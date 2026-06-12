// Production verification (docs/10): a PROPERTY-BASED determinism harness.
//
// AVCS's central guarantee is that the materialized code is a PURE function of the
// object set + policy + materializer:  state = reduce(objects, policy, materializer).
// The same logical operations yield the same materialized content regardless of the
// ORDER they were authored, the way work was PARTITIONED across replicas, or the
// order replicas SYNCED. This file tries hard to break that and asserts it holds.
//
// Strategy:
//   - A seeded PRNG (mulberry32) makes every "random" choice reproducible. On any
//     failure we print the seed so the exact adversarial case can be replayed.
//   - We generate a random DAG of logical ops (put_file over a small path set +
//     set_symbol over a small symbol set) with random causalDeps drawn ONLY from
//     already-emitted ops, so every topological order of the DAG is valid.
//   - We author the SAME logical DAG into fresh repos in DIFFERENT topological
//     orders / partitions and compare the materialized (path -> content) map — the
//     true determinism claim. createdAt timestamps make raw oids/treeHash differ
//     across separately-authored runs, so content equality is the load-bearing
//     assertion there. treeHash equality is asserted ONLY where the underlying
//     object set is genuinely identical (after a full cross-pull of the SAME bytes).
//
// If a property ever reveals a REAL non-determinism bug it must NOT be papered over:
// the assertion fails loudly with the seed for a minimal repro.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import type { Actor } from "../src/objects/types.ts";

// ── seeded PRNG ─────────────────────────────────────────────────────────────
// mulberry32: tiny, fast, well-distributed 32-bit PRNG. Deterministic per seed.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  #next: () => number;
  constructor(seed: number) {
    this.#next = mulberry32(seed);
  }
  float(): number {
    return this.#next();
  }
  int(maxExclusive: number): number {
    return Math.floor(this.#next() * maxExclusive);
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)]!;
  }
  /** Fisher–Yates shuffle (in place, deterministic for this rng). */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    return arr;
  }
}

const ai: Actor = { kind: "ai_agent", id: "ai:a" };
const aiB: Actor = { kind: "ai_agent", id: "ai:b" };

// ── logical op model ─────────────────────────────────────────────────────────
// A logical op is the order-independent description of an edit. `deps` are indices
// into the logical-op list and ALWAYS point at earlier ops (a DAG), so any
// topological order is a valid authoring order. We resolve logical indices to real
// oids at authoring time, which is what lets us reorder/partition freely.
type LogicalOp =
  | { kind: "put_file"; path: string; content: string; deps: number[]; actor: Actor }
  | { kind: "set_symbol"; path: string; symbol: string; text: string; deps: number[]; actor: Actor };

const PATHS = ["a.ts", "b.ts", "c.ts"] as const;
const SYMBOLS = ["alpha", "beta", "gamma"] as const;

const symbolSrc = (name: string, v: string) => `export function ${name}() {\n  return "${v}";\n}\n`;

/**
 * Generate a random valid DAG of N logical ops. Constraints that keep it a sound,
 * reorderable program while still being adversarial:
 *   - The FIRST op touching any path is a put_file establishing that path; its content
 *     is the concatenation of placeholder bodies for all symbols so later set_symbol
 *     ops have a span to splice into. (set_symbol on a path with no prior put_file
 *     would be a no-op file; we want exercise of the merge machinery.)
 *   - Every op depends on a random subset of already-emitted ops, ALWAYS including the
 *     establishing put_file for its own path (so reconstruction starts from the file)
 *     and, for set_symbol, optionally the prior edit of the SAME symbol — chaining some
 *     edits (deterministic single-head) while leaving others concurrent (real conflicts).
 */
function genDag(rng: Rng, n: number): LogicalOp[] {
  const ops: LogicalOp[] = [];
  const fileEstablisher = new Map<string, number>(); // path -> logical index of its put_file
  const lastSymbolEdit = new Map<string, number>(); // `${path}#${symbol}` -> logical index
  // All ops (since the path's establisher) that touch a path but are not yet known to
  // be causally dominated. A whole-file put_file must depend on ALL of these so it is
  // SEQUENCED after them, never concurrent with them. See KNOWN-BUG note below: a
  // whole-file put_file concurrent with a set_symbol on the SAME file contends on a
  // DIFFERENT key (file:p vs symbol:p#s), so the reducer raises no conflict and the
  // materialized result flips with authoring (lamport) order — a real determinism
  // hole. P1 deliberately avoids generating that unsound pattern so it tests the
  // order-independence that genuinely holds; the hole itself is asserted, with a
  // minimal repro, in the dedicated "KNOWN BUG" test below.
  const outstanding = new Map<string, number[]>();
  const actors = [ai, aiB];
  const touch = (p: string, i: number) => outstanding.set(p, [...(outstanding.get(p) ?? []), i]);

  for (let i = 0; i < n; i++) {
    const path = rng.pick(PATHS);
    const establisher = fileEstablisher.get(path);

    if (establisher === undefined) {
      // Must establish the file first. Seed it with all symbols so edits have targets.
      const content = SYMBOLS.map((s) => symbolSrc(s, "v0")).join("\n");
      // A put_file may still depend on unrelated earlier ops (random causal edges).
      const deps = pickDeps(rng, i, []);
      ops.push({ kind: "put_file", path, content, deps, actor: rng.pick(actors) });
      fileEstablisher.set(path, i);
      outstanding.set(path, [i]);
      continue;
    }

    // Path exists. Either edit a symbol (most common) or overwrite the whole file.
    const overwrite = rng.float() < 0.2;
    if (overwrite) {
      const content = SYMBOLS.map((s) => symbolSrc(s, `o${i}`)).join("\n");
      // Depend on EVERY outstanding op for this path so the overwrite is sequenced
      // after them (no put_file-vs-set_symbol concurrency on the same file).
      const deps = pickDeps(rng, i, outstanding.get(path) ?? [establisher]);
      ops.push({ kind: "put_file", path, content, deps, actor: rng.pick(actors) });
      // A whole-file rewrite re-establishes the symbol baseline and dominates prior edits.
      fileEstablisher.set(path, i);
      for (const s of SYMBOLS) lastSymbolEdit.delete(`${path}#${s}`);
      outstanding.set(path, [i]);
      continue;
    }

    const symbol = rng.pick(SYMBOLS);
    const symKey = `${path}#${symbol}`;
    const required = [fileEstablisher.get(path)!];
    // Chain on the previous edit of this symbol ~60% of the time — leaving the rest
    // concurrent, which is exactly what produces genuine same-symbol conflicts.
    const prev = lastSymbolEdit.get(symKey);
    if (prev !== undefined && rng.float() < 0.6) required.push(prev);
    const deps = pickDeps(rng, i, required);
    ops.push({ kind: "set_symbol", path, symbol, text: symbolSrc(symbol, `e${i}`), deps, actor: rng.pick(actors) });
    lastSymbolEdit.set(symKey, i);
    touch(path, i);
  }
  return ops;
}

/** A dep set over [0,i): the `required` indices plus a random extra subset. */
function pickDeps(rng: Rng, i: number, required: number[]): number[] {
  const set = new Set<number>(required);
  for (let j = 0; j < i; j++) if (rng.float() < 0.25) set.add(j);
  return [...set].sort((a, b) => a - b);
}

/** A random topological order of a DAG given by per-node dep lists. */
function topoOrder(rng: Rng, deps: number[][]): number[] {
  const n = deps.length;
  const indeg = deps.map((d) => d.length);
  const dependents: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) for (const d of deps[i]!) dependents[d]!.push(i);
  const ready: number[] = [];
  for (let i = 0; i < n; i++) if (indeg[i] === 0) ready.push(i);
  const order: number[] = [];
  while (ready.length) {
    // Pick a RANDOM ready node — this is what randomizes the topo order per seed.
    const k = rng.int(ready.length);
    const node = ready.splice(k, 1)[0]!;
    order.push(node);
    for (const dep of dependents[node]!) {
      indeg[dep] = (indeg[dep] ?? 0) - 1;
      if (indeg[dep] === 0) ready.push(dep);
    }
  }
  assert.equal(order.length, n, "DAG had a cycle — generator bug");
  return order;
}

// ── authoring ────────────────────────────────────────────────────────────────
async function mkRepo(tag: string): Promise<{ dir: string; repo: Repo }> {
  const dir = await mkdtemp(join(tmpdir(), `avcs-det-${tag}-`));
  const repo = await Repo.init(dir);
  return { dir, repo };
}

/**
 * Author the given logical ops, in the given authoring order, into `repo`.
 * `subset` (optional) restricts which logical indices are authored here (for the
 * partition property) — but the authoring order still respects deps among the subset
 * (the subset is dep-closed by construction in the partition test). Returns the
 * logical-index -> real-oid map (entries only for authored indices).
 */
async function authorInto(
  repo: Repo,
  logical: LogicalOp[],
  order: number[],
  intentOid: string,
  sessionOid: string,
  realOid: Map<number, string>,
): Promise<void> {
  for (const i of order) {
    const op = logical[i]!;
    // Resolve logical deps to real oids. Deps not yet authored (cross-partition) are
    // simply dropped from causalDeps here; the missing-dep edge is restored after the
    // cross-pull, since causalDeps reference oids that the pull brings in. For the
    // order-independence test, every dep is present so nothing is dropped.
    const causalDeps = op.deps.map((d) => realOid.get(d)).filter((x): x is string => x !== undefined);
    let oid: string;
    if (op.kind === "put_file") {
      oid = await repo.proposeFileWrite({
        sessionOid, intentOid, actor: op.actor, path: op.path, content: op.content,
        declaredPurpose: `put ${op.path}`, causalDeps,
      });
    } else {
      oid = await repo.proposeSymbolEdit({
        sessionOid, intentOid, actor: op.actor, path: op.path, symbolName: op.symbol,
        newText: op.text, declaredPurpose: `edit ${op.path}#${op.symbol}`, causalDeps,
      });
    }
    realOid.set(i, oid);
  }
}

/** Sorted (path -> content) map of a repo's materialized 'main' view. */
async function contentMap(repo: Repo): Promise<[string, string][]> {
  const res = await repo.materialize("main");
  const files = await repo.materializedFiles(res);
  return files.map((f): [string, string] => [f.path, f.content]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Sorted conflict ids of a repo's materialized 'main' view. */
async function conflictIds(repo: Repo): Promise<string[]> {
  const res = await repo.materialize("main");
  return res.conflicts.map((c) => c.id).sort();
}

const ITER = 40;
const OPS_PER_DAG = 14;

// ── Property 1: order independence within one repo ───────────────────────────
test("P1: same logical DAG authored in different topological orders -> identical materialized content + conflicts", async () => {
  for (let it = 0; it < ITER; it++) {
    const seed = 0x1000 + it;
    const rng = new Rng(seed);
    const logical = genDag(rng, OPS_PER_DAG);
    const deps = logical.map((o) => o.deps);

    // Two independent random topological orders of the SAME logical DAG.
    const orderA = topoOrder(rng, deps);
    const orderB = topoOrder(rng, deps);

    const a = await mkRepo("p1a");
    const b = await mkRepo("p1b");
    try {
      const ia = await a.repo.createIntent({ title: "t", owner: ai.id });
      const sa = await a.repo.startSession({ intentOid: ia, actor: ai });
      await authorInto(a.repo, logical, orderA, ia, sa, new Map());

      const ib = await b.repo.createIntent({ title: "t", owner: ai.id });
      const sb = await b.repo.startSession({ intentOid: ib, actor: ai });
      await authorInto(b.repo, logical, orderB, ib, sb, new Map());

      const ca = await contentMap(a.repo);
      const cb = await contentMap(b.repo);
      assert.deepEqual(
        cb, ca,
        `P1 FAIL seed=${seed}: materialized content differs across authoring order.\n` +
          `repro: new Rng(${seed}); genDag -> two topoOrders.\norderA=${orderA}\norderB=${orderB}`,
      );

      const cfa = await conflictIds(a.repo);
      const cfb = await conflictIds(b.repo);
      assert.deepEqual(
        cfb, cfa,
        `P1 FAIL seed=${seed}: conflict id set differs across authoring order.`,
      );
    } finally {
      await rm(a.dir, { recursive: true, force: true });
      await rm(b.dir, { recursive: true, force: true });
    }
  }
});

// ── Property 1b: identical object set -> identical treeHash ──────────────────
// When the object bytes are genuinely identical (author once, then a SECOND repo
// pulls those exact bytes), treeHash MUST match exactly — not just content. This is
// the strong form of the determinism claim over an identical object set.
test("P1b: full pull of identical bytes -> identical treeHash", async () => {
  for (let it = 0; it < ITER; it++) {
    const seed = 0x2000 + it;
    const rng = new Rng(seed);
    const logical = genDag(rng, OPS_PER_DAG);
    const deps = logical.map((o) => o.deps);
    const order = topoOrder(rng, deps);

    const a = await mkRepo("p1ba");
    const b = await mkRepo("p1bb");
    try {
      const ia = await a.repo.createIntent({ title: "t", owner: ai.id });
      const sa = await a.repo.startSession({ intentOid: ia, actor: ai });
      await authorInto(a.repo, logical, order, ia, sa, new Map());

      // b pulls A's exact objects. Same bytes in both stores => same treeHash.
      await b.repo.pull(a.dir);
      const ra = await a.repo.materialize("main");
      const rb = await b.repo.materialize("main");
      assert.equal(
        rb.treeHash, ra.treeHash,
        `P1b FAIL seed=${seed}: identical object set produced different treeHash.`,
      );
      assert.deepEqual(await contentMap(b.repo), await contentMap(a.repo), `P1b FAIL seed=${seed}: content`);
      assert.deepEqual(
        rb.conflicts.map((c) => c.id).sort(),
        ra.conflicts.map((c) => c.id).sort(),
        `P1b FAIL seed=${seed}: conflict ids`,
      );
    } finally {
      await rm(a.dir, { recursive: true, force: true });
      await rm(b.dir, { recursive: true, force: true });
    }
  }
});

// ── Property 2: sync split-independence ──────────────────────────────────────
// Build one logical DAG, then partition the ops randomly across two repos A and B,
// cross-pull, and assert A and B converge to the SAME materialized content and the
// SAME conflict ids. The partition is dep-closed-aware: we keep deps satisfiable by
// authoring each repo's subset in topo order, dropping cross-partition dep edges at
// authoring time (they are restored after the cross-pull because causalDeps reference
// oids that the pull brings in — but since both partitions author the SAME logical op
// with the SAME content, the establishing put_file oid each side minted differs).
//
// To keep "same logical op" meaningful under partition, we make the partition assign
// each logical op WHOLLY to one side, but BOTH sides first author a shared PREFIX (the
// file establishers) so set_symbol ops on either side splice against identical base
// content. After cross-pull each repo holds the union and reduces it.
test("P2: random partition across two repos then cross-pull -> convergent content + conflicts", async () => {
  for (let it = 0; it < ITER; it++) {
    const seed = 0x3000 + it;
    const rng = new Rng(seed);
    const logical = genDag(rng, OPS_PER_DAG);

    // Shared prefix: every file establisher is authored IDENTICALLY on both repos so
    // their oids match and later edits (on either side) target the same base bytes.
    const establishers = new Set<number>();
    {
      const seen = new Set<string>();
      for (let i = 0; i < logical.length; i++) {
        const op = logical[i]!;
        if (op.kind === "put_file" && !seen.has(op.path)) {
          establishers.add(i);
          seen.add(op.path);
        }
      }
    }

    // Assign each NON-establisher op to side 0 or 1.
    const side = new Map<number, 0 | 1>();
    for (let i = 0; i < logical.length; i++) {
      if (establishers.has(i)) continue;
      side.set(i, rng.float() < 0.5 ? 0 : 1);
    }

    const a = await mkRepo("p2a");
    const b = await mkRepo("p2b");
    try {
      // Each repo shares ONE intent/session id space by authoring the shared prefix
      // identically. We must author the establishers with identical createdAt? No —
      // we cannot control createdAt. So establisher oids will differ across repos,
      // meaning set_symbol ops that depend on them reference DIFFERENT oids per side.
      // After cross-pull the union therefore contains BOTH establishers for a path,
      // which is itself a legitimate concurrent put_file — handled deterministically.
      // We assert A and B converge regardless.
      const ia = await a.repo.createIntent({ title: "t", owner: ai.id });
      const sa = await a.repo.startSession({ intentOid: ia, actor: ai });
      const ib = await b.repo.createIntent({ title: "t", owner: ai.id });
      const sb = await b.repo.startSession({ intentOid: ib, actor: ai });

      const realA = new Map<number, string>();
      const realB = new Map<number, string>();

      // Both repos author the establishers (shared base). Different real oids per side.
      const estOrder = topoOrder(rng, logical.map((o) => o.deps)).filter((i) => establishers.has(i));
      await authorInto(a.repo, logical, estOrder, ia, sa, realA);
      await authorInto(b.repo, logical, estOrder, ib, sb, realB);

      // Side-0 ops -> repo A; side-1 ops -> repo B. Author in a topo order restricted
      // to each side (deps to the other side are dropped at authoring; they resolve to
      // the local establisher base which is content-equivalent).
      const fullOrder = topoOrder(rng, logical.map((o) => o.deps));
      const orderA = fullOrder.filter((i) => side.get(i) === 0);
      const orderB = fullOrder.filter((i) => side.get(i) === 1);
      await authorInto(a.repo, logical, orderA, ia, sa, realA);
      await authorInto(b.repo, logical, orderB, ib, sb, realB);

      // Cross-pull both directions: each repo now holds the FULL union of objects.
      await a.repo.pull(b.dir);
      await b.repo.pull(a.dir);

      const ra = await a.repo.materialize("main");
      const rb = await b.repo.materialize("main");

      // Identical object set on both sides => identical treeHash AND content AND conflicts.
      assert.equal(
        rb.treeHash, ra.treeHash,
        `P2 FAIL seed=${seed}: A and B did NOT converge to the same treeHash after cross-pull.`,
      );
      assert.deepEqual(
        await contentMap(b.repo), await contentMap(a.repo),
        `P2 FAIL seed=${seed}: convergent content differs after cross-pull.`,
      );
      assert.deepEqual(
        rb.conflicts.map((c) => c.id).sort(),
        ra.conflicts.map((c) => c.id).sort(),
        `P2 FAIL seed=${seed}: conflict id sets differ after cross-pull.`,
      );
    } finally {
      await rm(a.dir, { recursive: true, force: true });
      await rm(b.dir, { recursive: true, force: true });
    }
  }
});

// ── Property 3: conflict stability ───────────────────────────────────────────
// Two concurrent edits to the SAME symbol must produce the SAME conflict id no matter
// the authoring order or which replica saw which edit first. The conflict id is keyed
// purely on the contended entity (conflictIdFor(key)), so it must be invariant.
test("P3: concurrent same-symbol edits -> identical conflict id regardless of order/sync", async () => {
  for (let it = 0; it < ITER; it++) {
    const seed = 0x4000 + it;
    const rng = new Rng(seed);
    const path = rng.pick(PATHS);
    const symbol = rng.pick(SYMBOLS);
    const base = SYMBOLS.map((s) => symbolSrc(s, "v0")).join("\n");
    const editX = symbolSrc(symbol, "X");
    const editY = symbolSrc(symbol, "Y");

    // Repo 1: author base, then X then Y (both depend ONLY on base => concurrent).
    const r1 = await mkRepo("p3a");
    // Repo 2: author base, then Y then X (opposite order).
    const r2 = await mkRepo("p3b");
    // Repo 3: split across replicas (X on one, Y on another) then cross-pull.
    const r3a = await mkRepo("p3ca");
    const r3b = await mkRepo("p3cb");
    try {
      const author = async (repo: Repo, first: string, second: string) => {
        const intent = await repo.createIntent({ title: "t", owner: ai.id });
        const sess = await repo.startSession({ intentOid: intent, actor: ai });
        const b = await repo.proposeFileWrite({
          sessionOid: sess, intentOid: intent, actor: ai, path, content: base, declaredPurpose: "base",
        });
        await repo.proposeSymbolEdit({
          sessionOid: sess, intentOid: intent, actor: ai, path, symbolName: symbol, newText: first,
          declaredPurpose: "edit1", causalDeps: [b],
        });
        await repo.proposeSymbolEdit({
          sessionOid: sess, intentOid: intent, actor: aiB, path, symbolName: symbol, newText: second,
          declaredPurpose: "edit2", causalDeps: [b],
        });
        return { intent, sess, b };
      };

      await author(r1.repo, editX, editY);
      await author(r2.repo, editY, editX);

      const c1 = await r1.repo.materialize("main");
      const c2 = await r2.repo.materialize("main");
      assert.equal(c1.conflicts.length, 1, `P3 FAIL seed=${seed}: r1 expected exactly one conflict`);
      assert.equal(c2.conflicts.length, 1, `P3 FAIL seed=${seed}: r2 expected exactly one conflict`);
      assert.equal(
        c1.conflicts[0]!.id, c2.conflicts[0]!.id,
        `P3 FAIL seed=${seed}: same-symbol conflict id differs across authoring order.`,
      );

      // Split-replica variant: r3a has base+X, r3b has base+Y (SAME base bytes since
      // both author identical base content — but different oids; both edits depend on
      // their own local base). Cross-pull and confirm the conflict id matches r1's.
      const i3a = await r3a.repo.createIntent({ title: "t", owner: ai.id });
      const s3a = await r3a.repo.startSession({ intentOid: i3a, actor: ai });
      const b3a = await r3a.repo.proposeFileWrite({ sessionOid: s3a, intentOid: i3a, actor: ai, path, content: base, declaredPurpose: "base" });
      await r3a.repo.proposeSymbolEdit({ sessionOid: s3a, intentOid: i3a, actor: ai, path, symbolName: symbol, newText: editX, declaredPurpose: "x", causalDeps: [b3a] });

      const i3b = await r3b.repo.createIntent({ title: "t", owner: ai.id });
      const s3b = await r3b.repo.startSession({ intentOid: i3b, actor: aiB });
      const b3b = await r3b.repo.proposeFileWrite({ sessionOid: s3b, intentOid: i3b, actor: aiB, path, content: base, declaredPurpose: "base" });
      await r3b.repo.proposeSymbolEdit({ sessionOid: s3b, intentOid: i3b, actor: aiB, path, symbolName: symbol, newText: editY, declaredPurpose: "y", causalDeps: [b3b] });

      await r3a.repo.pull(r3b.dir);
      await r3b.repo.pull(r3a.dir);
      const c3a = await r3a.repo.materialize("main");
      const c3b = await r3b.repo.materialize("main");
      assert.deepEqual(
        c3b.conflicts.map((c) => c.id).sort(),
        c3a.conflicts.map((c) => c.id).sort(),
        `P3 FAIL seed=${seed}: split replicas disagree on conflict ids after cross-pull.`,
      );
      // And the contended symbol conflict id matches the single-repo case.
      const symConflict = c3a.conflicts.map((c) => c.id);
      assert.ok(
        symConflict.includes(c1.conflicts[0]!.id),
        `P3 FAIL seed=${seed}: split-replica conflict id set ${JSON.stringify(symConflict)} ` +
          `does not contain the single-repo same-symbol conflict id ${c1.conflicts[0]!.id}.`,
      );
    } finally {
      await rm(r1.dir, { recursive: true, force: true });
      await rm(r2.dir, { recursive: true, force: true });
      await rm(r3a.dir, { recursive: true, force: true });
      await rm(r3b.dir, { recursive: true, force: true });
    }
  }
});

// ── KNOWN BUG (found by this harness): put_file ∥ set_symbol on the SAME file ─
//
// THIS HARNESS FOUND A REAL DETERMINISM HOLE. It is documented and pinned here so the
// suite stays green AND the bug cannot silently regress or be forgotten. P1 above
// deliberately does NOT generate this pattern (its put_file overwrites are sequenced
// after every outstanding edit), so P1 still tests the order-independence that holds.
//
// THE BUG
//   A whole-file `put_file` and a `set_symbol` on the SAME file, authored CONCURRENTLY
//   (neither is a causal ancestor of the other), contend on DIFFERENT reducer keys:
//     - put_file  -> keysOf = ["file:<path>"]           (src/reducer/reducer.ts keysOf)
//     - set_symbol -> keysOf = ["symbol:<path>#<name>"]
//   Because they never share a conflict group, the reducer raises NO conflict and marks
//   BOTH ops `accepted`. Both are then projected into the tree, and the final content of
//   the file depends purely on the apply order in kahnOrder(), whose tie-break for two
//   ops with no dep edge between them is (lamport, oid). `lamport` is assigned at
//   AUTHORING time, so it is authoring-order-dependent — and therefore the materialized
//   tree is too. This violates the central guarantee: state = reduce(objects, ...) must
//   not depend on authoring order.
//
// MINIMAL REPRO (no PRNG): base file with one symbol `g`, then two concurrent edits —
// a whole-file put_file (-> "WHOLE") and a set_symbol (-> "SYMBOL") — both depending
// only on the base. Author them in the two possible orders into fresh repos.
//
// EXPECTED (correct) BEHAVIOR once fixed: either the reducer treats a put_file as
// contending on the file's symbol keys too (so this surfaces as a concurrent_write
// conflict), or whole-file and symbol ops are reconciled deterministically regardless
// of lamport. Until then, this test PINS the current (buggy) behavior and FAILS LOUDLY
// the moment it changes — at which point flip the assertion to the determinism check.
// FIXED (fix/cross-granularity-determinism): the reducer now raises a concurrent_write
// conflict for a whole-file op ∥ set_symbol on the same file, so the result is
// order-independent. Flag flipped to assert the determinism guarantee.
const KNOWN_BUG_put_vs_symbol_is_order_dependent = false;

test("KNOWN BUG: concurrent put_file ∥ set_symbol on same file is authoring-order-dependent", async () => {
  const sym = (n: string, v: string) => `export function ${n}() {\n  return "${v}";\n}\n`;
  const base = sym("g", "v0");

  // Author the base, then the two concurrent edits in the given order; return the
  // materialized value of g and the number of conflicts the reducer raised.
  async function run(firstKind: "put" | "sym"): Promise<{ val: string; conflicts: number }> {
    const { dir, repo } = await mkRepo("kb");
    try {
      const i = await repo.createIntent({ title: "t", owner: ai.id });
      const s = await repo.startSession({ intentOid: i, actor: ai });
      const b = await repo.proposeFileWrite({
        sessionOid: s, intentOid: i, actor: ai, path: "f.ts", content: base, declaredPurpose: "base",
      });
      const doPut = () => repo.proposeFileWrite({
        sessionOid: s, intentOid: i, actor: ai, path: "f.ts", content: sym("g", "WHOLE"),
        declaredPurpose: "put", causalDeps: [b],
      });
      const doSym = () => repo.proposeSymbolEdit({
        sessionOid: s, intentOid: i, actor: ai, path: "f.ts", symbolName: "g", newText: sym("g", "SYMBOL"),
        declaredPurpose: "sym", causalDeps: [b],
      });
      if (firstKind === "put") { await doPut(); await doSym(); }
      else { await doSym(); await doPut(); }
      const res = await repo.materialize("main");
      const content = (await repo.materializedFiles(res)).find((f) => f.path === "f.ts")!.content;
      return { val: content.match(/return "(.*?)"/)![1]!, conflicts: res.conflicts.length };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const putFirst = await run("put");
  const symFirst = await run("sym");

  if (KNOWN_BUG_put_vs_symbol_is_order_dependent) {
    // PINNED current behavior: no conflict is raised, and the winner flips with order.
    assert.equal(putFirst.conflicts, 0, "currently NO conflict is raised for put∥symbol (part of the bug)");
    assert.equal(symFirst.conflicts, 0, "currently NO conflict is raised for put∥symbol (part of the bug)");
    assert.notEqual(
      putFirst.val, symFirst.val,
      "KNOWN BUG NO LONGER REPRODUCES — the put_file ∥ set_symbol determinism hole appears fixed.\n" +
        "ACTION: flip KNOWN_BUG_put_vs_symbol_is_order_dependent to false to assert the determinism guarantee instead.",
    );
    assert.equal(putFirst.val, "SYMBOL", "pinned: put-authored-first ⇒ set_symbol applied last ⇒ SYMBOL");
    assert.equal(symFirst.val, "WHOLE", "pinned: sym-authored-first ⇒ put_file applied last ⇒ WHOLE");
  } else {
    // Determinism guarantee (assert this once the reducer is fixed).
    assert.equal(
      putFirst.val, symFirst.val,
      "put_file ∥ set_symbol on the same file must materialize identically regardless of authoring order.",
    );
  }
});

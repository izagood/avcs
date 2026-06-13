// Incremental-reduce benchmark (docs/11 Track A, stage A1). Measures the reducer-level
// COMPUTE win of reduceIncremental vs a full reduce when one op is appended to a large
// op set — the "+1op" case the materialize bench showed is O(N) today. Reports the
// clean-group reuse ratio (why it's faster) alongside wall time.
//
// Run: npm run bench:incremental
//
// NB: this isolates reduce COMPUTE only (no disk IO). The end-to-end materialize win
// also needs the persistent op-log + tail-read (A5) so the repo stops re-reading every
// op from disk; this bench is the lower bound the wiring (A6) unlocks.
import { reduce, snapshotReduce, reduceIncremental } from "../src/reducer/reducer.ts";
import { defaultPolicy } from "../src/reducer/policy.ts";
import type { ReduceInput } from "../src/reducer/reducer.ts";
import type { Operation as Op } from "../src/objects/types.ts";

const ai = { kind: "ai_agent" as const, id: "ai:a" };
const ms = (n: number) => `${n.toFixed(2)}ms`;
const blobOf = (s: string) => `blob_${s.length}_${s.replace(/\W/g, "").slice(0, 8)}`;

/** A large, mostly-disjoint op set: `files` files, each scaffolded then edited twice. */
function buildInput(n: number): { input: ReduceInput; blobContent: Map<string, string> } {
  const ops: Op[] = [];
  const blobContent = new Map<string, string>();
  const files = Math.ceil(n / 3);
  let made = 0;
  for (let f = 0; f < files && made < n; f++) {
    const path = `src/mod${f}.ts`;
    const c0 = `export function g${f}() { return "v0"; }\n`;
    const b0 = blobOf(c0);
    blobContent.set(b0, c0);
    const scaffold: Op = mk(`op_${made}`, path, { kind: "put_file", path, blobOid: b0 }, [], made);
    ops.push(scaffold);
    made++;
    let prev = scaffold.oid as string;
    for (let e = 0; e < 2 && made < n; e++) {
      const text = `export function g${f}() { return "v${e + 1}"; }\n`;
      const b = blobOf(text);
      blobContent.set(b, text);
      const op: Op = mk(`op_${made}`, path, { kind: "set_symbol", path, symbolName: `g${f}`, blobOid: b }, [prev], made);
      ops.push(op);
      prev = op.oid as string;
      made++;
    }
  }
  const intents = new Map();
  const input: ReduceInput = { ops, evidence: [], decisions: [], intents, policy: defaultPolicy(), blobContent };
  return { input, blobContent };
}

function mk(oid: string, path: string, body: Op["body"], deps: string[], lamport: number): Op {
  return {
    type: "operation", oid, sessionOid: "s", intentOid: "i", actor: ai,
    target: { entityKind: "file", entityId: path }, body, causalDeps: deps,
    declaredPurpose: oid, lamport, createdAt: `2026-02-01T00:00:00.000Z`,
  } as Op;
}

function timed<T>(fn: () => T): [T, number] {
  const t = performance.now();
  const r = fn();
  return [r, performance.now() - t];
}

function main(): void {
  for (const N of [500, 1500, 3000]) {
    const { input, blobContent } = buildInput(N);
    // Snapshot the base set once (this is what a long-lived repo would cache).
    const snap = snapshotReduce(input);
    // Append one new op on a fresh file (a typical "author one edit" delta).
    const newContent = `export const fresh = ${N}\n`;
    const nb = blobOf(newContent);
    const bc2 = new Map(blobContent);
    bc2.set(nb, newContent);
    const newOp = mk(`op_new`, "src/new.ts", { kind: "put_file", path: "src/new.ts", blobOid: nb }, [], N);
    const next: ReduceInput = { ...input, ops: [...input.ops, newOp], blobContent: bc2 };

    // Full re-reduce (today's +1op cost) vs incremental.
    const [, fullMs] = timed(() => reduce(next));
    const [incSnap, incMs] = timed(() => reduceIncremental(snap, next));
    const s = incSnap.stats;
    const reusePct = ((s.groupsReused / s.groupsTotal) * 100).toFixed(1);
    const speedup = (fullMs / incMs).toFixed(2);
    console.log(
      `N=${String(N).padStart(4)} groups=${String(s.groupsTotal).padStart(4)}  ` +
        `full=${ms(fullMs)}  inc=${ms(incMs)}  speedup=${speedup}x  ` +
        `reused=${s.groupsReused}/${s.groupsTotal} (${reusePct}%)  recomputed=${s.groupsRecomputed}`,
    );
  }
}

main();

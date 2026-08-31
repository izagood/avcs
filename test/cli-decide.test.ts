// Issue #129 — `avcs conflicts` names a debt the CLI could not pay.
//
// A conflict in AVCS is not markers in a file; it is an object that waits for a signed
// human `decision`. The MCP surface has `avcs.decision.record`, so an agent can get past
// one — but the human-facing CLI had no verb at all, and a person working without an agent
// had to write a script against the library API. This was the single place the CLI demanded
// an action and supplied no way to take it.
//
// What `avcs decide` has to be, for that to be fixed:
//   (a) it ends the deadlock — after deciding, the SAME land goes through;
//   (b) the decision it writes is the real thing: ed25519-signed under the actor's own local
//       key (so an agent that does not hold the key cannot forge a human sign-off), carrying
//       chosen/rejected ops and the rationale;
//   (c) with no local key it refuses and names `avcs key provision` — the CLI's own habit of
//       naming the command that fixes the error;
//   (d) it is complete NON-INTERACTIVELY (scripts, CI), and when `--choose` is missing it
//       still hands the human a runnable command per option rather than a prompt;
//   (e) `avcs conflicts` names it, so the listing points at its own resolution.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Repo } from "../src/api/repo.ts";
import type { Decision, Operation } from "../src/objects/types.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** Run the CLI, returning `{ status, out }` — never throwing, so exit codes are assertable. */
function cli(cwd: string, ...a: string[]): { status: number; out: string } {
  try {
    const out = execFileSync(process.execPath, ["--experimental-strip-types", CLI, ...a], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

interface Scene {
  root: string;
  /** bob's repo: holds both concurrent ops, so its `main` carries the open conflict. */
  bob: string;
  alice: string;
}

/**
 * The issue's scenario, with no hub in it: two repos edit the SAME line of a file whose
 * history they share, and bob pulls alice's operation. Both edits are concurrent — neither
 * built on the other — so they overlap on one line region and the reducer surfaces a
 * `needs_human` conflict instead of picking a winner. A hub is one way to reach that state
 * (it is how a real pair of clones meets it); it is not what the state IS, and leaving it
 * out keeps this test about the CLI verb rather than about transport.
 */
async function conflicted(): Promise<Scene> {
  const root = await mkdtemp(join(tmpdir(), "avcs-decide-"));
  const alice = join(root, "alice");
  const bob = join(root, "bob");
  cli(root, "init", alice);
  await writeFile(join(alice, "f.txt"), "a\nb\nc\n", "utf8");
  cli(alice, "commit", "-m", "seed the file", "--author", "human:alice");
  cli(alice, "key", "provision", "human:alice");

  cli(root, "init", bob);
  cli(bob, "pull", alice);
  cli(bob, "checkout");
  cli(bob, "key", "provision", "human:bob");

  // Concurrent, overlapping: both rewrite line 2, neither having seen the other.
  await writeFile(join(alice, "f.txt"), "a\nb-alice\nc\n", "utf8");
  cli(alice, "commit", "-m", "alice rewords line 2", "--author", "human:alice");
  await writeFile(join(bob, "f.txt"), "a\nb-bob\nc\n", "utf8");
  cli(bob, "commit", "-m", "bob rewords line 2", "--author", "human:bob");
  cli(bob, "pull", alice);
  return { root, bob, alice };
}

/** The open conflict's id and its two option oids, read the way a human reads them. */
function conflictFromListing(out: string): { id: string; ops: string[] } {
  const id = /(conflict_[0-9a-f]+)/.exec(out)?.[1];
  assert.ok(id, `the listing must show a conflict id:\n${out}`);
  const ops = [...out.matchAll(/(operation_[0-9a-f]+)/g)].map((m) => m[1] as string);
  assert.equal(ops.length, 2, `both contending operations must be listed:\n${out}`);
  return { id, ops };
}

/** Which of the listed options is `actor`'s — the choice a human is actually making. */
async function opOf(repoDir: string, actor: string, ops: string[]): Promise<string> {
  const repo = await Repo.open(repoDir);
  for (const oid of ops) {
    const op = await repo.store.get<Operation>(oid);
    if (op.actor?.id === actor) return oid;
  }
  throw new Error(`no option authored by ${actor}`);
}

test("a conflict decided on the CLI lets the same land through", async () => {
  const { root, bob } = await conflicted();
  try {
    // The deadlock: land refuses, and points at the listing.
    const blocked = cli(bob, "land", "--as", "human:bob", "-m", "bob lands");
    assert.equal(blocked.status, 1, `land must refuse while the conflict is open:\n${blocked.out}`);
    assert.match(blocked.out, /conflict/, blocked.out);

    const listing = cli(bob, "conflicts");
    assert.equal(listing.status, 0, listing.out);
    const { id, ops } = conflictFromListing(listing.out);
    const mine = await opOf(bob, "human:bob", ops);

    const d = cli(bob, "decide", id, "--choose", mine, "--reason", "bob's wording is the agreed one", "--as", "human:bob");
    assert.equal(d.status, 0, `decide must succeed:\n${d.out}`);
    assert.match(d.out, /decision_[0-9a-f]+/, `decide must report the decision it recorded:\n${d.out}`);

    // The debt is paid: the listing is empty and the same land goes through.
    const after = cli(bob, "conflicts");
    assert.match(after.out, /no open conflicts/, `the decided conflict must close:\n${after.out}`);
    const landed = cli(bob, "land", "--as", "human:bob", "-m", "bob lands");
    assert.equal(landed.status, 0, `land must pass after the decision:\n${landed.out}`);

    // And the chosen content is what the tree projects — the decision moved bytes, not just state.
    cli(bob, "checkout");
    assert.equal(await readFile(join(bob, "f.txt"), "utf8"), "a\nb-bob\nc\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the recorded decision is ed25519-signed under the deciding actor's own key", async () => {
  const { root, bob } = await conflicted();
  try {
    const { id, ops } = conflictFromListing(cli(bob, "conflicts").out);
    const mine = await opOf(bob, "human:bob", ops);
    const theirs = ops.find((o) => o !== mine) as string;

    const d = cli(bob, "decide", id, "--choose", mine, "--reason", "keep bob's wording", "--as", "human:bob");
    assert.equal(d.status, 0, d.out);
    const oid = /(decision_[0-9a-f]+)/.exec(d.out)?.[1] as string;

    const shown = cli(bob, "show", oid);
    assert.equal(shown.status, 0, shown.out);
    const dec = JSON.parse(shown.out) as Decision;
    assert.equal(dec.type, "decision");
    assert.equal(dec.conflictId, id);
    assert.deepEqual(dec.chosenOps, [mine], "the chosen op is the one named by --choose");
    assert.deepEqual(dec.rejectedOps, [theirs], "the other option is rejected — a decision settles the contest");
    assert.equal(dec.reason, "keep bob's wording", "the rationale is recorded verbatim");
    assert.deepEqual(dec.decidedBy, { kind: "human", id: "human:bob" });

    // Signed, and signed by BOB's registered key over this decision's own oid — this is
    // what makes it un-forgeable by an agent that does not hold the key.
    assert.equal(dec.sig?.alg, "ed25519", `decision must be ed25519-signed:\n${shown.out}`);
    assert.equal(dec.sig?.keyId, "human:bob");
    const repo = await Repo.open(bob);
    assert.ok(repo.keyring.verifyFor("human:bob", oid, dec.sig), "the signature must verify against bob's trusted key");
    assert.equal(repo.keyring.verifyFor("human:alice", oid, dec.sig), false, "and must not pass as alice's");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("with no local key, decide refuses and names `avcs key provision`", async () => {
  const { root, bob } = await conflicted();
  try {
    const { id, ops } = conflictFromListing(cli(bob, "conflicts").out);
    // A trusted-but-not-held identity: carol can be named, but this machine cannot sign for
    // her — exactly the case where recording anyway would produce a decision the trust gate
    // silently drops, i.e. a conflict that looks decided and is not.
    const r = cli(bob, "decide", id, "--choose", ops[0] as string, "--as", "human:carol");
    assert.notEqual(r.status, 0, `decide must fail without a signing key:\n${r.out}`);
    assert.match(r.out, /avcs key provision human:carol/, `it must name the command that fixes it:\n${r.out}`);
    // Nothing was written: the conflict is still open.
    assert.match(cli(bob, "conflicts").out, /conflict_/, "a refused decide records nothing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("without --choose, decide prints each option's author, purpose and the exact command", async () => {
  const { root, bob } = await conflicted();
  try {
    const { id, ops } = conflictFromListing(cli(bob, "conflicts").out);
    const r = cli(bob, "decide", id, "--as", "human:bob");
    assert.notEqual(r.status, 0, `an undecided decide is not a success:\n${r.out}`);
    // No prompt: a CLI that blocks on stdin is unusable in a script. It hands back the
    // command instead — which is also what makes the choice reviewable before it is made.
    for (const op of ops) assert.ok(r.out.includes(op), `option ${op} must be offered:\n${r.out}`);
    assert.match(r.out, /human:alice/, `each option must name its author:\n${r.out}`);
    assert.match(r.out, /human:bob/, r.out);
    assert.match(r.out, /alice rewords line 2/, `…and its declared purpose:\n${r.out}`);
    assert.match(r.out, new RegExp(`avcs decide ${id} --choose `), `…and a runnable command:\n${r.out}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("op oids may be abbreviated, and an unmatched or ambiguous one is refused", async () => {
  const { root, bob } = await conflicted();
  try {
    const { id, ops } = conflictFromListing(cli(bob, "conflicts").out);
    const mine = await opOf(bob, "human:bob", ops);

    // Nothing in the conflict starts with this.
    const unknown = cli(bob, "decide", id, "--choose", "operation_ffffffff", "--as", "human:bob");
    assert.notEqual(unknown.status, 0, unknown.out);
    assert.match(unknown.out, /no option/i, `an unmatched --choose must say so:\n${unknown.out}`);

    // "operation_" prefixes both — refusing beats silently taking the first.
    const ambiguous = cli(bob, "decide", id, "--choose", "operation_", "--as", "human:bob");
    assert.notEqual(ambiguous.status, 0, ambiguous.out);
    assert.match(ambiguous.out, /ambiguous/i, `an ambiguous --choose must be refused:\n${ambiguous.out}`);

    // A unique abbreviation is what a human actually types off the listing.
    const short = cli(bob, "decide", id, "--choose", mine.slice(0, 20), "--as", "human:bob");
    assert.equal(short.status, 0, `a unique prefix must resolve:\n${short.out}`);
    const dec = JSON.parse(cli(bob, "show", /(decision_[0-9a-f]+)/.exec(short.out)?.[1] as string).out) as Decision;
    assert.deepEqual(dec.chosenOps, [mine], "the abbreviation resolved to the full oid");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the conflict listing names `avcs decide` — and shows who wrote each option", async () => {
  const { root, bob } = await conflicted();
  try {
    const listing = cli(bob, "conflicts");
    assert.equal(listing.status, 0, listing.out);
    const { id } = conflictFromListing(listing.out);
    assert.match(listing.out, new RegExp(`avcs decide ${id}`), `conflicts must name its own resolution:\n${listing.out}`);
    // A command you cannot answer is not guidance: an overlapping-edit conflict carries no
    // actor on its options, so the listing has to fill them in from the operations.
    assert.match(listing.out, /human:alice/, `options must be attributable:\n${listing.out}`);
    assert.match(listing.out, /human:bob/, listing.out);

    // And `land`'s refusal speaks CLI, not MCP tool names — a human reads that output too.
    const blocked = cli(bob, "land", "--as", "human:bob", "-m", "bob lands");
    assert.equal(blocked.status, 1, blocked.out);
    assert.match(blocked.out, /avcs conflicts/, `land must name the CLI listing:\n${blocked.out}`);
    assert.match(blocked.out, /avcs decide/, `…and the CLI verb that resolves it:\n${blocked.out}`);
    assert.doesNotMatch(blocked.out, /avcs\.decision\.record|avcs\.conflict\.list|avcs\.sync\.land/, `no MCP tool names in CLI output:\n${blocked.out}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("`avcs help` lists decide next to conflicts", async () => {
  const r = cli(tmpdir(), "help");
  assert.equal(r.status, 0, r.out);
  // The help is a list of bare verbs; `decide` has to be in it, or the fix for #129 is
  // reachable only by someone who already knew it existed.
  assert.match(r.out, /^\s+decide <conflict-id>/m, `the verb must be discoverable:\n${r.out}`);
  const lines = r.out.split("\n");
  assert.ok(
    lines.findIndex((l) => /^\s+decide /.test(l)) === lines.findIndex((l) => /^\s+conflicts /.test(l)) + 1,
    `decide belongs directly under the command that names it:\n${r.out}`,
  );
});

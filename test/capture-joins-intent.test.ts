// issue #167 — an intent opened through MCP could not be joined by the capture path.
// `commitWorkingTree` always ran `createIntent({ title: <the commit message> })`, and its
// options had no field an existing intent could arrive through, so an agent that declared a
// goal, constraints and success criteria had its work land under a throwaway intent titled
// with the commit message. The `AVCS-Intent:` trailer then named the throwaway.
//
// Intent is the object that carries WHY. Minting a new one per capture collapses the "why"
// back into the "what" — the exact thing intents exist to prevent — so what is asserted here
// is that the declared intent is the one the ops end up under, not merely that a flag parses.
//
// Two ways in, because the two capture paths differ in what they can reach:
//   --intent <oid>   for a human/agent typing the command
//   AVCS_INTENT      for `git commit`, where the git hook runs avcs with no argv of its own
// Flag wins over env, matching how --author relates to AVCS_AUTHOR.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Repo } from "../src/api/repo.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const ACTOR = { kind: "human" as const, id: "human:me" };

/** Run the CLI, returning `{ status, out }` — never throwing, so exit codes are assertable. */
function cli(cwd: string, args: string[], env: Record<string, string> = {}): { status: number; out: string } {
  try {
    const out = execFileSync(process.execPath, ["--experimental-strip-types", CLI, ...args], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env },
    });
    return { status: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

const DECLARED = "the goal that was actually declared";

/** A fresh repo, one uncommitted file, and one intent opened the way MCP opens it. */
async function declared(): Promise<{ dir: string; intent: string }> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-join-intent-"));
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({
    title: DECLARED,
    owner: ACTOR.id,
    kind: "bugfix",
    constraints: ["must not break the other thing"],
    successCriteria: ["the suite stays green"],
  });
  await writeFile(join(dir, "f.txt"), "a\n", "utf8");
  return { dir, intent };
}

/** Every intent in the repo, newest last — the count is what proves nothing was minted. */
async function intentsIn(dir: string): Promise<{ oid?: string; title: string }[]> {
  const repo = await Repo.open(dir);
  return (await repo.listIntents()).map((i) => ({ oid: i.oid, title: i.title }));
}

test("`commit --intent` authors under the declared intent instead of minting one", async () => {
  const { dir, intent } = await declared();
  try {
    const r = cli(dir, ["commit", "-m", "a commit message that is not the goal", "--intent", intent]);
    assert.equal(r.status, 0, `the commit succeeds:\n${r.out}`);

    const intents = await intentsIn(dir);
    assert.deepEqual(intents.map((i) => i.title), [DECLARED], "no second intent may be minted");

    // The ops really hang off it — `blame` reads the intent through the op's session, so this
    // is the end-to-end path, not just a count that happens to match.
    const blame = cli(dir, ["blame", "f.txt"]);
    assert.match(blame.out, new RegExp(`intent: ${DECLARED}`), `blame must name the declared intent:\n${blame.out}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AVCS_INTENT joins the same way, for the git-hook path that has no argv", async () => {
  const { dir, intent } = await declared();
  try {
    const r = cli(dir, ["commit", "-m", "committed by a hook"], { AVCS_INTENT: intent });
    assert.equal(r.status, 0, `the commit succeeds:\n${r.out}`);
    assert.deepEqual((await intentsIn(dir)).map((i) => i.title), [DECLARED], "no second intent may be minted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the flag wins over the environment, as --author does over AVCS_AUTHOR", async () => {
  const { dir, intent } = await declared();
  try {
    const repo = await Repo.open(dir);
    const stale = await repo.createIntent({ title: "a stale exported intent", owner: ACTOR.id });
    const r = cli(dir, ["commit", "-m", "msg", "--intent", intent], { AVCS_INTENT: stale });
    assert.equal(r.status, 0, `the commit succeeds:\n${r.out}`);
    const blame = cli(dir, ["blame", "f.txt"]);
    assert.match(blame.out, new RegExp(`intent: ${DECLARED}`), `the flag's intent must win:\n${blame.out}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unknown intent oid is refused before anything is authored", async () => {
  const { dir } = await declared();
  try {
    const r = cli(dir, ["commit", "-m", "msg", "--intent", "intent_" + "0".repeat(32)]);
    assert.equal(r.status, 1, `a bad --intent must fail:\n${r.out}`);
    assert.match(r.out, /no such intent/, `it must say what is wrong:\n${r.out}`);
    assert.match(r.out, /--intent|AVCS_INTENT/, `it must name the input to fix:\n${r.out}`);

    // "Before anything is authored" is the real contract: a refusal must cost the caller
    // nothing, so the change is still uncaptured and no intent was left behind.
    assert.deepEqual((await intentsIn(dir)).map((i) => i.title), [DECLARED], "no intent may be minted by a refusal");
    const after = cli(dir, ["commit", "-m", "msg"]);
    assert.match(after.out, /A f\.txt/, `the change must still be uncaptured:\n${after.out}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an oid that is not an intent is refused, and says what it actually is", async () => {
  const { dir, intent } = await declared();
  try {
    const repo = await Repo.open(dir);
    const session = await repo.startSession({ intentOid: intent, actor: ACTOR });
    const r = cli(dir, ["commit", "-m", "msg", "--intent", session]);
    assert.equal(r.status, 1, `a non-intent oid must fail:\n${r.out}`);
    assert.match(r.out, /not an intent/, `it must say the oid is the wrong kind:\n${r.out}`);
    assert.match(r.out, /session/, `it must name what the oid actually is:\n${r.out}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("git-sync carries the intent through to the capture it reports", async () => {
  // gitSync only wraps commitWorkingTree, and its `captured.intent` is what the git trailer
  // is built from (repo.ts, `AVCS-Intent:`). Asserting it here covers the trailer without
  // needing a git repo to read it back out of.
  const { dir, intent } = await declared();
  try {
    const repo = await Repo.open(dir);
    const r = await repo.gitSync({ message: "synced", actor: ACTOR, intentOid: intent });
    assert.equal(r.captured.intent, intent, "the trailer's intent is the declared one");
    assert.deepEqual((await intentsIn(dir)).map((i) => i.title), [DECLARED], "no second intent may be minted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("with nothing passed, capture still opens its own intent — unchanged default", async () => {
  // The fix is opt-in. A human running `avcs commit` with no declared intent must behave
  // exactly as before, or this becomes a breaking change wearing a bugfix's clothes.
  const { dir } = await declared();
  try {
    const r = cli(dir, ["commit", "-m", "a plain commit"]);
    assert.equal(r.status, 0, `the commit succeeds:\n${r.out}`);
    const titles = (await intentsIn(dir)).map((i) => i.title).sort();
    assert.deepEqual(titles, [DECLARED, "a plain commit"].sort(), "capture still mints an intent titled with the message");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

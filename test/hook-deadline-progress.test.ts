// A capture that cannot finish inside the git-hook deadline must still leave progress behind
// (issue #181). It did not: the hook exited the process at the bound, and because a capture
// stages its writes (`store.batched`) and flushes at the end, exiting mid-way discarded every
// op it had authored. A store whose next capture needed >30 s therefore made no progress on
// any commit — one repo stopped recording for six days while every hook printed success.
//
// The fix is cooperative: `commitWorkingTree` / `gitSync` take an AbortSignal and stop at the
// next op boundary, return what they authored (flushed, durable) plus a `partial.remaining`
// count, and the next capture continues from there. The abort here is driven from inside the
// store's `put` so the test never races a stopwatch (#55).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { partialCaptureMessage, preCommitTimeoutMessage } from "../src/git/hookTimeoutMessage.ts";

const human = { kind: "human" as const, id: "human:h" };

/** A repo whose working tree holds `n` new files. */
async function treeWith(n: number): Promise<{ repo: Repo; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-deadline-"));
  const repo = await Repo.init(dir);
  await mkdir(join(dir, "src"), { recursive: true });
  for (let i = 0; i < n; i++) await writeFile(join(dir, "src", `f${String(i).padStart(3, "0")}.txt`), `${i}\n`);
  return { repo, dir };
}

/** Abort `ac` once the store has taken `afterPuts` objects — deterministic, no timers. */
function abortAfterPuts(repo: Repo, ac: AbortController, afterPuts: number): void {
  const store = repo.store as unknown as { put(obj: object): Promise<string> };
  const orig = store.put.bind(store);
  let n = 0;
  store.put = async (obj: object) => {
    const oid = await orig(obj);
    if (++n === afterPuts) ac.abort();
    return oid;
  };
}

test("an aborted capture stops at an op boundary, keeps what it authored, and counts the rest", async () => {
  const { repo, dir } = await treeWith(40);
  try {
    const ac = new AbortController();
    abortAfterPuts(repo, ac, 12); // somewhere in the middle: intent + session + a few blob/op pairs
    const r = await repo.commitWorkingTree(dir, { message: "big", actor: human, signal: ac.signal });
    assert.ok(r.partial, "the capture must report that it was cut short");
    assert.ok(r.ops.length > 0, "something was authored before the stop");
    assert.ok(r.partial!.remaining > 0, "something was left");
    assert.equal(r.ops.length + r.partial!.remaining, 40, "authored + remaining accounts for every change");
    assert.equal(r.added.length, r.ops.length, "the lists describe what WAS authored, not what was planned");

    // Durable: a fresh handle on the same store sees exactly the authored ops in the view.
    const again = await Repo.open(dir);
    const view = await again.materialize("main");
    assert.equal(view.tree.size, r.ops.length, "the flushed ops project; nothing staged was lost");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the next capture continues from where the aborted one stopped — progress converges", async () => {
  const { repo, dir } = await treeWith(30);
  try {
    const ac = new AbortController();
    abortAfterPuts(repo, ac, 10);
    const first = await repo.commitWorkingTree(dir, { message: "part 1", actor: human, signal: ac.signal });
    assert.ok(first.partial);

    const second = await (await Repo.open(dir)).commitWorkingTree(dir, { message: "part 2", actor: human });
    assert.equal(second.partial, undefined, "the remainder fits and finishes");
    assert.equal(second.ops.length, first.partial!.remaining, "only what was left is authored — nothing is redone");
    const view = await (await Repo.open(dir)).materialize("main");
    assert.equal(view.tree.size, 30);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gitSync passes the signal through and, when partial, makes no checkpoint and no reprojection", async () => {
  const { repo, dir } = await treeWith(30);
  try {
    const ac = new AbortController();
    abortAfterPuts(repo, ac, 10);
    const r = await repo.gitSync({ message: "hook", actor: human, workDir: dir, signal: ac.signal });
    assert.ok(r.partial, "gitSync surfaces the partial capture");
    assert.equal(r.checkpoint, undefined, "a checkpoint would claim a tree the working tree is not");
    assert.equal(r.reprojected, undefined, "reprojecting a half-captured view would delete the unreached files");
    assert.deepEqual(r.conflicts, []);
    assert.equal(r.captured.ops.length + r.partial!.remaining, 30);

    const done = await (await Repo.open(dir)).gitSync({ message: "hook again", actor: human, workDir: dir });
    assert.equal(done.partial, undefined);
    assert.ok(done.checkpoint, "the completing sync checkpoints");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unaborted signal changes nothing", async () => {
  const { repo, dir } = await treeWith(5);
  try {
    const r = await repo.commitWorkingTree(dir, { message: "all", actor: human, signal: new AbortController().signal });
    assert.equal(r.partial, undefined);
    assert.equal(r.ops.length, 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the messages say what is and is not on disk", () => {
  const partial = partialCaptureMessage("pre-commit", 30_000, 312, 273);
  assert.match(partial, /312 operation\(s\) were captured and are durable/);
  assert.match(partial, /273 change\(s\) were not reached/);
  assert.match(partial, /continues from here, not from zero/);
  assert.match(partial, /no AVCS checkpoint or trailer/);

  const hard = preCommitTimeoutMessage(30_000);
  assert.match(hard, /could not stop cleanly/);
  assert.match(hard, /Nothing from this capture is on disk/, "a staged capture that exits mid-way flushed nothing — the message must not promise otherwise");
  assert.doesNotMatch(hard, /stays in the store/);
});

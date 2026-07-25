// Phase 16 M1.2 (docs/18 §1.2) — bounded reads.
//
// An unbounded response is a token bomb: materialize's file list, history, and blob
// contents all grow with the repo, and an agent pays for every byte. Each read here gains
// a limit with a documented default, and — the part that matters — says so in the response
// (`total`, `filesTruncated`, `truncated`) so an omission is never silent.
//
// The invariants that must NOT be bounded stay whole: treeHash, statuses, conflicts and
// dropped are correctness data, not listing data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { TOOLS, runTool } from "../src/mcp/server.ts";
import type { Actor } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

function tool(name: string) {
  const t = TOOLS.find((t) => t.name === name);
  assert.ok(t, `tool ${name} is registered`);
  return t!;
}

async function call(name: string, repo: Repo, args: Record<string, unknown> = {}): Promise<any> {
  const res = await runTool(tool(name), repo, args);
  assert.notEqual(res.isError, true, `${name} failed: ${res.content[0]!.text}`);
  return JSON.parse(res.content[0]!.text);
}

async function tmpRepo(): Promise<{ repo: Repo; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-mcp-bound-"));
  return { repo: await Repo.init(dir), dir };
}

/** Author `n` sequential edits to one path so history has depth. */
async function authorN(repo: Repo, path: string, n: number): Promise<void> {
  const intent = await repo.createIntent({ title: `edit ${path}`, owner: "human:h" });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  for (let k = 0; k < n; k++) {
    await repo.proposeFileWrite({
      sessionOid: sess, intentOid: intent, actor: ai,
      path, content: `v${k}\n`, declaredPurpose: `rev ${k}`,
    });
  }
}

// ── avcs.history ────────────────────────────────────────────────────────────

// history returns an ARRAY and must keep doing so: docs/18 §2 principle 1 and the second
// recorded risk in §5 both say success shapes are never wrapped. (§1.2's table says "total
// 가산", but a field cannot be added to an array — the principle wins.) A full page is the
// standard "there may be more" signal, and `cursor` pages on from there.
test("history is capped at a default limit and stays an array", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    await authorN(repo, "a.ts", 25);
    const res = await call("avcs.history", repo, { entityKey: "file:a.ts" });
    assert.ok(Array.isArray(res), "the array shape is preserved for existing consumers");
    assert.equal(res.length, 20, "default limit is 20");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("history honours an explicit limit", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    await authorN(repo, "a.ts", 10);
    const res = await call("avcs.history", repo, { entityKey: "file:a.ts", limit: 3 });
    assert.equal(res.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the history cursor pages forward without repeating or skipping an op", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    await authorN(repo, "a.ts", 7);
    const first = await call("avcs.history", repo, { entityKey: "file:a.ts", limit: 4 });
    const second = await call("avcs.history", repo, {
      entityKey: "file:a.ts", limit: 4, cursor: first[first.length - 1].op,
    });
    assert.equal(second.length, 3, "the tail page is short — that is the end signal");
    const seen = [...first, ...second].map((o: any) => o.op);
    assert.equal(new Set(seen).size, 7, "every op appears exactly once across the pages");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── avcs.intent.list ────────────────────────────────────────────────────────

test("intent.list is capped at a default limit", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    for (let i = 0; i < 55; i++) await repo.createIntent({ title: `i${i}`, owner: "human:h" });
    const res = await call("avcs.intent.list", repo, {});
    assert.equal(res.length, 50, "default limit is 50");
    const few = await call("avcs.intent.list", repo, { limit: 5 });
    assert.equal(few.length, 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── avcs.view.materialize ───────────────────────────────────────────────────

test("materialize caps the file list, reports the total, and flags truncation", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const intent = await repo.createIntent({ title: "many", owner: "human:h" });
    const sess = await repo.startSession({ intentOid: intent, actor: ai });
    for (let i = 0; i < 12; i++) {
      await repo.proposeFileWrite({
        sessionOid: sess, intentOid: intent, actor: ai,
        path: `f${String(i).padStart(2, "0")}.ts`, content: "x\n", declaredPurpose: "p",
      });
    }
    const res = await call("avcs.view.materialize", repo, { filesLimit: 5 });
    assert.equal(res.files.length, 5);
    assert.equal(res.filesTotal, 12);
    assert.equal(res.filesTruncated, true);
    // Correctness data is never bounded.
    assert.ok(res.treeHash, "treeHash stays whole");
    assert.ok(res.status, "statuses stay whole");
    assert.ok(Array.isArray(res.conflicts), "conflicts stay whole");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("materialize does not flag truncation when everything fits", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const intent = await repo.createIntent({ title: "few", owner: "human:h" });
    const sess = await repo.startSession({ intentOid: intent, actor: ai });
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "a.ts", content: "x\n", declaredPurpose: "p" });
    const res = await call("avcs.view.materialize", repo, {});
    assert.equal(res.filesTruncated, false);
    assert.equal(res.filesTotal, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pathsOnlyUnder narrows the listing to a subtree, and the total reflects the filter", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const intent = await repo.createIntent({ title: "tree", owner: "human:h" });
    const sess = await repo.startSession({ intentOid: intent, actor: ai });
    for (const p of ["src/a.ts", "src/b.ts", "docs/c.md"]) {
      await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: p, content: "x\n", declaredPurpose: "p" });
    }
    const res = await call("avcs.view.materialize", repo, { pathsOnlyUnder: "src/" });
    assert.deepEqual(res.files, ["src/a.ts", "src/b.ts"]);
    assert.equal(res.filesTotal, 2, "the total counts the filtered set, not the whole tree");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── avcs.object.show ────────────────────────────────────────────────────────

test("object.show truncates a large blob at maxBytes and says it did", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const big = "x".repeat(5000) + "\n";
    const oid = await repo.putBlob(big);
    const res = await call("avcs.object.show", repo, { oid, maxBytes: 100 });
    assert.equal(res.truncated, true);
    assert.equal(res.bytes, big.length, "bytes is the FULL size, not the returned slice");
    assert.ok(res.text.length <= 100, `returned slice respects maxBytes, got ${res.text.length}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("object.show returns a line range when asked", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const oid = await repo.putBlob("l1\nl2\nl3\nl4\nl5\n");
    const res = await call("avcs.object.show", repo, { oid, lines: { start: 2, end: 4 } });
    assert.equal(res.text, "l2\nl3\nl4\n");
    assert.equal(res.truncated, true, "a slice of a larger blob is a truncation");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a small blob read whole is not marked truncated", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const oid = await repo.putBlob("tiny\n");
    const res = await call("avcs.object.show", repo, { oid });
    assert.equal(res.truncated, false);
    assert.equal(res.text, "tiny\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── avcs.diff ───────────────────────────────────────────────────────────────

test("diff defaults to the existing paths shape (backward compatible)", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const res = await call("avcs.diff", repo, { viewA: "main", viewB: "main" });
    assert.ok("added" in res && "removed" in res, `paths shape preserved, got ${JSON.stringify(res)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("diff format:patch emits a unified diff for a changed file", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const intent = await repo.createIntent({ title: "d", owner: "human:h" });
    const sess = await repo.startSession({ intentOid: intent, actor: ai });
    const base = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "a.ts", content: "one\ntwo\n", declaredPurpose: "p" });
    await repo.createLine("feat", "main");
    // A line edit must build on that line's frontier, or the line materializes empty.
    await repo.proposeEdit({
      sessionOid: sess, intentOid: intent, actor: ai, line: "feat",
      path: "a.ts", newText: "one\nTWO\n", declaredPurpose: "p",
      causalDeps: await repo.lineFrontier("feat"),
    });
    assert.ok(base, "base op authored");
    const res = await call("avcs.diff", repo, { viewA: "main", viewB: "feat", format: "patch" });
    const patch = JSON.stringify(res);
    assert.match(patch, /@@/, "unified diff carries hunk headers");
    assert.match(patch, /\+TWO/, "the added line appears with a + prefix");
    assert.match(patch, /-two/, "the removed line appears with a - prefix");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

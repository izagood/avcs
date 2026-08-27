import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { gitCliSource, importGitHistory } from "../src/importer/gitHistory.ts";

/**
 * Hardening for the git-driven import source (issue #71). A server process feeds
 * this untrusted input, so: no option injection through positional values, a
 * bounded runtime, and no redirect following (a vetted URL must not pivot).
 */

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("rejects a source that would be read as a git option", { skip: !hasGit }, async () => {
  await assert.rejects(
    () => gitCliSource({ dir: "--upload-pack=touch /tmp/avcs-pwned" }),
    /option|--|not a valid/i,
    "a source starting with `-` must be refused, not handed to git",
  );
});

test("rejects a ref that would be read as a git option", { skip: !hasGit }, async () => {
  const src = await mkdtemp(join(tmpdir(), "avcs-h-src-"));
  execFileSync("git", ["-C", src, "init", "-q"]);
  await assert.rejects(
    () => gitCliSource({ dir: src, ref: "--output=/tmp/avcs-pwned" }),
    /option|--|not a valid/i,
    "a ref starting with `-` must be refused",
  );
});

test("bounds a hanging clone with timeoutMs", { skip: !hasGit }, async () => {
  // A listener that accepts and never answers: git blocks on the initial
  // info/refs request, which is exactly the shape that hung a server.
  const server = createServer(() => {
    /* never respond */
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const started = Date.now();
    // The guarantee is the BOUND, not a particular message: git words a stalled
    // transfer differently across versions and platforms, and the process-level
    // backstop reports differently again.
    await assert.rejects(() =>
      gitCliSource({ url: `http://127.0.0.1:${port}/o/r.git`, timeoutMs: 1500 }),
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 12_000, `should give up near the bound, took ${elapsed}ms`);
  } finally {
    server.close();
  }
});

test("does not follow redirects into another host", { skip: !hasGit }, async () => {
  // The pivot target records whether it was ever reached.
  let pivotHits = 0;
  const pivot = createServer((_req, res) => {
    pivotHits += 1;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("internal");
  });
  await new Promise<void>((resolve) => pivot.listen(0, "127.0.0.1", resolve));
  const pivotPort = (pivot.address() as { port: number }).port;

  const redirector = createServer((req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${pivotPort}${req.url ?? "/"}` });
    res.end();
  });
  await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
  const redirPort = (redirector.address() as { port: number }).port;

  try {
    await assert.rejects(
      () => gitCliSource({ url: `http://127.0.0.1:${redirPort}/o/r.git`, timeoutMs: 20_000 }),
      /./,
      "the clone fails either way; the point is where git went",
    );
    assert.equal(pivotHits, 0, "git must not have followed the redirect to the other host");
  } finally {
    redirector.close();
    pivot.close();
  }
});

test("a caller can still import normally (no regression)", { skip: !hasGit }, async () => {
  const src = await mkdtemp(join(tmpdir(), "avcs-h-ok-"));
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", src, "-c", "user.email=h@e.com", "-c", "user.name=H", ...a], {
      stdio: "ignore",
    });
  git("init", "-q", "-b", "main");
  await writeFile(join(src, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-q", "-m", "add a");

  const repo = await Repo.init(await mkdtemp(join(tmpdir(), "avcs-h-repo-")));
  const res = await importGitHistory(repo, { dir: src, timeoutMs: 30_000 });
  assert.equal(res.commits, 1);
  assert.equal(res.operations, 1);
});

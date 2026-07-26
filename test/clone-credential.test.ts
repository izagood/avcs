// `avcs clone` against a hub that gates reads (issue #58).
//
// #50 taught the client to sign reads, which fixed sync and push. Clone still could not
// reach a private repository, and the reason is structural rather than an oversight:
// signing needs a key in the target repo's keystore, and clone is the command that CREATES
// that repo. A freshly init'd directory holds no key by construction, so there is nothing
// to sign the first GET /have with.
//
// The fix therefore has to bring a credential in from outside, and then leave it behind so
// the clone is usable afterwards — a clone that works once and whose `sync` then 401s would
// just move the problem.
//
// The reference hub is read-public by design, so these drive a small gating proxy in front
// of it. That is the honest way to exercise the client: assert on what it sends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { Repo } from "../src/api/repo.ts";
import { startHub } from "../src/hub/hubServer.ts";
import { parseAuthHeader } from "../src/hub/transportAuth.ts";
import type { Actor } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

async function author(repo: Repo, path: string, content: string): Promise<string> {
  const intent = await repo.createIntent({ title: `w ${path}`, owner: "human:h" });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  return repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path, content, declaredPurpose: "p" });
}

/** A hub front that refuses every unsigned request — what a multi-tenant deployment does. */
async function gatingProxy(upstream: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (!parseAuthHeader(req.headers["authorization"])) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthenticated" }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const body = Buffer.concat(chunks);
        const r = await fetch(`${upstream}${req.url}`, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          ...(body.length ? { body } : {}),
        });
        res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
        res.end(Buffer.from(await r.arrayBuffer()));
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** A hub holding one file, plus a key file an operator could hand to a new machine. */
async function seeded(): Promise<{ hubDir: string; srcDir: string; hub: Awaited<ReturnType<typeof startHub>>; keyFile: string; op: string }> {
  const hubDir = await mkdtemp(join(tmpdir(), "avcs-cc-hub-"));
  const srcDir = await mkdtemp(join(tmpdir(), "avcs-cc-src-"));
  const hub = await startHub({ repoDir: hubDir });
  const src = await Repo.init(srcDir);
  await src.provisionOwnerKey({ kind: "human", id: "human:h" });
  const op = await author(src, "a.ts", "content\n");
  await src.pushHub(hub.url, { as: "human:h" });
  const keyFile = join(srcDir, ".avcs", "private", "human:h.json");
  return { hubDir, srcDir, hub, keyFile, op };
}

test("clone with a supplied key reaches a repo whose reads are gated", async () => {
  const { hubDir, srcDir, hub, keyFile, op } = await seeded();
  const proxy = await gatingProxy(hub.url);
  const dest = await mkdtemp(join(tmpdir(), "avcs-cc-dest-"));
  try {
    const repo = await Repo.init(dest);
    await repo.importLocalKey(keyFile);
    const r = await repo.pullHub(proxy.url, { as: "human:h" });
    assert.ok(r.pulled > 0, "objects arrived through the gate");
    assert.ok(await repo.store.has(op));
  } finally {
    await proxy.close();
    await hub.close();
    for (const d of [hubDir, srcDir, dest]) await rm(d, { recursive: true, force: true });
  }
});

test("the supplied key is left behind, so the clone's later syncs also work", async () => {
  const { hubDir, srcDir, hub, keyFile } = await seeded();
  const dest = await mkdtemp(join(tmpdir(), "avcs-cc-dest-"));
  try {
    const repo = await Repo.init(dest);
    const actorId = await repo.importLocalKey(keyFile);
    assert.equal(actorId, "human:h", "the actor is derived from the key file");
    // A clone that worked once but left nothing behind would just move the problem.
    assert.ok(await repo.loadLocalKey("human:h"), "the key now lives in the cloned repo");
    assert.deepEqual(await repo.listLocalKeys(), ["human:h"]);
  } finally {
    await hub.close();
    for (const d of [hubDir, srcDir, dest]) await rm(d, { recursive: true, force: true });
  }
});

test("importing from an existing repo directory works, not just a bare key file", async () => {
  // The common case on a machine that already has the repo once: point at it rather than
  // hunting for the file inside .avcs/private.
  const { hubDir, srcDir, hub } = await seeded();
  const dest = await mkdtemp(join(tmpdir(), "avcs-cc-dest-"));
  try {
    const repo = await Repo.init(dest);
    const actorId = await repo.importLocalKey(srcDir);
    assert.equal(actorId, "human:h");
    assert.ok(await repo.loadLocalKey("human:h"));
  } finally {
    await hub.close();
    for (const d of [hubDir, srcDir, dest]) await rm(d, { recursive: true, force: true });
  }
});

test("a source holding several keys requires saying which one", async () => {
  const { hubDir, srcDir, hub } = await seeded();
  const dest = await mkdtemp(join(tmpdir(), "avcs-cc-dest-"));
  try {
    const src = await Repo.open(srcDir);
    await src.provisionOwnerKey({ kind: "ai_agent", id: "ai:b" });
    const repo = await Repo.init(dest);
    await assert.rejects(
      () => repo.importLocalKey(srcDir),
      /which/i,
      "an ambiguous source names the choice rather than picking silently",
    );
    assert.equal(await repo.importLocalKey(srcDir, "ai:b"), "ai:b");
  } finally {
    await hub.close();
    for (const d of [hubDir, srcDir, dest]) await rm(d, { recursive: true, force: true });
  }
});

test("a malformed key file fails with a message that says what was wrong", async () => {
  const dest = await mkdtemp(join(tmpdir(), "avcs-cc-dest-"));
  const bad = join(dest, "notakey.json");
  try {
    await writeFile(bad, JSON.stringify({ hello: "world" }), "utf8");
    const repo = await Repo.init(dest);
    await assert.rejects(() => repo.importLocalKey(bad), /key/i);
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});

test("cloning a read-public hub still needs no key at all", async () => {
  const { hubDir, srcDir, hub, op } = await seeded();
  const dest = await mkdtemp(join(tmpdir(), "avcs-cc-dest-"));
  try {
    const repo = await Repo.init(dest);
    const r = await repo.pullHub(hub.url);
    assert.ok(r.pulled > 0);
    assert.ok(await repo.store.has(op));
    assert.deepEqual(await repo.listLocalKeys(), [], "no key was invented");
  } finally {
    await hub.close();
    for (const d of [hubDir, srcDir, dest]) await rm(d, { recursive: true, force: true });
  }
});

test("the key file an operator hands over is the same shape the keystore writes", async () => {
  // Pins the interchange format: whatever `key provision` produced on one machine must be
  // loadable on another, or "hand the key over" is not actually a procedure.
  const { hubDir, srcDir, hub, keyFile } = await seeded();
  try {
    const parsed = JSON.parse(await readFile(keyFile, "utf8")) as Record<string, unknown>;
    assert.equal(typeof parsed.actorId, "string");
    assert.equal(typeof parsed.privateKey, "string");
  } finally {
    await hub.close();
    for (const d of [hubDir, srcDir]) await rm(d, { recursive: true, force: true });
  }
});

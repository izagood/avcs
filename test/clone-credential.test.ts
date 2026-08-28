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
// UPDATE (issue #98): the premise above was itself the defect. Keys are machine-scoped now,
// so the credential does not have to cross a boundary — there is no boundary. `clone` signs
// its first GET /have with the machine identity and needs no flag at all; `--key` is the
// escape hatch it should always have been. `clone reaches a gated hub with NO --key` below
// is the proof that #98 dissolved #58 rather than moving the code around.
//
// These tests point AVCS_CONFIG_HOME at a per-test temp dir: they must never read or write
// the developer's real ~/.avcs, and `key provision` writes to the machine keystore now.
//
// The reference hub is read-public by design, so these drive a small gating proxy in front
// of it. That is the honest way to exercise the client: assert on what it sends.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { Repo } from "../src/api/repo.ts";
import { machineKeyPath } from "../src/api/keystore.ts";
import { signMessage, verifyMessage } from "../src/core/identity.ts";
import { startHub } from "../src/hub/hubServer.ts";
import { parseAuthHeader } from "../src/hub/transportAuth.ts";
import type { Actor } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

// A fresh machine keystore per test (issue #98). Never the real ~/.avcs: these tests
// provision keys, and that is the developer's own credential store. Per TEST rather than
// per file, because `cloning a read-public hub still needs no key at all` asserts that no
// key is held — a key another test provisioned machine-wide would silently break it.
let ksHome: string;
let ksPrev: string | undefined;
beforeEach(async () => {
  ksPrev = process.env.AVCS_CONFIG_HOME;
  ksHome = await mkdtemp(join(tmpdir(), "avcs-cc-home-"));
  process.env.AVCS_CONFIG_HOME = ksHome;
});
afterEach(async () => {
  if (ksPrev === undefined) delete process.env.AVCS_CONFIG_HOME;
  else process.env.AVCS_CONFIG_HOME = ksPrev;
  await rm(ksHome, { recursive: true, force: true });
});

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
  // Since #98 `provisionOwnerKey` writes to the MACHINE keystore, not the checkout — which
  // is the whole point: the identity is the machine's. The interchange file an operator
  // hands to another box is the same shape, just at a different path.
  const keyFile = machineKeyPath("human:h");
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
  // Point at a repo rather than hunting for the file inside .avcs/private. Since #98 the
  // repo-local store is the OVERRIDE, so this is the case the form still serves: lift a
  // second identity out of the checkout that deliberately holds one.
  const { hubDir, srcDir, hub } = await seeded();
  const dest = await mkdtemp(join(tmpdir(), "avcs-cc-dest-"));
  try {
    const src = await Repo.open(srcDir);
    await src.saveLocalKey("human:h", (await src.loadLocalKey("human:h"))!, { scope: "repo" });
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
    // Two keys in the SOURCE's repo-local store — the ambiguity the message has to name.
    await src.saveLocalKey("human:h", (await src.loadLocalKey("human:h"))!, { scope: "repo" });
    await src.saveLocalKey("ai:b", (await src.generateActorKey({ kind: "ai_agent", id: "ai:b" })).privateKey, { scope: "repo" });
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
    // Was `listLocalKeys() === []`. Under #98 the machine legitimately holds human:h — that
    // is the identity `seeded()` provisioned on this box — so the honest form of "no key was
    // invented" is: nothing was written into the CHECKOUT, and the key that shows up is the
    // machine's, not a copy.
    assert.equal(existsSync(join(dest, ".avcs", "private")), false, "no key was invented in the checkout");
    assert.deepEqual(await repo.listLocalKeySources(), [{ actorId: "human:h", source: "machine" }]);
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

// ── issue #98: the machine keystore dissolves the bootstrap problem ───────────────────

test("clone reaches a read-gated hub with NO --key at all", async () => {
  // #58's exact scenario, and the headline claim of #98. The machine holds the identity, so
  // the freshly `Repo.init`'d directory signs its first GET /have with it — nothing is
  // carried in, because there is no boundary left to carry it across.
  const { hubDir, srcDir, hub, op } = await seeded(); // provisions human:h MACHINE-wide
  const proxy = await gatingProxy(hub.url);
  const dest = await mkdtemp(join(tmpdir(), "avcs-cc-dest-"));
  try {
    const repo = await Repo.init(dest);
    const signer = await repo.localActorId(); // what `avcs clone` now resolves with no flag
    assert.equal(signer, "human:h", "the machine identity resolves in a brand new repo");
    const r = await repo.pullHub(proxy.url, { as: signer });
    assert.ok(r.pulled > 0, "objects arrived through the gate with no --key");
    assert.ok(await repo.store.has(op));
    assert.equal(existsSync(join(dest, ".avcs", "private")), false, "and no key was copied into the checkout");
  } finally {
    await proxy.close();
    await hub.close();
    for (const d of [hubDir, srcDir, dest]) await rm(d, { recursive: true, force: true });
  }
});

test("the same clone through the CLI needs no --key either", async () => {
  // The API test above proves the resolution; this proves the wiring, since `clone`'s signer
  // used to come only from `--key`/`--as`.
  const { hubDir, srcDir, hub } = await seeded();
  const proxy = await gatingProxy(hub.url);
  const dest = await mkdtemp(join(tmpdir(), "avcs-cc-dest-"));
  try {
    // execFile, NOT execFileSync: the gating proxy runs on THIS process's event loop, so a
    // synchronous spawn would block the very server the CLI is talking to.
    const { stdout: out } = await promisify(execFile)(
      process.execPath,
      ["--experimental-strip-types", join(import.meta.dirname, "..", "src", "cli.ts"), "clone", proxy.url, dest],
      { encoding: "utf8", env: { ...process.env, AVCS_CONFIG_HOME: ksHome } },
    );
    assert.match(out, /signing as human:h/);
    assert.match(out, /cloned [1-9]\d* object/);
  } finally {
    await proxy.close();
    await hub.close();
    for (const d of [hubDir, srcDir, dest]) await rm(d, { recursive: true, force: true });
  }
});

test("--key still wins over the machine identity, and stays confined to the repo", async () => {
  // The escape hatch #98 leaves in place: this checkout must sign as someone else. Importing
  // must not install that credential machine-wide behind the user's back.
  const { hubDir, srcDir, hub, keyFile } = await seeded();
  const dest = await mkdtemp(join(tmpdir(), "avcs-cc-dest-"));
  try {
    const src = await Repo.open(srcDir);
    await src.provisionOwnerKey({ kind: "ai_agent", id: "ai:b" }); // a second machine identity
    const repo = await Repo.init(dest);
    const id = await repo.importLocalKey(keyFile);
    assert.equal(id, "human:h");
    assert.equal(existsSync(join(dest, ".avcs", "private", "human:h.json")), true, "the override is repo-local");
    assert.deepEqual(await repo.listLocalKeySources(), [
      { actorId: "ai:b", source: "machine" },
      // `shadowed` because seeded() also provisioned human:h machine-wide: the override is
      // hiding the machine identity here, which `key ls` says out loud.
      { actorId: "human:h", source: "repo", shadowed: true },
    ]);
  } finally {
    await hub.close();
    for (const d of [hubDir, srcDir, dest]) await rm(d, { recursive: true, force: true });
  }
});

test("an imported key is TRUSTED, not just signable (the #96 note)", async () => {
  // `importLocalKey` used to persist only the private half, so the clone reported
  // `signable 1 / trusted 0`: it could sign and nothing it signed was honored. ed25519
  // private keys carry the public point, so the trust record is recoverable.
  const { hubDir, srcDir, hub, keyFile } = await seeded();
  const dest = await mkdtemp(join(tmpdir(), "avcs-cc-dest-"));
  try {
    const repo = await Repo.init(dest);
    await repo.importLocalKey(keyFile);
    assert.deepEqual(await repo.listTrustedKeys(), ["human:h"], "trusted is no longer 0");
    // and it is the RIGHT public key: it verifies a signature made with the imported private half.
    const rec = JSON.parse(await readFile(join(dest, ".avcs", "keys", "human:h.json"), "utf8")) as { publicKey: string };
    const priv = (await repo.loadLocalKey("human:h"))!;
    assert.equal(verifyMessage(rec.publicKey, "some-oid", signMessage(priv, "some-oid")), true);
  } finally {
    await hub.close();
    for (const d of [hubDir, srcDir, dest]) await rm(d, { recursive: true, force: true });
  }
});

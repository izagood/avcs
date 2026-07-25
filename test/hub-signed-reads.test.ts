// The client signs READS as well as writes (issue #50).
//
// The reference hub is read-public by design (D2), so the client never needed a read
// credential and the omission was invisible against it. It stops being invisible the moment
// `startHub({ auth: { resolvePublicKey } })` is used for what it is for: an embedder with
// per-repo access control necessarily gates reads.
//
// The failure was total, not partial. `pushToHub` begins by asking the hub what it already
// holds, so on a read-gated hub a client could neither pull NOR push — `GET /have` returned
// 401 before a single object moved.
//
// Signing reads is additive: a hub that does not require it ignores the header, so the
// reference hub is unaffected and no protocol bump is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { Repo } from "../src/api/repo.ts";
import { startHub } from "../src/hub/hubServer.ts";
import { generateKeypair } from "../src/core/identity.ts";
import { parseAuthHeader } from "../src/hub/transportAuth.ts";
import type { Actor } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

async function author(repo: Repo, path: string, content: string): Promise<string> {
  const intent = await repo.createIntent({ title: `w ${path}`, owner: "human:h" });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  return repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path, content, declaredPurpose: "p" });
}

/**
 * A recording proxy in front of a real hub: forwards everything, but remembers which
 * paths arrived carrying an AVCS-Sig credential. Lets the test assert on what the CLIENT
 * sent without reimplementing a hub.
 */
async function signatureProbe(upstream: string): Promise<{ url: string; signed: Set<string>; seen: Set<string>; close: () => Promise<void> }> {
  const signed = new Set<string>();
  const seen = new Set<string>();
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    seen.add(path);
    if (parseAuthHeader(req.headers["authorization"])) signed.add(path);
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
  return {
    url: `http://127.0.0.1:${port}`,
    signed,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("pull signs every read it makes, when the replica holds a key", async () => {
  const hubDir = await mkdtemp(join(tmpdir(), "avcs-sr-hub-"));
  const aDir = await mkdtemp(join(tmpdir(), "avcs-sr-a-"));
  const bDir = await mkdtemp(join(tmpdir(), "avcs-sr-b-"));
  try {
    const hub = await startHub({ repoDir: hubDir });
    const probe = await signatureProbe(hub.url);
    try {
      const b = await Repo.init(bDir);
      await author(b, "b.ts", "from b\n");
      await b.pushHub(hub.url);

      const a = await Repo.init(aDir);
      await a.provisionOwnerKey({ kind: "human", id: "human:h" });
      await a.pullHub(probe.url);

      assert.ok(probe.seen.has("/have") || probe.seen.has("/sync"), `a read happened: ${[...probe.seen]}`);
      for (const p of ["/have", "/sync", "/refs"]) {
        if (probe.seen.has(p)) assert.ok(probe.signed.has(p), `${p} carried a credential`);
      }
    } finally {
      await probe.close();
      await hub.close();
    }
  } finally {
    for (const d of [hubDir, aDir, bDir]) await rm(d, { recursive: true, force: true });
  }
});

test("push signs the /have it starts with — the read that used to 401 first", async () => {
  const hubDir = await mkdtemp(join(tmpdir(), "avcs-sr-hub-"));
  const aDir = await mkdtemp(join(tmpdir(), "avcs-sr-a-"));
  try {
    const hub = await startHub({ repoDir: hubDir });
    const probe = await signatureProbe(hub.url);
    try {
      const a = await Repo.init(aDir);
      await a.provisionOwnerKey({ kind: "human", id: "human:h" });
      await author(a, "a.ts", "mine\n");
      await a.pushHub(probe.url, { as: "human:h" });
      assert.ok(probe.signed.has("/have"), `push signed its opening read: signed=${[...probe.signed]}`);
    } finally {
      await probe.close();
      await hub.close();
    }
  } finally {
    for (const d of [hubDir, aDir]) await rm(d, { recursive: true, force: true });
  }
});

test("a replica with no key still reads — signing is best-effort, not a new requirement", async () => {
  const hubDir = await mkdtemp(join(tmpdir(), "avcs-sr-hub-"));
  const aDir = await mkdtemp(join(tmpdir(), "avcs-sr-a-"));
  const bDir = await mkdtemp(join(tmpdir(), "avcs-sr-b-"));
  try {
    const hub = await startHub({ repoDir: hubDir });
    try {
      const b = await Repo.init(bDir);
      const op = await author(b, "b.ts", "from b\n");
      await b.pushHub(hub.url);

      // No provisionOwnerKey here: the reference hub is read-public, and that must keep working.
      const a = await Repo.init(aDir);
      const r = await a.pullHub(hub.url);
      assert.ok(r.pulled > 0);
      assert.ok(await a.store.has(op));
    } finally {
      await hub.close();
    }
  } finally {
    for (const d of [hubDir, aDir, bDir]) await rm(d, { recursive: true, force: true });
  }
});

test("the read signature covers the GET method, so it cannot be replayed as a write", async () => {
  // canonicalRequest binds the method, so a captured GET credential does not authenticate
  // a POST to the same path. Pinned because it is the property that makes signing reads safe.
  const kp = generateKeypair();
  const { buildAuthHeader, verifyAuth } = await import("../src/hub/transportAuth.ts");
  const header = buildAuthHeader({ keyId: "ai:a", privateKey: kp.privateKey, method: "GET", path: "/have", body: "" });
  const asWrite = await verifyAuth({
    header, method: "POST", path: "/have", body: "",
    resolvePublicKey: async () => kp.publicKey, now: Date.now(),
  });
  assert.equal(asWrite.ok, false, "a GET credential does not verify as a POST");
});

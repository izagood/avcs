// A signing key has to be reachable from the surfaces people and agents actually use.
//
// `Repo.provisionOwnerKey` was the only way to mint one, and it appeared in src/ exactly
// once outside its own definition — inside an error message telling the caller to invoke
// it. Any signed action (recording a decision, pushing to an auth-required hub) therefore
// failed on a fresh repo with no way forward that did not involve writing a script
// (issue #51).
//
// Two distinct questions, and the surface must not blur them:
//   - which public keys does this REPO trust?      (keys/ — shared, gossiped)
//   - which private keys can THIS MACHINE sign with? (local, never shared)
// Listing the second must never print the key material itself.
//
// Since issue #98 the second really is machine-scoped: private keys live in
// `~/.avcs/private/` (see src/api/keystore.ts), with `<store>/private/` kept as a per-repo
// override. `test/_isolate-keystore.ts`, loaded by `npm test`, gives each test its own
// keystore so these never touch the developer's real one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { TOOLS, runTool } from "../src/mcp/server.ts";

async function tmpRepo(): Promise<{ repo: Repo; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-key-"));
  return { repo: await Repo.init(dir), dir };
}

function tool(name: string) {
  const t = TOOLS.find((t) => t.name === name);
  assert.ok(t, `tool ${name} is registered`);
  return t!;
}

test("listLocalKeys reports which actors this machine can sign as", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    assert.deepEqual(await repo.listLocalKeys(), [], "a fresh repo signs as nobody");
    await repo.provisionOwnerKey({ kind: "human", id: "human:h" });
    assert.deepEqual(await repo.listLocalKeys(), ["human:h"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listing local keys never exposes the key material", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    await repo.provisionOwnerKey({ kind: "human", id: "human:h" });
    const listed = JSON.stringify(await repo.listLocalKeys());
    const priv = await repo.loadLocalKey("human:h");
    assert.ok(priv, "the key exists");
    assert.ok(!listed.includes(priv!), "the private key is not in the listing");
    assert.ok(!/PRIVATE KEY/.test(listed), "no PEM body leaks into the listing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("avcs.key.provision mints a key an agent can then sign with", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const res = await runTool(tool("avcs.key.provision"), repo, {
      actor: { kind: "ai_agent", id: "ai:claude" },
    });
    assert.notEqual(res.isError, true, res.content[0]!.text);
    assert.ok(await repo.loadLocalKey("ai:claude"), "the private key is now held locally");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("avcs.key.list answers the two questions separately", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    await repo.provisionOwnerKey({ kind: "human", id: "human:h" });
    const res = await runTool(tool("avcs.key.list"), repo, {});
    assert.notEqual(res.isError, true, res.content[0]!.text);
    const body = JSON.parse(res.content[0]!.text) as { local: string[]; trusted: string[] };
    assert.deepEqual(body.local, ["human:h"], "signable on this machine");
    assert.ok(Array.isArray(body.trusted), "public keys this repo trusts are a separate list");
    assert.ok(!JSON.stringify(body).includes("PRIVATE KEY"), "no key material in the response");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("provisioning is idempotent per actor — a second call does not orphan the first key", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    await repo.provisionOwnerKey({ kind: "human", id: "human:h" });
    const first = await repo.loadLocalKey("human:h");
    await runTool(tool("avcs.key.provision"), repo, { actor: { kind: "human", id: "human:h" } });
    const second = await repo.loadLocalKey("human:h");
    assert.equal(second, first, "an existing key is kept rather than silently replaced");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the recovery hint can name the tool again, now that it exists", async () => {
  const { RECOVERY } = await import("../src/mcp/respond.ts");
  const rule = RECOVERY.find((r) => r.re.test("no local signing key for ai:x"));
  assert.ok(rule, "the failure class is still recognized");
  assert.ok(
    rule!.nextActions.some((a) => a.includes("avcs.key.provision")),
    `got ${JSON.stringify(rule!.nextActions)}`,
  );
});

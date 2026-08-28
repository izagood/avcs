// `submit` / `land` and the acting identity (issue #95).
//
// The convergence path is the whole point of Phase 14: `submit` and `land` return a VERDICT
// instead of "pull and redo". They were also the only two commands an authenticating hub
// refused by default, because the CLI substituted a literal for the actor:
//
//     by: flag("--as") ?? process.env.AVCS_ACTOR ?? "human:cli",
//
// `"human:cli"` has no key and no membership, so the hub rejected the credential outright —
// a 401, not a 403. `sync` against the same remote in the same repo succeeded, because it
// passes `as` through unset and lets the repo resolve it.
//
// The resolution chain already exists: `Repo.localActorId()` does
// explicit → AVCS_ACTOR → config.json actorId → the sole private key.
// The CLI duplicated the first two steps and then cut the chain, so it never reached the
// config or the keystore. The fix is to stop duplicating it.
//
// Note the MCP surface was already correct — `server.ts` calls integrateHub with
// `by: actorOf(i).id`, a resolved actor. This aligns the CLI with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { Repo } from "../src/api/repo.ts";
import { startHub } from "../src/hub/hubServer.ts";
import { parseAuthHeader } from "../src/hub/transportAuth.ts";
import { land } from "../src/mcp/land.ts";
import type { Actor } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

async function author(repo: Repo, path: string, content: string): Promise<string> {
  const intent = await repo.createIntent({ title: `w ${path}`, owner: "human:h" });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  return repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path, content, declaredPurpose: "p" });
}

/**
 * A hub front that refuses every request whose signature names an actor the repo does not
 * know. This is what makes the bug observable: the reference hub is read-public, so an
 * unresolved actor would sail through and the test would prove nothing.
 *
 * It records the actor each request claimed, so a test can assert WHICH identity the client
 * chose — the actual subject here — rather than only whether the call succeeded.
 */
async function actorGate(upstream: string, allowed: string): Promise<{
  url: string;
  seen: string[];
  close: () => Promise<void>;
}> {
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    const parsed = parseAuthHeader(req.headers["authorization"]);
    const claimed = parsed?.keyId;
    if (claimed !== undefined) seen.push(claimed);
    if (claimed !== allowed) {
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
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** A repo holding one op and one provisioned key, plus a gated hub in front. */
async function fixture(): Promise<{
  repo: Repo;
  gate: Awaited<ReturnType<typeof actorGate>>;
  hub: Awaited<ReturnType<typeof startHub>>;
  dirs: string[];
  cleanup: () => Promise<void>;
}> {
  const hubDir = await mkdtemp(join(tmpdir(), "avcs-95-hub-"));
  const srcDir = await mkdtemp(join(tmpdir(), "avcs-95-src-"));
  const hub = await startHub({ repoDir: hubDir });
  const repo = await Repo.init(srcDir);
  await repo.provisionOwnerKey({ kind: "human", id: "human:h" });
  await author(repo, "a.ts", "export const a = 1\n");
  const gate = await actorGate(hub.url, "human:h");
  const dirs = [hubDir, srcDir];
  return {
    repo, gate, hub, dirs,
    cleanup: async () => {
      await gate.close();
      await hub.close();
      for (const d of dirs) await rm(d, { recursive: true, force: true });
    },
  };
}

// The keystore holds exactly one key and nothing else names an actor, so this exercises
// the LAST step of the resolution chain — the one the literal made unreachable.
test("submit resolves the actor from the repo when --as is absent", async () => {
  const f = await fixture();
  try {
    const checkpoint = await f.repo.createCheckpoint("main", "submit main");
    // `by` omitted entirely: exactly what the CLI now passes.
    const r = await f.repo.integrateHub(f.gate.url, { view: "main", checkpoint });

    assert.notEqual(r.verdict, "rejected", `expected a real verdict, got ${JSON.stringify(r)}`);
    assert.deepEqual(
      [...new Set(f.gate.seen)],
      ["human:h"],
      "the client must sign as the repo's key, never as a placeholder",
    );
  } finally {
    await f.cleanup();
  }
});

test("land resolves the actor from the repo when by is absent", async () => {
  const f = await fixture();
  try {
    await f.repo.addRemote("origin", f.gate.url);
    const r = await land(f.repo, { view: "main", summary: "land main", hub: "origin" });

    assert.equal(r.landed, true, `expected a land, got ${JSON.stringify(r)}`);
    assert.deepEqual([...new Set(f.gate.seen)], ["human:h"]);
  } finally {
    await f.cleanup();
  }
});

// config.json's actorId is a step the old code skipped entirely: it stopped at AVCS_ACTOR.
test("submit honours config.json's actorId over the sole-key fallback", async () => {
  const f = await fixture();
  try {
    // A second key makes the sole-key step ambiguous, so only config.json can decide.
    await f.repo.provisionOwnerKey({ kind: "human", id: "human:other" });
    // `.avcs/config.json` is a plain file the repo reads via #readConfig — write it directly
    // rather than inventing an API for the test's convenience.
    await writeFile(join(f.repo.store.root, "config.json"), JSON.stringify({ actorId: "human:h" }), "utf8");

    const checkpoint = await f.repo.createCheckpoint("main", "submit main");
    const r = await f.repo.integrateHub(f.gate.url, { view: "main", checkpoint });

    assert.notEqual(r.verdict, "rejected", JSON.stringify(r));
    assert.deepEqual([...new Set(f.gate.seen)], ["human:h"], "config.json decided the identity");
  } finally {
    await f.cleanup();
  }
});

test("an explicit actor still wins — the existing contract does not change", async () => {
  const f = await fixture();
  try {
    await f.repo.provisionOwnerKey({ kind: "human", id: "human:other" });
    await writeFile(join(f.repo.store.root, "config.json"), JSON.stringify({ actorId: "human:other" }), "utf8");

    const checkpoint = await f.repo.createCheckpoint("main", "submit main");
    const r = await f.repo.integrateHub(f.gate.url, { view: "main", checkpoint, by: "human:h" });

    assert.notEqual(r.verdict, "rejected", JSON.stringify(r));
    assert.deepEqual([...new Set(f.gate.seen)], ["human:h"], "--as overrides config.json");
  } finally {
    await f.cleanup();
  }
});

// A user with no identity at all used to get the server's `401 Unauthorized`, which points
// at the hub and tells them nothing about the fix being on their own machine.
test("no resolvable identity fails locally, naming the fix — not with a 401", async () => {
  const hubDir = await mkdtemp(join(tmpdir(), "avcs-95-hub-"));
  const srcDir = await mkdtemp(join(tmpdir(), "avcs-95-src-"));
  const hub = await startHub({ repoDir: hubDir });
  try {
    const repo = await Repo.init(srcDir); // no provisionOwnerKey: nothing to resolve
    await author(repo, "a.ts", "export const a = 1\n");
    const checkpoint = await repo.createCheckpoint("main", "submit main");

    await assert.rejects(
      () => repo.integrateHub(hub.url, { view: "main", checkpoint }),
      (e: Error) => {
        assert.doesNotMatch(e.message, /401|Unauthorized/, "must not surface the hub's rejection");
        assert.match(e.message, /--as|AVCS_ACTOR|key provision/, "must name what the user can do");
        return true;
      },
    );
  } finally {
    await hub.close();
    for (const d of [hubDir, srcDir]) await rm(d, { recursive: true, force: true });
  }
});

// `"human:cli"` is a fine DISPLAY label for a CLI-authored op, and `avcs log` shows it that
// way. The bug was using it where a credential was required; the label must stay.
test("human:cli remains the display attribution for a CLI-authored op", async () => {
  const cli = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");

  // The display role stays: `avcs commit --author` defaults to it, and `avcs log` prints it.
  assert.match(cli, /flag\("--author"\) \?\? "human:cli"/, "the --author default is unchanged");

  // The authenticating role must not. `AVCS_ACTOR ?? "human:cli"` was the exact shape that
  // cut the resolution chain, so pin its absence rather than a general "no literal" rule.
  assert.doesNotMatch(
    cli,
    /AVCS_ACTOR \?\? "human:cli"/,
    "no authenticating path may fall back to the literal (issue #95)",
  );
});

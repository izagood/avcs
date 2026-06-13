// Observability hardening: governance/security events emit structured JSON log entries
// through the Repo/hub logger so an operator can audit finalize, redact, gc and hub
// traffic. A buffer sink captures entries; a silent logger is the default (no noise).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { startHub } from "../src/hub/hubServer.ts";
import { pushToHub } from "../src/hub/hubClient.ts";
import { Logger, silentLogger, consoleLogger, type LogEntry } from "../src/observe/logger.ts";
import { generateKeypair } from "../src/core/identity.ts";
import type { Actor } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

function bufferLogger(level: "debug" | "info" | "warn" | "error" = "debug"): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { logger: new Logger({ level, sink: (e) => entries.push(e) }), entries };
}

test("Logger respects level, base fields, and child scoping", () => {
  const entries: LogEntry[] = [];
  const log = new Logger({ level: "info", sink: (e) => entries.push(e), base: { repo: "r1" } });
  log.debug("skipped"); // below min level → dropped
  log.info("hello", { n: 1 });
  log.child({ view: "main" }).warn("scoped");
  assert.equal(entries.length, 2, "debug dropped, info+warn kept");
  const [first, second] = entries as [LogEntry, LogEntry];
  assert.deepEqual(
    { event: first.event, repo: first.repo, n: first.n },
    { event: "hello", repo: "r1", n: 1 },
  );
  assert.equal(second.view, "main", "child fields merged");
  assert.equal(second.repo, "r1", "base fields inherited by child");
  assert.match(first.ts, /^\d{4}-\d{2}-\d{2}T/, "ISO timestamp stamped");
  // silent/console constructors don't throw and produce a usable Logger
  assert.ok(silentLogger() instanceof Logger);
  assert.ok(consoleLogger("warn") instanceof Logger);
});

test("Repo emits structured finalize / redact / gc events; default is silent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-log-"));
  try {
    const repo = await Repo.init(dir);
    // default logger is silent — no throw, no capture
    assert.ok(repo.logger instanceof Logger);

    const root = generateKeypair();
    const admin = generateKeypair();
    await repo.registerMembership({ actorId: "human:admin", publicKey: admin.publicKey, role: "admin", root: { keyId: "root", privateKey: root.privateKey } });
    await repo.registerMembership({ actorId: "ai:a", publicKey: generateKeypair().publicKey, role: "proposer", root: { keyId: "root", privateKey: root.privateKey } });

    // now attach a buffer sink and exercise the audited paths
    const { logger, entries } = bufferLogger();
    repo.logger = logger;

    const intent = await repo.createIntent({ title: "t", owner: "human:admin" });
    const sess = await repo.startSession({ intentOid: intent, actor: ai });
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "secret.env", content: "AWS_KEY=AKIA_leaked\n", declaredPurpose: "oops" });

    // finalize rejected: ai:a lacks maintainer role under default protection
    const mat = await repo.materialize();
    const cp = await repo.createCheckpoint("main", "cp");
    await repo.setProtection({
      view: "main",
      requiredApprovals: 0,
      requireOwnerApproval: false,
      requiredChecks: [],
      finalizeRole: "maintainer",
      requireSignedOps: false,
      requireUpToDate: false,
      allowForcePush: false,
    });
    const rejected = await repo.finalize({ view: "main", newCheckpoint: cp, parentHead: await repo.protectedHead("main"), by: "ai:a" });
    assert.equal(rejected.finalized, false);

    // finalize accepted by admin
    const accepted = await repo.finalize({ view: "main", newCheckpoint: cp, parentHead: await repo.protectedHead("main"), by: "human:admin" });
    assert.equal(accepted.finalized, true);

    // redact the secret blob (admin)
    const blobOid = mat.tree.get("secret.env")!;
    await repo.redact(blobOid, "leaked AWS key", "human:admin", { keyId: "human:admin", privateKey: admin.privateKey });

    // gc (dry run is fine for the log assertion)
    await repo.gc({ dryRun: true });

    const events = entries.map((e) => e.event);
    assert.ok(events.includes("finalize.rejected"), `expected finalize.rejected in ${events.join(",")}`);
    assert.ok(events.includes("finalize.accepted"), `expected finalize.accepted in ${events.join(",")}`);
    assert.ok(events.includes("redact.applied"), `expected redact.applied in ${events.join(",")}`);
    assert.ok(events.includes("gc"), `expected gc in ${events.join(",")}`);

    const rej = entries.find((e) => e.event === "finalize.rejected")!;
    assert.equal(rej.level, "warn");
    assert.equal(rej.by, "ai:a");
    assert.equal(typeof rej.reason, "string");

    const red = entries.find((e) => e.event === "redact.applied")!;
    assert.equal(red.level, "warn");
    assert.equal(red.blobOid, blobOid);
    assert.equal(red.by, "human:admin");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hub logs each request with method, path, status and latency", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-hublog-"));
  const devDir = await mkdtemp(join(tmpdir(), "avcs-hubdev-"));
  const { logger, entries } = bufferLogger("info");
  const hub = await startHub({ repoDir: dir, port: 0, logger });
  try {
    const dev = await Repo.init(devDir);
    const intent = await dev.createIntent({ title: "t", owner: "human:admin" });
    const sess = await dev.startSession({ intentOid: intent, actor: ai });
    await dev.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "a.txt", content: "hi\n", declaredPurpose: "x" });
    await pushToHub(devDir, hub.url); // GET /have + POST /objects ...

    const reqs = entries.filter((e) => e.event === "hub.request");
    assert.ok(reqs.length >= 2, `expected several hub.request entries, got ${reqs.length}`);
    const haveReq = reqs.find((e) => e.path === "/have" && e.method === "GET")!;
    assert.equal(haveReq.status, 200);
    assert.equal(typeof haveReq.ms, "number");
    const postReq = reqs.find((e) => e.path === "/objects" && e.method === "POST")!;
    assert.equal(postReq.status, 200);
  } finally {
    await hub.close();
    await rm(dir, { recursive: true, force: true });
    await rm(devDir, { recursive: true, force: true });
  }
});

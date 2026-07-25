// Phase 16 M1.1 (docs/18 §1.1) — the MCP response layer.
//
// Two jobs, both about tokens. Serialization is COMPACT by default (indentation is
// whitespace an agent pays for on every single call) with `verbose` restoring
// pretty-print for human debugging. And every failure is translated into a machine
// -readable envelope carrying `nextActions`, so an agent recovers by following a list
// instead of parsing prose and flailing.
//
// Success shapes are NOT wrapped (docs/18 §2 principle 1): existing consumers and tests
// parse the raw shape, so only additive fields are allowed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { serializeResult, errorEnvelope, RECOVERY } from "../src/mcp/respond.ts";
import { TOOLS } from "../src/mcp/server.ts";

test("serialization is compact by default: no indentation an agent has to pay for", () => {
  const text = serializeResult({ oid: "abc", nested: { a: 1, b: [2, 3] } });
  assert.equal(text, '{"oid":"abc","nested":{"a":1,"b":[2,3]}}');
  assert.ok(!text.includes("\n"), "compact output is a single line");
});

test("verbose restores pretty-print for human debugging", () => {
  const text = serializeResult({ oid: "abc" }, { verbose: true });
  assert.equal(text, '{\n  "oid": "abc"\n}');
});

test("a success shape is never wrapped in an envelope — only the raw value is serialized", () => {
  // A bare string result must not become {"result":"..."} etc.
  assert.equal(serializeResult("plain"), '"plain"');
  assert.equal(serializeResult(["a", "b"]), '["a","b"]');
});

test("an unrecognized failure still produces a structured envelope with the message", () => {
  const env = errorEnvelope(new Error("something nobody mapped"));
  assert.equal(env.error, "something nobody mapped");
  assert.equal(env.nextActions, undefined, "no invented recovery for an unknown class");
});

test("a stale head translates to land — the agent never parses 'head moved'", () => {
  // Now that M2 ships avcs.sync.land, it is the one-call recovery: it re-pushes,
  // re-checks the merge, re-checkpoints and re-integrates on its own.
  const env = errorEnvelope(new Error("head moved: abc -> def, pull first"));
  assert.ok(
    env.nextActions?.some((a) => a.includes("avcs.sync.land")),
    `got ${JSON.stringify(env.nextActions)}`,
  );
});

test("every CLI command named by a recovery hint actually exists", async () => {
  // The tool-name guard below deliberately skipped space-separated CLI invocations, and
  // that exemption is exactly where a hint rotted: `avcs key provision` was suggested for
  // a missing signing key and has never been a command. A nextAction is followed, not
  // skimmed, so naming a command that does not exist guarantees the agent fails.
  const cli = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
  const commands = new Set([...cli.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]!));
  assert.ok(commands.size > 10, "parsed the CLI command table");

  const referenced = RECOVERY.flatMap((r) => r.nextActions)
    .map((a) => /^avcs\s+([a-z-]+)/.exec(a)?.[1])
    .filter((c): c is string => !!c);
  assert.ok(referenced.length > 0, "the table names at least one CLI command");
  for (const c of referenced) {
    assert.ok(commands.has(c), `recovery hint names nonexistent CLI command \`avcs ${c}\``);
  }
});

test("every tool named by a recovery hint is actually registered — hints cannot drift", () => {
  // A nextAction that points at a tool which does not exist is worse than prose: the agent
  // follows it and fails. This pins the whole RECOVERY table against the live tool list.
  const registered = new Set(TOOLS.map((t) => t.name));
  const referenced = RECOVERY.flatMap((r) => r.nextActions)
    .flatMap((a) => a.match(/avcs\.[a-z]+(?:\.[a-z]+)*/g) ?? [])
    // CLI invocations (`avcs key provision`) are space-separated, not dotted tool names.
    .filter((n) => n.includes("."));
  assert.ok(referenced.length > 0, "the table names at least one tool");
  for (const name of referenced) {
    assert.ok(registered.has(name), `recovery hint names unregistered tool ${name}`);
  }
});

test("a missing signing key explains provisioning in the hint, since no command does it", () => {
  // There is deliberately no `avcs key …` nextAction: that command does not exist, and a
  // hint the agent can read beats an instruction it would follow into a failure.
  const env = errorEnvelope(new Error("no local signing key for ai:claude"));
  assert.match(String(env.hint), /provisionOwnerKey/);
});

test("being outside a repo points at cwd and init, the two things that actually fix it", () => {
  const env = errorEnvelope(new Error("AVCS_REPO=/x is not an AVCS repo (no .avcs/ at or above it)"));
  const actions = (env.nextActions ?? []).join(" ");
  assert.match(actions, /cwd/i);
  assert.match(actions, /init/i);
});

test("the envelope is JSON-serializable as-is (it is what the transport sends)", () => {
  const env = errorEnvelope(new Error("head moved: a -> b"));
  const round = JSON.parse(JSON.stringify(env)) as { error: string; nextActions?: string[] };
  assert.equal(round.error, "head moved: a -> b");
  assert.ok(Array.isArray(round.nextActions));
});

test("a non-Error throw still yields an envelope rather than crashing the call", () => {
  const env = errorEnvelope("bare string throw");
  assert.equal(env.error, "bare string throw");
});

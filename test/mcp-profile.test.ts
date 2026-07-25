// Phase 16 M5 (docs/18 §M5) — the `core` profile.
//
// A tool schema is a toll every agent pays every session. 36 tools is the right surface for
// a client that needs all of it; for the canonical loop it is mostly noise. The `core`
// profile advertises the 13 tools that loop actually uses.
//
// Compatibility rule: the DEFAULT is still everything. A profile is opt-in, because
// silently hiding tools from an existing client would break it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, CORE_PROFILE, toolsForProfile } from "../src/mcp/server.ts";

test("the default profile advertises every tool — hiding tools is opt-in", () => {
  assert.equal(toolsForProfile(undefined).length, TOOLS.length);
  assert.equal(toolsForProfile("full").length, TOOLS.length);
  assert.equal(toolsForProfile("nonsense").length, TOOLS.length, "an unknown profile degrades to full, never to empty");
});

test("the core profile is a real reduction, not a rename of the full set", () => {
  const core = toolsForProfile("core");
  assert.equal(core.length, CORE_PROFILE.length);
  assert.ok(core.length < TOOLS.length / 2, `core is ${core.length} of ${TOOLS.length}`);
});

test("every tool named in the core profile actually exists — the profile cannot drift", () => {
  const registered = new Set(TOOLS.map((t) => t.name));
  for (const name of CORE_PROFILE) assert.ok(registered.has(name), `core names unregistered tool ${name}`);
});

test("the core profile carries the whole canonical loop — an agent can finish its work", async () => {
  const { buildGuide } = await import("../src/mcp/guide.ts");
  const loop = (buildGuide(TOOLS) as { loop: { tool: string }[] }).loop;
  const core = new Set(CORE_PROFILE);
  for (const step of loop) {
    assert.ok(core.has(step.tool), `loop step ${step.tool} is missing from the core profile`);
  }
});

test("core keeps the guide, so an agent given the small surface can still learn the rest", () => {
  assert.ok(CORE_PROFILE.includes("avcs.guide"));
});

test("core drops the surfaces sync.land absorbs", () => {
  // land does push + checkpoint + integrate internally; carrying them separately in the
  // small profile would re-teach the very dance M2 removed.
  for (const absorbed of ["avcs.checkpoint.create", "avcs.sync.push", "avcs.integration.submit"]) {
    assert.ok(!CORE_PROFILE.includes(absorbed), `${absorbed} should not be in core`);
  }
});

test("the core profile is meaningfully cheaper in schema tokens", () => {
  const words = (list: { description: string }[]) => list.reduce((s, t) => s + t.description.split(/\s+/).length, 0);
  const full = words(TOOLS);
  const core = words(toolsForProfile("core"));
  assert.ok(core < full * 0.6, `core ${core} words vs full ${full}`);
});

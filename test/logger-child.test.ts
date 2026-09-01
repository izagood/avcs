import { test } from "node:test";
import assert from "node:assert/strict";
import { Logger, type LogEntry } from "../src/observe/logger.ts";

/** A logger whose entries are collected, at a given threshold. */
function collecting(level: Parameters<Logger["log"]>[0]) {
  const seen: LogEntry[] = [];
  return { seen, logger: new Logger({ level, sink: (e) => seen.push(e) }) };
}

test("a child logger keeps its parent's level", () => {
  // `child` is for adding request/actor context, not for changing how much is logged.
  // It used to construct the child without `level`, so the child fell back to the "info"
  // default: a child of a warn-level logger logged MORE than its parent, and a child of a
  // debug-level one logged less. Either way the threshold the caller set stopped applying
  // the moment context was attached.
  const { seen, logger } = collecting("warn");
  const child = logger.child({ requestId: "r1" });

  child.info("below.threshold");
  child.warn("at.threshold");

  assert.deepEqual(
    seen.map((e) => e.event),
    ["at.threshold"],
    "the child must apply the parent's warn threshold",
  );
  assert.equal(seen[0]!.requestId, "r1", "and still carry the context it was given");
});

test("a child of a debug logger still logs debug", () => {
  const { seen, logger } = collecting("debug");
  logger.child({ actor: "a" }).debug("verbose");
  assert.deepEqual(seen.map((e) => e.event), ["verbose"]);
});

test("child context nests, innermost last", () => {
  const { seen, logger } = collecting("info");
  logger.child({ a: 1, shared: "outer" }).child({ b: 2, shared: "inner" }).info("e");
  assert.equal(seen[0]!.a, 1);
  assert.equal(seen[0]!.b, 2);
  assert.equal(seen[0]!.shared, "inner");
});

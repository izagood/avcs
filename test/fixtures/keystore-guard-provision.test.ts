// A test file that provisions a key WITHOUT the isolation harness — exactly the shape that
// wrote fixtures into a developer's real `~/.avcs/private/` (issue #107).
//
// It lives under `test/fixtures/` so the suite's own `test/*.test.ts` glob never picks it up;
// `keystore-test-guard.test.ts` runs it deliberately, in a child process, and asserts that it
// FAILS and that the real keystore is unchanged.
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../../src/api/repo.ts";

test("provisions a key with no AVCS_CONFIG_HOME set", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-107-probe-"));
  try {
    const repo = await Repo.init(dir);
    await repo.provisionOwnerKey({ kind: "human", id: "human:should-never-land" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

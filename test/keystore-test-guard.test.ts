// The machine keystore must be unreachable from a test that did not opt into isolation
// (issue #107).
//
// `keystore.ts` already states the requirement — the config home resolves at call time so
// that "a test, which must never touch the developer's real credential store, can repoint it
// per process" — and `test/_isolate-keystore.ts` implements it well. But the guarantee lived
// entirely in the `npm test` script: run one file the ordinary way,
//
//     node --experimental-strip-types --test test/key-surface.test.ts
//
// and the harness is simply absent. Every `provisionOwnerKey` in that file then wrote into
// the developer's real `~/.avcs/private/`.
//
// That happened. Five fixtures (`ai:claude`, `alice`, `human:h`, `human:other`,
// `human:owner`) ended up in a real keystore, and the consequences were worse than untidy:
// the suite poisoned itself (assertions on an exact signable list started failing, which was
// reported as "6 failures on merged main" and did not reproduce under `npm test`), and the
// extra identities made `localActorId`'s sole-key fallback ambiguous, so `avcs submit`
// stopped resolving an actor at all.
//
// So the guard belongs in the module that states the rule, not in the script that happens to
// run it: under `node --test` with no `AVCS_CONFIG_HOME`, resolving the config home throws.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { configHome, machineKeystoreDir } from "../src/api/keystore.ts";

const run = promisify(execFile);
const FIXTURE = fileURLToPath(new URL("./fixtures/keystore-guard-probe.ts", import.meta.url));

/** Restore whatever the harness set, so these tests do not disturb their neighbours. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("under the test runner with no AVCS_CONFIG_HOME, resolving the config home throws", () => {
  // This process IS the test runner, so NODE_TEST_CONTEXT is already set — dropping the
  // isolation variable is enough to reproduce a bare `node --test <file>`.
  withEnv({ AVCS_CONFIG_HOME: undefined, XDG_CONFIG_HOME: undefined }, () => {
    assert.throws(
      () => configHome(),
      (e: Error) => {
        // The message has to name the fix, not just the fact — the failure it replaces was
        // silent, and a user hitting this is mid-way through running one file.
        assert.match(e.message, /AVCS_CONFIG_HOME/, "names the variable");
        assert.match(e.message, /_isolate-keystore|npm test/, "names the supported way to run tests");
        assert.doesNotMatch(e.message, new RegExp(homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
          "must not print the developer's home path as if it were a suggestion");
        return true;
      },
    );
  });
  // The derived path must refuse too — that is what every caller actually uses.
  withEnv({ AVCS_CONFIG_HOME: undefined, XDG_CONFIG_HOME: undefined }, () => {
    assert.throws(() => machineKeystoreDir(), /AVCS_CONFIG_HOME/);
  });
});

test("an isolated test resolves normally — the harness keeps working", async () => {
  const home = await mkdtemp(join(tmpdir(), "avcs-107-"));
  try {
    withEnv({ AVCS_CONFIG_HOME: home }, () => {
      assert.equal(configHome(), home);
      assert.equal(machineKeystoreDir(), join(home, "private"));
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// XDG is a deliberate opt-in, so a test that sets it has said where to write.
test("XDG_CONFIG_HOME also counts as opting in", async () => {
  const xdg = await mkdtemp(join(tmpdir(), "avcs-107-xdg-"));
  try {
    withEnv({ AVCS_CONFIG_HOME: undefined, XDG_CONFIG_HOME: xdg }, () => {
      assert.equal(configHome(), join(xdg, "avcs"));
    });
  } finally {
    await rm(xdg, { recursive: true, force: true });
  }
});

// avcs is a library. The runner that bit us hardest was not avcs' own — a downstream
// consumer's vitest suite provisioned 11 fixture keys into a real `~/.avcs`, and the
// resulting ambiguity made its client sign nothing (every POST /objects → 401).
test("vitest and jest count as the test runner too", () => {
  for (const [k, v] of [["VITEST", "true"], ["JEST_WORKER_ID", "1"]] as const) {
    withEnv(
      { AVCS_CONFIG_HOME: undefined, XDG_CONFIG_HOME: undefined, NODE_TEST_CONTEXT: undefined, [k]: v },
      () => assert.throws(() => configHome(), /AVCS_CONFIG_HOME/, `${k} must be recognised`),
    );
  }
});

// The guard must not touch ordinary use. A user running `avcs key ls` is not under the test
// runner, and `~/.avcs` is exactly where their key belongs.
test("outside the test runner the home default still applies", async () => {
  const { stdout } = await run(
    process.execPath,
    ["--experimental-strip-types", FIXTURE],
    { env: childEnv(), encoding: "utf8" },
  );
  assert.equal(stdout.trim(), join(homedir(), ".avcs"), "a normal process resolves ~/.avcs");
});

// The end-to-end property, and the one that actually protects the developer: a test file run
// WITHOUT the harness must fail rather than write into the real keystore.
test("a test file run without the harness fails instead of writing to the real keystore", async () => {
  const before = existsSync(machineKeystoreDirSafe()) ? (await readdir(machineKeystoreDirSafe())).sort() : null;

  const probe = fileURLToPath(new URL("./fixtures/keystore-guard-provision.test.ts", import.meta.url));
  let failed = false;
  let output = "";
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      ["--experimental-strip-types", "--test", probe],
      // NODE_TEST_CONTEXT must be cleared for the CHILD: inherited, Node treats the run as
      // nested and skips the file with "run() is being called recursively". The child's own
      // `--test` sets it fresh, which is what the guard reads.
      { env: childEnv(), encoding: "utf8" },
    );
    output = `${stdout}${stderr}`;
  } catch (e) {
    failed = true;
    const err = e as { stdout?: string; stderr?: string };
    output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }

  assert.ok(failed, `the bare run must fail:\n${output}`);
  assert.match(output, /AVCS_CONFIG_HOME/, "and say why");

  const after = existsSync(machineKeystoreDirSafe()) ? (await readdir(machineKeystoreDirSafe())).sort() : null;
  assert.deepEqual(after, before, "the real keystore is untouched");
});

/** A child env with every isolation signal removed, so the child reproduces a bare run. */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AVCS_CONFIG_HOME;
  delete env.XDG_CONFIG_HOME;
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/** The real machine keystore path, resolved outside the guard so this test can look at it. */
function machineKeystoreDirSafe(): string {
  return join(homedir(), ".avcs", "private");
}

// Keystore isolation for the test suite (issue #98). Loaded via `--import` for EVERY test
// process — see the `test` script in package.json.
//
// avcs' machine keystore defaults to `~/.avcs`, which on a developer's box is their REAL
// credential store: the keys they sign their own work with. Dozens of tests call
// `provisionOwnerKey`, and the repo→machine migration writes a copy on first use, so without
// this the suite would mint keys into — and adopt keys out of — that store.
//
// `--import` rather than a per-file helper because it cannot be forgotten: a test added later
// that provisions a key is isolated without its author having to know this exists. And the
// directory is fresh per TEST, not per file: several tests in one file provision the same
// actor id and assert on exact listings, so a keystore shared across a file would make them
// depend on each other's order. Child processes the CLI tests spawn inherit the variable.
//
// A test that wants tighter control sets AVCS_CONFIG_HOME itself; that value is restored,
// not clobbered.
import { beforeEach, afterEach } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "avcs-test-config-"));
  process.env.AVCS_CONFIG_HOME = home;
});

afterEach(async () => {
  delete process.env.AVCS_CONFIG_HOME;
  if (home) {
    // Never fail a test run over cleanup of a temp dir the OS would reap anyway.
    await rm(home, { recursive: true, force: true }).catch(() => {});
    home = undefined;
  }
});

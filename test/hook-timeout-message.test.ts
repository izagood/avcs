// Issue #156 — what a timed-out git-bridge hook tells the person standing in front of it.
//
// The deadline (#33) exists so a hook never strands `git`. It fires wherever the ingest had
// got to, which is usually *after* the capture: operations, blobs and the intent are already
// durable, and it is the checkpoint, the reprojection and the trailer that are missing. The
// old message said the opposite ("proceeding without audit capture") and then named a cause
// it could not have observed — a competing process holding the store — when the only lock on
// this path throws `lock timeout acquiring …`, which `withDeadline` propagates unchanged and
// so never reaches the timeout branch at all.
//
// The wording is asserted directly rather than by tripping a real deadline: which bound trips
// depends on how fast the machine is that moment, and choosing an assertion by stopwatch is
// the flake this repository has already paid for once (#55). One end-to-end test still covers
// the property that does not depend on which branch fired — the hook lets git through.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { storeOpenTimeoutMessage, preCommitTimeoutMessage } from "../src/git/hookTimeoutMessage.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();

const avcs = (cwd: string, ...a: string[]) =>
  spawnSync(process.execPath, ["--experimental-strip-types", CLI, ...a], { cwd, encoding: "utf8" });

test("the pre-commit timeout says what survived and how to finish the job", () => {
  const m = preCommitTimeoutMessage(30_000);

  assert.match(m, /exceeded 30000ms/, "names the bound that was exceeded");
  assert.match(m, /avcs git-sync -m/, "names the command that brings the store level");
  assert.match(m, /checkpoint/, "names what is missing");
  assert.match(m, /AVCS_HOOK_TIMEOUT_MS=0/, "keeps the escape hatch");

  // The two claims a timeout is not entitled to make.
  assert.doesNotMatch(m, /without audit capture/, "the capture has usually already completed");
  assert.doesNotMatch(m, /holding the store/, "no lock was observed, and none could have been");
});

test("the store-open timeout claims nothing beyond what it knows", () => {
  const m = storeOpenTimeoutMessage("pre-commit", 30_000);

  assert.match(m, /exceeded 30000ms/);
  assert.match(m, /pre-commit/, "names the phase it skipped");
  assert.match(m, /Nothing was read or written/, "this branch really did do nothing");
  assert.doesNotMatch(m, /holding the store/, "opening the store takes no lock");
});

test("a missing phase name is reported as missing, not as `undefined`", () => {
  assert.doesNotMatch(storeOpenTimeoutMessage(undefined, 1), /undefined/);
});

test("a timed-out hook still lets git make the commit", { skip: !hasGit }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-hooktimeout-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: dir });
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "dev");
  git("config", "commit.gpgsign", "false");
  assert.equal(avcs(dir, "init", ".").status, 0);
  await writeFile(join(dir, "a.txt"), "a\n", "utf8");
  git("add", "-A");
  git("commit", "-qm", "initial");

  await writeFile(join(dir, "a.txt"), "a\nb\n", "utf8");
  git("add", "a.txt");

  // 1 ms: some bound is certain to trip. Which one is not the point here.
  const res = spawnSync("git", ["commit", "-qm", "edit"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, AVCS_HOOK_TIMEOUT_MS: "1" },
  });
  const said = `${res.stdout}${res.stderr}`;

  assert.equal(res.status, 0, `the hook must fail OPEN, never block git\n${said}`);
  assert.equal(git("log", "-1", "--format=%s"), "edit", "the commit is made");
  assert.match(said, /exceeded 1ms/, "and the reason is on screen");
  assert.doesNotMatch(said, /holding the store/, "whichever branch fired, it invents no cause");
});

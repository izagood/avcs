// The machine-level private keystore (issue #98).
//
// An actor identity belongs to a person and a machine, not to a checkout — the way
// ~/.ssh, ~/.gnupg and ~/.config/gh each hold one credential that every repository on the
// box uses. avcs stored private keys per repository, which is what created the clone
// bootstrap problem in #58: `clone` is the command that creates the repo it would have to
// read the credential from. A machine-level keystore removes that boundary instead of
// carrying a credential across it.
//
// TEST ISOLATION: these tests must never read or write the developer's real credential
// store. Every test runs inside `withKeystore`, which repoints AVCS_CONFIG_HOME at a temp
// directory and restores the previous value afterwards. `the real config home is never
// touched` proves the isolation rather than assuming it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Repo } from "../src/api/repo.ts";
import { configHome, machineKeystoreDir, machineKeyPath } from "../src/api/keystore.ts";

/** Run `fn` with the machine keystore pointed at a fresh temp dir. */
async function withKeystore<T>(fn: (ks: string) => Promise<T>): Promise<T> {
  const prev = process.env.AVCS_CONFIG_HOME;
  const home = await mkdtemp(join(tmpdir(), "avcs-ks-home-"));
  process.env.AVCS_CONFIG_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.AVCS_CONFIG_HOME;
    else process.env.AVCS_CONFIG_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
}

async function tmpRepo(): Promise<{ dir: string; repo: Repo }> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-ks-repo-"));
  return { dir, repo: await Repo.init(dir) };
}

test("the keystore path is $AVCS_CONFIG_HOME, else $XDG_CONFIG_HOME/avcs, else ~/.avcs", () => {
  const saved = { a: process.env.AVCS_CONFIG_HOME, x: process.env.XDG_CONFIG_HOME };
  try {
    process.env.AVCS_CONFIG_HOME = "/tmp/explicit";
    process.env.XDG_CONFIG_HOME = "/tmp/xdg";
    assert.equal(configHome(), "/tmp/explicit", "the explicit override wins");

    delete process.env.AVCS_CONFIG_HOME;
    assert.equal(configHome(), join("/tmp/xdg", "avcs"), "XDG comes next");

    // Under the test runner with neither variable set, resolution now REFUSES rather than
    // falling back to the developer's real keystore (issue #107). The `~/.avcs` default is
    // still the contract for ordinary processes — `keystore-test-guard.test.ts` asserts it
    // from a real child process, which is a truer check than asserting it from in here.
    delete process.env.XDG_CONFIG_HOME;
    assert.throws(() => configHome(), /AVCS_CONFIG_HOME/, "a bare test run must not reach ~/.avcs");

    process.env.AVCS_CONFIG_HOME = "/tmp/explicit";
    assert.equal(machineKeystoreDir(), join("/tmp/explicit", "private"));
    assert.equal(machineKeyPath("human:h"), join("/tmp/explicit", "private", "human:h.json"));
  } finally {
    if (saved.a === undefined) delete process.env.AVCS_CONFIG_HOME; else process.env.AVCS_CONFIG_HOME = saved.a;
    if (saved.x === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved.x;
  }
});

test("key provision writes to the machine keystore, 0600 in a 0700 directory", async () => {
  await withKeystore(async (home) => {
    const { dir, repo } = await tmpRepo();
    try {
      await repo.provisionOwnerKey({ kind: "human", id: "human:h" });
      const keyFile = machineKeyPath("human:h");
      assert.ok(existsSync(keyFile), `the key lives at ${keyFile}`);
      // This is credential storage: the modes are part of the contract, not a detail.
      assert.equal((await stat(keyFile)).mode & 0o777, 0o600, "key file is 0600");
      assert.equal((await stat(machineKeystoreDir())).mode & 0o777, 0o700, "keystore dir is 0700");
      assert.equal((await stat(home)).mode & 0o777, 0o700, "config home is 0700");
      // and NOT into the checkout
      assert.equal(existsSync(join(dir, ".avcs", "private", "human:h.json")), false, "not in the repo");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("a freshly init'd repo can sign immediately on a machine that holds a key", async () => {
  // The headline of #98: `avcs init` is not a command that should require key setup.
  await withKeystore(async () => {
    const a = await tmpRepo();
    const b = await tmpRepo();
    try {
      await a.repo.provisionOwnerKey({ kind: "human", id: "human:h" });
      assert.deepEqual(await b.repo.listLocalKeys(), ["human:h"], "signable is not 0 in a brand new repo");
      assert.ok(await b.repo.loadLocalKey("human:h"), "and the key actually loads");
      assert.equal(await b.repo.localActorId(), "human:h", "so the sole-key default identity resolves too");
    } finally {
      for (const d of [a.dir, b.dir]) await rm(d, { recursive: true, force: true });
    }
  });
});

test("a repo-local key beats the machine key for the same actor", async () => {
  // The deliberate case #98 keeps working: a CI checkout, or a second identity, that must
  // sign as someone other than the machine default.
  await withKeystore(async () => {
    const { dir, repo } = await tmpRepo();
    try {
      await repo.saveLocalKey("human:h", "MACHINE-KEY", { scope: "machine" });
      await repo.saveLocalKey("human:h", "REPO-KEY", { scope: "repo" });
      assert.equal(await repo.loadLocalKey("human:h"), "REPO-KEY", "repo → machine, first hit wins");
      const sources = await repo.listLocalKeySources();
      assert.deepEqual(
        sources,
        [{ actorId: "human:h", source: "repo", shadowed: true }],
        "the listing reports the winner AND that it is hiding a machine key",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("listLocalKeys merges both sources and key ls says which is which", async () => {
  await withKeystore(async () => {
    const { dir, repo } = await tmpRepo();
    try {
      await repo.saveLocalKey("human:h", "M", { scope: "machine" });
      await repo.saveLocalKey("ci:bot", "R", { scope: "repo" });
      assert.deepEqual(await repo.listLocalKeys(), ["ci:bot", "human:h"]);
      assert.deepEqual(await repo.listLocalKeySources(), [
        { actorId: "ci:bot", source: "repo" },
        { actorId: "human:h", source: "machine" },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("a repo that has only a repo-local key keeps working, and its key is adopted once", async () => {
  await withKeystore(async () => {
    const { dir, repo } = await tmpRepo();
    try {
      // Exactly what a 0.35.0 repo looks like on disk.
      await repo.saveLocalKey("human:h", "LEGACY", { scope: "repo" });
      assert.equal(existsSync(machineKeyPath("human:h")), false);

      assert.equal(await repo.loadLocalKey("human:h"), "LEGACY", "it still signs");
      assert.equal(await readFile(machineKeyPath("human:h"), "utf8").then((s) => JSON.parse(s).privateKey), "LEGACY", "and is now held machine-wide");
      assert.equal(repo.keystoreNotices.length, 1, "the user is told it happened");
      assert.match(repo.keystoreNotices[0]!, /human:h/);
      assert.match(repo.keystoreNotices[0]!, /adopted/i);
      assert.equal((await stat(machineKeyPath("human:h"))).mode & 0o777, 0o600, "adopted with credential modes");

      await repo.loadLocalKey("human:h");
      assert.equal(repo.keystoreNotices.length, 1, "adoption happens once, not on every read");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("adoption never clobbers a different machine key for the same actor id", async () => {
  // Overwriting would destroy a credential whose signatures already exist in history and
  // cannot be re-made. Erroring would break a repo that works today. So: keep both, let
  // repo-local precedence keep the repo signing exactly as before, and say so.
  await withKeystore(async () => {
    const { dir, repo } = await tmpRepo();
    try {
      await repo.saveLocalKey("human:h", "MACHINE-ORIGINAL", { scope: "machine" });
      await repo.saveLocalKey("human:h", "REPO-DIFFERENT", { scope: "repo" });

      assert.equal(await repo.loadLocalKey("human:h"), "REPO-DIFFERENT", "the repo is unaffected");
      assert.equal(
        JSON.parse(await readFile(machineKeyPath("human:h"), "utf8")).privateKey,
        "MACHINE-ORIGINAL",
        "the machine credential is intact",
      );
      assert.equal(repo.keystoreNotices.length, 1);
      assert.match(repo.keystoreNotices[0]!, /differ/i);
      assert.equal(repo.keystoreNotices[0]!.includes("MACHINE-ORIGINAL"), false, "no key material in the notice");
      assert.equal(repo.keystoreNotices[0]!.includes("REPO-DIFFERENT"), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("AVCS_KEYSTORE_ADOPT=0 turns the migration off", async () => {
  await withKeystore(async () => {
    const { dir, repo } = await tmpRepo();
    const prev = process.env.AVCS_KEYSTORE_ADOPT;
    process.env.AVCS_KEYSTORE_ADOPT = "0";
    try {
      await repo.saveLocalKey("human:h", "LEGACY", { scope: "repo" });
      assert.equal(await repo.loadLocalKey("human:h"), "LEGACY");
      assert.equal(existsSync(machineKeyPath("human:h")), false, "nothing was copied out of the checkout");
      assert.deepEqual(repo.keystoreNotices, []);
    } finally {
      if (prev === undefined) delete process.env.AVCS_KEYSTORE_ADOPT; else process.env.AVCS_KEYSTORE_ADOPT = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("an actor id that would escape the keystore directory is refused", async () => {
  // The keystore is machine-global now, so a path-traversing actor id would write outside
  // the user's config home rather than merely outside a checkout.
  await withKeystore(async () => {
    const { dir, repo } = await tmpRepo();
    try {
      for (const bad of ["../evil", "a/b", "..", "."]) {
        await assert.rejects(() => repo.saveLocalKey(bad, "K"), /actor id/i, `refused: ${bad}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("the real config home is never touched by these tests", async () => {
  // The isolation guarantee, asserted rather than assumed: snapshot the developer's actual
  // keystore, run the full provision path under the override, and compare.
  // The real path is computed directly, not via `configHome()`: since #107 that function
  // refuses to resolve the home default under the test runner, which is exactly the
  // protection this test exists to verify. Asking for the path is not the same as being
  // allowed to use it.
  const real = join(homedir(), ".avcs");
  const before = existsSync(real) ? (await readdir(real)).sort() : null;

  await withKeystore(async () => {
    const { dir, repo } = await tmpRepo();
    try {
      await repo.provisionOwnerKey({ kind: "human", id: "human:h" });
      await repo.listLocalKeySources();
      await repo.loadLocalKey("human:h");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  const saved = process.env.AVCS_CONFIG_HOME;
  delete process.env.AVCS_CONFIG_HOME;
  const after = existsSync(real) ? (await readdir(real)).sort() : null;
  if (saved !== undefined) process.env.AVCS_CONFIG_HOME = saved;
  assert.deepEqual(after, before, `${real} must be untouched`);
});

test("a key file dropped into the machine keystore by hand is picked up", async () => {
  // "Copy your key onto the new machine" has to be a real procedure, not a code path.
  await withKeystore(async () => {
    const { dir, repo } = await tmpRepo();
    try {
      await mkdir(machineKeystoreDir(), { recursive: true });
      await writeFile(machineKeyPath("human:h"), JSON.stringify({ actorId: "human:h", privateKey: "HANDED-OVER" }), "utf8");
      assert.equal(await repo.loadLocalKey("human:h"), "HANDED-OVER");
      assert.deepEqual(await repo.listLocalKeys(), ["human:h"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("`avcs key ls` names which keystore each key came from", async () => {
  // The CLI line "signable on this machine" is what #98 made true. With two sources it also
  // has to stay honest: a repo-local override shadowing the machine identity is exactly the
  // thing a user needs to be able to see.
  await withKeystore(async () => {
    const { dir, repo } = await tmpRepo();
    try {
      await repo.saveLocalKey("human:h", "M", { scope: "machine" });
      await repo.saveLocalKey("ci:bot", "R", { scope: "repo" });
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ["--experimental-strip-types", join(import.meta.dirname, "..", "src", "cli.ts"), "key", "ls"],
        { encoding: "utf8", cwd: dir, env: { ...process.env, AVCS_CONFIG_HOME: configHome() } },
      );
      assert.match(stdout, /signable on this machine \(2\)/);
      assert.match(stdout, /human:h {2}\(machine keystore\)/);
      assert.match(stdout, /ci:bot {2}\(this repo only — not in the machine keystore\)/);
      assert.match(stdout, new RegExp(`keystore: ${machineKeystoreDir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.equal(stdout.includes("PRIVATE KEY"), false, "no key material in the listing");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("`avcs key provision` names the machine keystore it wrote to", async () => {
  await withKeystore(async () => {
    const { dir } = await tmpRepo();
    try {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ["--experimental-strip-types", join(import.meta.dirname, "..", "src", "cli.ts"), "key", "provision", "human:h"],
        { encoding: "utf8", cwd: dir, env: { ...process.env, AVCS_CONFIG_HOME: configHome() } },
      );
      assert.match(stdout, /machine keystore/);
      assert.match(stdout, /every repo on this machine can now sign as human:h/);
      assert.equal(stdout.includes("PRIVATE KEY"), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("`avcs key import` puts an identity on a new machine, and says so", async () => {
  // The normal way to bootstrap a second box: `clone --key` is the per-repo escape hatch.
  await withKeystore(async () => {
    const a = await tmpRepo();
    const b = await tmpRepo();
    try {
      await a.repo.provisionOwnerKey({ kind: "human", id: "human:h" });
      const keyFile = machineKeyPath("human:h");
      // Simulate a fresh machine: an empty keystore plus the file the operator carried over.
      const fresh = await mkdtemp(join(tmpdir(), "avcs-ks-fresh-"));
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ["--experimental-strip-types", join(import.meta.dirname, "..", "src", "cli.ts"), "key", "import", keyFile],
        { encoding: "utf8", cwd: b.dir, env: { ...process.env, AVCS_CONFIG_HOME: fresh } },
      );
      assert.match(stdout, /imported signing key for human:h into the machine keystore/);
      assert.equal(existsSync(join(fresh, "private", "human:h.json")), true);
      assert.equal(existsSync(join(b.dir, ".avcs", "private")), false, "machine scope, not the checkout");
      await rm(fresh, { recursive: true, force: true });
    } finally {
      for (const d of [a.dir, b.dir]) await rm(d, { recursive: true, force: true });
    }
  });
});

test("a keystore that cannot be written does not take away the repo's ability to sign", async () => {
  // Adoption happens on a READ path (`loadLocalKey`, which is what the hub signer and the
  // MCP decision signer call). A read-only home must not turn a migration into an outage.
  const prev = process.env.AVCS_CONFIG_HOME;
  const blocked = await mkdtemp(join(tmpdir(), "avcs-ks-blocked-"));
  // A FILE where the config home should be a directory: every mkdir under it fails.
  const asFile = join(blocked, "home");
  await writeFile(asFile, "not a directory", "utf8");
  process.env.AVCS_CONFIG_HOME = asFile;
  const { dir, repo } = await tmpRepo();
  try {
    await repo.saveLocalKey("human:h", "LEGACY", { scope: "repo" });
    assert.equal(await repo.loadLocalKey("human:h"), "LEGACY", "the repo still signs");
    assert.equal(await repo.localActorId(), "human:h");
    assert.equal(repo.keystoreNotices.length, 1);
    assert.match(repo.keystoreNotices[0]!, /could not adopt/i);
    assert.equal(repo.keystoreNotices[0]!.includes("LEGACY"), false, "no key material in the notice");
  } finally {
    if (prev === undefined) delete process.env.AVCS_CONFIG_HOME;
    else process.env.AVCS_CONFIG_HOME = prev;
    for (const d of [dir, blocked]) await rm(d, { recursive: true, force: true });
  }
});

test("`key ls` distinguishes a repo-only key from one shadowing the machine key", async () => {
  // After the migration adopts a key, the repo copy is no longer "the only copy" — it is an
  // override hiding a machine key. Saying "this repo only" then would be false, and the
  // whole point of #98 is that this listing stops lying about scope.
  await withKeystore(async () => {
    const { dir, repo } = await tmpRepo();
    try {
      await repo.saveLocalKey("human:only", "R", { scope: "repo" });
      await repo.saveLocalKey("human:both", "M", { scope: "machine" });
      await repo.saveLocalKey("human:both", "R2", { scope: "repo" });
      assert.deepEqual(await repo.listLocalKeySources(), [
        { actorId: "human:both", source: "repo", shadowed: true },
        { actorId: "human:only", source: "repo" },
      ]);
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ["--experimental-strip-types", join(import.meta.dirname, "..", "src", "cli.ts"), "key", "ls"],
        { encoding: "utf8", cwd: dir, env: { ...process.env, AVCS_CONFIG_HOME: configHome() } },
      );
      assert.match(stdout, /human:only {2}\(this repo only — not in the machine keystore\)/);
      assert.match(stdout, /human:both {2}\(this repo's override — shadows the machine key for this actor\)/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

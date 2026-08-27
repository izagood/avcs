// docs/20 — workspace-first git bridge: a topic branch is a CONVERGING workspace, not a
// permanently DIVERGING line, and a merge into trunk is what lands it. The matrix below is
// docs/20 §5 (W1–W15); W5 lives in test/workspace-landed-visibility.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LEGACY_TRUNK_BRANCHES, Repo } from "../src/api/repo.ts";
import { mergedBranchFromReflog, scopeForBranch } from "../src/git/scope.ts";
import type { Actor } from "../src/objects/types.ts";

const dev: Actor = { kind: "human", id: "human:dev" };
const mk = () => mkdtemp(join(tmpdir(), "avcs-wsb-"));

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
const avcs = (cwd: string, ...a: string[]) =>
  execFileSync(process.execPath, ["--experimental-strip-types", CLI, ...a], { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

/** A git repo with an AVCS store, hooks OFF (each test drives the bridge explicitly). */
async function gitRepo(branch = "main"): Promise<string> {
  const dir = await mk();
  git(dir, "init", "-b", branch);
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  const repo = await Repo.init(dir);
  await repo.setGitMode("sidecar");
  return dir;
}

const pathsOf = async (repo: Repo, opts?: { workspace?: string }) =>
  (await repo.materializedFiles(await repo.materialize("main", opts))).map((f) => f.path).sort();

// ── Task 2: trunk config ────────────────────────────────────────────────────
test("trunk config: defaults to main, persists, and shares config.json with gitMode", async () => {
  const dir = await mk();
  const repo = await Repo.init(dir);
  try {
    assert.equal(await repo.getTrunk(), "main", "unset ⇒ main (what the bridge assumed before trunk existed)");

    await repo.setGitMode("committed");
    await repo.setTrunk("dev");
    // Both live in .avcs/config.json; neither write may erase the other.
    assert.equal(await repo.getTrunk(), "dev");
    assert.equal(await repo.getGitMode(), "committed");
    await repo.setGitMode("sidecar");
    assert.equal(await repo.getTrunk(), "dev", "setGitMode preserved trunk");

    const reopened = await Repo.open(dir);
    assert.equal(await reopened.getTrunk(), "dev", "trunk survives a re-open");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("`avcs trunk` prints the trunk and sets it", { skip: !hasGit }, async () => {
  const dir = await gitRepo();
  try {
    assert.match(avcs(dir, "trunk"), /trunk: main/);
    avcs(dir, "trunk", "dev");
    assert.match(avcs(dir, "trunk"), /trunk: dev/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("`avcs init` records a trunk only when origin names one that is not main/master", { skip: !hasGit }, async () => {
  // A repo whose default branch is `dev`, as a clone would present it.
  const dir = await mk();
  const cfgOf = async (d: string) => JSON.parse(await readFile(join(d, ".avcs", "config.json"), "utf8")) as Record<string, unknown>;
  try {
    git(dir, "init", "-b", "dev");
    git(dir, "config", "user.email", "t@t");
    git(dir, "config", "user.name", "t");
    git(dir, "commit", "-q", "--allow-empty", "-m", "seed");
    // Stand in for a clone's origin: a remote-tracking ref plus origin/HEAD pointing at it.
    git(dir, "update-ref", "refs/remotes/origin/dev", "HEAD");
    git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/dev");
    const out = avcs(dir, "init", "--no-hooks");
    assert.match(out, /detected trunk: dev/);
    assert.equal((await cfgOf(dir)).trunk, "dev");

    // A main-default repo needs no field: unset already means {main, master} (W7).
    const plain = await mk();
    git(plain, "init", "-b", "main");
    git(plain, "config", "user.email", "t@t");
    git(plain, "config", "user.name", "t");
    avcs(plain, "init", "--no-hooks");
    assert.equal((await cfgOf(plain)).trunk, undefined, "nothing was written for a main-default repo");
    await rm(plain, { recursive: true, force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Task 3: scopeFor + capture wiring ───────────────────────────────────────
test("W7/W8/W9: scopeForBranch maps a branch to base / workspace / line", () => {
  const unset = LEGACY_TRUNK_BRANCHES;    // no `trunk` in config
  const devTrunk = ["dev"];               // `avcs trunk dev`

  // W7 — trunk unset ⇒ `main` AND `master` stay base, exactly as the old `lineFor` did.
  assert.deepEqual(scopeForBranch("main", unset), {}, "on trunk ⇒ base view, no scope tag");
  assert.deepEqual(scopeForBranch("master", unset), {}, "a master-default repo keeps working");
  // Detached HEAD / no git ⇒ base, same as the old mapping's "HEAD" case.
  assert.deepEqual(scopeForBranch("HEAD", unset), {});
  assert.deepEqual(scopeForBranch(null, unset), {});

  // An explicit --line is a human saying "diverge" — still honoured (docs/20 §2.4).
  assert.deepEqual(scopeForBranch("main", unset, { explicitLine: "v1.x" }), { line: "v1.x" });
  assert.deepEqual(scopeForBranch("topic-a", unset, { explicitLine: "v1.x" }), { line: "v1.x" });

  // W2 — any other branch is a converging workspace.
  assert.deepEqual(scopeForBranch("topic-a", unset), { workspace: "topic-a" });
  assert.deepEqual(scopeForBranch("feat/nested/name", unset), { workspace: "feat/nested/name" });

  // W8 — with trunk = dev, `dev` is base and `main` is just another topic branch.
  assert.deepEqual(scopeForBranch("dev", devTrunk), {});
  assert.deepEqual(scopeForBranch("main", devTrunk), { workspace: "main" });
  assert.deepEqual(scopeForBranch("master", devTrunk), { workspace: "master" }, "configured trunk is the single answer");

  // W9 — a branch that ALREADY has a `line:<name>` ref keeps being a line, so in-flight
  // pre-trunk work is not stranded by the remapping.
  assert.deepEqual(scopeForBranch("topic-a", unset, { hasExistingLine: true }), { line: "topic-a" });
  assert.deepEqual(scopeForBranch("topic-a", unset, { hasExistingLine: false }), { workspace: "topic-a" });
  // …including when that branch is the trunk. Before `trunk` existed, a trunk named anything
  // but main/master had itself become a line and its work lives there; sending new captures to
  // the default view would split that history in two.
  assert.deepEqual(scopeForBranch("dev", devTrunk, { hasExistingLine: true }), { line: "dev" });
  assert.deepEqual(scopeForBranch("dev", devTrunk, { hasExistingLine: false }), {});
});

test("W1/W2: trunk capture is untagged and instantly visible; a topic capture is workspace-tagged and is not", { skip: !hasGit }, async () => {
  const dir = await gitRepo();
  try {
    // W1 — on trunk.
    await writeFile(join(dir, "a.txt"), "trunk\n", "utf8");
    avcs(dir, "git-sync", "-m", "base", "--no-add");
    const repo = await Repo.open(dir);
    assert.deepEqual(await pathsOf(repo), ["a.txt"], "trunk capture lands in the base view at once");

    // W2 — on a topic branch.
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    git(dir, "checkout", "-q", "-b", "topic-b");
    await writeFile(join(dir, "b.txt"), "topic\n", "utf8");
    avcs(dir, "git-sync", "-m", "topic work", "--no-add");

    const after = await Repo.open(dir);
    assert.deepEqual(await pathsOf(after), ["a.txt"], "base view does NOT see the topic branch's work");
    assert.deepEqual(await pathsOf(after, { workspace: "topic-b" }), ["a.txt", "b.txt"], "the workspace view does");
    // And it is a workspace, not a line: no `line:topic-b` was minted.
    assert.deepEqual((await after.listLines()).map((l) => l.name), [], "no line was created for a topic branch");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("W3: two topic workspaces editing the same file do not contaminate each other", { skip: !hasGit }, async () => {
  const dir = await gitRepo();
  try {
    await writeFile(join(dir, "m.txt"), "alpha\nbeta\ngamma\n", "utf8");
    avcs(dir, "git-sync", "-m", "base", "--no-add");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");

    for (const [branch, body] of [["ws-1", "ALPHA\nbeta\ngamma\n"], ["ws-2", "alpha\nbeta\nGAMMA\n"]] as const) {
      git(dir, "checkout", "-q", "-b", branch, "main");
      await writeFile(join(dir, "m.txt"), body, "utf8");
      avcs(dir, "git-sync", "-m", `${branch} work`, "--no-add");
    }

    const repo = await Repo.open(dir);
    const contentIn = async (ws: string) =>
      (await repo.materializedFiles(await repo.materialize("main", { workspace: ws }))).find((f) => f.path === "m.txt")?.content;
    assert.equal(await contentIn("ws-1"), "ALPHA\nbeta\ngamma\n");
    assert.equal(await contentIn("ws-2"), "alpha\nbeta\nGAMMA\n");
    assert.equal((await repo.materialize("main")).conflicts.length, 0, "unlanded workspaces never collide on base");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("W14: capturing twice in a workspace does not re-capture its own earlier change", { skip: !hasGit }, async () => {
  const dir = await gitRepo();
  try {
    await writeFile(join(dir, "a.txt"), "one\n", "utf8");
    avcs(dir, "git-sync", "-m", "base", "--no-add");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    git(dir, "checkout", "-q", "-b", "topic-c");

    await writeFile(join(dir, "a.txt"), "two\n", "utf8");
    const first = avcs(dir, "git-sync", "-m", "first", "--no-add");
    assert.match(first, /M a\.txt/, "the first capture sees the edit");

    // Nothing changed on disk since the re-projection, so the second capture is a no-op.
    // If the capture diffed against the BASE projection it would keep re-reporting "M a.txt"
    // (and, with rename detection, could pair stale removals into phantom renames).
    const second = avcs(dir, "git-sync", "-m", "second", "--no-add");
    assert.match(second, /captured 0 op\(s\)/, "second capture is empty — the workspace projection is the base");
    assert.doesNotMatch(second, /^\s+[AMDR] /m, "no phantom add/modify/delete/rename");

    const repo = await Repo.open(dir);
    const content = (await repo.materializedFiles(await repo.materialize("main", { workspace: "topic-c" })))
      .find((f) => f.path === "a.txt")?.content;
    assert.equal(content, "two\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Task 4: post-merge land seam ────────────────────────────────────────────
test("W10/W11: mergedBranchFromReflog identifies a merge, and refuses to guess otherwise", () => {
  // W10 — git's own reflog wording for a merge, including the `--no-ff` / octopus shapes.
  assert.equal(mergedBranchFromReflog("merge topic-a: Merge made by the 'ort' strategy."), "topic-a");
  assert.equal(mergedBranchFromReflog("merge feat/x: Fast-forward"), "feat/x");
  assert.equal(mergedBranchFromReflog("pull origin topic-a: Merge made by the 'ort' strategy."), "topic-a");
  assert.equal(mergedBranchFromReflog("pull --no-rebase origin topic-a: Fast-forward"), "topic-a", "flags carry no name");
  // W11 — anything else yields null. Landing is append-only and irreversible, so guessing
  // wrong is worse than not landing (docs/20 R1).
  assert.equal(mergedBranchFromReflog("commit: squashed everything"), null);
  assert.equal(mergedBranchFromReflog("rebase (finish): returning to refs/heads/main"), null);
  assert.equal(mergedBranchFromReflog("merge a b: Merge made by the 'octopus' strategy."), null, "octopus: several branches, no single answer");
  assert.equal(mergedBranchFromReflog("pull origin a b: Merge made by the 'octopus' strategy."), null, "multi-ref pull: same reason");
  assert.equal(mergedBranchFromReflog("pull: Fast-forward"), null, "no ref recorded at all");
  assert.equal(mergedBranchFromReflog(""), null);
  assert.equal(mergedBranchFromReflog(null), null);
  assert.equal(mergedBranchFromReflog("merge HEAD: Fast-forward"), null, "HEAD is not a branch name");
});

test("W4/W10: a git merge into trunk lands the merged branch's workspace", { skip: !hasGit }, async () => {
  const dir = await gitRepo();
  try {
    avcs(dir, "install-hooks", "--force");
    await writeFile(join(dir, "m.txt"), "alpha\nbeta\ngamma\n", "utf8");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base"); // hooks capture on trunk (untagged)

    git(dir, "checkout", "-q", "-b", "topic-d");
    await writeFile(join(dir, "m.txt"), "ALPHA\nbeta\ngamma\n", "utf8");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "topic edit"); // captured as workspace topic-d

    const before = await Repo.open(dir);
    assert.deepEqual(await before.landedWorkspaces(), [], "nothing landed yet");

    git(dir, "checkout", "-q", "main");
    // A trunk-side edit to a disjoint region, so the land exercises the 3-way merge.
    await writeFile(join(dir, "m.txt"), "alpha\nbeta\nGAMMA\n", "utf8");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "trunk edit");
    git(dir, "merge", "--no-ff", "-m", "merge topic-d", "topic-d");

    const repo = await Repo.open(dir);
    assert.deepEqual(await repo.landedWorkspaces(), ["topic-d"], "post-merge landed the merged branch");
    const res = await repo.materialize("main");
    assert.equal(res.conflicts.length, 0, "disjoint edits auto-merge on land");
    assert.equal(
      (await repo.materializedFiles(res)).find((f) => f.path === "m.txt")?.content,
      "ALPHA\nbeta\nGAMMA\n",
      "the landed workspace 3-way merges with the trunk op",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("W11: post-merge lands NOTHING when the merged branch cannot be identified, and says so", { skip: !hasGit }, async () => {
  const dir = await gitRepo();
  try {
    avcs(dir, "install-hooks", "--force");
    await writeFile(join(dir, "a.txt"), "base\n", "utf8");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");

    // A squash-merge shape: the change arrives as a plain commit on trunk, so the reflog
    // carries no `merge <branch>` entry (docs/20 R2).
    await writeFile(join(dir, "a.txt"), "squashed\n", "utf8");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "squashed topic");
    // Run the hook by hand — a squash leaves no merge for git to fire it on.
    const run = spawnSync(process.execPath, ["--experimental-strip-types", CLI, "git-hook", "post-merge"], {
      cwd: dir, encoding: "utf8",
    });
    const text = `${run.stdout}${run.stderr}`;

    const repo = await Repo.open(dir);
    assert.deepEqual(await repo.landedWorkspaces(), [], "nothing was landed — land is irreversible (R1)");
    assert.match(text, /landed NOTHING/, "says outright that nothing landed");
    assert.match(text, /avcs workspace land/, "points at the manual path instead of failing silently");
    assert.match(text, /squash/i, "names the reason a squash workflow hits this");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("W9/W11b: merging a branch that is an avcs LINE lands nothing and does not cry for a human", { skip: !hasGit }, async () => {
  const dir = await gitRepo();
  try {
    avcs(dir, "install-hooks", "--force");
    await writeFile(join(dir, "a.txt"), "base\n", "utf8");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");

    // A branch from before this mapping existed: it already has a `line:<branch>` ref, so
    // its capture keeps going to that line (W9) — and merging it is a port, not a land.
    git(dir, "checkout", "-q", "-b", "legacy-topic");
    await (await Repo.open(dir)).createLine("legacy-topic");
    await writeFile(join(dir, "l.txt"), "on the line\n", "utf8");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "line work");

    const mid = await Repo.open(dir);
    assert.deepEqual(
      (await mid.materializedFiles(await mid.materialize("legacy-topic"))).map((f) => f.path).sort(),
      ["a.txt", "l.txt"],
      "W9: the capture went to the pre-existing line, not to a new workspace",
    );
    assert.deepEqual(await mid.workspaceNames(), [], "no workspace was invented for it");

    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "--no-ff", "-m", "merge legacy-topic", "legacy-topic");
    const run = spawnSync(process.execPath, ["--experimental-strip-types", CLI, "git-hook", "post-merge"], {
      cwd: dir, encoding: "utf8",
    });
    const text = `${run.stdout}${run.stderr}`;

    const repo = await Repo.open(dir);
    assert.deepEqual(await repo.landedWorkspaces(), [], "a line is never landed as a workspace");
    assert.doesNotMatch(text, /landed NOTHING/, "not an unresolved land — nothing was owed");
    assert.match(text, /nothing to land/, "still says what it did, quietly");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("`avcs conflicts` inspects the current scope, so a workspace's conflicts are not reported as none", { skip: !hasGit }, async () => {
  const dir = await gitRepo();
  try {
    // A base file, then two CONCURRENT writes to it inside one workspace — the shape that
    // reduce leaves as an open conflict for a human.
    const repo = await Repo.open(dir);
    const intent = await repo.createIntent({ title: "t", owner: "human:h" });
    const sess = await repo.startSession({ intentOid: intent, actor: dev });
    const common = { sessionOid: sess, intentOid: intent, actor: dev, declaredPurpose: "w", workspace: "topic-g" };
    await repo.proposeFileWrite({ ...common, path: "c.txt", content: "left\n" });
    await repo.proposeFileWrite({ ...common, path: "c.txt", content: "right\n" });
    assert.ok((await repo.materialize("main", { workspace: "topic-g" })).conflicts.length > 0, "fixture really conflicts");

    git(dir, "commit", "-q", "--allow-empty", "-m", "seed");
    git(dir, "checkout", "-q", "-b", "topic-g");
    const out = avcs(dir, "conflicts");
    assert.match(out, /workspace topic-g/, "says which scope it inspected");
    assert.doesNotMatch(out, /no open conflicts/, "the workspace's conflict is reported");

    // On trunk the same command reports the base view, exactly as before.
    git(dir, "checkout", "-q", "main");
    assert.match(avcs(dir, "conflicts"), /no open conflicts/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("W12: landWorkspace is idempotent — the ref does not move on a second call", async () => {
  const dir = await mk();
  const repo = await Repo.init(dir);
  try {
    const intent = await repo.createIntent({ title: "t", owner: "human:h" });
    const sess = await repo.startSession({ intentOid: intent, actor: dev });
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: dev, path: "f.txt", content: "x\n", declaredPurpose: "w", workspace: "wsA" });
    await repo.landWorkspace("wsA");
    const first = await repo.store.getRef("workspaces.landed");
    await repo.landWorkspace("wsA");
    assert.equal(await repo.store.getRef("workspaces.landed"), first, "second land is a no-op");
    assert.deepEqual(await repo.landedWorkspaces(), ["wsA"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Task 5: `workspace project` uses the configured trunk ───────────────────
test("W13: `workspace project` resolves the base from the configured trunk, not a hardcoded main", { skip: !hasGit }, async () => {
  const dir = await gitRepo("dev");
  const out = await mk();
  try {
    avcs(dir, "trunk", "dev");
    const repo = await Repo.open(dir);
    const intent = await repo.createIntent({ title: "t", owner: "human:h" });
    const sess = await repo.startSession({ intentOid: intent, actor: dev });
    const common = { sessionOid: sess, intentOid: intent, actor: dev };
    // Under the new mapping, work on the trunk branch is untagged base-view work — so the
    // base of a workspace is the default view even though the trunk is called `dev`.
    await repo.proposeFileWrite({ ...common, path: "on-trunk.txt", content: "trunk\n", declaredPurpose: "base" });
    await repo.proposeFileWrite({ ...common, path: "ws.txt", content: "ws\n", declaredPurpose: "ws", workspace: "topic-e" });

    const printed = avcs(dir, "workspace", "project", "topic-e", "--out", out);
    assert.match(printed, /over main/, "names the view it projected");
    assert.equal(await readFile(join(out, "on-trunk.txt"), "utf8"), "trunk\n", "the trunk's content is projected");
    assert.equal(await readFile(join(out, "ws.txt"), "utf8"), "ws\n", "plus the workspace's own");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test("W13b: a legacy trunk that is still an avcs line is projected from that line", { skip: !hasGit }, async () => {
  const dir = await gitRepo("dev");
  const out = await mk();
  try {
    avcs(dir, "trunk", "dev");
    const repo = await Repo.open(dir);
    // A repo from before trunk existed: the `dev` branch had become the `dev` LINE, and its
    // work lives there. The old hardcoded `main` made `workspace project` unusable for it.
    await repo.createLine("dev");
    const intent = await repo.createIntent({ title: "t", owner: "human:h" });
    const sess = await repo.startSession({ intentOid: intent, actor: dev });
    const common = { sessionOid: sess, intentOid: intent, actor: dev, line: "dev" };
    await repo.proposeFileWrite({ ...common, path: "on-dev-line.txt", content: "dev line\n", declaredPurpose: "base" });
    await repo.proposeFileWrite({ ...common, path: "ws.txt", content: "ws\n", declaredPurpose: "ws", workspace: "topic-f" });

    const printed = avcs(dir, "workspace", "project", "topic-f", "--out", out);
    assert.match(printed, /over dev/, "projected the dev line, not main");
    assert.equal(await readFile(join(out, "on-dev-line.txt"), "utf8"), "dev line\n");
    assert.equal(await readFile(join(out, "ws.txt"), "utf8"), "ws\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

// ── Task 6: backward compatibility ──────────────────────────────────────────
test("W7: a repo with no trunk configured behaves exactly as before — untagged capture on main", { skip: !hasGit }, async () => {
  const dir = await gitRepo();
  try {
    // No `avcs trunk` call anywhere: config.json must stay trunk-free.
    await writeFile(join(dir, "a.txt"), "one\n", "utf8");
    avcs(dir, "git-sync", "-m", "one", "--no-add");
    await writeFile(join(dir, "b.txt"), "two\n", "utf8");
    avcs(dir, "git-sync", "-m", "two", "--no-add");

    const cfg = JSON.parse(await readFile(join(dir, ".avcs", "config.json"), "utf8")) as Record<string, unknown>;
    assert.equal(cfg.trunk, undefined, "nothing wrote a trunk field");

    const repo = await Repo.open(dir);
    assert.deepEqual(await pathsOf(repo), ["a.txt", "b.txt"], "both captures are in the base view, untagged");
    assert.deepEqual(await repo.landedWorkspaces(), [], "no workspace was invented");
    assert.deepEqual((await repo.listLines()).map((l) => l.name), [], "no line was invented");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("W6: abandoning an unlanded workspace leaves the base view untouched, ops still audited", async () => {
  const dir = await mk();
  const repo = await Repo.init(dir);
  try {
    const intent = await repo.createIntent({ title: "t", owner: "human:h" });
    const sess = await repo.startSession({ intentOid: intent, actor: dev });
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: dev, path: "base.txt", content: "b\n", declaredPurpose: "base" });
    const abandoned = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: dev, path: "gone.txt", content: "g\n", declaredPurpose: "ws", workspace: "dead-ws" });

    // "Abandoning" is simply never landing it. There is nothing to clean up.
    assert.deepEqual(await pathsOf(repo), ["base.txt"], "base view unchanged");
    assert.ok(await repo.store.has(abandoned), "the op is still on disk for audit");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("W15: an existing line's treeHash is unchanged by the workspace remapping", async () => {
  const dir = await mk();
  const repo = await Repo.init(dir);
  try {
    // A pre-trunk history: a real line with its own ops, captured the old way.
    const intent = await repo.createIntent({ title: "t", owner: "human:h" });
    const sess = await repo.startSession({ intentOid: intent, actor: dev });
    const base = "alpha\nbeta\n";
    const put = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: dev, path: "m.txt", content: base, declaredPurpose: "base" });
    await repo.createLine("legacy");
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: dev, path: "l.txt", content: "L\n", declaredPurpose: "on the line", line: "legacy" });
    await repo.proposeEdit({ sessionOid: sess, intentOid: intent, actor: dev, path: "m.txt", baseText: base, newText: "ALPHA\nbeta\n", causalDeps: [put], declaredPurpose: "line edit", line: "legacy" });

    const lineTree = await repo.materialize("legacy");
    assert.deepEqual((await repo.materializedFiles(lineTree)).map((f) => f.path).sort(), ["l.txt", "m.txt"]);
    assert.equal((await repo.materializedFiles(lineTree)).find((f) => f.path === "m.txt")?.content, "ALPHA\nbeta\n");

    // Landing an unrelated workspace must not perturb the line's reduction: the landed set
    // is now consulted on every view, so this is the guard that says "consulted ≠ changed".
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: dev, path: "ws.txt", content: "w\n", declaredPurpose: "ws", workspace: "unrelated" });
    await repo.landWorkspace("unrelated");
    const again = await repo.materialize("legacy");
    assert.equal(again.treeHash, lineTree.treeHash, "the line's treeHash is byte-identical");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

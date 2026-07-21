// Working-tree capture must include git-adjacent DOTFILES that are code — `.github/`
// (CI workflows), `.gitignore`, `.gitattributes` — while still skipping git's own
// `.git/` directory and AVCS state. A `startsWith(".git")` filter over-matched all of
// them, so they could never enter the op graph and `verify-git` reported them as
// "+git only" on every real repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";

test("commitWorkingTree captures .github/.gitignore/.gitattributes but never .git/ or .avcs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-dot-"));
  try {
    const repo = await Repo.init(dir);
    await mkdir(join(dir, ".github", "workflows"), { recursive: true });
    await writeFile(join(dir, ".github", "workflows", "ci.yml"), "name: ci\n", "utf8");
    await writeFile(join(dir, ".gitignore"), "node_modules/\n", "utf8");
    await writeFile(join(dir, ".gitattributes"), "* text=auto\n", "utf8");
    await writeFile(join(dir, "app.ts"), "export const v = 1;\n", "utf8");
    // git's own directory — internal state, never part of the projection
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, ".git", "config"), "[core]\n", "utf8");

    const r = await repo.commitWorkingTree(dir, { message: "adopt", actor: { kind: "human", id: "human:h" } });
    assert.deepEqual(
      r.added,
      [".gitattributes", ".github/workflows/ci.yml", ".gitignore", "app.ts"],
      "dotfile code is captured; .git/ and .avcs/ are not",
    );

    const files = [...(await repo.materialize("main")).tree.keys()].sort();
    assert.ok(files.includes(".github/workflows/ci.yml") && files.includes(".gitignore"), "captured dotfiles project into the tree");
    assert.ok(!files.some((f) => f === ".git" || f.startsWith(".git/")), "git internals never project");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

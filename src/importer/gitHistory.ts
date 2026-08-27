import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Repo } from "../api/repo.ts";
import type { Actor } from "../objects/types.ts";

const execFileAsync = promisify(execFile);

/**
 * Programmatic git-history import (issue #63).
 *
 * A server process (or any embedder) replays a git repository's history into
 * an AVCS operation graph without shelling out to the `avcs` CLI. Two layers,
 * so the core's git-independence is preserved:
 *
 *  - {@link GitHistorySource} — the seam. Anything that can enumerate commits
 *    (sha + metadata + per-commit file changes) drives the import; no git
 *    binary is required at this layer.
 *  - {@link gitCliSource} — the batteries-included source. Reads a checkout,
 *    a bare repo, a bundle file, or a clone URL by shelling out to `git`
 *    (exactly like the CLI's existing git-bridge does). Fails with a clear
 *    error when no git binary is available.
 *
 * History maps onto AVCS the way `commitWorkingTree` established: one intent +
 * one session per commit (title = the commit subject, owner = the git author),
 * `put_file`/`delete_file` operations per changed path, each new commit's ops
 * anchored on the previous frontier via `causalDeps`. AVCS history is an
 * operation graph, not replayed diffs — the import walks the FIRST-PARENT
 * line, so a merge commit lands as its net effect on the mainline (the side
 * branch's internal commits are not replayed).
 *
 * Commit metadata travels in existing fields — no object-schema change:
 * the actor is `git:<author-email>`, `Co-authored-by:` trailers become
 * `coAuthors`, and `declaredPurpose` carries the full commit message plus a
 * `[git <sha>] <author> <date>` provenance line.
 */

/** One file touched by a commit. `read` is required for `kind: "write"`. */
export interface GitFileChange {
  readonly path: string;
  readonly kind: "write" | "delete";
  readonly read?: () => Promise<Uint8Array>;
}

/** One commit on the imported line, in replay (oldest-first) order. */
export interface GitCommitRecord {
  readonly sha: string;
  readonly subject: string;
  readonly message: string;
  readonly authorName: string;
  readonly authorEmail: string;
  /** Author date, ISO-8601. */
  readonly authorDate: string;
  readonly coAuthors: ReadonlyArray<{ name: string; email: string }>;
  readonly changes: readonly GitFileChange[];
}

/** The import seam: enumerate commits oldest-first. No git binary implied. */
export interface GitHistorySource {
  commits(): AsyncIterable<GitCommitRecord>;
  /** Release temp resources (e.g. a bare clone). Safe to omit. */
  close?(): Promise<void>;
}

export interface ImportGitHistoryOptions {
  /** AVCS line (view) to import onto. Default `main`. */
  readonly line?: string;
  /**
   * Actor recorded when a commit has no usable author identity, and the
   * session opener. Defaults to `{ id: "git-import", kind: "ci_bot" }`.
   */
  readonly actor?: Actor;
  /** Progress callback: commits replayed so far + the sha just finished. */
  readonly onCommit?: (done: number, sha: string) => void;
}

export interface ImportGitHistoryResult {
  /** Commits walked on the first-parent line (empty ones included). */
  readonly commits: number;
  /** Operations authored. */
  readonly operations: number;
  /** Intents created (one per commit that changed anything). */
  readonly intents: number;
}

/** What {@link gitCliSource} accepts: a checkout/bare dir, a bundle, or a URL. */
export type GitCliTarget = string | { dir?: string; url?: string; bundle?: string; ref?: string };

async function runGit(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", dir, ...args], {
    maxBuffer: 1 << 28,
  });
  return stdout;
}

async function runGitBuffer(dir: string, args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", ["-C", dir, ...args], {
    maxBuffer: 1 << 28,
    encoding: "buffer",
  });
  return stdout as unknown as Buffer;
}

function parseCoAuthors(message: string): Array<{ name: string; email: string }> {
  const out: Array<{ name: string; email: string }> = [];
  for (const line of message.split("\n")) {
    const m = /^co-authored-by:\s*(.+?)\s*<([^>]*)>\s*$/i.exec(line.trim());
    if (m) out.push({ name: m[1]!, email: m[2]! });
  }
  return out;
}

/**
 * A {@link GitHistorySource} backed by the `git` binary. A URL or bundle is
 * bare-cloned into a temp dir (removed on `close()`); a local dir is read in
 * place. The walk is `rev-list --first-parent --reverse <ref>` and per-commit
 * changes come from `diff-tree` against the first parent (`--no-renames`, so
 * a rename is a delete + write — the reducer treats paths as entities).
 */
export async function gitCliSource(target: GitCliTarget): Promise<GitHistorySource> {
  try {
    await execFileAsync("git", ["--version"]);
  } catch {
    throw new Error(
      "gitCliSource requires a `git` executable on PATH. To import without one, " +
        "implement GitHistorySource yourself (e.g. over a parsed bundle) and pass it " +
        "to importGitHistory directly.",
    );
  }

  const t = typeof target === "string" ? inferTarget(target) : target;
  const ref = t.ref ?? "HEAD";

  let dir: string;
  let tempClone: string | null = null;
  if (t.dir) {
    dir = t.dir;
  } else {
    const source = t.url ?? t.bundle;
    if (!source) throw new Error("gitCliSource: pass one of dir, url, or bundle");
    tempClone = await mkdtemp(join(tmpdir(), "avcs-git-import-"));
    await execFileAsync("git", ["clone", "--bare", "--quiet", source, join(tempClone, "src.git")], {
      maxBuffer: 1 << 24,
    });
    dir = join(tempClone, "src.git");
  }

  return {
    async *commits(): AsyncIterable<GitCommitRecord> {
      const shas = (await runGit(dir, ["rev-list", "--first-parent", "--reverse", ref]))
        .split("\n")
        .filter(Boolean);
      for (const sha of shas) {
        // %x00-separated to survive arbitrary subjects/messages.
        const meta = await runGit(dir, [
          "show",
          "-s",
          "--format=%an%x00%ae%x00%aI%x00%s%x00%B",
          sha,
        ]);
        const [authorName = "", authorEmail = "", authorDate = "", subject = "", ...rest] =
          meta.split("\0");
        const message = rest.join("\0").replace(/\n$/, "");

        // First-parent diff; --root covers the parentless first commit.
        const hasParent =
          (await runGit(dir, ["rev-list", "--parents", "-n", "1", sha])).trim().split(" ").length > 1;
        const rawDiff = hasParent
          ? await runGit(dir, ["diff-tree", "--no-renames", "-r", "-z", "--name-status", `${sha}^`, sha])
          : await runGit(dir, ["diff-tree", "--root", "--no-renames", "-r", "-z", "--name-status", sha]);
        const fields = rawDiff.split("\0").filter(Boolean);
        // A --root diff-tree echoes the sha as its first record; drop it.
        const records = fields[0] === sha ? fields.slice(1) : fields;

        const changes: GitFileChange[] = [];
        for (let i = 0; i + 1 < records.length; i += 2) {
          const status = records[i]!;
          const path = records[i + 1]!;
          if (status.startsWith("D")) {
            changes.push({ path, kind: "delete" });
          } else {
            changes.push({
              path,
              kind: "write",
              read: () => runGitBuffer(dir, ["cat-file", "blob", `${sha}:${path}`]),
            });
          }
        }

        yield {
          sha,
          subject,
          message,
          authorName,
          authorEmail,
          authorDate,
          coAuthors: parseCoAuthors(message),
          changes,
        };
      }
    },
    async close(): Promise<void> {
      if (tempClone) await rm(tempClone, { recursive: true, force: true });
    },
  };
}

function inferTarget(target: string): { dir?: string; url?: string; bundle?: string; ref?: string } {
  if (/^[a-z+]+:\/\//i.test(target) || /^[^/\s]+@[^/\s]+:/.test(target)) return { url: target };
  if (target.endsWith(".bundle")) return { bundle: target };
  if (existsSync(target)) return { dir: target };
  return { url: target };
}

/**
 * Replay a git history into `repo` as an operation graph. See the module doc
 * for the mapping. Accepts a {@link GitHistorySource}, or anything
 * {@link gitCliSource} understands (dir / URL / bundle path).
 */
export async function importGitHistory(
  repo: Repo,
  source: GitHistorySource | GitCliTarget,
  opts: ImportGitHistoryOptions = {},
): Promise<ImportGitHistoryResult> {
  const src: GitHistorySource =
    typeof source === "object" && source !== null && "commits" in source
      ? (source as GitHistorySource)
      : await gitCliSource(source as GitCliTarget);

  const fallback: Actor = opts.actor ?? { id: "git-import", kind: "ci_bot" };
  let commits = 0;
  let operations = 0;
  let intents = 0;

  try {
    for await (const c of src.commits()) {
      commits += 1;
      if (c.changes.length === 0) {
        opts.onCommit?.(commits, c.sha);
        continue;
      }

      const authorId = c.authorEmail || c.authorName;
      const actor: Actor = authorId ? { id: `git:${authorId}`, kind: "human" } : fallback;
      const coAuthors: Actor[] = c.coAuthors.map((a) => ({
        id: `git:${a.email || a.name}`,
        kind: "human" as const,
      }));
      const purpose =
        `${c.message.trimEnd()}\n\n` +
        `[git ${c.sha}] ${c.authorName} <${c.authorEmail}> ${c.authorDate}`;

      // Anchor this commit's ops on the current frontier — the same shape
      // commitWorkingTree produces, so downstream tooling sees familiar graphs.
      const res = await repo.materialize(opts.line ?? "main");
      const deps = res.headOps;
      const intentOid = await repo.createIntent({ title: c.subject || c.sha, owner: actor.id });
      const sessionOid = await repo.startSession({ intentOid, actor });
      intents += 1;

      for (const change of c.changes) {
        if (change.kind === "write") {
          if (!change.read) throw new Error(`GitFileChange for ${change.path} lacks read()`);
          const blobOid = await repo.putBlob(await change.read());
          await repo.proposeOperation({
            sessionOid,
            intentOid,
            actor,
            target: { entityKind: "file", entityId: change.path },
            body: { kind: "put_file", path: change.path, blobOid },
            declaredPurpose: purpose,
            causalDeps: deps,
            coAuthors,
            line: opts.line,
          });
        } else {
          await repo.proposeOperation({
            sessionOid,
            intentOid,
            actor,
            target: { entityKind: "file", entityId: change.path },
            body: { kind: "delete_file", path: change.path },
            declaredPurpose: purpose,
            causalDeps: deps,
            coAuthors,
            line: opts.line,
          });
        }
        operations += 1;
      }
      opts.onCommit?.(commits, c.sha);
    }
  } finally {
    await src.close?.();
  }

  return { commits, operations, intents };
}

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
export type GitCliTarget =
  | string
  | {
      dir?: string;
      url?: string;
      bundle?: string;
      ref?: string;
      /**
       * Wall-clock bound for EVERY git invocation (issue #71). A server driving
       * this cannot afford an unbounded clone: an endpoint that accepts and never
       * answers would hang the request forever and leak the temp clone. Default
       * 10 minutes; 0 disables the bound.
       */
      timeoutMs?: number;
    };

/** Default bound per git invocation. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Refuse a value git would read as an option (issue #71). Positional values also
 * get a `--` terminator below, but a caller deserves a clear error rather than a
 * confusing git failure — and `--` does not save every subcommand.
 */
function rejectOptionLike(what: string, value: string): void {
  if (value.startsWith("-")) {
    throw new Error(
      `gitCliSource: ${what} may not start with "-" (git would read "${value}" as an option)`,
    );
  }
}

/**
 * git config forced onto every invocation. `http.followRedirects=false` is the
 * important one: a caller that vetted a URL must not have git pivot elsewhere on
 * a 302 (issue #71). Passed via GIT_CONFIG_* so it cannot be overridden by the
 * repo's own config.
 */
function forcedGitConfig(timeoutMs: number): NodeJS.ProcessEnv {
  // git gives up on a stalled transfer itself. This matters more than the process
  // timeout below: `git clone` spawns git-remote-http, so killing only the parent
  // leaves a grandchild holding the pipes and the promise never settles.
  const stallSecs = timeoutMs > 0 ? Math.max(1, Math.ceil(timeoutMs / 1000)) : 0;
  const entries: Array<[string, string]> = [
    ["http.followRedirects", "false"],
    // Never stop for credentials: a prompt in a server process hangs forever.
    ["core.askPass", ""],
  ];
  if (stallSecs > 0) {
    entries.push(["http.lowSpeedLimit", "1"], ["http.lowSpeedTime", String(stallSecs)]);
  }
  const env: NodeJS.ProcessEnv = {
    GIT_CONFIG_COUNT: String(entries.length),
    GIT_TERMINAL_PROMPT: "0",
  };
  entries.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
}

function gitOpts(timeoutMs: number, extra: Record<string, unknown> = {}) {
  return {
    maxBuffer: 1 << 28,
    // Backstop for anything the git-level stall bound misses. `detached` puts the
    // child in its own process group so the kill reaches git-remote-http too.
    ...(timeoutMs > 0
      ? { timeout: Math.ceil(timeoutMs * 1.5), killSignal: "SIGKILL" as const, detached: true }
      : {}),
    env: { ...process.env, ...forcedGitConfig(timeoutMs) },
    ...extra,
  };
}

async function runGit(dir: string, args: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", dir, ...args], gitOpts(timeoutMs));
  return stdout;
}

async function runGitBuffer(dir: string, args: string[], timeoutMs: number): Promise<Buffer> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", dir, ...args],
    gitOpts(timeoutMs, { encoding: "buffer" }),
  );
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
  const timeoutMs = t.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Positional values reach git as arguments; a leading "-" would be an option.
  if (t.dir) rejectOptionLike("dir", t.dir);
  if (t.url) rejectOptionLike("url", t.url);
  if (t.bundle) rejectOptionLike("bundle", t.bundle);
  rejectOptionLike("ref", ref);

  let dir: string;
  let tempClone: string | null = null;
  if (t.dir) {
    dir = t.dir;
  } else {
    const source = t.url ?? t.bundle;
    if (!source) throw new Error("gitCliSource: pass one of dir, url, or bundle");
    tempClone = await mkdtemp(join(tmpdir(), "avcs-git-import-"));
    try {
      await execFileAsync(
        "git",
        ["clone", "--bare", "--quiet", "--", source, join(tempClone, "src.git")],
        gitOpts(timeoutMs, { maxBuffer: 1 << 24 }),
      );
    } catch (err) {
      // A bounded clone that was killed still left a temp dir behind.
      await rm(tempClone, { recursive: true, force: true });
      const e = err as { killed?: boolean; signal?: string };
      if (e.killed || e.signal) {
        throw new Error(`gitCliSource: clone timed out after ${timeoutMs}ms`);
      }
      throw err;
    }
    dir = join(tempClone, "src.git");
  }

  return {
    async *commits(): AsyncIterable<GitCommitRecord> {
      const shas = (await runGit(dir, ["rev-list", "--first-parent", "--reverse", ref, "--"], timeoutMs))
        .split("\n")
        .filter(Boolean);
      for (const sha of shas) {
        // %x00-separated to survive arbitrary subjects/messages.
        const meta = await runGit(
          dir,
          ["show", "-s", "--format=%an%x00%ae%x00%aI%x00%s%x00%B", sha],
          timeoutMs,
        );
        const [authorName = "", authorEmail = "", authorDate = "", subject = "", ...rest] =
          meta.split("\0");
        const message = rest.join("\0").replace(/\n$/, "");

        // First-parent diff; --root covers the parentless first commit.
        const hasParent =
          (await runGit(dir, ["rev-list", "--parents", "-n", "1", sha], timeoutMs)).trim().split(" ").length >
          1;
        const rawDiff = hasParent
          ? await runGit(
              dir,
              ["diff-tree", "--no-renames", "-r", "-z", "--name-status", `${sha}^`, sha],
              timeoutMs,
            )
          : await runGit(
              dir,
              ["diff-tree", "--root", "--no-renames", "-r", "-z", "--name-status", sha],
              timeoutMs,
            );
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
              read: () => runGitBuffer(dir, ["cat-file", "blob", `${sha}:${path}`], timeoutMs),
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

function inferTarget(target: string): Exclude<GitCliTarget, string> {
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

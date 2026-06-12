// Phase 3: validation runner.
//
// Self-contained module that turns real shell-command results into AVCS Evidence.
// It materializes a view, writes the workspace to disk, runs each check command
// against that workspace, and attaches a pass/fail Evidence object per check.
//
// Design notes:
//   - Uses ONLY the public Repo API (materialize, writeWorkspace, attachEvidence).
//   - Robust: a command that cannot be spawned (e.g. command-not-found) maps to a
//     "fail" Evidence, never a thrown error, so one broken check can't abort the run.
//   - Bounded: stdout/stderr capture is truncated so a runaway command can't bloat
//     the object store.

import { execFile } from "node:child_process";
import type { Repo } from "../api/repo.ts";
import type { Actor, EvidenceKind } from "../objects/types.ts";

/** A single validation step: what kind of evidence it produces + the shell command. */
export interface CheckSpec {
  kind: EvidenceKind;
  command: string;
}

/** Detail (stdout/stderr) is truncated to keep evidence objects small. */
const DETAIL_LIMIT = 2000;
/** Per-command wall-clock budget. */
const TIMEOUT_MS = 30_000;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

/**
 * Run a shell command in `cwd`, capturing exit code + bounded stdout/stderr.
 * Never rejects: a spawn failure (command-not-found) or a timeout resolves with a
 * non-zero/null code so the caller can treat it as a "fail".
 */
function runCommand(command: string, cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    // Route through the shell so `command` can be an arbitrary command line.
    const child = execFile(
      command,
      {
        cwd,
        shell: true,
        timeout: TIMEOUT_MS,
        // Cap captured bytes; overflow kills the child and surfaces as an error.
        maxBuffer: DETAIL_LIMIT * 8,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const out = String(stdout ?? "");
        const errOut = String(stderr ?? "");
        if (err) {
          // execFile's error carries `.code` (exit code) for normal non-zero exits,
          // but a number-or-string. A real spawn failure has no numeric exit code.
          const code = typeof (err as { code?: unknown }).code === "number"
            ? ((err as { code: number }).code)
            : child.exitCode;
          resolve({
            code: typeof code === "number" ? code : null,
            stdout: out,
            stderr: errOut,
            spawnError: code === undefined || typeof code !== "number" ? err.message : undefined,
          });
          return;
        }
        resolve({ code: child.exitCode ?? 0, stdout: out, stderr: errOut });
      },
    );
  });
}

function truncate(s: string, limit = DETAIL_LIMIT): string {
  if (s.length <= limit) return s;
  return s.slice(0, limit) + `\n…[truncated ${s.length - limit} chars]`;
}

/**
 * Materialize the view, write it to `workspaceDir`, run each check, and attach a
 * pass/fail Evidence for every check (exit 0 → "pass", anything else → "fail").
 * Returns the oids of the attached Evidence objects, in `checks` order.
 */
export async function runChecks(
  repo: Repo,
  opts: {
    ops: string[];
    view?: string;
    workspaceDir: string;
    ciActor: Actor;
    checks: CheckSpec[];
  },
): Promise<string[]> {
  const result = await repo.materialize(opts.view ?? "main");
  await repo.writeWorkspace(result, opts.workspaceDir);

  const evidenceOids: string[] = [];
  for (const check of opts.checks) {
    const run = await runCommand(check.command, opts.workspaceDir);
    const pass = run.code === 0;

    const detailParts: string[] = [`$ ${check.command}`, `exit: ${run.code ?? "null"}`];
    if (run.spawnError) detailParts.push(`spawn-error: ${run.spawnError}`);
    if (run.stdout.trim()) detailParts.push(`--- stdout ---\n${run.stdout}`);
    if (run.stderr.trim()) detailParts.push(`--- stderr ---\n${run.stderr}`);

    const oid = await repo.attachEvidence({
      forOps: opts.ops,
      kind: check.kind,
      result: pass ? "pass" : "fail",
      producedBy: opts.ciActor,
      command: check.command,
      detail: truncate(detailParts.join("\n")),
    });
    evidenceOids.push(oid);
  }
  return evidenceOids;
}

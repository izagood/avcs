// What a git-bridge hook says when its deadline (#33) fires.
//
// These live apart from the hook so they can be asserted directly. Reaching them through a
// real `git commit` means racing the deadline against the work — which bound trips depends on
// how fast the machine is that day, and a test that picks its assertion by stopwatch is the
// flake this repository has already paid for once (#55).
//
// The wording is the subject of #156. Two things a timeout may not say:
//
//   - that nothing was captured. The deadline abandons the ingest wherever it stood, and the
//     capture runs first, so operations, blobs and the intent are frequently already durable.
//     What is reliably missing is the checkpoint, the reprojection and the trailer.
//   - that another process was holding the store. The one lock on this path throws
//     `lock timeout acquiring …`, and `withDeadline` propagates errors unchanged — so a
//     contended store never reaches the timeout branch. It was a guess printed as a finding.

/** The store could not even be opened inside the bound: this hook does nothing at all.
 *  `phase` comes straight off argv and may be absent — say so rather than printing
 *  "git-hook undefined", which reads as a bug in avcs rather than a missing argument. */
export function storeOpenTimeoutMessage(phase: string | undefined, ms: number): string {
  return (
    `avcs: opening the store exceeded ${ms}ms — skipping git-hook ${phase ?? "(unnamed phase)"} and letting git proceed (#33).\n` +
    `  Nothing was read or written. Set AVCS_HOOK_TIMEOUT_MS=0 to wait, or a larger value to raise the bound.`
  );
}

/**
 * The capture stopped cleanly at the bound (#181): it finished the op in flight, flushed what
 * it had staged, and counted the rest. This is the message a slow ingest should normally end
 * with — every run leaves progress behind, so repeated commits converge instead of repeating
 * the same unfinished work forever.
 */
export function partialCaptureMessage(phase: "pre-commit" | "post-merge", ms: number, capturedOps: number, remaining: number): string {
  return (
    `avcs: ${phase} exceeded ${ms}ms and stopped at an op boundary — git proceeds; ${capturedOps} operation(s) were captured and are durable, ${remaining} change(s) were not reached (#181).\n` +
    `  This commit carries no AVCS checkpoint or trailer. The next commit (or \`avcs git-sync -m "<message>"\`) continues from here, not from zero.\n` +
    `  AVCS_HOOK_TIMEOUT_MS=0 finishes in one go; a larger value raises the bound.`
  );
}

/**
 * The hard deadline fired: the capture could not stop cooperatively (a store lock, a
 * synchronous section) and the process is exiting under it. The capture stages its writes
 * (`store.batched`), so nothing it had authored survives — say so; the old wording promised
 * the opposite (#156, #181).
 */
export function preCommitTimeoutMessage(ms: number): string {
  return (
    `avcs: pre-commit exceeded ${ms}ms and could not stop cleanly — git proceeds, but this commit carries no AVCS checkpoint or trailer (#33).\n` +
    `  Nothing from this capture is on disk: a capture stages its writes and flushes at the end, and the end was not reached.\n` +
    `  Bring the store level again with:  avcs git-sync -m "<message>"\n` +
    `  AVCS_HOOK_TIMEOUT_MS=0 waits instead of giving up; a larger value raises the bound.`
  );
}

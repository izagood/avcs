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

/** The ingest ran and was cut off partway: some of it is on disk, the rest is not. */
export function preCommitTimeoutMessage(ms: number): string {
  return (
    `avcs: pre-commit exceeded ${ms}ms — git proceeds, but this commit carries no AVCS checkpoint or trailer (#33).\n` +
    `  Whatever the ingest had captured stays in the store; the checkpoint and the commit↔checkpoint link were not written.\n` +
    `  Bring the store level again with:  avcs git-sync -m "<message>"\n` +
    `  AVCS_HOOK_TIMEOUT_MS=0 waits instead of giving up; a larger value raises the bound.`
  );
}

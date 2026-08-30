// The machine-level private keystore (issue #98).
//
// An actor identity belongs to a person and a MACHINE, not to a checkout — the way
// ~/.ssh, ~/.gnupg and ~/.config/gh each hold one credential that every repository on the
// box uses. avcs stored private keys per repository instead (`<store>/private/`), and that
// is what created the clone bootstrap problem in #58: signing needs a key in the target
// repo, and `clone` is the command that CREATES the target repo. #58 closed by adding
// `clone --key`, a flag whose whole job is to carry a credential across a boundary that
// should not exist. Holding the identity at machine scope removes the boundary instead.
//
// Per-repo storage also duplicated key material into every checkout: N copies to protect,
// N places to rotate, and no single answer to "what can this machine sign as?" — while
// `avcs key ls` printed "signable on this machine" the whole time.
//
// NOT to be confused with the shared build cache of docs/21, which deliberately avoids
// $HOME because a cache is shared between machines by design. Key material is the opposite:
// machine-scoped by nature, and it must never be on a shared path.

import { homedir } from "node:os";
import { join } from "node:path";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

/** The on-disk shape of a key file, identical in both keystores so a file copied from one
 *  to the other (or handed to another machine) loads unchanged. */
export interface KeyFile {
  actorId: string;
  privateKey: string;
  /** The actor's kind, when the writer knew it. Absent in files written before #98; readers
   *  fall back to the id prefix, which is what the CLI already does. */
  actorKind?: "human" | "ai_agent" | "ci_bot";
}

/**
 * avcs' machine-level config home, resolved at CALL time so a CI job — or a test, which
 * must never touch the developer's real credential store — can repoint it per process:
 *
 *   1. `$AVCS_CONFIG_HOME` — explicit override.
 *   2. `$XDG_CONFIG_HOME/avcs` — the platform convention, when the user has opted into it.
 *   3. `~/.avcs` — the default, alongside ~/.ssh and ~/.gnupg.
 */
/**
 * Which test runner, if any, this process is under — or `null` for ordinary use.
 *
 * This is a denylist and cannot be complete; a runner not listed here still reaches the
 * `$HOME` fallback. That is accepted deliberately: the alternative is refusing by default and
 * breaking every real invocation of the CLI, which is the far worse failure. The list covers
 * what actually bit us —
 *
 *   - `node --test` sets NODE_TEST_CONTEXT (avcs' own suite)
 *   - vitest sets VITEST (avcshub's suite — 11 fixture keys reached a real `~/.avcs` this way,
 *     and the resulting ambiguity in `localActorId`'s sole-key fallback made the client sign
 *     nothing, so every `POST /objects` came back 401)
 *   - jest sets JEST_WORKER_ID
 *
 * A consumer's own isolation (setting AVCS_CONFIG_HOME in its test setup) is the real
 * protection; this is defence in depth for the case where they have not done it yet.
 */
function testRunner(): string | null {
  if (process.env.NODE_TEST_CONTEXT) return "`node --test`";
  if (process.env.VITEST) return "vitest";
  if (process.env.JEST_WORKER_ID) return "jest";
  return null;
}

export function configHome(): string {
  const explicit = process.env.AVCS_CONFIG_HOME;
  if (explicit) return explicit;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "avcs");
  // Under `node --test` with neither variable set, REFUSE rather than fall back to $HOME
  // (issue #107). The comment above says a test must never touch the developer's real
  // credential store, and `test/_isolate-keystore.ts` upholds that — but only for processes
  // the `npm test` script starts. Running one file the ordinary way drops the harness, and
  // the old fallback then wrote fixtures into `~/.avcs/private/` silently.
  //
  // That is not a tidiness problem. The stray keys survive into later runs, so assertions on
  // an exact signable list begin failing and read as a product regression; and they make
  // `localActorId`'s sole-key fallback ambiguous, which stops `avcs submit` resolving an
  // actor at all. Both happened before this guard existed.
  //
  // A throw here converts a silent, delayed, misattributed failure into an immediate one that
  // names its own fix. Nothing about ordinary use changes: `NODE_TEST_CONTEXT` is set by the
  // Node test runner, so a real invocation of the CLI never reaches this branch.
  const runner = testRunner();
  if (runner) {
    throw new Error(
      `refusing to resolve the machine keystore under ${runner} without AVCS_CONFIG_HOME — ` +
        "it would write credentials into the real store. Set AVCS_CONFIG_HOME to a temp dir " +
        "for the test process (avcs' own suite does this via --import ./test/_isolate-keystore.ts).",
    );
  }
  return join(homedir(), ".avcs");
}

/** The directory holding this machine's PRIVATE keys — one JSON file per actor id.
 *  A `private/` subdirectory rather than the config home itself, so the layout matches
 *  a repo's `<store>/private/` exactly and later machine-level config cannot collide
 *  with an actor id. */
export function machineKeystoreDir(): string {
  return join(configHome(), "private");
}

/**
 * Reject an actor id that cannot be a single filename.
 *
 * Repo-local storage made a traversing id ("../../x") escape a checkout; the keystore is
 * machine-global, so the same id would now escape the user's config home. Actor ids in
 * practice are `kind:name` ("human:h", "ci:bot"), so nothing legitimate is refused.
 */
export function assertKeyFilename(actorId: string): void {
  if (!actorId || actorId === "." || actorId === ".." || /[/\\]/.test(actorId) || actorId.startsWith("-")) {
    throw new Error(`invalid actor id for a key file: ${JSON.stringify(actorId)} — an actor id must be a single path segment`);
  }
}

export function machineKeyPath(actorId: string): string {
  assertKeyFilename(actorId);
  return join(machineKeystoreDir(), `${actorId}.json`);
}

/** Create the keystore with credential modes. `mkdir`'s `mode` is masked by the process
 *  umask and ignored entirely for a directory that already exists, so pin both levels
 *  explicitly — 0700 is part of the contract here, not a nicety. */
export async function ensureKeystoreDir(): Promise<string> {
  const dir = machineKeystoreDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const d of [configHome(), dir]) {
    try {
      await chmod(d, 0o700);
    } catch {
      /* someone else's directory (a shared $XDG_CONFIG_HOME) — the key file's own 0600 still holds */
    }
  }
  return dir;
}

/** Write a private key into the machine keystore, 0600. Returns the path written. */
export async function saveMachineKey(rec: KeyFile): Promise<string> {
  const dir = await ensureKeystoreDir();
  const p = join(dir, `${rec.actorId}.json`);
  assertKeyFilename(rec.actorId);
  await writeFile(p, JSON.stringify(rec), { encoding: "utf8", mode: 0o600 });
  // writeFile's `mode` applies only when it creates the file; an existing file keeps
  // whatever mode it had. Rotation must not leave a credential world-readable.
  await chmod(p, 0o600);
  return p;
}

/** Read a key file from either keystore. Returns null when absent or unparseable — a
 *  corrupt file must not be louder than a missing one, because both mean "cannot sign". */
export async function readKeyFile(path: string): Promise<KeyFile | null> {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<KeyFile>;
    if (typeof parsed.privateKey !== "string" || !parsed.privateKey) return null;
    return { actorId: typeof parsed.actorId === "string" ? parsed.actorId : "", privateKey: parsed.privateKey, actorKind: parsed.actorKind };
  } catch {
    return null;
  }
}

/** The private key this machine holds for `actorId`, or null. */
export async function loadMachineKey(actorId: string): Promise<string | null> {
  try {
    return (await readKeyFile(machineKeyPath(actorId)))?.privateKey ?? null;
  } catch {
    return null; // an id that cannot name a file simply has no key
  }
}

/** Actor ids this machine holds a private key for. Ids only — key material must never
 *  travel with a listing, or `key ls` becomes the disclosure it exists to help avoid. */
export async function listMachineKeys(): Promise<string[]> {
  const dir = machineKeystoreDir();
  if (!existsSync(dir)) return [];
  try {
    return (await readdir(dir))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
  } catch {
    return [];
  }
}

/** Whether the repo→machine migration of #98 is allowed to copy a key out of a checkout.
 *  Off-switchable because moving credentials is something a user must be able to refuse —
 *  on a shared build box, a repo-local CI identity may be deliberately confined there. */
export function adoptionEnabled(): boolean {
  const v = process.env.AVCS_KEYSTORE_ADOPT;
  return !(v === "0" || v === "false");
}

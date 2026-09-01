// issue #162 — `avcs workspace land --help` bound the literal string `--help` as the
// workspace NAME and performed a real land (exit 0, `workspace list` then showing
// `landed --help`). `--help` is what a user types on an unfamiliar destructive subcommand
// precisely BECAUSE they believe it is the safe thing to type, so a CLI that lets it bind
// as a positional turns the safety reflex into the trigger.
//
// Two independent halves, and the tests keep them apart:
//
//   (a) `--help`/`-h` anywhere in the command line is a HELP REQUEST, handled before any
//       positional binds — prints the usage table, exits 0, changes nothing. This is the
//       class-wide half. Its one hard edge is that a help-shaped token which is a FLAG'S
//       VALUE (`commit -m --help`) is a message, not a request, so the scan must know
//       which flags take values.
//   (b) any OTHER `--`-shaped token (`--bogus`) must never bind as a name. This file already
//       has two conventions for that, split by whether the positional is required:
//       a REQUIRED one rejects it with usage (`workspace project`, `shared add`), an OPTIONAL
//       one reads it as "not given" and takes the default (`release`, `materialize`, `log`,
//       and 14 others). `land`, `remote add|rm`, `key provision|import`, `shared rm` (required)
//       and `checkpoint` (optional) were the ones that got neither.
//
// The contract under test is state, not output: a help request must leave nothing behind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** Run the CLI, returning `{ status, out }` — never throwing, so exit codes are assertable. */
function cli(cwd: string, ...a: string[]): { status: number; out: string } {
  try {
    const out = execFileSync(process.execPath, ["--experimental-strip-types", CLI, ...a], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

/** A standalone repo (no git) holding one committed file. */
async function seeded(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-help-pos-"));
  cli(dir, "init", ".");
  await writeFile(join(dir, "f.txt"), "a\n", "utf8");
  cli(dir, "commit", "-m", "initial import");
  return dir;
}

/** The help table's first line — what `avcs --help` prints and nothing else does. */
const HELP = /^avcs <command>/m;

test("`workspace land --help` asks for help: it prints it, exits 0, and lands nothing", async () => {
  const dir = await seeded();
  try {
    const r = cli(dir, "workspace", "land", "--help");
    assert.equal(r.status, 0, `a help request succeeds:\n${r.out}`);
    assert.match(r.out, HELP, `--help must print the usage table:\n${r.out}`);
    // The real contract: no land happened. Output alone would still pass if the command
    // printed help AND landed.
    const list = cli(dir, "workspace", "list");
    assert.doesNotMatch(list.out, /--help/, `nothing may be landed under the name "--help":\n${list.out}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("`checkpoint --help` asks for help: it prints it, exits 0, and freezes nothing", async () => {
  const dir = await seeded();
  try {
    const r = cli(dir, "checkpoint", "--help");
    assert.equal(r.status, 0, `a help request succeeds:\n${r.out}`);
    assert.match(r.out, HELP, `--help must print the usage table:\n${r.out}`);
    // `checkpoint <view>` writes `checkpoint:<view>:latest`, a flat file under .avcs/refs.
    assert.equal(
      existsSync(join(dir, ".avcs", "refs", "checkpoint:--help:latest")),
      false,
      'no checkpoint may be created on a view named "--help"',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("`-h` is the same request as `--help`", async () => {
  const dir = await seeded();
  try {
    const r = cli(dir, "workspace", "land", "-h");
    assert.equal(r.status, 0, `-h succeeds:\n${r.out}`);
    assert.match(r.out, HELP, `-h must print the usage table:\n${r.out}`);
    const list = cli(dir, "workspace", "list");
    assert.doesNotMatch(list.out, /-h\b/, `nothing may be landed under the name "-h":\n${list.out}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a help-shaped token that is a flag's VALUE stays a value", async () => {
  const dir = await seeded();
  try {
    await writeFile(join(dir, "f.txt"), "a\nb\n", "utf8");
    // `-m --help` is a commit message, not a help request: the scan must skip the value
    // slot of every value-taking flag, or this command silently stops committing.
    const r = cli(dir, "commit", "-m", "--help");
    assert.equal(r.status, 0, `commit -m --help must still commit:\n${r.out}`);
    assert.doesNotMatch(r.out, HELP, `-m's value must not be read as a help request:\n${r.out}`);
    const log = cli(dir, "log");
    assert.match(log.out, /--help/, `the message "--help" must be recorded:\n${log.out}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// (b) — any other `--`-shaped token in a required positional slot is a usage error.
// These never reach the help path, so they exercise the per-subcommand guard alone.
const FLAG_SHAPED: Array<{ argv: string[]; usage: RegExp }> = [
  { argv: ["workspace", "land", "--bogus"], usage: /usage: avcs workspace land/ },
  { argv: ["remote", "add", "--bogus", "http://example.invalid"], usage: /usage: avcs remote add/ },
  { argv: ["remote", "rm", "--bogus"], usage: /usage: avcs remote rm/ },
  { argv: ["key", "provision", "--bogus"], usage: /usage: avcs key provision/ },
  { argv: ["key", "import", "--bogus"], usage: /usage: avcs key import/ },
  { argv: ["shared", "rm", "--bogus"], usage: /usage: avcs shared rm/ },
];

for (const { argv, usage } of FLAG_SHAPED) {
  test(`\`avcs ${argv.join(" ")}\` is a usage error, not a name`, async () => {
    const dir = await seeded();
    try {
      const r = cli(dir, ...argv);
      assert.equal(r.status, 1, `a flag in a name slot must fail:\n${r.out}`);
      assert.match(r.out, usage, `it must say what the command actually takes:\n${r.out}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("`checkpoint --bogus` freezes the default view, never a view named for the flag", async () => {
  // `checkpoint [view]` takes an OPTIONAL positional, so the file's convention for that case
  // applies: a `--`-shaped token means "no view was given" and the default stands. What must
  // not survive is the flag becoming a view NAME — that is the binding issue #162 is about.
  const dir = await seeded();
  try {
    const r = cli(dir, "checkpoint", "--bogus");
    assert.equal(r.status, 0, `an unknown flag does not break the default:\n${r.out}`);
    assert.equal(
      existsSync(join(dir, ".avcs", "refs", "checkpoint:--bogus:latest")),
      false,
      'no checkpoint may be created on a view named "--bogus"',
    );
    assert.equal(
      existsSync(join(dir, ".avcs", "refs", "checkpoint:main:latest")),
      true,
      "the default view is what got frozen",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("every value-taking flag is registered, so the help scan cannot silently rot", async () => {
  // The help scan skips the token after a value-taking flag. A flag added later and not
  // registered would make `… --new-flag --help` print help instead of passing the value —
  // a regression no feature test would catch, because it is about a flag that does not
  // exist yet. So the registry is checked against the source that uses it.
  const src = await readFile(CLI, "utf8");
  const decl = /const VALUED_FLAGS = new Set\(\[([^\]]*)\]\)/.exec(src);
  assert.ok(decl, "cli.ts must declare a module-level VALUED_FLAGS set");
  const registered = new Set([...(decl[1] as string).matchAll(/"(-{1,2}[a-z-]+)"/g)].map((m) => m[1] as string));
  const used = new Set(
    [...src.matchAll(/\b(?:flag|valueFlag)\("(-{1,2}[a-z-]+)"/g)].map((m) => m[1] as string),
  );
  const missing = [...used].filter((f) => !registered.has(f)).sort();
  assert.deepEqual(missing, [], `these flags take a value but are not in VALUED_FLAGS: ${missing.join(", ")}`);
});

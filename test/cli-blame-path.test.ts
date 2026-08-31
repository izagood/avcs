// `avcs blame src/math.js` — 접두사 없는 경로는 모든 git 사용자가 처음 치는 형태다 (issue #117).
//
// 종전에는 엔티티 키의 `file:` 접두사를 그대로 요구했고, 빠뜨리면 아무 단서 없는
// "no owner (entity not present)" 로 끝났다. 여기서 검증하는 계약:
//   1) kind 접두사 없는 인자가 추적 중인 파일과 일치하면 `file:<path>` 로 자동 승격된다
//   2) `--line` 을 함께 줘도 같은 승격이 적용된다
//   3) 어느 엔티티와도 일치하지 않으면 `file:` 접두사를 가리키는 실행 가능한 에러가 난다
//   4) 명시적 `file:` 키는 종전 그대로 동작한다
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

async function seeded(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-blame-path-"));
  cli(dir, "init", ".");
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "math.js"), "export const x = 1;\n", "utf8");
  cli(dir, "commit", "-m", "seed src/math.js");
  return dir;
}

test("접두사 없는 추적 경로는 file: 엔티티로 승격된다", async () => {
  const dir = await seeded();
  try {
    const explicit = cli(dir, "blame", "file:src/math.js");
    assert.equal(explicit.status, 0, `기준선인 명시적 키가 실패한다:\n${explicit.out}`);
    assert.doesNotMatch(explicit.out, /no owner/, `기준선이 소유자를 못 찾는다:\n${explicit.out}`);

    const bare = cli(dir, "blame", "src/math.js");
    assert.equal(bare.status, 0, `접두사 없는 경로가 실패하면 안 된다:\n${bare.out}`);
    assert.equal(bare.out, explicit.out, "승격된 결과는 명시적 키의 결과와 같아야 한다");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("`--line` 경로에서도 같은 승격이 적용된다", async () => {
  const dir = await seeded();
  try {
    const r = cli(dir, "blame", "src/math.js", "--line", "main");
    assert.equal(r.status, 0, `--line 과 함께여도 승격돼야 한다:\n${r.out}`);
    assert.doesNotMatch(r.out, /no owner/, `소유자를 찾아야 한다:\n${r.out}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("어떤 엔티티와도 일치하지 않으면 file: 접두사를 알려주는 에러가 난다", async () => {
  const dir = await seeded();
  try {
    const r = cli(dir, "blame", "src/missing.js");
    assert.notEqual(r.status, 0, `없는 경로는 조용히 0으로 끝나면 안 된다:\n${r.out}`);
    assert.match(r.out, /did you mean 'file:src\/missing\.js'\?/, `조치 가능한 힌트가 있어야 한다:\n${r.out}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("명시적 file: 키의 미존재 엔티티는 종전 메시지를 유지한다", async () => {
  const dir = await seeded();
  try {
    const r = cli(dir, "blame", "file:src/missing.js");
    assert.equal(r.status, 0, `명시적 키의 종전 동작이 바뀌면 안 된다:\n${r.out}`);
    assert.match(r.out, /no owner \(entity not present\)/, `종전 메시지를 유지해야 한다:\n${r.out}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

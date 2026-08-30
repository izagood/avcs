// `--at` 이 값 없이 주어졌을 때 CLI 가 조용히 head 로 떨어지지 않는다.
//
// 코어에서는 이미 막아 뒀다 — 나쁜 체크포인트 oid 는 던진다. 이유는 명확했다: 조용한 폴백은
// 이 기능을 무의미하게 만든다. 잡은 자기가 옛 트리를 받았다고 믿고 최신 트리를 검사하며,
// 그 결과가 evidence 로 원래 체크포인트에 결속된다.
//
// 그런데 CLI 층에 정확히 그 폴백이 남아 있었다. `flag("--at")` 이 값을 못 찾으면 `undefined`
// 를 돌려주고 `at ? { at } : undefined` 가 그것을 그대로 통과시킨다. 코어에 세운 규칙이
// 한 겹 위에서 무너지는 자리다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  const dir = await mkdtemp(join(tmpdir(), "avcs-at-cli-"));
  cli(dir, "init", ".");
  await writeFile(join(dir, "a.txt"), "v1\n", "utf8");
  cli(dir, "commit", "-m", "v1");
  return dir;
}

test("`--at` 에 값이 없으면 실패한다 — 조용히 head 를 쓰지 않는다", async () => {
  const dir = await seeded();
  try {
    const r = cli(dir, "checkout", "main", "--at");
    assert.notEqual(r.status, 0, `종료 코드가 0이면 안 된다:\n${r.out}`);
    assert.match(r.out, /--at/, `무엇이 잘못됐는지 말해야 한다:\n${r.out}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("`--at` 뒤에 다른 플래그가 오면 그것을 체크포인트로 오해하지 않는다", async () => {
  const dir = await seeded();
  try {
    const r = cli(dir, "checkout", "main", "--at", "--workspace");
    assert.notEqual(r.status, 0, `플래그를 oid 로 삼키면 안 된다:\n${r.out}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 회귀 방지: `--at` 없는 평범한 체크아웃은 그대로다.
test("`--at` 없는 checkout 은 예전 그대로", async () => {
  const dir = await seeded();
  try {
    const r = cli(dir, "checkout", "main");
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /checked out/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 존재하지 않는 체크포인트는 코어가 이미 던진다 — CLI 가 그것을 삼키지 않는지 확인한다.
test("없는 체크포인트를 주면 실패가 사용자에게 보인다", async () => {
  const dir = await seeded();
  try {
    const r = cli(dir, "checkout", "main", "--at", "0".repeat(64));
    assert.notEqual(r.status, 0, `코어가 던진 것을 CLI 가 삼키면 안 된다:\n${r.out}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

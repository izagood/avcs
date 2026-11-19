// 적합성 스위트의 하네스 — **부착 지점**이 계약이다.
//
// 지금 hub 테스트 14개는 `startHub()` 를 직접 부른다. 그건 "참조 구현이 맞게 동작하는가" 를
// 재는 것이고, 제3자가 "내 서버가 호환인가" 를 물을 방법이 없다.
//
// 다만 14개를 그대로 옮길 수는 없다. 7개는 서버 옵션(`gated`·`auth`·`rateLimit`·
// `resolvePublicKey`)을 켜고 끄며 검증하므로 외부 URL 로는 불가능하다 — 그건 참조 서버의
// **옵션**을 재는 테스트이고 프로토콜을 재는 게 아니다. 적합성 스위트는 14개의 변환이 아니라
// **프로토콜 관측 가능한 것만의 부분집합**이다.
//
// 그래서 하네스의 계약은 둘이다:
//   ① URL 을 받으면 그 서버를 잰다.
//   ② 안 받으면 참조 구현을 띄워 잰다 — 그래야 기존 커버리지가 그대로 유지되고,
//      스위트 자체가 CI 에서 계속 검증된다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { openTarget, parseBin, LEVELS, type Level } from "./target.ts";

/** env 주입(URL·실행 파일)을 끄고 참조 구현을 연다. 스위트를 외부 대상으로 돌릴 때도 이
 *  자기검증들은 "참조 구현" 자체를 재야 하므로 — 끄지 않으면 자기모순이 된다. */
async function openReference(): ReturnType<typeof openTarget> {
  return openWithoutEnv();
}

/** env 주입을 끈 채로 openTarget — 자기검증이 스위트 실행 대상(URL·실행 파일)에 끌려가지 않게. */
async function openWithoutEnv(opts?: Parameters<typeof openTarget>[0]): ReturnType<typeof openTarget> {
  const keys = ["AVCS_CONFORMANCE_URL", "AVCS_CONFORMANCE_BIN", "AVCS_CONFORMANCE_BIN_ARGS"] as const;
  const saved = keys.map((k) => process.env[k]);
  for (const k of keys) delete process.env[k];
  try {
    return await openTarget(opts);
  } finally {
    keys.forEach((k, i) => { if (saved[i] !== undefined) process.env[k] = saved[i]; });
  }
}

/** TS 참조 CLI 를 "외부 실행 파일" 로 본다 — 다른 언어 구현이 꽂힐 자리와 같은 경로로 띄운다. */
const TS_CLI: string[] = [
  process.execPath, "--experimental-strip-types",
  fileURLToPath(new URL("../../src/cli.ts", import.meta.url)),
];

test("URL 을 주면 그 서버를 잰다 — 참조 구현을 띄우지 않는다", async () => {
  const t = await openTarget({ url: "http://127.0.0.1:9/acme/web" });
  try {
    assert.equal(t.base, "http://127.0.0.1:9/acme/web");
    assert.equal(t.spawned, false, "URL 을 줬으면 서버를 띄워선 안 된다");
  } finally {
    await t.close();
  }
});

test("URL 이 없으면 참조 구현을 띄운다 — 기존 커버리지가 유지된다", async () => {
  // 이 자기검증은 "URL 없음" 조건 자체를 재므로 env 기본값을 명시적으로 끈다 — 스위트를
  // AVCS_CONFORMANCE_URL 로 외부 서버에 돌리면 env 가 여기까지 주입되어 자기모순이 된다.
  // 실제로 첫 외부 실행(제3 구현)이 이 버그를 찾았다.
  const t = await openReference();
  try {
    assert.equal(t.spawned, true, "URL 이 없으면 참조 구현을 띄워야 한다");
    assert.match(t.base, /^http:\/\/127\.0\.0\.1:\d+$/);
    const r = await fetch(`${t.base}/have`);
    assert.equal(r.status, 200, "띄운 서버가 실제로 응답해야 한다");
  } finally {
    await t.close();
  }
});

test("레벨은 누적이다 — 상위가 하위를 포함한다", () => {
  assert.deepEqual(LEVELS, ["core", "sync", "governance", "queue"]);
  // 누적이 아니면 "queue 통과" 가 "core 통과" 를 뜻하지 않게 되고, 배지가 의미를 잃는다.
  const idx = (l: Level): number => LEVELS.indexOf(l);
  assert.ok(idx("core") < idx("sync"));
  assert.ok(idx("sync") < idx("governance"));
  assert.ok(idx("governance") < idx("queue"));
});

test("서버가 광고하지 않는 능력의 레벨은 건너뛴다 — 실패가 아니다", async () => {
  // 부분 구현 서버가 1급 시민이라는 것이 프로토콜의 약속이다(docs/26 §0). 스위트가 그것을
  // 실패로 처리하면 약속을 어기는 쪽이 스위트가 된다.
  // "참조 구현은 전부 켜져 있다" 를 재므로 env 주입을 끈다 (위 테스트와 같은 이유).
  const t = await openReference();
  try {
    const caps = await t.capabilities();
    assert.equal(typeof caps.batch, "boolean");
    assert.equal(typeof caps.integrate, "boolean");
    // 참조 구현은 전부 켜져 있으므로 어느 레벨도 건너뛰지 않는다.
    assert.deepEqual(await t.applicableLevels(), LEVELS);
  } finally {
    await t.close();
  }
});

test("능력을 광고하지 않는 서버는 상위 레벨이 적용 대상에서 빠진다", async () => {
  // /version 이 없는 서버를 흉내낸다 — 클라이언트가 모든 능력을 off 로 가정하는 그 상황.
  const t = await openTarget({ url: "http://127.0.0.1:9", capabilitiesOverride: {} });
  try {
    assert.deepEqual(
      await t.applicableLevels(), ["core"],
      "능력 광고가 없으면 core 만 적용된다 — 나머지는 실패가 아니라 미적용이다",
    );
  } finally {
    await t.close();
  }
});

test("게이트된 서버: 자격 env 가 있으면 쓰기 검사가 실제로 잰다 — 없으면 401 조기 반환 경로", async () => {
  // 참조 구현을 gated 로 띄우고 멤버 키를 등록한 뒤, writeHeaders 로 서명해 밀어 본다.
  // 이것이 초록이어야 "스위트가 게이트된 상용 배포도 잴 수 있다" 가 성립한다.
  const { generateKeypair } = await import("../../src/core/identity.ts");
  const { ObjectStore } = await import("../../src/store/objectStore.ts");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { startHub } = await import("../../src/hub/hubServer.ts");
  const { writeHeaders } = await import("./target.ts");

  const dir = await mkdtemp(join(tmpdir(), "avcs-conf-gated-"));
  const kp = generateKeypair();
  const store = new ObjectStore(dir);
  await store.init();
  const memberOid = await store.put({ type: "membership", actorId: "human:ci", role: "maintainer", status: "active", publicKey: kp.publicKey, grantedBy: "human:ci", grantedAt: new Date().toISOString() } as never);
  await store.setRef("member:human:ci", memberOid);
  const hub = await startHub({ repoDir: dir, gated: true, auth: { required: true } });

  const saved = {
    keyId: process.env.AVCS_CONFORMANCE_KEYID,
    key: process.env.AVCS_CONFORMANCE_PRIVATE_KEY,
    file: process.env.AVCS_CONFORMANCE_PRIVATE_KEY_FILE,
  };
  try {
    const body = JSON.stringify({ type: "intent", title: "gated write", owner: "human:ci", status: "open" });

    // 음성 대조 — 자격 없이 밀면 401 (쓰기 검사들이 조기 반환하는 바로 그 경로)
    delete process.env.AVCS_CONFORMANCE_KEYID;
    delete process.env.AVCS_CONFORMANCE_PRIVATE_KEY;
    delete process.env.AVCS_CONFORMANCE_PRIVATE_KEY_FILE;
    const bare = await fetch(`${hub.url}/objects`, { method: "POST", headers: writeHeaders(hub.url, "POST", "/objects", body), body });
    assert.equal(bare.status, 401, "자격 없는 쓰기는 401 — 조기 반환 경로");

    // 양성 — env 자격으로 서명하면 잰다
    process.env.AVCS_CONFORMANCE_KEYID = "human:ci";
    process.env.AVCS_CONFORMANCE_PRIVATE_KEY = kp.privateKey;
    const signed = await fetch(`${hub.url}/objects`, { method: "POST", headers: writeHeaders(hub.url, "POST", "/objects", body), body });
    assert.equal(signed.status, 200, `서명된 쓰기는 저장돼야 한다: ${await signed.clone().text()}`);
  } finally {
    if (saved.keyId === undefined) delete process.env.AVCS_CONFORMANCE_KEYID; else process.env.AVCS_CONFORMANCE_KEYID = saved.keyId;
    if (saved.key === undefined) delete process.env.AVCS_CONFORMANCE_PRIVATE_KEY; else process.env.AVCS_CONFORMANCE_PRIVATE_KEY = saved.key;
    if (saved.file === undefined) delete process.env.AVCS_CONFORMANCE_PRIVATE_KEY_FILE; else process.env.AVCS_CONFORMANCE_PRIVATE_KEY_FILE = saved.file;
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("확장은 사다리 밖이다 — 레벨 순서에 참여하지 않고 플래그가 켜져 있을 때만 잰다", async () => {
  const { EXTENSIONS } = await import("./target.ts");
  assert.deepEqual(Object.keys(EXTENSIONS), ["reduced"]);
  // 참조 구현은 reduced 를 광고한다 → 확장 적용, 레벨 결과는 불변.
  const t = await openReference();
  try {
    assert.deepEqual(await t.applicableExtensions(), ["reduced"]);
    assert.deepEqual(await t.applicableLevels(), LEVELS, "확장을 더해도 레벨은 그대로다");
  } finally { await t.close(); }
});

test("reduced 를 광고하지 않는 서버는 확장이 빠질 뿐 레벨은 유지된다", async () => {
  const t = await openTarget({ url: "http://127.0.0.1:9", capabilitiesOverride: { batch: true, integrate: true, events: true } });
  try {
    assert.deepEqual(await t.applicableExtensions(), []);
  } finally { await t.close(); }
});

// ── 실행 파일 대상 (R0) ─────────────────────────────────────────────────────────
test("실행 파일을 주면 그것을 띄워 잰다 — 참조 구현을 in-process 로 띄우지 않는다", async () => {
  const t = await openWithoutEnv({ bin: TS_CLI, binArgs: "serve {dir} --port {port} --quiet" });
  try {
    assert.equal(t.kind, "binary");
    assert.equal(t.spawned, true);
    assert.match(t.base, /^http:\/\/127\.0\.0\.1:\d+$/);
    const r = await fetch(`${t.base}/have`);
    assert.equal(r.status, 200, "띄운 실행 파일이 실제로 응답해야 한다");
    assert.deepEqual(await t.applicableLevels(), LEVELS, "참조 CLI 를 실행 파일로 띄워도 전 레벨이 적용된다");
  } finally {
    await t.close();
  }
  // close 뒤에는 포트가 닫혀야 한다 — 남은 프로세스가 다음 실행을 오염시키지 않게.
  await assert.rejects(fetch(`${t.base}/have`));
});

test("URL 이 실행 파일보다 우선한다", async () => {
  const t = await openTarget({ url: "http://127.0.0.1:9/x", bin: ["/nonexistent"] });
  try {
    assert.equal(t.kind, "url");
    assert.equal(t.spawned, false);
  } finally {
    await t.close();
  }
});

test("실행 파일이 뜨지 못하면 그 출력과 함께 실패한다 — 조용히 참조 구현으로 넘어가지 않는다", async () => {
  await assert.rejects(
    openWithoutEnv({ bin: [process.execPath, "-e", "console.error('boom'); process.exit(3)"], binArgs: "", startTimeoutMs: 5000 }),
    /exit 3[\s\S]*boom/,
  );
});

test("AVCS_CONFORMANCE_BIN 은 공백 문자열과 JSON 배열 둘 다 받는다", () => {
  assert.deepEqual(parseBin("/usr/local/bin/avcs-rs"), ["/usr/local/bin/avcs-rs"]);
  assert.deepEqual(parseBin("node --experimental-strip-types src/cli.ts"), ["node", "--experimental-strip-types", "src/cli.ts"]);
  assert.deepEqual(parseBin('["/opt/my avcs/bin", "--flag"]'), ["/opt/my avcs/bin", "--flag"]);
  assert.throws(() => parseBin("   "));
});

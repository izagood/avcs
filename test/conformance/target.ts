// 적합성 스위트가 재는 **대상**. URL 을 받으면 그 서버, 실행 파일을 받으면 그것을 띄운 서버,
// 둘 다 없으면 참조 구현.
//
// 실행 파일 대상(R0): 다른 언어로 만든 구현(예: Rust 바이너리)을 **같은 스위트**로 재려면
// 사람이 서버를 먼저 띄워 URL 을 넘기는 대신 스위트가 직접 띄워야 CI 한 줄로 끝난다.
//   AVCS_CONFORMANCE_BIN=/path/to/avcs npm run conformance
// 스위트는 빈 임시 디렉터리와 빈 포트를 골라 `<bin> serve <dir> --port <port>` 로 띄우고
// (avcs CLI 의 serve 계약), GET /have 가 200 을 줄 때까지 기다린 뒤 잰다. 인자 모양이 다른
// 구현은 AVCS_CONFORMANCE_BIN_ARGS 로 바꾼다(`{dir}`·`{port}` 자리표시자).
//
// 왜 이 파일이 따로 있나: 지금 hub 테스트는 `startHub()` 를 직접 부르므로 제3자가 자기 서버를
// 그 자리에 꽂을 수 없다. 부착 지점을 함수에서 URL 로 옮기는 것이 이 스위트의 전부다 —
// 테스트가 재는 내용은 바뀌지 않는다.
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { buildAuthHeader } from "../../src/hub/transportAuth.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHub, type HubHandle } from "../../src/hub/hubServer.ts";

/**
 * 적합성 레벨. **누적**이다 — 상위가 하위를 포함한다. 누적이 아니면 "queue 통과" 가
 * "core 통과" 를 뜻하지 않게 되고 배지가 의미를 잃는다.
 *
 *   core        필수 3개 (docs/25 §0). 이것만으로 클론이 된다.
 *   sync        + 증분 발견과 배치 전송
 *   governance  + 거버넌스 ref 배포와 head 전진
 *   queue       + 통합 큐와 라이브 이벤트
 */
export const LEVELS = ["core", "sync", "governance", "queue"] as const;
export type Level = (typeof LEVELS)[number];

/** 각 레벨이 요구하는 능력 플래그. `core` 는 아무 광고도 요구하지 않는다. */
const LEVEL_CAPS: Record<Level, readonly string[]> = {
  core: [],
  sync: ["batch"],
  governance: [],
  queue: ["integrate", "events"],
};

/** 레벨이 요구하는, 광고와 무관한 엔드포인트. 광고 플래그가 없는 것들이 여기 온다. */
const LEVEL_PROBES: Record<Level, readonly string[]> = {
  core: [],
  sync: ["/sync"],
  governance: ["/refs"],
  queue: [],
};

/**
 * 사다리 **밖**의 능력(docs/27 §5). 레벨은 누적이라 "queue 통과 = core 통과" 가 성립하지만,
 * 서로 독립인 능력은 그 순서에 끼울 자리가 없다 — 끝에 두면 통합 큐 없는 미러가 도달하지
 * 못하고, 중간에 두면 오늘 queue 인 서버가 강등된다. 그래서 확장은 자기 플래그가 참일 때만
 * 재고, 어느 레벨의 결과도 바꾸지 않는다. 배지는 `queue +reduced` 로 읽는다.
 */
export const EXTENSIONS = {
  reduced: { caps: ["reduced"] as readonly string[] },
} as const;
export type Extension = keyof typeof EXTENSIONS;

export interface Capabilities {
  batch?: boolean;
  integrate?: boolean;
  events?: boolean;
  reduced?: boolean;
  reducedTreeMaxEntries?: number;
  auth?: string;
  protocol?: number;
  [k: string]: unknown;
}

export interface Target {
  /** 프로토콜 경로가 붙는 접두사. 서버가 정한다(docs/25 §1). */
  readonly base: string;
  /** 서버를 우리가 띄웠는가(참조 구현이든 실행 파일이든). URL 을 받았으면 false. */
  readonly spawned: boolean;
  /** 무엇을 재는가 — 받은 URL / 띄운 실행 파일 / 참조 구현. */
  readonly kind: "url" | "binary" | "reference";
  capabilities(): Promise<Capabilities>;
  /** 이 서버에 실제로 적용되는 레벨. 광고하지 않는 능력의 레벨은 **미적용**이다 — 실패가 아니다.
   *  부분 구현 서버가 1급 시민이라는 것이 프로토콜의 약속이므로(docs/25 §0), 스위트가 그것을
   *  실패로 처리하면 약속을 어기는 쪽이 스위트가 된다. */
  applicableLevels(): Promise<Level[]>;
  /** 적용되는 확장. 광고하지 않으면 빠진다 — 실패가 아니다. 레벨과 독립이다(docs/27 §5). */
  applicableExtensions(): Promise<Extension[]>;
  close(): Promise<void>;
}

export interface OpenOpts {
  /** 잴 서버. 생략하면 참조 구현을 띄운다. `AVCS_CONFORMANCE_URL` 이 기본값이 된다. */
  url?: string;
  /** 띄워서 잴 실행 파일. 문자열(공백으로 나눔) 또는 argv 배열. `AVCS_CONFORMANCE_BIN` 이 기본값.
   *  url 이 있으면 무시한다. */
  bin?: string | readonly string[];
  /** 실행 파일 인자 틀. 기본 `serve {dir} --port {port}`. `AVCS_CONFORMANCE_BIN_ARGS` 가 기본값. */
  binArgs?: string;
  /** 실행 파일이 응답할 때까지 기다릴 시간(ms). 기본 15초. */
  startTimeoutMs?: number;
  /** 테스트에서 능력 광고를 흉내낼 때만. 실제 사용에서는 쓰지 않는다. */
  capabilitiesOverride?: Capabilities;
}

/**
 * 쓰기 요청 헤더. 게이트된 서버(쓰기에 AVCS-Sig 요구)를 재려면 자격을 환경으로 준다:
 *
 *   AVCS_CONFORMANCE_KEYID=human:ci
 *   AVCS_CONFORMANCE_PRIVATE_KEY=<PEM>            (또는)
 *   AVCS_CONFORMANCE_PRIVATE_KEY_FILE=<PEM 경로>
 *
 * 없으면 헤더 없이 나간다 — 그때 게이트된 서버의 쓰기 검사는 401/403 을 만나 조기
 * 반환한다(측정하지 않음, 실패도 아님). 자격이 있으면 그 검사들이 실제로 잰다.
 * 서명은 클라이언트가 보내는 것과 같은 재료다: 메서드·프로토콜 경로·본문, 그리고
 * base URL 의 경로를 scope 로(멀티테넌트 서버에서 다른 repo 로의 재생을 막는 그 값).
 */
export function writeHeaders(base: string, method: string, path: string, body: string): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const keyId = process.env.AVCS_CONFORMANCE_KEYID;
  let privateKey = process.env.AVCS_CONFORMANCE_PRIVATE_KEY;
  const file = process.env.AVCS_CONFORMANCE_PRIVATE_KEY_FILE;
  if (!privateKey && file) privateKey = readFileSync(file, "utf8");
  if (keyId && privateKey) {
    const scope = new URL(base).pathname.replace(/\/$/, "");
    headers.authorization = buildAuthHeader({
      keyId, privateKey, method, path, body,
      scope: scope === "/" ? "" : scope,
    });
  }
  return headers;
}

/** `AVCS_CONFORMANCE_BIN` 의 두 모양: JSON argv 배열(경로에 공백이 있을 때) 또는 공백으로 나눈 문자열. */
export function parseBin(bin: string | readonly string[]): string[] {
  if (Array.isArray(bin)) return [...bin];
  const s = (bin as string).trim();
  if (s.startsWith("[")) {
    const arr = JSON.parse(s) as unknown;
    if (!Array.isArray(arr) || arr.length === 0 || !arr.every((x) => typeof x === "string")) {
      throw new Error("AVCS_CONFORMANCE_BIN: JSON 이면 비지 않은 문자열 배열이어야 한다");
    }
    return arr as string[];
  }
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 0) throw new Error("AVCS_CONFORMANCE_BIN 이 비었다");
  return parts;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** 실행 파일을 띄우고 GET /have 가 200 을 줄 때까지 기다린다. 먼저 죽으면 그 출력과 함께 실패한다. */
async function spawnBinary(
  argv: string[], argsTemplate: string, dir: string, timeoutMs: number,
): Promise<{ child: ChildProcess; base: string }> {
  const port = await freePort();
  const args = argsTemplate.split(/\s+/).filter(Boolean)
    .map((a) => a.replaceAll("{dir}", dir).replaceAll("{port}", String(port)));
  const child = spawn(argv[0]!, [...argv.slice(1), ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  const keep = (b: Buffer): void => { out = (out + b.toString("utf8")).slice(-4000); };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  let exited: string | null = null;
  child.once("exit", (code, sig) => { exited = `exit ${code ?? sig}`; });
  child.once("error", (e) => { exited = `spawn error: ${e.message}`; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) break;
    try {
      const res = await fetch(`${base}/have`);
      if (res.status === 200) return { child, base };
    } catch {
      /* 아직 안 떴다 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill("SIGKILL");
  throw new Error(
    `conformance 대상 실행 파일이 ${exited ?? `${timeoutMs}ms 안에 응답하지 않았다`}: ` +
      `${[argv[0], ...argv.slice(1), ...args].join(" ")}\n--- 출력 ---\n${out}`,
  );
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise<void>((r) => child.once("exit", () => r()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  await done;
  clearTimeout(timer);
}

export async function openTarget(opts: OpenOpts = {}): Promise<Target> {
  const url = opts.url ?? process.env.AVCS_CONFORMANCE_URL;
  const bin = url ? undefined : (opts.bin ?? process.env.AVCS_CONFORMANCE_BIN);
  let hub: HubHandle | null = null;
  let child: ChildProcess | null = null;
  let dir: string | null = null;
  let base: string;

  if (url) {
    base = url.replace(/\/$/, "");
  } else if (bin) {
    dir = await mkdtemp(join(tmpdir(), "avcs-conf-bin-"));
    const tmpl = opts.binArgs ?? process.env.AVCS_CONFORMANCE_BIN_ARGS ?? "serve {dir} --port {port}";
    try {
      ({ child, base } = await spawnBinary(parseBin(bin), tmpl, dir, opts.startTimeoutMs ?? 15_000));
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      throw e;
    }
  } else {
    dir = await mkdtemp(join(tmpdir(), "avcs-conf-"));
    hub = await startHub({ repoDir: dir, port: 0 });
    base = hub.url.replace(/\/$/, "");
  }

  let cached: Capabilities | null = opts.capabilitiesOverride ?? null;

  const capabilities = async (): Promise<Capabilities> => {
    if (cached) return cached;
    try {
      const res = await fetch(`${base}/version`);
      // `/version` 이 없어도 된다. 그때 클라이언트는 모든 능력을 off 로 가정하고(docs/25 §3),
      // 스위트도 같은 가정을 해야 한다 — 다르게 가정하면 스위트가 클라이언트보다 엄격해진다.
      cached = res.ok ? ((await res.json()) as Capabilities) : {};
    } catch {
      cached = {};
    }
    return cached;
  };

  /** 광고와 무관한 엔드포인트가 실제로 있는지. 404·405·501 은 "없음" 이다(docs/25 §0). */
  const probe = async (path: string): Promise<boolean> => {
    try {
      const res = await fetch(`${base}${path}`);
      return res.status !== 404 && res.status !== 405 && res.status !== 501;
    } catch {
      return false;
    }
  };

  return {
    base,
    spawned: hub !== null || child !== null,
    kind: url ? "url" : child ? "binary" : "reference",
    capabilities,
    async applicableLevels(): Promise<Level[]> {
      const caps = await capabilities();
      const out: Level[] = [];
      for (const level of LEVELS) {
        const capsOk = LEVEL_CAPS[level].every((c) => caps[c] === true);
        if (!capsOk) break; // 누적이므로 한 레벨이 빠지면 그 위도 빠진다
        let probesOk = true;
        for (const p of LEVEL_PROBES[level]) {
          if (!(await probe(p))) { probesOk = false; break; }
        }
        if (!probesOk) break;
        out.push(level);
      }
      return out;
    },
    async applicableExtensions(): Promise<Extension[]> {
      const caps = await capabilities();
      return (Object.keys(EXTENSIONS) as Extension[]).filter((x) => EXTENSIONS[x].caps.every((c) => caps[c] === true));
    },
    async close(): Promise<void> {
      await hub?.close();
      if (child) await stopChild(child);
      if (dir) await rm(dir, { recursive: true, force: true });
    },
  };
}

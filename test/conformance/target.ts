// 적합성 스위트가 재는 **대상**. URL 을 받으면 그 서버, 없으면 참조 구현.
//
// 왜 이 파일이 따로 있나: 지금 hub 테스트는 `startHub()` 를 직접 부르므로 제3자가 자기 서버를
// 그 자리에 꽂을 수 없다. 부착 지점을 함수에서 URL 로 옮기는 것이 이 스위트의 전부다 —
// 테스트가 재는 내용은 바뀌지 않는다.
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
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

export interface Capabilities {
  batch?: boolean;
  integrate?: boolean;
  events?: boolean;
  auth?: string;
  protocol?: number;
  [k: string]: unknown;
}

export interface Target {
  /** 프로토콜 경로가 붙는 접두사. 서버가 정한다(docs/25 §1). */
  readonly base: string;
  /** 참조 구현을 우리가 띄웠는가. URL 을 받았으면 false. */
  readonly spawned: boolean;
  capabilities(): Promise<Capabilities>;
  /** 이 서버에 실제로 적용되는 레벨. 광고하지 않는 능력의 레벨은 **미적용**이다 — 실패가 아니다.
   *  부분 구현 서버가 1급 시민이라는 것이 프로토콜의 약속이므로(docs/25 §0), 스위트가 그것을
   *  실패로 처리하면 약속을 어기는 쪽이 스위트가 된다. */
  applicableLevels(): Promise<Level[]>;
  close(): Promise<void>;
}

export interface OpenOpts {
  /** 잴 서버. 생략하면 참조 구현을 띄운다. `AVCS_CONFORMANCE_URL` 이 기본값이 된다. */
  url?: string;
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

export async function openTarget(opts: OpenOpts = {}): Promise<Target> {
  const url = opts.url ?? process.env.AVCS_CONFORMANCE_URL;
  let hub: HubHandle | null = null;
  let dir: string | null = null;
  let base: string;

  if (url) {
    base = url.replace(/\/$/, "");
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
    spawned: hub !== null,
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
    async close(): Promise<void> {
      await hub?.close();
      if (dir) await rm(dir, { recursive: true, force: true });
    },
  };
}

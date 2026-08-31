#!/usr/bin/env python3
"""avcs core-level server — stdlib only, one file.

docs/26 §0 이 약속하는 것의 실증: 적합한 서버는 엔드포인트 3개다. 이 파일의 의존은
docs/24(정규 직렬화 계약)와 spec/canonical-vectors.json(골든 벡터)뿐이고, JS 도 avcs
라이브러리도 쓰지 않는다.

    python3 examples/server.py --data ./data --port 8430          # 서버
    python3 examples/server.py --selftest                          # 벡터 자기검증

적합성:  AVCS_CONFORMANCE_URL=http://127.0.0.1:8430 npm run conformance
(/version 이 없으므로 클라이언트도 스위트도 모든 능력을 off 로 가정한다 — core 만 적용.)
"""
import argparse
import hashlib
import json
import os
import re
import sys
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ── 정규 직렬화 (docs/24 §2) ─────────────────────────────────────────────────
# 정체성은 정규 바이트의 sha256 이다. 여기서 참조 구현과 한 바이트라도 갈리면 오류 없이
# 수렴하지 않는다 — 그래서 이 절은 골든 벡터로 검증된다(--selftest).

_ESCAPE = {'"': '\\"', "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t"}
_MAX_INT = 2**53 - 1


def _canon_str(s: str) -> str:
    # JSON 필수 이스케이프만 — 나머지는 UTF-8 그대로. "한글" 을 \uXXXX 로 쓰는 구현은
    # 다른 바이트, 따라서 다른 oid 를 낸다.
    out = ['"']
    for ch in s:
        if ch in _ESCAPE:
            out.append(_ESCAPE[ch])
        elif ord(ch) < 0x20:
            out.append(f"\\u{ord(ch):04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _assert_interop(v, path="$"):
    # 상호운용 안전 부분집합 (docs/24 §3). put 관문에서 강제 — 우회 있는 검사는 검사가 아니다.
    if isinstance(v, bool) or v is None:
        return
    if isinstance(v, float):
        raise ValueError(f"{path}: non-integer number")
    if isinstance(v, int):
        if abs(v) > _MAX_INT:
            raise ValueError(f"{path}: integer beyond ±(2^53-1)")
        return
    if isinstance(v, str):
        for ch in v:
            if 0xD800 <= ord(ch) <= 0xDFFF:
                raise ValueError(f"{path}: lone surrogate")
        return
    if isinstance(v, list):
        for i, item in enumerate(v):
            _assert_interop(item, f"{path}[{i}]")
        return
    if isinstance(v, dict):
        for k, item in v.items():
            if not isinstance(k, str):
                raise ValueError(f"{path}: non-string key")
            if any(ord(c) > 0xFFFF for c in k):
                raise ValueError(f"{path}.{k}: astral char in object key")
            if unicodedata.normalize("NFC", k) != k:
                raise ValueError(f"{path}.{k}: object key not NFC")
            _assert_interop(k, f"{path}.{k}")  # 키의 lone surrogate 도 거부
            _assert_interop(item, f"{path}.{k}")
        return
    raise ValueError(f"{path}: unsupported type {type(v).__name__}")


def canonicalize(v) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, str):
        return _canon_str(v)
    if isinstance(v, list):
        return "[" + ",".join(canonicalize(x) for x in v) + "]"
    if isinstance(v, dict):
        # 코드포인트 오름차순 — Python 의 str 비교가 정확히 그것이다. 부분집합이 astral 키를
        # 금지하므로 UTF-16 기반 참조 구현의 정렬과 BMP 안에서 일치한다(docs/24 §3-2).
        items = sorted(v.items(), key=lambda kv: kv[0])
        return "{" + ",".join(_canon_str(k) + ":" + canonicalize(x) for k, x in items) + "}"
    raise ValueError(f"cannot canonicalize {type(v).__name__}")


def compute_oid(obj: dict) -> str:
    # oid = "<type>_" + sha256("<type> " + canonical(payload)).hex[:32].
    # `oid` 와 `sig` 는 해시 대상에서 제외된다 — oid 는 내용의 고정점이어야 하고, 서명은
    # oid 를 서명하므로 자기가 서명하는 것 안에 있을 수 없다. 해시 입력의 타입 접두사는
    # 같은 페이로드가 다른 타입으로 재해석되는 것을 막는다.
    payload = {k: v for k, v in obj.items() if k not in ("oid", "sig")}
    digest = hashlib.sha256(f"{obj['type']} {canonicalize(payload)}".encode("utf-8")).hexdigest()
    return f"{obj['type']}_{digest[:32]}"


# ── 저장 (파일 하나 = 객체 하나, 파일명이 oid) ───────────────────────────────
OID_RE = re.compile(r"^[a-z_]+_[0-9a-f]+$")


class Store:
    def __init__(self, data_dir: str):
        self.dir = data_dir
        os.makedirs(data_dir, exist_ok=True)

    def _path(self, oid: str) -> str:
        return os.path.join(self.dir, oid + ".json")

    def have(self):
        return [f[:-5] for f in os.listdir(self.dir) if f.endswith(".json")]

    def get(self, oid: str):
        try:
            with open(self._path(oid), encoding="utf-8") as f:
                return json.load(f)
        except FileNotFoundError:
            return None

    def put(self, obj: dict) -> str:
        _assert_interop(obj)          # 관문은 하나 — 모든 객체가 지나는 put (docs/24 §5)
        oid = compute_oid(obj)        # 주장된 oid 는 무시한다 — 위조는 제 주소로 떨어진다 (docs/26 §8)
        stored = dict(obj)
        stored["oid"] = oid
        tmp = self._path(oid) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(stored, f, ensure_ascii=False)
        os.replace(tmp, self._path(oid))  # 멱등 — 같은 내용은 같은 주소로
        return oid


# ── HTTP (docs/26 §0 의 3개 + healthz) ───────────────────────────────────────
def make_handler(store: Store):
    class Handler(BaseHTTPRequestHandler):
        def _json(self, status: int, body):
            raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, *a):  # 조용히
            pass

        def do_GET(self):
            path = self.path.split("?")[0]
            if path in ("/healthz", "/health"):
                return self._json(200, {"ok": True})
            if path == "/have":
                return self._json(200, store.have())
            if path.startswith("/objects/"):
                oid = path[len("/objects/"):]
                obj = store.get(oid) if OID_RE.match(oid) else None
                if obj is None:
                    return self._json(404, {"error": "not found"})  # 404 는 정상 응답이다 (§4-3)
                return self._json(200, obj)
            # 없는 선택 엔드포인트(/version 포함)의 404 는 "폴백하라" 다 — 5xx 가 아니다 (§0)
            return self._json(404, {"error": "not found"})

        def do_POST(self):
            if self.path.split("?")[0] != "/objects":
                return self._json(404, {"error": "not found"})
            length = int(self.headers.get("content-length") or 0)
            if length > 8 * 1024 * 1024:
                return self._json(413, {"error": "body too large"})
            try:
                obj = json.loads(self.rfile.read(length).decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                return self._json(400, {"error": "invalid JSON"})
            if not isinstance(obj, dict) or not isinstance(obj.get("type"), str):
                return self._json(400, {"error": "object must have a string `type`"})
            if obj["type"] == "integration":
                # 큐를 돌리지 않는 서버가 integration 을 받으면 누구나 큐 히스토리를 위조할 수 있다 (§6-2)
                return self._json(403, {"error": "integration objects cannot be pushed"})
            try:
                return self._json(200, {"oid": store.put(obj)})
            except ValueError as e:
                return self._json(400, {"error": str(e)})

    return Handler


# ── 골든 벡터 자기검증 (docs/24 §6) ──────────────────────────────────────────
def selftest() -> int:
    vectors_path = os.path.join(os.path.dirname(__file__), "..", "spec", "canonical-vectors.json")
    with open(vectors_path, encoding="utf-8") as f:
        vectors = json.load(f)
    failed = 0
    for v in vectors["accepted"]:
        got = canonicalize(v["payload"])
        oid = f"{v['type']}_{hashlib.sha256((v['type'] + ' ' + got).encode('utf-8')).hexdigest()[:32]}"
        if got != v["canonical"] or oid != v["oid"]:
            failed += 1
            print(f"FAIL {v['name']}: canonical/oid mismatch\n  want {v['canonical']}\n  got  {got}")
    for v in vectors["rejected"]:
        try:
            _assert_interop(v["payload"])
            failed += 1
            print(f"FAIL {v['name']}: should have been rejected ({v['reason']})")
        except ValueError:
            pass
    # lone surrogate 는 UTF-8 파일에 실을 수 없어 벡터가 아니라 여기서 잰다 (docs/24 §6)
    try:
        _assert_interop({"s": "\ud800"})
        failed += 1
        print("FAIL lone-surrogate: should have been rejected")
    except ValueError:
        pass
    total = len(vectors["accepted"]) + len(vectors["rejected"]) + 1
    print(f"{total - failed}/{total} vectors ok")
    return 1 if failed else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="./data")
    ap.add_argument("--port", type=int, default=8430)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        return selftest()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(Store(args.data)))
    print(f"avcs core server (python, stdlib) on http://127.0.0.1:{args.port}")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
매장 태블릿 동기화 API 서버 - 데모/프로토타입 (역할 기반 접근제어 포함)

정책: "데이터 분석 내역(상권분석/통계/전체 상담로그)은 본사 및 지사 관리자만 조회 가능하다."
      상담사(매장 직원)는 세일즈톡 참고자료 조회 + 자기 매장 로그 입력만 가능하고,
      집계·분석 데이터는 조회할 수 없다.

역할(role) 3종:
  - staff          : 매장 상담사. 자기 매장 소속(store_id)만 부여됨. /api/consultant/* 만 사용.
  - branch_manager : 지사 관리자. 소속 지사(branch_id) 산하 매장 데이터만 조회 가능.
  - hq_manager     : 본사 관리자. 전국 전체 데이터 조회 가능.

인증 방식: 이 프로토타입은 외부 패키지 설치가 막혀있는 샌드박스 환경이라 JWT 라이브러리 없이
Python 표준 라이브러리(hmac/hashlib)만으로 서명 토큰을 직접 구현했다. 개념 검증(로그인 -> 서명된
토큰 발급 -> 요청마다 서명 검증 -> 역할별 데이터 필터링)은 실제 JWT/OAuth와 동일하지만, 프로덕션에서는
- SECRET_KEY를 환경변수/시크릿매니저로 관리
- ACCOUNTS의 평문 비밀번호를 실제 사번 기반 SSO/LDAP 연동으로 대체
- 반드시 HTTPS 위에서만 토큰을 주고받을 것
을 전제로 반드시 정식 인증 체계(사내 SSO, OAuth2 등)로 교체해야 한다.
"""
import json
import sys
import os
import time
import hmac
import hashlib
import base64
import mimetypes
import threading
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

DATA_FILE = os.path.join(os.path.dirname(__file__), "..", "data", "store_data.json")
# web/ 폴더를 이 서버가 그대로 서빙한다 - 프론트엔드(HTML/JS/CSS)와 API를 같은 프로세스/같은 URL에서
# 제공해야 "URL 하나로 공유"가 되므로, 정적 파일 서버와 API 서버를 합쳤다 (배포 가이드 참고).
WEB_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "web"))
LOCK = threading.Lock()

# 데모용 시크릿 키 - 운영 환경에서는 반드시 환경변수 등 안전한 방식으로 교체
SECRET_KEY = os.environ.get("STORE_APP_SECRET", "DEMO-ONLY-CHANGE-ME-IN-PRODUCTION").encode()
TOKEN_TTL_SECONDS = 12 * 3600  # 12시간

# ---------------------------------------------------------------------------
# 사이트 전체 접근 게이트 (선택) - 무료 호스팅의 URL은 기본적으로 링크를 아는 누구나 접속 가능하다.
# SITE_ACCESS_USER/SITE_ACCESS_PASS를 둘 다 설정하면 로그인 화면이 뜨기 전에 브라우저 기본 인증
# 창(HTTP Basic Auth)이 한 번 더 뜨고, 이걸 통과해야 앱(정적 파일 포함) 자체에 접근할 수 있다.
# "URL을 지정한 사람에게만 알려준다"는 정책을 기술적으로 한 겹 더 보강하는 용도. 설정 안 하면
# 기존처럼 아무 게이트 없이 접근 가능(로그인 화면은 그대로 뜸 - 앱 내부 권한은 별개로 동작).
# ---------------------------------------------------------------------------
SITE_ACCESS_USER = os.environ.get("SITE_ACCESS_USER", "")
SITE_ACCESS_PASS = os.environ.get("SITE_ACCESS_PASS", "")

# ---------------------------------------------------------------------------
# 데모 계정 (실 운영 시 사내 SSO/HR 시스템 연동으로 반드시 대체)
# ---------------------------------------------------------------------------
ACCOUNTS = {
    "staff_gangnam":   {"password": "pass1234", "role": "staff", "store_id": "ST001",
                        "display_name": "강남본점 상담사"},
    "staff_haeundae":  {"password": "pass1234", "role": "staff", "store_id": "ST004",
                        "display_name": "해운대점 상담사"},
    "branch_sudokwon": {"password": "pass1234", "role": "branch_manager", "branch_id": "BR_SUDOKWON",
                        "display_name": "수도권지사 관리자"},
    "branch_youngnam": {"password": "pass1234", "role": "branch_manager", "branch_id": "BR_YOUNGNAM",
                        "display_name": "영남지사 관리자"},
    "hq_admin":        {"password": "pass1234", "role": "hq_manager",
                        "display_name": "본사 관리자"},
}


# ---------------------------------------------------------------------------
# 저장소: 로컬 파일(기본값) 또는 GitHub Gist(선택, 무료 호스팅에서도 데이터 안 사라지게)
#
# Render 같은 무료 호스팅은 서버가 15분 유휴 후 잠들었다 깨어날 때 디스크가 배포 시점 상태로
# 초기화된다 - 로컬 파일에만 저장하면 상담사가 입력한 로그가 방금 사라진다. 이를 피하려면
# 환경변수 GIST_ID, GITHUB_TOKEN을 설정해서 GitHub Gist를 데이터 저장소로 쓸 수 있다
# (표준 라이브러리만으로 구현 - 별도 패키지 설치 불필요). 설정 안 하면 지금까지처럼 로컬
# 파일을 그대로 쓴다 (로컬 개발/테스트용). 설정 방법은 docs/웹앱_배포_가이드.md 참고.
# ---------------------------------------------------------------------------
GIST_ID = os.environ.get("GIST_ID", "")
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
GIST_FILENAME = "store_data.json"
GIST_CACHE_TTL = 5  # 초 - 이 시간 안의 반복 조회는 재요청 없이 캐시 사용
_gist_cache = {"db": None, "ts": 0.0}


def _gist_request(method, url, payload=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"token {GITHUB_TOKEN}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "store-app-demo")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _gist_load():
    now = time.time()
    if _gist_cache["db"] is not None and (now - _gist_cache["ts"]) < GIST_CACHE_TTL:
        return _gist_cache["db"]
    gist = _gist_request("GET", f"https://api.github.com/gists/{GIST_ID}")
    content = gist["files"][GIST_FILENAME]["content"]
    db = json.loads(content)
    _gist_cache["db"] = db
    _gist_cache["ts"] = now
    return db


def _gist_save(db):
    content = json.dumps(db, ensure_ascii=False, indent=2)
    _gist_request(
        "PATCH",
        f"https://api.github.com/gists/{GIST_ID}",
        {"files": {GIST_FILENAME: {"content": content}}},
    )
    _gist_cache["db"] = db
    _gist_cache["ts"] = time.time()


def load_db():
    if GIST_ID and GITHUB_TOKEN:
        try:
            return _gist_load()
        except (urllib.error.URLError, KeyError, json.JSONDecodeError) as e:
            sys.stderr.write(f"[sync_server] Gist 로드 실패, 로컬 파일로 대체: {e}\n")
    with open(DATA_FILE, encoding="utf-8") as f:
        return json.load(f)


def save_db(db):
    if GIST_ID and GITHUB_TOKEN:
        _gist_save(db)  # 실패 시 예외를 그대로 올려서 호출부가 저장 실패를 알 수 있게 함
        return
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# 토큰 (서명된 JSON, HMAC-SHA256) - 표준 라이브러리만 사용한 간이 구현
# ---------------------------------------------------------------------------
def b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def make_token(payload: dict) -> str:
    payload = dict(payload)
    payload["iat"] = int(time.time())
    payload["exp"] = int(time.time()) + TOKEN_TTL_SECONDS
    body = b64url_encode(json.dumps(payload, ensure_ascii=False).encode())
    sig = b64url_encode(hmac.new(SECRET_KEY, body.encode(), hashlib.sha256).digest())
    return f"{body}.{sig}"


def verify_token(token: str):
    try:
        body, sig = token.split(".")
        expected_sig = b64url_encode(hmac.new(SECRET_KEY, body.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, expected_sig):
            return None
        payload = json.loads(b64url_decode(body))
        if payload.get("exp", 0) < time.time():
            return None
        return payload
    except Exception:
        return None


def allowed_store_ids(payload, db):
    """토큰의 role/scope에 따라 조회 가능한 store_id 집합을 반환."""
    role = payload.get("role")
    if role == "hq_manager":
        return {s["store_id"] for s in db["stores"]}
    if role == "branch_manager":
        return {s["store_id"] for s in db["stores"] if s["branch_id"] == payload.get("branch_id")}
    if role == "staff":
        return {payload.get("store_id")}
    return set()


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth(self):
        """Authorization: Bearer <token> 검증. 실패 시 None."""
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return None
        return verify_token(header[len("Bearer "):])

    def _check_site_gate(self):
        """SITE_ACCESS_USER/PASS가 설정된 경우 HTTP Basic Auth 통과 여부 확인. 실패 시 401 응답까지 처리."""
        if not (SITE_ACCESS_USER and SITE_ACCESS_PASS):
            return True
        header = self.headers.get("Authorization", "")
        ok = False
        if header.startswith("Basic "):
            try:
                decoded = base64.b64decode(header[len("Basic "):]).decode("utf-8")
                user, _, pw = decoded.partition(":")
                ok = hmac.compare_digest(user, SITE_ACCESS_USER) and hmac.compare_digest(pw, SITE_ACCESS_PASS)
            except Exception:
                ok = False
        if ok:
            return True
        body = b"Authentication required"
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="store-app"')
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        return False

    def _serve_static(self, path):
        """web/ 폴더의 정적 파일(HTML/JS/CSS/아이콘 등)을 서빙. API 외 모든 GET 요청이 여기로 온다."""
        rel = path.lstrip("/") or "index.html"
        full = os.path.abspath(os.path.join(WEB_DIR, rel))
        # 상위 폴더 접근(경로 조작) 방지
        if not full.startswith(WEB_DIR):
            self._send_json({"error": "forbidden"}, status=403)
            return
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        if not os.path.isfile(full):
            # 알 수 없는 경로는 index.html로 폴백 (새로고침 시 404 방지)
            full = os.path.join(WEB_DIR, "index.html")
        content_type, _ = mimetypes.guess_type(full)
        try:
            with open(full, "rb") as f:
                data = f.read()
        except OSError:
            self._send_json({"error": "not found"}, status=404)
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        # service-worker.js 자체는 브라우저가 HTTP 캐시로 오래 붙들고 있으면 안 된다 -
        # 그러면 코드를 새로 배포해도 브라우저가 새 service-worker.js를 아예 받아보지 못해서
        # 오래된 버전의 앱 화면이 계속 뜨는 문제가 생긴다. 매번 네트워크로 재검증하게 강제한다.
        if os.path.basename(full) == "service-worker.js":
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self._send_json({})

    def do_GET(self):
        path = urlparse(self.path).path

        if not path.startswith("/api/"):
            # 사이트 게이트는 화면(정적 파일) 로딩에만 적용한다. API는 로그인 자격/Bearer 토큰으로
            # 이미 별도 보호되고, 여기서 Basic Auth까지 요구하면 앱이 fetch()로 보내는
            # "Authorization: Bearer ..." 헤더와 충돌해 로그인 후 API 호출이 깨진다.
            if not self._check_site_gate():
                return
            self._serve_static(path)
            return

        if path == "/api/health":
            with LOCK:
                db = load_db()
            self._send_json({"status": "ok", "stores": len(db["stores"])})
            return

        payload = self._auth()
        if not payload:
            self._send_json({"error": "unauthorized", "message": "로그인이 필요합니다"}, status=401)
            return

        with LOCK:
            db = load_db()

        role = payload.get("role")

        if path == "/api/consultant/bundle":
            # 상담사 전용: 자기 매장 기본정보 + 세일즈톡 참고자료만. 상권분석/통계/타 매장 로그는 제공하지 않음.
            if role != "staff":
                self._send_json({"error": "forbidden"}, status=403)
                return
            store = next((s for s in db["stores"] if s["store_id"] == payload["store_id"]), None)
            self._send_json({
                "store": store,
                "customer_segments": db["customer_segments"],
                "talk_scripts": db["talk_scripts"],
            })
            return

        if path == "/api/manager/export":
            # 관리자(지사/본사) 전용: 데이터 분석 내역 전체 조회
            if role not in ("branch_manager", "hq_manager"):
                self._send_json({"error": "forbidden", "message": "본사/지사 관리자만 조회할 수 있습니다"}, status=403)
                return
            allowed = allowed_store_ids(payload, db)
            filtered = {
                "branches": db["branches"] if role == "hq_manager"
                            else [b for b in db["branches"] if b["branch_id"] == payload.get("branch_id")],
                "stores": [s for s in db["stores"] if s["store_id"] in allowed],
                "commercial_area": [a for a in db["commercial_area"] if a["store_id"] in allowed],
                "customers": [c for c in db["customers"] if c["store_id"] in allowed],
                "customer_segments": db["customer_segments"],
                "talk_scripts": db["talk_scripts"],
                "sales_talk_log": [l for l in db["sales_talk_log"] if l["store_id"] in allowed],
                "generated_at": db.get("generated_at"),
                "scope": {"role": role, "branch_id": payload.get("branch_id")},
            }
            self._send_json(filtered)
            return

        self._send_json({"error": "not found"}, status=404)

    def do_POST(self):
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            self._send_json({"error": "invalid json"}, status=400)
            return

        if path == "/api/login":
            user_id = body.get("user_id", "")
            password = body.get("password", "")
            account = ACCOUNTS.get(user_id)
            if not account or account["password"] != password:
                self._send_json({"error": "invalid credentials"}, status=401)
                return
            token_payload = {"user_id": user_id, "role": account["role"]}
            if "store_id" in account:
                token_payload["store_id"] = account["store_id"]
            if "branch_id" in account:
                token_payload["branch_id"] = account["branch_id"]
            token = make_token(token_payload)
            self._send_json({
                "token": token,
                "role": account["role"],
                "display_name": account["display_name"],
                "store_id": account.get("store_id"),
                "branch_id": account.get("branch_id"),
                "expires_in": TOKEN_TTL_SECONDS,
            })
            return

        # 아래 엔드포인트는 모두 인증 필요
        payload = self._auth()
        if not payload:
            self._send_json({"error": "unauthorized", "message": "로그인이 필요합니다"}, status=401)
            return

        if path == "/api/sales_talk_log":
            role = payload.get("role")
            if role == "staff":
                # 상담사는 본인 매장에만 기록 가능 (요청 store_id 무시하고 토큰 기준으로 강제)
                body["store_id"] = payload["store_id"]
                body["staff_id"] = payload["user_id"]
            elif role in ("branch_manager", "hq_manager"):
                with LOCK:
                    db_check = load_db()
                allowed = allowed_store_ids(payload, db_check)
                if body.get("store_id") not in allowed:
                    self._send_json({"error": "forbidden", "message": "권한 범위 밖의 매장입니다"}, status=403)
                    return
            else:
                self._send_json({"error": "forbidden"}, status=403)
                return

            required = ["store_id", "age_group", "gender", "residence_area", "product_category", "customer_reaction", "wow_point", "decision_point"]
            missing = [k for k in required if k not in body or body[k] in (None, "")]
            if missing:
                self._send_json({"error": f"missing fields: {missing}"}, status=400)
                return
            with LOCK:
                db = load_db()
                body.setdefault("log_id", f"LOG_SRV_{len(db['sales_talk_log'])+1:06d}")
                body.setdefault("source", "manual")
                db["sales_talk_log"].append(body)
                try:
                    save_db(db)
                except (urllib.error.URLError, Exception) as e:
                    sys.stderr.write(f"[sync_server] 저장 실패: {e}\n")
                    self._send_json({"error": "save_failed", "message": "서버 저장에 실패했습니다. 다시 시도해주세요."}, status=502)
                    return
            self._send_json({"status": "saved", "log_id": body["log_id"]})
            return

        self._send_json({"error": "not found"}, status=404)

    def log_message(self, fmt, *args):
        sys.stderr.write("[sync_server] " + (fmt % args) + "\n")


def main():
    # 배포 플랫폼(Render 등)은 PORT 환경변수로 포트를 지정한다. 로컬 실행 시에는 커맨드라인 인자
    # 또는 기본값(8787)을 사용한다.
    port = int(os.environ.get("PORT") or (sys.argv[1] if len(sys.argv) > 1 else 8787))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"서버 실행 중: http://0.0.0.0:{port}  (web: {WEB_DIR}, data: {os.path.abspath(DATA_FILE)})")
    print("데모 계정: staff_gangnam/staff_haeundae/branch_sudokwon/branch_youngnam/hq_admin (비밀번호 pass1234)")
    server.serve_forever()


if __name__ == "__main__":
    main()

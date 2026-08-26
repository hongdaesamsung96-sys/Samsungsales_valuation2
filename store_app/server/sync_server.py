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
from urllib.parse import urlparse, parse_qs

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

# ---------------------------------------------------------------------------
# AI 상담 분석 (2단계) - 상담 녹음을 서버로 올리면
#   1) OpenAI 음성인식으로 텍스트 변환
#   2) OpenAI 텍스트 모델이 세일즈톡 매칭/고객반응/wow포인트/구매결정포인트를 JSON으로 추출
# 상담사가 모바일에서 브라우저 실시간 음성인식(Web Speech API)의 인식률이 낮았던 문제를 피하려고
# 실제 녹음 파일 기반 서버 분석으로 바꾼 것. OPENAI_API_KEY 없으면 이 기능은 비활성(503)이고
# 상담사는 화면에서 수동 입력으로 대체할 수 있다. 오디오/변환된 텍스트는 분석 응답을 만드는 동안
# 메모리에서만 쓰이고 디스크/DB 어디에도 저장하지 않는다 (개인정보보호법 설계 원칙 유지).
# ---------------------------------------------------------------------------
# 상담 상품유형(product_category)을 삼성전자 사업부 축약어인 CE(가전)/MX(모바일)로 묶는 매핑.
# web/js/app.js의 PRODUCT_GROUP과 값이 같아야 클라이언트/서버 집계가 서로 어긋나지 않는다.
PRODUCT_GROUP = {
    "스마트폰": "모바일", "태블릿": "모바일", "웨어러블": "모바일",
    "TV": "가전", "냉장고": "가전", "세탁기": "가전", "에어컨": "가전", "청소기": "가전", "기타가전": "가전",
}


def product_group(cat):
    return PRODUCT_GROUP.get(cat, "기타")


# 추천 조합 결과에 "예시 모델명 나열" 대신, 고객 라이프스타일(거주인원수/평형대/설치환경)에 맞는
# 모델 하나를 특정해서 보여주기 위한 참고용 카탈로그. data/gen_db.py의 PRODUCT_CATALOG와 값을
# 맞춰둔다 (samsung.com 제품페이지/보도자료 검색 기반 참고 더미데이터 - 실시간 가격 연동이 아니라
# 프로토타입용 근사치다).
#
# "fit"에 적힌 값은 해당 라이프스타일 조건일 때 이 모델이 잘 맞는다는 뜻이고, 조건을 아예 언급하지
# 않은 축(예: 세탁기인데 install_environment가 없음)은 "그 축은 안 가린다"는 뜻으로 중립 처리한다.
# 모바일류(스마트폰/태블릿/웨어러블)는 라이프스타일과 무관해서 fit을 아예 비워둔다.
PRODUCT_CATALOG = {
    "스마트폰": [
        {"name": "갤럭시 S25", "model": "SM-S931N", "price": 1155000, "fit": {}},
        {"name": "갤럭시 S25 울트라", "model": "SM-S938N", "price": 1798500, "fit": {}},
        {"name": "갤럭시 Z 플립7", "model": "SM-F766N", "price": 1596000, "fit": {}},
        {"name": "갤럭시 Z 폴드7", "model": "SM-F966N", "price": 2395600, "fit": {}},
        {"name": "갤럭시 A56", "model": "SM-A566N", "price": 599500, "fit": {}},
    ],
    "태블릿": [
        {"name": "갤럭시 탭 S10+", "model": "SM-X820N", "price": 1248500, "fit": {}},
        {"name": "갤럭시 탭 S10 울트라", "model": "SM-X926N", "price": 1598300, "fit": {}},
        {"name": "갤럭시 탭 A9", "model": "SM-X110N", "price": 269500, "fit": {}},
    ],
    "웨어러블": [
        {"name": "갤럭시 워치8 (44mm)", "model": "SM-L330N", "price": 459000, "fit": {}},
        {"name": "갤럭시 워치8 (40mm)", "model": "SM-L320N", "price": 419000, "fit": {}},
        {"name": "갤럭시 버즈3", "model": "SM-R530N", "price": 219000, "fit": {}},
    ],
    "TV": [
        {"name": "Neo QLED 4K 65형", "model": "KQ65QN80HAFXKR", "price": 2790000,
         "fit": {"home_size_pyeong": ["30평대", "40평대 이상"]}},
        {"name": "OLED 4K 77형", "model": "KQ77S95FAFXKR", "price": 4990000,
         "fit": {"home_size_pyeong": ["40평대 이상"]}},
        {"name": "Neo QLED 4K 55형", "model": "KQ55QN70HAFXKR", "price": 1890000,
         "fit": {"home_size_pyeong": ["20평대 이하", "30평대"]}},
    ],
    "냉장고": [
        {"name": "BESPOKE 냉장고 4도어 875L", "model": "RF85C90D201", "price": 3590000,
         "fit": {"household_size": ["3인", "4인 이상"], "home_size_pyeong": ["30평대", "40평대 이상"]}},
        {"name": "BESPOKE 냉장고 4도어 849L", "model": "RF85T92M1AP", "price": 3290000,
         "fit": {"household_size": ["2인", "3인"], "home_size_pyeong": ["20평대 이하", "30평대"]}},
        {"name": "BESPOKE 냉장고 키친핏 4도어", "model": "RF85B910327", "price": 3990000,
         "fit": {"household_size": ["3인", "4인 이상"], "home_size_pyeong": ["30평대", "40평대 이상"],
                 "install_environment": ["아파트(베란다·실외기 공간 있음)", "단독주택/대형평수"]}},
    ],
    "세탁기": [
        {"name": "BESPOKE 그랑데 AI 세탁기 25kg", "model": "WF25D9500KV", "price": 1890000,
         "fit": {"household_size": ["3인", "4인 이상"]}},
        {"name": "BESPOKE 그랑데 AI 슬림 세탁기", "model": "WF19D9700KV", "price": 1349000,
         "fit": {"household_size": ["1인", "2인"], "install_environment": ["원룸/오피스텔"]}},
        {"name": "BESPOKE AI 콤보 (세탁건조 일체형)", "model": "WD24B9910KV", "price": 4048000,
         "fit": {"install_environment": ["원룸/오피스텔", "아파트(베란다·실외기 공간 있음)"]}},
    ],
    "에어컨": [
        {"name": "BESPOKE 무풍에어컨 갤러리 프로 (스탠드형)", "model": "AF90H17D24GRS", "price": 2990000,
         "fit": {"home_size_pyeong": ["30평대", "40평대 이상"],
                 "install_environment": ["아파트(베란다·실외기 공간 있음)", "단독주택/대형평수"]}},
        {"name": "BESPOKE 무풍에어컨 프로 (벽걸이형)", "model": "AF90H17D24SRS", "price": 990000,
         "fit": {"home_size_pyeong": ["20평대 이하"], "install_environment": ["원룸/오피스텔"]}},
    ],
    "청소기": [
        {"name": "BESPOKE 제트 AI 무선청소기", "model": "VS28C973GSK", "price": 899000,
         "fit": {"home_size_pyeong": ["20평대 이하", "30평대"]}},
        {"name": "BESPOKE AI 스팀 로봇청소기", "model": "VR90F01AAGCRK", "price": 1490000,
         "fit": {"home_size_pyeong": ["30평대", "40평대 이상"], "household_size": ["3인", "4인 이상"]}},
    ],
    "기타가전": [
        {"name": "BESPOKE 큐커", "model": "NQ5B9770B01", "price": 399000, "fit": {}},
        {"name": "제스퍼 공기청정기", "model": "AX90T9080WD", "price": 490000, "fit": {}},
    ],
}


def pick_best_product(products: list, prefs: dict):
    """카테고리 안의 여러 후보 모델 중, 고객 라이프스타일 조건(거주인원수/평형대/설치환경)에 가장 잘
    맞는 모델 딱 하나를 골라준다 - "예시 나열"이 아니라 실제 조합을 구체화하기 위함. 모델의 fit에
    해당 축이 아예 없으면(예: 모바일 제품) 그 축은 안 가리는 것으로 보고 중립 처리하고, 있는데 값이
    다르면 감점한다. 라이프스타일 조건을 아무것도 입력하지 않았으면 모든 모델이 동점이라 카탈로그에
    먼저 등록된(대표) 모델이 뽑힌다."""
    if not products:
        return None

    def score(p):
        fit = p.get("fit") or {}
        s = 0
        for key, val in prefs.items():
            if not val:
                continue
            allowed = fit.get(key)
            if not allowed:
                continue
            s += 1 if val in allowed else -1
        return s

    return max(products, key=score)


def log_categories(log: dict) -> list:
    """한 상담로그의 상품유형 목록을 돌려준다. 상담 상품유형은 다중 선택이 가능해서(예: TV+냉장고를
    같이 논의) product_categories(배열)가 우선이고, 그 필드가 없는 옛날 데이터는 product_category
    (단일값) 하나짜리 목록으로 취급한다."""
    cats = log.get("product_categories")
    if isinstance(cats, list) and cats:
        return cats
    single = log.get("product_category")
    return [single] if single else []


def top_performer_pitch(db: dict, store_id: str):
    """세일즈톡 참고자료 탭 최상단에 "전월 판매성공율이 가장 높은 사원의 세일즈 멘트"를 보여주기
    위한 집계. 이 매장 로그인 계정을 여러 판매사원이 같이 쓰므로 staff_id가 아니라 consultant_name
    기준으로 전환율을 낸다. 개인 고객을 특정하는 정보는 다루지 않고(이미 비식별 저장된 요약 항목만
    사용), 같은 매장 안에서의 사원별 성과 비교이므로 기존 "성공사례 참고" 기능과 동일한 성격이다."""
    store_logs = [l for l in db["sales_talk_log"] if l.get("store_id") == store_id]
    if not store_logs:
        return None

    dated = [l for l in store_logs if l.get("log_date")]
    if not dated:
        return None
    latest_date = max(l["log_date"] for l in dated)
    latest_year, latest_month = int(latest_date[:4]), int(latest_date[5:7])
    if latest_month == 1:
        prev_year, prev_month = latest_year - 1, 12
    else:
        prev_year, prev_month = latest_year, latest_month - 1
    prev_prefix = f"{prev_year:04d}-{prev_month:02d}"

    month_logs = [l for l in store_logs if (l.get("log_date") or "").startswith(prev_prefix)]
    month_label = prev_prefix
    if not month_logs:
        # 데모 데이터가 두 달치를 못 채우는 경우 등 - 최소한 뭔가는 보여주도록 전체 기간으로 대체.
        month_logs = store_logs
        month_label = None

    stats = {}
    for l in month_logs:
        name = l.get("consultant_name")
        if not name:
            continue
        d = stats.setdefault(name, {"total": 0, "converted": 0})
        d["total"] += 1
        if l.get("purchase_converted") == "Y":
            d["converted"] += 1
    if not stats:
        return None

    candidates = [(name, d["converted"] / d["total"], d["total"]) for name, d in stats.items()]
    qualified = [c for c in candidates if c[2] >= 3] or candidates
    qualified.sort(key=lambda c: (-c[1], -c[2]))
    top_name, top_rate, top_total = qualified[0]

    scripts_by_id = {s["script_id"]: s for s in db["talk_scripts"]}

    def score_log(l):
        s = 0
        if l.get("script_id") in scripts_by_id:
            s += 2
        if l.get("wow_point"):
            s += 1
        if l.get("decision_point"):
            s += 1
        return s

    top_logs = [l for l in month_logs if l.get("consultant_name") == top_name and l.get("purchase_converted") == "Y"]
    if not top_logs:
        top_logs = [l for l in store_logs if l.get("consultant_name") == top_name and l.get("purchase_converted") == "Y"]
    if not top_logs:
        return None
    top_logs.sort(key=lambda l: (score_log(l), l.get("log_date") or ""), reverse=True)
    pick = top_logs[0]
    script = scripts_by_id.get(pick.get("script_id"))

    return {
        "consultant_name": top_name,
        "conv_rate": round(top_rate * 100),
        "sample_size": top_total,
        "month": month_label,
        "highlight": {
            "product_category": pick.get("product_category"),
            "product_categories": log_categories(pick),
            "purchase_occasion": pick.get("purchase_occasion"),
            "script_text": script.get("script_text") if script else None,
            "wow_point": pick.get("wow_point"),
            "decision_point": pick.get("decision_point"),
            "customer_reaction": pick.get("customer_reaction"),
            "age_group": pick.get("age_group"),
            "gender": pick.get("gender"),
            "residence_area": pick.get("residence_area"),
            "log_date": pick.get("log_date"),
        },
    }


OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_TRANSCRIBE_MODEL = os.environ.get("OPENAI_TRANSCRIBE_MODEL", "gpt-4o-transcribe")
OPENAI_ANALYSIS_MODEL = os.environ.get("OPENAI_ANALYSIS_MODEL", "gpt-4o-mini")
OPENAI_TIMEOUT = 45  # 초 - 음성인식 + 텍스트분석 두 단계라 넉넉하게 잡음
MAX_BODY_BYTES = 30 * 1024 * 1024   # 요청 바디 상한 (base64 오디오 포함)
MAX_AUDIO_BYTES = 18 * 1024 * 1024  # 디코딩된 오디오 상한 (대략 10분 이상 분량, 안전판 성격)


def _openai_transcribe(audio_bytes: bytes, mime_type: str) -> str:
    """오디오 바이트를 OpenAI 음성인식 API로 보내 한국어 텍스트로 변환한다. 파일을 디스크에 쓰지 않는다."""
    ext = {"audio/webm": "webm", "audio/mp4": "mp4", "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/wav": "wav"}.get(mime_type, "webm")
    boundary = "----storeapp" + b64url_encode(os.urandom(12))
    parts = [
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.{ext}"\r\nContent-Type: {mime_type}\r\n\r\n'.encode()
        + audio_bytes + b"\r\n",
        f'--{boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n{OPENAI_TRANSCRIBE_MODEL}\r\n'.encode(),
        f'--{boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nko\r\n'.encode(),
        f'--{boundary}--\r\n'.encode(),
    ]
    body = b"".join(parts)

    req = urllib.request.Request("https://api.openai.com/v1/audio/transcriptions", data=body, method="POST")
    req.add_header("Authorization", f"Bearer {OPENAI_API_KEY}")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    with urllib.request.urlopen(req, timeout=OPENAI_TIMEOUT) as resp:
        result = json.loads(resp.read().decode("utf-8"))
    return (result.get("text") or "").strip()


def _openai_analyze(transcript: str, scripts: list) -> dict:
    """상담 텍스트 + 세일즈톡 목록을 넘겨 구조화된 JSON(세그먼트 매칭/반응/wow포인트/결정포인트)을 받는다."""
    script_options = [
        {"script_id": s.get("script_id"), "category": s.get("category"),
         "product_category": s.get("product_category"), "text": s.get("script_text")}
        for s in scripts
    ]
    system_prompt = (
        "너는 삼성전자판매 매장의 상담 녹음 텍스트를 분석해서 통계용 항목만 뽑아내는 도우미다. "
        "반드시 아래 규칙을 지켜라.\n"
        "1) 출력은 JSON 객체 하나만. 다른 설명 문장은 절대 쓰지 마라.\n"
        "2) script_id는 제공된 세일즈톡 목록 중 대화 내용과 가장 가까운 것 하나의 id를 고르거나, "
        "적절한 게 없으면 null로 남겨라. 목록에 없는 id를 만들어내지 마라.\n"
        "3) customer_reaction은 '긍정' / '중립' / '부정' 중 하나만 써라.\n"
        "4) wow_point, decision_point는 각각 한국어 한 문장(40자 이내)으로 상담의 반응/결정 흐름만 "
        "요약해라. 이름, 전화번호, 구체 주소, 생년월일 등 개인을 특정할 수 있는 정보는 절대로 "
        "포함하지 마라 - 대화 중 그런 말이 나와도 결과에는 절대 넣지 말고 일반화해서 써라.\n"
        "5) 상담 내용이 너무 짧거나 불분명하면 wow_point/decision_point에 '판단 어려움'이라고 써라.\n"
        '출력 형식: {"script_id": "...", "customer_reaction": "...", "wow_point": "...", "decision_point": "..."}'
    )
    user_prompt = (
        f"[상담 녹음 텍스트]\n{transcript}\n\n"
        f"[선택 가능한 세일즈톡 목록]\n{json.dumps(script_options, ensure_ascii=False)}"
    )
    payload = {
        "model": OPENAI_ANALYSIS_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.2,
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request("https://api.openai.com/v1/chat/completions", data=data, method="POST")
    req.add_header("Authorization", f"Bearer {OPENAI_API_KEY}")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=OPENAI_TIMEOUT) as resp:
        result = json.loads(resp.read().decode("utf-8"))
    content = result["choices"][0]["message"]["content"]
    return json.loads(content)


def _openai_failure_feedback(entry: dict, success_examples: list) -> dict:
    """구매 미전환(purchase_converted=N) 로그 저장 시 호출. 원본 녹음/텍스트는 이미 폐기된 뒤라
    이 로그 자체에 저장하기로 한 요약 항목(반응/wow포인트/결정포인트 등)과, 같은 매장에서 실제
    전환된 다른 로그들의 요약 항목만 근거로 실패 사유/코칭 피드백을 만든다 - 새로운 개인정보를
    다루지 않는다."""
    success_desc = "\n".join(
        f"- wow포인트: {s.get('wow_point','')} / 결정포인트: {s.get('decision_point','')}"
        for s in success_examples
    ) or "(참고할 만한 전환 사례 없음)"
    entry_desc = (
        f"연령대={entry.get('age_group')}, 성별={entry.get('gender')}, "
        f"상품유형={entry.get('product_category')}, 구매유형={entry.get('purchase_occasion')}, "
        f"고객반응={entry.get('customer_reaction')}, wow포인트={entry.get('wow_point')}, "
        f"결정포인트(또는 이탈 지점)={entry.get('decision_point')}"
    )
    system_prompt = (
        "너는 삼성전자판매 매장의 판매 코치 AI다. 구매로 이어지지 않은 상담 1건의 요약 정보와, "
        "같은 매장에서 실제 구매로 이어진 다른 상담들의 요약 패턴을 비교해서 이번 상담이 왜 실패했을지, "
        "그리고 해당 상담사가 다음에 무엇을 다르게 하면 좋을지 알려줘라.\n"
        "규칙:\n"
        "1) 출력은 JSON 객체 하나만.\n"
        "2) failure_reason은 한국어 한 문장(40자 이내)으로 실패 추정 원인.\n"
        "3) coach_feedback은 한국어 한두 문장(80자 이내)으로 구체적이고 실행 가능한 코칭 조언.\n"
        "4) 주어진 정보에 없는 사실(가격, 특정 발언 등)을 지어내지 마라. 개인을 특정할 수 있는 정보는 "
        "포함하지 마라.\n"
        '출력 형식: {"failure_reason": "...", "coach_feedback": "..."}'
    )
    user_prompt = f"[이번 실패 상담 요약]\n{entry_desc}\n\n[같은 매장의 전환 성공 사례 참고]\n{success_desc}"
    payload = {
        "model": OPENAI_ANALYSIS_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.3,
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request("https://api.openai.com/v1/chat/completions", data=data, method="POST")
    req.add_header("Authorization", f"Bearer {OPENAI_API_KEY}")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=OPENAI_TIMEOUT) as resp:
        result = json.loads(resp.read().decode("utf-8"))
    content = result["choices"][0]["message"]["content"]
    return json.loads(content)


def _openai_bundle_pitch(filters: dict, combo: list, total: int, must_categories: list = None) -> str:
    """추천 조합 통계(서버가 이미 집계한 숫자)를 문장으로 다듬어주는 선택 단계. 통계에 없는
    사실은 지어내지 말라고 명시한다 - AI는 숫자를 만들지 않고 표현만 다듬는다."""
    combo_desc = ", ".join(
        f"{c['product_category']}({c['pct']}%)"
        + (f" 추천모델: {c['recommended_product']['name']}" if c.get("recommended_product") else "")
        + (f" 예시모델: {'/'.join(c['examples'])}" if c["examples"] else "")
        for c in combo
    )
    filter_desc = ", ".join(f"{k}={v}" for k, v in filters.items() if v and k in ("age_group", "gender", "residence_area", "purchase_occasion"))
    must_desc = f"\n상담사가 필수로 표시한 제품군: {', '.join(must_categories)}" if must_categories else ""
    single_note = "상품군이 하나뿐이면 그 상품 하나를 추천하는 멘트로 써라. " if len(combo) == 1 else ""
    prompt = (
        f"조건: {filter_desc or '전체'}{must_desc}\n전환된 상담 {total}건 집계: {combo_desc}\n"
        "위 통계만 근거로, 상담사가 고객 앞에서 바로 쓸 수 있는 추천 멘트를 한국어 2문장 이내로 작성해줘. "
        f"{single_note}통계에 없는 스펙/가격/사실을 지어내지 마."
    )
    payload = {
        "model": OPENAI_ANALYSIS_MODEL,
        "messages": [
            {"role": "system", "content": "너는 삼성전자판매 매장 상담 보조 AI다. 주어진 통계만 근거로 간결한 추천 멘트를 작성한다."},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.4,
        "max_tokens": 200,
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request("https://api.openai.com/v1/chat/completions", data=data, method="POST")
    req.add_header("Authorization", f"Bearer {OPENAI_API_KEY}")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=OPENAI_TIMEOUT) as resp:
        result = json.loads(resp.read().decode("utf-8"))
    return (result["choices"][0]["message"]["content"] or "").strip()[:250]


def _segment_stats(group_logs: list, segments_by_id: dict) -> list:
    """상담로그 목록(이미 CE 또는 MX로 필터링됨)을 segment_id별로 집계한다. 세그먼트 이름/설명은
    customer_segments 마스터 데이터에서 가져오고, 랭킹 숫자 자체는 항상 서버가 직접 계산한다."""
    if not group_logs:
        return []
    total = len(group_logs)
    counts = {}
    for l in group_logs:
        key = l.get("segment_id") or "UNASSIGNED"
        counts[key] = counts.get(key, 0) + 1
    ranked = sorted(counts.items(), key=lambda kv: -kv[1])
    out = []
    for seg_id, count in ranked:
        name = segments_by_id.get(seg_id, {}).get("segment_name", "미지정 세그먼트")
        out.append({"segment_id": seg_id, "segment_name": name, "count": count, "pct": round(count / total * 100)})
    return out


def _openai_segment_insight(store_name: str, ce_stats: list, mx_stats: list) -> str:
    """CE/MX 세그먼트 분포(서버가 이미 집계한 숫자)를 근거로 매장 운영 인사이트를 문장으로 만든다.
    AI는 숫자를 새로 만들지 않고, 주어진 집계에서 운영상 시사점만 도출한다."""
    def fmt(stats):
        return ", ".join(f"{s['segment_name']}({s['pct']}%, {s['count']}건)" for s in stats) or "데이터 없음"
    prompt = (
        f"매장: {store_name}\n"
        f"CE(가전) 세그먼트 분포: {fmt(ce_stats)}\n"
        f"MX(모바일) 세그먼트 분포: {fmt(mx_stats)}\n"
        "위 통계만 근거로, 이 매장 관리자가 참고할 운영 인사이트를 한국어 3줄 이내로 작성해줘. "
        "줄마다 줄바꿈으로 구분하고, 어떤 세그먼트/타이밍에 어떤 준비를 하면 좋을지 실무적으로 제안해. "
        "통계에 없는 숫자나 사실을 지어내지 마."
    )
    payload = {
        "model": OPENAI_ANALYSIS_MODEL,
        "messages": [
            {"role": "system", "content": "너는 삼성전자판매 매장 운영을 돕는 분석 보조 AI다. 주어진 통계만 근거로 실무적인 인사이트를 제공한다."},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.4,
        "max_tokens": 300,
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request("https://api.openai.com/v1/chat/completions", data=data, method="POST")
    req.add_header("Authorization", f"Bearer {OPENAI_API_KEY}")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=OPENAI_TIMEOUT) as resp:
        result = json.loads(resp.read().decode("utf-8"))
    return (result["choices"][0]["message"]["content"] or "").strip()[:600]


def _template_branch_insight(branch_stats: list) -> str:
    """OPENAI_API_KEY가 없을 때도 지사비교 탭이 항상 뭔가 유용한 문장을 보여주도록 하는 규칙
    기반 폴백. AI 버전과 마찬가지로 branch_stats에 있는 숫자만 그대로 문장으로 옮긴다."""
    with_logs = [b for b in branch_stats if b["log_count"] > 0]
    if not with_logs:
        return "아직 지사별로 비교할 만한 상담 로그가 충분하지 않습니다."
    by_conv = sorted(with_logs, key=lambda b: -b["sales"]["conv_rate"])
    top, bottom = by_conv[0], by_conv[-1]
    lines = [
        f"판매: {top['branch_name']}이(가) 구매전환율 {top['sales']['conv_rate']}%로 가장 높고, "
        f"{bottom['branch_name']}은(는) {bottom['sales']['conv_rate']}%로 가장 낮습니다.",
    ]
    if bottom["promo"]["top_fail_reason"]:
        lines.append(
            f"판촉: {bottom['branch_name']}의 미전환 사유 1위는 '{bottom['promo']['top_fail_reason']['name']}'"
            f"({bottom['promo']['top_fail_reason']['count']}건)입니다 - 관련 대응을 우선 점검해보세요."
        )
    if top["promo"]["top_wow_point"]:
        lines.append(
            f"참고: {top['branch_name']}의 전환 상담에서 자주 나온 Wow포인트는 "
            f"'{top['promo']['top_wow_point']['name']}'입니다 - 다른 지사 세일즈톡에도 접목해볼 만합니다."
        )
    return "\n".join(lines)


def _openai_branch_insight(branch_stats: list) -> str:
    """지사별 판매/판촉 KPI(서버가 이미 집계한 숫자)를 근거로, 본사 관리자가 참고할 지사간
    비교 인사이트를 문장으로 만든다. AI는 숫자를 새로 만들지 않고 운영 시사점만 도출한다."""
    def fmt(b):
        s, p = b["sales"], b["promo"]
        parts = [
            f"{b['branch_name']}(매장{b['store_count']}개,상담{b['log_count']}건)",
            f"전환율 {s['conv_rate']}%", f"평균고객구매액 {s['avg_customer_value']:,}원",
            f"가전/모바일 비중 {s['ce_pct']}%/{s['mx_pct']}%",
        ]
        if p["top_occasion"]:
            parts.append(f"최다구매유형 {p['top_occasion']['name']}({p['top_occasion']['pct']}%)")
        if p["top_fail_reason"]:
            parts.append(f"최다실패사유 '{p['top_fail_reason']['name']}'")
        if p["top_wow_point"]:
            parts.append(f"최다Wow포인트 '{p['top_wow_point']['name']}'")
        if p["top_segment"]:
            parts.append(f"최다세그먼트 {p['top_segment']['name']}({p['top_segment']['pct']}%)")
        return ", ".join(parts)

    branches_desc = "\n".join(f"- {fmt(b)}" for b in branch_stats)
    prompt = (
        f"[지사별 판매/판촉 KPI]\n{branches_desc}\n\n"
        "위 통계만 근거로, 본사 관리자가 참고할 지사간 비교 인사이트를 한국어 4줄 이내로 작성해줘. "
        "'판매' 관점(전환율/객단가/상품 비중)과 '판촉' 관점(구매유형/실패사유/Wow포인트/세그먼트)을 "
        "구분해서 어느 지사가 강점/약점인지와 다음에 취할 만한 실무 액션을 제안해. "
        "줄마다 줄바꿈으로 구분하고, 통계에 없는 숫자나 사실을 지어내지 마."
    )
    payload = {
        "model": OPENAI_ANALYSIS_MODEL,
        "messages": [
            {"role": "system", "content": "너는 삼성전자판매 본사 운영을 돕는 분석 보조 AI다. 주어진 지사별 통계만 근거로 실무적인 비교 인사이트를 제공한다."},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.4,
        "max_tokens": 400,
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request("https://api.openai.com/v1/chat/completions", data=data, method="POST")
    req.add_header("Authorization", f"Bearer {OPENAI_API_KEY}")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=OPENAI_TIMEOUT) as resp:
        result = json.loads(resp.read().decode("utf-8"))
    return (result["choices"][0]["message"]["content"] or "").strip()[:800]


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
            # 매장 공용 로그인 계정을 여러 판매사원이 같이 쓰는 경우를 위한 사원 명단 - 상담기록
            # 입력화면의 "담당 판매사원" 드롭다운에 쓰인다.
            staff_roster = sorted({
                r["staff_name"] for r in db.get("store_staff", [])
                if r.get("store_id") == payload["store_id"] and r.get("staff_name")
            })
            self._send_json({
                "store": store,
                "customer_segments": db["customer_segments"],
                "talk_scripts": db["talk_scripts"],
                "staff_roster": staff_roster,
                # 세일즈톡 참고자료 탭 최상단에 노출할 "전월 판매성공율 1위 사원의 세일즈 멘트".
                # 로그가 부족하면 None - 클라이언트가 이 경우 상단 카드를 그냥 생략한다.
                "top_performer": top_performer_pitch(db, payload["store_id"]),
            })
            return

        if path == "/api/consultant/my_failures":
            # 상담사 본인이 입력한 구매 미전환 건 + AI 코칭 피드백만 조회 (본인 것만, 매장 전체/타 상담사 비교 불가).
            # 집계·분석 접근권한(관리자 전용) 정책은 그대로 두되, "내 실패 케이스 피드백"은 자기계발 목적으로
            # 본인에게만 예외적으로 허용한다. 다만 매장 로그인 계정 하나를 여러 판매사원이 같이 쓰는 경우를
            # 위해, 이 로그인 계정 범위(store_id+staff_id) 안에서만 consultant_name으로 한 번 더 좁혀볼 수 있다
            # (다른 로그인/매장 데이터는 여전히 볼 수 없음 - 권한 경계는 그대로 유지).
            if role != "staff":
                self._send_json({"error": "forbidden"}, status=403)
                return
            query = parse_qs(urlparse(self.path).query)
            consultant_filter = (query.get("consultant_name") or [""])[0].strip()

            scope_logs = [
                l for l in db["sales_talk_log"]
                if l.get("store_id") == payload.get("store_id")
                and l.get("staff_id") == payload.get("user_id")
            ]
            consultant_names = sorted({l.get("consultant_name") for l in scope_logs if l.get("consultant_name")})

            my_fails = [l for l in scope_logs if l.get("purchase_converted") == "N"]
            if consultant_filter:
                my_fails = [l for l in my_fails if l.get("consultant_name") == consultant_filter]
            my_fails.sort(key=lambda l: (l.get("log_date", ""), l.get("log_id", "")), reverse=True)

            # 실패 로그마다, 같은 매장에서 실제 전환된 유사 상품유형 사례를 성공 참고용으로 붙여준다
            # (개인식별 정보 없이 wow_point/decision_point/product_category만 - manager 쪽 findSuccessReference와 같은 방식).
            success_logs = [
                l for l in db["sales_talk_log"]
                if l.get("store_id") == payload.get("store_id") and l.get("purchase_converted") == "Y"
            ]

            def find_success_ref(fail_log):
                cats = set(log_categories(fail_log))
                candidates = [
                    l for l in success_logs
                    if cats & set(log_categories(l)) and (l.get("wow_point") or l.get("decision_point"))
                ]
                if not candidates:
                    return None
                same_seg = [l for l in candidates if l.get("segment_id") == fail_log.get("segment_id")]
                pick = (same_seg or candidates)[0]
                return {
                    "product_category": pick.get("product_category"),
                    "wow_point": pick.get("wow_point"),
                    "decision_point": pick.get("decision_point"),
                }

            enriched = []
            for l in my_fails:
                item = dict(l)
                item["success_reference"] = find_success_ref(l)
                enriched.append(item)

            self._send_json({"logs": enriched, "consultant_names": consultant_names})
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
        if length > MAX_BODY_BYTES:
            self._send_json({"error": "payload_too_large", "message": "요청이 너무 큽니다."}, status=413)
            return
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

        if path == "/api/analyze_consultation":
            # 상담사가 녹음한 오디오를 넘기면 (1)음성인식 (2)세일즈톡 매칭/반응/wow포인트/결정포인트 추출을
            # 서버가 대신 해주는 엔드포인트. 결과만 응답하고, 실제 저장은 클라이언트가 이 결과를 검토/수정한
            # 뒤 기존 /api/sales_talk_log로 별도 호출해서 한다 (이 엔드포인트 자체는 DB에 아무것도 쓰지 않음).
            if not OPENAI_API_KEY:
                self._send_json({
                    "error": "ai_not_configured",
                    "message": "서버에 AI 분석 기능(OPENAI_API_KEY)이 아직 설정되지 않았습니다. 직접 입력으로 진행해주세요.",
                }, status=503)
                return

            audio_b64 = body.get("audio_base64", "")
            mime_type = body.get("audio_mime") or "audio/webm"
            if not audio_b64:
                self._send_json({"error": "missing audio"}, status=400)
                return
            try:
                audio_bytes = base64.b64decode(audio_b64)
            except Exception:
                self._send_json({"error": "invalid audio encoding"}, status=400)
                return
            if len(audio_bytes) > MAX_AUDIO_BYTES:
                self._send_json({"error": "audio_too_large", "message": "녹음이 너무 깁니다. 더 짧게 나눠서 시도해주세요."}, status=413)
                return
            if len(audio_bytes) < 1000:
                self._send_json({"error": "audio_too_short", "message": "녹음 내용이 너무 짧습니다."}, status=400)
                return

            with LOCK:
                db = load_db()
            scripts = db.get("talk_scripts", [])

            try:
                transcript = _openai_transcribe(audio_bytes, mime_type)
            except Exception as e:
                sys.stderr.write(f"[sync_server] 음성인식 실패: {e}\n")
                self._send_json({"error": "transcribe_failed", "message": "음성 인식에 실패했습니다. 다시 시도하거나 직접 입력해주세요."}, status=502)
                return
            finally:
                audio_bytes = None  # 처리 즉시 폐기 - 저장하지 않음

            if not transcript:
                self._send_json({"error": "empty_transcript", "message": "녹음에서 음성을 인식하지 못했습니다. 다시 시도하거나 직접 입력해주세요."}, status=422)
                return

            try:
                analysis = _openai_analyze(transcript, scripts)
            except Exception as e:
                sys.stderr.write(f"[sync_server] AI 분석 실패: {e}\n")
                self._send_json({"error": "analyze_failed", "message": "AI 분석에 실패했습니다. 다시 시도하거나 직접 입력해주세요."}, status=502)
                return

            valid_ids = {s.get("script_id") for s in scripts}
            script_id = analysis.get("script_id")
            if script_id not in valid_ids:
                script_id = None
            segment_id = next((s.get("target_segment") for s in scripts if s.get("script_id") == script_id), None)

            reaction = analysis.get("customer_reaction")
            if reaction not in ("긍정", "중립", "부정"):
                reaction = "중립"

            self._send_json({
                "transcript_preview": transcript[:300],
                "suggested": {
                    "script_id": script_id,
                    "segment_id": segment_id,
                    "customer_reaction": reaction,
                    "wow_point": (analysis.get("wow_point") or "").strip()[:200],
                    "decision_point": (analysis.get("decision_point") or "").strip()[:200],
                },
            })
            return

        if path == "/api/recommend_bundle":
            # 고객 유형(연령대/성별/거주지/구매유형)을 넣으면, 조건이 비슷하면서 실제 구매전환된
            # 상담 로그들을 집계해서 어떤 상품유형/모델이 많이 팔렸는지 알려주는 "추천 조합" 기능.
            # 개인별 구매이력을 연결하는 게 아니라 비식별 로그들의 통계 집계라서, "이 고객이 A를
            # 샀으니 B도 살 것"이 아니라 "이런 조건의 고객들에게는 보통 이런 조합이 잘 팔렸다"는
            # 뜻이다. 랭킹 자체는 서버가 직접 집계하고(숫자를 지어내지 않음), AI는 있으면 문구만
            # 다듬는다 - 없어도 통계 기반 결과는 그대로 나온다.
            role = payload.get("role")
            with LOCK:
                db = load_db()
            if role == "staff":
                scope_store_ids = {payload["store_id"]}
            elif role in ("branch_manager", "hq_manager"):
                scope_store_ids = allowed_store_ids(payload, db)
                if body.get("store_id"):
                    if body["store_id"] not in scope_store_ids:
                        self._send_json({"error": "forbidden", "message": "권한 범위 밖의 매장입니다"}, status=403)
                        return
                    scope_store_ids = {body["store_id"]}
            else:
                self._send_json({"error": "forbidden"}, status=403)
                return

            stores_by_id = {s["store_id"]: s for s in db["stores"]}
            channel_type = body.get("channel_type") or None
            # 상담사가 추천 조합 화면에서 직접 고른 제품군 목록 (다품목 화면은 여러 개, 즉시상담 단품
            # 화면은 1개). 지정된 경우 집계 대상을 이 제품군들로만 제한한다 - AI가 임의로 다른
            # 제품군을 끼워넣지 않도록 서버 단계에서부터 후보를 좁혀둔다.
            categories = set(body.get("categories") or [])
            must_categories = [c for c in (body.get("must_categories") or []) if c in categories] if categories else []

            def is_match(log, use_residence, use_occasion):
                if log.get("store_id") not in scope_store_ids:
                    return False
                if log.get("purchase_converted") != "Y":
                    return False
                if channel_type and stores_by_id.get(log.get("store_id"), {}).get("channel_type") != channel_type:
                    return False
                if categories and not (categories & set(log_categories(log))):
                    return False
                if body.get("age_group") and log.get("age_group") != body["age_group"]:
                    return False
                if body.get("gender") and log.get("gender") != body["gender"]:
                    return False
                if use_residence and body.get("residence_area") and log.get("residence_area") != body["residence_area"]:
                    return False
                if use_occasion and body.get("purchase_occasion") and log.get("purchase_occasion") != body["purchase_occasion"]:
                    return False
                return True

            all_logs = db["sales_talk_log"]
            candidates = [l for l in all_logs if is_match(l, True, True)]
            relax_note = None
            if len(candidates) < 3:
                relaxed = [l for l in all_logs if is_match(l, False, True)]
                if len(relaxed) >= 3:
                    candidates = relaxed
                    relax_note = "거주지 조건은 제외하고 집계했습니다."
                else:
                    relaxed2 = [l for l in all_logs if is_match(l, False, False)]
                    if len(relaxed2) >= 3:
                        candidates = relaxed2
                        relax_note = "거주지/구매유형 조건은 제외하고 연령대·성별 기준으로 집계했습니다."

            if len(candidates) < 3:
                cat_note = f" (선택 제품군: {', '.join(sorted(categories))})" if categories else ""
                self._send_json({
                    "sample_size": len(candidates),
                    "combo": [],
                    "pitch": None,
                    "message": f"조건에 맞는 전환 사례가 아직 충분하지 않습니다 (최소 3건 필요){cat_note}.",
                })
                return

            # 상담 상품유형은 다중 선택이 가능하므로, 한 상담이 여러 제품군에 걸쳐 있으면 그 각각에
            # 집계를 반영한다. 다만 상담사가 특정 제품군을 골라 요청한 경우(categories)는, 그 로그가
            # 실제로 논의하지 않은 다른 제품군까지 끼워넣지 않도록 요청받은 제품군으로만 좁힌다.
            cat_counts, item_examples = {}, {}
            for l in candidates:
                l_cats = log_categories(l) or ["미상"]
                scoped_cats = [c for c in l_cats if not categories or c in categories] or l_cats
                for cat in scoped_cats:
                    cat_counts[cat] = cat_counts.get(cat, 0) + 1
                    item = (l.get("purchased_item") or "").strip()
                    if item:
                        bucket = item_examples.setdefault(cat, [])
                        if item not in bucket and len(bucket) < 3:
                            bucket.append(item)
            total = len(candidates)
            ranked = sorted(cat_counts.items(), key=lambda kv: -kv[1])[:4]

            # 거주인원수/평형대/설치환경 - 상담사가 추천조합 3단계에서 입력한 고객 라이프스타일
            # 조건. "예시 모델 나열"이 아니라 조합을 구체화하기 위해, 카테고리별로 이 조건에 가장
            # 잘 맞는 모델 하나를 pick_best_product()로 특정한다.
            lifestyle_prefs = {
                "household_size": body.get("household_size") or None,
                "home_size_pyeong": body.get("home_size_pyeong") or None,
                "install_environment": body.get("install_environment") or None,
            }
            combo = [
                {
                    "product_category": c,
                    "count": n,
                    "pct": round(n / total * 100),
                    "examples": item_examples.get(c, []),
                    # 카탈로그 전체 리스트가 아니라, 라이프스타일 조건에 맞춰 특정된 모델 1개만 내려준다.
                    "recommended_product": pick_best_product(PRODUCT_CATALOG.get(c, []), lifestyle_prefs),
                }
                for c, n in ranked
            ]
            combo_total_price = sum(
                c["recommended_product"]["price"] for c in combo if c.get("recommended_product")
            )

            pitch = None
            if OPENAI_API_KEY:
                try:
                    pitch = _openai_bundle_pitch(body, combo, total, must_categories)
                except Exception as e:
                    sys.stderr.write(f"[sync_server] 추천 문구 생성 실패: {e}\n")
            if not pitch:
                top_names = ", ".join(c["product_category"] for c in combo)
                pitch = f"비슷한 조건의 전환 사례 {total}건 중 {top_names} 순으로 많이 팔렸습니다."

            self._send_json({
                "sample_size": total,
                "relax_note": relax_note,
                "combo": combo,
                "combo_total_price": combo_total_price,
                "pitch": pitch,
            })
            return

        if path == "/api/segment_insight":
            # 고객세그먼트 탭 최상단 AI 인사이트. CE(가전)/MX(모바일)별 세그먼트 분포를 서버가
            # 직접 집계하고(숫자를 지어내지 않음), OPENAI_API_KEY가 있으면 AI가 운영 인사이트 문구만
            # 다듬는다 - 없어도 통계 기반 템플릿 문구로 항상 동작한다. 매니저 전용 화면이라 상담사는
            # 접근할 수 없다.
            role = payload.get("role")
            if role not in ("branch_manager", "hq_manager"):
                self._send_json({"error": "forbidden"}, status=403)
                return
            with LOCK:
                db = load_db()
            allowed = allowed_store_ids(payload, db)
            store_id = body.get("store_id")
            if not store_id or store_id not in allowed:
                self._send_json({"error": "forbidden", "message": "권한 범위 밖의 매장입니다"}, status=403)
                return

            store = next((s for s in db["stores"] if s["store_id"] == store_id), None)
            store_name = store["store_name"] if store else store_id
            segments_by_id = {s["segment_id"]: s for s in db["customer_segments"]}
            logs = [l for l in db["sales_talk_log"] if l.get("store_id") == store_id]
            # 상담 상품유형이 다중 선택일 수 있어서(예: TV+냉장고), 한 상담이 CE/MX 양쪽에 걸치면
            # 두 그룹 통계에 모두 반영한다 - 어느 한쪽으로만 억지로 나누지 않는다.
            ce_logs = [l for l in logs if any(product_group(c) == "가전" for c in log_categories(l))]
            mx_logs = [l for l in logs if any(product_group(c) == "모바일" for c in log_categories(l))]
            ce_stats = _segment_stats(ce_logs, segments_by_id)
            mx_stats = _segment_stats(mx_logs, segments_by_id)

            if not ce_stats and not mx_stats:
                self._send_json({
                    "ce": [], "mx": [], "insight": None,
                    "message": "아직 쌓인 상담 로그가 없어 인사이트를 만들 수 없습니다.",
                })
                return

            insight = None
            if OPENAI_API_KEY:
                try:
                    insight = _openai_segment_insight(store_name, ce_stats, mx_stats)
                except Exception as e:
                    sys.stderr.write(f"[sync_server] 세그먼트 인사이트 생성 실패: {e}\n")
            if not insight:
                lines = []
                if ce_stats:
                    top = ce_stats[0]
                    lines.append(f"CE(가전)에서는 {top['segment_name']}이(가) {top['pct']}%({top['count']}건)로 가장 큰 비중을 차지합니다.")
                if mx_stats:
                    top = mx_stats[0]
                    lines.append(f"MX(모바일)에서는 {top['segment_name']}이(가) {top['pct']}%({top['count']}건)로 가장 큰 비중을 차지합니다.")
                lines.append("각 세그먼트의 추천 타이밍/상품을 참고해 상담 준비를 해보세요.")
                insight = "\n".join(lines)

            self._send_json({"ce": ce_stats, "mx": mx_stats, "insight": insight})
            return

        if path == "/api/branch_insight":
            # 지사별 비교 탭 - 예전엔 지사별로 "최다 연령대/최다 상품유형" 같은 단순 집계 테이블만
            # 보여주고 그래서 어쩌라는건지(운영 인사이트)가 없었다. 이제 지사별 핵심 지표를
            # "판매"(전환율/객단가/CE·MX 비중)와 "판촉"(구매유형/실패사유/성공 Wow포인트/세그먼트)
            # 두 축으로 나눠 서버가 직접 집계하고(숫자는 항상 서버가 계산), OPENAI_API_KEY가 있으면
            # AI가 그 집계를 근거로 지사간 비교 인사이트 문구만 만든다 - 없어도 템플릿 문구로 항상 동작.
            # 본사 관리자만 전사 지사 비교를 볼 수 있다 (지사 관리자는 자기 지사만 보이므로 비교 대상이 없음).
            role = payload.get("role")
            if role != "hq_manager":
                self._send_json({"error": "forbidden"}, status=403)
                return
            with LOCK:
                db = load_db()

            segments_by_id = {s["segment_id"]: s for s in db["customer_segments"]}
            branch_stats = []
            for br in db["branches"]:
                branch_stores = [s["store_id"] for s in db["stores"] if s["branch_id"] == br["branch_id"]]
                logs = [l for l in db["sales_talk_log"] if l.get("store_id") in branch_stores]
                customers = [c for c in db["customers"] if c.get("store_id") in branch_stores]
                log_count = len(logs)
                converted_logs = [l for l in logs if l.get("purchase_converted") == "Y"]
                failed_logs = [l for l in logs if l.get("purchase_converted") == "N"]
                conv_rate = round(len(converted_logs) / log_count * 100) if log_count else 0

                def top_freq(items, key_fn):
                    freq = {}
                    for it in items:
                        v = key_fn(it)
                        if not v:
                            continue
                        freq[v] = freq.get(v, 0) + 1
                    if not freq:
                        return None
                    name, count = sorted(freq.items(), key=lambda kv: -kv[1])[0]
                    return {"name": name, "count": count, "pct": round(count / len(items) * 100) if items else 0}

                # 판매(Sales) KPI -----------------------------------------------------------
                amounts = [c.get("total_purchase_amount") for c in customers if c.get("total_purchase_amount")]
                avg_customer_value = round(sum(amounts) / len(amounts)) if amounts else 0
                ce_logs = [l for l in logs if any(product_group(c) == "가전" for c in log_categories(l))]
                mx_logs = [l for l in logs if any(product_group(c) == "모바일" for c in log_categories(l))]
                ce_pct = round(len(ce_logs) / log_count * 100) if log_count else 0
                mx_pct = round(len(mx_logs) / log_count * 100) if log_count else 0

                # 판촉(Promotion) KPI --------------------------------------------------------
                top_occasion = top_freq(logs, lambda l: l.get("purchase_occasion"))
                top_fail_reason = top_freq(failed_logs, lambda l: l.get("failure_reason"))
                top_wow = top_freq(converted_logs, lambda l: l.get("wow_point"))
                top_segment_raw = top_freq(logs, lambda l: l.get("segment_id"))
                top_segment = None
                if top_segment_raw:
                    seg_name = segments_by_id.get(top_segment_raw["name"], {}).get("segment_name", top_segment_raw["name"])
                    top_segment = {"name": seg_name, "count": top_segment_raw["count"], "pct": top_segment_raw["pct"]}

                branch_stats.append({
                    "branch_id": br["branch_id"],
                    "branch_name": br["branch_name"],
                    "store_count": len(branch_stores),
                    "log_count": log_count,
                    "sales": {
                        "conv_rate": conv_rate,
                        "avg_customer_value": avg_customer_value,
                        "ce_pct": ce_pct,
                        "mx_pct": mx_pct,
                    },
                    "promo": {
                        "fail_rate": (100 - conv_rate) if log_count else 0,
                        "top_occasion": top_occasion,
                        "top_fail_reason": top_fail_reason,
                        "top_wow_point": top_wow,
                        "top_segment": top_segment,
                    },
                })

            if not any(b["log_count"] for b in branch_stats):
                self._send_json({
                    "branches": branch_stats, "insight": None,
                    "message": "아직 쌓인 상담 로그가 없어 인사이트를 만들 수 없습니다.",
                })
                return

            insight = None
            if OPENAI_API_KEY:
                try:
                    insight = _openai_branch_insight(branch_stats)
                except Exception as e:
                    sys.stderr.write(f"[sync_server] 지사비교 인사이트 생성 실패: {e}\n")
            if not insight:
                insight = _template_branch_insight(branch_stats)

            self._send_json({"branches": branch_stats, "insight": insight})
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

            # 상담 상품유형은 다중 선택이 가능하다. 클라이언트는 product_categories(배열)를 보내고,
            # product_category(대표값 = 배열의 첫 값)는 옛 단일값 소비처와의 호환을 위해 함께 보낸다.
            # 혹시 하나만 왔더라도 나머지를 여기서 서로 채워 넣어 항상 둘 다 일관되게 저장한다.
            cats = body.get("product_categories")
            if not (isinstance(cats, list) and cats):
                cats = [body["product_category"]] if body.get("product_category") else []
            body["product_categories"] = cats
            if not body.get("product_category") and cats:
                body["product_category"] = cats[0]

            required = ["store_id", "consultant_name", "age_group", "gender", "residence_area", "product_category", "purchase_occasion", "customer_reaction", "wow_point", "decision_point"]
            missing = [k for k in required if k not in body or body[k] in (None, "")]
            if missing:
                self._send_json({"error": f"missing fields: {missing}"}, status=400)
                return

            # 구매 미전환 건은, 저장하기로 한 요약 항목만 근거로 AI가 실패사유/코칭피드백을 만들어본다.
            # 키가 없거나 호출이 실패해도 저장 자체는 막지 않고 그냥 빈 값으로 둔다.
            if body.get("purchase_converted") == "N" and OPENAI_API_KEY:
                try:
                    db_ctx = load_db()
                    success_examples = [
                        l for l in db_ctx["sales_talk_log"]
                        if l.get("store_id") == body.get("store_id") and l.get("purchase_converted") == "Y"
                    ][-8:]
                    fb = _openai_failure_feedback(body, success_examples)
                    body["failure_reason"] = (fb.get("failure_reason") or "").strip()[:150]
                    body["coach_feedback"] = (fb.get("coach_feedback") or "").strip()[:200]
                except Exception as e:
                    sys.stderr.write(f"[sync_server] 실패 피드백 생성 실패: {e}\n")
                    body.setdefault("failure_reason", "")
                    body.setdefault("coach_feedback", "")
            else:
                body.setdefault("failure_reason", "")
                body.setdefault("coach_feedback", "")

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
    print(f"AI 상담 분석: {'활성화됨 (' + OPENAI_TRANSCRIBE_MODEL + ' / ' + OPENAI_ANALYSIS_MODEL + ')' if OPENAI_API_KEY else '비활성 - OPENAI_API_KEY 환경변수 없음'}")
    server.serve_forever()


if __name__ == "__main__":
    main()

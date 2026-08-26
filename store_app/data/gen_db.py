#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
매장별 고객/상권/세일즈톡 분석 DB 생성 스크립트
삼성전자판매 전국 체인 - 프로토타입용 샘플 데이터
"""
import sqlite3
import random
import json
from datetime import datetime, timedelta

random.seed(42)

DB_PATH = "store_analysis.db"

conn = sqlite3.connect(DB_PATH)
cur = conn.cursor()

cur.executescript("""
DROP TABLE IF EXISTS branches;
DROP TABLE IF EXISTS stores;
DROP TABLE IF EXISTS commercial_area;
DROP TABLE IF EXISTS customers;
DROP TABLE IF EXISTS customer_segments;
DROP TABLE IF EXISTS talk_scripts;
DROP TABLE IF EXISTS sales_talk_log;
DROP TABLE IF EXISTS store_staff;
DROP TABLE IF EXISTS sales_policies;

CREATE TABLE branches (
    branch_id       TEXT PRIMARY KEY,
    branch_name     TEXT NOT NULL   -- 지사명 (본사 관할 지역 조직)
);

-- 매장은 매장명/위치로만 구분한다. "오피스형/주거형" 같은 사전 정의 유형 라벨은 두지 않는다.
-- 어떤 연령대/성별/거주형태 고객이 많이 오는 매장인지는 아래 sales_talk_log가 쌓인 뒤 그 실측
-- 데이터를 집계해서 알아내는 것이지, 매장에 미리 붙여두는 속성이 아니다 (설계 배경은 docs/ 참고).
CREATE TABLE stores (
    store_id        TEXT PRIMARY KEY,
    store_name      TEXT NOT NULL,
    branch_id       TEXT REFERENCES branches(branch_id),
    region_sido     TEXT NOT NULL,
    region_sigungu  TEXT NOT NULL,
    address         TEXT,
    lat             REAL,
    lng             REAL,
    open_date       TEXT,
    channel_type    TEXT   -- 유통채널: 백화점/로드샵/기타 - 매장별 판매 조합 비교(추천 조합 기능)에 사용
);

-- 상권분석: 외부에서 확인 가능한 물리적 상권 정보(경쟁매장/교통/유동인구)만 담는다.
-- 방문 고객의 연령대·성별 같은 "고객유형" 정보는 여기 두지 않고, sales_talk_log를 집계해서 구한다.
CREATE TABLE commercial_area (
    store_id            TEXT PRIMARY KEY REFERENCES stores(store_id),
    competitor_count    INTEGER,   -- 반경 500m 내 경쟁 매장 총 개수 (아래 competitor_breakdown의 합)
    competitor_breakdown TEXT,     -- JSON 배열: 경쟁사를 브랜드 라벨(X사/H사/A사 등)로 구분한 개수/최근접거리.
                                    -- 실제 상호를 그대로 노출하지 않고 사내 코드명으로 순화해서 보여주기 위함.
    nearby_subway       TEXT,
    subway_distance_m   INTEGER,
    nearby_office_count INTEGER,
    nearby_apt_units    INTEGER,   -- 인근 아파트 세대수 추정
    foot_traffic_index  INTEGER,   -- 0~100 상대지수
    analysis_date       TEXT,
    notes               TEXT
);

CREATE TABLE customer_segments (
    segment_id      TEXT PRIMARY KEY,
    segment_name    TEXT,
    criteria_desc   TEXT,
    target_products TEXT,
    recommended_timing TEXT
);

CREATE TABLE customers (
    customer_id         TEXT PRIMARY KEY,
    store_id            TEXT REFERENCES stores(store_id),
    age_group           TEXT,
    gender              TEXT,
    membership_tier     TEXT,   -- VIP / GOLD / SILVER / GENERAL
    carrier             TEXT,   -- SKT / KT / LGU+ / 알뜰폰
    contract_end_date   TEXT,
    last_purchase_date  TEXT,
    last_purchase_category TEXT,  -- 스마트폰/TV/냉장고/웨어러블/기타가전
    purchase_cycle_months INTEGER,
    total_purchase_amount INTEGER,
    segment_id          TEXT REFERENCES customer_segments(segment_id),
    registered_date     TEXT   -- 매장 대시보드의 "등록 고객 수" 일계/누계 구분용 등록일
);

CREATE TABLE talk_scripts (
    script_id       TEXT PRIMARY KEY,
    category        TEXT,
    script_text     TEXT,
    target_segment  TEXT,
    product_category TEXT   -- 스마트폰/태블릿/웨어러블/TV/냉장고/세탁기/에어컨/청소기/기타가전 (모바일-가전 구분용)
);

-- 상담 로그: 특정 고객을 식별하는 값(customer_id, 이름, 연락처 등)은 의도적으로 포함하지 않는다.
-- 개인정보보호법상 "개인을 식별할 수 있는 정보"에 해당하지 않도록, 상담원이 상담 중 육안/대화로
-- 판단해 수기로 태깅하는 연령대·성별 같은 비식별 통계 항목만 남긴다 (설계 배경은 docs/ 참고).
CREATE TABLE sales_talk_log (
    log_id              TEXT PRIMARY KEY,
    store_id            TEXT REFERENCES stores(store_id),
    staff_id            TEXT,   -- 로그인 계정(매장 공용 계정일 수 있음) - 권한/접근범위 판단용
    consultant_name     TEXT,   -- 실제 상담을 진행한 판매사원 이름 - 공용 로그인 계정 하나를 여러 사원이
                                 -- 같이 쓰는 매장 특성상, staff_id만으로는 실제 담당자를 구분할 수 없어 별도로 태깅
    age_group           TEXT,   -- 상담원 수기 태깅: 10대/20대/30대/40대/50대이상 (추정치, CRM 조회 아님)
    gender              TEXT,   -- 상담원 수기 태깅: 남성/여성/미상
    residence_area      TEXT,   -- 상담원 수기 태깅: 인근 거주/인근 직장/타 지역/미상 (구체 주소 아님)
    product_category    TEXT,   -- 대표 상품유형(다중선택 시 첫번째 값) - 기존 단일값 기준 통계/집계 호환용
    product_categories  TEXT,   -- 상담원 버튼 선택(다중 선택 가능, JSON 배열 문자열): 한 상담에서 여러 상품유형을
                                 -- 같이 논의한 경우를 반영. 값 예: ["TV","냉장고"]. product_category는 이 배열의 첫 값.
    purchase_occasion   TEXT,   -- 상담원 버튼 선택: 혼수/입주/이사/모바일/즉시상담 (추천 조합 집계용 구매 상황 태그)
    purchased_item      TEXT,   -- 상담원 수기 입력(선택): 실제 구매/상담한 모델명 - 구매전환 DB 강화용, 필수 아님
    segment_id          TEXT,   -- 상담원이 대화 맥락으로 판단한 세그먼트 (CRM 연결 아님)
    script_id           TEXT,
    customer_reaction   TEXT,   -- 긍정 / 중립 / 부정
    wow_point           TEXT,
    decision_point      TEXT,
    purchase_converted  TEXT,   -- Y / N
    failure_reason      TEXT,   -- purchase_converted=N일 때만: AI가 저장된 요약 항목만 근거로 판단한 실패 사유
    coach_feedback      TEXT,   -- purchase_converted=N일 때만: AI가 제시하는 해당 상담사용 구체 피드백
    customer_need       TEXT,   -- purchase_converted=N일 때만: AI가 판단한 "고객이 원하는 바" - 판매사원에게 1차 제공
    sms_message         TEXT,   -- purchase_converted=N일 때만: 고객 재상담(가망고객화)용 문자메시지 초안 (실제 발송은 상담사가 직접)
    recommended_product TEXT,   -- purchase_converted=N일 때만: JSON 객체 {name, model, price} - 재상담 시 제안할 제품
    recommended_policy  TEXT,   -- purchase_converted=N일 때만: JSON 객체 {policy_id, name, description} - 연동된 판매정책
    lead_status         TEXT,   -- 가망고객 관리 상태: 미처리/가망고객 등록/후속 접촉 완료/재상담 예정/이탈 (실패건에만 의미 있음)
    next_contact_date   TEXT,   -- 상담사가 지정하는 후속 접촉 예정일 (선택)
    lead_note           TEXT,   -- 상담사가 남기는 메모 (선택) - 개인 식별 정보 입력 금지
    log_date            TEXT,
    source              TEXT    -- manual / ai_transcribed
);

-- 판매정책 마스터 (더미) - 실패 상담 건을 "가망고객"으로 재상담할 때 AI가 근거로 삼는 실제 정책 후보.
-- 프로토타입이라 그럴듯한 정책으로 채워뒀고, 나중에 실제 사내 정책으로 교체하기 쉽도록
-- policy_id/name/description/categories(적용 상품유형, "전체"면 품목 무관) 구조를 유지했다.
-- server/sync_server.py의 SALES_POLICIES와 반드시 값을 맞춰둔다.
CREATE TABLE sales_policies (
    policy_id     TEXT PRIMARY KEY,
    name          TEXT,
    description   TEXT,
    categories    TEXT   -- JSON 배열. ["전체"]면 품목 무관하게 적용 가능
);

-- 매장 공용 로그인 계정을 여러 판매사원이 같이 쓰는 경우를 위한 사원 명단. 상담기록 입력 화면에서
-- "담당 판매사원"을 드롭다운으로 고를 수 있게 하는 용도 (매장 관리자가 별도로 등록/수정하는 기능은
-- 아직 없고, 지금은 초기 명단만 시드로 채운다).
CREATE TABLE store_staff (
    store_id    TEXT REFERENCES stores(store_id),
    staff_name  TEXT
);
""")

# ---------- 지사 ----------
branches = [
    ("BR_SUDOKWON", "수도권영업팀"),
    ("BR_YOUNGNAM", "영남영업팀"),
    ("BR_HONAM", "호남영업팀"),
    ("BR_CHUNGCHEONG", "충청영업팀"),
]
cur.executemany("INSERT INTO branches VALUES (?,?)", branches)

# ---------- 매장 (전국 샘플, 매장명/위치로만 구분 - 사전 유형 라벨 없음) ----------
# channel_type(유통채널: 백화점/로드샵)은 "추천 조합" 기능에서 유통구조별 비교에 쓰는 매장 속성이다.
# 상권 물리정보와 마찬가지로 외부에서 확인 가능한 사실(입점 형태)이라 매장에 미리 붙여도 되는 값.
stores = [
    ("ST001","삼성스토어 강남본점","BR_SUDOKWON","서울","강남구","서울 강남구 테헤란로 123",37.4979,127.0276,"2015-03-01","로드샵"),
    ("ST002","삼성스토어 목동점","BR_SUDOKWON","서울","양천구","서울 양천구 목동로 45",37.5265,126.8748,"2016-07-15","로드샵"),
    ("ST003","삼성스토어 판교점","BR_SUDOKWON","경기","성남시","경기 성남시 분당구 판교역로 231",37.3947,127.1112,"2018-05-20","백화점"),
    ("ST004","삼성스토어 해운대점","BR_YOUNGNAM","부산","해운대구","부산 해운대구 센텀중앙로 90",35.1691,129.1306,"2014-11-10","백화점"),
    ("ST005","삼성스토어 수원영통점","BR_SUDOKWON","경기","수원시","경기 수원시 영통구 광교로 12",37.2636,127.0286,"2017-02-01","로드샵"),
    ("ST006","삼성스토어 대전둔산점","BR_CHUNGCHEONG","대전","서구","대전 서구 둔산로 100",36.3504,127.3845,"2013-09-05","로드샵"),
    ("ST007","삼성스토어 광주상무점","BR_HONAM","광주","서구","광주 서구 상무중앙로 55",35.1526,126.8514,"2019-01-15","로드샵"),
    ("ST008","삼성스토어 일산킨텍스점","BR_SUDOKWON","경기","고양시","경기 고양시 일산서구 킨텍스로 30",37.6688,126.7444,"2020-06-01","로드샵"),
    ("ST009","삼성스토어 부천중동점","BR_SUDOKWON","경기","부천시","경기 부천시 원미구 중동로 210",37.5039,126.7638,"2016-04-11","백화점"),
    ("ST010","삼성스토어 노원점","BR_SUDOKWON","서울","노원구","서울 노원구 상계로 65",37.6541,127.0568,"2015-12-20","로드샵"),
]
cur.executemany("INSERT INTO stores VALUES (?,?,?,?,?,?,?,?,?,?)", stores)

# ---------- 상권분석 (외부에서 확인 가능한 물리적 상권 정보만. 고객유형은 여기 없음) ----------
# 매장 주소 기준 실존하는 최인접 지하철역명 - 더미데이터이지만 "OO 인근역" 같은 placeholder 대신
# 실제 존재하는 역 이름으로 예시를 보여주기 위해 매장별로 지정했다 (거리는 임의값).
NEAREST_SUBWAY_BY_STORE = {
    "ST001": "강남역(2호선)",
    "ST002": "오목교역(5호선)",
    "ST003": "판교역(신분당선)",
    "ST004": "센텀시티역(부산 2호선)",
    "ST005": "광교역(신분당선)",
    "ST006": "정부청사역(대전 1호선)",
    "ST007": "상무역(광주 1호선)",
    "ST008": "킨텍스역(GTX-A)",
    "ST009": "부천시청역(7호선)",
    "ST010": "노원역(4·7호선)",
}
# 경쟁매장을 실제 상호 대신 사내 코드명(X사/H사/A사)으로 순화해서 보여주기 위한 브랜드 라벨.
# label: 화면에 노출하는 코드명, real_name: 내부 참고용 실제 브랜드(더미데이터 주석용, UI에는 label만 노출).
COMPETITOR_BRANDS = [
    {"label": "X사", "real_name": "LG베스트샵"},
    {"label": "H사", "real_name": "롯데하이마트"},
    {"label": "A사", "real_name": "Apple 매장(공인/직영)"},
]
area_rows = []
for s in stores:
    store_id = s[0]
    breakdown = []
    for brand in COMPETITOR_BRANDS:
        # A사(Apple)는 대형 상권에만 있는 경우가 많아 등장 빈도를 낮게, X사/H사는 좀 더 흔하게 배치.
        max_count = 2 if brand["label"] == "A사" else 4
        count = random.randint(0, max_count)
        if count == 0:
            continue
        breakdown.append({
            "label": brand["label"],
            "count": count,
            "nearest_distance_m": random.randint(80, 900),
        })
    comp = sum(b["count"] for b in breakdown)
    office = random.randint(5, 200)
    apt = random.randint(500, 15000)
    foot_traffic = random.randint(40, 95)
    subway = NEAREST_SUBWAY_BY_STORE.get(store_id, f"{s[4]} 인근역")
    breakdown_desc = ", ".join(f"{b['label']} {b['count']}개" for b in breakdown) or "인근 경쟁매장 없음"
    area_rows.append((
        store_id, comp, json.dumps(breakdown, ensure_ascii=False), subway, random.randint(150, 900),
        office, apt, foot_traffic,
        "2026-08-01", f"경쟁매장 {breakdown_desc}, 인근 오피스 {office}개소, 아파트 {apt}세대 추정 (유동인구지수 참고용)"
    ))
cur.executemany("INSERT INTO commercial_area VALUES (?,?,?,?,?,?,?,?,?,?)", area_rows)

# ---------- 매장별 "실측 방문객 성향" 시드 (스키마에 저장되지 않는, 샘플 로그 생성용 내부 가중치일 뿐) ----------
# 실제 서비스에서는 이런 가중치가 없다 - sales_talk_log가 쌓이면 그 자체가 매장의 고객 성향을 보여준다.
# 여기서는 매장마다 그럴듯하게 다른 통계가 나오도록 매장별로 다른 랜덤 성향을 부여해 샘플을 생성할 뿐이다.
age_groups = ["10대", "20대", "30대", "40대", "50대이상"]
gender_options = ["남성", "여성"]
residence_options = ["인근 거주", "인근 직장", "타 지역", "미상"]

def random_weights(n, sharpness=2.5):
    w = [random.random() ** sharpness + 0.05 for _ in range(n)]
    total = sum(w)
    return [x / total for x in w]

store_visit_profile = {
    s[0]: {
        "age": random_weights(len(age_groups)),
        "gender": random_weights(len(gender_options), sharpness=1.5),
        "residence": random_weights(len(residence_options)),
    }
    for s in stores
}

# ---------- 고객 세그먼트 ----------
# 모바일(통신) 중심 세그먼트 3개 + 가전 중심 세그먼트 2개 - 가전 판매 비중이 크므로 반영
segments = [
    ("SEG_UPGRADE","약정만료 임박 업그레이드군","통신사 약정 만료 60일 이내, 최근 2년 이상 기기 미교체","최신 갤럭시 스마트폰","약정 만료 45~60일 전 접촉"),
    ("SEG_FAMILY","가족형 복수기기군","가전+스마트폰 복수 카테고리 구매 이력, 40대 이상","패밀리 결합, 대형가전(TV/냉장고)","명절/이사철 시즌"),
    ("SEG_YOUNG","2030 얼리어답터군","20~30대, 신제품 발매 직후 구매 이력 다수","신모델/웨어러블","신제품 발매 직후 2주"),
    ("SEG_VIP","고액 VIP군","최근 1년 누적구매액 상위 10%","프리미엄 라인업, 트레이드인","연 2회 VIP 전용 프로모션"),
    ("SEG_STUDENT","학생/청소년군","학원가 상권, 10대 고객 또는 학부모 동반","보급형 스마트폰, 태블릿","방학 시즌, 신학기"),
    ("SEG_APPLIANCE_MOVE","이사·혼수 가전 수요군","이사/신혼 예정, 냉장고·세탁기·TV 등 가전 풀세트 구매 문의","냉장고·세탁기·TV 풀세트, 비스포크","이사철(2~4월, 9~11월), 예식 시즌"),
    ("SEG_APPLIANCE_SEASON","계절가전 성수기 수요군","에어컨/제습기 등 계절성 가전 문의, 노후 가전 교체 시기","에어컨, 공기청정기, 제습기","여름 성수기 진입 전(4~5월), 환절기"),
]
cur.executemany("INSERT INTO customer_segments VALUES (?,?,?,?,?)", segments)

# ---------- 세일즈톡 템플릿 ----------
# product_category: 스마트폰/태블릿/웨어러블(모바일) 또는 TV/냉장고/세탁기/에어컨/청소기/기타가전(가전)
scripts = [
    ("SC001","약정만료","고객님 약정 만료가 얼마 안 남으셨네요. 지금 갈아타시면 위약금 없이 최신 모델로 넘어가실 수 있어요.","SEG_UPGRADE","스마트폰"),
    ("SC002","가족결합","가족 회선을 같이 묶으시면 결합할인에 가전 구매 시 추가 캐시백까지 받으실 수 있어요.","SEG_FAMILY","기타가전"),
    ("SC003","신제품","이번에 새로 나온 모델이 카메라랑 배터리가 특히 좋아졌어요. 지금 사전예약하시면 사은품도 같이 드려요.","SEG_YOUNG","스마트폰"),
    ("SC004","VIP트레이드인","기존 기기 반납하시면 시세보다 더 쳐드리는 트레이드인 프로그램이 있어서 부담 훨씬 줄어드실 거예요.","SEG_VIP","스마트폰"),
    # 학생증 지참 기반 "학생 할인"은 실제 회사 정책에 없는 내용이라 제외 - 보급형 모델 추천 +
    # 태블릿 구매 시 액세서리 증정(다른 매장에도 있는 일반 프로모션 성격)으로 대체했다.
    ("SC005","청소년 프로모션","보급형 모델도 최신 기능은 다 갖추고 있어서 학생 고객님께도 추천드리기 좋아요. 태블릿을 같이 구매하시면 액세서리를 증정해드립니다.","SEG_STUDENT","태블릿"),
    ("SC006","가전풀세트","이사/혼수시라면 냉장고·세탁기·TV를 풀세트로 묶으시는 게 개별구매보다 훨씬 유리해요. 배송·설치 일정도 한 번에 맞춰드려요.","SEG_APPLIANCE_MOVE","냉장고"),
    ("SC007","계절가전","이맘때 에어컨은 예약설치가 밀리기 전에 미리 결정하시는 게 좋아요. 구형 대비 전기요금도 확 줄어들어요.","SEG_APPLIANCE_SEASON","에어컨"),
    ("SC008","프리미엄가전","비스포크 라인은 색상·디자인을 주방에 맞춰 고르실 수 있어서, 인테리어까지 신경쓰시는 분들 반응이 좋아요.","SEG_APPLIANCE_MOVE","기타가전"),
]
cur.executemany("INSERT INTO talk_scripts VALUES (?,?,?,?,?)", scripts)

# ---------- 고객 (매장별 20명) ----------
carriers = ["SKT","KT","LGU+","알뜰폰"]
tiers = ["VIP","GOLD","SILVER","GENERAL"]
categories = ["스마트폰","태블릿","TV","냉장고","세탁기","에어컨","청소기","웨어러블","기타가전"]
seg_ids = [s[0] for s in segments]

# ---------- 상담 상품유형 (모바일 vs 가전) ----------
# 가전 판매 비중이 큰 매장 특성을 반영해 모바일:가전 비중을 대략 45:55로 설정
PRODUCT_CATEGORIES = ["스마트폰","태블릿","웨어러블","TV","냉장고","세탁기","에어컨","청소기","기타가전"]
PRODUCT_CATEGORY_WEIGHTS = [28, 9, 8,   12, 11, 9, 10, 6, 7]  # 모바일 45 : 가전 55
PRODUCT_GROUP = {
    "스마트폰": "모바일", "태블릿": "모바일", "웨어러블": "모바일",
    "TV": "가전", "냉장고": "가전", "세탁기": "가전", "에어컨": "가전", "청소기": "가전", "기타가전": "가전",
}
SCRIPT_PRODUCT_CATEGORY = {s[0]: s[4] for s in scripts}

# ---------- 구매유형(추천 조합 집계용) + 구매 품목 예시 + 실패 케이스 샘플 텍스트 ----------
# web/js/app.js의 추천 조합 1단계 "상담 유형 선택" 타일(혼수/입주/이사/모바일/즉시상담)과 값이 동일해야
# 상담기록 태깅과 추천 검색 필터가 서로 맞물린다. 즉시상담 = 다품목 조합이 아닌 단품 즉시 추천.
PURCHASE_OCCASIONS = ["혼수", "입주", "이사", "모바일", "즉시상담"]
# 추천 조합 결과 화면에서 "모델명만 나열"이 아니라 출고가까지 같이 보여주기 위한 카탈로그.
# 모델명/가격은 samsung.com(제품 상세페이지) 및 삼성뉴스룸 보도자료 검색 결과를 참고해 만든 참고용
# 더미데이터다 - 실제 판매가/재고와는 다를 수 있고, 실시간 가격 연동이 아니다 (프로토타입 목적).
# "fit"은 거주인원수/평형대/설치환경 같은 고객 라이프스타일 조건에 이 모델이 잘 맞는다는 태그로,
# server/sync_server.py의 pick_best_product()가 이 태그를 보고 카테고리별 모델 하나를 특정한다.
# 값은 server/sync_server.py의 PRODUCT_CATALOG와 반드시 동일하게 맞춰둔다.
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
# FAILURE_REASONS/COACH_FEEDBACKS/CUSTOMER_NEEDS는 같은 인덱스끼리 짝지어 쓴다(실패 사유 i번 ↔
# 코칭 피드백 i번 ↔ 고객 니즈 i번) - 서로 관련 없는 조합이 섞이지 않도록 하기 위함. 실사용
# 서버(sync_server.py)에서는 AI가 실제 상담 맥락에 맞게 이 세 가지를 함께 생성하고, 이 더미
# 리스트는 AI 없이 샘플 데이터를 만들 때만 쓰는 자리채움용이다.
FAILURE_REASONS = [
    "가격 안내가 늦게 나와 고객이 다른 매장과 비교할 시간을 갖고 이탈함",
    "원하는 색상/사양 재고가 없어 고객이 결정을 미룸",
    "결합 혜택 설명이 충분히 전달되지 않아 구매 필요성을 못 느낌",
    "경쟁사 프로모션 대비 강점을 구체적으로 제시하지 못함",
    "설치/배송 일정에 대한 확신을 주지 못해 보류함",
]
COACH_FEEDBACKS = [
    "가격 안내를 상담 초반에 먼저 제시하고, 할부/캐시백 옵션을 함께 설명해보세요.",
    "재고 없는 사양은 대체 모델이나 입고 일정을 바로 안내하는 스크립트를 준비해두세요.",
    "가족결합/트레이드인 혜택을 숫자로 구체화해서 설명하면 설득력이 올라갑니다.",
    "경쟁사 대비 차별점(AS, 사은품 등)을 3줄 이내로 정리해 상담 초반에 언급해보세요.",
    "배송/설치 예약을 상담 자리에서 바로 잡아주면 이탈을 줄일 수 있습니다.",
]
# "고객이 원하는 바" - 실패 사유의 이면에서 고객이 실제로 기다리고 있는 조건. 판매사원에게
# 재상담 시 1차로 제공되는 진단 문구다 (프로토타입: AI 없이는 이 템플릿을, AI 있으면 실제
# 상담 맥락 기반 문장을 사용 - server/sync_server.py 참고).
CUSTOMER_NEEDS = [
    "다른 매장과 비교할 수 있게 경쟁력 있는 가격/혜택을 먼저 확인하고 싶어함",
    "원하는 색상/사양이 입고되면 바로 구매할 의향 - 입고 시점 안내를 원함",
    "결합/가족할인 등으로 실제 얼마나 절감되는지 구체적인 금액으로 확인하고 싶어함",
    "경쟁사 대비 이 매장만의 차별화된 혜택(AS/사은품 등)을 비교해보고 싶어함",
    "명확한 배송/설치 일정을 먼저 확정받고 싶어함",
]

# 판매정책 마스터 (더미) - "가망고객" 재상담 시 추천 제품과 함께 안내할 실제 정책 후보.
# categories가 "전체"면 품목 무관하게 적용 가능. server/sync_server.py의 SALES_POLICIES와
# 값을 반드시 맞춰둔다.
SALES_POLICIES = [
    {"policy_id": "POLICY01", "name": "무이자 할부 12개월", "description": "전 품목 12개월 무이자 할부 적용 가능 (카드사별 상이)", "categories": ["전체"]},
    {"policy_id": "POLICY02", "name": "구형기기 트레이드인 추가지원", "description": "기존 사용 기기 반납 시 시세 대비 추가 보상", "categories": ["스마트폰", "태블릿"]},
    {"policy_id": "POLICY03", "name": "가전 2종 이상 결합 캐시백", "description": "가전 2개 이상 동시구매 시 캐시백 최대 10만원", "categories": ["TV", "냉장고", "세탁기", "에어컨", "청소기", "기타가전"]},
    {"policy_id": "POLICY04", "name": "이사철 배송·설치 우선예약", "description": "이사/입주 고객 대상 배송·설치 일정 우선 예약", "categories": ["냉장고", "세탁기", "TV", "에어컨"]},
    {"policy_id": "POLICY05", "name": "웨어러블 동시구매 사은품", "description": "스마트폰과 워치/버즈 동시구매 시 사은품 증정", "categories": ["스마트폰", "웨어러블"]},
    {"policy_id": "POLICY06", "name": "시즌 가전 조기구매 할인", "description": "에어컨/청소기 시즌 조기구매 시 할인 적용", "categories": ["에어컨", "청소기"]},
]

def pick_best_policy(categories):
    """카테고리 목록과 겹치는 정책 중 가장 구체적인(= "전체"가 아니면서 겹치는 항목이 많은) 정책을
    고른다. server/sync_server.py의 pick_best_policy와 동일한 로직 - 항상 서버가 결정적으로
    고르고, AI는 이 결과를 문구로만 다듬는다."""
    cat_set = set(categories or [])
    if not cat_set:
        return None
    scored = []
    for p in SALES_POLICIES:
        p_cats = set(p["categories"])
        if "전체" in p_cats:
            scored.append((0, p))
        else:
            overlap = len(cat_set & p_cats)
            if overlap:
                scored.append((overlap, p))
    if not scored:
        return None
    scored.sort(key=lambda t: -t[0])
    return scored[0][1]

def build_sms_template(store_name, product, policy):
    """OPENAI_API_KEY 없이도(또는 더미데이터 생성 시) 항상 뭔가 보여줄 수 있는 결정적 문자메시지
    템플릿. 실제 발송은 상담사가 직접 하고, 이 앱은 문자를 발송하지 않는다 - 초안 텍스트만 만든다."""
    parts = [f"[{store_name}] 안녕하세요, 지난 상담 관련해서 연락드립니다."]
    if product:
        parts.append(f"문의주셨던 {product['name']} 관련해서 안내드리고 싶은 소식이 있어요.")
    if policy:
        parts.append(f"현재 '{policy['name']}' 혜택({policy['description']})도 함께 적용 가능합니다.")
    parts.append("편하실 때 말씀 주시면 자세히 안내드릴게요. 감사합니다.")
    return " ".join(parts)


# ---------- 판매정책 마스터 ----------
policy_rows = [
    (p["policy_id"], p["name"], p["description"], json.dumps(p["categories"], ensure_ascii=False))
    for p in SALES_POLICIES
]
cur.executemany("INSERT INTO sales_policies VALUES (?,?,?,?)", policy_rows)


def occasion_for_category(cat):
    # weights 순서: 혼수, 입주, 이사, 모바일, 즉시상담
    if cat in ("스마트폰", "웨어러블"):
        return random.choices(PURCHASE_OCCASIONS, weights=[5, 5, 5, 60, 25])[0]
    if cat == "태블릿":
        return random.choices(PURCHASE_OCCASIONS, weights=[5, 5, 5, 30, 55])[0]
    return random.choices(PURCHASE_OCCASIONS, weights=[30, 25, 25, 5, 15])[0]

customers = []
cid = 1
for s in stores:
    store_id = s[0]
    for _ in range(20):
        customer_id = f"CUST{cid:05d}"
        age = random.choice(age_groups)
        gender = random.choice(["남성","여성"])
        tier = random.choices(tiers, weights=[5,15,35,45])[0]
        carrier = random.choice(carriers)
        contract_end = (datetime(2026,8,5) + timedelta(days=random.randint(-30,180))).strftime("%Y-%m-%d")
        last_purchase = (datetime(2026,8,5) - timedelta(days=random.randint(10,900))).strftime("%Y-%m-%d")
        category = random.choice(categories)
        cycle = random.choice([12,18,24,30,36])
        amount = random.randint(300000, 5000000)
        seg = random.choice(seg_ids)
        # 상담로그(log_date)와 같은 기준일(2026-08-05)로 분포시켜, 대시보드의 "오늘(최근 영업일)"
        # 기준 일계 집계가 상담로그와 같은 날짜 범위에서 자연스럽게 맞물리게 한다.
        registered = (datetime(2026,8,5) - timedelta(days=random.randint(0,120))).strftime("%Y-%m-%d")
        customers.append((customer_id, store_id, age, gender, tier, carrier, contract_end,
                           last_purchase, category, cycle, amount, seg, registered))
        cid += 1
cur.executemany("INSERT INTO customers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", customers)

# ---------- 세일즈톡 로그 (샘플, source 구분: manual vs ai_transcribed) ----------
wow_points = [
    "트레이드인 가격을 듣고 눈이 커짐","가족결합 할인폭에 놀람","신제품 카메라 시연에 반응 좋음",
    "무이자 할부 안내에 긍정적","기존 대비 배터리 개선폭에 관심","사은품 구성에 만족"
]
decision_points = [
    "월 납부금 부담 완화가 결정적","트레이드인 가격이 결정타","가족 모두 결합하는 조건이 핵심",
    "품절 임박 안내가 구매를 앞당김","전작 대비 차별점 설명이 설득력 있었음","사은품/액세서리 구성"
]
reactions = ["긍정","중립","부정"]

# 데모 로그인 계정(server/sync_server.py의 ACCOUNTS)과 실제로 매칭되는 상담사는 이 두 매장뿐이다.
# staff_id를 전부 STAFF01~05로만 채우면 로그인해서 "내 실패 피드백"을 눌러도 항상 0건이 되어
# 데모가 텅 비어 보인다 - 해당 매장 로그의 일부는 실제 로그인 계정으로 채워서 데모가 바로 보이게 한다.
DEMO_STAFF_BY_STORE = {"ST001": "staff_gangnam", "ST004": "staff_haeundae"}

# 매장 공용 로그인 계정 하나를 여러 실제 판매사원이 같이 쓰므로, staff_id(로그인)와 별개로
# 실제 담당자 이름을 매장별로 몇 명씩 배정해 샘플 데이터에 다양성을 준다.
CONSULTANT_NAME_POOL = ["김민준","이서연","박도윤","최지우","정하은","강시우","윤서준","임하윤","조은우","한소율"]

logs = []
staff_roster_rows = []
lid = 1
for s in stores:
    store_id = s[0]
    profile = store_visit_profile[store_id]
    staff_pool = [f"STAFF{n:02d}" for n in range(1, 6)]
    if store_id in DEMO_STAFF_BY_STORE:
        staff_pool = staff_pool + [DEMO_STAFF_BY_STORE[store_id]] * 3
    consultant_pool = random.sample(CONSULTANT_NAME_POOL, 3)
    staff_roster_rows.extend((store_id, name) for name in consultant_pool)
    for _ in range(30):
        seg = random.choice(seg_ids)
        script = next((sc[0] for sc in scripts if sc[3] == seg), random.choice(scripts)[0])
        reaction = random.choices(reactions, weights=[55,30,15])[0]
        converted = "Y" if reaction == "긍정" and random.random() < 0.6 else ("Y" if random.random() < 0.1 else "N")
        source = random.choices(["manual","ai_transcribed"], weights=[70,30])[0]
        # 상담원이 실제 상담 중 판단해 태깅했다고 가정한 값 - 매장별로 다른 방문객 성향을 반영해 샘플링
        age_group = random.choices(age_groups, weights=profile["age"])[0]
        gender = "미상" if random.random() < 0.05 else random.choices(gender_options, weights=profile["gender"])[0]
        residence_area = random.choices(residence_options, weights=profile["residence"])[0]
        # 상품유형: 선택된 세일즈톡과 같은 계열일 확률이 높되(실제 상담 흐름 반영), 가끔 다른 상품 문의도 섞임
        if random.random() < 0.7:
            product_category = SCRIPT_PRODUCT_CATEGORY.get(script, random.choices(PRODUCT_CATEGORIES, weights=PRODUCT_CATEGORY_WEIGHTS)[0])
        else:
            product_category = random.choices(PRODUCT_CATEGORIES, weights=PRODUCT_CATEGORY_WEIGHTS)[0]
        purchase_occasion = occasion_for_category(product_category)
        # 상담 상품유형은 다중 선택이 가능하다 - 실제로도 "TV 보러 왔다가 냉장고도 같이 문의"하는 식으로
        # 같은 상담에서 여러 상품유형이 같이 논의되는 경우가 있어, 25% 확률로 같은 대분류(모바일/가전)
        # 안에서 두번째 상품유형을 추가한다. product_category는 이 목록의 첫 값(기존 단일값 통계 호환용).
        categories_list = [product_category]
        if random.random() < 0.25:
            same_group_candidates = [c for c in PRODUCT_CATEGORIES if c != product_category and PRODUCT_GROUP.get(c) == PRODUCT_GROUP.get(product_category)]
            if same_group_candidates:
                categories_list.append(random.choice(same_group_candidates))
        # 구매 품목(모델명)은 선택 입력 항목이라 실제로도 절반 정도만 채워지는 걸 반영
        catalog_options = PRODUCT_CATALOG.get(product_category, [])
        purchased_item = random.choice(catalog_options)["name"] if random.random() < 0.5 and catalog_options else ""

        # 가망고객화 관련 필드 - 실패 건(converted=="N")에만 값을 채운다. 실사용 서버에서는 이걸
        # AI(또는 템플릿 폴백)가 저장 시점에 자동으로 만들어주지만, 샘플 데이터는 같은 인덱스로
        # 짝지은 더미 리스트에서 그대로 가져와 채운다.
        if converted == "N":
            fi = random.randrange(len(FAILURE_REASONS))
            failure_reason = FAILURE_REASONS[fi]
            coach_feedback = COACH_FEEDBACKS[fi]
            customer_need = CUSTOMER_NEEDS[fi]
            rec_product = catalog_options[0] if catalog_options else None
            rec_policy = pick_best_policy(categories_list)
            sms_message = build_sms_template(s[1], rec_product, rec_policy)
            recommended_product_json = json.dumps(rec_product, ensure_ascii=False) if rec_product else ""
            recommended_policy_json = json.dumps(rec_policy, ensure_ascii=False) if rec_policy else ""
            # 실제로는 상담사가 이후 계속 관리하는 값이라, 샘플에서는 절반 정도만 진행 상태를 부여하고
            # 나머지는 "미처리"로 남겨 실제 운영 초기 모습과 비슷하게 한다.
            lead_status = random.choices(
                ["미처리", "가망고객 등록", "재상담 예정", "후속 접촉 완료", "이탈"],
                weights=[45, 20, 15, 10, 10],
            )[0]
            next_contact_date = (
                (datetime(2026, 8, 5) + timedelta(days=random.randint(1, 20))).strftime("%Y-%m-%d")
                if lead_status in ("가망고객 등록", "재상담 예정") else ""
            )
            lead_note = random.choice(["", "", "", "다음 방문 시 재안내 예정", "전화 재상담 예정"])
        else:
            failure_reason = ""
            coach_feedback = ""
            customer_need = ""
            sms_message = ""
            recommended_product_json = ""
            recommended_policy_json = ""
            lead_status = ""
            next_contact_date = ""
            lead_note = ""

        logs.append((
            f"LOG{lid:05d}", store_id, random.choice(staff_pool), random.choice(consultant_pool),
            age_group, gender, residence_area,
            product_category, json.dumps(categories_list, ensure_ascii=False), purchase_occasion, purchased_item, seg, script, reaction,
            random.choice(wow_points), random.choice(decision_points), converted, failure_reason, coach_feedback,
            customer_need, sms_message, recommended_product_json, recommended_policy_json,
            lead_status, next_contact_date, lead_note,
            (datetime(2026,8,5) - timedelta(days=random.randint(0,120))).strftime("%Y-%m-%d"),
            source
        ))
        lid += 1
cur.executemany(
    "INSERT INTO sales_talk_log VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    logs,
)
cur.executemany("INSERT INTO store_staff VALUES (?,?)", staff_roster_rows)

conn.commit()

# ---------- JSON 내보내기 (웹앱 오프라인 로딩용) ----------
def dump_table(name):
    cur.execute(f"SELECT * FROM {name}")
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]

sales_talk_log_rows = dump_table("sales_talk_log")
for row in sales_talk_log_rows:
    # SQLite에는 JSON 문자열로 저장했으니, JSON 파일로 내보낼 때는 실제 배열로 풀어서
    # web/js/app.js가 바로 배열로 쓸 수 있게 한다.
    raw = row.get("product_categories")
    try:
        row["product_categories"] = json.loads(raw) if raw else ([row["product_category"]] if row.get("product_category") else [])
    except (TypeError, ValueError):
        row["product_categories"] = [row["product_category"]] if row.get("product_category") else []

    # recommended_product / recommended_policy도 JSON 객체 문자열로 저장했으니 실제 객체로 풀어준다.
    # 상담성공(purchase_converted=Y) 건은 값이 없으므로 None으로 남긴다.
    raw_prod = row.get("recommended_product")
    try:
        row["recommended_product"] = json.loads(raw_prod) if raw_prod else None
    except (TypeError, ValueError):
        row["recommended_product"] = None

    raw_policy = row.get("recommended_policy")
    try:
        row["recommended_policy"] = json.loads(raw_policy) if raw_policy else None
    except (TypeError, ValueError):
        row["recommended_policy"] = None

sales_policies_rows = dump_table("sales_policies")
for row in sales_policies_rows:
    raw = row.get("categories")
    try:
        row["categories"] = json.loads(raw) if raw else []
    except (TypeError, ValueError):
        row["categories"] = []

commercial_area_rows = dump_table("commercial_area")
for row in commercial_area_rows:
    # competitor_breakdown도 SQLite에는 JSON 문자열로 저장했으니, product_categories와 마찬가지로
    # export 시 실제 배열로 풀어준다.
    raw = row.get("competitor_breakdown")
    try:
        row["competitor_breakdown"] = json.loads(raw) if raw else []
    except (TypeError, ValueError):
        row["competitor_breakdown"] = []

export = {
    "branches": dump_table("branches"),
    "stores": dump_table("stores"),
    "commercial_area": commercial_area_rows,
    "customer_segments": dump_table("customer_segments"),
    "customers": dump_table("customers"),
    "talk_scripts": dump_table("talk_scripts"),
    "sales_talk_log": sales_talk_log_rows,
    "store_staff": dump_table("store_staff"),
    "sales_policies": sales_policies_rows,
    "generated_at": datetime.now().isoformat()
}

with open("store_data.json", "w", encoding="utf-8") as f:
    json.dump(export, f, ensure_ascii=False, indent=2)

# ---------- 참고자료 JSON (상담사용, 비민감정보만) ----------
# web/data/public_reference.json은 이전엔 수기로 관리했는데, 세그먼트/스크립트가 바뀔 때마다
# 두 곳을 따로 고쳐야 해서 어긋나기 쉬웠다. 이제 DB 내보내기 시 여기서 같이 생성해 항상 동기화한다.
public_reference = {
    "customer_segments": export["customer_segments"],
    "talk_scripts": export["talk_scripts"],
    "generated_at": export["generated_at"],
}
import os
web_data_dir = os.path.join("..", "web", "data")
if os.path.isdir(web_data_dir):
    with open(os.path.join(web_data_dir, "public_reference.json"), "w", encoding="utf-8") as f:
        json.dump(public_reference, f, ensure_ascii=False, indent=2)
    print(f"public_reference.json 갱신 완료 ({web_data_dir})")

conn.close()
print(f"DB 생성 완료: {len(stores)}개 매장, {len(customers)}명 고객, {len(logs)}건 상담로그")

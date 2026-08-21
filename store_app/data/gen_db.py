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
    competitor_count    INTEGER,   -- 반경 500m 내 경쟁 매장 수 (하이마트/전자랜드/타통신사대리점 등)
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
    product_category    TEXT,   -- 상담원 버튼 선택: 스마트폰/태블릿/웨어러블/TV/냉장고/세탁기/에어컨/청소기/기타가전
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
    log_date            TEXT,
    source              TEXT    -- manual / ai_transcribed
);
""")

# ---------- 지사 ----------
branches = [
    ("BR_SUDOKWON", "수도권지사"),
    ("BR_YOUNGNAM", "영남지사"),
    ("BR_HONAM", "호남지사"),
    ("BR_CHUNGCHEONG", "충청지사"),
]
cur.executemany("INSERT INTO branches VALUES (?,?)", branches)

# ---------- 매장 (전국 샘플, 매장명/위치로만 구분 - 사전 유형 라벨 없음) ----------
# channel_type(유통채널: 백화점/로드샵)은 "추천 조합" 기능에서 유통구조별 비교에 쓰는 매장 속성이다.
# 상권 물리정보와 마찬가지로 외부에서 확인 가능한 사실(입점 형태)이라 매장에 미리 붙여도 되는 값.
stores = [
    ("ST001","삼성디지털프라자 강남본점","BR_SUDOKWON","서울","강남구","서울 강남구 테헤란로 123",37.4979,127.0276,"2015-03-01","로드샵"),
    ("ST002","삼성디지털프라자 목동점","BR_SUDOKWON","서울","양천구","서울 양천구 목동로 45",37.5265,126.8748,"2016-07-15","로드샵"),
    ("ST003","삼성디지털프라자 판교점","BR_SUDOKWON","경기","성남시","경기 성남시 분당구 판교역로 231",37.3947,127.1112,"2018-05-20","백화점"),
    ("ST004","삼성디지털프라자 해운대점","BR_YOUNGNAM","부산","해운대구","부산 해운대구 센텀중앙로 90",35.1691,129.1306,"2014-11-10","백화점"),
    ("ST005","삼성디지털프라자 수원영통점","BR_SUDOKWON","경기","수원시","경기 수원시 영통구 광교로 12",37.2636,127.0286,"2017-02-01","로드샵"),
    ("ST006","삼성디지털프라자 대전둔산점","BR_CHUNGCHEONG","대전","서구","대전 서구 둔산로 100",36.3504,127.3845,"2013-09-05","로드샵"),
    ("ST007","삼성디지털프라자 광주상무점","BR_HONAM","광주","서구","광주 서구 상무중앙로 55",35.1526,126.8514,"2019-01-15","로드샵"),
    ("ST008","삼성디지털프라자 일산킨텍스점","BR_SUDOKWON","경기","고양시","경기 고양시 일산서구 킨텍스로 30",37.6688,126.7444,"2020-06-01","로드샵"),
    ("ST009","삼성디지털프라자 부천중동점","BR_SUDOKWON","경기","부천시","경기 부천시 원미구 중동로 210",37.5039,126.7638,"2016-04-11","백화점"),
    ("ST010","삼성디지털프라자 노원점","BR_SUDOKWON","서울","노원구","서울 노원구 상계로 65",37.6541,127.0568,"2015-12-20","로드샵"),
]
cur.executemany("INSERT INTO stores VALUES (?,?,?,?,?,?,?,?,?,?)", stores)

# ---------- 상권분석 (외부에서 확인 가능한 물리적 상권 정보만. 고객유형은 여기 없음) ----------
area_rows = []
for s in stores:
    store_id = s[0]
    comp = random.randint(1, 8)
    office = random.randint(5, 200)
    apt = random.randint(500, 15000)
    foot_traffic = random.randint(40, 95)
    area_rows.append((
        store_id, comp, f"{s[4]} 인근역", random.randint(150, 900),
        office, apt, foot_traffic,
        "2026-08-01", f"경쟁매장 {comp}개, 인근 오피스 {office}개소, 아파트 {apt}세대 추정 (유동인구지수 참고용)"
    ))
cur.executemany("INSERT INTO commercial_area VALUES (?,?,?,?,?,?,?,?,?)", area_rows)

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
    ("SC005","학생할인","학생증 지참하시면 별도 학생 할인 적용되고, 태블릿 같이 구매하시면 액세서리 증정해드려요.","SEG_STUDENT","태블릿"),
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
MODEL_EXAMPLES = {
    "스마트폰": ["갤럭시 S25", "갤럭시 Z플립7", "갤럭시 Z폴드7", "갤럭시 A56"],
    "태블릿": ["갤럭시 탭 S10", "갤럭시 탭 A9"],
    "웨어러블": ["갤럭시 워치8", "갤럭시 버즈3"],
    "TV": ["QLED 65형", "OLED 77형", "Neo QLED 55형"],
    "냉장고": ["비스포크 냉장고 4도어", "비스포크 냉장고 키친핏"],
    "세탁기": ["비스포크 그랑데 AI", "일반형 드럼세탁기"],
    "에어컨": ["무풍에어컨 갤러리", "무풍에어컨 스탠드"],
    "청소기": ["비스포크 제트", "비스포크 제트 AI"],
    "기타가전": ["비스포크 큐커", "제스퍼 공기청정기"],
}
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
lid = 1
for s in stores:
    store_id = s[0]
    profile = store_visit_profile[store_id]
    staff_pool = [f"STAFF{n:02d}" for n in range(1, 6)]
    if store_id in DEMO_STAFF_BY_STORE:
        staff_pool = staff_pool + [DEMO_STAFF_BY_STORE[store_id]] * 3
    consultant_pool = random.sample(CONSULTANT_NAME_POOL, 3)
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
        # 구매 품목(모델명)은 선택 입력 항목이라 실제로도 절반 정도만 채워지는 걸 반영
        purchased_item = random.choice(MODEL_EXAMPLES.get(product_category, [])) if random.random() < 0.5 and MODEL_EXAMPLES.get(product_category) else ""
        if converted == "N":
            failure_reason = random.choice(FAILURE_REASONS)
            coach_feedback = random.choice(COACH_FEEDBACKS)
        else:
            failure_reason = ""
            coach_feedback = ""
        logs.append((
            f"LOG{lid:05d}", store_id, random.choice(staff_pool), random.choice(consultant_pool),
            age_group, gender, residence_area,
            product_category, purchase_occasion, purchased_item, seg, script, reaction,
            random.choice(wow_points), random.choice(decision_points), converted, failure_reason, coach_feedback,
            (datetime(2026,8,5) - timedelta(days=random.randint(0,120))).strftime("%Y-%m-%d"),
            source
        ))
        lid += 1
cur.executemany("INSERT INTO sales_talk_log VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", logs)

conn.commit()

# ---------- JSON 내보내기 (웹앱 오프라인 로딩용) ----------
def dump_table(name):
    cur.execute(f"SELECT * FROM {name}")
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]

export = {
    "branches": dump_table("branches"),
    "stores": dump_table("stores"),
    "commercial_area": dump_table("commercial_area"),
    "customer_segments": dump_table("customer_segments"),
    "customers": dump_table("customers"),
    "talk_scripts": dump_table("talk_scripts"),
    "sales_talk_log": dump_table("sales_talk_log"),
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

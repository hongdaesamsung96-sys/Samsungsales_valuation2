/*
 * 삼성전자판매 매장 상권/고객/세일즈톡 분석 앱 (역할 기반 접근제어 버전)
 * 순수 vanilla JS - Capacitor WebView 및 일반 브라우저 모두에서 동작
 *
 * 정책: 데이터 분석 내역(상권분석/통계/전체 상담로그)은 본사·지사 관리자만 조회 가능.
 *       상담사는 세일즈톡 참고자료 조회 + 자기 매장 로그 입력만 가능.
 * 실제 인가는 서버(server/sync_server.py)가 토큰 role/scope로 강제하며, 이 파일의 화면 분기는
 * 그 서버 응답을 그대로 반영하는 것일 뿐 그 자체가 보안 경계는 아니다.
 */

const API_BASE = window.STORE_APP_API_BASE || "";
const SYNC_TIMEOUT_MS = 4000;
const SESSION_KEY = "store_app_session";

let session = null;        // {token, role, displayName, storeId, branchId, userId}
let publicRef = null;      // {customer_segments, talk_scripts} - 항상 로컬 번들에서 로드 (비민감정보)
let managerData = null;    // 관리자 전용 스코프 데이터
let consultantBundle = null; // 상담사 전용 번들 (본인 매장 기본정보 + 참고자료)
let sessionLogs = [];      // 상담사가 이번 세션에 입력한 로그 (조회 권한 없이 자기 입력 확인용, 서버 GET 없음)
let currentStoreId = null;  // 관리자 화면에서 드릴다운으로 선택된 매장(레벨3)
let currentBranchId = null; // 관리자 화면에서 선택된 영업팀(레벨2) - branch_manager/store_manager는 자기 영업팀으로 고정
let managerViewLevel = "store"; // 'compare'(본사 전체비교) | 'branch'(영업팀 집계+매장목록) | 'store'(매장 단위 탭)
let branchInsightCache = null; // /api/branch_insight 응답 캐시 - 동기화 전까지는 재호출하지 않는다

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2400);
}

function fetchWithTimeout(url, opts = {}, ms = SYNC_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(id));
}

function authHeaders() {
  return session ? { Authorization: `Bearer ${session.token}` } : {};
}

async function api(path, opts = {}) {
  const res = await fetchWithTimeout(`${API_BASE}${path}`, {
    ...opts,
    headers: { ...(opts.headers || {}), ...authHeaders() },
  });
  if (res.status === 401) {
    doLogout("세션이 만료됐습니다. 다시 로그인해주세요.");
    throw new Error("unauthorized");
  }
  return res;
}

/* ---------------- 세션 저장/복원 ---------------- */
function saveSession() {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}
function restoreSession() {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function cacheKeyFor(userId, kind) {
  return `store_app_cache_${kind}_${userId}`;
}

/* ---------------- 화면 전환 ---------------- */
function showScreen(name) {
  $("#loginScreen").style.display = name === "login" ? "flex" : "none";
  $("#consultantApp").style.display = name === "consultant" ? "flex" : "none";
  $("#managerApp").style.display = name === "manager" ? "flex" : "none";
}

/* ---------------- 로그인 ---------------- */
// API_BASE가 빈 문자열이면 "설정 안 됨"이 아니라 "같은 서버(같은 origin)에서 API를 호출하라"는
// 정상적인 기본값이다 (지금 배포 구조: 프론트+백엔드가 같은 프로세스/같은 URL). 그래서 API_BASE가
// 비어 있다고 로그인을 막으면 안 된다 - 예전에 프론트/백엔드를 분리 배포하던 구조의 잔재 체크였는데
// 지금은 틀린 체크라 제거했다.
async function doLogin(userId, password) {
  const errBox = $("#loginError");
  errBox.textContent = "";
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, password }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      errBox.textContent = body.error === "invalid credentials" ? "아이디 또는 비밀번호가 올바르지 않습니다." : "로그인에 실패했습니다.";
      return;
    }
    const data = await res.json();
    session = {
      token: data.token,
      role: data.role,
      displayName: data.display_name,
      storeId: data.store_id || null,
      branchId: data.branch_id || null,
      userId,
    };
    saveSession();
    await afterLogin();
  } catch (e) {
    errBox.textContent = "서버에 연결할 수 없습니다. 네트워크 상태를 확인해주세요.";
  }
}

function doLogout(message) {
  session = null;
  managerData = null;
  consultantBundle = null;
  sessionLogs = [];
  clearSession();
  showScreen("login");
  if (message) toast(message);
}

async function afterLogin() {
  if (session.role === "staff") {
    await loadConsultantData();
    renderConsultant();
    showScreen("consultant");
  } else if (session.role === "branch_manager" || session.role === "hq_manager" || session.role === "store_manager") {
    await loadManagerData();
    renderManagerAll();
    showScreen("manager");
  } else {
    doLogout("알 수 없는 권한입니다.");
  }
}

/* ---------------- 데이터 로드 ---------------- */
async function loadPublicReference() {
  const res = await fetch("data/public_reference.json");
  publicRef = await res.json();
}

async function loadConsultantData() {
  const cacheKey = cacheKeyFor(session.userId, "consultant");
  try {
    const res = await api("/api/consultant/bundle");
    if (res.ok) {
      consultantBundle = await res.json();
      localStorage.setItem(cacheKey, JSON.stringify(consultantBundle));
      setConsultantSyncStatus(true);
      return;
    }
  } catch (e) {
    /* 폴백으로 진행 */
  }
  setConsultantSyncStatus(false);
  const cached = localStorage.getItem(cacheKey);
  consultantBundle = cached ? JSON.parse(cached) : { store: null, customer_segments: publicRef.customer_segments, talk_scripts: publicRef.talk_scripts };
}

async function loadManagerData() {
  const cacheKey = cacheKeyFor(session.userId, "manager");
  try {
    const res = await api("/api/manager/export");
    if (res.ok) {
      managerData = await res.json();
      localStorage.setItem(cacheKey, JSON.stringify(managerData));
      setManagerSyncStatus(true);
      setupManagerNavDefaults();
      return;
    }
  } catch (e) {
    /* 폴백으로 진행 */
  }
  setManagerSyncStatus(false);
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    managerData = JSON.parse(cached);
    setupManagerNavDefaults();
  }
}

// 역할별로 관리자 화면이 처음 보여줄 "레벨"과 선택값을 정한다.
//   - hq_manager: 기본은 '전체 영업팀 비교'(compare). 이전에 특정 영업팀/매장을 보고 있었다면
//     (새로고침 등으로) 그 위치를 그대로 복원한다.
//   - branch_manager: 영업팀이 자기 소속 하나뿐이라 늘 그 영업팀으로 고정하고, 기본 화면은
//     '우리 영업팀 현황'(branch) - 예전처럼 특정 매장이 바로 뜨지 않는다. 매장을 보고 있었다면 복원.
//   - store_manager: 매장이 자기 매장 하나뿐이라 항상 그 매장의 분석 탭(store)으로 바로 들어간다.
function setupManagerNavDefaults() {
  const role = session.role;
  const savedBranch = localStorage.getItem("current_branch_id_" + session.userId);
  const savedStore = localStorage.getItem("current_store_id_" + session.userId);
  const savedLevel = localStorage.getItem("manager_view_level_" + session.userId);
  const storeExists = (id) => id && managerData.stores.find((s) => s.store_id === id);
  const branchExists = (id) => id && managerData.branches.find((b) => b.branch_id === id);

  if (role === "store_manager") {
    currentStoreId = managerData.stores[0]?.store_id || null;
    currentBranchId = managerData.branches[0]?.branch_id || null;
    managerViewLevel = "store";
    return;
  }

  if (role === "branch_manager") {
    currentBranchId = managerData.branches[0]?.branch_id || null;
    if (savedLevel === "store" && storeExists(savedStore)) {
      currentStoreId = savedStore;
      managerViewLevel = "store";
    } else {
      currentStoreId = null;
      managerViewLevel = "branch";
    }
    return;
  }

  // hq_manager
  if (savedLevel === "store" && storeExists(savedStore)) {
    currentStoreId = savedStore;
    currentBranchId = managerData.stores.find((s) => s.store_id === savedStore)?.branch_id || savedBranch || null;
    managerViewLevel = "store";
  } else if (savedLevel === "branch" && branchExists(savedBranch)) {
    currentBranchId = savedBranch;
    currentStoreId = null;
    managerViewLevel = "branch";
  } else {
    currentBranchId = null;
    currentStoreId = null;
    managerViewLevel = "compare";
  }
}

function persistManagerNavState() {
  localStorage.setItem("manager_view_level_" + session.userId, managerViewLevel);
  if (currentBranchId) localStorage.setItem("current_branch_id_" + session.userId, currentBranchId);
  if (currentStoreId) localStorage.setItem("current_store_id_" + session.userId, currentStoreId);
}

function setConsultantSyncStatus(online) {
  $("#cSyncDot").classList.toggle("online", online);
  $("#cSyncDot").classList.toggle("offline", !online);
  $("#cSyncLabel").textContent = online ? "서버 연동됨" : "오프라인 - 캐시된 참고자료 사용 중";
}
function setManagerSyncStatus(online) {
  $("#syncDot").classList.toggle("online", online);
  $("#syncDot").classList.toggle("offline", !online);
  $("#syncLabel").textContent = online
    ? `서버 연동됨 (${new Date().toLocaleTimeString("ko-KR")})`
    : "오프라인 - 캐시된 데이터 사용 중";
}

/* ---------------- 조회 헬퍼 (managerData 기준) ---------------- */
function getStore(id) { return managerData.stores.find((s) => s.store_id === id); }
function getArea(id) { return managerData.commercial_area.find((a) => a.store_id === id); }
function getCustomers(id) { return managerData.customers.filter((c) => c.store_id === id); }
function getLogs(id) { return managerData.sales_talk_log.filter((l) => l.store_id === id); }
function getSegment(id) { return managerData.customer_segments.find((s) => s.segment_id === id); }

/* =========================================================================
   상담사(Consultant) 화면
   ========================================================================= */
const AGE_GROUP_OPTIONS = ["10대", "20대", "30대", "40대", "50대이상"];
const GENDER_OPTIONS = ["남성", "여성", "미상"];
const RESIDENCE_OPTIONS = ["인근 거주", "인근 직장", "타 지역", "미상"];
// 추천조합 3단계에서 쓰는 라이프스타일 조건 - 거주인원수/평형대/설치환경에 따라 카테고리별
// 모델을 구체화(server의 pick_best_product)하는 데 쓰인다. 값은 서버 PRODUCT_CATALOG의 fit
// 태그 값과 정확히 일치해야 매칭이 된다.
const HOUSEHOLD_SIZE_OPTIONS = ["1인", "2인", "3인", "4인 이상"];
const HOME_SIZE_PYEONG_OPTIONS = ["20평대 이하", "30평대", "40평대 이상"];
const INSTALL_ENVIRONMENT_OPTIONS = ["원룸/오피스텔", "아파트(베란다·실외기 공간 있음)", "단독주택/대형평수"];
// 가전 판매 비중이 크므로 모바일(스마트폰/태블릿/웨어러블)과 가전(TV/냉장고/세탁기/에어컨/청소기/기타가전)을 함께 다룬다.
const PRODUCT_CATEGORY_OPTIONS = ["스마트폰", "태블릿", "웨어러블", "TV", "냉장고", "세탁기", "에어컨", "청소기", "기타가전"];
const PRODUCT_GROUP = {
  "스마트폰": "모바일", "태블릿": "모바일", "웨어러블": "모바일",
  "TV": "가전", "냉장고": "가전", "세탁기": "가전", "에어컨": "가전", "청소기": "가전", "기타가전": "가전",
};
function productGroup(cat) {
  return PRODUCT_GROUP[cat] || "기타";
}
// 상담 상품유형은 다중 선택이 가능하다 - product_categories(배열)가 있으면 그걸 쓰고, 옛 단일값
// 데이터는 product_category 하나짜리 배열로 취급한다 (server/sync_server.py의 log_categories와 동일 규칙).
function logCategories(l) {
  if (Array.isArray(l.product_categories) && l.product_categories.length) return l.product_categories;
  return l.product_category ? [l.product_category] : [];
}
// 구매유형(구매 상황 태그) - "추천 조합" 기능이 연령대/성별/거주지와 함께 필터로 쓰는 축.
// product_category(무엇을 샀는지)와는 별개로 "어떤 상황에서 샀는지"를 나타낸다.
// 추천 조합 화면의 1단계 "상담 유형 선택" 타일과 동일한 값을 써서 상담기록 태깅과 추천 검색이 서로 맞물리게 한다.
const PURCHASE_OCCASION_OPTIONS = ["혼수", "입주", "이사", "모바일", "즉시상담"];
const OCCASION_META = [
  { value: "혼수", icon: "💐", desc: "혼수가전 다품목" },
  { value: "입주", icon: "🏢", desc: "입주가전 다품목" },
  { value: "이사", icon: "📦", desc: "이사가전 다품목" },
  { value: "모바일", icon: "📱", desc: "모바일 다품목" },
  { value: "즉시상담", icon: "🛍️", desc: "단품 즉시 추천" },
];

/* ---------------- 상담 녹음 → AI 자동 분석 ----------------
 * 예전엔 브라우저 내장 음성인식(Web Speech API)으로 실시간 텍스트를 보여주고 상담원이 그걸 보면서
 * 고객반응/세일즈톡/wow포인트/구매결정포인트를 직접 입력했는데, 모바일에서 음성인식 정확도가 낮아
 * 실용성이 떨어졌다. 그래서 실제 녹음 파일을 서버로 올려 (1) OpenAI 음성인식으로 텍스트 변환
 * (2) AI가 텍스트를 분석해 위 네 항목을 뽑아내는 방식으로 바꿨다 (server/sync_server.py의
 * /api/analyze_consultation). 상담원은 연령대/성별/거주지/상품유형/구매전환여부만 수기 태깅하면 된다.
 * 실시간 화면 텍스트 기능은 뺐다 - 녹음(getUserMedia)과 별도 음성인식 스트림을 동시에 열면 모바일에서
 * 마이크 리소스 충돌로 더 불안정해질 수 있고, 최종 분석은 어차피 녹음 파일 기반이라 실시간 텍스트가
 * 없어도 정확도에 영향이 없다.
 * 녹음 파일/변환된 텍스트는 서버가 분석 응답을 만드는 동안만 메모리에 있다가 즉시 버려진다 -
 * 디스크나 DB 어디에도 저장하지 않는다 (개인정보보호법 설계 원칙 유지, 저장되는 항목은 예전과
 * 동일하게 wow포인트/결정포인트 같은 통계용 요약 텍스트뿐이다).
 */
const MAX_RECORD_SECONDS = 360; // 6분 - 상담 특성상 충분하고 서버/AI 비용·타임아웃도 같이 방어

let mediaRecorder = null;
let mediaStream = null;
let audioChunks = [];
let isRecording = false;
let isAnalyzing = false;
let recordStartedAt = null;
let recordTimerHandle = null;
let aiSuggested = null; // 마지막 분석 결과: {script_id, segment_id, customer_reaction, wow_point, decision_point}

function recordingSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
}

function pickAudioMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c;
  }
  return ""; // 브라우저 기본값에 맡김
}

function setRecordStatus(text) {
  const el = $("#recordStatus");
  if (el) el.textContent = text;
}

function setupRecordingUI() {
  const toggleBtn = $("#recordToggleBtn");
  if (!toggleBtn) return; // 참고자료 탭 등 폼이 없는 화면에서는 아무것도 안 함

  if (!recordingSupported()) {
    toggleBtn.style.display = "none";
    const warn = $("#recordUnsupported");
    if (warn) warn.style.display = "block";
    return;
  }

  toggleBtn.addEventListener("click", toggleRecording);
  updateRecordingButtonState();

  const scriptSel = $('#logForm select[name="script_id"]');
  if (scriptSel) scriptSel.addEventListener("change", syncSegmentFromScript);
}

function toggleRecording() {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
}

async function startRecording() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    toast("마이크 권한이 필요합니다");
    return;
  }
  mediaStream = stream;
  audioChunks = [];
  const mimeType = pickAudioMimeType();
  try {
    mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  } catch (e) {
    toast("이 브라우저에서는 녹음을 시작할 수 없습니다");
    stream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
    return;
  }
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) audioChunks.push(e.data);
  };
  mediaRecorder.onstop = () => {
    const usedMime = mediaRecorder.mimeType || mimeType || "audio/webm";
    const blob = new Blob(audioChunks, { type: usedMime });
    audioChunks = [];
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
    handleRecordingFinished(blob, usedMime);
  };

  mediaRecorder.start();
  isRecording = true;
  recordStartedAt = Date.now();
  updateRecordingButtonState();
  recordTimerHandle = setInterval(updateRecordTimer, 1000);
  updateRecordTimer();
}

function stopRecording() {
  if (!isRecording || !mediaRecorder) return;
  isRecording = false;
  clearInterval(recordTimerHandle);
  recordTimerHandle = null;
  try {
    mediaRecorder.stop();
  } catch (e) {
    /* noop */
  }
  updateRecordingButtonState();
}

function updateRecordTimer() {
  if (!recordStartedAt) return;
  const sec = Math.floor((Date.now() - recordStartedAt) / 1000);
  const mm = String(Math.floor(sec / 60)).padStart(2, "0");
  const ss = String(sec % 60).padStart(2, "0");
  setRecordStatus(`분석 중... ${mm}:${ss}`);
  if (sec >= MAX_RECORD_SECONDS) {
    toast("녹음 시간이 길어져 자동으로 종료합니다");
    stopRecording();
  }
}

function updateRecordingButtonState() {
  const btn = $("#recordToggleBtn");
  if (!btn) return;
  if (isAnalyzing) {
    btn.textContent = "AI 분석 중...";
    btn.disabled = true;
    btn.classList.remove("active");
    setRecordStatus("AI가 상담 내용을 분석하고 있습니다 (10~30초 소요)");
  } else if (isRecording) {
    btn.textContent = "⏹ 분석 완료";
    btn.disabled = false;
    btn.classList.add("active");
  } else {
    btn.textContent = "🎙 분석 시작";
    btn.disabled = false;
    btn.classList.remove("active");
    setRecordStatus("대기 중");
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result || "";
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function handleRecordingFinished(blob, mimeType) {
  if (blob.size < 800) {
    toast("녹음 내용이 너무 짧습니다. 다시 시도해주세요.");
    updateRecordingButtonState();
    return;
  }
  isAnalyzing = true;
  updateRecordingButtonState();
  try {
    const audioBase64 = await blobToBase64(blob);
    const res = await api("/api/analyze_consultation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audio_base64: audioBase64, audio_mime: mimeType }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(data.message || "AI 분석에 실패했습니다. 아래 항목을 직접 입력해주세요.");
      setRecordStatus("AI 분석 실패 - 아래 항목을 직접 입력해주세요");
      return;
    }
    applyAiSuggestion(data.suggested || {});
    toast("AI 분석 완료 - 아래 내용을 확인하고 필요하면 수정하세요");
    setRecordStatus("AI 분석 완료 - 아래 내용을 확인해주세요");
  } catch (e) {
    toast("AI 분석 중 오류가 발생했습니다. 아래 항목을 직접 입력해주세요.");
    setRecordStatus("AI 분석 실패 - 아래 항목을 직접 입력해주세요");
  } finally {
    isAnalyzing = false;
    updateRecordingButtonState();
  }
}

function applyAiSuggestion(suggested) {
  aiSuggested = suggested;
  const form = $("#logForm");
  if (!form) return;
  if (suggested.script_id) {
    const scriptSel = form.querySelector('select[name="script_id"]');
    if (scriptSel) scriptSel.value = suggested.script_id;
  }
  if (suggested.customer_reaction) {
    const reactionSel = form.querySelector('select[name="customer_reaction"]');
    if (reactionSel) reactionSel.value = suggested.customer_reaction;
  }
  const wowEl = form.querySelector('textarea[name="wow_point"]');
  if (wowEl) wowEl.value = suggested.wow_point || "";
  const decisionEl = form.querySelector('textarea[name="decision_point"]');
  if (decisionEl) decisionEl.value = suggested.decision_point || "";
  syncSegmentFromScript();
}

// 세그먼트는 상담원이 직접 고르지 않고, 선택된(AI가 추천했거나 직접 고른) 세일즈톡의 target_segment로
// 자동 유도한다. script_id가 바뀔 때마다(AI 적용 시/상담원이 직접 select를 바꿀 때 모두) 다시 계산.
function syncSegmentFromScript() {
  const form = $("#logForm");
  if (!form) return;
  const scriptSel = form.querySelector('select[name="script_id"]');
  const segmentInput = form.querySelector('input[name="segment_id"]');
  if (!scriptSel || !segmentInput) return;
  const script = (consultantBundle.talk_scripts || []).find((s) => s.script_id === scriptSel.value);
  segmentInput.value = (script && script.target_segment) || (aiSuggested && aiSuggested.segment_id) || "";
}

function renderButtonGroup(name, options, selected) {
  return `
    <div class="btn-group" data-field="${name}">
      <input type="hidden" name="${name}" value="${selected || ""}" required />
      ${options
        .map(
          (opt) =>
            `<button type="button" class="tag-btn${opt === selected ? " active" : ""}" data-value="${opt}">${opt}</button>`
        )
        .join("")}
    </div>`;
}

function renderConsultant() {
  const store = consultantBundle.store;
  $("#consultantStoreName").textContent = store ? store.store_name : session.displayName;
  initConsultantTabs();
  renderConsultantReference();
  renderConsultantLogForm();
  renderConsultantRecommend();
  renderConsultantMyFailures();
}

function initConsultantTabs() {
  $$("#consultantApp nav.tabs button").forEach((btn) => {
    btn.onclick = () => {
      $$("#consultantApp nav.tabs button").forEach((b) => b.classList.remove("active"));
      $$("#consultantApp .view").forEach((v) => v.classList.remove("active"));
      btn.classList.add("active");
      $(`#cview-${btn.dataset.ctab}`).classList.add("active");
    };
  });
}

// 세일즈톡 문장에서 실제로 강조되면 좋은 마케팅/혜택 관련 키워드만 골라 <mark>로 감싼다.
// AI가 아니라 고정 키워드 목록 기반이라 결과가 항상 같고, 없는 단어를 지어내지 않는다.
const SCRIPT_KEYWORDS = [
  "위약금 없이", "무료", "캐시백", "할인", "결합할인", "가족결합", "추가 캐시백", "사은품",
  "사전예약", "트레이드인", "액세서리 증정", "풀세트", "배송·설치", "예약설치",
  "전기요금", "인테리어", "프리미엄", "최신 모델", "신제품",
];
function highlightScriptKeywords(text) {
  if (!text) return "";
  let out = String(text);
  SCRIPT_KEYWORDS.forEach((kw) => {
    if (!out.includes(kw)) return;
    out = out.split(kw).join(`<mark class="kw">${kw}</mark>`);
  });
  return out;
}

let referenceTopExpanded = false;

function renderConsultantReference() {
  const scripts = consultantBundle.talk_scripts || [];
  const top = consultantBundle.top_performer;

  // 세그먼트별로 흩어져 있던 목록을, 상담 전 훑어보기 좋게 품목군(product_category) 타일로 재구성.
  // 실제 상담 태깅과 같은 카테고리 축(PRODUCT_CATEGORY_OPTIONS)을 그대로 써서 다른 화면과 일관되게 한다.
  const byCategory = {};
  scripts.forEach((sc) => {
    const cat = sc.product_category || "기타";
    (byCategory[cat] = byCategory[cat] || []).push(sc);
  });
  const categoryOrder = PRODUCT_CATEGORY_OPTIONS.filter((c) => byCategory[c]).concat(
    Object.keys(byCategory).filter((c) => !PRODUCT_CATEGORY_OPTIONS.includes(c))
  );

  const topHtml = top
    ? `
    <div class="card" id="topPerformerCard" style="margin-bottom:18px; border-left:4px solid var(--accent); cursor:pointer;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap;">
        <div>
          <div class="label" style="margin-bottom:2px;">🏆 ${top.month ? top.month + " " : ""}판매성공율 1위 · ${top.consultant_name}</div>
          <div class="small-muted">전환율 ${top.conv_rate}% (${top.sample_size}건 기준)</div>
        </div>
        <span class="pill pos">상단 고정</span>
      </div>
      <div style="margin-top:10px; font-size:15px; line-height:1.6;">
        ${top.highlight.script_text ? `"${highlightScriptKeywords(top.highlight.script_text)}"` : `"${top.highlight.wow_point || "세부 상담 내역을 참고하세요."}"`}
      </div>
      <div class="small-muted" style="margin-top:8px;">눌러서 세부 상담 내역 보기 ${referenceTopExpanded ? "▲" : "▼"}</div>
      <div id="topPerformerDetail" style="margin-top:10px; ${referenceTopExpanded ? "" : "display:none;"}">
        <div class="small-muted"><b>상품유형:</b> ${(top.highlight.product_categories || []).join(", ") || top.highlight.product_category || "-"}</div>
        <div class="small-muted"><b>구매유형:</b> ${top.highlight.purchase_occasion || "-"}</div>
        <div class="small-muted"><b>고객 반응:</b> ${top.highlight.customer_reaction || "-"}</div>
        <div class="small-muted"><b>고객층:</b> ${top.highlight.age_group || "-"} · ${top.highlight.gender || "-"} · ${top.highlight.residence_area || "-"}</div>
        <div class="small-muted" style="margin-top:6px;"><b>Wow 포인트:</b> ${top.highlight.wow_point || "-"}</div>
        <div class="small-muted"><b>구매 결정 포인트:</b> ${top.highlight.decision_point || "-"}</div>
        <div class="small-muted" style="margin-top:6px;">상담일: ${top.highlight.log_date || "-"}</div>
      </div>
    </div>`
    : "";

  const tilesHtml = categoryOrder.length
    ? `
    <div class="grid">
      ${categoryOrder
        .map((cat) => {
          const items = byCategory[cat];
          return `
          <div class="card">
            <div class="label" style="display:flex; align-items:center; gap:8px;">
              <span class="pill ${productGroup(cat) === "가전" ? "appliance" : "mobile"}">${cat}</span>
            </div>
            ${items
              .map((sc) => `<div class="script-line">"${highlightScriptKeywords(sc.script_text)}"</div>`)
              .join("")}
          </div>`;
        })
        .join("")}
    </div>`
    : `<div class="small-muted">참고자료가 없습니다.</div>`;

  $("#cview-reference").innerHTML = `
    <div class="section-title">세일즈톡 참고자료</div>
    <div class="small-muted" style="margin-bottom:14px;">품목군별 추천 멘트입니다. 상담 전 참고하세요.</div>
    ${topHtml}
    ${tilesHtml}
  `;

  const topCard = $("#topPerformerCard");
  if (topCard) {
    topCard.addEventListener("click", () => {
      referenceTopExpanded = !referenceTopExpanded;
      renderConsultantReference();
    });
  }
}

// 상담 상품유형 다중선택 상태 - 폼이 다시 렌더링될 때(제출 후 등) 기본값 하나로 리셋된다.
let logFormCategories = new Set([PRODUCT_CATEGORY_OPTIONS[0]]);

function renderConsultantLogForm() {
  const lastConsultantName = localStorage.getItem("last_consultant_name_" + session.userId) || "";
  logFormCategories = new Set([PRODUCT_CATEGORY_OPTIONS[0]]);
  $("#cview-logform").innerHTML = `
    <div class="section-title">상담기록</div>
    <div class="small-muted" style="margin-bottom:12px;">
      개인을 특정할 수 있는 정보(고객 이름·연락처·고객ID)는 입력하지 않습니다. 연령대/성별/거주지/상품유형/
      구매전환여부만 상담원이 직접 태깅하고, 고객반응·사용한 세일즈톡·wow포인트·구매결정포인트는
      아래 녹음-분석 기능을 쓰면 AI가 자동으로 채워줍니다(직접 수정 가능). 기록의 집계·분석은
      본사/지사 관리자만 조회합니다. 단, 이 매장 로그인 계정을 여러 판매사원이 함께 쓰는 경우를 위해
      담당 판매사원 이름만 별도로 태깅합니다 (실패 분석/피드백을 사원별로 나눠 보기 위함).
    </div>

    <div class="card" style="margin-bottom:18px;">
      <div class="label">담당 판매사원</div>
      ${(() => {
        const roster = consultantBundle.staff_roster || [];
        const isKnown = roster.includes(lastConsultantName);
        return `
        <select id="consultantNameSelect" style="margin-top:8px;">
          <option value="" disabled ${lastConsultantName ? "" : "selected"}>선택해주세요</option>
          ${roster.map((n) => `<option value="${n}" ${n === lastConsultantName ? "selected" : ""}>${n}</option>`).join("")}
          <option value="__custom__" ${lastConsultantName && !isKnown ? "selected" : ""}>+ 명단에 없음 (직접 입력)</option>
        </select>
        <input type="text" id="consultantNameCustomInput" placeholder="이름을 입력해주세요"
          value="${!isKnown ? lastConsultantName : ""}"
          style="margin-top:8px; display:${!isKnown && lastConsultantName ? "block" : "none"};" />
        `;
      })()}
    </div>

    <div class="card" id="recordingPanel" style="margin-bottom:18px;">
      <div class="label">상담 녹음 → AI 자동 분석</div>
      <div class="small-muted" style="margin-bottom:10px;">
        상담원 본인이 참여하는 대화를 녹음하는 것은 통신비밀보호법상 별도 동의 없이 가능하지만, 고객에게
        사전에 안내하는 걸 권장합니다. "분석 시작"을 누르고 상담을 진행한 뒤 "분석 완료"를 누르면, 녹음이
        AI에게 전달돼 세일즈톡 매칭/고객반응/wow포인트/구매결정포인트를 자동으로 채워줍니다. <b>녹음 파일과
        변환된 텍스트는 분석 응답을 만드는 즉시 폐기되고 서버에 저장되지 않습니다</b> - 최종적으로 남는
        것은 예전과 동일하게 통계용 요약 항목들뿐입니다.
      </div>
      <div style="display:flex; gap:10px; align-items:center; margin-bottom:4px; flex-wrap:wrap;">
        <button type="button" id="recordToggleBtn" class="tag-btn">🎙 분석 시작</button>
        <span id="recordStatus" class="small-muted">대기 중</span>
      </div>
      <div id="recordUnsupported" class="small-muted" style="display:none; color:var(--warn); margin-top:8px;">
        이 브라우저/기기에서는 녹음 기능을 지원하지 않습니다. 아래 항목을 직접 입력해주세요.
      </div>
    </div>

    <form class="log-form" id="logForm">
      <div class="full">
        <label>고객 연령대 (추정, 버튼 선택 · 수기입력)</label>
        ${renderButtonGroup("age_group", AGE_GROUP_OPTIONS, AGE_GROUP_OPTIONS[1])}
      </div>
      <div class="full">
        <label>고객 성별 (추정, 버튼 선택 · 수기입력)</label>
        ${renderButtonGroup("gender", GENDER_OPTIONS, GENDER_OPTIONS[2])}
      </div>
      <div class="full">
        <label>고객 거주지 (추정, 버튼 선택 · 수기입력 - 구체 주소 아님)</label>
        ${renderButtonGroup("residence_area", RESIDENCE_OPTIONS, RESIDENCE_OPTIONS[3])}
      </div>
      <div class="full">
        <label>상담 상품유형 (버튼 선택 · 다중 선택 가능 - 한 상담에서 여러 상품을 같이 논의한 경우 함께 선택)</label>
        <div class="btn-group" id="categoryMultiSelect">
          ${PRODUCT_CATEGORY_OPTIONS.map((c) => `<button type="button" class="tag-btn ${logFormCategories.has(c) ? "active" : ""}" data-multicat="${c}">${c}</button>`).join("")}
        </div>
      </div>
      <div class="full">
        <label>구매유형 (버튼 선택 · 수기입력 - "추천 조합" 집계에 사용됩니다)</label>
        ${renderButtonGroup("purchase_occasion", PURCHASE_OCCASION_OPTIONS, PURCHASE_OCCASION_OPTIONS[3])}
      </div>
      <div>
        <label>구매 전환 여부 (수기입력)</label>
        <select name="purchase_converted" required>
          <option value="Y">전환(Y)</option>
          <option value="N">미전환(N)</option>
        </select>
      </div>
      <div>
        <label>구매 품목/모델명 (선택 입력)</label>
        <input type="text" name="purchased_item" placeholder="예: 갤럭시 Z플립7 (안 채워도 됩니다)" />
      </div>

      <input type="hidden" name="segment_id" value="" />

      <div class="full section-title" style="margin:10px 0 0; font-size:14px;">AI 분석 결과 (녹음 후 자동 입력, 직접 수정 가능)</div>
      <div>
        <label>사용한 세일즈톡</label>
        <select name="script_id" required>
          <option value="" disabled selected>분석 대기 중 - 직접 선택도 가능</option>
          ${(consultantBundle.talk_scripts || []).map((s) => `<option value="${s.script_id}">[${s.product_category || s.category}] ${s.script_text.slice(0, 20)}...</option>`).join("")}
        </select>
      </div>
      <div>
        <label>고객 반응</label>
        <select name="customer_reaction" required>
          <option value="" disabled selected>분석 대기 중 - 직접 선택도 가능</option>
          <option value="긍정">긍정</option>
          <option value="중립">중립</option>
          <option value="부정">부정</option>
        </select>
      </div>
      <div class="full">
        <label>Wow 포인트 (고객이 특히 반응한 지점)</label>
        <textarea name="wow_point" placeholder="녹음 후 AI가 자동으로 채웁니다 (직접 입력도 가능)" required></textarea>
      </div>
      <div class="full">
        <label>구매 결정 포인트</label>
        <textarea name="decision_point" placeholder="녹음 후 AI가 자동으로 채웁니다 (직접 입력도 가능)" required></textarea>
      </div>
      <div class="full">
        <button type="submit">상담기록 저장</button>
      </div>
    </form>

    <div class="section-title" style="margin-top:26px;">이번 세션에 작성한 상담기록 <span class="badge">${sessionLogs.length}건</span></div>
    <div class="small-muted" style="margin-bottom:10px;">상담사는 전체 집계·통계를 조회할 권한이 없어, 본인이 방금 작성한 내역만 확인용으로 표시됩니다.</div>
    <div class="table-scroll"><table>
      <thead><tr><th>시각</th><th>연령대</th><th>성별</th><th>거주지</th><th>상품유형</th><th>구매유형</th><th>반응</th><th>Wow포인트</th><th>출처</th></tr></thead>
      <tbody>
        ${sessionLogs
          .slice()
          .reverse()
          .map(
            (l) => `<tr>
              <td>${l.time}</td><td>${l.age_group}</td><td>${l.gender}</td><td>${l.residence_area}</td>
              <td>${(l.product_categories && l.product_categories.length ? l.product_categories : [l.product_category]).filter(Boolean).join(", ")}</td><td>${l.purchase_occasion || "-"}</td><td>${l.customer_reaction}</td><td>${l.wow_point}</td>
              <td>${sourcePill(l.source)}</td>
            </tr>`
          )
          .join("")}
      </tbody>
    </table></div>
  `;

  // 버튼그룹(연령대/성별/거주지/구매유형)은 단일선택 - data-field가 있는 그룹만 대상으로 한다.
  // 상품유형 다중선택(#categoryMultiSelect)은 hidden input이 없는 별도 구조라 여기서 제외된다.
  $$("#logForm .btn-group[data-field]").forEach((group) => {
    const hidden = group.querySelector('input[type="hidden"]');
    group.querySelectorAll(".tag-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        group.querySelectorAll(".tag-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        hidden.value = btn.dataset.value;
      });
    });
  });

  // 상품유형 다중선택: 탭할 때마다 켜기/끄기. 최소 1개는 항상 선택돼 있어야 한다.
  $$("#categoryMultiSelect [data-multicat]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cat = btn.dataset.multicat;
      if (logFormCategories.has(cat)) {
        if (logFormCategories.size > 1) logFormCategories.delete(cat);
      } else {
        logFormCategories.add(cat);
      }
      btn.classList.toggle("active", logFormCategories.has(cat));
    });
  });

  // 담당 판매사원: 명단에 없으면 "+ 직접 입력"을 골라 텍스트로 채운다.
  const consultantSelect = $("#consultantNameSelect");
  const consultantCustom = $("#consultantNameCustomInput");
  if (consultantSelect && consultantCustom) {
    consultantSelect.addEventListener("change", () => {
      consultantCustom.style.display = consultantSelect.value === "__custom__" ? "block" : "none";
      if (consultantSelect.value === "__custom__") consultantCustom.focus();
    });
  }

  $("#logForm").addEventListener("submit", onSubmitConsultantLog);
  setupRecordingUI();
}

async function onSubmitConsultantLog(e) {
  e.preventDefault();
  if (isRecording || isAnalyzing) {
    toast("녹음/분석이 끝난 뒤 저장해주세요");
    return;
  }
  const consultantSelectEl = $("#consultantNameSelect");
  const consultantName = (
    consultantSelectEl.value === "__custom__" ? $("#consultantNameCustomInput").value : consultantSelectEl.value
  ).trim();
  if (!consultantName) {
    toast("담당 판매사원을 선택하거나 입력해주세요");
    return;
  }
  if (logFormCategories.size === 0) {
    toast("상담 상품유형을 하나 이상 선택해주세요");
    return;
  }
  localStorage.setItem("last_consultant_name_" + session.userId, consultantName);
  const selectedCategories = Array.from(logFormCategories);
  const fd = new FormData(e.target);
  const entry = {
    store_id: session.storeId,
    consultant_name: consultantName,
    age_group: fd.get("age_group"),
    gender: fd.get("gender"),
    residence_area: fd.get("residence_area"),
    product_category: selectedCategories[0],
    product_categories: selectedCategories,
    purchase_occasion: fd.get("purchase_occasion"),
    purchased_item: fd.get("purchased_item") || "",
    segment_id: fd.get("segment_id") || null,
    script_id: fd.get("script_id"),
    customer_reaction: fd.get("customer_reaction"),
    wow_point: fd.get("wow_point"),
    decision_point: fd.get("decision_point"),
    purchase_converted: fd.get("purchase_converted"),
    log_date: new Date().toISOString().slice(0, 10),
    source: aiSuggested ? "ai_transcribed" : "manual",
  };

  try {
    const res = await api("/api/sales_talk_log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
    if (res.ok) {
      toast("상담기록 저장 완료 (서버 동기화됨)");
    } else {
      queueConsultantPending(entry);
      toast("서버 저장 실패 - 재동기화 대기열에 추가됨");
    }
  } catch (err) {
    queueConsultantPending(entry);
    toast("오프라인 - 재연결 시 자동 동기화되도록 대기열에 저장됨");
  }

  sessionLogs.push({ ...entry, time: new Date().toLocaleTimeString("ko-KR") });
  aiSuggested = null;
  e.target.reset();
  renderConsultantLogForm();
}

function queueConsultantPending(entry) {
  const key = "pending_logs_" + session.userId;
  const pending = JSON.parse(localStorage.getItem(key) || "[]");
  pending.push(entry);
  localStorage.setItem(key, JSON.stringify(pending));
}

async function flushConsultantPending() {
  if (!session || session.role !== "staff") return;
  const key = "pending_logs_" + session.userId;
  const pending = JSON.parse(localStorage.getItem(key) || "[]");
  if (!pending.length) return;
  const remaining = [];
  for (const entry of pending) {
    try {
      const res = await api("/api/sales_talk_log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
      });
      if (!res.ok) remaining.push(entry);
    } catch {
      remaining.push(entry);
    }
  }
  localStorage.setItem(key, JSON.stringify(remaining));
  if (remaining.length < pending.length) toast(`대기 중이던 로그 ${pending.length - remaining.length}건 동기화 완료`);
}

/* ---------------- 추천 조합 ----------------
 * 고객 유형(연령대/성별/거주지/구매유형)을 입력하면, 비슷한 조건에서 실제 구매전환된 상담들을
 * 서버가 집계해 어떤 상품유형/모델이 많이 팔렸는지 알려준다. 특정 고객의 구매이력을 추적하는
 * 것이 아니라 비식별 로그의 통계 집계다 (설계 배경은 docs/ 참고).
 */
// recommendFlow: 추천 조합 화면의 단계 상태.
// step 1 = 상담 유형(고객유형) 선택 타일, step 2 = 제품 선택(다품목 그리드 또는 즉시상담 트리),
// step 3 = 고객 특성 입력 + 결과. 혼수/입주/이사/모바일은 다품목(제품군 다중선택 + 필수/관심 태깅),
// 즉시상담은 단품(카테고리 트리에서 1개만 선택) 흐름으로 갈라진다.
let recommendFlow = { step: 1, occasion: null, categories: {}, singleCategory: null, treeGroup: null };

function renderConsultantRecommend() {
  recommendFlow = { step: 1, occasion: null, categories: {}, singleCategory: null, treeGroup: null };
  renderRecommendStep();
}

function renderRecommendStep() {
  if (recommendFlow.step === 1) {
    $("#cview-recommend").innerHTML = recommendStep1Html();
    wireRecommendStep1();
  } else if (recommendFlow.step === 2 && recommendFlow.occasion === "즉시상담") {
    $("#cview-recommend").innerHTML = recommendStep2TreeHtml();
    wireRecommendStep2Tree();
  } else if (recommendFlow.step === 2) {
    $("#cview-recommend").innerHTML = recommendStep2GridHtml();
    wireRecommendStep2Grid();
  } else {
    $("#cview-recommend").innerHTML = recommendStep3Html();
    wireRecommendStep3();
  }
}

function recommendStep1Html() {
  return `
    <div class="section-title">추천 조합</div>
    <div class="small-muted" style="margin-bottom:16px;">
      상담 유형을 선택해 주세요. 실제 구매전환 상담을 집계해 상품유형/모델을 추천합니다 -
      특정 고객의 과거 구매이력을 연결하는 게 아니라 비슷한 조건 고객들의 통계입니다.
    </div>
    <div class="grid" id="occasionGrid" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr));">
      ${OCCASION_META.map(
        (o) => `
        <div class="card" data-occasion="${o.value}" style="text-align:center; cursor:pointer;">
          <div style="font-size:30px; margin-bottom:8px;">${o.icon}</div>
          <div style="font-weight:700;">${o.value}</div>
          <div class="small-muted" style="margin-top:4px;">${o.desc}</div>
        </div>`
      ).join("")}
    </div>
  `;
}
function wireRecommendStep1() {
  $$("#occasionGrid [data-occasion]").forEach((card) => {
    card.addEventListener("click", () => {
      recommendFlow.occasion = card.dataset.occasion;
      recommendFlow.step = 2;
      renderRecommendStep();
    });
  });
}

function recommendCategoryChip(cat) {
  const pr = recommendFlow.categories[cat];
  const label = pr === "must" ? `${cat} · 필수` : pr === "interest" ? `${cat} · 관심` : cat;
  // 필수 = tag-btn.active(파란 배경 + 흰 글씨)를 그대로 쓰고, 관심은 별도 outline 스타일(연한 배경 +
  // 파란 테두리/글씨)로 구분한다. 예전엔 관심 상태에도 active 클래스를 같이 붙이면서 인라인
  // color:var(--accent)만 덮어써서, active의 파란 배경 위에 파란 글씨가 얹혀 글자가 안 보였다.
  const cls = pr === "must" ? "active" : "";
  const style = pr === "interest" ? "background:var(--panel); border-color:var(--accent); color:var(--accent);" : "";
  return `<button type="button" class="tag-btn ${cls}" data-cat="${cat}" style="${style}">${label}</button>`;
}

function recommendStep2GridHtml() {
  const mobileCats = PRODUCT_CATEGORY_OPTIONS.filter((c) => productGroup(c) === "모바일");
  const applianceCats = PRODUCT_CATEGORY_OPTIONS.filter((c) => productGroup(c) === "가전");
  const mustCount = Object.values(recommendFlow.categories).filter((v) => v === "must").length;
  const interestCount = Object.values(recommendFlow.categories).filter((v) => v === "interest").length;
  const canNext = mustCount + interestCount > 0;
  return `
    <div class="section-title">${recommendFlow.occasion}상담 · 관심 제품군 선택</div>
    <div class="small-muted" style="margin-bottom:10px;">
      탭할 때마다 관심 → 필수 → 선택 해제 순으로 바뀝니다. 여러 제품군을 함께 고를 수 있어요.
    </div>
    <div class="small-muted" style="margin-bottom:14px;">필수 ${mustCount} · 관심 ${interestCount}</div>
    <div class="card" style="margin-bottom:14px;">
      <div class="label">모바일</div>
      <div class="btn-group" id="mobileCatGroup" style="margin-top:8px;">${mobileCats.map(recommendCategoryChip).join("")}</div>
    </div>
    <div class="card" style="margin-bottom:20px;">
      <div class="label">가전</div>
      <div class="btn-group" id="applianceCatGroup" style="margin-top:8px;">${applianceCats.map(recommendCategoryChip).join("")}</div>
    </div>
    <div style="display:flex; gap:10px;">
      <button type="button" class="tag-btn" id="recommendBackBtn">이전</button>
      <button type="button" id="recommendNextBtn" ${canNext ? "" : "disabled"}>다음</button>
    </div>
  `;
}
function wireRecommendStep2Grid() {
  $$("#cview-recommend [data-cat]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cat = btn.dataset.cat;
      const cur = recommendFlow.categories[cat];
      if (!cur) recommendFlow.categories[cat] = "interest";
      else if (cur === "interest") recommendFlow.categories[cat] = "must";
      else delete recommendFlow.categories[cat];
      renderRecommendStep();
    });
  });
  $("#recommendBackBtn").addEventListener("click", () => {
    recommendFlow.step = 1;
    renderRecommendStep();
  });
  $("#recommendNextBtn").addEventListener("click", () => {
    if (Object.keys(recommendFlow.categories).length === 0) return;
    recommendFlow.step = 3;
    renderRecommendStep();
  });
}

function recommendStep2TreeHtml() {
  const groups = ["모바일", "가전"];
  const activeGroup = recommendFlow.treeGroup || groups[0];
  const leaves = PRODUCT_CATEGORY_OPTIONS.filter((c) => productGroup(c) === activeGroup);
  return `
    <div class="section-title">즉시상담 · 제품 선택</div>
    <div class="small-muted" style="margin-bottom:14px;">구매하실 제품 한 가지를 선택하면 단품 추천을 받을 수 있어요.</div>
    <div style="display:flex; gap:14px; align-items:flex-start; flex-wrap:wrap;">
      <div class="btn-group" style="flex-direction:column; min-width:110px;">
        ${groups
          .map((g) => `<button type="button" class="tag-btn ${g === activeGroup ? "active" : ""}" data-group="${g}" style="width:100%;">${g}</button>`)
          .join("")}
      </div>
      <div class="btn-group" style="flex-direction:column; flex:1; min-width:160px;">
        ${leaves
          .map(
            (c) =>
              `<button type="button" class="tag-btn ${recommendFlow.singleCategory === c ? "active" : ""}" data-leaf="${c}" style="width:100%; text-align:left;">${c}</button>`
          )
          .join("")}
      </div>
    </div>
    <div style="display:flex; gap:10px; margin-top:20px;">
      <button type="button" class="tag-btn" id="recommendBackBtn">이전</button>
      <button type="button" id="recommendNextBtn" ${recommendFlow.singleCategory ? "" : "disabled"}>다음</button>
    </div>
  `;
}
function wireRecommendStep2Tree() {
  $$("#cview-recommend [data-group]").forEach((btn) => {
    btn.addEventListener("click", () => {
      recommendFlow.treeGroup = btn.dataset.group;
      renderRecommendStep();
    });
  });
  $$("#cview-recommend [data-leaf]").forEach((btn) => {
    btn.addEventListener("click", () => {
      recommendFlow.singleCategory = btn.dataset.leaf;
      renderRecommendStep();
    });
  });
  $("#recommendBackBtn").addEventListener("click", () => {
    recommendFlow.step = 1;
    renderRecommendStep();
  });
  $("#recommendNextBtn").addEventListener("click", () => {
    if (!recommendFlow.singleCategory) return;
    recommendFlow.step = 3;
    renderRecommendStep();
  });
}

function recommendStep3Html() {
  const isSingle = recommendFlow.occasion === "즉시상담";
  const summary = isSingle
    ? `선택 제품: ${recommendFlow.singleCategory}`
    : `선택한 제품군: ${
        Object.entries(recommendFlow.categories)
          .map(([c, p]) => `${c}(${p === "must" ? "필수" : "관심"})`)
          .join(", ") || "없음"
      }`;
  return `
    <div class="section-title">${recommendFlow.occasion}상담 · 고객 특성</div>
    <div class="small-muted" style="margin-bottom:14px;">${summary}</div>
    <form class="log-form" id="recommendForm">
      <div>
        <label>연령대</label>
        <select name="age_group"><option value="">전체</option>${AGE_GROUP_OPTIONS.map((o) => `<option value="${o}">${o}</option>`).join("")}</select>
      </div>
      <div>
        <label>성별</label>
        <select name="gender"><option value="">전체</option>${GENDER_OPTIONS.map((o) => `<option value="${o}">${o}</option>`).join("")}</select>
      </div>
      <div class="full">
        <label>거주지</label>
        <select name="residence_area"><option value="">전체</option>${RESIDENCE_OPTIONS.map((o) => `<option value="${o}">${o}</option>`).join("")}</select>
      </div>
      <div class="full section-title" style="margin:8px 0 0; font-size:14px;">고객 라이프스타일 <span class="badge">모델 구체화에 사용</span></div>
      <div>
        <label>거주인원수</label>
        <select name="household_size"><option value="">전체</option>${HOUSEHOLD_SIZE_OPTIONS.map((o) => `<option value="${o}">${o}</option>`).join("")}</select>
      </div>
      <div>
        <label>평형대</label>
        <select name="home_size_pyeong"><option value="">전체</option>${HOME_SIZE_PYEONG_OPTIONS.map((o) => `<option value="${o}">${o}</option>`).join("")}</select>
      </div>
      <div class="full">
        <label>설치환경</label>
        <select name="install_environment"><option value="">전체</option>${INSTALL_ENVIRONMENT_OPTIONS.map((o) => `<option value="${o}">${o}</option>`).join("")}</select>
      </div>
      <div class="full" style="display:flex; gap:10px;">
        <button type="button" class="tag-btn" id="recommendBackBtn">이전</button>
        <button type="submit">${isSingle ? "추천 상품 보기" : "추천 조합 만들기"}</button>
      </div>
    </form>
    <div id="recommendResult" style="margin-top:18px;"></div>
  `;
}
function wireRecommendStep3() {
  $("#recommendBackBtn").addEventListener("click", () => {
    recommendFlow.step = 2;
    renderRecommendStep();
  });
  $("#recommendForm").addEventListener("submit", onSubmitRecommendForm);
}

async function onSubmitRecommendForm(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const isSingle = recommendFlow.occasion === "즉시상담";
  const categories = isSingle ? [recommendFlow.singleCategory] : Object.keys(recommendFlow.categories);
  const mustCategories = isSingle
    ? []
    : Object.entries(recommendFlow.categories)
        .filter(([, p]) => p === "must")
        .map(([c]) => c);
  const filters = {
    age_group: fd.get("age_group") || "",
    gender: fd.get("gender") || "",
    residence_area: fd.get("residence_area") || "",
    household_size: fd.get("household_size") || "",
    home_size_pyeong: fd.get("home_size_pyeong") || "",
    install_environment: fd.get("install_environment") || "",
    purchase_occasion: recommendFlow.occasion,
    categories,
    must_categories: mustCategories,
    mode: isSingle ? "single" : "combo",
  };
  const resultEl = $("#recommendResult");
  resultEl.innerHTML = `<div class="small-muted">집계 중...</div>`;
  try {
    const res = await api("/api/recommend_bundle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(filters),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.combo || !data.combo.length) {
      resultEl.innerHTML = `
        <div class="card"><div class="small-muted">${data.message || "조건에 맞는 데이터가 아직 부족합니다."}</div></div>
        <button type="button" style="margin-top:12px;" id="recommendRestartBtn">처음부터 다시 선택</button>
      `;
      $("#recommendRestartBtn").addEventListener("click", renderConsultantRecommend);
      return;
    }
    const lifestyleNote = ["household_size", "home_size_pyeong", "install_environment"]
      .map((k) => filters[k])
      .filter(Boolean)
      .join(" · ");
    resultEl.innerHTML = `
      <div class="card">
        <div class="label">추천 멘트</div>
        <div style="margin:6px 0 14px;">${data.pitch || ""}</div>
        <div class="small-muted">전환 사례 ${data.sample_size}건 집계${data.relax_note ? " · " + data.relax_note : ""}</div>
        ${lifestyleNote ? `<div class="small-muted" style="margin-top:4px;">라이프스타일 조건: ${lifestyleNote}</div>` : ""}
      </div>
      ${data.combo
        .map((c) => {
          const p = c.recommended_product;
          return `
        <div class="card" style="margin-top:14px;">
          <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:10px; flex-wrap:wrap; gap:6px;">
            <div class="label" style="margin-bottom:0;">${c.product_category}</div>
            <div class="small-muted">전환 사례 중 ${c.pct}% · ${c.count}건</div>
          </div>
          ${
            p
              ? `<div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
                  <div>
                    <div style="font-weight:700; font-size:15.5px;">${p.name}</div>
                    <div class="small-muted">모델번호 ${p.model}</div>
                  </div>
                  <div style="font-weight:700; font-size:16px;">${p.price.toLocaleString()}원</div>
                </div>`
              : `<div class="small-muted">조건에 맞는 추천 모델이 없습니다.</div>`
          }
          ${c.examples && c.examples.length ? `<div class="small-muted" style="margin-top:8px;">실제 상담에서 언급된 모델: ${c.examples.join(", ")}</div>` : ""}
        </div>`;
        })
        .join("")}
      <div class="card" style="margin-top:14px; display:flex; justify-content:space-between; align-items:center;">
        <div class="label" style="margin-bottom:0;">조합 총액</div>
        <div style="font-weight:700; font-size:18px;">${(data.combo_total_price || 0).toLocaleString()}원</div>
      </div>
      <div class="small-muted" style="margin-top:10px;">※ 위 모델명/출고가는 참고용 더미데이터이며, 실제 재고·판매가와 다를 수 있습니다. 라이프스타일 조건을 입력하지 않은 항목은 대표 모델이 표시됩니다.</div>
      <button type="button" style="margin-top:16px;" id="recommendRestartBtn">처음부터 다시 선택</button>
    `;
    $("#recommendRestartBtn").addEventListener("click", renderConsultantRecommend);
  } catch (err) {
    resultEl.innerHTML = `<div class="small-muted">네트워크 오류로 추천을 가져오지 못했습니다.</div>`;
  }
}

/* ---------------- 내 실패 피드백 ----------------
 * 본인 매장 로그인 계정 범위 안에서만, AI가 저장된 요약 항목만 근거로 판단한 실패 사유와 코칭
 * 피드백(개선 방법) + 참고할 성공 사례를 보여준다. 다른 상담사/매장 통계는 조회할 수 없다
 * (자기계발 목적 예외). 매장 로그인 계정을 여러 판매사원이 같이 쓰는 경우를 위해, 상단에서
 * 담당 판매사원을 선택해 그 사람 기록만 좁혀볼 수 있다.
 */
let myFailuresConsultantFilter = "";
// 키워드/상품유형/가망고객 상태 필터는 서버 재조회 없이 이미 받아온 목록 안에서만 걸러낸다
// (담당 판매사원 선택만 서버 범위를 바꾸므로 재조회한다).
let myFailuresFilter = { keyword: "", product_category: "", lead_status: "" };
let myFailuresRawLogs = [];
let expandedMyFailureLogIds = new Set();

async function renderConsultantMyFailures() {
  myFailuresConsultantFilter = "";
  myFailuresFilter = { keyword: "", product_category: "", lead_status: "" };
  expandedMyFailureLogIds = new Set();
  const el = $("#cview-myfailures");
  el.innerHTML = `
    <div class="section-title">내 실패 피드백</div>
    <div class="small-muted" style="margin-bottom:14px;">
      본인 매장 로그인 계정 범위 안에서 구매 미전환 상담에 대해 AI가 판단한 실패 사유와 개선 방법입니다.
      다른 상담사나 매장 전체 통계는 이 화면에서 볼 수 없습니다. 일자 최신순으로 정렬되며, 행을 누르면
      상세내용을 펼쳐볼 수 있습니다.
    </div>
    <div id="myFailuresSummary" class="card" style="margin-bottom:16px;">
      <div class="label">개선하면 좋은 점</div>
      <div class="small-muted" style="margin-top:6px;">불러오는 중...</div>
    </div>
    <div class="card" style="margin-bottom:16px;">
      <div class="label">필터</div>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); margin:8px 0 0;">
        <div>
          <label style="font-size:12px;">키워드 검색</label>
          <input type="text" id="myFailuresKeyword" placeholder="실패사유/코칭/고객니즈/반응 등에서 검색" style="width:100%; box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:12px;">판매 사원</label>
          <select id="myFailuresConsultantSelect"><option value="">전체 (이 계정으로 기록된 모든 사원)</option></select>
        </div>
        <div>
          <label style="font-size:12px;">상품유형</label>
          <select id="myFailuresCategorySelect"><option value="">전체</option>${PRODUCT_CATEGORY_OPTIONS.map((c) => `<option value="${c}">${c}</option>`).join("")}</select>
        </div>
        <div>
          <label style="font-size:12px;">가망고객 상태</label>
          <select id="myFailuresStatusSelect"><option value="">전체</option>${LEAD_STATUS_OPTIONS.map((s) => `<option value="${s}">${s}</option>`).join("")}</select>
        </div>
      </div>
      <button type="button" id="myFailuresResetBtn" class="tag-btn" style="margin-top:12px;">필터 초기화</button>
    </div>
    <div id="myFailuresList" class="small-muted">불러오는 중...</div>
  `;
  $("#myFailuresConsultantSelect").addEventListener("change", (e) => {
    myFailuresConsultantFilter = e.target.value;
    loadMyFailures();
  });
  $("#myFailuresKeyword").addEventListener("input", (e) => {
    myFailuresFilter.keyword = e.target.value.trim();
    renderMyFailuresTable();
  });
  $("#myFailuresCategorySelect").addEventListener("change", (e) => {
    myFailuresFilter.product_category = e.target.value;
    renderMyFailuresTable();
  });
  $("#myFailuresStatusSelect").addEventListener("change", (e) => {
    myFailuresFilter.lead_status = e.target.value;
    renderMyFailuresTable();
  });
  $("#myFailuresResetBtn").addEventListener("click", () => {
    myFailuresFilter = { keyword: "", product_category: "", lead_status: "" };
    $("#myFailuresKeyword").value = "";
    $("#myFailuresCategorySelect").value = "";
    $("#myFailuresStatusSelect").value = "";
    renderMyFailuresTable();
  });
  await loadMyFailures();
}

// 실패 로그 목록만 근거로 만드는 결정적(비AI) 3줄 요약 - 대시보드의 buildStoreSummaryLines와 같은
// 원칙으로, OPENAI_API_KEY 유무와 무관하게 항상 동작한다.
function buildMyFailuresSummaryLines(logs) {
  if (!logs.length) {
    return ["아직 구매 미전환 상담 기록이 없어 요약할 내용이 없습니다."];
  }
  const topReason = mostCommon(logs.map((l) => l.failure_reason).filter(Boolean));
  const topCat = mostCommon(logs.map((l) => l.product_category).filter(Boolean));
  const refLog = logs.find((l) => l.success_reference && (l.success_reference.wow_point || l.success_reference.decision_point));
  const lines = [
    `최근 구매 미전환 상담 ${logs.length}건을 분석한 결과입니다.`,
    topReason ? `가장 흔한 실패 사유: "${topReason}"` : "아직 AI가 판단한 실패 사유가 충분히 쌓이지 않았습니다.",
  ];
  if (refLog) {
    const ref = refLog.success_reference;
    lines.push(`${topCat || "유사 상품"} 상담에서는 "${ref.wow_point || ref.decision_point}" 같은 포인트가 실제 전환으로 이어졌으니 참고해보세요.`);
  } else {
    lines.push(`${topCat || "-"} 유형 상담 비중이 가장 크니, 해당 유형의 코칭 피드백부터 살펴보세요.`);
  }
  return lines;
}

async function loadMyFailures() {
  const listEl = $("#myFailuresList");
  const summaryEl = $("#myFailuresSummary");
  listEl.textContent = "불러오는 중...";
  try {
    const qs = myFailuresConsultantFilter ? `?consultant_name=${encodeURIComponent(myFailuresConsultantFilter)}` : "";
    const res = await api("/api/consultant/my_failures" + qs);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      listEl.textContent = "불러오지 못했습니다.";
      return;
    }

    const sel = $("#myFailuresConsultantSelect");
    if (sel && sel.options.length <= 1) {
      (data.consultant_names || []).forEach((name) => {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        sel.appendChild(opt);
      });
    }

    myFailuresRawLogs = data.logs || [];
    summaryEl.innerHTML = `
      <div class="label">개선하면 좋은 점</div>
      <div style="margin-top:8px; line-height:1.7;">${buildMyFailuresSummaryLines(myFailuresRawLogs).map((line) => `<div>${line}</div>`).join("")}</div>
    `;
    renderMyFailuresTable();
  } catch (err) {
    listEl.textContent = "네트워크 오류로 불러오지 못했습니다.";
  }
}

// 키워드 검색 대상 필드 - 고객 이름/전화번호 등 개인식별정보는 애초에 이 로그에 저장되지 않으므로
// 검색 범위에 포함될 위험이 없다.
function myFailureSearchText(l) {
  return [
    l.product_category, l.purchase_occasion, l.consultant_name, l.customer_reaction,
    l.failure_reason, l.coach_feedback, l.customer_need, l.lead_note,
    l.recommended_product && l.recommended_product.name,
    l.recommended_policy && l.recommended_policy.name,
  ].filter(Boolean).join(" ").toLowerCase();
}

function myFailureRowHtml(l) {
  const expanded = expandedMyFailureLogIds.has(l.log_id);
  const ref = l.success_reference;
  const rp = l.recommended_product;
  const rpol = l.recommended_policy;
  const leadStatus = l.lead_status || "미처리";
  const summary = `<tr data-log-id="${escAttr(l.log_id)}" style="cursor:pointer;" title="눌러서 상세내용 보기">
    <td>${l.log_date || "-"}</td>
    <td>${l.consultant_name || "-"}</td>
    <td>${l.product_category || "-"} · ${l.purchase_occasion || "-"}</td>
    <td>${leadStatusPill(leadStatus)}</td>
    <td>${l.failure_reason || "-"}</td>
  </tr>`;
  if (!expanded) return summary;

  const detail = `<tr class="mf-detail-row" data-log-id="${escAttr(l.log_id)}">
    <td colspan="5">
      <div style="padding:10px 4px; line-height:1.7;">
        <div class="small-muted"><b>고객 반응:</b> ${l.customer_reaction || "-"}</div>
        ${l.coach_feedback ? `<div class="script-line" style="margin-top:8px;"><b>개선 방법:</b> ${l.coach_feedback}</div>` : ""}
        ${l.customer_need ? `<div class="script-line" style="margin-top:8px; border-left:3px solid var(--accent2);"><b>AI 판단 고객 니즈 (재상담 시 먼저 확인):</b> ${l.customer_need}</div>` : ""}
        ${
          rp || rpol
            ? `<div class="card-muted" style="margin-top:10px; padding:10px 12px;">
                <div class="label" style="margin-bottom:6px;">재상담 추천 조합</div>
                ${rp ? `<div class="small-muted">제품: <b>${rp.name}</b> (${rp.model}) · ${rp.price.toLocaleString()}원</div>` : ""}
                ${rpol ? `<div class="small-muted" style="margin-top:4px;">연동 판매정책: <b>${rpol.name}</b> - ${rpol.description}</div>` : ""}
               </div>`
            : ""
        }
        ${
          l.sms_message
            ? `<div style="margin-top:10px;">
                <div class="label" style="margin-bottom:6px;">고객 재상담용 문자메시지 초안</div>
                <textarea class="sms-text" readonly style="width:100%; min-height:78px; resize:vertical; font-size:13px; padding:8px; border:1px solid var(--border); border-radius:8px; background:var(--panel-muted);">${l.sms_message}</textarea>
                <div style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                  <button type="button" class="btn-sms-copy" style="padding:6px 12px; font-size:12.5px;">문자 내용 복사</button>
                  <span class="small-muted" style="font-size:11.5px;">이 앱은 문자를 직접 발송하지 않습니다 - 복사해서 직접 발송해주세요.</span>
                </div>
               </div>`
            : ""
        }
        ${
          ref
            ? `<div class="small-muted" style="margin-top:8px; padding-top:8px; border-top:1px dashed var(--border);">
                <b>참고할 성공 사례</b> (같은 상품유형 · 실제 전환 건)<br>
                ${ref.wow_point ? `Wow 포인트: ${ref.wow_point}<br>` : ""}${ref.decision_point ? `구매 결정 포인트: ${ref.decision_point}` : ""}
               </div>`
            : `<div class="small-muted" style="margin-top:8px;">아직 참고할 만한 유사 성공 사례가 없습니다.</div>`
        }
        <div style="margin-top:12px; padding-top:10px; border-top:1px solid var(--border);">
          <div class="label" style="margin-bottom:6px;">가망고객 관리</div>
          <div style="display:flex; flex-wrap:wrap; gap:8px; align-items:center;">
            <select class="lead-status-select" style="padding:6px 8px; font-size:13px;">
              ${LEAD_STATUS_OPTIONS.map((s) => `<option value="${s}" ${s === leadStatus ? "selected" : ""}>${s}</option>`).join("")}
            </select>
            <input type="date" class="lead-date-input" value="${escAttr(l.next_contact_date || "")}" style="padding:6px 8px; font-size:13px;">
          </div>
          <input type="text" class="lead-note-input" maxlength="200" placeholder="메모 (고객 이름/전화번호 입력 금지)" value="${escAttr(l.lead_note || "")}" style="width:100%; margin-top:8px; padding:7px 9px; font-size:13px; border:1px solid var(--border); border-radius:8px;">
          <div style="display:flex; align-items:center; gap:10px; margin-top:8px;">
            <button type="button" class="btn-lead-save" style="padding:6px 14px; font-size:12.5px;">저장</button>
            <span class="lead-save-msg small-muted" style="font-size:12px;"></span>
          </div>
        </div>
      </div>
    </td>
  </tr>`;
  return summary + detail;
}

// 실제 리스트 렌더링 - 서버 재조회 없이 myFailuresRawLogs 위에서 키워드/상품유형/가망고객상태로
// 걸러내고 일자 최신순(같은 날짜면 log_id순)으로 정렬한다. 상담 기록 탭(renderLogTab)과 동일한
// "행 클릭 → 상세 펼침" 패턴을 재사용해 화면 전체의 일관성을 유지한다.
function renderMyFailuresTable() {
  const listWrap = $("#myFailuresList");
  if (!listWrap) return;
  const kw = myFailuresFilter.keyword.toLowerCase();
  const logs = myFailuresRawLogs
    .filter((l) => !myFailuresFilter.product_category || logCategories(l).includes(myFailuresFilter.product_category) || l.product_category === myFailuresFilter.product_category)
    .filter((l) => !myFailuresFilter.lead_status || (l.lead_status || "미처리") === myFailuresFilter.lead_status)
    .filter((l) => !kw || myFailureSearchText(l).includes(kw))
    .slice()
    .sort((a, b) => (logSortKey(a) < logSortKey(b) ? 1 : logSortKey(a) > logSortKey(b) ? -1 : 0));

  if (!myFailuresRawLogs.length) {
    listWrap.outerHTML = `<div id="myFailuresList" class="small-muted">아직 구매 미전환 상담 기록이 없습니다.</div>`;
    return;
  }
  if (!logs.length) {
    listWrap.outerHTML = `<div id="myFailuresList" class="small-muted">조건에 맞는 기록이 없습니다.</div>`;
    return;
  }

  listWrap.outerHTML = `
    <div id="myFailuresList">
      <div class="small-muted" style="margin-bottom:8px;">${logs.length}건</div>
      <div class="table-scroll"><table>
        <thead><tr><th>일자</th><th>담당 사원</th><th>상품유형 · 구매유형</th><th>가망고객 상태</th><th>AI 실패 사유</th></tr></thead>
        <tbody>${logs.map(myFailureRowHtml).join("")}</tbody>
      </table></div>
    </div>
  `;

  $$("#myFailuresList tr[data-log-id]:not(.mf-detail-row)").forEach((row) => {
    row.addEventListener("click", () => {
      const id = row.dataset.logId;
      if (expandedMyFailureLogIds.has(id)) expandedMyFailureLogIds.delete(id);
      else expandedMyFailureLogIds.add(id);
      renderMyFailuresTable();
    });
  });
  $("#myFailuresList").querySelectorAll(".btn-sms-copy").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const text = btn.closest("tr").querySelector(".sms-text").value;
      copyTextToClipboard(text, btn);
    });
  });
  $("#myFailuresList").querySelectorAll(".btn-lead-save").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      saveLeadStatus(btn);
    });
  });
  $("#myFailuresList").querySelectorAll(".lead-status-select, .lead-date-input, .lead-note-input").forEach((elm) => {
    elm.addEventListener("click", (e) => e.stopPropagation());
  });
}

// sales_talk_log는 고객 이름/전화번호를 저장하지 않으므로, "가망고객"은 고객 개인이 아니라
// 이 실패 상담 로그 1건 자체를 추적 단위로 삼는다. 서버(sync_server.py)의 LEAD_STATUSES와
// 값을 맞춰둔다.
const LEAD_STATUS_OPTIONS = ["미처리", "가망고객 등록", "재상담 예정", "후속 접촉 완료", "이탈"];

function escAttr(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function copyTextToClipboard(text, btn) {
  const original = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "복사됨!";
  } catch (err) {
    try {
      // 클립보드 API를 못 쓰는 환경(구형 브라우저/권한 거부) 대비 폴백.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      btn.textContent = "복사됨!";
    } catch (err2) {
      btn.textContent = "복사 실패 - 직접 선택해주세요";
    }
  }
  setTimeout(() => { btn.textContent = original; }, 1800);
}

async function saveLeadStatus(btn) {
  const card = btn.closest("[data-log-id]");
  const logId = card.getAttribute("data-log-id");
  const status = card.querySelector(".lead-status-select").value;
  const nextDate = card.querySelector(".lead-date-input").value;
  const note = card.querySelector(".lead-note-input").value;
  const msgEl = card.querySelector(".lead-save-msg");
  btn.disabled = true;
  msgEl.style.color = "var(--muted)";
  msgEl.textContent = "저장 중...";
  try {
    const res = await api("/api/consultant/lead_status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ log_id: logId, lead_status: status, next_contact_date: nextDate, lead_note: note }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      msgEl.style.color = "var(--warn)";
      msgEl.textContent = data.message || "저장에 실패했습니다.";
    } else {
      msgEl.style.color = "var(--muted)";
      msgEl.textContent = "저장되었습니다.";
      // 목록에 이미 불러와 둔 데이터도 즉시 갱신해서, 다시 불러오지 않아도 상태 배지/필터가
      // 곧바로 최신값을 반영하게 한다 (내 실패 피드백 탭의 리스트/필터 정확성을 위함).
      const rec = myFailuresRawLogs.find((l) => l.log_id === logId);
      if (rec) {
        rec.lead_status = data.lead_status ?? status;
        rec.next_contact_date = data.next_contact_date ?? nextDate;
        rec.lead_note = data.lead_note ?? note;
        if (typeof renderMyFailuresTable === "function" && $("#myFailuresList")) {
          setTimeout(renderMyFailuresTable, 700); // 저장 메시지를 잠깐 보여준 뒤 배지를 갱신
        }
      }
    }
  } catch (err) {
    msgEl.style.color = "var(--warn)";
    msgEl.textContent = "네트워크 오류로 저장하지 못했습니다.";
  } finally {
    btn.disabled = false;
  }
}

/* =========================================================================
   매장/영업팀/본사 관리자 화면 - 데이터 분석 내역
   3단계 드릴다운: compare(본사 전체 영업팀 비교) → branch(영업팀 집계+매장 목록) → store(매장 단위 탭)
   - hq_manager: compare가 기본화면, 영업팀 선택 → branch, 매장 선택 → store
   - branch_manager: branch가 기본화면(자기 영업팀 고정), 매장 선택 → store
   - store_manager: store가 기본화면(자기 매장 고정, 상위 레벨 접근 불가)
   ========================================================================= */
function getBranch(id) { return (managerData.branches || []).find((b) => b.branch_id === id); }

function setupManagerHeader() {
  const role = session.role;
  const roleLabelMap = { hq_manager: "본사 관리자", branch_manager: "영업팀 관리자", store_manager: "지점장" };
  $("#managerRoleLabel").textContent = `${session.displayName} (${roleLabelMap[role] || "관리자"})`;

  const branchSel = $("#branchSelect");
  if (role === "hq_manager") {
    branchSel.style.display = "";
    branchSel.innerHTML = `<option value="">전체 비교</option>` +
      managerData.branches.map((b) => `<option value="${b.branch_id}">${b.branch_name}</option>`).join("");
    branchSel.value = managerViewLevel === "compare" ? "" : (currentBranchId || "");
    branchSel.onchange = () => {
      const val = branchSel.value;
      currentBranchId = val || null;
      currentStoreId = null;
      managerViewLevel = val ? "branch" : "compare";
      persistManagerNavState();
      renderManagerAll();
    };
  } else {
    branchSel.style.display = "none";
    branchSel.onchange = null;
  }
}

// 상위 레벨로 돌아갈 수 있는 링크 형태 브레드크럼. store_manager는 갈 수 있는 상위 레벨이
// 아예 없어서(항상 자기 매장 1곳) 표시하지 않는다.
function renderManagerBreadcrumb() {
  const el = $("#managerBreadcrumb");
  if (!el) return;
  const role = session.role;
  const crumbs = [];

  if (role === "hq_manager") {
    if (managerViewLevel !== "compare") {
      crumbs.push({ label: "전체 비교", action: () => {
        currentBranchId = null; currentStoreId = null; managerViewLevel = "compare";
        persistManagerNavState(); renderManagerAll();
      }});
    }
    if (managerViewLevel === "branch" || managerViewLevel === "store") {
      const b = getBranch(currentBranchId);
      const label = b ? b.branch_name : "영업팀";
      if (managerViewLevel === "store") {
        crumbs.push({ label, action: () => {
          currentStoreId = null; managerViewLevel = "branch";
          persistManagerNavState(); renderManagerAll();
        }});
      } else {
        crumbs.push({ label, current: true });
      }
    }
  } else if (role === "branch_manager" && managerViewLevel === "store") {
    const b = getBranch(currentBranchId);
    crumbs.push({ label: b ? b.branch_name : "영업팀", action: () => {
      currentStoreId = null; managerViewLevel = "branch";
      persistManagerNavState(); renderManagerAll();
    }});
  }

  if (managerViewLevel === "store" && currentStoreId) {
    const store = getStore(currentStoreId);
    crumbs.push({ label: store ? store.store_name : "매장", current: true });
  }

  if (!crumbs.length) {
    el.style.display = "none";
    el.innerHTML = "";
    return;
  }
  el.style.display = "";
  el.innerHTML = crumbs
    .map((c, i) => {
      const sep = i > 0 ? ` <span style="opacity:.5;">›</span> ` : "";
      return c.action
        ? `${sep}<a href="#" data-crumb="${i}" style="color:var(--accent); text-decoration:underline;">${c.label}</a>`
        : `${sep}<b>${c.label}</b>`;
    })
    .join("");
  crumbs.forEach((c, i) => {
    if (!c.action) return;
    const a = el.querySelector(`[data-crumb="${i}"]`);
    if (a) a.addEventListener("click", (e) => { e.preventDefault(); c.action(); });
  });
}

function applyManagerLevelVisibility() {
  $("#level-compare").classList.toggle("active", managerViewLevel === "compare");
  $("#level-branch").classList.toggle("active", managerViewLevel === "branch");
  $("#level-store").classList.toggle("active", managerViewLevel === "store");
}

// 매장 단위 탭(대시보드/세그먼트/상담기록/실패분석/통계)은 #level-store 안에서만 동작하므로,
// 쿼리를 그 안으로 한정한다 - 그렇지 않으면 level-compare/level-branch도 같은 .view 클래스를
// 써서(공통 표시/숨김 CSS 재사용) 탭 클릭이 엉뚱한 레벨의 표시 상태까지 건드리게 된다.
function initManagerTabs() {
  $$("#level-store nav.tabs button").forEach((btn) => {
    btn.onclick = () => {
      $$("#level-store nav.tabs button").forEach((b) => b.classList.remove("active"));
      $$("#level-store main .view").forEach((v) => v.classList.remove("active"));
      btn.classList.add("active");
      $(`#view-${btn.dataset.tab}`).classList.add("active");
    };
  });
}

function renderManagerAll() {
  setupManagerHeader();
  renderManagerBreadcrumb();
  applyManagerLevelVisibility();

  if (managerViewLevel === "compare") {
    renderCompareLevel();
    return;
  }
  if (managerViewLevel === "branch") {
    renderBranchLevel();
    return;
  }

  // managerViewLevel === "store"
  initManagerTabs();
  // "대시보드"라는 고정 탭명 대신 현재 선택된 매장명을 그대로 탭 이름으로 보여준다.
  const store = getStore(currentStoreId);
  const dashboardBtn = $("#level-store nav.tabs button[data-tab='dashboard']");
  if (dashboardBtn) dashboardBtn.textContent = store ? store.store_name : "매장 현황";
  renderDashboard();
  renderSegments();
  renderLogTab();
  renderFailureAnalysis();
  renderStats();
}

// 날짜 문자열(YYYY-MM-DD) 필드들 중 가장 최근 값을 찾는다. 샘플 데이터는 실제 달력상 "오늘"이 아니라
// 과거 특정 구간에 분포되어 있으므로, 매장별 "오늘(최근 영업일)"을 실측 데이터 안에서 정의해 일계
// 집계가 항상 의미 있는 값을 보여주도록 한다. 실서비스에서는 상담기록이 실제 당일에 쌓이므로
// 이 최근값이 곧 실제 오늘과 같아진다.
function latestDateStr(records, field) {
  let max = null;
  records.forEach((r) => {
    const v = r[field];
    if (v && (!max || v > max)) max = v;
  });
  return max;
}
function mostCommon(arr) {
  if (!arr.length) return null;
  const counts = {};
  arr.forEach((v) => (counts[v] = (counts[v] || 0) + 1));
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

// 상단 3줄 분석요약 - AI 호출 없이 실측 데이터에서 바로 계산되는 결정적 요약이라 항상 동작한다.
function buildStoreSummaryLines(store, logs) {
  if (!logs.length) {
    return [
      `${store.store_name}은(는) 아직 쌓인 상담 기록이 없습니다.`,
      "상담사가 상담기록을 남기기 시작하면 이 요약이 자동으로 채워집니다.",
      "먼저 상담기록 탭에서 몇 건을 입력해보세요.",
    ];
  }
  const converted = logs.filter((l) => l.purchase_converted === "Y").length;
  const convRate = Math.round((converted / logs.length) * 100);
  const topAge = mostCommon(logs.map((l) => l.age_group).filter(Boolean));
  const topGender = mostCommon(logs.map((l) => l.gender).filter(Boolean));
  const topCat = mostCommon(logs.map((l) => l.product_category).filter(Boolean));
  const failLogs = logs.filter((l) => l.purchase_converted === "N" && l.failure_reason);
  const line3 = failLogs.length
    ? `구매 미전환 상담 ${logs.length - converted}건 중 가장 흔한 실패 사유: "${mostCommon(failLogs.map((l) => l.failure_reason))}"`
    : `구매 미전환 상담에 AI 실패 사유 분석이 아직 쌓이지 않았습니다.`;
  return [
    `${store.store_name}은(는) 누적 상담 ${logs.length}건 중 ${converted}건이 구매로 전환됐습니다 (전환율 ${convRate}%).`,
    `가장 많이 상담한 고객층은 ${topAge || "-"} · ${topGender || "-"}이며, 가장 많이 상담된 상품유형은 ${topCat || "-"}입니다.`,
    line3,
  ];
}

// 사원별 당일 상담성공률 추이 그래프 - 매장 현황(대시보드) 탭에만 그려지고, 이 탭 자체가
// managerApp(지점장/영업팀 관리자/본사 관리자 전용) 안에만 있어서 판매사원 계정에는 애초에
// 노출되지 않는다. 기본은 최근 7일, 버튼을 누르면 최근 30일로 확장해서 같은 그래프를 다시 그린다.
let dashboardStaffTrendExpanded = false;

// refDateStr(그 매장 상담로그 중 가장 최근 날짜)를 기준으로 최근 n일치 날짜 문자열(YYYY-MM-DD)을
// 오름차순으로 만든다. 실제 달력상 "오늘"이 아니라 매장별 최근 영업일 기준인 점은 다른 일계 지표와 동일.
function lastNDateStrings(refDateStr, n) {
  if (!refDateStr) return [];
  const ref = new Date(refDateStr + "T00:00:00Z");
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(ref);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

const STAFF_TREND_COLORS = ["#2f6fed", "#0ea472", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#db2777", "#65a30d"];

// 사원(consultant_name)별 · 날짜별 구매전환율을 SVG 꺾은선 그래프로 그린다. AI 추정이 아니라
// 그 매장 상담로그를 그대로 집계한 값이라 항상 실측 데이터만 나온다. 상담이 없던 날은 값을
// 0%로 지어내지 않고 선을 끊어서(데이터 없음) 표시한다.
function staffDailySuccessChartHtml(logs, refDateStr, expanded) {
  const days = expanded ? 30 : 7;
  const dates = lastNDateStrings(refDateStr, days);
  if (!dates.length) {
    return `<div class="small-muted">아직 쌓인 상담 로그가 없어 사원별 성공률 추이를 표시할 수 없습니다.</div>`;
  }
  const staffNames = Array.from(new Set(logs.map((l) => l.consultant_name).filter(Boolean))).sort();
  if (!staffNames.length) {
    return `<div class="small-muted">담당 판매사원이 태깅된 상담 기록이 아직 없습니다.</div>`;
  }

  const byDateStaff = {};
  logs.forEach((l) => {
    if (!l.consultant_name || !dates.includes(l.log_date)) return;
    const dayBucket = (byDateStaff[l.log_date] = byDateStaff[l.log_date] || {});
    const s = (dayBucket[l.consultant_name] = dayBucket[l.consultant_name] || { total: 0, converted: 0 });
    s.total++;
    if (l.purchase_converted === "Y") s.converted++;
  });

  const W = 640, H = 220, padL = 34, padR = 12, padT = 14, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const xStep = dates.length > 1 ? plotW / (dates.length - 1) : 0;
  const xOf = (i) => padL + xStep * i;
  const yOf = (rate) => padT + plotH - (rate / 100) * plotH;

  const gridLines = [0, 25, 50, 75, 100]
    .map(
      (v) => `
    <line x1="${padL}" y1="${yOf(v)}" x2="${W - padR}" y2="${yOf(v)}" stroke="var(--border)" stroke-width="1" />
    <text x="${padL - 6}" y="${yOf(v) + 3}" font-size="10" fill="var(--muted)" text-anchor="end">${v}%</text>`
    )
    .join("");

  // 라벨이 많아지는 30일 모드에서는 다 표기하면 겹치므로 몇 개씩 건너뛰며 표기
  const labelEvery = dates.length > 10 ? Math.ceil(dates.length / 8) : 1;
  const xLabels = dates
    .map((d, i) =>
      i % labelEvery === 0 || i === dates.length - 1
        ? `<text x="${xOf(i)}" y="${H - 6}" font-size="10" fill="var(--muted)" text-anchor="middle">${d.slice(5)}</text>`
        : ""
    )
    .join("");

  const lines = staffNames
    .map((name, idx) => {
      const color = STAFF_TREND_COLORS[idx % STAFF_TREND_COLORS.length];
      // 상담이 없던 날은 값을 지어내지 않고 그냥 건너뛴다. 대신 실제 상담이 있었던 날짜들끼리는
      // 사이에 빈 날이 있어도 선으로 이어서(추세를 한눈에 보기 쉽게) 그린다 - 점만 찍히는 문제 수정.
      const points = dates
        .map((d, i) => {
          const rec = byDateStaff[d]?.[name];
          if (!rec || !rec.total) return null;
          return { x: xOf(i), y: yOf(Math.round((rec.converted / rec.total) * 100)) };
        })
        .filter(Boolean);
      const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
      const dots = points.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="2.5" fill="${color}" />`).join("");
      return `<path d="${path}" fill="none" stroke="${color}" stroke-width="2" />${dots}`;
    })
    .join("");

  const legend = staffNames
    .map((name, idx) => {
      const color = STAFF_TREND_COLORS[idx % STAFF_TREND_COLORS.length];
      const recs = dates.map((d) => byDateStaff[d]?.[name]).filter(Boolean);
      const total = recs.reduce((s, r) => s + r.total, 0);
      const converted = recs.reduce((s, r) => s + r.converted, 0);
      const avg = total ? Math.round((converted / total) * 100) : null;
      return `
      <div style="display:flex; align-items:center; gap:6px; font-size:12.5px;">
        <span style="width:10px; height:10px; border-radius:50%; background:${color}; display:inline-block; flex-shrink:0;"></span>
        <span>${name}</span>
        <span class="small-muted">${avg === null ? "데이터 없음" : `기간 평균 ${avg}%`}</span>
      </div>`;
    })
    .join("");

  return `
    <div style="overflow-x:auto; -webkit-overflow-scrolling:touch;">
      <svg viewBox="0 0 ${W} ${H}" style="width:100%; height:auto; min-width:480px; max-width:640px; display:block;">
        ${gridLines}
        ${lines}
        ${xLabels}
      </svg>
    </div>
    <div style="margin-top:10px; display:flex; flex-wrap:wrap; gap:10px 16px;">${legend}</div>
  `;
}

// 매장 현황 - 예전의 "대시보드"+"상권분석" 두 탭을 하나로 합쳤다. 탭 이름도 고정 문구 대신
// populateStoreSelect()에서 선택된 매장명으로 바꿔 보여준다.
function renderDashboard() {
  const store = getStore(currentStoreId);
  if (!store) { $("#view-dashboard").innerHTML = `<div class="small-muted">표시할 매장이 없습니다.</div>`; return; }
  const customers = getCustomers(currentStoreId);
  const logs = getLogs(currentStoreId);
  const converted = logs.filter((l) => l.purchase_converted === "Y").length;
  const convRate = logs.length ? Math.round((converted / logs.length) * 100) : 0;

  // "오늘" = 이 매장 상담로그 중 가장 최근 날짜 (실서비스에서는 실제 당일과 같아짐)
  const todayRef = latestDateStr(logs, "log_date") || latestDateStr(customers, "registered_date");
  const todaysLogs = todayRef ? logs.filter((l) => l.log_date === todayRef) : [];
  const todaysConverted = todaysLogs.filter((l) => l.purchase_converted === "Y").length;
  const todaysConvRate = todaysLogs.length ? Math.round((todaysConverted / todaysLogs.length) * 100) : 0;
  const todaysCustomers = todayRef ? customers.filter((c) => c.registered_date === todayRef).length : 0;
  const todayLabel = todayRef ? `${todayRef} 기준` : "데이터 없음";

  // 객단가 = 고객의 누적 구매액(total_purchase_amount) 평균. 상담로그에는 건별 판매금액이 없어서
  // (실거래 연동 전까지는) 고객이 지금까지 쓴 총액을 기준으로 낸다. CE/MX 구분은 고객의 최근
  // 구매품목(last_purchase_category)이 가전/모바일 중 어디에 속하는지로 나눈다 - 완벽한 매출
  // 분해는 아니지만, 현재 스키마에서 지어내지 않고 낼 수 있는 가장 근거 있는 근사치다.
  const withAmount = customers.filter((c) => c.total_purchase_amount);
  const ceCustomers = withAmount.filter((c) => productGroup(c.last_purchase_category) === "가전");
  const mxCustomers = withAmount.filter((c) => productGroup(c.last_purchase_category) === "모바일");
  const avgAmount = (arr) => (arr.length ? Math.round(arr.reduce((s, c) => s + c.total_purchase_amount, 0) / arr.length) : 0);
  const ceAvgOrder = avgAmount(ceCustomers);
  const mxAvgOrder = avgAmount(mxCustomers);
  const totalAvgOrder = avgAmount(withAmount);

  const summaryLines = buildStoreSummaryLines(store, logs);

  $("#view-dashboard").innerHTML = `
    <div class="section-title">${store.store_name}</div>
    <div class="small-muted" style="margin-bottom:14px;">${store.address} · 오픈 ${store.open_date}</div>

    <div class="card" style="margin-bottom:16px;">
      <div class="label">이 매장 분석 요약 (${todayLabel})</div>
      <div style="margin-top:8px; line-height:1.7;">
        ${summaryLines.map((line) => `<div>${line}</div>`).join("")}
      </div>
    </div>

    <div class="small-muted" style="margin-bottom:8px;">오늘 기준일: ${todayLabel} (매장 상담로그 중 가장 최근 날짜 - 실제 운영 중에는 당일과 같아집니다)</div>
    <div class="grid">
      <div class="card">
        <div class="label">등록 고객 수</div>
        <div class="stat-pair">
          <div class="stat-item today"><div class="stat-label">오늘</div><div class="stat-value">${todaysCustomers}명</div></div>
          <div class="stat-item"><div class="stat-label">누계</div><div class="stat-value">${customers.length}명</div></div>
        </div>
      </div>
      <div class="card">
        <div class="label">누적 상담 로그</div>
        <div class="stat-pair">
          <div class="stat-item today"><div class="stat-label">오늘</div><div class="stat-value">${todaysLogs.length}건</div></div>
          <div class="stat-item"><div class="stat-label">누계</div><div class="stat-value">${logs.length}건</div></div>
        </div>
      </div>
      <div class="card">
        <div class="label">구매 전환율</div>
        <div class="stat-pair">
          <div class="stat-item today">
            <div class="stat-label">오늘</div>
            <div class="stat-value">${todaysConvRate}%</div>
            <div class="small-muted" style="font-size:11px; margin-top:2px;">${todaysConverted}/${todaysLogs.length}건</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">누계</div>
            <div class="stat-value">${convRate}%</div>
            <div class="small-muted" style="font-size:11px; margin-top:2px;">${converted}/${logs.length}건</div>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="label">객단가 (고객 평균 누적구매액)</div>
        <div class="stat-pair triple">
          <div class="stat-item"><div class="stat-label">CE·가전</div><div class="stat-value">${ceAvgOrder.toLocaleString()}원</div></div>
          <div class="stat-item"><div class="stat-label">MX·모바일</div><div class="stat-value">${mxAvgOrder.toLocaleString()}원</div></div>
          <div class="stat-item total"><div class="stat-label">총 객단가</div><div class="stat-value">${totalAvgOrder.toLocaleString()}원</div></div>
        </div>
        <div class="small-muted" style="margin-top:8px; font-size:11px;">고객의 최근 구매품목 기준 CE/MX 분류, 누적 구매액 평균입니다.</div>
      </div>
    </div>

    <div class="section-title" style="margin-top:26px;">사원별 당일 상담성공률 추이</div>
    <div class="small-muted" style="margin-bottom:10px;">담당 판매사원별로 하루 상담 중 구매전환(성공)한 비율을 날짜별로 보여줍니다.
    기본은 ${dashboardStaffTrendExpanded ? "최근 30일" : "최근 7일"}이며, 아래 버튼으로 기간을 바꿀 수 있습니다.</div>
    <div class="card" style="margin-bottom:10px;">
      ${staffDailySuccessChartHtml(logs, todayRef, dashboardStaffTrendExpanded)}
      <div style="margin-top:12px;">
        <button type="button" id="staffTrendToggleBtn" class="tag-btn">${dashboardStaffTrendExpanded ? "최근 7일만 보기 ▲" : "최근 30일 보기 →"}</button>
      </div>
    </div>

    <div class="section-title" style="margin-top:26px;">실제 방문 고객 통계 (상담로그 ${logs.length}건 집계) <span class="badge">데이터 기반</span></div>
    <div class="grid">
      <div class="card"><div class="label">연령대 분포</div>${distributionBars(logs, "age_group")}</div>
      <div class="card"><div class="label">성별 분포</div>${distributionBars(logs, "gender")}</div>
      <div class="card"><div class="label">거주지 분포</div>${distributionBars(logs, "residence_area")}</div>
    </div>

    <div class="section-title" style="margin-top:26px;">상담 상품유형 (모바일 vs 가전) <span class="badge">데이터 기반</span></div>
    <div class="grid">
      <div class="card"><div class="label">모바일 / 가전 비중</div>${productGroupBars(logs)}</div>
      <div class="card"><div class="label">상품유형 세부 분포</div>${distributionBars(logs, "product_category")}</div>
    </div>
  `;

  const trendBtn = $("#staffTrendToggleBtn");
  if (trendBtn) {
    trendBtn.addEventListener("click", () => {
      dashboardStaffTrendExpanded = !dashboardStaffTrendExpanded;
      renderDashboard();
    });
  }
}

// 카테고리형 필드(연령대/성별/거주지 등)의 분포를 상담로그 실측 데이터로부터 집계해 막대로 표시
function distributionBars(logs, field) {
  const total = logs.length;
  if (!total) return `<div class="small-muted">아직 쌓인 상담 로그가 없습니다.</div>`;
  const counts = {};
  logs.forEach((l) => (counts[l[field]] = (counts[l[field]] || 0) + 1));
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return entries
    .map(([label, count]) => {
      const pct = Math.round((count / total) * 100);
      return `
        <div style="margin-bottom:10px;">
          <div style="display:flex; justify-content:space-between; font-size:13px; margin-bottom:4px;">
            <span>${label}</span><span class="small-muted">${count}건 (${pct}%)</span>
          </div>
          <div class="stat-bar"><div style="width:${pct}%"></div></div>
        </div>`;
    })
    .join("");
}

// 모바일/가전 대분류 비중 - product_category를 productGroup()으로 묶어서 집계
function productGroupBars(logs) {
  const total = logs.length;
  if (!total) return `<div class="small-muted">아직 쌓인 상담 로그가 없습니다.</div>`;
  const counts = {};
  logs.forEach((l) => {
    const g = productGroup(l.product_category);
    counts[g] = (counts[g] || 0) + 1;
  });
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return entries
    .map(([label, count]) => {
      const pct = Math.round((count / total) * 100);
      return `
        <div style="margin-bottom:10px;">
          <div style="display:flex; justify-content:space-between; font-size:13px; margin-bottom:4px;">
            <span>${label}</span><span class="small-muted">${count}건 (${pct}%)</span>
          </div>
          <div class="stat-bar"><div style="width:${pct}%"></div></div>
        </div>`;
    })
    .join("");
}

// 고객세그먼트 탭의 CE(가전)/MX(모바일) 탭 선택 상태 - 매장을 바꿔도 선택된 탭은 유지한다.
let segmentGroupTab = "CE";

// segLogs(이미 CE 또는 MX로 필터링된 상담로그)를 segment_id별로 묶어서, 세그먼트마다
// 연령대 분포까지 하위에 보여주는 카드 그리드를 만든다. 세그먼트 정보(설명/추천상품/타이밍)는
// customer_segments 마스터 데이터에서 가져온다.
function renderSegmentGroup(segLogs) {
  if (!segLogs.length) {
    return `<div class="small-muted">이 품목군에는 아직 쌓인 상담 로그가 없습니다.</div>`;
  }
  const bySeg = {};
  segLogs.forEach((l) => {
    const key = l.segment_id || "UNASSIGNED";
    (bySeg[key] = bySeg[key] || []).push(l);
  });
  const total = segLogs.length;
  const entries = Object.entries(bySeg).sort((a, b) => b[1].length - a[1].length);
  const cards = entries
    .map(([segId, logsInSeg]) => {
      const meta = managerData.customer_segments.find((s) => s.segment_id === segId);
      const name = meta ? meta.segment_name : "미지정 세그먼트";
      const pct = Math.round((logsInSeg.length / total) * 100);
      return `
      <div class="card segment-card">
        <div class="label">${name}</div>
        <div class="value">${logsInSeg.length}건 <span class="small-muted" style="font-size:13px;font-weight:400;">(${pct}%)</span></div>
        ${meta ? `<div class="sub">${meta.criteria_desc}</div>` : ""}
        <div class="stat-bar"><div style="width:${pct}%"></div></div>
        <div style="margin-top:10px;">${distributionBars(logsInSeg, "age_group")}</div>
        ${meta ? `<div class="small-muted" style="margin-top:8px;"><b>추천 상품:</b> ${meta.target_products}</div><div class="small-muted"><b>추천 타이밍:</b> ${meta.recommended_timing}</div>` : ""}
      </div>`;
    })
    .join("");
  return `<div class="grid">${cards}</div>`;
}

function renderSegments() {
  const logs = getLogs(currentStoreId);
  // 상담 상품유형은 다중 선택이 가능해서, 한 상담이 CE/MX 양쪽 다 걸치면 두 그룹 통계에 모두 반영한다
  // (서버쪽 /api/segment_insight와 동일한 규칙).
  const ceLogs = logs.filter((l) => logCategories(l).some((c) => productGroup(c) === "가전"));
  const mxLogs = logs.filter((l) => logCategories(l).some((c) => productGroup(c) === "모바일"));

  $("#view-segments").innerHTML = `
    <div class="section-title">고객 세그먼트 분포 (본 매장)</div>
    <div class="card" id="segmentInsightCard" style="margin-bottom:16px;">
      <div class="label">AI 운영 인사이트</div>
      <div id="segmentInsightBody" class="small-muted" style="margin-top:6px; line-height:1.6;">불러오는 중...</div>
    </div>
    <div class="btn-group" id="segGroupTabs" style="margin-bottom:16px;">
      <button type="button" class="tag-btn ${segmentGroupTab === "CE" ? "active" : ""}" data-seggroup="CE">CE · 가전 (${ceLogs.length}건)</button>
      <button type="button" class="tag-btn ${segmentGroupTab === "MX" ? "active" : ""}" data-seggroup="MX">MX · 모바일 (${mxLogs.length}건)</button>
    </div>
    <div id="segmentGroupBody">${renderSegmentGroup(segmentGroupTab === "CE" ? ceLogs : mxLogs)}</div>
  `;

  $$("#segGroupTabs [data-seggroup]").forEach((btn) => {
    btn.addEventListener("click", () => {
      segmentGroupTab = btn.dataset.seggroup;
      renderSegments();
    });
  });

  loadSegmentInsight();
}

async function loadSegmentInsight() {
  const el = $("#segmentInsightBody");
  if (!el) return;
  try {
    const res = await api("/api/segment_insight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ store_id: currentStoreId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      el.textContent = data.message || "인사이트를 불러오지 못했습니다.";
      return;
    }
    const lines = (data.insight || "인사이트를 생성할 만큼 데이터가 아직 쌓이지 않았습니다.")
      .split("\n")
      .filter((l) => l.trim());
    el.innerHTML = lines.map((line) => `<div>${line}</div>`).join("");
  } catch (err) {
    el.textContent = "네트워크 오류로 인사이트를 불러오지 못했습니다.";
  }
}

function reactionPill(r) {
  const cls = r === "긍정" ? "pos" : r === "부정" ? "neg" : "neu";
  return `<span class="pill ${cls}">${r}</span>`;
}
function sourcePill(s) {
  return s === "ai_transcribed" ? `<span class="pill ai">AI 분석</span>` : `<span class="pill manual">수동입력</span>`;
}
// 가망고객 관리 상태 배지 - sync_server.py의 LEAD_STATUSES와 값을 맞춰둔다.
function leadStatusPill(status) {
  const s = status || "미처리";
  const clsMap = { "미처리": "neu", "가망고객 등록": "mobile", "재상담 예정": "appliance", "후속 접촉 완료": "pos", "이탈": "neg" };
  return `<span class="pill ${clsMap[s] || "neu"}">${s}</span>`;
}

// 상담 기록(구 "세일즈톡 로그") 탭의 필터 상태 + 펼쳐진 상세보기 행. 매장을 바꾸거나 다시 렌더링해도
// 사용자가 고른 필터/펼침 상태가 유지되도록 모듈 전역에 둔다.
let logTabFilter = { age_group: "", gender: "", product_category: "", purchase_occasion: "", purchase_converted: "", consultant_name: "" };
let expandedLogIds = new Set();

// log_date(일자)가 같은 로그가 여러 건이면, 서버가 저장 순서대로 부여한 log_id를 2차 기준으로 써서
// "상담을 종료한 시점 순서"에 최대한 가깝게 정렬한다 (이 앱은 종료 시각까지는 따로 기록하지 않음).
function logSortKey(l) {
  return `${l.log_date || ""}_${l.log_id || ""}`;
}

function logTableRowHtml(l) {
  const expanded = expandedLogIds.has(l.log_id);
  const summary = `<tr data-log-id="${l.log_id}" style="cursor:pointer;" title="눌러서 상세내용 보기">
    <td>${l.log_date}</td>
    <td>${l.consultant_name || l.staff_id || "-"}</td>
    <td>${l.age_group || "-"}</td>
    <td>${l.gender || "-"}</td>
    <td>${
      logCategories(l).length
        ? logCategories(l).map((c) => `<span class="pill ${productGroup(c) === "가전" ? "appliance" : "mobile"}">${c}</span>`).join(" ")
        : "-"
    }</td>
    <td>${l.purchase_occasion || "-"}</td>
    <td>${l.purchase_converted === "Y" ? "✅" : "—"}</td>
    <td>${sourcePill(l.source)}</td>
  </tr>`;
  if (!expanded) return summary;
  const detail = `<tr class="log-detail-row">
    <td colspan="8">
      <div style="padding:10px 4px; line-height:1.8;">
        <div><b>로그ID:</b> ${l.log_id} · <b>로그인 계정:</b> ${l.staff_id || "-"} · <b>거주지:</b> ${l.residence_area || "-"}</div>
        <div style="margin-top:4px;"><b>구매 품목:</b> ${l.purchased_item || "-"} · <b>세그먼트:</b> ${getSegment(l.segment_id)?.segment_name || "-"}</div>
        <div style="margin-top:4px;"><b>고객 반응:</b> ${reactionPill(l.customer_reaction)}</div>
        <div style="margin-top:4px;"><b>Wow 포인트:</b> ${l.wow_point || "-"}</div>
        <div style="margin-top:4px;"><b>구매 결정 포인트:</b> ${l.decision_point || "-"}</div>
        ${
          l.purchase_converted === "N"
            ? `<div style="margin-top:4px;"><b>AI 실패 사유:</b> ${l.failure_reason || "-"}</div>
               <div style="margin-top:4px;"><b>AI 코칭 피드백:</b> ${l.coach_feedback || "-"}</div>`
            : ""
        }
      </div>
    </td>
  </tr>`;
  return summary + detail;
}

function renderLogTab() {
  const allLogs = getLogs(currentStoreId);
  const consultantNames = Array.from(new Set(allLogs.map((l) => l.consultant_name).filter(Boolean))).sort();

  const logs = allLogs
    .filter((l) => !logTabFilter.age_group || l.age_group === logTabFilter.age_group)
    .filter((l) => !logTabFilter.gender || l.gender === logTabFilter.gender)
    .filter((l) => !logTabFilter.product_category || logCategories(l).includes(logTabFilter.product_category))
    .filter((l) => !logTabFilter.purchase_occasion || l.purchase_occasion === logTabFilter.purchase_occasion)
    .filter((l) => !logTabFilter.purchase_converted || l.purchase_converted === logTabFilter.purchase_converted)
    .filter((l) => !logTabFilter.consultant_name || l.consultant_name === logTabFilter.consultant_name)
    .slice()
    .sort((a, b) => (logSortKey(a) < logSortKey(b) ? 1 : logSortKey(a) > logSortKey(b) ? -1 : 0));

  const opt = (current, options) =>
    `<option value="">전체</option>${options.map((o) => `<option value="${o}" ${current === o ? "selected" : ""}>${o}</option>`).join("")}`;

  $("#view-log").innerHTML = `
    <div class="section-title">상담 기록 <span class="badge">${logs.length}건</span></div>
    <div class="small-muted" style="margin-bottom:12px;">
      로그 입력은 매장 상담사용 화면에서 이뤄지며, 이 화면은 조회 전용입니다. 상담을 종료한 시점(일자) 최신순으로
      정렬됩니다. 행을 누르면 상세내용을 펼쳐볼 수 있습니다.
    </div>

    <div class="card" style="margin-bottom:16px;">
      <div class="label">필터</div>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); margin:8px 0 0;">
        <div><label style="font-size:12px;">연령대</label><select id="logFilterAge">${opt(logTabFilter.age_group, AGE_GROUP_OPTIONS)}</select></div>
        <div><label style="font-size:12px;">성별</label><select id="logFilterGender">${opt(logTabFilter.gender, GENDER_OPTIONS)}</select></div>
        <div><label style="font-size:12px;">상품유형</label><select id="logFilterCategory">${opt(logTabFilter.product_category, PRODUCT_CATEGORY_OPTIONS)}</select></div>
        <div><label style="font-size:12px;">구매유형</label><select id="logFilterOccasion">${opt(logTabFilter.purchase_occasion, PURCHASE_OCCASION_OPTIONS)}</select></div>
        <div><label style="font-size:12px;">전환여부</label><select id="logFilterConverted">${opt(logTabFilter.purchase_converted, ["Y", "N"])}</select></div>
        <div><label style="font-size:12px;">담당 사원</label><select id="logFilterConsultant">${opt(logTabFilter.consultant_name, consultantNames)}</select></div>
      </div>
      <button type="button" id="logFilterResetBtn" class="tag-btn" style="margin-top:12px;">필터 초기화</button>
    </div>

    <div class="table-scroll"><table>
      <thead><tr><th>일자</th><th>담당 사원</th><th>연령대</th><th>성별</th><th>상품유형</th><th>구매유형</th><th>전환</th><th>출처</th></tr></thead>
      <tbody>
        ${logs.length ? logs.map(logTableRowHtml).join("") : `<tr><td colspan="8" class="small-muted">조건에 맞는 상담 기록이 없습니다.</td></tr>`}
      </tbody>
    </table></div>
  `;

  const bind = (id, key) => $(`#${id}`).addEventListener("change", (e) => { logTabFilter[key] = e.target.value; renderLogTab(); });
  bind("logFilterAge", "age_group");
  bind("logFilterGender", "gender");
  bind("logFilterCategory", "product_category");
  bind("logFilterOccasion", "purchase_occasion");
  bind("logFilterConverted", "purchase_converted");
  bind("logFilterConsultant", "consultant_name");
  $("#logFilterResetBtn").addEventListener("click", () => {
    logTabFilter = { age_group: "", gender: "", product_category: "", purchase_occasion: "", purchase_converted: "", consultant_name: "" };
    renderLogTab();
  });

  $$("#view-log tr[data-log-id]").forEach((row) => {
    row.addEventListener("click", () => {
      const id = row.dataset.logId;
      if (expandedLogIds.has(id)) expandedLogIds.delete(id);
      else expandedLogIds.add(id);
      renderLogTab();
    });
  });
}

// 같은 상품유형(가능하면 같은 세그먼트까지)에서 실제로 전환된 사례를 찾아 "참고할 성공 사례"로
// 붙여준다. 실패 사유를 통보하는 데서 끝나지 않고, 바로 적용해볼 수 있는 성공 패턴을 함께 보여주기 위함.
// 실패분석 탭 최상단에 먼저 보여줄 "매장 전체 주요 실패요인" 요약. 사원별로 쪼개기 전에,
// 이 매장에서 고객이 구매하지 않은 이유가 전체적으로 무엇인지부터 한눈에 보여준다.
function failureReasonSummaryHtml(failLogs) {
  const total = failLogs.length;
  if (!total) {
    return `
    <div class="card" style="margin-bottom:14px;">
      <div class="label">주요 실패 요인 (구매 미전환 사유)</div>
      <div class="small-muted" style="margin-top:8px;">아직 구매로 이어지지 않은 상담 기록이 없습니다.</div>
    </div>`;
  }
  const counts = {};
  failLogs.forEach((l) => {
    const reason = l.failure_reason || "미분류";
    counts[reason] = (counts[reason] || 0) + 1;
  });
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const [topReason, topCount] = entries[0];
  const topPct = Math.round((topCount / total) * 100);
  return `
  <div class="card" style="margin-bottom:14px;">
    <div class="label">주요 실패 요인 (구매 미전환 ${total}건 기준)</div>
    <div class="small-muted" style="margin-top:4px;">가장 흔한 사유: <b>"${topReason}"</b> (${topCount}건 · ${topPct}%)</div>
    <div style="margin-top:12px; display:flex; flex-direction:column; gap:8px;">
      ${entries
        .map(([reason, count]) => {
          const pct = Math.round((count / total) * 100);
          return `
          <div>
            <div style="display:flex; justify-content:space-between; font-size:12.5px;">
              <span>${reason}</span>
              <span class="small-muted">${count}건 · ${pct}%</span>
            </div>
            <div class="stat-bar"><div style="width:${pct}%"></div></div>
          </div>`;
        })
        .join("")}
    </div>
  </div>`;
}

function findSuccessReference(successLogs, failLog) {
  const failCats = new Set(logCategories(failLog));
  const candidates = successLogs.filter((l) => logCategories(l).some((c) => failCats.has(c)) && (l.wow_point || l.decision_point));
  if (!candidates.length) return null;
  const sameSeg = candidates.filter((l) => l.segment_id === failLog.segment_id);
  return (sameSeg.length ? sameSeg : candidates)[0];
}

// 실패 분석 탭에서 펼쳐진 사원 이름들 (매장을 바꿔도 유지)
let expandedFailureEmployees = new Set();

// 실패 분석: "매장 전체" 하나로 뭉뚱그리지 않고 담당 사원(공용 로그인 계정 안에서도 consultant_name으로
// 구분)별로 나눠서 보여준다. 각 실패 케이스마다 AI 실패사유/코칭피드백(개선 방법)과 함께, 같은
// 상품유형에서 실제 전환된 참고 성공 사례를 같이 제시해 "통보"가 아니라 "적용 가능한 개선"이 되도록 한다.
function renderFailureAnalysis() {
  const logs = getLogs(currentStoreId);
  const successLogs = logs.filter((l) => l.purchase_converted === "Y");
  const failLogs = logs.filter((l) => l.purchase_converted === "N");

  const byEmployee = {};
  logs.forEach((l) => {
    const key = l.consultant_name || l.staff_id || "미상";
    (byEmployee[key] = byEmployee[key] || { all: [], fails: [] }).all.push(l);
    if (l.purchase_converted === "N") byEmployee[key].fails.push(l);
  });
  const employeeEntries = Object.entries(byEmployee).sort((a, b) => b[1].fails.length - a[1].fails.length);

  const sections = employeeEntries
    .map(([name, data]) => {
      const total = data.all.length;
      const failCount = data.fails.length;
      const convRate = total ? Math.round(((total - failCount) / total) * 100) : 0;
      const expanded = expandedFailureEmployees.has(name);
      const rows = data.fails
        .slice()
        .sort((a, b) => (logSortKey(a) < logSortKey(b) ? 1 : logSortKey(a) > logSortKey(b) ? -1 : 0))
        .map((l) => {
          const ref = findSuccessReference(successLogs, l);
          return `
          <div class="card" style="margin-bottom:10px;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
              <div class="label">${l.log_date} · ${l.product_category || "-"} · ${l.purchase_occasion || "-"}</div>
              ${leadStatusPill(l.lead_status)}
            </div>
            <div class="small-muted" style="margin-top:6px;"><b>고객 반응:</b> ${reactionPill(l.customer_reaction)}</div>
            <div class="small-muted" style="margin-top:8px;"><b>AI 실패 사유:</b> ${l.failure_reason || "-"}</div>
            <div class="script-line" style="margin-top:8px;"><b>개선 방법:</b> ${l.coach_feedback || "아직 코칭 피드백이 생성되지 않았습니다."}</div>
            ${l.customer_need ? `<div class="small-muted" style="margin-top:8px;"><b>AI 판단 고객 니즈:</b> ${l.customer_need}</div>` : ""}
            ${l.next_contact_date ? `<div class="small-muted" style="margin-top:4px;"><b>후속 접촉 예정일:</b> ${l.next_contact_date}</div>` : ""}
            ${
              ref
                ? `<div class="small-muted" style="margin-top:8px; padding-top:8px; border-top:1px dashed var(--border);">
                    <b>참고할 성공 사례</b> (같은 상품유형에서 실제 전환된 건)<br>
                    ${ref.wow_point ? `Wow 포인트: ${ref.wow_point}<br>` : ""}${ref.decision_point ? `구매 결정 포인트: ${ref.decision_point}` : ""}
                   </div>`
                : `<div class="small-muted" style="margin-top:8px;">아직 참고할 만한 유사 성공 사례가 없습니다.</div>`
            }
          </div>`;
        })
        .join("");
      const leadCounts = {};
      data.fails.forEach((l) => { const s = l.lead_status || "미처리"; leadCounts[s] = (leadCounts[s] || 0) + 1; });
      const leadSummary = LEAD_STATUS_OPTIONS.filter((s) => leadCounts[s]).map((s) => `${s} ${leadCounts[s]}`).join(" · ");
      return `
      <div class="card" style="margin-bottom:14px;">
        <div data-employee="${name}" style="display:flex; justify-content:space-between; align-items:center; cursor:pointer;">
          <div>
            <div class="label" style="margin-bottom:2px;">${name}</div>
            <div class="small-muted">전체 상담 ${total}건 · 구매전환율 ${convRate}% · 미전환 ${failCount}건</div>
            ${leadSummary ? `<div class="small-muted" style="margin-top:2px;">가망고객 현황: ${leadSummary}</div>` : ""}
          </div>
          <div class="small-muted">${expanded ? "▲ 접기" : "▼ 펼치기"}</div>
        </div>
        ${expanded ? `<div style="margin-top:14px;">${failCount ? rows : `<div class="small-muted">미전환 상담이 없습니다.</div>`}</div>` : ""}
      </div>`;
    })
    .join("");

  const overallLeadCounts = {};
  failLogs.forEach((l) => { const s = l.lead_status || "미처리"; overallLeadCounts[s] = (overallLeadCounts[s] || 0) + 1; });
  const overallLeadSummary = LEAD_STATUS_OPTIONS.filter((s) => overallLeadCounts[s]).map((s) => `${s} <b>${overallLeadCounts[s]}</b>건`).join(" · ");

  $("#view-failures").innerHTML = `
    <div class="section-title">실패 분석 <span class="badge">${failLogs.length}건</span></div>
    <div class="small-muted" style="margin-bottom:8px;">
      구매로 이어지지 않은 상담을 사원별로 나눠서 보여줍니다. 각 케이스마다 AI가 판단한 실패 사유와 개선 방법,
      그리고 같은 상품유형에서 실제로 전환된 참고 성공 사례를 함께 제시합니다. 사원 이름을 눌러 펼치거나 접어보세요.
    </div>
    ${failureReasonSummaryHtml(failLogs)}
    ${overallLeadSummary ? `<div class="card card-muted" style="margin-bottom:14px; padding:10px 14px;"><div class="label" style="margin-bottom:4px;">전체 가망고객 현황</div><div class="small-muted">${overallLeadSummary}</div></div>` : ""}
    <div class="section-title" style="margin-top:6px; margin-bottom:8px;">사원별 실패 관리</div>
    ${employeeEntries.length ? sections : `<div class="small-muted">아직 쌓인 상담 기록이 없습니다.</div>`}
  `;

  $$("#view-failures [data-employee]").forEach((header) => {
    header.addEventListener("click", () => {
      const name = header.dataset.employee;
      if (expandedFailureEmployees.has(name)) expandedFailureEmployees.delete(name);
      else expandedFailureEmployees.add(name);
      renderFailureAnalysis();
    });
  });
}

function renderStats() {
  const logs = getLogs(currentStoreId);
  const bySegment = {};
  logs.forEach((l) => {
    const seg = getSegment(l.segment_id)?.segment_name || "미분류";
    if (!bySegment[seg]) bySegment[seg] = { total: 0, converted: 0 };
    bySegment[seg].total++;
    if (l.purchase_converted === "Y") bySegment[seg].converted++;
  });

  const byProduct = {};
  const byGroup = {};
  logs.forEach((l) => {
    const cat = l.product_category || "미분류";
    if (!byProduct[cat]) byProduct[cat] = { total: 0, converted: 0 };
    byProduct[cat].total++;
    if (l.purchase_converted === "Y") byProduct[cat].converted++;

    const grp = productGroup(l.product_category);
    if (!byGroup[grp]) byGroup[grp] = { total: 0, converted: 0 };
    byGroup[grp].total++;
    if (l.purchase_converted === "Y") byGroup[grp].converted++;
  });

  const wowFreq = {};
  logs.forEach((l) => (wowFreq[l.wow_point] = (wowFreq[l.wow_point] || 0) + 1));
  const topWow = Object.entries(wowFreq).sort((a, b) => b[1] - a[1]).slice(0, 5);

  $("#view-stats").innerHTML = `
    <div class="section-title">세그먼트별 전환율</div>
    <div class="table-scroll"><table>
      <thead><tr><th>세그먼트</th><th>상담건수</th><th>전환건수</th><th>전환율</th></tr></thead>
      <tbody>
        ${Object.entries(bySegment)
          .map(([seg, v]) => {
            const rate = v.total ? Math.round((v.converted / v.total) * 100) : 0;
            return `<tr><td>${seg}</td><td>${v.total}</td><td>${v.converted}</td><td>${rate}%</td></tr>`;
          })
          .join("")}
      </tbody>
    </table></div>

    <div class="section-title" style="margin-top:26px;">모바일 vs 가전 전환율</div>
    <div class="table-scroll"><table>
      <thead><tr><th>구분</th><th>상담건수</th><th>전환건수</th><th>전환율</th></tr></thead>
      <tbody>
        ${Object.entries(byGroup)
          .map(([grp, v]) => {
            const rate = v.total ? Math.round((v.converted / v.total) * 100) : 0;
            return `<tr><td>${grp}</td><td>${v.total}</td><td>${v.converted}</td><td>${rate}%</td></tr>`;
          })
          .join("")}
      </tbody>
    </table></div>

    <div class="section-title">상품유형별 전환율</div>
    <div class="table-scroll"><table>
      <thead><tr><th>상품유형</th><th>상담건수</th><th>전환건수</th><th>전환율</th></tr></thead>
      <tbody>
        ${Object.entries(byProduct)
          .sort((a, b) => b[1].total - a[1].total)
          .map(([cat, v]) => {
            const rate = v.total ? Math.round((v.converted / v.total) * 100) : 0;
            return `<tr><td>${cat}</td><td>${v.total}</td><td>${v.converted}</td><td>${rate}%</td></tr>`;
          })
          .join("")}
      </tbody>
    </table></div>

    <div class="section-title">자주 나온 Wow 포인트 Top 5</div>
    <div class="table-scroll"><table>
      <thead><tr><th>Wow 포인트</th><th>빈도</th></tr></thead>
      <tbody>
        ${topWow.map(([w, n]) => `<tr><td>${w}</td><td>${n}</td></tr>`).join("")}
      </tbody>
    </table></div>
  `;
}

/* 본사 관리자 전용: 지사별 비교. 예전엔 "최다 연령대/최다 상품유형" 같은 단순 집계 테이블만 있어서
   운영에 바로 쓸 인사이트가 없었다. 이제 "판매"(전환율/객단가/CE·MX 비중)와 "판촉"(구매유형/실패
   사유/Wow포인트/세그먼트) 두 축의 KPI로 재구성하고, 서버가 집계한 숫자를 근거로 AI가 만든 비교
   인사이트를 최상단에 보여준다 (숫자 자체는 항상 서버 계산 - AI는 문구만 다듬음). */
// /api/branch_insight는 AI 호출이 섞여 있어 매번 다시 부르지 않고, 동기화(새로고침) 전까지는
// 한 번 불러온 결과를 compare/branch 두 레벨이 같이 재사용한다.
async function ensureBranchInsight() {
  if (branchInsightCache) return branchInsightCache;
  try {
    const res = await api("/api/branch_insight", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    const data = await res.json().catch(() => ({}));
    branchInsightCache = res.ok ? data : { branches: [], insight: null, message: data.message || "불러오지 못했습니다." };
  } catch (err) {
    branchInsightCache = { branches: [], insight: null, message: "네트워크 오류로 불러오지 못했습니다." };
  }
  return branchInsightCache;
}

function fmtTopStat(t) {
  return t ? `${t.name} (${t.pct}%)` : "-";
}

// 본사 관리자 기본화면: 전체 영업팀 비교 + 영업팀별 드릴다운 버튼.
function renderCompareLevel() {
  $("#level-compare").innerHTML = `
    <div class="section-title">영업팀별 비교 (전사 관점)</div>
    <div class="card" style="margin-bottom:16px;">
      <div class="label">AI 운영 인사이트</div>
      <div id="branchInsightBody" class="small-muted" style="margin-top:6px; line-height:1.6;">불러오는 중...</div>
    </div>
    <div id="branchDrilldownBody"></div>
    <div id="branchKpiBody"><div class="small-muted">불러오는 중...</div></div>
  `;
  loadCompareLevelData();
}

async function loadCompareLevelData() {
  const insightEl = $("#branchInsightBody");
  const drillEl = $("#branchDrilldownBody");
  const kpiEl = $("#branchKpiBody");
  if (!insightEl || !kpiEl) return;
  const data = await ensureBranchInsight();
  if (data.message && !data.branches.length) {
    insightEl.textContent = data.message;
    kpiEl.innerHTML = "";
    return;
  }
  const lines = (data.insight || "인사이트를 생성할 만큼 데이터가 아직 쌓이지 않았습니다.")
    .split("\n")
    .filter((l) => l.trim());
  insightEl.innerHTML = lines.map((line) => `<div>${line}</div>`).join("");
  drillEl.innerHTML = renderBranchDrilldownGrid(data.branches || []);
  kpiEl.innerHTML = renderBranchKpiTables(data.branches || []);
  $$("#branchDrilldownBody [data-branch-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentBranchId = btn.dataset.branchId;
      currentStoreId = null;
      managerViewLevel = "branch";
      persistManagerNavState();
      renderManagerAll();
    });
  });
}

function renderBranchDrilldownGrid(branches) {
  if (!branches.length) return "";
  return `
    <div class="section-title" style="margin-top:4px;">영업팀별 자세히 보기</div>
    <div class="grid" style="margin-bottom:24px;">
      ${branches
        .map(
          (b) => `
        <div class="card">
          <div class="label">${b.branch_name}</div>
          <div class="small-muted" style="margin-top:6px;">매장 ${b.store_count}곳 · 상담 ${b.log_count}건 · 전환율 ${b.sales.conv_rate}%</div>
          <button type="button" class="tag-btn" data-branch-id="${b.branch_id}" style="margin-top:10px;">이 영업팀 자세히 보기 →</button>
        </div>`
        )
        .join("")}
    </div>
  `;
}

function renderBranchKpiTables(branches) {
  if (!branches.length) return `<div class="small-muted">비교할 영업팀 데이터가 없습니다.</div>`;
  return `
    <div class="section-title" style="margin-top:8px;">판매 KPI <span class="badge">데이터 기반</span></div>
    <div class="small-muted" style="margin-bottom:10px;">전환율/객단가/상품 비중처럼 실제 매출 성과와 직결되는 지표입니다.</div>
    <div class="table-scroll"><table>
      <thead><tr><th>영업팀</th><th>매장 수</th><th>상담 로그 수</th><th>구매 전환율</th><th>고객 평균 누적구매액</th><th>가전(CE) 비중</th><th>모바일(MX) 비중</th></tr></thead>
      <tbody>
        ${branches
          .map(
            (b) => `<tr>
              <td>${b.branch_name}</td><td>${b.store_count}</td><td>${b.log_count}</td>
              <td>${b.sales.conv_rate}%</td><td>${b.sales.avg_customer_value.toLocaleString()}원</td>
              <td>${b.sales.ce_pct}%</td><td>${b.sales.mx_pct}%</td>
            </tr>`
          )
          .join("")}
      </tbody>
    </table></div>

    <div class="section-title" style="margin-top:26px;">판촉 KPI <span class="badge">데이터 기반</span></div>
    <div class="small-muted" style="margin-bottom:10px;">구매유형/실패사유/성공 Wow포인트/세그먼트처럼 프로모션·상담 전략에 참고할 지표입니다.</div>
    <div class="table-scroll"><table>
      <thead><tr><th>영업팀</th><th>미전환율</th><th>최다 구매유형</th><th>최다 미전환 사유</th><th>최다 Wow포인트</th><th>최다 세그먼트</th></tr></thead>
      <tbody>
        ${branches
          .map(
            (b) => `<tr>
              <td>${b.branch_name}</td><td>${b.promo.fail_rate}%</td>
              <td>${fmtTopStat(b.promo.top_occasion)}</td>
              <td>${b.promo.top_fail_reason ? b.promo.top_fail_reason.name : "-"}</td>
              <td>${b.promo.top_wow_point ? b.promo.top_wow_point.name : "-"}</td>
              <td>${fmtTopStat(b.promo.top_segment)}</td>
            </tr>`
          )
          .join("")}
      </tbody>
    </table></div>
  `;
}

// 영업팀 관리자 기본화면(+ 본사 관리자가 특정 영업팀을 골랐을 때): 그 영업팀 집계 KPI +
// 소속 매장 드릴다운 버튼. 매장 목록은 이미 받아둔 managerData.stores를 branch_id로만
// 걸러내면 되므로 별도 API 호출이 필요 없다.
// 영업팀 관리자 기본화면 - 본사 관리자 첫화면(renderCompareLevel)과 같은 순서/구성 요소
// (AI 인사이트 카드 → 판매/판촉 KPI 표, renderBranchKpiTables 공용 재사용)를 그대로 따르는
// 간략한 요약형 대시보드다. 표 하나에 우리 영업팀 1개 행만 나오는 점만 다르다 - 본사 화면과
// 형식을 통일해서 두 역할 모두 같은 방식으로 숫자를 읽을 수 있게 한다.
async function renderBranchLevel() {
  const el = $("#level-branch");
  el.innerHTML = `<div class="small-muted">불러오는 중...</div>`;
  const data = await ensureBranchInsight();
  const b = (data.branches || []).find((x) => x.branch_id === currentBranchId);
  const branchMeta = getBranch(currentBranchId);
  const stores = managerData.stores.filter((s) => s.branch_id === currentBranchId);

  const insightLines = (data.insight || "인사이트를 생성할 만큼 데이터가 아직 쌓이지 않았습니다.")
    .split("\n")
    .filter((l) => l.trim());

  el.innerHTML = `
    <div class="section-title">${branchMeta ? branchMeta.branch_name : "영업팀"} 현황</div>
    <div class="card" style="margin-bottom:16px;">
      <div class="label">AI 운영 인사이트</div>
      <div style="margin-top:6px; line-height:1.6;">${b ? insightLines.map((l) => `<div>${l}</div>`).join("") : `<span class="small-muted">${data.message || "아직 쌓인 상담 로그가 없어 인사이트를 만들 수 없습니다."}</span>`}</div>
    </div>
    ${b ? renderBranchKpiTables([b]) : ""}

    <div class="section-title" style="margin-top:8px;">소속 매장 (${stores.length}곳)</div>
    <div class="small-muted" style="margin-bottom:10px;">매장을 눌러 그 매장의 상세 분석 화면(대시보드/세그먼트/상담기록/실패분석/통계)으로 들어갈 수 있습니다.</div>
    <div class="grid">
      ${stores
        .map(
          (s) => `
        <div class="card">
          <div class="label">${s.store_name}</div>
          <div class="small-muted" style="margin-top:4px;">${s.region_sido} ${s.region_sigungu} · ${s.channel_type || "-"}</div>
          <button type="button" class="tag-btn" data-store-id="${s.store_id}" style="margin-top:10px;">매장 상세보기 →</button>
        </div>`
        )
        .join("")}
    </div>
  `;

  $$("#level-branch [data-store-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentStoreId = btn.dataset.storeId;
      managerViewLevel = "store";
      persistManagerNavState();
      renderManagerAll();
    });
  });
}

/* ---------------- 초기화 ---------------- */
async function main() {
  await loadPublicReference();

  $("#loginForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    doLogin(fd.get("user_id"), fd.get("password"));
  });

  $("#logoutBtnConsultant").addEventListener("click", () => doLogout());
  $("#logoutBtnManager").addEventListener("click", () => doLogout());

  $("#refreshBtn").addEventListener("click", async () => {
    toast("동기화 중...");
    branchInsightCache = null; // 영업팀 KPI/AI 인사이트도 최신 데이터로 다시 집계하도록 캐시 초기화
    await loadManagerData();
    renderManagerAll();
    toast("동기화 완료");
  });

  const restored = restoreSession();
  if (restored && restored.token) {
    session = restored;
    try {
      await afterLogin();
      if (session.role === "staff") flushConsultantPending();
      showScreen(session.role === "staff" ? "consultant" : "manager");
      return;
    } catch {
      /* afterLogin에서 401 시 이미 로그아웃 처리됨 */
    }
  }
  showScreen("login");

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  }
}

main();

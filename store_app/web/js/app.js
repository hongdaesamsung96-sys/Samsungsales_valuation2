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
let currentStoreId = null; // 관리자 화면의 매장 스위처 선택값

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
  } else if (session.role === "branch_manager" || session.role === "hq_manager") {
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
      const saved = localStorage.getItem("current_store_id_" + session.userId);
      currentStoreId = saved && managerData.stores.find((s) => s.store_id === saved) ? saved : managerData.stores[0]?.store_id;
      return;
    }
  } catch (e) {
    /* 폴백으로 진행 */
  }
  setManagerSyncStatus(false);
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    managerData = JSON.parse(cached);
    currentStoreId = managerData.stores[0]?.store_id;
  }
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
// 가전 판매 비중이 크므로 모바일(스마트폰/태블릿/웨어러블)과 가전(TV/냉장고/세탁기/에어컨/청소기/기타가전)을 함께 다룬다.
const PRODUCT_CATEGORY_OPTIONS = ["스마트폰", "태블릿", "웨어러블", "TV", "냉장고", "세탁기", "에어컨", "청소기", "기타가전"];
const PRODUCT_GROUP = {
  "스마트폰": "모바일", "태블릿": "모바일", "웨어러블": "모바일",
  "TV": "가전", "냉장고": "가전", "세탁기": "가전", "에어컨": "가전", "청소기": "가전", "기타가전": "가전",
};
function productGroup(cat) {
  return PRODUCT_GROUP[cat] || "기타";
}

/* ---------------- 상담 녹음 → 실시간 텍스트 변환 (브라우저 내장 음성인식, 참고용) ----------------
 * 서버로 전송/저장되지 않는다 - 화면에만 표시되는 참고용 텍스트다 (설계 배경은
 * docs/AI_상담로그_파이프라인_설계.md 참고). Web Speech API는 Chrome/Edge 위주로 지원되고,
 * 마이크 권한과 HTTPS(또는 localhost)가 필요하다.
 */
let recognition = null;
let isRecording = false;
let finalTranscript = "";

function getSpeechRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function setupRecordingUI() {
  const toggleBtn = $("#recordToggleBtn");
  const clearBtn = $("#recordClearBtn");
  if (!toggleBtn) return; // 참고자료 탭 등 폼이 없는 화면에서는 아무것도 안 함

  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) {
    toggleBtn.style.display = "none";
    if (clearBtn) clearBtn.style.display = "none";
    const warn = $("#recordUnsupported");
    if (warn) warn.style.display = "block";
    return;
  }

  toggleBtn.addEventListener("click", toggleRecording);
  if (clearBtn) clearBtn.addEventListener("click", () => clearTranscript());

  // 재렌더링 후에도 이미 녹음 중이던 상태/누적 텍스트를 화면에 이어서 반영
  updateRecordingButtonState();
  updateTranscriptDisplay(finalTranscript, "");
}

function toggleRecording() {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
}

function startRecording() {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) return;

  recognition = new Ctor();
  recognition.lang = "ko-KR";
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const piece = e.results[i][0].transcript;
      if (e.results[i].isFinal) {
        finalTranscript += piece + " ";
      } else {
        interim += piece;
      }
    }
    updateTranscriptDisplay(finalTranscript, interim);
  };

  recognition.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      toast("마이크 권한이 필요합니다");
      stopRecording();
    }
    // 'no-speech'처럼 일시적인 오류는 무시 - onend에서 녹음 중이면 자동 재시작됨
  };

  recognition.onend = () => {
    // Chrome은 일정 시간마다 세션을 끊는데, 사용자가 아직 "녹음 중지"를 안 눌렀으면 이어서 재시작
    if (isRecording) {
      try {
        recognition.start();
      } catch (e) {
        /* 이미 시작된 경우 등은 무시 */
      }
    }
  };

  try {
    recognition.start();
    isRecording = true;
    updateRecordingButtonState();
  } catch (e) {
    toast("음성인식을 시작할 수 없습니다");
  }
}

function stopRecording() {
  isRecording = false;
  if (recognition) {
    recognition.onend = null; // 자동 재시작 방지 후 종료
    try {
      recognition.stop();
    } catch (e) {
      /* noop */
    }
    recognition = null;
  }
  updateRecordingButtonState();
}

function clearTranscript() {
  finalTranscript = "";
  updateTranscriptDisplay("", "");
}

function updateRecordingButtonState() {
  const btn = $("#recordToggleBtn");
  const status = $("#recordStatus");
  if (!btn) return;
  if (isRecording) {
    btn.textContent = "⏹ 녹음 중지";
    btn.classList.add("active");
    if (status) status.textContent = "녹음 중... (실시간 변환)";
  } else {
    btn.textContent = "🎙 녹음 시작";
    btn.classList.remove("active");
    if (status) status.textContent = "대기 중";
  }
}

function updateTranscriptDisplay(final, interim) {
  const box = $("#transcriptBox");
  if (!box) return;
  const finalHtml = escapeHtml(final);
  const interimHtml = interim ? `<span class="transcript-interim">${escapeHtml(interim)}</span>` : "";
  box.innerHTML = finalHtml + interimHtml || `<span class="small-muted">녹음을 시작하면 여기에 실시간으로 텍스트가 표시됩니다.</span>`;
  box.scrollTop = box.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
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

function renderConsultantReference() {
  const segs = consultantBundle.customer_segments || [];
  const scripts = consultantBundle.talk_scripts || [];
  const cards = segs
    .map(
      (seg) => `
      <div class="card segment-card">
        <div class="label">${seg.segment_name}</div>
        <div class="sub">${seg.criteria_desc}</div>
        <div class="small-muted" style="margin-top:8px;"><b>추천 상품:</b> ${seg.target_products}</div>
        <div class="small-muted"><b>추천 타이밍:</b> ${seg.recommended_timing}</div>
        <div class="small-muted" style="margin-top:8px;"><b>추천 멘트:</b></div>
        ${scripts
          .filter((sc) => sc.target_segment === seg.segment_id)
          .map((sc) => `<div class="script-line"><span class="pill ${productGroup(sc.product_category) === "가전" ? "appliance" : "mobile"}">${sc.product_category}</span> "${sc.script_text}"</div>`)
          .join("")}
      </div>`
    )
    .join("");

  $("#cview-reference").innerHTML = `
    <div class="section-title">세일즈톡 참고자료</div>
    <div class="small-muted" style="margin-bottom:14px;">고객 유형별 추천 상품/타이밍/멘트입니다. 상담 전 참고하세요.</div>
    <div class="grid">${cards || `<div class="small-muted">참고자료가 없습니다.</div>`}</div>
  `;
}

function renderConsultantLogForm() {
  $("#cview-logform").innerHTML = `
    <div class="section-title">세일즈톡 로그 입력</div>
    <div class="small-muted" style="margin-bottom:12px;">
      개인을 특정할 수 있는 정보(이름·연락처·고객ID)는 입력하지 않습니다. 연령대/성별은 상담 중 판단한
      추정치를 버튼으로 태깅하는 통계용 항목입니다. 입력된 로그의 집계·분석은 본사/지사 관리자만 조회합니다.
    </div>

    <div class="card" id="recordingPanel" style="margin-bottom:18px;">
      <div class="label">상담 녹음 → 실시간 텍스트 변환 (참고용)</div>
      <div class="small-muted" style="margin-bottom:10px;">
        상담원 본인이 참여하는 대화를 녹음하는 것은 통신비밀보호법상 별도 동의 없이 가능하지만, 고객에게
        사전에 안내하는 걸 권장합니다. 아래 텍스트는 <b>이 화면에만 표시되고 서버로 전송·저장되지
        않습니다</b> - wow포인트/결정포인트를 놓치지 않고 적기 위한 참고용입니다. 로그를 저장하면 이
        텍스트는 자동으로 지워집니다.
      </div>
      <div style="display:flex; gap:10px; align-items:center; margin-bottom:10px; flex-wrap:wrap;">
        <button type="button" id="recordToggleBtn" class="tag-btn">🎙 녹음 시작</button>
        <button type="button" id="recordClearBtn" class="tag-btn">지우기</button>
        <span id="recordStatus" class="small-muted">대기 중</span>
      </div>
      <div id="transcriptBox" class="transcript-box"></div>
      <div id="recordUnsupported" class="small-muted" style="display:none; color:var(--warn); margin-top:8px;">
        이 브라우저는 실시간 음성인식을 지원하지 않습니다 (Chrome 브라우저 권장).
      </div>
    </div>

    <form class="log-form" id="logForm">
      <div class="full">
        <label>고객 연령대 (추정, 버튼 선택)</label>
        ${renderButtonGroup("age_group", AGE_GROUP_OPTIONS, AGE_GROUP_OPTIONS[1])}
      </div>
      <div class="full">
        <label>고객 성별 (추정, 버튼 선택)</label>
        ${renderButtonGroup("gender", GENDER_OPTIONS, GENDER_OPTIONS[2])}
      </div>
      <div class="full">
        <label>고객 거주지 (추정, 버튼 선택 - 구체 주소 아님)</label>
        ${renderButtonGroup("residence_area", RESIDENCE_OPTIONS, RESIDENCE_OPTIONS[3])}
      </div>
      <div class="full">
        <label>상담 상품유형 (버튼 선택)</label>
        ${renderButtonGroup("product_category", PRODUCT_CATEGORY_OPTIONS, PRODUCT_CATEGORY_OPTIONS[0])}
      </div>
      <div>
        <label>고객 유형(세그먼트)</label>
        <select name="segment_id" required>
          ${(consultantBundle.customer_segments || []).map((s) => `<option value="${s.segment_id}">${s.segment_name}</option>`).join("")}
        </select>
      </div>
      <div>
        <label>사용한 세일즈톡</label>
        <select name="script_id" required>
          ${(consultantBundle.talk_scripts || []).map((s) => `<option value="${s.script_id}">[${s.product_category || s.category}] ${s.script_text.slice(0, 20)}...</option>`).join("")}
        </select>
      </div>
      <div>
        <label>고객 반응</label>
        <select name="customer_reaction" required>
          <option value="긍정">긍정</option>
          <option value="중립">중립</option>
          <option value="부정">부정</option>
        </select>
      </div>
      <div>
        <label>구매 전환 여부</label>
        <select name="purchase_converted" required>
          <option value="Y">전환(Y)</option>
          <option value="N">미전환(N)</option>
        </select>
      </div>
      <div class="full">
        <label>Wow 포인트 (고객이 특히 반응한 지점)</label>
        <textarea name="wow_point" placeholder="예: 트레이드인 가격을 듣고 눈이 커짐" required></textarea>
      </div>
      <div class="full">
        <label>구매 결정 포인트</label>
        <textarea name="decision_point" placeholder="예: 월 납부금 부담 완화가 결정적" required></textarea>
      </div>
      <div class="full">
        <button type="submit">로그 저장</button>
      </div>
    </form>

    <div class="section-title" style="margin-top:26px;">이번 세션에 입력한 로그 <span class="badge">${sessionLogs.length}건</span></div>
    <div class="small-muted" style="margin-bottom:10px;">상담사는 전체 집계·통계를 조회할 권한이 없어, 본인이 방금 입력한 내역만 확인용으로 표시됩니다.</div>
    <table>
      <thead><tr><th>시각</th><th>연령대</th><th>성별</th><th>거주지</th><th>상품유형</th><th>반응</th><th>Wow포인트</th></tr></thead>
      <tbody>
        ${sessionLogs
          .slice()
          .reverse()
          .map(
            (l) => `<tr>
              <td>${l.time}</td><td>${l.age_group}</td><td>${l.gender}</td><td>${l.residence_area}</td>
              <td>${l.product_category}</td><td>${l.customer_reaction}</td><td>${l.wow_point}</td>
            </tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;

  $$("#logForm .btn-group").forEach((group) => {
    const hidden = group.querySelector('input[type="hidden"]');
    group.querySelectorAll(".tag-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        group.querySelectorAll(".tag-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        hidden.value = btn.dataset.value;
      });
    });
  });

  $("#logForm").addEventListener("submit", onSubmitConsultantLog);
  setupRecordingUI();
}

async function onSubmitConsultantLog(e) {
  e.preventDefault();
  stopRecording();
  clearTranscript();
  const fd = new FormData(e.target);
  const entry = {
    store_id: session.storeId,
    age_group: fd.get("age_group"),
    gender: fd.get("gender"),
    residence_area: fd.get("residence_area"),
    product_category: fd.get("product_category"),
    segment_id: fd.get("segment_id"),
    script_id: fd.get("script_id"),
    customer_reaction: fd.get("customer_reaction"),
    wow_point: fd.get("wow_point"),
    decision_point: fd.get("decision_point"),
    purchase_converted: fd.get("purchase_converted"),
    log_date: new Date().toISOString().slice(0, 10),
    source: "manual",
  };

  try {
    const res = await api("/api/sales_talk_log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
    if (res.ok) {
      toast("로그 저장 완료 (서버 동기화됨)");
    } else {
      queueConsultantPending(entry);
      toast("서버 저장 실패 - 재동기화 대기열에 추가됨");
    }
  } catch (err) {
    queueConsultantPending(entry);
    toast("오프라인 - 재연결 시 자동 동기화되도록 대기열에 저장됨");
  }

  sessionLogs.push({ ...entry, time: new Date().toLocaleTimeString("ko-KR") });
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

/* =========================================================================
   관리자(Manager: 지사/본사) 화면 - 데이터 분석 내역
   ========================================================================= */
function populateStoreSelect() {
  const sel = $("#storeSelect");
  sel.innerHTML = managerData.stores
    .map((s) => `<option value="${s.store_id}">${s.store_name} (${s.region_sido} ${s.region_sigungu})</option>`)
    .join("");
  sel.value = currentStoreId;
  sel.onchange = () => {
    currentStoreId = sel.value;
    localStorage.setItem("current_store_id_" + session.userId, currentStoreId);
    renderManagerAll();
  };

  const roleLabel = session.role === "hq_manager" ? "본사 관리자" : "지사 관리자";
  $("#managerRoleLabel").textContent = `${session.displayName} (${roleLabel})`;
  $("#compareTabBtn").style.display = session.role === "hq_manager" ? "" : "none";
}

function initManagerTabs() {
  $$("#managerApp nav.tabs button").forEach((btn) => {
    btn.onclick = () => {
      $$("#managerApp nav.tabs button").forEach((b) => b.classList.remove("active"));
      $$("#managerApp .view").forEach((v) => v.classList.remove("active"));
      btn.classList.add("active");
      $(`#view-${btn.dataset.tab}`).classList.add("active");
    };
  });
}

function renderManagerAll() {
  populateStoreSelect();
  initManagerTabs();
  renderDashboard();
  renderArea();
  renderSegments();
  renderLogTab();
  renderStats();
  renderCompare();
}

function renderDashboard() {
  const store = getStore(currentStoreId);
  if (!store) { $("#view-dashboard").innerHTML = `<div class="small-muted">표시할 매장이 없습니다.</div>`; return; }
  const area = getArea(currentStoreId);
  const customers = getCustomers(currentStoreId);
  const logs = getLogs(currentStoreId);
  const converted = logs.filter((l) => l.purchase_converted === "Y").length;
  const convRate = logs.length ? Math.round((converted / logs.length) * 100) : 0;

  $("#view-dashboard").innerHTML = `
    <div class="section-title">${store.store_name}</div>
    <div class="small-muted" style="margin-bottom:14px;">${store.address} · 오픈 ${store.open_date}</div>
    <div class="grid">
      <div class="card"><div class="label">등록 고객 수</div><div class="value">${customers.length}</div></div>
      <div class="card"><div class="label">누적 상담 로그</div><div class="value">${logs.length}</div></div>
      <div class="card"><div class="label">구매 전환율</div><div class="value">${convRate}%</div><div class="sub">${converted} / ${logs.length}건 전환</div></div>
      <div class="card"><div class="label">유동인구 지수</div><div class="value">${area.foot_traffic_index}</div><div class="sub">0~100 상대지수</div></div>
    </div>
    <div class="section-title">약정 만료 임박 고객 (60일 이내)</div>
    ${renderUpcomingContracts(customers)}
  `;
}

function renderUpcomingContracts(customers) {
  const today = new Date();
  const soon = customers
    .map((c) => ({ ...c, days: Math.round((new Date(c.contract_end_date) - today) / 86400000) }))
    .filter((c) => c.days >= 0 && c.days <= 60)
    .sort((a, b) => a.days - b.days);
  if (!soon.length) return `<div class="small-muted">해당 고객 없음</div>`;
  return `<table><thead><tr><th>고객ID</th><th>연령대</th><th>통신사</th><th>등급</th><th>만료까지(일)</th></tr></thead><tbody>
    ${soon
      .slice(0, 10)
      .map((c) => `<tr><td>${c.customer_id}</td><td>${c.age_group}</td><td>${c.carrier}</td><td>${c.membership_tier}</td><td>${c.days}</td></tr>`)
      .join("")}
  </tbody></table>`;
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

function renderArea() {
  const store = getStore(currentStoreId);
  const area = getArea(currentStoreId);
  if (!store || !area) { $("#view-area").innerHTML = `<div class="small-muted">표시할 데이터가 없습니다.</div>`; return; }
  const logs = getLogs(currentStoreId);

  $("#view-area").innerHTML = `
    <div class="section-title">상권 분석 - ${store.store_name}</div>
    <div class="small-muted" style="margin-bottom:10px;">아래 물리적 상권 정보(경쟁매장/교통/유동인구)는 외부 조사 기반이고,
    고객유형 통계는 매장에 미리 붙여둔 라벨이 아니라 실제 쌓인 상담 로그를 집계한 결과입니다.</div>
    <div class="grid">
      <div class="card"><div class="label">반경 내 경쟁 매장</div><div class="value">${area.competitor_count}개</div></div>
      <div class="card"><div class="label">최인접 지하철</div><div class="value" style="font-size:18px;">${area.nearby_subway}</div><div class="sub">${area.subway_distance_m}m</div></div>
      <div class="card"><div class="label">인근 오피스 밀집도</div><div class="value">${area.nearby_office_count}</div><div class="sub">개소 추정</div></div>
      <div class="card"><div class="label">인근 아파트 세대수</div><div class="value">${area.nearby_apt_units.toLocaleString()}</div><div class="sub">세대 추정</div></div>
      <div class="card"><div class="label">유동인구 지수</div><div class="value">${area.foot_traffic_index}</div>
        <div class="stat-bar"><div style="width:${area.foot_traffic_index}%"></div></div>
      </div>
    </div>
    <div class="small-muted">${area.notes}</div>
    <div class="small-muted" style="margin-top:6px;">분석 기준일: ${area.analysis_date}</div>

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
}

function renderSegments() {
  const customers = getCustomers(currentStoreId);
  const segCounts = {};
  customers.forEach((c) => (segCounts[c.segment_id] = (segCounts[c.segment_id] || 0) + 1));

  const cards = managerData.customer_segments
    .map((seg) => {
      const count = segCounts[seg.segment_id] || 0;
      const pct = customers.length ? Math.round((count / customers.length) * 100) : 0;
      return `
      <div class="card segment-card">
        <div class="label">${seg.segment_name}</div>
        <div class="value">${count}명 <span class="small-muted" style="font-size:13px;font-weight:400;">(${pct}%)</span></div>
        <div class="sub">${seg.criteria_desc}</div>
        <div class="stat-bar"><div style="width:${pct}%"></div></div>
        <div class="small-muted" style="margin-top:8px;"><b>추천 상품:</b> ${seg.target_products}</div>
        <div class="small-muted"><b>추천 타이밍:</b> ${seg.recommended_timing}</div>
      </div>`;
    })
    .join("");

  $("#view-segments").innerHTML = `
    <div class="section-title">고객 세그먼트 분포 (본 매장)</div>
    <div class="grid">${cards}</div>
  `;
}

function reactionPill(r) {
  const cls = r === "긍정" ? "pos" : r === "부정" ? "neg" : "neu";
  return `<span class="pill ${cls}">${r}</span>`;
}
function sourcePill(s) {
  return s === "ai_transcribed" ? `<span class="pill ai">AI 분석</span>` : `<span class="pill manual">수동입력</span>`;
}

function renderLogTab() {
  const logs = getLogs(currentStoreId).slice().reverse();
  $("#view-log").innerHTML = `
    <div class="section-title">세일즈톡 로그 열람 <span class="badge">${logs.length}건</span></div>
    <div class="small-muted" style="margin-bottom:12px;">로그 입력은 매장 상담사용 화면에서 이뤄지며, 이 화면은 조회 전용입니다.</div>
    <table>
      <thead><tr><th>일자</th><th>연령대</th><th>성별</th><th>거주지</th><th>상품유형</th><th>세그먼트</th><th>반응</th><th>Wow포인트</th><th>결정포인트</th><th>전환</th><th>출처</th></tr></thead>
      <tbody>
        ${logs
          .map(
            (l) => `<tr>
              <td>${l.log_date}</td>
              <td>${l.age_group || "-"}</td>
              <td>${l.gender || "-"}</td>
              <td>${l.residence_area || "-"}</td>
              <td>${l.product_category ? `<span class="pill ${productGroup(l.product_category) === "가전" ? "appliance" : "mobile"}">${l.product_category}</span>` : "-"}</td>
              <td>${getSegment(l.segment_id)?.segment_name || "-"}</td>
              <td>${reactionPill(l.customer_reaction)}</td>
              <td>${l.wow_point}</td>
              <td>${l.decision_point}</td>
              <td>${l.purchase_converted === "Y" ? "✅" : "—"}</td>
              <td>${sourcePill(l.source)}</td>
            </tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;
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
    <table>
      <thead><tr><th>세그먼트</th><th>상담건수</th><th>전환건수</th><th>전환율</th></tr></thead>
      <tbody>
        ${Object.entries(bySegment)
          .map(([seg, v]) => {
            const rate = v.total ? Math.round((v.converted / v.total) * 100) : 0;
            return `<tr><td>${seg}</td><td>${v.total}</td><td>${v.converted}</td><td>${rate}%</td></tr>`;
          })
          .join("")}
      </tbody>
    </table>

    <div class="section-title" style="margin-top:26px;">모바일 vs 가전 전환율</div>
    <table>
      <thead><tr><th>구분</th><th>상담건수</th><th>전환건수</th><th>전환율</th></tr></thead>
      <tbody>
        ${Object.entries(byGroup)
          .map(([grp, v]) => {
            const rate = v.total ? Math.round((v.converted / v.total) * 100) : 0;
            return `<tr><td>${grp}</td><td>${v.total}</td><td>${v.converted}</td><td>${rate}%</td></tr>`;
          })
          .join("")}
      </tbody>
    </table>

    <div class="section-title">상품유형별 전환율</div>
    <table>
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
    </table>

    <div class="section-title">자주 나온 Wow 포인트 Top 5</div>
    <table>
      <thead><tr><th>Wow 포인트</th><th>빈도</th></tr></thead>
      <tbody>
        ${topWow.map(([w, n]) => `<tr><td>${w}</td><td>${n}</td></tr>`).join("")}
      </tbody>
    </table>
  `;
}

/* 본사 관리자 전용: 지사별 비교 (상권별 고객유형 차이 파악용) */
function renderCompare() {
  if (session.role !== "hq_manager") { $("#view-compare").innerHTML = ""; return; }
  const rows = managerData.branches.map((br) => {
    const branchStores = managerData.stores.filter((s) => s.branch_id === br.branch_id).map((s) => s.store_id);
    const branchLogs = managerData.sales_talk_log.filter((l) => branchStores.includes(l.store_id));
    const converted = branchLogs.filter((l) => l.purchase_converted === "Y").length;
    const rate = branchLogs.length ? Math.round((converted / branchLogs.length) * 100) : 0;
    const topOf = (field) => {
      const freq = {};
      branchLogs.forEach((l) => (freq[l[field]] = (freq[l[field]] || 0) + 1));
      const top = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
      return top ? top[0] : "-";
    };
    const applianceCount = branchLogs.filter((l) => productGroup(l.product_category) === "가전").length;
    const appliancePct = branchLogs.length ? Math.round((applianceCount / branchLogs.length) * 100) : 0;
    return {
      branch: br.branch_name, stores: branchStores.length, logs: branchLogs.length, rate,
      topAge: topOf("age_group"), topGender: topOf("gender"), topResidence: topOf("residence_area"),
      topProduct: topOf("product_category"), appliancePct,
    };
  });

  $("#view-compare").innerHTML = `
    <div class="section-title">지사별 비교 (전사 관점)</div>
    <div class="small-muted" style="margin-bottom:12px;">지사별로 실제 방문 고객 통계(상담로그 집계)가 어떻게 다른지 비교합니다. 본사 관리자만 조회 가능합니다.</div>
    <table>
      <thead><tr><th>지사</th><th>매장 수</th><th>상담 로그 수</th><th>구매 전환율</th><th>최다 연령대</th><th>최다 성별</th><th>최다 거주유형</th><th>최다 상품유형</th><th>가전 비중</th></tr></thead>
      <tbody>
        ${rows.map((r) => `<tr><td>${r.branch}</td><td>${r.stores}</td><td>${r.logs}</td><td>${r.rate}%</td><td>${r.topAge}</td><td>${r.topGender}</td><td>${r.topResidence}</td><td>${r.topProduct}</td><td>${r.appliancePct}%</td></tr>`).join("")}
      </tbody>
    </table>
  `;
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

// SPEC-usage-analytics.md §4/§UAS/§UASC（v0.6）— 用量統計頁。
// 圖表都是手刻 SVG 字串拼接（沿用本專案一貫做法：innerHTML 拼字串，不引入任何圖表套件）：
//   G1 Pareto 排行榜（按對話／按技能切換，v0.6 移除「按排程」＝D15）＋輔助指標卡
//   G2 每日趨勢堆疊圖（按 trigger 堆疊）＋每日累加曲線（v0.6.1 D25：原獨立的「對話累積用量
//      曲線」橫軸是第幾輪、看不出趨勢，已整張移除並把累加概念併進 G2）
//   G2b 每週限額使用狀況（v0.7 D29）：ISO 週彙總 token、推估佔週限額 %（靠官方 7 天窗口校準）
//   G4 使用量趨勢（X-Bar/R，固定組距，v0.6 取代原 X/MR＝D17）；v0.7 D30 移除歷史百分位線
//   G5 X-Bar/R 管制圖（分組＝同一天的同一個對話，D11/D18）；v0.7 D27 界限改固定水平線
// v0.6（D16）已整張移除 G3 分佈箱型圖。
//
// 資料來源：G1／輔助指標卡吃 /api/usage/summary（不受 2000 筆上限，數字精確）；
// G2 吃 /api/usage/events（上限 2000 筆，truncated:true 時在畫面上誠實標出，
// 不默默吃掉超過的部分）；G4 吃 /api/usage/trend；G5 吃 /api/usage/xbar-r。
//
// 下面的「純計算」函式（paretoWithCumulative）刻意保持跟
// .worktable/artifacts/uas/mirror_test.js 裡複製的版本逐字一致，方便日後對照。

export const meta = { route: '/app/usage', title: '用量統計', icon: 'bar-chart-3', menuGroup: 'usage' };

let container = null;
// ── 日期區間（v0.7 D31）────────────────────────────────────────────────
// 全頁共用「一組」起迄日期（本地日曆日，YYYY-MM-DD），所有圖表、指標卡都用同一組算，
// 不再各自用 rangeDays。預設＝含今天往前推一週（10/8 打開＝10/02~10/08，共 7 天）。
// 本地日期一律用 getFullYear/getMonth/getDate 組字串，不可用 toISOString().slice(0,10)
// ——在 UTC+8 本地午夜換算成 UTC 會退成前一天（既有踩雷紀錄）。
function localDayStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function todayStr() { return localDayStr(new Date()); }
function shiftDayStr(dayStr, deltaDays) {
  const [y, m, d] = String(dayStr).split('-').map(Number);
  return localDayStr(new Date(y, m - 1, d + deltaDays));
}
function defaultRange() {
  const to = todayStr();
  return { from: shiftDayStr(to, -6), to };   // 含兩端共 7 天
}
const DEFAULT_RANGE = defaultRange();

let usageState = {
  fromDate: DEFAULT_RANGE.from,   // 本地日曆日 YYYY-MM-DD（含當天）
  toDate: DEFAULT_RANGE.to,       // 本地日曆日 YYYY-MM-DD（含當天）
  paretoGroupBy: 'session', // 'session' | 'skill' — UASF-1(D13)：預設按對話；UASC-3(D15)：移除「按排程」
  trendSettings: null,      // G4 設定統計指標（組大小／管制界限視窗），UASC-1(D19/D20)
  // D23：G4／G5 圖高切換（緊湊／標準／放大）；記在 localStorage，換頁、重開都保留使用者的選擇。
  chartSize: (typeof localStorage !== 'undefined' && localStorage.getItem('usage.chartSize')) || 'normal',
  // UASZ-4（D34）：範圍切換「本專案／全部專案」。只放前端記憶體，不寫 localStorage、不寫 settings.json
  // ——重新整理一律回到預設「本專案」。
  scope: 'current',         // 'current' | 'all'
  _projectNames: [],        // UASZ-5（D35/D36）：scope='all' 時，從本次查到的事件收斂出的專案清單（固定排序，供上色）
};
let usageData = { summarySkill: null, summarySchedule: null, summarySession: null, summaryTrigger: null, summaryAll: null, events: null, xbarR: null, trend: null, quota: null };

// 區間共幾天（含兩端）——G2 每日趨勢的柱子數、週彙總的日期清單都靠它。
function rangeDayList() {
  const out = [];
  let cur = usageState.fromDate;
  for (let guard = 0; guard < 1000 && cur <= usageState.toDate; guard++) {
    out.push(cur);
    cur = shiftDayStr(cur, 1);
  }
  return out;
}

// ── UASF-2（D14）名稱解析層：共用給所有圖，取不到名稱一律顯示「未命名…」＋短代號，不印裸 ID ──
let _scheduleNameMap = new Map();   // scheduleId -> 排程名稱
let _chatTitleMap = new Map();      // sessionId -> 對話標題
function shortCode(id) { return String(id || '').slice(-6) || '??????'; }
async function loadNameMaps() {
  const [schedules, chatHistories] = await Promise.all([
    fetchJson('/api/schedules'),
    fetchJson('/api/chat/history'),
  ]);
  _scheduleNameMap = new Map();
  (Array.isArray(schedules) ? schedules : []).forEach((s) => { if (s && s.id) _scheduleNameMap.set(s.id, s.name || null); });
  _chatTitleMap = new Map();
  (Array.isArray(chatHistories) ? chatHistories : []).forEach((h) => { if (h && h.sessionId) _chatTitleMap.set(h.sessionId, h.title || null); });
}
function resolveScheduleName(scheduleId) {
  if (!scheduleId) return '（無排程）';
  const n = _scheduleNameMap.get(scheduleId);
  return n || ('未命名排程（' + shortCode(scheduleId) + '）');
}
function resolveSessionTitle(sessionId, firstAt) {
  if (!sessionId) return '（無對話）';
  const t = _chatTitleMap.get(sessionId);
  if (t) return t;
  const day = firstAt ? String(firstAt).slice(0, 10) : '';
  return '未命名對話（' + (day ? day + '・' : '') + shortCode(sessionId) + '）';
}
function resolveSkillName(skill) { return skill ? ('/' + skill) : '(無技能)'; }

function escapeHtml(s) { return window.escapeHtml ? window.escapeHtml(s) : String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function fmtNum(n) { if (n == null || !Number.isFinite(n)) return '—'; return n.toLocaleString('zh-TW'); }
function fmtPct(n) { if (n == null || !Number.isFinite(n)) return '—'; return (n * 100).toFixed(1) + '%'; }
function truncateLabel(s, max) {
  max = max || 10;
  s = String(s || '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ── UASZ-5（D35/D36）跨專案配色：固定色票依「本次收斂出的專案清單」排序取模指派 ──
// 排序用專案名稱字典序（非後端的路徑排序），但同一組專案名在同一次載入內永遠對到同一個顏色，
// 顏色數不足時循環（圖形上另外用點形狀區分，見 xbarRSvg／trendSvg 的 dot 形狀邏輯）。
const PROJECT_PALETTE = ['#0891b2', '#f59e0b', '#8b5cf6', '#16a34a', '#dc2626', '#2563eb', '#db2777', '#65a30d'];
function projectColor(name) {
  if (!name) return '#64748b';
  const list = usageState._projectNames || [];
  const idx = list.indexOf(name);
  if (idx === -1) return '#64748b';
  return PROJECT_PALETTE[idx % PROJECT_PALETTE.length];
}
// 從合併後的事件（scope='all' 時每筆帶 project）收斂出固定排序的專案清單。
function collectProjectNames(events) {
  const names = new Set();
  (events || []).forEach((e) => { if (e && e.project) names.add(e.project); });
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

// ── 純計算：與鏡射測試逐字一致，勿各自微調 ──────────────────────────────
function paretoWithCumulative(rows) {
  const sorted = rows.slice().sort((a, b) => b.tokenTotal - a.tokenTotal);
  const total = sorted.reduce((s, r) => s + r.tokenTotal, 0) || 1;
  let cum = 0;
  return sorted.map((r) => { cum += r.tokenTotal; return Object.assign({}, r, { cumPct: (cum / total) * 100 }); });
}
// ── 純計算結束 ───────────────────────────────────────────────────────

async function fetchJson(url) {
  try { const r = await fetch(url); return await r.json(); } catch (e) { return null; }
}

// 把共用的本地起迄日轉成後端比對用的 UTC ISO 瞬間：from＝起日本地 00:00、to＝迄日本地 23:59:59.999。
// （這裡用 new Date(y, m-1, d) 是刻意的：要的正是「本地午夜對應的 UTC 瞬間」，與日期字串無關。）
function dateRangeISO() {
  const [fy, fm, fd] = usageState.fromDate.split('-').map(Number);
  const [ty, tm, td] = usageState.toDate.split('-').map(Number);
  const from = new Date(fy, fm - 1, fd, 0, 0, 0, 0);
  const to = new Date(ty, tm - 1, td, 23, 59, 59, 999);
  return { from: from.toISOString(), to: to.toISOString() };
}
// 事件時間（UTC ISO）→ 本地日曆日字串。G2 與週彙總都以「指揮官看到的那一天」為單位，
// 不能直接 slice(0,10)（那是 UTC 日界線，台灣時間 08:00 前的事件會被算到前一天）。
function eventLocalDay(iso) {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? '' : localDayStr(t);
}

async function loadAll() {
  const { from, to } = dateRangeISO();
  // UASZ-4（D34）：scope 跟著共用區間一起帶給所有查詢端點；settings 端點不接受 scope（維持只讀寫當前工作區）。
  const qs = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&scope=${usageState.scope}`;
  const [summarySkill, summarySchedule, summarySession, summaryTrigger, summaryAll, events, xbarR] = await Promise.all([
    fetchJson(`/api/usage/summary?${qs}&groupBy=skill`),
    fetchJson(`/api/usage/summary?${qs}&groupBy=schedule`),
    fetchJson(`/api/usage/summary?${qs}&groupBy=session`),   // UASF-1(D13)
    fetchJson(`/api/usage/summary?${qs}&groupBy=trigger`),   // UASF-3(D12)：G4 下拉的「僅對話／僅排程」樣本數
    fetchJson(`/api/usage/summary?${qs}`),
    fetchJson(`/api/usage/events?${qs}`),
    fetchJson(`/api/usage/xbar-r?${qs}`),                    // UASF-4(D11)
    loadNameMaps(),                                          // UASF-2(D14)：排程名稱／對話標題，供所有圖表共用
  ]);
  // D29：週限額要用官方「7 天窗口使用率」當校準基準。走既有 /api/model-quota（讀 metadata 端點、
  // 不經過模型、不花額度），並刻意帶 maxAgeSec 吃 server 端既有快取，不為了畫圖多打一次上游。
  const quota = await fetchJson('/api/model-quota?maxAgeSec=300');
  usageData = { summarySkill, summarySchedule, summarySession, summaryTrigger, summaryAll, events, xbarR, quota };
  // UASZ-5：scope='all' 時才會有 project 欄位，收斂一份固定排序的專案清單供 G1/G2/G4/G5 上色一致。
  usageState._projectNames = usageState.scope === 'all' ? collectProjectNames(events && events.events) : [];
  renderAll();
}

function render() {
  container.innerHTML = `
  <section class="flex-1 overflow-y-auto h-full bg-slate-50/50 dark:bg-slate-900/40 p-6 space-y-6">
    <div class="flex items-center justify-between flex-wrap gap-2">
      <h2 class="text-base font-bold text-slate-900 dark:text-white">用量統計</h2>
      <div class="flex items-center gap-2 flex-wrap">
        <div class="flex items-center rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5 text-xs font-medium">
          <button data-scope="current" class="usage-scope-btn px-2.5 py-1 rounded-md transition-all">本專案</button>
          <button data-scope="all" class="usage-scope-btn px-2.5 py-1 rounded-md transition-all">全部專案</button>
        </div>
        <div class="flex items-center rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5 text-xs font-medium">
          ${[7, 14, 30, 90].map((d) => `<button data-range="${d}" class="usage-range-btn px-2.5 py-1 rounded-md transition-all">近 ${d} 天</button>`).join('')}
        </div>
        <div class="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
          <input id="usage-from" type="date" value="${usageState.fromDate}" max="${todayStr()}" class="text-xs px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200"/>
          <span>~</span>
          <input id="usage-to" type="date" value="${usageState.toDate}" max="${todayStr()}" class="text-xs px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200"/>
          <button id="usage-apply-range" class="text-xs px-2.5 py-1 rounded-md bg-cyan-600 text-white hover:bg-cyan-700">套用</button>
        </div>
        <label class="flex items-center gap-1 text-xs text-slate-400 dark:text-slate-500">圖高
          <select id="usage-chart-size" class="text-xs px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300">
            ${Object.keys(CHART_SIZES).map((k) => `<option value="${k}" ${k === usageState.chartSize ? 'selected' : ''}>${CHART_SIZES[k].label}</option>`).join('')}
          </select>
        </label>
      </div>
    </div>
    <div id="usage-range-hint" class="text-[11px] text-slate-400 dark:text-slate-500"></div>
    <div id="usage-range-error" class="hidden text-xs px-3 py-2 rounded-lg bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"></div>
    <div id="usage-truncated-notice" class="hidden text-xs px-3 py-2 rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"></div>

    <div id="usage-cards" class="grid grid-cols-2 md:grid-cols-4 gap-3"></div>

    <div class="rounded-xl border border-slate-200 dark:border-slate-700/60 bg-white dark:bg-slate-800/40 p-4">
      <div class="flex items-center justify-between mb-2 flex-wrap gap-2">
        <h3 class="text-sm font-bold text-slate-700 dark:text-slate-200">G1・Pareto 排行榜 — 誰吃掉我的額度</h3>
        <div class="flex items-center rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5 text-xs font-medium">
          <button data-pareto-group="session" class="usage-pareto-btn px-2.5 py-1 rounded-md transition-all">按對話</button>
          <button data-pareto-group="skill" class="usage-pareto-btn px-2.5 py-1 rounded-md transition-all">按技能</button>
        </div>
      </div>
      <div id="usage-g1"></div>
    </div>

    <div class="rounded-xl border border-slate-200 dark:border-slate-700/60 bg-white dark:bg-slate-800/40 p-4">
      <h3 class="text-sm font-bold text-slate-700 dark:text-slate-200">G2・每日趨勢（按來源堆疊）＋累積曲線 — 額度是怎麼一天一天花掉的</h3>
      <p class="text-[11px] text-slate-400 dark:text-slate-500 mb-2">柱子＝當天各來源用量；紅線＝從區間第一天累加到當天的佔比（D25：原本獨立的「對話累積用量曲線」橫軸是第幾輪、看不出時間趨勢，已併入這張）。</p>
      <div id="usage-g2"></div>
      <div class="mt-4 pt-3 border-t border-slate-100 dark:border-slate-700/60">
        <h4 class="text-xs font-bold text-slate-600 dark:text-slate-300 mb-1">每週限額使用狀況</h4>
        <div id="usage-g2-weekly"></div>
      </div>
    </div>

    <div class="rounded-xl border border-slate-200 dark:border-slate-700/60 bg-white dark:bg-slate-800/40 p-4">
      <div class="flex items-center justify-between mb-1 flex-wrap gap-2">
        <h3 class="text-sm font-bold text-slate-700 dark:text-slate-200">G4・使用量趨勢（X-Bar/R，固定組距） — 我是怎麼用到超出管制界限的</h3>
        <button id="usage-g4-settings-btn" class="flex items-center gap-1 text-xs px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700/60">
          <i data-lucide="settings" class="h-3.5 w-3.5"></i>設定統計指標
        </button>
      </div>
      <p class="text-[11px] text-slate-400 dark:text-slate-500 mb-2">一個點＝把所有執行紀錄依時間先後、每固定幾筆打包成的一組；上圖看「這組平均多貴」，下圖看「這組內部落差多大」。紅點＝出界，代表那段時間用量明顯脫離平常水準。</p>
      <div id="usage-g4"></div>
    </div>

    <div id="usage-settings-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div class="w-80 rounded-xl bg-white dark:bg-slate-800 p-5 space-y-3 shadow-xl">
        <h4 class="text-sm font-bold text-slate-900 dark:text-white">設定統計指標</h4>
        <label class="block text-xs text-slate-500 dark:text-slate-400">組大小（每幾筆事件打包成一組，2~50）
          <input id="usage-set-groupSize" type="number" min="2" max="50" class="mt-1 w-full text-sm px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100"/>
        </label>
        <label class="block text-xs text-slate-500 dark:text-slate-400">管制界限視窗（取最近幾組算管制線，≥8）
          <input id="usage-set-controlWindow" type="number" min="8" class="mt-1 w-full text-sm px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100"/>
        </label>
        <div id="usage-settings-error" class="hidden text-xs text-red-500"></div>
        <div class="flex items-center justify-end gap-2 pt-1">
          <button id="usage-settings-cancel" class="text-xs px-3 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300">取消</button>
          <button id="usage-settings-save" class="text-xs px-3 py-1.5 rounded-md bg-cyan-600 text-white hover:bg-cyan-700">儲存並重算</button>
        </div>
      </div>
    </div>

    <div class="rounded-xl border border-slate-200 dark:border-slate-700/60 bg-white dark:bg-slate-800/40 p-4">
      <h3 class="text-sm font-bold text-slate-700 dark:text-slate-200 mb-1">G5・X-Bar/R 管制圖 — 這個對話該不該關掉</h3>
      <p class="text-[11px] text-slate-400 dark:text-slate-500">一個點＝「某一天的某一個對話」。上圖 X̄＝那個對話當天平均每輪燒多少 token；下圖 R＝最貴的一輪減最便宜的一輪，也就是這個對話從頭漲到尾的落差。點變紅＝那個對話明顯比其他對話貴、或漲得特別兇，通常就是該關掉重開的那一個（滑鼠移過去可看它是哪個對話）。</p>
      <p class="text-[11px] text-amber-600 dark:text-amber-400 mb-2">⚠ 此處 R 代表「對話從頭漲到尾的落差」，非教科書隨機變異；各組對話輪數其實不等，管制界限以平均輪數算成固定水平線（D27 刻意簡化，不是標準品管警報）。</p>
      <div id="usage-g5"></div>
    </div>
  </section>`;

  container.querySelectorAll('.usage-scope-btn').forEach((b) => b.addEventListener('click', () => {
    const scope = b.getAttribute('data-scope');
    if (scope === usageState.scope) return;
    usageState.scope = scope;
    updateScopeButtons();
    loadAll();
  }));
  container.querySelectorAll('.usage-range-btn').forEach((b) => b.addEventListener('click', () => {
    const d = parseInt(b.getAttribute('data-range'), 10);
    usageState.toDate = todayStr();
    usageState.fromDate = shiftDayStr(usageState.toDate, -(d - 1));   // 含今天共 d 天
    syncRangeInputs();
    updateRangeButtons();
    showRangeError(null);
    loadAll();
  }));
  container.querySelector('#usage-apply-range').addEventListener('click', applyCustomRange);
  ['#usage-from', '#usage-to'].forEach((sel) => {
    const el = container.querySelector(sel);
    if (el) el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') applyCustomRange(); });
  });
  container.querySelectorAll('.usage-pareto-btn').forEach((b) => b.addEventListener('click', () => {
    usageState.paretoGroupBy = b.getAttribute('data-pareto-group');
    updateParetoButtons();
    renderG1();
  }));
  const sizeSel = container.querySelector('#usage-chart-size');
  if (sizeSel) sizeSel.addEventListener('change', () => {
    usageState.chartSize = sizeSel.value;
    try { localStorage.setItem('usage.chartSize', usageState.chartSize); } catch (e) { /* 無痕模式寫不了，不影響本次使用 */ }
    // 只重畫、不重新打 API（G4 的 trend 已快取在 usageData.trend）。
    renderG2();
    renderG4({ reuse: true });
    renderG5();
  });
  container.querySelector('#usage-g4-settings-btn').addEventListener('click', openSettingsModal);
  container.querySelector('#usage-settings-cancel').addEventListener('click', closeSettingsModal);
  container.querySelector('#usage-settings-save').addEventListener('click', saveSettingsAndRecalc);
  updateRangeButtons();
  updateParetoButtons();
  updateScopeButtons();
}
function updateScopeButtons() {
  container.querySelectorAll('.usage-scope-btn').forEach((b) => {
    const active = b.getAttribute('data-scope') === usageState.scope;
    b.classList.toggle('bg-white', active); b.classList.toggle('dark:bg-slate-700', active);
    b.classList.toggle('shadow-sm', active); b.classList.toggle('text-slate-900', active); b.classList.toggle('dark:text-white', active);
    b.classList.toggle('text-slate-500', !active); b.classList.toggle('dark:text-slate-400', !active);
  });
}

// ── 設定統計指標彈窗（D19/D20）──────────────────────────────────────
function openSettingsModal() {
  const s = usageState.trendSettings || {};
  container.querySelector('#usage-set-groupSize').value = s.groupSize != null ? s.groupSize : '';
  container.querySelector('#usage-set-controlWindow').value = s.controlWindow != null ? s.controlWindow : '';
  const err = container.querySelector('#usage-settings-error');
  err.classList.add('hidden'); err.textContent = '';
  container.querySelector('#usage-settings-modal').classList.remove('hidden');
}
function closeSettingsModal() {
  container.querySelector('#usage-settings-modal').classList.add('hidden');
}
async function saveSettingsAndRecalc() {
  const groupSize = parseInt(container.querySelector('#usage-set-groupSize').value, 10);
  const controlWindow = parseInt(container.querySelector('#usage-set-controlWindow').value, 10);
  // D30：歷史百分位線已移除，彈窗不再顯示這個欄位；但後端設定檔仍保留欄位（PUT 會驗證），
  // 所以沿用目前存著的值原樣送回，不改動它、也不讓驗證失敗。
  const s0 = usageState.trendSettings || {};
  const percentileWindow = s0.percentileWindow != null ? s0.percentileWindow : 100;
  const err = container.querySelector('#usage-settings-error');
  try {
    const r = await fetch('/api/usage/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupSize, controlWindow, percentileWindow }),
    });
    const data = await r.json();
    if (!r.ok) {
      err.textContent = data.error || '儲存失敗';
      err.classList.remove('hidden');
      return;
    }
    usageState.trendSettings = data;
    usageData.trend = null;   // 設定改了，舊的分組結果整份作廢，必須重算
    closeSettingsModal();
    await renderG4();
    renderG5();               // G5 的註腳會引用組大小，一起更新
  } catch (e) {
    err.textContent = '儲存失敗：' + e.message;
    err.classList.remove('hidden');
  }
}

// 自訂起迄（D31）：錯的輸入不送查詢，直接在畫面上講清楚哪裡錯，不靜默修正成別的區間。
function applyCustomRange() {
  const f = String(container.querySelector('#usage-from').value || '').trim();
  const t = String(container.querySelector('#usage-to').value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || !/^\d{4}-\d{2}-\d{2}$/.test(t)) { showRangeError('起迄日期都要填（格式 YYYY-MM-DD）。'); return; }
  if (f > t) { showRangeError('開始日期不能晚於結束日期。'); return; }
  if (t > todayStr()) { showRangeError('結束日期不能超過今天（未來沒有用量資料）。'); return; }
  usageState.fromDate = f;
  usageState.toDate = t;
  showRangeError(null);
  updateRangeButtons();
  loadAll();
}
function showRangeError(msg) {
  const el = container.querySelector('#usage-range-error');
  if (!el) return;
  if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.textContent = '⚠ ' + msg;
  el.classList.remove('hidden');
}
function syncRangeInputs() {
  const f = container.querySelector('#usage-from'); if (f) f.value = usageState.fromDate;
  const t = container.querySelector('#usage-to'); if (t) t.value = usageState.toDate;
}
function renderRangeHint() {
  const el = container.querySelector('#usage-range-hint');
  if (!el) return;
  const n = rangeDayList().length;
  const scopeNote = usageState.scope === 'all' ? `目前涵蓋 ${usageState._projectNames.length} 個專案。` : '';
  el.textContent = `目前統計區間：${usageState.fromDate} ~ ${usageState.toDate}（共 ${n} 天）。本頁所有圖表、指標卡都用這一組區間計算。${scopeNote}`;
}
// 快捷按鈕只在「迄日＝今天、天數剛好吻合」時才算選中；自訂區間則三顆都不亮。
function currentPresetDays() {
  if (usageState.toDate !== todayStr()) return null;
  return rangeDayList().length;
}
function updateRangeButtons() {
  const preset = currentPresetDays();
  container.querySelectorAll('.usage-range-btn').forEach((b) => {
    const active = parseInt(b.getAttribute('data-range'), 10) === preset;
    b.classList.toggle('bg-white', active); b.classList.toggle('dark:bg-slate-700', active);
    b.classList.toggle('shadow-sm', active); b.classList.toggle('text-slate-900', active); b.classList.toggle('dark:text-white', active);
    b.classList.toggle('text-slate-500', !active); b.classList.toggle('dark:text-slate-400', !active);
  });
}
function updateParetoButtons() {
  container.querySelectorAll('.usage-pareto-btn').forEach((b) => {
    const active = b.getAttribute('data-pareto-group') === usageState.paretoGroupBy;
    b.classList.toggle('bg-white', active); b.classList.toggle('dark:bg-slate-700', active);
    b.classList.toggle('shadow-sm', active); b.classList.toggle('text-slate-900', active); b.classList.toggle('dark:text-white', active);
    b.classList.toggle('text-slate-500', !active); b.classList.toggle('dark:text-slate-400', !active);
  });
}

function renderAll() {
  renderRangeHint();
  renderTruncatedNotice();
  renderCards();
  renderG1();
  renderG2();
  renderWeekly();
  renderG4();
  renderG5();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function renderTruncatedNotice() {
  const el = container.querySelector('#usage-truncated-notice');
  if (!el) return;
  const ev = usageData.events;
  if (ev && ev.truncated) {
    el.textContent = `⚠ 事件數（${fmtNum(ev.total)} 筆）超過單次查詢上限（2000 筆），G2 每日趨勢只畫出最新 2000 筆，不代表全貌。G1 排行榜與下方指標卡不受此限制、數字是精確的。`;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

function renderCards() {
  const box = container.querySelector('#usage-cards');
  const all = usageData.summaryAll;
  const row = all && all.rows && all.rows[0];
  const total = all ? all.totalEvents : 0;
  const noData = all ? all.noDataCount : 0;
  const coverage = total ? (1 - noData / total) : null;
  const cacheHit = row ? row.cacheHitRate : null;
  const avgTokens = row ? row.avgTokens : null;
  const cards = [
    { label: '執行次數（本期）', value: fmtNum(total), icon: 'activity' },
    { label: '快取命中率', value: fmtPct(cacheHit), icon: 'zap' },
    { label: '平均單次用量（token）', value: fmtNum(avgTokens), icon: 'gauge' },
    { label: '無資料筆數（覆蓋率 ' + (coverage == null ? '—' : fmtPct(coverage)) + '）', value: fmtNum(noData), icon: 'help-circle' },
  ];
  box.innerHTML = cards.map((c) => `
    <div class="rounded-xl border border-slate-200 dark:border-slate-700/60 bg-white dark:bg-slate-800/40 p-3 flex items-start gap-2.5">
      <i data-lucide="${c.icon}" class="h-4 w-4 text-cyan-600 dark:text-cyan-400 mt-0.5 shrink-0"></i>
      <div>
        <div class="text-[11px] text-slate-400 dark:text-slate-500">${escapeHtml(c.label)}</div>
        <div class="text-lg font-bold text-slate-900 dark:text-white">${c.value}</div>
      </div>
    </div>`).join('');
}

// ── G1: Pareto ───────────────────────────────────────────────────────
// UASZ-5（D35）：scope='all' 時每條長條依專案上色＋標籤後綴專案名；一組若橫跨多個專案
// （目前只有「按技能」分組才可能發生）取第一個專案的顏色，標籤列出全部專案名。
function rowProjectLabel(r) { return r.project || (r.projects && r.projects.length ? r.projects.join('、') : null); }
function rowProjectColor(r) { return projectColor(r.project || (r.projects && r.projects[0]) || null); }
function paretoSvg(rows, scopeAll) {
  if (!rows.length) return '<div class="text-sm text-slate-400 py-10 text-center">目前沒有資料</div>';
  const withCum = paretoWithCumulative(rows).slice(0, 12); // 最多畫前 12 名，避免擠爆
  const W = 680, H = 295, padL = 58, padR = 36, padT = 16, padB = 96;
  const n = withCum.length;
  const gap = (W - padL - padR) / n;
  const barW = gap * 0.58;
  const maxVal = Math.max.apply(null, withCum.map((r) => r.tokenTotal).concat([1]));
  const plotH = H - padT - padB;
  const yOfCum = (pct) => padT + plotH - (pct / 100) * plotH;
  const bars = withCum.map((r, i) => {
    const x = padL + i * gap + (gap - barW) / 2;
    const h = (r.tokenTotal / maxVal) * plotH;
    const y = padT + plotH - h;
    return { x, y, h, r, cx: x + barW / 2 };
  });
  const barsHtml = bars.map((b) => {
    const color = scopeAll ? rowProjectColor(b.r) : '#0891b2';
    const proj = scopeAll ? rowProjectLabel(b.r) : null;
    const label = proj ? (b.r.displayLabel || b.r.key) + ' · ' + proj : (b.r.displayLabel || b.r.key);
    return `
    <rect x="${b.x.toFixed(1)}" y="${b.y.toFixed(1)}" width="${barW.toFixed(1)}" height="${b.h.toFixed(1)}" fill="${color}" rx="3"/>
    <text x="${b.cx.toFixed(1)}" y="${(b.y - 5).toFixed(1)}" font-size="9" text-anchor="middle" fill="currentColor" opacity="0.65">${fmtNum(b.r.tokenTotal)}</text>
    <text x="${b.cx.toFixed(1)}" y="${(H - padB + 12).toFixed(1)}" font-size="8.5" text-anchor="end" fill="currentColor" opacity="0.75" transform="rotate(-35 ${b.cx.toFixed(1)} ${(H - padB + 12).toFixed(1)})">${escapeHtml(truncateLabel(label, scopeAll ? 20 : 12))}<title>${escapeHtml(String(label))}</title></text>`;
  }).join('');
  const linePoints = bars.map((b) => `${b.cx.toFixed(1)},${yOfCum(b.r.cumPct).toFixed(1)}`).join(' ');
  const dots = bars.map((b) => `<circle cx="${b.cx.toFixed(1)}" cy="${yOfCum(b.r.cumPct).toFixed(1)}" r="2.6" fill="#f59e0b"/>
    <text x="${b.cx.toFixed(1)}" y="${(yOfCum(b.r.cumPct) - 7).toFixed(1)}" font-size="8.5" text-anchor="middle" fill="#f59e0b">${b.r.cumPct.toFixed(0)}%</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="w-full h-auto" style="color:#475569">
    <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="currentColor" stroke-opacity="0.3"/>
    <line x1="${padL}" y1="${padT + plotH}" x2="${padL}" y2="${padT}" stroke="currentColor" stroke-opacity="0.3"/>
    ${barsHtml}
    <polyline points="${linePoints}" fill="none" stroke="#f59e0b" stroke-width="1.6"/>
    ${dots}
  </svg>`;
}
// UASF-1/2（D13/D14）：Pareto 的 X 軸標籤要顯示人看得懂的名稱，不是原始分組 key（排程 ID／sessionId）。
function paretoLabelFor(groupBy, row) {
  if (groupBy === 'schedule') return row.key === '(無排程)' ? row.key : resolveScheduleName(row.key);
  if (groupBy === 'session') return row.key === '(無對話)' ? row.key : resolveSessionTitle(row.key, row.firstAt);
  if (groupBy === 'skill') return row.key === '(無技能)' ? row.key : resolveSkillName(row.key);
  return row.key;
}
function renderG1() {
  const dataMap = { session: usageData.summarySession, skill: usageData.summarySkill, schedule: usageData.summarySchedule };
  const data = dataMap[usageState.paretoGroupBy] || usageData.summarySkill;
  const el = container.querySelector('#usage-g1');
  if (!el) return;
  if (!data || !data.rows) { el.innerHTML = '<div class="text-sm text-slate-400 py-10 text-center">載入中…</div>'; return; }
  // D22（v0.6.1）：按「對話」排行時剔除 `(無對話)` 這個佔位分組——這張圖問的是「哪個對話吃掉額度」，
  // 一個不是對話的桶子放進來只會干擾排序與累積百分比。按「技能」時的 `(無技能)` 反而是有意義的
  // 類別（＝沒套技能的純對話），故不一併剔除。
  const rows = data.rows
    .filter((r) => r.tokenTotal > 0)
    .filter((r) => !(usageState.paretoGroupBy === 'session' && r.key === '(無對話)'))
    .map((r) => Object.assign({}, r, { displayLabel: paretoLabelFor(usageState.paretoGroupBy, r) }));
  const scopeAll = usageState.scope === 'all';
  el.innerHTML = paretoSvg(rows, scopeAll);
  if (scopeAll) {
    const names = Array.from(new Set(rows.flatMap((r) => (r.projects && r.projects.length ? r.projects : (r.project ? [r.project] : []))))).sort((a, b) => a.localeCompare(b));
    if (names.length) el.innerHTML += legendHtml(names.map((n) => ({ color: projectColor(n), label: n })));
  }
}

// ── 圖表大小（v0.6.1 D23）─────────────────────────────────────────────
// G4／G5 是雙子圖、內容多，原本一屏放不下；而且 SVG 用 viewBox 等比撐滿寬度時，字級也會
// 跟著被放大（viewBox 680 顯示在 ~950px 容器上＝放大約 1.4 倍）。解法兩手：① viewBox 寬度拉到
// 接近實際像素寬（980），字就不再被放大；② 高度交給使用者用這個三段切換自己決定。
const CHART_SIZES = {
  compact: { label: '緊湊', H: 300 },
  normal: { label: '標準', H: 400 },
  large: { label: '放大', H: 540 },
};
const CHART_W = 980;
function chartH() { return (CHART_SIZES[usageState.chartSize] || CHART_SIZES.normal).H; }

// ── 共用：圖例、滑鼠縱軸指示線＋數值提示（v0.6.1 D24）──────────────────
// 雙子圖本來就必須「上下一起看」，所以指示線要貫穿上下兩個子圖，提示框一次把該組在 X̄ 與 R
// 的數字都列出來，不必靠眼睛在兩張圖之間對位置。
function legendHtml(items) {
  return '<div class="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[11px] text-slate-500 dark:text-slate-400">'
    + items.map((it) => {
      const stroke = it.dash
        ? `<line x1="0" y1="4" x2="18" y2="4" stroke="${it.color}" stroke-width="1.6" stroke-dasharray="${it.dash}"/>`
        : (it.dot
          ? `<circle cx="9" cy="4" r="3" fill="${it.color}"/>`
          : `<line x1="0" y1="4" x2="18" y2="4" stroke="${it.color}" stroke-width="2"/>`);
      return `<span class="flex items-center gap-1.5"><svg width="18" height="8" class="shrink-0">${stroke}</svg>${escapeHtml(it.label)}</span>`;
    }).join('')
    + '</div>';
}
function chartShell(svgHtml) {
  return '<div class="relative usage-chart-wrap">' + svgHtml
    + '<div class="usage-tip absolute z-10 pointer-events-none text-[11px] leading-snug px-2 py-1.5 rounded-md bg-slate-900/90 text-white shadow-lg" style="display:none;min-width:170px"></div></div>';
}
// geom = { W, xs:[每點的 svg x 座標], title:(i)=>string, rows:(i)=>[[標籤, 值], ...] }
function attachCrosshair(el, geom) {
  if (!el || !geom || !geom.xs || !geom.xs.length) return;
  const svg = el.querySelector('svg');
  const line = svg && svg.querySelector('.usage-xh');
  const tip = el.querySelector('.usage-tip');
  if (!svg || !line || !tip) return;
  const nearest = (svgX) => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < geom.xs.length; i++) { const d = Math.abs(geom.xs[i] - svgX); if (d < bd) { bd = d; best = i; } }
    return best;
  };
  svg.style.cursor = 'crosshair';
  svg.addEventListener('mousemove', (ev) => {
    const box = svg.getBoundingClientRect();
    if (!box.width) return;
    const svgX = ((ev.clientX - box.left) / box.width) * geom.W;
    const i = nearest(svgX);
    const px = geom.xs[i].toFixed(1);
    line.setAttribute('x1', px); line.setAttribute('x2', px);
    line.style.display = '';
    tip.innerHTML = '<div class="font-bold mb-1">' + escapeHtml(geom.title(i)) + '</div>'
      + geom.rows(i).map(([k, v]) => '<div class="flex justify-between gap-4"><span class="opacity-60">' + escapeHtml(k) + '</span><span>' + escapeHtml(String(v)) + '</span></div>').join('');
    tip.style.display = 'block';
    const relX = ev.clientX - box.left;
    const tipW = tip.offsetWidth || 180;
    tip.style.left = Math.min(Math.max(relX + 14, 4), Math.max(4, box.width - tipW - 4)) + 'px';
    tip.style.top = Math.max(ev.clientY - box.top - 12, 4) + 'px';
  });
  svg.addEventListener('mouseleave', () => { line.style.display = 'none'; tip.style.display = 'none'; });
}
function fmtClock(iso) {
  const s = String(iso || '');
  return s ? (s.slice(5, 10) + ' ' + s.slice(11, 16)) : '—';
}
function pointCount(data) { return fmtNum((data.groups || data.points || []).length); }

// ── G2: 每日趨勢堆疊圖＋每日累加曲線（v0.6.1 D25 合併）──────────────────
// D25：原本獨立的「對話累積用量曲線」橫軸是「第幾輪」、還得先挑一個對話，看不出時間趨勢，
// 已整張移除；累加的概念併進這張每日趨勢——柱子＝當天各來源用量（堆疊），紅線＝從區間第一天
// 累加到當天的佔比（畫法同 Pareto 的累積線，只是排序軸換成日期、而非「前幾大」）。
const TRIGGER_COLOR = { chat: '#0891b2', schedule: '#f59e0b', telegram: '#8b5cf6' };
const TRIGGER_LABEL = { chat: '對話', schedule: '排程', telegram: 'Telegram' };
// D31：日期清單改由共用區間（usageState.fromDate~toDate）產生，且以「本地日曆日」歸戶。
// UASZ-5（D35）：堆疊的「鍵」一般化——scope='current' 時仍按 trigger；scope='all' 時改按專案
// （keys 傳入 usageState._projectNames，keyFn 改讀 e.project），取代原本寫死的 chat/schedule/telegram。
function dailyStackMatrix(events, keys, keyFn) {
  const byDay = new Map();
  rangeDayList().forEach((day) => { const row = {}; keys.forEach((k) => { row[k] = 0; }); byDay.set(day, row); });
  (events || []).forEach((e) => {
    const day = eventLocalDay(e.at);
    if (!byDay.has(day)) return;
    const row = byDay.get(day);
    const k = keyFn(e);
    if (row[k] === undefined || !(e.tokens && typeof e.tokens.total === 'number')) return;
    row[k] += e.tokens.total;
  });
  return Array.from(byDay.entries()).map(([day, v]) => Object.assign({ day }, v));
}
function dailyTriggerMatrix(events) { return dailyStackMatrix(events, ['chat', 'schedule', 'telegram'], (e) => e.trigger); }
// 純計算：每日總量 → 逐日累加佔比（%）。與 paretoWithCumulative 同一個概念，只是不重新排序。
function dailyWithCumulative(matrix, keys) {
  const total = matrix.reduce((s, m) => s + keys.reduce((ss, k) => ss + (m[k] || 0), 0), 0) || 1;
  let cum = 0;
  return matrix.map((m) => {
    const dayTotal = keys.reduce((ss, k) => ss + (m[k] || 0), 0);
    cum += dayTotal;
    return Object.assign({}, m, { dayTotal, cumToken: cum, cumPct: (cum / total) * 100 });
  });
}
function stackedBarSvg(matrix, keys, colorFn, labelFn) {
  if (!matrix.length) return { html: '<div class="text-sm text-slate-400 py-10 text-center">目前沒有資料</div>', geom: null };
  const rows = dailyWithCumulative(matrix, keys);
  const W = CHART_W, H = Math.round(chartH() * 0.62), padL = 62, padR = 50, padT = 16, padB = 26;
  const plotH = H - padT - padB;
  const n = rows.length;
  const gap = (W - padL - padR) / n;
  const barW = Math.max(1.5, gap * 0.68);
  const maxTotal = Math.max.apply(null, rows.map((m) => m.dayTotal).concat([1]));
  const cx = (i) => padL + i * gap + gap / 2;
  const yOfCum = (pct) => padT + plotH - (pct / 100) * plotH;
  let bars = '';
  rows.forEach((m, i) => {
    const bx = padL + i * gap + (gap - barW) / 2;
    let yCursor = padT + plotH;
    keys.forEach((k) => {
      const h = (m[k] / maxTotal) * plotH;
      if (h > 0) {
        bars += `<rect x="${bx.toFixed(1)}" y="${(yCursor - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${colorFn(k)}"/>`;
        yCursor -= h;
      }
    });
  });
  const labelEvery = Math.max(1, Math.ceil(n / 14));
  let labels = '';
  rows.forEach((m, i) => {
    if (i % labelEvery !== 0) return;
    labels += `<text x="${cx(i).toFixed(1)}" y="${(H - padB + 13).toFixed(1)}" font-size="10" text-anchor="middle" fill="currentColor" opacity="0.6">${m.day.slice(5)}</text>`;
  });
  const cumPath = rows.map((m, i) => `${cx(i).toFixed(1)},${yOfCum(m.cumPct).toFixed(1)}`).join(' ');
  const cumDots = rows.map((m, i) => `<circle cx="${cx(i).toFixed(1)}" cy="${yOfCum(m.cumPct).toFixed(1)}" r="1.8" fill="#dc2626"/>`).join('');
  const html = `<svg viewBox="0 0 ${W} ${H}" class="w-full h-auto" style="color:#475569">
    <text x="${padL}" y="11" font-size="10" fill="currentColor" opacity="0.7">每日用量（token）</text>
    <text x="${(W - padR).toFixed(1)}" y="11" font-size="10" text-anchor="end" fill="#dc2626" opacity="0.85">累積佔比 %</text>
    <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="currentColor" stroke-opacity="0.3"/>
    <line x1="${padL}" y1="${padT + plotH}" x2="${padL}" y2="${padT}" stroke="currentColor" stroke-opacity="0.3"/>
    <text x="${(padL - 5).toFixed(1)}" y="${(padT + 9).toFixed(1)}" font-size="9.5" text-anchor="end" fill="currentColor" opacity="0.55">${fmtNum(Math.round(maxTotal))}</text>
    <text x="${(W - padR + 5).toFixed(1)}" y="${(padT + 9).toFixed(1)}" font-size="9.5" fill="#dc2626" opacity="0.7">100%</text>
    ${bars}
    <polyline points="${cumPath}" fill="none" stroke="#dc2626" stroke-width="1.6"/>
    ${cumDots}
    ${labels}
    <line class="usage-xh" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,3" style="display:none"/>
  </svg>`;
  const geom = {
    W,
    xs: rows.map((m, i) => cx(i)),
    title: (i) => rows[i].day,
    rows: (i) => keys.map((k) => [labelFn(k), fmtNum(Math.round(rows[i][k]))])
      .concat([['當日總量', fmtNum(Math.round(rows[i].dayTotal))]])
      .concat([['累積至當日', fmtNum(Math.round(rows[i].cumToken)) + '（' + rows[i].cumPct.toFixed(1) + '%）']]),
  };
  return { html, geom };
}
function renderG2() {
  const el = container.querySelector('#usage-g2');
  if (!el) return;
  if (!usageData.events || !usageData.events.events) { el.innerHTML = '<div class="text-sm text-slate-400 py-10 text-center">載入中…</div>'; return; }
  const scopeAll = usageState.scope === 'all';
  // UASZ-5（D35）：scope='all' 時改按專案堆疊（取代按 trigger），keys 用本次收斂出的固定專案清單。
  const keys = scopeAll ? usageState._projectNames : ['chat', 'schedule', 'telegram'];
  const colorFn = scopeAll ? (k) => projectColor(k) : (k) => TRIGGER_COLOR[k];
  const labelFn = scopeAll ? (k) => k : (k) => TRIGGER_LABEL[k];
  const matrix = scopeAll
    ? dailyStackMatrix(usageData.events.events, keys, (e) => e.project)
    : dailyTriggerMatrix(usageData.events.events);
  const out = stackedBarSvg(matrix, keys, colorFn, labelFn);
  if (!out.geom) { el.innerHTML = out.html; return; }
  el.innerHTML = chartShell(out.html) + legendHtml(
    keys.map((k) => ({ color: colorFn(k), label: '柱：' + labelFn(k) }))
      .concat([{ color: '#dc2626', label: '線：從區間第一天累加到當天的佔比（右軸 0~100%）' }])
  );
  attachCrosshair(el, out.geom);
}

// ── G2b: 每週限額使用狀況（v0.7 D29）────────────────────────────────────
// 指揮官要的是「每一周的限額用掉多少」。誠實前提（寫在畫面上、不藏在規格裡）：
//   官方用量端點（/api/oauth/usage）只給「當下」的 5 小時／7 天窗口使用率，沒有歷史週的百分比，
//   所以歷史週的「佔週限額 %」拿不到真值，只能推估。
// 推估方法（校準）：若當下官方 7 天窗口使用率為 U%，而最近 7 天我們自己記到的 token 為 T，
//   則「週限額 ≈ T / (U/100)」；拿這個基準把每一週的 token 量換算成百分比。
// 推估會偏低（低估使用率）：我們只記得到「本工作區」的用量，官方窗口算的是整個帳號；
//   別的工作區／直接用 CLI 的用量都不在 T 裡面。這句話必須顯示在畫面上。
// 週的定義（v0.7.2 D33 起）：優先以官方「7 天窗口」resetAt 為錨點往回切週，
// 讀不到官方值才退回 ISO 週（週一起算，與 Linux/ISO 8601 一致）。
// isoWeekStart 本身保留──退回路徑與既有呼叫處仍需要它，不可刪不可改語意。
function isoWeekStart(dayStr) {
  const [y, m, d] = String(dayStr).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const dow = (dt.getDay() + 6) % 7;      // 週一=0 … 週日=6
  return shiftDayStr(dayStr, -dow);
}
// MM/DD HH:MM（本地時間），給 D33 重置錨點週表與官方重置提示共用。
function localDateTimeLabel(ms) {
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}`;
}
// 表頭用：把 resetAt 換算成「星期＋時刻」的本地說明（例如「週六 07:00」），星期與時刻都從
// resetAt 推算，不寫死——帳號方案／時區不同的人重置時刻也不同。
// 官方 resetAt 本身的本地時間落在「該視窗最後一分鐘」（例如週六 06:59），真正的視窗邊界
// （也是下一段的起點）要 +1 分鐘對齊，所以這裡與 weekWindowsFromReset 都做同一個 +60000 位移。
function anchorWeekdayTimeLabel(resetAtISO) {
  const resetMs = new Date(resetAtISO).getTime();
  if (!Number.isFinite(resetMs)) return null;
  const anchor = new Date(resetMs + 60000);
  const names = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
  return `${names[anchor.getDay()]} ${String(anchor.getHours()).padStart(2, '0')}:${String(anchor.getMinutes()).padStart(2, '0')}`;
}
// D33：以官方 resetAt 為界線，往回每 7 天切出覆蓋 [fromMs, toMs] 的視窗清單（每段 [startMs, endMs)，
// endMs 一律等於下一段的 startMs，彼此不重疊、不留縫）。resetAt 可能是「下次重置」（落在未來），
// 用模數往回推到「不晚於 toMs」的第一個邊界再往兩邊展開，不假設它一定在過去或現在。
// resetAtISO 不是合法時間就回 null，呼叫端須自行退回 ISO 週切分。
function weekWindowsFromReset(resetAtISO, fromMs, toMs) {
  const resetMs = new Date(resetAtISO).getTime();
  if (!Number.isFinite(resetMs)) return null;
  const period = 7 * 24 * 60 * 60 * 1000;
  const anchor = resetMs + 60000;   // 真正的視窗邊界（見 anchorWeekdayTimeLabel 的註解）
  const stepsForward = Math.floor((toMs - anchor) / period);
  let start = anchor + stepsForward * period;   // 不晚於 toMs 的最近一個邊界
  const windows = [];
  while (start + period > fromMs) {
    windows.push({ startMs: start, endMs: start + period });
    start -= period;
  }
  windows.reverse();
  return windows;
}
// 回傳 { rows, fallback }。rows 的 weekStart/weekEnd：重置錨點模式下是毫秒時間戳；
// 退回模式下是日期字串（YYYY-MM-DD，沿用舊格式）。fallback=true 代表讀不到官方 resetAt，
// 已退回 ISO 週一~週日切分。事件一律用原始時間戳（new Date(e.at).getTime()）歸戶，
// 不再用 eventLocalDay() 的日曆日字串分桶（跨 07:00 的同一天會落在不同週）——
// 但 eventLocalDay() 本身保留給 G2 每日柱與退回路徑用，不可刪不可改。
function weeklyMatrix(events, resetAtISO) {
  const [fy, fm, fd] = usageState.fromDate.split('-').map(Number);
  const [ty, tm, td] = usageState.toDate.split('-').map(Number);
  const fromMs = new Date(fy, fm - 1, fd, 0, 0, 0, 0).getTime();
  const toMs = new Date(ty, tm - 1, td, 23, 59, 59, 999).getTime();
  const windows = resetAtISO ? weekWindowsFromReset(resetAtISO, fromMs, toMs) : null;
  if (windows && windows.length) {
    const rows = windows.map((w) => ({ weekStart: w.startMs, weekEnd: w.endMs, chat: 0, schedule: 0, telegram: 0, total: 0, hoursInRange: 0 }));
    (events || []).forEach((e) => {
      const t = new Date(e.at).getTime();
      if (!Number.isFinite(t)) return;
      const row = rows.find((r) => t >= r.weekStart && t < r.weekEnd);
      if (!row) return;
      const trig = e.trigger;
      const v = (e.tokens && typeof e.tokens.total === 'number') ? e.tokens.total : 0;
      if (row[trig] !== undefined) row[trig] += v;
      row.total += v;
    });
    rows.forEach((r) => {
      const overlapStart = Math.max(r.weekStart, fromMs);
      const overlapEnd = Math.min(r.weekEnd, toMs + 1);
      r.hoursInRange = Math.max(0, (overlapEnd - overlapStart) / 3600000);
    });
    return { rows, fallback: false };
  }
  // 退回：官方 resetAt 讀不到，沿用既有 ISO 週一~週日切分。
  const byWeek = new Map();               // 週一日期 -> { weekStart, weekEnd, chat, schedule, telegram, total, daysInRange }
  rangeDayList().forEach((day) => {
    const ws = isoWeekStart(day);
    if (!byWeek.has(ws)) byWeek.set(ws, { weekStart: ws, weekEnd: shiftDayStr(ws, 6), chat: 0, schedule: 0, telegram: 0, total: 0, daysInRange: 0 });
    byWeek.get(ws).daysInRange += 1;
  });
  (events || []).forEach((e) => {
    const day = eventLocalDay(e.at);
    if (!day) return;
    const ws = isoWeekStart(day);
    const row = byWeek.get(ws);
    if (!row) return;
    const t = e.trigger;
    const v = (e.tokens && typeof e.tokens.total === 'number') ? e.tokens.total : 0;
    if (row[t] !== undefined) row[t] += v;
    row.total += v;
  });
  return { rows: Array.from(byWeek.values()).sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1)), fallback: true };
}
// 回傳 { weeklyLimit, officialPct, resetAt } 或 null（拿不到官方數字就不推估、整欄顯示「—」）。
function quotaCalibration(events) {
  const q = usageData.quota;
  const claude = q && Array.isArray(q.providers) ? q.providers.find((p) => p.id === 'claude') : null;
  const w7 = claude && Array.isArray(claude.windows) ? claude.windows.find((w) => w.name === '7 天') : null;
  if (!w7 || typeof w7.usedRatio !== 'number' || w7.usedRatio <= 0) return null;
  // D33：分母與官方 7 天窗口對齊同一段——讀得到 resetAt 時用「resetAt - 7 天」至今，
  // 讀不到才退回近 7 個日曆日（原本的作法）。
  let used = 0;
  if (w7.resetAt) {
    const resetMs = new Date(w7.resetAt).getTime();
    const nowMs = Date.now();
    if (Number.isFinite(resetMs)) {
      const windowStart = resetMs - 7 * 24 * 60 * 60 * 1000;
      (events || []).forEach((e) => {
        const t = new Date(e.at).getTime();
        if (Number.isFinite(t) && t >= windowStart && t <= nowMs && e.tokens && typeof e.tokens.total === 'number') used += e.tokens.total;
      });
    }
  } else {
    const since = shiftDayStr(todayStr(), -6);
    (events || []).forEach((e) => {
      const day = eventLocalDay(e.at);
      if (day && day >= since && e.tokens && typeof e.tokens.total === 'number') used += e.tokens.total;
    });
  }
  if (used <= 0) return null;
  return { weeklyLimit: used / w7.usedRatio, officialPct: w7.usedRatio * 100, resetAt: w7.resetAt || null, basisTokens: used };
}
function renderWeekly() {
  const el = container.querySelector('#usage-g2-weekly');
  if (!el) return;
  if (!usageData.events || !usageData.events.events) { el.innerHTML = '<div class="text-xs text-slate-400 py-4">載入中…</div>'; return; }
  const q = usageData.quota;
  const claude = q && Array.isArray(q.providers) ? q.providers.find((p) => p.id === 'claude') : null;
  const w7 = claude && Array.isArray(claude.windows) ? claude.windows.find((w) => w.name === '7 天') : null;
  const resetAtISO = (w7 && w7.resetAt) || null;
  const { rows, fallback } = weeklyMatrix(usageData.events.events, resetAtISO);
  if (!rows.length) { el.innerHTML = '<div class="text-xs text-slate-400 py-4">目前區間沒有資料</div>'; return; }
  const cal = quotaCalibration(usageData.events.events);
  const maxTotal = Math.max.apply(null, rows.map((r) => r.total).concat([1]));
  const body = rows.map((r) => {
    const pct = cal ? (r.total / cal.weeklyLimit) * 100 : null;
    const barW = Math.max(0, (r.total / maxTotal) * 100);
    const over = pct != null && pct >= 100;
    const warn = pct != null && pct >= 80 && pct < 100;
    const barColor = over ? '#dc2626' : (warn ? '#f59e0b' : '#0891b2');
    let label, partial;
    if (fallback) {
      label = `${escapeHtml(r.weekStart.slice(5))} ~ ${escapeHtml(r.weekEnd.slice(5))}`;
      partial = r.daysInRange < 7 ? `<span class="text-[10px] text-slate-400">（區間內只含 ${r.daysInRange} 天）</span>` : '';
    } else {
      label = `${escapeHtml(localDateTimeLabel(r.weekStart))} ~ ${escapeHtml(localDateTimeLabel(r.weekEnd - 60000))}`;
      const daysEquiv = r.hoursInRange / 24;
      partial = r.hoursInRange < 168 ? `<span class="text-[10px] text-slate-400">（區間內只含 ${daysEquiv.toFixed(1)} 天）</span>` : '';
    }
    return `<tr class="border-t border-slate-100 dark:border-slate-700/50">
      <td class="py-1.5 pr-3 whitespace-nowrap text-slate-700 dark:text-slate-200">${label} ${partial}</td>
      <td class="py-1.5 pr-3 text-right tabular-nums text-slate-700 dark:text-slate-200">${fmtNum(Math.round(r.total))}</td>
      <td class="py-1.5 pr-3 w-1/2">
        <div class="h-2 rounded bg-slate-100 dark:bg-slate-700/60 overflow-hidden"><div style="width:${barW.toFixed(1)}%;background:${barColor}" class="h-full"></div></div>
      </td>
      <td class="py-1.5 text-right tabular-nums ${over ? 'text-red-600 dark:text-red-400 font-bold' : (warn ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400')}">${pct == null ? '—' : pct.toFixed(1) + '%'}</td>
    </tr>`;
  }).join('');
  const official = cal
    ? `官方 7 天窗口目前已用 <b>${cal.officialPct.toFixed(0)}%</b>${cal.resetAt ? `（${escapeHtml(localDateTimeLabel(new Date(cal.resetAt).getTime()))} 重置）` : ''}；據此回推週限額約 ${fmtNum(Math.round(cal.weeklyLimit))} token。`
    : '目前讀不到官方 7 天窗口使用率（Claude 未登入／端點異常／本週本工作區還沒有用量），因此「佔週限額」整欄顯示「—」，不以推估數字充當真值。';
  const caveat = cal
    ? '⚠ 「佔週限額」是<b>推估值</b>：官方只提供「當下」的 7 天窗口使用率、沒有歷史週的百分比，這裡是用上面那組當下數字回推出週限額再換算每一週。且本頁只記得到<b>本工作區</b>的用量，帳號層級的實際使用率會比這裡高（別的工作區、直接開 CLI 用掉的都不在內）。'
    : '';
  const headerLabel = fallback
    ? '週（官方重置時間讀不到，暫以週一 ~ 週日切分）'
    : `週（每週重置：${anchorWeekdayTimeLabel(resetAtISO)}）`;
  el.innerHTML = `<table class="w-full text-xs">
    <thead><tr class="text-[11px] text-slate-400 dark:text-slate-500">
      <th class="text-left font-medium pb-1">${headerLabel}</th>
      <th class="text-right font-medium pb-1 pr-3">該週用量（token）</th>
      <th class="text-left font-medium pb-1 pr-3">相對最高週</th>
      <th class="text-right font-medium pb-1">佔週限額（推估）</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>
  <p class="mt-2 text-[11px] text-slate-400 dark:text-slate-500">${official}</p>
  ${caveat ? `<p class="mt-1 text-[11px] text-amber-600 dark:text-amber-400">${caveat}</p>` : ''}`;
}

// ── G4: 使用量趨勢（X-Bar/R，固定組距）── UASC-3（D17 取代原 X/MR）───────
// 依事件時間序每 groupSize 筆打包一組；上半畫 X̄ 折線＋管制界限（CL/UCL/LCL，取最近
// controlWindow 組、用教科書 X-Bar/R 公式 X̄̄ ± A2·R̄，見 D21 修正）；下半畫 R 子圖，含 R̄ 與
// D4·R̄／D3·R̄ 界限。
// v0.7 D30：原本疊在上半的「歷史百分位線」（右軸 0~100%）整條移除。指揮官原話是他以為那條線
// 是「跟 UCL/LCL 類似、只是算法不同」的東西，看了才發現不是——它答的是「這組比過去幾成的組高」，
// 跟管制判定無關，兩套語意疊在同一張圖只會互相干擾。要看相對排名，柏拉圖已經在答這件事。
function trendSvg(data, scopeAll) {
  const points = data.groups, cl = data.controlLines;
  const W = CHART_W, H = chartH(), padL = 62, padR = 62, padT = 20, padB = 26, gapV = 24;
  const plotH = (H - padT - padB - gapV) / 2, plotW = W - padL - padR;
  const x = (i) => padL + (points.length > 1 ? (i / (points.length - 1)) * plotW : plotW / 2);

  // 上半：X̄ ＋ 管制界限（左軸 token）＋ 歷史百分位（右軸 0~100%）
  const xVals = points.map((p) => p.xbar).concat([cl.ucl, cl.lcl]);
  const xMax = Math.max.apply(null, xVals), xMin = Math.min.apply(null, xVals.concat([0]));
  const xSpan = (xMax - xMin) || 1;
  const yX = (v) => padT + plotH - ((v - xMin) / xSpan) * plotH;
  const xPath = points.map((p, i) => `${x(i).toFixed(1)},${yX(p.xbar).toFixed(1)}`).join(' ');
  // UASZ-5（D35）：scope='all' 時，出界的點優先維持紅色警示；未出界時依該組單一專案上色
  // （一組若橫跨多個專案——固定組距分組時可能發生——沒有單一色可對應，維持預設色）。
  const dotProjectColor = (p) => (scopeAll && p.project) ? projectColor(p.project) : null;
  const xDots = points.map((p, i) => {
    const out = p.xbar > cl.ucl || p.xbar < cl.lcl;
    const color = out ? '#dc2626' : (dotProjectColor(p) || '#0891b2');
    return `<circle cx="${x(i).toFixed(1)}" cy="${yX(p.xbar).toFixed(1)}" r="${out ? 3.4 : 2.2}" fill="${color}"/>`;
  }).join('');

  // 下半：R ＋ R̄／UCL_R（D4·R̄）／LCL_R（D3·R̄）
  const rTop = padT + plotH + gapV;
  const rMax = Math.max.apply(null, points.map((p) => p.r).concat([cl.rUcl || 0, 1]));
  const yR = (v) => rTop + plotH - (v / rMax) * plotH;
  const rPath = points.map((p, i) => `${x(i).toFixed(1)},${yR(p.r).toFixed(1)}`).join(' ');
  const rDots = points.map((p, i) => {
    const out = cl.rUcl != null && (p.r > cl.rUcl || p.r < (cl.rLcl || 0));
    const color = out ? '#dc2626' : (dotProjectColor(p) || '#f59e0b');
    return `<circle cx="${x(i).toFixed(1)}" cy="${yR(p.r).toFixed(1)}" r="${out ? 3.4 : 2.2}" fill="${color}"/>`;
  }).join('');

  const labelEvery = Math.max(1, Math.ceil(points.length / 12));
  const xLabels = points.map((p, i) => (i % labelEvery !== 0 ? '' :
    `<text x="${x(i).toFixed(1)}" y="${(H - 6).toFixed(1)}" font-size="9.5" text-anchor="middle" fill="currentColor" opacity="0.55">${escapeHtml(String(p.endAt || '').slice(5, 10))}</text>`)).join('');

  const html = `<svg viewBox="0 0 ${W} ${H}" class="w-full h-auto" style="color:#475569">
    <text x="${padL}" y="${(padT - 7).toFixed(1)}" font-size="10" fill="currentColor" opacity="0.7">X̄・每組平均用量（每組 ${escapeHtml(String((data.settings && data.settings.groupSize) || ''))} 筆事件）</text>
    <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="currentColor" stroke-opacity="0.3"/>
    <line x1="${padL}" y1="${padT + plotH}" x2="${padL}" y2="${padT}" stroke="currentColor" stroke-opacity="0.3"/>
    <line x1="${padL}" y1="${yX(cl.ucl).toFixed(1)}" x2="${W - padR}" y2="${yX(cl.ucl).toFixed(1)}" stroke="#dc2626" stroke-dasharray="5,3" stroke-width="1"/>
    <line x1="${padL}" y1="${yX(cl.cl).toFixed(1)}" x2="${W - padR}" y2="${yX(cl.cl).toFixed(1)}" stroke="#16a34a" stroke-dasharray="2,3" stroke-width="1"/>
    <line x1="${padL}" y1="${yX(cl.lcl).toFixed(1)}" x2="${W - padR}" y2="${yX(cl.lcl).toFixed(1)}" stroke="#dc2626" stroke-dasharray="5,3" stroke-width="1"/>
    <text x="${(W - padR + 4).toFixed(1)}" y="${(yX(cl.ucl) + 3).toFixed(1)}" font-size="9" fill="#dc2626">UCL ${fmtNum(Math.round(cl.ucl))}</text>
    <text x="${(W - padR + 4).toFixed(1)}" y="${(yX(cl.cl) + 3).toFixed(1)}" font-size="9" fill="#16a34a">CL ${fmtNum(Math.round(cl.cl))}</text>
    <text x="${(W - padR + 4).toFixed(1)}" y="${(yX(cl.lcl) + 3).toFixed(1)}" font-size="9" fill="#dc2626">LCL ${fmtNum(Math.round(cl.lcl))}</text>
    <polyline points="${xPath}" fill="none" stroke="#0891b2" stroke-width="1.4"/>
    ${xDots}
    <text x="${padL}" y="${(rTop - 7).toFixed(1)}" font-size="10" fill="currentColor" opacity="0.7">R・每組全距（組內最大－最小）</text>
    <line x1="${padL}" y1="${(rTop + plotH).toFixed(1)}" x2="${W - padR}" y2="${(rTop + plotH).toFixed(1)}" stroke="currentColor" stroke-opacity="0.3"/>
    <line x1="${padL}" y1="${(rTop + plotH).toFixed(1)}" x2="${padL}" y2="${rTop.toFixed(1)}" stroke="currentColor" stroke-opacity="0.3"/>
    ${cl.rUcl != null ? `<line x1="${padL}" y1="${yR(cl.rUcl).toFixed(1)}" x2="${W - padR}" y2="${yR(cl.rUcl).toFixed(1)}" stroke="#dc2626" stroke-dasharray="5,3" stroke-width="1"/>
    <line x1="${padL}" y1="${yR(cl.rBar).toFixed(1)}" x2="${W - padR}" y2="${yR(cl.rBar).toFixed(1)}" stroke="#16a34a" stroke-dasharray="2,3" stroke-width="1"/>
    <text x="${(W - padR + 4).toFixed(1)}" y="${(yR(cl.rUcl) + 3).toFixed(1)}" font-size="9" fill="#dc2626">UCL ${fmtNum(Math.round(cl.rUcl))}</text>
    <text x="${(W - padR + 4).toFixed(1)}" y="${(yR(cl.rBar) + 3).toFixed(1)}" font-size="9" fill="#16a34a">R̄ ${fmtNum(Math.round(cl.rBar))}</text>` : ''}
    <polyline points="${rPath}" fill="none" stroke="#f59e0b" stroke-width="1.4"/>
    ${rDots}
    ${xLabels}
    <line class="usage-xh" x1="0" y1="${padT}" x2="0" y2="${(rTop + plotH).toFixed(1)}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,3" style="display:none"/>
  </svg>`;
  const geom = {
    W,
    xs: points.map((p, i) => x(i)),
    title: (i) => `第 ${i + 1} 組（${fmtClock(points[i].startAt)} → ${fmtClock(points[i].endAt)}）`,
    rows: (i) => {
      const p = points[i];
      const outX = p.xbar > cl.ucl ? '超出 UCL' : (p.xbar < cl.lcl ? '低於 LCL' : '界限內');
      const outR = (cl.rUcl == null) ? '—' : (p.r > cl.rUcl ? '超出 UCL' : (p.r < (cl.rLcl || 0) ? '低於 LCL' : '界限內'));
      const base = [
        ['X̄ 平均用量', fmtNum(Math.round(p.xbar))],
        ['R 全距', fmtNum(Math.round(p.r))],
        ['組內筆數', p.n],
        ['X̄ 判定', outX],
        ['R 判定', outR],
      ];
      if (scopeAll && (p.project || (p.projects && p.projects.length))) base.push(['專案', p.project || p.projects.join('、')]);
      return base;
    },
  };
  return { html, geom };
}
async function renderG4(opts) {
  const el = container.querySelector('#usage-g4');
  if (!el) return;
  if (!(opts && opts.reuse && usageData.trend)) {
    el.innerHTML = '<div class="text-sm text-slate-400 py-10 text-center">載入中…</div>';
    if (!usageState.trendSettings) usageState.trendSettings = await fetchJson('/api/usage/settings');
    const { from, to } = dateRangeISO();
    usageData.trend = await fetchJson(`/api/usage/trend?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&scope=${usageState.scope}`);
  }
  const data = usageData.trend;
  if (!data) { el.innerHTML = '<div class="text-sm text-red-500 py-10 text-center">載入失敗</div>'; return; }
  if (data.insufficientData) {
    // D28：原本只丟一行「組數 N < 8」，指揮官看了也不知道能做什麼。改成講清楚差多少、
    // 並算出「組大小改成幾」就能看到圖（組數＝事件數 ÷ 組大小），以及拉長區間這條路。
    const have = (data.groups || []).length;
    const curGs = (data.settings && data.settings.groupSize) || 3;
    const totalEv = (usageData.events && usageData.events.total) || have * curGs;
    const suggest = Math.max(2, Math.floor(totalEv / 8));
    const canSuggest = suggest < curGs && Math.floor(totalEv / suggest) >= 8;
    el.innerHTML = `<div class="text-sm text-amber-600 dark:text-amber-400 py-8 px-4 text-center space-y-1">
      <div>這段區間只切出 <b>${fmtNum(have)}</b> 組（每組 ${escapeHtml(String(curGs))} 筆事件），不足畫管制界限所需的 8 組，所以這張圖先不畫——與其畫一條沒有統計意義的界限騙您，不如空著。</div>
      <div class="text-[12px] text-slate-500 dark:text-slate-400">可以這樣讓它出現：${canSuggest ? `按右上「設定統計指標」把<b>組大小</b>從 ${escapeHtml(String(curGs))} 改成 <b>${escapeHtml(String(suggest))}</b>（本區間共 ${fmtNum(totalEv)} 筆事件，這樣約可切出 ${fmtNum(Math.floor(totalEv / suggest))} 組）；或` : ''}把上方的統計區間拉長（例如改成近 30／90 天）。</div>
    </div>`;
    return;
  }
  const scopeAll = usageState.scope === 'all';
  const out = trendSvg(data, scopeAll);
  const gs = (data.settings && data.settings.groupSize) || '?';
  const clines = data.controlLines || {};
  const approx = clines.approxConstants ? '｜⚠ 組大小超過 15，管制常數夾在 n=15 上，屬刻意近似' : '';
  // D28 誠實標註：界限實際用了幾組算出來，少於設定視窗時明說「靈敏度偏高」。
  const basis = clines.limitedBasis
    ? `<p class="mt-1 text-[11px] text-amber-600 dark:text-amber-400">⚠ 管制界限只用了 ${fmtNum(clines.basisCount)} 組算出（設定的管制界限視窗是 ${fmtNum((data.settings && data.settings.controlWindow) || 0)} 組）。樣本偏少時界限會偏窄、較容易判定出界，請當成「初步訊號」而非定論；拉長統計區間或累積更多用量後會更穩。</p>`
    : '';
  const projectLegend = scopeAll
    ? Array.from(new Set(data.groups.flatMap((g) => (g.projects && g.projects.length ? g.projects : (g.project ? [g.project] : [])))))
        .sort((a, b) => a.localeCompare(b)).map((n) => ({ color: projectColor(n), dot: true, label: '點：' + n }))
    : [];
  el.innerHTML = chartShell(out.html) + legendHtml([
    { color: '#0891b2', label: 'X̄ 每組平均用量（左軸 token）' },
    { color: '#f59e0b', label: 'R 每組全距' },
    { color: '#16a34a', dash: '2,3', label: 'CL／R̄ 中心線（＝全體平均，正好落在上下界限中間）' },
    { color: '#dc2626', dash: '5,3', label: 'UCL／LCL 管制上下界限（X̄̄ ± A2·R̄）' },
    { color: '#dc2626', dot: true, label: '放大的紅點＝該組出界' },
  ].concat(projectLegend)) + `<p class="mt-1.5 text-[11px] text-slate-400 dark:text-slate-500">共 ${pointCount(data)} 組｜每組 ${escapeHtml(String(gs))} 筆事件，依時間先後切（對話與排程一起算）${approx}${scopeAll ? '｜一組若橫跨多個專案，點色維持預設不特別標示，滑過去的提示框仍會列出全部專案名' : ''}</p>` + basis;
  attachCrosshair(el, out.geom);
}

// ── G5: X-Bar/R 管制圖（UASF-4/D11，分組＝同一天的同一個對話，n 隨組變動）────────
function xbarRSvg(data, scopeAll) {
  const points = data.points;
  // D27：固定界限由後端 controlLines 給；舊快取回應沒有這個欄位時退回第一點的值（此時各點已同值）。
  const lim = data.controlLines || { xUcl: points[0].xUcl, xLcl: points[0].xLcl, rUcl: points[0].rUcl, rLcl: points[0].rLcl };
  const W = CHART_W, H = chartH(), padL = 62, padR = 62, padT = 20, padB = 26, gapV = 24;
  const plotH = (H - padT - padB - gapV) / 2, plotW = W - padL - padR;
  const x = (i) => padL + (points.length > 1 ? (i / (points.length - 1)) * plotW : plotW / 2);
  // X̄ 子圖（上半）：管制線為整段共用的固定水平線（D27，原本每點隨 n 變動呈階梯狀）。
  const xVals = points.map((p) => p.xbar).concat([lim.xUcl, lim.xLcl]);
  const xMax = Math.max.apply(null, xVals), xMin = Math.min.apply(null, xVals.concat([0]));
  const xSpan = (xMax - xMin) || 1;
  const yX = (v) => padT + plotH - ((v - xMin) / xSpan) * plotH;
  const xPath = points.map((p, i) => `${x(i).toFixed(1)},${yX(p.xbar).toFixed(1)}`).join(' ');
  // D27：界限是整段共用的固定值（後端已改成每點同值），所以直接畫水平線＋右側數字，
  // 不再用 polyline 串成階梯——階梯界限讓「這點有沒有出界」變成要逐點比對，失去管制圖的用意。
  const hz = (v, color, label, yFn) => `<line x1="${padL}" y1="${yFn(v).toFixed(1)}" x2="${W - padR}" y2="${yFn(v).toFixed(1)}" stroke="${color}" stroke-dasharray="5,3" stroke-width="1"/>
    <text x="${(W - padR + 4).toFixed(1)}" y="${(yFn(v) + 3).toFixed(1)}" font-size="9" fill="${color}">${label} ${fmtNum(Math.round(v))}</text>`;
  const xLimitLines = hz(lim.xUcl, '#dc2626', 'UCL', yX) + hz(lim.xLcl, '#dc2626', 'LCL', yX);
  const xClLine = data.xbarbar != null
    ? `<line x1="${padL}" y1="${yX(data.xbarbar).toFixed(1)}" x2="${W - padR}" y2="${yX(data.xbarbar).toFixed(1)}" stroke="#16a34a" stroke-dasharray="2,3" stroke-width="1"/>
       <text x="${(W - padR + 4).toFixed(1)}" y="${(yX(data.xbarbar) + 3).toFixed(1)}" font-size="9" fill="#16a34a">X̄̄ ${fmtNum(Math.round(data.xbarbar))}</text>` : '';
  // UASZ-5（D35）：G5 一個點＝一個對話一天，一定只屬於單一專案，優先用專案色（出界仍維持紅色警示）。
  const xDots = points.map((p, i) => {
    const out = p.xbar > lim.xUcl || p.xbar < lim.xLcl;
    const color = out ? '#dc2626' : ((scopeAll && p.project) ? projectColor(p.project) : '#0891b2');
    return `<circle cx="${x(i).toFixed(1)}" cy="${yX(p.xbar).toFixed(1)}" r="${out ? 3.4 : 2.2}" fill="${color}"/>`;
  }).join('');
  // R 子圖（下半）
  const rTop = padT + plotH + gapV;
  const rVals = points.map((p) => p.r).concat([lim.rUcl]);
  const rMax = Math.max.apply(null, rVals.concat([1]));
  const yR = (v) => rTop + plotH - (v / rMax) * plotH;
  const rPath = points.map((p, i) => `${x(i).toFixed(1)},${yR(p.r).toFixed(1)}`).join(' ');
  const rLimitLines = hz(lim.rUcl, '#dc2626', 'UCL', yR) + (lim.rLcl > 0 ? hz(lim.rLcl, '#dc2626', 'LCL', yR) : '');
  const rClLine = data.rbar != null
    ? `<line x1="${padL}" y1="${yR(data.rbar).toFixed(1)}" x2="${W - padR}" y2="${yR(data.rbar).toFixed(1)}" stroke="#16a34a" stroke-dasharray="2,3" stroke-width="1"/>
       <text x="${(W - padR + 4).toFixed(1)}" y="${(yR(data.rbar) + 3).toFixed(1)}" font-size="9" fill="#16a34a">R̄ ${fmtNum(Math.round(data.rbar))}</text>` : '';
  const rDots = points.map((p, i) => {
    const out = p.r > lim.rUcl || p.r < lim.rLcl;
    const color = out ? '#dc2626' : ((scopeAll && p.project) ? projectColor(p.project) : '#f59e0b');
    return `<circle cx="${x(i).toFixed(1)}" cy="${yR(p.r).toFixed(1)}" r="${out ? 3.4 : 2.2}" fill="${color}"/>`;
  }).join('');
  const labelEvery = Math.max(1, Math.ceil(points.length / 12));
  const xLabels = points.map((p, i) => (i % labelEvery !== 0 ? '' :
    `<text x="${x(i).toFixed(1)}" y="${(H - 6).toFixed(1)}" font-size="9.5" text-anchor="middle" fill="currentColor" opacity="0.55">${escapeHtml(String(p.date || '').slice(5))}</text>`)).join('');
  const html = `<svg viewBox="0 0 ${W} ${H}" class="w-full h-auto" style="color:#475569">
    <text x="${padL}" y="${(padT - 7).toFixed(1)}" font-size="10" fill="currentColor" opacity="0.7">X̄・這個對話當天「平均每輪」燒掉多少 token</text>
    <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="currentColor" stroke-opacity="0.3"/>
    <line x1="${padL}" y1="${padT + plotH}" x2="${padL}" y2="${padT}" stroke="currentColor" stroke-opacity="0.3"/>
    ${xLimitLines}
    ${xClLine}
    <polyline points="${xPath}" fill="none" stroke="#0891b2" stroke-width="1.4"/>
    ${xDots}
    <text x="${padL}" y="${(rTop - 7).toFixed(1)}" font-size="10" fill="currentColor" opacity="0.7">R・最貴的一輪減最便宜的一輪（＝這個對話從頭漲到尾的落差）</text>
    <line x1="${padL}" y1="${(rTop + plotH).toFixed(1)}" x2="${W - padR}" y2="${(rTop + plotH).toFixed(1)}" stroke="currentColor" stroke-opacity="0.3"/>
    <line x1="${padL}" y1="${(rTop + plotH).toFixed(1)}" x2="${padL}" y2="${rTop.toFixed(1)}" stroke="currentColor" stroke-opacity="0.3"/>
    ${rLimitLines}
    ${rClLine}
    <polyline points="${rPath}" fill="none" stroke="#f59e0b" stroke-width="1.4"/>
    ${rDots}
    ${xLabels}
    <line class="usage-xh" x1="0" y1="${padT}" x2="0" y2="${(rTop + plotH).toFixed(1)}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,3" style="display:none"/>
  </svg>`;
  const geom = {
    W,
    xs: points.map((p, i) => x(i)),
    title: (i) => `${points[i].date}｜${resolveSessionTitle(points[i].sessionId, points[i].date)}`,
    rows: (i) => {
      const p = points[i];
      const outX = p.xbar > lim.xUcl ? '超出 UCL（比其他對話貴很多）' : (p.xbar < lim.xLcl ? '低於 LCL' : '界限內');
      const outR = p.r > lim.rUcl ? '超出 UCL（漲幅特別兇）' : (p.r < lim.rLcl ? '低於 LCL' : '界限內');
      const base = [
        ['輪數', p.n],
        ['X̄ 平均每輪', fmtNum(Math.round(p.xbar))],
        ['R 頭尾落差', fmtNum(Math.round(p.r))],
        ['當天總用量', fmtNum(Math.round(p.sum))],
        ['X̄ 判定', outX],
        ['R 判定', outR],
      ];
      if (scopeAll && (p.project || (p.projects && p.projects.length))) base.push(['專案', p.project || p.projects.join('、')]);
      return base;
    },
  };
  return { html, geom };
}
function renderG5() {
  const el = container.querySelector('#usage-g5');
  if (!el) return;
  const data = usageData.xbarR;
  if (!data) { el.innerHTML = '<div class="text-sm text-slate-400 py-10 text-center">載入中…</div>'; return; }
  if (data.insufficientData) {
    // G5 的分組是「一個對話一天算一組」，沒有可調的參數——唯一的路是拉長區間或多累積幾天。
    const have = (data.points || []).length;
    el.innerHTML = `<div class="text-sm text-amber-600 dark:text-amber-400 py-8 px-4 text-center space-y-1">
      <div>這段區間只有 <b>${fmtNum(have)}</b> 組「對話 × 日」（且一個對話當天至少要 2 輪才算得出落差），不足畫管制界限所需的 8 組。</div>
      <div class="text-[12px] text-slate-500 dark:text-slate-400">這張圖的分組是「一個對話一天一組」，沒有可調參數——把上方統計區間拉長（例如近 30／90 天），或再累積幾天對話，它就會出現。</div>
    </div>`;
    return;
  }
  const gs = (usageState.trendSettings && usageState.trendSettings.groupSize) || '?';
  const scopeAll = usageState.scope === 'all';
  const out = xbarRSvg(data, scopeAll);
  const projectLegend = scopeAll
    ? Array.from(new Set(data.points.map((p) => p.project).filter(Boolean))).sort((a, b) => a.localeCompare(b)).map((n) => ({ color: projectColor(n), dot: true, label: '點：' + n }))
    : [];
  el.innerHTML = chartShell(out.html) + legendHtml([
    { color: '#0891b2', label: 'X̄ 平均每輪用量' },
    { color: '#f59e0b', label: 'R 頭尾落差' },
    { color: '#16a34a', dash: '2,3', label: 'X̄̄／R̄ 中心線（全部對話的平均水準）' },
    { color: '#dc2626', dash: '5,3', label: 'UCL／LCL 管制界限（整段固定的水平線，與 G4 畫法一致）' },
    { color: '#dc2626', dot: true, label: '放大的紅點＝這個對話建議關掉重開' },
  ].concat(projectLegend)) + `<p class="mt-1.5 text-[11px] text-slate-400 dark:text-slate-500">共 ${pointCount(data)} 組｜一個點＝「某一天的某一個對話」（至少 2 輪才算得出落差）。點數與上面 G4 本來就不同：G4 是把所有事件每 ${escapeHtml(String(gs))} 筆切一組，G5 是一個對話一天算一組。</p>`
    + `<p class="mt-1 text-[11px] text-amber-600 dark:text-amber-400">⚠ 各組對話輪數不等（平均 ${escapeHtml(String(data.nBar || '?'))} 輪），界限以平均輪數算成一組固定值（D27）。這是為了「一眼看出哪個點出界」而刻意簡化；教科書做法是每點隨自己的輪數變動。</p>`;
  attachCrosshair(el, out.geom);
}

export function mount(root, ctx) {
  container = root;
  if (typeof window.showPanel === 'function') window.showPanel('__view_root__');
  root.classList.remove('hidden');
  if (typeof window.highlightMenuBtn === 'function') window.highlightMenuBtn('menu-usage');
  const pathEl = document.getElementById('header-file-path'); if (pathEl) pathEl.innerText = '用量統計';
  const titleEl = document.getElementById('header-file-title'); if (titleEl) titleEl.innerText = '誰吃掉了額度、哪支技能變肥了';
  const vscodeEl = document.getElementById('btn-vscode'); if (vscodeEl) vscodeEl.href = '#';
  const savedEl = document.getElementById('last-saved'); if (savedEl) savedEl.classList.add('hidden');
  const backEl = document.getElementById('btn-back'); if (backEl) backEl.classList.add('hidden');

  render();
  loadAll();
}

export function unmount() {
  if (container) { container.classList.add('hidden'); container.innerHTML = ''; }
  container = null;
}

// SPEC-view-chat-context.md §3.1/§3.3 — 每個新 view 都要能用頭像對話（通則）；這頁沒有單一
// 聚焦物件（不像 codegraph 有選中的 symbol），只回報「目前看哪個區間、按什麼分組」當脈絡。
export function getChatContext() {
  const groupLabel = { session: '對話', skill: '技能', schedule: '排程' }[usageState.paretoGroupBy] || usageState.paretoGroupBy;
  return {
    kind: 'usage',
    key: 'usage:' + usageState.fromDate + '~' + usageState.toDate + ':' + usageState.paretoGroupBy,
    label: '用量統計（' + usageState.fromDate + ' ~ ' + usageState.toDate + '・按' + groupLabel + '排行）',
    payload: { fromDate: usageState.fromDate, toDate: usageState.toDate, paretoGroupBy: usageState.paretoGroupBy },
  };
}

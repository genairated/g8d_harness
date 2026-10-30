// SPEC-portal-architecture.md §V4 — 排程任務 view 模組（自 index.html 完整搬移，行為不變）。
// 同 V8/V9 手法：DOM 動態建置進 mount() 的 container；inline onclick 改 addEventListener；
// 共用的 window.escapeHtml/highlightMenuBtn/showPanel/showToast 沿用既有 index.html 全域函式。

export const meta = { route: '/app/schedule', title: '排程任務', icon: 'clock', menuGroup: 'schedule' };

let container = null;
let schedRefreshTimer = null; // SCHED-14: 有 run 執行中時輕量輪詢

// ── SBA: 批量歸檔＋串接整串連動（spec §9.4）─────────────────────────────
// 現役（list）／歷史（hist）各自獨立管理選取狀態：
//   schedSelectedExplicit[table] = 指揮官「真的點過」的 id 集合
//   schedSelected[table]         = 連動後的完整集合（explicit 的每個 id 所屬整條鏈全部成員）
// 每次 schedLoadList() 重繪都會重新計算 schedChainGroupsByTable，並把已不存在的 id 從
// explicit 剔除、再從 explicit 重新 derive 完整集合——SSE 重繪後選取盡量保留、刪除的排程自動消失。
let schedSelectedExplicit = { list: new Set(), hist: new Set() };
let schedSelected = { list: new Set(), hist: new Set() };
let schedChainGroupsByTable = { list: new Map(), hist: new Map() };
let schedByIdTable = { list: new Map(), hist: new Map() }; // id -> schedule 物件（該表全量，非僅當頁）
let schedAllIdsTable = { list: [], hist: [] };              // 該表全量 id（供「全選」使用，不受分頁限制）
let schedBatchBusy = false; // 批量 PUT 執行中，避免重複觸發

// ── SLV: 排程頁即時更新（SSE + 保底輪詢）────────────────────────────────
// 後端只推「排程資料有變動」的輕量事件；收到就重新呼叫既有的 GET /api/schedules /
// GET /api/activities 重繪，不接收整包資料（避免兩份狀態不同步）。
let schedEventSource = null;
let schedChangeDebounceTimer = null;
let schedSSEFailCount = 0;
let schedPollTimer = null;      // SSE 連續失敗時的保底：可見分頁每 15 秒輪詢
let schedUsingPolling = false;
const SCHED_SSE_FAIL_THRESHOLD = 3;

const STATUS_BADGE = {
  success:  'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  failed:  'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  running: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  interrupted: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  'limited-waiting': 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  blocked: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  aborted: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  // SSTAT-P: 完成、有交付，但有事待指揮官確認——藍色，跟綠色 success／amber blocked 區隔。
  partial: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
};
// SSTAT-03: display label per status key; falls back to the raw key for the others.
const STATUS_LABEL = { blocked: '⚠ 受阻·待你', interrupted: '⛔ 中斷', aborted: '🛑 已中止', partial: '✅ 完成·待確認' };

// KD2: 知識精華收斂——verdict／status 中文標籤與色票（spec §3 資料模型）
const KD_VERDICT_LABEL = { adopt: '全部收納', merge: '併入既有', partial: '部分收納', outdated: '過時', wrong: '錯誤', duplicate: '重複' };
const KD_VERDICT_BADGE = {
  adopt:     'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
  merge:     'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  partial:   'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
  outdated:  'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  wrong:     'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  duplicate: 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
};
const KD_STATUS_LABEL = {
  pending: '待裁決', accepted: '已接受', rejected: '已拒絕', commented: '等待 Hana 重新思考',
  agreed: 'Hana 同意（已修正）', disputed: 'Hana 仍有疑慮', applied: '已寫入',
};

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// SCH-MDP: 排程 prompt 幾乎都是 Markdown（## 標題／清單／表格），先前用 escHtml 塞進 <pre> 連換行都被
// 折疊掉。這裡用平台已全域載入的 window.marked（portal/index.html）渲染，不引入任何新套件。
// 用 scoped CSS（.md-render，注入一次到 <head>）而非逐一補 Tailwind class：marked 產出的標籤
// （h1/ul/table…）數量多、逐個補 class 維護成本高，注入一段 CSS 更貼近這類「渲染第三方 HTML」的作法。
const MD_STYLE_ID = 'sched-md-style';
function ensureMdStyle() {
  if (document.getElementById(MD_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = MD_STYLE_ID;
  style.textContent = `
.md-render{font-size:0.8rem;line-height:1.6;color:#334155;}
.dark .md-render{color:#cbd5e1;}
.md-render h1,.md-render h2,.md-render h3,.md-render h4{font-weight:700;margin:0.6em 0 0.3em;color:#0f172a;}
.dark .md-render h1,.dark .md-render h2,.dark .md-render h3,.dark .md-render h4{color:#f1f5f9;}
.md-render h1{font-size:1.15em;} .md-render h2{font-size:1.08em;} .md-render h3{font-size:1.02em;}
.md-render p{margin:0.4em 0;}
.md-render ul,.md-render ol{margin:0.3em 0 0.3em 1.2em;}
.md-render ul{list-style:disc;} .md-render ol{list-style:decimal;}
.md-render li{margin:0.15em 0;}
.md-render code{background:rgba(148,163,184,0.25);border-radius:3px;padding:0.1em 0.35em;font-family:ui-monospace,monospace;font-size:0.9em;}
.md-render pre{background:rgba(148,163,184,0.15);border-radius:6px;padding:0.6em 0.8em;overflow-x:auto;margin:0.4em 0;}
.md-render pre code{background:none;padding:0;}
.md-render table{border-collapse:collapse;margin:0.4em 0;font-size:0.95em;}
.md-render th,.md-render td{border:1px solid rgba(148,163,184,0.4);padding:0.25em 0.6em;}
.md-render blockquote{border-left:3px solid rgba(148,163,184,0.6);margin:0.4em 0;padding-left:0.7em;color:#64748b;}
.dark .md-render blockquote{color:#94a3b8;}
.md-render a{color:#0891b2;text-decoration:underline;}
.dark .md-render a{color:#22d3ee;}
`;
  document.head.appendChild(style);
}

// 渲染 Markdown → 消毒過的 HTML 字串（外層已包 .md-render）。window.marked 缺席時退回 escHtml 純文字。
function mdToSafeHtml(text) {
  const raw = String(text || '');
  if (!raw) return '';
  let html = null;
  if (window.marked && typeof window.marked.parse === 'function') {
    try { html = window.marked.parse(raw, { breaks: true, mangle: false, headerIds: false }); } catch (e) { html = null; }
  }
  if (html == null) {
    return `<div class="whitespace-pre-wrap">${escHtml(raw)}</div>`;
  }
  // 最小消毒：移除 script/style 節點、所有 on* 屬性、javascript: 開頭的 href/src。
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style').forEach(el => el.remove());
  doc.querySelectorAll('*').forEach(el => {
    Array.from(el.attributes).forEach(attr => {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) { el.removeAttribute(attr.name); return; }
      if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
    });
  });
  ensureMdStyle();
  return `<div class="md-render">${doc.body.innerHTML}</div>`;
}

function mdToggleBtn(actName, rawMode) {
  return `<button data-act="${actName}" class="shrink-0 text-[10px] px-2 py-0.5 rounded border border-slate-300 dark:border-slate-600 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">${rawMode ? '看 Markdown' : '看原始文字'}</button>`;
}

// ── SCHED-TAB / SCHED-PAGE: 頁籤與分頁狀態 ────────────────────────────
// 指揮官的關注順序：排程列表（含順序性，最常看）→ 精華待審 → 近期動態（已完成的事，最少看）。
let activeTab = 'list';
const PAGE = { list: 1, hist: 1, cand: 1, act: 1 };
let listPageSize = 20;
let candCache = [];   // 精華待審全量，前端分頁
let actCache  = [];   // 近期動態全量，前端分頁
const CAND_PAGE_SIZE = 5;
const ACT_PAGE_SIZE  = 10;

// ── KD2: 知識精華收斂——彙整提案檢視狀態 ─────────────────────────────────
// proposal.json 的寫入只發生在 KD4 的「套用」，這裡的 kdRowState 是頁面端的暫存
// 覆蓋層（接受/拒絕/備註），疊在 proposal.rows[].status 之上；KD3 的 rethink 尚未
// 接上前，備註只會把該列標成「等待 Hana 重新思考」，不會真的觸發模型（誠實標註）。
const KD_MODEL_KEY = 'kd-distill-model';
let kdProposal = null;        // GET /api/knowledge-distill/proposal 回傳的 proposal 物件
let kdCompleteness = null;    // 完整性檢查（有無候選未登進任何列）
let kdSummary = null;         // 摘要統計（幾群幾條幾組互斥）
let kdJob = null;             // 目前彙整 job 狀態（輪詢用）
let kdPollTimer = null;
let kdRowState = {};          // rowId -> { status, note }
let kdHkChecked = {};         // housekeeping 項目 index -> boolean（預設不勾）
let kdApplyBusy = false;      // KD4: 套用請求進行中（鎖住按鈕避免重複送出）
let kdCollapsed = {};         // clusterId -> boolean（是否摺疊，預設展開）

function tabBtn(key, label, badgeId) {
  const badge = badgeId
    ? `<span id="${badgeId}" class="hidden ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300"></span>`
    : '';
  return `<button data-act="sched-tab" data-tab="${key}" class="sched-tab relative -mb-px px-4 py-2 text-sm font-semibold border-b-2 border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors">${label}${badge}</button>`;
}

function switchTab(key) {
  activeTab = key;
  container.querySelectorAll('.sched-tab').forEach(btn => {
    const on = btn.getAttribute('data-tab') === key;
    btn.classList.toggle('border-cyan-500', on);
    btn.classList.toggle('text-cyan-600', on);
    btn.classList.toggle('dark:text-cyan-400', on);
    btn.classList.toggle('text-slate-500', !on);
    btn.classList.toggle('dark:text-slate-400', !on);
  });
  ['list', 'cand', 'act'].forEach(k => {
    const pane = container.querySelector('#sched-pane-' + k);
    if (pane) pane.classList.toggle('hidden', k !== key);
  });
  // 表格藏著時 getBoundingClientRect 全是 0，切回來必須重畫串接曲線。
  if (key === 'list') drawChainLinks();
}

// 共用分頁列；onGo(page) 由呼叫端重繪對應區塊。
function pagerHtml(total, page, size, opts) {
  const pages = Math.max(1, Math.ceil(total / size));
  if (total === 0) return '';
  const btn = (p, label, disabled) =>
    `<button data-act="sched-page" data-page="${p}" ${disabled ? 'disabled' : ''} class="px-2 py-1 rounded text-xs ${disabled
      ? 'text-slate-300 dark:text-slate-600 cursor-not-allowed'
      : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}">${label}</button>`;
  const sizeSel = (opts && opts.sizes)
    ? `<select data-act="sched-page-size" class="ml-2 text-[11px] px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300">`
      + opts.sizes.map(n => `<option value="${n}" ${n === size ? 'selected' : ''}>每頁 ${n === Infinity ? '全部' : n}</option>`).join('')
      + `</select>`
    : '';
  const from = (page - 1) * size + 1;
  const to   = Math.min(total, page * size);
  return `<div class="flex items-center justify-between gap-2 pt-3 mt-1">
      <span class="text-[11px] text-slate-400 dark:text-slate-500">第 ${from}–${to} 筆，共 ${total} 筆</span>
      <div class="flex items-center gap-0.5">
        ${btn(1, '«', page <= 1)}${btn(page - 1, '‹', page <= 1)}
        <span class="px-2 text-xs text-slate-500 dark:text-slate-400">${page} / ${pages}</span>
        ${btn(page + 1, '›', page >= pages)}${btn(pages, '»', page >= pages)}
        ${sizeSel}
      </div>
    </div>`;
}

function bindPager(scopeEl, onGo, onSize) {
  scopeEl.querySelectorAll('[data-act="sched-page"]').forEach(b => {
    b.addEventListener('click', ev => { ev.stopPropagation(); if (!b.disabled) onGo(parseInt(b.getAttribute('data-page'), 10)); });
  });
  if (onSize) scopeEl.querySelectorAll('[data-act="sched-page-size"]').forEach(sel => {
    sel.addEventListener('change', ev => { ev.stopPropagation(); onSize(parseInt(sel.value, 10)); });
  });
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// Absolute ISO (stored as UTC) → LOCAL "YYYY-MM-DDTHH:mm" for <input type="datetime-local">.
function isoToLocalInput(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function triggerLabel(t) {
  if (!t) return '—';
  if (t.type === 'cron')     return `Cron: ${t.expr}`;
  if (t.type === 'interval') return `每 ${Math.round((t.intervalMs || 3600000) / 60000)} 分鐘`;
  if (t.type === 'once')     return `單次: ${fmtDate(t.atISO)}`;
  if (t.type === 'manual')   return '手動觸發';
  return t.type;
}

// SCHED-CHAIN: 依 chainNext 把鏈頭→被接者排相鄰；環狀/共享目標的殘餘照原順序補上。
function orderScheduleChains(list) {
  const byId = new Map(list.map(s => [s.id, s]));
  const nextOf = s => { const t = s && s.chainNext; return (t && byId.has(t)) ? t : null; };
  const pointedTo = new Set();
  list.forEach(s => { const t = nextOf(s); if (t) pointedTo.add(t); });
  const visited = new Set(); const out = [];
  const walk = startId => {
    let cur = startId;
    while (cur && byId.has(cur) && !visited.has(cur)) {
      visited.add(cur); out.push(byId.get(cur));
      cur = nextOf(byId.get(cur));
    }
  };
  list.forEach(s => { if (!pointedTo.has(s.id)) walk(s.id); });   // 先走鏈頭
  list.forEach(s => { if (!visited.has(s.id)) { visited.add(s.id); out.push(s); } });
  return out;
}

// SBA-1: 以 chainNext 建「無向連通分量」——勾一筆要把整條鏈（上游＋下游）都帶出來，不只下游。
// 用 union-find：容忍環狀（union 到同根就是 no-op）、容忍多筆指向同一目標（自然合併進同一組）。
// 只在傳入的 list（已過工作區過濾、且屬同一張表——現役或歷史）內計算，回傳 id -> 同組 id 陣列。
function schedChainGroups(list) {
  const byId = new Map(list.map(s => [s.id, s]));
  const parent = new Map(list.map(s => [s.id, s.id]));
  const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  list.forEach(s => { const t = s.chainNext; if (t && byId.has(t)) union(s.id, t); });
  const buckets = new Map();
  list.forEach(s => { const r = find(s.id); if (!buckets.has(r)) buckets.set(r, []); buckets.get(r).push(s.id); });
  const groups = new Map();
  list.forEach(s => groups.set(s.id, buckets.get(find(s.id))));
  return groups;
}

// 從「真的點過」的 explicit 集合 derive 出連動後的完整集合（每個 explicit id 所屬整條鏈全部成員）。
function schedRecomputeSelected(tableKey) {
  const groups = schedChainGroupsByTable[tableKey];
  const result = new Set();
  schedSelectedExplicit[tableKey].forEach(id => {
    const g = groups.get(id) || [id];
    g.forEach(x => result.add(x));
  });
  schedSelected[tableKey] = result;
}

// SCHED-CHAIN: 在每個表格左側走線槽用 SVG 曲線＋箭頭，把 source row 連到它的 chainNext row。
function drawChainLinks() {
  const dark = document.documentElement.classList.contains('dark');
  const stroke = dark ? '#22d3ee' : '#0891b2';
  container.querySelectorAll('#sched-list-content .chain-wrap').forEach(wrap => {
    const svg = wrap.querySelector('svg.chain-links');
    if (!svg) return;
    const wrapRect = wrap.getBoundingClientRect();
    const rows = Array.from(wrap.querySelectorAll('tr[data-sched-id]'));
    const byId = {}; rows.forEach(r => { byId[r.getAttribute('data-sched-id')] = r; });
    let paths = '';
    rows.forEach(src => {
      const tid = src.getAttribute('data-chain-next');
      if (!tid) return;
      const tgt = byId[tid];
      if (!tgt) return;   // 目標不在本表（如跨現役/歷史）→ 不畫線
      const sr = src.getBoundingClientRect();
      const tr = tgt.getBoundingClientRect();
      const gx = 22, bx = 4;                          // 靠表格左緣 / 曲線最左凸點
      const y0 = sr.top - wrapRect.top + sr.height / 2;
      const y1 = tr.top - wrapRect.top + tr.height / 2;
      paths += `<circle cx="${gx}" cy="${y0}" r="2.4" fill="${stroke}"/>`;
      paths += `<path d="M ${gx} ${y0} C ${bx} ${y0}, ${bx} ${y1}, ${gx} ${y1}" fill="none" stroke="${stroke}" stroke-width="1.6" marker-end="url(#chain-arrow)" opacity="0.9"/>`;
    });
    svg.innerHTML = paths
      ? `<defs><marker id="chain-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${stroke}"/></marker></defs>${paths}`
      : '';
  });
}

function onResizeRedrawChains() {
  const v = container && container.querySelector('#sched-list-view');
  if (v && !v.classList.contains('hidden')) drawChainLinks();
}

// SCHED-DEPLOY D1/Z6: 「佈署」欄——鏈尾 postRun.deploy=true 顯示 badge、鏈中途顯示「串接中」、其餘「—」。
// lastDeployStatus==='failed' 在 badge 後加 ⚠（tooltip 帶 lastDeployAt）。
function deployCell(s) {
  if (s.chainNext) {
    return `<span class="text-xs text-slate-400 dark:text-slate-500" title="有接續排程，佈署只能設在最後一棒">串接中</span>`;
  }
  if (s.postRun && s.postRun.deploy === true) {
    const failed = s.lastDeployStatus === 'failed';
    const title = s.lastDeployAt ? `上次佈署：${fmtDate(s.lastDeployAt)}（${s.lastDeployStatus || '—'}）` : '尚未佈署過';
    // inline-block + whitespace-nowrap：欄位被擠窄時 badge 曾被拆成「⬆／佈／署」直排。
    return `<span class="inline-block whitespace-nowrap px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" title="${escHtml(title)}">⬆ 佈署${failed ? ' ⚠' : ''}</span>`;
  }
  return `<span class="text-slate-300 dark:text-slate-600 text-xs">—</span>`;
}

// SBA-4: 批量工具列——有選取時顯示「已選 N 筆」＋主按鈕＋清除選取；無選取時整列隱藏（不佔版面）。
function schedToolbarHtml(tableKey, hist) {
  const n = schedSelected[tableKey].size;
  const mainAct = hist ? 'batch-restore' : 'batch-archive';
  const mainLabel = hist ? '↩ 批量復原' : '📥 批量歸檔';
  return `
    <div id="sched-toolbar-${tableKey}" class="flex items-center gap-2 mb-2 px-1 ${n ? '' : 'hidden'}">
      <span class="text-xs font-semibold text-slate-600 dark:text-slate-300">已選 ${n} 筆</span>
      <button data-act="${mainAct}" data-table="${tableKey}" class="px-2.5 py-1 rounded-lg text-xs font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 hover:opacity-80 transition-opacity">${mainLabel}</button>
      <button data-act="batch-clear" data-table="${tableKey}" class="px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400 hover:opacity-80 transition-opacity">清除選取</button>
    </div>`;
}

async function schedLoadList() {
  const listEl = container.querySelector('#sched-list-content');
  if (!listEl) return;
  try {
    const all = await (await fetch('/api/schedules')).json();
    refreshSchedBadge();   // 清單載入＝排程資料可能剛變動（啟停/觸發/刪除/歸檔都會回頭叫這裡）
    if (!all.length) {
      listEl.innerHTML = '<div class="text-center py-16 text-slate-400 dark:text-slate-500 text-sm">尚無排程。點「+ 新增排程」建立第一個。</div>';
      schedSelectedExplicit = { list: new Set(), hist: new Set() };
      schedSelected = { list: new Set(), hist: new Set() };
      return;
    }
    const nameById = {}; all.forEach(s => { nameById[s.id] = s.name; });
    // SCHED-CHAIN: 把串接的排程排在一起（鏈頭→被接者相鄰），清單才看得出接續關係。
    const active  = orderScheduleChains(all.filter(s => !s.archived));
    const history = orderScheduleChains(all.filter(s => s.archived));

    // SBA-1/SBA-2: 每次重繪都重新計算該表（現役／歷史各自獨立）的鏈分組與全量 id/物件表，
    // 並把 explicit 選取中已不存在的 id 剔除、重新 derive 完整連動集合——SSE 重繪後選取盡量保留。
    schedByIdTable.list = new Map(active.map(s => [s.id, s]));
    schedByIdTable.hist = new Map(history.map(s => [s.id, s]));
    schedAllIdsTable.list = active.map(s => s.id);
    schedAllIdsTable.hist = history.map(s => s.id);
    schedChainGroupsByTable.list = schedChainGroups(active);
    schedChainGroupsByTable.hist = schedChainGroups(history);
    ['list', 'hist'].forEach(tk => {
      const alive = schedByIdTable[tk];
      Array.from(schedSelectedExplicit[tk]).forEach(id => { if (!alive.has(id)) schedSelectedExplicit[tk].delete(id); });
      schedRecomputeSelected(tk);
    });

    const row = (s, hist) => {
      const tk = hist ? 'hist' : 'list';
      const checked = schedSelected[tk].has(s.id);
      const brought = checked && !schedSelectedExplicit[tk].has(s.id); // SBA-3: 被串接連動帶入、非指揮官本人點選
      return `
      <tr data-sched-id="${s.id}" data-chain-next="${(s.chainNext && nameById[s.chainNext]) ? s.chainNext : ''}" class="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors cursor-pointer ${brought ? 'bg-cyan-50/60 dark:bg-cyan-900/10' : ''}" data-act="open-detail" data-id="${s.id}">
        <td class="px-2 py-3 text-center" data-act="stop-prop">
          <input type="checkbox" data-sched-check data-table="${tk}" data-id="${s.id}" ${checked ? 'checked' : ''} class="accent-cyan-600 align-middle">
          ${brought ? '<span class="block text-[9px] leading-none text-cyan-600 dark:text-cyan-400 mt-0.5" title="因串接連動自動帶入">串</span>' : ''}
        </td>
        <td class="px-3 py-3 font-medium text-slate-900 dark:text-white min-w-[12rem]">${escHtml(s.name)}</td>
        <td class="px-3 py-3 text-slate-500 dark:text-slate-400 font-mono text-xs whitespace-nowrap">${escHtml(triggerLabel(s.trigger))}</td>
        <td class="px-3 py-3 text-slate-500 dark:text-slate-400 text-xs whitespace-nowrap">${escHtml(s.model || '')}</td>
        <td class="px-3 py-3 text-slate-500 dark:text-slate-400 text-xs whitespace-nowrap">${hist ? fmtDate(s.lastRunAt) : fmtDate(s.nextRunAt)}</td>
        <td class="px-3 py-3 whitespace-nowrap">
          ${s.running
            ? `<div class="flex flex-col gap-0.5">
                 <div class="flex items-center gap-1.5">
                   <span class="px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_BADGE.running} inline-flex items-center gap-1 w-fit"><span class="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>執行中</span>
                   <button data-act="abort-now" data-id="${s.id}" title="🛑 中止（只會叫停，不會還原已做過的事）" class="px-1.5 py-0.5 rounded text-xs bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400 hover:opacity-80">🛑 停止</button>
                 </div>
                 <span class="text-[10px] text-slate-400 dark:text-slate-500">${fmtDate(s.running.startedAt)} 起 · ${s.running.trigger === 'manual' ? '手動' : '自動'}</span>
               </div>`
            : (s.lastRunStatus ? `<span class="px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_BADGE[s.lastRunStatus] || ''}">${STATUS_LABEL[s.lastRunStatus] || s.lastRunStatus}</span>` : '<span class="text-slate-400 text-xs">尚未執行</span>')}
        </td>
        <td class="px-3 py-3 whitespace-nowrap">${deployCell(s)}</td>
        <td class="px-3 py-3" data-act="stop-prop">
          <button data-act="toggle" data-id="${s.id}" data-enabled="${!s.enabled}" class="px-2 py-0.5 rounded-full text-xs font-semibold ${s.enabled ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-400'}">
            ${s.enabled ? '啟用' : '停用'}
          </button>
        </td>
        <td class="px-3 py-3 whitespace-nowrap" data-act="stop-prop">
          ${hist
            ? `<button data-act="archive" data-id="${s.id}" data-archived="false" class="mr-1 px-2 py-0.5 rounded text-xs bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300 hover:opacity-80" title="復原為現役">↩ 復原</button>`
            : `${s.running
                 ? `<button disabled class="mr-1 px-2 py-0.5 rounded text-xs bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-600 cursor-not-allowed" title="執行中，無法重複觸發">▶ 執行中</button>`
                 : `<button data-act="trigger-now" data-id="${s.id}" class="mr-1 px-2 py-0.5 rounded text-xs bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400 hover:opacity-80 transition-opacity" title="立即執行一次">▶ 立即</button>`}
               <button data-act="edit" data-id="${s.id}" class="mr-1 px-2 py-0.5 rounded text-xs bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300 hover:opacity-80">編輯</button>
               <button data-act="archive" data-id="${s.id}" data-archived="true" class="mr-1 px-2 py-0.5 rounded text-xs bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 hover:opacity-80" title="歸檔到歷史（並停用）">📥 歸檔</button>`}
          <button data-act="delete" data-id="${s.id}" class="px-2 py-0.5 rounded text-xs bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400 hover:opacity-80">刪除</button>
        </td>
      </tr>`;
    };
    // SBA-2: 表頭全選——checked 代表「該表全部 id（不只當頁）都在完整選取集合內」，部分選取時給 indeterminate（見下方套用處）。
    const tableWrap = (rows, nextLabel, tk) => {
      const allIds = schedAllIdsTable[tk];
      const allSelected = allIds.length > 0 && allIds.every(id => schedSelected[tk].has(id));
      return `
     <div class="chain-wrap relative pl-6">
      <svg class="chain-links pointer-events-none absolute inset-0 w-full h-full z-20 overflow-visible"></svg>
      <div class="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700/60 shadow-sm">
        <table class="w-full text-sm">
          <thead class="bg-slate-100/60 dark:bg-slate-800/60">
            <tr class="text-left text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              <th class="px-2 py-3 text-center"><input type="checkbox" data-sched-check-all data-table="${tk}" ${allSelected ? 'checked' : ''} class="accent-cyan-600 align-middle"></th>
              <th class="px-3 py-3">名稱</th><th class="px-3 py-3">觸發</th><th class="px-3 py-3">模型</th>
              <th class="px-3 py-3 whitespace-nowrap">${nextLabel}</th><th class="px-3 py-3 whitespace-nowrap">最近狀態</th><th class="px-3 py-3">佈署</th><th class="px-3 py-3">啟用</th><th class="px-3 py-3">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-200 dark:divide-slate-700/50">${rows}</tbody>
        </table>
      </div>
     </div>`;
    };
    // SCHED-PAGE: 表很長，現役／歷史各自分頁（鏈順序已先算好，切頁只是取窗格）。
    const pageOf = (arr, page, size) => {
      const pages = Math.max(1, Math.ceil(arr.length / size));
      const p = Math.min(Math.max(1, page), pages);
      return { p, items: arr.slice((p - 1) * size, p * size) };
    };
    const act = pageOf(active, PAGE.list, listPageSize);   PAGE.list = act.p;
    const his = pageOf(history, PAGE.hist, listPageSize);  PAGE.hist = his.p;

    let html = active.length
      ? schedToolbarHtml('list', false)
        + tableWrap(act.items.map(s => row(s, false)).join(''), '下次執行', 'list')
        + `<div data-pager="list">${pagerHtml(active.length, PAGE.list, listPageSize, { sizes: [10, 20, 50, 100] })}</div>`
      : '<div class="text-center py-10 text-slate-400 dark:text-slate-500 text-sm">目前沒有現役排程。</div>';
    if (history.length) {
      // 不強制收合：若指揮官手動展開過（不是靠分頁跳到第 2 頁），SSE/輪詢觸發的重繪不該把它收回去。
      const prevHistDetails = listEl.querySelector('details');
      const histWasOpen = !!(prevHistDetails && prevHistDetails.open);
      html += `
        <details class="mt-4 group" ${(PAGE.hist > 1 || histWasOpen) ? 'open' : ''}>
          <summary class="cursor-pointer select-none px-1 py-2 text-xs font-semibold text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
            <i data-lucide="chevron-right" class="h-3.5 w-3.5 transition-transform group-open:rotate-90"></i>📜 歷史（已歸檔 ${history.length}）
          </summary>
          <div class="mt-2 opacity-80">${schedToolbarHtml('hist', true)}${tableWrap(his.items.map(s => row(s, true)).join(''), '上次執行', 'hist')}
            <div data-pager="hist">${pagerHtml(history.length, PAGE.hist, listPageSize, null)}</div>
          </div>
        </details>`;
    }
    listEl.innerHTML = html;
    bindListActions(listEl);
    // indeterminate 只能用 JS 屬性設，HTML 字串做不到——部分選取時給表頭 checkbox 一個「半勾」視覺。
    ['list', 'hist'].forEach(tk => {
      const cb = listEl.querySelector(`[data-sched-check-all][data-table="${tk}"]`);
      if (cb) cb.indeterminate = schedSelected[tk].size > 0 && schedSelected[tk].size < schedAllIdsTable[tk].length;
    });
    const listPagerEl = listEl.querySelector('[data-pager="list"]');
    if (listPagerEl) bindPager(listPagerEl,
      p => { PAGE.list = p; schedLoadList(); },
      n => { listPageSize = n; PAGE.list = 1; PAGE.hist = 1; schedLoadList(); });
    const histPagerEl = listEl.querySelector('[data-pager="hist"]');
    if (histPagerEl) bindPager(histPagerEl, p => { PAGE.hist = p; schedLoadList(); }, null);
    if (typeof lucide !== 'undefined') lucide.createIcons();
    if (activeTab === 'list') drawChainLinks();  // SCHED-CHAIN: 在左側走線槽畫出「A 成功→接 B」的箭頭曲線（藏著時量不到座標）
    // SCHED-14: 若有排程執行中，15s 後自動刷新一次（執行中徽章/按鈕會在完成後自動恢復）；清單不在畫面上就不刷。
    clearTimeout(schedRefreshTimer);
    if (active.some(s => s.running)) {
      schedRefreshTimer = setTimeout(() => {
        const v = container && container.querySelector('#sched-list-view');
        if (v && !v.classList.contains('hidden')) schedLoadList();
      }, 15000);
    }
  } catch (e) {
    listEl.innerHTML = `<div class="text-red-500 text-sm">載入失敗：${e.message}</div>`;
  }
}

function bindListActions(listEl) {
  listEl.querySelectorAll('[data-act="stop-prop"]').forEach(el => el.addEventListener('click', ev => ev.stopPropagation()));
  listEl.querySelectorAll('[data-act="open-detail"]').forEach(el => el.addEventListener('click', () => schedOpenDetail(el.getAttribute('data-id'))));
  listEl.querySelectorAll('[data-act="toggle"]').forEach(el => el.addEventListener('click', ev => { ev.stopPropagation(); schedToggle(el.getAttribute('data-id'), el.getAttribute('data-enabled') === 'true'); }));
  listEl.querySelectorAll('[data-act="archive"]').forEach(el => el.addEventListener('click', ev => { ev.stopPropagation(); schedArchive(el.getAttribute('data-id'), el.getAttribute('data-archived') === 'true'); }));
  listEl.querySelectorAll('[data-act="trigger-now"]').forEach(el => el.addEventListener('click', ev => { ev.stopPropagation(); schedTriggerNow(el.getAttribute('data-id')); }));
  listEl.querySelectorAll('[data-act="abort-now"]').forEach(el => el.addEventListener('click', ev => { ev.stopPropagation(); schedAbortNow(el.getAttribute('data-id')); }));
  listEl.querySelectorAll('[data-act="edit"]').forEach(el => el.addEventListener('click', ev => { ev.stopPropagation(); schedEdit(el.getAttribute('data-id')); }));
  listEl.querySelectorAll('[data-act="delete"]').forEach(el => el.addEventListener('click', ev => { ev.stopPropagation(); schedDelete(el.getAttribute('data-id')); }));
  // SBA-2/3: 勾選框——點擊不觸發列的 open-detail（已包在 data-act="stop-prop" 的 td 裡）；
  // change 事件依 explicit 集合重新 derive 連動後的完整集合，再重繪（保留捲動位置，避免跳回頂端）。
  listEl.querySelectorAll('[data-sched-check]').forEach(cb => cb.addEventListener('change', () => {
    const tk = cb.getAttribute('data-table');
    const id = cb.getAttribute('data-id');
    if (cb.checked) schedSelectedExplicit[tk].add(id); else schedSelectedExplicit[tk].delete(id);
    schedRecomputeSelected(tk);
    schedRerenderKeepScroll();
  }));
  listEl.querySelectorAll('[data-sched-check-all]').forEach(cb => cb.addEventListener('change', () => {
    const tk = cb.getAttribute('data-table');
    if (cb.checked) schedAllIdsTable[tk].forEach(id => schedSelectedExplicit[tk].add(id));
    else schedSelectedExplicit[tk] = new Set();
    schedRecomputeSelected(tk);
    schedRerenderKeepScroll();
  }));
  listEl.querySelectorAll('[data-act="batch-clear"]').forEach(btn => btn.addEventListener('click', () => {
    const tk = btn.getAttribute('data-table');
    schedSelectedExplicit[tk] = new Set();
    schedRecomputeSelected(tk);
    schedRerenderKeepScroll();
  }));
  listEl.querySelectorAll('[data-act="batch-archive"]').forEach(btn => btn.addEventListener('click', () => schedOpenBatchConfirm('list')));
  listEl.querySelectorAll('[data-act="batch-restore"]').forEach(btn => btn.addEventListener('click', () => schedOpenBatchConfirm('hist')));
}

// 勾選/全選/清除選取只是本地狀態變動，重繪整張表仍會重打 schedLoadList()（沿用既有「每次改動都整表重載」
// 的簡單寫法），但保留捲動位置，避免每點一次就被彈回頂端。
function schedRerenderKeepScroll() {
  const scrollY = window.scrollY;
  Promise.resolve(schedLoadList()).then(() => window.scrollTo(0, scrollY));
}

// Archive a schedule to「歷史」(also pause it) / restore it back to active.
async function schedArchive(id, archived) {
  const body = archived ? { archived: true, enabled: false } : { archived: false };
  try {
    await fetch(`/api/schedules/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    schedLoadList();
  } catch (e) { window.showToast && window.showToast('歸檔失敗：' + e.message, 'error'); }
}

// SBA-5: 算出批量歸檔/復原要用的四個分類——原本點選、因串接帶入、執行中跳過、尚未成功執行過（僅提示）。
function schedBatchPlan(tableKey) {
  const byId = schedByIdTable[tableKey];
  const explicitIds = Array.from(schedSelectedExplicit[tableKey]);
  const fullIds = Array.from(schedSelected[tableKey]);
  const isRunning = id => { const s = byId.get(id); return !!(s && s.running); };
  const runningIds = fullIds.filter(isRunning);
  const execIds = fullIds.filter(id => !isRunning(id));             // 真正會送出 PUT 的 id（連動帶入 + 原本點選，排除執行中）
  const execOnlyOriginal = explicitIds.filter(id => !isRunning(id)); // 「只歸檔／復原我原本點選的」版本
  const broughtIds = execIds.filter(id => !schedSelectedExplicit[tableKey].has(id));
  // 「尚未成功執行過」沒有獨立欄位可查，用 lastRunStatus 近似：從未跑過或最近一次不是 success 都算，
  // 僅供指揮官判斷參考（SBA-5 規則：不禁止歸檔，只標註），不影響 execIds 的計算。
  const neverSucceededIds = execIds.filter(id => { const s = byId.get(id); return s && s.lastRunStatus !== 'success'; });
  return { byId, explicitIds, fullIds, runningIds, execIds, execOnlyOriginal, broughtIds, neverSucceededIds };
}

function schedNameList(byId, ids) {
  if (!ids.length) return '（無）';
  return ids.map(id => escHtml((byId.get(id) && byId.get(id).name) || id)).join('、');
}

// SBA-5: 確認摘要彈窗——沿用 #sched-modal 的 fixed/backdrop 寫法，動態建立/移除，不佔用既有編輯表單的 DOM。
function schedOpenBatchConfirm(tableKey) {
  if (schedBatchBusy) return;
  const archiving = tableKey === 'list';
  const plan = schedBatchPlan(tableKey);
  if (!plan.fullIds.length) return;
  const existing = document.getElementById('sched-batch-modal');
  if (existing) existing.remove();
  const verb = archiving ? '歸檔' : '復原';
  const modal = document.createElement('div');
  modal.id = 'sched-batch-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm';
  modal.innerHTML = `
    <div class="w-full max-w-lg mx-4 rounded-xl bg-white dark:bg-slate-800 shadow-xl p-5 max-h-[85vh] overflow-y-auto">
      <h3 class="text-base font-bold text-slate-900 dark:text-white mb-3">批量${verb}確認</h3>
      <div class="space-y-3 text-sm text-slate-700 dark:text-slate-200">
        <div>即將${verb} <b>${plan.execIds.length}</b> 筆：</div>
        <div class="pl-3 border-l-2 border-slate-200 dark:border-slate-600">
          <div class="text-xs text-slate-400 mb-0.5">你原本點選的 ${plan.execOnlyOriginal.length} 筆</div>
          <div class="text-xs">${schedNameList(plan.byId, plan.execOnlyOriginal)}</div>
        </div>
        ${plan.broughtIds.length ? `
        <div class="pl-3 border-l-2 border-cyan-300 dark:border-cyan-700">
          <div class="text-xs text-cyan-600 dark:text-cyan-400 mb-0.5">因串接被一併帶入的 ${plan.broughtIds.length} 筆</div>
          <div class="text-xs">${schedNameList(plan.byId, plan.broughtIds)}</div>
        </div>` : ''}
        ${plan.runningIds.length ? `
        <div class="pl-3 border-l-2 border-amber-300 dark:border-amber-700">
          <div class="text-xs text-amber-600 dark:text-amber-400 mb-0.5">執行中、將自動跳過的 ${plan.runningIds.length} 筆</div>
          <div class="text-xs">${schedNameList(plan.byId, plan.runningIds)}</div>
        </div>` : ''}
        ${plan.neverSucceededIds.length ? `
        <div class="pl-3 border-l-2 border-slate-200 dark:border-slate-600">
          <div class="text-xs text-slate-400 mb-0.5">尚未成功執行過（僅提示，不阻擋 ${verb}）：${plan.neverSucceededIds.length} 筆</div>
          <div class="text-xs">${schedNameList(plan.byId, plan.neverSucceededIds)}</div>
        </div>` : ''}
      </div>
      <div class="flex flex-wrap justify-end gap-2 mt-5">
        <button data-act="batch-cancel" class="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:opacity-80">取消</button>
        ${plan.broughtIds.length ? `<button data-act="batch-only-original" class="px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-200 dark:bg-slate-600 text-slate-700 dark:text-slate-100 hover:opacity-80">只${verb}我原本點選的</button>` : ''}
        <button data-act="batch-confirm" class="px-3 py-1.5 rounded-lg text-xs font-semibold bg-cyan-600 hover:bg-cyan-700 text-white">確認${verb}</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.addEventListener('click', ev => { if (ev.target === modal) close(); });
  modal.querySelector('[data-act="batch-cancel"]').addEventListener('click', close);
  const onlyBtn = modal.querySelector('[data-act="batch-only-original"]');
  if (onlyBtn) onlyBtn.addEventListener('click', () => { close(); schedExecuteBatch(tableKey, plan.execOnlyOriginal, archiving); });
  modal.querySelector('[data-act="batch-confirm"]').addEventListener('click', () => { close(); schedExecuteBatch(tableKey, plan.execIds, archiving); });
}

// SBA-6: 小並發 4 筆逐筆呼叫既有 PUT /api/schedules/:id，任一筆失敗不中斷其餘。
async function schedExecuteBatch(tableKey, ids, archiving) {
  if (!ids.length) { window.showToast && window.showToast('沒有可執行的項目（可能全部執行中）', 'info'); return; }
  schedBatchBusy = true;
  const body = archiving ? { archived: true, enabled: false } : { archived: false };
  const results = { success: [], failed: [] };
  let idx = 0;
  const worker = async () => {
    while (idx < ids.length) {
      const id = ids[idx++];
      try {
        const r = await fetch(`/api/schedules/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (r.ok) results.success.push(id); else results.failed.push(id);
      } catch (e) { results.failed.push(id); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
  schedBatchBusy = false;
  const byId = schedByIdTable[tableKey];
  schedSelectedExplicit[tableKey] = new Set();
  schedSelected[tableKey] = new Set();
  const failedNames = results.failed.map(id => (byId.get(id) && byId.get(id).name) || id).join('、');
  const msg = `成功 ${results.success.length} 筆` + (results.failed.length ? `、失敗 ${results.failed.length} 筆（${failedNames}）` : '');
  window.showToast && window.showToast(msg, results.failed.length ? 'error' : 'success');
  schedLoadList();
}

let _schedCurrentDetailId = null; // H3: track which schedule is in detail view
let schedDetailRaw = '';       // SCH-MDP: 目前詳情頁 prompt 的原文（切換時就地重繪，不重打 API）
let schedDetailRawMode = false; // false=Markdown 渲染（預設），true=原始文字

function renderSchedDetailPrompt() {
  const box = container.querySelector('#sched-detail-prompt-box');
  if (!box) return;
  const btn = container.querySelector('[data-act="sched-detail-md-toggle"]');
  if (btn) btn.textContent = schedDetailRawMode ? '看 Markdown' : '看原始文字';
  box.innerHTML = schedDetailRawMode
    ? `<pre class="whitespace-pre-wrap font-mono">${escHtml(schedDetailRaw)}</pre>`
    : (mdToSafeHtml(schedDetailRaw) || '<span class="text-slate-400">（無 prompt）</span>');
}

async function schedOpenDetail(id) {
  _schedCurrentDetailId = id; // H3: remember for transcript-clear action
  container.querySelector('#sched-list-view').classList.add('hidden');
  container.querySelector('#sched-detail-view').classList.remove('hidden');
  const s = await (await fetch(`/api/schedules/${id}`)).json();
  container.querySelector('#sched-detail-name').textContent = s.name;
  const badge = container.querySelector('#sched-detail-status-badge');
  if (s.lastRunStatus) {
    badge.textContent = STATUS_LABEL[s.lastRunStatus] || s.lastRunStatus;
    badge.className = `px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_BADGE[s.lastRunStatus] || ''}`;
    badge.classList.remove('hidden');
  } else { badge.classList.add('hidden'); }
  schedDetailRaw = (s.task && s.task.prompt) || '';
  schedDetailRawMode = false; // 每次開新詳情都回到預設的 Markdown 檢視
  container.querySelector('#sched-detail-meta').innerHTML = `
    <div>觸發：<span class="font-mono">${escHtml(triggerLabel(s.trigger))}</span></div>
    <div>模型：${escHtml(s.model)}</div>
    <div>下次執行：${fmtDate(s.nextRunAt)}</div>
    <div>上次執行：${fmtDate(s.lastRunAt)}</div>
    <div class="mt-2">
      <div class="flex items-center justify-between mb-1">
        <span class="text-[10px] font-semibold text-slate-400 uppercase">Prompt</span>
        ${mdToggleBtn('sched-detail-md-toggle', schedDetailRawMode)}
      </div>
      <div id="sched-detail-prompt-box" class="text-xs bg-slate-100 dark:bg-slate-800/40 rounded p-2 max-h-[60vh] overflow-y-auto"></div>
    </div>`;
  renderSchedDetailPrompt();
  const toggleBtn = container.querySelector('[data-act="sched-detail-md-toggle"]');
  if (toggleBtn) toggleBtn.addEventListener('click', () => { schedDetailRawMode = !schedDetailRawMode; renderSchedDetailPrompt(); });

  const runsEl = container.querySelector('#sched-runs-list');
  try {
    const runs = await (await fetch(`/api/schedules/${id}/runs`)).json();
    if (!runs.length) {
      runsEl.innerHTML = '<div class="text-slate-400 text-sm py-4">尚無執行紀錄。</div>';
    } else {
      runsEl.innerHTML = runs.map(r => `
        <div class="flex items-center gap-3 px-4 py-3 rounded-xl mb-2 bg-white dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700/50 shadow-sm hover:bg-slate-50 dark:hover:bg-slate-800/80 transition-colors cursor-pointer" data-act="open-run" data-sched-id="${s.id}" data-run-id="${r.id}">
          <span class="px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_BADGE[r.status] || 'bg-slate-200 text-slate-500'}">${r.status}</span>
          <span class="text-xs text-slate-600 dark:text-slate-300">${fmtDate(r.startedAt)}</span>
          <span class="text-xs text-slate-400">${r.usage && r.usage.runtimeMs ? Math.round(r.usage.runtimeMs/1000) + 's' : ''}</span>
          ${r.artifactIds && r.artifactIds.length ? `<span class="ml-auto text-xs text-cyan-600 dark:text-cyan-400">📄 ${r.artifactIds.length} 產出</span>` : ''}
        </div>`).join('');
      runsEl.querySelectorAll('[data-act="open-run"]').forEach(el => el.addEventListener('click', () => schedOpenRun(el.getAttribute('data-sched-id'), el.getAttribute('data-run-id'))));
    }
  } catch (e) {
    runsEl.innerHTML = `<div class="text-red-500 text-sm">載入失敗：${e.message}</div>`;
  }
}

// SCH-MDP: 執行內容的 prompt/回覆同樣預設 Markdown 渲染，切換鈕共用一顆（兩欄一起切）。
let schedRunDetailRawMode = false;
let schedRunPromptRaw = '', schedRunReplyRaw = '';
let schedRunPromptNotice = false, schedRunReplyNotice = false; // true=「逐字稿已清理」這類提示訊息，不當 Markdown 解析

function renderSchedRunDetail() {
  const promptEl = container.querySelector('#sched-run-detail-prompt');
  const replyEl  = container.querySelector('#sched-run-detail-reply');
  const btn = container.querySelector('[data-act="sched-run-md-toggle"]');
  if (btn) btn.textContent = schedRunDetailRawMode ? '看 Markdown' : '看原始文字';
  const renderField = (el, raw, isNotice) => {
    if (!el) return;
    if (!raw) { el.innerHTML = ''; return; }
    if (isNotice) { el.innerHTML = `<div class="italic text-slate-400">${escHtml(raw)}</div>`; return; }
    el.innerHTML = schedRunDetailRawMode
      ? `<pre class="whitespace-pre-wrap font-mono">${escHtml(raw)}</pre>`
      : mdToSafeHtml(raw);
  };
  renderField(promptEl, schedRunPromptRaw, schedRunPromptNotice);
  renderField(replyEl, schedRunReplyRaw, schedRunReplyNotice);
}

async function schedOpenRun(schedId, runId) {
  const r = await (await fetch(`/api/runs/${runId}`)).json();
  const el = container.querySelector('#sched-run-detail');
  schedRunDetailRawMode = false;
  schedRunPromptRaw = ''; schedRunReplyRaw = '';
  schedRunPromptNotice = false; schedRunReplyNotice = false;

  // H2: load session JSON (chat_sched_<runId>.json) for prompt + reply.
  // H3: if transcriptCleared flag set or session 404, show "逐字稿已清理".
  if (r.transcriptCleared) {
    schedRunPromptRaw = '（逐字稿已清理）'; schedRunPromptNotice = true;
  } else {
    try {
      const sessRes = await fetch(`/api/chat/history/sched_${runId}`);
      if (sessRes.ok) {
        const sess = await sessRes.json();
        const msgs = sess.messages || [];
        const userMsg = msgs.find(m => m.role === 'user');
        const aiMsg   = msgs.find(m => m.role === 'assistant');
        if (userMsg && userMsg.content) { schedRunPromptRaw = userMsg.content.slice(0, 3000); }
        else { schedRunPromptRaw = '（無 prompt）'; schedRunPromptNotice = true; }
        if (aiMsg && aiMsg.content) { schedRunReplyRaw = aiMsg.content; }
        else { schedRunReplyRaw = '（無回覆）'; schedRunReplyNotice = true; }
      } else {
        schedRunPromptRaw = '（逐字稿已清理）'; schedRunPromptNotice = true;
      }
    } catch (e) {
      schedRunPromptRaw = r.error || '（無法讀取）'; schedRunPromptNotice = true;
    }
  }
  renderSchedRunDetail();
  el.classList.remove('hidden');
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// H3: batch-clear transcripts for the schedule currently in detail view.
async function schedClearTranscriptsDialog() {
  const id = _schedCurrentDetailId;
  if (!id) return;
  const choice = prompt(
    '清理此排程的逐字稿（run 統計保留，清理後點開只顯示「逐字稿已清理」）\n\n' +
    '請選擇：\n  1 — 清理全部\n  數字 — 清理 N 天前（例輸入 30）'
  );
  if (choice === null) return;
  let params;
  if (choice.trim() === '1') {
    if (!confirm('確定清理此排程所有執行紀錄的逐字稿？')) return;
    params = 'all=true';
  } else {
    const days = parseInt(choice.trim(), 10);
    if (isNaN(days) || days <= 0) { alert('請輸入有效的天數（例：30）'); return; }
    if (!confirm(`確定清理 ${days} 天前的逐字稿？`)) return;
    params = `olderThanDays=${days}`;
  }
  try {
    const r = await fetch(`/api/schedules/${id}/runs/transcripts?${params}`, { method: 'DELETE' });
    const d = await r.json();
    if (d.ok) {
      window.showToast(`已清理 ${d.cleared} 筆逐字稿`, 'success');
      container.querySelector('#sched-run-detail').classList.add('hidden');
      schedOpenDetail(id); // reload run list
    } else { window.showToast('清理失敗: ' + (d.error || '未知'), 'error'); }
  } catch (e) { window.showToast('清理失敗: ' + e.message, 'error'); }
}

// H5: load and render memory candidates for current workspace
async function loadCandidates() {
  try {
    const d = await (await fetch('/api/schedules/candidates')).json();
    candCache = (d.candidates || []);
    PAGE.cand = 1;
    renderCandidates();
  } catch (e) { console.warn('[Candidates] load error:', e.message); }
}

function renderCandidates() {
  {
    const all = candCache;
    const cont = container.querySelector('#sched-candidates-content');
    const pagerEl = container.querySelector('#sched-candidates-pager');
    if (!cont) return;
    updateTabBadge('sched-tab-badge-cand', all.length);
    if (!all.length) {
      cont.innerHTML = '<p class="text-xs text-slate-400 dark:text-slate-500 py-1">目前沒有待審的精華。</p>';
      if (pagerEl) pagerEl.innerHTML = '';
      return;
    }
    const pages = Math.max(1, Math.ceil(all.length / CAND_PAGE_SIZE));
    PAGE.cand = Math.min(Math.max(1, PAGE.cand), pages);
    const items = all.slice((PAGE.cand - 1) * CAND_PAGE_SIZE, PAGE.cand * CAND_PAGE_SIZE);
    cont.innerHTML = items.map(item => {
      const c = item.candidate;
      const ts = item.startedAt ? new Date(item.startedAt).toLocaleString('zh-TW', { hour12: false }) : '';
      const BUCKETS = ['MEMORY','USER','AGENT','PERSONA'];
      const opts = BUCKETS.map(b => `<option value="${b}" ${b === (c.bucket||'MEMORY') ? 'selected' : ''}>${b}</option>`).join('');
      return `<div class="flex flex-col gap-1.5 p-3 rounded-lg bg-white dark:bg-slate-800/60 border border-amber-100 dark:border-amber-800/40 shadow-sm" data-cand-sched="${item.scheduleId}" data-cand-run="${item.runId}">
        <div class="flex items-start gap-2">
          <span class="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">${(item.scheduleName||'').slice(0,20)}</span>
          <span class="text-[10px] text-slate-400">${ts}</span>
        </div>
        <div class="text-sm text-slate-700 dark:text-slate-200">${(c.insight||'').replace(/</g,'&lt;')}</div>
        <div class="flex items-center gap-2 mt-1">
          <span class="text-[10px] text-slate-400">建議桶別：</span>
          <select class="sched-cand-bucket text-[11px] px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200">${opts}</select>
          <button data-act="cand-accept" class="px-2.5 py-1 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-[11px] font-semibold transition-colors">採用</button>
          <button data-act="cand-reject" class="px-2.5 py-1 rounded-lg bg-slate-200 hover:bg-red-100 dark:bg-slate-700 dark:hover:bg-red-900/30 text-slate-600 dark:text-slate-300 hover:text-red-600 dark:hover:text-red-400 text-[11px] font-semibold transition-colors">丟棄</button>
        </div>
      </div>`;
    }).join('');
    // Set initial bucket from candidate
    items.forEach(item => {
      const el = cont.querySelector(`[data-cand-sched="${item.scheduleId}"][data-cand-run="${item.runId}"]`);
      if (el) el.dataset.bucket = item.candidate.bucket || 'MEMORY';
    });
    cont.querySelectorAll('.sched-cand-bucket').forEach(sel => {
      sel.addEventListener('change', () => { sel.closest('[data-cand-sched]').dataset.bucket = sel.value; });
    });
    cont.querySelectorAll('[data-act="cand-accept"]').forEach(btn => btn.addEventListener('click', () => candidateReview(btn, 'true')));
    cont.querySelectorAll('[data-act="cand-reject"]').forEach(btn => btn.addEventListener('click', () => candidateReview(btn, 'false')));
    if (pagerEl) {
      pagerEl.innerHTML = pagerHtml(all.length, PAGE.cand, CAND_PAGE_SIZE, null);
      bindPager(pagerEl, p => { PAGE.cand = p; renderCandidates(); }, null);
    }
  }
}

function updateTabBadge(id, count) {
  const el = container && container.querySelector('#' + id);
  if (!el) return;
  el.textContent = count > 99 ? '99+' : String(count);
  el.classList.toggle('hidden', !count);
}

async function candidateReview(btn, acceptedStr) {
  const card = btn.closest('[data-cand-sched]');
  if (!card) return;
  const schedId = card.dataset.candSched;
  const runId   = card.dataset.candRun;
  const bucket  = card.dataset.bucket || 'MEMORY';
  const accepted = acceptedStr === 'true';
  try {
    const r = await fetch(`/api/schedules/${schedId}/runs/${runId}/candidate/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accepted, bucket }),
    });
    const d = await r.json();
    if (d.ok) {
      window.showToast(accepted ? `已採用並寫入 ${bucket} 記憶` : '已丟棄', accepted ? 'success' : 'info');
      candCache = candCache.filter(it => !(it.scheduleId === schedId && it.runId === runId));
      renderCandidates();   // 重繪＝順便更新頁籤數字與分頁（該頁被清空時自動退回上一頁）
    } else { window.showToast('操作失敗: ' + (d.error || ''), 'error'); }
  } catch (e) { window.showToast('操作失敗: ' + e.message, 'error'); }
}

// ── KD2: 知識精華收斂——彙整提案 UI ──────────────────────────────────────

function kdRowStatus(rowId) {
  if (kdRowState[rowId] && kdRowState[rowId].status) return kdRowState[rowId].status;
  const r = (kdProposal && kdProposal.rows || []).find(x => x.id === rowId);
  return (r && r.status) || 'pending';
}

// 互斥雙方「同時被留下」才算未解：兩邊都是 accepted/agreed。任一方被拒絕就算解了。
function kdConflictPairsUnresolved() {
  if (!kdProposal) return [];
  const rows = kdProposal.rows || [];
  const seen = new Set();
  const unresolved = [];
  const kept = s => s === 'accepted' || s === 'agreed';
  for (const r of rows) {
    for (const other of (Array.isArray(r.conflictsWith) ? r.conflictsWith : [])) {
      const key = [r.id, other].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      if (kept(kdRowStatus(r.id)) && kept(kdRowStatus(other))) unresolved.push([r.id, other]);
    }
  }
  return unresolved;
}

function kdInit() {
  try { const saved = localStorage.getItem(KD_MODEL_KEY); if (saved) container.querySelector('#kd-model-select').value = saved; } catch (e) {}
  const sel = container.querySelector('#kd-model-select');
  if (sel) sel.addEventListener('change', () => { try { localStorage.setItem(KD_MODEL_KEY, sel.value); } catch (e) {} });
  container.querySelector('#kd-btn-run').addEventListener('click', kdStartRun);
  kdLoadProposal();
}

async function kdStartRun() {
  const btn = container.querySelector('#kd-btn-run');
  const model = container.querySelector('#kd-model-select').value;
  btn.disabled = true;
  btn.textContent = '彙整中…';
  try {
    const r = await fetch('/api/knowledge-distill/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }),
    });
    const d = await r.json();
    if (!d.ok) {
      window.showToast(d.error || '無法開始彙整', 'error');
      btn.disabled = false; btn.textContent = '🧪 開始彙整';
      return;
    }
    window.showToast('已開始背景彙整（' + model + '）…', 'info');
    kdPollStatus();
  } catch (e) {
    window.showToast('開始彙整失敗: ' + e.message, 'error');
    btn.disabled = false; btn.textContent = '🧪 開始彙整';
  }
}

async function kdPollStatus() {
  clearTimeout(kdPollTimer);
  try {
    const d = await (await fetch('/api/knowledge-distill/status')).json();
    kdJob = d.job || null;
    const line = container.querySelector('#kd-status-line');
    if (line) {
      if (d.running) line.textContent = '執行中…（' + (kdJob && kdJob.model || '') + '）';
      else if (kdJob && kdJob.status === 'failed') line.textContent = '上次彙整失敗：' + (kdJob.error || '未知錯誤');
      else line.textContent = '';
    }
    if (d.running) {
      // KD3: rethink 是背景跑同一顆 distill job，跑的當下把「送出已備註的」鈕鎖住並顯示思考中，
      // 避免指揮官重複送出同一批列。kdProposal 還沒重讀，按鈕的 disabled 狀態純靠 kdJob 判斷。
      if (kdProposal) kdRenderProposalBox();
      kdPollTimer = setTimeout(kdPollStatus, 3000);
      return;
    }
    const btn = container.querySelector('#kd-btn-run');
    if (btn) { btn.disabled = false; btn.textContent = '🧪 開始彙整'; }
    if (kdJob && kdJob.status === 'failed') {
      window.showToast('彙整失敗: ' + (kdJob.error || '未知錯誤'), 'error');
      return;
    }
    if (kdJob) window.showToast(kdJob.mode === 'rethink' ? 'Hana 重新想過了，thread 已更新。' : '彙整完成，已產生提案。', 'success');
    await kdLoadProposal();
  } catch (e) {
    console.warn('[KD] status poll error:', e.message);
  }
}

async function kdLoadProposal() {
  try {
    const d = await (await fetch('/api/knowledge-distill/proposal')).json();
    if (!d.ok) { window.showToast('讀取提案失敗: ' + (d.error || ''), 'error'); return; }
    kdProposal = d.proposal;
    kdCompleteness = d.completeness;
    kdSummary = d.summary;
    kdRowState = {};   // 提案是重跑就整份覆蓋的（spec §3 開頭），本地暫存跟著歸零
    kdHkChecked = {};
    kdRenderSummaryLine();
    kdRenderProposalBox();
  } catch (e) {
    console.warn('[KD] load proposal error:', e.message);
  }
}

function kdRenderSummaryLine() {
  const line = container.querySelector('#kd-summary-line');
  const lastRun = container.querySelector('#kd-last-run');
  if (!line) return;
  if (!kdProposal || !kdSummary) {
    line.textContent = '尚未彙整過，按「🧪 開始彙整」讓 Hana 深度比對目前的精華待審。';
    if (lastRun) lastRun.textContent = '';
    return;
  }
  line.textContent = `本次 ${kdSummary.clusters} 群 ${kdSummary.rows} 條${kdSummary.conflictPairs ? `、${kdSummary.conflictPairs} 組互斥` : ''}（建議收 ${kdSummary.keep} 條、淘汰 ${kdSummary.drop} 條${kdSummary.housekeeping ? `、順手整理 ${kdSummary.housekeeping} 條` : ''}）`;
  if (lastRun) lastRun.textContent = kdSummary.generatedAt ? ('上次彙整：' + fmtDate(kdSummary.generatedAt)) : '';
}

function kdRowSourcesText(r) {
  return (Array.isArray(r.sources) ? r.sources : [])
    .map(s => `${escHtml(s.scheduleName || s.scheduleId || '')}${s.part && s.part !== '全部' ? `（${escHtml(s.part)}）` : ''}`)
    .join('、') || '—';
}

function kdRowInsightText(r) {
  return (Array.isArray(r.sources) ? r.sources : []).map(s => s.insight).filter(Boolean).join(' / ');
}

function kdThreadHtml(r) {
  const thread = Array.isArray(r.thread) ? r.thread : [];
  if (!thread.length) return '';
  return '<div class="kd-thread mt-2 pl-2 border-l-2 border-slate-200 dark:border-slate-700 space-y-1.5">'
    + thread.map(t => {
        if (t.by === 'commander') {
          return `<div class="text-xs"><span class="font-semibold text-slate-500 dark:text-slate-400">🧑‍✈️ 指揮官：</span><span class="text-slate-600 dark:text-slate-300">${escHtml(t.text)}</span></div>`;
        }
        const outcomeTag = t.outcome === 'agree'
          ? '<span class="text-cyan-600 dark:text-cyan-400 font-semibold">同意</span>'
          : t.outcome === 'dispute' ? '<span class="text-amber-600 dark:text-amber-400 font-semibold">仍有疑慮</span>' : '';
        return `<div class="text-xs"><span class="font-semibold text-slate-500 dark:text-slate-400">🌸 Hana（${escHtml(t.model || '')}）：</span>${outcomeTag} <span class="text-slate-600 dark:text-slate-300">${escHtml(t.text)}</span>${t.newText ? `<div class="mt-0.5 pl-3 text-cyan-700 dark:text-cyan-400">→ 修正後：${escHtml(t.newText)}</div>` : ''}</div>`;
      }).join('')
    + (thread.length >= 3 ? '<div class="text-[10px] font-semibold text-amber-600 dark:text-amber-400">⟳ 已往返 ' + thread.length + ' 輪，尚未收斂</div>' : '')
    + '</div>';
}

function kdRowHtml(r) {
  const status = kdRowStatus(r.id);
  const conflicts = Array.isArray(r.conflictsWith) ? r.conflictsWith : [];
  const unresolvedIds = new Set(kdConflictPairsUnresolved().flat());
  const isConflictLive = conflicts.length && unresolvedIds.has(r.id);
  const badge = KD_VERDICT_BADGE[r.verdict] || KD_VERDICT_BADGE.duplicate;
  const label = KD_VERDICT_LABEL[r.verdict] || r.verdict || '';
  const op = r.op || {};
  return `<div class="p-3 rounded-lg border ${isConflictLive ? 'border-red-400 dark:border-red-600 bg-red-50/50 dark:bg-red-900/10' : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/60'}" data-kd-row="${r.id}">
    ${isConflictLive ? `<div class="text-[10px] font-semibold text-red-600 dark:text-red-400 mb-1">⚠ 與第 ${escHtml(conflicts.join('、'))} 條互斥——同時留下會被鎖住</div>` : ''}
    <div class="flex flex-wrap items-center gap-2">
      <span class="px-1.5 py-0.5 rounded text-[10px] font-semibold ${badge}">${label}</span>
      <span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-300">→ ${escHtml(op.action === 'none' ? '不寫入' : (r.bucket || ''))}</span>
      <span class="text-[10px] text-slate-400 dark:text-slate-500">${KD_STATUS_LABEL[status] || status}</span>
    </div>
    <div class="text-[11px] text-slate-400 dark:text-slate-500 mt-1">來源：${kdRowSourcesText(r)}</div>
    <div class="text-xs text-slate-500 dark:text-slate-400 mt-1 whitespace-pre-wrap">原文：${escHtml(kdRowInsightText(r))}</div>
    <div class="text-xs text-slate-600 dark:text-slate-300 mt-1">理由：${escHtml(r.reason || '')}</div>
    ${op.action !== 'none' ? `<div class="text-xs text-cyan-700 dark:text-cyan-400 mt-1 whitespace-pre-wrap">最終寫入：${escHtml(op.new || '')}</div>` : ''}
    ${kdThreadHtml(r)}
    <div class="flex flex-wrap items-center gap-2 mt-2">
      <button data-act="kd-row-accept" data-row="${r.id}" class="px-2 py-1 rounded-lg text-[11px] font-semibold transition-colors ${status === 'accepted' ? 'bg-cyan-600 text-white' : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-cyan-100 dark:hover:bg-cyan-900/30'}">接受</button>
      <button data-act="kd-row-reject" data-row="${r.id}" class="px-2 py-1 rounded-lg text-[11px] font-semibold transition-colors ${status === 'rejected' ? 'bg-slate-500 text-white' : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-red-100 dark:hover:bg-red-900/30'}">拒絕</button>
      <input data-act="kd-row-note-input" data-row="${r.id}" type="text" placeholder="備註（例如：這句其實已經過時了）" class="flex-1 min-w-[10rem] text-[11px] px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200">
      <button data-act="kd-row-note-submit" data-row="${r.id}" class="px-2 py-1 rounded-lg text-[11px] font-semibold bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors">送出備註</button>
    </div>
  </div>`;
}

function kdClusterHtml(cl, rows) {
  const collapsed = !!kdCollapsed[cl.id];
  // 每個區塊自己的「全部接受／全部拒絕」：Hana 已經把「該收」跟「該捨」分群分好，
  // 指揮官能一群一群拍板，不必逐條按、也不必只能全域一拍。
  // 有互斥的群不提供「全部接受」（會直接造出未解衝突），但可以全部拒絕。
  const decided = rows.filter(r => ['accepted', 'rejected', 'agreed'].includes(kdRowStatus(r.id))).length;
  const acceptCls = cl.hasConflict
    ? 'bg-slate-100 dark:bg-slate-800 text-slate-300 dark:text-slate-600 cursor-not-allowed'
    : 'bg-cyan-50 hover:bg-cyan-600 hover:text-white dark:bg-cyan-900/30 dark:hover:bg-cyan-600 text-cyan-700 dark:text-cyan-300';
  return `<div class="rounded-xl border ${cl.hasConflict ? 'border-red-200 dark:border-red-800/60' : 'border-slate-200 dark:border-slate-700/60'} bg-white dark:bg-slate-900/40 shadow-sm overflow-hidden mb-3" data-kd-cluster="${cl.id}">
    <div class="flex items-center gap-2 px-4 py-2.5 ${cl.hasConflict ? 'bg-red-50/70 dark:bg-red-900/10' : 'bg-slate-50/80 dark:bg-slate-800/60'} border-b border-slate-200 dark:border-slate-700/50">
      <button data-act="kd-toggle-cluster" data-cluster="${cl.id}" class="flex-1 min-w-0 flex items-center gap-2 text-left">
        <span class="text-sm font-semibold text-slate-700 dark:text-slate-200 truncate">${cl.hasConflict ? '⚠️ ' : ''}${escHtml(cl.title || cl.id)} <span class="text-[10px] font-normal text-slate-400">（${rows.length} 條${decided ? '，已定案 ' + decided : ''}）</span></span>
        <span class="text-slate-400 text-xs shrink-0">${collapsed ? '▸ 展開' : '▾ 收合'}</span>
      </button>
      <button data-act="kd-cluster-accept" data-cluster="${cl.id}" ${cl.hasConflict ? 'disabled' : ''} title="${cl.hasConflict ? '這群存在互斥，請逐條取捨' : '把這個區塊的 ' + rows.length + ' 條全標為接受'}" class="shrink-0 px-2 py-1 rounded-lg text-[11px] font-semibold transition-colors ${acceptCls}">全部接受</button>
      <button data-act="kd-cluster-reject" data-cluster="${cl.id}" title="把這個區塊的 ${rows.length} 條全標為拒絕" class="shrink-0 px-2 py-1 rounded-lg text-[11px] font-semibold bg-slate-100 hover:bg-red-100 dark:bg-slate-700 dark:hover:bg-red-900/30 text-slate-600 dark:text-slate-300 hover:text-red-600 dark:hover:text-red-400 transition-colors">全部拒絕</button>
    </div>
    <div class="kd-cluster-body px-4 py-3 space-y-3 ${collapsed ? 'hidden' : ''}">${rows.map(kdRowHtml).join('')}</div>
  </div>`;
}

function kdHousekeepingHtml() {
  const hk = (kdProposal && Array.isArray(kdProposal.housekeeping)) ? kdProposal.housekeeping : [];
  if (!hk.length) return '';
  return `<div class="rounded-xl border border-slate-200 dark:border-slate-700/60 bg-slate-50/60 dark:bg-slate-800/30 shadow-sm overflow-hidden mb-3">
    <div class="px-4 py-2.5 bg-slate-100/80 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-700/50">
      <span class="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">🧹 順手整理既有記憶（與本次候選無關，預設不勾）</span>
    </div>
    <div class="px-4 py-3 space-y-2">${hk.map((h, i) => `
      <label class="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
        <input type="checkbox" data-act="kd-hk-toggle" data-idx="${i}" class="mt-0.5 accent-cyan-600" ${kdHkChecked[i] ? 'checked' : ''}>
        <span><span class="px-1.5 py-0.5 rounded text-[10px] font-semibold ${KD_VERDICT_BADGE[h.verdict] || KD_VERDICT_BADGE.duplicate} mr-1">${KD_VERDICT_LABEL[h.verdict] || h.verdict || ''}</span>
        ${escHtml(h.reason || '')} — <span class="text-cyan-700 dark:text-cyan-400">${escHtml((h.op && h.op.new) || '')}</span></span>
      </label>`).join('')}
    </div>
  </div>`;
}

function kdRenderProposalBox() {
  const box = container.querySelector('#kd-proposal-box');
  if (!box) return;
  if (!kdProposal) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  const rows = Array.isArray(kdProposal.rows) ? kdProposal.rows : [];
  const clusters = Array.isArray(kdProposal.clusters) ? kdProposal.clusters : [];
  const byCluster = clusters.map(cl => ({ cl, rows: rows.filter(r => r.clusterId === cl.id) }))
    .concat([{ cl: { id: '__nocluster__', title: '未分群' }, rows: rows.filter(r => !clusters.some(c => c.id === r.clusterId)) }])
    .filter(g => g.rows.length);

  const unresolved = kdConflictPairsUnresolved();
  const incomplete = kdCompleteness && kdCompleteness.complete === false;
  // 「比提案晚出生」的候選不算缺漏（後端已歸為 deferred），只提示、不鎖套用。
  const deferredCount = (kdCompleteness && (kdCompleteness.deferred || []).length) || 0;
  const blockReason = incomplete ? '有候選未登進任何列，請先重跑或人工確認完整性' : (unresolved.length ? '存在未解衝突，請先在衝突群內做取捨' : '');
  // KD3: 「送出已備註的」只認頁面本地狀態為 commented 且有備註文字的列——那才是還沒送給 Hana 想過的。
  const commentedCount = Object.keys(kdRowState).filter(id => kdRowState[id].status === 'commented' && kdRowState[id].note).length;
  const rethinkBusy = !!(kdJob && kdJob.status === 'running' && kdJob.mode === 'rethink');
  // KD4 接線：套用要送出的是「本次已定案」的列——頁面本地的 accepted/rejected，
  // 加上 Hana 重新思考後已同意（agreed，狀態寫在 proposal.json）的列。
  const decidedCount = rows.filter(r => {
    const st = kdRowStatus(r.id);
    return st === 'accepted' || st === 'rejected' || st === 'agreed';
  }).length;
  const applyBlocked = incomplete || unresolved.length > 0 || decidedCount === 0;

  box.innerHTML = `
    ${deferredCount ? `<div class="mb-3 px-4 py-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 text-xs text-slate-500 dark:text-slate-400">ℹ 有 ${deferredCount} 筆精華後來才產生（比這份彙整晚），不包含在本次提案，會留到下一輪。</div>` : ''}
    ${incomplete ? `<div class="mb-3 px-4 py-2.5 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-400">⚠ 完整性檢查失敗：有 ${(kdCompleteness.unregistered || []).length} 筆候選沒有登進任何提案列，「套用」已鎖住。</div>` : ''}
    <div class="space-y-3">${byCluster.map(g => kdClusterHtml(g.cl, g.rows)).join('')}</div>
    ${kdHousekeepingHtml()}
    <div class="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-slate-200 dark:border-slate-700/60">
      <button data-act="kd-all-accept" ${(clusters.some(c => c.hasConflict) || unresolved.length) ? 'disabled' : ''} class="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${(clusters.some(c => c.hasConflict) || unresolved.length) ? 'bg-slate-100 dark:bg-slate-800 text-slate-300 dark:text-slate-600 cursor-not-allowed' : 'bg-cyan-600 hover:bg-cyan-700 text-white'}">全部接受</button>
      <button data-act="kd-all-reject" class="px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-200 hover:bg-red-100 dark:bg-slate-700 dark:hover:bg-red-900/30 text-slate-600 dark:text-slate-300 hover:text-red-600 dark:hover:text-red-400 transition-colors">全部拒絕</button>
      <button data-act="kd-send-rethink" ${(!commentedCount || rethinkBusy) ? 'disabled' : ''} title="${commentedCount ? '' : '先在列下方輸入備註並送出，才有東西可以重新思考'}" class="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${(!commentedCount || rethinkBusy) ? 'bg-slate-100 dark:bg-slate-800 text-slate-300 dark:text-slate-600 cursor-not-allowed' : 'bg-amber-500 hover:bg-amber-600 text-white'}">${rethinkBusy ? 'Hana 思考中…' : `送出已備註的${commentedCount ? '（' + commentedCount + ' 條）' : ''}（請 Hana 重新思考）`}</button>
      <button data-act="kd-apply" ${(applyBlocked || kdApplyBusy) ? 'disabled' : ''} title="${blockReason || '寫入記憶檔前會先快照四個記憶檔，可還原'}" class="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${(applyBlocked || kdApplyBusy) ? 'bg-slate-100 dark:bg-slate-800 text-slate-300 dark:text-slate-600 cursor-not-allowed' : 'bg-emerald-600 hover:bg-emerald-700 text-white'}">${kdApplyBusy ? '套用中…' : `套用已定案項${decidedCount ? '（' + decidedCount + ' 條）' : ''}`}</button>
      ${blockReason ? `<span class="text-[11px] text-red-600 dark:text-red-400">⚠ ${blockReason}</span>` : ''}
    </div>
    <p class="text-[10px] text-slate-400 dark:text-slate-500 mt-1">接受／拒絕先記在頁面上，按「套用已定案項」才真的寫入記憶檔並把對應的精華待審清掉；仍在討論中的列會留著。備註送出後會觸發 Hana 重新思考。</p>
  `;
  kdBindProposalEvents(box);
}

function kdBindProposalEvents(box) {
  box.querySelectorAll('[data-act="kd-toggle-cluster"]').forEach(btn => btn.addEventListener('click', () => {
    const id = btn.getAttribute('data-cluster');
    kdCollapsed[id] = !kdCollapsed[id];
    kdRenderProposalBox();
  }));
  const kdSetClusterStatus = (clusterId, status) => {
    const rows = (kdProposal && kdProposal.rows) || [];
    const clusters = (kdProposal && kdProposal.clusters) || [];
    const inCluster = clusterId === '__nocluster__'
      ? rows.filter(r => !clusters.some(c => c.id === r.clusterId))
      : rows.filter(r => r.clusterId === clusterId);
    inCluster.forEach(r => { kdRowState[r.id] = Object.assign({}, kdRowState[r.id], { status }); });
    window.showToast(`已將 ${inCluster.length} 條標為${status === 'accepted' ? '接受' : '拒絕'}（尚未寫入）`, 'info');
    kdRenderProposalBox();
  };
  box.querySelectorAll('[data-act="kd-cluster-accept"]').forEach(btn => btn.addEventListener('click', () => {
    if (btn.disabled) return;
    kdSetClusterStatus(btn.getAttribute('data-cluster'), 'accepted');
  }));
  box.querySelectorAll('[data-act="kd-cluster-reject"]').forEach(btn => btn.addEventListener('click', () => {
    kdSetClusterStatus(btn.getAttribute('data-cluster'), 'rejected');
  }));
  box.querySelectorAll('[data-act="kd-row-accept"]').forEach(btn => btn.addEventListener('click', () => kdSetRowStatus(btn.getAttribute('data-row'), 'accepted')));
  box.querySelectorAll('[data-act="kd-row-reject"]').forEach(btn => btn.addEventListener('click', () => kdSetRowStatus(btn.getAttribute('data-row'), 'rejected')));
  box.querySelectorAll('[data-act="kd-row-note-submit"]').forEach(btn => btn.addEventListener('click', () => {
    const rowId = btn.getAttribute('data-row');
    const input = box.querySelector(`[data-act="kd-row-note-input"][data-row="${rowId}"]`);
    const text = (input && input.value || '').trim();
    if (!text) { window.showToast('請先輸入備註內容', 'error'); return; }
    kdRowState[rowId] = Object.assign({}, kdRowState[rowId], { status: 'commented', note: text });
    window.showToast('已記下備註，按下方「送出已備註的」讓 Hana 真的重新想一次', 'info');
    kdRenderProposalBox();
  }));
  box.querySelectorAll('[data-act="kd-hk-toggle"]').forEach(chk => chk.addEventListener('change', () => {
    kdHkChecked[chk.getAttribute('data-idx')] = chk.checked;
  }));
  const allAcceptBtn = box.querySelector('[data-act="kd-all-accept"]');
  if (allAcceptBtn) allAcceptBtn.addEventListener('click', () => {
    if (allAcceptBtn.disabled) return;
    (kdProposal.rows || []).forEach(r => { kdRowState[r.id] = Object.assign({}, kdRowState[r.id], { status: 'accepted' }); });
    kdRenderProposalBox();
  });
  const allRejectBtn = box.querySelector('[data-act="kd-all-reject"]');
  if (allRejectBtn) allRejectBtn.addEventListener('click', () => {
    (kdProposal.rows || []).forEach(r => { kdRowState[r.id] = Object.assign({}, kdRowState[r.id], { status: 'rejected' }); });
    kdRenderProposalBox();
  });
  const rethinkBtn = box.querySelector('[data-act="kd-send-rethink"]');
  if (rethinkBtn) rethinkBtn.addEventListener('click', () => { if (!rethinkBtn.disabled) kdSendRethink(); });
  const applyBtn = box.querySelector('[data-act="kd-apply"]');
  if (applyBtn) applyBtn.addEventListener('click', () => { if (!applyBtn.disabled) kdApply(); });
}

// KD4 接線：把頁面本地的 accepted/rejected 決定送給 /apply，由後端快照 → applyMemoryOps 寫入
// → 依 candidateLedger 結算候選（全數列定案的才 reviewed:true、從精華待審消失）。
// 仍在 commented/disputed 的列與其來源候選會留著，提案檔不刪。
async function kdApply() {
  const decisions = {};
  (kdProposal && kdProposal.rows || []).forEach(r => {
    const st = kdRowState[r.id] && kdRowState[r.id].status;
    if (st === 'accepted' || st === 'rejected') decisions[r.id] = st;
  });
  const housekeeping = Object.keys(kdHkChecked).filter(k => kdHkChecked[k]).map(Number);
  if (!confirm('要把已定案的項目寫入這個工作區的記憶檔嗎？寫入前會先做快照，可還原。')) return;
  kdApplyBusy = true; kdRenderProposalBox();
  try {
    const r = await fetch('/api/knowledge-distill/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decisions, housekeeping }),
    });
    const d = await r.json();
    if (!d.ok) { window.showToast(d.error || '套用失敗', 'error'); return; }
    const total = Object.values(d.written || {}).reduce((a, b) => a + b, 0);
    const left = (d.stillInProgress || []).length;
    window.showToast('已寫入 ' + total + ' 條記憶、結算 ' + (d.settledCandidates || 0) + ' 筆精華待審'
      + (left ? '；仍有 ' + left + ' 筆在討論中' : '') + (d.proposalDeleted ? '；提案已全數定案' : ''), 'success');
    (d.capWarnings || []).forEach(w => window.showToast(w, 'error'));
    kdRowState = {}; kdHkChecked = {};
    await kdLoadProposal();
    await loadCandidates();
  } catch (e) {
    window.showToast('套用失敗: ' + e.message, 'error');
  } finally {
    kdApplyBusy = false; kdRenderProposalBox();
  }
}

// KD3: 把頁面本地已備註（commented + note）的列送給 /rethink——server 端先把備註寫進 thread、
// 轉成 commented，再背景跑技能只對這幾列重新想一次。完成後 kdPollStatus() 會整份重新載入提案，
// 屆時該列的 status/thread 就是 Hana 真正想過的結果（agreed/disputed），頁面本地暫存自然歸零。
async function kdSendRethink() {
  const model = container.querySelector('#kd-model-select').value;
  const rows = Object.keys(kdRowState)
    .filter(id => kdRowState[id].status === 'commented' && kdRowState[id].note)
    .map(id => ({ id, note: kdRowState[id].note }));
  if (!rows.length) { window.showToast('目前沒有已備註待送出的列', 'error'); return; }
  try {
    const r = await fetch('/api/knowledge-distill/rethink', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows, model }),
    });
    const d = await r.json();
    if (!d.ok) { window.showToast(d.error || '送出失敗', 'error'); return; }
    window.showToast('已送出 ' + rows.length + ' 條給 Hana 重新思考（' + model + '）…', 'info');
    kdPollStatus();
  } catch (e) {
    window.showToast('送出失敗: ' + e.message, 'error');
  }
}

function kdSetRowStatus(rowId, status) {
  kdRowState[rowId] = Object.assign({}, kdRowState[rowId], { status });
  kdRenderProposalBox();
}

function schedBackToList() {
  container.querySelector('#sched-list-view').classList.remove('hidden');
  container.querySelector('#sched-detail-view').classList.add('hidden');
  container.querySelector('#sched-run-detail').classList.add('hidden');
  if (activeTab === 'list') drawChainLinks();   // 從詳情返回時重新量座標
}

let _schedEditId = null;
function schedOpenNew() { _schedEditId = null; schedOpenModal(null); }
function schedEdit(id) { _schedEditId = id; schedOpenModal(id); }
function schedCloseModal() { container.querySelector('#sched-modal').classList.add('hidden'); }

function schedUpdateTriggerUI() {
  const t = container.querySelector('#sched-f-trigger-type').value;
  container.querySelector('#sched-f-trigger-cron').classList.toggle('hidden', t !== 'cron');
  container.querySelector('#sched-f-trigger-interval').classList.toggle('hidden', t !== 'interval');
  container.querySelector('#sched-f-trigger-once').classList.toggle('hidden', t !== 'once');
  // manual：不排時間，只能按「▶ 立即」或被鏈接觸發 → 三個時間欄位全隱藏，改顯示說明
  container.querySelector('#sched-f-trigger-manual').classList.toggle('hidden', t !== 'manual');
}

// SCHED-CHAIN: 用同工作區的排程清單填「成功後接續」下拉（排除自己；不排除已成功者——例行排程可反覆被接）。
async function schedPopulateChainOptions(excludeId, selectedId) {
  const sel = container.querySelector('#sched-f-chainnext');
  if (!sel) return;
  let list = [];
  try { list = await (await fetch('/api/schedules')).json(); } catch (e) { list = []; }
  const opts = ['<option value="">（不接續）</option>'];
  list.filter(s => s.id !== excludeId).forEach(s => {
    const tag = s.archived ? '（已歸檔）' : (s.enabled ? '' : '（停用）');
    opts.push(`<option value="${escHtml(s.id)}">${escHtml(s.name)}${tag}</option>`);
  });
  sel.innerHTML = opts.join('');
  if (selectedId) sel.value = selectedId;
}

// SCHED-DEPLOY-NEXT §4.8: 「部署成功後接續」下拉——列「全部」排程（可跨工作區，標出工作區名稱），排除自己。
// 走專用的 /api/schedules/deploy-targets（只回 id/名稱/工作區名），不放寬一般清單的工作區隔離。
async function schedPopulateDeployNextOptions(excludeId, selectedId) {
  const sel = container.querySelector('#sched-f-nextafterdeploy');
  if (!sel) return;
  let list = [];
  try { list = await (await fetch('/api/schedules/deploy-targets')).json(); } catch (e) { list = []; }
  const opts = ['<option value="">（不接續）</option>'];
  (Array.isArray(list) ? list : []).filter(s => s.id !== excludeId && !s.archived).forEach(s => {
    const tag = s.enabled ? '' : '（停用）';
    opts.push(`<option value="${escHtml(s.id)}">[${escHtml(s.workspace || '')}] ${escHtml(s.name)}${tag}</option>`);
  });
  sel.innerHTML = opts.join('');
  sel.value = selectedId || '';
}

// SCHED-DEPLOY D2/Z6: 「成功後接續」選了非空值 → 佈署 checkbox 立即取消勾選並 disable（不自動勾回）。
function schedUpdatePostRunDeployUI() {
  const chained = !!container.querySelector('#sched-f-chainnext').value;
  const cb = container.querySelector('#sched-f-postrun-deploy');
  const hint = container.querySelector('#sched-f-postrun-deploy-hint');
  cb.disabled = chained;
  if (chained) cb.checked = false;
  hint.textContent = chained
    ? '已設定接續排程，佈署請設在鏈的最後一棒。'
    : '佈署會重啟服務，因此只能設在沒有接續排程的最後一棒。';
  // SCHED-DEPLOY-NEXT: 只有勾了佈署才可選「部署成功後接續」
  const nx = container.querySelector('#sched-f-nextafterdeploy');
  if (nx) {
    nx.disabled = !cb.checked;
    if (!cb.checked) nx.value = '';
    container.querySelector('#sched-f-nextafterdeploy-wrap').classList.toggle('opacity-50', !cb.checked);
  }
}

async function schedOpenModal(id) {
  container.querySelector('#sched-modal-title').textContent = id ? '編輯排程' : '新增排程';
  container.querySelector('#sched-f-edit-id').value = id || '';
  container.querySelector('#sched-f-name').value = '';
  container.querySelector('#sched-f-cron-expr').value = '0 9 * * *';
  container.querySelector('#sched-f-interval-min').value = '60';
  container.querySelector('#sched-f-once-at').value = '';
  container.querySelector('#sched-f-prompt').value = '';
  container.querySelector('#sched-f-model').value = 'claude::sonnet';
  container.querySelector('#sched-f-trigger-type').value = 'cron';
  container.querySelector('#sched-f-failbreak').value = '3';
  container.querySelector('#sched-f-maxruntime').value = '5';
  // H7: 新建預設兩個都勾
  container.querySelector('#sched-f-delivery-web').checked = true;
  container.querySelector('#sched-f-delivery-telegram').checked = true;
  // SCHED-DEPLOY: 新建預設不勾佈署
  container.querySelector('#sched-f-postrun-deploy').checked = false;
  schedUpdateTriggerUI();
  // SCHED-CHAIN: 填入「成功後接續」下拉——列出同工作區所有排程（含已成功/例行者），排除自己
  await schedPopulateChainOptions(id, null);
  await schedPopulateDeployNextOptions(id, null);
  schedUpdatePostRunDeployUI();

  if (id) {
    try {
      const s = await (await fetch(`/api/schedules/${id}`)).json();
      container.querySelector('#sched-f-chainnext').value = s.chainNext || '';
      container.querySelector('#sched-f-postrun-deploy').checked = !!(s.postRun && s.postRun.deploy === true);
      schedUpdatePostRunDeployUI();
      container.querySelector('#sched-f-nextafterdeploy').value = (s.postRun && s.postRun.nextAfterDeploy) || '';
      container.querySelector('#sched-f-name').value = s.name || '';
      container.querySelector('#sched-f-prompt').value = (s.task && s.task.prompt) || '';
      container.querySelector('#sched-f-model').value = s.model || 'claude::sonnet';
      container.querySelector('#sched-f-failbreak').value = (s.guardrails && s.guardrails.failureBreakAfter) ?? 3;
      container.querySelector('#sched-f-maxruntime').value = Math.round(((s.guardrails && s.guardrails.maxRuntimeMs) ?? 300000) / 60000);
      const t = s.trigger || {};
      container.querySelector('#sched-f-trigger-type').value = t.type || 'cron';
      if (t.type === 'cron') container.querySelector('#sched-f-cron-expr').value = t.expr || '0 9 * * *';
      if (t.type === 'interval') container.querySelector('#sched-f-interval-min').value = Math.round((t.intervalMs || 3600000) / 60000);
      if (t.type === 'once') container.querySelector('#sched-f-once-at').value = t.atISO ? isoToLocalInput(t.atISO) : '';
      schedUpdateTriggerUI();
      // H7: 回填 delivery 勾選
      const del = Array.isArray(s.delivery) ? s.delivery : ['web', 'telegram'];
      container.querySelector('#sched-f-delivery-web').checked = del.includes('web');
      container.querySelector('#sched-f-delivery-telegram').checked = del.includes('telegram');
    } catch (e) { console.error('schedOpenModal fetch error', e); }
  }
  container.querySelector('#sched-modal').classList.remove('hidden');
}

async function schedSave() {
  const id = container.querySelector('#sched-f-edit-id').value;
  const tType = container.querySelector('#sched-f-trigger-type').value;
  let trigger;
  if (tType === 'cron')     trigger = { type: 'cron', expr: container.querySelector('#sched-f-cron-expr').value.trim() };
  if (tType === 'interval') trigger = { type: 'interval', intervalMs: parseFloat(container.querySelector('#sched-f-interval-min').value) * 60000 };
  if (tType === 'manual')   trigger = { type: 'manual' };
  if (tType === 'once') {
    const raw = container.querySelector('#sched-f-once-at').value;
    const at = new Date(raw);
    if (!raw || isNaN(at.getTime())) { alert('「單次」需要指定時間；若不想排時間，請把觸發方式改成「手動觸發」。'); return; }
    trigger = { type: 'once', atISO: at.toISOString() };
  }
  // H7: 收集通知勾選
  const delivery = [];
  if (container.querySelector('#sched-f-delivery-web').checked) delivery.push('web');
  if (container.querySelector('#sched-f-delivery-telegram').checked) delivery.push('telegram');
  const data = {
    name: container.querySelector('#sched-f-name').value.trim() || '未命名排程',
    trigger,
    task: { kind: 'prompt', prompt: container.querySelector('#sched-f-prompt').value.trim() },
    model: container.querySelector('#sched-f-model').value,
    guardrails: {
      failureBreakAfter: parseInt(container.querySelector('#sched-f-failbreak').value) || 3,
      maxRuntimeMs: parseFloat(container.querySelector('#sched-f-maxruntime').value) * 60000 || 300000,
    },
    delivery,
    chainNext: container.querySelector('#sched-f-chainnext').value || null,  // SCHED-CHAIN
    postRun: {  // SCHED-DEPLOY ＋ SCHED-DEPLOY-NEXT
      deploy: container.querySelector('#sched-f-postrun-deploy').checked,
      nextAfterDeploy: container.querySelector('#sched-f-postrun-deploy').checked ? (container.querySelector('#sched-f-nextafterdeploy').value || null) : null,
    },
  };
  try {
    const res = id
      ? await fetch(`/api/schedules/${id}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) })
      : await fetch('/api/schedules', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || ('HTTP ' + res.status)); }
    schedCloseModal();
    schedLoadList();
  } catch (e) { alert('儲存失敗：' + e.message); }
}

async function schedDelete(id) {
  if (!confirm('確定刪除此排程？執行紀錄不會一併刪除。')) return;
  await fetch(`/api/schedules/${id}`, { method: 'DELETE' });
  schedLoadList();
}

async function schedToggle(id, enabled) {
  await fetch(`/api/schedules/${id}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ enabled }) });
  schedLoadList();
}

async function schedTriggerNow(id) {
  const res  = await fetch(`/api/schedules/${id}/run`, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    alert(data.error === 'already-running'
      ? '此排程正在執行中，無法重複觸發。'
      : ('觸發失敗：' + (data.error || res.status)));
    schedLoadList();
    return;
  }
  schedLoadList();  // 立刻反映「執行中」+ disable 按鈕
}

// SCH-STOP: 中止「目前正在跑」的 run。語意是叫停、不是還原——確認文案要把這點講清楚，
// 避免指揮官以為按下去會把已寫入的檔案/已上線的程式/已過帳的資料退回去。
async function schedAbortNow(id) {
  const ok = confirm(
    '確定要中止這次執行嗎？\n\n' +
    '① 這只會叫停，不會還原已經做過的事。\n' +
    '② 已寫入的檔案／已上線的程式／已寫入的資料會停在半套狀態，不會自動退回。\n' +
    '③ 排程本身不會被停用，下次照常會依原排程觸發。'
  );
  if (!ok) return;
  try {
    const res  = await fetch(`/api/schedules/${id}/abort`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const msg = {
        'not-running': '這條排程目前沒有正在執行的任務，可能剛好已經跑完了。',
        'no-job': '找不到對應的執行程序（可能已經自行結束），無法中止。',
        'forbidden-workspace': '這條排程不屬於目前的工作區，不能在這裡中止它。',
      }[data.error] || ('中止失敗：' + (data.error || res.status));
      window.showToast ? window.showToast(msg, 'error') : alert(msg);
      schedLoadList();
      return;
    }
    window.showToast && window.showToast('🛑 已送出中止指令', 'success');
  } catch (e) {
    const msg = '中止失敗：' + e.message;
    window.showToast ? window.showToast(msg, 'error') : alert(msg);
  }
  schedLoadList();
}

// ── Activity Feed (站內動態, SCHED-08) ────────────────────────────────

async function loadActivities() {
  const activitiesEl = container.querySelector('#sched-activities-content');
  if (!activitiesEl) return;
  try {
    // 分頁後不再只取 10 筆；取回全量（上限 200）由前端切頁。
    actCache = await (await fetch('/api/activities?limit=200')).json();
    PAGE.act = 1;
    renderActivities();
  } catch (e) {
    if (activitiesEl) activitiesEl.innerHTML = '<p class="text-xs text-rose-400 py-1">載入失敗</p>';
  }
}

function renderActivities() {
  const activitiesEl = container.querySelector('#sched-activities-content');
  const pagerEl = container.querySelector('#sched-activities-pager');
  if (!activitiesEl) return;
  {
    const all = actCache || [];
    if (!all.length) {
      activitiesEl.innerHTML = '<p class="text-xs text-slate-400 dark:text-slate-500 py-1">尚無動態記錄</p>';
      if (pagerEl) pagerEl.innerHTML = '';
      updateTabBadge('sched-tab-badge-act', 0);
      return;
    }
    updateTabBadge('sched-tab-badge-act', all.length);
    const pages = Math.max(1, Math.ceil(all.length / ACT_PAGE_SIZE));
    PAGE.act = Math.min(Math.max(1, PAGE.act), pages);
    const notifs = all.slice((PAGE.act - 1) * ACT_PAGE_SIZE, PAGE.act * ACT_PAGE_SIZE);
    const statusIcon = { success: '✅', failed: '❌', 'limited-waiting': '⏳', running: '🔄', aborted: '🛑', blocked: '⚠️', partial: '✅' };
    activitiesEl.innerHTML = notifs.map(function(n) {
      const icon = statusIcon[n.status] || '📌';
      const t = n.createdAt ? n.createdAt.slice(0, 16).replace('T', ' ') : '';
      return '<div class="flex items-start gap-2 py-2 border-b border-slate-100 dark:border-slate-800 last:border-0" data-act="activity-item" data-sched-id="' + escHtml(n.scheduleId) + '" data-notif-id="' + escHtml(n.id) + '">'
        + '<span class="text-sm shrink-0 mt-0.5">' + icon + '</span>'
        + '<div class="min-w-0 flex-1">'
        + '<span class="text-[13px] font-medium text-slate-700 dark:text-slate-200">' + escHtml(n.scheduleName || n.scheduleId) + '</span>'
        + (n.summary ? '<br><span class="text-xs text-slate-500 dark:text-slate-400">' + escHtml(n.summary) + '</span>' : '')
        + '<br><span class="text-[10px] text-slate-400 dark:text-slate-500">' + t + '</span>'
        + '<button data-act="activity-view" class="ml-2 text-[10px] text-cyan-500 hover:text-cyan-700 dark:text-cyan-400 dark:hover:text-cyan-200">查看</button>'
        + '</div>'
        + '<button data-act="activity-dismiss" title="移除" class="shrink-0 text-slate-300 hover:text-rose-400 dark:text-slate-600 dark:hover:text-rose-400 text-lg leading-none">×</button>'
        + '</div>';
    }).join('');
    activitiesEl.querySelectorAll('[data-act="activity-view"]').forEach(btn => {
      const item = btn.closest('[data-act="activity-item"]');
      btn.addEventListener('click', () => schedOpenDetail(item.getAttribute('data-sched-id')));
    });
    activitiesEl.querySelectorAll('[data-act="activity-dismiss"]').forEach(btn => {
      const item = btn.closest('[data-act="activity-item"]');
      btn.addEventListener('click', () => dismissActivity(item.getAttribute('data-notif-id')));
    });
    if (pagerEl) {
      pagerEl.innerHTML = pagerHtml(all.length, PAGE.act, ACT_PAGE_SIZE, null);
      bindPager(pagerEl, p => { PAGE.act = p; renderActivities(); }, null);
    }
  }
}

// 側欄徽章（menu-scheduler 旁 #sched-notif-badge）屬 index.html 殼常駐 DOM，不隨本 view 卸載，
// 語意＝「已排但未完成的筆數」，由殼層的 window.refreshSchedBadge() 統一計算（見 index.html）。
// 本 view 只負責在排程資料可能變動後（載入清單、啟停、觸發、刪除、歸檔）請它重算。
function refreshSchedBadge() {
  if (typeof window.refreshSchedBadge === 'function') window.refreshSchedBadge();
}

async function dismissActivity(id) {
  await fetch('/api/activities/' + id, { method: 'DELETE' });
  actCache = (actCache || []).filter(n => String(n.id) !== String(id));
  renderActivities();   // 就地重繪，不重載＝不會把你彈回第 1 頁
}

// ── SLV: SSE 即時更新 + 保底輪詢 ─────────────────────────────────────────

// debounce 300ms：短時間內連續多個事件（例如一次排程同時觸發 run-start + run-update）只重抓一次。
// 重抓時記住捲動位置，重繪完再還原，避免版面被彈回頂端。
function scheduleChangeHandler() {
  clearTimeout(schedChangeDebounceTimer);
  schedChangeDebounceTimer = setTimeout(() => {
    if (!container) return; // view 已卸載
    const scrollY = window.scrollY;
    Promise.resolve(schedLoadList())
      .then(() => loadActivities())
      .then(() => { refreshSchedBadge(); window.scrollTo(0, scrollY); })
      .catch(() => {});
  }, 300);
}

function stopSchedPolling() {
  if (schedPollTimer) { clearInterval(schedPollTimer); schedPollTimer = null; }
}

function startSchedPolling() {
  stopSchedPolling();
  schedUsingPolling = true;
  schedPollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') scheduleChangeHandler();
  }, 15000);
}

function onSchedVisibilityChange() {
  // 分頁切回前景時，若目前是靠輪詢保底（SSE 連不上），立即補抓一次，不等下個 15 秒。
  if (schedUsingPolling && document.visibilityState === 'visible') scheduleChangeHandler();
}

function startScheduleStream() {
  if (typeof window.EventSource !== 'function') { startSchedPolling(); return; } // 環境不支援 SSE → 直接退回輪詢
  const ws = (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('current_workspace')) || '';
  try {
    schedEventSource = new EventSource('/api/schedules/stream?workspace=' + encodeURIComponent(ws));
  } catch (e) { startSchedPolling(); return; }
  schedEventSource.addEventListener('schedules-changed', scheduleChangeHandler);
  schedEventSource.onopen = () => {
    schedSSEFailCount = 0;
    if (schedUsingPolling) { schedUsingPolling = false; stopSchedPolling(); }
  };
  schedEventSource.onerror = () => {
    schedSSEFailCount++;
    if (schedSSEFailCount >= SCHED_SSE_FAIL_THRESHOLD) {
      // 連續失敗次數過多（例如環境擋 keep-alive）→ 收掉，退回可見分頁輪詢，不讓瀏覽器無限重試。
      if (schedEventSource) { schedEventSource.close(); schedEventSource = null; }
      startSchedPolling();
    }
  };
  document.addEventListener('visibilitychange', onSchedVisibilityChange);
}

function stopScheduleStream() {
  clearTimeout(schedChangeDebounceTimer);
  if (schedEventSource) { schedEventSource.close(); schedEventSource = null; }
  stopSchedPolling();
  schedUsingPolling = false;
  schedSSEFailCount = 0;
  document.removeEventListener('visibilitychange', onSchedVisibilityChange);
}

function render() {
  container.innerHTML =
    // 清單有 8 欄（含「佈署」），max-w-4xl／7xl 都太窄會逼出橫向捲軸；改吃滿可用寬度、
    // 左右只留必要 padding（畫面兩側本來就有大量留白），配合 px-3 儲存格讓 8 欄自然容得下。
    '<div class="w-full px-6 py-8">'

    + '<div id="sched-list-view">'
    + '<div class="flex items-center justify-between mb-4">'
    + '<div>'
    + '<h2 class="text-xl font-bold text-slate-900 dark:text-white">排程任務</h2>'
    + '<p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">執行者常駐 server，不需開瀏覽器也能跑</p>'
    + '</div>'
    + '<div class="flex items-center gap-2">'
    + '<button id="sched-btn-refresh-list" title="重新整理排程清單" class="px-3 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 text-sm font-medium transition-all">↻ 重新整理</button>'
    + '<button id="sched-btn-new" class="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-sm font-semibold transition-all shadow">+ 新增排程</button>'
    + '</div>'
    + '</div>'

    // SCHED-TAB: 三區塊改頁籤，順序＝指揮官的關注順序（列表 → 精華待審 → 近期動態），預設停在列表。
    + '<div class="flex items-center gap-1 mb-4 border-b border-slate-200 dark:border-slate-700/60">'
    + tabBtn('list', '📋 排程列表', '')
    + tabBtn('cand', '💡 精華待審', 'sched-tab-badge-cand')
    + tabBtn('act', '📢 近期動態', 'sched-tab-badge-act')
    + '</div>'

    + '<div id="sched-pane-list">'
    + '<div id="sched-list-content"><p class="text-slate-400 text-sm">載入中…</p></div>'
    + '</div>'

    + '<div id="sched-pane-cand" class="hidden">'

    // KD2-1: 知識精華收斂工具條——模型下拉 + 開始彙整 + 上次彙整時間 + 摘要
    + '<div class="rounded-xl border border-cyan-200 dark:border-cyan-700/60 bg-cyan-50/60 dark:bg-cyan-900/10 shadow-sm overflow-hidden mb-4">'
    + '<div class="flex flex-wrap items-center gap-3 px-4 py-3">'
    + '<span class="text-xs font-semibold text-cyan-700 dark:text-cyan-400 uppercase tracking-wider shrink-0">🧪 知識精華收斂</span>'
    + '<select id="kd-model-select" class="text-xs px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200">'
    + '<option value="claude::opus">Claude Opus（推薦）</option>'
    + '<option value="claude::sonnet">Claude Sonnet</option>'
    + '<option value="claude::haiku">Claude Haiku</option>'
    + '<option value="gemini::Gemini 3.5 Flash (Medium)">Gemini Flash</option>'
    + '</select>'
    + '<button id="kd-btn-run" class="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-xs font-semibold transition-colors">🧪 開始彙整</button>'
    + '<span id="kd-last-run" class="text-[11px] text-slate-400 dark:text-slate-500"></span>'
    + '<span id="kd-status-line" class="text-[11px] text-cyan-600 dark:text-cyan-400"></span>'
    + '</div>'
    + '<div id="kd-summary-line" class="px-4 pb-3 text-xs text-slate-600 dark:text-slate-300"></div>'
    + '</div>'
    + '<div id="kd-proposal-box" class="hidden"></div>'

    + '<div class="rounded-xl border border-amber-200 dark:border-amber-700/60 bg-amber-50/60 dark:bg-amber-900/10 shadow-sm overflow-hidden">'
    + '<div class="flex items-center justify-between px-4 py-2.5 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-700/50">'
    + '<span class="text-xs font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wider">💡 排程精華待審</span>'
    + '<button id="sched-btn-refresh-candidates" class="text-[11px] text-amber-500 hover:text-amber-700 dark:hover:text-amber-300 transition-colors">重新整理</button>'
    + '</div>'
    + '<div id="sched-candidates-content" class="px-4 py-3 space-y-3"></div>'
    + '<div id="sched-candidates-pager" class="px-4 pb-3"></div>'
    + '</div>'
    + '</div>'

    + '<div id="sched-pane-act" class="hidden">'
    + '<div class="rounded-xl border border-slate-200 dark:border-slate-700/60 bg-white dark:bg-slate-900/50 shadow-sm overflow-hidden">'
    + '<div class="flex items-center justify-between px-4 py-2.5 bg-slate-50/80 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-700/50">'
    + '<span class="text-xs font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wider">📢 近期動態</span>'
    + '<button id="sched-btn-refresh-activities" class="text-[11px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors">重新整理</button>'
    + '</div>'
    + '<div id="sched-activities-content" class="px-4 py-3 text-sm text-slate-400 dark:text-slate-500 min-h-[2.5rem]">載入中…</div>'
    + '<div id="sched-activities-pager" class="px-4 pb-3"></div>'
    + '</div>'
    + '</div>'
    + '</div>'

    + '<div id="sched-detail-view" class="hidden">'
    + '<div class="flex items-center gap-3 mb-6">'
    + '<button id="sched-btn-back" class="px-3 py-1.5 rounded-lg bg-slate-200 hover:bg-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 text-xs font-medium text-slate-600 dark:text-slate-300 transition-all">← 返回</button>'
    + '<h2 id="sched-detail-name" class="text-xl font-bold text-slate-900 dark:text-white"></h2>'
    + '<span id="sched-detail-status-badge" class="px-2 py-0.5 rounded-full text-xs font-semibold"></span>'
    + '</div>'
    + '<div id="sched-detail-meta" class="mb-4 text-sm text-slate-500 dark:text-slate-400 space-y-1"></div>'
    + '<div class="flex items-center justify-between mb-3">'
    + '<h3 class="text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">執行紀錄</h3>'
    + '<button id="sched-clear-btn" class="text-[11px] px-2 py-1 rounded-lg bg-slate-100 hover:bg-red-50 dark:bg-slate-800 dark:hover:bg-red-900/20 text-slate-500 hover:text-red-600 dark:text-slate-400 dark:hover:text-red-400 transition-colors border border-transparent hover:border-red-200 dark:hover:border-red-800">清理逐字稿…</button>'
    + '</div>'
    + '<div id="sched-runs-list"></div>'
    + '<div id="sched-run-detail" class="hidden mt-4 p-4 rounded-xl bg-white dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60 shadow-sm">'
    + '<div class="flex items-center justify-between mb-3">'
    + '<span class="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase">執行內容（唯讀）</span>'
    + '<div class="flex items-center gap-2">'
    + mdToggleBtn('sched-run-md-toggle', false)
    + '<button id="sched-run-detail-close" class="text-slate-400 hover:text-slate-700 dark:hover:text-white text-lg leading-none">✕</button>'
    + '</div>'
    + '</div>'
    + '<div class="mb-3">'
    + '<div class="text-[10px] font-semibold text-slate-400 uppercase mb-1">回覆</div>'
    + '<div id="sched-run-detail-reply" class="text-xs text-slate-700 dark:text-slate-300 max-h-[60vh] overflow-y-auto bg-slate-50 dark:bg-slate-900/40 rounded p-2"></div>'
    + '</div>'
    + '<details class="group">'
    + '<summary class="cursor-pointer select-none text-[10px] font-semibold text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 uppercase mb-1">查看本次 Prompt</summary>'
    + '<div id="sched-run-detail-prompt" class="mt-1 text-xs text-slate-700 dark:text-slate-300 max-h-32 overflow-y-auto bg-slate-50 dark:bg-slate-900/40 rounded p-2"></div>'
    + '</details>'
    + '</div>'
    + '</div>'

    + '<div id="sched-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">'
    + '<div class="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-lg mx-4 p-6 space-y-4">'
    + '<div class="flex items-center justify-between">'
    + '<h3 id="sched-modal-title" class="text-base font-bold text-slate-900 dark:text-white">新增排程</h3>'
    + '<button id="sched-modal-close" class="text-slate-400 hover:text-slate-700 dark:hover:text-white text-xl leading-none">✕</button>'
    + '</div>'
    + '<div class="space-y-3">'
    + '<div>'
    + '<label class="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">名稱</label>'
    + '<input id="sched-f-name" type="text" placeholder="例：每日摘要" class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-cyan-500">'
    + '</div>'
    + '<div>'
    + '<label class="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">觸發方式</label>'
    + '<select id="sched-f-trigger-type" class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-cyan-500">'
    + '<option value="cron">Cron 表達式</option>'
    + '<option value="interval">間隔（分鐘）</option>'
    + '<option value="once">單次（指定時間）</option>'
    + '<option value="manual">手動觸發（不排時間）</option>'
    + '</select>'
    + '</div>'
    + '<div id="sched-f-trigger-cron">'
    + '<label class="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">Cron 表達式（分 時 日 月 週）</label>'
    + '<input id="sched-f-cron-expr" type="text" placeholder="0 9 * * *（每天早上 9 點）" class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-cyan-500">'
    + '<p class="text-xs text-slate-400 mt-1">支援：數字、*、*/N。範例：<code>*/30 * * * *</code>=每 30 分鐘、<code>0 8 * * 1</code>=每週一早上 8 點</p>'
    + '</div>'
    + '<div id="sched-f-trigger-interval" class="hidden">'
    + '<label class="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">間隔（分鐘）</label>'
    + '<input id="sched-f-interval-min" type="number" min="1" placeholder="60" class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-cyan-500">'
    + '</div>'
    + '<div id="sched-f-trigger-once" class="hidden">'
    + '<label class="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">執行時間</label>'
    + '<input id="sched-f-once-at" type="datetime-local" class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-cyan-500">'
    + '</div>'
    + '<div id="sched-f-trigger-manual" class="hidden">'
    + '<p class="text-xs text-slate-500 dark:text-slate-400 px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-800/60">不排時間，永遠不會自動跑；要執行時在清單按「▶ 立即」，或讓別的排程用「成功後接續」接上它。</p>'
    + '</div>'
    + '<div>'
    + '<label class="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">任務內容（Prompt）</label>'
    + '<textarea id="sched-f-prompt" rows="3" placeholder="例：請摘要今天的 run log，並判斷是否有異常" class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-cyan-500 resize-none"></textarea>'
    + '</div>'
    + '<div>'
    + '<label class="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">模型</label>'
    + '<select id="sched-f-model" class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-cyan-500">'
    + '<option value="claude::sonnet">Claude Sonnet（推薦）</option>'
    + '<option value="claude::opus">Claude Opus</option>'
    + '<option value="claude::haiku">Claude Haiku</option>'
    + '<option value="gemini::Gemini 3.5 Flash (Medium)">Gemini Flash</option>'
    + '</select>'
    + '</div>'
    + '<details class="text-xs text-slate-500 dark:text-slate-400">'
    + '<summary class="cursor-pointer font-semibold text-slate-600 dark:text-slate-300">護欄設定（選填）</summary>'
    + '<div class="mt-2 space-y-2 pl-2">'
    + '<div class="flex items-center gap-2">'
    + '<label class="w-32 shrink-0">連續失敗熔斷</label>'
    + '<input id="sched-f-failbreak" type="number" min="1" value="3" class="w-20 px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-white">'
    + '<span>次</span>'
    + '</div>'
    + '<div class="flex items-center gap-2">'
    + '<label class="w-32 shrink-0">最長執行時間</label>'
    + '<input id="sched-f-maxruntime" type="number" min="1" value="5" class="w-20 px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-white">'
    + '<span>分鐘</span>'
    + '</div>'
    + '</div>'
    + '</details>'
    + '<div>'
    + '<label class="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">完成通知</label>'
    + '<div class="flex items-center gap-4 pl-1">'
    + '<label class="flex items-center gap-1.5 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">'
    + '<input type="checkbox" id="sched-f-delivery-web" checked class="accent-cyan-600"> 站內'
    + '</label>'
    + '<label class="flex items-center gap-1.5 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">'
    + '<input type="checkbox" id="sched-f-delivery-telegram" checked class="accent-cyan-600"> Telegram'
    + '</label>'
    + '</div>'
    + '</div>'
    + '<div>'
    + '<label class="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">成功後接續（選填）</label>'
    + '<select id="sched-f-chainnext" class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-cyan-500">'
    + '<option value="">（不接續）</option>'
    + '</select>'
    + '<p class="text-xs text-slate-400 mt-1">此排程<b>真正成功</b>後，自動立即觸發選定的排程（失敗／受阻／等待限額都不接）。被接的排程可維持停用。</p>'
    + '<label class="flex items-center gap-1.5 text-sm text-slate-700 dark:text-slate-300 cursor-pointer mt-2" id="sched-f-postrun-deploy-label">'
    + '<input type="checkbox" id="sched-f-postrun-deploy" class="accent-cyan-600"> 執行成功後自動重新佈署（Deploy_Harness.ps1）'
    + '</label>'
    + '<p class="text-xs text-slate-400 mt-1" id="sched-f-postrun-deploy-hint">佈署會重啟服務，因此只能設在沒有接續排程的最後一棒。</p>'
    + '<div class="mt-2" id="sched-f-nextafterdeploy-wrap">'
    + '<label class="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">部署成功後接續（選填，可跨工作區）</label>'
    + '<select id="sched-f-nextafterdeploy" class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-cyan-500">'
    + '<option value="">（不接續）</option>'
    + '</select>'
    + '<p class="text-xs text-slate-400 mt-1">新版上線、確認<b>佈署成功</b>後才觸發；佈署失敗回滾或結果未知都不接。</p>'
    + '</div>'
    + '</div>'
    + '</div>'
    + '<input type="hidden" id="sched-f-edit-id">'
    + '<div class="flex justify-end gap-3 pt-2">'
    + '<button id="sched-modal-cancel" class="px-4 py-2 rounded-lg bg-slate-200 hover:bg-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 text-sm font-medium text-slate-700 dark:text-slate-200 transition-all">取消</button>'
    + '<button id="sched-modal-save" class="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-sm font-semibold transition-all shadow">儲存</button>'
    + '</div>'
    + '</div>'
    + '</div>'

    + '</div>';

  container.querySelectorAll('[data-act="sched-tab"]').forEach(btn =>
    btn.addEventListener('click', () => switchTab(btn.getAttribute('data-tab'))));
  switchTab(activeTab);

  container.querySelector('#sched-btn-new').addEventListener('click', schedOpenNew);
  container.querySelector('#sched-btn-refresh-list').addEventListener('click', () => { schedLoadList(); loadActivities(); });
  container.querySelector('#sched-btn-refresh-activities').addEventListener('click', loadActivities);
  container.querySelector('#sched-btn-refresh-candidates').addEventListener('click', loadCandidates);
  container.querySelector('#sched-btn-back').addEventListener('click', schedBackToList);
  container.querySelector('#sched-clear-btn').addEventListener('click', schedClearTranscriptsDialog);
  container.querySelector('#sched-run-detail-close').addEventListener('click', () => container.querySelector('#sched-run-detail').classList.add('hidden'));
  container.querySelector('[data-act="sched-run-md-toggle"]').addEventListener('click', () => { schedRunDetailRawMode = !schedRunDetailRawMode; renderSchedRunDetail(); });
  container.querySelector('#sched-modal-close').addEventListener('click', schedCloseModal);
  container.querySelector('#sched-modal-cancel').addEventListener('click', schedCloseModal);
  container.querySelector('#sched-modal-save').addEventListener('click', schedSave);
  container.querySelector('#sched-f-trigger-type').addEventListener('change', schedUpdateTriggerUI);
  container.querySelector('#sched-f-chainnext').addEventListener('change', schedUpdatePostRunDeployUI);
  container.querySelector('#sched-f-postrun-deploy').addEventListener('change', schedUpdatePostRunDeployUI);
}

export function mount(root, ctx) {
  container = root;
  if (typeof window.showPanel === 'function') window.showPanel('__view_root__');
  root.classList.remove('hidden');
  if (typeof window.highlightMenuBtn === 'function') window.highlightMenuBtn('menu-scheduler');

  const pathEl = document.getElementById('header-file-path'); if (pathEl) pathEl.innerText = '排程任務';
  const titleEl = document.getElementById('header-file-title'); if (titleEl) titleEl.innerText = '定時自動執行任務，不需開瀏覽器';
  const vscodeEl = document.getElementById('btn-vscode'); if (vscodeEl) vscodeEl.href = '#';
  const savedEl = document.getElementById('last-saved'); if (savedEl) savedEl.classList.add('hidden');
  const backEl = document.getElementById('btn-back'); if (backEl) backEl.classList.add('hidden');

  activeTab = 'list';                                   // 每次進來都停在列表（最常看的那一頁）
  PAGE.list = PAGE.hist = PAGE.cand = PAGE.act = 1;
  render();
  schedBackToList();
  schedLoadList();
  loadActivities();
  loadCandidates(); // H5: load unreviewed memory candidates
  kdInit(); // KD2: 知識精華收斂工具條 + 既有提案（若有）
  window.addEventListener('resize', onResizeRedrawChains);
  if (typeof lucide !== 'undefined') lucide.createIcons();
  startScheduleStream(); // SLV: 開 SSE 連線，免手動重整
}

export function unmount() {
  clearTimeout(schedRefreshTimer);
  clearTimeout(kdPollTimer);
  window.removeEventListener('resize', onResizeRedrawChains);
  stopScheduleStream(); // SLV: router mount/unmount 合約——切走此檢視務必關掉連線，避免殘留累積
  if (container) { container.classList.add('hidden'); container.innerHTML = ''; }
  container = null;
  // SBA: 批量歸檔確認彈窗掛在 document.body（非 container 底下），離開畫面時務必清掉，避免殘留。
  const batchModal = document.getElementById('sched-batch-modal');
  if (batchModal) batchModal.remove();
  schedSelectedExplicit = { list: new Set(), hist: new Set() };
  schedSelected = { list: new Set(), hist: new Set() };
}

// SPEC-view-chat-context.md §3.1/CTX2: let the avatar float-chat know "am I looking at the whole
// schedule list, or one particular schedule's detail". D2/D3: follows the screen — list page → the
// whole workspace's list; a detail page open → just that one schedule. _schedCurrentDetailId isn't
// reset by schedBackToList() (H3 only tracks "which schedule was last opened", not "am I still
// there"), so detail-vs-list is read from the DOM (#sched-detail-view visibility), not that flag alone.
export function getChatContext() {
  if (!container) return null;
  const detailView = container.querySelector('#sched-detail-view');
  const inDetail = _schedCurrentDetailId && detailView && !detailView.classList.contains('hidden');
  if (inDetail) {
    const nameEl = container.querySelector('#sched-detail-name');
    const label = (nameEl && nameEl.textContent) || _schedCurrentDetailId;
    return { kind: 'schedule', key: 'schedule:' + _schedCurrentDetailId, label, payload: { scheduleId: _schedCurrentDetailId } };
  }
  return { kind: 'schedule', key: 'schedule:list', label: '排程清單（本工作區）', payload: { scope: 'list' } };
}

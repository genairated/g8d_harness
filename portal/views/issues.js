// SPEC-issue-report.md §5.3／IR2 — 問題回報頁（平台內建 view）。
// 版面：同一頁左右分欄——左清單、右內容（跟會議／文件管理／排程一致）；網址 ?id=N 可直接開到某一筆。
// 重播用 vendor 內的 rrweb.Replayer（預設 iframe sandbox，錄製檔裡的樣式／腳本進不了平台本身）。
// 問題單所有工作區共用一份（D2，刻意不套工作區過濾）。本階段唯讀：改狀態是 IR3。

export const meta = { route: '/app/issues', title: '問題回報', icon: 'flag', menuGroup: 'issues' };

const OPEN_STATUSES = ['待處理', '處理中', '已修正待驗證'];
const ALL_STATUSES = ['待處理', '處理中', '已修正待驗證', '已結案', '不處理'];
const STATUS_CLS = {
  '待處理': 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  '處理中': 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  '已修正待驗證': 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  '已結案': 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  '不處理': 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
};

const state = { list: [], status: 'open', type: '', selectedId: null, detail: null, detailErr: '' };
let container = null;
let replayer = null;
let replayTimer = null;
let loadSeq = 0;            // 防止快速連點時，慢回來的舊請求蓋掉新的
let rrwebPromise = null;
let listSeq = 0;            // IRR：清單請求序號，慢回來的舊結果丟掉
let pollTimer = null;       // IRR：可見時每 15 秒輕量重抓清單
let listLoadedOnce = false; // 第一次載入不做「新筆高亮」
let countNote = '';         // 附在 #iss-count 後的提示（更新失敗／新回報被篩選擋住）
let refreshing = false;
const POLL_MS = 15000;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function typeLabel(t) { return t === 'feature' ? '新需求' : '問題'; }
function fmtTime(iso) {
  const d = new Date(iso); if (isNaN(d)) return esc(iso || '');
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function wsName(w) { if (!w) return '—'; const s = String(w).replace(/[\\/]+$/, ''); return s.split(/[\\/]/).pop() || s; }
function browserOf(ua) {
  ua = String(ua || '');
  const m = /(Edg|Chrome|Firefox|Safari)\/([\d.]+)/.exec(ua);
  const name = m ? (m[1] === 'Edg' ? 'Edge' : m[1]) + ' ' + m[2].split('.')[0] : '';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return [name, os].filter(Boolean).join(' · ') || ua.slice(0, 60);
}
function statusChip(s) { return '<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold ' + (STATUS_CLS[s] || STATUS_CLS['不處理']) + '">' + esc(s) + '</span>'; }
function typeChip(t) {
  return '<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold ' + (t === 'feature' ? 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300' : 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300') + '">' + typeLabel(t) + '</span>';
}

// ── 網址 ?id= ──
function readIdFromUrl() { const m = /[?&]id=(\d+)/.exec(location.search || ''); return m ? parseInt(m[1], 10) : null; }
function syncUrl(id) {
  const url = location.pathname + (id ? '?id=' + id : '');
  try { history.replaceState(history.state, '', url); } catch (e) {}
}

// ── 畫面骨架 ──
const SHELL = `
<section class="flex-1 overflow-hidden flex h-full bg-slate-50/50 dark:bg-slate-900/40">
  <div id="iss-left" class="w-80 flex-shrink-0 border-r border-slate-200 dark:border-slate-800 flex flex-col bg-white/40 dark:bg-slate-900/30">
    <div class="p-3 border-b border-slate-200 dark:border-slate-800 flex-shrink-0 space-y-2">
      <div class="flex items-center gap-2">
        <select id="iss-f-status" class="flex-1 min-w-0 px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs text-slate-800 dark:text-slate-100">
          <option value="open">未結案</option><option value="all">全部狀態</option>
          ${ALL_STATUSES.map(s => '<option value="' + s + '">' + s + '</option>').join('')}
        </select>
        <select id="iss-f-type" class="w-24 px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs text-slate-800 dark:text-slate-100">
          <option value="">全部類型</option><option value="bug">問題</option><option value="feature">新需求</option>
        </select>
      </div>
      <div class="flex items-center gap-2">
        <div id="iss-count" class="flex-1 min-w-0 text-[11px] text-slate-400 dark:text-slate-500"></div>
        <button id="iss-refresh" type="button" title="重新整理" aria-label="重新整理" class="flex-shrink-0 p-1 rounded-md text-slate-500 hover:text-cyan-600 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-60"><i data-lucide="refresh-cw" class="w-3.5 h-3.5"></i></button>
      </div>
    </div>
    <div id="iss-list" class="flex-1 overflow-y-auto"></div>
  </div>
  <div id="iss-right" class="flex-1 min-w-0 overflow-y-auto"></div>
</section>`;

// ── 清單 ──
function visibleList() {
  return state.list.filter(i => {
    if (state.status === 'open' && !OPEN_STATUSES.includes(i.status)) return false;
    if (state.status !== 'open' && state.status !== 'all' && i.status !== state.status) return false;
    if (state.type && i.type !== state.type) return false;
    return true;
  });
}

function updateCount() {
  const cnt = container && container.querySelector('#iss-count'); if (!cnt) return;
  cnt.textContent = '顯示 ' + visibleList().length + ' 筆（共 ' + state.list.length + ' 筆）' + (countNote ? '　' + countNote : '');
}

function renderList() {
  const box = container && container.querySelector('#iss-list'); if (!box) return;
  const rows = visibleList();
  updateCount();
  if (!state.list.length) {
    box.innerHTML = '<div class="p-6 text-center text-xs text-slate-400 dark:text-slate-500 leading-relaxed">還沒有回報。<br>按頭像旁的旗子，或按 Alt+Shift+R，送出第一筆。</div>';
    return;
  }
  if (!rows.length) {
    box.innerHTML = '<div class="p-6 text-center text-xs text-slate-400 dark:text-slate-500">這個篩選條件下沒有問題單。</div>';
    return;
  }
  box.innerHTML = rows.map(i => {
    const sel = i.id === state.selectedId;
    return '<button data-id="' + i.id + '" class="iss-row w-full text-left px-3 py-2.5 border-b border-slate-100 dark:border-slate-800/70 transition-colors '
      + (sel ? 'iss-selected bg-cyan-50 dark:bg-cyan-900/20 border-l-2 border-l-cyan-500' : 'hover:bg-slate-100/70 dark:hover:bg-slate-800/40') + '">'
      + '<div class="flex items-center gap-1.5 mb-1"><span class="text-[11px] font-mono font-bold text-slate-500 dark:text-slate-400">#' + i.id + '</span>' + typeChip(i.type) + statusChip(i.status) + '</div>'
      + '<div class="text-[13px] font-medium text-slate-800 dark:text-slate-100 truncate">' + esc(i.title) + '</div>'
      + '<div class="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500 truncate">' + esc(i.view || i.route || '—') + ' · ' + esc(wsName(i.workspace)) + ' · ' + fmtTime(i.createdAt) + '</div>'
      + '</button>';
  }).join('');
  box.querySelectorAll('.iss-row').forEach(b => b.addEventListener('click', () => selectIssue(parseInt(b.getAttribute('data-id'), 10))));
}

function listSig(a) { return a.map(i => i.id + '|' + i.status + '|' + i.title).join('\n'); }

function flashRows(ids) {
  const box = container && container.querySelector('#iss-list'); if (!box) return;
  ids.forEach(id => {
    const row = box.querySelector('.iss-row[data-id="' + id + '"]'); if (!row) return;
    row.style.transition = 'background-color 1.5s';
    row.style.backgroundColor = 'rgba(250,204,21,.35)';
    setTimeout(() => { row.style.backgroundColor = ''; }, 2000);
  });
}

// IRR-4：自動更新只提示、不重建右欄（重播器不受影響）；按「重新整理」才完整重抓。
function checkSelectedStale() {
  const box = container && container.querySelector('#iss-right');
  if (!box || !state.selectedId || !state.detail || state.detail.id !== state.selectedId) return;
  const cur = state.list.find(i => i.id === state.selectedId);
  let msg = '';
  if (!cur) msg = '這筆目前不在清單中（可能已被移除）。';
  else if (cur.status !== state.detail.status || cur.title !== state.detail.title) msg = '這筆有更新，按重新整理查看。';
  if (!msg || box.querySelector('#iss-stale')) return;
  const bar = document.createElement('div');
  bar.id = 'iss-stale';
  bar.className = 'sticky top-0 z-10 px-4 py-2 text-xs bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border-b border-amber-200 dark:border-amber-800 flex items-center gap-3';
  bar.innerHTML = '<span class="flex-1">' + esc(msg) + '</span><button type="button" class="px-2 py-0.5 rounded bg-amber-200/70 dark:bg-amber-800/60 font-semibold">重新整理</button>';
  bar.querySelector('button').addEventListener('click', manualRefresh);
  box.insertBefore(bar, box.firstChild);
}

async function loadList(opts) {
  opts = opts || {};
  const seq = ++listSeq;
  let data = null;
  try {
    const r = await fetch('/api/issues');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    data = Array.isArray(j) ? j : [];
  } catch (e) { data = null; }
  if (seq !== listSeq || !container) return !!data;   // 已有更新的請求或 view 已卸載
  if (!data) { countNote = '更新失敗，稍後重試'; updateCount(); return false; }
  countNote = '';
  const prevSig = listSig(state.list), prevIds = new Set(state.list.map(i => i.id));
  const first = !listLoadedOnce;
  state.list = data; listLoadedOnce = true;
  const fresh = first ? [] : data.filter(i => !prevIds.has(i.id));
  if (opts.createdId != null) {
    const hit = data.find(i => String(i.id) === String(opts.createdId));
    if (hit && !visibleList().includes(hit)) countNote = '有 1 筆新回報不在目前篩選內';
  }
  if (first || prevSig !== listSig(data)) {
    const box = container.querySelector('#iss-list'), top = box ? box.scrollTop : 0;
    renderList();
    if (box) box.scrollTop = top;
    flashRows(fresh.map(i => i.id));
  } else updateCount();
  checkSelectedStale();
  try { if (typeof window.refreshIssueBadge === 'function') window.refreshIssueBadge(); } catch (e) {}
  return true;
}

function setSpin(on) {
  const btn = container && container.querySelector('#iss-refresh'); if (!btn) return;
  btn.disabled = on;
  const ic = btn.querySelector('svg, i'); if (ic) ic.classList.toggle('animate-spin', on);
}

async function manualRefresh() {
  if (refreshing) return;
  refreshing = true; setSpin(true);
  try {
    await loadList();
    if (container && state.selectedId) await loadDetail(state.selectedId);
  } finally { refreshing = false; setSpin(false); }
}

function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
function startPoll() {
  stopPoll();
  if (document.visibilityState !== 'visible') return;
  pollTimer = setInterval(() => { if (document.visibilityState === 'visible') loadList(); }, POLL_MS);
}
function onVisibility() {
  if (!container) return;
  if (document.visibilityState === 'visible') { loadList(); startPoll(); } else stopPoll();
}
function onIssueCreated(e) { if (container) loadList({ createdId: e && e.detail ? e.detail.id : null }); }

// ── 選一筆 ──
async function selectIssue(id) {
  state.selectedId = id;
  syncUrl(id);
  renderList();
  await loadDetail(id);
}

async function loadDetail(id) {
  const seq = ++loadSeq;
  teardownReplay();
  state.detail = null; state.detailErr = '';
  renderRight(true);
  try {
    const r = await fetch('/api/issues/' + id);
    if (!r.ok) throw new Error(r.status === 404 ? '找不到這筆問題單' : ('HTTP ' + r.status));
    const d = await r.json();
    if (seq !== loadSeq) return;
    state.detail = d;
  } catch (e) {
    if (seq !== loadSeq) return;
    state.detailErr = e.message || String(e);
  }
  renderRight(false);
  if (state.detail) mountReplay(state.detail, seq);
}

function teardownReplay() {
  if (replayTimer) { clearInterval(replayTimer); replayTimer = null; }
  if (replayer) { try { replayer.pause(); } catch (e) {} try { replayer.destroy && replayer.destroy(); } catch (e) {} replayer = null; }
}

// ── 右欄 ──
function card(title, body, extra) {
  return '<section class="rounded-xl border border-slate-200 dark:border-slate-700/60 bg-white/70 dark:bg-slate-900/50 mb-4">'
    + '<div class="px-4 py-2.5 border-b border-slate-100 dark:border-slate-800 text-xs font-bold text-slate-600 dark:text-slate-300 flex items-center justify-between"><span>' + title + '</span>' + (extra || '') + '</div>'
    + '<div class="p-4">' + body + '</div></section>';
}
function kv(k, v) {
  return '<div class="flex gap-3 py-1 text-[12px]"><div class="w-24 flex-shrink-0 text-slate-400 dark:text-slate-500">' + k + '</div><div class="min-w-0 break-all text-slate-700 dark:text-slate-200">' + v + '</div></div>';
}

function renderRight(loading) {
  const box = container && container.querySelector('#iss-right'); if (!box) return;
  if (!state.selectedId) {
    box.innerHTML = '<div class="h-full flex items-center justify-center text-sm text-slate-400 dark:text-slate-500 p-6 text-center">從左邊挑一筆，這裡會顯示重播、環境與時間軸。</div>';
    return;
  }
  if (loading) { box.innerHTML = '<div class="p-6 text-sm text-slate-400">載入中…</div>'; return; }
  const it = state.detail;
  if (!it) { box.innerHTML = '<div class="p-6 text-sm text-rose-500">' + esc(state.detailErr || '讀取失敗') + '</div>'; return; }

  const env = it.env || {};
  const pickHtml = it.pick
    ? kv('指認位置', esc(it.pick.text ? '「' + it.pick.text + '」' : '') + ' <span class="font-mono text-[11px] text-slate-400">' + esc(it.pick.selector || it.pick.tag || '') + '</span>' + (it.pick.value ? '（當下值：' + esc(it.pick.value) + '）' : ''))
    : '';
  const envHtml = kv('所在畫面', esc(it.view || '—') + ' <span class="font-mono text-[11px] text-slate-400">' + esc(it.route || '') + '</span>')
    + kv('工作區', esc(it.workspace || '—'))
    + kv('平台版本', esc(it.version || '—'))
    + kv('瀏覽器', esc(browserOf(env.userAgent)) + (env.viewport ? '，視窗 ' + esc(env.viewport) : ''))
    + kv('建立時間', esc(fmtTime(it.createdAt)))
    + kv('重播紀錄', esc((it.replay && it.replay.events) || 0) + ' 筆事件'
      + (it.replay && it.replay.fromPageLoad ? '<span class="ml-2 px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 text-[10px]">紀錄自頁面載入起，可能不足 ' + esc((it.replay && it.replay.bufferMinutes) || '') + ' 分鐘</span>' : ''))
    + pickHtml;

  const errs = Array.isArray(it.errors) ? it.errors : [];
  const errHtml = errs.length
    ? errs.map(e => {
        const where = e.source ? (String(e.source).split('/').pop() + ':' + (e.line || 0)) : '';
        return '<div class="py-2 border-b border-slate-100 dark:border-slate-800 last:border-0"><div class="text-[12px] text-rose-600 dark:text-rose-400 break-all">' + esc(e.message || '') + '</div>'
          + (where ? '<div class="text-[11px] font-mono text-slate-400">' + esc(where) + '</div>' : '')
          + (e.stack ? '<pre class="mt-1 text-[10px] font-mono text-slate-500 dark:text-slate-400 whitespace-pre-wrap break-all max-h-32 overflow-auto">' + esc(e.stack) + '</pre>' : '') + '</div>';
      }).join('')
    : '<div class="text-xs text-slate-400">這段紀錄裡沒有前端錯誤。</div>';

  const reqs = Array.isArray(it.requests) ? it.requests : [];
  const reqHtml = reqs.length
    ? '<div class="overflow-x-auto"><table class="w-full text-[11px] font-mono"><tbody>' + reqs.map(r => {
        const bad = !r.status || r.status >= 400;
        return '<tr class="' + (bad ? 'iss-req-bad text-rose-600 dark:text-rose-400 font-semibold' : 'text-slate-500 dark:text-slate-400') + '"><td class="pr-2 py-0.5">' + esc(r.method) + '</td><td class="pr-2 break-all">' + esc(r.url) + '</td><td class="pr-2">' + (r.status || 'ERR') + '</td><td>' + esc(r.ms) + 'ms</td></tr>'
          + (bad && r.body ? '<tr class="text-rose-500/80"><td></td><td colspan="3" class="pb-1 break-all font-normal">' + esc(String(r.body).slice(0, 300)) + '</td></tr>' : '');
      }).join('') + '</tbody></table></div>'
    : '<div class="text-xs text-slate-400">這段紀錄裡沒有 API 請求。</div>';

  const files = Array.isArray(it.files) ? it.files : [];
  const imgHtml = files.length
    ? '<div class="flex flex-wrap gap-2">' + files.map(f => '<a href="/api/issues/' + it.id + '/files/' + encodeURIComponent(f) + '" target="_blank" rel="noopener" title="' + esc(f) + '"><img src="/api/issues/' + it.id + '/files/' + encodeURIComponent(f) + '" class="h-20 rounded border border-slate-200 dark:border-slate-700 object-cover"></a>').join('') + '</div>'
    : '';

  const hist = Array.isArray(it.history) ? it.history : [];
  const histHtml = hist.map(h => '<div class="text-[12px] py-0.5 text-slate-600 dark:text-slate-300"><span class="font-mono text-slate-400">' + esc(fmtTime(h.at)) + '</span> ' + esc(h.by || '') + '：' + esc(h.from || '—') + ' → <b>' + esc(h.to) + '</b>' + (h.note ? ' <span class="text-slate-400">（' + esc(h.note) + '）</span>' : '') + '</div>').join('')
    + (it.resolution ? '<div class="mt-3 p-3 rounded-lg bg-violet-50 dark:bg-violet-900/20 text-[12px] text-slate-700 dark:text-slate-200"><div class="font-bold mb-1">處理結果</div>' + esc(it.resolution.summary || '') + (it.resolution.version ? '<div class="text-slate-400 mt-1">上線版本：' + esc(it.resolution.version) + '</div>' : '') + '</div>' : '');

  const sess = Array.isArray(it.linkedSessions) ? it.linkedSessions : [];
  const sessHtml = sess.length
    ? sess.map(s => '<button data-sid="' + esc(s.sessionId) + '" class="iss-sess block w-full text-left px-2 py-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-[12px] text-cyan-700 dark:text-cyan-300 truncate">接回：' + esc(s.label || s.sessionId) + ' <span class="text-slate-400">· ' + esc(fmtTime(s.at)) + '</span></button>').join('')
    : '<div class="text-xs text-slate-400">還沒有討論過。在這一筆點頭像開始討論，對話會自動記在這裡。</div>';

  const wbHint = (it.view === 'whiteboard' || /whiteboard/.test(it.route || ''))
    ? '<div class="mt-2 text-[11px] text-amber-600 dark:text-amber-400">白板畫布不錄製，重播裡白板區會是空白；請看指認位置與貼圖。</div>' : '';

  box.innerHTML = '<div class="max-w-5xl mx-auto p-5">'
    + '<div class="mb-4"><div class="flex items-center gap-2 mb-1.5"><span class="text-sm font-mono font-bold text-slate-500">#' + it.id + '</span>' + typeChip(it.type) + statusChip(it.status) + '</div>'
    + '<h2 class="text-lg font-bold text-slate-900 dark:text-white break-words">' + esc(it.title) + '</h2>'
    + '<p class="mt-1.5 text-[13px] text-slate-600 dark:text-slate-300 whitespace-pre-wrap break-words">' + esc(it.description) + '</p></div>'
    + card('操作重播', '<div id="iss-replay"><div class="text-xs text-slate-400">重播載入中…</div></div>' + wbHint)
    + card('環境資訊', envHtml)
    + (imgHtml ? card('貼圖', imgHtml) : '')
    + card('文字時間軸', it.timeline ? '<pre id="iss-timeline" class="text-[11px] font-mono text-slate-600 dark:text-slate-300 whitespace-pre-wrap break-words max-h-80 overflow-auto">' + esc(it.timeline) + '</pre>' : '<div class="text-xs text-slate-400">沒有時間軸。</div>')
    + card('錯誤列表（' + errs.length + '）', errHtml)
    + card('API 紀錄（' + reqs.length + '）', reqHtml)
    + card('處理紀錄', histHtml || '<div class="text-xs text-slate-400">沒有紀錄。</div>')
    + card('討論過的對話（' + sess.length + '）', sessHtml)
    + '</div>';
  box.querySelectorAll('.iss-sess').forEach(b => b.addEventListener('click', () => resumeSession(b.getAttribute('data-sid'))));
  if (typeof lucide !== 'undefined') { try { lucide.createIcons(); } catch (e) {} }
}

// 接回討論過的對話：沿用頭像浮動對話既有的開窗與續接（_openFloatChatWithContext + fcResume），不自造。
async function resumeSession(sid) {
  try {
    const ctx = getChatContext();
    if (typeof window._openFloatChatWithContext === 'function' && ctx) await window._openFloatChatWithContext(ctx);
    if (typeof window.fcResume === 'function') await window.fcResume(sid);
  } catch (e) { console.error('[issues] resume session failed:', e); }
}

// ── 重播 ──
function ensureRrweb() {
  if (window.rrweb && window.rrweb.Replayer) return Promise.resolve();
  if (rrwebPromise) return rrwebPromise;
  rrwebPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = '/vendor/rrweb/rrweb.umd.min.js';
    s.onload = () => (window.rrweb && window.rrweb.Replayer) ? resolve() : reject(new Error('rrweb 載入後沒有 Replayer'));
    s.onerror = () => { rrwebPromise = null; reject(new Error('rrweb 載入失敗')); };
    document.head.appendChild(s);
  });
  return rrwebPromise;
}
function ensureRrwebCss() {
  if (document.getElementById('iss-rrweb-css')) return;
  const l = document.createElement('link'); l.id = 'iss-rrweb-css'; l.rel = 'stylesheet'; l.href = '/vendor/rrweb/rrweb.min.css';
  document.head.appendChild(l);
}
function fmtMs(ms) { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

async function mountReplay(it, seq) {
  const box = container && container.querySelector('#iss-replay'); if (!box) return;
  const fail = msg => { if (seq === loadSeq && box.isConnected) box.innerHTML = '<div class="text-xs text-amber-600 dark:text-amber-400">' + esc(msg) + '　（問題單其他資訊仍可使用）</div>'; };
  try {
    const r = await fetch('/api/issues/' + it.id + '/replay');
    if (!r.ok) return fail('重播資料讀取失敗（HTTP ' + r.status + '）');
    const events = await r.json();
    if (seq !== loadSeq) return;
    if (!Array.isArray(events) || events.length < 2) return fail('這筆沒有可重播的紀錄（事件不足）。');
    ensureRrwebCss();
    await ensureRrweb();
    if (seq !== loadSeq || !box.isConnected) return;

    box.innerHTML =
      '<div id="iss-stage" class="relative overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700 bg-white" style="width:100%"></div>'
      + '<div class="mt-2 flex items-center gap-3">'
      + '<button id="iss-play" class="px-3 py-1 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-xs font-semibold flex-shrink-0">播放</button>'
      + '<input id="iss-seek" type="range" min="0" max="1000" value="0" class="flex-1 min-w-0">'
      + '<span id="iss-time" class="text-[11px] font-mono text-slate-500 flex-shrink-0">0:00 / 0:00</span></div>'
      + '<div id="iss-pick-note" class="mt-1 text-[11px] text-slate-400"></div>';
    const stage = box.querySelector('#iss-stage');
    const meta0 = events.find(e => e && e.type === 4 && e.data);
    const vw = (meta0 && meta0.data.width) || 1280, vh = (meta0 && meta0.data.height) || 720;

    // 不覆寫 sandbox：rrweb 預設把重播放進 sandbox iframe（禁腳本），錄製檔裡的樣式／腳本碰不到平台。
    const rp = new window.rrweb.Replayer(events, { root: stage, mouseTail: false, skipInactive: false });
    replayer = rp;
    const total = rp.getMetaData().totalTime || 1;

    const wrapper = stage.querySelector('.replayer-wrapper');
    function fit() {
      const w = stage.clientWidth || 800, s = Math.min(1, w / vw);
      if (wrapper) { wrapper.style.transformOrigin = 'top left'; wrapper.style.transform = 'scale(' + s + ')'; }
      stage.style.height = Math.round(vh * s) + 'px';
    }
    fit();
    const ro = (typeof ResizeObserver === 'function') ? new ResizeObserver(fit) : null; if (ro) ro.observe(stage);

    const playBtn = box.querySelector('#iss-play'), seek = box.querySelector('#iss-seek'), timeEl = box.querySelector('#iss-time'), noteEl = box.querySelector('#iss-pick-note');
    let playing = false, dragging = false;
    function paintTime(cur) { timeEl.textContent = fmtMs(cur) + ' / ' + fmtMs(total); if (!dragging) seek.value = String(Math.round(cur / total * 1000)); }

    // 指認框紅：以 selector 在重播 iframe 裡找元素，疊一個紅框（座標與重播畫面同一空間，隨縮放）。
    let pickBox = null;
    function paintPick() {
      if (!it.pick || !it.pick.selector || !wrapper) return;
      let el = null;
      try { const doc = rp.iframe && rp.iframe.contentDocument; el = doc ? doc.querySelector(it.pick.selector) : null; } catch (e) { el = null; }
      if (!el) { if (pickBox) pickBox.style.display = 'none'; noteEl.textContent = '重播畫面裡找不到指認的元素，指認文字：' + (it.pick.text || it.pick.selector); return; }
      const b = el.getBoundingClientRect();
      if (!pickBox) {
        pickBox = document.createElement('div'); pickBox.id = 'iss-pick-box';
        pickBox.style.cssText = 'position:absolute;pointer-events:none;border:3px solid #ef4444;background:rgba(239,68,68,.12);border-radius:4px;z-index:50;box-sizing:border-box';
        wrapper.appendChild(pickBox);
      }
      pickBox.style.display = 'block';
      pickBox.style.left = b.left + 'px'; pickBox.style.top = b.top + 'px'; pickBox.style.width = b.width + 'px'; pickBox.style.height = b.height + 'px';
      noteEl.textContent = '紅框＝指揮官指出的位置：' + (it.pick.text ? '「' + it.pick.text + '」' : it.pick.selector);
    }

    function setPlaying(v) { playing = v; playBtn.textContent = v ? '暫停' : '播放'; }
    playBtn.addEventListener('click', () => {
      if (playing) { rp.pause(); setPlaying(false); paintPick(); return; }
      const cur = rp.getCurrentTime();
      rp.play(cur >= total - 50 ? 0 : cur); setPlaying(true);
    });
    seek.addEventListener('input', () => { dragging = true; const t = seek.value / 1000 * total; paintTime(t); });
    seek.addEventListener('change', () => {
      const t = seek.value / 1000 * total; dragging = false;
      if (playing) rp.play(t); else { rp.pause(t); setTimeout(paintPick, 30); }
    });
    rp.on('finish', () => { setPlaying(false); paintTime(total); paintPick(); });
    replayTimer = setInterval(() => { try { if (playing) { paintTime(rp.getCurrentTime()); if (it.pick) paintPick(); } } catch (e) {} }, 250);

    // 預設停在送出那一刻（最後一幀）
    rp.pause(total);
    paintTime(total);
    setTimeout(() => { fit(); paintPick(); }, 80);
    setTimeout(paintPick, 400);
    box.dataset.ready = '1';
  } catch (e) {
    console.error('[issues] replay failed:', e);
    fail('重播無法顯示：' + (e && e.message || e));
  }
}

// ── view 契約 ──
export function mount(root, ctx) {
  container = root;
  if (typeof window.showPanel === 'function') window.showPanel('__view_root__');
  root.classList.remove('hidden');
  if (typeof window.highlightMenuBtn === 'function') window.highlightMenuBtn('menu-issues');
  const pathEl = document.getElementById('header-file-path'); if (pathEl) pathEl.innerText = '問題回報';
  const titleEl = document.getElementById('header-file-title'); if (titleEl) titleEl.innerText = '回報給 Hana 的問題與新需求；點一筆看重播，點頭像跟 Hana 討論';
  const vscodeEl = document.getElementById('btn-vscode'); if (vscodeEl) vscodeEl.href = '#';
  const savedEl = document.getElementById('last-saved'); if (savedEl) savedEl.classList.add('hidden');
  const backEl = document.getElementById('btn-back'); if (backEl) backEl.classList.add('hidden');

  listLoadedOnce = false; countNote = ''; refreshing = false;
  state.list = []; state.selectedId = readIdFromUrl(); state.detail = null; state.detailErr = '';
  root.innerHTML = SHELL;
  const fs = root.querySelector('#iss-f-status'), ft = root.querySelector('#iss-f-type');
  fs.value = state.status; ft.value = state.type;
  fs.addEventListener('change', () => { state.status = fs.value; renderList(); });
  ft.addEventListener('change', () => { state.type = ft.value; renderList(); });
  root.querySelector('#iss-refresh').addEventListener('click', manualRefresh);
  window.addEventListener('harness:issue-created', onIssueCreated);
  document.addEventListener('visibilitychange', onVisibility);
  startPoll();
  renderList(); renderRight(false);
  (async () => {
    await loadList();
    // 網址帶的那筆即使被預設篩選（未結案）擋掉，也要能開；開到時把篩選放寬，讓左邊看得到高亮
    if (state.selectedId) {
      const hit = state.list.find(i => i.id === state.selectedId);
      if (hit && !visibleList().includes(hit)) { state.status = 'all'; fs.value = 'all'; renderList(); }
      await loadDetail(state.selectedId);
    }
  })();
  if (typeof lucide !== 'undefined') { try { lucide.createIcons(); } catch (e) {} }
}

export function unmount() {
  loadSeq++; listSeq++;
  stopPoll();
  window.removeEventListener('harness:issue-created', onIssueCreated);
  document.removeEventListener('visibilitychange', onVisibility);
  teardownReplay();
  if (container) { container.classList.add('hidden'); container.innerHTML = ''; }
  container = null;
  state.selectedId = null; state.detail = null;
}

// SPEC-view-chat-context.md／IR2-5：兩層脈絡。payload 只帶識別（scope／issueId），內容由後端現讀。
export function getChatContext() {
  if (state.selectedId) {
    const t = state.detail && state.detail.title;
    return { kind: 'issue', key: 'issue:' + state.selectedId, label: '問題單 #' + state.selectedId + (t ? '：' + t : ''), payload: { scope: 'detail', issueId: state.selectedId } };
  }
  return { kind: 'issue', key: 'issue:list', label: '問題回報清單', payload: { scope: 'list' } };
}

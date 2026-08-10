// SPEC-portal-architecture.md §V4 — 排程任務 view 模組（自 index.html 完整搬移，行為不變）。
// 同 V8/V9 手法：DOM 動態建置進 mount() 的 container；inline onclick 改 addEventListener；
// 共用的 window.escapeHtml/highlightMenuBtn/showPanel/showToast 沿用既有 index.html 全域函式。

export const meta = { route: '/app/schedule', title: '排程任務', icon: 'clock', menuGroup: 'schedule' };

let container = null;
let schedRefreshTimer = null; // SCHED-14: 有 run 執行中時輕量輪詢

const STATUS_BADGE = {
  success:  'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  failed:  'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  running: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  interrupted: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  'limited-waiting': 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  blocked: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
};
// SSTAT-03: display label per status key; falls back to the raw key for the others.
const STATUS_LABEL = { blocked: '⚠ 受阻·待你', interrupted: '⛔ 中斷' };

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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

async function schedLoadList() {
  const listEl = container.querySelector('#sched-list-content');
  if (!listEl) return;
  try {
    const all = await (await fetch('/api/schedules')).json();
    refreshSchedBadge();   // 清單載入＝排程資料可能剛變動（啟停/觸發/刪除/歸檔都會回頭叫這裡）
    if (!all.length) {
      listEl.innerHTML = '<div class="text-center py-16 text-slate-400 dark:text-slate-500 text-sm">尚無排程。點「+ 新增排程」建立第一個。</div>';
      return;
    }
    const nameById = {}; all.forEach(s => { nameById[s.id] = s.name; });
    // SCHED-CHAIN: 把串接的排程排在一起（鏈頭→被接者相鄰），清單才看得出接續關係。
    const active  = orderScheduleChains(all.filter(s => !s.archived));
    const history = orderScheduleChains(all.filter(s => s.archived));
    const row = (s, hist) => `
      <tr data-sched-id="${s.id}" data-chain-next="${(s.chainNext && nameById[s.chainNext]) ? s.chainNext : ''}" class="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors cursor-pointer" data-act="open-detail" data-id="${s.id}">
        <td class="px-3 py-3 font-medium text-slate-900 dark:text-white min-w-[12rem]">${escHtml(s.name)}</td>
        <td class="px-3 py-3 text-slate-500 dark:text-slate-400 font-mono text-xs whitespace-nowrap">${escHtml(triggerLabel(s.trigger))}</td>
        <td class="px-3 py-3 text-slate-500 dark:text-slate-400 text-xs whitespace-nowrap">${escHtml(s.model || '')}</td>
        <td class="px-3 py-3 text-slate-500 dark:text-slate-400 text-xs whitespace-nowrap">${hist ? fmtDate(s.lastRunAt) : fmtDate(s.nextRunAt)}</td>
        <td class="px-3 py-3 whitespace-nowrap">
          ${s.running
            ? `<div class="flex flex-col gap-0.5">
                 <span class="px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_BADGE.running} inline-flex items-center gap-1 w-fit"><span class="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>執行中</span>
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
    const tableWrap = (rows, nextLabel) => `
     <div class="chain-wrap relative pl-6">
      <svg class="chain-links pointer-events-none absolute inset-0 w-full h-full z-20 overflow-visible"></svg>
      <div class="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700/60 shadow-sm">
        <table class="w-full text-sm">
          <thead class="bg-slate-100/60 dark:bg-slate-800/60">
            <tr class="text-left text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              <th class="px-3 py-3">名稱</th><th class="px-3 py-3">觸發</th><th class="px-3 py-3">模型</th>
              <th class="px-3 py-3 whitespace-nowrap">${nextLabel}</th><th class="px-3 py-3 whitespace-nowrap">最近狀態</th><th class="px-3 py-3">佈署</th><th class="px-3 py-3">啟用</th><th class="px-3 py-3">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-200 dark:divide-slate-700/50">${rows}</tbody>
        </table>
      </div>
     </div>`;
    // SCHED-PAGE: 表很長，現役／歷史各自分頁（鏈順序已先算好，切頁只是取窗格）。
    const pageOf = (arr, page, size) => {
      const pages = Math.max(1, Math.ceil(arr.length / size));
      const p = Math.min(Math.max(1, page), pages);
      return { p, items: arr.slice((p - 1) * size, p * size) };
    };
    const act = pageOf(active, PAGE.list, listPageSize);   PAGE.list = act.p;
    const his = pageOf(history, PAGE.hist, listPageSize);  PAGE.hist = his.p;

    let html = active.length
      ? tableWrap(act.items.map(s => row(s, false)).join(''), '下次執行')
        + `<div data-pager="list">${pagerHtml(active.length, PAGE.list, listPageSize, { sizes: [10, 20, 50, 100] })}</div>`
      : '<div class="text-center py-10 text-slate-400 dark:text-slate-500 text-sm">目前沒有現役排程。</div>';
    if (history.length) {
      html += `
        <details class="mt-4 group" ${PAGE.hist > 1 ? 'open' : ''}>
          <summary class="cursor-pointer select-none px-1 py-2 text-xs font-semibold text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
            <i data-lucide="chevron-right" class="h-3.5 w-3.5 transition-transform group-open:rotate-90"></i>📜 歷史（已歸檔 ${history.length}）
          </summary>
          <div class="mt-2 opacity-80">${tableWrap(his.items.map(s => row(s, true)).join(''), '上次執行')}
            <div data-pager="hist">${pagerHtml(history.length, PAGE.hist, listPageSize, null)}</div>
          </div>
        </details>`;
    }
    listEl.innerHTML = html;
    bindListActions(listEl);
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
  listEl.querySelectorAll('[data-act="edit"]').forEach(el => el.addEventListener('click', ev => { ev.stopPropagation(); schedEdit(el.getAttribute('data-id')); }));
  listEl.querySelectorAll('[data-act="delete"]').forEach(el => el.addEventListener('click', ev => { ev.stopPropagation(); schedDelete(el.getAttribute('data-id')); }));
}

// Archive a schedule to「歷史」(also pause it) / restore it back to active.
async function schedArchive(id, archived) {
  const body = archived ? { archived: true, enabled: false } : { archived: false };
  try {
    await fetch(`/api/schedules/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    schedLoadList();
  } catch (e) { window.showToast && window.showToast('歸檔失敗：' + e.message, 'error'); }
}

let _schedCurrentDetailId = null; // H3: track which schedule is in detail view

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
  container.querySelector('#sched-detail-meta').innerHTML = `
    <div>觸發：<span class="font-mono">${escHtml(triggerLabel(s.trigger))}</span></div>
    <div>模型：${escHtml(s.model)}</div>
    <div>下次執行：${fmtDate(s.nextRunAt)}</div>
    <div>上次執行：${fmtDate(s.lastRunAt)}</div>
    <div class="mt-2 text-xs bg-slate-100 dark:bg-slate-800/40 rounded p-2 font-mono">${escHtml(s.task.prompt || '')}</div>`;

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

async function schedOpenRun(schedId, runId) {
  const r = await (await fetch(`/api/runs/${runId}`)).json();
  const el = container.querySelector('#sched-run-detail');
  const promptEl = container.querySelector('#sched-run-detail-prompt');
  const replyEl  = container.querySelector('#sched-run-detail-reply');
  promptEl.textContent = ''; replyEl.textContent = '';

  // H2: load session JSON (chat_sched_<runId>.json) for prompt + reply.
  // H3: if transcriptCleared flag set or session 404, show "逐字稿已清理".
  if (r.transcriptCleared) {
    promptEl.textContent = '（逐字稿已清理）';
  } else {
    try {
      const sessRes = await fetch(`/api/chat/history/sched_${runId}`);
      if (sessRes.ok) {
        const sess = await sessRes.json();
        const msgs = sess.messages || [];
        const userMsg = msgs.find(m => m.role === 'user');
        const aiMsg   = msgs.find(m => m.role === 'assistant');
        promptEl.textContent = (userMsg && userMsg.content && userMsg.content.slice(0, 3000)) || '（無 prompt）';
        replyEl.textContent  = (aiMsg && aiMsg.content) || '（無回覆）';
      } else {
        promptEl.textContent = '（逐字稿已清理）';
      }
    } catch (e) {
      promptEl.textContent = r.error || '（無法讀取）';
    }
  }
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
  schedUpdatePostRunDeployUI();

  if (id) {
    try {
      const s = await (await fetch(`/api/schedules/${id}`)).json();
      container.querySelector('#sched-f-chainnext').value = s.chainNext || '';
      container.querySelector('#sched-f-postrun-deploy').checked = !!(s.postRun && s.postRun.deploy === true);
      schedUpdatePostRunDeployUI();
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
    postRun: { deploy: container.querySelector('#sched-f-postrun-deploy').checked },  // SCHED-DEPLOY
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
    const statusIcon = { success: '✅', failed: '❌', 'limited-waiting': '⏳', running: '🔄', aborted: '🛑', blocked: '⚠️' };
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
    + '<button id="sched-btn-new" class="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-sm font-semibold transition-all shadow">+ 新增排程</button>'
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
    + '<button id="sched-run-detail-close" class="text-slate-400 hover:text-slate-700 dark:hover:text-white text-lg leading-none">✕</button>'
    + '</div>'
    + '<div class="mb-3">'
    + '<div class="text-[10px] font-semibold text-slate-400 uppercase mb-1">Prompt</div>'
    + '<pre id="sched-run-detail-prompt" class="text-xs text-slate-700 dark:text-slate-300 whitespace-pre-wrap max-h-32 overflow-y-auto bg-slate-50 dark:bg-slate-900/40 rounded p-2"></pre>'
    + '</div>'
    + '<div>'
    + '<div class="text-[10px] font-semibold text-slate-400 uppercase mb-1">回覆</div>'
    + '<pre id="sched-run-detail-reply" class="text-xs text-slate-700 dark:text-slate-300 whitespace-pre-wrap max-h-64 overflow-y-auto bg-slate-50 dark:bg-slate-900/40 rounded p-2"></pre>'
    + '</div>'
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
  container.querySelector('#sched-btn-refresh-activities').addEventListener('click', loadActivities);
  container.querySelector('#sched-btn-refresh-candidates').addEventListener('click', loadCandidates);
  container.querySelector('#sched-btn-back').addEventListener('click', schedBackToList);
  container.querySelector('#sched-clear-btn').addEventListener('click', schedClearTranscriptsDialog);
  container.querySelector('#sched-run-detail-close').addEventListener('click', () => container.querySelector('#sched-run-detail').classList.add('hidden'));
  container.querySelector('#sched-modal-close').addEventListener('click', schedCloseModal);
  container.querySelector('#sched-modal-cancel').addEventListener('click', schedCloseModal);
  container.querySelector('#sched-modal-save').addEventListener('click', schedSave);
  container.querySelector('#sched-f-trigger-type').addEventListener('change', schedUpdateTriggerUI);
  container.querySelector('#sched-f-chainnext').addEventListener('change', schedUpdatePostRunDeployUI);
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
  window.addEventListener('resize', onResizeRedrawChains);
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

export function unmount() {
  clearTimeout(schedRefreshTimer);
  window.removeEventListener('resize', onResizeRedrawChains);
  if (container) { container.classList.add('hidden'); container.innerHTML = ''; }
  container = null;
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

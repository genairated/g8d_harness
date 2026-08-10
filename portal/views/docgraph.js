// SPEC-portal-architecture.md §V3 — DocGraph 知識圖譜 view 模組（自 index.html 完整搬移，行為不變）。
// 依賴 index.html 仍保留的共用全域 function（傳統 <script> 的 function 宣告掛在 window 上，
// ESM 動態 import() 可直接呼叫）：window.showPanel / window.highlightMenuBtn / window.loadFile。
// 另需 window.lucide（圖示渲染），由 index.html 既有的 CDN <script> 掛在 window 上。

export const meta = { route: '/app/docgraph', title: 'DocGraph 知識圖譜', icon: 'git-fork', menuGroup: 'docgraph' };

let container = null;
let dgActiveId = null;
let dgCurrentTab = 'impact';
let dgSearchTimer = null;

function dgEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function field(id) { return container.querySelector('#' + id); }

function dgBadge(type) {
  const colors = { R: 'bg-purple-500/15 text-purple-600 dark:text-purple-300', F: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300', SPEC: 'bg-blue-500/15 text-blue-600 dark:text-blue-300', TEST: 'bg-amber-500/15 text-amber-600 dark:text-amber-300', BR: 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-300', LP: 'bg-pink-500/15 text-pink-600 dark:text-pink-300', ADR: 'bg-sky-500/15 text-sky-600 dark:text-sky-300', CASE: 'bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-300', DOC: 'bg-slate-500/15 text-slate-500 dark:text-slate-400' };
  return `<span class="px-1.5 py-0.5 rounded text-[10px] font-bold font-mono flex-shrink-0 ${colors[type] || colors.DOC}">${dgEsc(type)}</span>`;
}

function dgNodeRow(n, withDepth) {
  const depth = (withDepth && n.depth !== undefined) ? `<span class="text-[10px] font-mono text-cyan-600 dark:text-cyan-400 flex-shrink-0 w-6">d${n.depth}</span>` : '';
  const title = (n.title && n.title !== n.id) ? `<span class="text-[11px] text-slate-500 dark:text-slate-400 truncate">${dgEsc(n.title)}</span>` : '';
  const file = n.file ? `<span class="text-[10px] text-slate-400 dark:text-slate-600 font-mono truncate ml-auto flex-shrink-0 max-w-[38%]">${dgEsc(n.file)}</span>` : '';
  return `<div data-dg-id="${dgEsc(n.id)}" class="flex items-center gap-2 px-3 py-2 rounded-lg border border-transparent hover:border-slate-200 dark:hover:border-slate-800 hover:bg-white/60 dark:hover:bg-slate-800/40 cursor-pointer transition-all">${depth}${dgBadge(n.type)}<span class="text-[13px] font-mono font-semibold text-slate-700 dark:text-slate-200 truncate">${dgEsc(n.id)}</span>${title}${file}</div>`;
}

function handleDgSearchKey(e) { if (e.key === 'Enter') performDgSearch(); }
function setDgDemoQuery(q) { field('dg-search-input').value = q; performDgSearch(); }

function performDgSearch() {
  const q = field('dg-search-input').value.trim();
  const list = field('dg-results-list');
  field('dg-results-title').innerText = '搜尋結果';
  if (!q) { field('dg-results-count').innerText = '0'; return; }
  clearTimeout(dgSearchTimer);
  dgSearchTimer = setTimeout(async () => {
    try {
      const data = await (await fetch('/api/docgraph/search?q=' + encodeURIComponent(q))).json();
      field('dg-results-count').innerText = data.rows.length;
      list.innerHTML = data.rows.length ? data.rows.map(n => dgNodeRow(n, false)).join('') : '<div class="py-10 text-center text-xs text-slate-400 dark:text-slate-500">無相符節點</div>';
    } catch (e) {
      list.innerHTML = `<div class="py-10 text-center text-xs text-red-500">查詢失敗: ${dgEsc(e.message)}</div>`;
    }
  }, 160);
}

async function loadDgGaps() {
  const list = field('dg-results-list');
  field('dg-results-title').innerText = '缺口稽核';
  list.innerHTML = '<div class="py-10 text-center text-xs text-slate-400">載入中…</div>';
  try {
    const g = await (await fetch('/api/docgraph/gaps')).json();
    const pill = (id, type) => `<span data-dg-id="${dgEsc(id)}" class="cursor-pointer inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-200 dark:border-slate-800 bg-white/50 dark:bg-slate-900/40 hover:border-cyan-500 text-[11px] font-mono">${type ? dgBadge(type) : ''}${dgEsc(id)}</span>`;
    const sec = (title, items, render) => `<div class="mb-4"><div class="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">${title} (${items.length})</div>${items.length ? '<div class="flex flex-wrap gap-1.5">' + items.map(render).join('') + '</div>' : '<div class="text-xs text-emerald-600 dark:text-emerald-400">無 ✓</div>'}</div>`;
    field('dg-results-count').innerText = (g.dangling.length + g.missingRight.length + g.missingLeft.length);
    list.innerHTML =
      sec('🔴 斷鏈（被引用但未定義）', g.dangling, d => pill(d.id, d.type)) +
      sec('🟠 SPEC 缺 TEST', g.missingRight, id => pill(id, 'SPEC')) +
      sec('🟠 TEST 缺 SPEC', g.missingLeft, id => pill(id, 'TEST'));
  } catch (e) {
    list.innerHTML = `<div class="py-10 text-center text-xs text-red-500">稽核失敗: ${dgEsc(e.message)}</div>`;
  }
}

async function dgSelectNode(id) {
  dgActiveId = id;
  field('dg-details-empty').classList.add('hidden');
  field('dg-details-content').classList.remove('hidden');
  await dgLoadTab(dgCurrentTab, true);
}

function dgSetActiveTabStyle(tab) {
  ['impact', 'refs', 'trace'].forEach(t => {
    field('dg-tab-content-' + t).classList.toggle('hidden', t !== tab);
    const btn = field('dg-tab-btn-' + t);
    if (btn) {
      btn.classList.toggle('border-cyan-500', t === tab);
      btn.classList.toggle('text-cyan-600', t === tab);
      btn.classList.toggle('dark:text-cyan-400', t === tab);
      btn.classList.toggle('border-transparent', t !== tab);
    }
  });
}

async function dgLoadTab(tab, refreshHeader) {
  dgCurrentTab = tab;
  dgSetActiveTabStyle(tab);
  const listEl = field('dg-' + tab + '-list');
  listEl.innerHTML = '<div class="py-6 text-center text-xs text-slate-400">載入中…</div>';
  try {
    const data = await (await fetch('/api/docgraph/' + tab + '?id=' + encodeURIComponent(dgActiveId))).json();
    if (refreshHeader) {
      const n = data.node || { id: dgActiveId, type: '?', title: '', file: '' };
      field('dg-active-type').innerText = n.type || '?';
      field('dg-active-id').innerText = n.id || dgActiveId;
      field('dg-active-title').innerText = (n.title && n.title !== n.id) ? n.title : '';
      field('dg-active-file').innerText = n.file || '';
      const openBtn = field('dg-active-open-btn');
      if (n.file && /\.md$/i.test(n.file)) { openBtn.classList.remove('hidden'); openBtn.dataset.file = n.file; }
      else openBtn.classList.add('hidden');
    }
    const rows = data.rows || [];
    const badge = field('dg-' + tab + '-badge'); if (badge) badge.innerText = rows.length;
    listEl.innerHTML = rows.length ? rows.map(n => dgNodeRow(n, tab === 'impact')).join('') : '<div class="py-8 text-center text-xs text-slate-400 dark:text-slate-500">（無）</div>';
  } catch (e) {
    listEl.innerHTML = `<div class="py-8 text-center text-xs text-red-500">載入失敗: ${dgEsc(e.message)}</div>`;
  }
}
function switchDgTab(tab) { dgLoadTab(tab, false); }

function dgOpenFile() {
  const f = field('dg-active-open-btn').dataset.file;
  if (f && typeof window.loadFile === 'function') window.loadFile(f);
}

async function loadDgStats() {
  try {
    const s = await (await fetch('/api/docgraph/stats')).json();
    const m = s.meta || {};
    const titleEl = document.getElementById('header-file-title');
    if (titleEl) titleEl.innerText = `profile=${m.profile || '?'} · ${s.edges} edges · indexed ${(m.indexedAt || '').slice(0, 10)}`;
  } catch (e) {}
}

function render() {
  container.innerHTML = `
    <section class="flex-1 overflow-hidden flex flex-col h-full bg-slate-100/15 dark:bg-slate-900/15">
      <!-- Search Bar -->
      <div class="p-6 border-b border-slate-200 dark:border-slate-800 bg-white/40 dark:bg-slate-900/30 flex flex-wrap items-center gap-4 flex-shrink-0">
        <div class="flex-1 min-w-[280px] relative">
          <i data-lucide="search" class="absolute left-3.5 top-[11px] h-4.5 w-4.5 text-slate-400 dark:text-slate-500"></i>
          <input type="text" id="dg-search-input" placeholder="搜尋治理節點：id 或標題（如: SPEC-WORKORDER、途程、R-MFG-0001、F-0032）..." class="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl pl-11 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/20 focus:border-cyan-500 text-slate-800 dark:text-slate-200 transition-all shadow-sm">
        </div>
        <button id="dg-search-btn" class="flex items-center space-x-2 px-5 py-2.5 rounded-xl bg-cyan-600 hover:bg-cyan-700 text-white text-xs font-semibold shadow-md shadow-cyan-500/10 hover:shadow-cyan-500/20 transition-all">
          <i data-lucide="search" class="h-4 w-4"></i>
          <span>搜尋節點</span>
        </button>
        <button id="dg-gaps-btn" class="flex items-center space-x-2 px-4 py-2.5 rounded-xl bg-amber-500/10 hover:bg-amber-500 border border-amber-500/30 hover:border-amber-500 text-amber-600 hover:text-white dark:text-amber-400 dark:hover:text-white text-xs font-semibold transition-all">
          <i data-lucide="shield-alert" class="h-4 w-4"></i>
          <span>缺口稽核</span>
        </button>
      </div>

      <!-- Split Layout Workspace -->
      <div class="flex-1 flex overflow-hidden">
        <!-- Left Pane: Results -->
        <div class="w-1/2 md:w-5/12 border-r border-slate-200 dark:border-slate-800 flex flex-col bg-white/10 dark:bg-slate-900/10">
          <div class="px-5 py-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/20 flex items-center justify-between flex-shrink-0">
            <span id="dg-results-title" class="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">搜尋結果</span>
            <span id="dg-results-count" class="text-[10px] px-2 py-0.5 rounded-full bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400 font-mono font-bold">0</span>
          </div>
          <div id="dg-results-list" class="flex-1 overflow-y-auto p-4 space-y-1.5">
            <!-- Welcome Panel -->
            <div id="dg-welcome-panel" class="py-12 px-6 text-center space-y-4 max-w-sm mx-auto">
              <div class="h-12 w-12 rounded-full bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 flex items-center justify-center mx-auto shadow-inner">
                <i data-lucide="git-fork" class="h-6 w-6 animate-pulse"></i>
              </div>
              <div class="space-y-1.5">
                <h4 class="text-sm font-semibold text-slate-800 dark:text-slate-200">開始探索 DocGraph</h4>
                <p class="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">搜尋法規／需求／規格節點，檢視它的影響範圍、引用者與依賴來龍去脈。</p>
              </div>
              <div class="p-3.5 rounded-xl border border-slate-200/60 dark:border-slate-800/80 bg-slate-50 dark:bg-slate-950/40 text-left text-xs text-slate-500 dark:text-slate-400 space-y-2">
                <div class="font-semibold text-slate-700 dark:text-slate-300">💡 試試看:</div>
                <ul class="list-disc pl-4 space-y-1 font-mono text-[11px]">
                  <li><a href="#" data-dg-demo="SPEC-PRODUCT-ROUTING" class="text-cyan-600 hover:underline dark:text-cyan-400">SPEC-PRODUCT-ROUTING</a> (途程規格)</li>
                  <li><a href="#" data-dg-demo="R-MFG-0001" class="text-cyan-600 hover:underline dark:text-cyan-400">R-MFG-0001</a> (需求 → 影響範圍)</li>
                  <li><a href="#" data-dg-demo="F-0032" class="text-cyan-600 hover:underline dark:text-cyan-400">F-0032</a> (功能單元)</li>
                  <li><a href="#" data-dg-demo="途程" class="text-cyan-600 hover:underline dark:text-cyan-400">途程</a> (標題關鍵字)</li>
                </ul>
              </div>
            </div>
          </div>
        </div>

        <!-- Right Pane: Node Detail & Relations -->
        <div id="dg-details-pane" class="w-1/2 md:w-7/12 flex flex-col bg-white/25 dark:bg-slate-900/25 overflow-hidden">
          <div id="dg-details-empty" class="flex-1 flex flex-col items-center justify-center text-center p-12 text-slate-400 dark:text-slate-500">
            <i data-lucide="info" class="h-8 w-8 text-slate-300 dark:text-slate-700 mb-3"></i>
            <span class="text-xs font-medium">請從左側點擊一個節點以檢視其關係</span>
          </div>

          <div id="dg-details-content" class="flex-1 flex flex-col overflow-hidden hidden">
            <!-- Active Node Header -->
            <div class="p-6 border-b border-slate-200 dark:border-slate-800 bg-white/60 dark:bg-slate-900/60 flex-shrink-0 flex items-start justify-between">
              <div class="space-y-1.5 flex-1 min-w-0 pr-4">
                <div class="flex items-center space-x-2.5">
                  <span id="dg-active-type" class="px-2 py-0.5 rounded text-[10px] font-bold tracking-wide uppercase bg-cyan-600/15 text-cyan-700 dark:text-cyan-300">TYPE</span>
                  <h3 id="dg-active-id" class="text-base font-display font-semibold text-slate-800 dark:text-slate-100 truncate font-mono">activeNodeId</h3>
                </div>
                <p id="dg-active-title" class="text-xs text-slate-500 dark:text-slate-400 truncate"></p>
                <p id="dg-active-file" class="text-[11px] text-slate-400 dark:text-slate-500 font-mono truncate"></p>
              </div>
              <div class="flex flex-col space-y-2 flex-shrink-0">
                <button id="dg-active-open-btn" class="hidden flex items-center justify-center space-x-1.5 px-3 py-1.5 rounded-lg bg-cyan-600/10 hover:bg-cyan-600 border border-cyan-500/20 hover:border-cyan-500/50 text-xs font-semibold text-cyan-600 hover:text-white dark:text-cyan-400 dark:hover:text-white transition-all shadow-sm">
                  <i data-lucide="book-open" class="h-3.5 w-3.5"></i>
                  <span>開啟文件</span>
                </button>
              </div>
            </div>

            <!-- Tab Buttons -->
            <div class="border-b border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/20 flex-shrink-0 flex px-4">
              <button data-dg-tab="impact" id="dg-tab-btn-impact" class="px-4 py-3 border-b-2 border-transparent text-xs font-bold text-slate-500 dark:text-slate-455 hover:text-slate-800 dark:hover:text-white transition-all flex items-center space-x-1.5">
                <i data-lucide="activity" class="h-3.5 w-3.5"></i>
                <span>受影響 (Impact)</span>
                <span id="dg-impact-badge" class="text-[9px] px-1.5 py-0.2 rounded bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400 font-mono font-bold">0</span>
              </button>
              <button data-dg-tab="refs" id="dg-tab-btn-refs" class="px-4 py-3 border-b-2 border-transparent text-xs font-bold text-slate-500 dark:text-slate-455 hover:text-slate-800 dark:hover:text-white transition-all flex items-center space-x-1.5">
                <i data-lucide="log-in" class="h-3.5 w-3.5"></i>
                <span>誰引用它 (Refs)</span>
                <span id="dg-refs-badge" class="text-[9px] px-1.5 py-0.2 rounded bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400 font-mono font-bold">0</span>
              </button>
              <button data-dg-tab="trace" id="dg-tab-btn-trace" class="px-4 py-3 border-b-2 border-transparent text-xs font-bold text-slate-500 dark:text-slate-455 hover:text-slate-800 dark:hover:text-white transition-all flex items-center space-x-1.5">
                <i data-lucide="log-out" class="h-3.5 w-3.5"></i>
                <span>它依賴誰 (Trace)</span>
                <span id="dg-trace-badge" class="text-[9px] px-1.5 py-0.2 rounded bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400 font-mono font-bold">0</span>
              </button>
            </div>

            <!-- Tab Content -->
            <div class="flex-1 overflow-y-auto p-6">
              <div id="dg-tab-content-impact" class="dg-tab-content hidden"><div id="dg-impact-list" class="space-y-1.5"></div></div>
              <div id="dg-tab-content-refs" class="dg-tab-content hidden"><div id="dg-refs-list" class="space-y-1.5"></div></div>
              <div id="dg-tab-content-trace" class="dg-tab-content hidden"><div id="dg-trace-list" class="space-y-1.5"></div></div>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;

  container.querySelector('#dg-search-input').addEventListener('keydown', handleDgSearchKey);
  container.querySelector('#dg-search-input').addEventListener('input', performDgSearch);
  container.querySelector('#dg-search-btn').addEventListener('click', performDgSearch);
  container.querySelector('#dg-gaps-btn').addEventListener('click', loadDgGaps);
  container.querySelectorAll('[data-dg-demo]').forEach(el => {
    el.addEventListener('click', (e) => { e.preventDefault(); setDgDemoQuery(el.getAttribute('data-dg-demo')); });
  });
  container.querySelectorAll('[data-dg-tab]').forEach(el => {
    el.addEventListener('click', () => switchDgTab(el.getAttribute('data-dg-tab')));
  });
  container.addEventListener('click', (e) => {
    const row = e.target.closest('[data-dg-id]');
    if (row) dgSelectNode(row.getAttribute('data-dg-id'));
  });
  container.querySelector('#dg-active-open-btn').addEventListener('click', dgOpenFile);
}

export function mount(root, ctx) {
  container = root;
  if (typeof window.showPanel === 'function') window.showPanel('__view_root__');
  root.classList.remove('hidden');
  if (typeof window.highlightMenuBtn === 'function') window.highlightMenuBtn('menu-docgraph');
  const pathEl = document.getElementById('header-file-path'); if (pathEl) pathEl.innerText = 'DocGraph Explorer';
  const titleEl = document.getElementById('header-file-title'); if (titleEl) titleEl.innerText = '探索法規 / 需求 / 規格的知識圖譜';
  const vscodeEl = document.getElementById('btn-vscode'); if (vscodeEl) vscodeEl.href = '#';
  const savedEl = document.getElementById('last-saved'); if (savedEl) savedEl.classList.add('hidden');
  const backEl = document.getElementById('btn-back'); if (backEl) backEl.classList.add('hidden');

  dgActiveId = null;
  dgCurrentTab = 'impact';
  render();
  if (typeof lucide !== 'undefined') lucide.createIcons();
  loadDgStats();
}

export function unmount() {
  clearTimeout(dgSearchTimer);
  if (container) { container.classList.add('hidden'); container.innerHTML = ''; }
  container = null;
  dgActiveId = null;
}

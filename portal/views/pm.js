// SPEC-portal-architecture.md §V10 — 專案管理（PM）view 模組。
// 沿用 V1 chat / V6 documents / V7 meeting 的「殼搬遷」手法（非 V2/V8/V9 的完整搬移）：PM 的業務邏輯
// （pmState/pmMulti 狀態機、清單/看板/甘特圖渲染、多專案對齊視圖的 scroll-sync/splitter-drag/觀測線拖曳
// ……近千行）與浮動聊天（openFloatChatForPm）等全站共用函式深度糾纏、體量遠大於 V8/V9，判斷完整拆分
// 風險/效益比不划算，故只把原本 index.html 裡 <section id="pm-panel"> 的靜態 DOM 殼動態建置進 #view-root，
// 並把 inline onclick/onchange 改成 addEventListener。所有業務邏輯（pmLoadProjects/pmRenderGantt/
// pmMultiRender/...）維持是 index.html 傳統 <script> 的全域 function 宣告，本檔透過 window.xxx 呼叫；
// 它們本就只用 document.getElementById 操作 DOM，不管這些 id 掛在哪個容器下都能正常運作（同 V1/V6/V7
// 已驗證的機制）。
//
// 離開面板 teardown（本階段重點）：原本 index.html 的 showPanel() 裡有一行
// `if (id !== 'pm-panel' && pmMulti.active) pmMultiDeactivate()`，靠「切到別的 panel id」偵測離開 pm、
// 藉此清掉多專案甘特圖的 scroll/drag/mousemove 監聽（含掛在 document 上的）。pm-panel DOM 消失後這行會
// 變成恆真式死碼（因為 '__view_root__' 永遠 !== 'pm-panel'，連「進入」pm 自己 mount() 呼叫的
// showPanel('__view_root__') 都會誤觸發，只是恰好當下 pmMulti.active 還是 false 而看不出問題）——已將
// 這行從 showPanel() 移除，改為本檔 unmount() 顯式呼叫 pmMultiDeactivate()，語意正確且不再依賴巧合。

export const meta = { route: '/app/pm', title: '專案管理', icon: 'folder-kanban', menuGroup: 'pm' };

let container = null;

const PANEL_HTML = `
    <!-- h-full：理由同 documents.js／meeting.js（#view-root 非 flex 容器，flex-1 不生效）。 -->
    <section class="flex-1 overflow-hidden flex h-full bg-slate-50/50 dark:bg-slate-900/40">
      <!-- Left: project list -->
      <div class="w-64 flex-shrink-0 border-r border-slate-200 dark:border-slate-800 flex flex-col bg-white/40 dark:bg-slate-900/30">
        <div class="p-3 border-b border-slate-200 dark:border-slate-800 flex-shrink-0 space-y-2">
          <button id="pm-new-project-btn" class="w-full px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-xs font-semibold transition-colors flex items-center justify-center gap-1.5"><i data-lucide="plus" class="h-3.5 w-3.5"></i>新專案</button>
          <div class="flex items-center rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5 text-xs font-medium">
            <button id="pm-scope-ws" class="flex-1 px-2 py-1 rounded-md transition-all">當前工作區</button>
            <button id="pm-scope-all" class="flex-1 px-2 py-1 rounded-md transition-all">全部</button>
          </div>
          <label class="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 select-none cursor-pointer">
            <input type="checkbox" id="pm-show-archived" class="rounded border-slate-300 dark:border-slate-600"> 顯示已封存
          </label>
        </div>
        <div id="pm-project-list" class="flex-1 overflow-y-auto p-2 space-y-1 text-sm text-slate-400">載入中…</div>
      </div>

      <!-- Right: main area -->
      <div id="pm-content" class="flex-1 flex flex-col overflow-hidden bg-slate-50 dark:bg-slate-900">
        <div id="pm-empty" class="flex-1 flex flex-col items-center justify-center text-slate-400 text-sm select-none">
          <i data-lucide="folder-kanban" class="h-12 w-12 mb-3 opacity-20"></i>
          <p>選擇左側專案，或<button id="pm-new-project-btn2" class="text-cyan-600 dark:text-cyan-400 underline mx-1">建立第一個專案</button></p>
        </div>
        <div id="pm-main" class="hidden flex-1 flex flex-col overflow-hidden">
          <div class="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/50 flex-wrap gap-2">
            <div class="flex items-center gap-2 min-w-0">
              <span id="pm-project-title" class="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate"></span>
              <button id="pm-archive-btn" class="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 flex-shrink-0" title="封存/取消封存專案"><i data-lucide="archive" class="h-3.5 w-3.5"></i></button>
              <button id="pm-delete-project-btn" class="text-xs text-slate-400 hover:text-rose-500 flex-shrink-0" title="刪除專案"><i data-lucide="trash-2" class="h-3.5 w-3.5"></i></button>
            </div>
            <div class="flex items-center gap-2">
              <div class="flex items-center rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5 text-xs font-medium">
                <button id="pm-view-overview" class="px-2.5 py-1 rounded-md transition-all">總覽</button>
                <button id="pm-view-list" class="px-2.5 py-1 rounded-md transition-all">清單</button>
                <button id="pm-view-kanban" class="px-2.5 py-1 rounded-md transition-all">看板</button>
                <button id="pm-view-gantt" class="px-2.5 py-1 rounded-md transition-all">甘特圖</button>
              </div>
              <button id="pm-auto-arrange-btn" class="px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-300 text-xs font-medium transition-colors flex items-center gap-1" title="依開始/結束時間，由上而下重新排序"><i data-lucide="arrow-down-wide-narrow" class="h-3.5 w-3.5"></i>自動排列</button>
              <button id="pm-export-btn" class="px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-300 text-xs font-medium transition-colors flex items-center gap-1" title="匯出 Excel（總覽／清單／甘特圖）"><i data-lucide="download" class="h-3.5 w-3.5"></i>匯出 Excel</button>
              <button class="pm-fullscreen-btn p-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-300 transition-colors" title="全螢幕"><i data-lucide="maximize" class="h-3.5 w-3.5"></i></button>
              <button id="pm-new-task-btn" class="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-xs font-semibold transition-all shadow">+ 新任務</button>
            </div>
          </div>
          <div class="flex-1 overflow-auto p-4">
            <div id="pm-view-overview-wrap" class="hidden"></div>
            <div id="pm-view-list-wrap"><div id="pm-task-table-wrap"></div></div>
            <div id="pm-view-kanban-wrap" class="hidden"></div>
            <div id="pm-view-gantt-wrap" class="hidden"></div>
          </div>
        </div>

        <!-- PM6: multi-project aligned Gantt + observation line — SPEC-project-management.md §6.5 -->
        <style>
          /* PM6 fix: individual panes/ruler scroll programmatically (kept in sync) but only the
             master bar (#pm-multi-hbar) shows a visible scrollbar — otherwise N projects → N+1 bars. */
          .pm-multi-noscrollbar::-webkit-scrollbar { display: none; }
          .pm-multi-noscrollbar { scrollbar-width: none; -ms-overflow-style: none; }
          .pm-multi-splitter { flex: 0 0 7px; cursor: row-resize; position: relative; }
          .pm-multi-splitter::after { content: ''; position: absolute; left: 0; right: 0; top: 2px; height: 3px; border-radius: 2px; background: rgba(148,163,184,0.4); }
          .pm-multi-splitter:hover::after, .pm-multi-splitter.dragging::after { background: rgba(6,182,212,0.7); }
        </style>
        <div id="pm-multi-wrap" class="hidden flex-1 flex flex-col overflow-hidden">
          <div class="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/50 flex-wrap gap-2 flex-shrink-0">
            <div class="flex items-center gap-2 min-w-0">
              <i data-lucide="layout-dashboard" class="h-4 w-4 text-slate-400 flex-shrink-0"></i>
              <span class="text-sm font-semibold text-slate-800 dark:text-slate-100">多專案對齊視圖</span>
              <span id="pm-multi-count" class="text-xs text-slate-400"></span>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-xs text-slate-400">觀測日</span>
              <span id="pm-multi-observe-date" class="text-xs font-mono font-semibold text-slate-600 dark:text-slate-300"></span>
              <button id="pm-multi-recenter-btn" class="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-xs font-medium text-slate-600 dark:text-slate-300 transition-colors flex items-center gap-1"><i data-lucide="undo-2" class="h-3 w-3"></i>回到畫面中央</button>
              <button class="pm-fullscreen-btn p-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-300 transition-colors" title="全螢幕"><i data-lucide="maximize" class="h-3.5 w-3.5"></i></button>
            </div>
          </div>
          <div id="pm-multi-legend" class="px-4 pt-2 flex-shrink-0"></div>
          <div id="pm-multi-readout" class="px-4 pb-2 flex-shrink-0 space-y-0.5"></div>
          <div id="pm-multi-panes" class="relative flex-1 flex flex-col overflow-hidden px-4 pb-4" style="min-height:0"></div>
        </div>
      </div>
    </section>`;

function wireEvents() {
  const $ = (sel) => container.querySelector(sel);
  const call = (name, ...args) => { if (typeof window[name] === 'function') window[name](...args); };

  $('#pm-new-project-btn').addEventListener('click', () => call('pmNewProject'));
  $('#pm-new-project-btn2').addEventListener('click', () => call('pmNewProject'));
  $('#pm-scope-ws').addEventListener('click', () => call('pmSetScope', 'workspace'));
  $('#pm-scope-all').addEventListener('click', () => call('pmSetScope', 'all'));
  $('#pm-show-archived').addEventListener('change', () => call('pmToggleArchived'));
  $('#pm-archive-btn').addEventListener('click', () => call('pmToggleProjectArchive'));
  $('#pm-delete-project-btn').addEventListener('click', () => call('pmDeleteProject'));
  $('#pm-view-overview').addEventListener('click', () => call('pmSetView', 'overview'));
  $('#pm-view-list').addEventListener('click', () => call('pmSetView', 'list'));
  $('#pm-view-kanban').addEventListener('click', () => call('pmSetView', 'kanban'));
  $('#pm-view-gantt').addEventListener('click', () => call('pmSetView', 'gantt'));
  $('#pm-new-task-btn').addEventListener('click', () => call('pmOpenTaskForm', null));
  $('#pm-auto-arrange-btn').addEventListener('click', () => call('pmAutoArrange'));
  $('#pm-export-btn').addEventListener('click', () => call('pmExportExcel'));
  $('#pm-multi-recenter-btn').addEventListener('click', () => call('pmMultiRecenter'));
  container.querySelectorAll('.pm-fullscreen-btn').forEach((btn) => {
    btn.addEventListener('click', () => call('pmToggleFullscreen'));
  });
}

export function mount(root, ctx) {
  container = root;
  if (typeof window.showPanel === 'function') window.showPanel('__view_root__');
  root.classList.remove('hidden');
  root.innerHTML = PANEL_HTML;
  if (typeof window.highlightMenuBtn === 'function') window.highlightMenuBtn('menu-pm');

  const pathEl = document.getElementById('header-file-path'); if (pathEl) pathEl.innerText = '專案管理';
  const titleEl = document.getElementById('header-file-title'); if (titleEl) titleEl.innerText = '規劃任意專案的任務、時程與相依（清單／看板／甘特圖）';
  const vscodeEl = document.getElementById('btn-vscode'); if (vscodeEl) vscodeEl.href = '#';
  const savedEl = document.getElementById('last-saved'); if (savedEl) savedEl.classList.add('hidden');
  const backEl = document.getElementById('btn-back'); if (backEl) backEl.classList.add('hidden');
  // historyStack = [] 原為 switchToPm() 的一部分——它是傳統 <script> 的模組作用域 let 綁定，ESM 拿不到，
  // 同 V8 notes 的既有取捨（只影響 wiki 返回堆疊的邊界情況，非本次範圍），未搬。

  wireEvents();
  if (typeof window.pmUpdateToggleUI === 'function') window.pmUpdateToggleUI();
  if (typeof window.pmLoadProjects === 'function') window.pmLoadProjects();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

export function unmount() {
  // 離開 pm 面板：teardown 多專案甘特圖 overlay 的 scroll/drag/mousemove 監聽（含掛在 document 上的），
  // 否則 pmMulti.listeners 會累積、且拖曳觀測線等監聽會在其他 view 上持續反應滑鼠事件。
  if (typeof window.pmMultiDeactivate === 'function') window.pmMultiDeactivate();
  if (container) { container.classList.add('hidden'); container.innerHTML = ''; }
  container = null;
}

// SPEC-view-chat-context.md §3.1/CTX3: report the gantt-checked project(s) to the avatar float-chat.
// window.getActivePmContext() (index.html, next to pmMulti/pmState) bridges in the selection this
// module can't see itself (classic <script> state, not visible to an ES module — see §V1 教訓).
export function getChatContext() {
  const r = (typeof window.getActivePmContext === 'function') ? window.getActivePmContext() : null;
  if (!r || !Array.isArray(r.projectIds) || !r.projectIds.length) return null;
  const key = 'pm:' + r.projectIds.slice().sort().join(',');
  return { kind: 'pm', key, label: r.label || r.projectIds.join('、'), payload: { pmProjectIds: r.projectIds } };
}

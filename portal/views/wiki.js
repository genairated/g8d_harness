// SPEC-portal-architecture.md §V11 — wiki/檔案檢視 view 模組。
//
// 沿用 V1 chat / V6 documents / V7 meeting / V10 pm 的「殼搬遷」手法（非 V2/V8/V9 的完整搬移）：wiki
// 的業務邏輯（loadFile/renderMarkdown/renderCodeFile/renderBpmnEditor/highlightActiveMenu/toggleMdEdit
// /saveMdFile/historyStack ……）是全站幾乎所有面板共用的核心基礎設施（開檔、VS Code 深連結、返回堆疊、
// DASHBOARD/TASK 檢視全靠它），糾纏面比 V6/V7/V10 更深、體量更大，判斷完整拆分風險/效益比不划算，故只把
// 原本 index.html 裡 <section id="wiki-panel"> 的靜態 DOM 殼（content-area + md-editor-area）動態建置
// 進 #view-root；業務邏輯原封不動留在 index.html 傳統 <script>（本就只用 document.getElementById 操作
// DOM，不管容器掛在哪都能正常運作，同其餘殼搬遷 view 已驗證的機制）。
//
// 本 view 的特殊之處：wiki 不像其餘面板只透過選單 router.navigate() 進入，它也是全站預設首頁、且被
// loadFile() 直接呼叫進入（點側欄檔案樹、DASHBOARD/TASK 選單、程式碼預覽「查看程式碼」連結、F1 mtime
// 自動重載……）。為此 index.html 新增了 ensureWikiView() 輔助函式，loadFile()/renderBpmnEditor() 內呼叫
// 它取代原本的 showPanel('wiki-panel')；為避免每次 loadFile 呼叫都重建殼（同一份 wiki 內部換檔會蓋掉正在
// 渲染的內容），router.js 新增 currentView 追蹤、同一 view 重複進入時 render() 直接 no-op（詳見
// router.js 的 currentView 註解與異動）。
//
// historyStack/返回鈕：wiki 是唯一實際依賴返回堆疊的 view（V8 notes/V10 pm 都選擇隱藏返回鈕、略過
// historyStack 清空，因為便條貼/PM 本就沒有這個返回機制）。本檔 mount()/unmount() 刻意不動 btn-back
// 與 historyStack——它們的顯示/清空邏輯完全由 loadFile()（已存在、未搬動）依 historyStack.length 自行
// 決定，維持原行為不變；若在 mount() 裡強制隱藏 btn-back（照搬 V8/V10 的省略），會把 wiki 本來就在用的
// 返回鈕功能打壞，這正是本階段任務特別提醒不能沿用 V8 省略的地方。

export const meta = { route: '/app/wiki', title: '檔案檢視', icon: 'file-text', menuGroup: 'wiki' };

let container = null;

// 與原 <section id="wiki-panel" class="flex-1 overflow-y-auto px-12 py-10"> 的差異：外層的
// flex-1/overflow-y-auto 現在由 #view-root 本身負責（R6 已賦予相同 class），這裡只需重建內層
// 「置中＋留白」的 wrapper，視覺效果等價。
const PANEL_HTML = `
    <div class="max-w-4xl mx-auto px-12 py-10">
      <!-- Rendered HTML Container -->
      <article id="content-area" class="prose prose-slate dark:prose-invert prose-custom max-w-none select-text animate-fade-in">
        <!-- Markdown parsed html will end up here -->
      </article>
      <!-- DIAG-P6-01: md editor (hidden by default, shown in edit mode) -->
      <div id="md-editor-area" class="hidden flex flex-col gap-3">
        <textarea id="md-editor-textarea" class="w-full font-mono text-sm bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg p-4 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 resize-y leading-relaxed" style="min-height:60vh" spellcheck="false"></textarea>
        <div class="flex items-center justify-between">
          <span id="md-editor-status" class="text-xs text-slate-400 dark:text-slate-500 font-mono"></span>
          <div class="flex space-x-2">
            <button id="wiki-md-cancel-btn" class="flex items-center space-x-2 px-4 py-2 rounded-lg bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 text-xs font-semibold transition-all">
              <i data-lucide="x" class="h-3.5 w-3.5"></i>
              <span>取消</span>
            </button>
            <button id="wiki-md-save-btn" class="flex items-center space-x-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold transition-all shadow-sm">
              <i data-lucide="save" class="h-3.5 w-3.5"></i>
              <span>儲存</span>
            </button>
          </div>
        </div>
      </div>
    </div>
`;

function wireEvents() {
  const $ = (sel) => container.querySelector(sel);
  const cancelBtn = $('#wiki-md-cancel-btn');
  if (cancelBtn) cancelBtn.addEventListener('click', () => { if (typeof window.cancelMdEdit === 'function') window.cancelMdEdit(); });
  const saveBtn = $('#wiki-md-save-btn');
  if (saveBtn) saveBtn.addEventListener('click', () => { if (typeof window.saveMdFile === 'function') window.saveMdFile(); });
}

export function mount(root) {
  container = root;
  if (typeof window.showPanel === 'function') window.showPanel('__view_root__');
  root.classList.remove('hidden');
  root.innerHTML = PANEL_HTML;
  wireEvents();
  if (typeof lucide !== 'undefined') lucide.createIcons();
  // 刻意不在這裡設定 header-file-path/title、不碰 btn-back/historyStack——這些都由呼叫方
  // ensureWikiView() 之後緊接著執行的 loadFile()（或 init() 的 DASHBOARD 空狀態分支）決定，
  // 本函式只負責把殼搭好。
}

export function unmount() {
  if (container) { container.classList.add('hidden'); container.innerHTML = ''; }
  container = null;
}

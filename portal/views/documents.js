// SPEC-portal-architecture.md §V6 — 文件管理 view 模組。
// 沿用 V1 chat 的「殼搬遷」手法（非 V8/V9 的完整搬移）：文件管理的業務邏輯（registry 載入/篩選、
// 擬真預覽、split-view md 編輯、doc-action-bar 動態渲染、BPMN embed 渲染……）與 loadFile()/
// renderBpmnEditor() 等全站共用函式深度糾纏、且體量極大（數千行），搬遷風險遠高於效益；本檔只負責
// 把原本 index.html 裡 <section id="documents-panel"> 的靜態 DOM 殼動態建置進 #view-root，並把
// inline onclick/oninput 改成 addEventListener。所有業務邏輯（loadDocumentRegistry/renderDocList/
// selectDocument/renderDocActionBar/toggleDocFilter/...）維持是 index.html 傳統 <script> 的全域
// function 宣告，本檔透過 window.xxx 呼叫；因為它們本來就只用 document.getElementById 操作 DOM，
// 不管這些 id 掛在哪個容器下都能正常運作（V1 chat 已驗證過同一手法）。

export const meta = { route: '/app/documents', title: '文件管理', icon: 'folder', menuGroup: 'documents' };

let container = null;

const PANEL_HTML = `
    <!-- h-full：#view-root 不是 flex 容器（它是 flex-1 overflow-y-auto 的捲動框），所以這層的
         flex-1 不會生效，少了 h-full 就只撐到內容高度＝面板只顯示一半。同 chat/notes/codegraph。 -->
    <section class="flex-1 overflow-hidden flex h-full bg-slate-50/50 dark:bg-slate-900/40">

      <!-- Left: Document List -->
      <div class="w-72 flex-shrink-0 border-r border-slate-200 dark:border-slate-800 flex flex-col bg-white/40 dark:bg-slate-900/30">
        <!-- Search + Filter (DOC-J6) -->
        <div class="p-3 border-b border-slate-200 dark:border-slate-800">
          <div class="flex items-center gap-2">
            <div class="relative flex-1 min-w-0">
              <i data-lucide="search" class="absolute left-3 top-[9px] h-3.5 w-3.5 text-slate-400"></i>
              <input id="doc-search" type="text" placeholder="搜尋文件…"
                class="w-full pl-8 pr-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs text-slate-700 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-cyan-500">
            </div>
            <button id="doc-recycle-toggle" title="檢視已刪除 / 資源回收桶"
              class="flex-shrink-0 p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-500 hover:border-rose-400 transition-colors">
              <i data-lucide="trash-2" class="h-4 w-4"></i>
            </button>
            <div class="relative">
              <button id="doc-filter-btn">篩選 ▾</button>
              <div id="doc-filter-popover">
                <div class="doc-filter-group">
                  <div class="doc-filter-group-label">型別</div>
                  <div id="doc-filter-type-chips" class="doc-filter-chips">
                    <button class="doc-filter-chip" data-group="types" data-value="doc">doc</button>
                    <button class="doc-filter-chip" data-group="types" data-value="block-deck">block-deck</button>
                  </div>
                </div>
                <div class="doc-filter-group">
                  <div class="doc-filter-group-label">來源</div>
                  <div class="doc-filter-chips">
                    <button class="doc-filter-chip" data-group="origins" data-value="imported">匯入</button>
                    <button class="doc-filter-chip" data-group="origins" data-value="generated">生成</button>
                  </div>
                </div>
                <div class="doc-filter-group">
                  <div class="doc-filter-group-label">狀態</div>
                  <div class="doc-filter-chips">
                    <button class="doc-filter-chip" data-group="states" data-value="original">原始</button>
                    <button class="doc-filter-chip" data-group="states" data-value="modified">已修改</button>
                  </div>
                </div>
                <div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(148,163,184,0.15);display:flex;justify-content:flex-end;">
                  <button id="doc-filter-clear" style="font-size:11px;color:#64748b;cursor:pointer;background:none;border:none;padding:2px 6px;">清除</button>
                </div>
              </div>
            </div>
          </div>
        </div>
        <!-- Document list -->
        <div id="doc-list" class="flex-1 overflow-y-auto">
          <div class="p-6 text-center text-slate-400 text-sm">載入中…</div>
        </div>
        <!-- New / Import buttons (DOC-J3: 新增文件 generates from a template/copy via the doc-new skill) -->
        <div class="p-3 border-t border-slate-200 dark:border-slate-800 space-y-2">
          <button id="doc-new-btn" class="w-full flex items-center justify-center space-x-2 px-3 py-2 rounded-lg bg-cyan-600/10 hover:bg-cyan-600 border border-cyan-500/20 hover:border-cyan-500/50 text-xs font-semibold text-cyan-600 hover:text-white dark:text-cyan-400 dark:hover:text-white transition-all shadow-sm">
            <i data-lucide="file-plus" class="h-3.5 w-3.5"></i>
            <span>＋ 新增文件</span>
          </button>
          <button id="doc-import-btn" class="w-full flex items-center justify-center space-x-2 px-3 py-2 rounded-lg bg-violet-600/10 hover:bg-violet-600 border border-violet-500/20 hover:border-violet-500/50 text-xs font-semibold text-violet-600 hover:text-white dark:text-violet-400 dark:hover:text-white transition-all shadow-sm">
            <i data-lucide="file-up" class="h-3.5 w-3.5"></i>
            <span>匯入文件</span>
          </button>
        </div>
      </div>

      <!-- Right: Preview + Action Bar -->
      <div class="flex-1 flex flex-col overflow-hidden">
        <!-- DOC-I4: Per-document Action Bar (sticky, type-driven) -->
        <div id="doc-action-bar" class="hidden flex-shrink-0 px-5 py-2 border-b border-slate-200 dark:border-slate-800 bg-white/60 dark:bg-slate-900/60 flex items-center justify-end space-x-2">
          <!-- Buttons injected by renderDocActionBar() -->
        </div>
        <!-- Content area (flow mode) -->
        <div id="doc-preview-scroll" class="flex-1 overflow-y-auto px-12 py-10">
          <div class="max-w-4xl mx-auto">
            <article id="doc-content-area" class="prose prose-slate dark:prose-invert prose-custom max-w-none select-text">
              <div id="doc-empty-state" class="py-24 text-center text-slate-400">
                <i data-lucide="file-text" class="h-14 w-14 mx-auto mb-4 opacity-20"></i>
                <p class="text-sm">選擇左側文件以預覽</p>
              </div>
            </article>
          </div>
        </div>
        <!-- DOC-I5: Paged (Word-style) view — toggled by toggleDocPagedMode() -->
        <div id="doc-paged-view" class="hidden flex-1 overflow-y-auto">
          <!-- A4 page divs injected by _renderDocPaged() -->
        </div>
        <!-- DOC-L2-01: Split-view — 並排雙欄（左=md投影+編輯 | 右=擬真預覽） -->
        <div id="doc-split-view" class="flex-1 overflow-hidden" style="display:none;flex-direction:row">
          <!-- Left: rendered md投影 (with image hover UX) + textarea editor -->
          <div style="display:flex;flex:1.2;flex-direction:column;overflow:hidden;border-right:1px solid #e2e8f0;min-width:0">
            <div id="doc-split-md-scroll" style="flex:1;overflow-y:auto;padding:1rem 1.5rem">
              <article id="doc-split-md-area" class="prose prose-slate dark:prose-invert prose-custom max-w-none select-text text-sm"></article>
            </div>
            <div style="flex-shrink:0;border-top:1px solid #e2e8f0;padding:0.75rem;display:flex;flex-direction:column;gap:0.5rem;height:38%">
              <div style="display:flex;align-items:center;justify-content:space-between;flex-shrink:0">
                <span class="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">md 投影（文字校修）</span>
                <div style="display:flex;align-items:center;gap:0.5rem">
                  <span id="doc-split-wb-status" class="text-[11px] max-w-[240px] truncate"></span>
                  <button id="doc-split-submit" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-xs font-semibold shadow transition-all">
                    <i data-lucide="send" class="h-3 w-3"></i><span>送出</span>
                  </button>
                </div>
              </div>
              <textarea id="doc-split-textarea" style="flex:1;width:100%;resize:none;border:1px solid #e2e8f0;border-radius:0.5rem;background:#fff;color:#0f172a;font-family:monospace;font-size:11px;line-height:1.6;padding:0.5rem 0.75rem;outline:none" spellcheck="false" placeholder="md 投影（可編輯）"></textarea>
            </div>
          </div>
          <!-- Right: inline docx-preview or pptxjs (read-only 擬真預覽) -->
          <div style="flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0">
            <div style="flex-shrink:0;display:flex;align-items:center;justify-content:space-between;padding:0.5rem 1rem;border-bottom:1px solid #e2e8f0;background:rgba(255,255,255,0.6)">
              <span class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">擬真預覽（source 真身）</span>
              <button id="doc-split-refresh" class="text-slate-400 hover:text-violet-600 transition-colors" title="重新載入擬真預覽"><i data-lucide="refresh-cw" class="h-3.5 w-3.5"></i></button>
            </div>
            <div id="doc-split-preview-loading" style="display:none;align-items:center;justify-content:center;padding:3rem 1rem;color:#94a3b8;font-size:0.875rem">載入擬真預覽…</div>
            <div id="doc-split-preview-error" style="display:none;padding:0.75rem 1rem;color:#ef4444;font-size:0.75rem"></div>
            <div id="doc-split-preview-body" style="flex:1;overflow:auto;padding:0.75rem;min-height:0"></div>
          </div>
        </div>
      </div>

    </section>`;

function wireEvents() {
  const $ = (sel) => container.querySelector(sel);

  $('#doc-search').addEventListener('input', () => { if (typeof window.filterDocList === 'function') window.filterDocList(); });
  $('#doc-recycle-toggle').addEventListener('click', () => { if (typeof window.toggleRecycleView === 'function') window.toggleRecycleView(); });
  $('#doc-filter-btn').addEventListener('click', (e) => { if (typeof window.toggleDocFilterPopover === 'function') window.toggleDocFilterPopover(e); });
  container.querySelectorAll('.doc-filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => { if (typeof window.toggleDocFilter === 'function') window.toggleDocFilter(chip); });
  });
  $('#doc-filter-clear').addEventListener('click', () => { if (typeof window.clearDocFilters === 'function') window.clearDocFilters(); });
  $('#doc-new-btn').addEventListener('click', () => { if (typeof window.openNewDocDialog === 'function') window.openNewDocDialog(); });
  $('#doc-import-btn').addEventListener('click', () => { if (typeof window.openImportDialog === 'function') window.openImportDialog(); });
  $('#doc-split-submit').addEventListener('click', () => { if (typeof window.docSubmitTextEdit === 'function') window.docSubmitTextEdit(); });
  $('#doc-split-refresh').addEventListener('click', () => { if (typeof window._refreshSplitPreview === 'function') window._refreshSplitPreview(); });
}

export function mount(root, ctx) {
  container = root;
  if (typeof window.showPanel === 'function') window.showPanel('__view_root__');
  root.classList.remove('hidden');
  root.innerHTML = PANEL_HTML;
  if (typeof window.highlightMenuBtn === 'function') window.highlightMenuBtn('menu-documents');

  const pathEl = document.getElementById('header-file-path'); if (pathEl) pathEl.innerText = '文件管理';
  const titleEl = document.getElementById('header-file-title'); if (titleEl) titleEl.innerText = '匯入 · 檢視 · 匯出 · 交付';
  const vscodeEl = document.getElementById('btn-vscode'); if (vscodeEl) vscodeEl.href = '#';
  const savedEl = document.getElementById('last-saved'); if (savedEl) savedEl.classList.add('hidden');
  const backEl = document.getElementById('btn-back'); if (backEl) backEl.classList.add('hidden');
  // wiki-only header buttons（編輯／匯出 docx／分頁）不屬於文件面板，同 switchToDocuments() 原行為。
  ['btn-md-edit', 'btn-export-docx', 'btn-paged-view'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });

  wireEvents();
  if (typeof lucide !== 'undefined') lucide.createIcons();
  if (typeof window.loadDocumentRegistry === 'function') window.loadDocumentRegistry();
}

export function unmount() {
  if (container) { container.classList.add('hidden'); container.innerHTML = ''; }
  container = null;
}

// SPEC-view-chat-context.md §3.1/CTX3: report the currently-open document to the avatar float-chat.
// window.getActiveDocContext() (index.html, next to _docActiveId) bridges in the id/mdPath this
// module can't see itself (classic <script> state, not visible to an ES module — see §V1 教訓).
export function getChatContext() {
  const r = (typeof window.getActiveDocContext === 'function') ? window.getActiveDocContext() : null;
  if (!r || !r.filePath) return null;
  return { kind: 'file', key: 'file:' + r.filePath, label: r.label || r.filePath, payload: { filePath: r.filePath } };
}

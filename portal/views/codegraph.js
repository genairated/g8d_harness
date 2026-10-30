// SPEC-portal-architecture.md §V2 — CodeGraph 探索器 view 模組（自 index.html 完整搬移，行為不變）。
// 依賴 index.html 仍保留的共用全域 function（傳統 <script> 的 function 宣告掛在 window 上，
// ESM 動態 import() 可直接呼叫）：window.showPanel / window.highlightMenuBtn / window.loadFile /
// window.showToast。另需 window.lucide（圖示渲染）與 window.Prism（原始碼語法高亮），皆由
// index.html 既有的 CDN <script> 掛在 window 上。
//
// 兩個既有入口（側欄選單「menu-codegraph」＋工作台首頁快捷鍵卡片）都已是 router.navigate('/app/codegraph')，
// 不需另外遷移，掛載本模組即可讓兩者一起動起來。

export const meta = { route: '/app/codegraph', title: 'CodeGraph 探索器', icon: 'network', menuGroup: 'codegraph' };

let container = null;
let activeCgTab = 'callers';
let activeCgNode = null;

function showToast(msg, type) { if (typeof window.showToast === 'function') window.showToast(msg, type); }
function workspaceRoot() { return sessionStorage.getItem('current_workspace') || ''; }

function render() {
  container.innerHTML = `
    <section class="flex-1 overflow-hidden flex flex-col h-full bg-slate-100/15 dark:bg-slate-900/15">
      <!-- Search and Filter Bar -->
      <div class="p-6 border-b border-slate-200 dark:border-slate-800 bg-white/40 dark:bg-slate-900/30 flex flex-wrap items-center gap-4 flex-shrink-0">
        <div class="flex-1 min-w-[280px] relative">
          <i data-lucide="search" class="absolute left-3.5 top-[11px] h-4.5 w-4.5 text-slate-400 dark:text-slate-500"></i>
          <input type="text" id="cg-search-input" placeholder="輸入函式、類別、檔案或變數名稱（如: toggle, auth, prisma）..." class="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl pl-11 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/20 focus:border-cyan-500 text-slate-800 dark:text-slate-200 transition-all shadow-sm">
        </div>

        <div class="flex items-center space-x-2.5 flex-shrink-0">
          <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">符號類型:</label>
          <select id="cg-kind-select" class="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-2 text-xs font-medium focus:outline-none focus:ring-1 focus:ring-cyan-500 focus:border-cyan-500 text-slate-700 dark:text-slate-300 shadow-sm cursor-pointer">
            <option value="">全部 (All)</option>
            <option value="function">函式 (Function)</option>
            <option value="method">方法 (Method)</option>
            <option value="class">類別 (Class)</option>
            <option value="interface">介面 (Interface)</option>
            <option value="type">型別 (Type)</option>
            <option value="variable">變數 (Variable)</option>
            <option value="constant">常數 (Constant)</option>
            <option value="route">路由 (Route)</option>
            <option value="component">元件 (Component)</option>
          </select>
        </div>

        <button id="cg-search-btn" class="flex items-center space-x-2 px-5 py-2.5 rounded-xl bg-cyan-600 hover:bg-cyan-700 text-white text-xs font-semibold shadow-md shadow-cyan-500/10 hover:shadow-cyan-500/20 transition-all">
          <i data-lucide="search" class="h-4 w-4"></i>
          <span>搜尋符號</span>
        </button>
      </div>

      <!-- Split Layout Workspace -->
      <div class="flex-1 flex overflow-hidden">
        <!-- Left Pane: Search Results -->
        <div class="w-1/2 md:w-5/12 border-r border-slate-200 dark:border-slate-800 flex flex-col bg-white/10 dark:bg-slate-900/10">
          <div class="px-5 py-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/20 flex items-center justify-between flex-shrink-0">
            <span class="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">搜尋結果</span>
            <span id="cg-results-count" class="text-[10px] px-2 py-0.5 rounded-full bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400 font-mono font-bold">0</span>
          </div>

          <!-- Results Scroll Area -->
          <div id="cg-results-list" class="flex-1 overflow-y-auto p-4 space-y-2.5">
            <!-- Default Welcome/Help Panel -->
            <div id="cg-welcome-panel" class="py-12 px-6 text-center space-y-4 max-w-sm mx-auto">
              <div class="h-12 w-12 rounded-full bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 flex items-center justify-center mx-auto shadow-inner">
                <i data-lucide="network" class="h-6 w-6 animate-pulse"></i>
              </div>
              <div class="space-y-1.5">
                <h4 class="text-sm font-semibold text-slate-800 dark:text-slate-200">開始探索 CodeGraph</h4>
                <p class="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">請在上方輸入框中輸入關鍵字，即可找出專案中的函式、類別與依賴關係。</p>
              </div>
              <div class="p-3.5 rounded-xl border border-slate-200/60 dark:border-slate-800/80 bg-slate-50 dark:bg-slate-950/40 text-left text-xs text-slate-500 dark:text-slate-400 space-y-2">
                <div class="font-semibold text-slate-700 dark:text-slate-300">💡 搜尋關鍵字推薦:</div>
                <ul class="list-disc pl-4 space-y-1 font-mono text-[11px]">
                  <li><a href="#" data-demo="toggle" class="text-cyan-600 hover:underline dark:text-cyan-400">toggle</a> (切換功能)</li>
                  <li><a href="#" data-demo="auth" class="text-cyan-600 hover:underline dark:text-cyan-400">auth</a> (權限與錯誤)</li>
                  <li><a href="#" data-demo="Prisma" class="text-cyan-600 hover:underline dark:text-cyan-400">Prisma</a> (資料庫元件)</li>
                  <li><a href="#" data-demo="user" class="text-cyan-600 hover:underline dark:text-cyan-400">user</a> (帳號管理與行為)</li>
                </ul>
              </div>
            </div>
          </div>
        </div>

        <!-- Right Pane: Details, Relations & Source Preview -->
        <div id="cg-details-pane" class="w-1/2 md:w-7/12 flex flex-col bg-white/25 dark:bg-slate-900/25 overflow-hidden">
          <!-- Default empty state -->
          <div id="cg-details-empty" class="flex-1 flex flex-col items-center justify-center text-center p-12 text-slate-400 dark:text-slate-500">
            <i data-lucide="info" class="h-8 w-8 text-slate-300 dark:text-slate-700 mb-3"></i>
            <span class="text-xs font-medium">請從左側點擊一個符號以檢視其關係與原始碼</span>
          </div>

          <!-- Detail contents (hidden by default) -->
          <div id="cg-details-content" class="flex-1 flex flex-col overflow-hidden hidden">
            <!-- Active Symbol Header Card -->
            <div class="p-6 border-b border-slate-200 dark:border-slate-800 bg-white/60 dark:bg-slate-900/60 flex-shrink-0 flex items-start justify-between">
              <div class="space-y-1.5 flex-1 min-w-0 pr-4">
                <div class="flex items-center space-x-2.5">
                  <span id="cg-active-kind" class="px-2 py-0.5 rounded text-[10px] font-bold tracking-wide uppercase">CLASS</span>
                  <h3 id="cg-active-name" class="text-base font-display font-semibold text-slate-800 dark:text-slate-100 truncate">activeSymbolName</h3>
                </div>
                <p id="cg-active-path" class="text-[11px] text-slate-400 dark:text-slate-500 font-mono truncate">file/path/here.ts</p>
                <p id="cg-active-sig" class="text-xs text-slate-500 dark:text-slate-400 font-mono italic truncate bg-slate-100/50 dark:bg-slate-950/50 px-2 py-1 rounded border border-slate-200/30 dark:border-slate-800/30 mt-1 hidden"></p>
              </div>
              <div class="flex flex-col space-y-2 flex-shrink-0">
                <a id="cg-active-vscode-btn" href="#" class="flex items-center justify-center space-x-1.5 px-3 py-1.5 rounded-lg bg-indigo-600/10 hover:bg-indigo-600 border border-indigo-500/20 hover:border-indigo-500/50 text-xs font-semibold text-indigo-600 hover:text-white dark:text-indigo-400 dark:hover:text-white transition-all shadow-sm">
                  <i data-lucide="external-link" class="h-3.5 w-3.5"></i>
                  <span>VS Code</span>
                </a>
                <button id="cg-active-wiki-btn" class="flex items-center justify-center space-x-1.5 px-3 py-1.5 rounded-lg bg-cyan-600/10 hover:bg-cyan-600 border border-cyan-500/20 hover:border-cyan-500/50 text-xs font-semibold text-cyan-600 hover:text-white dark:text-cyan-400 dark:hover:text-white transition-all shadow-sm">
                  <i data-lucide="book-open" class="h-3.5 w-3.5"></i>
                  <span>網頁查看</span>
                </button>
              </div>
            </div>

            <!-- Tab Buttons -->
            <div class="border-b border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/20 flex-shrink-0 flex px-4">
              <button data-cg-tab="callers" id="tab-btn-callers" class="px-4 py-3 border-b-2 border-transparent text-xs font-bold text-slate-500 dark:text-slate-455 hover:text-slate-800 dark:hover:text-white transition-all flex items-center space-x-1.5">
                <i data-lucide="log-in" class="h-3.5 w-3.5"></i>
                <span>誰呼叫它 (Callers)</span>
                <span id="cg-callers-badge" class="text-[9px] px-1.5 py-0.2 rounded bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400 font-mono font-bold">0</span>
              </button>
              <button data-cg-tab="callees" id="tab-btn-callees" class="px-4 py-3 border-b-2 border-transparent text-xs font-bold text-slate-500 dark:text-slate-455 hover:text-slate-800 dark:hover:text-white transition-all flex items-center space-x-1.5">
                <i data-lucide="log-out" class="h-3.5 w-3.5"></i>
                <span>它呼叫誰 (Callees)</span>
                <span id="cg-callees-badge" class="text-[9px] px-1.5 py-0.2 rounded bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400 font-mono font-bold">0</span>
              </button>
              <button data-cg-tab="impact" id="tab-btn-impact" class="px-4 py-3 border-b-2 border-transparent text-xs font-bold text-slate-500 dark:text-slate-455 hover:text-slate-800 dark:hover:text-white transition-all flex items-center space-x-1.5">
                <i data-lucide="activity" class="h-3.5 w-3.5"></i>
                <span>影響範圍 (Impact)</span>
                <span id="cg-impact-badge" class="text-[9px] px-1.5 py-0.2 rounded bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400 font-mono font-bold">0</span>
              </button>
              <button data-cg-tab="code" id="tab-btn-code" class="px-4 py-3 border-b-2 border-transparent text-xs font-bold text-slate-500 dark:text-slate-455 hover:text-slate-800 dark:hover:text-white transition-all flex items-center space-x-1.5">
                <i data-lucide="code-2" class="h-3.5 w-3.5"></i>
                <span>程式碼預覽</span>
              </button>
            </div>

            <!-- Tab Content Pane -->
            <div class="flex-1 overflow-y-auto p-6">
              <!-- Callers Tab -->
              <div id="tab-content-callers" class="cg-tab-content space-y-3 hidden">
                <div id="cg-callers-list" class="space-y-2"></div>
              </div>

              <!-- Callees Tab -->
              <div id="tab-content-callees" class="cg-tab-content space-y-3 hidden">
                <div id="cg-callees-list" class="space-y-2"></div>
              </div>

              <!-- Impact Tab -->
              <div id="tab-content-impact" class="cg-tab-content space-y-3 hidden">
                <div id="cg-impact-meta" class="text-xs text-slate-500 dark:text-slate-400 flex items-center space-x-4 pb-2 border-b border-slate-200/50 dark:border-slate-800/50">
                  <span>影響深度: <strong class="font-semibold text-slate-700 dark:text-slate-200">2</strong> 層</span>
                  <span>影響節點數: <strong id="cg-impact-nodecount" class="font-semibold text-slate-700 dark:text-cyan-400 font-mono">0</strong></span>
                  <span>關係邊數量: <strong id="cg-impact-edgecount" class="font-semibold text-slate-700 dark:text-cyan-400 font-mono">0</strong></span>
                </div>
                <div id="cg-impact-list" class="space-y-2 mt-3"></div>
              </div>

              <!-- Code Preview Tab -->
              <div id="tab-content-code" class="cg-tab-content hidden h-full flex flex-col">
                <div class="flex-shrink-0 flex items-center justify-between text-xs text-slate-400 dark:text-slate-500 mb-2 font-mono">
                  <span id="cg-code-lines">Lines: -- to --</span>
                  <span id="cg-code-lang">language</span>
                </div>
                <pre class="flex-1 overflow-auto rounded-xl border border-slate-200 dark:border-slate-800/80 bg-slate-950 p-4 font-mono text-xs leading-relaxed select-text" style="margin: 0 !important;"><code id="cg-code-block" class="language-javascript select-text"></code></pre>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;

  container.querySelector('#cg-search-input').addEventListener('keydown', handleCgSearchKey);
  container.querySelector('#cg-search-btn').addEventListener('click', performCgSearch);
  container.querySelectorAll('[data-demo]').forEach(el => {
    el.addEventListener('click', (e) => { e.preventDefault(); setCgDemoQuery(el.getAttribute('data-demo')); });
  });
  container.querySelectorAll('[data-cg-tab]').forEach(el => {
    el.addEventListener('click', () => switchCgTab(el.getAttribute('data-cg-tab')));
  });
}

function field(id) { return container.querySelector('#' + id); }

function setCgDemoQuery(term) {
  field('cg-search-input').value = term;
  performCgSearch();
}

function handleCgSearchKey(event) {
  if (event.key === 'Enter') {
    performCgSearch();
  }
}

// Perform symbol search query
async function performCgSearch() {
  const input = field('cg-search-input');
  const kindSelect = field('cg-kind-select');
  const listContainer = field('cg-results-list');
  const countBadge = field('cg-results-count');

  const query = input.value.trim();
  const kind = kindSelect.value;

  if (!query) {
    showToast('請輸入搜尋關鍵字', 'error');
    return;
  }

  listContainer.innerHTML = `
    <div class="py-12 text-center text-slate-400 flex flex-col items-center justify-center space-y-3">
      <span class="h-6 w-6 rounded-full border-2 border-cyan-500 border-t-transparent animate-spin"></span>
      <span class="text-xs">正在向 CodeGraph 索引查詢中...</span>
    </div>
  `;

  try {
    const url = `/api/codegraph/query?query=${encodeURIComponent(query)}&kind=${encodeURIComponent(kind)}&limit=30`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const results = await res.json();
    countBadge.innerText = results.length;
    listContainer.innerHTML = '';

    if (results.length === 0) {
      listContainer.innerHTML = `
        <div class="py-12 text-center text-slate-400 dark:text-slate-500 text-xs font-medium">
          沒有找到符合的符號。請更換關鍵字再試一次。
        </div>
      `;
      return;
    }

    results.forEach(item => {
      const node = item.node;
      const card = document.createElement('div');
      card.onclick = () => selectCgSymbol(node);
      card.className = `p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950/45 hover:border-cyan-500/50 dark:hover:border-cyan-500/40 cursor-pointer transition-all duration-150 flex flex-col space-y-2 group select-none shadow-sm`;

      // Badge colors
      const badgeClass = getCgKindBadgeClass(node.kind);

      card.innerHTML = `
        <div class="flex items-center justify-between min-w-0">
          <span class="px-2 py-0.5 rounded text-[9px] font-bold tracking-wide uppercase ${badgeClass}">${node.kind}</span>
          <span class="text-[10px] text-slate-400 dark:text-slate-650 font-mono">L${node.startLine}</span>
        </div>
        <div class="font-display font-semibold text-slate-850 dark:text-slate-250 truncate group-hover:text-cyan-600 dark:group-hover:text-cyan-400 transition-colors text-sm">${node.name}</div>
        <div class="text-[10.5px] text-slate-400 dark:text-slate-500 font-mono truncate flex items-center space-x-1">
          <i data-lucide="file-code-2" class="h-3 w-3 text-slate-400 flex-shrink-0"></i>
          <span class="truncate">${node.filePath}</span>
        </div>
      `;
      listContainer.appendChild(card);
    });
    if (typeof lucide !== 'undefined') lucide.createIcons();

  } catch (err) {
    listContainer.innerHTML = `
      <div class="py-12 text-center text-red-500 text-xs font-semibold">
        查詢失敗: ${err.message}
      </div>
    `;
    showToast('CodeGraph 查詢錯誤', 'error');
  }
}

function getCgKindBadgeClass(kind) {
  const k = kind.toLowerCase();
  if (k === 'class') return 'bg-amber-100 text-amber-800 dark:bg-amber-950/80 dark:text-amber-300 border border-amber-200 dark:border-amber-800/40';
  if (k === 'function' || k === 'method') return 'bg-sky-100 text-sky-800 dark:bg-sky-950/80 dark:text-sky-300 border border-sky-200 dark:border-sky-800/40';
  if (k === 'interface') return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/80 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/40';
  if (k === 'type' || k === 'type_alias') return 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950/80 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800/40';
  if (k === 'variable' || k === 'constant') return 'bg-purple-100 text-purple-800 dark:bg-purple-950/80 dark:text-purple-300 border border-purple-200 dark:border-purple-800/40';
  if (k === 'component' || k === 'route') return 'bg-rose-100 text-rose-800 dark:bg-rose-950/80 dark:text-rose-300 border border-rose-200 dark:border-rose-800/40';
  return 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-300 border border-slate-200/50';
}

// Load selected symbol properties, relations & code block
async function selectCgSymbol(node) {
  activeCgNode = node;

  // Toggle visibility
  field('cg-details-empty').classList.add('hidden');
  field('cg-details-content').classList.remove('hidden');

  // Update basic fields
  field('cg-active-name').innerText = node.name;
  field('cg-active-path').innerText = node.filePath;

  const kindBadge = field('cg-active-kind');
  kindBadge.innerText = node.kind;
  kindBadge.className = `px-2 py-0.5 rounded text-[10px] font-bold tracking-wide uppercase ${getCgKindBadgeClass(node.kind)}`;

  // Update signature helper
  const sigEl = field('cg-active-sig');
  if (node.signature) {
    sigEl.innerText = `${node.name}${node.signature}`;
    sigEl.classList.remove('hidden');
  } else {
    sigEl.classList.add('hidden');
  }

  // Top Actions Setup
  const wsRoot = workspaceRoot().replace(/\\/g, '/');
  field('cg-active-vscode-btn').href = `vscode://file/${wsRoot}/${node.filePath}:${node.startLine}`;
  field('cg-active-wiki-btn').onclick = () => {
    if (typeof window.loadFile === 'function') window.loadFile(node.filePath, true, node.startLine);
  };

  // Reset badges
  field('cg-callers-badge').innerText = '...';
  field('cg-callees-badge').innerText = '...';
  field('cg-impact-badge').innerText = '...';

  // Load active tab panels (by default start with current activeCgTab)
  switchCgTab(activeCgTab);

  // Async fetch relations in parallel
  fetchCgRelations(node);
}

// Switch between details tabs
function switchCgTab(tab) {
  activeCgTab = tab;

  // Highlight tabs
  container.querySelectorAll('[data-cg-tab]').forEach(btn => {
    btn.classList.remove('border-cyan-500', 'text-cyan-600', 'dark:text-cyan-400');
    btn.classList.add('border-transparent');
  });

  const activeBtn = field(`tab-btn-${tab}`);
  if (activeBtn) {
    activeBtn.classList.remove('border-transparent');
    activeBtn.classList.add('border-cyan-500', 'text-cyan-600', 'dark:text-cyan-400');
  }

  // Toggle tab content panels
  container.querySelectorAll('.cg-tab-content').forEach(p => p.classList.add('hidden'));
  const contentPanel = field(`tab-content-${tab}`);
  if (contentPanel) contentPanel.classList.remove('hidden');

  // If code tab is selected, trigger Prism code loading
  if (tab === 'code' && activeCgNode) {
    loadCgCodePreview(activeCgNode);
  }
}

// Fetch callers, callees, and impact from server
async function fetchCgRelations(node) {
  const symbol = node.name;

  // 1. Callers
  fetch(`/api/codegraph/callers?symbol=${encodeURIComponent(symbol)}`)
    .then(res => res.json())
    .then(data => {
      const callers = data.callers || [];
      field('cg-callers-badge').innerText = callers.length;
      renderCgRelationsList(callers, 'cg-callers-list', 'callers');
    }).catch(err => {
      console.error('Callers fetch failed:', err);
      field('cg-callers-badge').innerText = 'Error';
    });

  // 2. Callees
  fetch(`/api/codegraph/callees?symbol=${encodeURIComponent(symbol)}`)
    .then(res => res.json())
    .then(data => {
      const callees = data.callees || [];
      field('cg-callees-badge').innerText = callees.length;
      renderCgRelationsList(callees, 'cg-callees-list', 'callees');
    }).catch(err => {
      console.error('Callees fetch failed:', err);
      field('cg-callees-badge').innerText = 'Error';
    });

  // 3. Impact
  fetch(`/api/codegraph/impact?symbol=${encodeURIComponent(symbol)}`)
    .then(res => res.json())
    .then(data => {
      const affected = data.affected || [];
      field('cg-impact-badge').innerText = affected.length;
      field('cg-impact-nodecount').innerText = data.nodeCount || 0;
      field('cg-impact-edgecount').innerText = data.edgeCount || 0;
      renderCgRelationsList(affected, 'cg-impact-list', 'impact');
    }).catch(err => {
      console.error('Impact fetch failed:', err);
      field('cg-impact-badge').innerText = 'Error';
    });
}

// Render relations list items
function renderCgRelationsList(items, containerId, relationType) {
  const listEl = field(containerId);
  listEl.innerHTML = '';

  if (items.length === 0) {
    listEl.innerHTML = `
      <div class="py-6 text-center text-slate-400 dark:text-slate-650 text-xs">
        沒有找到任何關係節點。
      </div>
    `;
    return;
  }

  items.forEach(item => {
    const div = document.createElement('div');
    div.className = `p-3 rounded-xl border border-slate-200/60 dark:border-slate-800/80 bg-white/40 dark:bg-slate-900/30 flex items-center justify-between hover:border-slate-350 dark:hover:border-slate-700/80 shadow-sm transition-all duration-100 group`;

    const badgeClass = getCgKindBadgeClass(item.kind);
    const wsRoot = workspaceRoot().replace(/\\/g, '/');
    const vscodeUrl = `vscode://file/${wsRoot}/${item.filePath}:${item.startLine}`;

    div.innerHTML = `
      <div class="flex-1 min-w-0 pr-4">
        <div class="flex items-center space-x-2">
          <span class="px-1.5 py-0.2 rounded text-[8.5px] font-bold uppercase ${badgeClass}">${item.kind}</span>
          <strong class="text-xs font-semibold text-slate-700 dark:text-slate-200 truncate">${item.name}</strong>
        </div>
        <div class="text-[10px] text-slate-400 dark:text-slate-550 font-mono truncate mt-1">${item.filePath} <span class="font-bold text-slate-500">L${item.startLine}</span></div>
      </div>
      <div class="flex items-center space-x-1.5 flex-shrink-0 opacity-80 group-hover:opacity-100 transition-opacity">
        <a href="${vscodeUrl}" class="p-1.5 rounded-lg bg-indigo-500/10 hover:bg-indigo-500 hover:text-white text-indigo-500 dark:text-indigo-400 text-[10px] font-semibold border border-transparent transition-all shadow-sm" title="在 VS Code 開啟對應行數">
          <i data-lucide="external-link" class="h-3.5 w-3.5"></i>
        </a>
        <button class="cg-open-file-btn p-1.5 rounded-lg bg-cyan-500/10 hover:bg-cyan-500 hover:text-white text-cyan-500 dark:text-cyan-400 text-[10px] font-semibold border border-transparent transition-all shadow-sm" title="在網頁載入檔案並高亮該行">
          <i data-lucide="book-open" class="h-3.5 w-3.5"></i>
        </button>
      </div>
    `;
    div.querySelector('.cg-open-file-btn').addEventListener('click', () => {
      if (typeof window.loadFile === 'function') window.loadFile(item.filePath, true, item.startLine);
    });
    listEl.appendChild(div);
  });
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// Load extracted code segment of active symbol
async function loadCgCodePreview(node) {
  const codeBlock = field('cg-code-block');
  const linesLabel = field('cg-code-lines');
  const langLabel = field('cg-code-lang');

  codeBlock.innerText = '// 正在載入原始碼預覽...';

  try {
    const res = await fetch(`/api/file?path=${encodeURIComponent(node.filePath)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const lines = data.content.split(/\r?\n/);

    // Window parameters: 5 lines before, 10 lines after definition block
    const start = Math.max(0, node.startLine - 5);
    const end = Math.min(lines.length, node.endLine + 10);
    const slice = lines.slice(start, end);

    linesLabel.innerText = `Lines: ${start + 1} to ${end} (Symbol at L${node.startLine})`;

    const ext = node.filePath.split('.').pop();
    const langMap = {
      'ts': 'typescript',
      'tsx': 'tsx',
      'js': 'javascript',
      'jsx': 'jsx',
      'py': 'python',
      'yaml': 'yaml',
      'json': 'json'
    };
    const lang = langMap[ext] || 'javascript';
    langLabel.innerText = lang.toUpperCase();

    // Inject content
    codeBlock.className = `language-${lang} select-text`;
    codeBlock.innerText = slice.join('\n');

    // Highlight element
    if (typeof Prism !== 'undefined') Prism.highlightElement(codeBlock);

  } catch (err) {
    codeBlock.innerText = `// 無法預覽原始碼: ${err.message}`;
    linesLabel.innerText = 'Lines: --';
    langLabel.innerText = 'Unknown';
  }
}

export function mount(root, ctx) {
  container = root;
  if (typeof window.showPanel === 'function') window.showPanel('__view_root__');
  root.classList.remove('hidden');
  if (typeof window.highlightMenuBtn === 'function') window.highlightMenuBtn('menu-codegraph');
  const pathEl = document.getElementById('header-file-path'); if (pathEl) pathEl.innerText = 'CodeGraph Explorer';
  const titleEl = document.getElementById('header-file-title'); if (titleEl) titleEl.innerText = '探索靜態代碼關係圖';
  const vscodeEl = document.getElementById('btn-vscode'); if (vscodeEl) vscodeEl.href = '#';
  const savedEl = document.getElementById('last-saved'); if (savedEl) savedEl.classList.add('hidden');
  const backEl = document.getElementById('btn-back'); if (backEl) backEl.classList.add('hidden');

  activeCgTab = 'callers';
  activeCgNode = null;
  render();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

export function unmount() {
  if (container) { container.classList.add('hidden'); container.innerHTML = ''; }
  container = null;
  activeCgNode = null;
}

// SPEC-view-chat-context.md §3.1/§3.3 — 頭像在 CodeGraph 探索器開的對話：跟著使用者當下點開的
// symbol 走。有選中 symbol 就把它（名稱/檔案/行號/種類）當識別碼帶給後端 provider，讓 Hana 用她
// 自己的 codegraph_* 工具直接查關係，不必在這裡重複組一份 callers/callees/impact 文字。
export function getChatContext() {
  if (activeCgNode) {
    return {
      kind: 'codegraph',
      key: 'codegraph:' + activeCgNode.filePath + ':' + activeCgNode.name,
      label: 'CodeGraph：' + activeCgNode.name,
      payload: { symbol: activeCgNode.name, filePath: activeCgNode.filePath, startLine: activeCgNode.startLine, kind: activeCgNode.kind },
    };
  }
  return { kind: 'codegraph', key: 'codegraph:explorer', label: 'CodeGraph 探索器', payload: {} };
}

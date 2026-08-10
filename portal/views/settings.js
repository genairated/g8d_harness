// SPEC-workspace-settings.md (§5) + SPEC-sidebar-worktable-card.md (§6) — 工作區設定 UI（TASK.md §W4）。
// D3: 可編輯任一已登錄工作區，不限當前工作區。window.fetch is globally wrapped to always attach
// X-Workspace from sessionStorage['current_workspace'] (see index.html wrapGlobalFetch) — it always
// wins over any header we set ourselves, so to target a DIFFERENT workspace we briefly swap that
// sessionStorage value around the fetch call (synchronous set → fetch → synchronous restore; the
// wrapper reads it synchronously before the request is sent, so this is race-free).
export const meta = { route: '/app/settings', title: '工作區設定', icon: 'settings', menuGroup: 'settings' };

// D1: these are display-only toggles — label/icon/order are NOT editable here (avoids each
// workspace inventing its own terminology for the same global feature).
const NAV_ITEMS = [
  { key: 'chat', label: 'AI 對話', note: '核心功能：關掉只隱藏入口，仍可用網址 /app/chat 進入' },
  { key: 'worktable', label: '工作台卡片（看板／任務／歷程）' },
  { key: 'scheduler', label: '排程任務' },
  { key: 'telegram', label: 'Telegram 控制台' },
  { key: 'documents', label: '文件管理' },
  { key: 'meeting', label: 'AI 會議' },
  { key: 'notes', label: '便條貼' },
  { key: 'audioTopics', label: '音訊主題' },
  { key: 'pm', label: '專案管理' },
  { key: 'whiteboard', label: '白板' },
];

let container = null;
const state = {
  projects: [],
  currentRoot: '',   // this tab's actual active workspace (sessionStorage)
  editRoot: '',       // workspace currently being edited in this page
  manifest: null,
  sections: [],       // working copy of manifest.sidebar.sections (array editing)
};

function esc(str) { return window.escapeHtml ? window.escapeHtml(String(str == null ? '' : str)) : String(str == null ? '' : str); }

// Runs `fn` (an async function performing fetch calls) with sessionStorage['current_workspace']
// temporarily pointed at `root`, then restores it — see file header comment.
async function asWorkspace(root, fn) {
  const orig = sessionStorage.getItem('current_workspace');
  sessionStorage.setItem('current_workspace', root);
  try {
    return await fn();
  } finally {
    if (orig === null) sessionStorage.removeItem('current_workspace'); else sessionStorage.setItem('current_workspace', orig);
  }
}

async function loadProjects() {
  const r = await fetch('/api/workspace');
  const data = await r.json();
  state.projects = data.projects || [];
  state.currentRoot = data.active || '';
  if (!state.editRoot) state.editRoot = state.currentRoot;
}

async function loadManifestFor(root) {
  return asWorkspace(root, async () => {
    const r = await fetch('/api/manifest');
    const data = await r.json();
    return data.manifest;
  });
}

function render() {
  const isOtherWorkspace = state.editRoot !== state.currentRoot;
  const m = state.manifest || {};
  const nav = m.nav || {};
  const tools = m.tools || {};

  container.innerHTML = `
    <section class="flex-1 overflow-y-auto h-full bg-slate-50/50 dark:bg-slate-900/40">
      <div class="max-w-3xl mx-auto p-6 space-y-6">
        <div class="flex items-center gap-3">
          <i data-lucide="settings" class="h-5 w-5 text-cyan-600 dark:text-cyan-400"></i>
          <h1 class="text-lg font-bold text-slate-800 dark:text-slate-100">工作區設定</h1>
        </div>

        <div class="flex items-center gap-2 text-sm">
          <span class="text-slate-500 dark:text-slate-400 flex-shrink-0">編輯工作區：</span>
          <select id="settings-ws-select" class="flex-1 px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 text-sm">
            ${state.projects.map(p => `<option value="${esc(p.root)}" ${p.root === state.editRoot ? 'selected' : ''}>${esc(p.name)} — ${esc(p.root)}</option>`).join('')}
          </select>
        </div>
        ${isOtherWorkspace ? `
        <div class="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300 text-xs">
          <i data-lucide="alert-triangle" class="h-4 w-4 flex-shrink-0"></i>
          <span>正在編輯「其他」工作區，不是你目前所在的工作區。儲存後不會立即套用在你眼前的側邊欄，切換過去才會生效。</span>
        </div>` : ''}

        <!-- ① 品牌 -->
        <div class="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-4 space-y-3">
          <h2 class="text-sm font-bold text-slate-700 dark:text-slate-300 flex items-center gap-1.5"><i data-lucide="image" class="h-4 w-4"></i>品牌</h2>
          <div class="flex items-center gap-4">
            <div class="h-16 w-16 rounded-lg overflow-hidden flex items-center justify-center bg-slate-100 dark:bg-slate-800 flex-shrink-0 border border-slate-200 dark:border-slate-700">
              <img id="settings-avatar-preview" class="h-full w-full object-cover" alt="頭像預覽" onerror="this.style.display='none'; document.getElementById('settings-avatar-fallback').style.display='flex';">
              <i id="settings-avatar-fallback" data-lucide="${esc(m.icon || 'shield')}" class="h-8 w-8 text-slate-400" style="display:none;"></i>
            </div>
            <div class="flex-1 space-y-1.5">
              <label class="text-xs text-slate-500 dark:text-slate-400">頭像路徑（相對於工作區根目錄）</label>
              <div class="flex gap-1.5">
                <input id="settings-avatar" type="text" value="${esc(m.avatar || '')}" placeholder="portal/hana_face.png" class="flex-1 px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-800 dark:text-slate-100 text-xs font-mono">
                <button id="settings-avatar-reset" class="px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-xs text-slate-600 dark:text-slate-300">還原預設</button>
              </div>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div class="space-y-1">
              <label class="text-xs text-slate-500 dark:text-slate-400">名稱</label>
              <input id="settings-name" type="text" value="${esc(m.name || '')}" class="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-800 dark:text-slate-100 text-sm">
            </div>
            <div class="space-y-1">
              <label class="text-xs text-slate-500 dark:text-slate-400">副標</label>
              <input id="settings-subtitle" type="text" value="${esc(m.subtitle || '')}" class="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-800 dark:text-slate-100 text-sm">
            </div>
          </div>
          <div class="space-y-1">
            <label class="text-xs text-slate-500 dark:text-slate-400">Fallback 圖示（lucide 名稱，頭像載入失敗時顯示）</label>
            <input id="settings-icon" type="text" value="${esc(m.icon || '')}" placeholder="shield" class="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-800 dark:text-slate-100 text-sm font-mono">
          </div>
        </div>

        <!-- ② 功能選單 -->
        <div class="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-4 space-y-2">
          <h2 class="text-sm font-bold text-slate-700 dark:text-slate-300 flex items-center gap-1.5"><i data-lucide="list-checks" class="h-4 w-4"></i>功能選單</h2>
          <p class="text-[11px] text-slate-400 dark:text-slate-500">只能開關顯示，標籤與順序不可改。</p>
          <div class="grid grid-cols-2 gap-x-4 gap-y-1.5">
            ${NAV_ITEMS.map(it => `
              <label class="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer" title="${esc(it.note || '')}">
                <input type="checkbox" data-nav-key="${it.key}" ${nav[it.key] !== false ? 'checked' : ''} class="rounded border-slate-300 dark:border-slate-600">
                ${esc(it.label)}
              </label>`).join('')}
          </div>
          <div class="pt-2 mt-2 border-t border-slate-100 dark:border-slate-800 grid grid-cols-2 gap-x-4 gap-y-1.5">
            <label class="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
              <input type="checkbox" id="settings-tool-codegraph" ${tools.codegraph ? 'checked' : ''} class="rounded border-slate-300 dark:border-slate-600">
              CodeGraph 探索器
            </label>
            <label class="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
              <input type="checkbox" id="settings-tool-docgraph" ${tools.docgraph ? 'checked' : ''} class="rounded border-slate-300 dark:border-slate-600">
              DocGraph 知識圖譜
            </label>
          </div>
        </div>

        <!-- ③ 檔案區塊 -->
        <div class="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-4 space-y-2">
          <div class="flex items-center justify-between">
            <h2 class="text-sm font-bold text-slate-700 dark:text-slate-300 flex items-center gap-1.5"><i data-lucide="folder-tree" class="h-4 w-4"></i>檔案區塊</h2>
            <button id="settings-section-add" class="px-2.5 py-1 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-xs font-semibold">+ 新增區塊</button>
          </div>
          <div id="settings-sections-list" class="space-y-2"></div>
        </div>

        <div class="flex justify-end gap-2 pb-8">
          <button id="settings-save" class="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-sm font-semibold shadow">儲存</button>
        </div>
      </div>
    </section>`;

  state.sections = (m.sidebar && Array.isArray(m.sidebar.sections)) ? m.sidebar.sections.map(s => Object.assign({}, s)) : [];
  renderSections();
  bindStaticEvents();
  updateAvatarPreview();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function renderSections() {
  const box = container.querySelector('#settings-sections-list');
  if (!box) return;
  if (!state.sections.length) {
    box.innerHTML = '<div class="text-xs text-slate-400 dark:text-slate-500 italic py-2">尚無自訂檔案區塊</div>';
    return;
  }
  box.innerHTML = state.sections.map((s, i) => `
    <div class="flex items-center gap-1.5 p-2 rounded-lg bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800" data-idx="${i}">
      <div class="grid grid-cols-4 gap-1.5 flex-1">
        <input data-field="label" value="${esc(s.label)}" placeholder="標籤" class="px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs text-slate-800 dark:text-slate-100">
        <input data-field="icon" value="${esc(s.icon)}" placeholder="lucide icon" class="px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-mono text-slate-800 dark:text-slate-100">
        <input data-field="path" value="${esc(s.path)}" placeholder="相對路徑" class="px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-mono text-slate-800 dark:text-slate-100">
        <input data-field="filter" value="${esc(s.filter)}" placeholder="*.md" class="px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-mono text-slate-800 dark:text-slate-100">
      </div>
      <div class="flex items-center gap-0.5 flex-shrink-0">
        <button data-act="up" title="上移" class="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400"><i data-lucide="chevron-up" class="h-3.5 w-3.5"></i></button>
        <button data-act="down" title="下移" class="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400"><i data-lucide="chevron-down" class="h-3.5 w-3.5"></i></button>
        <button data-act="remove" title="刪除" class="p-1 rounded hover:bg-red-100 dark:hover:bg-red-900/40 text-red-500"><i data-lucide="trash-2" class="h-3.5 w-3.5"></i></button>
      </div>
    </div>`).join('');

  box.querySelectorAll('[data-idx]').forEach(row => {
    const idx = parseInt(row.getAttribute('data-idx'), 10);
    row.querySelectorAll('input[data-field]').forEach(inp => {
      inp.addEventListener('input', () => { state.sections[idx][inp.getAttribute('data-field')] = inp.value; });
    });
    const upBtn = row.querySelector('[data-act="up"]');
    if (upBtn) upBtn.addEventListener('click', () => { if (idx > 0) { [state.sections[idx - 1], state.sections[idx]] = [state.sections[idx], state.sections[idx - 1]]; renderSections(); if (typeof lucide !== 'undefined') lucide.createIcons(); } });
    const downBtn = row.querySelector('[data-act="down"]');
    if (downBtn) downBtn.addEventListener('click', () => { if (idx < state.sections.length - 1) { [state.sections[idx + 1], state.sections[idx]] = [state.sections[idx], state.sections[idx + 1]]; renderSections(); if (typeof lucide !== 'undefined') lucide.createIcons(); } });
    const rmBtn = row.querySelector('[data-act="remove"]');
    if (rmBtn) rmBtn.addEventListener('click', () => { state.sections.splice(idx, 1); renderSections(); if (typeof lucide !== 'undefined') lucide.createIcons(); });
  });
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function updateAvatarPreview() {
  const input = container.querySelector('#settings-avatar');
  const img = container.querySelector('#settings-avatar-preview');
  const fallback = container.querySelector('#settings-avatar-fallback');
  if (!input || !img) return;
  const p = input.value.trim() || 'portal/hana_face.png';
  img.style.display = '';
  if (fallback) fallback.style.display = 'none';
  img.src = '/raw?path=' + encodeURIComponent(p) + '&workspace=' + encodeURIComponent(state.editRoot);
}

function bindStaticEvents() {
  const sel = container.querySelector('#settings-ws-select');
  if (sel) sel.addEventListener('change', async () => {
    state.editRoot = sel.value;
    state.manifest = await loadManifestFor(state.editRoot);
    render();
  });

  const avatarInput = container.querySelector('#settings-avatar');
  if (avatarInput) avatarInput.addEventListener('input', updateAvatarPreview);

  const resetBtn = container.querySelector('#settings-avatar-reset');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    avatarInput.value = 'portal/hana_face.png';
    updateAvatarPreview();
  });

  const addBtn = container.querySelector('#settings-section-add');
  if (addBtn) addBtn.addEventListener('click', () => {
    state.sections.push({ label: '', icon: 'folder', path: '', filter: '*.md' });
    renderSections();
    if (typeof lucide !== 'undefined') lucide.createIcons();
  });

  const saveBtn = container.querySelector('#settings-save');
  if (saveBtn) saveBtn.addEventListener('click', onSave);
}

async function onSave() {
  const nav = {};
  container.querySelectorAll('[data-nav-key]').forEach(cb => { nav[cb.getAttribute('data-nav-key')] = cb.checked; });

  const tools = {};
  const cgOn = container.querySelector('#settings-tool-codegraph').checked;
  const dgOn = container.querySelector('#settings-tool-docgraph').checked;
  tools.codegraph = cgOn ? Object.assign({ label: 'CodeGraph 探索器', icon: 'network', scope: '' }, (state.manifest && state.manifest.tools && state.manifest.tools.codegraph) || {}) : null;
  tools.docgraph = dgOn ? Object.assign({ label: 'DocGraph 知識圖譜', icon: 'git-fork', profile: 'hana' }, (state.manifest && state.manifest.tools && state.manifest.tools.docgraph) || {}) : null;

  const payload = {
    root: state.editRoot,
    name: container.querySelector('#settings-name').value.trim(),
    subtitle: container.querySelector('#settings-subtitle').value,
    icon: container.querySelector('#settings-icon').value.trim() || 'shield',
    avatar: container.querySelector('#settings-avatar').value.trim() || 'portal/hana_face.png',
    nav,
    sidebar: { sections: state.sections.filter(s => s.path) },
    tools,
  };

  const saveBtn = container.querySelector('#settings-save');
  saveBtn.disabled = true;
  saveBtn.textContent = '儲存中…';
  try {
    const res = await asWorkspace(state.editRoot, () => fetch('/api/manifest', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '儲存失敗');

    state.manifest = data.manifest;
    if (state.editRoot === state.currentRoot) {
      if (typeof window.applyManifest === 'function') window.applyManifest(data.manifest);
      if (typeof showToast === 'function') showToast('已儲存並套用', 'success');
    } else {
      if (typeof showToast === 'function') showToast('已儲存，切換到該工作區即生效', 'success');
    }
    render();
  } catch (e) {
    if (typeof showToast === 'function') showToast('儲存失敗: ' + e.message, 'error');
    else alert('儲存失敗: ' + e.message);
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '儲存'; }
  }
}

export async function mount(root) {
  container = root;
  if (typeof window.showPanel === 'function') window.showPanel('__view_root__');
  container.classList.remove('hidden');
  if (typeof window.highlightMenuBtn === 'function') window.highlightMenuBtn(null); // gear isn't a nav-list item
  const pathEl = document.getElementById('header-file-path'); if (pathEl) pathEl.innerText = '工作區設定';
  const titleEl = document.getElementById('header-file-title'); if (titleEl) titleEl.innerText = '可視化編輯 harness.json（品牌 / 功能選單 / 檔案區塊）';
  const vscodeEl = document.getElementById('btn-vscode'); if (vscodeEl) vscodeEl.href = '#';
  const savedEl = document.getElementById('last-saved'); if (savedEl) savedEl.classList.add('hidden');
  const backEl = document.getElementById('btn-back'); if (backEl) backEl.classList.add('hidden');

  container.innerHTML = '<div class="flex-1 flex items-center justify-center text-slate-400 text-sm">載入中…</div>';
  await loadProjects();
  state.manifest = await loadManifestFor(state.editRoot);
  render();
}

export function unmount() {
  if (container) { container.classList.add('hidden'); container.innerHTML = ''; }
  container = null;
}

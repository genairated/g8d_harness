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
  { key: 'uidesign', label: 'UI 設計系統' },
];

let container = null;
const state = {
  projects: [],
  currentRoot: '',   // this tab's actual active workspace (sessionStorage)
  editRoot: '',       // workspace currently being edited in this page
  manifest: null,
  sections: [],       // working copy of manifest.sidebar.sections (array editing)
  pluginsList: [],    // WSX2: working copy of /api/status's `plugins` for editRoot (order + hidden editable)
  quota: null,        // last GET /api/model-quota response ({ providers, generatedAt }) or null before first load
  quotaLoading: false,
  quotaError: null,
  sidebarCards: null,  // SBC-5: working copy of manifest.sidebarCards ({rotateSeconds,quotaRefreshSeconds,hidden,order})
  cardsList: [],       // SBC-5: working copy of the known+trusted card ids, in display order, each {id,label,hidden}
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

// WSX2 (§8.5): plugin list has no dedicated endpoint — `/api/status`'s `plugins` array is already
// the single source (sorted + `hidden`-flagged per that workspace's harness.json), same one the
// sidebar itself reads. Reuse it via the same asWorkspace() swap so "editing another workspace"
// lists THAT workspace's plugins, not the current tab's.
async function loadPluginsFor(root) {
  return asWorkspace(root, async () => {
    const r = await fetch('/api/status');
    const data = await r.json();
    return data.plugins || [];
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

        <!-- ③ 工作區外掛 -->
        <div class="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-4 space-y-2">
          <h2 class="text-sm font-bold text-slate-700 dark:text-slate-300 flex items-center gap-1.5"><i data-lucide="puzzle" class="h-4 w-4"></i>工作區外掛</h2>
          <p class="text-[11px] text-slate-400 dark:text-slate-500">只能調整顯示與排序；標籤與圖示以該外掛的 plugin.json 為準，這裡唯讀。</p>
          <div id="settings-plugins-list" class="space-y-1.5"></div>
        </div>

        <!-- ④ 模型額度 -->
        <div class="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-4 space-y-2">
          <div class="flex items-center justify-between">
            <h2 class="text-sm font-bold text-slate-700 dark:text-slate-300 flex items-center gap-1.5"><i data-lucide="gauge" class="h-4 w-4"></i>模型額度</h2>
            <button id="settings-quota-refresh" class="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-xs text-slate-600 dark:text-slate-300 flex items-center gap-1">
              <i data-lucide="refresh-cw" class="h-3.5 w-3.5"></i>重新整理
            </button>
          </div>
          <p class="text-[11px] text-slate-400 dark:text-slate-500">手動查詢，不自動輪詢（查額度本身不該花額度）。</p>
          <div id="settings-quota-box" class="space-y-2"></div>
        </div>

        <!-- ④b 側欄卡片輪播 (SPEC-sidebar-card-carousel.md §7/SBC-5) -->
        <div class="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-4 space-y-3">
          <h2 class="text-sm font-bold text-slate-700 dark:text-slate-300 flex items-center gap-1.5"><i data-lucide="gallery-horizontal" class="h-4 w-4"></i>側欄卡片</h2>
          <p class="text-[11px] text-slate-400 dark:text-slate-500">工作台卡／模型額度卡／外掛客製卡，可個別開關與排序；0 秒＝不自動輪播。</p>
          <div class="grid grid-cols-2 gap-3">
            <div class="space-y-1">
              <label class="text-xs text-slate-500 dark:text-slate-400">輪播秒數（0 或 3–120）</label>
              <input id="settings-sbc-rotate" type="number" min="0" step="1" value="${esc((state.sidebarCards && state.sidebarCards.rotateSeconds) != null ? state.sidebarCards.rotateSeconds : 8)}" class="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-800 dark:text-slate-100 text-sm">
            </div>
            <div class="space-y-1">
              <label class="text-xs text-slate-500 dark:text-slate-400">用量刷新秒數（0 或 30–3600）</label>
              <input id="settings-sbc-quota-refresh" type="number" min="0" step="1" value="${esc((state.sidebarCards && state.sidebarCards.quotaRefreshSeconds) != null ? state.sidebarCards.quotaRefreshSeconds : 300)}" class="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-800 dark:text-slate-100 text-sm">
            </div>
          </div>
          <div id="settings-sbc-error" class="hidden text-[11px] text-red-500"></div>
          <div id="settings-cards-list" class="space-y-1.5"></div>
          <div id="settings-cards-untrusted" class="text-[11px] text-red-500 dark:text-red-400 space-y-0.5"></div>
        </div>

        <!-- ⑤ 檔案區塊 -->
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
  state.sidebarCards = Object.assign({ rotateSeconds: 8, quotaRefreshSeconds: 300, hidden: [], order: [] }, m.sidebarCards || {});
  renderSections();
  renderPlugins();
  renderQuotaBox();
  rebuildCardsList();
  renderCardsList();
  bindStaticEvents();
  updateAvatarPreview();
  if (typeof lucide !== 'undefined') lucide.createIcons();

  if (!state.quota && !state.quotaLoading) loadQuota();
}

// SPEC-model-quota.md §3/§5 — 四態卡片：ok 綠／unsupported·missing 灰（顯示 message，不畫空進度條）／broken 紅（message 全文不摺疊）。
const QUOTA_HEALTH_META = {
  ok: { dot: 'bg-emerald-500', box: 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60', label: '正常' },
  unsupported: { dot: 'bg-slate-400', box: 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40', label: '不支援' },
  missing: { dot: 'bg-slate-400', box: 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40', label: '未安裝' },
  broken: { dot: 'bg-red-500', box: 'border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/40', label: '異常' },
  // SPEC-model-quota.md §9 D11 (MQR-4): transient network/timeout failure riding on a still-fresh
  // last-good read — amber caution, not red failure (real numbers, just slightly old).
  stale: { dot: 'bg-amber-500', box: 'border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30', label: '資料較舊' },
};

// Renders a coarse "約 N 小時／分鐘後重置" description from an ISO resetAt — relative time only,
// never a raw countdown clock (D3: don't imply more precision than the source actually gives).
function relativeResetLabel(resetAt) {
  if (!resetAt) return null;
  const ms = new Date(resetAt).getTime() - Date.now();
  if (!isFinite(ms)) return null;
  if (ms <= 0) return '即將重置';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `約 ${mins} 分鐘後重置`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `約 ${hours} 小時後重置`;
  return `約 ${Math.round(hours / 24)} 天後重置`;
}

function relativeFreshnessLabel(fetchedAt) {
  if (!fetchedAt) return '';
  const ms = Date.now() - new Date(fetchedAt).getTime();
  if (!isFinite(ms) || ms < 0) return '';
  const mins = Math.round(ms / 60000);
  if (mins < 1) return '剛剛更新';
  if (mins < 60) return `${mins} 分鐘前更新`;
  return `${Math.round(mins / 60)} 小時前更新`;
}

function renderQuotaProviderCard(p) {
  const meta = QUOTA_HEALTH_META[p.health] || QUOTA_HEALTH_META.broken;
  const windowsHtml = (p.windows || []).map(w => `
    <div class="space-y-0.5">
      <div class="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
        <span>${esc(w.name)}</span>
        <span>${Math.round((w.usedRatio || 0) * 100)}%${w.resetAt ? ' · ' + esc(relativeResetLabel(w.resetAt) || '') : ''}</span>
      </div>
      <div class="h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
        <div class="h-full ${(w.usedRatio || 0) >= 0.9 ? 'bg-red-500' : (w.usedRatio || 0) >= 0.7 ? 'bg-amber-500' : 'bg-cyan-500'}" style="width:${Math.max(0, Math.min(100, (w.usedRatio || 0) * 100))}%"></div>
      </div>
    </div>`).join('');

  return `
    <div class="rounded-lg border ${meta.box} p-3 space-y-1.5">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-1.5 min-w-0">
          <span class="h-2 w-2 rounded-full flex-shrink-0 ${meta.dot}"></span>
          <span class="text-sm font-semibold text-slate-700 dark:text-slate-200 truncate">${esc(p.label)}</span>
        </div>
        <span class="text-[11px] text-slate-400 dark:text-slate-500 flex-shrink-0">${esc(relativeFreshnessLabel(p.fetchedAt))}</span>
      </div>
      ${(p.health === 'ok' || p.health === 'stale') && windowsHtml ? (windowsHtml + (p.health === 'stale' && p.message ? `<div class="text-[11px] text-slate-400 dark:text-slate-500">${esc(p.message)}</div>` : ''))
        : p.health === 'ok' ? '<div class="text-[11px] text-slate-400 dark:text-slate-500 italic">目前沒有可顯示的限額窗口。</div>' : `
      <div class="text-xs ${p.health === 'broken' ? 'text-red-700 dark:text-red-300' : 'text-slate-500 dark:text-slate-400'}">${esc(p.message || '')}</div>`}
    </div>`;
}

function renderQuotaBox() {
  const box = container && container.querySelector('#settings-quota-box');
  if (!box) return;
  if (state.quotaLoading && !state.quota) {
    box.innerHTML = '<div class="text-xs text-slate-400 dark:text-slate-500 italic py-1">查詢中…</div>';
    return;
  }
  if (state.quotaError && !state.quota) {
    box.innerHTML = `<div class="text-xs text-red-600 dark:text-red-400">查詢失敗：${esc(state.quotaError)}</div>`;
    return;
  }
  if (!state.quota || !Array.isArray(state.quota.providers) || !state.quota.providers.length) {
    box.innerHTML = '<div class="text-xs text-slate-400 dark:text-slate-500 italic py-1">尚無資料，按「重新整理」查詢。</div>';
    return;
  }
  box.innerHTML = `<div class="grid grid-cols-1 sm:grid-cols-3 gap-2">${state.quota.providers.map(renderQuotaProviderCard).join('')}</div>`;
}

async function loadQuota() {
  state.quotaLoading = true;
  state.quotaError = null;
  renderQuotaBox();
  try {
    const r = await fetch('/api/model-quota');
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    state.quota = data;
  } catch (e) {
    state.quotaError = e.message || String(e);
  } finally {
    state.quotaLoading = false;
    renderQuotaBox();
    // SBC-5: the quota card list depends on providers[] from this same response — re-derive it
    // now that we actually have (or failed to get) that data, preserving whatever hide/order
    // choices are already sitting in state.cardsList for ids that still exist.
    const prevOrder = state.cardsList.map(c => c.id);
    const prevHidden = new Set(state.cardsList.filter(c => c.hidden).map(c => c.id));
    rebuildCardsList();
    state.cardsList.sort((a, b) => {
      const ia = prevOrder.indexOf(a.id), ib = prevOrder.indexOf(b.id);
      if (ia === -1 && ib === -1) return 0;
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
    state.cardsList.forEach(c => { if (prevHidden.has(c.id)) c.hidden = true; });
    renderCardsList();
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
}

// SBC-5 (SPEC-sidebar-card-carousel.md §7): rebuilds state.cardsList — the known-today card ids
// (worktable + whatever /api/model-quota returned + every TRUSTED plugin card) — in
// manifest.sidebarCards.order order (unlisted ones appended, discovery order), each flagged
// `hidden` per manifest.sidebarCards.hidden. Untrusted plugin cards are deliberately NOT included
// here (D7: they never reach the carousel) — they're rendered separately, read-only, with their reason.
function rebuildCardsList() {
  const sc = state.sidebarCards || { hidden: [], order: [] };
  const known = [{ id: 'worktable', label: '工作台' }];
  (state.quota && state.quota.providers || []).forEach(p => known.push({ id: 'quota:' + p.id, label: p.label }));
  (state.pluginsList || []).forEach(pl => {
    if (!pl.enabled) return;
    (pl.cards || []).forEach(c => { if (c.enabled) known.push({ id: 'plugin:' + pl.name + ':' + c.id, label: c.title || c.id }); });
  });
  const order = Array.isArray(sc.order) ? sc.order.filter(id => known.some(k => k.id === id)) : [];
  const rest = known.filter(k => !order.includes(k.id));
  const ordered = order.map(id => known.find(k => k.id === id)).concat(rest);
  const hidden = new Set(Array.isArray(sc.hidden) ? sc.hidden : []);
  state.cardsList = ordered.map(k => Object.assign({}, k, { hidden: hidden.has(k.id) }));
}

function renderUntrustedCardsList() {
  const box = container && container.querySelector('#settings-cards-untrusted');
  if (!box) return;
  const rows = [];
  (state.pluginsList || []).forEach(pl => {
    (pl.cards || []).forEach(c => { if (!c.enabled) rows.push(`「${pl.title || pl.name}」的「${c.title || c.id}」卡：${c.disabledReason || '未信任，未載入'}`); });
  });
  box.innerHTML = rows.map(r => esc(r)).map(r => `<div>${r}</div>`).join('');
}

function renderCardsList() {
  const box = container && container.querySelector('#settings-cards-list');
  if (!box) return;
  box.innerHTML = state.cardsList.map((c, i) => `
    <div class="flex items-center gap-2 p-2 rounded-lg bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800" data-idx="${i}">
      <input type="checkbox" data-act="shown" ${c.hidden ? '' : 'checked'} title="顯示於輪播" class="rounded border-slate-300 dark:border-slate-600 flex-shrink-0">
      <span class="text-sm text-slate-700 dark:text-slate-300 truncate flex-1">${esc(c.label)}</span>
      <span class="text-[10px] font-mono text-slate-400 dark:text-slate-500 flex-shrink-0">${esc(c.id)}</span>
      <div class="flex items-center gap-0.5 flex-shrink-0">
        <button data-act="up" title="上移" class="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400"><i data-lucide="chevron-up" class="h-3.5 w-3.5"></i></button>
        <button data-act="down" title="下移" class="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400"><i data-lucide="chevron-down" class="h-3.5 w-3.5"></i></button>
      </div>
    </div>`).join('');
  box.querySelectorAll('[data-idx]').forEach(row => {
    const idx = parseInt(row.getAttribute('data-idx'), 10);
    const shownCb = row.querySelector('[data-act="shown"]');
    if (shownCb) shownCb.addEventListener('change', () => { state.cardsList[idx].hidden = !shownCb.checked; });
    const upBtn = row.querySelector('[data-act="up"]');
    if (upBtn) upBtn.addEventListener('click', () => { if (idx > 0) { [state.cardsList[idx - 1], state.cardsList[idx]] = [state.cardsList[idx], state.cardsList[idx - 1]]; renderCardsList(); if (typeof lucide !== 'undefined') lucide.createIcons(); } });
    const downBtn = row.querySelector('[data-act="down"]');
    if (downBtn) downBtn.addEventListener('click', () => { if (idx < state.cardsList.length - 1) { [state.cardsList[idx + 1], state.cardsList[idx]] = [state.cardsList[idx], state.cardsList[idx + 1]]; renderCardsList(); if (typeof lucide !== 'undefined') lucide.createIcons(); } });
  });
  renderUntrustedCardsList();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// SBC-5: realtime validation mirroring server.js's isValidRotateSeconds/isValidQuotaRefreshSeconds —
// blocks Save client-side with the same message the server would 400 with, instead of a round-trip.
function sidebarCardsValidationError() {
  const rotateEl = container && container.querySelector('#settings-sbc-rotate');
  const refreshEl = container && container.querySelector('#settings-sbc-quota-refresh');
  if (!rotateEl || !refreshEl) return '';
  const rotate = parseInt(rotateEl.value, 10);
  const refresh = parseInt(refreshEl.value, 10);
  if (!Number.isInteger(rotate) || !(rotate === 0 || (rotate >= 3 && rotate <= 120))) return '輪播秒數須為 0 或 3–120 的整數';
  if (!Number.isInteger(refresh) || !(refresh === 0 || (refresh >= 30 && refresh <= 3600))) return '用量刷新秒數須為 0 或 30–3600 的整數';
  return '';
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

// WSXU (§24 D24): slug format — lowercase alnum, starting with alnum, up to 40 chars.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

// The alias actually used to build a URL: the working (possibly unsaved) slug if non-empty, else name.
function pluginKey(p) { return (p.slug || '').trim() || p.name; }

function pluginUrls(p) {
  const key = pluginKey(p);
  return {
    embed: '/app/x/' + encodeURIComponent(key),
    standalone: '/x/' + encodeURIComponent(key),
    api: '/api/x/' + encodeURIComponent(p.name) + '/',
    embedExternal: '/app/xurl/' + encodeURIComponent(key),
  };
}

// WSXW (§30 D30): externalUrl is fed into window.open()/iframe src — only http(s) accepted, up to
// 500 chars. Mirrors server.js's isValidExternalUrl() so the UI blocks before a round-trip 400.
function isValidExternalUrl(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 500 && /^https?:\/\//i.test(v);
}

// WSXW (§26 D26/D31): validate a plugin row's two-dimension open settings. Blocks saving when
// target=external but externalUrl is missing/malformed (§32-4/5) — mirrors slugValidationForIndex.
function targetValidationForIndex(idx) {
  const p = state.pluginsList[idx];
  if (!p || p.target !== 'external') return { error: '' };
  const v = (p.externalUrl || '').trim();
  if (!v) return { error: '選了外部網址但尚未填寫' };
  if (!isValidExternalUrl(v)) return { error: '網址格式錯誤：需以 http:// 或 https:// 開頭' };
  return { error: '' };
}

// WSXU (§24): realtime validation for the slug at `idx` against the *other* rows currently on this
// page. Format errors and same-page duplicate slugs block saving (§24-4/5); colliding with another
// plugin's `name` is allowed (D24: name resolves first) and only warns.
function slugValidationForIndex(idx) {
  const list = state.pluginsList;
  const raw = (list[idx].slug || '').trim();
  if (!raw) return { error: '', warning: '' };
  if (!SLUG_RE.test(raw)) return { error: '格式錯誤：需為小寫英數字與連字號，且以英數字開頭（1–40 字）', warning: '' };
  const dupSlug = list.some((q, j) => j !== idx && (q.slug || '').trim() === raw);
  if (dupSlug) return { error: '此代稱已被其他外掛使用', warning: '' };
  const dupName = list.some((q, j) => j !== idx && q.name === raw);
  if (dupName) return { error: '', warning: '此代稱與另一個外掛的識別名相同：該識別名優先解析，此網址仍會開到原本那個外掛（D24）' };
  return { error: '', warning: '' };
}

function pluginsHaveError() {
  return state.pluginsList.some((_, i) => !!slugValidationForIndex(i).error || !!targetValidationForIndex(i).error);
}

// Re-derive and patch only the per-row bits that depend on slug (urls / error / warning text +
// visibility) without touching the <input> nodes themselves — full re-render on every keystroke
// would steal focus and reset the caret mid-typing (§24: "realtime" must not fight the user).
function refreshPluginRows() {
  const box = container.querySelector('#settings-plugins-list');
  if (!box) return;
  box.querySelectorAll('[data-idx]').forEach(row => {
    const idx = parseInt(row.getAttribute('data-idx'), 10);
    const p = state.pluginsList[idx];
    if (!p) return;
    const urls = pluginUrls(p);
    const embedEl = row.querySelector('[data-act="url-embed"]');
    if (embedEl) embedEl.textContent = urls.embed;
    const standaloneEl = row.querySelector('[data-act="url-standalone"]');
    if (standaloneEl) standaloneEl.textContent = urls.standalone;
    const { error, warning } = slugValidationForIndex(idx);
    const errEl = row.querySelector('[data-act="slug-error"]');
    if (errEl) { errEl.textContent = error; errEl.classList.toggle('hidden', !error); }
    const warnEl = row.querySelector('[data-act="slug-warning"]');
    if (warnEl) { warnEl.textContent = warning; warnEl.classList.toggle('hidden', !warning); }
    const slugInput = row.querySelector('[data-act="slug"]');
    if (slugInput) slugInput.classList.toggle('border-red-400', !!error);

    // WSXW (§29/§30): external-target rows show an external-URL input + a 4th read-only URL row +
    // an "iframe may be blocked" hint (only when openIn=embed), all dependent on `target`/`openIn` —
    // patched here too so toggling either dropdown updates without a full re-render (which would
    // steal focus from the URL <input> mid-typing).
    const isExternal = p.target === 'external';
    const extInputRow = row.querySelector('[data-act="external-input-row"]');
    if (extInputRow) extInputRow.classList.toggle('hidden', !isExternal);
    const extUrlRow = row.querySelector('[data-act="url-external-row"]');
    if (extUrlRow) extUrlRow.classList.toggle('hidden', !isExternal);
    const extUrlEl = row.querySelector('[data-act="url-external"]');
    if (extUrlEl) extUrlEl.textContent = p.externalUrl || '';
    const embedHintEl = row.querySelector('[data-act="embed-external-hint"]');
    if (embedHintEl) embedHintEl.classList.toggle('hidden', !(isExternal && p.openIn !== 'tab'));
    const { error: targetError } = targetValidationForIndex(idx);
    const targetErrEl = row.querySelector('[data-act="target-error"]');
    if (targetErrEl) { targetErrEl.textContent = targetError; targetErrEl.classList.toggle('hidden', !targetError); }
    const externalUrlInput = row.querySelector('[data-act="external-url"]');
    if (externalUrlInput) externalUrlInput.classList.toggle('border-red-400', !!targetError);
  });
  updateSaveButtonState();
}

function updateSaveButtonState() {
  const saveBtn = container.querySelector('#settings-save');
  if (!saveBtn) return;
  const blocked = pluginsHaveError();
  saveBtn.disabled = blocked;
  saveBtn.title = blocked ? '有外掛代稱格式錯誤或重複，請先修正' : '';
  saveBtn.classList.toggle('opacity-50', blocked);
  saveBtn.classList.toggle('cursor-not-allowed', blocked);
}

async function copyPluginUrl(text, el) {
  try {
    await navigator.clipboard.writeText(text);
    if (typeof showToast === 'function') showToast('已複製', 'success');
  } catch (e) {
    // Fallback (§22/§24): clipboard API unavailable/denied — select the text so the user can Ctrl+C.
    if (el) {
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (_) { /* ignore selection failures, still show the hint below */ }
    }
    if (typeof showToast === 'function') showToast('無法自動複製，已選取文字，請手動複製', 'error');
  }
}

// WSX2 (§8.5): plugin label/icon/name are read-only here (D5) — only the shown-checkbox and
// up/down order matter. WSXU (§20-§22 / D20-D24) adds a per-row slug (alias) input plus a
// read-only routes block (embed / standalone / API) so every plugin's URLs are visible even when
// left as 'embed'. Mirrors renderSections()'s in-memory-array + full-rerender pattern.
function renderPlugins() {
  const box = container.querySelector('#settings-plugins-list');
  if (!box) return;
  if (!state.pluginsList.length) {
    box.innerHTML = `<div class="text-xs text-slate-400 dark:text-slate-500 italic py-2 space-y-1">
      <div>此工作區沒有外掛。</div>
      <div>外掛放在 <code class="font-mono">${esc(state.editRoot)}\\.harness\\plugins\\&lt;名稱&gt;\\plugin.json</code></div>
    </div>`;
    updateSaveButtonState();
    return;
  }
  box.innerHTML = state.pluginsList.map((p, i) => {
    const urls = pluginUrls(p);
    const { error, warning } = slugValidationForIndex(i);
    const { error: targetError } = targetValidationForIndex(i);
    const openIn = p.openIn === 'tab' ? 'tab' : 'embed';
    const target = p.target === 'external' ? 'external' : 'internal';
    const isExternal = target === 'external';
    const showEmbedHint = isExternal && openIn !== 'tab';
    return `
    <div class="flex flex-col gap-1.5 p-2 rounded-lg bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800" data-idx="${i}">
      <div class="flex items-center gap-2">
        <input type="checkbox" data-act="shown" ${p.hidden ? '' : 'checked'} title="顯示於側邊欄" class="rounded border-slate-300 dark:border-slate-600 flex-shrink-0">
        <i data-lucide="${esc(p.icon || 'puzzle')}" class="h-4 w-4 text-slate-400 flex-shrink-0"></i>
        <span class="text-sm text-slate-700 dark:text-slate-300 truncate flex-1">${esc(p.title || p.name)}</span>
        <span class="text-[11px] font-mono text-slate-400 dark:text-slate-500 truncate flex-shrink-0">${esc(p.name)}</span>
        ${!p.enabled ? `<span class="text-[11px] text-slate-400 dark:text-slate-500 flex-shrink-0">未信任：${esc(p.disabledReason || '')}</span>` : ''}
        <select data-act="open-in" title="開啟方式" class="text-[11px] rounded border-slate-300 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-300 flex-shrink-0">
          <option value="embed" ${openIn === 'embed' ? 'selected' : ''}>內嵌</option>
          <option value="tab" ${openIn === 'tab' ? 'selected' : ''}>新分頁</option>
        </select>
        <select data-act="target" title="連到哪裡" class="text-[11px] rounded border-slate-300 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-300 flex-shrink-0">
          <option value="internal" ${target === 'internal' ? 'selected' : ''}>內部路由</option>
          <option value="external" ${target === 'external' ? 'selected' : ''}>外部網址</option>
        </select>
        <div class="flex items-center gap-0.5 flex-shrink-0">
          <button data-act="up" title="上移" class="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400"><i data-lucide="chevron-up" class="h-3.5 w-3.5"></i></button>
          <button data-act="down" title="下移" class="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400"><i data-lucide="chevron-down" class="h-3.5 w-3.5"></i></button>
        </div>
      </div>
      <div data-act="external-input-row" class="flex items-center gap-2 pl-6 ${isExternal ? '' : 'hidden'}">
        <label class="text-[11px] text-slate-400 dark:text-slate-500 flex-shrink-0">外部網址</label>
        <input type="text" data-act="external-url" value="${esc(p.externalUrl || '')}" placeholder="http://localhost:5090" spellcheck="false"
          class="flex-1 min-w-0 px-2 py-1 rounded border ${targetError ? 'border-red-400' : 'border-slate-300 dark:border-slate-700'} bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 text-[11px] font-mono">
      </div>
      <div data-act="target-error" class="pl-6 text-[11px] text-red-500 ${targetError ? '' : 'hidden'}">${esc(targetError)}</div>
      <div data-act="embed-external-hint" class="pl-6 text-[11px] text-slate-400 dark:text-slate-500 ${showEmbedHint ? '' : 'hidden'}">有些網站會在標頭禁止被嵌入，這種情況會看到空白</div>
      <div class="flex items-center gap-2 pl-6">
        <label class="text-[11px] text-slate-400 dark:text-slate-500 flex-shrink-0">網址代稱</label>
        <input type="text" data-act="slug" value="${esc(p.slug || '')}" placeholder="${esc(p.name)}" spellcheck="false"
          class="flex-1 min-w-0 px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 text-[11px] font-mono">
      </div>
      <div data-act="slug-error" class="pl-6 text-[11px] text-red-500 ${error ? '' : 'hidden'}">${esc(error)}</div>
      <div data-act="slug-warning" class="pl-6 text-[11px] text-amber-500 ${warning ? '' : 'hidden'}">${esc(warning)}</div>
      <div class="pl-6 space-y-0.5">
        <div class="flex items-center gap-1.5">
          <span class="text-[10px] text-slate-400 dark:text-slate-500 w-10 flex-shrink-0">內嵌</span>
          <code data-act="url-embed" class="flex-1 min-w-0 truncate text-[11px] font-mono text-slate-600 dark:text-slate-400">${esc(urls.embed)}</code>
          <button data-act="copy-embed" title="複製內嵌網址" class="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400 flex-shrink-0"><i data-lucide="copy" class="h-3 w-3"></i></button>
        </div>
        <div class="flex items-center gap-1.5">
          <span class="text-[10px] text-slate-400 dark:text-slate-500 w-10 flex-shrink-0">獨立</span>
          <code data-act="url-standalone" class="flex-1 min-w-0 truncate text-[11px] font-mono text-slate-600 dark:text-slate-400">${esc(urls.standalone)}</code>
          <button data-act="copy-standalone" title="複製獨立網址" class="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400 flex-shrink-0"><i data-lucide="copy" class="h-3 w-3"></i></button>
        </div>
        <div class="flex items-center gap-1.5">
          <span class="text-[10px] text-slate-400 dark:text-slate-500 w-10 flex-shrink-0">API</span>
          <code data-act="url-api" class="flex-1 min-w-0 truncate text-[11px] font-mono text-slate-600 dark:text-slate-400">${esc(urls.api)}</code>
          <button data-act="copy-api" title="複製 API 網址" class="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400 flex-shrink-0"><i data-lucide="copy" class="h-3 w-3"></i></button>
        </div>
        <div class="text-[10px] text-slate-400 dark:text-slate-500 pl-11">由外掛程式使用、不可更改</div>
        <div data-act="url-external-row" class="flex items-center gap-1.5 ${isExternal ? '' : 'hidden'}">
          <span class="text-[10px] text-slate-400 dark:text-slate-500 w-10 flex-shrink-0">外部</span>
          <code data-act="url-external" class="flex-1 min-w-0 truncate text-[11px] font-mono text-slate-600 dark:text-slate-400">${esc(p.externalUrl || '')}</code>
        </div>
      </div>
    </div>`;
  }).join('');

  box.querySelectorAll('[data-idx]').forEach(row => {
    const idx = parseInt(row.getAttribute('data-idx'), 10);
    const shownCb = row.querySelector('[data-act="shown"]');
    if (shownCb) shownCb.addEventListener('change', () => { state.pluginsList[idx].hidden = !shownCb.checked; });
    const openInSel = row.querySelector('[data-act="open-in"]');
    if (openInSel) openInSel.addEventListener('change', () => { state.pluginsList[idx].openIn = openInSel.value; refreshPluginRows(); });
    const targetSel = row.querySelector('[data-act="target"]');
    if (targetSel) targetSel.addEventListener('change', () => { state.pluginsList[idx].target = targetSel.value; refreshPluginRows(); });
    const externalUrlInput = row.querySelector('[data-act="external-url"]');
    if (externalUrlInput) externalUrlInput.addEventListener('input', () => { state.pluginsList[idx].externalUrl = externalUrlInput.value; refreshPluginRows(); });
    const upBtn = row.querySelector('[data-act="up"]');
    if (upBtn) upBtn.addEventListener('click', () => { if (idx > 0) { [state.pluginsList[idx - 1], state.pluginsList[idx]] = [state.pluginsList[idx], state.pluginsList[idx - 1]]; renderPlugins(); if (typeof lucide !== 'undefined') lucide.createIcons(); } });
    const downBtn = row.querySelector('[data-act="down"]');
    if (downBtn) downBtn.addEventListener('click', () => { if (idx < state.pluginsList.length - 1) { [state.pluginsList[idx + 1], state.pluginsList[idx]] = [state.pluginsList[idx], state.pluginsList[idx + 1]]; renderPlugins(); if (typeof lucide !== 'undefined') lucide.createIcons(); } });
    const slugInput = row.querySelector('[data-act="slug"]');
    if (slugInput) slugInput.addEventListener('input', () => {
      state.pluginsList[idx].slug = slugInput.value;
      // Revalidate every row, not just this one: e.g. clearing a duplicate here should also clear
      // the "already used" error on the row it used to collide with.
      refreshPluginRows();
    });
    const copyEmbed = row.querySelector('[data-act="copy-embed"]');
    if (copyEmbed) copyEmbed.addEventListener('click', () => copyPluginUrl(pluginUrls(state.pluginsList[idx]).embed, row.querySelector('[data-act="url-embed"]')));
    const copyStandalone = row.querySelector('[data-act="copy-standalone"]');
    if (copyStandalone) copyStandalone.addEventListener('click', () => copyPluginUrl(pluginUrls(state.pluginsList[idx]).standalone, row.querySelector('[data-act="url-standalone"]')));
    const copyApi = row.querySelector('[data-act="copy-api"]');
    if (copyApi) copyApi.addEventListener('click', () => copyPluginUrl(pluginUrls(state.pluginsList[idx]).api, row.querySelector('[data-act="url-api"]')));
  });
  if (typeof lucide !== 'undefined') lucide.createIcons();
  updateSaveButtonState();
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
    state.pluginsList = (await loadPluginsFor(state.editRoot)).map(p => Object.assign({}, p));
    render();
  });

  const avatarInput = container.querySelector('#settings-avatar');
  if (avatarInput) avatarInput.addEventListener('input', updateAvatarPreview);

  const resetBtn = container.querySelector('#settings-avatar-reset');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    avatarInput.value = 'portal/hana_face.png';
    updateAvatarPreview();
  });

  const quotaRefreshBtn = container.querySelector('#settings-quota-refresh');
  if (quotaRefreshBtn) quotaRefreshBtn.addEventListener('click', loadQuota);

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

  // WSX2 (§8.4): order = current row order (all names, shown or hidden); hidden = the subset whose
  // checkbox got unchecked. Not validated against the live plugin list server-side (§8.4 note) —
  // a plugin may belong to a workspace that isn't mounted right now.
  // WSXW (§28 D28): openMode is no longer written by this page — openIn/target/externalUrl replace
  // it (server derives a legacy openMode value from them for old front-ends, see applyPluginManifestOrder).

  if (pluginsHaveError()) {
    if (typeof showToast === 'function') showToast('有外掛代稱格式錯誤或重複、或外部網址未填/格式錯誤，請先修正再儲存', 'error');
    return;
  }
  const sbcError = sidebarCardsValidationError();
  const sbcErrorEl = container.querySelector('#settings-sbc-error');
  if (sbcError) {
    if (sbcErrorEl) { sbcErrorEl.textContent = sbcError; sbcErrorEl.classList.remove('hidden'); }
    if (typeof showToast === 'function') showToast(sbcError, 'error');
    return;
  } else if (sbcErrorEl) { sbcErrorEl.classList.add('hidden'); }
  const slug = {};
  state.pluginsList.forEach(p => { const v = (p.slug || '').trim(); if (v) slug[p.name] = v; });

  // WSXW (§28/§32-3): openIn/target/externalUrl omit default values (embed/internal/'') to keep
  // harness.json clean, mirroring slug's "empty omitted" convention above.
  const openIn = {};
  const target = {};
  const externalUrl = {};
  state.pluginsList.forEach(p => {
    if (p.openIn === 'tab') openIn[p.name] = 'tab';
    if (p.target === 'external') {
      target[p.name] = 'external';
      const v = (p.externalUrl || '').trim();
      if (v) externalUrl[p.name] = v;
    }
  });

  const plugins = {
    order: state.pluginsList.map(p => p.name),
    hidden: state.pluginsList.filter(p => p.hidden).map(p => p.name),
    slug,
    openIn,
    target,
    externalUrl,
  };

  const payload = {
    root: state.editRoot,
    name: container.querySelector('#settings-name').value.trim(),
    subtitle: container.querySelector('#settings-subtitle').value,
    icon: container.querySelector('#settings-icon').value.trim() || 'shield',
    avatar: container.querySelector('#settings-avatar').value.trim() || 'portal/hana_face.png',
    nav,
    sidebar: { sections: state.sections.filter(s => s.path) },
    tools,
    plugins,
    // SBC-5 (§7): order = current row order (all card ids, shown or hidden); hidden = the subset
    // whose checkbox got unchecked. Mirrors the plugins order/hidden convention above.
    sidebarCards: {
      rotateSeconds: parseInt(container.querySelector('#settings-sbc-rotate').value, 10),
      quotaRefreshSeconds: parseInt(container.querySelector('#settings-sbc-quota-refresh').value, 10),
      order: state.cardsList.map(c => c.id),
      hidden: state.cardsList.filter(c => c.hidden).map(c => c.id),
    },
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
      // WSX1 (SPEC-workspace-settings.md §9.3): reloadShell() also repaints file sections /
      // plugins / skills tree that applyManifest() alone never touched. silent:true — the line
      // below already announces success, no need to stack a second "選單已更新" toast on top.
      if (typeof window.reloadShell === 'function') await window.reloadShell({ silent: true }).catch(() => {});
      else if (typeof window.applyManifest === 'function') window.applyManifest(data.manifest);
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
  state.pluginsList = (await loadPluginsFor(state.editRoot)).map(p => Object.assign({}, p));
  render();
}

export function unmount() {
  if (container) { container.classList.add('hidden'); container.innerHTML = ''; }
  container = null;
}

// SPEC-whiteboard.md §4 (WB1) — 白板 view 模組（L0 底座：Excalidraw 離線 vendor）。
// 新增面板，無 legacy DOM 可搬遷，故採 notes.js/pm.js 那種「自足 view」寫法，不依賴 index.html 的
// 舊 showPanel()/switchToX() 相容層（§V13 已拔除，見 router.js 開頭註解）。
//
// 已知地雷（vendor 载入順序，見 SPEC-whiteboard.md §4.1）：
//   1. Excalidraw UMD 會讀 process.env.IS_PREACT → 載入前必須先 shim window.process。
//   2. window.EXCALIDRAW_ASSET_PATH 必須在載入 excalidraw.production.min.js 之前設好，且尾斜線不可省
//      （離線環境沒有網路，缺尾斜線會讓它去打 unpkg 抓字型）。
//   3. React UMD 必須先於 ReactDOM、ReactDOM 必須先於 excalidraw，三支都掛在 window 上供 UMD 消費。
// 這幾支加起來 ~1.6MB，只在第一次開白板面板時才動態注入 <script>，不進 portal 開機路徑。

import { createBeautifyEngine } from './wb-beautify.js';

export const meta = { route: '/app/whiteboard', title: '白板', icon: 'pen-tool', menuGroup: 'whiteboard' };

const AUTOSAVE_DEBOUNCE_MS = 1500;
const AUTOSAVE_FALLBACK_MS = 30000;
const SIZE_WARN_BYTES = 8 * 1024 * 1024; // §5.1 — 只警告不擋存
const REMOTE_POLL_MS = 2000; // §8.2 (WB4/WB-17)：單人使用，2 秒輪詢足夠，不引入 SSE
const THUMBNAIL_MAX_EDGE = 1600; // §8.3.1 (WB5/WB-19) — D6：縮圖長邊上限

// appState 有些欄位（如 collaborators）是 Map，不可 JSON 序列化；只挑存檔真的需要的子集，
// 涵蓋「縮放後元素座標正確、存檔還原不跑位」的 DoD（scrollX/scrollY/zoom）與畫筆預設值。
const APP_STATE_PERSIST_KEYS = [
  'viewBackgroundColor', 'scrollX', 'scrollY', 'zoom', 'gridSize',
  'currentItemStrokeColor', 'currentItemBackgroundColor', 'currentItemFillStyle',
  'currentItemStrokeWidth', 'currentItemStrokeStyle', 'currentItemRoughness', 'currentItemOpacity',
  'currentItemFontFamily', 'currentItemFontSize', 'currentItemTextAlign', 'currentItemStartArrowhead',
  'currentItemEndArrowhead', 'name', 'autoBeautify'
];

let container = null;
let reactRoot = null;
let vendorPromise = null;
let excalidrawAPI = null;
let currentBoard = null;   // { id, title, elements, appState, files, updatedAt }
let boardList = [];
let saveDebounceTimer = null;
let saveFallbackTimer = null;
let pollTimer = null;
let polling = false; // reentrancy guard — a slow doSave()/apiGet() must not overlap the next tick
let dirty = false;
let themeObserver = null;
let destroyed = false;
let beautifyEngine = null;
let autoBeautifyEnabled = true;
let fullscreenChangeHandler = null;
let thumbnailDataUrl = null; // §8.3.1 (WB5/WB-19) — 最新畫布縮圖快取（PNG dataURL），getChatContext() 只回傳這份快取
const badgeState = new Map(); // elId -> { el: HTMLElement, timer }

function isDark() { return document.documentElement.classList.contains('dark'); }

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('無法載入 ' + src));
    document.head.appendChild(s);
  });
}

// 依序載入 vendor（只做一次，之後回傳同一個已完成的 Promise）。
function ensureVendorLoaded() {
  if (vendorPromise) return vendorPromise;
  vendorPromise = (async () => {
    window.process = window.process || { env: {} }; // 地雷 1
    window.EXCALIDRAW_ASSET_PATH = '/vendor/excalidraw/'; // 地雷 2：尾斜線不可省
    if (!window.React) await loadScript('/vendor/excalidraw/react.production.min.js');
    if (!window.ReactDOM) await loadScript('/vendor/excalidraw/react-dom.production.min.js');
    if (!window.ExcalidrawLib) await loadScript('/vendor/excalidraw/excalidraw.production.min.js');
    if (!window.ExcalidrawLib || !window.ExcalidrawLib.Excalidraw) {
      throw new Error('excalidraw 載入後未掛上 window.ExcalidrawLib.Excalidraw');
    }
    return window.ExcalidrawLib;
  })();
  return vendorPromise;
}

function persistableAppState(appState) {
  const out = {};
  if (!appState) return out;
  for (const k of APP_STATE_PERSIST_KEYS) { if (k in appState) out[k] = appState[k]; }
  return out;
}

function esc(str) { return window.escapeHtml ? window.escapeHtml(String(str == null ? '' : str)) : String(str == null ? '' : str); }

function shellHtml() {
  return (
    // 左列表／右內容，跟 AI 對話（chat.js）、文件管理（documents.js）同一套版式，不再只靠下拉選單。
    '<section class="flex-1 overflow-hidden flex h-full bg-slate-50/50 dark:bg-slate-900/40">'
    + '<div class="w-72 flex-shrink-0 border-r border-slate-200 dark:border-slate-800 flex flex-col bg-white/40 dark:bg-slate-900/30">'
    + '<div class="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between flex-shrink-0">'
    + '<span class="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">白板列表</span>'
    + '<button id="wb-new-btn" title="新白板" class="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-850 text-cyan-600 dark:text-cyan-400"><i data-lucide="plus-circle" class="h-4 w-4"></i></button>'
    + '</div>'
    + '<div id="wb-list" class="flex-1 overflow-y-auto p-2 space-y-1"></div>'
    + '</div>'
    + '<div id="wb-right" class="flex-1 flex flex-col overflow-hidden bg-slate-50/50 dark:bg-slate-900/40">'
    + '<div class="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/50 flex-wrap gap-2 flex-shrink-0">'
    + '<div class="flex items-center gap-2 min-w-0">'
    + '<span id="wb-current-title" class="text-sm font-semibold text-slate-700 dark:text-slate-200 truncate max-w-[220px]"></span>'
    + '<span id="wb-save-status" class="text-[11px] text-slate-400 dark:text-slate-500 ml-1"></span>'
    + '</div>'
    + '<div class="flex items-center gap-2">'
    + '<button id="wb-beautify-toggle" title="自動美化：手繪直線拉直、圓圈變正圓（不重畫成其他形狀）" class="px-2.5 py-1.5 rounded-lg bg-cyan-50 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-300 text-xs font-medium flex items-center gap-1"><i data-lucide="wand-2" class="h-3.5 w-3.5"></i><span id="wb-beautify-toggle-label">自動美化：開</span></button>'
    + '<button id="wb-interpret-btn" title="🔍 AI 判讀：框選一段筆跡，辨識文字或自訂 prompt 判讀" class="px-2.5 py-1.5 rounded-lg bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 text-xs font-medium flex items-center gap-1"><i data-lucide="search" class="h-3.5 w-3.5"></i>AI 判讀</button>'
    + '<button id="wb-export-btn" title="匯出 PNG" class="px-2.5 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-xs font-medium flex items-center gap-1"><i data-lucide="image-down" class="h-3.5 w-3.5"></i>匯出 PNG</button>'
    + '<button id="wb-save-btn" title="手動儲存" class="px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 text-xs font-medium flex items-center gap-1"><i data-lucide="save" class="h-3.5 w-3.5"></i>儲存</button>'
    // 全螢幕作用在 #wb-right（含這排工具列），跟 pm.js 的 pmToggleFullscreen 同套手法：進全螢幕
    // 後左側白板列表隱去，工具列（含下面新增的主題切換）仍在畫面內可操作。
    + '<button id="wb-fullscreen-btn" title="全螢幕" class="p-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-300 transition-colors"><i id="wb-fullscreen-icon" data-lucide="maximize" class="h-3.5 w-3.5"></i></button>'
    // 全域主題切換鈕掛在最外層 header，一旦白板進了全螢幕（Fullscreen API 只渲染該元素子樹）就構
    // 不到了；這裡另放一顆呼叫同一個 window.toggleTheme()，全螢幕內也能切換 Dark/Light。
    + '<button id="wb-theme-btn" title="切換主題 (Light/Dark)" class="p-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-300 transition-colors"><i id="wb-theme-icon" data-lucide="moon" class="h-3.5 w-3.5"></i></button>'
    + '</div>'
    + '</div>'
    + '<div id="wb-canvas-wrap" class="flex-1 relative min-h-0">'
    + '<div id="wb-loading" class="absolute inset-0 flex items-center justify-center text-sm text-slate-400">載入白板引擎中…</div>'
    + '<div id="wb-canvas" class="absolute inset-0"></div>'
    + '</div>'
    + '</div>'
    + '</section>'
  );
}

function setStatus(text) {
  const el = container && container.querySelector('#wb-save-status');
  if (el) el.textContent = text;
}

function fmtTime(iso) {
  return String(iso || '').slice(0, 16).replace('T', ' ');
}

// 左側白板列表——跟 chat.js 歷史對話、meeting.js 會議清單同一套「列表項 + hover 才顯示的
// 重新命名/刪除小圖示」版式，取代舊版只靠一顆 <select> 切換白板。
function renderList() {
  const list = container && container.querySelector('#wb-list');
  if (!list) return;
  list.innerHTML = boardList.map(b => {
    const active = currentBoard && currentBoard.id === b.id;
    return '<div class="group flex items-center gap-1 px-1 py-1 rounded-lg ' + (active ? 'bg-cyan-50 dark:bg-cyan-900/30' : 'hover:bg-slate-100 dark:hover:bg-slate-800') + ' transition-colors">'
      + '<button data-wb-open="' + esc(b.id) + '" class="flex-1 text-left min-w-0 px-2 py-1">'
      + '<div class="text-sm font-medium truncate ' + (active ? 'text-cyan-700 dark:text-cyan-300' : 'text-slate-700 dark:text-slate-200') + '">' + esc(b.title) + '</div>'
      + '<div class="text-[11px] text-slate-400 mt-0.5">' + esc(fmtTime(b.updatedAt || b.createdAt)) + '</div>'
      + '</button>'
      + '<div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">'
      + '<button data-wb-rename="' + esc(b.id) + '" title="重新命名" class="p-1.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400 hover:text-cyan-600 dark:hover:text-cyan-400 transition-colors"><i data-lucide="pencil" class="h-3.5 w-3.5"></i></button>'
      + '<button data-wb-delete="' + esc(b.id) + '" title="刪除白板" class="p-1.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 transition-colors"><i data-lucide="trash-2" class="h-3.5 w-3.5"></i></button>'
      + '</div>'
      + '</div>';
  }).join('');
  if (typeof lucide !== 'undefined') lucide.createIcons();
  const titleEl = container.querySelector('#wb-current-title');
  if (titleEl) titleEl.textContent = currentBoard ? currentBoard.title : '';
}

async function apiList() {
  const r = await fetch('/api/whiteboards');
  return r.ok ? r.json() : [];
}

async function apiCreate(title) {
  const r = await fetch('/api/whiteboards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
  return r.json();
}

async function apiGet(id) {
  const r = await fetch('/api/whiteboards/' + encodeURIComponent(id));
  return r.ok ? r.json() : null;
}

async function apiSave(id, patch) {
  const r = await fetch('/api/whiteboards/' + encodeURIComponent(id), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
  return r.ok ? r.json() : null;
}

async function apiDelete(id) {
  await fetch('/api/whiteboards/' + encodeURIComponent(id), { method: 'DELETE' });
}

function scheduleAutosave() {
  dirty = true;
  setStatus('編輯中…');
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(doSave, AUTOSAVE_DEBOUNCE_MS);
}

// §8.3.1 (WB5/WB-19)：在背景產生一張長邊 ≤1600px 的畫布縮圖快取（PNG dataURL），供
// getChatContext() 同步回傳（exportToBlob 本身是非同步，getChatContext() 不能 await，所以
// 一律讀這份「已備妥」的快取，不是每次現算）。D5：跟著既有存檔 debounce 走，不另開計時器。
// 護欄：空白板不留快取（不附圖）；失敗只記 log、不丟例外——縮圖只是加分，絕不能因為它卡住存檔
// 或讓對話失敗（降級成只送文字脈絡，見 CHAT_CONTEXT_PROVIDERS.whiteboard）。
async function captureThumbnail() {
  if (!excalidrawAPI || !window.ExcalidrawLib || destroyed) return;
  try {
    const elements = excalidrawAPI.getSceneElements().filter(e => e && !e.isDeleted);
    if (!elements.length) { thumbnailDataUrl = null; return; }
    const appState = excalidrawAPI.getAppState();
    const files = excalidrawAPI.getFiles();
    const blob = await window.ExcalidrawLib.exportToBlob({
      elements, appState, files, mimeType: 'image/png',
      getDimensions: (w, h) => {
        const scale = Math.min(1, THUMBNAIL_MAX_EDGE / Math.max(w, h));
        return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), scale };
      }
    });
    if (destroyed) return; // 這段 await 期間面板可能已卸載
    thumbnailDataUrl = await blobToDataUrl(blob);
  } catch (e) { console.warn('[whiteboard] 縮圖快取產生失敗（降級為純文字脈絡）', e); }
}

async function doSave() {
  if (!currentBoard || !excalidrawAPI || destroyed) return;
  if (saveDebounceTimer) { clearTimeout(saveDebounceTimer); saveDebounceTimer = null; }
  if (!dirty) return;
  dirty = false;
  let elements = excalidrawAPI.getSceneElements();
  // §8.2 (WB4/WB-17) 護欄的另一半：doSave() 本來是「本地場景整包覆蓋」，若 Hana 剛好在這之間
  // 用 elements API 寫入了新東西（例如剛完成的 mount 觸發了一次無意義的 onChange、把 dirty
  // 設回 true，1.5 秒後這裡才存檔），會把 Hana 剛寫入、本地還沒輪詢到的元素整個蓋掉。存檔前
  // 先問一次伺服器現在的版本，把「伺服器有、本地場景沒有」的元素（多半就是 Hana 剛寫的）併回
  // 本地場景再存，而不是無條件用本地覆蓋。
  try {
    const remote = await apiGet(currentBoard.id);
    if (remote && remote.updatedAt !== currentBoard.updatedAt) {
      const localIds = new Set(elements.map(e => e.id));
      const remoteExtra = (remote.elements || []).filter(e => e && !e.isDeleted && !localIds.has(e.id));
      if (remoteExtra.length && excalidrawAPI) {
        elements = elements.concat(remoteExtra);
        excalidrawAPI.updateScene({ elements, commitToHistory: false });
      }
    }
  } catch (e) { /* 併入失敗就照原本邏輯存，不因為背景檢查掛掉而完全不存檔 */ }
  const appState = persistableAppState(excalidrawAPI.getAppState());
  const files = excalidrawAPI.getFiles();
  currentBoard.elements = elements;
  currentBoard.appState = appState;
  currentBoard.files = files;
  const size = new Blob([JSON.stringify({ elements, appState, files })]).size;
  const saved = await apiSave(currentBoard.id, { elements, appState, files });
  if (saved && saved.updatedAt) currentBoard.updatedAt = saved.updatedAt;
  setStatus(size > SIZE_WARN_BYTES ? ('已儲存（' + (size / 1024 / 1024).toFixed(1) + 'MB，偏大）') : '已儲存');
  captureThumbnail(); // §8.3.1 (WB5/WB-19)：不 await——背景產生，不拖慢存檔流程
}

function onExcalidrawChange(elements) {
  scheduleAutosave();
  if (beautifyEngine) beautifyEngine.onSceneChange(elements);
}

function clearBadge(id) {
  const b = badgeState.get(id);
  if (!b) return;
  if (b.timer) clearTimeout(b.timer);
  if (b.el && b.el.parentNode) b.el.parentNode.removeChild(b.el);
  badgeState.delete(id);
}

// 依目前 scroll/zoom 把場景座標換算成畫布覆蓋層的螢幕座標（Excalidraw 慣例：
// screenCoord = (sceneCoord + scroll) * zoom）。
function showRevertBadge(newEl, originalEl) {
  if (!container || destroyed || !excalidrawAPI) return;
  clearBadge(newEl.id);
  const wrap = container.querySelector('#wb-canvas-wrap');
  if (!wrap) return;
  const appState = excalidrawAPI.getAppState();
  const zoom = (appState.zoom && appState.zoom.value) || 1;
  const left = (newEl.x + newEl.width + (appState.scrollX || 0)) * zoom + 6;
  const top = (newEl.y + (appState.scrollY || 0)) * zoom;
  const badge = document.createElement('button');
  badge.textContent = '↩ 保留手繪';
  badge.className = 'absolute z-10 text-[11px] px-2 py-1 rounded-md bg-slate-800/90 text-white shadow-lg hover:bg-slate-700 whitespace-nowrap';
  badge.style.left = left + 'px';
  badge.style.top = top + 'px';
  badge.addEventListener('click', () => {
    if (beautifyEngine) beautifyEngine.revertTo(newEl.id);
    clearBadge(newEl.id);
    scheduleAutosave();
  });
  wrap.appendChild(badge);
  const timer = setTimeout(() => clearBadge(newEl.id), 3000);
  badgeState.set(newEl.id, { el: badge, timer });
}

function isBeautifyEnabled() { return autoBeautifyEnabled; }

function updateBeautifyToggleLabel() {
  const label = container && container.querySelector('#wb-beautify-toggle-label');
  if (label) label.textContent = '自動美化：' + (autoBeautifyEnabled ? '開' : '關');
}

function toggleBeautify() {
  autoBeautifyEnabled = !autoBeautifyEnabled;
  updateBeautifyToggleLabel();
  if (excalidrawAPI) excalidrawAPI.updateScene({ appState: { autoBeautify: autoBeautifyEnabled }, commitToHistory: false });
  scheduleAutosave();
}

function mountExcalidraw(board) {
  const canvas = container.querySelector('#wb-canvas');
  const Lib = window.ExcalidrawLib;
  const React = window.React;
  for (const id of Array.from(badgeState.keys())) clearBadge(id);
  if (beautifyEngine) beautifyEngine.reset();
  autoBeautifyEnabled = (board.appState && typeof board.appState.autoBeautify === 'boolean') ? board.appState.autoBeautify : true;
  updateBeautifyToggleLabel();
  const initialData = {
    elements: board.elements || [],
    appState: Object.assign({}, board.appState || {}, { theme: isDark() ? 'dark' : 'light', autoBeautify: autoBeautifyEnabled }),
    files: board.files || {}
  };
  // initialData 只在「真的重新掛載」時才會被 Excalidraw 採用（官方行為：後續 re-render 只更新
  // props，不會重套 initialData）。切換白板若沿用同一個 Excalidraw 實例，新白板會誤繼承舊白板的
  // 場景（踩過的雷：切板後場景疊加、存檔互相污染）。用 key={board.id} 強制 React 卸載重掛。
  excalidrawAPI = null;
  if (!reactRoot) reactRoot = window.ReactDOM.createRoot(canvas);
  reactRoot.render(
    React.createElement(
      'div',
      { key: board.id, style: { height: '100%', width: '100%' } },
      React.createElement(Lib.Excalidraw, {
        key: board.id,
        initialData,
        theme: isDark() ? 'dark' : 'light',
        excalidrawAPI: (api) => { excalidrawAPI = api; },
        onChange: onExcalidrawChange
      })
    )
  );
}

function applyThemeToExcalidraw() {
  if (excalidrawAPI) excalidrawAPI.updateScene({ appState: { theme: isDark() ? 'dark' : 'light' } });
  const icon = container && container.querySelector('#wb-theme-icon');
  if (icon) { icon.setAttribute('data-lucide', isDark() ? 'sun' : 'moon'); if (typeof lucide !== 'undefined') lucide.createIcons(); }
}

async function loadBoard(id) {
  teardownInterpretUI(); // 換白板前清掉框選/判讀面板，避免殘留引用到舊白板的元素
  await doSave(); // 換白板前先存目前這張，不遺失
  const board = await apiGet(id);
  if (!board || destroyed) return;
  currentBoard = board;
  dirty = false;
  setStatus('');
  thumbnailDataUrl = null; // 換板：舊縮圖屬於別張白板，先清掉避免對話附錯圖
  renderList(); // 更新左側列表的選中高亮 + 右側標題
  mountExcalidraw(board);
  // §8.3.1 (WB5/WB-19)：開啟一張「已有內容但這次沒編輯」的既有白板時也要有縮圖可用——不能只靠
  // doSave() 觸發，否則指揮官單純打開白板問問題（沒動筆）就永遠拿不到圖。不 await，背景產生。
  captureThumbnail();
}

async function refreshList(selectId) {
  boardList = await apiList();
  if (destroyed) return;
  if (!boardList.length) {
    const created = await apiCreate('白板 1');
    boardList = await apiList();
    selectId = created.id;
  }
  renderList();
  await loadBoard(selectId || boardList[0].id);
}

async function renameBoard(id) {
  const board = boardList.find(b => b.id === id);
  if (!board) return;
  const name = window.prompt('重新命名白板', board.title);
  if (!name || !name.trim()) return;
  await apiSave(id, { title: name.trim() });
  if (currentBoard && currentBoard.id === id) currentBoard.title = name.trim();
  await refreshList(currentBoard ? currentBoard.id : id);
}

async function deleteBoard(id) {
  const board = boardList.find(b => b.id === id);
  if (!board) return;
  if (!window.confirm('刪除白板「' + board.title + '」？此動作無法復原。')) return;
  if (currentBoard && currentBoard.id === id) currentBoard = null;
  await apiDelete(id);
  await refreshList();
}

function wireEvents() {
  const $ = (sel) => container.querySelector(sel);
  $('#wb-list').addEventListener('click', (e) => {
    const openBtn = e.target.closest('[data-wb-open]');
    const renameBtn = e.target.closest('[data-wb-rename]');
    const deleteBtn = e.target.closest('[data-wb-delete]');
    if (renameBtn) { renameBoard(renameBtn.getAttribute('data-wb-rename')); return; }
    if (deleteBtn) { deleteBoard(deleteBtn.getAttribute('data-wb-delete')); return; }
    if (openBtn) { const id = openBtn.getAttribute('data-wb-open'); if (!currentBoard || currentBoard.id !== id) loadBoard(id); }
  });
  $('#wb-new-btn').addEventListener('click', async () => {
    const created = await apiCreate('白板 ' + (boardList.length + 1));
    await refreshList(created.id);
  });
  $('#wb-save-btn').addEventListener('click', () => { dirty = true; doSave(); });
  $('#wb-export-btn').addEventListener('click', exportPng);
  $('#wb-beautify-toggle').addEventListener('click', toggleBeautify);
  $('#wb-interpret-btn').addEventListener('click', startInterpretSelection);
  $('#wb-fullscreen-btn').addEventListener('click', toggleFullscreen);
  $('#wb-theme-btn').addEventListener('click', () => { if (typeof window.toggleTheme === 'function') window.toggleTheme(); });
}

// §WB — 全螢幕作用在 #wb-right（工具列 + 畫布），不含左側白板列表，跟 pm.js 的
// pmToggleFullscreen 同套手法：Fullscreen API 只渲染該元素子樹，工具列上的按鈕（含主題切換）
// 仍在畫面內可操作。
async function toggleFullscreen() {
  const el = container && container.querySelector('#wb-right');
  if (!el) return;
  try {
    if (document.fullscreenElement === el) await document.exitFullscreen();
    else await el.requestFullscreen();
  } catch (e) { /* 使用者拒絕或瀏覽器不支援，靜默略過 */ }
}

function updateFullscreenIcon() {
  const icon = container && container.querySelector('#wb-fullscreen-icon');
  if (!icon) return;
  const active = document.fullscreenElement === container.querySelector('#wb-right');
  icon.setAttribute('data-lucide', active ? 'minimize' : 'maximize');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function exportPng() {
  if (!excalidrawAPI || !window.ExcalidrawLib) return;
  const elements = excalidrawAPI.getSceneElements();
  const appState = excalidrawAPI.getAppState();
  const files = excalidrawAPI.getFiles();
  const blob = await window.ExcalidrawLib.exportToBlob({ elements, appState, files, mimeType: 'image/png' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (currentBoard ? currentBoard.title : 'whiteboard') + '.png';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ── WB4 (SPEC-whiteboard.md §8)：Hana 也能畫 — 前端同步 ───────────────────
// 面板開啟時每 2 秒輪詢 index.json 的 updatedAt（比整份 board.json 輕，且天生就是既有 apiList()
// 的資料）；變了才拉整份 board。護欄：本地有未存變更（dirty）時，先把本地變更存下去，才套用遠端
// 版本——寧可讓 Hana 剛寫入的東西被隨後的自動存檔覆蓋一次，也不能讓指揮官正在畫的筆跡被靜默蓋掉。
async function pollForRemoteChanges() {
  if (polling || destroyed || !currentBoard || !excalidrawAPI) return;
  polling = true;
  try {
    const list = await apiList();
    if (destroyed || !currentBoard) return;
    const meta = list.find(b => b.id === currentBoard.id);
    if (!meta || meta.updatedAt === currentBoard.updatedAt) return;
    if (dirty) await doSave(); // 先存再套用 — 保護指揮官尚未存檔的筆跡
    if (destroyed || !currentBoard) return;
    const board = await apiGet(currentBoard.id);
    if (!board || destroyed || !currentBoard || board.id !== currentBoard.id) return;
    currentBoard = board;
    dirty = false;
    excalidrawAPI.updateScene({ elements: board.elements || [], commitToHistory: false });
  } catch (e) { /* 背景同步，失敗就等下一輪 tick 再試，不打斷使用者 */ }
  finally { polling = false; }
}

// ── WB3 (SPEC-whiteboard.md §7)：框選 AI 判讀 ──────────────────────────────
const INTERPRET_TIMEOUT_MS = 90000;     // §7.2 護欄：單次逾時 90 秒（跟後端一致，前端多留 5 秒緩衝再 abort）
const MAX_SELECTION_EDGE = 4000;        // §7.2 護欄：框選邊長 > 4000px 先縮放再匯出
const TEXT_MODE_PROMPT = '辨識這張圖裡的手寫文字，只輸出文字本身，不要加說明';

let interpretOverlayEl = null;
let interpretRectEl = null;
let interpretDragStart = null;   // {x,y} 螢幕座標，相對 #wb-canvas-wrap
let interpretPanelEl = null;
let interpretSelBox = null;      // {x1,y1,x2,y2} 場景座標（已正規化 min/max）
let interpretSelElements = [];
let interpretInFlight = false;
let interpretLastPrompt = '';

function wbToast(msg) {
  if (typeof window.showToast === 'function') window.showToast(msg);
  else console.warn('[whiteboard]', msg);
}

// Excalidraw 慣例：screenCoord = (sceneCoord + scroll) * zoom（見 showRevertBadge 的反向換算）。
function screenToScene(sx, sy) {
  const appState = excalidrawAPI.getAppState();
  const zoom = (appState.zoom && appState.zoom.value) || 1;
  return { x: sx / zoom - (appState.scrollX || 0), y: sy / zoom - (appState.scrollY || 0) };
}

// 用元素自身的 bbox（x/y/width/height）做重疊判定；不處理旋轉角度（近似，接受此已知限制）。
function elementsInBox(elements, box) {
  return elements.filter(el => {
    if (!el || el.isDeleted) return false;
    const ex1 = el.x, ey1 = el.y, ex2 = el.x + el.width, ey2 = el.y + el.height;
    return ex1 < box.x2 && ex2 > box.x1 && ey1 < box.y2 && ey2 > box.y1;
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function cleanupInterpretOverlay() {
  if (interpretOverlayEl && interpretOverlayEl.parentNode) interpretOverlayEl.parentNode.removeChild(interpretOverlayEl);
  interpretOverlayEl = null;
  interpretRectEl = null;
  interpretDragStart = null;
  const btn = container && container.querySelector('#wb-interpret-btn');
  if (btn) btn.classList.remove('ring-2', 'ring-violet-500');
}

// 只拆掉面板 DOM，不動 interpretSelBox/interpretSelElements（openInterpretPromptPanel 開新面板前
// 用這個防呆清掉可能殘留的舊面板；closeInterpretPanel 才是「使用者按了關掉／取消整個框選」的語意）。
function removeInterpretPanelDom() {
  if (interpretPanelEl && interpretPanelEl.parentNode) interpretPanelEl.parentNode.removeChild(interpretPanelEl);
  interpretPanelEl = null;
}

function closeInterpretPanel() {
  removeInterpretPanelDom();
  interpretSelBox = null;
  interpretSelElements = [];
}

function teardownInterpretUI() {
  cleanupInterpretOverlay();
  closeInterpretPanel();
}

// 頂欄「🔍 AI 判讀」→ 進入框選模式：游標十字、畫布暫停繪圖（覆蓋層蓋在畫布上方接管滑鼠事件）。
function startInterpretSelection() {
  if (!excalidrawAPI || !container) return;
  if (interpretOverlayEl) { cleanupInterpretOverlay(); return; } // 再點一次＝取消框選模式
  closeInterpretPanel();
  const wrap = container.querySelector('#wb-canvas-wrap');
  if (!wrap) return;
  const btn = container.querySelector('#wb-interpret-btn');
  if (btn) btn.classList.add('ring-2', 'ring-violet-500');

  const overlay = document.createElement('div');
  overlay.id = 'wb-interpret-overlay';
  overlay.className = 'absolute inset-0 z-20 cursor-crosshair';
  wrap.appendChild(overlay);
  interpretOverlayEl = overlay;

  const onKeydown = (e) => { if (e.key === 'Escape') { cleanupInterpretOverlay(); document.removeEventListener('keydown', onKeydown); } };
  document.addEventListener('keydown', onKeydown);

  overlay.addEventListener('mousedown', (e) => {
    const r = wrap.getBoundingClientRect();
    interpretDragStart = { x: e.clientX - r.left, y: e.clientY - r.top };
    const rect = document.createElement('div');
    rect.className = 'absolute z-20 border-2 border-violet-500 bg-violet-500/10 pointer-events-none';
    rect.style.left = interpretDragStart.x + 'px';
    rect.style.top = interpretDragStart.y + 'px';
    overlay.appendChild(rect);
    interpretRectEl = rect;
  });
  overlay.addEventListener('mousemove', (e) => {
    if (!interpretDragStart || !interpretRectEl) return;
    const r = wrap.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    const x1 = Math.min(cx, interpretDragStart.x), y1 = Math.min(cy, interpretDragStart.y);
    const x2 = Math.max(cx, interpretDragStart.x), y2 = Math.max(cy, interpretDragStart.y);
    interpretRectEl.style.left = x1 + 'px'; interpretRectEl.style.top = y1 + 'px';
    interpretRectEl.style.width = (x2 - x1) + 'px'; interpretRectEl.style.height = (y2 - y1) + 'px';
  });
  overlay.addEventListener('mouseup', (e) => {
    if (!interpretDragStart) return;
    const r = wrap.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    const sx1 = Math.min(cx, interpretDragStart.x), sy1 = Math.min(cy, interpretDragStart.y);
    const sx2 = Math.max(cx, interpretDragStart.x), sy2 = Math.max(cy, interpretDragStart.y);
    cleanupInterpretOverlay();
    document.removeEventListener('keydown', onKeydown);
    if ((sx2 - sx1) < 8 || (sy2 - sy1) < 8) return; // 太小＝誤觸，視為取消
    const p1 = screenToScene(sx1, sy1), p2 = screenToScene(sx2, sy2);
    const box = { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
    const els = elementsInBox(excalidrawAPI.getSceneElements(), box);
    if (!els.length) { wbToast('框選範圍內沒有元素可判讀'); return; }
    interpretSelBox = box;
    interpretSelElements = els;
    openInterpretPromptPanel(sx2, sy1, wrap);
  });
}

function openInterpretPromptPanel(anchorX, anchorY, wrap) {
  removeInterpretPanelDom();
  const panel = document.createElement('div');
  panel.className = 'absolute z-30 w-72 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-xl p-3 text-xs';
  panel.style.left = Math.max(8, Math.min(anchorX + 8, wrap.clientWidth - 296)) + 'px';
  panel.style.top = Math.max(8, anchorY) + 'px';
  panel.innerHTML =
    '<div class="flex items-center gap-1 mb-2">'
    + '<button data-mode="text" class="wb-ip-mode-btn flex-1 px-2 py-1.5 rounded-lg font-medium">文字辨識</button>'
    + '<button data-mode="custom" class="wb-ip-mode-btn flex-1 px-2 py-1.5 rounded-lg font-medium">自訂 prompt</button>'
    + '</div>'
    + '<textarea id="wb-ip-prompt" rows="3" placeholder="例如：這是什麼架構？幫我列出元件" class="hidden w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 px-2 py-1.5 text-xs mb-2"></textarea>'
    + '<div class="flex items-center justify-end gap-2">'
    + '<button id="wb-ip-cancel" class="px-2 py-1 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700">取消</button>'
    + '<button id="wb-ip-send" class="px-3 py-1 rounded-lg bg-violet-600 hover:bg-violet-700 text-white font-medium">送出</button>'
    + '</div>';
  wrap.appendChild(panel);
  interpretPanelEl = panel;

  let mode = 'text';
  const modeButtons = panel.querySelectorAll('.wb-ip-mode-btn');
  const promptEl = panel.querySelector('#wb-ip-prompt');
  promptEl.value = interpretLastPrompt;
  const setMode = (m) => {
    mode = m;
    modeButtons.forEach(b => {
      const active = b.getAttribute('data-mode') === m;
      b.className = 'wb-ip-mode-btn flex-1 px-2 py-1.5 rounded-lg font-medium ' + (active ? 'bg-violet-600 text-white' : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300');
    });
    promptEl.classList.toggle('hidden', m !== 'custom');
  };
  setMode('text');
  modeButtons.forEach(b => b.addEventListener('click', () => setMode(b.getAttribute('data-mode'))));
  panel.querySelector('#wb-ip-cancel').addEventListener('click', closeInterpretPanel);
  panel.querySelector('#wb-ip-send').addEventListener('click', () => {
    const customPrompt = promptEl.value.trim();
    if (mode === 'custom' && !customPrompt) { wbToast('請輸入自訂 prompt'); return; }
    if (mode === 'custom') interpretLastPrompt = customPrompt;
    runInterpret(mode, mode === 'custom' ? customPrompt : TEXT_MODE_PROMPT);
  });
}

function showInterpretStatusPanel(text) {
  if (!interpretPanelEl) return;
  interpretPanelEl.innerHTML = '<div class="flex items-center gap-2 text-slate-500 dark:text-slate-400 py-2"><i data-lucide="loader-2" class="h-4 w-4 animate-spin"></i>' + esc(text) + '</div>';
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function showInterpretResultPanel(mode, text, isError) {
  if (!interpretPanelEl) return;
  const canReplace = mode === 'text' && !isError;
  interpretPanelEl.innerHTML =
    '<div class="text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">' + (isError ? '判讀失敗' : '判讀結果') + '</div>'
    + '<pre class="whitespace-pre-wrap break-words max-h-48 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 p-2 mb-2 '
      + (isError ? 'text-rose-600 dark:text-rose-400' : 'text-slate-700 dark:text-slate-200') + '">' + esc(text) + '</pre>'
    + (canReplace ? '<label class="flex items-center gap-1.5 mb-2 text-slate-500 dark:text-slate-400"><input id="wb-ip-replace" type="checkbox"> 取代原筆跡</label>' : '')
    + '<div class="flex items-center justify-end gap-2">'
    + '<button id="wb-ip-close" class="px-2 py-1 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700">關掉</button>'
    + (isError ? '' : '<button id="wb-ip-copy" class="px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 font-medium">複製</button>')
    + (isError ? '' : '<button id="wb-ip-insert" class="px-3 py-1 rounded-lg bg-violet-600 hover:bg-violet-700 text-white font-medium">插入白板</button>')
    + '</div>';
  const closeBtn = interpretPanelEl.querySelector('#wb-ip-close');
  if (closeBtn) closeBtn.addEventListener('click', closeInterpretPanel);
  if (!isError) {
    const copyBtn = interpretPanelEl.querySelector('#wb-ip-copy');
    if (copyBtn) copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(text).then(() => wbToast('已複製')).catch(() => wbToast('複製失敗'));
    });
    const insertBtn = interpretPanelEl.querySelector('#wb-ip-insert');
    if (insertBtn) insertBtn.addEventListener('click', () => {
      const replaceEl = interpretPanelEl.querySelector('#wb-ip-replace');
      insertInterpretResult(text, canReplace && replaceEl && replaceEl.checked);
      closeInterpretPanel();
    });
  }
}

function insertInterpretResult(text, replace) {
  if (!excalidrawAPI || !window.ExcalidrawLib || !interpretSelBox) return;
  const newEls = window.ExcalidrawLib.convertToExcalidrawElements([{
    type: 'text', x: interpretSelBox.x2 + 20, y: interpretSelBox.y1, text, fontSize: 16,
    strokeColor: isDark() ? '#e2e8f0' : '#1e1e1e'
  }]);
  let elements = excalidrawAPI.getSceneElements().slice();
  if (replace) {
    const ids = new Set(interpretSelElements.filter(el => el.type === 'freedraw').map(el => el.id));
    elements = elements.map(el => (ids.has(el.id) ? Object.assign({}, el, { isDeleted: true }) : el));
  }
  elements = elements.concat(newEls);
  excalidrawAPI.updateScene({ elements, commitToHistory: true });
  scheduleAutosave();
}

// §7.2 護欄：單次逾時 90 秒、同一時間只允許一個判讀請求在跑；失敗誠實回報，不假裝辨識成功。
async function runInterpret(mode, promptText) {
  if (interpretInFlight) { wbToast('已有一個判讀在跑，請稍候'); return; }
  if (!currentBoard || !excalidrawAPI || !window.ExcalidrawLib || !interpretSelBox) { wbToast('框選狀態遺失，請重新框選'); return; }
  interpretInFlight = true;
  showInterpretStatusPanel('辨識中…');
  const panelRef = interpretPanelEl; // 綁定這次請求所屬的面板；使用者若在等待期間關掉它、開新框選，結果回來時不可蓋掉新面板
  try {
    const appState = excalidrawAPI.getAppState();
    const files = excalidrawAPI.getFiles();
    const box = interpretSelBox;
    const edge = Math.max(box.x2 - box.x1, box.y2 - box.y1);
    const scale = edge > MAX_SELECTION_EDGE ? (MAX_SELECTION_EDGE / edge) : 1; // 框選邊長 > 4000px 先縮放
    const blob = await window.ExcalidrawLib.exportToBlob({
      elements: interpretSelElements,
      appState, files,
      mimeType: 'image/png',
      exportPadding: 8,
      getDimensions: (w, h) => ({ width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), scale })
    });
    const dataUrl = await blobToDataUrl(blob);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), INTERPRET_TIMEOUT_MS + 5000);
    let resp;
    try {
      resp = await fetch('/api/whiteboards/' + encodeURIComponent(currentBoard.id) + '/interpret', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl, prompt: promptText, mode, model: localStorage.getItem('hana_selected_model') || '' }),
        signal: ctrl.signal
      });
    } finally { clearTimeout(timer); }
    if (panelRef !== interpretPanelEl) return; // 這段等待期間使用者已關掉/換了面板，結果作廢，不覆蓋新畫面
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.error) {
      showInterpretResultPanel(mode, data.error || ('判讀失敗（HTTP ' + resp.status + '）'), true);
    } else {
      showInterpretResultPanel(mode, data.text || '（模型沒有回覆內容）', !data.text);
    }
  } catch (e) {
    if (panelRef !== interpretPanelEl) return;
    const msg = (e && e.name === 'AbortError') ? '判讀逾時（超過 90 秒），請稍後再試' : ('判讀失敗：' + (e.message || e));
    showInterpretResultPanel(mode, msg, true);
  } finally {
    interpretInFlight = false;
  }
}

// e2e/debug hooks only — no production behavior depends on these; safe no-ops when unused.
window.__wbCurrentBoardId = () => (currentBoard ? currentBoard.id : null);
window.__wbGetSceneElements = () => (excalidrawAPI ? excalidrawAPI.getSceneElements() : null);

export function mount(root, ctx) {
  destroyed = false;
  container = root;
  beautifyEngine = createBeautifyEngine({ getApi: () => excalidrawAPI, isEnabled: isBeautifyEnabled, onReplaced: showRevertBadge });
  if (typeof window.showPanel === 'function') window.showPanel('__view_root__');
  root.classList.remove('hidden');
  if (typeof window.highlightMenuBtn === 'function') window.highlightMenuBtn('menu-whiteboard');
  const pathEl = document.getElementById('header-file-path'); if (pathEl) pathEl.innerText = '白板';
  const titleEl = document.getElementById('header-file-title'); if (titleEl) titleEl.innerText = '自由思考的畫布——手繪架構、圈重點、貼截圖';
  const backEl = document.getElementById('btn-back'); if (backEl) backEl.classList.add('hidden');
  const savedEl = document.getElementById('last-saved'); if (savedEl) savedEl.classList.add('hidden');

  container.innerHTML = shellHtml();
  wireEvents();
  if (typeof lucide !== 'undefined') lucide.createIcons();

  themeObserver = new MutationObserver(applyThemeToExcalidraw);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  applyThemeToExcalidraw(); // 掛載當下先同步一次主題圖示，不等下一次 class 變動

  fullscreenChangeHandler = updateFullscreenIcon;
  document.addEventListener('fullscreenchange', fullscreenChangeHandler);

  saveFallbackTimer = setInterval(() => { if (dirty) doSave(); }, AUTOSAVE_FALLBACK_MS);
  pollTimer = setInterval(pollForRemoteChanges, REMOTE_POLL_MS);

  ensureVendorLoaded().then(async () => {
    if (destroyed) return;
    const loadingEl = container.querySelector('#wb-loading');
    if (loadingEl) loadingEl.remove();
    await refreshList();
  }).catch((e) => {
    const loadingEl = container && container.querySelector('#wb-loading');
    if (loadingEl) loadingEl.textContent = '白板引擎載入失敗：' + e.message;
  });
}

// SPEC-view-chat-context.md §3.1/CTX4 — 讓頭像浮動對話知道「我正在看哪一張白板」。payload 帶
// boardId（識別，文字脈絡由後端 provider 現讀 board.json 產生，避免注入過期的前端場景）＋
// §8.3.1 (WB5/WB-20)：thumbnail（畫布縮圖快取，getChatContext() 是同步函式、只能回傳「已備妥」
// 的快取，缺快取就不給這個欄位——index.html 送出訊息時會據此決定要不要自動附圖，降級不卡住）。
export function getChatContext() {
  if (!container) return null;
  if (!currentBoard) return { kind: 'whiteboard', key: 'whiteboard:none', label: '白板（尚未載入）', payload: {} };
  const payload = { boardId: currentBoard.id };
  if (thumbnailDataUrl) payload.thumbnail = thumbnailDataUrl;
  return {
    kind: 'whiteboard',
    key: 'whiteboard:' + currentBoard.id,
    label: '白板：' + (currentBoard.title || currentBoard.id),
    payload
  };
}

export function unmount() {
  destroyed = true;
  teardownInterpretUI();
  if (saveDebounceTimer) { clearTimeout(saveDebounceTimer); saveDebounceTimer = null; }
  if (saveFallbackTimer) { clearInterval(saveFallbackTimer); saveFallbackTimer = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (fullscreenChangeHandler) { document.removeEventListener('fullscreenchange', fullscreenChangeHandler); fullscreenChangeHandler = null; }
  if (document.fullscreenElement && container && document.fullscreenElement === container.querySelector('#wb-right')) { try { document.exitFullscreen(); } catch (e) {} }
  if (dirty) doSave();
  if (themeObserver) { themeObserver.disconnect(); themeObserver = null; }
  if (reactRoot) { try { reactRoot.unmount(); } catch (e) {} reactRoot = null; }
  for (const id of Array.from(badgeState.keys())) clearBadge(id);
  beautifyEngine = null;
  excalidrawAPI = null;
  currentBoard = null;
  thumbnailDataUrl = null;
  if (container) { container.classList.add('hidden'); container.innerHTML = ''; }
  container = null;
}

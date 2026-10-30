// SPEC-ui-designer.md §7 UID1/UID2 — UI 設計系統・L1 元件庫 + L2 設計畫布（Figma 概念的最小版）。
// D1：元件真身是真 HTML+CSS（不是向量圖形），畫布看到的＝原型跑起來的＝可交給工程師的那一份。
// D2：不裝真 Storybook，但資料格式向 args/variant 觀念看齊（params=可調參數，variants=參數組合的預設值）。
// D4：畫布另做（不沿用白板 Excalidraw），但沿用白板慣例：離線、延遲載入、深淺色同步、工作區隔離。
// D12 工作區隔離鐵則：一律用 apiFetch（帶 X-Workspace），不做全域回退——這個工作區沒有資料時，
// 顯示「這個專案還沒有…」提示，不去讀別的工作區或平台預設。

export const meta = { route: '/app/uidesign', title: 'UI 設計系統', icon: 'layout-template', menuGroup: 'uidesign' };

let container = null;
// UID8：全螢幕/預覽相關的模組層級控制代碼（比照 whiteboard.js 的 fullscreenChangeHandler 手法，
// 不放進 state 是因為它們是 DOM/事件監聽器參照，不是可序列化的畫面資料）。
let canvasFullscreenChangeHandler = null;
let previewOverlay = null;
let previewFullscreenHandler = null;
let previewResizeHandler = null;
let previewKeyHandler = null;
// UID17：全螢幕預覽現在也能因 navigate 事件切換畫面，記住「目前預覽的是哪一張」（不是 state.screen
// ——那是編輯器目前開啟的畫面，兩者在導覽後會不同），供呈現模式切換（refreshPreviewOverlay）沿用。
let previewScreenId = null;
let panDocMoveHandler = null;
let panDocUpHandler = null;
// UID3：可點擊原型播放模式，同樣是模組層級控制代碼（非可序列化資料，不放進 state）。
let playOverlay = null;
let playState = null;   // {currentId, screen, historyIds:[], startId}
let playKeyHandler = null;
let playFullscreenHandler = null;
let playResizeHandler = null;
// UID12：簡報模式（情境流程）的模組層級控制代碼，比照上面 UID3 播放模式的手法。
let flowPresentOverlay = null;
let flowPresentKeyHandler = null;
let flowPresentFullscreenHandler = null;
let flowPresentResizeHandler = null;
// UID16 D14：事件橋接（postMessage）的當前收件脈絡——同一時間只有一個播放面開著，
// 每次 fillReadOnlyFrames(...,{interactive:true,...}) 都會覆寫這份 ctx；監聽器本身只在
// mount() 掛一次、unmount() 拆掉（比照本檔其它 module-level handler 的慣例）。
let uidBridgeMessageHandler = null;
let uidBridgeHandlerCtx = null;

const state = {
  mode: 'library', // 'library' | 'canvas'
  components: [],       // index list: {id,name,category,description,updatedAt}
  tokens: {},
  selectedId: null,
  detail: null,          // full component when editing: {id,name,category,description,params,variants,html,css}
  activeVariant: 0,
  dirty: false,
  loading: true,

  // ── UID2 畫布 ──────────────────────────────────────────────────────────
  devices: [],
  screens: [],           // index list: {id,name,device,frame,updatedAt}
  screenId: null,
  screen: null,           // full: {id,name,device,frame,elements:[...]}
  compCache: {},          // componentId -> full component (for canvas rendering)
  selection: [],          // selected element ids
  zoom: 1,
  savePending: false,
  saveTimer: null,
  screensLoading: true,
  refreshing: false,     // UID-31：手動重新整理中（畫面清單／元件庫重抓）

  // ── UID8 編輯操作性 ────────────────────────────────────────────────────
  undoStack: [],          // 每筆＝變更前的 elements 快照（深拷貝），上限 MAX_HISTORY
  redoStack: [],
  _spaceDown: false,      // 空白鍵是否按住（臨時平移）
  _keyBound: false,

  // UID8 修正：常駐工具模式（比照白板的箭頭/手掌）。'select'＝拖曳元件與框選；'pan'＝拖曳整
  // 個畫布。空白鍵按住仍可在 select 模式下臨時平移，兩者共用 isPanMode()。
  tool: 'select',         // 'select' | 'pan'
  // 進入全螢幕前的視圖，離開時原樣還原（否則全螢幕的 fit 縮放會殘留在小視窗裡）
  _preFsView: null,       // {zoom, left, top}

  // UID8 修正：全螢幕編輯改為「狀態 + CSS 覆蓋層」，不再把 Fullscreen API 目標指向會被
  // render() 重建的 #uid-canvas-shell（那會在拖曳元件時因為節點被換掉而自動退出全螢幕）。
  canvasFullscreen: false,
  // UID8 修正：畫布主題獨立於平台主題（平台 header 本來就有深淺色切換），這顆鈕只切「畫布/
  // 元件預覽」的深淺色，讓設計者能檢查同一份設計在兩種主題下的樣子。null＝跟隨平台。
  canvasTheme: null,      // null | 'light' | 'dark'

  // ── UID-09b 自訂尺寸 ───────────────────────────────────────────────────
  // newDevice：新畫面要用的裝置 id；'__custom__' 代表正在輸入自訂寬高。自訂尺寸會存進工作區
  // （POST /api/ui/devices），之後就跟出廠預設一樣出現在下拉選單裡，可重複選用。
  newDevice: '',
  customW: '',
  customH: '',
  customLabel: '',

  // ── UID9 以螢幕尺寸設計（dp/pt，D13）────────────────────────────────────
  // newScreenMode：新畫面用「解析度模式」(px，現況/預設) 還是「尺寸模式」(dp，挑機型或自填
  // 對角吋數＋實體解析度)。models：本工作區的機型清單（GET /api/ui/models，首次呼叫自動種子）。
  // presentMode：預覽/原型呈現用「dp（設計視角）」還是「device（裝置視角，整體乘上 scale）」。
  newScreenMode: 'px',    // 'px' | 'dp'
  models: [],
  newModel: '',           // 尺寸模式挑的機型 id；'__custom__' 代表自填吋數＋解析度
  customDiagonal: '',
  customNativeW: '',
  customNativeH: '',
  presentMode: 'dp',      // 'dp' | 'device'（僅 unit==='dp' 的畫面有作用）

  // ── UID10 語意標記（來源標記，SPEC-ui-designer.md §7.3.1）───────────────
  // newPurpose：新畫面對話框選的畫面用途，選填，預設空字串＝未標記。
  // markMode：畫布是否切到「標記檢視」，開啟時未標記的元件會被標出、工具列顯示覆蓋率。
  newPurpose: '',
  markMode: false,

  // ── UID5 範本庫 ────────────────────────────────────────────────────────
  templates: [],          // index list: {id,name,deviceGroup,device,tags,source,updatedAt,thumbnail}
  templatesLoading: true,
  templateFilterDevice: 'all', // 'all' | 'desktop' | 'tablet' | 'phone' | 'pda'

  // ── UID11 依範本重套（Restyle，SPEC-ui-designer.md §7.3.2）──────────────
  // restylePicker：挑畫面＋模式的畫框；非 null 時 render() 會疊一層遮罩。
  //   {templateId, templateName, selected:Set<screenId>, mode:'single'|'batch'}
  // restyleWalk：逐張確認模式的走訪狀態；每次移動到下一張都重新呼叫 preview API（dry-run）。
  //   {templateId, templateName, screenIds:[...], idx, preview:null|{...}, busy:false, done:[]}
  restylePicker: null,
  restyleWalk: null,
  // revisionsPanel：畫面版本記錄疊層（重套/退回都會留一筆），{screenId, list, loading}
  revisionsPanel: null,
  // deleteScreenConfirm：UID-55 刪畫面二次確認疊層，{screenId, screenName, usage:[{flowId,flowName,stepIndex}]}
  deleteScreenConfirm: null,

  // ── UID12 情境流程（Scenario Flows，SPEC-ui-designer.md §7.4）──────────
  flows: [],              // index list: {id,name,description,device,stepCount,updatedAt}
  flowsLoading: true,
  flowId: null,
  flow: null,              // full: {id,name,description,device,steps:[{screenId,caption,hotspot,note,_invalid,_screenName}],...}
  flowSavePending: false,
  flowSaveTimer: null,
  stepAddScreenId: '',     // 加步驟：目前挑的畫面 id（縮圖選單）
  stepAddCaption: '',      // 加步驟：操作說明草稿
  flowDragIdx: null,       // 拖曳排序中的步驟來源 index
  hotspotStepIdx: null,    // 正在畫熱點框的步驟 index（null=沒有展開）
  hotspotScreenCache: {},  // screenId -> 完整畫面資料（熱點編輯器要畫框才抓）
  // flowPlay：重播/簡報共用的播放核心狀態，兩者只差外框（見 renderFlowReplayPanel/enterFlowPresent）
  flowPlay: null           // {idx, screens:{screenId:fullScreen}, loading}
};

// 畫布（含全螢幕唯讀預覽）目前該用深色還是淺色渲染。
function canvasIsDark() {
  if (state.canvasTheme === 'dark') return true;
  if (state.canvasTheme === 'light') return false;
  return document.documentElement.classList.contains('dark');
}

function esc(str) { return window.escapeHtml ? window.escapeHtml(String(str == null ? '' : str)) : String(str == null ? '' : str); }
function api(path, opts) { return (window.apiFetch || fetch)(path, opts); }
function uid() { return 'el_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function groupByCategory(list) {
  const groups = {};
  list.forEach(c => {
    const cat = c.category || '未分類';
    (groups[cat] = groups[cat] || []).push(c);
  });
  return groups;
}

// ════════════════════════════════════════════════════════════════════════
// L1 元件庫（既有，不變）
// ════════════════════════════════════════════════════════════════════════

async function loadAll() {
  state.loading = true;
  render();
  try {
    const [compRes, tokRes] = await Promise.all([api('/api/ui/components'), api('/api/ui/tokens')]);
    state.components = await compRes.json();
    state.tokens = await tokRes.json();
  } catch (e) {
    state.components = [];
    state.tokens = {};
  }
  state.loading = false;
  render();
}

async function selectComponent(id) {
  state.selectedId = id;
  state.activeVariant = 0;
  state.detail = null;
  render();
  try {
    const r = await api('/api/ui/components/' + encodeURIComponent(id));
    if (r.ok) state.detail = await r.json();
  } catch (e) {}
  render();
}

function blankComponent() {
  return {
    id: null,
    name: '新元件',
    category: '未分類',
    description: '',
    params: [{ key: 'label', label: '文字', default: '按鈕' }],
    variants: [
      { name: 'Primary', values: { label: '主要按鈕' } },
      { name: 'Secondary', values: { label: '次要按鈕' } },
      { name: 'Danger', values: { label: '刪除' } }
    ],
    html: '<button class="btn btn-{{variant}}">{{label}}</button>',
    css: '.btn { padding: 8px 16px; border-radius: var(--ui-radius-md, 8px); border: none; font-size: var(--ui-font-md, 14px); cursor: pointer; }\n.btn-primary { background: var(--ui-color-primary, #0891b2); color: #fff; }\n.btn-secondary { background: transparent; color: var(--ui-color-primary, #0891b2); border: 1px solid var(--ui-color-primary, #0891b2); }\n.btn-danger { background: var(--ui-color-danger, #dc2626); color: #fff; }'
  };
}

function newComponent() {
  state.selectedId = null;
  state.detail = blankComponent();
  state.activeVariant = 0;
  render();
}

function substitute(tpl, values) {
  return String(tpl || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, key) => (key in values) ? esc(values[key]) : m);
}

function tokenCssVars(tokens) {
  const lines = [];
  const walk = (obj, prefix) => {
    if (!obj || typeof obj !== 'object') return;
    Object.keys(obj).forEach(k => {
      const v = obj[k];
      if (v && typeof v === 'object') walk(v, prefix + '-' + k);
      else lines.push('--ui-' + prefix + '-' + k + ': ' + v + ';');
    });
  };
  Object.keys(tokens || {}).forEach(cat => walk(tokens[cat], cat));
  return ':root {\n' + lines.join('\n') + '\n}';
}

// UID16 D14：可選事件橋接——注入極小 inline script，把 iframe 內的 click/change/input
// 轉成 postMessage 回報父頁（含元件實例 id、目標標籤/名稱/值、以及點擊在「這顆 iframe 自己
// 座標系」裡的 clientX/clientY，父頁再用 el.x/el.y/presentScale 換算回畫框原生座標）。
// sandbox 維持 allow-scripts、不加 allow-same-origin（維持隔離）、不加 allow-forms（避免表單
// 真的送出造成 iframe 內導航）——所以這支腳本是唯一能把互動「說出來」的管道。
function buildUidBridgeScript(elId) {
  return '<script>(function(){'
    + 'var elId=' + JSON.stringify(String(elId)) + ';'
    + 'function report(type,ev){'
    + '  var t=ev.target; if(!t||!t.tagName) return;'
    + '  var val;'
    + '  if (t.type==="checkbox"||t.type==="radio") val=t.checked;'
    + '  else if ("value" in t) val=t.value;'
    + '  try{ window.parent.postMessage({uidBridge:true,elId:elId,type:type,x:(ev.clientX||0),y:(ev.clientY||0),tag:t.tagName,name:t.name||"",value:val}, "*"); }catch(e){}'
    + '}'
    + 'document.addEventListener("click",function(ev){report("click",ev);},true);'
    + 'document.addEventListener("change",function(ev){report("change",ev);},true);'
    + 'document.addEventListener("input",function(ev){report("input",ev);},true);'
    + '})();</script>';
}

// 共用：把一顆元件（含 html/css/params）用一組實際值渲染成一份可丟進 iframe 的 srcdoc。
// values 已經是「defaults <- variant.values <- overrides」疊完的最終值。bridgeElId 給了值
// 才注入 UID_BRIDGE（唯讀播放路徑用）；組件編輯器的預覽面板與畫布不傳，維持原行為。
function buildRenderSrcdoc(component, values, extraBodyStyle, darkOverride, bridgeElId) {
  const html = substitute(component.html, values);
  const isDark = darkOverride == null ? document.documentElement.classList.contains('dark') : !!darkOverride;
  return '<!doctype html><html class="' + (isDark ? 'dark' : '') + '"><head><meta charset="utf-8">'
    + '<style>' + tokenCssVars(state.tokens) + '</style>'
    + '<style>html,body{margin:0;padding:0;font-family:system-ui,-apple-system,"Noto Sans TC",sans-serif;background:transparent;color:var(--ui-color-text,#1e293b);}'
    + 'html.dark,body.dark{color:#e2e8f0;}'
    + 'body{' + (extraBodyStyle || '') + '}</style>'
    + '<style>' + (component.css || '') + '</style>'
    + '</head><body class="' + (isDark ? 'dark' : '') + '">' + html
    + (bridgeElId ? buildUidBridgeScript(bridgeElId) : '')
    + '</body></html>';
}

function buildPreviewSrcdoc(component, variantIndex) {
  const variant = (component.variants || [])[variantIndex] || { name: '', values: {} };
  const defaults = {};
  (component.params || []).forEach(p => { defaults[p.key] = p.default; });
  const values = Object.assign({ variant: (variant.name || '').toLowerCase() }, defaults, variant.values || {});
  return buildRenderSrcdoc(component, values, 'padding:16px;background:var(--ui-color-bg,#fff);').replace(
    '<style>html,body{margin:0;', '<style>html,body{margin:0;'
  );
}

function renderPreview() {
  const frame = container.querySelector('#uid-preview-frame');
  if (!frame || !state.detail) return;
  frame.srcdoc = buildPreviewSrcdoc(state.detail, state.activeVariant);
}

function renderEditor() {
  const d = state.detail;
  if (!d) {
    return '<div class="flex-1 flex items-center justify-center text-sm text-slate-400">從左側選一個元件，或點「+ 新建元件」</div>';
  }
  const variantsHtml = (d.variants || []).map((v, i) =>
    '<button data-variant="' + i + '" class="px-2.5 py-1 rounded-md text-xs font-medium transition-all ' +
    (i === state.activeVariant ? 'bg-cyan-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300') +
    '">' + esc(v.name || ('變體 ' + (i + 1))) + '</button>'
  ).join('');

  return ''
    + '<div class="flex-1 flex flex-col overflow-hidden">'
    + '  <div class="p-4 border-b border-slate-200 dark:border-slate-700/60 space-y-3">'
    + '    <div class="flex items-center gap-2">'
    + '      <input id="uid-f-name" value="' + esc(d.name) + '" placeholder="元件名稱" class="flex-1 px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm font-semibold">'
    + '      <input id="uid-f-category" value="' + esc(d.category) + '" placeholder="分類" class="w-32 px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm">'
    + '      <button id="uid-save" class="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-xs font-semibold">儲存</button>'
    + (d.id ? '      <button id="uid-delete" class="px-3 py-1.5 rounded-lg bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-300 text-xs font-semibold">刪除</button>' : '')
    + '    </div>'
    + '    <input id="uid-f-desc" value="' + esc(d.description) + '" placeholder="說明（選填）" class="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs">'
    + '  </div>'
    + '  <div class="flex-1 grid grid-cols-2 gap-0 overflow-hidden">'
    + '    <div class="overflow-y-auto p-4 space-y-3 border-r border-slate-200 dark:border-slate-700/60">'
    + '      <div><label class="text-xs font-semibold text-slate-500 block mb-1">HTML（可用 {{paramKey}} 帶入參數）</label>'
    + '        <textarea id="uid-f-html" class="w-full h-28 font-mono text-xs px-2 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900">' + esc(d.html) + '</textarea></div>'
    + '      <div><label class="text-xs font-semibold text-slate-500 block mb-1">CSS</label>'
    + '        <textarea id="uid-f-css" class="w-full h-28 font-mono text-xs px-2 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900">' + esc(d.css) + '</textarea></div>'
    + '      <div><label class="text-xs font-semibold text-slate-500 block mb-1">參數定義（JSON 陣列：[{"key","label","default"}]）</label>'
    + '        <textarea id="uid-f-params" class="w-full h-20 font-mono text-xs px-2 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900">' + esc(JSON.stringify(d.params || [], null, 2)) + '</textarea></div>'
    + '      <div><label class="text-xs font-semibold text-slate-500 block mb-1">變體（JSON 陣列：[{"name","values":{...}}]）</label>'
    + '        <textarea id="uid-f-variants" class="w-full h-24 font-mono text-xs px-2 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900">' + esc(JSON.stringify(d.variants || [], null, 2)) + '</textarea></div>'
    + '    </div>'
    + '    <div class="flex flex-col overflow-hidden">'
    + '      <div class="flex items-center gap-1.5 p-3 flex-wrap border-b border-slate-200 dark:border-slate-700/60">' + variantsHtml + '</div>'
    + '      <div class="flex-1 bg-slate-100 dark:bg-slate-950/40 p-3 overflow-auto">'
    + '        <iframe id="uid-preview-frame" sandbox="allow-scripts" class="w-full h-full rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700"></iframe>'
    + '      </div>'
    + '    </div>'
    + '  </div>'
    + '</div>';
}

function renderList() {
  if (state.loading) return '<div class="p-4 text-sm text-slate-400">載入中…</div>';
  if (!state.components.length) {
    return '<div class="p-4 text-sm text-slate-400 leading-relaxed">這個工作區還沒有元件庫。<br>點「+ 新建元件」開始建立，或之後可從別的工作區匯入（尚未實作）。</div>';
  }
  const groups = groupByCategory(state.components);
  return Object.keys(groups).sort().map(cat =>
    '<div class="mb-2">'
    + '<div class="px-3 py-1 text-[11px] font-bold text-slate-400 uppercase tracking-wide">' + esc(cat) + '</div>'
    + groups[cat].map(c =>
      '<button data-id="' + c.id + '" class="w-full text-left px-3 py-2 rounded-lg text-sm ' +
      (c.id === state.selectedId ? 'bg-cyan-50 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-300 font-semibold' : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800') +
      '">' + esc(c.name) + '</button>'
    ).join('')
    + '</div>'
  ).join('');
}

function renderLibraryTab() {
  return ''
    + '<aside class="w-56 flex-shrink-0 border-r border-slate-200 dark:border-slate-700/60 bg-white/70 dark:bg-slate-900/50 flex flex-col">'
    + '  <div class="p-3 border-b border-slate-200 dark:border-slate-700/60">'
    + '    <button id="uid-new" class="w-full px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-xs font-semibold">+ 新建元件</button>'
    + '  </div>'
    + '  <div class="flex-1 overflow-y-auto py-1">' + renderList() + '</div>'
    + '</aside>'
    + renderEditor();
}

function collectFormIntoDetail() {
  const d = state.detail;
  d.name = container.querySelector('#uid-f-name').value.trim() || '未命名元件';
  d.category = container.querySelector('#uid-f-category').value.trim() || '未分類';
  d.description = container.querySelector('#uid-f-desc').value;
  d.html = container.querySelector('#uid-f-html').value;
  d.css = container.querySelector('#uid-f-css').value;
  try { d.params = JSON.parse(container.querySelector('#uid-f-params').value || '[]'); } catch (e) { alert('參數定義不是合法 JSON：' + e.message); throw e; }
  try { d.variants = JSON.parse(container.querySelector('#uid-f-variants').value || '[]'); } catch (e) { alert('變體不是合法 JSON：' + e.message); throw e; }
  return d;
}

async function saveComponent() {
  let d;
  try { d = collectFormIntoDetail(); } catch (e) { return; }
  try {
    if (d.id) {
      const r = await api('/api/ui/components/' + encodeURIComponent(d.id), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: d.name, category: d.category, description: d.description, html: d.html, css: d.css, params: d.params, variants: d.variants })
      });
      state.detail = await r.json();
    } else {
      const r = await api('/api/ui/components', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(d)
      });
      state.detail = await r.json();
      state.selectedId = state.detail.id;
    }
    const r2 = await api('/api/ui/components');
    state.components = await r2.json();
    state.compCache[state.detail.id] = state.detail; // 畫布快取同步更新
  } catch (e) { alert('儲存失敗：' + e.message); }
  render();
}

async function deleteComponent() {
  if (!state.detail || !state.detail.id) return;
  if (!confirm('永久刪除元件「' + state.detail.name + '」？此動作無法復原。')) return;
  try { await api('/api/ui/components/' + encodeURIComponent(state.detail.id), { method: 'DELETE' }); } catch (e) {}
  state.selectedId = null;
  state.detail = null;
  const r = await api('/api/ui/components');
  state.components = await r.json();
  render();
}

// ════════════════════════════════════════════════════════════════════════
// L2 設計畫布（UID2）
// ════════════════════════════════════════════════════════════════════════

const GRID = 8;
const SNAP_THRESHOLD = 6;
const MAX_HISTORY = 50;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;

// ── UID8：復原／重做 ────────────────────────────────────────────────────
// 新增／刪除／移動／縮放／改參數／圖層調序皆入棧；連續拖曳只在「拖曳開始」拍一次快照、
// 「放開且真的動了」才推入 undoStack（beginUndoSnapshot/commitUndoSnapshot 這組），避免一像
// 素一筆。離散動作（新增元件、刪除、換變體、圖層調序、單次數值輸入）直接呼叫 pushUndo()。
function cloneElements(els) { return JSON.parse(JSON.stringify(els || [])); }

function beginUndoSnapshot() { return state.screen ? cloneElements(state.screen.elements) : null; }

function commitUndoSnapshot(snapshot) {
  if (!snapshot) return;
  state.undoStack.push(snapshot);
  if (state.undoStack.length > MAX_HISTORY) state.undoStack.shift();
  state.redoStack = [];
}

function pushUndo() {
  if (!state.screen) return;
  commitUndoSnapshot(beginUndoSnapshot());
}

function resetHistory() {
  state.undoStack = [];
  state.redoStack = [];
}

function undo() {
  if (!state.screen || !state.undoStack.length) return;
  state.redoStack.push(cloneElements(state.screen.elements));
  if (state.redoStack.length > MAX_HISTORY) state.redoStack.shift();
  state.screen.elements = state.undoStack.pop();
  state.selection = state.selection.filter(id => state.screen.elements.some(e => e.id === id));
  scheduleSave();
  render();
}

function redo() {
  if (!state.screen || !state.redoStack.length) return;
  state.undoStack.push(cloneElements(state.screen.elements));
  if (state.undoStack.length > MAX_HISTORY) state.undoStack.shift();
  state.screen.elements = state.redoStack.pop();
  state.selection = state.selection.filter(id => state.screen.elements.some(e => e.id === id));
  scheduleSave();
  render();
}

async function loadDevices() {
  try { const r = await api('/api/ui/devices'); state.devices = await r.json(); } catch (e) { state.devices = []; }
  // 選單預設值失效時（首次載入、或剛刪掉正選著的自訂尺寸）回到第一個裝置
  if (state.newDevice !== '__custom__' && !state.devices.some(d => d.id === state.newDevice)) {
    state.newDevice = (state.devices[0] && state.devices[0].id) || '';
  }
}

// UID9：尺寸模式的機型清單（本工作區種子＋自訂），比照 loadDevices。
async function loadModels() {
  try { const r = await api('/api/ui/models'); state.models = await r.json(); } catch (e) { state.models = []; }
  if (state.newModel !== '__custom__' && !state.models.some(m => m.id === state.newModel)) {
    state.newModel = (state.models[0] && state.models[0].id) || '';
  }
}

async function loadScreens() {
  state.screensLoading = true;
  render();
  try { const r = await api('/api/ui/screens'); state.screens = await r.json(); }
  catch (e) { state.screens = []; }
  state.screensLoading = false;
  render();
}

async function ensureComponentCached(id) {
  if (state.compCache[id]) return state.compCache[id];
  try {
    const r = await api('/api/ui/components/' + encodeURIComponent(id));
    if (r.ok) { const c = await r.json(); state.compCache[id] = c; return c; }
  } catch (e) {}
  return null;
}

async function selectScreen(id) {
  state.screenId = id;
  state.screen = null;
  state.selection = [];
  resetHistory(); // 復原/重做不跨畫面，換畫面就是一段新的編輯歷史
  render();
  try {
    const r = await api('/api/ui/screens/' + encodeURIComponent(id));
    if (r.ok) state.screen = await r.json();
  } catch (e) {}
  if (state.screen) {
    const ids = Array.from(new Set((state.screen.elements || []).map(el => el.componentId)));
    await Promise.all(ids.map(ensureComponentCached));
  }
  render();
  // §7.1：切換畫面時預設自動套用一次「符合視窗」，大畫框（如 1920×1080）在小視窗中不至於
  // 一開就被裁掉一半。用 rAF 等這次 render() 的 DOM 落地後再量測可視區大小。
  if (state.screen) requestAnimationFrame(fitToWindow);
}

// UID-09b：選了「＋ 自訂尺寸…」時，先把寬高存成本工作區的自訂裝置，再用它開新畫面——
// 這樣同一個尺寸下次直接從選單選，不必重打。
async function saveCustomDevice() {
  const w = parseInt(state.customW, 10), h = parseInt(state.customH, 10);
  if (!(w > 0) || !(h > 0)) { alert('請先輸入有效的寬與高（像素）'); return null; }
  try {
    const r = await api('/api/ui/devices', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: state.customLabel, width: w, height: h })
    });
    if (!r.ok) throw new Error((await r.json()).error || '儲存失敗');
    const device = await r.json();
    await loadDevices();
    state.newDevice = device.id;
    state.customW = ''; state.customH = ''; state.customLabel = '';
    return device.id;
  } catch (e) { alert('儲存自訂尺寸失敗：' + e.message); return null; }
}

async function deleteCustomDevice(id) {
  try { await api('/api/ui/devices/' + encodeURIComponent(id), { method: 'DELETE' }); } catch (e) {}
  await loadDevices();
  state.newDevice = (state.devices[0] && state.devices[0].id) || '';
  render();
}

// UID9：尺寸模式下組出 {unit:'dp', modelId} 或 {unit:'dp', diagonalInch, nativeWidth,
// nativeHeight}；解析度模式維持原本 {device} 行為不變（向後相容）。
function buildNewScreenBody(deviceId) {
  // UID10：手拉建畫面一律標 origin:'manual'；purpose 選填（state.newPurpose 空字串就不帶，
  // 後端視為未標記），不強制填寫，維持「不新增額外提問負擔」。
  const purposePatch = state.newPurpose ? { purpose: state.newPurpose, origin: 'manual' } : { origin: 'manual' };
  if (state.newScreenMode === 'dp') {
    if (state.newModel === '__custom__') {
      const di = parseFloat(state.customDiagonal);
      const w = parseInt(state.customNativeW, 10), h = parseInt(state.customNativeH, 10);
      if (!(di > 0) || !(w > 0) || !(h > 0)) { alert('請輸入有效的對角吋數與實體解析度'); return null; }
      return Object.assign({ name: '新畫面', unit: 'dp', diagonalInch: di, nativeWidth: w, nativeHeight: h }, purposePatch);
    }
    const modelId = state.newModel || (state.models[0] && state.models[0].id);
    if (!modelId) { alert('請先選一個機型，或改用「自填吋數」'); return null; }
    return Object.assign({ name: '新畫面', unit: 'dp', modelId }, purposePatch);
  }
  const device = deviceId || (state.devices[0] && state.devices[0].id) || 'desktop-1440';
  return Object.assign({ name: '新畫面', device }, purposePatch);
}

async function newScreen(deviceId) {
  if (state.newScreenMode !== 'dp' && deviceId === '__custom__') {
    const savedId = await saveCustomDevice();
    if (!savedId) { render(); return; }
    deviceId = savedId;
  }
  const body = buildNewScreenBody(deviceId);
  if (!body) { render(); return; }
  try {
    const r = await api('/api/ui/screens', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error((await r.json()).error || '新建失敗');
    const screen = await r.json();
    const r2 = await api('/api/ui/screens');
    state.screens = await r2.json();
    await selectScreen(screen.id);
  } catch (e) { alert('新建畫面失敗：' + e.message); render(); }
}

async function duplicateCurrentScreen() {
  if (!state.screen) return;
  try {
    const r = await api('/api/ui/screens/' + encodeURIComponent(state.screen.id) + '/duplicate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const copy = await r.json();
    const r2 = await api('/api/ui/screens');
    state.screens = await r2.json();
    await selectScreen(copy.id);
  } catch (e) { alert('複製畫面失敗：' + e.message); }
}

// UID-55（SPEC-ui-designer.md §7.4.1）：刪畫面前先擋一次。伺服器端判定這張畫面是否被任何情境
// 流程引用（GET /api/ui/screens/:id/usage，一律由伺服器判定，前端不自行推測）；未被引用維持原本
// 的單次 confirm()、不增加摩擦；被引用則跳出列出流程名／第幾步的自訂對話框，要求二次確認（預設
// 焦點在「取消」，見 bindFlowsTabEvents 呼叫端的 focus() 與 renderDeleteScreenConfirmModal）。
async function requestDeleteCurrentScreen() {
  if (!state.screen) return;
  const screenId = state.screen.id, screenName = state.screen.name;
  let usage = [];
  try {
    const r = await api('/api/ui/screens/' + encodeURIComponent(screenId) + '/usage');
    if (r.ok) usage = await r.json();
  } catch (e) { usage = []; }
  if (!usage.length) {
    if (!confirm('永久刪除畫面「' + screenName + '」？此動作無法復原。')) return;
    await performDeleteScreen(screenId);
    return;
  }
  state.deleteScreenConfirm = { screenId, screenName, usage };
  render();
}

async function performDeleteScreen(screenId) {
  try { await api('/api/ui/screens/' + encodeURIComponent(screenId), { method: 'DELETE' }); } catch (e) {}
  if (state.screenId === screenId) { state.screenId = null; state.screen = null; state.selection = []; }
  const r = await api('/api/ui/screens');
  state.screens = await r.json();
  state.deleteScreenConfirm = null;
  render();
}

function cancelDeleteScreenConfirm() { state.deleteScreenConfirm = null; render(); }

function renderDeleteScreenConfirmModal() {
  const c = state.deleteScreenConfirm;
  if (!c) return '';
  const items = c.usage.map(u => '<li>「' + esc(u.flowName) + '」第 ' + u.stepIndex + ' 步</li>').join('');
  return '<div class="fixed inset-0 z-[998] bg-black/40 flex items-center justify-center p-4">'
    + '  <div class="bg-white dark:bg-slate-900 rounded-xl shadow-xl max-w-md w-full p-4 space-y-3">'
    + '    <div class="text-sm font-semibold text-red-600 dark:text-red-400">這張畫面被 UI操作演示 引用</div>'
    + '    <div class="text-xs text-slate-600 dark:text-slate-300">畫面「' + esc(c.screenName) + '」被以下流程使用：</div>'
    + '    <ul class="text-xs list-disc list-inside text-slate-600 dark:text-slate-300 space-y-0.5 max-h-32 overflow-y-auto">' + items + '</ul>'
    + '    <div class="text-[11px] text-slate-400">刪除仍可執行，但那些步驟會變成「畫面已刪除」的失效提示，不會壞掉整條流程。確定要刪除嗎？</div>'
    + '    <div class="flex items-center justify-end gap-2 pt-1">'
    + '      <button id="uid-delscreen-cancel" class="px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-semibold">取消</button>'
    + '      <button id="uid-delscreen-confirm" class="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-semibold">仍要刪除</button>'
    + '    </div>'
    + '  </div>'
    + '</div>';
}

// ════════════════════════════════════════════════════════════════════════
// L5 範本庫（UID5，SPEC-ui-designer.md §6.2）
// D9：範本只存結構與元件引用，不存死內容——「另存為範本」時把每個元件實例的 overrides
// （指揮官在這個畫面上實際填過的文字/數值）換成依元件參數 label 生成的佔位文字；沒有覆寫、
// 只用元件本身預設值的欄位維持原樣（那是元件自己的樣子，不是「這個畫面獨有」的死內容）。
// ════════════════════════════════════════════════════════════════════════

function genericizeOverrides(el, component) {
  const overrides = el.overrides || {};
  if (!Object.keys(overrides).length) return {};
  const params = component ? (component.params || []) : [];
  const out = {};
  Object.keys(overrides).forEach(key => {
    const value = overrides[key];
    const param = params.find(p => p.key === key);
    if (typeof value === 'number') {
      // 數字（如清單筆數）視為結構參數，佔位方式＝退回元件自身預設值，不留這個畫面的實際數字。
      out[key] = param && typeof param.default === 'number' ? param.default : 0;
    } else if (typeof value === 'string' && value) {
      out[key] = '〔' + (param ? param.label : key) + '〕';
    }
    // 其他型別（如 boolean）或空字串：略過＝退回元件的 variant/預設值，本來就不是死內容。
  });
  return out;
}

async function loadTemplates() {
  state.templatesLoading = true;
  render();
  try {
    const q = state.templateFilterDevice && state.templateFilterDevice !== 'all' ? ('?device=' + encodeURIComponent(state.templateFilterDevice)) : '';
    const r = await api('/api/ui/templates' + q);
    state.templates = await r.json();
  } catch (e) { state.templates = []; }
  state.templatesLoading = false;
  render();
}

// UID-17：把目前開著的畫面另存為範本。componentId 相同的元件才有 params 可查 label，
// 所以先確保 compCache 已把畫面用到的元件都抓齊（selectScreen 進來時已做過，這裡再保險一次）。
async function saveScreenAsTemplate() {
  if (!state.screen) return;
  const name = prompt('範本名稱：', state.screen.name + '範本');
  if (name == null) return;
  const ids = Array.from(new Set((state.screen.elements || []).map(el => el.componentId)));
  await Promise.all(ids.map(ensureComponentCached));
  const elements = (state.screen.elements || []).map(el => Object.assign({}, el, {
    overrides: genericizeOverrides(el, state.compCache[el.componentId])
  }));
  try {
    const r = await api('/api/ui/templates', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim() || (state.screen.name + '範本'),
        device: state.screen.device,
        frame: state.screen.frame,
        elements,
        sourceScreenId: state.screen.id
      })
    });
    if (!r.ok) throw new Error((await r.json()).error || '儲存失敗');
    alert('已另存為範本，可在「範本庫」分頁找到。');
    state.templates = []; state.templatesLoading = true; // 下次切到範本庫分頁時重新載入
  } catch (e) { alert('另存為範本失敗：' + e.message); }
}

// UID-18：套用範本＝新建一張畫面，直接切過去繼續編輯（跟「+ 新畫面」的收尾動作一致）。
async function applyTemplate(id) {
  try {
    const r = await api('/api/ui/templates/' + encodeURIComponent(id) + '/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.ok) throw new Error((await r.json()).error || '套用失敗');
    const screen = await r.json();
    const r2 = await api('/api/ui/screens');
    state.screens = await r2.json();
    state.mode = 'canvas';
    await selectScreen(screen.id);
  } catch (e) { alert('套用範本失敗：' + e.message); render(); }
}

async function deleteTemplateItem(id, name) {
  if (!confirm('刪除範本「' + name + '」？此動作無法復原（已套用過的畫面不受影響）。')) return;
  try { await api('/api/ui/templates/' + encodeURIComponent(id), { method: 'DELETE' }); } catch (e) {}
  await loadTemplates();
}

// ════════════════════════════════════════════════════════════════════════
// UID11 依範本重套（Restyle，SPEC-ui-designer.md §7.3.2）
// 兩種模式：逐張確認（預設，改一張看一張、可略過）／整批套用（全部畫面一次換新風格）。
// 一律先存版本快照才落地（後端 saveScreenRevision），UI 只負責挑畫面、跑 preview/apply、
// 誠實列出「未能自動重套」清單（UID-44），不自行揣測對位結果。
// ════════════════════════════════════════════════════════════════════════

function openRestylePicker(templateId, templateName) {
  if (!state.screens.length) { loadScreens().then(render); }
  state.restylePicker = { templateId, templateName, selected: new Set(), mode: 'single' };
  render();
}

function closeRestylePicker() { state.restylePicker = null; render(); }

function renderRestylePicker() {
  const p = state.restylePicker;
  if (!p) return '';
  const rows = state.screens.length
    ? state.screens.map(s => ''
      + '<label class="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer">'
      + '<input type="checkbox" data-restyle-screen="' + s.id + '"' + (p.selected.has(s.id) ? ' checked' : '') + '>'
      + '<span class="flex-1 text-xs text-slate-700 dark:text-slate-200 truncate">' + esc(s.name) + '</span>'
      + '<span class="text-[10px] text-slate-400">' + esc(deviceLabel(s.device)) + '</span>'
      + '</label>'
    ).join('')
    : '<div class="p-3 text-xs text-slate-400">這個工作區還沒有畫面可套用。</div>';
  return ''
    + '<div class="absolute inset-0 z-40 bg-black/30 flex items-center justify-center" id="uid-restyle-picker-backdrop">'
    + '  <div class="w-[420px] max-h-[80%] flex flex-col rounded-xl shadow-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 overflow-hidden">'
    + '    <div class="px-4 py-3 border-b border-slate-200 dark:border-slate-700/60">'
    + '      <div class="text-sm font-semibold text-slate-800 dark:text-slate-100">依範本重套：' + esc(p.templateName) + '</div>'
    + '      <div class="text-[11px] text-slate-400 mt-0.5">挑要重套的畫面（保留內容、可退回）</div>'
    + '    </div>'
    + '    <div class="flex-1 overflow-y-auto px-2 py-1.5">' + rows + '</div>'
    + '    <div class="px-4 py-2.5 border-t border-slate-200 dark:border-slate-700/60 flex items-center gap-2">'
    + '      <div class="flex items-center rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5 text-[11px] font-medium">'
    + '        <button data-restyle-mode="single" class="px-2 py-1 rounded-md ' + (p.mode === 'single' ? 'bg-white dark:bg-slate-700 shadow-sm text-cyan-600 dark:text-cyan-300' : 'text-slate-500 dark:text-slate-400') + '">逐張確認</button>'
    + '        <button data-restyle-mode="batch" class="px-2 py-1 rounded-md ' + (p.mode === 'batch' ? 'bg-white dark:bg-slate-700 shadow-sm text-cyan-600 dark:text-cyan-300' : 'text-slate-500 dark:text-slate-400') + '">整批套用</button>'
    + '      </div>'
    + '      <div class="flex-1"></div>'
    + '      <button id="uid-restyle-cancel" class="px-2.5 py-1 rounded-lg text-xs text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">取消</button>'
    + '      <button id="uid-restyle-start" class="px-3 py-1 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-xs font-semibold' + (p.selected.size ? '' : ' opacity-50 pointer-events-none') + '">開始（' + p.selected.size + '）</button>'
    + '    </div>'
    + '  </div>'
    + '</div>';
}

async function startRestyle() {
  const p = state.restylePicker;
  if (!p || !p.selected.size) return;
  const screenIds = Array.from(p.selected);
  if (p.mode === 'batch') {
    if (!confirm('整批套用會直接改寫 ' + screenIds.length + ' 張畫面（各自留一份可退回的版本），確定要繼續嗎？')) return;
    state.restylePicker = null;
    render();
    try {
      const r = await api('/api/ui/screens/restyle/batch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ screenIds, templateId: p.templateId })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || '整批套用失敗');
      reportRestyleBatchResult(data);
      await loadScreens();
      if (state.screenId && screenIds.indexOf(state.screenId) !== -1) await selectScreen(state.screenId);
    } catch (e) { alert('整批套用失敗：' + e.message); }
    render();
    return;
  }
  // 逐張確認：初始化走訪狀態，載入第一張的試算結果。
  state.restylePicker = null;
  state.restyleWalk = { templateId: p.templateId, templateName: p.templateName, screenIds, idx: 0, preview: null, busy: true, done: [] };
  render();
  await loadRestyleWalkPreview();
}

function reportRestyleBatchResult(data) {
  const lines = (data.results || []).map(r => {
    if (!r.ok) return '✗ ' + (r.screenId) + '：' + (r.error || '失敗');
    const unmatched = (r.unmatchedFromScreen || []).length + (r.unmatchedFromTemplate || []).length;
    return '✓ ' + r.screenName + '：對上 ' + r.matchedCount + '/' + r.templateElementCount + ' 格' + (unmatched ? '，' + unmatched + ' 項未能自動重套' : '');
  });
  alert('整批套用「' + data.templateName + '」完成：\n\n' + lines.join('\n'));
}

async function loadRestyleWalkPreview() {
  const w = state.restyleWalk;
  if (!w) return;
  w.busy = true; render();
  try {
    const screenId = w.screenIds[w.idx];
    const r = await api('/api/ui/screens/' + encodeURIComponent(screenId) + '/restyle/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ templateId: w.templateId })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '試算失敗');
    w.preview = data;
  } catch (e) { w.preview = { error: e.message }; }
  w.busy = false; render();
}

// 略過：不呼叫 apply，直接移到下一張（這張畫面完全不受影響）。
async function restyleWalkSkip() {
  const w = state.restyleWalk;
  if (!w) return;
  w.done.push({ screenId: w.screenIds[w.idx], skipped: true });
  await restyleWalkAdvance();
}

// 套用這張：呼叫 apply（後端存版本快照＋落地），成功才算走完這張。
async function restyleWalkApply() {
  const w = state.restyleWalk;
  if (!w || w.busy) return;
  w.busy = true; render();
  const screenId = w.screenIds[w.idx];
  try {
    const r = await api('/api/ui/screens/' + encodeURIComponent(screenId) + '/restyle/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ templateId: w.templateId })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '套用失敗');
    w.done.push({ screenId, applied: true, matchedCount: data.matchedCount, templateElementCount: data.templateElementCount });
    if (state.screenId === screenId) await selectScreen(screenId); // 若正開著這張，重載畫面內容
    await loadScreens();
  } catch (e) { alert('套用失敗：' + e.message); w.busy = false; render(); return; }
  await restyleWalkAdvance();
}

async function restyleWalkAdvance() {
  const w = state.restyleWalk;
  if (!w) return;
  w.idx += 1;
  if (w.idx >= w.screenIds.length) {
    const applied = w.done.filter(d => d.applied).length;
    const skipped = w.done.filter(d => d.skipped).length;
    alert('逐張確認完成：共 ' + w.done.length + ' 張，套用 ' + applied + ' 張、略過 ' + skipped + ' 張。');
    state.restyleWalk = null;
    render();
    return;
  }
  await loadRestyleWalkPreview();
}

function cancelRestyleWalk() {
  const w = state.restyleWalk;
  if (!w) return;
  const applied = w.done.filter(d => d.applied).length;
  if (applied && !confirm('已套用 ' + applied + ' 張，剩下的畫面不會再處理。確定要中止嗎？')) return;
  state.restyleWalk = null;
  render();
}

function renderUnmatchedList(title, items, labelFn) {
  if (!items || !items.length) return '';
  return '<div class="mt-1.5"><div class="text-[10px] font-semibold text-amber-600 dark:text-amber-400">' + title + '（' + items.length + '）</div>'
    + '<ul class="text-[10px] text-slate-500 dark:text-slate-400 list-disc list-inside">' + items.map(it => '<li>' + esc(labelFn(it)) + '</li>').join('') + '</ul></div>';
}

function renderRestyleWalkPanel() {
  const w = state.restyleWalk;
  if (!w) return '';
  const screenId = w.screenIds[w.idx];
  const screenMeta = state.screens.find(s => s.id === screenId);
  const p = w.preview;
  const body = w.busy ? '<div class="p-4 text-xs text-slate-400">試算中…</div>'
    : (p && p.error) ? '<div class="p-4 text-xs text-red-500">試算失敗：' + esc(p.error) + '</div>'
    : p ? (''
      + '<div class="px-4 py-2 text-xs text-slate-600 dark:text-slate-300">對上 <b>' + p.matchedCount + ' / ' + p.templateElementCount + '</b> 格範本插槽，內容全數保留。</div>'
      + '<div class="px-4 pb-2">'
      + renderUnmatchedList('未能自動重套（原畫面元件）', p.unmatchedFromScreen, it => it.reasonLabel)
      + renderUnmatchedList('範本插槽找不到對應內容（已用範本預設值）', p.unmatchedFromTemplate, it => it.reasonLabel)
      + '</div>'
    ) : '';
  return ''
    + '<div class="absolute inset-0 z-40 bg-black/30 flex items-center justify-center" id="uid-restyle-walk-backdrop">'
    + '  <div class="w-[460px] max-h-[80%] flex flex-col rounded-xl shadow-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 overflow-hidden">'
    + '    <div class="px-4 py-3 border-b border-slate-200 dark:border-slate-700/60 flex items-center justify-between">'
    + '      <div>'
    + '        <div class="text-sm font-semibold text-slate-800 dark:text-slate-100">逐張確認：' + esc(w.templateName) + '</div>'
    + '        <div class="text-[11px] text-slate-400 mt-0.5">' + (w.idx + 1) + ' / ' + w.screenIds.length + '　' + esc(screenMeta ? screenMeta.name : screenId) + '</div>'
    + '      </div>'
    + '      <button id="uid-restyle-walk-cancel" class="px-2 py-1 rounded-lg text-[11px] text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">中止</button>'
    + '    </div>'
    + '    <div class="flex-1 overflow-y-auto">' + body + '</div>'
    + '    <div class="px-4 py-2.5 border-t border-slate-200 dark:border-slate-700/60 flex items-center gap-2">'
    + '      <button id="uid-restyle-walk-skip" class="px-2.5 py-1 rounded-lg text-xs text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"' + (w.busy ? ' disabled' : '') + '>略過這張</button>'
    + '      <div class="flex-1"></div>'
    + '      <button id="uid-restyle-walk-apply" class="px-3 py-1 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-xs font-semibold' + (w.busy ? ' opacity-50 pointer-events-none' : '') + '">套用這張</button>'
    + '    </div>'
    + '  </div>'
    + '</div>';
}

// UID-43：版本記錄疊層——列出這張畫面所有重套/退回留下的快照，一鍵退回任一筆。
async function openRevisionsPanel() {
  if (!state.screen) return;
  state.revisionsPanel = { screenId: state.screen.id, list: [], loading: true };
  render();
  try {
    const r = await api('/api/ui/screens/' + encodeURIComponent(state.screen.id) + '/revisions');
    state.revisionsPanel.list = await r.json();
  } catch (e) { state.revisionsPanel.list = []; }
  state.revisionsPanel.loading = false;
  render();
}

function closeRevisionsPanel() { state.revisionsPanel = null; render(); }

async function restoreRevision(revId) {
  const p = state.revisionsPanel;
  if (!p) return;
  if (!confirm('退回到這個版本？目前的內容會先留一份（可再退回），不會直接消失。')) return;
  try {
    const r = await api('/api/ui/screens/' + encodeURIComponent(p.screenId) + '/revisions/' + encodeURIComponent(revId) + '/restore', { method: 'POST' });
    if (!r.ok) throw new Error((await r.json()).error || '退回失敗');
    await loadScreens();
    if (state.screenId === p.screenId) await selectScreen(p.screenId);
    state.revisionsPanel = null;
    render();
  } catch (e) { alert('退回失敗：' + e.message); }
}

function renderRevisionsPanel() {
  const p = state.revisionsPanel;
  if (!p) return '';
  const body = p.loading ? '<div class="p-4 text-xs text-slate-400">載入中…</div>'
    : !p.list.length ? '<div class="p-4 text-xs text-slate-400">這張畫面還沒有版本記錄（重套或退回之後才會產生）。</div>'
    : p.list.map(rv => ''
      + '<div class="flex items-center gap-2 px-3 py-2 border-b border-slate-100 dark:border-slate-800">'
      + '<div class="flex-1 min-w-0">'
      + '<div class="text-xs text-slate-700 dark:text-slate-200 truncate">' + esc(rv.label || rv.reason) + '</div>'
      + '<div class="text-[10px] text-slate-400">' + esc(rv.savedAt) + '</div>'
      + '</div>'
      + '<button data-restore-rev="' + rv.id + '" class="px-2 py-1 rounded-lg bg-violet-50 dark:bg-violet-900/30 text-violet-600 dark:text-violet-300 text-[11px] font-semibold whitespace-nowrap">退回這個版本</button>'
      + '</div>'
    ).join('');
  return ''
    + '<div class="absolute inset-0 z-40 bg-black/30 flex items-center justify-center" id="uid-revisions-backdrop">'
    + '  <div class="w-[420px] max-h-[80%] flex flex-col rounded-xl shadow-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 overflow-hidden">'
    + '    <div class="px-4 py-3 border-b border-slate-200 dark:border-slate-700/60 flex items-center justify-between">'
    + '      <div class="text-sm font-semibold text-slate-800 dark:text-slate-100">版本記錄</div>'
    + '      <button id="uid-revisions-close" class="px-2 py-1 rounded-lg text-[11px] text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">關閉</button>'
    + '    </div>'
    + '    <div class="flex-1 overflow-y-auto">' + body + '</div>'
    + '  </div>'
    + '</div>';
}

// UID10：畫面用途／來源 標籤對照表，畫布工具列與新畫面對話框共用。
const PURPOSE_LABELS = { login: '登入', list: '清單', detail: '詳情', form: '表單', dashboard: '儀表板', scan: '掃描' , other: '其他' };
const ORIGIN_LABELS = { manual: '手拉', template: '範本', image: '擷圖', skill: '技能' };
function purposeLabel(p) { return p ? (PURPOSE_LABELS[p] || p) : '未標記'; }
function originLabel(o) { return o ? (ORIGIN_LABELS[o] || o) : '未標記'; }
const ROLE_OPTS = ['header', 'nav', 'field-group', 'field', 'action-bar', 'action', 'list', 'list-item', 'card', 'text', 'media'];

function deviceGroupLabel(g) {
  return { desktop: '桌機', tablet: '平板', phone: '手機', pda: 'PDA', custom: '自訂' }[g] || g;
}

function renderTemplatesTab() {
  const filterBtn = (g, label) => '<button data-tpl-filter="' + g + '" class="px-2.5 py-1 rounded-lg text-xs font-semibold '
    + (state.templateFilterDevice === g ? 'bg-cyan-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700')
    + '">' + label + '</button>';
  const filters = '<div class="flex items-center gap-1.5 px-3 py-2 border-b border-slate-200 dark:border-slate-700/60 bg-white/70 dark:bg-slate-900/50 flex-wrap">'
    + filterBtn('all', '全部') + filterBtn('desktop', '桌機') + filterBtn('tablet', '平板') + filterBtn('phone', '手機') + filterBtn('pda', 'PDA')
    + '<span class="flex-1"></span>'
    + '<span class="text-[10px] text-slate-400">挑一個範本套用，或到「畫布設計」把做好的畫面另存為範本</span>'
    + '</div>';
  let body;
  if (state.templatesLoading) {
    body = '<div class="p-4 text-xs text-slate-400">載入中…</div>';
  } else if (!state.templates.length) {
    body = '<div class="p-6 text-xs text-slate-400 leading-relaxed text-center">'
      + (state.templateFilterDevice === 'all' ? '這個工作區還沒有範本。' : '這個裝置分類下還沒有範本。')
      + '</div>';
  } else {
    body = '<div class="grid gap-3 p-3" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr));">'
      + state.templates.map(t => ''
        + '<div class="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden bg-white dark:bg-slate-900 flex flex-col">'
        + '  <div class="aspect-[4/3] bg-slate-100 dark:bg-slate-800 flex items-center justify-center overflow-hidden">'
        + '    <img src="' + t.thumbnail + '" class="w-full h-full object-contain" alt="' + esc(t.name) + '">'
        + '  </div>'
        + '  <div class="p-2.5 flex-1 flex flex-col gap-1.5">'
        + '    <div class="text-xs font-semibold text-slate-700 dark:text-slate-200 truncate">' + esc(t.name) + '</div>'
        + '    <div class="text-[10px] text-slate-400">' + deviceGroupLabel(t.deviceGroup) + (t.source === 'seed' ? ' · 內建骨架' : ' · 自建') + '</div>'
        + '    <div class="flex-1"></div>'
        + '    <div class="flex items-center gap-1.5">'
        + '      <button data-tpl-apply="' + t.id + '" class="flex-1 px-2 py-1 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-[11px] font-semibold">套用</button>'
        + '      <button data-tpl-restyle="' + t.id + '" data-tpl-name="' + esc(t.name) + '" title="依範本重套（UID11）：把既有畫面換上這個範本的樣式，內容保留、可退回" class="px-2 py-1 rounded-lg bg-violet-50 dark:bg-violet-900/30 text-violet-600 dark:text-violet-300 text-[11px]">重套</button>'
        + '      <button data-tpl-del="' + t.id + '" data-tpl-name="' + esc(t.name) + '" class="px-2 py-1 rounded-lg bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-300 text-[11px]">刪除</button>'
        + '    </div>'
        + '  </div>'
        + '</div>'
      ).join('')
      + '</div>';
  }
  return '<div class="flex-1 flex flex-col overflow-hidden">' + filters + '<div class="flex-1 overflow-y-auto">' + body + '</div></div>';
}

function scheduleSave() {
  state.savePending = true;
  if (state.saveTimer) clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveScreenNow, 600);
}

async function saveScreenNow() {
  if (!state.screen) return;
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  const s = state.screen;
  try {
    await api('/api/ui/screens/' + encodeURIComponent(s.id), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: s.name, device: s.device, frame: s.frame, elements: s.elements, purpose: s.purpose })
    });
    state.savePending = false;
    const badge = container.querySelector('#uid-save-badge');
    if (badge) badge.textContent = '已儲存';
  } catch (e) { /* 靜默失敗，下次操作會再 debounce 重試 */ }
}

function elementValues(el, component) {
  const variant = (component.variants || [])[el.variantIndex || 0] || { name: '', values: {} };
  const defaults = {};
  (component.params || []).forEach(p => { defaults[p.key] = p.default; });
  return Object.assign({ variant: (variant.name || '').toLowerCase() }, defaults, variant.values || {}, el.overrides || {});
}

function refreshElementFrame(elId) {
  const el = (state.screen.elements || []).find(e => e.id === elId);
  if (!el) return;
  const component = state.compCache[el.componentId];
  const frame = container.querySelector('.uid-el-frame[data-el="' + elId + '"]');
  if (!frame || !component) return;
  frame.srcdoc = buildRenderSrcdoc(component, elementValues(el, component), 'display:flex;align-items:center;justify-content:center;width:100%;height:100%;overflow:hidden;', canvasIsDark());
}

function deviceLabel(id) {
  const d = state.devices.find(x => x.id === id);
  return d ? d.label : id;
}

function renderScreenList() {
  if (state.screensLoading) return '<div class="p-3 text-xs text-slate-400">載入中…</div>';
  if (!state.screens.length) {
    return '<div class="p-3 text-xs text-slate-400 leading-relaxed">這個工作區還沒有畫面。<br>點「+ 新畫面」開始拼第一張畫面。</div>';
  }
  return state.screens.map(s =>
    '<button data-screen="' + s.id + '" class="w-full text-left px-3 py-2 rounded-lg text-xs ' +
    (s.id === state.screenId ? 'bg-cyan-50 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-300 font-semibold' : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800') +
    '"><div class="font-medium truncate">' + esc(s.name) + '</div>'
    + '<div class="text-[10px] text-slate-400">' + esc(deviceLabel(s.device)) + '</div></button>'
  ).join('');
}

function renderComponentPalette() {
  if (!state.components.length) {
    return '<div class="p-3 text-[11px] text-slate-400 leading-relaxed">還沒有元件可拖放，先去「元件庫」分頁建幾顆。</div>';
  }
  const groups = groupByCategory(state.components);
  return Object.keys(groups).sort().map(cat =>
    '<div class="mb-1">'
    + '<div class="px-3 py-1 text-[10px] font-bold text-slate-400 uppercase tracking-wide">' + esc(cat) + '</div>'
    + groups[cat].map(c =>
      '<div draggable="true" data-drag-comp="' + c.id + '" class="mx-2 mb-1 px-2.5 py-1.5 rounded-lg text-xs bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 cursor-grab hover:bg-cyan-50 dark:hover:bg-cyan-900/30 truncate">' + esc(c.name) + '</div>'
    ).join('')
    + '</div>'
  ).join('');
}

function renderLayers() {
  if (!state.screen) return '';
  const els = (state.screen.elements || []);
  // 圖層清單：z 大的在上方（視覺最上層）
  const sorted = els.map((el, idx) => ({ el, idx })).sort((a, b) => (b.el.z || 0) - (a.el.z || 0));
  if (!sorted.length) return '<div class="p-3 text-[11px] text-slate-400">畫面上還沒有元件，從左側拖一顆進來。</div>';
  return sorted.map(({ el }) => {
    const comp = state.compCache[el.componentId];
    const name = comp ? comp.name : el.componentId;
    const selected = state.selection.indexOf(el.id) !== -1;
    return '<div data-layer="' + el.id + '" class="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs cursor-pointer ' +
      (selected ? 'bg-cyan-50 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-300' : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300') + '">'
      + '<span class="flex-1 truncate">' + esc(name) + '</span>'
      + '<button data-layer-up="' + el.id + '" title="上移一層" class="w-5 h-5 flex items-center justify-center text-[10px] rounded hover:bg-slate-200 dark:hover:bg-slate-700">▲</button>'
      + '<button data-layer-down="' + el.id + '" title="下移一層" class="w-5 h-5 flex items-center justify-center text-[10px] rounded hover:bg-slate-200 dark:hover:bg-slate-700">▼</button>'
      + '</div>';
  }).join('');
}

// UID-37：role 下拉選單共用 markup，單選/多選批次標記都用它。
function renderRoleSelect(id, current) {
  const opts = ['<option value=""' + (!current ? ' selected' : '') + '>（未標記）</option>']
    .concat(ROLE_OPTS.map(r => '<option value="' + r + '"' + (current === r ? ' selected' : '') + '>' + r + '</option>'));
  return '<select id="' + id + '" class="w-full px-2 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs">' + opts.join('') + '</select>';
}

// UID17 §7.5.2 D15：屬性面板的「事件」區塊——可新增/刪除多列，每列選觸發時機(on)、動作(action)，
// 依動作動態出對應的目標欄位：navigate→本工作區畫面下拉、toast→文字輸入框、toggle→同畫面其它
// 元件實例下拉。沿用既有屬性面板的樣式（同一批 class）與 debounce 存檔（scheduleSave），不自創
// 新樣式或新的存檔管道；與既有 link 欄位共存，互不覆寫（見 elementEventsFor）。
function renderEventTargetField(ev, idx, el) {
  if (ev.action === 'toast') {
    return '<input data-event-message="' + idx + '" value="' + esc(ev.message || '') + '" placeholder="提示文字" class="w-full px-2 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs">';
  }
  if (ev.action === 'toggle') {
    const others = (state.screen.elements || []).filter(e => e.id !== el.id);
    const opts = ['<option value="">（選一個要切換顯示/隱藏的元件）</option>'].concat(
      others.map(e => {
        const comp = state.compCache[e.componentId];
        const label = (comp ? comp.name : e.componentId) + '（' + e.id.slice(-4) + '）';
        return '<option value="' + e.id + '"' + (ev.target === e.id ? ' selected' : '') + '>' + esc(label) + '</option>';
      })
    ).join('');
    return '<select data-event-target="' + idx + '" class="w-full px-2 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs">' + opts + '</select>';
  }
  // navigate（預設）
  const opts = ['<option value="">（選一個目標畫面）</option>'].concat(
    state.screens.filter(s => s.id !== state.screen.id).map(s => '<option value="' + s.id + '"' + (ev.target === s.id ? ' selected' : '') + '>' + esc(s.name) + '</option>')
  ).join('');
  return '<select data-event-target="' + idx + '" class="w-full px-2 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs">' + opts + '</select>';
}

function renderEventRow(ev, idx, el) {
  const onOpts = ['click', 'change'].map(v => '<option value="' + v + '"' + (ev.on === v ? ' selected' : '') + '>' + (v === 'click' ? '點擊' : '值改變') + '</option>').join('');
  const actionOpts = [['navigate', '前往畫面'], ['toast', '顯示提示'], ['toggle', '顯示/隱藏']].map(pair => '<option value="' + pair[0] + '"' + (ev.action === pair[0] ? ' selected' : '') + '>' + pair[1] + '</option>').join('');
  return '<div data-event-row="' + idx + '" class="flex items-center gap-1 mb-1.5">'
    + '<select data-event-on="' + idx + '" class="px-1.5 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs">' + onOpts + '</select>'
    + '<select data-event-action="' + idx + '" class="px-1.5 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs">' + actionOpts + '</select>'
    + '<div class="flex-1">' + renderEventTargetField(ev, idx, el) + '</div>'
    + '<button data-event-del="' + idx + '" title="刪除此事件" class="w-5 h-5 flex-shrink-0 flex items-center justify-center text-[11px] rounded hover:bg-red-100 dark:hover:bg-red-900/40 text-red-500">✕</button>'
    + '</div>';
}

function renderEventsSection(el) {
  const events = el.events || [];
  const rows = events.map((ev, idx) => renderEventRow(ev, idx, el)).join('');
  return '<div class="pt-1 border-t border-slate-200 dark:border-slate-700/60">'
    + '<label class="text-[10px] text-slate-400 block mb-1">事件（UID17：點擊/值改變時要發生什麼）</label>'
    + rows
    + '<button id="uid-el-event-add" class="w-full mt-0.5 px-2 py-1 rounded-md bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 text-[11px] font-semibold">+ 新增事件</button>'
    + '</div>';
}

function renderProperties() {
  if (!state.screen) return '';
  if (state.selection.length > 1) {
    // UID-37：多選批次標記——一次把 role 套到所有選取的元件上。
    return '<div class="p-3 space-y-2 text-xs">'
      + '<div class="text-[11px] text-slate-400">已選取 ' + state.selection.length + ' 個元件（多選僅支援移動／刪除／批次標記角色）</div>'
      + '<div class="pt-1 border-t border-slate-200 dark:border-slate-700/60">'
      + '<label class="text-[10px] text-slate-400 block">批次標記角色（role，UID10）</label>'
      + renderRoleSelect('uid-batch-role', '')
      + '<button id="uid-batch-role-apply" class="w-full mt-1.5 px-2 py-1 rounded-md bg-cyan-600 hover:bg-cyan-700 text-white text-[11px] font-semibold">套用到全部選取</button>'
      + '</div></div>';
  }
  if (state.selection.length !== 1) {
    return '<div class="p-3 text-[11px] text-slate-400">點畫面上的元件可編輯參數</div>';
  }
  const el = (state.screen.elements || []).find(e => e.id === state.selection[0]);
  if (!el) return '';
  const comp = state.compCache[el.componentId];
  if (!comp) return '<div class="p-3 text-[11px] text-slate-400">元件載入中…</div>';
  const variantOpts = (comp.variants || []).map((v, i) => '<option value="' + i + '"' + (i === (el.variantIndex || 0) ? ' selected' : '') + '>' + esc(v.name || ('變體 ' + (i + 1))) + '</option>').join('');
  const values = elementValues(el, comp);
  const paramInputs = (comp.params || []).map(p =>
    '<div class="mb-1.5"><label class="text-[10px] text-slate-400 block">' + esc(p.label || p.key) + '</label>'
    + '<input data-override="' + esc(p.key) + '" value="' + esc(values[p.key] == null ? '' : values[p.key]) + '" class="w-full px-2 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs"></div>'
  ).join('');
  const linkOpts = ['<option value="">（無跳轉，UID3 才會生效）</option>'].concat(
    state.screens.filter(s => s.id !== state.screen.id).map(s => '<option value="' + s.id + '"' + ((el.link && el.link.targetScreenId === s.id) ? ' selected' : '') + '>' + esc(s.name) + '</option>')
  ).join('');
  return ''
    + '<div class="p-3 space-y-2 text-xs">'
    + '  <div class="font-semibold text-slate-700 dark:text-slate-200">' + esc(comp.name) + '</div>'
    + '  <div class="grid grid-cols-2 gap-1.5">'
    + '    <div><label class="text-[10px] text-slate-400 block">X</label><input data-geo="x" type="number" value="' + Math.round(el.x) + '" class="w-full px-2 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"></div>'
    + '    <div><label class="text-[10px] text-slate-400 block">Y</label><input data-geo="y" type="number" value="' + Math.round(el.y) + '" class="w-full px-2 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"></div>'
    + '    <div><label class="text-[10px] text-slate-400 block">寬</label><input data-geo="width" type="number" value="' + Math.round(el.width) + '" class="w-full px-2 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"></div>'
    + '    <div><label class="text-[10px] text-slate-400 block">高</label><input data-geo="height" type="number" value="' + Math.round(el.height) + '" class="w-full px-2 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"></div>'
    + '  </div>'
    + (comp.variants && comp.variants.length ? ('  <div><label class="text-[10px] text-slate-400 block">變體</label><select data-el-variant class="w-full px-2 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900">' + variantOpts + '</select></div>') : '')
    + '  <div class="pt-1 border-t border-slate-200 dark:border-slate-700/60">' + paramInputs + '</div>'
    // UID10 UID-37：元件實例語意標記——role（畫面裡的角色）與 slot（對應範本插槽名，選填）。
    + '  <div class="pt-1 border-t border-slate-200 dark:border-slate-700/60 space-y-1.5">'
    + '    <div><label class="text-[10px] text-slate-400 block">角色（role，UID10）</label>' + renderRoleSelect('uid-el-role', el.role || '') + '</div>'
    + '    <div><label class="text-[10px] text-slate-400 block">插槽（slot，對應範本插槽名，選填）</label><input data-el-slot value="' + esc(el.slot || '') + '" class="w-full px-2 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs"></div>'
    + '  </div>'
    + '  <div class="pt-1 border-t border-slate-200 dark:border-slate-700/60"><label class="text-[10px] text-slate-400 block">點擊跳轉至（舊版跳轉連結，UID17 之後建議改用下方「事件」設 navigate）</label><select data-el-link class="w-full px-2 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900">' + linkOpts + '</select></div>'
    + renderEventsSection(el)
    + '  <button data-el-delete class="w-full mt-1 px-2 py-1.5 rounded-lg bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-300 font-semibold">刪除此元件</button>'
    + '</div>';
}

function renderCanvasFrame() {
  if (!state.screen) {
    return '<div class="flex-1 flex items-center justify-center text-sm text-slate-400">從左側選一個畫面，或點「+ 新畫面」</div>';
  }
  const s = state.screen;
  const els = (s.elements || []).slice().sort((a, b) => (a.z || 0) - (b.z || 0));
  const elementsHtml = els.map(el => {
    const selected = state.selection.indexOf(el.id) !== -1;
    const handles = (state.selection.length === 1 && selected) ? RESIZE_HANDLES.map(h =>
      '<div data-handle="' + h + '" class="uid-handle uid-handle-' + h + '" style="position:absolute;width:8px;height:8px;background:#fff;border:1.5px solid #0891b2;border-radius:2px;"></div>'
    ).join('') : '';
    // UID-39：標記檢視開啟時，未標 role 的元件用琥珀色虛線框標出（選取狀態優先，避免視覺打架）。
    const unmarked = state.markMode && !el.role;
    const outline = selected ? 'outline:2px solid #0891b2;outline-offset:1px;'
      : unmarked ? 'outline:2px dashed #f59e0b;outline-offset:1px;'
      : 'outline:1px dashed transparent;';
    return '<div data-el-wrap="' + el.id + '" style="position:absolute;left:' + el.x + 'px;top:' + el.y + 'px;width:' + el.width + 'px;height:' + el.height + 'px;'
      + outline + '" class="uid-el-wrap group">'
      + '<iframe data-el="' + el.id + '" class="uid-el-frame" sandbox="allow-scripts" style="width:100%;height:100%;border:0;pointer-events:none;background:transparent;"></iframe>'
      + (unmarked ? '<div class="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-amber-500" title="未標記"></div>' : '')
      + handles
      + '</div>';
  }).join('');
  // UID-26/UID-27：外層 scroll 容器保留原生滾輪捲動（平移）；中間 zoom-wrap 依縮放後的實際
  // 尺寸佔位，讓捲軸/置中運算正確；內層 uid-canvas-frame 用 CSS transform:scale 呈現縮放，
  // 但自身 width/height 仍是畫框原生尺寸——所有滑鼠座標換算（拖曳/縮放/框選/拖放）沿用既有
  // 「(clientXY - frame.getBoundingClientRect()) / state.zoom」寫法，因為 transform 後的
  // getBoundingClientRect() 本來就回傳「已縮放」的實際畫面座標，不必另外改算法。
  const zoom = state.zoom || 1;
  const zw = Math.round(s.frame.width * zoom), zh = Math.round(s.frame.height * zoom);
  return ''
    // 置中改用 margin:auto 而非 flex justify-center：flex 置中在「內容比容器大」時會把溢出
    // 推到左上、且捲不回去（畫框比視窗大時左上角被切掉就是這個原因）；margin:auto 在 block
    // 容器裡溢出時會自動退化成靠左，捲軸涵蓋完整內容。
    + '<div class="flex-1 overflow-auto p-8" id="uid-canvas-scroll" style="' + (isPanMode() ? 'cursor:grab;' : '') + '">'
    + '  <div id="uid-canvas-zoom-wrap" style="position:relative;width:' + zw + 'px;height:' + zh + 'px;margin:0 auto;">'
    + '    <div id="uid-canvas-frame" data-frame-w="' + s.frame.width + '" data-frame-h="' + s.frame.height + '" style="position:absolute;left:0;top:0;width:' + s.frame.width + 'px;height:' + s.frame.height + 'px;transform:scale(' + zoom + ');transform-origin:top left;background:' + (canvasIsDark() ? '#0f172a' : '#fff') + ';box-shadow:0 0 0 1px rgba(0,0,0,.08),0 8px 24px rgba(0,0,0,.12);">'
    + '      <div id="uid-snap-lines"></div>'
    + elementsHtml
    + '    </div>'
    + '  </div>'
    + '</div>';
}

const RESIZE_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

// UID8：畫布分頁統一工具列——復原/重做、縮放（+/－/100%/符合視窗）、全螢幕編輯、全螢幕預覽
// （唯讀）、主題切換（全螢幕下摸不到全域 header，比照白板慣例複製一份到這裡）。這一列連同下面
// 三欄一起被外層 #uid-canvas-shell 包住，全螢幕時整塊一起顯示，工具都按得到。
// UID8 修正：常駐工具切換（比照白板／Figma）——箭頭＝選取編輯元件，手掌＝拖動整個畫布。
// 快捷鍵 V / H，另外按住空白鍵可在箭頭模式下臨時平移。
function renderToolGroup() {
  const cell = (tool, icon, title) => '<button data-uid-tool="' + tool + '" title="' + esc(title) + '" class="p-1.5 '
    + (state.tool === tool
      ? 'bg-cyan-500 text-white'
      : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300')
    + '"><i data-lucide="' + icon + '" class="h-3.5 w-3.5"></i></button>';
  return '<div class="flex items-center gap-0.5 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">'
    + cell('select', 'mouse-pointer-2', '選取元件（V）')
    + cell('pan', 'hand', '拖曳畫面（H）－ 也可按住空白鍵臨時使用')
    + '</div>';
}

// UID9：畫面尺寸標籤——dp 畫面同時標出設計用 dp 尺寸與換算回的實體像素／密度倍率，
// 讓指揮官一眼看出「這是尺寸模式，不是解析度模式」；px 畫面維持原樣（向後相容）。
function screenSizeLabel(screen) {
  const base = screen.frame.width + '×' + screen.frame.height;
  if (screen.unit === 'dp' && screen.nativeWidth && screen.nativeHeight) {
    return base + 'dp（' + screen.nativeWidth + '×' + screen.nativeHeight + 'px @' + (screen.scale || 1) + 'x）';
  }
  return base;
}

// UID-39：標記覆蓋率——只算「有 componentId 的元件」是否已標 role，回傳 {marked, total}。
function coverageStats(screen) {
  const els = (screen && screen.elements) || [];
  const marked = els.filter(el => el.role).length;
  return { marked, total: els.length };
}

function renderCanvasToolbar() {
  const zoomPct = Math.round((state.zoom || 1) * 100);
  const btn = (id, icon, title, extra) => '<button id="' + id + '" title="' + esc(title) + '" class="p-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-300 transition-colors' + (extra || '') + '"><i ' + (id === 'uid-fullscreen-btn' ? 'id="uid-fullscreen-icon" ' : '') + 'data-lucide="' + icon + '" class="h-3.5 w-3.5"></i></button>';
  const isDpScreen = !!(state.screen && state.screen.unit === 'dp');
  const cov = state.screen ? coverageStats(state.screen) : null;
  return ''
    + '<div class="flex items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-700/60 bg-white/70 dark:bg-slate-900/50 flex-wrap flex-shrink-0">'
    + (state.screen ? (
      '<input id="uid-screen-name" value="' + esc(state.screen.name) + '" class="px-2.5 py-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm font-semibold w-40">'
      + '<span class="text-[11px] text-slate-400 whitespace-nowrap">' + (isDpScreen ? '尺寸模式 · ' : esc(deviceLabel(state.screen.device)) + ' · ') + screenSizeLabel(state.screen) + '</span>'
      + '<span id="uid-save-badge" class="text-[10px] text-slate-400">已儲存</span>'
      // UID10：畫面用途可事後補標／改標；來源是唯讀徽章（怎麼建立的就是怎麼建立的，不可事後假造）。
      + '<select id="uid-screen-purpose" title="畫面用途（語意標記，UID10）" class="text-[11px] px-1.5 py-0.5 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900">'
      + '<option value=""' + (!state.screen.purpose ? ' selected' : '') + '>用途：未標記</option>'
      + Object.keys(PURPOSE_LABELS).map(p => '<option value="' + p + '"' + (state.screen.purpose === p ? ' selected' : '') + '>用途：' + PURPOSE_LABELS[p] + '</option>').join('')
      + '</select>'
      + '<span class="text-[10px] px-1.5 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-400 whitespace-nowrap">來源：' + esc(originLabel(state.screen.origin)) + '</span>'
    ) : '<span class="text-xs text-slate-400">未開啟畫面</span>')
    + '<div class="flex-1"></div>'
    + (state.screen ? btn('uid-mark-mode-btn', 'tag', '標記檢視（UID-39）' + (cov ? '：' + cov.marked + '/' + cov.total + ' 已標記' : ''), state.markMode ? ' ring-2 ring-cyan-500' : '') : '')
    + (state.screen && state.markMode ? '<span class="text-[10px] text-cyan-600 dark:text-cyan-400 whitespace-nowrap font-semibold">' + cov.marked + '/' + cov.total + ' 已標記</span>' : '')
    + renderToolGroup()
    + '<div class="flex items-center gap-0.5 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">'
    + '  <button id="uid-undo" title="復原 (Ctrl+Z)"' + (state.undoStack.length ? '' : ' disabled') + ' class="p-1.5 ' + (state.undoStack.length ? 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300' : 'text-slate-300 dark:text-slate-600 cursor-not-allowed') + '"><i data-lucide="undo-2" class="h-3.5 w-3.5"></i></button>'
    + '  <button id="uid-redo" title="重做 (Ctrl+Shift+Z / Ctrl+Y)"' + (state.redoStack.length ? '' : ' disabled') + ' class="p-1.5 ' + (state.redoStack.length ? 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300' : 'text-slate-300 dark:text-slate-600 cursor-not-allowed') + '"><i data-lucide="redo-2" class="h-3.5 w-3.5"></i></button>'
    + '</div>'
    + '<div class="flex items-center gap-0.5 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">'
    + '  <button id="uid-zoom-out" title="縮小" class="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300"><i data-lucide="minus" class="h-3.5 w-3.5"></i></button>'
    + '  <button id="uid-zoom-100" title="100%" class="px-2 py-1 text-[11px] font-semibold hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 w-12">' + zoomPct + '%</button>'
    + '  <button id="uid-zoom-in" title="放大" class="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300"><i data-lucide="plus" class="h-3.5 w-3.5"></i></button>'
    + '  <button id="uid-zoom-fit" title="符合視窗" class="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300"><i data-lucide="scan" class="h-3.5 w-3.5"></i></button>'
    + '</div>'
    + (state.screen ? (
      '<button id="uid-screen-dup" class="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs font-semibold whitespace-nowrap">複製畫面</button>'
      + '<button id="uid-screen-save-template" title="另存為範本（UID5）" class="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs font-semibold whitespace-nowrap">另存為範本</button>'
      + '<button id="uid-screen-revisions" title="版本記錄（UID11：重套/退回都會留一筆，可一鍵退回）" class="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs font-semibold whitespace-nowrap">版本記錄</button>'
      + '<button id="uid-screen-del" class="px-2.5 py-1 rounded-lg bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-300 text-xs font-semibold whitespace-nowrap">刪除畫面</button>'
    ) : '')
    + btn('uid-preview-fullscreen-btn', 'eye', '全螢幕預覽（唯讀）')
    + btn('uid-play-btn', 'play', '播放可點擊原型（UID3：可點擊跳轉）')
    + btn('uid-fullscreen-btn', 'maximize', '全螢幕編輯')
    + btn('uid-theme-btn', canvasIsDark() ? 'sun' : 'moon', canvasIsDark() ? '畫布主題：深色（點擊切為淺色）' : '畫布主題：淺色（點擊切為深色）')
    + '</div>';
}

// UID-09b：裝置下拉＝出廠預設 + 本工作區已存的自訂尺寸 + 「＋ 自訂尺寸…」入口。
// 舊的 'custom' 佔位預設（固定 800×600、不能改）不再列出，但保留在後端以免既有畫面的
// device 欄位對不到標籤。
function renderPxDeviceChooser() {
  const sel = state.newDevice || (state.devices[0] && state.devices[0].id) || '';
  const opts = state.devices
    .filter(d => d.id !== 'custom')
    .map(d => '<option value="' + d.id + '"' + (sel === d.id ? ' selected' : '') + '>' + esc(d.label) + (d.custom ? '' : '') + '</option>')
    .join('');
  const isCustom = sel === '__custom__';
  const current = state.devices.find(d => d.id === sel);
  const inp = (id, ph, val) => '<input id="' + id + '" value="' + esc(String(val || '')) + '" placeholder="' + esc(ph) + '" class="w-full px-2 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs">';
  return ''
    + '<select id="uid-new-device" class="w-full px-2 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs">'
    + opts
    + '<option value="__custom__"' + (isCustom ? ' selected' : '') + '>＋ 自訂尺寸…</option>'
    + '</select>'
    + (isCustom
      ? '<div class="space-y-1.5 p-2 rounded-md bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700">'
        + '<div class="flex items-center gap-1.5">'
        + inp('uid-custom-w', '寬', state.customW) + '<span class="text-[11px] text-slate-400">×</span>' + inp('uid-custom-h', '高', state.customH)
        + '</div>'
        + inp('uid-custom-label', '名稱（選填，例：客戶大屏）', state.customLabel)
        + '<div class="text-[10px] text-slate-400 leading-snug">按下「新畫面」時會把這個尺寸存進本工作區，之後在上面的選單就選得到。</div>'
        + '</div>'
      : '')
    + (current && current.custom
      ? '<button id="uid-device-del" class="w-full px-2 py-1 rounded-md text-[11px] text-red-600 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/30">移除這個自訂尺寸</button>'
      : '');
}

// UID9 UID-32：尺寸模式——挑機型，或自填「對角吋數＋實體解析度」，系統算出 dp 畫框。
function renderDpModelChooser() {
  const sel = state.newModel || (state.models[0] && state.models[0].id) || '';
  const opts = state.models
    .map(m => '<option value="' + m.id + '"' + (sel === m.id ? ' selected' : '') + '>' + esc(m.label) + '（' + m.scale + 'x）</option>')
    .join('');
  const isCustom = sel === '__custom__';
  const current = state.models.find(m => m.id === sel);
  const inp = (id, ph, val) => '<input id="' + id + '" value="' + esc(String(val || '')) + '" placeholder="' + esc(ph) + '" class="w-full px-2 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs">';
  let preview = '';
  if (isCustom) {
    const di = parseFloat(state.customDiagonal), w = parseInt(state.customNativeW, 10), h = parseInt(state.customNativeH, 10);
    if (di > 0 && w > 0 && h > 0) {
      const ppi = Math.sqrt(w * w + h * h) / di;
      const scale = ppi / 160;
      preview = '<div class="text-[10px] text-cyan-600 dark:text-cyan-400">≈ ' + Math.round(ppi) + ' PPI · ' + Math.round(scale * 100) / 100 + 'x · dp 畫框 ' + Math.round(w / scale) + '×' + Math.round(h / scale) + '</div>';
    }
  } else if (current) {
    preview = '<div class="text-[10px] text-slate-400">dp 畫框 ' + Math.round(current.nativeWidth / current.scale) + '×' + Math.round(current.nativeHeight / current.scale) + '（同吋數不同解析度的機型會算出同一組 dp 畫框）</div>';
  }
  return ''
    + '<select id="uid-new-model" class="w-full px-2 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs">'
    + opts
    + '<option value="__custom__"' + (isCustom ? ' selected' : '') + '>＋ 自填吋數／解析度…</option>'
    + '</select>'
    + (isCustom
      ? '<div class="space-y-1.5 p-2 rounded-md bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700">'
        + inp('uid-custom-diagonal', '對角吋數（例：6.1）', state.customDiagonal)
        + '<div class="flex items-center gap-1.5">'
        + inp('uid-custom-native-w', '實體寬(px)', state.customNativeW) + '<span class="text-[11px] text-slate-400">×</span>' + inp('uid-custom-native-h', '實體高(px)', state.customNativeH)
        + '</div>'
        + '</div>'
      : '')
    + preview;
}

// UID-32 模式切換：解析度模式（現況，預設）／尺寸模式（dp，D13）。
function renderDeviceChooser() {
  const cell = (mode, label) => '<button data-screen-mode="' + mode + '" class="flex-1 px-2 py-1 text-[11px] font-semibold ' +
    (state.newScreenMode === mode ? 'bg-cyan-500 text-white' : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300') + '">' + label + '</button>';
  return ''
    + '<div class="flex border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">'
    + cell('px', '解析度模式') + cell('dp', '尺寸模式（dp）')
    + '</div>'
    + (state.newScreenMode === 'dp' ? renderDpModelChooser() : renderPxDeviceChooser());
}

// UID-31：手動重抓畫布資料。技能（/ui-from-image）或另一個分頁寫進工作區的畫面／元件，
// 這支會一次補齊：畫面清單、元件庫（含 compCache 失效重建）、裝置與機型清單，並重載目前開著
// 的那張畫面。重抓前先把 debounce 中的存檔沖掉，避免用伺服器版本覆蓋掉剛改還沒存的編輯。
async function refreshCanvasData() {
  if (state.refreshing) return;
  state.refreshing = true;
  render();
  try {
    if (state.savePending) { try { await saveScreenNow(); } catch (e) {} }
    state.compCache = {};
    await Promise.all([
      (async () => { try { const r = await api('/api/ui/components'); state.components = await r.json(); } catch (e) {} })(),
      loadDevices(),
      loadModels(),
      (async () => { try { const r = await api('/api/ui/screens'); state.screens = await r.json(); state.screensLoading = false; } catch (e) {} })()
    ]);
  } finally {
    state.refreshing = false;
  }
  // 目前開著的畫面若還在，重載它（順便把元件快取補回來）；若已被刪除就回到未開啟狀態。
  if (state.screenId && state.screens.some(s => s.id === state.screenId)) {
    await selectScreen(state.screenId);
  } else {
    if (state.screenId) { state.screenId = null; state.screen = null; state.selection = []; }
    render();
  }
}

function renderCanvasTab() {
  return ''
    + renderCanvasToolbar()
    + '<div class="flex-1 flex overflow-hidden">'
    + '<aside class="w-52 flex-shrink-0 border-r border-slate-200 dark:border-slate-700/60 bg-white/70 dark:bg-slate-900/50 flex flex-col overflow-hidden">'
    + '  <div class="p-2.5 border-b border-slate-200 dark:border-slate-700/60 space-y-1.5">'
    + renderDeviceChooser()
    // UID10：新畫面用途，選填（不新增額外提問負擔，預設「未標記」也能建畫面）。
    + '    <select id="uid-new-purpose" class="w-full px-2 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs">'
    + '      <option value="">用途（選填，未標記）</option>'
    + Object.keys(PURPOSE_LABELS).map(p => '<option value="' + p + '"' + (state.newPurpose === p ? ' selected' : '') + '>' + PURPOSE_LABELS[p] + '</option>').join('')
    + '    </select>'
    + '    <button id="uid-screen-new" class="w-full px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-xs font-semibold">+ 新畫面</button>'
    + '  </div>'
    // UID-31：畫面／元件可能由技能（/ui-from-image）或其他分頁在背景寫進工作區，前端不會自動
    // 知道；這一列的重新整理鈕＝手動重抓，免得只能靠重新整理整個瀏覽器頁面才看得到。
    + '  <div class="flex items-center justify-between px-3 pt-2 pb-1">'
    + '    <span class="text-[10px] font-bold text-slate-400 uppercase">畫面</span>'
    + '    <button id="uid-screens-refresh" title="重新整理畫面與元件（抓取技能或其他分頁剛產生的內容）"' + (state.refreshing ? ' disabled' : '') + ' class="p-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"><i data-lucide="refresh-cw" class="h-3 w-3' + (state.refreshing ? ' animate-spin' : '') + '"></i></button>'
    + '  </div>'
    + '  <div class="flex-1 overflow-y-auto py-1">' + renderScreenList() + '</div>'
    + '  <div class="border-t border-slate-200 dark:border-slate-700/60 max-h-56 overflow-y-auto">'
    + '    <div class="px-3 pt-2 text-[10px] font-bold text-slate-400 uppercase">元件（拖到畫布上）</div>'
    + renderComponentPalette()
    + '  </div>'
    + '</aside>'
    + '<div class="flex-1 flex flex-col overflow-hidden">'
    + renderCanvasFrame()
    + '</div>'
    + '<aside class="w-60 flex-shrink-0 border-l border-slate-200 dark:border-slate-700/60 bg-white/70 dark:bg-slate-900/50 flex flex-col overflow-hidden">'
    + '  <div class="px-3 py-2 text-[10px] font-bold text-slate-400 uppercase border-b border-slate-200 dark:border-slate-700/60">圖層</div>'
    + '  <div class="max-h-40 overflow-y-auto py-1">' + renderLayers() + '</div>'
    + '  <div class="px-3 py-2 text-[10px] font-bold text-slate-400 uppercase border-t border-b border-slate-200 dark:border-slate-700/60">屬性</div>'
    + '  <div class="flex-1 overflow-y-auto">' + renderProperties() + '</div>'
    + '</aside>'
    + '</div>';
}

// ── UID-27 縮放 ─────────────────────────────────────────────────────────

function setZoom(z) {
  state.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(z * 100) / 100));
  render();
}

// Ctrl+滾輪：以游標所在位置為中心縮放（縮放前後，游標下方那一點在螢幕上的位置不變）。
// frameEl() 是有 CSS transform:scale 的元素，getBoundingClientRect() 回傳的就是「已縮放」的
// 實際畫面座標，縮放前後各量一次即可算出要補的捲動量，不必額外反推 transform 矩陣。
function zoomAt(clientX, clientY, factor) {
  if (!state.screen) return;
  const frame = frameEl();
  const scrollEl = container.querySelector('#uid-canvas-scroll');
  if (!frame || !scrollEl) return;
  const before = frame.getBoundingClientRect();
  const localX = (clientX - before.left) / state.zoom;
  const localY = (clientY - before.top) / state.zoom;
  const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(state.zoom * factor * 100) / 100));
  if (newZoom === state.zoom) return;
  state.zoom = newZoom;
  render();
  const frame2 = frameEl();
  const scrollEl2 = container.querySelector('#uid-canvas-scroll');
  if (!frame2 || !scrollEl2) return;
  const after = frame2.getBoundingClientRect();
  const targetLeft = clientX - localX * newZoom;
  const targetTop = clientY - localY * newZoom;
  scrollEl2.scrollLeft += (after.left - targetLeft);
  scrollEl2.scrollTop += (after.top - targetTop);
}

// 「符合視窗」：把整個畫框等比縮到剛好塞進可編輯區（可視區扣掉 padding），這是指揮官點名的
// 主要需求——1920×1080 這種畫框在一般螢幕上放不下。切換畫面/改變畫框尺寸時自動套用一次。
function fitToWindow() {
  if (!state.screen) return;
  const scrollEl = container && container.querySelector('#uid-canvas-scroll');
  if (!scrollEl) return;
  const availW = Math.max(50, scrollEl.clientWidth - 64);
  const availH = Math.max(50, scrollEl.clientHeight - 64);
  const fw = state.screen.frame.width, fh = state.screen.frame.height;
  let z = Math.min(availW / fw, availH / fh);
  z = Math.max(MIN_ZOOM, Math.min(2, z)); // 符合視窗不無限放大，最多到 2x
  state.zoom = Math.round(z * 100) / 100;
  render();
}

// ── UID-26 平移（抓取拖拉畫面）────────────────────────────────────────────
// 分流原則（比照白板）：空白處拖曳＝框選（既有行為，見 bindCanvasMarquee）；空白鍵按住拖曳／
// 中鍵拖曳＝平移；滾輪／觸控板兩指捲動＝瀏覽器原生 overflow:auto 捲動，不必額外實作。
// #uid-canvas-scroll 每次 render() 都是全新 DOM 節點，把 mousedown/wheel 綁在它身上沒有洩漏
// 疑慮（舊節點連同監聽器一起被丟棄）；但 document 級的 mousemove/mouseup 若跟著每次 render
// 重綁會疊加成好幾份，改用 panState 這個模組層級可變物件 + 只在 mount() 綁一次 document 監聽。
// select／pan 兩種常駐模式；空白鍵按住＝臨時 pan（不改變常駐模式）
function isPanMode() { return state.tool === 'pan' || state._spaceDown; }

const panState = { active: false, startX: 0, startY: 0, startL: 0, startT: 0, scrollEl: null };

function bindCanvasPan(scrollEl) {
  if (!scrollEl) return;
  scrollEl.addEventListener('mousedown', (ev) => {
    if (ev.button !== 1 && !(ev.button === 0 && isPanMode())) return;
    ev.preventDefault();
    panState.active = true;
    panState.scrollEl = scrollEl;
    panState.startX = ev.clientX; panState.startY = ev.clientY;
    panState.startL = scrollEl.scrollLeft; panState.startT = scrollEl.scrollTop;
    scrollEl.style.cursor = 'grabbing';
  });
  // Ctrl+滾輪縮放；沒按 Ctrl 就讓瀏覽器原生捲動（平移）照跑，不 preventDefault。
  scrollEl.addEventListener('wheel', (ev) => {
    if (!ev.ctrlKey) return;
    ev.preventDefault();
    zoomAt(ev.clientX, ev.clientY, ev.deltaY < 0 ? 1.1 : 1 / 1.1);
  }, { passive: false });
}

function initPanDocListeners() {
  if (panDocMoveHandler) return; // 只綁一次，避免每次 render 疊加
  panDocMoveHandler = (ev) => {
    if (!panState.active || !panState.scrollEl) return;
    panState.scrollEl.scrollLeft = panState.startL - (ev.clientX - panState.startX);
    panState.scrollEl.scrollTop = panState.startT - (ev.clientY - panState.startY);
  };
  panDocUpHandler = () => {
    if (!panState.active) return;
    panState.active = false;
    if (panState.scrollEl) panState.scrollEl.style.cursor = isPanMode() ? 'grab' : '';
  };
  document.addEventListener('mousemove', panDocMoveHandler);
  document.addEventListener('mouseup', panDocUpHandler);
}

// ── UID-29 全螢幕編輯 ───────────────────────────────────────────────────
// 修正（拖曳元件會掉出全螢幕）：原本把 Fullscreen API 目標指到 #uid-canvas-shell，但畫布的
// 任何互動（拖曳、選取、縮放）都會呼叫 render() 重建 container.innerHTML → 全螢幕的那顆節點
// 被移除 → 瀏覽器自動退出全螢幕。改法：Fullscreen API 只鎖 document.documentElement（永不被
// 重建），畫布是否「佔滿整個視窗」由 state.canvasFullscreen + 一個 fixed 覆蓋層 class 決定，
// 每次 render() 之後重新套用，所以 re-render 不會打斷全螢幕。
// 用 inline style 而非 Tailwind class：shell 原本就帶 bg-slate-50/50 這種半透明底色，
// 再疊一個 bg-slate-50 class 不保證蓋得過（CSS 勝出看的是規則順序不是 class 順序），
// 全螢幕時底下會透出東西；inline style 一定贏。
function applyCanvasFullscreenClass() {
  if (!container) return;
  const shell = container.querySelector('#uid-canvas-shell');
  if (!shell) return;
  if (state.canvasFullscreen) {
    shell.style.position = 'fixed';
    shell.style.inset = '0';
    shell.style.zIndex = '900';
    shell.style.background = document.documentElement.classList.contains('dark') ? '#0f172a' : '#f8fafc';
  } else {
    shell.style.position = '';
    shell.style.inset = '';
    shell.style.zIndex = '';
    shell.style.background = '';
  }
}

// 全螢幕會改變可視區大小，縮放與捲動位置都得跟著調整，否則畫框仍照小視窗的比例擺放：
// 進入時自動「符合視窗」（1920×1080 這種大畫框才會完整落在螢幕內、置中），離開時把進入前
// 的縮放與捲動位置原樣還原。等兩個 frame 再算，確保瀏覽器已完成全螢幕後的版面重排。
function captureCanvasView() {
  const scrollEl = container && container.querySelector('#uid-canvas-scroll');
  return { zoom: state.zoom || 1, left: scrollEl ? scrollEl.scrollLeft : 0, top: scrollEl ? scrollEl.scrollTop : 0 };
}

function restoreCanvasView(view) {
  if (!view) return;
  state.zoom = view.zoom;
  render();
  const scrollEl = container && container.querySelector('#uid-canvas-scroll');
  if (scrollEl) { scrollEl.scrollLeft = view.left; scrollEl.scrollTop = view.top; }
}

function afterViewportSettled(fn) {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

async function toggleCanvasFullscreen() {
  const shell = container && container.querySelector('#uid-canvas-shell');
  if (!shell) return;
  const entering = !state.canvasFullscreen;
  if (entering) state._preFsView = captureCanvasView();
  state.canvasFullscreen = entering;
  applyCanvasFullscreenClass();
  updateCanvasFullscreenIcon();
  if (entering) {
    afterViewportSettled(() => { if (state.canvasFullscreen) fitToWindow(); });
  } else {
    const view = state._preFsView; state._preFsView = null;
    afterViewportSettled(() => restoreCanvasView(view));
  }
  try {
    if (state.canvasFullscreen) {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    } else if (document.fullscreenElement === document.documentElement) {
      await document.exitFullscreen();
    }
  } catch (e) { /* 使用者拒絕或瀏覽器不支援：覆蓋層本身已是全視窗，視覺上等效 */ }
}

// 使用者用 Esc／F11 直接離開瀏覽器全螢幕時，把覆蓋層一起收掉，避免狀態不同步。
function onDocFullscreenChange() {
  if (!document.fullscreenElement && state.canvasFullscreen && !previewOverlay) {
    state.canvasFullscreen = false;
    applyCanvasFullscreenClass();
    const view = state._preFsView; state._preFsView = null;
    afterViewportSettled(() => restoreCanvasView(view));
  }
  updateCanvasFullscreenIcon();
}

function updateCanvasFullscreenIcon() {
  if (!container) return;
  const icon = container.querySelector('#uid-fullscreen-icon');
  if (!icon) return;
  icon.setAttribute('data-lucide', state.canvasFullscreen ? 'minimize' : 'maximize');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// ── UID-30 全螢幕預覽（唯讀）────────────────────────────────────────────
// 抽成共用的「唯讀渲染」函式：只畫畫框與元件實例本身，不含任何編輯介面（拖曳把手／吸附線／
// 格線／選取框／圖層面板），滑鼠不可拖動或選取元件。UID3 的可點擊原型播放之後直接在這份
// DOM 結構上掛「點擊→跳轉」，不需要另寫一套渲染邏輯（見 SPEC-ui-designer.md §7.1 分工說明）。
// UID9 UID-34：呈現切換的倍率——'dp'＝原樣（設計視角）；'device'＝乘上該畫面的密度倍率
// scale（裝置視角，讓指揮官看到同一份 dp 設計在實際 1x/2x/3x 螢幕上的相對大小）。px 畫面
// scale 恆為 1，兩種模式視覺上完全一樣（向後相容：舊畫面沒有 scale 欄位時視為 1）。
function presentScaleFor(screen) {
  if (state.presentMode !== 'device') return 1;
  return (screen && screen.scale) || 1;
}

// interactive=false（僅熱點編輯器 §7.5.3「明確不動」）維持 pointer-events:none——拖框取熱點的
// 前提是滑鼠事件穿透到底下的畫框，解鎖會讓拖曳收不到 mousedown。其餘播放/預覽路徑一律 interactive。
function renderReadOnlyElementsHtml(screen, presentScale, interactive) {
  const ps = presentScale || 1;
  const locked = interactive === false;
  const els = (screen.elements || []).slice().sort((a, b) => (a.z || 0) - (b.z || 0));
  return els.map(el =>
    '<div data-ro-wrap="' + el.id + '" style="position:absolute;left:' + (el.x * ps) + 'px;top:' + (el.y * ps) + 'px;width:' + (el.width * ps) + 'px;height:' + (el.height * ps) + 'px;">'
    + '<iframe data-ro-el="' + el.id + '" sandbox="allow-scripts" style="width:100%;height:100%;border:0;' + (locked ? 'pointer-events:none;' : '') + 'background:transparent;"></iframe>'
    + '</div>'
  ).join('');
}

function renderReadOnlyFrameHtml(screen, opts) {
  const scale = (opts && opts.scale) || 1;
  const presentScale = (opts && opts.presentScale) || 1;
  const interactive = !(opts && opts.interactive === false);
  const fw = Math.round(screen.frame.width * presentScale), fh = Math.round(screen.frame.height * presentScale);
  return '<div class="uid-ro-frame" data-frame-w="' + fw + '" data-frame-h="' + fh + '" style="position:relative;width:' + fw + 'px;height:' + fh + 'px;transform:scale(' + scale + ');transform-origin:top left;background:' + (canvasIsDark() ? '#0f172a' : '#fff') + ';box-shadow:0 0 0 1px rgba(0,0,0,.08),0 8px 24px rgba(0,0,0,.24);flex-shrink:0;">'
    + renderReadOnlyElementsHtml(screen, presentScale, interactive)
    + '</div>';
}

// UID16：opts.interactive!==false（預設）才注入橋接並更新 uidBridgeHandlerCtx，讓 postMessage
// 有地方回報；opts.onClick(el, msg, presentScale) / opts.onChange(el, msg, type) 由呼叫端依播放
// 面各自的規則決定「點了/改了要做什麼」（UID3 導覽、UID12 熱區前進……），這裡只負責轉發。
function fillReadOnlyFrames(root, screen, opts) {
  const interactive = !(opts && opts.interactive === false);
  root.querySelectorAll('[data-ro-el]').forEach(frame => {
    const elId = frame.getAttribute('data-ro-el');
    const el = (screen.elements || []).find(e => e.id === elId);
    const component = el && state.compCache[el.componentId];
    if (!el || !component) return;
    frame.srcdoc = buildRenderSrcdoc(component, elementValues(el, component), 'display:flex;align-items:center;justify-content:center;width:100%;height:100%;overflow:hidden;', canvasIsDark(), interactive ? el.id : null);
  });
  if (interactive) {
    uidBridgeHandlerCtx = {
      root, screen,
      presentScale: (opts && opts.presentScale) || 1,
      onClick: opts && opts.onClick,
      onChange: opts && opts.onChange
    };
  }
}

// 唯一的 message 監聽（mount() 掛一次）。驗證 event.source 真的是 uidBridgeHandlerCtx.root 底下
// 那顆 [data-ro-el] iframe 的 contentWindow，忽略其他來源，再依 type 分派給呼叫端給的 handler。
function onUidBridgeMessage(ev) {
  const msg = ev.data;
  if (!msg || msg.uidBridge !== true) return;
  const ctx = uidBridgeHandlerCtx;
  if (!ctx || !ctx.root || !ctx.root.isConnected) return;
  let frame = null;
  ctx.root.querySelectorAll('[data-ro-el]').forEach(f => { if (f.getAttribute('data-ro-el') === msg.elId) frame = f; });
  if (!frame || frame.contentWindow !== ev.source) return;
  const el = (ctx.screen.elements || []).find(e => e.id === msg.elId);
  if (!el) return;
  if (msg.type === 'click') { if (typeof ctx.onClick === 'function') ctx.onClick(el, msg, ctx.presentScale); }
  else if (msg.type === 'change' || msg.type === 'input') { if (typeof ctx.onChange === 'function') ctx.onChange(el, msg, msg.type); }
}

// ════════════════════════════════════════════════════════════════════════
// UID17 §7.5.2 D15：設計時指定的事件（navigate／toast／toggle）。
// 四個播放面（全螢幕預覽、UID3 可點擊原型、UID12 重播/簡報模式、UID13 離線匯出包，見下方各自
// 呼叫點）共用這一段判定與執行邏輯，不得各自重寫一份；離線匯出包因為是獨立的靜態 HTML，另在
// portal/uidesign.js 鏡射同一套邏輯（buildUidEventRuntimeScript），語意必須保持一致。
// ════════════════════════════════════════════════════════════════════════

// 缺 events 欄位＝沿用舊有 link 寫法（{on:'click',action:'navigate',target}），不回填、不改寫
// el.link 本身；有 events 就以 events 為準（UID-73）。
function elementEventsFor(el) {
  if (el.events && el.events.length) return el.events;
  if (el.link && el.link.targetScreenId) return [{ on: 'click', action: 'navigate', target: el.link.targetScreenId }];
  return [];
}

// ctx：{ wrapRoot（供 toast/toggle 在其中定位/尋找目標元件的容器）、
//        navigate(targetScreenId)（此播放面切換畫面用的函式；不支援導覽可省略/傳 null）、
//        suppressNavigate（true＝正在演示流程播放中，navigate 動作要被忽略且記一行 console，
//        §7.4.3／UID12 的「流程順序優先」規則） }
function runElementEvents(el, evtType, ctx) {
  const events = elementEventsFor(el).filter(e => e && e.on === evtType);
  events.forEach(e => {
    if (e.action === 'navigate') {
      if (ctx.suppressNavigate) { console.log('[UID17] 演示播放中，忽略元件 ' + el.id + ' 的 navigate 事件（流程順序優先，見 SPEC §7.4.3）'); return; }
      if (typeof ctx.navigate === 'function' && e.target) ctx.navigate(e.target);
    } else if (e.action === 'toast') {
      showUidToast(ctx.wrapRoot, e.message || '');
    } else if (e.action === 'toggle') {
      toggleUidTarget(ctx.wrapRoot, e.target);
    }
  });
}

// 浮動提示訊息（約 3 秒淡出）。深色文字＋不透明深底，不依賴底下畫面的主題，深/淺色底都看得清楚。
function showUidToast(wrapRoot, message) {
  if (!wrapRoot) return;
  const host = wrapRoot.querySelector('.uid-ro-frame') || wrapRoot;
  const toast = document.createElement('div');
  toast.className = 'uid-event-toast';
  toast.textContent = message || '';
  toast.style.cssText = 'position:absolute;left:50%;bottom:24px;transform:translateX(-50%);'
    + 'background:rgba(15,23,42,.94);color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;'
    + 'max-width:80%;text-align:center;white-space:pre-wrap;box-shadow:0 4px 16px rgba(0,0,0,.35);'
    + 'z-index:99999;pointer-events:none;opacity:1;transition:opacity .4s ease;';
  host.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; }, 2600);
  setTimeout(() => { toast.remove(); }, 3100);
}

// 切換同畫面另一個元件實例外層 wrap 的顯示/隱藏（data-ro-wrap，見 renderReadOnlyElementsHtml）。
function toggleUidTarget(wrapRoot, targetId) {
  if (!wrapRoot || !targetId) return;
  const wrap = wrapRoot.querySelector('[data-ro-wrap="' + targetId + '"]');
  if (!wrap) return;
  wrap.style.display = (wrap.style.display === 'none') ? '' : 'none';
}

function previewScaleFor(screen, availW, availH, presentScale) {
  const ps = presentScale || 1;
  const w = screen.frame.width * ps, h = screen.frame.height * ps;
  const z = Math.min(Math.max(50, availW) / w, Math.max(50, availH) / h);
  return Math.max(0.1, Math.min(3, z));
}

// 進入全螢幕（或視窗大小改變）後，用「實際的預覽區尺寸」重算比例，讓畫框真的貼齊可視區。
function fitPreviewScale() {
  if (!previewOverlay || !state.screen) return;
  const scrollEl = previewOverlay.querySelector('#uid-preview-scroll');
  const frame = previewOverlay.querySelector('.uid-ro-frame');
  const wrap = previewOverlay.querySelector('#uid-preview-wrap');
  if (!scrollEl || !frame || !wrap) return;
  const presentScale = presentScaleFor(state.screen);
  const scale = previewScaleFor(state.screen, scrollEl.clientWidth - 16, scrollEl.clientHeight - 16, presentScale);
  frame.style.transform = 'scale(' + scale + ')';
  // transform 不影響版面盒尺寸，外層要自己佔位，捲動與置中才會正確
  wrap.style.width = Math.round(state.screen.frame.width * presentScale * scale) + 'px';
  wrap.style.height = Math.round(state.screen.frame.height * presentScale * scale) + 'px';
}

// UID-34：切換「以 dp 呈現」／「以實際解析度呈現」，只在全螢幕預覽/播放疊層開著時呼叫。
function togglePresentMode(mode) {
  state.presentMode = mode;
  if (previewOverlay) refreshPreviewOverlay();
  if (playOverlay && playState) renderPlayScreen(playState.currentId, { push: false });
}

// 呈現模式切換鈕（只在 unit==='dp' 的畫面顯示，見呼叫端判斷）。
function renderPresentToggleHtml() {
  const cell = (mode, label) => '<button data-uid-present="' + mode + '" class="px-2 py-1 rounded text-[11px] font-semibold ' +
    (state.presentMode === mode ? 'bg-cyan-500 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-200') + '">' + label + '</button>';
  return '<div class="flex items-center gap-1">' + cell('dp', 'dp 呈現') + cell('device', '實際解析度') + '</div>';
}

function bindPresentToggle(root) {
  root.querySelectorAll('[data-uid-present]').forEach(b => b.addEventListener('click', () => togglePresentMode(b.getAttribute('data-uid-present'))));
}

// UID17：全螢幕預覽本來是純看版（不含跳轉），現在與其它三個播放面一樣改用共用的事件執行邏輯
// （runElementEvents），元件若設了 navigate/toast/toggle 一律可用。navigatePreviewTo 讓預覽也能
// 跳轉到別的畫面，跳轉後 previewScreenId 記住「目前預覽的是哪張」，供 refreshPreviewOverlay
// （呈現模式切換用）重繪同一張，而不是每次都退回 state.screen（編輯器目前開啟的那張）。
function previewOnClick(wrap) {
  return (el) => runElementEvents(el, 'click', { wrapRoot: wrap, navigate: navigatePreviewTo });
}
function previewOnChange(wrap) {
  return (el, msg, type) => runElementEvents(el, type, { wrapRoot: wrap, navigate: navigatePreviewTo });
}

// 重繪全螢幕預覽疊層本身（不是整個 view 的 render()）——用於呈現模式切換時，不必重新進出全螢幕。
async function refreshPreviewOverlay() {
  if (!previewOverlay) return;
  const id = previewScreenId || (state.screen && state.screen.id);
  if (!id) return;
  const screen = (state.screen && state.screen.id === id) ? state.screen : await fetchScreenForPlay(id);
  if (!screen || !previewOverlay) return;
  paintPreviewFrame(screen);
}

// 導覽到別的畫面（navigate 事件的執行）：抓資料、記住目前預覽的是哪張、重繪。
async function navigatePreviewTo(targetId) {
  if (!previewOverlay || !targetId) return;
  const screen = await fetchScreenForPlay(targetId);
  if (!screen || !previewOverlay) return;
  previewScreenId = targetId;
  paintPreviewFrame(screen);
}

function paintPreviewFrame(screen) {
  if (!previewOverlay) return;
  const wrap = previewOverlay.querySelector('#uid-preview-wrap');
  if (!wrap) return;
  const scrollEl = previewOverlay.querySelector('#uid-preview-scroll');
  const presentScale = presentScaleFor(screen);
  const scale = previewScaleFor(screen, (scrollEl ? scrollEl.clientWidth : window.innerWidth) - 16, (scrollEl ? scrollEl.clientHeight : window.innerHeight) - 16, presentScale);
  wrap.innerHTML = renderReadOnlyFrameHtml(screen, { scale, presentScale });
  wrap.style.width = Math.round(screen.frame.width * presentScale * scale) + 'px';
  wrap.style.height = Math.round(screen.frame.height * presentScale * scale) + 'px';
  fillReadOnlyFrames(wrap, screen, { presentScale, onClick: previewOnClick(wrap), onChange: previewOnChange(wrap) });
  const titleEl = previewOverlay.querySelector('#uid-preview-title');
  if (titleEl) titleEl.textContent = '全螢幕預覽（唯讀）－ ' + screen.name;
  const toggle = previewOverlay.querySelector('#uid-preview-present-toggle');
  if (toggle) { toggle.innerHTML = screen.unit === 'dp' ? renderPresentToggleHtml() : ''; bindPresentToggle(toggle); }
}

async function enterPreviewFullscreen() {
  if (!state.screen || previewOverlay) return;
  const screen = state.screen;
  previewScreenId = screen.id;
  const presentScale = presentScaleFor(screen);
  // 初始比例先用目前視窗算，進入全螢幕後版面會變大，再用實際容器尺寸重算一次（見
  // fitPreviewScale）——否則會照「進入前的小視窗」縮放，全螢幕下四周留白、不滿版。
  let scale = previewScaleFor(screen, window.innerWidth - 64, window.innerHeight - 120, presentScale);
  const overlay = document.createElement('div');
  overlay.id = 'uid-preview-overlay';
  overlay.className = 'fixed inset-0 z-[999] bg-slate-900/95 flex flex-col';
  overlay.innerHTML = ''
    + '<div class="flex items-center justify-between px-4 py-2.5 flex-shrink-0">'
    + '  <span id="uid-preview-title" class="text-xs text-slate-300">全螢幕預覽（唯讀）－ ' + esc(screen.name) + '</span>'
    + '  <div class="flex items-center gap-2">'
    + (screen.unit === 'dp' ? ('<div id="uid-preview-present-toggle">' + renderPresentToggleHtml() + '</div>') : '')
    + '  <button id="uid-preview-close" class="px-2.5 py-1 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs">關閉（Esc）</button>'
    + '</div>'
    // 置中用 margin:auto（同畫布）：flex 置中在內容大於容器時會把左上角推出可視區且捲不回去。
    + '<div id="uid-preview-scroll" class="flex-1 overflow-auto">'
    + '  <div id="uid-preview-wrap" style="margin:auto;width:fit-content;">'
    + renderReadOnlyFrameHtml(screen, { scale, presentScale })
    + '  </div>'
    + '</div>';
  document.body.appendChild(overlay);
  previewOverlay = overlay;
  fillReadOnlyFrames(overlay, screen, { presentScale, onClick: previewOnClick(overlay), onChange: previewOnChange(overlay) });
  bindPresentToggle(overlay);
  overlay.querySelector('#uid-preview-close').addEventListener('click', exitPreviewFullscreen);
  previewKeyHandler = (ev) => { if (ev.key === 'Escape') exitPreviewFullscreen(); };
  document.addEventListener('keydown', previewKeyHandler);
  previewFullscreenHandler = () => { if (!document.fullscreenElement && previewOverlay) exitPreviewFullscreen(); };
  document.addEventListener('fullscreenchange', previewFullscreenHandler);
  try { await overlay.requestFullscreen(); } catch (e) { /* Headless/自動化環境可能不支援，overlay 本身已是 fixed 全版面覆蓋，視覺上等效 */ }
  afterViewportSettled(fitPreviewScale);
  previewResizeHandler = () => fitPreviewScale();
  window.addEventListener('resize', previewResizeHandler);
}

function exitPreviewFullscreen() {
  if (!previewOverlay) return;
  if (document.fullscreenElement && document.fullscreenElement === previewOverlay) {
    try { document.exitFullscreen(); } catch (e) {}
  }
  if (previewKeyHandler) { document.removeEventListener('keydown', previewKeyHandler); previewKeyHandler = null; }
  if (previewFullscreenHandler) { document.removeEventListener('fullscreenchange', previewFullscreenHandler); previewFullscreenHandler = null; }
  if (previewResizeHandler) { window.removeEventListener('resize', previewResizeHandler); previewResizeHandler = null; }
  previewOverlay.remove();
  previewOverlay = null;
  previewScreenId = null;
  // 從「全螢幕編輯」進來看預覽的情況：關掉預覽後把瀏覽器全螢幕接回去，覆蓋層本來就還在
  if (state.canvasFullscreen && !document.fullscreenElement) {
    try { document.documentElement.requestFullscreen(); } catch (e) {}
  }
}

// ── UID3 可點擊原型播放模式 ──────────────────────────────────────────────
// D5：第一版只做「點擊 → 前往某畫面」＋ hover/按下的視覺回饋，不做狀態邏輯（表單值/顯示隱藏/
// 條件）。直接沿用 UID8 抽出的唯讀渲染鏈（renderReadOnlyFrameHtml / fillReadOnlyFrames），只在
// 其上多綁一層 click 事件；不重寫另一套渲染邏輯（見 renderReadOnlyElementsHtml 上方註解）。
// 播放模式與「全螢幕預覽（唯讀）」是兩個獨立入口——預覽是靜態看版，播放模式才可操作/可跳轉。

// 取得任一畫面的完整資料（含元件實例）＋確保用到的元件都已快取，供播放模式跳轉到「目前編輯器
// 沒開啟過」的畫面時使用（editor 的 state.compCache 只保證當前開啟的畫面已載入元件）。
async function fetchScreenForPlay(id) {
  try {
    const r = await api('/api/ui/screens/' + encodeURIComponent(id));
    if (!r.ok) return null;
    const screen = await r.json();
    const ids = Array.from(new Set((screen.elements || []).map(el => el.componentId)));
    await Promise.all(ids.map(ensureComponentCached));
    return screen;
  } catch (e) { return null; }
}

async function enterPlayMode() {
  if (!state.screen || playOverlay) return;
  playState = { currentId: state.screen.id, screen: state.screen, historyIds: [], startId: state.screen.id };
  const overlay = document.createElement('div');
  overlay.id = 'uid-play-overlay';
  overlay.className = 'fixed inset-0 z-[999] bg-slate-900/95 flex flex-col';
  overlay.innerHTML = ''
    // hover／按下的視覺回饋：只對有掛跳轉連結的元件套用（bindPlayClicks 才會加這個 class）。
    + '<style>.uid-play-hit{cursor:pointer;transition:outline-color .12s,transform .05s;}'
    + '.uid-play-hit:hover{outline:2px solid rgba(6,182,212,.65);outline-offset:2px;}'
    + '.uid-play-hit:active{transform:scale(0.97);}</style>'
    + '<div class="flex items-center justify-between px-4 py-2.5 flex-shrink-0">'
    + '  <span id="uid-play-title" class="text-xs text-slate-300">播放原型</span>'
    + '  <div class="flex items-center gap-1.5">'
    + '    <div id="uid-play-present-toggle"></div>'
    + '    <button id="uid-play-back" disabled class="px-2.5 py-1 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-slate-700">← 上一頁</button>'
    + '    <button id="uid-play-reset" class="px-2.5 py-1 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs">重置</button>'
    + '    <button id="uid-play-close" class="px-2.5 py-1 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs">關閉（Esc）</button>'
    + '  </div>'
    + '</div>'
    // 置中同樣用 margin:auto（不可用 flex justify-center，見畫布/預覽同一個註解的理由）。
    + '<div id="uid-play-scroll" class="flex-1 overflow-auto">'
    + '  <div id="uid-play-wrap" style="margin:auto;width:fit-content;"></div>'
    + '</div>';
  document.body.appendChild(overlay);
  playOverlay = overlay;
  overlay.querySelector('#uid-play-close').addEventListener('click', exitPlayMode);
  overlay.querySelector('#uid-play-back').addEventListener('click', playGoBack);
  overlay.querySelector('#uid-play-reset').addEventListener('click', playReset);
  playKeyHandler = (ev) => { if (ev.key === 'Escape') exitPlayMode(); };
  document.addEventListener('keydown', playKeyHandler);
  playFullscreenHandler = () => { if (!document.fullscreenElement && playOverlay) exitPlayMode(); };
  document.addEventListener('fullscreenchange', playFullscreenHandler);
  try { await overlay.requestFullscreen(); } catch (e) { /* Headless/自動化環境可能不支援，overlay 本身已是 fixed 全版面覆蓋，視覺上等效 */ }
  await renderPlayScreen(state.screen.id, { push: false });
  playResizeHandler = () => fitPlayScale();
  window.addEventListener('resize', playResizeHandler);
}

// 切到某張畫面播放；push=true 時把「切換前那張」記進上一頁歷史（reset/回退時 push=false）。
async function renderPlayScreen(id, opts) {
  if (!playOverlay || !playState) return;
  const screen = await fetchScreenForPlay(id);
  if (!screen || !playOverlay) return; // 使用者可能在等待期間已關閉播放模式
  if (opts && opts.push && playState.currentId) playState.historyIds.push(playState.currentId);
  playState.currentId = id;
  playState.screen = screen;
  const scrollEl = playOverlay.querySelector('#uid-play-scroll');
  const wrap = playOverlay.querySelector('#uid-play-wrap');
  if (!scrollEl || !wrap) return;
  const presentScale = presentScaleFor(screen);
  const scale = previewScaleFor(screen, scrollEl.clientWidth - 16, scrollEl.clientHeight - 16, presentScale);
  wrap.innerHTML = renderReadOnlyFrameHtml(screen, { scale, presentScale });
  wrap.style.width = Math.round(screen.frame.width * presentScale * scale) + 'px';
  wrap.style.height = Math.round(screen.frame.height * presentScale * scale) + 'px';
  // UID16：導覽改由橋接的 click 回報觸發（iframe 解鎖 pointer-events 後，點擊落在 iframe
  // 內就不會再冒泡到 wrap 的 click 監聽，bindPlayClicks 現在只負責 hover 樣式，不重掛 click）。
  // UID17：navigate/toast/toggle 一律走共用的 runElementEvents（含 UID3 舊有的 link 退化寫法）。
  const playNavigate = (targetId) => renderPlayScreen(targetId, { push: true });
  fillReadOnlyFrames(wrap, screen, { presentScale,
    onClick: (el) => runElementEvents(el, 'click', { wrapRoot: wrap, navigate: playNavigate }),
    onChange: (el, msg, type) => runElementEvents(el, type, { wrapRoot: wrap, navigate: playNavigate })
  });
  bindPlayClicks(wrap, screen);
  const title = playOverlay.querySelector('#uid-play-title');
  if (title) title.textContent = '播放原型－' + screen.name;
  const backBtn = playOverlay.querySelector('#uid-play-back');
  if (backBtn) backBtn.disabled = !playState.historyIds.length;
  const toggle = playOverlay.querySelector('#uid-play-present-toggle');
  if (toggle) {
    toggle.innerHTML = screen.unit === 'dp' ? renderPresentToggleHtml() : '';
    bindPresentToggle(toggle);
  }
}

// 只在有掛「點擊跳轉」的元件上加可點擊樣式（hover outline／按下縮放，見 enterPlayMode 的
// .uid-play-hit 樣式）。UID16 之前這裡還會掛 click 監聽觸發跳轉；解鎖 iframe 後點擊會被
// iframe 自己吃掉、不冒泡到這層，真正的跳轉改由 fillReadOnlyFrames 的 onClick 橋接回報處理
// （見 renderPlayScreen），這裡只剩樣式標記，避免兩套邏輯重複觸發同一次跳轉。
function bindPlayClicks(root, screen) {
  root.querySelectorAll('[data-ro-wrap]').forEach(wrap => {
    const elId = wrap.getAttribute('data-ro-wrap');
    const el = (screen.elements || []).find(e => e.id === elId);
    // UID17：有任何 click 事件（navigate/toast/toggle，或退化的 link）都算「按了會有事」，一律套用視覺回饋。
    const hasClickEvent = el && elementEventsFor(el).some(e => e.on === 'click');
    if (!hasClickEvent) return;
    wrap.classList.add('uid-play-hit');
  });
}

function playGoBack() {
  if (!playState || !playState.historyIds.length) return;
  const prev = playState.historyIds.pop();
  renderPlayScreen(prev, { push: false });
}

function playReset() {
  if (!playState) return;
  playState.historyIds = [];
  renderPlayScreen(playState.startId, { push: false });
}

// 視窗大小改變時，依目前畫面重新計算縮放比例（不切換畫面、不動歷史）。
function fitPlayScale() {
  if (!playOverlay || !playState || !playState.screen) return;
  const scrollEl = playOverlay.querySelector('#uid-play-scroll');
  const wrap = playOverlay.querySelector('#uid-play-wrap');
  const frame = playOverlay.querySelector('.uid-ro-frame');
  if (!scrollEl || !wrap || !frame) return;
  const presentScale = presentScaleFor(playState.screen);
  const scale = previewScaleFor(playState.screen, scrollEl.clientWidth - 16, scrollEl.clientHeight - 16, presentScale);
  frame.style.transform = 'scale(' + scale + ')';
  wrap.style.width = Math.round(playState.screen.frame.width * presentScale * scale) + 'px';
  wrap.style.height = Math.round(playState.screen.frame.height * presentScale * scale) + 'px';
}

function exitPlayMode() {
  if (!playOverlay) return;
  if (document.fullscreenElement && document.fullscreenElement === playOverlay) {
    try { document.exitFullscreen(); } catch (e) {}
  }
  if (playKeyHandler) { document.removeEventListener('keydown', playKeyHandler); playKeyHandler = null; }
  if (playFullscreenHandler) { document.removeEventListener('fullscreenchange', playFullscreenHandler); playFullscreenHandler = null; }
  if (playResizeHandler) { window.removeEventListener('resize', playResizeHandler); playResizeHandler = null; }
  playOverlay.remove();
  playOverlay = null;
  playState = null;
  // 從「全螢幕編輯」進來播放的情況：關掉播放後把瀏覽器全螢幕接回去（同 exitPreviewFullscreen）。
  if (state.canvasFullscreen && !document.fullscreenElement) {
    try { document.documentElement.requestFullscreen(); } catch (e) {}
  }
}

// ── 畫布互動：拖放新增、拖曳移動、把手縮放、多選、對齊吸附 ─────────────────

function frameEl() { return container.querySelector('#uid-canvas-frame'); }

function snapCandidatesX() {
  const s = state.screen;
  const xs = [0, Math.round(s.frame.width / 2), s.frame.width];
  (s.elements || []).forEach(el => {
    if (state.selection.indexOf(el.id) !== -1) return;
    xs.push(el.x, el.x + el.width / 2, el.x + el.width);
  });
  return xs;
}
function snapCandidatesY() {
  const s = state.screen;
  const ys = [0, Math.round(s.frame.height / 2), s.frame.height];
  (s.elements || []).forEach(el => {
    if (state.selection.indexOf(el.id) !== -1) return;
    ys.push(el.y, el.y + el.height / 2, el.y + el.height);
  });
  return ys;
}

function snapValue(value, candidates) {
  let best = value, bestDist = SNAP_THRESHOLD + 1;
  candidates.forEach(c => { const d = Math.abs(c - value); if (d < bestDist) { bestDist = d; best = c; } });
  if (bestDist <= SNAP_THRESHOLD) return best;
  // 沒對到別的元素/畫框，退回格線吸附
  return Math.round(value / GRID) * GRID;
}

function setSelection(ids) {
  state.selection = ids;
  render();
}

function bindElementDrag(wrap, elId) {
  wrap.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return; // 中鍵留給平移，右鍵留給瀏覽器選單
    if (isPanMode()) return; // 平移模式（手掌工具或按住空白鍵）優先，讓事件冒泡給 scroll 容器
    if (ev.target.closest('[data-handle]')) return; // 交給 resize handler
    ev.preventDefault();
    ev.stopPropagation();
    const undoSnapshot = beginUndoSnapshot(); // UID-25：拖曳開始拍一次快照，放開且真的動了才推入
    const additive = ev.shiftKey;
    let selection;
    if (additive) {
      selection = state.selection.indexOf(elId) !== -1 ? state.selection.filter(id => id !== elId) : state.selection.concat([elId]);
    } else if (state.selection.indexOf(elId) === -1) {
      selection = [elId];
    } else {
      selection = state.selection;
    }
    state.selection = selection;
    render();
    if (!selection.length) return;
    const startX = ev.clientX, startY = ev.clientY;
    const orig = selection.map(id => {
      const el = state.screen.elements.find(e => e.id === id);
      return { id, x: el.x, y: el.y };
    });
    const primary = orig.find(o => o.id === elId) || orig[0];
    const primaryEl = state.screen.elements.find(e => e.id === primary.id);
    let moved = false;
    function onMove(mv) {
      const dx = (mv.clientX - startX) / state.zoom;
      const dy = (mv.clientY - startY) / state.zoom;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) moved = true;
      const rawX = primary.x + dx, rawY = primary.y + dy;
      const snapX = snapValue(rawX, snapCandidatesX().concat(snapCandidatesX().map(c => c - primaryEl.width / 2 * 0)));
      const snapY = snapValue(rawY, snapCandidatesY());
      const adjustDx = snapX - primary.x, adjustDy = snapY - primary.y;
      orig.forEach(o => {
        const el = state.screen.elements.find(e => e.id === o.id);
        if (!el) return;
        el.x = Math.max(0, Math.round(o.x + adjustDx));
        el.y = Math.max(0, Math.round(o.y + adjustDy));
        const f = container.querySelector('.uid-el-wrap[data-el-wrap="' + o.id + '"]');
        if (f) { f.style.left = el.x + 'px'; f.style.top = el.y + 'px'; }
      });
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (moved) { commitUndoSnapshot(undoSnapshot); scheduleSave(); render(); }
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function bindResizeHandle(handleEl, elId, handle) {
  handleEl.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const el = state.screen.elements.find(e => e.id === elId);
    if (!el) return;
    const undoSnapshot = beginUndoSnapshot(); // UID-25：縮放開始拍一次快照，合併成一步
    let resized = false;
    const start = { x: el.x, y: el.y, w: el.width, h: el.height };
    const startX = ev.clientX, startY = ev.clientY;
    function onMove(mv) {
      const dx = (mv.clientX - startX) / state.zoom;
      const dy = (mv.clientY - startY) / state.zoom;
      let { x, y, w, h } = start;
      if (handle.indexOf('e') !== -1) w = Math.max(20, start.w + dx);
      if (handle.indexOf('s') !== -1) h = Math.max(20, start.h + dy);
      if (handle.indexOf('w') !== -1) { w = Math.max(20, start.w - dx); x = start.x + (start.w - w); }
      if (handle.indexOf('n') !== -1) { h = Math.max(20, start.h - dy); y = start.y + (start.h - h); }
      w = Math.round(w / GRID) * GRID; h = Math.round(h / GRID) * GRID;
      x = Math.round(x); y = Math.round(y);
      if (x !== el.x || y !== el.y || w !== el.width || h !== el.height) resized = true;
      el.x = x; el.y = y; el.width = w; el.height = h;
      const wrap = container.querySelector('.uid-el-wrap[data-el-wrap="' + elId + '"]');
      if (wrap) { wrap.style.left = x + 'px'; wrap.style.top = y + 'px'; wrap.style.width = w + 'px'; wrap.style.height = h + 'px'; }
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (resized) { commitUndoSnapshot(undoSnapshot); scheduleSave(); render(); }
      else refreshElementFrame(elId);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function bindCanvasMarquee(frame) {
  frame.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return; // 中鍵留給平移
    if (isPanMode()) return; // 平移模式優先，讓事件冒泡給 scroll 容器去平移
    if (ev.target.closest('[data-el-wrap]')) return;
    const rect = frame.getBoundingClientRect();
    const startX = (ev.clientX - rect.left) / state.zoom, startY = (ev.clientY - rect.top) / state.zoom;
    const box = document.createElement('div');
    box.style.cssText = 'position:absolute;border:1px dashed #0891b2;background:rgba(8,145,178,0.08);pointer-events:none;';
    frame.appendChild(box);
    if (!ev.shiftKey) { state.selection = []; }
    function onMove(mv) {
      const x2 = (mv.clientX - rect.left) / state.zoom, y2 = (mv.clientY - rect.top) / state.zoom;
      const x = Math.min(startX, x2), y = Math.min(startY, y2), w = Math.abs(x2 - startX), h = Math.abs(y2 - startY);
      box.style.left = x + 'px'; box.style.top = y + 'px'; box.style.width = w + 'px'; box.style.height = h + 'px';
      const sel = (state.screen.elements || []).filter(el =>
        el.x < x + w && el.x + el.width > x && el.y < y + h && el.y + el.height > y
      ).map(el => el.id);
      state.selection = sel;
      container.querySelectorAll('.uid-el-wrap').forEach(w2 => {
        const id = w2.getAttribute('data-el-wrap');
        w2.style.outline = sel.indexOf(id) !== -1 ? '2px solid #0891b2' : '1px dashed transparent';
      });
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      box.remove();
      render();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function bindPaletteDrag() {
  container.querySelectorAll('[data-drag-comp]').forEach(el => {
    el.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.setData('text/plain', el.getAttribute('data-drag-comp'));
      ev.dataTransfer.effectAllowed = 'copy';
    });
  });
  const scrollWrap = container.querySelector('#uid-canvas-scroll');
  if (!scrollWrap) return;
  scrollWrap.addEventListener('dragover', (ev) => { if (state.screen) ev.preventDefault(); });
  scrollWrap.addEventListener('drop', async (ev) => {
    if (!state.screen) return;
    const componentId = ev.dataTransfer.getData('text/plain');
    if (!componentId) return;
    ev.preventDefault();
    const frame = frameEl();
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    let x = (ev.clientX - rect.left) / state.zoom, y = (ev.clientY - rect.top) / state.zoom;
    x = Math.max(0, Math.round(x / GRID) * GRID);
    y = Math.max(0, Math.round(y / GRID) * GRID);
    const comp = await ensureComponentCached(componentId);
    if (!comp) return;
    pushUndo(); // UID-25：新增元件入棧
    const maxZ = Math.max(0, ...((state.screen.elements || []).map(e => e.z || 0)));
    const newEl = {
      id: uid(), componentId, x, y, width: 200, height: 56, z: maxZ + 1,
      variantIndex: 0, overrides: {}, link: { targetScreenId: null }
    };
    state.screen.elements = (state.screen.elements || []).concat([newEl]);
    state.selection = [newEl.id];
    scheduleSave();
    render();
  });
}

function bindLayerEvents() {
  container.querySelectorAll('[data-layer]').forEach(row => {
    row.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-layer-up],[data-layer-down]')) return;
      setSelection([row.getAttribute('data-layer')]);
    });
  });
  container.querySelectorAll('[data-layer-up]').forEach(btn => btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    reorderLayer(btn.getAttribute('data-layer-up'), 1);
  }));
  container.querySelectorAll('[data-layer-down]').forEach(btn => btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    reorderLayer(btn.getAttribute('data-layer-down'), -1);
  }));
}

function reorderLayer(elId, dir) {
  const els = state.screen.elements || [];
  const sorted = els.slice().sort((a, b) => (a.z || 0) - (b.z || 0));
  const idx = sorted.findIndex(e => e.id === elId);
  const swapIdx = idx + (dir > 0 ? 1 : -1);
  if (idx === -1 || swapIdx < 0 || swapIdx >= sorted.length) return;
  pushUndo(); // UID-25：圖層調序入棧
  const za = sorted[idx].z, zb = sorted[swapIdx].z;
  sorted[idx].z = zb; sorted[swapIdx].z = za;
  scheduleSave();
  render();
}

function bindPropertyEvents() {
  if (!state.screen) return;
  // UID-37：多選批次標記角色——先處理，跟單選屬性面板互斥（多選時只渲染這顆按鈕）。
  if (state.selection.length > 1) {
    const applyBtn = container.querySelector('#uid-batch-role-apply');
    if (applyBtn) applyBtn.addEventListener('click', () => {
      const roleSel = container.querySelector('#uid-batch-role');
      const role = roleSel ? roleSel.value : '';
      if (!role) { alert('請先選一個角色再套用'); return; }
      pushUndo(); // UID-25：批次標記入棧
      state.screen.elements.forEach(e => { if (state.selection.indexOf(e.id) !== -1) e.role = role; });
      scheduleSave();
      render();
    });
    return;
  }
  if (state.selection.length !== 1) return;
  const el = state.screen.elements.find(e => e.id === state.selection[0]);
  if (!el) return;
  container.querySelectorAll('[data-geo]').forEach(inp => inp.addEventListener('change', () => {
    const key = inp.getAttribute('data-geo');
    const v = Math.max(key === 'width' || key === 'height' ? 20 : 0, parseInt(inp.value, 10) || 0);
    if (v === el[key]) return; // 沒真的改變，不要空推一筆 undo
    pushUndo(); // UID-25：改尺寸/位置入棧
    el[key] = v;
    scheduleSave();
    render();
  }));
  const variantSel = container.querySelector('[data-el-variant]');
  if (variantSel) variantSel.addEventListener('change', () => {
    pushUndo(); // UID-25：換變體入棧
    el.variantIndex = parseInt(variantSel.value, 10) || 0;
    scheduleSave();
    refreshElementFrame(el.id);
  });
  // UID-25：文字覆寫是連續輸入（每個字都會觸發 input），只在這次編輯 session 的第一個字推一筆
  // undo，之後的字合併成同一步；聚焦（focus）時重置旗標，代表開始新的一次編輯。
  container.querySelectorAll('[data-override]').forEach(inp => {
    let pushed = false;
    inp.addEventListener('focus', () => { pushed = false; });
    inp.addEventListener('input', () => {
      if (!pushed) { pushUndo(); pushed = true; }
      el.overrides = el.overrides || {};
      el.overrides[inp.getAttribute('data-override')] = inp.value;
      scheduleSave();
      refreshElementFrame(el.id);
    });
  });
  const linkSel = container.querySelector('[data-el-link]');
  if (linkSel) linkSel.addEventListener('change', () => {
    el.link = { targetScreenId: linkSel.value || null };
    scheduleSave();
  });
  // UID17：事件列——新增/刪除/改觸發時機/改動作(需要 render() 重畫目標欄位)/改目標/改訊息。
  // 沿用既有屬性面板慣例：這類下拉/文字變更不入 undo 堆疊（比照 link/role/slot）。
  container.querySelectorAll('[data-event-on]').forEach(sel => sel.addEventListener('change', () => {
    const idx = parseInt(sel.getAttribute('data-event-on'), 10);
    if (el.events && el.events[idx]) { el.events[idx].on = sel.value; scheduleSave(); }
  }));
  container.querySelectorAll('[data-event-action]').forEach(sel => sel.addEventListener('change', () => {
    const idx = parseInt(sel.getAttribute('data-event-action'), 10);
    if (el.events && el.events[idx]) { el.events[idx].action = sel.value; scheduleSave(); render(); }
  }));
  container.querySelectorAll('[data-event-target]').forEach(sel => sel.addEventListener('change', () => {
    const idx = parseInt(sel.getAttribute('data-event-target'), 10);
    if (el.events && el.events[idx]) { el.events[idx].target = sel.value || null; scheduleSave(); }
  }));
  container.querySelectorAll('[data-event-message]').forEach(inp => inp.addEventListener('input', () => {
    const idx = parseInt(inp.getAttribute('data-event-message'), 10);
    if (el.events && el.events[idx]) { el.events[idx].message = inp.value; scheduleSave(); }
  }));
  container.querySelectorAll('[data-event-del]').forEach(btn => btn.addEventListener('click', () => {
    const idx = parseInt(btn.getAttribute('data-event-del'), 10);
    el.events = (el.events || []).filter((_, i) => i !== idx);
    scheduleSave();
    render();
  }));
  const eventAddBtn = container.querySelector('#uid-el-event-add');
  if (eventAddBtn) eventAddBtn.addEventListener('click', () => {
    el.events = el.events || [];
    el.events.push({ on: 'click', action: 'navigate', target: null });
    scheduleSave();
    render();
  });
  // UID10 UID-37：role/slot 標記。
  const roleSel = container.querySelector('#uid-el-role');
  if (roleSel) roleSel.addEventListener('change', () => {
    el.role = roleSel.value || undefined;
    scheduleSave();
    render();
  });
  const slotInp = container.querySelector('[data-el-slot]');
  if (slotInp) slotInp.addEventListener('change', () => {
    el.slot = slotInp.value.trim() || undefined;
    scheduleSave();
  });
  const delBtn = container.querySelector('[data-el-delete]');
  if (delBtn) delBtn.addEventListener('click', () => {
    pushUndo(); // UID-25：刪除入棧
    state.screen.elements = state.screen.elements.filter(e => e.id !== el.id);
    state.selection = [];
    scheduleSave();
    render();
  });
}

// UID8：復原/重做快捷鍵、空白鍵平移、刪除，三者共用同一個 keydown 監聽（比照白板：只在
// canvas 分頁、且焦點不在輸入框時才攔截，避免打字時誤觸發或吃掉輸入框自己的原生 Ctrl+Z）。
function bindCanvasKeys() {
  if (state._keyBound) return;
  state._keyBound = true;
  document.addEventListener('keydown', (ev) => {
    if (state.mode !== 'canvas' || !state.screen) return;
    const tag = (document.activeElement && document.activeElement.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && !ev.shiftKey && ev.key.toLowerCase() === 'z') { ev.preventDefault(); undo(); return; }
    if (mod && (ev.key.toLowerCase() === 'y' || (ev.shiftKey && ev.key.toLowerCase() === 'z'))) { ev.preventDefault(); redo(); return; }
    if (ev.code === 'Space' && !state._spaceDown) { state._spaceDown = true; setPanCursor(true); }
    if (ev.key === 'v' || ev.key === 'V') { setTool('select'); return; }
    if (ev.key === 'h' || ev.key === 'H') { setTool('pan'); return; }
    if (!state.selection.length) return;
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      ev.preventDefault();
      pushUndo(); // UID-25：刪除入棧
      state.screen.elements = state.screen.elements.filter(e => state.selection.indexOf(e.id) === -1);
      state.selection = [];
      scheduleSave();
      render();
    }
  });
  document.addEventListener('keyup', (ev) => {
    if (ev.code === 'Space') { state._spaceDown = false; setPanCursor(isPanMode()); }
  });
}

function setPanCursor(active) {
  const scrollEl = container && container.querySelector('#uid-canvas-scroll');
  if (scrollEl) scrollEl.style.cursor = active ? 'grab' : '';
}

function setTool(tool) {
  if (state.tool === tool) return;
  state.tool = tool;
  render();
}

function renderElementFramesAll() {
  container.querySelectorAll('.uid-el-frame').forEach(frame => {
    const elId = frame.getAttribute('data-el');
    refreshElementFrame(elId);
  });
}

function bindCanvasEvents() {
  container.querySelectorAll('.uid-el-wrap').forEach(wrap => {
    const elId = wrap.getAttribute('data-el-wrap');
    bindElementDrag(wrap, elId);
    wrap.querySelectorAll('[data-handle]').forEach(h => bindResizeHandle(h, elId, h.getAttribute('data-handle')));
  });
  const frame = frameEl();
  if (frame) bindCanvasMarquee(frame);
  bindCanvasPan(container.querySelector('#uid-canvas-scroll'));
  bindPaletteDrag();
  bindLayerEvents();
  bindPropertyEvents();
  bindCanvasKeys();
  renderElementFramesAll();
}

// ════════════════════════════════════════════════════════════════════════
// UID12 情境流程（Scenario Flows，SPEC-ui-designer.md §7.4，TASK.md UID-46～50/UID-55）
// 與元件庫／畫面／範本並列的第四種資料：一條流程＝有順序的步驟，每步一張既有畫面＋一句操作
// 說明。第一版採清單式建立（不做錄製）。重播／簡報模式沿用 UID8 抽出的唯讀渲染鏈
// （renderReadOnlyFrameHtml/fillReadOnlyFrames/previewScaleFor/presentScaleFor），不自寫第二套。
// ════════════════════════════════════════════════════════════════════════

async function loadFlows() {
  state.flowsLoading = true;
  render();
  try {
    const r = await api('/api/ui/flows');
    state.flows = await r.json();
  } catch (e) { state.flows = []; }
  state.flowsLoading = false;
  render();
}

async function selectFlow(id) {
  state.flowId = id;
  state.flow = null;
  state.flowPlay = null;
  state.hotspotStepIdx = null;
  render();
  try {
    const r = await api('/api/ui/flows/' + encodeURIComponent(id));
    if (!r.ok) throw new Error('not found');
    state.flow = await r.json();
  } catch (e) { state.flow = null; }
  render();
}

async function createFlow() {
  const name = prompt('流程名稱（例如「新進人員報到」）：');
  if (name == null) return;
  const description = prompt('情境描述（選填，可多行用分號隔開）：', '') || '';
  try {
    const r = await api('/api/ui/flows', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() || '未命名流程', description })
    });
    if (!r.ok) throw new Error((await r.json()).error || '建立失敗');
    const flow = await r.json();
    await loadFlows();
    await selectFlow(flow.id);
  } catch (e) { alert('建立流程失敗：' + e.message); }
}

async function deleteFlowItem(id, name) {
  if (!confirm('永久刪除流程「' + name + '」？此動作無法復原（畫面本身不受影響）。')) return;
  try { await api('/api/ui/flows/' + encodeURIComponent(id), { method: 'DELETE' }); } catch (e) {}
  if (state.flowId === id) { state.flowId = null; state.flow = null; state.flowPlay = null; }
  await loadFlows();
}

// UID13：匯出前先問伺服器算過的檢查結果（失效步驟／外部網址），列出來讓使用者決定「仍要匯出」
// 或「先修好再匯」——不靜默略過（§7.4.4／UID-53）。confirm() 沿用本檔既有慣例（見檔內其他 alert/confirm）。
async function exportCurrentFlow() {
  if (!state.flow) return;
  const id = state.flow.id;
  let check;
  try {
    const r = await api('/api/ui/flows/' + encodeURIComponent(id) + '/export-check');
    if (!r.ok) throw new Error((await r.json()).error || '檢查失敗');
    check = await r.json();
  } catch (e) { alert('匯出前檢查失敗：' + e.message); return; }
  if (!check.stepCount) { alert('這條流程沒有可匯出的步驟（所有步驟的畫面都已不存在）。'); return; }
  const warnLines = [];
  if (check.skipped.length) warnLines.push('有 ' + check.skipped.length + ' 個步驟的畫面已不存在，將略過：第 ' + check.skipped.map(s => s.index).join('、') + ' 步。');
  if (check.externalRefs.length) warnLines.push('偵測到 ' + check.externalRefs.length + ' 個外部網址（離線開啟連不到，畫面上該處會顯示不出來）：\n' + check.externalRefs.slice(0, 5).join('\n') + (check.externalRefs.length > 5 ? '\n…' : ''));
  if (warnLines.length && !confirm('匯出前發現以下狀況：\n\n' + warnLines.join('\n\n') + '\n\n仍要匯出嗎？（可先關掉這個視窗回去修好再匯）')) return;
  try {
    const r = await api('/api/ui/flows/' + encodeURIComponent(id) + '/export', { method: 'POST' });
    if (!r.ok) throw new Error((await r.json()).error || '匯出失敗');
    const result = await r.json();
    alert('已匯出 ' + result.stepCount + ' 個步驟到：\n' + result.dir + '\n\n把整個資料夾複製給客戶，用瀏覽器打開裡面的 index.html 即可離線瀏覽。');
  } catch (e) { alert('匯出失敗：' + e.message); }
}

function scheduleFlowSave() {
  state.flowSavePending = true;
  if (state.flowSaveTimer) clearTimeout(state.flowSaveTimer);
  state.flowSaveTimer = setTimeout(saveFlowNow, 600);
}

async function saveFlowNow() {
  if (state.flowSaveTimer) { clearTimeout(state.flowSaveTimer); state.flowSaveTimer = null; }
  if (!state.flow) { state.flowSavePending = false; return; }
  state.flowSavePending = false;
  try {
    await api('/api/ui/flows/' + encodeURIComponent(state.flow.id), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: state.flow.name, description: state.flow.description, device: state.flow.device, steps: (state.flow.steps || []).map(stripStepComputed) })
    });
    const idx = state.flows.findIndex(f => f.id === state.flow.id);
    if (idx !== -1) { state.flows[idx].name = state.flow.name; state.flows[idx].stepCount = (state.flow.steps || []).length; }
  } catch (e) { /* 靜默失敗，下次編輯會再排一次存檔 */ }
}

// steps 存回伺服器前剝掉 GET 附加的計算欄位（_invalid/_screenName），避免髒資料被寫進檔案。
function stripStepComputed(step) {
  const { _invalid, _screenName, ...rest } = step;
  return rest;
}

function addStep() {
  if (!state.flow) return;
  const screenId = state.stepAddScreenId;
  if (!screenId) { alert('先從縮圖選單挑一張畫面。'); return; }
  const caption = (state.stepAddCaption || '').trim();
  if (!caption) { alert('請填一句操作說明。'); return; }
  const screen = state.screens.find(s => s.id === screenId);
  state.flow.steps = (state.flow.steps || []).concat([{ screenId, caption, hotspot: null, note: '', _screenName: screen ? screen.name : null, _invalid: false }]);
  state.stepAddScreenId = '';
  state.stepAddCaption = '';
  scheduleFlowSave();
  render();
}

function removeStep(idx) {
  if (!state.flow) return;
  state.flow.steps = (state.flow.steps || []).filter((_, i) => i !== idx);
  if (state.hotspotStepIdx === idx) state.hotspotStepIdx = null;
  scheduleFlowSave();
  render();
}

function duplicateStep(idx) {
  if (!state.flow) return;
  const steps = (state.flow.steps || []).slice();
  const src = steps[idx];
  if (!src) return;
  steps.splice(idx + 1, 0, Object.assign({}, src, { hotspot: src.hotspot ? Object.assign({}, src.hotspot) : null }));
  state.flow.steps = steps;
  scheduleFlowSave();
  render();
}

function updateStepCaption(idx, caption) {
  if (!state.flow || !state.flow.steps[idx]) return;
  state.flow.steps[idx].caption = caption;
  scheduleFlowSave();
}

function updateStepNote(idx, note) {
  if (!state.flow || !state.flow.steps[idx]) return;
  state.flow.steps[idx].note = note;
  scheduleFlowSave();
}

function reorderStep(fromIdx, toIdx) {
  if (!state.flow || fromIdx === toIdx || fromIdx == null || toIdx == null) return;
  const steps = (state.flow.steps || []).slice();
  const [moved] = steps.splice(fromIdx, 1);
  steps.splice(toIdx, 0, moved);
  state.flow.steps = steps;
  scheduleFlowSave();
  render();
}

function toggleHotspotEditor(idx) {
  state.hotspotStepIdx = state.hotspotStepIdx === idx ? null : idx;
  if (state.hotspotStepIdx !== null) {
    const step = state.flow.steps[idx];
    if (step && step.screenId && !state.hotspotScreenCache[step.screenId]) {
      fetchScreenForPlay(step.screenId).then(screen => {
        if (screen) state.hotspotScreenCache[step.screenId] = screen;
        render();
      });
    }
  }
  render();
}

function clearStepHotspot(idx) {
  if (!state.flow || !state.flow.steps[idx]) return;
  const step = state.flow.steps[idx];
  step.hotspot = null;
  // 清掉熱點時，若這一步原本靠熱點才能前進，一併退回 'next'——否則會變成勾了卻沒有
  // 熱點框可點的死路（UID15 誠實邊界：勾選只在有熱點時才有意義）。
  if (step.advance === 'hotspot') step.advance = 'next';
  scheduleFlowSave();
  render();
}

// step.advance：'next'（預設，沿用按鈕前進）｜'hotspot'（必須點擊熱區才前進，僅在
// 該步驟已設定 hotspot 時才生效，見 SPEC §7.4.7／UID-61）。
function stepMustAdvanceHotspot(step) {
  return !!(step && step.advance === 'hotspot' && step.hotspot);
}

function toggleStepAdvanceHotspot(idx) {
  if (!state.flow || !state.flow.steps[idx]) return;
  const step = state.flow.steps[idx];
  if (!step.hotspot) return; // 未設熱點不可勾選；UI 已 disable，這裡是二次防呆
  step.advance = step.advance === 'hotspot' ? 'next' : 'hotspot';
  scheduleFlowSave();
  render();
}

// 重播／簡報／匯出三個播放面共用的呼吸高亮樣式（UID15）。匯出包另外把同一組 CSS
// 烘進 renderFlowExportHtml，不能共用這份 JS 字串（那邊是純字串拼出的靜態 HTML），
// 但視覺規格必須一致：橘色框＋呼吸陰影＋可點游標。
const FLOW_HOTSPOT_ADVANCE_STYLE = '<style>@keyframes uid-flow-hotspot-pulse{0%,100%{box-shadow:0 0 0 0 rgba(245,158,11,.55);}50%{box-shadow:0 0 0 8px rgba(245,158,11,0);}}'
  + '.uid-flow-hotspot-advance{position:absolute;border:2px solid #f59e0b;background:rgba(245,158,11,.15);border-radius:4px;cursor:pointer;pointer-events:none;animation:uid-flow-hotspot-pulse 1.6s ease-in-out infinite;}'
  + '.uid-flow-hotspot-advance:hover{background:rgba(245,158,11,.28);}</style>';

// 疊在畫框上的熱區框，供 insertIntoFrame 插入；只有 mustAdvance 時才畫（否則沿用
// renderHotspotEditor 那個純展示、pointer-events:none 的框）。
// UID16 D16：降級為純提示——pointer-events:none，不再攔截點擊（底下的真元件才收得到點擊，
// 例如熱區蓋著一顆按鈕時，按鈕本身仍可互動）。呼吸高亮＋游標提示照舊，只是不再是「可點的那層」。
// 前進判定改走 bridgeNativeXY()＋pointInHotspot()：橋接回報的點擊座標換算回原生座標後，
// 判斷是否落在 step.hotspot 矩形內（見 renderFlowPresentFrame／bindFlowsTabEvents 的 onClick）。
function renderFlowAdvanceHotspotBox(step, presentScale) {
  if (!stepMustAdvanceHotspot(step)) return '';
  const ps = presentScale || 1; // 元素以 el.x*ps 排版（renderReadOnlyElementsHtml），熱區座標也要跟著乘
  const h = step.hotspot;
  return '<div data-flow-advance-hit="1" class="uid-flow-hotspot-advance" style="left:' + (h.x * ps) + 'px;top:' + (h.y * ps) + 'px;width:' + (h.w * ps) + 'px;height:' + (h.h * ps) + 'px;"></div>';
}

// 舊版「熱區本身可點」的掛法（UID15）。D16 之後熱區框已是 pointer-events:none，這支不會再被
// 觸發（保留是因為呼叫端不影響正確性，等後續整理再一併移除），真正的前進判定見上方註解。
function bindFlowAdvanceHotspot(rootEl, step, onAdvance) {
  if (!rootEl || !stepMustAdvanceHotspot(step)) return;
  const hit = rootEl.querySelector('[data-flow-advance-hit]');
  if (hit) hit.addEventListener('click', onAdvance);
}

// UID16：橋接回報的 msg.x/y 是「該顆元件 iframe 自己的 clientX/clientY」，換算回畫框原生座標
// （未乘 presentScale 前）要用 el.x + msg.x/ps、el.y + msg.y/ps——因為畫面排版時是用 el.x*ps
// 定位、iframe 尺寸是 el.width*ps，所以 iframe 內的 1px 對應原生座標的 1/ps px。
function bridgeNativeXY(el, msg, presentScale) {
  const ps = presentScale || 1;
  return { x: el.x + (msg.x || 0) / ps, y: el.y + (msg.y || 0) / ps };
}

function pointInHotspot(pt, h) {
  return !!h && pt.x >= h.x && pt.x <= h.x + h.w && pt.y >= h.y && pt.y <= h.y + h.h;
}

// 在熱點編輯器的畫框上拖曳畫一個框；座標換算回畫框原生（frame）座標存進 step.hotspot，
// 手法比照 bindCanvasMarquee 的拖框邏輯，只是這裡不是選取元件、而是存一個矩形當熱點。
function bindHotspotDraw(frameEl, idx, scale) {
  frameEl.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const rect = frameEl.getBoundingClientRect();
    const startX = (ev.clientX - rect.left) / scale, startY = (ev.clientY - rect.top) / scale;
    const box = document.createElement('div');
    box.style.cssText = 'position:absolute;border:2px solid #f59e0b;background:rgba(245,158,11,0.15);pointer-events:none;';
    frameEl.appendChild(box);
    function onMove(mv) {
      const x2 = (mv.clientX - rect.left) / scale, y2 = (mv.clientY - rect.top) / scale;
      const x = Math.min(startX, x2), y = Math.min(startY, y2), w = Math.abs(x2 - startX), h = Math.abs(y2 - startY);
      box.style.left = x + 'px'; box.style.top = y + 'px'; box.style.width = w + 'px'; box.style.height = h + 'px';
    }
    function onUp(mv) {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const x2 = (mv.clientX - rect.left) / scale, y2 = (mv.clientY - rect.top) / scale;
      const x = Math.round(Math.min(startX, x2)), y = Math.round(Math.min(startY, y2));
      const w = Math.round(Math.abs(x2 - startX)), h = Math.round(Math.abs(y2 - startY));
      box.remove();
      if (w > 4 && h > 4 && state.flow && state.flow.steps[idx]) {
        state.flow.steps[idx].hotspot = { x, y, w, h };
        scheduleFlowSave();
      }
      render();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// 既有熱點框要顯示在「已套用 transform:scale() 的畫框」裡面，而不是外層——插進去當子節點後，
// 座標可直接用原生 frame 單位（不必再乘 scale），會隨父層的 transform 自動一起縮放，跟畫布/預覽
// 同一套「資料永遠以原生座標儲存，縮放只改視覺呈現」的原則一致（見 SPEC §7.1 縮放小節）。
function insertIntoFrame(frameHtml, innerHtml) {
  const idx = frameHtml.lastIndexOf('</div>');
  if (idx === -1) return frameHtml + innerHtml;
  return frameHtml.slice(0, idx) + innerHtml + frameHtml.slice(idx);
}

function renderHotspotEditor(idx) {
  const step = state.flow.steps[idx];
  if (!step || !step.screenId) return '<div class="p-3 text-[11px] text-slate-400">這一步沒有畫面可標熱點。</div>';
  const screen = state.hotspotScreenCache[step.screenId];
  if (!screen) return '<div class="p-3 text-[11px] text-slate-400">載入畫面中…</div>';
  const scale = previewScaleFor(screen, 520, 360, 1);
  const boxHtml = step.hotspot
    ? ('<div id="uid-hotspot-box-' + idx + '" style="position:absolute;border:2px solid #f59e0b;background:rgba(245,158,11,0.15);left:' + step.hotspot.x + 'px;top:' + step.hotspot.y + 'px;width:' + step.hotspot.w + 'px;height:' + step.hotspot.h + 'px;pointer-events:none;"></div>')
    : '';
  // §7.5.3「明確不動」：熱點編輯器維持 pointer-events:none——拖框取熱點靠滑鼠事件穿透到
  // 底下的畫框，解鎖互動會讓 mousedown 收不到（見 bindHotspotDraw／fillReadOnlyFrames 呼叫端）。
  const frameHtml = insertIntoFrame(renderReadOnlyFrameHtml(screen, { scale, presentScale: 1, interactive: false }), boxHtml);
  return '<div class="p-3 bg-slate-50 dark:bg-slate-900/60 border-t border-slate-200 dark:border-slate-700/60">'
    + '<div class="text-[11px] text-slate-400 mb-1.5">在畫面上拉一個框標熱點（選填，播放時高亮該處）；' + (step.hotspot ? '已設定 <button data-hotspot-clear="' + idx + '" class="text-amber-600 underline">清除</button>' : '尚未設定') + '</div>'
    + '<div id="uid-hotspot-frame-wrap-' + idx + '" style="width:fit-content;">' + frameHtml + '</div>'
    + '</div>';
}

function renderFlowStepsList() {
  const flow = state.flow;
  const steps = flow.steps || [];
  if (!steps.length) return '<div class="p-3 text-[11px] text-slate-400">還沒有步驟，從下方挑一張畫面加進來。</div>';
  return steps.map((step, idx) => {
    const invalid = step._invalid;
    const label = invalid ? ('這一步的畫面已被刪除' + (step._screenName ? '（原：' + esc(step._screenName) + '）' : '')) : esc(step._screenName || step.screenId);
    return '<div draggable="true" data-flow-step="' + idx + '" class="rounded-lg border ' + (invalid ? 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20' : 'border-slate-200 dark:border-slate-700') + ' mb-2">'
      + '  <div class="flex items-start gap-2 p-2 cursor-move">'
      + '    <span class="text-[10px] font-bold text-slate-400 mt-1 w-5 text-right">' + (idx + 1) + '.</span>'
      + '    <div class="flex-1 min-w-0">'
      + '      <div class="text-[10px] ' + (invalid ? 'text-amber-600 dark:text-amber-400 font-semibold' : 'text-slate-400') + ' truncate">' + (invalid ? '⚠ ' : '') + label + '</div>'
      + '      <input data-step-caption="' + idx + '" value="' + esc(step.caption || '') + '" placeholder="這一步要做什麼？" class="w-full mt-0.5 px-2 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs">'
      + '      <textarea data-step-note="' + idx + '" placeholder="內部備註（客戶看不到，選填）" rows="1" class="w-full mt-1 px-2 py-1 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-[11px] text-slate-500">' + esc(step.note || '') + '</textarea>'
      + '      <label class="flex items-center gap-1 mt-1 text-[10px] ' + (step.hotspot ? 'text-slate-500 dark:text-slate-400 cursor-pointer' : 'text-slate-300 dark:text-slate-600 cursor-not-allowed') + '" title="' + (step.hotspot ? '勾選後，播放時必須點擊畫面上的熱區才會前進' : '請先在畫面上拉出熱區，才能勾選此項') + '">'
      + '        <input type="checkbox" data-step-advance="' + idx + '" ' + (step.advance === 'hotspot' ? 'checked' : '') + (step.hotspot ? '' : ' disabled') + ' class="w-3 h-3">'
      + '        必須點擊熱區才前進'
      + '      </label>'
      + '    </div>'
      + '    <div class="flex flex-col gap-1 flex-shrink-0">'
      + '      <button data-hotspot-toggle="' + idx + '" title="標熱點（選填）" class="w-6 h-6 flex items-center justify-center rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-[11px]" style="' + (step.hotspot ? 'color:#f59e0b' : '') + '">▢</button>'
      + '      <button data-step-dup="' + idx + '" title="複製這一步" class="w-6 h-6 flex items-center justify-center rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-[11px]">⧉</button>'
      + '      <button data-step-del="' + idx + '" title="刪除這一步" class="w-6 h-6 flex items-center justify-center rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-red-500 text-[11px]">✕</button>'
      + '    </div>'
      + '  </div>'
      + (state.hotspotStepIdx === idx ? renderHotspotEditor(idx) : '')
      + '</div>';
  }).join('');
}

// 加步驟用的「縮圖選單」：以裝置外框比例＋名稱做輕量縮圖（不逐一起 iframe 渲染每張畫面，
// 避免流程一長就要對每個候選畫面重跑一次真實渲染；真正的視覺唯讀渲染留給熱點編輯器/播放器）。
function renderStepScreenPicker() {
  if (!state.screens.length) return '<div class="p-2 text-[11px] text-slate-400">這個工作區還沒有畫面，先到「畫布設計」拼幾張。</div>';
  return '<div class="grid gap-1.5 p-2 max-h-40 overflow-y-auto" style="grid-template-columns:repeat(auto-fill,minmax(96px,1fr));">'
    + state.screens.map(s => {
      const ratio = (s.frame && s.frame.width && s.frame.height) ? (s.frame.height / s.frame.width) : 0.6;
      const selected = state.stepAddScreenId === s.id;
      return '<button data-step-pick-screen="' + s.id + '" class="rounded-lg border p-1.5 text-left ' + (selected ? 'border-cyan-500 bg-cyan-50 dark:bg-cyan-900/30' : 'border-slate-200 dark:border-slate-700 hover:border-cyan-300') + '">'
        + '<div class="rounded bg-slate-100 dark:bg-slate-800 mx-auto" style="width:100%;max-width:56px;aspect-ratio:1/' + Math.max(0.3, Math.min(3, ratio)) + ';"></div>'
        + '<div class="text-[10px] mt-1 truncate text-slate-600 dark:text-slate-300">' + esc(s.name) + '</div>'
        + '</button>';
    }).join('')
    + '</div>';
}

function renderFlowEditor() {
  const flow = state.flow;
  const steps = flow.steps || [];
  const hasSteps = steps.length > 0;
  return '<div class="flex-1 flex flex-col overflow-hidden">'
    + '  <div class="p-3 border-b border-slate-200 dark:border-slate-700/60 space-y-1.5">'
    + '    <input id="uid-flow-name" value="' + esc(flow.name) + '" class="w-full px-2 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm font-semibold">'
    + '    <textarea id="uid-flow-desc" rows="2" placeholder="情境描述（例如：新進人員第一天要走完哪些畫面）" class="w-full px-2 py-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs">' + esc(flow.description || '') + '</textarea>'
    + '    <div class="flex items-center gap-1.5">'
    + '      <button id="uid-flow-replay" ' + (hasSteps ? '' : 'disabled') + ' class="px-2.5 py-1 rounded-lg bg-cyan-600 hover:bg-cyan-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold">▶ 重播</button>'
    + '      <button id="uid-flow-present" ' + (hasSteps ? '' : 'disabled') + ' class="px-2.5 py-1 rounded-lg bg-violet-600 hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold">⛶ 簡報模式</button>'
    + '      <button id="uid-flow-export" ' + (hasSteps ? '' : 'disabled') + ' class="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed text-slate-700 dark:text-slate-200 text-xs font-semibold">⤓ 匯出（離線交付）</button>'
    + '      <span class="flex-1"></span>'
    + '      <button id="uid-flow-delete" class="px-2.5 py-1 rounded-lg bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-300 text-xs">刪除流程</button>'
    + '    </div>'
    + '  </div>'
    + '  <div class="flex-1 overflow-y-auto p-3">'
    + '    <div class="text-[11px] font-semibold text-slate-500 mb-1.5">步驟（拖曳排序）</div>'
    + renderFlowStepsList()
    + '    <div class="mt-3 pt-3 border-t border-slate-200 dark:border-slate-700/60">'
    + '      <div class="text-[11px] font-semibold text-slate-500 mb-1">加一步：先挑畫面</div>'
    + renderStepScreenPicker()
    + '      <div class="flex items-center gap-1.5 mt-1.5">'
    + '        <input id="uid-step-caption" value="' + esc(state.stepAddCaption) + '" placeholder="這一步要做什麼？" class="flex-1 px-2 py-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs">'
    + '        <button id="uid-step-add" class="px-2.5 py-1 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-xs font-semibold">加入步驟</button>'
    + '      </div>'
    + '    </div>'
    + '  </div>'
    + '</div>';
}

function renderFlowList() {
  if (state.flowsLoading) return '<div class="p-3 text-xs text-slate-400">載入中…</div>';
  if (!state.flows.length) return '<div class="p-3 text-xs text-slate-400 leading-relaxed">這個工作區還沒有 UI操作演示。<br>點「+ 新流程」開始建第一條。</div>';
  return state.flows.map(f =>
    '<div data-flow="' + f.id + '" class="w-full text-left px-3 py-2 rounded-lg text-xs cursor-pointer flex items-center gap-1.5 ' +
    (f.id === state.flowId ? 'bg-cyan-50 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-300 font-semibold' : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800') +
    '"><div class="flex-1 min-w-0"><div class="font-medium truncate">' + esc(f.name) + '</div>'
    + '<div class="text-[10px] text-slate-400">' + (f.stepCount || 0) + ' 步</div></div>'
    + '<button data-flow-del="' + f.id + '" data-flow-del-name="' + esc(f.name) + '" title="刪除" class="w-5 h-5 flex-shrink-0 flex items-center justify-center rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-red-400 text-[11px]">✕</button>'
    + '</div>'
  ).join('');
}

function renderFlowsTab() {
  return '<div class="flex-1 flex overflow-hidden">'
    + '  <div class="w-56 border-r border-slate-200 dark:border-slate-700/60 flex flex-col overflow-hidden bg-white/60 dark:bg-slate-900/40">'
    + '    <div class="p-2 flex items-center justify-between border-b border-slate-200 dark:border-slate-700/60">'
    + '      <span class="text-xs font-semibold text-slate-500">UI操作演示</span>'
    + '      <button id="uid-flow-new" class="px-2 py-1 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-[11px] font-semibold">+ 新流程</button>'
    + '    </div>'
    + '    <div class="flex-1 overflow-y-auto p-1.5">' + renderFlowList() + '</div>'
    + '  </div>'
    + (state.flow
      ? (state.flowPlay && !flowPresentOverlay ? renderFlowReplayPanel() : renderFlowEditor())
      : '<div class="flex-1 flex items-center justify-center text-sm text-slate-400">選一條流程，或點「+ 新流程」建立第一條</div>')
    + '</div>';
}

// ── UID12 重播（就地播放，設計工具內）與簡報模式（全螢幕，比照 whiteboard.js
// toggleFullscreen() 慣例）共用的播放核心：flowPlay = {idx, screens, loading}。────────────

async function loadFlowPlayScreens(flow) {
  const cache = {};
  const ids = Array.from(new Set((flow.steps || []).map(s => s.screenId).filter(Boolean)));
  await Promise.all(ids.map(async (id) => { cache[id] = await fetchScreenForPlay(id); }));
  return cache;
}

// UID15 修正：載入畫面是「開始播放」的唯一入口，重播與簡報模式都必須走這裡。
// 舊寫法把載入綁在 startFlowReplay() 裡，編輯頁的「簡報模式」自己 new 了一個
// flowPlay={loading:true} 卻沒觸發載入，enterFlowPresent() 又因為 flowPlay 已存在而
// 跳過補救 → 簡報永遠卡在「載入中…」，且離開後那個殘留的 flowPlay 連帶讓重播面板
// 也卡住（使用者看到的就是「重播和簡報都跑不起來」）。
function ensureFlowPlayLoaded() {
  if (!state.flow || !(state.flow.steps || []).length) return;
  if (!state.flowPlay) state.flowPlay = { idx: 0, screens: {}, loading: true };
  const fp = state.flowPlay;
  if (!fp.loading || fp._loadStarted) return; // 已載完，或已有一輪載入在跑
  fp._loadStarted = true;
  loadFlowPlayScreens(state.flow).then((cache) => {
    if (!state.flowPlay || state.flowPlay !== fp) return; // 期間已結束播放／換了流程
    fp.screens = cache;
    fp.loading = false;
    fp._loadStarted = false;
    if (flowPresentOverlay) renderFlowPresentFrame(); else render();
  });
}

function startFlowReplay() {
  if (!state.flow || !(state.flow.steps || []).length) return;
  state.flowPlay = { idx: 0, screens: {}, loading: true };
  render();
  ensureFlowPlayLoaded();
}

function stopFlowReplay() {
  state.flowPlay = null;
  if (flowPresentOverlay) exitFlowPresent();
  render();
}

function flowPlayGoTo(idx) {
  if (!state.flow || !state.flowPlay) return;
  const n = (state.flow.steps || []).length;
  state.flowPlay.idx = Math.max(0, Math.min(n - 1, idx));
  if (flowPresentOverlay) renderFlowPresentFrame(); else render();
}

function renderFlowReplayPanel() {
  const flow = state.flow;
  const fp = state.flowPlay;
  const steps = flow.steps || [];
  const idx = Math.max(0, Math.min(steps.length - 1, fp.idx));
  const step = steps[idx];
  const screen = (!fp.loading && step && step.screenId) ? fp.screens[step.screenId] : null;
  const mustAdvance = stepMustAdvanceHotspot(step);
  let frameHtml;
  if (fp.loading) frameHtml = '<div class="p-6 text-xs text-slate-400">載入中…</div>';
  else if (!screen) frameHtml = '<div class="p-6 text-xs text-amber-600 dark:text-amber-400">⚠ 這一步的畫面已被刪除，流程仍可繼續走其他步驟。</div>';
  else {
    const presentScale = presentScaleFor(screen);
    const scale = previewScaleFor(screen, 640, 440, presentScale);
    frameHtml = renderReadOnlyFrameHtml(screen, { scale, presentScale });
    if (mustAdvance) frameHtml = FLOW_HOTSPOT_ADVANCE_STYLE + insertIntoFrame(frameHtml, renderFlowAdvanceHotspotBox(step, presentScale));
  }
  const sideList = steps.map((s, i) =>
    '<button data-flow-goto="' + i + '" class="w-full text-left px-2 py-1.5 rounded-lg text-[11px] ' +
    (i === idx ? 'bg-cyan-50 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-300 font-semibold' : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300') + '">'
    + (i + 1) + '. ' + (s._invalid ? '⚠ ' : '') + esc(s.caption || s._screenName || '') + '</button>'
  ).join('');
  return '<div class="flex-1 flex overflow-hidden">'
    + '  <div class="flex-1 flex flex-col overflow-hidden">'
    + '    <div class="flex items-center justify-between px-3 py-2 border-b border-slate-200 dark:border-slate-700/60">'
    + '      <span class="text-xs text-slate-500">重播 · ' + (idx + 1) + ' / ' + steps.length + '</span>'
    + '      <div class="flex items-center gap-1.5">'
    + '        <button id="uid-flow-play-prev" ' + (idx === 0 ? 'disabled' : '') + ' class="px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 disabled:opacity-40 text-xs">◀ 上一步</button>'
    + '        <button id="uid-flow-play-next" ' + (idx === steps.length - 1 || mustAdvance ? 'disabled' : '') + ' class="px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 disabled:opacity-40 text-xs">下一步 ▶</button>'
    + '        <button id="uid-flow-play-present" class="px-2 py-1 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-xs">⛶ 簡報模式</button>'
    + '        <button id="uid-flow-play-close" class="px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs">結束重播</button>'
    + '      </div>'
    + '    </div>'
    + '    <div id="uid-flow-play-scroll" class="flex-1 overflow-auto p-4"><div style="margin:auto;width:fit-content;">' + frameHtml + '</div></div>'
    + '    <div class="px-4 py-2.5 border-t border-slate-200 dark:border-slate-700/60 text-xs text-slate-600 dark:text-slate-300">' + esc(step ? (step.caption || '') : '') + (mustAdvance ? ' <span class="text-amber-600 dark:text-amber-400 font-semibold">・請點擊畫面上的指示位置繼續</span>' : '') + '</div>'
    + '  </div>'
    + '  <div class="w-56 border-l border-slate-200 dark:border-slate-700/60 overflow-y-auto p-1.5 space-y-0.5">' + sideList + '</div>'
    + '</div>';
}

async function enterFlowPresent() {
  if (!state.flow || !(state.flow.steps || []).length) return;
  ensureFlowPlayLoaded(); // 不論從編輯頁或重播面板進來，畫面都保證會被載入
  if (flowPresentOverlay) return;
  const overlay = document.createElement('div');
  overlay.id = 'uid-flow-present-overlay';
  overlay.className = 'fixed inset-0 z-[999] flex flex-col';
  overlay.style.background = canvasIsDark() ? '#0f172a' : '#f8fafc';
  overlay.innerHTML = ''
    + '<div class="flex items-center justify-between px-4 py-2 flex-shrink-0">'
    + '  <span class="text-xs ' + (canvasIsDark() ? 'text-slate-300' : 'text-slate-500') + '">' + esc(state.flow.name) + '</span>'
    + '  <div class="flex items-center gap-1.5">'
    // UID8 §7.1 慣例：主題鈕複製一份到播放工具列，全螢幕下才按得到。
    + '    <button id="uid-flow-present-theme" class="px-2.5 py-1 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs">切換深淺色</button>'
    + '    <button id="uid-flow-present-close" class="px-2.5 py-1 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs">結束（Esc）</button>'
    + '  </div>'
    + '</div>'
    + '<div id="uid-flow-present-scroll" class="flex-1 overflow-auto"><div id="uid-flow-present-wrap" style="margin:auto;width:fit-content;"></div></div>'
    + '<div id="uid-flow-present-caption" class="px-6 py-4 flex-shrink-0 text-center text-sm"></div>'
    + '<div id="uid-flow-present-progress" class="px-6 pb-3 text-center text-xs"></div>';
  document.body.appendChild(overlay);
  flowPresentOverlay = overlay;
  overlay.querySelector('#uid-flow-present-close').addEventListener('click', exitFlowPresent);
  overlay.querySelector('#uid-flow-present-theme').addEventListener('click', () => {
    state.canvasTheme = canvasIsDark() ? 'light' : 'dark';
    renderFlowPresentFrame();
  });
  flowPresentKeyHandler = (ev) => {
    if (ev.key === 'Escape') { exitFlowPresent(); return; }
    if (ev.key === 'ArrowRight' || ev.key === ' ') {
      ev.preventDefault();
      // UID15：這一步若必須點擊熱區才前進，右鍵／空白鍵不生效（左鍵與側邊清單跳轉不受限）。
      const curStep = (state.flow.steps || [])[state.flowPlay.idx];
      if (stepMustAdvanceHotspot(curStep)) return;
      flowPlayGoTo(state.flowPlay.idx + 1);
    }
    else if (ev.key === 'ArrowLeft') { flowPlayGoTo(state.flowPlay.idx - 1); }
  };
  document.addEventListener('keydown', flowPresentKeyHandler);
  flowPresentFullscreenHandler = () => { if (!document.fullscreenElement && flowPresentOverlay) exitFlowPresent(); };
  document.addEventListener('fullscreenchange', flowPresentFullscreenHandler);
  try { await overlay.requestFullscreen(); } catch (e) { /* Headless/自動化環境可能不支援，overlay 本身已是 fixed 全版面覆蓋，視覺上等效 */ }
  afterViewportSettled(renderFlowPresentFrame);
  flowPresentResizeHandler = () => renderFlowPresentFrame();
  window.addEventListener('resize', flowPresentResizeHandler);
}

function renderFlowPresentFrame() {
  if (!flowPresentOverlay || !state.flow || !state.flowPlay) return;
  const dark = canvasIsDark();
  flowPresentOverlay.style.background = dark ? '#0f172a' : '#f8fafc';
  const captionEl = flowPresentOverlay.querySelector('#uid-flow-present-caption');
  const progressEl = flowPresentOverlay.querySelector('#uid-flow-present-progress');
  if (captionEl) captionEl.className = 'px-6 py-4 flex-shrink-0 text-center text-sm ' + (dark ? 'text-slate-100' : 'text-slate-700');
  if (progressEl) progressEl.className = 'px-6 pb-3 text-center text-xs ' + (dark ? 'text-slate-400' : 'text-slate-500');
  const steps = state.flow.steps || [];
  const idx = Math.max(0, Math.min(steps.length - 1, state.flowPlay.idx));
  state.flowPlay.idx = idx;
  const step = steps[idx];
  const mustAdvance = stepMustAdvanceHotspot(step);
  const screen = (!state.flowPlay.loading && step && step.screenId) ? state.flowPlay.screens[step.screenId] : null;
  const scrollEl = flowPresentOverlay.querySelector('#uid-flow-present-scroll');
  const wrap = flowPresentOverlay.querySelector('#uid-flow-present-wrap');
  if (!scrollEl || !wrap) return;
  if (state.flowPlay.loading) {
    wrap.innerHTML = '<div class="p-8 text-sm ' + (dark ? 'text-slate-300' : 'text-slate-500') + '">載入中…</div>';
    wrap.style.width = ''; wrap.style.height = '';
  } else if (!screen) {
    wrap.innerHTML = '<div class="p-8 text-sm text-amber-500">這一步的畫面已被刪除，無法預覽。</div>';
    wrap.style.width = ''; wrap.style.height = '';
  } else {
    const presentScale = presentScaleFor(screen);
    const scale = previewScaleFor(screen, scrollEl.clientWidth - 32, scrollEl.clientHeight - 32, presentScale);
    let frameHtml = renderReadOnlyFrameHtml(screen, { scale, presentScale });
    if (mustAdvance) frameHtml = FLOW_HOTSPOT_ADVANCE_STYLE + insertIntoFrame(frameHtml, renderFlowAdvanceHotspotBox(step, presentScale));
    wrap.innerHTML = frameHtml;
    wrap.style.width = Math.round(screen.frame.width * presentScale * scale) + 'px';
    wrap.style.height = Math.round(screen.frame.height * presentScale * scale) + 'px';
    // UID16/UID17：以流程順序為準（§7.4.3）。熱區命中優先觸發前進；否則交給共用事件執行邏輯，
    // 但 navigate 一律忽略（suppressNavigate，避免誤點畫面上其它元件的 navigate 就跳離流程），
    // toast/toggle 仍然照常執行——這不是「跳離流程」，只是元件自己的視覺回饋。
    fillReadOnlyFrames(wrap, screen, {
      presentScale,
      onClick: (el, msg, ps) => {
        if (mustAdvance && pointInHotspot(bridgeNativeXY(el, msg, ps), step.hotspot)) { flowPlayGoTo(state.flowPlay.idx + 1); return; }
        runElementEvents(el, 'click', { wrapRoot: wrap, suppressNavigate: true });
      },
      onChange: (el, msg, type) => runElementEvents(el, type, { wrapRoot: wrap, suppressNavigate: true })
    });
    bindFlowAdvanceHotspot(wrap, step, () => flowPlayGoTo(state.flowPlay.idx + 1));
  }
  if (captionEl) captionEl.innerHTML = step ? (esc(step.caption || '') + (mustAdvance ? ' <span class="text-amber-500 font-semibold">・請點擊畫面上的指示位置繼續</span>' : '')) : '';
  if (progressEl) progressEl.textContent = steps.length ? ((idx + 1) + ' / ' + steps.length) : '';
}

function exitFlowPresent() {
  if (!flowPresentOverlay) return;
  if (document.fullscreenElement && document.fullscreenElement === flowPresentOverlay) { try { document.exitFullscreen(); } catch (e) {} }
  if (flowPresentKeyHandler) { document.removeEventListener('keydown', flowPresentKeyHandler); flowPresentKeyHandler = null; }
  if (flowPresentFullscreenHandler) { document.removeEventListener('fullscreenchange', flowPresentFullscreenHandler); flowPresentFullscreenHandler = null; }
  if (flowPresentResizeHandler) { window.removeEventListener('resize', flowPresentResizeHandler); flowPresentResizeHandler = null; }
  flowPresentOverlay.remove();
  flowPresentOverlay = null;
  render();
}

function bindFlowsTabEvents() {
  const newBtn = container.querySelector('#uid-flow-new');
  if (newBtn) newBtn.addEventListener('click', createFlow);
  container.querySelectorAll('[data-flow]').forEach(el => el.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-flow-del]')) return;
    selectFlow(el.getAttribute('data-flow'));
  }));
  container.querySelectorAll('[data-flow-del]').forEach(btn => btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    deleteFlowItem(btn.getAttribute('data-flow-del'), btn.getAttribute('data-flow-del-name'));
  }));

  if (!state.flow) return;

  if (state.flowPlay && !flowPresentOverlay) {
    const prevBtn = container.querySelector('#uid-flow-play-prev');
    if (prevBtn) prevBtn.addEventListener('click', () => flowPlayGoTo(state.flowPlay.idx - 1));
    const nextBtn = container.querySelector('#uid-flow-play-next');
    if (nextBtn) nextBtn.addEventListener('click', () => flowPlayGoTo(state.flowPlay.idx + 1));
    const presentBtn = container.querySelector('#uid-flow-play-present');
    if (presentBtn) presentBtn.addEventListener('click', enterFlowPresent);
    const closeBtn = container.querySelector('#uid-flow-play-close');
    if (closeBtn) closeBtn.addEventListener('click', stopFlowReplay);
    container.querySelectorAll('[data-flow-goto]').forEach(b => b.addEventListener('click', () => flowPlayGoTo(parseInt(b.getAttribute('data-flow-goto'), 10) || 0)));
    const scrollEl = container.querySelector('#uid-flow-play-scroll');
    const steps = (state.flow.steps || []);
    const fp = state.flowPlay;
    const curIdx = Math.max(0, Math.min(steps.length - 1, fp.idx));
    const curStep = steps[curIdx];
    const curScreen = (!fp.loading && curStep && curStep.screenId) ? fp.screens[curStep.screenId] : null;
    if (scrollEl && curScreen) {
      const mustAdvance = stepMustAdvanceHotspot(curStep);
      // UID17：與 renderFlowPresentFrame 同一套規則——熱區命中優先前進，否則交給共用事件執行
      // 邏輯但忽略 navigate（流程順序優先，§7.4.3）。
      fillReadOnlyFrames(scrollEl, curScreen, {
        presentScale: presentScaleFor(curScreen),
        onClick: (el, msg, ps) => {
          if (mustAdvance && pointInHotspot(bridgeNativeXY(el, msg, ps), curStep.hotspot)) { flowPlayGoTo(fp.idx + 1); return; }
          runElementEvents(el, 'click', { wrapRoot: scrollEl, suppressNavigate: true });
        },
        onChange: (el, msg, type) => runElementEvents(el, type, { wrapRoot: scrollEl, suppressNavigate: true })
      });
    }
    if (scrollEl) bindFlowAdvanceHotspot(scrollEl, curStep, () => flowPlayGoTo(fp.idx + 1));
    return;
  }

  const nameInp = container.querySelector('#uid-flow-name');
  if (nameInp) nameInp.addEventListener('change', () => { state.flow.name = nameInp.value.trim() || '未命名流程'; scheduleFlowSave(); });
  const descInp = container.querySelector('#uid-flow-desc');
  if (descInp) descInp.addEventListener('change', () => { state.flow.description = descInp.value; scheduleFlowSave(); });
  const replayBtn = container.querySelector('#uid-flow-replay');
  if (replayBtn) replayBtn.addEventListener('click', startFlowReplay);
  const presentBtn = container.querySelector('#uid-flow-present');
  if (presentBtn) presentBtn.addEventListener('click', enterFlowPresent);
  const exportBtn = container.querySelector('#uid-flow-export');
  if (exportBtn) exportBtn.addEventListener('click', exportCurrentFlow);
  const delBtn = container.querySelector('#uid-flow-delete');
  if (delBtn) delBtn.addEventListener('click', () => deleteFlowItem(state.flow.id, state.flow.name));

  container.querySelectorAll('[data-step-pick-screen]').forEach(b => b.addEventListener('click', () => { state.stepAddScreenId = b.getAttribute('data-step-pick-screen'); render(); }));
  const stepCaptionInp = container.querySelector('#uid-step-caption');
  if (stepCaptionInp) stepCaptionInp.addEventListener('input', () => { state.stepAddCaption = stepCaptionInp.value; });
  const stepAddBtn = container.querySelector('#uid-step-add');
  if (stepAddBtn) stepAddBtn.addEventListener('click', addStep);

  container.querySelectorAll('[data-step-caption]').forEach(inp => inp.addEventListener('change', () => {
    updateStepCaption(parseInt(inp.getAttribute('data-step-caption'), 10), inp.value);
  }));
  container.querySelectorAll('[data-step-note]').forEach(ta => ta.addEventListener('change', () => {
    updateStepNote(parseInt(ta.getAttribute('data-step-note'), 10), ta.value);
  }));
  container.querySelectorAll('[data-step-dup]').forEach(b => b.addEventListener('click', () => duplicateStep(parseInt(b.getAttribute('data-step-dup'), 10))));
  container.querySelectorAll('[data-step-del]').forEach(b => b.addEventListener('click', () => removeStep(parseInt(b.getAttribute('data-step-del'), 10))));
  container.querySelectorAll('[data-hotspot-toggle]').forEach(b => b.addEventListener('click', () => toggleHotspotEditor(parseInt(b.getAttribute('data-hotspot-toggle'), 10))));
  container.querySelectorAll('[data-hotspot-clear]').forEach(b => b.addEventListener('click', () => clearStepHotspot(parseInt(b.getAttribute('data-hotspot-clear'), 10))));
  container.querySelectorAll('[data-step-advance]').forEach(cb => cb.addEventListener('change', () => toggleStepAdvanceHotspot(parseInt(cb.getAttribute('data-step-advance'), 10))));

  // 拖曳排序（原生 HTML5 draggable，比照 §7.4.2 需求；不引入額外套件）
  container.querySelectorAll('[data-flow-step]').forEach(el => {
    el.addEventListener('dragstart', () => { state.flowDragIdx = parseInt(el.getAttribute('data-flow-step'), 10); });
    el.addEventListener('dragover', (ev) => ev.preventDefault());
    el.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const toIdx = parseInt(el.getAttribute('data-flow-step'), 10);
      reorderStep(state.flowDragIdx, toIdx);
      state.flowDragIdx = null;
    });
  });

  if (state.hotspotStepIdx !== null) {
    const step = state.flow.steps[state.hotspotStepIdx];
    const screen = step && step.screenId ? state.hotspotScreenCache[step.screenId] : null;
    const wrap = container.querySelector('#uid-hotspot-frame-wrap-' + state.hotspotStepIdx);
    if (wrap && screen) {
      const frame = wrap.querySelector('.uid-ro-frame');
      const scale = previewScaleFor(screen, 520, 360, 1);
      if (frame) { fillReadOnlyFrames(wrap, screen, { interactive: false }); bindHotspotDraw(frame, state.hotspotStepIdx, scale); }
    }
  }
}

// ════════════════════════════════════════════════════════════════════════
// 共用外殼：分頁切換、mount/unmount、頭像對話脈絡
// ════════════════════════════════════════════════════════════════════════

function switchMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  if (mode === 'canvas' && !state.devices.length) loadDevices().then(render);
  if (mode === 'canvas' && !state.models.length) loadModels().then(render);
  // UID-31：每次切回畫布分頁都重抓一次畫面清單（背景可能有技能剛產生新畫面），不再只在首次載入時抓。
  if (mode === 'canvas') loadScreens();
  if (mode === 'templates' && !state.templates.length) loadTemplates();
  // UID12：情境流程分頁要挑「既有畫面」建步驟，畫面清單沒載過就先抓；流程清單每次切回都重抓
  // （比照畫布分頁的 UID-31 慣例，背景技能可能剛新增流程）。
  if (mode === 'flows') { if (!state.screens.length) loadScreens(); loadFlows(); }
  render();
}

function render() {
  const tabs = ''
    + '<div class="flex items-center gap-1 px-3 pt-2 border-b border-slate-200 dark:border-slate-700/60 bg-white/70 dark:bg-slate-900/50">'
    + '  <button id="uid-tab-library" class="px-3 py-1.5 rounded-t-lg text-xs font-semibold ' + (state.mode === 'library' ? 'bg-slate-50 dark:bg-slate-900 text-cyan-600 dark:text-cyan-400' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300') + '">元件庫</button>'
    + '  <button id="uid-tab-canvas" class="px-3 py-1.5 rounded-t-lg text-xs font-semibold ' + (state.mode === 'canvas' ? 'bg-slate-50 dark:bg-slate-900 text-cyan-600 dark:text-cyan-400' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300') + '">畫布設計</button>'
    + '  <button id="uid-tab-templates" class="px-3 py-1.5 rounded-t-lg text-xs font-semibold ' + (state.mode === 'templates' ? 'bg-slate-50 dark:bg-slate-900 text-cyan-600 dark:text-cyan-400' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300') + '">範本庫</button>'
    + '  <button id="uid-tab-flows" class="px-3 py-1.5 rounded-t-lg text-xs font-semibold ' + (state.mode === 'flows' ? 'bg-slate-50 dark:bg-slate-900 text-cyan-600 dark:text-cyan-400' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300') + '">UI操作演示</button>'
    + '</div>';

  // UID8：畫布分頁整塊包在 #uid-canvas-shell 裡（工具列＋三欄），這是 UID-29 全螢幕編輯的
  // Fullscreen API 目標子樹；元件庫分頁維持原樣不受影響。
  container.innerHTML = ''
    + '<section class="relative flex-1 overflow-hidden flex flex-col h-full bg-slate-50/50 dark:bg-slate-900/40">'
    + tabs
    + '  <div class="flex-1 flex overflow-hidden">'
    + (state.mode === 'library' ? renderLibraryTab()
      : state.mode === 'templates' ? renderTemplatesTab()
      : state.mode === 'flows' ? renderFlowsTab()
      : ('<div id="uid-canvas-shell" class="flex-1 flex flex-col overflow-hidden bg-slate-50/50 dark:bg-slate-900/40">' + renderCanvasTab() + '</div>'))
    + '  </div>'
    + renderRestylePicker()
    + renderRestyleWalkPanel()
    + renderRevisionsPanel()
    + renderDeleteScreenConfirmModal()
    + '</section>';

  container.querySelector('#uid-tab-library').addEventListener('click', () => switchMode('library'));
  container.querySelector('#uid-tab-canvas').addEventListener('click', () => switchMode('canvas'));
  container.querySelector('#uid-tab-templates').addEventListener('click', () => switchMode('templates'));
  container.querySelector('#uid-tab-flows').addEventListener('click', () => switchMode('flows'));

  if (state.mode === 'library') {
    const newBtn = container.querySelector('#uid-new');
    if (newBtn) newBtn.addEventListener('click', newComponent);
    container.querySelectorAll('[data-id]').forEach(btn => btn.addEventListener('click', () => selectComponent(btn.getAttribute('data-id'))));
    container.querySelectorAll('[data-variant]').forEach(btn => btn.addEventListener('click', () => {
      state.activeVariant = parseInt(btn.getAttribute('data-variant'), 10) || 0;
      render();
    }));
    const saveBtn = container.querySelector('#uid-save');
    if (saveBtn) saveBtn.addEventListener('click', saveComponent);
    const delBtn = container.querySelector('#uid-delete');
    if (delBtn) delBtn.addEventListener('click', deleteComponent);
    if (state.detail) renderPreview();
  } else if (state.mode === 'templates') {
    container.querySelectorAll('[data-tpl-filter]').forEach(b => b.addEventListener('click', () => {
      state.templateFilterDevice = b.getAttribute('data-tpl-filter');
      loadTemplates();
    }));
    container.querySelectorAll('[data-tpl-apply]').forEach(b => b.addEventListener('click', () => applyTemplate(b.getAttribute('data-tpl-apply'))));
    container.querySelectorAll('[data-tpl-restyle]').forEach(b => b.addEventListener('click', () => openRestylePicker(b.getAttribute('data-tpl-restyle'), b.getAttribute('data-tpl-name'))));
    container.querySelectorAll('[data-tpl-del]').forEach(b => b.addEventListener('click', () => deleteTemplateItem(b.getAttribute('data-tpl-del'), b.getAttribute('data-tpl-name'))));
  } else if (state.mode === 'flows') {
    bindFlowsTabEvents();
  } else {
    const refreshBtn = container.querySelector('#uid-screens-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', refreshCanvasData);
    const newScreenBtn = container.querySelector('#uid-screen-new');
    if (newScreenBtn) newScreenBtn.addEventListener('click', () => {
      const devSel = container.querySelector('#uid-new-device');
      newScreen(devSel ? devSel.value : null);
    });
    const purposeSel = container.querySelector('#uid-new-purpose');
    if (purposeSel) purposeSel.addEventListener('change', () => { state.newPurpose = purposeSel.value; });
    // UID9 UID-32：解析度模式／尺寸模式 切換鈕。
    container.querySelectorAll('[data-screen-mode]').forEach(b => b.addEventListener('click', () => {
      state.newScreenMode = b.getAttribute('data-screen-mode');
      render();
    }));
    // UID-09b 自訂尺寸：選單切到「＋ 自訂尺寸…」要即時長出寬高輸入框；輸入值存進 state，
    // 免得任何一次 render() 把使用者剛打的數字沖掉。
    const devSel = container.querySelector('#uid-new-device');
    if (devSel) devSel.addEventListener('change', () => { state.newDevice = devSel.value; render(); });
    [['uid-custom-w', 'customW'], ['uid-custom-h', 'customH'], ['uid-custom-label', 'customLabel']].forEach(([id, key]) => {
      const el = container.querySelector('#' + id);
      if (el) el.addEventListener('input', () => { state[key] = el.value; });
    });
    const devDel = container.querySelector('#uid-device-del');
    if (devDel) devDel.addEventListener('click', () => {
      const d = state.devices.find(x => x.id === state.newDevice);
      if (d && confirm('移除自訂尺寸「' + d.label + '」？（已用它建立的畫面不受影響）')) deleteCustomDevice(d.id);
    });
    // UID9：尺寸模式的機型選單＋自填吋數／解析度輸入。
    const modelSel = container.querySelector('#uid-new-model');
    if (modelSel) modelSel.addEventListener('change', () => { state.newModel = modelSel.value; render(); });
    // 'input' 只存值（不重繪，維持輸入焦點）；'blur' 才重繪刷新 PPI/dp 換算即時預覽。
    [['uid-custom-diagonal', 'customDiagonal'], ['uid-custom-native-w', 'customNativeW'], ['uid-custom-native-h', 'customNativeH']].forEach(([id, key]) => {
      const el = container.querySelector('#' + id);
      if (!el) return;
      el.addEventListener('input', () => { state[key] = el.value; });
      el.addEventListener('blur', () => render());
    });
    container.querySelectorAll('[data-screen]').forEach(btn => btn.addEventListener('click', () => selectScreen(btn.getAttribute('data-screen'))));
    const nameInp = container.querySelector('#uid-screen-name');
    if (nameInp) nameInp.addEventListener('change', () => { state.screen.name = nameInp.value.trim() || '未命名畫面'; scheduleSave(); const badge = container.querySelector('#uid-save-badge'); if (badge) badge.textContent = '儲存中…'; });
    // UID10：畫面用途改了就立即存（不是連續輸入，不必 debounce）。
    const purposeScreenSel = container.querySelector('#uid-screen-purpose');
    if (purposeScreenSel) purposeScreenSel.addEventListener('change', () => {
      state.screen.purpose = purposeScreenSel.value || undefined;
      scheduleSave();
    });
    const markModeBtn = container.querySelector('#uid-mark-mode-btn');
    if (markModeBtn) markModeBtn.addEventListener('click', () => { state.markMode = !state.markMode; render(); });
    const dupBtn = container.querySelector('#uid-screen-dup');
    if (dupBtn) dupBtn.addEventListener('click', duplicateCurrentScreen);
    const saveTplBtn = container.querySelector('#uid-screen-save-template');
    if (saveTplBtn) saveTplBtn.addEventListener('click', saveScreenAsTemplate);
    const revisionsBtn = container.querySelector('#uid-screen-revisions');
    if (revisionsBtn) revisionsBtn.addEventListener('click', openRevisionsPanel);
    const delScreenBtn = container.querySelector('#uid-screen-del');
    if (delScreenBtn) delScreenBtn.addEventListener('click', requestDeleteCurrentScreen);
    // UID8 工具列：復原/重做、縮放、全螢幕編輯、全螢幕預覽、主題切換
    container.querySelectorAll('[data-uid-tool]').forEach(b => {
      b.addEventListener('click', () => setTool(b.getAttribute('data-uid-tool')));
    });
    const undoBtn = container.querySelector('#uid-undo');
    if (undoBtn) undoBtn.addEventListener('click', undo);
    const redoBtn = container.querySelector('#uid-redo');
    if (redoBtn) redoBtn.addEventListener('click', redo);
    const zoomOutBtn = container.querySelector('#uid-zoom-out');
    if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => setZoom((state.zoom || 1) / 1.2));
    const zoomInBtn = container.querySelector('#uid-zoom-in');
    if (zoomInBtn) zoomInBtn.addEventListener('click', () => setZoom((state.zoom || 1) * 1.2));
    const zoom100Btn = container.querySelector('#uid-zoom-100');
    if (zoom100Btn) zoom100Btn.addEventListener('click', () => setZoom(1));
    const zoomFitBtn = container.querySelector('#uid-zoom-fit');
    if (zoomFitBtn) zoomFitBtn.addEventListener('click', fitToWindow);
    const fsBtn = container.querySelector('#uid-fullscreen-btn');
    if (fsBtn) fsBtn.addEventListener('click', toggleCanvasFullscreen);
    const previewBtn = container.querySelector('#uid-preview-fullscreen-btn');
    if (previewBtn) previewBtn.addEventListener('click', enterPreviewFullscreen);
    const playBtn = container.querySelector('#uid-play-btn');
    if (playBtn) playBtn.addEventListener('click', enterPlayMode);
    const themeBtn = container.querySelector('#uid-theme-btn');
    if (themeBtn) themeBtn.addEventListener('click', () => {
      // 只切「畫布/元件預覽」的深淺色（平台整體主題由 header 那顆負責，兩者互不干擾）
      state.canvasTheme = canvasIsDark() ? 'light' : 'dark';
      render();
    });
    applyCanvasFullscreenClass();
    updateCanvasFullscreenIcon();
    bindCanvasEvents();
  }

  // UID11：重套挑選／逐張確認 疊層——與 state.mode 無關（可能開著疊層時使用者切了分頁），
  // 兩顆疊層互斥（同一時間只會有一個非 null），各自的節點存在才綁。
  const rpBackdrop = container.querySelector('#uid-restyle-picker-backdrop');
  if (rpBackdrop) {
    container.querySelectorAll('[data-restyle-screen]').forEach(cb => cb.addEventListener('change', () => {
      const id = cb.getAttribute('data-restyle-screen');
      if (cb.checked) state.restylePicker.selected.add(id); else state.restylePicker.selected.delete(id);
      render();
    }));
    container.querySelectorAll('[data-restyle-mode]').forEach(b => b.addEventListener('click', () => {
      state.restylePicker.mode = b.getAttribute('data-restyle-mode'); render();
    }));
    const cancelBtn = container.querySelector('#uid-restyle-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', closeRestylePicker);
    const startBtn = container.querySelector('#uid-restyle-start');
    if (startBtn) startBtn.addEventListener('click', startRestyle);
  }
  const rwBackdrop = container.querySelector('#uid-restyle-walk-backdrop');
  if (rwBackdrop) {
    const cancelBtn = container.querySelector('#uid-restyle-walk-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', cancelRestyleWalk);
    const skipBtn = container.querySelector('#uid-restyle-walk-skip');
    if (skipBtn) skipBtn.addEventListener('click', restyleWalkSkip);
    const applyBtn = container.querySelector('#uid-restyle-walk-apply');
    if (applyBtn) applyBtn.addEventListener('click', restyleWalkApply);
  }
  const revBackdrop = container.querySelector('#uid-revisions-backdrop');
  if (revBackdrop) {
    const closeBtn = container.querySelector('#uid-revisions-close');
    if (closeBtn) closeBtn.addEventListener('click', closeRevisionsPanel);
    container.querySelectorAll('[data-restore-rev]').forEach(b => b.addEventListener('click', () => restoreRevision(b.getAttribute('data-restore-rev'))));
  }
  // UID-55：刪畫面二次確認——預設焦點在「取消」（原生 confirm() 無法控制焦點，故用自訂疊層）。
  if (state.deleteScreenConfirm) {
    const cancelBtn = container.querySelector('#uid-delscreen-cancel');
    if (cancelBtn) { cancelBtn.addEventListener('click', cancelDeleteScreenConfirm); cancelBtn.focus(); }
    const confirmBtn = container.querySelector('#uid-delscreen-confirm');
    if (confirmBtn) confirmBtn.addEventListener('click', () => performDeleteScreen(state.deleteScreenConfirm.screenId));
  }

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

export function mount(root, ctx) {
  container = root;
  if (typeof window.showPanel === 'function') window.showPanel('__view_root__');
  root.classList.remove('hidden');
  if (typeof window.highlightMenuBtn === 'function') window.highlightMenuBtn('menu-uidesign');
  const pathEl = document.getElementById('header-file-path'); if (pathEl) pathEl.innerText = 'UI 設計系統';
  const titleEl = document.getElementById('header-file-title'); if (titleEl) titleEl.innerText = '元件庫 ＋ 設計畫布';
  const vscodeEl = document.getElementById('btn-vscode'); if (vscodeEl) vscodeEl.href = '#';
  const savedEl = document.getElementById('last-saved'); if (savedEl) savedEl.classList.add('hidden');
  const backEl = document.getElementById('btn-back'); if (backEl) backEl.classList.add('hidden');

  // UID8：全螢幕編輯的 fullscreenchange 監聽只綁一次（比照 whiteboard.js），平移用的
  // document 級滑鼠監聽也只在此綁一次，避免每次 render() 重綁疊加。
  canvasFullscreenChangeHandler = onDocFullscreenChange;
  document.addEventListener('fullscreenchange', canvasFullscreenChangeHandler);
  // UID16：事件橋接的 message 監聽只掛一次，四個播放面共用（見 fillReadOnlyFrames／onUidBridgeMessage）。
  uidBridgeMessageHandler = onUidBridgeMessage;
  window.addEventListener('message', uidBridgeMessageHandler);
  initPanDocListeners();

  loadAll();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

export function unmount() {
  if (state.savePending) saveScreenNow();
  if (state.flowSavePending) saveFlowNow();
  exitPreviewFullscreen();
  exitPlayMode();
  if (flowPresentOverlay) exitFlowPresent();
  state.flowPlay = null;
  state.flowId = null;
  state.flow = null;
  state.hotspotStepIdx = null;
  if (canvasFullscreenChangeHandler) { document.removeEventListener('fullscreenchange', canvasFullscreenChangeHandler); canvasFullscreenChangeHandler = null; }
  if (uidBridgeMessageHandler) { window.removeEventListener('message', uidBridgeMessageHandler); uidBridgeMessageHandler = null; }
  uidBridgeHandlerCtx = null;
  state.canvasFullscreen = false;
  if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (e) {} }
  if (panDocMoveHandler) { document.removeEventListener('mousemove', panDocMoveHandler); panDocMoveHandler = null; }
  if (panDocUpHandler) { document.removeEventListener('mouseup', panDocUpHandler); panDocUpHandler = null; }
  panState.active = false; panState.scrollEl = null;
  if (container) { container.classList.add('hidden'); container.innerHTML = ''; }
  container = null;
  state.selectedId = null;
  state.detail = null;
  state.mode = 'library';
  state.screenId = null;
  state.screen = null;
  state.selection = [];
  state.undoStack = [];
  state.redoStack = [];
  state._spaceDown = false;
  state.templates = [];
  state.templatesLoading = true;
  state.flows = [];
  state.flowsLoading = true;
  state.deleteScreenConfirm = null;
  state.hotspotScreenCache = {};
  // 注意：state._keyBound 刻意不重置——bindCanvasKeys() 的 document 級 keydown/keyup 監聽跟
  // 原本白板同一套「只綁一次」哲學，監聽器內部已用 state.mode/state.screen 判斷是否要處理，
  // unmount 後不會誤觸發；重置成 false 反而會在重新 mount 時疊加出第二份監聽器。
}

// SPEC-view-chat-context.md §3.1/§3.3 — 讓頭像對話知道目前在看哪個元件庫／哪顆元件／哪張畫面（人話描述，不吐內部 id）。
export function getChatContext() {
  if (state.mode === 'flows') {
    if (state.flow) {
      const label = 'UI 設計系統・UI操作演示・正在編輯「' + state.flow.name + '」（共 ' + (state.flow.steps || []).length + ' 步' + (state.flowPlay ? '，播放中' : '') + '）';
      return { kind: 'uidesign', key: 'uidesign:flow:' + state.flow.id, label, payload: { mode: 'flows', flowId: state.flow.id } };
    }
    const count = state.flows.length;
    const label = count ? ('UI 設計系統・UI操作演示（本工作區共 ' + count + ' 條流程）') : 'UI 設計系統・UI操作演示（這個工作區還沒有流程）';
    return { kind: 'uidesign', key: 'uidesign:flows:list', label, payload: { mode: 'flows' } };
  }
  if (state.mode === 'templates') {
    const count = state.templates.length;
    const filterLabel = state.templateFilterDevice === 'all' ? '全部' : deviceGroupLabel(state.templateFilterDevice);
    const label = count
      ? ('UI 設計系統・範本庫（本工作區共 ' + count + ' 個範本，目前篩選：' + filterLabel + '）')
      : 'UI 設計系統・範本庫（這個工作區還沒有範本）';
    return { kind: 'uidesign', key: 'uidesign:templates:list', label, payload: { mode: 'templates' } };
  }
  if (state.mode === 'canvas') {
    if (state.screen) {
      const sizeDesc = state.screen.unit === 'dp'
        ? ('尺寸模式・' + screenSizeLabel(state.screen))
        : deviceLabel(state.screen.device);
      const label = 'UI 設計系統・畫布・正在編輯畫面「' + state.screen.name + '」（' + sizeDesc + '，共 ' + (state.screen.elements || []).length + ' 個元件）';
      return { kind: 'uidesign', key: 'uidesign:screen:' + state.screen.id, label, payload: { mode: 'canvas', screenId: state.screen.id } };
    }
    const count = state.screens.length;
    const label = count ? ('UI 設計系統・畫布（本工作區共 ' + count + ' 張畫面，尚未開啟任一張）') : 'UI 設計系統・畫布（這個工作區還沒有畫面）';
    return { kind: 'uidesign', key: 'uidesign:canvas:list', label, payload: { mode: 'canvas' } };
  }
  const count = state.components.length;
  if (state.detail) {
    const label = 'UI 設計系統・正在編輯元件「' + state.detail.name + '」（分類：' + state.detail.category + '，共 ' + (state.detail.variants || []).length + ' 個變體）';
    return { kind: 'uidesign', key: 'uidesign:' + (state.detail.id || 'new'), label, payload: { mode: 'components', componentId: state.detail.id || null } };
  }
  const label = count ? ('UI 設計系統・元件庫（共 ' + count + ' 個元件）') : 'UI 設計系統・這個工作區還沒有元件庫';
  return { kind: 'uidesign', key: 'uidesign:list', label, payload: { mode: 'components' } };
}

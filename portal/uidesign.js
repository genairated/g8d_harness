'use strict';
// UI 設計系統 — L1 元件庫持久化（SPEC-ui-designer.md §5/§5.1，TASK.md §UID1）。
// D12 工作區隔離鐵則：資料只存在 <workspace>/.harness/uidesign/，不做全域回退、不讀其他工作區。
// 目錄結構（比照 whiteboards.js 的 index + 個別檔案 pattern）：
//   library.json        — 設計 token（顏色/間距/字級…）
//   index.json           — 元件清單索引（id/name/category/updatedAt…，不含 html/css 內文）
//   components/<id>.json — 元件 metadata（name/category/description/params/variants）
//   components/<id>.html — 元件真身 HTML（D1：真 HTML+CSS，非向量圖形）
//   components/<id>.css  — 元件樣式
const fs = require('fs');
const path = require('path');

function uidesignDir(root) { return path.join(root, '.harness', 'uidesign'); }
function libraryPath(root) { return path.join(uidesignDir(root), 'library.json'); }
function indexPath(root) { return path.join(uidesignDir(root), 'index.json'); }
function componentsDir(root) { return path.join(uidesignDir(root), 'components'); }
function componentMetaPath(root, id) { return path.join(componentsDir(root), id + '.json'); }
function componentHtmlPath(root, id) { return path.join(componentsDir(root), id + '.html'); }
function componentCssPath(root, id) { return path.join(componentsDir(root), id + '.css'); }

// SPEC-ui-designer.md §7 UID2 — L2 設計畫布（screens）。放在自己的 screens/index.json（而非頂層
// index.json，那個已被 UID1 元件清單占用），比照 whiteboards 的 index + 個別檔案 pattern。
function screensDir(root) { return path.join(uidesignDir(root), 'screens'); }
function screensIndexPath(root) { return path.join(screensDir(root), 'index.json'); }
function screenPath(root, id) { return path.join(screensDir(root), id + '.json'); }

// 設計 token 出廠預設（種子）——首次使用複製進工作區，之後該工作區自己改，不受平台升級覆寫。
function defaultTokens() {
  return {
    colors: {
      primary: '#0891b2',
      primaryHover: '#0e7490',
      text: '#1e293b',
      textMuted: '#64748b',
      bg: '#ffffff',
      border: '#e2e8f0',
      danger: '#dc2626'
    },
    spacing: { xs: '4px', sm: '8px', md: '16px', lg: '24px', xl: '32px' },
    fontSizes: { xs: '12px', sm: '13px', md: '14px', lg: '16px', xl: '20px' },
    radius: { sm: '4px', md: '8px', lg: '12px' }
  };
}

// 已存在則不覆寫（D12/UID-01）：只在目錄/檔案缺席時建立種子。
function ensureSeed(root) {
  const dir = uidesignDir(root);
  try { fs.mkdirSync(componentsDir(root), { recursive: true }); } catch (e) {}
  const libP = libraryPath(root);
  if (!fs.existsSync(libP)) {
    fs.writeFileSync(libP, JSON.stringify({ tokens: defaultTokens(), createdAt: new Date().toISOString() }, null, 2));
  }
  const idxP = indexPath(root);
  if (!fs.existsSync(idxP)) {
    fs.writeFileSync(idxP, JSON.stringify([], null, 2));
  }
  return dir;
}

function readLibrary(root) {
  ensureSeed(root);
  try {
    const data = JSON.parse(fs.readFileSync(libraryPath(root), 'utf8'));
    if (!data.tokens) data.tokens = defaultTokens();
    return data;
  } catch (e) { return { tokens: defaultTokens() }; }
}

function writeLibrary(root, lib) {
  try { fs.mkdirSync(uidesignDir(root), { recursive: true }); } catch (e) {}
  fs.writeFileSync(libraryPath(root), JSON.stringify(lib, null, 2));
}

function readIndex(root) {
  ensureSeed(root);
  try {
    const data = JSON.parse(fs.readFileSync(indexPath(root), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (e) { return []; }
}

function writeIndex(root, list) {
  try { fs.mkdirSync(uidesignDir(root), { recursive: true }); } catch (e) {}
  fs.writeFileSync(indexPath(root), JSON.stringify(list, null, 2));
}

function readComponent(root, id) {
  const metaP = componentMetaPath(root, id);
  if (!fs.existsSync(metaP)) return null;
  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaP, 'utf8')); } catch (e) { return null; }
  let html = '', css = '';
  try { html = fs.readFileSync(componentHtmlPath(root, id), 'utf8'); } catch (e) {}
  try { css = fs.readFileSync(componentCssPath(root, id), 'utf8'); } catch (e) {}
  return Object.assign({ id, html, css }, meta);
}

function writeComponent(root, id, component) {
  try { fs.mkdirSync(componentsDir(root), { recursive: true }); } catch (e) {}
  const { html, css, ...meta } = component;
  fs.writeFileSync(componentMetaPath(root, id), JSON.stringify(meta, null, 2));
  fs.writeFileSync(componentHtmlPath(root, id), html || '');
  fs.writeFileSync(componentCssPath(root, id), css || '');
}

function deleteComponent(root, id) {
  for (const p of [componentMetaPath(root, id), componentHtmlPath(root, id), componentCssPath(root, id)]) {
    try { fs.unlinkSync(p); } catch (e) {}
  }
  const list = readIndex(root).filter(c => c.id !== id);
  writeIndex(root, list);
}

function genComponentId() { return 'uic_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

// ── UID2 畫面（screens/<id>.json）─────────────────────────────────────────
// SPEC-ui-designer.md §4 裝置預設。id 供 screen.device 使用；custom 允許畫面自帶 frame 覆寫。
const DEVICE_PRESETS = [
  { id: 'desktop-1920', label: '桌機 FHD 1920×1080', width: 1920, height: 1080, group: 'desktop' },
  { id: 'desktop-1440', label: '桌機 1440×900', width: 1440, height: 900, group: 'desktop' },
  { id: 'desktop-1280', label: '桌機 1280×800', width: 1280, height: 800, group: 'desktop' },
  { id: 'tablet-1024', label: '平板 1024×768（橫）', width: 1024, height: 768, group: 'tablet' },
  { id: 'tablet-768', label: '平板 768×1024（直）', width: 768, height: 1024, group: 'tablet' },
  { id: 'phone-390', label: '手機 390×844', width: 390, height: 844, group: 'phone' },
  { id: 'pda-480', label: '工業 PDA 480×800', width: 480, height: 800, group: 'pda' },
  { id: 'pda-720', label: '工業 PDA 720×1280', width: 720, height: 1280, group: 'pda' },
  { id: 'custom', label: '自訂尺寸', width: 800, height: 600, group: 'custom' }
];

// 使用者自訂尺寸（UID-09b）：存在工作區的 devices.json，跟出廠預設併起來供選單使用。
// D12：只存當前工作區，不做全域回退——A 工作區加的尺寸不會跑到 B 工作區。
function customDevicesPath(root) { return path.join(uidesignDir(root), 'devices.json'); }

function readCustomDevices(root) {
  try {
    const data = JSON.parse(fs.readFileSync(customDevicesPath(root), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (e) { return []; }
}

function writeCustomDevices(root, list) {
  try { fs.mkdirSync(uidesignDir(root), { recursive: true }); } catch (e) {}
  fs.writeFileSync(customDevicesPath(root), JSON.stringify(list, null, 2));
}

// 出廠預設 + 工作區自訂，前者在前。custom:true 讓前端知道哪些可刪。
function listDevices(root) {
  return DEVICE_PRESETS.concat(readCustomDevices(root).map(d => Object.assign({}, d, { custom: true })));
}

function findDevice(root, id) {
  return listDevices(root).find(d => d.id === id) || null;
}

// 同尺寸不重複新增（避免選單越用越長）：寬高一樣就沿用既有那筆。
function addCustomDevice(root, { label, width, height }) {
  const w = Math.max(64, Math.min(10000, Math.round(Number(width) || 0)));
  const h = Math.max(64, Math.min(10000, Math.round(Number(height) || 0)));
  if (!w || !h) throw new Error('寬高必須是有效數字');
  const list = readCustomDevices(root);
  const dup = list.find(d => d.width === w && d.height === h);
  if (dup) return Object.assign({}, dup, { custom: true });
  const preset = DEVICE_PRESETS.find(d => d.group !== 'custom' && d.width === w && d.height === h);
  if (preset) return preset;
  const device = {
    id: 'uid_dev_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    label: String(label || '').trim() || ('自訂 ' + w + '×' + h),
    width: w, height: h, group: 'custom', custom: true,
    createdAt: new Date().toISOString()
  };
  list.push(device);
  writeCustomDevices(root, list);
  return device;
}

function deleteCustomDevice(root, id) {
  writeCustomDevices(root, readCustomDevices(root).filter(d => d.id !== id));
}

function ensureScreenSeed(root) {
  const dir = screensDir(root);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const idxP = screensIndexPath(root);
  if (!fs.existsSync(idxP)) fs.writeFileSync(idxP, JSON.stringify([], null, 2));
  return dir;
}

function readScreenIndex(root) {
  ensureScreenSeed(root);
  try {
    const data = JSON.parse(fs.readFileSync(screensIndexPath(root), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (e) { return []; }
}

function writeScreenIndex(root, list) {
  try { fs.mkdirSync(screensDir(root), { recursive: true }); } catch (e) {}
  fs.writeFileSync(screensIndexPath(root), JSON.stringify(list, null, 2));
}

function readScreen(root, id) {
  const p = screenPath(root, id);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function writeScreen(root, id, screen) {
  try { fs.mkdirSync(screensDir(root), { recursive: true }); } catch (e) {}
  fs.writeFileSync(screenPath(root, id), JSON.stringify(screen, null, 2));
}

function deleteScreen(root, id) {
  try { fs.unlinkSync(screenPath(root, id)); } catch (e) {}
  const list = readScreenIndex(root).filter(s => s.id !== id);
  writeScreenIndex(root, list);
}

function genScreenId() { return 'uis_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

// ── UID6 設計指南（L6）：guideline.md（人可讀可改）＋ decisions.json（機器可讀決策表）─────
// SPEC-ui-designer.md §6.1、§7 UID6。D12：只存當前工作區，出廠預設當「種子」——首次使用複製進
// 工作區，之後該工作區自己改，平台升級不覆寫已存在的檔案。
function guidelineDir(root) { return path.join(uidesignDir(root), 'guideline'); }
function guidelineMdPath(root) { return path.join(guidelineDir(root), 'guideline.md'); }
function decisionsPath(root) { return path.join(guidelineDir(root), 'decisions.json'); }

function defaultGuidelineMd() {
  return [
    '# UI 設計指南（本工作區）',
    '',
    '> 這是規則檔，不是 AI 自由心證——Hana 建 UI 前會依這份文件與同目錄 `decisions.json` 提問、選元件。',
    '> 你可以直接編輯這個檔案；改了之後只影響本工作區，不會被平台升級覆蓋，也不會影響其他工作區。',
    '',
    '## 1. 版面網格',
    '- 以 **8px 網格**為基準（元件尺寸、間距盡量落在 8 的倍數；小數點間距如 4px 只用於圖示/邊框微調）。',
    '- 內容區左右邊界：桌機 24px、平板 16px、手機/PDA 12px。',
    '',
    '## 2. 間距刻度（呼應 `library.json` 的 `spacing` token）',
    '| 代號 | 值 | 用途 |',
    '|---|---|---|',
    '| xs | 4px | 圖示與文字間、緊密群組內 |',
    '| sm | 8px | 同群組元件間 |',
    '| md | 16px | 區塊內段落間 |',
    '| lg | 24px | 區塊與區塊之間 |',
    '| xl | 32px | 大段落／頁首頁尾留白 |',
    '',
    '## 3. 色彩語意（呼應 `library.json` 的 `colors` token）',
    '- `primary`：主要操作（提交、確認、主要按鈕）。',
    '- `danger`：破壞性操作（刪除、不可逆動作），一律搭配二次確認。',
    '- `text` / `textMuted`：內文與次要說明文字，不要用 `primary` 當內文色。',
    '- `border`：分隔線、輸入框邊框，不要用來當強調色。',
    '- 顏色只用來輔助辨識，**不可作為唯一的狀態辨識依據**（無障礙：色盲/黑白列印仍要看得懂），狀態一律加文字或圖示。',
    '',
    '## 4. 字級階梯（呼應 `library.json` 的 `fontSizes` token）',
    '| 代號 | 值 | 用途 |',
    '|---|---|---|',
    '| xs | 12px | 輔助說明、時間戳 |',
    '| sm | 13px | 表格內文、次要標籤 |',
    '| md | 14px | 一般內文、表單標籤（預設） |',
    '| lg | 16px | 卡片標題、強調文字 |',
    '| xl | 20px | 頁面標題 |',
    '',
    '## 5. 無障礙',
    '- 可互動元件（按鈕/輸入框/連結）**最小點擊區域 44×44px**（觸控裝置常見門檻），文字連結不夠大時用透明 padding 補足。',
    '- 文字與背景對比度至少符合 WCAG AA（一般文字 4.5:1、大字 3:1）。',
    '- 所有表單欄位需有可見標籤（不要只用 placeholder 當標籤，會在使用者開始輸入後消失、造成困惑）。',
    '',
    '## 6. PDA／工業手持機特例',
    '- **大按鈕**：主要操作按鈕高度 ≥ 56px（比一般桌機/手機大一號），方便戴手套點擊或掃碼後快速確認。',
    '- **實體按鍵區**：畫面下緣或側邊需預留給實體按鍵（掃描鍵、確認鍵）對應的安全區，畫面內容不可被實體外殼遮住。',
    '- **單手操作**：常用操作集中在畫面下半部，避免要求跨手指伸展。',
    '- 對應範本：範本庫（L5）的「PDA 掃碼作業頁」骨架已依此規則設計，可直接套用。',
    ''
  ].join('\n');
}

// 決策表出廠預設（種子）——對應 spec §6.1 的範例表，逐條可由指揮官增修。
// 結構：情境（situation）+ 提問（questions，Hana 會依序問）+ 規則（rules：when 描述 → result 選用結果）。
function defaultDecisions() {
  return [
    {
      id: 'single-select',
      situation: '從一組固定選項中選一個',
      questions: ['選項有幾個？', '需要同時看到全部嗎？', '畫面寬鬆還是擁擠？'],
      rules: [
        { when: '2–3 個且需一眼看完', result: 'Radio 清單' },
        { when: '4–7 個', result: 'Segmented / Radio' },
        { when: '8 個以上或畫面擁擠', result: '下拉選單' },
        { when: '上百筆', result: '可搜尋的下拉' }
      ]
    },
    {
      id: 'multi-select',
      situation: '從一組固定選項中選多個',
      questions: ['選項數量？', '是否需要全選？', '需要比較欄位嗎？'],
      rules: [
        { when: '少量', result: 'Checkbox 清單' },
        { when: '大量', result: '多選下拉 + 已選標籤' },
        { when: '需比較欄位', result: 'Grid 勾選' }
      ]
    },
    {
      id: 'data-list',
      situation: '呈現一批資料',
      questions: ['每筆要看幾個欄位？', '要排序/篩選/批次操作嗎？', '行動裝置也要看嗎？'],
      rules: [
        { when: '多欄位＋要排序', result: '資料表格' },
        { when: '少欄位＋重瀏覽', result: '卡片清單' },
        { when: '手機/PDA', result: '清單列 + 明細頁' }
      ]
    },
    {
      id: 'status-field',
      situation: '狀態類欄位',
      questions: ['狀態值固定嗎？幾種？', '使用者常改嗎？'],
      rules: [
        { when: '固定 2–3 種且常改', result: 'Radio / 切換' },
        { when: '固定多種', result: '下拉選單' },
        { when: '唯讀', result: '狀態標籤（Badge）' }
      ]
    },
    {
      id: 'tri-state',
      situation: '是/否/忽略 這類三態',
      questions: ['是否有預設值？', '誤觸代價高嗎？'],
      rules: [
        { when: '三態且需明示', result: 'Radio 清單' },
        { when: '純開關（僅二態）', result: 'Switch' }
      ]
    },
    {
      id: 'date-amount-input',
      situation: '日期、數量、金額等輸入',
      questions: ['有範圍限制嗎？', '需不需要快速選（今天/本月）？'],
      rules: [
        { when: '需要範圍', result: '區間選擇器' },
        { when: '需要快速選', result: '日期選擇器（含常用捷徑）' },
        { when: '單純數值、無特殊需求', result: '純輸入框' }
      ]
    }
  ];
}

// 已存在則不覆寫（D12 種子原則）：只在目錄/檔案缺席時建立。
function ensureGuidelineSeed(root) {
  const dir = guidelineDir(root);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const mdP = guidelineMdPath(root);
  if (!fs.existsSync(mdP)) fs.writeFileSync(mdP, defaultGuidelineMd());
  const decP = decisionsPath(root);
  if (!fs.existsSync(decP)) fs.writeFileSync(decP, JSON.stringify(defaultDecisions(), null, 2));
  return dir;
}

function readGuidelineMd(root) {
  ensureGuidelineSeed(root);
  try { return fs.readFileSync(guidelineMdPath(root), 'utf8'); } catch (e) { return defaultGuidelineMd(); }
}

function writeGuidelineMd(root, content) {
  try { fs.mkdirSync(guidelineDir(root), { recursive: true }); } catch (e) {}
  fs.writeFileSync(guidelineMdPath(root), String(content == null ? '' : content));
}

function readDecisions(root) {
  ensureGuidelineSeed(root);
  try {
    const data = JSON.parse(fs.readFileSync(decisionsPath(root), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (e) { return defaultDecisions(); }
}

function writeDecisions(root, list) {
  try { fs.mkdirSync(guidelineDir(root), { recursive: true }); } catch (e) {}
  fs.writeFileSync(decisionsPath(root), JSON.stringify(Array.isArray(list) ? list : [], null, 2));
}

// ── UID5 範本庫（L5）──────────────────────────────────────────────────────
// SPEC-ui-designer.md §6.2、§7 UID5。D9：範本只存結構與元件引用，不存死內容。
// 內建骨架範本（UID-19）不能綁定某工作區才有的元件，所以先以一組固定 id 的「骨架佔位元件」
// （真 HTML+CSS，比照 D1）當種子複製進元件庫，範本本身只是這些佔位元件的排版組合——
// 這樣範本仍然遵守「元件引用」而非另開一套渲染邏輯，套用/預覽/原型播放完全複用既有渲染鏈。
function templatesDir(root) { return path.join(uidesignDir(root), 'templates'); }
function templatesIndexPath(root) { return path.join(templatesDir(root), 'index.json'); }
function templatePath(root, id) { return path.join(templatesDir(root), id + '.json'); }

// 固定 id：ensureTemplatesSeed 用「id 是否已存在」判斷要不要種——不會覆寫指揮官已改過的版本。
const PLACEHOLDER_COMPONENTS = [
  {
    id: 'uic_seed_title', name: '骨架・標題', category: '骨架佔位',
    description: '範本種子元件：畫面/區塊標題文字。', params: [{ key: 'text', label: '標題文字', default: '畫面標題' }],
    variants: [{ name: 'Default', values: {} }],
    html: '<div class="ph-title">{{text}}</div>',
    css: '.ph-title{font-size:var(--ui-font-xl,20px);font-weight:700;color:var(--ui-color-text,#1e293b);padding:8px 4px;}'
  },
  {
    id: 'uic_seed_text', name: '骨架・內文', category: '骨架佔位',
    description: '範本種子元件：一般說明/內文文字。', params: [{ key: 'text', label: '內文文字', default: '內文文字' }],
    variants: [{ name: 'Default', values: {} }],
    html: '<div class="ph-text">{{text}}</div>',
    css: '.ph-text{font-size:var(--ui-font-md,14px);color:var(--ui-color-textMuted,#64748b);padding:4px;}'
  },
  {
    id: 'uic_seed_field', name: '骨架・欄位', category: '骨架佔位',
    description: '範本種子元件：欄位名稱 + 值/輸入提示。',
    params: [{ key: 'label', label: '欄位名稱', default: '欄位名稱' }, { key: 'value', label: '欄位值／提示', default: '' }],
    variants: [{ name: 'Default', values: {} }],
    html: '<div class="ph-field"><div class="ph-field-label">{{label}}</div><div class="ph-field-value">{{value}}</div></div>',
    css: '.ph-field{padding:8px 12px;border:1px solid var(--ui-color-border,#e2e8f0);border-radius:var(--ui-radius-md,8px);background:var(--ui-color-bg,#fff);box-sizing:border-box;height:100%;}.ph-field-label{font-size:var(--ui-font-xs,12px);color:var(--ui-color-textMuted,#64748b);margin-bottom:2px;}.ph-field-value{font-size:var(--ui-font-md,14px);color:var(--ui-color-text,#1e293b);min-height:1.2em;}'
  },
  {
    id: 'uic_seed_button', name: '骨架・按鈕', category: '骨架佔位',
    description: '範本種子元件：主要操作按鈕。', params: [{ key: 'text', label: '按鈕文字', default: '按鈕' }],
    variants: [{ name: 'Default', values: {} }],
    html: '<button class="ph-btn">{{text}}</button>',
    css: '.ph-btn{width:100%;height:100%;padding:0 16px;border-radius:var(--ui-radius-md,8px);border:none;background:var(--ui-color-primary,#0891b2);color:#fff;font-size:var(--ui-font-md,14px);font-weight:600;cursor:pointer;box-sizing:border-box;}'
  },
  {
    id: 'uic_seed_searchbar', name: '骨架・搜尋框', category: '骨架佔位',
    description: '範本種子元件：搜尋輸入框。', params: [{ key: 'placeholder', label: '提示文字', default: '搜尋…' }],
    variants: [{ name: 'Default', values: {} }],
    html: '<div class="ph-search">🔍 {{placeholder}}</div>',
    css: '.ph-search{padding:8px 12px;border:1px solid var(--ui-color-border,#e2e8f0);border-radius:var(--ui-radius-md,8px);color:var(--ui-color-textMuted,#64748b);font-size:var(--ui-font-md,14px);background:var(--ui-color-bg,#fff);box-sizing:border-box;height:100%;display:flex;align-items:center;}'
  },
  {
    id: 'uic_seed_listrow', name: '骨架・清單列', category: '骨架佔位',
    description: '範本種子元件：清單中的一列。', params: [{ key: 'text', label: '清單項目文字', default: '清單項目' }],
    variants: [{ name: 'Default', values: {} }],
    html: '<div class="ph-row">{{text}}</div>',
    css: '.ph-row{padding:10px 12px;border-bottom:1px solid var(--ui-color-border,#e2e8f0);font-size:var(--ui-font-md,14px);color:var(--ui-color-text,#1e293b);box-sizing:border-box;height:100%;display:flex;align-items:center;}'
  },
  {
    id: 'uic_seed_card', name: '骨架・統計卡', category: '骨架佔位',
    description: '範本種子元件：儀表板統計卡片。',
    params: [{ key: 'label', label: '指標名稱', default: '指標名稱' }, { key: 'value', label: '數值', default: '0' }],
    variants: [{ name: 'Default', values: {} }],
    html: '<div class="ph-card"><div class="ph-card-label">{{label}}</div><div class="ph-card-value">{{value}}</div></div>',
    css: '.ph-card{padding:16px;border:1px solid var(--ui-color-border,#e2e8f0);border-radius:var(--ui-radius-lg,12px);background:var(--ui-color-bg,#fff);box-sizing:border-box;height:100%;}.ph-card-label{font-size:var(--ui-font-sm,13px);color:var(--ui-color-textMuted,#64748b);margin-bottom:6px;}.ph-card-value{font-size:24px;font-weight:700;color:var(--ui-color-primary,#0891b2);}'
  },
  {
    id: 'uic_seed_scanarea', name: '骨架・掃碼區', category: '骨架佔位',
    description: '範本種子元件：PDA 掃碼作業的取景框（依設計指南 PDA 特例）。',
    params: [{ key: 'label', label: '提示文字', default: '將條碼對準框內掃描' }],
    variants: [{ name: 'Default', values: {} }],
    html: '<div class="ph-scan">📷<br>{{label}}</div>',
    css: '.ph-scan{height:100%;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;border:2px dashed var(--ui-color-border,#e2e8f0);border-radius:var(--ui-radius-md,8px);color:var(--ui-color-textMuted,#64748b);font-size:var(--ui-font-md,14px);text-align:center;}'
  }
];

function ph(id) { return { componentId: id }; }

// 骨架種子範本的元件實例輔助：z 依呼叫順序遞增，link 一律 null（跳轉留給指揮官在畫布上自己接）。
// UID-41：role/slot 選填——套用範本本身仍照舊（UID-18 邏輯不變），但這兩個欄位是「依範本重套」
// 對位引擎唯一吃得到的資訊。slot 用 spec §7.3.1 建議的可讀名稱（title/primary-action/search…），
// role 沿用 UID-37 既有的 ROLE_OPTS 詞彙（見 portal/views/uidesign.js），兩邊詞彙必須一致才對得起來。
function tplEl(zRef, componentId, x, y, width, height, overrides, role, slot) {
  return {
    id: 'el_seed_' + (zRef.n++).toString(36),
    componentId, x, y, width, height, z: zRef.n, variantIndex: 0,
    overrides: overrides || {}, link: null,
    role: role || undefined, slot: slot || undefined
  };
}

function seedTemplateDefs() {
  const mk = (fn) => { const z = { n: 0 }; return fn(z); };
  return [
    {
      id: 'uit_seed_login', name: '登入頁', deviceGroup: 'desktop', device: 'desktop-1440',
      tags: ['登入', '表單'],
      frame: { width: 1440, height: 900 },
      elements: mk(z => [
        tplEl(z, 'uic_seed_title', 520, 180, 400, 48, { text: '登入' }, 'header', 'title'),
        tplEl(z, 'uic_seed_field', 520, 250, 400, 60, { label: '帳號', value: '' }, 'field', 'field-account'),
        tplEl(z, 'uic_seed_field', 520, 320, 400, 60, { label: '密碼', value: '' }, 'field', 'field-password'),
        tplEl(z, 'uic_seed_button', 520, 400, 400, 48, { text: '登入' }, 'action', 'primary-action')
      ])
    },
    {
      id: 'uit_seed_list_search', name: '清單＋搜尋', deviceGroup: 'desktop', device: 'desktop-1440',
      tags: ['清單', '搜尋', '資料'],
      frame: { width: 1440, height: 900 },
      elements: mk(z => [
        tplEl(z, 'uic_seed_title', 40, 32, 300, 40, { text: '清單標題' }, 'header', 'title'),
        tplEl(z, 'uic_seed_searchbar', 40, 84, 1360, 44, { placeholder: '搜尋…' }, 'field', 'search'),
        tplEl(z, 'uic_seed_listrow', 40, 144, 1360, 48, { text: '清單項目 1' }, 'list-item'),
        tplEl(z, 'uic_seed_listrow', 40, 192, 1360, 48, { text: '清單項目 2' }, 'list-item'),
        tplEl(z, 'uic_seed_listrow', 40, 240, 1360, 48, { text: '清單項目 3' }, 'list-item'),
        tplEl(z, 'uic_seed_listrow', 40, 288, 1360, 48, { text: '清單項目 4' }, 'list-item'),
        tplEl(z, 'uic_seed_listrow', 40, 336, 1360, 48, { text: '清單項目 5' }, 'list-item')
      ])
    },
    {
      id: 'uit_seed_detail', name: '主檔明細', deviceGroup: 'desktop', device: 'desktop-1440',
      tags: ['明細', '表單'],
      frame: { width: 1440, height: 900 },
      elements: mk(z => [
        tplEl(z, 'uic_seed_title', 40, 32, 400, 40, { text: '主檔名稱' }, 'header', 'title'),
        tplEl(z, 'uic_seed_field', 40, 100, 660, 64, { label: '欄位一', value: '' }, 'field'),
        tplEl(z, 'uic_seed_field', 740, 100, 660, 64, { label: '欄位二', value: '' }, 'field'),
        tplEl(z, 'uic_seed_field', 40, 180, 660, 64, { label: '欄位三', value: '' }, 'field'),
        tplEl(z, 'uic_seed_field', 740, 180, 660, 64, { label: '欄位四', value: '' }, 'field'),
        tplEl(z, 'uic_seed_button', 40, 280, 200, 48, { text: '儲存' }, 'action', 'primary-action')
      ])
    },
    {
      id: 'uit_seed_dashboard', name: '儀表板', deviceGroup: 'desktop', device: 'desktop-1440',
      tags: ['儀表板', '統計'],
      frame: { width: 1440, height: 900 },
      elements: mk(z => [
        tplEl(z, 'uic_seed_title', 40, 32, 300, 40, { text: '儀表板' }, 'header', 'title'),
        tplEl(z, 'uic_seed_card', 40, 100, 320, 140, { label: '指標一', value: '0' }, 'card'),
        tplEl(z, 'uic_seed_card', 380, 100, 320, 140, { label: '指標二', value: '0' }, 'card'),
        tplEl(z, 'uic_seed_card', 40, 260, 320, 140, { label: '指標三', value: '0' }, 'card'),
        tplEl(z, 'uic_seed_card', 380, 260, 320, 140, { label: '指標四', value: '0' }, 'card')
      ])
    },
    {
      id: 'uit_seed_pda_scan', name: 'PDA 掃碼作業頁', deviceGroup: 'pda', device: 'pda-480',
      tags: ['PDA', '掃碼', '工業手持機'],
      frame: { width: 480, height: 800 },
      elements: mk(z => [
        tplEl(z, 'uic_seed_title', 20, 20, 440, 40, { text: '掃碼作業' }, 'header', 'title'),
        // scanarea 沒有精確對應的 role 詞彙（ROLE_OPTS 無「掃描區」），取意義最接近的 media，
        // 靠 slot='scan-area' 精準對位；純 role 對位時會退而求其次配到任何 role=media 的來源元件。
        tplEl(z, 'uic_seed_scanarea', 20, 80, 440, 400, { label: '將條碼對準框內掃描' }, 'media', 'scan-area'),
        tplEl(z, 'uic_seed_text', 20, 500, 440, 32, { text: '掃描結果：—' }, 'text'),
        // 依 SPEC §6.1/PDA 特例：主要操作按鈕高度 ≥ 56px，方便戴手套點擊或掃碼後快速確認。
        tplEl(z, 'uic_seed_button', 20, 560, 440, 56, { text: '確認' }, 'action', 'primary-action')
      ])
    }
  ];
}

// 極輕量縮圖：不起無頭瀏覽器截圖（避免種子/另存為範本這種常見動作要背一份 Playwright 依賴），
// 改用畫框比例＋元件方框畫一張 SVG 當版面縮圖，足以在範本清單一眼看出結構。data URI，不落地成檔案。
function genThumbnailSvg(frame, elements) {
  const w = Math.max(1, frame.width), h = Math.max(1, frame.height);
  const rects = (elements || []).map(el =>
    '<rect x="' + el.x + '" y="' + el.y + '" width="' + el.width + '" height="' + el.height + '" rx="4" fill="#cbd5e1" stroke="#94a3b8" stroke-width="2"/>'
  ).join('');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '">'
    + '<rect x="0" y="0" width="' + w + '" height="' + h + '" fill="#f8fafc"/>' + rects + '</svg>';
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}

// 已存在則不覆寫（D12 種子原則）：判斷單位是「id 是否已存在」——指揮官改過名字/內容也不會被種回去。
function ensureTemplatesSeed(root) {
  ensureSeed(root); // 骨架佔位元件要寫進元件庫，先確保元件庫目錄存在
  const dir = templatesDir(root);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}

  // 1) 骨架佔位元件：逐一檢查，缺哪個補哪個，不動已存在的（含指揮官自己改過的同名 id）。
  const compIndex = readIndex(root);
  const compIndexIds = new Set(compIndex.map(c => c.id));
  let compIndexChanged = false;
  for (const def of PLACEHOLDER_COMPONENTS) {
    if (fs.existsSync(componentMetaPath(root, def.id))) continue;
    const now = new Date().toISOString();
    const { id, ...meta } = def;
    writeComponent(root, id, Object.assign({}, meta, { createdAt: now, updatedAt: now }));
    if (!compIndexIds.has(id)) {
      compIndex.push({ id, name: def.name, category: def.category, description: def.description, updatedAt: now });
      compIndexIds.add(id);
      compIndexChanged = true;
    }
  }
  if (compIndexChanged) writeIndex(root, compIndex);

  // 2) 範本索引：沒有就建空的；骨架範本逐一檢查缺哪個補哪個（同樣不覆寫既有檔）。
  const idxP = templatesIndexPath(root);
  let tplIndex = [];
  if (fs.existsSync(idxP)) {
    try { tplIndex = JSON.parse(fs.readFileSync(idxP, 'utf8')); if (!Array.isArray(tplIndex)) tplIndex = []; } catch (e) { tplIndex = []; }
  }
  const tplIds = new Set(tplIndex.map(t => t.id));
  let tplIndexChanged = false;
  for (const def of seedTemplateDefs()) {
    if (fs.existsSync(templatePath(root, def.id))) continue;
    const now = new Date().toISOString();
    const template = Object.assign({}, def, { source: 'seed', createdAt: now, updatedAt: now, thumbnail: genThumbnailSvg(def.frame, def.elements) });
    fs.writeFileSync(templatePath(root, def.id), JSON.stringify(template, null, 2));
    if (!tplIds.has(def.id)) {
      tplIndex.push({ id: def.id, name: template.name, deviceGroup: template.deviceGroup, device: template.device, tags: template.tags, source: 'seed', updatedAt: now, thumbnail: template.thumbnail });
      tplIds.add(def.id);
      tplIndexChanged = true;
    }
  }
  if (tplIndexChanged || !fs.existsSync(idxP)) writeTemplateIndexRaw(root, tplIndex);
  return dir;
}

function writeTemplateIndexRaw(root, list) {
  try { fs.mkdirSync(templatesDir(root), { recursive: true }); } catch (e) {}
  fs.writeFileSync(templatesIndexPath(root), JSON.stringify(list, null, 2));
}

function readTemplateIndex(root) {
  ensureTemplatesSeed(root);
  try {
    const data = JSON.parse(fs.readFileSync(templatesIndexPath(root), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (e) { return []; }
}

function writeTemplateIndex(root, list) { writeTemplateIndexRaw(root, list); }

function readTemplate(root, id) {
  const p = templatePath(root, id);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function writeTemplate(root, id, template) {
  try { fs.mkdirSync(templatesDir(root), { recursive: true }); } catch (e) {}
  fs.writeFileSync(templatePath(root, id), JSON.stringify(template, null, 2));
}

function deleteTemplate(root, id) {
  try { fs.unlinkSync(templatePath(root, id)); } catch (e) {}
  const list = readTemplateIndex(root).filter(t => t.id !== id);
  writeTemplateIndex(root, list);
}

function genTemplateId() { return 'uit_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

// 依畫框寬高判斷屬於哪個裝置分類，供範本篩選與縮圖分組使用（比照 DEVICE_PRESETS 的 group）。
function deviceGroupOf(root, deviceId) {
  const d = findDevice(root, deviceId);
  return (d && d.group) || 'custom';
}

// ── UID11 依範本重套（Restyle，SPEC-ui-designer.md §7.3.2，TASK.md UID-41～44）──────────────
// 對位優先序：slot（精準）→ role（次之，同一 role 有多個來源時依畫面原順序逐一消耗，池化取用）。
// 保留原則：對到的元件一律沿用「範本這格已知的欄位鍵」去挑要不要覆蓋——只搬「範本這格本來就有」
// 的鍵（例如 text/label/value/placeholder），不會亂塞來源元件裡範本這格根本不認得的鍵。
// 對不到的：來源元件原樣保留（疊在新結構之後，位置/大小不變）；範本這格則照範本自己的預設內容
// 產出（不無中生有硬套來源資料）。兩邊都誠實列進回報清單，不靜默丟棄或亂猜（UID-44）。
function genElId() { return 'el_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function restyleMatchScreen(screen, template) {
  const srcEls = (screen.elements || []).slice();
  const used = new Array(srcEls.length).fill(false);
  function findBySlot(slot) {
    if (!slot) return -1;
    return srcEls.findIndex((el, i) => !used[i] && el.slot === slot);
  }
  function findByRole(role) {
    if (!role) return -1;
    return srcEls.findIndex((el, i) => !used[i] && el.role === role);
  }

  const outElements = [];
  const unmatchedFromTemplate = [];
  let z = 0;
  (template.elements || []).forEach((tEl) => {
    z += 1;
    let srcIdx = findBySlot(tEl.slot);
    let matchedBy = srcIdx !== -1 ? 'slot' : null;
    if (srcIdx === -1) { srcIdx = findByRole(tEl.role); matchedBy = srcIdx !== -1 ? 'role' : null; }
    const overrides = Object.assign({}, tEl.overrides || {});
    let link = tEl.link || null;
    let sourceElementId = null;
    if (srcIdx !== -1) {
      used[srcIdx] = true;
      const srcEl = srcEls[srcIdx];
      sourceElementId = srcEl.id;
      const srcOverrides = srcEl.overrides || {};
      const tOverrideKeys = tEl.overrides || {};
      Object.keys(srcOverrides).forEach((k) => {
        if (Object.prototype.hasOwnProperty.call(tOverrideKeys, k)) overrides[k] = srcOverrides[k];
      });
      if (srcEl.link) link = srcEl.link; // 跳轉設定也是「這個畫面獨有的資料」，一併保留
    }
    outElements.push({
      id: genElId(),
      componentId: tEl.componentId,
      x: tEl.x, y: tEl.y, width: tEl.width, height: tEl.height,
      z, variantIndex: tEl.variantIndex || 0,
      overrides, link,
      role: tEl.role || undefined, slot: tEl.slot || undefined
    });
    if (srcIdx === -1) {
      unmatchedFromTemplate.push({
        slot: tEl.slot || null, role: tEl.role || null,
        reasonLabel: '範本的「' + (tEl.slot || tEl.role || '（未標記）') + '」區塊在原畫面找不到對應內容，已套用範本預設內容（可能需要手動填寫）'
      });
    } else {
      outElements[outElements.length - 1]._matchedBy = matchedBy; // 供呼叫端組報表，寫回前會被剝除
      outElements[outElements.length - 1]._sourceElementId = sourceElementId;
    }
  });

  const unmatchedFromScreen = [];
  srcEls.forEach((el, i) => {
    if (used[i]) return;
    let reason, reasonLabel;
    if (el.slot) { reason = 'slot-not-in-template'; reasonLabel = '找不到對應 slot（' + el.slot + '）'; }
    else if (el.role) { reason = 'role-not-in-template'; reasonLabel = '範本無此角色（' + el.role + '）'; }
    else { reason = 'unmarked'; reasonLabel = '未標記'; }
    unmatchedFromScreen.push({ elementId: el.id, componentId: el.componentId, reason, reasonLabel });
    z += 1;
    outElements.push(Object.assign({}, el, { z })); // 原樣保留，疊在新結構之上，絕不丟棄
  });

  const matchedCount = outElements.filter(el => el._matchedBy).length;
  const cleanElements = outElements.map((el) => {
    const { _matchedBy, _sourceElementId, ...rest } = el;
    return rest;
  });
  return {
    elements: cleanElements,
    matchedCount,
    templateElementCount: (template.elements || []).length,
    unmatchedFromScreen, unmatchedFromTemplate
  };
}

// 重套版本（UID-43 可逆）：套用前把原畫面完整快照存進 screens/revisions/<screenId>/<revId>.json，
// UI 提供一鍵退回。退回本身也先把「即將被取代的當下版本」存一份，讓退回動作自己也可再退回。
function screenRevisionsDir(root, screenId) { return path.join(screensDir(root), 'revisions', screenId); }
function screenRevisionsIndexPath(root, screenId) { return path.join(screenRevisionsDir(root, screenId), 'index.json'); }
function screenRevisionPath(root, screenId, revId) { return path.join(screenRevisionsDir(root, screenId), revId + '.json'); }
function genRevisionId() { return 'uir_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

function saveScreenRevision(root, screenId, screenSnapshot, meta) {
  const dir = screenRevisionsDir(root, screenId);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const id = genRevisionId();
  const now = new Date().toISOString();
  const revision = Object.assign({ id, screenId, savedAt: now }, meta || {}, { snapshot: screenSnapshot });
  fs.writeFileSync(screenRevisionPath(root, screenId, id), JSON.stringify(revision, null, 2));
  const idxP = screenRevisionsIndexPath(root, screenId);
  let idx = [];
  if (fs.existsSync(idxP)) {
    try { idx = JSON.parse(fs.readFileSync(idxP, 'utf8')); if (!Array.isArray(idx)) idx = []; } catch (e) { idx = []; }
  }
  idx.push({ id, savedAt: now, reason: (meta && meta.reason) || 'restyle', label: (meta && meta.label) || '' });
  fs.writeFileSync(idxP, JSON.stringify(idx, null, 2));
  return revision;
}

function listScreenRevisions(root, screenId) {
  const idxP = screenRevisionsIndexPath(root, screenId);
  if (!fs.existsSync(idxP)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(idxP, 'utf8'));
    return Array.isArray(data) ? data.slice().reverse() : []; // 新的在前
  } catch (e) { return []; }
}

function readScreenRevision(root, screenId, revId) {
  const p = screenRevisionPath(root, screenId, revId);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

// ── UID9 以「螢幕尺寸」設計（密度無關單位，D13）──────────────────────────────
// SPEC-ui-designer.md §7.2、D13。業界標準：Android dp（1dp = 1px @160dpi）／iOS pt（@1x）。
// scale（密度倍率）＝ PPI / 160；PPI（每吋像素數）＝ 對角像素數 ÷ 對角吋數
//   對角像素數 = sqrt(nativeWidth² + nativeHeight²)。
// dp 畫框尺寸 = 實體像素 ÷ scale——同吋數、不同解析度但同比例的機型會算出同一個 dp 畫框。
// D12：機型表當「種子」複製進工作區（models.json），之後工作區自行增修，平台升級不覆寫。
function modelsPath(root) { return path.join(uidesignDir(root), 'models.json'); }

function computeScale(diagonalInch, nativeWidth, nativeHeight) {
  const di = Number(diagonalInch), w = Number(nativeWidth), h = Number(nativeHeight);
  if (!(di > 0) || !(w > 0) || !(h > 0)) return { ppi: 0, scale: 1 };
  const ppi = Math.sqrt(w * w + h * h) / di;
  return { ppi, scale: ppi / 160 };
}

// 出廠預設機型表（種子）。誠實提醒：這裡一律用 PPI/160 精算，不強行湊成官方標示的整數倍率
// （例如 Apple 對 Retina 的「2x/3x」是依機型固定的 point 倍率，不是連續 PPI/160 換算，兩者
// 可能對不太起來——算出來的數字才是本系統實際用來換算 dp 畫框的依據，見 SPEC §7.2 誠實提醒）。
function defaultModels() {
  const mk = (id, label, diagonalInch, nativeWidth, nativeHeight) => {
    const { ppi, scale } = computeScale(diagonalInch, nativeWidth, nativeHeight);
    return {
      id, label, diagonalInch, nativeWidth, nativeHeight,
      ppi: Math.round(ppi * 10) / 10, scale: Math.round(scale * 100) / 100
    };
  };
  return [
    mk('model_phone_61', '手機 6.1 吋（1179×2556）', 6.1, 1179, 2556),
    mk('model_phone_67', '手機 6.7 吋（1290×2796）', 6.7, 1290, 2796),
    mk('model_laptop_13', '筆電 13 吋（1920×1080）', 13, 1920, 1080),
    mk('model_laptop_13_retina', '筆電 13 吋 Retina（2560×1600）', 13, 2560, 1600),
    mk('model_pda_4', '工業 PDA 4 吋（480×800）', 4, 480, 800)
  ];
}

function ensureModelsSeed(root) {
  const p = modelsPath(root);
  if (!fs.existsSync(p)) {
    try { fs.mkdirSync(uidesignDir(root), { recursive: true }); } catch (e) {}
    fs.writeFileSync(p, JSON.stringify(defaultModels(), null, 2));
  }
  return p;
}

function readModels(root) {
  ensureModelsSeed(root);
  try {
    const data = JSON.parse(fs.readFileSync(modelsPath(root), 'utf8'));
    return Array.isArray(data) ? data : defaultModels();
  } catch (e) { return defaultModels(); }
}

function writeModels(root, list) {
  try { fs.mkdirSync(uidesignDir(root), { recursive: true }); } catch (e) {}
  fs.writeFileSync(modelsPath(root), JSON.stringify(Array.isArray(list) ? list : [], null, 2));
}

function findModel(root, id) {
  return readModels(root).find(m => m.id === id) || null;
}

function addModel(root, { label, diagonalInch, nativeWidth, nativeHeight }) {
  const di = Number(diagonalInch);
  const w = Math.round(Number(nativeWidth));
  const h = Math.round(Number(nativeHeight));
  if (!(di > 0) || !w || !h) throw new Error('對角吋數與實體解析度必須是有效數字');
  const { ppi, scale } = computeScale(di, w, h);
  const model = {
    id: 'uid_model_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    label: String(label || '').trim() || (di + ' 吋 ' + w + '×' + h),
    diagonalInch: di, nativeWidth: w, nativeHeight: h,
    ppi: Math.round(ppi * 10) / 10, scale: Math.round(scale * 100) / 100,
    custom: true, createdAt: new Date().toISOString()
  };
  const list = readModels(root);
  list.push(model);
  writeModels(root, list);
  return model;
}

function deleteModel(root, id) {
  writeModels(root, readModels(root).filter(m => m.id !== id));
}

// ── UID12 情境流程（Scenario Flows，SPEC-ui-designer.md §7.4，TASK.md UID-46～50/UID-55）──
// D12 工作區隔離鐵則：一律只存 <workspace>/.harness/uidesign/flows/，不做全域回退。
// 比照 screens 的 index + 個別檔案 pattern：flows/index.json（輕量清單）+ flows/<id>.json（完整內容）。
// 步驟欄位 screenId/caption/hotspot{x,y,w,h}/note；screenId 指向的畫面被刪除時不修改儲存的資料
// 本身（不做级联刪除／改寫），失效判定在讀取時（server.js GET /api/ui/flows/:id）現算現標。
function flowsDir(root) { return path.join(uidesignDir(root), 'flows'); }
function flowsIndexPath(root) { return path.join(flowsDir(root), 'index.json'); }
function flowPath(root, id) { return path.join(flowsDir(root), id + '.json'); }

function ensureFlowSeed(root) {
  const dir = flowsDir(root);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const idxP = flowsIndexPath(root);
  if (!fs.existsSync(idxP)) fs.writeFileSync(idxP, JSON.stringify([], null, 2));
  return dir;
}

function readFlowIndex(root) {
  ensureFlowSeed(root);
  try {
    const data = JSON.parse(fs.readFileSync(flowsIndexPath(root), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (e) { return []; }
}

function writeFlowIndex(root, list) {
  try { fs.mkdirSync(flowsDir(root), { recursive: true }); } catch (e) {}
  fs.writeFileSync(flowsIndexPath(root), JSON.stringify(list, null, 2));
}

function readFlow(root, id) {
  const p = flowPath(root, id);
  if (!fs.existsSync(p)) return null;
  try {
    const flow = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(flow.steps)) flow.steps = [];
    return flow;
  } catch (e) { return null; }
}

function writeFlow(root, id, flow) {
  try { fs.mkdirSync(flowsDir(root), { recursive: true }); } catch (e) {}
  fs.writeFileSync(flowPath(root, id), JSON.stringify(flow, null, 2));
}

function deleteFlow(root, id) {
  try { fs.unlinkSync(flowPath(root, id)); } catch (e) {}
  const list = readFlowIndex(root).filter(f => f.id !== id);
  writeFlowIndex(root, list);
}

function genFlowId() { return 'uif_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

// UID-55：刪畫面前先擋一次。掃過本工作區所有流程的所有步驟，找出引用了這個 screenId 的
// {flowId, flowName, stepIndex}（stepIndex 1-based，供前端顯示「第 N 步」）。一律由伺服器判定，
// 前端不自行推測；即使某個流程的 <id>.json 讀不到（例如手動刪過檔）也不擋、直接略過該筆。
function findScreenUsageInFlows(root, screenId) {
  const usage = [];
  readFlowIndex(root).forEach((entry) => {
    const flow = readFlow(root, entry.id);
    if (!flow) return;
    (flow.steps || []).forEach((step, i) => {
      if (step && step.screenId === screenId) usage.push({ flowId: flow.id, flowName: flow.name, stepIndex: i + 1 });
    });
  });
  return usage;
}

// ── UID13 情境流程離線匯出（SPEC-ui-designer.md §7.4.4）──────────────────────────────────
// 目標：客戶收到一個資料夾，用瀏覽器直接開 index.html 就能看完整條流程，不連本系統、不裝東西。
// 做法：所有素材（元件 html/css、畫面資料）在「產生當下」直接烘進單一 index.html——每張畫面的
// 每個元件變成一個 <iframe srcdoc="...">，srcdoc 屬性值是完整字串，不靠執行期 JS 去 fetch 元件
// 資料。這樣天生離線，唯一可能連網的破口是元件/畫面內容裡有人寫死了外部 http(s) 網址（例如
// <img src="https://...">）——這種情況匯出前掃出來列成「無法內嵌」告知使用者，不靜默略過
// （UID-53 誠實原則）。D12：產物只寫當前工作區 <workspace>/.harness/uidesign/exports/。
function exportsDir(root) { return path.join(uidesignDir(root), 'exports'); }
function exportFlowDir(root, flowId) { return path.join(exportsDir(root), flowId); }

function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function substituteTpl(tpl, values) {
  return String(tpl || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, key) => (key in values) ? escHtml(values[key]) : m);
}

function tokenCssVarsStr(tokens) {
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

// UID17 §7.5.2 D15（伺服器端鏡射 portal/views/uidesign.js 的 elementEventsFor）：缺 events 欄位
// 時退化成舊有 link 寫法，供匯出包烘進 JSON 資料使用。不改寫 el.link 本身。
function elementEventsForExport(el) {
  if (el.events && el.events.length) return el.events;
  if (el.link && el.link.targetScreenId) return [{ on: 'click', action: 'navigate', target: el.link.targetScreenId }];
  return [];
}

function elementValuesFor(el, component) {
  const variant = (component.variants || [])[el.variantIndex || 0] || { name: '', values: {} };
  const defaults = {};
  (component.params || []).forEach(p => { defaults[p.key] = p.default; });
  return Object.assign({ variant: (variant.name || '').toLowerCase() }, defaults, variant.values || {}, el.overrides || {});
}

// 元件 html/css 裡指到外部網址的地方（http(s):// 開頭的 src=/href=/url()）——匯出後離線開啟
// 連不到，不能靜默內嵌，掃出來讓使用者知道（UID-53）。目前元件/畫面模型沒有上傳素材的機制，
// 內容本身就是文字（html/css/json），照原樣寫進 srcdoc 即天生離線；這個掃描是唯一的破口防線。
function findExternalRefs(text) {
  const found = [];
  const re = /(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']|url\(\s*["']?(https?:\/\/[^"')]+)["']?\s*\)/gi;
  let m;
  while ((m = re.exec(String(text || '')))) { const u = m[1] || m[2]; if (found.indexOf(u) === -1) found.push(u); }
  return found;
}

// UID16 D14（伺服器端版本，鏡射 portal/views/uidesign.js 的 buildUidBridgeScript）：匯出包是
// 靜態 HTML、沒有執行期能問伺服器，橋接腳本必須在產生當下就烘死進 srcdoc；語意與線上版一致：
// click/change/input 經 postMessage 回報，不加 allow-same-origin／allow-forms。
function buildUidBridgeScriptStatic(elId) {
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

function buildElementSrcdoc(component, values, tokens, dark, bridgeElId) {
  const html = substituteTpl(component.html, values);
  const cls = dark ? 'dark' : '';
  return '<!doctype html><html class="' + cls + '"><head><meta charset="utf-8">'
    + '<style>' + tokenCssVarsStr(tokens) + '</style>'
    + '<style>html,body{margin:0;padding:0;font-family:system-ui,-apple-system,"Noto Sans TC",sans-serif;background:transparent;color:var(--ui-color-text,#1e293b);}'
    + 'html.dark,body.dark{color:#e2e8f0;}'
    + 'body{display:flex;align-items:center;justify-content:center;width:100%;height:100%;overflow:hidden;}</style>'
    + '<style>' + (component.css || '') + '</style>'
    + '</head><body class="' + cls + '">' + html
    + (bridgeElId ? buildUidBridgeScriptStatic(bridgeElId) : '')
    + '</body></html>';
}

// 把一張畫面靜態烘成 <div>…</div>（比照 portal/views/uidesign.js 的 renderReadOnlyFrameHtml／
// renderReadOnlyElementsHtml，但這裡的 iframe srcdoc 是產生當下就寫死成屬性字串——匯出包沒有
// 執行期 JS 去抓元件資料，不能沿用「先留空 iframe 再用 JS 填」的做法）。externalRefs 供呼叫端
// 收集掃到的外部網址；hotspot（若有）用跟熱點編輯器一致的原生 frame 座標疊在最後一層。
// mustAdvance（UID-64／UID15）：true 時這顆熱點框要能被匯出包的播放器點擊以前進，
// 疊一層 uid-x-hotspot-advance（pointer-events:auto + 呼吸動畫，樣式定義在 renderFlowExportHtml
// 的 <style> 裡）；false 時維持原本純展示用途（pointer-events:none，不可點）。
// UID16：iframe 一律解鎖互動（不再 pointer-events:none）並烘進橋接腳本，讓匯出包也是「播放即
// 真網頁」——按鈕可點、輸入框可打字。熱區框（D16）降級為純提示，不再 pointer-events:auto 攔截
// 點擊；「有沒有點到熱區」改由 renderFlowExportHtml 的播放器依橋接回報的座標判定。
function buildStaticFrameHtml(root, screen, tokens, dark, hotspot, externalRefs, mustAdvance) {
  const fw = Math.round(screen.frame.width), fh = Math.round(screen.frame.height);
  const els = (screen.elements || []).slice().sort((a, b) => (a.z || 0) - (b.z || 0));
  const elsHtml = els.map((el) => {
    const component = readComponent(root, el.componentId);
    if (!component) return '';
    findExternalRefs(component.html).concat(findExternalRefs(component.css)).forEach(u => { if (externalRefs.indexOf(u) === -1) externalRefs.push(u); });
    const values = elementValuesFor(el, component);
    const srcdoc = buildElementSrcdoc(component, values, tokens, dark, el.id);
    // UID17：data-uid-wrap 供匯出包播放器的 toggle 動作找到「這個元件實例的外層容器」切換顯示/隱藏
    // （鏡射線上版 renderReadOnlyElementsHtml 的 data-ro-wrap）。
    return '<div data-uid-wrap="' + escHtml(String(el.id)) + '" style="position:absolute;left:' + el.x + 'px;top:' + el.y + 'px;width:' + el.width + 'px;height:' + el.height + 'px;">'
      + '<iframe data-uid-el="' + escHtml(String(el.id)) + '" sandbox="allow-scripts" srcdoc="' + escHtml(srcdoc) + '" style="width:100%;height:100%;border:0;background:transparent;"></iframe>'
      + '</div>';
  }).join('');
  const hotspotHtml = hotspot
    ? '<div class="' + (mustAdvance ? 'uid-x-hotspot uid-x-hotspot-advance' : 'uid-x-hotspot') + '" style="position:absolute;border:2px solid #f59e0b;background:rgba(245,158,11,0.15);left:' + hotspot.x + 'px;top:' + hotspot.y + 'px;width:' + hotspot.w + 'px;height:' + hotspot.h + 'px;pointer-events:none;' + (mustAdvance ? 'cursor:pointer;border-radius:4px;' : '') + '"></div>'
    : '';
  return '<div style="position:relative;width:' + fw + 'px;height:' + fh + 'px;background:' + (dark ? '#0f172a' : '#fff') + ';box-shadow:0 0 0 1px rgba(0,0,0,.08),0 8px 24px rgba(0,0,0,.24);flex-shrink:0;">'
    + elsHtml + hotspotHtml + '</div>';
}

// 產生整份離線 index.html（封面頁＋簡報模式播放器：上一步／下一步／進度／字幕／熱點高亮／
// 深淺色切換）。JS 只做 DOM 顯示切換（步驟前進、主題屬性），畫面內容全部是產生當下就烘好的
// 靜態 HTML，不靠 fetch。只收有效步驟（screenId 對應畫面存在）；失效步驟列在 skipped 供告知。
function renderFlowExportHtml(flow, stepsData, skipped) {
  const stepsHtml = stepsData.map((s, i) =>
    '<div class="uid-x-step" data-idx="' + i + '">'
    + '<div class="uid-x-theme-variant uid-x-theme-light">' + s.lightFrame + '</div>'
    + '<div class="uid-x-theme-variant uid-x-theme-dark">' + s.darkFrame + '</div>'
    + '</div>'
  ).join('');
  // mustAdvance 隨每步一併烘進 JS 資料，讓匯出包自己判斷是否停用下一步／攔截鍵盤（UID15）——
  // 靜態 HTML 沒有伺服器可問，資料必須在產生當下就決定好、寫死進 script。
  // UID17：screenId／elements[].events 一併烘進，讓匯出包自己執行 navigate/toast/toggle。
  const capsJson = JSON.stringify(stepsData.map(s => ({ caption: s.caption, mustAdvance: !!s.mustAdvance, elements: s.elements || [], hotspot: s.hotspot || null, screenId: s.screenId || null }))).replace(/</g, '\\u003c');
  const warnHtml = skipped.length
    ? '<div class="uid-x-warn">⚠ 有 ' + skipped.length + ' 個步驟的畫面已不存在，匯出時已略過：第 ' + skipped.map(s => s.index).join('、') + ' 步。</div>'
    : '';
  return '<!doctype html><html><head><meta charset="utf-8"><title>UI操作演示 - ' + escHtml(flow.name) + '</title>'
    + '<style>'
    + 'html,body{margin:0;padding:0;font-family:system-ui,-apple-system,"Noto Sans TC",sans-serif;}'
    + 'body{background:#f8fafc;color:#1e293b;min-height:100vh;display:flex;flex-direction:column;}'
    + 'body[data-theme="dark"]{background:#0f172a;color:#e2e8f0;}'
    + '.uid-x-cover{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px 20px;}'
    + '.uid-x-cover .uid-x-kicker{font-size:11px;letter-spacing:.05em;color:#0891b2;font-weight:700;margin:0 0 8px;}'
    + '.uid-x-cover h1{font-size:22px;margin:0 0 12px;}'
    + '.uid-x-cover p{max-width:520px;white-space:pre-wrap;color:#64748b;font-size:13px;line-height:1.7;margin:0 0 20px;}'
    + 'body[data-theme="dark"] .uid-x-cover p{color:#94a3b8;}'
    + '.uid-x-warn{max-width:520px;margin:0 0 20px;padding:10px 14px;border-radius:8px;background:#fef3c7;color:#92400e;font-size:12px;text-align:left;}'
    + '.uid-x-btn{padding:10px 22px;border-radius:10px;background:#0891b2;color:#fff;border:0;font-size:14px;font-weight:600;cursor:pointer;}'
    + '.uid-x-btn:hover{background:#0e7490;}.uid-x-btn:disabled{opacity:.4;cursor:default;}'
    + '.uid-x-player{display:none;flex:1;flex-direction:column;min-height:100vh;}'
    + '.uid-x-topbar{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;flex-shrink:0;}'
    + '.uid-x-topbar .name{font-size:12px;opacity:.7;}'
    + '.uid-x-controls{display:flex;gap:8px;flex-wrap:wrap;}'
    + '.uid-x-controls button{padding:6px 12px;border-radius:8px;border:0;background:#334155;color:#fff;font-size:12px;cursor:pointer;}'
    + '.uid-x-controls button:disabled{opacity:.35;cursor:default;}'
    + '.uid-x-stage{flex:1;overflow:auto;display:flex;}'
    + '.uid-x-stage-inner{margin:auto;position:relative;padding:16px;}'
    + '.uid-x-step{display:none;}.uid-x-step.active{display:block;}'
    + '.uid-x-theme-variant{display:none;}'
    + 'body[data-theme="light"] .uid-x-step.active .uid-x-theme-light{display:block;}'
    + 'body[data-theme="dark"] .uid-x-step.active .uid-x-theme-dark{display:block;}'
    + '.uid-x-caption{padding:14px 20px;text-align:center;font-size:13px;flex-shrink:0;}'
    + '.uid-x-caption .uid-x-hint{color:#f59e0b;font-weight:600;}'
    + '.uid-x-progress{padding:0 20px 14px;text-align:center;font-size:11px;opacity:.6;flex-shrink:0;}'
    + '@keyframes uid-x-hotspot-pulse{0%,100%{box-shadow:0 0 0 0 rgba(245,158,11,.55);}50%{box-shadow:0 0 0 8px rgba(245,158,11,0);}}'
    + '.uid-x-hotspot-advance{animation:uid-x-hotspot-pulse 1.6s ease-in-out infinite;}'
    + '</style></head>'
    + '<body data-theme="light">'
    + '<div id="uid-x-cover" class="uid-x-cover">'
    + '<div class="uid-x-kicker">UI操作演示</div>'
    + '<h1>' + escHtml(flow.name) + '</h1>'
    + (flow.description ? ('<p>' + escHtml(flow.description) + '</p>') : '')
    + warnHtml
    + '<button id="uid-x-start" class="uid-x-btn"' + (stepsData.length ? '' : ' disabled') + '>' + (stepsData.length ? '開始瀏覽 ▶' : '這條流程目前沒有可播放的步驟') + '</button>'
    + '</div>'
    + '<div id="uid-x-player" class="uid-x-player">'
    + '<div class="uid-x-topbar"><span class="name">' + escHtml(flow.name) + '</span>'
    + '<div class="uid-x-controls">'
    + '<button id="uid-x-theme">切換深淺色</button>'
    + '<button id="uid-x-fullscreen">全螢幕</button>'
    + '<button id="uid-x-prev">◀ 上一步</button>'
    + '<button id="uid-x-next">下一步 ▶</button>'
    + '</div></div>'
    + '<div class="uid-x-stage"><div class="uid-x-stage-inner">' + stepsHtml + '</div></div>'
    + '<div class="uid-x-caption" id="uid-x-caption"></div>'
    + '<div class="uid-x-progress" id="uid-x-progress"></div>'
    + '</div>'
    + '<script>(function(){'
    + 'var steps = ' + capsJson + ';'
    + 'var idx = 0;'
    + 'var stepEls = document.querySelectorAll(".uid-x-step");'
    + 'var captionEl = document.getElementById("uid-x-caption");'
    + 'var progressEl = document.getElementById("uid-x-progress");'
    + 'var prevBtn = document.getElementById("uid-x-prev");'
    + 'var nextBtn = document.getElementById("uid-x-next");'
    + 'function paint(){'
    + '  stepEls.forEach(function(el,i){ el.classList.toggle("active", i===idx); });'
    + '  var cur = steps[idx];'
    + '  captionEl.innerHTML = cur ? (escText(cur.caption) + (cur.mustAdvance ? \' <span class="uid-x-hint">・請點擊畫面上的指示位置繼續</span>\' : "")) : "";'
    + '  progressEl.textContent = steps.length ? ((idx+1) + " / " + steps.length) : "";'
    + '  prevBtn.disabled = idx<=0; nextBtn.disabled = idx>=steps.length-1 || (cur && cur.mustAdvance);'
    + '}'
    + 'function escText(s){ var d=document.createElement("div"); d.textContent = s||""; return d.innerHTML; }'
    + 'function goTo(n){ idx = Math.max(0, Math.min(steps.length-1, n)); paint(); }'
    + 'prevBtn.addEventListener("click", function(){ goTo(idx-1); });'
    + 'nextBtn.addEventListener("click", function(){ if (!(steps[idx] && steps[idx].mustAdvance)) goTo(idx+1); });'
    // UID16：熱區已降級為 pointer-events:none 純提示，改由橋接（postMessage）回報的點擊座標
    // 判定是否落在熱區矩形內；驗證來源真的是目前這一步、目前這個主題底下的某個元件 iframe，
    // 忽略其他來源（比照線上播放面 onUidBridgeMessage 的驗證方式）。
    + 'window.addEventListener("message", function(ev){'
    + '  var msg = ev.data;'
    + '  if (!msg || msg.uidBridge !== true) return;'
    + '  var cur = steps[idx];'
    + '  if (!cur || !cur.mustAdvance || !cur.hotspot) return;'
    + '  var activeStepEl = stepEls[idx];'
    + '  if (!activeStepEl) return;'
    + '  var frames = activeStepEl.querySelectorAll("[data-uid-el]");'
    + '  var matched = false;'
    + '  for (var i=0;i<frames.length;i++){ if (frames[i].getAttribute("data-uid-el")===msg.elId && frames[i].contentWindow===ev.source) { matched = true; break; } }'
    + '  if (!matched) return;'
    + '  var elMeta = null;'
    + '  for (var j=0;j<cur.elements.length;j++){ if (cur.elements[j].id === msg.elId) { elMeta = cur.elements[j]; break; } }'
    + '  if (!elMeta) return;'
    + '  var nx = elMeta.x + (msg.x||0), ny = elMeta.y + (msg.y||0), h = cur.hotspot;'
    + '  if (nx>=h.x && nx<=h.x+h.w && ny>=h.y && ny<=h.y+h.h) goTo(idx+1);'
    + '});'
    + 'document.getElementById("uid-x-theme").addEventListener("click", function(){'
    + '  var b = document.body; b.setAttribute("data-theme", b.getAttribute("data-theme")==="dark" ? "light" : "dark");'
    + '});'
    + 'document.getElementById("uid-x-fullscreen").addEventListener("click", function(){'
    + '  if (document.fullscreenElement) { document.exitFullscreen(); }'
    + '  else if (document.documentElement.requestFullscreen) { document.documentElement.requestFullscreen().catch(function(){}); }'
    + '});'
    + 'document.addEventListener("keydown", function(ev){'
    + '  if (document.getElementById("uid-x-player").style.display === "none") return;'
    + '  if (ev.key === "ArrowRight" || ev.key === " ") { ev.preventDefault(); if (!(steps[idx] && steps[idx].mustAdvance)) goTo(idx+1); }'
    + '  else if (ev.key === "ArrowLeft") { goTo(idx-1); }'
    + '  else if (ev.key === "Escape" && document.fullscreenElement) { document.exitFullscreen(); }'
    + '});'
    + 'var startBtn = document.getElementById("uid-x-start");'
    + 'startBtn.addEventListener("click", function(){'
    + '  document.getElementById("uid-x-cover").style.display = "none";'
    + '  document.getElementById("uid-x-player").style.display = "flex";'
    + '  paint();'
    + '});'
    + '})();</script>'
    + '</body></html>';
}

// 計算一次匯出（不寫檔）：組出完整 html 字串＋失效步驟清單＋掃到的外部網址清單。
// GET /api/ui/flows/:id/export-check 與 POST /api/ui/flows/:id/export 共用這個函式，
// 前者只回報告不落地、後者算完再寫檔——確保「先檢查再決定要不要匯出」跟「實際匯出」看到同一份判定。
function computeFlowExport(root, flowId) {
  const flow = readFlow(root, flowId);
  if (!flow) return null;
  const tokens = readLibrary(root).tokens;
  const externalRefs = [];
  const skipped = [];
  const stepsData = [];
  (flow.steps || []).forEach((step, i) => {
    const screen = step && step.screenId ? readScreen(root, step.screenId) : null;
    if (!screen) { skipped.push({ index: i + 1, caption: (step && step.caption) || '' }); return; }
    const mustAdvance = !!(step.advance === 'hotspot' && step.hotspot);
    const lightFrame = buildStaticFrameHtml(root, screen, tokens, false, step.hotspot, externalRefs, mustAdvance);
    const darkFrame = buildStaticFrameHtml(root, screen, tokens, true, step.hotspot, externalRefs, mustAdvance);
    // UID16：熱區判定改在瀏覽器端用橋接座標算，播放器需要每步的元件位置（id/x/y/w/h，export
    // 不支援 dp 呈現切換，恆為原生像素、不必乘 presentScale）與 hotspot 矩形一併烘進資料。
    // UID17：一併烘進每個元件的 events（含 link 退化寫法），供匯出包播放器執行 navigate/toast/
    // toggle；screenId 供 navigate 反查「目標畫面是不是這條演示的某一步」（不含在內就無法導覽，
    // 見 renderFlowExportHtml 的誠實 console 提示）。
    const elementsMeta = (screen.elements || []).map(el => ({ id: el.id, x: el.x, y: el.y, width: el.width, height: el.height, events: elementEventsForExport(el) }));
    stepsData.push({ caption: step.caption || '', lightFrame, darkFrame, mustAdvance, elements: elementsMeta, hotspot: step.hotspot || null, screenId: step.screenId });
  });
  const html = renderFlowExportHtml(flow, stepsData, skipped);
  return { flow, html, stepCount: stepsData.length, skipped, externalRefs };
}

function writeFlowExport(root, flowId, computed) {
  const dir = exportFlowDir(root, flowId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), computed.html);
  return dir;
}

module.exports = {
  uidesignDir, libraryPath, indexPath, componentsDir,
  defaultTokens, ensureSeed,
  readLibrary, writeLibrary,
  readIndex, writeIndex,
  readComponent, writeComponent, deleteComponent,
  genComponentId,
  // UID2
  DEVICE_PRESETS, screensDir, screensIndexPath, screenPath,
  customDevicesPath, readCustomDevices, writeCustomDevices,
  listDevices, findDevice, addCustomDevice, deleteCustomDevice,
  ensureScreenSeed, readScreenIndex, writeScreenIndex,
  readScreen, writeScreen, deleteScreen, genScreenId,
  // UID6
  guidelineDir, guidelineMdPath, decisionsPath,
  defaultGuidelineMd, defaultDecisions, ensureGuidelineSeed,
  readGuidelineMd, writeGuidelineMd, readDecisions, writeDecisions,
  // UID5
  templatesDir, templatesIndexPath, templatePath, PLACEHOLDER_COMPONENTS,
  ensureTemplatesSeed, readTemplateIndex, writeTemplateIndex,
  readTemplate, writeTemplate, deleteTemplate, genTemplateId,
  genThumbnailSvg, deviceGroupOf,
  // UID9
  modelsPath, computeScale, defaultModels, ensureModelsSeed,
  readModels, writeModels, findModel, addModel, deleteModel,
  // UID11
  genElId, restyleMatchScreen,
  screenRevisionsDir, saveScreenRevision, listScreenRevisions, readScreenRevision,
  // UID12
  flowsDir, flowsIndexPath, flowPath, ensureFlowSeed,
  readFlowIndex, writeFlowIndex, readFlow, writeFlow, deleteFlow, genFlowId,
  findScreenUsageInFlows,
  // UID13
  exportsDir, exportFlowDir, computeFlowExport, writeFlowExport
};

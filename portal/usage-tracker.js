// usage-tracker.js — §UA 用量記錄層（SPEC-usage-analytics.md）
//
// 職責：
//   1. parseClaudeCliOutput()：Claude Code `--output-format json` 輸出的「單一解析函式」。
//      三個呼叫點（server.js 的 chatViaClaude / _spawnCliPrintOnce / _tgSpawnClaude）都必須呼叫
//      這同一支，不得各寫一份。解析失敗（非合法 JSON／缺欄位）一律退回「整段當純文字回覆」
//      ，tokens 記為 null、source 記為 'unavailable' —— 絕不可讓回覆變空白（UA 最大風險點）。
//   2. recordUsageEvent()：append-only 寫入 `<workspace>/.harness/runtime/usage/YYYY-MM.jsonl`。
//   3. Codex 近似值（本機 rollout 紀錄）／Gemini（官方無資料，一律 unavailable，不得補 0）。
//   4. 查詢層：queryEvents / querySummary / queryControlChart（規格 §3.3），工作區隔離採
//      path.resolve()＋小寫正規化、null 工作區＝傳入的 defaultRoot（呼叫端應傳 WORKSPACE_ROOT）。
//
// 不依賴 server.js 任何東西（除了唯讀 require model-quota.js 的既有匯出函式找 Codex rollout
// 檔案路徑，不改它一行）；可被鏡射測試直接 require，不會 listen 任何埠。

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

let modelQuota = null;
function lazyModelQuota() {
  if (!modelQuota) {
    try { modelQuota = require('./model-quota'); } catch (e) { modelQuota = { findLatestCodexRolloutFile: () => null }; }
  }
  return modelQuota;
}

const MAX_EVENTS = 2000; // UA-4：/api/usage/events 回傳上限，超過回 truncated:true（不得靜默截斷）

function genId() {
  return 'ua_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
}

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

// 供應商代號對齊規格 §3.1（claude | codex | agy）。內部各處原本用 'gemini' 當 provider 字串
// （沿用既有 chat 引擎慣例），記錄落檔時統一轉成規格要求的 'agy'；未知值原樣放行，不擋。
function mapProviderId(internal) {
  if (internal === 'gemini') return 'agy';
  return internal;
}

// ---------------------------------------------------------------------------
// UA-1: 唯一的 Claude CLI JSON 輸出解析函式
// ---------------------------------------------------------------------------
// Claude Code `--output-format json` 的成功輸出大致形如：
//   { type:'result', subtype:'success', result:'<最終回覆文字>',
//     usage:{ input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens },
//     total_cost_usd, duration_ms, ... }
// 防線（UA-1 的紅線）：任何一步偏離預期（不是合法 JSON／不是物件／沒有字串型 result）一律整段
// 退回「把原始輸出當純文字」；cleanFn（通常是 server.js 的 cleanCliOutput）用來清掉 ANSI 等雜訊，
// 省略時等於不清。拿到合法 result 但 usage 缺失/型別不對時，文字仍用 result（真的有拿到），
// 只有 tokens 記為 null、source 記為 'unavailable' —— 這樣「有字可顯示的狀況」不會被錯殺成空白。
function parseClaudeCliOutput(raw, cleanFn) {
  const clean = typeof cleanFn === 'function' ? cleanFn : (s) => s;
  const rawStr = (raw === null || raw === undefined) ? '' : String(raw);
  const trimmed = rawStr.trim();
  const textFallback = () => {
    const cleaned = clean(rawStr);
    const t = (typeof cleaned === 'string' ? cleaned : rawStr).trim();
    return { text: t, usage: null, costUsd: null, source: 'unavailable' };
  };
  if (!trimmed) return { text: '', usage: null, costUsd: null, source: 'unavailable' };

  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch (e) {
    return textFallback(); // 不是合法 JSON（CLI 崩在輸出 JSON 之前、混了其它文字…）→ 退回純文字
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return textFallback();
  if (typeof obj.result !== 'string' || !obj.result) return textFallback(); // 缺少預期欄位 → 整段退回

  const costUsd = typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : null;
  const u = obj.usage;
  if (!u || typeof u !== 'object') {
    return { text: obj.result, usage: null, costUsd, source: 'unavailable' };
  }
  const input = Number(u.input_tokens);
  const output = Number(u.output_tokens);
  if (!Number.isFinite(input) || !Number.isFinite(output)) {
    return { text: obj.result, usage: null, costUsd, source: 'unavailable' };
  }
  const cacheReadRaw = Number(u.cache_read_input_tokens);
  const cacheCreateRaw = Number(u.cache_creation_input_tokens);
  const cacheRead = Number.isFinite(cacheReadRaw) ? cacheReadRaw : 0;
  const cacheCreate = Number.isFinite(cacheCreateRaw) ? cacheCreateRaw : 0;
  const usage = { input, output, cacheRead, cacheCreate, total: input + output + cacheRead + cacheCreate };
  return { text: obj.result, usage, costUsd, source: 'claude --output-format json' };
}

// ---------------------------------------------------------------------------
// UA-2: Codex 近似值 / Gemini 不支援
// ---------------------------------------------------------------------------
// Codex CLI 沒有等價於 Claude `--output-format json` 的單次帳單；用本機 rollout 紀錄近似——
// 沿用 model-quota.js 已驗證過的「找最新 rollout 檔」邏輯（唯讀 require，不改它），改掃
// `token_count` 事件的 `info.last_token_usage`（這次呼叫的用量，不是累計），拿不到就誠實留空
// （D3：絕不補 0）。
function codexApproxUsage() {
  try {
    const mq = lazyModelQuota();
    const codexHome = path.join(homeDir(), '.codex');
    const file = mq.findLatestCodexRolloutFile(codexHome);
    if (!file) return { tokens: null, source: 'unavailable' };
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch (e) { return { tokens: null, source: 'unavailable' }; }
    const lines = content.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || line.indexOf('token_count') === -1) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (e) { continue; }
      const info = obj && obj.payload && obj.payload.info;
      const u = info && (info.last_token_usage || info.total_token_usage);
      if (!u || typeof u !== 'object') continue;
      const input = Number(u.input_tokens);
      const output = Number(u.output_tokens);
      if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
      const cacheReadRaw = Number(u.cached_input_tokens);
      const cacheRead = Number.isFinite(cacheReadRaw) ? cacheReadRaw : 0;
      return {
        tokens: { input, output, cacheRead, cacheCreate: 0, total: input + output + cacheRead },
        source: 'codex-approx',
      };
    }
    return { tokens: null, source: 'unavailable' };
  } catch (e) {
    return { tokens: null, source: 'unavailable' };
  }
}

// Antigravity/Gemini：官方不提供任何用量輸出（同 SPEC-model-quota D3 的判定）。一律 null + unavailable，
// 絕不補 0（0 會被誤判成「這次沒花錢」，比留空更危險）。
function geminiUnavailableUsage() {
  return { tokens: null, source: 'unavailable' };
}

// ---------------------------------------------------------------------------
// UA-3: 落檔
// ---------------------------------------------------------------------------
function usageDir(workspaceRoot) {
  return path.join(workspaceRoot, '.harness', 'runtime', 'usage');
}

// fields = { trigger, background, skill, sessionId, scheduleId, provider, model, tokens, costUsd,
//            elapsedMs, source }
// 絕不拋出例外（寫檔失敗只記 console.error，不中斷呼叫端的對話/排程流程）。
function recordUsageEvent(workspaceRoot, fields) {
  try {
    const root = workspaceRoot || '';
    if (!root) return null;
    const at = new Date();
    const event = {
      id: genId(),
      at: at.toISOString(),
      workspace: root,
      trigger: fields.trigger,
      background: !!fields.background,
      skill: fields.skill || null,
      sessionId: fields.sessionId || null,
      scheduleId: fields.scheduleId || null,
      provider: fields.provider,
      model: fields.model || null,
      tokens: fields.tokens || null, // {input,output,cacheRead,cacheCreate,total} 或 null（無資料，不補 0）
      costUsd: (typeof fields.costUsd === 'number') ? fields.costUsd : null,
      elapsedMs: (typeof fields.elapsedMs === 'number') ? fields.elapsedMs : null,
      source: fields.source || 'unavailable',
    };
    const dir = usageDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const ym = at.toISOString().slice(0, 7); // YYYY-MM
    const file = path.join(dir, ym + '.jsonl');
    fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
    return event;
  } catch (e) {
    console.error('[usage-tracker] recordUsageEvent failed (non-fatal):', e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// UA-4: 查詢層（工作區隔離：path.resolve() + 小寫正規化；null 工作區 = defaultRoot）
// ---------------------------------------------------------------------------
function normPath(p, defaultRoot) {
  try { return path.resolve(String(p || defaultRoot || '')).toLowerCase(); } catch (e) { return ''; }
}

// ---------------------------------------------------------------------------
// UASZ-1: 跨專案工作區清單（D34/D36）— 讀 global-knowledge/projects.json，
// 以 path.resolve()+小寫正規化去重（同一 root 多別名取第一個出現的名字），
// 當前工作區即使不在清單中也必須納入；固定排序讓顏色指派穩定。
// 找不到檔案／解析失敗 → 只回含當前工作區的清單，不報錯（沿用既有誠實降級慣例）。
// ---------------------------------------------------------------------------
function harnessHome() {
  return process.env.HARNESS_HOME ? path.resolve(process.env.HARNESS_HOME) : path.resolve(__dirname, '..');
}

function listUsageWorkspaces(currentRoot) {
  const seen = new Map(); // normalized path -> entry
  const list = [];
  const add = (name, root) => {
    if (!root) return;
    const norm = normPath(root, root);
    if (!norm || seen.has(norm)) return; // 第一個出現的名字優先（去重規則）
    const entry = { name: name || path.basename(path.resolve(root)), root: path.resolve(root) };
    seen.set(norm, entry);
    list.push(entry);
  };
  try {
    const file = path.join(harnessHome(), 'global-knowledge', 'projects.json');
    if (fs.existsSync(file)) {
      const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
      const projects = Array.isArray(obj && obj.projects) ? obj.projects : [];
      for (const p of projects) {
        if (p && p.root) add(p.name, p.root);
      }
    }
  } catch (e) { /* 解析失敗：忽略 projects.json，仍保證回傳含當前工作區的清單 */ }
  add(path.basename(path.resolve(String(currentRoot || '.'))), currentRoot);
  list.sort((a, b) => {
    const an = normPath(a.root, a.root), bn = normPath(b.root, b.root);
    return an < bn ? -1 : (an > bn ? 1 : 0);
  });
  return list;
}

// 若群組中的事件帶有 project 標籤（僅 scope:'all' 時才有），補 projects（去重清單）／project
// （僅單一專案時填，供 G1 上色用）。scope:'current' 時事件沒有 project 欄位，回原物件不動，
// 確保「不帶 scope 的呼叫完全沿用舊行為」（UASZ-6 相容性斷言）。
function withProjectInfo(obj, items) {
  const names = items.map((it) => it && it.project).filter(Boolean);
  if (!names.length) return obj;
  const uniq = Array.from(new Set(names));
  return Object.assign({}, obj, { projects: uniq, project: uniq.length === 1 ? uniq[0] : null });
}

function listMonthFiles(root) {
  const dir = usageDir(root);
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort();
  } catch (e) { return []; }
}

// UAS-6: 每檔解析結果以 mtimeMs 當快取鍵——events 數長大後，舊的月檔（已關檔、不會再變動）
// 不必每次 summary/events 請求都整檔重新 JSON.parse 一次；只有真的被 append 過（mtime 變了）
// 才重讀。跨工作區安全：key 用絕對路徑，不同工作區的月檔天然不會撞到同一個 key。
const _fileParseCache = new Map(); // absPath -> { mtimeMs, events }

function readEventsRaw(root) {
  const files = listMonthFiles(root);
  const out = [];
  for (const f of files) {
    const p = path.join(usageDir(root), f);
    let stat;
    try { stat = fs.statSync(p); } catch (e) { continue; }
    const cached = _fileParseCache.get(p);
    if (cached && cached.mtimeMs === stat.mtimeMs) { out.push.apply(out, cached.events); continue; }
    let content;
    try { content = fs.readFileSync(p, 'utf8'); } catch (e) { continue; }
    const events = [];
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { events.push(JSON.parse(t)); } catch (e) { /* 單行壞資料跳過，不整檔放棄 */ }
    }
    _fileParseCache.set(p, { mtimeMs: stat.mtimeMs, events });
    out.push.apply(out, events);
  }
  return out;
}

function applyCommonFilters(events, filters) {
  return events
    .filter((e) => !filters.trigger || e.trigger === filters.trigger)
    .filter((e) => !filters.skill || e.skill === filters.skill)
    .filter((e) => !filters.provider || e.provider === filters.provider)
    .filter((e) => !filters.model || e.model === filters.model)
    .filter((e) => !filters.from || (e.at && e.at >= filters.from))
    .filter((e) => !filters.to || (e.at && e.at <= filters.to));
}

// filters = { from, to, trigger, skill, provider, model, scope }
// UASZ-2 (D34)：scope:'all' 時改讀 listUsageWorkspaces() 展開的每個工作區，各自讀取＋依自身
// workspace 欄位過濾後補 project（顯示名），合併後才套用 from/to/trigger/... 等既有篩選。
// scope 省略或非 'all'（即 'current'）時行為與改動前逐字相同（一字不改，相容性要求）。
function filterEvents(workspaceRoot, defaultRoot, filters) {
  filters = filters || {};
  const root = workspaceRoot || defaultRoot;
  if (!root) return [];
  if (filters.scope === 'all') {
    const list = listUsageWorkspaces(root);
    let merged = [];
    for (const ws of list) {
      const target = normPath(ws.root, defaultRoot);
      const events = readEventsRaw(ws.root)
        .filter((e) => normPath(e && e.workspace, defaultRoot) === target)
        .map((e) => Object.assign({}, e, { project: ws.name }));
      merged = merged.concat(events);
    }
    return applyCommonFilters(merged, filters);
  }
  const target = normPath(root, defaultRoot);
  return applyCommonFilters(
    readEventsRaw(root).filter((e) => normPath(e && e.workspace, defaultRoot) === target),
    filters
  );
}

// GET /api/usage/events — 原始事件，上限 MAX_EVENTS 筆，超過回 truncated:true（不得靜默截斷）。
function queryEvents(workspaceRoot, defaultRoot, filters) {
  const all = filterEvents(workspaceRoot, defaultRoot, filters)
    .sort((a, b) => (a.at < b.at ? 1 : (a.at > b.at ? -1 : 0))); // 新到舊
  const truncated = all.length > MAX_EVENTS;
  return { events: all.slice(0, MAX_EVENTS), truncated, total: all.length };
}

// GET /api/usage/summary — 預彙總，groupBy: skill|trigger|provider|model|day|schedule|session
// UAS-2：新增 'schedule' 分組（G1 Pareto 要能「按排程」切換），以 scheduleId 分組。
// UASF-1：新增 'session' 分組（D13，Pareto 補「按對話」且設為預設），以 sessionId 分組。
function querySummary(workspaceRoot, defaultRoot, filters, groupBy) {
  const all = filterEvents(workspaceRoot, defaultRoot, filters);
  const keyFn = (e) => {
    switch (groupBy) {
      case 'skill': return e.skill || '(無技能)';
      case 'trigger': return e.trigger || '(未知)';
      case 'provider': return e.provider || '(未知)';
      case 'model': return e.model || '(未知)';
      case 'day': return (e.at || '').slice(0, 10) || '(未知)';
      case 'schedule': return e.scheduleId || '(無排程)';
      case 'session': return e.sessionId || '(無對話)';
      default: return '(全部)';
    }
  };
  const groups = new Map();
  let noDataCount = 0;
  for (const e of all) {
    const k = keyFn(e);
    if (!groups.has(k)) groups.set(k, { key: k, count: 0, tokenTotal: 0, cacheReadTotal: 0, withTokenCount: 0, costUsd: 0, noDataCount: 0, elapsedMsTotal: 0, firstAt: e.at || null, projectItems: [] });
    const g = groups.get(k);
    g.count++;
    // UASF-2：D14 的「未命名對話（日期＋短代號）」退回文案需要這組最早一筆的時間，供前端組字。
    if (e.at && (!g.firstAt || e.at < g.firstAt)) g.firstAt = e.at;
    if (e.tokens && typeof e.tokens.total === 'number') {
      g.tokenTotal += e.tokens.total;
      g.withTokenCount++;
      if (typeof e.tokens.cacheRead === 'number') g.cacheReadTotal += e.tokens.cacheRead;
    } else { g.noDataCount++; noDataCount++; }
    if (typeof e.costUsd === 'number') g.costUsd += e.costUsd;
    if (typeof e.elapsedMs === 'number') g.elapsedMsTotal += e.elapsedMs;
    if (e.project) g.projectItems.push({ project: e.project }); // UASZ-5：G1 上色＋圖例用
  }
  const rows = Array.from(groups.values()).map((g) => {
    const projectItems = g.projectItems;
    const base = Object.assign({}, g);
    delete base.projectItems;
    return Object.assign({}, withProjectInfo(base, projectItems), {
      avgTokens: g.withTokenCount ? Math.round(g.tokenTotal / g.withTokenCount) : null,
      // 快取命中率＝這組的 cacheRead 加總／token 加總（含 cacheRead 本身，與落檔時 total 的定義一致）。
      cacheHitRate: g.tokenTotal ? g.cacheReadTotal / g.tokenTotal : null,
    });
  });
  return { groupBy: groupBy || null, rows, totalEvents: all.length, noDataCount };
}

// GET /api/usage/control-chart — X/MR（D8：先取對數再算 ±3σ，避免右偏值誤判異常）
// subject = 'all' | 'trigger:chat' | 'trigger:schedule' | 'skill:<name>' | 'schedule:<id>'（舊格式，
// D12 修訂後前端下拉已不再送出 schedule:<id>，但後端保留相容、不擋）。
// UASF-3（D12）：下拉改成「類型過濾」，故新增 'all'（全部）與 'trigger'（僅對話／僅排程）兩種 kind。
function parseSubject(subject) {
  if (!subject || typeof subject !== 'string') return null;
  if (subject === 'all') return { kind: 'all', value: null };
  const idx = subject.indexOf(':');
  if (idx === -1) return null;
  const kind = subject.slice(0, idx);
  const value = subject.slice(idx + 1);
  if ((kind !== 'skill' && kind !== 'schedule' && kind !== 'trigger') || !value) return null;
  return { kind, value };
}

function queryControlChart(workspaceRoot, defaultRoot, filters, subject) {
  const parsed = parseSubject(subject);
  if (!parsed) {
    return { subject: subject || null, points: [], insufficientData: true, reason: 'subject 格式錯誤，需為 all、trigger:<chat|schedule>、skill:<name> 其中一種' };
  }
  const matchSubject = (e) => {
    switch (parsed.kind) {
      case 'all': return true;
      case 'trigger': return e.trigger === parsed.value;
      case 'skill': return e.skill === parsed.value;
      default: return e.scheduleId === parsed.value; // 'schedule' — 舊格式相容，前端下拉已不使用
    }
  };
  const all = filterEvents(workspaceRoot, defaultRoot, filters)
    .filter(matchSubject)
    .filter((e) => e.tokens && typeof e.tokens.total === 'number' && e.tokens.total > 0)
    .sort((a, b) => (a.at > b.at ? 1 : (a.at < b.at ? -1 : 0))); // 舊到新
  const points = all.map((e) => {
    const p = { at: e.at, id: e.id, value: e.tokens.total };
    if (e.project) p.project = e.project; // UASZ-5：僅 scope:'all' 時才有，供提示框顯示專案名
    return p;
  });
  // D7：點數太少（< 8）不畫管制線，明確標示「資料不足」而非亂畫假警報。
  if (points.length < 8) {
    return { subject, points, insufficientData: true, reason: `資料不足，尚不畫管制線（樣本數 ${points.length} < 8）` };
  }
  // D8：先取對數再算 X/MR（token 用量高度右偏，直接算 ±3σ 會把正常值判成異常）。
  const logs = points.map((p) => Math.log(p.value));
  const n = logs.length;
  const meanLog = logs.reduce((s, v) => s + v, 0) / n;
  const mrs = [];
  for (let i = 1; i < logs.length; i++) mrs.push(Math.abs(logs[i] - logs[i - 1]));
  const mrBar = mrs.reduce((s, v) => s + v, 0) / mrs.length;
  const D2_FOR_N2 = 1.128; // 業界標準 X/MR 管制常數（移動範圍樣本大小=2）
  const sigma = mrBar / D2_FOR_N2;
  const toLinear = (v) => Math.exp(v);
  const cl = toLinear(meanLog);
  const uclLog = meanLog + 3 * sigma;
  const lclLog = meanLog - 3 * sigma;
  return {
    subject,
    points,
    insufficientData: false,
    controlLines: { cl, ucl: toLinear(uclLog), lcl: Math.max(0, toLinear(lclLog)) },
  };
}

// ---------------------------------------------------------------------------
// UASF-4: G5 X-Bar/R（D11）— 分組＝「同一天的同一個對話」，n 隨組變動（不固定）。
// ---------------------------------------------------------------------------
// 業界標準 X-Bar/R 管制常數表（Montgomery，n=2~15）。n 隨組變動時逐點管制線本該是階梯狀，
// 這是正確做法，不為了畫一條直線就強行固定 n。n>15 的罕見情況（單一對話單日超過 15 輪）夾在
// n=15 的常數上，屬刻意的近似、非精確值——此處本就是「漲幅」語意而非教科書隨機變異（見下方
// note），不追求學術精確。
const XBAR_R_CONST = {
  2: { A2: 1.880, D3: 0, D4: 3.267 },
  3: { A2: 1.023, D3: 0, D4: 2.574 },
  4: { A2: 0.729, D3: 0, D4: 2.282 },
  5: { A2: 0.577, D3: 0, D4: 2.114 },
  6: { A2: 0.483, D3: 0, D4: 2.004 },
  7: { A2: 0.419, D3: 0.076, D4: 1.924 },
  8: { A2: 0.373, D3: 0.136, D4: 1.864 },
  9: { A2: 0.337, D3: 0.184, D4: 1.816 },
  10: { A2: 0.308, D3: 0.223, D4: 1.777 },
  11: { A2: 0.285, D3: 0.256, D4: 1.744 },
  12: { A2: 0.266, D3: 0.283, D4: 1.717 },
  13: { A2: 0.249, D3: 0.307, D4: 1.693 },
  14: { A2: 0.235, D3: 0.328, D4: 1.672 },
  15: { A2: 0.223, D3: 0.347, D4: 1.653 },
};
function xbarRConstFor(n) {
  const k = Math.max(2, Math.min(15, Math.round(n)));
  return XBAR_R_CONST[k];
}

// GET /api/usage/xbar-r — 分組鍵＝(日期, sessionId)；每組至少 2 筆才算得出 R（單輪對話沒有
// 「漲幅」可言，不納入分組）。回傳點依「該組最後一輪時間」排序。組數 < 8 時明確標示資料不足。
function queryXbarR(workspaceRoot, defaultRoot, filters) {
  const all = filterEvents(workspaceRoot, defaultRoot, filters)
    .filter((e) => e.trigger === 'chat' && e.sessionId && e.tokens && typeof e.tokens.total === 'number' && e.tokens.total > 0);
  const groups = new Map(); // 'YYYY-MM-DD|sessionId' -> { date, sessionId, values[], lastAt, projectItems[] }
  for (const e of all) {
    const date = (e.at || '').slice(0, 10);
    if (!date) continue;
    const key = date + '|' + e.sessionId;
    if (!groups.has(key)) groups.set(key, { date, sessionId: e.sessionId, values: [], lastAt: e.at, projectItems: [] });
    const g = groups.get(key);
    g.values.push(e.tokens.total);
    if (e.at > g.lastAt) g.lastAt = e.at;
    if (e.project) g.projectItems.push({ project: e.project }); // UASZ-5：G5 提示框用
  }
  const points = Array.from(groups.values())
    .filter((g) => g.values.length >= 2)
    .map((g) => {
      const n = g.values.length;
      const sum = g.values.reduce((s, v) => s + v, 0);
      return withProjectInfo({
        date: g.date,
        sessionId: g.sessionId,
        n, sum,
        xbar: sum / n,
        r: Math.max.apply(null, g.values) - Math.min.apply(null, g.values),
        lastAt: g.lastAt,
      }, g.projectItems);
    })
    .sort((a, b) => (a.lastAt < b.lastAt ? -1 : (a.lastAt > b.lastAt ? 1 : 0)));
  if (points.length < 8) {
    return { points, insufficientData: true, reason: `資料不足，尚不畫管制線（對話組數 ${points.length} < 8）` };
  }
  const totalN = points.reduce((s, p) => s + p.n, 0);
  const grandSum = points.reduce((s, p) => s + p.sum, 0);
  const xbarbar = grandSum / totalN; // 全體輪次加權平均（等同把所有輪次攤平算平均）
  const rbar = points.reduce((s, p) => s + p.r, 0) / points.length;
  // D27（v0.7）：管制界限改為「整段共用的四條水平線」，不再每點隨該組輪數變動。
  // 原本每點用自己的 n 查常數表 → 界限呈階梯狀，指揮官實測指出「每一點界限都不一樣、看不懂」。
  // 管制圖的用途是「一眼看出哪個點脫離平常水準」，階梯界限把這件事變成要逐點心算。
  // 改法：用平均輪數 n̄ 查一次常數表，算一組固定界限（與 G4 的畫法一致）。
  // 誠實標註：各組 n 其實不等，固定界限屬刻意簡化（nBar / approxConstants 回傳給前端標示）。
  const nBar = Math.max(2, Math.round(totalN / points.length));
  const c = xbarRConstFor(nBar);
  const xUcl = xbarbar + c.A2 * rbar;
  const xLcl = Math.max(0, xbarbar - c.A2 * rbar);
  const rUcl = c.D4 * rbar;
  const rLcl = c.D3 * rbar;
  const withLines = points.map((p) => Object.assign({}, p, { xUcl, xLcl, rUcl, rLcl }));
  return {
    points: withLines,
    insufficientData: false,
    xbarbar, rbar, nBar,
    controlLines: { xUcl, xLcl, rUcl, rLcl, nBar, approxConstants: nBar > 15 },
    // D11 誠實標註：R 在此代表「對話頭尾漲幅」，非教科書的隨機變異，解讀方式與標準品管不同。
    note: 'R 代表「這個對話從頭漲到尾的落差」，非隨機變異；各組輪數不等，界限以平均輪數 n̄ 固定，屬刻意簡化',
  };
}

// ---------------------------------------------------------------------------
// UASC-1: 設定儲存層（D19/D20）— .harness/runtime/usage/settings.json
// ---------------------------------------------------------------------------
const USAGE_SETTINGS_DEFAULTS = { groupSize: 3, controlWindow: 25, percentileWindow: 100 };
// D28：管制界限最低需要的組數。低於這個數字才真的不畫圖；介於它與 controlWindow 之間照畫、標註基數不足。
const MIN_CONTROL_GROUPS = 8;

function settingsPath(workspaceRoot) {
  return path.join(usageDir(workspaceRoot), 'settings.json');
}

// 檔案不存在或壞檔一律回系統預設值、不落檔（D19）。
function readUsageSettings(workspaceRoot, defaultRoot) {
  const root = workspaceRoot || defaultRoot;
  if (!root) return Object.assign({}, USAGE_SETTINGS_DEFAULTS);
  const file = settingsPath(root);
  if (!fs.existsSync(file)) return Object.assign({}, USAGE_SETTINGS_DEFAULTS);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw);
    const groupSize = Number.isFinite(obj.groupSize) ? obj.groupSize : USAGE_SETTINGS_DEFAULTS.groupSize;
    const controlWindow = Number.isFinite(obj.controlWindow) ? obj.controlWindow : USAGE_SETTINGS_DEFAULTS.controlWindow;
    const percentileWindow = (obj.percentileWindow === 'all' || Number.isFinite(obj.percentileWindow))
      ? obj.percentileWindow : USAGE_SETTINGS_DEFAULTS.percentileWindow;
    return { groupSize, controlWindow, percentileWindow };
  } catch (e) {
    return Object.assign({}, USAGE_SETTINGS_DEFAULTS);
  }
}

// 驗證規則（D19/§3.3 PUT）：組大小整數 2~50、管制界限視窗整數 >=8、
// 歷史百分位視窗整數 >=10 或字串 "all"。失敗回 { ok:false, errors }，呼叫端不得落檔。
function validateUsageSettings(input) {
  input = input || {};
  const errors = [];
  const groupSize = Number(input.groupSize);
  if (!Number.isInteger(groupSize) || groupSize < 2 || groupSize > 50) errors.push('組大小須為 2~50 的整數');
  const controlWindow = Number(input.controlWindow);
  if (!Number.isInteger(controlWindow) || controlWindow < 8) errors.push('管制界限視窗須為 >=8 的整數');
  let percentileWindow;
  if (input.percentileWindow === 'all') {
    percentileWindow = 'all';
  } else {
    const pw = Number(input.percentileWindow);
    if (!Number.isInteger(pw) || pw < 10) errors.push('歷史百分位視窗須為 >=10 的整數或 "all"');
    else percentileWindow = pw;
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { groupSize, controlWindow, percentileWindow } };
}

// 驗證失敗回 { ok:false, errors }、不寫檔。成功寫入並回 { ok:true, value }（含 updatedAt）。
function writeUsageSettings(workspaceRoot, defaultRoot, settings) {
  const root = workspaceRoot || defaultRoot;
  if (!root) return { ok: false, errors: ['workspace 未知'] };
  const validated = validateUsageSettings(settings);
  if (!validated.ok) return validated;
  try {
    const dir = usageDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const toSave = Object.assign({}, validated.value, { updatedAt: new Date().toISOString() });
    fs.writeFileSync(settingsPath(root), JSON.stringify(toSave, null, 2), 'utf8');
    return { ok: true, value: toSave };
  } catch (e) {
    return { ok: false, errors: ['寫檔失敗：' + e.message] };
  }
}

// ---------------------------------------------------------------------------
// UASC-2: queryUsageTrend（D17）— 固定組距 X-Bar/R，取代 G4 原本呼叫的 X/MR。
// ---------------------------------------------------------------------------
// 依事件時間序（跨全部 trigger），每 groupSize 筆打包成一組，算每組 X̄（平均）／R（全距）。
function groupByFixedN(events, n) {
  const withTokens = events
    .filter((e) => e.tokens && typeof e.tokens.total === 'number' && e.tokens.total > 0)
    .sort((a, b) => (a.at < b.at ? -1 : (a.at > b.at ? 1 : 0))); // 舊到新
  const groups = [];
  for (let i = 0; i < withTokens.length; i += n) {
    const chunk = withTokens.slice(i, i + n);
    if (!chunk.length) continue;
    const values = chunk.map((e) => e.tokens.total);
    const sum = values.reduce((s, v) => s + v, 0);
    groups.push(withProjectInfo({
      startAt: chunk[0].at,
      endAt: chunk[chunk.length - 1].at,
      n: values.length,
      xbar: sum / values.length,
      r: Math.max.apply(null, values) - Math.min.apply(null, values),
    }, chunk)); // UASZ-5：一組可能跨多個專案（scope:'all' 時依時間序混排），提示框列出全部
  }
  return groups;
}

// 該值在 windowValues（含自身）中的百分位排名：有幾成的值 <= 自己。
function percentileRank(value, windowValues) {
  if (!windowValues.length) return null;
  const countLE = windowValues.filter((v) => v <= value).length;
  return (countLE / windowValues.length) * 100;
}

// settings = { groupSize, controlWindow, percentileWindow }（讀自 readUsageSettings，呼叫端負責傳入）。
// 管制界限（CL/UCL/LCL）：取最近 controlWindow 組的 X̄，沿用既有 D8 對數法（先取對數、用相鄰差的
// 平均當 sigma 估計、±3σ），只是輸入換成「組平均」而非單筆事件值，算法本身不改。
// 歷史百分位：對每一組，取「截至該組為止、最近 percentileWindow 組」（percentileWindow='all' 則從頭
// 算到該組）算百分位排名，故歷史百分位是隨點變動的一條線，管制界限是整段共用的水平參考線。
function queryUsageTrend(workspaceRoot, defaultRoot, filters, settings) {
  const s = Object.assign({}, USAGE_SETTINGS_DEFAULTS, settings || {});
  const groupSize = s.groupSize;
  const controlWindow = s.controlWindow;
  const percentileWindow = s.percentileWindow;

  const all = filterEvents(workspaceRoot, defaultRoot, filters);
  const groups = groupByFixedN(all, groupSize);

  // D28（v0.7）：起迄預設縮短為一週後，組數常低於管制界限視窗（預設 25），原本會整張圖空白、
  // 只剩一行「資料不足」，等於預設畫面看不到任何管制圖。改為兩段門檻：
  //   組數 < MIN_CONTROL_GROUPS(8) → 真的畫不出界限，照舊回 insufficientData。
  //   8 <= 組數 < controlWindow   → 用手上全部組數算界限、照常畫，另回 limitedBasis 讓前端誠實標註
  //                                「界限只用 N 組算出，少於設定的 W 組，靈敏度偏高」。
  if (groups.length < MIN_CONTROL_GROUPS) {
    return {
      groups, insufficientData: true,
      reason: `資料不足，尚不畫管制線（組數 ${groups.length} < 最低 ${MIN_CONTROL_GROUPS} 組）`,
      settings: s,
    };
  }

  // D21（v0.6.1）：G4 既然叫 X-Bar/R，管制界限就用教科書 X-Bar/R 公式——CL = X̄̄（總平均）、
  // UCL/LCL = X̄̄ ± A2·R̄，R 子圖用 D4·R̄ / D3·R̄。舊版沿用 X/MR 的「取對數再 ±3σ」法，在線性
  // Y 軸上有兩個明顯症狀（指揮官實測指出）：① CL = 幾何平均，不在 UCL 與 LCL 的中間，看起來
  // 明顯偏下；② 界限寬到沒有任何點會出界，等於畫了一張沒有警報能力的圖。固定組距下 n 不變，
  // 故管制線是三條水平直線（非階梯），這也符合教科書 X-Bar/R 的樣子。
  const windowGroups = groups.slice(-controlWindow);
  const totalN = windowGroups.reduce((s, g) => s + g.n, 0) || 1;
  const grandSum = windowGroups.reduce((s, g) => s + g.xbar * g.n, 0);
  const rbar = windowGroups.reduce((s, g) => s + g.r, 0) / windowGroups.length;
  const c = xbarRConstFor(groupSize);
  const cl = grandSum / totalN;
  const ucl = cl + c.A2 * rbar;
  const lcl = Math.max(0, cl - c.A2 * rbar);

  const withPct = groups.map((g, i) => {
    let winVals;
    if (percentileWindow === 'all') {
      winVals = groups.slice(0, i + 1).map((x) => x.xbar);
    } else {
      const start = Math.max(0, i - percentileWindow + 1);
      winVals = groups.slice(start, i + 1).map((x) => x.xbar);
    }
    return Object.assign({}, g, { percentile: percentileRank(g.xbar, winVals) });
  });

  return {
    groups: withPct,
    insufficientData: false,
    controlLines: {
      cl, ucl, lcl,
      rBar: rbar,
      rUcl: c.D4 * rbar,
      rLcl: c.D3 * rbar,
      n: groupSize,
      // 誠實標註：常數表只到 n=15，組大小設超過 15 時夾在 n=15 的常數上，屬刻意近似。
      approxConstants: groupSize > 15,
      // D28：界限實際用了幾組算出來；少於設定的 controlWindow 時 limitedBasis=true。
      basisCount: windowGroups.length,
      limitedBasis: windowGroups.length < controlWindow,
    },
    settings: s,
  };
}

module.exports = {
  MAX_EVENTS,
  mapProviderId,
  listUsageWorkspaces,
  parseClaudeCliOutput,
  codexApproxUsage,
  geminiUnavailableUsage,
  recordUsageEvent,
  usageDir,
  normPath,
  filterEvents,
  queryEvents,
  querySummary,
  queryControlChart,
  parseSubject,
  queryXbarR,
  USAGE_SETTINGS_DEFAULTS,
  MIN_CONTROL_GROUPS,
  readUsageSettings,
  validateUsageSettings,
  writeUsageSettings,
  queryUsageTrend,
};

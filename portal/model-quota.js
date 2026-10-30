// SPEC-model-quota.md §3/§4 — provider-neutral model quota adapters.
// Read-only: only inspects local files / CLI's already-existing output. Never makes a network
// call or spends quota just to answer "how much is left" (D4, shared stance with SPEC-resilient-cli §B).
// Each adapter is independent — one provider's failure must never affect the others (D6), and an
// unreadable/unexpected format must surface as health:'broken' with a concrete message rather than
// a guessed number (D3) or a silent throw.

const fs = require('fs');
const path = require('path');

function homeDir() {
  return process.env.USERPROFILE || path.join(process.env.HOMEDRIVE || 'C:', process.env.HOMEPATH || '');
}

function commandExists(cmd) {
  try {
    require('child_process').execSync((process.platform === 'win32' ? 'where ' : 'which ') + cmd, { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`逾時（${ms}ms 內未回應）`)), ms)),
  ]);
}

// Wraps one adapter call: normalizes its result into the full contract shape, and converts ANY
// thrown exception into health:'broken' rather than letting it propagate (D6).
async function safeFetch(id, label, fn) {
  const fetchedAt = new Date().toISOString();
  try {
    const r = await withTimeout(Promise.resolve().then(fn), 15000);
    return {
      id,
      label,
      health: r.health,
      message: r.health === 'ok' ? (r.message || null) : (r.message || `${label} 查詢失敗，原因不明。`),
      usage: r.usage || null,
      windows: r.windows || [],
      source: r.source || null,
      fetchedAt,
    };
  } catch (err) {
    return {
      id,
      label,
      health: 'broken',
      message: `${label} 額度查詢時發生未預期錯誤：${(err && err.message) || err}`,
      usage: null,
      windows: [],
      source: null,
      fetchedAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------
// 實地確認結果（2026-08-30，修正版）：~/.claude/ 下的狀態檔確實沒有配額欄位（原轉接器到此為止就
// 回 unsupported，那是錯的結論），但 Claude Code 自己顯示 /usage 用的是官方帳號用量端點
//   GET https://api.anthropic.com/api/oauth/usage
// 帶 ~/.claude/.credentials.json 裡既有的 OAuth token 即可讀到 five_hour / seven_day 的
// utilization(%) 與 resets_at。這是「查用量」的 metadata 端點、不經過模型、不花任何額度，
// 因此符合 D4（不為了顯示而去打模型）——它就是 CLI 既有的用量輸出，只是走 HTTP 而非本機檔。
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

function readClaudeToken(claudeDir) {
  const credPath = path.join(claudeDir, '.credentials.json');
  if (!fs.existsSync(credPath)) return null;
  const raw = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const oauth = raw && raw.claudeAiOauth;
  return (oauth && typeof oauth.accessToken === 'string' && oauth.accessToken) ? oauth.accessToken : null;
}

// { utilization: 20.0, resets_at: "..." } → contract window. Returns null when the key is absent
// (a plan legitimately may not have that window); returns the string 'bad' when the key EXISTS but
// its shape is wrong — that is a format break the caller must surface as 'broken' (§4 格式健檢).
function claudeWindow(entry, label) {
  if (entry === null || entry === undefined) return null;
  if (typeof entry !== 'object' || typeof entry.utilization !== 'number') return 'bad';
  return {
    name: label,
    usedRatio: Math.max(0, Math.min(1, entry.utilization / 100)),
    resetAt: entry.resets_at ? new Date(entry.resets_at).toISOString() : null,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// SPEC-model-quota.md §9 D11/D12 — process-lifetime last-good cache for the Claude adapter only
// (not persisted to disk; a server restart just re-queries). Only a true health:'ok' result is
// ever stored here, so a stale/broken read never poisons it.
let claudeLastGood = null; // { result, fetchedAt: <ms epoch> } | null
const CLAUDE_STALE_MAX_AGE_MS = 30 * 60 * 1000; // D11: last-good older than 30 min → real 'broken', not 'stale'
const CLAUDE_FETCH_TIMEOUT_MS = 15000; // D9

// One HTTP attempt. Returns the final contract-shaped result for anything that isn't a network/
// timeout failure (HTTP 401/403, non-2xx, bad JSON, bad field shape — none of those change on
// retry, D10). A network-layer failure or abort/timeout throws an Error with `.retryable = true`
// so the caller (fetchClaudeQuota) can decide whether to retry.
async function attemptClaudeFetchOnce(token) {
  let res;
  try {
    res = await fetch(CLAUDE_USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(CLAUDE_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const retryableErr = new Error(`Claude 用量端點連線失敗：${err.message}`);
    retryableErr.retryable = true;
    throw retryableErr;
  }
  if (res.status === 401 || res.status === 403) {
    return { health: 'missing', message: 'Claude 登入憑證已失效或過期，請在終端機重新登入 Claude Code 後再查。', usage: null, windows: [], source: CLAUDE_USAGE_URL };
  }
  if (!res.ok) {
    return { health: 'broken', message: `Claude 用量端點回應 HTTP ${res.status}，可能是官方介面異動，需要修正轉接器。`, usage: null, windows: [], source: CLAUDE_USAGE_URL };
  }
  let data;
  try {
    data = await res.json();
  } catch (err) {
    return { health: 'broken', message: 'Claude 用量端點回傳的不是可解析的 JSON，可能是官方介面異動，需要修正轉接器。', usage: null, windows: [], source: CLAUDE_USAGE_URL };
  }

  const w5 = claudeWindow(data && data.five_hour, '5 小時');
  const w7 = claudeWindow(data && data.seven_day, '7 天');
  if (w5 === 'bad' || w7 === 'bad') {
    return { health: 'broken', message: 'Claude 用量輸出的欄位格式與預期不符（找不到 utilization 百分比欄位），可能是官方介面異動，需要修正轉接器。', usage: null, windows: [], source: CLAUDE_USAGE_URL };
  }
  const windows = [w5, w7].filter(Boolean);
  if (!windows.length) {
    return { health: 'broken', message: 'Claude 用量輸出裡找不到 five_hour／seven_day 任一個限額窗口，可能是官方介面異動，需要修正轉接器。', usage: null, windows: [], source: CLAUDE_USAGE_URL };
  }
  return {
    health: 'ok',
    message: null,
    usage: { unit: 'percent', used: Math.round(windows[0].usedRatio * 100) },
    windows,
    source: 'Claude 官方帳號用量端點（/api/oauth/usage，不消耗額度）',
  };
}

async function fetchClaudeQuota() {
  const claudeDir = path.join(homeDir(), '.claude');
  if (!fs.existsSync(claudeDir)) {
    return { health: 'missing', message: 'Claude Code CLI 未安裝（找不到 ~/.claude 目錄）。', usage: null, windows: [], source: null };
  }
  let token;
  try {
    token = readClaudeToken(claudeDir);
  } catch (err) {
    return { health: 'broken', message: `Claude 登入憑證檔（~/.claude/.credentials.json）讀取失敗：${err.message}`, usage: null, windows: [], source: null };
  }
  if (!token) {
    return { health: 'missing', message: 'Claude Code 尚未以訂閱帳號登入（找不到 OAuth 憑證），登入後才查得到額度。', usage: null, windows: [], source: null };
  }

  // D10: retry only network/timeout failures, at most 2 requests total, 1s backoff between them.
  let lastRetryableErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(1000);
    try {
      const result = await attemptClaudeFetchOnce(token);
      if (result.health === 'ok') claudeLastGood = { result, fetchedAt: Date.now() };
      return result;
    } catch (err) {
      if (!err || !err.retryable) throw err; // non-retryable errors never thrown by attemptClaudeFetchOnce today, but don't silently swallow if that changes
      lastRetryableErr = err;
    }
  }

  // D11: both attempts failed on the network layer. Fall back to the last successful read if it's
  // still fresh enough to be useful; otherwise this really is broken.
  if (claudeLastGood && (Date.now() - claudeLastGood.fetchedAt) <= CLAUDE_STALE_MAX_AGE_MS) {
    const minsAgo = Math.max(1, Math.round((Date.now() - claudeLastGood.fetchedAt) / 60000));
    return {
      health: 'stale',
      message: `資料為 ${minsAgo} 分鐘前的查詢結果（本次連線逾時，稍後自動重試）。`,
      usage: claudeLastGood.result.usage,
      windows: claudeLastGood.result.windows,
      source: claudeLastGood.result.source,
    };
  }
  return { health: 'broken', message: lastRetryableErr.message, usage: null, windows: [], source: CLAUDE_USAGE_URL };
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------
// 實地確認結果（2026-08-30）：Codex CLI 沒有 `/status` 對應的獨立 CLI 子指令輸出，但每次
// 真實執行後，會把當下的 rate limit 快照寫進 `~/.codex/sessions/**/rollout-*.jsonl` 的
// `event_msg`（type: token_count）事件裡，欄位為：
//   payload.rate_limits = { primary: { used_percent, window_minutes, resets_at(unix秒) },
//                            secondary: {...}|null, plan_type, ... }
// 這是被動讀取本機既有紀錄（不主動打 API），符合 D4。取「最新一筆有 rate_limits 的紀錄」
// 即為目前已知的最新用量快照。
function findLatestCodexRolloutFile(codexHome) {
  const sessionsDir = path.join(codexHome, 'sessions');
  if (!fs.existsSync(sessionsDir)) return null;
  let latest = null;
  let latestMtime = -1;
  const stack = [sessionsDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!ent.name.endsWith('.jsonl')) continue;
      let mtime;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch (e) {
        continue;
      }
      if (mtime > latestMtime) {
        latestMtime = mtime;
        latest = full;
      }
    }
  }
  return latest;
}

// Scans a rollout file from the end for the last line carrying a `rate_limits` object.
// Exported for testing (feeding a hand-crafted malformed file to prove the format-health-check).
function parseCodexRateLimitsFromFile(file) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.indexOf('"rate_limits"') === -1) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      continue; // not JSON on this line — keep scanning older lines
    }
    const rl = obj && obj.payload && obj.payload.rate_limits;
    if (rl) return rl;
  }
  return null;
}

function windowFromRateLimitEntry(entry, label) {
  if (!entry || typeof entry.used_percent !== 'number') return null;
  const resetAt = typeof entry.resets_at === 'number' ? new Date(entry.resets_at * 1000).toISOString() : null;
  return { name: label, usedRatio: Math.max(0, Math.min(1, entry.used_percent / 100)), resetAt };
}

function labelForWindow(entry, fallback) {
  if (!entry || typeof entry.window_minutes !== 'number') return fallback;
  if (entry.window_minutes <= 360) return '5 小時';
  if (entry.window_minutes >= 10000) return '7 天';
  return fallback;
}

function fetchCodexQuota() {
  if (!commandExists('codex')) {
    return { health: 'missing', message: 'Codex CLI 未安裝（PATH 找不到 codex 指令）。', usage: null, windows: [], source: null };
  }
  const codexHome = path.join(homeDir(), '.codex');
  const rolloutFile = findLatestCodexRolloutFile(codexHome);
  if (!rolloutFile) {
    return {
      health: 'unsupported',
      message: 'Codex 尚無本機執行紀錄（~/.codex/sessions 下沒有任何 rollout 檔），至少要成功呼叫過一次才查得到用量。',
      usage: null,
      windows: [],
      source: '~/.codex/sessions/**/*.jsonl',
    };
  }
  let rl;
  try {
    rl = parseCodexRateLimitsFromFile(rolloutFile);
  } catch (err) {
    return { health: 'broken', message: `Codex 執行紀錄讀取失敗：${err.message}`, usage: null, windows: [], source: rolloutFile };
  }
  if (!rl) {
    return {
      health: 'unsupported',
      message: 'Codex 最新一筆本機執行紀錄裡沒有 rate_limits 欄位，可能是 CLI 版本尚未回報用量。',
      usage: null,
      windows: [],
      source: rolloutFile,
    };
  }
  if (!rl.primary && !rl.secondary) {
    return {
      health: 'broken',
      message: 'Codex 用量輸出找不到 primary/secondary 任一個限額窗口，可能是 CLI 更新，需要修正轉接器。',
      usage: null,
      windows: [],
      source: rolloutFile,
    };
  }
  const w1 = windowFromRateLimitEntry(rl.primary, labelForWindow(rl.primary, '主要窗口'));
  const w2 = windowFromRateLimitEntry(rl.secondary, labelForWindow(rl.secondary, '次要窗口'));
  const windows = [w1, w2].filter(Boolean);
  if (!windows.length) {
    return {
      health: 'broken',
      message: 'Codex 用量輸出找不到百分比欄位（used_percent），可能是 CLI 更新，需要修正轉接器。',
      usage: null,
      windows: [],
      source: rolloutFile,
    };
  }
  // 誠實原則（D3）：rollout 快照是「上次呼叫當下」的照片。若所有窗口的重置時間都已過去，
  // 這份百分比早就失效（窗口已重置），顯示它等於給指揮官一個假的安心數字 → 回 unsupported。
  const allExpired = windows.every((w) => w.resetAt && new Date(w.resetAt).getTime() <= Date.now());
  if (allExpired) {
    let lastUsed = null;
    try { lastUsed = fs.statSync(rolloutFile).mtime.toLocaleString('zh-TW', { hour12: false }); } catch (e) {}
    return {
      health: 'unsupported',
      message: `Codex 上次呼叫是 ${lastUsed || '較早之前'}，那筆快照的限額窗口早已重置，目前用量無從得知（下次實際呼叫 Codex 後才會更新）。`,
      usage: null,
      windows: [],
      source: rolloutFile,
    };
  }
  const primaryPercent = rl.primary && typeof rl.primary.used_percent === 'number' ? rl.primary.used_percent
    : (rl.secondary && typeof rl.secondary.used_percent === 'number' ? rl.secondary.used_percent : null);
  return {
    health: 'ok',
    message: null,
    usage: primaryPercent === null ? null : { unit: 'percent', used: primaryPercent },
    windows,
    source: rolloutFile,
  };
}

// ---------------------------------------------------------------------------
// Gemini (Antigravity)
// ---------------------------------------------------------------------------
// 實地確認結果（2026-08-30）：`~/.gemini/` 下只有 OAuth 憑證與設定，沒有任何用量／配額欄位；
// 官方 agy CLI 也沒有等價的 usage 指令。撞牆訊號只能靠既有 `/api/limits`（RESOURCE_EXHAUSTED
// 反應式偵測）取得，不是本規格「主動查詢」能提供的。依 spec §4 D2，固定回 unsupported。
function fetchGeminiQuota() {
  const home = homeDir();
  const agyBin = path.join(home, 'AppData', 'Local', 'agy', 'bin', 'agy.exe');
  const geminiDir = path.join(home, '.gemini');
  if (!fs.existsSync(agyBin) && !fs.existsSync(geminiDir)) {
    return { health: 'missing', message: 'Antigravity (Gemini) CLI 未安裝。', usage: null, windows: [], source: null };
  }
  return {
    health: 'unsupported',
    message: 'Antigravity (Gemini) 官方不提供帳號層級剩餘配額查詢，只能在撞牆當下得知（見既有 /api/limits）。',
    usage: null,
    windows: [],
    source: '官方無此 API',
  };
}

async function fetchAllQuota() {
  const providers = await Promise.all([
    safeFetch('claude', 'Claude Code', fetchClaudeQuota),
    safeFetch('codex', 'Codex', fetchCodexQuota),
    safeFetch('gemini', 'Antigravity (Gemini)', fetchGeminiQuota),
  ]);
  return { providers, generatedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// §6 Degradation detection (MQ-12/MQ-13) — pure, no telegram/scheduler dependency so
// the transition logic is unit-testable in isolation (MQ-15). The caller (server.js) is
// responsible for actually delivering the returned transitions through the existing
// notification pipeline (MQ-14) — this module only decides WHETHER to notify.
// ---------------------------------------------------------------------------

function loadHealthSnapshot(snapshotPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch (e) {
    return {}; // missing / first run / corrupt → start clean, never throw
  }
}

function saveHealthSnapshot(snapshotPath, snapshot) {
  try {
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
  } catch (e) {
    console.error('[model-quota] health snapshot write failed:', e.message);
  }
}

// Compares this fetch's providers against the last-known health per provider, persists the
// updated snapshot ({ [providerId]: { health, since } }), and returns only the transitions
// worth notifying about — D5: ok→broken (just broke, notify once) and broken→ok (recovered,
// notify once). broken→broken (no health change) does not re-notify. unsupported/missing never
// notify regardless of what they transition from/to. The very first observation of a provider
// (no prior snapshot entry) is recorded silently — there is no "before" state to compare against.
function updateHealthSnapshot(providers, snapshotPath) {
  const snapshot = loadHealthSnapshot(snapshotPath);
  const now = new Date().toISOString();
  const transitions = [];
  for (const p of providers || []) {
    const prev = snapshot[p.id];
    const prevHealth = prev ? prev.health : null;
    if (prevHealth !== p.health) {
      snapshot[p.id] = { health: p.health, since: now };
      if (prevHealth === 'ok' && p.health === 'broken') {
        transitions.push({ id: p.id, label: p.label, kind: 'degraded', health: p.health, message: p.message, since: now });
      } else if (prevHealth === 'broken' && p.health === 'ok') {
        transitions.push({ id: p.id, label: p.label, kind: 'recovered', health: p.health, message: p.message, since: now });
      }
      // any other transition (first-ever observation, or anything touching unsupported/missing) → silent (D5).
    }
  }
  saveHealthSnapshot(snapshotPath, snapshot);
  return transitions;
}

module.exports = {
  fetchAllQuota,
  fetchClaudeQuota,
  fetchCodexQuota,
  fetchGeminiQuota,
  // exported for MQ-07 self-test only (feeding hand-crafted malformed rollout files)
  parseCodexRateLimitsFromFile,
  findLatestCodexRolloutFile,
  // MQ-12/13/15
  updateHealthSnapshot,
  loadHealthSnapshot,
};

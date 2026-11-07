// chat-index.js — 對話清單目錄（SPEC-list-index.md §9.3，IDX-CHAT）。
//
// 把「每個工作區一份 <ws>/.harness/index/chat.json」的欄位定義、掃描、寫入同步與三支清單的過濾集中在這裡；
// 目錄的讀寫、排隊、原子替換、重建骨架全部交給共用模組 list-index.js，本檔不另寫一套。
// 對話檔 chat_<sessionId>.json 才是真相；目錄只是快取。
const fs = require('fs');
const path = require('path');
const listIndex = require('./list-index');

const fsp = fs.promises;

// 啟動時由 server.js 指定的取字函式（與 server.js 的 chatMsgText 同義）。
function msgText(m) {
  if (!m) return '';
  return typeof m.content === 'string' ? m.content
    : (Array.isArray(m.content) ? m.content.filter(c => c && c.text).map(c => c.text).join('\n') : '');
}

const isChatFile = f => f.startsWith('chat_') && f.endsWith('.json');
const idFromFile = f => f.slice('chat_'.length, -'.json'.length);

// <ws>/.harness/runtime/chat_history → <ws>；不是標準位置就回 null（此時不走目錄、直接掃資料夾）。
function wsRootOfDir(dir) {
  try {
    const d = path.resolve(dir);
    const rt = path.dirname(d), hz = path.dirname(rt);
    if (path.basename(d).toLowerCase() === 'chat_history' && path.basename(rt).toLowerCase() === 'runtime' && path.basename(hz).toLowerCase() === '.harness') {
      return path.dirname(hz);
    }
  } catch (_) {}
  return null;
}

// 對話檔 → 目錄欄位。不放訊息本文：只留清單要顯示／篩選的欄位。
function entryFromData(data, fileId) {
  const sessionId = data.sessionId || fileId;
  const msgs = Array.isArray(data.messages) ? data.messages : [];
  // 預設標題要的是「第一則 user 字串訊息的前 30 字，且知道是否超過 30 字」→ 存前 31 字即可判斷。
  const firstUser = msgs.find(m => m && m.role === 'user' && typeof m.content === 'string');
  const last = msgs.length ? msgs[msgs.length - 1] : null;
  const e = {
    sessionId,
    title: data.title || null,
    firstUser: firstUser ? firstUser.content.slice(0, 31) : null,
    updatedAt: data.updatedAt || null,
    origin: data.origin || (String(data.sessionId || fileId).startsWith('sched_') ? 'schedule' : 'human'),
    filePath: data.filePath || null,
    contextKind: data.contextKind || null,
    contextKey: data.contextKey || null,
    contextLabel: data.contextLabel || null,
    meetingId: data.meetingId || null,
    pmProjectIds: (Array.isArray(data.pmProjectIds) && data.pmProjectIds.length) ? data.pmProjectIds : null,
    msgCount: msgs.length,
    lastText: last ? msgText(last).replace(/\s+/g, ' ').slice(0, 60) : '',
  };
  return e;
}

// 掃資料夾 → 目錄項目（非同步、每 50 筆讓出）。0 位元組或壞掉的檔：略過、不刪，記在 skipped。
async function scanDir(dir, skipped) {
  let names;
  try { names = (await fsp.readdir(dir)).filter(isChatFile); } catch (_) { return []; }
  return listIndex.eachYield(names, async (file) => {
    try {
      const text = await fsp.readFile(path.join(dir, file), 'utf8');
      if (!text.trim()) { if (skipped) skipped.push({ file, reason: 'empty' }); return undefined; }
      return entryFromData(JSON.parse(text), idFromFile(file));
    } catch (e) {
      if (skipped) skipped.push({ file, reason: 'unreadable: ' + String(e.message).slice(0, 80) });
      return undefined;
    }
  });
}

// 便宜的核對值：只列檔名（含 0 位元組檔，與目錄內容無關，只用來看「資料夾有沒有變」）。
async function fingerprintDir(dir) {
  let names = [];
  try { names = (await fsp.readdir(dir)).filter(isChatFile); } catch (_) {}
  return listIndex.idSetFingerprint(names.map(idFromFile));
}

// ── 登錄與取用 ───────────────────────────────────────────────────────────────
const skippedByWs = new Map(); // normalizeWorkspace(ws) → [{file, reason}]（最近一次重建略過的壞檔）

function chatDirOf(wsRoot) { return path.join(wsRoot, '.harness', 'runtime', 'chat_history'); }

function register() {
  listIndex.registerIndexKind('chat', (wsRoot) => {
    const dir = chatDirOf(wsRoot);
    const key = listIndex.normalizeWorkspace(wsRoot);
    return listIndex.open({
      kind: 'chat',
      indexPath: path.join(listIndex.indexDirFor(wsRoot), 'chat.json'),
      workspace: wsRoot,
      idOf: e => e.sessionId,
      sort: (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || String(a.sessionId).localeCompare(String(b.sessionId)),
      scanSource: async () => {
        const skipped = [];
        const items = await scanDir(dir, skipped);
        skippedByWs.set(key, skipped);
        if (skipped.length) console.error(`[ChatIndex] 重建略過 ${skipped.length} 個空檔／壞檔（不刪檔）：` + skipped.slice(0, 5).map(s => s.file).join(', ') + (skipped.length > 5 ? ' …' : ''));
        return items;
      },
      fingerprintSource: () => fingerprintDir(dir),
    });
  });
}

function handleFor(dir) {
  const ws = wsRootOfDir(dir);
  if (!ws) return null;
  try { return listIndex.getIndex('chat', ws); } catch (_) { return null; }
}

function skippedFor(wsRoot) { return skippedByWs.get(listIndex.normalizeWorkspace(wsRoot)) || []; }

// 業務檔（對話檔）已寫成功之後呼叫；永不丟出，目錄失敗＝下次核對／重建補回。
function syncUpsert(dir, data, fileId) {
  try {
    const h = handleFor(dir);
    if (!h) return;
    h.upsert(entryFromData(data, fileId)).catch(() => {});
  } catch (_) {}
}
function syncRemove(dir, sessionId) {
  try {
    const h = handleFor(dir);
    if (!h) return;
    h.remove(sessionId).catch(() => {});
  } catch (_) {}
}

// 取全部項目：{ items, fallback }。目錄不可用時自動走「非同步掃資料夾」保底（欄位形狀相同），fallback:true。
async function listAll(dir) {
  const h = handleFor(dir);
  if (h) {
    const r = await h.list();
    if (!r.fallback) return { items: r.items, fallback: false };
  }
  return { items: await scanDir(dir), fallback: true };
}

// ── 三支清單的過濾（與改前行為一致）─────────────────────────────────────────
const hasScope = e => !!(e.filePath || e.meetingId || e.pmProjectIds || e.contextKind);
const derivedTitle = (e, empty, dots) => {
  if (e.title) return e.title;
  if (e.firstUser == null) return empty;
  return e.firstUser.slice(0, 30) + (dots && e.firstUser.length > 30 ? '...' : '');
};

// GET /api/chat/history：只列 human 且沒有任何脈絡的自由對話；回 {sessionId,title,updatedAt}，新到舊。
function toHistoryList(items) {
  return items
    .filter(e => e.origin === 'human' && !hasScope(e))
    .map(e => ({ sessionId: e.sessionId, title: derivedTitle(e, '無主題對話', true), updatedAt: e.updatedAt }))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

// GET /api/chat-sessions?filePath= / ?ctxKey=
function toSessionsByFile(items, filePath) {
  return items.filter(e => e.filePath && e.filePath === filePath)
    .map(e => ({ sessionId: e.sessionId, title: derivedTitle(e, '無主題對話', false), updatedAt: e.updatedAt, filePath: e.filePath }));
}
function toSessionsByCtx(items, ctxKey) {
  return items.filter(e => e.contextKey && e.contextKey === ctxKey)
    .map(e => ({ sessionId: e.sessionId, title: derivedTitle(e, '無主題對話', false), updatedAt: e.updatedAt, contextLabel: e.contextLabel || null }));
}
function sortSessions(out) {
  return out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

// Telegram：排除 schedule 與有脈絡者（telegram 來源的保留）；messages 只在被讀取時才開檔（/back、摘要卡需要）。
function toTelegramList(items, dir) {
  const out = items
    .filter(e => e.origin !== 'schedule' && !hasScope(e))
    .map(e => {
      const o = { sessionId: e.sessionId, title: derivedTitle(e, '新對話', true), updatedAt: e.updatedAt, msgCount: e.msgCount, lastText: e.lastText };
      let cached = null;
      Object.defineProperty(o, 'messages', {
        enumerable: true,
        get() {
          if (cached) return cached;
          try {
            const d = JSON.parse(fs.readFileSync(path.join(dir, `chat_${e.sessionId}.json`), 'utf8'));
            cached = Array.isArray(d.messages) ? d.messages : [];
          } catch (_) { cached = []; }
          return cached;
        },
      });
      return o;
    });
  return out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

// ── 對話檔「先寫暫存再換名」（只改寫法，不改內容格式）───────────────────────────
// 同步版（呼叫端都是同步流程）。Windows 上 rename 被防毒／其他程式短暫鎖住（EPERM/EBUSY/EACCES）時重試。
const _sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function writeFileAtomicSync(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, text, 'utf8');
  const delays = [20, 50, 100, 200, 400];
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) {
      if (i < delays.length && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES')) { Atomics.wait(_sleepBuf, 0, 0, delays[i]); continue; }
      try { fs.unlinkSync(tmp); } catch (_) {}
      throw e;
    }
  }
}

module.exports = {
  register, entryFromData, scanDir, fingerprintDir, wsRootOfDir, chatDirOf,
  listAll, handleFor, skippedFor, syncUpsert, syncRemove,
  toHistoryList, toSessionsByFile, toSessionsByCtx, sortSessions, toTelegramList,
  writeFileAtomicSync,
};

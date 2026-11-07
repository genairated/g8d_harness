// meetings-index.js — AI 會議清單目錄（SPEC-list-index.md §9.8，IDX-MTG）。
//
// 每個工作區一份 <ws>/.harness/index/meetings.json；目錄的讀寫、排隊、原子替換、重建骨架全部交給
// 共用模組 list-index.js，本檔不另寫一套。<ws>/.harness/runtime/meetings/<id>/meta.json 才是真相。
// 目錄項目＝meta.json 原樣（≤2 KB，清單回傳的欄位與改前完全相同）。
//
// 注意：錄製器／匯入器是 Python 子程序，它們會自己改 meta.json（status 由 recording／importing／
// transcribing 變 done／error），伺服器不會知道。因此 listAll 會把目錄中「仍在進行中」的幾筆
// 重讀一次實際 meta（通常 0～2 筆），有變就順手更新目錄。
const fs = require('fs');
const path = require('path');
const listIndex = require('./list-index');

const fsp = fs.promises;

const IN_FLIGHT = new Set(['recording', 'importing', 'transcribing']);

function meetingsDirOf(wsRoot) { return path.join(wsRoot, '.harness', 'runtime', 'meetings'); }

// <ws>/.harness/runtime/meetings/<id> → <ws>；不是標準位置就回 null。
function wsRootOfMeetingDir(meetingDir) {
  try {
    const d = path.resolve(meetingDir);
    const mdir = path.dirname(d), rt = path.dirname(mdir), hz = path.dirname(rt);
    if (path.basename(mdir).toLowerCase() === 'meetings' && path.basename(rt).toLowerCase() === 'runtime' && path.basename(hz).toLowerCase() === '.harness') {
      return path.dirname(hz);
    }
  } catch (_) {}
  return null;
}

const byStartedDesc = (a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || ''));

// meta.json → 目錄項目（原樣；缺 meetingId 時以資料夾名補上，目錄用它當 id）。壞檔／非物件回 undefined。
function entryFromMeta(meta, folderId) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
  return meta.meetingId ? meta : Object.assign({}, meta, { meetingId: folderId });
}

async function readEntry(meetingDir) {
  try {
    const meta = JSON.parse(await fsp.readFile(path.join(meetingDir, 'meta.json'), 'utf8'));
    return entryFromMeta(meta, path.basename(meetingDir));
  } catch (_) { return undefined; }
}

// 掃資料夾 → 目錄項目（非同步、每 50 筆讓出）。沒有 meta.json 的資料夾（如 .git）略過。
async function scanDir(dir) {
  let names;
  try { names = (await fsp.readdir(dir)).filter(n => !n.startsWith('.')); } catch (_) { return []; }
  return listIndex.eachYield(names, (id) => readEntry(path.join(dir, id)));
}

// 便宜的核對值：資料夾名稱（只 stat 有沒有 meta.json，不開檔）。
async function fingerprintDir(dir) {
  let names = [];
  try { names = (await fsp.readdir(dir)).filter(n => !n.startsWith('.')); } catch (_) {}
  const has = await Promise.all(names.map(n => fsp.access(path.join(dir, n, 'meta.json')).then(() => true, () => false)));
  return listIndex.idSetFingerprint(names.filter((n, i) => has[i]));
}

function register() {
  listIndex.registerIndexKind('meetings', (wsRoot) => {
    const dir = meetingsDirOf(wsRoot);
    return listIndex.open({
      kind: 'meetings',
      indexPath: path.join(listIndex.indexDirFor(wsRoot), 'meetings.json'),
      workspace: wsRoot,
      idOf: e => e.meetingId,
      sort: byStartedDesc,
      scanSource: () => scanDir(dir),
      fingerprintSource: () => fingerprintDir(dir),
    });
  });
}

function handleFor(wsRoot) {
  if (!wsRoot) return null;
  try { return listIndex.getIndex('meetings', wsRoot); } catch (_) { return null; }
}

// meta.json 已寫成功之後呼叫（業務檔先、目錄後）；永不丟出，目錄失敗＝下次核對／重建補回。
function syncDir(meetingDir) {
  try {
    const h = handleFor(wsRootOfMeetingDir(meetingDir));
    if (!h) return Promise.resolve();
    return readEntry(meetingDir).then(e => { if (e) return h.upsert(e); }).catch(() => {});
  } catch (_) { return Promise.resolve(); }
}
function syncRemove(meetingDir) {
  try {
    const h = handleFor(wsRootOfMeetingDir(meetingDir));
    if (!h) return Promise.resolve();
    return h.remove(path.basename(meetingDir)).catch(() => {});
  } catch (_) { return Promise.resolve(); }
}

// 取全部會議（新到舊）：{ items, fallback }。目錄不可用時走非同步掃資料夾保底（欄位形狀相同），fallback:true。
async function listAll(wsRoot) {
  const dir = meetingsDirOf(wsRoot);
  const h = handleFor(wsRoot);
  if (h) {
    const r = await h.list();
    if (!r.fallback) {
      // Python 子程序會自己改 meta：進行中的幾筆以實際檔案為準。
      const items = r.items.slice();
      let changed = false;
      for (let i = 0; i < items.length; i++) {
        if (!IN_FLIGHT.has(items[i].status)) continue;
        const fresh = await readEntry(path.join(dir, items[i].meetingId));
        if (fresh && JSON.stringify(fresh) !== JSON.stringify(items[i])) { items[i] = fresh; changed = true; h.upsert(fresh).catch(() => {}); }
      }
      return { items: changed ? items.sort(byStartedDesc) : items, fallback: false };
    }
  }
  return { items: (await scanDir(dir)).sort(byStartedDesc), fallback: true };
}

module.exports = {
  register, entryFromMeta, scanDir, fingerprintDir, meetingsDirOf, wsRootOfMeetingDir,
  listAll, handleFor, syncDir, syncRemove, IN_FLIGHT,
};

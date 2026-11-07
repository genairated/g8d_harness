// document-registry.js — .documents/ storage helpers + registry (index.json) read/write
// DOC-I1-01 / DOC-I1-02 / DOC-I1-03
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const listIndex = require('./list-index');   // IDX-DOC: SPEC-list-index.md §9.9 — 登錄 kind 'documents'（重建／核對／狀態）

const DOCS_DIR   = '.documents';
const INDEX_FILE = 'index.json';

// ── Path helpers ──────────────────────────────────────────────────────────────

function getDocumentsDir(workspaceRoot) {
  return path.join(workspaceRoot, DOCS_DIR);
}

function getDocumentDir(workspaceRoot, id) {
  return path.join(workspaceRoot, DOCS_DIR, id);
}

function getRegistryPath(workspaceRoot) {
  return path.join(workspaceRoot, DOCS_DIR, INDEX_FILE);
}

// ── UUID ──────────────────────────────────────────────────────────────────────

function generateDocId() {
  return crypto.randomUUID();
}

// ── Directory structure ───────────────────────────────────────────────────────
// Creates <workspace>/.documents/<id>/assets/ and .../exports/

function ensureDocumentDir(workspaceRoot, id) {
  const dir = getDocumentDir(workspaceRoot, id);
  fs.mkdirSync(path.join(dir, 'assets'),  { recursive: true });
  fs.mkdirSync(path.join(dir, 'exports'), { recursive: true });
  return dir;
}

// ── Registry read/write ───────────────────────────────────────────────────────
// Schema: { documents: [ { id, sourcePath, mdPath, type, exports[], convertedAt, updatedAt } ] }
// 無 title 欄：顯示名稱由 sourcePath（原始檔名）推導。Word 自由格式無可靠標題、title 又易誤解。

// IDX-DOC：目錄檔 index.json 格式不變（{ documents[], trash[] }，另加選配 orphans[]＝重建時掃到的孤兒資料夾快取）。
// 讀：以「修改時間＋大小」做記憶體快取，沒變就不重讀、不重 parse；回傳的是複本（呼叫端慣例是就地改了再 writeRegistry）。
// 寫：先寫 index.json.tmp-* 再 rename 蓋過去（中斷時磁碟上不是舊的完整版就是新的完整版）；rename 被鎖（EPERM／EBUSY）重試。
// 排隊：此模組的讀改寫全是同步函式，Node 單執行緒下同一程序內不可能交錯＝天然串成一條，
//       同時匯入兩份文件不會互相覆蓋（單元測試有驗）。共用模組的非同步排隊用不上（呼叫端全是同步鏈）。
const _regCache = new Map();   // registry path → { mtimeMs, size, data }
const _RENAME_RETRY = [50, 100, 200, 400, 800];
function _sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) {} }

function readRegistry(workspaceRoot) {
  const p = getRegistryPath(workspaceRoot);
  let st;
  try { st = fs.statSync(p); } catch (_) { _regCache.delete(p); return { documents: [] }; }
  const c = _regCache.get(p);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return structuredClone(c.data);
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!data || typeof data !== 'object' || !Array.isArray(data.documents)) throw new Error('registry has no documents[]');
    _regCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, data });
    return structuredClone(data);
  } catch (e) {
    console.error('[DocRegistry] Failed to read registry:', e.message);
    return { documents: [] };
  }
}

function writeRegistry(workspaceRoot, registry) {
  const dir = getDocumentsDir(workspaceRoot);
  fs.mkdirSync(dir, { recursive: true });
  const p = getRegistryPath(workspaceRoot);
  const text = JSON.stringify(registry, null, 2);
  const tmp = p + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, text, 'utf8');
  let lastErr = null;
  for (let i = 0; i <= _RENAME_RETRY.length; i++) {
    try { fs.renameSync(tmp, p); lastErr = null; break; }
    catch (e) {
      lastErr = e;
      if (!(e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES')) || i === _RENAME_RETRY.length) break;
      _sleepSync(_RENAME_RETRY[i]);
    }
  }
  if (lastErr) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw lastErr;     // 這份目錄就是文件的登記簿，寫不進去不能假裝成功
  }
  try { const st = fs.statSync(p); _regCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, data: structuredClone(registry) }); }
  catch (_) { _regCache.delete(p); }
}

// Add or update a document entry; updatedAt is always refreshed.
function upsertDocument(workspaceRoot, doc) {
  const reg = readRegistry(workspaceRoot);
  const idx = reg.documents.findIndex(d => d.id === doc.id);
  const now = new Date().toISOString();
  if (idx >= 0) {
    reg.documents[idx] = { ...reg.documents[idx], ...doc, updatedAt: now };
  } else {
    reg.documents.push({ convertedAt: now, exports: [], ...doc, updatedAt: now });
  }
  writeRegistry(workspaceRoot, reg);
  return reg.documents.find(d => d.id === doc.id);
}

function removeDocument(workspaceRoot, id) {
  const reg = readRegistry(workspaceRoot);
  reg.documents = reg.documents.filter(d => d.id !== id);
  writeRegistry(workspaceRoot, reg);
}

// ── 刪除 / 資源回收桶（soft-delete + recycle bin）─────────────────────────────
// 軟刪除＝從 documents 移到 trash[]（蓋 deletedAt），目錄留著、從列表消失、可還原。
// 徹底刪除（purge）才真的 rm 目錄。孤兒＝磁碟上有、documents/trash 都沒關聯的 UUID 目錄。
const _UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function _dirSizeBytes(dir) {
  let total = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += _dirSizeBytes(p);
    else { try { total += fs.statSync(p).size; } catch (_) {} }
  }
  return total;
}

function softDeleteDocument(workspaceRoot, id) {
  const reg = readRegistry(workspaceRoot);
  if (!Array.isArray(reg.trash)) reg.trash = [];
  const i = reg.documents.findIndex(d => d.id === id);
  if (i < 0) return null;
  const doc = reg.documents.splice(i, 1)[0];
  doc.deletedAt = new Date().toISOString();
  doc.sizeBytes = _dirSizeBytes(getDocumentDir(workspaceRoot, id));   // IDX-DOC：移入回收桶時算一次，清單不再遞迴算
  reg.trash.push(doc);
  writeRegistry(workspaceRoot, reg);
  return doc;
}

function restoreDocument(workspaceRoot, id) {
  const reg = readRegistry(workspaceRoot);
  if (!Array.isArray(reg.trash)) reg.trash = [];
  const i = reg.trash.findIndex(d => d.id === id);
  if (i < 0) return null;                 // 孤兒（不在 trash）無法還原——沒有 registry 記錄
  const doc = reg.trash.splice(i, 1)[0];
  delete doc.deletedAt;
  delete doc.sizeBytes;
  doc.updatedAt = new Date().toISOString();
  reg.documents.push(doc);
  writeRegistry(workspaceRoot, reg);
  return doc;
}

// 徹底刪除：從 trash/documents 移除 + rm 目錄。孤兒也可 purge（只 rm 目錄）。
function purgeDocument(workspaceRoot, id) {
  if (!_UUID_RE.test(id)) throw new Error('refuse to purge non-UUID id: ' + id);   // 防呆
  const reg = readRegistry(workspaceRoot);
  if (Array.isArray(reg.trash)) reg.trash = reg.trash.filter(d => d.id !== id);
  reg.documents = reg.documents.filter(d => d.id !== id);
  if (Array.isArray(reg.orphans)) reg.orphans = reg.orphans.filter(o => o.id !== id);
  writeRegistry(workspaceRoot, reg);
  const dir = getDocumentDir(workspaceRoot, id);
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) { console.error('[DocRegistry] purge rm failed:', e.message); }
  return true;
}

// 資源回收桶清單＝軟刪除的 trash[]（大小在移入時已存好）＋ 重建時掃到並存進目錄的孤兒 orphans[]。
// IDX-DOC：這裡只讀目錄，不 readdir、不開 doc.md、不遞迴算大小；孤兒掃描與舊項目補大小都移到 rebuildDocuments()。
function listRecycle(workspaceRoot) {
  const reg = readRegistry(workspaceRoot);
  const trash = Array.isArray(reg.trash) ? reg.trash : [];
  const known = new Set([...reg.documents.map(d => d.id), ...trash.map(d => d.id)]);

  const items = trash.map(d => ({
    id: d.id, sourcePath: d.sourcePath || '', title: d.title || '',
    bornAt: d.bornAt || d.convertedAt || null, deletedAt: d.deletedAt || null,
    sizeBytes: typeof d.sizeBytes === 'number' ? d.sizeBytes : 0, kind: 'trash',
  }));
  for (const o of (Array.isArray(reg.orphans) ? reg.orphans : [])) {
    if (!o || known.has(o.id)) continue;
    items.push({ id: o.id, sourcePath: o.sourcePath || '', title: '', bornAt: o.bornAt || null, deletedAt: null,
      sizeBytes: typeof o.sizeBytes === 'number' ? o.sizeBytes : 0, kind: 'orphan' });
  }
  // 刪除時間新→舊；孤兒(無 deletedAt)排後面
  items.sort((a, b) => (b.deletedAt || '') < (a.deletedAt || '') ? -1 : 1);
  return items;
}

function emptyRecycle(workspaceRoot) {
  const items = listRecycle(workspaceRoot);
  let purged = 0;
  for (const it of items) { try { purgeDocument(workspaceRoot, it.id); purged++; } catch (_) {} }
  return purged;
}

// DOC-P2D-04: mark/clear a document's "已變更" (working copy edited, not yet written back to
// the original sourcePath 真身). Distinct from `revisions` (which counts history events).
function setDocDirty(workspaceRoot, id, dirty) {
  const reg = readRegistry(workspaceRoot);
  const doc = reg.documents.find(d => d.id === id);
  if (!doc) return null;
  if (dirty) doc.dirty = true;
  else       delete doc.dirty;
  doc.updatedAt = new Date().toISOString();
  writeRegistry(workspaceRoot, reg);
  return doc;
}

// ── Version history (DOC-J5) ──────────────────────────────────────────────────
// Per-document timeline that unifies birth + every later edit, layered ON TOP of git
// (the app keeps fine-grained snapshots+log; git stays the durable backup). Storage:
//   .documents/<id>/history/
//     log.json        ← event array (rev 0 = born; rev>0 = edit)
//     doc.<rev>.md    ← snapshot of doc.md *after* that event
// registry caches origin/bornAt/revisions so the list needn't scan the log.

const HISTORY_DIR = 'history';
const HISTORY_LOG = 'log.json';

function getHistoryDir(workspaceRoot, id) {
  return path.join(getDocumentDir(workspaceRoot, id), HISTORY_DIR);
}

function readDocHistory(workspaceRoot, id) {
  const p = path.join(getHistoryDir(workspaceRoot, id), HISTORY_LOG);
  if (!fs.existsSync(p)) return [];
  try {
    const events = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(events) ? events : [];
  } catch (e) {
    console.error('[DocHistory] Failed to read log:', e.message);
    return [];
  }
}

function writeDocHistory(workspaceRoot, id, events) {
  const dir = getHistoryDir(workspaceRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, HISTORY_LOG), JSON.stringify(events, null, 2), 'utf8');
}

// Record one event: snapshot the current doc.md as doc.<nextRev>.md, append to log,
// then sync the registry cache (revisions/updatedAt; born also sets origin/bornAt).
//   opts = {
//     kind: 'born' | 'edit', by, summary, origin?,
//     change?:  'text' | 'flow' | 'image'             — J8: type of change for timeline icon/diff
//     assets?:  [{type:'flow'|'image', path:'assets/foo.bpmn', beforeContent?:Buffer}]
//               path relative to docDir; beforeContent = file state BEFORE this edit for COW baseline
//   }
// Returns the appended event.
function appendDocHistory(workspaceRoot, id, { kind, by, summary, origin, change, assets } = {}) {
  const docDir  = getDocumentDir(workspaceRoot, id);
  const mdPath  = path.join(docDir, 'doc.md');
  const histDir = getHistoryDir(workspaceRoot, id);
  fs.mkdirSync(histDir, { recursive: true });

  const events  = readDocHistory(workspaceRoot, id);
  const nextRev = events.length === 0 ? 0 : (events[events.length - 1].rev + 1);
  const ts      = new Date().toISOString();

  // ── Copy-on-write baseline for sibling assets (DOC-J8-01) ──────────────────
  // First time a sibling asset (bpmn/image) is touched: write its "before" content as a baseline
  // under the born event so that `resolveAssetSnapshot(rev < firstEdit)` has something to return.
  // This makes the first diff's "before" available without snapshotting everything at birth.
  const assetList = Array.isArray(assets) ? assets : [];
  for (const a of assetList) {
    if (!a.path || a.beforeContent == null) continue;
    const base = path.basename(a.path);
    const alreadySnapshotted = events.some(ev =>
      Array.isArray(ev.assets) && ev.assets.some(ea => path.basename(ea.path || '') === base && ea.snapshot)
    );
    if (!alreadySnapshotted && events.length > 0) {
      // Baseline under the born event (events[0])
      const bornRev   = events[0].rev;
      const baseDir   = path.join(histDir, 'assets', String(bornRev));
      fs.mkdirSync(baseDir, { recursive: true });
      try {
        fs.writeFileSync(path.join(baseDir, base), a.beforeContent);
        if (!Array.isArray(events[0].assets)) events[0].assets = [];
        events[0].assets.push({ type: a.type, path: a.path,
          snapshot: 'assets/' + bornRev + '/' + base });
      } catch (e) { console.error('[DocHistory] COW baseline failed:', e.message); }
    }
  }

  // ── Snapshot the current doc.md ────────────────────────────────────────────
  let snapshot = null;
  if (fs.existsSync(mdPath)) {
    snapshot = `doc.${nextRev}.md`;
    try { fs.copyFileSync(mdPath, path.join(histDir, snapshot)); }
    catch (e) { console.error('[DocHistory] snapshot failed:', e.message); snapshot = null; }
  }

  // ── Snapshot sibling assets (DOC-J8-01) ───────────────────────────────────
  // Current on-disk state of each asset = "after" state of this edit.
  const snapshotedAssets = [];
  for (const a of assetList) {
    if (!a.path) continue;
    const assetAbs = path.join(docDir, a.path);
    if (!fs.existsSync(assetAbs)) continue;
    const base   = path.basename(a.path);
    const revDir = path.join(histDir, 'assets', String(nextRev));
    fs.mkdirSync(revDir, { recursive: true });
    try {
      fs.copyFileSync(assetAbs, path.join(revDir, base));
      snapshotedAssets.push({ type: a.type, path: a.path, snapshot: 'assets/' + nextRev + '/' + base });
    } catch (e) { console.error('[DocHistory] asset snapshot failed:', e.message); }
  }

  const ev = { rev: nextRev, ts, kind, by: by || 'Hana', summary: summary || '' };
  if (kind === 'born')          ev.origin  = origin || 'imported';
  if (change)                   ev.change  = change;
  if (snapshotedAssets.length)  ev.assets  = snapshotedAssets;
  ev.snapshot = snapshot;
  events.push(ev);
  writeDocHistory(workspaceRoot, id, events);   // includes any COW mutations to events[0]

  // Sync registry cache (single source for the list: origin/bornAt/revisions).
  const reg = readRegistry(workspaceRoot);
  const doc = reg.documents.find(d => d.id === id);
  if (doc) {
    if (kind === 'born') {
      doc.origin    = origin || 'imported';
      doc.bornAt    = ts;
      doc.revisions = 0;
    } else {
      doc.revisions = events.filter(e => e.kind !== 'born').length;
    }
    doc.updatedAt = ts;
    writeRegistry(workspaceRoot, reg);
  }
  return ev;
}

// ── Asset snapshot resolution (DOC-J8-03) ────────────────────────────────────
// For a given assetRelPath (relative to docDir, e.g. 'assets/foo.bpmn'), return the absolute
// path to the most-recent snapshot at rev ≤ upToRev.  Returns null if none found or file missing.
// Derivation rule: path 相同、rev ≤ upToRev 的最後一筆 assets[] 快照。
function resolveAssetSnapshot(workspaceRoot, id, assetRelPath, upToRev) {
  const events  = readDocHistory(workspaceRoot, id);
  const histDir = getHistoryDir(workspaceRoot, id);
  const base    = path.basename(assetRelPath);
  let lastSnap  = null;
  for (const ev of events) {
    if (ev.rev > upToRev) break;
    if (!Array.isArray(ev.assets)) continue;
    for (const a of ev.assets) {
      if (path.basename(a.path || '') === base && a.snapshot) {
        lastSnap = path.join(histDir, a.snapshot.replace(/\//g, path.sep));
      }
    }
  }
  if (!lastSnap) return null;
  return fs.existsSync(lastSnap) ? lastSnap : null;
}

// Resolve a doc id from an absolute path inside .documents/<id>/… (null if not under one).
function docIdFromPath(workspaceRoot, absPath) {
  const docsRoot = getDocumentsDir(workspaceRoot);
  const rel = path.relative(docsRoot, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const first = rel.split(/[\\/]/)[0];
  return first && first !== INDEX_FILE ? first : null;
}

// Backfill existing documents (pre-J5) onto the history mechanism: write a rev-0
// born:imported event with doc.0.md = current doc.md, set origin/bornAt/revisions.
// Idempotent — skips docs that already have a log. Returns { backfilled, skipped }.
// IDX-DOC：不再由 GET /api/documents 每次呼叫；改在開機核對／重建目錄時背景跑（見 rebuildDocuments）。
// 同步版保留給測試與手動呼叫。
function _backfillOne(workspaceRoot, doc) {
  // Skip only when a history log actually exists — origin alone isn't proof (a registry entry
  // could carry origin without its log/born snapshot). existsSync is the cheap hot-path guard.
  const logPath = path.join(getHistoryDir(workspaceRoot, doc.id), HISTORY_LOG);
  if (doc.origin && fs.existsSync(logPath)) return false;
  if (readDocHistory(workspaceRoot, doc.id).length > 0) return false;
  const mdPath = path.join(getDocumentDir(workspaceRoot, doc.id), 'doc.md');
  if (!fs.existsSync(mdPath)) return false;
  const histDir = getHistoryDir(workspaceRoot, doc.id);
  fs.mkdirSync(histDir, { recursive: true });
  fs.copyFileSync(mdPath, path.join(histDir, 'doc.0.md'));
  const ts = doc.convertedAt || doc.updatedAt || new Date().toISOString();
  writeDocHistory(workspaceRoot, doc.id, [{
    rev: 0, ts, kind: 'born', origin: 'imported', by: '老闆',
    summary: `匯入自 ${doc.sourcePath || '未知來源'}`, snapshot: 'doc.0.md',
  }]);
  doc.origin    = 'imported';
  doc.bornAt    = ts;
  doc.revisions = 0;
  return true;
}

function backfillDocHistory(workspaceRoot) {
  const reg = readRegistry(workspaceRoot);
  let backfilled = 0, skipped = 0;
  for (const doc of reg.documents) { if (_backfillOne(workspaceRoot, doc)) backfilled++; else skipped++; }
  if (backfilled > 0) writeRegistry(workspaceRoot, reg);
  return { backfilled, skipped };
}

// ── IDX-DOC：重建／核對（SPEC-list-index.md §5、§9.9）──────────────────────────
// 重建＝① 孤兒資料夾掃描（只認 UUID 目錄、排除 documents/trash 已知的），結果與大小存進 orphans[]；
//       ② trash 項目缺 sizeBytes 的補算一次（舊資料）；③ pre-J5 文件歷史回填；
//       ④ registry 核對：登記了但資料夾不見的文件只回報數量（missing）、不刪資料。非同步、每 50 筆讓出。
// 讀到寫之間會 await，所以最後寫入前重讀最新版、只套用算出的欄位，避免蓋掉期間發生的 API 寫入。
const _yield = () => new Promise(r => setImmediate(r));
const _fsp = fs.promises;
async function _dirSizeAsync(dir) {
  let total = 0, entries = [];
  try { entries = await _fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await _dirSizeAsync(p);
    else { try { total += (await _fsp.stat(p)).size; } catch (_) {} }
  }
  return total;
}

async function rebuildDocuments(workspaceRoot) {
  const t0 = Date.now();
  const snap = readRegistry(workspaceRoot);
  const docsRoot = getDocumentsDir(workspaceRoot);
  if (!fs.existsSync(docsRoot)) return { ok: true, documents: 0, trash: 0, orphans: 0, missing: 0, backfilled: 0, sizesFilled: 0, ms: 0 };
  const trash0 = Array.isArray(snap.trash) ? snap.trash : [];

  const sizes = {};
  let n = 0;
  for (const d of trash0) {
    if (typeof d.sizeBytes === 'number') continue;
    if (++n % 50 === 0) await _yield();
    sizes[d.id] = await _dirSizeAsync(getDocumentDir(workspaceRoot, d.id));
  }

  const known = new Set([...snap.documents.map(d => d.id), ...trash0.map(d => d.id)]);
  const orphans = [];
  let dirs = [];
  try { dirs = (await _fsp.readdir(docsRoot, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name); } catch (_) {}
  let i = 0;
  for (const name of dirs) {
    if (++i % 50 === 0) await _yield();
    if (!_UUID_RE.test(name) || known.has(name)) continue;
    const base = path.join(docsRoot, name);
    let sourcePath = '', bornAt = null;
    try {
      const parsed = parseFrontMatter(await _fsp.readFile(path.join(base, 'doc.md'), 'utf8'));
      sourcePath = parsed.meta.source || '';
      bornAt = parsed.meta.convertedAt || null;
    } catch (_) {}
    if (!bornAt) { try { bornAt = (await _fsp.stat(base)).birthtime.toISOString(); } catch (_) {} }
    orphans.push({ id: name, sourcePath, bornAt, sizeBytes: await _dirSizeAsync(base) });
  }

  let missing = 0, k = 0;
  for (const d of snap.documents) {
    if (++k % 50 === 0) await _yield();
    try { await _fsp.access(getDocumentDir(workspaceRoot, d.id)); } catch (_) { missing++; }
  }

  const bf = {};   // id → { origin, bornAt, revisions }
  let backfilled = 0, j = 0;
  for (const d of snap.documents) {
    if (++j % 50 === 0) await _yield();
    const copy = { ...d };
    try { if (_backfillOne(workspaceRoot, copy)) { backfilled++; bf[d.id] = { origin: copy.origin, bornAt: copy.bornAt, revisions: copy.revisions }; } }
    catch (e) { console.error('[DocHistory] backfill failed:', d.id, e.message); }
  }

  // 寫回（同步區段，不會再被交錯）
  const cur = readRegistry(workspaceRoot);
  let changed = false;
  for (const d of (cur.trash || [])) if (typeof d.sizeBytes !== 'number' && sizes[d.id] != null) { d.sizeBytes = sizes[d.id]; changed = true; }
  for (const d of cur.documents) if (bf[d.id] && !d.origin) { Object.assign(d, bf[d.id]); changed = true; }
  const curKnown = new Set([...cur.documents.map(d => d.id), ...(cur.trash || []).map(d => d.id)]);
  const nextOrphans = orphans.filter(o => !curKnown.has(o.id));
  if (JSON.stringify(nextOrphans) !== JSON.stringify(cur.orphans || [])) {
    if (nextOrphans.length) cur.orphans = nextOrphans; else delete cur.orphans;
    changed = true;
  }
  if (changed) writeRegistry(workspaceRoot, cur);
  return { ok: true, documents: snap.documents.length, trash: trash0.length, orphans: nextOrphans.length, missing,
    backfilled, sizesFilled: Object.keys(sizes).length, ms: Date.now() - t0 };
}

// 便宜的核對：只列 .documents/ 底下的 UUID 資料夾名稱（不開檔）與 registry 的 id 集合比對。
async function _checkState(workspaceRoot) {
  let names = [];
  try { names = (await _fsp.readdir(getDocumentsDir(workspaceRoot), { withFileTypes: true })).filter(e => e.isDirectory() && _UUID_RE.test(e.name)).map(e => e.name); } catch (_) {}
  const reg = readRegistry(workspaceRoot);
  const regIds = new Set([...reg.documents.map(d => d.id), ...(reg.trash || []).map(d => d.id), ...(reg.orphans || []).map(d => d.id)]);
  const diskIds = new Set(names);
  return {
    sameSet: regIds.size === diskIds.size && [...regIds].every(x => diskIds.has(x)),
    trashNoSize: (reg.trash || []).some(d => typeof d.sizeBytes !== 'number'),
    needBackfill: reg.documents.some(d => !d.origin),
  };
}

// 登錄成清單目錄的一種 kind（'documents'）：讓 POST /api/index/rebuild、GET /api/index/status、開機核對都管得到文件管理。
// 目錄檔仍是 <ws>/.documents/index.json（既有位置與格式），所以這裡的 handle 是自訂的，不走 list-index 的 items 格式。
function registerIndexKind() {
  listIndex.registerIndexKind('documents', (wsRoot) => {
    if (!fs.existsSync(getDocumentsDir(wsRoot))) return null;    // 這個工作區沒有文件管理
    let rebuilding = null, lastError = null, lastErrorAt = null, lastResult = null, rebuiltAt = null;
    const run = (reason) => {
      if (rebuilding) return rebuilding;
      rebuilding = rebuildDocuments(wsRoot)
        .then(r => { lastResult = Object.assign({ reason }, r); rebuiltAt = new Date().toISOString(); return r; })
        .catch(e => { lastError = e.message; lastErrorAt = new Date().toISOString(); return { ok: false, error: e.message }; })
        .finally(() => { rebuilding = null; });
      return rebuilding;
    };
    return {
      kind: 'documents', indexPath: getRegistryPath(wsRoot), archivePath: null,
      rebuild: ({ reason } = {}) => run(reason || 'api'),
      async verify() {
        try {
          const st = await _checkState(wsRoot);
          if (!st.sameSet || st.trashNoSize || st.needBackfill) {
            await run('verify');
            return { ok: true, rebuilt: true, reason: !st.sameSet ? 'fingerprint' : (st.trashNoSize ? 'trash-size' : 'backfill') };
          }
          return { ok: true, rebuilt: false };
        } catch (e) { lastError = e.message; lastErrorAt = new Date().toISOString(); return { ok: false, error: e.message }; }
      },
      async status() {
        const reg = readRegistry(wsRoot);
        let st = null; try { st = fs.statSync(getRegistryPath(wsRoot)); } catch (_) {}
        return { kind: 'documents', workspace: wsRoot, indexPath: getRegistryPath(wsRoot), archivePath: null,
          valid: !!st, count: reg.documents.length, archivedCount: (reg.trash || []).length, orphans: (reg.orphans || []).length,
          updatedAt: st ? st.mtime.toISOString() : null, rebuiltAt,
          rebuilding: !!rebuilding, pendingWrites: 0, lastError, lastErrorAt, lastResult };
      },
    };
  });
}

// ── Front-matter parse/write (JS) ─────────────────────────────────────────────
// Simple YAML-subset: scalar values + arrays written as [a, b, c].
// front-matter is the source of truth; registry is a cache rebuilt from it.

function parseFrontMatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { meta: {}, body: content };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)/);
    if (!m) continue;
    let val = m[2].trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
    }
    meta[m[1]] = val;
  }
  return { meta, body: content.slice(match[0].length) };
}

function stringifyFrontMatter(meta) {
  const lines = [];
  for (const [k, v] of Object.entries(meta)) {
    lines.push(Array.isArray(v) ? `${k}: [${v.join(', ')}]` : `${k}: ${v}`);
  }
  return '---\n' + lines.join('\n') + '\n---\n';
}

// Merge `meta` into the file's existing front-matter (new keys win), preserve body.
function writeFrontMatter(mdPath, meta) {
  let body = '';
  let existing = {};
  if (fs.existsSync(mdPath)) {
    const parsed = parseFrontMatter(fs.readFileSync(mdPath, 'utf8'));
    existing = parsed.meta;
    body = parsed.body;
  }
  const merged = { ...existing, ...meta };
  fs.writeFileSync(mdPath, stringifyFrontMatter(merged) + body, 'utf8');
}

module.exports = {
  getDocumentsDir,
  getDocumentDir,
  getRegistryPath,
  generateDocId,
  ensureDocumentDir,
  readRegistry,
  writeRegistry,
  upsertDocument,
  removeDocument,
  softDeleteDocument,
  restoreDocument,
  purgeDocument,
  listRecycle,
  emptyRecycle,
  setDocDirty,
  getHistoryDir,
  readDocHistory,
  appendDocHistory,
  resolveAssetSnapshot,
  docIdFromPath,
  backfillDocHistory,
  rebuildDocuments,
  registerIndexKind,
  parseFrontMatter,
  stringifyFrontMatter,
  writeFrontMatter,
};

// ── CLI: doc-new helpers (DOC-J3) ─────────────────────────────────────────────
// Used by the `doc-new` skill (a CLI agent) to allocate + register a generated document
// without hand-writing the registry/history schema (that's what J5's appendDocHistory is for).
// Two steps, because appendDocHistory snapshots the CURRENT doc.md — the agent must write the
// finished content BETWEEN them:
//   1) new-doc        → allocate a uuid, create .documents/<uuid>/{assets,exports}/, print {id,mdPath}
//   2) <agent writes .documents/<uuid>/doc.md (+ assets) >
//   3) register-born  → write front-matter (type + provenance) + upsert registry + born:generated event
// cwd defaults to the active workspace root (the job runs there); override with --workspace.
if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd  = argv[0];
  const opt  = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a && a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next != null && !String(next).startsWith('--')) { opt[k] = next; i++; }
      else opt[k] = 'true';
    }
  }
  const ws = opt.workspace || process.cwd();

  if (cmd === 'new-doc') {
    const id = generateDocId();
    ensureDocumentDir(ws, id);
    console.log(JSON.stringify({
      ok: true, id,
      dir:    path.posix.join('.documents', id),
      mdPath: path.posix.join('.documents', id, 'doc.md'),
    }));
  } else if (cmd === 'register-born') {
    const id = opt.id;
    if (!id) { console.error('register-born: --id <uuid> required'); process.exit(1); }
    const mdAbs = path.join(getDocumentDir(ws, id), 'doc.md');
    if (!fs.existsSync(mdAbs)) {
      console.error('register-born: doc.md not found at ' + mdAbs + ' — write the document content first');
      process.exit(1);
    }
    const type = opt.type || 'doc';
    // Front-matter = type + provenance (NO title — registry/viewer derive the name from sourcePath).
    const fm = { type };
    if (opt.template) fm.template = opt.template;   // 從範本：家族名
    if (opt.source)   fm.source   = opt.source;     // 從複製：來源 docId / 路徑
    writeFrontMatter(mdAbs, fm);
    const name = opt.name || id;
    // sourcePath uses a 生成/<name> pseudo-path: viewer shows <name> (basename, ext stripped) as the
    // display name and "生成/<name>" as the location hint — mirroring how imported docs read.
    upsertDocument(ws, {
      id,
      sourcePath: opt.sourcePath || ('生成/' + name),
      mdPath: path.posix.join('.documents', id, 'doc.md'),
      type,
      exports: [],
    });
    const summary = opt.summary
      || (opt.template ? ('由範本「' + opt.template + '」生成')
      :  (opt.source   ? ('複製自 ' + opt.source + ' 生成')
      :  '由 Hana 生成'));
    appendDocHistory(ws, id, { kind: 'born', origin: opt.origin || 'generated', by: 'Hana', summary });
    console.log(JSON.stringify({ ok: true, id, mdPath: path.posix.join('.documents', id, 'doc.md') }));
  } else {
    console.error(
      'usage:\n' +
      '  node document-registry.js new-doc [--workspace <root>]\n' +
      '  node document-registry.js register-born --id <uuid> --name "<name>"\n' +
      '       [--origin generated] [--template "<family>"] [--source "<docId>"] [--summary "<text>"] [--workspace <root>]'
    );
    process.exit(1);
  }
}

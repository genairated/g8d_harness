// list-index.js — 全平台共用「清單目錄檔」讀寫模組（SPEC-list-index.md §3–§7，IDX-0）。
//
// 目錄檔（index.json）只是加在實際檔案旁邊的「快取」：清單 API 讀它、不再逐檔打開；實際檔案才是真相，
// 隨時可從實際檔案重建。本模組不認識任何功能——哪些欄位進目錄、怎麼掃實際檔案、怎麼判斷已歸檔，
// 全部由呼叫端在 open() 傳入。
//
// 保證：
//  - 讀：記憶體快取＋每次只 stat 修改時間；一律 fs.promises 非同步，不卡伺服器。
//  - 寫：同一 indexPath 一條排隊（同時進來的變更合併成一次寫入）；寫 *.tmp-<pid>-<亂數> 再 rename；
//    Windows 上被鎖（EPERM/EBUSY/EACCES）重試 5 次（50→800ms）。失敗只記錯誤、不丟出——
//    呼叫端的業務寫入不會因為目錄壞掉而失敗（目錄壞了可重建，業務資料不能丟）。
//  - 目錄缺檔／壞檔：list 回 { items:[], fallback:true } 讓呼叫端走舊路徑，並排一次重建。
//    此時 upsert/remove 不會寫出「只有一筆」的殘缺目錄，而是等重建（重建會從實際檔案掃到這筆）。
//  - 重建：非同步、每 50 筆 setImmediate 讓出；同一份同時只跑一個；重建期間的寫入排隊、重建完再套用。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA = 'harness.list-index/1';
const YIELD_EVERY = 50;
const RETRY_DELAYS = [50, 100, 200, 400, 800];
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const STALE_TMP_MS = 60 * 60 * 1000;

// 檔案操作集中在這裡，單元測試可替換（例如模擬 rename 被鎖）。
const io = {
  stat: p => fs.promises.stat(p),
  readFile: p => fs.promises.readFile(p, 'utf8'),
  writeFile: (p, s) => fs.promises.writeFile(p, s, 'utf8'),
  rename: (a, b) => fs.promises.rename(a, b),
  unlink: p => fs.promises.unlink(p),
  mkdir: p => fs.promises.mkdir(p, { recursive: true }),
  readdir: p => fs.promises.readdir(p),
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const yieldNow = () => new Promise(r => setImmediate(r));
const log = (...a) => console.error('[ListIndex]', ...a);

// ── 工作區與位置 ────────────────────────────────────────────────────────────
// path.resolve()+小寫。null／空字串＝harness home，由呼叫端以第二個參數傳入（模組不猜）。
function normalizeWorkspace(p, home) {
  const raw = p || home;
  if (!raw) throw new TypeError('normalizeWorkspace: workspace 為空且未提供 harness home');
  return path.resolve(String(raw)).toLowerCase();
}
// 工作區自有資料 → <ws>/.harness/index/
function indexDirFor(workspaceRoot) {
  return path.join(path.resolve(workspaceRoot), '.harness', 'index');
}
// 平台共用資料（實體檔在 harness home）→ <baseDir>/index/<sha1(正規化工作區) 前 12 碼>/
function sharedIndexDirFor(baseDir, workspaceRoot) {
  const key = crypto.createHash('sha1').update(normalizeWorkspace(workspaceRoot)).digest('hex').slice(0, 12);
  return path.join(path.resolve(baseDir), 'index', key);
}
// 便宜的核對值：id 集合（排序後）的雜湊＋數量。給 fingerprintSource 用（§5.2「只列檔名、不打開檔案」）。
function idSetFingerprint(ids) {
  const sorted = Array.from(ids, String).sort();
  return sorted.length + ':' + crypto.createHash('sha1').update(sorted.join('\n')).digest('hex').slice(0, 16);
}
// 給 scanSource 實作者用：逐筆處理、每 50 筆讓出一次，大工作區重建期間其他 API 照常回應。
async function eachYield(arr, fn, every = YIELD_EVERY) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    if (i && i % every === 0) await yieldNow();
    const v = await fn(arr[i], i);
    if (v !== undefined) out.push(v);
  }
  return out;
}

// ── 原子寫入 ────────────────────────────────────────────────────────────────
async function ensureDir(dir) {
  let existed = true;
  try { await io.stat(dir); } catch (_) { existed = false; }
  if (existed) return;
  await io.mkdir(dir);
  // 目錄是快取、不進版控：比照 .venv／.pytest_cache 的通行做法，在自己建立的目錄放一個「忽略全部」的 .gitignore，
  // 工作區自己的 .gitignore 不必改（使用者專案的 .gitignore 只忽略 .harness/runtime/）。
  try { await io.writeFile(path.join(dir, '.gitignore'), '# list-index 快取目錄，可隨時重建\n*\n'); } catch (_) {}
}
async function writeAtomic(file, text) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  await io.writeFile(tmp, text);
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try { await io.rename(tmp, file); return; } catch (e) {
      lastErr = e;
      if (!RETRY_CODES.has(e && e.code) || attempt === RETRY_DELAYS.length) break;
      await sleep(RETRY_DELAYS[attempt]);
    }
  }
  // 依 §4：保留暫存檔供診斷（讀取只認正式檔名，殘留暫存檔不影響讀）。
  const err = new Error(`rename ${path.basename(tmp)} → ${path.basename(file)} 失敗: ${lastErr && (lastErr.code || lastErr.message)}`);
  err.code = lastErr && lastErr.code;
  err.tmp = tmp;
  throw err;
}
async function cleanupStaleTmp(file) {
  const dir = path.dirname(file), base = path.basename(file) + '.tmp-';
  let names = [];
  try { names = await io.readdir(dir); } catch (_) { return; }
  for (const n of names) {
    if (!n.startsWith(base)) continue;
    try {
      const st = await io.stat(path.join(dir, n));
      if (Date.now() - st.mtimeMs > STALE_TMP_MS) await io.unlink(path.join(dir, n));
    } catch (_) {}
  }
}

// ── 單份目錄 ────────────────────────────────────────────────────────────────
const instances = new Map(); // 正規化 indexPath → handle（同一份目錄全程只有一條排隊）

function open(opts) {
  if (!opts || !opts.kind || !opts.indexPath) throw new TypeError('listIndex.open: 需要 kind 與 indexPath');
  const key = path.resolve(opts.indexPath).toLowerCase();
  if (instances.has(key)) return instances.get(key);
  const h = createIndex(opts);
  instances.set(key, h);
  return h;
}

function createIndex(opts) {
  const kind = opts.kind;
  const indexPath = path.resolve(opts.indexPath);
  const archivePath = opts.archivePath ? path.resolve(opts.archivePath) : null;
  const workspace = opts.workspace || null;
  const workspaceKey = workspace ? normalizeWorkspace(workspace) : null;
  const idOf = opts.idOf || (e => e && e.id);
  const isArchived = opts.isArchived || (() => false);
  const sort = opts.sort || null;
  const scanSource = opts.scanSource || null;
  const fingerprintSource = opts.fingerprintSource || null;

  const cache = new Map(); // filePath → { mtimeMs, size, data }
  const pending = [];      // 等待中的操作 { type:'upsert'|'remove'|'rebuild', ..., resolve }
  let working = false;
  let rebuilding = false;
  let queuedRebuild = null; // 尚未開始的重建（重複要求直接共用）
  let lastError = null;
  let lastErrorAt = null;

  // 讀一份目錄檔：{ ok:true, data } 或 { ok:false, reason:'missing'|'corrupt' }
  async function load(file) {
    let st;
    try { st = await io.stat(file); } catch (_) { cache.delete(file); return { ok: false, reason: 'missing' }; }
    const c = cache.get(file);
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return { ok: true, data: c.data };
    let data;
    try { data = JSON.parse(await io.readFile(file)); } catch (_) { cache.delete(file); return { ok: false, reason: 'corrupt' }; }
    if (!data || !Array.isArray(data.items)) { cache.delete(file); return { ok: false, reason: 'corrupt' }; }
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, data });
    return { ok: true, data };
  }
  async function loadAll() {
    const main = await load(indexPath);
    const arch = archivePath ? await load(archivePath) : { ok: true, data: null };
    return { main, arch, ok: main.ok && arch.ok };
  }
  async function save(file, items, meta) {
    const data = {
      schema: SCHEMA, kind, workspace, workspaceKey,
      updatedAt: new Date().toISOString(),
      rebuiltAt: meta.rebuiltAt || null,
      count: items.length,
      fingerprint: meta.fingerprint == null ? null : meta.fingerprint,
      items,
    };
    await writeAtomic(file, JSON.stringify(data));
    try {
      const st = await io.stat(file);
      cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, data });
    } catch (_) { cache.delete(file); }
  }
  function sorted(items) { return sort ? items.slice().sort(sort) : items; }
  function recordError(e, where) {
    lastError = `${where}: ${e && e.message || e}`;
    lastErrorAt = new Date().toISOString();
    log(`[${kind}] ${lastError}`);
  }
  async function currentFingerprint() {
    if (!fingerprintSource) return null;
    try { return await fingerprintSource(); } catch (e) { recordError(e, 'fingerprintSource'); return null; }
  }

  // ── 排隊 ──
  function enqueue(op) {
    return new Promise(resolve => { op.resolve = resolve; pending.push(op); kick(); });
  }
  function kick() {
    if (working) return;
    working = true;
    setImmediate(() => drain().catch(e => recordError(e, 'drain')).finally(() => {
      working = false;
      if (pending.length) kick();
    }));
  }
  async function drain() {
    while (pending.length) {
      if (pending[0].type === 'rebuild') {
        const op = pending.shift();
        if (op === queuedRebuild) queuedRebuild = null;
        op.resolve(await runRebuild(op.reason));
        continue;
      }
      // 合併連續的 upsert/remove 成一批、寫一次
      const batch = [];
      while (pending.length && pending[0].type !== 'rebuild') batch.push(pending.shift());
      const result = await applyBatch(batch);
      for (const op of batch) op.resolve(result);
    }
  }
  async function applyBatch(batch) {
    try {
      const { main, arch, ok } = await loadAll();
      if (!ok) {
        // 不寫出殘缺目錄：業務檔已先寫好，重建會從實際檔案掃到這幾筆。
        requestRebuild('index-missing-on-write');
        return { ok: false, deferred: true };
      }
      const live = new Map(main.data.items.map(e => [String(idOf(e)), e]));
      const old = new Map(arch.data ? arch.data.items.map(e => [String(idOf(e)), e]) : []);
      for (const op of batch) {
        if (op.type === 'upsert') {
          const id = String(idOf(op.entry));
          live.delete(id); old.delete(id);
          (archivePath && isArchived(op.entry) ? old : live).set(id, op.entry);
        } else if (op.type === 'remove') {
          live.delete(String(op.id)); old.delete(String(op.id));
        }
      }
      const fingerprint = await currentFingerprint();
      const meta = { rebuiltAt: main.data.rebuiltAt, fingerprint };
      // 先寫歸檔、再寫主目錄：中途中斷頂多「兩邊都有」，不會「兩邊都沒有」。
      if (archivePath) await save(archivePath, sorted(Array.from(old.values())), { rebuiltAt: arch.data.rebuiltAt, fingerprint });
      await save(indexPath, sorted(Array.from(live.values())), meta);
      return { ok: true };
    } catch (e) {
      recordError(e, 'write');
      cache.clear();
      return { ok: false, error: e.message };
    }
  }

  // ── 重建 ──
  function requestRebuild(reason) {
    if (queuedRebuild) return queuedRebuild.promise;
    const op = { type: 'rebuild', reason };
    op.promise = new Promise(resolve => { op.resolve = resolve; });
    queuedRebuild = op;
    pending.push(op);
    kick();
    return op.promise;
  }
  // 讀到缺檔／壞檔時用：已在重建中就不再多排一次（否則重建期間每次列清單都會再排一輪）。
  function rebuildSoon(reason) { if (!rebuilding) requestRebuild(reason); }
  async function runRebuild(reason) {
    if (!scanSource) return { ok: false, error: 'no scanSource' };
    rebuilding = true;
    const t0 = Date.now();
    try {
      const scanned = await scanSource();
      const live = [], old = [], seen = new Set();
      for (let i = 0; i < scanned.length; i++) {
        if (i && i % YIELD_EVERY === 0) await yieldNow();
        const e = scanned[i];
        const id = e && idOf(e);
        if (id == null || seen.has(String(id))) continue;
        seen.add(String(id));
        (archivePath && isArchived(e) ? old : live).push(e);
      }
      const fingerprint = await currentFingerprint();
      const rebuiltAt = new Date().toISOString();
      if (archivePath) await save(archivePath, sorted(old), { rebuiltAt, fingerprint });
      await save(indexPath, sorted(live), { rebuiltAt, fingerprint });
      cleanupStaleTmp(indexPath).catch(() => {});
      if (archivePath) cleanupStaleTmp(archivePath).catch(() => {});
      lastError = null;
      console.log(`[ListIndex] [${kind}] rebuilt (${reason || 'manual'}): ${live.length} 筆${archivePath ? `＋歸檔 ${old.length} 筆` : ''}，${Date.now() - t0} ms — ${indexPath}`);
      return { ok: true, count: live.length, archivedCount: old.length, ms: Date.now() - t0 };
    } catch (e) {
      recordError(e, 'rebuild');
      cache.clear();
      return { ok: false, error: e.message };
    } finally {
      rebuilding = false;
    }
  }

  // ── 對外介面 ──
  async function list({ includeArchived = false } = {}) {
    const main = await load(indexPath);
    if (!main.ok) { rebuildSoon('list-' + main.reason); return { items: [], fallback: true }; }
    if (!includeArchived || !archivePath) return { items: main.data.items, fallback: false };
    const arch = await load(archivePath);
    if (!arch.ok) { rebuildSoon('list-archive-' + arch.reason); return { items: [], fallback: true }; }
    return { items: sorted(main.data.items.concat(arch.data.items)), fallback: false };
  }
  async function listArchived() {
    if (!archivePath) return { items: [], fallback: false };
    const arch = await load(archivePath);
    if (!arch.ok) { rebuildSoon('list-archive-' + arch.reason); return { items: [], fallback: true }; }
    return { items: arch.data.items, fallback: false };
  }
  async function get(id) {
    const want = String(id);
    for (const f of archivePath ? [indexPath, archivePath] : [indexPath]) {
      const r = await load(f);
      if (!r.ok) continue;
      const hit = r.data.items.find(e => String(idOf(e)) === want);
      if (hit) return hit;
    }
    return null;
  }
  function upsert(entry) {
    if (!entry || idOf(entry) == null) return Promise.resolve({ ok: false, error: 'entry 缺 id' });
    return enqueue({ type: 'upsert', entry });
  }
  function remove(id) {
    if (id == null) return Promise.resolve({ ok: false, error: 'id 為空' });
    return enqueue({ type: 'remove', id });
  }
  function rebuild({ reason } = {}) { return requestRebuild(reason || 'manual'); }
  // 核對：目錄缺／壞，或指紋對不上 → 排一次重建。回傳 { ok, rebuilt, reason? }
  async function verify() {
    try {
      const { main, arch, ok } = await loadAll();
      if (!ok) { const why = !main.ok ? main.reason : 'archive-' + arch.reason; await requestRebuild('verify-' + why); return { ok: true, rebuilt: true, reason: why }; }
      if (fingerprintSource) {
        const fp = await currentFingerprint();
        if (fp != null && fp !== main.data.fingerprint) { await requestRebuild('verify-fingerprint'); return { ok: true, rebuilt: true, reason: 'fingerprint' }; }
      }
      return { ok: true, rebuilt: false };
    } catch (e) { recordError(e, 'verify'); return { ok: false, error: e.message }; }
  }
  async function status() {
    const main = await load(indexPath);
    const arch = archivePath ? await load(archivePath) : null;
    return {
      kind, workspace, indexPath, archivePath,
      valid: main.ok && (!arch || arch.ok),
      count: main.ok ? main.data.items.length : null,
      archivedCount: arch && arch.ok ? arch.data.items.length : (archivePath ? null : 0),
      updatedAt: main.ok ? main.data.updatedAt : null,
      rebuiltAt: main.ok ? main.data.rebuiltAt : null,
      rebuilding: rebuilding || !!queuedRebuild,
      pendingWrites: pending.filter(o => o.type !== 'rebuild').length,
      lastError, lastErrorAt,
    };
  }
  // 測試用：等排隊清空
  async function idle() { while (working || pending.length) await sleep(5); }

  return { kind, indexPath, archivePath, list, listArchived, get, upsert, remove, rebuild, verify, status, _idle: idle };
}

// ── 功能登錄（之後的子項各自登錄自己的 kind） ─────────────────────────────────
// factory(workspaceRoot) → open(...) 的結果（或 null＝這個工作區沒有這份目錄）。
const kinds = new Map();          // kind → factory
const handleCache = new Map();    // kind + '|' + 正規化工作區 → handle
function registerIndexKind(kind, factory) {
  if (!kind || typeof factory !== 'function') throw new TypeError('registerIndexKind(kind, factory)');
  kinds.set(kind, factory);
  for (const k of Array.from(handleCache.keys())) if (k.startsWith(kind + '|')) handleCache.delete(k);
}
function listKinds() { return Array.from(kinds.keys()); }
function getIndex(kind, workspaceRoot) {
  const factory = kinds.get(kind);
  if (!factory) return null;
  const k = kind + '|' + normalizeWorkspace(workspaceRoot);
  if (!handleCache.has(k)) handleCache.set(k, factory(path.resolve(workspaceRoot)) || null);
  return handleCache.get(k);
}
// 手動重建：kind 不給＝該工作區全部。立即回傳要重建的清單（不等重建完成）。
function rebuildWorkspace(workspaceRoot, kind) {
  const targets = kind ? [kind] : listKinds();
  const accepted = [], unknown = [];
  for (const k of targets) {
    const h = kinds.has(k) ? getIndex(k, workspaceRoot) : null;
    if (!h) { unknown.push(k); continue; }
    h.rebuild({ reason: 'api' }).catch(() => {});
    accepted.push(k);
  }
  return { accepted, unknown };
}
async function statusWorkspace(workspaceRoot) {
  const out = [];
  for (const k of listKinds()) {
    const h = getIndex(k, workspaceRoot);
    if (!h) continue;
    try { out.push(await h.status()); } catch (e) { out.push({ kind: k, error: e.message }); }
  }
  return out;
}
// 開機核對：逐工作區、逐功能依序 verify（依序跑，避免開機時同時重建多份搶資源）。永不丟出。
async function verifyAllOnBoot(workspaces) {
  const seen = new Set(), results = [];
  for (const ws of workspaces || []) {
    if (!ws) continue;
    let key;
    try { key = normalizeWorkspace(ws); } catch (_) { continue; }
    if (seen.has(key)) continue;
    seen.add(key);
    for (const k of listKinds()) {
      try {
        const h = getIndex(k, ws);
        if (!h) continue;
        results.push(Object.assign({ kind: k, workspace: ws }, await h.verify()));
      } catch (e) { log(`verifyAllOnBoot ${k} @ ${ws}: ${e.message}`); results.push({ kind: k, workspace: ws, ok: false, error: e.message }); }
    }
  }
  return results;
}

module.exports = {
  SCHEMA,
  open, normalizeWorkspace, indexDirFor, sharedIndexDirFor, idSetFingerprint, eachYield,
  registerIndexKind, listKinds, getIndex, rebuildWorkspace, statusWorkspace, verifyAllOnBoot,
  writeAtomic,
  _io: io,
  _reset() { instances.clear(); kinds.clear(); handleCache.clear(); },
};

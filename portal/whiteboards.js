'use strict';
// Whiteboard persistence — SPEC-whiteboard.md §5. Unlike notes.js/pm.js (one global file under
// HARNESS_HOME, workspace-tagged), whiteboards are a genuinely PER-WORKSPACE directory tree
// (天條: only ever written under <workspace>/.harness/whiteboards/) — Charles's boards for one
// client project must never leak into another workspace's list.
const fs   = require('fs');
const path = require('path');
const listIndex = require('./list-index'); // IDX-WB: SPEC-list-index.md 9.12 — 目錄讀寫一律經共用模組

function whiteboardsDir(root) {
  return path.join(root, '.harness', 'whiteboards');
}

function indexPath(root) {
  return path.join(whiteboardsDir(root), 'index.json');
}

function boardDir(root, id) {
  return path.join(whiteboardsDir(root), id);
}

function boardPath(root, id) {
  return path.join(boardDir(root, id), 'board.json');
}

// 同步讀（只給「頭像對話脈絡」這種不方便 await 的地方）。相容兩種檔案格式：
// 舊版純陣列、IDX-WB 之後的 { schema, items } 物件。清單 API 請改用 listBoards()。
function readIndex(root) {
  const p = indexPath(root);
  try {
    if (!fs.existsSync(p)) return [];
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Array.isArray(data)) return data;
    return data && Array.isArray(data.items) ? data.items : [];
  } catch (e) { return []; }
}

function readBoard(root, id) {
  const p = boardPath(root, id);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function writeBoard(root, id, board) {
  const dir = boardDir(root, id);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  fs.writeFileSync(boardPath(root, id), JSON.stringify(board, null, 2));
}

// 刪掉整張白板（資料夾），再從目錄移除。目錄更新失敗不影響刪除本身（下次核對會補）。
async function deleteBoard(root, id) {
  const dir = boardDir(root, id);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  const idx = getIdx(root);
  if (idx) await idx.remove(id);
}

// ── 清單目錄（IDX-WB）────────────────────────────────────────────────────────
// 位置仍是 <ws>/.harness/whiteboards/index.json，內容改為共用模組格式 { schema, kind, items:[…] }；
// 舊版純陣列檔會被視為「壞檔」→ 清單先走保底掃描、同時背景重建一次（createdAt 沿用舊檔）。
const isBoardDirName = n => /^wb_/.test(n);

function byCreated(a, b) {
  return String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id));
}

async function boardDirNames(root) {
  try {
    return (await fs.promises.readdir(whiteboardsDir(root), { withFileTypes: true }))
      .filter(d => d.isDirectory() && isBoardDirName(d.name)).map(d => d.name);
  } catch (_) { return []; }
}

// 從實際檔案（每張白板的 board.json）掃出清單欄位；非同步、每 50 筆讓出。
async function scanBoards(root) {
  const names = await boardDirNames(root);
  const created = new Map();
  for (const e of readIndex(root)) if (e && e.id && e.createdAt) created.set(e.id, e.createdAt);
  const out = await listIndex.eachYield(names, async (id) => {
    let b;
    try { b = JSON.parse(await fs.promises.readFile(boardPath(root, id), 'utf8')); } catch (_) { return undefined; }
    if (!b) return undefined;
    let createdAt = created.get(id);
    if (!createdAt) { const m = /^wb_(\d{13})_/.exec(id); if (m) createdAt = new Date(Number(m[1])).toISOString(); } // id 內含建立時間
    if (!createdAt) { try { createdAt = (await fs.promises.stat(boardPath(root, id))).birthtime.toISOString(); } catch (_) {} }
    return { id, title: b.title || '', createdAt: createdAt || b.updatedAt || null, updatedAt: b.updatedAt || createdAt || null };
  });
  return out.filter(Boolean).sort(byCreated);
}

function getIdx(root) {
  if (!root) return null;
  return listIndex.open({
    kind: 'whiteboards',
    indexPath: indexPath(root),
    workspace: root,
    scanSource: () => scanBoards(root),
    fingerprintSource: async () => listIndex.idSetFingerprint(await boardDirNames(root)),
    sort: byCreated,
  });
}

// 清單：先讀目錄；目錄缺／壞就直接掃白板資料夾（保底，模組已排重建），回 { items, fallback }。
async function listBoards(root) {
  const idx = getIdx(root);
  const r = await idx.list();
  if (!r.fallback) return r;
  if (!fs.existsSync(whiteboardsDir(root))) return { items: [], fallback: true };
  return { items: await scanBoards(root), fallback: true };
}

// 新增／更新一筆目錄（board.json 要先寫成功再呼叫）。永不丟出。
async function upsertMeta(root, meta) {
  const idx = getIdx(root);
  if (!idx) return { ok: false };
  const old = await idx.get(meta.id).catch(() => null);
  return idx.upsert(Object.assign({}, old || {}, meta, { createdAt: (old && old.createdAt) || meta.createdAt || meta.updatedAt || null }));
}

// 登錄成目錄的一種 kind：開機核對、POST /api/index/rebuild、GET /api/index/status 才管得到白板。
function registerIndexKind() {
  listIndex.registerIndexKind('whiteboards', (wsRoot) => (fs.existsSync(whiteboardsDir(wsRoot)) ? getIdx(wsRoot) : null));
}

function genWhiteboardId() { return 'wb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

module.exports = {
  whiteboardsDir, indexPath, boardDir, boardPath,
  readIndex, listBoards, upsertMeta, scanBoards, registerIndexKind,
  readBoard, writeBoard, deleteBoard, genWhiteboardId
};

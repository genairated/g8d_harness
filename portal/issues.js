'use strict';
// 回報給 Hana — 問題單持久化（SPEC-issue-report.md §5.2／§5.4）。
// 存放 HARNESS_HOME/.harness/issues/<id>/{issue.json, replay.json.gz, timeline.md, files/}，
// 所有工作區共用一份、每筆標 workspace（D2）。整個 .harness/ 已被 .gitignore，不會進版控。
// 流水號用「非遞迴 mkdir」搶號：同名資料夾已存在就 EEXIST → 換下一號，跨行程也安全。
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const { buildTimeline } = require('./issue-timeline');
const listIndex = require('./list-index');   // SPEC-list-index.md §9.7（IDX-ISS）：清單目錄檔

const fsp = fs.promises;

const MAX_BODY_BYTES = 30 * 1024 * 1024;   // §5.4：單筆上限 30MB
const TYPES = ['bug', 'feature'];
const DEFAULT_BUFFER_MINUTES = 3;          // D5

function issuesDir(harnessHome) { return path.join(harnessHome, '.harness', 'issues'); }
function configPath(harnessHome) { return path.join(harnessHome, 'global-knowledge', 'issue-report-config.json'); }

// D5：保留分鐘數讀設定（global-knowledge/issue-report-config.json 的 bufferMinutes），預設 3，限 1～10。
function readConfig(harnessHome) {
  let n = DEFAULT_BUFFER_MINUTES;
  try {
    const j = JSON.parse(fs.readFileSync(configPath(harnessHome), 'utf8'));
    const v = Number(j && j.bufferMinutes);
    if (isFinite(v) && v >= 1 && v <= 10) n = Math.round(v);
  } catch (e) {}
  return { bufferMinutes: n };
}

function clipStr(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) : s; }
function arr(a, max) { return Array.isArray(a) ? a.slice(-max) : []; }

// ── 下一個編號：HARNESS_HOME/.harness/issues/next-id（不存在或壞掉時從 readdir 算一次）──
function nextIdPath(harnessHome) { return path.join(issuesDir(harnessHome), 'next-id'); }
function scanMaxId(root) {
  let max = 0;
  for (const n of fs.readdirSync(root)) { const v = /^\d+$/.test(n) ? parseInt(n, 10) : 0; if (v > max) max = v; }
  return max;
}
function readNextId(harnessHome, root) {
  try {
    const v = parseInt(String(fs.readFileSync(nextIdPath(harnessHome), 'utf8')).trim(), 10);
    if (isFinite(v) && v >= 1) return v;
  } catch (e) {}
  return scanMaxId(root) + 1;
}
function writeNextId(harnessHome, n) {
  try { fs.writeFileSync(nextIdPath(harnessHome), String(n), 'utf8'); } catch (e) {}   // 失敗無妨：下次 EEXIST 會往後找、或重算
}

// 搶下一個流水號並建好資料夾。回傳 { id, dir }。仍用「非遞迴 mkdir」搶號，next-id 只是起點（跨行程安全不變）。
function allocate(harnessHome) {
  const root = issuesDir(harnessHome);
  fs.mkdirSync(root, { recursive: true });
  for (let round = 0; round < 2; round++) {
    const start = round === 0 ? readNextId(harnessHome, root) : scanMaxId(root) + 1;   // 第二輪：next-id 落後太多，改用實際資料夾重算
    for (let id = start; id < start + 1000; id++) {
      const dir = path.join(root, String(id));
      try { fs.mkdirSync(dir); writeNextId(harnessHome, id + 1); return { id, dir }; }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
  }
  throw new Error('cannot allocate issue id');
}

function saveImages(dir, images) {
  const saved = [];
  const list = Array.isArray(images) ? images.slice(0, 10) : [];
  if (!list.length) return saved;
  const fdir = path.join(dir, 'files');
  fs.mkdirSync(fdir, { recursive: true });
  list.forEach((im, i) => {
    const m = /^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/s.exec(String(im && im.dataUrl || ''));
    if (!m) return;
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const name = (im.kind === 'pick' ? 'pick-' : 'paste-') + (i + 1) + '.' + ext;
    fs.writeFileSync(path.join(fdir, name), Buffer.from(m[2], 'base64'));
    saved.push(name);
  });
  return saved;
}

// payload: 前端送件內容；ctx: { workspace }（伺服器端判定，不信前端）
function createIssue(harnessHome, payload, ctx) {
  const p = payload || {};
  const description = String(p.description || '').trim();
  if (!description) { const e = new Error('description required'); e.status = 400; throw e; }
  const type = TYPES.includes(p.type) ? p.type : 'bug';
  const { id, dir } = allocate(harnessHome);
  try {
    const now = new Date().toISOString();
    const events = Array.isArray(p.events) ? p.events : [];
    const title = clipStr(String(p.title || description).replace(/\s+/g, ' ').trim(), 60);
    const issue = {
      id, type, title, description: clipStr(description, 4000),
      status: '待處理',
      createdAt: now,
      workspace: (ctx && ctx.workspace) || null,
      route: clipStr(p.route, 300),
      view: clipStr(p.view, 100),
      chatContext: p.chatContext && typeof p.chatContext === 'object' ? p.chatContext : null,
      version: clipStr(p.version, 60),
      env: p.env && typeof p.env === 'object' ? p.env : null,
      pick: p.pick && typeof p.pick === 'object' ? p.pick : null,
      errors: arr(p.errors, 50),
      requests: arr(p.requests, 30),
      replay: { events: events.length, bufferMinutes: Number(p.bufferMinutes) || null, fromPageLoad: !!p.fromPageLoad },
      files: [],
      linkedSessions: [],
      resolution: null,
      history: [{ at: now, by: 'commander', from: null, to: '待處理', note: '建立' }],
      links: { task: null, schedule: null },
    };
    issue.files = saveImages(dir, p.images);
    fs.writeFileSync(path.join(dir, 'replay.json.gz'), zlib.gzipSync(Buffer.from(JSON.stringify(events), 'utf8')));
    let tl;
    try { tl = buildTimeline(events, Object.assign({}, issue, { submittedAt: now })); }
    catch (e) { tl = '# 問題單 #' + id + ' 時間軸\n\n（時間軸產生失敗：' + e.message + '；原始紀錄見 replay.json.gz）\n'; }
    fs.writeFileSync(path.join(dir, 'timeline.md'), tl, 'utf8');
    fs.writeFileSync(path.join(dir, 'issue.json'), JSON.stringify(issue, null, 2), 'utf8');
    syncIndex(harnessHome, issue);   // 業務檔先寫成功，再更新目錄（不 await、不丟出）
    return issue;
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e2) {}   // 失敗不留半成品
    throw e;
  }
}

function readIssue(harnessHome, id) {
  if (!/^\d+$/.test(String(id))) return null;
  try { return JSON.parse(fs.readFileSync(path.join(issuesDir(harnessHome), String(id), 'issue.json'), 'utf8')); }
  catch (e) { return null; }
}

// ── 清單目錄（IDX-ISS）──
// 問題單是 D2 的刻意例外：所有工作區共用一份、前端清單本來就顯示全部（每筆自帶 workspace 欄位）。
// 所以目錄只有「一份」，放在 harness home 名下：HARNESS_HOME/.harness/issues/index/<雜湊>/issues.json；
// 已結案、不處理進 issues.archive.json。issue.json 才是真相，目錄只是快取。
const ARCHIVED_STATUSES = ['已結案', '不處理'];
const ALL_STATUSES = ['待處理', '處理中', '已修正待驗證', '已結案', '不處理'];

// 清單 API 以前 map 出來的那些欄位（前端 portal/views/issues.js 只用這些）。
function entryOf(i) {
  return { id: i.id, type: i.type, title: i.title, status: i.status, workspace: i.workspace, route: i.route, view: i.view, version: i.version, createdAt: i.createdAt };
}
const byIdDesc = (a, b) => b.id - a.id;

async function scanAll(harnessHome) {
  let names = [];
  try { names = (await fsp.readdir(issuesDir(harnessHome))).filter(n => /^\d+$/.test(n)); } catch (e) { return []; }
  return listIndex.eachYield(names, async (n) => {
    try { return entryOf(JSON.parse(await fsp.readFile(path.join(issuesDir(harnessHome), n, 'issue.json'), 'utf8'))); }
    catch (e) { return undefined; }   // 壞檔／半成品資料夾略過（與舊的 readIssue 回 null 一致）
  });
}
async function fingerprintIds(harnessHome) {
  let names = [];
  try { names = (await fsp.readdir(issuesDir(harnessHome))).filter(n => /^\d+$/.test(n)); } catch (e) {}
  return listIndex.idSetFingerprint(names);
}

// 伺服器啟動時呼叫一次。其他工作區的路徑回 null（問題單只有 harness home 這一份目錄）。
function registerIndex(harnessHome) {
  const homeKey = listIndex.normalizeWorkspace(harnessHome);
  listIndex.registerIndexKind('issues', (wsRoot) => {
    if (listIndex.normalizeWorkspace(wsRoot) !== homeKey) return null;
    const dir = listIndex.sharedIndexDirFor(issuesDir(harnessHome), harnessHome);
    return listIndex.open({
      kind: 'issues',
      indexPath: path.join(dir, 'issues.json'),
      archivePath: path.join(dir, 'issues.archive.json'),
      workspace: harnessHome,
      sort: byIdDesc,
      isArchived: (e) => ARCHIVED_STATUSES.includes(e.status),
      scanSource: () => scanAll(harnessHome),
      fingerprintSource: () => fingerprintIds(harnessHome),
    });
  });
}
function handleFor(harnessHome) {
  try { return listIndex.getIndex('issues', harnessHome); } catch (e) { return null; }
}
// issue.json 已寫成功之後呼叫；永不丟出，目錄失敗＝下次核對／重建補回。
function syncIndex(harnessHome, issue) {
  try {
    const h = handleFor(harnessHome);
    if (h && issue) h.upsert(entryOf(issue)).catch(() => {});
  } catch (e) {}
}

// 清單用：一次請求只讀一次目錄（主＋歸檔），清單、待處理數、總數都從這份結果算。
// 回 { items（新到舊，欄位同舊 API）, open, total, fallback }。目錄不可用時走非同步逐檔保底，fallback:true。
// 歸檔也一併讀入：前端清單本來就含已結案／不處理（用狀態篩選器切換），不能讓畫面少東西。
async function listIndexed(harnessHome, filter) {
  const f = filter || {};
  let all = null, fallback = false;
  const h = handleFor(harnessHome);
  if (h) {
    try {
      const m = await h.list();
      if (!m.fallback) {
        const a = await h.listArchived();
        if (!a.fallback) { const seen = new Set(); all = m.items.concat(a.items).filter(i => !seen.has(i.id) && seen.add(i.id)).sort(byIdDesc); }   // 去重：正好遇到搬移（主→歸檔）的瞬間也不會重複
      }
    } catch (e) {}
  }
  if (!all) { fallback = true; all = (await scanAll(harnessHome)).sort(byIdDesc); }
  const open = all.filter(i => OPEN_STATUSES.includes(i.status)).length;
  const items = all.filter(i => (!f.status || i.status === f.status) && (!f.type || i.type === f.type));
  return { items, open, total: all.length, fallback };
}

function listIssues(harnessHome, filter) {
  const f = filter || {};
  const root = issuesDir(harnessHome);
  let names = [];
  try { names = fs.readdirSync(root).filter(n => /^\d+$/.test(n)); } catch (e) { return []; }
  const out = [];
  for (const n of names) {
    const it = readIssue(harnessHome, n);
    if (!it) continue;
    if (f.status && it.status !== f.status) continue;
    if (f.type && it.type !== f.type) continue;
    out.push(it);
  }
  return out.sort((a, b) => b.id - a.id);
}

function readTimeline(harnessHome, id) {
  if (!/^\d+$/.test(String(id))) return '';
  try { return fs.readFileSync(path.join(issuesDir(harnessHome), String(id), 'timeline.md'), 'utf8'); } catch (e) { return ''; }
}

// ── IR2：問題管理頁需要的讀取／綁定能力 ──
// 「未結案」＝尚需人處理或驗收的狀態（待處理、處理中、已修正待驗證）；已結案、不處理不算。
const OPEN_STATUSES = ['待處理', '處理中', '已修正待驗證'];
function countOpen(harnessHome) {
  return listIssues(harnessHome).filter(i => OPEN_STATUSES.includes(i.status)).length;
}

// 重播資料：原樣回傳 gzip 位元組，由路由加 Content-Encoding: gzip 讓瀏覽器自動解開。找不到回 null。
function readReplayGz(harnessHome, id) {
  if (!/^\d+$/.test(String(id))) return null;
  try { return fs.readFileSync(path.join(issuesDir(harnessHome), String(id), 'replay.json.gz')); } catch (e) { return null; }
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
// 貼圖／指認圖：檔名只准「英數、點、底線、連字號」且不含 ..，並再驗解析後路徑仍在該筆 files/ 之內（防路徑穿越）。
function resolveFile(harnessHome, id, name) {
  if (!/^\d+$/.test(String(id))) return null;
  const n = String(name || '');
  if (!/^[A-Za-z0-9._-]+$/.test(n) || n.indexOf('..') !== -1) return null;
  const ext = n.split('.').pop().toLowerCase();
  if (!MIME[ext]) return null;
  const fdir = path.resolve(issuesDir(harnessHome), String(id), 'files');
  const abs = path.resolve(fdir, n);
  if (path.dirname(abs) !== fdir) return null;
  try { if (!fs.statSync(abs).isFile()) return null; } catch (e) { return null; }
  return { abs, mime: MIME[ext] };
}

// 把一段頭像對話記進問題單的 linkedSessions[]（去重；重複只回傳原筆不新增）。回傳更新後的 linkedSessions，找不到單回 null。
function linkSession(harnessHome, id, sessionId, label) {
  const sid = String(sessionId || '').trim();
  if (!sid || sid.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(sid)) { const e = new Error('invalid sessionId'); e.status = 400; throw e; }
  const it = readIssue(harnessHome, id);
  if (!it) return null;
  if (!Array.isArray(it.linkedSessions)) it.linkedSessions = [];
  if (it.linkedSessions.some(s => s && s.sessionId === sid)) return it.linkedSessions;
  it.linkedSessions.push({ sessionId: sid, at: new Date().toISOString(), label: clipStr(label, 80) || null });
  writeIssueFile(harnessHome, id, it);
  syncIndex(harnessHome, it);
  return it.linkedSessions;
}

function writeIssueFile(harnessHome, id, it) {
  const file = path.join(issuesDir(harnessHome), String(id), 'issue.json');
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(it, null, 2), 'utf8');
  fs.renameSync(tmp, file);   // 先寫暫存再改名，讀的人不會讀到寫一半的檔
}

// 改狀態的唯一入口（目前沒有 UI／路由呼叫它；日後改狀態一律走這裡，才會同步目錄、並在已結案／不處理時搬進歸檔）。
// 回更新後的問題單；找不到回 null；狀態不合法丟 400。
function updateIssueStatus(harnessHome, id, status, by, note) {
  if (!ALL_STATUSES.includes(status)) { const e = new Error('invalid status'); e.status = 400; throw e; }
  const it = readIssue(harnessHome, id);
  if (!it) return null;
  if (!Array.isArray(it.history)) it.history = [];
  it.history.push({ at: new Date().toISOString(), by: clipStr(by, 40) || 'commander', from: it.status, to: status, note: clipStr(note, 500) || null });
  it.status = status;
  writeIssueFile(harnessHome, id, it);
  syncIndex(harnessHome, it);
  return it;
}

module.exports = { MAX_BODY_BYTES, DEFAULT_BUFFER_MINUTES, OPEN_STATUSES, ALL_STATUSES, issuesDir, readConfig, createIssue, readIssue, listIssues, listIndexed, registerIndex, updateIssueStatus, readTimeline, countOpen, readReplayGz, resolveFile, linkSession };

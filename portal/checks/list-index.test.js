// IDX-0：portal/list-index.js 單元測試（純 node、暫存目錄，不起 server）。
// 跑法：node portal/checks/list-index.test.js
const fs = require('fs'), path = require('path'), assert = require('assert');
const LI = require('../list-index');

// 暫存目錄放在本工作區 _tmp/ 底下（產出留在所屬工作區），測完刪掉。
const ROOT = path.join(__dirname, '..', '..', '_tmp', 'list-index-test-' + process.pid);
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

let passed = 0, failed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const origIo = Object.assign({}, LI._io);
const restoreIo = () => Object.assign(LI._io, origIo);

// 模擬一個功能：實際檔案＝ src/<id>.json，目錄欄位只取 id/title/archived/at
function makeFeature(name, extra = {}) {
  const dir = path.join(ROOT, name);
  const src = path.join(dir, 'src');
  fs.mkdirSync(src, { recursive: true });
  const write = e => fs.writeFileSync(path.join(src, e.id + '.json'), JSON.stringify(Object.assign({ body: 'x'.repeat(200) }, e)));
  const del = id => fs.unlinkSync(path.join(src, id + '.json'));
  const toEntry = d => ({ id: d.id, title: d.title, archived: !!d.archived, at: d.at || 0 });
  const opts = Object.assign({
    kind: 'demo',
    indexPath: path.join(dir, 'idx', 'demo.json'),
    archivePath: path.join(dir, 'idx', 'demo.archive.json'),
    workspace: dir,
    scanSource: async () => {
      const names = (await fs.promises.readdir(src)).filter(n => n.endsWith('.json'));
      return LI.eachYield(names, async n => toEntry(JSON.parse(await fs.promises.readFile(path.join(src, n), 'utf8'))));
    },
    fingerprintSource: async () => LI.idSetFingerprint((await fs.promises.readdir(src)).filter(n => n.endsWith('.json')).map(n => n.slice(0, -5))),
    isArchived: e => !!e.archived,
    sort: (a, b) => (b.at - a.at) || String(a.id).localeCompare(String(b.id)),
  }, extra);
  return { dir, src, write, del, toEntry, opts, idx: LI.open(opts) };
}
const ids = items => items.map(e => e.id).sort();

test('路徑與工作區正規化', () => {
  assert.strictEqual(LI.normalizeWorkspace('D:/SideProject/G8D_Harness/'), path.resolve('D:/SideProject/G8D_Harness').toLowerCase());
  assert.strictEqual(LI.normalizeWorkspace('D:\\\\SideProject\\\\g8d_harness'), LI.normalizeWorkspace('d:/sideproject/g8d_harness'));
  assert.strictEqual(LI.normalizeWorkspace(null, 'D:/Home'), path.resolve('D:/Home').toLowerCase());
  assert.throws(() => LI.normalizeWorkspace(null));
  assert.strictEqual(LI.indexDirFor('D:/ws'), path.join(path.resolve('D:/ws'), '.harness', 'index'));
  const a = LI.sharedIndexDirFor('D:/h/schedules', 'D:\\Projects\\客戶專案'), b = LI.sharedIndexDirFor('D:/h/schedules', 'd:/projects/客戶專案/');
  assert.strictEqual(a, b, '同一工作區不同寫法→同一資料夾');
  assert.match(path.basename(a), /^[0-9a-f]{12}$/);
  assert.notStrictEqual(a, LI.sharedIndexDirFor('D:/h/schedules', 'D:/other'));
});

test('新增／更新／刪除＋目錄格式', async () => {
  const f = makeFeature('crud');
  f.write({ id: 'a', title: 'A', at: 1 }); f.write({ id: 'b', title: 'B', at: 2 });
  await f.idx.rebuild({ reason: 'test' });
  f.write({ id: 'c', title: 'C', at: 3 }); assert.deepStrictEqual(await f.idx.upsert({ id: 'c', title: 'C', archived: false, at: 3 }), { ok: true });
  await f.idx.upsert({ id: 'a', title: 'A2', archived: false, at: 1 });
  f.del('b'); await f.idx.remove('b');
  const r = await f.idx.list();
  assert.strictEqual(r.fallback, false);
  assert.deepStrictEqual(r.items.map(e => e.id), ['c', 'a'], '依 sort 排序');
  assert.strictEqual((await f.idx.get('a')).title, 'A2');
  assert.strictEqual(await f.idx.get('b'), null);
  const disk = JSON.parse(fs.readFileSync(f.opts.indexPath, 'utf8'));
  assert.strictEqual(disk.schema, 'harness.list-index/1');
  assert.strictEqual(disk.kind, 'demo');
  assert.strictEqual(disk.count, 2);
  assert.strictEqual(disk.workspaceKey, LI.normalizeWorkspace(f.dir));
  assert(disk.updatedAt && disk.rebuiltAt && disk.fingerprint);
  assert(!('body' in disk.items[0]), '目錄不放大欄位（由 scan/upsert 決定）');
  assert(fs.existsSync(path.join(path.dirname(f.opts.indexPath), '.gitignore')), '目錄資料夾自帶忽略全部的 .gitignore');
  const st = await f.idx.status();
  assert.strictEqual(st.count, 2); assert.strictEqual(st.archivedCount, 0); assert.strictEqual(st.rebuilding, false); assert.strictEqual(st.valid, true);
});

test('歸檔移轉（兩個方向）', async () => {
  const f = makeFeature('archive');
  f.write({ id: 'x', title: 'X' }); f.write({ id: 'y', title: 'Y', archived: true });
  await f.idx.rebuild();
  assert.deepStrictEqual(ids((await f.idx.list()).items), ['x']);
  assert.deepStrictEqual(ids((await f.idx.listArchived()).items), ['y']);
  await f.idx.upsert({ id: 'x', title: 'X', archived: true });
  assert.deepStrictEqual(ids((await f.idx.list()).items), []);
  assert.deepStrictEqual(ids((await f.idx.listArchived()).items), ['x', 'y']);
  await f.idx.upsert({ id: 'y', title: 'Y', archived: false });
  assert.deepStrictEqual(ids((await f.idx.list()).items), ['y']);
  assert.deepStrictEqual(ids((await f.idx.list({ includeArchived: true })).items), ['x', 'y']);
  assert.strictEqual((await f.idx.get('x')).archived, true, 'get 也找得到歸檔項');
});

test('壞檔／缺檔保底：回 fallback 並自動排重建', async () => {
  const f = makeFeature('corrupt');
  f.write({ id: 'p', title: 'P' }); f.write({ id: 'q', title: 'Q' });
  let r = await f.idx.list();
  assert.deepStrictEqual(r, { items: [], fallback: true }, '缺檔→fallback');
  await f.idx._idle();
  r = await f.idx.list();
  assert.strictEqual(r.fallback, false); assert.deepStrictEqual(ids(r.items), ['p', 'q'], '自動重建後正常');
  fs.writeFileSync(f.opts.indexPath, '');   // 0 位元組（客戶專案真實出現過）
  r = await f.idx.list();
  assert.strictEqual(r.fallback, true, '壞檔→fallback');
  await f.idx._idle();
  assert.deepStrictEqual(ids((await f.idx.list()).items), ['p', 'q']);
  fs.writeFileSync(f.opts.indexPath, '{"items":');
  assert.strictEqual((await f.idx.list()).fallback, true, '半截 JSON→fallback');
  await f.idx._idle();
  assert.strictEqual((await f.idx.list()).fallback, false);
});

test('目錄缺檔時寫入不產生殘缺目錄（延後到重建）', async () => {
  const f = makeFeature('missing-write');
  f.write({ id: 'm1', title: 'M1' }); f.write({ id: 'm2', title: 'M2' });
  const r = await f.idx.upsert({ id: 'm2', title: 'M2', archived: false });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.deferred, true);
  await f.idx._idle();
  assert.deepStrictEqual(ids((await f.idx.list()).items), ['m1', 'm2'], '重建後兩筆都在，而不是只有 m2');
});

test('殘留暫存檔不影響讀', async () => {
  const f = makeFeature('tmp');
  f.write({ id: 't1', title: 'T1' });
  await f.idx.rebuild();
  fs.writeFileSync(f.opts.indexPath + '.tmp-999-deadbeef', '{"items":[{"id":"幽靈"');   // 模擬寫到一半被中斷
  fs.writeFileSync(f.opts.indexPath + '.tmp-998-cafebabe', JSON.stringify({ items: [{ id: 'ghost' }] }));
  assert.deepStrictEqual(ids((await f.idx.list()).items), ['t1']);
  await f.idx.upsert({ id: 't2', title: 'T2', archived: false });
  assert.deepStrictEqual(ids((await f.idx.list()).items), ['t1', 't2']);
});

test('同時 50 筆 upsert 不遺失（且合併成少數幾次寫入）', async () => {
  const f = makeFeature('concurrent');
  await f.idx.rebuild();
  let renames = 0;
  LI._io.rename = (a, b) => { renames++; return origIo.rename(a, b); };
  try {
    const all = [];
    for (let i = 0; i < 50; i++) { const e = { id: 'n' + String(i).padStart(2, '0'), title: 'N' + i, at: i }; f.write(e); all.push(f.idx.upsert(Object.assign({ archived: i % 5 === 0 }, e))); }
    const results = await Promise.all(all);
    assert(results.every(r => r.ok), '每筆都回 ok');
  } finally { restoreIo(); }
  const live = (await f.idx.list()).items, arch = (await f.idx.listArchived()).items;
  assert.strictEqual(live.length + arch.length, 50, '50 筆全在');
  assert.strictEqual(arch.length, 10);
  assert(renames < 50 * 2, `同時寫入合併（rename ${renames} 次 < 100）`);
});

test('重建結果＝逐筆寫入的結果', async () => {
  const f = makeFeature('rebuild-eq');
  await f.idx.rebuild();
  for (let i = 0; i < 120; i++) {
    const e = { id: 'r' + i, title: 'R' + i, at: i % 7, archived: i % 4 === 0 };
    f.write(e); await f.idx.upsert(f.toEntry(e));
  }
  for (let i = 0; i < 120; i += 9) { f.del('r' + i); await f.idx.remove('r' + i); }
  const incLive = (await f.idx.list()).items, incArch = (await f.idx.listArchived()).items;
  const rr = await f.idx.rebuild({ reason: 'compare' });
  assert.strictEqual(rr.ok, true);
  assert.deepStrictEqual((await f.idx.list()).items, incLive);
  assert.deepStrictEqual((await f.idx.listArchived()).items, incArch);
});

test('重建期間的寫入排隊、重建完再套用；同時只跑一個重建', async () => {
  let scans = 0, release;
  const gate = new Promise(r => { release = r; });
  const f = makeFeature('during-rebuild');
  f.write({ id: 'd1', title: 'D1' });
  const realScan = f.opts.scanSource;
  const f2 = makeFeature('during-rebuild2', { scanSource: async () => { scans++; await gate; return realScan(); } });
  // f2 掃的是 f 的 src（共用 realScan）
  const p1 = f2.idx.rebuild(), p2 = f2.idx.rebuild();
  assert.strictEqual(p1, p2, '尚未開始的重建要求共用同一個');
  await sleep(20);
  assert.strictEqual((await f2.idx.status()).rebuilding, true);
  f.write({ id: 'd2', title: 'D2' });
  const w = f2.idx.upsert({ id: 'd2', title: 'D2-new', archived: false });
  await sleep(20);
  assert.strictEqual(scans, 1);
  release();
  assert.strictEqual((await w).ok, true);
  const items = (await f2.idx.list()).items;
  assert.deepStrictEqual(ids(items), ['d1', 'd2']);
  assert.strictEqual(items.find(e => e.id === 'd2').title, 'D2-new', '重建後再套用排隊中的寫入');
  assert.strictEqual((await f2.idx.status()).rebuilding, false);
});

test('重建每 50 筆讓出：重建中其他工作照常進行', async () => {
  const many = Array.from({ length: 400 }, (_, i) => ({ id: 'z' + i, title: 'Z', archived: false, at: 0 }));
  const f = makeFeature('yield', { scanSource: async () => many, fingerprintSource: null });
  let ticks = 0;
  const iv = setInterval(() => ticks++, 0);
  const t = setImmediate(() => ticks++);
  await f.idx.rebuild();
  clearInterval(iv);
  assert((await f.idx.list()).items.length === 400);
  assert(ticks > 0, '重建過程中事件迴圈有讓出');
  void t;
});

test('rename 被鎖：重試後成功', async () => {
  const f = makeFeature('lock-ok');
  f.write({ id: 'l1', title: 'L1' });
  await f.idx.rebuild();
  let fails = 3, calls = 0;
  LI._io.rename = (a, b) => { calls++; if (fails-- > 0) { const e = new Error('locked'); e.code = 'EPERM'; return Promise.reject(e); } return origIo.rename(a, b); };
  const t0 = Date.now();
  try { assert.deepStrictEqual(await f.idx.upsert({ id: 'l2', title: 'L2', archived: false }), { ok: true }); }
  finally { restoreIo(); }
  assert(calls >= 4, '至少重試 3 次'); assert(Date.now() - t0 >= 50 + 100 + 200 - 20, '間隔遞增 50→100→200');
  assert.deepStrictEqual(ids((await f.idx.list()).items), ['l1', 'l2']);
});

test('rename 一直被鎖：不丟出、記錯誤、保留暫存檔、舊目錄仍可讀', async () => {
  const f = makeFeature('lock-fail', { archivePath: null });
  f.write({ id: 'k1', title: 'K1' });
  await f.idx.rebuild();
  let calls = 0;
  LI._io.rename = () => { calls++; const e = new Error('busy'); e.code = 'EBUSY'; return Promise.reject(e); };
  const origErr = console.error; console.error = () => {};
  let r;
  try { r = await f.idx.upsert({ id: 'k2', title: 'K2' }); }
  finally { restoreIo(); console.error = origErr; }
  assert.strictEqual(r.ok, false); assert(/EBUSY/.test(r.error));
  assert.strictEqual(calls, 6, '1 次＋重試 5 次');
  const st = await f.idx.status();
  assert(st.lastError && /EBUSY/.test(st.lastError));
  const tmps = fs.readdirSync(path.dirname(f.opts.indexPath)).filter(n => n.includes('.tmp-'));
  assert(tmps.length >= 1, '保留暫存檔');
  assert.deepStrictEqual(ids((await f.idx.list()).items), ['k1'], '舊的完整版仍可讀');
});

test('非可重試錯誤不重試', async () => {
  const f = makeFeature('lock-other', { archivePath: null });
  f.write({ id: 'o1', title: 'O1' }); await f.idx.rebuild();
  let calls = 0;
  LI._io.rename = () => { calls++; const e = new Error('nope'); e.code = 'ENOSPC'; return Promise.reject(e); };
  const origErr = console.error; console.error = () => {};
  try { assert.strictEqual((await f.idx.upsert({ id: 'o2' })).ok, false); }
  finally { restoreIo(); console.error = origErr; }
  assert.strictEqual(calls, 1);
});

test('讀取快取：檔案沒變不重讀；外部改檔會讀到新版', async () => {
  const f = makeFeature('cache', { archivePath: null });
  f.write({ id: 'c1', title: 'C1' }); await f.idx.rebuild();
  let reads = 0;
  LI._io.readFile = p => { reads++; return origIo.readFile(p); };
  try {
    await f.idx.list(); await f.idx.list(); await f.idx.list();
    assert.strictEqual(reads, 0, '剛寫完的目錄已在快取');
    const disk = JSON.parse(fs.readFileSync(f.opts.indexPath, 'utf8'));
    disk.items.push({ id: 'c9', title: 'outside' });
    await sleep(15);
    fs.writeFileSync(f.opts.indexPath, JSON.stringify(disk));
    assert.deepStrictEqual(ids((await f.idx.list()).items), ['c1', 'c9']);
    assert.strictEqual(reads, 1);
  } finally { restoreIo(); }
});

test('verify：指紋對不上就重建；一致就不動', async () => {
  const f = makeFeature('verify');
  f.write({ id: 'v1', title: 'V1' }); await f.idx.rebuild();
  assert.deepStrictEqual(await f.idx.verify(), { ok: true, rebuilt: false });
  f.write({ id: 'v2', title: 'V2' });   // 不經 API 直接加檔（§5.3）
  const r = await f.idx.verify();
  assert.strictEqual(r.rebuilt, true); assert.strictEqual(r.reason, 'fingerprint');
  assert.deepStrictEqual(ids((await f.idx.list()).items), ['v1', 'v2']);
  fs.unlinkSync(f.opts.archivePath);
  assert.strictEqual((await f.idx.verify()).rebuilt, true, '歸檔目錄缺檔也要重建');
  assert(fs.existsSync(f.opts.archivePath));
});

test('同一 indexPath 開兩次＝同一條排隊', () => {
  const f = makeFeature('same');
  const again = LI.open(Object.assign({}, f.opts, { indexPath: f.opts.indexPath.toUpperCase() }));
  assert.strictEqual(again, f.idx);
});

test('功能登錄、狀態、手動重建、開機核對', async () => {
  LI._reset();
  assert.deepStrictEqual(LI.listKinds(), []);
  assert.deepStrictEqual(await LI.statusWorkspace(ROOT), [], '尚無登錄→空清單');
  assert.deepStrictEqual(LI.rebuildWorkspace(ROOT), { accepted: [], unknown: [] });
  assert.deepStrictEqual(await LI.verifyAllOnBoot([ROOT]), []);
  const wsA = path.join(ROOT, 'wsA'), wsB = path.join(ROOT, 'wsB');
  for (const ws of [wsA, wsB]) { fs.mkdirSync(path.join(ws, 'data'), { recursive: true }); }
  fs.writeFileSync(path.join(wsA, 'data', 'a1.json'), '{}');
  fs.writeFileSync(path.join(wsB, 'data', 'b1.json'), '{}'); fs.writeFileSync(path.join(wsB, 'data', 'b2.json'), '{}');
  let factoryCalls = 0;
  LI.registerIndexKind('things', ws => { factoryCalls++; const data = path.join(ws, 'data'); return LI.open({
    kind: 'things', workspace: ws,
    indexPath: path.join(LI.indexDirFor(ws), 'things.json'),
    scanSource: async () => (await fs.promises.readdir(data)).map(n => ({ id: n.slice(0, -5) })),
    fingerprintSource: async () => LI.idSetFingerprint((await fs.promises.readdir(data)).map(n => n.slice(0, -5))),
  }); });
  assert.deepStrictEqual(LI.rebuildWorkspace(wsA, 'nope'), { accepted: [], unknown: ['nope'] });
  const boot = await LI.verifyAllOnBoot([wsA, wsB, wsA.toUpperCase(), null]);
  assert.strictEqual(boot.length, 2, '重複工作區只核對一次、null 略過');
  assert(boot.every(r => r.ok && r.rebuilt));
  assert.strictEqual(factoryCalls, 2, '同工作區的 handle 有快取');
  const sA = await LI.statusWorkspace(wsA), sB = await LI.statusWorkspace(wsB);
  assert.strictEqual(sA[0].count, 1); assert.strictEqual(sB[0].count, 2, '工作區隔離：各一份');
  assert(sA[0].rebuiltAt && sA[0].updatedAt); assert.strictEqual(sA[0].rebuilding, false);
  fs.writeFileSync(path.join(wsA, 'data', 'a2.json'), '{}');
  assert.deepStrictEqual(LI.rebuildWorkspace(wsA), { accepted: ['things'], unknown: [] });
  await LI.getIndex('things', wsA)._idle();
  assert.strictEqual((await LI.statusWorkspace(wsA))[0].count, 2);
  const again = await LI.verifyAllOnBoot([wsA, wsB]);
  assert(again.every(r => r.ok && !r.rebuilt), '一致時開機核對不重建');
});

(async () => {
  const origLog = console.log; console.log = () => {};
  for (const t of tests) {
    try { await t.fn(); passed++; origLog('PASS ' + t.name); }
    catch (e) { failed++; origLog('FAIL ' + t.name + '\n   ' + (e && e.stack || e)); }
  }
  console.log = origLog;
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

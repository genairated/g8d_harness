// node portal/checks/meetings-index.test.js [--sample <含 .harness/runtime/meetings 的工作區複本>]
// 會議清單目錄（IDX-MTG）：合成資料單元測試；帶 --sample 時另跑真實 meta 複本的新舊比對＋量測。
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const mi = require('../meetings-index');
mi.register();

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + e.message); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (cond, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await cond()) return true; await sleep(20); } return false; };

// 改前的寫法（逐檔同步讀），當比對基準
function legacyList(ws) {
  const d = path.join(ws, '.harness', 'runtime', 'meetings'); const list = [];
  try { for (const id of fs.readdirSync(d)) { try { list.push(JSON.parse(fs.readFileSync(path.join(d, id, 'meta.json'), 'utf8'))); } catch (e) {} } } catch (e) {}
  list.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  return list;
}
function mk(ws, id, extra) {
  const dir = path.join(ws, '.harness', 'runtime', 'meetings', id); fs.mkdirSync(dir, { recursive: true });
  const n = parseInt(id.replace(/\D/g, ''), 10) || 0;
  const meta = Object.assign({ meetingId: id, title: 'T ' + id, startedAt: new Date(Date.UTC(2026, 0, 1) + n * 3600e3).toISOString(), finishedAt: null, status: 'done', workspace: ws }, extra || {});
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2)); return dir;
}
const idxFile = ws => path.join(ws, '.harness', 'index', 'meetings.json');
const tmpWs = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mtgidx-'));
const ready = async ws => { await mi.listAll(ws); assert.ok(await waitFor(() => fs.existsSync(idxFile(ws))), '目錄檔應建立'); await sleep(50); };

(async () => {
  console.log('meetings-index 單元測試');
  await t('沒有目錄檔：保底走掃資料夾、結果與舊寫法相同，並排重建', async () => {
    const ws = tmpWs(); mk(ws, 'meeting_1'); mk(ws, 'meeting_2'); mk(ws, 'meeting_3');
    fs.mkdirSync(path.join(ws, '.harness', 'runtime', 'meetings', '.git'), { recursive: true });
    const r = await mi.listAll(ws);
    assert.strictEqual(r.fallback, true);
    assert.deepStrictEqual(r.items, legacyList(ws));
    assert.ok(await waitFor(() => fs.existsSync(idxFile(ws))), '重建後應出現 meetings.json');
    await sleep(50);
    const r2 = await mi.listAll(ws);
    assert.strictEqual(r2.fallback, false);
    assert.deepStrictEqual(r2.items, legacyList(ws));
  });
  await t('開始一場：syncDir 後清單即時出現（不靠重建）', async () => {
    const ws = tmpWs(); mk(ws, 'meeting_1'); await ready(ws);
    const d = mk(ws, 'meeting_4', { status: 'recording' }); await mi.syncDir(d);
    const r = await mi.listAll(ws);
    assert.strictEqual(r.fallback, false);
    assert.ok(r.items.some(m => m.meetingId === 'meeting_4'));
    assert.deepStrictEqual(r.items, legacyList(ws));
  });
  await t('改 meta（PUT meta／摘要完成）→ syncDir → 清單更新', async () => {
    const ws = tmpWs(); const d = mk(ws, 'meeting_1'); await ready(ws);
    const mp = path.join(d, 'meta.json'); const m = JSON.parse(fs.readFileSync(mp, 'utf8')); m.title = '新標題'; m.tags = ['a']; m.summary = { x: 1 };
    fs.writeFileSync(mp, JSON.stringify(m)); await mi.syncDir(d);
    const it = (await mi.listAll(ws)).items[0]; assert.strictEqual(it.title, '新標題'); assert.deepStrictEqual(it.tags, ['a']);
    assert.deepStrictEqual((await mi.listAll(ws)).items, legacyList(ws));
  });
  await t('刪除：syncRemove 後清單即時消失', async () => {
    const ws = tmpWs(); mk(ws, 'meeting_1'); const d2 = mk(ws, 'meeting_2'); await ready(ws);
    fs.rmSync(d2, { recursive: true, force: true }); await mi.syncRemove(d2);
    assert.deepStrictEqual((await mi.listAll(ws)).items.map(m => m.meetingId), ['meeting_1']);
  });
  await t('Python 子程序自己改 meta（recording→done）：進行中的項目以實際檔案為準，且順手更新目錄', async () => {
    const ws = tmpWs(); const d = mk(ws, 'meeting_1', { status: 'recording' }); await ready(ws);
    assert.strictEqual((await mi.listAll(ws)).items[0].status, 'recording');
    const mp = path.join(d, 'meta.json'); const m = JSON.parse(fs.readFileSync(mp, 'utf8')); m.status = 'done'; m.finishedAt = 'X'; fs.writeFileSync(mp, JSON.stringify(m));  // 不經 syncDir
    assert.strictEqual((await mi.listAll(ws)).items[0].status, 'done');
    assert.ok(await waitFor(() => JSON.parse(fs.readFileSync(idxFile(ws), 'utf8')).items[0].status === 'done'), '目錄檔也應被更新');
  });
  await t('目錄檔壞掉（半截 JSON）：不丟錯，走保底', async () => {
    const ws = tmpWs(); mk(ws, 'meeting_1'); await ready(ws);
    fs.writeFileSync(idxFile(ws), '{"schema":"harness.list-index/1","items":[{'); await sleep(30);
    const r = await mi.listAll(ws); assert.deepStrictEqual(r.items, legacyList(ws));
  });
  await t('重建：壞 meta 與沒有 meta 的資料夾被略過；缺 meetingId 以資料夾名補上', async () => {
    const ws = tmpWs(); mk(ws, 'meeting_1'); mk(ws, 'meeting_2');
    const root = path.join(ws, '.harness', 'runtime', 'meetings');
    fs.mkdirSync(path.join(root, 'meeting_bad')); fs.writeFileSync(path.join(root, 'meeting_bad', 'meta.json'), '');
    fs.mkdirSync(path.join(root, 'meeting_nometa'));
    fs.mkdirSync(path.join(root, 'meeting_old')); fs.writeFileSync(path.join(root, 'meeting_old', 'meta.json'), JSON.stringify({ title: 'old', startedAt: '2025-01-01' }));
    const h = mi.handleFor(ws); const r = await h.rebuild({ reason: 'test' }); assert.strictEqual(r.ok, true);
    const ids = (await mi.listAll(ws)).items.map(m => m.meetingId).sort();
    assert.deepStrictEqual(ids, ['meeting_1', 'meeting_2', 'meeting_old']);
  });
  await t('同時 30 個 syncDir 不遺失', async () => {
    const ws = tmpWs(); mk(ws, 'meeting_0'); await ready(ws);
    const ds = []; for (let i = 10; i < 40; i++) ds.push(mk(ws, 'meeting_' + i));
    await Promise.all(ds.map(d => mi.syncDir(d)));
    assert.strictEqual((await mi.listAll(ws)).items.length, 31);
  });
  await t('工作區隔離：兩個工作區各一份目錄，互不外洩', async () => {
    const a = tmpWs(), b = tmpWs(); mk(a, 'meeting_1'); mk(b, 'meeting_2'); mk(b, 'meeting_3');
    assert.strictEqual((await mi.listAll(a)).items.length, 1); assert.strictEqual((await mi.listAll(b)).items.length, 2);
  });
  await t('開機核對：目錄漏了一場（直接改檔）→ verify 偵測並重建', async () => {
    const ws = tmpWs(); mk(ws, 'meeting_1'); await ready(ws);
    mk(ws, 'meeting_9'); const v = await mi.handleFor(ws).verify(); assert.strictEqual(v.rebuilt, true);
    assert.deepStrictEqual((await mi.listAll(ws)).items, legacyList(ws));
  });
  await t('wsRootOfMeetingDir：標準位置才認', async () => {
    const ok = path.join(os.tmpdir(), 'x', '.harness', 'runtime', 'meetings', 'm1');
    assert.strictEqual(mi.wsRootOfMeetingDir(ok), path.join(os.tmpdir(), 'x'));
    assert.strictEqual(mi.wsRootOfMeetingDir(path.join(os.tmpdir(), 'x', 'other', 'm1')), null);
  });

  const si = process.argv.indexOf('--sample');
  if (si > 0) {
    const real = path.resolve(process.argv[si + 1]);
    console.log('真實 meta 複本：' + real);
    await t('新舊清單逐筆相同＋量測', async () => {
      const N = 5; const before = [];
      for (let i = 0; i < N; i++) { const t0 = process.hrtime.bigint(); legacyList(real); before.push(Number(process.hrtime.bigint() - t0) / 1e6); }
      const t0 = process.hrtime.bigint(); const first = await mi.listAll(real); const firstMs = Number(process.hrtime.bigint() - t0) / 1e6;
      assert.strictEqual(first.fallback, true);
      assert.ok(await waitFor(() => fs.existsSync(idxFile(real)), 8000));
      await sleep(200);
      const after = [];
      for (let i = 0; i < 20; i++) { const a0 = process.hrtime.bigint(); const r = await mi.listAll(real); after.push(Number(process.hrtime.bigint() - a0) / 1e6); assert.strictEqual(r.fallback, false); }
      const L = legacyList(real), R = (await mi.listAll(real)).items;
      assert.strictEqual(JSON.stringify(R), JSON.stringify(L), '新舊清單（含欄位順序）應完全相同');
      const f = a => a.map(x => x.toFixed(2)).join(', ');
      after.sort((a, b) => a - b);
      console.log(`    場數 ${L.length}；改前（逐檔同步讀）${N} 次(ms)：${f(before)}`);
      console.log(`    改後：第一次(無目錄，保底掃) ${firstMs.toFixed(2)} ms；之後 20 次 最大 ${after[19].toFixed(2)} ms／中位 ${after[10].toFixed(2)} ms`);
    });
  }
  console.log(`\n${pass} 通過、${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})();

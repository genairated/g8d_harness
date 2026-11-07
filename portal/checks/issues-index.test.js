// node portal/checks/issues-index.test.js [--sample <含 .harness/issues 的 harness home 複本>]
// 問題回報清單目錄（IDX-ISS）：合成資料單元測試；帶 --sample 時另跑真實資料複本的新舊比對＋量測。
// 全部在暫存目錄跑（sample 會先複製一份），不碰真實 .harness/issues、不起 server。
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const store = require('../issues');
const listIndex = require('../list-index');

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + e.message); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (cond, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await cond()) return true; await sleep(20); } return false; };

// 改前的寫法（路由原樣：整份讀三次——清單、X-Open-Count、summary），當比對基準
function legacyList(home, q) {
  q = q || {};
  const list = store.listIssues(home, { status: q.status, type: q.type })
    .map(i => ({ id: i.id, type: i.type, title: i.title, status: i.status, workspace: i.workspace, route: i.route, view: i.view, version: i.version, createdAt: i.createdAt }));
  const open = store.countOpen(home);
  const all = store.listIssues(home);
  return { list, open, summary: { open: all.filter(i => store.OPEN_STATUSES.includes(i.status)).length, total: all.length } };
}
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'issidx-'));
const idxDir = home => listIndex.sharedIndexDirFor(store.issuesDir(home), home);
const idxFile = home => path.join(idxDir(home), 'issues.json');
const arcFile = home => path.join(idxDir(home), 'issues.archive.json');
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const mk = (home, text, ws) => store.createIssue(home, { description: text, type: 'bug', route: '#/x', view: 'v', version: 'v1' }, { workspace: ws === undefined ? 'D:\\ws\\a' : ws });
const ready = async home => { await store.listIndexed(home); assert.ok(await waitFor(() => fs.existsSync(idxFile(home))), '目錄檔應建立'); await sleep(50); };
const copyDir = (a, b) => { fs.mkdirSync(b, { recursive: true }); for (const n of fs.readdirSync(a)) { const s = path.join(a, n), d = path.join(b, n); fs.statSync(s).isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d); } };

(async () => {
  console.log('issues-index 單元測試');
  const sampleIdx = process.argv.indexOf('--sample');

  await t('沒有目錄檔：保底掃資料夾、結果與舊寫法相同，並排重建', async () => {
    const home = tmpHome(); store.registerIndex(home);
    mk(home, 'one'); mk(home, 'two', null); mk(home, 'three');
    const r = await store.listIndexed(home);
    const old = legacyList(home);
    assert.strictEqual(r.fallback, true);
    assert.deepStrictEqual(r.items, old.list);
    assert.strictEqual(r.open, old.open);
    assert.ok(await waitFor(() => fs.existsSync(idxFile(home))), '重建後應出現 issues.json');
  });

  await t('目錄建好後：清單／待處理數／summary 與舊寫法逐位元組相同；null workspace 保留', async () => {
    const home = tmpHome(); store.registerIndex(home);
    mk(home, 'one'); mk(home, 'two', null); mk(home, 'three');
    await ready(home);
    const r = await store.listIndexed(home);
    const old = legacyList(home);
    assert.strictEqual(r.fallback, false);
    assert.strictEqual(JSON.stringify(r.items), JSON.stringify(old.list));
    assert.strictEqual(r.open, old.open);
    assert.deepStrictEqual({ open: r.open, total: r.total }, old.summary);
    assert.strictEqual(r.items.find(i => i.title === 'two').workspace, null);
  });

  await t('新增一筆：即時出現；next-id 同步前進', async () => {
    const home = tmpHome(); store.registerIndex(home);
    mk(home, 'a'); await ready(home);
    const n = mk(home, 'b');
    assert.ok(await waitFor(async () => (await store.listIndexed(home)).items.some(i => i.id === n.id)));
    assert.strictEqual(fs.readFileSync(path.join(store.issuesDir(home), 'next-id'), 'utf8'), String(n.id + 1));
    assert.deepStrictEqual((await store.listIndexed(home)).items, legacyList(home).list);
  });

  await t('改狀態：待處理→已結案 搬進歸檔、待處理數 -1、清單仍含該筆；回到處理中則搬回', async () => {
    const home = tmpHome(); store.registerIndex(home);
    const a = mk(home, 'a'); mk(home, 'b'); await ready(home);
    store.updateIssueStatus(home, a.id, '已結案', 'commander', 'ok');
    assert.ok(await waitFor(() => fs.existsSync(arcFile(home)) && readJson(arcFile(home)).items.some(i => i.id === a.id) && !readJson(idxFile(home)).items.some(i => i.id === a.id)), '應搬進歸檔、主目錄不再有');
    let r = await store.listIndexed(home);
    assert.strictEqual(r.open, 1); assert.strictEqual(r.total, 2);
    assert.deepStrictEqual(r.items, legacyList(home).list);
    assert.strictEqual(store.readIssue(home, a.id).history.length, 2);
    store.updateIssueStatus(home, a.id, '處理中');
    assert.ok(await waitFor(async () => !readJson(arcFile(home)).items.some(i => i.id === a.id) && readJson(idxFile(home)).items.some(i => i.id === a.id)), '應搬回主目錄');
    r = await store.listIndexed(home); assert.strictEqual(r.open, 2);
    assert.throws(() => store.updateIssueStatus(home, a.id, '亂寫'), /invalid status/);
    assert.strictEqual(store.updateIssueStatus(home, 999, '處理中'), null);
  });

  await t('篩選 status／type 與舊寫法相同', async () => {
    const home = tmpHome(); store.registerIndex(home);
    const a = mk(home, 'a'); store.createIssue(home, { description: 'f', type: 'feature' }, { workspace: 'W' }); mk(home, 'c');
    store.updateIssueStatus(home, a.id, '不處理'); await ready(home);
    for (const q of [{ status: '待處理' }, { type: 'feature' }, { status: '不處理' }, { status: '待處理', type: 'bug' }]) {
      assert.deepStrictEqual((await store.listIndexed(home, q)).items, legacyList(home, q).list, JSON.stringify(q));
    }
  });

  await t('linkSession：寫完同步（目錄項目不變、不壞）；去重', async () => {
    const home = tmpHome(); store.registerIndex(home);
    const a = mk(home, 'a'); await ready(home);
    store.linkSession(home, a.id, 'sess-1', 'L'); store.linkSession(home, a.id, 'sess-1', 'L');
    assert.strictEqual(store.readIssue(home, a.id).linkedSessions.length, 1);
    await sleep(100);
    assert.deepStrictEqual((await store.listIndexed(home)).items, legacyList(home).list);
  });

  await t('刪目錄檔 → 保底仍正確 → 自動重建回來；半截壞檔同理', async () => {
    const home = tmpHome(); store.registerIndex(home);
    mk(home, 'a'); mk(home, 'b'); await ready(home);
    fs.rmSync(idxDir(home), { recursive: true, force: true });
    let r = await store.listIndexed(home);
    assert.strictEqual(r.fallback, true); assert.strictEqual(r.items.length, 2);
    assert.ok(await waitFor(() => fs.existsSync(idxFile(home))), '應自動重建');
    await sleep(100);
    fs.writeFileSync(idxFile(home), '{"items":[{"id":');   // 半截
    r = await store.listIndexed(home);
    assert.strictEqual(r.fallback, true); assert.strictEqual(r.items.length, 2);
    assert.ok(await waitFor(async () => { try { return readJson(idxFile(home)).items.length === 2; } catch (e) { return false; } }), '壞檔應被重建覆蓋');
  });

  await t('開機核對：目錄漏一筆（外部多了一個資料夾）→ 重建補回', async () => {
    const home = tmpHome(); store.registerIndex(home);
    mk(home, 'a'); mk(home, 'b'); await ready(home);
    const d = path.join(store.issuesDir(home), '9'); fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'issue.json'), JSON.stringify({ id: 9, type: 'bug', title: 'ext', status: '待處理', workspace: null, createdAt: 'x' }));
    const v = await listIndex.getIndex('issues', home).verify();
    assert.strictEqual(v.rebuilt, true);
    assert.ok((await store.listIndexed(home)).items.some(i => i.id === 9));
  });

  await t('其他工作區路徑不另開目錄（回 null）', async () => {
    const home = tmpHome(); store.registerIndex(home);
    assert.strictEqual(listIndex.getIndex('issues', path.join(home, 'other')), null);
    assert.ok(listIndex.getIndex('issues', home.toUpperCase() === home ? home : home));
  });

  await t('next-id：缺檔時從資料夾算；落後時往後找；壞內容時重算；同時 20 筆建立編號不重複', async () => {
    const home = tmpHome(); store.registerIndex(home);
    mk(home, 'a'); mk(home, 'b');
    const nid = path.join(store.issuesDir(home), 'next-id');
    fs.rmSync(nid); assert.strictEqual(mk(home, 'c').id, 3);
    fs.writeFileSync(nid, '1'); assert.strictEqual(mk(home, 'd').id, 4);   // 落後：EEXIST 往後找
    fs.writeFileSync(nid, 'abc'); assert.strictEqual(mk(home, 'e').id, 5);
    const ids = await Promise.all(Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => mk(home, 'p' + i).id)));
    assert.strictEqual(new Set(ids).size, 20);
    await sleep(200);
    const r = await store.listIndexed(home);
    assert.strictEqual(r.total, 25);
    assert.deepStrictEqual(r.items, legacyList(home).list);
  });

  await t('同時 30 次新增＋改狀態不遺失（目錄＝逐筆實際檔案的結果）', async () => {
    const home = tmpHome(); store.registerIndex(home);
    mk(home, 'seed'); await ready(home);
    const made = [];
    for (let i = 0; i < 30; i++) made.push(mk(home, 'c' + i));
    for (let i = 0; i < 30; i += 3) store.updateIssueStatus(home, made[i].id, '已結案');
    assert.ok(await waitFor(async () => { const r = await store.listIndexed(home); return r.total === 31 && r.open === 21; }, 6000));
    assert.deepStrictEqual((await store.listIndexed(home)).items, legacyList(home).list);
  });

  if (sampleIdx > 0) {
    const src = path.resolve(process.argv[sampleIdx + 1]);
    await t('真實資料複本：新舊清單／待處理數／summary 相同，並量測', async () => {
      const home = tmpHome(); copyDir(path.join(src, '.harness', 'issues'), store.issuesDir(home)); store.registerIndex(home);
      const old = legacyList(home);
      const r0 = await store.listIndexed(home);          // 無目錄：保底
      assert.deepStrictEqual(r0.items, old.list);
      await ready(home);
      const r = await store.listIndexed(home);
      assert.strictEqual(JSON.stringify(r.items), JSON.stringify(old.list));
      assert.strictEqual(r.open, old.open);
      assert.deepStrictEqual({ open: r.open, total: r.total }, old.summary);
      const N = 20, med = a => a.slice().sort((x, y) => x - y)[a.length >> 1];
      const tOld = [], tNew = [];
      for (let i = 0; i < N; i++) { const t0 = process.hrtime.bigint(); legacyList(home); tOld.push(Number(process.hrtime.bigint() - t0) / 1e6); }
      for (let i = 0; i < N; i++) { const t0 = process.hrtime.bigint(); await store.listIndexed(home); tNew.push(Number(process.hrtime.bigint() - t0) / 1e6); }
      console.log(`    真實複本 ${old.list.length} 筆（含錄影）：改前（清單＋待處理數＋summary 共讀 3 次）中位 ${med(tOld).toFixed(2)} ms；改後（讀 1 次目錄）中位 ${med(tNew).toFixed(2)} ms`);
    });
    await t('放大量測：合成 500 筆小單（每筆 issue.json 約 2 KB）新舊耗時', async () => {
      const home = tmpHome(); store.registerIndex(home);
      const root = store.issuesDir(home); fs.mkdirSync(root, { recursive: true });
      for (let i = 1; i <= 500; i++) {
        const d = path.join(root, String(i)); fs.mkdirSync(d);
        fs.writeFileSync(path.join(d, 'issue.json'), JSON.stringify({ id: i, type: 'bug', title: 't' + i, description: 'x'.repeat(1500), status: i % 4 ? '已結案' : '待處理', createdAt: new Date(1e12 + i).toISOString(), workspace: 'W', route: '#/x', view: 'v', version: 'v1', history: [] }, null, 2));
      }
      const t0 = process.hrtime.bigint(); const r0 = await store.listIndexed(home); const fb = Number(process.hrtime.bigint() - t0) / 1e6;
      assert.strictEqual(r0.items.length, 500);
      await ready(home);
      const med = a => a.slice().sort((x, y) => x - y)[a.length >> 1];
      const tOld = [], tNew = [];
      for (let i = 0; i < 5; i++) { const a = process.hrtime.bigint(); legacyList(home); tOld.push(Number(process.hrtime.bigint() - a) / 1e6); }
      for (let i = 0; i < 20; i++) { const a = process.hrtime.bigint(); await store.listIndexed(home); tNew.push(Number(process.hrtime.bigint() - a) / 1e6); }
      console.log(`    500 筆：改前中位 ${med(tOld).toFixed(1)} ms；改後（目錄）中位 ${med(tNew).toFixed(2)} ms；無目錄保底首次 ${fb.toFixed(1)} ms`);
      assert.deepStrictEqual((await store.listIndexed(home)).items, legacyList(home).list);
    });
  }

  console.log(`\n${pass} 通過，${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})();

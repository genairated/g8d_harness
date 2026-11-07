// whiteboards-index.test.js — IDX-WB 單元測試。node portal/checks/whiteboards-index.test.js
// 全程在暫存目錄；樣本取自 _tmp/idx/wb-sample/ws（客戶專案白板資料夾複本，若存在）。不起 server、不碰真實工作區。
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const listIndex = require('../list-index');
const wb = require('../whiteboards');

let pass = 0, fail = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass++; results.push('PASS ' + name); }
  catch (e) { fail++; results.push('FAIL ' + name + ' — ' + (e && e.stack || e)); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitIdle(root) {
  const h = wb.__idx ? wb.__idx(root) : listIndex.getIndex('whiteboards', root);
  for (let i = 0; i < 300; i++) { const s = await h.status(); if (!s.rebuilding && !s.pendingWrites) { await sleep(30); return; } await sleep(10); }
}
function mkWs() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'wbidx-'));
  fs.mkdirSync(path.join(ws, '.harness', 'whiteboards'), { recursive: true });
  return ws;
}
function addBoard(ws, id, title, updatedAt) {
  wb.writeBoard(ws, id, { id, title, elements: [], appState: {}, files: {}, updatedAt });
}
const slim = a => a.map(e => ({ id: e.id, title: e.title, createdAt: e.createdAt, updatedAt: e.updatedAt }));
const sample = path.join(__dirname, '..', '..', '_tmp', 'idx', 'wb-sample', 'ws');
function copySample() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'wbidx-real-'));
  fs.cpSync(path.join(sample, '.harness'), path.join(ws, '.harness'), { recursive: true });
  return ws;
}

(async () => {
  wb.registerIndexKind();

  await t('新增／更新／刪除一張白板：目錄同步', async () => {
    const ws = mkWs();
    const id = 'wb_1794000000000_aaaaaa';
    addBoard(ws, id, 'A', '2026-11-07T00:00:00.000Z');
    // 目錄尚不存在 → upsert 延後（deferred），清單走保底並排重建
    await wb.upsertMeta(ws, { id, title: 'A', createdAt: '2026-11-07T00:00:00.000Z', updatedAt: '2026-11-07T00:00:00.000Z' });
    let r = await wb.listBoards(ws);
    assert.strictEqual(r.items.length, 1);
    await waitIdle(ws);
    r = await wb.listBoards(ws);
    assert.strictEqual(r.fallback, false);
    assert.strictEqual(r.items[0].title, 'A');
    const id2 = 'wb_1794003600000_bbbbbb';
    addBoard(ws, id2, 'B', '2026-11-07T01:00:00.000Z');
    await wb.upsertMeta(ws, { id: id2, title: 'B', createdAt: '2026-11-07T01:00:00.000Z', updatedAt: '2026-11-07T01:00:00.000Z' });
    await wb.upsertMeta(ws, { id, title: 'A2', updatedAt: '2026-11-07T02:00:00.000Z' }); // 改標題：createdAt 要保留
    r = await wb.listBoards(ws);
    assert.deepStrictEqual(r.items.map(e => e.title), ['A2', 'B']);
    assert.strictEqual(r.items[0].createdAt, new Date(1794000000000).toISOString());
    assert.strictEqual(r.items[0].updatedAt, '2026-11-07T02:00:00.000Z');
    await wb.deleteBoard(ws, id);
    r = await wb.listBoards(ws);
    assert.deepStrictEqual(r.items.map(e => e.id), [id2]);
    assert(!fs.existsSync(wb.boardDir(ws, id)));
  });

  await t('同時 30 次更新不遺失', async () => {
    const ws = mkWs();
    const ids = [];
    for (let i = 0; i < 30; i++) { const id = 'wb_' + (1000 + i) + '_x'; ids.push(id); addBoard(ws, id, 'T' + i, '2026-11-07T00:00:' + String(i).padStart(2, '0') + '.000Z'); }
    await wb.listBoards(ws); await waitIdle(ws); // 建出目錄
    await Promise.all(ids.map(id => wb.upsertMeta(ws, { id, title: 'N' + id, updatedAt: '2026-11-07T05:00:00.000Z' })));
    const r = await wb.listBoards(ws);
    assert.strictEqual(r.items.length, 30);
    assert(r.items.every(e => e.title === 'N' + e.id));
  });

  await t('中斷殘留暫存檔不影響讀', async () => {
    const ws = mkWs();
    addBoard(ws, 'wb_1_a', 'A', '2026-11-07T00:00:00.000Z');
    await wb.listBoards(ws); await waitIdle(ws);
    fs.writeFileSync(wb.indexPath(ws) + '.tmp-999-zz', '{"half');
    const r = await wb.listBoards(ws);
    assert.strictEqual(r.fallback, false); assert.strictEqual(r.items.length, 1);
  });

  await t('壞檔（半截 JSON）→ 保底掃描＋自動重建', async () => {
    const ws = mkWs();
    addBoard(ws, 'wb_1_a', 'A', '2026-11-07T00:00:00.000Z');
    fs.writeFileSync(wb.indexPath(ws), '{"schema":"harness.li');
    let r = await wb.listBoards(ws);
    assert.strictEqual(r.fallback, true); assert.strictEqual(r.items[0].title, 'A');
    await waitIdle(ws);
    r = await wb.listBoards(ws);
    assert.strictEqual(r.fallback, false); assert.strictEqual(r.items.length, 1);
  });

  await t('核對：多出一張白板資料夾 → 開機核對後補進目錄', async () => {
    const ws = mkWs();
    addBoard(ws, 'wb_1_a', 'A', '2026-11-07T00:00:00.000Z');
    await wb.listBoards(ws); await waitIdle(ws);
    addBoard(ws, 'wb_2_b', 'B', '2026-11-07T01:00:00.000Z'); // Hana 直接寫檔，沒走 API
    assert.strictEqual((await wb.listBoards(ws)).items.length, 1);
    const v = await listIndex.getIndex('whiteboards', ws).verify();
    assert.strictEqual(v.rebuilt, true);
    await waitIdle(ws);
    assert.strictEqual((await wb.listBoards(ws)).items.length, 2);
    const v2 = await listIndex.getIndex('whiteboards', ws).verify();
    assert.strictEqual(v2.rebuilt, false);
  });

  await t('非白板資料夾（_wb1_test_evidence 之類）被忽略，核對不會每次重建', async () => {
    const ws = mkWs();
    addBoard(ws, 'wb_1_a', 'A', '2026-11-07T00:00:00.000Z');
    fs.mkdirSync(path.join(wb.whiteboardsDir(ws), '_wb1_test_evidence'), { recursive: true });
    await wb.listBoards(ws); await waitIdle(ws);
    assert.strictEqual((await listIndex.getIndex('whiteboards', ws).verify()).rebuilt, false);
  });

  await t('沒有白板資料夾的工作區：不建資料夾、清單為空', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'wbidx-empty-'));
    const r = await wb.listBoards(ws);
    assert.deepStrictEqual(r.items, []);
    assert(!fs.existsSync(path.join(ws, '.harness', 'whiteboards')));
    assert.strictEqual(listIndex.getIndex('whiteboards', ws), null);
  });

  await t('舊版 readIndex 相容兩種格式（陣列／物件）', async () => {
    const ws = mkWs();
    fs.writeFileSync(wb.indexPath(ws), JSON.stringify([{ id: 'wb_1_a', title: 'A' }]));
    assert.strictEqual(wb.readIndex(ws).length, 1);
    addBoard(ws, 'wb_1_a', 'A', '2026-11-07T00:00:00.000Z');
    fs.unlinkSync(wb.indexPath(ws));
    await wb.listBoards(ws); await waitIdle(ws);
    assert.strictEqual(wb.readIndex(ws).length, 1);
  });

  if (fs.existsSync(sample)) {
    const orig = JSON.parse(fs.readFileSync(path.join(sample, '.harness', 'whiteboards', 'index.json'), 'utf8'));
    const timing = {};

    await t('樣本（客戶專案複本）：舊版陣列檔升級後清單與原本相同（含 createdAt）', async () => {
      const ws = copySample();
      let r = await wb.listBoards(ws);
      assert.strictEqual(r.fallback, true, '舊陣列格式首次應走保底');
      assert.deepStrictEqual(slim(r.items), slim(orig));
      await waitIdle(ws);
      r = await wb.listBoards(ws);
      assert.strictEqual(r.fallback, false);
      assert.deepStrictEqual(slim(r.items), slim(orig));
    });

    await t('樣本：刪掉 index.json 後重建，標題與 updatedAt 與原目錄相同', async () => {
      const ws = copySample();
      await wb.listBoards(ws); await waitIdle(ws);
      const before = slim((await wb.listBoards(ws)).items);
      fs.unlinkSync(wb.indexPath(ws));
      let r = await wb.listBoards(ws);
      assert.strictEqual(r.fallback, true);
      await waitIdle(ws);
      r = await wb.listBoards(ws);
      assert.strictEqual(r.fallback, false);
      const after = slim(r.items);
      // 刪掉目錄後 createdAt 無舊檔可沿用，改取檔案建立時間：只比 id／title／updatedAt
      // 手取名稱的白板（wb_alert_dashboard）id 不含時間，順序可能不同 → 依 id 排序後比對
      const key = x => x.map(e => [e.id, e.title, e.updatedAt]).sort((p, q) => p[0].localeCompare(q[0]));
      assert.deepStrictEqual(key(after), key(before));
      assert.deepStrictEqual(key(after), key(orig));
    });

    await t('樣本量測：改前（同步讀陣列檔）vs 改後（目錄＋快取）', async () => {
      const ws = copySample();
      const N = 200;
      let t0 = process.hrtime.bigint();
      for (let i = 0; i < N; i++) wb.readIndex(ws);
      timing.before = Number(process.hrtime.bigint() - t0) / 1e6 / N;
      await wb.listBoards(ws); await waitIdle(ws);
      t0 = process.hrtime.bigint();
      await wb.listBoards(ws);
      timing.afterFirst = Number(process.hrtime.bigint() - t0) / 1e6;
      t0 = process.hrtime.bigint();
      for (let i = 0; i < N; i++) await wb.listBoards(ws);
      timing.after = Number(process.hrtime.bigint() - t0) / 1e6 / N;
      // 保底（逐板掃描）耗時
      t0 = process.hrtime.bigint();
      await wb.scanBoards(ws);
      timing.scan = Number(process.hrtime.bigint() - t0) / 1e6;
      results.push(`TIMING 11 張白板複本：改前 readIndex ${timing.before.toFixed(3)} ms／次（同步）；改後 listBoards 第一次 ${timing.afterFirst.toFixed(2)} ms、之後 ${timing.after.toFixed(3)} ms／次；完整重建掃描 ${timing.scan.toFixed(1)} ms`);
    });
  } else {
    results.push('SKIP 樣本不存在：' + sample);
  }

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

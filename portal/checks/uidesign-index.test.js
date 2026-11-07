'use strict';
// IDX-UID：UI 設計系統四份清單目錄（元件／畫面／範本／演示）改經共用模組的單元測試。
// 用法：node portal/checks/uidesign-index.test.js [樣本工作區根目錄（內含 .harness/uidesign）]
// 一律在暫存目錄跑（會把樣本複製過去），不碰任何真實工作區。
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const store = require('../uidesign');
const listIndex = require('../list-index');

let pass = 0, fail = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass++; results.push('PASS  ' + name); }
  catch (e) { fail++; results.push('FAIL  ' + name + '\n      ' + (e && e.stack || e).toString().split('\n').slice(0, 4).join('\n      ')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idx-uid-'));
async function idle(root) { for (const k of ['ui-components', 'ui-screens', 'ui-templates', 'ui-flows']) await store.getIdx(k, root)._idle(); }
function copyDir(src, dst) { fs.cpSync(src, dst, { recursive: true }); }
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const KINDS = [['ui-components', store.indexPath], ['ui-screens', store.screensIndexPath], ['ui-templates', store.templatesIndexPath], ['ui-flows', store.flowsIndexPath]];

(async () => {
  const sample = process.argv[2];

  await t('全新工作區：種子只做一次，範本與骨架佔位元件進目錄', async () => {
    const root = tmpRoot();
    let existsCalls = 0; const orig = fs.existsSync;
    const tpl1 = await store.listTemplates(root);
    assert.ok(tpl1.items.length >= 1, '應有骨架範本');
    assert.ok(tpl1.items.every(x => x.thumbnail && x.source === 'seed'));
    fs.existsSync = (...a) => { existsCalls++; return orig(...a); };
    try {
      const tpl2 = await store.listTemplates(root);
      assert.strictEqual(tpl2.items.length, tpl1.items.length);
    } finally { fs.existsSync = orig; }
    assert.strictEqual(existsCalls, 0, '第二次讀不應再做種子檢查（existsSync 被呼叫 ' + existsCalls + ' 次）');
    const comps = await store.listComponents(root);
    assert.ok(comps.items.length >= 1, '骨架佔位元件應在元件清單');
    await idle(root);
    assert.strictEqual(readJson(store.templatesIndexPath(root)).schema, 'harness.list-index/1');
  });

  await t('舊版純陣列檔：第一次走保底掃描，之後重建成新格式、清單內容相同', async () => {
    const root = tmpRoot();
    const dir = store.uidesignDir(root);
    fs.mkdirSync(store.componentsDir(root), { recursive: true });
    store.writeComponent(root, 'uic_1_a', { name: 'A', category: 'x', description: 'd', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', html: '<b/>', css: '' });
    store.writeComponent(root, 'uic_2_b', { name: 'B', category: 'y', description: 'e', createdAt: '2026-01-03T00:00:00.000Z', updatedAt: '2026-01-04T00:00:00.000Z', html: '<i/>', css: '' });
    fs.writeFileSync(store.indexPath(root), JSON.stringify([{ id: 'uic_1_a', name: 'A', category: 'x', description: 'd', updatedAt: '2026-01-02T00:00:00.000Z' }]));
    const r1 = await store.listComponents(root);
    assert.strictEqual(r1.fallback, true);
    assert.deepStrictEqual(r1.items.map(x => x.id), ['uic_1_a', 'uic_2_b']); // 依建立時間
    await idle(root);
    const r2 = await store.listComponents(root);
    assert.strictEqual(r2.fallback, false);
    assert.deepStrictEqual(r2.items.map(x => x.id), ['uic_1_a', 'uic_2_b']);
    assert.ok(Array.isArray(readJson(store.indexPath(root)).items));
    assert.ok(dir);
  });

  await t('四種：新增／更新／刪除即時反映在清單，且目錄檔跟著變', async () => {
    const root = tmpRoot();
    const now = () => new Date().toISOString();
    // 元件
    store.writeComponent(root, 'uic_x', { name: 'X', category: 'c', description: '', html: '', css: '', createdAt: now(), updatedAt: now() });
    await store.upsertComponent(root, { id: 'uic_x', name: 'X', category: 'c', description: '', updatedAt: now() });
    store.writeComponent(root, 'uic_x', { name: 'X2', category: 'c', description: '', html: '', css: '', createdAt: now(), updatedAt: now() });
    await store.upsertComponent(root, { id: 'uic_x', name: 'X2', category: 'c', description: '', updatedAt: now() });
    let r = await store.listComponents(root);
    assert.deepStrictEqual(r.items.filter(x => x.id === 'uic_x').map(x => x.name), ['X2']);
    await store.deleteComponent(root, 'uic_x');
    r = await store.listComponents(root);
    assert.ok(!r.items.find(x => x.id === 'uic_x'));
    // 畫面
    const sc = { id: 'uis_1', name: 'S', device: 'desktop-1440', frame: { width: 1440, height: 900 }, unit: 'px', scale: 1, elements: [], createdAt: now(), updatedAt: now() };
    store.writeScreen(root, 'uis_1', sc); await store.upsertScreen(root, sc);
    sc.name = 'S2'; store.writeScreen(root, 'uis_1', sc); await store.upsertScreen(root, sc);
    r = await store.listScreens(root);
    assert.deepStrictEqual(r.items.map(x => [x.id, x.name, x.unit, x.scale]), [['uis_1', 'S2', 'px', 1]]);
    await store.deleteScreen(root, 'uis_1');
    assert.strictEqual((await store.listScreens(root)).items.length, 0);
    // 範本（先讓種子做完）
    const seedCount = (await store.listTemplates(root)).items.length;
    const tp = { id: 'uit_1', name: 'T', device: 'desktop-1440', deviceGroup: 'desktop', tags: ['a'], frame: { width: 1, height: 1 }, elements: [], source: 'screen', thumbnail: '<svg/>', createdAt: now(), updatedAt: now() };
    store.writeTemplate(root, 'uit_1', tp); await store.upsertTemplate(root, tp);
    r = await store.listTemplates(root);
    assert.strictEqual(r.items.length, seedCount + 1);
    assert.deepStrictEqual(Object.keys(r.items.find(x => x.id === 'uit_1')).sort(), ['deviceGroup', 'device', 'id', 'name', 'source', 'tags', 'thumbnail', 'updatedAt'].sort());
    await store.deleteTemplate(root, 'uit_1');
    assert.strictEqual((await store.listTemplates(root)).items.length, seedCount);
    // 演示
    const fl = { id: 'uif_1', name: 'F', description: 'd', device: null, steps: [{ screenId: 'a' }, { screenId: 'b' }], createdAt: now(), updatedAt: now() };
    store.writeFlow(root, 'uif_1', fl); await store.upsertFlow(root, fl);
    r = await store.listFlows(root);
    assert.deepStrictEqual(r.items.map(x => [x.id, x.stepCount]), [['uif_1', 2]]);
    await store.deleteFlow(root, 'uif_1');
    assert.strictEqual((await store.listFlows(root)).items.length, 0);
    await idle(root);
  });

  await t('同時 30 筆新增／更新都不遺失（排隊＋暫存換名）', async () => {
    const root = tmpRoot();
    fs.mkdirSync(store.screensDir(root), { recursive: true });
    await store.listScreens(root); // 先建好目錄
    await idle(root);
    const ps = [];
    for (let i = 0; i < 30; i++) {
      const sc = { id: 'uis_c' + i, name: 'n' + i, device: 'd', frame: {}, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: new Date().toISOString() };
      store.writeScreen(root, sc.id, sc);
      ps.push(store.upsertScreen(root, sc));
    }
    await Promise.all(ps);
    await idle(root);
    assert.strictEqual((await store.listScreens(root)).items.length, 30);
    assert.strictEqual(readJson(store.screensIndexPath(root)).items.length, 30);
    const leftovers = fs.readdirSync(store.screensDir(root)).filter(n => /tmp-/.test(n));
    assert.deepStrictEqual(leftovers, []);
  });

  await t('壞檔（半截 JSON）→ 保底掃檔不 500、背景重建後恢復', async () => {
    const root = tmpRoot();
    const now = new Date().toISOString();
    const fl = { id: 'uif_9', name: 'F', description: '', device: null, steps: [], createdAt: now, updatedAt: now };
    store.writeFlow(root, 'uif_9', fl);
    fs.writeFileSync(store.flowsIndexPath(root), '{"schema":"harness.list-index/1","items":[{"id":"uif');
    const r1 = await store.listFlows(root);
    assert.strictEqual(r1.fallback, true);
    assert.deepStrictEqual(r1.items.map(x => x.id), ['uif_9']);
    await idle(root);
    const r2 = await store.listFlows(root);
    assert.strictEqual(r2.fallback, false);
    assert.deepStrictEqual(r2.items.map(x => x.id), ['uif_9']);
  });

  await t('同步讀（頭像對話脈絡用）相容新舊格式、不寫東西', async () => {
    const root = tmpRoot();
    fs.mkdirSync(store.screensDir(root), { recursive: true });
    assert.deepStrictEqual(store.readScreenIndex(root), []);
    assert.ok(!fs.existsSync(store.screensIndexPath(root)), '同步讀不應建立目錄檔');
    fs.writeFileSync(store.screensIndexPath(root), JSON.stringify([{ id: 'a' }]));
    assert.deepStrictEqual(store.readScreenIndex(root), [{ id: 'a' }]);
    fs.writeFileSync(store.screensIndexPath(root), JSON.stringify({ schema: 'harness.list-index/1', items: [{ id: 'b' }] }));
    assert.deepStrictEqual(store.readScreenIndex(root), [{ id: 'b' }]);
  });

  await t('工作區隔離：A 的新增不會出現在 B 的清單', async () => {
    const a = tmpRoot(), b = tmpRoot();
    const sc = { id: 'uis_iso', name: 'iso', device: 'd', frame: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    store.writeScreen(a, sc.id, sc); await store.upsertScreen(a, sc);
    assert.strictEqual((await store.listScreens(a)).items.length, 1);
    assert.strictEqual((await store.listScreens(b)).items.length, 0);
  });

  if (sample) {
    // 以真實資料複本驗：新舊清單相同、刪目錄重建相同
    const oldLists = JSON.parse(fs.readFileSync(path.join(path.dirname(sample), 'old-lists.json'), 'utf8'));
    const map = { components: ['listComponents', 'ui-components', store.indexPath], screens: ['listScreens', 'ui-screens', store.screensIndexPath], templates: ['listTemplates', 'ui-templates', store.templatesIndexPath], flows: ['listFlows', 'ui-flows', store.flowsIndexPath] };
    await t('樣本：四個清單新舊相同（id 集合與共同欄位）', async () => {
      const root = tmpRoot(); copyDir(path.join(sample, '.harness'), path.join(root, '.harness'));
      for (const [name, [fn]] of Object.entries(map)) {
        const nu = (await store[fn](root)).items;
        const old = oldLists[name];
        // 舊目錄漏掉的（有人不經 API 直接寫了檔、目錄沒跟著更新）新版重建會補進來——允許多出來，但舊的一筆都不能少
        const nuIds = new Set(nu.map(x => x.id));
        for (const o of old) assert.ok(nuIds.has(o.id), name + ' 少了 ' + o.id);
        const extra = nu.filter(x => !old.find(o => o.id === x.id)).map(x => x.id);
        if (extra.length) console.log('[note] ' + name + ' 比舊目錄多出 ' + extra.length + ' 筆（檔案存在、舊目錄漏登）: ' + extra.join(', '));
        const files = fs.readdirSync(({ components: store.componentsDir, screens: store.screensDir, templates: store.templatesDir, flows: store.flowsDir })[name](root)).filter(n => /.json$/.test(n) && n !== 'index.json');
        assert.strictEqual(nu.length, files.length, name + ' 清單筆數應等於實際檔案數');
        for (const o of old) {
          const n = nu.find(x => x.id === o.id);
          for (const k of Object.keys(o)) {
            if (k === 'updatedAt' && n[k] !== o[k]) { // 舊目錄的時間戳落後於實際檔案（有人不經 API 直接改檔）→ 新版以檔案為準
              assert.ok(String(n[k]) > String(o[k]), name + ' ' + o.id + ' updatedAt 應以較新的檔案為準');
              console.log('[note] ' + name + ' ' + o.id + ' updatedAt 舊目錄=' + o[k] + ' 檔案=' + n[k]);
              continue;
            }
            assert.deepStrictEqual(n[k], o[k], name + ' ' + o.id + ' 欄位 ' + k + ' 不同');
          }
        }
      }
      await idle(root);
    });
    await t('樣本：刪掉四份目錄檔 → 重建後與重建前相同', async () => {
      const root = tmpRoot(); copyDir(path.join(sample, '.harness'), path.join(root, '.harness'));
      const before = {};
      for (const [name, [fn]] of Object.entries(map)) { await store[fn](root); }
      await idle(root);
      for (const [name, [fn]] of Object.entries(map)) before[name] = (await store[fn](root)).items;
      for (const [name, [, , pf]] of Object.entries(map)) fs.rmSync(pf(root), { force: true });
      for (const [name, [, kind]] of Object.entries(map)) await store.getIdx(kind, root).rebuild({ reason: 'test' });
      for (const [name, [fn]] of Object.entries(map)) {
        const after = (await store[fn](root));
        assert.strictEqual(after.fallback, false, name + ' 重建後仍走保底');
        assert.deepStrictEqual(after.items, before[name], name + ' 重建前後不同');
      }
    });
  }

  console.log(results.join('\n'));
  console.log(`\n${pass} 通過 / ${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})();

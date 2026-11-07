// node portal/checks/documents-index.test.js [--sample <含 .documents 的工作區複本>] [--old <舊版 document-registry.js 路徑>]
// 文件管理目錄（IDX-DOC，SPEC-list-index.md §9.9）：合成資料單元測試；帶 --sample 時另跑真實複本的新舊比對＋量測。
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const dr = require('../document-registry');
const listIndex = require('../list-index');
dr.registerIndexKind();

const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + e.message); } }
const tmpWs = () => fs.mkdtempSync(path.join(os.tmpdir(), 'docidx-'));
const uuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
function mkDoc(ws, n, { withHistory = true, withFile = true } = {}) {
  const id = uuid(n), dir = path.join(ws, '.documents', id);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  if (withFile) fs.writeFileSync(path.join(dir, 'doc.md'), '---\ntype: doc\nsource: src/' + n + '.docx\n---\n' + 'x'.repeat(100 * n));
  if (withHistory && withFile) {
    fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'history', 'log.json'), '[{"rev":0}]');
  }
  return id;
}
const regOf = ws => JSON.parse(fs.readFileSync(path.join(ws, '.documents', 'index.json'), 'utf8'));

(async () => {
  console.log('documents-index 單元測試');

  await t('讀：沒有目錄檔回空；壞檔回空不丟出', () => {
    const ws = tmpWs();
    assert.deepStrictEqual(dr.readRegistry(ws), { documents: [] });
    fs.mkdirSync(path.join(ws, '.documents'));
    fs.writeFileSync(path.join(ws, '.documents', 'index.json'), '{ half');
    assert.deepStrictEqual(dr.readRegistry(ws).documents, []);
  });

  await t('寫入走暫存檔＋換名：不留 tmp、格式不變（documents／trash）', () => {
    const ws = tmpWs();
    dr.upsertDocument(ws, { id: uuid(1), sourcePath: 'a.docx', type: 'doc' });
    const names = fs.readdirSync(path.join(ws, '.documents'));
    assert.deepStrictEqual(names, ['index.json']);
    const r = regOf(ws);
    assert.strictEqual(r.documents.length, 1);
    assert.strictEqual(r.documents[0].id, uuid(1));
    assert.ok(r.documents[0].convertedAt && r.documents[0].updatedAt);
  });

  await t('快取：回傳是複本，呼叫端改動不會污染快取；外部改檔會被看到', () => {
    const ws = tmpWs();
    dr.upsertDocument(ws, { id: uuid(1), sourcePath: 'a' });
    const a = dr.readRegistry(ws); a.documents[0].sourcePath = 'HACK';
    assert.strictEqual(dr.readRegistry(ws).documents[0].sourcePath, 'a');
    const p = path.join(ws, '.documents', 'index.json');
    fs.writeFileSync(p, JSON.stringify({ documents: [{ id: uuid(9), sourcePath: 'ext-longer-name' }] }));
    assert.strictEqual(dr.readRegistry(ws).documents[0].id, uuid(9));
  });

  await t('同時 upsert 兩份＋50 份不互相覆蓋', async () => {
    const ws = tmpWs();
    await Promise.all(Array.from({ length: 50 }, (_, i) => Promise.resolve().then(() => dr.upsertDocument(ws, { id: uuid(i + 1), sourcePath: 's' + i }))));
    assert.strictEqual(regOf(ws).documents.length, 50);
    // 兩個「讀到一半被切換」的非同步呼叫端：各自 await 之後才呼叫（同步函式，不會交錯）
    const ws2 = tmpWs();
    await Promise.all([
      (async () => { await new Promise(r => setImmediate(r)); dr.upsertDocument(ws2, { id: uuid(1), sourcePath: 'A' }); })(),
      (async () => { dr.upsertDocument(ws2, { id: uuid(2), sourcePath: 'B' }); })(),
    ]);
    assert.deepStrictEqual(regOf(ws2).documents.map(d => d.id).sort(), [uuid(1), uuid(2)]);
  });

  await t('rename 被鎖（EPERM）重試後成功；一直失敗則丟出、不留 tmp、舊檔仍完整', () => {
    const ws = tmpWs();
    dr.upsertDocument(ws, { id: uuid(1), sourcePath: 'keep' });
    const real = fs.renameSync; let n = 0;
    fs.renameSync = (a, b) => { if (String(b).endsWith('index.json') && n++ < 2) { const e = new Error('locked'); e.code = 'EPERM'; throw e; } return real(a, b); };
    try { dr.upsertDocument(ws, { id: uuid(2), sourcePath: 'two' }); } finally { fs.renameSync = real; }
    assert.strictEqual(n, 3);
    assert.strictEqual(regOf(ws).documents.length, 2);
    fs.renameSync = (a, b) => { if (String(b).endsWith('index.json')) { const e = new Error('locked'); e.code = 'EBUSY'; throw e; } return real(a, b); };
    try { assert.throws(() => dr.upsertDocument(ws, { id: uuid(3), sourcePath: 'three' }), /locked/); } finally { fs.renameSync = real; }
    assert.strictEqual(regOf(ws).documents.length, 2);
    assert.deepStrictEqual(fs.readdirSync(path.join(ws, '.documents')), ['index.json']);
  });

  await t('軟刪除時存好資料夾大小；清單不再算大小', () => {
    const ws = tmpWs();
    const id = mkDoc(ws, 3);
    dr.upsertDocument(ws, { id, sourcePath: 's3' });
    const expect = dr._dirSizeBytes ? dr._dirSizeBytes(path.join(ws, '.documents', id)) : null;
    const doc = dr.softDeleteDocument(ws, id);
    assert.ok(doc.sizeBytes > 300, 'sizeBytes=' + doc.sizeBytes);
    if (expect != null) assert.strictEqual(doc.sizeBytes, expect);
    // 往資料夾丟大檔：清單仍回「移入當時」的大小（證明沒有重算）
    fs.writeFileSync(path.join(ws, '.documents', id, 'big.bin'), Buffer.alloc(5000));
    const items = dr.listRecycle(ws);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].sizeBytes, doc.sizeBytes);
    assert.strictEqual(items[0].kind, 'trash');
  });

  await t('listRecycle 不 readdir／不讀 doc.md', () => {
    const ws = tmpWs();
    const id = mkDoc(ws, 1);
    dr.upsertDocument(ws, { id, sourcePath: 's' });
    dr.softDeleteDocument(ws, id);
    const rd = fs.readdirSync, rf = fs.readFileSync;
    let calls = 0;
    fs.readdirSync = (...a) => { calls++; return rd(...a); };
    fs.readFileSync = (...a) => { if (!String(a[0]).endsWith('index.json')) calls++; return rf(...a); };
    try { dr.listRecycle(ws); } finally { fs.readdirSync = rd; fs.readFileSync = rf; }
    assert.strictEqual(calls, 0);
  });

  await t('還原：回到清單、去掉 deletedAt／sizeBytes；徹底刪除會 rm 資料夾', () => {
    const ws = tmpWs();
    const id = mkDoc(ws, 2); dr.upsertDocument(ws, { id, sourcePath: 's' });
    dr.softDeleteDocument(ws, id);
    const back = dr.restoreDocument(ws, id);
    assert.ok(!back.deletedAt && back.sizeBytes === undefined);
    assert.strictEqual(regOf(ws).documents.length, 1);
    dr.softDeleteDocument(ws, id);
    dr.purgeDocument(ws, id);
    assert.ok(!fs.existsSync(path.join(ws, '.documents', id)));
    assert.strictEqual(dr.listRecycle(ws).length, 0);
  });

  await t('重建：孤兒資料夾被掃出（含來源檔名／大小）、列在回收桶；purge 孤兒可移除', async () => {
    const ws = tmpWs();
    const a = mkDoc(ws, 1); dr.upsertDocument(ws, { id: a, sourcePath: 'a' });
    const o = mkDoc(ws, 7);   // 孤兒：有資料夾沒登記
    fs.mkdirSync(path.join(ws, '.documents', '.templates'));   // 非 UUID 目錄要被忽略
    fs.mkdirSync(path.join(ws, '.documents', 'not-a-uuid'));
    assert.strictEqual(dr.listRecycle(ws).length, 0, '重建前清單不掃孤兒');
    const r = await dr.rebuildDocuments(ws);
    assert.strictEqual(r.orphans, 1);
    const items = dr.listRecycle(ws);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].id, o); assert.strictEqual(items[0].kind, 'orphan');
    assert.strictEqual(items[0].sourcePath, 'src/7.docx'); assert.ok(items[0].sizeBytes > 700);
    dr.purgeDocument(ws, o);
    assert.strictEqual(dr.listRecycle(ws).length, 0);
    assert.ok(!fs.existsSync(path.join(ws, '.documents', o)));
  });

  await t('重建：舊回收桶項目（沒大小）補算；歷史回填；登記但資料夾不見只回報不刪', async () => {
    const ws = tmpWs();
    const a = mkDoc(ws, 1, { withHistory: false });          // 沒歷史 → 回填
    const b = mkDoc(ws, 2); const c = uuid(3);                // c 登記了但沒資料夾
    fs.mkdirSync(path.join(ws, '.documents'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.documents', 'index.json'), JSON.stringify({
      documents: [{ id: a, sourcePath: 'a' }, { id: b, sourcePath: 'b', origin: 'imported' }, { id: c, sourcePath: 'c', origin: 'imported' }],
      trash: [{ id: uuid(4), sourcePath: 'old', deletedAt: '2026-01-01T00:00:00Z' }],
    }));
    mkDoc(ws, 4);
    const r = await dr.rebuildDocuments(ws);
    assert.strictEqual(r.backfilled, 1); assert.strictEqual(r.sizesFilled, 1); assert.strictEqual(r.missing, 1);
    const reg = regOf(ws);
    assert.strictEqual(reg.documents.length, 3, '不刪登記');
    assert.ok(reg.documents.find(d => d.id === a).origin === 'imported');
    assert.ok(fs.existsSync(path.join(ws, '.documents', a, 'history', 'log.json')));
    assert.ok(reg.trash[0].sizeBytes > 400);
    const r2 = await dr.rebuildDocuments(ws);          // 冪等
    assert.strictEqual(r2.backfilled, 0); assert.strictEqual(r2.sizesFilled, 0);
  });

  await t('重建期間插進來的 upsert 不會被蓋掉', async () => {
    const ws = tmpWs();
    for (let i = 1; i <= 120; i++) { mkDoc(ws, i); dr.upsertDocument(ws, { id: uuid(i), sourcePath: 's' + i, origin: 'imported' }); }
    mkDoc(ws, 500);   // 孤兒，讓重建有事做
    const p = dr.rebuildDocuments(ws);
    await new Promise(r => setImmediate(r));
    dr.upsertDocument(ws, { id: uuid(121), sourcePath: 'late' });
    await p;
    assert.ok(regOf(ws).documents.some(d => d.id === uuid(121)), '重建期間新增的文件應還在');
    assert.strictEqual(regOf(ws).documents.length, 121);
  });

  await t('kind documents：verify 對得上＝不重建；多一個孤兒資料夾＝重建；status/rebuild 走 listIndex', async () => {
    const ws = tmpWs();
    const a = mkDoc(ws, 1); dr.upsertDocument(ws, { id: a, sourcePath: 'a', origin: 'imported' });
    const h = listIndex.getIndex('documents', ws);
    assert.ok(h);
    assert.strictEqual((await h.verify()).rebuilt, false);
    mkDoc(ws, 9);
    const v = await h.verify();
    assert.strictEqual(v.rebuilt, true);
    assert.strictEqual(dr.listRecycle(ws).length, 1);
    assert.strictEqual((await h.verify()).rebuilt, false, '重建後再核對應對得上');
    const st = await h.status();
    assert.strictEqual(st.kind, 'documents'); assert.strictEqual(st.count, 1); assert.strictEqual(st.orphans, 1);
    const acc = listIndex.rebuildWorkspace(ws, 'documents');
    assert.deepStrictEqual(acc.accepted, ['documents']);
    assert.strictEqual(listIndex.getIndex('documents', tmpWs()), null, '沒有 .documents 的工作區 → null');
  });

  const sample = arg('--sample');
  if (sample) {
    const oldPath = arg('--old') || path.join(__dirname, '..', '..', '_tmp', 'idx', 'document-registry.old.js');
    const old = require(oldPath);
    console.log('\n真實複本：' + sample);
    const ms = fn => { const t0 = process.hrtime.bigint(); const v = fn(); return [v, Number(process.hrtime.bigint() - t0) / 1e6]; };
    const med = (fn, n = 5) => { const a = []; for (let i = 0; i < n; i++) a.push(ms(fn)[1]); a.sort((x, y) => x - y); return a[Math.floor(n / 2)]; };
    // 舊版先跑（它的回填只在有缺歷史的文件時才寫檔），新版再跑同一份複本；兩者看到的資料相同。
    const oldWs = sample, newWs = sample;

    const oldList = () => { old.backfillDocHistory(oldWs); return old.readRegistry(oldWs).documents; };
    const newList = () => dr.readRegistry(newWs).documents;
    const oldRecycle = () => old.listRecycle(oldWs);
    const newRecycle = () => dr.listRecycle(newWs);

    const [ol, olMs] = ms(oldList); const olMed = med(oldList);
    const [orc0, orMs] = ms(oldRecycle); const orMed = med(oldRecycle);
    console.log(`  舊 清單(含每次回填) 首次 ${olMs.toFixed(1)} ms／中位數 ${olMed.toFixed(1)} ms，${ol.length} 份`);
    console.log(`  舊 回收桶 首次 ${orMs.toFixed(1)} ms／中位數 ${orMed.toFixed(1)} ms，${orc0.length} 項`);

    // 新版：先做一次「開機核對／重建」（背景一次性成本），再量清單與回收桶
    const t0 = Date.now(); const rb = await dr.rebuildDocuments(newWs); const rbMs = Date.now() - t0;
    console.log(`  新 重建目錄（一次性、背景）${rbMs} ms：`, JSON.stringify(rb));
    const [nl, nlMs] = ms(newList); const nlMed = med(newList);
    const [nrc, nrMs] = ms(newRecycle); const nrMed = med(newRecycle);
    console.log(`  新 清單 首次 ${nlMs.toFixed(3)} ms／中位數 ${nlMed.toFixed(3)} ms，${nl.length} 份`);
    console.log(`  新 回收桶 首次 ${nrMs.toFixed(3)} ms／中位數 ${nrMed.toFixed(3)} ms，${nrc.length} 項`);

    await t('清單內容與舊版相同（回填欄位以外逐欄位比對）', () => {
      assert.strictEqual(nl.length, ol.length);
      const om = new Map(ol.map(d => [d.id, d]));
      for (const d of nl) { const o = om.get(d.id); assert.ok(o, d.id); for (const k of Object.keys(o)) assert.deepStrictEqual(d[k], o[k], d.id + '.' + k); }
    });
    await t('回收桶內容與舊版相同（id／kind／sourcePath／bornAt／deletedAt／sizeBytes）', () => {
      const f = a => a.map(x => [x.id, x.kind, x.sourcePath, x.bornAt, x.deletedAt, x.sizeBytes].join('|')).sort();
      assert.deepStrictEqual(f(nrc), f(orc0));
    });
    await t('清單 < 50 ms、回收桶 < 100 ms（驗收）', () => { assert.ok(nlMs < 50, String(nlMs)); assert.ok(nrMs < 100, String(nrMs)); });
  }

  console.log(`\n${pass} 通過，${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})();

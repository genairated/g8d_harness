// chat-index.test.js — IDX-CHAT 單元測試。node portal/checks/chat-index.test.js [--real]
// 合成資料全程在暫存目錄；--real 另用 _tmp/idx/chat-sample/ws（客戶專案對話資料夾複本）與「改前」的舊函式（取自 git HEAD）逐筆比對。
// 不起 server、不碰真實工作區。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const assert = require('assert');
const listIndex = require('../list-index');
const ci = require('../chat-index');

let pass = 0, fail = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass++; results.push('PASS ' + name); }
  catch (e) { fail++; results.push('FAIL ' + name + ' — ' + (e && e.stack || e)); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 等目錄寫入完成：status().pendingWrites 不含「已取出、寫入中」的批次，所以改成輪詢到筆數符合（或逾時）。
async function waitIdle(h, n) { for (let i = 0; i < 300; i++) { const s = await h.status(); if (!s.rebuilding && !s.pendingWrites && (n == null || s.count === n)) { await sleep(20); return; } await sleep(10); } }

function mkWs() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'chatidx-'));
  const dir = path.join(ws, '.harness', 'runtime', 'chat_history');
  fs.mkdirSync(dir, { recursive: true });
  return { ws, dir };
}
function put(dir, id, extra = {}) {
  const d = Object.assign({ sessionId: id, updatedAt: '2026-11-01T00:00:00.000Z', messages: [{ role: 'user', content: 'hello ' + id }, { role: 'assistant', content: 'hi' }], trace: [] }, extra);
  fs.writeFileSync(path.join(dir, `chat_${id}.json`), JSON.stringify(d, null, 2));
  return d;
}

(async () => {
  ci.register();

  await t('entryFromData：不含訊息本文，只留清單欄位；origin 回推', () => {
    const e = ci.entryFromData({ sessionId: 'sched_run_1', updatedAt: 'x', messages: [{ role: 'user', content: 'A'.repeat(100) }, { role: 'assistant', content: 'B'.repeat(200) }] });
    assert.strictEqual(e.origin, 'schedule');
    assert.strictEqual(e.firstUser.length, 31);
    assert.strictEqual(e.lastText.length, 60);
    assert.strictEqual(e.msgCount, 2);
    assert.ok(!('messages' in e));
  });

  await t('重建：略過 0 位元組與壞檔、不刪檔、記在 skipped', async () => {
    const { ws, dir } = mkWs();
    put(dir, 'a'); put(dir, 'b');
    fs.writeFileSync(path.join(dir, 'chat_empty.json'), '');
    fs.writeFileSync(path.join(dir, 'chat_bad.json'), '{"sessionId":"bad","messa');
    const h = ci.handleFor(dir);
    const r = await h.rebuild({ reason: 'test' });
    assert.ok(r.ok); assert.strictEqual(r.count, 2);
    assert.ok(fs.existsSync(path.join(dir, 'chat_empty.json')) && fs.existsSync(path.join(dir, 'chat_bad.json')), '壞檔不可被刪');
    const sk = ci.skippedFor(ws);
    assert.strictEqual(sk.length, 2);
  });

  await t('upsert／remove 同步；三支清單過濾與改前規則一致', async () => {
    const { ws, dir } = mkWs();
    const h = ci.handleFor(dir);
    await h.rebuild({ reason: 'init' });
    const mk = (id, extra) => { const d = put(dir, id, extra); ci.syncUpsert(dir, d, id); };
    mk('h1', { updatedAt: '2026-11-02T00:00:00.000Z', title: '自訂' });
    mk('h2', { updatedAt: '2026-11-03T00:00:00.000Z' });
    mk('sched_x', { origin: 'schedule' });
    mk('tg1', { origin: 'telegram', updatedAt: '2026-11-04T00:00:00.000Z' });
    mk('f1', { filePath: 'docs/a.md' });
    mk('c1', { contextKind: 'schedule', contextKey: 'schedule:abc', contextLabel: '排程 abc' });
    mk('m1', { meetingId: 'mt1' });
    mk('p1', { pmProjectIds: ['p'] });
    await waitIdle(h, 8);
    const { items, fallback } = await ci.listAll(dir);
    assert.strictEqual(fallback, false);
    assert.strictEqual(items.length, 8);
    const hist = ci.toHistoryList(items);
    assert.deepStrictEqual(hist.map(x => x.sessionId), ['h2', 'h1']);       // telegram 來源不列在網頁清單
    assert.strictEqual(hist[1].title, '自訂');
    assert.strictEqual(hist[0].title, 'hello h2');
    const tg = ci.toTelegramList(items, dir);
    assert.deepStrictEqual(tg.map(x => x.sessionId), ['tg1', 'h2', 'h1']);  // telegram 保留、schedule 排除
    assert.strictEqual(tg[0].messages.length, 2);                           // 懶讀
    assert.deepStrictEqual(ci.toSessionsByFile(items, 'docs/a.md').map(x => x.sessionId), ['f1']);
    assert.deepStrictEqual(ci.toSessionsByCtx(items, 'schedule:abc')[0], { sessionId: 'c1', title: 'hello c1', updatedAt: '2026-11-01T00:00:00.000Z', contextLabel: '排程 abc' });
    // 改標題、刪除
    const d = JSON.parse(fs.readFileSync(path.join(dir, 'chat_h2.json'), 'utf8')); d.title = '新標題';
    fs.writeFileSync(path.join(dir, 'chat_h2.json'), JSON.stringify(d)); ci.syncUpsert(dir, d, 'h2');
    fs.unlinkSync(path.join(dir, 'chat_h1.json')); ci.syncRemove(dir, 'h1');
    await waitIdle(h, 7);
    const hist2 = ci.toHistoryList((await ci.listAll(dir)).items);
    assert.deepStrictEqual(hist2, [{ sessionId: 'h2', title: '新標題', updatedAt: '2026-11-03T00:00:00.000Z' }]);
  });

  await t('刪掉目錄檔 → 走保底（fallback）且自動重建；重建後筆數＝實際檔案數', async () => {
    const { ws, dir } = mkWs();
    for (let i = 0; i < 7; i++) put(dir, 's' + i);
    const h = ci.handleFor(dir);
    const r1 = await ci.listAll(dir);                 // 目錄尚不存在
    assert.strictEqual(r1.fallback, true); assert.strictEqual(r1.items.length, 7);
    await waitIdle(h); await sleep(50); await waitIdle(h);
    const r2 = await ci.listAll(dir);
    assert.strictEqual(r2.fallback, false); assert.strictEqual(r2.items.length, 7);
  });

  await t('資料夾多一個檔（外部寫入）→ 開機核對發現並重建', async () => {
    const { ws, dir } = mkWs();
    put(dir, 'a');
    const h = ci.handleFor(dir);
    await h.rebuild({ reason: 'init' });
    put(dir, 'b');                                     // 直接寫檔，沒走 syncUpsert
    const v = await h.verify();
    assert.ok(v.rebuilt, '指紋不同要重建');
    assert.strictEqual((await ci.listAll(dir)).items.length, 2);
  });

  await t('同時 40 次 upsert 不遺失', async () => {
    const { ws, dir } = mkWs();
    const h = ci.handleFor(dir);
    await h.rebuild({ reason: 'init' });
    for (let i = 0; i < 40; i++) { const d = put(dir, 'n' + i); ci.syncUpsert(dir, d, 'n' + i); }
    await waitIdle(h, 40);
    assert.strictEqual((await ci.listAll(dir)).items.length, 40);
  });

  await t('原子寫入：不留暫存檔、內容正確；rename 一直失敗時丟出並清掉暫存', () => {
    const { dir } = mkWs();
    const f = path.join(dir, 'chat_z.json');
    ci.writeFileAtomicSync(f, '{"a":1}');
    assert.strictEqual(fs.readFileSync(f, 'utf8'), '{"a":1}');
    assert.deepStrictEqual(fs.readdirSync(dir).filter(x => x.includes('.tmp-')), []);
    ci.writeFileAtomicSync(f, '{"a":2}');
    assert.strictEqual(fs.readFileSync(f, 'utf8'), '{"a":2}');
    const orig = fs.renameSync; let n = 0;
    fs.renameSync = () => { n++; const e = new Error('locked'); e.code = 'EPERM'; throw e; };
    try { assert.throws(() => ci.writeFileAtomicSync(f, '{"a":3}'), /locked/); } finally { fs.renameSync = orig; }
    assert.strictEqual(n, 6);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), '{"a":2}', '舊檔完整');
    assert.deepStrictEqual(fs.readdirSync(dir).filter(x => x.includes('.tmp-')), []);
  });

  await t('非標準位置的資料夾：不走目錄，直接掃（fallback）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatidx-odd-'));
    put(dir, 'q');
    ci.syncUpsert(dir, put(dir, 'r'), 'r');            // 不丟出
    const r = await ci.listAll(dir);
    assert.strictEqual(r.fallback, true); assert.strictEqual(r.items.length, 2);
  });

  // ── 真實樣本：與改前舊函式（git HEAD 的 server.js）逐筆比對 ──
  if (process.argv.includes('--real')) {
    const repo = path.resolve(__dirname, '..', '..');
    const ws = path.join(repo, '_tmp', 'idx', 'chat-sample', 'ws');
    const dir = path.join(ws, '.harness', 'runtime', 'chat_history');
    const src = execSync('git show HEAD:portal/server.js', { cwd: repo, maxBuffer: 1 << 29 }).toString('utf8');
    const grab = (start, end) => { const a = src.indexOf(start), b = src.indexOf(end, a); if (a < 0 || b < 0) throw new Error('grab ' + start); return src.slice(a, b); };
    const oldHist = new Function('fs', 'path', 'CHAT_HISTORY_DIR', grab('function getChatHistories(', '// --- Gemini MCP') + '; return getChatHistories;')(fs, path, dir);
    const oldTg = new Function('fs', 'path', 'HARNESS_HOME', grab('function _tgListChatSessions(', '// TGC8-04: /newchat') + '; return _tgListChatSessions;')(fs, path, ws);
    // 舊的 /api/chat-sessions 迴圈（原文逐字搬出，只把 target/ctxKey 參數化）
    const oldSess = (kind, want) => {
      const out = [];
      for (const file of fs.readdirSync(dir)) {
        if (!file.startsWith('chat_') || !file.endsWith('.json')) continue;
        try {
          const d = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
          const hit = kind === 'file' ? (d.filePath && d.filePath === want) : (d.contextKey && d.contextKey === want);
          if (hit) {
            let title = d.title;
            if (!title) { const fm = (d.messages || []).find(m => m.role === 'user' && typeof m.content === 'string'); title = fm ? fm.content.slice(0, 30) : '無主題對話'; }
            out.push(kind === 'file' ? { sessionId: d.sessionId, title, updatedAt: d.updatedAt, filePath: d.filePath } : { sessionId: d.sessionId, title, updatedAt: d.updatedAt, contextLabel: d.contextLabel || null });
          }
        } catch (e) {}
      }
      out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      return out;
    };
    const time = async (fn) => { const t0 = process.hrtime.bigint(); const r = await fn(); return [r, Number(process.hrtime.bigint() - t0) / 1e6]; };

    const [oh, tOldHist] = await time(() => oldHist(dir));
    const [ot, tOldTg] = await time(() => oldTg(ws));
    const files = fs.readdirSync(dir).filter(f => f.startsWith('chat_') && f.endsWith('.json'));
    const fileKeys = new Set(), ctxKeys = new Set();
    for (const f of files) { try { const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (d.filePath) fileKeys.add(d.filePath); if (d.contextKey) ctxKeys.add(d.contextKey); } catch (e) {} }
    const oldSessAll = {}; const [, tOldSess] = await time(() => { for (const k of fileKeys) oldSessAll['f:' + k] = oldSess('file', k); for (const k of ctxKeys) oldSessAll['c:' + k] = oldSess('ctx', k); });

    const h = ci.handleFor(dir);
    try { fs.rmSync(path.join(ws, '.harness', 'index'), { recursive: true, force: true }); } catch (e) {}
    const tR0 = Date.now(); const rr = await h.rebuild({ reason: 'real-test' }); const tRebuild = Date.now() - tR0;
    await t('真實樣本：重建成功，筆數＝可解析的對話檔數', () => { assert.ok(rr.ok); assert.strictEqual(rr.count + ci.skippedFor(ws).length, files.length); });
    await listIndex.getIndex('chat', ws).list();   // 暖
    const [r1, tNewHist] = await time(async () => ci.toHistoryList((await ci.listAll(dir)).items));
    const [r2] = await time(async () => ci.toHistoryList((await ci.listAll(dir)).items));
    const tNewHist2 = (await time(async () => ci.toHistoryList((await ci.listAll(dir)).items)))[1];
    const [nt, tNewTg] = await time(async () => ci.toTelegramList((await ci.listAll(dir)).items, dir));
    const newSessAll = {}; const [, tNewSess] = await time(async () => { const items = (await ci.listAll(dir)).items; for (const k of fileKeys) newSessAll['f:' + k] = ci.sortSessions(ci.toSessionsByFile(items, k)); for (const k of ctxKeys) newSessAll['c:' + k] = ci.sortSessions(ci.toSessionsByCtx(items, k)); });

    await t(`真實樣本：/api/chat/history 新舊逐筆相同（${oh.length} 筆）`, () => { assert.deepStrictEqual(r1, oh); assert.deepStrictEqual(r2, oh); });
    await t(`真實樣本：Telegram 清單新舊相同（${ot.length} 筆，含 messages 逐筆）`, () => {
      assert.strictEqual(nt.length, ot.length);
      for (let i = 0; i < ot.length; i++) {
        assert.strictEqual(nt[i].sessionId, ot[i].sessionId); assert.strictEqual(nt[i].title, ot[i].title); assert.strictEqual(nt[i].updatedAt, ot[i].updatedAt);
        assert.deepStrictEqual(nt[i].messages, ot[i].messages);
      }
    });
    await t(`真實樣本：/api/chat-sessions filePath(${fileKeys.size} 個)／ctxKey(${ctxKeys.size} 個) 查詢新舊相同`, () => { assert.deepStrictEqual(newSessAll, oldSessAll); });
    await t('真實樣本：刪掉目錄重開 → 自動重建後筆數一致', async () => {
      fs.rmSync(path.join(ws, '.harness', 'index'), { recursive: true, force: true });
      const v = await h.verify(); assert.ok(v.rebuilt);
      assert.strictEqual((await ci.listAll(dir)).items.length, rr.count);
    });
    const idxSize = fs.statSync(path.join(ws, '.harness', 'index', 'chat.json')).size;
    results.push('');
    results.push('量測（ms，同一份樣本、本機、無其他負載）：');
    results.push(`  /api/chat/history   改前(逐檔同步讀) ${tOldHist.toFixed(0)}  →  改後 第一次(暖機後) ${tNewHist.toFixed(1)}、之後 ${tNewHist2.toFixed(1)}`);
    results.push(`  Telegram 清單        改前 ${tOldTg.toFixed(0)}  →  改後 ${tNewTg.toFixed(1)}（messages 懶讀，用到才開檔）`);
    results.push(`  /api/chat-sessions  改前 ${tOldSess.toFixed(0)}（共 ${fileKeys.size + ctxKeys.size} 次查詢）  →  改後 ${tNewSess.toFixed(1)}（同樣 ${fileKeys.size + ctxKeys.size} 次）`);
    results.push(`  一次性重建 ${tRebuild} ms（背景、每 50 筆讓出）；目錄檔 ${(idxSize / 1024).toFixed(0)} KB；略過壞檔 ${ci.skippedFor(ws).length} 個`);
  }

  console.log(results.join('\n'));
  console.log(`\n${pass}/${pass + fail} 通過`);
  process.exit(fail ? 1 : 0);
})();

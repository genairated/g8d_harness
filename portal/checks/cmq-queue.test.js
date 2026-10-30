'use strict';
// CMQ-P1 自測（SPEC-chat-concurrent-messages.md §9 AC1~AC5、AC7 + 重開對話對得上）。
// 不起 server：佇列用 chat-queue.js 注入假 start/abort/classify；落檔那段從 server.js「原樣取出」
// 真正的 withChatSessionLock / saveChatSessionMerged / saveChatSession 在隔離暫存目錄跑。
// 執行：node portal/checks/cmq-queue.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const Q = require('../chat-queue');

let pass = 0, fail = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass++; results.push('PASS ' + name); }
  catch (e) { fail++; results.push('FAIL ' + name + '\n     ' + (e && e.stack || e)); }
}

// ── 工具：造一個帶假依賴的佇列 ──
function mk(classifyImpl, opts) {
  const log = { started: [], aborted: [], cancelled: [], events: [] };
  const q = Q.createChatQueue(Object.assign({
    classify: classifyImpl,
    start: (e) => log.started.push(e.questionNo),
    abort: (e, why) => log.aborted.push([e.questionNo, why]),
    cancelQueued: (e) => log.cancelled.push(e.questionNo),
    onChange: (e, r) => log.events.push([r, e.questionNo, e.ws]),
    classifyTimeoutMs: (opts && opts.timeout) || 300,
  }, opts && opts.deps));
  return { q, log };
}
const WS = 'D:\\proj\\A';
const ent = (no, text, extra) => Object.assign({ jobId: 'j' + no, ws: WS, sessionId: 's1', questionNo: no, text, ctx: {} }, extra || {});
const RO = JSON.stringify({ relation: 'independent', readOnly: true, prevReadOnly: true });
const flush = () => new Promise(r => setTimeout(r, 20));

(async () => {
  // ── 純函式 ──
  await t('parseClassification：壞格式一律 unknown＋非唯讀', () => {
    for (const bad of [null, '', 'hello', '{not json', '{"relation":"merge"}', '[]', '{"relation":42}']) {
      const r = Q.parseClassification(bad);
      assert.strictEqual(r.relation, 'unknown', String(bad)); assert.strictEqual(r.readOnly, false); assert.strictEqual(r.ok, false);
    }
    const g = Q.parseClassification('好的：{"relation":"continue","readOnly":true,"prevReadOnly":false} 謝謝');
    assert.deepStrictEqual([g.relation, g.readOnly, g.prevReadOnly, g.ok], ['continue', true, false, true]);
    assert.strictEqual(Q.parseClassification('{"relation":"independent","readOnly":"yes"}').readOnly, false, 'readOnly 必須嚴格 true');
  });
  await t('parseDirective：明確指示才認，其餘 null', () => {
    assert.strictEqual(Q.parseDirective('上一個先停，改做這個'), 'stop-prev');
    assert.strictEqual(Q.parseDirective('這個先停'), 'stop-prev');
    assert.strictEqual(Q.parseDirective('這兩件同時做'), 'parallel');
    assert.strictEqual(Q.parseDirective('等上一個做完再處理這個'), 'wait');
    assert.strictEqual(Q.parseDirective('幫我查一下天氣'), null);
    assert.strictEqual(Q.parseDirective('我先停一下喝咖啡'), null, '不該誤認');
  });
  await t('insertReplyOrdered：依提問順序、不插隊、不丟訊息', () => {
    const base = [{ role: 'user', questionNo: 1 }, { role: 'user', questionNo: 2 }];
    let m = Q.insertReplyOrdered(base, { role: 'assistant', replyTo: 2, content: 'a2' });
    m = Q.insertReplyOrdered(m, { role: 'assistant', replyTo: 1, content: 'a1' });
    assert.deepStrictEqual(m.map(x => x.content || x.questionNo), [1, 2, 'a1', 'a2']);
    assert.strictEqual(m.length, 4);
    const m2 = Q.insertReplyOrdered(base, { role: 'assistant', content: 'plain' });
    assert.strictEqual(m2[m2.length - 1].content, 'plain');
  });

  // ── AC1 ──
  await t('AC1 兩則獨立唯讀 → 同時處理（並行）', async () => {
    const { q, log } = mk(async () => RO);
    q.submit(ent(1, '查A是什麼')); await flush();
    q.submit(ent(2, '查B是什麼')); await flush();
    assert.deepStrictEqual(log.started, [1, 2]);
    const l = q.list(WS, 's1'); assert.deepStrictEqual(l.map(x => [x.status, x.mode]), [['running', 'solo'], ['running', 'parallel']]);
    assert.strictEqual(log.aborted.length, 0);
  });
  await t('AC1 回覆標示：quoteHeader 含第 N 問與原提問', () => {
    const h = Q.quoteHeader(2, '查B是什麼'); assert.ok(h.includes('第 2 問') && h.includes('查B是什麼'));
    assert.ok(Q.quoteHeader(3, 'x', 2).includes('第 2 句'));
  });

  // ── AC2 ──
  await t('AC2 可能寫檔 → 第二則排隊，第一則完成後自動接續', async () => {
    const { q, log } = mk(async () => JSON.stringify({ relation: 'independent', readOnly: false, prevReadOnly: false }));
    const e1 = ent(1, '改A檔'), e2 = ent(2, '改B檔');
    q.submit(e1); await flush(); q.submit(e2); await flush();
    assert.deepStrictEqual(log.started, [1]); assert.strictEqual(e2.status, 'queued');
    q.finish(e1, 'done'); await flush();
    assert.deepStrictEqual(log.started, [1, 2]); assert.strictEqual(e2.status, 'running');
  });
  await t('AC2 對方是唯讀但自己會寫 → 也排隊（寫檔工作一律不並行）', async () => {
    const { q, log } = mk(async () => JSON.stringify({ relation: 'independent', readOnly: false, prevReadOnly: true }));
    q.submit(ent(1, '查')); await flush(); q.submit(ent(2, '改檔')); await flush();
    assert.deepStrictEqual(log.started, [1]);
  });
  await t('AC2 第一則沒被判斷過（solo 開跑）、新的唯讀 → 仍須雙方唯讀才並行', async () => {
    const { q, log } = mk(async () => JSON.stringify({ relation: 'independent', readOnly: true, prevReadOnly: false }));
    q.submit(ent(1, '做事')); await flush(); q.submit(ent(2, '查')); await flush();
    assert.deepStrictEqual(log.started, [1], '前一個可能寫檔 → 不並行');
  });

  // ── AC3 ──
  await t('AC3 明確補充 → 中止前一個、前一個真正結束後以合併需求重做', async () => {
    const { q, log } = mk(async () => JSON.stringify({ relation: 'continue', readOnly: false, prevReadOnly: false }));
    const e1 = ent(1, '幫我做報表'), e2 = ent(2, '報表要加上月份欄位');
    q.submit(e1); await flush(); q.submit(e2); await flush();
    assert.deepStrictEqual(log.aborted, [[1, 'superseded']]);
    assert.ok(e1.superseded && e1.supersededBy === 2);
    assert.deepStrictEqual(log.started, [1], '前一個還沒真正結束，合併者不可先開跑（避免同時改檔）');
    assert.strictEqual(e2.mergedFrom, 1); assert.ok(e2.text.includes('幫我做報表') && e2.text.includes('月份欄位'));
    assert.strictEqual(e2.mode, 'merged');
    q.finish(e1, 'aborted'); await flush();
    assert.deepStrictEqual(log.started, [1, 2]);
  });
  await t('AC3 前一個還在排隊（沒開跑）→ 直接取消它、合併者接位，不中止任何執行中工作', async () => {
    let n = 0;
    const { q, log } = mk(async () => (++n === 1
      ? JSON.stringify({ relation: 'dependent', readOnly: false, prevReadOnly: false })
      : JSON.stringify({ relation: 'continue', readOnly: false, prevReadOnly: false })));
    const e1 = ent(1, '任務一'), e2 = ent(2, '任務二'), e3 = ent(3, '任務二補一句');
    q.submit(e1); await flush(); q.submit(e2); await flush(); q.submit(e3); await flush();
    assert.deepStrictEqual(log.cancelled, [2]); assert.strictEqual(log.aborted.length, 0);
    assert.strictEqual(e3.mergedFrom, 2); assert.strictEqual(e3.status, 'queued');
    q.finish(e1, 'done'); await flush();
    assert.deepStrictEqual(log.started, [1, 3]);
  });
  await t('AC3 斜線指令等不可合併者 → 即使判成 continue 也只排隊', async () => {
    const { q, log } = mk(async () => JSON.stringify({ relation: 'continue', readOnly: false, prevReadOnly: false }));
    q.submit(ent(1, '/task X', { mergeable: false })); await flush(); q.submit(ent(2, '補充')); await flush();
    assert.strictEqual(log.aborted.length, 0); assert.deepStrictEqual(log.started, [1]);
  });

  // ── AC4 ──
  await t('AC4 判斷失敗／逾時／亂回／unknown → 一律排隊，絕不中斷', async () => {
    const cases = {
      throws: async () => { throw new Error('boom'); },
      garbage: async () => '⚠️ 回應失敗：spawn ENOENT',
      timeout: () => new Promise(() => {}),
      unknown: async () => JSON.stringify({ relation: 'unknown', readOnly: true, prevReadOnly: true }),
      badRelation: async () => JSON.stringify({ relation: 'merge-it', readOnly: true }),
    };
    for (const [name, fn] of Object.entries(cases)) {
      const { q, log } = mk(fn, { timeout: 80 });
      const e1 = ent(1, 'a'), e2 = ent(2, 'b');
      q.submit(e1); await flush(); q.submit(e2); await new Promise(r => setTimeout(r, 200));
      assert.strictEqual(log.aborted.length, 0, name + ' 不可中斷');
      assert.deepStrictEqual(log.started, [1], name + ' 第二則應排隊'); assert.strictEqual(e2.status, 'queued', name);
    }
  });
  await t('AC4 指揮官明確指示優先：先停／同時做／等上一個', async () => {
    const boom = async () => { throw new Error('指示明確時不該呼叫模型'); };
    { const { q, log } = mk(boom); const e1 = ent(1, '做A'), e2 = ent(2, '上一個先停，改做這個');
      q.submit(e1); await flush(); q.submit(e2); await flush();
      assert.deepStrictEqual(log.aborted, [[1, 'directive']]); assert.deepStrictEqual(log.started, [1]);
      q.finish(e1, 'aborted'); await flush(); assert.deepStrictEqual(log.started, [1, 2]); }
    { const { q, log } = mk(boom); q.submit(ent(1, '做A')); await flush(); q.submit(ent(2, '這個同時做')); await flush();
      assert.deepStrictEqual(log.started, [1, 2]); }
    { const { q, log } = mk(boom); q.submit(ent(1, '做A')); await flush(); q.submit(ent(2, '等上一個做完再做這個')); await flush();
      assert.deepStrictEqual(log.started, [1]); assert.strictEqual(log.aborted.length, 0); }
  });
  await t('同一對話的判斷依序進行（連送三則不會互相踩）', async () => {
    const order = [];
    const { q, log } = mk(async ({ newText }) => { order.push('s:' + newText); await new Promise(r => setTimeout(r, 30)); order.push('e:' + newText); return RO; });
    q.submit(ent(1, 'A')); q.submit(ent(2, 'B')); q.submit(ent(3, 'C')); await new Promise(r => setTimeout(r, 300));
    assert.deepStrictEqual(order, ['s:B', 'e:B', 's:C', 'e:C']);
    assert.deepStrictEqual(log.started.sort(), [1, 2, 3]);
  });
  await t('start 丟例外 → 該則標記 aborted，後面的照樣接續', async () => {
    let n = 0;
    const { q, log } = mk(async () => JSON.stringify({ relation: 'dependent' }), { deps: { start: (e) => { log0.push(e.questionNo); if (++n === 2) throw new Error('x'); } } });
    const log0 = [];
    const e1 = ent(1, 'a'), e2 = ent(2, 'b'), e3 = ent(3, 'c');
    q.submit(e1); await flush(); q.submit(e2); await flush(); q.submit(e3); await flush();
    q.finish(e1, 'done'); await flush();
    assert.strictEqual(e2.status, 'aborted'); assert.strictEqual(e3.status, 'running'); assert.deepStrictEqual(log0, [1, 2, 3]);
  });

  // ── AC7 ──
  await t('AC7 工作區隔離：別的工作區看不到佇列／事件帶自己的工作區', async () => {
    const { q, log } = mk(async () => RO);
    q.submit(ent(1, '查A')); await flush();
    q.submit({ jobId: 'jB', ws: 'D:\\proj\\B', sessionId: 's1', questionNo: 1, text: 'B的事', ctx: {} }); await flush();
    assert.strictEqual(q.list('D:\\proj\\A', 's1').length, 1);
    assert.strictEqual(q.list('D:\\proj\\B', 's1').length, 1);
    assert.strictEqual(q.list('D:\\proj\\C').length, 0);
    assert.strictEqual(q.list('d:/PROJ/a/', 's1').length, 1, '大小寫與斜線正規化');
    assert.ok(q.list('D:\\proj\\A')[0].preview === '查A');
    // 同 sessionId 不同工作區互不干擾：B 的第一則是 solo，不會被 A 的當成「前一個」
    assert.strictEqual(q.list('D:\\proj\\B')[0].mode, 'solo');
    assert.ok(log.events.every(([, , ws]) => ws === 'D:\\proj\\A' || ws === 'D:\\proj\\B'));
  });

  // ── AC5 / AC6：真正的鎖＋合併落檔（原樣取自 server.js）──
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  function grab(re) {
    const m = re.exec(src); assert.ok(m, 'server.js 找不到 ' + re);
    let i = src.indexOf('{', m.index + m[0].length - 1), depth = 0, j = i;
    for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}') { depth--; if (!depth) break; } }
    return src.slice(m.index, j + 1);
  }
  const tmp = path.join(__dirname, '..', '..', '.worktable', 'artifacts', 'cmq', 'tmp-chat');
  fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
  const sandbox = { fs, path, console, CHAT_HISTORY_DIR: tmp, Promise };
  vm.createContext(sandbox);
  vm.runInContext('const _chatSessionLocks = new Map();\n'
    + grab(/function withChatSessionLock\(sessionId, fn\) \{/) + '\n'
    + grab(/function readChatSessionMessages\(sessionId, dir\) \{/) + '\n'
    + grab(/function saveChatSession\(sessionId, messages, trace/) + '\n'
    + grab(/function saveChatSessionMerged\(sessionId, knownMessages/) + '\n'
    + 'this.lock = withChatSessionLock; this.merged = saveChatSessionMerged; this.read = readChatSessionMessages; this.save = saveChatSession;', sandbox);
  const rd = (...a) => JSON.parse(JSON.stringify(sandbox.read(...a)));   // 跨 vm 的陣列要先轉成本域物件才能 deepStrictEqual
const order = (all, add) => add.reduce((acc, m) => Q.insertReplyOrdered(acc, m), all);

  await t('AC5 兩則幾乎同時完成（反序）→ 依提問順序、沒有任何一則消失；AC6 重開仍對得上', async () => {
    const sid = 'cmq_ac5';
    const u1 = { role: 'user', content: '問1', questionNo: 1 }, u2 = { role: 'user', content: '問2', questionNo: 2 };
    sandbox.save(sid, [u1], [], tmp, null, 'human', null, { since: 'x' });                 // 第 1 問落檔（pending）
    sandbox.save(sid, [u1, u2], [], tmp, null, 'human', null, { since: 'x' });             // 第 2 問落檔
    const a1 = { role: 'assistant', content: '答1', replyTo: 1 }, a2 = { role: 'assistant', content: '答2', replyTo: 2 };
    // 第 2 問先完成、第 1 問後完成；兩邊都只帶「自己送出當時」的記憶中快照
    const p2 = sandbox.lock(sid, () => sandbox.merged(sid, [u1, u2], [a2], [], tmp, null, 'human', null, null, null, null, order));
    const p1 = sandbox.lock(sid, () => sandbox.merged(sid, [u1], [a1], [], tmp, null, 'human', null, null, null, null, order));
    await Promise.all([p1, p2]);
    const disk = rd(sid, tmp);
    assert.deepStrictEqual(disk.map(m => m.content), ['問1', '問2', '答1', '答2']);
    // 重開對話（重新讀檔）：每則回覆的 replyTo 仍指向正確的提問
    for (const m of disk.filter(x => x.role === 'assistant')) assert.strictEqual(disk.find(u => u.role === 'user' && u.questionNo === m.replyTo).content, '問' + m.replyTo);
  });
  await t('AC5 回寫鎖：十則同時完成不互相覆蓋', async () => {
    const sid = 'cmq_ac5b', us = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: 'q' + (i + 1), questionNo: i + 1 }));
    sandbox.save(sid, us, [], tmp, null, 'human', null, null);
    const ps = us.map((u, i) => sandbox.lock(sid, () => sandbox.merged(sid, us, [{ role: 'assistant', content: 'a' + (i + 1), replyTo: i + 1 }], [], tmp, null, 'human', null, null, null, null, order)));
    await Promise.all(ps);
    const disk = rd(sid, tmp);
    assert.strictEqual(disk.length, 20); assert.deepStrictEqual(disk.slice(10).map(m => m.replyTo), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
  await t('不帶 insertFn 的舊路徑行為不變（純附加）', async () => {
    const sid = 'cmq_legacy'; const u = { role: 'user', content: 'q' };
    sandbox.save(sid, [u], [], tmp, null, 'human', null, null);
    await sandbox.lock(sid, () => sandbox.merged(sid, [u], [{ role: 'assistant', content: 'a' }], [], tmp, null, 'human', null, null, null, null));
    assert.deepStrictEqual(rd(sid, tmp).map(m => m.content), ['q', 'a']);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

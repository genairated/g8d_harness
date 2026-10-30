'use strict';
// CMQ-P1 自測（接線層）：把 server.js 裡 CMQ 那一整段「原樣取出」，用假的 CLI／假的 HTTP 回應跑一遍。
// 不起 server、不碰真 CLI／額度。執行：node portal/checks/cmq-glue.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const a = src.indexOf('const chatQueueLib = require');
const b = src.indexOf('\n// Kill every LONG-LIVED child');
assert.ok(a > 0 && b > a, '找不到 CMQ 區段');
const block = src.slice(a, b);

const started = [], aborted = [], events = [], prompts = {};
const jobs = new Map();
const classifyScript = [];
const sandbox = {
  require: (m) => require(m === './chat-queue' ? path.join(__dirname, '..', 'chat-queue.js') : m),
  console, setTimeout, Date, Promise, JSON, String, Array, Object, Error,
  jobs,
  chatMsgText: (m) => (typeof m.content === 'string' ? m.content : ''),
  chatViaClaude: (ctx) => started.push([ctx.cmqQuestionNo, ctx.fullPrompt]),
  chatViaGemini: () => { throw new Error('不該呼叫'); }, chatViaCodex: () => { throw new Error('不該呼叫'); }, chatViaGrok: () => { throw new Error('不該呼叫'); },
  abortJob: (id) => { aborted.push(id); return true; },
  broadcastChatTaskChange: (e) => events.push(e),
  _tgSpawnClaude: async () => classifyScript.shift(),
};
vm.createContext(sandbox);
vm.runInContext(block + '\nthis.cmqSubmit = cmqSubmit; this.cmqRelease = cmqRelease; this.chatQueue = chatQueue; this.cmqStampQuestion = cmqStampQuestion; this.cmqEndWithoutReply = cmqEndWithoutReply;', sandbox);

const flush = () => new Promise(r => setTimeout(r, 30));
function fakeRes() {
  const r = { headersSent: false, writableEnded: false, status: null, body: null, on() {},
    writeHead(s) { r.status = s; r.headersSent = true; }, end(b) { r.body = b; r.writableEnded = true; } };
  return r;
}
function mkCtx(no, text, ws, extra) {
  const messages = [];
  for (let i = 1; i < no; i++) messages.push({ role: 'user', content: 'older' + i });
  messages.push({ role: 'user', content: text });
  return Object.assign({ jobId: 'job' + no, activeSessionId: 'S', messages, provider: 'claude', status: 'running', wctx: { root: ws || 'D:\\wsA' }, res: fakeRes(), fullPrompt: 'P' + no }, extra || {});
}
let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('PASS ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n   ' + (e.stack || e)); } }

(async () => {
  await t('第一則直接開跑（不問模型、不加標示），題號落在使用者訊息上', async () => {
    const c1 = mkCtx(1, '第一個問題'); jobs.set(c1.jobId, c1);
    sandbox.cmqStampQuestion(c1); sandbox.cmqSubmit(c1, {});
    assert.strictEqual(c1.status, 'queued'); await flush();
    assert.strictEqual(c1.status, 'running'); assert.deepStrictEqual(started[0], [1, 'P1']);
    assert.strictEqual(c1.messages[0].questionNo, 1);
    assert.strictEqual(classifyScript.length, 0);
  });
  await t('第二則：模型判排隊 → status=queued、不開跑；jobIsRunning 邏輯看得到', async () => {
    classifyScript.push('{"relation":"dependent","readOnly":false,"prevReadOnly":false}');
    const c2 = mkCtx(2, '第二個問題'); jobs.set(c2.jobId, c2);
    sandbox.cmqStampQuestion(c2); sandbox.cmqSubmit(c2, { rebuildPrompt: (txt) => 'REBUILT:' + txt }); await flush();
    assert.strictEqual(c2.status, 'queued'); assert.strictEqual(started.length, 1);
    assert.strictEqual(c2.cmq.mode, 'queued');
  });
  await t('第一則結束（cmqRelease）→ 第二則自動開跑，且 prompt 以「現在硬碟狀態」重建', async () => {
    const c1 = jobs.get('job1'), c2 = jobs.get('job2');
    c1.status = 'done'; sandbox.cmqRelease(c1); await flush();
    assert.strictEqual(c2.status, 'running'); assert.strictEqual(started[1][1], 'REBUILT:第二個問題');
  });
  await t('排隊中被取消（cancelQueued）→ HTTP 請求收尾、不留回覆、不影響執行中者', async () => {
    const c3 = mkCtx(3, '第三個', 'D:\\wsA'); jobs.set(c3.jobId, c3);
    classifyScript.push('{"relation":"unknown"}');
    sandbox.cmqStampQuestion(c3); sandbox.cmqSubmit(c3, {}); await flush();
    assert.strictEqual(c3.status, 'queued');
    c3.cmq.status = 'aborted'; sandbox.cmqEndWithoutReply(c3, 'cancelled');
    assert.strictEqual(c3.status, 'done'); assert.strictEqual(c3.res.status, 200);
    const body = JSON.parse(c3.res.body); assert.strictEqual(body.cancelled, true);
  });
  await t('明確補充：執行中者被標記 cmqSuperseded 並呼叫中止；合併者等它結束才開跑，prompt 為合併後需求', async () => {
    started.length = 0; aborted.length = 0;
    const ws = 'D:\\wsMerge';
    const m1 = mkCtx(1, '做報表', ws, { jobId: 'm1', activeSessionId: 'M' }); jobs.set('m1', m1);
    sandbox.cmqStampQuestion(m1); sandbox.cmqSubmit(m1, { rebuildPrompt: (t2) => 'R:' + t2 }); await flush();
    classifyScript.push('{"relation":"continue","readOnly":false,"prevReadOnly":false}');
    const m2 = mkCtx(2, '加月份欄', ws, { jobId: 'm2', activeSessionId: 'M' }); jobs.set('m2', m2);
    sandbox.cmqStampQuestion(m2); sandbox.cmqSubmit(m2, { rebuildPrompt: (t2) => 'R:' + t2 }); await flush();
    assert.ok(m1.cmqSuperseded, '前一個應標記被取代'); assert.deepStrictEqual(aborted, ['m1']);
    assert.strictEqual(started.length, 1, '合併者不可在前一個結束前開跑');
    sandbox.cmqEndWithoutReply(m1, 'superseded'); sandbox.cmqRelease(m1); await flush();
    assert.strictEqual(started.length, 2);
    assert.ok(started[1][1].startsWith('R:做報表') && started[1][1].includes('加月份欄'), started[1][1]);
    assert.strictEqual(m2.cmq.mergedFrom, 1);
    const b1 = JSON.parse(m1.res.body); assert.strictEqual(b1.superseded, true);
  });
  await t('工作區隔離：SSE 廣播的 workspace 為各自的工作區；GET 清單別區看不到', async () => {
    assert.ok(events.length > 0 && events.every(e => e.workspace && e.sessionId));
    assert.ok(sandbox.chatQueue.list('D:\\wsMerge').length >= 2);
    assert.strictEqual(sandbox.chatQueue.list('D:\\wsOther').length, 0);
    assert.ok(events.filter(e => e.workspace === 'D:\\wsMerge').every(e => e.sessionId === 'M'));
  });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

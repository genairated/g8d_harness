'use strict';
// CMQ-P1 (specs/SPEC-chat-concurrent-messages.md)：每條對話的訊息佇列＋關係判斷。
// 純邏輯、無任何 server 依賴——server.js 注入 classify / start / abort / onChange，所以可單獨自測。
//
// 安全優先：不確定一律排隊；只有「明確是同一件事的補充」才中止前一個。
const path = require('path');

function normWs(p) { try { return path.resolve(String(p || '')).toLowerCase(); } catch (e) { return ''; } }

// ── 指揮官明確指示（優先於模型判斷）──────────────────────────────────────────
// 只認很明確的口語，認不得就回 null（交給關係判斷，最終不確定＝排隊）。
function parseDirective(text) {
  const t = String(text || '');
  if (/(上一個|前一個|剛剛那個|剛才那個|上一題|前一題)[^。！？\n]{0,6}(先停|先中止|停掉|不用做了|不要做了|取消)|(先停|先中止|停掉|取消)[^。！？\n]{0,4}(上一個|前一個|剛剛那個|剛才那個)|這個先停|先停下來/.test(t)) return 'stop-prev';
  if (/同時(做|進行|處理|跑)|一起(做|處理)|並行/.test(t)) return 'parallel';
  if (/(等|待)(上一個|前一個|剛剛那個|剛才那個)[^。！？\n]{0,6}(做完|完成|結束)|(做完|完成)(上一個|前一個)[^。！？\n]{0,4}(再|後)|做完再(做|處理)/.test(t)) return 'wait';
  return null;
}

// ── 關係判斷：解析模型輸出；任何不合格式一律 unknown / 非唯讀 ─────────────────
const RELATIONS = ['continue', 'independent', 'dependent', 'unknown'];
function parseClassification(raw) {
  const bad = { relation: 'unknown', readOnly: false, prevReadOnly: false, ok: false };
  if (raw == null) return bad;
  const s = String(raw);
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return bad;
  let o; try { o = JSON.parse(m[0]); } catch (e) { return bad; }
  if (!o || typeof o !== 'object' || !RELATIONS.includes(o.relation)) return bad;
  return { relation: o.relation, readOnly: o.readOnly === true, prevReadOnly: o.prevReadOnly === true, ok: true };
}

function buildClassifyPrompt(prevTexts, newText) {
  const clip = (x, n) => { x = String(x || '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n) + '…' : x; };
  return '你是訊息關係判斷器，只輸出一行 JSON，不要任何其他文字。\n'
    + '情境：使用者在同一個對話裡，前面的訊息還在處理中，又送出了新的一則。\n'
    + '【處理中的前文】\n' + prevTexts.map((t, i) => `(${i + 1}) ${clip(t, 400)}`).join('\n') + '\n'
    + '【新訊息】\n' + clip(newText, 600) + '\n\n'
    + '請判斷 relation（四選一）：\n'
    + '- continue：新訊息「明確」是前文同一件事的補充或更正（前文需求沒講完、改條件）。\n'
    + '- independent：兩件互不相干的事。\n'
    + '- dependent：新訊息要用到前文的成果，或兩者有先後關係。\n'
    + '- unknown：無法確定（有疑慮就選這個）。\n'
    + '另外 readOnly：新訊息是否「明確只是查資料／回答問題、不會修改任何檔案」；prevReadOnly：最後一則前文是否同理。\n'
    + '有任何可能要改檔、建檔、執行指令寫入，就填 false。\n'
    + '輸出格式：{"relation":"unknown","readOnly":false,"prevReadOnly":false}';
}

// ── 回覆呈現 ────────────────────────────────────────────────────────────────
function quoteHeader(questionNo, text, mergedFrom) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const q = t.length > 40 ? t.slice(0, 40) + '…' : t;
  let h = `> 回覆你的第 ${questionNo} 問：${q}`;
  if (mergedFrom) h += `\n> （已把你的第 ${mergedFrom} 句併入這一問一起處理）`;
  return h + '\n\n';
}

// 回覆依「提問順序」落位：若檔案裡已有 replyTo 比我大的回覆，插在它前面；否則附加在最後。
// 先完成的不插隊——沒有其他回覆時就是單純附加；不會動到任何既有訊息。
function insertReplyOrdered(messages, reply) {
  const out = messages.slice();
  const n = reply && reply.replyTo;
  if (typeof n === 'number') {
    const idx = out.findIndex(m => m && m.role === 'assistant' && typeof m.replyTo === 'number' && m.replyTo > n);
    if (idx !== -1) { out.splice(idx, 0, reply); return out; }
  }
  out.push(reply);
  return out;
}

// ── 佇列 ────────────────────────────────────────────────────────────────────
// entry: { jobId, ws, sessionId, questionNo, text, mergeable, status, mode, readOnly, mergedFrom, ... }
// status: queued | running | done | aborted
function createChatQueue(deps) {
  const classify = deps.classify;                 // async ({prevTexts,newText,entry}) => raw string | parsed obj
  const start = deps.start;                       // (entry) => void   開始真正執行
  const abort = deps.abort;                       // (entry, reason) => void   中止執行中的
  const onChange = deps.onChange || (() => {});   // (entry, reason) => void   SSE
  const log = deps.log || (() => {});
  const classifyTimeoutMs = deps.classifyTimeoutMs || 30000;
  const sessions = new Map();                     // `${ws}|${sessionId}` -> { entries:[], chain:Promise }
  const KEEP_FINISHED = 30;

  function keyOf(e) { return normWs(e.ws) + '|' + e.sessionId; }
  function sess(e) {
    const k = keyOf(e);
    if (!sessions.has(k)) sessions.set(k, { entries: [], chain: Promise.resolve() });
    return sessions.get(k);
  }
  const isActive = (x) => x.status === 'queued' || x.status === 'running';

  function prune(s) {
    const fin = s.entries.filter(x => !isActive(x));
    if (fin.length > KEEP_FINISHED) {
      const drop = new Set(fin.slice(0, fin.length - KEEP_FINISHED));
      s.entries = s.entries.filter(x => !drop.has(x));
    }
  }

  function begin(e) {
    e.status = 'running'; e.startedAt = Date.now();
    onChange(e, 'chat-queue-started');
    try { start(e); }
    catch (err) { log('start failed: ' + err.message); finish(e, 'aborted'); }
  }

  // 沒有執行中的就依序啟動下一個排隊者（FIFO）。
  function pump(s) {
    if (s.entries.some(x => x.status === 'running')) return;
    const next = s.entries.find(x => x.status === 'queued');
    if (next) begin(next);
  }

  function finish(e, status) {
    if (!isActive(e)) return;
    e.status = status || 'done'; e.finishedAt = Date.now();
    onChange(e, 'chat-queue-finished');
    const s = sess(e);
    prune(s);
    pump(s);
  }

  function enqueue(s, e, mode, atFront) {
    e.status = 'queued'; e.mode = mode;
    if (atFront) {
      const self = s.entries.indexOf(e);
      if (self !== -1) s.entries.splice(self, 1);
      const firstQueued = s.entries.findIndex(x => x.status === 'queued');
      if (firstQueued === -1) s.entries.push(e); else s.entries.splice(firstQueued, 0, e);
    } else if (!s.entries.includes(e)) s.entries.push(e);
    onChange(e, 'chat-queue-queued');
  }

  async function safeClassify(e, active) {
    const bad = { relation: 'unknown', readOnly: false, prevReadOnly: false, ok: false };
    try {
      const raw = await Promise.race([
        Promise.resolve(classify({ prevTexts: active.map(x => x.text), newText: e.text, entry: e })),
        new Promise((_, rej) => setTimeout(() => rej(new Error('classify timeout')), classifyTimeoutMs)),
      ]);
      return (raw && typeof raw === 'object' && raw.relation) ? Object.assign({ ok: true }, bad, raw, { ok: true }) : parseClassification(raw);
    } catch (err) { log('classify failed → unknown: ' + err.message); return bad; }
  }

  async function admit(e) {
    const s = sess(e);
    let active = s.entries.filter(isActive);
    if (!active.length) { e.mode = 'solo'; s.entries.push(e); begin(e); return e; }

    const directive = parseDirective(e.text);
    if (directive === 'stop-prev') {
      s.entries.push(e); e.mode = 'preempt';
      for (const x of active.filter(y => y.status === 'running')) abort(x, 'directive');
      for (const x of active.filter(y => y.status === 'queued')) { x.status = 'aborted'; x.finishedAt = Date.now(); onChange(x, 'chat-queue-finished'); if (deps.cancelQueued) deps.cancelQueued(x); }
      // 被中止者結束時會 pump；若它們已不在執行中，這裡直接啟動。
      e.status = 'queued'; pump(s);
      return e;
    }
    if (directive === 'parallel') { e.mode = 'parallel'; s.entries.push(e); begin(e); return e; }
    if (directive === 'wait') { s.entries.push(e); enqueue(s, e, 'queued'); return e; }

    const cls = await safeClassify(e, active);
    active = s.entries.filter(isActive);                 // 判斷期間前面的可能已做完
    if (!active.length) { e.mode = 'solo'; s.entries.push(e); begin(e); return e; }
    const last = active[active.length - 1];
    if (cls.ok && last.readOnly == null) last.readOnly = cls.prevReadOnly;
    e.readOnly = cls.ok ? cls.readOnly : false;
    e.relation = cls.relation;

    // 接續：僅限「明確補充」且前一則可合併（非斜線指令）
    if (cls.ok && cls.relation === 'continue' && last.mergeable && e.mergeable) {
      e.mergedFrom = last.questionNo;
      e.text = deps.mergeText ? deps.mergeText(last, e) : (last.text + '\n\n【補充】' + e.text);
      if (deps.onMerge) deps.onMerge(e, last);           // server 端重建 prompt
      s.entries.push(e);
      if (last.status === 'running') {
        last.superseded = true; last.supersededBy = e.questionNo;
        abort(last, 'superseded');
        enqueue(s, e, 'merged', true);                   // 前一個真正結束後才接手，避免兩個同時改檔
      } else {
        last.status = 'aborted'; last.superseded = true; last.supersededBy = e.questionNo; last.finishedAt = Date.now();
        onChange(last, 'chat-queue-finished');
        if (deps.cancelQueued) deps.cancelQueued(last);
        enqueue(s, e, 'merged', true);
        pump(s);
      }
      return e;
    }

    // 獨立且雙方明確唯讀 → 並行
    if (cls.ok && cls.relation === 'independent' && e.readOnly === true && active.every(x => x.readOnly === true)) {
      e.mode = 'parallel'; s.entries.push(e); begin(e); return e;
    }

    // 其餘（dependent / unknown / 可能寫檔）一律排隊
    s.entries.push(e); enqueue(s, e, 'queued');
    return e;
  }

  // 入口。同一條對話的送入依序處理（判斷期間不會有兩則同時做決定）。
  function submit(e) {
    e.status = 'queued'; e.enqueuedAt = Date.now();
    if (e.mergeable == null) e.mergeable = true;
    const s = sess(e);
    const p = s.chain.then(() => admit(e)).catch((err) => {
      log('admit failed → queue: ' + err.message);
      if (!s.entries.includes(e)) s.entries.push(e);
      if (e.status === 'queued') { if (!e.mode) e.mode = 'queued'; pump(s); }
    });
    s.chain = p.then(() => {}, () => {});
    return p;
  }

  function list(ws, sessionId) {
    const out = [];
    const w = normWs(ws);
    for (const [k, s] of sessions) {
      if (!k.startsWith(w + '|')) continue;            // 工作區隔離：其他工作區完全不可見
      for (const x of s.entries) {
        if (sessionId && x.sessionId !== sessionId) continue;
        out.push({
          jobId: x.jobId, sessionId: x.sessionId, questionNo: x.questionNo, status: x.status, mode: x.mode || null,
          readOnly: x.readOnly == null ? null : x.readOnly, mergedFrom: x.mergedFrom || null,
          supersededBy: x.supersededBy || null, preview: String(x.text || '').replace(/\s+/g, ' ').slice(0, 60),
          enqueuedAt: x.enqueuedAt || null, startedAt: x.startedAt || null, finishedAt: x.finishedAt || null,
        });
      }
    }
    return out.sort((a, b) => (a.questionNo || 0) - (b.questionNo || 0));
  }

  // 同一條對話裡「另一個還活著」的項目（回寫時用來保留 pending 標記）
  function activeSibling(e) {
    const s = sessions.get(keyOf(e));
    return s ? (s.entries.find(x => x !== e && isActive(x)) || null) : null;
  }

  return { submit, finish, list, activeSibling, _sessions: sessions };
}

module.exports = { createChatQueue, parseDirective, parseClassification, buildClassifyPrompt, quoteHeader, insertReplyOrdered, normWs };

'use strict';
// Audio Topics (音訊主題) persistence + compiler — shared by server.js (CRUD API + the four audio
// entry points) and telegram.js (F5 voice picks the current workspace's default topic).
// Two-file, scope-based storage — same "全域 vs 工作區" split as skills, NOT the single
// "workspace field on one file" pattern used by notes/schedules, because a global topic must be
// visible from every workspace while a workspace topic must stay isolated. See SPEC-audio-topic.md §4.
const fs = require('fs');
const path = require('path');
const listIndex = require('./list-index');

// Whisper's real hard limit is ~224 tokens (half its 448-token text window) — see
// global-knowledge/audio-topic-guide.md §1. Estimation is intentionally approximate (no tokenizer
// dependency): ~1.5 "tokens" per CJK character, ~1 per whitespace-delimited latin word/number.
const TOKEN_BUDGET = 224;


// 寫入一律走共用模組（SPEC-list-index.md §9.14）：同一份檔一條排隊、暫存檔換名寫回。
// 呼叫端（server.js）是「同步讀 → 改 → 呼叫 writeX」，寫檔改非同步後，下一個請求可能在換名前讀到舊檔；
// 所以寫入當下先把最新內容放進 pending（同步），讀取先看 pending，寫完且沒被更新的才清掉——不會丟更新。
// 不加目錄、不改檔案格式；檔案仍是真相。
const pending = new Map();   // 檔案路徑 → 最新待寫內容（物件）
const queues = new Map();    // 檔案路徑 → 排隊尾端 Promise
function queuedWrite(p, data) {
  pending.set(p, data);
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch (e) {}   // 目錄先建好，免得共用模組當成「自己建的快取目錄」塞 .gitignore
  const prev = queues.get(p) || Promise.resolve();
  const run = prev.then(async () => {
    const snap = pending.get(p);   // 合併：排到時寫當下最新版；前面的一輪已寫掉就略過
    if (snap === undefined) return;
    try { await listIndex.writeAtomic(p, JSON.stringify(snap, null, 2)); }
    catch (e) { console.warn('[audio-topics] 寫入失敗 ' + p + ': ' + (e && e.message || e)); }
    if (pending.get(p) === snap) pending.delete(p);
  });
  const tail = run.catch(() => {});
  queues.set(p, tail);
  tail.then(() => { if (queues.get(p) === tail) queues.delete(p); });
  return run;
}
function clone(o) { return JSON.parse(JSON.stringify(o)); }

function globalTopicsPath(harnessHome) {
  return path.join(harnessHome, 'global-knowledge', 'audio-topics.json');
}
function workspaceTopicsPath(workspaceRoot) {
  return path.join(workspaceRoot, '.harness', 'runtime', 'audio-topics.json');
}

function readGlobal(harnessHome) {
  const p = globalTopicsPath(harnessHome);
  if (pending.has(p)) { const d = clone(pending.get(p)); return { topics: Array.isArray(d.topics) ? d.topics : [] }; }
  try {
    if (!fs.existsSync(p)) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ topics: [] }, null, 2));
    }
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { topics: Array.isArray(data.topics) ? data.topics : [] };
  } catch (e) { return { topics: [] }; }
}
function writeGlobal(harnessHome, data) {
  const p = globalTopicsPath(harnessHome);
  return queuedWrite(p, clone({ topics: data.topics || [] }));
}

function readWorkspace(workspaceRoot) {
  const p = workspaceTopicsPath(workspaceRoot);
  if (pending.has(p)) { const d = clone(pending.get(p)); return { defaultTopicId: d.defaultTopicId || null, topics: Array.isArray(d.topics) ? d.topics : [] }; }
  try {
    if (!fs.existsSync(p)) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ defaultTopicId: null, topics: [] }, null, 2));
    }
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { defaultTopicId: data.defaultTopicId || null, topics: Array.isArray(data.topics) ? data.topics : [] };
  } catch (e) { return { defaultTopicId: null, topics: [] }; }
}
function writeWorkspace(workspaceRoot, data) {
  const p = workspaceTopicsPath(workspaceRoot);
  return queuedWrite(p, clone({ defaultTopicId: data.defaultTopicId || null, topics: data.topics || [] }));
}

// Same normalisation convention used everywhere else workspace isolation is enforced
// (schedules, notes, activities) — collapse doubled separators, lowercase.
function normWs(p) { try { return path.resolve(String(p || '')).toLowerCase(); } catch (e) { return ''; } }

function genTopicId() { return 'topic_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

// Merged list for a given workspace: 🌐 global topics ∪ 📁 that workspace's own topics.
function mergedList(harnessHome, workspaceRoot) {
  const g = readGlobal(harnessHome).topics.map(t => Object.assign({}, t, { scope: 'global', workspace: null }));
  const active = normWs(workspaceRoot);
  const w = readWorkspace(workspaceRoot).topics
    .filter(t => normWs(t.workspace) === active)
    .map(t => Object.assign({}, t, { scope: 'workspace' }));
  return g.concat(w);
}

function getDefaultTopicId(workspaceRoot) { return readWorkspace(workspaceRoot).defaultTopicId || null; }

function resolveTopic(harnessHome, workspaceRoot, topicId) {
  if (!topicId) return null;
  return mergedList(harnessHome, workspaceRoot).find(t => t.id === topicId) || null;
}
function resolveDefaultTopic(harnessHome, workspaceRoot) {
  const id = getDefaultTopicId(workspaceRoot);
  return id ? resolveTopic(harnessHome, workspaceRoot, id) : null;
}

// Resolve what an audio entry point should actually send as initial_prompt for a given selection.
//   topicId === '__none__' → explicit "don't use a topic" (skip default too)
//   topicId falsy          → follow the workspace's defaultTopicId (may resolve to nothing)
//   topicId set            → that specific topic (must exist in the merged list, else null)
// Returns { prompt, lang, topic } or null.
function resolvePromptForRequest(harnessHome, workspaceRoot, topicId) {
  if (topicId === '__none__') return null;
  const topic = topicId ? resolveTopic(harnessHome, workspaceRoot, topicId) : resolveDefaultTopic(harnessHome, workspaceRoot);
  return topic ? { prompt: topic.prompt, lang: topic.lang, topic } : null;
}

// ---- token estimate (guide §1: no tokenizer dependency, deliberately approximate/conservative) ----
function estimateTokens(str) {
  if (!str) return 0;
  const CJK = /[一-鿿　-〿＀-￯]/;
  let tokens = 0, buf = '';
  const flushLatin = () => { if (buf.trim()) tokens += buf.trim().split(/\s+/).filter(Boolean).length; buf = ''; };
  for (const ch of Array.from(str)) {
    if (CJK.test(ch)) { flushLatin(); tokens += 1.5; }
    else buf += ch;
  }
  flushLatin();
  return Math.round(tokens * 10) / 10;
}

// Trim a raw (hand-written) prompt string down to the token budget by dropping characters off the
// tail. Used for UI-hand-filled `prompt` values, which skip the structured compiler.
function truncateRawToBudget(str) {
  let s = String(str || '');
  let truncated = false;
  while (s.length > 0 && estimateTokens(s) > TOKEN_BUDGET) { s = s.slice(0, -1); truncated = true; }
  return { prompt: s, tokenCount: estimateTokens(s), truncated };
}

// ---- structured fields -> Whisper-friendly prompt (audio-topic-guide.md §4 skeleton) ----
// Priority when trimming to fit the token budget (guide §2 ROI order, spec §4): 人名 > 專名 > 主題句 > notes.
// So we drop the LOWEST-priority piece first: notes, then topicLine, then terms (tail), then people (tail).
function compileTopic(fields) {
  fields = fields || {};
  const lang = fields.lang || 'zh';
  const meetingType = String(fields.meetingType || '').trim();
  let people = Array.isArray(fields.people) ? fields.people.map(String).filter(Boolean) : [];
  let terms = Array.isArray(fields.terms) ? fields.terms.map(String).filter(Boolean) : [];
  let topicLine = String(fields.topicLine || '').trim();
  let notes = String(fields.notes || '').trim();

  function assemble() {
    const parts = [];
    if (lang === 'en') {
      parts.push('This is a conversation' + (meetingType ? (' about ' + meetingType) : '') + '. Please transcribe naturally with punctuation.');
      if (topicLine) parts.push('Topic: ' + topicLine + '.');
      if (people.length) parts.push('Names: ' + people.join(', ') + '.');
      if (terms.length) parts.push('Terms (keep spelling): ' + terms.join(', ') + '.');
      if (notes) parts.push(notes);
    } else {
      parts.push('這是一段繁體中文的' + (meetingType || '對話') + '，可能夾雜少量英文工具名。請以自然的繁體中文辨識，包含適當標點。');
      if (topicLine) parts.push('主題：' + topicLine + '。');
      if (people.length) parts.push('常見人名：' + people.join('、') + '。');
      if (terms.length) parts.push('常見專有名詞：' + terms.join('、') + '（保持這些拼法）。');
      if (notes) parts.push(notes);
    }
    return parts.join('\n');
  }

  let truncated = false;
  let prompt = assemble();
  while (estimateTokens(prompt) > TOKEN_BUDGET) {
    if (notes) { notes = ''; truncated = true; }
    else if (topicLine) { topicLine = ''; truncated = true; }
    else if (terms.length) { terms = terms.slice(0, -1); truncated = true; }
    else if (people.length) { people = people.slice(0, -1); truncated = true; }
    else break; // header sentence alone still over budget — nothing left to trim, accept as-is
    prompt = assemble();
  }
  return { prompt, tokenCount: estimateTokens(prompt), truncated };
}

module.exports = {
  TOKEN_BUDGET, globalTopicsPath, workspaceTopicsPath,
  readGlobal, writeGlobal, readWorkspace, writeWorkspace,
  normWs, genTopicId, mergedList, getDefaultTopicId, resolveTopic, resolveDefaultTopic,
  resolvePromptForRequest, estimateTokens, truncateRawToBudget, compileTopic,
};

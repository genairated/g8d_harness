'use strict';
// Notes (Stickies) persistence — shared by server.js (web API), telegram.js (/note, /notes, NL
// injection) and scheduler.js (due-date reminder scan). Single global-knowledge/notes/notes.json
// under HARNESS_HOME, same "one file + workspace field" pattern as schedules.json — see
// SPEC-stickies.md §3–§5. Already git-ignored via the blanket `global-knowledge/` rule.
const fs   = require('fs');
const path = require('path');
const listIndex = require('./list-index');

const NOTE_COLORS = ['yellow', 'pink', 'blue', 'green', 'purple', 'orange', 'gray'];

function notesPath(harnessHome) {
  return path.join(harnessHome, 'global-knowledge', 'notes', 'notes.json');
}

function readNotes(harnessHome) {
  const p = notesPath(harnessHome);
  try {
    if (!fs.existsSync(p)) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify([], null, 2));
    }
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (e) { return []; }
}

// 所有寫入（API、Telegram /note、到期提醒掃描）一律走這裡（SPEC-list-index.md §9.10、D8）：
// 同一份檔一條排隊，每次動作都是「讀最新 → 套用變更 → 暫存檔換名寫回」，三方不會互相覆蓋。
// mutator(list) 可直接改 list 後回傳 undefined，或回傳新陣列；其回傳值（非陣列時）原樣交回呼叫端。
// mutator 丟錯 → 不寫檔、錯誤交回呼叫端（Promise reject）。
const queues = new Map();   // notesPath → 排隊尾端 Promise
function updateNotes(harnessHome, mutator) {
  const p = notesPath(harnessHome);
  const prev = queues.get(p) || Promise.resolve();
  const run = prev.then(async () => {
    const list = readNotes(harnessHome);
    const ret = mutator(list);
    const next = Array.isArray(ret) ? ret : list;
    await listIndex.writeAtomic(p, JSON.stringify(next, null, 2));
    return Array.isArray(ret) ? undefined : ret;
  });
  const tail = run.catch(() => {});
  queues.set(p, tail);
  tail.then(() => { if (queues.get(p) === tail) queues.delete(p); });
  return run;
}

function genNoteId() { return 'note_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

// Normalise a workspace path for comparison (collapse doubled separators, lowercase) — same
// convention used everywhere else workspace isolation is enforced (schedules, activities, ...).
function normWs(p) { try { return path.resolve(String(p || '')).toLowerCase(); } catch (e) { return ''; } }

// Local-calendar (not UTC) YYYY-MM-DD for "is it due today / overdue" comparisons — a
// toISOString().slice(0,10) here would roll back a day in UTC+8 (see MEMORY teaching).
function localDateStr(d) {
  const dt = d || new Date();
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}

module.exports = { NOTE_COLORS, notesPath, readNotes, updateNotes, genNoteId, normWs, localDateStr };

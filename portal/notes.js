'use strict';
// Notes (Stickies) persistence — shared by server.js (web API), telegram.js (/note, /notes, NL
// injection) and scheduler.js (due-date reminder scan). Single global-knowledge/notes/notes.json
// under HARNESS_HOME, same "one file + workspace field" pattern as schedules.json — see
// SPEC-stickies.md §3–§5. Already git-ignored via the blanket `global-knowledge/` rule.
const fs   = require('fs');
const path = require('path');

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

function writeNotes(harnessHome, list) {
  const p = notesPath(harnessHome);
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch (e) {}
  fs.writeFileSync(p, JSON.stringify(list, null, 2));
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

module.exports = { NOTE_COLORS, notesPath, readNotes, writeNotes, genNoteId, normWs, localDateStr };

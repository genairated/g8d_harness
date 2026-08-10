'use strict';
// Project Management (PM) persistence — single global-knowledge/pm/pm.json under HARNESS_HOME,
// same "one file + workspace field" pattern as notes.json/schedules.json — see SPEC-project-management.md §3-§5.
// Already git-ignored via the blanket `global-knowledge/` rule.
const fs   = require('fs');
const path = require('path');

function pmPath(harnessHome) {
  return path.join(harnessHome, 'global-knowledge', 'pm', 'pm.json');
}

function readPm(harnessHome) {
  const p = pmPath(harnessHome);
  try {
    if (!fs.existsSync(p)) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ projects: [], tasks: [] }, null, 2));
    }
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      projects: Array.isArray(data.projects) ? data.projects : [],
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
    };
  } catch (e) { return { projects: [], tasks: [] }; }
}

function writePm(harnessHome, data) {
  const p = pmPath(harnessHome);
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch (e) {}
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function genProjectId() { return 'proj_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }
function genTaskId() { return 'ptask_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

// Same normalisation convention used everywhere else workspace isolation is enforced.
function normWs(p) { try { return path.resolve(String(p || '')).toLowerCase(); } catch (e) { return ''; } }

// Local-calendar (not UTC) YYYY-MM-DD — a toISOString().slice(0,10) here would roll back a day
// in UTC+8 (MEMORY teaching).
function localDateStr(d) {
  const dt = d || new Date();
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}

// Add one calendar day to a 'YYYY-MM-DD' date-only string (local calendar semantics).
function addDaysStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return localDateStr(dt);
}

// Does `taskId` (transitively, via `deps`) depend on itself if we add an edge taskId -> newDepId?
// i.e. would adding newDepId to taskId's deps create a cycle? Walk newDepId's dep chain looking for taskId.
function wouldCycle(tasks, taskId, newDepId) {
  if (taskId === newDepId) return true;
  const byId = new Map(tasks.map(t => [t.id, t]));
  const seen = new Set();
  const stack = [newDepId];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === taskId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const t = byId.get(cur);
    if (t && Array.isArray(t.deps)) stack.push(...t.deps);
  }
  return false;
}

module.exports = { pmPath, readPm, writePm, genProjectId, genTaskId, normWs, localDateStr, addDaysStr, wouldCycle };

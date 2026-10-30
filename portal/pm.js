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
      // PMHR1: resources is new — old pm.json files predate it, so backfill an empty array
      // rather than let callers blow up on `.resources` of undefined (SPEC §14.2 compat note).
      resources: Array.isArray(data.resources) ? data.resources : [],
    };
  } catch (e) { return { projects: [], tasks: [], resources: [] }; }
}

function writePm(harnessHome, data) {
  const p = pmPath(harnessHome);
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch (e) {}
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function genProjectId() { return 'proj_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }
function genTaskId() { return 'ptask_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }
function genResourceId() { return 'res_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

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

// Monday (local calendar) of the week containing `dateStr` ('YYYY-MM-DD') — week-start convention
// for §14.4 workload aggregation.
function mondayStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const dow = dt.getDay(); // 0=Sun..6=Sat
  const diff = dow === 0 ? -6 : (1 - dow);
  dt.setDate(dt.getDate() + diff);
  return localDateStr(dt);
}

// Whole-day difference b - a for two 'YYYY-MM-DD' strings (local calendar, DST-safe via Date diff).
function daysBetweenStr(aStr, bStr) {
  const [ay, am, ad] = aStr.split('-').map(Number);
  const [by, bm, bd] = bStr.split('-').map(Number);
  const a = new Date(ay, am - 1, ad);
  const b = new Date(by, bm - 1, bd);
  return Math.round((b - a) / 86400000);
}

// PMWD/§14.9 — 工作日語意。週六日一律非工作日；再扣掉該人員自己的休假日（`daysOff`，個人排休/
// 調休/特休，比國定假日表更貼近小團隊實況，Charles 2026-08-25 拍板）。沒有 resource 時只判週末。
function dayOfWeekStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getDay(); // 0=Sun..6=Sat
}
function isWeekendStr(dateStr) { const dow = dayOfWeekStr(dateStr); return dow === 0 || dow === 6; }
function daysOffSetOf(resource) {
  const list = (resource && Array.isArray(resource.daysOff)) ? resource.daysOff : [];
  return new Set(list.map(s => String(s)));
}
function isWorkdayStr(dateStr, offSet) {
  if (isWeekendStr(dateStr)) return false;
  return !(offSet && offSet.has(dateStr));
}
// 該人員在某一週（週一起算，同 §14.4）實際能上班幾天 → 可投入工時 = weeklyHours/5 × 工作日數。
// 這是「請兩天假的那一週，可投入就只有 3 天份」的唯一實作點；原本固定 /5 會高估產能。
function weekWorkdays(weekStartStr, offSet) {
  let n = 0;
  for (let i = 0; i < 7; i++) { if (isWorkdayStr(addDaysStr(weekStartStr, i), offSet)) n++; }
  return n;
}

// PMWD: 休假日清單正規化——只收 'YYYY-MM-DD'、去重、排序。API 寫入前一律過這關，
// 免得計算端要面對半格式化的資料。
function normalizeDaysOff(v) {
  if (!Array.isArray(v)) return [];
  const out = new Set();
  for (const item of v) {
    const s = String(item || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) out.add(s);
  }
  return Array.from(out).sort();
}

// §14.4 workload calc — the single source of truth shared by GET /api/pm/workload (and later the
// gantt overload markers in PMHR3). Pure function: {resources, tasks} in, per-resource-per-week
// allocation out. `from`/`to` are optional 'YYYY-MM-DD' bounds (inclusive) to limit which days count.
function computeWorkload({ resources, tasks }, opts) {
  opts = opts || {};
  const { from, to } = opts;
  const byId = new Map((resources || []).map(r => [r.id, r]));
  const weekMap = new Map(); // `${resourceId}|${weekStart}` -> accumulator

  for (const t of (tasks || [])) {
    if (t.isMilestone) continue;
    if (!t.assigneeId) continue;
    const resource = byId.get(t.assigneeId);
    if (!resource || resource.archived) continue;
    if (!t.start || !t.end) continue;
    let durationDays = daysBetweenStr(t.start, t.end) + 1;
    if (durationDays < 1) durationDays = 1;
    // PMWD: 工時只攤在「該負責人的工作日」上（扣週末＋個人休假）。原本按曆日平均攤，會把週五
    // 排到下週二的 3 天工作算成 5 天全職（超載假警報的根因，Charles 2026-08-25 回報）。
    const offSet = daysOffSetOf(resource);
    const allDays = [];
    for (let i = 0; i < durationDays; i++) allDays.push(addDaysStr(t.start, i));
    let workDays = allDays.filter(d => isWorkdayStr(d, offSet));
    // 整段都落在非工作日（例：只排週六日、或那幾天剛好都請假）→ 不讓工時憑空消失，退回按曆日攤，
    // 好過靜默算成 0 小時讓人以為沒事。
    if (!workDays.length) workDays = allDays;
    const perWorkday = resource.weeklyHours / 5;
    const estimate = (typeof t.estimateHours === 'number' && t.estimateHours > 0)
      ? t.estimateHours
      : perWorkday * workDays.length; // R3: unestimated = full-time for every workday in the span
    const dailyLoad = estimate / workDays.length;
    for (const day of workDays) {
      if (from && day < from) continue;
      if (to && day > to) continue;
      const week = mondayStr(day);
      const key = resource.id + '|' + week;
      if (!weekMap.has(key)) weekMap.set(key, { resourceId: resource.id, weekStart: week, allocatedHours: 0, byTask: new Map() });
      const acc = weekMap.get(key);
      acc.allocatedHours += dailyLoad;
      // PMHR3: per-task share of the week, so the gantt load row's hover can name the week's biggest eater.
      const prev = acc.byTask.get(t.id) || { id: t.id, name: t.name || '', hours: 0 };
      prev.hours += dailyLoad;
      acc.byTask.set(t.id, prev);
    }
  }

  const out = [];
  for (const entry of weekMap.values()) {
    const resource = byId.get(entry.resourceId);
    // PMWD: 可投入工時隨「那一週實際能上班幾天」縮放（週末永遠不算，再扣個人休假）。
    const offSet = daysOffSetOf(resource);
    const wd = weekWorkdays(entry.weekStart, offSet);
    const capacityHours = Math.round((resource.weeklyHours / 5) * wd * 100) / 100;
    // 整週休假（capacity 0）卻仍有配置 → 一定是超載，給一個 >1 的比率讓色階與 overloaded 都成立。
    const ratio = capacityHours > 0 ? entry.allocatedHours / capacityHours : (entry.allocatedHours > 0 ? 2 : 0);
    let topTask = null;
    for (const cand of entry.byTask.values()) { if (!topTask || cand.hours > topTask.hours) topTask = cand; }
    out.push({
      resourceId: entry.resourceId,
      weekStart: entry.weekStart,
      allocatedHours: Math.round(entry.allocatedHours * 100) / 100,
      capacityHours,
      workdays: wd, // PMWD: 供前端 hover 說明「這週只有 N 個工作日」
      ratio: Math.round(ratio * 1000) / 1000,
      overloaded: ratio > 1.0,
      topTask: topTask ? { id: topTask.id, name: topTask.name, hours: Math.round(topTask.hours * 100) / 100 } : null,
    });
  }
  out.sort((a, b) => (a.resourceId === b.resourceId ? a.weekStart.localeCompare(b.weekStart) : a.resourceId.localeCompare(b.resourceId)));
  return out;
}

module.exports = {
  pmPath, readPm, writePm, genProjectId, genTaskId, genResourceId, normWs,
  localDateStr, addDaysStr, wouldCycle, mondayStr, daysBetweenStr, computeWorkload,
  dayOfWeekStr, isWeekendStr, daysOffSetOf, isWorkdayStr, weekWorkdays, normalizeDaysOff,
};

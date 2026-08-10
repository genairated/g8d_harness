#!/usr/bin/env node
'use strict';
// portal/render-service/daily-activity.js
// DEV-FBPOST-01 — 跨工作區「昨日活動」彙整 (SPEC-daily-reflection-post §2)
//
// 供每日心得貼文的排程 agent 呼叫：回收「前一天」跨所有工作區發生的事，做成一份
// 素材清單交給草稿生成 prompt（DEV-FBPOST-02）。**只在執行期產生暫存資料、不落地成檔**。
//
// 素材兩路：
//   1. 排程執行紀錄 — schedulerManager.queryRuns 取全量（不按單一 workspace 過濾），
//      再用 run.scheduleId → schedule.workspace 反查標註來源工作區（null = harness home）。
//   2. 聊天記錄 — 掃各工作區 <root>/.harness/runtime/chat_history/*.md，篩 mtime 落在前一天者。
//
// 這支不被 server.js 載入（是排程 agent 從原始碼樹直接 `node` 執行的一次性腳本），
// 讀的是共用的 global-knowledge/schedules 資料，故毋須走 Deploy 上線。
//
// 用法：
//   node portal/render-service/daily-activity.js            # 前一天，輸出素材 markdown
//   node portal/render-service/daily-activity.js --json     # 前一天，輸出結構化 JSON
//   node portal/render-service/daily-activity.js --for=2026-07-04   # 指定某一天（測試用）

const fs   = require('fs');
const path = require('path');
const { SchedulerManager } = require('../scheduler.js');

// harness home（跨工作區的根，才能讀所有工作區的排程與 projects.json）
function resolveHarnessHome(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.HARNESS_HOME) return path.resolve(process.env.HARNESS_HOME);
  return path.resolve(__dirname, '..', '..');
}

// 前一天的本地時間視窗 [昨日 00:00, 今日 00:00)
function computeDayWindow(ref) {
  const now = ref || new Date();
  const end   = new Date(now.getFullYear(), now.getMonth(), now.getDate(),     0, 0, 0, 0);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0, 0);
  return { start, end };
}
// 指定某一日曆日的本地視窗（測試用；month 為 1-12）
function windowForDate(y, m, d) {
  return {
    start: new Date(y, m - 1, d,     0, 0, 0, 0),
    end:   new Date(y, m - 1, d + 1, 0, 0, 0, 0),
  };
}

const normRoot = p => { try { return path.resolve(String(p || '')).toLowerCase(); } catch (e) { return ''; } };

// 本地日曆日字串（YYYY-MM-DD）——不可用 toISOString().slice()，那會把本地 00:00 換算成 UTC、
// 在 UTC+8 下退成前一天（例如 2026-07-04 本地午夜的 ISO 是 2026-07-03T16:00Z）。
function localDateStr(d) {
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// projects.json → 所有工作區清單（比對前一律 resolve；失敗回退成單一 harness home）
function loadWorkspaces(harnessHome) {
  const regPath = path.join(harnessHome, 'global-knowledge', 'projects.json');
  try {
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    if (reg && Array.isArray(reg.projects) && reg.projects.length) {
      return reg.projects
        .filter(p => p && p.root)
        .map(p => ({ name: p.name || path.basename(p.root), root: path.resolve(p.root) }));
    }
  } catch (e) {}
  return [{ name: path.basename(harnessHome), root: path.resolve(harnessHome) }];
}

// 壓平空白 + 截斷，讓素材保持有界（不把整份 transcript / chat 塞給 LLM）
function excerpt(text, limit) {
  limit = limit || 600;
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > limit ? s.slice(0, limit) + ' …' : s;
}

// 該 run 最新一則 transcript artifact 的內容（agent 自己對這次做了什麼的摘要）
function runResultSummary(sched, run) {
  const ids = run.artifactIds || [];
  for (let i = ids.length - 1; i >= 0; i--) {
    const art = sched.getArtifact(run.scheduleId, run.id, ids[i]);
    if (art && art.kind === 'transcript' && art.content) return art.content;
  }
  return '';
}

// 掃一個工作區的 chat_history，回前一天有動過的 .md 檔摘要
function scanChats(root, win) {
  const dir = path.join(root, '.harness', 'runtime', 'chat_history');
  const out = [];
  let files;
  try { files = fs.readdirSync(dir); } catch (e) { return out; }
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    const fp = path.join(dir, f);
    let st; try { st = fs.statSync(fp); } catch (e) { continue; }
    if (!st.isFile()) continue;
    if (st.mtime < win.start || st.mtime >= win.end) continue;
    let content = ''; try { content = fs.readFileSync(fp, 'utf8'); } catch (e) {}
    out.push({ file: f, mtime: st.mtime.toISOString(), bytes: st.size, excerpt: excerpt(content) });
  }
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

const STATUS_LABEL = {
  success: '✅ 成功', failed: '❌ 失敗', 'limited-waiting': '⏳ 等待限額重置',
  running: '🔄 執行中', aborted: '🛑 已中止', interrupted: '⛔ 中斷',
  'pending-resume': '⏸ 待續跑', blocked: '⚠ 受阻·待你',
};

// ── 主彙整 ────────────────────────────────────────────────────────────────
function aggregateDailyActivity(opts) {
  opts = opts || {};
  const harnessHome = resolveHarnessHome(opts.harnessHome);
  const win = opts.window || computeDayWindow(opts.now);

  const sched     = new SchedulerManager(harnessHome);
  const schedules = sched.loadSchedules();
  const schedMap = {}, wsMap = {};
  schedules.forEach(s => { schedMap[s.id] = s.name; wsMap[s.id] = s.workspace; });

  // 以 normalize 後的 root 當 key，先把所有已註冊工作區 + harness home 建成 bucket
  const buckets = new Map(); // key(normRoot) → { name, root, runs:[], chats:[] }
  const ensureBucket = (root, name) => {
    const key = normRoot(root);
    if (!buckets.has(key)) buckets.set(key, { name: name || path.basename(root), root, runs: [], chats: [] });
    return buckets.get(key);
  };
  ensureBucket(harnessHome, 'harness home（' + path.basename(harnessHome) + '）');
  for (const w of loadWorkspaces(harnessHome)) ensureBucket(w.root, w.name);

  // 1) 排程執行紀錄：全量取，反查 workspace 標來源（null workspace = harness home）
  const runs = sched.queryRuns({ since: win.start.toISOString(), until: win.end.toISOString(), limit: 1000 });
  let runCount = 0;
  for (const r of runs) {
    const wsRoot = wsMap[r.scheduleId] || harnessHome; // null → harness home，與 runner 預設一致
    const b = ensureBucket(wsRoot); // 排程指向未登錄工作區時也建 bucket
    b.runs.push({
      scheduleName: schedMap[r.scheduleId] || r.scheduleId,
      startedAt: r.startedAt || '',
      status: r.status || '',
      model: r.model || '',
      runtimeSec: (r.usage && r.usage.runtimeMs) ? Math.round(r.usage.runtimeMs / 1000) : null,
      error: r.error || '',
      resultSummary: excerpt(runResultSummary(sched, r), 800),
    });
    runCount++;
  }

  // 2) 聊天記錄：逐工作區掃 chat_history，前一天動過的 .md
  let chatCount = 0;
  for (const b of buckets.values()) {
    b.chats = scanChats(b.root, win);
    chatCount += b.chats.length;
    b.runs.sort((a, z) => (z.startedAt || '').localeCompare(a.startedAt || ''));
  }

  // 只保留當天真的有事（有 run 或 chat）的工作區
  const workspaces = [...buckets.values()].filter(b => b.runs.length || b.chats.length);

  return {
    generatedAt: new Date().toISOString(),
    harnessHome,
    window: { start: win.start.toISOString(), end: win.end.toISOString(),
              dateLabel: localDateStr(win.start) },
    counts: { workspaces: workspaces.length, runs: runCount, chats: chatCount },
    workspaces,
  };
}

// ── 素材 markdown（餵給草稿生成 prompt 的人/LLM 可讀版本）─────────────────
function formatMaterial(agg) {
  const L = [];
  L.push('=== 前一天跨工作區活動彙整（' + agg.window.dateLabel + '，共 '
    + agg.counts.workspaces + ' 個工作區 / ' + agg.counts.runs + ' 筆排程執行 / '
    + agg.counts.chats + ' 份對話）===');
  if (!agg.workspaces.length) {
    L.push('（前一天沒有偵測到任何排程執行或對話活動。）');
    L.push('=== 彙整結束 ===');
    return L.join('\n');
  }
  for (const w of agg.workspaces) {
    L.push('');
    L.push('## 工作區：' + w.name);
    L.push('路徑：' + w.root);
    if (w.runs.length) {
      L.push('— 排程執行：');
      for (const r of w.runs) {
        const t   = r.startedAt ? r.startedAt.slice(0, 16).replace('T', ' ') : '?';
        const st  = STATUS_LABEL[r.status] || r.status || '?';
        const dur = r.runtimeSec != null ? '，耗時 ' + r.runtimeSec + 's' : '';
        L.push('  · [' + t + '] ' + r.scheduleName + '（' + (r.model || '?') + '）→ ' + st + dur);
        if (r.resultSummary) L.push('    成果：' + r.resultSummary);
        if (r.error)         L.push('    錯誤：' + excerpt(r.error, 300));
      }
    }
    if (w.chats.length) {
      L.push('— 對話記錄（前一天動過的 chat_history）：');
      for (const c of w.chats) {
        const t = c.mtime ? c.mtime.slice(0, 16).replace('T', ' ') : '?';
        L.push('  · [' + t + '] ' + c.file);
        if (c.excerpt) L.push('    摘錄：' + c.excerpt);
      }
    }
  }
  L.push('');
  L.push('=== 彙整結束 ===');
  return L.join('\n');
}

if (require.main === module) {
  const args   = process.argv.slice(2);
  const asJson = args.includes('--json');
  let win;
  const forArg = args.find(a => a.startsWith('--for='));
  if (forArg) {
    const m = /^--for=(\d{4})-(\d{2})-(\d{2})$/.exec(forArg);
    if (!m) { console.error('用法：--for=YYYY-MM-DD'); process.exit(2); }
    win = windowForDate(+m[1], +m[2], +m[3]);
  }
  const agg = aggregateDailyActivity({ window: win });
  process.stdout.write((asJson ? JSON.stringify(agg, null, 2) : formatMaterial(agg)) + '\n');
}

module.exports = {
  aggregateDailyActivity,
  formatMaterial,
  computeDayWindow,
  windowForDate,
  loadWorkspaces,
};

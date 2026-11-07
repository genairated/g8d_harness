'use strict';
const fs = require('fs');
const path = require('path');
const listIndex = require('./list-index');

// Validate and normalise delivery sinks. Unknown sinks are stripped; empty/missing → default.
const _DELIVERY_VALID = ['web', 'telegram'];
function _normalizeDelivery(d) {
  const arr = Array.isArray(d) ? [...new Set(d.filter(s => _DELIVERY_VALID.includes(s)))] : null;
  return (arr && arr.length) ? arr : ['web', 'telegram'];
}

// ── SinkManager — pluggable delivery abstraction ──────────────────────────
// Run 完成時把摘要+連結投到各 sink（web / telegram / …）。
// 要接 Telegram（§C）只需：schedulerManager.sinkManager.register('telegram', fn)
class SinkManager {
  constructor() { this._sinks = new Map(); }
  register(name, fn) { this._sinks.set(name, fn); }
  has(name) { return this._sinks.has(name); }
  deliver(sinkNames, payload) {
    const names = (Array.isArray(sinkNames) && sinkNames.length) ? sinkNames : ['web'];
    for (const name of names) this.deliverOne(name, payload);
  }
  // Deliver to ONE sink; resolves true only if a sink fn exists AND its send completed without
  // throwing/rejecting — so the caller can mark that sink delivered (B4 per-sink idempotency).
  // AWAITs the fn so async sinks (telegram: a network send) are only counted delivered once the
  // send actually finished — a fire-and-forget send aborted by a deploy-restart resolves false here
  // and stays pending. Unregistered sink → false (e.g. telegram before §C wires it in).
  async deliverOne(name, payload) {
    const fn = this._sinks.get(name);
    if (!fn) return false;
    try { await fn(payload); return true; }
    catch (e) { console.error('[Sink:' + name + '] delivery error:', e.message); return false; }
  }
}

// ── Minimal 5-field cron field parser ────────────────────────────────────
// Supported: number, *, */N, A-B（範圍）, A,B,C（清單，遞迴解析每段）, A-B/N（範圍內每隔 N）
// 標準 Vixie cron 子集，見 specs/SPEC-scheduler.md §2.1.1。無效輸入一律回退成 [min]。
function parseCronField(expr, min, max) {
  if (expr.indexOf(',') !== -1) {
    const parts = expr.split(',');
    const set = new Set();
    for (const p of parts) {
      for (const v of parseCronField(p, min, max)) set.add(v);
    }
    if (!set.size) return [min];
    return Array.from(set).sort((a, b) => a - b);
  }
  if (expr === '*') {
    const r = []; for (let i = min; i <= max; i++) r.push(i); return r;
  }
  if (expr.startsWith('*/')) {
    const step = parseInt(expr.slice(2), 10);
    if (!step || step <= 0) return [min];
    const r = []; for (let i = min; i <= max; i += step) r.push(i); return r;
  }
  const rangeStepMatch = expr.match(/^(\d+)-(\d+)\/(\d+)$/);
  if (rangeStepMatch) {
    const lo = parseInt(rangeStepMatch[1], 10);
    const hi = parseInt(rangeStepMatch[2], 10);
    const step = parseInt(rangeStepMatch[3], 10);
    if (lo > hi || lo < min || hi > max || !step || step <= 0) return [min];
    const r = []; for (let i = lo; i <= hi; i += step) r.push(i); return r;
  }
  const rangeMatch = expr.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const lo = parseInt(rangeMatch[1], 10);
    const hi = parseInt(rangeMatch[2], 10);
    if (lo > hi || lo < min || hi > max) return [min];
    const r = []; for (let i = lo; i <= hi; i++) r.push(i); return r;
  }
  const v = parseInt(expr, 10);
  if (!isNaN(v) && v >= min && v <= max) return [v];
  return [min];
}

// Returns the next Date after `after` matching the 5-field cron expr, or null.
function cronNextAfter(expr, after) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const mins   = parseCronField(parts[0], 0, 59);
  const hours  = parseCronField(parts[1], 0, 23);
  const doms   = parseCronField(parts[2], 1, 31);
  const months = parseCronField(parts[3], 1, 12);
  const dows   = parseCronField(parts[4], 0, 6);

  // Advance 1 minute past 'after' and start checking
  let d = new Date(after);
  d.setSeconds(0, 0);
  d = new Date(d.getTime() + 60000);

  const MAX_ITER = 366 * 24 * 60; // at most 1 year of minutes
  for (let i = 0; i < MAX_ITER; i++, d = new Date(d.getTime() + 60000)) {
    if (months.includes(d.getMonth() + 1) &&
        doms.includes(d.getDate()) &&
        dows.includes(d.getDay()) &&
        hours.includes(d.getHours()) &&
        mins.includes(d.getMinutes())) {
      return d;
    }
  }
  return null;
}

function computeNextRunAt(trigger, from) {
  const base = from || new Date();
  if (!trigger) return null;
  if (trigger.type === 'once') {
    // accept common field-name variants — agents writing the schedule via the API often guess
    // `at`/`atUTC` instead of the canonical `atISO`; treat them all the same (else nextRunAt=null silently).
    const t = new Date(trigger.atISO || trigger.at || trigger.atUTC || trigger.datetime);
    return isNaN(t.getTime()) || t <= base ? null : t;
  }
  if (trigger.type === 'interval') {
    const ms = trigger.intervalMs || trigger.everyMs ||
      (trigger.minutes ? trigger.minutes * 60000 : 0) || (trigger.seconds ? trigger.seconds * 1000 : 0) || 3600000;
    return new Date(base.getTime() + ms);
  }
  if (trigger.type === 'cron') {
    return cronNextAfter(trigger.expr || trigger.cron || trigger.expression || '0 * * * *', base);
  }
  return null;
}

// ── SchedulerManager ─────────────────────────────────────────────────────

class SchedulerManager {
  constructor(harnessHome) {
    this.harnessHome        = harnessHome;
    this.schedulesDir       = path.join(harnessHome, 'global-knowledge', 'schedules');
    this.schedulesPath      = path.join(this.schedulesDir, 'schedules.json');
    this.runsDir            = path.join(this.schedulesDir, 'runs');
    this.notificationsPath  = path.join(this.schedulesDir, 'notifications.json');
    this.sinkManager        = new SinkManager();
    this._fireJob           = null;
    this._timer             = null;
    this._onChange          = null;   // SLV-1: optional change-notification listener, default no-op
    // IDX-RUN (SPEC-list-index.md §9.1): 執行記錄目錄。_runMem＝現役（未歸檔）排程的執行記錄摘要，
    // _running＝其中 status 'running' 的那幾筆；兩者在 start() 對帳＋warmRunIndex() 後才算可信（_runMemWarm）。
    this._runMem            = new Map();   // runId → { wsKey, e: 摘要 }
    this._running           = new Map();   // runId → 摘要
    this._runMemWarm        = false;
    this._schedWsSig        = null;
    this._schedWsMap        = new Map();   // scheduleId → { wsKey, wsRaw, archived, fromChat, chatOrigin }
    // IDX-SCH (SPEC-list-index.md §9.2): 排程清單目錄。_schedSnap＝上次同步時每筆排程的指紋（id → {wsKey,wsRaw,archived,sig}），
    // saveSchedules() 以它做差異比對、只同步有變的那幾筆；_schedWsRoots＝目前出現過的工作區（供 deploy-targets 跨區列舉）。
    this._schedSnap         = null;
    this._schedWsRoots      = new Map();   // wsKey → wsRaw
    this._schedWarm         = false;
    this._ensure();
    this._registerRunsIndex();
    this._registerSchedulesIndex();
  }

  // SLV-1: register a listener invoked on run-start / run-update (incl. run-end, since the final
  // status write also goes through updateRun()). Payload: { reason, scheduleId, runId, workspace }.
  // Never throws if unset; a throwing listener is swallowed so it can't break scheduler operation.
  setChangeListener(fn) {
    this._onChange = (typeof fn === 'function') ? fn : null;
  }

  _emitChange(reason, scheduleId, runId) {
    if (!this._onChange) return;
    let workspace = null;
    try {
      const s = this.getSchedule(scheduleId);
      workspace = s ? (s.workspace || null) : null;
    } catch (e) {}
    try { this._onChange({ reason, scheduleId, runId, workspace }); } catch (e) {}
  }

  _ensure() {
    try {
      fs.mkdirSync(this.schedulesDir, { recursive: true });
      fs.mkdirSync(this.runsDir,      { recursive: true });
      if (!fs.existsSync(this.schedulesPath))
        fs.writeFileSync(this.schedulesPath, JSON.stringify([], null, 2));
    } catch (e) { console.error('[Scheduler] init error:', e.message); }
  }

  // ── Schedule CRUD ──────────────────────────────────────────────────────

  loadSchedules() {
    try { return JSON.parse(fs.readFileSync(this.schedulesPath, 'utf8')); }
    catch (e) { return []; }
  }

  // IDX-SCH：非同步讀取（清單 API 的保底路徑用，不卡伺服器）。
  async loadSchedulesAsync() {
    try { return JSON.parse(await fs.promises.readFile(this.schedulesPath, 'utf8')); }
    catch (e) { return []; }
  }

  // 所有寫入 schedules.json 的路徑（createSchedule／updateSchedule／deleteSchedule／歸檔還原／排程器跑完回寫／
  // 續跑／對帳／server.js 的 postRun 回寫）最後都走這裡，所以目錄同步只掛這一個出口（規格 §2 第 3 條）。
  // 順序：業務檔先寫成功，再同步目錄；目錄同步失敗只記 log，永不影響業務寫入。
  saveSchedules(list) {
    let prev = this._schedSnap;
    if (!prev) {   // 本行程第一次寫入：趁覆寫前讀一次舊檔當比對基準（只此一次）
      try { prev = this._buildSchedSnap(JSON.parse(fs.readFileSync(this.schedulesPath, 'utf8'))).snap; }
      catch (e) { prev = new Map(); }
    }
    fs.writeFileSync(this.schedulesPath, JSON.stringify(list, null, 2));
    try { this._syncSchedIndex(list, prev); }
    catch (e) { console.error('[Scheduler] schedules index sync error:', e.message); }
  }

  getSchedule(id) {
    return this.loadSchedules().find(s => s.id === id) || null;
  }

  createSchedule(data) {
    const list = this.loadSchedules();
    const now  = new Date();
    const resolvedTrigger = data.trigger || { type: 'cron', expr: '0 * * * *' };
    const s = {
      id:        'sched_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      name:      data.name      || '未命名排程',
      enabled:   data.enabled   !== false,
      trigger:   resolvedTrigger,
      task:      data.task      || { kind: 'prompt', prompt: '' },
      model:     data.model     || 'claude::sonnet',
      workspace: data.workspace || null,
      guardrails: Object.assign(
        { maxCalls: 100, maxRuntimeMs: 300000, maxResumes: 3, failureBreakAfter: 3 },
        data.guardrails || {}
      ),
      delivery:           _normalizeDelivery(data.delivery),
      chainNext:          data.chainNext || null,   // SCHED-CHAIN: 本排程真正 success 後自動接續的排程 id（可為 null）
      // CBG-1: 由對話觸發的「一次性背景任務」標記 + 來源對話識別。chatTask=true 時 GET /api/schedules
      // 要把它濾掉（不混進排程清單），但仍是一筆完整的 Schedule（沿用既有排程器執行，D4）。
      // CBGV-3（SPEC-chat-background-task.md §3.6.2）：週期性（cron）排程永遠不能被藏起來——即使
      // 呼叫端誤傳 chatTask:true，只要 trigger 是 cron 就強制降為 false，避免指揮官主動要的定時任務
      // 消失在排程清單裡。這裡用 trigger.type（而非 data.trigger）取值，因為上面已經套過預設值。
      chatTask:           (data.chatTask === true && resolvedTrigger.type !== 'cron'),
      origin:             data.origin || null,       // { kind:'chat', sessionId, workspace }
      // SCHED-DEPLOY (D1-D4): 本排程 run 成功後由 server（不是模型）執行 Deploy_Harness.ps1。
      // server.js 的 POST/PUT /api/schedules 已驗證過 shape/D2 不變式，這裡再兜底一次 boolean 化。
      postRun:            Object.assign({ deploy: !!(data.postRun && data.postRun.deploy === true) },
                            // SCHED-DEPLOY-NEXT §4.8：已由 server 驗證（存在、非自己、deploy=true 才有）
                            (data.postRun && data.postRun.deploy === true && typeof data.postRun.nextAfterDeploy === 'string' && data.postRun.nextAfterDeploy)
                              ? { nextAfterDeploy: data.postRun.nextAfterDeploy } : {}),
      lastDeployStatus:   null,   // 'success' | 'failed' | 'unknown' | null
      lastDeployAt:       null,
      createdAt:          now.toISOString(),
      nextRunAt:          null,
      lastRunAt:          null,
      lastRunStatus:      null,
      consecutiveFailures: 0,
      archived:           false,   // 歸檔後移到「歷史」、不再現役（執行完的 once 排程可手動歸檔）
    };
    s.nextRunAt = s.enabled
      ? (computeNextRunAt(s.trigger, now)?.toISOString() || null)
      : null;
    list.push(s);
    this.saveSchedules(list);
    return s;
  }

  updateSchedule(id, patch) {
    const list = this.loadSchedules();
    const idx  = list.findIndex(s => s.id === id);
    if (idx < 0) return null;
    Object.assign(list[idx], patch);
    // Recompute nextRunAt when trigger or enabled changes
    if ('trigger' in patch || 'enabled' in patch) {
      list[idx].nextRunAt = list[idx].enabled
        ? (computeNextRunAt(list[idx].trigger, new Date())?.toISOString() || null)
        : null;
    }
    this.saveSchedules(list);
    return list[idx];
  }

  deleteSchedule(id) {
    const list = this.loadSchedules();
    const idx  = list.findIndex(s => s.id === id);
    if (idx < 0) return false;
    list.splice(idx, 1);
    this.saveSchedules(list);
    return true;
  }

  // ── IDX-SCH：排程清單目錄（SPEC-list-index.md §9.2）──────────────────────────
  // 實際檔案（schedules.json）仍是真相；目錄＝每個工作區兩份：
  //   global-knowledge/schedules/index/<ws 雜湊>/schedules.json（現役）＋schedules.archive.json（archived:true）。
  // 清單欄位＝排程本體去掉 task.prompt（改放 taskKind 與前 120 字 taskPreview）、pendingResume.partial（最多 8000 字）。

  _schedListEntry(s) {
    const e = Object.assign({}, s);
    const t = (s.task && typeof s.task === 'object') ? s.task : {};
    const prompt = typeof t.prompt === 'string' ? t.prompt : '';
    e.task = Object.assign({}, t); delete e.task.prompt;
    e.taskKind = t.kind || 'prompt';
    e.taskPreview = (prompt || [t.skill, t.args].filter(Boolean).join(' ')).slice(0, 120);
    if (e.pendingResume && typeof e.pendingResume === 'object') {
      e.pendingResume = Object.assign({}, e.pendingResume); delete e.pendingResume.partial;
    }
    return e;
  }

  // list → { snap: Map(id → {wsKey,wsRaw,archived,sig}), entries: Map(id → entry) }
  _buildSchedSnap(list) {
    const snap = new Map(), entries = new Map();
    for (const s of (Array.isArray(list) ? list : [])) {
      if (!s || !s.id) continue;
      const wsRaw = s.workspace || this.harnessHome;   // null workspace ＝ harness home
      const entry = this._schedListEntry(s);
      snap.set(s.id, { wsKey: this._normWsKey(wsRaw), wsRaw, archived: !!s.archived, sig: JSON.stringify(entry) });
      entries.set(s.id, entry);
    }
    return { snap, entries };
  }

  _syncSchedIndex(list, prev) {
    const { snap, entries } = this._buildSchedSnap(list);
    const handle = (wsRaw) => listIndex.getIndex('schedules', wsRaw);
    for (const [id, n] of snap) {
      this._schedWsRoots.set(n.wsKey, n.wsRaw);
      const p = prev.get(id);
      if (p && p.sig === n.sig) continue;
      if (p && p.wsKey !== n.wsKey) { const ho = handle(p.wsRaw); if (ho) ho.remove(id).catch(() => {}); }   // 搬了工作區
      const h = handle(n.wsRaw);
      if (h) h.upsert(entries.get(id)).catch(() => {});
      if (p && p.archived !== n.archived) this.syncRunsArchiveFlag(id).catch(() => {});   // IDX-RUN D5：歸檔／還原連動執行記錄目錄
    }
    for (const [id, p] of prev) {
      if (snap.has(id)) continue;
      const h = handle(p.wsRaw); if (h) h.remove(id).catch(() => {});   // 刪除
    }
    this._schedSnap = snap;
  }

  async _scanSchedulesForWorkspace(wsRoot) {
    const key = this._normWsKey(wsRoot);
    const mine = (await this.loadSchedulesAsync()).filter(s => s && s.id && this._normWsKey(s.workspace || this.harnessHome) === key);
    return listIndex.eachYield(mine, async (s) => this._schedListEntry(s));
  }

  // 指紋＝schedules.json 大小＋修改時間（§5.2）。單一大檔被所有工作區共用，所以別區寫入也會讓本區下次開機多重建一次（便宜、正確）。
  async _schedFingerprint() {
    try { const st = await fs.promises.stat(this.schedulesPath); return st.size + ':' + Math.round(st.mtimeMs); }
    catch (e) { return 'missing'; }
  }

  _registerSchedulesIndex() {
    try {
      listIndex.registerIndexKind('schedules', (wsRoot) => {
        const dir = listIndex.sharedIndexDirFor(this.schedulesDir, wsRoot);
        return listIndex.open({
          kind: 'schedules',
          indexPath: path.join(dir, 'schedules.json'),
          archivePath: path.join(dir, 'schedules.archive.json'),
          workspace: wsRoot,
          scanSource: () => this._scanSchedulesForWorkspace(wsRoot),
          fingerprintSource: () => this._schedFingerprint(),
          isArchived: (e) => !!e.archived,
          // 與檔案順序（＝建立順序）一致；id 內含時間戳，createdAt 相同時再以 id 定序。
          sort: (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)),
        });
      });
    } catch (e) { console.error('[Scheduler] register schedules index error:', e.message); }
  }

  // 啟動後背景暖機：建比對基準、核對每個出現過的工作區的目錄（對不上就重建）。完成前清單走保底（非同步讀主檔）。
  async warmSchedIndex() {
    const t0 = Date.now();
    try {
      const list = await this.loadSchedulesAsync();
      if (!this._schedSnap) this._schedSnap = this._buildSchedSnap(list).snap;
      const roots = new Map([[this._normWsKey(this.harnessHome), this.harnessHome]]);
      for (const n of this._schedSnap.values()) if (!roots.has(n.wsKey)) roots.set(n.wsKey, n.wsRaw);
      for (const [k, v] of roots) this._schedWsRoots.set(k, v);
      let total = 0, rebuilt = 0;
      for (const wsRaw of roots.values()) {
        const h = listIndex.getIndex('schedules', wsRaw);
        if (!h) throw new Error('schedules index not registered');
        const v = await h.verify();
        if (v && v.rebuilt) rebuilt++;
        let r = await h.list();
        if (r.fallback) { await h.rebuild({ reason: 'warm' }); r = await h.list(); }
        if (r.fallback) throw new Error('schedules index unreadable for ' + wsRaw);
        total += r.items.length;
      }
      this._schedWarm = true;
      console.log('[Scheduler] schedules index warm: ' + roots.size + ' workspace(s), ' + total + ' active, rebuilt ' + rebuilt + ', ' + (Date.now() - t0) + 'ms');
    } catch (e) {
      console.error('[Scheduler] schedules index warm failed (清單維持讀主檔保底):', e.message);
    }
  }

  // 清單 API 用：→ { items, archivedCount, fallback }。目錄壞了／不存在 → 保底（非同步讀主檔，同樣的欄位形狀）。
  async listSchedulesForWorkspace(wsRoot, archived) {
    const h = listIndex.getIndex('schedules', wsRoot);
    if (h) {
      try {
        const r = archived ? await h.listArchived() : await h.list();
        if (!r.fallback) {
          const st = await h.status();
          return { items: r.items, archivedCount: st.archivedCount || 0, fallback: false };
        }
      } catch (e) { /* 走保底 */ }
    }
    const key = this._normWsKey(wsRoot);
    const mine = (await this.loadSchedulesAsync()).filter(s => s && this._normWsKey(s.workspace || this.harnessHome) === key);
    return {
      items: mine.filter(s => !!s.archived === !!archived).map(s => this._schedListEntry(s)),
      archivedCount: mine.filter(s => s.archived).length,
      fallback: true,
    };
  }

  // deploy-targets 用：所有工作區的現役排程（目錄版）。任一份目錄不可讀 → 回 null，呼叫端走保底。
  async listActiveSchedulesAllWorkspaces() {
    if (!this._schedWarm) return null;
    const out = [];
    for (const wsRaw of this._schedWsRoots.values()) {
      const h = listIndex.getIndex('schedules', wsRaw);
      if (!h) return null;
      const r = await h.list();
      if (r.fallback) return null;
      for (const e of r.items) out.push(e);
    }
    return out;
  }

  // ── IDX-RUN：執行記錄目錄（SPEC-list-index.md §9.1）──────────────────────────
  // 實際檔案（runs/<排程id>/<執行id>.json）仍是真相；目錄只是加在旁邊的快取：
  //   global-knowledge/schedules/index/<ws 雜湊>/runs.json（現役排程的執行記錄）＋runs.archive.json（已歸檔排程，D5）。
  // 記憶體：_runMem（現役摘要）＋_running（執行中）。warmRunIndex() 完成後清單查詢全走記憶體，不再逐檔讀。

  _normWsKey(p) {
    try { return listIndex.normalizeWorkspace(p, this.harnessHome); } catch (e) { return String(p || '').toLowerCase(); }
  }

  _mkSchedInfo(s) {
    const wsRaw = s.workspace || this.harnessHome;   // null workspace ＝ harness home
    const hasChatOrigin = !!(s.origin && s.origin.kind === 'chat' && s.origin.sessionId);
    return {
      wsRaw, wsKey: this._normWsKey(wsRaw), archived: !!s.archived, name: s.name,
      chatTask: s.chatTask === true,
      chatOrigin: hasChatOrigin ? this._pickOrigin(s.origin) : null,
    };
  }

  _pickOrigin(o) {
    if (!o || typeof o !== 'object') return null;
    const out = {};
    for (const k of ['kind', 'sessionId', 'channel', 'chatId']) if (o[k] !== undefined && o[k] !== null) out[k] = o[k];
    return out;
  }

  // scheduleId → 工作區等資訊；以 schedules.json「大小＋修改時間」當指紋，沒變就用快取（只 stat 一次）。
  _schedInfo(scheduleId) {
    let sig = null;
    try { const st = fs.statSync(this.schedulesPath); sig = st.size + ':' + st.mtimeMs; } catch (e) {}
    if (sig === null || sig !== this._schedWsSig) {
      const map = new Map();
      for (const s of this.loadSchedules()) map.set(s.id, this._mkSchedInfo(s));
      this._schedWsMap = map; this._schedWsSig = sig;
    }
    return this._schedWsMap.get(scheduleId) || null;
  }

  // 清單欄位（§9.1）：不放 resolvedPrompt／輸出／delivery 等大欄位。
  _runEntry(run, info) {
    const o = run.origin || null;
    let origin = this._pickOrigin(o);
    let fromChat = false;
    if (info) {
      // 與舊 GET /api/runs 的標註規則相同：chatTask 排程 → fromChat；排程帶對話 origin → fromChat，
      // 且 run 自己沒帶 sessionId 時用排程的 origin 回填。
      if (info.chatTask) fromChat = true;
      else if (info.chatOrigin) { fromChat = true; if (!(o && o.sessionId)) origin = info.chatOrigin; }
    }
    return {
      id: run.id, scheduleId: run.scheduleId, status: run.status,
      startedAt: run.startedAt || null, finishedAt: run.finishedAt || null,
      trigger: run.trigger || 'auto', model: run.model || '', resumeCount: run.resumeCount || 0,
      origin, fromChat,
      hasCandidate: !!run.hasCandidate, candidateReviewed: false, candidateNoteworthy: false,
      usage: { calls: (run.usage && run.usage.calls) || 0, runtimeMs: (run.usage && run.usage.runtimeMs) || 0 },
      archived: !!(info && info.archived),
    };
  }

  _registerRunsIndex() {
    try {
      listIndex.registerIndexKind('runs', (wsRoot) => {
        const dir = listIndex.sharedIndexDirFor(this.schedulesDir, wsRoot);
        return listIndex.open({
          kind: 'runs',
          indexPath: path.join(dir, 'runs.json'),
          archivePath: path.join(dir, 'runs.archive.json'),
          workspace: wsRoot,
          scanSource: () => this._scanRunsForWorkspace(wsRoot),
          fingerprintSource: () => this._runsFingerprint(wsRoot),
          isArchived: (e) => !!e.archived,
          sort: (a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''),
        });
      });
    } catch (e) { console.error('[Scheduler] register runs index error:', e.message); }
  }

  // 列出 runs/ 底下每個排程資料夾的檔名（只 readdir，不開檔）。→ [{ sid, files:['run_x.json'] }]
  async _listRunFiles() {
    const fp = fs.promises;
    let sids = [];
    try { sids = (await fp.readdir(this.runsDir, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name); }
    catch (e) { return []; }
    return listIndex.eachYield(sids, async (sid) => {
      try {
        const files = (await fp.readdir(path.join(this.runsDir, sid))).filter(f => f.endsWith('.json'));
        return { sid, files };
      } catch (e) { return undefined; }
    });
  }

  // 重建用：掃實際檔案，只收「屬於該工作區」的執行記錄。找不到排程的執行記錄歸 harness home 並記進報告。
  async _scanRunsForWorkspace(wsRoot) {
    const key = this._normWsKey(wsRoot);
    const homeKey = this._normWsKey(this.harnessHome);
    const infos = new Map();
    for (const s of this.loadSchedules()) infos.set(s.id, this._mkSchedInfo(s));
    const groups = await this._listRunFiles();
    const orphanSchedules = [];
    const todo = [];
    for (const g of groups) {
      const info = infos.get(g.sid) || null;
      if (!info && !orphanSchedules.includes(g.sid)) orphanSchedules.push(g.sid);
      if ((info ? info.wsKey : homeKey) !== key) continue;
      for (const f of g.files) todo.push({ sid: g.sid, f, info });
    }
    const fp = fs.promises;
    const entries = await listIndex.eachYield(todo, async (t) => {
      let run;
      try { run = JSON.parse(await fp.readFile(path.join(this.runsDir, t.sid, t.f), 'utf8')); } catch (e) { return undefined; }
      if (!run || !run.id) return undefined;
      const e = this._runEntry(run, t.info);
      if (e.hasCandidate) {
        try {
          const c = JSON.parse(await fp.readFile(path.join(this.runsDir, t.sid, run.id, 'candidate.json'), 'utf8'));
          e.candidateReviewed = !!(c && c.reviewed);
          e.candidateNoteworthy = !!(c && c.noteworthy);   // IDX-CAND：重建時從 candidate.json 回填
        } catch (er) {}
      }
      return e;
    });
    this._lastRunsRebuildReport = { workspace: wsRoot, at: new Date().toISOString(), count: entries.length, orphanSchedules: key === homeKey ? orphanSchedules : [] };
    if (key === homeKey && orphanSchedules.length)
      console.log('[Scheduler] runs index: ' + orphanSchedules.length + ' 個執行記錄資料夾找不到對應排程，歸入 harness home：' + orphanSchedules.slice(0, 10).join(', ') + (orphanSchedules.length > 10 ? ' …' : ''));
    return entries;
  }

  // 核對用指紋（§5.2）：只看檔名。第一次實際 readdir 全部資料夾，之後靠 createRun 增量維護（執行記錄只增不刪）。
  async _runsFingerprint(wsRoot) {
    const key = this._normWsKey(wsRoot);
    if (!this._runIdSets) {
      if (!this._runIdScan) {
        this._runIdScan = (async () => {
          const infos = new Map();
          for (const s of this.loadSchedules()) infos.set(s.id, this._mkSchedInfo(s));
          const homeKey = this._normWsKey(this.harnessHome);
          const sets = new Map();
          for (const g of await this._listRunFiles()) {
            const info = infos.get(g.sid);
            const k = info ? info.wsKey : homeKey;
            if (!sets.has(k)) sets.set(k, new Set());
            const set = sets.get(k);
            for (const f of g.files) set.add(f.slice(0, -5));
          }
          for (const [k, id] of (this._runIdPending || [])) { if (!sets.has(k)) sets.set(k, new Set()); sets.get(k).add(id); }
          this._runIdPending = null;
          this._runIdSets = sets;
        })().catch((e) => { this._runIdScan = null; throw e; });
      }
      await this._runIdScan;
    }
    return listIndex.idSetFingerprint(Array.from(this._runIdSets.get(key) || []));
  }

  _runIdAdd(wsKey, id) {
    if (this._runIdSets) { if (!this._runIdSets.has(wsKey)) this._runIdSets.set(wsKey, new Set()); this._runIdSets.get(wsKey).add(id); }
    else (this._runIdPending = this._runIdPending || []).push([wsKey, id]);
  }

  // 每條寫入路徑（createRun／updateRun／saveMemoryCandidate）呼叫：同步更新記憶體，再排入目錄 upsert。
  _trackRun(run, extra) {
    try {
      if (!run || !run.id || !run.scheduleId) return;
      const info = this._schedInfo(run.scheduleId);
      const wsRaw = info ? info.wsRaw : this.harnessHome;
      const wsKey = info ? info.wsKey : this._normWsKey(this.harnessHome);
      const prev = this._runMem.get(run.id);
      const e = this._runEntry(run, info);
      e.candidateReviewed = (extra && 'candidateReviewed' in extra) ? !!extra.candidateReviewed : !!(prev && prev.e.candidateReviewed);
      // IDX-CAND：沿用舊值；舊目錄檔沒有此欄位（undefined）時維持 undefined＝「未知，要讀檔確認」
      e.candidateNoteworthy = (extra && 'candidateNoteworthy' in extra) ? !!extra.candidateNoteworthy : (prev ? prev.e.candidateNoteworthy : undefined);
      const wrap = { wsKey, e };
      if (e.archived) this._runMem.delete(run.id); else this._runMem.set(run.id, wrap);
      if (e.status === 'running') this._running.set(run.id, wrap); else this._running.delete(run.id);
      const h = listIndex.getIndex('runs', wsRaw);
      if (h) h.upsert(e).catch(() => {});
    } catch (er) { console.error('[Scheduler] runs index track error:', er.message); }
  }

  // 排程被歸檔／還原時，IDX-SCH 呼叫：把該排程所有執行記錄搬進／搬出歸檔目錄（D5）。
  async syncRunsArchiveFlag(scheduleId) {
    try {
      const info = this._schedInfo(scheduleId);
      const fp = fs.promises;
      let files = [];
      try { files = (await fp.readdir(path.join(this.runsDir, scheduleId))).filter(f => f.endsWith('.json')); } catch (e) { return 0; }
      for (const f of files) {
        try { this._trackRun(JSON.parse(await fp.readFile(path.join(this.runsDir, scheduleId, f), 'utf8'))); } catch (e) {}
      }
      return files.length;
    } catch (e) { return 0; }
  }

  // 啟動後背景暖機：核對（對不上就重建）→ 把現役排程的執行記錄載入記憶體。完成前清單查詢走舊的逐檔讀取。
  async warmRunIndex() {
    const t0 = Date.now();
    try {
      const wsRoots = new Map();
      wsRoots.set(this._normWsKey(this.harnessHome), this.harnessHome);
      for (const s of this.loadSchedules()) {
        const i = this._mkSchedInfo(s);
        if (!i.archived && !wsRoots.has(i.wsKey)) wsRoots.set(i.wsKey, i.wsRaw);
      }
      let total = 0;
      for (const wsRaw of wsRoots.values()) {
        const h = listIndex.getIndex('runs', wsRaw);
        if (!h) throw new Error('runs index not registered');
        await h.verify();
        let r = await h.list();
        if (r.fallback) { await h.rebuild({ reason: 'warm' }); r = await h.list(); }
        if (r.fallback) throw new Error('runs index unreadable for ' + wsRaw);
        const wsKey = this._normWsKey(wsRaw);
        for (const e of r.items) {
          if (this._runMem.has(e.id)) continue;      // 開機後已被更新過的以記憶體為準
          this._runMem.set(e.id, { wsKey, e });      // 目錄裡的 running 不採信：執行中以本行程的 _running 為準
          total++;
        }
      }
      this._runMemWarm = true;
      console.log('[Scheduler] runs index warm: ' + total + ' run(s) in ' + (Date.now() - t0) + 'ms');
    } catch (e) {
      console.error('[Scheduler] runs index warm failed (清單維持逐檔讀取):', e.message);
    }
  }

  // ── Run CRUD ───────────────────────────────────────────────────────────

  createRun(scheduleId, opts = {}) {
    const runId = 'run_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const runDir = path.join(this.runsDir, scheduleId, runId);
    fs.mkdirSync(runDir, { recursive: true });
    const run = {
      id:             runId,
      scheduleId,
      startedAt:      new Date().toISOString(),
      finishedAt:     null,
      status:         'running',
      trigger:        opts.trigger        || 'auto',  // 'auto' (排程到點/續跑) | 'manual' (/run 立即執行)
      model:          opts.model          || '',
      resolvedPrompt: opts.resolvedPrompt || '',
      usage:          { calls: 0, runtimeMs: 0 },
      jobId:          opts.jobId          || null,
      resumeCount:    opts.resumeCount    || 0,
      previousRunId:  opts.previousRunId  || null,
      artifactIds:    [],
      error:          null,
      // TGC10-02: which conversation manually triggered this run, e.g. {channel:'telegram',chatId,
      // sessionId} — null for auto ticks/resumes and manual triggers that didn't pass one.
      origin:         opts.origin || null,
    };
    fs.writeFileSync(
      path.join(this.runsDir, scheduleId, runId + '.json'),
      JSON.stringify(run, null, 2)
    );
    // IDX-RUN：業務檔先寫成功，再更新目錄與記憶體。
    this._trackRun(run);
    try { const inf = this._schedInfo(scheduleId); this._runIdAdd(inf ? inf.wsKey : this._normWsKey(this.harnessHome), runId); } catch (e) {}
    this._emitChange('run-start', scheduleId, runId);
    return { run, runDir };
  }

  updateRun(scheduleId, runId, patch) {
    const runPath = path.join(this.runsDir, scheduleId, runId + '.json');
    try {
      const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
      Object.assign(run, patch);
      fs.writeFileSync(runPath, JSON.stringify(run, null, 2));
      this._trackRun(run);   // IDX-RUN
      // SLV-1: covers both mid-run state/progress updates AND run-end (the final status write
      // — status/finishedAt — also goes through this same function).
      this._emitChange('run-update', scheduleId, runId);
      return run;
    } catch (e) {
      console.error('[Scheduler] updateRun error:', e.message);
      return null;
    }
  }

  getRun(scheduleId, runId) {
    try {
      return JSON.parse(fs.readFileSync(
        path.join(this.runsDir, scheduleId, runId + '.json'), 'utf8'
      ));
    } catch (e) { return null; }
  }

  getRuns(scheduleId, limit = 50) {
    const dir = path.join(this.runsDir, scheduleId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { return null; } })
      .filter(Boolean)
      .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))
      .slice(0, limit);
  }

  saveArtifact(scheduleId, runId, kind, content) {
    const artId  = 'art_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const artDir = path.join(this.runsDir, scheduleId, runId);
    fs.mkdirSync(artDir, { recursive: true });
    fs.writeFileSync(
      path.join(artDir, artId + '.json'),
      JSON.stringify({ id: artId, runId, kind, content, createdAt: new Date().toISOString() }, null, 2)
    );
    // Append to run's artifactIds
    const runPath = path.join(this.runsDir, scheduleId, runId + '.json');
    try {
      const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
      (run.artifactIds = run.artifactIds || []).push(artId);
      fs.writeFileSync(runPath, JSON.stringify(run, null, 2));
    } catch (e) {}
    return artId;
  }

  getArtifact(scheduleId, runId, artId) {
    try {
      return JSON.parse(fs.readFileSync(
        path.join(this.runsDir, scheduleId, runId, artId + '.json'), 'utf8'
      ));
    } catch (e) { return null; }
  }

  // ── Scheduler loop ─────────────────────────────────────────────────────

  setFireJob(fn) { this._fireJob = fn; }

  start() {
    this.reconcileOrphanRuns();  // clear phantom 'running' from a prior process before anything fires
    this.warmRunIndex();         // IDX-RUN：背景載入執行記錄目錄（不 await；完成前查詢走舊路徑）
    this.warmSchedIndex();       // IDX-SCH：背景核對排程清單目錄（不 await；完成前清單走保底）
    this._tickWithMissedRun(); // immediate check on startup (missed-run + due runs)
    this._timer = setInterval(() => this._tick(), 60000);
    if (this._timer.unref) this._timer.unref(); // don't prevent process exit
    console.log('[Scheduler] loop started (tick every 60s)');
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  // On startup: if nextRunAt is in the past (up to 24h), fire once as a missed-run.
  _tickWithMissedRun() {
    const now      = new Date();
    const cutoff   = new Date(now.getTime() - 24 * 3600 * 1000); // 24h window
    const list     = this.loadSchedules();
    let   changed  = false;
    for (const s of list) {
      // Fire overdue pending resumes on startup; skip regular run while any resume is pending
      if (s.pendingResume) {
        if (new Date(s.pendingResume.atISO) <= now) {
          console.log(`[Scheduler] ${s.id} (${s.name}) firing missed resume #${s.pendingResume.resumeCount} from startup`);
          const pr = s.pendingResume;
          s.pendingResume = null;
          changed = true;
          this.saveSchedules(list);
          this._firePendingResume(s, pr);
        }
        continue;
      }

      if (!s.enabled || !s.nextRunAt) continue;
      const next = new Date(s.nextRunAt);
      if (next > now) continue; // not yet due
      if (next < cutoff) {
        // Missed more than 24h ago → skip, advance nextRunAt
        console.log(`[Scheduler] ${s.id} (${s.name}) missed by >24h — skipping, advancing nextRunAt`);
      } else {
        // Missed within 24h → fire once as catch-up
        console.log(`[Scheduler] ${s.id} (${s.name}) missed run detected — firing now`);
        this._fireSchedule(s);
      }
      // Advance nextRunAt regardless
      if (s.trigger.type === 'once') {
        s.nextRunAt = null;
        s.enabled   = false;
      } else {
        const n = computeNextRunAt(s.trigger, now);
        s.nextRunAt = n ? n.toISOString() : null;
      }
      changed = true;
    }
    if (changed) this.saveSchedules(list);
  }

  _tick() {
    const now  = new Date();
    const list = this.loadSchedules();
    let changed = false;
    for (const s of list) {
      // Pending resume takes priority; also suppresses regular run while waiting
      if (s.pendingResume) {
        if (new Date(s.pendingResume.atISO) <= now) {
          console.log(`[Scheduler] ${s.id} (${s.name}) firing resume #${s.pendingResume.resumeCount}`);
          const pr = s.pendingResume;
          s.pendingResume = null;
          changed = true;
          this.saveSchedules(list); // persist cleared pendingResume before firing
          this._firePendingResume(s, pr);
        }
        continue; // don't fire regular run while resume is pending or being fired
      }

      if (!s.enabled || !s.nextRunAt) continue;
      if (new Date(s.nextRunAt) > now) continue;

      // Circuit breaker
      if ((s.consecutiveFailures || 0) >= (s.guardrails?.failureBreakAfter || 3)) {
        console.log(`[Scheduler] ${s.id} (${s.name}) circuit breaker — disabling after ${s.consecutiveFailures} consecutive failures`);
        s.enabled   = false;
        s.nextRunAt = null;
        changed     = true;
        continue;
      }

      console.log(`[Scheduler] firing ${s.id} (${s.name})`);
      this._fireSchedule(s);

      // Advance trigger
      if (s.trigger.type === 'once') {
        s.nextRunAt = null;
        s.enabled   = false;
      } else {
        const n = computeNextRunAt(s.trigger, now);
        s.nextRunAt = n ? n.toISOString() : null;
      }
      changed = true;
    }
    if (changed) this.saveSchedules(list);
    // H6/H5: daily & weekly housekeeping hook (fires on every tick, guarded inside)
    if (typeof this._housekeepingFn === 'function') {
      try { this._housekeepingFn(); } catch (e) { console.error('[Scheduler] housekeeping error:', e.message); }
    }
    // SN4: due-note Telegram reminder scan (fires on every tick, guarded inside)
    if (typeof this._noteReminderFn === 'function') {
      try { this._noteReminderFn(); } catch (e) { console.error('[Scheduler] note reminder error:', e.message); }
    }
  }

  // TGC10-02: `origin` only ever arrives via triggerNow → manual; _tick()'s auto calls never pass
  // it, so opts.origin stays undefined → run.origin = null there, identical to pre-TGC10 behavior.
  _fireSchedule(schedule, trigger, origin) {
    if (!this._fireJob) {
      console.warn('[Scheduler] fireJob callback not set — skipping');
      return;
    }
    const resolvedPrompt = schedule.task.kind === 'skill'
      ? `/${schedule.task.skill || ''}${schedule.task.args ? ' ' + schedule.task.args : ''}`
      : (schedule.task.prompt || '');

    const { run } = this.createRun(schedule.id, {
      model: schedule.model,
      resolvedPrompt,
      trigger: trigger || 'auto',   // 自動觸發（_tick）不帶值 → 'auto'；手動經 triggerNow 帶 'manual'
      origin,                        // manual-trigger conversation origin, or undefined
    });

    // Fire async, handle errors internally
    Promise.resolve().then(() => this._fireJob(schedule, run)).catch(e => {
      console.error(`[Scheduler] fireJob error for ${schedule.id}:`, e.message);
      this.updateRun(schedule.id, run.id, {
        status:      'failed',
        finishedAt:  new Date().toISOString(),
        error:       e.message,
      });
      this._recordFailure(schedule.id);
    });
  }

  // Called by onComplete in server.js to update schedule-level stats
  recordRunOutcome(scheduleId, status) {
    const list = this.loadSchedules();
    const idx  = list.findIndex(s => s.id === scheduleId);
    if (idx < 0) return;
    list[idx].lastRunAt     = new Date().toISOString();
    list[idx].lastRunStatus = status;
    if (status === 'success' || status === 'partial') {
      // SSTAT-P: `partial` zeroes the counter like `success` — the agent DID ship real work
      // (it just also flagged something to confirm), so it should count as progress and not
      // push the schedule toward the circuit breaker. This is deliberately different from
      // `blocked` below, which did no work at all and therefore neither zeroes nor increments.
      list[idx].consecutiveFailures = 0;
    } else if (status !== 'limited-waiting' && status !== 'blocked' && status !== 'noop' && status !== 'aborted') {
      // limited-waiting / blocked / noop are not real failures — don't count toward the circuit
      // breaker. blocked (SSTAT-02) = ran clean but deliberately did nothing (guardrail/approval):
      // it neither succeeded (don't zero the counter) nor broke (don't push toward the breaker).
      // aborted (SCH-STOP) = 指揮官人為叫停，不是排程本身壞掉——同理不該推高熔斷計數。
      list[idx].consecutiveFailures = (list[idx].consecutiveFailures || 0) + 1;
    }
    this.saveSchedules(list);
  }

  // Schedule a resume run at resetAt (called by server.js onComplete when rate-limited).
  // Stores a pendingResume on the schedule; _tick picks it up when the time arrives.
  scheduleResume(schedule, previousRun, resetAt, partial) {
    const maxResumes  = (schedule.guardrails && schedule.guardrails.maxResumes != null)
      ? schedule.guardrails.maxResumes : 3;
    const resumeCount = (previousRun.resumeCount || 0) + 1;
    if (resumeCount > maxResumes) {
      console.log(`[Scheduler] ${schedule.id} (${schedule.name}) maxResumes (${maxResumes}) reached — not scheduling resume`);
      return false;
    }
    // Default to 6h from now if no resetAt was parsed
    const atISO = resetAt || new Date(Date.now() + 6 * 3600 * 1000).toISOString();
    const list = this.loadSchedules();
    const idx  = list.findIndex(s => s.id === schedule.id);
    if (idx < 0) return false;
    list[idx].pendingResume = {
      atISO,
      previousRunId: previousRun.id,
      resumeCount,
      partial:       (partial || '').slice(0, 8000),
    };
    this.saveSchedules(list);
    console.log(`[Scheduler] ${schedule.id} (${schedule.name}) resume #${resumeCount} scheduled for ${atISO}`);
    return true;
  }

  // Fire a pending resume as a new run, passing partial output + original prompt.
  _firePendingResume(schedule, pendingResume) {
    if (!this._fireJob) {
      console.warn('[Scheduler] fireJob callback not set — skipping resume');
      return;
    }
    const originalPrompt = schedule.task.kind === 'skill'
      ? '/' + (schedule.task.skill || '') + (schedule.task.args ? ' ' + schedule.task.args : '')
      : (schedule.task.prompt || '');
    const partial = pendingResume.partial || '';
    const resumePrompt = partial
      ? '[系統：上次執行因配額限制中斷，已保存的進度如下]\n\n--- 上次進度 ---\n' + partial + '\n--- 進度結束 ---\n\n[請在上述進度的基礎上繼續完成原始任務]\n\n' + originalPrompt
      : '[系統：上次執行因配額限制中斷，現在繼續完成原始任務]\n\n' + originalPrompt;
    const { run } = this.createRun(schedule.id, {
      model:         schedule.model,
      resolvedPrompt: resumePrompt,
      resumeCount:   pendingResume.resumeCount,
      previousRunId: pendingResume.previousRunId,
      trigger:       'auto',   // 限額自醒續跑 = 系統自動發起
    });
    Promise.resolve().then(() => this._fireJob(schedule, run)).catch(e => {
      console.error(`[Scheduler] resume fireJob error for ${schedule.id}:`, e.message);
      this.updateRun(schedule.id, run.id, {
        status:     'failed',
        finishedAt: new Date().toISOString(),
        error:      e.message,
      });
      this._recordFailure(schedule.id);
    });
  }

  _recordFailure(scheduleId) {
    this.recordRunOutcome(scheduleId, 'failed');
  }

  // ── Notifications (web sink persistence) ──────────────────────────────────
  // Ring-buffer: newest first, max 200 entries.

  saveNotification(notif) {
    let list = [];
    try { list = JSON.parse(fs.readFileSync(this.notificationsPath, 'utf8')); } catch (e) {}
    if (!Array.isArray(list)) list = [];
    list.unshift(notif);
    if (list.length > 200) list = list.slice(0, 200);
    try { fs.writeFileSync(this.notificationsPath, JSON.stringify(list, null, 2)); } catch (e) {
      console.error('[Sink:web] saveNotification error:', e.message);
    }
  }

  getNotifications(limit) {
    try {
      const list = JSON.parse(fs.readFileSync(this.notificationsPath, 'utf8'));
      return (Array.isArray(list) ? list : []).slice(0, limit || 50);
    } catch (e) { return []; }
  }

  dismissNotification(id) {
    try {
      let list = JSON.parse(fs.readFileSync(this.notificationsPath, 'utf8'));
      if (!Array.isArray(list)) return false;
      const len = list.length;
      list = list.filter(function(n) { return n.id !== id; });
      if (list.length !== len) {
        fs.writeFileSync(this.notificationsPath, JSON.stringify(list, null, 2));
        return true;
      }
      return false;
    } catch (e) { return false; }
  }

  // ── Delivery ───────────────────────────────────────────────────────────────
  // 投出「摘要+連結」到排程定義的各 sink；web sink 預設啟用。
  // Telegram（§C）只需 register('telegram', fn) 即可插入，不動核心。

  // ── Resilient delivery (B4 / SCHED-10·11·12) ──────────────────────────────
  // The OLD deliver() sent web+telegram fire-and-forget right after a run finished. If that run
  // triggered a deploy/restart, the send never ran → the notification vanished even though the run
  // was marked success. Now the delivery INTENT lives on the run (`run.delivery`, written atomically
  // with the final status by server.js), and actual sending is a separate, idempotent, retryable step:
  //   • flushRunDelivery — send the sinks this run hasn't delivered yet, record which succeeded.
  //   • flushPendingDeliveries — on boot, re-send every run with sinks still undelivered.

  // Attach a delivery intent to a run if it has none (used when a caller didn't write it inline).
  recordPendingDelivery(scheduleId, runId, sinks, status, summary, scheduleName) {
    const run = this.getRun(scheduleId, runId);
    if (!run || run.delivery) return;
    this.updateRun(scheduleId, runId, {
      delivery: { sinks: sinks && sinks.length ? sinks : ['web'], status, summary: summary || '', scheduleName: scheduleName || '', deliveredSinks: [], origin: run.origin || null },
    });
  }

  // Send the sinks this run still owes; mark each that succeeds. Idempotent: an already-delivered sink
  // is skipped, so re-running this (e.g. on every boot) never double-sends.
  async flushRunDelivery(scheduleId, runId) {
    const run = this.getRun(scheduleId, runId);
    if (!run || !run.delivery) return;
    const d = run.delivery;
    const done = new Set(d.deliveredSinks || []);
    for (const sink of d.sinks || []) {
      if (done.has(sink)) continue;
      const notif = {
        id:           'notif_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        type:         'run_complete',
        scheduleId,   scheduleName: d.scheduleName || '',
        runId,        status: d.status, summary: d.summary || '',
        createdAt:    run.finishedAt || new Date().toISOString(),
        // TGC10-03: manual-trigger origin (if any) so a sink can route back to the triggering
        // conversation instead of broadcasting. null for auto runs / triggers without one.
        origin:       d.origin || null,
      };
      // AWAIT the actual send: web resolves immediately (sync file write); telegram resolves only
      // after Telegram accepts the HTTP. Persist deliveredSinks PER-SINK on success, so a sink that
      // truly sent is recorded even if a later sink — or a deploy-restart killing this process
      // mid-send — aborts before the rest finish. Anything not recorded stays owed → re-sent on boot.
      let ok = false;
      try { ok = await this.sinkManager.deliverOne(sink, notif); } catch (e) { ok = false; }
      if (ok) {
        done.add(sink);
        this.updateRun(scheduleId, runId, { delivery: Object.assign({}, d, { deliveredSinks: Array.from(done) }) });
      }
    }
  }

  // On boot (after sinks are registered): re-send every run whose delivery still has an undelivered,
  // currently-registered sink. Runs predating this feature (no `delivery`) are skipped — no back-spam.
  flushPendingDeliveries() {
    let scheduleIds = [];
    try { scheduleIds = fs.readdirSync(this.runsDir).filter((f) => { try { return fs.statSync(path.join(this.runsDir, f)).isDirectory(); } catch (e) { return false; } }); }
    catch (e) { return; }
    let flushed = 0;
    for (const sid of scheduleIds) {
      const dir = path.join(this.runsDir, sid);
      let files = [];
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (e) { continue; }
      for (const f of files) {
        let run; try { run = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
        if (!run || !run.id || !run.delivery) continue;
        const done = new Set(run.delivery.deliveredSinks || []);
        const owed = (run.delivery.sinks || []).filter((s) => !done.has(s) && this.sinkManager.has(s));
        if (owed.length) { this.flushRunDelivery(sid, run.id); flushed++; }
      }
    }
    if (flushed) console.log('[Scheduler] re-delivered notifications for ' + flushed + ' run(s) undelivered before restart');
  }

  // ── Cross-schedule run query (SCHED-09 自我感知) ──────────────────────────
  // 跨所有排程搜尋執行紀錄，供 API 查詢 + 注入 Hana 上下文。

  // IDX-RUN：目錄暖機完成後走記憶體（回傳清單摘要欄位，非整份 run）；opts.workspace 只回該工作區（D2）。
  // 注意：已歸檔排程的執行記錄在歸檔目錄（D5），不在這個全域查詢裡；指定 scheduleId 且記憶體沒有時才逐檔讀。
  queryRuns(opts) {
    opts = opts || {};
    if (this._runMemWarm) {
      const sid = opts.scheduleId || null;
      let hasSid = !sid;
      if (sid) { for (const w of this._runMem.values()) if (w.e.scheduleId === sid) { hasSid = true; break; } }
      if (hasSid) return this._queryRunsMem(opts);
    }
    return this._queryRunsScan(opts);
  }

  _queryRunsMem(opts) {
    const since = opts.since || null, until = opts.until || null;
    const filterSid = opts.scheduleId || null, filterSt = opts.status || null;
    const limit = opts.limit || 50;
    const wsKey = opts.workspace ? this._normWsKey(opts.workspace) : null;
    // status=running 且不指定排程：直接看「執行中」清單（含已歸檔排程的執行中 run）。
    const src = (filterSt === 'running' && !filterSid) ? this._running.values() : this._runMem.values();
    const out = [];
    for (const w of src) {
      const run = w.e;
      if (wsKey && w.wsKey !== wsKey) continue;
      if (filterSid && run.scheduleId !== filterSid) continue;
      if (since && run.startedAt && run.startedAt < since) continue;
      if (until && run.startedAt && run.startedAt > until) continue;
      if (filterSt && run.status !== filterSt) continue;
      out.push(Object.assign({}, run, { origin: run.origin ? Object.assign({}, run.origin) : null, usage: Object.assign({}, run.usage) }));
    }
    return out.sort(function(a, b) { return (b.startedAt || '').localeCompare(a.startedAt || ''); }).slice(0, limit);
  }

  _queryRunsScan(opts) {
    opts = opts || {};
    var since     = opts.since      || null;
    var until     = opts.until      || null;
    var filterSid = opts.scheduleId || null;
    var filterSt  = opts.status     || null;
    var limit     = opts.limit      || 50;

    var sids;
    if (filterSid) {
      sids = [filterSid];
    } else {
      try {
        sids = fs.readdirSync(this.runsDir).filter(function(f) {
          try { return fs.statSync(path.join(this.runsDir, f)).isDirectory(); } catch(e) { return false; }
        }.bind(this));
      } catch (e) { sids = []; }
    }

    var results = [];
    var self = this;
    for (var i = 0; i < sids.length; i++) {
      var dir = path.join(self.runsDir, sids[i]);
      if (!fs.existsSync(dir)) continue;
      try {
        var files = fs.readdirSync(dir).filter(function(f) { return f.endsWith('.json'); });
        for (var j = 0; j < files.length; j++) {
          try {
            var run = JSON.parse(fs.readFileSync(path.join(dir, files[j]), 'utf8'));
            if (since && run.startedAt && run.startedAt < since) continue;
            if (until && run.startedAt && run.startedAt > until) continue;
            if (filterSt && run.status !== filterSt) continue;
            results.push(run);
          } catch (e) {}
        }
      } catch (e) {}
    }
    // IDX-RUN：暖機前的保底路徑也要守 D2（opts.workspace 只回該工作區；找不到排程歸 harness home）。
    if (opts.workspace) {
      var wk = self._normWsKey(opts.workspace), homeKey = self._normWsKey(self.harnessHome);
      results = results.filter(function(r) { var inf = self._schedInfo(r.scheduleId); return (inf ? inf.wsKey : homeKey) === wk; });
    }
    return results
      .sort(function(a, b) { return (b.startedAt || '').localeCompare(a.startedAt || ''); })
      .slice(0, limit);
  }

  // Manual trigger for API /api/schedules/:id/run
  // TGC10-02: `origin` ({channel,chatId,sessionId}) identifies which conversation triggered this —
  // undefined for the plain "立即執行" button / any caller that doesn't pass one (unchanged behavior).
  triggerNow(scheduleId, origin) {
    const s = this.getSchedule(scheduleId);
    if (!s) return null;
    // SCHED-15: 防重入 — 已有執行中的 run 就不再觸發（前端按鈕也會 disabled，這是後端雙保險）。
    const running = this.getRunningRun(scheduleId);
    if (running) return { ok: false, error: 'already-running', runId: running.id };
    this._fireSchedule(s, 'manual', origin);
    return { ok: true, scheduleId };
  }

  // SCHED-14/15: 該排程目前仍在執行的 run（status 'running'），無則 null。
  // 供「立即執行」防重入守衛與清單「執行中」徽章使用。
  // IDX-RUN：開機對帳後改看記憶體裡的「執行中」清單（不再讀整個資料夾）；對帳前保守走舊的讀檔。
  getRunningRun(scheduleId) {
    if (!this._reconciled)
      return this.getRuns(scheduleId, 50).find(r => r && r.status === 'running') || null;
    let best = null;
    for (const w of this._running.values()) {
      if (w.e.scheduleId !== scheduleId) continue;
      if (!best || String(w.e.startedAt || '') > String(best.startedAt || '')) best = w.e;
    }
    return best ? Object.assign({}, best) : null;
  }

  // SCHED-DEPLOY Z5-2: true if ANY schedule (any workspace) currently has a run 'running'. A
  // postRun deploy restarts :3400, so it should wait out other in-flight runs rather than yank
  // the server out from under them.
  hasAnyRunningRun() {
    if (this._reconciled) return this._running.size > 0;   // IDX-RUN
    let scheduleIds = [];
    try { scheduleIds = fs.readdirSync(this.runsDir).filter(f => { try { return fs.statSync(path.join(this.runsDir, f)).isDirectory(); } catch (e) { return false; } }); }
    catch (e) { return false; }
    for (const sid of scheduleIds) {
      if (this.getRunningRun(sid)) return true;
    }
    return false;
  }

  // Z8: 最近一次佈署晉升的時間（ms）。Deploy_Harness.ps1 每次晉升新版都會改寫 .releases/current.json，
  // 所以不必另外埋 marker 就能判斷「這次重啟是不是佈署造成的」。讀不到就回 null（判為一般重啟）。
  _lastDeployAtMs() {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(this.harnessHome, '.releases', 'current.json'), 'utf8'));
      const t = Date.parse(j && j.updatedAt);
      return Number.isFinite(t) ? t : null;
    } catch (e) { return null; }
  }

  // 開機對帳：任何殘留 'running' 的 run 都屬於上一個（已死）行程 —— 此刻尚無任何 job 真正在跑。
  // 將其改記為 'interrupted'，避免清單顯示幽靈「執行中」或永久卡住手動執行按鈕。
  reconcileOrphanRuns() {
    let scheduleIds = [];
    try { scheduleIds = fs.readdirSync(this.runsDir).filter(f => { try { return fs.statSync(path.join(this.runsDir, f)).isDirectory(); } catch (e) { return false; } }); }
    catch (e) { this._reconciled = true; return; }
    let fixed = 0;
    const orphanBySchedule = {};   // sid → 該排程最後一筆被判定中斷的 run
    // Z8: 若這次重啟是「佈署」造成的，說出來。.releases/current.json 的 updatedAt 由
    // Deploy_Harness.ps1 在晉升新版時寫入 —— 它落在某筆 run 的執行區間內，就代表那筆 run 是被佈署
    // 重啟砍掉的（工作多半已做完），不是崩潰或當機。誠實但不過度宣稱：狀態仍是 interrupted。
    const deployAtMs = this._lastDeployAtMs();
    for (const sid of scheduleIds) {
      for (const run of this.getRuns(sid, 200)) {
        if (run && run.status === 'running') {
          const startedMs = Date.parse(run.startedAt || '') || 0;
          const byDeploy  = !!(deployAtMs && startedMs && deployAtMs >= startedMs);
          this.updateRun(sid, run.id, {
            status: 'interrupted',
            finishedAt: new Date().toISOString(),
            error: byDeploy
              ? '中斷：佈署重啟服務（本輪工作可能已完成，請查看回報內容與 TASK.md 勾選狀態）'
              : '中斷：伺服器重啟',
            interruptedBy: byDeploy ? 'deploy' : 'restart',
          });
          const prev = orphanBySchedule[sid];
          if (!prev || String(run.startedAt || '') > String(prev.startedAt || '')) orphanBySchedule[sid] = run;
          fixed++;
        }
      }
    }
    // 也把「排程層」的最近狀態同步成 interrupted。否則自我佈署／重啟打斷的 run 只有 run 檔變成
    // interrupted，schedule.lastRunStatus 仍是 null，清單永遠顯示「尚未執行」（§Z 自己踩過）。
    const sids = Object.keys(orphanBySchedule);
    if (sids.length) {
      const list = this.loadSchedules();
      let touched = 0;
      for (const sid of sids) {
        const idx = list.findIndex(s => s.id === sid);
        if (idx < 0) continue;
        const startedAt = orphanBySchedule[sid].startedAt || null;
        // 只在這筆中斷確實比排程既有的 lastRunAt 新時才覆寫，避免蓋掉更新的正常結果。
        if (startedAt && list[idx].lastRunAt && String(list[idx].lastRunAt) >= String(startedAt)) continue;
        list[idx].lastRunAt     = orphanBySchedule[sid].finishedAt || startedAt || new Date().toISOString();
        list[idx].lastRunStatus = 'interrupted';   // 非真實失敗 → 不累加 consecutiveFailures
        touched++;
      }
      if (touched) this.saveSchedules(list);
    }
    if (fixed) console.log('[Scheduler] reconciled ' + fixed + ' orphaned running run(s) → interrupted');
    this._reconciled = true;   // IDX-RUN：此後「執行中」以記憶體清單為準（run 檔上的 running 都已改成 interrupted）
  }

  // ── Memory candidate sidecar (H4/H5/H6) ───────────────────────────────────
  // candidate.json is written alongside the run dir when the agent judges a run noteworthy.

  saveMemoryCandidate(scheduleId, runId, data) {
    const dir = path.join(this.runsDir, scheduleId, runId);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'candidate.json'), JSON.stringify(data, null, 2));
    } catch (e) { console.error('[Scheduler] saveMemoryCandidate error:', e.message); return; }
    // IDX-RUN：候選審核狀態進目錄（candidateReviewed）。
    try { const run = this.getRun(scheduleId, runId); if (run) this._trackRun(run, { candidateReviewed: !!(data && data.reviewed), candidateNoteworthy: !!(data && data.noteworthy) }); } catch (e) {}
  }

  getMemoryCandidate(scheduleId, runId) {
    try {
      return JSON.parse(fs.readFileSync(
        path.join(this.runsDir, scheduleId, runId, 'candidate.json'), 'utf8'
      ));
    } catch (e) { return null; }
  }

  // Collect all unreviewed memory candidates for a workspace (null = all workspaces).
  // IDX-CAND：目錄暖機後只看執行記錄目錄（hasCandidate／candidateReviewed／candidateNoteworthy）先篩，
  // 只讀「待審」的 candidate.json；暖機前或目錄不可用時走舊的逐檔讀取（保底）。回傳格式不變。
  collectCandidates(workspaceRoot) {
    if (this._runMemWarm) {
      try { return this._collectCandidatesMem(workspaceRoot); }
      catch (e) { console.error('[Scheduler] collectCandidates (index) failed, fallback to scan:', e.message); }
    }
    return this._collectCandidatesScan(workspaceRoot);
  }

  _collectCandidatesMem(workspaceRoot) {
    const wsKey = workspaceRoot ? this._normWsKey(workspaceRoot) : null;
    const results = [];
    for (const w of this._runMem.values()) {
      const e = w.e;
      if (wsKey && w.wsKey !== wsKey) continue;
      if (!e.hasCandidate || e.candidateReviewed) continue;
      if (e.candidateNoteworthy === false) continue;   // undefined＝舊目錄檔無此欄位，仍要讀檔確認
      const candidate = this.getMemoryCandidate(e.scheduleId, e.id);
      if (!candidate || !candidate.noteworthy || candidate.reviewed) continue;
      const info = this._schedInfo(e.scheduleId);
      results.push({ scheduleId: e.scheduleId, scheduleName: info ? info.name : undefined, runId: e.id, startedAt: e.startedAt, candidate });
    }
    return results.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
  }

  _collectCandidatesScan(workspaceRoot) {
    const norm = p => p ? path.resolve(p).toLowerCase() : null;
    const wsNorm = workspaceRoot ? norm(workspaceRoot) : null;
    const results = [];
    for (const s of this.loadSchedules()) {
      if (wsNorm !== null) {
        const sWs = norm(s.workspace) || norm(this.harnessHome);
        if (sWs !== wsNorm) continue;
      }
      for (const r of this.getRuns(s.id, 500)) {
        if (!r.hasCandidate) continue;
        const candidate = this.getMemoryCandidate(s.id, r.id);
        if (!candidate || !candidate.noteworthy || candidate.reviewed) continue;
        results.push({ scheduleId: s.id, scheduleName: s.name, runId: r.id, startedAt: r.startedAt, candidate });
      }
    }
    return results.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
  }

  // Identify runs eligible for automatic transcript cleanup (H6).
  // Returns [{scheduleId, runId, workspace}] — server.js does the actual file deletion.
  collectHousekeepingTargets(retainDays, retainMin) {
    retainDays = retainDays || 30;
    retainMin  = retainMin  || 20;
    const cutoff = new Date(Date.now() - retainDays * 24 * 3600 * 1000);
    const targets = [];
    for (const s of this.loadSchedules()) {
      const runs = this.getRuns(s.id, 500);
      const keepSet = new Set();
      runs.forEach((r, i) => {
        if (i < retainMin) keepSet.add(r.id);
        if (r.startedAt && new Date(r.startedAt) >= cutoff) keepSet.add(r.id);
      });
      for (const r of runs) {
        if (keepSet.has(r.id)) continue;
        if (r.transcriptCleared) continue;
        if (r.status === 'pending-resume' || r.status === 'limited-waiting') continue;
        if (r.hasCandidate) {
          const cand = this.getMemoryCandidate(s.id, r.id);
          if (cand && !cand.reviewed) continue; // H6 value gate: pending review
        }
        targets.push({ scheduleId: s.id, runId: r.id, workspace: s.workspace || null });
      }
    }
    return targets;
  }

  // ── Housekeeping state (H5 weekly / H6 daily tracking) ───────────────────

  _housekeepingPath() { return path.join(this.schedulesDir, 'housekeeping.json'); }

  getHousekeepingState() {
    try { return JSON.parse(fs.readFileSync(this._housekeepingPath(), 'utf8')); }
    catch (e) { return {}; }
  }

  saveHousekeepingState(state) {
    try { fs.writeFileSync(this._housekeepingPath(), JSON.stringify(state, null, 2)); }
    catch (e) { console.error('[Scheduler] saveHousekeepingState error:', e.message); }
  }

  // Hook registered by server.js for daily/weekly housekeeping (H6/H5).
  setHousekeepingFn(fn) { this._housekeepingFn = fn; }

  // Hook registered by server.js for the SN4 due-note Telegram reminder scan — piggybacks this
  // existing 60s tick instead of a separate schedule object (see SPEC-stickies.md §8).
  setNoteReminderFn(fn) { this._noteReminderFn = fn; }
}

module.exports = { SchedulerManager, computeNextRunAt };

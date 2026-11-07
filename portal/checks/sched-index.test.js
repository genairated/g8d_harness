// IDX-SCH 單元測試：排程清單目錄（SPEC-list-index.md §9.2）。
// 用法：node portal/checks/sched-index.test.js [--real]
//   預設：暫存目錄下造合成資料跑功能測試。
//   --real：另把真實 global-knowledge/schedules/schedules.json「複製」到 _tmp/idx/sch-sample/home 做「舊清單 vs 新清單」
//           逐筆比對＋耗時／回應大小量測＋工作區對不上登錄的清單（D7）。只讀真實檔、只寫 _tmp。
// 不起 server、不啟動排程器（不呼叫 start()）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { SchedulerManager } = require('../scheduler');
const listIndex = require('../list-index');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('PASS ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const nowMs = () => Number(process.hrtime.bigint() / 1000000n);
const nowF = () => Number(process.hrtime.bigint()) / 1e6;

function mkHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-idx-'));
  fs.mkdirSync(path.join(home, 'global-knowledge', 'schedules', 'runs'), { recursive: true });
  return home;
}
async function waitFor(pred, ms = 3000) {
  const t0 = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - t0 > ms) throw new Error('等待逾時');
    await sleep(30);
  }
}
const ids = (r) => r.items.map(x => x.id);

// 與 server.js 的 isChatOnlySchedule 相同判準（比對用，不 require server）。
function isChatOnlySchedule(s) {
  if (!s) return false;
  if (s.trigger && s.trigger.type === 'cron') return false;
  if (s.chatTask === true) return true;
  return !!(s.origin && s.origin.kind === 'chat' && s.origin.sessionId);
}

(async () => {
  const home = mkHome();
  const wsA = path.join(home, 'wsA'), wsB = path.join(home, 'wsB');
  fs.mkdirSync(wsA, { recursive: true }); fs.mkdirSync(wsB, { recursive: true });
  const sm = new SchedulerManager(home);
  // 偵測 syncRunsArchiveFlag 是否在歸檔／還原時被呼叫（D5 連動）
  const archiveCalls = [];
  sm.syncRunsArchiveFlag = async (id) => { archiveCalls.push(id); return 0; };

  const idxA = () => ({
    active: sm.listSchedulesForWorkspace(wsA, false),
    arch: sm.listSchedulesForWorkspace(wsA, true),
  });

  let s1, s2, sB;
  await t('建立：指示全文不進目錄，改放 taskKind／taskPreview；其他欄位原樣', async () => {
    const longPrompt = '開頭' + 'x'.repeat(300);
    s1 = sm.createSchedule({ name: '甲', workspace: wsA, task: { kind: 'prompt', prompt: longPrompt }, trigger: { type: 'cron', expr: '0 * * * *' } });
    s2 = sm.createSchedule({ name: '乙', workspace: wsA, task: { kind: 'skill', skill: 'task', args: 'XYZ' }, trigger: { type: 'manual' } });
    sB = sm.createSchedule({ name: 'B區', workspace: wsB, task: { kind: 'prompt', prompt: 'b' } });
    await waitFor(async () => { const r = await idxA().active; return !r.fallback && r.items.length === 2; });
    const r = await idxA().active;
    const e1 = r.items.find(x => x.id === s1.id), e2 = r.items.find(x => x.id === s2.id);
    assert.strictEqual(e1.task.prompt, undefined, 'task.prompt 不該在目錄');
    assert.strictEqual(e1.taskKind, 'prompt');
    assert.strictEqual(e1.taskPreview.length, 120);
    assert.ok(e1.taskPreview.startsWith('開頭x'));
    assert.strictEqual(e2.taskKind, 'skill');
    assert.strictEqual(e2.taskPreview, 'task XYZ');
    // 其餘欄位與主檔相同
    for (const k of ['id', 'name', 'enabled', 'trigger', 'model', 'workspace', 'guardrails', 'delivery', 'createdAt', 'nextRunAt', 'archived', 'chainNext', 'postRun']) {
      assert.deepStrictEqual(e1[k], s1[k], '欄位 ' + k);
    }
    assert.strictEqual(r.fallback, false);
  });

  await t('工作區隔離：A 區清單看不到 B 區的排程', async () => {
    const rb = await sm.listSchedulesForWorkspace(wsB, false);
    assert.deepStrictEqual(ids(rb), [sB.id]);
    const ra = await sm.listSchedulesForWorkspace(wsA, false);
    assert.ok(!ids(ra).includes(sB.id));
  });

  await t('排序＝建立順序（與主檔順序一致）', async () => {
    const r = await sm.listSchedulesForWorkspace(wsA, false);
    assert.deepStrictEqual(ids(r), [s1.id, s2.id]);
  });

  await t('更新：改名、改啟停後目錄即時一致（含 nextRunAt 重算）', async () => {
    sm.updateSchedule(s1.id, { name: '甲改', enabled: false });
    await waitFor(async () => (await sm.listSchedulesForWorkspace(wsA, false)).items.find(x => x.id === s1.id).name === '甲改');
    const e = (await sm.listSchedulesForWorkspace(wsA, false)).items.find(x => x.id === s1.id);
    assert.strictEqual(e.enabled, false);
    assert.strictEqual(e.nextRunAt, null);
  });

  await t('排程器跑完回寫（recordRunOutcome）與續跑（scheduleResume）同步；pendingResume.partial 不進目錄', async () => {
    sm.recordRunOutcome(s2.id, 'failed');
    sm.scheduleResume(sm.getSchedule(s2.id), { id: 'run_x', resumeCount: 0 }, new Date(Date.now() + 3600e3).toISOString(), 'P'.repeat(5000));
    await waitFor(async () => {
      const e = (await sm.listSchedulesForWorkspace(wsA, false)).items.find(x => x.id === s2.id);
      return e.lastRunStatus === 'failed' && e.pendingResume;
    });
    const e = (await sm.listSchedulesForWorkspace(wsA, false)).items.find(x => x.id === s2.id);
    assert.strictEqual(e.consecutiveFailures, 1);
    assert.strictEqual(e.pendingResume.partial, undefined);
    assert.strictEqual(e.pendingResume.resumeCount, 1);
    // 主檔裡 partial 仍在（目錄只是快取）
    assert.strictEqual(sm.getSchedule(s2.id).pendingResume.partial.length, 5000);
  });

  await t('歸檔：從現役目錄搬到歸檔目錄，並連動執行記錄歸檔旗標（syncRunsArchiveFlag）', async () => {
    archiveCalls.length = 0;
    sm.updateSchedule(s1.id, { archived: true, enabled: false });
    // 現役與歸檔是兩個檔案，各自原子替換；兩邊都換好才算搬完
    await waitFor(async () => (await sm.listSchedulesForWorkspace(wsA, true)).items.some(x => x.id === s1.id) && !(await sm.listSchedulesForWorkspace(wsA, false)).items.some(x => x.id === s1.id));
    const a = await sm.listSchedulesForWorkspace(wsA, false), z = await sm.listSchedulesForWorkspace(wsA, true);
    assert.ok(!ids(a).includes(s1.id)); assert.ok(ids(z).includes(s1.id));
    assert.strictEqual(a.archivedCount, 1);
    assert.deepStrictEqual(archiveCalls, [s1.id]);
  });

  await t('還原：從歸檔搬回現役，再連動一次', async () => {
    archiveCalls.length = 0;
    sm.updateSchedule(s1.id, { archived: false });
    await waitFor(async () => (await sm.listSchedulesForWorkspace(wsA, false)).items.some(x => x.id === s1.id));
    const z = await sm.listSchedulesForWorkspace(wsA, true);
    assert.ok(!ids(z).includes(s1.id));
    assert.deepStrictEqual(archiveCalls, [s1.id]);
  });

  await t('刪除：兩邊目錄都沒有', async () => {
    sm.deleteSchedule(s2.id);
    await waitFor(async () => !ids(await sm.listSchedulesForWorkspace(wsA, false)).includes(s2.id));
    assert.ok(!ids(await sm.listSchedulesForWorkspace(wsA, true)).includes(s2.id));
  });

  await t('搬工作區：舊區移除、新區出現', async () => {
    sm.updateSchedule(s1.id, { workspace: wsB });
    await waitFor(async () => ids(await sm.listSchedulesForWorkspace(wsB, false)).includes(s1.id));
    assert.ok(!ids(await sm.listSchedulesForWorkspace(wsA, false)).includes(s1.id));
  });

  await t('不同寫法的同一個工作區（雙反斜線／大小寫／結尾斜線／正斜線）歸同一份目錄', async () => {
    const variants = [wsB, wsB.replace(/\\/g, '\\\\'), wsB.toUpperCase(), wsB + path.sep, wsB.replace(/\\/g, '/')];
    const made = variants.map((w, i) => sm.createSchedule({ name: 'V' + i, workspace: w, task: { kind: 'prompt', prompt: 'v' } }));
    await waitFor(async () => { const r = await sm.listSchedulesForWorkspace(wsB, false); return made.every(m => ids(r).includes(m.id)); });
    // 每種寫法拿到的清單都一樣
    const base = ids(await sm.listSchedulesForWorkspace(wsB, false)).sort();
    for (const w of variants) assert.deepStrictEqual(ids(await sm.listSchedulesForWorkspace(w, false)).sort(), base, '寫法 ' + w);
    // 清掉，避免影響後面的計數
    for (const m of made) sm.deleteSchedule(m.id);
    await waitFor(async () => ids(await sm.listSchedulesForWorkspace(wsB, false)).length === 1 + 1 /* sB, s1 */);
  });

  await t('目錄檔被刪：清單走保底（fallback:true、欄位形狀相同、無 task.prompt）並自動重建', async () => {
    const h = listIndex.getIndex('schedules', wsA);
    const st = await h.status();
    for (const p of [st.indexPath, st.archivePath]) { try { fs.unlinkSync(p); } catch (e) {} }
    // 模組快取可能還有記憶體版；用全新的 SchedulerManager（新行程模擬）看保底
    const sm2 = new SchedulerManager(home);
    sm2.syncRunsArchiveFlag = async () => 0;
    const r0 = await sm2.listSchedulesForWorkspace(wsA, false);
    // 不管這次走目錄還是保底，內容都要正確
    assert.ok(Array.isArray(r0.items));
    for (const x of r0.items) assert.strictEqual(x.task.prompt, undefined);
    await waitFor(async () => { const r = await sm2.listSchedulesForWorkspace(wsA, false); return !r.fallback; }, 5000);
    const r1 = await sm2.listSchedulesForWorkspace(wsA, false);
    assert.deepStrictEqual(ids(r1), ids(r0));
  });

  await t('暖機：重開（新 SchedulerManager）後 warmSchedIndex 核對不重建，且之後第一次寫入的差異比對基準正確', async () => {
    const sm3 = new SchedulerManager(home);
    sm3.syncRunsArchiveFlag = async () => 0;
    await sm3.warmSchedIndex();
    assert.strictEqual(sm3._schedWarm, true);
    const all = await sm3.listActiveSchedulesAllWorkspaces();
    assert.ok(Array.isArray(all));
    // 第一次寫入：只改一筆 → 目錄只該動那一筆
    const before = (await sm3.listSchedulesForWorkspace(wsB, false)).items.length;
    const x = sm3.createSchedule({ name: '暖機後新增', workspace: wsB, task: { kind: 'prompt', prompt: 'n' } });
    await waitFor(async () => (await sm3.listSchedulesForWorkspace(wsB, false)).items.length === before + 1);
    sm3.deleteSchedule(x.id);
    await waitFor(async () => (await sm3.listSchedulesForWorkspace(wsB, false)).items.length === before);
  });

  await t('重建結果＝逐筆寫入的結果（逐欄位相同）', async () => {
    const h = listIndex.getIndex('schedules', wsB);
    const inc = (await h.list()).items;
    const r = await h.rebuild({ reason: 'test' });
    assert.ok(r.ok);
    const rb = (await h.list()).items;
    assert.deepStrictEqual(rb, inc);
  });

  await t('同時 40 次寫入不遺失', async () => {
    const made = [];
    for (let i = 0; i < 40; i++) made.push(sm.createSchedule({ name: 'M' + i, workspace: wsA, task: { kind: 'prompt', prompt: 'm' + i } }));
    await waitFor(async () => { const r = await sm.listSchedulesForWorkspace(wsA, false); return made.every(m => ids(r).includes(m.id)); }, 5000);
  });

  await t('保底路徑（目錄不可用）也不拋錯：未登錄工作區的 handle 取不到時走主檔', async () => {
    const sm4 = new SchedulerManager(home);
    sm4.syncRunsArchiveFlag = async () => 0;
    const orig = listIndex.getIndex;
    listIndex.getIndex = () => null;
    try {
      const r = await sm4.listSchedulesForWorkspace(wsA, false);
      assert.strictEqual(r.fallback, true);
      assert.ok(r.items.length >= 40);
      assert.strictEqual(r.items[0].task.prompt, undefined);
    } finally { listIndex.getIndex = orig; }
  });

  console.log('\n合成測試：' + pass + ' passed, ' + fail + ' failed');

  // ── 真實資料樣本（--real）──────────────────────────────────────────────────
  if (process.argv.includes('--real')) {
    const repo = path.resolve(__dirname, '..', '..');
    const realFile = path.join(repo, 'global-knowledge', 'schedules', 'schedules.json');
    const sample = path.join(repo, '_tmp', 'idx', 'sch-sample', 'home');
    fs.rmSync(sample, { recursive: true, force: true });
    fs.mkdirSync(path.join(sample, 'global-knowledge', 'schedules', 'runs'), { recursive: true });
    fs.copyFileSync(realFile, path.join(sample, 'global-knowledge', 'schedules', 'schedules.json'));
    const all = JSON.parse(fs.readFileSync(realFile, 'utf8'));
    console.log('\n[real] 樣本：' + all.length + ' 筆排程，其中歸檔 ' + all.filter(s => s.archived).length +
      '，主檔 ' + (fs.statSync(realFile).size / 1048576).toFixed(2) + ' MB');

    const sm5 = new SchedulerManager(sample);
    sm5.syncRunsArchiveFlag = async () => 0;
    const norm = (p) => { try { return path.resolve(String(p || '')).toLowerCase(); } catch (e) { return ''; } };
    const homeKey = norm(sample);

    // 暖機（含首次重建）
    const w0 = nowMs();
    await sm5.warmSchedIndex();
    console.log('[real] 暖機（首次，含各工作區重建）：' + (nowMs() - w0) + ' ms，工作區 ' + sm5._schedWsRoots.size + ' 個');

    // 登錄的工作區（D7 用）
    let reg = [];
    try { reg = (JSON.parse(fs.readFileSync(path.join(repo, 'global-knowledge', 'projects.json'), 'utf8')).projects || []).map(p => ({ name: p.name, root: p.root })); } catch (e) {}
    const regKeys = new Set(reg.map(p => norm(p.root)));
    regKeys.add(norm(repo));

    // 逐工作區：舊清單（去 task.prompt 後）vs 新清單
    const byWs = new Map();
    for (const s of all) { const k = norm(s.workspace || sample); if (!byWs.has(k)) byWs.set(k, []); byWs.get(k).push(s); }
    let cmpFail = 0, cmpRows = 0; const orderDiff = [];
    const strip = (s) => { const e = JSON.parse(JSON.stringify(s)); if (e.task) delete e.task.prompt; if (e.pendingResume) delete e.pendingResume.partial; return e; };
    for (const [k, arr] of byWs) {
      const wsRaw = arr[0].workspace || sample;
      for (const archived of [false, true]) {
        let oldL = arr.filter(s => !!s.archived === archived).filter(s => !isChatOnlySchedule(s)).map(strip);
        const nr = await sm5.listSchedulesForWorkspace(wsRaw, archived);
        const newL = nr.items.filter(s => !isChatOnlySchedule(s)).map(e => { const c = JSON.parse(JSON.stringify(e)); delete c.taskKind; delete c.taskPreview; return c; });
        cmpRows += oldL.length;
        // 順序：目錄固定依建立時間排；主檔順序是「寫入先後」，少數手動塞進去的舊排程（id 非時間戳）兩者不同。
        // 內容逐筆比對前先把兩邊都依 id 排，順序差異另外計數回報（不算失敗）。
        const sameOrder = oldL.length === newL.length && oldL.every((x, i) => x.id === newL[i].id);
        if (!sameOrder) { orderDiff.push((archived ? '歸檔 ' : '現役 ') + wsRaw); }
        oldL = oldL.slice().sort((x, y) => x.id < y.id ? -1 : 1); newL.sort((x, y) => x.id < y.id ? -1 : 1);
        let ok = oldL.length === newL.length;
        let firstDiff = '';
        if (ok) for (let i = 0; i < oldL.length; i++) {
          if (JSON.stringify(oldL[i]) !== JSON.stringify(newL[i])) {
            ok = false;
            const a = oldL[i], b = newL[i];
            const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
            const d = [...keys].filter(x => JSON.stringify(a[x]) !== JSON.stringify(b[x]));
            firstDiff = ' 第 ' + i + ' 筆 ' + a.id + ' vs ' + b.id + ' 欄位 ' + d.join(',');
            break;
          }
        }
        if (nr.fallback) { ok = false; firstDiff += ' (走了保底)'; }
        if (!ok) { cmpFail++; console.log('[real] ✗ 工作區 ' + wsRaw + (archived ? '（歸檔）' : '（現役）') + ' 舊 ' + oldL.length + ' / 新 ' + newL.length + firstDiff); }
      }
    }
    console.log('[real] 順序與主檔不同的清單：' + (orderDiff.length ? orderDiff.join('；') : '無'));
    console.log('[real] 逐筆比對：' + byWs.size + ' 個工作區、' + cmpRows + ' 筆（去除對話衍生者）→ ' + (cmpFail ? cmpFail + ' 組不同' : '全部相同（數量、欄位、順序）'));
    if (cmpFail) fail++;

    // D7：工作區對不上登錄的
    const unmatched = [...byWs].filter(([k]) => !regKeys.has(k) && k !== homeKey);
    console.log('[real] 工作區欄位種類（正規化後）：' + byWs.size + ' 種；對得上登錄 ' + (byWs.size - unmatched.length) + ' 種');
    for (const [k, arr] of unmatched) {
      console.log('[real] ⚠ 對不上任何登錄工作區：正規化後 "' + k + '"（' + arr.length + ' 筆，現役 ' + arr.filter(s => !s.archived).length + '；原值樣本 ' + JSON.stringify([...new Set(arr.map(s => s.workspace))].slice(0, 3)) + '；排程名樣本 ' + arr.slice(0, 2).map(s => s.name).join(' / ') + '）');
    }

    // 量測：客戶專案（筆數最多的非 harness 工作區）
    let big = null;
    for (const [k, arr] of byWs) if (!big || arr.length > big.arr.length) big = { k, arr };
    const wsBig = big.arr[0].workspace || sample;
    const R = 30;
    // 舊：整份解析主檔 → 過濾工作區 → 過濾對話衍生 → 組 JSON（含指示全文）。排除了「對每筆讀執行記錄找執行中」的成本（樣本沒有 runs 資料夾，所以舊值偏樂觀）
    let oldMs = 0, oldBytes = 0, oldN = 0;
    for (let i = 0; i < 5; i++) {
      const a = nowF();
      const l = sm5.loadSchedules().filter(s => norm(s.workspace || sample) === norm(wsBig)).filter(s => !isChatOnlySchedule(s))
        .map(s => Object.assign({}, s, { running: null }));
      const body = JSON.stringify(l);
      oldMs += nowF() - a; oldBytes = Buffer.byteLength(body); oldN = l.length;
    }
    oldMs /= 5;
    // 新：現役清單（第一次＝冷讀，之後＝記憶體）
    const c0 = nowF();
    const nr0 = await sm5.listSchedulesForWorkspace(wsBig, false);
    const body0 = JSON.stringify(nr0.items.filter(s => !isChatOnlySchedule(s)).map(s => Object.assign({}, s, { running: null })));
    const coldMs = nowF() - c0;
    let newMs = 0, newBytes = 0, newN = 0;
    for (let i = 0; i < R; i++) {
      const a = nowF();
      const r = await sm5.listSchedulesForWorkspace(wsBig, false);
      const l = r.items.filter(s => !isChatOnlySchedule(s)).map(s => Object.assign({}, s, { running: null }));
      const body = JSON.stringify(l);
      newMs += nowF() - a; newBytes = Buffer.byteLength(body); newN = l.length;
    }
    newMs /= R;
    const a0 = nowF();
    const ar = await sm5.listSchedulesForWorkspace(wsBig, true);
    const archBody = JSON.stringify(ar.items.filter(s => !isChatOnlySchedule(s)));
    const archMs = nowF() - a0;
    console.log('[real] 量測工作區 ' + wsBig + '：');
    console.log('[real]   舊（整份解析＋過濾＋含指示全文）：' + oldMs.toFixed(1) + ' ms，回應 ' + (oldBytes / 1024).toFixed(0) + ' KB，' + oldN + ' 筆（含歸檔；未含逐排程讀執行記錄的成本）');
    console.log('[real]   新 現役清單 冷讀：' + coldMs.toFixed(1) + ' ms；之後平均 ' + newMs.toFixed(2) + ' ms，回應 ' + (newBytes / 1024).toFixed(1) + ' KB，' + newN + ' 筆');
    console.log('[real]   新 ?archived=1：' + archMs.toFixed(1) + ' ms，回應 ' + (Buffer.byteLength(archBody) / 1024).toFixed(0) + ' KB，' + ar.items.length + ' 筆');
    const dt0 = nowF();
    const dts = await sm5.listActiveSchedulesAllWorkspaces();
    console.log('[real]   deploy-targets（全工作區現役）：' + (nowF() - dt0).toFixed(1) + ' ms，' + (dts ? dts.length : 'null') + ' 筆');
    // 大小：目錄檔
    const dirs = fs.readdirSync(path.join(sample, 'global-knowledge', 'schedules', 'index'));
    let tot = 0; for (const d of dirs) for (const f of fs.readdirSync(path.join(sample, 'global-knowledge', 'schedules', 'index', d))) tot += fs.statSync(path.join(sample, 'global-knowledge', 'schedules', 'index', d, f)).size;
    console.log('[real]   目錄檔共 ' + dirs.length + ' 個資料夾、' + (tot / 1024).toFixed(0) + ' KB');
    // 單次寫入成本（saveSchedules 多了差異比對）
    const wr = 5; let wOld = 0, wNew = 0;
    const lst = sm5.loadSchedules();
    for (let i = 0; i < wr; i++) { const a = nowF(); fs.writeFileSync(path.join(sample, 'x.tmp'), JSON.stringify(lst, null, 2)); wOld += nowF() - a; }
    for (let i = 0; i < wr; i++) { lst[0].lastRunAt = new Date().toISOString(); const a = nowF(); sm5.saveSchedules(lst); wNew += nowF() - a; }
    console.log('[real]   一次寫入：舊（只寫檔）' + (wOld / wr).toFixed(1) + ' ms → 新（寫檔＋差異比對＋排隊同步）' + (wNew / wr).toFixed(1) + ' ms');
    await sleep(500);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

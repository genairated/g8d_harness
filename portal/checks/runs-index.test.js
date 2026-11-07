// IDX-RUN 單元測試：執行記錄目錄（SPEC-list-index.md §9.1）。
// 用法：node portal/checks/runs-index.test.js [--real]
//   預設：造一份小型合成資料夾（暫存目錄）跑功能測試。
//   --real：另把 global-knowledge/schedules 複製到 _tmp/idx/runs-sample/home 當樣本，做「舊 vs 新」逐筆比對與耗時量測。
// 不起 server、不啟動排程器（不呼叫 start()），不碰真實資料（只讀、且複製後才改）。
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

function mkHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-idx-'));
  fs.mkdirSync(path.join(home, 'global-knowledge', 'schedules', 'runs'), { recursive: true });
  return home;
}
async function waitIdx(sm, wsRaw, pred, ms = 3000) {
  const h = listIndex.getIndex('runs', wsRaw);
  const t0 = Date.now();
  for (;;) {
    const a = (await h.list()).items, b = (await h.listArchived()).items;
    if (pred(a, b)) return { a, b };
    if (Date.now() - t0 > ms) throw new Error('目錄等待逾時');
    await sleep(30);
  }
}

(async () => {
  // ── 功能測試（合成資料）──────────────────────────────────────────────────
  const home = mkHome();
  const wsA = path.join(home, 'wsA'), wsB = path.join(home, 'wsB');
  fs.mkdirSync(wsA); fs.mkdirSync(wsB);
  const sm = new SchedulerManager(home);
  const sA = sm.createSchedule({ name: 'A', workspace: wsA });
  const sB = sm.createSchedule({ name: 'B', workspace: wsB.replace(/\\/g, '/') });   // 不同寫法
  const sH = sm.createSchedule({ name: 'H', workspace: null });                       // null ＝ harness home
  const sChat = sm.createSchedule({ name: 'C', workspace: wsA, chatTask: true, origin: { kind: 'chat', sessionId: 'sess1', workspace: wsA } });
  const sArch = sm.createSchedule({ name: 'X', workspace: wsA });

  await t('對帳前（未暖機）走舊路徑：getRunningRun／queryRuns 正確', async () => {
    const { run } = sm.createRun(sA.id, { trigger: 'manual', model: 'm' });
    assert.strictEqual(sm.getRunningRun(sA.id).id, run.id);          // _reconciled=false → 舊讀檔
    assert.ok(sm.hasAnyRunningRun());
    sm.updateRun(sA.id, run.id, { status: 'success', finishedAt: new Date().toISOString() });
    assert.strictEqual(sm.getRunningRun(sA.id), null);
    assert.strictEqual(sm.queryRuns({}).length, 1);
  });

  sm.reconcileOrphanRuns();
  await sm.warmRunIndex();

  await t('暖機後：記憶體路徑、目錄檔寫出、欄位齊全且沒有大欄位', async () => {
    assert.ok(sm._runMemWarm);
    const q = sm.queryRuns({});
    assert.strictEqual(q.length, 1);
    const e = q[0];
    for (const k of ['id', 'scheduleId', 'status', 'startedAt', 'finishedAt', 'trigger', 'model', 'resumeCount', 'origin', 'fromChat', 'hasCandidate', 'candidateReviewed', 'usage'])
      assert.ok(k in e, '缺欄位 ' + k);
    assert.ok(!('resolvedPrompt' in e) && !('delivery' in e));
    const { a } = await waitIdx(sm, wsA, (a) => a.length === 1);
    assert.strictEqual(a[0].status, 'success');
    const file = path.join(listIndex.sharedIndexDirFor(sm.schedulesDir, wsA), 'runs.json');
    assert.ok(fs.existsSync(file), '目錄檔應存在');
  });

  await t('建立→執行中→完成：目錄、執行中清單、getRunningRun／hasAnyRunningRun 一致', async () => {
    const { run } = sm.createRun(sA.id, { trigger: 'auto', model: 'x', resolvedPrompt: 'P'.repeat(10000) });
    assert.strictEqual(sm.getRunningRun(sA.id).id, run.id);
    assert.strictEqual(sm.getRunningRun(sB.id), null);
    assert.ok(sm.hasAnyRunningRun());
    assert.deepStrictEqual(sm.queryRuns({ status: 'running' }).map(r => r.id), [run.id]);
    await waitIdx(sm, wsA, (a) => a.some(x => x.id === run.id && x.status === 'running'));
    sm.updateRun(sA.id, run.id, { status: 'failed', finishedAt: new Date().toISOString(), usage: { calls: 3, runtimeMs: 1234 } });
    assert.strictEqual(sm.getRunningRun(sA.id), null);
    assert.ok(!sm.hasAnyRunningRun());
    const { a } = await waitIdx(sm, wsA, (a) => a.some(x => x.id === run.id && x.status === 'failed'));
    const e = a.find(x => x.id === run.id);
    assert.strictEqual(e.usage.runtimeMs, 1234);
    assert.ok(!JSON.stringify(e).includes('PPPP'), '目錄不放 resolvedPrompt');
  });

  await t('工作區隔離：workspace 參數只回該區（寫法不同、null＝harness home 都正規化）', async () => {
    const rB = sm.createRun(sB.id, {}).run, rH = sm.createRun(sH.id, {}).run;
    sm.updateRun(sB.id, rB.id, { status: 'success' }); sm.updateRun(sH.id, rH.id, { status: 'success' });
    assert.deepStrictEqual(sm.queryRuns({ workspace: wsB }).map(r => r.id), [rB.id]);
    assert.deepStrictEqual(sm.queryRuns({ workspace: home }).map(r => r.id), [rH.id]);
    assert.ok(sm.queryRuns({ workspace: wsA }).every(r => r.scheduleId === sA.id));
    assert.ok(sm.queryRuns({}).length >= 3, '無 workspace 參數＝全部');
    // 目錄一個工作區一份
    const dirA = listIndex.sharedIndexDirFor(sm.schedulesDir, wsA), dirB = listIndex.sharedIndexDirFor(sm.schedulesDir, wsB);
    assert.notStrictEqual(dirA, dirB);
  });

  await t('fromChat／origin 標註與舊 /api/runs 規則相同', async () => {
    const { run } = sm.createRun(sChat.id, { origin: null });
    const e = sm.queryRuns({ status: 'running' }).find(r => r.id === run.id);
    assert.strictEqual(e.fromChat, true);
    assert.strictEqual(e.origin.sessionId, 'sess1');          // run 沒帶 → 用排程 origin 回填
    sm.updateRun(sChat.id, run.id, { status: 'success' });
    const r2 = sm.createRun(sChat.id, { origin: { channel: 'chat', sessionId: 'mine', workspace: wsA } }).run;
    assert.strictEqual(sm.queryRuns({ status: 'running' }).find(r => r.id === r2.id).origin.sessionId, 'mine');  // run 自帶優先
    sm.updateRun(sChat.id, r2.id, { status: 'success' });
    assert.strictEqual(sm.queryRuns({ scheduleId: sA.id })[0].fromChat, false);
  });

  await t('saveMemoryCandidate → candidateReviewed 進目錄，updateRun 不會洗掉它', async () => {
    const { run } = sm.createRun(sA.id, {});
    sm.updateRun(sA.id, run.id, { status: 'success', hasCandidate: true });
    sm.saveMemoryCandidate(sA.id, run.id, { noteworthy: true, reviewed: false });
    assert.strictEqual(sm.queryRuns({ scheduleId: sA.id }).find(r => r.id === run.id).candidateReviewed, false);
    sm.saveMemoryCandidate(sA.id, run.id, { noteworthy: true, reviewed: true });
    assert.strictEqual(sm.queryRuns({ scheduleId: sA.id }).find(r => r.id === run.id).candidateReviewed, true);
    sm.updateRun(sA.id, run.id, { transcriptCleared: true });
    assert.strictEqual(sm.queryRuns({ scheduleId: sA.id }).find(r => r.id === run.id).candidateReviewed, true);
    const { a } = await waitIdx(sm, wsA, (a) => a.some(x => x.id === run.id && x.candidateReviewed === true));
    assert.ok(a.find(x => x.id === run.id).hasCandidate);
  });

  await t('歸檔排程（D5）：執行記錄進 runs.archive.json、不在全域查詢；還原後回主目錄', async () => {
    const { run } = sm.createRun(sArch.id, {});
    sm.updateRun(sArch.id, run.id, { status: 'success' });
    await waitIdx(sm, wsA, (a) => a.some(x => x.id === run.id));
    sm.updateSchedule(sArch.id, { archived: true });
    assert.strictEqual(await sm.syncRunsArchiveFlag(sArch.id), 1);
    const { a, b } = await waitIdx(sm, wsA, (a, b) => b.some(x => x.id === run.id) && !a.some(x => x.id === run.id));
    assert.ok(!a.some(x => x.id === run.id));
    assert.ok(!sm.queryRuns({}).some(r => r.id === run.id), '歸檔排程的 run 不在全域查詢');
    assert.strictEqual(sm.queryRuns({ scheduleId: sArch.id }).length, 1, '指定 scheduleId 仍可逐檔讀到');
    sm.updateSchedule(sArch.id, { archived: false });
    await sm.syncRunsArchiveFlag(sArch.id);
    await waitIdx(sm, wsA, (a) => a.some(x => x.id === run.id));
  });

  await t('重開機（新 SchedulerManager、刪掉目錄檔）→ 自動重建，數量與實際 run 檔相同', async () => {
    const disk = fs.readdirSync(sm.runsDir).filter(d => fs.statSync(path.join(sm.runsDir, d)).isDirectory())
      .reduce((n, d) => n + fs.readdirSync(path.join(sm.runsDir, d)).filter(f => f.endsWith('.json')).length, 0);
    await sleep(300);
    fs.rmSync(path.join(sm.schedulesDir, 'index'), { recursive: true, force: true });
    listIndex._reset();
    const sm2 = new SchedulerManager(home);
    sm2.reconcileOrphanRuns();
    await sm2.warmRunIndex();
    const mem = sm2._runMem.size;
    let archived = 0;
    for (const w of listIndex.listKinds()) void w;
    const hA = listIndex.getIndex('runs', wsA);
    archived = (await hA.listArchived()).items.length;
    assert.strictEqual(mem + archived, disk, `記憶體 ${mem} + 歸檔 ${archived} 應等於實際 ${disk}`);
    assert.ok(sm2._runMemWarm);
  });

  await t('對帳：殘留 running → interrupted，目錄同步', async () => {
    const h2 = mkHome(); const w = path.join(h2, 'w'); fs.mkdirSync(w);
    const s1 = new SchedulerManager(h2);
    const sc = s1.createSchedule({ name: 'Z', workspace: w });
    const { run } = s1.createRun(sc.id, {});            // 留在 running，模擬舊行程當掉
    await sleep(200); listIndex._reset();
    const s2 = new SchedulerManager(h2);                // 新行程
    s2.reconcileOrphanRuns(); await s2.warmRunIndex();
    assert.strictEqual(s2.getRunningRun(sc.id), null);
    assert.ok(!s2.hasAnyRunningRun());
    const { a } = await waitIdx(s2, w, (a) => a.some(x => x.id === run.id && x.status === 'interrupted'));
    assert.strictEqual(a.length, 1);
    fs.rmSync(h2, { recursive: true, force: true });
  });

  await t('暖機失敗時保底：_runMemWarm=false 仍走逐檔讀、且 workspace 參數照樣隔離', async () => {
    const h3 = mkHome(); const w1 = path.join(h3, 'w1'), w2 = path.join(h3, 'w2'); fs.mkdirSync(w1); fs.mkdirSync(w2);
    listIndex._reset();
    const s3 = new SchedulerManager(h3);
    const a = s3.createSchedule({ name: 'a', workspace: w1 }), b = s3.createSchedule({ name: 'b', workspace: w2 });
    const ra = s3.createRun(a.id, {}).run; s3.createRun(b.id, {});
    s3._runMemWarm = false;
    const r = s3.queryRuns({ workspace: w1 });
    assert.deepStrictEqual(r.map(x => x.id), [ra.id]);
    fs.rmSync(h3, { recursive: true, force: true });
  });

  fs.rmSync(home, { recursive: true, force: true });

  // ── 真實樣本：舊 vs 新逐筆比對＋耗時 ─────────────────────────────────────
  if (process.argv.includes('--real')) {
    const root = path.resolve(__dirname, '..', '..');
    const src = path.join(root, 'global-knowledge', 'schedules');
    const sampleHome = path.join(root, '_tmp', 'idx', 'runs-sample', 'home');
    fs.rmSync(path.join(root, '_tmp', 'idx', 'runs-sample'), { recursive: true, force: true });
    const dst = path.join(sampleHome, 'global-knowledge', 'schedules');
    fs.mkdirSync(dst, { recursive: true });
    fs.copyFileSync(path.join(src, 'schedules.json'), path.join(dst, 'schedules.json'));
    fs.cpSync(path.join(src, 'runs'), path.join(dst, 'runs'), { recursive: true });
    listIndex._reset();
    const rs = new SchedulerManager(sampleHome);
    const sched = rs.loadSchedules();
    const archivedIds = new Set(sched.filter(s => s.archived).map(s => s.id));
    const nRunFiles = fs.readdirSync(rs.runsDir).reduce((n, d) => { try { return n + fs.readdirSync(path.join(rs.runsDir, d)).filter(f => f.endsWith('.json')).length; } catch (e) { return n; } }, 0);
    console.log(`樣本：${sched.length} 筆排程（${archivedIds.size} 筆已歸檔）、${nRunFiles} 筆執行記錄`);

    rs.reconcileOrphanRuns();                       // 先把殘留 running 對帳掉，新舊才有可比性
    const nowIso = new Date().toISOString();
    const some = rs.queryRuns({ limit: 500 });
    const mid = some.length ? some[Math.floor(some.length / 2)].startedAt : nowIso;
    const sidWithRuns = (some.find(r => !archivedIds.has(r.scheduleId)) || some[0] || {}).scheduleId;
    const cases = {
      '無參數(limit 50)': {},
      '全部(limit 500)': { limit: 500 },
      'status=running': { status: 'running', limit: 200 },
      'status=failed': { status: 'failed', limit: 500 },
      'scheduleId': { scheduleId: sidWithRuns, limit: 500 },
      'since/until': { since: new Date(Date.parse(mid) - 5 * 86400000).toISOString(), until: mid, limit: 500 },
    };
    const keyFields = ['id', 'scheduleId', 'status', 'startedAt', 'finishedAt', 'trigger', 'model'];
    const oldRes = {}, oldMs = {}, newMs = {};
    for (const [k, o] of Object.entries(cases)) {
      const a = nowMs(); oldRes[k] = rs.queryRuns(o); oldMs[k] = nowMs() - a;
    }
    const tw0 = nowMs(); await rs.warmRunIndex(); const warmMs = nowMs() - tw0;
    for (const [k, o] of Object.entries(cases)) {
      let nw; const a = nowMs(); for (let i = 0; i < 20; i++) nw = rs.queryRuns(o); newMs[k] = (nowMs() - a) / 20;
      await t(`樣本比對「${k}」：新舊逐筆相同（舊=${oldMs[k]}ms，新=${newMs[k].toFixed(2)}ms）`, async () => {
        const expectOld = oldRes[k].filter(r => !archivedIds.has(r.scheduleId) || k === 'scheduleId');
        // 舊的 limit 在過濾前就截斷，這裡以「新結果＝舊全量過濾歸檔後取前 N」為準，所以舊用大 limit 重取
        const oldFull = rs._queryRunsScan(Object.assign({}, o, { limit: 100000 })).filter(r => !archivedIds.has(r.scheduleId) || k === 'scheduleId').slice(0, o.limit || 50);
        assert.strictEqual(nw.length, oldFull.length, `筆數 新${nw.length} ≠ 舊${oldFull.length}`);
        for (let i = 0; i < nw.length; i++)
          for (const f of keyFields) { let ov = oldFull[i][f]; if (f === 'trigger' && !ov) ov = 'auto'; /* 舊檔缺 trigger → 目錄統一補 'auto'（與 /api/schedules 相同預設） */ assert.strictEqual(nw[i][f] === undefined ? null : nw[i][f], ov === undefined ? null : ov, `第${i}筆 ${f}`); }
        void expectOld;
      });
    }
    await t('樣本：getRunningRun／hasAnyRunningRun 與逐檔讀一致（對帳後皆無）', async () => {
      assert.strictEqual(rs.hasAnyRunningRun(), false);
      for (const s of sched.slice(0, 40)) assert.strictEqual(rs.getRunningRun(s.id), null);
    });
    await t('樣本：每個現役排程的 run 筆數＝實際檔案數', async () => {
      const mem = new Map();
      for (const w of rs._runMem.values()) mem.set(w.e.scheduleId, (mem.get(w.e.scheduleId) || 0) + 1);
      for (const s of sched.filter(x => !x.archived)) {
        let n = 0; try { n = fs.readdirSync(path.join(rs.runsDir, s.id)).filter(f => f.endsWith('.json')).filter(f => { try { return !!JSON.parse(fs.readFileSync(path.join(rs.runsDir, s.id, f), 'utf8')).id; } catch (e) { return false; } }).length; } catch (e) {}  // 0 位元組壞檔舊、新都略過
        assert.strictEqual(mem.get(s.id) || 0, n, s.id);
      }
    });
    const dir = listIndex.sharedIndexDirFor(rs.schedulesDir, rs.harnessHome);
    const sizes = fs.readdirSync(path.dirname(dir)).map(d => fs.readdirSync(path.join(path.dirname(dir), d)).map(f => `${d}/${f}=${fs.statSync(path.join(path.dirname(dir), d, f)).size}B`)).flat();
    console.log('量測（毫秒）：');
    console.log('  暖機（核對＋重建＋載入記憶體，一次性、背景）: ' + warmMs);
    for (const k of Object.keys(cases)) console.log(`  ${k}: 舊 ${oldMs[k]} → 新 ${newMs[k].toFixed(2)}`);
    console.log('  執行中查詢 getRunningRun×1121: ' + (() => { const a = nowMs(); for (const s of sched) rs.getRunningRun(s.id); return nowMs() - a; })());
    console.log('  目錄檔: ' + sizes.join(', '));
    await sleep(500);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

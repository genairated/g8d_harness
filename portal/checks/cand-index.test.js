// IDX-CAND 單元測試：精華候選改走執行記錄目錄（SPEC-list-index.md §9.4）。
// 用法：node portal/checks/cand-index.test.js [--real]
//   預設：合成資料（暫存目錄）。--real：複製 global-knowledge/schedules 到 _tmp/idx/cand-sample，新舊逐筆比對＋量測耗時。
// 不起 server、不啟動排程器、不碰真實資料。
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
const sig = (list) => JSON.stringify(list.map(x => [x.scheduleId, x.scheduleName, x.runId, x.startedAt, x.candidate]));

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cand-idx-'));
  fs.mkdirSync(path.join(home, 'global-knowledge', 'schedules', 'runs'), { recursive: true });
  const wsA = path.join(home, 'wsA'), wsB = path.join(home, 'wsB');
  fs.mkdirSync(wsA); fs.mkdirSync(wsB);
  const sm = new SchedulerManager(home);
  const sA = sm.createSchedule({ name: 'A', workspace: wsA });
  const sB = sm.createSchedule({ name: 'B', workspace: wsB.split(String.fromCharCode(92)).join('/') });
  const sH = sm.createSchedule({ name: 'H', workspace: null });
  const mk = (s, cand) => {
    const { run } = sm.createRun(s.id, { trigger: 'manual' });
    sm.updateRun(s.id, run.id, { status: 'success', finishedAt: new Date().toISOString(), hasCandidate: !!cand });
    if (cand) sm.saveMemoryCandidate(s.id, run.id, cand);
    return run;
  };
  const r1 = mk(sA, { noteworthy: true, insight: 'a1', bucket: 'MEMORY' });
  mk(sA, { noteworthy: false });
  const r3 = mk(sA, { noteworthy: true, insight: 'a3', reviewed: true });
  const r4 = mk(sB, { noteworthy: true, insight: 'b1' });
  const r5 = mk(sH, { noteworthy: true, insight: 'h1' });
  mk(sH, null);
  sm.reconcileOrphanRuns();

  await t('暖機前走舊路徑', async () => {
    assert.strictEqual(sm._runMemWarm, false);
    assert.strictEqual(sm.collectCandidates(null).length, 3);
  });
  await sleep(100);
  await sm.warmRunIndex();
  await t('暖機後：null／各工作區結果與舊掃描逐筆相同', async () => {
    for (const w of [null, wsA, wsB, wsB.split(String.fromCharCode(92)).join('/').toUpperCase(), home]) {
      assert.strictEqual(sig(sm.collectCandidates(w)), sig(sm._collectCandidatesScan(w)), String(w));
    }
    assert.strictEqual(sm.collectCandidates(wsA).length, 1);
    assert.strictEqual(sm.collectCandidates(wsA)[0].scheduleName, 'A');
    assert.strictEqual(sm.collectCandidates(wsB).length, 1);
    assert.strictEqual(sm.collectCandidates(home).length, 1);   // null workspace ＝ harness home
  });
  await t('標記已審後即時減少、目錄旗標同步', async () => {
    sm.saveMemoryCandidate(sA.id, r1.id, Object.assign({}, sm.getMemoryCandidate(sA.id, r1.id), { reviewed: true }));
    assert.strictEqual(sm.collectCandidates(wsA).length, 0);
    assert.strictEqual(sm.collectCandidates(null).length, 2);
    const h = listIndex.getIndex('runs', wsA);
    for (let i = 0; i < 100; i++) { const it = (await h.list()).items.find(x => x.id === r1.id); if (it && it.candidateReviewed) break; await sleep(30); }
    const it = (await h.list()).items.find(x => x.id === r1.id);
    assert.strictEqual(it.candidateReviewed, true);
    assert.strictEqual(it.candidateNoteworthy, true);
  });
  await t('不值得記的候選不進清單、也不被讀檔', async () => {
    let reads = 0; const orig = sm.getMemoryCandidate.bind(sm);
    sm.getMemoryCandidate = (a, b) => { reads++; return orig(a, b); };
    sm.collectCandidates(null);
    sm.getMemoryCandidate = orig;
    assert.strictEqual(reads, 2, '只該讀 2 個待審候選，實際 ' + reads);
  });
  await t('舊目錄檔（無 candidateNoteworthy）仍正確：讀檔確認', async () => {
    for (const w of sm._runMem.values()) delete w.e.candidateNoteworthy;
    assert.strictEqual(sig(sm.collectCandidates(null)), sig(sm._collectCandidatesScan(null)));
  });
  await t('刪目錄檔重建後 candidateNoteworthy 由 candidate.json 回填', async () => {
    listIndex._reset();
    const sm2 = new SchedulerManager(home);
    sm2.reconcileOrphanRuns();
    const dir = listIndex.sharedIndexDirFor(sm2.schedulesDir, wsA);
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    listIndex._reset();
    const sm3 = new SchedulerManager(home);
    sm3.reconcileOrphanRuns();
    await sm3.warmRunIndex();
    const e = Array.from(sm3._runMem.values()).map(w => w.e);
    assert.strictEqual(e.find(x => x.id === r1.id).candidateReviewed, true);
    assert.strictEqual(e.find(x => x.id === r4.id).candidateNoteworthy, true);
    assert.strictEqual(sig(sm3.collectCandidates(null)), sig(sm3._collectCandidatesScan(null)));
    void r3; void r5;
  });
  fs.rmSync(home, { recursive: true, force: true });

  if (process.argv.includes('--real')) {
    const root = path.resolve(__dirname, '..', '..');
    const src = path.join(root, 'global-knowledge', 'schedules');
    const base = path.join(root, '_tmp', 'idx', 'cand-sample');
    fs.rmSync(base, { recursive: true, force: true });
    const dst = path.join(base, 'home', 'global-knowledge', 'schedules');
    fs.mkdirSync(dst, { recursive: true });
    fs.copyFileSync(path.join(src, 'schedules.json'), path.join(dst, 'schedules.json'));
    fs.cpSync(path.join(src, 'runs'), path.join(dst, 'runs'), { recursive: true });
    listIndex._reset();
    const rs = new SchedulerManager(path.join(base, 'home'));
    const sched = rs.loadSchedules();
    const archived = new Set(sched.filter(s => s.archived).map(s => s.id));
    rs.reconcileOrphanRuns();
    const wss = [null, ...Array.from(new Set(sched.filter(s => !s.archived && s.workspace).map(s => s.workspace))).slice(0, 6)];
    const oldRes = {}, oldMs = {};
    for (const w of wss) { const a = nowMs(); oldRes[String(w)] = rs._collectCandidatesScan(w); oldMs[String(w)] = nowMs() - a; }
    const tw = nowMs(); await rs.warmRunIndex(); const warmMs = nowMs() - tw;
    for (const w of wss) {
      let nw; const a = nowMs(); for (let i = 0; i < 20; i++) nw = rs.collectCandidates(w); const nm = (nowMs() - a) / 20;
      await t(`樣本「${w}」：新舊逐筆相同（${nw.length} 筆；舊 ${oldMs[String(w)]}ms → 新 ${nm.toFixed(2)}ms）`, async () => {
        const exp = oldRes[String(w)].filter(x => !archived.has(x.scheduleId));
        assert.strictEqual(sig(nw), sig(exp));
        const lost = oldRes[String(w)].length - exp.length;
        if (lost) console.log(`     （舊結果含 ${lost} 筆已歸檔排程的候選，新版依 D5 不列）`);
      });
    }
    console.log('量測：暖機（一次性背景）' + warmMs + ' ms');
    await sleep(500);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

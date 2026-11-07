'use strict';
// IDX-PM：專案管理寫入經排隊＋暫存換名。只用暫存目錄（可選：PM_SAMPLE 指向複製出來的樣本 HOME）。
// node portal/checks/pm-queue.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pm = require('../pm');

const ms = t => (Number(process.hrtime.bigint() - t) / 1e6).toFixed(1);

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-q-'));
  try {
    if (process.env.PM_SAMPLE) fs.cpSync(process.env.PM_SAMPLE, home, { recursive: true });
    await pm.updatePm(home, d => { d.projects.push({ id: 'P', name: 'p', workspace: null }); });
    const base = pm.readPm(home).tasks.length;

    // 1) 20 個任務同時新增，全部生效
    const jobs = [];
    for (let i = 0; i < 20; i++) jobs.push(pm.updatePm(home, d => { d.tasks.push({ id: 't' + i, projectId: 'P', name: 'n' + i, progress: 0 }); }));
    await Promise.all(jobs);
    let d = pm.readPm(home);
    assert.strictEqual(d.tasks.length, base + 20);

    // 2) 20 個任務同時更新（不同欄位／不同任務），全部生效，不互相覆蓋
    await Promise.all(Array.from({ length: 20 }, (_, i) => pm.updatePm(home, d => {
      const t = d.tasks.find(x => x.id === 't' + i); t.progress = i + 1; t.name = 'renamed' + i;
    })));
    d = pm.readPm(home);
    for (let i = 0; i < 20; i++) {
      const t = d.tasks.find(x => x.id === 't' + i);
      assert.strictEqual(t.progress, i + 1); assert.strictEqual(t.name, 'renamed' + i);
    }

    // 3) 同時混合：更新＋刪除＋資源新增
    await Promise.all([
      pm.updatePm(home, d => { d.tasks = d.tasks.filter(x => x.id !== 't0'); }),
      pm.updatePm(home, d => { d.resources.push({ id: 'r1', name: 'x' }); }),
      pm.updatePm(home, d => { d.tasks.find(x => x.id === 't1').progress = 99; }),
    ]);
    d = pm.readPm(home);
    assert.ok(!d.tasks.some(x => x.id === 't0'));
    assert.ok(d.resources.some(x => x.id === 'r1'));
    assert.strictEqual(d.tasks.find(x => x.id === 't1').progress, 99);

    // 4) 無暫存殘留
    assert.deepStrictEqual(fs.readdirSync(path.dirname(pm.pmPath(home))).filter(f => f.includes('.tmp-')), []);

    // 5) mutator 丟錯 → 不寫檔、後續照常；回傳值傳回呼叫端
    const before = fs.readFileSync(pm.pmPath(home), 'utf8');
    await assert.rejects(pm.updatePm(home, d => { d.tasks.length = 0; throw new Error('boom'); }), /boom/);
    assert.strictEqual(fs.readFileSync(pm.pmPath(home), 'utf8'), before);
    assert.strictEqual(await pm.updatePm(home, d => d.tasks.find(x => x.id === 't2').id), 't2');

    // 6) 檔案壞掉 → 拒絕寫入、不覆寫成空資料
    fs.writeFileSync(pm.pmPath(home), '{ broken');
    await assert.rejects(pm.updatePm(home, d => { d.tasks.push({ id: 'z' }); }), /無法解析/);
    assert.strictEqual(fs.readFileSync(pm.pmPath(home), 'utf8'), '{ broken');
    fs.writeFileSync(pm.pmPath(home), before);

    // 7) 量測
    const R = 30;
    let t = process.hrtime.bigint(); for (let i = 0; i < R; i++) pm.readPm(home);
    console.log(`read avg ms: ${(ms(t) / R).toFixed(2)} (tasks=${pm.readPm(home).tasks.length})`);
    t = process.hrtime.bigint();
    for (let i = 0; i < R; i++) { const x = pm.readPm(home); fs.writeFileSync(pm.pmPath(home), JSON.stringify(x, null, 2)); }
    console.log(`OLD-style sync write avg ms: ${(ms(t) / R).toFixed(2)}`);
    t = process.hrtime.bigint();
    for (let i = 0; i < R; i++) await pm.updatePm(home, d => { d.tasks[0].progress = i; });
    console.log(`NEW updatePm sequential avg ms: ${(ms(t) / R).toFixed(2)}`);
    t = process.hrtime.bigint();
    await Promise.all(Array.from({ length: 20 }, (_, i) => pm.updatePm(home, d => { d.tasks[i % d.tasks.length].progress = 50; })));
    console.log(`NEW 20 concurrent updates total ms: ${ms(t)}`);
    console.log('PASS pm-queue');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
})().catch(e => { console.error('FAIL', e); process.exit(1); });

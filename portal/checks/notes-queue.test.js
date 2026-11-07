'use strict';
// IDX-NOTE：便條寫入經排隊＋暫存換名。用暫存目錄，不碰真實資料。node portal/checks/notes-queue.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const notes = require('../notes');

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-q-'));
  try {
    // 1) 20 個新增（API 與 Telegram 交錯）＋同時一次到期標記，全部都在
    const mk = i => ({ id: 'n' + i, text: 't' + i, status: 'active', dueAt: null, remindedAt: null });
    const jobs = [];
    for (let i = 0; i < 20; i++) jobs.push(notes.updateNotes(home, l => { l.push(mk(i)); }));
    jobs.push(notes.updateNotes(home, l => { const n = l.find(x => x.id === 'n0'); if (n) n.remindedAt = 'x'; }));
    jobs.push(notes.updateNotes(home, l => l.filter(n => n.id !== 'n19')));
    await Promise.all(jobs);
    const list = notes.readNotes(home);
    assert.strictEqual(list.length, 19, '20 增 1 刪 = 19');
    for (let i = 0; i < 19; i++) assert.ok(list.some(n => n.id === 'n' + i), 'n' + i + ' 遺失');
    assert.ok(!list.some(n => n.id === 'n19'));
    // 2) 無暫存殘留
    const left = fs.readdirSync(path.dirname(notes.notesPath(home))).filter(f => f.includes('.tmp-'));
    assert.deepStrictEqual(left, []);
    // 3) mutator 丟錯 → 不寫檔、後續照常
    await assert.rejects(notes.updateNotes(home, () => { throw new Error('boom'); }), /boom/);
    await notes.updateNotes(home, l => { l.push(mk(99)); });
    assert.strictEqual(notes.readNotes(home).length, 20);
    // 4) 回傳值傳回呼叫端
    const r = await notes.updateNotes(home, l => l.find(n => n.id === 'n1'));
    assert.strictEqual(r.id, 'n1');
    // 5) 量測：200 筆清單讀取
    await notes.updateNotes(home, l => { for (let i = 100; i < 300; i++) l.push(mk(i)); });
    const t = process.hrtime.bigint();
    for (let i = 0; i < 50; i++) notes.readNotes(home);
    console.log('read x50 on', notes.readNotes(home).length, 'notes ms:', Number(process.hrtime.bigint() - t) / 1e6);
    console.log('PASS notes-queue');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
})().catch(e => { console.error('FAIL', e); process.exit(1); });

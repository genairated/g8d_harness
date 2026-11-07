'use strict';
// IDX-AUD：音訊主題寫入走排隊＋暫存換名。暫存目錄跑，不碰真實資料。
const fs = require('fs'), os = require('os'), path = require('path');
const at = require('../audio-topics');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const root = fs.mkdtempSync(path.join(process.env.AUD_TMP || os.tmpdir(), 'aud-'));
  const home = path.join(root, 'home'), ws = path.join(root, 'ws');
  fs.mkdirSync(home); fs.mkdirSync(ws);
  // 新增主題（全域＋工作區）、改預設
  const g = at.readGlobal(home); g.topics.push({ id: 'g1', name: 'G' }); at.writeGlobal(home, g);
  const w = at.readWorkspace(ws); w.topics.push({ id: 'w1', name: 'W', workspace: ws }); w.defaultTopicId = 'g1'; at.writeWorkspace(ws, w);
  // 寫入未完成時立即讀：要讀到最新（不丟更新）
  ok(at.readGlobal(home).topics.length === 1 && at.readWorkspace(ws).defaultTopicId === 'g1', '寫入未落檔前讀到最新');
  ok(at.getDefaultTopicId(ws) === 'g1' && at.mergedList(home, ws).length === 2, '預設與合併清單正確');
  // 連續快速 read-modify-write 20 次，不遺失
  for (let i = 0; i < 20; i++) { const x = at.readGlobal(home); x.topics.push({ id: 'n' + i }); at.writeGlobal(home, x); }
  await sleep(500);
  const disk = JSON.parse(fs.readFileSync(at.globalTopicsPath(home), 'utf8'));
  ok(disk.topics.length === 21, '連續 20 筆新增全落檔（共 ' + disk.topics.length + '）');
  const dw = JSON.parse(fs.readFileSync(at.workspaceTopicsPath(ws), 'utf8'));
  ok(dw.defaultTopicId === 'g1' && dw.topics.length === 1, '工作區檔格式不變、預設已落檔');
  // 刪預設
  const w2 = at.readWorkspace(ws); w2.defaultTopicId = null; w2.topics = []; at.writeWorkspace(ws, w2);
  await sleep(300);
  ok(JSON.parse(fs.readFileSync(at.workspaceTopicsPath(ws), 'utf8')).defaultTopicId === null, '清除預設落檔');
  ok(fs.readdirSync(path.dirname(at.globalTopicsPath(home))).every(n => !n.includes('.tmp-')), '無殘留暫存檔');
  ok(!fs.existsSync(path.join(path.dirname(at.globalTopicsPath(home)), '.gitignore')), '未多出 .gitignore');
  // 計時
  const t0 = process.hrtime.bigint(); for (let i = 0; i < 200; i++) at.mergedList(home, ws);
  console.log('  mergedList x200: ' + Number(process.hrtime.bigint() - t0) / 1e6 + ' ms');
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${pass} 通過 / ${fail} 失敗`); process.exit(fail ? 1 : 0);
})();

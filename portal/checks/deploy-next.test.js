#!/usr/bin/env node
// 單元測試：SCHED-DEPLOY-NEXT「部署成功後接續」的純邏輯（portal/deploy-next.js）。
// 不起 server、不碰 schedules.json——全部用假排程清單／假部署結果。
// 用法：node portal/checks/deploy-next.test.js（失敗 exit 1）
'use strict';
const assert = require('assert');
const path = require('path');
const { decideNextAfterDeploy, sanitizeNextAfterDeploy } = require(path.join(__dirname, '..', 'deploy-next'));

const P0 = { id: 'sched_p0', name: '平台 P0', workspace: 'D:\\SideProject\\g8d_harness', postRun: { deploy: true, nextAfterDeploy: 'sched_p1' } };
const P1 = { id: 'sched_p1', name: '客戶專案 P1', workspace: 'D:\\Projects\\客戶專案' };
const SELF = { id: 'sched_self', name: '指向自己', postRun: { deploy: true, nextAfterDeploy: 'sched_self' } };
const GHOST = { id: 'sched_ghost', name: '指向不存在', postRun: { deploy: true, nextAfterDeploy: 'sched_nope' } };
const list = [P0, P1, SELF, GHOST];

let pass = 0;
function t(name, fn) { fn(); pass++; console.log('  ✓ ' + name); }

console.log('decideNextAfterDeploy（開機對帳時要不要接）');
t('部署 success → 接續 P1（跨工作區）', () => {
  const d = decideNextAfterDeploy({ status: 'success', scheduleId: 'sched_p0', schedules: list });
  assert.strictEqual(d.next && d.next.id, 'sched_p1'); assert.strictEqual(d.reason, 'ok');
});
t('部署 failed → 不接', () => {
  const d = decideNextAfterDeploy({ status: 'failed', scheduleId: 'sched_p0', schedules: list });
  assert.strictEqual(d.next, null); assert.strictEqual(d.reason, 'deploy-failed');
});
t('部署 unknown → 不接', () => {
  const d = decideNextAfterDeploy({ status: 'unknown', scheduleId: 'sched_p0', schedules: list });
  assert.strictEqual(d.next, null); assert.strictEqual(d.reason, 'deploy-unknown');
});
t('目標 id 不存在 → 不接', () => {
  const d = decideNextAfterDeploy({ status: 'success', scheduleId: 'sched_ghost', schedules: list });
  assert.strictEqual(d.next, null); assert.strictEqual(d.reason, 'target-missing');
});
t('指向自己 → 不接', () => {
  const d = decideNextAfterDeploy({ status: 'success', scheduleId: 'sched_self', schedules: list });
  assert.strictEqual(d.next, null); assert.strictEqual(d.reason, 'self');
});
t('沒設 nextAfterDeploy → 不接（not-set）', () => {
  const d = decideNextAfterDeploy({ status: 'success', scheduleId: 'sched_p1', schedules: list });
  assert.strictEqual(d.next, null); assert.strictEqual(d.reason, 'not-set');
});
t('來源排程已被刪 → 不接', () => {
  const d = decideNextAfterDeploy({ status: 'success', scheduleId: 'sched_gone', schedules: list });
  assert.strictEqual(d.next, null); assert.strictEqual(d.reason, 'source-missing');
});
t('目標已歸檔 → 不接', () => {
  const l2 = [P0, Object.assign({}, P1, { archived: true })];
  const d = decideNextAfterDeploy({ status: 'success', scheduleId: 'sched_p0', schedules: l2 });
  assert.strictEqual(d.next, null); assert.strictEqual(d.reason, 'target-archived');
});

console.log('sanitizeNextAfterDeploy（API 驗證要保留欄位、擋錯值）');
t('合法值保留', () => {
  assert.deepStrictEqual(sanitizeNextAfterDeploy({ deploy: true, nextAfterDeploy: 'sched_p1' }, { selfId: 'sched_p0', schedules: list }), { ok: true, value: 'sched_p1' });
});
t('不存在的 id → 拒絕', () => {
  assert.strictEqual(sanitizeNextAfterDeploy({ deploy: true, nextAfterDeploy: 'sched_nope' }, { selfId: 'sched_p0', schedules: list }).ok, false);
});
t('指向自己 → 拒絕', () => {
  assert.strictEqual(sanitizeNextAfterDeploy({ deploy: true, nextAfterDeploy: 'sched_p0' }, { selfId: 'sched_p0', schedules: list }).ok, false);
});
t('沒開 deploy 卻明確帶值 → 拒絕', () => {
  assert.strictEqual(sanitizeNextAfterDeploy({ deploy: false, nextAfterDeploy: 'sched_p1' }, { selfId: 'sched_x', schedules: list }).ok, false);
});
t('PUT 沒帶欄位 → 沿用磁碟上的值（只改 deploy 的呼叫端不會洗掉它）', () => {
  assert.deepStrictEqual(sanitizeNextAfterDeploy({ deploy: true }, { selfId: 'sched_p0', schedules: list, existing: P0 }), { ok: true, value: 'sched_p1' });
});
t('PUT 沒帶欄位但把 deploy 關掉 → 一併清掉', () => {
  assert.deepStrictEqual(sanitizeNextAfterDeploy({ deploy: false }, { selfId: 'sched_p0', schedules: list, existing: P0 }), { ok: true, value: null });
});
t('明確帶 null → 清掉', () => {
  assert.deepStrictEqual(sanitizeNextAfterDeploy({ deploy: true, nextAfterDeploy: null }, { selfId: 'sched_p0', schedules: list, existing: P0 }), { ok: true, value: null });
});
t('非字串 → 拒絕', () => {
  assert.strictEqual(sanitizeNextAfterDeploy({ deploy: true, nextAfterDeploy: 123 }, { schedules: list }).ok, false);
});

console.log(`\n全部通過：${pass} 項`);

// deploy-next.js — SCHED-DEPLOY-NEXT「部署成功後接續」的純邏輯（無 I/O，可單獨測）
// spec: specs/SPEC-schedule-deploy-control.md §4.8
//
// postRun.nextAfterDeploy = <排程 id>：只有 postRun.deploy=true 的鏈尾排程可設（D2 不變：chainNext 仍須為空）。
// 新版 server 開機時 reconcilePendingDeploy() 判定部署 success 後，才依此接續；failed／unknown 一律不接。
'use strict';

// API 驗證用：把 raw postRun 裡的 nextAfterDeploy 正規化。
//   raw       — 請求帶來的 postRun 物件（已確認 deploy 為 boolean）
//   selfId    — 被編輯的排程 id（建立時為 null）
//   schedules — 目前全部排程（跨工作區）
//   existing  — PUT 時磁碟上的排程（POST 為 null）；請求「沒帶」這個欄位時沿用它的值，
//               避免只改 deploy 的呼叫端把接續設定默默洗掉。
// → { ok:true, value: id|null } 或 { ok:false, error }
function sanitizeNextAfterDeploy(raw, { selfId = null, schedules = [], existing = null } = {}) {
  const deploy = !!(raw && raw.deploy === true);
  let v;
  if (raw && Object.prototype.hasOwnProperty.call(raw, 'nextAfterDeploy')) v = raw.nextAfterDeploy;
  else v = existing && existing.postRun ? existing.postRun.nextAfterDeploy : null;
  if (v === undefined || v === null || v === '') return { ok: true, value: null };
  if (typeof v !== 'string') return { ok: false, error: 'postRun.nextAfterDeploy 必須是排程 id 字串' };
  if (!deploy) {
    // 沒帶欄位、只是把 deploy 關掉 → 一起清掉；明確帶值卻沒開 deploy → 拒絕
    if (raw && Object.prototype.hasOwnProperty.call(raw, 'nextAfterDeploy')) {
      return { ok: false, error: '「部署成功後接續」只能設在有開啟佈署的排程' };
    }
    return { ok: true, value: null };
  }
  if (selfId && v === selfId) return { ok: false, error: '「部署成功後接續」不可指向自己' };
  if (!schedules.some(s => s && s.id === v)) return { ok: false, error: `「部署成功後接續」指向的排程不存在：${v}` };
  return { ok: true, value: v };
}

// 開機對帳用：這次部署結果要不要接續、接誰。
//   status     — reconcilePendingDeploy 判定的 'success' | 'failed' | 'unknown'
//   scheduleId — 觸發部署的那支排程
//   schedules  — 重讀的全部排程（跨工作區；triggerNow 本來就以 id 找全域排程）
// → { next: <schedule>|null, reason }
function decideNextAfterDeploy({ status, scheduleId, schedules = [] }) {
  if (status !== 'success') return { next: null, reason: `deploy-${status || 'unknown'}` };
  const self = schedules.find(s => s && s.id === scheduleId);
  if (!self) return { next: null, reason: 'source-missing' };
  const target = self.postRun && self.postRun.nextAfterDeploy;
  if (!target) return { next: null, reason: 'not-set' };
  if (!(self.postRun && self.postRun.deploy === true)) return { next: null, reason: 'deploy-off' };
  if (target === scheduleId) return { next: null, reason: 'self' };
  const next = schedules.find(s => s && s.id === target);
  if (!next) return { next: null, reason: 'target-missing' };
  if (next.archived) return { next: null, reason: 'target-archived' };
  return { next, reason: 'ok' };
}

module.exports = { sanitizeNextAfterDeploy, decideNextAfterDeploy };

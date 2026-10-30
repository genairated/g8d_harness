'use strict';
// SPEC-issue-report.md §5.5 — rrweb 事件 → 給 Hana 讀的文字時間軸（timeline.md）。
// 純程式轉換，不用 AI、零額度。真相是 replay.json.gz；這份只是省 token 的快取。
//
// 輸入事件來源：rrweb 內建事件（type 2 全量快照、type 3 增量：mutation / click / input / scroll）
//   ＋ 前端錄製器用 addCustomEvent 塞的 type 5：tag = route | error | console-error | api。

// rrweb enum（固定值，不依賴套件）
const ET = { Meta: 4, FullSnapshot: 2, Incremental: 3, Custom: 5 };
const IS = { Mutation: 0, MouseInteraction: 2, Scroll: 3, Input: 5 };
const MI = { Click: 2, DblClick: 4 };

const MAX_TEXT = 40;
const SCROLL_MERGE_MS = 1500;
const CLICKABLE = new Set(['button', 'a', 'label', 'option', 'summary', 'input', 'select', 'textarea', 'tr', 'li', 'td', 'th']);

function pad(n) { return String(n).padStart(2, '0'); }
function hms(ts) { const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
function clip(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; }

// ── 節點表：從快照 / mutation 維護 id → node，之後點擊才查得到「那顆按鈕寫什麼」 ──
function makeDom() {
  const nodes = new Map();
  function walk(n, parentId) {
    if (!n || typeof n !== 'object') return;
    nodes.set(n.id, { id: n.id, type: n.type, tagName: n.tagName ? String(n.tagName).toLowerCase() : null, attributes: n.attributes || {}, textContent: n.textContent, parentId: parentId, children: [] });
    const p = nodes.get(parentId);
    if (p) p.children.push(n.id);
    (n.childNodes || []).forEach(c => walk(c, n.id));
  }
  function removeNode(id) {
    const n = nodes.get(id); if (!n) return;
    n.children.slice().forEach(removeNode);
    const p = nodes.get(n.parentId);
    if (p) p.children = p.children.filter(c => c !== id);
    nodes.delete(id);
  }
  return {
    nodes,
    reset() { nodes.clear(); },
    snapshot(root) { nodes.clear(); walk(root, null); },
    mutate(d) {
      (d.removes || []).forEach(r => removeNode(r.id));
      (d.adds || []).forEach(a => walk(a.node, a.parentId));
      (d.texts || []).forEach(t => { const n = nodes.get(t.id); if (n) n.textContent = t.value; });
      (d.attributes || []).forEach(a => { const n = nodes.get(a.id); if (n) Object.assign(n.attributes, a.attributes); });
    },
  };
}

function textOf(dom, id, depth) {
  const n = dom.nodes.get(id); if (!n || depth > 6) return '';
  if (n.type === 3) return n.textContent || '';
  if (n.tagName === 'script' || n.tagName === 'style' || n.tagName === 'select' || n.tagName === 'option') return '';   // 欄位名稱不要混進下拉選項文字
  return n.children.map(c => textOf(dom, c, depth + 1)).join(' ');
}

// 欄位的人話名稱：<label for>、包著它的 <label>、aria-label、placeholder、name、id
function fieldName(dom, n) {
  const a = n.attributes || {};
  if (a.id) {
    for (const o of dom.nodes.values()) {
      if (o.tagName === 'label' && o.attributes && o.attributes.for === a.id) { const t = clip(textOf(dom, o.id, 0), MAX_TEXT); if (t) return t; }
    }
  }
  let p = dom.nodes.get(n.parentId);
  for (let i = 0; p && i < 4; i++, p = dom.nodes.get(p.parentId)) {
    if (p.tagName === 'label') { const t = clip(textOf(dom, p.id, 0), MAX_TEXT); if (t) return t; }
  }
  return a['aria-label'] || a.placeholder || a.title || a.name || a.id || (n.tagName || '欄位');
}

// 把點擊的節點講成人話：往上找最近的可點元素，帶文字／標籤
function describeTarget(dom, id) {
  let n = dom.nodes.get(id); if (!n) return '畫面上的某處';
  let hop = 0;
  while (n && hop < 6 && !(n.tagName && (CLICKABLE.has(n.tagName) || (n.attributes && (n.attributes.role === 'button' || n.attributes.onclick != null))))) {
    n = dom.nodes.get(n.parentId); hop++;
  }
  if (!n) n = dom.nodes.get(id);
  const a = n.attributes || {};
  const tag = n.tagName;
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const t = String(a.type || '').toLowerCase();
    if (t === 'button' || t === 'submit') return '按鈕「' + clip(a.value || a.id || '', MAX_TEXT) + '」';
    if (t === 'checkbox' || t === 'radio') return (t === 'checkbox' ? '勾選框「' : '選項「') + fieldName(dom, n) + '」';
    return '欄位「' + fieldName(dom, n) + '」';
  }
  const txt = clip(textOf(dom, n.id, 0), MAX_TEXT) || a['aria-label'] || a.title || '';
  if (tag === 'button' || a.role === 'button') return '按鈕「' + (txt || a.id || '（無文字）') + '」';
  if (tag === 'a') return '連結「' + (txt || a.href || '') + '」';
  if (tag === 'tr' || tag === 'td' || tag === 'li') return '「' + (txt || tag) + '」那一列';
  if (txt) return '「' + txt + '」';
  return (tag || '元素') + (a.id ? '#' + a.id : '');
}

// 錯誤堆疊 → 第一個「平台自己的」frame：檔名:行號。略過 vendor 與 rrweb。
function firstFrame(stack) {
  const lines = String(stack || '').split('\n');
  for (const ln of lines) {
    const m = /((?:https?:\/\/[^\s)]+?|file:\/\/[^\s)]+?|\/[^\s):]+?))(?::(\d+))(?::(\d+))?\)?\s*$/.exec(ln.trim());
    if (!m) continue;
    if (/\/vendor\//.test(m[1])) continue;
    let f = m[1].replace(/^https?:\/\/[^/]+/, '').replace(/^\//, '');
    return f + ':' + m[2];
  }
  return '';
}
function frames(stack, n) {
  return String(stack || '').split('\n').map(s => s.trim()).filter(s => /:\d+/.test(s) && /^(at |[^\s]+@)/.test(s)).slice(0, n);
}

function buildTimeline(events, meta) {
  meta = meta || {};
  events = (Array.isArray(events) ? events : []).filter(e => e && typeof e.timestamp === 'number').sort((a, b) => a.timestamp - b.timestamp);
  const dom = makeDom();
  const out = [];       // { ts, text }
  let pendInput = null; // 合併連續輸入
  let pendScroll = null;
  let lastApi = null;

  const flushInput = () => {
    if (!pendInput) return;
    const p = pendInput; pendInput = null;
    const n = dom.nodes.get(p.id);
    const a = (n && n.attributes) || {};
    const name = n ? fieldName(dom, n) : '欄位';
    const isPwd = String(a.type || '').toLowerCase() === 'password';
    let txt;
    if (isPwd) txt = '在「' + name + '」輸入密碼（內容不顯示）';
    else if (n && n.tagName === 'select') txt = '在「' + name + '」選擇「' + clip(p.text, 60) + '」';
    else if (p.isChecked != null && (a.type === 'checkbox' || a.type === 'radio')) txt = (p.isChecked ? '勾選' : '取消勾選') + '「' + name + '」';
    else txt = '在「' + name + '」輸入「' + clip(p.text, 80) + '」' + (p.text === '' ? '（清空）' : '');
    out.push({ ts: p.ts, text: txt });
  };
  const flushScroll = () => {
    if (!pendScroll) return;
    out.push({ ts: pendScroll.ts, text: '捲動畫面' + (pendScroll.y != null ? '（位置 ' + Math.round(pendScroll.y) + '）' : '') });
    pendScroll = null;
  };
  const flushAll = () => { flushInput(); flushScroll(); };

  for (const e of events) {
    if (e.type === ET.FullSnapshot) { flushAll(); dom.snapshot(e.data && e.data.node); continue; }
    if (e.type === ET.Meta) {
      if (!out.length && e.data && e.data.href) out.push({ ts: e.timestamp, text: '紀錄起點：' + String(e.data.href).replace(/^https?:\/\/[^/]+/, '') });
      continue;
    }
    if (e.type === ET.Custom) {
      flushAll();
      const tag = e.data && e.data.tag; const p = (e.data && e.data.payload) || {};
      if (tag === 'route') {
        out.push({ ts: e.timestamp, text: '切到「' + (p.title || p.view || p.to) + '」畫面（' + p.to + '）' });
      } else if (tag === 'error' || tag === 'console-error') {
        const loc = firstFrame(p.stack) || (p.source ? String(p.source).replace(/^https?:\/\/[^/]+\//, '') + (p.line ? ':' + p.line : '') : '');
        const label = tag === 'console-error' ? 'console.error' : '畫面錯誤';
        let t = label + '：' + clip(p.message, 200) + (loc ? '（' + loc + '）' : '');
        const fr = frames(p.stack, 3);
        if (fr.length) t += '\n            堆疊：' + fr.join(' ← ');
        out.push({ ts: e.timestamp, text: t });
      } else if (tag === 'api') {
        const bad = !(p.status >= 200 && p.status < 400);
        const key = p.method + ' ' + p.url + ' ' + p.status;
        if (!bad && lastApi && lastApi.key === key && e.timestamp - lastApi.ts < 60000) { lastApi.item.n++; lastApi.item.text = lastApi.item.base + ' ×' + lastApi.item.n; lastApi.ts = e.timestamp; continue; }
        const base = 'API ' + p.method + ' ' + p.url + ' → ' + (p.status || '連線失敗') + (p.ms != null ? '（' + p.ms + 'ms）' : '');
        const item = { ts: e.timestamp, base, n: 1, text: base + (bad && p.body ? '（回應：' + clip(p.body, 300) + '）' : '') };
        out.push(item);
        lastApi = bad ? null : { key, ts: e.timestamp, item };
      }
      continue;
    }
    if (e.type !== ET.Incremental || !e.data) continue;
    const d = e.data;
    if (d.source === IS.Mutation) { dom.mutate(d); continue; }
    if (d.source === IS.MouseInteraction && (d.type === MI.Click || d.type === MI.DblClick)) {
      flushAll();
      out.push({ ts: e.timestamp, text: (d.type === MI.DblClick ? '雙擊' : '點擊') + describeTarget(dom, d.id) });
      continue;
    }
    if (d.source === IS.Input) {
      flushScroll();
      if (pendInput && pendInput.id !== d.id) flushInput();
      pendInput = { id: d.id, text: d.text, isChecked: d.isChecked, ts: e.timestamp };
      continue;
    }
    if (d.source === IS.Scroll) {
      flushInput();
      if (pendScroll && e.timestamp - pendScroll.last <= SCROLL_MERGE_MS && pendScroll.id === d.id) { pendScroll.last = e.timestamp; pendScroll.y = d.y; }
      else { flushScroll(); pendScroll = { id: d.id, ts: e.timestamp, last: e.timestamp, y: d.y }; }
      continue;
    }
  }
  flushAll();
  out.sort((a, b) => a.ts - b.ts);

  // 最後一行：指揮官的指認與說明
  const lines = out.map(o => hms(o.ts) + '  ' + o.text);
  const submitTs = meta.submittedAt ? Date.parse(meta.submittedAt) : Date.now();
  const pickTxt = meta.pick && (meta.pick.text || meta.pick.selector)
    ? '指揮官指認：' + (meta.pick.text ? '「' + clip(meta.pick.text, 60) + '」' : '') + (meta.pick.selector ? '（' + meta.pick.selector + '）' : '') + (meta.pick.value ? '，當下值「' + clip(meta.pick.value, 60) + '」' : '') + '；'
    : '指揮官';
  lines.push(hms(submitTs) + '  ' + pickTxt + '說明：' + clip(meta.description, 500));

  const head = [];
  head.push('# 問題單 ' + (meta.id != null ? '#' + meta.id : '') + ' 時間軸' + (meta.title ? '：' + meta.title : ''));
  head.push('');
  const kv = [];
  if (meta.type) kv.push('類型：' + (meta.type === 'feature' ? '新需求' : '問題'));
  if (meta.workspace) kv.push('工作區：' + meta.workspace);
  if (meta.route) kv.push('畫面：' + meta.route);
  if (meta.version) kv.push('平台版本：' + meta.version);
  if (events.length) kv.push('紀錄範圍：' + hms(events[0].timestamp) + ' ~ ' + hms(events[events.length - 1].timestamp) + (meta.fromPageLoad ? '（自頁面載入起，緩衝可能不足設定分鐘數）' : ''));
  kv.forEach(s => head.push('- ' + s));
  head.push('', '```');
  return head.join('\n') + '\n' + lines.join('\n') + '\n```\n';
}

module.exports = { buildTimeline, firstFrame, hms };

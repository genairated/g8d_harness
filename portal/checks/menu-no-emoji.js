#!/usr/bin/env node
// 護欄：側欄 menu 一律只用 lucide icon（<i data-lucide="...">），標籤文字裡不得出現 emoji。
// 由來：「白板」的選單標籤被反覆塞進 🖊️ emoji，造成同一列出現兩個圖示（lucide + emoji）。
// 查無任何技能／spec／程式會自動產生它 → 判定為人工誤植，故改用部署前靜態檢查把它擋在上線之前。
// 用法：node portal/checks/menu-no-emoji.js <path-to-index.html>（失敗 exit 1，Deploy 會中止）
const fs = require('fs');
const path = require('path');

const target = process.argv[2] || path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(target, 'utf8');

// 側欄標籤一律掛 .sb-collapse-hide；plugin/view 的 meta.title 由 sidebar.js 以純文字渲染，
// 另在 checkViewMeta() 一併掃。
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}]/u;
const offenders = [];

src.split('\n').forEach((line, i) => {
  if (!/sb-collapse-hide/.test(line)) return;
  const m = line.match(/sb-collapse-hide"[^>]*>([^<]*)</);
  if (m && EMOJI.test(m[1])) offenders.push({ file: path.basename(target), line: i + 1, text: m[1].trim() });
});

// view 模組的 meta.title（sidebar.js / plugin-loader 用它當 menu 文字）
const viewsDir = path.join(path.dirname(target), 'views');
if (fs.existsSync(viewsDir)) {
  for (const f of fs.readdirSync(viewsDir).filter(n => n.endsWith('.js'))) {
    const txt = fs.readFileSync(path.join(viewsDir, f), 'utf8');
    const m = txt.match(/export\s+const\s+meta\s*=\s*\{[^}]*title:\s*['"]([^'"]*)['"]/);
    if (m && EMOJI.test(m[1])) offenders.push({ file: 'views/' + f, line: 0, text: m[1] });
  }
}

if (offenders.length) {
  console.error('[menu-no-emoji] menu 標籤不得含 emoji（請改用 lucide icon）：');
  offenders.forEach(o => console.error('  - ' + o.file + (o.line ? ':' + o.line : '') + '  「' + o.text + '」'));
  process.exit(1);
}
console.log('[menu-no-emoji] OK — menu 標籤皆無 emoji');

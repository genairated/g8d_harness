#!/usr/bin/env node
// 護欄：每個 view 模組（portal/views/<name>.js）都必須「有路可走」——index.html 裡要存在
// router.navigate('/app/<name>')（側欄 menu 或其他明確入口），否則使用者點不到它。
// 由來：§UAS「用量統計」規格明寫要掛進側欄 menu，排程卻回報成功而 menu 根本沒長出來；
// 同一類「功能寫好了但沒入口」的漏接已反覆發生，故改成部署前靜態檢查擋在上線之前。
// 用法：node portal/checks/view-has-menu.js <path-to-index.html>（失敗 exit 1，Deploy 會中止）
const fs = require('fs');
const path = require('path');

// 刻意不進側欄的 view（由程式內部導引進入，不是獨立選單項目）。
// 新增成員前請先確認它真的另有入口，不要拿這份清單來掩蓋漏掛 menu。
const NO_SIDEBAR = new Set([
  'deck',        // 由 ensureDeckView() / wiki 預覽進入
  'wiki',        // 由 loadFile() 進入（幾乎每個面板都會呼叫）
  'wb-beautify', // 白板內的子工具，非獨立頁
]);

const target = process.argv[2] || path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(target, 'utf8');
const viewsDir = path.join(path.dirname(target), 'views');

const routes = new Set();
for (const m of src.matchAll(/\/app\/([a-zA-Z0-9_-]+)/g)) routes.add(m[1]);

const missing = [];
for (const f of fs.readdirSync(viewsDir).filter(n => n.endsWith('.js'))) {
  const name = f.replace(/\.js$/, '');
  if (NO_SIDEBAR.has(name) || routes.has(name)) continue;
  missing.push(name);
}

if (missing.length) {
  console.error('[view-has-menu] 以下 view 沒有任何入口（index.html 找不到 /app/<name>），使用者點不到：');
  missing.forEach(n => console.error('  - portal/views/' + n + '.js  → 請在側欄加 data-nav 入口並 router.navigate(\'/app/' + n + '\')'));
  console.error('  （若它刻意不進側欄，請加進本檔的 NO_SIDEBAR 並註明真正的入口）');
  process.exit(1);
}
console.log('[view-has-menu] OK — ' + fs.readdirSync(viewsDir).filter(n => n.endsWith('.js')).length + ' 個 view 皆有入口');

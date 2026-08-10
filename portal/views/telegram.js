// SPEC-portal-architecture.md §V5 — Telegram 控制台 view 模組（自 index.html 完整搬移，行為不變）。
// 依賴 index.html 仍保留的共用全域 function：window.highlightMenuBtn / window.showPanel / window.escapeHtml。

export const meta = { route: '/app/telegram', title: 'Telegram 控制台', icon: 'send', menuGroup: 'telegram' };

let container = null;
let autoRefreshTimer = null;

function render() {
  container.innerHTML =
    '<section class="flex-1 overflow-y-auto bg-slate-50/50 dark:bg-slate-900/40">'
    + '<div class="max-w-4xl mx-auto p-8 space-y-6">'

    + '<div class="flex flex-wrap items-start gap-4">'
    + '<div class="flex-1 min-w-0 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-5">'
    + '<h2 class="text-sm font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">Bot 狀態</h2>'
    + '<div id="tg-status" class="space-y-1 text-sm text-slate-700 dark:text-slate-300"><p>載入中...</p></div>'
    + '</div>'
    + '<div class="flex-1 min-w-0 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-5">'
    + '<h2 class="text-sm font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">目前脈絡</h2>'
    + '<div id="tg-contexts" class="space-y-1 text-sm text-slate-700 dark:text-slate-300"><p class="text-slate-400">（未設定任何脈絡）</p></div>'
    + '</div>'
    + '<div class="flex gap-2 flex-shrink-0">'
    + '<button id="tg-clear-btn" class="px-3 py-2 rounded-lg bg-rose-50 dark:bg-rose-950/30 text-rose-600 dark:text-rose-400 text-xs font-semibold hover:bg-rose-100 dark:hover:bg-rose-900/40 border border-rose-200 dark:border-rose-800 transition-all">🗑 清空日誌</button>'
    + '<button id="tg-refresh-btn" class="px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-xs font-semibold hover:bg-slate-200 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 transition-all">↻ 重新整理</button>'
    + '</div>'
    + '</div>'

    + '<div class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">'
    + '<div class="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/20">'
    + '<h2 class="text-sm font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">控制台日誌</h2>'
    + '<span id="tg-log-count" class="text-xs text-slate-400">0 則</span>'
    + '</div>'
    + '<div id="tg-log" class="divide-y divide-slate-100 dark:divide-slate-800 max-h-[60vh] overflow-y-auto">'
    + '<p class="px-5 py-8 text-center text-slate-400 text-sm">尚無記錄</p>'
    + '</div>'
    + '</div>'

    + '<div class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-4">'
    + '<div class="flex gap-2">'
    + '<input id="tg-input" type="text" placeholder="在此輸入指令或問題，與手機 Telegram 互通…" '
    + 'class="flex-1 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm text-slate-800 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500">'
    + '<button id="tg-send-btn" class="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-700 active:bg-cyan-800 text-white text-sm font-semibold transition-colors flex-shrink-0">傳送</button>'
    + '</div>'
    + '<p class="text-[10px] text-slate-400 mt-2">Enter 傳送 · 同步至手機 Telegram · 指令如 /here /use /status /schedules /today</p>'
    + '</div>'

    + '</div>'
    + '</section>';

  container.querySelector('#tg-clear-btn').addEventListener('click', tgClearLog);
  container.querySelector('#tg-refresh-btn').addEventListener('click', tgRefresh);
  container.querySelector('#tg-send-btn').addEventListener('click', tgSend);
  container.querySelector('#tg-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); tgSend(); }
  });
}

async function tgRefresh() {
  try {
    const statusResp = await fetch('/api/telegram/status');
    const status = await statusResp.json();
    const statusEl = container.querySelector('#tg-status');
    if (statusEl) {
      const dot = status.configured ? (status.polling ? '🟢 已連線' : '🟡 已設定但未輪詢') : '🔴 未設定';
      statusEl.innerHTML = '<p><strong>狀態：</strong>' + dot + '</p>'
        + '<p><strong>授權 chat 數：</strong>' + status.authorizedCount + '</p>'
        + '<p><strong>Offset：</strong>' + status.offset + '</p>';
    }
  } catch (e) { /* ignore */ }

  try {
    const ctxResp = await fetch('/api/telegram/context');
    const contexts = await ctxResp.json();
    const ctxEl = container.querySelector('#tg-contexts');
    if (ctxEl) {
      const keys = Object.keys(contexts || {});
      if (!keys.length) {
        ctxEl.innerHTML = '<p class="text-slate-400">（未設定任何脈絡）</p>';
      } else {
        ctxEl.innerHTML = keys.map((k) => {
          const c = contexts[k];
          return '<p><strong>chat ' + k + '：</strong>' + (c.label || '') + '</p>';
        }).join('');
      }
    }
  } catch (e) { /* ignore */ }

  try {
    const logResp = await fetch('/api/telegram/console?limit=100');
    const log = await logResp.json();
    const logEl = container.querySelector('#tg-log');
    const countEl = container.querySelector('#tg-log-count');
    if (countEl) countEl.textContent = (log.length || 0) + ' 則';
    if (logEl) {
      if (!log.length) {
        logEl.innerHTML = '<p class="px-5 py-8 text-center text-slate-400 text-sm">尚無記錄</p>';
      } else {
        logEl.innerHTML = log.map((entry, idx) => {
          const role = entry.role || 'unknown';
          const roleColor = role === 'user' ? 'text-cyan-600 dark:text-cyan-400'
            : role === 'bot' ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-slate-400 dark:text-slate-500';
          const roleLabel = role === 'user' ? '👤 指揮官' : role === 'bot' ? '🤖 Hana' : '⚙️ 系統';
          const ts = (entry.ts || '').slice(0, 19).replace('T', ' ');
          const txt = (entry.text || '').slice(0, 400).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const imgHtml = entry.imageFilename
            ? '<img src="/api/telegram/images/' + encodeURIComponent(entry.imageFilename) + '" alt="圖片" class="mt-1 max-h-24 max-w-[12rem] rounded border border-slate-200 dark:border-slate-700 object-cover" />'
            : '';
          return '<div class="flex items-start gap-3 px-5 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/30 group" data-idx="' + idx + '">'
            + '<span class="text-xs font-semibold ' + roleColor + ' flex-shrink-0 w-20 pt-0.5">' + roleLabel + '</span>'
            + '<div class="flex-1 min-w-0"><p class="text-xs text-slate-700 dark:text-slate-300 whitespace-pre-wrap break-words">' + txt + '</p>'
            + imgHtml
            + '<p class="text-[10px] text-slate-400 mt-0.5">' + ts + '</p></div>'
            + '<button data-act="delete-entry" data-idx="' + idx + '" class="opacity-0 group-hover:opacity-100 transition-opacity text-slate-300 hover:text-rose-500 dark:hover:text-rose-400 text-xs px-1 flex-shrink-0" title="刪除">✕</button>'
            + '</div>';
        }).join('');
        logEl.querySelectorAll('[data-act="delete-entry"]').forEach((btn) => {
          btn.addEventListener('click', () => tgDeleteEntry(btn.getAttribute('data-idx')));
        });
        logEl.scrollTop = logEl.scrollHeight;
      }
    }
  } catch (e) { /* ignore */ }
}

async function tgClearLog() {
  if (!confirm('確定要清空 Telegram 控制台日誌？')) return;
  try {
    await fetch('/api/telegram/console', { method: 'DELETE' });
    tgRefresh();
  } catch (e) { alert('清空失敗：' + e.message); }
}

async function tgDeleteEntry(idx) {
  try {
    await fetch('/api/telegram/console/' + idx, { method: 'DELETE' });
    tgRefresh();
  } catch (e) { /* ignore */ }
}

async function tgSend() {
  const inputEl = container.querySelector('#tg-input');
  const btnEl = container.querySelector('#tg-send-btn');
  const text = (inputEl ? inputEl.value : '').trim();
  if (!text) return;
  if (inputEl) inputEl.value = '';
  if (btnEl) { btnEl.disabled = true; btnEl.textContent = '…'; }
  try {
    await fetch('/api/telegram/console/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text }),
    });
    tgRefresh();
    setTimeout(tgRefresh, 2500);
    setTimeout(tgRefresh, 6000);
  } catch (e) { alert('傳送失敗：' + e.message); }
  finally { if (btnEl) { btnEl.disabled = false; btnEl.textContent = '傳送'; } }
}

export function mount(root, ctx) {
  container = root;
  if (typeof window.showPanel === 'function') window.showPanel('__view_root__');
  root.classList.remove('hidden');
  if (typeof window.highlightMenuBtn === 'function') window.highlightMenuBtn('menu-telegram');
  const pathEl = document.getElementById('header-file-path'); if (pathEl) pathEl.innerText = 'Telegram 指揮控制台';
  const titleEl = document.getElementById('header-file-title'); if (titleEl) titleEl.innerText = '全域指令 / 回報 / 日誌鏡像檢視';
  const vscodeEl = document.getElementById('btn-vscode'); if (vscodeEl) vscodeEl.href = '#';
  const savedEl = document.getElementById('last-saved'); if (savedEl) savedEl.classList.add('hidden');
  const backEl = document.getElementById('btn-back'); if (backEl) backEl.classList.add('hidden');

  render();
  tgRefresh();

  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(() => {
    if (container) tgRefresh();
    else { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
  }, 5000);

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

export function unmount() {
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
  if (container) { container.classList.add('hidden'); container.innerHTML = ''; }
  container = null;
}

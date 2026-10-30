// SPEC-portal-architecture.md §V1/V8 — 便條貼 view 模組（自 index.html 完整搬移，行為不變）。
// 便條貼是最自足的面板：狀態/HTML 完全侷限在這支檔案，只依賴 index.html 仍保留的共用全域
// function 宣告（傳統 <script> 的 function 宣告會掛在 window 上，ESM 動態 import() 可直接呼叫）：
// window.escapeHtml / window.highlightMenuBtn / window.showPanel。

export const meta = { route: '/app/notes', title: '便條貼', icon: 'sticky-note', menuGroup: 'notes' };

const NOTE_COLORS_UI = ['yellow', 'pink', 'blue', 'green', 'purple', 'orange', 'gray'];
const NOTE_COLOR_HEX = { yellow: '#fde68a', pink: '#f9a8d4', blue: '#93c5fd', green: '#6ee7b7', purple: '#c4b5fd', orange: '#fdba74', gray: '#d1d5db' };
const notesState = { list: [], scope: 'workspace', tab: 'board', color: 'yellow', dragId: null, dragOffset: null };

let container = null;
let closePopoverListener = null;

function escapeHtml(str) { return window.escapeHtml(str); }

function render() {
  container.innerHTML =
    '<section class="flex-1 overflow-hidden flex flex-col h-full bg-slate-50/50 dark:bg-slate-900/40">'
    + '<div class="flex items-center justify-between px-6 py-3 border-b border-slate-200 dark:border-slate-700/60 bg-white/70 dark:bg-slate-900/50 flex-wrap gap-2">'
    + '<div class="flex items-center gap-2">'
    + '<button id="notes-create" class="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-xs font-semibold transition-all shadow">+ 新便條</button>'
    + '<div id="notes-color-picker" class="flex items-center gap-1"></div>'
    + '</div>'
    + '<div class="flex items-center gap-2">'
    + '<div class="flex items-center rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5 text-xs font-medium">'
    + '<button id="notes-scope-ws" data-scope="workspace" class="px-2.5 py-1 rounded-md transition-all">當前工作區</button>'
    + '<button id="notes-scope-all" data-scope="all" class="px-2.5 py-1 rounded-md transition-all">全部</button>'
    + '</div>'
    + '<div class="flex items-center rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5 text-xs font-medium">'
    + '<button id="notes-tab-board" data-tab="board" class="px-2.5 py-1 rounded-md transition-all">看板</button>'
    + '<button id="notes-tab-done" data-tab="done" class="px-2.5 py-1 rounded-md transition-all">已完成</button>'
    + '</div>'
    + '</div>'
    + '</div>'
    + '<div id="notes-board-wrap" class="flex-1 overflow-auto relative">'
    + '<div id="notes-board" class="relative w-full" style="min-height: 600px;"></div>'
    + '</div>'
    + '<div id="notes-done-wrap" class="flex-1 overflow-y-auto hidden">'
    + '<div id="notes-done-list" class="max-w-2xl mx-auto p-6 space-y-2"></div>'
    + '</div>'
    + '</section>';

  container.querySelector('#notes-create').addEventListener('click', notesCreate);
  container.querySelector('#notes-scope-ws').addEventListener('click', () => notesSetScope('workspace'));
  container.querySelector('#notes-scope-all').addEventListener('click', () => notesSetScope('all'));
  container.querySelector('#notes-tab-board').addEventListener('click', () => notesSetTab('board'));
  container.querySelector('#notes-tab-done').addEventListener('click', () => notesSetTab('done'));
}

function notesRenderColorPicker() {
  const box = container.querySelector('#notes-color-picker');
  if (!box) return;
  box.innerHTML = NOTE_COLORS_UI.map(c =>
    '<div class="note-color-dot' + (c === notesState.color ? ' selected' : '') + '" data-c="' + c + '" style="background:' + NOTE_COLOR_HEX[c] + '" title="' + c + '"></div>'
  ).join('');
  box.querySelectorAll('.note-color-dot').forEach(dot => {
    dot.addEventListener('click', () => { notesState.color = dot.getAttribute('data-c'); notesRenderColorPicker(); });
  });
}

function notesUpdateToggleUI() {
  const ACTIVE = ['bg-white', 'dark:bg-slate-700', 'shadow-sm', 'text-slate-900', 'dark:text-white'];
  const INACTIVE = ['text-slate-500', 'dark:text-slate-400'];
  function apply(id, active) {
    const el = container.querySelector('#' + id); if (!el) return;
    ACTIVE.forEach(c => el.classList.toggle(c, active));
    INACTIVE.forEach(c => el.classList.toggle(c, !active));
  }
  apply('notes-scope-ws', notesState.scope === 'workspace');
  apply('notes-scope-all', notesState.scope === 'all');
  apply('notes-tab-board', notesState.tab === 'board');
  apply('notes-tab-done', notesState.tab === 'done');
  container.querySelector('#notes-board-wrap').classList.toggle('hidden', notesState.tab !== 'board');
  container.querySelector('#notes-done-wrap').classList.toggle('hidden', notesState.tab !== 'done');
}

function notesSetScope(scope) { notesState.scope = scope; notesUpdateToggleUI(); notesLoad(); }
function notesSetTab(tab) { notesState.tab = tab; notesUpdateToggleUI(); notesLoad(); }

async function notesLoad() {
  try {
    const status = notesState.tab === 'done' ? 'done' : 'active';
    const r = await fetch('/api/notes?status=' + status + '&scope=' + notesState.scope);
    const data = await r.json();
    notesState.list = Array.isArray(data) ? data : [];
  } catch (e) { notesState.list = []; }
  if (notesState.tab === 'done') notesRenderDone(); else notesRenderBoard();
}

function notesIsOverdue(n) { return !!n.dueAt && new Date(n.dueAt) <= new Date(); }

function notesRenderBoard() {
  const board = container.querySelector('#notes-board');
  if (!notesState.list.length) {
    board.innerHTML = '<div class="absolute inset-0 flex items-center justify-center text-sm text-slate-400">還沒有便條，點左上角「+ 新便條」貼第一張吧</div>';
    return;
  }
  const rect = board.getBoundingClientRect();
  const boardW = Math.max(rect.width, 800);
  const boardH = Math.max(rect.height, 600);
  board.innerHTML = notesState.list.map(n => {
    const left = (n.x || 0) * boardW;
    const top = (n.y || 0) * boardH;
    const w = n.w || 200;
    const overdue = notesIsOverdue(n);
    const due = n.dueAt
      ? '<div class="text-[10px] mt-1.5 opacity-70' + (overdue ? ' text-red-600 dark:text-red-300 font-semibold' : '') + '">⏰ ' + escapeHtml(n.dueAt.replace('T', ' ')) + '</div>'
      : '';
    const created = n.createdAt
      ? '<div class="text-[10px] mt-1.5 opacity-50">🕓 ' + escapeHtml(n.createdAt.replace('T', ' ').slice(0, 16)) + '</div>'
      : '';
    return '<div class="note-card' + (overdue ? ' note-overdue' : '') + ' absolute rounded-lg shadow-md p-3 cursor-grab select-none" data-note-id="' + n.id + '" data-color="' + (n.color || 'yellow') + '" style="left:' + left + 'px; top:' + top + 'px; width:' + w + 'px; z-index:' + (n.z || 1) + ';">'
      + '<div class="flex items-center justify-end gap-2 mb-1">'
      + '<button data-act="due" onpointerdown="event.stopPropagation()" title="到期時間" class="text-xs opacity-60 hover:opacity-100">📅</button>'
      + '<button data-act="color" onpointerdown="event.stopPropagation()" title="改顏色" class="text-xs opacity-60 hover:opacity-100">🎨</button>'
      + '<button data-act="complete" onpointerdown="event.stopPropagation()" title="完成" class="text-xs opacity-60 hover:opacity-100">✓</button>'
      + '<button data-act="delete" onpointerdown="event.stopPropagation()" title="刪除" class="text-xs opacity-60 hover:opacity-100">🗑</button>'
      + '</div>'
      + '<div class="text-sm whitespace-pre-wrap break-words outline-none" contenteditable="true" onpointerdown="event.stopPropagation()" data-act="text">' + escapeHtml(n.text || '') + '</div>'
      + due
      + created
      + '</div>';
  }).join('');
  bindBoardActions(board);
  notesBindDrag(board);
}

function bindBoardActions(board) {
  board.querySelectorAll('.note-card').forEach(card => {
    const id = card.getAttribute('data-note-id');
    card.querySelector('[data-act="due"]').addEventListener('click', (e) => notesSetDue(e, id, notesState.list.find(n => n.id === id)?.dueAt || ''));
    card.querySelector('[data-act="color"]').addEventListener('click', (e) => notesOpenColorMenu(e, id));
    card.querySelector('[data-act="complete"]').addEventListener('click', async (e) => { e.stopPropagation(); await notesUpdate(id, { status: 'done' }); });
    card.querySelector('[data-act="delete"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('永久刪除這張便條？此動作無法復原。')) return;
      try { await fetch('/api/notes/' + encodeURIComponent(id), { method: 'DELETE' }); } catch (e2) {}
      await notesLoad();
    });
    card.querySelector('[data-act="text"]').addEventListener('blur', (e) => notesUpdate(id, { text: e.target.innerText }));
  });
}

function notesBindDrag(board) {
  board.querySelectorAll('.note-card').forEach(card => {
    card.addEventListener('pointerdown', (e) => {
      const id = card.getAttribute('data-note-id');
      const boardRect = board.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      notesState.dragId = id;
      notesState.dragOffset = { dx: e.clientX - cardRect.left, dy: e.clientY - cardRect.top, boardLeft: boardRect.left, boardTop: boardRect.top };
      card.style.zIndex = 9999;
      try { card.setPointerCapture(e.pointerId); } catch (err) {}
    });
    card.addEventListener('pointermove', (e) => {
      if (notesState.dragId !== card.getAttribute('data-note-id')) return;
      const off = notesState.dragOffset;
      let left = e.clientX - off.boardLeft - off.dx;
      let top = e.clientY - off.boardTop - off.dy;
      left = Math.max(0, left); top = Math.max(0, top);
      card.style.left = left + 'px';
      card.style.top = top + 'px';
    });
    card.addEventListener('pointerup', async (e) => {
      if (notesState.dragId !== card.getAttribute('data-note-id')) return;
      const id = notesState.dragId;
      notesState.dragId = null;
      const boardRect = board.getBoundingClientRect();
      const boardW = Math.max(boardRect.width, 800);
      const boardH = Math.max(boardRect.height, 600);
      const left = parseFloat(card.style.left) || 0;
      const top = parseFloat(card.style.top) || 0;
      const x = left / boardW, y = top / boardH;
      const maxZ = notesState.list.reduce((m, n) => Math.max(m, n.z || 1), 1) + 1;
      await notesUpdate(id, { x, y, z: maxZ });
    });
  });
}

function notesRenderDone() {
  const box = container.querySelector('#notes-done-list');
  if (!notesState.list.length) { box.innerHTML = '<p class="text-sm text-slate-400 text-center mt-8">還沒有已完成的便條</p>'; return; }
  const sorted = notesState.list.slice().sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0));
  box.innerHTML = sorted.map(n =>
    '<div class="note-card rounded-lg p-3 flex items-start justify-between gap-3" data-note-id="' + n.id + '" data-color="' + (n.color || 'yellow') + '">'
    + '<div class="flex-1 min-w-0"><div class="text-sm whitespace-pre-wrap break-words">' + escapeHtml(n.text || '') + '</div>'
    + '<div class="text-[10px] opacity-60 mt-1">完成於 ' + escapeHtml((n.completedAt || '').replace('T', ' ').slice(0, 16)) + '</div></div>'
    + '<div class="flex items-center gap-2 shrink-0">'
    + '<button data-act="restore" class="text-xs px-2 py-1 rounded bg-white/60 dark:bg-black/20 hover:bg-white dark:hover:bg-black/40">↩ 還原</button>'
    + '<button data-act="purge" class="text-xs px-2 py-1 rounded bg-white/60 dark:bg-black/20 hover:bg-red-100 dark:hover:bg-red-900/40 text-red-600 dark:text-red-300">🗑 永久刪除</button>'
    + '</div></div>'
  ).join('');
  box.querySelectorAll('.note-card').forEach(card => {
    const id = card.getAttribute('data-note-id');
    card.querySelector('[data-act="restore"]').addEventListener('click', () => notesUpdate(id, { status: 'active' }));
    card.querySelector('[data-act="purge"]').addEventListener('click', async () => {
      if (!confirm('永久刪除這張已完成的便條？此動作無法復原。')) return;
      try { await fetch('/api/notes/' + encodeURIComponent(id), { method: 'DELETE' }); } catch (e) {}
      await notesLoad();
    });
  });
}

async function notesUpdate(id, patch) {
  try {
    await fetch('/api/notes/' + encodeURIComponent(id), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
  } catch (e) {}
  await notesLoad();
}
async function notesCreate() {
  try {
    await fetch('/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '新便條', color: notesState.color }) });
  } catch (e) {}
  await notesLoad();
}

// Popovers are appended as CHILDREN of the note-card (not document.body) so they inherit its
// absolute-position coordinate space and move together when the card is dragged; the card's own
// z-index is bumped while a popover is open so it isn't covered by other notes.
function notesClosePopovers() {
  container.querySelectorAll('.notes-color-menu, .notes-due-popover').forEach(m => m.remove());
}
function notesOpenPopover(e, id, className, buildInner) {
  e.stopPropagation();
  notesClosePopovers();
  const card = e.currentTarget.closest('.note-card');
  if (!card) return;
  const prevZ = card.style.zIndex;
  card.style.zIndex = 99999;
  const menu = document.createElement('div');
  menu.className = className;
  // Popover is a child of the (draggable) card, so any pointerdown inside it that isn't
  // stopped bubbles up to the card's drag handler — that starts a drag AND races the
  // popover's own notesUpdate call with a second notesUpdate({x,y,z}) on pointerup; whichever
  // PUT lands second wins and silently clobbers the popover's edit (e.g. a just-set dueAt).
  menu.addEventListener('pointerdown', ev => ev.stopPropagation());
  buildInner(menu, () => { menu.remove(); card.style.zIndex = prevZ; });
  card.appendChild(menu);
  setTimeout(() => {
    document.addEventListener('click', function closeOnce(ev) {
      if (!menu.isConnected || menu.contains(ev.target)) return;
      menu.remove();
      card.style.zIndex = prevZ;
      document.removeEventListener('click', closeOnce);
    });
  }, 0);
}
function notesSetDue(e, id, current) {
  notesOpenPopover(e, id, 'notes-due-popover flex flex-col gap-2 p-3 text-xs w-56', (menu, close) => {
    // Buttons come BEFORE the input: the native datetime-local picker drops down below the
    // input, so putting the buttons above it keeps them from ever being covered by the picker.
    menu.innerHTML =
      '<div class="flex justify-between gap-2">'
      + '<button class="px-2 py-1 rounded bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600">清除</button>'
      + '<button class="px-2 py-1 rounded bg-cyan-600 text-white hover:bg-cyan-700">確定</button>'
      + '</div>'
      + '<input type="datetime-local" class="notes-due-input px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 text-xs" value="' + escapeHtml(current || '') + '">';
    const input = menu.querySelector('input');
    // Also save on change as a safety net (e.g. user picks a full date+time and clicks
    // straight out without hitting 確定).
    input.addEventListener('change', () => { notesUpdate(id, { dueAt: input.value || null }); });
    const [clearBtn, okBtn] = menu.querySelectorAll('button');
    clearBtn.onclick = () => { notesUpdate(id, { dueAt: null }); close(); };
    okBtn.onclick = () => { notesUpdate(id, { dueAt: input.value || null }); close(); };
  });
}
function notesOpenColorMenu(e, id) {
  notesOpenPopover(e, id, 'notes-color-menu flex gap-1 p-1.5', (menu, close) => {
    menu.innerHTML = NOTE_COLORS_UI.map(c =>
      '<div class="note-color-dot" data-c="' + c + '" style="background:' + NOTE_COLOR_HEX[c] + '"></div>'
    ).join('');
    menu.querySelectorAll('.note-color-dot').forEach(dot => {
      dot.onclick = () => { notesUpdate(id, { color: dot.getAttribute('data-c') }); close(); };
    });
  });
}

export function mount(root, ctx) {
  container = root;
  if (typeof window.showPanel === 'function') window.showPanel('__view_root__'); // hides all legacy panels + PM overlay teardown
  root.classList.remove('hidden');
  if (typeof window.highlightMenuBtn === 'function') window.highlightMenuBtn('menu-notes');
  const pathEl = document.getElementById('header-file-path'); if (pathEl) pathEl.innerText = '便條貼';
  const titleEl = document.getElementById('header-file-title'); if (titleEl) titleEl.innerText = '指揮官自己的待辦白板，想到什麼就貼一張';
  const vscodeEl = document.getElementById('btn-vscode'); if (vscodeEl) vscodeEl.href = '#';
  const savedEl = document.getElementById('last-saved'); if (savedEl) savedEl.classList.add('hidden');
  const backEl = document.getElementById('btn-back'); if (backEl) backEl.classList.add('hidden');

  render();
  notesRenderColorPicker();
  notesUpdateToggleUI();
  notesLoad();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

export function unmount() {
  notesClosePopovers();
  if (container) { container.classList.add('hidden'); container.innerHTML = ''; }
  container = null;
}

// SPEC-view-chat-context.md §3.1/§3.3 — 頭像在便條貼面板開的對話。內容本身早已由
// server.js 的 injectNotesContext() 無條件注入每一次聊天（見 SN2-03），這裡只負責讓浮動視窗
// 標題正確顯示「討論：便條貼」，不必也不應該再重複注入一次便條內容。
export function getChatContext() {
  const scopeLabel = notesState.scope === 'all' ? '全部工作區' : '本工作區';
  const tabLabel = notesState.tab === 'done' ? '已完成' : '看板';
  return { kind: 'notes', key: 'notes:' + notesState.scope + ':' + notesState.tab, label: '便條貼（' + scopeLabel + '・' + tabLabel + '）', payload: {} };
}

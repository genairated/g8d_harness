// SPEC-portal-architecture.md §V9 — 音訊主題管理 view 模組（自 index.html 完整搬移，行為不變）。
// 依賴 index.html 仍保留的共用全域 function 宣告（傳統 <script> 的 function 宣告掛在 window 上，
// ESM 動態 import() 可直接呼叫）：window.escapeHtml / window.showToast / window.loadAudioTopics
// （後者是聊天/會議面板拿來刷新音訊主題下拉選單用的既有函式，不屬本 view，故不搬）。

export const meta = { route: '/app/audio-topics', title: '音訊主題', icon: 'waves', menuGroup: 'audio-topics' };

const atState = { list: [], defaultTopicId: null, currentId: null, compileTimer: null };
let container = null;

function escapeHtml(str) { return window.escapeHtml(str); }
function showToast(msg, type) { if (typeof window.showToast === 'function') window.showToast(msg, type); }

function render() {
  container.innerHTML =
    '<section class="flex-1 overflow-hidden flex h-full bg-slate-50/50 dark:bg-slate-900/40">'
    + '<div class="w-72 flex-shrink-0 border-r border-slate-200 dark:border-slate-800 flex flex-col bg-white/40 dark:bg-slate-900/30 overflow-y-auto">'
    + '<div class="p-3 border-b border-slate-200 dark:border-slate-800 flex-shrink-0">'
    + '<button id="at-new" class="w-full px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-xs font-semibold transition-colors flex items-center justify-center gap-1.5"><i data-lucide="plus" class="h-3.5 w-3.5"></i>新增音訊主題</button>'
    + '</div>'
    + '<div class="p-3 space-y-4">'
    + '<div><div class="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">🌐 全域（所有工作區可選）</div><div id="at-list-global" class="space-y-1 text-sm text-slate-500">載入中…</div></div>'
    + '<div><div class="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">📁 本工作區</div><div id="at-list-workspace" class="space-y-1 text-sm text-slate-500"></div></div>'
    + '</div>'
    + '</div>'
    + '<div class="flex-1 overflow-y-auto p-6">'
    + '<div id="at-empty" class="flex flex-col items-center justify-center h-full text-slate-400 text-sm select-none">'
    + '<i data-lucide="waves" class="h-12 w-12 mb-3 opacity-20"></i><p class="text-center text-slate-400">選擇左側主題編輯<br>或新增一個</p>'
    + '</div>'
    + '<div id="at-editor" class="hidden max-w-2xl space-y-3">'
    + '<input id="at-id" type="hidden">'
    + '<label class="text-xs text-slate-500 dark:text-slate-400 flex flex-col gap-1">名稱<input id="at-name" type="text" placeholder="例：需求訪談 · 文件管理客戶" class="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-800 dark:text-slate-100"></label>'
    + '<div class="grid grid-cols-3 gap-2">'
    + '<label class="text-xs text-slate-500 dark:text-slate-400 flex flex-col gap-1">範圍<select id="at-scope" class="px-2 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs text-slate-800 dark:text-slate-100"><option value="workspace">📁 本工作區</option><option value="global">🌐 全域</option></select></label>'
    + '<label class="text-xs text-slate-500 dark:text-slate-400 flex flex-col gap-1">語言<select id="at-lang" class="px-2 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs text-slate-800 dark:text-slate-100"><option value="zh">中文</option><option value="en">English</option><option value="auto">auto</option></select></label>'
    + '<label class="text-xs text-slate-500 dark:text-slate-400 flex flex-col gap-1">類型<input id="at-meeting-type" type="text" placeholder="需求訪談／周會…" class="px-2 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs text-slate-800 dark:text-slate-100"></label>'
    + '</div>'
    + '<label class="text-xs text-slate-500 dark:text-slate-400 flex flex-col gap-1">主題句（一句話這場在談什麼）<input id="at-topic-line" type="text" placeholder="客戶討論文件管理與流程圖轉換需求" class="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-800 dark:text-slate-100"></label>'
    + '<label class="text-xs text-slate-500 dark:text-slate-400 flex flex-col gap-1">常見人名（逗號分隔）<input id="at-people" type="text" placeholder="Charles, 王經理" class="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-800 dark:text-slate-100"></label>'
    + '<label class="text-xs text-slate-500 dark:text-slate-400 flex flex-col gap-1">常見專有名詞（逗號分隔，保持拼法）<input id="at-terms" type="text" placeholder="Harness, Portal, BPMN" class="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-800 dark:text-slate-100"></label>'
    + '<label class="text-xs text-slate-500 dark:text-slate-400 flex flex-col gap-1">備註（會納入編譯，仍受 token 預算）<input id="at-notes" type="text" class="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-800 dark:text-slate-100"></label>'
    + '<div class="rounded-xl border border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/40 p-3">'
    + '<div class="flex items-center justify-between mb-1"><span class="text-[11px] font-semibold text-slate-500 dark:text-slate-400">即時預覽（編譯後 initial_prompt）</span><span id="at-token-label" class="text-[11px] text-slate-400"></span></div>'
    + '<pre id="at-prompt-preview" class="whitespace-pre-wrap text-xs text-slate-700 dark:text-slate-200 bg-slate-50 dark:bg-slate-950/40 rounded-lg p-2 min-h-[3em]"></pre>'
    + '<div class="mt-1.5 h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden"><div id="at-token-bar" class="h-full bg-cyan-500 transition-all" style="width:0%"></div></div>'
    + '</div>'
    + '<div class="flex items-center gap-2 pt-1">'
    + '<button id="at-save" class="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-sm font-semibold transition-colors">儲存</button>'
    + '<button id="at-set-default" class="px-4 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-sm font-semibold transition-colors">設為本工作區預設</button>'
    + '<button id="at-delete" class="px-4 py-2 rounded-lg bg-rose-50 dark:bg-rose-950/30 hover:bg-rose-100 dark:hover:bg-rose-900/40 text-rose-600 dark:text-rose-400 text-sm font-semibold transition-colors ml-auto">刪除</button>'
    + '</div>'
    + '</div>'
    + '</div>'
    + '</section>';

  container.querySelector('#at-new').addEventListener('click', atNewTopic);
  container.querySelector('#at-scope').addEventListener('change', atCompilePreview);
  container.querySelector('#at-lang').addEventListener('change', atCompilePreview);
  ['at-meeting-type', 'at-topic-line', 'at-people', 'at-terms', 'at-notes'].forEach(id => {
    container.querySelector('#' + id).addEventListener('input', atCompilePreview);
  });
  container.querySelector('#at-save').addEventListener('click', atSave);
  container.querySelector('#at-set-default').addEventListener('click', atSetAsDefault);
  container.querySelector('#at-delete').addEventListener('click', atDelete);
}

function field(id) { return container.querySelector('#' + id); }

async function atLoad() {
  try {
    const r = await fetch('/api/audio-topics');
    const d = await r.json();
    atState.list = d.topics || [];
    atState.defaultTopicId = d.defaultTopicId || null;
  } catch (e) { atState.list = []; atState.defaultTopicId = null; }
  atRenderList();
}

function atRenderList() {
  const row = (t) => '<div data-id="' + t.id + '" class="at-row px-2.5 py-1.5 rounded-lg cursor-pointer text-xs flex items-center justify-between ' +
    (t.id === atState.currentId ? 'bg-cyan-100 dark:bg-cyan-900/40 text-cyan-700 dark:text-cyan-300' : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300') + '">' +
    '<span class="truncate">' + escapeHtml(t.name) + (t.id === atState.defaultTopicId ? ' ⭐' : '') + '</span></div>';
  const g = atState.list.filter(t => t.scope === 'global');
  const w = atState.list.filter(t => t.scope === 'workspace');
  field('at-list-global').innerHTML = g.length ? g.map(row).join('') : '<div class="text-xs text-slate-400 px-2.5">（無）</div>';
  field('at-list-workspace').innerHTML = w.length ? w.map(row).join('') : '<div class="text-xs text-slate-400 px-2.5">（無）</div>';
  container.querySelectorAll('.at-row').forEach(el => el.addEventListener('click', () => atSelectTopic(el.getAttribute('data-id'))));
}

function atNewTopic() {
  atState.currentId = null;
  field('at-empty').classList.add('hidden');
  field('at-editor').classList.remove('hidden');
  field('at-id').value = '';
  field('at-name').value = '';
  field('at-scope').value = 'workspace';
  field('at-lang').value = 'zh';
  field('at-meeting-type').value = '';
  field('at-topic-line').value = '';
  field('at-people').value = '';
  field('at-terms').value = '';
  field('at-notes').value = '';
  atRenderList();
  atCompilePreview();
}

function atSelectTopic(id) {
  const t = atState.list.find(x => x.id === id);
  if (!t) return;
  atState.currentId = id;
  field('at-empty').classList.add('hidden');
  field('at-editor').classList.remove('hidden');
  field('at-id').value = t.id;
  field('at-name').value = t.name || '';
  field('at-scope').value = t.scope || 'workspace';
  field('at-lang').value = t.lang || 'zh';
  field('at-meeting-type').value = t.meetingType || '';
  field('at-topic-line').value = t.topicLine || '';
  field('at-people').value = (t.people || []).join(', ');
  field('at-terms').value = (t.terms || []).join(', ');
  field('at-notes').value = t.notes || '';
  atRenderList();
  atCompilePreview();
}

function atCollectFields() {
  return {
    lang: field('at-lang').value,
    meetingType: field('at-meeting-type').value.trim(),
    topicLine: field('at-topic-line').value.trim(),
    people: field('at-people').value.split(',').map(s => s.trim()).filter(Boolean),
    terms: field('at-terms').value.split(',').map(s => s.trim()).filter(Boolean),
    notes: field('at-notes').value.trim(),
  };
}

// Debounced live preview: compiled prompt + token usage bar (turns red once truncated/over budget).
function atCompilePreview() {
  clearTimeout(atState.compileTimer);
  atState.compileTimer = setTimeout(async () => {
    try {
      const r = await fetch('/api/audio-topics/compile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(atCollectFields()) });
      const d = await r.json();
      field('at-prompt-preview').innerText = d.prompt || '';
      const pct = Math.min(100, Math.round((d.tokenCount || 0) / 224 * 100));
      const bar = field('at-token-bar');
      bar.style.width = pct + '%';
      bar.className = 'h-full transition-all ' + (d.truncated || pct >= 100 ? 'bg-rose-500' : (pct >= 80 ? 'bg-amber-500' : 'bg-cyan-500'));
      field('at-token-label').innerText = Math.round(d.tokenCount || 0) + ' / 224 token' + (d.truncated ? '（已截斷）' : '');
    } catch (e) {}
  }, 250);
}

async function atSave() {
  const body = Object.assign({ name: field('at-name').value.trim(), scope: field('at-scope').value }, atCollectFields());
  if (!body.name) { showToast('請輸入名稱', 'error'); return; }
  try {
    const id = field('at-id').value;
    const r = await fetch(id ? ('/api/audio-topics/' + id) : '/api/audio-topics', {
      method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '儲存失敗');
    showToast(d.truncated ? '已儲存（主題過長已截斷）' : '已儲存', d.truncated ? 'info' : 'success');
    await atLoad();
    atSelectTopic(d.topic.id);
    if (typeof window.loadAudioTopics === 'function') window.loadAudioTopics();
  } catch (e) { showToast('儲存失敗: ' + e.message, 'error'); }
}

async function atSetAsDefault() {
  const id = field('at-id').value;
  if (!id) { showToast('請先儲存主題', 'error'); return; }
  try {
    const r = await fetch('/api/audio-topics/default', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topicId: id }) });
    if (!r.ok) throw new Error((await r.json()).error || '設定失敗');
    await atLoad();
    showToast('已設為本工作區預設', 'success');
  } catch (e) { showToast('設定失敗: ' + e.message, 'error'); }
}

async function atDelete() {
  const id = field('at-id').value;
  if (!id) return;
  if (!confirm('刪除這個音訊主題？')) return;
  try {
    const r = await fetch('/api/audio-topics/' + id, { method: 'DELETE' });
    if (!r.ok) throw new Error('刪除失敗');
    atState.currentId = null;
    field('at-editor').classList.add('hidden');
    field('at-empty').classList.remove('hidden');
    await atLoad();
    if (typeof window.loadAudioTopics === 'function') window.loadAudioTopics();
    showToast('已刪除', 'success');
  } catch (e) { showToast('刪除失敗: ' + e.message, 'error'); }
}

export function mount(root, ctx) {
  container = root;
  if (typeof window.showPanel === 'function') window.showPanel('__view_root__');
  root.classList.remove('hidden');
  if (typeof window.highlightMenuBtn === 'function') window.highlightMenuBtn('menu-audio-topics');
  const pathEl = document.getElementById('header-file-path'); if (pathEl) pathEl.innerText = '音訊主題';
  const titleEl = document.getElementById('header-file-title'); if (titleEl) titleEl.innerText = 'Whisper 提示語：命名、可重用、跨入口共用';
  const vscodeEl = document.getElementById('btn-vscode'); if (vscodeEl) vscodeEl.href = '#';
  const savedEl = document.getElementById('last-saved'); if (savedEl) savedEl.classList.add('hidden');
  const backEl = document.getElementById('btn-back'); if (backEl) backEl.classList.add('hidden');

  render();
  atLoad();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

export function unmount() {
  clearTimeout(atState.compileTimer);
  if (container) { container.classList.add('hidden'); container.innerHTML = ''; }
  container = null;
}

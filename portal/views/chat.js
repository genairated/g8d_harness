// SPEC-portal-architecture.md §V1 — AI 對話（Claude/Gemini/Codex）view 模組（自 index.html 完整搬移，
// 行為不變）。這是全站最複雜的面板：多 CLI 分頁、模型/推理強度、附件、slash 指令、語音/loopback、
// 背景 job reattach…背後龐大的業務邏輯（chatTabs 狀態機、sendChatMessage、pollJob、reattachRunningJobs、
// 語音/TTS、附件上傳等）維持留在 index.html 的傳統 <script>（因為它們與浮動聊天小工具 hana-float-widget、
// 頭像/TTS 系統深度共用同一批全域函式與模組級變數，搬過來風險高、效益低）。本檔案只負責：
// 1) 把 chat-panel 的 DOM 動態建置進傳入的 container（#view-root），element id 與舊版完全一致，
//    讓 index.html 裡那些用 document.getElementById(...) 操作的舊函式可以原封不動繼續運作。
// 2) 用 addEventListener 取代原本寫死在 HTML 的 inline onclick/onchange/oninput（ESM 模組沒有全域作用
//    域，不能讓 inline handler 反查 chat.js 內部函式；但呼叫 index.html 仍留著的全域函式一律用 window.xxx）。
// 3) mount() 時重跑「原本只在 index.html init() 執行一次」但依賴 chat-panel DOM 的初始化
//    （loadChatModels/initSttModel/loadAudioTopics），因為那些元素現在只有 mount 之後才存在。
//
// 依賴 window 上的全域（傳統 <script> 的 function 宣告 / DOMContentLoaded init() 建立的模組級變數）：
// showPanel / highlightMenuBtn / escapeHtml / router
// startNewChat / clearCurrentChat / loadChatHistoryList / chatSendOrStop / handleChatInputKey /
// onChatInput / onChatModelChange / onChatEffortChange / toggleLimitPanel / voiceToggle /
// loopbackToggle / loopbackClear / loopbackHidePanel / sendChatMessage / onAudioTopicSelect /
// setSttModel / loadChatModels / loadAudioTopics / initSttModel / renderTabBar / renderActiveTab /
// activeTab / chatTabs / createTab / setSendButtonState / setAvatarState / selectRandomThinkingState /
// onChatMessagesContainerClick

export const meta = { route: '/app/chat', title: 'AI 對話', icon: 'message-square', menuGroup: 'chat' };

let container = null;

function render() {
  container.innerHTML =
    // id="chat-view-root" lets index.html's CSS safety-net (§ "Layout safety-net" — hard-pins
    // the two-column flex layout in case the Tailwind CDN JIT hasn't generated .w-80/.flex-1 yet
    // on a fresh load) target THIS view specifically, without collateral effects on notes.js's or
    // audio-topics.js's own .flex-1 elements if scoped generically to #view-root.
    // h-full (like codegraph/notes/docgraph/audio-topics' root sections) binds this section to
    // #view-root's height so the two inner columns get a bounded box and scroll INDEPENDENTLY
    // (history list vs messages). Without it the section sized to content and #view-root scrolled
    // the whole thing as one page — and on first open it rendered only half-height. (§V1 omitted it.)
    '<section id="chat-view-root" class="flex-1 overflow-hidden flex h-full bg-slate-100/15 dark:bg-slate-900/15">'
    // Chat Sidebar: History List
    + '<div class="w-80 border-r border-slate-200 dark:border-slate-800 flex flex-col bg-white/10 dark:bg-slate-900/10 flex-shrink-0">'
    + '<div class="px-5 py-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/20 flex items-center justify-between flex-shrink-0">'
    + '<span class="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">歷史對話</span>'
    + '<button id="chat-new-btn" title="開啟新對話" class="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-850 text-cyan-600 dark:text-cyan-400"><i data-lucide="plus-circle" class="h-4 w-4"></i></button>'
    + '</div>'
    + '<div id="chat-history-list" class="flex-1 overflow-y-auto p-3 space-y-1.5"></div>'
    + '</div>'
    // Hidden avatar-mood state tracker (no visual — read/written by pollJob/finishReattached/
    // sendChatMessage/setAvatarState via document.getElementById('hana-avatar-container')). The
    // legacy markup also had a full <svg> Q-version avatar here, but that whole sub-panel was
    // already dead (wrapper had class="hidden" permanently, comment said "(removed)") — only this
    // state-tracking div is load-bearing, so that's all that's rebuilt here.
    + '<div id="hana-avatar-container" class="state-idle hidden"></div>'
    // Main Chat Dialogue Area
    + '<div class="flex-1 flex flex-col overflow-hidden bg-white/20 dark:bg-slate-900/20">'
    + '<div class="px-6 py-3 border-b border-slate-200 dark:border-slate-800 bg-white/40 dark:bg-slate-900/30 flex items-center justify-between flex-shrink-0">'
    + '<div class="flex items-center space-x-3">'
    + '<label class="text-xs font-semibold text-slate-500 dark:text-slate-400">大腦模型:</label>'
    + '<select id="chat-model-select" class="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 shadow-sm cursor-pointer"><option value="">載入可用模型中…</option></select>'
    + '<select id="chat-effort-select" title="推理強度" class="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 shadow-sm cursor-pointer"><option value="default">預設</option></select>'
    + '<select id="chat-style-select" title="回覆風格" class="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 shadow-sm cursor-pointer"><option value="default">風格：預設</option></select>'
    + '<button id="limit-status-btn" title="各模型可用/限流狀態（依實際呼叫結果更新）" class="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 hover:text-cyan-600 dark:hover:text-cyan-400 border border-slate-200 dark:border-slate-800 rounded-xl px-2.5 py-1.5 shadow-sm transition-colors">'
    + '<span id="limit-status-dot" class="h-2 w-2 rounded-full bg-slate-300"></span><span id="limit-status-label">額度</span></button>'
    + '</div>'
    // TGC9-01 (SPEC-telegram.md §17.4): manual refresh — Telegram free-typing now writes into the
    // same chat_<sessionId>.json this tab reads (TGC8), but this tab won't notice on its own; the
    // commander explicitly asked for a manual pull, not auto-polling.
    + '<button id="chat-refresh-btn" title="重新讀取這本對話（例如剛用 Telegram 補講了幾句）" class="text-xs text-slate-400 hover:text-cyan-600 transition-colors flex items-center space-x-1 mr-3"><i data-lucide="refresh-cw" class="h-3.5 w-3.5"></i><span>刷新對話</span></button>'
    + '<button id="chat-clear-btn" class="text-xs text-slate-400 hover:text-red-500 transition-colors flex items-center space-x-1"><i data-lucide="trash-2" class="h-3.5 w-3.5"></i><span>清除當前對話</span></button>'
    + '</div>'
    + '<div id="chat-tab-bar" class="flex items-end gap-1 px-3 pt-1.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-950/30 overflow-x-auto flex-shrink-0"></div>'
    + '<div id="chat-messages-container" class="flex-1 overflow-y-auto px-4 py-6 space-y-6 select-text">'
    + '<div id="chat-empty-state" class="h-full flex flex-col items-center justify-center text-center space-y-4 max-w-md mx-auto px-6">'
    + '<div class="h-14 w-14 rounded-2xl bg-gradient-to-tr from-cyan-500 to-blue-500 text-white flex items-center justify-center shadow-lg shadow-cyan-500/20"><i data-lucide="sparkles" class="h-7 w-7"></i></div>'
    + '<div class="space-y-1.5"><h4 class="text-base font-display font-semibold text-slate-800 dark:text-slate-200">開始一段新對話</h4>'
    + '<p class="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">從上方選擇模型（Claude / Gemini / Codex），問我關於這個工作區的規格、法規或程式碼。</p></div></div>'
    + '</div>'
    // Chat Input Area
    + '<div class="px-4 py-4 border-t border-slate-200 dark:border-slate-800 bg-white/40 dark:bg-slate-900/30 flex-shrink-0">'
    + '<div id="chat-attach-row" class="hidden max-w-3xl mx-auto mb-2 flex flex-wrap gap-2"></div>'
    + '<input id="chat-attach-file" type="file" multiple class="hidden">'
    + '<div class="max-w-3xl mx-auto flex items-end space-x-3">'
    + '<div class="flex-1 relative">'
    + '<div id="cmd-menu" class="hidden absolute bottom-full mb-2 left-0 right-0 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl overflow-hidden z-30 max-h-64 overflow-y-auto"></div>'
    + '<div class="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl p-2.5 shadow-sm focus-within:ring-2 focus-within:ring-cyan-500/20 focus-within:border-cyan-500 transition-all flex flex-col">'
    + '<div id="cmd-capsule" class="hidden mb-1.5"></div>'
    + '<textarea id="chat-input-textarea" rows="1" placeholder="問問內容，或輸入 / 叫出指令... (Enter 發送，Shift+Enter 換行)" class="w-full bg-transparent resize-none border-none focus:ring-0 focus:outline-none text-sm text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-500 max-h-36 min-h-[24px] overflow-y-auto"></textarea>'
    + '</div>'
    + '</div>'
    + '<button id="btn-attach-chat" title="附加檔案（也可貼上截圖或拖放）" class="h-11 w-11 rounded-2xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-300 flex items-center justify-center transition-all flex-shrink-0"><i data-lucide="paperclip" class="h-4.5 w-4.5"></i></button>'
    + '<button id="btn-mic-chat" title="語音輸入（按一次開始，再按停止）" class="h-11 w-11 rounded-2xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-300 flex items-center justify-center transition-all flex-shrink-0">'
    + '<i data-lucide="mic" class="h-4.5 w-4.5 rec-ic-idle"></i><i data-lucide="square" fill="currentColor" class="h-4 w-4 rec-ic-rec hidden"></i></button>'
    + '<button id="btn-loopback-chat" title="電腦音訊（來賓）——按一次開始收音，再按停止；靜音 10 秒或滿 5 分鐘自動收尾" class="h-11 w-11 rounded-2xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-300 flex items-center justify-center transition-all flex-shrink-0">'
    + '<i data-lucide="laptop" class="h-4.5 w-4.5 rec-ic-idle"></i><i data-lucide="square" fill="currentColor" class="h-4 w-4 rec-ic-rec hidden"></i></button>'
    + '<button id="btn-send-chat" title="發送（合併我／來賓）" class="h-11 w-11 rounded-2xl bg-cyan-600 hover:bg-cyan-700 text-white flex items-center justify-center shadow-lg shadow-cyan-500/10 hover:shadow-cyan-500/20 transition-all flex-shrink-0"><i data-lucide="send" class="h-4.5 w-4.5"></i></button>'
    + '</div>'
    + '<div class="max-w-3xl mx-auto mt-1.5 flex items-center gap-2 text-[10px] text-slate-400">'
    + '<span id="mic-state-chat" class="text-rose-500"></span><span id="loopback-state-chat" class="text-rose-500"></span>'
    + '<span class="ml-auto">音訊主題</span><select id="audio-topic-chat" class="bg-transparent border-0 text-[10px] text-slate-500 focus:outline-none p-0"></select>'
    + '<span>辨識模型</span><select id="stt-model-chat" class="bg-transparent border-0 text-[10px] text-slate-500 focus:outline-none p-0"><option value="small">small（快）</option><option value="medium">medium（準）</option><option value="large-v3">large-v3</option></select>'
    + '<span>語音語言</span><select id="mic-lang-chat" class="bg-transparent border-0 text-[10px] text-slate-500 focus:outline-none p-0"><option value="zh">中文</option><option value="en">English</option></select>'
    + '</div>'
    + '<div id="chat-loopback-wrap" class="hidden max-w-3xl mx-auto mt-2">'
    + '<div class="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900 rounded-xl p-2">'
    + '<div class="flex items-center justify-between mb-1">'
    + '<input id="chat-loopback-name" type="text" placeholder="來賓（Guest）" class="text-[10px] font-medium text-amber-700 dark:text-amber-400 bg-transparent border-none focus:ring-0 focus:outline-none p-0 flex-1 min-w-0">'
    + '<div class="flex items-center gap-2 flex-shrink-0">'
    + '<button id="chat-loopback-clear-btn" class="text-[10px] text-slate-400 hover:text-rose-500">清空</button>'
    + '<button id="chat-loopback-hide-btn" class="text-[10px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">收起 ✕</button>'
    + '</div></div>'
    + '<textarea id="chat-loopback-input" rows="2" placeholder="來賓講的話會轉文字回填到這裡…可累積多段" class="w-full bg-transparent resize-none border-none focus:ring-0 focus:outline-none text-sm text-slate-800 dark:text-slate-200 placeholder-slate-400"></textarea>'
    + '<div class="flex items-center gap-3 mt-1">'
    + '<a id="chat-send-meonly" class="text-[10px] text-slate-400 hover:text-cyan-600 cursor-pointer underline">只發我這段</a>'
    + '<a id="chat-send-guestonly" class="text-[10px] text-slate-400 hover:text-cyan-600 cursor-pointer underline">只發來賓這段</a>'
    + '</div></div></div>'
    + '</div>'
    + '</div>'
    + '</section>';

  container.querySelector('#chat-new-btn').addEventListener('click', () => window.startNewChat());
  container.querySelector('#chat-refresh-btn').addEventListener('click', () => window.refreshActiveChatTab());
  container.querySelector('#chat-clear-btn').addEventListener('click', () => window.clearCurrentChat());
  container.querySelector('#chat-model-select').addEventListener('change', (e) => window.onChatModelChange(e.target.value));
  container.querySelector('#chat-effort-select').addEventListener('change', (e) => window.onChatEffortChange(e.target.value));
  container.querySelector('#chat-style-select').addEventListener('change', (e) => window.onChatStyleChange(e.target.value));
  container.querySelector('#limit-status-btn').addEventListener('click', (e) => window.toggleLimitPanel(e));
  container.querySelector('#chat-input-textarea').addEventListener('keydown', (e) => window.handleChatInputKey(e));
  container.querySelector('#chat-input-textarea').addEventListener('input', (e) => window.onChatInput(e.target));
  container.querySelector('#btn-attach-chat').addEventListener('click', () => container.querySelector('#chat-attach-file').click());
  container.querySelector('#btn-mic-chat').addEventListener('click', () => window.voiceToggle('chat-input-textarea', 'btn-mic-chat', 'mic-state-chat', 'mic-lang-chat'));
  container.querySelector('#btn-loopback-chat').addEventListener('click', () => window.loopbackToggle('chat-loopback-input', 'btn-loopback-chat', 'loopback-state-chat', 'chat-loopback-wrap', 'mic-lang-chat'));
  container.querySelector('#btn-send-chat').addEventListener('click', () => window.chatSendOrStop());
  container.querySelector('#audio-topic-chat').addEventListener('change', (e) => window.onAudioTopicSelect(e.target, 'mic-lang-chat'));
  container.querySelector('#stt-model-chat').addEventListener('change', (e) => window.setSttModel(e.target.value));
  container.querySelector('#chat-loopback-clear-btn').addEventListener('click', () => window.loopbackClear('chat-loopback-input'));
  container.querySelector('#chat-loopback-hide-btn').addEventListener('click', () => window.loopbackHidePanel('chat-loopback-wrap'));
  container.querySelector('#chat-send-meonly').addEventListener('click', () => window.sendChatMessage('meOnly'));
  container.querySelector('#chat-send-guestonly').addEventListener('click', () => window.sendChatMessage('guestOnly'));
  // SPEC-chat-message-delete.md §Y3/§4.2 — this container is rebuilt on every mount(), so the
  // per-message trash button's delegated listener has to be rewired here each time too.
  container.querySelector('#chat-messages-container').addEventListener('click', (e) => window.onChatMessagesContainerClick(e));

  // MM-M1 attachments: initChatAttachments() (called once at page bootstrap) only wired the
  // 'main' scope's paste/drop/change listeners onto elements that didn't exist yet at that time
  // (chat-panel is now built lazily here). Re-wire just the 'main' scope here on every mount —
  // NOT the whole initChatAttachments(), which would also re-wire 'float' and stack duplicate
  // listeners on the always-present floating-chat elements.
  if (typeof window.wireChatAttachScope === 'function') {
    window.wireChatAttachScope('main', 'chat-input-textarea', container.querySelector('#chat-input-textarea'));
  }
}

export function mount(root, ctx) {
  container = root;
  if (typeof window.showPanel === 'function') window.showPanel('__view_root__');
  root.classList.remove('hidden');
  if (typeof window.highlightMenuBtn === 'function') window.highlightMenuBtn('menu-chat');
  const pathEl = document.getElementById('header-file-path'); if (pathEl) pathEl.innerText = 'Hana AI Chat Panel';
  const titleEl = document.getElementById('header-file-title'); if (titleEl) titleEl.innerText = '與 AI 討論規格與代碼';
  const vscodeEl = document.getElementById('btn-vscode'); if (vscodeEl) vscodeEl.href = '#';
  const savedEl = document.getElementById('last-saved'); if (savedEl) savedEl.classList.add('hidden');
  const backEl = document.getElementById('btn-back'); if (backEl) backEl.classList.add('hidden');
  // AVT-FIX：整頁對話裡頭像照常顯示（麥克風/筆記/問題回報/設定都還要用），只隱藏「頭像對話」入口
  // （整頁本身就是對話）。不再整個藏頭像。
  const widget = document.getElementById('hana-float-widget'); if (widget) widget.classList.add('hana-no-chat');

  render();

  // Re-run the chat-DOM-dependent parts of the page's one-time init() — those ran before this
  // panel's elements existed (chat-panel used to be static markup; now it's built above).
  if (typeof window.loadChatModels === 'function') window.loadChatModels();
  if (typeof window.loadChatStyles === 'function') window.loadChatStyles();
  if (typeof window.initSttModel === 'function') window.initSttModel();
  if (typeof window.loadAudioTopics === 'function') window.loadAudioTopics();

  // Same sequence as the old switchToChat(): ensure at least one tab, then render tab bar +
  // active conversation (reattachRunningJobs()/createTab() etc. may already have populated
  // chatTabs/activeTabId before this view was ever mounted — that state lives in index.html's
  // module scope, not here, so it survives across mount/unmount).
  if (typeof window.ensureActiveChatTab === 'function') window.ensureActiveChatTab();
  if (typeof window.renderTabBar === 'function') window.renderTabBar();
  if (typeof window.renderActiveTab === 'function') window.renderActiveTab();
  if (typeof window.chatSyncSendButtonAndAvatar === 'function') window.chatSyncSendButtonAndAvatar();

  if (typeof window.loadChatHistoryList === 'function') window.loadChatHistoryList();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

export function unmount() {
  const widget = document.getElementById('hana-float-widget'); if (widget) widget.classList.remove('hana-no-chat');
  // Deliberately does NOT abort in-flight jobs/polling — background chat jobs are meant to survive
  // navigating away (that's the whole point of job reattach); index.html's pollJob()/tickChatTimers()
  // already no-op gracefully when their target DOM elements are gone.
  if (container) { container.classList.add('hidden'); container.innerHTML = ''; }
  container = null;
}

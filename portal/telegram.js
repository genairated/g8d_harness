'use strict';
// Telegram 全域指揮控制台
//   C1: outbound sink (scheduler notifications)
//   C2: inbound long-polling + auth whitelist + /bind + read-only cmds + console log
//   C3: sticky context, /use, /here, expose context for web mirror
//   C4: task dispatch — intent classify → inline [確認] → job in workspace
//   C5: console log compression/delete + sendDocument + long-message split
// 機密：token 等存 HARNESS_HOME/global-knowledge/secrets/telegram.json
// 控制台日誌：HARNESS_HOME/global-knowledge/telegram/console.json
// 不用任何 npm 套件（純 Node built-in https）

const https      = require('https');
const fs         = require('fs');
const path       = require('path');
const notesStore = require('./notes');   // SN2: /note, /notes — shared with server.js's Notes API
const audioTopics = require('./audio-topics');   // AT2-d: F5 voice picks the chat's workspace default topic

// C4: simple task-intent heuristic — true = likely a mutating task
// TGC7-04: first exclude query-toned phrasing, then check for action-verb PHRASES (not single
// chars — a lone char like "跑" false-matched "跑完沒？"). Query tone always wins → chat path.
const TASK_QUERY_RE = /(看一下|查一下|確認一下|為什麼|是不是|有沒有|完成了嗎|好了沒|狀態|進度|嗎[?？]?$|[?？]$)/;
const TASK_RE_ZH = /(修改|修正|修復|改成|改一下|調整|新增|刪除|建立|部署|執行|撰寫|寫一個|寫入|更新|重構|移除|搬移|複製|安裝|設定)/;
const TASK_RE_EN = /\b(create|modify|edit|delete|deploy|run|exec(?:ute)?|write|update|remove|fix|build|refactor|add|change)\b/i;
function looksLikeTask(text) {
  const t = String(text || '');
  if (TASK_QUERY_RE.test(t)) return false;
  return TASK_RE_ZH.test(t) || TASK_RE_EN.test(t);
}

class TelegramBot {
  constructor(harnessHome, schedulerManager, opts) {
    opts = opts || {};
    this._harnessHome      = harnessHome;
    this._schedulerManager = schedulerManager;
    this._chatFn           = opts.chatFn || null;          // (text, context, ctx) => Promise<string>
    this._taskFn           = opts.taskFn || null;          // C4: (prompt, workspaceRoot) => Promise<string>
    this._listProjectsFn   = opts.listProjectsFn || null;  // C3: () => [{name, root}]
    this._sttFn            = opts.sttFn || null;            // F5: (audioPath, lang) => Promise<string>
    this._ttsVoiceFn       = opts.ttsVoiceFn || null;      // F5: (text) => Promise<oggPath|null>
    this._voiceLang        = opts.voiceLang || 'zh';       // F5: STT language for inbound voice
    this._meetingsFn       = opts.meetingsFn || null;      // /meeting: (workspaceRoot) => [{meta}]
    this._meetingDetailFn  = opts.meetingDetailFn || null; // /meeting detail: (root, id) => {meta,transcript,summary}

    this._secretsDir  = path.join(harnessHome, 'global-knowledge', 'secrets');
    this._secretsPath = path.join(this._secretsDir, 'telegram.json');
    this._consolePath = path.join(harnessHome, 'global-knowledge', 'telegram', 'console.json');

    this._token             = null;
    this._authorizedChatIds = new Set();
    this._offset            = 0;
    this._polling           = false;
    this._contexts          = {};         // C3: String(chatId) -> { root, label, sessions }
    this._pendingConfirms   = new Map();  // C4: key -> { chatId, text, workspaceRoot, label, ts, sessionId }
    // TGC8: web-chat-session plumbing (opts, all optional — degrade to "功能未設定" if absent)
    this._listChatSessionsFn = opts.listChatSessionsFn || null; // (root) => [{sessionId,title,updatedAt,messages}]
    this._createChatSessionFn = opts.createChatSessionFn || null; // (root, title) => sessionId
    this._recapSessionFn     = opts.recapSessionFn || null;      // (root, sessionId) => Promise<string>
    this._backCursor         = new Map();  // TGC8-05: String(chatId) -> { sessionId, page }

    // Generic extension points for optional plugins (no built-in command depends on these).
    //   _extraCallbackHandlers: async (data, chatId, bot) => boolean  — claim an inline-button callback
    //   _extraTextInterceptors: async (chatId, text, bot) => boolean  — claim a plain-text message pre-route
    // A handler returning true means "I handled this" → dispatch/routing stops.
    this._extraCallbackHandlers = [];
    this._extraTextInterceptors = [];

    this._loadConfig();
  }

  // ── Config ───────────────────────────────────────────────────────────────

  _loadConfig() {
    try {
      if (!fs.existsSync(this._secretsPath)) return;
      const cfg = JSON.parse(fs.readFileSync(this._secretsPath, 'utf8'));
      if (cfg.botToken)              this._token = cfg.botToken;
      if (cfg.authorizedChatIds)     this._authorizedChatIds = new Set(cfg.authorizedChatIds);
      if (cfg.pollingOffset != null) this._offset = cfg.pollingOffset;
      if (cfg.contexts && typeof cfg.contexts === 'object') this._contexts = cfg.contexts;
      if (cfg.model === 'opus' || cfg.model === 'sonnet') this._model = cfg.model;
    } catch (e) { console.error('[Telegram] config load error:', e.message); }
  }

  _saveConfig() {
    try {
      fs.mkdirSync(this._secretsDir, { recursive: true });
      let cfg = {};
      try { cfg = JSON.parse(fs.readFileSync(this._secretsPath, 'utf8')); } catch (e) {}
      cfg.authorizedChatIds = [...this._authorizedChatIds];
      cfg.pollingOffset     = this._offset;
      cfg.contexts          = this._contexts;
      if (this._model) cfg.model = this._model;
      fs.writeFileSync(this._secretsPath, JSON.stringify(cfg, null, 2));
    } catch (e) { console.error('[Telegram] config save error:', e.message); }
  }

  isConfigured() { return !!this._token; }

  // TG-MODEL: 自由對話／派任務用的模型，預設 opus（指揮官拍板：短對話為主，思考品質優先於 token 成本）。
  // 內部摘要（_tgRecapSession）不吃這個，固定用 sonnet（見呼叫點）。
  getModel() { return this._model || 'opus'; }
  setModel(m) {
    if (m !== 'opus' && m !== 'sonnet') return { ok: false, error: '只接受 opus 或 sonnet。' };
    this._model = m;
    this._saveConfig();
    return { ok: true };
  }

  // The single bound commander chat, for server-side triggers that aren't replying to an
  // inbound update and so have no chatId of their own (same lookup as handleWebMessage's
  // chatId fallback). Used by optional server-initiated flows.
  getPrimaryChatId() {
    return this._authorizedChatIds.size > 0 ? [...this._authorizedChatIds][0] : null;
  }

  getStatus() {
    return {
      configured:      this.isConfigured(),
      polling:         this._polling,
      authorizedCount: this._authorizedChatIds.size,
      offset:          this._offset,
    };
  }

  // C3: sticky context accessors (also consumed by /api/telegram/context)
  getContext(chatId)            { return this._contexts[String(chatId)] || null; }
  getAllContexts()              { return this._contexts; }
  setContext(chatId, root, label) {
    // TGC8-01: preserve the per-workspace session cursor map across a workspace switch —
    // it used to be a flat overwrite, which would silently wipe `.sessions` on every /use.
    const key  = String(chatId);
    const prev = this._contexts[key] || {};
    this._contexts[key] = { root, label: label || root, sessions: prev.sessions || {} };
    this._saveConfig();
  }

  // ── TGC8-01: sticky "对话游标" — chatId × normalised workspace root -> activeSessionId ─────
  getActiveSessionId(chatId, root) {
    const c = this._contexts[String(chatId)];
    if (!c || !c.sessions) return null;
    return c.sessions[this._normWs(root)] || null;
  }

  setActiveSessionId(chatId, root, sessionId) {
    const key = String(chatId);
    if (!this._contexts[key]) this._contexts[key] = { root, label: path.basename(root || '') };
    if (!this._contexts[key].sessions) this._contexts[key].sessions = {};
    this._contexts[key].sessions[this._normWs(root)] = sessionId;
    this._saveConfig();
  }

  // Resolve (or lazily create) the active session for this chat's current workspace context.
  // Used by both the typed-text and voice free-chat entry points so they share one cursor.
  _resolveActiveSession(chatId) {
    const ctx = this.getContext(chatId);
    const workspaceRoot = (ctx && ctx.root) || this._harnessHome;
    let sessionId = this.getActiveSessionId(chatId, workspaceRoot);
    if (!sessionId) {
      sessionId = 'session_' + Date.now();
      this.setActiveSessionId(chatId, workspaceRoot, sessionId);
    }
    return { ctx, workspaceRoot, sessionId };
  }

  // TGC8-06: 接錯本防呆 — one line telling the commander which chat session is now active.
  _sessionStatusLine(chatId, workspaceRoot) {
    const sessionId = this.getActiveSessionId(chatId, workspaceRoot);
    if (!sessionId) return '現在接：（尚無對話，直接打字即自動建立新對話）';
    let title = sessionId;
    if (this._listChatSessionsFn) {
      try {
        const s = this._listChatSessionsFn(workspaceRoot).find(function (x) { return x.sessionId === sessionId; });
        if (s && s.title) title = s.title;
      } catch (e) {}
    }
    return '現在接：' + title;
  }

  // TGC8-04/05: 標題＋最後更新時間＋最近 3 則各一兩句 — 絕不倒全文。
  _buildSummaryCard(session) {
    const title   = (session && session.title) || '新對話';
    const updated = (session && session.updatedAt) ? session.updatedAt.slice(0, 16).replace('T', ' ') : '（尚無訊息）';
    let card = '現在接：' + title + '\n更新時間：' + updated;
    const msgs = (session && Array.isArray(session.messages)) ? session.messages : [];
    if (!msgs.length) {
      card += '\n（這本對話還沒有內容，直接打字開始吧）';
    } else {
      card += '\n\n最近內容：';
      msgs.slice(-3).forEach(function (m) {
        const who  = m.role === 'user' ? '指揮官' : 'Hana';
        const text = (typeof m.content === 'string' ? m.content : '').replace(/\s+/g, ' ').slice(0, 200);
        card += '\n• ' + who + '：' + text + (text.length >= 200 ? '…' : '');
      });
    }
    return card;
  }

  // ── Telegram HTTPS API ────────────────────────────────────────────────────

  _apiPost(method, body, socketTimeoutMs) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const reqOpts = {
        hostname: 'api.telegram.org',
        path:     '/bot' + this._token + '/' + method,
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      };
      const req = https.request(reqOpts, (res) => {
        let data = '';
        res.on('data', (d) => { data += d; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { resolve({ ok: false }); }
        });
      });
      req.on('error', reject);
      if (socketTimeoutMs) {
        req.setTimeout(socketTimeoutMs, () => {
          req.destroy(new Error('socket timeout after ' + socketTimeoutMs + 'ms'));
        });
      }
      req.write(payload);
      req.end();
    });
  }

  // ── Outbound messages (C1 / C3 / C4 / C5) ────────────────────────────────

  async sendMessage(chatId, text) {
    if (!this._token) return;
    const chunks = this._splitMessage(String(text || ''));
    for (const chunk of chunks) {
      try { await this._apiPost('sendMessage', { chat_id: chatId, text: chunk }); }
      catch (e) { console.error('[Telegram] sendMessage error:', e.message); }
    }
  }

  // C4: send with inline keyboard (single row); keyboard attached only to last chunk
  async sendInlineKeyboard(chatId, text, buttons) {
    if (!this._token) return;
    const chunks = this._splitMessage(String(text || ''));
    for (var i = 0; i < chunks.length; i++) {
      const body = { chat_id: chatId, text: chunks[i] };
      if (i === chunks.length - 1 && buttons && buttons.length) {
        body.reply_markup = { inline_keyboard: [buttons] };
      }
      try { await this._apiPost('sendMessage', body); }
      catch (e) { console.error('[Telegram] sendInlineKeyboard error:', e.message); }
    }
  }

  // C4: send with multi-row inline keyboard; rows = [[{text,callback_data}], ...]
  async sendInlineRows(chatId, text, rows) {
    if (!this._token) return;
    const chunks = this._splitMessage(String(text || ''));
    for (var i = 0; i < chunks.length; i++) {
      const body = { chat_id: chatId, text: chunks[i] };
      if (i === chunks.length - 1 && rows && rows.length) {
        body.reply_markup = { inline_keyboard: rows };
      }
      try { await this._apiPost('sendMessage', body); }
      catch (e) { console.error('[Telegram] sendInlineRows error:', e.message); }
    }
  }

  // C4: acknowledge callback query (prevents Telegram loading spinner from hanging)
  async answerCallbackQuery(callbackQueryId, text) {
    if (!this._token) return;
    try {
      await this._apiPost('answerCallbackQuery', { callback_query_id: callbackQueryId, text: text || '' });
    } catch (e) { console.error('[Telegram] answerCallbackQuery error:', e.message); }
  }

  // C5: send a file as Telegram document (multipart/form-data, no npm deps)
  async sendDocument(chatId, filename, buffer) {
    if (!this._token) return;
    const boundary = 'TgBoundary' + Date.now();
    const head = [
      '--' + boundary,
      'Content-Disposition: form-data; name="chat_id"',
      '',
      String(chatId),
      '--' + boundary,
      'Content-Disposition: form-data; name="document"; filename="' + filename + '"',
      'Content-Type: application/octet-stream',
      '',
    ].join('\r\n') + '\r\n';
    const tail = '\r\n--' + boundary + '--\r\n';
    const body = Buffer.concat([Buffer.from(head, 'utf8'), buffer, Buffer.from(tail, 'utf8')]);
    return new Promise((resolve) => {
      const opts = {
        hostname: 'api.telegram.org',
        path:     '/bot' + this._token + '/sendDocument',
        method:   'POST',
        headers:  { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length },
      };
      const req = https.request(opts, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', (e) => { console.error('[Telegram] sendDocument error:', e.message); resolve(); });
      req.write(body); req.end();
    });
  }

  // F5: send a voice note (OGG/Opus) via sendVoice (multipart/form-data, no npm deps)
  async sendVoice(chatId, oggPath) {
    if (!this._token) return;
    let audio;
    try { audio = fs.readFileSync(oggPath); } catch (e) { console.error('[Telegram] sendVoice read error:', e.message); return; }
    const boundary = 'TgVoice' + Date.now();
    const head = [
      '--' + boundary,
      'Content-Disposition: form-data; name="chat_id"',
      '',
      String(chatId),
      '--' + boundary,
      'Content-Disposition: form-data; name="voice"; filename="reply.ogg"',
      'Content-Type: audio/ogg',
      '',
    ].join('\r\n') + '\r\n';
    const tail = '\r\n--' + boundary + '--\r\n';
    const body = Buffer.concat([Buffer.from(head, 'utf8'), audio, Buffer.from(tail, 'utf8')]);
    return new Promise((resolve) => {
      const opts = {
        hostname: 'api.telegram.org',
        path:     '/bot' + this._token + '/sendVoice',
        method:   'POST',
        headers:  { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length },
      };
      const req = https.request(opts, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', (e) => { console.error('[Telegram] sendVoice error:', e.message); resolve(); });
      req.write(body); req.end();
    });
  }

  async sendToAll(text) {
    if (!this._token) return;
    for (const id of this._authorizedChatIds) { await this.sendMessage(id, text); }
  }

  // C5: split long text into ≤4000-char chunks at newline boundaries
  _splitMessage(text) {
    const MAX = 4000;
    if (text.length <= MAX) return [text];
    const chunks = [];
    while (text.length > 0) {
      let cut = text.lastIndexOf('\n', MAX);
      if (cut <= 0) cut = MAX;
      chunks.push(text.slice(0, cut));
      text = text.slice(cut).replace(/^\n/, '');
    }
    return chunks;
  }

  // ── Sink registration (C1) ────────────────────────────────────────────────

  registerSink() {
    if (!this._schedulerManager) return;
    const self = this;
    this._schedulerManager.sinkManager.register('telegram', function (payload) {
      // Not configured / no recipients → nothing to send; resolve so the run is treated as delivered
      // (the sink only registers when configured, so this is just a defensive no-op, not retry-spam).
      if (!self.isConfigured() || self._authorizedChatIds.size === 0) return Promise.resolve();
      // RETURN the send promise (don't swallow errors). The scheduler awaits this and only marks
      // telegram delivered once Telegram has actually accepted the message. If a deploy-restart aborts
      // the in-flight send, the await never resolves, deliveredSinks isn't updated for telegram, and
      // B4 (flushPendingDeliveries) re-sends it on boot. A send failure rejects → stays undelivered → retried.
      // TGC10-03: a run manually triggered from a Telegram conversation carries payload.origin
      // ({channel:'telegram',chatId,sessionId}) — route the completion notice back to that one chat
      // instead of broadcasting. Auto-triggered runs (and manual triggers without an origin, e.g. the
      // web "立即執行" button) have no origin → unchanged sendToAll broadcast.
      const o = payload.origin;
      if (o && o.channel === 'telegram' && o.chatId) {
        return self.sendMessage(o.chatId, self._formatNotification(payload));
      }
      return self.sendToAll(self._formatNotification(payload));
    });
    console.log('[Telegram] sink registered');
  }

  _formatNotification(payload) {
    // SN4: due-note reminder — a distinct payload shape from schedule-run notifications.
    if (payload.kind === 'note_reminder') {
      return '⏰ 便條到期：' + payload.text + ' · ' + payload.workspaceLabel;
    }
    // KD5-2: 知識精華彙整提案就緒——workspaceLabel 標明是哪個工作區，counts 只算該工作區自己的 proposal.json。
    if (payload.kind === 'distill_ready') {
      let msg = '🧪 【' + payload.workspaceLabel + '】彙整提案已就緒，' + payload.pendingCount + ' 條待裁決';
      if (payload.disputedCount > 0) msg += '／' + payload.disputedCount + ' 條等你回覆';
      return msg;
    }
    // MTG-ABRT-01: 會議錄製中斷——人不在畫面前也要知道「這場沒錄到」，不然只能事後翻檔案。
    if (payload.kind === 'meeting_aborted') {
      let msg = '⛔ 【' + payload.workspaceLabel + '】會議錄製中斷：' + payload.title;
      if (payload.reason) msg += '\n原因：' + payload.reason;
      return msg;
    }
    // MQ-13: model quota health transition — distinct payload shape (not a schedule run).
    if (payload.kind === 'model_quota_health') {
      const icon = payload.type === 'model_quota_degraded' ? '🔴' : '🟢';
      return icon + ' ' + payload.summary;
    }
    // SSTAT-P: partial (✅ 完成·待確認) uses the same ✅ as success — payload.summary (deliverSummary
    // from server.js) already carries the "✅ 完成·待確認：<reason>" text so the reason still lands
    // on the phone without opening the app.
    const icon = (payload.status === 'success' || payload.status === 'partial') ? '✅' : (payload.status === 'failed' ? '❌' : (payload.status === 'blocked' ? '⚠️' : '⏳'));
    let text = icon + ' 排程完成：' + payload.scheduleName + '\n狀態：' + payload.status;
    if (payload.summary) text += '\n摘要：' + payload.summary;
    return text;
  }

  // ── Console log (C2 + C5) ─────────────────────────────────────────────────

  _logConsole(entry) {
    try {
      fs.mkdirSync(path.dirname(this._consolePath), { recursive: true });
      let log = [];
      try { log = JSON.parse(fs.readFileSync(this._consolePath, 'utf8')); } catch (e) {}
      if (!Array.isArray(log)) log = [];
      log.push(Object.assign({ ts: new Date().toISOString() }, entry));
      // C5: auto-compress when > 200 entries; collapse oldest into a sentinel
      if (log.length > 200) {
        const old = log.splice(0, log.length - 100);
        log.unshift({
          ts:         old[old.length - 1].ts,
          role:       'system',
          text:       '[已自動壓縮 ' + old.length + ' 則較舊記錄]',
          compressed: old.length,
        });
      }
      fs.writeFileSync(this._consolePath, JSON.stringify(log, null, 2));
    } catch (e) { console.error('[Telegram] console log error:', e.message); }
  }

  getConsoleLog(limit) {
    try {
      const log = JSON.parse(fs.readFileSync(this._consolePath, 'utf8'));
      return (Array.isArray(log) ? log : []).slice(-(limit || 100));
    } catch (e) { return []; }
  }

  clearConsoleLog() {
    try {
      fs.mkdirSync(path.dirname(this._consolePath), { recursive: true });
      fs.writeFileSync(this._consolePath, JSON.stringify([], null, 2));
      return true;
    } catch (e) { return false; }
  }

  // C5: delete a single log entry by absolute index
  deleteConsoleEntry(idx) {
    try {
      let log = [];
      try { log = JSON.parse(fs.readFileSync(this._consolePath, 'utf8')); } catch (e) {}
      if (!Array.isArray(log) || idx < 0 || idx >= log.length) return false;
      log.splice(idx, 1);
      fs.writeFileSync(this._consolePath, JSON.stringify(log, null, 2));
      return true;
    } catch (e) { return false; }
  }

  // ── Inbound long-polling (C2) ─────────────────────────────────────────────

  start() {
    if (!this.isConfigured()) {
      console.log('[Telegram] no botToken in secrets/telegram.json — polling skipped');
      return;
    }
    this.registerSink();
    this._polling = true;
    this._pollLoop();
    this._registerCommands();   // register the "/" command menu in the Telegram app (fire-and-forget)
    console.log('[Telegram] long-polling started (offset=' + this._offset + ')');
  }

  // Register the bot's slash-command menu so Telegram shows an autocomplete list when typing "/".
  // Fire-and-forget; a failure (e.g. offline) must not block polling. Keep in sync with _cmdHelp.
  async _registerCommands() {
    try {
      await this._apiPost('setMyCommands', {
        commands: [
          { command: 'today',     description: '今天的排程執行記錄' },
          { command: 'schedules', description: '排程清單（目前工作區）' },
          { command: 'status',    description: '系統狀態 + 目前脈絡' },
          { command: 'here',      description: '顯示目前工作區脈絡' },
          { command: 'use',       description: '切換工作區脈絡（/use 專案名）' },
          { command: 'meeting',   description: '查詢今日或指定日期的會議（/meeting 或 /meeting 6/25）' },
          { command: 'note',      description: '記一張便條（/note 內容 due:MM/DD color:顏色，或 /note list）' },
          { command: 'notes',     description: '列出目前工作區未完成便條' },
          { command: 'chats',     description: '列出最近對話（/chats 3 切換到第 3 本）' },
          { command: 'newchat',   description: '開一本新對話（/newchat 標題）' },
          { command: 'whichchat', description: '現在接的是哪一本對話' },
          { command: 'back',      description: '往前翻對話（一次 3 則）' },
          { command: 'recap',     description: '把目前對話濃縮成一段摘要' },
          { command: 'clear',     description: '清空控制台日誌' },
          { command: 'delete',    description: '刪除某則日誌（/delete 序號）' },
          { command: 'help',      description: '顯示指令說明' },
        ],
      });
      console.log('[Telegram] slash-command menu registered (setMyCommands)');
    } catch (e) {
      console.error('[Telegram] setMyCommands failed:', e.message);
    }
  }

  stop() {
    this._polling = false;
    console.log('[Telegram] polling stopped');
  }

  _pollLoop() {
    var self = this;
    function loop() {
      if (!self._polling) return;
      // C4: include callback_query in allowed_updates for inline keyboard handling
      self._apiPost(
        'getUpdates',
        { offset: self._offset, timeout: 30, allowed_updates: ['message', 'callback_query'] },
        40000
      ).then(function (result) {
        if (result && result.ok && Array.isArray(result.result) && result.result.length > 0) {
          for (var i = 0; i < result.result.length; i++) {
            self._offset = result.result[i].update_id + 1;
            self._handleUpdate(result.result[i]).catch(function (e) {
              console.error('[Telegram] handleUpdate error:', e.message);
            });
          }
          self._saveConfig();
        }
        if (self._polling) setImmediate(loop);
      }).catch(function (e) {
        if (self._polling) {
          console.error('[Telegram] poll error:', e.message);
          setTimeout(loop, 5000);
        }
      });
    }
    setImmediate(loop);
  }

  async _handleUpdate(update) {
    // C4: handle callback_query (inline keyboard button press)
    if (update.callback_query) {
      return this._handleCallbackQuery(update.callback_query);
    }

    const msg = update.message;
    if (!msg) return;

    // C6: handle photo or image-type document (no text required)
    const hasPhoto    = Array.isArray(msg.photo) && msg.photo.length > 0;
    const hasImageDoc = msg.document && msg.document.mime_type &&
                        msg.document.mime_type.startsWith('image/');
    if (hasPhoto || hasImageDoc) return this._handlePhoto(msg);

    // F5: handle voice note / audio (no text required) → STT → Hana → voice reply
    const hasVoice    = msg.voice || (msg.audio && msg.audio.file_id);
    const hasAudioDoc = msg.document && msg.document.mime_type && msg.document.mime_type.startsWith('audio/');
    if (hasVoice || hasAudioDoc) return this._handleVoice(msg);

    if (!msg.text) return;
    const chatId = msg.chat.id;
    const text   = msg.text.trim();

    // /bind must be processed before auth check (needed for initial pairing)
    if (text === '/bind') return this._handleBind(chatId);

    // Authorization: silently ignore unknown chats
    if (!this._authorizedChatIds.has(chatId)) {
      console.log('[Telegram] unauthorized from chat_id=' + chatId + ' (ignored)');
      return;
    }

    this._logConsole({ role: 'user', chatId, text });

    // Generic extension point: optional plugins get first claim on a plain-text message
    // (e.g. a multi-step flow awaiting the user's next reply) before normal routing.
    // A slash command is left for the plugin to decide (it may treat "/" as an escape).
    for (const h of this._extraTextInterceptors) {
      try { if (await h(chatId, text, this)) return; }
      catch (e) { console.error('[Telegram] extra text interceptor error:', e.message); }
    }

    try {
      await this._route(chatId, text);
    } catch (e) {
      console.error('[Telegram] route error:', e.message);
      await this.sendMessage(chatId, '⚠️ 處理時發生錯誤：' + String(e.message).slice(0, 200));
    }
  }

  // C6: handle inbound photo or image document
  async _handlePhoto(msg) {
    const chatId = msg.chat.id;
    if (!this._authorizedChatIds.has(chatId)) {
      console.log('[Telegram] unauthorized photo from chat_id=' + chatId + ' (ignored)');
      return;
    }

    // Pick file_id: photo array (largest = last element) or image document
    var fileId, origExt;
    if (Array.isArray(msg.photo) && msg.photo.length > 0) {
      fileId  = msg.photo[msg.photo.length - 1].file_id;
      origExt = '.jpg';
    } else {
      fileId  = msg.document.file_id;
      var dn  = msg.document.file_name || '';
      origExt = dn.includes('.') ? dn.slice(dn.lastIndexOf('.')) : '.jpg';
    }

    const filename = 'tg_' + Date.now() + origExt;
    const caption  = (msg.caption || '').trim();

    this._logConsole({ role: 'user', chatId,
      text: '[圖片] ' + filename + (caption ? ' — ' + caption : ''),
      imageFilename: filename });

    await this.sendMessage(chatId, '📥 收到圖片，正在下載...');

    // Resolve Telegram file_path via getFile
    var fileRes;
    try {
      fileRes = await this._apiPost('getFile', { file_id: fileId });
      if (!fileRes.ok || !fileRes.result || !fileRes.result.file_path) {
        throw new Error('getFile 回傳失敗');
      }
    } catch (e) {
      console.error('[Telegram] getFile error:', e.message);
      await this.sendMessage(chatId, '⚠️ 無法取得圖片資訊：' + e.message.slice(0, 200));
      return;
    }

    const tgFilePath = fileRes.result.file_path;
    const imagesDir  = path.join(this._harnessHome, 'global-knowledge', 'telegram', 'images');
    try { fs.mkdirSync(imagesDir, { recursive: true }); } catch (e) {}
    const localPath = path.join(imagesDir, filename);

    try {
      await this._downloadTelegramFile(tgFilePath, localPath);
    } catch (e) {
      console.error('[Telegram] download error:', e.message);
      await this.sendMessage(chatId, '⚠️ 圖片下載失敗：' + e.message.slice(0, 200));
      return;
    }

    this._logConsole({ role: 'system', chatId, text: '[圖片已儲存] ' + localPath });

    // Build route text: inject local path so chatFn/taskFn can read the image
    const imageNote = '指揮官附了截圖，路徑：' + localPath + '（請用 Read 工具讀取後再回答）';
    const routeText = caption ? imageNote + '\n指揮官說：' + caption : imageNote;

    try {
      await this._route(chatId, routeText);
    } catch (e) {
      console.error('[Telegram] photo route error:', e.message);
      await this.sendMessage(chatId, '⚠️ 處理圖片時發生錯誤：' + e.message.slice(0, 200));
    }
  }

  // F5: handle inbound voice note → download → STT (stt.py) → Hana → text + voice reply
  async _handleVoice(msg) {
    const chatId = msg.chat.id;
    if (!this._authorizedChatIds.has(chatId)) {
      console.log('[Telegram] unauthorized voice from chat_id=' + chatId + ' (ignored)');
      return;
    }
    const media = msg.voice || msg.audio || msg.document;
    const fileId = media && media.file_id;
    if (!fileId) return;
    this._logConsole({ role: 'user', chatId, text: '[語音訊息]' });

    if (!this._sttFn) { await this.sendMessage(chatId, '⚠️ 語音辨識未設定，無法處理語音。'); return; }

    // Resolve + download the .ogg from Telegram's CDN
    let fileRes;
    try { fileRes = await this._apiPost('getFile', { file_id: fileId }); }
    catch (e) { await this.sendMessage(chatId, '⚠️ 無法取得語音檔：' + String(e.message).slice(0, 150)); return; }
    if (!fileRes || !fileRes.ok || !fileRes.result || !fileRes.result.file_path) {
      await this.sendMessage(chatId, '⚠️ 無法取得語音檔資訊。'); return;
    }
    const voiceDir = path.join(this._harnessHome, 'global-knowledge', 'telegram', 'voice');
    try { fs.mkdirSync(voiceDir, { recursive: true }); } catch (e) {}
    const localPath = path.join(voiceDir, 'tg_voice_' + Date.now() + '.ogg');
    try { await this._downloadTelegramFile(fileRes.result.file_path, localPath); }
    catch (e) { await this.sendMessage(chatId, '⚠️ 語音下載失敗：' + String(e.message).slice(0, 150)); return; }

    // STT (server Whisper via stt.py). AT2-d: use this chat's current workspace default audio
    // topic, if any — Telegram has no per-message topic picker, just the workspace's defaultTopicId.
    const ctxForTopic = this.getContext(chatId);
    const workspaceForTopic = (ctxForTopic && ctxForTopic.root) || this._harnessHome;
    const resolvedTopic = audioTopics.resolveDefaultTopic(this._harnessHome, workspaceForTopic);
    let text = '';
    try { text = await this._sttFn(localPath, this._voiceLang, resolvedTopic && resolvedTopic.prompt); }
    catch (e) { await this.sendMessage(chatId, '⚠️ 語音辨識失敗：' + String(e.message).slice(0, 150)); return; }
    finally { try { fs.unlinkSync(localPath); } catch (e) {} }

    if (!text || !text.trim()) { await this.sendMessage(chatId, '🤔 沒聽清楚，請再說一次。'); return; }
    this._logConsole({ role: 'user', chatId, text: '🎙️ ' + text });
    await this.sendMessage(chatId, '🎙️ 聽到：' + text);

    // Mutating request → existing confirm flow (text only). Conversational → reply text + voice.
    if (looksLikeTask(text)) return this._confirmTask(chatId, text);
    if (!this._chatFn) return;
    try {
      // TGC8-02: voice free-chat shares the same session cursor as typed free-chat.
      const { ctx, sessionId } = this._resolveActiveSession(chatId);
      const reply = await this._chatFn(text, this.getConsoleLog(), ctx, chatId, sessionId);
      const safe = String(reply || '（無回應）');
      this._logConsole({ role: 'bot', chatId, text: safe });
      await this.sendMessage(chatId, safe);
      // Voice reply (edge-tts → ogg/opus). Best-effort: a TTS failure still leaves the text reply.
      if (this._ttsVoiceFn) {
        try {
          const oggPath = await this._ttsVoiceFn(safe.slice(0, 600));
          if (oggPath) { await this.sendVoice(chatId, oggPath); try { fs.unlinkSync(oggPath); } catch (e) {} }
        } catch (e) { console.error('[Telegram] voice reply error:', e.message); }
      }
    } catch (e) {
      await this.sendMessage(chatId, '⚠️ 回覆失敗：' + String(e.message).slice(0, 150));
    }
  }

  // Download a file from Telegram's CDN (GET /file/bot<token>/<file_path>)
  _downloadTelegramFile(tgFilePath, localPath) {
    var token = this._token;
    return new Promise(function (resolve, reject) {
      var opts = {
        hostname: 'api.telegram.org',
        path:     '/file/bot' + token + '/' + tgFilePath,
        method:   'GET',
      };
      var req = https.request(opts, function (res) {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        var chunks = [];
        res.on('data', function (d) { chunks.push(d); });
        res.on('end',  function () {
          try { fs.writeFileSync(localPath, Buffer.concat(chunks)); resolve(); }
          catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  // C4: handle inline keyboard button presses
  async _handleCallbackQuery(cq) {
    const chatId = cq.message && cq.message.chat && cq.message.chat.id;
    const data   = cq.data || '';
    // Always ack to remove Telegram loading state
    await this.answerCallbackQuery(cq.id, '收到！');
    if (!chatId || !this._authorizedChatIds.has(chatId)) return;

    // Generic extension point: optional plugins get first claim on the callback.
    for (const h of this._extraCallbackHandlers) {
      try { if (await h(data, chatId, this)) return; }
      catch (e) { console.error('[Telegram] extra callback handler error:', e.message); }
    }

    if (data.startsWith('confirm:')) {
      const key     = data.slice('confirm:'.length);
      const pending = this._pendingConfirms.get(key);
      if (!pending) {
        await this.sendMessage(chatId, '⚠️ 確認已逾時或找不到。請重新發送指令。');
        return;
      }
      this._pendingConfirms.delete(key);
      await this._executeTask(chatId, pending.text, pending.workspaceRoot, pending.label, pending.sessionId);

    } else if (data.startsWith('cancel:')) {
      const key = data.slice('cancel:'.length);
      this._pendingConfirms.delete(key);
      await this.sendMessage(chatId, '❌ 已取消。');

    } else if (data.startsWith('use:')) {
      // C3: workspace picker selection
      const root     = data.slice('use:'.length);
      const projects = this._listProjectsFn ? this._listProjectsFn() : [];
      const proj     = projects.find(function (p) { return p.root === root; });
      const label    = proj ? (proj.name || path.basename(root)) : path.basename(root);
      this.setContext(chatId, root, label);
      // TGC8-06: 接錯本防呆 — 工作區切換後附上目前接的是哪本對話。
      const statusLine = this._sessionStatusLine(chatId, root);
      this._logConsole({ role: 'bot', chatId, text: '已切換至 ' + label });
      await this.sendMessage(chatId, '📍 目前脈絡切換至：' + label + '\n(' + root + ')\n' + statusLine);

    } else if (data.startsWith('meeting:')) {
      // /meeting — view meeting detail
      const meetingId = data.slice('meeting:'.length);
      await this._sendMeetingDetail(chatId, meetingId);
    }
  }

  // C4: execute a confirmed task in the target workspace
  async _executeTask(chatId, text, workspaceRoot, label, sessionId) {
    const displayLabel = label || (workspaceRoot ? path.basename(workspaceRoot) : '預設');
    await this.sendMessage(chatId, '⚙️ 開始在「' + displayLabel + '」執行任務...');
    this._logConsole({ role: 'system', chatId, text: '[開始任務] 標的:' + displayLabel + ' | ' + text.slice(0, 200) });

    if (!this._taskFn) {
      const reply = '⚠️ taskFn 未設定，無法執行任務（請聯絡系統管理員）。';
      this._logConsole({ role: 'bot', chatId, text: reply });
      await this.sendMessage(chatId, reply);
      return;
    }

    try {
      // TGC8-03: front-context now comes from the workspace's active CHAT SESSION (same source
      // as free chat), not the console log — `context`/`chatId` are kept as a fallback for callers
      // that don't (yet) resolve a sessionId, per taskFn's own graceful-degrade contract.
      const result = await this._taskFn(text, workspaceRoot, this.getConsoleLog(), chatId, sessionId);
      const safe   = String(result || '（完成，無輸出）');
      // TGC7-03: log full reply (no 300-char truncation) — truncation only happens at the
      // Telegram send layer below (3500-char message cap), not at the log-write layer.
      this._logConsole({ role: 'bot', chatId, text: '[任務完成] ' + safe });
      await this.sendMessage(chatId, '✅ 任務完成 @ ' + displayLabel + '\n\n' + safe.slice(0, 3500));
    } catch (e) {
      const reply = '❌ 任務執行失敗：' + String(e.message).slice(0, 300);
      this._logConsole({ role: 'bot', chatId, text: reply });
      await this.sendMessage(chatId, reply);
    }
  }

  // ── /bind: one-time pairing (C2) ─────────────────────────────────────────

  async _handleBind(chatId) {
    try {
      let cfg = {};
      try { cfg = JSON.parse(fs.readFileSync(this._secretsPath, 'utf8')); } catch (e) {}
      const pendingUntil = cfg.bindPendingUntil ? new Date(cfg.bindPendingUntil) : null;
      if (pendingUntil && new Date() < pendingUntil) {
        this._authorizedChatIds.add(chatId);
        cfg.authorizedChatIds = [...this._authorizedChatIds];
        cfg.pollingOffset     = this._offset;
        cfg.bindPendingUntil  = null;
        fs.writeFileSync(this._secretsPath, JSON.stringify(cfg, null, 2));
        await this.sendMessage(chatId,
          '✅ 綁定成功！此 chat 已加入授權白名單。\n歡迎使用 Hana 全域指揮控制台。\n\n' +
          '指令：/today /schedules /status /here /use /clear /help'
        );
        console.log('[Telegram] chat_id=' + chatId + ' bound and authorized');
      } else {
        // No active bind window — silently ignore
        console.log('[Telegram] /bind from chat_id=' + chatId + ' — no active bind window');
      }
    } catch (e) { console.error('[Telegram] bind handler error:', e.message); }
  }

  openBindWindow(minutes) {
    try {
      fs.mkdirSync(this._secretsDir, { recursive: true });
      let cfg = {};
      try { cfg = JSON.parse(fs.readFileSync(this._secretsPath, 'utf8')); } catch (e) {}
      const expiresAt = new Date(Date.now() + (minutes || 10) * 60000).toISOString();
      cfg.bindPendingUntil = expiresAt;
      fs.writeFileSync(this._secretsPath, JSON.stringify(cfg, null, 2));
      console.log('[Telegram] bind window opened until ' + expiresAt);
      return expiresAt;
    } catch (e) {
      console.error('[Telegram] openBindWindow error:', e.message);
      return null;
    }
  }

  // ── Message routing (C2 + C3 + C5) ──────────────────────────────────────

  async _route(chatId, text) {
    const parts = text.split(/\s+/);
    const cmd   = parts[0].toLowerCase();
    if (cmd === '/today')     return this._cmdToday(chatId);
    if (cmd === '/schedules') return this._cmdSchedules(chatId);
    if (cmd === '/status')    return this._cmdStatus(chatId);
    if (cmd === '/here')      return this._cmdHere(chatId);
    if (cmd === '/use')       return this._cmdUse(chatId, parts.slice(1).join(' '));
    if (cmd === '/meeting')   return this._cmdMeeting(chatId, parts.slice(1).join(' '));
    if (cmd === '/note')      return this._cmdNote(chatId, parts.slice(1).join(' '));
    if (cmd === '/notes')     return this._cmdNotes(chatId);
    if (cmd === '/clear')     return this._cmdClear(chatId);
    if (cmd === '/delete')    return this._cmdDelete(chatId, parts[1]);
    if (cmd === '/chats')     return this._cmdChats(chatId, parts.slice(1).join(' '));
    if (cmd === '/newchat')   return this._cmdNewChat(chatId, parts.slice(1).join(' '));
    if (cmd === '/whichchat') return this._cmdWhichChat(chatId);
    if (cmd === '/back')      return this._cmdBack(chatId, parts[1]);
    if (cmd === '/recap')     return this._cmdRecap(chatId);
    if (cmd === '/model')     return this._cmdModel(chatId, parts[1]);
    if (cmd === '/help')      return this._cmdHelp(chatId);
    return this._chat(chatId, text);
  }

  // /meeting [date] — list meetings for the current workspace context on a given date
  async _cmdMeeting(chatId, arg) {
    const ctx = this.getContext(chatId);
    const workspaceRoot = (ctx && ctx.root) || this._harnessHome;
    const label = ctx ? ctx.label : path.basename(workspaceRoot);

    // Parse date: "6/25", "06/25", "2026/6/25", "2026-06-25", or default today
    const today = new Date().toISOString().slice(0, 10);
    var dateStr = today;
    var raw = (arg || '').trim();
    if (raw) {
      var m1 = raw.match(/^(\d{1,2})\/(\d{1,2})$/);
      var m2 = raw.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
      if (m1) {
        dateStr = new Date().getFullYear() + '-' +
          String(parseInt(m1[1], 10)).padStart(2, '0') + '-' +
          String(parseInt(m1[2], 10)).padStart(2, '0');
      } else if (m2) {
        dateStr = m2[1] + '-' + String(parseInt(m2[2], 10)).padStart(2, '0') + '-' +
          String(parseInt(m2[3], 10)).padStart(2, '0');
      }
    }

    if (!this._meetingsFn) {
      return this.sendMessage(chatId, '⚠️ meetingsFn 未設定，無法查詢會議。');
    }

    var meetings = [];
    try { meetings = this._meetingsFn(workspaceRoot); } catch (e) {
      return this.sendMessage(chatId, '⚠️ 查詢會議失敗：' + e.message);
    }

    var filtered = meetings.filter(function (m) { return (m.startedAt || '').startsWith(dateStr); });

    if (!filtered.length) {
      var noReply = '📅 ' + dateStr + '（' + label + '）沒有會議記錄。';
      this._logConsole({ role: 'bot', chatId, text: noReply });
      return this.sendMessage(chatId, noReply);
    }

    var header = '📅 ' + dateStr + '（' + label + '）有 ' + filtered.length + ' 場會議，點選查看：';
    var rows = filtered.slice(0, 10).map(function (m) {
      var timeStr = (m.startedAt || '').slice(11, 16);
      var icon = m.status === 'done' ? '✅' : (m.status === 'recording' ? '🔴' : '•');
      var title = (m.title || m.meetingId || '未命名').slice(0, 30);
      return [{ text: icon + ' ' + timeStr + ' ' + title, callback_data: 'meeting:' + m.meetingId }];
    });

    this._logConsole({ role: 'bot', chatId, text: header });
    return this.sendInlineRows(chatId, header, rows);
  }

  // Send detailed meeting content (transcript + summary) to chat
  async _sendMeetingDetail(chatId, meetingId) {
    if (!this._meetingDetailFn) {
      return this.sendMessage(chatId, '⚠️ meetingDetailFn 未設定。');
    }
    const ctx = this.getContext(chatId);
    const workspaceRoot = (ctx && ctx.root) || this._harnessHome;
    try {
      const detail = this._meetingDetailFn(workspaceRoot, meetingId);
      const meta = detail.meta || {};
      const title = meta.title || meetingId;
      const timeStr = (meta.startedAt || '').slice(0, 16).replace('T', ' ');
      var reply = '📋 ' + title + '\n🕐 ' + timeStr;
      if (meta.status) reply += '　' + meta.status;
      reply += '\n\n';
      if (detail.summary) {
        reply += '── 摘要 ──\n' + detail.summary.slice(0, 1800) +
          (detail.summary.length > 1800 ? '\n…（已截斷）' : '');
      } else if (detail.transcript) {
        reply += '── 逐字稿 ──\n' + detail.transcript.slice(0, 2000) +
          (detail.transcript.length > 2000 ? '\n…（已截斷）' : '');
      } else {
        reply += '（無逐字稿或摘要）';
      }
      this._logConsole({ role: 'bot', chatId, text: '[會議詳情] ' + title });
      return this.sendMessage(chatId, reply);
    } catch (e) {
      return this.sendMessage(chatId, '⚠️ 讀取會議失敗：' + e.message);
    }
  }

  // ── SN2: /note, /notes — 指揮官個人待辦便條白板 ──────────────────────────

  // Parse "<內容> [due:MM/DD|due:YYYY-MM-DD] [color:xxx]" — order-independent, both tokens optional.
  _parseNoteArgs(raw) {
    let text = raw;
    let dueAt = null, color = null;
    const dueMatch = text.match(/due:(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2})/i);
    if (dueMatch) {
      dueAt = this._resolveDueDate(dueMatch[1]);
      text = text.replace(dueMatch[0], '').trim();
    }
    const colorMatch = text.match(/color:([a-z]+)/i);
    if (colorMatch) {
      const c = colorMatch[1].toLowerCase();
      if (notesStore.NOTE_COLORS.includes(c)) color = c;
      text = text.replace(colorMatch[0], '').trim();
    }
    return { text: text.replace(/\s+/g, ' ').trim(), dueAt, color };
  }

  // "MM/DD" (no year → this year, rolled to next year if already past) or "YYYY-MM-DD" →
  // local "YYYY-MM-DDTHH:mm" (defaults to 09:00). Local calendar components, not UTC (MEMORY: a
  // toISOString-based date in UTC+8 rolls back a day).
  _resolveDueDate(raw) {
    const now = new Date();
    let y, mo, d;
    const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (iso) {
      y = parseInt(iso[1], 10); mo = parseInt(iso[2], 10); d = parseInt(iso[3], 10);
    } else {
      const md = raw.match(/^(\d{1,2})\/(\d{1,2})$/);
      mo = parseInt(md[1], 10); d = parseInt(md[2], 10);
      y = now.getFullYear();
      const candidate = new Date(y, mo - 1, d);
      const todayOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (candidate < todayOnly) y += 1;
    }
    const pad = (n) => String(n).padStart(2, '0');
    return y + '-' + pad(mo) + '-' + pad(d) + 'T09:00';
  }

  // /note <內容> [due:...] [color:...] — create; /note list — alias for /notes
  async _cmdNote(chatId, argStr) {
    const raw = (argStr || '').trim();
    if (!raw) return this.sendMessage(chatId, '用法：/note <內容> [due:MM/DD 或 due:YYYY-MM-DD] [color:顏色]\n或 /note list 查詢');
    if (raw.toLowerCase() === 'list') return this._cmdNotes(chatId);

    const { text, dueAt, color } = this._parseNoteArgs(raw);
    if (!text) return this.sendMessage(chatId, '⚠️ 便條內容不能是空的。');

    const ctx = this.getContext(chatId);
    const workspace = (ctx && ctx.root) || this._harnessHome;
    const now = new Date().toISOString();
    const note = {
      id: notesStore.genNoteId(),
      text,
      color: color || 'yellow',
      x: 0.08 + Math.random() * 0.55,
      y: 0.08 + Math.random() * 0.55,
      z: Date.now(),
      w: null,
      dueAt: dueAt || null,
      remindedAt: null,
      status: 'active',
      workspace,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    const list = notesStore.readNotes(this._harnessHome);
    list.push(note);
    notesStore.writeNotes(this._harnessHome, list);

    const dueLabel = dueAt ? '（到期 ' + dueAt.slice(0, 16).replace('T', ' ') + '）' : '';
    const reply = '📌 已記下便條' + dueLabel + '：\n' + text;
    this._logConsole({ role: 'bot', chatId, text: reply });
    return this.sendMessage(chatId, reply);
  }

  // /notes — list current workspace-context's unfinished notes, nearest-due first (no-due last)
  async _cmdNotes(chatId) {
    const ctx = this.getContext(chatId);
    const workspace = (ctx && ctx.root) || this._harnessHome;
    const active = notesStore.normWs(workspace);
    const label = ctx ? ctx.label : path.basename(workspace);
    const list = notesStore.readNotes(this._harnessHome)
      .filter(function (n) { return n.status === 'active'; })
      .filter(function (n) { return notesStore.normWs(n.workspace || workspace) === active; });

    if (!list.length) {
      const reply = '📌 目前沒有待辦便條（' + label + '）。';
      this._logConsole({ role: 'bot', chatId, text: reply });
      return this.sendMessage(chatId, reply);
    }

    list.sort(function (a, b) {
      if (!a.dueAt && !b.dueAt) return 0;
      if (!a.dueAt) return 1;
      if (!b.dueAt) return -1;
      return a.dueAt.localeCompare(b.dueAt);
    });

    const todayStr = notesStore.localDateStr(new Date());
    const lines = list.map(function (n) {
      let mark = '';
      if (n.dueAt) {
        const d = n.dueAt.slice(0, 10);
        mark = d < todayStr ? ' ⚠️已過期' : (d === todayStr ? ' 📍今日到期' : '');
        mark += '（到期 ' + n.dueAt.slice(0, 16).replace('T', ' ') + '）';
      }
      return '• ' + String(n.text || '').slice(0, 200) + mark;
    });
    const reply = '📌 待辦便條（' + label + '，' + list.length + ' 張）：\n' + lines.join('\n');
    this._logConsole({ role: 'bot', chatId, text: reply });
    return this.sendMessage(chatId, reply);
  }

  async _cmdToday(chatId) {
    const sm = this._schedulerManager;
    if (!sm) return this.sendMessage(chatId, '排程系統不可用。');
    const today = new Date().toISOString().slice(0, 10);
    let runs = sm.queryRuns({ since: today + 'T00:00:00.000Z' });
    // Scope to the chat's workspace context (map run.scheduleId → schedule.workspace).
    const ctx = this.getContext(chatId);
    let scope;
    if (ctx && ctx.root) {
      const active = this._normWs(ctx.root);
      const wsMap = {};
      sm.loadSchedules().forEach(s => { wsMap[s.id] = s.workspace; });
      runs = runs.filter(r => this._normWs(wsMap[r.scheduleId]) === active);
      scope = '（' + ctx.label + '）';
    } else {
      scope = '（全部工作區・未設定脈絡）';
    }
    let reply;
    if (!runs.length) {
      reply = '今天' + scope + '還沒有排程任務執行。';
    } else {
      const lines = runs.map(function (r) {
        const icon = (r.status === 'success' || r.status === 'partial') ? '✅' : (r.status === 'failed' ? '❌' : (r.status === 'blocked' ? '⚠️' : '⏳'));
        const t = (r.startedAt || '').slice(0, 16).replace('T', ' ');
        return icon + ' ' + (r.scheduleId || '').slice(0, 20) + ' — ' + r.status + ' @ ' + t;
      });
      reply = '📅 今天的執行記錄 ' + scope + '（' + runs.length + ' 筆）：\n' + lines.join('\n');
    }
    this._logConsole({ role: 'bot', chatId, text: reply });
    return this.sendMessage(chatId, reply);
  }

  // Normalise a workspace path for comparison (collapse doubled separators, lowercase).
  _normWs(p) { try { return path.resolve(String(p || '')).toLowerCase(); } catch (e) { return ''; } }

  async _cmdSchedules(chatId) {
    const sm = this._schedulerManager;
    if (!sm) return this.sendMessage(chatId, '排程系統不可用。');
    const ctx = this.getContext(chatId);
    let list = sm.loadSchedules();
    let scope;
    if (ctx && ctx.root) {
      const active = this._normWs(ctx.root);
      list = list.filter(s => this._normWs(s.workspace) === active);
      scope = '（' + ctx.label + '）';
    } else {
      scope = '（全部工作區・未設定脈絡，用 /use 切換）';
    }
    let reply;
    if (!list.length) {
      reply = '目前' + scope + '沒有設定任何排程。';
    } else {
      const lines = list.map(function (s) {
        const icon = s.enabled ? '🟢' : '⚫';
        const next = s.nextRunAt ? s.nextRunAt.slice(0, 16).replace('T', ' ') : '無';
        return icon + ' ' + s.name + '\n  下次：' + next + ' | 模型：' + (s.model || '?');
      });
      reply = '📅 排程清單 ' + scope + '（' + list.length + ' 個）：\n\n' + lines.join('\n\n');
    }
    this._logConsole({ role: 'bot', chatId, text: reply });
    return this.sendMessage(chatId, reply);
  }

  async _cmdStatus(chatId) {
    const uptime = Math.floor(process.uptime());
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const sm = this._schedulerManager;
    const ctx  = this.getContext(chatId);
    let sched = sm ? sm.loadSchedules() : [];
    if (ctx && ctx.root) { const active = this._normWs(ctx.root); sched = sched.filter(s => this._normWs(s.workspace) === active); }
    const schedCount  = sm ? sched.length : '?';
    const activeCount = sm ? sched.filter(function (s) { return s.enabled; }).length : '?';
    const reply = [
      '🤖 Hana Harness 狀態',
      '運行時間：' + h + 'h ' + m + 'm',
      '記憶體：' + mem + ' MB',
      'PID：' + process.pid,
      '排程：' + activeCount + ' 啟用 / ' + schedCount + ' 總計',
      'Telegram：已連接 (' + this._authorizedChatIds.size + ' 授權)',
      '目前脈絡：' + (ctx ? ctx.label : '未設定（用 /use 切換）'),
    ].join('\n');
    this._logConsole({ role: 'bot', chatId, text: reply });
    return this.sendMessage(chatId, reply);
  }

  async _cmdHere(chatId) {
    const ctx = this.getContext(chatId);
    let reply;
    if (ctx) {
      reply = '📍 目前脈絡：' + ctx.label + '\n路徑：' + ctx.root + '\n\n用 /use <專案名> 切換';
    } else {
      reply = '📍 目前脈絡：未設定\n\n用 /use <專案名> 設定，或發任務時從清單選擇。';
    }
    this._logConsole({ role: 'bot', chatId, text: reply });
    return this.sendMessage(chatId, reply);
  }

  // C3: /use [project] — set sticky workspace context
  async _cmdUse(chatId, arg) {
    const argTrim = (arg || '').trim();
    if (!argTrim) return this._showProjectPicker(chatId, '請選擇目標工作區：');
    const projects = this._listProjectsFn ? this._listProjectsFn() : [];
    const q = argTrim.toLowerCase();
    const match = projects.find(function (p) {
      return (p.name || '').toLowerCase().includes(q)
          || path.basename(p.root || '').toLowerCase().includes(q)
          || (p.root || '').toLowerCase().includes(q);
    });
    if (!match) return this._showProjectPicker(chatId, '找不到「' + argTrim + '」，請從清單選擇：');
    const label = match.name || path.basename(match.root);
    this.setContext(chatId, match.root, label);
    // TGC8-06: 接錯本防呆 — 工作區切換後附上目前接的是哪本對話。
    const reply = '📍 已切換至：' + label + '\n路徑：' + match.root + '\n' + this._sessionStatusLine(chatId, match.root);
    this._logConsole({ role: 'bot', chatId, text: reply });
    return this.sendMessage(chatId, reply);
  }

  // C3: show project picker as inline keyboard rows
  async _showProjectPicker(chatId, prompt) {
    const projects = this._listProjectsFn ? this._listProjectsFn() : [];
    if (!projects.length) return this.sendMessage(chatId, '目前沒有已知的工作區。');
    const buttons = projects.slice(0, 12).map(function (p) {
      return { text: (p.name || path.basename(p.root || '')).slice(0, 30), callback_data: 'use:' + p.root };
    });
    const rows = [];
    for (var i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
    try {
      await this._apiPost('sendMessage', { chat_id: chatId, text: prompt || '請選擇工作區：', reply_markup: { inline_keyboard: rows } });
    } catch (e) { console.error('[Telegram] showProjectPicker error:', e.message); }
  }

  // TG-MODEL: /model — show or switch the model used for chatFn/taskFn (opus/sonnet).
  async _cmdModel(chatId, arg) {
    const argTrim = (arg || '').trim().toLowerCase();
    if (!argTrim) {
      const reply = '🧠 目前使用模型：' + this.getModel() + '\n\n用 /model opus 或 /model sonnet 切換。';
      this._logConsole({ role: 'bot', chatId, text: reply });
      return this.sendMessage(chatId, reply);
    }
    const r = this.setModel(argTrim);
    const reply = r.ok
      ? '✅ 已切換至 ' + argTrim + '。之後的對話與任務都會用這個模型。'
      : '⚠️ ' + r.error;
    this._logConsole({ role: 'bot', chatId, text: reply });
    return this.sendMessage(chatId, reply);
  }

  async _cmdClear(chatId) {
    const ok    = this.clearConsoleLog();
    const reply = ok ? '✅ 控制台日誌已清空。' : '⚠️ 清空失敗，請稍後再試。';
    return this.sendMessage(chatId, reply);
  }

  // C5: /delete <n>
  async _cmdDelete(chatId, idxStr) {
    const idx = parseInt(idxStr, 10);
    if (isNaN(idx)) return this.sendMessage(chatId, '用法：/delete <序號>');
    const ok    = this.deleteConsoleEntry(idx);
    const reply = ok ? '✅ 已刪除第 ' + idx + ' 則記錄。' : '⚠️ 找不到序號 ' + idx + ' 的記錄。';
    return this.sendMessage(chatId, reply);
  }

  async _cmdHelp(chatId) {
    const reply = [
      '🤖 Hana 指揮控制台指令：',
      '/today — 今天的排程執行記錄',
      '/schedules — 排程清單',
      '/status — 系統狀態 + 目前脈絡',
      '/here — 目前脈絡',
      '/use [專案名] — 切換目前脈絡',
      '/meeting [日期] — 查詢當日或指定日期的會議',
      '/note <內容> [due:MM/DD] [color:顏色] — 記一張便條（或 /note list 查詢）',
      '/notes — 列出目前工作區未完成便條',
      '/chats [編號] — 列出目前工作區最近對話（或切換到某本）',
      '/newchat [標題] — 開一本新對話',
      '/whichchat — 現在接的是哪一本對話',
      '/back [n] — 往前翻對話（一次 3 則）',
      '/recap — 把目前這本對話濃縮成一段摘要',
      '/model [opus|sonnet] — 查詢或切換對話／任務用的模型（預設 opus）',
      '/clear — 清空控制台日誌',
      '/delete <序號> — 刪除某則日誌',
      '/help — 顯示此說明',
      '',
      '直接發送文字：',
      '• 問答 / 唯讀 → 直接回應（併入網頁對話本）',
      '• 改檔 / 執行 → 確認後再派工',
    ].join('\n');
    return this.sendMessage(chatId, reply);
  }

  // ── TGC8-04: /chats [n] — list recent sessions in the current workspace, or switch to #n ──
  async _cmdChats(chatId, argStr) {
    const ctx = this.getContext(chatId);
    const workspaceRoot = (ctx && ctx.root) || this._harnessHome;
    if (!this._listChatSessionsFn) return this.sendMessage(chatId, '⚠️ 對話列表功能未設定。');

    let sessions = [];
    try { sessions = this._listChatSessionsFn(workspaceRoot); }
    catch (e) { return this.sendMessage(chatId, '⚠️ 讀取對話清單失敗：' + e.message.slice(0, 200)); }
    const top = sessions.slice(0, 10);

    const n = parseInt((argStr || '').trim(), 10);
    if (!isNaN(n)) {
      const picked = top[n - 1];
      if (!picked) return this.sendMessage(chatId, '⚠️ 找不到編號 ' + n + '（目前只有 ' + top.length + ' 本）。');
      this.setActiveSessionId(chatId, workspaceRoot, picked.sessionId);
      this._logConsole({ role: 'bot', chatId, text: '[切換對話] ' + (picked.title || picked.sessionId) });
      return this.sendMessage(chatId, this._buildSummaryCard(picked));
    }

    if (!top.length) return this.sendMessage(chatId, '📂 這個工作區還沒有任何對話記錄，直接打字就會自動開一本。');
    const activeId = this.getActiveSessionId(chatId, workspaceRoot);
    const lines = top.map(function (s, i) {
      const mark = (s.sessionId === activeId) ? ' ← 目前' : '';
      const t    = s.updatedAt ? s.updatedAt.slice(0, 16).replace('T', ' ') : '';
      return (i + 1) + '. ' + (s.title || '（無標題）') + '（' + t + '）' + mark;
    });
    const label = ctx ? ctx.label : path.basename(workspaceRoot);
    return this.sendMessage(chatId, '📂 最近對話（' + label + '）：\n' + lines.join('\n') + '\n\n用 /chats <編號> 切換');
  }

  // ── TGC8-04: /newchat [標題] — start a fresh session in the current workspace ──────────────
  async _cmdNewChat(chatId, argStr) {
    const ctx = this.getContext(chatId);
    const workspaceRoot = (ctx && ctx.root) || this._harnessHome;
    if (!this._createChatSessionFn) return this.sendMessage(chatId, '⚠️ 新增對話功能未設定。');
    const title = (argStr || '').trim() || null;
    let sessionId;
    try { sessionId = this._createChatSessionFn(workspaceRoot, title); }
    catch (e) { return this.sendMessage(chatId, '⚠️ 建立對話失敗：' + e.message.slice(0, 200)); }
    this.setActiveSessionId(chatId, workspaceRoot, sessionId);
    this._backCursor.delete(String(chatId));
    this._logConsole({ role: 'bot', chatId, text: '[新對話] ' + (title || sessionId) });
    return this.sendMessage(chatId, this._buildSummaryCard({ sessionId, title: title || '新對話', updatedAt: new Date().toISOString(), messages: [] }));
  }

  // ── TGC8-04: /whichchat — which session is currently active for this workspace ────────────
  async _cmdWhichChat(chatId) {
    const ctx = this.getContext(chatId);
    const workspaceRoot = (ctx && ctx.root) || this._harnessHome;
    const sessionId = this.getActiveSessionId(chatId, workspaceRoot);
    if (!sessionId) return this.sendMessage(chatId, '📍 ' + (ctx ? ctx.label : path.basename(workspaceRoot)) + '　目前還沒有作用中的對話，打字就會自動建立一本。');
    let session = null;
    if (this._listChatSessionsFn) {
      try { session = this._listChatSessionsFn(workspaceRoot).find(function (s) { return s.sessionId === sessionId; }); }
      catch (e) {}
    }
    if (!session) return this.sendMessage(chatId, '📍 目前對話：' + sessionId + '（找不到內容，可能剛建立）');
    return this.sendMessage(chatId, this._buildSummaryCard(session));
  }

  // ── TGC8-05: /back [n] — page backwards through the active session, 3 messages at a time ──
  async _cmdBack(chatId, argStr) {
    const ctx = this.getContext(chatId);
    const workspaceRoot = (ctx && ctx.root) || this._harnessHome;
    const sessionId = this.getActiveSessionId(chatId, workspaceRoot);
    if (!sessionId) return this.sendMessage(chatId, '📍 目前沒有作用中的對話可回顧。');
    if (!this._listChatSessionsFn) return this.sendMessage(chatId, '⚠️ 回顧功能未設定。');

    let session;
    try { session = this._listChatSessionsFn(workspaceRoot).find(function (s) { return s.sessionId === sessionId; }); }
    catch (e) { return this.sendMessage(chatId, '⚠️ 讀取對話失敗：' + e.message.slice(0, 200)); }
    const msgs = (session && Array.isArray(session.messages)) ? session.messages : [];
    if (!msgs.length) return this.sendMessage(chatId, '📍 這本對話還沒有內容。');

    const totalPages = Math.ceil(msgs.length / 3);
    const key = String(chatId);
    let cur = this._backCursor.get(key);
    if (!cur || cur.sessionId !== sessionId) cur = { sessionId, page: 0 };
    const argN = parseInt((argStr || '').trim(), 10);
    let page = !isNaN(argN) ? argN : cur.page + 1;
    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;
    cur.page = page;
    this._backCursor.set(key, cur);

    // page 1 = the most recent 3 messages, page 2 = the 3 before those, etc.
    const endIdx   = msgs.length - (page - 1) * 3;
    const startIdx = Math.max(0, endIdx - 3);
    const lines = msgs.slice(startIdx, endIdx).map(function (m) {
      const who  = m.role === 'user' ? '指揮官' : 'Hana';
      const text = (typeof m.content === 'string' ? m.content : '').replace(/\s+/g, ' ').slice(0, 200);
      return '• ' + who + '：' + text + (text.length >= 200 ? '…' : '');
    });
    const reply = '⏪ 第 ' + page + '/' + totalPages + ' 頁（共 ' + msgs.length + ' 則）：\n' + lines.join('\n')
      + (page < totalPages ? '\n\n用 /back 繼續往前翻' : '\n\n（已到最早）');
    return this.sendMessage(chatId, reply.slice(0, 3500));
  }

  // ── TGC8-05: /recap — condense the whole active session into one summary ──────────────────
  async _cmdRecap(chatId) {
    const ctx = this.getContext(chatId);
    const workspaceRoot = (ctx && ctx.root) || this._harnessHome;
    const sessionId = this.getActiveSessionId(chatId, workspaceRoot);
    if (!sessionId) return this.sendMessage(chatId, '📍 目前沒有作用中的對話可濃縮。');
    if (!this._recapSessionFn) return this.sendMessage(chatId, '⚠️ 濃縮摘要功能未設定。');
    await this.sendMessage(chatId, '🧠 濃縮中...');
    try {
      const summary = await this._recapSessionFn(workspaceRoot, sessionId);
      const safe = String(summary || '（沒有可濃縮的內容）').slice(0, 3500);
      this._logConsole({ role: 'bot', chatId, text: '[recap] ' + safe.slice(0, 200) });
      return this.sendMessage(chatId, '🧾 對話濃縮：\n' + safe);
    } catch (e) {
      return this.sendMessage(chatId, '⚠️ 濃縮失敗：' + String(e.message).slice(0, 200));
    }
  }

  // ── Chat + C4 intent routing ──────────────────────────────────────────────

  async _chat(chatId, text) {
    // C4: classify — mutating task → confirm flow; otherwise → direct chat
    if (looksLikeTask(text)) return this._confirmTask(chatId, text);

    if (!this._chatFn) {
      const reply = '（chatFn 未設定，無法回覆）';
      this._logConsole({ role: 'bot', chatId, text: reply });
      return this.sendMessage(chatId, reply);
    }
    try {
      // TGC8-02: 自由打字併入網頁對話本 — chatFn 現在載入/接續 chat_<sessionId>.json、走
      // buildChatPrompt 同一套人設/長期記憶/對話歷史外殼，而不是只帶零散的控制台日誌片段。
      // `context`（控制台日誌）與 `chatId` 仍照傳，供 chatFn 內部的相容/除錯路徑使用。
      const context = this.getConsoleLog();
      const { ctx, sessionId } = this._resolveActiveSession(chatId);
      const reply   = await this._chatFn(text, context, ctx, chatId, sessionId);
      const safe    = String(reply || '（無回應）');
      this._logConsole({ role: 'bot', chatId, text: safe });
      return this.sendMessage(chatId, safe);
    } catch (e) {
      const reply = '⚠️ 聊天回覆失敗：' + String(e.message).slice(0, 200);
      this._logConsole({ role: 'bot', chatId, text: reply });
      return this.sendMessage(chatId, reply);
    }
  }

  // C4: ask for confirmation before executing a mutating task
  async _confirmTask(chatId, text) {
    let ctx = this.getContext(chatId);

    // No sticky context — try to infer workspace from text, then ask
    if (!ctx) {
      const inferred = this._inferWorkspace(text);
      if (!inferred) {
        this._logConsole({ role: 'bot', chatId, text: '[需先選工作區]' });
        await this._showProjectPicker(chatId, '這個任務需要知道目標工作區，請選擇：');
        await this.sendMessage(chatId, '選好工作區後，請重新發送您的指令。');
        return;
      }
      this.setContext(chatId, inferred.root, inferred.label);
      ctx = this.getContext(chatId);
    }

    const key = 'task_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    // TGC8-03: carry the workspace's active chat session id through to _executeTask so the task
    // prompt's front-context comes from the same conversation as free chat (session cursor is
    // read-only here — a task never creates a new session, it just borrows whichever is active).
    const sessionId = this.getActiveSessionId(chatId, ctx.root);
    this._pendingConfirms.set(key, { chatId, text, workspaceRoot: ctx.root, label: ctx.label, ts: Date.now(), sessionId });

    // Evict confirms older than 5 minutes
    const now = Date.now();
    for (const [k, v] of this._pendingConfirms) {
      if (now - v.ts > 300000) this._pendingConfirms.delete(k);
    }

    const prompt = '📋 準備在「' + ctx.label + '」執行：\n\n' + text.slice(0, 500) + '\n\n確認？';
    this._logConsole({ role: 'bot', chatId, text: prompt });
    return this.sendInlineKeyboard(chatId, prompt, [
      { text: '✅ 確認執行', callback_data: 'confirm:' + key },
      { text: '❌ 取消',     callback_data: 'cancel:'  + key },
    ]);
  }

  // C4: infer workspace from project name mentioned in text
  _inferWorkspace(text) {
    const projects = this._listProjectsFn ? this._listProjectsFn() : [];
    const lower = text.toLowerCase();
    for (var i = 0; i < projects.length; i++) {
      const p    = projects[i];
      const name = (p.name || path.basename(p.root || '')).toLowerCase();
      if (name && lower.includes(name)) return { root: p.root, label: p.name || path.basename(p.root) };
    }
    return null;
  }

  // C3: trusted inbound from web portal console (no auth check — web = local = you)
  async handleWebMessage(text) {
    const chatId = this._authorizedChatIds.size > 0 ? [...this._authorizedChatIds][0] : 0;
    this._logConsole({ role: 'user', source: 'web', chatId: chatId || 'web', text });
    try {
      await this._route(chatId, text);
    } catch (e) {
      const reply = '⚠️ 處理時發生錯誤：' + String(e.message).slice(0, 200);
      this._logConsole({ role: 'bot', chatId: chatId || 'web', text: reply });
    }
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

function createTelegramBot(harnessHome, schedulerManager, opts) {
  return new TelegramBot(harnessHome, schedulerManager, opts);
}

module.exports = { createTelegramBot, TelegramBot };

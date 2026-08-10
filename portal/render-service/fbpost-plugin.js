'use strict';
// ── Private plugin: daily-reflection Facebook post approval flow ────────────────
// PRIVATE — export-ignore (see specs/SPEC-fbpost-privatization.md). This file bundles
// ALL Facebook-specific code that used to live inline in server.js and telegram.js.
// The public edition ships without this file, so the generic extension points in
// server.js / telegram.js stay empty and the feature simply doesn't exist there.
//
// Architecture (SPEC-daily-reflection-post §6, approach 2): a scheduled agent generates
// a draft and hands it to the always-on server via POST /api/telegram/fbpost-draft, which
// registers a pending item + sends four buttons (✅ 同意 / ❌ 放棄 / 🔁 重來 / ✏️ 修改).
// Approval/edit/redo/discard are handled here by the long-running server, decoupled from
// the (already-finished) scheduling CLI process.
//
// register({ server, bot, HARNESS_HOME, spawn }):
//   server.extraRoutes         — array; we push a route handler for /api/telegram/fbpost-draft
//   bot._extraCallbackHandlers  — array; we push the fbpost_* inline-button handler
//   bot._extraTextInterceptors  — array; we push the "awaiting edit note" text interceptor
//   HARNESS_HOME                — shared data home (for secrets / material aggregation)
//   spawn(prompt, cwd, timeout) — the Claude-spawn helper (server's _tgSpawnClaude)

function register({ server, bot, HARNESS_HOME, spawn }) {
  if (!server || !Array.isArray(server.extraRoutes)) throw new Error('fbpost-plugin: server.extraRoutes required');
  if (!bot || !Array.isArray(bot._extraCallbackHandlers) || !Array.isArray(bot._extraTextInterceptors)) {
    throw new Error('fbpost-plugin: bot extension points required');
  }
  if (typeof spawn !== 'function') throw new Error('fbpost-plugin: spawn function required');

  // ── Plugin-local state (was telegramBot._pendingFbDrafts / _awaitingEditFor) ──
  const pendingDrafts   = new Map();  // key -> { chatId, draftText, sourceSummary, ts, expiresAt }
  const awaitingEditFor = new Map();  // String(chatId) -> pending draft key awaiting an edit note

  // ── Generation / posting (was server.js fbGenerateFn / fbPostFn) ──────────────
  // Lazy require so the private render-service modules are only touched when the flow runs.
  function generateDraft(opts) {
    const { aggregateDailyActivity, formatMaterial } = require('./daily-activity.js');
    const { buildReflectionPrompt, extractDraft }    = require('./reflection-prompt.js');
    const agg      = aggregateDailyActivity({});
    const material = formatMaterial(agg);
    const prompt   = buildReflectionPrompt(material, opts || {});
    return spawn(prompt, HARNESS_HOME, 180000).then(function (output) {
      return { draftText: extractDraft(output), sourceSummary: material.slice(0, 300) };
    });
  }
  function postDraft(draftText) {
    const { postToFacebook } = require('./facebook-post');
    return postToFacebook(draftText);
  }

  // ── Pending-draft bookkeeping ─────────────────────────────────────────────────
  function evictExpired() {
    const now = Date.now();
    for (const [k, v] of pendingDrafts) {
      if (now >= (v.expiresAt || (v.ts + 300000))) {
        pendingDrafts.delete(k);
        clearAwaitingForKey(k);
      }
    }
  }
  function clearAwaitingForKey(key) {
    for (const [cid, ek] of awaitingEditFor) {
      if (ek === key) awaitingEditFor.delete(cid);
    }
  }

  // Public entry: register a pending draft + send the four approval buttons.
  // ttlMs = how long the buttons stay live (default 5 min ↔ the schedule's max runtime).
  async function sendDraftForApproval(chatId, draftText, sourceSummary, ttlMs) {
    const draft = String(draftText || '').trim();
    if (!draft) { await bot.sendMessage(chatId, '⚠️ 沒有草稿內容可供核可。'); return null; }
    const now       = Date.now();
    const key       = 'fbpost_' + now + '_' + Math.random().toString(36).slice(2, 6);
    const expiresAt = now + (ttlMs && ttlMs > 0 ? ttlMs : 300000);   // default 5 min
    pendingDrafts.set(key, { chatId, draftText: draft, sourceSummary: sourceSummary || '', ts: now, expiresAt });
    evictExpired();
    const prompt = '📝 今日心得草稿：\n\n' + draft + '\n\n要貼到 Facebook 嗎？';
    bot._logConsole({ role: 'bot', chatId, text: prompt });
    await bot.sendInlineRows(chatId, prompt, [
      [{ text: '✅ 同意', callback_data: 'fbpost_approve:' + key },
       { text: '❌ 放棄', callback_data: 'fbpost_discard:' + key }],
      [{ text: '🔁 重來', callback_data: 'fbpost_redo:' + key },
       { text: '✏️ 修改', callback_data: 'fbpost_edit:' + key }],
    ]);
    return key;
  }

  // ✅ 同意 → post the approved draft to Facebook
  async function approve(chatId, key) {
    evictExpired();
    const pending = pendingDrafts.get(key);
    if (!pending) { await bot.sendMessage(chatId, '⚠️ 這則草稿已逾時或找不到，本次不貼文。'); return; }
    pendingDrafts.delete(key);
    clearAwaitingForKey(key);
    await bot.sendMessage(chatId, '⏳ 正在貼到 Facebook...');
    try {
      const result = await postDraft(pending.draftText);
      if (result && result.ok) {
        await bot.sendMessage(chatId, '✅ 已貼出到 Facebook。' + (result.url ? '\n' + result.url : ''));
      } else {
        await bot.sendMessage(chatId, '❌ 發文失敗：' + String((result && result.error) || '未知錯誤').slice(0, 300));
      }
    } catch (e) {
      await bot.sendMessage(chatId, '❌ 發文失敗：' + String(e.message).slice(0, 300));
    }
  }

  // ❌ 放棄 → drop the pending item, end the flow
  async function discard(chatId, key) {
    pendingDrafts.delete(key);
    clearAwaitingForKey(key);
    await bot.sendMessage(chatId, '🗑️ 已放棄，今天不貼文。');
  }

  // 🔁 重來 → regenerate from scratch (no bias from the previous draft)
  async function redo(chatId, key) {
    const pending = pendingDrafts.get(key);
    pendingDrafts.delete(key);
    clearAwaitingForKey(key);
    await bot.sendMessage(chatId, '🔁 重新想一篇（同一天的素材，換個寫法）...');
    try {
      const gen = await generateDraft({});   // fresh: no editInstruction/previousDraft
      if (!gen || !gen.draftText) { await bot.sendMessage(chatId, '⚠️ 重新生成沒有拿到草稿。'); return; }
      const ttlMs = pending ? (pending.expiresAt - pending.ts) : undefined;   // preserve the approval window
      await sendDraftForApproval(chatId, gen.draftText, gen.sourceSummary, ttlMs);
    } catch (e) {
      await bot.sendMessage(chatId, '⚠️ 重新生成失敗：' + String(e.message).slice(0, 200));
    }
  }

  // ✏️ 修改 → ask for an edit note; the next plain-text message becomes the instruction
  async function edit(chatId, key) {
    evictExpired();
    const pending = pendingDrafts.get(key);
    if (!pending) { await bot.sendMessage(chatId, '⚠️ 這則草稿已逾時或找不到，無法修改。'); return; }
    awaitingEditFor.set(String(chatId), key);
    await bot.sendMessage(chatId, '✏️ 請說要改什麼（直接傳一則文字訊息給我；傳 / 開頭的指令則取消修改）。');
  }

  // Consume the edit note: regenerate with the previous draft + the instruction.
  async function applyEdit(chatId, editInstruction) {
    const key = awaitingEditFor.get(String(chatId));
    awaitingEditFor.delete(String(chatId));
    evictExpired();
    const pending = key && pendingDrafts.get(key);
    if (!pending) { await bot.sendMessage(chatId, '⚠️ 原草稿已逾時或找不到，請重新觸發本次任務。'); return; }
    pendingDrafts.delete(key);
    await bot.sendMessage(chatId, '✏️ 依你的意見重新改寫中...');
    try {
      const gen = await generateDraft({ editInstruction, previousDraft: pending.draftText });
      if (!gen || !gen.draftText) { await bot.sendMessage(chatId, '⚠️ 改寫後沒有拿到草稿。'); return; }
      const ttlMs = pending.expiresAt - pending.ts;   // preserve the approval window length
      await sendDraftForApproval(chatId, gen.draftText, gen.sourceSummary, ttlMs);
    } catch (e) {
      await bot.sendMessage(chatId, '⚠️ 改寫失敗：' + String(e.message).slice(0, 200));
    }
  }

  // ── Register into the generic extension points ────────────────────────────────

  // Inline-button callbacks: claim the four fbpost_* actions, decline everything else.
  bot._extraCallbackHandlers.push(async function (data, chatId, _bot) {
    if (data.startsWith('fbpost_approve:')) { await approve(chatId, data.slice('fbpost_approve:'.length)); return true; }
    if (data.startsWith('fbpost_discard:')) { await discard(chatId, data.slice('fbpost_discard:'.length)); return true; }
    if (data.startsWith('fbpost_redo:'))    { await redo(chatId,    data.slice('fbpost_redo:'.length));    return true; }
    if (data.startsWith('fbpost_edit:'))    { await edit(chatId,    data.slice('fbpost_edit:'.length));    return true; }
    return false;
  });

  // Plain-text interceptor: if this chat is awaiting an edit note, consume the message as
  // the edit instruction (a slash command escapes edit mode and falls through to routing).
  bot._extraTextInterceptors.push(async function (chatId, text, _bot) {
    const cid = String(chatId);
    if (awaitingEditFor.has(cid) && !text.startsWith('/')) {
      try { await applyEdit(chatId, text); }
      catch (e) {
        console.error('[fbpost] edit error:', e.message);
        await bot.sendMessage(chatId, '⚠️ 修改時發生錯誤：' + String(e.message).slice(0, 200));
      }
      return true;   // claimed
    }
    if (awaitingEditFor.has(cid) && text.startsWith('/')) {
      awaitingEditFor.delete(cid);   // escape hatch: bail out of edit mode, let routing proceed
    }
    return false;
  });

  // HTTP route: POST /api/telegram/fbpost-draft — entry point for the daily reflection-post
  // schedule (a standalone CLI process that ends once its prompt replies) to hand off to the
  // long-running server's four-button approval flow, which survives the CLI exiting.
  server.extraRoutes.push(function (req, res, pathname, _parsedUrl) {
    if (pathname !== '/api/telegram/fbpost-draft' || req.method !== 'POST') return false;
    let body = '';
    req.on('data', function (d) { body += d; });
    req.on('end', function () {
      (async () => {
        try {
          const opts   = body ? JSON.parse(body) : {};
          const chatId = bot.getPrimaryChatId();
          if (chatId === null) { res.writeHead(409); res.end('{"error":"no bound telegram chat"}'); return; }
          const gen = await generateDraft({});
          if (!gen || !gen.draftText) { res.writeHead(500); res.end('{"error":"generation produced no draft"}'); return; }
          await sendDraftForApproval(chatId, gen.draftText, gen.sourceSummary, opts.ttlMs || 30 * 60 * 1000);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
        }
      })();
    });
    return true;   // claimed
  });
}

module.exports = { register };

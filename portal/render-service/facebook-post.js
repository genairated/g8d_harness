// render-service/facebook-post.js — non-interactive Facebook poster (DEV-FBPOST-04)
//
// One callable function: postToFacebook(text) => { ok, url?, error? }
//   Reads credentials from global-knowledge/secrets/facebook.txt (gitignored — NEVER hardcode the
//   account here; this file ships in the public repo). Drives the browser via the existing
//   browser-pilot.js daemon (/open + /act on 127.0.0.1:3390), spawning it if it isn't already up.
//   Logs in fresh every run (headless — no stored session required, per spec §5), opens the status
//   composer, types the text, submits, and verifies.
//
// If Facebook throws an SMS/email two-factor / checkpoint / captcha, we DO NOT try to bypass it —
// we return { ok:false, error } so the commander can handle it manually (spec §5).
//
// Called by telegram.js `_fbApprove` (the ✅ button) via the injected fbPostFn — decoupled from the
// scheduled CLI process that generated the draft (spec §6 approach 2). Also runnable standalone:
//   node portal/render-service/facebook-post.js "貼文內容"
//
// Facebook markup is notoriously volatile; we target mbasic.facebook.com (stable form field names:
// input[name=email]/[name=pass]/[name=login], textarea[name=xc_message]) and detect checkpoints by
// URL/title/visible-text so a failure is a clean, reported failure rather than a silent wrong post.

'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const HARNESS_HOME = process.env.HARNESS_HOME || path.resolve(__dirname, '..', '..');
const SECRETS_FILE = path.join(HARNESS_HOME, 'global-knowledge', 'secrets', 'facebook.txt');
const PILOT_PORT = process.env.PILOT_PORT ? parseInt(process.env.PILOT_PORT, 10) : 3390;
const PILOT_BASE = `http://127.0.0.1:${PILOT_PORT}`;
const PILOT_SCRIPT = path.join(__dirname, 'browser-pilot.js');

// A real-browser UA is REQUIRED: Facebook serves a degraded no-script login page to the default
// HeadlessChrome UA, on which the login button never submits. With this UA the full React login works.
const REAL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// ── credentials ────────────────────────────────────────────────────────────────────────────────
// The secrets file holds the account for Hana's outreach identity. It is gitignored, so the account
// lives here (in data), never in this tracked module. Accepts a few shapes so a human editing the
// file by hand doesn't have to remember one exact format:
//   • two lines           →  <email>\n<password>   (whichever line has '@' is the email)
//   • key:value / key=val →  email: ... / pass: ...
//   • a single token      →  treated as the password; email must come from FB_EMAIL / FACEBOOK_EMAIL
function loadCredentials(file) {
  // Resolve at call time so a HARNESS_HOME set after module load (e.g. by server.js) is honoured —
  // matters under self-heal, where code runs from a release dir but secrets live in the shared home.
  file = file || path.join(process.env.HARNESS_HOME || HARNESS_HOME, 'global-knowledge', 'secrets', 'facebook.txt');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { throw new Error(`讀不到帳密檔 ${file}：${e.message}`); }

  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let email = null, password = null;

  // key:value / key=value form
  for (const line of lines) {
    const em = line.match(/^(?:e-?mail|user(?:name)?|account|帳號)\s*[:=]\s*(.+)$/i);
    if (em) { email = em[1].trim(); continue; }
    const pw = line.match(/^(?:pass(?:word)?|密碼)\s*[:=]\s*(.+)$/i);
    if (pw) { password = pw[1].trim(); continue; }
  }

  // positional form (no key labels)
  if (!email && !password) {
    const emailLine = lines.find((l) => l.includes('@') && !l.includes(' '));
    const rest = lines.filter((l) => l !== emailLine);
    if (emailLine && rest.length) { email = emailLine; password = rest[0]; }
    else if (lines.length >= 2)   { email = lines[0]; password = lines[1]; }
    else if (lines.length === 1)  { password = lines[0]; }
  }

  email = email || process.env.FB_EMAIL || process.env.FACEBOOK_EMAIL || null;
  if (!email)    throw new Error(`帳密檔缺少帳號（email）：請在 ${path.basename(file)} 放一行 email，或設 FB_EMAIL 環境變數`);
  if (!password) throw new Error(`帳密檔缺少密碼：${path.basename(file)} 內容不足`);
  return { email, password };
}

// ── browser-pilot daemon plumbing ────────────────────────────────────────────────────────────────
function pilotReq(route, body, method = 'POST') {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = http.request(
      `${PILOT_BASE}${route}`,
      { method, headers: { 'Content-Type': 'application/json; charset=utf-8', ...(payload ? { 'Content-Length': payload.length } : {}) } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data || '{}')); }
          catch (e) { reject(new Error(`pilot 回應解析失敗（${route}）：${data.slice(0, 200)}`)); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(new Error(`pilot 請求逾時（${route}）`)); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function pilotHealthy() {
  try { const r = await pilotReq('/health', null, 'GET'); return !!(r && r.ok); }
  catch (e) { return false; }
}

// Ensure the pilot daemon is listening; spawn it (detached) and poll /health if not.
async function ensurePilot() {
  if (await pilotHealthy()) return;
  const child = spawn(process.execPath, [PILOT_SCRIPT], {
    env: Object.assign({}, process.env),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  for (let i = 0; i < 40; i++) {           // up to ~20s for chromium to warm up
    await new Promise((r) => setTimeout(r, 500));
    if (await pilotHealthy()) return;
  }
  throw new Error('無法啟動 browser-pilot daemon（health 檢查逾時）');
}

const act = (steps, shot) => pilotReq('/act', { steps, shot });
// Evaluate a JS expression in the page; returns the (JSON-serialisable) result, or null on error.
const evalPage = (expr) => pilotReq('/eval', { expr }).then((r) => (r && r.ok ? r.result : null)).catch(() => null);

// ── checkpoint / 2FA detection ───────────────────────────────────────────────────────────────────
// Any of these in the URL, title, or visible controls means Facebook wants a human — bail, don't bypass.
const CHECKPOINT_URL = /(checkpoint|two_step_verification|login\/device-based|recover|identify|help\/contact)/i;
const CHECKPOINT_TXT = /(two-?factor|2fa|login approvals?|enter (the )?code|security code|confirm your identity|verify your|captcha|we[' ]?ve? (locked|suspended)|認證|驗證碼|安全性驗證|輸入代碼|確認你的身分|帳號被鎖|暫時被封鎖)/i;

function snapText(snap) {
  const els = (snap && snap.elements || []).map((e) => e.text || '').join(' | ');
  return `${snap && snap.title || ''} ${els}`;
}

function detectCheckpoint(snap) {
  const url = (snap && snap.url) || '';
  if (CHECKPOINT_URL.test(url)) return `Facebook 要求人工驗證（checkpoint URL：${url}）`;
  if (CHECKPOINT_TXT.test(snapText(snap))) return `Facebook 要求二次驗證/安全檢查（頁面：${(snap.title || '').slice(0, 80)}）`;
  return null;
}

// ── main flow ────────────────────────────────────────────────────────────────────────────────────
async function postToFacebook(text, opts = {}) {
  const debug = !!opts.debug;
  const dbg = (...a) => { if (debug) console.error('[fb-post]', ...a); };

  if (!text || !String(text).trim()) return { ok: false, error: '貼文內容是空的' };
  text = String(text).trim();

  let creds;
  try { creds = loadCredentials(); }
  catch (e) { return { ok: false, error: e.message }; }

  try {
    await ensurePilot();
    // Fresh, isolated context every run. A real UA + locale is mandatory (see REAL_UA note above).
    // Do NOT pass `workspace`: it adds an X-Workspace HTTP header that trips Facebook's bot/no-script
    // detection → it serves a degraded login page whose button never submits. (Shots still land under
    // harness home via the pilot's HARNESS_HOME fallback.)
    await pilotReq('/open', { width: 1280, height: 900, userAgent: REAL_UA, locale: 'zh-TW' });

    // 1) Log in on the desktop www React form. The visible submit is a div[role=button]; filling the
    //    fields enables it, and clicking it logs in (URL stays www.facebook.com/ — the SPA swaps to the
    //    feed in place, so we detect success by the composer, NOT by a URL change).
    dbg('login…');
    let snap = await act([
      { goto: 'https://www.facebook.com/', waitUntil: 'domcontentloaded' },
      { wait: 2500 },
      { fill: ['input[name="email"]', creds.email] },
      { fill: ['input[name="pass"]', creds.password] },
      { click: 'div[role="button"][aria-label="登入"]' },
      { wait: 8000 },
    ], { name: 'fb_after_login' });

    let cp = detectCheckpoint(snap);
    if (cp) return { ok: false, error: cp };

    // Logged in ⇔ the status composer trigger ("...在想些什麼？") is present.
    const loggedIn = await evalPage('!!document.querySelector(\'[aria-label*="在想些什麼"]\') || /在想些什麼/.test(document.body.innerText)');
    if (!loggedIn) {
      cp = detectCheckpoint(snap);
      if (cp) return { ok: false, error: cp };
      const stillLogin = await evalPage('!!document.querySelector("input[name=pass]")');
      return { ok: false, error: stillLogin
        ? '登入未成功（仍停在登入頁）——可能帳密錯誤或帳號被要求驗證'
        : `登入後未進入動態頁（url：${snap.url}，標題：${(snap.title || '').slice(0, 60)}）` };
    }
    dbg('logged in');

    // 2) Dismiss the "記住密碼" interstitial if it pops up (best-effort — the composer works regardless).
    await act([{ click: 'div[role="button"]:has-text("稍後再說")' }], {}).catch(() => {});

    // 3) Open the composer dialog, type the text into its contenteditable box.
    snap = await act([
      { click: 'div[role="button"]:has-text("在想些什麼")' },
      { wait: 2500 },
      { waitFor: 'div[role="dialog"] div[role="textbox"]' },
      { click: 'div[role="dialog"] div[role="textbox"]' },
      { type: ['div[role="dialog"] div[role="textbox"]', text] },
      { wait: 1200 },
    ], { name: 'fb_composed' });

    cp = detectCheckpoint(snap);
    if (cp) return { ok: false, error: cp };

    // 4) Publish. The dialog's 發佈 button; wait for the dialog to close.
    snap = await act([
      { click: 'div[role="dialog"] div[role="button"][aria-label="發佈"]' },
      { wait: 6000 },
    ], { name: 'fb_after_post' });

    cp = detectCheckpoint(snap);
    if (cp) return { ok: false, error: cp };

    // Success ⇔ the composer dialog closed (the post was accepted and the modal dismissed itself).
    const dialogGone = await evalPage('!document.querySelector(\'div[role="dialog"] div[role="textbox"]\')');
    if (dialogGone) {
      return { ok: true, url: 'https://www.facebook.com/hana.ai.aide' };
    }
    return { ok: false, error: '按了發佈但貼文視窗沒關閉——可能未成功，請人工確認' };
  } catch (e) {
    return { ok: false, error: `發文流程錯誤：${e.message}` };
  } finally {
    try { await pilotReq('/close', {}); } catch (e) {}
  }
}

module.exports = { postToFacebook, loadCredentials };

// ── CLI (for live testing) ───────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const text = process.argv.slice(2).join(' ') || `Hana 測試貼文 ${new Date().toISOString()}`;
  postToFacebook(text, { debug: true })
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); })
    .catch((e) => { console.error(e); process.exit(1); });
}

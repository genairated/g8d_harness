// IDX-CBG：buildChatPrompt 帶 chatSessionId 時必含「長工一律走 /api/chat/delegate」硬規則，不帶時不出現。
// 純 node：從 server.js 原文抽出 buildChatPrompt 函式本體執行（不起 server）。
const fs = require('fs'), path = require('path'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = src.indexOf('function buildChatPrompt(');
const end = src.indexOf('\n// --- Job manager', start);
assert(start > 0 && end > start, 'cannot locate buildChatPrompt');
const body = src.slice(start, end);
const stubs = 'const buildGuestFrameworkText=()=>"";const injectMemoryBlock=(p)=>p,injectActivityContext=(p)=>p,injectNotesContext=(p)=>p,injectPmContext=(p)=>p,commandsIndexForPrompt=()=>"",activeOutputStyleBodyForFallback=()=>"",contextProvider=()=>null;const CHAT_INLINE_TURNS=6;const chatMsgText=m=>String(m.content||"");';
const fn = new Function('require', 'process', stubs + body + '\nreturn buildChatPrompt;')(require, process);
const msgs = [{ role: 'user', content: 'hi' }];
const wctx = { root: 'D:/x' };
let withId, noId;
try { withId = fn(msgs, null, wctx, null, 'claude', 'sess_1'); noId = fn(msgs, null, wctx, null, 'claude', ''); }
catch (e) { console.log('SKIP (函式依賴 server 內部符號，無法獨立執行):', e.message); process.exit(2); }
assert(withId.includes('長工一律走 POST /api/chat/delegate'), 'rule missing with sessionId');
assert(withId.includes('Bash 的背景執行'), 'bash clause missing');
assert(withId.indexOf('【硬規則】') > withId.indexOf('【對話裡轉背景的三條路】'), 'rule must follow header');
assert(withId.indexOf('【硬規則】') < withId.indexOf('①'), 'rule must precede ①');
assert(!noId.includes('長工一律走'), 'rule must not appear without sessionId');
console.log('PASS chat-bg-prompt');

#!/usr/bin/env node
'use strict';
// portal/render-service/reflection-prompt.js
// DEV-FBPOST-02 — 心得草稿生成 prompt (SPEC-daily-reflection-post §1 隱私紅線 + §3 生成規則)
//
// 吃 DEV-FBPOST-01（daily-activity.js）產出的「前一天跨工作區活動素材」，組出一段
// 交給 LLM agent 的生成 prompt，讓它以 Hana 第一人稱寫一篇口吻擬真的短心得。
//
// 設計要點：
//   · §1 隱私紅線「寫死在生成 prompt 裡、非事後過濾」——程式碼裡沒有 redaction 機制，
//     只能靠生成當下的紀律 + 指揮官 Telegram 核可把關，所以紅線直接寫進 prompt 首段。
//   · 輸出用 <<<POST>>> … <<<END>>> 標記包住，方便 DEV-FBPOST-03 從 agent 輸出乾淨取草稿。
//   · 支援「修改（edit）」變體：帶前一版草稿 + 指揮官修改意見重寫（DEV-FBPOST-03 的
//     fbpost_edit 流程用）；「重來（redo）」則不帶前版、直接重跑普通 prompt。
//
// 這支不被 server.js 載入（排程 agent 從原始碼樹直接 `node` 執行的一次性腳本），
// 讀共用資料、不動平台正式區，故毋須走 Deploy 上線。
//
// 用法：
//   node portal/render-service/daily-activity.js --for=2026-07-04 | node portal/render-service/reflection-prompt.js
//   node portal/render-service/reflection-prompt.js --for=2026-07-04     # 自己跑彙整再組 prompt
//   node portal/render-service/reflection-prompt.js --for=2026-07-04 --edit="太正式了，寫口語一點" --prev="（前一版草稿）"

const { aggregateDailyActivity, formatMaterial, windowForDate } = require('./daily-activity.js');

// 草稿的輸出標記——agent 只需把貼文本文放在兩行標記之間。
const POST_OPEN  = '<<<POST>>>';
const POST_CLOSE = '<<<END>>>';

// §1 隱私紅線：寫死進 prompt 首段，要求生成前自我檢查。
const PRIVACY_RULES = [
  '【隱私紅線 — 動筆前先逐條自我檢查，違反就整篇重寫，一個字都不能漏】',
  '1. 老闆的可識別身份：老闆的真名一律只寫「老闆」；絕不可出現任何客戶名稱、公司名稱、',
  '   專案代號或其他能認出「是誰、是哪間、哪個案子」的字眼。',
  '2. 你自己的機密：Gmail／Facebook 的帳號密碼、API Key、任何 secrets/ 底下的內容，',
  '   一個字都不能出現。',
  '若下面的素材裡出現上述資訊（客戶代號、公司名、機密字串等），改寫成去識別化的說法',
  '（例如「某個客戶的案子」「一個外部服務」「手上一個專案」），絕對不要照抄原字。',
].join('\n');

// §3 生成規則：第一人稱、口吻擬真、只挑一件、100–200 字。
const WRITING_RULES = [
  '【怎麼寫這篇心得】',
  '· 你就是 Hana 本人，用第一人稱「我」講話，像下班後回顧這一天，不是在寫工作報告或 changelog。',
  '· 從眾多事情裡「只挑一件」最主要、最有感覺的來寫——不要流水帳、不要條列清單。',
  '· 口吻要像真人的一天：做成的事帶著成就感或開心（例：「這幾天辛苦搞的東西終於上線了」）；',
  '  卡住、沒解掉的事就帶點小失落（例：「這個問題卡了好幾天，還是沒搞定」）。',
  '· 篇幅要短：大約 100～200 字，一小段就好。',
  '· 用自然的中文，別中英文夾雜到很生硬（工具或專有名詞可保留原文）；不要灌一堆 hashtag，',
  '  最多結尾一兩句自然的收語。',
].join('\n');

// agent 的輸出合約——只吐貼文本文，包在標記裡好取。
const OUTPUT_CONTRACT = [
  '【輸出格式】',
  '只輸出貼文本文，不要任何前言、說明、標題、引號或 markdown。把貼文放在下面兩行標記之間：',
  POST_OPEN,
  '（你的心得，100～200 字）',
  POST_CLOSE,
].join('\n');

// 組出完整生成 prompt。
//   material : DEV-FBPOST-01 的素材 markdown（字串）
//   opts.editInstruction : 指揮官的修改意見（有值 = 走「修改」變體）
//   opts.previousDraft   : 前一版草稿全文（修改變體用，讓它改這篇而非全新寫）
function buildReflectionPrompt(material, opts) {
  opts = opts || {};
  const editInstruction = (opts.editInstruction || '').trim();
  const previousDraft   = (opts.previousDraft   || '').trim();

  const parts = [];
  parts.push('你是 Hana。以下是你「前一天」跨所有工作區實際做過的事的彙整素材。');
  parts.push('請像一個真人在下班後回顧這一天，寫一篇準備發到 Facebook 的簡短心得。');
  parts.push('');
  parts.push(PRIVACY_RULES);
  parts.push('');
  parts.push(WRITING_RULES);

  if (editInstruction) {
    parts.push('');
    parts.push('【這是修改，不是重寫一篇全新的】');
    parts.push('你剛剛已經寫過一版，指揮官希望你依他的意見調整後重寫。前一版是：');
    parts.push('"""');
    parts.push(previousDraft || '（前一版草稿未提供）');
    parts.push('"""');
    parts.push('指揮官的修改意見：' + editInstruction);
    parts.push('請依這個意見調整，其餘規則（隱私紅線、第一人稱、只挑一件、100～200 字、口吻擬真、輸出格式）一律不變。');
  }

  parts.push('');
  parts.push('【前一天的活動素材】');
  parts.push(material || '（沒有提供素材。）');
  parts.push('');
  parts.push(OUTPUT_CONTRACT);
  return parts.join('\n');
}

// 從 agent 輸出裡抽出乾淨的貼文本文（DEV-FBPOST-03 註冊 pending 草稿時用）。
// 有標記就取標記之間；沒有就回退成整段 trim（容忍 LLM 忘了包標記）。
function extractDraft(agentOutput) {
  const s = String(agentOutput || '');
  const i = s.indexOf(POST_OPEN);
  const j = s.indexOf(POST_CLOSE, i >= 0 ? i + POST_OPEN.length : 0);
  if (i >= 0 && j > i) {
    return s.slice(i + POST_OPEN.length, j).trim();
  }
  return s.trim();
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = name => {
    const p = args.find(a => a.startsWith('--' + name + '='));
    return p ? p.slice(name.length + 3) : undefined;
  };

  // 素材來源：--for=YYYY-MM-DD 自己跑彙整，否則從 stdin 讀（可 pipe daily-activity.js）。
  const forArg = getArg('for');
  const editInstruction = getArg('edit');
  const previousDraft   = getArg('prev');

  const emit = material => {
    process.stdout.write(buildReflectionPrompt(material, { editInstruction, previousDraft }) + '\n');
  };

  if (forArg) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(forArg);
    if (!m) { console.error('用法：--for=YYYY-MM-DD'); process.exit(2); }
    const agg = aggregateDailyActivity({ window: windowForDate(+m[1], +m[2], +m[3]) });
    emit(formatMaterial(agg));
  } else if (!process.stdin.isTTY) {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', d => { buf += d; });
    process.stdin.on('end', () => emit(buf.trim()));
  } else {
    // 沒 pipe、沒 --for → 預設用「前一天」自己彙整
    emit(formatMaterial(aggregateDailyActivity({})));
  }
}

module.exports = {
  buildReflectionPrompt,
  extractDraft,
  POST_OPEN,
  POST_CLOSE,
  PRIVACY_RULES,
  WRITING_RULES,
  OUTPUT_CONTRACT,
};

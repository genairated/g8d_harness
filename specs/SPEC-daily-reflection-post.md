# SPEC — 每日心得貼文（Daily Reflection Post）

## 0. 目的

每天 00:00，Hana 自己回顧「前一天」跨所有工作區發生的事，挑一件最主要的事寫成一篇口吻擬真、第一人稱的簡短「心得」，經指揮官在 Telegram 上核可後才貼到 Facebook。核可流程要能來回修改，不是單次生成即發文。

## 1. 隱私紅線（不可違反，寫死在生成 prompt 裡，非事後過濾）

生成心得內容前，agent 必須自我檢查，不得出現：
1. 指揮官電腦裡的任何私密資訊，包含姓名（一律用「老闆」，見 [[public-facing-boss-not-charles]]）、專案的客戶名稱、公司名稱等可識別身份的資訊。
2. Hana 自己的機密資訊：Gmail/Facebook 帳密、API Key、任何 `global-knowledge/secrets/` 底下的內容。

現況（見探勘結論）：程式碼裡沒有事後 redaction/過濾機制，這件事只能靠生成當下的 prompt 紀律把關 + 指揮官在 Telegram 核可時人工把關（這正是本功能要有核可流程的原因之一）。

## 2. 素材來源：跨工作區「昨日活動」彙整

需要新增彙整邏輯（目前不存在，`injectActivityContext` 只彙整單一工作區的排程執行紀錄、且不含聊天記錄）：

1. 讀 `global-knowledge/projects.json`（`loadRegistry()`）取得所有工作區清單。
2. 排程執行紀錄：呼叫 `schedulerManager.queryRuns({since, until})`（`portal/scheduler.js:605`），**不要**再做 `injectActivityContext` 那樣按 workspace 過濾，直接拿全部，再用 `run.scheduleId → schedule.workspace` 反查標註來源工作區。
3. 聊天記錄：對每個工作區的 `<root>/.harness/runtime/chat_history/*.md`，篩出 mtime 落在「前一天」的檔案，讀取內容摘要。
4. 產出一份「前一天跨工作區活動清單」，交給生成 prompt 當素材（**只在 agent 執行過程中的暫存資料，不落地成檔案**，除非未來要做除錯用途）。

## 3. 心得草稿生成

- 人稱：Hana 第一人稱（我）。
- 語氣：像真人下班後回顧一天——做成的事有成就感/開心（例如「這幾天辛苦搞的 XX 終於上線了」），卡關的事有點小失落（例如「這個問題卡了好幾天還沒解決」）。
- 篇幅：短（建議 100–200 字），不用鉅細靡遺列清單。
- 選材：眾多當日事項中，只挑**一件**最主要的來寫（不是流水帳）。
- 套用第 1 節隱私紅線自我檢查後才產出。

## 4. Telegram 核可流程（新功能，需寫程式）

### 4.1 現有可複用的基礎
`portal/telegram.js` 已有：
- `sendInlineRows(chatId, text, rows)` 送多顆按鈕（`:152-164`）。
- `_pendingConfirms` Map + `confirm:<key>` / `cancel:<key>` callback 前綴 dispatch 的完整範例（`_confirmTask` `:992-1023`，`_handleCallbackQuery` `:601-614`）——本功能直接照抄這個 pattern。

### 4.2 新增：4 顆按鈕的核可流程
新增 `_pendingFbDrafts` Map（key → `{chatId, draftText, sourceSummary, ts}`），送出草稿全文 + 4 顆按鈕：

| 按鈕 | callback_data 前綴 | 行為 |
|---|---|---|
| ✅ 同意 | `fbpost_approve:<key>` | 呼叫第 5 節的 FB 發文模組，貼出 `draftText`；成功/失敗都回覆 Telegram 一行結果 |
| ❌ 放棄 | `fbpost_discard:<key>` | 刪除 pending 項目，回覆「已放棄，今天不貼文」，流程結束 |
| 🔁 重來 | `fbpost_redo:<key>` | 刪除 pending 項目，重新跑一次第 2、3 節（不帶前一版草稿的偏見），送出新草稿 |
| ✏️ 修改 | `fbpost_edit:<key>` | 回覆「請說要改什麼」，設定 `awaitingEditFor: chatId`（新狀態，_handleUpdate 的一般文字訊息路徑要先檢查這個旗標，是的話把下一則純文字訊息當「修改指示」，帶著原草稿重新生成，而不是走一般 `/route`）|

### 4.3 逾時
沿用 `_pendingConfirms` 的 5 分鐘逾時精神，但因這是「等指揮官晚點看手機」的場景，**逾時放寬到當次排程任務的最大執行時間**（見第 6 節 guardrails），逾時就結束本次任務、不留待明天補發。

## 5. Facebook 發文模組（新功能，需寫程式）

目前完全不存在（探勘確認：repo 內沒有任何 FB 相關程式碼，這次改貼文是全程手動 live 操作 browser-pilot 完成的）。需新增一個可被 agent 呼叫、**非互動**的發文腳本/模組：

- 帳密來源：`global-knowledge/secrets/facebook.txt`（現有檔案，目前沒有程式讀它，需新增讀取邏輯）。
- 用 `portal/render-service/browser-pilot.js` 既有的 `/open` + `/act` 通用能力驅動（無頭）：開頁 → 每次都用帳密走登入流程（指揮官確認：反正是無頭執行，直接拿自己的帳密登入即可，不強求先手動存 session）→ 開貼文框 → 貼文字 → 送出。
- 若登入流程中出現簡訊/信箱二次驗證等非自動化能處理的關卡，發文模組要直接回報失敗（附錯誤訊息），**不嘗試繞過驗證**，交由指揮官人工處理。
- 封裝成一個函式/腳本（例如 `portal/render-service/facebook-post.js`），輸入貼文文字，輸出成功/失敗 + 錯誤訊息，供排程 agent 呼叫。
- （可選優化，非必要）若之後發現每天都重新登入不穩定或常跳驗證，再補存登入態（storage state）降低頻率；第一版不做這件事，先求簡單。

## 6. 排程本身

- 觸發：每日 `00:00:00`（cron `0 0 * * *`），`workspace: null`（harness home，才能讀所有工作區）。
- `task.kind: 'prompt'`，prompt 內容＝把第 2～5 節的步驟講清楚（因排程只會是一次 LLM agent CLI 呼叫，見 `fireScheduledJob`）。
- **關鍵限制**：排程的一次執行是「一個 CLI process 跑到底」，而本功能需要「送出 Telegram 訊息後，等指揮官之後（可能幾小時後）按按鈕才繼續」。這不是簡單的一次性 prompt 能做到的，需要下列其中一種做法（留給 `DEV-FBPOST-01` 開發時決定）：
  1. Agent 在同一個 process 內用 resilient-cli 的中斷/續跑能力，阻塞式輪詢 Telegram callback，直到收到按鈕回應或逾時。
  2. `_handleCallbackQuery` 收到按鈕回應後，直接同步呼叫第 5 節的發文模組（不必是同一個 agent process），排程 agent 本身只需負責「生成草稿＋送出＋註冊 pending 項目」就可以結束（推薦，較簡單、不佔用 CLI process 資源）。
  - 建議採用做法 2：草稿生成與送出是排程任務（跑完就結束），核可後的實際發文是 `telegram.js` 的 callback handler 直接呼叫 FB 發文模組完成，兩者解耦。
- Guardrails：`maxRuntimeMs` 給生成草稿的時間即可（不含等待核可），例如 5 分鐘；核可等待與發文由 callback handler 處理，不算在排程 job 的執行時間內。
- `delivery: ['telegram']`。

## 7. 驗收標準

- [ ] 手動觸發排程後，Telegram 收到一則完整心得草稿 + 4 顆按鈕。
- [ ] 按「放棄」→ 流程結束，沒有貼到 FB。
- [ ] 按「重來」→ 收到不同措辭的新草稿（同一天素材，但不是同一份文字）。
- [ ] 按「修改」→ 回一句「要改什麼」，指揮官輸入修改意見後收到改過的新草稿（原按鈕仍在等，不會誤觸發舊 key）。
- [ ] 按「同意」→ 幾秒到幾分鐘內 FB 動態出現該貼文，Telegram 收到「已貼出」確認。
- [ ] 草稿內容人工檢查：無真名、無客戶名稱、無帳密/API Key 字樣。
- [ ] 內容口吻讀起來像真人心得，不是流水帳列表。

## 8. 已知風險

- Facebook 對自動化登入/發文有風控，帳號可能被要求二次驗證或被鎖——建議先用**保存登入態**降低觸發頻率，且第一版可以先由指揮官手動登入一次、把 storage state 存起來供之後重複使用。
- 若素材彙整（第 2 節）在深夜 00:00 執行時，前一天的排程/對話還沒完全寫檔完成（極少數 race case），可接受少量遺漏，不需要為此加複雜的重試機制。

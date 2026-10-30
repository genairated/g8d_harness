# SPEC — Telegram 全域指揮控制台（Command & Control）

> Status: DRAFT for discussion ｜ Owner: 老闆 + Hana ｜ 影響範圍：`portal/server.js`（長輪詢 loop + 意圖路由 + telegram sink + 控制台日誌）、`portal/index.html`（控制台鏡像檢視）、`HARNESS_HOME`（token 機密、綁定、控制台日誌）
> **相依**：`SPEC-scheduler.md` 的 `SCHED-08`（delivery sink 抽象，已於 B3/v44 完成 → `register('telegram', fn)` 即可插入）。
> **本版重新定位（取代舊版「Telegram = 另一個聊天前端」）**：Telegram = **單一、全域的指揮控制台 / 收件匣 / 路由器**，不是會累積上下文的聊天串。

---

## 1. 定位：全域控制台，不是聊天分頁

一條 Telegram 串 = 你的隨身**指揮控制台**：
- **單一對話**（手機好控制，不用切畫面）。
- **全域**：能讀／控**所有 workspace 的所有對話與排程任務**。
- **Hana 當 orchestrator**：理解你要什麼 → 定位標的 → 動手前確認 → 派工 → **逐一回報**。你不必自己切專案。

> 一句話：你在這條串下令、收回報；真正的工作分散在各 workspace 執行；Telegram 把它們統一收攏。

---

## 2. 核心原則（為什麼這樣設計）

1. **執行者 / 觀看者分離**（沿用 scheduler）：執行在 24h 常駐 server；Telegram 與網頁都只是控制/觀看端。
2. **控制台串 ≠ 模型上下文**（關鍵，解決 token 膨脹）：
   - 意圖分類只看「**近期控制台片段 + 這則訊息**」（便宜）。
   - 真正的工作以 **job 派進「標的 workspace 自己的脈絡」**執行——那個 job 的 token 成本是**標的的上下文，跟控制台日誌多長無關**。
   - 所以控制台可以很長（它是日誌），但每條指令的 token 不會跟著爆。
3. **先理解 → 再定位 → 動手前確認**：不要求你預先標注專案；Hana 從理解請求才推出「去哪做」。

---

## 3. 每則 Telegram 訊息的生命週期

```
訊息進來
 └ Hana 判斷意圖（只用近期控制台片段，便宜）
    ├ 純聊天 / 問答 ──────────────► 直接回答（不碰檔案、不需 workspace）
    ├ 唯讀查詢（status / 今天做了什麼 / 某專案進度 / 看某檔）► 讀資料回答
    └ 任務（要改檔 / 跑東西 / 部署）
         ├ 決定標的 workspace：
         │   ① 沿用「目前脈絡」(sticky)  →  ② 從內容推斷（提到專案名/明顯歸屬）
         │   →  ③ 仍不確定 → 用 inline 按鈕反問「哪個專案？」（不猜就動手）
         ├ 動手前回報：「我要在〈專案A〉做〈X〉，確認？」＋ inline [確認] 按鈕
         └ 你按確認 → 派 job 進該 workspace 脈絡執行 → 完成後回報
```

---

## 4. Sticky「目前脈絡」（游標）

- 控制台持一個 **目前標的**（workspace + 可選的對話）。後續訊息**預設沿用**——你不用每句報專案。
- 明確切換或明顯換主題才變更。控制台與**網頁都顯示**「目前脈絡：專案 A」，你永遠知道在哪。
- 指令：`/here`（顯示目前脈絡）、`/use <project>`（切換）。

---

## 5. 意圖分類與安全梯度

| 類型 | 行為 | 需確認？ |
|---|---|---|
| 聊天 / 問答 | 直接回答，不碰檔、不需 workspace | ❌ |
| 唯讀查詢（status / today / 看檔 / 進度） | 讀資料回答 | ❌ |
| 寫入 / 執行 / 部署 | 回報「在哪、做什麼」→ inline [確認] → 才動手；沿用全域護欄 | ✅ |

- **這就是控制面**：閒聊自由流動，**只有「會動到東西」的才跳確認**——你絕不會只是聊天就誤觸發改檔。
- （可選）**信任模式**：對低風險動作免確認——**預設關閉**，要明確開啟。

---

## 6. 路由 / 標的解析

- 順序：**sticky 脈絡 → 從內容推斷 → 不確定就 inline 反問**（列出工作區按鈕）。
- **絕不在「會改東西」的任務上猜了就動手**；模糊一律反問。
- 多則訊息：sticky 脈絡 + Hana 理解整段討論 → 你可連發數句把需求講清楚，它們共享脈絡，等意圖清楚且你按確認才派工。

---

## 7. 逐一回報（接 SCHED-08 delivery sink）

- 每個派出去的 job 完成（成功/中斷/限額）→ 透過 B3 的 `SinkManager` 的 **telegram sink** 送一則回報：**標清楚「哪個專案 / 任務 + 結果摘要 + 產出連結/檔案」**。
- 並行的多個 job 各自完成、各自回報（標好來源，避免混淆）。
- 排程任務的完成通知也走同一條 sink → 你「排簡報 → 手機收到」就是這條。

---

## 8. 控制台日誌管理（壓縮 / 刪除 / 清空）

- 控制台串**持久化**於 `HARNESS_HOME`（如 `global-knowledge/telegram/console.json`）。
- **因為它是日誌、真正的工作住在各 workspace** → 修剪它**不會弄丟任何工作**。
- 機制：保留**最近 N 則**做對話延續；**更舊的自動壓縮成摘要**；指令 `/clear` 清空重來、可刪除某些條目。
- 這直接解決「對話越長 → 下一條指令一開始 token 就過大」。

---

## 9. 網頁控制台（雙向，可看可打）

- 控制台串持久化 → portal 一個「**Telegram 控制台**」面板：同一份指令/回報/通知日誌，網頁也看得到。
- **雙向可輸入**：面板有輸入框，你在網頁打字 → server 把文字**餵進「跟 Telegram 訊息同一個 handler」**（以已授權身分）→ 回覆寫進控制台日誌；同時 `sendMessage` **同步到手機 Telegram**。手機打的也會被網頁輪詢到 → **兩端完全同步、互通**。
- 端點：`POST /api/telegram/console/send`（文字 → handler → 寫日誌 → 同步 Telegram）。
- 安全：網頁在本機 portal 後面（= 你本人）→ **網頁輸入天生可信、不需再過白名單**（白名單是給手機端 inbound 用的）。
- 結果：一個全域控制台，**手機 / 網頁皆可下令、內容互通**——等於「你自己的 Telegram 網頁 Chat」，但專屬於跟 Hana 的控制台。

---

## 10. Bot 與機密

- BotFather `/newbot` → 取得 **bot token**；`/setcommands` 註冊指令選單（`/today`、`/use`、`/here`、`/clear`…）。
- **token 是機密**：存 `HARNESS_HOME` 外於 git（`global-knowledge/secrets/telegram.json` 或環境變數），**加 `.gitignore`、絕不入庫、不出現在訊息/log**。

## 11. 連線：長輪詢（不用 webhook）

- 本地優先、無固定公網端點 → **long polling（`getUpdates`）**，offset 持久化（重啟不漏/不重複）。輪詢 loop 跑在 server 內（與 scheduler loop 同類常駐迴圈）。

## 12. 授權與安全（全域控制 ＝ 最高門檻）

- **只認白名單 `chat_id`**（`/bind` 一次性配對，或設定檔手填）；白名單外一律忽略。
- **全域控制台 = 一把開全部的鑰匙** → 授權是最高優先。
- 寫入/發派**需確認** + 沿用 scheduler 護欄（預算 / maxRuntime / 失敗熔斷）；inbound 速率限制；機密不外洩（token、路徑、堆疊不回傳）。

## 13. 訊息格式

- 單則 4096 上限 → 長輸出**分段**；MarkdownV2/HTML 跳脫要統一工具；產出檔用 `sendDocument`；選擇/確認用 **inline keyboard**。

---

## 14. 分階段 C0–C5（每項都小到能單獨完工＋部署＋驗收，耐多次 5h 限額）

- **C0**：本 SPEC 定稿 + BotFather 建 bot + token 機密落地（`.gitignore` + 設定檔）。
- **C1**：**Outbound** telegram sink（接 SCHED-08）+ 最簡綁定（設定檔填 chat_id）。驗收：手動跑一個排程 → 手機收到回報。
- **C2**：**長輪詢 loop + 授權白名單 + `/bind`** ＋ **純聊天回答 + 唯讀查詢指令**（`/today` `/schedules` `/status`）＋ **控制台日誌持久化**。驗收：只有你能對話、陌生 chat 被拒；問它問題會答、查詢正確。
- **C3**：**Sticky 目前脈絡 + 標的解析（sticky→推斷→inline 反問）+ `/use` `/here`** ＋ **網頁「Telegram 控制台」雙向面板（可看可打）**：輸入框 + `POST /api/telegram/console/send`（餵進同一 handler + 寫日誌 + 同步 Telegram）。驗收：能切換/顯示目前脈絡；**網頁能打字下令、與手機互通同步**。
- **C4**：**任務派發** —— 動手前 inline [確認] → 派 job 進標的 workspace 脈絡執行 + 全域護欄（＋可選信任模式開關）。驗收：手機下「在專案 A 做 X」→ 反問/確認 → Hana 在 A 執行並回報。
- **C5**：**控制台日誌管理**（保留近 N、自動壓縮、`/clear`、刪除條目）＋ **產出檔投遞 + 長訊息分段 + 格式跳脫**。驗收：長日誌不致 token 膨脹；簡報匯出能以檔案送達。

> 順序：外送 → 授權+唯讀 → 脈絡+鏡像 → 寫入發派（最強最危險，擺後面 + 確認關）→ 日誌管理+投遞。

---

## 15. 開放問題（實際用過再定）

1. 意圖分類由「每則一次 Hana turn」還是「先用便宜分類器再升級」？（v1 先單次，之後優化）
2. 標的反問的粒度：只問 workspace，還是連「哪個對話」一起問？
3. 壓縮策略：保留幾則？壓縮成摘要由誰做（規則 vs 一次模型呼叫）？
4. 信任模式要不要、預設關還是分級（唯讀免確認、寫入必確認）？
5. token 機密：檔案 vs 環境變數。

> ⚠️ 本設計**一定要實際使用過才知道哪裡可優化**（意圖誤判、反問頻率、確認煩不煩、壓縮時機）——C 做完先用一陣子，再回頭調 §15。

---

## 16. C7 — 對話續接與意圖判斷修正（2026-08-26 Charles 提出）

> **問題（實測 8/25 對話紀錄）**：指揮官反映「用 Telegram 跟 Hana 溝通很難，你幾乎不懂我在說什麼」。根因分析如下，三層疊加。

### 16.1 根因

1. **任務路徑完全沒有前文（主因）**。`portal/server.js` 的 `taskFn`（約 L7087）組 prompt 時只有 `sysprompt + memoryBlock + 「任務：」+ 這一句話`，**不帶任何控制台歷史**；而 `chatFn`（約 L7062）有帶（`context.slice(-5)`）。由於幾乎每句話都被判成任務（見 16.2），實際上多數對話都走在「零前文」那條路上，指代（「我指的是 KB01」「你剛才說…」）必然失敗。
2. **意圖判斷過粗**。`portal/telegram.js` L20–22 的 `looksLikeTask()` 只用單字元正則 `/[改修增刪建部執跑寫更移重複]/`，「你**看**一下 KB01 **跑**完沒有？」因為有「跑」字就被判為任務 → 跳確認框 → 走進零前文路徑。查詢語氣被當成派工。
3. **就算走聊天路徑，前文品質也差**。`chatFn` 只取最近 5 則、每則截斷 300 字；且 `_executeTask()`（`telegram.js` L690）在**寫入**控制台日誌時就先把 Hana 的回覆砍成 300 字，資訊在來源端即已遺失。另外 `getConsoleLog()` 是全域日誌，不分工作區、不分 chat。

### 16.2 決策（Charles 2026-08-26 拍板）

- **D1**：任務路徑必須帶前文。`taskFn` 簽名加上 `context`，與 `chatFn` 共用同一段「近期控制台紀錄」組裝邏輯（抽成共用函式，不各寫一份）。
- **D2**：前文品質拉高——取最近 **12 則**、每則上限 **1000 字**；並且**只取當前脈絡工作區（`ctx.root`）＋同一 chatId** 的紀錄，不再跨專案混。
- **D3**：`_executeTask()` / `_chat()` 寫入控制台日誌時**不再截斷**（截斷只發生在送 Telegram 訊息的顯示層，`sendMessage` 的 3500 字上限維持）。日誌長度改由 §8 的既有壓縮/保留機制控管。
- **D4**：意圖判斷改為「先排除查詢語氣，再看動作詞」——命中查詢型樣式（看一下／查一下／確認一下／為什麼／是不是／有沒有／完成了嗎／狀態／進度／？／嗎）時一律走聊天路徑，不跳確認框。動作詞正則由單字元改為詞組（避免「跑完沒」「看一下」誤判）。維持保守原則：**真正會改檔的仍必須確認**。

### 16.3 不做（明確排除）

- 不引入「用一次模型呼叫做意圖分類」（§15 開放問題 1 仍留待日後），本次只修規則。
- 不做控制台日誌的資料結構遷移（既有 `console.json` 條目維持原格式，`workspace` 欄位缺漏時視為不限定、照舊納入）。

---

## 17. C8 — Telegram 自由對話接上「網頁對話本」（2026-08-26 Charles 提出）

> **問題**：C7 修好了「聽不懂前後文」，但 Telegram 的對話記憶仍住在**控制台流水帳**（`console.json`）裡，跟網頁的對話本（`chat_<sessionId>.json`）完全無關。結果是：手機上講的事，回到電腦看不到；同一個主題被迫講兩次。指揮官因此問「既然都指定工作區了，Telegram 的對話還有必要另外留一套嗎？」

### 17.1 決策（Charles 2026-08-26 拍板）

- **D1｜遙控指令原樣保留**。`/today` `/schedules` `/status` `/use` `/note` `/meeting` … 這些是「問一件事、回一則答案」，不需要對話延續，**完全不動**。C8 只改「自由打字」這一條路。
- **D2｜自由打字改接網頁對話本**。非指令訊息不再只寫 console 流水帳，而是寫進**當前脈絡工作區的一本網頁對話 session**，並走與網頁**同一個 prompt 外殼**（`buildChatPrompt`：人設／長期記憶／對話歷史／技能／使用者原文）。這是**取代，不是並存**——不再有兩套對話記憶。
- **D3｜sticky 對話游標**。每個 `chatId × workspace` 記一個 `activeSessionId`；`/use` 切工作區時對話游標跟著切（各工作區各自記住上次那本）。從未指定過 → **自動建新 session**（`session_<ts>`，`origin:'telegram'`），不要求指揮官先選。
- **D4｜可以像一般 app 一樣選／開對話**。新增 `/chats`（列出目前工作區最近 N 本，附編號可切換）、`/newchat [標題]`（開一本新的）、`/whichchat`（現在接的是哪一本）。
- **D5｜切換時只回「摘要卡」，絕不倒全文**。摘要卡＝標題＋最後更新時間＋最近 3 則各一兩句。回顧另外用 `/back [n]`（往前翻，一次 3 則、每則上限約 200 字）與 `/recap`（把整本講到目前為止濃縮成一段）。**理由**：一本對話動輒數十輪、Hana 回覆又長，全倒會連續刷幾十則訊息洗版，且超過 Telegram 單則長度上限會被硬切。**「Hana 讀得到」與「指揮官螢幕上看得到」是兩件事**——組 prompt 時照樣讀整本，顯示層可以省。
- **D6｜任務路徑的前文改用對話本**。會改檔的訊息維持既有確認框（安全梯度不變），但送進 `taskFn` 的前文由「控制台日誌」改為「該 session 的對話歷史」，與聊天路徑同源。
- **D7｜控制台日誌降級**。`console.json` 保留，但角色改為**系統通知的落點**（排程完成回報、指令輸出、錯誤通知），不再是指揮官對話記憶的來源。§8 的壓縮/刪除機制照舊。

### 17.2 為什麼不衝突（回答「Telegram 還有必要留著嗎」）

Telegram 現在同時扮演兩個角色：**遙控器**（指令）與**對話入口**（自由打字）。只有後者跟網頁重疊。C8 把重疊的那半併進網頁對話本、留下不重疊的遙控器那半，因此**不會有兩套邏輯打架，也不需要砍掉 Telegram**。

### 17.3 風險與護欄

- **最大風險：接錯本**。指揮官以為講給 A，其實寫進 B。護欄：**每次工作區切換或對話切換後的第一則回覆，必須附上一行「現在接：<標題>」**；`/whichchat` 隨時可查。
- **不做**（明確排除）：Telegram 端的附件／圖片上傳；網頁端為 Telegram 來源訊息做特殊 UI（僅在訊息 metadata 記 `origin:'telegram'`）；刪除或改寫任何既有指令；把 console.json 資料遷移進對話本（歷史流水帳留在原地）。

### 17.4 C9 — 網頁端補上「刷新對話」（2026-08-26 Charles 追加）

> **缺口**：C8 上線後指揮官實測，發現手機在 Telegram 打的字**確實有寫進網頁那本對話檔**（`chat_<sessionId>.json`，同一份檔案、C8 D2 的設計本來就是共用），但**開著的網頁分頁不會自己重新讀檔**，刷新整個瀏覽器也不會，因為網頁本來就沒有「重新讀取當前 session 檔案」這個動作、只有「使用者自己發訊息時」會更新畫面。這是 UI 缺口，不是 C8 資料流的缺口。

- **D8｜不做自動輪詢，改成手動「刷新對話」按鈕**。指揮官明確要求用按鈕、不要自動偵測輪詢（避免和使用者正在打字的畫面狀態打架、也避免額外背景請求）。按鈕放在 `portal/views/chat.js` 對話視窗的標題列／工具列。
- **D9｜按鈕行為**：呼叫既有的 `GET /api/chat-sessions/:sessionId`（`portal/server.js` 約 L2860，讀 `chat_<sessionId>.json`）取回該 session 完整訊息陣列，重繪對話視窗；**不重新整理整頁、不中斷正在輸入的文字**。因為 Telegram 與網頁本來就寫同一份 session 檔（C8 D2），這個按鈕天然就能看到「網頁＋Telegram 的完整合併對話」，不需要額外做合併邏輯。
- **D10｜找不到目前 session 對應的按鈕承接點時**，先讀 `portal/views/chat.js` 現有的對話載入/渲染函式（開啟一本對話時怎麼把 messages 畫出來的），刷新按鈕重用同一段渲染邏輯，不得另寫一套顯示格式。
- **明確不做**：自動輪詢／WebSocket／SSE 即時推送（範圍外，未來如有需要另立 spec）；跨 session 的合併顯示。

---

## 18. C10 — 排程完成通知回原對話而非廣播（2026-08-26 Charles 提出）

> **問題**：排程「觸發」不論來源都不記錄是哪個對話按的，而排程完成後的通知一律走 `sendToAll`（`portal/telegram.js`）廣播給每個已授權 Telegram 帳號。C8/C9 引入多對話 session 之後，指揮官在某個 Telegram 對話裡手動觸發排程，跑完的結果卻回不到那個對話、只能出現在所有對話都看得到的廣播——這是「舊設計（廣播）沒跟上新功能（多對話 session）」，不是新 bug。

- **決策**：`POST /api/schedules/:id/run` 新增可選 `origin:{channel,chatId,sessionId}`，一路帶進 `triggerNow` → `_fireSchedule` → `createRun`，存進 run 記錄（`run.origin`）；沒帶就是 `null`，行為與改動前完全一致。
- run 完成時寫入 `run.delivery` 的兩個地方（`server.js` 的 `onComplete`，限額中斷與正常完成各一處）把 `run.origin` 一併帶進 `delivery.origin`；`scheduler.js` 的 `flushRunDelivery` 組 `notif` 時把 `delivery.origin` 一併放進送給各 sink 的 payload。
- `portal/telegram.js` 的 telegram sink：`payload.origin.channel==='telegram'` 且有 `chatId` → 只 `sendMessage(chatId, ...)` 送回那一個對話；否則（自動觸發／舊資料／沒帶 origin）維持 `sendToAll` 廣播，回歸底線不變。
- `taskFn`（Telegram 派工的 system prompt）補上一段：若這次任務是要代理人去觸發某個排程，必須在 `POST .../run` 的 body 帶上 `origin`，且把本次呼叫本身就有的 `chatId`／`sessionId`（確定值，非模型猜測）直接寫死在 prompt 裡讓它照抄。
- **加分項 C10-04（通知順便寫進 `chat_<sessionId>.json`）未做**：該邏輯目前只存在於 `server.js` 的 chatFn/taskFn 封閉範圍內（依賴 `wctx.chatHistoryDir`／`saveChatSession`），telegram.js 的 sink function 沒有這些依賴，硬做需要跨模組傳遞工作區路徑並重複實作寫檔邏輯，評估後風險大於效益，本輪跳過。
- **護欄**：自動觸發（`_tick()` 到點、限額續跑 `_firePendingResume`）一律不傳 origin，`run.origin` 恆為 `null`，通知行為與 C10 之前完全一致——這是本次修改唯一不能碰壞的回歸底線，已用單元測試驗證。

---

## 19. TG-MODEL — 模型選擇（2026-09-09 Charles 提出）

> **動機**：Telegram 自由對話與派任務原本寫死用 Sonnet。指揮官不常用 Telegram，就算用也多是短對話，token 差異不大；但他曾在 Telegram 問「排程執行 blocked 的原因」，Sonnet 給了完全錯誤的答案、反而要多追問幾次更浪費 token。因此把 Telegram 預設模型改成 Opus——短對話下思考品質優先於 token 成本。

- **決策**：`_tgSpawnClaude(prompt, workspaceRoot, timeoutMs, modelArg)` 新增第 4 個參數；省略時吃 `tgDefaultModel()`，其讀取 `telegramBot.getModel()`，**未設定時預設 `'opus'`**。網頁聊天的 `DEFAULT_CHAT_MODEL`、排程用的 `claude::sonnet` 完全不受影響。
- **設定持久化**：沿用既有的 `portal/telegram.js` `_loadConfig`/`_saveConfig`，寫進 `secrets/telegram.json` 的 `model` 欄位（不另建新設定檔）。`TelegramBot.getModel()`/`setModel(m)` 只接受 `'opus'`／`'sonnet'`，其他值拒絕並回中文錯誤訊息，不落地。
- **`/model` 指令**：`/model` 顯示目前使用的模型；`/model opus`、`/model sonnet` 切換並存檔，回覆含「之後的對話與任務都會用這個模型」。與 `/use`／`/status` 同一套指令 dispatch 寫法，已列入 `/help`。
- **誰吃這個設定**：`chatFn`（自由對話）與 `taskFn`（派任務）走設定值（預設 Opus）。`_tgRecapSession`（摘要，機械式壓縮）**固定傳 `'sonnet'`**，不吃使用者選的模型——用 Opus 摘要純粹浪費額度。
- **撞限額自動退回（TG-MODEL-5）**：`_tgSpawnClaude` 若這次用的是 opus 且輸出被既有 `detectRateLimit('claude', output, '')`（`server.js`，B4 既有的限流字串判斷）判為 `limited`，自動改用 sonnet 重試一次，回覆最前面加一行「⚠️ Opus 額度目前用滿，本則改用 Sonnet 回答」。**只退回一次**，不會無限重試（sonnet 那次即使也被判 limited 也直接回傳，不再遞迴）。
- **護欄**：只動 `portal/server.js`（`_tgSpawnClaude`/`tgDefaultModel`/三個呼叫點）與 `portal/telegram.js`（設定存取＋`/model`指令），不動網頁聊天、排程、會議等其他模型預設。

---

## Changelog
| Date | Version | Author | Description |
|:-----|:--------|:-------|:------------|
| 2026-06-20 | v0.1 | 老闆 + Claude | 初版（Telegram = 觀看者 + 遠端入口）。 |
| 2026-06-20 | v0.2 | 老闆 + Claude | **重大改寫**：改為「全域指揮控制台」模型。新增訊息生命週期、sticky 脈絡、意圖分類+安全梯度、標的反問路由、控制台日誌管理（壓縮/刪除/清空）、網頁鏡像。控制台串 ≠ 模型上下文（解 token 膨脹）。重切 C0–C5。 |
| 2026-06-20 | v0.3 | 老闆 + Claude | §9 網頁鏡像由「唯讀」升級為「**雙向可輸入**」：網頁輸入框 + `POST /api/telegram/console/send`，文字走同一 handler、與手機 Telegram 雙向同步（= 內嵌的 Hana 控制台 web chat）。C3 任務同步更新。 |
| 2026-08-26 | v0.4 | Charles + Hana | 新增 §16 C7：Telegram 對話續接與意圖判斷修正（任務路徑補前文、前文品質、日誌不截斷、查詢語氣不派工）。 |
| 2026-08-26 | v0.5 | Charles + Hana | 新增 §17 C8：Telegram 自由打字接上網頁對話本（遙控指令保留、sticky 對話游標、/chats /newchat /whichchat、摘要卡不倒全文、console.json 降級為通知落點）。 |
| 2026-08-26 | v0.6 | Charles + Hana | 新增 §17.4 C9：網頁端補「刷新對話」按鈕（手動、非輪詢），讓已寫入同一 session 檔的 Telegram 訊息能在不整頁刷新的情況下顯示於網頁。 |
| 2026-08-26 | v0.7 | Charles + Hana | 新增 §18 C10：排程手動觸發可帶 `origin`，完成通知回原 Telegram 對話而非廣播；自動觸發維持 `origin:null` 廣播不變。 |
| 2026-09-09 | v0.8 | Charles + Hana | 新增 §19 TG-MODEL：Telegram 對話／任務預設模型改為 Opus（可用 `/model` 切換），摘要固定 Sonnet，撞限額自動退回 Sonnet 一次。 |

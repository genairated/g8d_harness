# SPEC-chat-durability — 對話落檔韌性（中斷也不失憶）

> 狀態：草案（2026-08-03 立案）
> 相關：`portal/server.js`（`saveChatSession` / `/api/chat` job 生命週期）、`Deploy_Harness.ps1`
> 任務：`.worktable/TASK.md` §X

---

## 1. 問題（實際踩到的事故）

指揮官與 Hana 進行的一整輪對話**完全沒有留下任何記錄**——不是被覆蓋、不是被清掉，而是**從未被寫出來過**。

根因鏈（已於 2026-08-03 追查確認）：

1. 對話落檔只有**一個時機**：`portal/server.js` 在整輪回答 finalize 之後才呼叫 `saveChatSession()`（server.js:8048），寫出 `<workspace>/.harness/runtime/chat_history/chat_<sessionId>.json`。
2. 在那之前，整段對話（**含使用者已送出的提問**）只活在 server 進程的**記憶體**裡。
3. 該輪對話中執行了 `Deploy_Harness.ps1`，其步驟 5 會**停掉 :3400 的舊 server、起新 release**——等於把「正在承載這段對話的那顆 server」殺掉。
4. 那一輪從未 finalize → `saveChatSession()` 從未被呼叫 → session 檔從未建立。

同一個弱點也適用於：server crash、機器斷電、使用者關機、CLI job 卡死被強殺、Windows 更新重開。**只要那輪沒跑完，整輪（含提問）就蒸發。**

## 2. 設計原則

**提問一旦送出，就必須先落地。** 回答是加值，不是落檔的前提條件。硬碟是真相（沿用 resilient-CLI 的同一條原則）。

## 3. 範圍內

### 3.1 送出即落檔（主要保險，通用於所有中斷情境）

- `/api/chat` 收到請求、確定 session 與工作區之後、**在把工作丟給 CLI 之前**，先呼叫一次 `saveChatSession()`，寫入「使用者這則訊息已加入、assistant 回覆尚未產生」的半成品狀態。
- 該次寫入在 session JSON 加上 `pending: { since: <ISO>, model: <model>, jobId: <id> }`。
- 回答 finalize 時的既有 `saveChatSession()` 呼叫**覆寫**該檔並**移除 `pending`**（`saveChatSession()` 已有「保留既有欄位」的模式，`pending` 反過來要**明確清掉**，不可沿用保留邏輯——否則會永遠掛著）。
- 失敗處理與既有一致：`try/catch` 包住，寫檔失敗只記 log、**不可**讓提問本身失敗。

### 3.2 中途 checkpoint（長工作的中間狀態）

- 一輪 CLI 執行常達數分鐘且會累積 `trace`（工具呼叫軌跡）。在既有的 trace 累積點加入**節流式 checkpoint**：距上次寫檔超過 30 秒才寫一次（避免長對話高頻寫大 JSON）。
- checkpoint 寫入的內容 = 目前 messages（含半成品 assistant 佔位）＋ 已累積的 trace ＋ `pending`。

### 3.3 Deploy 前主動保存（專治自癒／部署情境）

- `Deploy_Harness.ps1` 在**停掉 3400 之前**，先打 `POST http://localhost:3400/api/chat/flush`（新端點，見 §4.2），逾時 3 秒即放行、失敗不阻擋部署（部署不能因為 flush 失敗就卡死）。
- server 端另註冊 `SIGINT`/`SIGTERM` handler 做同一件事（涵蓋 `Ctrl+C` 手動停）。**誠實說明**：Windows 上 `Stop-Process` 為強制終止、收不到訊號，所以 §3.1/§3.2 才是主要保險，§3.3 是加分項。

### 3.4 中斷的可見化

- `GET /api/chat/history/:id` 回傳的資料本就整包吐出，前端載入 session 時若見 `pending`，在該輪 assistant 位置顯示一條淡色橫幅：「這一輪在 <時間> 被中斷，未取得回覆」。
- 沿用既有的 `interruptedBannerHtml(meta)` 樣式，不另造一套視覺。

## 4. 介面

### 4.1 資料模型（`chat_<sessionId>.json` 增補）

```jsonc
{
  "sessionId": "...",
  "pending": { "since": "2026-08-03T12:00:00.000Z", "model": "claude::opus", "jobId": "job_..." },
  "messages": [ /* 既有 */ ],
  "trace": [ /* 既有 */ ]
}
```

- `pending` **只在該輪未完成時存在**；完成即刪鍵。舊檔沒有此鍵 → 視為無中斷，行為與今天完全一致。

### 4.2 `POST /api/chat/flush`（新增）

- 登記進 `portal/api-router.js` 的 route table（**勿加進舊 78-if 鏈**）。
- 對所有記憶體中 in-flight 的 chat job 各做一次 `saveChatSession()`（各自用 job 啟動時捕獲的 `chatHistoryDir`，維持既有的「job 寫回自己工作區」語意）。
- 回應 `{ ok: true, flushed: <n> }`。無 in-flight 時回 `{ ok: true, flushed: 0 }`。

## 5. 不在範圍

- 不做逐字串流落檔（每個 token 就寫檔）——成本與收益不成比例。
- 不做跨機器／雲端備份。
- 不改 `context_<sessionId>.md` 的產生時機（它本就在每次送出時重寫，已足夠）。

## 6. 驗收

1. 送出一則訊息後、**在回覆產生前**強制殺掉 server → `chat_<id>.json` 已存在、含該則使用者訊息、帶 `pending`。
2. 重啟 server 後開啟該 session → 看得到自己的提問，並顯示「這一輪被中斷」橫幅。
3. 正常完成一輪 → `pending` 鍵已消失，訊息與 trace 完整（與今天一致）。
4. 一輪跑超過 60 秒的長任務中途殺掉 → 檔內含已累積的部分 trace（checkpoint 生效）。
5. `Deploy_Harness.ps1` 在有 in-flight 對話時執行 → 部署照常成功，且該輪對話已落檔（不再整輪蒸發）。
6. 舊的 session 檔（無 `pending`）載入行為完全不變。

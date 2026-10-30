# SPEC-chat-background-task — 對話內背景任務（交待完就能繼續交待，結果自己回到同一條對話）

> 狀態：草案（2026-10-01 立案，Charles 拍板三項決策）
> 相關：`portal/server.js`（`/api/chat` 生命週期、`saveChatSession`、`respondChat`、SSE 廣播）、`portal/scheduler.js`（背景執行器）、`portal/index.html`（聊天前端）、`portal/views/schedule.js`
> 相關規格：`specs/SPEC-scheduler.md`（§9.3 SSE 即時更新）、`specs/SPEC-chat-durability.md`（送出即落檔、pending、trace checkpoint）
> 任務：`.worktable/TASK.md` §CBG（後端）、§CBGU（前端）

---

## 1. 問題

每一輪對話＝叫起一次 CLI，回完那段話該次執行就結束——**沒有任何「我」留在對話裡等背景結果**。所以：

1. Hana 說「我等它完成後回報」在現行架構下兌現不了（已確認是措辭過度承諾，非遺忘）。
2. 指揮官目前的變通做法是：判斷某件事要跑很久 → 請 Hana 建一筆排程 → 自己去排程頁看。代價是**結論離開了對話脈絡**，日後回頭翻對話找不到結果。
3. 長工進行中，指揮官還有別的事要在同一條對話交待，但前景回覆會把對話占住。

## 2. 設計決策（2026-10-01 Charles 拍板）

| # | 決策 | 內容 |
|---|---|---|
| D1 | 鎖定範圍 | **「正在跑就不能插話」只套用於前景即席回覆**，背景任務執行期間對話**不鎖、可繼續交待**。理由：多工本身就是這功能的目的。 |
| D2 | 併發上限 | **不設上限**。改為提供**單筆中止**能力——後令蓋前令時，指揮官要能只停掉前面那筆背景任務，不影響其他筆。 |
| D3 | 升級判斷權 | **Hana 自行判斷**要不要轉背景，並在回覆第一句講明；**指揮官明確指示時（「這個現在做」／「這個背景跑」）以指示為最高優先**，Hana 不得用自己的判斷覆蓋。 |
| D4 | 執行引擎 | **沿用既有排程器，不另造背景執行系統**（不重造輪子原則）。差別只是這類任務是**一次性、由對話觸發**的。 |
| D5 | 可見性 | 三處：①**對話清單／分頁上的計數徽章**（執行中筆數，歸零即消失）；②**對話裡的狀態小卡**（執行中→完成，就地變成結果訊息）；③既有排程執行記錄頁（標註「來自對話」）。不另開新頁面。 |

### 2.1 Hana 的升級準則（寫進技能／人設層，非程式判斷）

轉背景：要**動程式並重新上線**的、要**跨多檔修改**的、**預估超過兩分鐘**的（寫規格、批次處理、轉檔、長文件分析）。
留前景：問答、查資料、改一兩行純文字檔。

## 3. 範圍內

### 3.1 背景委派（後端）

- 新增 `POST /api/chat/delegate`：由對話觸發，建立一筆**一次性背景任務**，回 `{ taskId, scheduleId, runId }`。
- 任務以排程器執行，內容為 `kind:"prompt"` 完整內嵌指示（與既有排程一致），並帶 `origin: { kind:'chat', sessionId, workspace }`。
- 該筆任務**標記為對話專用**（`chatTask: true`）：
  - **不出現在排程清單**（避免製造噪音）——`GET /api/schedules` 需過濾掉 `chatTask`。
  - **仍出現在執行記錄**（`GET /api/runs` / 近期動態），並標註「來自對話」。
- 一次性任務完成後自動不再觸發（無 cron、不續排）。

### 3.2 結果回寫同一條對話（後端）

- 任務完成（成功／失敗／中止）→ 以**附加**方式把結果寫進該 session 的對話檔，成為一則新的 assistant 訊息，`meta` 帶 `{ bgTaskId, status, elapsedMs, origin:'background' }`。
- **並發安全（必做）**：回寫不得整檔覆寫。必須「讀最新檔 → 附加 → 寫回」，且與 `/api/chat` 的 `saveChatSession` 共用同一把序列化鎖；若該 session 正有前景回覆在跑，等它 finalize 後再附加。否則會與指揮官同時打字的那輪互相蓋掉。
- 回寫的訊息**算進後續對話脈絡**（下輪會被模型看到）。
- 同步推一則 Telegram 通知（沿用既有通知管道）。

### 3.3 即時推播與徽章（前端）

- 沿用 SPEC-scheduler §9.3 的 SSE 模式：後端只推「這條對話有變動」的輕量事件，前端重新抓該 session。
- 聊天頁開著 → 新訊息自己長出來（目前聊天頁完全沒有即時更新，只有排程頁有）。
- 對話分頁與歷史對話清單顯示**執行中筆數徽章**，歸零消失。
- **工作區隔離（鐵則）**：SSE 不能帶自訂標頭，workspace 走 query param；server 端 `path.resolve()` ＋小寫正規化後比對，`null` ＝ `WORKSPACE_ROOT`，只推同工作區。徽章與回寫同樣過濾。

### 3.4 對話內狀態小卡（前端）

委派成功後，對話裡立即插入一張卡片：任務標題、狀態（執行中／已完成／失敗／已中止）、經過時間、**「中止這一筆」按鈕**（D2）。完成後卡片摺疊成一行摘要，結果訊息接在它下面。

> **注意：狀態小卡 ≠ 執行軌跡（`buildTraceHtml`）**。小卡是這次新增的背景任務狀態列，執行軌跡是既有的工具呼叫清單。兩者都要在歷史裡看得到，見 §3.5。

### 3.5 歷史對話的執行軌跡遺失（本次一併修掉）

**已確認的缺陷**（2026-10-01 查證）：

1. `portal/index.html` 的 `renderActiveTab()` 重畫歷史訊息時，`appendMessageToUI(...)` 的 trace 參數**一律傳 `null`** → 回到歷史對話永遠看不到「執行軌跡」區塊，即使當時有。
2. `portal/server.js` 的 `saveChatSession()` 把 `trace` 存成**session 級單一陣列**（只有最後一輪），不是逐則訊息。所以即使前端改傳，也只救得回最後一輪。

修法：

- `respondChat()` 落檔時把該輪 trace 一併掛在**那則 assistant 訊息自己身上**（`msg.trace`）；session 級 `trace` 欄位維持不動（向後相容、`SPEC-chat-durability` 的 checkpoint 仍用它）。
- `renderActiveTab()` 改為傳 `msg.trace || null`。
- **舊檔相容**：既有 session 檔的訊息沒有 `msg.trace`。讀取時若整份都沒有 per-message trace，就把 session 級 `trace` 掛到**最後一則** assistant 訊息上（只救得回最後一輪，**不假裝補齊全部**，誠實原則）。

### 3.6 對話中「另外建排程再觸發」也要掛上來源對話（2026-10-01 追加，任務 §CBGO）

**實際缺口**：§3.1 的 `POST /api/chat/delegate` 只涵蓋「Hana 走委派端點」這條路。但 Hana 在對話裡更常見的做法是**另外建一筆排程、再手動觸發**（規劃與規格討論留在同一對話、不被改程式打斷）。這種排程沒有 `origin.sessionId`，導致：徽章與狀態小卡看不到它、對話按「停止」時連動中止抓不到它（指揮官 2026-10-01 實際遇到）、結果只走 Telegram 不回對話。

**修法（決策，2026-10-01 當日即被指揮官推翻，見下方「決策被推翻」）**：

1. ~~這類排程仍留在排程清單（`chatTask` 維持 false）——它是指揮官主動要看的真排程，不該被藏起來；差別只在多帶 `origin: { kind:'chat', sessionId, workspace }`。~~
2. **兩層保障**：① `buildChatPrompt()` 注入本輪確定的 `sessionId`，並指示建立／觸發排程時把 `origin` 照抄進 request body（對齊既有 Telegram `taskFn` 的同類指示）；② `POST /api/schedules` 與 `POST /api/schedules/:id/run` 接受選填 `origin` 並持久化（觸發時若 schedule 身上還沒有 chat origin 就補寫）。
3. **完成回寫的判準改為「有 chat origin」**，不再綁 `chatTask:true`：`chatTask` 從此只負責「要不要從排程清單濾掉」這一件事，回寫／SSE／徽章一律看 `origin.kind==='chat' && origin.sessionId`。回寫仍走 §3.2 的鎖與附加機制，不得整檔覆寫。

> **決策被推翻（2026-10-01 當面拍板，任務 §CBGV）**：第 1 點的「仍留在排程清單」是誤判。指揮官實際要的是**對話裡看得到背景排程在跑、結果是什麼**，但**不要這些對話衍生的一次性任務出現在排程頁面製造噪音**——跟原始決策①正好相反。第 2、3 點（`origin` 持久化、回寫判準看 `origin` 不看 `chatTask`）維持不變，繼續沿用。新判準見 §3.6.2。

**明確不做**：不改排程執行邏輯與 cron、不改工作區過濾規則、不新增資料欄位以外的資料結構、不改 `/api/chat/delegate` 既有行為、不新增 UI 元件。

### 3.6.1 實作備註（§CBGO，2026-10-01）

- `buildChatPrompt()` 新增選填參數 `chatSessionId`；只有三個「真人對話」呼叫點（`POST /api/chat` 一般訊息、同路由的技能展開、Telegram `chatFn` 自由對話）傳入當前 sessionId。`fireScheduledJob`（排程本身執行時）與 `/knowledge-distill` 背景任務呼叫 `buildChatPrompt()` 時刻意**不傳**——它們的 `activeSessionId` 是一次性 scratch session（`sched_<runId>` 等），注入指示只會誤導模型把排程自己的暫存 session 誤標成「來源對話」。
- `POST /api/schedules`：`data.origin` 只在 `{kind:'chat', sessionId:非空}` 形狀下被接受並持久化（連同 `workspace`，優先用 `origin.workspace`，缺則回填 `data.workspace`）；任何其他形狀（含完全缺漏）一律 `delete data.origin`，絕不報錯擋下建立。`chatTask` 不受影響，仍只能由呼叫端顯式傳 `true`（§CBG 的 `/api/chat/delegate` 專用）。
- `POST /api/schedules/:id/run`：沿用 TGC10-01/02 既有的 `origin` 參數解析（run-level，forward 給 `triggerNow`，shape 通常是 Telegram 的 `{channel,chatId,sessionId}`，不動）；另外新增一段**獨立判斷**——若該 body 的 `origin.kind==='chat' && origin.sessionId`，且該 schedule 目前還沒有 chat origin，就用 `schedulerManager.updateSchedule()` 補寫到 **schedule 本身**（不是 run）。這是兩個完全獨立的資料面：run-level origin 給 TGC10-03 的 Telegram 完成通知路由用；schedule-level origin 給 CBG-4/CBGO-4 的「結果回寫對話」用。兩者 shape 不同（有無 `kind` 欄位）天然不會互相誤判。
- `deliverChatTaskResult()`（§CBG 既有函式）判準由 `schedule.chatTask` 改為 `schedule.origin && schedule.origin.kind==='chat' && schedule.origin.sessionId`；`chatTask` 從此只負責 `GET /api/schedules` 的清單過濾，不再參與回寫判斷。
- `GET /api/runs`：原本只對 `schedule.chatTask===true` 的 run 標 `fromChat:true`。查證發現 `portal/index.html` 既有的 CBGU-2 徽章/狀態小卡/停止連動（`fetchChatRunningTasks`／`renderBgTaskCards`／`askStopLinkedBgTasks`）全部只消費 `r.fromChat && r.origin.sessionId`，若不放寬，CBGO 這類（`chatTask` 刻意維持 false）排程的 run 會被整批濾掉、徽章與小卡完全看不到——這正是查證出的「chatTask 條件在擋」之處。修法：任何 `schedule.origin.kind==='chat'` 的排程一律補 `fromChat:true`；若該 run 自己沒帶 per-run origin（例如由 cron 自動觸發，TGC10-02 本就不帶 run-level origin），從 `schedule.origin` 回填到回應的 `origin` 欄位，讓前端既有的 `r.origin.sessionId` 比對原樣吃到。`portal/index.html` 本次**完全未改**。
- **未做／未驗證**：鏡射測試（`.worktable/artifacts/cbgo/mirror-test.js`，純 Node、直接 `require scheduler.js`、temp harnessHome，20 項斷言全過）只驗證了本次新增/修改的判準邏輯與資料流，**沒有**透過真實 HTTP 或真 CLI 任務跑過「對話交待長工 → Hana 自建排程觸發 → 徽章/小卡/停止連動 → 結果回寫對話」的端到端流程；並發安全的鎖定/合併寫入機制（`withChatSessionLock`／`saveChatSessionMerged`）完全沿用 §CBG 既有程式碼，本次未改也未重新測試；`POST /api/schedules/:id/abort` 對這類排程的實際中止行為未實測（程式邏輯本就不分 chatTask/chat-origin，沿用 §CBG 的誠實備註）。

### 3.6.2 實作備註（§CBGV，2026-10-01，推翻 §3.6 修法第 1 點）

- **新判準**：`GET /api/schedules` 不再只濾 `chatTask===true`，改用共用 helper `isChatOnlySchedule(s)`（`portal/server.js`，緊鄰該路由上方）：
  1. `s.trigger.type === 'cron'` → 永遠留在清單（指揮官主動要的定時任務，不論帶不帶 `chatTask`／`origin`）。
  2. 非 cron 且 `chatTask === true` → 濾掉（§CBG `/api/chat/delegate` 既有路徑）。
  3. 非 cron 且有 `origin.kind==='chat' && origin.sessionId` → 濾掉（§CBGO「對話中另建排程」路徑，這就是被推翻的那條，現在改成也要濾）。
  4. 其餘（無 origin、無 chatTask 的一般排程）→ 留在清單。
- **cron 防線**：`portal/scheduler.js` 的 `createSchedule()` 新增一道保護——`trigger.type === 'cron'` 時，即使呼叫端傳 `chatTask:true` 也會被強制降為 `false`，避免一筆真正的週期排程因為誤傳而從清單消失、指揮官再也找不到。`isChatOnlySchedule()` 本身也把 cron 判斷放在最前面，雙重保險。
- **`buildChatPrompt()` 注入指示改寫**：原本只講「另建排程記得帶 origin」，現在講清楚三條路——① 走 `/api/chat/delegate`（天然濾掉、天然回寫）；② 改用 `POST /api/schedules` 建一次性任務（`trigger:{type:'once'}`）再手動觸發，要同時帶 `origin` 與顯式 `chatTask:true`；③ 指揮官要的週期排程照常建、不要帶 `chatTask`。
- **確認沒有連帶弄壞對話側可見性**：`GET /api/runs` 的 `fromChat` 判準、`deliverChatTaskResult()`、`broadcastChatTaskChange()`、前端 `fetchChatRunningTasks`／`renderBgTaskCards`／`askStopLinkedBgTasks` 全部讀 `schedule.origin`／`run.origin`，跟「是否出現在排程清單」完全是兩個獨立判準——讀過一輪程式碼確認無誤，本次**未改動**這些函式。
- **已知、刻意不修的既有缺口**：Telegram `/schedules`（`_cmdSchedules`）與 `/status`（排程計數）目前**沒有**套用任何 chatTask／chat-origin 過濾，是查證時發現的既有缺口（早於本次任務，§CBG 落地時就沒補），本次任務範圍是「排程任務頁面」而非 Telegram 介面，故**刻意不修**，留待日後若指揮官認為 Telegram 也要一致再開新任務。`portal/views/schedule.js` 只消費 `GET /api/schedules`，本次未改它也自動吃到新過濾邏輯。
- **自測**：鏡射測試（`.worktable/artifacts/cbgv/mirror-test.js`，純 Node、直接 `require scheduler.js` 的真實 `createSchedule()`，temp harnessHome）11 項斷言全過，涵蓋本節列出的全部判準組合。`node --check` 過 `portal/server.js` 與 `portal/scheduler.js`。**未驗證**：真實瀏覽器點擊／真實 HTTP 端到端（環境無瀏覽器工具、本次也未起第二顆 server）、Telegram 既有缺口的實際使用者影響。

## 4. 明確不做

- 不設併發上限、不做排隊機制（D2）。
- 不做 sub agent 平行化（它在單輪內收斂，解決不了「回完話之後才說話」）。
- 不另造背景執行器、不引入 npm 套件、不做 WebSocket。
- 不把對話任務混進排程清單 UI、不新增頁面。
- 不改既有排程的執行邏輯、資料格式與工作區過濾。
- 不做「全部對話都走背景」（簡單問題會變笨重）。

## 5. 風險（誠實揭露）

1. **額度**：不設上限＝可能同時跑多個長任務，撞限額機率高於現在。既有「限額自醒續跑」會接手，但指揮官需知道這是刻意的取捨。
2. **並發寫入**：§3.2 的鎖沒做對會吃掉訊息。這是本規格最容易出錯的一點，必須有針對性測試。
3. **工作區外洩**：本系統有多次前例，回寫、徽章、SSE 三處都必須過濾。
4. **工時不確定**：估兩個任務量（後端一、前端一），非跨天工程，但不保證精確工時。

## 6. 驗收條件（AC）

1. 交待一件長工 → Hana 當場回短訊息說明已轉背景 → 對話立即可繼續輸入第二件。
2. 同時啟動 3 筆背景任務，分頁徽章顯示「3」；完成一筆變「2」；全完成徽章消失。
3. 任一筆按「中止這一筆」→ 只有該筆停止，其餘繼續跑完並回寫。
4. 背景任務完成時，聊天頁開著 → 不重整就長出結果訊息；關掉分頁後重開同一條對話 → 結果訊息在。
5. 背景任務回寫的那一刻，指揮官正在同一條對話送出前景訊息 → 兩則訊息都在，沒有任何一則消失。
6. 工作區 A 的背景任務，在工作區 B 的聊天頁／清單**完全看不到**（徽章、訊息、SSE 事件皆然）。
7. 對話中為了把工作做掉而建立的一次性背景任務（不論走 `/api/chat/delegate` 或另建排程再觸發）**不出現**在排程清單；指揮官主動要的週期性（cron）定時排程**仍出現**在排程清單。兩者皆出現在執行記錄並標註「來自對話」（§CBGV，2026-10-01 推翻原決策①後的最終版本）。
8. 開啟一條**過去的**歷史對話 → 當時有工具呼叫的訊息，底下看得到可展開的「執行軌跡」（§3.5）。
9. 指揮官明說「這個現在做」→ Hana 不轉背景；明說「這個背景跑」→ 即使 Hana 判斷很快也照辦（D3）。

## 8. 實作備註（§CBG 後端，2026-10-01）

- **§3.1 委派**：`POST /api/chat/delegate`（`portal/server.js`，ApiRouter 路由表）直接建一筆 `chatTask:true` 的 Schedule（`enabled:false`、`trigger:{type:'once'}`）再立刻 `schedulerManager.triggerNow()`——完全沿用既有排程器（D4），沒有另造執行路徑。`scheduler.js` 的 `createSchedule()` 新增 `chatTask`／`origin` 兩個欄位。
- **§3.2 回寫**：新增 `withChatSessionLock(sessionId, fn)`（per-session promise 鏈，序列化所有寫入）＋ `saveChatSessionMerged()`（讀目前磁碟上的 `messages`，把呼叫者「以為」的 prefix 跟磁碟實際內容做差集，把差出來的 `extra` 保留下來再接上新訊息）＋ `appendMessageToChatSession()`（背景任務專用，讀最新檔→附加→寫回）。`saveChatPending`（X1/X2 checkpoint）與 `respondChat`（finalize）的寫入點都改走同一把鎖與 `saveChatSessionMerged`，不再是「從記憶體裡的 `ctx.messages` 直接整檔覆寫」——這是修掉 AC5 競態的關鍵，不只是加鎖，鎖本身不夠（checkpoint 若還是整檔覆寫，一樣會把背景訊息蓋掉）。
- **§3.2 Telegram 通知**：沒有新寫路徑。`schedule.delivery` 預設即含 `telegram`，`fireScheduledJob` 既有的 `sinkManager.deliver()` 對所有排程（含 chatTask）一視同仁，CBG-4 不必另造管道。
- **§3.3 SSE**：新增 `broadcastChatTaskChange()`，直接複用既有 `scheduleSSEClients`（同一條 `GET /api/schedules/stream`、同一套工作區正規化比對），只是換一個事件名 `chat-task-changed`（payload 只有 `reason/sessionId/scheduleId`，不帶訊息本體）。前端串接（CBGU-1）不在本次範圍。
- **§3.5 歷史軌跡**：`respondChat` 的 `assistantMsg` 現在帶 `trace`（有內容才帶，避免每則都掛空陣列）；`GET /api/chat/history/:id` 讀取時，若整份訊息都沒有 per-message trace 但 session 級 `trace` 有內容，只在回應中把它掛到最後一則 assistant 訊息（不回寫磁碟、不假裝補齊全部）。
- **GET /api/schedules**：新增 `.filter(s => s.chatTask !== true)`。**GET /api/runs**：對每筆 run 查一次它的 schedule，`chatTask===true` 時附加 `fromChat:true`（「來自對話」標註）。
- **未做／未驗證**：前端（徽章／狀態小卡／SSE 接收／`renderActiveTab` 改傳 `msg.trace`）屬 §CBGU，本次完全未動。CBG-7 的自測是**鏡射測試**（純 Node 腳本複製貼上同一段邏輯跑、或直接 `require` 無害的 `scheduler.js`），**不是**透過真的 HTTP 請求打 `/api/chat/delegate` 跑一次真正的 CLI 背景任務——沒有實際呼叫過 LLM、沒有驗證過真實的 Telegram 推播是否送達、也沒有驗證過 `POST /api/schedules/:id/abort` 對 chatTask 排程的實際行為（程式碼邏輯上不分 chatTask 與否，但未實測）。

## 9. 實作備註（§CBGU 前端，2026-10-01）

- **§3.3 SSE/輪詢**：`portal/index.html` 新增獨立的 `chatTaskES`（另開一條 `EventSource`，與 `views/schedule.js` 自己那條完全分開，互不影響生命週期），接同一支既有 `/api/schedules/stream?workspace=`，只監聽 `chat-task-changed`。debounce 300ms 後：重抓執行中計數（`fetchChatRunningTasks()`）→ 重繪分頁徽章＋歷史清單徽章；若事件的 `sessionId` 正是目前開著的分頁，額外呼叫既有 `refreshActiveChatTab()`（沿用 TGC9 既有的「不重建分頁身份」刷新路徑）取回新訊息與 trace。連續失敗 3 次（`onerror` 累計、`onopen` 歸零）退回 `setInterval` 15 秒輪詢，僅 `document.visibilityState==='visible'` 時打，切回前景補抓一次——與 SPEC-scheduler §9.3 同一套保底手法。
- **§3.3 徽章資料源**：`GET /api/runs?status=running&limit=200`（既有 CBG-2 已附的 `fromChat` 標記 + `run.origin.sessionId`，後者是 `/api/chat/delegate` 建排程當下 `triggerNow(s.id, {channel:'chat', sessionId, workspace})` 寫進 run 的，見 CBG §8）。前端用 `origin.sessionId` 精確比對出「這個 session 自己的執行中筆數」。**誠實記載限制**：`/api/runs` 本身**沒有**伺服器端工作區過濾（MEMORY 記載為既有刻意例外），CBGU 未改動它（不在「不改後端 API 合約」授權範圍內）；用 `sessionId` 精確比對能保證「畫面上」不顯示其他工作區/對話的任務（sessionId 是不會跨工作區重複的隨機值），但該端點的原始 HTTP 回應仍含跨工作區資料（devtools 可見）——若日後要補嚴格的傳輸層隔離，需另案在 `/api/runs` 加 workspace 過濾。
- **§3.4 狀態小卡**：`renderBgTaskCards(tab)` 只為目前分頁 `sessionId` 仍「執行中」的 run 插卡（標題／執行中／經過秒數／「中止這一筆」按鈕），插在訊息列表與 foreground 思考 loader 之間；卡片標題另呼叫 `GET /api/schedules/:id` 取排程 `name`（快取避免重複打 API）。中止按鈕沿用既有 `POST /api/schedules/:id/abort`（SCH-STOP），對 chatTask 排程一視同仁。任務結束後該 run 從「執行中」清單消失、卡片隨之收掉；「完成後摺疊成一行摘要」改由 `appendMessageToUI` 新增的 `bgSummaryHtml` 分支（偵測 `meta.origin==='background'`，依 `meta.status` 顯示 ✅/❌/🛑 徽章＋耗時）接手，確實呈現在那則結果訊息正上方，且與既有 `buildTraceHtml`（執行軌跡）完全分離、未混用。
- **§3.5 歷史軌跡**：`renderActiveTab()` 的 trace 參數由一律傳 `null` 改為 `msg.trace || null`，配合 CBG-6 的後端半邊（`respondChat` 掛 `msg.trace`、舊檔只回填最後一則）。
- **自測**：抽出 `index.html` 全部 inline `<script>` 串接後 `node --check` 通過；純 Node 鏡射測試（不起 server）驗證：AC2 計數轉換（3→2→0）、AC3 單筆中止不影響其他筆、AC8 trace 新檔還原／舊檔回退 null、一般排程（非 chatTask）不誤算進對話徽章——共 10 項斷言全過。**未驗證**：真實瀏覽器像素/點擊互動（環境無瀏覽器工具）、卡片標題 API 的即時效果、多分頁同時開啟的 SSE 實際行為——僅靠程式碼審視＋鏡射測試確認邏輯正確。
- **未做**：不包含「如何觸發委派」的 UI（例如手動按鈕）——依設計本身委派由對話過程中的判斷（D3）或既有管道觸發，CBGU 只負責被動反映 SSE/API 回報的狀態，不新增觸發入口。

## 7. Changelog

- v0.1（2026-10-01）立案。決策 D1–D5 由 Charles 拍板；§3.5 歷史軌跡缺陷為同日查證後納入。
- v0.2（2026-10-01）§CBG 後端實作完成（CBG-1~6）：`/api/chat/delegate`、chatTask 排程過濾、並發安全回寫（per-session lock + merge-aware save）、SSE `chat-task-changed`、per-message trace。細節見 §8。前端（§CBGU）未動；`node --check` 過、隔離/鏡射自測過，**尚未部署**。
- v0.3（2026-10-01）§CBGU 前端實作完成（CBGU-1~5）：SSE 接收＋退回輪詢、分頁/歷史清單執行中筆數徽章、對話內狀態小卡＋單筆中止、歷史訊息還原 per-message trace。細節見 §9。`node --check` 過、鏡射自測過，**尚未部署**。
- v0.4（2026-10-01）§CBGO 實作完成（CBGO-1~7，§3.6 追加設計）：補上「對話中另外建排程再手動觸發」這條路的來源對話標記——`buildChatPrompt()` 注入 `origin` 照抄指示、`POST /api/schedules`／`POST /api/schedules/:id/run` 接受並持久化/補寫 chat origin（schedule 維持不設 `chatTask`，仍留在排程清單）、`deliverChatTaskResult` 判準改為「有 chat origin」、`GET /api/runs` 放寬 `fromChat` 判定並回填 origin（查證後確認的真缺口，不放寬會被既有前端濾掉）。`portal/index.html` 完全未改。細節見 §3.6.1。`node --check` 過、`.worktable/artifacts/cbgo/mirror-test.js` 20 項鏡射自測過，**尚未部署**。
- v0.5（2026-10-01）§CBGV 實作完成（CBGV-1~7，推翻 §3.6 修法第 1 點）：指揮官當面拍板「對話衍生的一次性排程一律別出現在排程清單」，不再分走哪條路——新增共用 helper `isChatOnlySchedule()`（`portal/server.js`），凡非 cron 且帶 `chatTask:true` 或帶 chat `origin` 的排程一律濾掉，cron 排程永遠留著；`portal/scheduler.js` 的 `createSchedule()` 加一道防線，cron 排程即使誤傳 `chatTask:true` 也強制降為 `false`。`buildChatPrompt()` 注入指示改寫成三條路版本。查證確認回寫／SSE／徽章／`GET /api/runs` 的 `fromChat` 判準全部看 `origin` 不看清單過濾，未受影響、未改動。細節見 §3.6.2。`node --check` 過 `server.js`／`scheduler.js`，`.worktable/artifacts/cbgv/mirror-test.js` 11 項鏡射自測過，**尚未部署**。

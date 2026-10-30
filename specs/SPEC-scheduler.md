# SPEC — Scheduler（排程 + 自動接續 + 產出紀錄）

> Status: DRAFT for discussion ｜ Owner: 老闆 + Hana ｜ 影響範圍：`portal/server.js`（排程迴圈 + job）、`portal/index.html`（排程清單 UI）、`HARNESS_HOME`（持久化）
> 這是 `specs/SPEC-resilient-cli.md` 標記為「後續 Phase」的部分落地：**自動排程到 reset 自醒續跑 / 自主任務佇列 / 預算·煞車護欄**。
> Run／schedule 的**狀態語意**（success／failed／limited-waiting／`blocked` 受阻·待你…）與 agent 自報標記 `<run-outcome>` 定義於 `specs/SPEC-schedule-status.md`。
> 先求「**架構**」：網站上看得到排程清單（何時起、跑什麼、產出什麼）、沒開瀏覽器也能跑、且為之後接 Telegram 鋪好地基。

---

## 1. 核心原則：執行者 vs 觀看者分離（這是一切的根）

> **執行者**＝24h 常駐的 server（supervisor 擁有）；**觀看者**（網頁排程清單、Telegram、手機）只是去**讀**同一份持久化資料。

```
┌──────── 執行者（不需要瀏覽器）────────┐
│ Supervisor / Server（24h 常駐）        │
│   Scheduler Loop：到點 → 起 Job        │
│     └ 用指定 provider::model 跑任務     │
│     └ 撞 5h 限額 → 記 resetAt → 自醒續  │
│   全程寫入持久化資料（HARNESS_HOME）   │
└───────────────┬────────────────────────┘
                │ 讀同一份資料 + API
   ┌────────────┴───────────────┐
   │ 觀看者（缺席不影響執行）     │
   │  • 網頁「排程」清單          │
   │  • Telegram bot（後續）      │
   │  • 手機 / email              │
   └────────────────────────────┘
```

「沒開網頁也能跑」就是因為**執行與紀錄都在 server 端、且持久化**——跟現有「server 託管的 job 關掉瀏覽器也不死」同一招。

---

## 2. 資料模型（定義 → 執行 → 產出）

三層，對應「何時起／跑什麼／產出什麼」。**檔案式、與執行者無關**（之後要把執行搬到獨立 worker 也不用改）。

### 2.1 Schedule（排程定義）
```
{
  id, name, enabled,
  trigger: { type: 'cron'|'interval'|'once', expr|intervalMs|atISO },
  task:    { kind: 'prompt'|'skill', prompt?|skill?+args? },
  model:   'provider::model',          // 固定模型（如 claude::sonnet / gemini::pro）
  workspace,                           // 在哪個工作區跑
  guardrails: { maxCalls, maxRuntimeMs, maxResumes, failureBreakAfter },
  delivery: ['web'|'telegram'|'email'...],
  createdAt, nextRunAt
}
```

### 2.2 Run（執行紀錄；每跑一次一筆）
```
{
  id, scheduleId,
  startedAt, finishedAt,
  status: 'running'|'success'|'failed'|'limited-waiting'|'aborted'|'interrupted',
  trigger: 'auto'|'manual',            // B6：'auto'=排程到點/限額續跑；'manual'=/run 立即執行
  model, resolvedPrompt,
  usage,                               // 呼叫次數/時間（餵護欄與成本）
  jobId,                               // 對應 server 的 job
  interrupted?: { reason, resetAt, partial },   // 銜接 Part C
  artifactIds: [...], error?
}
```
- **狀態機（B6）**：`running` 為唯一非終態；終態為 `success`/`failed`/`limited-waiting`/`aborted`/`interrupted`。
  `interrupted` 由開機對帳 `reconcileOrphanRuns()` 寫入 —— 上一個行程殘留的 `running` run（被佈署/重啟打斷、永遠等不到 `finishedAt`）一律改記 `interrupted`，避免清單顯示幽靈「執行中」或卡住手動觸發。
- **防重入（B6）**：`triggerNow` 偵測 `getRunningRun(scheduleId)`（最新一筆 `running`），有則回 `409 {ok:false,error:'already-running'}`；前端「立即」按鈕同步 disabled。
- **清單即時狀態（B6）**：`GET /api/schedules` 每筆附 `running:{startedAt,trigger}|null`；UI 顯示「執行中」徽章＋開始時間＋自動/手動，並於有 run 執行中時輕量自動刷新。

### 2.3 Artifact（產出物；一個 Run → 0..n 個）
```
{ id, runId, kind: 'file'|'summary'|'transcript', path|content, createdAt }
```

### 2.1.1 Cron 欄位語法（trigger.type='cron' 時的 `expr`）
標準 5 欄位 Vixie cron（`分 時 日 月 星期`），與業界通用寫法一致（Linux crontab、K8s CronJob、GitHub Actions、Quartz、APScheduler、node-cron 皆同源）——**不自創語法**，只自解析一個夠用的子集：

| 語法 | 意義 | 範例 |
|---|---|---|
| `*` | 每一個值 | `* * * * *` 每分鐘 |
| `N` | 固定值 | `0 8 * * *` 每天 8:00 |
| `*/N` | 每隔 N | `*/15 * * * *` 每 15 分鐘 |
| `A-B` | 範圍 | `8-20` 表示 8 到 20 |
| `A,B,C` | 清單 | `1,3,5` 表示週一三五 |
| `A-B/N` | 範圍內每隔 N | `8-20/2` 表示 8,10,12…20 |

例：`0 8-20 * * 1-5` = 平日（週一到五）每天 8:00–20:00 整點各跑一次。**未支援**：`?`、`L`/`W`/`#`（月最後一天/最近工作日/第 N 個星期幾，Quartz 專有擴充，非標準 Vixie cron，本系統不需要）。解析器：`portal/scheduler.js` 的 `parseCronField`。

### 2.4 持久化位置
- `HARNESS_HOME` 下（建議 `global-knowledge/schedules/`）：
  - `schedules.json`（定義）、`runs/<scheduleId>/<runId>.json`（執行）、產出檔放 `runs/<scheduleId>/<runId>/`。
- 跟 chat history 同精神（檔案式）→ **跨自癒重啟不丟、不綁分頁、不綁工作區**。

---

## 3. 執行架構：第一版「內建在 server」

### 3.1 決策：內建優先，不先拆 worker
- **「內建」不代表 server 自己算**：server 跟跑 chat 一樣是 **spawn CLI 子行程**去算，自己只做監督 + 接 I/O + 寫紀錄 → event loop 不被長任務卡。
- **排程任務 = 一種被時間觸發的 job**，直接複用現有 `jobs` Map、reattach、Part C 中斷/續跑。
- 最少零件、最本地優先：一個 supervisor、一個 server，不引入佇列/IPC/第二個 supervisor。

### 3.2 唯一權衡（已被 Part C 解掉）
自癒重啟（deploy）時若剛好有排程 job 在跑 → 子行程被收 → 這正是 Part C 場景：**存半成品 → 之後自醒續**。耦合會優雅降級，不是災難。

### 3.3 何時才拆獨立 worker（出現具體需求才做，非破壞性）
- 有任務長到**絕對不能被 deploy 打斷**；或
- 要在 **server 重啟/沒開時也照跑**；或
- 要**大量平行**排程（需 worker pool）。
- 因資料模型與執行者無關，屆時只換「誰跑迴圈」，UI/API/資料不動。

### 3.4 機器必須醒著（獨立議題，但別漏）
不管內建或 worker，**排程時間點該機器要是醒的**。要可靠「凌晨 2 點」跑，需 OS 層喚醒（Windows 工作排程器 wake timer／設不睡眠）。Scheduler 啟動時也要做 **missed-run 補跑判斷**（睡醒後發現錯過的排程要不要補）。

---

## 4. 自動接續（限額自醒續跑，銜接 Part C）

- Run 撞 5h 限額 → 狀態 `limited-waiting` + 記 `resetAt`（`detectRateLimit` 已會解析）。
- Scheduler 在 `resetAt` 自動排一個「續跑」：把 Part C 存的半成品 + 硬碟現況餵回**同一顆模型**接續（同模型才省 token、語意連續）。
- 受 `guardrails.maxResumes` 限制，避免無限自醒。

### 4.1 排程串接 `chainNext`（SCHED-CHAIN）

- 排程可選填 `chainNext: <排程id>`。當該排程一次 Run 以**真正 `success`** 收尾時（`onComplete` 內），自動以 `triggerNow(chainNext)` 觸發下一筆。
- 只有 `success` 會接續：`failed` / `blocked` / `limited-waiting` 都**不**觸發下一筆——確保前一階段真的做完才進下一階段（例：DTS-A 成功 → 自動接 DTS-B）。
- 複用既有手動觸發路徑：`triggerNow` 不看 `enabled`（被接的那筆可維持 `enabled:false`），並有「同一筆已在跑」防重入。自我串接（`chainNext===自身id`）被忽略，避免遞迴。
- **UI（可視化接線）**：編輯排程表單有「成功後接續」下拉，列出**同工作區**所有排程（含已成功／停用／歸檔者，不排除——例行排程可反覆被接）、排除自己；排程清單會把串接的排程**排相鄰**（`orderScheduleChains`：鏈頭→被接者），並在名稱旁標「↘ 接續：<名稱>」＋左側走線槽用 SVG 曲線＋箭頭把 source row 連到 target row。`createSchedule` 需把 `chainNext` 納入白名單持久化（`updateSchedule` 走 `Object.assign` 直通）。
- **SCHC：接棒前必須重讀最新設定，不可信任開跑時的舊快照**（2026-10-03 修）——`onComplete` 原本判斷 `chainNext`／`postRun.deploy` 時用的是任務**開跑那一刻**閉包捕獲的 `schedule` 物件；指揮官若在排程**執行中**把 `chainNext` 清空或改掉，上一棒跑完仍會接到舊設定指定的下一棒（已重現的真實 bug）。修法對齊 SCHED-DEPLOY Z5-3 的既有寫法：`onComplete` 尾端判斷前先 `schedulerManager.getSchedule(schedule.id)` 重讀一次（命名 `fresh`），之後一律以 `fresh.chainNext`／`fresh.postRun` 為準；`fresh` 讀不到（排程已被刪）則不接棒也不部署。語意＝「指揮官中途改了，就以改完的為準」。

---

## 5. 護欄（自主執行的安全閥，非可選）

排程＝在你不看著時自動花共用 quota。第一版就要有：
- 每條排程：`maxCalls`（最多幾次模型呼叫）、`maxRuntimeMs`（單次最長）、`maxResumes`（最多自醒幾次）、`failureBreakAfter`（連續失敗 N 次 → 停用 + 通知，不無限重試）。
- 全域可加「每日總預算」上限（跨排程）。

---

## 6. Delivery sinks（為 Telegram/手機鋪路）

- 每條 Schedule 可掛 `delivery` 目標：`web`（站內動態）/ `telegram` / `email`。
- Run 完成 → 把摘要 + 產出連結投到各 sink。
- **Telegram 只是「另一個讀同一份資料的消費端 + 通知器」**：跑完推一則、或你問「今天做了什麼」回今日 Run 摘要。核心邏輯不因加 Telegram 而改。

### 6.1 通知摘要可由 prompt 自訂內容（NOTIFY-SUM）

- **問題**：`success` 狀態的通知摘要原本固定寫死「執行完成，產出已儲存。」——排程實際做了什麼（例如 FTP 排程「沒有新檔案」還是「新下載了 a.csv, b.csv」）看不到，得點開 transcript 才知道。
- **做法**：沿用 `<memory-candidate>` / `<run-outcome>` 同一套「prompt 尾端附加系統指令 → agent 輸出機器可讀標記 → `onComplete` 剝除並解析」pattern，零新機制：
  - `fireScheduledJob`（`portal/server.js`）在排出的 prompt 尾端固定附加指令，要求 agent 完成任務後在回覆最末尾附一句話重點：`<notify-summary>一句話重點</notify-summary>`。
  - `onComplete` 解析並剝除此標記（不進存檔 transcript、不影響 `isFailed` 判定），若有內容則覆蓋預設摘要：`deliverSummary = notifySummary || '執行完成，產出已儲存。'`。
  - 只作用於 `success` 狀態；`failed`（用錯誤訊息）與 `blocked`（用 `outcomeReason`，見 `SPEC-schedule-status.md`）維持各自既有摘要邏輯，不被覆蓋。
  - 標記為**選填**：agent 若省略，退回原本固定文案，不影響既有排程的行為。
- 好處：每條排程不用改核心程式碼，直接靠自己的 prompt 決定「要回報什麼重點給指揮官」——跟 prompt 本身怎麼寫任務是同一個地方。

---

## 7. UI（網頁「排程」清單，借用歷史對話版型）

- 側邊欄一個「📅 排程」區：列出各 Schedule（名稱、**下次何時起**、模型、啟用開關、最近一次狀態）。
- 點一條 → 詳情：任務內容（prompt/skill）、**Run 歷史**（時間/狀態/用量）、每次的**產出物**（可點開看報告/transcript，如同點開一段歷史對話）。
- 新增/編輯排程：名稱、觸發、任務、固定模型、工作區、護欄、delivery。

---

## 8. Hana 自我感知（Run log 也是 Hana 的記憶）

- Run 歷史不只給 UI 看，也要能**餵回 Hana / 可查詢**：讓 Hana 能回答「我今天做了什麼」、避免重複做、跨排程引用先前產出。
- 提供查詢介面（如 `/api/schedules/runs?since=...`）兼供 UI、Telegram、Hana 自身使用。

---

## 9. API 介面（草案）

| 端點 | 用途 |
|---|---|
| `GET /api/schedules` | 列出排程（含 nextRunAt、最近狀態、`running` 執行中狀態） |
| `POST /api/schedules` / `PUT /api/schedules/:id` / `DELETE` | 建/改/刪排程 |
| `POST /api/schedules/:id/run` | 立即手動觸發一次 |
| `GET /api/schedules/:id/runs` | 某排程的 Run 歷史 |
| `GET /api/runs/:runId` | 單次 Run 詳情 + 產出 |

---

## 9.1 執行中中斷（SCHED-ABORT / SCH-STOP）

- **語意（先講清楚，貫穿實作與 UI 文案）**：中斷是「叫停」不是「還原」。已寫入的檔案、已編譯上線的程式、已過帳的資料**都不會退回**，會停在半套狀態；排程本身不會被停用，下次仍照原排程觸發。
- **API**：`POST /api/schedules/:id/abort` —— 取該排程目前 `running` 的 run（`schedulerManager.getRunningRun(id)`），讀其 `jobId` 呼叫既有 `abortJob(jobId)`（跟聊天停止鍵同一套機制）。
  - 工作區隔離（§5 鐵則）：`resolveWorkspace(req)` 正規化後需與 `schedule.workspace || WORKSPACE_ROOT` 相符，不符回 `403 {ok:false,error:'forbidden-workspace'}`。
  - 無執行中 run → `409 {ok:false,error:'not-running'}`；run 存在但 `jobId` 缺或 job 已不在 → `409 {ok:false,error:'no-job'}`（不偽造成功）。
  - 成功 → `200 {ok:true,runId}`；中止只是送出 `SIGINT` 訊號，實際收尾（寫入 run 狀態）仍在該 job 的 `onComplete` 完成，非同步。
- **Run 狀態機新增 `aborted`**（終態之一，`fireScheduledJob` 的 `onComplete`）：`ctx.aborted`（由 `abortJob()` 設）或 `meta.reason==='aborted'` 時，優先於泛用的 success/failed 判定，直接記 `status:'aborted'`、`delivery.summary` 固定「🛑 已由指揮官中止（已產生的變更不會自動還原）」。
- **三條規則**：
  1. 中止**不觸發 `chainNext`**（`onComplete` 在 aborted 分支直接 `return`，不落入下方 chain/deploy 判斷）。
  2. 中止**不觸發 `postRun.deploy`**（同上，早 return）。
  3. 中止**不計入連續失敗**：`recordRunOutcome` 的熔斷豁免清單（`limited-waiting`/`blocked`/`noop`）新增 `aborted`——人為叫停不代表排程本身壞掉，不該推高 `consecutiveFailures` 或誤觸自動停用。
- **UI**：`portal/views/schedule.js` 清單「執行中」徽章旁加 🛑 停止鈕，點擊先跳確認對話框（講清楚①叫停非還原②半套狀態③排程不會被停用），成功後沿用既有輪詢刷新；失敗把 `not-running`／`no-job`／`forbidden-workspace` 轉成可讀中文。

## 9.2 排程詳情的 prompt 呈現（SCH-MDP）

- **問題**：Hana 寫的排程 prompt 幾乎都是 Markdown（`##` 標題、清單、反引號、表格），但排程詳情頁（`schedOpenDetail`）與「執行內容（唯讀）」的 Prompt／回覆（`schedOpenRun`）先前都只用 `escHtml` 塞進等寬 `<pre>`，連換行都被 HTML 折疊掉，指揮官審閱不了指示內容。
- **拍板**：**預設渲染成 Markdown**，並提供一顆「原始文字／Markdown」切換鈕（有些 prompt 是純文字或靠縮排排版，需要能切回等寬原文）；切換狀態只存記憶體，不持久化。**不改儲存格式**——後端仍存純字串，`task.prompt` 不變。
- **渲染引擎**：沿用 `portal/index.html` 已全域載入的 `window.marked`（`/vendor/marked.min.js`），**不新增任何第三方套件、不引入 DOMPurify**。`window.marked` 缺席時退回 `escHtml` + `whitespace-pre-wrap` 純文字顯示（防呆）。
- **最小消毒策略**：`marked.parse(text, {breaks:true, mangle:false, headerIds:false})` 產出的 HTML 用 `DOMParser` 走一次，移除 `<script>`／`<style>` 節點、移除所有 `on*` 屬性、拔掉 `javascript:` 開頭的 `href`／`src`。這不是通用消毒器，只防排程 prompt（指揮官／Hana 自己寫的內容）裡意外或惡意夾帶的可執行內容，範圍限定在這個唯讀展示情境。
- **樣式**：注入一段 scoped CSS（`.md-render`，`portal/views/schedule.js` 的 `ensureMdStyle()`，只注入一次到 `<head>`），涵蓋標題階層／清單／`code`／`pre`／`table`／`blockquote`，並用 `.dark .md-render` 補深色模式配色。選 scoped CSS 而非逐一補 Tailwind class：`marked` 產出的標籤種類多，逐個補 class 維護成本高。
- **涵蓋範圍**：① 排程詳情頁的 prompt 卡片（`schedOpenDetail`，含 `max-h-[60vh] overflow-y-auto` 避免超長指示撐爆頁面）；② 「執行內容（唯讀）」的 Prompt／回覆（`schedOpenRun`，原 `<pre>` 改 `<div>`，沿用既有 `max-h-32`／`max-h-64`），兩處共用一顆切換鈕（`sched-run-md-toggle`）同時切 Prompt 與回覆。
- **不受影響**：「逐字稿已清理」「（無 prompt）」「（無回覆）」「載入失敗」等 Hana 自己組的提示訊息一律標記 `isNotice`，走 `escHtml` 純文字路徑，不當 Markdown 解析。
- **SRR（2026-09-23 追加）**：「執行內容（唯讀）」原本 Prompt／回覆各半，但 Prompt 就是排程本體那段指示、指揮官建排程與排程詳情頁都看得到，等於同一份文字再印一次，反而把真正要讀的回覆壓成小窗。改為**回覆是主體**（`sched-run-detail-reply` 容器放大到 `max-h-[60vh]`，置於上方），**Prompt 改成預設收合的 `<details>`**（summary「查看本次 Prompt」，展開後維持原本 `max-h-32`），需要對照時才展開；`sched-run-md-toggle` 切換鈕行為不變，同時作用於兩欄。**只動「執行內容（唯讀）」（`schedOpenRun`），排程詳情頁（`schedOpenDetail`）的 prompt 卡片維持原樣不動。**

---

## 9.3 即時更新（SLV：SSE 推播 → 前端自動刷新）

- **問題**：指揮官長時間開著排程頁。① 排程跑完後狀態不會自己變（執行中 → 成功／失敗要按 F5 才看得到）；② 在另一個分頁請 Hana 新建排程，這一頁不會出現那筆，清單也沒有「重新整理」按鈕，只能重整整個瀏覽器。
- **拍板**：走業界標準 **SSE（Server-Sent Events）＋「變更通知 → 前端重新抓取」**——後端只推一個輕量「排程資料有變動」事件，**不推整包資料**（避免前後端兩份狀態不同步），前端收到就重新呼叫既有的 `GET /api/schedules` / `GET /api/activities` 重繪。不用 WebSocket（過重）、不用純輪詢當主要手段（有延遲）、不引入任何 npm 套件。
- **變更通知出口（`portal/scheduler.js`）**：`SchedulerManager.setChangeListener(fn)` 可注入一個監聽器（未注入為 no-op，不拋錯）；`createRun()`（run 開始）與 `updateRun()`（狀態／進度變動，含 run 結束——最終狀態寫入同樣經 `updateRun()`）呼叫 `_emitChange(reason, scheduleId, runId)`，內部解析出該排程的 `workspace`（`schedule.workspace || null`），payload 固定 `{ reason, scheduleId, runId, workspace }`。
- **SSE 端點**：`GET /api/schedules/stream`（`portal/server.js`）。回應標頭 `text/event-stream` + `Cache-Control: no-cache` + `Connection: keep-alive`；每 25 秒送 `: ping` 心跳防中斷代理逾時關閉連線；`req.on('close')` 移除連線集合並清心跳計時器。連線註冊時記錄「正規化後的 workspace」，`schedulerManager.setChangeListener(broadcastScheduleChange)` 接上後只廣播 `event: schedules-changed` 給同工作區的連線。
- **寫入型路由也各自廣播一次**（`portal/server.js`）：`POST /api/schedules`、`PUT /api/schedules/:id`、`DELETE /api/schedules/:id`、`POST /api/schedules/:id/run`、`POST /api/schedules/:id/abort`、`DELETE /api/activities/:id`（通知 dismiss）——確保「在別的分頁新建排程，這一頁立刻長出來」；`/run` 的廣播與 `createRun()` 內建的 `run-start` 廣播會重複一次，無害（前端已 debounce）。
- **工作區隔離（鐵則）**：`EventSource` 不能帶自訂標頭，工作區改用 query param 傳（`?workspace=<encodeURIComponent(root)>`，`resolveWorkspace(req)` 本已支援從 query 讀取）；server 端一律 `path.resolve()` ＋小寫正規化後比對，`null`／未帶＝`WORKSPACE_ROOT`，只推給同工作區的連線，絕不跨工作區外洩。
- **前端（`portal/views/schedule.js`）**：`mount()` 呼叫 `startScheduleStream()` 開一條 `EventSource`，收到 `schedules-changed` 事件後 **debounce 300ms** 再重新 `schedLoadList()` + `loadActivities()` + `refreshSchedBadge()`（重繪前記錄 `window.scrollY`，重繪後還原，避免版面彈回頂端；歷史排程的 `<details>` 若指揮官手動展開過，重繪也不強制收合）；`unmount()` 呼叫 `stopScheduleStream()` 關閉連線（router mount/unmount 合約，見 `portal/router.js`），避免切換檢視後連線殘留累積。
- **保底**：`EventSource` 連續失敗達 3 次（`onerror` 累計、`onopen` 歸零）→ 關閉該連線、改用 `setInterval` 每 15 秒輪詢，且僅在 `document.visibilityState === 'visible'` 時打；分頁從背景切回前景時（輪詢模式下）立即補抓一次，不等下個 15 秒。
- **手動保底**：排程清單標題列補一顆「↻ 重新整理」按鈕（`sched-btn-refresh-list`），與既有「近期動態」「精華待審」的重新整理鈕同款，供 SSE／輪詢都失效時仍能手動刷新。
- **明確不做**：不改排程執行邏輯、不改資料存檔格式、不引入任何 npm 套件、不做 WebSocket、不把完整排程資料塞進事件、不動 Telegram 推播。

---

## 9.4 批量歸檔與串接連動（SBA）

- **問題**：指揮官有大量指定時段（多為半夜跑）的排程，執行成功後要歸檔。現況只能一列一列按「📥 歸檔」，筆數多時極繁瑣；而串接在一起的排程（`chainNext`）若只歸檔其中一筆，留在現役的那筆會指向已歸檔的對象，接續關係斷在半空中。
- **拍板（Charles 2026-10-01）**：
  1. 現役清單與歷史清單各列加入**勾選框**、表頭加**全選**，上方出現「已選 N 筆」工具列（現役＝「批量歸檔」；歷史＝「批量復原」）。
  2. **整串連動**：勾選任一筆 → 自動帶入其所屬**整條鏈的所有成員**（上游＋下游全部，不只下游）；取消勾選同樣整串一起取消。理由：只歸檔一半會留下指向已歸檔對象的斷鏈。
  3. **不另外問「要不要一起」**：既然勾選已自動連動，歸檔前改以**確認摘要彈窗**呈現——「即將歸檔 N 筆，其中 M 筆因串接被一併帶入：X、Y、Z」，並提供「只歸檔我原本點選的那幾筆」退出路徑（不連動版本）。
  4. **執行中的排程自動跳過**（歸檔會順手停用，不該打斷正在跑的那筆），並在摘要中明示被跳過的筆數與名稱。
  5. **「尚未執行成功過」的排程不禁止歸檔**，但在確認摘要上標註，讓指揮官自行判斷。
- **實作方式**：純前端（`portal/views/schedule.js`）＋沿用現成的 `PUT /api/schedules/:id`（`{archived, enabled}`）逐筆呼叫，**不新增 API、不新增資料欄位、不動排程執行邏輯**。批量呼叫以小並發（如 4 筆並行）送出，任一筆失敗不中斷其餘，結束後回報「成功 N 筆 / 失敗 M 筆」並重新載入清單。
- **鏈的求法**：以 `chainNext` 建無向連通分量（既有 `orderScheduleChains()` 已有 `byId`／`nextOf` 的作法可借用），需容忍環狀與「多筆指向同一目標」的情形，並且只在**同工作區**的清單資料內計算（清單本身已經過工作區過濾）。
- **明確不做**：不新增後端路由、不改 `archived` 的語意、不做批量刪除（破壞性，維持逐筆）、不動 SSE 推播機制（批量操作後讓既有 SSE／重新載入處理刷新）。
- **實作備註（誠實標註近似值）**：資料模型沒有「曾經成功過」欄位，確認摘要的「尚未成功執行過」一項以 `lastRunStatus !== 'success'`（含從未執行過）近似判定——這只是提示用途、不影響是否可歸檔，但不是精確的「歷史上從未成功」語意（若某排程曾成功、但最近一次失敗，也會被標在此列）。若日後要做精確判定，需在 Run 歷史新增彙總欄位。

---

## 10. 待拍板的開放問題
1. ~~cron 表達式自己解析，還是引入輕量套件？（避免重型依賴）~~ **已拍板 2026-08-13**：維持自解析（不引入套件），但補齊到跟業界標準一致的子集——範圍 `A-B`、清單 `A,B,C`、`A-B/N`（詳見 §2.1.1）。現況 `parseCronField` 只認 `*`／`N`／`*/N`，缺這兩種業界標準寫法。待辦：`SCH-CRON`（見 worktable）。
2. `missed-run`：睡醒後錯過的排程要補跑、跳過、還是只補最近一次？
3. delivery 第一版只做 `web`（站內），Telegram 留下一階段？
4. 護欄的「每日總預算」用「呼叫次數」還是「時間」計？（CLI 查不到精確 token）
5. 排程任務的工作區：固定綁一個，還是可選 `_harness` 自身（自我診斷類）？

---

## Changelog
| Date | Version | Author | Description |
|:-----|:--------|:-------|:------------|
| 2026-06-20 | v0.1 | 老闆 + Claude | 初版架構草案。執行者/觀看者分離、三層資料模型（Schedule/Run/Artifact）、內建優先（何時拆 worker）、限額自醒續跑銜接 Part C、護欄、delivery sinks、排程清單 UI、Hana 自我感知。 |
| 2026-06-27 | v0.2 | 老闆 + Claude | B6：Run 增 `trigger`（auto/manual）與 `interrupted` 終態；狀態機、防重入（triggerNow 守衛 + 409）、開機 orphan 對帳、清單即時「執行中」狀態（`GET /api/schedules` 附 running）。 |
| 2026-07-11 | v0.3 | 老闆 + Hana | SCHED-CHAIN：排程新增 `chainNext` 欄位，一次 Run 真正 `success` 時自動 `triggerNow` 下一筆（失敗/護欄停手/限額等待皆不接續）；複用手動觸發路徑、被接筆可維持 disabled、防自我遞迴。首用：DTS-A 成功→自動接 DTS-B。 |
| 2026-07-11 | v0.4 | 老闆 + Hana | SCHED-CHAIN 可視化：編輯表單加「成功後接續」下拉（同工作區全列、排除自己、不排除已成功者）；清單把串接排相鄰＋名稱旁「↘ 接續」標記＋左側 SVG 箭頭曲線連到目標。`createSchedule` 白名單補 `chainNext`。 |
| 2026-08-13 | v0.5 | 老闆 + Hana | 新增 §2.1.1 cron 欄位語法：拍板維持自解析、補齊範圍 `A-B` 與清單 `A,B,C`（含 `A-B/N`）到業界標準子集，解掉 §10 開放問題 1。實作待辦 `SCH-CRON`（worktable）。 |
| 2026-08-13 | v0.6 | 老闆 + Hana | 新增 §6.1 NOTIFY-SUM：`success` 通知摘要可由排程自身 prompt 透過 `<notify-summary>` 標記自訂，取代固定文案「執行完成，產出已儲存。」；沿用 `<memory-candidate>`/`<run-outcome>` 同款附加-剝除 pattern，選填、不影響既有排程。實作已於 `portal/server.js` `fireScheduledJob`/`onComplete` 落地，待辦 `SCH-NOTIFY`（worktable，手動 schedule）。 |
| 2026-09-09 | v0.7 | 老闆 + Hana | 新增 §9.1 SCHED-ABORT：執行中的排程可被中斷（🛑 停止鈕）。新增 `POST /api/schedules/:id/abort`（複用既有 `abortJob`）、Run 狀態機新增 `aborted` 終態、三條規則（不觸發 chainNext／不觸發 postRun.deploy／不計入連續失敗熔斷）。語意明講「叫停不是還原」。實作待辦 `SCH-STOP`（worktable，手動 schedule）。 |
| 2026-09-09 | v0.8 | 老闆 + Hana | 新增 §9.2 SCH-MDP：排程詳情頁與執行內容（唯讀）的 Prompt／回覆改預設 Markdown 渲染（沿用既有 `window.marked`，不新增套件），提供原始文字／Markdown 切換鈕；`DOMParser` 做最小消毒（移除 script/style、on\* 屬性、javascript: 連結）；新增 `.md-render` scoped CSS 支援深色模式。實作於 `portal/views/schedule.js`（手動 schedule）。 |
| 2026-09-23 | v0.9 | 老闆 + Hana | §9.2 補 SRR：「執行內容（唯讀）」改以 AI 回覆為主體（容器放大到 `max-h-[60vh]`），Prompt 改預設收合的 `<details>`（不刪除，需要對照時展開）；只動 `schedOpenRun`，排程詳情頁的 prompt 卡片不動。實作於 `portal/views/schedule.js`（手動 schedule，**尚未 Deploy**）。 |
| 2026-09-23 | v0.10 | 老闆 + Hana | 新增 §9.3 SLV：排程頁即時更新——SSE（`GET /api/schedules/stream`）＋「變更通知→前端重抓」，`SchedulerManager.setChangeListener` 接上 run 起訖/狀態變動、寫入型路由各自廣播一次；工作區以 query param 隔離；前端 debounce 300ms 重繪、不強制收合已展開的歷史區塊、不彈回頂端；SSE 連續失敗 3 次退回可見分頁 15 秒輪詢，並補「↻ 重新整理」手動按鈕。實作於 `portal/scheduler.js`／`portal/server.js`／`portal/views/schedule.js`（手動 schedule，**尚未 Deploy**）。 |
| 2026-10-01 | v0.11 | 老闆 + Hana | 新增 §9.4 批量歸檔與串接連動（SBA）：清單加勾選框＋全選＋批量歸檔/復原工具列；勾選自動連動整條 `chainNext` 鏈（上下游全帶）；歸檔前以確認摘要列出被連帶的筆數與名稱並提供「只歸檔原本點選」退路；執行中排程自動跳過。純前端＋沿用 `PUT /api/schedules/:id`，不新增 API/欄位。 |
| 2026-10-01 | v0.12 | 老闆 + Hana | SBA 實作落地（`portal/views/schedule.js`）：`schedChainGroups()` 用 union-find 建無向連通分量（容忍環狀/多指向同目標）、現役與歷史表各自獨立選取狀態與鏈分組；全選＝整個分類（不只當頁）；確認摘要四類分項含「尚未成功執行過」近似判定（見 §9.4 實作備註）。自測以純 Node 腳本鏡射核心函式＋假 `fetch`（`.worktable/artifacts/sba/mirror-test.js`，18 項斷言全過，未起任何 server/佔用任何埠）。手動 schedule，**尚未 Deploy**。 |
| 2026-10-03 | v0.13 | 老闆 + Hana | 修 SCHC：`onComplete` 判斷 `chainNext`／`postRun.deploy` 前補重讀最新設定（對齊 SCHED-DEPLOY Z5-3 寫法），修掉「串接執行中被改設定、上一棒跑完仍接到舊棒」的真實 bug；`fresh` 讀不到（排程已刪）則不接棒不部署。實作於 `portal/server.js`（手動 schedule，**尚未 Deploy**，等全機閒置後由 §SCHD 統一部署）。 |

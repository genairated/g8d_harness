# SPEC-view-chat-context — 讓 Hana 看得懂「你現在在哪個畫面」

> 狀態：草案（方案 A 已由指揮官拍板，見 §2）
> 相關：`specs/SPEC-portal-architecture.md`（§3.1 router / view 模組）、`specs/SPEC-plugin-contract.md` §3（view 契約）、`specs/SPEC-scheduler.md`
> 任務：`.worktable/TASK.md` §CTX

---

## 1. 問題

§V 路由重構把每個面板變成 view module（`mount` / `unmount` / `meta`），統一了**畫面**；但頭像浮動對話的「Hana 現在看得到什麼」**沒有跟著重構**，仍是一份寫死的特例清單：

| 現況 | 位置 |
|---|---|
| 只認 `/app/documents` 一條路由，其餘一律 fallback 到 wiki 的 `currentFilePath`（預設 DASHBOARD.md） | `portal/index.html` `_floatChatTarget()`（約 6835） |
| 會議、PM 各自另開一個入口函式，塞自己的欄位 | `openFloatChatForMeeting()`（5728）、`openFloatChatForPm()`（5768） |
| 頭像點擊用 `location.pathname === ...` 的 if 鏈分派 | `openFloatChatFromAvatar()`（7025） |
| `/api/chat` body 是三個平行參數 `filePath` / `meetingId` / `pmProjectIds` | `server.js` 2002 / 2023 / 2143 |
| `buildChatPrompt()` 用三段硬編 `if` 注入 | `server.js` 7798 起 |

**排程（`/app/schedule`）從頭到尾沒被登記進這三條任何一條**，所以在排程頁點頭像只會掉進檔案 fallback，標題變成「討論：DASHBOARD.md」。CodeGraph、DocGraph、便條貼、音訊主題等 view 同樣沒有脈絡。

根因一句話：**脈絡不是 view 契約的一部分，而是外面打的補丁**——每多一個 view 就要再挖一次同樣的洞。

## 2. 已拍板的決策

| # | 決策 | 選定 |
|---|---|---|
| D1 | 做法 | **方案 A**：把「脈絡」升格成 view 契約的一部分（`getChatContext()`），一次解決所有 view，不再逐個特例 |
| D2 | 排程脈絡的範圍 | **跟著畫面走**：在清單頁 → 針對「本工作區整份清單」；已進入某一筆排程（detail）→ 只針對那一筆 |
| D3 | 深度 | 同 D2：清單頁給摘要（每筆一行）；detail 給該筆完整內容（含 task 指示全文、近期執行記錄） |
| D4 | 權限 | **可讀可寫**——Hana 可直接依指示改排程（停用／改時間／建立／刪除），對話就是要能直接做事 |

## 3. 設計

### 3.1 前端：view 契約新增 `getChatContext()`

`portal/views/README.md` 的契約增補一個**選用**匯出：

```js
// 選用。回傳 null 或不實作 → 該 view 沿用既有的檔案模式（wiki currentFilePath）。
export function getChatContext() {
  return {
    kind: 'schedule',            // provider 名稱，後端據此分派
    key: 'schedule:list',        // 脈絡識別；變了就重開一段 session
    label: '排程清單（本工作區）', // 浮動視窗標題用
    payload: { scope: 'list' }   // 傳給後端 provider 的資料（只傳 id/範圍，不傳內容）
  };
}
```

規則：
- **payload 只帶識別（id、scope），不帶內容**。內容一律由後端 provider 從真相來源（檔案／store）現讀，避免前端狀態過期或被竄改。
- 不實作 = 退回檔案模式，**既有未遷移的 view 完全不受影響**。

### 3.2 router：記住當前 module，代為取脈絡

`portal/router.js` 的 `render()` 已 `import` 到 module，多存一份 `currentModule`；新增：

```js
window.router.getChatContext = function () {
  try { return currentModule && currentModule.getChatContext ? (currentModule.getChatContext() || null) : null; }
  catch (e) { return null; }
};
```

`unmount` 時清掉 `currentModule`。

### 3.3 `openFloatChatFromAvatar()` 改為單一路徑

```
ctx = router.getChatContext()
ctx ? 綁 ctx（標題 = '討論：' + ctx.label，ctx.key 變了才重開 session）
    : 既有檔案模式（openFloatChat()）
```

`location.pathname === '/app/meeting' | '/app/pm' | '/app/documents'` 三條 if **全部刪除**，改由 `views/meeting.js`、`views/pm.js`、`views/documents.js` 各自實作 `getChatContext()` 回報自己的脈絡。`openFloatChatForMeeting()` / `openFloatChatForPm()` 保留為內部細節或一併收斂（見 §5 分階段）。

### 3.4 後端：`context` 單一參數 ＋ provider 註冊表

`/api/chat` body 新增 `context: { kind, payload }`（`filePath` / `meetingId` / `pmProjectIds` **保留相容**，進入點若收到舊欄位就就地轉成對應 context）。

`buildChatPrompt()` 的三段硬編 `if` 換成：

```js
const CHAT_CONTEXT_PROVIDERS = {
  file:     (payload, wctx) => ...,   // 由既有 filePath 區塊搬移，行為不變
  meeting:  (payload, wctx) => ...,   // 同上
  pm:       (payload, wctx) => ...,   // 同上
  schedule: (payload, wctx) => ...,   // 新增，見 §3.5
};
```

`buildChatPrompt()` 只負責 `p += (CHAT_CONTEXT_PROVIDERS[ctx.kind] || (() => ''))(ctx.payload, wctx)`。
未知 kind → 回空字串，不報錯（外掛 view 亂填也不會炸掉聊天）。

> 註：`injectActivityContext` / `injectNotesContext` / `injectPmContext` 是**全域**注入（每段對話都給的背景），與本機制無關，維持原樣不動。

### 3.5 schedule provider

**護欄（鐵則）**：一律照工作區過濾——`scheduleId → schedule.workspace`，比對前 `path.resolve()` + 小寫正規化，`null workspace` 視為 `WORKSPACE_ROOT`。與 `GET /api/schedules`、`injectActivityContext` 同一套 pattern。

| payload | 注入內容 |
|---|---|
| `{ scope: 'list' }` | 本工作區全部排程，每筆一行：名稱、id、觸發（cron/interval/once）、啟用狀態、模型、`postRun.deploy`、`chainNext`、上次執行時間與結果。task 指示截斷至 200 字。 |
| `{ scheduleId }` | 該筆完整內容：所有欄位 ＋ **task 指示全文**（截斷 8KB）＋ 最近 5 筆執行記錄（時間、狀態、耗時、log 尾端各 1KB）。 |

寫入授權文字（沿用 `server.js` 5717/5742 既有措辭，保持一致）：告知 Hana 可用 `POST/PUT/DELETE /api/schedules[/:id]` 修改，並明示**「排程／schedule」指本地 Harness 排程器，不是 CronCreate/CronList 那套雲端工具**。

**額度護欄**：`POST /api/schedules/:id/run`（立即執行）會真的燒模型額度，provider 文字要求 Hana **執行前先向指揮官確認**；讀取、改設定、停用不需確認。

### 3.6 session 綁定

浮動對話目前用 `filePath` 查歷史（`GET /api/chat-sessions?filePath=`）。非檔案脈絡（meeting/pm）現況是直接開新 session、不給接續選單——**本階段沿用**，`ctx.key` 只用來判斷「脈絡換了 → 清空訊息重開」。跨脈絡的 session 續接留待後續（§6）。

## 4. 影響範圍

| 檔案 | 動作 |
|---|---|
| `portal/views/README.md` | 契約文件增補 `getChatContext()` |
| `portal/router.js` | 記 `currentModule`、匯出 `getChatContext()` |
| `portal/index.html` | `openFloatChatFromAvatar()` 收斂；`_floatChatTarget()` 的 documents 特例移除；`/api/chat` 改送 `context` |
| `portal/views/schedule.js` | 新增 `getChatContext()`（依 `_schedDetailId` 判斷 list / detail）＋ 頭像可用性 |
| `portal/views/documents.js`、`meeting.js`、`pm.js` | 各自新增 `getChatContext()` |
| `portal/server.js` | `/api/chat` 收 `context`；`buildChatPrompt()` 改 provider 註冊表；新增 schedule provider |

## 5. 分階段

- **CTX1 骨架**：view 契約 ＋ router ＋ `openFloatChatFromAvatar()` ＋ 後端 `context` 參數與 provider 註冊表（既有 file/meeting/pm 三段原樣搬進 provider，**行為必須不變**）。舊欄位相容保留。
- **CTX2 schedule provider**：list / detail 兩種 payload ＋ 工作區過濾 ＋ 寫入授權與額度護欄。
- **CTX3 既有 view 收斂**：documents / meeting / pm 改由自己的 `getChatContext()` 回報，刪除 index.html 三條 pathname if。
- **CTX4（選用）**：codegraph / docgraph / notes / audio-topics 等其餘 view 補脈絡。
- **CTX5 白板**（2026-08-05 補做）：`views/whiteboard.js` 的 `getChatContext()`（`kind:'whiteboard'`，payload 只帶 `boardId`）＋ server 端 `whiteboard` provider——現讀 `board.json` 注入標題／元素統計／每元素一行（含容器綁定文字與箭頭 binding），並附 `SPEC-whiteboard.md` §8 的寫入授權（`POST /api/whiteboards/:id/elements`；`mode:"replace"` 為破壞性、須先確認）。**教訓**：新 view 上線時若沒同步實作 `getChatContext()`，頭像就會安靜地退回檔案模式、變成「討論：DASHBOARD.md」——沒有任何錯誤訊息，只能靠使用者發現。日後新增 view 應把「實作 `getChatContext()`」當成 view 契約的預設項目。

## 6. 明確不做（本 spec 範圍外）

- 排程清單的**勾選 UI**（多選特定幾筆）——D2 已定為「跟著畫面走」，清單頁即全部，不需勾選。
- 跨脈絡的 session 接續選單。
- Telegram 端的脈絡對齊（Telegram 走 `getContext(chatId).root`，另一條線）。

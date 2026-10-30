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

**排程（`/app/schedule`）從頭到尾沒被登記進這三條任何一條**，所以在排程頁點頭像只會掉進檔案 fallback，標題變成「討論：DASHBOARD.md」。CodeGraph、DocGraph、便條貼、音訊主題等 view 當時同樣沒有脈絡（CodeGraph、便條貼已於 §3.7 補上；DocGraph、音訊主題仍待補，見 §5 CTX4）。

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

**通則（適用所有現在與未來的 view）：只要一個功能畫面上有「使用者當下正在看的東西」（一份文件、一筆會議、一個專案、一張白板、一筆排程……），該 view 就必須實作 `getChatContext()` 把它回報出來**，讓指揮官在該功能裡點 Hana 頭像就能直接對話。判定條件要**涵蓋該功能所有檢視/子模式**，不能只認其中一種——只認一種的話，其他檢視下會靜默退回檔案模式（標題變成「討論：DASHBOARD.md」），使用者以為 Hana 在看 A、其實在看 B。（實例：PM 曾只認多專案甘特圖，清單／看板選的專案被忽略，見 `SPEC-project-management.md` §7.3。）新功能上線前的自測要包含「在每個檢視下點頭像，標題是否正確」。

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

### 3.7 codegraph / notes provider（CTX4，2026-08-17 補做）

**CodeGraph 探索器**（`views/codegraph.js`）：`getChatContext()` 依 `activeCgNode`（使用者當下點開的 symbol）判斷——

| payload | 注入內容 |
|---|---|
| `{}`（尚未點開任何 symbol） | 提示 Hana：使用者在這個面板，若問起程式直接用自己的 `codegraph_*` 工具查，不必等使用者點選。 |
| `{ symbol, filePath, startLine, kind }` | 只給識別碼（名稱／檔案／行號／種類），不在 server 端重複組一份 callers/callees/impact——Hana 本身就掛了 `codegraph_explore`/`codegraph_search`/`codegraph_callers`/`codegraph_callees`/`codegraph_impact`/`codegraph_node` 這些工具，直接查比 server 端再跑一次 CLI（`runCodegraph` 是非同步、需要 callback）更即時也更完整。這是本 spec 目前唯一一個 provider 不現讀資料源、只給識別碼轉交 Hana 自己查的例子。 |

**便條貼**（`views/notes.js`）：`getChatContext()` 回報 `kind:'notes'`，`payload:{}`。**便條內容本身早就由 `injectNotesContext()` 無條件注入每一次聊天**（SN2-03，跟使用者在哪個 view 無關），所以 `CHAT_CONTEXT_PROVIDERS.notes` 是刻意保留的空函式——只負責讓 `getChatContext()` 有回傳值（浮動視窗標題正確顯示「討論：便條貼」），不重複注入內容。

### 3.8 uidesign provider（CTX7，2026-08-21 補做）

**背景**：`views/uidesign.js` 早就有 `getChatContext()`，但 `payload` 是空的 `{}`、server 端也沒有 `uidesign` provider → 注入內容為零。因為未知 kind 的分派是「回空字串、不報錯」，這個缺口**完全無聲**：浮動視窗標題顯示正確、Hana 也答得很順，內容卻是憑印象編的（2026-08-21 客戶專案實例：把元件的預設文字拼成不存在的畫面名稱）。

| payload | 注入內容 |
|---|---|
| 共通（所有 payload 都給） | 本工作區**真實存在**的元件／畫面／範本／UI操作演示各一行（名稱＋id，每類上限 80 筆），並明寫「清單裡沒有的就是不存在，不得臆造」。這一段是防幻覺的主力。 |
| `{ mode:'flows', flowId }` | 該條演示的情境說明、逐步驟（說明／引用畫面名稱／是否標熱區／是否須點熱區前進／備註），**外加每一步用到的畫面完整內容**（元件逐項＋覆寫文字）。 |
| `{ mode:'canvas', screenId }` | 該畫面的畫框尺寸、設計備註、元件逐項（元件名／角色／座標尺寸／覆寫文字／elId，上限 80）。 |
| `{ mode:'components', componentId }` | 該元件的說明、參數（含預設值）、變體。 |
| `{ mode:'templates' }` 等清單模式 | 只給共通清單。 |

資料一律用 `uidesignStore` 從 `<workspace>/.harness/uidesign/` 現讀，走 `wctx.root`，與所有 `/api/ui/*` 路由同一套工作區隔離。寫入授權：可直接 `POST/PUT/DELETE /api/ui/{components,screens,flows,templates}`；**刪除或整批覆寫前先問**，新增／改文案／加步驟不必問。

**教訓（通則）**：view 實作 `getChatContext()` 只是一半，**後端 provider 沒接＝Hana 全瞎**，而症狀是「答得很順但內容是編的」，比報錯更危險。日後新增 view 的自測項要包含「在該畫面問一個只有讀得到資料才答得出來的問題」，不能只看標題對不對。

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
- **CTX4（選用）**：codegraph / docgraph / notes / audio-topics 等其餘 view 補脈絡。**codegraph、notes 已於 2026-08-17 補上**（見 §3.7）；docgraph、audio-topics 仍待補。
- **CTX5 白板**（2026-08-05 補做）：`views/whiteboard.js` 的 `getChatContext()`（`kind:'whiteboard'`，payload 只帶 `boardId`）＋ server 端 `whiteboard` provider——現讀 `board.json` 注入標題／元素統計／每元素一行（含容器綁定文字與箭頭 binding），並附 `SPEC-whiteboard.md` §8 的寫入授權（`POST /api/whiteboards/:id/elements`；`mode:"replace"` 為破壞性、須先確認）。**教訓**：新 view 上線時若沒同步實作 `getChatContext()`，頭像就會安靜地退回檔案模式、變成「討論：DASHBOARD.md」——沒有任何錯誤訊息，只能靠使用者發現。日後新增 view 應把「實作 `getChatContext()`」當成 view 契約的預設項目。

- **CTX7 uidesign provider**（2026-08-21 補做）：見 §3.8。
- **CTX6 主題對話的歷史續接與清單隔離**（2026-08-20 拍板）：見 §7。這一階段把 §3.6／§6 原本延後的「跨脈絡 session 續接」正式補上，並把「不混進 AI 對話清單」通用化。

## 6. 明確不做（本 spec 範圍外）

- 排程清單的**勾選 UI**（多選特定幾筆）——D2 已定為「跟著畫面走」，清單頁即全部，不需勾選。
- ~~跨脈絡的 session 接續選單。~~ → 已改為要做，見 §7（CTX6）。
- Telegram 端的脈絡對齊（Telegram 走 `getContext(chatId).root`，另一條線）。

---

## 7. CTX6 — 主題對話的「歷史續接」與「清單隔離」通用化（2026-08-20 拍板）

### 7.1 定義（指揮官拍板，寫死為通則）

| | 定義 | 出現在「AI 對話」清單 | 有自己的歷史 |
|---|---|---|---|
| **AI 對話** | 自由對話。沒有綁定任何主題，只有從 AI 對話面板直接開的才算 | ✅ | ✅（就是那份清單） |
| **Hana 頭像對話** | 主題對話。永遠綁著使用者當下在看的那一樣東西 | ❌ 不得混入 | ✅ 依主題各自留存 |

**這條是新功能上線前的必檢項**，與 §3.3 的「所有 view 都要實作 `getChatContext()`」同一條規矩，只是把「歷史續接」與「清單隔離」也納入。

### 7.2 現況缺口（根因）

§3.6 當初把「非檔案脈絡不給續接選單」列為本階段不做，於是：

- **續接**：`fcOfferSessions()` 只認 `GET /api/chat-sessions?filePath=`，`_openFloatChatWithContext()` 根本沒呼叫它 → 排程／白板／UI 設計系統等主題每次點頭像都是空白。
- **隔離**：`getChatHistories()` 的排除條件寫死 `data.filePath || data.meetingId || data.pmProjectIds` 三種舊欄位；新脈絡走 `context` 參數，而 `saveChatSession()` **從未把 `context` 寫進 session 檔** → 這些對話在磁碟上與自由對話無異，全數混進 AI 對話清單。

一句話：**脈絡已經是 view 契約的一部分（§3.1 做到了），但「持久化」還停在舊的三個特例欄位。**

### 7.3 設計

**(1) session 檔記錄脈絡。** `saveChatSession()` 新增可選欄位（與 `filePath`/`meetingId`/`pmProjectIds` 並存，不取代）：

```json
{ "contextKind": "schedule", "contextKey": "schedule:sched_123", "contextLabel": "排程：每日 Spam 巡檢" }
```

`ctx.context` 由 `/api/chat` 進入點帶到 `finalizeChat`／`saveChatPending` 一路存下。**`contextKey` 就是前端 `getChatContext().key`**——它已經是穩定識別（`kind:id`），不必另外設計 key 規則。

**(2) 查詢改吃 contextKey。** `GET /api/chat-sessions` 新增 `ctxKey=` 參數（與既有 `filePath=` 二擇一，`filePath` 維持不動以保相容）：回傳該主題底下所有 session（`sessionId` / `title` / `updatedAt` / `contextLabel`），排序同既有。

**(3) 清單排除條件通用化。** `getChatHistories()` 的排除條件加上 `|| data.contextKind`。**注意 `notes` 這種 `payload:{}` 的全域型脈絡也會被排除**——這是正確的：它本來就是頭像對話，不該進自由對話清單。

**(4) 前端續接。** `_openFloatChatWithContext()` 在 `ctxKey` 改變的分支末端，把 `chooser.classList.add('hidden')` 換成 `await fcOfferSessions({ ctxKey: ctx.key })`；`fcOfferSessions()` 改為接受 `{ filePath }` 或 `{ ctxKey }`，內部組不同 query，其餘（0 筆→直接開新、≥1 筆→列出接續選單）完全共用。`fcResume()` 不必改。

**(5) 送出時一併帶 sessionId。** 主題對話續接後 `floatChat.sessionId` 有值，`sendFloatChat()` 既有邏輯已會帶上，但需確認 `context` 與 `sessionId` 同時送出時後端不會誤判為新 session（`saveChatSession` 以 `sessionId` 為準）。

### 7.4 明確不做

- **不回填舊資料**（見 §7.5）。
- 不做「把某段對話手動搬到某個主題」的 UI（若日後要，另立任務）。
- Telegram 端不受影響（另一條線）。

### 7.5 舊對話能不能歸位？——不能自動歸位，原因寫在這裡

舊的主題對話（排程頁、UI 設計系統、白板等處點頭像產生的）**在磁碟上沒有留下任何可辨識的標記**：`context` 從未被寫入 session 檔，而它們也不像文件對話那樣有 `filePath`。因此系統**無法用程式判斷**某段舊對話原本屬於哪個主題，只能靠讀對話內容去猜——那是啟發式推測，會猜錯、且錯了會把對話搬到不相干的主題底下，比留在原地更難找。

**決策：不做自動回填，從修好那天起算。**舊對話留在 AI 對話清單裡（內容完全沒有遺失，只是沒有分類）。若日後真的需要，正解是加一個「手動指定這段對話屬於哪個主題」的動作，由人判斷、系統只負責寫欄位——不是讓模型猜。

### 7.6 影響範圍

| 檔案 | 動作 |
|---|---|
| `portal/server.js` | `saveChatSession()` 存 `contextKind`/`contextKey`/`contextLabel`；`finalizeChat`/`saveChatPending` 傳遞；`GET /api/chat-sessions` 支援 `ctxKey=`；`getChatHistories()` 排除條件加 `contextKind` |
| `portal/index.html` | `fcOfferSessions()` 泛化；`_openFloatChatWithContext()` 呼叫它 |
| `specs/SPEC-plugin-contract.md` | view 契約檢查表補一行（新 view 必須有脈絡，且脈絡會自動獲得歷史與隔離） |

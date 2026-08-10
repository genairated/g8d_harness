# SPEC — 便條貼看板（Sticky Notes / 待辦便條）

> Status: 定稿 for build ｜ Owner: 老闆 + Hana ｜ 規劃日 2026-07-23
> 影響範圍：`portal/server.js`（notes API）、`portal/index.html`（白板面板）、`portal/telegram.js`（`/note`·`/notes`·NL 注入）、`portal/scheduler.js`（到期推播掃描）、`global-knowledge/notes/`（持久化，git-ignored）、`.harness/commands/note.md`（指令技能）。
> 一句話：**指揮官自己的待辦便條**——想到要做什麼（不一定要 Hana 做，例如「某天跟客戶開會、細節待確認」）就貼一張，隨時看得到；完成就從看板移除但仍查得到；可設顏色、可自由擺放；能在 Telegram 上叫 Hana 幫建、或問 Hana「還有哪些待辦」；到期用 Telegram 提醒。

---

## 1. 動機與定位（與既有能力的分界）

- 這**不是** `.worktable/TASK.md`（那是 Hana 的能力路線圖、由 Hana 執行）；也**不是**排程（那是自動跑的任務）。
- 這是**指揮官個人的便利貼白板**：純筆記／提醒，內容可能跟任何工作、任何一天有關，**不預期 Hana 去執行**（本版不做「一鍵轉成 Hana 任務」，見 §9 決策 4，日後再說）。
- 呈現直覺借鏡現有 Dashboard 看板／Active Task 清單的視覺語感，但互動是**自由拖放白板**（不是欄位式看板）。

## 2. 決策摘要（Charles 2026-07-23 拍板）

| # | 議題 | 拍板 |
|---|---|---|
| 1 | 版面 | **自由拖放白板**（便條可任意擺放、位置持久化）。 |
| 2 | 到期提醒 | **要**，且**用 Telegram 通知**；此提醒**獨立成一個 task**（§SN4）。 |
| 3 | 存放 | **本機不上版**（存 `global-knowledge/notes/`、git-ignored，不進 repo）。 |
| 4 | 轉任務 | **先不做**「一鍵轉成給 Hana 的任務」按鈕，以後再說。 |
| 5 | 指令 / Telegram | 要有 **note 指令**；且能在 **Telegram 指示 Hana 建立便條**、或問 Hana**還有哪些待辦**——**此項優先完成**（§SN2）。 |
| 6 | UI 元件與設計 | 由 Hana 決定（本 spec §6 定案）。 |

## 3. 資料模型（一張便條）

單一 JSON 陣列檔 `global-knowledge/notes/notes.json`（比照 `schedules/` 同精神：檔案式、本機、跨自癒重啟不丟）。**完成的便條不刪、只改 `status`**，仍留在同一檔供「已完成」查詢。

```jsonc
{
  id,                 // note_<ms>_<rand>
  text,               // 便條內容（純文字／簡單換行；不 render 任意 HTML）
  color,              // 調色盤 key：yellow|pink|blue|green|purple|orange|gray（預設 yellow）
  x, y,               // 白板上的位置（相對座標 0..1，抗不同螢幕寬度；見 §6.2）
  z,                  // 疊放順序（拖曳/點選時提到最上層）
  w,                  // 選填寬度（px；預設由 UI 給），高度自適應內容
  dueAt,              // 選填 ISO 到期時間（YYYY-MM-DDTHH:mm，當地時間語意）；無＝不提醒
  remindedAt,         // 選填：上次已推播提醒的 ISO（去重、避免重複轟炸）
  status,             // 'active'（看板上）｜'done'（已完成、移出看板、可查）
  workspace,          // 工作區隔離標籤（見 §5）
  createdAt, updatedAt, completedAt   // ISO
}
```

- 座標用**相對比例**（0..1）而非絕對 px：白板尺寸隨視窗變，存比例才不會換螢幕就跑位；渲染時 `left = x*boardW`、`top = y*boardH`。
- `text` 一律當**純文字**渲染（`textContent`／逃逸），不解析 HTML／不執行內容 → 防注入。

## 4. API（`portal/server.js`）

所有面都經 `resolveWorkspace(req)`（讀 `X-Workspace` 標頭）做工作區隔離（§5）。

| 端點 | 用途 |
|---|---|
| `GET /api/notes?status=active\|done\|all&scope=workspace\|all` | 列便條。預設 `status=active&scope=workspace`（只回當前工作區、未完成）。 |
| `POST /api/notes` | 建便條。body `{text, color?, x?, y?, dueAt?}`；未給座標→伺服器給預設（略帶隨機偏移避免完全重疊）；自動標 `workspace`＝`resolveWorkspace(req)`、`status='active'`。回整筆。 |
| `PUT /api/notes/:id` | 改便條。可改 `text/color/x/y/z/w/dueAt/status`。`status:'done'`→設 `completedAt`、清 `remindedAt`；`status:'active'`（還原）→清 `completedAt`。`updatedAt` 一律刷新。 |
| `DELETE /api/notes/:id` | **永久刪除**一筆（連已完成紀錄也移除）。破壞性、需前端二次確認；日常「完成」走 `status:'done'` 而非刪。 |

- 寫檔採「讀→改→寫」全量覆蓋 + 簡單檔鎖/同步寫（比照 schedules.json 寫法），量小、免資料庫。
- 併發足夠低（單人使用），不引入額外機制。

## 5. 工作區隔離（沿用平台鐵則）

- 每筆便條帶 `workspace`；建立時自動標記＝該請求解析出的工作區（Web：`X-Workspace`；Telegram：chat 脈絡 `getContext(chatId).root`，`/use` 可切）。
- 比對前 `path.resolve()`＋小寫正規化；`null`／未帶＝ harness home（`WORKSPACE_ROOT`）——與排程隔離同一套規則（見 MEMORY「排程的工作區隔離」）。
- **看板預設只顯示當前工作區**的便條；但因這是**個人跨專案待辦**，UI 提供「**全部工作區**」切換（`scope=all`）讓指揮官一次看全部。Telegram `/notes` 預設回當前脈絡工作區。
- 決策點（§9 D1）：預設視圖＝當前工作區（含「全部」切換）。若指揮官想「便條一律全域、不分工作區」，改成 `scope=all` 為預設即可（純預設值調整）。

## 6. UI 設計（`portal/index.html`，Hana 定案）

### 6.1 入口與面板
- 側邊欄新增「📌 便條貼」入口，走既有 `showPanel(id)` 互斥機制（與排程頁同款；不塞進 Dashboard 的 Markdown 檢視，白板需要獨立空間）。
- 面板頂欄：**＋ 新便條**、顏色快選、`工作區：當前 ▾ / 全部` 切換、`看板 / 已完成` 分頁。

### 6.2 白板（active 檢視）
- 一塊相對定位容器（`position:relative`），每張便條 `position:absolute`，以 `x*boardW / y*boardH` 定位。
- 拖曳用 pointer events（`pointerdown/move/up`）：拖放中即時更新 `left/top`，放開時換算回相對座標 `PUT /api/notes/:id {x,y}`；拖起同時把該張 `z` 提到最上（`PUT {z}`）。
- 每張便條：可直接點內文**就地編輯**（blur 存 `text`）；右上角操作＝**✓ 完成**（→`status:'done'`，淡出移出看板）、**顏色點**（開調色盤改 `color`）、**🗑 刪除**（二次確認才 `DELETE`）；底部可設/顯示 `dueAt`（到期近了視覺加重、過期標紅）。
- 顏色套用內建調色盤（§3 的 key → 一組柔和底色＋深色模式對應色，深淺模式都可讀，避免 MEMORY「全螢幕撞色字消失」那類問題：底色與文字色都隨 `.dark` 切換）。

### 6.3 已完成檢視
- 分頁「已完成」列出 `status:'done'`（依 `completedAt` 新→舊），每筆可「↩ 還原」（回看板）或「🗑 永久刪除」。滿足「完成就從看板移除、但查得到」。

### 6.4 深色模式與主題
- 所有寫死底色的元件，內部文字色必須跟 `.dark` 一起切換（吸取 MEMORY 教訓，避免某個 mode 下便條字與底色撞成同色）。

## 7. 指令與 Telegram（§SN2，**優先**）

### 7.1 note 指令技能
- `.harness/commands/note.md`（帶 frontmatter 的 command，比照既有 command 慣例）：讓 Hana 能用自然語言指令建立/查詢便條——`/note 明天跟客戶開會，細節待確認 due:7/30` → 呼叫 `POST /api/notes`；`/note list` → 讀當前工作區未完成便條回列。指令內含：解析「內容／到期（`due:MM/DD` 或 `due:YYYY-MM-DD`）／顏色（`color:xxx`）」、天條（只寫當前工作區）、只當純文字。

### 7.2 Telegram 指令
- `portal/telegram.js` `_route` 新增：
  - `/note <內容> [due:MM/DD] [color:顏色]` → 在**當前 chat 脈絡工作區**建便條，回確認（含到期）。
  - `/notes` → 列當前脈絡工作區**未完成**便條（依到期近→遠、無到期殿後），標出已過期/今日到期。
- `_registerCommands()` 的「/」選單與 `/help` 補這兩條。

### 7.3 自然語言（NL）也要能問/建
- 非指令訊息走既有 `_chat`（送給 Hana）。新增 `injectNotesContext`（比照既有 `injectActivityContext`）：把「當前工作區未完成便條摘要（含到期）」注入 chat context → 指揮官打「還有哪些待辦？」Hana 就答得出；指揮官說「幫我記一張便條…」Hana 可經 `/note` 技能／`POST /api/notes` 建立。
- 注入僅供 Hana 讀；便條**建立/修改一律經 API**（單一真相，UI/Telegram/NL 同一份資料）。

## 8. 到期 Telegram 提醒（§SN4，獨立 task）

- 在 `portal/scheduler.js` 既有週期迴圈掛一個**輕量掃描**（比照既有 tick，不新增排程物件）：每隔數分鐘掃 `notes.json`，挑 `status:'active' && dueAt && dueAt<=now(+提前量) && 未提醒過(remindedAt 空或早於本次到期)` → 經既有 Telegram sink 推一則「⏰ 便條到期：<內容> · <工作區>」→ 寫 `remindedAt`（去重）。
- **時間比對正確性**（MEMORY 教訓）：判斷「是否到期／今天到期」用**當地日曆組件**（`getFullYear/Month/Date`）組字，不可用 `toISOString().slice(0,10)`（UTC+8 會退一天）；`dueAt` 本身存 ISO。
- 護欄：一張便條同一個到期只推一次；掃描失敗只記 log、不影響排程主迴圈；沒 Telegram secrets 時自動 skip（比照既有 polling skip）。
- 推播對象＝該便條 `workspace` 對應的 chat 脈絡／預設授權 chat（沿用既有排程 Telegram 投遞的收件邏輯）。

## 9. 開放決策（可事後微調，皆已給預設、不阻擋開工）

- **D1 預設視圖**：看板預設「當前工作區」+「全部」切換（推薦）／或一律全域。→ 先做前者。
- **D2 到期提前量**：到期「當下」提醒／或提前 N 分鐘（例如當天早上）。→ 先做「到期當下」+ 當天到期在 `/notes`／掃描時標記；提前量做成常數可調。
- **D3 顏色盤**：7 色（yellow/pink/blue/green/purple/orange/gray）夠不夠。→ 先 7 色，常數化易加。

## 10. 分階段（對應 `.worktable/TASK.md §SN`、四個獨立手動 schedule）

| Phase | 內容 | 相依 | 模型 |
|---|---|---|---|
| **SN1** | 資料層 + Notes API（substrate） | 無 | Sonnet |
| **SN2** | `/note` 指令 + Telegram 建立/查詢 + NL 注入（**優先**） | 只依 SN1 | Sonnet |
| **SN3** | 自由拖放白板 UI（顏色/完成/已完成檢視） | 只依 SN1 | Sonnet |
| **SN4** | 到期 Telegram 推播提醒（**獨立**） | 只依 SN1 | Sonnet |

- SN2/SN3/SN4 都只依賴 SN1，彼此獨立、可任意順序；SN2 為指揮官指定的優先項，做完 SN1 即可先跑。

## 11. DoD（每階段自測）

- 自我修改平台程式（server.js/index.html/telegram.js/scheduler.js）→ 改完走 `Deploy_Harness.ps1`（冒煙＋自動回滾），git 由人類掌控、不自行 commit。
- 自測用**隔離埠 3399** ＋ temp `HARNESS_HOME` ＋明指真 `HARNESS_VENV`；**勿起第二顆完整 server**（會搶 Telegram token／燒額度）。
- 天條：便條只寫當前工作區解析出的 `global-knowledge/notes/`（此為 harness home 的個人區，本機不上版）；不寫 `C:\Users`／系統暫存／工作區外。

---

## Changelog
| Date | Version | Author | Description |
|:-----|:--------|:-------|:------------|
| 2026-07-23 | v1.0 | 老闆 + Hana | 初版定稿。自由拖放白板、本機不上版、顏色/位置/完成封存、note 指令＋Telegram 建立/查詢（優先）、到期 Telegram 提醒（獨立）。四階段 SN1–SN4，各獨立手動 schedule。 |

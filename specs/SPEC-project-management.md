# SPEC — 專案管理（Project Management：清單／看板／甘特圖）

> Status: 定稿 for build ｜ Owner: 老闆 + Hana ｜ 規劃日 2026-07-30
> 影響範圍：`portal/server.js`（PM API）、`portal/index.html`（專案管理面板：清單／看板／甘特圖三視圖）、`global-knowledge/pm/`（持久化，git-ignored）、`.harness/commands/pm.md`（指令技能）。
> 一句話：**指揮官規劃「任意專案」的工具**——一份結構化資料（任務＋開始/結束日＋% 完成＋前後相依），用**清單 / 看板 / 甘特圖**三種視圖看同一份資料；可在網頁手動編、也可用對話叫 Hana 幫你建/改，或用 `/pm` 指令。

---

## 1. 動機與定位（與既有機制的分界，這條最關鍵）

指揮官要一個「正常專案管理系統」該有的東西：任務清單、任務前後關係、預計完成日、以甘特圖呈現。關鍵洞見（規劃對話已釐清）：

> **清單（List）、看板（Kanban）、甘特圖（Gantt）不是三選一，而是同一份結構化資料的三種視圖。** 只要底層資料有 `start/end/deps/progress`，三種視圖都只是渲染方式。MS Project／Jira／Asana／Monday／ClickUp 都是這條路。

因此本能力做的是**一套全新、獨立的結構化資料 + 三視圖渲染**，**不改造 Dashboard、不吸收既有 TASK/worktable**。

工作區裡已經有三個「像 task 的東西」，PM 是**第四個、刻意獨立的筒倉**，設計上與它們清楚分界：

| 現有機制 | 擁有者/用途 | 有日期? | 有相依/甘特? | 與 PM 的關係 |
|---|---|---|---|---|
| Worktable `TASK.md` | **Hana 的開發路線圖**（敘事型記憶、由 Hana 執行） | ❌ | ❌ | 完全不碰 |
| 便條貼 `/note` | 指揮官**個人待辦白板**（純提醒） | ✅ 到期日 | ❌ | **完全獨立**（見決策 1） |
| 排程 Scheduler | 定時**執行** prompt | ✅ cron | ❌ | 不相干 |
| **（本 spec）專案管理** | 指揮官規劃**任意專案**的工期/相依/時間軸 | ✅ | ✅ | 新做 |

## 2. 決策摘要（Charles 2026-07-30 拍板）

| # | 議題 | 拍板 |
|---|---|---|
| 1 | 管什麼專案 | **任意專案**（客戶案、生活專案…，**與 Hana 開發無關**）→ 純新能力，worktable 完全不碰。 |
| 2 | 與便條貼關係 | **完全獨立**。便條貼只是提醒、不是排定的任務；PM 不吃掉便條貼、也不互通。 |
| 3 | 相依類型 | **只做最常見的 FS**（Finish→Start：前項完成才可開始）；不做 SS/FF/SF、不做 lead/lag。 |
| 4 | 建/改方式 | 三路並存：**① 網頁手動編、② 對話叫 Hana 建/改、③ `/pm` 指令技能**。 |
| 5 | 視圖 | **清單 + 看板 + 甘特圖三種都要**。 |
| 6 | 深度 | 里程碑、% 完成、基準線（原訂 vs 實際）**都先做最基本**。 |

## 3. 資料模型（結構化資料＝一切的根）

單一 JSON 檔 `global-knowledge/pm/pm.json`（本機、git-ignored，比照 `notes/`、`schedules/` 同精神：檔案式、跨自癒重啟不丟）。內含兩個陣列：

```jsonc
{
  "projects": [ /* Project */ ],
  "tasks":    [ /* Task */ ]
}
```

### 3.1 Project（專案）
```jsonc
{
  id,            // proj_<ms>_<rand>
  name,          // 專案名
  description,   // 選填說明（純文字）
  color,         // 選填主題色 key（沿用調色盤，深淺模式都可讀）
  workspace,     // 工作區隔離標籤（見 §5）
  archived,      // 封存（移出清單、仍可查/還原）；預設 false
  createdAt, updatedAt
}
```

### 3.2 Task（任務）
```jsonc
{
  id,            // ptask_<ms>_<rand>
  projectId,     // 所屬專案（→ 由專案取得 workspace）
  name,
  start,         // 'YYYY-MM-DD'（當地日曆語意；里程碑時 == end）
  end,           // 'YYYY-MM-DD'（含當日；即預計完成日）
  progress,      // 0..100（% 完成）
  status,        // 'todo' | 'in_progress' | 'done'（看板欄；獨立存，非由日期推導，見 §9 D5）
  deps,          // [taskId, ...] FS 前置任務（這些完成後本任務才可開始）
  isMilestone,   // 里程碑＝工期 0 的時間點標記（Gantt 畫菱形）；預設 false
  order,         // 整數，清單/看板內的手動排序
  color,         // 選填
  baseline,      // 選填 { start, end } 基準線快照（原訂 vs 實際，見 §6.3 / §9 D6）
  createdAt, updatedAt
}
```

- **日期一律 date-only `YYYY-MM-DD` 當地日曆語意**；工期（天）＝`end − start + 1`。**計算「今天／是否延誤」用當地日曆組件**（`getFullYear/Month/Date`）比對，**不可用 `toISOString().slice(0,10)`**（UTC+8 會退一天，MEMORY 教訓）。
- `name`/`description` 一律**純文字**渲染（`textContent`／逃逸），不解析 HTML → 防注入。
- **相依只存前置 `deps`（FS）**：語意＝所有 `deps` 完成前，本任務不應開始。基本版**只視覺呈現＋標記違規（後項早於前項結束）**，**不自動重排**日期（自動排程屬進階、不做，見 §9 D3）。

## 4. API（`portal/server.js`）

所有面都經 `resolveWorkspace(req)`（讀 `X-Workspace` 標頭）做工作區隔離（§5）。寫檔採「讀→改→寫」全量覆蓋 + 同步寫（比照 `schedules.json`／`notes.json`），單人低併發、免資料庫。

| 端點 | 用途 |
|---|---|
| `GET /api/pm/projects?scope=workspace\|all&includeArchived=0\|1` | 列專案。預設 `scope=workspace`、不含封存。 |
| `POST /api/pm/projects` | 建專案。body `{name, description?, color?}`；自動標 `workspace`＝`resolveWorkspace(req)`。回整筆。 |
| `PUT /api/pm/projects/:id` | 改專案（`name/description/color/archived`）。刷新 `updatedAt`。 |
| `DELETE /api/pm/projects/:id` | **永久刪除**專案**及其所有任務**（破壞性、前端二次確認）。 |
| `GET /api/pm/projects/:id/tasks` | 列該專案任務（依 `order`）。 |
| `POST /api/pm/projects/:id/tasks` | 建任務。body `{name, start?, end?, progress?, status?, deps?, isMilestone?, color?}`；缺日期給合理預設（今日起 1 天）；`order` 自動接尾。回整筆。 |
| `PUT /api/pm/tasks/:id` | 改任務（`name/start/end/progress/status/deps/isMilestone/order/color/baseline`）。刷新 `updatedAt`。 |
| `DELETE /api/pm/tasks/:id` | 刪任務，並**清掉其他任務 `deps` 中對它的引用**（避免懸空相依）。 |
| `POST /api/pm/tasks/:id/baseline` | 把目前 `start/end` 存進 `baseline`（原訂快照）。清除＝`PUT {baseline:null}`。 |

- 任務端點的工作區隔離：**task 無自帶 workspace，經 `projectId → project.workspace` 對應**後過濾（比照排程「run 只帶 scheduleId、需經 scheduleId→workspace 對應」的鐵則）。跨工作區的 `projectId` 一律 404，不得操作。
- `deps` 寫入時驗證：只接受**同專案內**、**非自身**、**不成環**的 taskId（基本防呆；成環直接拒絕）。

## 5. 工作區隔離（沿用平台鐵則）

- 每個 **Project** 帶 `workspace`；建立時自動標記＝該請求解析出的工作區（Web：`X-Workspace` 標頭 `resolveWorkspace(req)`）。**Task 不自帶 workspace**，一律經 `projectId → project.workspace` 判定歸屬。
- 比對前一律 `path.resolve()`＋小寫正規化；`null`／未帶＝ harness home（`WORKSPACE_ROOT`）——與排程／便條貼隔離**同一套規則**（MEMORY「排程的工作區隔離」）。
- 面板**預設只顯示當前工作區**的專案；因這是**跨專案的個人規劃工具**，UI 提供「**全部工作區**」切換（`scope=all`）。
- **日後新增任何 PM 相關的讀取功能，務必照此 pattern 過濾**（避免跨工作區外洩，MEMORY 鐵則）。

## 6. 三視圖（`portal/index.html`，Hana 定案）

### 6.0 入口與面板外殼
- 側邊欄新增「📊 專案管理」入口，走既有 `showPanel(id)` 互斥機制（與排程頁同款、獨立空間，不塞進 Dashboard）。
- 版面：**左欄＝專案清單**（＋新專案、選取、`工作區：當前 ▾ / 全部` 切換、封存切換）；**主區＝選定專案的任務**，頂部**視圖切換 `清單 / 看板 / 甘特圖`**＋「＋新任務」。
- 三視圖共讀同一份 `tasks`（`GET /projects/:id/tasks`）、任何一處編輯都經 API 寫回單一真相，切視圖即時反映。

### 6.1 清單視圖（List）
- 表格：任務名、開始、結束、工期、% 完成、狀態、相依（前置任務名）。
- 就地新增/編輯（點列開編輯表單或就地欄位）：改 `name/start/end/progress/status/deps/isMilestone` → `PUT`。依 `order` 排序、可調整順序。
- 相依欄用**下拉多選**（同專案任務），呈現前置任務名。

### 6.2 看板視圖（Kanban）
- 三欄＝`待辦(todo) / 進行中(in_progress) / 完成(done)`。卡片顯示任務名、日期區間、% 完成、里程碑標記。
- 卡片可**拖曳跨欄** → 放開時 `PUT /tasks/:id {status}`；同欄內拖曳可調 `order`。
- 卡片點擊 → 開同一個任務編輯表單（與清單共用）。

### 6.3 甘特圖視圖（Gantt，SVG，本能力最核心的呈現）
- 輕量 **SVG** 手繪（不引大型函式庫）；時間軸 X 依專案任務的最早 `start`～最晚 `end` 自動決定範圍與刻度（日／週自適應）。一列一任務（依 `order`）。
- 每個元素：
  - **任務條**：`start`→`end` 的橫條，**依 `progress` 填充**（已完成比例著色）。
  - **里程碑**：`isMilestone` 畫**菱形**（工期 0 的時間點）。
  - **FS 相依箭頭**：從前置任務**結束端** → 後續任務**開始端**畫箭頭連線；後項開始早於前項結束時**視覺標紅**（違規提示、不自動改期）。
  - **今日線**：一條垂直「今天」標線（當地日期）。
  - **基準線 ghost**：若該任務有 `baseline`，在條上/下畫一條細的原訂區間 ghost（原訂 vs 實際對照）；無則不畫。
- 條/菱形點擊 → 開任務編輯表單。橫向可捲動看長專案。

### 6.4 深色模式與主題（MEMORY 教訓）
- 所有寫死底色的元件，內部文字色/線色必須跟 `.dark` 一起切換（避免某 mode 下撞色使字/線消失，如「Excel 全螢幕字看不到」那次）。甘特圖的軸線、格線、條色、今日線在深淺模式都要清楚可讀。

### 6.5 多專案同步甘特圖 + 觀測線（Phase 6 追加；決策 2026-07-31）

> 動機：指揮官同時推多個專案（可能分屬不同工作區），想在**同一畫面**上下並排看數個專案的甘特圖、對齊在**同一條時間軸**上，並用一條可拖曳的**觀測線**觀察「某個時間點各團隊分別在做什麼、進度如何」。**本階段只做視覺對齊＋觀測線（下方 D-PM6-1＝A）**；跨專案的正式相依（箭頭連線、異動連鎖標紅）延後（見 §12）。

**入口**：左欄專案清單支援**複選（checkbox）**。選 1 個＝維持現有單專案甘特；選 **≥2 個 → 切換為「多專案對齊視圖」**（上下分割 N 格、每專案一格）。

1. **共用時間軸（橫軸統一）**
   - 時間範圍＝**所有被選專案的 union**（最早 `start`～最晚 `end`，前後各墊 1 天），用**同一組** `minD / pxPerDay / xOf()` 餵給每一格 → 各格天生對齊。**把現有 `pmRenderGantt()` 內部算時間座標的那段抽成可傳入 `minD/pxPerDay` 的純函式**，單/多專案共用，不重寫一套。
   - 頂部一條**共用日期刻度尺**（沿用現有日/週自適應邏輯），下方各專案格只畫自己的任務列。
2. **捲動行為（縱各自、橫同步）**
   - 每格是自己的**垂直捲動盒**（縱軸獨立，長專案格內自捲）。
   - **橫向捲動同步**：任一格 `scrollLeft` 改變 → 用 event listener＋**防重入 flag** 同步到其他格與頂部刻度尺（避免互相觸發成迴圈）。
3. **觀測線（Observation Line）— 決策 Q2=a：date-anchored**
   - 一條**跨所有格全高**的垂直導引線，用**絕對定位的 overlay**（不塞進任何單一格的 SVG，才能橫跨）。
   - **釘在「日期」而非「畫面位置」**（date-anchored）：預設落在畫面中央對應的日期；時間軸橫捲時，它跟著那個日期移動（該時刻不變）。提供「**↩ 回到畫面中央**」快捷鈕（捲遠後拉回）。
   - **可左右拖曳**改觀測日期；**hover 觀測線即顯示該日精確日期 tooltip**（決策：日期密集時光看位置不好判讀，故 hover/拖曳都要浮出 `YYYY-MM-DD`）。
   - **讀數面板**：觀測線停在某日 → **每格即時列出「當天正在進行的任務名＋進度%」**（該日落在 `start..end` 區間內的任務），真正實現「觀測某時間點各團隊進度」。
   - 深淺模式皆清楚可讀（線色/tooltip/讀數背景跟 `.dark` 切換，MEMORY 教訓）。
   - **DOM 清理護欄**：切回單專案／關面板時，移除 overlay 與 scroll/hover/drag 的 event listener，避免殘留監聽或洩漏。

- **開放決策 D-PM6-1（跨專案正式相依）**：本階段**只做 A（視覺對齊＋觀測線、用眼睛看互相影響）**；**B（跨專案 deps 資料模型＋面板間相依箭頭＋異動連鎖標紅）延後**，待正式上線用一段時間後再評估（Charles 2026-07-31 拍板）。→ 列 §12 後續。

## 7. 建/改三路（決策 4）

### 7.1 網頁手動（§6 各視圖表單）— 主路
就地表單/拖曳，全部經 §4 API。

### 7.2 `/pm` 指令技能
- `.harness/commands/pm.md`（帶 frontmatter 的 command，比照 `note.md` 慣例）：Hana 用自然語言建/改/查——解析「建專案／在某專案加任務（含開始~結束、相依、里程碑）／更新進度或狀態／列出」，呼叫 §4 API。內含：日期解析（`M/D`、`YYYY-MM-DD`）、相依用任務名對應 id、天條（只寫當前工作區）、只當純文字。
- 例：`/pm 建專案「網站改版」`；`/pm 網站改版 加任務 設計稿 7/31~8/5`；`/pm 網站改版 開發 依賴 設計稿`；`/pm 網站改版 開發 進度 60%`；`/pm 網站改版 list`。

### 7.3 對話式（Hana 頭像 / 浮動 chat）
- 新增 `injectPmContext`（比照既有 `injectNotesContext`/`injectActivityContext`）：把「當前工作區的專案＋任務摘要（含進度、近期到期）」注入 chat context → 指揮官問「網站改版現在進度如何／還有哪些任務沒完成？」Hana 答得出；指揮官說「幫我把開發標成完成」Hana 可經 `/pm` 技能／§4 API 執行。
- 注入僅供 Hana 讀；**建立/修改一律經 API**（單一真相，UI／對話同一份資料）。

## 8. UI/UX 細節
- 空狀態引導：無專案時主區顯示「＋ 建立第一個專案」；專案無任務時甘特/看板顯示引導加任務。
- 破壞性操作（刪專案／刪任務）一律**二次確認**；日常「完成」走 `status:'done'` 或封存，非刪。
- 相依下拉只列同專案任務、排除自身與會成環者。

## 9. 開放決策（皆已給預設、不阻擋開工，可事後微調）

- **D1 儲存**：本機 git-ignored（`global-knowledge/pm/`，同便條貼）／或進版控。→ 先本機不上版。
- **D2 關鍵路徑（Critical Path）**：基本版**先不做**（相依只求 FS、都先最基本）；資料模型已足以日後加「最長相依鏈高亮」。→ 列 §後續。
- **D3 相依違規處理**：只**視覺標記**（後項早於前項結束標紅）／或自動重排日期。→ 先只標記、不自動改期（自動排程屬進階）。
- **D4 Telegram PM 指令**：先**不做**（網頁 + 對話 + `/pm` 技能已涵蓋「用對話建/改」）。→ 列 §後續，比照便條貼日後可加 `/pm`·`/pms`。
- **D5 狀態來源**：`status` **獨立存**（看板需要明確欄位），與日期無關聯自動推導。→ 採獨立存。
- **D6 基準線深度**：手動「設基準線」快照**一次**、Gantt 畫 ghost（原訂 vs 實際）。→ 先最基本；不做多版本基準/歷史。

## 10. 分階段（對應 `.worktable/TASK.md §PM`；五個獨立手動 schedule，成功後接續串接）

| Phase | 內容 | 相依 | 模型 | 理由 |
|---|---|---|---|---|
| **PM1** | 資料層 `pm.json` + PM API（Project/Task CRUD、工作區隔離、deps 防呆） | 無 | Sonnet | 依既有 notes/schedules pattern 的 CRUD，成熟路數。 |
| **PM2** | 面板外殼 + **清單視圖** + 任務建立/編輯表單（手動編輯主路） | PM1 | Sonnet | 表單/表格，既有 UI 慣例。 |
| **PM3** | **甘特圖視圖**（SVG 時間軸：任務條＋% 填充、里程碑菱形、FS 相依箭頭、今日線、基準線 ghost） | PM1+PM2 | **Opus** | 時間軸幾何、相依連線、里程碑/基準線佈局是本能力唯一有實質演算/版面複雜度處。 |
| **PM4** | **看板視圖**（狀態欄拖放、卡片編輯） | PM1+PM2 | Sonnet | 拖放跨欄改 status，既有互動模式。 |
| **PM5** | `/pm` 指令技能 + 對話式建/改 + `injectPmContext`（Hana 答進度） | PM1 | Sonnet | 技能/prompt 撰寫 + API 串接。 |
| **PM6** | **多專案同步甘特圖 + 觀測線**（§6.5：複選入口、union 時間軸、上下分割 N 格、橫捲同步、date-anchored 可拖曳+hover 觀測線+讀數面板） | PM3 | **Opus** | 重構甘特時間座標成共用純函式、跨面板 overlay 與捲動同步、date-anchored 觀測線幾何，屬版面/互動複雜度高處。 |

- 串接：**PM1 → PM2 → PM3 → PM4 → PM5**，各以真正 `success` 收尾才接下一棒（`chainNext`）。PM1 排定明日（2026-07-31）凌晨 02:00 起跑，其餘由前一棒成功後自動觸發。
- PM2 須在 PM3/PM4 之前（後兩者需要面板外殼）；PM5 只依 PM1，排最後接續即可。
- **PM6 為 Phase 6 追加**（2026-07-31）：依賴 PM3 甘特圖已完成（重構其 `pmRenderGantt` 時間座標為共用純函式）。**獨立手動 schedule、不接在 PM1–5 串接鏈上**（指揮官自己挑時間手動觸發）。

## 11. DoD（每階段自測）
- 自我修改平台程式（`server.js`/`index.html`）→ 改完一律走 `Deploy_Harness.ps1`（自動冒煙＋失敗回滾），不手改正式區、不碰唯讀 `.releases/`，git 由人類掌控、不自行 commit。
- 自測用**隔離埠 3399** ＋ temp `HARNESS_HOME` ＋明指真 `HARNESS_VENV`；**勿起第二顆完整 server**（會搶 Telegram token／燒額度，MEMORY 鐵則）。
- 天條：PM 資料只寫當前工作區解析出的 `global-knowledge/pm/`（harness home 個人區、本機不上版）；不寫 `C:\Users`／系統暫存／工作區外。
- 每階段列出實際測過的情境（誠實原則：只有驗證過才勾）。

## 12. 後續（先列不做）
- **跨專案正式相依（D-PM6-1 的 B）**：放寬資料模型允許跨專案 `deps`、多專案甘特面板間畫相依箭頭、某專案排程異動時把受影響的他專案活動標紅。→ 待 PM6 視覺對齊版上線用一段時間後再評估（Charles 2026-07-31）。
- Critical Path（關鍵路徑）最長相依鏈高亮（D2）。
- 相依自動重排日期 / lead·lag / SS·FF·SF（D3，進階排程）。
- Telegram `/pm`·`/pms` 指令（D4）。
- 多版本基準線 / 甘特匯出圖片 / 資源與負責人 / 依賴違規自動告警。

---

## 13. Excel 匯出（2026-08-07 追加，單專案）

- 入口：專案主區工具列「匯出 Excel」按鈕（`portal/views/pm.js`），呼叫 `GET /api/pm/projects/:id/export`（`portal/server.js`），由 `portal/pm-export.js`（`exceljs`）組出三頁籤 `.xlsx`：
  - **清單**：任務名稱/開始/結束/工期(公式)/進度%/狀態/相依/里程碑，另有三個灰階輔助欄（完成天數/應完成人天/實際完成人天）供總覽與甘特圖公式取用。
  - **總覽**：任務總數/已完成/完成百分比／**Ontime Rate**（皆為公式，開啟時隨 `TODAY()` 與清單異動自動重算）＋簡易文字進度條（conditional formatting）。
  - **甘特圖**：不用原生圖表物件（exceljs 對圖表支援有限、易出壞檔風險），改用**逐日欄位 + conditional formatting** 畫橫條：淺色＝排定區間、深色＝依進度已完成部分、紫色＝里程碑、橘色表頭＝今天。所有公式指向「清單」分頁同列儲存格，**在 Excel 裡改清單的日期/進度/相依，甘特圖與總覽會自動跟著重算**（純結構性異動如加刪任務列，仍需重新匯出）。
- **Ontime Rate 定義**（老闆 2026-08-07 拍板，範例：總共 100 人天工作項，已過 20 天且都完成＝100%；只完成 18 人天＝90%）：對「今天已開始」的任務，分母＝Σ`MIN(工期, 今天-開始+1)`（應完成人天），分子＝Σ`工期×進度%`（不封頂，可反映超前）；比值即 Ontime Rate，尚無任務啟動時顯示「—」。同一定義同時用於 xlsx 匯出公式與 App 內「總覽」頁籤（`pmComputeOverviewStats`，`index.html`）。
- App 內新增第 4 個視圖分頁「**總覽**」（清單/看板/甘特圖旁），呈現同一組統計卡片（不需匯出即可看）。
- 多專案匯出：本階段**只做單專案**（決策：先驗證單專案格式與公式穩定性，多專案的呈現方式——多 sheet／合併總覽——待用過一段時間再評估，不預先設計）。

## Changelog
| Date | Version | Author | Description |
|:-----|:--------|:-------|:------------|
| 2026-08-07 | v1.2 | 老闆 + Hana | 追加 §13 單專案 Excel 匯出（總覽/清單/甘特圖三頁籤，公式聯動、甘特圖用 conditional formatting 逐日繪製、Ontime Rate 定義拍板）；App 內新增「總覽」視圖頁籤。多專案匯出留待後續評估。 |
| 2026-07-30 | v1.0 | 老闆 + Hana | 初版定稿。全新獨立 PM 能力：結構化資料（任務＋日期＋FS 相依＋% 完成＋里程碑＋基準線）＋清單/看板/甘特三視圖＋手動/對話/`/pm` 三路建改。工作區隔離、本機不上版。五階段 PM1–PM5，各獨立手動 schedule、成功後接續串接，PM1 排明日 02:00。 |
| 2026-07-31 | v1.1 | 老闆 + Hana | 追加 §6.5 多專案同步甘特圖＋觀測線（Phase 6）：專案複選→上下分割 N 格、union 時間軸共用座標、縱各自捲/橫同步捲、date-anchored 可拖曳+hover 顯示日期的觀測線+各格當日進行中任務讀數。決策：本階段只做視覺對齊+觀測線（A），跨專案正式相依（B）延後（§12）。新增階段 PM6（Opus，依賴 PM3，獨立手動 schedule）。 |

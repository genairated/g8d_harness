# SPEC — 回報給 Hana（操作重播式問題回報＋內建問題管理）

> 規格版本 v0.3（2026-10-21 起草；IR2 完工）｜Owner: Charles + Hana｜狀態：**§9 決策已拍板（2026-10-21）**
> 關聯：`specs/SPEC-view-chat-context.md`（頭像對話脈絡契約 `getChatContext()`）、`specs/SPEC-floating-chat.md`（浮動對話、session 綁定）、`specs/SPEC-chat-multimodal.md`（附件落地與注入 pattern）、`specs/SPEC-plugin-contract.md` §3（view 契約）、`specs/SPEC-runtime-version-display.md`（版本號）、`specs/SPEC-browser-pilot.md`（無頭瀏覽器，IR4 截圖用）
> 參考實作：另一個客戶專案自製的問題錄製工具（P0 已實作實測）——錄製、指認欄位、重播頁、rrweb 2.1.7 套件皆可直接借用
> 任務：`.worktable/TASK.md §IR`（待拍板後登錄）

---

## 1. 動機與一句話定義

現況指揮官回報 Hana 平台的問題或新需求，是「擷圖 → 貼進對話 → 口述怎麼發生」。擷圖只有一格畫面，缺「出錯前做了什麼」「後端回了什麼」，Hana 常要再問。

**一句話**：在 Hana 平台任何畫面按一下「回報給 Hana」，就把**出錯前幾分鐘的操作紀錄（可重播）＋錯誤訊息＋當下所在畫面**存成一筆問題單；問題單進 Hana 自己的問題管理頁，並且能在**頭像對話**裡針對這一筆討論怎麼改，改完回寫結果——形成平台內完整的「回報 → 討論 → 修正 → 驗收」流程。

## 2. 與客戶專案版的差異（為什麼不直接搬外掛）

| 項目 | 客戶專案版 | Hana 平台版 |
|---|---|---|
| 錄製程式怎麼進頁面 | 瀏覽器外掛（MES 不能改） | **平台自己載入**，不需外掛、不需安裝 |
| 回報按鈕 | 外掛畫的浮動圓鈕 | 掛在 **Hana 頭像**＋快捷鍵（§4.1） |
| 問題單存哪 | 獨立回報網站（:4410） | 平台內建 API＋問題管理頁（`/app/issues`），不另起服務 |
| 討論 | 網站內類 JIRA 留言串 | **頭像對話**就是討論串（session 綁定問題單，§5.3） |
| 誰處理 | IT 人員 | **Hana 自己**（讀問題單 → 定位 → 修 → Deploy → 回寫） |
| 隱私／登入 | 正式上線前必做 | 本機單人使用，風險低；密碼欄仍一律遮蔽 |

借用：rrweb 錄製設定、環狀緩衝、指認欄位模式、重播頁版面、請求攔截邏輯。

## 3. 核心原則

1. **Hana 直接讀錄製檔，不必另造文字版**：rrweb 錄的是 JSON 事件（DOM 快照＋點擊／輸入／畫面變化＋自訂事件），不是影片，Hana 可直接解析。2026-10-21 已實證：分身在完全不知情下只讀 `events.json`（64 筆、24KB），正確還原畫面、每次點擊與輸入值、API 404→200、錯誤原文與重現步驟（見 `_tmp/rrweb-proof/`）。唯一缺口是錄製檔不含原始碼與堆疊，所以**送出時要一併記錄錯誤的 stack**；平台程式 Hana 本來就讀得到，可直接定位根因。仍可順手產一份精簡時間軸（`timeline.md`）省 token，但它是快取、真相是錄製檔。
2. **平常只放記憶體、不寫檔、不連網**：只保留最近 N 分鐘，按下回報才送出。
3. **用現成的**：錄製用 rrweb（業界標準，客戶專案已驗證）；附件落地照 `SPEC-chat-multimodal`；頭像脈絡照 `SPEC-view-chat-context` 的 `getChatContext()`；狀態流照業界通用簡化版（§5.2），不自創。
4. **新 view 必須能用頭像對話**：問題清單頁、單筆頁都要實作 `getChatContext()`，不得退回 DASHBOARD.md。
5. **結案權在指揮官**：Hana 修完只能改成「已修正待驗證」，「已結案」由指揮官按（同 TASK.md「指揮官手動驗證」精神）。

## 4. 使用者流程

### 4.1 回報（指揮官）

1. 平常照常使用；平台背景錄最近 N 分鐘（預設 3）。
2. 遇到問題或想到新需求 → 按 **頭像旁的「回報給 Hana」**（或 `Alt+Shift+R`）。
3. 跳出回報小窗：
   - 類型：**問題**／**新需求**（預設問題）
   - 一句話說明（必填）
   - 選填「指給 Hana 看」：進指認模式點畫面上有問題的元素（借客戶專案做法，記下元素標籤與當下值）
   - 選填貼圖（`Ctrl+V`，沿用多模態附件）
4. 送出 → 畫面提示「已回報 #編號」，可直接點「現在跟 Hana 討論」開頭像對話。

### 4.2 處理（Hana＋指揮官）

1. 問題管理頁看清單 → 點一筆 → 上方重播、旁邊環境資訊、下方文字時間軸與錯誤紀錄。
2. 在該筆頁面點頭像 → 對話自動帶入這筆問題單（說明＋文字時間軸＋錯誤＋所在畫面＋附件）。
3. 討論出改法 → Hana 修改、走 Deploy → 在問題單記下「改了什麼、哪一版上線」→ 狀態改「已修正待驗證」。
4. 指揮官驗證 → 按「結案」；沒修好 → 「退回」回到處理中。
5. 若改動大（要寫 spec、要排程），Hana 依既有慣例建 TASK／排程，並把連結掛回問題單。

## 5. 設計

### 5.1 錄製端（前端，所有畫面共用）

- 平台殼（`index.html` 載入時）啟動 rrweb `record()`；每 60 秒重拍一次完整畫面（checkout），緩衝只留最近 N 分鐘。
- 同時收集（只放記憶體）：
  - 前端錯誤：`window.onerror`、`unhandledrejection`、`console.error`
  - 平台 API 請求：包一層 `fetch`，記最近 30 筆（方法、網址、狀態碼、耗時；失敗者另記回應前 2KB）
  - 路由切換（`router.js` 的 view 變化）
- 送件當下另抓：目前路由與 view、`getChatContext()` 結果、工作區、平台版本號、瀏覽器與視窗大小。
- 遮蔽：密碼欄一律遮；其他預設不遮（單人本機）。
- **開錄時機與狀態判定（IRF，2026-10-22）**：
  - 錄製器載入即**同步**以預設 3 分鐘 `start()`，不等 `/api/issues/config`（設定回來只更新保留分鐘數、不重啟）；rrweb 用 `recordAfter: 'DOMContentLoaded'`，頁面骨架好就開錄，不等圖片字型。
  - **以第一張完整快照（type 2）為準**才算「真正錄影中」（`live=true`）。之前產生的標記（路由／錯誤／API）先暫存（上限 50 筆、超過丟最舊），開錄後依序補寫並帶原始時間 `at`。
  - 單筆標記寫入失敗只丟該筆並累計 `customErrors`，**不再停掉整台錄製器**；只有 rrweb 啟動失敗、緩衝寫入失敗才算致命。開錄後 10 秒仍無快照 → `failed=true`、`failReason='逾時未開錄'`（不停錄，之後拍到即恢復）。
  - `snapshot().recording` ＝ `running && live`；`stats()` 新增 `live／liveAt／recordedMs／failReason／pendingCustom／customErrors`（既有欄位意義不變）。
  - 回報小窗一行小字如實顯示：「● 錄影中，已錄 N 秒（N 筆）」／「錄影準備中…」／「⚠ 錄影未運作（原因：…）」，失敗不再只藏在主控台。
- **已知限制**：白板（Excalidraw 畫布）預設不錄畫布內容（錄畫布很吃效能），重播該區會空白——靠「指給 Hana 看」與貼圖補；Deploy 後頁面重載會讓緩衝重來。

### 5.2 問題單資料與狀態

存放：見 §9 D2（建議集中在 Hana 的家 `HARNESS_HOME/.harness/issues/`，不上版）。每筆一個資料夾：

```
issues/<id>/issue.json     # 問題單本體
issues/<id>/replay.json.gz # rrweb 紀錄（壓縮）
issues/<id>/timeline.md    # 給 Hana 讀的文字時間軸（送件時由後端產生）
issues/<id>/files/         # 貼圖、指認截圖
```

`issue.json` 主要欄位：`id`（流水號 #1、#2…）、`type`（bug｜feature）、`title`、`description`、`status`、`createdAt`、`workspace`（回報時所在工作區）、`route`、`chatContext`、`version`、`pick`、`errors[]`、`requests[]`、`linkedSessions[]`（討論過的對話）、`resolution{summary, version, at}`、`history[]`（狀態變更紀錄，誰在何時從什麼改成什麼）、`links{task, schedule}`。

狀態（業界通用簡化版，對照 JIRA／GitHub Issues）：

| 狀態 | 誰可以改到這 |
|---|---|
| 待處理 | 新建預設 |
| 處理中 | Hana／指揮官 |
| 已修正待驗證 | Hana（必須填 resolution） |
| 已結案 | **只有指揮官** |
| 不處理 | 指揮官（附理由） |

### 5.3 問題管理頁 `/app/issues`（平台內建 view）

- 側欄新增「問題回報」，顯示未結案數。
- **版面（2026-10-21 Charles 拍板）**：跟會議、文件管理、排程等既有功能一致——**左邊是清單、右邊是內容**（同一頁左右分欄，點左邊一筆、右邊顯示那一筆；不是另開一頁）。網址可帶 `?id=` 直接開到某一筆。
- **清單**（左欄）：編號、類型、標題、所在畫面、工作區、狀態、建立時間；篩選狀態（預設未結案）、類型。
- **單筆**（右欄）：重播（rrweb-player，自動停在送出那一刻；有指認就框紅）／環境資訊／文字時間軸／錯誤與 API 紀錄／處理紀錄（狀態歷程＋resolution）／討論過的對話清單（點了接回那段頭像對話）。
- `getChatContext()`：清單頁 → `kind:'issue', key:'issue:list'`（摘要每筆一行）；單筆頁 → `key:'issue:<id>'`（帶完整內容與 timeline.md）。
- **清單更新（IRR，2026-10-30）**：業界通用做法——手動刷新鈕＋同頁事件＋回到分頁時刷新＋可見時輕量輪詢，不新增後端。
  - 刷新鈕（左欄 `#iss-count` 右側，`refresh-cw`）：重抓清單＋選中那筆右欄；抓取中旋轉、disabled 防連點。
  - 同頁送件：`issue-report-ui.js` 送件成功派發 `harness:issue-created`（`detail.id`）；本頁收到即重抓清單，新那筆高亮約 2 秒，**不改右欄選取**；若被目前篩選擋住，`#iss-count` 提示「有 1 筆新回報不在目前篩選內」，不擅改篩選。
  - 自動更新：頁面掛載且分頁可見時每 15 秒只打 `GET /api/issues`；隱藏時停，回到可見立刻抓一次再恢復；unmount 清計時器與監聽。以 id＋status＋title 簽章比對，沒變不重畫；保留篩選、選取、左欄捲動位置。
  - 不打斷重播：自動更新**不重建右欄**；選中那筆的狀態／標題變了（或不在清單了），右欄頂部出現一條「這筆有更新，按重新整理查看」提示，由指揮官按刷新鈕才完整重抓。
  - 抓取失敗不清空清單，`#iss-count` 顯示「更新失敗，稍後重試」，下次成功自動清除。
- 頭像對話權限：**可讀可寫**（同排程 D4）——Hana 可在對話中改狀態、寫 resolution、掛 TASK 連結；結案除外。

### 5.4 後端 API（`server.js` 或拆 `portal/issues.js`，照 `notes.js` 模式）

| API | 說明 |
|---|---|
| `POST /api/issues` | 送件（含重播資料，上限 30MB）；產生 timeline.md |
| `GET /api/issues?status=&type=` | 清單 |
| `GET /api/issues/:id` | 單筆（含 timeline.md 全文） |
| `GET /api/issues/:id/replay` | 重播資料（gzip 原樣送出並標 `Content-Encoding: gzip`，瀏覽器自動解開） |
| `GET /api/issues/:id/timeline`、`/files/:name` | 時間軸原文；貼圖／指認圖（檔名白名單，防路徑穿越） |
| `POST /api/issues/:id/sessions` | 把一段頭像對話記進 `linkedSessions[]`（去重） |
| `GET /api/issues/summary` | 未結案數（側欄徽章用）；清單 API 另在 `X-Open-Count` 標頭帶同一個數字 |
| `PATCH /api/issues/:id` | 狀態、resolution、links（「已結案」只接受來自頁面按鈕，不接受 Hana 對話寫入） |
| `POST /api/issues/:id/files` | 補貼圖 |

### 5.5 文字時間軸（timeline.md）範例

```
14:02:11  切到「排程」畫面（/app/schedule）
14:02:15  點擊「每日 Gmail 檢查」那一列
14:02:18  點擊「立即執行」按鈕
14:02:18  API POST /api/schedules/sched_xxx/run → 500（回應：…）
14:02:19  畫面錯誤提示：「執行失敗」
14:02:25  指揮官指認：按鈕「立即執行」；說明：按了沒反應
```

由後端讀 rrweb 事件轉出（點擊／輸入／捲動合併、路由、錯誤、API 依時間合併），不用 AI，零額度。

## 6. 分階段

| 階段 | 內容 | 完成後指揮官能做到 |
|---|---|---|
| **IR1** 錄製與送件 | rrweb 套件放進 `portal/vendor`；殼層錄製＋錯誤／API 收集；頭像旁按鈕＋快捷鍵＋回報小窗（含指認、貼圖）；`POST /api/issues` 與存檔；timeline.md 產生 | 按一下就留下一筆問題單 |
| **IR2** 問題管理頁＋頭像討論 | `/app/issues` 清單與單筆（重播、時間軸、環境）；側欄項目；`getChatContext()` 兩層；對話 session 綁定問題單 | 在平台內看、重播、跟 Hana 討論 |
| **IR3** 處理流程閉環 | 狀態流與權限；Hana 對話中改狀態／寫 resolution（含上線版本）；結案／退回按鈕；連結 TASK／排程 | 從回報到驗收一條龍 |
| **IR4** 加值（各自可選） | 出錯自動建單（同錯誤 60 秒去重）；用 browser-pilot 把送出當下畫面算成截圖給 Hana 直接看；側欄卡片顯示未結案 | 不按也會自動回報、Hana 能「看到」畫面 |

每階段結尾保留一條「🧑‍✈️ 指揮官手動驗證」。

## 7. 驗收條件（摘要）

- 任何畫面（含整頁對話、白板、文件、排程）都能叫出回報；送出後清單立即出現該筆。
- 重播能看到送出前約 N 分鐘的操作；timeline.md 能正確列出點擊、畫面切換、API 失敗。
- 在單筆頁點頭像，Hana 第一句就能說出「你在哪個畫面、做了什麼、哪裡出錯」，不需再問。
- Hana 無法把狀態改成「已結案」。
- 平常錄製不讓平台明顯變慢（以白板、文件預覽兩個最重的畫面實測）。

## 8. 風險

| 風險 | 影響 | 對策 |
|---|---|---|
| 重的畫面（白板、文件預覽、簡報 iframe）錄製吃效能或錄不全 | 平台變慢、重播空白 | 畫布不錄、iframe 視情況排除；IR1 實測後再定，必要時提供「暫停錄製」 |
| Hana 讀不懂重播 | 仍要追問 | timeline.md（IR1 就做）＋ IR4 截圖 |
| Deploy／重新整理讓緩衝重來 | 剛更新完就出錯時，紀錄很短 | 接受；在問題單標註「紀錄自頁面載入起」 |
| 重播資料太大 | 硬碟累積 | 壓縮存、單筆上限 30MB；已結案超過 90 天可清（之後再定） |

## 9. 決策（2026-10-21 指揮官拍板：全照建議；Telegram 通知不做——回報者就是指揮官本人、人在電腦前）

| # | 議題 | 選項 | Hana 建議 |
|---|---|---|---|
| D1 | 回報按鈕放哪 | A 頭像旁的圖示面板＋快捷鍵；B 固定右上角；C 固定左下角 | **A**，另在頭像被隱藏時（整頁對話）右下角補一顆小鈕 |
| D2 | 問題單存哪、看得到哪些 | A 集中在 Hana 的家，所有工作區共用一份清單、每筆標來源工作區；B 每個工作區各自一份 | **A**——回報的是 Hana 平台本身的問題，跟在哪個工作區按無關 |
| D3 | 討論方式 | A 頭像對話就是討論串；B 另做類 JIRA 留言串（客戶專案那套） | **A**——不重造，且討論完 Hana 能直接動手 |
| D4 | 出錯自動建單 | 第一版要 ／ 放 IR4 | **放 IR4**，先確認手動流程好用 |
| D5 | 保留幾分鐘 | 1～10 | **3 分鐘**，設定頁可調 |

---

## 10. Changelog

### v0.2（2026-10-21）— IR1 錄製與送件完工（**尚未部署**）

**做了什麼**：殼層背景錄製（rrweb 2.1.7，只放記憶體）＋錯誤堆疊／API／路由收集；頭像面板旗子圖示＋`Alt+Shift+R`＋回報小窗（類型、說明、指出位置、貼圖）；`POST/GET /api/issues`；存檔 `issue.json`／`replay.json.gz`／`timeline.md`／`files/`；timeline 由程式轉出（零額度）。

**動到的檔案**
- 新增：`portal/vendor/rrweb/`（`rrweb.umd.min.js`＝含 record＋Replayer、`rrweb.min.css`、README）、`portal/issues.js`、`portal/issue-timeline.js`、`portal/shell/issue-recorder.js`、`portal/shell/issue-report-ui.js`
- 修改：`portal/server.js`（`require` ＋ 4 條路由，緊鄰 `/api/notes`）、`portal/index.html`（3 行 `<script>`）
- 自測腳本：`.worktable/artifacts/ir1/{backend-test,frontend-test}.js`、開銷原始數據 `overhead-result.txt`

**與前文設計的差異（實作時定案）**
1. **保留分鐘數的設定**：讀 `global-knowledge/issue-report-config.json` 的 `bufferMinutes`（1～10，預設 3，越界退回 3）；`GET /api/issues/config` 供前端讀取。**尚無設定頁 UI**（D5 的「設定頁可調」留待後續）。
2. **「補一顆小鈕」**：沒有另造右下角浮鈕——頭像面板（`#hana-icon-panel`）在頭像被藏（整頁對話）時 CSS 本來就常駐顯示，旗子圖示掛在這個面板裡，因此整頁對話時右下角仍看得到。**需指揮官在真平台確認**。
3. **白板不錄的範圍**：`blockSelector` 設為整個 `.excalidraw` 容器（含工具列），而非只擋 canvas——Excalidraw 的 React 介面本身 DOM 變動頻繁。重播該區會是空白佔位。
4. rrweb `input` 取樣**不用 `'last'`**（那只在欄位失焦才記，人還停在欄位內就按回報會漏掉輸入）。
5. 錄製器的 `fetch`／`console.error`／`history` 包裝各自持有原始函式，且 `stop()` 只在包裝仍是最外層時才還原（避免拆掉 index.html 後來疊上去的 X-Workspace 補丁）。

**自測結果（皆為鏡射層，非真平台）**
- 後端（隔離埠 3399，`require` 真的 `issues.js`＋從 `server.js` 原樣取出的真路由區塊）：21/21 通過——四項檔案齊全、流水號遞增、並發 8 筆不重號、>30MB 回 413 且不留半成品、28MB 可收、清單／單筆／篩選、workspace 由伺服器判定、路徑穿越 404、config 預設／讀檔／越界。
- 前端（Playwright 最小鏡射頁，載入真的 vendor 與 shell 檔）：27/27 通過——緩衝只留 N（N=4s 實測保留 5.0s、開頭必為 Meta→FullSnapshot）、錯誤堆疊含 `app.js:2`、unhandledrejection、console.error、API 只留 30 筆且失敗者回應 2KB、路由切換、密碼不外洩、白板區塊不錄、取消不送、Esc 不送、空說明不能送、指認不觸發原按鈕、貼圖、送件內容完整、rrweb 啟動／途中出錯皆不影響平台。
- `timeline.md`（`_tmp/rrweb-proof/events.json`）讀得出：查無批號→補 `.1`→換 ETCH-04→不良數 3→過帳跳錯（樣本 `.worktable/artifacts/ir1/timeline-sample.md`）。
- `node --check` 全過；`menu-no-emoji.js`、`view-has-menu.js` OK。
- **錄製開銷**（同一個「很忙的畫面」：400×10 表格每 0.1 秒改 20 格＋捲動＋滑鼠＋打字；各 60 秒，headless Chromium）：CPU 10.4% → 10.8%（+0.4 個百分點）；JS 腳本時間 0.2% → 0.8%；JS 記憶體（GC 後）1.0MB → 8.1MB（+7.1MB）；緩衝內約 890 筆事件／2.84MB JSON。

**未驗證項（誠實記載）**
- 沒在真平台（:3400）跑過：圖示是否真的出現在頭像面板、整頁對話時是否可見、`Alt+Shift+R` 是否被真平台其他東西吃掉、`/vendor/rrweb/`、`/shell/` 新檔經真 server 的 MIME 與路徑。
- **開銷只量了鏡射的忙碌頁**；白板、文件預覽、簡報 iframe 這幾個最重畫面（§7 驗收點）**沒量**。真 `index.html` 約 1.6 萬行、Tailwind 執行期產生大量樣式，完整畫面快照會比鏡射頁大很多，單筆 30MB 上限在最重畫面是否夠用**未知**。
- 簡報 iframe（`srcdoc`）內的操作是否錄得到、是否要排除，未驗。
- 送件後的 `timeline.md` 在「真實平台錄製」下的可讀性只用外部素材（`events.json`）與鏡射事件驗過。
- 未做：問題管理頁／重播 UI（IR2）、狀態流（IR3）、自動建單與截圖（IR4）、設定頁調分鐘數。

### v0.3（2026-10-21）— IR2 問題管理頁＋頭像討論完工（**尚未部署**）

**做了什麼**：側欄新增「問題回報」＋未結案數紅徽章；`/app/issues` 同一頁左清單右內容（網址 `?id=N`、重新整理停同一筆）；右欄有重播（停在送出那一刻、可播放暫停拖曳、指認處框紅）、環境資訊、文字時間軸、錯誤與 API 紀錄、貼圖、處理紀錄（唯讀）、討論過的對話；`getChatContext()` 兩層；在單筆頁開的頭像對話自動記進該筆。

**動到的檔案**
- 新增：`portal/views/issues.js`
- 修改：`portal/issues.js`（`countOpen`／`readReplayGz`／`resolveFile`／`linkSession`）、`portal/server.js`（`/api/issues` 區塊補 5 條路由＋清單標頭；`CHAT_CONTEXT_PROVIDERS.issue`；`/api/chat` 內一小段綁定）、`portal/index.html`（側欄項目、`refreshIssueBadge()`、進站與每 60 秒更新）、`portal/shell/issue-report-ui.js`（送出後刷新徽章）
- 自測腳本：`.worktable/artifacts/ir2/{mirror-server,backend-test,frontend-test}.js`、`mirror-page.html`、截圖 `shot-*.png`

**與前文設計的差異（實作時定案）**
1. **未結案數**：清單 API 維持回「陣列」（不改格式以免弄壞既有呼叫端），數字改由 `X-Open-Count` 標頭＋專用的 `GET /api/issues/summary` 提供，側欄用後者。「未結案」＝待處理、處理中、已修正待驗證。
2. **對話綁定在伺服器端做**：`/api/chat` 收到 `context.kind==='issue'` 且為單筆層時，直接把本次 session 記進該筆（不靠前端回呼——前端要等回應才拿得到 sessionId，而且 Telegram 等其他入口也一併涵蓋）。`POST /api/issues/:id/sessions` 仍保留供手動補綁。
3. **重播縮放**：Replayer 以錄製時視窗大小畫、整塊依容器寬縮小（不放大）。
4. **網址指到被篩掉的單**：`?id=` 指到「已結案」等被預設篩選擋掉的單時，篩選自動放寬為「全部狀態」，免得右邊有內容、左邊找不到高亮。
5. 側欄項目沒加進「每工作區可隱藏」的 nav 設定（`DEFAULT_NAV`／設定頁）——問題單是全域共用，不屬單一工作區。

**自測結果（皆為鏡射層，非真平台）**
- 後端（隔離埠 3399，真的 `issues.js`＋從 `server.js` 原樣取出的路由區塊／chat provider／綁定片段）：**44/44**——replay 為 gzip 且事件數一致、files 取圖正確、10 種路徑穿越／非法檔名全被拒、linkedSessions 去重（含並發 6 次重複綁定仍 1 筆）、未結案數正確（已結案、不處理不算；已修正待驗證算）、`/config` 與 `/summary` 沒被 `:id` 吃掉、provider 兩層內容與 timeline 截斷、綁定只對單筆層生效。
- 前端（Playwright，真的 `views/issues.js`＋vendor rrweb＋本機 tailwind）：**46/46**——左右分欄、預設未結案、狀態／類型篩選、點一筆右欄切換且網址 `?id=`、重新整理停同一筆、重播 iframe 保留 sandbox、停在最後一幀、指認框紅（找不到元素時改顯示指認文字）、播放／拖曳、白板提示、貼圖、壞掉的重播檔只影響重播區塊、錄製檔樣式沒洩進外層、空狀態、`getChatContext()` 兩層 key、點討論過的對話呼叫既有 `_openFloatChatWithContext`＋`fcResume`。
- `node --check` 全過；`portal/checks/` 兩支（menu-no-emoji、view-has-menu）OK。

**未驗證項（誠實記載）**
- **沒在真平台（:3400）跑過**，也沒部署。鏡射頁的殼層函式（`showPanel`、`highlightMenuBtn`、`_openFloatChatWithContext`、`fcResume`、`refreshIssueBadge`）是替身；真平台上「點討論過的對話能否真的接回」「側欄徽章位置與更新」「頭像在單筆頁開對話後 Hana 第一句是否就說得出畫面／操作／錯誤」都要指揮官驗。
- `_openFloatChatWithContext`／`fcResume` 是否為全域函式，是依「同檔 inline `onclick="fcResume(...)"` 在用」推斷，沒在真頁面實測。
- `/api/chat` 裡的綁定與 `issue` provider 是從原始碼取出片段單獨跑的，**沒走過真的 chat 流程**；真正 prompt 長相（含 12000 字 timeline）與模型回應品質未驗。
- 真實錄製（含 Tailwind 大量樣式的真平台畫面）的重播保真度、重播載入大檔（接近 30MB）的速度未測；只用 `_tmp/rrweb-proof/events.json`（24KB）。
- 重播畫面目前靠左、不置中；排版細節以真平台為準。
- 本階段未做 codegraph 影響分析的獨立查詢：改動以新增為主（新路由、新 provider 鍵、新 view、`/api/chat` 內一段包 try/catch 的附屬呼叫），未修改既有函式行為。
- 未做：改狀態與權限、Hana 對話寫入問題單、連結 TASK／排程（IR3）；自動建單、截圖、側欄卡片（IR4）；Telegram（永久不做）。

### v0.4（2026-10-22）— IRF 錄影「頁面一能看就開錄」修正（**尚未部署**）

- **問題單 #1／#2 根因**（時序競態）：錄製器先等 `/api/issues/config` 才 `start()`；rrweb 預設要等整頁 load 才真正開錄，此前呼叫 `addCustomEvent` 會丟例外；而 `start()` 立刻標 `running=true` 並寫路由標記 → 例外 → 整台錄製器自殺，只在主控台留一行。結果每次都是 0 筆事件。
- 修正：馬上開錄（DOMContentLoaded）、以第一張快照為準、標記暫存補寫、單筆失敗不停錄、狀態與回報小窗如實顯示（見 §5.1）。改動檔：`portal/shell/issue-recorder.js`、`portal/shell/issue-report-ui.js`。
- 自測：3399 最小鏡射＋5 秒延遲大圖，設定 API 正常／延遲 4 秒／404 三種情境皆在 DOMContentLoaded 後 ≤1 秒 live、圖片未載完即開錄、路由標記補寫成功、操作後事件增加；反例（`addCustomEvent` 必丟例外）錄製器不停、`customErrors` 增加；小窗三狀態截圖；`portal/checks/` 通過。腳本與截圖在 `.worktable/artifacts/irf/`。
- **未驗證**：真平台（Tailwind 大頁面、真實載入順序）上實際開錄速度；需 Deploy 後 Ctrl+F5 由指揮官確認。

### v0.5（2026-10-30）— IRR 問題回報頁自動更新＋刷新按鈕（**尚未部署**）

**做了什麼**：見 §5.3「清單更新」。刷新鈕、同頁送件事件即時出現（高亮 2 秒）、可見時 15 秒輪詢、回到分頁立即抓、沒變不重畫、不打斷重播（改為提示條）、失敗保留清單。
**動到的檔案**：`portal/views/issues.js`、`portal/shell/issue-report-ui.js`（僅 +1 行派發事件）。後端未動。
**與設計的差異**：IRR-4 採設計中的「退一步」方案——右欄不做局部更新，只顯示提示條，避免任何重播中斷風險。
**自測（鏡射層，非真平台）**：隔離埠 3399 + Playwright，23/23 通過（刷新鈕、事件 9ms 出現＋高亮＋選取不變、被篩選擋住提示、輪詢 10s 內跟著變、重播中自動更新後重播器同一個節點且時間持續前進、沒變不重畫、500 保留清單、隱藏 16.5s 零請求且回可見立即 +1、unmount 後零請求）；腳本與截圖在 `.worktable/artifacts/irr/`。`node --check`、`menu-no-emoji.js`、`view-has-menu.js` OK。**未驗證**：真平台實際表現（Deploy 後 Ctrl+F5）。

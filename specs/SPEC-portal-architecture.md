# SPEC — Portal 架構重構（路由化 + 模組化 + 外掛化）

> **一句話**：把單檔 monolith 的 portal（`index.html` 16k 行、`server.js` 8k 行一條 78-if 鏈）重構成
> **① 真實網址路由**（網址看得出在哪、可分享/前進後退）、**② 每個 menu 功能一個獨立 view 模組**（一次只改一個檔）、
> **③ 工作區可用「外掛」貢獻前端 view＋後端路由＋側欄項目**（專案才有的功能不必寫死進平台）。
> g8d_harness 是**新的家**：**開發期就直接在這裡做**（雙軌並行），`_harness` 3300 全程當「不動的對照組」；等 g8d_harness 功能全就位、驗證無誤，才把記憶/task/schedule/封存對話做最後同步、`_harness` 退役。

- 狀態：**已定案**（指揮官 2026-08-01 回「照建議」拍板 D1–D5；D6 定 A；**D7 定 B＝雙軌並行、就地在 g8d_harness 開發**）— 可據此實作
- 建立：2026-08-01
- 相關：`[[SPEC-plugin-contract]]`、`_harness/specs/ARCHITECTURE-portal.md`（舊架構地圖，遷移完成後由本區取代）

---

## 1. 現況（實測，非臆測）

- **前端**：`portal/index.html` 單檔 16,235 行。切換頁面靠 `showPanel(id)` 把 11 個 `<div>` 用 `.hidden` 顯示/隱藏，**沒有網址、沒有路由**。網址永遠是 `/`。
- **11 個面板**（`PANEL_IDS`）：`wiki`(檔案檢視/簡報 host)、`chat`、`codegraph`、`docgraph`、`schedule`、`telegram`、`meeting`、`documents`、`notes`、`audio-topic`、`pm`。
- **後端**：`portal/server.js` 8,346 行，單一 `http.createServer` handler，內含約 **78 個 `if (pathname === …)`** 內聯區塊（不是 Express）。
- **既有外掛能力（重要）**：AI 那層**已有三層合併**——`loadCommands()`：ship(`portal/commands`) < global(`global-knowledge/commands`) < project(`<ws>/.harness/commands`)，`extends` 可繼承。所以 **skill/command 早就能「專案自帶」**。缺的是**前端面板 UI** 與**後端 API 路由**這兩層，目前只能寫死進 monolith。這正是要補的。
- **側欄動態區已有雛形**：manifest 已能驅動 `menu-codegraph-wrap`/`menu-docgraph-wrap` 的顯示，且有 `#dynamic-sections`（`manifest.sidebar.sections`）——外掛側欄可沿用/擴充這條路。

---

## 2. ✅ 決策（已拍板 2026-08-01；下表「我的建議」即最終定案）

| # | 決策 | 定案 | 理由 / 影響 |
|---|---|---|---|
| **D1** | 是否維持**零建置**（vanilla JS + vendored 依賴、無 webpack/React 打包） | **維持零建置** | `Deploy_Harness.ps1` 的冒煙測＋自癒回滾建立在「檔案即上線」；導入打包會斷這條命脈。 |
| **D2** | 後端 78-if 鏈是否換成**路由註冊表** | **換** | 乾淨很多、外掛掛載點才有地方接；可漸進（見 Phase B）。 |
| **D3** | 前端技術棧 | **維持 vanilla**（模組化，非框架化） | 同 D1；風險最低。若你想順便換棧要另議、會大幅拉長工期。 |
| **D4** | 外掛**信任模型**：工作區帶「程式型」外掛（前端 view.js／後端 handler）要不要限「信任工作區」？（純提示型 skill 不限） | **要**：預設只有 registry 標記 `trusted:true` 的工作區能載程式型外掛 | 帶程式進來＝可被執行；不設閘＝任何資料夾都能注入程式。 |
| **D5** | 網址形態 | **`/app/<view>`**（如 `/app/chat`、`/app/pm/<專案>`） | 用 `/app/` 前綴避開跟 `/api/*`、`/raw`、檔案路徑相撞；乾淨且看得出在哪。 |
| **D6** | `global-knowledge`（記憶/技能/voice-config/projects.json）在搬家時「搬過去」還是「共用」 | **搬過去**（A 已定調） | 時機在最後 Phase M；在那之前仍讀 `_harness` 的。 |
| **D7** | **開發模型**：先在 `_harness` 就地重構再搬（A）／先把 portal 搬進 g8d_harness、**雙軌並行就地開發**（B） | **B — 雙軌並行** | 這是「程式整套重構」；同時跑兩套才能比對驗證、改壞了有活的對照組可回退、可重現狀況。`_harness` 3300 全程不動一行。 |

### 2.1 港號與腳本隔離（D7=B 的直接後果）

| 面 | `_harness`（對照組，不動） | `g8d_harness`（實驗組，本重構的家） |
|---|---|---|
| App server 埠 | **3300** | **3400** |
| 冒煙測埠 | 3399 | **3499**（不與 3399 撞） |
| Deploy 腳本 | `Deploy_Harness.ps1` | **`Deploy_G8D.ps1`**（新寫，指向 g8d 開發區/release/HARNESS_HOME、冒煙埠 3499、失敗回滾） |
| Start 腳本 | `Start_Harness.ps1` | **`Start_G8D.ps1`**（新寫，3400 起、HARNESS_HOME 指 g8d 資料目錄） |
| HARNESS_HOME（資料） | `_harness` 的 | **g8d_harness 自己的**（runtime/schedules/secrets 完全分離） |
| Telegram | 正式 bot | **G 階段先 skip polling**（不放 secrets/telegram.json，避免與正式 bot 搶同一 token→409/搶更新） |

> 兩套必須能**同時起、互不搶埠/搶 token**。這是雙軌並行的地基，落在新增的 **Phase G（立家）**，排在所有重構之前。

> **全數定案**：D6 定 A（搬過去）；D1–D5 於 2026-08-01 回「照建議」確認；D7 於 2026-08-01 由指揮官拍板 B（雙軌並行）。spec 就此鎖定，可從 §G 立家開始實作。

---

## 3. 目標架構

### 3.1 前端：路由 + view 模組

- **Router（History API）**：`/app/<view>[/<sub>]` 真實網址；攔截側欄連結與程式化導航呼叫 `router.navigate(path)`；支援瀏覽器前進/後退（`popstate`）。網址是唯一真相——重整頁面回到同一 view。
- **View 模組合約**：每個 menu 功能拆成獨立檔 `portal/views/<name>.js`（+ 選用 `<name>.css`）。每個模組匯出生命週期：
  - `mount(container, ctx)`：把 view 的 DOM 掛進 `container`，綁事件，拉資料。
  - `unmount()`：拆事件/計時器/overlay（如 PM 多甘特 overlay 這種要顯式 teardown 的）。
  - `meta`：`{ route, title, icon, menuGroup }`。
- **App shell**：`index.html` 瘦身成「殼」——只留 `<head>`＋側欄容器＋header 容器＋`#view-root`＋router/loader 啟動。各 view 的大段 HTML/JS/CSS 移出到自己的模組檔。
- **相容層**：保留 `showPanel(id)` 但改成「內部呼叫 `router.navigate`」，讓尚未遷移的面板照舊能動，支撐**漸進遷移、不大爆炸**。

### 3.2 後端：路由註冊表

- 用一張 `routes`（method + path pattern → handler）取代 78-if 鏈；分派器負責 match（含 `:param`）、`X-Workspace` 解析、錯誤包裝。
- 現有 `/api/*` 逐批登記進表（行為不變，只搬位置）。
- 保留 `/api/*` 與 `/raw` 的既有語意；新增 **app 路徑 SPA fallback**：非 `/api`、非 `/raw`、非靜態資產的 `/app/*` 一律回 `index.html`（前端 router 接手）。

### 3.3 外掛合約（詳見 `[[SPEC-plugin-contract]]`）

一個工作區可透過 `plugin.json` 宣告貢獻：**側欄項目 + 前端 view 模組 + 後端路由 handler**。平台於解析工作區時動態載入（受 D4 信任模型約束）。把已存在的三層 command 機制，往「UI＋API」擴到同一套「ship < global < project」疊加模型。

### 3.4 不變量（沿用舊架構地圖，重構不得破壞）

- `.ps1` 限 PowerShell 5.1 語法（禁 `??`/`?.`/`&&`/`||`）。
- **HARNESS_HOME（資料）vs release 目錄（程式）分離**——搬家時尤其別混。
- 只改開發區、**絕不碰 `.releases/`**；改完走 `Deploy_Harness.ps1`（冒煙＋回滾）。
- 聊天回覆不吐整段 HTML/程式碼（`buildChatPrompt` 前言強制＋前端 `sanitizeRenderedHtml` 擋）。
- 排程/記憶/文件等既有**工作區隔離**規則不得因路由化而失效。
- 簡報：一個 deck 只能有一套播放引擎（`presentation-core` 注入式）。

---

## 4. 分階段總覽（細粒度任務見 `.worktable/TASK.md`）

| 階段 | 名稱 | 目的 | 依賴 |
|---|---|---|---|
| **G** | **立家（雙軌並行地基）** | portal 程式快照進 g8d_harness＋`Deploy_G8D.ps1`/`Start_G8D.ps1` 重寫＋埠改 3400/冒煙 3499＋HARNESS_HOME 分離＋兩套同時起 | — |
| **R** | 路由骨架 | History API router＋view 模組合約＋SPA fallback＋showPanel 相容層 | G |
| **B** | 後端路由表 | 78-if 鏈 → 路由註冊表＋外掛路由掛載點 | R2 |
| **P** | 外掛合約 | `plugin.json` 載入器（前端 view＋後端 route＋側欄）＋信任模型 | R3, B3 |
| **S** | 共用外殼模組化 | 側欄/header/avatar-TTS/主題 各自成模組 | R3 |
| **V** | 逐面板遷移 | **每個 menu 功能一個 view 模組**（11+ 面板一項一 task） | R3, S1 |
| **M** | 收尾切換（最後、大幅縮小） | 因程式從 G 起就住 g8d_harness，M 只剩：最後同步 global-knowledge/排程/封存資料＋Telegram 正式接手＋`_harness` 退役決策 | 全部 V 完成 |

**推進策略**：**G（立家，最先）** → R → B → (P 與 S 可並行) → V（大量並行、一面板一任務）→ M（收尾）。每階段結尾固定一條「🧑‍✈️ 指揮官手動驗證」，只由指揮官勾。全程 `_harness` 3300 為不動對照組。

---

## 5. 驗收準則（整體）

- 網址列能反映當前 view（`/app/chat`…）；重整/分享網址回到同一處；前進後退正常。
- 改某一個面板只需動它自己的 `views/<name>.js`，不必碰別的面板或殼。
- 一個示範工作區能用 `plugin.json` 掛一個「平台沒有的」側欄項目＋view＋API，不改平台程式。
- 所有既有功能（11 面板＋簡報＋TTS＋排程＋Telegram＋工作區隔離）行為不退。
- Deploy 冒煙測全綠；自癒回滾仍有效。

---

## 6. 側欄卡片輪播殼（SPEC-sidebar-card-carousel.md，2026-10-08 增補）

側欄頂端（品牌區塊下方）原本是一張寫死的工作台卡，現在是一個**輪播殼**，結構：

```
#sb-carousel                               ← 容器；sb-collapse 收合時整區隱藏＋停計時器
  #sb-carousel-track                       ← 卡片軌道，一次只顯示一張（.sb-carousel-slide-active）
    .sb-carousel-slide[data-card-id="worktable"]       ← 內建，靜態（§SPEC-sidebar-worktable-card.md）
    .sb-carousel-slide[data-card-id="quota:<id>"]      ← 內建，動態（一家模型一張，§SPEC-model-quota.md §3.2）
    .sb-carousel-slide[data-card-id="plugin:<name>:<id>"]  ← 外掛貢獻，受信任才載入（§SPEC-plugin-contract.md §2/§5）
  #sb-carousel-prev / #sb-carousel-next     ← hover 浮出的左右箭頭
  #sb-carousel-dots                        ← 圓點列（僅 1 張可見卡時隱藏）
```

- **卡片註冊表**：`portal/shell/card-carousel.js`（`window.sbCardCarousel`）只管生命週期/排序/輪播/圓點/箭頭的通用機制；
  實際「這次要註冊哪些卡」由 `portal/index.html` 的 `rebuildCardCarousel()` 決定（讀 `manifest.sidebarCards` ＋
  `/api/model-quota` ＋ `/api/status` 的 `plugins[].cards`）。
- 卡片模組合約是既有 view 合約（§3 的 `mount(container,ctx)`/`unmount()`/`ctx.apiFetch`）的子集，版面天條更嚴
  （最多 3 行、不設固定高度、不注入全域 CSS、不開 overlay/modal）。
- 卡片模組檔案由 `portal/server.js` 新增的 `/views/xcard/<pluginName>/<cardId>.js` 路由服務，鏡射既有
  `/views/x/<name>.js`（外掛 view 模組）那條路由的信任閘＋路徑安全檢查寫法。
- 詳細設計決策、設定節點、卡片合約全文見 `specs/SPEC-sidebar-card-carousel.md`。

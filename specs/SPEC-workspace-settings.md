# SPEC-workspace-settings — 工作區設定 UI（可視化編輯 harness.json）

> 狀態：草案（決策已由指揮官拍板，見 §2）
> 相關：`specs/SPEC-portal-architecture.md`（router / view 模組 / 後端路由表）、`specs/SPEC-plugin-contract.md`
> ⚠️ 已被 `specs/SPEC-sidebar-worktable-card.md` 修訂（2026-08-03）：`nav` 的 `dashboard` + `task` 兩鍵**合併為單一 `worktable`**，因為工作台已從選單移進左上角卡片。以下文字已就地更新。
> 任務：`.worktable/TASK.md` §W

---

## 1. 問題

側邊欄的樣貌目前有兩個來源，其中一個完全不可設定：

| 區塊 | 目前來源 | 可設定？ |
|---|---|---|
| 左上角頭像 | `index.html:1060` 寫死 `/raw?path=portal/hana_face.png`（載入失敗才 fallback 到 `#brand-icon` lucide 圖示） | ❌ 寫死 |
| 品牌名稱 / 副標 / icon | `harness.json` → `getManifest()`（server.js）→ `applyManifest()`（index.html:2277） | ✅ |
| 檔案清單區塊（`sidebar.sections`） | 同上 | ✅ |
| CodeGraph / DocGraph 兩顆（`tools`） | 同上（未設定即隱藏） | ✅ |
| AI 對話 / 排程任務 / Telegram / 文件管理 / AI 會議 / 便條貼 / 音訊主題 / 專案管理 | `index.html` 寫死 markup（`#menu-chat`、`#menu-scheduler`、`#menu-telegram`、`#menu-documents`、`#menu-meeting`、`#menu-notes`、`#menu-audio-topics`、`#menu-pm`） | ❌ 寫死 |
| 工作台卡片（看板／任務兩顆按鈕＋展開的檔案樹） | `index.html` 寫死 markup（`#wt-card` 內的 `#menu-dashboard`、`#menu-task`；見 `SPEC-sidebar-worktable-card.md`） | ❌ 寫死 |

結果：每個工作區長得一樣。客戶專案不需要「Hana 自我介紹簡報」、也不需要「音訊主題」，卻無法關掉；要改任何一項都得手動編輯 `harness.json`（沒有 UI），或改動平台程式（寫死那批）。

## 2. 已拍板的決策

| # | 決策 | 選定 |
|---|---|---|
| D1 | 寫死那批導覽項目是否可設定 | **只做「顯示／不顯示」勾選**。它們是全域功能，標籤、圖示、排序一律不開放改（避免每個工作區叫法不同造成溝通成本）。 |
| D2 | 設定入口位置 | **側邊欄底部齒輪** |
| D3 | 可編輯的工作區範圍 | **任一已登錄工作區皆可改寫**（從 `global-knowledge/projects.json` 選），不限當前工作區 |
| D4 | 左上角頭像 | **每工作區可自訂**（本 spec 納入，非 nice-to-have） |

## 3. 資料模型（`harness.json` 增補）

沿用現有檔案，**只增欄位、不改既有語意**，舊 `harness.json` 不改也能正常運作。

```jsonc
{
  "name": "Hana 的家",
  "subtitle": "AI 工作區管理器",
  "icon": "home",                       // 既有：頭像載入失敗時的 lucide fallback
  "avatar": "portal/hana_face.png",     // 【新】相對於工作區根目錄的圖片路徑；省略 = 用預設值
  "nav": {                              // 【新】寫死那批的顯示開關；省略或缺鍵 = 顯示（預設全開）
    "chat": true,
    "worktable": true,                  // 工作台卡片的下半（看板／任務兩顆按鈕＋展開區）；進度條不受此開關控制
    "scheduler": true,
    "telegram": false,
    "documents": true,
    "meeting": true,
    "notes": true,
    "audioTopics": false,
    "pm": true
  },
  "worktable": { "...": "既有" },
  "chat":      { "...": "既有" },
  "sidebar":   { "sections": [ "...既有..." ] },
  "tools":     { "...": "既有（codegraph / docgraph）" }
}
```

規則：
- `nav` 採 **opt-out**：缺鍵視為 `true`。這保證所有現存工作區行為不變。
- `nav.chat` 允許關掉嗎？**允許**，但 UI 上標示「關掉後仍可由網址 `/app/chat` 進入」——`chat` 是核心 view，只隱藏入口、不移除路由。
- `avatar` 為**工作區相對路徑**，透過既有 `/raw?path=...`（帶 `X-Workspace`）取得；解析後必須仍在工作區根目錄內（防 `../` 逃逸），否則視為未設定。
- 沒設 `avatar` 時的預設：沿用今天的 `portal/hana_face.png`；該檔在該工作區不存在（一般專案都不存在）→ `onerror` fallback 到 `icon` 指定的 lucide 圖示（既有行為）。

## 4. 後端

### 4.1 `getManifest(root)` 增補
在既有合併邏輯尾端補兩個欄位：
- `avatar: m.avatar || def.avatar`（`buildDefaultManifest()` 給 `avatar: 'portal/hana_face.png'`）
- `nav: Object.assign({}, DEFAULT_NAV, m.nav || {})`，`DEFAULT_NAV` = 全部 `true`

### 4.2 `PUT /api/manifest`（新增）
- **註冊方式**：登記進 `portal/api-router.js` 的 route table（§B 已就位；`GET /api/manifest` 已在 batch 1 內），不再往 78-if 鏈加。
- **目標工作區**：body 帶 `root`（欲寫入的工作區絕對路徑）；**未帶則用 `resolveWorkspace(req)`（`X-Workspace`）**。
- **白名單**：`root` 必須 `path.resolve()` + 小寫正規化後**命中 `projects.json` 的登錄項或 `WORKSPACE_ROOT`**，否則 400。禁止寫入任意路徑。
- **schema 驗證**（不通過整包拒收、回 400 與欄位訊息）：
  - `name`/`subtitle`/`icon`/`avatar`：字串（`avatar` 另做逃逸檢查）
  - `nav`：物件，值皆為 boolean，鍵須在已知清單內（未知鍵丟棄而非報錯，向前相容）
  - `sidebar.sections`：陣列，每項 `{label, icon, path, filter}` 皆字串，`path` 不得逃出工作區
  - `tools`：只認 `codegraph`/`docgraph`，值為物件或 `null`（`null` = 移除該顆）
- **寫入**：先把現有 `harness.json` 備份成 `harness.json.bak`（單份、覆蓋式），再 `writeFileSync` 格式化 JSON（2 空格）。原檔不存在則直接建立。
- **回應**：寫入後回傳 `getManifest(root)` 的結果（即前端可直接拿去 `applyManifest()`，不必再打一次 GET）。
- 寫入不需 `trusted` 旗標：`harness.json` 是純資料、不含可執行內容，與外掛的 `trust:"code"` 閘門無關。

## 5. 前端

### 5.1 入口
側邊欄最底部（`#nav-container` 之後、與現有底部區同層）加一顆齒輪按鈕 → `router.navigate('/app/settings')`。齒輪本身**不可被關閉**（否則會鎖死自己）。

### 5.2 View 模組 `portal/views/settings.js`
依 `SPEC-portal-architecture.md` 的 view 合約（`mount()` 建 DOM 進 `#view-root` 並呼叫 `showPanel('__view_root__')`）。頁面結構：

- **頂部：工作區選擇器** — 下拉列出 `projects.json` 全部工作區（預設選當前）。切換即重新 `GET /api/manifest`（帶對應 `X-Workspace`）載入該工作區設定。**編輯的不是當前工作區時，頁面顯示明顯提示條**（避免誤改別人的家）。
- **① 品牌** — 頭像（路徑輸入 + 即時預覽 + 「還原預設」）、名稱、副標、fallback 圖示（lucide 名稱）。
- **② 功能選單** — 寫死那批，一項一個 checkbox（唯讀標籤，不可改名／不可排序，符合 D1）；CodeGraph / DocGraph 兩顆也放這區（勾選 = 產生預設 `tools` 設定，取消 = 設 `null`）。
- **③ 檔案區塊** — `sidebar.sections` 清單：新增／刪除／編輯 `label`/`icon`/`path`/`filter`，上下移動排序（不做拖曳，鍵盤與觸控都能用）。
- 底部「儲存」→ `PUT /api/manifest`。**只有編輯的是當前工作區時**才立即 `applyManifest(回傳的 manifest)` 熱套用（不重整）；編輯別的工作區則只提示「已儲存，切換過去即生效」。

### 5.3 `applyManifest()` 增補
- 套用 `m.avatar` 到 `#brand-avatar` 的 `src`（`/raw?path=<avatar>`，並重設 `style.display`，讓上次 fallback 過的狀態能復原）。
- 依 `m.nav` 對那批寫死的按鈕做 `classList.toggle('hidden', !enabled)`。**做法**：給每顆按鈕的外層容器加 `data-nav="<key>"`，`applyManifest()` 用 `querySelectorAll('[data-nav]')` 統一處理——**不是**逐顆寫 `getElementById`（新增功能時只要加 `data-nav` 就自動納管）。工作台卡片的工作台列掛 `data-nav="worktable"`，走同一條路徑。

## 6. 不在範圍

- 不做導覽項目改名／改圖示／排序（D1 已定）。
- 不做工作區的新增／刪除／改名（那是 `projects.json` 的事，另議）。
- 不動外掛（plugin）在側邊欄的顯示邏輯——外掛已有自己的 trust 閘門與清單。
- 不做多人／並行編輯保護（單機單人使用，備份檔已足夠）。

## 7. 驗收

1. 任一工作區關掉「音訊主題」「Telegram」→ 該工作區側邊欄不再出現這兩顆；切回其他工作區仍在。
2. 設定頁改別的工作區並儲存 → 該工作區 `harness.json` 正確更新、`harness.json.bak` 產生；當前工作區側邊欄不受影響。
3. 換頭像圖片路徑 → 儲存後左上角立即換圖，不需重整；填一個不存在的路徑 → fallback 到 lucide 圖示、不破版。
4. 手動把 `harness.json` 刪除 → 一切回到預設（全開、預設頭像），不報錯。
5. `PUT /api/manifest` 帶 `projects.json` 以外的 `root` → 400，且該路徑下沒有檔案被建立。
6. 舊的 `harness.json`（無 `nav`／無 `avatar`）→ 行為與今天完全一致。

---

# 增補 WSX（2026-09-22，Charles 指示）

> 起因：指揮官回報兩件事——①「工作區設定」只能新增**檔案**類型的瀏覽節點，客戶專案自己開發的**外掛**完全不在設定頁裡，而「可設定」本來就是最初的需求；②新增選單項目後，側邊欄**沒有刷新機制**，只能整頁重新整理瀏覽器。
> 本增補**修訂 §6「不動外掛在側邊欄的顯示邏輯」**那一條——當時的判斷是外掛有自己的 trust 閘門就夠了，實務上不成立：側欄會出現的東西，設定頁就該管得到。

## 8. 外掛節點納入工作區設定

### 8.1 現況（問題定位）

| 側欄元素 | 來源 | 設定頁管得到？ |
|---|---|---|
| 內建功能選單 11 項 | `views/settings.js` 的 `NAV_ITEMS` 寫死 → `harness.json.nav` | ✅ 只能開關 |
| 檔案區塊 | `harness.json.sidebar.sections` | ✅ 可增刪改排序 |
| **工作區外掛**（`.harness/plugins/*/plugin.json`） | `/api/status` 的 `plugins`（`getPlugins()` → `plugin-loader.loadPlugins()`），由 `shell/sidebar.js` 直接全部畫出 | ❌ **完全管不到** |

外掛順序目前等同 `fs.readdirSync()` 的檔名順序，無法調整；也無法隱藏某一個而不刪檔。
（實例：客戶專案工作區有 5 個外掛——`gitbranch`／`manual`／`nocodegit`／`samplecode`／`tracksim`。）

### 8.2 決策

| # | 決策 | 選定 | 理由 |
|---|---|---|---|
| D5 | 外掛在設定頁可改到什麼程度 | **只做「顯示／隱藏」＋「排序」**；標籤與圖示仍以 `plugin.json` 為唯一真相，設定頁唯讀顯示 | 避免同一個外掛的名字出現兩處來源而打架；外掛是工作區自己寫的，要改名直接改 `plugin.json` 最直覺 |
| D6 | 設定資料放哪 | `harness.json` 新增 `plugins` 物件，**不塞進 `nav`** | `nav` 的鍵是平台內建功能的固定白名單（`DEFAULT_NAV`，`PUT /api/manifest` 會丟掉未知鍵）；外掛名是動態的，混進去會被靜默丟棄 |
| D7 | 未被設定過的外掛 | **預設顯示**（opt-out），排在已排序清單之後、依名稱排序 | 與 `nav` 的 opt-out 語意一致；新裝的外掛不會被靜默藏起來 |
| D8 | 未信任（`trust:"code"` 但工作區未 `trusted`）的外掛 | 設定頁**照樣列出**並標示「未信任」，仍可調整顯示／排序 | 與 §6 既有的「停用也要看得到原因」一致 |

### 8.3 資料模型（`harness.json` 增補）

```jsonc
{
  "plugins": {
    "order": ["tracksim", "manual", "nocodegit"],   // 只列有指定順序的；其餘接在後面依名稱排
    "hidden": ["samplecode"]                         // 不顯示在側欄；未列＝顯示
  }
}
```

- 兩個欄位都可省略；舊 `harness.json` 行為完全不變。
- `hidden` **只影響側邊欄的顯示**，不影響 `/app/x/<name>` 直接開啟，也**不繞過 trust 閘門**（安全邊界仍在 server 端，見 `SPEC-plugin-contract.md` §5）。

### 8.4 後端

- `getManifest()` 增補 `plugins: { order: [], hidden: [] }`（型別不符一律回退空陣列，壞掉的 `harness.json` 不得讓整個側欄掛掉）。
- `PUT /api/manifest` 接受 `patch.plugins`：`order`／`hidden` 必須是字串陣列，否則 400；值只做去重與去空白，**不驗證外掛是否存在**（外掛可能屬於尚未掛載的工作區）。
- `/api/status` 的 `plugins` 陣列在輸出前套用排序與 `hidden` 過濾，並替每筆補上 `hidden: true|false`，讓設定頁能列出被藏起來的那些。
  - ⚠️ 側欄拿的是過濾後的清單；設定頁要拿**完整清單**，故 `/api/status` 對被隱藏者仍輸出該筆、只標記 `hidden:true`，由前端 `sidebar.js` 自行略過——**單一來源，不另開 API**。

### 8.5 前端（`views/settings.js`）

- 「功能選單」卡片下方新增第三組「**工作區外掛**」，列出目前編輯中工作區（`state.editRoot`）的外掛：
  - 每列：顯示勾選框、圖示、標題（唯讀）、`name`（唯讀、等寬字）、上移／下移。
  - 未信任者列尾標「未信任：<原因>」灰字。
  - 沒有任何外掛時顯示「此工作區沒有外掛」，並附一行提示：外掛放在 `<工作區>/.harness/plugins/<名稱>/plugin.json`。
- 儲存時把順序與隱藏集合寫進 `patch.plugins`。
- 外掛清單一樣走 `asWorkspace(editRoot, …)` 取得（沿用既有的 sessionStorage 暫換技巧），確保編輯別的工作區時列到的是**那個**工作區的外掛。

## 9. 選單刷新（不必重整整個瀏覽器）

### 9.1 現況（問題定位）

`/api/status` 只在 `index.html` 啟動流程中抓**一次**，`statusData` 之後不再更新。因此新增檔案區塊、新增外掛、改品牌，都得整頁 F5。設定頁存檔後雖有呼叫 `window.applyManifest()`，但它只處理品牌與 `nav` 的顯示開關，**不會重畫檔案區塊與外掛清單**。

### 9.2 決策

| # | 決策 | 選定 |
|---|---|---|
| D9 | 刷新方式 | **手動按鈕 ＋ 設定頁存檔後自動呼叫**。不做輪詢（側欄不值得固定打 API） |
| D10 | 刷新範圍 | 只重畫「側邊欄外殼」：品牌／`nav` 顯示／檔案區塊／外掛／技能樹／工作台卡片。**不動目前開著的主畫面 view**，不重載頁面、不清掉聊天內容 |
| D11 | 按鈕位置 | 側邊欄底部，齒輪（工作區設定）旁邊，圖示 `refresh-cw` |

### 9.3 做法

- 把 `index.html` 啟動流程中「抓 `/api/status` → `applyManifest()` → `renderSidebarLists()` → `renderSkillsTree()` → `initWorktableCard()`」抽成可重複呼叫的 `window.reloadShell()`；啟動流程改為呼叫它，**不複製一份邏輯**。
  - 抽出時要保留啟動時才該做的事（載入 DASHBOARD、`router.restore()`、設定 `current_workspace`）**留在啟動流程**，不要進 `reloadShell()`——否則按一下刷新會把使用者踢回 DASHBOARD。
  - `initWorktableCard()` 既有的 `wtCardBound` 旗標已能防止重複綁事件；`renderSidebarLists()` 每次都重建 DOM，無殘留監聽。
- 刷新中按鈕顯示轉圈、完成後 toast「選單已更新」；失敗顯示錯誤 toast 且保留舊側欄（不清空）。
- `views/settings.js` 儲存成功後改呼叫 `window.reloadShell()`（取代目前只呼叫 `applyManifest()` 的做法）；編輯的是**別的**工作區時不呼叫（沿用既有的 isOtherWorkspace 判斷與提示文案）。

## 10. 不在範圍（WSX）

- 不做外掛的安裝／刪除／改名（那是檔案系統的事）。
- 不在設定頁改外掛的標籤與圖示（D5）。
- 不做側欄自動輪詢或 WebSocket 推播（D9）。
- 不動 trust 模型。

## 11. 驗收（WSX）

1. 客戶專案工作區開設定頁 → 「工作區外掛」列出 5 個外掛；取消勾選 `samplecode` → 存檔 → 側欄該項消失，其餘不變；重開瀏覽器仍維持。
2. 把 `tracksim` 上移到第一 → 存檔 → 側欄外掛順序跟著變。
3. 在別的工作區（如 Hana 的家）開設定頁選「客戶專案」→ 列到的是客戶專案的外掛，不是自己的；存檔只改到客戶專案的 `harness.json`。
4. 手動在工作區新增一個 `plugin.json` → 按側欄「刷新選單」→ 不重整瀏覽器即出現，且目前開著的畫面（例如正在編輯的白板／對話）不被重置。
5. 新增一個檔案區塊並存檔 → 側欄立即出現，無需 F5。
6. 舊的 `harness.json`（無 `plugins` 欄位）→ 所有外掛照常全顯示、順序與今天一致。
7. `PUT /api/manifest` 帶 `plugins.order = "abc"`（非陣列）→ 400，檔案未被改動。

## Changelog（WSX）

- 2026-09-22 建立增補 WSX，修訂 §6 對外掛的排除條款。決策 D5–D11 由 Charles 指示、Hana 提案。
- 2026-09-22 WSX1 完成：`portal/index.html` 抽出全域 `window.reloadShell(opts)`（`opts.silent` 供開機/存檔後呼叫免跳「選單已更新」toast，避免與各自的成功提示疊兩個 toast），啟動流程與側欄「刷新選單」按鈕、`portal/views/settings.js` 存檔成功後共用同一份邏輯。隔離埠 3399 鏡射＋Playwright 自動化驗證：連按兩次不重複發送請求／不卸載目前開著的 view／`/api/status` 失敗時側欄維持原狀；並在過程中抓到並修掉一個真的漏洞——按鈕失敗時 `reloadShell()` 內部重拋的錯誤沒人接，會變成 console 的 unhandled promise rejection（已在按鈕與 `settings.js` 呼叫端加 `.catch()` 收掉）。
- 2026-09-22 WSX2 完成（實作與規格一致，無出入）：`portal/server.js` 新增 `normalizePluginsManifest()`（型別防呆）、`applyPluginManifestOrder()`（依 `manifest.plugins.order` 排序＋補 `hidden` 旗標），`buildDefaultManifest()`／`getManifest()`／`/api/status`／`PUT /api/manifest` 依 §8.4 串起來；`portal/shell/sidebar.js` 的 `renderSidebarLists()` 加一行跳過 `hidden:true`；`portal/views/settings.js` 新增「工作區外掛」卡片（`renderPlugins()`）與 `loadPluginsFor()`（沿用 `asWorkspace()` 打 `/api/status` 取目標工作區的外掛清單，無另開端點）。自測方式與 §8.4 原設想略有不同：因涉及的三段邏輯（型別正規化／排序過濾／PUT 驗證）皆為純函式、無 I/O，改用「原樣鏡射進獨立腳本直接跑」取代隔離埠 3399——比起跑一顆 HTTP server 再打它更乾淨、無需佔用埠或事後確認釋放，16 項斷言全數通過（詳見 TASK.md WSX2-6）。**前端 `settings.js` 的實際渲染畫面本次未做瀏覽器／Playwright 視覺驗證**，僅語法檢查通過＋比對已產品化的 `renderSections()` pattern，留待指揮官手動驗證時一併確認。

---

# 增補 WSXT — 選單節點的「新分頁開啟」（2026-09-22）

> 需求（Charles）：客戶專案那類外掛（範例站台、線上操作手冊……）要做成「獨立網站」交付，
> 因此選單點下去不該一律內嵌在右側面板，而要能用**獨立瀏覽器頁籤**開啟。兩種：
> ①再開一個完整 Hana 頁籤，該功能內嵌在它的右側；②只開該功能自己的畫面，沒有 Hana 外殼。

## 12. 決策

| # | 決策 | 選定 | 理由 |
|---|---|---|---|
| D12 | 三種開啟方式的名稱與語意 | `embed`（預設，內嵌右側面板）／`tab`（新頁籤，含完整 Hana 外殼）／`standalone`（新頁籤，只有該功能自己，無側欄／無頁首／無頭像） | 對應指揮官講的「內嵌」「多開一個 Hana」「單獨開啟該功能網站」三者，一對一不多不少 |
| D13 | 套用範圍 | **只做外掛節點**（`/app/x/<name>`）。**檔案清單區塊（`sidebar.sections`）本次不做** | 檔案是用 `loadFile()` 開的、**沒有可深連的網址**（`/app/wiki` 不帶檔案路徑），要支援得先新增一套檔案深連機制——與本需求（外掛當獨立網站）無關，另案再談 |
| D14 | 設定放哪 | `harness.json` 的 `plugins` 物件再加一個 `openMode` 對照表，鍵為外掛 `name` | 與 WSX 的 `order`／`hidden` 同一個容器、同一支 `PUT /api/manifest` 驗證，不另開欄位樹 |
| D15 | 真相來源 | **設定頁為唯一真相**；`plugin.json` 本次不新增 `defaultOpen` 欄位 | 沿用 D5 的原則（同一件事不要兩處來源打架）；外掛作者想預設獨立開，可由工作區設定一次設定好 |
| D16 | 未設定過的外掛 | 一律 `embed` | 與今天行為完全一致，舊工作區無感 |
| D17 | 獨立外殼（`standalone`）用什麼網址 | 新增 `GET /x/<name>`（與內嵌用的 `/app/x/<name>` 平行，不共用 `index.html`） | `index.html` 是整個平台外殼（側欄／頁首／頭像／路由／全域腳本），無法「關掉外殼」；獨立頁必須是另一份極簡 host |
| D18 | 獨立外殼提供什麼環境 | 提供既有外掛實際依賴的最小相容層：Tailwind CDN、lucide、`window.apiFetch`（自動帶 `X-Workspace`）、`window.showToast`、深淺色 class。平台專屬全域（`loadFile`、`statusData`、`router`、`openHanaChat` 等）提供 **no-op 殘件並在 console 警告** | 外掛是照「內嵌在平台裡」寫的，直接裸跑會因缺全域而白屏；殘件讓它至少能開、並明確指出用到了什麼平台能力 |
| D19 | 工作區怎麼跟著新頁籤走 | 兩種新分頁都在網址帶 `?workspace=<絕對路徑>`；`index.html` 開機時若有此參數就寫入 `sessionStorage.current_workspace`（優先於伺服器啟動預設） | `sessionStorage` **不會**繼承到新頁籤，不帶參數的話新頁籤會落回 server 啟動時的預設工作區——客戶專案的外掛會 404 或讀到別人的資料 |

## 13. 資料模型（`harness.json`，WSX §8.3 增補）

```jsonc
{
  "plugins": {
    "order": ["tracksim", "manual"],
    "hidden": ["samplecode"],
    "openMode": { "manual": "standalone", "samplecode": "tab" }   // 未列＝embed
  }
}
```

- 三個欄位皆可省略；舊 `harness.json` 行為完全不變。
- `openMode` 只影響**側欄點擊行為**，不影響 `/app/x/<name>` 本身仍可直接開，也不繞過 trust 閘門。

## 14. 後端

- `normalizePluginsManifest()` 增補 `openMode`：必須是物件，值只接受 `"embed"|"tab"|"standalone"`，其他一律丟棄該鍵（不整包報錯，壞掉的檔不得讓側欄掛掉）。
- `PUT /api/manifest` 的 `patch.plugins` 驗證增補：`openMode` 非物件 → 400；值不在三種之內 → 400（與 `order`／`hidden` 的嚴格度一致，避免前端靜默寫壞）。
- `/api/status` 的 `plugins` 每筆補 `openMode`（預設 `"embed"`），側欄與設定頁共用同一份輸出，**不另開 API**。
- 新增 `GET /x/<name>`（獨立外殼，D17／D18）：
  - 產生一份極簡 HTML：`<head>` 載入 Tailwind／lucide／外掛自己的 `styles`；`<body>` 只有一個 `#view-root`，inline script `import('/views/x/<name>.js?workspace=…')` 後呼叫 `mount()`。
  - `?workspace=` 解析沿用 `resolveWorkspace(req)` 的同一套（Web 看 `X-Workspace`，此處另接受 query，因 `import()` 帶不了 header——與既有 `/views/x/<name>.js` 的做法一致）。
  - trust 閘門照走：未信任的 `trust:"code"` 外掛回 403，文案同既有 `/views/x/` 處理。
  - 找不到外掛回 404 純文字。
  - `Cache-Control: no-store`（與 `index.html` 一致，避免部署後拿到舊外殼）。

## 15. 前端

- `portal/shell/sidebar.js` 外掛按鈕點擊改依 `pl.openMode`：
  - `embed` → 今天的 `router.navigate('/app/x/' + name)`（完全不變）
  - `tab` → `window.open('/app/x/' + name + '?workspace=' + enc, '_blank')`
  - `standalone` → `window.open('/x/' + name + '?workspace=' + enc, '_blank')`
  - 非 `embed` 者在標題後加一個小的 `external-link` 圖示，讓人一眼看出會開新頁籤。
- `portal/index.html` 開機流程：若 `location.search` 有 `workspace`，先寫入 `sessionStorage.current_workspace` 再跑其餘啟動步驟（D19）。此段屬**開機專屬**，不得進 `reloadShell()`。
- `portal/views/settings.js`「工作區外掛」每列新增一個下拉：內嵌（預設）／新分頁（完整 Hana）／新分頁（獨立畫面）；儲存時寫進 `patch.plugins.openMode`（值為 `embed` 者省略不寫，保持檔案乾淨）。

## 16. 不在範圍（WSXT）

- 檔案清單節點的新分頁開啟（D13）。
- `plugin.json` 自帶預設開啟方式（D15）。
- 獨立外殼的自訂標題／favicon／品牌（第一版用外掛 `title` 當 `<title>`，其餘不做）。
- 讓獨立外殼支援平台全域（只給 no-op 殘件，D18）。

## 17. 驗收（WSXT）

1. 客戶專案工作區設定頁 → 「線上操作手冊」選「新分頁（獨立畫面）」→ 存檔 → 按刷新選單 → 側欄該項顯示 external-link 圖示，點擊開出新頁籤且**沒有**側欄／頁首／頭像，功能本身可正常讀資料（API 有帶對工作區）。
2. 同一外掛改選「新分頁（完整 Hana）」→ 點擊開出完整 Hana 頁籤，右側已是該外掛，且**左上工作區仍是客戶專案**（不是 server 啟動預設工作區）。
3. 改回「內嵌」→ 行為與今天完全相同（原頁籤內嵌、不開新頁籤）。
4. 未信任的 `trust:"code"` 外掛設成 `standalone` → 直接開 `/x/<name>` 回 403 並顯示原因（trust 閘門未被繞過）。
5. `/x/不存在的名字` → 404 純文字，不是 500、不噴 stack。
6. 舊 `harness.json`（無 `openMode`）→ 所有外掛照舊內嵌。
7. `PUT /api/manifest` 帶 `plugins.openMode = { "a": "popup" }`（非三種之一）→ 400，檔案未被改動。

## Changelog（WSXT）

- 2026-09-22 WSXT2 完成（與規格有 2 處出入，如實記錄）：`portal/server.js` 新增 `GET /x/<name>`（嚴格 regex `^/x/([A-Za-z0-9_-]+)$`，放在 `/views/x/` 靜態 handler之前的相鄰區塊，共用同一套 trust 閘門／404 邏輯）；產生極簡 HTML，`<head>` 載入平台既有的 `/vendor/tailwind.js`＋`/vendor/lucide.min.js`（**出入①**：規格原文寫「Tailwind CDN」，但平台其餘所有頁面一律走 vendored 離線版本，為與現行慣例一致、維持離線可用性，改用 vendored 版本而非外部 CDN）＋外掛自帶 `styles`（`<link>` 指向既有 `/views/x/<name>.css?workspace=`）；`<body>` 僅 `#view-root`；inline module script `import('/views/x/<name>.js?workspace=' + 該 tab 的 workspace)` 後呼叫 `mod.mount(root, { workspace, sub: null, plugin: name, apiFetch })`，ctx 形狀與 `router.js` 的 plugin 分支對齊。`workspace` 來源：`resolveWorkspace(req)`（已內建 query fallback，見 `resolveWorkspace()` 第 146–151 行，故不需另寫一套）。回應標頭 `Cache-Control: no-store`。相容層：`window.apiFetch` 自動帶 `X-Workspace`（語意同 index.html 的 fetch 包裝，讀 `sessionStorage.current_workspace`）；`window.showToast` 簡易角落提示；深淺色沿用 `documentElement.classList` + `localStorage.theme`，與 index.html 一致；`loadFile`／`router`／`statusData` 用 `Object.defineProperty` getter 給 no-op＋`console.warn('[standalone] ...')`（**出入②**：規格列的「頭像相關」全域未逐一枚舉 stub——目前平台沒有單一穩定入口點可鏡射（頭像相關函式散在多處、部分依賴 DOM 結構），故未處理；若外掛實際呼叫到會照常拋錯，非規格要求的「no-op 殘件」保護，留給指揮官驗收時反饋是否需要補）。`<title>` 用 `plugin.title || plugin.name`，已 HTML escape。自測：HTML 產生／trust／404 邏輯原樣鏡射到隔離埠 3399 的獨立 `http.createServer` 腳本（假外掛清單，非完整 portal server），4 項斷言全過（未信任 403＋文案、不存在 404 純文字、正常外掛 200＋`import()` 網址與 `?workspace=` 正確＋`no-store`、`?workspace=` 缺省回退預設）；測完刪暫存腳本、`netstat` 確認 3399 僅剩 `TIME_WAIT`。**未做的一項，如實標註**：未用 Playwright 對客戶專案真實外掛做裸跑驗證（需要真 `getPlugins()`/已部署 server），留給指揮官部署後手動驗證一併確認。`Deploy_Harness.ps1` 依系統佈署政策本次未執行，需指揮官另行觸發上線。
- 2026-09-22 WSXT1 完成（實作與規格一致，無出入）：`portal/server.js` 的 `normalizePluginsManifest()`／`buildDefaultManifest()`／`applyPluginManifestOrder()`／`PUT /api/manifest` 依 §14 補上 `openMode`（未知鍵/非法值逐鍵丟棄，不整包報錯）；`portal/shell/sidebar.js` 外掛按鈕依 `openMode` 分流（`embed` 行為完全不變／`tab`／`standalone` 開新頁籤並帶 `?workspace=`，非 embed 加 `external-link` 小圖示）；`portal/index.html` 的 `init()` 開頭（`reloadShell({silent:true})` 之前）新增讀取 `location.search` 的 `workspace` 寫回 `sessionStorage.current_workspace`（刻意未放進 `reloadShell()`，避免刷新選單把工作區彈回網址舊值）；`portal/views/settings.js`「工作區外掛」每列新增開啟方式下拉，存檔時 `embed` 省略不寫。自測：`normalizePluginsManifest()`／PUT 驗證段鏡射進獨立腳本，15 項斷言全過（含 §17 第 6、7 項）；側欄導流用隔離埠 3399 純靜態鏡射（非完整 portal server）＋Playwright，8 項斷言全過（三種 openMode 的點擊行為、未設定時預設 embed）；測完已刪暫存檔、kill 行程、確認埠已釋放。**唯一未做瀏覽器自動化驗證的一項**：`index.html` 開機讀 `?workspace=` 與「刷新選單不覆寫」僅靠程式碼審視＋語法檢查確認，留待指揮官手動驗證時一併確認（WSXT2 完成後才有 `/x/<name>` 真實入口可完整走一次新分頁流程）。`Deploy_Harness.ps1` 依系統佈署政策本次未執行，需指揮官另行觸發上線。

---

# 增補 WSXU — 外掛的「網址」看得到、代稱改得了（2026-09-22）

> 需求（Charles）：客戶專案做了「模擬站台」「線上操作手冊」兩個要當獨立網站交付的外掛，
> 但設定頁**完全看不到它們的網址**，更不能改。指揮官要求：**即便是內嵌的外掛，也要能在設定頁看到它的 routing**。

## 18. 現況（問題定位）

外掛的每一條網址都由 `plugin.json` 的 `name` 直接推導，設定頁一條都沒顯示：

| 用途 | 網址 | 產生處 |
|---|---|---|
| 內嵌（前端路由） | `/app/x/<name>` | `shell/sidebar.js` 拼字串 → `router.js` |
| 獨立外殼（WSXT2） | `/x/<name>` | `server.js` 的 `GET /x/<name>` |
| view／樣式模組 | `/views/x/<name>.js｜.css` | `server.js` 靜態 handler；由 `router.js` 依網址 `sub` 推導 |
| 後端 API 前綴 | `/api/x/<name>/*` | `server.js` P3 區塊 |

## 19. 決策

| # | 決策 | 選定 | 理由 |
|---|---|---|---|
| D20 | 設定頁顯示什麼 | 每個外掛**一律列出全部網址**（內嵌／獨立／API 前綴），各附一鍵複製；即使該外掛是 `embed` 也照列 | 直接對應指揮官「內嵌的也要看得到 routing」 |
| D21 | 可編輯的是什麼 | 新增「網址代稱」（slug）。**只改頁面網址**（`/app/x/<slug>`、`/x/<slug>`、`/views/x/<slug>`），**`/api/x/<name>` 不動、唯讀顯示** | 外掛自己的程式把 API 路徑寫死在原始碼裡，跟著改會當場壞掉；頁面網址則沒有這個綁定 |
| D22 | 舊網址怎麼辦 | slug 是**別名**不是取代——`<name>` 的網址永遠仍可用，兩條都通 | 已經發出去的連結不會死，也不必做轉址表 |
| D23 | 要不要開放根網址（如 `/manual`） | **不開放**，維持 `/x/` 前綴 | 根路徑屬於平台（`/app`／`/api`／`/views`／`/vendor`／`/shell`／`/raw`／`/router`…），開放根網址會撞既有路由、且平台日後每加一條路徑都可能踩到使用者的外掛。真要「乾淨網域」是反向代理／網域層的事，不該拿平台路由去換 |
| D24 | slug 格式與衝突 | 格式 `^[a-z0-9][a-z0-9-]{0,39}$`；同一工作區內 slug 不可重複（`PUT` 回 400）。若 slug 撞到**別的外掛的 `name`**，解析順序固定為「先比 `name`、再比 `slug`」→ name 優先，設定頁顯示警告 | 解析順序寫死才不會因為載入順序不同而行為飄移 |
| D25 | 真相來源 | 設定頁（`harness.json`）為唯一真相，`plugin.json` 不新增 `slug` 欄位 | 沿用 D5／D15：同一件事不要兩處來源打架 |

## 20. 資料模型（`harness.json`，WSX §8.3／WSXT §13 再增補）

```jsonc
{
  "plugins": {
    "order": ["tracksim", "manual"],
    "hidden": ["samplecode"],
    "openMode": { "manual": "standalone" },
    "slug": { "manual": "handbook", "tracksim": "sim" }   // 未列或空字串＝沒有代稱，僅 name 可用
  }
}
```

- 四個欄位皆可省略；舊 `harness.json` 行為完全不變。
- `slug` 不繞過 trust 閘門、不影響 `hidden`／`openMode` 的語意。

## 21. 後端（`portal/server.js`）

- `normalizePluginsManifest()` 增補 `slug`：必須是物件；鍵與值皆為字串且值需符合 D24 格式，不符者**逐鍵丟棄**（壞掉的 `harness.json` 不得讓側欄掛掉）。
- `PUT /api/manifest` 的 `patch.plugins` 驗證增補：`slug` 非物件 → 400；值不符格式 → 400；值有重複 → 400（訊息需指出是哪個值重複）。與 `order`／`hidden`／`openMode` 的嚴格度一致。
- 新增 `findPluginByKey(list, key)`：**先比 `name`，命中即回；否則比 slug**（D24）。
- 改用 `findPluginByKey()` 的查找點：`GET /x/<key>`（WSXT2 新增的獨立外殼）、`/views/x/<key>.js｜.css`。
  - **`/api/x/<name>/*` 維持只認 `name`**（D21），不得改成接受 slug。
- `/api/status` 的每筆 plugin 增補：
  - `slug`（無則 `null`）
  - `routes: { embed: "/app/x/<key>", standalone: "/x/<key>", api: "/api/x/<name>/" }`，其中 `<key>` ＝ slug 有值時用 slug、否則用 name。
  - 側欄與設定頁**共用這一份輸出**，前端不得自行拼網址字串（單一來源）。

## 22. 前端

- `portal/shell/sidebar.js`：外掛按鈕的 `tab`／`standalone` 網址改讀 `pl.routes.embed` ／ `pl.routes.standalone`，不再自己拼 `'/x/' + pl.name`；`embed` 分支改 `router.navigate(pl.routes.embed)`。
- `portal/views/settings.js`「工作區外掛」每列增補：
  - 一個「網址代稱」輸入框（`placeholder` 顯示該外掛的 `name`，代表留空就是用 name）；即時檢查格式與重複，不合格時該列標紅並**擋下儲存**（不送出壞資料讓後端回 400）。
  - 一小塊唯讀網址區：內嵌 `/app/x/<key>`、獨立 `/x/<key>`、API `/api/x/<name>/`，各附複製鈕（`navigator.clipboard`，失敗時 fallback 選取文字）。API 那條要標「由外掛程式使用、不可更改」。
  - 改了代稱後，唯讀網址區要**即時跟著變**（讓人存檔前就看得到結果）。
  - 儲存時寫入 `patch.plugins.slug`，空值省略不寫（保持檔案乾淨）。

## 23. 不在範圍（WSXU）

- 根網址（`/manual` 這種不帶 `/x/` 前綴的）——D23。
- 改 `/api/x/<name>` 的命名空間——D21。
- 檔案清單節點的網址（它沒有深連網址，見 WSXT D13）。
- 舊網址 301 轉址（D22 已讓兩條並存，不需要）。
- `plugin.json` 自帶 `slug`（D25）。

## 24. 驗收（WSXU）

1. 客戶專案工作區開設定頁 → 每個外掛都看得到三條網址（內嵌／獨立／API），含設為「內嵌」的那些。
2. 把「線上操作手冊」代稱設成 `handbook` → 存檔 → 側欄該項點下去走 `/x/handbook`（或 `/app/x/handbook`），畫面正常。
3. 同時直接開舊網址 `/x/manual` → 仍然可用（D22）。
4. 代稱填 `Hand Book`（含空白與大寫）→ 前端即時標紅且擋下儲存；若強行 `PUT` 該值 → 400，檔案未被改動。
5. 兩個外掛填同一個代稱 → 前端擋下；強行 `PUT` → 400 並指出重複的值。
6. 代稱填成另一個外掛的 `name` → 該網址仍解析到原本那個 name 的外掛（name 優先），設定頁顯示警告。
7. 舊 `harness.json`（無 `slug`）→ 所有外掛網址與今天完全一致。
8. `/x/<不存在的代稱>` → 404 純文字，不是 500。

## Changelog（WSXU）

- 2026-09-22 建立增補 WSXU，決策 D20–D25 由 Charles 指示、Hana 提案。兩筆手動排程串接（WSXU1→WSXU2），`postRun.deploy=false`。
- 2026-09-22 WSXU1 完成（實作與規格一致，無出入）：`portal/server.js` 依 §21 補上 `normalizePluginsManifest()`／`buildDefaultManifest()` 的 `slug` 欄位（格式 `^[a-z0-9][a-z0-9-]{0,39}$`，逐鍵丟棄不整包報錯）、`PUT /api/manifest` 的格式與重複值驗證、新增 `findPluginByKey(list, key)`（name 優先、否則 slug，D24）、`GET /x/<key>` 與 `/views/x/<key>.js｜.css` 改用它、`applyPluginManifestOrder()` 每筆補 `slug`／`routes:{embed,standalone,api}`（`api` 一律用 `name`，D21 未動）。實作補充一點規格未明寫的細節：`GET /x/<key>` 內部產生的 `/views/x/<name>.js` 連結與傳給 `mount()` 的 `ctx.plugin`，一律改用解析後的 `plugin.name`（不是 url 上可能是 slug 的那個 key）——避免內部組出的網址／API 呼叫因為 url 用了 slug 而產生歧義；`/views/x/` handler 本身仍同時接受 name 或 slug 直接請求（供舊連結／書籤使用）。自測：①純函式邏輯（normalize／PUT 驗證／findPluginByKey／routes 組法）鏡射進獨立腳本，17 項斷言全過（涵蓋 §24 第 4、5、6、7 項）；②`GET /x/<key>` 與 `/views/x/<key>.js` 兩條 handler 的接線用隔離埠 3399 的獨立 `http.createServer` 鏡射（假外掛清單）另跑 6 項斷言全過（by-name／by-slug 皆解析正確、未信任 403、不存在 404）；測完刪暫存腳本並確認 3399 已釋放。**未做的一項，如實標註**：未對前端（設定頁顯示網址、編輯代稱 UI）做任何驗證——那是 WSXU2 的範圍，本次只交付後端資料模型與路由解析。`Deploy_Harness.ps1` 依系統佈署政策本次未執行，需指揮官另行觸發上線。
- 2026-09-22 WSXU2 完成（實作與規格一致，1 處自測範圍出入，如實記錄）：`portal/shell/sidebar.js` 外掛按鈕的 `embed`／`tab`／`standalone` 三分支改讀 `pl.routes.embed`／`pl.routes.standalone`（單一來源，§22），`pl.routes` 缺席時（舊快取或尚未部署 WSXU1 的 `/api/status`）逐欄位安全回退成 `'/app/x/'+name`／`'/x/'+name`，不拋錯不白屏。`portal/views/settings.js`「工作區外掛」每列新增：①網址代稱輸入框（placeholder＝`name`）；②唯讀網址區塊（內嵌／獨立／API，各附複製鈕，`navigator.clipboard.writeText` 失敗時 fallback 為 `Range`+`Selection` 選取文字讓使用者手動複製；API 那條標「由外掛程式使用、不可更改」）；③即時驗證——`slugValidationForIndex()` 對照 D24 格式 `^[a-z0-9][a-z0-9-]{0,39}$`、同頁重複 slug 標紅擋存檔（`updateSaveButtonState()` disable「儲存」鈕）、slug 撞到別的外掛 `name` 只顯示黃色警告仍可存檔。改代稱時的即時網址更新刻意**不**呼叫整段 `renderPlugins()` 重繪，而是新增 `refreshPluginRows()` 只補丁受影響的文字節點（url/error/warning）——若每次按鍵都整列重繪，`<input>` 節點會被換掉導致游標/焦點跳掉，這是規格「即時」要求下的必要實作細節，補記於此。`onSave()` 新增 `slug` 物件（空字串／純空白省略），與既有 `order`／`hidden`／`openMode` 寫入邏輯並列、互不影響。**自測範圍與 WSXU2-6 原設想的「隔離埠 3399＋Playwright」不同，如實記錄**：本次改用「方式一」——把上述四個純函式（`pluginKey`／`pluginUrls`／`slugValidationForIndex`／`pluginsHaveError`）與 sidebar.js 的點擊路由解析邏輯原樣鏡射進獨立 node 腳本直接跑，不牽動任何 DOM／server，共 24 項斷言全數通過（含 §24 第 1、2、4、5、6 項，以及 `pl.routes` 缺席/部分缺席的安全回退）；判斷純函式邏輯已無 I/O、鏡射跑腳本比另起隔離埠+瀏覽器更直接可靠。**未做、如實標註**：未用瀏覽器（Playwright 或其他）對 `settings.js` 實際渲染畫面做視覺驗證——排版是否真的不破版、複製鈕按下後系統剪貼簿是否真的收到內容、輸入框連續打字時焦點是否真的不丟，這三項只靠程式邏輯與 DOM 更新方式的審視保證，未實機開瀏覽器看過畫面，留待指揮官手動驗證時一併確認。`Deploy_Harness.ps1` 依系統佈署政策本次未執行，需指揮官另行觸發上線。

---

# 增補 WSXW — 外掛開啟方式改成「兩個維度」，支援外部網址

> 需求（Charles 2026-09-22）：客戶專案的「線上操作手冊」「範例站台」本身是**獨立跑在別的埠**的網站（手冊 5090、範例 5080）。
> WSXT 做的三種開啟方式全部都指向 Hana 自己的網址，沒有一種能跳到 `http://localhost:5090`。
> 指揮官指示：只要**兩個輸入**——①「新分頁／內嵌」②「內部路由／外部網址」，交叉共 4 種即可滿足，外部網址**手填**。

## 25. 開啟方式的新模型（兩個維度）

| | 內部路由（`internal`） | 外部網址（`external`） |
|---|---|---|
| **內嵌（`embed`）** | 今天的行為：`router.navigate('/app/x/<key>')` | 在 Hana 畫面內用整頁 `<iframe>` 嵌入 `externalUrl` |
| **新分頁（`tab`）** | `window.open('/x/<key>?workspace=…')`（WSXT2 的獨立外殼） | `window.open(externalUrl)`（不附 `?workspace=`） |

## 26. 決策（WSXW）

| # | 決策 | 選定 | 理由 |
|---|---|---|---|
| D26 | 輸入維度 | 兩個下拉：`openIn`（`embed`｜`tab`）與 `target`（`internal`｜`external`），交叉 4 種 | 指揮官明示「兩個輸入、4 個選項就夠」 |
| D27 | 外部網址怎麼來 | **指揮官手填**，平台**不**去讀客戶專案自己的站台清單檔 | 那份清單是單一專案的格式，平台認識它就綁死其他工作區；手填一次、換機器換埠號自己改得動 |
| D28 | 舊的三選一怎麼收 | `openMode` 轉為**只讀的舊欄位**：`embed→(embed,internal)`、`tab→(tab,internal)`、`standalone→(tab,internal)`。設定頁存檔後只寫新欄位、不再寫 `openMode` | 4 選項不含「新分頁（完整 Hana 外殼）」。**行為變動要如實告知**：原本設成「新分頁（完整 Hana）」的外掛，改版後新分頁會開獨立外殼 `/x/<key>`，不是 `/app/x/<key>` |
| D29 | 「範例站台」不設外部網址 | 維持內嵌 | 它側欄的畫面是**管理面板**（列出所有範例站台、狀態、重啟）；直接跳 5080 就再也點不到面板（指揮官已同意） |
| D30 | 外部網址格式 | 只接受 `http://` 或 `https://` 開頭，長度 ≤ 500；`javascript:`／`data:`／相對路徑一律拒絕 | 這個值會被塞進 `window.open()` 與 `iframe src`，不擋等於開一個 XSS 入口 |
| D31 | 選了外部卻沒填網址 | 前端擋存檔、後端 `PUT` 回 400 | 不讓指揮官存出一個「點了沒反應」的側欄項目 |
| D32 | 站台活著沒有 | **本次不做**探測 | 要平台去 ping 埠號是另一筆工；現況是站台沒開就開出瀏覽器的「無法連線」，已如實告知指揮官 |

## 27. 資料模型（`harness.json`，取代 WSXT §13 的 `openMode`）

```jsonc
{
  "plugins": {
    "order": ["tracksim", "manual"],
    "hidden": [],
    "slug": { "manual": "handbook" },
    "openIn": { "manual": "tab" },                                  // embed | tab，未列＝embed
    "target": { "manual": "external" },                             // internal | external，未列＝internal
    "externalUrl": { "manual": "http://localhost:5090" },           // target=external 時必填
    "openMode": { "manual": "standalone" }                          // 舊欄位，只讀；新欄位存在時以新欄位為準
  }
}
```

## 28. 後端（`portal/server.js`）

- `normalizePluginsManifest()` 增補 `openIn`／`target`／`externalUrl` 三個 map：型別不符**逐鍵丟棄**（沿用 `openMode`／`slug` 的作風，壞檔不得讓側欄掛掉）。`externalUrl` 值須通過 D30。
- `buildDefaultManifest()` 補上三個空物件。
- `PUT /api/manifest` 的 `plugins` 驗證增補：三者非物件 → 400；`openIn` 值不在 `embed|tab` → 400；`target` 值不在 `internal|external` → 400；`externalUrl` 不符 D30 → 400；**某外掛 `target=external` 但 `externalUrl` 缺／空 → 400**（D31）。
- `applyPluginManifestOrder()` 每筆 plugin 輸出增補（供 `/api/status`，前端不得自行推導）：
  - `openIn`（預設 `embed`）、`target`（預設 `internal`）、`externalUrl`（無則 `null`）
  - **舊欄位遷移**：該外掛沒有 `openIn`／`target` 設定時，才用 `openMode` 依 D28 推導。
  - `openMode` 欄位**繼續輸出**（值由新模型回推：`embed+internal→embed`、`tab+internal→standalone`、外部→`tab`），讓尚未部署的舊前端不至於炸掉。
  - `routes` 增補 `embedExternal: '/app/xurl/<key>'`（內嵌外部網址用的前端路由）。

## 29. 前端

- `portal/shell/sidebar.js`：點擊導流改依 §25 的 2×2 表。`target=external` 時側欄一律顯示 `external-link` 圖示（含內嵌模式，表示它連的是外面的站台）。`externalUrl` 缺失時**不要開空白分頁**，改為 `showToast` 提示「尚未設定外部網址」。
- `portal/router.js`：新增路由 `/app/xurl/<key>` — 不 `import` 任何 view 模組，直接在 `#view-root` 塞滿版 `<iframe>`；網址由 `/api/status` 查該 key（name 優先、再 slug，沿用 D24）取得 `externalUrl`。`unmount` 要清掉 iframe。找不到或非 http(s) → 畫面顯示可讀錯誤，不得白屏。
- `portal/views/settings.js`：把原本單一的「開啟方式」下拉換成**兩個下拉**（開啟方式：內嵌／新分頁；連到哪裡：內部路由／外部網址），選「外部網址」時該列才展開一個「外部網址」輸入框（placeholder `http://localhost:5090`）。即時驗證（格式錯／選外部沒填）→ 標紅＋停用存檔鈕，沿用 WSXU2 的 `refreshPluginRows()` 補丁式更新（避免打字失焦）。存檔寫 `openIn`／`target`／`externalUrl`，預設值（`embed`／`internal`／空字串）的鍵省略不寫；**不再寫 `openMode`**。
- WSXU 的三條唯讀網址（內嵌／獨立／API）與複製鈕全部保留；`target=external` 時**額外**列出第四條「外部」。

## 30. 已知限制

- 有些網站會在 HTTP 標頭禁止被別人嵌入（`X-Frame-Options`／CSP），這種站台選「內嵌＋外部網址」會是一片空白。本機自架站台（手冊 5090、範例 5080）預設不會擋。設定頁在選「內嵌＋外部」時顯示一行灰字提醒。
- 平台不知道外部站台有沒有在跑（D32），站台沒開就會開出「無法連線」。

## 31. 不在範圍（WSXW）

- 埠號探測／健康狀態顯示（D32）。
- 自動從客戶專案的站台清單讀網址（D27）。
- 「新分頁（完整 Hana 外殼 `/app/x/<key>`）」這個選項（D28 已收掉）。

## 32. 驗收（WSXW）

1. 設定頁每個外掛看得到**兩個下拉**，且原本設 `standalone` 的外掛載入後顯示為「新分頁＋內部路由」。
2. 「線上操作手冊」設成 新分頁＋外部 `http://localhost:5090` → 存檔 → 側欄點下去開新分頁到 5090（不是 Hana 的網址）。
3. 同一外掛改成 內嵌＋外部 → 側欄點下去在 Hana 畫面內看到 5090 的內容（iframe）。
4. 選外部但網址留空 → 前端標紅、存檔鈕停用；強行 `PUT` → 400 且檔案未被改動。
5. 網址填 `javascript:alert(1)` 或 `localhost:5090`（沒有 scheme）→ 前端擋下、`PUT` 400。
6. 舊 `harness.json`（只有 `openMode`）→ 側欄行為依 D28 對應，不報錯。
7. 內部路由的兩種（內嵌／新分頁）行為與 WSXT／WSXU 完全一致，slug 代稱仍生效。
8. `/app/xurl/<不存在的 key>` → 畫面顯示可讀錯誤，不白屏、不丟未處理例外。

## Changelog（WSXW）

- 2026-09-22 建立增補 WSXW，決策 D26–D32 由 Charles 拍板（兩個維度共 4 選項、範例站台維持面板、網址手填）。兩筆手動排程串接（WSXW1→WSXW2），`postRun.deploy=false`。
- 2026-09-22 WSXW2 完成（實作與規格一致，無出入）：`portal/views/settings.js` 把「工作區外掛」每列的單一「開啟方式」下拉換成兩個（`data-act="open-in"`：內嵌／新分頁；`data-act="target"`：內部路由／外部網址），`target=external` 才展開一個外部網址輸入框（`placeholder="http://localhost:5090"`）；新增 `isValidExternalUrl()`（前端鏡射 server.js 同名函式的 D30 規則）與 `targetValidationForIndex()`，`pluginsHaveError()` 併入 target 驗證一起擋存檔；`refreshPluginRows()`（沿用 WSXU2 的補丁式更新手法，不整列重繪避免打字失焦）新增對外部網址輸入框、第四條「外部」唯讀網址列、「內嵌＋外部」提醒文字（`data-act="embed-external-hint"`，只在 `target=external && openIn!=='tab'` 顯示）、`target-error` 錯誤文字的即時更新；`pluginUrls()` 增補 `embedExternal` 鍵；`onSave()` 改寫 `patch.plugins.openIn`／`target`／`externalUrl`（預設值省略），**不再寫 `openMode`**（D28，交由 server 端 `applyPluginManifestOrder()` 從新欄位回推相容值）。`portal/shell/sidebar.js` 外掛點擊處理改為 §25 的 2×2 表：讀 `pl.openIn`／`pl.target`（非 `pl.openMode`）決定四種行為之一，`target=external` 時一律顯示 external-link 圖示（含內嵌模式，不只 `openIn!=='embed'`），`externalUrl` 缺失時呼叫 `showToast` 而非開空白分頁；`routes.embed`／`routes.standalone`／`routes.embedExternal` 缺席時各自安全回退成字串拼接（沿用 WSXU2 既有的防呆手法）。`portal/router.js` 新增 `/app/xurl/<key>` 路由（`parsePath` 命中 `view==='xurl'` 時直接分流，不進入既有的 plugin `import()` 分支）：`renderXurl()` 打 `/api/status` 用 name-優先-slug-其次解析 `key`，找到合法 `externalUrl`（`http(s)://` 開頭）才塞入滿版 `<iframe>`（`position:absolute;inset:0`），否則顯示置中可讀錯誤文字；`currentUnmount` 設為清空 `#view-root` 的閉包，與既有 view-module 路由共用同一個 `currentView`/`currentModule` 狀態機（`currentModule=null`，故此路由下 `getChatContext()` 回 null，退回檔案模式，屬預期行為、未在規格另外要求）。**自測**：把 `isValidExternalUrl`／`targetValidationForIndex`／`pluginsHaveError`／`onSave` 的 patch 組值邏輯，以及 sidebar.js 的 2×2 點擊路由解析（`resolveClickAction`）、router.js 的 `parsePath`，原樣鏡射進獨立 node 腳本直接跑，24 項斷言全數通過（涵蓋 §32 第 1、2、3、4、5、7 項：兩下拉存在、格式錯/缺網址擋存檔、`openIn`/`target`/`externalUrl` 省略預設值且不寫 `openMode`、四種點擊行為的路由與是否附 `?workspace=`、`routes` 缺席時的回退、`/app/xurl/<key>` 的 `parsePath` 解析）；測完已刪暫存腳本，全程未起任何 server 或佔用任何埠口。**未做、如實標註**：本次完全未做瀏覽器（Playwright 或其他）視覺驗證——設定頁兩個下拉與外部網址輸入框的實際排版、選「內嵌＋外部」時 iframe 是否真的顯示外部站台內容（含 §30 講的 X-Frame-Options 空白情境）、複製鈕是否真的把網址寫進系統剪貼簿、連續切換下拉時輸入框是否真的不丟焦點——這些只靠程式邏輯與既有 `refreshPluginRows()` 補丁式更新手法的審視保證，留待指揮官依 §32 驗收清單手動驗證。`Deploy_Harness.ps1` 依系統佈署政策本次未執行，需指揮官另行觸發上線；WSXW1→WSXW2 兩筆排程至此全部完工待驗收。
- 2026-09-22 WSXW1 完成（實作與規格一致，無出入）：`portal/server.js` 依 §28 補上 `normalizePluginsManifest()`／`buildDefaultManifest()` 的 `openIn`／`target`／`externalUrl` 三個 map（`isValidExternalUrl()` 實作 D30：僅收 `http(s)://` 開頭、≤500 字，`javascript:`/`data:`/無 scheme 一律丟棄）；`PUT /api/manifest` 依三者格式驗證後回 400，並新增交叉檢查 D31（`target=external` 缺/空 `externalUrl` → 400，訊息指名是哪個外掛）；`applyPluginManifestOrder()` 依 D28 實作遷移——用 `hasNewFields`（該外掛的 `openIn`／`target` 是否存在合法值）判斷走新欄位還是回推自舊 `openMode`（`embed→(embed,internal)`、`tab`/`standalone→(tab,internal)`，未設定的舊值視同 `embed`），並反向組出 `openMode` 輸出值（`target=external` 一律 `tab`；否則 `openIn=embed→embed`、`openIn=tab→standalone`）供舊前端相容；`routes` 增補 `embedExternal:'/app/xurl/<key>'`（`<key>` 沿用既有 slug 優先、否則 name 的邏輯）。自測：四段純函式（`normalizePluginsManifest`／PUT 驗證／`applyPluginManifestOrder` 遷移＋回推／routes 組法）原樣鏡射進獨立 node 腳本直接跑，26 項斷言全數通過（涵蓋 §32 第 4、5、6 項，另加「新舊欄位並存時新欄位優先」「embed+external 這個新組合的 openMode 回推仍是 tab」等邊界案例）；測完已刪暫存腳本，全程未起任何 server／未佔用任何埠口。**未測到、如實標註**：WSXW2 範圍的前端（`settings.js` 兩下拉、`sidebar.js` 2×2 導流、`router.js` 的 `/app/xurl/<key>`）與任何瀏覽器視覺驗證本次完全未動、未測。`Deploy_Harness.ps1` 依系統佈署政策本次未執行，需指揮官另行觸發上線。

---

## 33. `sidebarCards` 節點（SPEC-sidebar-card-carousel.md §7/SBC-5 增補）

`harness.json` 新增選用節點，控制側欄卡片輪播（`portal/shell/card-carousel.js`）的四項設定：

```jsonc
"sidebarCards": {
  "rotateSeconds": 8,              // 每頁停留秒數；0 = 不自動輪播（只手動切）
  "quotaRefreshSeconds": 300,      // 模型用量卡的查詢 TTL；0 = 只在按「重新整理」時查；下限 30（見 SPEC-model-quota.md §3.1）
  "hidden": ["quota:gemini"],      // opt-out：卡片 id 列進來就隱藏，沒列到＝顯示
  "order": ["worktable", "quota:claude"]  // 列到的卡片照此順序排前面，其餘接在後面（內建先、外掛後，各自維持原序）
}
```

- **整個節點省略 → 全用預設值**（輪播 8 秒、用量 300 秒、全部顯示、依發現順序排列），**舊 `harness.json` 不改也行為不變**——這是硬性要求，`getManifest()` 的 `buildDefaultManifest()` 與讀取既有檔案兩條路徑都已覆蓋。
- `getManifest()` 一律把 `sidebarCards` 併入回應（缺的欄位補預設值），前端／設定頁不需要自己再補一層防呆。
- `PUT /api/manifest` 驗證（壞一項就整包 400、不寫檔，同其他欄位的「全有全無」政策）：
  - `rotateSeconds` 必須是整數 `0` 或 `3`–`120`。
  - `quotaRefreshSeconds` 必須是整數 `0` 或 `30`–`3600`。
  - `hidden`／`order` 必須是字串陣列（內容是卡片 id，**不**對照當下實際存在的卡片清單驗證——同 `plugins.order`/`hidden` 的既有慣例，一張卡可能暫時不存在但設定仍保留）。
- 設定頁（`portal/views/settings.js`「側欄卡片」區塊）：卡片清單（勾選顯示／上下箭頭排序，清單來源是當下已知的卡片——`worktable` + `/api/model-quota` 回的每家 + 每個已信任外掛的 `cards[]`）、兩個秒數輸入框、未信任外掛卡片另外列一塊唯讀紅字（卡片名＋原因）。存檔後（當前工作區）觸發 `reloadShell()` → `rebuildCardCarousel()`：先卸載所有現有卡片（呼叫各自 `unmount()`）再依新設定重建（§8 的硬性要求）。

## Changelog（SBC）

- 2026-10-08 SBC-5 完成（實作與規格一致，無出入）：`portal/server.js` 的 `buildDefaultManifest()` 補上 `sidebarCards` 預設值、新增 `normalizeSidebarCardsManifest()`／`isValidRotateSeconds()`／`isValidQuotaRefreshSeconds()`，`getManifest()` 併入該節點；`PUT /api/manifest` 新增 `sidebarCards` 驗證區塊（壞值 400、不寫檔）。`portal/views/settings.js` 新增「側欄卡片」區塊（`state.sidebarCards`／`state.cardsList`／`rebuildCardsList()`／`renderCardsList()`／`renderUntrustedCardsList()`／`sidebarCardsValidationError()`），`onSave()` 併入 `sidebarCards` payload。自測：`normalizeSidebarCardsManifest`／`isValidRotateSeconds`／`isValidQuotaRefreshSeconds` 原樣鏡射進 `.worktable/artifacts/sbc/mirror_test.js` 直接跑，涵蓋「省略節點＝全預設」「合法值原樣保留」「超界值逐欄位丟棄回預設」「PUT 驗證邊界（0、3、120、29/30、3600/3601、非整數）」，全數通過；測完全程未起任何 server、未佔用任何埠口。**未驗證**：設定頁「側欄卡片」區塊的實際排版、勾選/拖曳排序的互動手感——只靠程式邏輯與既有 `renderPlugins()`/`renderSections()` 同款手法的審視保證，未做瀏覽器視覺驗證（屬 SPEC-sidebar-card-carousel.md 全規格共通的「未部署、未能實機驗證」限制，見該規格 Changelog v0.2）。

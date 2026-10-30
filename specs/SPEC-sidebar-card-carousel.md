# SPEC — 側欄卡片輪播（Sidebar Card Carousel）

> 規格版本 v0.1（2026-10-08 起草）｜Owner: Charles + Hana
> 關聯：`specs/SPEC-sidebar-worktable-card.md`（本規格把那張卡變成「輪播裡的第一張」，不改它的內容與行為）、`specs/SPEC-model-quota.md`（用量卡的唯一資料來源，§3 統一契約不動）、`specs/SPEC-plugin-contract.md`（外掛卡片沿用同一份信任與模組合約，本規格只新增 `cards` 欄位）、`specs/SPEC-workspace-settings.md`（四項設定的落點）、`specs/SPEC-portal-architecture.md`
> 任務：`.worktable/TASK.md §SBC`

---

## 1. 動機

左上角那塊目前**只有一張寫死的卡**（工作台進度，`portal/index.html:1070` 的 `#wt-card`）。指揮官要的是：

1. **隨時看得到模型用量**（5 小時／7 天），不必開對話才看得到；
2. **每個專案能把自己關心的資訊掛進這一區**（例如客戶專案要看專案進度），而且不改平台程式；
3. 這一區會有**多種**資訊 → 要能自動輪播、也能手動切頁。

### 1.1 架構可行性結論（回答指揮官的提問）

**目前沒有任何「卡片」元件或框架可以套用**——`#wt-card` 是一段寫死在 `index.html` 的 HTML，不是可重複實例化的元件。因此本規格必須：

- 在 `portal/index.html` 的側欄頂端包一層**輪播殼**，`#wt-card` 原樣搬進去當第一張；
- 新增一個**卡片模組合約**（刻意與既有 view 合約 `mount/unmount/ctx.apiFetch` 同形，不另創一套）；
- 連帶增補四份既有 spec（見 §9）。

這就是指揮官說的「若沒有既有框架，整個 portal 頁面要調整、相關 spec 要跟著改」——確認屬於後者，已納入本規格與任務範圍。

---

## 2. 設計決策（已與指揮官拍板，實作紅線）

| # | 決策 | 選定 | 理由 |
|---|---|---|---|
| D1 | 卡片模組合約要不要另創一套 | **沿用既有 view 合約的子集**（`mount(container, ctx)` / `unmount()` / `ctx.apiFetch`） | 不重造輪子；外掛作者學一次就會兩種 |
| D2 | 用量卡的粒度 | **一家模型一張卡**（指揮官指示）；卡片清單由 `GET /api/model-quota` 的 `providers` **動態生成**，後端多接一家就多一張，前端不改 | 延續 SPEC-model-quota D1 的 adapter 立場 |
| D3 | 用量查詢頻率 | **後端共用快取 + TTL 可設定**（預設 300 秒）；所有瀏覽器/分頁共用同一份快照，輪播切頁**不觸發查詢** | 卡片會一直輪播，若切頁就查會變成持續對外連線 |
| D4 | 哪些卡要顯示 | **每張卡可個別關掉**（含用量卡逐家關），採 opt-out（沒設＝顯示） | 指揮官要「我可以只看 Claude Code」；與既有 `nav` 開關同慣例，舊工作區行為不變 |
| D5 | 輪播秒數 | **可設定**，`0` ＝ 不自動輪播（只手動切） | 指揮官要求「每頁停留時間可設定」 |
| D6 | 外掛卡片怎麼進來 | **`plugin.json` 新增 `cards[]`**，沿用 §5 信任閘；不新開載入管道 | 「不改平台程式」的既有承諾延伸到卡片 |
| D7 | 未信任的外掛卡 | **輪播中直接不出現**（不像側欄項目那樣顯示停用灰項），但**工作區設定頁要列出並寫明「因未信任未載入」** | 輪播裡塞一張停用卡只會浪費一頁；但不能靜默消失 |
| D8 | 單張卡壞掉 | **只有該張顯示「這張卡載入失敗」＋原因**，其餘卡與輪播照常 | 沿用 SPEC-model-quota D6「一家壞不影響其他家」 |
| D9 | 絕不編造用量數字 | `health !== 'ok'` 一律照 SPEC-model-quota §3 的四態顯示（灰／紅＋一句人話），不得用估算填格子 | 誠實原則，沿用 D3/D2 |
| D10 | 側欄收合狀態 | 收合（`sb-collapse`）時整區隱藏、**自動輪播暫停**（不在看不見的地方跑計時器與查詢） | 省資源 |

---

## 3. 卡片識別與註冊

### 3.1 卡片 ID（穩定 key，設定檔靠它記住顯示/順序）

| ID | 來源 | 說明 |
|---|---|---|
| `worktable` | 平台內建 | 現有工作台卡（進度條＋看板/任務/歷程按鈕＋可展開樹），**內容與行為完全不動** |
| `quota:<providerId>` | 平台內建（動態） | 一家模型一張，`providerId` 取 `/api/model-quota` 的 `providers[].id`（今天是 `claude`／`codex`／`gemini`） |
| `plugin:<pluginName>:<cardId>` | 工作區外掛 | 見 §5 |

### 3.2 排序規則

`sidebarCards.order` 明列者照該順序；未列到的接在後面（內建先、外掛後，各自維持原序）。

---

## 4. 卡片模組合約（D1）

```js
// cards/progress.js
export const card = {
  id: 'progress',            // 外掛內唯一；平台對外呈現為 plugin:<name>:progress
  title: '專案進度',
  icon: 'trending-up',       // lucide 名
};
export function mount(container, ctx) { /* 掛 DOM、拉資料；ctx.apiFetch 自動帶 X-Workspace */ }
export function unmount() { /* 拆事件與計時器 */ }
```

- `ctx` 與既有 view 合約同形：至少提供 `workspace`、`apiFetch(path, init)`。
- 版面約束（側欄只有約 `14rem` 寬）：卡片**最多 3 行內容**、不得自行設定固定高度、不得注入全域 CSS、不得開 overlay/modal。平台會把超出高度的內容裁切（`overflow:hidden`）。
- **輪播外框高度固定＝所有卡片中最高的那張**（2026-10-27 指揮官拍板）：所有 slide 疊在同一格（CSS grid 同一 cell），非作用中的只 `visibility:hidden`、不 `display:none`，因此切換卡片時外框高度不變、下方側欄 menu 不會跳動（曾因此點錯 menu）。較矮的卡片會被撐到同高。
- `mount` 丟錯或逾時（3 秒）→ D8 的失敗卡。

---

## 5. 外掛貢獻卡片（D6/D7）

`plugin.json` 新增選用欄位（`SPEC-plugin-contract.md §2` 增補）：

```jsonc
{
  "name": "project-status",
  "title": "專案狀態",
  "trust": "code",
  "cards": [
    { "id": "progress", "title": "專案進度", "icon": "trending-up", "module": "cards/progress.js" }
  ]
}
```

- `module` 相對 plugin 目錄，遵守 §4 合約。
- 信任模型完全沿用 `SPEC-plugin-contract.md §5`：`trust:"code"` 的外掛卡只在 registry 標 `trusted:true` 的工作區載入；未信任則不載（D7）。
- `/api/status` 的 plugin 節點回傳 `cards` 陣列（含是否因未信任而未載入、原因字串），供輪播與設定頁共用。

---

## 6. 用量卡（D2/D3/D9）

### 6.1 後端：共用快取

`GET /api/model-quota` 增補（**不動 `model-quota.js` 的任何 adapter**）：

- process 內單一快照 `{ data, fetchedAt }`，所有工作區／瀏覽器共用。
- `?maxAgeSec=N`：快照比 N 秒新就直接回，否則重查。伺服器**強制下限 30 秒**（防設定值被填成 1 而打爆）。
- `?force=1`：忽略快照重查（手動刷新鈕用）。
- 回應增加 `cached: true|false`、`fetchedAt`，前端據此顯示「N 分鐘前更新」。
- 併發保護：同時多個請求要重查時只實際跑一次（共用同一個 in-flight promise）。

### 6.2 前端：卡片版面（每家一張）

```
┌─────────────────────────────┐
│ Claude Code          ● 綠燈 │
│ 5 小時  ▓▓▓▓▓░░░░░  42%     │
│ 7 天    ▓▓░░░░░░░░  18%     │
│ 3 分鐘前更新            ⟳  │
└─────────────────────────────┘
```

- `health: ok` → 每個 `windows[]` 一條細進度條；`usedRatio` ≥ 0.8 轉橘、≥ 0.95 轉紅。
- `health: unsupported` / `missing` → 灰字一句人話（例：Gemini 官方不提供剩餘配額），**不畫進度條**。
- `health: broken` → 紅字 `message` 原文。
- `⟳` 手動刷新鈕 → `?force=1`，刷新所有用量卡（一次查、多張卡共用結果）。

---

## 7. 設定（D4/D5，落在工作區設定頁）

`harness.json` 新增節點（`SPEC-workspace-settings.md` 增補）：

```jsonc
"sidebarCards": {
  "rotateSeconds": 8,              // 每頁停留秒數；0 = 不自動輪播
  "quotaRefreshSeconds": 300,      // 用量查詢 TTL；下限 30，0 = 只在按 ⟳ 時查
  "hidden": ["quota:gemini"],      // opt-out：沒列到就是顯示
  "order": ["worktable", "quota:claude"]
}
```

- 整個節點省略 → 全用預設值（輪播 8 秒、用量 300 秒、全部顯示）；**舊工作區不改也行為不變**。
- 設定頁新增「側欄卡片」區塊：卡片清單（勾選顯示／上下箭頭排序／未信任的標紅字原因）＋兩個秒數輸入框。
- 驗證：`rotateSeconds` 整數 0 或 3~120；`quotaRefreshSeconds` 整數 0 或 30~3600。失敗回 400、不寫檔。
- 設定存在 `harness.json` → **工作區各自獨立**。

---

## 8. 互動規格

- 下排圓點：點擊直接跳該頁；當前頁高亮；**只有 1 張可見卡時圓點與箭頭都不顯示**。
- 滑鼠移入卡片區：左右兩側浮出半透明箭頭；移出即消失（觸控裝置改為常駐小箭頭）。
- 滑鼠移入或鍵盤 focus 在卡片區 → **自動輪播暫停**，移出恢復。
- 手動切頁後**重置計時**（不會剛切完馬上被輪走）。
- 切換工作區／`applyManifest()` 重新套用設定時：卸載所有卡（呼叫各自 `unmount`）再依新設定重建。
- 尊重 `prefers-reduced-motion`：不做滑動動畫、直接換頁。

---

## 9. 連帶要改的既有 spec（§1.1 的結論）

| spec | 增補內容 |
|---|---|
| `SPEC-sidebar-worktable-card.md` | 註明該卡自此是輪播第一張（`id: worktable`），內容與 `nav.worktable` 開關語意不變 |
| `SPEC-plugin-contract.md` | §2 新增 `cards[]`；§3 旁註卡片模組合約是 view 合約子集；§5 信任閘涵蓋卡片 |
| `SPEC-workspace-settings.md` | 新增 `sidebarCards` 節點與設定頁區塊、驗證規則 |
| `SPEC-model-quota.md` | §3 增補快取參數（`maxAgeSec`/`force`/`cached`）與「側欄一家一張卡」的消費端 |
| `SPEC-portal-architecture.md` | 側欄結構圖加上輪播殼與卡片註冊表 |

---

## 10. 新技能 `/card`（指揮官特別要求）

`global-knowledge/commands/card.md`——讓 Hana 在**任何工作區**都記得自己有「幫這個專案做一張側欄卡」的能力。技能步驟：

1. 問清楚這張卡要看什麼、資料從哪來（既有 API／工作區檔案／外掛後端）；
2. 若該工作區還沒有外掛 → 建 `plugin.json`；已有 → 只加 `cards[]` 一筆；
3. 寫 `cards/<id>.js`（遵守 §4 的三行限制）；
4. 重新解析工作區、確認卡片出現在輪播中，並在工作區設定頁確認可開關；
5. 若該工作區未被標 `trusted` → 明白告訴指揮官卡片不會載入、要他決定是否信任。

---

## 11. 不在範圍

- 卡片**內容**的拖曳縮放、自訂版面編輯器（這不是儀表板產品）。
- 把用量統計頁（`SPEC-usage-analytics.md`）的圖塞進側欄——側欄太窄，用量卡只給「還剩多少」。
- 多家模型的歷史趨勢（屬 `SPEC-usage-analytics.md`）。
- 新增第四家模型的 adapter（今天 `/api/model-quota` 只有三家；要加第四家是 `SPEC-model-quota.md` 的工作，本規格的卡片數會自動跟著長）。

---

## 12. 驗收

- 側欄頂端出現輪播：預設 `worktable` + 三張用量卡；圓點可點、hover 出現左右箭頭、hover 時不自動輪播。
- 用量卡顯示 Claude Code 的 5 小時／7 天百分比；Gemini 顯示灰字「官方不提供」而非 0%。
- 連續在輪播中停留 2 分鐘，後端對外查詢次數 ≤ 1（TTL 300 秒生效）。
- 設定頁把 `quota:codex`、`quota:gemini` 關掉後重新整理 → 只剩兩張卡、圓點變兩顆。
- `rotateSeconds: 0` → 不再自動換頁，手動仍可切。
- 一個示範工作區用 `plugin.json` 的 `cards[]` 掛一張卡，**不改平台程式**即出現在輪播。
- 故意讓示範卡 `mount` 丟錯 → 只有該張顯示失敗訊息，其餘卡正常。

---

## Changelog

- v0.1（2026-10-08）起草。指揮官拍板：①更新頻率／輪播秒數／每張卡顯示與否都要可設定；②一家模型一張卡；③建手動排程、由指揮官自行執行；④卡片能力要有技能（`/card`）。
- v0.2（2026-10-08）SBC-1~SBC-8 實作完成（細節見下）。**全程未執行 `Deploy_Harness.ps1`、未重啟/動正式 portal（:3400）**——程式已寫進原始碼，要指揮官自行挑時間上線才會生效；本次自測也嚴格遵守「不起第二顆完整 server」的護欄。

  **完成的部分：**
  - SBC-1：新增 `portal/shell/card-carousel.js`（卡片註冊表＋mount/unmount 生命週期＋圓點＋hover 箭頭＋自動輪播含 hover/focus 暫停＋手動切頁重置計時＋單卡可見時隱藏圓點箭頭＋`prefers-reduced-motion`＋`sb-collapse` 收合停計時器）。`portal/index.html` 把 `#wt-card` 包進輪播殼第一張卡，卡內所有既有 id（`#sprint-badge`/`#progress-bar`/`#menu-dashboard`/`#worktable-tree`/`#wt-card-expand-btn` 等）與綁定完全未動，只是巢狀深度多了兩層 wrapper。單卡 mount 逾時 3 秒／丟錯 → 只該卡顯示失敗訊息（`card-carousel.js` 的 `mountOne()`）。
  - SBC-2：`portal/server.js` 的 `GET /api/model-quota` 加上 process 內單一快照（`quotaSnapshot`/`quotaInFlight`）、`?maxAgeSec=N`（伺服器強制下限 30 秒）、`?force=1`、回應增加 `cached`/`fetchedAt`、併發保護（共用 in-flight promise）。`model-quota.js` 一行未動。
  - SBC-3：quota 卡前端渲染邏輯寫在 `portal/index.html` 的 `renderQuotaCardInto()`/`rebuildCardCarousel()`——依 `providers[]` 動態生成、健康燈、每個 window 一條細進度條（≥80% 橘、≥95% 紅）、「N 分鐘前更新」、手動刷新鈕（`?force=1`，所有 quota 卡共用一次查詢結果）。非 `ok` 時依四態顯示人話，不畫進度條。
  - SBC-4：`portal/server.js` 新增 `normalizePluginCards()`、`getPlugins()` 併入驗證後的 `cards[]`（含 `enabled`/`disabledReason`，繼承所屬外掛的信任狀態）、新路由 `/views/xcard/<pluginName>/<cardId>.js`（鏡射既有 `/views/x/` 的信任閘＋路徑安全檢查）。`/api/status` 的 plugin 節點自動帶出 `cards`（沒有另外改動，因為是整包 `Object.assign`）。前端 `rebuildCardCarousel()` 只為 `enabled:true` 的外掛卡呼叫 `import()` 動態載入模組並註冊進輪播；未信任的不註冊（不進輪播），但設定頁（SBC-5）仍能列出。
  - SBC-5：`harness.json` 新增 `sidebarCards`（`rotateSeconds`/`quotaRefreshSeconds`/`hidden[]`/`order[]`），`buildDefaultManifest()`/`getManifest()` 補預設值與合併；`PUT /api/manifest` 新增驗證區塊（壞值 400、不寫檔）。`portal/views/settings.js` 新增「側欄卡片」區塊（勾選顯示／上下箭頭排序／兩個秒數輸入／未信任卡片紅字原因列表），`onSave()` 併入 payload。`portal/index.html` 的 `reloadShell()` 呼叫 `rebuildCardCarousel()` → 內部 `sbCardCarousel.mountAll()` 一律先 `unmountAll()` 再重建，滿足「套用新設定前先卸載」的硬性要求。
  - SBC-6：新增 `global-knowledge/commands/card.md`，格式仿照既有 `/plugin`、`/note` 技能，含資料來源確認／`plugin.json` 的 `cards[]` 寫法／卡片三行版面天條／自我驗證步驟／trusted 確認（不自己動手標信任），本文明寫 `{{args}}`。
  - SBC-7：所有動到的 `.js`（`server.js`/`card-carousel.js`/`settings.js`/`sidebar.js`）`node --check` 全過；`node portal/checks/menu-no-emoji.js`／`view-has-menu.js` 皆過；鏡射測試 `.worktable/artifacts/sbc/mirror_test.js`（23 項斷言：quota 快取 TTL/下限 30 秒/force 繞過/併發只查一次、`sidebarCards` 預設與驗證邊界、卡片排序 hidden/order 解析、未信任外掛卡片不進輪播但保留設定頁資訊）全數通過；全程未啟動任何第二顆 server、未佔用任何埠。
  - SBC-8：五份既有 spec 增補（`SPEC-sidebar-worktable-card.md` §9、`SPEC-plugin-contract.md` §2/§3/§5、`SPEC-workspace-settings.md` §33＋Changelog（SBC）、`SPEC-model-quota.md` §3.1/§3.2、`SPEC-portal-architecture.md` §6）；本檔 Changelog（本條）；`.worktable/TASK.md` §SBC 勾選；`.worktable/DASHBOARD.md` 補一行成果記錄。

  **未驗證、如實標註（因不能部署/重啟正式服務，完全沒有能力做瀏覽器視覺驗證）：**
  - 輪播殼實際排版、圓點/箭頭的 hover 顯隱手感、`prefers-reduced-motion` 的實際效果、側欄收合時是否真的停計時器——只靠程式邏輯審視，未做瀏覽器驗證。
  - quota 卡／外掛卡在真實畫面上的排版是否真的符合「最多 3 行、不溢出」。
  - 設定頁「側欄卡片」區塊的排版、拖曳/勾選互動手感。
  - 外掛卡片端到端的真實載入（`import('/views/xcard/...')`）：沒有找到安全、不影響正式服務的方式起一個真正的 HTTP server 來驗證這條路由，只對照既有 `/views/x/` 路由的寫法做邏輯比對；曾考慮在 Harness 自身的 `.harness/plugins/demo/plugin.json` 加一筆 `cards[]` 來自我驗證，但發現 `HARNESS_HOME` 預設就是這個工作目錄本身（`portal/server.js:8231`），若正式服務真的以這個工作目錄當 home，編輯這裡的 `plugin.json` 可能不需要 Deploy 就被正式服務讀到——為了不冒這個風險，最終**沒有**實際掛上這張示範卡，只留下合約層面與鏡射測試的驗證。
  - 指揮官手動驗證那一條（§12 驗收清單）維持未勾，等待指揮官依驗收清單實機操作。

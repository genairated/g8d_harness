# SPEC — 外掛合約（工作區貢獻 UI + API）

> **一句話**：讓一個工作區用一份 `plugin.json` 宣告貢獻「**側欄項目 + 前端 view 模組 + 後端路由 handler**」，
> 平台於解析該工作區時動態載入——把已存在的三層 command 疊加（ship < global < project）擴到「UI＋API」同一套模型。
> 「專案才有的功能」從此用**外掛**帶進來，不再寫死進平台。

- 狀態：草案（依賴 `[[SPEC-portal-architecture]]` §2 的 D4 信任模型拍板）
- 建立：2026-08-01

---

## 1. 為什麼

現況 skill/command 已能專案自帶（`loadCommands` 三層合併），但**前端面板 UI** 與**後端 API 路由**只能寫死進 monolith。外掛合約補齊這兩層，形成完整的「一個工作區能自帶一套功能」。

---

## 2. `plugin.json`（放工作區根，或 `<ws>/.harness/plugins/<name>/plugin.json`）

```jsonc
{
  "name": "g8d-costing",              // 唯一名；決定路由前綴 /app/x/<name>、/api/x/<name>
  "title": "成本試算",                 // 側欄顯示
  "icon": "calculator",               // lucide 圖示名
  "menuGroup": "工具",                 // 側欄分組（沿用 manifest.sidebar.sections）
  "view": "views/costing.js",         // 前端 view 模組（相對 plugin 目錄）；遵守 §3 合約
  "styles": "views/costing.css",      // 選用
  "routes": "server/costing.js",      // 後端路由模組（相對 plugin 目錄）；遵守 §4 合約
  "trust": "code"                     // "prompt"=純提示型(免信任)；"code"=帶程式(受信任閘)
}
```

- 疊加/覆寫規則同 command：ship < global < project，同名 `name` 後者覆前者。
- 平台把外掛的 `route`/`title`/`icon`/`menuGroup` 併入既有 `#dynamic-sections` 渲染路徑。

---

## 3. 前端 view 模組合約（與平台內建 view 同一份合約）

```js
export const meta = { route: '/app/x/costing', title: '成本試算', icon: 'calculator', menuGroup: '工具' };
export function mount(container, ctx) { /* 掛 DOM、綁事件、拉資料；ctx 提供 workspace、apiFetch(帶 X-Workspace) */ }
export function unmount() { /* 拆事件/計時器/overlay */ }
```

- `ctx.apiFetch(path, init)`：平台注入的 fetch 包裝，自動帶 `X-Workspace` header（工作區隔離不可繞過）。
- view 模組**不得**自帶第二套播放引擎/全域樣式污染；CSS 以 `styles` 宣告、由平台 scope。

## 4. 後端路由模組合約

```js
// server/costing.js —— 回傳要註冊進平台 route table 的 handler 清單
export default function register(api) {
  api.get('/api/x/costing/summary', (req, res, ctx) => { /* ctx.workspace 已解析 */ });
  api.post('/api/x/costing/calc', async (req, res, ctx) => { /* … */ });
}
```

- 外掛路由**強制**命名空間 `/api/x/<plugin-name>/*`，避免撞平台 API。
- `ctx.workspace` 由平台以 `resolveWorkspace(req)` 解析後注入；外掛不自行讀全域 active，杜絕跨工作區外洩。

---

## 5. 信任模型（對應 D4，拍板後鎖定）

- `trust:"prompt"`（純提示型，如 skill）：任何工作區可載，無程式執行。
- `trust:"code"`（帶前端/後端程式）：**預設只有 registry 標記 `trusted:true` 的工作區可載**；未信任者側欄顯示但停用並標示原因。
- 平台啟動時記 log：載入了哪些外掛、來自哪個工作區、trust 級別。

---

## 6. 驗收準則

- 一個示範工作區放 `plugin.json`＋`views/x.js`＋`server/x.js`，重新解析工作區後：側欄出現該項、`/app/x/<name>` 可開、`/api/x/<name>/*` 可用——**全程不改平台程式**。
- 切到別的工作區時該外掛的側欄項/路由消失（工作區隔離）。
- 未信任工作區的 `trust:"code"` 外掛不被執行、且有明確提示。

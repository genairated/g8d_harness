# SPEC — 模型額度儀表（Model Quota Dashboard）

> 規格版本 v0.1（2026-08-30 起草）｜Owner: Charles + Hana
> 關聯：`specs/SPEC-resilient-cli.md`（Part B 被動限流狀態，本規格是它的「主動查詢」版）、`specs/SPEC-multi-model-panel.md`、`specs/SPEC-telegram.md`、`specs/SPEC-scheduler.md`
> 任務：`.worktable/TASK.md §MQ`

---

## 1. 動機與一句話定義

Hana 同時驅動三家 CLI（Claude Code、Codex、Antigravity/Gemini），但指揮官**看不到自己還剩多少額度**，常常撞牆才知道。
本規格定義一個**供應商中立的額度介面**：前端只認一種資料格式，後端每多接一家模型就多寫一個轉接器，**前端一行都不用改**。

**第二個同等重要的目的**：當某家 CLI 改版、後端解析不動了，畫面必須**明確報錯**（紅燈 + 一句人話），讓指揮官知道「該找 Hana 修了」，而不是靜靜顯示錯的數字或空白。

---

## 2. 設計決策（已與指揮官拍板，實作紅線）

| # | 決策 | 理由 |
|---|---|---|
| D1 | **前端只認一份統一格式**，後端用轉接器把各家資料翻過來 | 換模型／加模型不動前端。這是業界通用的 adapter pattern，非自創 |
| D2 | **「不支援」與「壞掉」必須是兩種不同狀態、不同顏色** | 混在一起會讓指揮官對紅燈麻痺；Gemini 永遠沒有剩餘量（灰、不用理），Codex 昨天有今天沒有＝真的壞了（紅、要修） |
| D3 | **絕不編造數字**。查不到就回 `unsupported` / `broken`，不得用估算值填格子 | 誠實原則；假數字比沒數字更危險 |
| D4 | **不主動輪詢消耗額度**：只讀本機檔案／CLI 既有輸出，不為了顯示而去打模型 | 沿用 `SPEC-resilient-cli` §B 的既有立場（查額度不該花額度） |
| D5 | **降級通知只在「由好轉壞」時推播一次**，不每次刷新都吵 | 避免通知疲勞；同時保證 CLI 半夜自動更新弄壞解析時，隔天早上就知道 |
| D6 | 一家掛掉**不得影響其他家**：每個轉接器獨立 try/catch，逾時各自算 | 不做成「一家壞、整排空白」 |

---

## 3. 統一資料契約（前端唯一認得的格式）

`GET /api/model-quota` → 

```jsonc
{
  "providers": [
    {
      "id": "claude",                 // 供應商代號（穩定 key）
      "label": "Claude Code",         // 顯示名稱
      "health": "ok",                 // ok | unsupported | broken | missing
      "message": null,                // health !== 'ok' 時必填：一句人話（正體中文）
      "usage": {                      // 可為 null（該家查不到用量）
        "unit": "requests|tokens|percent",
        "used": 123
      },
      "windows": [                    // 各個限額窗口；查不到就空陣列
        { "name": "5 小時", "usedRatio": 0.42, "resetAt": "2026-08-30T12:00:00.000Z" },
        { "name": "7 天",   "usedRatio": 0.18, "resetAt": "2026-09-02T00:00:00.000Z" }
      ],
      "source": "claude CLI /usage",  // 資料來源描述（除錯用，UI 可摺疊顯示）
      "fetchedAt": "2026-08-30T09:00:00.000Z"
    }
  ],
  "generatedAt": "2026-08-30T09:00:00.000Z"
}
```

**`health` 四態語意（D2 的落地，不可合併）**

| health | 顏色 | 意思 | 指揮官要不要動作 |
|---|---|---|---|
| `ok` | 綠 | 讀到了 | 不用 |
| `unsupported` | 灰 | 這家官方就是不提供剩餘配額（例：Gemini） | **不用，永遠灰的** |
| `missing` | 灰 | 這台機器沒裝這個 CLI | 想用再去裝 |
| `broken` | **紅** | 原本讀得到、現在解析不出來（多半是 CLI 改版） | **要，找 Hana 修** |
| `stale`（v0.2 新增，見 §9 D11） | **黃** | 本次查詢因網路／逾時暫時連不上，但 30 分鐘內有上次成功的結果，先顯示舊數字 | 不用，等它自己恢復；數字是真的只是舊的 |

**紅燈訊息必須具體**，例：「Codex 的用量輸出格式與預期不符（找不到百分比欄位），可能是 CLI 更新，需要修正轉接器。」

### 3.1 快取參數（SPEC-sidebar-card-carousel.md §6.1/SBC-2 增補）

`GET /api/model-quota` 在 `portal/server.js` 層（不動本規格 §4 的任何轉接器）加了一個 process 內單一快照，
所有工作區／分頁共用：

| 參數 | 說明 |
|---|---|
| `?maxAgeSec=N` | 快照比 N 秒新就直接回快照，否則重查上游。伺服器**強制下限 30 秒**（`maxAgeSec` 低於 30 一律視為 30，防止設定值被填成 1 而打爆） |
| `?force=1` | 忽略快照，強制重查（手動刷新鈕用） |
| 無參數 | 等同 `maxAgeSec=300`（舊呼叫端行為不變） |

回應在 §3 的 `providers`/`generatedAt` 之外多兩個欄位：`cached`（`true`＝這次回的是快照，沒有真的重查上游）、
`fetchedAt`（這份資料實際查到的時間，`cached:true` 時可能早於這次請求時間）。併發保護：多個請求同時觸發重查時，
只會真的打一次上游（共用同一個 in-flight promise），其餘請求等它回來後一起拿到同一份結果。

### 3.2 側欄一家一張卡（消費端，SPEC-sidebar-card-carousel.md §6.2）

側欄卡片輪播依本端點的 `providers[]` 動態生成 `quota:<id>` 卡，**一家模型一張**，後端多接一家本規格的轉接器，
前端自動多一張卡、不用改程式（延續 D1/D2 的 adapter 立場）。輪播本身**不會**因為切頁去查詢——所有卡共用
`?maxAgeSec=<sidebarCards.quotaRefreshSeconds>` 的同一份快照；卡片上的手動刷新鈕打 `?force=1`，一次查詢、
所有卡一起更新。`health !== 'ok'` 時卡片一律照 §3 的四態顯示一句人話，不畫進度條、不得編造數字（D9，同 D3）。

---

## 4. 轉接器（後端，每家一個）

共同介面：`async fetchQuota() → { health, message, usage, windows, source }`，**各自獨立、逾時 5 秒、例外一律轉成 `broken` 而非拋出**。

| 供應商 | 資料來源（實作時必須先實地確認，不可照抄本表硬幹） | 預期 health |
|---|---|---|
| **Claude Code** | 官方帳號用量端點 `GET https://api.anthropic.com/api/oauth/usage`，帶 `~/.claude/.credentials.json` 既有的 OAuth token；回傳 `five_hour` / `seven_day` 的 `utilization`(%) 與 `resets_at`。**這是 metadata 端點、不經過模型、不花額度**，故仍符合 D4。（註：`~/.claude/` 下的本機狀態檔確實查無配額欄位——2026-08-30 第一版誤據此判 `unsupported`，已修正） | `ok` |
| **Codex** | `~/.codex/sessions/**/rollout-*.jsonl` 最新一筆 `rate_limits` 快照。**快照有時效**：若所有窗口的 `resets_at` 都已過去，代表窗口早已重置、該百分比失效 → 回 `unsupported` 並註明上次呼叫時間，**不得續顯示過期數字**（D3） | `ok`／快照過期時 `unsupported` |
| **Gemini (Antigravity)** | 官方**不提供**帳號層級剩餘配額；`~/.gemini/` 只有本機紀錄可事後加總用量 | `unsupported`（有 usage、無 windows） |

> **實作紀律**：每個轉接器都必須有一段「格式健檢」——抓到資料後檢查關鍵欄位是否存在且型別正確，任何一項不符就回 `broken` 並在 `message` 寫清楚是哪個欄位不見了。**不得靜默 fallback 到預設值。**

**與既有 `cli-limit-state.json` 的分工**：`GET /api/limits`（被動、撞牆才知道）保留不動；本規格是主動查詢，兩者互補。UI 上「已撞牆等待重置」仍以 `/api/limits` 為準。

---

## 5. 前端呈現

- 位置：① 設定頁（`portal/views/settings.js`）「模型額度」區塊，每家一張卡；② **頂端「額度」按鈕的下拉面板（`portal/shell/header.js`）**——指揮官日常真正會看的地方，面板上半顯示各家用量進度條與重置時間，下半保留原本 `/api/limits` 的實際限流觀測；按鈕標籤顯示 Claude 最高窗口百分比（如「額度 20%」）。開啟面板時查一次，不輪詢。
- 每張卡：供應商名稱、health 燈號、各窗口進度條（`usedRatio` + 重置時間相對描述，如「約 3 小時後重置」）、資料新鮮度（`fetchedAt`）。
- `unsupported` / `missing` 卡：灰底、顯示 `message`，**不畫空的進度條**（避免看起來像 0%）。
- `broken` 卡：紅底 + `message` 全文，不摺疊。
- `stale` 卡（v0.2 新增，見 §9 D11）：**黃底／黃燈**，照常畫出 `windows` 的進度條（數字是真的、只是舊的），
  並在下方以灰字附上 `message`（「資料為 N 分鐘前的查詢結果」）。**不得顯示成紅字故障，也不得畫成 0%。**
- 手動「重新整理」按鈕；**不做自動輪詢**（D4）。

---

## 6. 降級偵測與通知（D5）

- 狀態快照存 `global-knowledge/model-quota-health.json`：`{ [providerId]: { health, since } }`。
- 每次 `GET /api/model-quota` 完成後比對：`ok → broken` 才推播一次（Telegram + 站內），訊息含供應商、`message`、時間。
- `broken → broken` 不重複推；`broken → ok` 推一則「已恢復」。
- `unsupported` / `missing` **永不推播**。
- 推播沿用既有 Telegram 通知管線，不另造一套。

---

## 7. 已知風險（誠實記錄）

- Codex 與 Gemini 的資料都來自**本機檔案或未公開輸出**，官方未承諾格式穩定；CLI 改版時本功能會壞——這正是 §6 存在的理由。單次修正預期在半小時內。
- 只有 Claude 那條是官方管道，相對穩定。
- 本功能**不保證數字與官方帳單一致**，僅供「還能不能繼續跑」的判斷。

---

## 8. 開放決策（本版已由指揮官拍板，留存備查）

- ✅ Gemini 那格顯示灰底「不支援」，不隱藏。
- ✅ 紅燈要推 Telegram，但只在「由好轉壞」時推一次。

---

## 9. v0.2 韌性修訂（MQR）— 偶發逾時不該變成紅字

**問題（Charles 2026-10-09 回報）**：側欄／頂端的用量卡經常顯示紅字
「Claude Code 額度查詢時發生未預期錯誤：逾時（5000ms 內未回應）」，要反覆手動刷新才會正常。

**根因（已讀碼確認，三項疊加）**

1. `model-quota.js` 的 `safeFetch` 統一 5000ms 逾時、`fetchClaudeQuota` 內 `AbortSignal.timeout(5000)`
   也是 5000ms。Claude 用量端點是**跨國 HTTPS 請求**（含 TLS 握手），偶發超過 5 秒屬正常波動。
2. **沒有重試**：一次逾時就定案為 `broken`。
3. `server.js` 的 `getQuotaSnapshot` 把**失敗結果也寫進快取**（`quotaSnapshot`），預設 maxAge 300 秒
   → 一次偶發逾時會讓紅字黏著 5 分鐘，直到使用者按下帶 `force=1` 的刷新。

**修訂決策**

- **D9（逾時放寬）**：Claude 轉接器與 `safeFetch` 的逾時 5000ms → **15000ms**。理由：這是使用者
  主動開面板時的查詢，等 15 秒遠優於顯示假故障；本機檔案型轉接器（Codex/Gemini）本來就瞬間完成，
  不受影響。
- **D10（重試一次）**：Claude 轉接器遇到**網路層失敗或逾時**（非 HTTP 4xx/5xx、非格式錯誤）時，
  退避 1 秒後重試一次；兩次都失敗才回報。格式錯誤／401 **不重試**（重試也不會變）。
- **D11（暫時性失敗不汙染快取，也不算降級）**：新增 `health: 'stale'`——當本次查詢因網路／逾時失敗、
  但 process 內存有**上次成功的結果且在 30 分鐘內**，則回傳上次成功的 windows，`message` 標註
  「資料為 N 分鐘前的查詢結果（本次連線逾時，稍後自動重試）」。
  - `stale` 在前端以**黃燈**呈現、照畫進度條（數字是真的，只是舊的），不是紅字。
  - `stale` **永不推播**降級通知（§6 的 D5 只處理 `ok↔broken`），避免網路抖動洗 Telegram。
  - 超過 30 分鐘無任何成功結果 → 照舊回 `broken`（此時確實是真的壞了）。
- **D12（失敗不覆蓋好快取）**：`server.js` 的快照層對「含 `broken`/`stale` 的 provider」**不更新該
  provider 的最後成功值**；成功值另存於 `model-quota.js` 內的 last-good 記憶體快取（process 生命週期內有效，
  不落檔——這是用量數字，重開 server 後重查即可）。

**不動的部分**：D4（絕不為了顯示而消耗模型額度）、快取 30 秒下限、`/api/limits` 被動偵測、
Codex 快照過期仍回 `unsupported`（那是「數字已失效」，與本節的「暫時連不上」不同，不可混用 `stale`）。

### 9.1 v0.2 實作紀錄（MQR，2026-10-09）

- D9/D10 已實作：`model-quota.js` 的 `safeFetch` 與 `fetchClaudeQuota` 內的 `AbortSignal.timeout`
  皆改為 15000ms；Claude 轉接器對網路層失敗／逾時退避 1 秒重試一次（最多兩次請求），401/403／非 2xx／
  JSON 解析失敗／欄位格式錯誤一律不重試。
- D11 已實作：新增 process 生命週期的 `claudeLastGood` 記憶體快取（不落檔），兩次請求都失敗且
  last-good 在 30 分鐘內 → 回 `health:'stale'` + 上次的 `windows` + 「資料為 N 分鐘前的查詢結果」訊息；
  超過 30 分鐘或從無成功紀錄 → 回 `broken`。
- D12 已實作：`server.js` 的 `getQuotaSnapshot` 新增 `degraded` 旗標（本次快取內含 `broken`／`stale`
  任一 provider），該快照重用窗口強制封頂在 30 秒（既有的 `QUOTA_MIN_MAX_AGE_SEC`），不吃預設 300 秒 TTL。
  `updateHealthSnapshot` **沒有改動程式**——原本的轉換條件（只有 `ok→broken`／`broken→ok` 才推播）天然就不會
  對 `ok→stale`／`stale→ok` 觸發，已用鏡射測試驗證此既有行為在新增 `stale` 態後依然成立。
- D11 前端呈現已實作於 `portal/shell/header.js`（面板）、`portal/index.html` 的 `renderQuotaCardInto`
  （側欄用量卡的真正程式位置——注意不是 `portal/shell/card-carousel.js`，那個檔案只負責輪播排版，
  個別供應商卡片的 HTML 是在 `index.html` 內生成）、`portal/views/settings.js`（設定頁額度卡，雖未列在
  原任務「主要動檔」，但同一份契約下若不補上會讓設定頁仍把 `stale` 誤判成紅字，故一併修正，維持一致）。
- **自測狀態**：`.worktable/artifacts/mqr/mirror_test.js` 直接 require 真 `model-quota.js`，monkey-patch
  `global.fetch` 驗證①~④（重試成功、stale 命中、無 last-good 回 broken、401 不重試）與⑤
  （`updateHealthSnapshot` 對 ok→stale／stale→ok 皆回空 transitions，並以對照組確認 ok→broken→ok 仍正常推播）；
  六項全部通過。`node --check` 已跑過每個動到的 `.js`；`index.html` 的 inline `<script>` 另用
  `new Function()` 驗證語法；`menu-no-emoji` 與 `view-has-menu` 兩個既有檢查也通過。
- **未驗證／誠實保留**：以上測試皆為 monkey-patch 假 `fetch` 的鏡射測試，**未對 Claude 官方端點做過真實
  的慢速/逾時網路測試**（無法可控地讓真實網路剛好卡在 5~15 秒），也**未經過瀏覽器端的人工操作驗證**
  （黃燈實際畫面、設定頁新卡片樣式皆未肉眼看過）。本次刻意未執行 `Deploy_Harness.ps1`（指揮官指示手動
  上線），因此以上前端改動在正式環境尚未生效，指揮官驗證需在 Deploy 之後進行。

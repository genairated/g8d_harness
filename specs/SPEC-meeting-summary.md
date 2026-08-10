# SPEC — 多模型會議摘要 + 可對話修正（Multi-Model Meeting Summary）

> **Status**: Draft v1.5 ｜ **Owner**: 老闆 + Claude(Opus) ｜ **Date**: 2026-07-03（v1.1 2026-07-16 加 P3 三分項；v1.2 2026-07-16 MSUM-D1~D4 拍板定案；v1.3 2026-07-16 加 P4 進度誠實＋三分項連動切換；v1.4 2026-07-16 加 P5 彙整版一等公民＝可選彙整模型＋獨立存檔可回放＋設為最終輸出；v1.5 2026-07-16 P5 擴充：彙整版可多份並存（綁彙整模型）＋彙整前可注入引導語）
> **Relates**: `SPEC-meeting-transcriber.md`（STT/diarization 上游）、`SPEC-multi-model-panel.md`（共用「跑 N 模型」原語）、`cli-providers.json`（模型選單）、`SPEC-meeting-export.md`（下游匯出，隨 P3 改三分項結構）

---

## 1. 動機

現行會議摘要（`meetingSummarizeToFiles` → `summary.md`+`actions.json`）有兩個問題：
1. **靜默失敗**：自動摘要是結束錄製時 **fire-and-forget**（`server.js` `finalizeMeetingSummary`），若當下 server 重啟（自癒部署打斷）、逐字稿未就緒、或 Claude 呼叫失敗 → **靜默跳過、無重試、無提示**。實測有場**逐字稿 1440 bytes 完整、卻連 `summary.md` 都沒有**。
2. **單一模型單一角度**：不同模型整理會議的角度不同（有的抓決議準、有的待辦全、有的條理清楚），單模型會漏。

**一個功能同時解**：把摘要升級成「**多模型集成 + 可靠 on-demand**」——多模型摘要本身就是新的摘要機制，順手把「沒摘要」的洞補掉。

---

## 2. 設計決策（與「深度思考」的關鍵區別）

**這是「交付物」不是「判斷題」** → 不需要深度思考那套（拜占庭、quorum、仲裁分歧）。摘要有「好壞」但不對立，多模型的價值只是**不同角度的整理** → **挑一版 or 彙整**即可。

| # | 決策 | 理由 |
|---|---|---|
| D1 | 多模型**集成**，不做分歧仲裁 | 摘要不是投票決定真相；並排看、挑或合就夠 |
| D2 | 兩種收尾：**挑一版** / **彙整**（主模型參考各版之長） | 彙整＝Mixture-of-Agents 的好處，但無仲裁複雜度 |
| D3 | **顯示模型品牌**（與深度思考的去標籤相反） | 你就是要比較它們，品牌是有用資訊 |
| D4 | 序列跑 N 模型（不並發） | 避開 CLI 並發搶 auth（同 `SPEC-multi-model-panel` D3） |
| D5 | 保留「結束自動跑一版預設模型」+「打開會議若無摘要就自動補」 | 保底：永遠至少一版，補掉靜默失敗 |

---

## 3. 共用原語：「跑 N 模型」（與 SPEC-multi-model-panel 共用）

深度思考與本功能**共用同一個底層**：對一個 prompt，**序列跑 N 個模型、回傳 N 份結果**。差別只在收尾（深度思考 diff 分歧；摘要挑/彙整）。

- 介面（建議）：`runModelsSequential({ prompt, models[], perTimeoutMs, wsRoot }) → [{ model, ok, output, elapsedMs }]`。
- 每個模型獨立 timeout、失敗棄權不重試（回 `ok:false`），湊到 ≥1 份即可收尾。
- 模型清單來源＝`cli-providers.json`（重用現有選單）。
- **本 spec 要求把這個原語抽成共用函式**（`render-service/` 或 server 內），deep-think 與 meeting-summary 都接它。

---

## 4. P1 — 多模型摘要（核心）

### 4.1 流程
1. 會議詳情「摘要」區的按鈕 → **多選模型**（cli-providers 選單；預設帶 1 個，可加選）。
2. `runModelsSequential` 對逐字稿各出一版 → 存 **`summary.<modelKey>.md`**（每模型一檔）。
   - prompt 沿用現行格式（`## SUMMARY` 三段【重點】【決議】【待辦】+ `## ACTIONS_JSON`）。
3. **UI 並排/分頁顯示 N 版**，各標**模型名 + 產生時間**。
4. **收尾（擇一）**：
   - **挑一版**：指揮官選最合的 → 該版寫入 `summary.md`+`actions.json`。
   - **彙整**：指定一個主模型（如 Opus）讀完 N 版 → 產出「參考各版之長」的最佳摘要 → 寫入 `summary.md`；`actions.json` = **N 版待辦的聯集去重**（最完整、漏項最少）。

### 4.2 可靠性（補掉「沒摘要」）
- **重跑允許**：已有摘要也能重跑，**覆蓋** `summary.md` 並更新時間戳（不因已存在而跳過）。
- **結束自動跑**：`finalizeMeetingSummary` 仍在，但改為跑**一版預設模型**（穩、便宜），確保永遠至少一版。
- **打開即自動補**：詳情開啟時偵測「有逐字稿但無 `summary.md`」→ 自動觸發一版預設模型摘要（lazy），並顯示「自動補摘要中…」。→ 舊的「有逐字稿沒摘要」會議一打開就補上。

### 4.3 來源與時間戳（provenance）
- `meta.json` 記 `summary` 區塊：`{ summarizedAt, models: [...], mode: 'single'|'pick'|'merge', chosenModel? }`。
- UI 明確顯示「**摘要於 <時間>、由 <模型> 產生（挑選/彙整）**」；每個 `summary.<model>.md` 也各自標時間，隨時能回去重看、重挑。

---

## 5. P2 — 對話式修正（Hana 頭像）

摘要/待辦/錯別字的微調常需人來改，且**改一處可能牽動整體** → 交給對話。

- 會議詳情加「**跟 Hana 討論此會議**」按鈕 → 開浮動頭像對話（`hana-overlay`），**把該會議的 context 帶入**：逐字稿 + 現行 `summary.md` + `actions.json`。
- 指揮官口語講「這裡錯別字、這個待辦改成…、決議寫錯」→ Hana 改 `summary.md`/`actions.json` 回寫。
- 因為改一處可能影響整體 → Hana 能**重新順一遍**（re-flow）整份摘要。
- 需要：一個「把會議 context 注入頭像對話 + 允許 Hana 回寫該會議 summary/actions」的通道（skill 或 chat 端的 meeting-scope）。

---

## 5.5 P3 — 多模型「三分項」分析（摘要／重點／Action item 同步 + 分項選擇性重生 + 一組彙整）

> 指揮官 2026-07-16 拍板方向：多模型不該只做「摘要」一項；**會議重點、Action item 也要各模型「同時」一起產生**，並能挑一版／彙整。

### 5.5.1 現況與缺口（不猜、實地查證）
- 目前每模型**一次 CLI 呼叫**就同時產出：`summary.<key>.md`（內含【重點】【決議】【待辦】三段文字）＋ `actions.<key>.json`（結構化待辦）。
- 所以「待辦（Action item）」**早已是多模型第一級公民**（每模型一檔＋彙整聯集去重）。
- **缺口**：**「會議重點」沒有獨立存在** — 它只是 `summary.md` 裡的一段【重點】文字，沒有獨立檔、沒有獨立收尾、UI 也沒有獨立面板（只有「摘要」「Action Items」兩塊）。

### 5.5.2 設計：把分析拆成三個第一級「分項」
一場會議的多模型分析＝**三個分項**，每個分項都有「各模型一版 + 收尾版」：

| 分項 | 內容 | 每模型檔 | 收尾檔 |
|---|---|---|---|
| **摘要** overview | 整體概述敘事 | `summary.<key>.md` | `summary.md` |
| **會議重點** keypoints | 關鍵要點＋決議（條列） | `keypoints.<key>.md`（新） | `keypoints.md`（新） |
| **Action item** | 結構化待辦 | `actions.<key>.json`（既有） | `actions.json`（既有） |

「決議」歸入「會議重點」（開放決策 MSUM-D2 可調）。

### 5.5.3 分項選擇性重生（勾選框）
- 摘要區的模型多選旁，加**三個分項勾選框**（摘要／重點／Action item），**預設全勾**。
- **「一組」約束（指揮官要點）**：三分項以**摘要為錨**。某模型若**尚無摘要**，就**不能只勾重點＋Action item**——前端把重點/Action item 勾選鎖住、提示「需先產生摘要」；若一項都沒有，摘要必含。Server 端亦防呆（未含摘要且該模型無 `summary.<key>.md` → 自動補上摘要）。
- **生成架構（方案 A′，MSUM-D1 已拍板）**：**維持每模型「一次 CLI 呼叫」**，但 prompt **動態只要求被勾選的分項**（重生衍生項時可把既有摘要當 context 餵入以保一致）；只覆寫被勾選分項的檔，未勾選分項的既有檔保留。→ 成本正比於勾選項、沿用現有 pipeline、不 3× 燒訂閱額度，且天然滿足「一組」。
  - 對照方案 B（真·每分項各一次呼叫）：最貼近「獨立重生」字面，但每模型最多 3× CLI 成本/時間。留 MSUM-D1 給指揮官選。

### 5.5.4 收尾（挑一版 / 彙整）三分項一致
- **挑一版**：選定某模型 → 該模型的**三分項**一起成為收尾版（`summary.md`＋`keypoints.md`＋`actions.json`）。
- **彙整（merge）**＝**三分項一起彙整**：摘要由 lead 模型重寫；**會議重點**由 lead 模型重寫（MSUM-D3 拍板：lead 重寫，非聯集）；Action item 維持既有**聯集去重**。→ 對應指揮官「彙整成一版＝每模型的摘要、重點、待辦一起匯整」。

### 5.5.5 相容
- 舊會議只有 `summary.md`（含【重點】）、無 `keypoints.md`：讀取端**回退**——UI/匯出取不到 `keypoints.*` 時，沿用 `summary.md` 內的【重點】段。零遷移、不回頭改舊檔。

### 5.5.6 決策（見 §8 P3、TASK §Q4）— **指揮官 2026-07-16 全數採推薦值拍板**
- `MSUM-D1` **生成架構** → ✅ **方案 A′**（維持每模型一次 CLI 呼叫、prompt 動態只求勾選分項）。省訂閱額度、沿用現有 pipeline、天然滿足「一組」。不採方案 B（3× 成本）。
- `MSUM-D2` **分項語意** → ✅ 摘要＝整體概述、會議重點＝關鍵要點＋**決議**、Action item＝待辦（**決議歸重點**）。
- `MSUM-D3` **重點彙整方式** → ✅ **lead 模型重寫**（較有條理）。
- `MSUM-D4` **provenance 粒度** → ✅ **每版加 `parts:{summary,keypoints,actions}`**（沿用單一 `versions[]`、破壞最小）。

---

## 5.6 P4 — 多模型整理「進度誠實 + 三分項連動切換」（上線後實測缺口）

> 指揮官 2026-07-16 實測 P3 後抓出兩個真 bug：整理過程「看起來沒反應」、切模型只換摘要不換重點/待辦。皆為前端呈現與收尾誠實度問題，非資料缺（磁碟上三分項各模型檔齊全、`versions[]` 也帶 `parts`）。

### 5.6.1 缺口 A — 整理「無進度回饋 + 全跑完才寫檔 + 全棄權假成功」
實地查證的三個根因：
1. **前端零進度**：按「開始整理」後只送請求、關選單、還原按鈕；**摘要區不進入整理中狀態**（只有「自動補摘要」那條路徑有 spinner，多模型這條沒有）→ 畫面看似沒按。
2. **全跑完才寫檔**：`meetingSummarizeToFiles` 序列跑完 N 模型＋收尾後才一次寫 `meta.summary.versions[]`；期間 `summary.md`／`keypoints.md`／`actions.json` 與版本面板都還是舊的 → 看似「內容沒變」其實還在跑。
3. **全棄權假成功**：輪詢完成判斷只看「有 summary 且沒在跑」。若該會議本有舊摘要、這次多模型**全部棄權**，系統保留舊摘要不覆蓋 → 輪詢誤判完成、還跳**假的「摘要與 Action 已產生」成功提示**。

### 5.6.2 修法 A（前端為主 + 後端一小改）
- **立即顯示進度**：一按「開始整理」，摘要區立即進入「正在序列整理 N 個模型，可能需數分鐘…」的 spinner、鎖定按鈕，直到真正完成/失敗。
- **逐模型即時寫檔**：後端在序列迴圈內**每跑完一個模型就寫一次 `meta.summary.versions[]`**（增量、非等全部）；前端輪詢顯示「已完成 x/N」並把該模型輸出**即時填進版本面板**（直接回應「按該模型的輸出即時呈現」）。
- **誠實收尾**：全模型棄權時，回傳明確錯誤「所有模型都沒產出、已保留原摘要」，前端顯示錯誤而非假成功；輪詢完成判斷需能區分「這次有新版本產生」與「沿用舊摘要」。

### 5.6.3 缺口 B — 頂部版本 tab 只切「摘要卡」，重點/待辦卡不連動
版面有三張獨立大卡：摘要（`mtg-summary-view`）、會議重點（`mtg-keypoints-view`）、Action Items（`mtg-actions-table`）。頂部「切換模型」＝版本比較面板（`mtg-summary-versions`）的分頁 tab，**整塊塞在摘要卡內**。`mtgSelectVersion → mtgRenderSummaryVersions` 只重繪這塊比較面板；下方獨立的重點卡、Action Items 卡只吃收尾版（`keypoints.md`／`actions.json`）→ 收尾為 pick/opus 時，切 tab 到別的模型，那兩張大卡文風不動，看似「重點/待辦沒跟著切」。（資料鏈正常：`versions[]` 每筆帶 `keypoints`／`actions`。）

### 5.6.4 修法 B — 頂部版本 tab 升級為全頁「檢視模型」開關
切版本 tab 時，同步把 `mtg-keypoints-view` 與 `mtg-actions-table` 也換成該版本的 `v.keypoints`／`v.actions`；「收尾版」作為其中一個 tab（顯示 `summary.md`／`keypoints.md`／`actions.json`）。一個開關管三區、三分項同步切換，最貼近「切一個模型三區一起換」的直覺、最不易誤解。純前端變更。

---

## 5.7 P5 — 彙整版一等公民（可選彙整模型 + 獨立存檔可回放 + 設為最終輸出）

> 指揮官 2026-07-16 拍板（推翻 P3 的「彙整＝用完即棄的收尾」）：**彙整本身有價值**——各模型有各自偏好，指揮官想用**一個高等模型**去讀各版、產出一份最好的彙整；而且「即便彙整後也可能有錯、需要調整」，所以彙整結果**必須獨立存檔、能回放、能再編輯，甚至以它當最終輸出**。

### 5.7.1 現況缺口（實地查證，非猜）
現行彙整（`_finalizeMeetingSummary` mode='merge'，server.js:5929）：
- **彙整模型不可選**：lead＝`chosenModel || 各版第一個`，指揮官無法指定一個「不在本次 N 選模型內」的高等模型（如只跑 3 個便宜模型、用 Opus 彙整）。
- **用完即棄、每次重生**：結果直接覆蓋 `summary.md`／`keypoints.md`／`actions.json`，**不進 `versions[]`**（`_readMeetingVersions` server.js:5805 只裝各模型原始版）→ 版本 tab 看不到「彙整版」、無法切回回放、每按一次彙整就重算覆蓋上一份。
- **無法把彙整版當「可修改的最終輸出」**：因為它沒有身分（不是一個 version），P2 對話修正也沒有明確的「編輯這個彙整版」的對象。

### 5.7.2 設計：彙整版＝`versions[]` 的一等公民（key 綁「彙整模型」，可多份並存）
把彙整從「收尾動作」升格為「**產生一個彙整版本**」，與各模型版並列。**關鍵：彙整版的身分綁「用哪個模型彙整」**——因為指揮官可能用不同高等模型各彙整一份來比較（例：Opus 一份、另一高等模型一份），所以**彙整版不是唯一一份、可多份並存**：

| 面向 | 各模型版 | **彙整版（新）** |
|---|---|---|
| key | modelKey（如 `claude::opus`） | **`merged::<彙整模型>`**（如 `merged::claude::opus`） |
| 檔案 | `summary.<key>.md` 等 | `summary.<mergedKey>.md`／`keypoints.<mergedKey>.md`／`actions.<mergedKey>.json`（沿用各模型版同一套檔名／消毒規則，只是 key 帶 `merged::` 前綴） |
| 進 `versions[]` | ✅ | ✅（`model:'merged::<彙整模型>'`，帶 `mergeModel` 記彙整模型、`mergePrompt` 記本次引導語） |
| 切 tab 回放 | ✅（P4 修法 B） | ✅（**每個彙整模型一個 tab**：「彙整版（由 Opus）」「彙整版（由 X）」並列） |
| 重跑 | 覆蓋該模型檔 | **只覆蓋同一彙整模型的那一份**（換彙整模型＝另存一份；與各模型版「一模型一份」一致） |

- **可選彙整模型**：彙整 UI 加一個**獨立的模型下拉**（來源＝整份 `cli-providers.json`，**不限於本次選的 N 個模型**；預設帶一個高等模型）。→ 直接回應「我會用一個高等模型來做彙整」，且換模型再按即多存一份、不互蓋。
- **彙整內容**沿用 P3 §5.5.4：摘要由彙整模型重寫、會議重點由彙整模型重寫、Action item＝各版**聯集去重**；三分項一起產、一起存進該彙整版的 `*.<mergedKey>.*`。

### 5.7.2b 彙整引導語（`mergePrompt`）— 彙整前可注入人工判斷
指揮官在按「彙整」前，可在彙整區填一段**引導語**（選填 textarea），例如：
- 「這三版對交期的描述邏輯衝突，**以第 2 版（<模型>）為主**」
- 「第 1 版的預算數字有誤、請以第 3 版為準」「Action item 的負責人以第 2 版為正解」
- 「合併時語氣統一成正式書面、去除口語贅字」

設計：
- 引導語**併進 `_meetingMergePrompt`**（放在「各版內容」之後、輸出指示之前，明確標為「指揮官的彙整指示，優先於各版內容的表面分歧」），讓彙整模型據此裁決衝突、修正已知錯誤。
- 引導語**隨該彙整版存檔**（`versions[].mergePrompt`），UI 在該 tab 顯示「本版彙整引導：…」，讓指揮官記得這份是用什麼判斷產出的；**重跑同一彙整模型**時帶回上次引導語當預設（可改）。
- 引導語為**選填**：留空＝純「參考各版之長」彙整（現行行為）。

### 5.7.3 「最終輸出」＝一個明確的指定（與「產生某版本」解耦）
把「**產生一個版本**」與「**哪一版是最終輸出**」拆成兩件事：
- `summary.md`／`keypoints.md`／`actions.json`＝**最終輸出（final）**，是預設顯示與**下游匯出（`SPEC-meeting-export.md`）取用**的內容（角色不變）。
- 新動作 **「設為最終輸出」**：對**任一版本**（某模型版 **或** 某個彙整版）→ 把它的三分項複製進 `summary.md`／`keypoints.md`／`actions.json`，並記 `meta.summary.final={ source: versionKey, setAt }`（`versionKey` 可為 modelKey 或 `merged::<彙整模型>`）。UI 在最終那版 tab 標「★ 最終輸出」。
- **相容**：**最近一次**彙整完成後**預設自動設為最終輸出**（＝現行行為）；但因彙整版可多份並存，指揮官隨時可切到任一彙整版／模型版回放、或把它改設為最終。

### 5.7.4 可回放 + 可再編輯
- **回放**：切到「彙整版」tab 即看回該版三分項（P4 修法 B 的全頁「檢視模型」開關天然涵蓋，只是多一個 tab）。
- **再編輯**：P2 對話修正（`MTG-SUM-06/07`）的編輯對象＝**目前選定的版本檔**；編輯某個彙整版即寫該版的 `*.<mergedKey>.*`。若該版同時是最終輸出，一併刷新 `summary.md` 等（保持「最終輸出＝該版最新內容」）。→ 直接回應「存起來才有辦法做修改，甚至以彙整版當最終輸出」。

### 5.7.5 決策 — 指揮官 2026-07-16 已拍板 B（+ 多份彙整版 + 引導語）
- `MSUM-D5` **彙整版留存策略** → ✅ **B**：彙整版獨立存檔為一等公民版本、可選彙整模型、可回放、可再編輯、可設為最終輸出。
- `MSUM-D6` **彙整版數量** → ✅ **可多份並存**，身分綁「彙整模型」（key `merged::<彙整模型>`）；換彙整模型另存一份、同模型重跑才覆蓋。（推翻 v1.4 的「單一彙整版」——理由：指揮官要用不同高等模型各彙整一份來比較。）
- `MSUM-D7` **彙整引導語** → ✅ 彙整前可注入選填引導語（指出各版衝突以誰為主、已知錯誤如何修正），併進彙整 prompt 並隨版存檔（見 §5.7.2b）。

---

## 6. 資料模型
```
.harness/runtime/meetings/<meetingId>/
  transcript.txt / transcript.labeled.txt      # 上游（不變）
  summary.<modelKey>.md                          # 每模型「摘要」一版（P1）
  keypoints.<modelKey>.md                        # 每模型「會議重點」一版（P3・新）
  actions.<modelKey>.json                        # 每模型「Action item」一版（P1・既有）
  summary.merged::<彙整模型>.md / keypoints.merged::<彙整模型>.json …  # 彙整版（P5・key `merged::<彙整模型>`，可多份並存、可選彙整模型、可回放/編輯；檔名沿用各模型版消毒規則）
  summary.md / keypoints.md / actions.json       # 最終輸出 final（下游匯出取用；由「設為最終輸出」指定某版複製而來）
  meta.json → { …, summary: { summarizedAt, models[], mode, chosenModel?,
                  final?: { source: versionKey, setAt },              # P5：哪一版是最終輸出（versionKey = modelKey | 'merged::<彙整模型>'）
                  versions:[{ model, generatedAt, ok, elapsedMs,
                              mergeModel?,                              # P5：model 以 'merged::' 開頭時，記用哪個模型彙整
                              mergePrompt?,                             # P5：本份彙整用的引導語（選填，見 §5.7.2b）
                              parts:{ summary:bool, keypoints:bool, actions:bool } }] } }
```

## 7. 落地觸點
- **server.js**：`runModelsSequential` 共用原語；`meetingSummarizeToFiles` 升級成多模型（產 `summary.<model>.md`）+ 挑/彙整；新端點 `POST /api/meeting/:id/summarize`（帶 `{models[], mode, chosenModel?}`）；`finalizeMeetingSummary` 改預設單模型 + 保底。
- **index.html**：摘要區加模型多選 + 並排/分頁 N 版 + 挑/彙整鈕 + provenance 顯示 + 「跟 Hana 討論此會議」(P2)；詳情開啟 lazy 補摘要。
- **cli-providers.json**：重用（模型選單）。

## 8. 任務分解（對應 `.worktable/TASK.md`）

### P1
- `MTG-SUM-01` 共用原語 `runModelsSequential`（序列跑 N 模型、獨立 timeout、失敗棄權）。
- `MTG-SUM-02` `meetingSummarizeToFiles` 多模型化：產 `summary.<model>.md`；端點收 `{models[],mode,chosenModel?}`。
- `MTG-SUM-03` 收尾：挑一版 / 彙整（主模型參考各版）+ actions 聯集去重 → `summary.md`+`actions.json`+meta provenance。
- `MTG-SUM-04` 可靠性：重跑覆蓋+更新時間；`finalizeMeetingSummary` 預設單模型保底；詳情開啟 lazy 補摘要。
- `MTG-SUM-05` UI：模型多選、並排/分頁 N 版、挑/彙整鈕、「摘要於 X 由 Y 產生」provenance。
- 🧑‍✈️ 指揮官手動驗證（此關只由指揮官勾）

### P2
- `MTG-SUM-06` 「跟 Hana 討論此會議」：把逐字稿+現摘要+待辦注入頭像對話。
- `MTG-SUM-07` Hana 回寫 summary/actions + re-flow（改一處可重順全份）。
- 🧑‍✈️ 指揮官手動驗證（此關只由指揮官勾）

### P3 — 多模型三分項（摘要／重點／Action item）（見 §5.5）
- `MTG-SUM-08` 資料模型＋三分項 prompt：`_meetingSummaryPrompt` 明列三段（`## SUMMARY` 概述／`## KEYPOINTS` 重點＋決議／`## ACTIONS_JSON` 待辦）；`_parseMeetingSummaryOutput` 解析三段；每模型寫 `summary.<key>.md`／`keypoints.<key>.md`／`actions.<key>.json`；`meta.summary.versions[]` 每版加 `parts`。舊 `summary.md`（含【重點】）保留讀取回退。
- `MTG-SUM-09` 分項選擇性生成：`meetingSummarizeToFiles` 收 `parts:{summary,keypoints,actions}`（預設全 true）；**方案 A′**＝一次呼叫、prompt 動態只求勾選分項、只覆寫勾選分項檔；「一組」防呆——未含摘要且該模型無 `summary.<key>.md` → 強制補摘要。`POST /api/meeting/:id/summarize` body 擴充 `parts`。
- `MTG-SUM-10` 三分項收尾：`_finalizeMeetingSummary` 三段各收尾——摘要 lead 重寫、重點 lead 重寫（或聯集，MSUM-D3）、actions 聯集去重 → `summary.md`＋`keypoints.md`＋`actions.json`＋meta。`summary/finalize` 端點沿用。
- `MTG-SUM-11` UI（`index.html` 摘要區）：模型多選旁加三分項勾選框（預設全勾、依「一組」規則 disable/提示）；N 版並排每版顯示三段；新增獨立「會議重點」顯示（並排各版重點）；收尾 pick/merge 三分項一致。
- `MTG-SUM-12` 自測＋部署：隔離埠＋temp `HARNESS_HOME`＋真 venv；多模型三分項生成、只重生重點+action、無摘要時強制含摘要、彙整三段；`node --check`＋`py_compile`＋`Deploy_Harness.ps1` smoke。
- 🧑‍✈️ 指揮官手動驗證（此關只由指揮官勾）

### P4 — 整理進度誠實 + 三分項連動切換（見 §5.6）
- `MTG-SUM-13` 進度回饋（缺口 A / 修法 A）：前端一按「開始整理」，摘要區立即進入「正在序列整理 N 個模型…」spinner＋鎖按鈕直到真完成/失敗；`index.html` 多模型路徑補上整理中狀態。
- `MTG-SUM-14` 逐模型即時寫檔＋誠實收尾（缺口 A / 修法 A）：`server.js`／`meetingSummarizeToFiles` 在序列迴圈內**每跑完一個模型就寫一次 `meta.summary.versions[]`**（增量）；前端輪詢顯示「x/N」並即時填版本面板；全模型棄權 → 回傳明確錯誤「所有模型都沒產出、已保留原摘要」，前端顯示錯誤而非假成功（輪詢完成判斷需區分「有新版本」vs「沿用舊摘要」）。
- `MTG-SUM-15` 三分項連動切換（缺口 B / 修法 B）：`index.html` 頂部版本 tab（`mtgSelectVersion`）升級為全頁「檢視模型」開關——切 tab 時同步把 `mtg-keypoints-view`／`mtg-actions-table` 換成該版 `v.keypoints`／`v.actions`；「收尾版」作為其中一個 tab。純前端。
- `MTG-SUM-16` 自測＋部署：隔離埠＋temp `HARNESS_HOME`＋真 venv 驗多模型整理即時顯示 x/N、全棄權報錯不假成功、切 tab 三卡連動；`node --check`＋`Deploy_Harness.ps1` smoke。
- 🧑‍✈️ 指揮官手動驗證（此關只由指揮官勾）

### P5 — 彙整版一等公民（可選彙整模型 + 獨立存檔可回放 + 設為最終輸出）（見 §5.7）
- `MTG-SUM-17` 彙整版存成一等公民（可多份）：`_finalizeMeetingSummary` mode='merge' 改為以 `mergeModel` 組出 key `merged::<彙整模型>`，寫 `summary.<mergedKey>.md`／`keypoints.<mergedKey>.md`／`actions.<mergedKey>.json`（沿用各模型版檔名消毒），並把 `{model:'merged::<彙整模型>', mergeModel, mergePrompt?, parts}` upsert 進 `meta.summary.versions[]`（同 mergeModel 覆蓋、換 mergeModel 另存一筆）；`_readMeetingVersions` 讀出所有 merged 版。彙整模型參數獨立於 N 選模型（來源整份 cli-providers）。
- `MTG-SUM-17b` 彙整引導語：端點收 `mergePrompt`（選填），`_meetingMergePrompt` 把它插在「各版內容」之後、輸出指示之前並標為「指揮官彙整指示（優先於各版表面分歧）」；`mergePrompt` 隨該彙整版存進 `versions[]`。
- `MTG-SUM-18` 「最終輸出」指定：新端點/動作「設為最終輸出」——把任一版本（modelKey 或 `merged::<彙整模型>`）三分項複製進 `summary.md`／`keypoints.md`／`actions.json`＋記 `meta.summary.final={source:versionKey,setAt}`；最近一次彙整完成預設自動設為最終（相容現行）。下游匯出改讀 final（若已存在該欄）。
- `MTG-SUM-19` UI（`index.html` 摘要區）：彙整區加**獨立彙整模型下拉**（整份模型清單、預設高等）＋**引導語 textarea**（選填，重跑同彙整模型帶回上次值）；「檢視模型」開關**每個彙整模型一個 tab**（「彙整版（由 X）」，切回可回放三分項並顯示該版引導語）；每版 tab 加「設為最終輸出」鈕、最終那版標「★ 最終輸出」。（P2 落地後：編輯對象＝選定版本檔，編輯彙整版寫該版 `*.<mergedKey>.*`，若為最終一併刷新 final。）
- `MTG-SUM-20` 自測＋部署：隔離埠＋temp `HARNESS_HOME`＋真 venv 驗——用非選內模型彙整、**兩個不同彙整模型各存一份且並列可切回**、帶引導語彙整（prompt 有含引導語、存回 versions[]）、同彙整模型重跑覆蓋、設為最終輸出改到不同版、匯出取 final；`node --check`＋`Deploy_Harness.ps1` smoke。
- 🧑‍✈️ 指揮官手動驗證（此關只由指揮官勾）

---

## Changelog
| Date | Version | Author | Description |
|:-----|:--------|:-------|:------------|
| 2026-07-16 | v1.5 | 老闆 + Hana(Opus) | P5 擴充（推翻 v1.4「單一彙整版」）：指揮官拍板 `MSUM-D6`（彙整版**可多份並存**、身分綁彙整模型 key `merged::<彙整模型>`，換模型另存、同模型重跑才覆蓋——理由：想用不同高等模型各彙整一份比較）＋ `MSUM-D7`（彙整前可注入**選填引導語** `mergePrompt`：指出各版衝突以誰為主、已知錯誤如何修正，併進彙整 prompt 並隨版存檔，見 §5.7.2b）。任務 `MTG-SUM-17`（改多份 upsert）＋新增 `MTG-SUM-17b`（引導語），`18/19/20` 同步更新（final source 改用 versionKey、UI 每彙整模型一 tab＋引導語 textarea、自測驗兩份彙整並存與引導語）。 |
| 2026-07-16 | v1.4 | 老闆 + Hana(Opus) | 加 P5（§5.7）：指揮官拍板 `MSUM-D5=B`。彙整版從「用完即棄的收尾」升格為 `versions[]` 一等公民（reserved key `merged`，存 `*.merged.*`）——**可選彙整模型**（獨立於 N 選模型、來源整份 cli-providers、預設高等）、**可切 tab 回放**、**可再編輯**、可透過新動作「**設為最終輸出**」把任一版（模型版或彙整版）複製進 `summary.md`/`keypoints.md`/`actions.json`（記 `meta.summary.final`）。彙整完成預設自動設為最終（相容）。任務 `MTG-SUM-17~20`。 |
| 2026-07-16 | v1.3 | 老闆 + Hana(Opus) | 加 P4（§5.6）：P3 上線後實測抓出兩個真 bug。缺口 A＝多模型整理「無進度回饋＋全跑完才寫檔＋全棄權假成功」（修法 A：立即 spinner＋逐模型即時寫 `versions[]`＋前端顯示 x/N＋全棄權誠實報錯）；缺口 B＝頂部版本 tab 只切摘要卡、重點/待辦卡不連動（修法 B：tab 升級為全頁「檢視模型」開關、三分項同步切換）。任務 `MTG-SUM-13~16`。 |
| 2026-07-03 | v1.0 | 老闆 + Claude(Opus) | 初版。多模型會議摘要＝交付物集成（非判斷題，無仲裁/拜占庭）：選 N 模型→序列各出一版→挑一版/彙整（主模型參考各版、待辦聯集）；同時補掉「靜默失敗沒摘要」（重跑覆蓋+時間戳、結束保底單模型、打開 lazy 補）；與 SPEC-multi-model-panel 共用「跑 N 模型」原語；P2 對話式修正（頭像帶會議 context、Hana 回寫+re-flow）。 |
| 2026-07-16 | v1.2 | 老闆 + Hana(Opus) | 指揮官全數採推薦值拍板 MSUM-D1~D4：D1＝方案 A′（一次呼叫、動態只求勾選分項）、D2＝三分項語意（決議歸重點）、D3＝重點以 lead 模型重寫、D4＝`versions[]` 每版加 `parts`。§5.5.3/§5.5.4/§5.5.6 由「待拍板」改為定案。 |
| 2026-07-16 | v1.1 | 老闆 + Hana(Opus) | 加 P3（§5.5）：把多模型分析拆成**三個第一級分項**——摘要／會議重點／Action item，各有「各模型一版＋收尾版」。缺口＝「會議重點」原本只是 `summary.md` 內一段【重點】文字、無獨立存在；新增 `keypoints.<key>.md`＋`keypoints.md`。分項勾選框（預設全勾）＋「一組」約束（摘要為錨、無摘要不可只勾重點/action）＋彙整三分項一起。推薦生成架構 A′（一次呼叫、動態只求勾選分項、省訂閱額度）。4 個開放決策 MSUM-D1~D4 待拍板。連動 `SPEC-meeting-export.md`（匯出改三分項結構、尚未開工零返工）。 |

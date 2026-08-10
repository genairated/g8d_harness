# SPEC — AI 會議：逐字稿校正 + 產生記錄入口 + 校正版檢視 + 錄音回放連動

> **Status**: Draft v1.0 ｜ **Owner**: 老闆 + Hana(Opus) ｜ **Date**: 2026-07-22
> **Relates**: `SPEC-meeting-transcriber.md`（上游：`transcript.txt` 即時 append 的 `[HH:MM:SS] text` 格式、`audio.wav` 同步落檔、`transcript.labeled.txt` 語者標籤）、`SPEC-meeting-summary.md`（下游：多模型摘要，讀逐字稿產 summary/keypoints/actions）、`SPEC-meeting-export.md`（更下游：匯出）
> **對應**：`.worktable/TASK.md §MCR`（四個獨立 phase：MCR1 校正 / MCR2 產生記錄入口 / MCR3 校正版檢視 / MCR4 回放連動）
> **開源**：隨公開版出貨。
> **自我修改平台程式**（`portal/server.js`、`portal/index.html`、`render-service/*`）：改完走 `Deploy_Harness.ps1`（冒煙＋自動回滾），git 由人類掌控、不自行 commit。

---

## 1. 動機（指揮官 2026-07-22 四點）

會議記錄目前錄完就停在逐字稿，且逐字稿是語音辨識直出、易有同音字錯誤 → 連帶讓摘要／重點／待辦出錯。四個優化：

1. **逐字稿校正**：停止錄製後，先讓 AI 依「會議主題＋前後文＋相似發音」規則把辨識錯誤校正過，再據校正版產生會議記錄。
2. **產生記錄入口**：錄完不要只停在逐字稿、也不要離開再重進才有摘要——畫面就地給一個「產生會議記錄」按鈕（比照現有「多模型」），點了才跑。
3. **校正版可檢視**：AI 校正後，原文與校正後都要留著、隨時能看。**逐字稿很長，diff 不好讀 → 重點是能單獨、完整地查看校正版**（畫面切換或彈窗皆可）。
4. **錄音回放**：能重聽該場錄音，且**回放要與逐字稿連動**——因為回放的目的就是核對逐字稿是否正確。

---

## 2. 設計決策（指揮官已拍板 A/B/C/D）

| # | 決策 | 拍板 |
|---|---|---|
| **A** | 校正用**單一模型**（下拉選一個高等模型），非多模型並存 | ✅ 同意單一模型。校正目標是「一份更準的逐字稿」，不像摘要要多角度並排。 |
| **B** | 校正**不強制**先做才能產記錄；UI 引導先校正，沒校正就用原始逐字稿 | ✅ 同意不強制。保留彈性。 |
| **C** | 校正版**純檢視**（不做 diff 反白），但**校正結果必須有地方能單獨、完整查看**（切換檢視 + 可全屏／彈窗查看整份校正版） | ✅ 同意純檢視；逐字稿很多、diff 難看，**能單獨查看比較重要**。 |
| **D** | 回放**必須與逐字稿連動**（點逐字稿跳到對應錄音時間 + 播放時高亮當前行、自動捲動）——**這要一起做，不延後** | ✅ 回放目的就是核對逐字稿正確性，連動一起做。 |

**MCR-D1（已決）** 校正基底：以「當下最佳逐字稿」為基底——有 `transcript.labeled.txt`（語者標籤）用它、否則用 `transcript.txt`。校正**保留每行 `[HH:MM:SS]` 時間戳與語者標籤**，只改辨識錯字。
**MCR-D2（已決）** 校正產物另存 `transcript.corrected.txt`、**原檔不動**（符合 C「原文與校正後都留」＋天條）。
**MCR-D3（已決）** 下游摘要逐字稿優先序改為 **corrected → labeled → raw**（有校正版就吃校正版，MCR1 落地後 MTG-SUM 自動受惠）。

---

## 3. 資料模型（重用會議目錄，零遷移）

每場會議 `<workspace>/.harness/runtime/meetings/<meetingId>/`：

| 檔 | 狀態 | 內容 |
|---|---|---|
| `transcript.txt` | 既有 | 原始逐字稿，每行 `[HH:MM:SS] text`（時間戳＝**距錄音起點的經過秒數**，`meeting_record.py` 由 `start_sample/rate` 寫入 → 直接對應音檔播放位置）。 |
| `transcript.labeled.txt` | 既有 | 語者標籤版（語者分離後）。 |
| `audio.wav` | 既有 | 同步落的單聲道 16-bit 音訊（回放素材）。 |
| `transcript.corrected.txt` | **MCR1 新** | AI 校正後逐字稿，**沿用 `[HH:MM:SS] text`（含語者標籤）同款格式** → 回放連動、下游摘要皆可直接吃。 |
| `meta.json` | 既有＋擴充 | 新增 `correction` 區塊（見下）。 |

```jsonc
meta.json → {
  …,
  correction: {              // MCR1 新增
    correctedAt: ISO,        // 校正完成時間
    model: "claude::opus",   // 用哪個模型校正（單一）
    base: "labeled"|"raw",   // 校正基底
    status: "done"|"error"|"running",
    chunks?: number,         // 分段數（長會議分段餵）
    error?: string
  }
}
```

---

## 4. MCR1 — 逐字稿校正（單一模型）｜§1.1 / 決策 A·B·D1·D2·D3

**新後端** `correctMeetingTranscript(meetingId, meetingDir, meta, { model })`（`server.js`，比照 `meetingSummarizeToFiles` 的 job 型態）：
1. 讀基底逐字稿（labeled 優先，否則 raw；空 → 400 錯誤）。
2. **分段餵**（長會議必須）：以行為單位切段（例如每 ~120 行或 ~4000 字一段），**每段帶前一段末尾數行當前後文 overlap**，避免跨段語意斷裂。
3. 每段呼叫**單一模型**（重用 `_spawnCliPrintOnce` / `runModelsSequential` 以 N=1 跑；模型來源 `cli-providers.json`），prompt 明列校正規則：
   - **只修辨識錯誤**（同音／近音字、專有名詞、數字、標點斷句），**不改寫、不摘要、不重排、不增刪語意**。
   - **保留每一行的 `[HH:MM:SS]` 前綴與語者標籤原樣**，逐行對應輸出（行數、時間戳不變）。
   - 帶**會議脈絡**提升準度：`meta.title`、`meta.tags`、`meta.speakers`（與會者姓名＝專有名詞校正線索）。
   - 中文維持台灣繁體用語。
4. 逐段回填、組出完整校正稿 → 寫 `transcript.corrected.txt`（`utf-8`）；寫 `meta.correction`。
5. **失敗誠實**：某段模型棄權／逾時 → 該段**保留原文**、`meta.correction.status='error'`＋error 說明，不假裝成功；已完成段落照存（防當機精神）。

**新端點** `POST /api/meeting/:id/correct` body `{ model }` → 非同步啟動（比照 summarize：in-flight 去重、回 `{status:'processing', runId}`）；進度／結果經 `GET /api/meeting/:id` 的 `meta.correction` 輪詢。工作區隔離走 `resolveWorkspace(req)`。

**下游接線（MCR-D3）**：`POST /api/meeting/:id/summarize`（`server.js:4117-4119`）逐字稿讀取優先序改為 **`transcript.corrected.txt` → `transcript.labeled.txt` → `transcript.txt`**。→ 有校正版時多模型摘要自動吃校正版。

**護欄**：單一模型、分段序列（不並發搶 auth）；guardrails 沿用 job 慣例。改到 server.js → Deploy。

---

## 5. MCR2 — 產生會議記錄入口（就地 CTA）｜§1.2 / 決策 B

**現況**（實地查證）：多模型「開始整理」面板**早已存在**於會議詳情摘要區（`MTG-SUM-05`）；缺的是**停止錄製後的引導**——`POST /api/meeting/stop` 後前端停在逐字稿，摘要要離開列表再重進才觸發。

**修法（前端為主）**：
1. **停止即落詳情頁**：`mtgStop()` 成功後直接 `mtgViewMeeting(id)`，停在該會議詳情、不再只停逐字稿。
2. **就地「產生會議記錄」CTA**：詳情頁在「有逐字稿、尚無摘要」時，於顯眼處放一塊引導：**① （可選）校正逐字稿 → ② 選模型 → ③ 產生會議記錄**。三步以按鈕呈現，**點了才跑**（B：校正非強制；「產生會議記錄」直接可按，跳過校正就用原始逐字稿）。
3. **校正步驟入口**：CTA 內「校正逐字稿」按鈕＝選一個模型 → 呼 `POST /api/meeting/:id/correct`（MCR1）；校正中顯 spinner、完成後提示「已產生校正版，可於逐字稿切換檢視（MCR3）」，並讓「產生會議記錄」自然吃到校正版。
4. 重用既有多模型摘要面板（`MTG-SUM-05`）為「選模型 → 產生」那步，不另造。

**相依**：校正步驟需要 MCR1；若 MCR1 尚未落地，該按鈕優雅停用／隱藏（「產生會議記錄」仍可用原始逐字稿）。純前端 → Deploy。

---

## 6. MCR3 — 校正版檢視（原始／校正後，純檢視）｜§1.3 / 決策 C

**目標**：原文與校正後都能看；**逐字稿很長 → 重點是能單獨、完整查看整份校正版**（不做 diff 反白）。

1. **逐字稿區「原始／校正後」切換**（`meta.correction` 存在且 `status='done'` 時才顯切換）：一鍵在 `transcript.txt`（或 labeled）與 `transcript.corrected.txt` 之間切換顯示；兩者皆保留、隨時可回看。
2. **單獨完整查看**：提供「檢視校正版」動作 → 開**全屏／彈窗**完整顯示整份校正稿（因逐字稿很長，需可捲動、可全屏），這是 C 的核心（「單獨可以查看比較重要」）。
3. **端點擴充**：`GET /api/meeting/:id/transcript`（`server.js:3905`）回傳新增 `corrected`（讀 `transcript.corrected.txt`，無則 null）；前端切換／彈窗即讀它。
4. **與 MCR4 相容**：切到「校正後」時，回放連動（MCR4）作用於校正稿（校正稿保留 `[HH:MM:SS]` → 連動照常）。

**相依**：需要 MCR1 產出的校正檔才有內容可切；無校正版時只顯原始、不出切換鈕。純前端＋一小端點欄位 → Deploy。

---

## 7. MCR4 — 錄音回放 + 逐字稿連動（決策 D，必做）｜§1.4

1. **音訊串流端點** `GET /api/meeting/:id/audio`（`server.js`）：serve `audio.wav`，**支援 HTTP `Range`**（`206 Partial Content`）→ 可拖曳進度、可 seek。工作區隔離 `resolveWorkspace(req)`＋路徑防穿越；`Content-Type: audio/wav`。
2. **播放器**：會議詳情頁加 `<audio controls>`（source 指該端點）。
3. **逐字稿 ↔ 音訊連動**（D 的重點）：
   - 前端把當前顯示的逐字稿逐行解析出 `[HH:MM:SS]` → **經過秒數 offset**（`meeting_record.py` 的時間戳本就是距起點秒數，直接對應）。
   - **點某行逐字稿** → `audio.currentTime = 該行 offset`（跳到對應錄音位置）。
   - **播放時** → 依 `timeupdate` 找出「offset ≤ currentTime < 下一行 offset」的當前行 → 高亮該行、自動捲動至可視範圍（沿用會議逐字稿既有「黏底捲動」精神，但改成捲到高亮行）。
   - 對**原始／labeled／校正版**三種顯示皆生效（都保留同款 `[HH:MM:SS]` 前綴；MCR1 已要求校正保留時間戳）。
4. **相依**：無（`audio.wav` 既有；時間戳既有）。可獨立於 MCR1/2/3 完成。改 server.js + index.html → Deploy。

---

## 8. 端點總覽

| 端點 | Phase | 用途 |
|---|---|---|
| `POST /api/meeting/:id/correct` `{model}` | MCR1 | 啟動單一模型逐字稿校正（非同步，`meta.correction` 輪詢） |
| `GET /api/meeting/:id/transcript`（擴充 `corrected` 欄位） | MCR3 | 逐字稿 tail，新增校正稿內容供切換／彈窗 |
| `GET /api/meeting/:id/audio`（Range） | MCR4 | 串流 `audio.wav` 供回放＋seek |
| `POST /api/meeting/:id/summarize`（改逐字稿優先序） | MCR1 | 下游摘要優先吃 corrected |
| `GET /api/meeting/:id`（`meta.correction`） | MCR1/2/3 | 詳情含校正狀態，驅動 CTA 與切換鈕顯示 |

---

## 9. 任務分解（對應 `.worktable/TASK.md §MCR`）

四個第一級 phase，**各自獨立、各對一個手動 schedule**。建議執行順序：**MCR1 → MCR3 → MCR2 → MCR4**（校正產物先有、檢視才有內容切；產生入口的校正步驟依賴 MCR1；回放 MCR4 全獨立、任何時候可做）。

### MCR1 — 逐字稿校正（單一模型）
- `MTG-COR-01` 校正後端 `correctMeetingTranscript`：讀基底（labeled→raw）、分段＋overlap、單一模型逐段校正（只修辨識錯字、保留 `[HH:MM:SS]`＋語者標籤＋行對應）、寫 `transcript.corrected.txt`＋`meta.correction`；失敗段保留原文＋誠實 status。
- `MTG-COR-02` 端點 `POST /api/meeting/:id/correct`（in-flight 去重、回 runId、`resolveWorkspace`）；`GET /api/meeting/:id` 帶出 `meta.correction`。
- `MTG-COR-03` 下游接線：`summarize` 逐字稿優先序 corrected→labeled→raw。
- `MTG-COR-04` 自測＋部署：隔離埠 3399＋temp `HARNESS_HOME`＋明指真 venv；用一場真逐字稿校正（含長會議分段）→ 校正稿保留時間戳/行數、辨識錯字被修、原檔不動；摘要吃到校正版；`node --check`＋`Deploy_Harness.ps1` smoke。
- 🧑‍✈️ **指揮官手動驗證**（此關只由指揮官勾）

### MCR2 — 產生會議記錄入口（就地 CTA）
- `MTG-GEN-01` 停止即落詳情：`mtgStop()` 成功後 `mtgViewMeeting(id)`，停在詳情非只逐字稿。
- `MTG-GEN-02` 就地 CTA：詳情頁「有逐字稿、尚無摘要」時顯眼引導「①（可選）校正 → ② 選模型 → ③ 產生會議記錄」；點了才跑（校正非強制，B）。
- `MTG-GEN-03` 校正步驟入口接 MCR1（選模型 → `POST …/correct`、spinner、完成提示）；「選模型→產生」重用既有多模型摘要面板。MCR1 未落地時校正鈕優雅停用。
- `MTG-GEN-04` 自測＋部署：純前端；隔離埠驗停止後就地看到 CTA、跳過校正可直接產生、校正後產生吃校正版；`node --check`＋`Deploy_Harness.ps1` smoke。
- 🧑‍✈️ **指揮官手動驗證**（此關只由指揮官勾）

### MCR3 — 校正版檢視（原始／校正後，純檢視）
- `MTG-CVW-01` 端點：`GET /api/meeting/:id/transcript` 新增 `corrected` 欄位（讀 `transcript.corrected.txt`，無→null）。
- `MTG-CVW-02` 逐字稿區「原始／校正後」切換（`meta.correction.status='done'` 才顯）；兩版皆保留、可互切。
- `MTG-CVW-03` 「檢視校正版」全屏／彈窗完整查看整份校正稿（可捲動、逐字稿很長仍好讀）；不做 diff（C）。
- `MTG-CVW-04` 自測＋部署：純前端＋一端點欄位；隔離埠驗有校正版顯切換與彈窗、無校正版只顯原始不出切換；`node --check`＋`Deploy_Harness.ps1` smoke。
- 🧑‍✈️ **指揮官手動驗證**（此關只由指揮官勾）

### MCR4 — 錄音回放 + 逐字稿連動
- `MTG-PLAY-01` 端點 `GET /api/meeting/:id/audio`：serve `audio.wav`、支援 `Range`（206）、`resolveWorkspace`＋防穿越。
- `MTG-PLAY-02` 詳情頁 `<audio controls>` 播放器指該端點。
- `MTG-PLAY-03` 連動：解析逐字稿行 `[HH:MM:SS]`→offset；點行 seek、播放中高亮當前行＋自動捲動；原始／labeled／校正版皆生效。
- `MTG-PLAY-04` 自測＋部署：隔離埠驗回放可播/可拖曳、點行跳對位置、播放高亮跟著走；`node --check`＋`Deploy_Harness.ps1` smoke。
- 🧑‍✈️ **指揮官手動驗證**（此關只由指揮官勾）

---

## 10. DoD（驗收）

- [ ] MCR1：校正稿保留每行時間戳＋語者標籤、辨識錯字被修、語意未被改寫；原檔不動；摘要吃校正版；失敗段誠實保留原文。
- [ ] MCR2：停止錄製後就地看到「產生會議記錄」CTA；可跳過校正直接產生；也可先校正再產生。
- [ ] MCR3：能在原始／校正後間切換；能單獨全屏／彈窗完整查看校正版；逐字稿很長仍可讀。
- [ ] MCR4：能重聽錄音、可拖曳；點逐字稿某行跳到對應錄音位置；播放時當前行高亮並自動捲動。
- [ ] 🧑‍✈️ **指揮官手動驗證**（各 phase 各自一關，只由指揮官勾）。

---

## 11. 開放問題（遇到先採預設、記錄，勿卡住）
1. 校正分段大小／overlap 行數 → 先取「~120 行或 ~4000 字、overlap 5 行」，準度/斷裂不佳再調（常數化）。
2. 校正模型預設值 → UI 下拉預設帶一個高等模型（如 Opus）；使用者可改。
3. 校正稿若某行被模型漏掉／行數對不上 → 以原行補回（寧可少改、不可掉行），並在 `meta.correction` 標記該段有回退。

---

## Changelog
| Date | Version | Author | Description |
|:-----|:--------|:-------|:------------|
| 2026-07-22 | v1.0 | 老闆 + Hana(Opus) | 初版。四點優化拆成四個獨立 phase：MCR1 逐字稿校正（單一模型、只修辨識錯字、保留時間戳/語者標籤、另存 `transcript.corrected.txt` 原檔不動、下游摘要優先吃校正版）／MCR2 停止後就地「產生會議記錄」CTA（可選校正→選模型→產生、點了才跑）／MCR3 原始↔校正後切換＋全屏彈窗單獨查看（純檢視不做 diff）／MCR4 錄音回放 `GET /audio`（Range）＋逐字稿連動（點行 seek、播放高亮自動捲動）。指揮官拍板 A 單一模型／B 不強制校正／C 純檢視但可單獨查看／D 回放連動必做。最大重用：`meeting_record.py` 的 `[HH:MM:SS]` 經過秒數時間戳直接對應音檔位置、`audio.wav` 既有、`runModelsSequential`/`_spawnCliPrintOnce` 校正 N=1。四 phase 各對一個手動 schedule。 |

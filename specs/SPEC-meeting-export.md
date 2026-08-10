# SPEC — AI 會議記錄匯出（Word / PDF，可選模型版本）

> **Status**: Draft v1.0 ｜ **Owner**: 老闆 + Hana(Opus) ｜ **Date**: 2026-07-16
> **Relates**: `SPEC-meeting-summary.md`（多模型摘要，上游、提供 `summary.<modelKey>.md`＋P3 `keypoints.<modelKey>.md`）、`SPEC-meeting-import.md`（會議來源）、`SPEC-doc-fidelity-export.md`（PDF 列印管線 `@page` 幾何 FX-A）
> **相依（2026-07-16 更新）**：本匯出的「三分項」組成（摘要／會議重點／待辦）依 `SPEC-meeting-summary.md` §Q **P3**。P3 尚未開工，故此處**零返工**：組裝器直接照三分項寫；若 P3 未落地（無 `keypoints.*`），**回退**沿用 `summary.md` 內【重點】段，匯出照樣可用。建議 §Q P3 先於或同 MEX 落地。
> **開源**：隨公開版出貨。

---

## 1. 動機

會議記錄（逐字稿 + 多模型摘要 + 待辦）目前只能在 portal 內看，**無法交付**。指揮官要能把一場會議匯出成 **Word 或 PDF** 拿去用。

關鍵需求（指揮官 2026-07-16）：一場會議的摘要**可由多個模型各出一版**（`SPEC-meeting-summary` 已落地 `summary.<modelKey>.md`），匯出時要能**決定匯出哪一份**——收尾版、某個模型版、或**每一種模型的產出都匯出**。

---

## 2. 設計決策

| # | 決策 | 理由 |
|---|---|---|
| D1 | **最大重用、不造新引擎**：Word 走既有 `md-to-docx.py`（同 `/api/doc/export-docx`）；PDF 走既有 Playwright `page.pdf` 列印管線（FX-A 的動態 `@page` 幾何 + `preferCSSPageSize`） | 這功能本質是「組裝 + 接線」，兩條匯出引擎都現成、已驗證 |
| D2 | **選版直接對應硬碟現有檔**，不新增資料 | 收尾版＝`summary.md`；各模型版＝`summary.<modelKey>.md`；選單來源＝`meta.summary.versions[]`（皆既有） |
| D3 | 匯出＝**唯讀組裝，不動真身**；輸出寫該會議目錄 `exports/` | 天條：產出留在該工作區；摘要/逐字稿/actions 皆不被改 |
| D4 | 「**全部模型**」預設＝**一份合併檔**（各模型一節，標品牌 + 時間） | 一個檔最好帶走、好並排比較；zip 留開放決策 MEX-D1 |
| D5 | 匯出內容＝**標題頁 + 摘要（選定版）+ 待辦表（選配，預設含）+ 逐字稿（選配，預設不含）** | 逐字稿常很長，預設不塞；由使用者勾 |

---

## 3. 匯出檔組成（配合 §Q P3 三分項）

一份匯出檔 =
1. **標題頁**：會議標題、日期時間、與會者（`meta.speakers`）、時長。
2. **摘要** overview：選定版本的 `summary(.<modelKey>).md`。
3. **會議重點** keypoints：選定版本的 `keypoints(.<modelKey>).md`（P3 新分項）。〔**回退**：舊會議無 `keypoints.*` → 沿用 `summary.md` 內【重點】段，不另生。〕
4. **待辦表**（選配，預設含）：讀對應的 `actions(.<modelKey>).json` → GFM 表格。
5. **逐字稿**（選配，預設不含）：`transcript.labeled.txt` 優先、退回 `transcript.txt`。

`selection='all'` 時：**每個模型一節**（節標題標「**模型品牌 · 產生時間**」），節內含該模型的摘要＋重點＋待辦。`selection='final'`＝三分項收尾版（`summary.md`＋`keypoints.md`＋`actions.json`），即指揮官「彙整成一版」的結果。

以上先組成**一份 markdown**，再交給對應引擎產 docx / pdf——兩種格式共用同一份組裝結果，只差最後一步引擎。

---

## 4. 資料模型（重用，零遷移）
```
<workspace>/.harness/runtime/meetings/<id>/
  meta.json → { title, speakers, summary:{ versions:[{model, file, generatedAt, parts?}], … } }   # 選單來源（既有）
  summary.md / summary.<modelKey>.md               # 摘要：收尾版 / 各模型版（既有）
  keypoints.md / keypoints.<modelKey>.md           # 會議重點：收尾版 / 各模型版（§Q P3 新；缺→回退 summary 內【重點】）
  actions.json / actions.<modelKey>.json           # 待辦：收尾版 / 各模型版（既有）
  transcript.labeled.txt / transcript.txt          # 逐字稿（既有）
  exports/<會議標題>_<版本標籤>_<YYYYMMDD>.docx|pdf   # 新輸出（唯讀衍生物，可重產）
```

---

## 5. 端點

`POST /api/meeting/:id/export`
```jsonc
{
  "format": "docx" | "pdf",
  "selection": "final" | "<modelKey>" | "all",   // final=summary.md；<modelKey>=某模型版；all=全部模型合併
  "include": { "actions": true, "transcript": false }
}
```
→ 產檔寫入該會議 `exports/`，並以 `Content-Disposition` 回檔下載（比照 `export-docx` / `export-pdf-fidelity`）。工作區隔離走 `resolveWorkspace(req)`；路徑防穿越。

---

## 6. 落地觸點

- **server.js**：
  - `assembleMeetingMarkdown(meetingDir, {selection, include})` — 依 §3 組出一份 markdown：標題頁＋**摘要**＋**會議重點**（`keypoints(.<key>).md`，缺→回退 `summary.md` 內【重點】段）＋待辦表＋逐字稿。`selection='all'` 讀 `meta.summary.versions[]` 逐版拼節（每節含該模型三分項）；`selection='final'` 讀三分項收尾版。
  - `POST /api/meeting/:id/export`：`format=docx` → 暫存 md → 呼 `md-to-docx.py` → 輸出 `exports/` + 下載；`format=pdf` → 走列印 bootstrap → Playwright `page.pdf` → 輸出 `exports/` + 下載。
- **index.html**：會議詳情加「**匯出**」鈕 → 選單＝格式（Word / PDF）＋版本（收尾版 / 各模型版逐一 / **全部模型**）＋選配（含待辦 / 含逐字稿）→ 送出下載。版本選單讀 `meta.summary.versions[]`。
- **PDF 列印**：新增 `?print=meeting&id=<id>&…` bootstrap（把組裝 markdown→HTML 渲進列印根，量測後動態注入 `@page` 幾何、`page.pdf({preferCSSPageSize:true})`，**沿用 FX-A 已驗證的方向不被 Chromium 互換的解法**）。〔**「怎麼做」由 Hana 於實作時決定**；優先重用現成 Playwright 管線，不引新依賴。〕

**部署**：改 server.js + index.html（+ 可能一支輕量組裝/列印輔助）→ **需 Deploy**（走 `Deploy_Harness.ps1`，冒煙 + 回滾）；git 由人類掌控。

---

## 7. 任務分解（對應 `.worktable/TASK.md §MEX`）

### MEX1 — 匯出核心
- `MTG-EXP-01` 組裝器 `assembleMeetingMarkdown`：標題頁 + 摘要（selection 解析成要讀的 summary 檔；`all`→逐版拼節標品牌+時間）+ 待辦表（選配）+ 逐字稿（選配）。
- `MTG-EXP-02` Word 匯出：`POST /api/meeting/:id/export`（`format=docx`）→ 暫存 md → `md-to-docx.py` → `exports/` + 下載。
- `MTG-EXP-03` PDF 匯出：同端點（`format=pdf`）→ 新 `?print=meeting` 列印 bootstrap → Playwright `page.pdf`（FX-A `@page` 幾何）→ `exports/` + 下載。
- `MTG-EXP-04` 前端 UI：會議詳情「匯出」鈕 → 格式 + 版本（收尾/各模型/全部）+ 選配（待辦/逐字稿）→ 下載；版本選單讀 `meta.summary.versions[]`。
- `MTG-EXP-05` 自測 + Deploy：隔離埠 3399 + temp `HARNESS_HOME` + 明指真 venv；docx/pdf × {收尾版、某模型版、全部} 各匯一次、開檔目視；`node --check` + `py_compile` + `Deploy_Harness.ps1` smoke。
- 🧑‍✈️ **指揮官手動驗證**（此關只由指揮官勾）

---

## 8. 開放決策（等指揮官拍板）

- `MEX-D1` 「**全部模型**」= 一份合併檔（各模型一節）還是 **N 個獨立檔打包 zip**？（**預設：一份合併檔**）
- `MEX-D2` 匯出**預設內容**：摘要必含；**待辦（actions）預設含**、**逐字稿預設不含**（皆可勾）。這樣可以嗎？
- `MEX-D3` **檔名慣例** `<會議標題>_<版本標籤>_<YYYYMMDD>.docx|pdf`（版本標籤＝`final`／模型名／`all`）可以嗎？
- `MEX-D4` **PDF 版式**：簡潔報告版式（無品牌）即可，還是要帶品牌頁首頁尾（如「Hana 特助辦公室」）？（**預設：簡潔報告版式**）

---

## Changelog
| Date | Version | Author | Description |
|:-----|:--------|:-------|:------------|
| 2026-07-16 | v1.0 | 老闆 + Hana(Opus) | 初版。會議記錄匯出 Word/PDF，可選匯出哪一模型版本（收尾/某模型/全部合併）。最大重用：Word=`md-to-docx.py`、PDF=既有 Playwright `page.pdf`（FX-A `@page`）；選版對應硬碟現有 `summary.<modelKey>.md`＋`meta.summary.versions[]`；唯讀組裝寫 `exports/`、不動真身。單一 phase MEX1 + 4 個開放決策待拍板。 |
| 2026-07-16 | v1.1 | 老闆 + Hana(Opus) | 配合 §Q P3「三分項」：匯出組成由「摘要（含重點）＋待辦」改為**摘要＋會議重點＋待辦**三節（§3/§4/§6）；`selection='all'` 每模型節含三分項、`final'`＝三分項收尾版。MEX 尚未開工故零返工；P3 未落地時回退用 `summary.md` 內【重點】段，匯出仍可用。 |

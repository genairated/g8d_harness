# SPEC — 會議匯入（Meeting Import：音檔／字幕 → 會議記錄分析）

> Status: Draft v1.0 ｜ 開源（隨公開版出貨）
> 關聯：[[SPEC-meeting-transcriber]]（錄製→逐字稿）、[[SPEC-meeting-summary]]（MTG-SUM 多模型摘要）、[[SPEC-setup]]（§13 依賴完整性鐵律）

## 0. 目的

Hana 目前的 AI 會議功能只能「即時錄製」（含電腦音訊 loopback）→ 地端 STT → 分析。本規格新增一條**匯入**路徑：讓使用者把**既有的音檔（mp3 / mp4）或字幕（vtt / srt）**丟進來，一樣產出會議記錄與多模型摘要。

因為 Hana 是**本地端**助理，檔案取得方式同時支援：
1. **HTTP 上傳**（portal 會議頁的「匯入」鈕，multipart）——小檔方便。
2. **本地路徑**（填絕對路徑，server 直接讀）——大 mp4 免上傳。

## 1. 核心原則：最大重用，最少新碼

匯入的產物只要是一個**標準 meeting 目錄**，現有機制就會自動接手。現況（已探勘確認）：

- 會議實體：`<workspace>/.harness/runtime/meetings/<meetingId>/`，含 `meta.json` + `transcript.txt`（格式 `[HH:MM:SS] 文字\n`）。
- `stt.py` 已有 **`transcribe_file(audio_path, lang, model_size, ...)`**：底層 `faster_whisper` 用 **PyAV 解碼**，**本來就吃檔案路徑**，mp3、mp4 都能直接丟（PyAV 自動抽 mp4 音軌），**不需要另裝 ffmpeg**。
- `server.js` 的 **`finalizeMeetingSummary(meetingId, meetingDir, wctx)`**（`portal/server.js:3143`）＋ **MTG-SUM-04 lazy backfill**（`:3486`「transcript 存在但沒 summary.md → 自動跑摘要」）會自動完成多模型摘要。
- 會議列表／逐字稿／摘要 UI 皆讀該目錄——匯入的會議天生就能顯示。

→ 所以本功能 = 「生一個含 `transcript.txt` 的 meeting 目錄 + 觸發 finalize」，**分析零新碼**。

## 2. 依賴檢查（SPEC-setup §13 鐵律）

| 格式 | 需要的東西 | 是否新增人工安裝依賴 |
|:--|:--|:--|
| mp3 / mp4 | 現成 `faster_whisper`（PyAV 隨附）＋ GPU STT | ❌ 無（STT 裝好就會） |
| vtt / srt | 純 Python 解析 | ❌ 零依賴、不用 GPU |

**結論：不新增任何要人工安裝的依賴，`/setup` 不需改。**（僅若未來要支援冷門編碼才需 ffmpeg，屆時才依 §13 註冊；v1 不做。）

## 3. 匯入流程（新端點）

### 3.1 `POST /api/meeting/import`
兩種輸入擇一：
- **multipart 上傳**：欄位 `file`（mp3/mp4/vtt/srt）＋ 選填 `title`、`lang`、`model`。
- **JSON `{ path, title?, lang?, model? }`**：`path` 為 server 可讀的本地絕對路徑。

處理：
1. 依副檔名判類型（audio: `.mp3/.mp4/.m4a/.wav`；subtitle: `.vtt/.srt`），不認得 → `400`。
2. 上傳檔存到暫存（`meetingDir/source.<ext>`）；本地路徑則直接讀（**不複製大檔到別處，只讀**）。
3. 建 meetingDir（同 `/api/meeting/start` 慣例）：`meetingId = 'meeting_' + Date.now()`，寫 `meta.json`（`source: 'import'`、`origin: <原始檔名或路徑>`、`title`、`createdAt`、`status: 'importing'`）。
4. 依類型產 `transcript.txt`（見 §4／§5）。
5. 完成後 `meta.status = 'done'`，呼叫既有 `finalizeMeetingSummary(meetingId, meetingDir, wctx)`（**完全重用**）。
6. 回 `{ ok:true, meetingId }`；前端導到該會議詳情（摘要由 lazy-backfill/finalize 產出）。

### 3.2 大檔非同步
STT 大檔可能數分鐘。端點採「先建目錄回 `meetingId`、背景轉錄」；`meta.status`（`importing`→`transcribing`→`summarizing`→`done`／`error`）供前端輪詢，比照現有錄製中 tail 的作法。

## 4. 音檔路徑（mp3 / mp4）→ transcript.txt

新增一支 STT CLI 包裝（比照 `stt.py` 既有模式，走 venv）：
- 呼叫現成 `transcribe_file(path, lang, model_size)`，拿回帶時間戳的 segments。
- **輸出格式必須與 `meeting_record.py` 一致**：`[HH:MM:SS] 文字\n`（`fmt_ts(seconds)` 同款），逐段 append + flush，確保與現有逐字稿 UI／摘要 prompt 相容。
- 繁中沿用 `stt.py` 既有 OpenCC 轉繁 + `DEFAULT_PUNCT_PROMPT_ZH`。
- mp4 直接丟路徑給 `transcribe_file`（PyAV 抽音軌）；不需先抽 wav。

## 5. 字幕路徑（vtt / srt）→ transcript.txt

新增純 Python 解析（零依賴）：
- 解析 cue：起始時間 + 文字（vtt `WEBVTT`/`HH:MM:SS.mmm --> ...`；srt 序號 + `HH:MM:SS,mmm --> ...`）。
- 若含 speaker/`<v 名字>` 標記，保留為前綴（利於後續 diarize 對齊；無則略）。
- 每 cue 轉成 `[HH:MM:SS] 文字\n`（時間戳取 cue 起始、去毫秒），連續同秒可合併。
- 去除 vtt 樣式標籤（`<c>`、`<00:00:00.000>` inline timing 等），只留純文字。
- **不經 STT、不用 GPU、秒完成。**

## 6. UI

會議頁（`portal/index.html` 會議面板）新增「**匯入**」鈕：
- 檔案選擇（accept `.mp3,.mp4,.m4a,.wav,.vtt,.srt`）→ multipart 上傳。
- 或「本地路徑」輸入框（大檔）→ JSON 送 `path`。
- 送出後顯示 `meta.status` 進度（轉錄中／摘要中），完成導到會議詳情。
- 選填：語言、STT 模型大小（沿用現有錄製設定的選項）。

## 7. 邊界與安全

- 副檔名／MIME 白名單；非白名單一律 `400`，不試圖解碼未知格式。
- 本地路徑模式：僅讀、不寫回原檔、不刪原檔；路徑走 workspace 感知（`wctx`），比照現有端點。
- 上傳大小上限（建議可設，預設寬鬆，因本地端）。
- 匯入的會議與錄製的會議在列表中可辨識來源（`meta.source: 'import'` + `origin`）。

## 8. 部署註記

本功能改到 **`server.js`（新端點）+ `index.html`（UI）** → **需要 Deploy**（走 `Deploy_Harness.ps1`），與 FB 那批「standalone 模組免 Deploy」不同。STT CLI 包裝與字幕 parser 為新檔（render-service 下）。

## 9. 驗收（AC）

1. 匯入一個 **mp3** → 產生 meeting 目錄、`transcript.txt` 格式正確、自動出現多模型摘要。
2. 匯入一個 **mp4** → 音軌被 PyAV 正確抽出轉錄（無需 ffmpeg），流程同上。
3. 匯入一個 **vtt** 與一個 **srt** → 不經 STT，秒轉出 `transcript.txt`、摘要正常。
4. 本地路徑模式與 HTTP 上傳模式皆可用；大檔（>30 分鐘）不阻塞 UI（背景轉錄 + status 輪詢）。
5. `/setup` 無需新增項目（確認未引入人工安裝依賴）。
6. `node --check` + Deploy smoke 通過。

## 10. 任務對照（見 `.worktable/TASK.md` §V）

| Task | 內容 |
|:--|:--|
| MTG-IMP-01 | 字幕 parser（vtt/srt → transcript.txt），零依賴、單測 |
| MTG-IMP-02 | STT CLI 包裝（音檔→transcript.txt，重用 `transcribe_file`，格式對齊 meeting_record） |
| MTG-IMP-03 | `POST /api/meeting/import` 端點（上傳＋本地路徑、建目錄、分派、觸發 finalize、status 輪詢） |
| MTG-IMP-04 | 會議頁「匯入」UI |
| MTG-IMP-05 | 端到端驗證（mp3/mp4/vtt/srt 各一）＋ Deploy；確認 /setup 免動 |

---

## 11. 逐字稿文件匯入（docx / txt）：樣板解析 + 預覽確認（v1.1，Charles 2026-09-30 拍板）

### 11.1 設計原則

`.docx` 與 `.txt` 沒有國際標準格式，各家會議軟體匯出長相不同。**不靠自動猜測默默解析**，改為「**選樣板 → 腳本解析 → 彈窗預覽前 5~10 段 → 人眼確認**」。判斷權在指揮官，腳本只負責解析與呈現。

核心觀察：**樣板綁的是「文字排列格式」，不是副檔名。** 同一份 Teams 逐字稿另存成 `.txt`，格式完全一樣 → 同一個 Teams 樣板照樣解得出來。故 docx 與 txt **共用同一組樣板**，差別只在前置的「取出純文字」那一步。

### 11.2 樣板定義

樣板存於 `global-knowledge/transcript-templates/<id>.json`（跨工作區共用，新學到的樣板全域受益）：

```json
{
  "id": "teams",
  "name": "Microsoft Teams 逐字稿匯出",
  "blockPattern": "^(?<speaker>.+?)\s+(?<time>\d{1,2}:\d{2}(:\d{2})?)\n(?<text>.+)$",
  "blockSplit": "blank-line",
  "timeFormat": "mm:ss|hh:mm:ss",
  "sample": "王小明 0:12\n大家早，我們開始。",
  "createdBy": "builtin"
}
```

- **v1 內建樣板**：`teams`（依指揮官提供的真實 Teams `.docx` 制定）。其他會議軟體樣板由 §11.5「樣板解析」現場產生後沉澱。
- 樣板為**純資料**（`.json`），新增樣板**不需 Deploy**。

### 11.3 匯入流程（docx / txt）

1. 使用者於會議頁選檔（`.docx` / `.txt`）。
2. 選檔後**立即開啟「逐字稿預覽」彈窗（modal）**。左側列表與右側會議內容區都不放預覽，避免擠壓既有版面；預覽本來就是「看完就關」的一次性決策，彈窗最貼近實際使用情境。彈窗內含：樣板下拉（預設 `teams`；另有「**不套用樣板**」）、預覽表格、命中率、動作按鈕（確認匯入／樣板解析／直接產生摘要／取消）。
3. `POST /api/meeting/transcript-preview`（multipart 或 `{path}` + `templateId`）：
   - `.docx` → 以既有 venv 的 `python-docx` 取出段落純文字（**已安裝，零新依賴**）；`.txt` → 直接讀（自動偵測 UTF-8 / UTF-8-BOM / Big5）。
   - 依樣板切段、逐段套 `blockPattern`。
   - 回 `{ ok, total, matched, matchRate, rows:[{speaker,time,text}] (前 10 筆), warnings }`。
4. 彈窗內顯示**預覽表格**（三欄：講者／時間／內容，最多 10 列）＋ 命中率（如「352 段中解析成功 348 段（98.9%）」）。切換樣板下拉即重新呼叫預覽端點、就地刷新表格，不關窗。
5. 指揮官在彈窗按「確認匯入」→ `POST /api/meeting/import` 帶 `templateId` 正式匯入，產出 `transcript.txt`（格式 `[HH:MM:SS] 講者：文字`，與 §4／§5 對齊）→ 走既有 `finalizeMeetingSummary`。

### 11.4 解析失敗就是失敗（不偷偷降級）

命中率低於門檻（**建議 60%**）或 0 段命中 → 預覽區顯示「**此樣板解析失敗**」＋ 前 20 行原始文字，讓指揮官看出檔案長什麼樣。**不自動 fallback**，由指揮官從以下三條路擇一：

- 換一個樣板重試；
- 按「**樣板解析**」學新樣板（§11.5）；
- 按「**直接產生摘要**」（§11.6）。

### 11.5 「樣板解析」按鈕 → 產生新樣板並立即套用

> **命名決策（Charles 2026-09-30）**：按鈕文字為「**樣板解析**」，不叫「AI 解析」。理由：使用者關心的是「產生一個新樣板來解析這份檔案」這件事，AI 只是實作手段，不該出現在介面文案。

`POST /api/meeting/transcript-learn`（`{ text (前 N 行), name? }`）：

- 送一段樣本給模型，要求回傳 §11.2 的樣板 JSON（regex + 切段規則 + 建議名稱）。
- 後端**先自行套用該樣板驗證**：命中率 ≥60% 才寫入 `global-knowledge/transcript-templates/`，否則回失敗、不落檔（避免存進壞樣板）。
- **成功後立即套用**：後端回傳新樣板 id + 用該樣板跑出的預覽結果；前端把樣板下拉自動切到新樣板、並就地刷新彈窗內的預覽表格，**不需使用者再手動選一次**。
- **一種新格式只付一次 AI 成本**，之後同源檔案走純腳本。

### 11.6 「直接產生摘要」按鈕

完全不套樣板：取出純文字 → 整份原樣寫入 `transcript.txt`（不加時間戳、不切講者）→ 照常觸發摘要。**保底路徑：任何文字檔都不會匯入失敗**，代價是摘要中沒有「誰說了什麼」的標註。

### 11.7 明確不做（v1）

- 不做自動樣板偵測（不掃全部樣板挑最高分）——**指揮官選、預覽確認**已足夠且不會誤判。
- 不做 `.doc`（舊版二進位）、不做 PDF。
- **不對內容做簡繁轉換**（Charles 2026-09-30 拍板：保留原文，看得懂中文的人簡繁都讀得懂）。但**摘要階段須能同時理解簡體與繁體**，且輸出一律正體中文（見 §11.9）。
- 不做樣板管理 UI（新增靠 AI 解析、刪改直接改 json 檔）。

### 11.8 部署註記

新增端點在 `server.js`、預覽 UI 在會議頁前端 → **需要 Deploy**。樣板 `.json` 為純資料，新增／修改**免 Deploy**。

### 11.9 簡繁處理（已拍板，不轉換）

- **原文不動**：`transcript.txt` 保留檔案原本的簡／繁字形，不做 OpenCC 轉換。實務上同一份檔常見標題簡體、內文繁體（指揮官提供的 Teams 檔即為此例），混排不影響閱讀。
- **摘要階段須簡繁通吃**：`finalizeMeetingSummary` 的摘要提示詞需明確指示「來源逐字稿可能簡繁混排，須一併理解；**摘要輸出一律使用正體中文**」，避免模型把簡體段落當成雜訊略過、或把簡體字帶進摘要。
- 不另外做簡繁偵測或轉換工具。

### 11.10 驗收（AC 增補）

7. 以指揮官提供的真實 Teams `.docx` 匯入 → 選 `teams` 樣板 → 預覽表格正確顯示前 10 段的講者／時間／內容，命中率 ≥95%。
8. 將同一份內容另存為 `.txt` → 同一個 `teams` 樣板解析結果與 §7 一致。
9. 以一份格式不符的檔案 → 預覽顯示「解析失敗」＋原始文字片段，**不自動降級**。
10. 對該失敗檔按「**樣板解析**」→ 產生新樣板並落檔，**彈窗內樣板下拉自動切到新樣板且預覽表格立即刷新為成功結果**；再匯入同格式檔案時該樣板可直接選用（不再呼叫 AI）。
11. 對純文字檔按「直接產生摘要」→ 不套樣板、摘要正常產出。
12. 匯入簡繁混排的逐字稿 → `transcript.txt` 保留原字形未被轉換，且產出的摘要為正體中文、內容涵蓋簡體段落的資訊。

### 11.11 任務對照（見 `.worktable/TASK.md` §MTGT）

| Task | 內容 |
|:--|:--|
| MTGT-1 | 樣板資料格式 + 內建 `teams` 樣板（依真實 docx 制定）+ 解析器（docx/txt 取文字、切段、套 regex、算命中率） |
| MTGT-2 | `POST /api/meeting/transcript-preview` 端點 |
| MTGT-3 | 會議頁：**預覽彈窗**（選樣板 + 預覽表格，含失敗態、原始文字片段） |
| MTGT-4 | 「樣板解析」端點 + 樣板落檔驗證 + 產生後立即套用刷新 |
| MTGT-5 | 「直接產生摘要」路徑 + 正式匯入串接 `finalizeMeetingSummary` |
| MTGT-6 | 端到端驗證（Teams docx／同內容 txt／失敗檔／AI 學樣板／純文字）＋ Deploy |

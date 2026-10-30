# SPEC — Presentation Export（保真 pptx 匯出）

> Status: DRAFT ｜ Owner: 老闆 + Hana ｜ 影響範圍：`portal/server.js`、`portal/render-service/`、`presentations/exports/`
> 目的：用無頭瀏覽器把 presentation-core deck 的每張投影片截成高解析 PNG，再用 PptxGenJS 組成保真 pptx，每頁是圖（無法編輯，但像素級一致）、旁白逐字稿存入備忘稿。

---

## 1. 設計原則

- **保真優先**：pptx 是衍生檔，不是主格式——每頁一張圖、像網頁一模一樣、不做可編輯版。可編輯版屬 Phase 3，本 SPEC 不涵蓋。
- **共用底層**：無頭瀏覽器（render service）同時支援 pptx 截圖、未來錄影（Phase 2）與 PDF 匯出，不要各自起各自的 headless 實例。
- **Portal 內建**：render service 整合進 `portal/` 生態系，不獨立部署，複用 `HARNESS_HOME` 環境變數與現有 server lifecycle。

---

## 2. 無頭引擎選型

| | Playwright | Puppeteer |
|---|---|---|
| **語言/生態** | Node，多瀏覽器（Chromium/Firefox/WebKit） | Node，主 Chromium |
| **截圖品質** | `page.screenshot({ type: 'png', fullPage: false })` | 同 |
| **錄影支援** | ✅ `page.video()` 原生錄影（Phase 2 預備） | ❌ 需外掛或 CDP |
| **套件體積** | 較大（含多瀏覽器 binary，可只裝 Chromium） | 較小 |
| **維護狀態** | Microsoft 維護，活躍 | Google 維護，活躍 |

**決策：選 Playwright**。主因是 Phase 2 錄影需求——Playwright 有原生錄影 API（`context.newPage()` + `recordVideo`），避免未來再引入第二套無頭套件。安裝時只下載 Chromium 以控制體積：

```bash
npm install playwright
npx playwright install chromium
```

---

## 3. Render Service 位置

```
portal/
  render-service/
    index.js          ← getBrowser() / getPage() / closeBrowser() 單例
    screenshot.js     ← slidesToPngs(deckUrl, opts) → [{ index, pngBuffer, transcript }]
    recorder.js       ← 待 Phase 2（錄影 + wav 合成）
```

- **單例 browser**：`getBrowser()` 懶啟動；`closeBrowser()` 掛在 `process.on('exit')` 清理。
- **整合點**：`portal/server.js` 在匯出 API handler 中 `require('./render-service/screenshot')`，不需獨立 process。

---

## 4. 截圖流程（`screenshot.js`）

### 4.1 輸入

```js
slidesToPngs(deckUrl, { width: 1920, height: 1080, waitMs: 300 })
```

- `deckUrl`：`http://localhost:<PORT>/raw?path=presentations/<deck>.html`（raw 模式，server 注入 core + overlay）
- `width/height`：預設 1920×1080
- `waitMs`：每頁截圖前等待 CSS transition 完成（預設 300 ms）

### 4.2 流程

```
1. page.goto(deckUrl, { waitUntil: 'networkidle' })
2. 等 #viewport[data-core-init] 出現（core 初始化完成）
3. 讀取 slides = page.$$('.slide')，取得總頁數 N
4. for i in 0..N-1:
   a. page.evaluate( 把第 i 張設為 active、其餘移除 active )
   b. await page.waitForTimeout(waitMs)
   c. pngBuffer = await page.screenshot({ clip: { x:0, y:0, width:1920, height:1080 } })
   d. transcript = await page.$eval('.slide.active', el => el.dataset.transcript || '')
   e. results.push({ index: i, pngBuffer, transcript })
5. return results
```

**重點**：
- 截圖時隱藏 core 注入的播放外殼（progress bar / footer / drawer），只保留 `#viewport` 內容。在 `evaluate` 步驟加 `document.body.classList.add('exporting')` 並在 `core.css` 補 `.exporting .core-shell { display:none }` 即可。
- deck 頁面不播 TTS（`data-autoplay` 不觸發）——raw 模式本就無自動播放需使用者手勢，無頭環境沒手勢故不觸發。

### 4.3 PRES-CUE 頁（2026-10-23）

- 有 `data-cues` 的頁：設為 active 後呼叫 `window.__presCore.finalizeSlide(i)`，截「**全部 cue 執行完**」的最終畫面（數字到終值、線條畫完、輪播停在最後一個 cue 指定的那張、時間軸到最後一格）；**雷射筆不畫**（`body.exporting:not(.export-keep-laser) .cue-laser{display:none}`）。
- 備忘稿：優先 `data-transcript`；沒有時把各 cue 的 `say` 串起來，確保備忘稿是全文。
- 沒有 `data-cues` 的頁：流程與以前完全相同。

---

## 5. PptxGenJS 流程（`export.js`）

### 5.1 依賴

```bash
npm install pptxgenjs
```

### 5.2 流程

```js
const pptx = new PptxGenJS();
pptx.layout = 'LAYOUT_16x9';  // 13.33" × 7.5"

for (const { index, pngBuffer, transcript } of slides) {
  const slide = pptx.addSlide();

  // 滿版圖（保真）
  slide.addImage({
    data: `data:image/png;base64,${pngBuffer.toString('base64')}`,
    x: 0, y: 0, w: '100%', h: '100%',
  });

  // 備忘稿（逐字稿）
  if (transcript) {
    slide.addNotes(transcript);
  }
}

const outputPath = path.join(HARNESS_HOME, 'presentations/exports', `${deckName}.pptx`);
await pptx.writeFile({ fileName: outputPath });
return outputPath;
```

### 5.3 命名規則

- `deckName` 取自 deck HTML 檔名（去 `.html`），例：`presentation-hana-episode1-v2`。
- 輸出目錄：`presentations/exports/`（相對 `HARNESS_HOME`）；目錄不存在時自動建立。

---

## 6. API Endpoint

```
POST /api/presentations/:name/export
```

### Request

```json
{ "format": "pptx" }
```

`:name` 為 deck 檔名（不含副檔名），如 `presentation-hana-episode1-v2`。

### Response（成功）

```json
{
  "ok": true,
  "path": "presentations/exports/presentation-hana-episode1-v2.pptx",
  "slides": 12
}
```

### Response（失敗）

```json
{ "ok": false, "error": "..." }
```

### 簡報根目錄（PXW，2026-10-23）

- **簡報根目錄＝當前工作區**（`X-Workspace` 標頭，或 `?workspace=` 查詢參數）；該工作區 `presentations/<name>.html` 不存在時，**才退回 `HARNESS_HOME/presentations`**。兩處都沒有 → 404，錯誤訊息點名找過的兩個完整路徑（`tried` 陣列）。實作：`server.js` 的 `locateDeck(req, name, suffix)`。
- 同一套解析用於：`POST /api/presentations/:name/export`、`POST /api/presentations/:name/record`、`GET /api/block-decks`（列「工作區＋Harness home」聯集、同名以工作區為準）、`POST /api/block-decks/:name/export`（`suffix='.blocks.json'`，圖片相對路徑也以命中的根目錄解析）。
- 傳給 `/raw` 的 `workspace=` 一律是**實際命中**的那個根目錄。
- 語音設定 `loadVoiceConfig(HARNESS_HOME)` 刻意**不隨工作區**（全域語音設定）。
- `GET /api/presentations/exports/<file>`：`<video>`／`<track>` 無法帶標頭，前端在網址加 `?workspace=`；有帶就先從該工作區的 `presentations/exports` 取檔，找不到或沒帶 → 退回 `HARNESS_HOME/presentations/exports`（原行為）。防穿越檢查（檔名不得含路徑分隔、`isPathSafe`）不變。

### 流程

```
1. 依上述規則找到 presentations/<name>.html（否則 404，列出找過的路徑）
2. 呼叫 slidesToPngs(url)
3. 呼叫 buildPptx(slides, name)
4. 回傳 path + slide 數
```

---

## 7. Portal 前端匯出入口

在 portal 簡報列表（`/`）每個 deck 卡片加一個「匯出 pptx」按鈕：

```
[▶ 播放]  [↓ 匯出 pptx]
```

- 點擊後 `POST /api/presentations/:name/export`；顯示 loading 狀態。
- 成功後顯示「已匯出：presentations/exports/xxx.pptx」並提供下載連結（`GET /raw?path=presentations/exports/xxx.pptx`）。
- 失敗顯示錯誤訊息（常見：deck 未轉成 core 架構、port 被佔用）。

---

## 8. 輸出路徑

```
<命中的簡報根目錄>/            ← 當前工作區；deck 不在工作區時才是 $HARNESS_HOME
  presentations/
    exports/
      <deckName>.pptx      ← 保真 pptx（每頁一圖）
      <deckName>.mp4/.vtt  ← 錄影＋字幕
      <deckName>-editable.pptx ← block deck 可編輯版
```

- 匯出檔一律存回 **deck 所在的那個根目錄**的 `presentations/exports/`——客戶專案的簡報匯出就落在客戶專案自己的資料夾，不會跑到 Harness 底下。API 回傳的 `path` 是相對該根目錄的路徑，前端下載連結同時帶 `&workspace=`。

- `exports/` 目錄由 export API handler 自動 `mkdir -p`。
- `/raw` endpoint 已支援靜態檔服務，無需額外設定即可下載。

---

## 9. Phase 2 延伸接點（錄影 + 旁白 wav）

本 SPEC 只做 Phase 1（pptx 截圖）。Phase 2 延伸：

| 接點 | Phase 1 預留 | Phase 2 實作 |
|---|---|---|
| Render service 單例 | `getBrowser()` 單例已建 | 同一 browser 實例供錄影用 |
| `recorder.js` | 空殼佔位 | Playwright `recordVideo` + ffmpeg 合成旁白 wav |
| 逐字稿 | 已從 `data-transcript` 取得並存 pptx 備忘稿 | 送離線/雲端 TTS 轉 wav，再嵌進 pptx / 合成影片 |
| API | `POST /api/presentations/:name/export` | 加 `"format": "video"` 分支 |
| 輸出目錄 | `presentations/exports/` | 同目錄加 `.mp4` / `.wav` |

### 9.1 錄影（mp4）的 cue 時序（PRES-CUE，2026-10-23）

- 錄影改以「**片段**」為單位（`screenshot.slidesToSegments`）：沒有 cue 的頁＝一個片段（整段 `data-transcript`，與以前相同）；有 cue 的頁＝**每個 cue 一個片段**：畫面是「做完該 cue 動作的當下」（`__presCore.cueState(i,k)`，含雷射筆），聲音是該 cue 的 `say`，片段長度＝語音實長＋0.4 秒＋該 cue 的 `pause`（用 `apad` 補靜音），所以 **cue 順序與停頓會照實出現在影片裡**。字幕（vtt）也按片段切。
- **做不到、照實記待辦**：片段內是**靜態畫面**——數字滾動、線條逐段畫出、滑桿移動、雷射筆脈動這類「動作過程」不會出現在 mp4，只會在 cue 切換時「跳」到下一個狀態。要錄出動態過程需改用真正的螢幕錄影（Playwright `recordVideo` 依 cue 時序即時播放＋另外合成語音），列為 **PRES-CUE-REC-02 待辦**。
- 頁與頁之間沒有額外的 1.5 秒停頓（錄影節奏由每段 pause 決定）；無旁白的 cue 片段至少 1 秒。
- 順帶修正：無旁白的片段改帶一條靜音音軌（以前是沒有音軌），讓所有片段的音訊格式一致、`concat` 不會掉聲音。

---

## 10. 依賴套件彙整

| 套件 | 用途 | 安裝 |
|---|---|---|
| `playwright` | 無頭截圖（+ Phase 2 錄影） | `npm install playwright && npx playwright install chromium` |
| `pptxgenjs` | 組 pptx | `npm install pptxgenjs` |
| `ffmpeg`（系統） | Phase 2 音影合成（非 npm） | 系統安裝，exec 呼叫 |

---

## 11. 實作驗收標準（Phase 1）

- ep1-v2 匯出的 pptx，每頁視覺與網頁瀏覽一致（允許字型反鋸齒細微差異）。
- 每頁備忘稿欄位顯示對應 `data-transcript` 內容，無亂碼。
- 匯出 12 張 slide 的 deck 在 5 秒內完成（本機 Chromium，無網路瓶頸）。
- 匯出失敗時 API 回傳明確錯誤訊息，前端顯示原因。

---

## Changelog

| Date | Version | Author | Description |
|:-----|:--------|:-------|:------------|
| 2026-06-20 | v1.0 | Hana(Claude) | 初版。無頭引擎選 Playwright、截圖 1920×1080、PptxGenJS 保真匯出、Phase 2 接點說明。 |
| 2026-10-23 | v1.1 | Hana(Claude) | §PXW：簡報根目錄改為「當前工作區優先、找不到才退回 HARNESS_HOME」（匯出 pptx／錄影 mp4／block deck 列表與匯出），404 點名找過的兩個路徑，匯出檔存回命中根目錄的 `presentations/exports/`；`GET /api/presentations/exports/<file>` 支援 `?workspace=`（§6 簡報根目錄、§8）。PRES-CUE：pptx 輸出全部 cue 執行完的最終畫面（不畫雷射筆）＋備忘稿全文（§4.3）；mp4 改以 cue 為片段、照 cue 順序與 pause 出片，動作過程不錄（靜態畫面，待辦 PRES-CUE-REC-02，§9.1）。**異動原因**：客戶專案工作區匯出回「找不到 deck」、結案報告 P9 需要匯出；指揮官 2026-10-23 拍板通用簡報能力歸平台。 |

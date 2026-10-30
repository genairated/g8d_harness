# SPEC — Presentation Core（注入式共享簡報框架）

> Status: ACTIVE ｜ Owner: 老闆 + Hana ｜ 影響範圍：`portal/presentation-player/`、`presentations/*.html`、`portal/server.js`（/raw 注入）
> 目的：讓「未來很多簡報」共用同一套播放引擎，**deck 只寫內容，播放/語音/頭像 fix-once**。

---

## 1. 為什麼要這份（背景與教訓）

每個 deck 各自內嵌一份播放程式（ep2–ep8 的舊做法）＝ 改一個播放 bug 要改 N 個檔。但「把框架硬套到已有自帶播放的 deck 上」更糟——`ep1-v2` 曾同時跑：
1. `PresentationPlayer` 框架，
2. deck 自帶 `adjustScale` + viewport transform，
3. deck 自帶浮動頭像，

三套互相打架（transform 衝突讓 `position:fixed` 頭像被縮放容器吃掉、雙引擎搶 `resize`、頭像路徑被污染）。

**鐵則：一個 deck 只能有「一套」播放引擎。** 正解是把 ep2 那套 proven 引擎抽成「server 注入式共享模組」，跟 `hana-overlay.js`（頭像/語音）同一個模式——deck 維持純內容。

---

## 2. 架構

```
deck (presentations/*.html)  =  純內容（投影片 + 視覺設計）
        │  載入 / 由 server 注入
        ▼
presentation-core.js   ← 播放引擎：縮放 / 切片 / dots / 進度 / autoplay / TTS / 全螢幕 / 逐字稿 / 鍵盤
presentation-core.css  ← 外殼 + 共用設計系統樣式
hana-overlay.js        ← 浮動頭像 + 語音覆寫（hook speechSynthesis.speak）；由 server 於 /raw 注入到所有 presentation HTML
```

- **core 與 overlay 互補、不重疊**：core 負責「投影片播放 + 朗讀觸發」；overlay 負責「全域語音設定 + 頭像 talk/idle」。core 呼叫 `speechSynthesis.speak(u)`，overlay 的 hook 在發聲當下套用全域語音並驅動頭像。
- **檔案位置**：`portal/presentation-player/`（與 `hana-overlay.js` 同目錄）。
- **上線方式**：`presentation-core.*` 是 `portal/` 下的「新檔」，走 `/raw` 的 HARNESS_HOME fallback **免 Deploy 即時生效**（見 ARCHITECTURE-portal.md 地雷區）。

---

## 3. Deck 合約（做新簡報照這個寫）

deck 只需提供以下骨架，其餘外殼（progress / timer / footer 控制列 / tech-panel 語音面板 / drawer 逐字稿 / overlay 開始鈕）由 `presentation-core.js` 自動建立：

```html
<head>
  <!-- 字型 -->
  <!-- (可選) deck 專屬的內容設計樣式 <style>…</style> -->
  <link rel="stylesheet" href="/raw?path=portal/presentation-player/presentation-core.css">
</head>
<body>
  <div class="presentation-viewport" id="viewport" data-subtitle="副標（顯示於開始播放遮罩）">
    <header>
      <div class="brand">HANA / HARNESS</div>
      <div class="meta">EPISODE 0X · 標題</div>
    </header>
    <main class="slides">
      <section class="slide title-slide" data-transcript="這一頁的旁白逐字稿（給 TTS 朗讀）">
        …投影片內容（可用 core.css 提供的設計系統 class：kicker / mini-card / compare-grid / table / pipeline / split …）…
      </section>
      <!-- 更多 <section class="slide" data-transcript="…"> -->
    </main>
  </div>
  <script src="/raw?path=portal/presentation-player/presentation-core.js"></script>
</body>
```

**合約要點**：
- 每張投影片是 `<section class="slide">`，標題頁加 `title-slide`。
- 旁白放 `data-transcript`（相容舊欄位 `data-notes`）。沒有旁白的頁不朗讀。
- **要「邊講邊動」**：在 `.slide` 內加 `<script type="application/json" data-cues>`，見 §8（PRES-CUE）。沒加的頁維持整段朗讀。
- `#viewport` 的 `data-subtitle` 顯示在「開始播放」遮罩。
- 「下一集」連結用 `<a href="presentation-hana-episodeN.html">`（只寫檔名、不寫目錄），core 會自動處理（iframe 用 `parent.loadFile`／raw 模式更新 query／否則跳轉）。**core 從自己被載入的 `?path=`（`/raw?path=<dir>/<file>.html`，iframe 與 raw 模式皆經此載入）反推所在目錄再接檔名，不寫死目錄**——因為同一套引擎要同時服務 `presentations/`（v1）與 `presentations-v2/`（v2）等多個目錄；曾因寫死 `presentations/` 前綴，v2 deck 點下一集載到不存在的路徑而黑屏（2026-07-01 修復，見 Changelog）。
- **deck 不要自帶**：縮放、投影片切換、TTS、全螢幕、浮動頭像、控制列 HTML——這些都由 core/overlay 提供。

---

## 4. presentation-core.js 提供的行為

| 功能 | 說明 |
|---|---|
| 縮放 | 1920×1080 等比 `scale` 到視窗，`resize` 重算 |
| 切片 | prev/next、dots、鍵盤（→/空白=下一頁、←=上一頁、F=全螢幕、P=朗讀、S=停止、Esc=退出簡報模式） |
| 進度/計時 | 頂部 progress bar；autoplay 倒數 timer bar |
| TTS | `data-transcript` → `speechSynthesis`；預設語音挑選優先序 `Microsoft Yating → Yating → zh-TW → zh → 第一個`；速度預設 1.2 |
| 自動換頁 | 有語音時靠朗讀 `onend` 推進；無語音時用倒數計時 |
| 全螢幕 / 簡報模式 | `全螢幕播放` 進入沉浸模式（隱藏面板、自動朗讀） |
| 逐字稿抽屜 | 右側 drawer 顯示當前頁 `data-transcript` |
| 開始遮罩 | 首次需使用者點「開始播放」解鎖音訊（瀏覽器 autoplay 政策） |

冪等：`#viewport[data-core-init]` 防重複初始化。

---

## 5. CSS 共存規則（deck 自帶樣式 + core.css）

- **載入順序**：deck 專屬 `<style>` 先、`core.css` 後 → 共享選擇器（`body` / `.presentation-viewport` / `.slide` 基底 / 外殼）由 core 覆寫；deck 專屬 class（內容版面）保留。
- core.css 定義 `.slide` 基底（卡片 + 進出場 transition）與 `.slide h1` / `.slide p`、外殼、共用設計系統。
- deck 若有自己的標題排版習慣（如舊 ep1 綁在 `.pres-slide`），在 core.css 之後補 `.slide h2/h3/...` 覆寫即可。

---

## 6. Block Deck 整合（Phase 3）

Phase 3 新增「版型區塊模型」：Hana 填 JSON（`.blocks.json`）即可生 deck，不必手寫 HTML。
- **規格**：`specs/SPEC-block-deck.md`
- **網頁渲染**：`portal/presentation-player/block-renderer.js` 把 JSON → `.slide` DOM，再由本 core 接管
- **播放外殼**：`presentations/block-deck-player.html`（`?deck=<name>` 參數指定 deck）
- **可編輯 pptx**：`portal/render-service/block-export.js`（PptxGenJS 原生圖元）
- **API**：`GET /api/block-decks`、`POST /api/block-decks/:name/export`

block deck 的 `.slide` 節點完全符合本 SPEC §3 的 deck 合約，presentation-core.js 無需修改即可接管。

---

## 7. 已知約束 / 待辦

- **瀏覽器 autoplay**：`speechSynthesis` 需使用者手勢後才出聲 → 用「開始播放」遮罩解鎖；沉浸/簡報模式按鈕本身即手勢。
- **每瀏覽器預設語音**：`hana-overlay.js` 目前只 POST 寫入 voice-config，缺 GET 載入「Edge 等瀏覽器的已存預設語音」→ 全新分頁會用瀏覽器預設音。屬語音「對不對」非「有沒有」，列待補。
- **遷移**：ep1 已轉為本架構（試刀）。ep2–ep8 仍各自內嵌引擎，後續可逐一瘦身改用 core。新簡報一律照本 SPEC。
- **PRES-CUE 的 deck 要放在 `presentations/` 目錄底下**才會被 `/raw` 注入 hana-overlay（頭像）；`portal/presentation-player/examples/cue-demo.html` 在平台目錄裡，直接開沒有頭像，這是注入條件（路徑含 `presentations`）的既有行為、不影響 cue 本身。
- **PRES-CUE 的 mp4 是「每個 cue 一張靜態畫面」**：數字滾動、線條畫出的「中間過程」不會出現在影片裡（見 export spec §9.1）。
- **server 注入自動化（可選、需 Deploy）**：目前 deck 自行用 `<script src>`/`<link>` 載入 core；若要像 hana-overlay 一樣由 server 自動注入到所有 presentation，於 server.js 的 /raw 注入點加一行即可（屬 `server.js` 變更 → 需 Deploy）。

---

## 8. 旁白分段 cue（PRES-CUE）——邊講邊動

> 起因：指揮官 2026-10-22 嫌簡報「靜態頁面、照稿唸完、10～15 秒就換頁」，要「說故事式」呈現（旁白講到哪、畫面動到哪）；2026-10-23 拍板「通用簡報能力一律做在平台」，各工作區只寫內容。寫法速查與範例：`portal/presentation-player/CUE-GUIDE.md`、`portal/presentation-player/examples/cue-demo.html`。

### 8.1 合約

投影片內放一段 JSON（`<script type="application/json" data-cues>`），每個元素是一個 cue：

| 欄位 | 型別 | 意義 |
|---|---|---|
| `say` | 字串 | 這一段要唸的字 |
| `step` | 數字 | 揭露到第 N 個 `data-anim-step`（元素需同時有 `data-anim`） |
| `laser` | 物件／字串／陣列 | 雷射筆：`{target, type:"circle"\|"box"\|"underline", box:{x,y,w,h}}`，`box` 為相對 target 的百分比；可同時多個（陣列）；下一個 cue 開始時淡出 |
| `show` | `{target, index}` | 輪播容器 `.cue-slides` 切到第 index 張（1 起算） |
| `count` | 選擇器／`{target, duration}` | 對 `[data-count-to]` 做數字滾動 |
| `draw` | 選擇器／陣列／`{target, duration}` | 對 `.cue-draw`（SVG 幾何或群組）逐段畫出；多個目標依序錯開 |
| `compare` | `{target, pos}` | 前後對照滑桿 `.cue-compare` 移到 pos（0～100，%） |
| `timeline` | `{target, at}` | 時間軸 `.cue-timeline` 推進到第 at 格 |
| `pause` | 毫秒 | 這段唸完後停多久，預設 **600** |

- **播放順序**：做該 cue 的動作 → 唸 `say` → 停 `pause` → 下一個 cue；全部 cue 結束後停 **1.5 秒**再換頁（自動換頁／全螢幕播放時）。進場時第一個 cue 的動作立即套用。
- **舊頁面不變**：沒有 `data-cues`（或 JSON 解析失敗）的頁面走原本流程——唸整段 `data-transcript`、唸完 1.5 秒換頁、`data-anim-step` 手動步進。JSON 壞掉時 console 警告、該頁退回舊流程，不讓整份簡報掛掉。
- **`data-transcript` 仍要保留**＝所有 `say` 串起來的全文（逐字稿抽屜、pptx 備忘稿用）；沒寫時引擎與匯出會自動把 `say` 串起來補位。
- **手動模式**：右鍵／空白＝下一個 cue（有語音就從該 cue 接著唸、沒語音只看動畫）；左鍵＝回到上一個 cue 的狀態（瞬間重建、不唸）；在第一個 cue 按左鍵＝回上一頁，且停在那頁「全部 cue 執行完」的狀態。
- **無語音＋自動換頁**：cue 依字數估時間推進（約每字 0.22 秒 ÷ 語速，最少 1.5 秒）＋ pause。
- **暫停**：⏸ 在唸的當下暫停發聲；在 cue 之間的停頓中按也有效（停頓計時會等到繼續）。

### 8.2 共用元件（`presentation-core.css`／`.js`，所有工作區共用）

| 元件 | 標記 | 說明 |
|---|---|---|
| 雷射筆 | 由 core 動態產生 `.cue-laser-circle/box/underline` | 紅點＋脈動光圈／框選／底線；同頁可多個 |
| 輪播 | `.cue-slides > *` | 子元素疊同一格，`.cue-on` 那張顯示，淡入淡出 |
| 數字滾動 | `[data-count-to]`＋可選 `data-count-from/decimals/prefix/suffix` | 千分位（en-US）、前後綴；沒有 cue 的頁進場自動滾 |
| SVG 逐段畫出 | `.cue-draw`（path/line/polyline/polygon/circle/rect/ellipse 或其群組） | stroke-dashoffset；沒有 cue 的頁進場依序自動畫 |
| 前後對照 | `.cue-compare > .cue-before + .cue-after`，`data-pos` 為起始位置（預設 100） | 中間把手由 core 補上 |
| 時間軸 | `.cue-timeline > .tl-item*` | 已過＝`tl-done`、當下＝`tl-current`，進度條由 core 補上 |
| 暫估角標 | `<span class="est-badge"></span>` | 空的會自動顯示「暫估」；可用 `data-label` 換字或直接寫字 |

### 8.3 與 hana-overlay 的關係

每個 cue 各自 `speechSynthesis.speak()` 一次——overlay 的 hook 照常套全域語音、每段切一次頭像 talk/idle（自測 30 次切換／15 段）。core 在 `speak` 前設定 `onend/onerror`，overlay 包住後仍會呼叫原本的 callback，所以 cue 鏈不會斷。

### 8.4 對外介面 `window.__presCore`

`cues(i)`、`finalizeSlide(i)`（全部 cue 執行完、不含雷射筆，pptx 用）、`cueState(i,k)`（瞬間重建到第 k 個 cue、含雷射筆，mp4 用）、`current()`（自測用）。匯出端見 `SPEC-presentation-export.md` §4.3／§9.1。

---

## Changelog
| Date | Version | Author | Description |
|:-----|:--------|:-------|:------------|
| 2026-06-19 | v1.0 | 老闆 + Hana(Claude) | 初版。從 ep2 proven 引擎抽出 `presentation-core.js`+`.css` 注入式共享模組；定義 deck 合約；ep1-v2 轉為本架構試刀。 |
| 2026-07-01 | v1.1 | 老闆 + Hana(Claude) | 修「下一集」跳轉黑屏：`presentation-core.js` 新增 `currentDeckDir()` 從 `?path=` 反推目錄，取代寫死的 `'presentations/'` 前綴，讓同一套引擎正確服務 v1（`presentations/`）與 v2（`presentations-v2/`）。順帶補 `portal/index.html` `presentationTitles` 缺的 v2 EP2–EP8 中文標題。 |
| 2026-10-23 | v1.2 | 指揮官 + Hana(Claude) | 新增 §8 旁白分段 cue（PRES-CUE）：`data-cues` 合約（say/step/laser/show/count/draw/compare/timeline/pause）、cue 播放鏈（動作→唸→停→下一個，頁尾 1.5 秒換頁）、手動前後步進、無語音估時推進、共用元件（雷射筆／輪播／數字滾動／SVG 畫出／前後對照／時間軸／暫估角標）、`window.__presCore` 匯出介面。**異動原因**：指揮官 2026-10-22 要求說故事式呈現（嫌舊簡報靜態、照稿唸完就換頁）；2026-10-23 拍板通用能力歸平台、工作區只寫內容。**自行取捨**：①進場即套用第一個 cue 的動作（否則手動模式第一次按右鍵看起來沒反應）；②匯出 pptx 的最終畫面不畫雷射筆（它是講解指示、不是內容）；③無語音時用字數估時；④JSON 壞掉退回舊流程不報錯中斷。舊頁面（無 data-cues）行為不變，已用客戶專案 62 頁舊 deck 抽 5 頁與上線版逐像素比對一致。 |

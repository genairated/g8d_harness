# CUE-GUIDE — 讓簡報「邊講邊動」的寫法速查

> 規格：`specs/SPEC-presentation-core.md` §8（PRES-CUE）。完整示範：`portal/presentation-player/examples/cue-demo.html`（8 頁，每種動作都有）。
> 這份是給**寫內容的人**看的：照抄片段、改字、改選擇器就能用。引擎與樣式都在平台，deck 不必（也不准）自帶任何播放程式。

---

## 0. 基本骨架

在每張 `<section class="slide">` 裡、最後面放一段 JSON：

```html
<section class="slide" data-transcript="（把下面所有 say 串起來的全文）">
  <h1 id="t1">標題</h1>
  …內容…
  <script type="application/json" data-cues>
  [
    {"say":"第一句旁白，", "laser":"#t1"},
    {"say":"第二句旁白。", "pause":900}
  ]
  </script>
</section>
```

播放順序：**做動作 → 唸 say → 停 pause（預設 600 毫秒）→ 下一個 cue**；最後一個 cue 唸完停 1.5 秒換頁。
手動：→／空白＝下一個 cue，←＝回上一個 cue；在第一個 cue 按 ← 才會回上一頁。

**`data-transcript` 一定要寫**，內容＝所有 `say` 按順序串起來（逐字稿抽屜、pptx 備忘稿都讀它）。

---

## 1. step：逐步揭露（沿用 data-anim-step）

```html
<div class="mini-card" data-anim data-anim-step="1">第一點</div>
<div class="mini-card" data-anim data-anim-step="2">第二點</div>
<script type="application/json" data-cues>
[
  {"say":"先講第一點，","step":1},
  {"say":"再講第二點。","step":2}
]
</script>
```

元素要**同時**有 `data-anim` 和 `data-anim-step="N"`；`step:N` 會顯示所有 ≤ N 的元素。

## 2. laser：雷射筆

```json
{"say":"看這個數字。", "laser":"#kpi1"}
{"say":"框右上角這一塊。", "laser":{"target":"#shot","type":"box","box":{"x":60,"y":0,"w":40,"h":35}}}
{"say":"這行是重點。", "laser":{"target":"#line3","type":"underline"}}
{"say":"兩邊一起看。", "laser":[{"target":"#a","type":"box"},{"target":"#b","type":"box"}]}
```

- `type`：`circle`（預設，紅點＋脈動光圈）／`box`（框選）／`underline`（底線）。
- `box` 是**相對 target 的百分比**（x、y 為左上角，w、h 為寬高）；不給 target 時相對整張投影片。
- 下一個 cue 開始時自動淡出；要連續標同一處，就在下一個 cue 再寫一次。
- pptx 匯出的最終畫面**不畫**雷射筆；mp4 會畫。

## 3. show：同頁截圖輪播

```html
<div class="cue-slides" id="shots">
  <img src="/raw?path=presentations/deck-assets/list.png">
  <img src="/raw?path=presentations/deck-assets/edit.png">
  <img src="/raw?path=presentations/deck-assets/report.png">
</div>
```
```json
{"say":"這是清單頁，","show":{"target":"#shots","index":1}}
{"say":"點進去是編輯頁，","show":{"target":"#shots","index":2}}
```

`index` 從 **1** 起算。容器初始顯示第 1 張；容器要給高度（或讓圖片撐開），圖片預設 `object-fit:contain`。

## 4. count：數字滾動

```html
<span id="n1" data-count-to="128450">0</span>
<span id="n2" data-count-to="62" data-count-suffix="%">0%</span>
<span id="n3" data-count-to="3.8" data-count-decimals="1" data-count-prefix="NT$" data-count-suffix="千萬">NT$0.0千萬</span>
```
```json
{"say":"一年處理十二萬筆，","count":"#n1"}
{"say":"成本省下約三點八千萬。","count":{"target":"#n3","duration":1800}}
```

- 自動加千分位；`data-count-from` 可改起點（預設 0）。
- 標籤內先寫好「起點文字」，避免載入瞬間閃出空白。
- 數字很長時給容器 `white-space:nowrap`，否則單位會被擠到下一行。
- 沒寫 cue 的頁：進場自動滾。

## 5. est-badge：暫估角標（還沒確認的數字一定要掛）

```html
<span data-count-to="380" data-count-suffix="萬">0萬</span><span class="est-badge"></span>
<span class="est-badge" data-label="待確認"></span>
```

空的會顯示「暫估」；`data-label` 可換字。**指揮官未確認的數字不可拿掉角標**。

## 6. draw：SVG 流程圖逐段畫出

```html
<svg viewBox="0 0 1600 560">
  <g class="cue-draw" id="n1"><rect x="40" y="200" width="360" height="160" rx="14" fill="none" stroke="#22d3ee" stroke-width="4"/></g>
  <path class="cue-draw" id="s1" d="M400 280 L620 280" fill="none" stroke="#34d399" stroke-width="6"/>
  <g class="cue-draw" id="n2">…</g>
</svg>
```
```json
{"say":"先收單，","draw":"#n1"}
{"say":"接著派工，","draw":["#s1","#n2"]}
```

- 要被畫的元素（或其群組）加 `class="cue-draw"`；陣列裡的目標會依序錯開畫。
- 只對**有外框線（stroke）**的圖形有效；填色（fill）不會「畫出來」，文字也不會——文字請用 `step` 揭露。

## 7. compare：前後對照滑桿

```html
<div class="cue-compare" id="cmp" data-pos="100" style="height:600px">
  <img class="cue-before" src="/raw?path=presentations/deck-assets/before.png">
  <img class="cue-after"  src="/raw?path=presentations/deck-assets/after.png">
  <span class="cue-label l">導入前</span><span class="cue-label r">導入後</span>
</div>
```
```json
{"say":"這是導入前，","compare":{"target":"#cmp","pos":100}}
{"say":"推過去就是導入後。","compare":{"target":"#cmp","pos":0}}
```

`pos`＝把手位置（%）：100＝全是「前」、0＝全是「後」。`data-pos` 是起始位置。

## 8. timeline：時間軸推進

```html
<div class="cue-timeline" id="tl">
  <div class="tl-item">需求訪談</div><div class="tl-item">設計</div><div class="tl-item">上線</div>
</div>
```
```json
{"say":"從需求訪談開始，","timeline":{"target":"#tl","at":1}}
{"say":"到上線。","timeline":{"target":"#tl","at":3}}
```

`at` 從 1 起算；之前的格子變「已完成」、第 at 格是「目前」。

## 9. pause：停頓

```json
{"say":"這是整個專案最關鍵的一句話。", "pause":1500}
```

預設 600 毫秒。換重點、讓觀眾消化數字時拉長到 1000～1500；同一句拆成好幾個動作時可縮到 200～300。

---

## 常見錯誤

| 症狀 | 原因 | 修法 |
|---|---|---|
| 整頁照舊整段唸、沒有分段 | JSON 寫錯（多逗號、用了中文引號「」、單引號）→ 引擎退回舊流程，console 有警告 | 用標準 JSON：雙引號、最後一項不加逗號 |
| 雷射筆圈錯位置 | 選擇器選到別的元素，或沒加 `#`／`.` | 選擇器只在**這張投影片內**找，給目標一個唯一 id |
| step 元素一開始就看得到 | 只寫了 `data-anim-step`、沒寫 `data-anim` | 兩個都要寫 |
| 數字單位跑到下一行 | 字太大、容器太窄 | 容器 `white-space:nowrap` 或縮字 |
| 流程圖線沒有「畫出來」，直接出現 | 目標沒有 `stroke`，或 `class="cue-draw"` 掛在 `<text>` 上 | 只對有外框線的幾何用 draw |
| 逐字稿抽屜／pptx 備忘稿少一段 | `data-transcript` 沒跟著 `say` 一起改 | 改 `say` 時同步改 `data-transcript` |
| 語音唸出「斜線」 | `say` 裡有 `/`、`／`、`\|` | 旁白改口語，不放這些符號（畫面可以有） |
| 開起來沒有 Hana 頭像 | deck 不在 `presentations/` 目錄下 | deck 放工作區的 `presentations/`（頭像注入看路徑） |

## 旁白字數建議

- **一個 cue 15～40 字**（約 3～8 秒）。一個 cue 只講一件事、配一個動作；超過 50 字就拆。
- **一頁 3～6 個 cue**，整頁 20～45 秒。30～60 分鐘的簡報約 80～110 頁。
- 語速 1.2 時，中文大約每秒 4.5～5 字；拿字數 ÷ 5 估秒數。
- 句尾留標點（，。）——字幕（vtt）會依標點切段。
- 數字寫成口語（「十二萬八千筆」比「128450 筆」唸得自然）；畫面上的數字照原樣。
- 人名、工具名照指揮官的 TTS 規則（保留英文原文）。

## 匯出時會怎樣

- **pptx**：每頁一張「全部 cue 執行完」的最終畫面（不畫雷射筆）＋備忘稿＝`data-transcript` 全文。
- **mp4**：每個 cue 一段——畫面是「做完該 cue 動作的當下」（含雷射筆）、聲音是該 cue 的 say、後面接 pause 的靜音。**數字滾動、線條畫出這類「過程」不會錄進影片**，只會在 cue 切換時跳到下一個狀態（平台待辦 PRES-CUE-REC-02）。

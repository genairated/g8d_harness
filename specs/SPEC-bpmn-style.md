# SPEC — BPMN 顯示風格（Style Packs：BPMN 原生／仿 Visio／可擴充）

> Status: APPROVED（2026-09-17 指揮官拍板「同意判斷」）｜Owner: Charles + Hana
> 影響範圍：`portal/index.html`（bpmn-js modeler 建立與著色／字級／擬真合成段，約 L2869–L3230、`_synthDocFlowSvg`、`?print=doc-fidelity`）、`portal/render-service/flow-bpmn.js`（`.flow.json` ⇄ `.bpmn` 投影）、`portal/server.js`（bpmn 存檔反向同步 L2576–2600、烤入端點 L6235+）、`portal/render-service/docx-bpmn-bake.py`（真身／交付檔烤入）
> 動機（2026-09-17 與 Charles）：BPMN 編輯器功能已足夠，但**交付給客戶的文件風格不一致**——客戶端慣用 Visio／draw.io 的觀感，而 portal 產出的是 bpmn-js 原生觀感。需求是「**同一套工具、可切換產出風格**」，且**未來可再加新風格**（例如 draw.io）。**不改流程語意、不改編輯功能。**

---

## 1. 核心設計：語意與外觀分離

BPMN 檔本身只存**語意**（誰接誰、哪個泳道、什麼節點型別）。「長什麼樣」抽成一個具名的 **Style Pack**：

```
.flow.json / .bpmn（語意，不變）  ×  Style Pack（外觀）  →  畫面 / PDF / docx 烤入
```

- **Style Pack 是一份宣告式定義**（JS 物件，程式內建），內容：各節點型別的填色／線色／線寬／圓角／字體／字級／陰影、連線樣式（直角 orthogonal vs 斜角）、標籤位置、泳道標題列外觀。
- **切換風格＝換一份 Style Pack 重畫**，語意檔一個字都不動 → **可逆、不會破壞既有圖**。
- 新增第三種風格＝新增一份定義檔，**不動架構**。

### 1.1 第一版內建風格

| id | 名稱 | 觀感 |
|---|---|---|
| `bpmn`（預設） | BPMN 原生 | 現行外觀，完全等同今天 |
| `visio` | 仿 Visio | 灰藍配色、較粗深色外框、方角矩形、直角連線、淡陰影、Segoe UI／微軟正黑體字族 |

> **誠實界定**：`visio` 是「風格接近、一眼認得出」，**不是** Visio 原生圖案庫的像素級複刻（Visio 的 stencil 是專有形狀庫，無法也不必複製）。交付一致性需要的是前者。

---

## 2. 風格存在哪裡（決策已定）

**文件層預設 ＋ 單張圖可覆寫：**

1. **文件層預設**：存在該文件的 `.documents/<uuid>/doc.md` front-matter 或 registry 記錄的 `flowStyle` 欄位（實作時擇一，以不破壞既有解析為準）。
2. **單張圖覆寫**：存在該圖的 `.flow.json` 的 `style` 欄位；`.bpmn` 端以自訂 namespace 屬性（`harness:style`）鏡射，讓**只拿到 .bpmn 的下游（烤入管線）也讀得到**。
3. **未標記 ＝ `bpmn` 原生**，舊圖行為完全不變（不做批次遷移）。

⚠️ **實作鐵則**：`.bpmn` 存檔時會反向同步回 `.flow.json`（`portal/server.js` L2583），**`style` 欄位必須在這條往返中被保留**，否則使用者選的風格會在下一次存檔被洗掉。這是本任務最容易踩的坑，必須寫測試守住。

---

## 3. 風格怎麼「生效」到三條輸出路徑

三條路徑必須都吃到同一份 Style Pack，否則會出現「編輯器裡是 Visio 風、烤出來變回原生」：

| 路徑 | 現行機制 | 套風格的方式 |
|---|---|---|
| **編輯器畫面** | bpmn-js modeler（`createBpmnModeler`） | import 後套用 Style Pack（等同現行 `applyBpmnDefaultColors` 的擴充版）＋ 容器注入 scoped CSS |
| **擬真預覽／PDF** | `_synthDocFlowSvg` 合成 svg 貼回圖框 | 同一支套用函式；**SVG 內必須是 inline 屬性／inline style**，不可只靠外部 CSS |
| **烤進 docx／真身** | 前端把 bpmn 渲成高解析 PNG → POST → `docx-bpmn-bake.py` | 渲 PNG 前先套用 Style Pack；PNG 是點陣，故**只要渲染當下是對的就是對的** |

### 3.1 已知技術限制（必須遵守）

- **顏色**走 `modeling.setColor()` → 寫進 BPMN DI（`bioc:fill`/`stroke`），**會持久化、下游讀得到**。✅
- **字級**目前是**注入 CSS 覆寫**（`applyBpmnElementFontSizes`，L3190+），**不寫進 XML** → 純 CSS 的東西在「SVG 被抽出去合成／光柵」時可能掉。因此 Style Pack 中凡是要進交付物的視覺屬性，**一律以 inline 屬性或在 SVG 序列化前內聯**，不可只掛 class。
- **形狀幾何**（方角 vs 圓角、終端膠囊形）需要接管 bpmn-js 的 renderer，屬**第二階段**，風險較高——它可能與現有的「改色」「字級」「泳道方向」功能互相打架，必須逐一回歸測試。

---

## 4. 分期

### Phase 1（BST1）— 風格資料模型 ＋ 切換 UI ＋ 顏色/線條/字體層級的 Visio 風（已實作，2026-09-17）
- Style Pack 定義結構、兩份內建風格、讀寫與往返保留、編輯器工具列「風格 ▾」下拉、切換即時重畫。
- Visio 風在此階段透過**配色、線寬、字族、陰影**達成（連線的「直角」偏好沿用 bpmn-js 既有的 manhattan 自動路由，本階段未另做接管——不動形狀幾何）。
- **實際做法**：`portal/index.html` 新增 `BPMN_STYLE_PACKS`（`bpmn`／`visio`）取代硬編 `_BPMN_TYPE_COLORS`；`applyBpmnStyle()` 取代 `applyBpmnDefaultColors()`，用每個 modeler 上的 `_harnessPackColoredIds`（`Set`）區分「套件管色」與「使用者手動改色」——只有前者隨風格切換重繪，後者永遠保留（既有改色功能因此不受影響）。舊檔沒有明確標記（`harness:packColored`）時，用「目前顏色是否等於 `bpmn` 原生預設值」推斷是套件色還是手動色，對所有 BST1 之前存的舊圖零誤判（`bpmn` 色表本來就沒變過）。線寬／字族／陰影／連線色這幾項不進 DI 的視覺屬性，由 `_bpmnPaintSvgDetails()` 直接寫成 SVG 節點的 inline style（不掛 class），在 `saveSVG()` 序列化前後各補畫一次，防止序列化過程遺失（守住 §3.1 的已知限制）。畫面（`createBpmnModeler` 系列 8 個呼叫點）與擬真合成／列印（`_placeFlowFrame` 唯一呼叫的 `_renderBpmnXmlInto`）全部收斂到同一支 `applyBpmnStyle`＋`_bpmnPaintSvgDetails`。持久化：風格 id 與套件管色清單以 `xmlns:harness`/`harness:style`/`harness:packColored` 自訂屬性鏡射在 `<bpmn:definitions>`（預設風格不寫入，維持零改變）；`flow-bpmn.js` 的 `flowToBpmn`/`bpmnToFlow` 雙向新增 `flow.style` 欄位，`bpmnToFlow` 直接解析 `harness:style`，故 `server.js` 既有的 `.bpmn`→`.flow.json` 反向同步無需額外改動即自動保留 style（鐵則守住）。
- **驗收現況**：`flow.json`⇄`.bpmn` 的 style 往返、`harness:` 屬性注入/解析（含切回預設乾淨移除、重複存檔不重複宣告命名空間）、套件色/手動色判斷演算法，皆以 Node 單元測試驗證通過。**「兩風格外觀明顯不同」「無 console 錯誤」這兩項需要真實瀏覽器渲染 bpmn-js 才能驗證，本次執行環境下未做**（本排程不自動部署、且執行中的 :3400 不得重啟/另起，指向舊版本測試沒有意義）——待指揮官 Deploy 後親自目視確認，見 `.worktable/TASK.md` §BST1 BST1-5。
- 風險：低（已實作部分）。

### Phase 2（BST2）— 形狀幾何層級（自訂 renderer，已實作，2026-09-17）
- 自訂 renderer：方角矩形、終端節點形狀、閘道外觀、泳道標題列樣式、連線路由偏好。
- **驗收**：既有改色／字級／泳道方向／自動排版全部仍正常（回歸清單逐項過）。
- 風險：中。這是最可能改壞既有功能的一段。

**實際做法（關鍵決策：委派而非重寫）**：`portal/index.html` 新增 `HarnessStyleRenderer`，以 **priority 1500**
註冊在 bpmn-js 的 `render.shape`／`render.connection` 事件上（bpmn-js 內建 `BpmnRenderer` 走 `BaseRenderer`
的 priority 1000，先回傳者勝出）。這個 renderer **不自己畫圖**：先呼叫 `bpmnRenderer.drawShape()` 取得
原生產物，再依 `pack.geometry` 修改 SVG 幾何。好處是顏色仍走 DI（`modeling.setColor`）、文字仍走
`textRenderer`、連線靠接點仍走原生 `render.getShapePath` → **既有「改色／字級／泳道方向／自動排版」路徑
完全沒被接管，回歸風險大幅下降**。`bpmn` 原生 pack 沒有 `geometry` 欄位，renderer 直接 return → 舊圖零改變。

**geometry 欄位（visio 首發值）**：`cornerRadius: 0`（方角矩形）、`gatewayStrokeWidth: 2.5`（閘道尖角接合）、
`eventRing: {start:2, end:4}`（終端節點：起始細環／結束粗環）、`laneHeader: {size:30, fill:'#dce5f2'}`
（泳道標題列填色帶）、`connectionCorner: 'sharp'`（連線直角接合；另實作 `'rounded'` 的圓角折線演算法
`_bpmnRoundPathCorners`，供 Phase 3 的 drawio 風格使用）。

**統一入口**：新增 `bpmnModelerOpts(container, extra)`，把 `additionalModules: [harnessStyleRendererModule]`
一次掛給**全部四個 `new BpmnJS(...)` 站點**（主／彈窗編輯器、`renderBpmnSvgInto` 內嵌預覽、
`_renderBpmnXmlInto` 擬真合成與列印、以及另一個離屏預覽），否則會出現「編輯器是 Visio 風、擬真／交付變回原生」。
`applyBpmnStyle()` 切換風格時先 `eventBus.fire('harness.style.changed', {pack})` 通知 renderer，再
`fire('elements.changed', {elements})` 強制整圖重繪（排除沒有 parent 的 root，避免 GraphicsFactory 更新 root 出錯）。

**踩到的坑（兩個，都已修掉）**：
1. **BST1 的 inline 塗色會蓋掉幾何層決定的線寬**：`_bpmnPaintSvgDetails()` 把每個形狀的第一個子節點線寬
   一律設成 `pack.strokeWidth`（2.5px），導致起訖事件的「細環／粗環」剛畫好就被抹平。解法：幾何層設定
   線寬時在該 SVG 節點打上 `data-harness-geo="1"`，`_bpmnPaintSvgDetails` 看到標記就不覆蓋線寬（陰影仍照塗）。
2. **「單一元件字級」其實從來沒生效過（既有 bug，非本階段造成，順手修掉）**：`applyBpmnElementFontSizes()`
   的選擇器是 `[data-element-id="X"] .djs-label text`，但 bpmn-js 的標籤**本身就是** `<text class="djs-label">`
   （底下只有 `<tspan>`），`.djs-label text` 永遠選不到；且事件／閘道的文字掛在獨立的外部標籤元素（id 為
   `<id>_label`），原本也沒涵蓋。已改成同時針對 `.djs-label`／其 `tspan`／以及 `<id>_label` 元素設定字級。
   （這是回歸清單逼出來的發現——若只跑「有沒有壞」而不驗「原本就該有的效果」，會漏掉。）

**驗收現況（真實瀏覽器，非推測）**：在**隔離埠 3399** 跑純靜態鏡射（只餵 `/vendor` 與測試頁，**不是第二顆
Harness server**：無 scheduler、無 Telegram polling、測完立即關閉），用 Playwright + 真實 Chromium 對
**從 `portal/index.html` 自動擷取的同一份程式碼**跑 36 項回歸，**36/36 通過**、console 零錯誤零警告。
鏡射裝置與截圖留在 `.worktable/artifacts/bst2/`（`mirror/run-test.js` 可重跑，BST3 直接沿用）。

### Phase 3（BST3）— 交付鏈打通 ＋ 文件層預設 ＋ 新增 draw.io 風格
- 文件層預設 UI、烤入管線（PNG 光柵／docx bake）確認吃到風格、`drawio` 第三份 Style Pack 作為「架構可擴充」的實證。
- **驗收**：先只驗「產生擬真交付檔」；確認無誤後才允許「烤進真身」（真身是覆寫，錯了要靠快照還原）。
- 風險：中低（架構已在 Phase 1/2 定案）。

---

## 5. 開放決策（已拍板，記錄備查）
1. 仿 Visio 程度 → **風格接近，非像素級複刻**。
2. 風格存放層級 → **文件層預設 ＋ 單張可覆寫**。
3. 既有圖 → **一律視為 `bpmn` 原生，不批次遷移**。

## 6. 護欄
- 動到 `portal/index.html`／`server.js`／`*.js` 皆為**會被執行的程式** → 改完**必須跑 `Deploy_Harness.ps1`** 才會上線（本系列排程 `postRun.deploy=false`，由指揮官自行部署）。
- 冒煙測**不得起第二顆完整 server**（會搶 Telegram token／重跑排程／燒額度）→ 用隔離埠 3399 鏡射。
- **不得在未經指揮官確認下對任何客戶文件真身執行烤入**。
- 產出只留本工作區；git 由人類掌控。

## 7. 相關規格
- `specs/SPEC-doc-editing.md` §13.10/§13.11（擬真層以 doc.md／paraId 為錨合成 BPMN）
- `specs/SPEC-doc-fidelity-export.md`（A/B/C 三階段烤入管線，本規格的風格必須沿用其對位與光柵化機制，不另造）
- `global-knowledge/commands/doc-flowchart.md`（AI 重建流程圖）

## 8. Changelog
| 日期 | 版本 | 作者 | 摘要 |
|---|---|---|---|
| 2026-09-24 | v0.5 | Hana | Phase 4（BST4）BST4-3～BST4-6 完成：自訂風格編輯 UI（「＋ 自訂風格…」入口、起手為複製現有風格、即時預覽走 `applyBpmnStyle` 同一路徑）＋ `POST`／`DELETE /api/bpmn-styles`；新增內建 `client-blue`「客戶藍」包（§6.3，只加宣告式定義）；三路徑一致性以原地擷取的真交付程式碼＋交付 PNG 逐像素統計驗證；修掉「交付鏈搶在自訂風格檔載入前渲染 → 悄悄退回原生」的競態。回歸：BST2 36/36、BST4 38/38、API 16/16。未部署，待指揮官 `Deploy_Harness.ps1`。 |
| 2026-09-24 | v0.4 | Hana | Phase 4（BST4）BST4-1／BST4-2 實作完成：`typeColors` 改宣告式 `match:[...]`（三包色值/順序照舊）、新增 `fontColor`／`geometry.laneBorder`／`geometry.laneHeader.fillByDepth` 三個 schema 欄位（未填零改變）；`GET /api/bpmn-styles` 讀 `global-knowledge/bpmn-styles/*.json` 並與內建包合併（同 id 使用者檔為準）。BST2 的 36 項回歸全數通過。BST4-3（編輯 UI）／BST4-4（`client-blue` 包）／BST4-5（三路徑一致性驗證）尚未做，見 §6.4。 |
| 2026-09-17 | v0.1 | Charles + Hana | 初版。語意／外觀分離的 Style Pack 設計；三期分工（資料模型＋切換 UI／形狀幾何 renderer／交付鏈＋draw.io）；記錄「純 CSS 的視覺屬性會在交付光柵化時掉」與「存檔往返必須保留 style」兩個實作鐵則。 |
| 2026-09-17 | v0.3 | Hana | Phase 2（BST2）實作完成：`HarnessStyleRenderer`（priority 1500 委派式接管 `render.shape`/`render.connection`，不重寫 BpmnRenderer）、`pack.geometry`（方角矩形／終端節點環／閘道外觀／泳道標題帶／連線轉角）、`bpmnModelerOpts` 統一四個 modeler 建立點。修掉兩個坑：inline 塗色蓋掉幾何線寬（改用 `data-harness-geo` 標記）、以及既有「單一元件字級」選擇器錯誤導致從未生效。隔離埠 3399 真實 Chromium 回歸 36/36 通過。 |
| 2026-09-17 | v0.2 | Hana | Phase 1（BST1）實作完成：`BPMN_STYLE_PACKS`（bpmn/visio）、`applyBpmnStyle`＋套件色/手動色判斷（`_harnessPackColoredIds`）、`_bpmnPaintSvgDetails`（inline 視覺屬性）、`harness:` 屬性持久化（`.bpmn`＋`flow.json` 雙向）、工具列風格下拉。Node 單元測試涵蓋邏輯層；瀏覽器渲染驗證（兩風格外觀差異／console 無錯誤）待指揮官 Deploy 後目視確認，尚未執行。§4 Phase 1 同步記錄實際做法。 |

---

## 6. Phase 4（BST4）— 自訂風格（全域） ＋ 內建「客戶藍」預設包

> 提出：2026-09-22（Charles 提供一張客戶慣用的流程圖範例，要求「能不能自訂 style，可以是全域的」）
> Status: DRAFT（待指揮官拍板後執行）

### 6.1 需求

1. **自訂風格**：使用者（非 Hana 改程式）能自己定義一份風格，存成資料、**全域共用**（跨工作區），在「風格 ▾」下拉中與內建風格並列。
2. **以範例圖為藍本，內建一份「客戶藍」風格包**：泳道以**粗虛線**分隔、泳道標題列**藍底／綠底（兩層不同色）**、節點**白底＋亮藍外框**、連線**亮藍**、文字**全黑**。

### 6.2 架構影響（查證後）

現行 `BPMN_STYLE_PACKS` 的 `typeColors` 用 **JS 函式** 作判斷（`test: t => t.includes('Task')`），**無法直接序列化成 JSON**。要支援使用者自訂，必須先把 pack 改成**純宣告式**：

```
typeColors: [ { match: ['Task','SubProcess'], fill: '#ffffff', stroke: '#00b0f0' }, ... ]
```

內建三包（`bpmn`／`visio`／`drawio`）同步改寫為宣告式，**色值一律照舊**，確保既有圖零改變。

**儲存位置**：`global-knowledge/bpmn-styles/<id>.json`（全域，跨工作區共用，與 `global-knowledge/voice-config.json` 同套路）。載入時與內建包合併，**同 id 以使用者檔為準**（使用者可覆寫內建包，但內建包本身不被改寫，刪掉 json 即復原）。

**pack schema 需新增的欄位**（範例圖逼出來的，內建包不填＝行為不變）：

| 欄位 | 用途 | 觸及 |
|---|---|---|
| `fontColor` | 強制文字顏色（範例圖要求全黑） | `_bpmnPaintSvgDetails` |
| `geometry.laneBorder` | 泳道框線 `{ dash: '6,4', width: 2, stroke: '#808080' }` | `HarnessStyleRenderer` |
| `geometry.laneHeader.fillByDepth` | 巢狀泳道**依層級**給不同底色（範例圖：層別藍、角色綠） | `HarnessStyleRenderer` |

⚠️ 上述三項是 Phase 4 唯一動到 renderer 的地方，**必須跑 BST2 留下的 36 項回歸**（`node .worktable/artifacts/bst2/mirror/run-test.js`）確認沒有回頭破壞改色／字級／泳道方向／自動排版。

### 6.3 「客戶藍」（`client-blue`）首發值（取自範例圖的近似取色，上線後可微調）

- Task／SubProcess：`fill #ffffff`、`stroke #00b0f0`
- Gateway（菱形）：`fill #ffffff`、`stroke #00b0f0`
- Event：`fill #ffffff`、`stroke #00b0f0`
- Lane：`fill #ffffff`、`stroke #808080`；`laneBorder { dash:'8,5', width:2 }`
- `laneHeader.fillByDepth`：`['#9dc3e6'（層別列・藍）, '#c6e0b4'（角色列・綠）]`
- `edgeColor '#00b0f0'`、`strokeWidth 1.5`、`fontColor '#000000'`、`shadow false`
- `geometry.cornerRadius 0`、`connectionCorner 'sharp'`

> **誠實界定**：這是「觀感接近範例圖」，不是像素複刻。範例圖左側的灰色總標題欄、以及浮水印，屬於該文件的版面元素而非流程圖風格，**不納入風格包**。

### 6.4 分段

- **BST4-1**：pack 宣告式化 ＋ 全域自訂風格檔（讀取／合併／下拉並列）＋ 三個新 schema 欄位 ＋ BST2 回歸。**已實作（2026-09-24）**：`typeColors` 改為 `{ match: ['Task',...], fill, stroke }`，判斷邏輯集中在 `_bpmnPackColor`（`match.some(m=>type.includes(m))`，先到先贏順序與原本相同）；三個內建包色值/順序逐一照舊。新增 `fontColor`（`_bpmnPaintSvgDetails` inline `text.style.fill`，不掛 class，遵守 §3.1）、`geometry.laneBorder`（`_bpmnReshapeGfx` 對 Lane/Participant 的 rect 設 `stroke-dasharray`/`stroke-width`/`stroke`）、`geometry.laneHeader.fillByDepth`（新增 `_bpmnLaneDepth(el)` 算「有幾層 `bpmn:Lane` 祖先」，依此索引陣列取色，超出長度沿用最後一個）三個 schema 欄位，三包皆未填＝行為零改變。BST2 的 36 項隔離埠 3399 回歸全數通過（`_bpmnLaneDepth` 已補進 `mirror/extract.js` 擷取清單）。
- **BST4-2**：全域自訂風格檔。**已實作（2026-09-24）**：`portal/server.js` 新增 `GET /api/bpmn-styles`，讀 `global-knowledge/bpmn-styles/*.json`（比照 `voice-config.json` 的單純讀檔手法，不建索引），目錄不存在或單一檔案壞掉一律跳過、不報 500。前端 `loadCustomBpmnStyles()`（`portal/index.html`）在 `init()` 非阻塞呼叫，把回傳的 pack 併入 `BPMN_STYLE_PACKS`（同 id 以使用者檔覆蓋，內建定義本身不被改寫、刪掉 json 即復原），並補刷新已畫出的「風格 ▾」下拉、保留使用者當下選值。**誠實界定**：這條端到端流程（fetch → 合併 → 下拉補新選項）只做了程式碼審視＋隔離單元測試（directory 缺失／json 壞掉兩種情境），未在真實瀏覽器對正式 `/api/bpmn-styles` 打過（本次冒煙用的隔離埠 3399 是純靜態鏡射、沒有這條 API，且本排程禁止另起完整 server）。**BST4-3（編輯 UI）與 BST4-4（`client-blue` 內建包）尚未實作**——本節分段標題原本把「自訂風格編輯 UI＋client-blue＋三路徑驗證」也算進 BST4-2，但 `.worktable/TASK.md` 已把它拆成獨立的 `BST4-3`/`BST4-4`/`BST4-5`，以 TASK.md 為準，本次僅完成 BST4-1／BST4-2。
- **BST4-3**：自訂風格編輯 UI。**已實作（2026-09-24）**：「風格 ▾」下拉最後固定掛 `＋ 自訂風格…`（`value='__custom__'`，`bpmnSetStyle` 攔截後還原下拉值再開編輯器）。編輯器起手**一律是「複製一份現有風格再改」**（頂端「複製自現有風格」可換底稿），可編輯每條 `typeColors` 規則的填色／線色、`edgeColor`／`strokeWidth`／`fontFamily`／`fontColor`／`shadow`、`geometry.cornerRadius`／`connectionCorner`、`geometry.laneHeader`（寬度、單一底色或多層 `fillByDepth`，可增減層）、`geometry.laneBorder`（虛線樣式／線寬／顏色）。即時預覽**不另做一套渲染**：草稿 pack 掛進 `BPMN_STYLE_PACKS` 後直接呼叫 `applyBpmnStyle`，與正式切換走同一條路徑（避免「預覽好看、切過去卻不一樣」）；取消會移除草稿 pack 並還原原風格。存檔／刪除新增 `POST /api/bpmn-styles`／`DELETE /api/bpmn-styles/:id`，代號一律 `^[a-z0-9][a-z0-9_-]{0,39}$`，前後端各擋一次（防路徑穿越）。**誠實界定**：編輯器的 DOM 互動未在真實瀏覽器點過（鏡射是純靜態伺服器、且本排程禁止另起完整 server／部署）；已驗的是下拉入口、代號正規化、表單寫回 pack 的路徑解析、pack 可序列化，以及三個 API 路由的行為（`.worktable/artifacts/bst4/api-test.js`，16/16，未起 server）。
- **BST4-4**：內建 `client-blue`「客戶藍」包。**已實作（2026-09-24）**，值照 §6.3（`Participant` 比照 `Lane` 取 `#ffffff`／`#808080`；未指定 `gatewayStrokeWidth`／`eventRing`，故閘道與事件一律吃 `strokeWidth 1.5`）。只加宣告式定義，未動 `HarnessStyleRenderer`／`applyBpmnStyle`／`bpmnModelerOpts`。真實 Chromium 逐項量測 14 項全過（含切回原生後完全復原），截圖 `.worktable/artifacts/bst4/style-client-blue.png`。
- **BST4-5**：回歸與三路徑一致性。**已完成（2026-09-24）**：BST2 的 36 項 **36/36**；新增 `run-test-bst4.js` **38/38**（同一套隔離埠 3399 純靜態鏡射，未起第二顆 server）。三路徑一致性把 `_renderBpmnXmlInto`（擬真預覽／PDF）與 `_svgToPngDataUrl`（烤入前光柵化）**從 `index.html` 原地擷取**來跑真程式碼，逐項比對畫面 vs 擬真 SVG 的填色／線色／連線色／字色／兩層泳道標題列，並把交付 PNG 畫回 canvas **逐像素統計**確認風格真的烤進點陣圖（含原生風格對照組排除巧合）。**修掉一個競態**：交付鏈可能搶在 `loadCustomBpmnStyles()` 完成前渲染 → 自訂風格悄悄退回原生（正是 §3 要防的狀況）；改法是 `loadCustomBpmnStyles()` 記住自己的 promise、`_renderBpmnXmlInto` 解析風格前先 `await bpmnCustomStylesReady()`。**順帶發現（未改）**：BST2 的 `B8`「連線直角接合」量到的是連線 visual 第一個子節點 `<defs>`（箭頭 marker 定義）而非連線本身，`<defs>` 的 `stroke-linejoin` 預設就是 `miter` → 該項為弱斷言／潛在偽陽性；本次 `L9` 已改用 `.djs-visual > path` 量真正的連線，`run-test.js` 維持不動以保留 36 項基準，建議日後併入修正。

### 6.5 開放決策（待指揮官拍板）
1. 自訂風格是否要**編輯 UI**（建議：要。否則每次微調配色都得 Hana 改程式＋重新部署）。
2. 「客戶藍」要不要**設為該類客戶文件的文件層預設**（BST3 已做文件層預設機制，只差指定）。

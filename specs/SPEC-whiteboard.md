# SPEC — 白板（Whiteboard：手繪 + 自動美化 + AI 判讀）

> Status: 定稿 for build ｜ Owner: Charles + Hana ｜ 規劃日 2026-08-04
> 影響範圍：`portal/vendor/excalidraw/`（新增，離線 vendor）、`portal/index.html`（白板面板 + 美化引擎 + 框選判讀）、`portal/server.js`（whiteboards API + 框選判讀轉發）、`<workspace>/.harness/whiteboards/`（持久化，工作區內）、`portal/views/settings.js` 的 `NAV_ITEMS` 與 `server.js` 的 `DEFAULT_NAV`（白板納入既有功能選單開關）、`.harness/commands/whiteboard.md`（指令技能）。
> 一句話：**一塊無邊界的手繪白板**——畫歪的線自動變直、隨手畫的框自動變正、圈起一段筆跡叫 AI 判讀（預設轉文字、也能自己下 prompt），存在當下工作區、可續畫、可匯出 PNG，而且**Hana 也能在上面畫**。

---

## 1. 動機與定位（與既有能力的分界）

- 這**不是**便條貼（`SPEC-stickies`：文字待辦、自由拖放但不畫圖），也**不是** BPMN 流程圖編輯器（`SPEC-doc-editing`：結構化泳道流程、綁文件），也**不是**簡報（`SPEC-presentation-core`）。
- 這是**自由思考的畫布**：開會時隨手畫架構、圈重點、寫想法。輸出以 **PNG** 為主，不進文件管理、不進 docgraph（決策 3）。
- 與現有能力唯一共用的是：面板註冊機制（`showPanel(id)`）、工作區隔離（`resolveWorkspace`）、離線 vendor 慣例（`portal/vendor/`）、以及一次性模型呼叫（`_spawnCliPrintOnce`）。

## 2. 決策摘要（Charles 2026-08-04 拍板）

| # | 議題 | 拍板 |
|---|---|---|
| 1 | 底座 | **用 Excalidraw**（MIT、離線 vendor 化），不自己從零刻畫布。接受引入 React UMD。 |
| 2 | 存放 | **存當下工作區**（`<workspace>/.harness/whiteboards/`），依天條不寫工作區外。 |
| 3 | 文件管理 / docgraph | **先獨立**，不整合（現行兩套機制不同），日後再看怎麼併。 |
| 4 | AI 判讀 | 要「**滑鼠框選 → 多模態判讀**」：**預設＝文字辨識**，也可**自己下 prompt** 讓 AI 判讀框選內容。手寫轉文字走這條路（**手動觸發**，不即時自動轉）。 |
| 5 | 視覺風格 | **保留 Excalidraw 手繪粗糙風**。 |
| 6 | 加分功能 | ① 箭頭吸附連線 **要**（Excalidraw 原生 binding，驗證即可）；② 匯出**只做 PNG**；③ OCR 併入決策 4；④ **Hana 也能畫**（最好要有）。 |
| 7 | 定位為**平台全域功能** | 白板不是某專案專屬，是**平台級能力**（其他專案馬上會用）。進側邊欄選單，並照**既有「全域功能」模式**納入左下角齒輪 →「工作區設定 → 功能選單」的顯示開關（`harness.json` 的 `nav`，見 `SPEC-workspace-settings.md` D1）。**不另建機制**（§4.4）。 |

## 3. 架構分層

| 層 | 內容 | 來源 |
|---|---|---|
| **L0 底座** | 無邊界畫布、縮放平移、筆粗細/顏色、選取、複製貼上（文字＋圖片）、箭頭吸附、存檔/續畫、PNG 匯出 | Excalidraw 原生 |
| **L1 形狀美化** | 手繪 → 直線／橢圓（含正圓）自動變正（不重分類其他形狀，見 §6.2.1） | **自製**（§6） |
| **L2 AI 判讀** | 框選 → 截圖 → 模型判讀（預設文字辨識／自訂 prompt）→ 結果回填白板 | **自製**（§7），底層走既有一次性模型呼叫 |
| **L3 Hana 也能畫** | 口述 → Hana 生成 Excalidraw 元素 → 白板即時出現 | **自製**（§8） |

## 4. 底座 vendor 化（L0）

### 4.1 檔案落點
```
portal/vendor/excalidraw/
  react.production.min.js          # React 18 UMD
  react-dom.production.min.js      # ReactDOM 18 UMD
  excalidraw.production.min.js     # @excalidraw/excalidraw UMD（釘版本）
  excalidraw.min.css
  fonts/                           # Excalifont / Virgil / Cascadia 等（EXCALIDRAW_ASSET_PATH 指這裡）
```
- **釘版本**：`@excalidraw/excalidraw` 取**最後一個仍出 UMD 的穩定版**（0.17.x 系列）；新版改 ESM-only、無法照現行 `<script>` 慣例離線載入。取得方式：`npm pack @excalidraw/excalidraw@<pinned>` 解壓後複製 `dist/` 需要的檔，**不留 node_modules、不改 package.json**。
- **已知地雷（必寫在程式碼註解裡）**：
  1. Excalidraw UMD 會讀 `process.env.IS_PREACT` → 載入前必須先 `window.process = window.process || { env: {} };`，否則整包炸 `process is not defined`。
  2. 字型/圖示走 `window.EXCALIDRAW_ASSET_PATH = '/vendor/excalidraw/'`（**尾斜線不可省**），否則離線環境會去打 unpkg、變成無網路就沒字型。
  3. React UMD 必須在 excalidraw 之前載入且掛在 `window.React` / `window.ReactDOM`。
- **延遲載入**：這幾支加起來約 2MB，**只在第一次開白板面板時才動態 `<script>` 注入**，不進 portal 開機路徑（portal 首屏不能被拖慢）。

### 4.2 面板與掛載
- 側邊欄新增「🖊️ 白板」入口（`id="menu-whiteboard"`、icon `pen-tool`），排在「📊 專案管理」之後，走既有 `showPanel(id)` 互斥機制（`switchToWhiteboard()`，比照 `switchToPm()`）。
- 白板按鈕外層容器要掛 `data-nav="whiteboard"`，納入既有的 `harness.json` → `nav` 顯示開關機制（§4.4）。
- 面板結構：頂欄（白板清單下拉／＋新白板／重新命名／匯出 PNG／🔍 AI 判讀）＋ 主畫布容器（`ReactDOM.createRoot` 掛 `<Excalidraw>`）。
- 深淺色：把 portal 的 `.dark` 狀態同步給 Excalidraw 的 `theme` prop，切換主題時一起變（吸取「全螢幕撞色字消失」教訓）。

### 4.3 L0 各項對應（不用自製，但要逐項驗證）
| 需求 | Excalidraw 對應 | DoD |
|---|---|---|
| 筆大小/顏色 | 原生左側工具列 | 畫得出不同粗細顏色 |
| 無邊界＋縮放 | 原生 scroll/pinch/`Ctrl+滾輪` | 縮放後元素座標正確、存檔還原不跑位 |
| 存檔/續畫 | `getSceneElements()` + `getAppState()` → 存 JSON；重開 `initialData` 還原 | 關掉重開，圖與捲動位置都在 |
| PNG 匯出 | `exportToBlob({ mimeType:'image/png' })` | 匯出檔可開、含背景、含中文字 |
| 複製貼上文字/圖片 | 原生剪貼簿處理 | 貼上截圖 → 變成 image 元素；貼上文字 → 變成 text 元素 |
| **箭頭吸附連線** | 原生 arrow binding | 箭頭端拉到矩形上 → 吸附；拖矩形時箭頭跟著走 |

### 4.4 納入既有「功能選單」— 決策 7（白板＝平台全域功能）

> **修正（v1.2）**：這套機制**早就存在**，由 `SPEC-workspace-settings.md` 定義並已上線——左下角齒輪 → `/app/settings`「工作區設定」→ **② 功能選單**（一個平台功能一個 checkbox）。白板**不新建任何機制**，只是照既有「全域功能」模式**多掛一個 key**。**不要**新造 `PLATFORM_FEATURES` 常數、`portal-nav.json` 或 `/api/portal-nav`（那是本 spec v1.1 的誤判，已作廢）。

「全域功能」的定義（沿用 `SPEC-workspace-settings.md` D1）：平台級能力，**標籤、圖示、排序一律不開放各工作區自訂**，只給「顯示／不顯示」勾選；開關值存在該工作區 `harness.json` 的 `nav`，缺鍵＝顯示（opt-out）。白板正是這一類，與 CodeGraph／DocGraph 那組（`tools`，屬工作區專屬工具、分隔線下方）**不同組**——白板放**上半的 nav 清單**。

要動的四處（全部是既有結構的「加一行」）：

| # | 檔案 | 改法 |
|---|---|---|
| 1 | `portal/server.js` `DEFAULT_NAV`（約 6140 行） | 加 `whiteboard: true`。這同時就是 `PUT /api/manifest` 的已知鍵白名單（`if (!(k in DEFAULT_NAV)) continue;`），不補這行前端存了也會被丟掉。 |
| 2 | `portal/views/settings.js` `NAV_ITEMS`（約 11 行） | 在 `pm` 之後加 `{ key: 'whiteboard', label: '白板' }`。 |
| 3 | `portal/index.html` 側邊欄 | 白板按鈕外層容器加 `data-nav="whiteboard"`（比照 `data-nav="pm"` 的 `<div class="px-1">`），排在 `pm` 之後。`applyManifest()` 既有的 `querySelectorAll('[data-nav]')` 迴圈會自動納管，**不必改 `applyManifest()`**。 |
| 4 | 本工作區 `harness.json` | **不用改**：缺鍵＝顯示。 |

- **順序**：`DEFAULT_NAV`、`NAV_ITEMS`、側邊欄三處都放在 `pm`（專案管理）之後，三邊順序保持一致。
- **套用時機**：既有行為——開機 `applyManifest()` 套一次；在設定頁存檔且編輯的是當前工作區時，熱套用不必重整。
- **DoD**：工作區設定頁的「功能選單」看得到「白板」且預設打勾；取消 → 存檔 → 側邊欄白板消失、重整仍消失；再勾回來 → 回來；改別的工作區的設定不影響當前工作區；舊 `harness.json`（無 `whiteboard` 鍵）→ 白板照樣顯示。

## 5. 資料模型與 API

### 5.1 落點（天條：只寫當前工作區）
```
<workspace>/.harness/whiteboards/
  index.json                 # [{ id, title, createdAt, updatedAt }]
  <id>/board.json            # { id, title, elements: [...], appState: {...}, files: {...}, updatedAt }
  <id>/assets/               # 框選判讀產生的區域 PNG（隨白板生死）
```
- `id` = `wb_<ms>_<rand>`（比照 `note_`/`sched_` 慣例）。
- `files` 存 Excalidraw 的 binary files map（貼上的圖片，base64 dataURL）；**大圖護欄**：單一白板 `board.json` 超過 8MB 時前端出提示（不擋存，只警告）。
- 工作區隔離：所有端點經 `resolveWorkspace(req)`（`X-Workspace` 標頭）；**寫入類 API 帶中文路徑 header 會誤判 not found（既有已知 bug）→ 前端一律先 `GET` 拿到 id 後直打 id，比照 `/pm` 的處理**。

### 5.2 端點（`portal/server.js`）
| 端點 | 用途 |
|---|---|
| `GET /api/whiteboards` | 列當前工作區白板（讀 `index.json`）。 |
| `POST /api/whiteboards` | 新建，body `{title?}`，回整筆。 |
| `GET /api/whiteboards/:id` | 讀單一白板完整內容（elements/appState/files）。 |
| `PUT /api/whiteboards/:id` | 存檔，body `{title?, elements?, appState?, files?}`；刷新 `updatedAt` 並同步 `index.json`。 |
| `DELETE /api/whiteboards/:id` | 刪除（**破壞性**，前端二次確認）。 |
| `POST /api/whiteboards/:id/interpret` | **AI 判讀**（§7）：body `{image: dataURL, prompt?, mode:'text'\|'custom'}` → 回 `{text}`。 |
| `POST /api/whiteboards/:id/elements` | **Hana 畫圖**（§8）：body `{elements:[...], mode:'append'\|'replace'}`。 |

- 存檔採**前端 debounce 自動存**（停筆 1.5 秒 → `PUT`；另每 30 秒保底存一次），加上頂欄手動「儲存」。寫檔「讀→改→寫」全量覆蓋，比照 `notes.json`/`pm.json`（單人使用、量小、免資料庫）。

## 6. L1 形狀美化（自製，`portal/index.html`）

### 6.1 觸發時機
- 掛 `<Excalidraw onChange>`：偵測「**剛完成**的 `freedraw` 元素」（新出現且 `pointerup` 後不再變動）→ 跑辨識 → 若判定為某個幾何形，用 `updateScene` **原地替換**成原生元素。
- **不碰**已存在的元素、不碰 text/image/已美化的元素 → 避免無限迴圈。

### 6.2 辨識管線（純前端幾何，不用模型）
1. **重採樣＋簡化**：對筆跡點做等距重採樣（64 點），再跑 RDP 簡化，ε = 對角線長 × 2%。
2. **開/閉判定**：首尾點距離 < 周長 × 15% → 視為封閉。
3. **封閉**：
   - 各點到質心距離的變異係數 < 0.12 → **橢圓**（長短軸比 < 1.15 → 正圓）。
   - 其他 → 不動（保留手繪）。**不猜多邊形**（三角形/矩形/菱形）——2026-08-10 拿掉，見下方「範圍收斂」。
4. **開放**：
   - 線性回歸 R² > 0.95 → **直線**。
   - 其餘 → 保留 freedraw，但做 Catmull-Rom 平滑（曲線變滑順）。**不猜箭頭**——2026-08-10 拿掉，見下方「範圍收斂」。

### 6.2.1 範圍收斂（2026-08-10）
指揮官實測回報：形狀重分類「猜太超過」——手寫數字「2」被誤判成箭頭、手繪梯形被誤判成菱形，這類「連形狀種類都改猜」的美化，比原本想解決的「線不直/圓不圓」問題本身更煩人。因此拿掉多邊形（三角形/矩形/菱形）與箭頭判定，`wb-beautify.js` 現在只做兩件事：封閉筆跡夠圓 → 變正圓/橢圓；開放筆跡夠直 → 拉直成線。其餘一律保留原手繪（開放筆跡會做 Catmull-Rom 平滑，但不改變形狀種類）。
5. **屬性繼承**：`strokeColor` / `strokeWidth` / `strokeStyle` / `roughness` / `opacity` 一律沿用原手繪，**`roughness` 保持手繪粗糙風**（決策 5）。
6. **信心門檻**：每條規則給分，低於門檻一律不動 —— **寧可不美化，也不要亂改**。

### 6.3 反悔機制（必要，否則會很煩）
- 替換後在該元素旁浮出小徽章「↩ 保留手繪」，**3 秒後自動消失**；點它 → 換回原筆跡。
- 同時原生 `Ctrl+Z` 也要能一步退回（把「替換」包成單一 history entry）。
- 頂欄提供**總開關**「自動美化 開/關」，狀態存進 `appState`（跟著白板走）。

## 7. L2 框選 AI 判讀（決策 4）

### 7.1 互動
1. 頂欄「🔍 AI 判讀」→ 進入**框選模式**（游標變十字，畫布暫時不接收繪圖）。
2. 滑鼠拖出矩形 → 放開 → 彈出小面板：
   - **模式一「文字辨識」（預設）**：直接送出，prompt 固定為「辨識這張圖裡的手寫文字，只輸出文字本身，不要加說明」。
   - **模式二「自訂」**：一個輸入框讓 Charles 自己下 prompt（例：「這是什麼架構？幫我列出元件」「把這張圖轉成表格」）。
3. 送出 → 「辨識中…」→ 結果面板顯示模型回覆，兩顆動作：
   - **插入白板**：把結果變成 text 元素放在框選區右側（文字辨識模式可選「取代原筆跡」——刪掉框內 freedraw、換成文字）。
   - **複製**：丟剪貼簿，不動白板。
   - 也可**直接關掉**（不滿意就重下 prompt，不強迫接受）。

### 7.2 實作
- 前端：`exportToBlob({ elements: 框內元素, exportPadding: 8 })` 產 PNG（**只匯出框內元素**，不是整張畫布截圖）→ base64 → `POST /api/whiteboards/:id/interpret`。
- 後端：把 PNG 寫進 `<id>/assets/interpret_<ts>.png`（天條：工作區內、隨白板生死），再用既有 **`_spawnCliPrintOnce`** 呼叫一次性模型，prompt 內含該圖**絕對路徑**並要求模型 Read 它（比照 chat 多模態附件走「路徑 + Read」而非 base64 塞 prompt 的既有模式）。
- 回傳純文字。**失敗誠實回報**（模型沒裝／逾時／看不懂就照實說），不假裝辨識成功。
- 護欄：單次逾時 90 秒；框選區 > 4000px 邊長時先縮放；同一時間只允許一個判讀請求在跑。

### 7.3 為什麼不做即時自動轉字
- 手寫辨識誤判率高，**寫到一半被自動改字比不轉更糟**；且每次都要打模型（延遲＋額度）。手動觸發＝完全可控。

## 8. L3 Hana 也能畫

### 8.1 能力
- Charles 對 Hana 說「在白板上畫一個三層架構圖：前端→API→資料庫，用箭頭連起來」→ Hana 生成 Excalidraw 元素 → **白板上直接出現**。
- 也能請 Hana**整理版面**（把亂放的框對齊、等距排列）——讀現有 elements、算好新座標、寫回。

### 8.2 實作
- `.harness/commands/whiteboard.md` 指令技能：`/whiteboard <要畫什麼>`。技能內容含：如何 `GET /api/whiteboards` 找到目前白板、Excalidraw 元素 JSON 的最小必要欄位（`type/x/y/width/height/strokeColor/backgroundColor/roughness/seed/id/...`）、箭頭 binding 的 `startBinding/endBinding` 寫法、以及**天條**（只寫當前工作區）。
- 後端 `POST /api/whiteboards/:id/elements`：把 Hana 給的元素**補齊必要預設欄位**（缺 `id`/`seed`/`versionNonce` 就補；防止畫面炸掉），`append` 或 `replace` 進 `board.json`。
- 前端同步：白板面板開啟時**每 2 秒輪詢** `updatedAt`，變了就 `updateScene`（單人使用，輪詢足夠，不引入 SSE）。**護欄**：本地有未存變更時不覆蓋（先存再套用），避免蓋掉 Charles 正在畫的東西。

### 8.3 讓 Hana「看得見」白板（WB5，2026-08-06 追加）

**問題（指揮官 2026-08-05 實測回報）**：叫 Hana 照著畫「三角形與圓交接的那塊扇形」，畫出來完全不像。
**根因**（已核實，非猜測）：CTX5 的 `whiteboard` context provider 注入的是 `board.json` 的**文字資料**（型別／座標／尺寸／文字／箭頭 binding）。指揮官指的那塊扇形是「三角形一條邊切過圓」的**幾何交集**——它在資料裡**根本不是一個元素**，是兩個元素疊出來的視覺結果。Hana 只能從頂點與圓心半徑腦補弦切在哪、弧多大，於是畫出一塊有直邊的多邊形而不是「一邊直、一邊弧」的弓形。
**諷刺點**：真正「用眼睛看」的能力白板上**早就有**（§7 WB3 框選判讀 `exportToBlob` → `/interpret`），只是頭像對話那條路沒接上它。

#### 8.3.1 讓 Hana 看得到畫面
- 在白板脈絡下，頭像對話送出時**附上當前畫布的 PNG**，讓模型真的看圖，不再純靠座標推論。
- **復用既有 chat 附件機制**（`POST /api/chat` 的 attachments／`chatHistoryDir/attachments`，見 `SPEC-chat-multimodal.md`），**不另造上傳管線**。
- 技術卡點與解法：`router.getChatContext()` 是**同步**的，而 `exportToBlob()` 是非同步 → 白板 view 自行維護一份**最新畫布縮圖快取**（存檔／`onChange` debounce 後在背景產生，長邊上限約 1600px），`getChatContext()` 只回傳快取的 dataURL；快取還沒好就照舊只送文字脈絡（**降級而非卡住**）。
- 護欄：空白板不附圖；縮圖產生失敗只記 log、不影響對話；圖檔落點遵守天條（當前工作區）。

#### 8.3.2 幾何交集要用算的，不是用猜的
- 「A 切 B 的那一塊」這類需求，不可用四點自由曲線硬湊。做法：算出直線與圓／橢圓的**真實交點**，弧段以**等角取樣**（每 2–4°）成點列，與直邊接成封閉輪廓，輸出 Excalidraw `line` 元素（`points` 相對於 `x/y`，首尾閉合）。
- 這段幾何工具寫成**可被 Hana 直接呼叫的小函式庫**（落點與 `wb-beautify.js` 同層或 `/whiteboard` 技能可引用的說明），避免每次重新推導。

#### 8.3.3 脈絡裡不要出現內部 id
- 現行 provider 每個元素一行帶 `id`（如 `3R6il`、`Fy0Y8i`），Hana 會把這些代號直接講給指揮官聽——**他看不懂，那是內部細節**。
- 改為：對指揮官說話時一律用**人看得懂的描述**（「左邊的三角形」「中間的圓」）；id 僅供 API 寫回時內部使用，不出現在回覆文字裡。provider 注入時同時給「序號＋方位描述」與 id，並明寫此規則。

## 9. 開放決策（皆已給預設、不阻擋開工）

- **D1 白板清單位置**：面板頂欄下拉切換（預設）／或側邊欄列出所有白板。→ 先做下拉。
- **D2 自動美化預設值**：預設**開**（可隨時關）。→ 若實測誤判煩人，改成預設關。
- **D3 判讀用哪個模型**：預設用**目前 chat 選定的 provider/model**；若該 provider 不支援讀圖則退回 Claude。→ 先這樣，之後可在面板加模型下拉。
- **D5 縮圖何時產生（WB5）**：預設**存檔後在背景產生**（跟著既有 debounce 存檔走，不另開計時器）；若實測發現大白板產圖太慢拖到互動，改為「點頭像時才產、對話等一下」。
- **D6 縮圖上限與成本（WB5）**：預設長邊 1600px、PNG；每次頭像對話都附一張最新縮圖。若發現額度吃太兇，改為「只在該回合訊息像是要畫圖／看圖時才附」。
- **D4 白板要不要納入 git**：`.harness/whiteboards/` 建議**加進工作區 `.gitignore`**（客戶 repo 不該被塞白板）。→ 先 ignore；Charles 要版控再說。

## 10. 分階段（對應 `.worktable/TASK.md §WB`，四個獨立手動 schedule）

| Phase | 內容 | 相依 | 模型 |
|---|---|---|---|
| **WB1** | Excalidraw vendor 化 + 白板面板 + **納入既有功能選單開關（§4.4）** + whiteboards API + 存檔/續畫 + PNG 匯出 + 箭頭吸附驗證（L0 全套） | 無 | Sonnet |
| **WB2** | L1 形狀美化引擎（直線/橢圓，2026-08-10 收斂為不做形狀重分類）+ 反悔機制 + 總開關 | WB1 | Sonnet |
| **WB3** | L2 框選 AI 判讀（文字辨識預設 + 自訂 prompt + 插入/取代/複製） | WB1 | Sonnet |
| **WB4** | L3 Hana 也能畫（`/whiteboard` 技能 + elements API + 輪詢同步 + 版面整理） | WB1 | Sonnet |
| **WB5** | 讓 Hana 看得見白板（§8.3：對話附畫布縮圖 + 幾何交集算得準 + 脈絡不吐內部 id） | WB4、CTX5 | Sonnet |

- WB2/WB3/WB4 都**只依賴 WB1**，彼此獨立、可任意順序。WB5 是 WB4 的修正輪，需 WB4 與 CTX5 已上線。

## 11. DoD（每階段自測）

- 自我修改平台程式（`server.js`/`index.html`）→ 改完走 `Deploy_Harness.ps1`（冒煙＋自動回滾）；git 由人類掌控、**不自行 commit**。
- 自測用**隔離埠 3499** ＋ temp `HARNESS_HOME` ＋明指真 `HARNESS_VENV`；**勿起第二顆完整 server**（會搶 Telegram token／燒額度）。
- UI 類驗證用 Playwright headless 實跑並**截圖**（淺色＋深色各一張），不靠讀程式碼推論。
- 天條：白板資料只寫**當前工作區** `.harness/whiteboards/`；不寫 `C:\Users`、系統暫存、或工作區外。
- 誠實原則：沒實測到的項目照實標「以程式碼路徑檢視確認」，不謊報。

---

## Changelog
| Date | Version | Author | Description |
|:-----|:--------|:-------|:------------|
| 2026-08-06 | v1.3 | Charles + Hana | 指揮官實測「叫 Hana 照畫三角形與圓交接的扇形，畫出來完全不像」→ 新增 §8.3（WB5）：① 白板脈絡下頭像對話**附當前畫布縮圖**（復用既有 chat 附件機制，`getChatContext()` 同步限制以縮圖快取解決、產不出來就降級成純文字）；② 幾何交集**用算的**（直線⇄圓/橢圓真實交點 + 弧段等角取樣 → `line` 閉合輪廓），不用四點曲線硬湊；③ 脈絡與回覆**不吐內部元素 id**，改用「左邊的三角形」這類人話。新增開放決策 D5/D6，§10 表格新增 WB5 一列。 |
| 2026-08-04 | v1.2 | Charles + Hana | **更正 v1.1 的誤判**：功能選單開關機制早已存在（`SPEC-workspace-settings.md`：左下角齒輪 →「工作區設定 → ② 功能選單」，值存 `harness.json.nav`）。白板依指揮官指示定位為**平台全域功能**，改為**沿用**該機制（`DEFAULT_NAV` / `NAV_ITEMS` / `data-nav="whiteboard"` 各加一行），**作廢** v1.1 新造的 `PLATFORM_FEATURES`、`portal-nav.json`、`/api/portal-nav`。§4.4 全面改寫、§4.2 更正。 |
| 2026-08-04 | v1.1 | Charles + Hana | 決策 7：白板定位為**平台功能**，新增 §4.4「左下角齒輪：平台功能選單設定」（per-workspace 黑名單 `<workspace>/.harness/portal-nav.json`＋`/api/portal-nav`＋`PLATFORM_FEATURES` 單一來源），併入 WB1。更正 §4.2：現行 `harness.json` 並無 `nav` 欄位，顯示機制需一併新建。 |
| 2026-08-04 | v1.0 | Charles + Hana | 初版定稿。Excalidraw 底座（離線 vendor）、存當下工作區、與文件管理/docgraph 先獨立、自製形狀美化、框選多模態判讀（預設文字辨識＋自訂 prompt）、保留手繪風、箭頭吸附＋PNG 匯出＋Hana 也能畫。四階段 WB1–WB4，各獨立手動 schedule。 |

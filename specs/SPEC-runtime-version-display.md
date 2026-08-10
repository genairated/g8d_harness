# SPEC — 顯示目前運行版本（UI 常駐）

## 1. 動機

指揮官（Charles）常被 Hana 告知「這項已經在 vXX 修好了」，但 Portal UI 上完全看不出目前正在跑的是哪一版，也無法對照 Hana 口頭講的版本是否一致。

## 2. 現況（2026-08-03 盤點）

- `portal/server.js` 已有：
  - `BOOT_ID`（每次 process 啟動的隨機 id，用於偵測「有沒有重啟」）
  - `RUNNING_VERSION`（由 `__dirname` 反推 `.releases/vN/portal` 的 `vN`；跑在工作樹時為 `'dev'`）
- `/api/ping` 已回傳 `{ bootId, version }`，前端用它做「bootId 變了就自動重整」的輪詢（`index.html` ~7573-7585）。
- `/api/status` handler（`server.js` ~1093-1101）組出的 `statusData` **只放了 `bootId`，沒有 `version`**。
- `portal/index.html` 第 3960 行的 Dashboard 卡片已經有一行 `VER: ${statusData?.runningVersion || 'N/A'}`，但欄位名跟後端從未對上（後端沒回過 `runningVersion`），所以永遠顯示 `N/A`；且這個顯示只存在於「主看板」這一張卡片一角，切到其他 view（聊天、排程、文件…）就完全看不到。

結論：不是要生一個新機制，是把既有半成品（後端資料在、前端變數對錯）接通，並移到「不管在哪個畫面都看得到」的常駐位置。

## 3. 設計

### 3.1 後端

`/api/status` 的 `statusData` 物件新增：

```js
version: RUNNING_VERSION,
```

與既有 `bootId: BOOT_ID` 同一層、同一物件。不需要改 `/api/ping`（它已經是對的）。

### 3.2 前端 — 常駐顯示位置

側邊欄（`#sidebar`）底部「Bottom Footer Status」列（`index.html` 約 1279-1294 行，目前只有一顆綠點 + `Portal Online` 文字）——這是唯一不隨 router 切換而卸載、每個 view 都看得到的區塊，因此是版本號的正確歸宿。

顯示格式：`Portal Online · v31`（或 `Portal Online · dev`）。資料沿用 `/api/status` 呼叫後已存的既有全域 `statusData`，不得為此另開一支 fetch。

### 3.3 前端 — 順手修正

Dashboard 卡片（`index.html` 第 3960 行）原本的 `statusData?.runningVersion` 改成 `statusData?.version`，讓兩處版本字樣來源一致、不留一個恆為 `N/A` 的死欄位。

### 3.4 更新時機

現有 `/api/ping` 輪詢邏輯（bootId 變了 → 整頁 reload）已足以涵蓋「部署後版本號要跟著變」——reload 後 `/api/status` 會重新抓到新版本，不需要額外輪詢版本號。

## 4. 驗收

1. `/api/status` 回應含 `version` 欄位，值等於該 process 實際跑的 `.releases/vN`（或 `dev`）。
2. 側邊欄底部任一畫面都能看到目前版本號，且與 Dashboard 卡片一致。
3. 部署切版重啟後（bootId 變化觸發 reload），版本號自動更新為新版本，不需手動重新整理兩次。
4. 沒有任何一處版本顯示殘留 `N/A`（跑在工作樹時應顯示 `dev`，而非 `N/A`）。

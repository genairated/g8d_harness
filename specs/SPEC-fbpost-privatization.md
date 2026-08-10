# SPEC — FB 功能私有化拆分（FBPost Privatization / Plugin Extraction）

> Status: Draft v1.0 ｜ **不開源（本檔 export-ignore，不進公開版）**
> 關聯：[[SPEC-daily-reflection-post]]（FB 功能本體，已實作）、[[SPEC-telegram]]、[[SPEC-browser-pilot]]
> 前提：`.gitattributes` export-ignore 只對**已 commit 到私有 repo** 的檔生效；本規格涉及的新模組須先 commit 到私有 `charleskcl/harness`。

## 0. 目的

「每日心得貼文」功能（[[SPEC-daily-reflection-post]]，DEV-FBPOST-01~04）**已實作完成**。指揮官決定：此功能**不開源**。目標是把 FB 相關程式從共用檔中**抽離成一個私有可選插件**，使——

- **公開版（hana-ai-aide/hana-aide）**：`server.js`／`telegram.js` 內**零 Facebook 痕跡**（grep 不到 facebook/fb/貼文/reflection），功能不存在。
- **私有版（charleskcl/harness）**：功能完全不變（四按鈕核可 + 發文照常）。

不是「留著但停用」——是要讓 FB 碼在公開版**根本不存在**。

## 1. 現況盤點（已探勘）

| 檔案 | 性質 | 這次 diff | 處置 |
|:--|:--|:--|:--|
| `portal/render-service/facebook-post.js` | 100% FB | 新檔 | export-ignore |
| `portal/render-service/daily-activity.js` | 跨工作區昨日活動彙整（FB 專用素材） | 新檔 | export-ignore |
| `portal/render-service/reflection-prompt.js` | 心得生成 prompt（FB 專用） | 新檔 | export-ignore |
| `specs/SPEC-daily-reflection-post.md` | FB 規格 | 新檔 | export-ignore |
| `specs/SPEC-fbpost-privatization.md`（本檔） | 拆分規格 | 新檔 | export-ignore |
| `portal/hana_avatar_anime.jpg` | FB 貼文頭像素材 | 新檔 | export-ignore |
| `gmail_authorize_ipv4.py`、`youtube_authorize_ipv4.py` | 一次性 OAuth 腳本 | 新檔 | export-ignore |
| `portal/render-service/browser-pilot.js` | ⚠️ **通用**改良（UA/locale 偽裝、檔案上傳、/eval），只有註解拿 FB 當例子 | +31 | **留公開**，把註解「Facebook」改中性例子 |
| `portal/server.js` | FB 端點 `/api/telegram/fbpost-draft` + `fbPostFn`/`fbGenerateFn`（已 lazy-require） | +48 | **抽進插件**（見 §3） |
| `portal/telegram.js` | 四按鈕審核流程（`_fbApprove/_fbDiscard/_fbRedo/_fbEdit`、`_pendingFbDrafts`、`_awaitingEditFor`、callback 分派、`sendFbDraftForApproval`） | +170 | **抽進插件**（見 §3） |

## 2. 設計原則：共用檔只留「通用擴充點」

在 `server.js`／`telegram.js` 只保留**與 FB 無關的通用機制**（這些留公開無妨，甚至是不錯的擴充性賣點）；所有 FB 專屬邏輯移進**單一私有插件** `portal/render-service/fbpost-plugin.js`（export-ignore）。公開版因為插件檔不存在，`try/catch` 靜默跳過 → 零痕跡、零報錯。

## 3. 目標架構

### 3.1 `telegram.js` — 通用 callback 擴充點（留公開）
- 建構子加：`this._extraCallbackHandlers = [];`（通用，無 FB 字樣）。
- `_handleCallbackQuery` 的 if/else 分派鏈**最前面**加一段通用迴圈：
  ```js
  for (const h of this._extraCallbackHandlers) {
    if (await h(data, chatId, this)) return;   // handler 認領就結束
  }
  ```
- 建構子加通用文字攔截點（供「修改」流程用）：`this._extraTextInterceptors = [];`，`_handleUpdate` 在 `_route` 前先跑一遍（handler 認領回 true 就不走一般 route）。
- **移除**所有 `fbpost_*` 分派、`_fb*` 方法、`_pendingFbDrafts`、`_awaitingEditFor`、`sendFbDraftForApproval` → 全部搬進插件，插件透過上述兩個陣列 + 自帶狀態註冊。

### 3.2 `server.js` — 通用插件載入器（留公開）
- 在 `createTelegramBot` opts 組裝處**移除** `fbPostFn`/`fbGenerateFn`。
- 移除 `/api/telegram/fbpost-draft` 端點。
- 開機（bot 建好後）加一段通用可選載入：
  ```js
  try { require('./render-service/fbpost-plugin').register({ server: <router hook>, bot: telegramBot, HARNESS_HOME, spawn: _tgSpawnClaude }); }
  catch (e) { /* 公開版無此插件，靜默略過 */ }
  ```
- 需要一個通用「額外路由註冊」機制讓插件掛 `/api/telegram/fbpost-draft`（可用既有 pathname 分派前的 hook 陣列，或插件回傳 handler 由主 router 迭代）。**hook 命名保持中性**（`extraRoutes`），不得出現 fb 字樣。

### 3.3 `fbpost-plugin.js`（新檔，export-ignore）
- 匯出 `register({ server, bot, HARNESS_HOME, spawn })`。
- 內含**原本散在 server.js（48 行）+ telegram.js（170 行）的全部 FB 碼**：
  - `fbGenerateFn`（包 daily-activity.js + reflection-prompt.js + agent 呼叫）、`fbPostFn`（包 facebook-post.js）。
  - `_pendingFbDrafts`/`_awaitingEditFor` 狀態、四按鈕流程、`sendFbDraftForApproval` 對外入口、過期清理。
  - 透過 `bot._extraCallbackHandlers.push(...)` 註冊 `fbpost_*` callback；透過 `bot._extraTextInterceptors.push(...)` 註冊「修改」文字關聯；透過 `server.extraRoutes` 註冊 `/api/telegram/fbpost-draft`。
- 依賴 lazy require（facebook-post.js 等），與現行一致。

### 3.4 `browser-pilot.js`（留公開）
- 功能不動（UA/locale/upload/eval 是通用能力）。
- 把註解裡的「Facebook」示例改成中性描述（如「某些會嗅探 HeadlessChrome 的網站」），移除 FB 專指。

## 4. export-ignore 清單（加進 `.gitattributes`）

```
/portal/render-service/facebook-post.js export-ignore
/portal/render-service/daily-activity.js export-ignore
/portal/render-service/reflection-prompt.js export-ignore
/portal/render-service/fbpost-plugin.js export-ignore
/specs/SPEC-daily-reflection-post.md export-ignore
/specs/SPEC-fbpost-privatization.md export-ignore
/portal/hana_avatar_anime.jpg export-ignore
/gmail_authorize_ipv4.py export-ignore
/youtube_authorize_ipv4.py export-ignore
```

## 5. 驗收（AC）

1. **私有版功能不變**：Deploy 後，四按鈕核可流程（同意/放棄/重來/修改）全部照常，FB 能真的貼出（沿用 DEV-FBPOST-04 的自測手法，貼測試文再刪）。
2. **公開版零痕跡**：跑一次 publish 後，對公開產出物 grep `-riE "facebook|fbpost|fbPost|貼文|reflection|daily-activity"` → **0 命中**（含 server.js/telegram.js/browser-pilot.js）。
3. **公開版可正常啟動**：clone 公開版 → `install.ps1` → `Start_Harness.ps1`，portal 正常起、Telegram bot 正常（插件不存在只是少一個功能，不報錯）。
4. `node --check` server.js/telegram.js/fbpost-plugin.js 皆過；Deploy smoke 通過。
5. `.gitattributes` 已加 §4 清單；FB 模組已 commit 到私有（否則 export-ignore 不生效）。

## 6. 執行順序（重要：動到正在跑的 bot，需謹慎）

1. 先加 `telegram.js`/`server.js` 的**通用擴充點**（不刪 FB 碼），確認 bot 仍正常。
2. 建 `fbpost-plugin.js`，把 FB 碼搬過去、改用擴充點註冊。
3. 從 `telegram.js`/`server.js` **移除**已搬走的 FB 碼。
4. 改 `browser-pilot.js` 註解；補 `.gitattributes`。
5. Deploy + 私有版功能回歸測試（AC-1）。
6. publish → 驗證公開版零痕跡（AC-2/3）。

## 7. 任務對照（見 `.worktable/TASK.md` §U）

| Task | 內容 |
|:--|:--|
| FBX-01 | `telegram.js`/`server.js` 加通用擴充點（`_extraCallbackHandlers`/`_extraTextInterceptors`/`extraRoutes`），FB 碼暫不動，驗證 bot 正常 |
| FBX-02 | 建 `fbpost-plugin.js`，搬入全部 FB 碼、改用擴充點註冊 |
| FBX-03 | 從 `server.js`/`telegram.js` 移除已搬走的 FB 碼；`browser-pilot.js` 註解去 FB 化 |
| FBX-04 | 補 `.gitattributes` export-ignore 清單；commit FB 模組到私有 |
| FBX-05 | Deploy + 私有回歸（AC-1）；publish + 公開版零痕跡驗證（AC-2/3） |

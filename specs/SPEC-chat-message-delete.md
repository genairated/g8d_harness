# SPEC-chat-message-delete — 刪除單一留言

> 狀態：已實作（2026-08-03 指揮官提出並完成 Y1-Y6；佈署留給排程系統接手，§6 七條驗收皆已用真實 HTTP 冒煙測試通過，僅瀏覽器視覺互動待指揮官手動驗收）
> 相關：`portal/views/chat.js`（DOM 殼）、`portal/index.html`（聊天業務邏輯、`renderActiveTab`/`appendMessageToUI`）、`portal/server.js`（`/api/chat/history/*`、`writeContextFile`）
> 任務：`.worktable/TASK.md` §Y

---

## 1. 問題

指揮官打錯字、問錯方向，或對某一輪不滿意想重問時，目前**沒有任何辦法把那則訊息移除**——只能整個對話刪掉重來。後果有三：

1. **錯誤會被重送**：每次送出時 `writeContextFile()` 會把「這個 session 的完整歷史」寫進 `context_<sessionId>.md` 一併餵給 CLI，錯誤的提問與被它帶偏的回答會**每一輪都再送一次**。
2. **持續燒 token**：歷史越長越貴，而其中一部分是明知無用的內容。
3. **持續污染判斷**：模型會參考那段錯誤脈絡，錯誤會延續。

## 2. 設計原則

- **刪除是不可逆的破壞性操作** → 一律先確認，且**預設連動刪除**要在確認框中講清楚。
- **索引易錯位** → 後端刪除採**樂觀鎖**（呼叫端要帶上被刪訊息的 role 與內容前綴），對不上就 409 拒收，寧可失敗也不刪錯。
- **不新增第二套狀態** → 沿用既有 `chatTabs[].messages` ↔ `chat_<sessionId>.json` 的單一真相，刪完重新 `renderActiveTab()`，不做 DOM 局部移除。

## 3. 行為規格

### 3.1 入口
- 每則訊息氣泡 **hover 時**於右上角顯示一顆小垃圾桶（`trash-2`），未 hover 不顯示（避免視覺雜訊）。行動裝置沒有 hover → 一律顯示但透明度低。
- 該輪**正在生成中（`inFlight`）時，刪除鈕停用**並附 tooltip「這一輪還在跑，請先停止或等它完成」。

### 3.2 連動規則
- 刪 **使用者訊息**：確認框預設**勾選**「連同它後面那一則 AI 回覆一起刪除」（因為問錯了，答案通常也錯）。可取消勾選只刪提問。
- 刪 **AI 回覆**：只刪該則，不動前面的提問（讓指揮官能原問題重跑）。
- 刪除後**不自動重送**任何訊息——重問與否由指揮官決定。

### 3.3 連帶清理
- 被刪的使用者訊息若帶 `attachments`，一併刪除 `chat_history/attachments/<sessionId>/` 下**只屬於該訊息**的檔案（沿用既有 DELETE session 的沙盒檢查：id 白名單正規式 ＋ `path.resolve().startsWith()`）。**同一個檔被別則訊息共用時不刪**。
- 刪除後重寫 `context_<sessionId>.md`（用刪除後的 messages），確保下一輪不會從舊檔撈回被刪內容。
- `trace` 不做逐則對應清理（trace 是整輪 session 級的執行軌跡，無穩定 per-message 對應）——**誠實記錄此限制**：被刪那輪的工具軌跡仍會留在 `trace` 裡，但它不進 `context_*.md`、不會被重送給模型。

## 4. 介面

### 4.1 `DELETE /api/chat/history/:sessionId/messages/:index`（新增）

- **註冊方式**：登記進 `portal/api-router.js` 的 route table（`:param` 已支援；**勿加進舊 78-if 鏈**）。注意既有的 `pathname.startsWith('/api/chat/history/')` 三條 legacy if（GET/PATCH/DELETE）是用 `split('/').pop()` 取 id 的——**新路徑多一層 `/messages/:index`，必須確認 route table 的 dispatch 在 legacy if 鏈之前攔截**，否則會被舊的 DELETE 誤判成「刪整個 session」，這是本任務**最高風險點**。
- 工作區：`resolveWorkspace(req)`（`X-Workspace`），沿用既有 `wctx.chatHistoryDir`。
- body：
  ```jsonc
  {
    "expectRole": "user",           // 樂觀鎖：該索引的 role 必須相符
    "expectPrefix": "前 40 字",      // 樂觀鎖：該訊息文字前綴必須相符
    "cascadeNextAssistant": true     // 是否連同其後那一則 assistant 一起刪
  }
  ```
- 檢查失敗 → `409 { error: 'message mismatch' }`，**不寫檔**。
- 成功 → 寫回 JSON（維持既有 2 空格格式）、重寫 `context_<sessionId>.md`、回傳 `{ ok: true, removed: <n>, messages: [...] }`（前端直接拿去 render，不必再 GET 一次）。

### 4.2 前端
- `appendMessageToUI()` 產生的每個 row 加上 `data-msg-index`，刪除鈕以事件委派綁定（**不用 inline `onclick`**——`views/chat.js` 是 ESM，沿用 §V1 的教訓）。
- 刪除成功後以回傳的 `messages` 覆寫 `activeTab().messages` 再 `renderActiveTab()`。
- **浮動聊天視窗（`floatChat`）** 同樣套用：它與主面板共用同一組 session 檔，刪除鈕與呼叫路徑共用同一個函式，不各寫一份。

## 5. 不在範圍

- 不做「編輯訊息後重送」（那是另一個功能，需要分支歷史語意）。
- 不做刪除復原／垃圾桶（session 檔本身仍可由指揮官從備份取回；本功能明確定位為不可逆）。
- 不做多選批次刪除。
- 不動排程產生的 session（`origin: 'schedule'`）的特殊語意——它們同樣可刪，行為一致。

## 6. 驗收

1. 在對話中刪掉一則打錯的提問（連同其回覆）→ 畫面立即少了那兩則；重整後仍然不在。
2. 刪除後再送出下一則 → 檢查 `context_<sessionId>.md`，**已無**被刪內容（＝不會再被重送）。
3. 只刪 AI 回覆 → 提問仍在，可原題重問。
4. 生成中（`inFlight`）→ 刪除鈕停用，點不下去。
5. 帶附件的訊息被刪 → `attachments/<sessionId>/` 下該檔已移除，其他訊息的附件完好。
6. 手動竄改索引呼叫 API（role 或前綴對不上）→ 409，且檔案內容未被修改。
7. 既有的「刪除整個 session」（`DELETE /api/chat/history/:id`）行為完全不變——**必測**，因為新路徑與它前綴相同。

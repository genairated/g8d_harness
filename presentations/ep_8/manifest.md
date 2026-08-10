# ep_8 圖片清單（manifest）— 第八集：從掙脫瀏覽器到走進你的手機（掙脫瀏覽器 ＋ Telegram，已合併）
# 格式：檔名 = 這張是什麼。Hana 只依本檔放圖，勿臆測畫面內容。
# ⚠️ 本集由「原第八集（掙脫瀏覽器）」＋「原第十集（Telegram）」合併。素材分兩部。

## 第一部：掙脫瀏覽器（伺服器常駐）
繼續工作.mp4 = 影片：示範「關掉瀏覽器 → 任務在伺服器照跑 → 重開瀏覽器原樣接回」。
  這是 .mp4（不是圖）：請用 <video src="/raw?path=..." muted playsinline> 嵌入，並用 JS 在該頁變 active 時自動播放一次（見既有做法：MutationObserver 監看 .active + played 旗標）。pptx 匯出那頁會變定格（影片是網頁限定）。

## 第二部：走進你的手機（Telegram）
# ⚠️ 圖片實際放在 portal/deck-assets/ep8/；deck 一律用 /raw?path=portal/deck-assets/ep8/<檔名> 引用。
# 絕不要用 presentations/ 路徑、也不要加 &workspace=... 參數——那會 404、圖載不出來（deck.md §5 鐵則）。
Telegram_手機對話.jpg = 手機 Telegram 與 Hana 的對話
telegram_網頁對話.png = 網頁「Telegram 控制台」鏡像
telegram_連線狀態.png = Telegram 連線 / 狀態

## 製作備註
- 弧線：第一部「大腦搬到伺服器、瀏覽器只是 client」是前提；第二部「再接一個 client = Telegram」是兌現。中間「頁 6 關鍵洞察」是橋。
- 原第十集 deck（presentation-hana-episode10.html）可作為 Telegram 段落的內容／風格來源，合併版做好後再退役。

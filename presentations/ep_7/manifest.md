# ep_7 圖片清單（manifest）— 第七集：harness.json 的故事（一份小檔案，決定我的「名字」與「要掛哪些資料夾」）
# ⚠️ 依「原本故事」EP7 是「harness.json」，不是部署/自癒。
# ⚠️ 準確性鐵律：harness.json 其實很小，只管三件事。別把整個側邊欄都說成「來自 harness.json」——那是錯的。
# 製作時 Hana 只依本檔放圖，勿臆測畫面內容。

## 真相：harness.json 到底決定什麼（這集的核心，務必講對）
harness.json 目前只有三個 key，它「只負責因工作區而異的那一層」：
  1. name      → 品牌名（這個工作區叫「Hana」）
  2. subtitle  → 副標（"AI 工作區管理器 · Hana 的家"）
  3. sidebar.sections → 把「哪些資料夾」掛成側邊欄的瀏覽區塊。目前掛了 3 個：
       - 自我介紹簡報 (Hana)  ← presentations/ 資料夾，*.html
       - 全域記憶 (USER/AGENT) ← global-knowledge/ 資料夾，*.md
       - 專案記憶 (MEMORY/PERSONA) ← .harness/knowledge/ 資料夾，*.md

## 不是 harness.json 長出來的（共用的 app 骨架，寫死在 index.html）
這些每個工作區都一樣，harness.json 管不到，別說成是它生成的：
  - 頂部功能面板：AI 對話、CodeGraph、DocGraph、排程、Telegram
  - 手風琴區塊：工作台 (Worktable)、技能 (Skills)

## 這集真正的賣點（多工作區）
同一套 portal 程式，換一份 harness.json，就長出不同的「名字 + 品牌 + 要掛哪些記憶/資料夾區塊」。
→ 一個專案一份 manifest，骨架共用、身分各異。這才是 harness.json 的價值。

## 需要的畫面（依 EP7 腳本）
harness.json.png = harness.json 檔案內容：name / subtitle / sidebar.sections（3 個資料夾掛載）。★ 指揮官已提供
# 以下兩張指揮官「不一定提供」——若無圖，簡報請以「文字 + 箭頭圖解」描述 harness.json → 側邊欄的對應，不要硬湊或臆造截圖：
<填檔名或留空> = （可選）harness.json 生成的那 3 個側邊欄區塊（自我介紹簡報 / 全域記憶 / 專案記憶）。可用整體側邊欄截圖局部。
<填檔名或留空> = （可選）對應關係 demo：sidebar.sections 裡某一筆（如 presentations）↔ 側邊欄出現「自我介紹簡報」、點了在右側播放。

## 給簡報作者的講述要點（沒有截圖時用文字/圖解承載）
- 用「設定 → 結果」的對照：左邊放 harness.json 的 3 行 sections，右邊用箭頭指到側邊欄長出的 3 個區塊。
- 誠實區分「共用骨架」vs「因工作區而異」：可做一張對照圖（骨架=灰、harness.json 決定的=亮色）。
- 收在多工作區結論：換一份 harness.json = 換一個身分，程式不動。

## 註：此資料夾原本的 deploy腳本執行畫面.png / 監督者腳本執行畫面.png 其實是「部署/自癒」那集（腳本 EP11+，或 EP1 超能力⑦）要用的——請移走或留待那集用，別放進 EP7。

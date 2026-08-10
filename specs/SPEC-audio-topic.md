# SPEC — Audio Topic（音訊主題：跨入口的 Whisper 提示語）

> Status: READY for build ｜ Owner: 老闆 + Hana ｜ 影響範圍：`portal/render-service/stt.py`（提示語相容、標點誘導合併）、`portal/server.js`（音訊主題 CRUD API + 各音訊入口帶主題）、`portal/index.html`（各入口的主題選單 + 主題管理面板）、`portal/telegram.js`（Telegram 語音帶當前主題）、`global-knowledge/commands/audio-topic.md`（產主題技能）、各 workspace `.harness/runtime/audio-topics.json`
> 對應 TASK.md **AT 系列**。
> **知識依據**：`global-knowledge/audio-topic-guide.md`（Whisper 提示語撰寫原則；224-token 上限、放什麼、避免什麼）——本 spec 只定「功能怎麼接」，「主題怎麼寫好」看那份。
> **相依既有**：`SPEC-meeting-transcriber.md`（stt.py、`/api/meeting/start` 已有 `--prompt`）、`SPEC-floating-chat.md`（F4 麥克風 `/api/stt`、F6 來賓 loopback `/api/stt/loopback/start`、F5 Telegram 語音）。

---

## 1. 為什麼要這個功能（需求）
指揮官在任何「收音 → 辨識」的場合，希望先做**前情提要**（這場在談什麼、有哪些人名/專名），讓 Whisper 辨識更準（見 `audio-topic-guide.md`）。現況：`stt.py` 的 `--prompt` 已存在、`/api/meeting/start` 已能帶 `--prompt`，但**沒有一個「命名、可重用、跨入口共用」的主題**——每次都要臨時想、也沒地方存好的提示語、更沒人守「別寫太長害了 Whisper」。

**本功能＝把「一段 Whisper-friendly 的 initial_prompt」升格成「命名主題」**，在**每一個音訊入口**都能一鍵選用，並提供**建立/管理主題**的地方（UI + 技能）與**撰寫原則**（guide）。

## 2. 音訊入口盤點（主題要接的地方）——動工前先定位這些真實位置
> **關鍵事實**：Hana 頭像 widget 的「🎙️ 麥克風模式」是 **TTS 自動朗讀輸出**（`setHanaTTSMode('mic')`），**不是收音**。頭像本身沒有 STT。真正「講話給 Hana」的音訊入口如下四個，全部匯流到 `stt.py`：

| # | 入口 | 現況真身 | 現在怎麼帶提示語 |
|---|---|---|---|
| 1 | **AI 會議** | `POST /api/meeting/start`（server.js ~3801）→ spawn `meeting_record.py --prompt` | 已支援 `opts.prompt`（~3824），但 UI 無選單 |
| 2 | **Chat 麥克風（F4）** | `POST /api/stt`（server.js ~4610）→ `sttTranscribe` | 目前不帶主題提示語（只有 stt.py 內建標點誘導） |
| 3 | **Chat 來賓 loopback（F6）** | `POST /api/stt/loopback/start`（~4497）→ loopback 擷取 → `sttTranscribe` | 目前不帶主題提示語 |
| 4 | **Telegram 語音（F5）** | `telegram.js` `_handleVoice` → `stt.py` | 目前不帶主題提示語 |

- **底層都同一支**：`stt.py transcribe_file(..., initial_prompt=...)`（含常駐 worker `sttTranscribe`）。主題最終就是被塞進 `initial_prompt`。
- `stt.py` 現有 `DEFAULT_PUNCT_PROMPT_ZH`（中文標點誘導）：呼叫端**沒帶 prompt** 且語言為中文/auto 時自動套用；**帶了 prompt 就整個被主題取代**（見 §5 合併策略）。

## 3. 核心原則
1. **一個主題 = 一段 Whisper-friendly 的 initial_prompt**：主題不是 LLM 指令，是餵給辨識器的「前情提要+專名表」，必須短（遵守 `audio-topic-guide.md` 的 224-token 上限與寫法）。
2. **四個入口共用同一份主題清單、同一套選單**：會議、麥克風、來賓、Telegram 都從同一個 `audio-topics.json` 挑，選單樣式照抄既有 STT 模型選單。
3. **兩種範圍（scope），比照 skill 的全域／工作區**：
   - 🌐 **全域主題**（`scope:"global"`）：存 `global-knowledge/audio-topics.json`，**所有工作區都選得到**——放通用、無 PII 的骨架款（free talk、教育訓練、固定人名）。這是指揮官「刻意公開」的部分，如同他把 skill 放 global。
   - 📁 **工作區主題**（`scope:"workspace"`）：含人名/客戶名/專案代號＝**專案專屬且可能敏感**，存 `<workspace>/.harness/runtime/audio-topics.json`，**只在該工作區出現**，比照 MEMORY「排程工作區隔離」pattern（`resolveWorkspace(req)` / `path.resolve()`+小寫正規化），不跨工作區外洩。
   - **入口選單＝全域 ∪ 當前工作區**（各帶範圍標記）；改一次全域到處生效，不必複製。隔離鐵則不破：工作區主題仍只在自己工作區顯示。
4. **不重造收音**：不新增任何收音/辨識管線——只在既有四個入口「多帶一個 initial_prompt」。
5. **產字有守門**：不論 UI 手填或技能產出，存檔前都**編譯成 Whisper-friendly 字串並在超 token 預算時截斷+警告**（守「別太長害了 Whisper」）。

## 4. 資料模型與儲存

**兩個檔（依範圍分家，比照 skill 全域 vs 工作區）**：
- 🌐 全域：`global-knowledge/audio-topics.json` → `{ "topics": [ …全域主題… ] }`（**無預設概念**——預設是各工作區各自決定的，見下）。
- 📁 工作區：`<workspace>/.harness/runtime/audio-topics.json` → `{ "defaultTopicId": "topic_xxx" | null, "topics": [ …工作區主題… ] }`（runtime 存法比照 meetings/notes；跨重啟不丟、已 gitignore）。

**單筆主題**：
```jsonc
{
  "id": "topic_<ts>_<rand>",
  "name": "需求訪談 · 文件管理客戶",     // 選單顯示名
  "scope": "workspace",                  // global | workspace（決定存哪個檔、誰看得到）
  "lang": "zh",                          // zh | en | auto（決定 stt.py 語言與標點誘導）
  "meetingType": "需求訪談",             // 結構化來源欄位（供編輯/技能）
  "people": ["Charles", "王經理"],
  "terms": ["Harness", "Portal", "BPMN"],
  "topicLine": "客戶討論文件管理與流程圖轉換需求",
  "notes": "",                           // 額外自由備註（會被納入編譯、仍受 token 預算）
  "prompt": "這是一段繁體中文的需求訪談…（編譯後的最終 initial_prompt）",
  "workspace": "D:\\SideProject\\_harness",  // 僅 scope:workspace 有；global 為 null
  "updatedAt": "2026-07-24T...Z"
}
```
- **`prompt` 是唯一真正餵給 Whisper 的欄位**；其餘結構化欄位是「來源」，供 UI 編輯與技能理解。
- **預設主題＝per-workspace 指標，不掛在主題身上**：預設由工作區檔的 `defaultTopicId` 記錄，**它可指向一個全域主題或自己的工作區主題**。這樣「不同工作區各自把某個全域主題設成自己的預設」自然成立（同一全域主題在 A 是預設、在 B 不是，互不干擾）。故主題**沒有 `isDefault` 布林**，避免全域主題被某工作區設預設卻污染到別的工作區。
- **解析某工作區的預設**：讀該工作區 `defaultTopicId` → 在「全域 ∪ 該工作區」合併清單中查；查無（被刪/失效）視同「（不套主題）」。
- **編譯規則**（結構化欄位 → `prompt`）：依 guide §4 骨架組字（語言+標點宣告句 → 主題句 → 人名 → 專名 → notes），**估算 token、超預算則依優先序（人名>專名>主題句>notes）裁掉尾部並在回應帶 `truncated:true` 警告**。UI 手填 `prompt` 者可直接存（仍過長度守門）；技能產出者由 Hana 依 guide 直接寫好 `prompt`＋回填結構化欄位。

## 5. AT 系列分階段

### AT1 — 資料層 + 提示語相容（先做，其餘都靠它）
- **`stt.py` 合併策略**：目前「呼叫端帶 prompt → 整個取代標點誘導」。改為：呼叫端帶主題 prompt 且語言為中文/auto 時，**把 `DEFAULT_PUNCT_PROMPT_ZH` 的標點宣告併入主題 prompt**（標點宣告在前、主題內容在後），合併後仍**受同一 token 預算截斷**——讓「選了主題」不會失去「中文補標點」的好處。非中文則只用主題 prompt。（純參數/字串層，不動辨識核心。）
- **`server.js` 音訊主題 CRUD API**（比照 `/api/voice-config`、`/api/notes` 風格，全部經 `resolveWorkspace(req)`；範圍決定讀寫哪個檔）：
  - `GET /api/audio-topics` → 回**合併清單**＝全域主題（`global-knowledge/audio-topics.json`）∪ 當前工作區主題（`path.resolve()`+小寫正規化過濾），每筆帶 `scope`；另回當前工作區的 `defaultTopicId`。回應形如 `{ topics:[…], defaultTopicId }`。
  - `POST /api/audio-topics`（body 帶 `scope`）→ 建立；`scope:"global"` 寫全域檔（`workspace:null`）、`scope:"workspace"` 寫當前工作區檔並標 `workspace`；自動 `id`、`updatedAt`；server 端**編譯 `prompt` + token 守門**（回 `{topic, truncated?}`）。
  - `PUT /api/audio-topics/:id` → 更新（依該主題 `scope` 找對的檔；重編譯 + 守門）。**改 scope**＝從一檔搬到另一檔（工作區↔全域）。
  - `DELETE /api/audio-topics/:id` → 刪除（依 scope 找檔）；若剛好是某工作區的 `defaultTopicId`，該工作區預設回退為 null。
  - `PUT /api/audio-topics/default`（body `{topicId|null}`）→ 設**當前工作區**的預設指標；`topicId` 可為全域或工作區主題 id（server 驗證存在於合併清單）。只寫當前工作區檔的 `defaultTopicId`，**絕不寫全域檔**（全域無預設概念）。
  - `POST /api/audio-topics/compile`（可選）→ 只編譯不儲存，供 UI 即時預覽最終 prompt 與 token 估算。
- **編譯器 helper**（server.js 內，或抽 `portal/audio-topics.js` 比照 `notes.js`）：讀/寫兩個檔（全域＋工作區）、合併清單、結構化欄位 → prompt、token 估算、預算截斷、`defaultTopicId` 存取。

### AT2 — 四個入口接上主題選單
> 每個入口：一個主題 `<select>`（照抄 index.html STT 模型選單樣式，選項＝合併清單〔全域∪工作區，各帶 🌐/📁 範圍標記〕 + 「（不套主題）」，並可顯示「（跟隨工作區預設）」項），**選擇存 localStorage per-surface**（記住上次），送出時帶 `topicId`；server 端把 `topic.prompt` 解析出來當 `initial_prompt`。未特別選時套當前工作區 `defaultTopicId`。
- **AT2-a 會議**：`index.html` 會議面板加主題選單；`POST /api/meeting/start` body 帶 `topicId` → server 解析 `topic.prompt` → 既有 `--prompt`（~3824）。
- **AT2-b Chat 麥克風（F4）**：`/api/stt` 接受 `topicId`（或 querystring）→ 解析 prompt → `sttTranscribe(initial_prompt)`。整頁與浮動 chat 共用。
- **AT2-c Chat 來賓 loopback（F6）**：`/api/stt/loopback/start` 接受 `topicId` → 帶進擷取器的辨識。
- **AT2-d Telegram 語音（F5）**：`telegram.js` 依 chat 脈絡工作區（`getContext(chatId).root`）取該工作區 `defaultTopicId`（可能指向全域或工作區主題）→ 在合併清單解析其 `prompt` 帶進 `stt.py`；另加指令可切當前主題（見待拍板 #5）。
- **語言連動**：選了主題 → 該入口的辨識語言（zh/en）預設跟主題 `lang` 走（使用者仍可覆蓋）。

### AT3 — 主題管理 UI + `/audio-topic` 技能
- **管理面板**（`index.html`，`#audio-topic-panel`，走既有 `showPanel(id)` 互斥；側邊欄入口如「🗂️ 音訊主題」）：分「🌐 全域」與「📁 本工作區」兩區列出主題（各帶範圍標記）、新增時**選範圍**、編輯（結構化欄位表單：類型/語言/人名/專名/主題句/備註，含「範圍」下拉可搬移全域↔工作區）、**即時預覽編譯後 prompt + token 用量條**（超預算變紅）、**設為本工作區預設**（全域或工作區主題皆可指定，寫 `defaultTopicId`）、刪除。深色模式底色與文字皆隨 `.dark`（吸取 MEMORY 撞色教訓）。
- **`/audio-topic` 技能**（`global-knowledge/commands/audio-topic.md`，帶 frontmatter，比照 `gmail-daily.md`/`doc-new.md`）：指揮官給一段口語前情提要（「這場是跟 XX 客戶談文件管理的需求訪談，會有王經理、Charles」）→ Hana **讀 `audio-topic-guide.md`**、萃取人名/專名/主題句、**產出 Whisper-friendly 主題**（結構化欄位 + 編譯 prompt，遵守 224-token 與「別塞長大綱」）→ `POST /api/audio-topics`（**預設 `scope:"workspace"`；指揮官若說「這是通用款/設成全域」則帶 `scope:"global"`**）存入 → 回報主題名、範圍與最終 prompt 供指揮官確認。**智慧在 Hana、儲存經 API（單一真相）。**

### AT4 — 驗證與收尾
- DoD（§6）+ 指揮官手動驗證。

## 6. 驗證（DoD）
- [ ] AT1：`stt.py` 帶主題 prompt（中文）時，輸出**同時**保有主題詞正確拼法**與**標點斷句（合併策略生效）；超長主題被截斷不報錯。範圍正確：`scope:workspace` 主題在 A 建、B 的清單看不到；`scope:global` 主題在 A、B **都**看得到。`defaultTopicId` 為 per-workspace：A 把某全域主題設預設，不影響 B 的預設。編譯超 token 回 `truncated:true`。
- [ ] AT2-a：會議面板選主題 → `/api/meeting/start` 帶 topicId → `meeting_record.py` 實際收到該 prompt（辨識一段含主題內專名的音，拼法正確）。
- [ ] AT2-b/c：麥克風與來賓 loopback 選主題 → 辨識輸出反映主題（自動驗證：edge-tts 播一段含專名的話，比對「有主題 vs 無主題」拼法差異）。
- [ ] AT2-d：Telegram 語音在某工作區使用其 `isDefault` 主題。
- [ ] AT3：管理面板可建/編/刪主題、即時看到編譯 prompt 與 token 條、超預算變紅；深淺模式字都可讀。`/audio-topic 這場是跟客戶談文件管理` → 產出**短、Whisper-friendly** 的主題並存入當前工作區。
- [ ] 🧑‍✈️ **指揮官手動驗證**（真實會議/對話選主題後辨識準度改善，此關只由 老闆勾）。

## 7. 待拍板（遇到先採預設、記錄，勿卡住）
1. ~~**主題儲存範圍**~~ → **已拍板（2026-07-24）**：不做「一鍵複製」，改為**範圍模型**——每個主題屬 🌐 **全域** 或 📁 **工作區**（比照 skill 全域/工作區）。入口選單＝全域∪當前工作區；預設是 per-workspace 指標 `defaultTopicId`，可指向全域或工作區主題。詳見 §3.3、§4。
2. **主題內容來源形態**：結構化欄位自動編譯（**預設**，UI 好編）vs Hana/使用者直接寫整段 prompt？→ **兩者皆可**：UI 填欄位→自動編譯；技能→Hana 直接寫 prompt 並回填結構化欄位。
3. **標點誘導與主題的合併**：合併（**預設**，標點宣告在前+主題內容在後，仍受 token 預算）vs 主題完全取代？→ 先合併（中文才併標點句）。
4. **各入口是否記住「上次用的主題」**：localStorage per-surface 記住（**預設**）+「（不套主題）」選項。
5. **Telegram 怎麼選主題**：先用該工作區 `isDefault`（**預設**）；要不要加 `/topic <名>` 指令切當前主題？→ 先只吃預設，指令留待需要。
6. **token 預算數值**：先採 guide 的 **≈224 token** 上限；估算用簡易「中文字≈1.5 token、英數詞≈1 token」近似即可（不引 tokenizer 相依），偏保守。
7. **會議「會後重轉」是否也吃主題**：先讓「開始錄音」帶主題即可；會後重轉沿用該會議 meta 記下的主題。

---

## Changelog
| Date | Version | Author | Description |
|:-----|:--------|:-------|:------------|
| 2026-07-24 | v0.2 | 老闆 + Hana | 拍板範圍模型：主題分 🌐 全域（`global-knowledge/audio-topics.json`，所有工作區可選）／📁 工作區（per-workspace runtime，僅該工作區可選），比照 skill 全域/工作區，取代原「全域模板庫一鍵複製」構想。預設改為 per-workspace 指標 `defaultTopicId`（可指向全域或工作區主題）、移除主題身上的 `isDefault`。API 增 scope 參數與 `PUT /api/audio-topics/default`；UI 分區顯示+選範圍+搬移；技能預設建工作區、可指定全域。待拍板 #1 結案。#2、#3 沿用同意之預設。 |
| 2026-07-24 | v0.1 | 老闆 + Hana | 初版。把「Whisper initial_prompt」升格為「命名、可重用、跨入口共用的音訊主題」。盤點四個音訊入口（AI 會議／chat 麥克風 F4／chat 來賓 loopback F6／Telegram 語音 F5——釐清頭像無獨立 STT）。per-workspace `audio-topics.json`（工作區隔離鐵則）；結構化欄位→編譯 prompt+token 守門；stt.py 主題與標點誘導合併策略。分階段 AT1（資料層+提示語相容）／AT2（四入口接選單）／AT3（管理 UI + `/audio-topic` 產字技能，依 audio-topic-guide.md）／AT4（驗證）。知識依據抽為 `global-knowledge/audio-topic-guide.md`。7 條待拍板均附預設。 |

# SPEC — Output Style（回覆風格切換）

> Status: DRAFT for discussion ｜ Owner: 老闆 + Hana ｜ 影響範圍：`portal/server.js`（buildChatPrompt、/api/chat、新增設定讀寫 API）、`portal/views/chat.js` + `portal/index.html`（下拉選單）、`portal/commands/output-style.md`（新技能）、`~/.claude/`（使用者主目錄，Claude Code 原生設定）、`<workspace>/.claude/`（專案原生設定）
> 目的：讓 Hana 回覆時可切換「風格」（如 PM 導向：決策/風險置頂、少術語）。**Claude Code 用原生機制，不組 prompt；其他 CLI（Codex/Gemini/Grok）沒有原生機制，才組 prompt 當 fallback。**

---

## 1. 關鍵事實（調查結果，決定了整個設計）

Claude Code CLI **原生支援 output style**，機制是：
- 風格定義＝一個 `.md` 檔，放在 `~/.claude/output-styles/`（使用者全域）或 `<cwd>/.claude/output-styles/`（專案，相對於執行時的工作目錄）。檔名＝風格名稱（除非 frontmatter 覆寫 `name`）。
- 檔案格式：
  ```md
  ---
  name: pm
  description: PM 導向：風險/決策置頂、少術語
  ---
  <這段文字會被加到系統提示詞末尾，等同原生 system prompt 擴充，不是我們自己組的>
  ```
- **目前選定哪個風格**＝`settings.json` 裡的 `outputStyle: "<name>"` 欄位。Claude Code 啟動時依 cwd 就近解析：`<cwd>/.claude/settings.json` 有設就用專案的，否則退回 `~/.claude/settings.json` 的全域值。
- **這兩個都是 Claude Code CLI 本來就會讀的路徑／欄位**——不需要我們每次呼叫 CLI 時額外組 `--settings` 參數，也不需要另外維護一份「Hana 自己的」風格檔案再同步過去。**寫檔案本身就是設定生效**，沒有另外的「同步」步驟。
- 這代表：`portal/server.js` 呼叫 Claude Code 的 `chatViaClaude()`（`server.js:9264`）**完全不用改**——風格是透過檔案系統生效，不是透過 CLI 參數。

其他三種 CLI（Codex `chatViaCodex`、Gemini/Antigravity `chatViaXxx`、Grok `chatViaGrok`）**沒有**原生 output style 機制（已對其 `--help` / repo 搜尋確認過去沒用過這類旗標）。這幾種維持現行做法：`buildChatPrompt()`（`server.js:8416`）在組 prompt 時，多插入一段「目前生效風格」的指令文字（讀同一份 `.md` 檔的 body，去掉 frontmatter 後直接塞進去）。

**好處**：同一份 `.md` 檔案，Claude Code 原生吃、其他 CLI 用來組 prompt fallback，**不用維護兩份風格定義**。

---

## 2. 儲存位置（兩層，比照 Claude Code 原生路徑，不另建 Hana 自己的資料夾）

| 層級 | 路徑 | 說明 |
|---|---|---|
| 全域（預設，每次用 Claude Code 都套用，含終端機直接打 `claude`） | `~/.claude/output-styles/*.md` + `~/.claude/settings.json` 的 `outputStyle` | 對應使用者第 1 點「每次使用 Claude Code 就是我偏好的風格」——因為是原生機制，連老闆自己在終端機手動打 `claude` 也會套用，不只 Hana Portal 內的對話。 |
| 專案（個別工作區覆寫） | `<workspace>/.claude/output-styles/*.md` + `<workspace>/.claude/settings.json` 的 `outputStyle` | 對應使用者第 4 點「未來每個專案也可能不同」。工作區沒有 `.claude/` 就在需要時建立。 |

**內建風格**（Harness 出貨自帶，第一次使用時若 `~/.claude/output-styles/` 不存在同名檔案才寫入，不覆蓋老闆已手動改過的內容）：
- `default`：不寫任何檔案／不設 `outputStyle`，就是 Claude Code 原生預設行為。
- `pm`：老闆第 3 點描述的 PM 風格——風險與需要決策的事項放最上方、少術語但關鍵技術影響要精準、段落簡短。內建範本放在 `portal/output-styles/pm.md`（隨 repo 出貨），首次使用時複製到 `~/.claude/output-styles/pm.md`。

---

## 3. 選定機制（點 2：「一個檔案存預設值，改的時候直接改該檔案」）

「目前選定哪個風格」這件事，其實**就是 `outputStyle` 欄位本身**，不需要 Hana 另外維護一份重複的設定檔：
- 切風格＝讀寫 `~/.claude/settings.json`（全域）或 `<workspace>/.claude/settings.json`（該專案）裡的 `outputStyle` 欄位，其餘欄位原樣保留（用既有 JSON merge 寫回，不能整份覆蓋——這兩個檔案 Claude Code 自己也會寫，例如 `model`/`theme`）。
- 這與 `voice-config.json` 的精神一致（檔案存預設值、改動就直接寫回檔案），差別只是「檔案就是 Claude Code 自己的 settings.json」，不必另造一個 Hana 專屬的中介檔案。

**判斷「目前生效的風格是什麼」（給 UI 下拉選單顯示、給 fallback CLI 組 prompt 用）**：
1. 讀 `<workspace>/.claude/settings.json`，有 `outputStyle` 就是它。
2. 沒有就讀 `~/.claude/settings.json` 的 `outputStyle`。
3. 都沒有就是 `default`。

---

## 4. `/output-style` 技能（點 3）

新增 `portal/commands/output-style.md`，功能：
- `/output-style list`：列出目前可用風格（全域 + 專案），標示目前生效的是哪個。
- `/output-style use <name> [--global|--project]`：切換生效風格，寫回對應層級的 `settings.json`（預設寫專案層；`--global` 才動全域）。
- `/output-style new <name>`：依老闆口述內容產生一份新的 `.md` 風格定義，寫入 `<workspace>/.claude/output-styles/<name>.md`（自訂風格預設歸在專案層，除非老闆說要全域）。
- `/output-style edit <name>`：修改既有風格定義的內文——**因為檔案本身就是原生設定來源，改檔案＝當場生效，不需要額外「更新 CLI 設定值」的動作**；這條指令本質是幫老闆定位到正確檔案並改寫，不是同步機制。

---

## 5. 聊天室下拉選單（點 5）

- `portal/views/chat.js` 在 `chat-model-select` / `chat-effort-select` 旁邊加 `chat-style-select`，選項來自新增的 `GET /api/output-styles`（回傳 `[{name, description, scope: 'global'|'project', active: bool}]`，掃 `~/.claude/output-styles/` 與 `<workspace>/.claude/output-styles/`）。
- 選單改變時呼叫 `POST /api/output-style`（body: `{name, scope}`），寫回對應 `settings.json`，邏輯與 `/output-style use` 共用同一段後端函式。
- **這是持久設定、不是單則訊息的暫時參數**——跟真正的 Claude Code `/output-style` 互動指令行為一致（切了就一直生效，直到下次再切），所以不比照 `model`/`effort` 存 localStorage、而是直接寫檔案，讓「網頁下拉選單」和「終端機手動打 `claude`」共享同一個生效狀態。

---

## 6. Fallback（Codex / Gemini / Grok）

`buildChatPrompt()`（`server.js:8416`）在系統前導語之後，若 `ctx.provider !== 'claude'`，且解析出的目前生效風格不是 `default`，讀該風格 `.md` 檔、去掉 frontmatter 後把 body 內容插入 prompt（明確標註「請以下列風格回覆」）。Claude Code 分支則完全不動 prompt。

---

## 7. 待老闆拍板的開放決策

1. **內建風格範圍**：第一版只出 `default` + `pm` 兩款，之後老闆想要更多（例如教學風、精簡風）用 `/output-style new` 自己加即可——還是要我一次多準備幾款常見範本鋪好？
2. **PM 風格草稿**：我直接依老闆先前描述寫一版 `portal/output-styles/pm.md` 定稿，還是先給草稿看過文字語氣再定？
3. **專案沒有 `.claude/` 目錄時自動建立**：這是新建資料夾/檔案（非破壞性動作），我會照做並告知；如果有工作區老闆不希望被寫入 `.claude/`（例如某些唯讀/共用目錄），要不要先講清楚排除清單？沒有的話我就預設「有需要就建」。

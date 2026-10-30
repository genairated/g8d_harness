---
name: output-style
description: 管理回覆風格（切換/新增/編輯 Claude Code 原生 output style）
icon: palette
type: prompt
---

# 任務：管理回覆風格（Output Style）

規格：`specs/SPEC-output-style.md`。**Claude Code 原生就有 output style 機制**，我不用自己組 prompt 或另建設定檔——寫檔案本身就是設定生效：

- 風格定義＝一個 `.md` 檔（frontmatter `name`/`description` + 內文），放在：
  - 全域：`~/.claude/output-styles/<name>.md`
  - 專案（覆寫全域）：`<workspace>/.claude/output-styles/<name>.md`
- 目前生效哪個風格＝對應層級 `settings.json` 的 `outputStyle` 欄位（`~/.claude/settings.json` 或 `<workspace>/.claude/settings.json`）。**這兩個檔案 Claude Code 自己也會寫（如 model/theme），改寫時只能 merge 既有內容、不能整份覆蓋。**
- 判斷「目前生效的風格」：先看 `<workspace>/.claude/settings.json` 的 `outputStyle`，沒有就看 `~/.claude/settings.json` 的，都沒有就是 `default`（不寫任何檔案，Claude Code 原生預設行為）。
- 內建出貨的 `pm` 風格範本在 `portal/output-styles/pm.md`（首次使用會被自動複製到 `~/.claude/output-styles/pm.md`，之後改動只動這份使用者的複本）。

依 `{{args}}` 判斷子指令：

- **`list`**（或無參數）：列出全域＋專案（若有）所有風格檔案（讀對應目錄），標示目前生效的是哪一個（依上面判斷規則）；用一句話簡述給指揮官看，不要整份貼出檔案內容。
- **`use <name> [--global|--project]`**：把對應層級（預設 `--project`，即 `<workspace>/.claude/settings.json`；帶 `--global` 才動 `~/.claude/settings.json`）的 `outputStyle` 欄位改成 `<name>`，**merge 寫回、保留其他既有欄位**。`<name>` 為 `default` 時，改成移除 `outputStyle` 欄位（等於清空，回到原生預設）。
- **`new <name>`**：依指揮官口述的風格描述，產生一份新的 `.md`（frontmatter `name`/`description` + 內文＝風格指示本身，用第二人稱指示模型該怎麼回覆），寫入 `<workspace>/.claude/output-styles/<name>.md`（自訂風格預設歸在專案層，除非指揮官說要全域）。寫完後告知指揮官這份風格「還沒生效」，要不要順便 `use` 切過去。
- **`edit <name>`**：找到既有風格檔案（先查專案層、再查全域層），依指揮官描述修改內文，直接覆寫該檔案。**這就是生效機制本身，改完即生效，不需要另外「更新 CLI 設定」的動作**——不要誤以為還要做什麼同步步驟。

本次指令參數：{{args}}

<div align="center">

<img src="portal/avatar/full/hana_wave_hi_right.png" width="220" alt="Hana waving hello">

# Hana

**Your in-computer AI development partner — one teammate across many AI CLIs, who never loses the thread when you switch models.**

English ｜ [繁體中文](#-中文)

</div>

---

Hana is a **local, self-hosted AI development partner**. Instead of locking you into one
vendor's chat box, she bridges the **official CLIs of several AI models** — Claude,
Antigravity (Gemini), Codex — into one persistent, model-neutral teammate that lives on your
own machine. She solves three everyday pains: **three AI brains that each forget on switch**
(Hana keeps one shared, file-based context so you change models mid-task without re-explaining),
**being locked to one interface** (tasks run on a server, reachable from a browser or Telegram),
and **cost** (official CLIs on your existing subscription — no API keys, no per-token metering).

> Honest note: this is a young, growing project. Everything below is really implemented — no
> vaporware — but still being polished.

## What Hana can do

The headline: ⭐ **cross-CLI, model-neutral, no amnesia.** Beyond that:

- 🔁 **Bridges Claude / Gemini / Codex** official CLIs — switch models mid-conversation, run several in parallel tabs like a small team.
- 🧠 **Memory + skills** — two-layer memory (global + per-project) and skills that are just `.md` files she can read, inherit and author.
- 🗂️ **A clone per project** — each workspace keeps its own memory / chats / tasks / schedules / menu, isolated but inheriting global know-how.
- 📱 **Server-resident + Telegram** — close the browser and work keeps running; control everything from your phone.
- ⏰ **Scheduler** — runs on a timer, self-wakes after hitting a rate cap, with budget/retry guardrails.
- 🗺️ **Living maps** — CodeGraph (code) + DocGraph (specs) that grow automatically with the codebase.
- 🩹 **Self-heal** — safely modifies her own code: immutable snapshot → smoke test → supervised restart → auto-rollback.
- 📄 **Docs & decks** — Word ⇄ editable Markdown with editable BPMN flowcharts, plus a voice-enabled presentation engine.

*Design: local-first · model-neutral · files-are-knowledge · isolated-yet-inheritable.*

### See `/setup` in action

Type `/setup` and the model probes your machine and reports what's ready — here **Claude** and **Codex** both detect a fully-configured install:

<div align="center">
<img src="docs/screenshots/setup-claude.png" width="420" alt="/setup detected by Claude"> <img src="docs/screenshots/setup-codex.png" width="420" alt="/setup detected by Codex">
</div>

## Getting started

### 1. Prerequisites

- **Node.js 22+** (Hana uses the built-in `node:sqlite`).
- **Windows** with PowerShell.
- **At least one AI CLI installed and logged in** — this is how Hana talks to models:
  - Claude: `npm i -g @anthropic-ai/claude-code` then `claude` (log in once), or
  - Codex, or Antigravity's `agy`. Any one is enough to start; you can add the others later.

### 2. Install & run

```powershell
git clone https://github.com/genairated/g8d_harness.git
cd g8d_harness/portal
npm install            # portal dependencies (node-pty, etc.)  — a one-command ./install.ps1 is coming
cd ..
./Start_Harness.ps1    # starts the portal (supervisor) and opens your browser
```

Then open <http://localhost:3300/>.

### 3. First run — `/setup`

In Hana's chat box, type **`/setup`**. She detects what's already installed and gives you
copy-paste commands for the optional pieces you want — speech-to-text & meeting transcription,
Telegram control, presentation/PPTX export, GPU acceleration, remote access. Nothing is installed
behind your back; `/setup` is an advisor, you run the commands.

### 4. Using Hana day to day

- **Pick a model** from the dropdown (Claude / Gemini / Codex) and just chat.
- **Switch models mid-task** — the conversation context carries over, so you can start on one
  model and hand off to another without re-explaining. This is the core trick.
- **Open multiple tabs** to run models in parallel, like a small team.
- **The left sidebar** holds Hana's self-introduction, memory files, and your project docs.
- **Tasks live on the server** — close the tab and long jobs keep running; reconnect (or use
  Telegram, if configured) to pick up where you left off.

> By default the portal binds to **`127.0.0.1` (localhost only)** — safe out of the box, zero
> config. Hana can read/write files and run CLIs on your machine, so treat the portal like a
> shell: don't expose it to an untrusted network. For remote access, use a private network
> (e.g. Tailscale) plus a `PORTAL_TOKEN` — see `/setup` → remote access, or `specs/SPEC-setup.md` §12.

## Under the hood

- **`portal/`** — Node HTTP server (`server.js`) + single-page UI (`index.html`): AI chat,
  document browser, scheduler, meeting transcriber, document pipeline, in-app graph explorers.
- **`docgraph/`** — a markdown spec/governance knowledge graph on the built-in `node:sqlite`
  (no native deps); per-project rules live in `docgraph/profiles/`.
- **`.releases/` + `Deploy_Harness.ps1` / `Rollback_Harness.ps1`** — the self-heal machinery:
  immutable versioned releases with a supervisor that restarts and auto-rolls-back.

## Roadmap

- One-command installer (`install.ps1`) + the `/setup` advisory skill for first-run onboarding.
- Security-by-default: bind to `127.0.0.1` out of the box + optional `PORTAL_TOKEN`.
- Semantic layer over docgraph (local embeddings → GraphRAG).

> **Recommended CLI**: for the smoothest experience, use **Claude** or **Codex** as your primary
> model. Antigravity (Gemini)'s CLI works, but is currently the least stable of the three (flaky
> cold-start auth, aggressive rate limits) — best kept as a secondary option.

---

<div align="center">

## 🌸 中文

<img src="portal/avatar/full/hana_laptop_talk_right.png" width="200" alt="Hana">

**你電腦裡的 AI 開發夥伴 — 一個橫跨多個 AI CLI、換模型也不失憶的隊友。**

[English](#hana) ｜ 繁體中文

</div>

---

Hana 是一個**本地、自架的 AI 開發夥伴**。她不把你綁死在單一廠商的聊天框裡,而是把
**多個 AI 模型的官方 CLI** —— Claude、Antigravity（Gemini）、Codex —— 橋接成一個會記憶、
模型中立的隊友,住在你自己的電腦裡。她解決三個日常痛點:**三顆大腦一換就忘**(Hana 用一份
檔案式共享脈絡,讓你做到一半換模型也不用重講)、**被單一介面綁死**(任務跑在伺服器,瀏覽器或
Telegram 都能接)、以及**成本**(官方 CLI＋你現有的訂閱,免 API 金鑰、不按 token 計費)。

> 誠實說:這是個還年輕、成長中的專案。以下每一項都是真的做出來了、沒有一項是吹的,只是仍在打磨。

## Hana 會做什麼

主打:⭐ **跨 CLI、模型中立、不失憶。** 此外:

- 🔁 **橋接 Claude／Gemini／Codex** 官方 CLI —— 對話中途換模型、多分頁並行像個小團隊。
- 🧠 **記憶＋技能** —— 兩層記憶（全域＋專案）;技能就是 `.md` 檔,她能讀、能繼承、能自己長。
- 🗂️ **每個專案一個分身** —— 各工作區各自的記憶／對話／任務／排程／選單,隔離但繼承全域經驗。
- 📱 **伺服器常駐＋Telegram** —— 關掉瀏覽器工作照跑;用手機也能全程控制。
- ⏰ **排程器** —— 定時執行、撞限額會自醒續跑,附預算／重試護欄。
- 🗺️ **活地圖** —— CodeGraph（程式）＋DocGraph（規格),隨程式自動長。
- 🩹 **自癒** —— 安全地改自己:不可變快照 → 冒煙測試 → 監督者重啟 → 失敗自動回滾。
- 📄 **文件與簡報** —— Word ⇄ 可編輯 Markdown＋可編輯 BPMN 流程圖,還有有語音的簡報引擎。

*設計哲學:本地優先 · 模型中立 · 檔案即知識 · 隔離又可繼承。*

### `/setup` 實際運作

輸入 `/setup`,模型會偵測你的機器並回報就緒狀態 —— 這裡 **Claude** 與 **Codex** 都正確偵測到已設定完成:

<div align="center">
<img src="docs/screenshots/setup-claude.png" width="420" alt="Claude 執行 /setup"> <img src="docs/screenshots/setup-codex.png" width="420" alt="Codex 執行 /setup">
</div>

## 如何開始使用

### 1. 環境需求

- **Node.js 22+**（Hana 用內建 `node:sqlite`）。
- **Windows** ＋ PowerShell。
- **至少一個已安裝並登入的 AI CLI** —— 這是 Hana 跟模型對話的方式:
  - Claude:`npm i -g @anthropic-ai/claude-code`,再執行 `claude` 登入一次;或
  - Codex,或 Antigravity 的 `agy`。**有任一個就能開始**,其他之後再加。

### 2. 安裝與啟動

```powershell
git clone https://github.com/genairated/g8d_harness.git
cd g8d_harness/portal
npm install            # portal 相依（node-pty 等）—— 一鍵 ./install.ps1 施工中
cd ..
./Start_Harness.ps1    # 啟動 portal（監督者）並開啟瀏覽器
```

接著開啟 <http://localhost:3300/>。

### 3. 首次執行 —— `/setup`

在 Hana 的對話框輸入 **`/setup`**。她會偵測你已經裝了什麼,並針對你想要的選配項目給出
**可複製貼上的指令** —— 語音辨識與會議轉錄、Telegram 控制台、簡報／PPTX 匯出、GPU 加速、
遠端存取。她**不會偷偷幫你安裝**;`/setup` 是顧問,指令由你自己執行。

### 4. 日常怎麼用

- **選一個模型**（Claude／Gemini／Codex）就開始聊。
- **中途換模型** —— 對話脈絡會接續,所以你可以用一個模型起頭、交棒給另一個,**不用重講**。
  這就是核心賣點。
- **開多個分頁**讓不同模型並行,像個小團隊。
- **左側選單**放 Hana 的自我介紹、記憶檔,以及你的專案文件。
- **任務住在伺服器** —— 關掉分頁,長任務照跑;重新連上(或用 Telegram,若已設定)接回原處。

> 預設 portal 只綁 **`127.0.0.1`（僅本機）**——天生安全、零設定。Hana 能讀寫你電腦的檔案、
> 執行 CLI,請把它當成一個 shell:別曝露到不信任的網路。要遠端存取,走私有網路（如 Tailscale）
> ＋設 `PORTAL_TOKEN`,見 `/setup` → 遠端存取,或 `specs/SPEC-setup.md` §12。

## 底層架構

- **`portal/`** —— Node HTTP 伺服器（`server.js`）＋單頁 UI（`index.html`）:AI 對話、文件
  瀏覽器、排程器、會議轉錄、文件管線、站內知識圖譜。
- **`docgraph/`** —— 建在內建 `node:sqlite` 的 markdown 規格／治理知識圖譜（無原生相依）;
  各專案規則放在 `docgraph/profiles/`。
- **`.releases/` ＋ `Deploy_Harness.ps1`／`Rollback_Harness.ps1`** —— 自癒機制:不可變的
  版本化 release,由監督者負責重啟與失敗自動回滾。

## 路線圖

- 一鍵安裝（`install.ps1`）＋ `/setup` 顧問技能,做首次安裝上手。
- 安全預設:預設綁 `127.0.0.1` ＋ 選配 `PORTAL_TOKEN`。
- docgraph 語意層（本地嵌入 → GraphRAG）。

> **CLI 建議**:想要最順的體驗,主力請用 **Claude** 或 **Codex**。Antigravity（Gemini）的 CLI
> 能用,但目前三者中穩定度最差(冷啟動登入偶發、速率限制較嚴)——建議當次要選項。

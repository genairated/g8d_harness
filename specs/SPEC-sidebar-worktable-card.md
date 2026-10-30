# SPEC-sidebar-worktable-card — 工作台卡片化 ＋ Active Sprint 有意義化

> 狀態：草案（決策見 §2）
> 相關：`specs/SPEC-workspace-settings.md`（`nav` 顯示開關 — **本 spec 修改了它的鍵集合**）、`specs/SPEC-portal-architecture.md`
> 任務：`.worktable/TASK.md` §W（W6–W8；與工作區設定 UI 同一批施工，理由見 §6）

---

## 1. 問題

### 1.1 工作台被拆成兩個地方

左上角「Active Sprint 卡片」（`index.html:1071-1091`）顯示的**就是工作台的進度**——它掃 `.worktable/TASK.md` 的 `[ ]`/`[x]` 算出百分比與完成數。但真正要打開工作台（`DASHBOARD.md` / `TASK.md` / `history/`）卻得往下捲到選單中段的「工作台 (WORKTABLE)」摺疊區（`index.html:1207-1237`）。同一件事被切成上下兩塊，中間還隔著八個不相干的功能按鈕。

### 1.2 `SPRINT_20260514` 是假的

`updateProgressInfo()`（`index.html:4097-4132`）只有在 `TASK.md` 找得到 `> **Sprint**: …` 時才會覆寫 badge；本工作區的 `TASK.md` 沒有這一行，於是 badge 永遠停在 HTML 寫死的 `SPRINT_20260514`。這是**顯示假資料**，比沒有更糟。

### 1.3 兩個寫死路徑（順手修掉）

- `updateProgressInfo()` 寫死 `fetch('/api/file?path=.worktable/TASK.md')`，忽略 `manifest.worktable.path`。
- 選單那兩顆按鈕寫死 `loadFile('.worktable/DASHBOARD.md')` / `loadFile('.worktable/TASK.md')`。

自訂 `worktable.path` 的工作區會進度永遠 0%、按鈕點了開不到檔。

## 2. 決策

| # | 決策 | 選定 | 理由 |
|---|---|---|---|
| C1 | 工作台在選單還是卡片 | **移出選單，併入左上角卡片** | 指揮官指示：它跟進度看板是同一件事 |
| C2 | 卡片內怎麼進 DASHBOARD / TASK / history | **三顆常駐 icon 按鈕**：看板、任務、歷程（不是展開才看得到） | 一鍵到達，這是最常用的三個入口 |
| C3 | `history/` 等資料夾樹怎麼辦 | **卡片可展開**，展開後在卡片下緣顯示既有的 `#worktable-tree`；另給「歷程」按鈕一鍵直達（見 §3a） | 低頻，不該常佔空間；但不能弄丟，且 history（已完成任務）比其他資料夾常用 |
| C4 | Sprint badge 去留 | **保留但改成真資料**：`> **Sprint**:` 優先，否則顯示「目前進行中的階段代號」，兩者都沒有就**隱藏** | 指揮官給的二選一是「拿掉或讓它有意義」；階段代號真的有意義（一眼看出卡在哪一段），且零維護成本 |
| C5 | 與 `nav` 開關的關係 | `nav.dashboard` + `nav.task` **合併成單一 `nav.worktable`** | 兩顆按鈕已不是獨立選單項，而是同一張卡的一部分 |

## 3. 卡片版面

取代現有 Active Sprint 卡片（`index.html:1071-1091`）：

```
┌─────────────────────────────────────┐
│ 工作台                    〔§W 工作區設定 UI〕│  ← 標題 + 階段 badge（無資料則不顯示 badge）
│                                     │
│ 任務進度                        82% │
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░               │
│ 已完成: 42 / 51 項        Target: 100% │
│ ─────────────────────────────────── │
│ 〔▤ 看板〕〔☑ 任務 9〕〔🗄 歷程〕 〔⌄〕│  ← C2 三顆常駐 icon + C3 展開鈕
├─────────────────────────────────────┤
│ 📁 history                          │  ← 展開時才出現（#worktable-tree）
│ 📄 SPRINT_2026….md                  │
└─────────────────────────────────────┘
```

規則：
- 標題「Active Sprint」→「工作台」；「Sprint Task Progress」→「任務進度」（中文化，也不再誤導成 Scrum sprint）。
- 前兩顆按鈕沿用既有 id：`#menu-dashboard`、`#menu-task`（含 `#task-badge` 未完成數），**不新造 id**——它們已有 `highlightMenuBtn` 等既有相依。第三顆是新的：`#menu-history`（icon `archive`，與樹裡 history 檔案同一顆 icon）。
- 展開鈕狀態記在 `localStorage['wt_card_expanded']`，預設**收合**。
- `#worktable-tree` 容器**原封不動搬進**卡片展開區（id 不變）→ `shell/sidebar.js` 的 `renderSidebarLists()` / `filterFiles()` 一行都不用改。
- 側邊欄收合（`sb-collapse-hide`）時整張卡片隱藏 —— 維持今天的行為，不另做迷你版。
- 選單中段的 `sec-worktable` 整段（含 `toggleSection('sec-worktable')` 按鈕）**刪除**。`toggleSection()` 函式本身保留（dynamic sections 與 skills 仍在用）。

## 3a. 「歷程」按鈕（C2 第三顆）

`history/` 是**資料夾**（`.worktable/history/*.md`，一個已完工能力段一份），不是單一檔，所以它不能像看板／任務那樣 `loadFile()` 一個路徑。行為定義如下：

1. 點「歷程」→ ① 若卡片是收合的，先展開（同步更新 `localStorage['wt_card_expanded']` 與展開鈕箭頭）②在 `#worktable-tree` 內找到 **top-level `type === 'directory'` 且 `name === 'history'`** 的節點，展開它（移除其 children 容器的 `hidden`、箭頭轉正）③ `scrollIntoView({block:'nearest'})` 捲到該節點。
2. 節點定位**不可寫死 `folder-.worktable-history` 這個 id**——`folderId` 是由 `item.path` 推導的，而 `worktable.path` 可自訂（§5）。實作方式：從 `statusData.worktable` 找出該 directory item 取其 `path`，再組出 `folder-${path.replace(/\//g,'-')}`；找不到就走第 3 點。
3. `statusData.worktable` 裡沒有名為 `history` 的資料夾時（新工作區還沒有歷程），這顆按鈕**隱藏**，不顯示成點了沒反應的死按鈕。此判定放在 `renderSidebarLists()` 之後執行的同一輪 UI 更新裡（`statusData` 就緒後）。
4. 這顆按鈕**不做 `highlightMenuBtn` 高亮**（它開的不是一份檔，沒有「目前正在看」的語意）。

## 4. Badge 的取值（C4）

`updateProgressInfo()` 依序判定，第一個命中者勝：

1. **明示**：`TASK.md` **開頭的 metadata 區塊**（檔首到第一個 `## ` 之前）內、**整行以 `>` 開頭**的 `> **Sprint**: <值>` → 顯示 `<值>`。
   **既有 regex 必須收嚴，不可原樣保留**（見 §4.1）。
2. **推導**：掃 `## §<代號> <標題>` 段落，找出**第一個仍含未勾選 `[ ]` 的段**，顯示 `§<代號> <標題>`（超過 18 字截斷，`title` 屬性放完整標題）。判定只看該段內的 checkbox 行，段落邊界＝下一個 `## ` 或檔尾。
3. **都沒有**（無 `TASK.md`、無 phase、或全部做完）→ badge 加 `hidden`，**不顯示任何字**。全做完時進度條顯示 100%，已足夠表達。

HTML 初始值必須是空字串 + `hidden`，**不得保留 `SPRINT_20260514`**——沒有資料時寧可空著，不假裝有。

### 4.1 既有 regex 是活的 bug（2026-08-03 實測跑版）

現行 `index.html:4125`：

```js
const sprintMatch = data.content.match(/>\s*\*\*Sprint\*\*:\s*([^\r\n()]+)/i);
```

三個缺陷，實際已造成側邊欄爆版（badge 撐成一大團字蓋住整張卡片）：

- **沒有錨定行首、沒有限定範圍**：`>` 只要出現在整份 `TASK.md` 任何位置就算數。本工作區 W7 這條任務**自己在描述這個規則**（行內寫了 `` `> **Sprint**: <值>` ``），於是被自己的說明文字命中。
- **排除字元只排除半形 `()`**：說明文字用的是全形 `（）`，攔不住，整行剩餘內容（含後半段所有敘述）全被吃進 badge。
- **取到的值沒有任何長度上限，badge 也沒有 CSS 夾制**：一長就把側邊欄撐破。

修法（三層，缺一不可）：

1. **收嚴比對**：只在 metadata 區塊（`content.split(/^## /m)[0]`）內比對，且錨定行首 —— `/^>\s*\*\*Sprint\*\*:\s*(.+)$/m`。
2. **清洗取值**：去除前後空白、去除包覆的反引號與 `**`，遇到全形／半形括號即截止；清洗後為空 → 視同未命中，往下一條規則走。
3. **統一收斂顯示**：規則 1 與規則 2 的結果都走同一個 `setSprintBadge(text, fullText)`——超過 18 字截斷加 `…`、`title` 放全文。**同時給 badge 加 CSS 夾制**（`inline-block max-w-[10rem] truncate align-middle`，或等效的 `overflow:hidden; text-overflow:ellipsis; white-space:nowrap`），作為最後防線：**無論值從哪來、多長，都不得撐破側邊欄版面。**

## 5. 路徑正確性（§1.3）

`updateProgressInfo()` 與兩顆按鈕一律改用 `wtPath`：

```js
const wtPath = (statusData?.manifest?.worktable?.path) || '.worktable';
```

`statusData` 尚未載入時（極早期呼叫）退回 `.worktable`，行為與今天相同。兩顆按鈕改為 `addEventListener` 綁定（`init()` 內、`statusData` 就緒後），不再用 inline `onclick` 寫死字串。

## 6. 與 SPEC-workspace-settings（§W）的衝突與合併

兩者都動 `index.html` 側邊欄與 `applyManifest()`，**分開做必然衝突**（W3 要對「寫死那批」逐顆加 `data-nav`，而本 spec 直接刪掉其中兩顆）。因此**併入 §W 同一批施工**，並修訂該 spec：

| SPEC-workspace-settings 原文 | 修訂後 |
|---|---|
| §3 `nav` 含 `"dashboard": true, "task": true` | 改為單一 `"worktable": true`（控制卡片下半的工作台列：三顆按鈕＋展開鈕＋展開區） |
| §1 表格「工作台 / 儀表板」列 `#menu-task`、`#menu-dashboard` 為寫死 markup | 改述為「工作台卡片（`#wt-card`）」 |
| §5.3 `data-nav` 統一 toggle | 不變，卡片工作台列掛 `data-nav="worktable"` |

相容性：W2 的 schema 驗證規則是「未知 `nav` 鍵丟棄而非報錯」，所以任何已寫入 `dashboard`/`task` 的舊 `harness.json` 不會壞，只是被忽略（目前全系統尚無任何 `harness.json` 有 `nav` 欄位——W1 都還沒做）。

**進度條區不受 `nav` 控制**（它是工作區狀態，不是功能入口）；但 `TASK.md` 不存在時整個進度區自動隱藏，只留標題與那排按鈕。

## 7. 不在範圍

- 不改 `DASHBOARD.md` / `TASK.md` 的內容格式，也不強制加 `> **Sprint**:` 行。
- 不做工作台的 view 模組化（今天它走 `loadFile()` 進 wiki 檢視，維持原樣）。
- 不做卡片拖曳、不做多工作台切換。

## 8. 驗收

1. 選單中段不再有「工作台 (WORKTABLE)」區；卡片上有「看板」「任務」「歷程」三顆按鈕，前兩顆點下去分別開出 `DASHBOARD.md`、`TASK.md`，與改版前開的是同一份檔。
2. 展開鈕可展開／收合，展開後看得到 `history` 等資料夾且可點進去；重整後展開狀態被記住。
2b. 卡片**收合**狀態下點「歷程」→ 卡片自動展開、`history` 資料夾自動展開並捲到可視範圍，點裡面任一份 `.md` 開得起來；把 `.worktable/history` 暫時改名後重整 → 「歷程」按鈕消失（不是點了沒反應）。
3. Badge：`TASK.md` 目前無 `> **Sprint**:` → 顯示 `§W …`（第一個有未完成項的階段）；手動在 `TASK.md` 加一行 `> **Sprint**: TEST_X` → 改顯示 `TEST_X`；把該行刪掉並把所有 `[ ]` 勾完 → badge 消失且進度 100%。**任何情況都不再出現 `SPRINT_20260514`。**
3b. **防跑版回歸測**（2026-08-03 實測 bug）：現行 `TASK.md` 的 W7 那一行行內寫著 `` `> **Sprint**: <值>` ``——改版後**不得**被誤判成 Sprint 值（改版前它會把整行敘述塞進 badge、把側邊欄撐爆）。另手動塞一個超長值（如 `> **Sprint**: ` 後接 60 個字）到 metadata 區塊 → badge 只顯示 18 字加 `…`、`title` 有全文、**卡片寬度不變、不換行、不溢出**。
4. 搜尋框輸入關鍵字 → 工作台底下的檔案仍出現在搜尋結果（`filterFiles` 未被破壞）。
5. 側邊欄收合 → 版面不破、無殘留空白卡片。
6. 把 `harness.json` 的 `nav.worktable` 設 `false` → 卡片只剩標題與進度條，三顆按鈕與展開區消失；設 `true` 或不設 → 全部顯示。
7. 在 `harness.json` 自訂 `worktable.path` 的工作區，進度數字與兩顆按鈕都指向該路徑（不再寫死 `.worktable`）。

---

## 9. SBC 增補（`specs/SPEC-sidebar-card-carousel.md`，2026-10-08）

本卡自此是側欄「卡片輪播」（`portal/shell/card-carousel.js`）裡的**第一張**，穩定識別碼 `worktable`（見
SPEC-sidebar-card-carousel.md §3.1）。這份 spec 原本描述的所有內容與行為——卡片本身的 DOM（`#wt-card`／
`#sprint-badge`／`#progress-bar`／`#menu-dashboard`／`#menu-task`／`#menu-history`／`#wt-card-expand-btn`／
`#worktable-tree` 等）、`nav.worktable` 開關語意、§8 驗收項——**完全不變**；唯一變化是它現在被包在輪播殼
（`#sb-carousel` → `#sb-carousel-track` → `.sb-carousel-slide[data-card-id="worktable"]`）裡，與模型用量卡／
外掛客製卡輪流顯示。`sidebarCards.hidden` 也可以把 `worktable` 列進去整張隱藏（opt-out，同 `nav.worktable`
但分屬兩個不同機制：`nav.worktable` 關掉的是卡片內的三顆按鈕＋展開區，`sidebarCards.hidden=["worktable"]`
關掉的是整張卡在輪播裡出現與否）。

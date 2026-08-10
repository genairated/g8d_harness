# 規格搬家稽核 — `_harness` → `g8d_harness`（2026-08-05）

> **緣起**：指揮官發現新站 `specs/` 只有 10 份，全是搬家後新寫的；舊站 `_harness/specs/` 的 35 份**一份都沒搬過來**（新舊檔名零交集）。
> 本檔記錄：① 搬了什麼 ② 逐份比對「規格 vs 現在的程式」的結果 ③ 還沒收斂的漂移。
>
> **稽核方法（誠實說明限度）**：抽出每份 spec 內所有反引號錨點（檔案路徑、`/api/*` 端點、識別字），
> 對現在的 `portal/`＋`global-knowledge/`＋根目錄做存在性比對（腳本：`.harness/runtime/tmp/spec_audit.mjs`），
> 再對可疑項人工查證。**這是「錨點級」比對，不是逐句語意審查**——能抓出「規格講的檔案/函式已不存在或改名」，
> 抓不出「函式還在但行為已改」。下表標 ✅ 者＝**未發現**漂移，不等於逐句驗證過。

---

## 1. 已搬移

35 份全數複製到 `g8d_harness/specs/`（`ARCHITECTURE-portal.md` + 34 份 `SPEC-*.md`），原檔保留在 `_harness/specs/` 未動。

---

## 2. 逐份結果

### ❌ 規格與實作分歧（規格描述的東西不存在）

| Spec | 發現 |
|---|---|
| `SPEC-chain-executor.md` | **整份未實作**。規格的 `Chain` / `ChainRun` / `chains.json` / `chain-runs/` / `reconcileOrphanChainRuns()` / `finalizeChain()` / `triggerChain()` / `deployAfterComplete` 在新舊兩站的程式裡**都查無**。實際落地的是簡化版：`schedule.chainNext`（單一後繼排程，SCHED-CHAIN），UI 在 `views/schedule.js` 的 `orderScheduleChains()`／`drawChainLinks()`，部署走每筆排程自己的 `postRun.deploy`。→ **本規格應標為「未採用，已由 chainNext 取代」或重寫**（待指揮官定奪，我沒有自行改寫規格內容）。 |
| `SPEC-setup.md` | 規格要求的 **`install.ps1` 沒有隨搬家帶到新站**（`_harness/install.ps1` 有、`g8d_harness/` 無）。同樣不在新站根目錄的還有 `README.md`、`package.json`。`global-knowledge/commands/setup.md` 技能本身有搬到、且仍在指示使用者跑 `./install.ps1` → **照現況跑會找不到檔**。 |

### ⚠️ 名稱已漂移（功能還在，規格寫的是舊名）

| Spec | 規格寫的 | 現在的程式 |
|---|---|---|
| `ARCHITECTURE-portal.md` | 單檔 monolith：`server.js ~2600 行`、`index.html` 單檔 SPA、API 全在一條 if 鏈 | 已重構：`api-router.js` 路由表（與殘留 if 鏈**並存**）、`router.js`＋`views/*.js`（15 個 view）、`plugin-loader.js`；server.js 9,381 行、index.html 12,782 行 → **本次已就地更新**（含埠 3400、pwsh、venv 位置、排程工作區隔離） |
| `SPEC-doc-fidelity-export.md` | `initDocPrintMode`、`mdToPdf`、`docExportDocFidelityPdf()` | `initDocFidelityPrintMode()`（index.html）、`render-service/doc-pdf.js` 的 `officeToPdf` |
| `SPEC-doc-editing.md` | `portal/vendor/pptx2html.js` | `portal/vendor/pptx-renderer.js` |

### ⚠️ 規格提到、但程式中查無該識別字（未實作或已換名，**我只驗到「字串不存在」，沒逐一追行為**）

- `SPEC-floating-chat.md` — `getDisplayMedia`（螢幕分享）
- `SPEC-presentation-export.md` — `recordVideo`（簡報錄影）
- `SPEC-multi-model-panel.md` — `deepThink`、`memoryCandidate`（排程「精華待審」有實作，但用的是 `/api/schedules/candidates`，不是這兩個名字）
- `SPEC-meeting-summary.md` — `mergeModel`、`mergePrompt`、`versionKey`
- `SPEC-document-templates.md` — `renderImageEmbedsIn`
- `SPEC-doc-editing.md` — `getSchemeColorFromTheme`、`slideMasterTextStyles`

### ✅ 未發現錨點漂移（其餘 27 份）

`SPEC-audio-topic`、`SPEC-block-deck`、`SPEC-browser-pilot`、`SPEC-chat-multimodal`、`SPEC-daily-reflection-post`、
`SPEC-doc-convert`、`SPEC-doc-roundtrip`、`SPEC-document-framework`、`SPEC-document-registry`、`SPEC-excel-import`、
`SPEC-fbpost-privatization`、`SPEC-gmail`、`SPEC-history-hygiene`、`SPEC-meeting-correction`、`SPEC-meeting-export`、
`SPEC-meeting-import`、`SPEC-meeting-transcriber`、`SPEC-meeting-workspace`、`SPEC-presentation-core`、
`SPEC-project-management`、`SPEC-resilient-cli`、`SPEC-schedule-status`、`SPEC-scheduler`、`SPEC-stickies`、
`SPEC-telegram`、`SPEC-document-templates`(除上述一項)、`SPEC-setup`(除 install.ps1)

> 這些 spec 剩下的「查無」全是雜訊：模板路徑（`<uuid>`、`*.html`、`runs/<scheduleId>/…`）、執行期才生成的資料檔、
> `.worktable/TASK.md §X` 之類的段落引用、以及 `server.js:3143` 這種會漂移的行號。

---

## 3. 建議後續（未做，等指揮官決定）

1. `SPEC-chain-executor.md` 標記為「未採用」或按 `chainNext` 現況重寫。
2. `install.ps1`（＋ `README.md`、`package.json`）要不要從舊站帶過來——它是舊站布局寫的，帶過來前要先照新站（埠 3400、`.venv` 在 g8d_harness）校過，不宜直接複製。
3. 上表「查無識別字」六項逐一確認是「沒做」還是「換名」，再決定改規格還是補功能。
4. 舊站 `_harness/specs/` 的 35 份原檔要不要就地標「已搬家，看 g8d_harness」以免日後誤讀。

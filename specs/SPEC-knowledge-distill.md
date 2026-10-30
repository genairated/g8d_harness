# SPEC — 知識精華收斂（Knowledge Distill）

> 狀態：已實作（KD1–KD5 全數完工，待指揮官逐階段手動驗證；決策紀錄見 §7，實作對齊見 §9-10）
> 作者：Hana ・ 2026-09-10
> 關聯：[[SPEC-history-hygiene]]（§5 精華候選的產生與待審清單）、[[SPEC-scheduler]]（工作區隔離鐵則）、`portal/server.js`（applyMemoryOps / candidates API）、`portal/views/schedule.js`（精華待審頁籤）

## 0. 問題（指揮官語言）

每跑一次排程都會冒出新的地雷或新發現，累積成一長串「精華待審」。指揮官不會每次逐條審，
通常放一陣子才一次收斂。但現在的審核只有「採用／丟棄」兩顆鈕，**採用＝把那句話原封不動 append 到記憶檔尾巴**——
不比對既有記憶、不合併重複、不淘汰過時、不修正錯誤。結果是記憶檔越長越肥、同一件事講三遍、舊結論跟新結論並存。

要的是：按一顆「開始彙整」，Hana 才開始想；把待審精華跟既有記憶**深度比對**，出一張逐條說明的表
（過時／錯誤／重複／部分收納／全部收納），列出本次建議寫入的內容；指揮官可全接受、全拒絕或逐條挑；
決定後清空待審。

## 1. 現況根因（survey 結論）

- 候選產生：排程 run 收尾時 agent 吐 `<memory-candidate>` JSON（`insight` + 建議 `bucket`），存成 `runs/<schedId>/<runId>/candidate.json`（`scheduler.js` `saveMemoryCandidate`）。
- 待審清單：`GET /api/schedules/candidates` → `collectCandidates(workspaceRoot)`，**已依當前工作區過濾**（`resolveWorkspace(req)`）。
- 審核：`POST /api/schedules/:id/runs/:runId/candidate/review` → `applyMemoryOps({ops:[{file:bucket, action:'add', text:insight}]}, wctx.knowledgeDir)`。
  - **關鍵缺口**：只用 `action:'add'`。而 `applyMemoryOps` 其實**早就支援** `replace`（改寫既有條目）與 `remove`（刪除既有條目）——能力在，只是沒人用。
  - 一次只能審一條，且完全沒有「跨條目 + 既有記憶」的全局視野。
- 記憶檔落點：`<工作區>/.harness/knowledge/{MEMORY,USER,AGENT,PERSONA}.md`，`MEMORY_SPECS[name].cap` 有字數上限，超過只會印警告、無人壓縮。

⇒ 需求 1「依工作區彙整、寫回該工作區」**現有管線已成立**，本規格不必重造；缺的是 §2 的「收斂」這一層。

## 2. 設計總則

1. **智慧在 Hana、儲存與裁決在頁面**：比對／判斷哪條過時哪條錯誤，是語意工作，只有模型做得到 ⇒ 做成**技能**。
   「按鈕觸發、看表、勾選、送出、清空」是狀態與互動 ⇒ 做成**頁面**。兩者合體，不二選一。
2. **不重造輪子**：寫入一律走既有 `applyMemoryOps`（含 add/replace/remove）；候選讀取沿用 `collectCandidates`；
   工作區判定沿用 `resolveWorkspace(req)` + `path.resolve()` 正規化（[[SPEC-scheduler]] 鐵則）。
3. **提案與套用分離**：技能只**產出提案檔**，一個字都不寫進記憶檔；真正寫入只發生在指揮官按下「套用」之後、由後端執行。
   ⇒ 模型判斷失準也不會直接污染記憶。
4. **可回溯**：套用前先對四個記憶檔做一份快照，放 `<ws>/.harness/runtime/distill/snapshots/<ts>/`，出事能還原。
5. **工作區隔離**：提案檔、快照、清空動作，全部只作用於當前工作區。

## 3. 資料模型

提案檔：`<工作區>/.harness/runtime/distill/proposal.json`（每個工作區同時只保留一份「進行中」提案，重跑覆蓋）

```
{
  "generatedAt": "ISO8601",
  "workspace": "<絕對路徑>",
  "candidateCount": 12,
  "rows": [
    {
      "id": "r1",
      "sources": [{ "scheduleId": "...", "runId": "...", "scheduleName": "...", "insight": "原文", "part": "全部 | 部分（哪一段）" }],
      "verdict": "adopt | merge | partial | outdated | wrong | duplicate",
      "reason": "為什麼——一句話，指揮官看得懂的話",
      "bucket": "MEMORY | USER | AGENT | PERSONA",
      "op": { "action": "add|replace|remove|none", "old": "既有記憶原文（replace/remove 必填）", "new": "要寫入的最終文字" },

      "clusterId": "c2",              // 所屬主題群（§3.1 排序與衝突）
      "conflictsWith": ["r37"],       // 與哪幾列邏輯衝突（同群內互斥，不該同時收）
      "status": "pending | accepted | rejected | commented | agreed | disputed | applied",
      "thread": [                     // 逐輪對話（§3.2），時間序
        { "by": "commander", "at": "ISO8601", "text": "指揮官的備註／建議" },
        { "by": "hana", "at": "ISO8601", "model": "claude::opus", "text": "我重新思考後的回覆", "outcome": "agree | dispute", "newText": "採納後修正的最終寫入文字" }
      ]
    }
  ],
  "clusters": [
    { "id": "c2", "title": "排程工作區隔離", "order": 3, "hasConflict": true }
  ],
  "candidateLedger": [                // §3.3 來源帳本：一筆候選 → 它被拆進哪些列
    { "scheduleId": "...", "runId": "...", "rowIds": ["r3", "r18"], "settled": false }
  ],
  "model": "claude::opus",            // §3.4 本次彙整所用模型（產生提案時記下）
  "housekeeping": [ /* 與候選無關、純粹清理既有記憶的建議（同 op 結構），可空 */ ]
}
```

**入場門檻（2026-09-10 指揮官拍板，先於 verdict 判定）**：值得記憶的只有「**沒有存在任何規格文件、沒有寫好的腳本程式、AI 思考過程中經常踩雷的**」。
學習過程吸收的領域／技術知識、已寫在 spec 或程式裡的事實、只在當次成立的臨場狀態、以及**只講「做不到」卻沒講「怎麼做才對」的無效結論**，一律判掉（`op.action:"none"`）。
判準：唸出這一條，若不能讓未來的我少走一步冤枉路，就沒有價值。寧可少收——提案越短越審得動。完整規則見技能檔 §步驟 3.0。

`verdict` 語意（＝需求 3 那張表的「逐條說明」欄）：
| verdict | 中文標籤 | 意思 | 典型 op |
|---|---|---|---|
| `adopt` | 全部收納 | 全新知識，直接收 | add |
| `merge` | 併入既有 | 與既有某條講同一件事，合併成更完整的一條 | replace |
| `partial` | 部分收納 | 只有一部分值得留，其餘是當下脈絡 | add（精簡後） |
| `outdated` | 過時 | 既有記憶已被它推翻，或它本身已被更新的事實推翻 | replace 或 none |
| `wrong` | 錯誤 | 判斷本身有誤，不該進記憶 | none |
| `duplicate` | 重複 | 既有記憶已完整涵蓋 | none |

### 3.1 排序與衝突偵測（需求：相關聯的放一起、互斥要看得出來）

- 提案表**不是按候選產生時間排**，而是先由 Hana 做**主題分群**（`clusters`），同一主題的列必定相鄰，群內再按「先總則、後細節／先新後舊」排序。
- 每群給一個看得懂的中文群名（例：「排程工作區隔離」「Deploy 時機」）。群之間依重要性（影響面大小）排序。
- **衝突偵測是強制步驟**：Hana 必須在群內、以及跨群做一次「兩兩是否邏輯互斥」的檢查，
  互斥的雙方各自寫入 `conflictsWith`，並在該群 `hasConflict:true`。
- 頁面對衝突列給明顯標記（紅框 + 「與第 N 條互斥」），且**同時勾選互斥雙方時，送出鈕鎖住並提示**——
  避免第 1 條與第 50 條一起被收進去。
- 「全部接受」在存在未解衝突時**不可直接送出**，必須先在衝突群內做取捨。

### 3.2 逐條裁決與往返討論（需求：我可以備註、你要真的再想一次）

每列有四種去向，對應 `status`：

| 指揮官動作 | Hana 的動作 | 結果 |
|---|---|---|
| **接受** → `accepted` | 無 | 套用時直接寫入，該列來源候選清掉 |
| **拒絕** → `rejected` | 無 | 直接捨棄，該列來源候選清掉（原始 candidate.json 留底） |
| **備註**（打字送出）→ `commented` | 重新思考，**同意** → `agreed`（附修正後的 `newText`） | 套用時寫入「修正後」版本，清掉 |
| **備註** → `commented` | 重新思考，**不完全認同／有疑慮** → `disputed`（附理由） | **不寫入、不清掉**，留到下一輪 |

- 指揮官送出備註後，該列進入 `commented`，由 `POST /api/knowledge-distill/rethink` 觸發 Hana **只針對這幾列**重新思考
  （不重跑整份彙整），把回覆 append 進該列 `thread`，並更新 `status` 為 `agreed` 或 `disputed`。
- **Hana 的思考結果必須看得見**：`agreed` 要說「我原本哪裡表達不精準／偏差在哪、改成什麼」；
  `disputed` 要說「我為什麼仍有疑慮、根據是什麼（引既有記憶或 spec）」——不能只回一句「好的」。
- **反覆往返**：`disputed` 的列，指揮官可以直接接受 Hana 的說法（→ `accepted`）、拒絕（→ `rejected`），
  或**再留一次備註**（→ `commented`，再觸發一次 rethink）。`thread` 就是這條知識的完整討論紀錄，逐輪顯示在該列下方。
- **部分套用是常態**：一次送出只結算 `accepted` / `agreed` / `rejected` 的列；`commented` / `disputed` 的列連同其來源候選**留在提案裡**，
  提案檔不刪，直到全部列都定案才清空。⇒ 需求 5 的「清空待審」變成**逐條清空**，不是一次全清。

### 3.3 候選與提案列的多對多結算（需求：全部結案才能清掉）

一筆「精華待審」候選可能被拆進**多列**提案（一段 insight 同時講了兩件事），一列提案也可能由**多筆候選**合併而成。
因此「清空待審」不能以列為單位，必須以**候選**為單位結算：

- 提案檔多一份 `candidateLedger`：每筆候選記下它被拆進哪些 `rowIds`（Hana 產提案時必須誠實填，不可漏登）。
  這是雙向索引——`row.sources` 是列→候選，`candidateLedger` 是候選→列。
- **結算規則**：候選 `(scheduleId, runId)` 只有在它的**每一個** `rowIds` 都已定案
  （`accepted` / `agreed` / `rejected` / `applied`）時，才標 `reviewed:true`、從精華待審清單消失。
  只要還有任一列停在 `commented` / `disputed`，這筆候選**留在清單上**。
- 套用（`apply`）流程改為：先結算列 → 再依 `candidateLedger` 反查哪些候選「全數列已定案」→ 只清那些。
  已寫入的列不會被重複寫入（標 `applied`）。
- 部分結算時，候選在清單上以「處理中 2/3 列」的樣式標示，避免指揮官誤以為沒動作。
- **完整性檢查（防漏）**：產提案時，若有候選沒被登進任何列（含判為 `wrong`/`duplicate` 的也要登，只是 op 為 `none`），
  視為提案不完整 ⇒ 頁面顯示警告並列出未登記的候選，套用鈕鎖住，直到重跑或人工確認。
- **例外：晚到候選不阻擋（2026-09-10 修正）**。若未登記候選的 `startedAt` **晚於** `proposal.generatedAt`，
  代表它是彙整跑完之後才由排程產生的，不是提案缺漏——這種情況必然會發生且重跑也可能再發生。
  這類候選歸入 `completeness.deferred`（不進 `unregistered`、不影響 `complete`），
  頁面只顯示灰色提示「有 N 筆精華會留到下一輪」，**不鎖套用**。

### 3.4 模型選擇（需求：我要能決定用哪個模型）

- 「開始彙整」按鈕旁附一個模型下拉，選項與現有排程表單一致（`portal/views/schedule.js` 的模型 select）：
  Claude Sonnet／Claude Opus／Claude Haiku／Gemini Flash。
- **預設 Claude Opus**（深度比對是這功能的全部價值），但指揮官可自行改；選擇記在 `localStorage`，下次沿用。
- `POST /api/knowledge-distill/run` 與 `/rethink` 都接受 `model` 參數，透傳給既有 agent 執行管線
  （與排程執行走同一條路，不另造）；未帶時用預設。
- 每次往返（rethink）可**單獨選模型**——例如提案用 Opus 產、後續小幅釐清用 Sonnet 省額度。
- 提案檔與每則 `thread` 回覆都記下當時所用模型，頁面顯示（讓指揮官看得出哪條是哪個模型想的）。

## 4. 技能 `/knowledge-distill`

放 `global-knowledge/commands/knowledge-distill.md`（全域、所有工作區共用；`.md` 存檔即生效，**不需 Deploy**）。

步驟（技能本文寫死）：
1. 讀當前工作區四個記憶檔全文（`.harness/knowledge/*.md`）。
2. 打 `GET /api/schedules/candidates` 取本工作區所有未審候選（含來源排程名與時間）。
3. **深度比對**：逐條候選 × 既有記憶全文，判 `verdict`；跨候選之間也要合併（同一個雷被三筆排程各記一次 ⇒ 合成一條）。
4. **分群與排序**（§3.1）：把 rows 歸成主題群、給中文群名、排出順序。
5. **衝突偵測**（§3.1）：群內與跨群兩兩檢查邏輯互斥，填 `conflictsWith` / `hasConflict`。這一步不可略過。
6. 順手挑出既有記憶中**互相矛盾或明顯過時**的條目，放 `housekeeping`（需求 2 的「過時、錯誤」不只針對新候選）。
7. **登錄來源帳本**（§3.3）：把每一筆候選對應到它被拆進的 rowIds，一筆都不可漏（判為錯誤／重複的也要登，op 記 `none`）。
8. 寫出 `proposal.json`（含本次所用模型）；不碰任何記憶檔。
9. 回覆指揮官一段簡短摘要（幾群、幾條、幾條建議收、幾條要淘汰、有無互斥），提示到精華待審頁看表。

另有一支**重新思考**入口（同技能、`mode:rethink`）：只讀提案檔中 `status:commented` 的列 + 指揮官備註 + 既有記憶，逐列重想並寫回 `thread`／`status`，同樣不碰記憶檔。

## 5. 頁面（精華待審頁籤）

- 既有清單上方新增一列工具條：**模型下拉（預設 Opus）** + **「🧪 開始彙整」** 按鈕 + 上次彙整時間 + 「本次 N 群 M 條、K 組互斥」摘要。
- 按下 → `POST /api/knowledge-distill/run`：後端以既有 chat/agent 管線在**背景**跑該技能（不阻塞頁面），回 jobId；前端輪詢狀態。
- 完成 → 切到「彙整提案」檢視：**按群分區顯示**（群標題可摺疊），群內逐列，衝突列紅框標「與第 N 條互斥」。
  每列顯示：來源排程／原文／verdict 中文標籤色票／理由／目標桶別／最終寫入文字。
- 每列的操作：**接受 ／ 拒絕 ／ 備註**（備註是一個輸入框，送出後該列顯示「等待 Hana 重新思考」）。
  列下方即為 `thread`：指揮官的備註與 Hana 的回覆逐輪往下貼，Hana 的回覆標明 **同意（附修正後文字）** 或 **仍有疑慮（附理由）**。
- **每個群（區塊）標題列自帶「全部接受／全部拒絕」**，只作用於該群的列（`__nocluster__` 未分群視為一群）。
  有互斥的群其「全部接受」鎖住（會直接造出未解衝突），但仍可整群拒絕。
  搭配技能步驟 4 的「先分收納／捨棄兩邊再分主題群」，指揮官可一群一拍、不必逐條。
- 底部工具條：**全部接受**、**全部拒絕**、**送出已備註的（請 Hana 重新思考）**、**套用已定案項**。
  - 存在未解衝突（互斥雙方同時為 accepted）時，「套用」與「全部接受」鎖住並提示要先取捨。
- 「送出已備註的」→ `POST /api/knowledge-distill/rethink`：背景跑技能 rethink 模式，只處理 `commented` 列，完成後頁面刷新該列的 `thread` 與新狀態。
- 「套用已定案項」→ `POST /api/knowledge-distill/apply`：
  1. 快照四個記憶檔；
  2. 取 `accepted` + `agreed` 列的 `op`（`agreed` 用 `thread` 最後一則的 `newText`）組成 ops，一次交給 `applyMemoryOps`；
  3. 依 `candidateLedger`（§3.3）反查：**只有所有衍生列都已定案的候選**才標 `reviewed:true` ⇒ 待審清單逐筆消失；
     仍有列在討論中的候選留在清單上，並顯示「處理中 x/y 列」；
  4. 若仍有 `commented`／`disputed` 列，提案檔**保留**（只移除已定案列）；全部定案才刪 `proposal.json`；
  5. 回傳寫入摘要（哪個桶＋幾條、有無超 cap 警告、還剩幾條在討論中）。
- 「全部拒絕」＝ ops 空陣列，所有列標 `rejected`、候選全標 `reviewed:true`、刪提案檔。

## 6. 階段拆解

- **KD1 — 提案產生**：技能檔 + `proposal.json` 格式（含 clusters／conflictsWith／status／thread／candidateLedger／model）+ 背景執行 API（`run`／`status`，接受 `model` 參數）。
- **KD2 — 提案檢視 UI**：分群顯示、衝突標記與互斥鎖、逐列三種操作、thread 顯示。
- **KD3 — 往返討論**：`rethink` API + 技能 rethink 模式 + 狀態機（commented → agreed／disputed → 再備註循環）。
- **KD4 — 套用與逐候選清空**：快照、`applyMemoryOps` 批次寫入、依 `candidateLedger` 判斷候選是否全數結案再標 reviewed、提案檔部分保留／全清、未登記候選的完整性警告。
- **KD5 — 收尾**：spec 同步、Telegram 輕推「本工作區彙整提案已就緒，N 條待裁決／M 條等你回覆」（沿用既有 sink）。
- 每階段結尾固定一條「🧑‍✈️ 指揮官手動驗證」。

## 7. 決策紀錄（2026-09-10 指揮官已拍板）

- **D1 拒絕的候選是否留底**：「全部拒絕」後候選標 `reviewed` 即從清單消失，原始 `candidate.json` 仍留在 run 目錄（可事後翻）。
  另一種是連檔一起刪。**✅ 已拍板：留底**（不佔空間，將來要追「當初為什麼否決」還找得到）。
- **D2 是否一併整理既有記憶（§4 步驟 4 的 housekeeping）**：會讓 Hana 動到「跟本次候選無關」的既有條目（刪重複、改過時）。
  好處是記憶檔真的會瘦下來；風險是動的範圍比指揮官預期大。**✅ 已拍板：做，但在表上獨立分區、預設不勾**，要動得自己勾。
- **D3 跑彙整用哪個模型**：**✅ 已拍板：由指揮官在頁面上選**（不寫死），預設 Opus，每次往返可單獨選 ⇒ 見 §3.4。
- **D4 觸發點是否也給排程**：除了手動按鈕，要不要允許建一筆「每月自動產提案」的排程（只產提案、絕不自動套用）？
  **✅ 已拍板：先不做**，等手動用順了再說。

- **D5 往返沒有收斂時怎麼辦**：`disputed` 的列可以無限往返。要不要設一個「第 3 輪仍未達成共識就強制二選一（依指揮官／依 Hana）」的收尾機制？
  **✅ 已拍板：不設上限**，但頁面對往返 ≥3 輪的列加醒目標記，讓指揮官知道這條卡住了。
- **D6 部分套用後的比對基準**：先套用一批會改變既有記憶，留在討論中的列原本的比對基準就舊了。
  **✅ 已拍板**：rethink 時一律**重讀當下的記憶檔**（不吃提案產生當時的快照），並在回覆中說明「因為剛剛已寫入 X，我的看法改成 Y」。

## 8. 明確不做

- 不改候選的產生方式（`<memory-candidate>` 那段照舊）。
- 不另造記憶儲存或記憶格式；不動 `MEMORY_SPECS` 的 cap 值。
- 不做自動套用（任何寫入都必須經指揮官按鈕）。
- 不動 `GET /api/schedules/candidates` 既有逐條「採用／丟棄」的路徑——保留，讓指揮官偶爾想快速處理單條時仍可用。

## 9. Telegram 輕推（KD5-2，實作對齊）

- 觸發點：`fireDistillJob` 的 `onComplete`——**只在 `mode !== 'rethink'`（全新彙整）且 job 狀態為 `done`** 時，
  呼叫 `notifyDistillReady(wctx)`（`portal/server.js`）。`rethink` 不推（那是往返討論的小幅更新，不算「提案就緒」）。
- `notifyDistillReady` 只讀**該工作區自己**的 `proposal.json`（`distillProposalPath` 本來就落在 `wctx.root` 底下），
  算出 `pendingCount`（`status:pending`）與 `disputedCount`（`status:disputed`）；兩者皆 0（例如全部列都已是
  `accepted`/`agreed`/`rejected`/`applied`）就不推，避免空訊息。
- 沿用既有 sink：直接呼叫 `schedulerManager.sinkManager.deliverOne('telegram', {kind:'distill_ready', workspaceLabel, pendingCount, disputedCount})`，
  格式化交給 `telegram.js` 的 `_formatNotification`（新增 `distill_ready` 分支）。**做法比照 SN4 `note_reminder`**：
  不做 chat-context 過濾、不接 web sink（`saveNotification`）——broadcast 給所有已授權的 Telegram 使用者，
  只在訊息文字內用 `workspaceLabel` 標明是哪個工作區。單一指揮官帳號下這與「工作區隔離」等效；
  真正的隔離重點是**訊息裡的數字只算這個工作區自己的 proposal.json**，不會把別的工作區的待審數混進來。
- 未做：不接 web 通知（`/api/activities`）——這則本來就沒有 `scheduleId` 可歸屬到某個 schedule 的 workspace，
  硬塞會落到 `WORKSPACE_ROOT` 誤判成 home 工作區的通知，故只做 Telegram 這一條路徑。

## 10. Changelog

- 2026-09-10：KD1–KD4 實作完成（提案產生／檢視 UI／往返討論／套用與逐候選清空），內容與 §3–§6 一致，未發現落差。
  KD5 補上 §9 的 Telegram 輕推設計並落地；本節同步記錄實際觸發時機（僅 `run` 非 `rethink`、僅 Telegram、broadcast+標籤而非 chat 過濾）。

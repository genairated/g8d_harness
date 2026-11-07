# SPEC-list-index — 全平台清單目錄檔（index.json）

> 狀態：草案 v0.1（2026-11-06 立案，Charles 拍板採「清單目錄檔」標準做法；§12 開放決策待拍板）
> 相關：`portal/server.js`（各清單 API）、`portal/scheduler.js`（排程／執行記錄／通知／精華候選）、`portal/document-registry.js`、`portal/notes.js`、`portal/issues.js`、`portal/pm.js`、`portal/whiteboards.js`、`portal/uidesign.js`、`portal/audio-topics.js`、`portal/usage-tracker.js`、`portal/telegram.js`
> 相關規格：`specs/SPEC-scheduler.md`、`specs/SPEC-chat-background-task.md`、`specs/SPEC-chat-durability.md`、`specs/SPEC-document-registry.md`、`specs/SPEC-telegram.md`、`specs/SPEC-knowledge-distill.md`
> 任務：`.worktable/TASK.md` §IDX

---

## 1. 問題（2026-11-06 實測）

伺服器只有一條執行緒。幾支清單 API 每次被呼叫都「把整個資料夾的每一個檔案打開、整份讀完、再挑幾個欄位」，而且用的是會卡住整台伺服器的同步讀檔。只要其中一支在跑，其他所有請求（包含本來 30ms 就好的「文件」清單）都要排隊等。

實測（客戶專案 `D:\Projects\客戶專案`，經 `:3400`，依序呼叫、各自單獨量）：

| API | 時間 | 回應大小 | 主因 |
|---|---|---|---|
| `GET /api/chat/history` | **9.7 s** | 14 KB | 每次整份讀 1,303 個對話檔（32 MB），其中 1,189 個是排程產生的對話、最後只列 100 筆 |
| `GET /api/runs?status=running` | **9.9 s** | 5 KB | 每次整份讀 1,052 個排程資料夾、1,896 個執行記錄，只為了找出「正在跑」的那幾筆 |
| `GET /api/runs` | 8.2 s | 367 KB | 同上；且**不分工作區**（客戶專案與 g8d 回的是同一份） |
| `GET /api/schedules` | 2.8 s | **6.3 MB** | 每次解析 7.75 MB 的 `schedules.json`（1,121 筆，其中 **1,030 筆已歸檔**）＋對每筆排程讀它全部的執行記錄找「執行中」 |
| `GET /api/schedules/candidates` | **9.0 s** | 204 KB | 每筆排程讀最多 500 筆執行記錄找「精華候選」；`/api/knowledge-distill/status`（前端輪詢）也走同一條 |
| `GET /api/status`（側欄資料夾樹） | **19.6 s** | 318 KB | 每次遞迴掃描所有側欄資料夾（`.harness/knowledge` 就有 8,526 個檔）——盤點時新發現，比上面幾支都慢 |
| `GET /api/documents` | 27 ms | 32 KB | 已有目錄檔，正常；但被上面幾支卡住時要等 8.6 s |

另外：
- 前端每 60 秒呼叫一次 `GET /api/schedules`（側欄紅點），每次 6 MB／2.8 s。
- 客戶專案對話資料夾裡已出現 **3 個 0 位元組的壞檔**（`chat_sched_run_1789224870128_s474.json` 等）——證明現在的「直接覆寫」寫法遇到中斷會留下半截檔，正是 §2 第 6 條「先寫暫存檔再替換」要解決的。
- `schedules.json` 裡的 `workspace` 欄位有 9 種寫法對應約 4 個真實工作區（正斜線／反斜線／雙重跳脫／斜線被吃掉的 `d:projects客戶專案`／打錯一字的客戶專案名）。目錄檔分工作區存放時必須先把這些正規化，否則會有排程「掉出所有清單」。

## 2. 通則（Charles 2026-11-06 拍板，全平台一體適用）

1. **清單頁只讀一份目錄檔**：清單 API 只讀該工作區、該功能的 `index.json`，不再逐檔打開。
2. **點了才讀全文**：目錄只放清單要顯示的欄位（id、標題、狀態、時間、幾個篩選用欄位）；要看內容才用單筆 API 讀實際檔案。
3. **所有寫入同步更新目錄**：建立／改狀態／歸檔／刪除，每一條寫入路徑都要在同一個動作裡更新目錄。漏一條＝清單錯。
4. **歸檔另存一份**：已歸檔／已完成／回收桶的項目存在 `index.archive.json`，只有使用者點「顯示已歸檔」時才讀。
5. **可從實際檔案重建目錄**：目錄只是「快取」，實際檔案才是真相。伺服器啟動時核對，對不上就自動重建；也提供手動「重建目錄」。
6. **寫目錄先寫暫存檔再替換**：寫 `index.json.tmp-*` → 確認寫完 → 換名蓋過去。任何時候中斷，磁碟上不是舊的完整版就是新的完整版，不會有半截檔。
7. **寫入一律經伺服器排隊**：同一份目錄同一時間只有一個寫入者，避免兩個寫入互相覆蓋（後寫者把前一個的更新吃掉）。
8. **格式用 `index.json`**；**一個工作區一份**，工作區隔離自然成立（讀哪個工作區就只讀那個工作區的目錄，不必再逐筆比對工作區欄位）。

## 3. 目錄檔格式

```jsonc
{
  "schema": "harness.list-index/1",
  "kind": "chat",                         // 功能代號，見各節
  "workspace": "D:\\SideProject\\g8d_harness",   // 正規化前的原值，供人看
  "workspaceKey": "d:\\sideproject\\g8d_harness", // path.resolve()+小寫，比對用
  "updatedAt": "2026-11-06T10:00:00.000Z",
  "rebuiltAt": "2026-11-06T09:00:00.000Z",  // 最近一次完整重建
  "count": 100,
  "fingerprint": "…",                     // 見 §5.2，核對用
  "items": [ { "id": "…", "...": "只放清單欄位" } ]
}
```

- 位置：**工作區自有資料** → `<工作區>/.harness/index/<kind>.json`、`<kind>.archive.json`。
  **平台共用資料**（排程、執行記錄、通知，實體檔在 `HARNESS_HOME/global-knowledge/schedules/`）→ `HARNESS_HOME/global-knowledge/schedules/index/<workspaceKey 的 sha1 前 12 碼>/<kind>.json`，檔內 `workspace` 欄位寫明是哪個工作區（見 §12 決策 D1）。
- `.harness/index/` 加進 `.gitignore`（目錄是快取，不進版控）。
- 目錄裡**不放大欄位**：不放對話訊息、排程指示全文、執行記錄的 resolvedPrompt／輸出、文件內文。

## 4. 共用「目錄讀寫模組」 `portal/list-index.js`（IDX-0）

所有功能共用同一支模組，不各自實作。對外介面（示意）：

```js
const idx = listIndex.open({
  kind: 'chat',
  indexPath, archivePath,                 // 由呼叫端依 §3 算好
  workspace,
  scanSource: async () => [ /* 從實際檔案掃出每筆的清單欄位 */ ],  // 重建用，必須是非同步讀檔
  fingerprintSource: async () => '…',     // 便宜的核對值，見 §5.2
  isArchived: entry => !!entry.archived,  // 決定進主目錄還是歸檔目錄
  sort: (a, b) => …,
});
await idx.list({ includeArchived:false });   // 讀主目錄（記憶體快取＋檔案修改時間檢查）
await idx.listArchived();
await idx.upsert(entry);                     // 新增或更新一筆；依 isArchived 自動放對邊
await idx.remove(id);
await idx.rebuild({ reason });               // 從實際檔案完整重建
await idx.verify();                          // 核對，對不上就排一次重建
```

設計要點：

- **讀**：第一次讀檔後放記憶體；之後每次只 `stat` 一次檢查修改時間，沒變就直接用記憶體版。讀檔一律用非同步 `fs.promises`，不卡伺服器。
- **寫**：每份目錄一條排隊（同一個 `indexPath` 的寫入串成一條 Promise 鏈，依序執行）。每次寫：讀最新版 → 套用變更 → 寫 `*.tmp-<pid>-<亂數>` → `rename` 蓋過正式檔。Windows 上被防毒或其他程式短暫鎖住時（`EPERM`／`EBUSY`），重試最多 5 次、間隔遞增（50→800 ms），仍失敗就記錯誤、保留暫存檔、**不讓原本的業務寫入失敗**（目錄壞了可重建，業務資料不能因此丟）。
- **順序**：業務檔先寫成功，再更新目錄。目錄更新失敗＝下次核對時會被發現並重建，不會錯在業務資料。
- **目錄壞掉或不存在**：清單 API 不回 500，改走「舊的逐檔讀取」作為保底（但改成非同步讀），同時排一次重建；回應加 `X-Index-Fallback: 1` 標頭方便診斷。
- **重建不卡伺服器**：非同步讀檔，每處理 50 筆讓出一次（`setImmediate`），大工作區重建期間其他 API 照常回應。同一份目錄同時只跑一個重建，重建期間的寫入照樣排隊、重建完再套用。
- **模組本身不認識任何功能**：哪些欄位進目錄、怎麼掃實際檔案、怎麼判斷已歸檔，全部由各功能傳入。
- **單元測試** `portal/checks/list-index.test.js`：暫存目錄下測 新增／更新／刪除／歸檔移轉／壞檔保底／中斷模擬（暫存檔殘留不影響讀）／同時 50 個寫入不遺失／重建等於逐筆寫入的結果。

### 4.1 實作備註（IDX-0，2026-11-06）— 後續子項照這個用

**改了哪些檔**：新增 `portal/list-index.js`、`portal/checks/list-index.test.js`；`portal/server.js` 只加三處（`require('./list-index')`、`POST /api/index/rebuild` 與 `GET /api/index/status` 兩支路由、開機 `listen` 回呼裡一行背景 `verifyAllOnBoot`）。`.gitignore` 未改：本 repo 已整個忽略 `.harness/` 與 `global-knowledge/`。使用者專案的 `.gitignore` 只忽略 `.harness/runtime/`，所以模組在**自己建立的目錄資料夾裡放一個內容為 `*` 的 `.gitignore`**（比照 `.venv`／`.pytest_cache` 的通行做法），不去動使用者的 `.gitignore`。

**函式簽名**（`const listIndex = require('./list-index')`）：

```js
// 位置
listIndex.normalizeWorkspace(p, harnessHome?)    // → path.resolve(p || harnessHome).toLowerCase()；兩者皆空丟 TypeError
listIndex.indexDirFor(workspaceRoot)             // → <ws>/.harness/index
listIndex.sharedIndexDirFor(baseDir, wsRoot)     // → <baseDir>/index/<sha1(normalizeWorkspace(ws)) 前 12 碼>
//   例：sharedIndexDirFor(path.join(HARNESS_HOME,'global-knowledge','schedules'), ws)
// 給 scanSource / fingerprintSource 用的小工具
listIndex.eachYield(arr, async (x, i) => entry|undefined, every=50)  // 逐筆處理、每 50 筆讓出；回 undefined 的略過（壞檔）
listIndex.idSetFingerprint(ids)                  // → "<數量>:<排序後 id 的 sha1 前 16 碼>"（§5.2 只看檔名）

// 單份目錄（同一 indexPath 不論大小寫，開幾次都回同一個物件＝同一條排隊）
const idx = listIndex.open({
  kind, indexPath, archivePath?,      // archivePath 不給＝不分歸檔
  workspace,                          // 原值，寫進檔內 workspace；workspaceKey 自動算
  scanSource: async () => entries[],  // 重建用；必須非同步讀檔，建議用 eachYield
  fingerprintSource?: async () => string,  // 每次寫入後與重建時記錄；verify() 比對
  isArchived?: entry => bool,         // 預設全部進主目錄
  sort?: (a, b) => number,            // 寫入時就排好，list 直接回
  idOf?: entry => id,                 // 預設 entry.id（對話可傳 e => e.sessionId）
});
await idx.list({ includeArchived? })  // → { items, fallback }；fallback:true 時 items=[]，模組已自動排重建
await idx.listArchived()              // → { items, fallback }
await idx.get(id)                     // → entry | null（主目錄找不到再找歸檔）
await idx.upsert(entry)               // → { ok:true } | { ok:false, error } | { ok:false, deferred:true }；永不丟出
await idx.remove(id)                  // → 同上
await idx.rebuild({ reason? })        // → { ok, count, archivedCount, ms } | { ok:false, error }
await idx.verify()                    // → { ok, rebuilt, reason? }  reason：missing／corrupt／archive-*／fingerprint
await idx.status()                    // → { kind, workspace, indexPath, archivePath, valid, count, archivedCount,
                                      //     updatedAt, rebuiltAt, rebuilding, pendingWrites, lastError, lastErrorAt }

// 功能登錄（後續子項在 server.js 啟動時呼叫一次）
listIndex.registerIndexKind(kind, wsRoot => listIndex.open({...}) | null)
listIndex.getIndex(kind, wsRoot)       // 依工作區快取 handle
listIndex.rebuildWorkspace(wsRoot, kind?)  // → { accepted:[kind], unknown:[kind] }（不等重建完成）
await listIndex.statusWorkspace(wsRoot)    // → [status()…]
await listIndex.verifyAllOnBoot([wsRoot…]) // 依序核對；重複工作區（正規化後）只做一次；永不丟出
```

**呼叫端慣例**：① 業務檔先寫成功，再 `idx.upsert()`／`idx.remove()`（不必 await 結果判斷成敗，它不會丟出）。② 清單 API：`const r = await idx.list(); if (r.fallback) { res.setHeader('X-Index-Fallback','1'); …走舊的逐檔讀（改非同步）… }`。③ 目錄缺檔／壞檔時 `upsert` 回 `deferred:true`、**不會寫出只有一筆的殘缺目錄**——等重建從實際檔案掃到它。④ 同時進來的寫入會合併成一次寫檔（50 筆同時 upsert 實測只寫幾次）。⑤ API：`POST /api/index/rebuild` body `{kind?}` → 202 `{ok, workspace, accepted}`；指定的 kind 未登錄 → 404；body 不是 JSON → 400。`GET /api/index/status` → `{ok, workspace, kinds:[status…]}`，目前尚無登錄＝`kinds:[]`。

**自測**：`node portal/checks/list-index.test.js` 17/17 通過（輸出 `.worktable/artifacts/idx/idx-0-test.txt`），含 rename 被鎖重試（模擬 EPERM 3 次後成功、EBUSY 一直失敗→1+5 次後放棄、不丟出、保留暫存檔、舊目錄仍可讀）、0 位元組與半截 JSON 壞檔、重建期間寫入排隊。兩支 API 以「從 server.js 原文抽出路由、掛隔離埠 3399」鏡射測過（空登錄 200／202、未知 kind 404、壞 body 400、登錄後重建→狀態數量正確）。未起完整 server。

**量測**（客戶專案對話資料夾複本 1,303 檔／32 MB，放 `_tmp/idx/sample/`，`_tmp/idx/bench.js`）：改前「逐檔同步整份讀」2.4～3.1 秒（這台機器、無其他請求競爭；線上 9.7 秒含其他負載）；改後讀目錄檔第一次 22 ms、之後（快取＋stat）0.2～0.9 ms；一次性重建 4.2 秒（背景、每 50 筆讓出），目錄檔 126 KB。3 個 0 位元組壞檔在重建時被略過。**此數字是模組能力示範**：IDX-0 本身還沒接任何清單 API，線上耗時要等 IDX-CHAT 等子項接上才會變。

**已知限制**：① 寫入連續失敗（rename 被鎖 6 次）後磁碟上的目錄會少那一筆，模組只記錯誤、不自動重試；靠下次開機核對（有 fingerprintSource 才抓得到）或手動重建補回。② 指紋在每次 API 寫入後重算，因此「直接改檔」若剛好發生在兩次 API 寫入之間，會被下一次寫入的指紋吸收而不被核對發現（§5.3 已知取捨）。③ 讀取快取以「修改時間＋大小」判斷，同一毫秒內同大小的外部改檔理論上可能漏讀，實務上可忽略。④ `scanSource` 內部怎麼讀檔由呼叫端負責；只有用 `eachYield` 才保證重建期間不卡伺服器。

## 5. 重建與核對

### 5.1 時機
- **伺服器啟動時**：對每個已登錄工作區（`global-knowledge/projects.json`）的每份目錄跑一次 `verify()`；放在啟動完成、開始接請求**之後**以背景方式執行，不拖慢開機。
- **目錄缺檔／解析失敗**：當下排重建。
- **手動**：`POST /api/index/rebuild`（body：`{ kind?:'chat' }`，不帶就重建該工作區全部），帶 `X-Workspace`。供「重建目錄」按鈕、也供 Hana 在對話裡自己呼叫。回應立刻回 `202`，進度可用 `GET /api/index/status` 查。
- 不做定時全量重建（浪費、且會與寫入搶排隊）。

### 5.2 核對方式（要便宜）
- 只列檔名、不打開檔案：`readdir` 取得實際檔案的 id 集合，與目錄的 id 集合比較；數量或集合不同＝對不上。
- 有需要的功能可再加「資料夾內檔案最新修改時間」比對（只 `stat`、不讀內容）。
- 排程（單一大檔）用 `schedules.json` 的「大小＋修改時間」當指紋；不同就重建排程目錄。

### 5.3 Hana 直接改檔的情況
Hana 或其他程式可能不經 API 直接改實際檔案（例如用寫檔工具改便條或文件）。這種改動目錄不會即時知道，靠：① 啟動時核對；② 手動重建；③ 單筆 API 讀到實際檔案時，若發現與目錄的清單欄位不同，順手更新那一筆。規格不承諾「直接改檔」能即時反映在清單上——這是已知取捨。

## 6. 同時寫入的處理

- 伺服器內：§4 的每份目錄一條排隊即可，因為所有 API 與排程器都在同一個 Node 程序裡。
- 伺服器外的寫入者（排程任務裡的模型、Telegram 處理、人手改檔）：**一律不直接寫目錄檔**；要改資料就呼叫 API，或只改實際檔案、等核對／重建。這條寫進各功能的技能檔與 `buildChatPrompt` 提示（各子任務順手檢查有無相關技能需補一句）。
- 多顆伺服器同時開（測試時誤起第二顆）：不保證正確，維持既有鐵則「不要起第二顆完整 server」。

## 7. 歸檔目錄

- 進歸檔目錄的條件由各功能定義（排程：`archived:true`；便條：`status:'done'`；文件：回收桶；問題回報：已結案……）。
- 項目狀態改變時，`upsert` 自動把它從主目錄搬到歸檔目錄（或反過來）。
- 清單 API 加參數 `?archived=1`（或沿用各功能既有的參數名）才讀歸檔目錄。前端「顯示已歸檔」按鈕才帶這個參數。

## 8. 排程主檔拆成一筆一檔（選配階段 IDX-SPLIT，風險高）

現在 1,121 筆排程全在一個 7.75 MB 的 `schedules.json`，每次新增／修改任何一筆都要整份讀寫。§9.1 的排程目錄能解決「清單慢」，但解決不了「每次寫入都整份重寫」。拆檔是把每筆排程存成 `schedules/items/<id>.json`。

**風險**：搬家過程若中斷或有程式沒改到，可能**遺失排程**或**同一筆排程被執行兩次**（新舊兩邊都看得到）。因此：
1. 只能在 IDX-0 與 IDX-SCH 都驗收後才做。
2. 搬家前把 `schedules.json`、`runs/`、`notifications.json` **完整備份**到 `global-knowledge/schedules/_backup-<時間>/`，並記下筆數與每筆內容的雜湊。
3. 搬家期間停止排程器的定時檢查（暫停 tick），搬完、核對完才恢復。
4. **逐筆核對**：新檔數量＝舊陣列數量、每筆內容雜湊相同、id 不重複；任何一項不符就整批放棄、保留原檔。
5. 舊 `schedules.json` 改名為 `schedules.json.migrated-<時間>`，**不刪**；並在讀取端加保護：若 `items/` 與舊檔同時存在，只認 `items/`，絕不兩邊合併執行。
6. 一定要有回退步驟（把備份放回去即可恢復），寫進該子任務的報告。
7. 由指揮官選時間手動執行，不排自動。

## 9. 各功能

> 每節格式：**現況**（資料存在哪、清單 API、讀法、資料量）／**改法**／**驗收**。數據為 2026-11-06 實測。

### 9.1 執行記錄（runs）— IDX-RUN ｜ 第一優先
- **現況**：`HARNESS_HOME/global-knowledge/schedules/runs/<排程id>/<執行id>.json`（1,052 個排程資料夾、1,896 筆執行記錄、27 MB）。`GET /api/runs` → `queryRuns`（scheduler.js）每次 readdir 全部資料夾＋整份解析每一筆；`getRunningRun`／`getRuns` 為了找「執行中」也是整個資料夾讀完。**不分工作區**（客戶專案與 g8d 回同一份 367 KB）。客戶專案實測 `?status=running` 9.9 s、全部 8.2 s。同路徑的其他使用者：Telegram `/today`（`_cmdToday`）、開機 `flushPendingDeliveries`、`reconcileOrphanRuns`、每日 `collectHousekeepingTargets`、部署前 `hasAnyRunningRun`。
- **改法**：每個工作區一份執行記錄目錄（`schedules/index/<ws>/runs.json`），欄位：id、scheduleId、status、startedAt、finishedAt、trigger、model、resumeCount、origin（只留 kind／sessionId／channel）、fromChat、hasCandidate、candidateReviewed、usage 摘要。寫入點：`createRun`、`updateRun`、`saveMemoryCandidate`、整理逐字稿／刪除執行記錄（housekeeping、transcript clear）。同檔內另維護「執行中」清單，`getRunningRun`／`hasAnyRunningRun` 只看它。歸檔排程的執行記錄進 `runs.archive.json`（決策 D5）。`GET /api/runs` 讀目錄後依參數過濾；`/api/runs/:id` 單筆照舊讀實際檔案。工作區過濾見決策 D2。
- **驗收**：客戶專案資料複本上 `?status=running` < 100 ms、全部 < 300 ms；建一筆→跑→完成，目錄與實際檔案一致；刪掉目錄檔重開，自動重建後數量與實際 `run_*.json` 數相同；對話紅色數字照常出現。

#### 9.1.1 實作備註（IDX-RUN，2026-11-06，待 Deploy）
> D2、D5 指揮官尚未拍板，**依 Hana 建議值實作**（D2＝A：`/api/runs` 預設只回當前工作區，`?scope=all` 回全部；D5＝A：已歸檔排程的執行記錄進 `runs.archive.json`）。

**改了哪些檔**：`portal/scheduler.js`（主體）、`portal/server.js`（只動 `GET /api/runs` 一處）、新增 `portal/checks/runs-index.test.js`。`portal/index.html` 沒改。

**怎麼做**（與 §4.1 模組搭配）：
- 目錄位置：`global-knowledge/schedules/index/<工作區雜湊>/runs.json`＋`runs.archive.json`；kind `'runs'` 在 `SchedulerManager` 建構時登錄（`registerIndexKind`），可 `POST /api/index/rebuild {kind:'runs'}` 重建；核對指紋＝各排程資料夾內檔名的 id 集合（只 readdir、不開檔；第一次實際 readdir，之後靠 `createRun` 增量維護，因為執行記錄只增不刪）。
- 工作區對應：`scheduleId → schedule.workspace`（`path.resolve()`＋小寫），null＝harness home；找不到排程的執行記錄歸 harness home，重建時列在 console（樣本裡有 2 個資料夾：`sched_1782206521802_d5ee`、`sched_1784192907881_mskf`）。排程對照表以 `schedules.json` 的「大小＋修改時間」當快取鍵，只 stat 一次。
- 寫入點：`createRun`、`updateRun`（含對帳、完成、續跑、housekeeping／transcript clear 的 `transcriptCleared`，它們本來就走 `updateRun`）、`saveMemoryCandidate`（寫 `candidateReviewed`）。**專案裡沒有任何「刪除執行記錄」的程式路徑**（transcript clear／housekeeping 只刪逐字稿、改旗標），所以沒有 remove 要接。
- 記憶體：`_runMem`（現役排程的摘要）＋`_running`（執行中）。啟動順序：`reconcileOrphanRuns()` → `warmRunIndex()`（背景：核對、必要時重建、載入記憶體）。**暖機完成前** `queryRuns` 走舊的逐檔讀取（保底，且照樣套 workspace 過濾）；**對帳完成後** `getRunningRun`／`hasAnyRunningRun` 就看 `_running`（不再讀資料夾）。
- `queryRuns(opts)` 新增 `opts.workspace`（D2）；暖機後回清單摘要欄位（id、scheduleId、status、startedAt、finishedAt、trigger、model、resumeCount、origin{kind,sessionId,channel,chatId}、fromChat、hasCandidate、candidateReviewed、usage{calls,runtimeMs}），**不含** resolvedPrompt／delivery／error 等大欄位。`fromChat`／origin 回填規則與舊 `/api/runs` 完全相同，改在寫入時算好，`/api/runs` 不再逐筆讀排程檔。
- 前端：`fetchChatRunningTasks` 只用 `fromChat`、`origin.sessionId`、`scheduleId`、`startedAt`，都保留，**不需改**。
- 新方法 `syncRunsArchiveFlag(scheduleId)`：**IDX-SCH 在歸檔／還原排程時要呼叫**，把該排程所有執行記錄搬進／搬出 `runs.archive.json`（D5）。本子項沒有碰歸檔 API。

**自測**（`node portal/checks/runs-index.test.js`，合成資料 10 項；加 `--real` 另跑真實樣本）：
- 合成：未暖機走舊路徑、暖機後欄位齊全且無大欄位、建立→執行中→完成目錄同步、工作區隔離（寫法不同／null）、fromChat 規則、候選審核旗標不被洗掉、歸檔排程搬進歸檔檔與還原、刪目錄檔重開後重建數量＝實際檔案數、對帳殘留 running、暖機失敗保底。
- 真實樣本（`global-knowledge/schedules` 複本放 `_tmp/idx/runs-sample/home`，1,138 筆排程／1,030 筆歸檔／1,899 筆執行記錄）：6 組查詢參數（無參數、全部、status=running、status=failed、scheduleId、since/until）新舊逐筆相同；現役排程的 run 數＝實際檔案數。共 **18/18 通過**。未起 server、未啟動排程器。

**量測**（這台機器、無其他負載；線上因競爭更慢，客戶專案實測 8～10 秒）：

| 查詢 | 改前（逐檔讀） | 改後（記憶體） |
|---|---|---|
| 無參數（50 筆） | 5,424 ms | 0.55 ms |
| 全部（500 筆） | 5,441 ms | 0.65 ms |
| status=running | 4,972 ms | 0.05 ms |
| status=failed | 5,314 ms | 0.05 ms |
| since/until | 5,230 ms | 0.05 ms |
| 執行中查詢（1,121 個排程各查一次） | （每次讀資料夾） | 合計 1 ms |
| 一次性暖機＋重建（背景） | — | 26.2 s（只在目錄不存在時；之後開機只核對） |

目錄檔：現役 runs.json 約 140 KB（主工作區）、歸檔 runs.archive.json 約 411 KB。

**已知限制／風險**：
1. **一次性重建要 26 秒**（背景、每 50 筆讓出，不卡請求），這段時間 `queryRuns` 仍走舊的慢路徑；第一次 Deploy 後的前半分鐘清單仍慢，之後正常。
2. **開機的 `reconcileOrphanRuns` 仍是一次同步全掃**（改前就有、約數秒，開機時卡一次）；本項沒改它，因為它必須在目錄可用前先把殘留 running 修好。要根治需另立項把它改成「只看目錄裡的 running」。
3. **D2 的代價**：`/api/runs` 預設只回當前工作區，對話的紅色背景任務數字只算目前工作區（以前是全部混在一起）。Telegram `/today`、`injectActivityContext` 仍自己過濾（兩者都沒帶 workspace 參數，拿到的是全部再自行過濾，結果不變）。
4. 歸檔排程的執行記錄不在全域 `queryRuns`（D5）；指定 `scheduleId` 且記憶體沒有時仍逐檔讀（單一資料夾，很快）。歸檔旗標在「寫入當下」與「重建」時才決定，排程事後被歸檔要靠 IDX-SCH 呼叫 `syncRunsArchiveFlag`。
5. 目錄摘要的 `trigger` 缺值統一補 `'auto'`（舊檔有些沒有此欄位）；`fromChat` 是寫入當下算的，排程的對話標記事後改變不會回頭更新（重建會修正）。
6. 真實資料裡有 **7 個 0 位元組的執行記錄壞檔**（例如 `sched_1789031149953_jqqr` 底下），新舊都略過，目錄不收。
7. 看到但沒改（別的功能也慢）：`collectHousekeepingTargets`、`collectCandidates`（IDX-CAND）、`GET /api/runs/:runId`（逐排程找）、`injectActivityContext` 每次聊天都整份解析 `schedules.json`（IDX-SCH 範圍）、`getSchedule()` 每次整份解析。
8. 執行中以「本行程記憶體」為準：行程外直接把 run 檔改成 `running`（不經 `updateRun`）不會被看見。專案內沒有這種寫法。

### 9.2 排程清單（schedules）— IDX-SCH ｜ 第一優先
- **現況**：單一大檔 `global-knowledge/schedules/schedules.json`（7.75 MB、1,121 筆，**1,030 筆已歸檔**，91 筆現役）。`GET /api/schedules` 每次整份解析＋過濾工作區＋過濾對話衍生排程＋**對每筆排程讀它全部執行記錄找「執行中」**，回傳含指示全文（客戶專案 6.3 MB、2.8 s）。前端側欄紅點每 60 秒呼叫一次；排程頁 SSE 斷線時每 15 秒輪詢。詳情與編輯已改用 `GET /api/schedules/:id`（views/schedule.js），清單不需要指示全文。
- **改法**：每工作區兩份目錄（`schedules.json` 現役、`schedules.archive.json` 已歸檔），欄位：排程本體去掉 `task.prompt`（改放 `taskKind` 與前 120 字 `taskPreview`）。執行中狀態改讀 IDX-RUN 的執行中清單。寫入點：`createSchedule`、`updateSchedule`（含排程器每次跑完寫 lastRunAt／nextRunAt、續跑）、`deleteSchedule`、歸檔／還原。指紋＝`schedules.json` 大小＋修改時間（§5.2）。前端「顯示已歸檔」才帶 `?archived=1`（排程頁若已有歷史分頁，就讓它改呼叫此參數）。`/api/schedules/deploy-targets` 也改讀目錄。排程器自己的每 60 秒檢查仍讀主檔（拆檔是 §8 選配）。
- **驗收**：客戶專案複本上清單 < 100 ms、回應 < 200 KB；新增／編輯／歸檔／刪除後清單即時正確；側欄紅點數字與改前一致；「顯示已歸檔」看得到歷史排程。

#### 9.2.1 實作備註（IDX-SCH，2026-11-06，待 Deploy）

**改了哪些檔**：`portal/scheduler.js`（主體）、`portal/server.js`（只動 `GET /api/schedules` 與 `GET /api/schedules/deploy-targets` 兩段）、`portal/views/schedule.js`（歷史摺疊改成展開才載入＋接續下拉補查）、`portal/views/usage.js`（名稱對照表補 `?archived=1`）、新增 `portal/checks/sched-index.test.js`。`portal/index.html`（側欄紅點 `refreshSchedBadge`）**沒改**：它本來就只取 `!archived && lastRunStatus !== 'success'`，清單預設只回現役後結果相同。

**怎麼做**：
- **寫入只有一個出口**：codegraph／全文搜尋確認，寫 `schedules.json` 的路徑（createSchedule、updateSchedule、deleteSchedule、歸檔／還原、`recordRunOutcome`、`scheduleResume`、`_tick`／`_tickWithMissedRun` 清 pendingResume、`reconcileOrphanRuns`、server.js 的 postRun 回寫）最後全走 `saveSchedules()`；server.js 與其他檔案**沒有**直接寫主檔。所以目錄同步只掛在 `saveSchedules`：業務檔寫成功後，拿「本次整份」跟「上次同步的快照」逐筆比對指紋（entry 的 JSON），只對有變的 upsert、不見的 remove、換工作區的從舊區 remove 再到新區 upsert；快照在本行程第一次寫入時趁覆寫前讀一次舊檔建立（之後都在記憶體）。目錄同步失敗只記 log，不影響業務寫入。
- **歸檔／還原連動**：快照發現 `archived` 旗標變了，就呼叫 IDX-RUN 留下的 `syncRunsArchiveFlag(id)`（D5）。
- **目錄**：kind `'schedules'`，位置 `global-knowledge/schedules/index/<工作區雜湊>/schedules.json`＋`schedules.archive.json`。欄位＝排程本體去掉 `task.prompt`（改放 `taskKind`＋前 120 字 `taskPreview`；skill 型用「skill args」當預覽），另去掉 `pendingResume.partial`（最多 8000 字，清單用不到）。`task` 物件仍在（沒有 prompt），所以前端用 `s.task.kind` 的地方不受影響。排序＝建立時間（createdAt），再以 id 定序。指紋＝`schedules.json` 大小＋修改時間（§5.2）。
- **啟動**：`start()` 呼叫 `warmSchedIndex()`（背景、不 await）：建快照、對每個出現過的工作區 `verify()`，對不上或缺檔就重建。暖機前清單走保底。
- **`GET /api/schedules`**：改 `listSchedulesForWorkspace(wsRoot, archived)`。預設只回現役；`?archived=1` 回歸檔。回應標頭 `X-Archived-Count`＝該工作區歸檔筆數；目錄不可用時自動走保底（**非同步**讀主檔、欄位形狀相同）並加 `X-Index-Fallback: 1`。仍套 `isChatOnlySchedule` 過濾；`running` 改由 IDX-RUN 的記憶體清單查（歸檔項不查）。
- **`GET /api/schedules/deploy-targets`**：改讀各工作區的現役目錄（`listActiveSchedulesAllWorkspaces`）；未暖機或任一份不可讀 → 保底走主檔（`X-Index-Fallback: 1`）。
- **前端**：①排程頁：載入時只取現役；「📜 歷史（已歸檔 N）」的 N 來自 `X-Archived-Count`；摺疊時不載內容、顯示「展開時載入…」，使用者展開（或原本就展開著的重繪、或翻到第 2 頁）才帶 `?archived=1` 取歸檔。②「成功後接續」下拉：現役清單裡找不到目前選的目標（已歸檔）時，才補查一次歸檔把它帶進來。③用量統計頁：名稱對照表多取一次 `?archived=1`，歷史排程的用量名稱才不會變成「未命名」。清單內沒有任何前端用到 `task.prompt`：詳情與編輯本來就走 `GET /api/schedules/:id`（views/schedule.js 671、1359 行）。
- **工作區正規化（D7）**：比對鍵＝`path.resolve()`＋小寫、null＝harness home；雙反斜線、大小寫、結尾斜線、正斜線等寫法歸同一份目錄（單元測試涵蓋）。**對不上任何登錄工作區的不改資料**，列在下方請指揮官確認。

**自測**（`node portal/checks/sched-index.test.js [--real]`；不起 server、不啟動排程器，真實資料只讀、複本放 `_tmp/idx/sch-sample/home`）：
- 合成 15 項全過：指示全文不進目錄＋預覽、工作區隔離、排序、更新、排程器回寫與續跑（`pendingResume.partial` 不進目錄、主檔仍在）、歸檔／還原（兩邊搬移＋`syncRunsArchiveFlag` 連動）、刪除、搬工作區、5 種寫法歸同一區、目錄檔被刪走保底並自動重建、重開後暖機不重建、重建＝逐筆寫入結果、同時 40 次寫入不遺失、目錄取不到時保底不拋錯。
- 真實樣本（1,138 筆、1,030 筆歸檔、7.48 MB）：**6 個工作區、1,122 筆（去除對話衍生者）舊清單去掉 `task.prompt` 後與新清單逐筆比對，數量與欄位全部相同**；現役清單連順序都相同，三份「歸檔」清單順序與主檔不同（見已知限制 3）。`IDX-0`、`IDX-RUN` 的單元測試（17／10）重跑仍全過。
- API 鏡射（把 server.js 兩段路由原文抽出、掛隔離埠 3399、後端用樣本複本）：200；客戶專案現役 54 筆、無 `task.prompt`、無歸檔項、每筆有 `running` 欄位、`X-Archived-Count: 762`；`?archived=1` 762 筆全為歸檔；deploy-targets 暖機後 92 筆（現役）、未暖機走保底 1,122 筆並帶 `X-Index-Fallback`。

**量測**（這台機器、無其他負載；客戶專案工作區）：

| 項目 | 改前 | 改後 |
|---|---|---|
| 清單耗時（伺服器內部：解析＋過濾＋組 JSON） | 157～167 ms（整份解析 7.5 MB 主檔，**未含**逐排程讀執行記錄找「執行中」；線上實測含此項為 2.8 s） | 冷讀 2.7 ms、之後 ≈2 ms（記憶體） |
| 清單耗時（含 HTTP，鏡射埠） | — | 28～30 ms |
| 回應大小 | 6,131 KB（816 筆含歸檔、含指示全文） | **42～50 KB**（54 筆現役） |
| 展開歷史（`?archived=1`） | （原本就一起回） | 26～33 ms、約 595～714 KB（762 筆，只有展開才載） |
| deploy-targets | 整份解析主檔 | 2～6 ms |
| 目錄檔 | — | 7 個工作區共 1,043 KB |
| 首次暖機（7 個工作區各重建） | — | 約 1.0～4.0 s（背景；之後開機只核對，175 ms） |
| 一次 `saveSchedules`（本機） | 約 1.2 s（純寫 7.5 MB 主檔） | 約 1.3 s（+約 0.14 s 差異比對；目錄寫入在背景排隊） |

**已知限制／風險**：
1. **線上實際數字要 Deploy 後才知道**；上表「改前 157 ms」不含執行記錄查詢，線上的 2.8 s 主要來自那一段，已由 IDX-RUN 的記憶體清單取代，兩項合起來才是完整效果。
2. **歷史（已歸檔）改為展開才載入**：收合時看得到筆數但看不到內容；展開瞬間會多一次請求（約 30 ms）。排程頁「全選」「批次」只作用於已載入的那張表。
3. **歸檔清單的顯示順序可能與以前不同**：目錄固定依建立時間排，舊主檔是寫入先後；實測 3 份歸檔清單（客戶專案／g8d／_harness）有少數手動塞入的舊排程（id 不是時間戳，如 `sched_1782810000001_n001`）位置不同，現役清單順序完全相同。
4. **deploy-targets 只回現役**（原本連歸檔一起回，但前端下拉本來就濾掉歸檔）；若有別的呼叫端要歸檔項，需另加參數。
5. **每次 `saveSchedules` 多約 0.14 s 的差異比對**（要為 1,100 多筆算指紋；同步執行）。相對原本 1.2 s 寫檔占約一成；若日後覺得明顯，可改成只對「呼叫端宣告有改的 id」比對。
6. **指紋是整個主檔的大小＋時間**：任一工作區寫入都會讓其他工作區下次開機多重建一次（便宜、正確，只是首次開機多花數百毫秒）。
7. 目錄是「記憶體快照＋本行程寫入」：行程外直接改 `schedules.json`（手改、別的工具）不會即時反映，等下次開機核對或 `POST /api/index/rebuild {kind:'schedules'}`。
8. null workspace 一律歸 harness home（與 IDX-RUN 一致）；舊程式是歸 server 當下的 `WORKSPACE_ROOT`，兩者只在 `HARNESS_PROJECT_ROOT` 與 `HARNESS_HOME` 不同時才有差別。
9. 看到但沒改（別的功能也慢）：`getSchedule()` 與 server.js 其他 `loadSchedules()` 呼叫（約 10 處，例如 `injectActivityContext`、Telegram 排程指令、`/api/schedules/:id/…`）仍每次整份解析主檔；排程器 `_tick` 依指示不動。

**D7 待指揮官確認（沒有改任何資料）**：工作區欄位正規化後仍對不上已登錄工作區的排程共 4 筆：
- 1 筆（現役）：工作區名稱被打錯一個字（客戶專案），名稱「對話背景任務：你是 Hana，工作區 D:\Projects\…」。
- 3 筆（現役）：工作區寫成「D:Projects客戶專案」（反斜線被吃掉），名稱含「【問題回報 9】」「【問題回報 10】」等。
這 4 筆在客戶專案的排程清單**本來就看不到**（舊程式也是比對不上），新清單同樣看不到，行為沒變；建議指揮官確認後再決定是否把它們的 `workspace` 改回客戶專案。樣本全文清單見 `.worktable/artifacts/idx/idx-sch-test.txt`。

### 9.3 對話清單（chat）— IDX-CHAT ｜ 第一優先
- **現況**：`<ws>/.harness/runtime/chat_history/chat_*.json`。客戶專案 1,303 檔（含上下文 md 共 32 MB），其中 **1,189 是排程產生的對話**、4 個主題對話、7 個檔案對話，清單只列 100 個自由對話；每次 `GET /api/chat/history`（`getChatHistories`）整份讀全部（9.7 s）。同樣逐檔讀的還有 `GET /api/chat-sessions?filePath=|ctxKey=`（浮動對話「接續上次」）與 Telegram `/chats` `/back` `/whichchat` `/recap`（`_tgListChatSessions`，連整個訊息陣列都留著）。已有 3 個 0 位元組壞檔。
- **改法**：每工作區一份 `chat.json`，欄位：sessionId、title、updatedAt、origin（human／schedule）、filePath、contextKey、contextKind、contextLabel、meetingId、pmProjectIds、訊息數、最後一則前 60 字（Telegram 用）。寫入點：所有存對話檔的函式（新建、每輪回寫、改標題、刪除、背景任務回寫、排程對話建立）——實作前用 codegraph 找出全部寫 `chat_*.json` 的路徑，一條都不能漏。三支清單（自由對話／依檔案或脈絡／Telegram）都改讀這份再過濾。順手把對話檔本身改成「先寫暫存再換名」；壞檔在重建時略過並記錄。
- **驗收**：客戶專案複本上清單 < 100 ms；送新訊息、改標題、刪對話後清單即時正確；浮動對話「接續上次」與 Telegram `/chats` 結果與改前相同；刪掉目錄自動重建後筆數一致。

#### 9.3.1 實作備註（IDX-CHAT，2026-11-06，待 Deploy）

**改了哪些檔**：新增 `portal/chat-index.js`（欄位定義、掃描、寫入同步、三支清單過濾、原子寫入）、`portal/checks/chat-index.test.js`；`portal/server.js`（登錄 kind `'chat'`、7 個寫入／刪除點、三支清單、`GET /api/index/status` 補 `skipped`、移除舊 `getChatHistories`）；`portal/telegram.js`（`_listChatSessionsFn` 變 async，6 處呼叫加 `await`，`_sessionStatusLine` 一併改 async）。目錄的讀寫、排隊、重建一律走 §4.1 共用模組，沒另寫一套。

**目錄**：`<ws>/.harness/index/chat.json`（不分歸檔；排程產生的對話也登錄，`origin` 區分，清單 API 再過濾）。欄位：sessionId、title（自訂標題）、firstUser（第一則使用者訊息前 31 字，用來推預設標題）、updatedAt、origin、filePath、contextKind／contextKey／contextLabel、meetingId、pmProjectIds、msgCount、lastText（最後一則前 60 字）。排序＝updatedAt 新到舊。指紋＝資料夾內 `chat_*.json` 檔名集合（只 readdir）。

**寫入點清單（一條一條對過 codegraph／全文搜尋，共 7 個）**：
1. `saveChatSession`（唯一的「整份寫對話檔」函式）→ 涵蓋新建、每輪回寫、`saveChatPending`（含 X2 檢查點）、`saveChatSessionMerged`、背景任務回寫 `appendMessageToChatSession`、Telegram `chatFn`／`_tgCreateChatSession` 初次存檔、排程對話（`fireScheduledJob` 走一般回合收尾）。
2. `PATCH /api/chat/history/:id`（改標題）。
3. `DELETE /api/chat/history/:id/messages/:index`（刪單則訊息）。
4. `_tgCreateChatSession` 的標題補寫。
5. `DELETE /api/chat/history/:id`（刪對話）→ remove。
6. 排程「清除逐字稿」（`chat_sched_<runId>.json` 刪除）→ remove。
7. 每日 housekeeping 逐字稿清理 → remove。
業務檔先寫成功才同步目錄；目錄失敗只記 log，不影響對話存檔。

**三支清單**：`GET /api/chat/history`（human 且無脈絡）、`GET /api/chat-sessions?filePath=|ctxKey=`、Telegram `_tgListChatSessions`（排除 schedule、保留 telegram 來源——這是改前就有的差異，原樣保留）。回應欄位與改前完全相同。Telegram 清單的 `messages` 改成「被讀取時才開檔」（`/back`、摘要卡、`/whichchat` 用得到），`/chats` 列清單完全不開檔。目錄不可用時走**非同步**掃資料夾保底（欄位形狀相同）並加 `X-Index-Fallback: 1`，同時排重建。

**壞檔**：重建遇到 0 位元組或解析失敗的對話檔→略過、不刪，記在 `GET /api/index/status` 的 chat 項（`skipped` 數量＋`skippedFiles` 前 20 個）與 console。客戶專案樣本略過 3 個（`chat_sched_run_1789224870128_s474`、`chat_sched_run_1789225770274_2i14`、`chat_session_1789227458486`）。

**對話檔寫法**：`writeFileAtomicSync`：寫 `.tmp-<pid>-<亂數>` 再 rename；被鎖（EPERM／EBUSY／EACCES）重試 5 次（20→400 ms），仍失敗才丟出並清掉暫存檔、舊檔完整保留。內容格式沒變。

**自測**（`node portal/checks/chat-index.test.js --real`，13/13；輸出 `.worktable/artifacts/idx/idx-chat-test.txt`；未起 server）：合成 8 項（欄位不含訊息、壞檔略過不刪、upsert／remove 與三支過濾、刪目錄保底＋自動重建、外部多一個檔核對重建、同時 40 次寫入不遺失、原子寫入含 rename 被鎖、非標準資料夾）；真實樣本（客戶專案複本 1,390 檔→1,300 筆可解析，放 `_tmp/idx/chat-sample/ws`）：`/api/chat/history` 100 筆、Telegram 清單 101 筆（含 messages 逐筆）、`/api/chat-sessions` 7 個 filePath＋4 個 ctxKey 查詢，**新舊逐筆完全相同**（舊函式取自 git HEAD 的 server.js 原文）；刪目錄重開自動重建筆數一致。

**量測**（這台機器、無其他負載；線上因競爭更慢，客戶專案實測 9.7 s）：

| 項目 | 改前（逐檔同步讀） | 改後 |
|---|---|---|
| `/api/chat/history` | 2.6～6.8 s | 暖機後約 1 ms（第一次讀檔 1.1 ms、之後 0.7 ms） |
| Telegram 對話清單 | 2.8～13 s | 約 1 ms |
| `/api/chat-sessions`（11 次查詢合計） | 31.6～47 s | 1.3 ms |
| 一次性重建（背景、每 50 筆讓出） | — | 3.7 s；目錄檔 592 KB |

**已知限制／風險**：
1. **Deploy 後第一次開機要背景重建一次（約 4 秒）**，這段時間清單走非同步保底（比較慢但不卡別的請求）。
2. 目錄只認「經 server 的寫入」。排程裡的模型或人手直接改／刪 `chat_*.json` 不會即時反映，要等下次開機核對或 `POST /api/index/rebuild {kind:'chat'}`（§5.3 已知取捨）。
3. `msgCount`／`lastText` 目前只有 Telegram 路徑預留使用，三支清單回應沒用到；放在目錄裡是依 §9.3 欄位表，成本很小。
4. 改前遇到沒有 `messages` 欄位的怪檔，`getChatHistories` 會整筆丟掉；改後該筆仍會列出（標題「無主題對話」）。真實樣本中沒有這種檔。
5. `telegram.js` 因 `_listChatSessionsFn` 變 async 而動了 7 行（加 `await`），屬 IDX-TG 範圍的前置，未改其他行為。
6. 沒有做 HTTP 層的路由鏡射（三段路由都是「取目錄→過濾→回 JSON」的薄包裝，邏輯已由上面新舊逐筆比對覆蓋）；Deploy 後的冒煙測試會實際打到這三支。
7. 看到但沒改（別的功能也慢）：`GET /api/chat/history/:id` 單筆本來就只讀一個檔；`buildTgSessionContextBlock`、`_tgRecapSession` 每次同步讀單一對話檔（單檔，不慢）；`daily-activity.js` 掃 chat_history 的 .md（另一功能）。

### 9.4 精華候選（knowledge-distill candidates）— IDX-CAND
- **現況**：`runs/<排程id>/<執行id>/candidate.json`。`GET /api/schedules/candidates`、`/api/knowledge-distill/status`（前端輪詢）、`checkDistillCompleteness`（每次讀提案）都呼叫 `collectCandidates`：每筆排程讀最多 500 筆執行記錄、再讀候選檔（客戶專案 9.0 s）。
- **改法**：用 IDX-RUN 目錄裡的 `hasCandidate`／`candidateReviewed`（含 noteworthy）先篩，只讀「待審」的那幾個 candidate.json；`saveMemoryCandidate`（建立、標記已審）同步更新執行記錄目錄。依賴 IDX-RUN。
- **驗收**：客戶專案複本上候選清單 < 300 ms、筆數與改前相同；標記已審後即時減少。

#### 9.4.1 實作備註（IDX-CAND，2026-11-06，待 Deploy）
**改了哪些檔**：`portal/scheduler.js`（只動目錄欄位與候選收集）、新增 `portal/checks/cand-index.test.js`。`portal/server.js` 沒改（五處呼叫 `collectCandidates` 的回傳格式不變）。
- 執行記錄目錄新增 `candidateNoteworthy`（`_runEntry` 預設 false、`_trackRun` 沿用舊值或由 `saveMemoryCandidate` 帶入、重建時從 `candidate.json` 回填）。舊目錄檔沒有此欄位（undefined）時視為「未知」，仍讀檔確認，所以 Deploy 後不必強制重建。
- `collectCandidates`：暖機完成後走 `_collectCandidatesMem`（掃記憶體裡的目錄，篩 `hasCandidate`＋未審＋非「確定不值得記」，只讀這些 `candidate.json`）；暖機前或出錯走 `_collectCandidatesScan`（原本的逐檔讀取，保底）。回傳格式不變。
- `saveMemoryCandidate` 寫完同步目錄（`candidateReviewed`＋`candidateNoteworthy`）。
**自測**：`node portal/checks/cand-index.test.js [--real]`，13/13 通過（合成 6 項：暖機前走舊路徑、各工作區／null／大小寫斜線寫法新舊相同、標記已審即時減少、不值得記的不讀檔、舊目錄檔相容、重建回填；真實樣本複本 7 組工作區新舊逐筆相同）。未起 server。
**量測**（客戶專案資料複本，本機）：

| 範圍 | 筆數 | 改前 | 改後 |
|---|---|---|---|
| 全部工作區（null） | 75 | 25,871 ms | 273 ms |
| 客戶專案（正斜線寫法） | 57 | 11,483 ms | 125 ms |
| 客戶專案（反斜線寫法） | 57 | 8,251 ms | 150 ms |
| g8d_harness | 18 | 1,798 ms | 51 ms |
| 無候選的工作區 | 0 | 171～1,548 ms | 0 ms |

**已知限制／風險**：
1. **行為差異（需指揮官確認）**：已歸檔排程的待審候選不再列出（依 D5，歸檔排程的執行記錄不在記憶體目錄）。樣本裡舊結果比新結果多 274 筆（全部工作區）、客戶專案多 61 筆，都屬已歸檔排程。若要保留，需把歸檔排程的候選另外讀 `runs.archive.json`。
2. 暖機（背景，樣本 30 秒）完成前仍走舊的慢路徑。
3. 新版以 `hasCandidate` 為篩選條件，與舊版相同；舊版每排程最多看 500 筆，新版無此上限。
4. 看到但沒改：`collectHousekeepingTargets` 仍逐排程逐檔讀。

### 9.5 側欄資料夾樹（/api/status）— IDX-TREE ｜ 第一優先（盤點時新發現）
- **現況**：`GET /api/status` 每次遞迴掃描工作台與 manifest 每個側欄區段的整棵資料夾（`getFolderTree`，同步 readdir＋stat），另外每次重掃三層外掛資料夾（`getPlugins`）。客戶專案單獨呼叫 **18.9～19.6 s**、回 318 KB（`.harness/knowledge` 底下就有 8,526 個檔）；g8d 5.1 s。前端進頁與切工作區時呼叫。比 chat／runs／schedules 都慢。
- **改法**：資料夾樹不適合目錄檔（檔案常被人和 Hana 直接改，目錄很容易過時），改用業界標準「**點開才載入下一層**」（VS Code、檔案總管的做法）：`/api/status` 只回每個區段第一層，新增 `GET /api/folder-tree?section=&path=` 回單一層；改用非同步讀檔；外掛清單開機讀一次、外掛新增／刪除時才重讀。前端側欄展開資料夾時才呼叫。（決策 D3）
- **驗收**：客戶專案 `/api/status` < 300 ms；側欄各區段展開、點檔案開啟、新增檔案後重新展開看得到，行為與改前相同。

#### 9.5.1 實作備註（IDX-TREE，2026-11-06，待 Deploy）
- **改了哪些檔**：`portal/server.js`（新增 `getFolderLevel`／`resolveTreeDir`／`searchFolderTree`；`GET /api/status` 改非同步只回第一層；新增 `GET /api/folder-tree`；`getPlugins` 加記憶體快取）、`portal/shell/sidebar.js`（`renderTree` 點開才載入、`sbExpanded` 記住展開、搜尋改問伺服器）、`portal/index.html`（歷程按鈕改走資料夾自己的點擊處理）。舊的 `getFolderTree` 保留未刪（已無人呼叫，之後清理）。
- **API**：`/api/status` 的 `worktable`／`sections[].tree` 只含第一層；資料夾 `{type:'directory',name,path,hasChildren:true}`（無 `children`），檔案欄位不變（`name/path/mtime`）。`GET /api/folder-tree?section=<worktable｜區段 label 或 path>&path=<相對工作區根的路徑>` 回 `{items:[…]}`；`?q=<字>` 改為走遍所有區段找檔名／路徑含該字的檔案（最多 200 筆）。路徑檢查：不得跳出該區段（字串比對＋realpath，擋 `../`、絕對路徑、指到區段外的連結）、不得含隱藏或略過資料夾；未知區段 404、越界 403。工作區沿用 `resolveWorkspace(req)`（X-Workspace）。
- **顯示規則與改前一致**：隱藏檔、`node_modules` 等略過資料夾、只列 `.md/.html/.bpmn`、區段 filter。原本「子樹過濾後為空就不顯示該資料夾」改成「往下看一層」：資料夾內沒有任何符合的檔、也沒有子資料夾才隱藏。差異（已知限制）：只含「子資料夾、但子資料夾內全無符合檔」的資料夾，現在會顯示、點開是空的。
- **前端**：點資料夾才呼叫 `/api/folder-tree`；收合再展開不重打；重新整理側欄（`reloadShell`）時，已展開的資料夾會逐層重新載入並保持展開（新增檔案因此看得到）。點檔案仍是 `loadFile(path)`。「歷程」按鈕改為觸發資料夾按鈕自己的點擊（才會載入內容）。
- **誰還吃完整樹（codegraph／Grep 確認）**：只有 ① 側邊欄搜尋（`handleSearch`／`filterFiles`）→ 改走 `/api/folder-tree?q=`（250 ms 防抖）；② `index.html` 的歷程按鈕與 `initWorktableCard` 只用第一層的 `history` 資料夾本身，不受影響。`/api/status` 的其他消費者（`router.js`、`card-carousel.js`、`views/settings.js`）只讀 `plugins`／`manifest`，不吃樹。對話脈絡與頭像對話（`getChatContext`）不讀資料夾樹。
- **外掛快取**：外掛是靠寫檔新增（`/plugin` 技能），伺服器沒有「新增／刪除外掛」的路由可掛重讀，所以不採「開機讀一次」。改為記憶體快取＋每次用幾個 `stat`（三層外掛資料夾與各 `plugin.json` 的修改時間）比對，變了才重讀；信任狀態仍每次即時套用。另有 `invalidatePluginCache()` 備用。
- **量測（同一份資料，改前／改後）**：假工作區 6000 檔 3 層（暖快取、中位數）：樹建置 **1929 ms → 19 ms**，知識區段 JSON 598 KB → 1.6 KB。真實工作區（唯讀走訪，只讀目錄與檔案屬性、不寫入）：客戶專案 18 個區段 **24.9 s → 約 58 ms**（302 KB → 46 KB）；g8d_harness 6 個區段 7.4 s → 15 ms。注意這是函式層級的耗時，不含整個 `/api/status` 其他欄位；正式 `/api/status` 秒數要 Deploy 後由指揮官實測（驗收線 < 300 ms）。
- **自測**：`portal/checks/folder-tree.test.js`（從 server.js 抽出真函式；與舊整棵樹逐項比對第一層與下一層、hasChildren 標記、8 種越界路徑被擋、連結跳出被擋、搜尋）全過；`_tmp/idx_tree_plug.js`（外掛快取：命中／新增／修改／刪除）通過；隔離埠 3399＋Playwright `portal/_idxtree_mirror_test.js`（用真的 `shell/sidebar.js`：只載第一層、點開才載、收合再開不重打、點檔案、新增檔後重新整理保持展開並看到新檔、搜尋走伺服器）全過。**未起第二顆 server、未碰 :3400。**
- **未驗**：整合進真 `index.html` 的完整頁面（含 `reloadShell`、工作區切換）沒在瀏覽器實測，只測了 `sidebar.js` 與假頁面；多工作區切換時 `sbExpanded` 以「區段路徑｜資料夾路徑」為鍵，不同工作區同路徑會共用展開記憶（影響極小，切換時最多多開幾個資料夾）。
- **順手觀察、未改**：`/api/status` 每次仍同步讀 `getManifest`（含 `existsSync`），本次未量測其耗時、未改，不在本項範圍。**需要佈署。**

### 9.6 Telegram 控制台 — IDX-TG
- **現況**：`/today` 走 `queryRuns`（全量）、`/schedules` `/status` 走整份排程檔、`/chats` 等逐檔讀對話、`/meeting` 逐檔讀會議；控制台紀錄與聊天脈絡是單一檔或記憶體，沒問題。
- **改法**：上述指令改呼叫 IDX-RUN／SCH／CHAT／MTG 提供的目錄查詢函式，不自己讀檔。`/today` 依 Telegram 當下 chat 脈絡的工作區過濾（沿用排程工作區隔離鐵則）。依賴那四項。
- **驗收**：隔離測試（不接真 bot）呼叫各指令處理函式，輸出與改前一致；耗時 < 200 ms。

#### 9.6.1 實作備註（IDX-TG，2026-11-07）
- **改了哪些檔**：只改 `portal/telegram.js`（`_cmdToday`、`_cmdSchedules`、`_cmdStatus`＋新增小工具 `_activeSchedulesAll`）；新增測試 `portal/checks/telegram-idxtg.test.js`。`server.js` 不用動：`/meeting`（`meetingsFn`→meetings 目錄，IDX-MTG）與 `/chats` `/back` `/whichchat` `/recap`（`_tgListChatSessions`→chat 目錄，IDX-CHAT；`messages` 只在被讀時才開檔）先前子項已接好，這次逐一用 codegraph／原文確認，無逐檔讀取殘留。`_cmdMeeting` 用的 `meetingDetailFn` 與 `/recap` 讀單一對話檔屬「點了才讀全文」，保留。
- **改法**：`/today` → `queryRuns({since, workspace: ctx.root})`（執行記錄目錄；工作區比對與 null＝harness home 由排程器負責）；`/schedules` `/status` → `listSchedulesForWorkspace(ctx.root,false)`；沒有脈絡（全部工作區）→ `listActiveSchedulesAllWorkspaces()`，不可用時退回讀主檔並排除已歸檔。
- **量測**（樣本＝正式排程檔＋1064 個執行記錄資料夾複本，放 `_tmp/idxtg/home`，目錄已建好、純函式呼叫、不接 bot）：`/today` 130～185 ms→0.1～0.5 ms；`/schedules` 120～175 ms→1～21 ms（g8d 35 筆 21 ms 為首次、客戶專案 66 筆 1.1 ms）；`/status` 125～175 ms→0.7～5 ms；全部工作區 `/schedules` 120～160 ms→2.5 ms。全部 < 200 ms。
- **輸出比對**：有脈絡時 `/today` 文字與改前逐字相同；`/schedules` `/status` 在 g8d、客戶專案的現役排程筆數（35／66）、啟用數（21／19）與舊版過濾 `!archived` 後的結果一致。
- **與舊版不同之處（刻意）**：① 舊版 `/schedules` `/status` 把已歸檔排程也算進去（g8d 138 筆、全部 1139 筆；現役僅 35／109），現在只列現役，與網頁排程頁預設一致（§9.2 D1／D7）。② 排序改為目錄的排序（與網頁相同），不再是主檔順序。③ `/today` 舊版先取前 50 筆再過濾工作區，新版先過濾工作區再取 50，不會被別區擠掉。④ 無脈絡時 `/today` 仍取全部（沿用 `queryRuns` 預設上限 50）。
- **已知限制**：排程器未暖機完成前 `queryRuns` 退回逐檔掃（與改前同速）；`/today` 沿用 UTC 日期切法（既有行為，未改）。
- **自測**：`node portal/checks/telegram-idxtg.test.js <樣本家目錄> <改前版 telegram.js 放在 portal/ 底下的路徑>`（需自備改前版副本，暫存用完已刪）。未起 server、未接 Telegram。
- 需要佈署；指揮官驗收：Deploy 後在 Telegram 對各工作區打 `/today` `/schedules` `/status` 看筆數對、回應即時。

### 9.7 問題回報（issues）— IDX-ISS
- **現況**：`HARNESS_HOME/.harness/issues/<編號>/issue.json`（目前 4 筆、3.2 MB 含錄影）。`GET /api/issues` 一次請求整份讀全部三次（清單＋待處理數標頭＋摘要），找下一個編號也要 readdir。全平台共用、每筆帶 workspace。量小，但會隨使用線性變慢。
- **改法**：依工作區分目錄（`HARNESS_HOME/.harness/issues/index/<ws>/issues.json`，比照 §3 平台共用資料）；已結案／不處理進歸檔目錄；`createIssue`、`linkSession` 及日後改狀態同步更新；待處理數直接從目錄算；下一個編號另存。
- **驗收**：清單、紅點數字與改前相同；新增一筆即時出現；刪目錄自動重建。

#### 9.7.1 實作備註（IDX-ISS，2026-11-06，待 Deploy）
**改了哪些檔**：`portal/issues.js`（新增 `registerIndex`、`listIndexed`、`updateIssueStatus`；`allocate`、`createIssue`、`linkSession` 改動）、`portal/server.js`（開機登錄 kind `issues`、`GET /api/issues`、`GET /api/issues/summary` 改讀目錄）、新增 `portal/checks/issues-index.test.js`。前端沒改（回應欄位與舊的逐位元組相同）。

**目錄放哪（與 §9.7 原文的一處差異）**：問題單是 D2 的刻意例外——全工作區共用一份，前端清單本來就顯示全部（每筆自帶 workspace 欄位）。若依工作區拆成多份，畫面會少東西，所以目錄只有**一份**，掛在 harness home 名下：`HARNESS_HOME/.harness/issues/index/<雜湊>/issues.json`＋`issues.archive.json`（已結案、不處理進歸檔）。每筆欄位＝舊清單 API map 出來的那 9 個（id、type、title、status、workspace、route、view、version、createdAt）。其他工作區路徑不另開目錄。

**怎麼做**：一次請求只讀一次目錄（主＋歸檔各 stat 一次），清單、`X-Open-Count`、summary 的 open／total 都從同一份算。**歸檔也一併讀入**：前端清單預設就含已結案／不處理（用狀態篩選切換），不能讓畫面少，因此沒有做成「點了才讀歸檔」；歸檔分離已就位，日後前端要預設隱藏已結案時只需加一個參數。下一個編號存 `HARNESS_HOME/.harness/issues/next-id`（缺檔／壞內容時從 readdir 算一次；仍用非遞迴 mkdir 搶號，next-id 只是起點，落後時 EEXIST 往後找、找不到再重算）。`createIssue`、`linkSession` 寫完 issue.json 後同步目錄；新增入口 `updateIssueStatus(home,id,status,by,note)`（目前沒有 UI／路由呼叫，只留入口）。目錄不可用時清單走非同步逐檔保底並加 `X-Index-Fallback: 1`、同時排重建。核對指紋＝數字資料夾名集合（只列檔名）。

**自測**：`node portal/checks/issues-index.test.js --sample _tmp/idx/iss-sample` 13/13 通過（輸出 `.worktable/artifacts/idx/idx-iss-test.txt`）；`list-index.test.js` 17/17 仍過。涵蓋：保底、清單／待處理數／summary 與舊寫法逐位元組相同（含 workspace 為 null 的單）、新增即時出現、改狀態搬進／搬回歸檔、篩選、linkSession、刪目錄／壞檔自動重建、外部多一個資料夾 → 核對補回、next-id（缺檔／落後／壞內容／同時 20 筆編號不重複）、同時 30 次新增＋改狀態不遺失。真實 4 筆資料複本（`.harness/issues` 複製到暫存）新舊清單相同。未起 server；路由本身（`GET /api/issues`）未在隔離埠鏡射，只換成 `await listIndexed()` 並加標頭，邏輯全在已測的 `listIndexed`。

**量測**（這台機器、單機無負載）：真實 4 筆（含錄影，3.2 MB）改前（清單＋待處理數＋summary 共讀 3 次）中位 ~29–35 ms → 改後中位 ~0.4–0.5 ms。合成 500 筆小單（各 ~2 KB）：改前中位 ~5,400 ms（這台機器逐檔同步讀很慢）→ 改後中位 ~0.6 ms；無目錄保底首次 ~1.6 s（非同步、不卡其他請求）。

**已知限制**：① `server.js` 裡 Hana 頭像對話的 `issue` 脈絡（`listIssues` 同步整份讀）沒改——不在本子項範圍，量小時不明顯，之後可改讀目錄。② 直接改 issue.json（不經 `updateIssueStatus`）狀態不會即時反映，要等開機核對（只看資料夾名集合，狀態變更偵測不到）或手動 `POST /api/index/rebuild {kind:'issues'}`；這是 §5.3 已知取捨。③ `countOpen`／`listIssues` 舊函式保留（脈絡、測試比對用）。④ 需 Deploy 才生效。

### 9.8 AI 會議（meetings）— IDX-MTG
- **現況**：`<ws>/.harness/runtime/meetings/<id>/meta.json`（客戶專案 17 場、g8d 2 場）。`GET /api/meetings` 與 Telegram `meetingsFn` 都逐場讀 meta（客戶專案 118 ms）。無歸檔；刪除是硬刪。
- **改法**：每工作區 `meetings.json`；寫入點：開始、匯入、停止、改 meta、當機標記中止、摘要完成、開機核對、刪除。
- **驗收**：清單與改前相同；開始／停止一場會議、刪除後清單即時正確。

#### 9.8.1 實作備註（IDX-MTG，2026-11-06，待 Deploy）
**改了哪些檔**：新增 `portal/meetings-index.js`（欄位、掃描、核對、寫入同步，目錄讀寫全走共用模組 `list-index.js`）、`portal/checks/meetings-index.test.js`；`portal/server.js`（登錄 kind `meetings`、`GET /api/meetings`、`meetingsFn`、10 個寫入點同步）；`portal/telegram.js`（`/meeting` 的 `meetingsFn` 呼叫加 `await`）。前端沒改（回應格式不變，仍是 `{meetings:[…]}`）。

**怎麼做**：目錄 `<ws>/.harness/index/meetings.json`，項目＝`meta.json` 原樣（≤2 KB，所以清單欄位與改前逐位元組相同；缺 `meetingId` 的舊檔以資料夾名補上）。核對指紋＝有 `meta.json` 的資料夾名（只 stat、不開檔；`.git` 等點開頭資料夾略過）。同步點（業務檔先寫、目錄後更新，皆不 await）：開始、匯入（開始／document 完成或失敗／音檔子程序結束／保底標 error）、停止、`PUT /:id/meta`、當機標中止（`markMeetingAbortedIfCrashed`）、摘要完成（`_writeMeetingSummaryMeta`）、校正完成（`_writeMeetingCorrectionMeta`）、開機把錄音中標中止、`DELETE /:id`（remove）。開機背景核對沿用 IDX-0 的 `verifyAllOnBoot`。目錄不可用時 `GET /api/meetings` 走非同步掃資料夾保底並加 `X-Index-Fallback: 1`，同時排重建。

**重要差異（Python 子程序）**：錄製器 `meeting_record.py`、匯入器 `meeting_import.py` 會**自己**改 `meta.json`（recording／importing／transcribing → done／error），伺服器不經手。對策：`listAll` 每次把目錄中 status 仍是進行中的項目（通常 0～2 筆）重讀實際 `meta.json`，有變就以實際檔案為準回傳並順手更新目錄；子程序結束與停止路徑也各補一次同步。`diarize.py` 不寫 meta。

**自測**：`node portal/checks/meetings-index.test.js --sample _tmp/idx/mtg-sample/ws` 12/12 通過（輸出 `.worktable/artifacts/idx/idx-mtg-test.txt`）：保底、開始／改 meta／刪除即時、子程序改 meta、目錄半截壞檔、重建略過壞 meta、30 個同時同步不遺失、兩工作區隔離、核對漏一場自動重建；客戶專案 17 場 meta 複本（只複製 meta，放 `_tmp/idx/mtg-sample/`）新舊清單 JSON 字串逐位元組相同。未起 server、未碰真實資料。

**量測**（客戶專案 17 場複本，單機、無負載）：改前逐檔同步讀 5 次＝134／33／31／32／33 ms（首次含冷快取）；改後讀目錄第一次（無目錄、保底掃）36 ms，之後 20 次中位 0.26 ms、最大 0.65 ms。目錄檔在重建後約 17 筆、數 KB；一次性重建約 70 ms。伺服器端 `GET /api/meetings` 路由本身未在隔離埠鏡射（邏輯全在 `listAll`，路由只是包 JSON）。

**已知限制**：① 場數少（17）所以本來就只有 ~33 ms，主要價值是不再同步卡住伺服器、且與其他清單一致；場數多時才明顯。② 直接改檔（不經 API 也不是子程序）的會議，要等開機核對／手動重建（`POST /api/index/rebuild {kind:'meetings'}`）才反映，屬 §5.3 已知取捨；但「進行中」的項目永遠以實際檔案為準。③ 只改 `meta.json` 以外檔案（逐字稿、摘要 md）不影響清單，不需同步。④ `/api/meeting/:id/correct`、摘要多模型等其他路徑都經 `_writeMeeting*Meta` 寫 meta，已涵蓋；若日後新增直接寫 `meta.json` 的程式，要補 `meetingsIndex.syncDir(meetingDir)`。

### 9.9 文件管理（documents）— IDX-DOC
- **現況**：已有目錄 `<ws>/.documents/index.json`（客戶專案 85 份，清單 27 ms），是本規格的範本。但：① 每次列清單都跑 `backfillDocHistory`（逐份檢查歷史檔、必要時讀 log、複製 doc.md、重寫目錄）；② 回收桶清單會 readdir 找「孤兒資料夾」並整份讀 doc.md、遞迴算每個資料夾大小；③ 寫目錄是直接覆寫、沒有排隊。
- **改法**：目錄讀寫改經共用模組；`backfillDocHistory` 改成開機核對時做一次；回收桶的資料夾大小在移入回收桶時算好存進目錄，孤兒掃描只在「重建目錄」時做。目錄格式維持現狀（`documents[]`＋`trash[]`），不改。
- **驗收**：清單、回收桶內容與改前相同；回收桶 < 100 ms；同時匯入兩份文件不互相覆蓋。

#### 9.9.1 實作備註（IDX-DOC，2026-11-07，待 Deploy）
- **改了哪些檔**：`portal/document-registry.js`（讀加「修改時間＋大小」記憶體快取、回傳複本；寫改「暫存檔→換名」、被鎖重試 50→800 ms、仍失敗就丟出不假裝成功；`softDeleteDocument` 存 `sizeBytes`；`listRecycle` 只讀目錄；新增 `rebuildDocuments`、`registerIndexKind`；`backfillDocHistory` 拆出單筆函式）、`portal/server.js`（`GET /api/documents` 拿掉每次回填；啟動時 `docRegistry.registerIndexKind()` 一行）、新增 `portal/checks/documents-index.test.js`。目錄格式 `{ documents[], trash[] }` 不變，只**多一個選配欄位 `orphans[]`**（重建時掃到的孤兒資料夾：id／來源檔名／建立時間／大小）；舊程式讀到會忽略。清單與回收桶回應欄位與改前完全相同（前端不必改）。
- **跟 §4 模組的關係（與原規劃的差異）**：文件登記簿的函式全是**同步**函式、被 server.js 幾十處同步呼叫，共用模組的寫入排隊與原子寫入是非同步的，接不上。因此：① 排隊靠「同步讀改寫＋Node 單執行緒」天然串成一條（單元測試：50 份同時 upsert 全部保留、重建期間插入的 upsert 不被蓋掉）；② 原子寫入在 document-registry.js 內自己做了一個同步版（暫存檔→`renameSync`＋重試），規則同 §4；③ 但**重建／核對／狀態**確實登錄成 `listIndex` 的 kind `documents`，所以 `POST /api/index/rebuild`、`GET /api/index/status`、開機 `verifyAllOnBoot` 都管得到。
- **開機核對**（背景）：只 `readdir` 比對 UUID 資料夾與登記簿 id 集合；對不上、或有舊回收桶項目沒大小、或有文件缺歷史，才跑 `rebuildDocuments`（孤兒掃描＋補大小＋歷史回填＋核對「登記了但資料夾不見」只回報不刪）。非同步、每 50 筆讓出。
- **量測**（客戶專案 `.documents` 複本 79 份＋1 項回收桶＋3 個孤兒資料夾，852 MB，`_tmp/idx/doc-sample`；本機無其他負載）：清單 舊 26.8 ms（中位數，含每次回填檢查）→ 新 0.64 ms；回收桶 舊 32.7 ms → 新 0.75 ms；一次性重建 396 ms（背景）。逐欄位比對清單與回收桶與舊版相同。注意：這台機器上舊版本來就不慢（約 30 ms），線上實測的慢（見 §1）來自其他請求同時競爭；此處數字是「單獨量」的結果，改善比例有參考價值、絕對值不要照搬。測試輸出 `.worktable/artifacts/idx/idx-doc-test.txt`（15 項全過）。
- **已知限制**：① 孤兒資料夾只在開機核對／手動重建時才會出現在回收桶，不是即時；② `node document-registry.js register-born`（doc-new 技能用的獨立 CLI 程序）跟伺服器是兩個程序，兩邊同一瞬間寫目錄仍可能互相覆蓋（改前也一樣，暫存換名只保證不會寫出半截檔）；③ 目錄檔若被改成壞檔，`readRegistry` 照舊回空清單，之後第一次寫入會把它覆寫成只有新一筆（改前行為，沒動；建議之後另案處理）；④ `GET /api/documents` 與回收桶 API 路由只做了語法檢查與單元測試，沒有掛隔離埠鏡射（改動僅是「拿掉一行回填」，風險低）。
- **其他發現（沒動）**：doc 相關寫入多處同時改 `index.json` 與 `history/log.json` 兩個檔，彼此不是一個交易；本次範圍外。

### 9.10 便條貼（notes）— IDX-NOTE
- **現況**：單一檔 `global-knowledge/notes/notes.json`（全平台共用、23 筆、14 KB），清單 8 ms。寫入者有 API、Telegram `/note`、每 60 秒到期提醒掃描三處，都直接覆寫、沒有排隊。
- **改法**：量小，**不拆**；讀寫改經共用模組（暫存換名＋排隊），三個寫入者共用同一條排隊。完成便條是否另存歸檔檔見決策 D8。
- **驗收**：同時從 API 與 Telegram 各建一張，兩張都在；到期提醒照常。

**實作備註（IDX-NOTE，2026-11-07）**
- 改了：`portal/notes.js`（新增 `updateNotes(home, mutator)`：同檔一條排隊、每次「讀最新→套變更→`list-index.writeAtomic` 暫存換名寫回」；移除 `writeNotes`，杜絕舊的整份覆寫）、`portal/server.js`（POST／PUT／DELETE 與到期提醒掃描改用它；掃描改為「推播成功後只標記那幾張的 remindedAt」，不再拿掃描開始時的舊清單覆寫）、`portal/telegram.js`（`/note` 新增改用它）。新測試 `portal/checks/notes-queue.test.js`。
- 沒拆檔、沒加目錄檔（量小，依 D8 前半）；完成便條歸檔檔（D8 後半）本次未做。
- 測試：20 個新增＋1 標記＋1 刪除同時發，結果 19 張全在、無暫存殘留；mutator 丟錯不寫檔；list-index 既有 17 項測試仍過。
- 量測（23 筆真實樣本複本）：讀取 改前≈改後≈3 ms（讀取路徑未動）；單次寫入 改前≈8 ms（直接覆寫）→ 改後≈25 ms（排隊＋換名，多的是安全代價）。20 筆排隊寫入共約 0.5 秒。
- 已知限制：僅單一伺服器程序內有序；Hana 直接改 notes.json 不走排隊（§5.3）。未 Deploy，需佈署後由指揮官驗收。

### 9.11 專案管理（pm）— IDX-PM
- **現況**：單一檔 `global-knowledge/pm/pm.json`（5 專案、137 任務、9 人員、79 KB，全平台共用），清單 12 ms。十餘個寫入點都是整份讀改寫、沒有排隊。
- **改法**：同 9.10，只改經共用模組寫入；已有 `archived` 與 `includeArchived`，維持。
- **驗收**：連續快速拖動多個任務（甘特圖）後重新整理，每個改動都在。
- **實作備註（IDX-PM，2026-11-07，未 Deploy）**：
  - 改了：`portal/pm.js`（`writePm` 換成 `updatePm(home, mutator)`：同一份 pm.json 一條排隊，每次「讀最新→套用→`listIndex.writeAtomic` 暫存檔換名」；mutator 丟錯不寫檔；檔案存在但無法解析時拒絕寫入，不會被當空資料覆寫）、`portal/server.js`（11 個寫入路由——專案新增／修改／刪除、任務新增／修改／刪除／基準線、人員新增／修改／刪除——全改成在 mutator 內驗證＋修改，驗證失敗丟 `PmHttpError` 回原本的 404／400；清單與其他讀取路由、回應格式都沒動）、新增 `portal/checks/pm-queue.test.js`。
  - 測試：20 個任務同時新增、20 個任務同時更新（不同欄位）全部生效；混合更新＋刪除＋新增資源同時發也都在；無暫存殘留；mutator 丟錯不寫檔；壞檔不被覆寫。用 79 KB 真實樣本複本（`_tmp/pm-sample`，156 任務）與空資料各跑一次皆 PASS；list-index 既有 17 項測試仍過。
  - 量測（樣本複本）：讀取（清單路徑，未動）≈4.5 ms；單次寫入 改前≈13 ms（讀＋直接覆寫）→ 改後≈29 ms（排隊＋暫存換名，多的是安全代價）；20 個同時更新總計≈0.55 秒。
  - 已知限制：只保證單一伺服器程序內有序；沒有另加目錄檔（pm 只有 5 專案，清單本來就 ≈4 ms，不需要）；`PUT` 寫入的 mutator 內縮排未重排（行為不變）。未在真實伺服器上實測，需佈署後由指揮官驗收。

### 9.12 白板（whiteboards）— IDX-WB
- **現況**：已有目錄 `<ws>/.harness/whiteboards/index.json`（客戶專案 11 個），清單 13 ms。目錄直接覆寫。
- **改法**：目錄讀寫改經共用模組；加入開機核對。
- **驗收**：清單相同；刪目錄自動重建後標題、時間正確。

#### 9.12.1 實作備註（IDX-WB，2026-11-07）
- **改了哪些檔**：`portal/whiteboards.js`（移除 `writeIndex`；新增 `listBoards`／`upsertMeta`／`scanBoards`／`registerIndexKind`；`deleteBoard` 改非同步）、`portal/server.js`（白板 5 條路由：列表、建立、儲存、刪除、elements 改走共用模組；啟動時登錄 kind `whiteboards`）、新增 `portal/checks/whiteboards-index.test.js`。
- **位置不變、內容格式改了**：仍是 `<ws>/.harness/whiteboards/index.json`，但共用模組只認 `{schema, kind, items}` 物件，故舊的純陣列檔會被當成「壞檔」→ 第一次清單走保底掃描並背景重建一次（createdAt 沿用舊檔，不丟）。每個工作區升級後只發生一次。**回滾風險**：舊版程式讀不懂新物件格式，白板清單會顯示為空（白板檔本身不受影響）；舊版也不會重建，回滾後要手動還原陣列檔。
- **前端欄位**：清單仍回純陣列 `[{id,title,createdAt,updatedAt}]`，與 `views/whiteboard.js` 使用的欄位一致，前端不用改；缺檔／壞檔時回應加 `X-Index-Fallback: 1`。面板開啟時每 2 秒的輪詢現在吃記憶體快取。
- **重建與核對**：重建＝逐一讀 `wb_*` 資料夾的 board.json 取 title／updatedAt；createdAt 優先沿用舊目錄，其次取 id 內含的時間戳，最後才用檔案建立時間。核對只列 `wb_` 開頭的資料夾名稱，不碰 `_wb1_test_evidence` 這類非白板資料夾。沒有白板資料夾的工作區不建任何東西。
- **量測**（客戶專案白板複本，11 筆／1.2 MB，放 `_tmp/idx/wb-sample/`）：改前 `readIndex` 同步讀 2.0 ms／次；改後 `listBoards` 第一次 0.35 ms、之後 0.19 ms／次；完整重建 42~49 ms。原本就很快（規格寫 13 ms），這一項的價值主要是不再同步卡住伺服器、寫入有排隊與暫存換名、並納入開機核對，而不是速度。
- **自測**：`node portal/checks/whiteboards-index.test.js` 11/11（輸出 `.worktable/artifacts/idx/idx-wb-test.txt`）：新增／改標題（createdAt 保留）／刪除、30 筆同時更新不遺失、暫存檔殘留、壞檔保底＋重建、多出資料夾核對、非白板資料夾略過、空工作區、舊陣列升級後清單相同、刪目錄重建後標題／updatedAt 相同。路由層只做語法檢查（`node --check`），未起 server、未鏡射到隔離埠。
- **已知限制**：① 手取名稱（id 不含時間，如 `wb_alert_dashboard`）的白板，若目錄與舊檔都遺失，createdAt 退為檔案建立時間，清單順序可能不同。② `server.js` 的頭像對話脈絡仍用同步 `readIndex`（相容兩種格式），未改非同步。③ 白板 board.json 本身仍是直接覆寫（未改暫存換名），屬 IDX-WB 範圍外。④ 需佈署才生效。

### 9.13 UI 設計系統（uidesign）— IDX-UID
- **現況**：元件、畫面、範本、操作演示各自已有目錄（`<ws>/.harness/uidesign/**/index.json`），清單 15 ms。但每次讀都跑「種子資料檢查」，目錄直接覆寫。
- **改法**：四份目錄改經共用模組；種子檢查改為第一次讀時做一次；加開機核對。
- **驗收**：四個清單與改前相同；新增／刪除元件、畫面即時正確。

#### 9.13.1 實作備註（IDX-UID，2026-11-07，未 Deploy）
- **改了哪些檔**：`portal/uidesign.js`（四份目錄讀寫改經共用模組；新增 `listComponents／listScreens／listTemplates／listFlows`、`upsertComponent／upsertScreen／upsertTemplate／upsertFlow`、`registerIndexKind`；四個 delete 改非同步；移除整份覆寫的 `writeIndex／writeScreenIndex／writeTemplateIndex／writeFlowIndex`）、`portal/server.js`（`/api/ui/components｜screens｜templates｜flows` 的列表、新增、修改、刪除、複製、套用範本、重套（單張／整批）、退回版本，全改成 upsert／remove；啟動時登錄四個 kind）、新增 `portal/checks/uidesign-index.test.js`。
- **四個 kind**：`ui-components`（uidesign/index.json）、`ui-screens`、`ui-templates`、`ui-flows`（各自資料夾的 index.json）。位置不變，**內容格式改為共用模組的 `{ schema, kind, items }` 物件**；舊版純陣列檔視為「壞檔」→ 第一次清單走保底掃檔（回應加 `X-Index-Fallback: 1`）、背景重建一次，每個工作區只發生一次。**回滾風險**：舊版程式讀不懂新物件格式，回滾後四個清單會顯示為空（元件／畫面等實際檔案不受影響），要手動還原陣列檔。
- **種子檢查只做一次**：`ensureSeed／ensureScreenSeed／ensureFlowSeed／ensureTemplatesSeed` 以「種類＋正規化工作區」記在記憶體，第一次讀才做；之後 0 次 existsSync（單元測試用計數驗證）。種子不再建立空的 index.json（缺檔由共用模組處理）；骨架範本／佔位元件補出來時用 upsert 進目錄。**行為差異**：舊版每次讀範本清單都會把「被刪掉的內建骨架範本」補回來；新版同一個程序內刪了不會立刻回來，重啟伺服器後才補回。
- **清單欄位**：與改前一致（元件 id／name／category／description／updatedAt；畫面 id／name／device／frame／unit／scale／updatedAt；範本含 thumbnail、tags、deviceGroup、source；演示含 stepCount），前端不用改。小差別：複製畫面、套用範本、退回版本三條路徑以前寫進目錄的畫面欄位較少（沒有 unit／scale），現在所有畫面寫入共用同一個欄位函式，一律完整。
- **重建與核對**：重建＝逐檔讀 `<id>.json` 取清單欄位，依建立時間排序（與新增時推到最後的順序一致）；核對只列檔名（排除 index.json、revisions／exports 子資料夾）。同步版 `readIndex／readScreenIndex／readTemplateIndex／readFlowIndex` 保留給頭像對話脈絡與「刪畫面前引用檢查」：直接讀目錄檔、相容新舊格式、不做種子、不寫檔。
- **自測**：`node portal/checks/uidesign-index.test.js _tmp/idx-uid/ws1` 9/9（輸出 `.worktable/artifacts/idx/idx-uid-test.txt`）：全新工作區種子只做一次、舊陣列升級、四種新增／更新／刪除、同時 30 筆不遺失、半截壞檔保底後恢復、同步讀不寫檔、工作區隔離、客戶專案複本四個清單新舊相同、刪四份目錄檔重建後相同。另把 server.js 路由原文抽出掛在隔離埠 3399 跑 HTTP 檢查（元件／畫面／範本／演示的新增、修改、刪除、複製、套用、重套、整批重套、退回版本，全 PASS，輸出 `idx-uid-route-mirror.txt`）；**未起完整 server**。
- **量測**（客戶專案 `.harness/uidesign` 複本 778 KB：51 元件／6 畫面／5 範本／1 演示，`_tmp/idx-uid/`）：改前每次讀 元件 3.8～4.5 ms、畫面 2.9～3.4 ms、**範本 14～15 ms**（每次都跑種子檢查）、演示 2.7～3.1 ms；改後（目錄＋記憶體快取）元件 0.33～0.39、畫面 0.25～0.30、範本 0.25～0.32、演示 0.21～0.25 ms；第一次讀 4～11 ms（偶有 60 ms 的檔案系統抖動）。原本就不慢（規格寫 15 ms），價值主要是範本不再每次檢查種子、寫入有排隊與暫存換名、納入開機核對。完整重建 30～310 ms。
- **發現**：客戶專案舊目錄與實際檔案其實對不上——2 個元件有檔案但沒登錄在目錄（被 Hana 直接寫檔），1 個畫面與 1 個演示的 updatedAt 比實際檔案舊。新版重建後以檔案為準（所以「多出 2 個元件」是補回、不是新增）。
- **已知限制**：① 同步版 `readFlowIndex`（引用檢查用）讀檔案，若剛 upsert 還沒落盤會短暫看到舊值，影響僅限「刪畫面前提示」。② 元件／畫面／範本／演示的 `<id>.json` 本身仍是直接覆寫（沒改暫存換名），屬範圍外。③ 外部（Hana、人手）直接改檔不會即時反映，靠開機核對或 `POST /api/index/rebuild`（§5.3）。④ 需佈署才生效。

### 9.14 音訊主題（audio-topics）— IDX-AUD
- **現況**：全域 `global-knowledge/audio-topics.json`＋工作區 `<ws>/.harness/runtime/audio-topics.json` 兩個小檔合併，16 ms。
- **改法**：只改經共用模組寫入（暫存換名＋排隊），不加目錄。
- **驗收**：新增、改預設、刪除後清單正確。

#### 9.14.1 實作備註（IDX-AUD，2026-11-07）
- **改了哪些檔**：`portal/audio-topics.js`（`writeGlobal`／`writeWorkspace` 改走同一份檔一條排隊＋`listIndex.writeAtomic` 暫存換名）；新增 `portal/checks/audio-topics-write.test.js`。`server.js` 與前端**完全沒動**，函式簽名與檔案格式不變。
- **為什麼多了「待寫內容」**：伺服器路由是「同步讀→改→寫」，寫檔變非同步後，下一個請求可能在換名前讀到舊檔而覆蓋掉前一筆。所以 `writeX` 當下先把最新內容放記憶體，`readX` 先看它，寫完才清；排到時合併成寫最新版。沒加目錄、檔案仍是真相。
- **自測**：`AUD_TMP=<暫存> node portal/checks/audio-topics-write.test.js` 7/7 通過（新增全域／工作區主題、改預設、清預設、寫入未落檔前讀到最新、連續 20 筆不遺失、無殘留暫存檔、不多出 .gitignore）。未起 server、未碰真實資料。
- **量測**（暫存目錄、50 筆各 200 字主題連續新增，三輪）：呼叫端被擋住的時間 改前 820～960 ms → 改後 61～64 ms（寫檔移到背景）；清單讀取穩定狀態仍是讀兩個小檔（本機約 7 ms，與改前相同，寫入後短暫由記憶體回答所以更快）。這次沒有加快清單，目標是安全。
- **已知限制**：寫入連續失敗（換名被鎖 6 次）只記警告、檔案維持舊內容；不加目錄故無核對機制。外部直接改檔而伺服器內有未寫完內容時，以伺服器內為準（僅毫秒級視窗）。需要佈署。

### 9.15 不列子項的功能（理由）
- **用量統計**：每月一個只追加的紀錄檔，已有「檔案沒變就用快取」的機制，54 ms。加目錄反而多一份要維護，**不改**。
- **技能清單／回覆風格／流程圖風格／逐字稿範本／簡報清單**：少量設定檔，30～400 ms；本次不做（日後可比照 IDX-TREE「開機讀一次、有變才重讀」）。
- **側欄卡片、模型額度**：已是記憶體快取。
- **瀏覽器操作、Gmail**：沒有清單功能。

### 9.16 對話轉背景修正 — IDX-CBG（與目錄檔無關，同批排入）
- **根因**：對話裡的模型遇到長工時，有時改用 CLI 內建的「背景子代理」或「背景執行指令」，而不是平台的 `POST /api/chat/delegate`。對話用的 CLI 是一次性模式（`--print`），回覆一結束整個程序就結束，內建背景工作跟著消失；平台不知道它存在，所以沒有紅色數字、結果也不會回寫對話。
- **改法 1（必做）**：`buildChatPrompt` 的「對話裡轉背景的三條路」開頭加硬規則：「長工一律走 `POST /api/chat/delegate`；不得用 CLI 內建 Agent 工具的背景模式、Bash 的背景執行、或任何『回覆結束後還要繼續跑』的方式代替——那些在本次回覆結束時就會被終止、平台看不到。前景、會在本次回覆內完成的子代理可以用。」
- **改法 2（評估，預設不做）**：在對話用的 CLI 啟動參數加 `--disallowedTools`。取捨：
  - CLI 只能整支工具封鎖，不能只封「背景模式」。封 `Agent` ＝ 對話裡連前景的查資料子代理都不能用（變慢、吃更多主對話額度）；`Bash` 不可能封。所以封了也只擋一半。
  - `chatViaClaude` 同時被對話（`cmqStartJob`）、排程任務（`fireScheduledJob`）、知識彙整（`fireDistillJob`）三處共用；若要加，必須只在對話那條路加（以 ctx 旗標區分），排程任務不能受影響。
  - 建議：先做改法 1，觀察一週；仍發生再做改法 2，並只封 `Agent`。（決策 D6）
- **驗收**：Deploy 後在對話裡請 Hana「把某件長工轉背景」，紅色數字出現、完成後結果回寫對話。
- **實作備註（IDX-CBG，2026-11-06）**：只做改法 1。`portal/server.js` 的 `buildChatPrompt`，在「對話裡轉背景的三條路」標題後、①之前加入【硬規則】一句（只在帶 `chatSessionId` 時出現）。D6 未拍板，依預設 A **未加** `--disallowedTools`，`chatViaClaude` 未動。檢查 `global-knowledge/commands/` 與 `portal/commands/`：沒有任何技能教模型用其他方式轉背景，故未改技能檔。自測 `portal/checks/chat-bg-prompt.test.js`（從 server.js 抽出真函式、周邊函式用空殼）：帶 sessionId 有硬規則且位置在①之前，不帶則不出現；`node --check` 語法通過。本項為純提示字串，無清單耗時可量測（不適用）。已知限制：只是提示，模型仍可能不聽；需 Deploy 後觀察一週，再決定是否做改法 2。**需要佈署。**

## 10. 上線順序建議

1. **IDX-CBG**（只改提示，小、獨立，可最先做）
2. **IDX-0 共用模組**（其他目錄項目都依賴它）
3. **IDX-TREE 側欄資料夾樹**（最慢的一支；不依賴 IDX-0，可與 IDX-0 互換）
4. **IDX-RUN 執行記錄** → 5. **IDX-SCH 排程清單** → 6. **IDX-CHAT 對話清單**
7. **IDX-CAND 精華候選**（依賴 IDX-RUN）
8. **IDX-MTG**、**IDX-ISS**、**IDX-DOC** → 9. **IDX-TG**（依賴 RUN／SCH／CHAT／MTG）
10. **IDX-NOTE**、**IDX-PM**、**IDX-WB**、**IDX-UID**、**IDX-AUD**（本來就快，主要補「暫存換名＋排隊」的安全性）
11. **IDX-SPLIT 排程拆檔**（選配，最後、由指揮官挑時間）

- 幾乎每個子項都改 `portal/server.js`，**一次只跑一個**，跑完、指揮官 Deploy 驗證後再跑下一個，避免同檔互相覆蓋。
- 建議 1～6 做完先 Deploy 一次驗收（解決絕大部分卡頓），其餘再分批。

## 11. 不做的事

- 不改資料本身的格式（除 §8 選配階段）。目錄只是加在旁邊的快取。
- 不改前端畫面樣式；前端只在需要時加「顯示已歸檔」「重建目錄」按鈕、或改呼叫單筆 API 取全文。
- 不引入資料庫（SQLite 等）——見 §12 決策 D4。

## 12. 開放決策

| # | 議題 | 選項 | Hana 建議 |
|---|---|---|---|
| D1 | 排程／執行記錄／問題回報這類「平台共用資料」的目錄放哪 | A. 放 harness home，依工作區分資料夾 ｜ B. 放各工作區自己的 `.harness/index/` | **A**：實際檔案就在 harness home，重建、備份同一處；工作區被搬走也不留孤兒 |
| D2 | `GET /api/runs` 改成只回當前工作區 | A. 只回當前（加 `?scope=all` 給跨區用途） ｜ B. 維持全部 | **A**：符合工作區隔離鐵則。代價：對話紅色數字只顯示目前工作區的背景任務（現在是全部混在一起） |
| D3 | 側欄資料夾樹改「點開才載入下一層」 | A. 納入本批（IDX-TREE） ｜ B. 另立 | **A**：目前最慢的一支（19 秒），不改的話其他項做完頁面仍會卡 |
| D4 | 是否改用資料庫（如 SQLite） | A. 維持 JSON 目錄檔 ｜ B. 換資料庫 | **A**：已拍板用 index.json；可手讀、可重建、不多一個依賴 |
| D5 | 已歸檔排程的執行記錄 | A. 一起進執行記錄的歸檔目錄 ｜ B. 留在主目錄 | **A**：1,030 筆歷史排程的紀錄不該拖慢日常清單 |
| D6 | 對話轉背景是否同時封鎖 CLI 內建背景工具 | A. 先只改提示、觀察一週 ｜ B. 一起封 `Agent` | **A**：封 `Agent` 會連前景子代理也不能用，且封不了 Bash 背景執行 |
| D7 | 9 種寫法的工作區欄位（含 3 筆斜線被吃掉、1 筆名稱錯字） | A. 重建時只正規化比對，錯字列報告請指揮官確認 ｜ B. 自動改回客戶專案 | **A**：不自動改資料；IDX-SCH 報告列出，指揮官確認再修 |
| D8 | 已完成的便條是否另存歸檔檔 | A. 暫不分（23 筆） ｜ B. 依通則分 | **A**：量太小；超過數百筆再分 |
| D9 | IDX-SPLIT 排程拆檔要不要做 | A. 前面驗收後再決定 ｜ B. 不做 | **A**：目錄檔已解決「清單慢」；拆檔只解決「每次寫入整份重寫」，風險高，視需要 |

## 13. Changelog

- v0.1（2026-11-06）立案。Charles 拍板通則（§2）；Hana 實測盤點（§1、§9）、設計共用模組與分階段；實作排成手動 schedule（§IDX），皆不自動部署。
- v0.2（2026-11-06）IDX-CBG 實作：對話轉背景提示加硬規則（待 Deploy）。
- v0.3（2026-11-06）IDX-0 實作：共用模組 `portal/list-index.js`＋`POST /api/index/rebuild`／`GET /api/index/status`＋開機背景核對；函式簽名見 §4.1（待 Deploy）。
- v0.4（2026-11-06）IDX-RUN 實作：執行記錄目錄（`runs.json`／`runs.archive.json`）、`getRunningRun`／`hasAnyRunningRun` 改看記憶體、`/api/runs` 預設只回當前工作區（D2，`?scope=all` 跨區）；量測見 §9.1.1（待 Deploy；D2／D5 依 Hana 建議值實作，待指揮官拍板）。
- v0.5（2026-11-06）IDX-SCH 實作：排程清單目錄（`schedules.json`／`schedules.archive.json`，一工作區一份）、`saveSchedules` 差異同步、`GET /api/schedules` 預設只回現役＋`?archived=1`＋`X-Archived-Count`、deploy-targets 改讀目錄、前端歷史展開才載；量測與 D7 清單見 §9.2.1（待 Deploy）。
- v0.6（2026-11-06）IDX-CHAT 實作：對話清單目錄（`<ws>/.harness/index/chat.json`）、7 個寫入／刪除點同步、三支清單改讀目錄、對話檔改先寫暫存再換名、壞檔重建略過並記在 status；新增 `portal/chat-index.js`，`telegram.js` 加 `await`（待 Deploy）。
- v0.7（2026-11-06）IDX-TREE 實作：`/api/status` 只回第一層、新增 `GET /api/folder-tree`（路徑檢查＋搜尋）、外掛清單記憶體快取（待 Deploy）。
- v0.8（2026-11-06）IDX-CAND 實作：目錄加 `candidateNoteworthy`、`collectCandidates` 暖機後走目錄只讀待審候選、`saveMemoryCandidate` 同步；客戶專案複本 11.5 s→0.13 s；已歸檔排程候選不再列出（待確認）；見 §9.4.1（待 Deploy）。
- v0.9（2026-11-06）IDX-MTG 實作：會議清單目錄（`<ws>/.harness/index/meetings.json`）、`GET /api/meetings`／Telegram `meetingsFn` 改讀目錄、10 個寫入點同步、進行中項目以實際檔案為準（Python 子程序自改 meta）；新增 `portal/meetings-index.js`，`telegram.js` 加 `await`；量測見 §9.8.1（待 Deploy）。
- v0.10（2026-11-06）IDX-ISS 實作：問題回報清單目錄（harness home 一份 `issues.json`＋`issues.archive.json`）、`/api/issues` 與 `/summary` 一次只讀一次目錄、`next-id` 檔、`updateIssueStatus` 入口；單元測試 13/13（待 Deploy）。
- v0.11（2026-11-07）IDX-DOC 實作：文件登記簿讀加快取、寫改暫存換名；清單不再每次回填歷史（改開機核對／重建）；回收桶大小移入時存好、孤兒改重建時掃並存 `orphans[]`；登錄 kind `documents`；單元測試 15/15；見 §9.9.1（待 Deploy）。
- v0.12（2026-11-07）IDX-TG 實作：Telegram `/today` `/schedules` `/status` 改讀執行記錄／排程清單目錄；已歸檔排程不再列入；見 §9.6.1（待 Deploy）。
- 2026-11-07：IDX-NOTE 完成（便條寫入改排隊＋暫存換名，未 Deploy）。
- v0.13（2026-11-07）IDX-PM 實作：專案管理 11 個寫入路由改走 `pm.updatePm` 單一排隊＋暫存換名，壞檔拒寫；見 §9.11（待 Deploy）。
- v0.14（2026-11-07）IDX-WB 實作：白板目錄 `index.json` 改經共用模組（物件格式、舊陣列自動升級）、5 條白板路由同步目錄、登錄 kind `whiteboards` 開機核對；單元測試 11/11；見 §9.12.1（待 Deploy）。
- v0.15（2026-11-07）IDX-UID 實作：UI 設計系統四份目錄（元件／畫面／範本／演示）改經共用模組（物件格式、舊陣列自動升級）、種子檢查每工作區只做一次、登錄四個 kind 開機核對；單元測試 9/9＋隔離埠路由鏡射全過；見 §9.13.1（待 Deploy）。
- v0.16（2026-11-07）IDX-AUD 實作：音訊主題兩份檔的寫入改走排隊＋暫存換名（讀取先看待寫內容，不丟更新）；單元測試 7/7；見 §9.14.1（待 Deploy）。

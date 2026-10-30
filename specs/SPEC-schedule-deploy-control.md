# SPEC-schedule-deploy-control — 排程的「佈署」一級控制

> 狀態：草案（決策已由指揮官 2026-08-03 拍板，見 §2；§4.8 部署成功後接續 2026-10-23 追加）
> 相關：`portal/scheduler.js`（schedule 資料結構 / run 生命週期）、`portal/server.js`（`fireScheduledJob` 的 onDone、SCHED-CHAIN）、`portal/views/schedule.js`（清單與編輯表單）、`Deploy_Harness.ps1`
> 任務：`.worktable/TASK.md` §Z

---

## 1. 問題

「這一輪跑完要不要重新佈署」目前**不是排程的欄位，而是 prompt 裡的一句話**。`portal/scheduler.js:139` 的 `createSchedule()` 只有 `trigger`／`task`／`model`／`workspace`／`guardrails`／`delivery`／`chainNext`，沒有任何跟佈署有關的欄位；`global-knowledge/schedules/schedules.json` 裡那些 `Deploy_Harness.ps1` 字串全都在 `task.prompt` 內文。

由此產生三個問題：

| # | 現象 |
|---|---|
| 1 | **看不到** — 排程清單無從得知哪一筆跑完會重新佈署，只能逐筆打開讀那幾千字 prompt |
| 2 | **不好控制** — 想讓某一輪「只改檔、先不佈署」，得去編輯那一大段內文，容易改漏、改完又要記得改回來 |
| 3 | **不保證** — 它是「給模型的建議」不是「系統行為」：模型可能忘記做，也可能在不該做時做了；佈署的成敗（冒煙失敗→回滾）也只混在模型輸出裡，沒有獨立記錄 |

另外，`chainNext`（成功後自動接續，`server.js:7902`）與佈署天然衝突：鏈中途佈署會**停掉並換掉正在承載這條鏈的 server**，而且就算重啟成功，下一棒改完檔又要再佈署一次——不符合實際使用情境。

## 2. 已拍板的決策

| # | 決策 | 選定 |
|---|---|---|
| D1 | 佈署設定要能在**清單**一眼看見 | **是**——清單新增「佈署」欄。目的正是「連續任務一次跑完、但不一定馬上佈署」時，一眼看得出整條鏈的佈署狀況 |
| D2 | 與 chain 的關係 | **只有「沒有下一棒」（`chainNext` 為空）的排程才可以設定佈署**。鏈中途一律不可佈署——不是預設 false 而已，是**不允許設定** |
| D3 | 模式數量 | 不做 `always/never/chain-end` 三態。有了 D2 的限制，**一個布林值就夠**：鏈尾自己決定要不要佈署 |
| D4 | 佈署由誰執行 | **由排程系統（server）執行，不是叫模型自己跑**。prompt 內的自行佈署指示一律改成「不要自行 Deploy」 |

## 3. 資料模型

`schedule` 增加一個欄位（只增不改，舊資料不動也能跑）：

```jsonc
{
  "chainNext": null,
  "postRun": { "deploy": true },      // 【新】本排程 run 成功後由系統執行 Deploy_Harness.ps1
  "lastDeployStatus": null,           // 【新】'success' | 'failed' | 'unknown' | null（供清單顯示 ⚠）
  "lastDeployAt": null                // 【新】ISO 字串
}
```

規則：

- **缺欄位 = 不佈署**。所有讀取端一律用 `(s.postRun && s.postRun.deploy) === true` 判定，**不回填歷史排程**（241 筆既有排程行為完全不變）。
- 包成 `postRun` 物件而非扁平的 `deployAfterRun`，是留給日後其他「跑完要做的事」（例如 restart-only、跑測試）用同一個殼，不必再加一層欄位。
- **不變式（D2）**：`chainNext` 非空 ⇒ `postRun.deploy` 必為 `false`。此不變式在**三個地方**各擋一次：建立／更新 API、UI 表單、以及真正要佈署前的執行期複檢（防資料被外部手改破壞）。

`run` 記錄增加：

```jsonc
{
  "deploy": {
    "status":     "running|success|failed|unknown",
    "startedAt":  "…", "finishedAt": "…",
    "exitCode":   0,
    "logPath":    "runs/<scheduleId>/<runId>/deploy.log"
  }
}
```

## 4. 後端

### 4.1 API 驗證（`POST /api/schedules`、`PUT /api/schedules/:id`）

- 接受 `postRun`；只認 `deploy` 一個鍵、值須為 boolean，其餘鍵丟棄。
- **衝突一律回 400，不靜默夾成 false**（訊息：「已設定接續排程時不可開啟佈署；佈署只能設在鏈的最後一棒」）。判定時取「這次寫入後的最終狀態」——亦即 patch 沒帶 `chainNext` 時要拿現存值來比對，不能只看 patch 本身。
  - 反向也擋：對一筆 `postRun.deploy === true` 的排程設定 `chainNext` → 同樣 400。
- `createSchedule()` 預設 `postRun: { deploy: false }`、`lastDeployStatus: null`、`lastDeployAt: null`。

### 4.2 觸發點（`server.js` 的 `fireScheduledJob` → onDone）

插在既有 SCHED-CHAIN 那段（`server.js:7898-7905`）**之後**，條件互斥：

```
if (status === 'success' && chainNext) → 接下一棒（既有行為，不佈署）
else if (status === 'success' && postRun.deploy === true && !chainNext) → 佈署
```

只有真正的 `success` 會佈署；`failed` / `blocked` / `limited-waiting` 一律不佈署（與 chain 同一原則——壞掉的產出不該被推上線）。

**順序不可調換**：`updateRun` → `recordRunOutcome` → `flushRunDelivery` 全部做完（run 記錄與通知都已落檔）**才**啟動佈署。因為佈署會殺掉這支 server，晚一步就永遠寫不出去。

### 4.3 怎麼執行（關鍵：它會殺掉自己）

`Deploy_Harness.ps1` 第 5 步會停掉 :3400 並改起新版——也就是**發動佈署的 server 會被自己觸發的腳本殺掉**。因此：

- 用 `spawn` 起一支**完全 detached 的 `pwsh`**（`detached: true`、`stdio: 'ignore'`、`.unref()`），父行程死亡不影響它。**必須用 `pwsh`（PowerShell 7）不可用 `powershell`**（腳本含中文，5.1 的 CP950 會亂碼）。
- 輸出導進 `runs/<scheduleId>/<runId>/deploy.log`，並在結尾追加一行 `HARNESS_DEPLOY_EXIT=<code>` 作為判定依據：
  ```
  pwsh -NoProfile -Command "& '<HOME>\Deploy_Harness.ps1' *>&1 | Tee-Object -FilePath '<log>'; ('HARNESS_DEPLOY_EXIT=' + $LASTEXITCODE) | Out-File -Append -Encoding utf8 '<log>'"
  ```
- 同時寫一份 marker：`global-knowledge/schedules/pending-deploy.json` = `{scheduleId, runId, startedAt, logPath}`。run 記錄先標 `deploy.status = 'running'`。

### 4.4 回收結果（新 server 開機時）

server 啟動、scheduler 初始化階段（與既有 `flushRunDelivery` 開機重送同一區）：

1. 讀 `pending-deploy.json`，不存在就跳過。
2. 讀 `deploy.log` 尾端的 `HARNESS_DEPLOY_EXIT=` → `0` 判 `success`、非 0 判 `failed`、找不到該行判 `unknown`。
3. 回寫該 run 的 `deploy` 欄位、回寫 schedule 的 `lastDeployStatus` / `lastDeployAt`。
4. 依該排程的 `delivery` 送一則通知（成功：「§X 佈署完成，已上線 vN」／失敗：「§X 佈署失敗，已回滾，log 見 …」）。
5. 刪掉 marker。
6. marker 的 `startedAt` 超過 **20 分鐘**仍在處理 → 判 `unknown` 並照樣收尾（避免卡死）。

**誠實標註的限制**：若佈署失敗並回滾，回來的是**舊版 server**——舊版沒有這段回收程式碼，marker 不會被清、通知也不會送，你只會看到 run 停在 `deploy.status: 'running'`。這是自我佈署的本質限制（無法由「將被取代的自己」保證結果被記錄）。緩解：marker 檔留著，**下一次任何一版含本功能的 server 上線時就會被收掉並補送通知**；且 `Deploy_Harness.ps1` 本身在回滾時已有自己的主控台輸出與 `.releases` 記錄可查。不假裝這條路徑是無縫的。

### 4.4a 開機對帳要同步「排程層」的最近狀態（實測 bug，2026-08-03 已修）

`scheduler.reconcileOrphanRuns()`（開機把殘留 `running` 的 run 改記 `interrupted`）原本**只改 run 檔、不動 schedule**。而 `schedule.lastRunStatus` 只由 `recordRunOutcome()`（onComplete 路徑）寫入 —— run 被 server 重啟打斷時那條路徑根本不會走到。結果：run 檔是 `interrupted`，schedule 仍 `lastRunStatus: null`，清單**永遠顯示「尚未執行」**。§Z 自己就是受害者（它在 run 中途自我佈署／重啟，把自己的 run 打斷）。

修法（`reconcileOrphanRuns()` 內）：

1. 對帳時記下每個 scheduleId **最新一筆**被判中斷的 run。
2. 用一次 `loadSchedules()` / `saveSchedules()` 把 `lastRunAt` = 該 run 的 `finishedAt`、`lastRunStatus` = `'interrupted'` 寫回去。
3. **只在該中斷 run 比排程既有的 `lastRunAt` 新時才覆寫**，避免蓋掉更新的正常結果。
4. `interrupted` 不是真實失敗 → **不累加 `consecutiveFailures`**（與 `recordRunOutcome` 對 `blocked` / `limited-waiting` 的處置一致）。

前端配套：`STATUS_LABEL` 補 `interrupted: '⛔ 中斷'`（否則 badge 會直接印出英文 key）。

### 4.6 Z8：佈署權收歸系統（2026-08-05，根治「跑完卻標 interrupted」）

**實測根因**：§Z 的遷移（§6）只改了 4 筆 prompt，但**新建的排程仍持續複製舊寫法**——最後一步寫「`Deploy_Harness.ps1` smoke＋晉升」。模型照做 → 佈署重啟 :3400 → 承載該 run 的 server 在 `finishRun()` 之前就死 → 一筆**其實做完的 run 被開機對帳標成 `interrupted`**。§WB1、§Z、§WB4 都是同一個坑。清點：現存 81 筆未封存排程中 **43 筆**內文含 `Deploy_Harness.ps1`（`_harness` 32、`g8d_harness` 11）。逐筆改資料治不了本（下一筆新排程又會複製回來）。

**修法（`server.js` 的 `fireScheduledJob`）**：新增純函式 `deployPolicyNote(schedule)`，其輸出**無條件附加在每一筆排程 prompt 的最後**（與 H4 價值判定同一段），內容為系統級指令且明示「優先於上方任務內文、若上方要求自行佈署一律忽略之」：

- `postRun.deploy === true` → 「不要自行佈署；你正常結束回報即可，系統會接手佈署」
- 否則 → 「不要自行佈署；若你認為需要上線，在報告中明講，由指揮官決定」

如此**不必改任何一筆既有 prompt**、也對未來新建的排程自動生效（跨工作區皆然）。系統佈署走既有 §4.2 路徑（run 記錄／通知全部落檔後才 spawn），run 會正常收在 `success`。

### 4.7 Z8：中斷原因要說得出口

即便未來仍發生佈署造成的重啟（手動佈署、指揮官在對話中佈署），`reconcileOrphanRuns()` 也不該只丟一句「伺服器重啟」。新增 `_lastDeployAtMs()` 讀 `.releases/current.json` 的 `updatedAt`（`Deploy_Harness.ps1` 每次晉升都會改寫，**不必另埋 marker**）：該時間落在 run 的執行區間內 ⇒ 這筆是被佈署砍的。

- run 增欄位 `interruptedBy: 'deploy' | 'restart'`
- `error` 改為「中斷：佈署重啟服務（本輪工作可能已完成，請查看回報內容與 TASK.md 勾選狀態）」
- **狀態仍是 `interrupted`**——系統無法證明模型已做完，不升格成 `success`（誠實原則）。

### 4.5 執行期護欄

- **重入保護**：`pending-deploy.json` 已存在 → 不再起第二支佈署，記 log 並把本次 run 的 `deploy.status` 標 `skipped-busy`。
- **避開撞車**：啟動佈署前檢查是否還有**其他 run 正在執行**（既有的 running 判定）。有的話**每 30 秒重試、最多等 10 分鐘**；逾時仍照常佈署，並在 log 與通知中明確記「等待逾時，可能中斷了其他執行中的排程」。理由：佈署會重啟 server，手動連跑多筆獨立排程時很容易重疊。
- **執行期複檢 D2**：真的要 spawn 之前再讀一次該 schedule，若 `chainNext` 非空 → 放棄佈署、記 log（防止資料被外部手改繞過 API 驗證）。

### 4.8 部署成功後接續（SCHED-DEPLOY-NEXT，2026-10-23）

> 起因：客戶專案「結案報告」是一條 P0（平台，要部署）→ P1～P9（客戶專案，只寫內容）的接力鏈。D2 規定佈署只能放在鏈尾，所以 P0 不能用 `chainNext` 接 P1；但 P1 又必須等 P0 的新引擎**上線之後**才能開跑。解法是把「接續」掛在**部署成功**這個時間點，而不是 run 成功的時間點。

**資料**：`postRun.nextAfterDeploy: "<排程 id>"`（選填）。

```jsonc
"postRun": { "deploy": true, "nextAfterDeploy": "sched_…" }
```

**規則**
- 只有 `postRun.deploy === true` 的排程可設；**D2 不變**——`chainNext` 仍必須為空（佈署仍只在鏈尾）。
- 值必須是**存在**的排程 id、**不可是自己**；可**跨工作區**（`triggerNow` 本來就以 id 找全域排程，被接的那支照它自己的 `workspace` 跑）。
- **觸發點**：新版 server 開機時的 `reconcilePendingDeploy()` 判定該次部署 **success**（`HARNESS_DEPLOY_EXIT=0`）之後，**重讀**排程清單，若有 `nextAfterDeploy` 就 `triggerNow(它)`；log 與通知寫明「部署完成，已接續「<名稱>」」，接續結果也記進該 run 的 `deploy.nextAfterDeploy`（`{id,name,ok,error}`）。`triggerNow` 回 `already-running` 等失敗時，通知改寫「⚠ 接續「<名稱>」未開跑（原因）」。
- 部署 **failed／unknown 一律不接續**。回滾回來的舊版本本來就沒有這段程式，也不會接——這是正確結果。
- 被接的排程已**歸檔** → 不接（記 log `target-archived`）；來源排程被刪、目標不存在、指向自己 → 不接（各記原因）。停用（`enabled:false`）的目標**照接**——與 `chainNext` 一致，被接的排程可維持停用。
- 純邏輯抽在 `portal/deploy-next.js`（`decideNextAfterDeploy`／`sanitizeNextAfterDeploy`，無 I/O），單元測試 `portal/checks/deploy-next.test.js`（success 接、failed／unknown 不接、id 不存在不接、指向自己不接，另含歸檔、未設、來源已刪與 API 驗證共 16 項）。

**API 驗證**（`validatePostRunPatch`，§4.1）
- 原本會剝掉 `postRun` 的未知欄位；現在**唯一保留** `nextAfterDeploy`，並驗證上述規則（不合法回 400、檔案不寫入）。
- **PUT 沒帶 `nextAfterDeploy`** → 沿用磁碟上的值（只改 `deploy` 的呼叫端不會默默洗掉接續設定）；把 `deploy` 關掉時一併清除；明確帶 `null`／空字串 → 清除。
- `scheduler.createSchedule()` 建立時保留通過驗證的值。

**UI**（`portal/views/schedule.js` 編輯表單）
- 「執行成功後自動重新佈署」勾選框下方加「**部署成功後接續**（選填，可跨工作區）」下拉；未勾佈署時 disable 並清空。
- 選項來源是專用端點 `GET /api/schedules/deploy-targets`：列**全部工作區**的排程，但**只回 `{id, name, workspace 名稱, enabled, archived}`**——不含任務內文、執行紀錄、通知。這是排程「工作區隔離」鐵則下刻意的窄例外（下拉要能跨工作區選），有內容的讀取面仍一律隔離。選項格式「[工作區名] 排程名稱（停用）」，已歸檔的不列。

**驗收**：本功能只能在「部署後」才真的發生——由 P0（`sched_1792689439889_b9xi`）部署成功後，客戶專案 P1（`sched_1792637373007_hh8l`）是否自動開跑來驗（§PCUE 指揮官驗收）。

## 5. 前端（`portal/views/schedule.js`）

### 5.1 清單新增「佈署」欄（D1）

放在「最近狀態」與「啟用」之間，`row()` 與兩個 `tableWrap` 的表頭同步加一欄：

| 情況 | 顯示 |
|---|---|
| `postRun.deploy === true` | `⬆ 佈署` 綠色 badge |
| 有 `chainNext` | `串接中` 灰字，tooltip「有接續排程，佈署只能設在最後一棒」 |
| 其餘 | `—` 淡灰 |
| 上次佈署 `lastDeployStatus === 'failed'` | badge 後加 `⚠`，tooltip 帶 `lastDeployAt` |

這一欄與既有的 SCHED-CHAIN 走線一起看，就是指揮官要的「一眼看完整條鏈：誰接誰、最後一棒佈不佈署」。

**版面**（加了第 8 欄之後實測會擠出橫向捲軸，2026-08-03 已修）：清單外層容器由 `max-w-4xl` 放寬到 **`max-w-7xl`**（畫面左右本來就有大量留白），並給「觸發／模型／下次執行／最近狀態／佈署」五欄加 `whitespace-nowrap`，避免 `⬆ 佈署` 被折成直排。原則：**這張表寧可吃滿寬度，也不要出現橫向捲軸**。

### 5.2 編輯表單

在「成功後接續」下拉正下方加一個 checkbox：**「執行成功後自動重新佈署（Deploy_Harness.ps1）」**，說明文字「佈署會重啟服務，因此只能設在沒有接續排程的最後一棒」。

連動（D2 的 UI 面）：
- 「成功後接續」選了非空值 → checkbox 立即**取消勾選並 disable**，說明文字改成「已設定接續排程，佈署請設在鏈的最後一棒」。
- 改回「（不接續）」→ checkbox 重新可用（維持未勾選，不自動勾回）。
- `schedSave()` 送出 `postRun: { deploy: <checked> }`；`schedOpenModal()` 回填。

## 6. 既有排程遷移

由 §Z 的排程在實作完成後**一併執行**（見 `.worktable/TASK.md` §Z7），範圍嚴格限縮：

- **只動 `workspace` 解析後等於 `D:\SideProject\g8d_harness` 的排程**（工作區隔離鐵則；`_harness` 等其他工作區的排程一律不碰）。
- **只動尚未成功執行的**（`lastRunStatus !== 'success'` 且 `archived !== true`）。已跑完的歷史排程不回填欄位。
- 對象：`§W`(`sched_1785722282003_ibme`)、`§X`(`sched_1785722282024_2904`)、`§Y`(`sched_1785722282042_pq1c`)、`§M 收尾切換`(`sched_1785559395020_twrm`，狀態 `blocked`)。
- 每筆做兩件事：
  1. 依 D2 設 `postRun.deploy`——`chainNext` 為空者設 `true`（它們原本 prompt 就要求自行 Deploy）；有接續者設 `false`。
  2. **改寫 `task.prompt` 內的自行佈署指示**：把「跑 `pwsh Deploy_Harness.ps1`」那類句子改成「**不要自行執行 Deploy_Harness.ps1；佈署由排程系統在本排程成功後接手**。你只需完成程式修改與 `node --check` 等本地驗證。」原有的冒煙／驗收要求保留。
- 遷移**直接改寫 `schedules.json`**（改前先複製一份 `schedules.json.bak`），不透過 API——避免逐筆 PUT 觸發 `nextRunAt` 重算而讓手動排程意外變成有下次執行時間。

## 7. 不在範圍

- 不做 `chain-end` 自動判定（D2 已用「不允許鏈中途佈署」從結構上消滅這個需求）。
- 不做「佈署失敗自動中斷後續鏈」——鏈尾才能佈署，佈署時鏈已結束，沒有後續可中斷。
- 不做佈署排隊佇列（多筆同時要佈署時只允許一支，其餘標 `skipped-busy`，見 §4.5）。
- 不改 `Deploy_Harness.ps1` 本身的行為（它的冒煙／回滾邏輯原樣沿用）。
- 不做 Telegram 端的佈署開關指令。

## 8. 驗收

1. 建一筆無接續的排程、勾選佈署 → 清單「佈署」欄顯示 `⬆ 佈署`；手動執行成功後，服務確實重新佈署上線（版本號 +1），且該 run 記錄有 `deploy.status: 'success'` 與 `deploy.log`。
2. 同一筆排程改設「成功後接續」→ 佈署 checkbox 自動取消並 disable；直接用 API 送 `{chainNext: X, postRun:{deploy:true}}` → 回 400 且**檔案未被寫入**。
3. 一條三棒的鏈（A→B→C，只有 C 勾佈署）手動觸發 A → A、B 跑完都**不重啟服務**，C 跑完才佈署一次。
4. 讓某排程刻意失敗（`status: failed`）→ **不佈署**，清單佈署欄仍顯示 `⬆ 佈署`（設定不變）但無 `lastDeployAt` 更新。
5. 佈署過程中 server 被替換 → 新 server 上線後，該 run 的 `deploy.status` 由 `running` 變 `success`，且收到一則佈署完成通知；`pending-deploy.json` 已被清除。
6. 未設 `postRun` 的既有排程（241 筆）執行行為與今天完全一致——不佈署、不報錯、清單顯示 `—`。
7. §6 遷移完成後：四筆目標排程的 prompt 內**不再含**要求自行跑 `Deploy_Harness.ps1` 的句子，且其他工作區的排程一個字都沒被改到（比對 `schedules.json.bak`）。
8. 清單在一般視窗寬度下**不出現橫向捲軸**：容器吃滿可用寬度（`w-full px-6 py-8`，非 `max-w-*` 置中）、儲存格 `px-3`、`⬆ 佈署` badge 為 `inline-block whitespace-nowrap`（曾被擠成「⬆／佈／署」直排）。

## 9. 實作教訓（已踩過）

- **自我佈署會打斷自己那一棒的 run**：排程勾了佈署 → 跑完觸發 `Deploy_Harness.ps1` → server 被換掉，該 run 的 `finishRun()` 永遠來不及寫，`schedule.lastRunStatus` 停在 `null`，清單就一直顯示「尚未執行」（§Z 自己第一次跑完就是這樣）。修法在 `scheduler.js` 的開機 reconcile：把孤兒 run 標 `interrupted` 之外，**同步把排程層的 `lastRunAt`／`lastRunStatus` 也補成 `interrupted`**（只在該中斷比既有 `lastRunAt` 新時才覆寫，避免蓋掉更新的正常結果；不累加 `consecutiveFailures`）。
- 因為這段修補只在 **server 啟動時**執行，狀態要等下一次重啟才會補上——不是 UI 沒更新。
- **只遷移既有 prompt 治不了本（2026-08-05）**：§6 改了 4 筆，但「最後一步自己 Deploy」這個寫法會被新排程一再複製回來，於是同一個坑重複踩了至少三次（§Z／§WB1／§WB4）。**凡是「模型該不該做某件會傷到系統本身的事」，就不能靠 prompt 內文自律，要由系統在執行期無條件注入政策**（見 §4.6）。同理適用於未來任何「模型可能殺掉承載自己的行程」的動作（重啟服務、改 port、動 venv）。

---

## Changelog

| Date | Version | Author | Description |
|:-----|:--------|:-------|:------------|
| 2026-10-23 | v1.1 | 指揮官 + Hana(Claude) | 新增 §4.8「部署成功後接續」（`postRun.nextAfterDeploy`）：開機對帳判定部署 success 後重讀排程並 `triggerNow` 接續目標（可跨工作區）；failed／unknown 不接；API 驗證保留並檢查此欄位（存在、非自己、需 deploy=true，PUT 未帶時沿用）；UI 加「部署成功後接續」下拉（專用 `GET /api/schedules/deploy-targets`，只回 id／名稱／工作區名）。**異動原因**：客戶專案結案報告 P0（平台，要部署）→ P1～P9（客戶專案）接力，D2 讓 P0 不能用 chainNext 接 P1，而 P1 必須等新引擎上線後才能跑；指揮官 2026-10-23 拍板通用能力歸平台。**自行取捨**：①停用的目標照接（與 chainNext 一致）、歸檔的不接；②接續失敗（如目標已在跑）只在通知裡講，不重試；③跨工作區下拉走窄端點，不放寬一般清單的工作區隔離。 |

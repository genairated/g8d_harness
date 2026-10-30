# SPEC — 排程狀態語意（Schedule / Run Status Semantics）

> 規格版本 v0.1（2026-07-08 起草，待指揮官拍板）
> 關聯：`specs/SPEC-scheduler.md`（排程系統本體）、`.worktable/TASK.md §Y`
> 觸發事件：Excel 匯入 Phase 2 那筆 run 只跑 58s、依前置護欄「Phase 1 未驗收就停」空手回報，
> 卻在網站排程面板顯示**綠色 ✅ 成功** → 指揮官誤以為「做完且成功」。**綠色成功不該涵蓋「跑完但沒動工」。**

---

## 1. 問題（根因）

`portal/server.js` 的 `onComplete` 目前用**二元判定**決定 run 狀態：

```js
const isFailed = !ctx.result || ctx.result.startsWith('❌');
const status   = isFailed ? 'failed' : 'success';
```

只要 agent 有產出、且開頭不是 ❌ → 一律 `success`（綠 ✅）。

但 agent 可能**乾淨地跑完、卻刻意沒做任何事**——例如撞到自己 prompt 裡的前置護欄
（「相依的上游任務未驗收 → 停下回報、不硬做」）。這種「合法的不動工」產出的是一份**非 ❌ 的說明文字**，
於是被判成 `success`。結果：**面板綠燈、看板像完工，指揮官不知道它其實停在那等你。**

一句話：**目前的狀態機分不出「做完了」與「跑完但沒做」。**

---

## 2. 現有狀態盤點（改動前的事實）

Run 層狀態（`onComplete` / `_fireJob` 寫入 run 記錄）與 UI 呈現：

| status | 中文 label | 顏色（`STATUS_BADGE` / `statusIcon`） | 語意 |
|---|---|---|---|
| `running` | 執行中 | 藍 · 🔄 | 進行中 |
| `success` | 成功 | **綠** · ✅ | 完成、有產出 |
| `failed` | 失敗 | 紅 · ❌ | 崩潰／`❌` 開頭／無產出 |
| `limited-waiting` | 等待續跑 | 黃 · ⏳ | 撞 API 限額，**系統會自醒續跑，不用你動** |
| `interrupted` | 中斷 | 橘 | 伺服器重啟把 run 砍掉（機器問題） |
| `aborted` | 中止 | 🛑 | 你手動按停 |

Schedule 層 `lastRunStatus` = 最後一次 run 的 status，經 `STATUS_BADGE[lastRunStatus]` 上色。

UI 落點（實作要一起改的地方）：
- `portal/index.html` `STATUS_BADGE`（≈ line 7026）— 徽章底色/字色
- `portal/index.html` `statusIcon`（≈ line 6987）— emoji 圖示
- `portal/index.html` schedule 卡片 `lastRunStatus` 徽章（≈ line 7078、7157）
- `portal/server.js` `onComplete`（≈ line 5501）— 狀態判定
- `portal/scheduler.js` `recordRunOutcome`（line 419）— 熔斷計數
- `portal/telegram.js` — 回報摘要文案（若有依 status 分流）

---

## 3. 設計：新增狀態 `blocked`（受阻·待你）

### 3.1 語意
> **agent 跑完、沒崩，但刻意沒完成任務**——因為前置條件／相依任務／核准未滿足，
> 它依約定停下、等一個人類決定或上游完成。**不是成功（沒有交付產出）、也不是失敗（什麼都沒壞）。需要你看一眼並做決定。**

典型場景：
- 前置護欄擋下（本次 Excel Phase 2）
- 等指揮官核准才能繼續的破壞性動作
- 相依的上游排程尚未完成／未驗收

### 3.2 顏色與標籤（本規格要指揮官拍板的重點）
| 屬性 | 值 | 理由 |
|---|---|---|
| status key | `blocked` | |
| 中文 label | **「⚠ 受阻·待你」**（徽章）／動態列「未動工·待處理」 | 一眼看出「要你介入」 |
| 圖示 | ⚠️ | 警告，非成功 |
| **字色** | **琥珀 amber**：`text-amber-600 dark:text-amber-400` | 見下方色彩推理 |
| 底色 | `bg-amber-100 dark:bg-amber-900/30` | |

**為什麼選 amber ⚠ 而不是別的顏色**（回答指揮官「什麼顏色比較合理」）：
- **不能是綠**：綠 = 完成／成功，正是要打掉的誤導。
- **不用紅**：紅 = 出錯／崩潰。這裡什麼都沒壞，用紅會讓人以為系統爆了、也會不必要地觸發「失敗」焦慮。
- **不用黃（limited-waiting 已佔）**：黃在本系統代表「系統會自己續跑、你不用動」——語意相反（那是不用理它，這是**要你動**）。
- **不用橘（interrupted 已佔）**：橘 = 伺服器重啟中斷（機器問題）。blocked 是**流程刻意停下等人**，不是崩潰。
- **選 amber + ⚠**：琥珀是通用「警告／待處理」色，配 ⚠ 圖示與粗體 label，在一排徽章裡最能喊「看我、我在等你」，且與黃/橘語意清楚切開。

### 3.3（開放決策，B 項）可選的第二個狀態 `noop`／`skipped`
有一種「跑完沒做事」是**良性**的：agent 正確判斷本來就沒事可做（例：每日 Gmail 掃到 0 封垃圾、沒有新 issue）。
- 這不該是綠（避免假裝有做事），但也不是 amber 警告（不用你動）。
- 建議：**灰/slate**（`text-slate-500 bg-slate-100 dark:bg-slate-800`）、圖示 「—」或 「∅」、label「無事可做」。
- **是否本期一起做，請指揮官拍板**（見 §7）。先把 `blocked` 做起來就能解決當前痛點；`noop` 是加分項。

---

## 4. 偵測機制：agent 自我標記（`<run-outcome>`）

系統**無法**自行分辨「跑完有做」與「跑完沒做」——兩者都產出非 ❌ 文字。
必須由 **agent 在輸出裡自報**。沿用既有 `<memory-candidate>` 區塊在 `onComplete` 被解析的**同款 pattern**（server.js:5524-5529），零新機制。

### 4.1 標記格式
agent 在「刻意沒動工就停下」時，於報告**最後**附一行機器可讀標記：

```
<run-outcome status="blocked" reason="Phase 1 尚未經指揮官驗收，依前置護欄停止、未動工" />
```

- `status`：`blocked`（或未來的 `noop`）。
- `reason`：一句話，會存進 run 記錄、顯示在面板/回報摘要，讓指揮官不點開就懂為何卡住。

### 4.2 server 端解析（`onComplete`）
在 `onComplete` 內、**算 `isFailed` 之前**（緊接現有 `<memory-candidate>` 剝除段）新增：
1. 用 regex 抓 `<run-outcome status="…" reason="…" />`，抓到就從 `ctx.result` 剝掉（不進存檔 transcript）。
2. 若 `status ∈ {blocked, noop}` → **覆蓋**原本算出的 `success`（`failed` 不覆蓋——真的壞了優先）。
3. 把 `reason` 寫進 `runPatch.error`? 不——另存 `runPatch.outcomeReason`（`error` 語意是錯誤）；delivery summary 用 reason。

### 4.3 熔斷計數（`recordRunOutcome`）
`blocked` / `noop` **不是失敗**：
- 不歸零 `consecutiveFailures`（它沒成功，不該假裝進度）。
- 也**不累加** `consecutiveFailures`（它沒壞，不該推向熔斷）。
- 即把 `blocked`/`noop` 加入現有 `limited-waiting` 那條「不計入熔斷」分支（scheduler.js:427）。

### 4.4 慣例落點（讓 agent 真的會標）
- `/task` skill、以及任何「前置護欄 → 停下回報」的 prompt 慣例：加一句
  「**當你沒做事就停下時，報告結尾務必附 `<run-outcome status="blocked" reason="…" />`**」。
- 本規格與 `SPEC-scheduler.md` 互相連結，作為日後所有排程 prompt 的共同約定。

---

## 5. 回溯修正：把 Excel Phase 2 那筆改成 `blocked`

觸發本規格的那筆 run（schedule `sched_1783434829644_x0bd`「Excel 匯入 · Phase 2」的最近一次 run）目前存成 `success`。實作時一併：
- 找到該 run 記錄，`status` `success → blocked`、補 `outcomeReason`「Phase 1 未經指揮官驗收，依前置護欄停止、未動工」。
- 該 schedule 的 `lastRunStatus` `success → blocked`（用 `recordRunOutcome` 或直接改 `schedules.json`，注意 workspace 欄位不動）。
- 讓面板/動態列該筆立刻顯示 amber ⚠「受阻·待你」，指揮官一看就懂它其實沒做。

---

## 6. 驗收（DoD）

- [ ] 造一筆會「自我護欄停下」的測試 run（或用 mock `ctx.result` 帶 `<run-outcome status="blocked">`）→ run 記錄 `status=blocked`、非 success。
- [ ] 面板/動態列該筆顯示 **amber ⚠「受阻·待你」**，**不是綠色成功**；hover/展開看得到 reason。
- [ ] `<run-outcome>` 標記**不出現在**存檔 transcript / 回報摘要正文。
- [ ] `blocked` **不動** `consecutiveFailures`（不歸零、不累加）——不誤觸熔斷、也不假裝成功。
- [ ] 一般成功 run（無標記、非 ❌）仍照舊綠 ✅；真失敗仍紅 ❌ ——**未回歸**。
- [ ] Excel Phase 2 那筆回溯改成 blocked、面板正確顯示。
- [ ] `Deploy_Harness.ps1` 冒煙通過。

---

## 7. 開放決策（等指揮官拍板）

1. **`blocked` 顏色**：採本規格建議的 **amber ⚠**？（預設 yes）
2. **是否本期一起做 `noop`（灰·無事可做）**？還是只先做 `blocked`、`noop` 之後再說？（預設：先只做 blocked）
3. **中文 label 用詞**：徽章「⚠ 受阻·待你」／動態列「未動工·待處理」——用詞可換（例：受阻／待處理／已停下等你）。
4. **Telegram 回報**：blocked 的推播要不要**特別醒目**（例：標題加 ⚠、或只在 web 顯示不吵手機）？（預設：照 schedule.delivery，摘要文案改成「⚠ 未動工：<reason>」）

---

## 8. 新增狀態 `partial`（✅ 完成·待確認）｜Charles 2026-09-09 拍板

> 規格版本 v0.2。**觸發事件**：指揮官在「客戶專案」工作區連續執行數筆程式開發排程，回報狀態全是
> `blocked`（amber ⚠「受阻·待你」），但實際查證發現**工作已經做完**，只是 agent 有幾個問題想確認。
> 指揮官因此誤以為那幾筆卡住沒動。**根因：狀態格子不夠用，agent 找不到「做完了但有事要問」的格子，只好往 `blocked` 塞。**

### 8.1 問題定義

`blocked` 的原始定義（§3.1）很嚴格：**完全沒動工**、依前置護欄停下等人。
但實務上最常見的結局是第三種：**做完了、有交付，只是有幾個決策點想請指揮官確認**。
現行三格（success／failed／blocked）沒有它的位置：

- 報 `success`（綠）→ 待確認事項被淹沒，指揮官不會回頭看。
- 報 `blocked`（amber ⚠）→ **看板顯示「受阻」，指揮官誤判它沒做事**（本次實際發生）。

這是**分類不足造成的系統性誤報**，不是 agent 亂寫。

### 8.2 業界對照（不自創）

主流 CI 都有「跑完了但要你看一眼」這一格，本規格照抄、不自創語意：

| 系統 | 該格名稱 | 語意 |
|---|---|---|
| Jenkins | `UNSTABLE`（黃球） | 建置成功但測試有問題 → 要人看 |
| GitLab CI | `passed with warnings` | 通過但有警告 |
| GitHub Actions | `neutral` | 完成、非成功也非失敗 |

→ 本系統取名 `partial`，中文「**完成·待確認**」。

### 8.3 語意與呈現（拍板）

> **agent 已完成任務主體、有實際交付（改了檔案／產出了東西），但存在需要指揮官確認或決定的事項。**
> 不是受阻（工作已推進），也不是純成功（有事待你看）。

| 屬性 | 值 |
|---|---|
| status key | `partial` |
| 中文 label | **「✅ 完成·待確認」** |
| 圖示 | ✅（配藍色徽章，與綠色成功區隔） |
| 字色／底色 | `text-blue-700 dark:text-blue-400` ／ `bg-blue-100 dark:bg-blue-900/30` |

**為什麼是藍**：藍在本系統既有語意是「資訊／進行中」，不帶警告意味；amber 保留給「**要你介入才能繼續**」，
綠保留給「完全沒事」。**藍＝已交付、有事供你參考**，與 amber 的「停住等你」清楚切開，一眼可辨。
（`running` 也用藍，但兩者不會同時出現在同一筆 run 的終態，且 label/圖示不同，實務上不混淆。）

### 8.4 判定準則：改成一個二選一硬條件（本節是修正誤報的關鍵）

現行 `/task` 技能對 `blocked` 的描述是**描述性**的（「前置護欄擋下、沒動工就停」），模型會自行詮釋，
於是「做完但有疑問」被詮釋成 `blocked`。改成**可機械判定的問句**：

> **「這次執行，你有沒有實際修改／新增任何檔案？」**
> - **有 → 一律不准報 `blocked`。** 有待確認事項就報 `partial`，沒有就報 `success`。
> - **沒有 →** 是因為前置條件不滿足而刻意停下 → `blocked`；是因為本來就沒事可做 → `success`（或未來的 `noop`）。

標記格式沿用 §4.1，新增 `partial`，並要求 `reason` 同時交代**已完成什麼**與**待確認什麼**：

```
<run-outcome status="partial" reason="已完成 X、Y、Z；待確認：A 的欄位命名要沿用舊表還是改名" />
```

### 8.5 實作落點

- `portal/server.js` `onComplete`（≈ L10459）：`outcomeMark.status === 'partial' && !isFailed` → `status='partial'`、
  `outcomeReason = reason`；`deliverSummary` 分支新增「✅ 完成·待確認：<reason>」。
- `portal/scheduler.js` `recordRunOutcome`（L468）：`partial` **視同成功**歸零 `consecutiveFailures`
  （它確實做完了，不該推向熔斷）——與 `blocked`（不歸零也不累加）不同，這是刻意的差異。
- **串接（chainNext）與自動部署（postRun.deploy）：`partial` 一律不觸發。**（server.js L10500 的條件維持 `status === 'success'`。）
  理由：既然有事待確認，就不該讓下一階段或部署自動跑下去。
- `portal/views/schedule.js`：`STATUS_BADGE` 加 `partial`（藍）、`STATUS_LABEL` 加 `partial: '✅ 完成·待確認'`、
  `statusIcon`（L732）加 `partial: '✅'`。
- `portal/telegram.js`（L393、L1102）：icon 分流新增 `partial → '✅'`，摘要文案帶 reason。
- `portal/commands/task.md`（`/task` 技能）：把 §8.4 的二選一硬條件寫進去，取代現行描述性說法；
  並要求 `partial` 的 reason 同時寫「已完成什麼／待確認什麼」。

### 8.6 已知限制（誠實聲明）

本機制仍**依賴 agent 自我標記**，系統無法自動驗證它到底做了沒。§8.4 的硬條件能大幅降低誤判率，
但**不保證 100% 不再誤報**。真要根治需由系統自行比對檔案異動（例如 run 前後的 git diff），
屬於更大的題目，**本期明確不做**。

### 8.7 驗收（DoD）

- [x] mock `ctx.result` 帶 `<run-outcome status="partial" reason="…" />` → run 記錄 `status=partial`、`outcomeReason` 有值。（鏡射邏輯腳本驗證，見 DASHBOARD 2026-09-09 SSTAT-P 記錄）
- [x] 面板顯示**藍色 ✅「完成·待確認」**，與綠色 success、amber blocked 三者一眼可辨；深淺色皆可讀。（程式已改，`portal/views/schedule.js` 用既有 dark: class 慣例；**視覺呈現待指揮官部署後手動驗證**）
- [x] `partial` **歸零** `consecutiveFailures`；`blocked` 維持既有（不歸零不累加）——未回歸。（單元測試驗證通過）
- [x] `partial` **不觸發** chainNext、**不觸發** postRun.deploy。（條件本為嚴格 `status==='success'`，程式碼審視＋鏡射測試確認）
- [x] Telegram 推播顯示 ✅ 與 reason，且 `<run-outcome>` 標記不出現在正文與存檔 transcript。（icon 分流已改；reason 沿用既有 `deliverSummary` 管道，未起真 bot 端對端測試，判斷風險低）
- [x] 既有 success／failed／blocked／limited-waiting 行為完全未變。（回歸測試通過）
- [ ] `Deploy_Harness.ps1` 冒煙通過。（**本次刻意未部署**——系統指令明令不自動 Deploy，由指揮官自行決定時機後才能勾這項）

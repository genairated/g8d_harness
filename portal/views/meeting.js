// SPEC-portal-architecture.md §V7 — AI 會議 view 模組。
// 沿用 V1 chat / V6 documents 的「殼搬遷」手法（非 V8/V9 的完整搬移）：會議面板的業務邏輯
// （mtgLoadHistory/mtgStart/mtgStop/mtgPollTranscript/mtgSummarize/mtgRunExport/……逾千行）
// 與浮動聊天（float-chat 綁 meeting context）、音訊主題下拉（onAudioTopicSelect/loadAudioTopics）
// 等全站共用函式深度糾纏、體量遠大於 V8/V9，判斷完整拆分風險/效益比不划算；本檔只負責把原本
// index.html 裡 <section id="meeting-panel"> 的靜態 DOM 殼動態建置進 #view-root，並把 inline
// onclick/oninput/onchange/ontimeupdate/onerror/onloadedmetadata 改成 addEventListener。所有業務
// 邏輯（mtg*/onAudioTopicSelect/voiceToggle……）維持是 index.html 傳統 <script> 的全域 function
// 宣告，本檔透過 window.xxx 呼叫；它們本來就只用 document.getElementById 操作 DOM，不管這些 id
// 掛在哪個容器下都能正常運作（同 V1/V6 已驗證的手法）。
// 語音輸入（voiceRec/voiceToggle）屬會議收音功能，本就留在 index.html 未搬（S 階段範圍），本次
// 遷移不動它，沿用既有呼叫方式。

export const meta = { route: '/app/meeting', title: 'AI 會議', icon: 'mic', menuGroup: 'meeting' };

let container = null;

const PANEL_HTML = `
    <!-- h-full：#view-root 不是 flex 容器（它是 flex-1 overflow-y-auto 的捲動框），所以這層的
         flex-1 不會生效，少了 h-full 就只撐到內容高度＝畫面沒滿版。同 chat/notes/codegraph 的寫法。 -->
    <section class="flex-1 overflow-hidden flex h-full bg-slate-50/50 dark:bg-slate-900/40">

      <!-- ── 左欄：搜尋 + 新增按鈕（點展開表單） + 會議清單 ── -->
      <div class="w-72 flex-shrink-0 border-r border-slate-200 dark:border-slate-800 flex flex-col bg-white/40 dark:bg-slate-900/30">

        <!-- 搜尋列 + 新增按鈕 -->
        <div class="p-3 border-b border-slate-200 dark:border-slate-800 flex-shrink-0">
          <div class="flex items-center gap-2">
            <input id="mtg-search" type="text" placeholder="搜尋標題或標籤…" class="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs text-slate-800 dark:text-slate-100" />
            <button id="mtg-new-btn" title="新增會議" class="flex-shrink-0 px-2.5 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-xs font-semibold transition-colors flex items-center gap-1"><i data-lucide="plus" class="h-3.5 w-3.5"></i>新增</button>
            <button id="mtg-import-toggle-btn" title="匯入音檔／字幕" class="flex-shrink-0 px-2.5 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-xs font-semibold transition-colors flex items-center gap-1"><i data-lucide="upload" class="h-3.5 w-3.5"></i>匯入</button>
          </div>
          <!-- 新會議表單（預設折疊，點「新增」展開）-->
          <div id="mtg-new-form" class="hidden mt-3 pt-3 border-t border-slate-100 dark:border-slate-800 space-y-2">
            <input id="mtg-title" type="text" placeholder="會議標題（可留空）" class="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-800 dark:text-slate-100" />
            <label class="text-[11px] text-slate-500 dark:text-slate-400 flex flex-col gap-0.5">收音來源
              <select id="mtg-source" class="px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs text-slate-800 dark:text-slate-100">
                <option value="both">兩者同收（麥＋系統）</option>
                <option value="loopback">系統 loopback</option>
                <option value="mic">麥克風（自己）</option>
              </select>
            </label>
            <div class="grid grid-cols-2 gap-2">
              <label class="text-[11px] text-slate-500 dark:text-slate-400 flex flex-col gap-0.5">模型
                <select id="mtg-model" class="px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs text-slate-800 dark:text-slate-100">
                  <option value="base">base（快）</option>
                  <option value="small" selected>small（中）</option>
                  <option value="medium">medium（準）</option>
                  <option value="large-v3">large-v3</option>
                </select>
              </label>
              <label class="text-[11px] text-slate-500 dark:text-slate-400 flex flex-col gap-0.5">語言
                <select id="mtg-lang" class="px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs text-slate-800 dark:text-slate-100">
                  <option value="zh">中文</option>
                  <option value="en">English</option>
                </select>
              </label>
            </div>
            <label class="text-[11px] text-slate-500 dark:text-slate-400 flex flex-col gap-0.5">音訊主題（AT2-a）
              <select id="mtg-topic" class="px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs text-slate-800 dark:text-slate-100"></select>
            </label>
            <button id="mtg-start-btn" class="w-full px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-1.5"><i data-lucide="circle" class="h-4 w-4"></i>開始錄製</button>
            <p class="text-[10px] text-slate-400">本機辨識，音訊不外送。</p>
          </div>
          <!-- 匯入表單（音檔/字幕 → 會議分析；預設折疊，點「匯入」展開）-->
          <div id="mtg-import-form" class="hidden mt-3 pt-3 border-t border-slate-100 dark:border-slate-800 space-y-2">
            <input id="mtg-imp-title" type="text" placeholder="標題（可留空）" class="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-800 dark:text-slate-100" />
            <label class="text-[11px] text-slate-500 dark:text-slate-400 flex flex-col gap-0.5">選擇檔案（mp3/mp4/m4a/wav/vtt/srt）
              <input id="mtg-imp-file" type="file" accept=".mp3,.mp4,.m4a,.wav,.vtt,.srt" class="text-xs text-slate-600 dark:text-slate-300 file:mr-2 file:py-1 file:px-2 file:rounded-md file:border-0 file:text-xs file:bg-violet-100 file:text-violet-700 dark:file:bg-violet-900/40 dark:file:text-violet-300" />
            </label>
            <div class="text-[10px] text-slate-400 text-center">— 或 大檔改填本地路徑（免上傳） —</div>
            <input id="mtg-imp-path" type="text" placeholder="本地絕對路徑，例：D:/會議/錄音.mp4" class="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs text-slate-800 dark:text-slate-100" />
            <div class="grid grid-cols-2 gap-2">
              <label class="text-[11px] text-slate-500 dark:text-slate-400 flex flex-col gap-0.5">模型（音檔用）
                <select id="mtg-imp-model" class="px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs text-slate-800 dark:text-slate-100">
                  <option value="base">base（快）</option>
                  <option value="small">small（中）</option>
                  <option value="medium" selected>medium（準）</option>
                  <option value="large-v3">large-v3</option>
                </select>
              </label>
              <label class="text-[11px] text-slate-500 dark:text-slate-400 flex flex-col gap-0.5">語言
                <select id="mtg-imp-lang" class="px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs text-slate-800 dark:text-slate-100">
                  <option value="zh">中文</option>
                  <option value="en">English</option>
                </select>
              </label>
            </div>
            <button id="mtg-imp-btn" class="w-full px-3 py-2 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-1.5"><i data-lucide="upload" class="h-4 w-4"></i>匯入分析</button>
            <p class="text-[10px] text-slate-400">音檔本機辨識、字幕直接解析；大檔背景轉錄不卡畫面。</p>
          </div>
        </div>

        <!-- 會議清單（直接列出） -->
        <div class="flex-1 overflow-y-auto p-2">
          <div id="mtg-history" class="space-y-1 text-sm text-slate-500">載入中…</div>
        </div>
      </div>

      <!-- ── 右欄：活躍會議 + 詳情 ── -->
      <div class="flex-1 overflow-y-auto p-6">

        <!-- Empty state (shown when no meeting selected) -->
        <div id="mtg-right-empty" class="flex flex-col items-center justify-center h-full text-slate-400 text-sm select-none">
          <i data-lucide="mic" class="h-12 w-12 mb-3 opacity-20"></i>
          <p class="text-center text-slate-400">選擇左側會議查看詳情<br>或開始一場新錄製</p>
        </div>

        <div class="space-y-4">
          <!-- Active / selected meeting -->
          <div id="mtg-active" class="hidden rounded-2xl border border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/40 p-5 shadow-sm">
            <div class="flex items-center justify-between mb-3">
              <h2 id="mtg-active-title" class="text-base font-bold text-slate-800 dark:text-slate-100 truncate"></h2>
              <div class="flex items-center gap-2">
                <span id="mtg-status" class="text-xs px-2 py-1 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500"></span>
                <button id="mtg-stop-btn" class="hidden px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold transition-colors flex items-center gap-1.5"><i data-lucide="square" class="h-3.5 w-3.5"></i>停止錄製</button>
              </div>
            </div>
            <!-- MTG-CVW-02: 原始／校正後切換（僅 meta.correction.status='done' 時顯示） -->
            <div id="mtg-view-toggle" class="hidden flex items-center gap-1.5 mb-2">
              <button id="mtg-view-raw-btn" class="px-2.5 py-1 rounded-lg text-xs font-semibold bg-violet-600 text-white">原始</button>
              <button id="mtg-view-corrected-btn" class="px-2.5 py-1 rounded-lg text-xs font-semibold bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">校正後</button>
              <button id="mtg-open-corrected-btn" class="ml-1 px-2.5 py-1 rounded-lg text-xs font-semibold border border-violet-300 dark:border-violet-700 text-violet-600 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-900/30 flex items-center gap-1"><i data-lucide="maximize-2" class="h-3 w-3"></i>檢視校正版</button>
            </div>
            <!-- MTG-PLAY-02: 錄音回放（Range 可拖曳/seek）；逐字稿點行 seek、播放中高亮見 mtgAudioTimeUpdate() -->
            <div id="mtg-audio-wrap" class="hidden mb-2">
              <audio id="mtg-audio" controls class="w-full h-9"></audio>
            </div>
            <pre id="mtg-transcript" class="whitespace-pre-wrap break-words text-sm text-slate-700 dark:text-slate-200 bg-slate-50 dark:bg-slate-950/40 border border-slate-200/60 dark:border-slate-800/60 rounded-xl p-4 max-h-[45vh] overflow-y-auto font-sans leading-relaxed"></pre>

            <!-- Post-processing (after done) -->
            <div id="mtg-postproc" class="hidden mt-4 space-y-3">
              <div class="flex items-center gap-2 flex-wrap">
                <label class="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">發言人數
                  <input id="mtg-speakers" type="number" min="1" max="20" placeholder="自動" class="w-16 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs text-slate-800 dark:text-slate-100" title="會講話的人數（不含全程沒發言者）；留空＝自動，可改數字重跑">
                </label>
                <button id="mtg-diarize-btn" class="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-xs font-semibold transition-colors flex items-center gap-1.5"><i data-lucide="users" class="h-3.5 w-3.5"></i>語者分離</button>
                <span id="mtg-diarize-hint" class="text-[11px] text-slate-400">需 HF_TOKEN；填發言人數更準（留空自動、可重跑）。</span>
              </div>
              <div id="mtg-remap-area" class="hidden space-y-2">
                <p class="text-xs text-slate-500 dark:text-slate-400">填入各語者真名後 remap 成最終逐字稿：</p>
                <p class="text-[10px] text-slate-400">💡 要<strong>合併</strong>被拆開的同一人 → 兩個輸入框填同一個名字即可（同名 = 自動合併）。</p>
                <div id="mtg-remap-inputs" class="grid grid-cols-2 sm:grid-cols-3 gap-2"></div>
                <button id="mtg-remap-btn" class="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-xs font-semibold transition-colors">套用真名 (remap)</button>
              </div>
            </div>
          </div>

          <!-- Meeting Detail: Summary + Actions + History -->
          <div id="mtg-detail" class="hidden space-y-4">
            <!-- MTG-GEN-02: 錄完就地引導 CTA（有逐字稿、尚無摘要時顯示） -->
            <div id="mtg-gen-cta" class="hidden rounded-2xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-900/10 p-4 space-y-2">
              <p class="text-xs font-semibold text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5"><i data-lucide="sparkles" class="h-3.5 w-3.5"></i>會議已結束，逐字稿已就緒 → 產生會議記錄：</p>
              <div class="flex items-center gap-2 flex-wrap">
                <span class="text-[11px] text-slate-500 dark:text-slate-400 whitespace-nowrap">①（可選）校正逐字稿</span>
                <select id="mtg-gen-correct-model" class="px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs text-slate-800 dark:text-slate-100"><option value="">載入模型中…</option></select>
                <button id="mtg-gen-correct-btn" class="px-3 py-1.5 rounded-lg border border-violet-300 dark:border-violet-700 text-xs text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-900/30 transition-colors">校正逐字稿</button>
                <span id="mtg-gen-correct-hint" class="text-[11px] text-slate-400"></span>
              </div>
              <div class="flex items-center gap-2 flex-wrap pt-2 border-t border-emerald-100 dark:border-emerald-900/40">
                <span class="text-[11px] text-slate-500 dark:text-slate-400 whitespace-nowrap">② 選模型 → ③ 產生會議記錄</span>
                <button id="mtg-gen-modelpanel-btn" class="px-3 py-1.5 rounded-lg border border-emerald-300 dark:border-emerald-700 text-xs text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 transition-colors">選模型（多模型比較）</button>
                <button id="mtg-gen-summarize-btn" class="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold transition-colors">直接產生會議記錄（預設模型）</button>
              </div>
            </div>
            <!-- Summary section -->
            <div class="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/40 p-5 shadow-sm">
              <div class="flex items-center justify-between mb-1">
                <h2 class="text-base font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2"><i data-lucide="file-text" class="h-4 w-4 text-emerald-600 dark:text-emerald-400"></i>摘要</h2>
                <div class="flex items-center gap-2">
                  <button id="mtg-summarize-btn" class="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold transition-colors flex items-center gap-1.5"><i data-lucide="sparkles" class="h-3.5 w-3.5"></i>Hana 整理</button>
                  <button id="mtg-multimodel-btn" class="px-3 py-1.5 rounded-lg border border-emerald-300 dark:border-emerald-700 text-xs text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 transition-colors flex items-center gap-1.5"><i data-lucide="layers" class="h-3.5 w-3.5"></i>多模型</button>
                  <button id="mtg-export-btn" class="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors flex items-center gap-1.5"><i data-lucide="download" class="h-3.5 w-3.5"></i>匯出</button>
                  <button id="mtg-sum-edit-btn" class="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">編輯</button>
                </div>
              </div>
              <!-- MTG-EXP-04 export panel -->
              <div id="mtg-export-panel" class="hidden mb-3 p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/30 space-y-2">
                <div class="flex items-center gap-4 flex-wrap">
                  <span class="text-xs text-slate-500">格式：</span>
                  <label class="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer"><input type="radio" name="mtg-exp-format" value="docx" checked class="h-3.5 w-3.5 text-cyan-600" />Word</label>
                  <label class="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer"><input type="radio" name="mtg-exp-format" value="pdf" class="h-3.5 w-3.5 text-cyan-600" />PDF</label>
                </div>
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="text-xs text-slate-500">版本：</span>
                  <select id="mtg-exp-selection" class="px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs text-slate-800 dark:text-slate-100">
                    <option value="final">收尾版</option>
                  </select>
                </div>
                <div class="flex items-center gap-4 flex-wrap">
                  <span class="text-xs text-slate-500">選配：</span>
                  <label class="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer"><input type="checkbox" id="mtg-exp-actions" checked class="h-3.5 w-3.5 rounded text-cyan-600" />含待辦</label>
                  <label class="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer"><input type="checkbox" id="mtg-exp-transcript" class="h-3.5 w-3.5 rounded text-cyan-600" />含逐字稿</label>
                  <button id="mtg-exp-run-btn" class="ml-auto px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-xs font-semibold transition-colors">下載</button>
                </div>
              </div>
              <!-- MTG-SUM-05 provenance line -->
              <div id="mtg-summary-provenance" class="hidden text-[11px] text-slate-400 dark:text-slate-500 mb-2"></div>
              <!-- MTG-SUM-05 multi-model picker panel -->
              <div id="mtg-model-panel" class="hidden mb-3 p-3 rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-900/10 space-y-2">
                <p class="text-xs font-semibold text-slate-600 dark:text-slate-300">選擇模型（可多選）→ 各出一版並排比較</p>
                <div id="mtg-model-checks" class="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-slate-600 dark:text-slate-300"><span class="text-slate-400 italic">載入模型清單中…</span></div>
                <div class="flex items-center gap-4 pt-1 border-t border-emerald-100 dark:border-emerald-900/50">
                  <span class="text-xs text-slate-500">分項：</span>
                  <label class="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer"><input type="checkbox" id="mtg-part-summary" checked class="h-3.5 w-3.5 rounded text-emerald-600" />摘要</label>
                  <label class="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer"><input type="checkbox" id="mtg-part-keypoints" checked class="h-3.5 w-3.5 rounded text-emerald-600" />會議重點</label>
                  <label class="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer"><input type="checkbox" id="mtg-part-actions" checked class="h-3.5 w-3.5 rounded text-emerald-600" />Action item</label>
                  <span id="mtg-parts-hint" class="hidden text-[10px] text-amber-500">需先產生摘要，已自動勾回</span>
                </div>
                <div class="flex items-center gap-4 pt-1 border-t border-emerald-100 dark:border-emerald-900/50">
                  <span class="text-xs text-slate-500">收尾方式：</span>
                  <label class="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer"><input type="radio" name="mtg-sum-mode" value="pick" checked class="h-3.5 w-3.5 text-emerald-600" />挑一版</label>
                  <label class="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer"><input type="radio" name="mtg-sum-mode" value="merge" class="h-3.5 w-3.5 text-emerald-600" />彙整（主模型參考各版）</label>
                  <button id="mtg-run-multi-btn" class="ml-auto px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold transition-colors">開始整理</button>
                </div>
              </div>
              <!-- MTG-SUM-13/14 multi-model run progress (立即 spinner + x/N，取代「看似沒反應」) -->
              <div id="mtg-multi-progress" class="hidden mb-3 p-2.5 rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-900/20 text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-2"></div>
              <!-- MTG-SUM-05/15 per-model versions (tabbed；含「收尾版」，切換連動下方三卡) -->
              <div id="mtg-summary-versions" class="hidden mb-3"></div>
              <div id="mtg-summary-view" class="prose prose-sm dark:prose-invert max-w-none text-slate-600 dark:text-slate-300 text-sm min-h-[48px]"><p class="text-slate-400 text-sm italic">尚無摘要。按「Hana 整理」產生，或結束錄製後自動產生。</p></div>
              <textarea id="mtg-summary-edit" class="hidden w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-800 dark:text-slate-100 font-mono min-h-[140px]"></textarea>
              <div id="mtg-sum-edit-bar" class="hidden mt-2 flex gap-2">
                <button id="mtg-save-summary-btn" class="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-xs font-semibold">儲存摘要</button>
                <button id="mtg-cancel-sumedit-btn" class="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">取消</button>
              </div>
            </div>
            <!-- Keypoints section (P3 §5.5) -->
            <div class="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/40 p-5 shadow-sm">
              <div class="flex items-center justify-between mb-1">
                <h2 class="text-base font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2"><i data-lucide="list-checks" class="h-4 w-4 text-cyan-600 dark:text-cyan-400"></i>會議重點</h2>
              </div>
              <div id="mtg-keypoints-view" class="prose prose-sm dark:prose-invert max-w-none text-slate-600 dark:text-slate-300 text-sm min-h-[24px]"><p class="text-slate-400 text-sm italic">尚無會議重點。</p></div>
            </div>
            <!-- Action Items section -->
            <div class="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/40 p-5 shadow-sm">
              <div class="flex items-center justify-between mb-3">
                <h2 class="text-base font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2"><i data-lucide="check-square" class="h-4 w-4 text-amber-600 dark:text-amber-400"></i>Action Items</h2>
                <button id="mtg-add-action-btn" class="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors flex items-center gap-1"><i data-lucide="plus" class="h-3 w-3"></i>新增</button>
              </div>
              <div id="mtg-actions-table" class="space-y-2"></div>
            </div>
            <!-- Change history section -->
            <div class="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/40 p-5 shadow-sm">
              <div class="flex items-center justify-between mb-3">
                <h2 class="text-base font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2"><i data-lucide="git-commit" class="h-4 w-4 text-slate-600 dark:text-slate-400"></i>變更歷史</h2>
                <button id="mtg-refresh-history-btn" class="text-xs text-cyan-600 dark:text-cyan-400 hover:underline">重新整理</button>
              </div>
              <div id="mtg-change-history" class="space-y-1 text-sm text-slate-500">（點右上角重新整理載入）</div>
              <div id="mtg-diff-view" class="hidden mt-3 p-3 bg-slate-50 dark:bg-slate-950/50 rounded-xl border border-slate-200 dark:border-slate-800 font-mono text-xs overflow-x-auto whitespace-pre max-h-64 overflow-y-auto"></div>
            </div>
          </div>
        </div>
      </div>

    </section>`;

function call(name, ...args) {
  if (typeof window[name] === 'function') window[name](...args);
}

function wireEvents() {
  const $ = (sel) => container.querySelector(sel);

  $('#mtg-search').addEventListener('input', () => call('mtgFilterHistory'));
  $('#mtg-new-btn').addEventListener('click', () => call('mtgToggleNewForm'));
  $('#mtg-import-toggle-btn').addEventListener('click', () => call('mtgToggleImportForm'));
  $('#mtg-topic').addEventListener('change', function () { call('onAudioTopicSelect', this, 'mtg-lang'); });
  $('#mtg-start-btn').addEventListener('click', () => call('mtgStart'));
  $('#mtg-imp-btn').addEventListener('click', () => call('mtgImport'));
  $('#mtg-stop-btn').addEventListener('click', () => call('mtgStop'));
  $('#mtg-view-raw-btn').addEventListener('click', () => call('mtgSetViewMode', 'raw'));
  $('#mtg-view-corrected-btn').addEventListener('click', () => call('mtgSetViewMode', 'corrected'));
  $('#mtg-open-corrected-btn').addEventListener('click', () => call('mtgOpenCorrectedView'));
  const audioEl = $('#mtg-audio');
  audioEl.addEventListener('timeupdate', () => call('mtgAudioTimeUpdate'));
  audioEl.addEventListener('error', () => call('mtgAudioOnError'));
  audioEl.addEventListener('loadedmetadata', () => call('mtgAudioOnLoaded'));
  $('#mtg-diarize-btn').addEventListener('click', () => call('mtgDiarize'));
  $('#mtg-remap-btn').addEventListener('click', () => call('mtgRemap'));
  $('#mtg-gen-correct-btn').addEventListener('click', () => call('mtgCorrectTranscript'));
  $('#mtg-gen-modelpanel-btn').addEventListener('click', () => call('mtgToggleModelPanel'));
  $('#mtg-gen-summarize-btn').addEventListener('click', () => call('mtgSummarize'));
  $('#mtg-summarize-btn').addEventListener('click', () => call('mtgSummarize'));
  $('#mtg-multimodel-btn').addEventListener('click', () => call('mtgToggleModelPanel'));
  $('#mtg-export-btn').addEventListener('click', () => call('mtgToggleExportPanel'));
  $('#mtg-sum-edit-btn').addEventListener('click', () => call('mtgToggleSumEdit'));
  $('#mtg-exp-run-btn').addEventListener('click', () => call('mtgRunExport'));
  $('#mtg-part-summary').addEventListener('change', () => call('mtgPartsGuard', 'summary'));
  $('#mtg-run-multi-btn').addEventListener('click', () => call('mtgRunMultiSummarize'));
  $('#mtg-save-summary-btn').addEventListener('click', () => call('mtgSaveSummary'));
  $('#mtg-cancel-sumedit-btn').addEventListener('click', () => call('mtgCancelSumEdit'));
  $('#mtg-add-action-btn').addEventListener('click', () => call('mtgAddAction'));
  $('#mtg-refresh-history-btn').addEventListener('click', () => call('mtgLoadChangeHistory'));
}

export function mount(root, ctx) {
  container = root;
  if (typeof window.showPanel === 'function') window.showPanel('__view_root__');
  root.classList.remove('hidden');
  root.innerHTML = PANEL_HTML;
  if (typeof window.highlightMenuBtn === 'function') window.highlightMenuBtn('menu-meeting');

  const pathEl = document.getElementById('header-file-path'); if (pathEl) pathEl.innerText = 'AI 會議';
  const titleEl = document.getElementById('header-file-title'); if (titleEl) titleEl.innerText = '即時辨識・邊轉邊存・語者分離';
  const vscodeEl = document.getElementById('btn-vscode'); if (vscodeEl) vscodeEl.href = '#';
  const savedEl = document.getElementById('last-saved'); if (savedEl) savedEl.classList.add('hidden');
  const backEl = document.getElementById('btn-back'); if (backEl) backEl.classList.add('hidden');
  // 原 switchToMeeting() 有 historyStack = [] 重置，但 historyStack 是傳統 <script> 的模組級 let
  // 綁定、ESM 拿不到（同 V8/V9 已記錄的限制），故未搬；只影響 wiki 返回堆疊的邊界情況，非本次範圍。

  wireEvents();
  if (typeof lucide !== 'undefined') lucide.createIcons();
  call('mtgLoadHistory');
}

export function unmount() {
  if (container) { container.classList.add('hidden'); container.innerHTML = ''; }
  container = null;
}

// SPEC-view-chat-context.md §3.1/CTX3: report the currently-open meeting to the avatar float-chat.
// window.getActiveMeetingContext() (index.html, next to mtgCurrentId) bridges in the id/title this
// module can't see itself (classic <script> state, not visible to an ES module — see §V1 教訓).
export function getChatContext() {
  const r = (typeof window.getActiveMeetingContext === 'function') ? window.getActiveMeetingContext() : null;
  if (!r || !r.meetingId) return null;
  return { kind: 'meeting', key: 'meeting:' + r.meetingId, label: r.label || r.meetingId, payload: { meetingId: r.meetingId } };
}

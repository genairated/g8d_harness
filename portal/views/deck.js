// SPEC-portal-architecture.md §V12 — 簡報 host view 模組。
//
// 完整搬移（同 V2 codegraph / V8 notes / V9 audio-topics 的手法，非 V1/V6/V7/V10/V11 的「殼搬遷」）：
// deck host 的邏輯（渲染播放 iframe、縮放置中、全螢幕、匯出 pptx、錄製 mp4）本就自成一體，不像
// chat/documents/meeting/pm/wiki 的業務邏輯與其他面板深度共用同一批全域函式/模組級變數——原本
// index.html 的 renderHtmlPreview/fitDeckIframe/presentationFullscreen/exportPptx/recordMp4/
// fullscreenchange 監聽整段搬進本模組，成為此 view 專屬、唯一的播放 host。
//
// 注意：presentation-core.js 是「deck 檔案內部」自帶的播放引擎（跑在 iframe 裡），本檔只是外層容器
// （縮放/置中/工具列），兩者職責不同、不構成「唯一引擎雙套」——deck 本身仍只有一套 presentation-core。
//
// loadFile()（仍留在 index.html，全站共用的開檔基礎設施）偵測到目標是簡報 html 時，改呼叫
// ensureDeckView() 導覽到本路由，再呼叫 window.renderDeckPreview(filePath) 把內容渲染進本模組建立
// 的容器——鏡射 V11 wiki.js 的 ensureWikiView()+renderMarkdown() 分工模式：mount() 只搭好空殼，
// 實際內容渲染是另一個獨立呼叫，這樣同一個 deck 路由內切換到「另一份簡報」時，不會被 router.js 的
// currentView no-op（同一 view 重複進入即 no-op）擋掉——真正的內容更新繞過那層 dedupe，直接呼叫。

export const meta = { route: '/app/deck', title: '簡報播放', icon: 'presentation' };

let viewRoot = null;
let contentEl = null;
let resizeHandler = null;
let fullscreenHandler = null;

function fitDeckIframe() {
  const wrap = contentEl ? contentEl.querySelector('#deck-fit-wrap') : null;
  const frame = contentEl ? contentEl.querySelector('#html-preview-frame') : null;
  if (!wrap || !frame || document.fullscreenElement === wrap) return;
  const w = wrap.clientWidth;
  if (!w) return;
  const s = w / 1920;
  frame.style.transform = 'scale(' + s + ')';
  wrap.style.height = (1080 * s) + 'px';
}

// 全螢幕橋接：iframe 內的 presentation-core.js（跑在被 renderDeckPreview 建立的 deck 內容裡）
// 不對自己的 document 請求全螢幕，而是呼叫這三個掛在 window 上的函式，對 #deck-fit-wrap（此
// 頂層文件裡永遠不會因換集而被摧毀重建的容器）請求——這樣「下一集/跳章」重建 iframe 時，全螢幕
// 狀態才不會被瀏覽器自動退出。見 renderDeckPreview() 換頁時的 wrap.requestFullscreen() 呼叫。
function isPresentationFullscreen() {
  const wrap = contentEl ? contentEl.querySelector('#deck-fit-wrap') : null;
  return !!(wrap && document.fullscreenElement === wrap);
}
function presentationEnterFullscreen() {
  const wrap = contentEl ? contentEl.querySelector('#deck-fit-wrap') : null;
  if (wrap && wrap.requestFullscreen) wrap.requestFullscreen().catch(() => {});
}
function presentationExitFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
}
window.isPresentationFullscreen = isPresentationFullscreen;
window.presentationEnterFullscreen = presentationEnterFullscreen;
window.presentationExitFullscreen = presentationExitFullscreen;

// 沿用原行為：目前站內無任何呼叫點會觸發這個函式（原本也是如此，屬既有孤兒程式碼），
// 純粹搬移過來維持行為對等，不在本次範圍內新增呼叫點或移除。
function presentationFullscreen() {
  const frame = contentEl ? contentEl.querySelector('#html-preview-frame') : null;
  if (frame && frame.src) {
    const url = new URL(frame.src, window.location.origin);
    url.searchParams.set('autoplay', '1');
    window.open(url.toString(), '_blank');
  }
}

async function exportPptx(deckName) {
  const btn = contentEl.querySelector('#export-pptx-btn');
  const statusEl = contentEl.querySelector('#export-pptx-status');
  if (!btn || !deckName) return;
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="loader" class="h-3.5 w-3.5 animate-spin"></i>匯出中…';
  if (statusEl) { statusEl.className = 'mb-2 text-xs text-slate-400 text-right'; statusEl.textContent = '正在截圖並組裝 pptx，請稍候…'; }
  if (typeof lucide !== 'undefined') lucide.createIcons();
  try {
    const workspace = sessionStorage.getItem('current_workspace') || '';
    const res = await fetch('/api/presentations/' + encodeURIComponent(deckName) + '/export', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, workspace ? { 'X-Workspace': encodeURIComponent(workspace) } : {}),
      body: JSON.stringify({ format: 'pptx' })
    });
    const data = await res.json();
    if (data.ok) {
      const dlUrl = '/raw?path=' + encodeURIComponent(data.path) + (workspace ? '&workspace=' + encodeURIComponent(workspace) : '');
      if (statusEl) {
        statusEl.innerHTML = `已匯出 ${data.slides} 頁：<a href="${dlUrl}" download class="text-cyan-400 underline ml-1">${data.path}</a>`;
      }
    } else {
      if (statusEl) statusEl.textContent = '匯出失敗：' + (data.error || '未知錯誤');
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = '匯出失敗：' + e.message;
  }
  btn.disabled = false;
  btn.innerHTML = '<i data-lucide="download" class="h-3.5 w-3.5"></i>匯出 pptx';
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function recordMp4(deckName) {
  const btn = contentEl.querySelector('#record-mp4-btn');
  const statusEl = contentEl.querySelector('#export-pptx-status');
  if (!btn || !deckName) return;
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="loader" class="h-3.5 w-3.5 animate-spin"></i>錄製中…';
  if (statusEl) { statusEl.className = 'mb-2 text-xs text-slate-400 text-right'; statusEl.textContent = '正在截圖、生成語音並組裝 mp4，需要數分鐘…'; }
  if (typeof lucide !== 'undefined') lucide.createIcons();
  try {
    const workspace = sessionStorage.getItem('current_workspace') || '';
    const res = await fetch('/api/presentations/' + encodeURIComponent(deckName) + '/record', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, workspace ? { 'X-Workspace': encodeURIComponent(workspace) } : {}),
    });
    const data = await res.json();
    if (data.ok) {
      const mp4File = (data.path || '').split('/').pop();
      const mp4Url = '/api/presentations/exports/' + encodeURIComponent(mp4File);
      const vttFile = data.vtt ? data.vtt.split('/').pop() : null;
      const vttUrl = vttFile ? '/api/presentations/exports/' + encodeURIComponent(vttFile) : null;
      if (statusEl) {
        statusEl.className = 'mb-2';
        statusEl.innerHTML =
          `<div class="text-xs text-slate-400 dark:text-slate-500 mb-1">已錄製 ${data.slides} 頁（語音：${data.voice || ''}）</div>` +
          `<video controls preload="metadata" style="width:100%;max-height:60vh;border-radius:8px;background:#000" src="${mp4Url}">` +
          (vttUrl ? `<track kind="captions" srclang="zh" label="字幕" default src="${vttUrl}">` : '') +
          `</video>` +
          `<div class="text-xs mt-1 text-right"><a href="${mp4Url}" download class="text-cyan-400 underline">下載 mp4</a>` +
          (vttUrl ? ` · <a href="${vttUrl}" download class="text-cyan-400 underline">下載字幕 (vtt)</a>` : '') + `</div>`;
      }
    } else {
      if (statusEl) statusEl.textContent = '錄製失敗：' + (data.error || '未知錯誤');
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = '錄製失敗：' + e.message;
  }
  btn.disabled = false;
  btn.innerHTML = '<i data-lucide="video" class="h-3.5 w-3.5"></i>錄製影片';
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// 渲染指定簡報檔進本 view 目前的容器——由 loadFile()（index.html）在 ensureDeckView() 之後呼叫。
// 曝露在 window 上是因為呼叫方（loadFile）是傳統 <script> 作用域、非 ES module，兩邊唯一的橋接方式。
function renderDeckPreview(filePath, resume) {
  if (!contentEl) return;
  // resume：呼叫方（index.html 的 loadFile，轉發自 iframe 內 gotoDeck()）明確表示換頁前正在播放；
  // 另外自己也用目前的 fullscreen 狀態兜底判斷一次，兩者任一為真都視為需要接續。
  const shouldResume = !!resume || isPresentationFullscreen();
  document.body.classList.add('has-active-presentation');
  const workspace = sessionStorage.getItem('current_workspace') || '';
  const src = '/raw?path=' + encodeURIComponent(filePath) + (workspace ? '&workspace=' + encodeURIComponent(workspace) : '') + (shouldResume ? '&resume=1' : '');
  const deckName = filePath.split('/').pop().replace(/\.html$/, '');

  // 同一次 view 掛載內換到「另一份簡報」（下一集/跳章）：若 #deck-fit-wrap 已存在，直接原地換
  // iframe.src，不要整段炸掉重建。實測過重建會炸出全螢幕 bug——wrap 正是目前的全螢幕元素，砍掉它
  // 觸發瀏覽器非同步的「自動退出全螢幕」清理，這個清理會晚於「對新 wrap 重新 requestFullscreen」
  // 才執行，結果把剛接續成功的全螢幕又偷偷關掉；等新頁面 iframe 載入完、自己發現不是全螢幕想再請求
  // 一次時，使用者手勢視窗已經過期，第二次請求必被瀏覽器拒絕（"can only be initiated by a user
  // gesture"）——這就是「已全螢幕時換集/跳章不會維持全螢幕」的根因。原地換 src 不動 wrap，
  // 全螢幕狀態全程不受影響，連 resume 的重新 request 都不需要了。
  const existingWrap = contentEl.querySelector('#deck-fit-wrap');
  const existingFrame = contentEl.querySelector('#html-preview-frame');
  if (existingWrap && existingFrame) {
    existingFrame.src = src;
    const exportBtn = contentEl.querySelector('#export-pptx-btn');
    if (exportBtn) exportBtn.onclick = () => exportPptx(deckName);
    const recordBtn = contentEl.querySelector('#record-mp4-btn');
    if (recordBtn) recordBtn.onclick = () => recordMp4(deckName);
    const openLink = contentEl.querySelector('a[rel="noopener"]');
    if (openLink) openLink.href = src;
    fitDeckIframe();
    return;
  }

  contentEl.innerHTML = `
    <div class="mb-2 flex items-center justify-end gap-2">
      <button id="export-pptx-btn" class="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"><i data-lucide="download" class="h-3.5 w-3.5"></i>匯出 pptx</button>
      <button id="record-mp4-btn" class="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"><i data-lucide="video" class="h-3.5 w-3.5"></i>錄製影片</button>
      <a href="${src}" target="_blank" rel="noopener" class="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"><i data-lucide="external-link" class="h-3.5 w-3.5"></i>新分頁開啟</a>
    </div>
    <div id="export-pptx-status" class="hidden mb-2 text-xs text-slate-500 dark:text-slate-400 text-right"></div>
    <div id="deck-fit-wrap" style="position:relative; width:100%; overflow:hidden; background:#000; border-radius:14px; box-shadow:0 8px 40px rgba(0,0,0,0.25);">
      <iframe id="html-preview-frame" src="${src}" allow="fullscreen; autoplay"
        style="width:1920px; height:1080px; border:0; transform-origin: top left; display:block;"></iframe>
    </div>`;

  const exportBtn = contentEl.querySelector('#export-pptx-btn');
  if (exportBtn) exportBtn.onclick = () => exportPptx(deckName);
  const recordBtn = contentEl.querySelector('#record-mp4-btn');
  if (recordBtn) recordBtn.onclick = () => recordMp4(deckName);

  if (typeof lucide !== 'undefined') lucide.createIcons();
  fitDeckIframe();
  setTimeout(fitDeckIframe, 60);

  // 換頁前若正在全螢幕播放：重建 wrap/iframe 已經讓瀏覽器自動退出了舊的全螢幕（新 DOM 節點跟
  // 舊的全螢幕狀態無關），這裡要在「同一次由使用者點擊觸發」的呼叫鏈裡立刻對新的 wrap 重新請求——
  // 只要不是等新分頁載入完成後才呼叫，仍在使用者手勢的有效視窗內，瀏覽器會放行。
  if (shouldResume) presentationEnterFullscreen();

  const frame = contentEl.querySelector('#html-preview-frame');
  if (frame) {
    frame.addEventListener('load', () => {
      try {
        const iframeDoc = frame.contentDocument || frame.contentWindow.document;
        const wrap = contentEl.querySelector('#deck-fit-wrap');
        if (iframeDoc && wrap) {
          iframeDoc.addEventListener('mouseenter', () => wrap.classList.add('iframe-hovered'));
          iframeDoc.addEventListener('mouseleave', () => wrap.classList.remove('iframe-hovered'));
          iframeDoc.addEventListener('mousemove', () => {
            if (!wrap.classList.contains('iframe-hovered')) wrap.classList.add('iframe-hovered');
          });
        }
      } catch (e) {
        console.warn('Iframe hover event sync failed:', e);
      }
    });
  }
}
window.renderDeckPreview = renderDeckPreview;
// 供偵錯/未來擴充呼叫；目前站內無呼叫點（同原本 index.html 行為，見上方註解）。
window.presentationFullscreen = presentationFullscreen;

export function mount(root) {
  viewRoot = root;
  if (typeof window.showPanel === 'function') window.showPanel('__view_root__');
  root.classList.remove('hidden');
  // 與原本 wiki content-area 相同的置中留白寬度（本次只搬 host、不重新設計版面）。
  root.innerHTML = '<div class="max-w-4xl mx-auto px-12 py-10"></div>';
  contentEl = root.querySelector('div');

  resizeHandler = () => fitDeckIframe();
  window.addEventListener('resize', resizeHandler);

  fullscreenHandler = () => {
    const wrap = contentEl ? contentEl.querySelector('#deck-fit-wrap') : null;
    const frame = contentEl ? contentEl.querySelector('#html-preview-frame') : null;
    const widget = document.getElementById('hana-float-widget');
    if (!wrap || !frame) return;
    if (document.fullscreenElement === wrap) {
      if (widget) { wrap.appendChild(widget); widget.style.position = 'absolute'; }
      wrap.classList.add('has-active-presentation');
      const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
      const tx = (window.innerWidth - 1920 * s) / 2, ty = (window.innerHeight - 1080 * s) / 2;
      wrap.style.height = '100%';
      frame.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')';
    } else {
      if (widget) { document.body.appendChild(widget); widget.style.position = 'fixed'; }
      wrap.classList.remove('has-active-presentation');
      frame.style.transform = '';
      fitDeckIframe();
      // 瀏覽器原生退出全螢幕（如按 Esc）不會經過 iframe 自己的 document——這裡回頭通知 iframe
      // 內的播放引擎同步收尾（停語音、拿掉 presentation-mode class），避免畫面已退出全螢幕但
      // deck 內部還以為自己在播放中。
      try {
        if (frame.contentWindow && typeof frame.contentWindow.__hanaExitPresentationMode === 'function') {
          frame.contentWindow.__hanaExitPresentationMode();
        }
      } catch (e) {}
    }
  };
  document.addEventListener('fullscreenchange', fullscreenHandler);
}

export function unmount() {
  document.body.classList.remove('has-active-presentation');
  if (resizeHandler) { window.removeEventListener('resize', resizeHandler); resizeHandler = null; }
  if (fullscreenHandler) { document.removeEventListener('fullscreenchange', fullscreenHandler); fullscreenHandler = null; }
  if (viewRoot) { viewRoot.classList.add('hidden'); viewRoot.innerHTML = ''; }
  viewRoot = null;
  contentEl = null;
}

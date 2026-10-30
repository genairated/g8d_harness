/* presentation-core.js — 共享簡報播放引擎
 *
 * 來源：以 ep2 (presentation-hana-episode2.html) 的 proven 內嵌引擎為基準抽出成共享模組。
 * 配對：presentation-core.css（外殼樣式）、hana-overlay.js（浮動頭像 + 語音覆寫，由 server 注入）。
 * 規格：specs/SPEC-presentation-core.md
 *
 * Deck 合約（deck 只需提供這些，其餘外殼由本檔建立）：
 *   <div class="presentation-viewport" id="viewport" [data-subtitle="..."]>
 *     <header>...brand + meta...</header>            (可選；不提供則無頁首)
 *     <main class="slides">
 *       <section class="slide [title-slide]" data-transcript="逐字稿（給 TTS 朗讀）"> ...內容... </section>
 *       ...
 *     </main>
 *   </div>
 *   <link rel="stylesheet" href="/raw?path=portal/presentation-player/presentation-core.css">
 *   <script src="/raw?path=portal/presentation-player/presentation-core.js"></script>
 *
 * 本檔自動建立：grid / progress / timer / footer(控制列) / tech-panel(語音面板) / drawer(逐字稿) / overlay(開始播放)。
 * 語音實際發聲交給瀏覽器 speechSynthesis；hana-overlay.js 會 hook speak 套用全域語音設定並驅動頭像 talk/idle。
 */
(function () {
  'use strict';

  function boot() {
    var viewport = document.getElementById('viewport') || document.querySelector('.presentation-viewport');
    if (!viewport) { console.warn('[presentation-core] 找不到 #viewport，略過初始化'); return; }
    var slidesHost = viewport.querySelector('main.slides') || viewport.querySelector('.slides');
    if (!slidesHost) { console.warn('[presentation-core] 找不到 main.slides，略過初始化'); return; }
    if (viewport.dataset.coreInit === '1') return; // 冪等：避免重複初始化
    viewport.dataset.coreInit = '1';

    var subtitle = viewport.getAttribute('data-subtitle') || '本地優先 AI 開發夥伴 Hana';

    // ── 1. 建立外殼 DOM（deck 不必自帶） ─────────────────────────────
    if (!viewport.querySelector('.grid')) {
      var grid = document.createElement('div'); grid.className = 'grid';
      viewport.insertBefore(grid, viewport.firstChild);
    }
    if (!viewport.querySelector('.progress-wrap')) {
      viewport.insertAdjacentHTML('afterbegin',
        '<div class="progress-wrap"><div class="progress" id="progressBar"></div></div>' +
        '<div class="timer" id="timerBar"></div>');
    }

    var shellHTML =
      '<footer>' +
        '<div class="slide-number" id="slideNumber">Slide 1</div>' +
        '<div class="dots" id="dots"></div>' +
        '<div class="controls">' +
          '<button class="btn" id="prevBtn" title="上一頁">‹</button>' +
          '<button class="btn" id="mainPauseBtn" title="暫停/繼續">⏸</button>' +
          '<button class="btn" id="fullscreenBtn" title="全螢幕播放（全螢幕＋語音）">⛶</button>' +
          '<button class="btn" id="nextBtn" title="下一頁">›</button>' +
        '</div>' +
      '</footer>' +
      '<aside class="tech-panel">' +
        '<div class="tech-title">VOICE / PLAYBACK</div>' +
        '<div class="row"><span>語音</span><select id="voiceSelect"></select></div>' +
        '<div class="row"><span>速度</span><input id="voiceSpeed" type="number" value="1.2" min="0.5" max="1.5" step="0.05"></div>' +
        '<div class="row"><span>自動語音</span><label class="switch"><input id="voicePlayToggle" type="checkbox" checked><span class="slider"></span></label></div>' +
        '<div class="row"><span>自動換頁</span><label class="switch"><input id="autoPlayToggle" type="checkbox"><span class="slider"></span></label></div>' +
        '<div class="row">' +
          '<button class="action" id="btnPlaySpeech">播放語音</button>' +
          '<button class="action" id="btnPauseSpeech">暫停</button>' +
          '<button class="action stop" id="btnStopSpeech">停止</button>' +
        '</div>' +
      '</aside>' +
      '<aside class="drawer" id="transcriptDrawer">' +
        '<button class="drawer-toggle" id="drawerToggleBtn">☰</button>' +
        '<h2>逐字稿</h2><div class="transcript" id="transcriptText"></div>' +
      '</aside>' +
      '<div class="overlay" id="initOverlay">' +
        '<button id="btnStartPlay">開始播放</button>' +
        '<div class="meta">' + subtitle + '</div>' +
      '</div>';
    viewport.insertAdjacentHTML('beforeend', shellHTML);

    // ── 2. 取得元素 ─────────────────────────────────────────────────
    var slides = [].slice.call(slidesHost.querySelectorAll('.slide'));
    var dotsBox = document.getElementById('dots');
    var prevBtn = document.getElementById('prevBtn');
    var nextBtn = document.getElementById('nextBtn');
    var slideNumber = document.getElementById('slideNumber');
    var progressBar = document.getElementById('progressBar');
    var timerBar = document.getElementById('timerBar');
    var transcriptText = document.getElementById('transcriptText');
    var voiceSelect = document.getElementById('voiceSelect');
    var voiceSpeed = document.getElementById('voiceSpeed');
    var voicePlayToggle = document.getElementById('voicePlayToggle');
    var autoPlayToggle = document.getElementById('autoPlayToggle');
    var btnPlaySpeech = document.getElementById('btnPlaySpeech');
    var btnPauseSpeech = document.getElementById('btnPauseSpeech');
    var mainPauseBtn = document.getElementById('mainPauseBtn');
    var initOverlay = document.getElementById('initOverlay');
    var transcriptDrawer = document.getElementById('transcriptDrawer');

    var currentSlide = 0, totalSlides = slides.length, autoPlayInterval = null;
    var audioUnlocked = false, isPresentationMode = false, currentUtterance = null;
    var voices = [], selectedVoice = null, isSpeechPaused = false;
    var _animSkip = false; // guard: skip triggerSlideAnims when navigating backward
    var synth = window.speechSynthesis;

    // ── 3. 縮放 ─────────────────────────────────────────────────────
    function adjustScale() {
      var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
      viewport.style.transform = 'scale(' + s + ')';
    }
    window.addEventListener('resize', adjustScale);
    adjustScale();

    // ── 4. 語音清單 ─────────────────────────────────────────────────
    function pickDefaultVoice(list) {
      return list.find(function (v) { return /Microsoft XiaoYi/i.test(v.name); }) ||
             list.find(function (v) { return /XiaoYi/i.test(v.name); }) ||
             list.find(function (v) { return /Microsoft Yating/i.test(v.name); }) ||
             list.find(function (v) { return /Yating/i.test(v.name); }) ||
             list.find(function (v) { return /zh[-_]TW/i.test(v.lang); }) ||
             list.find(function (v) { return /zh/i.test(v.lang); }) ||
             list[0] || null;
    }
    function populateVoiceList() {
      if (!synth) return;
      voices = synth.getVoices();
      voiceSelect.innerHTML = '';
      var zh = voices.filter(function (v) { return /zh/i.test(v.lang); });
      var all = zh.concat(voices.filter(function (v) { return !/zh/i.test(v.lang); }));
      selectedVoice = pickDefaultVoice(voices);
      all.forEach(function (v) {
        var o = document.createElement('option');
        o.value = v.name;
        o.textContent = (selectedVoice && v.name === selectedVoice.name ? 'Hana - ' : '') + v.name + ' (' + v.lang + ')';
        o.selected = selectedVoice && v.name === selectedVoice.name;
        voiceSelect.appendChild(o);
      });
    }
    populateVoiceList();
    if (synth && synth.onvoiceschanged !== undefined) synth.onvoiceschanged = populateVoiceList;
    function updateSelectedVoice() {
      selectedVoice = voices.find(function (v) { return v.name === voiceSelect.value; });
      stopSpeech();
    }

    // ── 5. 動畫鉤子（PRES-ANIM-01）────────────────────────────────
    // data-anim: 元素進場動畫（auto-reveal with stagger）
    // data-anim-step="N": 手動步進（右鍵依序揭露，不換頁）
    // data-anim-delay="ms": 覆蓋 auto-reveal 的延遲（預設 idx*150+100ms）
    function resetSlideAnims(slide) {
      [].slice.call(slide.querySelectorAll('[data-anim]')).forEach(function(el) {
        el.classList.remove('anim-visible');
      });
      slide._animStep = 0;
    }
    function revealAllAnims(slide) {
      [].slice.call(slide.querySelectorAll('[data-anim]')).forEach(function(el) {
        el.classList.add('anim-visible');
      });
      slide._animStep = getMaxAnimStep(slide);
    }
    function getMaxAnimStep(slide) {
      var steps = [].slice.call(slide.querySelectorAll('[data-anim-step]'))
        .map(function(el) { return parseInt(el.dataset.animStep, 10) || 1; });
      return steps.length ? Math.max.apply(null, steps) : 0;
    }
    function triggerSlideAnims(slide) {
      var autoEls = [].slice.call(slide.querySelectorAll('[data-anim]:not([data-anim-step])'));
      autoEls.forEach(function(el, idx) {
        var delay = parseInt(el.dataset.animDelay || String(idx * 150 + 100), 10);
        setTimeout(function() {
          if (slide.classList.contains('active')) el.classList.add('anim-visible');
        }, delay);
      });
      slide._animStep = 0;
    }
    function advanceAnimStep(slide) {
      var step = (slide._animStep || 0) + 1;
      slide._animStep = step;
      [].slice.call(slide.querySelectorAll('[data-anim-step]')).forEach(function(el) {
        if ((parseInt(el.dataset.animStep, 10) || 1) <= step) el.classList.add('anim-visible');
      });
    }

    // ── 5b. 旁白分段 cue（PRES-CUE，SPEC-presentation-core.md §8）─────────
    // 投影片內放 <script type="application/json" data-cues>[ {say, step, laser, show, count,
    // draw, compare, timeline, pause}, … ]</script>。每個 cue：先做動作 → 唸 say → 停 pause → 下一個。
    // 沒有 data-cues 的頁面完全走舊流程（唸整段 data-transcript）。
    // 狀態可「重建」：任何時候都能 reset 後瞬間套用 cue 0..k（左鍵回上一個 cue、匯出最終畫面都靠它）。
    function parseCues(slide) {
      var tag = slide.querySelector('script[data-cues]');
      if (!tag) return null;
      try {
        var arr = JSON.parse(tag.textContent || '[]');
        if (!Array.isArray(arr) || !arr.length) return null;
        return arr.filter(function (c) { return c && typeof c === 'object'; });
      } catch (e) {
        console.warn('[presentation-core] data-cues JSON 解析失敗，此頁退回舊流程：', e.message);
        return null;
      }
    }
    function slideCues(slide) {
      if (slide._cues === undefined) slide._cues = parseCues(slide);
      return slide._cues;
    }
    function asList(v) { return v == null ? [] : (Array.isArray(v) ? v : [v]); }
    function qsAll(slide, sel) {
      if (!sel) return [];
      try { return [].slice.call(slide.querySelectorAll(sel)); } catch (e) { console.warn('[presentation-core] cue 選擇器無效：', sel); return []; }
    }
    function pct(v, def) { var n = parseFloat(v); return isFinite(n) ? n : def; }

    // 量測元素相對於 slide 的「未縮放」座標。走 offsetParent 鏈（不受 viewport scale 與進場 transform 影響）；
    // SVG 元素沒有 offset* → 改用 getBoundingClientRect 再除以實際縮放倍率。
    function relRect(el, slide) {
      if (el === slide) return { x: 0, y: 0, w: slide.offsetWidth, h: slide.offsetHeight };
      if (el instanceof HTMLElement && el.offsetParent) {
        var x = 0, y = 0, n = el;
        while (n && n !== slide) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
        if (n === slide) return { x: x, y: y, w: el.offsetWidth, h: el.offsetHeight };
      }
      var r = el.getBoundingClientRect(), s = slide.getBoundingClientRect();
      var k = slide.offsetWidth ? (s.width / slide.offsetWidth) || 1 : 1;
      return { x: (r.left - s.left) / k, y: (r.top - s.top) / k, w: r.width / k, h: r.height / k };
    }

    // 雷射筆：紅點＋脈動光圈（circle）／框選（box）／底線（underline）。同頁可多個；下一個 cue 時淡出。
    function clearLasers(slide, instant) {
      [].slice.call(slide.querySelectorAll('.cue-laser')).forEach(function (el) {
        if (instant) { el.remove(); return; }
        el.classList.add('cue-laser-out');
        setTimeout(function () { el.remove(); }, 420);
      });
    }
    function placeLaser(slide, spec) {
      if (typeof spec === 'string') spec = { target: spec };
      var type = spec.type || 'circle';
      var host = spec.target ? slide.querySelector(spec.target) : slide;
      if (!host) { console.warn('[presentation-core] laser 找不到目標：', spec.target); return; }
      var r = relRect(host, slide);
      if (spec.box) { // 相對目標的百分比框
        r = { x: r.x + r.w * pct(spec.box.x, 0) / 100, y: r.y + r.h * pct(spec.box.y, 0) / 100,
              w: r.w * pct(spec.box.w, 100) / 100, h: r.h * pct(spec.box.h, 100) / 100 };
      }
      var el = document.createElement('div');
      el.className = 'cue-laser cue-laser-' + type;
      if (type === 'circle') {
        var d = Math.max(56, Math.min(260, Math.max(r.w, r.h) * 0.9));
        el.style.left = (r.x + r.w / 2 - d / 2) + 'px'; el.style.top = (r.y + r.h / 2 - d / 2) + 'px';
        el.style.width = d + 'px'; el.style.height = d + 'px';
        el.innerHTML = '<i class="cue-laser-dot"></i>';
      } else if (type === 'underline') {
        el.style.left = r.x + 'px'; el.style.top = (r.y + r.h + 4) + 'px'; el.style.width = r.w + 'px';
      } else { // box
        var pad = 8;
        el.style.left = (r.x - pad) + 'px'; el.style.top = (r.y - pad) + 'px';
        el.style.width = (r.w + pad * 2) + 'px'; el.style.height = (r.h + pad * 2) + 'px';
      }
      slide.appendChild(el);
    }

    // 輪播容器 .cue-slides：子元素一次只亮一張（1 起算），淡入淡出。
    function setShow(slide, spec) {
      if (typeof spec === 'string') spec = { target: spec, index: 1 };
      qsAll(slide, spec.target).forEach(function (box) {
        var kids = [].slice.call(box.children);
        var n = Math.max(1, Math.min(kids.length, parseInt(spec.index, 10) || 1));
        kids.forEach(function (k, i) { k.classList.toggle('cue-on', i === n - 1); });
      });
    }
    function resetShows(slide) {
      [].slice.call(slide.querySelectorAll('.cue-slides')).forEach(function (box) {
        [].slice.call(box.children).forEach(function (k, i) { k.classList.toggle('cue-on', i === 0); });
      });
    }

    // 數字滾動 [data-count-to]：可選 data-count-from / data-count-decimals / data-count-prefix / data-count-suffix。
    function fmtCount(el, v) {
      var dec = parseInt(el.dataset.countDecimals || '0', 10) || 0;
      var s = Number(v).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
      return (el.dataset.countPrefix || '') + s + (el.dataset.countSuffix || '');
    }
    function setCount(el, final) {
      if (el._countTimer) { cancelAnimationFrame(el._countTimer); el._countTimer = null; }
      el.textContent = fmtCount(el, final ? pct(el.dataset.countTo, 0) : pct(el.dataset.countFrom, 0));
    }
    function runCount(el, ms) {
      var from = pct(el.dataset.countFrom, 0), to = pct(el.dataset.countTo, 0), t0 = performance.now();
      ms = ms || 1400;
      if (el._countTimer) cancelAnimationFrame(el._countTimer);
      (function tick(now) {
        var p = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - p, 3);
        el.textContent = fmtCount(el, from + (to - from) * e);
        el._countTimer = p < 1 ? requestAnimationFrame(tick) : null;
      })(t0);
    }
    function countTargets(slide, spec) {
      var sel = typeof spec === 'string' ? spec : spec && spec.target;
      return qsAll(slide, sel).reduce(function (acc, el) {
        return acc.concat(el.hasAttribute('data-count-to') ? [el] : [].slice.call(el.querySelectorAll('[data-count-to]')));
      }, []);
    }

    // SVG 逐段畫出：目標可為 path/line/polyline… 或群組（取其內所有幾何）；多個目標依序錯開畫出。
    var DRAW_SEL = 'path,line,polyline,polygon,circle,rect,ellipse';
    function drawGeoms(el) {
      return el.matches && el.matches(DRAW_SEL) ? [el] : [].slice.call(el.querySelectorAll(DRAW_SEL));
    }
    function setDraw(g, drawn, animMs, delayMs) {
      var len = 0;
      try { len = g.getTotalLength ? g.getTotalLength() : 0; } catch (e) {}
      if (!len) len = 2000;
      g.style.strokeDasharray = len;
      if (animMs) {
        g.style.transition = 'none'; g.style.strokeDashoffset = len;
        g.getBoundingClientRect(); // 強制套用起點再開 transition
        g.style.transition = 'stroke-dashoffset ' + animMs + 'ms ease ' + (delayMs || 0) + 'ms';
        g.style.strokeDashoffset = 0;
      } else {
        g.style.transition = 'none';
        g.style.strokeDashoffset = drawn ? 0 : len;
      }
    }
    function resetDraws(slide) {
      [].slice.call(slide.querySelectorAll('.cue-draw')).forEach(function (el) {
        drawGeoms(el).forEach(function (g) { setDraw(g, false); });
      });
    }
    function runDraw(slide, spec, instant) {
      var sel = typeof spec === 'string' ? spec : spec && spec.target;
      var ms = (spec && spec.duration) || 900;
      var i = 0;
      qsAll(slide, sel).forEach(function (el) {
        drawGeoms(el).forEach(function (g) { setDraw(g, true, instant ? 0 : ms, instant ? 0 : (i++) * Math.round(ms * 0.6)); });
      });
    }

    // 前後對照滑桿 .cue-compare（子元素 .cue-before / .cue-after）：--pos 0~100（%），after 從右側蓋上。
    function ensureCompareHandle(box) {
      if (!box.querySelector('.cue-compare-handle')) {
        var h = document.createElement('i'); h.className = 'cue-compare-handle'; box.appendChild(h);
      }
    }
    function setCompare(slide, spec, instant) {
      qsAll(slide, spec.target || '.cue-compare').forEach(function (box) {
        ensureCompareHandle(box);
        box.classList.toggle('cue-instant', !!instant);
        box.style.setProperty('--pos', pct(spec.pos, 50) + '%');
      });
    }
    function resetCompares(slide) {
      [].slice.call(slide.querySelectorAll('.cue-compare')).forEach(function (box) {
        ensureCompareHandle(box);
        box.classList.add('cue-instant');
        box.style.setProperty('--pos', pct(box.dataset.pos, 100) + '%');
      });
    }

    // 時間軸 .cue-timeline（子元素 .tl-item）：at=N → 前 N-1 格 done、第 N 格 current，進度條推到該格。
    function setTimeline(slide, spec) {
      qsAll(slide, spec.target || '.cue-timeline').forEach(function (box) {
        var items = [].slice.call(box.querySelectorAll('.tl-item'));
        var at = Math.max(0, Math.min(items.length, parseInt(spec.at, 10) || 0));
        items.forEach(function (it, i) {
          it.classList.toggle('tl-done', i < at - 1);
          it.classList.toggle('tl-current', i === at - 1);
        });
        var fill = box.querySelector('.tl-fill');
        if (!fill) { fill = document.createElement('i'); fill.className = 'tl-fill'; box.insertBefore(fill, box.firstChild); }
        var p = items.length > 1 ? Math.max(0, at - 1) / (items.length - 1) * 100 : (at ? 100 : 0);
        box.style.setProperty('--tl-progress', p + '%');
      });
    }
    function resetTimelines(slide) { setTimeline(slide, { at: 0 }); }

    function revealStepUpTo(slide, n) {
      [].slice.call(slide.querySelectorAll('[data-anim-step]')).forEach(function (el) {
        el.classList.toggle('anim-visible', (parseInt(el.dataset.animStep, 10) || 1) <= n);
      });
      slide._animStep = n;
    }

    function resetCueState(slide) {
      if (!slideCues(slide)) return;
      clearLasers(slide, true);
      revealStepUpTo(slide, 0);
      resetShows(slide);
      [].slice.call(slide.querySelectorAll('[data-count-to]')).forEach(function (el) { setCount(el, false); });
      resetDraws(slide);
      resetCompares(slide);
      resetTimelines(slide);
      slide._cueIdx = -1;
    }
    // 套用單一 cue 的「畫面動作」（不含發聲）。instant=true → 不跑動畫直接到終態（重建／匯出用）。
    function applyCueAction(slide, cue, instant) {
      clearLasers(slide, instant);
      if (cue.step != null) revealStepUpTo(slide, Math.max(slide._animStep || 0, parseInt(cue.step, 10) || 0));
      asList(cue.show).forEach(function (s) { setShow(slide, s); });
      asList(cue.count).forEach(function (s) {
        countTargets(slide, s).forEach(function (el) { instant ? setCount(el, true) : runCount(el, s && s.duration); });
      });
      asList(cue.draw).forEach(function (s) { runDraw(slide, s, instant); });
      asList(cue.compare).forEach(function (s) { setCompare(slide, typeof s === 'number' ? { pos: s } : s, instant); });
      asList(cue.timeline).forEach(function (s) { setTimeline(slide, typeof s === 'number' ? { at: s } : s); });
      if (!instant) asList(cue.laser).forEach(function (s) { placeLaser(slide, s); });
    }
    // 重建到第 k 個 cue 的狀態：reset 後 0..k-1 瞬間套用、第 k 個依 animateLast 決定是否跑動畫。
    function rebuildCues(slide, k, animateLast) {
      var cues = slideCues(slide);
      if (!cues) return;
      resetCueState(slide);
      k = Math.min(k, cues.length - 1);
      for (var i = 0; i <= k; i++) applyCueAction(slide, cues[i], !(animateLast && i === k));
      if (k >= 0 && !animateLast) asList(cues[k].laser).forEach(function (s) { placeLaser(slide, s); });
      slide._cueIdx = k;
    }
    // 沒有 cue 的頁：數字 [data-count-to] 在進場時自動滾動，SVG .cue-draw 自動畫出（讓元件不寫 cue 也能用）。
    function autoAnimateNonCue(slide) {
      if (slideCues(slide)) return;
      [].slice.call(slide.querySelectorAll('[data-count-to]')).forEach(function (el) { setCount(el, false); runCount(el); });
      resetDraws(slide);
      [].slice.call(slide.querySelectorAll('.cue-draw')).forEach(function (el, i) {
        drawGeoms(el).forEach(function (g) { setDraw(g, true, 900, i * 500); });
      });
      resetTimelines(slide); resetShows(slide); resetCompares(slide);
    }
    function finalizeSlide(slide) { // 匯出用：全部 cue 執行完的最終畫面
      var cues = slideCues(slide);
      revealAllAnims(slide);
      if (cues) { rebuildCues(slide, cues.length - 1, false); clearLasers(slide, true); }
      else {
        [].slice.call(slide.querySelectorAll('[data-count-to]')).forEach(function (el) { setCount(el, true); });
        [].slice.call(slide.querySelectorAll('.cue-draw')).forEach(function (el) { drawGeoms(el).forEach(function (g) { setDraw(g, true); }); });
      }
    }
    function cueTranscript(slide) {
      var cues = slideCues(slide);
      return cues ? cues.map(function (c) { return c.say || ''; }).join('') : '';
    }

    // ── 6. 投影片切換 ───────────────────────────────────────────────
    slides.forEach(function (_, i) {
      var d = document.createElement('div');
      d.className = 'dot' + (i === 0 ? ' active' : '');
      d.addEventListener('click', function () { goToSlide(i); });
      dotsBox.appendChild(d);
    });
    var dots = [].slice.call(dotsBox.querySelectorAll('.dot'));
    function updateSlideUI() {
      slides.forEach(function (s, i) {
        s.classList.toggle('active', i === currentSlide);
        s.classList.toggle('previous-slide', i < currentSlide);
      });
      dots.forEach(function (d, i) { d.classList.toggle('active', i === currentSlide); });
      prevBtn.disabled = currentSlide === 0;
      nextBtn.disabled = currentSlide === totalSlides - 1;
      slideNumber.textContent = 'Slide ' + (currentSlide + 1) + ' of ' + totalSlides;
      progressBar.style.width = (totalSlides > 1 ? (currentSlide / (totalSlides - 1)) * 100 : 100) + '%';
      transcriptText.innerHTML = '<p>' + slideTranscript(currentSlide) + '</p>';
      if (!_animSkip) {
        triggerSlideAnims(slides[currentSlide]);
        if (slideCues(slides[currentSlide])) rebuildCues(slides[currentSlide], 0, true); // 進場即套用第一個 cue 的畫面
        else autoAnimateNonCue(slides[currentSlide]);
      }
      resetAutoPlayTimer();
      if ((voicePlayToggle.checked || isPresentationMode) && audioUnlocked) setTimeout(speakCurrentSlide, 350);
    }
    // 逐字稿來源：優先 data-transcript，相容舊 deck 的 data-notes
    function slideTranscript(i) { var s = slides[i]; return (s.dataset.transcript || s.dataset.notes || cueTranscript(s)); }
    // 朗讀前淨化：把會被 TTS 唸出的分隔符號（半/全形 / \ |）換成空白，避免唸成「斜線」。
    // 只作用於「發聲文字」，不影響抽屜顯示的逐字稿；單次 regex/張，效能可忽略。
    // 委派給共用的發聲正規化器（符號 + 同音字表）；未載入時退回原本的符號淨化。
    function ttsSanitize(t) {
      if (typeof window !== 'undefined' && window.ttsNormalize) return window.ttsNormalize(t);
      return String(t || '').replace(/[\/／\\＼|｜]+/g, ' ').replace(/ {2,}/g, ' ').trim();
    }
    function goToSlide(i) {
      if (i < 0 || i >= totalSlides) return;
      stopSpeech();
      resetSlideAnims(slides[currentSlide]);
      resetCueState(slides[currentSlide]);
      currentSlide = i;
      updateSlideUI();
    }
    function voiceActive() { return (voicePlayToggle.checked || isPresentationMode) && audioUnlocked; }
    function nextSlide() {
      var slide = slides[currentSlide];
      var cues = slideCues(slide);
      if (cues) {
        // PRES-CUE 手動步進：右鍵／空白＝下一個 cue；有語音就從那個 cue 接著唸，沒語音就只看動畫。
        var k = (slide._cueIdx == null ? -1 : slide._cueIdx) + 1;
        if (k < cues.length) {
          clearAutoPlayTimer();
          if (voiceActive()) runCues(k); else { stopSpeech(); applyCueAction(slide, cues[k], false); slide._cueIdx = k; }
          return;
        }
      } else if ((slide._animStep || 0) < getMaxAnimStep(slide)) {
        advanceAnimStep(slide);
        return;
      }
      currentSlide < totalSlides - 1 ? goToSlide(currentSlide + 1) : (clearAutoPlayTimer(), stopSpeech());
    }
    function prevSlide() {
      var cur = slides[currentSlide];
      if (slideCues(cur) && (cur._cueIdx || 0) > 0) { // 左鍵＝回上一個 cue 的狀態（不換頁、不唸）
        stopSpeech(); clearAutoPlayTimer();
        rebuildCues(cur, cur._cueIdx - 1, false);
        return;
      }
      if (currentSlide <= 0) return;
      stopSpeech();
      resetSlideAnims(cur);
      resetCueState(cur);
      currentSlide -= 1;
      revealAllAnims(slides[currentSlide]);
      if (slideCues(slides[currentSlide])) rebuildCues(slides[currentSlide], slides[currentSlide]._cues.length - 1, false);
      _animSkip = true;
      updateSlideUI();
      _animSkip = false;
    }

    // ── 7. TTS ──────────────────────────────────────────────────────
    // PRES-CUE 播放鏈：cue k 動作 → 唸 say → 停 pause（預設 600ms）→ cue k+1 …；全部唸完停 1.5 秒換頁。
    // cueRun 是「這一輪」的令牌：stopSpeech() 會換掉它，舊一輪的 onend／計時器看到令牌不符就自動作廢。
    var cueRun = null;
    function cueGapMs(cue) { var p = parseInt(cue.pause, 10); return isFinite(p) && p >= 0 ? p : 600; }
    function runCues(startIdx) {
      var slide = slides[currentSlide], cues = slideCues(slide);
      if (!cues) return;
      stopSpeech();
      var run = cueRun = { timer: null };
      btnPlaySpeech.textContent = '播放中';
      function step(k) {
        if (run !== cueRun) return;
        if (k >= cues.length) {
          cueRun = null;
          btnPlaySpeech.textContent = '播放語音';
          if ((autoPlayToggle.checked || isPresentationMode) && currentSlide < totalSlides - 1) startShortCountdown(1500);
          return;
        }
        var cue = cues[k];
        if (slide._cueIdx !== k) { applyCueAction(slide, cue, false); slide._cueIdx = k; }
        else if (k === startIdx && !slide.querySelector('.cue-laser:not(.cue-laser-out)')) { asList(cue.laser).forEach(function (s) { placeLaser(slide, s); }); }
        function afterSay() {
          if (run !== cueRun) return;
          (function wait(ms) {
            run.timer = setTimeout(function () {
              if (run !== cueRun) return;
              if (isSpeechPaused) return wait(200); // 停頓中按了暫停：等繼續
              step(k + 1);
            }, ms);
          })(cueGapMs(cue));
        }
        var text = ttsSanitize(cue.say || '');
        if (!text || !synth) { afterSay(); return; }
        var u = new SpeechSynthesisUtterance(text);
        currentUtterance = u;
        if (selectedVoice) u.voice = selectedVoice;
        u.lang = selectedVoice ? selectedVoice.lang : 'zh-TW';
        u.rate = parseFloat(voiceSpeed.value || '1.2');
        u.onend = function () { if (u === currentUtterance) afterSay(); };
        u.onerror = function (e) {
          if (e.error === 'interrupted' || e.error === 'canceled') return;
          if (u === currentUtterance) afterSay(); // 單段發聲失敗不卡死整頁
        };
        synth.speak(u); // hana-overlay.js 的 hook 照常套用全域語音＋頭像 talk/idle（每段一次）
      }
      step(startIdx);
    }
    // 沒有語音、但開了自動換頁：cue 依字數估時間自動推進（約每字 0.22 秒÷語速，最少 1.5 秒）＋ pause。
    function runCuesSilent(startIdx) {
      var slide = slides[currentSlide], cues = slideCues(slide);
      if (!cues) return;
      stopSpeech();
      var run = cueRun = { timer: null };
      var rate = parseFloat(voiceSpeed.value || '1.2') || 1.2;
      (function step(k) {
        if (run !== cueRun) return;
        if (k >= cues.length) { cueRun = null; if (currentSlide < totalSlides - 1) startShortCountdown(1500); return; }
        if (slide._cueIdx !== k) { applyCueAction(slide, cues[k], false); slide._cueIdx = k; }
        var ms = Math.max(1500, Math.round((cues[k].say || '').length * 220 / rate)) + cueGapMs(cues[k]);
        (function wait(t) {
          run.timer = setTimeout(function () { if (run !== cueRun) return; if (isSpeechPaused) return wait(200); step(k + 1); }, t);
        })(ms);
      })(startIdx);
    }

    function speakCurrentSlide() {
      if (!synth) return;
      var cs = slides[currentSlide];
      if (slideCues(cs)) { runCues(Math.max(0, cs._cueIdx || 0)); return; }
      stopSpeech();
      var text = ttsSanitize(slideTranscript(currentSlide));
      if (!text) return;
      var u = new SpeechSynthesisUtterance(text);
      currentUtterance = u;
      if (selectedVoice) u.voice = selectedVoice;
      u.lang = selectedVoice ? selectedVoice.lang : 'zh-TW';
      u.rate = parseFloat(voiceSpeed.value || '1.2');
      btnPlaySpeech.textContent = '播放中';
      u.onend = function () {
        if (u !== currentUtterance) return;
        btnPlaySpeech.textContent = '播放語音';
        if ((autoPlayToggle.checked || isPresentationMode) && currentSlide < totalSlides - 1) startShortCountdown(1500);
      };
      u.onerror = function (e) {
        if (e.error === 'interrupted' || e.error === 'canceled') return;
        btnPlaySpeech.textContent = '播放語音';
      };
      synth.speak(u); // hana-overlay.js 會在此 hook，套用全域語音 + 頭像 talk/idle
    }
    function togglePauseSpeech() {
      if (!synth) return;
      if ((synth.speaking || cueRun) && !isSpeechPaused) {
        if (synth.speaking) synth.pause();
        isSpeechPaused = true;
        if (btnPauseSpeech) btnPauseSpeech.textContent = '繼續';
        if (mainPauseBtn) mainPauseBtn.textContent = '⏵';
      } else if (isSpeechPaused) {
        synth.resume(); isSpeechPaused = false;
        if (btnPauseSpeech) btnPauseSpeech.textContent = '暫停';
        if (mainPauseBtn) mainPauseBtn.textContent = '⏸';
      }
    }
    function stopSpeech() {
      if (cueRun) { clearTimeout(cueRun.timer); cueRun = null; }
      if (synth) synth.cancel();
      currentUtterance = null; isSpeechPaused = false;
      btnPlaySpeech.textContent = '播放語音';
      if (btnPauseSpeech) btnPauseSpeech.textContent = '暫停';
      if (mainPauseBtn) mainPauseBtn.textContent = '⏸';
    }

    // ── 8. 自動換頁 ─────────────────────────────────────────────────
    function resetAutoPlayTimer() {
      clearAutoPlayTimer();
      var cs = slides[currentSlide];
      if (currentSlide === totalSlides - 1 && !slideCues(cs)) return;
      if (!(autoPlayToggle.checked || isPresentationMode)) return;
      if ((voicePlayToggle.checked || isPresentationMode) && audioUnlocked) return; // 有語音時靠 onend 推進
      if (slideCues(cs)) { runCuesSilent(Math.max(0, cs._cueIdx || 0)); return; } // PRES-CUE：無語音也照 cue 節奏推進
      startShortCountdown(10000);
    }
    function startShortCountdown(ms) {
      clearAutoPlayTimer();
      timerBar.classList.add('active');
      var e = 0;
      autoPlayInterval = setInterval(function () {
        e += 50; timerBar.style.width = (e / ms * 100) + '%';
        if (e >= ms) { clearAutoPlayTimer(); nextSlide(); }
      }, 50);
    }
    function clearAutoPlayTimer() {
      if (autoPlayInterval) clearInterval(autoPlayInterval);
      autoPlayInterval = null;
      timerBar.style.width = '0%';
      timerBar.classList.remove('active');
    }

    // ── 9. 全螢幕 / 簡報模式 ────────────────────────────────────────
    // iframe 模式（跑在 Portal 的簡報 host 內）：全螢幕改委由外層 deck.js 對 #deck-fit-wrap 請求，
    // 不對自己的 document.documentElement 請求——因為「下一集/跳集」會整份摧毀重建 iframe 內的
    // document，任何綁在「這份」document 上的全螢幕狀態都會被瀏覽器自動退出（這正是換頁後全螢幕
    // 消失的根因）；綁在外層永遠不會被摧毀的 document 上，才能撐過換頁。非 iframe（raw/file 模式、
    // 獨立分頁）沒有外層可托管，仍對自己請求（但獨立分頁的「換頁」本身就是整分頁重載，瀏覽器基於
    // 安全限制本來就不允許頁面重載後自動恢復全螢幕，這是平台限制、非本檔能繞過的）。
    function inIframeMode() {
      return !!(window.parent && window.parent !== window && typeof window.parent.loadFile === 'function');
    }
    function isFullscreenActive() {
      if (inIframeMode() && typeof window.parent.isPresentationFullscreen === 'function') return window.parent.isPresentationFullscreen();
      return !!document.fullscreenElement;
    }
    function requestFS() {
      if (inIframeMode() && typeof window.parent.presentationEnterFullscreen === 'function') { window.parent.presentationEnterFullscreen(); return; }
      if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(function () {});
    }
    function exitFS() {
      if (inIframeMode() && typeof window.parent.presentationExitFullscreen === 'function') { window.parent.presentationExitFullscreen(); return; }
      if (document.exitFullscreen) document.exitFullscreen();
    }
    function unlockAudioAndStart() {
      audioUnlocked = true;
      initOverlay.classList.add('hidden');
      updateSelectedVoice();
      speakCurrentSlide();
    }
    function toggleFullScreen() {
      isFullscreenActive() ? exitFS() : requestFS();
    }
    function enterPresentationMode() {
      isPresentationMode = true;
      document.body.classList.add('presentation-mode');
      audioUnlocked = true;
      initOverlay.classList.add('hidden');
      if (!isFullscreenActive()) requestFS();
      speakCurrentSlide();
      setTimeout(adjustScale, 100);
    }
    function exitPresentationMode() {
      isPresentationMode = false;
      document.body.classList.remove('presentation-mode');
      stopSpeech(); clearAutoPlayTimer();
      setTimeout(adjustScale, 100);
    }
    // ⛶ 一顆搞定：非全螢幕 → 進「全螢幕播放」(fullscreen ＋ 語音)；已全螢幕 → 退出。
    function togglePresentMode() {
      if (isFullscreenActive() || isPresentationMode) {
        if (isFullscreenActive()) exitFS();
        else exitPresentationMode();
      } else {
        enterPresentationMode();
      }
    }
    document.addEventListener('fullscreenchange', function () {
      if (!document.fullscreenElement && isPresentationMode) exitPresentationMode();
    });
    // 讓外層 deck.js 在偵測到瀏覽器原生退出全螢幕（如按 ESC）時，能反過來通知這份 iframe 同步收尾 UI。
    window.__hanaExitPresentationMode = exitPresentationMode;
    window.__hanaEnterPresentationMode = enterPresentationMode;

    function toggleTranscriptDrawer() { transcriptDrawer.classList.toggle('open'); }

    // ── 10. 事件接線（無 inline onclick，無全域污染） ────────────────
    prevBtn.addEventListener('click', prevSlide);
    nextBtn.addEventListener('click', nextSlide);
    mainPauseBtn.addEventListener('click', togglePauseSpeech);
    document.getElementById('fullscreenBtn').addEventListener('click', togglePresentMode);
    voiceSelect.addEventListener('change', updateSelectedVoice);
    voicePlayToggle.addEventListener('change', resetAutoPlayTimer);
    autoPlayToggle.addEventListener('change', resetAutoPlayTimer);
    btnPlaySpeech.addEventListener('click', speakCurrentSlide);
    btnPauseSpeech.addEventListener('click', togglePauseSpeech);
    document.getElementById('btnStopSpeech').addEventListener('click', stopSpeech);
    document.getElementById('drawerToggleBtn').addEventListener('click', toggleTranscriptDrawer);
    document.getElementById('btnStartPlay').addEventListener('click', unlockAudioAndStart);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); nextSlide(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); prevSlide(); }
      else if (e.key.toLowerCase() === 'f') toggleFullScreen();
      else if (e.key === 'Escape' && isPresentationMode) exitPresentationMode();
      else if (e.key.toLowerCase() === 'p') speakCurrentSlide();
      else if (e.key.toLowerCase() === 's') stopSpeech();
    });

    // 目前 deck 所在目錄：從自己被載入的 ?path= 反推（iframe / raw 模式都經 /raw?path=<dir>/<file>.html 載入），
    // 讓 v1（presentations/）與 v2（presentations-v2/）都能正確接續，不寫死目錄。
    function currentDeckDir() {
      try {
        var p = new URLSearchParams(window.location.search).get('path');
        if (p) {
          var idx = p.lastIndexOf('/');
          if (idx >= 0) return p.slice(0, idx + 1);
        }
      } catch (e) {}
      return 'presentations/';
    }

    // 換集導覽（下一集連結 / 跳章選單）共用同一個入口：換頁前若正在全螢幕播放中，帶著
    // resume=1 過去，讓新頁面一啟動就自動接續全螢幕＋語音（見下方 boot 尾端與 deck.js 的
    // presentationEnterFullscreen 配合）。曝露到 window 上是因為各集 deck 檔的跳章選單目前用
    // inline onclick（非 module，無法 import），只能靠這個全域橋接。
    function gotoDeck(href) {
      var dir = currentDeckDir();
      var resuming = isPresentationMode || isFullscreenActive();
      if (window.parent && typeof window.parent.loadFile === 'function') {
        window.parent.loadFile(dir + href, undefined, null, resuming);
      } else {
        var u = new URLSearchParams(window.location.search);
        var suffix = 'resume=' + (resuming ? '1' : '0');
        if (u.has('path')) window.location.search = '?path=' + encodeURIComponent(dir + href) + '&' + suffix;
        else window.location.href = href + (href.indexOf('?') >= 0 ? '&' : '?') + suffix;
      }
    }
    window.__hanaGotoDeck = gotoDeck;

    // PRES-CUE 對外介面（匯出 pptx／錄影 mp4／自測用；render-service/screenshot.js 會呼叫）。
    window.__presCore = {
      cues: function (i) { var c = slides[i] && slideCues(slides[i]); return c ? JSON.parse(JSON.stringify(c)) : null; },
      finalizeSlide: function (i) { if (slides[i]) finalizeSlide(slides[i]); },     // 全部 cue 執行完的最終畫面（不含雷射筆）
      cueState: function (i, k) { // 瞬間重建到第 k 個 cue（含該 cue 的雷射筆；非 step 的進場元素一律顯示）
        var s = slides[i]; if (!s) return;
        [].slice.call(s.querySelectorAll('[data-anim]:not([data-anim-step])')).forEach(function (el) { el.classList.add('anim-visible'); });
        rebuildCues(s, k, false);
      },
      current: function () { var s = slides[currentSlide]; return { slide: currentSlide, cue: s._cueIdx == null ? -1 : s._cueIdx, step: s._animStep || 0, playing: !!cueRun }; },
    };

    // 「下一集」連結（舊命名格式 presentation-hana-episode*.html，v1/v2 deck 用）：iframe 模式用
    // parent.loadFile；raw 模式更新 query；否則直接跳轉。v3 deck 的跳章選單改呼叫 window.__hanaGotoDeck。
    document.addEventListener('click', function (e) {
      var a = e.target.closest('a');
      if (!a || !a.getAttribute('href')) return;
      var h = a.getAttribute('href');
      if (h.indexOf('presentation-hana-episode') !== 0) return;
      e.preventDefault();
      gotoDeck(h);
    });

    // 若由「下一集/跳章」帶著 resume=1 導覽過來（換頁前正在全螢幕播放），此頁一啟動就接續播放，
    // 不需要使用者重新點「開始播放」或重按 ⛶。
    try {
      if (new URLSearchParams(window.location.search).get('resume') === '1') enterPresentationMode();
    } catch (e) {}

    updateSlideUI();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

// Sidebar Card Carousel (SPEC-sidebar-card-carousel.md §3/§4/§8).
//
// Owns everything inside #sb-carousel EXCEPT the pre-existing #wt-card markup (that markup, and
// its ids/bindings — #sprint-badge/#progress-bar/#menu-dashboard/#worktable-tree/etc — are left
// completely untouched; #wt-card's enclosing slide is simply treated as the "worktable" card's
// already-mounted DOM).
//
// Card module contract (D1, §4): a card module exports `card` ({id,title,icon}), `mount(container,
// ctx)`, `unmount()`. `ctx` is { workspace, apiFetch } — apiFetch is window.apiFetch (already
// wrapped to attach X-Workspace, per index.html's wrapGlobalFetch).
//
// Built-in cards: 'worktable' (static, already in the DOM) and 'quota:<providerId>' (dynamically
// generated from GET /api/model-quota's providers[]). Plugin cards ('plugin:<name>:<cardId>') are
// registered by index.html/reloadShell() after reading /api/status's plugins[].cards.
(function () {
  'use strict';

  // ---- registry -------------------------------------------------------------------------------
  // Map<id, { id, title, icon, isStatic, mount, unmount }>
  const registry = new Map();
  // Map<id, { slideEl, innerEl, failed, unmountFn }>
  const mounted = new Map();

  let ctx = { workspace: '', apiFetch: (window.apiFetch || window.fetch) };
  let settings = { rotateSeconds: 8, quotaRefreshSeconds: 300, hidden: [], order: [] };
  let activeIndex = 0;
  let timer = null;
  let hoverPaused = false;
  let focusPaused = false;
  let collapseObserver = null;
  let built = false; // true once mountAll() has run at least once

  function qs(id) { return document.getElementById(id); }
  function trackEl() { return qs('sb-carousel-track'); }
  function dotsEl() { return qs('sb-carousel-dots'); }
  function rootEl() { return qs('sb-carousel'); }

  function prefersReducedMotion() {
    try { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (e) { return false; }
  }

  function isSidebarCollapsed() {
    const sb = qs('sidebar');
    return !!(sb && sb.classList.contains('sidebar-collapsed'));
  }

  function withTimeout(promise, ms) {
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`逾時（${ms}ms 內未回應）`)), ms)),
    ]);
  }

  function escapeHtml(s) {
    return window.escapeHtml ? window.escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---- public: registration ---------------------------------------------------------------------
  // def: { id, title, icon, isStatic, mount(container, ctx), unmount() }
  function registerCard(def) {
    if (!def || !def.id) return;
    registry.set(def.id, def);
  }
  function unregisterCard(id) { registry.delete(id); }
  function clearRegistry() {
    // keep 'worktable' (always built-in, never user-contributed) — callers that rebuild the quota/
    // plugin cards call this before re-registering those, not before touching worktable.
    for (const id of Array.from(registry.keys())) {
      if (id !== 'worktable') registry.delete(id);
    }
  }

  // ---- ordering (§3.2) ---------------------------------------------------------------------------
  function visibleOrderedIds() {
    const all = Array.from(registry.keys());
    const order = Array.isArray(settings.order) ? settings.order.filter(id => all.includes(id)) : [];
    const rest = all.filter(id => !order.includes(id));
    const full = order.concat(rest);
    const hidden = new Set(Array.isArray(settings.hidden) ? settings.hidden : []);
    return full.filter(id => !hidden.has(id));
  }

  // ---- mount/unmount one card's slide -------------------------------------------------------------
  async function mountOne(id) {
    const def = registry.get(id);
    if (!def) return null;
    if (id === 'worktable') {
      // Already in the DOM (index.html). Just locate it.
      const existing = document.querySelector('.sb-carousel-slide[data-card-id="worktable"]');
      if (existing) { mounted.set(id, { slideEl: existing, innerEl: existing, failed: false, unmountFn: null }); return existing; }
    }
    const slide = document.createElement('div');
    slide.className = 'sb-carousel-slide';
    slide.setAttribute('data-card-id', id);
    const inner = document.createElement('div');
    inner.className = 'sb-card-inner p-4 rounded-xl glass-card';
    slide.appendChild(inner);
    trackEl().appendChild(slide);

    let failed = false;
    try {
      await withTimeout(Promise.resolve().then(() => def.mount(inner, ctx)), 3000);
    } catch (err) {
      failed = true;
      inner.innerHTML = '<div class="text-[11px] text-red-500 dark:text-red-400 py-1">這張卡載入失敗：'
        + escapeHtml((err && err.message) || String(err)) + '</div>';
    }
    // bind to `def` so a card whose unmount() reads state it stashed on `this` during mount()
    // (the same call-as-a-method pattern def.mount(...) already uses) keeps working once detached.
    mounted.set(id, { slideEl: slide, innerEl: inner, failed, unmountFn: def.unmount ? def.unmount.bind(def) : null });
    return slide;
  }

  function unmountOne(id) {
    const m = mounted.get(id);
    if (!m) return;
    if (id !== 'worktable') {
      try { if (typeof m.unmountFn === 'function') m.unmountFn(); } catch (e) { /* never let a broken card's unmount wedge the rest */ }
      if (m.slideEl && m.slideEl.parentNode) m.slideEl.parentNode.removeChild(m.slideEl);
    }
    mounted.delete(id);
  }

  function unmountAll() {
    for (const id of Array.from(mounted.keys())) unmountOne(id);
  }

  // ---- dots / arrows -------------------------------------------------------------------------------
  function renderDots(ids) {
    const dots = dotsEl();
    if (!dots) return;
    if (ids.length <= 1) { dots.innerHTML = ''; dots.classList.add('hidden'); return; }
    dots.classList.remove('hidden');
    dots.innerHTML = ids.map((id, i) => `<button class="sb-carousel-dot${i === activeIndex ? ' active' : ''}" data-dot-idx="${i}" aria-label="第 ${i + 1} 張"></button>`).join('');
    dots.querySelectorAll('[data-dot-idx]').forEach(btn => {
      btn.addEventListener('click', () => goTo(parseInt(btn.getAttribute('data-dot-idx'), 10), true));
    });
  }

  function updateArrowVisibility(ids) {
    const prev = qs('sb-carousel-prev');
    const next = qs('sb-carousel-next');
    const multi = ids.length > 1;
    if (prev) prev.classList.toggle('hidden', !multi);
    if (next) next.classList.toggle('hidden', !multi);
  }

  function currentIds() {
    return Array.from(trackEl() ? trackEl().querySelectorAll('.sb-carousel-slide') : []).map(el => el.getAttribute('data-card-id'));
  }

  function showIndex(idx) {
    const slides = trackEl() ? Array.from(trackEl().querySelectorAll('.sb-carousel-slide')) : [];
    if (!slides.length) return;
    activeIndex = ((idx % slides.length) + slides.length) % slides.length;
    const reduced = prefersReducedMotion();
    slides.forEach((el, i) => {
      // Inactive slides stay laid out (CSS visibility:hidden, stacked in one grid cell) so the
      // carousel keeps the tallest card's height and the sidebar menu below doesn't jump.
      el.classList.toggle('sb-carousel-slide-active', i === activeIndex);
      el.style.display = '';
      el.setAttribute('aria-hidden', i === activeIndex ? 'false' : 'true');
    });
    renderDots(slides.map(el => el.getAttribute('data-card-id')));
    updateArrowVisibility(slides);
  }

  function goTo(idx, manual) {
    showIndex(idx);
    if (manual) resetTimer();
  }
  function next(manual) { goTo(activeIndex + 1, manual); }
  function prev(manual) { goTo(activeIndex - 1, manual); }

  // ---- autoplay timer (D5/D10/§8) ------------------------------------------------------------------
  function shouldAutoplay() {
    if (settings.rotateSeconds <= 0) return false;
    if (hoverPaused || focusPaused) return false;
    if (isSidebarCollapsed()) return false;
    if (prefersReducedMotion()) return false; // §8: respect reduced-motion — no timed auto-advance either
    const slides = trackEl() ? trackEl().querySelectorAll('.sb-carousel-slide') : [];
    if (slides.length <= 1) return false;
    return true;
  }

  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }
  function startTimer() {
    stopTimer();
    if (!shouldAutoplay()) return;
    timer = setInterval(() => { next(false); }, Math.max(3, settings.rotateSeconds) * 1000);
  }
  function resetTimer() { stopTimer(); startTimer(); }

  function bindHoverFocus() {
    const root = rootEl();
    if (!root || root._sbcBound) return;
    root._sbcBound = true;
    root.addEventListener('mouseenter', () => { hoverPaused = true; stopTimer(); });
    root.addEventListener('mouseleave', () => { hoverPaused = false; startTimer(); });
    root.addEventListener('focusin', () => { focusPaused = true; stopTimer(); });
    root.addEventListener('focusout', () => { focusPaused = false; startTimer(); });
    const prevBtn = qs('sb-carousel-prev');
    const nextBtn = qs('sb-carousel-next');
    if (prevBtn) prevBtn.addEventListener('click', () => prev(true));
    if (nextBtn) nextBtn.addEventListener('click', () => next(true));
  }

  function watchCollapse() {
    if (collapseObserver) return;
    const sb = qs('sidebar');
    if (!sb || !window.MutationObserver) return;
    collapseObserver = new MutationObserver(() => {
      if (isSidebarCollapsed()) stopTimer(); else startTimer();
    });
    collapseObserver.observe(sb, { attributes: true, attributeFilter: ['class'] });
  }

  // ---- full (re)build ------------------------------------------------------------------------------
  async function mountAll(opts) {
    if (opts && opts.settings) settings = Object.assign({ rotateSeconds: 8, quotaRefreshSeconds: 300, hidden: [], order: [] }, opts.settings);
    if (opts && opts.ctx) ctx = opts.ctx;

    // Tear down everything currently mounted (except the static worktable slide, which is never
    // removed from the DOM — only hidden/shown) before rebuilding, per §8 "重新套用設定時先卸載再重建".
    unmountAll();
    const dots = dotsEl(); if (dots) dots.innerHTML = '';

    const ids = visibleOrderedIds();
    for (const id of ids) {
      await mountOne(id);
    }
    activeIndex = 0;
    showIndex(0);
    bindHoverFocus();
    watchCollapse();
    resetTimer();
    built = true;
  }

  function destroyAll() {
    stopTimer();
    unmountAll();
    const track = trackEl();
    if (track) Array.from(track.querySelectorAll('.sb-carousel-slide')).forEach(el => {
      if (el.getAttribute('data-card-id') !== 'worktable') el.remove();
    });
    built = false;
  }

  window.sbCardCarousel = {
    registerCard,
    unregisterCard,
    clearRegistry,
    mountAll,
    destroyAll,
    goTo,
    next,
    prev,
    // test/debug hooks
    _visibleOrderedIds: visibleOrderedIds,
    _isSidebarCollapsed: isSidebarCollapsed,
  };
})();

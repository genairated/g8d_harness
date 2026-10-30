// 回報給 Hana — 殼層錄製器（SPEC-issue-report.md §5.1，IR1-2）。classic <script>，需先載入 /vendor/rrweb/rrweb.umd.min.js。
// 平常只放記憶體、不寫檔、不連網（唯一連網是啟動後讀一次 /api/issues/config 取「保留幾分鐘」，不阻擋開錄）。
// 緩衝＝以 checkout（完整畫面重拍）為邊界切段，丟掉過舊的段，保證保留下來的開頭一定是完整畫面。
// 本檔任何一處出錯都不得影響平台：全部 try/catch，失敗就靜默停錄並在 console 留一行警告。
(function () {
  'use strict';
  if (window.IssueRecorder) return;

  var DEFAULT_MIN = 3, CHECKOUT_MS = 60000, MAX_REQ = 30, MAX_ERR = 50, MAX_STACK = 4096, MAX_BODY = 2048, MAX_PENDING = 50, LIVE_TIMEOUT_MS = 10000;
  var st = { running: false, failed: false, segs: [], dropped: false, errors: [], requests: [], stopRec: null, live: false, liveAt: 0, failReason: '', pending: [], customErrors: 0, liveTimer: null, bufferMs: DEFAULT_MIN * 60000, checkoutMs: CHECKOUT_MS, opts: {} };
  var origConsoleError = null, origFetch = null, origPush = null, origReplace = null;
  var myConsole = null, myFetch = null, myPush = null, myReplace = null;   // 我們自己的包裝；stop() 只在它仍是「最外層」時才還原，避免拆掉別人後來疊上去的包裝（如 X-Workspace 標頭補丁）

  function warnOnce(msg, e) { if (st.failed) return; st.failed = true; st.failReason = msg; try { console.warn('[issue-recorder] ' + msg + '，已停止錄製：', e && e.message || e); } catch (x) {} stop(); }
  function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) : s; }
  // 標記（路由／錯誤／API）：尚未拍到第一張完整快照前先暫存，開錄後補寫；單筆寫入失敗只丟該筆，不停整台錄製器
  function writeCustom(tag, payload) {
    try { rrweb.record.addCustomEvent(tag, payload); return true; }
    catch (e) { if (!st.customErrors++) { try { console.warn('[issue-recorder] 寫入自訂事件失敗（只丟棄該筆，錄製續行）：', e && e.message || e); } catch (x) {} } return false; }
  }
  function custom(tag, payload) {
    try {
      if (!st.running || !window.rrweb || !rrweb.record || !rrweb.record.addCustomEvent) return;
      if (!st.live) { st.pending.push({ tag: tag, payload: payload, at: Date.now() }); if (st.pending.length > MAX_PENDING) st.pending.shift(); return; }
      writeCustom(tag, payload);
    } catch (e) { st.customErrors++; }
  }
  function flushPending() {
    var q = st.pending; st.pending = [];
    q.forEach(function (p) {
      var pl = p.payload;
      if (pl && typeof pl === 'object' && !Array.isArray(pl)) { var c = {}; for (var k in pl) c[k] = pl[k]; c.at = p.at; pl = c; } else pl = { value: pl, at: p.at };
      writeCustom(p.tag, pl);
    });
  }

  // 把緩衝修到「最舊那段之後的下一段，起點距現在仍 ≥ 保留時間」就丟掉最舊那段 → 保留時間 ≈ N～N+1 分鐘，開頭必為完整畫面
  function trim(now) {
    while (st.segs.length > 1 && now - st.segs[1].start >= st.bufferMs) { st.segs.shift(); st.dropped = true; }
  }
  function onEmit(ev, isCheckout) {
    try {
      var now = ev.timestamp || Date.now();
      if (ev.type === 2 && !st.live) {   // 第一張完整快照＝真正開錄
        st.live = true; st.liveAt = Date.now(); st.failed = false; st.failReason = '';
        if (st.liveTimer) { clearTimeout(st.liveTimer); st.liveTimer = null; }
        setTimeout(flushPending, 0);   // 等這張快照寫進緩衝後再補寫標記
      }
      if (!st.segs.length || (isCheckout && ev.type === 4)) st.segs.push({ start: now, events: [] });
      st.segs[st.segs.length - 1].events.push(ev);
      if (isCheckout && ev.type === 4) trim(now);
    } catch (e) { warnOnce('緩衝寫入失敗', e); }
  }

  function addError(kind, p) {
    try {
      p.ts = Date.now();
      p.stack = clip(p.stack, MAX_STACK); p.message = clip(p.message, 1000);
      st.errors.push(p); if (st.errors.length > MAX_ERR) st.errors.shift();
      custom(kind, p);
    } catch (e) {}
  }
  function stackOf(args) {
    for (var i = 0; i < args.length; i++) if (args[i] && args[i].stack) return String(args[i].stack);
    try { return String(new Error().stack || '').split('\n').slice(2).join('\n'); } catch (e) { return ''; }
  }
  function onWinError(e) {
    if (!e || (e.target && e.target !== window)) return;      // 資源載入失敗（img/script）不算
    addError('error', { message: e.message || (e.error && e.error.message) || 'Error', source: e.filename || '', line: e.lineno || 0, col: e.colno || 0, stack: e.error && e.error.stack || '' });
  }
  function onRejection(e) {
    var r = e && e.reason;
    addError('error', { message: 'Unhandled rejection: ' + (r && r.message || String(r)), stack: r && r.stack || '' });
  }
  function hookConsole() {
    var orig = origConsoleError = console.error;   // 包裝自己持有原始函式：stop() 之後別處抓住的包裝仍要能正常運作
    console.error = myConsole = function () {
      try {
        var args = Array.prototype.slice.call(arguments);
        var msg = args.map(function (a) { try { return a && a.message ? a.message : (typeof a === 'object' ? JSON.stringify(a) : String(a)); } catch (x) { return String(a); } }).join(' ');
        addError('console-error', { message: msg, stack: stackOf(args) });
      } catch (e) {}
      return orig.apply(console, arguments);
    };
  }
  function relUrl(u) { try { var x = new URL(u, location.href); return x.origin === location.origin ? x.pathname + x.search : x.href; } catch (e) { return String(u); } }
  function hookFetch() {
    var orig = origFetch = window.fetch;
    if (typeof orig !== 'function') return;
    window.fetch = myFetch = function (input, init) {
      var t0 = Date.now(), method, url;
      try { method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase(); url = relUrl(typeof input === 'string' ? input : (input && input.url) || input); } catch (e) {}
      var skip = !url || /^\/api\/ping\b/.test(url);
      var p = orig.apply(this, arguments);
      if (skip) return p;
      p.then(function (res) {
        try {
          var rec = { method: method, url: url, status: res.status, ms: Date.now() - t0, ts: t0 };
          if (!res.ok) {
            res.clone().text().then(function (t) { rec.body = clip(t, MAX_BODY); pushReq(rec); }, function () { pushReq(rec); });
          } else pushReq(rec);
        } catch (e) {}
      }, function (err) {
        try { pushReq({ method: method, url: url, status: 0, ms: Date.now() - t0, ts: t0, body: clip(err && err.message || err, MAX_BODY) }); } catch (e) {}
      });
      return p;
    };
  }
  function pushReq(rec) {
    st.requests.push(rec); if (st.requests.length > MAX_REQ) st.requests.shift();
    custom('api', rec);
  }
  function routeEvent() {
    try { var m = /^\/app\/([^/]+)/.exec(location.pathname); custom('route', { to: location.pathname + location.search, view: m ? decodeURIComponent(m[1]) : '' }); } catch (e) {}
  }
  function hookRoute() {
    var push = origPush = history.pushState, repl = origReplace = history.replaceState;
    history.pushState = myPush = function () { var r = push.apply(this, arguments); routeEvent(); return r; };
    history.replaceState = myReplace = function () { var r = repl.apply(this, arguments); routeEvent(); return r; };
    window.addEventListener('popstate', routeEvent);
  }

  function start(opts) {
    if (st.running) return true;
    opts = opts || {};
    st.opts = opts;
    if (!window.rrweb || typeof rrweb.record !== 'function') { try { console.warn('[issue-recorder] rrweb 未載入，不錄製'); } catch (e) {} return false; }
    try {
      var min = Number(opts.bufferMinutes) > 0 ? Number(opts.bufferMinutes) : DEFAULT_MIN;
      st.bufferMs = opts.bufferMs || min * 60000;
      st.checkoutMs = opts.checkoutMs || CHECKOUT_MS;
      st.running = true; st.failed = false; st.failReason = ''; st.live = false; st.liveAt = 0; st.pending = [];
      st.liveTimer = setTimeout(function () { st.liveTimer = null; if (st.running && !st.live) { st.failed = true; st.failReason = '逾時未開錄'; } }, LIVE_TIMEOUT_MS);
      st.stopRec = rrweb.record({
        emit: onEmit,
        recordAfter: 'DOMContentLoaded',   // rrweb 只認這個字串，其餘退回 'load'（要等圖片字型全載完）
        checkoutEveryNms: st.checkoutMs,
        maskInputOptions: { password: true },
        blockSelector: opts.blockSelector || '.excalidraw, [data-rr-block]',   // 白板畫布不錄（吃效能，重播該區為空白）
        sampling: { mousemove: 200, scroll: 200 },   // input 不設 'last'：那只在失焦(change)時才記，人還停在欄位內就按回報會漏掉輸入
      });
      window.addEventListener('error', onWinError);
      window.addEventListener('unhandledrejection', onRejection);
      hookConsole(); hookFetch(); hookRoute();
      routeEvent();
      return true;
    } catch (e) { warnOnce('啟動失敗', e); return false; }
  }

  function stop() {
    var was = st.running;
    st.running = false; st.live = false;
    if (st.liveTimer) { clearTimeout(st.liveTimer); st.liveTimer = null; }
    try { if (st.stopRec) st.stopRec(); } catch (e) {}
    st.stopRec = null;
    try { window.removeEventListener('error', onWinError); window.removeEventListener('unhandledrejection', onRejection); window.removeEventListener('popstate', routeEvent); } catch (e) {}
    try {
      if (origConsoleError && console.error === myConsole) console.error = origConsoleError;
      if (origFetch && window.fetch === myFetch) window.fetch = origFetch;
      if (origPush && history.pushState === myPush) history.pushState = origPush;
      if (origReplace && history.replaceState === myReplace) history.replaceState = origReplace;
    } catch (e) {}
    origConsoleError = origFetch = origPush = origReplace = myConsole = myFetch = myPush = myReplace = null;
    return was;
  }

  // 目前緩衝的快照（不清空）。送件時用。
  function snapshot() {
    var events = [];
    st.segs.forEach(function (s) { events = events.concat(s.events); });
    var first = st.segs.length ? st.segs[0].start : 0;
    return {
      events: events,
      errors: st.errors.filter(function (e) { return e.ts >= first; }).slice(),
      requests: st.requests.slice(),
      fromPageLoad: !st.dropped,
      bufferMinutes: st.bufferMs / 60000,
      recording: st.running && st.live,
      failReason: st.failReason,
    };
  }
  function stats() {
    var first = st.segs.length ? st.segs[0].start : 0;
    return { live: st.live, liveAt: st.liveAt, recordedMs: first ? Math.max(0, Date.now() - first) : 0, failReason: st.failReason, pendingCustom: st.pending.length, customErrors: st.customErrors, running: st.running, failed: st.failed, segments: st.segs.length, events: st.segs.reduce(function (n, s) { return n + s.events.length; }, 0), firstTs: st.segs.length ? st.segs[0].start : 0, dropped: st.dropped };
  }

  window.IssueRecorder = { start: start, stop: stop, snapshot: snapshot, stats: stats };

  // 平台殼自動啟動：馬上以預設值開錄（不等網路）；設定回來後只更新保留時間、不重啟。測試鏡射頁可設 window.__ISSUE_REC_MANUAL = true 自己 start()。
  if (!window.__ISSUE_REC_MANUAL) {
    start({ bufferMinutes: DEFAULT_MIN });
    try {
      (window.apiFetch || fetch)('/api/issues/config').then(function (r) { return r.json(); }, function () {}).then(function (j) {
        var m = j && Number(j.bufferMinutes);
        if (m > 0 && m * 60000 !== st.bufferMs) st.bufferMs = m * 60000;
      }).catch(function () {});
    } catch (e) {}
  }
})();

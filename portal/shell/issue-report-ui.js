// 回報給 Hana — 回報入口與小窗（SPEC-issue-report.md §4.1／§5.1，IR1-3）。classic <script>，放在頭像 widget 之後載入。
// 入口：頭像圖示面板裡的旗子圖示（整頁對話時頭像被藏，但圖示面板仍常駐右下角＝補的那顆小鈕）＋快捷鍵 Alt+Shift+R。
// 按「送出」才連網；取消什麼都不送。送出的錄製資料是「按下入口當下」的快照，不受小窗停留時間影響。
(function () {
  'use strict';
  if (window.IssueReportUI) return;

  var MAX_IMG = 5, MAX_IMG_BYTES = 4 * 1024 * 1024;
  var FLAG_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-lucide="flag"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/></svg>';

  var dlg = null;     // 目前開著的小窗 { root, state }
  var picking = null; // 指認模式的清理函式

  function el(tag, css, text) { var n = document.createElement(tag); if (css) n.style.cssText = css; if (text != null) n.textContent = text; return n; }
  function isDark() { return document.documentElement.classList.contains('dark') || document.body.classList.contains('dark'); }
  function mine(n) { return !!(n && n.closest && n.closest('[data-issue-ui]')); }

  function selectorOf(node) {
    var parts = [];
    for (var i = 0; node && node.nodeType === 1 && i < 4 && node !== document.body; i++, node = node.parentElement) {
      if (node.id) { parts.unshift('#' + node.id); break; }
      var s = node.tagName.toLowerCase();
      var cls = (typeof node.className === 'string' ? node.className : '').split(/\s+/).filter(function (c) { return c && !/[:\[\]\/]/.test(c); }).slice(0, 2);
      if (cls.length) s += '.' + cls.join('.');
      var sib = node.parentElement && Array.prototype.filter.call(node.parentElement.children, function (c) { return c.tagName === node.tagName; });
      if (sib && sib.length > 1) s += ':nth-of-type(' + (sib.indexOf(node) + 1) + ')';
      parts.unshift(s);
    }
    return parts.join(' > ');
  }
  function describePick(node) {
    var txt = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    var val = ('value' in node && node.type !== 'password') ? String(node.value || '').slice(0, 120) : '';
    return { selector: selectorOf(node), tag: node.tagName.toLowerCase(), text: txt || node.getAttribute('aria-label') || node.getAttribute('title') || '', value: val };
  }

  // 指認模式：滑過的元素框紅、點下去記錄（吃掉這次點擊，不讓畫面真的動作）。Esc 取消。
  function startPick(done) {
    var box = el('div', 'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #ef4444;background:rgba(239,68,68,.12);border-radius:3px;display:none');
    box.setAttribute('data-issue-ui', '1');
    var tip = el('div', 'position:fixed;z-index:2147483647;top:10px;left:50%;transform:translateX(-50%);background:#ef4444;color:#fff;font:12px/1.4 sans-serif;padding:6px 12px;border-radius:8px;pointer-events:none', '請點一下有問題的地方（Esc 取消）');
    tip.setAttribute('data-issue-ui', '1');
    document.body.appendChild(box); document.body.appendChild(tip);
    var cur = null;
    function move(e) {
      var t = e.target; if (mine(t)) return; cur = t;
      var r = t.getBoundingClientRect();
      box.style.cssText += ';display:block;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px';
    }
    function click(e) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); var t = cur || e.target; end(); done(mine(t) ? null : describePick(t)); }
    function key(e) { if (e.key === 'Escape') { e.stopPropagation(); end(); done(null, true); } }
    function swallow(e) { if (!mine(e.target)) { e.preventDefault(); e.stopPropagation(); } }
    function end() {
      document.removeEventListener('mouseover', move, true); document.removeEventListener('click', click, true);
      document.removeEventListener('keydown', key, true); document.removeEventListener('mousedown', swallow, true); document.removeEventListener('mouseup', swallow, true);
      box.remove(); tip.remove(); picking = null;
    }
    document.addEventListener('mouseover', move, true); document.addEventListener('click', click, true);
    document.addEventListener('keydown', key, true); document.addEventListener('mousedown', swallow, true); document.addEventListener('mouseup', swallow, true);
    picking = end;
  }

  function readFile(file) {
    return new Promise(function (resolve) { var fr = new FileReader(); fr.onload = function () { resolve(fr.result); }; fr.onerror = function () { resolve(null); }; fr.readAsDataURL(file); });
  }

  function close() {
    if (picking) picking();
    if (dlg) { dlg.root.remove(); document.removeEventListener('keydown', dlg.onKey, true); dlg = null; }
  }

  function toast(msg, ok) {
    var t = el('div', 'position:fixed;z-index:2147483647;right:24px;bottom:96px;padding:10px 16px;border-radius:10px;font:13px/1.4 sans-serif;color:#fff;box-shadow:0 6px 24px rgba(0,0,0,.35);background:' + (ok ? '#0891b2' : '#dc2626'), msg);
    t.setAttribute('data-issue-ui', '1');
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 4000);
  }

  function collectContext() {
    var m = /^\/app\/([^/]+)/.exec(location.pathname);
    var chat = null; try { chat = window.router && window.router.getChatContext ? window.router.getChatContext() : null; } catch (e) {}
    return {
      route: location.pathname + location.search,
      view: m ? decodeURIComponent(m[1]) : '',
      chatContext: chat,
      env: { userAgent: navigator.userAgent, viewport: window.innerWidth + 'x' + window.innerHeight, screen: screen.width + 'x' + screen.height, dpr: window.devicePixelRatio, language: navigator.language, tz: (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone },
    };
  }

  function open() {
    if (dlg) return;
    // 先抓錄製快照與畫面脈絡（按下入口的當下）
    var snap = null;
    try { snap = window.IssueRecorder ? window.IssueRecorder.snapshot() : null; } catch (e) {}
    var ctx = collectContext();
    var state = { type: 'bug', pick: null, images: [] };

    var dark = isDark();
    var bg = dark ? '#0f172a' : '#ffffff', fg = dark ? '#e2e8f0' : '#0f172a', bd = dark ? '#334155' : '#cbd5e1', sub = dark ? '#94a3b8' : '#64748b';
    var root = el('div', 'position:fixed;inset:0;z-index:2147483645;background:rgba(2,6,23,.55);display:flex;align-items:center;justify-content:center');
    root.setAttribute('data-issue-ui', '1');
    var card = el('div', 'width:min(480px,92vw);max-height:90vh;overflow:auto;background:' + bg + ';color:' + fg + ';border:1px solid ' + bd + ';border-radius:14px;padding:18px;font:14px/1.5 sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.5)');
    root.appendChild(card);
    card.appendChild(el('div', 'font-weight:700;font-size:16px;margin-bottom:4px', '回報給 Hana'));
    card.appendChild(el('div', 'font-size:12px;color:' + sub + ';margin-bottom:12px', snap && snap.recording ? '會一併附上剛剛的操作紀錄（約最近 ' + snap.bufferMinutes + ' 分鐘）與錯誤訊息。按取消什麼都不會送出。' : '目前沒有操作紀錄（錄製未啟動），只會送出你寫的內容與畫面資訊。'));

    // 錄影狀態一行小字：真的有錄才說「錄影中」，其餘如實告知
    var recSt = null; try { recSt = window.IssueRecorder ? window.IssueRecorder.stats() : null; } catch (e) {}
    var recLine;
    if (recSt && recSt.live && recSt.running && !recSt.failed) {
      recLine = el('div', 'font-size:12px;margin-bottom:10px;color:#16a34a', '● 錄影中，已錄 ' + Math.round(recSt.recordedMs / 1000) + ' 秒（' + recSt.events + ' 筆）');
    } else if (recSt && recSt.running && !recSt.failed) {
      recLine = el('div', 'font-size:12px;margin-bottom:10px;color:' + sub, '錄影準備中…');
    } else {
      recLine = el('div', 'font-size:12px;margin-bottom:10px;color:#d97706', '⚠ 錄影未運作（原因：' + (recSt ? (recSt.failReason || (recSt.running ? '尚未開錄' : '已停止')) : '錄製器未載入') + '），這筆回報不會有重播，其他資訊照常送出');
    }
    recLine.setAttribute('data-rec-status', '1');
    card.appendChild(recLine);

    var typeRow = el('div', 'display:flex;gap:16px;margin-bottom:10px');
    [['bug', '問題'], ['feature', '新需求']].forEach(function (o) {
      var lb = el('label', 'cursor:pointer;display:flex;align-items:center;gap:6px');
      var r = document.createElement('input'); r.type = 'radio'; r.name = 'issue-type'; r.value = o[0]; r.checked = o[0] === 'bug';
      r.onchange = function () { state.type = o[0]; };
      lb.appendChild(r); lb.appendChild(document.createTextNode(o[1])); typeRow.appendChild(lb);
    });
    card.appendChild(typeRow);

    var ta = document.createElement('textarea');
    ta.rows = 4; ta.placeholder = '一句話說明（必填）：例如「按了立即執行沒反應」';
    ta.style.cssText = 'width:100%;box-sizing:border-box;background:' + (dark ? '#1e293b' : '#f8fafc') + ';color:' + fg + ';border:1px solid ' + bd + ';border-radius:8px;padding:8px;resize:vertical';
    card.appendChild(ta);

    var pickRow = el('div', 'display:flex;align-items:center;gap:8px;margin-top:10px');
    var pickBtn = el('button', 'padding:5px 10px;border:1px solid ' + bd + ';border-radius:8px;background:transparent;color:' + fg + ';cursor:pointer', '指出位置');
    var pickInfo = el('span', 'font-size:12px;color:' + sub + ';flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', '（選填）點畫面上有問題的地方');
    var pickClear = el('button', 'display:none;padding:2px 8px;border:1px solid ' + bd + ';border-radius:6px;background:transparent;color:' + sub + ';cursor:pointer;font-size:12px', '清除');
    pickRow.appendChild(pickBtn); pickRow.appendChild(pickInfo); pickRow.appendChild(pickClear); card.appendChild(pickRow);
    pickBtn.onclick = function () {
      root.style.display = 'none';
      setTimeout(function () {
        startPick(function (p) {
          root.style.display = 'flex';
          if (p) { state.pick = p; pickInfo.textContent = '已指出：' + (p.text ? '「' + p.text.slice(0, 30) + '」' : p.selector); pickClear.style.display = ''; }
        });
      }, 50);
    };
    pickClear.onclick = function () { state.pick = null; pickInfo.textContent = '（選填）點畫面上有問題的地方'; pickClear.style.display = 'none'; };

    var imgRow = el('div', 'display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;align-items:center');
    var imgHint = el('span', 'font-size:12px;color:' + sub, '可直接 Ctrl+V 貼上截圖（選填）');
    imgRow.appendChild(imgHint); card.appendChild(imgRow);
    function renderImgs() {
      imgRow.innerHTML = '';
      if (!state.images.length) { imgRow.appendChild(imgHint); return; }
      state.images.forEach(function (im, i) {
        var w = el('div', 'position:relative'); var img = document.createElement('img'); img.src = im.dataUrl; img.style.cssText = 'height:56px;border-radius:6px;border:1px solid ' + bd;
        var x = el('button', 'position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;border:0;background:#334155;color:#fff;cursor:pointer;font-size:12px;line-height:18px;padding:0', '×');
        x.onclick = function () { state.images.splice(i, 1); renderImgs(); };
        w.appendChild(img); w.appendChild(x); imgRow.appendChild(w);
      });
    }
    root.addEventListener('paste', function (e) {
      var items = (e.clipboardData && e.clipboardData.items) || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
          var f = items[i].getAsFile();
          if (!f || state.images.length >= MAX_IMG) continue;
          if (f.size > MAX_IMG_BYTES) { toast('圖片超過 4MB，沒有加入', false); continue; }
          e.preventDefault();
          readFile(f).then(function (d) { if (d) { state.images.push({ kind: 'paste', dataUrl: d }); renderImgs(); } });
        }
      }
    });

    var msg = el('div', 'color:#dc2626;font-size:12px;margin-top:8px;min-height:16px');
    card.appendChild(msg);
    var btnRow = el('div', 'display:flex;justify-content:flex-end;gap:8px;margin-top:6px');
    var cancel = el('button', 'padding:7px 16px;border:1px solid ' + bd + ';border-radius:8px;background:transparent;color:' + fg + ';cursor:pointer', '取消');
    var ok = el('button', 'padding:7px 16px;border:0;border-radius:8px;background:#0891b2;color:#fff;cursor:pointer;font-weight:600', '送出');
    btnRow.appendChild(cancel); btnRow.appendChild(ok); card.appendChild(btnRow);
    cancel.onclick = close;
    ok.onclick = function () {
      var desc = ta.value.trim();
      if (!desc) { msg.textContent = '請先寫一句說明'; ta.focus(); return; }
      ok.disabled = true; ok.textContent = '送出中…'; msg.textContent = '';
      submit({ type: state.type, description: desc, pick: state.pick, images: state.images, snap: snap, ctx: ctx }).then(function (id) {
        close(); toast('已回報 #' + id, true);
        try { if (typeof window.refreshIssueBadge === 'function') window.refreshIssueBadge(); } catch (e2) {}   // IR2-2：側欄未結案數即時更新
        try { window.dispatchEvent(new CustomEvent('harness:issue-created', { detail: { id: id } })); } catch (e3) {}   // IRR-2：問題回報頁即時出現新那筆
      }, function (e) {
        ok.disabled = false; ok.textContent = '送出'; msg.textContent = '送出失敗：' + (e && e.message || e);
      });
    };

    var onKey = function (e) { if (e.key === 'Escape' && !picking) { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(root);
    dlg = { root: root, state: state, onKey: onKey };
    setTimeout(function () { ta.focus(); }, 0);
  }

  function submit(o) {
    var versionP = fetch('/api/ping').then(function (r) { return r.json(); }).then(function (j) { return j && j.version || ''; }, function () { return ''; });
    return versionP.then(function (version) {
      var s = o.snap || {};
      var body = {
        type: o.type, description: o.description, pick: o.pick,
        route: o.ctx.route, view: o.ctx.view, chatContext: o.ctx.chatContext, env: o.ctx.env, version: version,
        errors: s.errors || [], requests: s.requests || [], events: s.events || [],
        bufferMinutes: s.bufferMinutes, fromPageLoad: !!s.fromPageLoad,
        images: o.images || [],
      };
      return fetch('/api/issues', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
          return j.id;
        });
      });
    });
  }

  function mountButton() {
    var panel = document.getElementById('hana-icon-panel');
    if (!panel || document.getElementById('issue-report-btn')) return;
    var b = document.createElement('button');
    b.id = 'issue-report-btn'; b.className = 'hana-mode-btn'; b.title = '回報給 Hana（Alt+Shift+R）';
    b.setAttribute('data-issue-ui', '1');
    b.style.cssText = 'width:38px;height:38px;border-radius:50%;border:1.5px solid rgba(248,113,113,0.45);background:rgba(15,23,42,0.82);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;cursor:pointer;color:#f87171;padding:0';
    b.innerHTML = FLAG_SVG;
    b.onclick = function (e) { e.stopPropagation(); open(); };
    var gear = document.getElementById('hana-gear-btn');
    panel.insertBefore(b, gear || null);
  }

  document.addEventListener('keydown', function (e) {
    if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyR') { e.preventDefault(); open(); }
  });

  window.IssueReportUI = { open: open, close: close, mountButton: mountButton, _submit: submit };
  try { mountButton(); } catch (e) { console.warn('[issue-report-ui] 掛載入口失敗：', e && e.message); }
})();

    // ── SPEC-resilient-cli Part B — limit-aware status (reactive; refreshed on load + after each chat) ──
    let _limitData = [];
    // SPEC-model-quota §5 — 主動查詢的用量／限額窗口（開啟面板時才查一次，不輪詢）。
    let _quotaData = null;
    function fmtReset(iso) {
      if (!iso) return '';
      const d = new Date(iso); if (isNaN(d.getTime())) return '';
      const diff = d.getTime() - Date.now(); if (diff <= 0) return '';
      const mins = Math.round(diff / 60000);
      const when = d.toLocaleString('zh-TW', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      return mins < 600 ? `約 ${when} 重置（${mins} 分後）` : `約 ${when} 重置`;
    }
    async function refreshLimitStatus() {
      try { const r = await fetch('/api/limits'); const j = await r.json(); _limitData = (j && j.models) || []; } catch (e) { _limitData = []; }
      const dot = document.getElementById('limit-status-dot'), label = document.getElementById('limit-status-label');
      if (dot && label) {
        const limited = _limitData.filter(m => m.status === 'limited');
        if (limited.length) { dot.className = 'h-2 w-2 rounded-full bg-amber-500'; label.textContent = limited.length + ' 限流'; }
        else if (_limitData.some(m => m.status === 'ok')) { dot.className = 'h-2 w-2 rounded-full bg-emerald-500'; label.textContent = '額度'; }
        else { dot.className = 'h-2 w-2 rounded-full bg-slate-300'; label.textContent = '額度'; }
      }
      const panel = document.getElementById('limit-panel');
      if (panel && !panel.classList.contains('hidden')) renderLimitPanel();
    }
    // 進度條 + 「約 X 後重置」；這是指揮官真正要看的東西（剩多少、何時回血），
    // 不是「最後使用時間」。
    function fmtResetLong(iso) {
      if (!iso) return '時間未知';
      const d = new Date(iso); if (isNaN(d.getTime())) return '時間未知';
      const diff = d.getTime() - Date.now();
      const when = d.toLocaleString('zh-TW', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      if (diff <= 0) return when + ' 已重置';
      const mins = Math.round(diff / 60000);
      if (mins < 60) return `${when} 重置（${mins} 分後）`;
      const hrs = Math.round(mins / 60);
      if (hrs < 48) return `${when} 重置（約 ${hrs} 小時後）`;
      return `${when} 重置（約 ${Math.round(hrs / 24)} 天後）`;
    }
    function quotaBar(w) {
      const pct = Math.round((w.usedRatio || 0) * 100);
      const color = pct >= 90 ? 'bg-rose-500' : pct >= 70 ? 'bg-amber-500' : 'bg-emerald-500';
      return `<div class="px-3 py-1"><div class="flex justify-between text-[11px] text-slate-500 dark:text-slate-400"><span>${escapeHtml(w.name || '')}</span><span class="font-semibold text-slate-700 dark:text-slate-200">${pct}%</span></div>`
        + `<div class="h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 mt-1 overflow-hidden"><div class="h-full ${color}" style="width:${Math.min(100, pct)}%"></div></div>`
        + `<div class="text-[10px] text-slate-400 mt-0.5">${escapeHtml(fmtResetLong(w.resetAt))}</div></div>`;
    }
    function renderQuotaSection() {
      if (!_quotaData) return '<div class="text-[11px] text-slate-400 px-3 py-2">查詢用量中…</div>';
      const provs = _quotaData.providers || [];
      if (!provs.length) return '';
      return provs.map((p) => {
        // SPEC-model-quota.md §9 D11 (MQR-4): 'stale' is a yellow caution, not a red failure — it
        // still carries real (if slightly old) windows, so draw the bars same as 'ok' plus a grey
        // note explaining the data is stale. Only 'broken' is red.
        const dotColor = p.health === 'ok' ? 'bg-emerald-500' : p.health === 'broken' ? 'bg-rose-500' : p.health === 'stale' ? 'bg-amber-500' : 'bg-slate-300';
        let body;
        if ((p.health === 'ok' || p.health === 'stale') && (p.windows || []).length) {
          body = p.windows.map(quotaBar).join('');
          if (p.health === 'stale' && p.message) body += `<div class="px-3 pb-1.5 text-[10px] text-slate-400">${escapeHtml(p.message)}</div>`;
        } else {
          body = `<div class="px-3 pb-1.5 text-[10px] ${p.health === 'broken' ? 'text-rose-500' : 'text-slate-400'}">${escapeHtml(p.message || '')}</div>`;
        }
        return `<div class="py-1 border-t border-slate-100 dark:border-slate-800 first:border-0"><div class="flex items-center gap-2 px-3 py-1 text-[11px] font-semibold text-slate-700 dark:text-slate-200"><span class="h-2 w-2 rounded-full ${dotColor}"></span>${escapeHtml(p.label || p.id)}</div>${body}</div>`;
      }).join('');
    }
    async function refreshQuota() {
      try { const r = await fetch('/api/model-quota'); _quotaData = await r.json(); }
      catch (e) { _quotaData = { providers: [], generatedAt: null, _err: true }; }
      const label = document.getElementById('limit-status-label');
      const claude = (_quotaData.providers || []).find((p) => p.id === 'claude');
      if (label && claude && claude.health === 'ok' && (claude.windows || []).length) {
        const worst = Math.max.apply(null, claude.windows.map((w) => Math.round((w.usedRatio || 0) * 100)));
        if (!/限流/.test(label.textContent)) label.textContent = '額度 ' + worst + '%';
      }
      const panel = document.getElementById('limit-panel');
      if (panel && !panel.classList.contains('hidden')) renderLimitPanel();
    }
    function renderLimitPanel() {
      const panel = document.getElementById('limit-panel'); if (!panel) return;
      const quotaHtml = '<div class="text-[10px] text-slate-400 px-3 pt-2 pb-1">用量與重置時間 · 開啟時查一次，不輪詢</div>' + renderQuotaSection()
        + '<div class="text-[10px] text-slate-400 px-3 pt-2 pb-1 border-t border-slate-100 dark:border-slate-800">實際呼叫觀察到的限流狀態</div>';
      if (!_limitData.length) { panel.innerHTML = quotaHtml + '<div class="text-[11px] text-slate-400 px-3 py-2">尚無資料——派工後就會顯示各模型狀態。</div>'; lucide.createIcons(); return; }
      panel.innerHTML = quotaHtml + _limitData.map(m => {
        const ok = m.status === 'ok', limited = m.status === 'limited';
        const color = ok ? 'bg-emerald-500' : limited ? 'bg-amber-500' : 'bg-slate-300';
        const stat = ok ? '可用' : limited ? '限流中' : '未知';
        const reset = limited ? fmtReset(m.resetAt) : '';
        const used = m.lastUsedAt ? new Date(m.lastUsedAt).toLocaleTimeString('zh-TW', { hour12: false }) : '';
        const sub = reset || (used ? '最後使用 ' + used : '');
        return `<div class="flex items-start gap-2 px-3 py-1.5 text-[11px]"><span class="h-2 w-2 rounded-full ${color} mt-1 flex-shrink-0"></span><span class="flex flex-col min-w-0"><span class="font-semibold text-slate-700 dark:text-slate-200 truncate">${escapeHtml(m.provider)} · ${escapeHtml(m.model || '')}</span><span class="text-slate-400">${stat}${sub ? ' · ' + sub : ''}</span></span></div>`;
      }).join('');
      lucide.createIcons();
    }
    function toggleLimitPanel(e) {
      if (e) e.stopPropagation();
      let panel = document.getElementById('limit-panel');
      if (!panel) {
        panel = document.createElement('div');
        panel.id = 'limit-panel';
        panel.className = 'fixed z-50 w-80 max-h-[70vh] overflow-y-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl py-1 hidden';
        document.body.appendChild(panel);
        document.addEventListener('click', (ev) => { if (!ev.target.closest('#limit-panel') && !ev.target.closest('#limit-status-btn')) panel.classList.add('hidden'); });
      }
      const btn = document.getElementById('limit-status-btn'), r = btn.getBoundingClientRect();
      panel.style.top = (r.bottom + 6) + 'px'; panel.style.left = Math.max(8, r.left) + 'px';
      const opening = panel.classList.contains('hidden');
      panel.classList.toggle('hidden');
      if (opening) { refreshLimitStatus(); refreshQuota(); }
    }

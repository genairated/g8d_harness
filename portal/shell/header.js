    // ── SPEC-resilient-cli Part B — limit-aware status (reactive; refreshed on load + after each chat) ──
    let _limitData = [];
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
    function renderLimitPanel() {
      const panel = document.getElementById('limit-panel'); if (!panel) return;
      if (!_limitData.length) { panel.innerHTML = '<div class="text-[11px] text-slate-400 px-3 py-2">尚無資料——派工後就會顯示各模型狀態（依實際呼叫結果，不會去打 API）。</div>'; lucide.createIcons(); return; }
      panel.innerHTML = '<div class="text-[10px] text-slate-400 px-3 pt-2 pb-1">依實際呼叫結果更新 · 不輪詢</div>' + _limitData.map(m => {
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
        panel.className = 'fixed z-50 w-72 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl py-1 hidden';
        document.body.appendChild(panel);
        document.addEventListener('click', (ev) => { if (!ev.target.closest('#limit-panel') && !ev.target.closest('#limit-status-btn')) panel.classList.add('hidden'); });
      }
      const btn = document.getElementById('limit-status-btn'), r = btn.getBoundingClientRect();
      panel.style.top = (r.bottom + 6) + 'px'; panel.style.left = Math.max(8, r.left) + 'px';
      const opening = panel.classList.contains('hidden');
      panel.classList.toggle('hidden');
      if (opening) refreshLimitStatus();
    }

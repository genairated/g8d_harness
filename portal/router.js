// SPEC-portal-architecture.md §3.1/§R — History API router core.
//
// Route shape: /app/<view>[/<sub>]. navigate() is the single entry point for changing view;
// render() imports the migrated view module (views/<view>.js, mount/unmount/meta contract — see
// SPEC-plugin-contract.md §3). §V13: every panel is now a view module, so the R5 legacy
// switchToX()/showPanel() compatibility fallback (VIEW_ROUTES/PANEL_TO_ROUTE/syncUrl) has been
// removed — render() no longer has anywhere to fall back to.
(function () {
  let currentUnmount = null;
  // §V11: which view (or 'x/<plugin>') is currently mounted into #view-root. Unlike every other
  // migrated view (only ever entered via a menu click → navigate(), already deduped by the
  // location.pathname === path check in navigate() below), wiki is also entered directly by
  // loadFile() — called from nearly every panel, and repeatedly while browsing within wiki itself.
  // Without this guard, re-rendering the SAME route would call unmount()+mount() again on every
  // single file open, wiping out whatever loadFile() was about to render into the fresh #content-area.
  let currentView = null;
  // SPEC-view-chat-context.md §3.2/CTX1: the currently-mounted view module (if any), so the avatar
  // float-chat can ask it "what am I looking at" instead of a hardcoded location.pathname if-chain.
  let currentModule = null;

  function parsePath(pathname) {
    const m = /^\/app\/([^/]+)(?:\/(.+))?$/.exec(pathname || '');
    if (!m) return null;
    return { view: decodeURIComponent(m[1]), sub: m[2] ? decodeURIComponent(m[2]) : null };
  }

  // WSXW (SPEC-workspace-settings.md §29/§32-8): /app/xurl/<key> — "embed + external" plugins.
  // This is NOT a view module route: it just drops a full-size <iframe> pointed at the plugin's
  // externalUrl into #view-root. `key` resolves name-first-then-slug against /api/status's plugins
  // (same single source sidebar.js and settings.js already read, D20/D24).
  async function renderXurl(key, root) {
    root.innerHTML = '<div class="flex-1 flex items-center justify-center text-slate-400 text-sm p-6">載入中…</div>';
    try {
      const r = await fetch('/api/status');
      const data = await r.json();
      const list = (data && data.plugins) || [];
      const pl = list.find(p => p.name === key) || list.find(p => p.slug === key);
      const url = pl && pl.externalUrl;
      if (!pl || !url || !/^https?:\/\//i.test(url)) {
        root.innerHTML = '<div class="flex-1 flex items-center justify-center text-slate-400 text-sm p-6 text-center">找不到這個外掛的外部網址，或網址格式不正確。</div>';
        return;
      }
      root.innerHTML = '';
      const iframe = document.createElement('iframe');
      iframe.src = url;
      iframe.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;';
      root.appendChild(iframe);
    } catch (e) {
      console.error('[router] xurl load error:', e);
      root.innerHTML = '<div class="flex-1 flex items-center justify-center text-slate-400 text-sm p-6 text-center">載入外部網址時發生錯誤。</div>';
    }
  }

  async function render(pathname) {
    const parsed = parsePath(pathname);
    if (!parsed) return;
    if (parsed.view === 'xurl' && parsed.sub) {
      const viewKey = 'xurl/' + parsed.sub;
      if (viewKey === currentView) return;
      if (currentUnmount) { try { currentUnmount(); } catch (e) { console.error('[router] unmount error:', e); } }
      const root = document.getElementById('view-root');
      if (!root) return;
      if (typeof window.showPanel === 'function') window.showPanel('__view_root__');
      root.classList.remove('hidden');
      currentUnmount = () => { root.innerHTML = ''; };
      currentView = viewKey;
      currentModule = null;
      renderXurl(parsed.sub, root);
      return;
    }
    // Plugin route (SPEC-plugin-contract.md §2/§3): /app/x/<name> — the plugin's view module is
    // served at /views/x/<name>.js (see server.js's dedicated static handler), not /views/<view>.js.
    const isPlugin = parsed.view === 'x' && !!parsed.sub;
    const viewKey = isPlugin ? ('x/' + parsed.sub) : parsed.view;
    if (viewKey === currentView) return; // already showing this view — no-op, see currentView comment above
    // A plugin's view module is loaded with import(), which — unlike window.fetch — cannot carry the
    // X-Workspace header, so the per-tab workspace travels as ?workspace= in the module URL instead.
    // Without it the server resolves the plugin against its STARTUP default workspace, so opening any
    // plugin from a tab pointed at a different workspace 404s ("no view module for route").
    const wsEnc = isPlugin ? encodeURIComponent(sessionStorage.getItem('current_workspace') || '') : '';
    const moduleUrl = isPlugin
      ? ('/views/x/' + parsed.sub + '.js' + (wsEnc ? '?workspace=' + wsEnc : ''))
      : ('/views/' + parsed.view + '.js');

    try {
      const mod = await import(moduleUrl);
      if (mod && typeof mod.mount === 'function') {
        if (currentUnmount) { try { currentUnmount(); } catch (e) { console.error('[router] unmount error:', e); } }
        const root = document.getElementById('view-root');
        if (root) {
          mod.mount(root, {
            workspace: sessionStorage.getItem('current_workspace') || '',
            sub: isPlugin ? null : parsed.sub,
            plugin: isPlugin ? parsed.sub : null,
            apiFetch: window.apiFetch
          });
          currentUnmount = typeof mod.unmount === 'function' ? mod.unmount : null;
          currentView = viewKey;
          currentModule = mod;
        }
      }
    } catch (e) {
      // §V13: there is no legacy fallback left — every menu route must have a view module.
      console.error('[router] no view module for route:', pathname, e);
    }
  }

  function navigate(path, opts) {
    opts = opts || {};
    if (location.pathname === path && !opts.force) return;
    if (opts.replace) history.replaceState({}, '', path);
    else history.pushState({}, '', path);
    render(path);
  }

  function restore() {
    if (location.pathname.indexOf('/app/') === 0) render(location.pathname);
  }

  window.addEventListener('popstate', function () { render(location.pathname); });

  // SPEC-view-chat-context.md §3.2/CTX1: ask the currently-mounted view "what am I looking at".
  // Wrapped in try/catch — a view's getChatContext() throwing must never break the chat widget.
  // Returns null when there's no mounted view, the view doesn't implement it, or it throws —
  // callers treat null as "fall back to file mode".
  function getChatContext() {
    try { return currentModule && typeof currentModule.getChatContext === 'function' ? (currentModule.getChatContext() || null) : null; }
    catch (e) { console.error('[router] getChatContext error:', e); return null; }
  }

  window.router = { navigate: navigate, restore: restore, render: render, getChatContext: getChatContext };
})();

// Backend route table (SPEC-portal-architecture.md §3.2, TASK.md §B1).
// Replaces (progressively — see TASK.md §B2 for migration batches) the 78-if chain in server.js
// with a method+path → handler table. Path patterns support `:param` segments. Handlers keep
// closing over server.js's module-level helpers (resolveWorkspace, getManifest, …) exactly as the
// if-blocks did — this module only owns matching, dispatch, and uniform error wrapping.
//
// Unregistered paths are not this module's concern: dispatch() returns false and the caller
// (server.js) falls through to the legacy if-chain, so migrating routes in batches is safe.

class ApiRouter {
  constructor() {
    this.routes = [];
  }

  _add(method, pattern, handler) {
    const paramNames = [];
    const regexSrc = '^' + pattern
      .split('/')
      .map((seg) => {
        if (seg.charAt(0) === ':') { paramNames.push(seg.slice(1)); return '([^/]+)'; }
        return seg.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/') + '$';
    this.routes.push({ method, pattern, regex: new RegExp(regexSrc), paramNames, handler });
  }

  get(pattern, handler) { this._add('GET', pattern, handler); }
  post(pattern, handler) { this._add('POST', pattern, handler); }
  put(pattern, handler) { this._add('PUT', pattern, handler); }
  delete(pattern, handler) { this._add('DELETE', pattern, handler); }
  patch(pattern, handler) { this._add('PATCH', pattern, handler); }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      r.paramNames.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
    return null;
  }

  // Returns true when a registered route claimed the request (handler has already run and
  // written the response, or a thrown error was caught and turned into a 500). Returns false
  // when nothing matched, so the caller can fall through to other handling.
  dispatch(req, res, pathname, parsedUrl) {
    const found = this.match(req.method, pathname);
    if (!found) return false;
    const ctx = { params: found.params, pathname, parsedUrl };
    try {
      found.handler(req, res, ctx);
    } catch (err) {
      console.error('[api-router] handler error on ' + req.method + ' ' + pathname + ':', (err && err.stack) || err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err && err.message) || String(err) }));
      }
    }
    return true;
  }

  // Plugin backend mount point (SPEC-plugin-contract.md §4). Forces every route registered by a
  // plugin's register(api) under /api/x/<name>/*, and injects ctx.workspace — already resolved via
  // resolveWorkspace(req) — so a plugin can never read the global active workspace and leak across
  // workspace isolation.
  mount(name, registerFn, resolveWorkspace) {
    const prefix = '/api/x/' + name;
    const self = this;
    function wrap(handler) {
      return (req, res, ctx) => {
        ctx.workspace = resolveWorkspace(req);
        return handler(req, res, ctx);
      };
    }
    const api = {
      get: (p, h) => self.get(prefix + p, wrap(h)),
      post: (p, h) => self.post(prefix + p, wrap(h)),
      put: (p, h) => self.put(prefix + p, wrap(h)),
      delete: (p, h) => self.delete(prefix + p, wrap(h)),
      patch: (p, h) => self.patch(prefix + p, wrap(h)),
    };
    registerFn(api);
  }
}

module.exports = { ApiRouter };

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');
const crypto = require('crypto');
const { execFile } = require('child_process');
const mcpServer = require('./mcp-server');
const { ApiRouter } = require('./api-router');
const pluginLoader = require('./plugin-loader');
const docgraph = require('../docgraph/query');
const docgraphProfile = require('../docgraph/profiles/hana');
const { SchedulerManager } = require('./scheduler');
const { createTelegramBot } = require('./telegram');
const docRegistry = require('./document-registry');
const notesStore = require('./notes');
const pmStore = require('./pm');
const { buildPmWorkbook } = require('./pm-export');
const whiteboardsStore = require('./whiteboards');
const audioTopics = require('./audio-topics');

// Keep the portal alive even if a spawned CLI / node-pty throws asynchronously.
// Without this, one bad child process could take down the whole server and make
// every subsequent request (and the web UI) hang.
process.on('uncaughtException', (err) => {
  console.error('[Harness] Uncaught exception (server kept alive):', (err && err.stack) || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Harness] Unhandled rejection (server kept alive):', reason);
});

// --- Harness wiring ---
// The portal now lives in the standalone harness and loads a project by root path.
// HARNESS_PROJECT_ROOT is the first "manifest seam": later this comes from a project
// registry / per-project harness.json instead of a hardcoded default.
const PORT = process.env.HARNESS_PORT ? parseInt(process.env.HARNESS_PORT, 10) : 3400;
// --- Access-security defaults (SPEC-setup §12) ---
// Bind to loopback by default: only this machine can reach the portal (the portal = a shell on
// this box). Set PORTAL_BIND=0.0.0.0 to expose it (remote/phone), ideally behind Tailscale.
const BIND = process.env.PORTAL_BIND || '127.0.0.1';
// Optional token gate. UNSET/empty ⇒ gate fully OFF ⇒ behaviour is 100% identical to before
// (zero-config default; first install is never locked out because loopback needs no token).
const PORTAL_TOKEN = process.env.PORTAL_TOKEN || '';
// Host allow-list for the token gate — blocks DNS-rebinding (a page resolving an attacker
// domain to 127.0.0.1 to reach us with the browser's cookies). Extra hosts via PORTAL_ALLOWED_HOSTS.
const PORTAL_ALLOWED_HOSTS = new Set(
  ['localhost', '127.0.0.1', '::1'].concat(
    (process.env.PORTAL_ALLOWED_HOSTS || '').split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean)
  )
);

// Constant-time token compare. Length is checked first because timingSafeEqual throws on a
// length mismatch (and an early length check leaks only length, not content).
function portalTokenMatches(candidate) {
  if (!candidate) return false;
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(PORTAL_TOKEN);
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch (e) { return false; }
}

function parsePortalCookies(req) {
  const raw = (req.headers && req.headers.cookie) || '';
  const out = {};
  raw.split(';').forEach(function (part) {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

// Access gate. Returns true if the request may proceed; on rejection it has already written the
// 401/403 and the caller must `return`. Disabled entirely when PORTAL_TOKEN is unset.
// Token accepted from three sources: ?token= (login), cookie portal_token, header X-Portal-Token.
// A correct ?token= seeds an HttpOnly cookie so every later same-origin request (images / iframes /
// downloads / navigations) carries it — the frontend needs zero changes. /api/ping is exempt.
function passAuth(req, res, parsedUrl, pathname) {
  if (!PORTAL_TOKEN) return true;
  if (pathname === '/api/ping') return true;

  const hostName = ((req.headers && req.headers.host) || '').toLowerCase().split(':')[0];
  if (hostName && !PORTAL_ALLOWED_HOSTS.has(hostName)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden host');
    return false;
  }

  const fromQuery = parsedUrl.query && parsedUrl.query.token;
  if (fromQuery && portalTokenMatches(fromQuery)) {
    res.setHeader('Set-Cookie', 'portal_token=' + encodeURIComponent(PORTAL_TOKEN) + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000');
    return true;
  }
  const cookies = parsePortalCookies(req);
  if (portalTokenMatches(cookies.portal_token) || portalTokenMatches(req.headers['x-portal-token'])) return true;

  res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Unauthorized');
  return false;
}
// A random id per server process. The frontend polls it; when it changes (a deploy restarted the
// server onto a new version) the page auto-reloads to pick up the new code. See /api/ping.
const BOOT_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
// Set at boot if this process came back from a graceful POST /api/restart (the supervisor relaunched
// us). The frontend reads it from /api/status to show a one-time "已重新啟動完畢" line in chat.
let LAST_RESTART = null;
// When a restart is requested WHILE a chat job is running (the classic case: Hana self-modifies and
// deploys from inside her own turn), we must NOT exit immediately — that would kill the job before
// its reply is saved, losing the very conversation that triggered the self-heal. Instead we defer:
// flag it here, and exit only after the last in-flight job finishes + saves (see respondChat).
let RESTART_PENDING = false;
// Which release this process is running, derived from its own path (.releases/vN/portal → "vN").
// "dev" when running from the working tree. Deploy reads it to confirm the new version actually held
// (vs. the supervisor having auto-fallen-back to last-known-good after a boot-crash).
const RUNNING_VERSION = (() => {
  try { const b = path.basename(path.resolve(__dirname, '..')); return /^v\d+$/.test(b) ? b : 'dev'; }
  catch (e) { return 'dev'; }
})();
// Mutable so the workspace can be switched at runtime via /api/workspace/activate.
// Handlers read these at call-time, so reassigning them re-points the whole portal.
// Default project workspace: an explicit HARNESS_PROJECT_ROOT, else Hana's own install dir
// (HARNESS_HOME, set by the supervisor) — never a hardcoded machine path (open-source friendly).
let WORKSPACE_ROOT = path.resolve(process.env.HARNESS_PROJECT_ROOT || process.env.HARNESS_HOME || path.join(__dirname, '..'));
let WORKTABLE_DIR = path.join(WORKSPACE_ROOT, '.worktable');

// agy (Antigravity) CLI `--model` flag expects the EXACT model label as printed by
let activeBuildProcess = null;

console.log(`[Worktable Server] Root workspace path: ${WORKSPACE_ROOT}`);
console.log(`[Worktable Server] Worktable directory: ${WORKTABLE_DIR}`);

// Helper to check if a resolved path is safe (stays inside the workspace root)
function isPathSafe(targetPath, root = WORKSPACE_ROOT) {
  const resolved = path.resolve(targetPath);
  return resolved.startsWith(root);
}

function resolveWorkspace(req) {
  let root = req.headers['x-workspace'];
  // The X-Workspace header is %-encoded by the frontend (HTTP headers must be ASCII; workspace paths
  // can be non-ASCII, e.g. 範例專案). Decode it back to the real path.
  if (root) { try { root = decodeURIComponent(root); } catch (e) {} }
  if (!root && req.url) {
    const parsed = url.parse(req.url, true);
    if (parsed.query && parsed.query.workspace) {
      root = parsed.query.workspace;
    }
  }
  if (!root && req.headers.referer) {
    try {
      const refUrl = url.parse(req.headers.referer, true);
      if (refUrl.query && refUrl.query.workspace) {
        root = refUrl.query.workspace;
      }
    } catch (e) {}
  }
  // No PER-TAB source (header / ?workspace=) → fall back to the STABLE startup default. We deliberately
  // do NOT fall back to the active_workspace COOKIE or the registry's `active` here: both are SHARED
  // across browser tabs (a cookie is per-domain; reg.active is global), so one tab's workspace choice
  // would leak into another tab's headerless first request — exactly the multi-tab contamination bug.
  // WORKSPACE_ROOT is set once at startup (from reg.active) and is never mutated by an in-session
  // switch, so every headerless request resolves to the same stable default. Per-tab selection is
  // owned entirely by the frontend (sessionStorage → X-Workspace header on every request).
  if (!root) {
    root = WORKSPACE_ROOT;
  }
  root = path.resolve(root);
  const manifest = getManifest(root);
  const worktablePath = (manifest.worktable && manifest.worktable.path) || '.worktable';
  const worktableDir = path.join(root, worktablePath);
  const harnessDir = path.join(root, '.harness');
  const chatHistoryDir = path.join(harnessDir, 'runtime', 'chat_history');
  const knowledgeDir = path.join(harnessDir, 'knowledge');
  const commandsDir = path.join(harnessDir, 'commands');
  return {
    root,
    worktableDir,
    harnessDir,
    chatHistoryDir,
    knowledgeDir,
    commandsDir
  };
}

// Notes (Stickies) persistence lives in ./notes.js (shared with telegram.js + scheduler.js);
// server.js just delegates to it with HARNESS_HOME. See notesStore require at top of file.
function readNotes() { return notesStore.readNotes(HARNESS_HOME); }
function writeNotes(list) { notesStore.writeNotes(HARNESS_HOME, list); }

// PM (Project Management) persistence lives in ./pm.js (SPEC-project-management.md), same
// single-file + workspace-tag pattern as notes.js.
function readPm() { return pmStore.readPm(HARNESS_HOME); }
function writePm(data) { pmStore.writePm(HARNESS_HOME, data); }
function genNoteId() { return notesStore.genNoteId(); }
const NOTE_COLORS = notesStore.NOTE_COLORS;

// Run codegraph CLI tool and return JSON results
function runCodegraph(args, root, callback) {
  execFile('codegraph', args, { cwd: root, shell: true }, (error, stdout, stderr) => {
    if (error) {
      callback(error, null);
      return;
    }
    try {
      const data = JSON.parse(stdout);
      callback(null, data);
    } catch (parseErr) {
      callback(new Error(`Failed to parse codegraph JSON output: ${stdout || stderr}`), null);
    }
  });
}

// Only return codegraph results from the active codebase. The scope prefix comes from the
// active workspace's manifest (tools.codegraph.scope); empty scope = no filtering.
function getCodegraphScope(root) {
  try { return ((getManifest(root).tools.codegraph) || {}).scope || ''; } catch (e) { return ''; }
}

function filterCgByScope(items, filePathKey, root) {
  if (!Array.isArray(items)) return items;
  const scope = getCodegraphScope(root);
  if (!scope) return items;
  return items.filter(item => {
    const fp = filePathKey ? item[filePathKey] : (item.node ? item.node.filePath : item.filePath);
    return fp && fp.startsWith(scope);
  });
}

// Compile a simple glob (e.g. "*.html") to an anchored, case-insensitive RegExp.
function globToRegex(glob) {
  return new RegExp('^' + glob.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
}

// Function to recursively crawl a directory and return a nested folder/file tree.
// `filter` (optional glob like "*.html") restricts which FILES are included; directories
// whose filtered subtree ends up empty are pruned — this keeps source-asset folders
// (e.g. presentations/ep_N/ holding images + a manifest.md) out of an *.html section.
function getFolderTree(dirPath, relativeTo = WORKSPACE_ROOT, filter = null) {
  let results = [];
  if (!fs.existsSync(dirPath)) return results;

  const matchRe = filter ? globToRegex(filter) : null;
  const list = fs.readdirSync(dirPath);
  list.forEach(file => {
    // Skip hidden files/directories like .git, .next, node_modules
    if (file.startsWith('.')) return;

    const fullPath = path.join(dirPath, file);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch (e) {
      return; // Skip if stat fails
    }

    const relPath = path.relative(relativeTo, fullPath).replace(/\\/g, '/');

    if (stat && stat.isDirectory()) {
      const skipDirs = ['node_modules', '.next', 'publish', 'app_data', 'dist', 'build', '.git', '.turbo', '.antigravitycli', '.claude', '.codegraph', 'out'];
      if (skipDirs.includes(file)) return;

      const children = getFolderTree(fullPath, relativeTo, filter);
      if (children.length > 0) {
        results.push({
          type: 'directory',
          name: file,
          path: relPath,
          children
        });
      }
    } else if (file.endsWith('.md') || file.endsWith('.html') || file.endsWith('.bpmn')) {
      // When a section declares a filter (e.g. "*.html"), only matching files appear.
      if (matchRe && !matchRe.test(file)) return;
      results.push({
        type: 'file',
        name: file,
        path: relPath,
        mtime: stat.mtime
      });
    }
  });

  // Directories first, then natural (number-aware) order so episode2 sorts before episode10.
  return results.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

// ── Sync-call breadcrumbs (freeze forensics) ──────────────────────────────────
// The server is single-threaded: ANY synchronous call that blocks (spawnSync, a
// sync sqlite read) freezes the WHOLE event loop — /api/ping stops answering, 0%
// CPU, only an external kill recovers it. A frozen process can't be queried, but
// a log line written JUST BEFORE the blocking call survives. So we breadcrumb the
// risky sync calls: "→ X" before, "✓ X (Nms)" after. After a freeze, the LAST
// "→ X" with no matching "✓ X" names the exact culprit.
function traceSync(label, fn) {
  const _t = Date.now();
  console.log('[sync] → ' + label);
  try { return fn(); }
  finally { console.log('[sync] ✓ ' + label + ' (' + (Date.now() - _t) + 'ms)'); }
}

// Generic extension point: optional private plugins may register additional HTTP routes.
// Each handler is (req, res, pathname, parsedUrl) => boolean (true = it claimed the request).
// Absent in the public edition → the array simply stays empty and no routes are added.
const extraRoutes = [];

// Route table (SPEC-portal-architecture.md §3.2, TASK.md §B1/B2). Routes below are migrated out
// of the legacy if-chain in batches — each batch's exact prior behavior is preserved, only the
// dispatch mechanism changes. Anything not registered here still lives in the if-chain further
// down and is handled unchanged.
const apiRouter = new ApiRouter();

apiRouter.get('/api/manifest', (req, res) => {
  try {
    const wctx = resolveWorkspace(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ root: wctx.root, manifest: getManifest(wctx.root) }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

// PUT /api/manifest — write harness.json for a (whitelisted) workspace (SPEC-workspace-settings.md
// §4.2, TASK.md §W2). body.root picks the TARGET workspace to write (may differ from the caller's
// current X-Workspace — the settings UI can edit any registered workspace); falls back to
// resolveWorkspace(req) when omitted so a bare PUT still writes "the workspace I'm looking at".
apiRouter.put('/api/manifest', (req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    try {
      const patch = JSON.parse(body || '{}');
      let root;
      try { root = patch.root ? path.resolve(String(patch.root)) : resolveWorkspace(req).root; }
      catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid root' })); return; }

      // Whitelist: root must be a registered project or the harness's own home — never an
      // arbitrary path (this endpoint can create files, so this is the actual security boundary).
      const reg = loadRegistry();
      const known = reg.projects.map(p => normalizeRoot(p.root)).concat([normalizeRoot(WORKSPACE_ROOT)]);
      if (!known.includes(normalizeRoot(root))) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'root not in registered workspaces' }));
        return;
      }

      // Schema validation — reject the whole payload with a field-level message rather than
      // partially applying a malformed patch.
      const out = {};
      for (const f of ['name', 'subtitle', 'icon']) {
        if (patch[f] !== undefined) {
          if (typeof patch[f] !== 'string') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: f + ' must be a string' })); return; }
          out[f] = patch[f];
        }
      }
      if (patch.avatar !== undefined) {
        if (typeof patch.avatar !== 'string') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'avatar must be a string' })); return; }
        const resolvedAvatar = path.resolve(path.join(root, patch.avatar));
        if (patch.avatar && !isPathSafe(resolvedAvatar, root)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'avatar path escapes workspace' }));
          return;
        }
        out.avatar = patch.avatar;
      }
      if (patch.nav !== undefined) {
        if (typeof patch.nav !== 'object' || patch.nav === null || Array.isArray(patch.nav)) {
          res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'nav must be an object' })); return;
        }
        const nav = {};
        for (const k of Object.keys(patch.nav)) {
          if (!(k in DEFAULT_NAV)) continue; // unknown key: silently dropped (forward-compat)
          if (typeof patch.nav[k] !== 'boolean') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'nav.' + k + ' must be a boolean' })); return; }
          nav[k] = patch.nav[k];
        }
        out.nav = nav;
      }
      if (patch.sidebar !== undefined) {
        if (!patch.sidebar || !Array.isArray(patch.sidebar.sections)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'sidebar.sections must be an array' })); return; }
        const sections = [];
        for (const s of patch.sidebar.sections) {
          if (!s || typeof s.label !== 'string' || typeof s.icon !== 'string' || typeof s.path !== 'string' || typeof s.filter !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'sidebar.sections entries need string label/icon/path/filter' })); return;
          }
          const resolvedSecPath = path.resolve(path.join(root, s.path));
          if (!isPathSafe(resolvedSecPath, root)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'sidebar section path escapes workspace: ' + s.path })); return; }
          sections.push({ label: s.label, icon: s.icon, path: s.path, filter: s.filter });
        }
        out.sidebar = { sections };
      }
      if (patch.tools !== undefined) {
        if (typeof patch.tools !== 'object' || patch.tools === null || Array.isArray(patch.tools)) {
          res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'tools must be an object' })); return;
        }
        const tools = {};
        for (const k of ['codegraph', 'docgraph']) {
          if (!(k in patch.tools)) continue;
          const v = patch.tools[k];
          if (v !== null && (typeof v !== 'object' || Array.isArray(v))) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'tools.' + k + ' must be an object or null' })); return; }
          if (v !== null) tools[k] = v; // null = remove the tool (omit from output)
        }
        out.tools = tools;
      }

      const manifestPath = path.join(root, 'harness.json');
      // Merge onto whatever raw harness.json already exists so untouched top-level keys (e.g.
      // worktable/chat overrides not editable from this UI, per SPEC-workspace-settings §6) survive.
      let existing = {};
      try { if (fs.existsSync(manifestPath)) existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) {}
      if (fs.existsSync(manifestPath)) {
        try { fs.copyFileSync(manifestPath, manifestPath + '.bak'); } catch (e) { console.error('[Harness] manifest backup failed:', e.message); }
      }
      const merged = Object.assign({}, existing, out);
      fs.writeFileSync(manifestPath, JSON.stringify(merged, null, 2), 'utf8');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ root, manifest: getManifest(root) }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

// API: Workspace registry — list known projects + active root
apiRouter.get('/api/workspace', (req, res) => {
  const wctx = resolveWorkspace(req);
  const reg = loadRegistry();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ active: wctx.root, projects: reg.projects }));
});

apiRouter.get('/api/models', (req, res, ctx) => {
  getCliModels(ctx.parsedUrl.query.refresh === '1')
    .then(data => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); })
    .catch(err => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })); });
});

// API: slash-command registry for the input "/" menu (global + active-workspace commands).
apiRouter.get('/api/commands', (req, res) => {
  const wctx = resolveWorkspace(req);
  const cmds = loadCommands(wctx.commandsDir).map(c => ({ name: c.name, description: c.description, icon: c.icon, type: c.type, source: c.source }));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ commands: cmds }));
});

// API: lightweight liveness/version ping. The frontend polls this; a changed bootId means the
// server was restarted onto a new version (a deploy) → the page reloads to get the new code.
apiRouter.get('/api/ping', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ bootId: BOOT_ID, version: RUNNING_VERSION }));
});

// X3 (SPEC-chat-durability): best-effort snapshot of every in-flight chat turn to disk. Called by
// Deploy_Harness.ps1 right before it stops this port, and by our own SIGINT/SIGTERM handlers below.
// Honest caveat: on Windows, Stop-Process is a hard kill that never reaches a signal handler — X1
// (save-on-send) and X2 (throttled mid-run checkpoint) are the real safety net; this is a bonus for
// the paths that DO get a chance to run (graceful /api/restart, Ctrl+C, this explicit flush call).
function flushPendingChatTurns() {
  let flushed = 0;
  for (const ctx of jobs.values()) {
    if (ctx.status !== 'running') continue;
    saveChatPending(ctx, ctx._lastCheckpointTrace || []);
    flushed++;
  }
  return flushed;
}
apiRouter.post('/api/chat/flush', (req, res) => {
  const flushed = flushPendingChatTurns();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, flushed }));
});
['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, () => {
    try { const n = flushPendingChatTurns(); if (n) console.log(`[Chat] ${sig} — flushed ${n} in-flight turn(s) to disk.`); } catch (e) {}
    process.exit(0);
  });
});

// API: CLI limit-aware status (SPEC-resilient-cli Part B). Reactive only — reflects the outcome of
// real chat calls (no polling, no fabricated quota %). Frontend re-fetches after each turn.
apiRouter.get('/api/limits', (req, res) => {
  const now = Date.now();
  const list = Object.values(limitState).map(s => {
    let status = s.status;
    if (status === 'limited' && s.resetAt && new Date(s.resetAt).getTime() <= now) status = 'unknown';
    return Object.assign({}, s, { status, resetPassed: s.status === 'limited' && s.resetAt && new Date(s.resetAt).getTime() <= now });
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ models: list }));
});

// API: Get TTS voice configuration
apiRouter.get('/api/voice-config', (req, res) => {
  const configPath = path.join(GLOBAL_KNOWLEDGE_DIR, 'voice-config.json');
  let config = { voice: '', speed: 1.2, browsers: {} };
  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (e) {
    console.error('[Harness] Error reading voice config:', e);
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(config));
});

// GET /api/notes?status=&scope=
apiRouter.get('/api/notes', (req, res, ctx) => {
  const wctx = resolveWorkspace(req);
  const norm = p => { try { return path.resolve(String(p || '')).toLowerCase(); } catch (e) { return ''; } };
  const active = norm(wctx.root);
  const qp = ctx.parsedUrl.query;
  const status = qp.status || 'active';
  const scope = qp.scope || 'workspace';
  let list = readNotes();
  if (status !== 'all') list = list.filter(n => n.status === status);
  if (scope !== 'all') list = list.filter(n => norm(n.workspace || WORKSPACE_ROOT) === active);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(list));
});

// POST /api/notes — create. body {text, color?, x?, y?, dueAt?}
apiRouter.post('/api/notes', (req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    try {
      const data = JSON.parse(body || '{}');
      const text = String(data.text || '').trim();
      if (!text) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'text required' })); return; }
      const wctx = resolveWorkspace(req);
      const now = new Date().toISOString();
      const note = {
        id: genNoteId(),
        text,
        color: NOTE_COLORS.includes(data.color) ? data.color : 'yellow',
        x: typeof data.x === 'number' ? data.x : (0.08 + Math.random() * 0.55),
        y: typeof data.y === 'number' ? data.y : (0.08 + Math.random() * 0.55),
        z: Date.now(),
        w: typeof data.w === 'number' ? data.w : null,
        dueAt: data.dueAt || null,
        remindedAt: null,
        status: 'active',
        workspace: wctx.root,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      };
      const list = readNotes();
      list.push(note);
      writeNotes(list);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(note));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

// PUT /api/notes/:id — update text/color/x/y/z/w/dueAt/status
apiRouter.put('/api/notes/:id', (req, res, ctx) => {
  const nid = ctx.params.id;
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    try {
      const patch = JSON.parse(body || '{}');
      const list = readNotes();
      const idx = list.findIndex(n => n.id === nid);
      if (idx === -1) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return; }
      const note = list[idx];
      const FIELDS = ['text', 'color', 'x', 'y', 'z', 'w', 'dueAt', 'status'];
      for (const f of FIELDS) { if (f in patch) note[f] = patch[f]; }
      if ('color' in patch && !NOTE_COLORS.includes(note.color)) note.color = 'yellow';
      if ('status' in patch) {
        if (patch.status === 'done') { note.completedAt = new Date().toISOString(); note.remindedAt = null; }
        else if (patch.status === 'active') { note.completedAt = null; }
      }
      note.updatedAt = new Date().toISOString();
      list[idx] = note;
      writeNotes(list);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(note));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

// DELETE /api/notes/:id — permanent delete
apiRouter.delete('/api/notes/:id', (req, res, ctx) => {
  const nid = ctx.params.id;
  const list = readNotes();
  const next = list.filter(n => n.id !== nid);
  const ok = next.length !== list.length;
  if (ok) writeNotes(next);
  res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok }));
});

// Whiteboards (SPEC-whiteboard.md §5) — unlike notes/pm, genuinely per-workspace directory tree
// under <workspace>/.harness/whiteboards/ (天條: never written outside the current workspace).
const WHITEBOARD_MAX_BYTES = 8 * 1024 * 1024; // §5.1 soft warning threshold (front-end only)

// SPEC-whiteboard.md §8 (WB4/WB-15) — Hana (or any caller without a live Excalidraw instance, e.g. a
// CLI skill) posts bare-bones element descriptions; Excalidraw's renderer will crash/misbehave on
// elements missing internal bookkeeping fields (id/seed/versionNonce/version/…). This backfills every
// field Excalidraw actually needs, preserving anything the caller already supplied.
function _wbRandInt() { return Math.floor(Math.random() * 2147483647); }
function fillElementDefaults(el) {
  el = el && typeof el === 'object' ? el : {};
  const type = el.type || 'rectangle';
  const now = Date.now();
  const base = {
    id: el.id || ('el_' + now + '_' + Math.random().toString(36).slice(2, 8)),
    type,
    x: typeof el.x === 'number' ? el.x : 0,
    y: typeof el.y === 'number' ? el.y : 0,
    width: typeof el.width === 'number' ? el.width : 100,
    height: typeof el.height === 'number' ? el.height : 100,
    angle: typeof el.angle === 'number' ? el.angle : 0,
    strokeColor: el.strokeColor || '#1e1e1e',
    backgroundColor: el.backgroundColor || 'transparent',
    fillStyle: el.fillStyle || 'hachure',
    strokeWidth: typeof el.strokeWidth === 'number' ? el.strokeWidth : 2,
    strokeStyle: el.strokeStyle || 'solid',
    roughness: typeof el.roughness === 'number' ? el.roughness : 1,
    opacity: typeof el.opacity === 'number' ? el.opacity : 100,
    groupIds: Array.isArray(el.groupIds) ? el.groupIds : [],
    frameId: 'frameId' in el ? el.frameId : null,
    roundness: 'roundness' in el ? el.roundness : (type === 'rectangle' || type === 'diamond' || type === 'ellipse' ? { type: 3 } : null),
    seed: typeof el.seed === 'number' ? el.seed : _wbRandInt(),
    version: typeof el.version === 'number' ? el.version : 1,
    versionNonce: typeof el.versionNonce === 'number' ? el.versionNonce : _wbRandInt(),
    isDeleted: false,
    boundElements: 'boundElements' in el ? el.boundElements : null,
    updated: now,
    link: 'link' in el ? el.link : null,
    locked: !!el.locked
  };
  if (type === 'text') {
    base.text = el.text || '';
    base.fontSize = typeof el.fontSize === 'number' ? el.fontSize : 20;
    base.fontFamily = typeof el.fontFamily === 'number' ? el.fontFamily : 1;
    base.textAlign = el.textAlign || 'left';
    base.verticalAlign = el.verticalAlign || 'top';
    base.baseline = typeof el.baseline === 'number' ? el.baseline : base.fontSize;
    base.containerId = 'containerId' in el ? el.containerId : null;
    base.originalText = el.originalText || base.text;
    base.lineHeight = typeof el.lineHeight === 'number' ? el.lineHeight : 1.25;
  }
  if (type === 'arrow' || type === 'line') {
    base.points = Array.isArray(el.points) ? el.points : [[0, 0], [base.width, base.height]];
    base.lastCommittedPoint = 'lastCommittedPoint' in el ? el.lastCommittedPoint : null;
    // Excalidraw arrow binding — {elementId, focus, gap} — links an arrow endpoint to a shape so
    // dragging the shape drags the arrow with it (SPEC-whiteboard.md §8: 畫連線圖用).
    base.startBinding = 'startBinding' in el ? el.startBinding : null;
    base.endBinding = 'endBinding' in el ? el.endBinding : null;
    base.startArrowhead = 'startArrowhead' in el ? el.startArrowhead : null;
    base.endArrowhead = 'endArrowhead' in el ? el.endArrowhead : (type === 'arrow' ? 'arrow' : null);
  }
  if (type === 'freedraw') {
    base.points = Array.isArray(el.points) ? el.points : [[0, 0]];
    base.pressures = Array.isArray(el.pressures) ? el.pressures : [];
    base.simulatePressure = 'simulatePressure' in el ? el.simulatePressure : true;
    base.lastCommittedPoint = 'lastCommittedPoint' in el ? el.lastCommittedPoint : null;
  }
  return Object.assign({}, el, base);
}

// GET /api/whiteboards — list current workspace's boards
apiRouter.get('/api/whiteboards', (req, res) => {
  const wctx = resolveWorkspace(req);
  const list = whiteboardsStore.readIndex(wctx.root);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(list));
});

// POST /api/whiteboards — create. body {title?}
apiRouter.post('/api/whiteboards', (req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    try {
      const data = JSON.parse(body || '{}');
      const wctx = resolveWorkspace(req);
      const now = new Date().toISOString();
      const id = whiteboardsStore.genWhiteboardId();
      const title = String(data.title || '').trim() || '未命名白板';
      const meta = { id, title, createdAt: now, updatedAt: now };
      const board = { id, title, elements: [], appState: {}, files: {}, updatedAt: now };
      whiteboardsStore.writeBoard(wctx.root, id, board);
      const list = whiteboardsStore.readIndex(wctx.root);
      list.push(meta);
      whiteboardsStore.writeIndex(wctx.root, list);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(meta));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

// GET /api/whiteboards/:id — full board content
apiRouter.get('/api/whiteboards/:id', (req, res, ctx) => {
  const wctx = resolveWorkspace(req);
  const board = whiteboardsStore.readBoard(wctx.root, ctx.params.id);
  if (!board) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return; }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(board));
});

// PUT /api/whiteboards/:id — save. body {title?, elements?, appState?, files?}
apiRouter.put('/api/whiteboards/:id', (req, res, ctx) => {
  const id = ctx.params.id;
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    try {
      const patch = JSON.parse(body || '{}');
      const wctx = resolveWorkspace(req);
      const board = whiteboardsStore.readBoard(wctx.root, id);
      if (!board) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return; }
      const FIELDS = ['title', 'elements', 'appState', 'files'];
      for (const f of FIELDS) { if (f in patch) board[f] = patch[f]; }
      board.updatedAt = new Date().toISOString();
      whiteboardsStore.writeBoard(wctx.root, id, board);
      const list = whiteboardsStore.readIndex(wctx.root);
      const idx = list.findIndex(b => b.id === id);
      if (idx !== -1) {
        if ('title' in patch) list[idx].title = board.title;
        list[idx].updatedAt = board.updatedAt;
        whiteboardsStore.writeIndex(wctx.root, list);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: board.id, title: board.title, updatedAt: board.updatedAt }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

// DELETE /api/whiteboards/:id — permanent delete (destructive; front-end must confirm)
apiRouter.delete('/api/whiteboards/:id', (req, res, ctx) => {
  const wctx = resolveWorkspace(req);
  const board = whiteboardsStore.readBoard(wctx.root, ctx.params.id);
  if (!board) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return; }
  whiteboardsStore.deleteBoard(wctx.root, ctx.params.id);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
});

// POST /api/whiteboards/:id/elements — SPEC-whiteboard.md §8 (WB4/WB-15): Hana 也能畫。
// body { elements:[...], mode:'append'|'replace' }。elements 只需給有意義的欄位（type/x/y/…），
// 缺的內部欄位（id/seed/versionNonce/version…）由 fillElementDefaults 補齊，防止前端 Excalidraw 炸掉。
// mode=replace 也是「Hana 讀現有 elements、重算座標做對齊/等距排列」的寫回路徑（§8.2）。
apiRouter.post('/api/whiteboards/:id/elements', (req, res, ctx) => {
  const id = ctx.params.id;
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    try {
      const data = JSON.parse(body || '{}');
      const wctx = resolveWorkspace(req);
      const board = whiteboardsStore.readBoard(wctx.root, id);
      if (!board) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return; }
      const incoming = Array.isArray(data.elements) ? data.elements : [];
      const filled = incoming.map(fillElementDefaults);
      const mode = data.mode === 'replace' ? 'replace' : 'append';
      board.elements = mode === 'replace' ? filled : (Array.isArray(board.elements) ? board.elements : []).concat(filled);
      board.updatedAt = new Date().toISOString();
      whiteboardsStore.writeBoard(wctx.root, id, board);
      const list = whiteboardsStore.readIndex(wctx.root);
      const idx = list.findIndex(b => b.id === id);
      if (idx !== -1) { list[idx].updatedAt = board.updatedAt; whiteboardsStore.writeIndex(wctx.root, list); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, mode, count: filled.length, updatedAt: board.updatedAt }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

// POST /api/whiteboards/:id/interpret — SPEC-whiteboard.md §7 (WB3): 框選 AI 判讀。
// body { image: 'data:image/png;base64,...'（只含框內元素的截圖）, prompt?, mode:'text'|'custom', model? }
// 圖片落地在 <id>/assets/interpret_<ts>.png（天條：工作區內、隨白板生死），再用既有一次性模型呼叫
// （_spawnCliPrintOnce）帶絕對路徑要求模型 Read（比照 chat 多模態「路徑＋Read」既有模式，不塞 base64 進 prompt）。
const WB_INTERPRET_TIMEOUT_MS = 90000; // §7.2 護欄：單次逾時 90 秒
const WB_INTERPRET_MAX_BYTES = 20 * 1024 * 1024; // 框選截圖遠小於整張白板存檔，20MB 綽綽有餘
const WB_INTERPRET_VISION_PROVIDERS = new Set(['claude', 'gemini']); // 已知能透過 CLI Read 讀圖的 provider；其餘退回 Claude（D3）
let _wbInterpretInFlight = false; // §7.2 護欄：同一時間只允許一個判讀請求在跑（單人平台，全域鎖即可）

apiRouter.post('/api/whiteboards/:id/interpret', (req, res, ctx) => {
  const id = ctx.params.id;
  let body = '';
  let tooBig = false;
  req.on('data', c => { body += c; if (body.length > WB_INTERPRET_MAX_BYTES) tooBig = true; });
  req.on('end', async () => {
    if (tooBig) { res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '圖片過大' })); return; }
    if (_wbInterpretInFlight) { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '已有一個判讀請求在跑，請稍候再試' })); return; }
    let data;
    try { data = JSON.parse(body || '{}'); } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'bad json' })); return;
    }
    const wctx = resolveWorkspace(req);
    const board = whiteboardsStore.readBoard(wctx.root, id);
    if (!board) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return; }
    const m = String(data.image || '').match(/^data:image\/([a-z0-9.+-]+);base64,(.+)$/i);
    if (!m) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '缺少或格式錯誤的圖片' })); return; }
    const mode = data.mode === 'custom' ? 'custom' : 'text';
    const promptText = mode === 'custom'
      ? String(data.prompt || '').trim()
      : '辨識這張圖裡的手寫文字，只輸出文字本身，不要加說明';
    if (!promptText) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '自訂模式需要輸入 prompt' })); return; }

    _wbInterpretInFlight = true;
    try {
      const assetsDir = path.join(whiteboardsStore.boardDir(wctx.root, id), 'assets');
      fs.mkdirSync(assetsDir, { recursive: true });
      const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
      const imgPath = path.join(assetsDir, `interpret_${Date.now()}.${ext}`);
      fs.writeFileSync(imgPath, Buffer.from(m[2], 'base64'));

      // D3: 預設用目前 chat 選定的 provider/model；不支援讀圖（未知能力）的 provider 退回 Claude。
      const { provider: reqProvider } = parseChatModel(data.model || DEFAULT_CHAT_MODEL);
      const useDefault = !WB_INTERPRET_VISION_PROVIDERS.has(reqProvider);
      const provider = useDefault ? 'claude' : reqProvider;
      const modelArg = useDefault ? 'sonnet' : parseChatModel(data.model || DEFAULT_CHAT_MODEL).modelArg;

      const prompt = `請用 Read 工具開啟並讀取這張圖片：${imgPath}\n\n${promptText}\n\n只回覆結果本身，不要加多餘的說明、前言或客套話。`;
      let text = '';
      try {
        text = await _spawnCliPrintOnce({ provider, modelArg, prompt, wsRoot: wctx.root, timeoutMs: WB_INTERPRET_TIMEOUT_MS });
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '模型呼叫失敗：' + (e.message || String(e)) }));
        return;
      }
      text = (text || '').trim();
      if (!text || text.startsWith('❌') || text.startsWith('⚠️')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: text || '模型沒有回覆內容，可能是逾時、未安裝／未登入，或看不懂這張圖片' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || String(e) }));
    } finally {
      _wbInterpretInFlight = false;
    }
  });
});

// DELETE /api/chat/history/:sessionId/messages/:index — SPEC-chat-message-delete.md §Y.
// MUST live in the route table, not the legacy `pathname.startsWith('/api/chat/history/')`
// DELETE if-block further down (that one still owns whole-session delete via `split('/').pop()`,
// which would misread the trailing `/messages/:index` segment as the session id and wipe the
// whole session). apiRouter.dispatch() runs before the legacy if-chain, so this route wins.
apiRouter.delete('/api/chat/history/:sessionId/messages/:index', (req, res, ctx) => {
  const { sessionId } = ctx.params;
  const index = parseInt(ctx.params.index, 10);
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    try {
      const { expectRole, expectPrefix, cascadeNextAssistant } = JSON.parse(body || '{}');
      const wctx = resolveWorkspace(req);
      const sessionPath = path.join(wctx.chatHistoryDir, `chat_${sessionId}.json`);
      if (!fs.existsSync(sessionPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Chat history not found' }));
        return;
      }
      const data = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      const messages = Array.isArray(data.messages) ? data.messages : [];
      const msg = Number.isInteger(index) ? messages[index] : undefined;
      // Optimistic lock: index drift is easy (another tab, a stale render) — refuse rather than
      // guess which message the caller actually meant.
      if (!msg || msg.role !== expectRole
          || (typeof expectPrefix === 'string' && chatMsgText(msg).slice(0, expectPrefix.length) !== expectPrefix)) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'message mismatch' }));
        return;
      }

      const toRemove = [index];
      if (cascadeNextAssistant && msg.role === 'user' && messages[index + 1] && messages[index + 1].role === 'assistant') {
        toRemove.push(index + 1);
      }
      const removedSet = new Set(toRemove);
      const removedMessages = toRemove.map(i => messages[i]);
      const nextMessages = messages.filter((_, i) => !removedSet.has(i));

      // Only delete attachment files no SURVIVING message still references (same sandbox check
      // as the whole-session DELETE below: must resolve inside chatHistoryDir/attachments).
      const survivingPaths = new Set();
      nextMessages.forEach(m => (m.attachments || []).forEach(a => { if (a && a.path) survivingPaths.add(a.path); }));
      const attRoot = path.resolve(path.join(wctx.chatHistoryDir, 'attachments'));
      removedMessages.forEach(m => (m.attachments || []).forEach(a => {
        if (!a || !a.path || survivingPaths.has(a.path)) return;
        try {
          const abs = path.resolve(wctx.root, a.path);
          if (abs.startsWith(attRoot + path.sep) && fs.existsSync(abs)) fs.unlinkSync(abs);
        } catch (e) { console.error('[chat/delete-message] attachment cleanup failed:', e.message); }
      }));

      data.messages = nextMessages;
      fs.writeFileSync(sessionPath, JSON.stringify(data, null, 2), 'utf8');

      // Rewrite context_<sessionId>.md so the next turn doesn't resurrect the deleted content.
      // writeContextFile() no-ops on an empty array, so clear the file by hand in that case —
      // otherwise a stale context file with the deleted content would linger.
      const contextPath = path.join(wctx.chatHistoryDir, `context_${sessionId}.md`);
      if (nextMessages.length) writeContextFile(sessionId, nextMessages, wctx.chatHistoryDir);
      else if (fs.existsSync(contextPath)) { try { fs.unlinkSync(contextPath); } catch (e) {} }

      // `trace` (per-turn tool-call log) is session-level, not per-message — it is NOT cleaned up
      // here. That's an accepted limitation (SPEC-chat-message-delete.md §3.3): it doesn't feed
      // into context_*.md and so is never resent to the model, but it will still show the deleted
      // turn's tool activity if the session's trace log is inspected directly.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, removed: toRemove.length, messages: nextMessages }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

const server = http.createServer((req, res) => {
  // CORS Headers — tightened from '*' to same-origin (the portal is same-origin only; a wildcard
  // let any website script the API). X-Portal-Token added for the optional token gate.
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost:' + PORT);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Portal-Token');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // Access gate (SPEC-setup §12). No-op unless PORTAL_TOKEN is set.
  if (!passAuth(req, res, parsedUrl, pathname)) return;

  // Breadcrumb every API request (skip the high-frequency pollers). If the server
  // freezes, the LAST '[req]' line is the request that triggered it.
  if (pathname.startsWith('/api/') && pathname !== '/api/ping' && pathname !== '/api/jobs') {
    console.log('[req] ' + req.method + ' ' + pathname);
  }

  // Optional plugin routes — first handler to claim the request wins. Registered by the
  // plugin loader below; empty (no-op) in the public edition.
  for (const route of extraRoutes) {
    try { if (route(req, res, pathname, parsedUrl)) return; }
    catch (e) { console.error('[extraRoutes] handler error:', e.message); }
  }

  // Route table (B1/B2) — tried before the legacy if-chain. Routes not yet migrated fall through.
  if (apiRouter.dispatch(req, res, pathname, parsedUrl)) return;

  // P3 (SPEC-plugin-contract.md §4): plugin backend routes, forced under /api/x/<name>/*. Loaded
  // fresh per request (not mounted once at startup) because plugins are workspace-scoped and the
  // active workspace can change at runtime — see B3's ApiRouter.mount() for the shared wrapping
  // (ctx.workspace injection) this reuses on a throwaway router instance.
  if (pathname.indexOf('/api/x/') === 0) {
    handlePluginApiRoute(req, res, pathname, parsedUrl);
    return;
  }

  // Serve Frontend UI (index.html)
  if (pathname === '/' || pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(htmlPath)) {
      // no-cache: the SPA must never be served stale, or a UI change (new loadFile / iframe
      // logic) keeps running the OLD cached index.html — exactly the "raw?path= 404 / stale
      // behaviour" symptom. Always revalidate.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' });
      res.end(fs.readFileSync(htmlPath));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('index.html not found.');
    }
    return;
  }

  // R1: router core script, served like index.html (no generic root static handler exists —
  // other root-level portal/*.js files are loaded via /raw?path=... instead, but this one must be
  // reachable at a fixed URL since index.html <script src="/router.js"> can't know the workspace).
  if (pathname === '/router.js') {
    const routerPath = path.join(__dirname, 'router.js');
    if (fs.existsSync(routerPath)) {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
      res.end(fs.readFileSync(routerPath));
      return;
    }
  }

  // R3 (SPEC-portal-architecture.md §3.1, SPEC-plugin-contract.md §3): platform view modules,
  // dynamically import()-ed by router.js as views/<name>.js. §V13: every menu route now has a
  // view module here; the R5 legacy-panel fallback in router.js has been removed. Sandboxed the
  // same way /vendor/ is.
  // P2 (SPEC-plugin-contract.md §3): plugin view/style modules, served at /views/x/<name>.js|.css —
  // resolved to whichever tier (ship/global/project) won the plugin's `view`/`styles` file, NOT from
  // portal/views/ like the platform views below. Must run BEFORE the generic /views/ handler since
  // both share the '/views/' prefix.
  if (pathname.startsWith('/views/x/')) {
    const rest = decodeURIComponent(pathname.slice('/views/x/'.length));
    const ext = path.extname(rest).toLowerCase();
    const name = rest.slice(0, rest.length - ext.length);
    const wctx = resolveWorkspace(req);
    const plugin = getPlugins(wctx).find(p => p.name === name);
    const wantsStyles = ext === '.css';
    const file = wantsStyles ? plugin && plugin.styles : plugin && plugin.view;
    if (!plugin || !file || (ext !== '.js' && ext !== '.css')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return;
    }
    if (plugin.trust === 'code' && !plugin.enabled) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Plugin not trusted: ' + (plugin.disabledReason || name));
      return;
    }
    const full = path.resolve(plugin.dir, file);
    if (!isPathSafe(full, plugin.dir) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return;
    }
    res.writeHead(200, { 'Content-Type': (wantsStyles ? 'text/css' : 'text/javascript') + '; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
    res.end(fs.readFileSync(full));
    return;
  }

  if (pathname.startsWith('/views/')) {
    const vroot = path.join(__dirname, 'views');
    const full = path.resolve(vroot, decodeURIComponent(pathname.slice('/views/'.length)).replace(/^[/\\]+/, ''));
    if (!isPathSafe(full, vroot) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return;
    }
    const ct = path.extname(full).toLowerCase() === '.css' ? 'text/css' : 'text/javascript';
    res.writeHead(200, { 'Content-Type': ct + '; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
    res.end(fs.readFileSync(full));
    return;
  }

  // Portal shell modules (portal/shell/) — classic (non-module) <script src> JS extracted from
  // index.html's inline scripts (sidebar/header/theme/avatar-tts). Sandboxed the same way /views/ is.
  if (pathname.startsWith('/shell/')) {
    const sroot = path.join(__dirname, 'shell');
    const full = path.resolve(sroot, decodeURIComponent(pathname.slice('/shell/'.length)).replace(/^[/\\]+/, ''));
    if (!isPathSafe(full, sroot) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return;
    }
    const ct = path.extname(full).toLowerCase() === '.css' ? 'text/css' : 'text/javascript';
    res.writeHead(200, { 'Content-Type': ct + '; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
    res.end(fs.readFileSync(full));
    return;
  }

  // Vendored frontend libs for OFFLINE use (portal/vendor/). Served from a REAL directory URL so
  // CSS-relative font urls (bpmn.css → ../font/bpmn.woff2) and ESM relative imports (./min-dash.js)
  // resolve correctly — unlike /raw?path= where the URL's dir is "/". MIME incl. fonts.
  if (pathname.startsWith('/vendor/')) {
    const vroot = path.join(__dirname, 'vendor');
    const full  = path.resolve(vroot, decodeURIComponent(pathname.slice('/vendor/'.length)).replace(/^[/\\]+/, ''));
    if (!isPathSafe(full, vroot) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return;
    }
    const vt = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
      '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject',
      '.svg': 'image/svg+xml', '.map': 'application/json' };
    const ct = vt[path.extname(full).toLowerCase()] || 'application/octet-stream';
    // no-cache (not the old 24h max-age): these vendor files aren't truly immutable — Hana
    // patches them in place (e.g. pptx2html.js JSZip 3.x fixes). A 24h cache meant a deploy's
    // fix silently kept serving the pre-fix file to already-open browsers until the cache
    // expired, even after a hard page reload. Same reasoning as index.html's no-cache above.
    res.writeHead(200, { 'Content-Type': ct + (ct.startsWith('text/') ? '; charset=utf-8' : ''), 'Cache-Control': 'no-cache, must-revalidate' });
    fs.createReadStream(full).pipe(res);
    return;
  }

  // Serve a RAW workspace file with its real Content-Type (for iframe previews, e.g. an HTML
  // presentation the menu plays). Workspace-sandboxed via isPathSafe. /api/file returns JSON for
  // markdown rendering; this returns the file as-is so a browser/iframe runs it.
  if (pathname === '/raw') {
    let rel = parsedUrl.query.path;
    if (rel) {
      // Strip leading slashes to normalize relative paths
      rel = rel.replace(/^[/\\]+/, '');
    }
    const wctx = resolveWorkspace(req);
    let root = wctx.root;
    let full = rel ? path.resolve(root, rel) : null;
    if (rel && (rel.startsWith('portal/') || rel.startsWith('global-knowledge/')) && !fs.existsSync(full)) {
      // 優先從 Harness 程式根目錄 (__dirname 的上層) 尋找
      const progFull = path.resolve(path.join(__dirname, '..'), rel);
      if (fs.existsSync(progFull)) {
        root = path.join(__dirname, '..');
        full = progFull;
      } else {
        const altFull = path.resolve(HARNESS_HOME, rel);
        if (fs.existsSync(altFull)) {
          root = HARNESS_HOME;
          full = altFull;
        }
      }
    }
    if (!full || !isPathSafe(full, root) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return;
    }
    const types = { '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg' };
    const ext = path.extname(full).toLowerCase();
    const ct = types[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ct + (ct.startsWith('text/') ? '; charset=utf-8' : '') });
    
    if (ext === '.html') {
      let htmlContent = fs.readFileSync(full, 'utf8');
      if (htmlContent.includes('id="voiceSelect"') || full.includes('presentations')) {
        const injectScript = `
<style>
/* Hide the presentation's old static avatar and restore buttons */
#hanaAvatarFloat {
  display: none !important;
}
.hana-avatar-restore-btn {
  display: none !important;
}

/* Floating widget animations and core styling matching the portal */
@keyframes hana-float-idle {
  0%, 100% { transform: translateY(0px); }
  50%       { transform: translateY(-9px); }
}
@keyframes hana-float-thinking {
  0%, 100% { transform: translateY(0px) rotate(-1deg); }
  33%      { transform: translateY(-5px) rotate(1.2deg); }
  66%      { transform: translateY(-8px) rotate(-0.6deg); }
}
@keyframes hana-float-speaking {
  0%, 100% { transform: translateY(0px) scale(1); }
  50%      { transform: translateY(-3px) scale(1.025); }
}
#hana-float-circle {
  width: 120px; height: 120px;
  border-radius: 50%;
  overflow: hidden;
  border: 2.5px solid rgba(34,211,238,0.55);
  box-shadow: 0 0 18px rgba(34,211,238,0.25), 0 4px 16px rgba(0,0,0,0.4);
  background: #0f172a;
  flex-shrink: 0;
}
#hana-float-img {
  width: 120px; height: 120px;
  object-fit: contain;
  display: block;
  pointer-events: none;
  animation: hana-float-idle 3.5s ease-in-out infinite;
}
#hana-float-img.state-thinking { animation: hana-float-thinking 2s ease-in-out infinite; }
#hana-float-img.state-speaking { animation: hana-float-speaking 0.85s ease-in-out infinite; }

@keyframes hana-bubble-float {
  0%, 100% { transform: translateX(-50%) translateY(0); }
  50%       { transform: translateX(-50%) translateY(-5px); }
}
#hana-think-bubble { transition: opacity 0.35s; }
#hana-think-bubble.visible {
  opacity: 1 !important;
  animation: hana-bubble-float 1.8s ease-in-out infinite;
}

.hana-mode-btn { transition: all 0.2s ease; }
.hana-mode-btn:hover { transform: scale(1.12); }
.hana-mode-btn.active {
  background: rgba(8,145,178,0.5) !important;
  border-color: rgba(34,211,238,0.9) !important;
  box-shadow: 0 0 12px rgba(34,211,238,0.45);
}

#hana-icon-panel {
  opacity: 0;
  pointer-events: none;
  transform: translateX(6px);
  transition: opacity 0.2s ease, transform 0.2s ease;
}
#hana-float-widget:hover #hana-icon-panel {
  opacity: 1;
  pointer-events: auto;
  transform: translateX(0);
}

/* Global avatar hidden mode styling */
#hana-float-widget.avatar-hidden #hana-float-circle,
#hana-float-widget.avatar-hidden #hana-think-bubble,
#hana-float-widget.avatar-hidden #hana-mode-badge,
#hana-float-widget.avatar-hidden #hana-float-close-btn {
  display: none !important;
}
#hana-float-widget.avatar-hidden #hana-icon-panel {
  opacity: 1 !important;
  pointer-events: auto !important;
  transform: none !important;
}
#hana-float-widget.avatar-hidden #hana-float-restore-btn {
  display: flex !important;
}

#hana-float-widget:hover #hana-float-close-btn {
  opacity: 1;
}
#hana-float-close-btn:hover {
  background: #ef4444 !important;
  color: white !important;
  border-color: #ef4444 !important;
  transform: scale(1.1);
}
#hana-float-restore-btn:hover {
  background: rgba(6, 182, 212, 0.15) !important;
  border-color: #06b6d4 !important;
  box-shadow: 0 0 15px rgba(6, 182, 212, 0.5) !important;
  color: #fff !important;
  transform: scale(1.05);
}

/* Style footer as a floating controls bar in presentation mode */
.presentation-mode footer {
  position: fixed !important;
  bottom: 40px !important;
  left: 50% !important;
  transform: translateX(-50%) !important;
  z-index: 1000 !important;
  background: rgba(15, 23, 42, 0.85) !important;
  backdrop-filter: blur(10px) !important;
  -webkit-backdrop-filter: blur(10px) !important;
  border: 1px solid rgba(255, 255, 255, 0.15) !important;
  padding: 8px 16px !important;
  border-radius: 9999px !important;
  height: auto !important;
  width: auto !important;
  opacity: 0 !important;
  pointer-events: none !important;
  transition: opacity 0.3s ease !important;
  box-shadow: 0 10px 30px rgba(0,0,0,0.6) !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  border-top: none !important;
  padding-top: 8px !important;
}
.presentation-mode footer.visible {
  opacity: 1 !important;
  pointer-events: auto !important;
}
.presentation-mode footer .slide-number,
.presentation-mode footer .dots,
.presentation-mode footer input,
.presentation-mode footer .slideJumpInput {
  display: none !important;
}
.presentation-mode footer .controls {
  opacity: 1 !important;
  pointer-events: auto !important;
  display: flex !important;
  gap: 16px !important;
}
</style>

<script src="/raw?path=portal/tts-normalize.js"></script>
<script src="/raw?path=portal/presentation-player/hana-overlay.js"></script>
`;
        if (htmlContent.includes('</body>')) {
          htmlContent = htmlContent.replace('</body>', injectScript + '</body>');
        } else {
          htmlContent += injectScript;
        }
      }
      res.end(htmlContent);
    } else {
      res.end(fs.readFileSync(full));
    }
    return;
  }

  // API: docgraph (markdown governance knowledge graph) queries against the loaded project
  if (pathname.startsWith('/api/docgraph/')) {
    const wctx = resolveWorkspace(req);
    const op = pathname.slice('/api/docgraph/'.length);
    const id = parsedUrl.query.id || '';
    const q = (parsedUrl.query.q || '').toLowerCase();
    try {
      const payload = docgraph.withDb(wctx.root, (db) => {
        switch (op) {
          case 'stats': return docgraph.stats(db);
          case 'gaps':  return docgraph.gaps(db, getDocgraphProfile(wctx.root));
          case 'impact': return { node: docgraph.node(db, id), rows: docgraph.impact(db, id) };
          case 'refs':   return { node: docgraph.node(db, id), rows: docgraph.refs(db, id) };
          case 'trace':  return { node: docgraph.node(db, id), rows: docgraph.trace(db, id) };
          case 'search': {
            const rows = db.prepare(
              `SELECT id, type, title, file, defined FROM nodes
               WHERE LOWER(id) LIKE ? OR LOWER(IFNULL(title,'')) LIKE ?
               ORDER BY (type='DOC'), type, id LIMIT 40`
            ).all('%' + q + '%', '%' + q + '%');
            return { rows };
          }
          default: return null;
        }
      });
      if (payload === null) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Unknown docgraph op: ${op}` }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ project: wctx.root, ...payload }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: Get Status & Folder Trees (manifest-driven sections)
  if (pathname === '/api/status') {
    try {
      const wctx = resolveWorkspace(req);
      const manifest = getManifest(wctx.root);
      const worktableTree = getFolderTree(wctx.worktableDir, wctx.root);

      // Each configured sidebar section gets its directory tree.
      const sections = (manifest.sidebar.sections || []).map(s => ({
        label: s.label,
        icon: s.icon || 'folder',
        path: s.path,
        tree: getFolderTree(path.join(wctx.root, s.path), wctx.root, s.filter || null)
      }));

      const statusData = {
        workspaceRoot: wctx.root,
        manifest,
        bootId: BOOT_ID,
        version: RUNNING_VERSION,
        lastRestart: LAST_RESTART,
        dashboardExists: fs.existsSync(path.join(wctx.worktableDir, 'DASHBOARD.md')),
        taskExists: fs.existsSync(path.join(wctx.worktableDir, 'TASK.md')),
        worktable: worktableTree,
        sections,
        // P2 (SPEC-plugin-contract.md §3): workspace-contributed sidebar items. Frontend renders
        // these into #dynamic-sections as nav buttons (router.navigate('/app/x/<name>')), not
        // folder trees like `sections` above.
        plugins: getPlugins(wctx)
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(statusData));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /api/manifest, GET /api/workspace — migrated to the route table (TASK.md §B2 batch 1).

  // API: Activate (and auto-register) a workspace by absolute path
  if (pathname === '/api/workspace/activate' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { root } = JSON.parse(body || '{}');
        if (!root) throw new Error('缺少 root 參數');
        const resolved = path.resolve(root);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
          throw new Error('找不到目錄或不是資料夾: ' + resolved);
        }
        ensureHarnessScaffold(resolved);
        ensureGlobalScaffold();
        const scaffold = ensureWorktable(resolved);
        const reg = loadRegistry();
        if (!reg.projects.some(p => normalizeRoot(p.root) === normalizeRoot(resolved))) {
          reg.projects.push({ name: path.basename(resolved), root: resolved });
        }
        reg.active = resolved;
        saveRegistry(reg);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, active: resolved, scaffold }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // API: Rename a registered workspace's display name (does not touch the actual directory)
  if (pathname === '/api/workspace/rename' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { root, name } = JSON.parse(body || '{}');
        if (!root) throw new Error('缺少 root 參數');
        const trimmedName = (name || '').trim();
        if (!trimmedName) throw new Error('名稱不可為空');
        const resolved = path.resolve(root);
        const reg = loadRegistry();
        const entry = reg.projects.find(p => normalizeRoot(p.root) === normalizeRoot(resolved));
        if (!entry) throw new Error('找不到此工作區：' + resolved);
        entry.name = trimmedName;
        saveRegistry(reg);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, projects: reg.projects }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // API: Remove a workspace from the registry (unregister only — the folder on disk is untouched).
  // Refuses to remove the currently active workspace or the last remaining entry.
  if (pathname === '/api/workspace/remove' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { root } = JSON.parse(body || '{}');
        if (!root) throw new Error('缺少 root 參數');
        const resolved = path.resolve(root);
        const reg = loadRegistry();
        if (reg.projects.length <= 1) throw new Error('至少要保留一個工作區');
        if (normalizeRoot(reg.active) === normalizeRoot(resolved)) throw new Error('無法移除目前使用中的工作區，請先切換到其他工作區');
        const idx = reg.projects.findIndex(p => normalizeRoot(p.root) === normalizeRoot(resolved));
        if (idx === -1) throw new Error('找不到此工作區：' + resolved);
        reg.projects.splice(idx, 1);
        saveRegistry(reg);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, projects: reg.projects }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // API: CodeGraph Query
  if (pathname === '/api/codegraph/query') {
    const wctx = resolveWorkspace(req);
    const query = parsedUrl.query.query || '';
    const kind = parsedUrl.query.kind || '';
    const limit = parsedUrl.query.limit || '15';
    
    if (!query) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing query parameter' }));
      return;
    }
    
    const args = ['query', '-j', '-l', limit];
    if (kind) {
      args.push('-k', kind);
    }
    args.push(query);
    
    runCodegraph(args, wctx.root, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      } else {
        // Filter to active codebase scope only
        const filtered = filterCgByScope(data, null, wctx.root);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(filtered));
      }
    });
    return;
  }

  // API: CodeGraph Callers
  if (pathname === '/api/codegraph/callers') {
    const wctx = resolveWorkspace(req);
    const symbol = parsedUrl.query.symbol || '';
    const limit = parsedUrl.query.limit || '20';
    
    if (!symbol) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing symbol parameter' }));
      return;
    }
    
    runCodegraph(['callers', '-j', '-l', limit, symbol], wctx.root, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      } else {
        if (data && data.callers) {
          data.callers = filterCgByScope(data.callers, 'filePath', wctx.root);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      }
    });
    return;
  }

  // API: CodeGraph Callees
  if (pathname === '/api/codegraph/callees') {
    const wctx = resolveWorkspace(req);
    const symbol = parsedUrl.query.symbol || '';
    const limit = parsedUrl.query.limit || '20';
    
    if (!symbol) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing symbol parameter' }));
      return;
    }
    
    runCodegraph(['callees', '-j', '-l', limit, symbol], wctx.root, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      } else {
        if (data && data.callees) {
          data.callees = filterCgByScope(data.callees, 'filePath', wctx.root);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      }
    });
    return;
  }

  // API: CodeGraph Impact
  if (pathname === '/api/codegraph/impact') {
    const wctx = resolveWorkspace(req);
    const symbol = parsedUrl.query.symbol || '';
    const depth = parsedUrl.query.depth || '2';
    
    if (!symbol) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing symbol parameter' }));
      return;
    }
    
    runCodegraph(['impact', '-j', '-d', depth, symbol], wctx.root, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      } else {
        if (data && data.affected) {
          data.affected = filterCgByScope(data.affected, 'filePath', wctx.root);
          data.nodeCount = data.affected.length;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      }
    });
    return;
  }

  // API: Read Markdown File Content
  if (pathname === '/api/file') {
    const wctx = resolveWorkspace(req);
    const relativePath = parsedUrl.query.path;
    if (!relativePath) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing path query parameter' }));
      return;
    }

    const fullPath = path.resolve(wctx.root, relativePath);
    if (!isPathSafe(fullPath, wctx.root)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Access denied: Out of bounds' }));
      return;
    }

    if (!fs.existsSync(fullPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `File not found: ${relativePath}` }));
      return;
    }

    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      const stats = fs.statSync(fullPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        path: relativePath,
        fullPath: fullPath.replace(/\\/g, '/'),
        content,
        mtime: stats.mtime
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // POST /api/file/save — write content to a workspace-relative file (BPMN editor save / save-as).
  // isPathSafe-guarded; creates parent dirs; only allows known editable extensions.
  if (pathname === '/api/file/save' && req.method === 'POST') {
    const wctx = resolveWorkspace(req);
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const relPath = data.path;
        const content = data.content;
        if (!relPath || content === undefined) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing path or content' }));
          return;
        }
        const fullPath = path.resolve(wctx.root, relPath);
        if (!isPathSafe(fullPath, wctx.root)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Access denied: out of bounds' }));
          return;
        }
        if (!['.bpmn', '.svg', '.md'].includes(path.extname(fullPath).toLowerCase())) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'File type not allowed' }));
          return;
        }
        // K2-02 / K4-02: doc.md writeback — capture pre-write state before overwriting
        const wbCtx = {};
        if (path.extname(fullPath).toLowerCase() === '.md' && path.basename(fullPath) === 'doc.md') {
          const _wbDocId = docRegistry.docIdFromPath(wctx.root, fullPath);
          if (_wbDocId) {
            const _wbDocDir  = docRegistry.getDocumentDir(wctx.root, _wbDocId);
            const _wbSrc     = path.join(_wbDocDir, 'source.docx');
            const _wbSrcPptx = path.join(_wbDocDir, 'source.pptx');
            const _wbSrcFile = fs.existsSync(_wbSrc) ? _wbSrc
                             : fs.existsSync(_wbSrcPptx) ? _wbSrcPptx : null;
            if (_wbSrcFile) {
              wbCtx.docId   = _wbDocId;
              wbCtx.docDir  = _wbDocDir;
              if (_wbSrcFile === _wbSrc)    wbCtx.sourceDocx = _wbSrc;
              else                          wbCtx.sourcePptx = _wbSrcPptx;
              if (fs.existsSync(fullPath)) {
                try {
                  wbCtx.oldMd    = fs.readFileSync(fullPath, 'utf8');
                  wbCtx.mdMtime  = fs.statSync(fullPath).mtimeMs;
                } catch (e) {}
              }
              try {
                wbCtx.oldSource  = fs.readFileSync(_wbSrcFile);   // for COW history snapshot
                wbCtx.srcMtime   = fs.statSync(_wbSrcFile).mtimeMs;
              } catch (e) {}
            }
          }
        }
        // J8: capture BPMN "before" content (COW baseline) before overwriting
        let oldBpmnContent = null;
        if (path.extname(fullPath).toLowerCase() === '.bpmn' && fs.existsSync(fullPath)) {
          try { oldBpmnContent = fs.readFileSync(fullPath); } catch (e) {}
        }
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content, 'utf8');
        // Reverse sync: flow.json is the source of truth, .bpmn is its projection.
        let flowSynced = false;
        if (path.extname(fullPath).toLowerCase() === '.bpmn') {
          try {
            const { bpmnToFlow } = require('./render-service/flow-bpmn');
            const flowPath = fullPath.replace(/\.bpmn$/i, '.flow.json');
            fs.writeFileSync(flowPath, JSON.stringify(bpmnToFlow(content), null, 2), 'utf8');
            flowSynced = true;
          } catch (e) { console.error('[flow-sync] bpmn→flow failed:', e.message); }
          // Version history (DOC-J5/J8): editing a flowchart is a doc edit; snapshot the bpmn asset.
          try {
            const docId = docRegistry.docIdFromPath(wctx.root, fullPath);
            if (docId) {
              const reg = docRegistry.readRegistry(wctx.root);
              if (reg.documents.some(d => d.id === docId)) {
                const docDir      = docRegistry.getDocumentDir(wctx.root, docId);
                const assetRelPath = path.relative(docDir, fullPath).replace(/\\/g, '/');
                docRegistry.appendDocHistory(wctx.root, docId, {
                  kind: 'edit', by: 'Hana', summary: '編輯流程圖',
                  change: 'flow',
                  assets: [{ type: 'flow', path: assetRelPath, beforeContent: oldBpmnContent }],
                });
              }
            }
          } catch (e) { console.error('[DocHistory] flowchart edit log failed:', e.message); }
        }
        // K2-02 / K4-02: run writeback if this was a doc.md save with source.docx or source.pptx
        let writebackResult = null;
        if (wbCtx.docId) {
          const _isPptx    = !!wbCtx.sourcePptx;
          const _wbSrcFile = wbCtx.sourceDocx || wbCtx.sourcePptx;
          const _wbScriptName = _isPptx ? 'pptx-writeback.py' : 'docx-writeback.py';
          const _wbScript  = path.join(RENDER_SERVICE_DIR, _wbScriptName);
          const _wbFileArg = _isPptx ? '--pptx' : '--docx';
          const _srcLabel  = _isPptx ? 'source.pptx' : 'source.docx';
          // §9.4: if source file mtime is more than 2s newer than doc.md, skip writeback
          if ((wbCtx.srcMtime || 0) > (wbCtx.mdMtime || 0) + 2000) {
            writebackResult = { ok: true, changed: 0, warning: _srcLabel + ' newer than doc.md; writeback skipped' };
            console.warn('[K4] skipped writeback for', wbCtx.docId, '—', _srcLabel, 'modified externally');
          } else if (fs.existsSync(_wbScript)) {
            const _tmpBase = path.join(wbCtx.docDir, '_wb_base_tmp.md');
            try {
              fs.writeFileSync(_tmpBase, wbCtx.oldMd || '', 'utf8');
              const { spawnSync } = require('child_process');
              const _wbRun = spawnSync(
                venvPython(),
                [_wbScript, _wbFileArg, _wbSrcFile, '--new', fullPath, '--base', _tmpBase],
                { env: venvSpawnEnv(), timeout: 30000, encoding: 'utf8' }
              );
              if (_wbRun.status === 0) {
                try { writebackResult = JSON.parse(_wbRun.stdout.trim() || '{"ok":true,"changed":0}'); }
                catch (pe) { writebackResult = { ok: false, error: 'writeback json parse error' }; }
              } else {
                writebackResult = { ok: false, error: (_wbRun.stderr || 'writeback failed').slice(0, 300) };
                console.error('[K4] writeback failed for', wbCtx.docId, ':', writebackResult.error);
              }
            } catch (wbErr) {
              writebackResult = { ok: false, error: wbErr.message };
              console.error('[K4] writeback error:', wbErr.message);
            } finally {
              try { fs.unlinkSync(_tmpBase); } catch (e2) {}
            }
            // K2-03 / K4-02: append edit event + snapshot source file (J8 COW mechanism)
            if (writebackResult && writebackResult.ok && writebackResult.changed > 0) {
              try {
                docRegistry.appendDocHistory(wctx.root, wbCtx.docId, {
                  kind: 'edit', by: '老闆',
                  summary: `文字校修（回寫 ${writebackResult.changed} 段）`,
                  change: 'text',
                  assets: [{ type: 'source', path: _srcLabel, beforeContent: wbCtx.oldSource }],
                });
              } catch (he) { console.error('[K4] history append failed:', he.message); }
            }
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: relPath, flowSynced, writeback: writebackResult }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API: Toggle Checkbox in File
  if (pathname === '/api/toggle' && req.method === 'POST') {
    const wctx = resolveWorkspace(req);
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { filePath, lineIndex, originalText, checked } = JSON.parse(body);
        
        if (!filePath || lineIndex === undefined || originalText === undefined || checked === undefined) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required parameters' }));
          return;
        }

        const fullPath = path.resolve(wctx.root, filePath);
        if (!isPathSafe(fullPath, wctx.root)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Access denied: Out of bounds' }));
          return;
        }

        if (!fs.existsSync(fullPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'File not found' }));
          return;
        }

        const fileContent = fs.readFileSync(fullPath, 'utf8');
        const lines = fileContent.split(/\r?\n/);
        
        if (lineIndex < 0 || lineIndex >= lines.length) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Line index out of bounds' }));
          return;
        }

        const line = lines[lineIndex];
        const normalize = (str) => str.replace(/-\s*\[\s*[x ]\s*\]/, '- [ ]').trim();

        if (normalize(line) !== normalize(decodeURIComponent(originalText))) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            error: 'Conflict: File content changed.',
            currentLine: line,
            expectedLine: decodeURIComponent(originalText)
          }));
          return;
        }

        const newCheckedState = checked ? '- [x]' : '- [ ]';
        lines[lineIndex] = line.replace(/-\s*\[\s*[x ]\s*\]/, newCheckedState);
        
        const joinChar = fileContent.includes('\r\n') ? '\r\n' : '\n';
        fs.writeFileSync(fullPath, lines.join(joinChar), 'utf8');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, updatedLine: lines[lineIndex] }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // API: Real-Time Chunked Stream for PowerShell Deployment script execution (supports JSON inputs)
  if (pathname === '/api/deploy' && req.method === 'POST') {
    const wctx = resolveWorkspace(req);
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { protocol, dbSync, cleanMode, apps } = JSON.parse(body || '{}');

        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Transfer-Encoding': 'chunked'
        });

        const { spawn } = require('child_process');
        const psScript = path.join(wctx.root, '1_Build_And_Launch_Profile.ps1');

        // Map UI configuration to script parameters
        const autoMode = 'true';
        const protocolIn = protocol === 'https' ? '2' : '1';
        const dbSyncIn = dbSync ? 'Y' : 'N';
        const cleanModeIn = cleanMode ? 'Y' : 'N';
        const appStr = (apps && apps.length > 0) ? apps.join(',') : 'all';
        const noPause = 'true';

        res.write(`[Worktable Portal] --- Starting Non-Interactive Build & Deploy Pipeline ---\n`);
        res.write(`[Worktable Portal] Config: Protocol=${protocol.toUpperCase()}, DbSync=${dbSyncIn}, CleanMode=${cleanModeIn}, TargetApps=${appStr}\n`);
        res.write(`[Worktable Portal] Executing: 1_Build_And_Launch_Profile.ps1 -AutoMode ${autoMode} -ProtocolIn ${protocolIn} -DbSyncIn ${dbSyncIn} -CleanMode ${cleanModeIn} -App "${appStr}" -NoPause ${noPause}\n\n`);

        if (activeBuildProcess) {
          res.write(`[Worktable Portal] Warning: Terminating previous active deploy process...\n`);
          try {
            activeBuildProcess.kill('SIGINT');
          } catch (e) {}
          activeBuildProcess = null;
        }

        // Spawn PowerShell using -Command to ensure correct named parameters binding
        const psCommand = `& "${psScript}" -AutoMode true -ProtocolIn "${protocolIn}" -DbSyncIn "${dbSyncIn}" -CleanMode "${cleanModeIn}" -App "${appStr}" -NoPause true`;
        const child = spawn('powershell.exe', [
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-Command', psCommand
        ], {
          cwd: wctx.root,
          env: Object.assign({}, process.env, {
            PORTAL_PID: process.pid.toString()
          })
        });

        activeBuildProcess = child;

        child.stdout.on('data', (data) => {
          res.write(data);
        });

        child.stderr.on('data', (data) => {
          res.write(data);
        });

        child.on('error', (err) => {
          res.write(`\n[Server Error] Failed to launch PowerShell: ${err.message}\n`);
        });

        child.on('close', (code) => {
          res.write(`\n[Worktable Portal] --- Deployment Script Finished. Exit Code: ${code} ---\n`);
          res.end();
          if (activeBuildProcess === child) {
            activeBuildProcess = null;
          }
        });

        // Handle client connection abort (TCP close)
        res.on('close', () => {
          if (activeBuildProcess === child) {
            console.log('[Worktable Portal] Client closed connection, killing process...');
            try {
              child.kill('SIGINT');
            } catch (e) {}
            activeBuildProcess = null;
          }
        });
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // API: Abort ongoing deploy process
  if (pathname === '/api/deploy/abort' && req.method === 'POST') {
    if (activeBuildProcess) {
      try {
        activeBuildProcess.kill('SIGINT');
        activeBuildProcess = null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Process abort requested successfully.' }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'No active build process running.' }));
    }
    return;
  }

  // API: Get Chat Histories
  if (pathname === '/api/chat/history' && req.method === 'GET') {
    try {
      const wctx = resolveWorkspace(req);
      const list = getChatHistories(wctx.chatHistoryDir);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(list));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: F2 — sessions linked to a given file (filePath = relative-to-workspace path = stable key).
  // The floating chat uses this to offer 接續上次 / 開新對話 when you open a chat on a file.
  if (pathname === '/api/chat-sessions' && req.method === 'GET') {
    const wctx = resolveWorkspace(req);
    const target = (parsedUrl.query.filePath || '').toString();
    const out = [];
    try {
      if (target && fs.existsSync(wctx.chatHistoryDir)) {
        for (const file of fs.readdirSync(wctx.chatHistoryDir)) {
          if (!file.startsWith('chat_') || !file.endsWith('.json')) continue;
          try {
            const d = JSON.parse(fs.readFileSync(path.join(wctx.chatHistoryDir, file), 'utf8'));
            if (d.filePath && d.filePath === target) {
              let title = d.title;
              if (!title) {
                const fm = (d.messages || []).find(m => m.role === 'user' && typeof m.content === 'string');
                title = fm ? fm.content.slice(0, 30) : '無主題對話';
              }
              out.push({ sessionId: d.sessionId, title, updatedAt: d.updatedAt, filePath: d.filePath });
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
    out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions: out }));
    return;
  }

  // API: Get Specific Chat History
  if (pathname.startsWith('/api/chat/history/') && req.method === 'GET') {
    const wctx = resolveWorkspace(req);
    const sessionId = pathname.split('/').pop();
    const sessionPath = path.join(wctx.chatHistoryDir, `chat_${sessionId}.json`);
    
    if (!fs.existsSync(sessionPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Chat history not found' }));
      return;
    }
    
    try {
      const data = fs.readFileSync(sessionPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /api/models, GET /api/commands — migrated to the route table (TASK.md §B2 batch 1).

  // API: Rename a chat history session title
  if (pathname.startsWith('/api/chat/history/') && req.method === 'PATCH') {
    const wctx = resolveWorkspace(req);
    const sessionId = pathname.split('/').pop();
    const sessionPath = path.join(wctx.chatHistoryDir, `chat_${sessionId}.json`);
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { title } = JSON.parse(body || '{}');
        if (!fs.existsSync(sessionPath)) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return; }
        const data = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
        data.title = (title || '').slice(0, 120);
        fs.writeFileSync(sessionPath, JSON.stringify(data, null, 2), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, title: data.title }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // API: Delete a chat history session (in the active workspace)
  if (pathname.startsWith('/api/chat/history/') && req.method === 'DELETE') {
    const wctx = resolveWorkspace(req);
    const sessionId = pathname.split('/').pop();
    const sessionPath = path.join(wctx.chatHistoryDir, `chat_${sessionId}.json`);
    try {
      if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
      // MM-M1-04: attachments live and die with the conversation. Sanitise the id and confirm the
      // folder resolves inside chatHistoryDir before recursive-removing it (no orphans, no traversal).
      const attDir = path.join(wctx.chatHistoryDir, 'attachments', sessionId);
      if (/^[A-Za-z0-9_.-]+$/.test(String(sessionId)) && !String(sessionId).includes('..')
          && path.resolve(attDir).startsWith(path.resolve(wctx.chatHistoryDir) + path.sep)) {
        fs.rmSync(attDir, { recursive: true, force: true });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /api/ping, GET /api/limits, GET /api/voice-config — migrated to the route table (TASK.md §B2 batch 1).

  // API: Save TTS voice configuration
  if (pathname === '/api/voice-config' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const configPath = path.join(GLOBAL_KNOWLEDGE_DIR, 'voice-config.json');
        
        fs.mkdirSync(GLOBAL_KNOWLEDGE_DIR, { recursive: true });
        
        let config = { voice: '', speed: 1.2, browsers: {} };
        try {
          if (fs.existsSync(configPath)) {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          }
        } catch (e) {
          console.error('[Harness] Error reading voice config for merge:', e);
        }
        
        if (payload.browser) {
          config.browsers = config.browsers || {};
          config.browsers[payload.browser] = {
            voice: payload.voice || '',
            speed: typeof payload.speed === 'number' ? payload.speed : 1.2
          };
          config.voice = payload.voice || config.voice || '';
          config.speed = typeof payload.speed === 'number' ? payload.speed : (config.speed || 1.2);
        } else {
          config.voice = payload.voice || config.voice || '';
          config.speed = typeof payload.speed === 'number' ? payload.speed : (config.speed || 1.2);
          if (payload.browsers) {
            config.browsers = config.browsers || {};
            for (const k of Object.keys(payload.browsers)) {
              const bval = payload.browsers[k];
              if (typeof bval === 'string') {
                config.browsers[k] = bval;
              } else if (bval && typeof bval === 'object') {
                config.browsers[k] = {
                  voice: bval.voice || '',
                  speed: typeof bval.speed === 'number' ? bval.speed : 1.2
                };
              }
            }
          }
        }
        
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, config }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // API: request a graceful restart. We drop a marker (so the NEXT boot can announce "restart
  // complete") and then exit; the supervisor loop (Start_Harness.ps1) relaunches us on the version
  // current.json now points at. This is how a deploy/self-heal goes live with no human in the loop.
  if (pathname === '/api/restart' && req.method === 'POST') {
    const reason = (parsedUrl.query.reason || 'manual').toString().slice(0, 80);
    try {
      fs.mkdirSync(RELEASES_DIR, { recursive: true });
      fs.writeFileSync(path.join(RELEASES_DIR, 'restart-pending.json'),
        JSON.stringify({ reason, requestedAt: new Date().toISOString(), fromBootId: BOOT_ID }));
    } catch (e) { /* best effort — the restart still happens */ }
    const running = listRunningJobs().length;
    const deferred = running > 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, bootId: BOOT_ID, deferred, runningJobs: running }));
    if (deferred) {
      // A job (e.g. Hana's self-modify turn) is still running. Wait for it to finish + save, THEN
      // exit (respondChat triggers the exit). Safety: force the restart after 10 min if a job hangs.
      RESTART_PENDING = true;
      console.log(`\x1b[33m[Harness] ⏳ 新版本已就緒 (${reason})，等 ${running} 個工作完成後再套用（不會打斷 Hana）…\x1b[0m`);
      setTimeout(() => { if (RESTART_PENDING) { console.log('\x1b[33m[Harness] ⏳ 等待逾時（10 分鐘），現在直接套用新版。\x1b[0m'); killSpawnedChildren('重啟'); process.exit(0); } }, 10 * 60 * 1000);
    } else {
      console.log(`\x1b[32m[Harness] ✅ 正在套用新版 (${reason}) — 重新啟動中…\x1b[0m`);
      setTimeout(() => { killSpawnedChildren('重啟'); process.exit(0); }, 200);
    }
    return;
  }

  // API: list the currently-RUNNING jobs (the browser filters to its active workspace + reattaches)
  if (pathname === '/api/jobs' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jobs: listRunningJobs() }));
    return;
  }
  // API: explicitly abort a running job (the Stop button calls this — browser-close does NOT kill)
  if (pathname.startsWith('/api/jobs/') && pathname.endsWith('/abort') && req.method === 'POST') {
    const jobId = pathname.slice('/api/jobs/'.length, -('/abort'.length));
    const ok = abortJob(jobId);
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok }));
    return;
  }
  // API: poll a single job's status/result (a reopened browser uses this to reattach + finish)
  if (pathname.startsWith('/api/jobs/') && req.method === 'GET') {
    const jobId = pathname.slice('/api/jobs/'.length);
    const j = jobs.get(jobId);
    if (!j) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jobId: j.jobId, sessionId: j.activeSessionId, status: j.status,
      provider: j.provider, model: j.modelArg, workspace: j.wctx && j.wctx.root,
      startTime: j.startT, elapsedMs: j.elapsedMs || (Date.now() - j.startT),
      reply: j.result || null, history: j.history || null, thinking: j.thinking || null, trace: j.finalTrace || null,
      liveOutput: j.liveOutput || null
    }));
    return;
  }

  // API: Chat Dialogue — provider-routed to the matching local CLI
  // MM-M1-01: chat attachment upload. Lands the file under THIS workspace's chat_history so it's
  // isolated per-workspace and dies with the conversation (the DELETE handler rms the folder). Base64
  // JSON body (consistent with the doc-image upload path) — no multipart dep. Hard limits: ≤25MB per
  // file, ≤5 files per compose (client passes `staged`) → 413. Path-traversal proof: sessionId +
  // safeName are sanitised and the resolved path must stay inside chatHistoryDir.
  if (pathname === '/api/chat/upload' && req.method === 'POST') {
    const wctx = resolveWorkspace(req);
    const MAX_BYTES = 25 * 1024 * 1024;
    const MAX_BODY = 36 * 1024 * 1024;   // base64 inflates ~33%; cap the raw JSON body just above 25MB
    let body = '';
    let tooBig = false;
    req.on('data', chunk => {
      if (tooBig) return;
      body += chunk;
      if (body.length > MAX_BODY) {
        tooBig = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '檔案過大（單檔上限 25MB）' }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig) return;
      try {
        const { sessionId, name, dataUrl, staged } = JSON.parse(body || '{}');
        if (Number(staged) >= 5) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '單則最多 5 個附件' }));
          return;
        }
        // sessionId: only the id charset we generate (session_<ts>); never separators or `..`.
        const sid = String(sessionId || '');
        if (!sid || !/^[A-Za-z0-9_.-]+$/.test(sid) || sid.includes('..')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'sessionId 不合法' }));
          return;
        }
        // Decode base64 payload (data URL or raw base64).
        const m = String(dataUrl || '').match(/^data:([^;,]*)?(?:;base64)?,([\s\S]*)$/);
        const b64 = m ? m[2] : String(dataUrl || '');
        const mime = (m && m[1]) || '';
        let buf = null;
        try { buf = Buffer.from(b64, 'base64'); } catch (e) { buf = null; }
        if (!buf || !buf.length) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '附件內容空白或格式錯誤' }));
          return;
        }
        if (buf.length > MAX_BYTES) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '檔案過大（單檔上限 25MB）' }));
          return;
        }
        // safeName: basename only, strip separators/illegal chars, reject `..`; CJK kept for readable names.
        let safeName = path.basename(String(name || 'file')).replace(/[\\/]/g, '_').replace(/[\x00-\x1f<>:"|?*]/g, '_');
        if (!safeName || safeName === '.' || safeName.includes('..')) safeName = 'file';
        safeName = safeName.slice(0, 120);
        const ts = Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        const dir = path.join(wctx.chatHistoryDir, 'attachments', sid);
        const abs = path.join(dir, `${ts}_${safeName}`);
        // Defence in depth: the resolved absolute path must stay inside chatHistoryDir.
        const rootResolved = path.resolve(wctx.chatHistoryDir);
        if (!path.resolve(abs).startsWith(rootResolved + path.sep)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '路徑不合法' }));
          return;
        }
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(abs, buf);
        const rel = path.relative(wctx.root, abs).split(path.sep).join('/');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ path: rel, name: safeName, kind: attachmentKind(safeName, mime) }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (pathname === '/api/chat' && req.method === 'POST') {
    const wctx = resolveWorkspace(req);
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { sessionId, messages, model, effort, jobId: clientJobId, filePath, meetingId, pmProjectIds, context } = JSON.parse(body || '{}');

        if (!messages || !Array.isArray(messages)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing messages array' }));
          return;
        }

        const activeSessionId = sessionId || `session_${Date.now()}`;
        const selectedModel = model || DEFAULT_CHAT_MODEL;
        const { provider, modelArg } = parseChatModel(selectedModel);
        console.log(`[Chat API] provider=${provider} model="${modelArg}"`);

        // SPEC-view-chat-context.md §3.4/CTX1: prefer the new single `context` param (any view via
        // getChatContext()); if the caller only sent the legacy filePath/meetingId/pmProjectIds
        // fields (older front-end code, Telegram, etc.), convert them in-place so buildChatPrompt
        // only ever has to look at one shape. filePath/meetingId/pmProjectIds themselves are left
        // untouched below — session save/resume/reattach still key off them exactly as before.
        const chatContext = (context && context.kind) ? context
          : (filePath ? { kind: 'file', payload: { filePath } }
          : (meetingId ? { kind: 'meeting', payload: { meetingId } }
          : ((Array.isArray(pmProjectIds) && pmProjectIds.length) ? { kind: 'pm', payload: { pmProjectIds } } : null)));

        // --- Slash-command interception (runs BEFORE any CLI) ---------------------------------
        // The portal resolves commands itself so behaviour is identical across all CLIs.
        const lastText = chatMsgText(messages[messages.length - 1]);
        const cmd = detectCommand(lastText);
        // The ctx IS the job: it carries a captured workspace context (wctx) so it stays correct
        // even if the user switches workspace while it runs, and it's registered so it survives a
        // browser disconnect and can be listed/aborted/reattached.
        const jobId = clientJobId || ('job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
        const ctx = { req, res, messages, activeSessionId, modelArg, provider, effort, startT: Date.now(), jobId, wctx: snapshotWctx(wctx), status: 'running', filePath: filePath || null, meetingId: meetingId || null, pmProjectIds: Array.isArray(pmProjectIds) && pmProjectIds.length ? pmProjectIds : null, context: chatContext };
        jobs.set(jobId, ctx);
        // X1 (SPEC-chat-durability): the user's message must hit disk BEFORE it's handed to a CLI —
        // a Deploy/crash/kill between here and finalize used to lose the whole turn (it only lived
        // in memory). Best-effort: never let a save failure block the actual chat request.
        saveChatPending(ctx, []);
        if (cmd) {
          const def = loadCommands(wctx.commandsDir).find(c => c.name === cmd.name);
          // /memory (builtin): ALWAYS distil from THIS conversation. Any text the user typed
          // after /memory is STEERING (what to focus on / pin), not content to store verbatim —
          // the memory must be grounded in the actual history, not just echo the command.
          if (def && def.type === 'builtin' && def.name === 'memory') {
            ctx.memoryIntent = true;
            ctx.fullPrompt = buildMemoryUpdatePrompt(messages, cmd.rest, wctx.knowledgeDir);
            if (provider === 'gemini') chatViaGemini(ctx);
            else if (provider === 'codex') chatViaCodex(ctx);
            else if (provider === 'grok') chatViaGrok(ctx);
            else chatViaClaude(ctx);
            return;
          }
          // prompt-type command: expand its template with the args, then run as a normal turn.
          if (def && def.type === 'prompt') {
            // `extends`: a project skill inherits a base skill's body (e.g. /deck extends the
            // 簡報通則). Portal stitches the base in front so the rules are always applied —
            // not dependent on the model remembering to go read the base file.
            let body = def.body;
            if (def.extends) {
              const base = loadCommands(wctx.commandsDir).find(c => c.name === def.extends);
              if (base) body = base.body + '\n\n--- 以上為繼承的通則；以下為本技能的特化 ---\n\n' + body;
            }
            // SKILL-SHELL: a skill used to be sent NAKED (fullPrompt = 技能本文), bypassing
            // buildChatPrompt entirely — no 聊天外殼、no 長期記憶/人設、no 對話歷史、no 使用者原文。
            // 後果：(a) 技能本文若沒寫 {{args}}，使用者打在指令後的文字被靜默丟棄；(b) 模型收到一張
            // 「沒有請求對象」的指示單，只有夠強的模型撐得住，換個模型就回「你沒有給我任務」；
            // (c) 沒有人設 → 回覆變英文。修法：技能一律走與一般對話相同的 prompt 外殼，技能本文
            // 當作「本次要執行的指示」附在後面；使用者原文永遠保留在「使用者問題」裡，不再遺失。
            const hasArgsSlot = /\{\{\s*args\s*\}\}/.test(body);
            body = body.replace(/\{\{\s*args\s*\}\}/g, cmd.rest);
            if (!hasArgsSlot && cmd.rest && cmd.rest.trim()) {
              body += `\n\n--- 本次指令參數（使用者打在 /${cmd.name} 後面的原文）---\n${cmd.rest.trim()}\n`;
            }
            const skillCtxFile = writeContextFile(activeSessionId, messages.slice(0, -1), wctx.chatHistoryDir);
            ctx.fullPrompt = buildChatPrompt(messages, skillCtxFile, wctx, ctx.context)
              + `\n\n=== 本次要執行的技能：/${cmd.name} ===\n`
              + '（上面「使用者問題」是使用者的原始輸入；斜線指令後面的文字就是本次技能的參數。請依下列技能指示執行，不要只是複述它。）\n\n'
              + body
              + `\n=== 技能指示結束 ===\n`;
            if (provider === 'gemini') chatViaGemini(ctx);
            else if (provider === 'codex') chatViaCodex(ctx);
            else if (provider === 'grok') chatViaGrok(ctx);
            else chatViaClaude(ctx);
            return;
          }
          // Unknown command → fall through and treat as a normal message.
        }

        // MM-M2-01 / MM-M3-01: some attachments need server-side pre-processing BEFORE the prompt is
        // built (buildChatPrompt is sync), so it can inject real content instead of just a path:
        //   • audio (mp3/m4a/wav) → sttTranscribe → transcript                       (M2, engine现成)
        //   • video (mp4/…)       → ffmpeg extract audio→STT + keyframes→JPG for Read (M3, 需 ffmpeg)
        //   • office (docx/xlsx/pptx) → run the existing converter → doc.md for Read  (M3, Office 深度)
        // Every derived file is written INSIDE the attachment's own attachments/<sid>/ folder (天条:
        // 只写当前工作区、随对话删除). Failure degrades honestly — the error is surfaced, never faked.
        const lastMsgForAtt = messages[messages.length - 1];
        const attsForPrep = (lastMsgForAtt && Array.isArray(lastMsgForAtt.attachments)) ? lastMsgForAtt.attachments : [];
        const rootResolvedPrep = path.resolve(wctx.root);
        // resolve an attachment's stored (workspace-relative) path back to a safe absolute path inside
        // the workspace, or null if it escapes / doesn't exist.
        const _attAbs = (rel) => {
          if (!rel) return null;
          const abs = path.resolve(rootResolvedPrep, String(rel));
          if (abs !== rootResolvedPrep && !abs.startsWith(rootResolvedPrep + path.sep)) return null;
          return (fs.existsSync(abs) && fs.statSync(abs).isFile()) ? abs : null;
        };
        const _toRel = (abs) => path.relative(rootResolvedPrep, abs).split(path.sep).join('/');
        for (const a of attsForPrep) {
          if (!a || !a.path) continue;
          const abs = _attAbs(a.path);
          if (!abs) continue;

          if (a.kind === 'audio') {
            try {
              const r = await sttTranscribe({ audio: abs, lang: 'auto', model: 'medium', beamSize: 1 });
              a.transcript = (r && r.text) || '';
            } catch (e) { a.transcriptError = e.message || String(e); }
            continue;
          }

          if (a.kind === 'video') {
            const vp = require('./render-service/video-preprocess');
            if (!vp.ffmpegAvailable()) {
              a.videoError = 'ffmpeg 未安裝或不在 PATH，無法從影片抽音軌/影格。請先安裝 ffmpeg 並重啟 portal。';
              continue;
            }
            const dir = path.dirname(abs);
            const base = path.basename(abs).replace(/\.[^.]+$/, '');
            // ① audio track → STT transcript (best-effort; a silent video simply has no transcript)
            try {
              const wav = path.join(dir, `${base}.audio.wav`);
              vp.extractAudio(abs, wav);
              const r = await sttTranscribe({ audio: wav, lang: 'auto', model: 'medium', beamSize: 1 });
              a.transcript = (r && r.text) || '';
            } catch (e) { a.transcriptError = e.message || String(e); }
            // ② keyframes → images Hana can Read
            try {
              const frames = vp.extractKeyframes(abs, dir, base, 6);
              if (frames.length) a.frames = frames.map(_toRel);
            } catch (e) { a.framesError = e.message || String(e); }
            continue;
          }

          if (a.kind === 'office') {
            // Office 深度: a binary .docx/.xlsx/.pptx is opaque to Read → run the same mechanical
            // converter the document registry uses (--import <file> <doc_dir>) to get a real doc.md.
            const ext = (path.extname(abs).toLowerCase());
            const convName = ext === '.xlsx' ? 'xlsx-convert.py'
              : ext === '.pptx' ? 'pptx-convert.py'
              : (ext === '.docx' || ext === '.doc') ? 'docx-convert.py' : null;
            if (!convName) continue;   // .xls/.ppt/odt → no converter; leave M1 path-only injection
            try {
              const convDir = path.join(path.dirname(abs), path.basename(abs) + '.converted');
              const { spawnSync } = require('child_process');
              const cr = spawnSync(venvPython(),
                [path.join(RENDER_SERVICE_DIR, convName), '--import', abs, convDir],
                { env: venvSpawnEnv(), timeout: 120000, encoding: 'utf8' });
              const mdAbs = path.join(convDir, 'doc.md');
              if (cr.status === 0 && fs.existsSync(mdAbs)) a.officeMd = _toRel(mdAbs);
              else a.officeError = (cr.stderr || cr.error && cr.error.message || '轉換失敗').toString().slice(0, 300);
            } catch (e) { a.officeError = e.message || String(e); }
            continue;
          }
        }

        // v2a: persist the full prior transcript to a file the agent can read, then build a
        // compact prompt that points at it (continuity without bloating argv/stdin).
        const contextFilePath = writeContextFile(activeSessionId, messages.slice(0, -1), wctx.chatHistoryDir);
        ctx.fullPrompt = buildChatPrompt(messages, contextFilePath, wctx, ctx.context);

        if (provider === 'gemini') { chatViaGemini(ctx); return; }
        if (provider === 'codex')  { chatViaCodex(ctx);  return; }
        if (provider === 'grok')   { chatViaGrok(ctx);   return; }
        chatViaClaude(ctx);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ===== Notes API (Stickies, SN1) =====================================
  // 便條看板：single global-knowledge/notes/notes.json, workspace-tagged (schedules.json pattern).
  // `text` is stored/returned as-is; the client MUST render it via textContent (never innerHTML) —
  // this endpoint does not sanitize/escape, so a raw <script> round-trips as plain JSON string data.

  // GET/POST /api/notes, PUT/DELETE /api/notes/:id — migrated to the route table (see apiRouter.*
  // registrations near the top of this file, TASK.md §B2 batch 1).

  // ===== Project Management API (PM1, SPEC-project-management.md §4) ====
  // 專案管理：single global-knowledge/pm/pm.json, workspace-tagged on Project (schedules.json /
  // notes.json pattern). Task carries no workspace of its own — isolation is via
  // projectId -> project.workspace (same convention as schedule runs -> scheduleId -> workspace).
  // `name`/`description` are stored/returned as-is; the client MUST render via textContent, never
  // innerHTML — this endpoint does not sanitize/escape.

  function pmNorm(p) { return pmStore.normWs(p); }

  // GET /api/pm/projects?scope=workspace|all&includeArchived=0|1
  if (pathname === '/api/pm/projects' && req.method === 'GET') {
    const wctx = resolveWorkspace(req);
    const active = pmNorm(wctx.root);
    const qp = parsedUrl.query;
    const scope = qp.scope || 'workspace';
    const includeArchived = qp.includeArchived === '1';
    const { projects } = readPm();
    let list = projects;
    if (scope !== 'all') list = list.filter(p => pmNorm(p.workspace || WORKSPACE_ROOT) === active);
    if (!includeArchived) list = list.filter(p => !p.archived);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
    return;
  }

  // POST /api/pm/projects — create. body {name, description?, color?}
  if (pathname === '/api/pm/projects' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const name = String(data.name || '').trim();
        if (!name) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'name required' })); return; }
        const wctx = resolveWorkspace(req);
        const now = new Date().toISOString();
        const project = {
          id: pmStore.genProjectId(),
          name,
          description: data.description ? String(data.description) : '',
          color: data.color ? String(data.color) : null,
          workspace: wctx.root,
          archived: false,
          createdAt: now,
          updatedAt: now,
        };
        const pm = readPm();
        pm.projects.push(project);
        writePm(pm);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(project));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // PUT /api/pm/projects/:id — update name/description/color/archived
  const pmProjectIdMatch = pathname.match(/^\/api\/pm\/projects\/([^/]+)$/);
  if (pmProjectIdMatch && req.method === 'PUT') {
    const pid = pmProjectIdMatch[1];
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const patch = JSON.parse(body || '{}');
        const pm = readPm();
        const idx = pm.projects.findIndex(p => p.id === pid);
        if (idx === -1) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return; }
        const project = pm.projects[idx];
        const FIELDS = ['name', 'description', 'color', 'archived'];
        for (const f of FIELDS) { if (f in patch) project[f] = patch[f]; }
        project.updatedAt = new Date().toISOString();
        pm.projects[idx] = project;
        writePm(pm);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(project));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // DELETE /api/pm/projects/:id — permanently delete project + all its tasks (destructive)
  if (pmProjectIdMatch && req.method === 'DELETE') {
    const pid = pmProjectIdMatch[1];
    const pm = readPm();
    const nextProjects = pm.projects.filter(p => p.id !== pid);
    const ok = nextProjects.length !== pm.projects.length;
    if (ok) {
      pm.projects = nextProjects;
      pm.tasks = pm.tasks.filter(t => t.projectId !== pid);
      writePm(pm);
    }
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok }));
    return;
  }

  // GET /api/pm/projects/:id/tasks — list tasks for project, ordered by `order`
  const pmProjectTasksMatch = pathname.match(/^\/api\/pm\/projects\/([^/]+)\/tasks$/);
  if (pmProjectTasksMatch && req.method === 'GET') {
    const pid = pmProjectTasksMatch[1];
    const wctx = resolveWorkspace(req);
    const pm = readPm();
    const project = pm.projects.find(p => p.id === pid);
    if (!project || pmNorm(project.workspace || WORKSPACE_ROOT) !== pmNorm(wctx.root)) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return;
    }
    const list = pm.tasks.filter(t => t.projectId === pid).sort((a, b) => (a.order || 0) - (b.order || 0));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
    return;
  }

  // GET /api/pm/projects/:id/export — single-project Excel export (總覽/清單/甘特圖 tabs, formula-linked).
  const pmProjectExportMatch = pathname.match(/^\/api\/pm\/projects\/([^/]+)\/export$/);
  if (pmProjectExportMatch && req.method === 'GET') {
    const pid = pmProjectExportMatch[1];
    (async () => {
      try {
        const wctx = resolveWorkspace(req);
        const pm = readPm();
        const project = pm.projects.find(p => p.id === pid);
        if (!project || pmNorm(project.workspace || WORKSPACE_ROOT) !== pmNorm(wctx.root)) {
          res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return;
        }
        const tasks = pm.tasks.filter(t => t.projectId === pid).sort((a, b) => (a.order || 0) - (b.order || 0));
        const wb = buildPmWorkbook(project, tasks);
        const buf = await wb.xlsx.writeBuffer();
        const fname = project.name.replace(/[\\/:*?"<>|]/g, '_') + '.xlsx';
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(fname),
          'Content-Length': buf.length,
        });
        res.end(buf);
      } catch (e) {
        console.error('[pm-export] error:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    })();
    return;
  }

  // POST /api/pm/projects/:id/tasks — create. body {name, start?, end?, progress?, status?, deps?, isMilestone?, color?}
  if (pmProjectTasksMatch && req.method === 'POST') {
    const pid = pmProjectTasksMatch[1];
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const name = String(data.name || '').trim();
        if (!name) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'name required' })); return; }
        const wctx = resolveWorkspace(req);
        const pm = readPm();
        const project = pm.projects.find(p => p.id === pid);
        if (!project || pmNorm(project.workspace || WORKSPACE_ROOT) !== pmNorm(wctx.root)) {
          res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return;
        }
        const today = pmStore.localDateStr(new Date());
        const start = data.start || today;
        const end = data.end || pmStore.addDaysStr(start, 1);
        // deps: only same-project, non-self (task doesn't exist yet so self-ref impossible), no cycle
        let deps = [];
        if (Array.isArray(data.deps)) {
          const sameProjectIds = new Set(pm.tasks.filter(t => t.projectId === pid).map(t => t.id));
          deps = data.deps.filter(d => sameProjectIds.has(d));
        }
        const maxOrder = pm.tasks.filter(t => t.projectId === pid).reduce((m, t) => Math.max(m, t.order || 0), -1);
        const now = new Date().toISOString();
        const task = {
          id: pmStore.genTaskId(),
          projectId: pid,
          name,
          start,
          end,
          progress: typeof data.progress === 'number' ? data.progress : 0,
          status: ['todo', 'in_progress', 'done'].includes(data.status) ? data.status : 'todo',
          deps,
          isMilestone: !!data.isMilestone,
          order: maxOrder + 1,
          color: data.color ? String(data.color) : null,
          baseline: null,
          createdAt: now,
          updatedAt: now,
        };
        pm.tasks.push(task);
        writePm(pm);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(task));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /api/pm/tasks/:id/baseline — snapshot current start/end into baseline
  const pmTaskBaselineMatch = pathname.match(/^\/api\/pm\/tasks\/([^/]+)\/baseline$/);
  if (pmTaskBaselineMatch && req.method === 'POST') {
    const tid = pmTaskBaselineMatch[1];
    const wctx = resolveWorkspace(req);
    const pm = readPm();
    const idx = pm.tasks.findIndex(t => t.id === tid);
    if (idx === -1) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return; }
    const task = pm.tasks[idx];
    const project = pm.projects.find(p => p.id === task.projectId);
    if (!project || pmNorm(project.workspace || WORKSPACE_ROOT) !== pmNorm(wctx.root)) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return;
    }
    task.baseline = { start: task.start, end: task.end };
    task.updatedAt = new Date().toISOString();
    pm.tasks[idx] = task;
    writePm(pm);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(task));
    return;
  }

  // PUT /api/pm/tasks/:id — update name/start/end/progress/status/deps/isMilestone/order/color/baseline
  // DELETE /api/pm/tasks/:id — delete, and scrub other tasks' deps referencing it
  const pmTaskIdMatch = pathname.match(/^\/api\/pm\/tasks\/([^/]+)$/);
  if (pmTaskIdMatch && req.method === 'PUT') {
    const tid = pmTaskIdMatch[1];
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const patch = JSON.parse(body || '{}');
        const wctx = resolveWorkspace(req);
        const pm = readPm();
        const idx = pm.tasks.findIndex(t => t.id === tid);
        if (idx === -1) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return; }
        const task = pm.tasks[idx];
        const project = pm.projects.find(p => p.id === task.projectId);
        if (!project || pmNorm(project.workspace || WORKSPACE_ROOT) !== pmNorm(wctx.root)) {
          res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return;
        }
        if ('deps' in patch) {
          if (!Array.isArray(patch.deps)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'deps must be an array' })); return; }
          const sameProjectIds = new Set(pm.tasks.filter(t => t.projectId === task.projectId).map(t => t.id));
          for (const depId of patch.deps) {
            if (depId === tid) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'task cannot depend on itself' })); return; }
            if (!sameProjectIds.has(depId)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'dep must be in the same project' })); return; }
            if (pmStore.wouldCycle(pm.tasks, tid, depId)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'dep would create a cycle' })); return; }
          }
        }
        const FIELDS = ['name', 'start', 'end', 'progress', 'status', 'deps', 'isMilestone', 'order', 'color', 'baseline'];
        for (const f of FIELDS) { if (f in patch) task[f] = patch[f]; }
        task.updatedAt = new Date().toISOString();
        pm.tasks[idx] = task;
        writePm(pm);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(task));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (pmTaskIdMatch && req.method === 'DELETE') {
    const tid = pmTaskIdMatch[1];
    const wctx = resolveWorkspace(req);
    const pm = readPm();
    const task = pm.tasks.find(t => t.id === tid);
    if (!task) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return; }
    const project = pm.projects.find(p => p.id === task.projectId);
    if (!project || pmNorm(project.workspace || WORKSPACE_ROOT) !== pmNorm(wctx.root)) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return;
    }
    pm.tasks = pm.tasks.filter(t => t.id !== tid);
    // Scrub dangling deps referencing the deleted task (avoid orphaned references).
    for (const t of pm.tasks) {
      if (Array.isArray(t.deps) && t.deps.includes(tid)) t.deps = t.deps.filter(d => d !== tid);
    }
    writePm(pm);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ===== Audio Topics API (AT1, SPEC-audio-topic.md §5) =================
  // Whisper initial_prompt, named + reusable + shared across all 4 audio entry points. Two-file
  // scope model (🌐 global-knowledge/audio-topics.json ∪ 📁 <workspace>/.harness/runtime/…), same
  // spirit as the skill global/workspace split — see portal/audio-topics.js.

  // GET /api/audio-topics — merged list (global ∪ current workspace) + the workspace's defaultTopicId.
  if (pathname === '/api/audio-topics' && req.method === 'GET') {
    const wctx = resolveWorkspace(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      topics: audioTopics.mergedList(HARNESS_HOME, wctx.root),
      defaultTopicId: audioTopics.getDefaultTopicId(wctx.root),
    }));
    return;
  }

  // POST /api/audio-topics/compile — compile-only preview (no save), for the management UI's
  // live token-usage bar. MUST be checked before the generic /:id routes below.
  if (pathname === '/api/audio-topics/compile' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(audioTopics.compileTopic(data)));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // PUT /api/audio-topics/default — set the CURRENT workspace's default topic pointer (may point at
  // a global or a workspace topic id, or null to clear). Never touches the global file.
  if (pathname === '/api/audio-topics/default' && req.method === 'PUT') {
    const wctx = resolveWorkspace(req);
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const topicId = data.topicId || null;
        if (topicId && !audioTopics.resolveTopic(HARNESS_HOME, wctx.root, topicId)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'topic not found' }));
        }
        const w = audioTopics.readWorkspace(wctx.root);
        w.defaultTopicId = topicId;
        audioTopics.writeWorkspace(wctx.root, w);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, defaultTopicId: topicId }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /api/audio-topics — create. body {name, scope:"global"|"workspace", lang, meetingType,
  // people[], terms[], topicLine, notes, prompt?}. `prompt` given → used as-is (still budget-checked);
  // otherwise compiled from the structured fields (guide skeleton). Always token-budget gated.
  if (pathname === '/api/audio-topics' && req.method === 'POST') {
    const wctx = resolveWorkspace(req);
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const name = String(data.name || '').trim();
        if (!name) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'name required' })); }
        const scope = data.scope === 'global' ? 'global' : 'workspace';
        const lang = ['zh', 'en', 'auto'].includes(data.lang) ? data.lang : 'zh';
        const people = Array.isArray(data.people) ? data.people.map(String).filter(Boolean) : [];
        const terms = Array.isArray(data.terms) ? data.terms.map(String).filter(Boolean) : [];
        const topicLine = String(data.topicLine || '').trim();
        const notes = String(data.notes || '').trim();
        const meetingType = String(data.meetingType || '').trim();
        const manualPrompt = String(data.prompt || '').trim();
        const compiled = manualPrompt
          ? audioTopics.truncateRawToBudget(manualPrompt)
          : audioTopics.compileTopic({ lang, people, terms, topicLine, notes, meetingType });
        const now = new Date().toISOString();
        const topic = {
          id: audioTopics.genTopicId(), name, scope, lang, meetingType, people, terms, topicLine, notes,
          prompt: compiled.prompt,
          workspace: scope === 'workspace' ? wctx.root : null,
          updatedAt: now,
        };
        if (scope === 'global') {
          const g = audioTopics.readGlobal(HARNESS_HOME);
          g.topics.push(topic);
          audioTopics.writeGlobal(HARNESS_HOME, g);
        } else {
          const w = audioTopics.readWorkspace(wctx.root);
          w.topics.push(topic);
          audioTopics.writeWorkspace(wctx.root, w);
        }
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ topic, truncated: compiled.truncated || undefined }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // PUT /api/audio-topics/:id — update (recompiles unless a non-empty `prompt` is given directly).
  // `scope` in the patch moves the topic between the global and workspace files.
  // DELETE /api/audio-topics/:id — remove; clears the current workspace's defaultTopicId if it matched.
  const topicIdMatch = pathname.match(/^\/api\/audio-topics\/([^/]+)$/);
  if (topicIdMatch && req.method === 'PUT') {
    const tid = topicIdMatch[1];
    const wctx = resolveWorkspace(req);
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const patch = JSON.parse(body || '{}');
        const g = audioTopics.readGlobal(HARNESS_HOME);
        const w = audioTopics.readWorkspace(wctx.root);
        let scope = null, idx = -1, topic = null;
        idx = g.topics.findIndex(t => t.id === tid);
        if (idx !== -1) { scope = 'global'; topic = g.topics[idx]; }
        else {
          idx = w.topics.findIndex(t => t.id === tid);
          if (idx !== -1) { scope = 'workspace'; topic = w.topics[idx]; }
        }
        if (!topic) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }

        const FIELDS = ['name', 'lang', 'meetingType', 'people', 'terms', 'topicLine', 'notes'];
        for (const f of FIELDS) { if (f in patch) topic[f] = patch[f]; }
        const manualPrompt = String(patch.prompt || '').trim();
        const compiled = manualPrompt ? audioTopics.truncateRawToBudget(manualPrompt) : audioTopics.compileTopic(topic);
        topic.prompt = compiled.prompt;
        topic.updatedAt = new Date().toISOString();

        const newScope = (patch.scope === 'global' || patch.scope === 'workspace') ? patch.scope : scope;
        if (scope === 'global') g.topics.splice(idx, 1); else w.topics.splice(idx, 1);
        topic.scope = newScope;
        topic.workspace = newScope === 'workspace' ? wctx.root : null;
        if (newScope === 'global') g.topics.push(topic); else w.topics.push(topic);

        audioTopics.writeGlobal(HARNESS_HOME, g);
        audioTopics.writeWorkspace(wctx.root, w);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ topic, truncated: compiled.truncated || undefined }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (topicIdMatch && req.method === 'DELETE') {
    const tid = topicIdMatch[1];
    const wctx = resolveWorkspace(req);
    const g = audioTopics.readGlobal(HARNESS_HOME);
    const w = audioTopics.readWorkspace(wctx.root);
    let ok = false;
    const gi = g.topics.findIndex(t => t.id === tid);
    if (gi !== -1) { g.topics.splice(gi, 1); audioTopics.writeGlobal(HARNESS_HOME, g); ok = true; }
    else {
      const wi = w.topics.findIndex(t => t.id === tid);
      if (wi !== -1) { w.topics.splice(wi, 1); ok = true; }
    }
    if (ok) {
      if (w.defaultTopicId === tid) w.defaultTopicId = null;
      audioTopics.writeWorkspace(wctx.root, w);
    }
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok }));
    return;
  }

  // ===== Scheduler API =================================================

  // GET /api/schedules — list schedules for the ACTIVE workspace only (workspace isolation).
  // (SCHED-DEPLOY validation helpers `validatePostRunPatch`/`postRunConflicts` live at module
  // scope below the request router — see their definitions there.)
  // Each schedule carries a `workspace`; a null one = legacy/untagged → runs in WORKSPACE_ROOT
  // (see the runner default), so it belongs to the harness home for display too. Normalise paths
  // (collapse doubled separators, lowercase) before comparing.
  if (pathname === '/api/schedules' && req.method === 'GET') {
    const wctx = resolveWorkspace(req);
    const norm = p => { try { return path.resolve(String(p || '')).toLowerCase(); } catch (e) { return ''; } };
    const active = norm(wctx.root);
    const list = schedulerManager.loadSchedules()
      .filter(s => norm(s.workspace || WORKSPACE_ROOT) === active)
      .map(s => {  // SCHED-14: 附帶目前執行中的 run（開始時間 + 自動/手動）供清單顯示「執行中」
        const r = schedulerManager.getRunningRun(s.id);
        return Object.assign({}, s, { running: r ? { runId: r.id, startedAt: r.startedAt, trigger: r.trigger || 'auto' } : null });
      });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
    return;
  }

  // POST /api/schedules — create
  if (pathname === '/api/schedules' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        // SCHED-DEPLOY Z1: validate postRun shape + D2 invariant BEFORE createSchedule writes anything.
        const pv = validatePostRunPatch(data);
        if (!pv.ok) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: pv.error })); return; }
        if (postRunConflicts(data, null)) {
          res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: POSTRUN_CONFLICT_MSG })); return;
        }
        // Tag the schedule with the active workspace (from X-Workspace) so it stays isolated to it.
        if (!data.workspace) { try { data.workspace = resolveWorkspace(req).root; } catch (e) {} }
        const s = schedulerManager.createSchedule(data);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(s));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /api/schedules/:id/run — manual trigger
  const schedRunMatch = pathname.match(/^\/api\/schedules\/([^/]+)\/run$/);
  if (schedRunMatch && req.method === 'POST') {
    const result = schedulerManager.triggerNow(schedRunMatch[1]);
    if (!result) { res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return; }
    if (result.ok === false) {  // SCHED-15: already-running → 409, don't double-fire
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // GET /api/schedules/candidates — H5: all unreviewed memory candidates for current workspace
  if (pathname === '/api/schedules/candidates' && req.method === 'GET') {
    const wctxCand = resolveWorkspace(req);
    const candidates = schedulerManager.collectCandidates(wctxCand.root);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, candidates }));
    return;
  }

  // POST /api/schedules/:id/runs/:runId/candidate/review — H5: adopt or discard a candidate
  const candReviewMatch = pathname.match(/^\/api\/schedules\/([^/]+)\/runs\/([^/]+)\/candidate\/review$/);
  if (candReviewMatch && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const { id: candSchedId, runId: candRunId } = { id: candReviewMatch[1], runId: candReviewMatch[2] };
        const sched = schedulerManager.getSchedule(candSchedId);
        if (!sched) { res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'schedule not found' })); return; }
        const wctxRev = resolveWorkspace(req);
        const normRev = p => { try { return path.resolve(String(p || '')).toLowerCase(); } catch (e) { return ''; } };
        if (normRev(sched.workspace || WORKSPACE_ROOT) !== normRev(wctxRev.root)) {
          res.writeHead(403); res.end(JSON.stringify({ ok: false, error: 'workspace mismatch' })); return;
        }
        const candidate = schedulerManager.getMemoryCandidate(candSchedId, candRunId);
        if (!candidate) { res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'no candidate' })); return; }
        const payload = JSON.parse(body || '{}');
        const accepted = payload.accepted === true;
        const bucket   = (payload.bucket || candidate.bucket || 'MEMORY').toUpperCase();
        let memorySummary = [];
        if (accepted && candidate.insight) {
          memorySummary = applyMemoryOps({ ops: [{ file: bucket, action: 'add', text: candidate.insight }] }, wctxRev.knowledgeDir);
        }
        schedulerManager.saveMemoryCandidate(candSchedId, candRunId, Object.assign({}, candidate, {
          reviewed: true, accepted, reviewedAt: new Date().toISOString(), finalBucket: accepted ? bucket : null,
        }));
        schedulerManager.updateRun(candSchedId, candRunId, { valueReviewed: true });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, accepted, memorySummary }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // GET /api/schedules/:id/runs — run history (H2-03: workspace isolation)
  // DELETE /api/schedules/:id/runs/transcripts — batch-clear transcripts (H3-02)
  const schedClearMatch = pathname.match(/^\/api\/schedules\/([^/]+)\/runs\/transcripts$/);
  if (schedClearMatch && req.method === 'DELETE') {
    const sid = schedClearMatch[1];
    const sched = schedulerManager.loadSchedules().find(s => s.id === sid);
    if (!sched) { res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return; }
    const wctxC = resolveWorkspace(req);
    const normC = p => { try { return path.resolve(String(p || '')).toLowerCase(); } catch (e) { return ''; } };
    if (normC(sched.workspace || WORKSPACE_ROOT) !== normC(wctxC.root)) {
      res.writeHead(403); res.end(JSON.stringify({ error: 'forbidden' })); return;
    }
    const qpC = parsedUrl.query;
    const clearAll = qpC.all === 'true';
    const olderDays = qpC.olderThanDays ? parseInt(qpC.olderThanDays, 10) : null;
    if (!clearAll && !(olderDays > 0)) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'specify all=true or olderThanDays=N' })); return;
    }
    const cutoff = (olderDays > 0) ? new Date(Date.now() - olderDays * 86400000).toISOString() : null;
    const allRuns = schedulerManager.getRuns(sid, 10000);
    let cleared = 0;
    for (const run of allRuns) {
      if (run.transcriptCleared) continue;
      if (!clearAll && cutoff && (run.startedAt || '') >= cutoff) continue; // keep recent
      // Delete chat_sched_<runId>.json
      const sessPath = path.join(wctxC.chatHistoryDir, `chat_sched_${run.id}.json`);
      try { if (fs.existsSync(sessPath)) fs.unlinkSync(sessPath); } catch (e) {}
      // Delete transcript artifacts; keep other artifact kinds
      const runDir = path.join(schedulerManager.runsDir, sid, run.id);
      const keptIds = [];
      if (fs.existsSync(runDir)) {
        try {
          for (const f of fs.readdirSync(runDir).filter(f => f.startsWith('art_') && f.endsWith('.json'))) {
            try {
              const art = JSON.parse(fs.readFileSync(path.join(runDir, f), 'utf8'));
              if (art.kind === 'transcript') { fs.unlinkSync(path.join(runDir, f)); }
              else { keptIds.push(art.id); }
            } catch (e) {}
          }
        } catch (e) {}
      }
      schedulerManager.updateRun(sid, run.id, { transcriptCleared: true, artifactIds: keptIds });
      cleared++;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, cleared }));
    return;
  }

  const schedRunsMatch = pathname.match(/^\/api\/schedules\/([^/]+)\/runs$/);
  if (schedRunsMatch && req.method === 'GET') {
    const sid = schedRunsMatch[1];
    const sched = schedulerManager.loadSchedules().find(s => s.id === sid);
    if (!sched) { res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return; }
    const wctxR = resolveWorkspace(req);
    const normR = p => { try { return path.resolve(String(p || '')).toLowerCase(); } catch (e) { return ''; } };
    if (normR(sched.workspace || WORKSPACE_ROOT) !== normR(wctxR.root)) {
      res.writeHead(403); res.end(JSON.stringify({ error: 'forbidden' })); return;
    }
    const runs = schedulerManager.getRuns(sid);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(runs));
    return;
  }

  // PUT /api/schedules/:id — update
  // DELETE /api/schedules/:id — delete
  const schedIdMatch = pathname.match(/^\/api\/schedules\/([^/]+)$/);
  if (schedIdMatch) {
    const sid = schedIdMatch[1];
    if (req.method === 'PUT') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const patch = JSON.parse(body || '{}');
          // H7: whitelist delivery sinks; strip unknowns, default to ['web','telegram']
          if ('delivery' in patch) {
            const VALID = ['web', 'telegram'];
            const d = Array.isArray(patch.delivery) ? [...new Set(patch.delivery.filter(s => VALID.includes(s)))] : null;
            patch.delivery = (d && d.length) ? d : ['web', 'telegram'];
          }
          // SCHED-DEPLOY Z1: validate postRun shape + D2 invariant against the FINAL state (patch
          // merged over what's already on disk) BEFORE any write happens.
          const pv = validatePostRunPatch(patch);
          if (!pv.ok) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: pv.error })); return; }
          const existingSched = schedulerManager.getSchedule(sid);
          if (!existingSched) { res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return; }
          if (postRunConflicts(patch, existingSched)) {
            res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: POSTRUN_CONFLICT_MSG })); return;
          }
          const updated = schedulerManager.updateSchedule(sid, patch);
          if (!updated) { res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return; }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(updated));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    if (req.method === 'DELETE') {
      const ok = schedulerManager.deleteSchedule(sid);
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok }));
      return;
    }
    if (req.method === 'GET') {
      const s = schedulerManager.getSchedule(sid);
      if (!s) { res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(s));
      return;
    }
  }

  // GET /api/schedules/:id/runs/:runId/artifact/:artId — artifact detail
  const artMatch = pathname.match(/^\/api\/schedules\/([^/]+)\/runs\/([^/]+)\/artifact\/([^/]+)$/);
  if (artMatch && req.method === 'GET') {
    const art = schedulerManager.getArtifact(artMatch[1], artMatch[2], artMatch[3]);
    if (!art) { res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(art));
    return;
  }

  // GET /api/activities — notification list (web sink, SCHED-08), scoped to the ACTIVE workspace.
  // Notifications carry a scheduleId; map it → the schedule's workspace and keep only this one
  // (null workspace = harness home, matching the runner default). Fetch a wide window, filter, then
  // trim to the requested limit so isolation never starves the feed.
  if (pathname === '/api/activities' && req.method === 'GET') {
    const qp = url.parse(req.url, true).query;
    const limit = Math.min(parseInt(qp.limit || '50', 10) || 50, 200);
    const wctx = resolveWorkspace(req);
    const norm = p => { try { return path.resolve(String(p || '')).toLowerCase(); } catch (e) { return ''; } };
    const active = norm(wctx.root);
    const wsMap = {};
    schedulerManager.loadSchedules().forEach(s => { wsMap[s.id] = s.workspace; });
    const list = schedulerManager.getNotifications(200)
      .filter(n => norm(wsMap[n.scheduleId] || WORKSPACE_ROOT) === active)
      .slice(0, limit);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
    return;
  }

  // DELETE /api/activities/:id — dismiss a notification
  const actDismissMatch = pathname.match(/^\/api\/activities\/([^/]+)$/);
  if (actDismissMatch && req.method === 'DELETE') {
    const ok = schedulerManager.dismissNotification(actDismissMatch[1]);
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok }));
    return;
  }

  // GET /api/runs — cross-schedule run query (SCHED-09 Hana 自我感知)
  // Params: since, until, scheduleId, status, limit
  if (pathname === '/api/runs' && req.method === 'GET') {
    const qp = url.parse(req.url, true).query;
    const runs = schedulerManager.queryRuns({
      since:      qp.since      || null,
      until:      qp.until      || null,
      scheduleId: qp.scheduleId || null,
      status:     qp.status     || null,
      limit:      Math.min(parseInt(qp.limit || '50', 10) || 50, 500),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(runs));
    return;
  }

  // GET /api/runs/:runId — single run detail (needs scheduleId from run file)
  const runIdMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (runIdMatch && req.method === 'GET') {
    const runId = runIdMatch[1];
    // Search all schedules for this runId
    const list = schedulerManager.loadSchedules();
    let found = null;
    for (const s of list) {
      const r = schedulerManager.getRun(s.id, runId);
      if (r) { found = r; break; }
    }
    if (!found) { res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(found));
    return;
  }

  // ===== END Scheduler API =============================================

  // ===== Telegram C&C API ===============================================

  // GET /api/telegram/status — bot configuration & polling status
  if (pathname === '/api/telegram/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(telegramBot.getStatus()));
    return;
  }

  // POST /api/telegram/bind-start — open a 10-min bind window so /bind on Telegram adds this chat
  if (pathname === '/api/telegram/bind-start' && req.method === 'POST') {
    if (!telegramBot.isConfigured()) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Telegram not configured (no botToken)' }));
      return;
    }
    const expiresAt = telegramBot.openBindWindow(10);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, expiresAt, message: '10 分鐘內在 Telegram 傳送 /bind 即可綁定。' }));
    return;
  }

  // GET /api/telegram/console — console log entries
  if (pathname === '/api/telegram/console' && req.method === 'GET') {
    const limit = parseInt(new URL(req.url, 'http://x').searchParams.get('limit') || '100', 10);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(telegramBot.getConsoleLog(limit)));
    return;
  }

  // DELETE /api/telegram/console — clear all console log entries
  if (pathname === '/api/telegram/console' && req.method === 'DELETE') {
    const ok = telegramBot.clearConsoleLog();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok }));
    return;
  }

  // DELETE /api/telegram/console/:idx — C5: delete single console entry by index
  if (req.method === 'DELETE' && /^\/api\/telegram\/console\/(\d+)$/.test(pathname)) {
    const idx = parseInt(pathname.split('/').pop(), 10);
    const ok  = telegramBot.deleteConsoleEntry(idx);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok }));
    return;
  }

  // GET /api/telegram/context — C3: sticky workspace context per chat
  if (pathname === '/api/telegram/context' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(telegramBot.getAllContexts()));
    return;
  }

  // POST /api/telegram/context — C3: set context from web UI
  if (pathname === '/api/telegram/context' && req.method === 'POST') {
    let body = '';
    req.on('data', function (d) { body += d; });
    req.on('end', function () {
      try {
        const { chatId, root, label } = JSON.parse(body);
        if (!chatId || !root) { res.writeHead(400); res.end('{"error":"chatId and root required"}'); return; }
        telegramBot.setContext(chatId, root, label || root);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400); res.end('{"error":"invalid JSON"}'); }
    });
    return;
  }

  // POST /api/telegram/console/send — C3: trusted web-UI → same handler → log + sync to phone
  if (pathname === '/api/telegram/console/send' && req.method === 'POST') {
    let body = '';
    req.on('data', function (d) { body += d; });
    req.on('end', function () {
      try {
        const { text } = JSON.parse(body);
        if (!text || !String(text).trim()) { res.writeHead(400); res.end('{"error":"text required"}'); return; }
        telegramBot.handleWebMessage(String(text).trim()).then(function () {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        }).catch(function (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        });
      } catch (e) { res.writeHead(400); res.end('{"error":"invalid JSON"}'); }
    });
    return;
  }

  // GET /api/telegram/images/:filename — C6: serve downloaded Telegram images
  const tgImgMatch = pathname.match(/^\/api\/telegram\/images\/([^/]+)$/);
  if (tgImgMatch && req.method === 'GET') {
    const fname = tgImgMatch[1];
    if (!/^[a-zA-Z0-9_\-.]+$/.test(fname)) { res.writeHead(400); res.end('invalid filename'); return; }
    const imgPath = path.join(HARNESS_HOME, 'global-knowledge', 'telegram', 'images', fname);
    if (!fs.existsSync(imgPath)) { res.writeHead(404); res.end('not found'); return; }
    const ext  = path.extname(fname).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(imgPath).pipe(res);
    return;
  }

  // ===== END Telegram C&C API ===========================================

  // POST /api/presentations/:name/export — PRES-EXPORT-04
  // :name = deck filename without .html, e.g. presentation-hana-episode1-v2
  const exportMatch = pathname.match(/^\/api\/presentations\/([^/]+)\/export$/);
  if (exportMatch && req.method === 'POST') {
    const deckName = exportMatch[1];
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', async () => {
      try {
        const { slidesToPngs } = require('./render-service/screenshot');
        const { buildPptx } = require('./render-service/export');

        // Locate the deck HTML
        const deckHtmlPath = path.join(HARNESS_HOME, 'presentations', deckName + '.html');
        if (!fs.existsSync(deckHtmlPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: `找不到 deck：presentations/${deckName}.html` }));
        }

        // Build the URL pointing at our own server so /raw can inject core + overlay
        // Pin /raw to HARNESS_HOME so it resolves presentations/ regardless of the portal's DEFAULT
        // workspace. A header-less server-side fetch otherwise resolves against the active workspace
        // (e.g. a client project like 範例專案) → 404 → Playwright sees 0 .slide → misleading「找不到 .slide」.
        const deckUrl = `http://localhost:${PORT}/raw?path=presentations/${deckName}.html&workspace=${encodeURIComponent(HARNESS_HOME)}`;
        const slides = await slidesToPngs(deckUrl);

        const exportDir = path.join(HARNESS_HOME, 'presentations', 'exports');
        const outputPath = await buildPptx(slides, deckName, exportDir);
        const relPath = path.relative(HARNESS_HOME, outputPath).replace(/\\/g, '/');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: relPath, slides: slides.length }));
      } catch (e) {
        console.error('[export-pptx] error:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // POST /api/presentations/:name/record — PRES-REC-02
  // Records deck to MP4 via TTS WAV + ffmpeg; requires ffmpeg in PATH.
  const recordMatch = pathname.match(/^\/api\/presentations\/([^/]+)\/record$/);
  if (recordMatch && req.method === 'POST') {
    const deckName = recordMatch[1];
    req.on('data', () => {});
    req.on('end', async () => {
      try {
        const { recordDeck, ffmpegAvailable } = require('./render-service/record');
        const { loadVoiceConfig } = require('./render-service/tts-edge');
        if (!ffmpegAvailable()) throw new Error('ffmpeg 未安裝或不在 PATH，請先安裝 ffmpeg 並重啟 portal');
        const deckHtmlPath = path.join(HARNESS_HOME, 'presentations', deckName + '.html');
        if (!fs.existsSync(deckHtmlPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: `找不到 deck：presentations/${deckName}.html` }));
        }
        const vc = loadVoiceConfig(HARNESS_HOME); // edge-tts voice + rate matching the browser config
        // Pin /raw to HARNESS_HOME so it resolves presentations/ regardless of the portal's DEFAULT
        // workspace. A header-less server-side fetch otherwise resolves against the active workspace
        // (e.g. a client project like 範例專案) → 404 → Playwright sees 0 .slide → misleading「找不到 .slide」.
        const deckUrl = `http://localhost:${PORT}/raw?path=presentations/${deckName}.html&workspace=${encodeURIComponent(HARNESS_HOME)}`;
        const exportDir = path.join(HARNESS_HOME, 'presentations', 'exports');
        const outputPath = path.join(exportDir, deckName + '.mp4');
        const result = await recordDeck(deckUrl, outputPath, { edgeVoice: vc.voice, edgeRate: vc.rate });
        const relPath = path.relative(HARNESS_HOME, result.outputPath).replace(/\\/g, '/');
        const vttRel = result.vttPath ? path.relative(HARNESS_HOME, result.vttPath).replace(/\\/g, '/') : null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: relPath, vtt: vttRel, slides: result.slideCount, voice: vc.voice }));
      } catch (e) {
        console.error('[record-mp4] error:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // GET /api/presentations/exports/<file> — serve recorded media (mp4 / vtt) from HARNESS_HOME with
  // HTTP Range support so <video> can stream + seek. No workspace param needed (always HARNESS_HOME).
  const exportFileMatch = pathname.match(/^\/api\/presentations\/exports\/([^/]+)$/);
  if (exportFileMatch && req.method === 'GET') {
    const fileName = decodeURIComponent(exportFileMatch[1]);
    const exportsDir = path.join(HARNESS_HOME, 'presentations', 'exports');
    const filePath = path.join(exportsDir, fileName);
    if (/[\\/]/.test(fileName) || !isPathSafe(filePath, exportsDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }
    const ext = path.extname(filePath).toLowerCase();
    const ctype = ext === '.mp4' ? 'video/mp4' : ext === '.vtt' ? 'text/vtt; charset=utf-8' : ext === '.mp3' ? 'audio/mpeg' : 'application/octet-stream';
    const stat = fs.statSync(filePath);
    const range = req.headers.range;
    if (range && ext === '.mp4') {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (isNaN(start) || start < 0) start = 0;
      if (isNaN(end) || end >= stat.size) end = stat.size - 1;
      if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
      res.writeHead(206, {
        'Content-Type': ctype,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': ctype, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(filePath).pipe(res);
    }
    return;
  }

  // GET /api/block-decks — list .blocks.json files (PRES-BLOCK-02/03)
  if (pathname === '/api/block-decks' && req.method === 'GET') {
    try {
      const presDir = path.join(HARNESS_HOME, 'presentations');
      const files = fs.existsSync(presDir)
        ? fs.readdirSync(presDir).filter(f => f.endsWith('.blocks.json'))
        : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, decks: files.map(f => f.replace('.blocks.json', '')) }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // GET /api/documents/import-tree — list docx/pptx files for the import dialog (DOC-I2-02)
  if (pathname === '/api/documents/import-tree' && req.method === 'GET') {
    try {
      const wctx = resolveWorkspace(req);
      const skipDirs = new Set(['node_modules', '.next', 'publish', 'app_data', 'dist', 'build',
        '.git', '.turbo', '.documents', '.harness', '.worktable', '.codegraph',
        '.antigravitycli', '.claude', 'out', '.venv', '.releases', 'global-knowledge']);
      function walkImportable(dir, relativeTo) {
        const items = [];
        if (!fs.existsSync(dir)) return items;
        for (const name of fs.readdirSync(dir)) {
          if (name.startsWith('.')) continue;
          const full = path.join(dir, name);
          let st; try { st = fs.statSync(full); } catch(e) { continue; }
          const rel = path.relative(relativeTo, full).replace(/\\/g, '/');
          if (st.isDirectory()) {
            if (skipDirs.has(name)) continue;
            const children = walkImportable(full, relativeTo);
            if (children.length > 0) items.push({ type: 'directory', name, path: rel, children });
          } else if (/\.(docx|pptx|xlsx)$/i.test(name)) {
            items.push({ type: 'file', name, path: rel, mtime: st.mtime });
          }
        }
        return items.sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
          return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        });
      }
      const tree = walkImportable(wctx.root, wctx.root);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, tree }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // POST /api/documents/import — SSE streaming batch import (DOC-I2-01/02/03/04)
  if (pathname === '/api/documents/import' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', async () => {
      let files = [], overwrite = false;
      try { ({ files = [], overwrite = false } = JSON.parse(body || '{}')); } catch(e) {}
      const wctx = resolveWorkspace(req);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      const send = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch(e) {} };

      send({ type: 'start', total: files.length });
      let successCount = 0, skipCount = 0, failCount = 0;

      for (const relPath of files) {
        const ext = path.extname(relPath).toLowerCase();

        const fullSrc = path.resolve(wctx.root, relPath);
        if (!fullSrc.startsWith(wctx.root) || !fs.existsSync(fullSrc)) {
          send({ type: 'error', file: relPath, error: '找不到檔案或路徑不合法' });
          failCount++;
          continue;
        }

        const reg = docRegistry.readRegistry(wctx.root);
        const existing = reg.documents.find(d => d.sourcePath === relPath);

        if (existing && !overwrite) {
          send({ type: 'skip', file: relPath, docId: existing.id, reason: '已存在（略過）' });
          skipCount++;
          continue;
        }

        const docId = existing ? existing.id : docRegistry.generateDocId();
        const docDir = path.join(wctx.root, '.documents', docId);

        // Backup old doc.md before overwrite
        if (existing && overwrite) {
          const oldMd = path.join(docDir, 'doc.md');
          if (fs.existsSync(oldMd)) {
            const bak = path.join(docDir, `doc.${Date.now()}.bak.md`);
            try { fs.copyFileSync(oldMd, bak); } catch(e) {}
            send({ type: 'backup', file: relPath, docId, bak: path.basename(bak) });
          }
        }

        docRegistry.ensureDocumentDir(wctx.root, docId);

        // Copy source file (convert from the copy, never lock original)
        const sourceCopy = path.join(docDir, ext === '.pptx' ? 'source.pptx' : ext === '.xlsx' ? 'source.xlsx' : 'source.docx');
        try { fs.copyFileSync(fullSrc, sourceCopy); }
        catch(e) {
          send({ type: 'error', file: relPath, error: `複製失敗: ${e.message}` });
          failCount++;
          continue;
        }

        send({ type: 'converting', file: relPath, docId });

        const convScript = path.join(RENDER_SERVICE_DIR, ext === '.pptx' ? 'pptx-convert.py' : ext === '.xlsx' ? 'xlsx-convert.py' : 'docx-convert.py');
        const convArgs = [convScript, '--import', sourceCopy, docDir, '--source', relPath];

        await new Promise((resolve) => {
          execFile(venvPython(), convArgs, { env: venvSpawnEnv(), timeout: 120000 }, (err, stdout, stderr) => {
            if (err) {
              send({ type: 'error', file: relPath, error: (stderr || err.message || '轉換失敗').slice(0, 300) });
              failCount++;
              return resolve();
            }
            // 不存 title：Word 是自由格式，沒有可靠的「文件標題」（第一行/某段都不一定是），而 title
            // 又是很標準的詞、留個「其實是檔名」的 title 欄遲早誤導。顯示名一律由 sourcePath（原始檔名）
            // 推導 → 單一真相來源、不會與檔名不同步。`name` 僅供匯入進度顯示，不寫入 registry。
            const name = path.basename(relPath, path.extname(relPath));
            try {
              docRegistry.upsertDocument(wctx.root, {
                id: docId,
                sourcePath: relPath,
                mdPath: `.documents/${docId}/doc.md`,
                type: ext === '.pptx' ? 'pptx' : ext === '.xlsx' ? 'workbook' : 'doc',
                exports: [],
              });
              // Version history (DOC-J5): first import = born:imported; overwrite = an edit.
              if (existing && overwrite) {
                docRegistry.appendDocHistory(wctx.root, docId, { kind: 'edit', by: '老闆', summary: '覆蓋匯入', change: 'text' });
              } else {
                docRegistry.appendDocHistory(wctx.root, docId, { kind: 'born', origin: 'imported', by: '老闆', summary: `匯入自 ${relPath}` });
              }
              send({ type: 'success', file: relPath, docId, name });
              successCount++;
            } catch(e2) {
              send({ type: 'error', file: relPath, error: `registry 更新失敗: ${e2.message}` });
              failCount++;
            }
            resolve();
          });
        });
      }

      send({ type: 'done', success: successCount, skip: skipCount, fail: failCount });
      res.end();
    });
    return;
  }

  // GET /api/documents — list documents for the active workspace (DOC-I1-02)
  if (pathname === '/api/documents' && req.method === 'GET') {
    try {
      const wctx = resolveWorkspace(req);
      // Lazy backfill (DOC-J5): give pre-J5 docs an origin/born event so the list shows badges.
      // Idempotent + workspace-isolated (only touches this workspace's registry).
      try { docRegistry.backfillDocHistory(wctx.root); } catch (e) { console.error('[DocHistory] backfill failed:', e.message); }
      const reg  = docRegistry.readRegistry(wctx.root);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, documents: reg.documents }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── 刪除 / 資源回收桶（soft-delete + recycle bin）───────────────────────────
  // GET /api/documents/recycle — 已刪除(trash)+ 孤兒目錄清單（帶檔名/建立/刪除時間/大小）。
  if (pathname === '/api/documents/recycle' && req.method === 'GET') {
    try {
      const wctx = resolveWorkspace(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, items: docRegistry.listRecycle(wctx.root) }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  // POST /api/documents/recycle/empty — 徹底刪除整桶（含孤兒）。
  if (pathname === '/api/documents/recycle/empty' && req.method === 'POST') {
    try {
      const wctx = resolveWorkspace(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, purged: docRegistry.emptyRecycle(wctx.root) }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  // POST /api/documents/:id/restore — 從 trash 還原到正式列表。
  const recRestoreMatch = pathname.match(/^\/api\/documents\/([^/]+)\/restore$/);
  if (recRestoreMatch && req.method === 'POST') {
    try {
      const wctx = resolveWorkspace(req);
      const doc = docRegistry.restoreDocument(wctx.root, recRestoreMatch[1]);
      if (!doc) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'not in recycle bin' })); }
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, doc }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }
  // DELETE /api/documents/:id/purge — 從電腦中移除（rm 目錄；含孤兒）。
  const recPurgeMatch = pathname.match(/^\/api\/documents\/([^/]+)\/purge$/);
  if (recPurgeMatch && req.method === 'DELETE') {
    try {
      const wctx = resolveWorkspace(req);
      docRegistry.purgeDocument(wctx.root, recPurgeMatch[1]);
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }
  // DELETE /api/documents/:id — 軟刪除（搬到 trash、目錄留著、可還原）。
  const recDeleteMatch = pathname.match(/^\/api\/documents\/([^/]+)$/);
  if (recDeleteMatch && req.method === 'DELETE') {
    try {
      const wctx = resolveWorkspace(req);
      const doc = docRegistry.softDeleteDocument(wctx.root, recDeleteMatch[1]);
      if (!doc) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'document not found' })); }
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, doc }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  // GET /api/documents/templates — list template families for the "+ 新增文件" dialog (DOC-J3-01).
  // Reads .documents/.templates/index.json (written by the doc-template skill / J2). Must be matched
  // BEFORE the /api/documents/:id route below, which would otherwise swallow "templates" as an id.
  if (pathname === '/api/documents/templates' && req.method === 'GET') {
    try {
      const wctx = resolveWorkspace(req);
      const idxPath = path.join(wctx.root, '.documents', '.templates', 'index.json');
      let templates = [];
      if (fs.existsSync(idxPath)) {
        try { templates = (JSON.parse(fs.readFileSync(idxPath, 'utf8')).templates) || []; } catch (e) {}
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, templates }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // POST /api/documents/new — dispatch the doc-new skill as a BACKGROUND job (DOC-J3-01).
  // Body: { sourceType:'template'|'copy', sourceRef, name, description, model? }.
  //   template → sourceRef = family name; copy → sourceRef = an existing docId.
  // We reuse the scheduler as the background-job home (survives browser close, visible in 排程,
  // can resume on rate-limit): create a one-off schedule (skill task) and fire it immediately, so
  // it never touches the interactive chat budget.
  if (pathname === '/api/documents/new' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const { sourceType, sourceRef, name, description, model } = JSON.parse(body || '{}');
        const nm = (name || '').trim();
        const desc = (description || '').trim();
        if (!nm)   { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: '請填寫文件名稱' })); return; }
        if (!desc) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: '請填寫說明' })); return; }
        if (sourceType !== 'template' && sourceType !== 'copy') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: '來源類型不合法' })); return; }
        if (!sourceRef) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: sourceType === 'template' ? '請選擇範本家族' : '請選擇要複製的文件' })); return; }

        const wctx = resolveWorkspace(req);
        // Build the args block the doc-new skill parses (來源 / 文件名稱 / 說明). Plain text so it
        // survives prompt round-tripping; the skill reads these three labelled fields.
        const srcLine = sourceType === 'template'
          ? ('範本家族「' + sourceRef + '」')
          : ('複製現有文件 ' + sourceRef);
        const args = [
          '來源：' + srcLine,
          '文件名稱：' + nm,
          '說明：',
          desc,
        ].join('\n');

        const schedule = schedulerManager.createSchedule({
          name:      '生成文件：' + nm,
          enabled:   false,  // never auto-fires; triggerNow (below) ignores enabled and runs it once now
          trigger:   { type: 'once', atISO: new Date().toISOString() },
          task:      { kind: 'skill', skill: 'doc-new', args },
          model:     model || DEFAULT_CHAT_MODEL,
          workspace: wctx.root,
          delivery:  ['web'],
          guardrails:{ maxRuntimeMs: 3600000 }, // doc-new (read template + draw flow + fill) can run long
        });
        // Fire now as a background run (trigger='manual'). The schedule stays disabled, so it lingers
        // as a finished one-off in the 排程 panel (like D-series tasks) — visible for progress, never re-run.
        const result = schedulerManager.triggerNow(schedule.id);
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, scheduleId: schedule.id, fired: !!(result && result.ok) }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // GET /api/documents/:id — single document entry (DOC-I1-02)
  const docGetMatch = pathname.match(/^\/api\/documents\/([^/]+)$/);
  if (docGetMatch && req.method === 'GET') {
    try {
      const wctx = resolveWorkspace(req);
      const reg  = docRegistry.readRegistry(wctx.root);
      const doc  = reg.documents.find(d => d.id === docGetMatch[1]);
      if (!doc) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'not found' }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, document: doc }));
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // GET /api/documents/:id/history — version timeline (born + edits), with snapshot sizes (DOC-J5-04)
  const docHistMatch = pathname.match(/^\/api\/documents\/([^/]+)\/history$/);
  if (docHistMatch && req.method === 'GET') {
    try {
      const wctx = resolveWorkspace(req);
      const reg  = docRegistry.readRegistry(wctx.root);
      const doc  = reg.documents.find(d => d.id === docHistMatch[1]);
      if (!doc) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'not found' })); }
      const histDir = docRegistry.getHistoryDir(wctx.root, doc.id);
      const events  = docRegistry.readDocHistory(wctx.root, doc.id).map(ev => {
        let size = null;
        if (ev.snapshot) {
          try { size = fs.statSync(path.join(histDir, ev.snapshot)).size; } catch (e) {}
        }
        // J8: backfill change field for pre-J8 edit events (infer from summary, don't rewrite disk)
        const evOut = { ...ev, size };
        if (ev.kind === 'edit' && !ev.change) {
          const s = ev.summary || '';
          evOut.change = /流程圖/.test(s) ? 'flow' : /圖片|插入|更換/.test(s) ? 'image' : 'text';
          if (!evOut.assets) evOut.assets = [];
        }
        return evOut;
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, events }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // GET /api/documents/:id/history/:rev/asset?path=<rel> — asset snapshot at rev ≤ N (DOC-J8-03)
  // 衍生規則：path 相同、rev ≤ N 的最後一筆快照。用於 diff 並排顯示前後版流程圖/圖片。
  const docHistAssetMatch = pathname.match(/^\/api\/documents\/([^/]+)\/history\/(\d+)\/asset$/);
  if (docHistAssetMatch && req.method === 'GET') {
    try {
      const wctx = resolveWorkspace(req);
      const reg  = docRegistry.readRegistry(wctx.root);
      const doc  = reg.documents.find(d => d.id === docHistAssetMatch[1]);
      if (!doc) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'not found' })); }
      const rev      = Number(docHistAssetMatch[2]);
      const assetRel = (new URLSearchParams(req.url.split('?')[1] || '')).get('path') || '';
      if (!assetRel) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'path param required' })); }
      const snapAbs = docRegistry.resolveAssetSnapshot(wctx.root, doc.id, assetRel, rev);
      if (!snapAbs) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'no snapshot for this asset at rev ' + rev })); }
      if (!isPathSafe(snapAbs, wctx.root)) { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'access denied' })); }
      const ext  = path.extname(snapAbs).toLowerCase();
      const mime = ext === '.bpmn' ? 'application/xml' : ext === '.svg' ? 'image/svg+xml'
                 : ext === '.png'  ? 'image/png'       : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
                 : ext === '.gif'  ? 'image/gif'        : ext === '.webp' ? 'image/webp'
                 // J8-FIX: Office 真身正名 MIME（勿留 octet-stream）——放大比對窗以 arrayBuffer 擬真渲染
                 : ext === '.pptx' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
                 : ext === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                 : ext === '.xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                 : 'application/octet-stream';
      const buf = fs.readFileSync(snapAbs);
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': buf.length });
      res.end(buf);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // GET /api/documents/:id/history/:rev — a single revision's snapshot md (read-only preview/diff)
  const docHistRevMatch = pathname.match(/^\/api\/documents\/([^/]+)\/history\/(\d+)$/);
  if (docHistRevMatch && req.method === 'GET') {
    try {
      const wctx = resolveWorkspace(req);
      const reg  = docRegistry.readRegistry(wctx.root);
      const doc  = reg.documents.find(d => d.id === docHistRevMatch[1]);
      if (!doc) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'not found' })); }
      const rev = Number(docHistRevMatch[2]);
      const ev  = docRegistry.readDocHistory(wctx.root, doc.id).find(e => e.rev === rev);
      if (!ev || !ev.snapshot) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'revision not found' })); }
      const snapAbs = path.join(docRegistry.getHistoryDir(wctx.root, doc.id), ev.snapshot);
      if (!isPathSafe(snapAbs, wctx.root) || !fs.existsSync(snapAbs)) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'snapshot missing' })); }
      const content = fs.readFileSync(snapAbs, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rev, event: ev, content }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // POST /api/documents/:id/restore/:rev — write a revision back to doc.md + log an edit (DOC-J5-04)
  const docRestoreMatch = pathname.match(/^\/api\/documents\/([^/]+)\/restore\/(\d+)$/);
  if (docRestoreMatch && req.method === 'POST') {
    req.on('data', () => {});
    req.on('end', () => {
      try {
        const wctx = resolveWorkspace(req);
        const reg  = docRegistry.readRegistry(wctx.root);
        const doc  = reg.documents.find(d => d.id === docRestoreMatch[1]);
        if (!doc) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'not found' })); }
        const rev = Number(docRestoreMatch[2]);
        const ev  = docRegistry.readDocHistory(wctx.root, doc.id).find(e => e.rev === rev);
        if (!ev || !ev.snapshot) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'revision not found' })); }
        const histDir = docRegistry.getHistoryDir(wctx.root, doc.id);
        const snapAbs = path.join(histDir, ev.snapshot);
        const mdAbs   = path.join(wctx.root, doc.mdPath);
        if (!isPathSafe(snapAbs, wctx.root) || !fs.existsSync(snapAbs)) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'snapshot missing' })); }
        if (!isPathSafe(mdAbs, wctx.root)) { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'access denied' })); }
        // Restore doc.md
        fs.copyFileSync(snapAbs, mdAbs);
        // J8: restore sibling assets referenced by this rev (flow/image)
        const docDir    = docRegistry.getDocumentDir(wctx.root, doc.id);
        const restoredAssets = [];
        if (Array.isArray(ev.assets) && ev.assets.length > 0) {
          for (const a of ev.assets) {
            if (!a.path) continue;
            const assetSnap = docRegistry.resolveAssetSnapshot(wctx.root, doc.id, a.path, rev);
            if (!assetSnap) continue;
            const assetTarget = path.join(docDir, a.path);
            if (!isPathSafe(assetTarget, wctx.root)) continue;
            try {
              fs.mkdirSync(path.dirname(assetTarget), { recursive: true });
              fs.copyFileSync(assetSnap, assetTarget);
              restoredAssets.push({ type: a.type, path: a.path });
            } catch (e) { console.error('[Restore] asset restore failed:', e.message); }
          }
        }
        // Restore is itself an edit: snapshot the result as a new rev (intermediate versions preserved).
        const restoreChange = restoredAssets.length > 0
          ? (restoredAssets.some(a => a.type === 'flow') ? 'flow' : 'image') : 'text';
        docRegistry.appendDocHistory(wctx.root, doc.id, {
          kind: 'edit', by: 'Hana', summary: `還原至第 ${rev} 版`,
          change: restoreChange,
          assets: restoredAssets.map(a => ({ type: a.type, path: a.path })),
        });
        const content = fs.readFileSync(mdAbs, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, content }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // POST /api/documents/:id/flowchart-dismiss — manual correction of the mechanical classifier's
  // over-flagging: an EMF/WMF *illustration* wrongly tagged as a Visio 待補 flowchart. Removes the
  // 待補 note + ```bpmn placeholder for that image, restores it as a plain ![](png), deletes the
  // *_pending.bpmn. Zero-AI (the commander already sees it's not a flowchart). body: { bpmn }.
  const docDismissMatch = pathname.match(/^\/api\/documents\/([^/]+)\/flowchart-dismiss$/);
  if (docDismissMatch && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const wctx = resolveWorkspace(req);
        const reg  = docRegistry.readRegistry(wctx.root);
        const doc  = reg.documents.find(d => d.id === docDismissMatch[1]);
        if (!doc) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'document not found' })); }
        const pendingRef = String((JSON.parse(body || '{}')).bpmn || '').replace(/^\.?\//, '');  // assets/imageN_pending.bpmn
        if (!/_pending\.bpmn$/i.test(pendingRef)) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'invalid bpmn ref' })); }
        const base   = path.basename(pendingRef).replace(/_pending\.bpmn$/i, '');  // imageN
        const pngRef  = pendingRef.replace(/_pending\.bpmn$/i, '.png');            // assets/imageN.png
        const mdAbs  = path.join(wctx.root, doc.mdPath);
        if (!isPathSafe(mdAbs, wctx.root) || !fs.existsSync(mdAbs)) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'doc.md not found' })); }
        let md = fs.readFileSync(mdAbs, 'utf8');
        const b = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // 待補 blockquote (optional) + the ```bpmn fence referencing *this* image's pending bpmn.
        // (?:(?!```)[\s\S])*? keeps the lazy match from crossing into another fence.
        const fence = '```bpmn(?:(?!```)[\\s\\S])*?' + b + '_pending\\.bpmn(?:(?!```)[\\s\\S])*?```';
        const re = new RegExp('(?:>[^\\n]*' + b + '\\.png[^\\n]*\\r?\\n\\s*\\r?\\n)?' + fence, 'g');
        const before = md;
        md = md.replace(re, '![](' + pngRef + ')');
        if (md === before) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'placeholder not found in doc.md' })); }
        fs.writeFileSync(mdAbs, md);
        try {                                   // drop the now-unused placeholder bpmn (keep the png)
          const pendAbs = path.join(path.dirname(mdAbs), pendingRef);
          if (isPathSafe(pendAbs, wctx.root) && fs.existsSync(pendAbs)) fs.unlinkSync(pendAbs);
        } catch (e) {}
        try { docRegistry.appendDocHistory(wctx.root, doc.id, { kind: 'edit', by: 'Hana', summary: '撤銷流程圖標記', change: 'text' }); }
        catch (e) { console.error('[DocHistory] dismiss edit log failed:', e.message); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, content: md }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // POST /api/documents/:id/image — insert/replace one image (SPEC-document-templates C). Saves the
  // uploaded image into the doc's assets/ and rewrites the Nth markdown image in doc.md — a placeholder
  // ![alt](placeholder) OR a real ![alt](assets/x.png) → ![alt](assets/<new>), preserving alt text.
  // body: { index: <0-based Nth ![] in doc order>, image: "data:image/<type>;base64,..." }.
  const docImgMatch = pathname.match(/^\/api\/documents\/([^/]+)\/image$/);
  if (docImgMatch && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 30 * 1024 * 1024) req.destroy(); });   // 30MB cap
    req.on('end', () => {
      try {
        const wctx = resolveWorkspace(req);
        const reg  = docRegistry.readRegistry(wctx.root);
        const doc  = reg.documents.find(d => d.id === docImgMatch[1]);
        if (!doc) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'document not found' })); }
        const payload = JSON.parse(body || '{}');
        const index = Number(payload.index);
        const m = String(payload.image || '').match(/^data:image\/([a-z0-9.+-]+);base64,(.+)$/i);
        if (!Number.isInteger(index) || index < 0 || !m) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'bad index or image' })); }
        const ext = ({ png: 'png', jpeg: 'jpg', jpg: 'jpg', gif: 'gif', webp: 'webp', 'svg+xml': 'svg' })[m[1].toLowerCase()] || 'png';
        const buf = Buffer.from(m[2], 'base64');
        const mdAbs = path.join(wctx.root, doc.mdPath);
        if (!isPathSafe(mdAbs, wctx.root) || !fs.existsSync(mdAbs)) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'doc.md not found' })); }
        const assetsDir = path.join(path.dirname(mdAbs), 'assets');
        fs.mkdirSync(assetsDir, { recursive: true });
        const fname = 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '.' + ext;
        fs.writeFileSync(path.join(assetsDir, fname), buf);
        // rewrite the Nth markdown image (![alt](url)), preserving its alt text
        let md = fs.readFileSync(mdAbs, 'utf8');
        // L2-04: extract el anchor for this image index BEFORE rewriting md
        let _imgElId = null;
        { let _ic = -1; for (const _ln of md.split('\n')) { if (/!\[[^\]]*\]\([^)]*\)/.test(_ln)) { if (++_ic === index) { const _em = _ln.match(/<!--\s*el:([^\s>]+)\s*-->/i); _imgElId = _em ? _em[1] : null; break; } } } }
        let i = -1, done = false, wasPlaceholder = false;
        md = md.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (full, alt, url) => {
          if (++i === index && !done) {
            done = true;
            wasPlaceholder = !/^assets\//i.test(String(url).trim());   // placeholder vs real image
            return '![' + alt + '](assets/' + fname + ')';
          }
          return full;
        });
        if (!done) {
          try { fs.unlinkSync(path.join(assetsDir, fname)); } catch (e) {}
          res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'image index ' + index + ' not found' }));
        }
        fs.writeFileSync(mdAbs, md);
        // Version history (DOC-J5/J8): inserting/replacing an image; snapshot the new asset.
        try {
          const newAssetRelPath = 'assets/' + fname;
          docRegistry.appendDocHistory(wctx.root, doc.id, {
            kind: 'edit', by: 'Hana',
            summary: `${wasPlaceholder ? '插入圖片' : '更換圖片'}（第 ${index + 1} 張）`,
            change: 'image',
            assets: [{ type: 'image', path: newAssetRelPath }],
          });
        } catch (e) { console.error('[DocHistory] image edit log failed:', e.message); }
        // L2-04: writeback new image binary into source.docx / source.pptx via el anchor
        if (_imgElId) {
          try {
            const _docDir  = path.dirname(mdAbs);
            const _srcDocx = path.join(_docDir, 'source.docx');
            const _srcPptx = path.join(_docDir, 'source.pptx');
            const _imgWbSc = path.join(RENDER_SERVICE_DIR, 'image-writeback.py');
            if (fs.existsSync(_imgWbSc)) {
              const _srcFile = fs.existsSync(_srcDocx) ? _srcDocx : (fs.existsSync(_srcPptx) ? _srcPptx : null);
              if (_srcFile) {
                const _wbRun = require('child_process').spawnSync(
                  venvPython(),
                  [_imgWbSc, _srcFile.endsWith('.pptx') ? '--pptx' : '--docx', _srcFile,
                   '--el-id', String(_imgElId), '--new-image', path.join(assetsDir, fname)],
                  { env: venvSpawnEnv(), timeout: 30000, encoding: 'utf8' }
                );
                if (_wbRun.status !== 0) {
                  console.warn('[L2-04] image-writeback failed:', (_wbRun.stderr || '').slice(0, 300));
                } else {
                  try {
                    const _wbRes = JSON.parse(_wbRun.stdout.trim() || '{}');
                    if (_wbRes.ok) {
                      docRegistry.appendDocHistory(wctx.root, doc.id, {
                        kind: 'edit', by: 'Hana',
                        summary: `換圖回寫 source（${_wbRes.media_part || ''}）`,
                        change: 'image',
                        assets: [{ type: 'source', path: _srcFile.endsWith('.pptx') ? 'source.pptx' : 'source.docx' }],
                      });
                    }
                  } catch (_pe) { /* JSON parse error */ }
                }
              }
            }
          } catch (_e) { console.warn('[L2-04] image writeback error:', _e.message); }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, content: md, asset: 'assets/' + fname }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ═══ P2-DOCX: 擬真上就地編輯（realistic in-place editing）endpoints ══════════════
  // All four edit the working copy (.documents/<id>/source.docx) only; the original 真身 at
  // registry.sourcePath is touched ONLY by /writeback-truth (manual, commander-triggered).

  // POST /api/documents/:id/inplace-text — DOC-P2D-01: run-level text writeback keyed by paraId.
  //   body: { edits: { "<paraId>": "<new plain text>", … } }  (from docx-preview <p data-el>)
  const docInplaceMatch = pathname.match(/^\/api\/documents\/([^/]+)\/inplace-text$/);
  if (docInplaceMatch && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 10 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      let _tmpEdits = null;
      try {
        const wctx = resolveWorkspace(req);
        const reg  = docRegistry.readRegistry(wctx.root);
        const doc  = reg.documents.find(d => d.id === docInplaceMatch[1]);
        if (!doc) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'document not found' })); }
        const edits = (JSON.parse(body || '{}').edits) || {};
        if (!edits || typeof edits !== 'object' || !Object.keys(edits).length) {
          res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'no edits' }));
        }
        const docDir  = docRegistry.getDocumentDir(wctx.root, doc.id);
        // DOC-P2P-01: same run-level text writeback for pptx — pick source.pptx + pptx-writeback.py
        // when there is no docx working copy (edits keyed by shape/para composite key vs paraId).
        const srcDocx = path.join(docDir, 'source.docx');
        const srcPptx = path.join(docDir, 'source.pptx');
        const srcFile = fs.existsSync(srcDocx) ? srcDocx : (fs.existsSync(srcPptx) ? srcPptx : null);
        if (!srcFile) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'source.docx/pptx not found' })); }
        const isPptx   = srcFile.endsWith('.pptx');
        const wbName   = isPptx ? 'pptx-writeback.py' : 'docx-writeback.py';
        const wbScript = path.join(RENDER_SERVICE_DIR, wbName);
        if (!fs.existsSync(wbScript)) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: wbName + ' missing' })); }
        const oldSource = fs.readFileSync(srcFile);   // COW baseline for history
        _tmpEdits = path.join(docDir, '_inplace_edits_tmp.json');
        fs.writeFileSync(_tmpEdits, JSON.stringify(edits), 'utf8');
        const run = require('child_process').spawnSync(
          venvPython(), [wbScript, isPptx ? '--pptx' : '--docx', srcFile, '--edits', _tmpEdits],
          { env: venvSpawnEnv(), timeout: 30000, encoding: 'utf8' }
        );
        let result;
        if (run.status === 0) {
          try { result = JSON.parse((run.stdout || '').trim() || '{"ok":false}'); }
          catch (pe) { result = { ok: false, error: 'writeback json parse error' }; }
        } else {
          result = { ok: false, error: (run.stderr || 'writeback failed').slice(0, 300) };
        }
        if (result.ok && (result.changed || 0) > 0) {
          try {
            docRegistry.appendDocHistory(wctx.root, doc.id, {
              kind: 'edit', by: '老闆', summary: `就地改字（回寫 ${result.changed} 段）`,
              change: 'text', assets: [{ type: 'source', path: isPptx ? 'source.pptx' : 'source.docx', beforeContent: oldSource }],
            });
          } catch (he) { console.error('[P2D-01] history append failed:', he.message); }
          docRegistry.setDocDirty(wctx.root, doc.id, true);
        }
        res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      } finally {
        if (_tmpEdits) { try { fs.unlinkSync(_tmpEdits); } catch (_) {} }
      }
    });
    return;
  }

  // ═══ P2-SHEET (SPEC-excel-import §4, XLSX-06/07/08): 試算表就地編輯回寫 + 風險偵測 ═══════
  // POST /api/documents/:id/sheet-writeback
  //   body: { changes:[{sheet,cell,formula?,value?}], values?:{sheet:{coord:disp}}, baseMtime? }
  //   ① 樂觀鎖：baseMtime 舊於現在的 source.xlsx mtime → 409（Excel 端已改，先重開編輯器，§4.3）。
  //   ② 只改被動格（xlsx-writeback.py，openpyxl）→ ③ 用編輯器重算值 overlay 重生 doc.md（openpyxl
  //   不保留公式快取，用 Univer 重算值補文字真身）→ ④ 記 edit 事件並快照 source.xlsx（延伸 J8/K）→
  //   ⑤ 標 dirty。所有動作僅碰工作複本 source.xlsx，registry.sourcePath 真身只由 /writeback-truth 動。
  const sheetWbMatch = pathname.match(/^\/api\/documents\/([^/]+)\/sheet-writeback$/);
  if (sheetWbMatch && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 20 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      let _tmpEdits = null, _tmpVals = null;
      try {
        const wctx = resolveWorkspace(req);
        const reg  = docRegistry.readRegistry(wctx.root);
        const doc  = reg.documents.find(d => d.id === sheetWbMatch[1]);
        if (!doc) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'document not found' })); }
        const payload = JSON.parse(body || '{}');
        const changes = Array.isArray(payload.changes) ? payload.changes : [];
        if (!changes.length) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'no changes' })); }
        const docDir  = docRegistry.getDocumentDir(wctx.root, doc.id);
        const srcXlsx = path.join(docDir, 'source.xlsx');
        if (!fs.existsSync(srcXlsx)) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'source.xlsx not found' })); }
        // ① optimistic concurrency: reject if source.xlsx changed on disk since the editor loaded it.
        const curMtime = fs.statSync(srcXlsx).mtimeMs;
        if (payload.baseMtime && curMtime > payload.baseMtime + 1000) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, conflict: true, error: 'source.xlsx 已被外部修改，請重新開啟編輯器再送出（避免蓋掉 Excel 端改動）' }));
        }
        const wbScript = path.join(RENDER_SERVICE_DIR, 'xlsx-writeback.py');
        if (!fs.existsSync(wbScript)) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'xlsx-writeback.py missing' })); }
        const oldSource = fs.readFileSync(srcXlsx);   // COW baseline for history snapshot
        const { spawnSync } = require('child_process');
        _tmpEdits = path.join(docDir, '_sheet_edits_tmp.json');
        fs.writeFileSync(_tmpEdits, JSON.stringify({ changes }), 'utf8');
        const run = spawnSync(venvPython(), [wbScript, '--edits', _tmpEdits, srcXlsx],
          { env: venvSpawnEnv(), timeout: 60000, encoding: 'utf8' });
        let result;
        if (run.status === 0) {
          try { result = JSON.parse((run.stdout || '').trim() || '{"ok":false}'); }
          catch (pe) { result = { ok: false, error: 'writeback json parse error' }; }
        } else {
          result = { ok: false, error: (run.stderr || 'writeback failed').slice(0, 300) };
        }
        if (result.ok && (result.changed || 0) > 0) {
          // ② regenerate doc.md from the new source.xlsx, injecting editor-recomputed values so
          //    formula cells stay searchable (openpyxl drops caches on save).
          try {
            const convScript = path.join(RENDER_SERVICE_DIR, 'xlsx-convert.py');
            const convArgs = [convScript, '--import', srcXlsx, docDir, '--source', doc.sourcePath || 'source.xlsx'];
            if (payload.values && typeof payload.values === 'object') {
              _tmpVals = path.join(docDir, '_sheet_vals_tmp.json');
              fs.writeFileSync(_tmpVals, JSON.stringify(payload.values), 'utf8');
              convArgs.push('--values', _tmpVals);
            }
            const cr = spawnSync(venvPython(), convArgs, { env: venvSpawnEnv(), timeout: 120000, encoding: 'utf8' });
            result.mdRegenerated = cr.status === 0;
            if (cr.status !== 0) result.mdWarning = (cr.stderr || 'doc.md regen failed').slice(0, 200);
          } catch (re) { result.mdRegenerated = false; result.mdWarning = re.message; }
          // ④ edit event + snapshot source.xlsx (J8 COW), ⑤ mark dirty
          try {
            docRegistry.appendDocHistory(wctx.root, doc.id, {
              kind: 'edit', by: '老闆', summary: `試算表編輯（回寫 ${result.changed} 格）`,
              change: 'data', assets: [{ type: 'source', path: 'source.xlsx', beforeContent: oldSource }],
            });
          } catch (he) { console.error('[XLSX-07] history append failed:', he.message); }
          docRegistry.setDocDirty(wctx.root, doc.id, true);
        }
        res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      } finally {
        if (_tmpEdits) { try { fs.unlinkSync(_tmpEdits); } catch (_) {} }
        if (_tmpVals)  { try { fs.unlinkSync(_tmpVals);  } catch (_) {} }
      }
    });
    return;
  }

  // GET /api/documents/:id/sheet-risk — XLSX-08：回寫失真風險偵測（圖表/樞紐/條件式格式/巨集…）+
  //   目前 source.xlsx mtime（供前端 pin baseMtime 做樂觀鎖）。
  const sheetRiskMatch = pathname.match(/^\/api\/documents\/([^/]+)\/sheet-risk$/);
  if (sheetRiskMatch && req.method === 'GET') {
    try {
      const wctx = resolveWorkspace(req);
      const reg  = docRegistry.readRegistry(wctx.root);
      const doc  = reg.documents.find(d => d.id === sheetRiskMatch[1]);
      if (!doc) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'document not found' })); }
      const docDir  = docRegistry.getDocumentDir(wctx.root, doc.id);
      const srcXlsx = path.join(docDir, 'source.xlsx');
      if (!fs.existsSync(srcXlsx)) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'source.xlsx not found' })); }
      const wbScript = path.join(RENDER_SERVICE_DIR, 'xlsx-writeback.py');
      const run = require('child_process').spawnSync(venvPython(), [wbScript, '--detect', srcXlsx],
        { env: venvSpawnEnv(), timeout: 30000, encoding: 'utf8' });
      let out = { ok: false };
      if (run.status === 0) { try { out = JSON.parse((run.stdout || '').trim() || '{"ok":false}'); } catch (e) {} }
      else { out = { ok: false, error: (run.stderr || 'detect failed').slice(0, 200) }; }
      try { out.sourceMtime = fs.statSync(srcXlsx).mtimeMs; } catch (_) {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
    }
  }

  // POST /api/documents/:id/source-image — DOC-P2D-02: replace one image binary in source.docx
  //   by its drawing anchor (wp:docPr id), reusing image-writeback.py. Preserves the original
  //   image frame (extent) — only the media bytes change.
  //   body: { docPrId: "<id>", image: "data:image/…;base64,…" }
  // Fidelity flow overlay (§13.11): return each flowchart's w14:paraId keyed by its source media
  // index (word/media/imageN), so the client can anchor bpmn-svg onto [data-el=paraId] instead of
  // guessing by image count/position. READ-ONLY (extract_flow_anchors never mutates the docx).
  const docFlowAnchorsMatch = pathname.match(/^\/api\/documents\/([^/]+)\/flow-anchors$/);
  if (docFlowAnchorsMatch && req.method === 'GET') {
    try {
      const wctx = resolveWorkspace(req);
      const reg  = docRegistry.readRegistry(wctx.root);
      const doc  = reg.documents.find(d => d.id === docFlowAnchorsMatch[1]);
      if (!doc) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'document not found' })); }
      const docDir  = docRegistry.getDocumentDir(wctx.root, doc.id);
      const srcDocx = path.join(docDir, 'source.docx');
      if (!fs.existsSync(srcDocx)) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'source.docx not found' })); }
      const conv = path.join(RENDER_SERVICE_DIR, 'docx-convert.py');
      const run = require('child_process').spawnSync(
        venvPython(), [conv, '--flow-anchors', srcDocx],
        { env: venvSpawnEnv(), timeout: 30000, encoding: 'utf8' }
      );
      let anchors = [];
      if (run.status === 0) { try { anchors = JSON.parse((run.stdout || '').trim() || '[]'); } catch (e) {} }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, anchors }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
    }
  }

  // GET /api/documents/:id/preview-docx — browser-safe copy of source.docx for the 擬真 render surfaces.
  // Browsers/docx-preview cannot decode EMF/WMF vector images (Word flowcharts, Visio-OLE previews), so
  // they render BLANK when source.docx is fed straight to docx.renderAsync. This endpoint returns a
  // DERIVED copy where those parts are transcoded to PNG (docx-convert.py --browser-safe). READ-ONLY:
  // source.docx (真身) is never touched; the result is cached beside the doc and rebuilt when source
  // changes. Used by the preview modal / 全螢幕 / split / print fidelity fetches (docx only).
  const docPreviewDocxMatch = pathname.match(/^\/api\/documents\/([^/]+)\/preview-docx$/);
  if (docPreviewDocxMatch && req.method === 'GET') {
    try {
      const wctx = resolveWorkspace(req);
      const reg  = docRegistry.readRegistry(wctx.root);
      const doc  = reg.documents.find(d => d.id === docPreviewDocxMatch[1]);
      if (!doc) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'document not found' })); }
      const docDir  = docRegistry.getDocumentDir(wctx.root, doc.id);
      const srcDocx = path.join(docDir, 'source.docx');
      if (!fs.existsSync(srcDocx)) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'source.docx not found' })); }

      const cacheDocx = path.join(docDir, '.preview-safe.docx');
      const srcMtime  = fs.statSync(srcDocx).mtimeMs;
      const fresh     = fs.existsSync(cacheDocx) && fs.statSync(cacheDocx).mtimeMs >= srcMtime;
      if (!fresh) {
        const conv = path.join(RENDER_SERVICE_DIR, 'docx-convert.py');
        const run = require('child_process').spawnSync(
          venvPython(), [conv, '--browser-safe', srcDocx, cacheDocx],
          { env: venvSpawnEnv(), timeout: 60000, encoding: 'utf8' }
        );
        if (run.status !== 0 || !fs.existsSync(cacheDocx)) {
          // Transcode failed → fall back to serving the raw source (blank EMF, but never breaks preview).
          console.error('[preview-docx] browser-safe build failed:', (run.stderr || run.stdout || '').slice(0, 500));
          const raw = fs.readFileSync(srcDocx);
          res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Content-Length': raw.length, 'X-Preview-Safe': '0' });
          return res.end(raw);
        }
      }
      const buf = fs.readFileSync(cacheDocx);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Length': buf.length,
        'Cache-Control': 'no-cache',
        'X-Preview-Safe': '1',
      });
      return res.end(buf);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
    }
  }

  const docSrcImgMatch = pathname.match(/^\/api\/documents\/([^/]+)\/source-image$/);
  if (docSrcImgMatch && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 30 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      let _tmpImg = null;
      try {
        const wctx = resolveWorkspace(req);
        const reg  = docRegistry.readRegistry(wctx.root);
        const doc  = reg.documents.find(d => d.id === docSrcImgMatch[1]);
        if (!doc) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'document not found' })); }
        const payload = JSON.parse(body || '{}');
        const docPrId = String(payload.docPrId || '').trim();
        const m = String(payload.image || '').match(/^data:image\/([a-z0-9.+-]+);base64,(.+)$/i);
        if (!docPrId || !m) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'bad docPrId or image' })); }
        const ext = ({ png: 'png', jpeg: 'jpg', jpg: 'jpg', gif: 'gif', webp: 'webp', 'svg+xml': 'svg' })[m[1].toLowerCase()] || 'png';
        const docDir  = docRegistry.getDocumentDir(wctx.root, doc.id);
        const srcDocx = path.join(docDir, 'source.docx');
        const srcPptx = path.join(docDir, 'source.pptx');
        const srcFile = fs.existsSync(srcDocx) ? srcDocx : (fs.existsSync(srcPptx) ? srcPptx : null);
        if (!srcFile) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'source file not found' })); }
        const imgWb = path.join(RENDER_SERVICE_DIR, 'image-writeback.py');
        if (!fs.existsSync(imgWb)) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'image-writeback.py missing' })); }
        const oldSource = fs.readFileSync(srcFile);
        _tmpImg = path.join(docDir, '_inplace_img_tmp.' + ext);
        fs.writeFileSync(_tmpImg, Buffer.from(m[2], 'base64'));
        const isPptx = srcFile.endsWith('.pptx');
        const elId   = isPptx ? (docPrId.includes('/') ? docPrId : docPrId + '/image') : docPrId;
        const run = require('child_process').spawnSync(
          venvPython(), [imgWb, isPptx ? '--pptx' : '--docx', srcFile, '--el-id', elId, '--new-image', _tmpImg],
          { env: venvSpawnEnv(), timeout: 30000, encoding: 'utf8' }
        );
        let result;
        if (run.status === 0) {
          try { result = JSON.parse((run.stdout || '').trim() || '{"ok":false}'); }
          catch (pe) { result = { ok: false, error: 'image-writeback json parse error' }; }
        } else {
          result = { ok: false, error: (run.stderr || 'image-writeback failed').slice(0, 300) };
        }
        if (result.ok) {
          try {
            docRegistry.appendDocHistory(wctx.root, doc.id, {
              kind: 'edit', by: '老闆', summary: `就地換圖（${result.media_part || ''}）`,
              change: 'image', assets: [{ type: 'source', path: isPptx ? 'source.pptx' : 'source.docx', beforeContent: oldSource }],
            });
          } catch (he) { console.error('[P2D-02] history append failed:', he.message); }
          docRegistry.setDocDirty(wctx.root, doc.id, true);
        }
        res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      } finally {
        if (_tmpImg) { try { fs.unlinkSync(_tmpImg); } catch (_) {} }
      }
    });
    return;
  }

  // POST /api/documents/:id/writeback-truth — DOC-P2D-04: manually push the working copy back to
  //   the original 真身 at registry.sourcePath. No hash/mtime guard, no auto git commit (spec §13.6).
  //   body: { mode: 'jia' | 'yi' }  — 乙(bpmn→svg)=default per spec, but its flowchart synthesis
  //   depends on a docPr↔bpmn map that import does not record (docx-convert.py:633 strips the
  //   anchor) → 乙 currently writes back like 甲 (原格式保留) with an honest warning. See TASK §P2-DOCX.
  const docWbTruthMatch = pathname.match(/^\/api\/documents\/([^/]+)\/writeback-truth$/);
  if (docWbTruthMatch && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const wctx = resolveWorkspace(req);
        const reg  = docRegistry.readRegistry(wctx.root);
        const doc  = reg.documents.find(d => d.id === docWbTruthMatch[1]);
        if (!doc) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'document not found' })); }
        const requestedMode = (JSON.parse(body || '{}').mode) === 'jia' ? 'jia' : 'yi';
        const srcRel = String(doc.sourcePath || '');
        if (!srcRel || /^生成[\\/]/.test(srcRel)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: '此文件無原始真身路徑（生成文件）— 無法寫回' }));
        }
        const docDir  = docRegistry.getDocumentDir(wctx.root, doc.id);
        const srcDocx = path.join(docDir, 'source.docx');
        const srcPptx = path.join(docDir, 'source.pptx');
        const workingCopy = fs.existsSync(srcDocx) ? srcDocx : (fs.existsSync(srcPptx) ? srcPptx : null);
        if (!workingCopy) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'source working copy not found' })); }
        const dest = path.resolve(wctx.root, srcRel);
        if (!isPathSafe(dest, wctx.root)) { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'destination out of bounds' })); }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        // 乙 (bpmn→svg) flowchart synthesis is not yet wired (see route comment) → both modes copy
        // the working copy (文字/圖片皆為最新；差異僅流程圖，尚未實作).
        fs.copyFileSync(workingCopy, dest);
        const effectiveMode = 'jia';
        const warning = requestedMode === 'yi'
          ? '乙（bpmn→svg 交付版）的流程圖合成尚未實作，已以甲（保留原始格式）寫回真身'
          : null;
        docRegistry.setDocDirty(wctx.root, doc.id, false);
        try {
          docRegistry.appendDocHistory(wctx.root, doc.id, {
            kind: 'edit', by: '老闆',
            summary: `寫回真身（${effectiveMode === 'jia' ? '甲·保留原格式' : '乙·交付版'}）→ ${srcRel}`,
          });
        } catch (he) { console.error('[P2D-04] history append failed:', he.message); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, mode: effectiveMode, requestedMode, dest: srcRel, warning }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // POST /api/documents/:id/open-desktop — DOC-P2D-05: open the source working copy in the OS
  //   default app (Word) for structural editing (add rows/cols etc.). Windows-first.
  const docOpenDeskMatch = pathname.match(/^\/api\/documents\/([^/]+)\/open-desktop$/);
  if (docOpenDeskMatch && req.method === 'POST') {
    req.on('data', () => {});
    req.on('end', () => {
      try {
        const wctx = resolveWorkspace(req);
        const reg  = docRegistry.readRegistry(wctx.root);
        const doc  = reg.documents.find(d => d.id === docOpenDeskMatch[1]);
        if (!doc) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'document not found' })); }
        const docDir  = docRegistry.getDocumentDir(wctx.root, doc.id);
        // workbook(xlsx) / doc(docx) / pptx 都可能是工作複本；擇一存在者用 OS 預設 App 開啟。
        const srcDocx = path.join(docDir, 'source.docx');
        const srcPptx = path.join(docDir, 'source.pptx');
        const srcXlsx = path.join(docDir, 'source.xlsx');
        const target  = fs.existsSync(srcDocx) ? srcDocx
                      : fs.existsSync(srcPptx) ? srcPptx
                      : fs.existsSync(srcXlsx) ? srcXlsx : null;
        if (!target) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'source working copy not found' })); }
        const { spawn } = require('child_process');
        if (process.platform === 'win32') {
          // `start` is a cmd builtin; empty "" is the window title arg so a quoted path isn't mistaken for it.
          spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        } else if (process.platform === 'darwin') {
          spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
        } else {
          spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, opened: path.basename(target) }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // POST /api/documents/:id/refresh-from-source — DESKRB-01/02:「更新AI記憶」（桌面編輯回讀）
  //   open-desktop 開的是 .documents/<id>/source.*（工作複本），使用者在 Word/Excel/PPT 改完存檔後，
  //   工作複本已含新內容。本端點：讀該工作複本 → 依 doc.type 重跑對應轉檔器（docx/pptx/xlsx-convert.py，
  //   --import <工作複本> <docDir>）重生 doc.md → appendDocHistory 記一筆 edit＋快照 source.*（COW）→
  //   setDocDirty。只碰工作複本，絕不 re-copy 原始真身（會蓋掉桌面改動）、不自動寫回真身。
  //   防呆：source.* mtime 未新於 doc.md → 回「桌面端沒有新變更」不重生（不做白工）。
  //   參考既有 sheet-writeback 的重生段（≈:2784–2805）。
  const docRefreshMatch = pathname.match(/^\/api\/documents\/([^/]+)\/refresh-from-source$/);
  if (docRefreshMatch && req.method === 'POST') {
    req.on('data', () => {});
    req.on('end', () => {
      try {
        const wctx = resolveWorkspace(req);
        const reg  = docRegistry.readRegistry(wctx.root);
        const doc  = reg.documents.find(d => d.id === docRefreshMatch[1]);
        if (!doc) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'document not found' })); }
        // 型別 → { 工作複本檔名, 轉檔器 }。舊值 'sheet' 視同 'workbook'（向後相容，§8）。
        const REFRESH_MAP = {
          doc:      { src: 'source.docx', conv: 'docx-convert.py' },
          pptx:     { src: 'source.pptx', conv: 'pptx-convert.py' },
          workbook: { src: 'source.xlsx', conv: 'xlsx-convert.py' },
        };
        const dtype = doc.type === 'sheet' ? 'workbook' : (doc.type || 'doc');
        const spec  = REFRESH_MAP[dtype];
        if (!spec) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: '此文件型別不支援桌面編輯回讀：' + dtype })); }
        const docDir  = docRegistry.getDocumentDir(wctx.root, doc.id);
        const srcPath = path.join(docDir, spec.src);
        if (!fs.existsSync(srcPath)) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: spec.src + ' 工作複本不存在（請先用「桌面開啟」編輯）' })); }
        const mdPath = path.join(docDir, 'doc.md');
        // ② mtime 防呆：工作複本未新於 doc.md → 桌面端沒有動過，不重生。
        const srcMtime = fs.statSync(srcPath).mtimeMs;
        const mdMtime  = fs.existsSync(mdPath) ? fs.statSync(mdPath).mtimeMs : 0;
        if (mdMtime && srcMtime <= mdMtime) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, changed: false, message: '桌面端沒有新變更' }));
        }
        const convScript = path.join(RENDER_SERVICE_DIR, spec.conv);
        if (!fs.existsSync(convScript)) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: spec.conv + ' missing' })); }
        const oldSource = fs.readFileSync(srcPath);   // COW baseline for history snapshot
        // 重跑轉檔器重生 doc.md。--source 帶原始真身相對路徑（僅寫進 frontmatter 顯示用，不 re-copy）。
        const convArgs = [convScript, '--import', srcPath, docDir, '--source', doc.sourcePath || spec.src];
        const cr = require('child_process').spawnSync(venvPython(), convArgs, { env: venvSpawnEnv(), timeout: 120000, encoding: 'utf8' });
        if (cr.status !== 0) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: (cr.stderr || 'doc.md 重生失敗').slice(0, 300) }));
        }
        // edit 事件 ＋ 快照 source.*（COW）＋ 標 dirty。
        try {
          docRegistry.appendDocHistory(wctx.root, doc.id, {
            kind: 'edit', by: '老闆', summary: '更新AI記憶（讀回桌面編輯）',
            change: 'data', assets: [{ type: 'source', path: spec.src, beforeContent: oldSource }],
          });
        } catch (he) { console.error('[DESKRB] history append failed:', he.message); }
        docRegistry.setDocDirty(wctx.root, doc.id, true);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, changed: true, message: '已讀回桌面編輯並記一版異動' }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // POST /api/block-decks/:name/export — editable pptx from block deck JSON (PRES-BLOCK-02)
  const blockExportMatch = pathname.match(/^\/api\/block-decks\/([^/]+)\/export$/);
  if (blockExportMatch && req.method === 'POST') {
    const deckName = blockExportMatch[1];
    req.on('data', () => {});
    req.on('end', async () => {
      try {
        const jsonPath = path.join(HARNESS_HOME, 'presentations', deckName + '.blocks.json');
        if (!fs.existsSync(jsonPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: `找不到 block deck：${deckName}.blocks.json` }));
        }
        const deckData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        const { buildEditablePptx } = require('./render-service/block-export');
        const exportDir = path.join(HARNESS_HOME, 'presentations', 'exports');
        const outputPath = await buildEditablePptx(deckData, deckName, exportDir, HARNESS_HOME);
        const relPath = path.relative(HARNESS_HOME, outputPath).replace(/\\/g, '/');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: relPath, slides: (deckData.slides || []).length }));
      } catch (e) {
        console.error('[block-export] error:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ===== Doc Export API (DOC-P4-01) =====================================================
  // POST /api/doc/export-docx — convert a workspace .md file to .docx (python-docx)
  if (pathname === '/api/doc/export-docx' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const { mdFilePath, bpmnImages } = JSON.parse(body || '{}');
        if (!mdFilePath) { res.writeHead(400); res.end(JSON.stringify({ error: '缺少 mdFilePath' })); return; }
        const wctx = resolveWorkspace(req);
        const fullMd = path.resolve(wctx.root, mdFilePath);
        if (!fullMd.startsWith(wctx.root)) { res.writeHead(403); res.end('Access denied'); return; }
        if (!fs.existsSync(fullMd)) { res.writeHead(404); res.end(JSON.stringify({ error: '找不到檔案' })); return; }
        const stamp = Date.now();
        const tmpDocx = path.join(os.tmpdir(), 'harness_export_' + stamp + '.docx');
        const script = path.join(RENDER_SERVICE_DIR, 'md-to-docx.py');
        // Write BPMN assets to temp dir so Python can embed them. Each item is either a legacy
        // PNG dataURL string, or { png: dataURL, svg: '<svg…>' } (DOC-I6-02 true-SVG embed).
        let tmpBpmnDir = null;
        if (Array.isArray(bpmnImages) && bpmnImages.length > 0) {
          tmpBpmnDir = path.join(os.tmpdir(), 'harness_bpmn_' + stamp);
          fs.mkdirSync(tmpBpmnDir, { recursive: true });
          bpmnImages.forEach((item, idx) => {
            let pngUrl = null, svgStr = null;
            if (typeof item === 'string') pngUrl = item;
            else if (item && typeof item === 'object') { pngUrl = item.png; svgStr = item.svg; }
            if (typeof pngUrl === 'string' && pngUrl.startsWith('data:image/png;base64,')) {
              try {
                const buf = Buffer.from(pngUrl.slice('data:image/png;base64,'.length), 'base64');
                fs.writeFileSync(path.join(tmpBpmnDir, idx + '.png'), buf);
              } catch (_) {}
            }
            if (typeof svgStr === 'string' && svgStr.indexOf('<svg') !== -1) {
              try { fs.writeFileSync(path.join(tmpBpmnDir, idx + '.svg'), svgStr, 'utf8'); } catch (_) {}
            }
          });
        }
        const scriptArgs = [script, fullMd, tmpDocx];
        if (tmpBpmnDir) scriptArgs.push(tmpBpmnDir);
        execFile(venvPython(), scriptArgs, { env: venvSpawnEnv(), timeout: 60000 }, (err, _stdout, stderr) => {
          if (tmpBpmnDir) {
            try { fs.readdirSync(tmpBpmnDir).forEach(f => { try { fs.unlinkSync(path.join(tmpBpmnDir, f)); } catch (_) {} }); fs.rmdirSync(tmpBpmnDir); } catch (_) {}
          }
          if (err || !fs.existsSync(tmpDocx)) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '匯出失敗: ' + (stderr || (err && err.message) || '未知錯誤') }));
            return;
          }
          const buf = fs.readFileSync(tmpDocx);
          try { fs.unlinkSync(tmpDocx); } catch (_) {}
          const fname = path.basename(fullMd, '.md') + '.docx';
          res.writeHead(200, {
            'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(fname),
            'Content-Length': buf.length
          });
          res.end(buf);
        });
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /api/doc/export-pdf-pptx — DV-05 (SPEC-document-registry §12): render source.pptx to PDF,
  // one landscape page per slide, via the SAME Playwright print mechanism as doc's export-pdf
  // (print bootstrap ?print=pptx reuses _renderPptxInto — no LibreOffice).
  if (pathname === '/api/doc/export-pdf-pptx' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', async () => {
      try {
        const { srcPath } = JSON.parse(body || '{}');
        if (!srcPath) { res.writeHead(400); res.end(JSON.stringify({ error: '缺少 srcPath' })); return; }
        const wctx = resolveWorkspace(req);
        const fullSrc = path.resolve(wctx.root, srcPath);
        if (!fullSrc.startsWith(wctx.root)) { res.writeHead(403); res.end('Access denied'); return; }
        if (!fs.existsSync(fullSrc)) { res.writeHead(404); res.end(JSON.stringify({ error: '找不到 source.pptx' })); return; }

        const { officeToPdf } = require('./render-service/doc-pdf');
        const printUrl = `http://localhost:${PORT}/?print=pptx`
          + `&path=${encodeURIComponent(srcPath)}`
          + `&workspace=${encodeURIComponent(wctx.root)}`;
        const pdfBuffer = await officeToPdf(printUrl);

        const fname = path.basename(fullSrc, path.extname(fullSrc)) + '.pdf';
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(fname),
          'Content-Length': pdfBuffer.length
        });
        res.end(pdfBuffer);
      } catch (e) {
        console.error('[export-pdf-pptx] error:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '匯出 PDF 失敗：' + (e && e.message || e) }));
      }
    });
    return;
  }

  // POST /api/doc/export-pdf-workbook — DV-06 (SPEC-document-registry §12): render source.xlsx to
  // PDF, every sheet in order with a page-break between (Excel「匯出整本活頁簿成 PDF」standard —
  // print-view fidelity, not pixel-perfect layout). Same Playwright mechanism, no LibreOffice.
  if (pathname === '/api/doc/export-pdf-workbook' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', async () => {
      try {
        const { srcPath } = JSON.parse(body || '{}');
        if (!srcPath) { res.writeHead(400); res.end(JSON.stringify({ error: '缺少 srcPath' })); return; }
        const wctx = resolveWorkspace(req);
        const fullSrc = path.resolve(wctx.root, srcPath);
        if (!fullSrc.startsWith(wctx.root)) { res.writeHead(403); res.end('Access denied'); return; }
        if (!fs.existsSync(fullSrc)) { res.writeHead(404); res.end(JSON.stringify({ error: '找不到 source.xlsx' })); return; }

        const { officeToPdf } = require('./render-service/doc-pdf');
        const printUrl = `http://localhost:${PORT}/?print=workbook`
          + `&path=${encodeURIComponent(srcPath)}`
          + `&workspace=${encodeURIComponent(wctx.root)}`;
        const pdfBuffer = await officeToPdf(printUrl);

        const fname = path.basename(fullSrc, path.extname(fullSrc)) + '.pdf';
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(fname),
          'Content-Length': pdfBuffer.length
        });
        res.end(pdfBuffer);
      } catch (e) {
        console.error('[export-pdf-workbook] error:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '匯出 PDF 失敗：' + (e && e.message || e) }));
      }
    });
    return;
  }

  // POST /api/doc/export-pdf-fidelity — FX-A-03 (SPEC-doc-fidelity-export.md §3): render source.docx
  // to PDF via the 擬真 print bootstrap (?print=doc-fidelity reuses docx-preview + _synthDocFlowSvg —
  // same engine as _renderDocFidelity's screen preview), so BPMN drawn on top of the flowchart
  // frames shows up in the PDF too. Same Playwright mechanism as pptx/workbook above.
  if (pathname === '/api/doc/export-pdf-fidelity' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', async () => {
      try {
        const { srcPath, docId, title } = JSON.parse(body || '{}');
        if (!srcPath) { res.writeHead(400); res.end(JSON.stringify({ error: '缺少 srcPath' })); return; }
        const wctx = resolveWorkspace(req);
        const fullSrc = path.resolve(wctx.root, srcPath);
        if (!fullSrc.startsWith(wctx.root)) { res.writeHead(403); res.end('Access denied'); return; }
        if (!fs.existsSync(fullSrc)) { res.writeHead(404); res.end(JSON.stringify({ error: '找不到 source.docx' })); return; }

        // FX-A-08: srcPath 磁碟上恆為 <docDir>/source.docx（工作複本固定命名），basename 沒意義
        // （永遠是「source」）— 原始檔名要用前端 _docDisplayName(doc) 帶來的 title（來自 doc 的
        // sourcePath front-matter），沒帶才退回 basename。
        const titleName = title || path.basename(fullSrc, path.extname(fullSrc));

        const { officeToPdf } = require('./render-service/doc-pdf');
        const printUrl = `http://localhost:${PORT}/?print=doc-fidelity`
          + `&path=${encodeURIComponent(srcPath)}`
          + `&docId=${encodeURIComponent(docId || '')}`
          + `&workspace=${encodeURIComponent(wctx.root)}`
          + `&title=${encodeURIComponent(titleName)}`;
        let pdfBuffer = await officeToPdf(printUrl);
        // FX-A-08: Chromium's page.pdf() can't set /Author, so post-process the metadata dict via
        // pikepdf (page content bytes untouched). /Title already matches document.title client-side
        // (initDocFidelityPrintMode); rewritten here too as a second guarantee.
        const tmpPdf = path.join(os.tmpdir(), 'harness_fidelity_pdf_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.pdf');
        try {
          fs.writeFileSync(tmpPdf, pdfBuffer);
          const metaScript = path.join(RENDER_SERVICE_DIR, 'pdf-metadata.py');
          const mr = require('child_process').spawnSync(venvPython(),
            [metaScript, tmpPdf, '--title', titleName, '--author', 'Hana 特助辦公室 (Hana Assistant Office)'],
            { env: venvSpawnEnv(), timeout: 30000, encoding: 'utf8' });
          if (mr.status === 0) {
            pdfBuffer = fs.readFileSync(tmpPdf);
          } else {
            console.error('[export-pdf-fidelity] pdf-metadata failed:', mr.stderr);
          }
        } finally {
          try { fs.unlinkSync(tmpPdf); } catch (_) {}
        }

        const fname = titleName + '.pdf';
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(fname),
          'Content-Length': pdfBuffer.length
        });
        res.end(pdfBuffer);
      } catch (e) {
        console.error('[export-pdf-fidelity] error:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '匯出 PDF 失敗：' + (e && e.message || e) }));
      }
    });
    return;
  }

  // POST /api/doc/export-docx-fidelity — FX-B (SPEC-doc-fidelity-export.md §4): 擬真 docx 交付檔.
  // Front-end renders each rebuilt assets/*.bpmn to a high-res PNG (bpmn-js) and POSTs them here;
  // docx-bpmn-bake.py takes source.docx as base and swaps ONLY the recognised flowchart drawings'
  // media to the BPMN raster (extent resized to keep frame width) — everything else byte-identical.
  // Output → .documents/<id>/exports/<title>.fidelity.docx; source.docx (真身) is NOT touched.
  if (pathname === '/api/doc/export-docx-fidelity' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 80 * 1024 * 1024) req.destroy(); });
    req.on('end', async () => {
      let tmpDir = null;
      try {
        const { srcPath, title, images, docId, bakeIntoSource } = JSON.parse(body || '{}');
        if (!srcPath) { res.writeHead(400); res.end(JSON.stringify({ error: '缺少 srcPath' })); return; }
        if (!Array.isArray(images) || !images.length) {
          res.writeHead(400); res.end(JSON.stringify({ error: '沒有可烤入的流程圖（BPMN）' })); return;
        }
        const wctx = resolveWorkspace(req);
        const fullSrc = path.resolve(wctx.root, srcPath);
        if (!fullSrc.startsWith(wctx.root)) { res.writeHead(403); res.end('Access denied'); return; }
        if (!fs.existsSync(fullSrc)) { res.writeHead(404); res.end(JSON.stringify({ error: '找不到 source.docx' })); return; }

        const bake = path.join(RENDER_SERVICE_DIR, 'docx-bpmn-bake.py');
        if (!fs.existsSync(bake)) { res.writeHead(500); res.end(JSON.stringify({ error: 'docx-bpmn-bake.py 不存在' })); return; }

        const docDir     = path.dirname(fullSrc);
        const exportsDir = path.join(docDir, 'exports');
        fs.mkdirSync(exportsDir, { recursive: true });
        tmpDir = path.join(docDir, '_bake_tmp_' + Date.now());
        fs.mkdirSync(tmpDir, { recursive: true });

        // decode each PNG dataURL to disk; build the bake manifest (stem = load-bearing imageN)
        const manImages = [];
        for (const it of images) {
          const stem = String(it && it.stem || '').replace(/[^A-Za-z0-9_]/g, '');
          const m = String(it && it.png || '').match(/^data:image\/png;base64,(.+)$/i);
          if (!stem || !m) continue;
          const pngPath = path.join(tmpDir, stem + '.png');
          fs.writeFileSync(pngPath, Buffer.from(m[1], 'base64'));
          manImages.push({ stem, png: pngPath, w: it.w || 0, h: it.h || 0 });
        }
        if (!manImages.length) { res.writeHead(400); res.end(JSON.stringify({ error: '流程圖影像解析失敗' })); return; }
        const manifestPath = path.join(tmpDir, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify({ images: manImages }), 'utf8');

        const safeTitle = String(title || path.basename(fullSrc, path.extname(fullSrc)) || 'document')
          .replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
        const outName = safeTitle + '.fidelity.docx';
        const outPath = path.join(exportsDir, outName);

        const run = require('child_process').spawnSync(
          venvPython(), [bake, '--docx', fullSrc, '--out', outPath, '--manifest', manifestPath],
          { env: venvSpawnEnv(), timeout: 120000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
        );
        let report = {};
        try { report = JSON.parse((run.stdout || '').trim() || '{}'); } catch (e) {}
        if (run.status !== 0 || !report.ok || !fs.existsSync(outPath)) {
          console.error('[export-docx-fidelity] bake failed:', run.stderr || run.stdout);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '烤入 BPMN 失敗：' + (report.error || run.stderr || '未知錯誤'), report }));
          return;
        }

        // 生成型 docx（doc-new）：流程圖是 BPMN_image<n> 書籤佔位，bake 走「插入 inline 圖」而非「換圖元」。
        // 這種 source.docx 是「doc.md 才是真身」的可重烤衍生交付物 → 就地把流程圖烤進 source.docx 本身，
        // 桌面 Word 直接開 source.docx 也看得到圖（與 .fidelity.docx 一致）。冪等（bake 重烤前先清該段）。
        // 匯入型（EMF 置換、真身寫回）刻意不在此觸碰 source.docx——那是 FX-C 帶快照＋顯式確認的破壞性動作。
        const inserted = Array.isArray(report.inserted) ? report.inserted.length : 0;
        const replaced = Array.isArray(report.replaced) ? report.replaced.length : 0;
        if (inserted > 0 && replaced === 0) {
          const run2 = require('child_process').spawnSync(
            venvPython(), [bake, '--docx', fullSrc, '--in-place', '--manifest', manifestPath],
            { env: venvSpawnEnv(), timeout: 120000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
          );
          let rep2 = {};
          try { rep2 = JSON.parse((run2.stdout || '').trim() || '{}'); } catch (e) {}
          if (run2.status !== 0 || !rep2.ok) {
            // 非致命：.fidelity.docx 已產出可交付；就地烤 source.docx 失敗只記 log，不擋下載。
            console.error('[export-docx-fidelity] in-place bake source.docx failed:', run2.stderr || run2.stdout);
          } else {
            console.log(`[export-docx-fidelity] source.docx baked in-place (inserted ${(rep2.inserted || []).length})`);
          }
        }

        // FX-C（匯入型真身寫回，spec §5／TASK §FX3）：置換路（replaced>0）刻意不自動觸碰 source.docx——
        // 客戶原檔是破壞性覆寫，只在指揮官顯式勾選「烤 BPMN 進真身」（bakeIntoSource:true，前端已跳確認
        // 對話框）才動手。動手前先快照舊 source.docx（COW baseline，走既有 registry 歷史機制，同
        // refresh-from-source :3241-3248 的作法）→ 可從版本歷史還原；成功後標「已變更」(dirty)。
        let inPlaceTruth = null;
        if (bakeIntoSource && replaced > 0) {
          if (!docId) {
            inPlaceTruth = { ok: false, error: '缺少 docId，無法記錄版本快照' };
          } else {
            const reg = docRegistry.readRegistry(wctx.root);
            const doc = reg.documents.find(d => d.id === docId);
            if (!doc) {
              inPlaceTruth = { ok: false, error: 'document not found: ' + docId };
            } else {
              try {
                const oldSource = fs.readFileSync(fullSrc);   // COW baseline BEFORE overwrite
                const run3 = require('child_process').spawnSync(
                  venvPython(), [bake, '--docx', fullSrc, '--in-place', '--manifest', manifestPath],
                  { env: venvSpawnEnv(), timeout: 120000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
                );
                let rep3 = {};
                try { rep3 = JSON.parse((run3.stdout || '').trim() || '{}'); } catch (e) {}
                if (run3.status !== 0 || !rep3.ok) {
                  console.error('[export-docx-fidelity] FX-C in-place bake failed:', run3.stderr || run3.stdout);
                  inPlaceTruth = { ok: false, error: rep3.error || run3.stderr || '烤入真身失敗' };
                } else {
                  docRegistry.appendDocHistory(wctx.root, doc.id, {
                    kind: 'edit', by: '老闆', summary: '烤 BPMN 進真身（source.docx，已自動快照可還原）',
                    change: 'data', assets: [{ type: 'source', path: 'source.docx', beforeContent: oldSource }],
                  });
                  docRegistry.setDocDirty(wctx.root, doc.id, true);
                  inPlaceTruth = { ok: true, replaced: (rep3.replaced || []).length };
                  console.log(`[export-docx-fidelity] FX-C source.docx baked in-place (replaced ${(rep3.replaced || []).length})`);
                }
              } catch (e3) {
                console.error('[export-docx-fidelity] FX-C error:', e3);
                inPlaceTruth = { ok: false, error: e3.message };
              }
            }
          }
        }

        const buf = fs.readFileSync(outPath);
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(outName),
          'Content-Length': buf.length,
          'X-Bake-Replaced': String(replaced + inserted),
          'X-Bake-Skipped': encodeURIComponent(JSON.stringify(report.skipped || [])),
          'X-Bake-InPlace-Truth': inPlaceTruth ? encodeURIComponent(JSON.stringify(inPlaceTruth)) : '',
        });
        res.end(buf);
      } catch (e) {
        console.error('[export-docx-fidelity] error:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '匯出擬真 docx 失敗：' + (e && e.message || e) }));
      } finally {
        if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {} }
      }
    });
    return;
  }

  // ===== Meeting Transcriber API (G3, SPEC-meeting-transcriber §7) =====================
  // Each meeting lives in <workspace>/.harness/runtime/meetings/<meetingId>/ (file-based, survives
  // restart — same spirit as chat_history). All python spawns use venvPython() + venvSpawnEnv().

  // POST /api/meeting/start — create meetingDir + initial meta + spawn meeting_record.py
  if (pathname === '/api/meeting/start' && req.method === 'POST') {
    const wctx = resolveWorkspace(req);
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const { spawn } = require('child_process');
        const opts = JSON.parse(body || '{}');
        const source = ['mic', 'loopback', 'both'].includes(opts.source) ? opts.source : 'both';
        const model = opts.model || 'medium';
        const lang = opts.lang || 'zh';
        const meetingId = 'meeting_' + Date.now();
        const meetingDir = path.join(wctx.harnessDir, 'runtime', 'meetings', meetingId);
        fs.mkdirSync(meetingDir, { recursive: true });
        // AT2-a: opts.topicId (may be '', '__none__', or a specific id) resolves via the current
        // workspace's merged topic list + defaultTopicId; an explicit opts.prompt still wins.
        const topicResolved = audioTopics.resolvePromptForRequest(HARNESS_HOME, wctx.root, opts.topicId);
        const promptToUse = opts.prompt || (topicResolved && topicResolved.prompt) || null;
        const meta = {
          meetingId, title: (opts.title || '').trim() || ('會議 ' + new Date().toLocaleString('zh-TW')),
          source, model, lang, startedAt: new Date().toISOString(), finishedAt: null,
          status: 'recording', workspace: wctx.root,
          topicId: (topicResolved && topicResolved.topic && topicResolved.topic.id) || null, prompt: promptToUse,
        };
        fs.writeFileSync(path.join(meetingDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
        meetingGitCommit(path.dirname(meetingDir), meetingId, 'started', 'Hana');
        const args = ['-u', path.join(RENDER_SERVICE_DIR, 'meeting_record.py'),
          '--dir', meetingDir, '--source', source, '--model', model, '--lang', lang];
        if (promptToUse) { args.push('--prompt', String(promptToUse)); }
        const child = spawn(venvPython(), args, { env: venvSpawnEnv(), windowsHide: true });
        let errTail = '';
        child.stderr.on('data', d => { errTail += d.toString(); if (errTail.length > 4000) errTail = errTail.slice(-4000); });
        child.on('exit', (code) => {
          const e = meetingProcs.get(meetingId);
          if (e) { e.exited = true; e.exitCode = code; }
          console.log(`[Meeting] ${meetingId} recorder exited code=${code}`);
        });
        child.on('error', (err) => { console.error('[Meeting] spawn error:', err.message); });
        meetingProcs.set(meetingId, { child, meetingDir, title: meta.title, errTailRef: () => errTail });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, meetingId, meta }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // POST /api/meeting/import — MTG-IMP-03: 匯入既有音檔/字幕 → 標準 meeting 目錄 → 觸發既有 finalize。
  // 兩種輸入擇一：本地路徑 { path }（大檔免上傳，只讀不複製）或 base64 上傳 { dataUrl, filename }
  // （沿用 /api/chat/upload 的 no-multipart-dep 慣例）。副檔名白名單分派：audio→STT、subtitle→純解析。
  // 大檔採「先回 meetingId、背景轉錄」，meta.status（importing→transcribing→done/error）供前端輪詢。
  if (pathname === '/api/meeting/import' && req.method === 'POST') {
    const wctx = resolveWorkspace(req);
    const MAX_BODY = 220 * 1024 * 1024;   // base64 上傳上限（~160MB 原始檔）；更大檔請用本地路徑模式
    let body = '';
    let tooBig = false;
    req.on('data', c => {
      if (tooBig) return;
      body += c;
      if (body.length > MAX_BODY) {
        tooBig = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '上傳檔案過大，請改用本地路徑模式（大檔免上傳）' }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig) return;
      try {
        const { spawn } = require('child_process');
        const opts = JSON.parse(body || '{}');
        const AUDIO_EXTS = ['.mp3', '.mp4', '.m4a', '.wav'];
        const SUB_EXTS = ['.vtt', '.srt'];
        const lang = opts.lang || 'zh';
        const model = opts.model || 'medium';

        // 決定來源：本地路徑（只讀）或 base64 上傳（存進 meetingDir/source.<ext>）。
        let ext = '', origin = '', localPath = null, uploadBuf = null;
        if (opts.path) {
          localPath = String(opts.path);
          origin = localPath;
          ext = path.extname(localPath).toLowerCase();
        } else if (opts.dataUrl) {
          let safeName = path.basename(String(opts.filename || 'import'))
            .replace(/[\\/]/g, '_').replace(/[\x00-\x1f<>:"|?*]/g, '_');
          if (!safeName || safeName === '.' || safeName.includes('..')) safeName = 'import';
          origin = safeName;
          ext = path.extname(safeName).toLowerCase();
          const m = String(opts.dataUrl).match(/^data:[^;,]*(?:;base64)?,([\s\S]*)$/);
          const b64 = m ? m[1] : String(opts.dataUrl);
          try { uploadBuf = Buffer.from(b64, 'base64'); } catch (e) { uploadBuf = null; }
          if (!uploadBuf || !uploadBuf.length) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: '上傳內容空白或格式錯誤' }));
          }
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: '需要 file（上傳）或 path（本地路徑）' }));
        }

        const kind = AUDIO_EXTS.includes(ext) ? 'audio' : (SUB_EXTS.includes(ext) ? 'subtitle' : null);
        if (!kind) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: '不支援的格式（僅 mp3/mp4/m4a/wav/vtt/srt）' }));
        }
        if (localPath && !fs.existsSync(localPath)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: '找不到本地檔案：' + localPath }));
        }

        const meetingId = 'meeting_' + Date.now();
        const meetingDir = path.join(wctx.harnessDir, 'runtime', 'meetings', meetingId);
        fs.mkdirSync(meetingDir, { recursive: true });
        let sourcePath = localPath;
        if (uploadBuf) {
          sourcePath = path.join(meetingDir, 'source' + ext);   // 只有上傳才落地；本地路徑不複製
          fs.writeFileSync(sourcePath, uploadBuf);
        }
        const meta = {
          meetingId,
          title: (opts.title || '').trim() || ('匯入 ' + new Date().toLocaleString('zh-TW')),
          source: 'import', origin, importKind: kind, model, lang,
          startedAt: new Date().toISOString(), finishedAt: null,
          status: 'importing', workspace: wctx.root,
        };
        fs.writeFileSync(path.join(meetingDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
        meetingGitCommit(path.dirname(meetingDir), meetingId, 'import started', 'Hana');

        const args = ['-u', path.join(RENDER_SERVICE_DIR, 'meeting_import.py'),
          '--dir', meetingDir, '--source', sourcePath, '--kind', kind, '--lang', lang, '--model', model];
        const child = spawn(venvPython(), args, { env: venvSpawnEnv(), windowsHide: true });
        let errTail = '';
        child.stderr.on('data', d => { errTail += d.toString(); if (errTail.length > 4000) errTail = errTail.slice(-4000); });
        child.on('exit', (code) => {
          console.log(`[Meeting] ${meetingId} import (${kind}) exited code=${code}`);
          if (code === 0) {
            // transcript.txt 就緒 → 完全重用既有多模型摘要（best-effort，比照錄製收尾）。
            finalizeMeetingSummary(meetingId, meetingDir, wctx).catch(e => console.error('[Meeting] import summary error:', e.message));
          } else {
            // python 通常已把 status 寫成 error；保底再標一次，附 errTail 尾巴供前端顯示。
            try {
              const mp = path.join(meetingDir, 'meta.json');
              const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
              if (m.status !== 'error') { m.status = 'error'; m.error = (errTail || 'import failed').slice(-500); fs.writeFileSync(mp, JSON.stringify(m, null, 2), 'utf8'); }
            } catch (e) {}
          }
        });
        child.on('error', (err) => { console.error('[Meeting] import spawn error:', err.message); });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, meetingId, meta }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // POST /api/meeting/stop — write STOP control file, wait for graceful finalise, then summarise
  if (pathname === '/api/meeting/stop' && req.method === 'POST') {
    const wctx = resolveWorkspace(req);
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { meetingId } = JSON.parse(body || '{}');
        const meetingDir = path.join(wctx.harnessDir, 'runtime', 'meetings', meetingId);
        if (!fs.existsSync(meetingDir)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'meeting not found' }));
        }
        fs.writeFileSync(path.join(meetingDir, 'STOP'), '');   // §8 graceful stop signal
        const metaPath = path.join(meetingDir, 'meta.json');
        let meta = null;
        const procEntry = meetingProcs.get(meetingId);
        for (let i = 0; i < 60; i++) {                          // up to ~30s for the recorder to drain
          await new Promise(r => setTimeout(r, 500));
          try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) {}
          if (meta && meta.status === 'done') break;
          // If the proc already exited (orphan from prior deploy), no need to keep waiting
          if (procEntry && procEntry.exited) break;
        }
        // Process died without cleanly writing done → mark aborted so frontend can unblock
        if (!meta || meta.status === 'recording') {
          const now = new Date().toISOString();
          meta = Object.assign(meta || {}, { status: 'aborted', finishedAt: now });
          try { fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8'); } catch (e) {}
          console.log(`[Meeting] stop: ${meetingId} proc exited without done → marked aborted`);
        }
        meetingProcs.delete(meetingId);
        meetingGitCommit(path.join(wctx.harnessDir, 'runtime', 'meetings'), meetingId, 'stopped', 'Hana');
        // G3: summarise + write to chat_history asynchronously (don't block the response).
        finalizeMeetingSummary(meetingId, meetingDir, wctx).catch(e => console.error('[Meeting] summary error:', e.message));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, meta }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // GET /api/meetings — list this workspace's meetings (newest first)
  if (pathname === '/api/meetings' && req.method === 'GET') {
    const wctx = resolveWorkspace(req);
    const meetingsDir = path.join(wctx.harnessDir, 'runtime', 'meetings');
    const list = [];
    try {
      for (const id of fs.readdirSync(meetingsDir)) {
        try { list.push(JSON.parse(fs.readFileSync(path.join(meetingsDir, id, 'meta.json'), 'utf8'))); } catch (e) {}
      }
    } catch (e) {}
    list.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ meetings: list }));
    return;
  }

  // GET /api/meeting/:id/transcript — live tail (frontend polls while recording)
  const mtgTxMatch = pathname.match(/^\/api\/meeting\/([^/]+)\/transcript$/);
  if (mtgTxMatch && req.method === 'GET') {
    const wctx = resolveWorkspace(req);
    const meetingDir = path.join(wctx.harnessDir, 'runtime', 'meetings', mtgTxMatch[1]);
    let transcript = '', labeled = null, corrected = null, meta = {}, partial = null;
    try { transcript = fs.readFileSync(path.join(meetingDir, 'transcript.txt'), 'utf8'); } catch (e) {}
    try { labeled = fs.readFileSync(path.join(meetingDir, 'transcript.labeled.txt'), 'utf8'); } catch (e) {}
    // MTG-CVW-01：校正稿（MCR1 產出），無則 null → 前端無校正版時不顯切換鈕。
    try { corrected = fs.readFileSync(path.join(meetingDir, 'transcript.corrected.txt'), 'utf8'); } catch (e) {}
    try { meta = JSON.parse(fs.readFileSync(path.join(meetingDir, 'meta.json'), 'utf8')); } catch (e) {}
    // MTG-P4-03：即時逐字（VAD 斷句前的暫定文字），錄製中才有意義；原子寫入見 meeting_record.py write_partial。
    try { partial = JSON.parse(fs.readFileSync(path.join(meetingDir, 'partial.json'), 'utf8')); } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ transcript, labeled, corrected, meta, partial }));
    return;
  }

  // GET /api/meeting/:id/audio — MTG-PLAY-01: serve audio.wav for playback, with HTTP Range support
  // (206 Partial Content) so <audio> can seek/scrub. Same Range pattern as the exports/<file> route above.
  const mtgAudioMatch = pathname.match(/^\/api\/meeting\/([^/]+)\/audio$/);
  if (mtgAudioMatch && req.method === 'GET') {
    const wctx = resolveWorkspace(req);
    const meetingsDir = path.join(wctx.harnessDir, 'runtime', 'meetings');
    const meetingDir = path.join(meetingsDir, mtgAudioMatch[1]);
    const filePath = path.join(meetingDir, 'audio.wav');
    if (!isPathSafe(meetingDir, path.resolve(meetingsDir)) || !fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: '找不到錄音檔' }));
    }
    const stat = fs.statSync(filePath);
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (isNaN(start) || start < 0) start = 0;
      if (isNaN(end) || end >= stat.size) end = stat.size - 1;
      if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
      res.writeHead(206, {
        'Content-Type': 'audio/wav',
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(filePath).pipe(res);
    }
    return;
  }

  // POST /api/meeting/:id/diarize — speaker separation (needs HF_TOKEN; may take minutes)
  const mtgDiaMatch = pathname.match(/^\/api\/meeting\/([^/]+)\/diarize$/);
  if (mtgDiaMatch && req.method === 'POST') {
    const wctx = resolveWorkspace(req);
    const diaChunks = [];
    req.on('data', (d) => { diaChunks.push(d); });
    req.on('end', () => {
      const meetingDir = path.join(wctx.harnessDir, 'runtime', 'meetings', mtgDiaMatch[1]);
      if (!process.env.HF_TOKEN) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'HF_TOKEN 未設定，無法執行語者分離（請先設環境變數並同意 pyannote 條款）。' }));
      }
      // 發言人數提示（§6.1）：可選；數的是「會發言的人」，不是與會人頭。留空 → 自動。
      let speakers = null;
      try { speakers = JSON.parse(Buffer.concat(diaChunks).toString() || '{}').speakers; } catch (e) {}
      const diaArgs = ['-u', path.join(RENDER_SERVICE_DIR, 'diarize.py'), '--dir', meetingDir];
      const nSpk = parseInt(speakers, 10);
      if (Number.isInteger(nSpk) && nSpk > 0) diaArgs.push('--speakers', String(nSpk));
      const { spawn } = require('child_process');
      const child = spawn(venvPython(), diaArgs,
        { env: venvSpawnEnv() });   // HF_TOKEN flows via process.env; diarize.py never logs it
      let out = '', err = '';
      child.stdout.on('data', d => { out += d.toString(); });
      child.stderr.on('data', d => { err += d.toString(); if (err.length > 4000) err = err.slice(-4000); });
      child.on('exit', (code) => {
        if (code === 0) {
          let result = {}; try { result = JSON.parse(out.trim()); } catch (e) {}
          let labeled = ''; try { labeled = fs.readFileSync(path.join(meetingDir, 'transcript.labeled.txt'), 'utf8'); } catch (e) {}
          meetingGitCommit(path.dirname(meetingDir), mtgDiaMatch[1], 'diarized', 'Hana');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result, labeled }));
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: (err || 'diarize failed').slice(-1500), code }));
        }
      });
      child.on('error', (e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      });
    });
    return;
  }

  // POST /api/meeting/:id/remap — post-meeting rename 人員A=王經理,人員B=李工
  const mtgRemapMatch = pathname.match(/^\/api\/meeting\/([^/]+)\/remap$/);
  if (mtgRemapMatch && req.method === 'POST') {
    const wctx = resolveWorkspace(req);
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const { map } = JSON.parse(body || '{}');
        const meetingDir = path.join(wctx.harnessDir, 'runtime', 'meetings', mtgRemapMatch[1]);
        const { spawn } = require('child_process');
        const child = spawn(venvPython(), ['-u', path.join(RENDER_SERVICE_DIR, 'diarize.py'), 'remap', '--dir', meetingDir, '--map', String(map || '')],
          { env: venvSpawnEnv() });
        let out = '', err = '';
        child.stdout.on('data', d => { out += d.toString(); });
        child.stderr.on('data', d => { err += d.toString(); });
        child.on('exit', (code) => {
          if (code === 0) {
            let labeled = ''; try { labeled = fs.readFileSync(path.join(meetingDir, 'transcript.labeled.txt'), 'utf8'); } catch (e) {}
            meetingGitCommit(path.dirname(meetingDir), mtgRemapMatch[1], 'remapped', '老闆');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, labeled }));
          } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: (err || 'remap failed').slice(-1000), code }));
          }
        });
        child.on('error', (e) => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); });
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── Meeting Management APIs (G9-W2, G10-W3, G11-W4, G12-W5) ──────────────────────────

  // DELETE /api/meeting/:id — hard delete dir + git "removed" commit (G9/W2, G10/W3)
  const mtgDelMatch = pathname.match(/^\/api\/meeting\/([^/]+)$/);
  if (mtgDelMatch && req.method === 'DELETE') {
    const wctx = resolveWorkspace(req);
    const meetingId = mtgDelMatch[1];
    const meetingsDir = path.join(wctx.harnessDir, 'runtime', 'meetings');
    const meetingDir = path.join(meetingsDir, meetingId);
    try {
      if (!fs.existsSync(meetingDir)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'meeting not found' }));
      }
      fs.rmSync(meetingDir, { recursive: true, force: true });
      meetingGitCommit(meetingsDir, meetingId, 'removed', '老闆');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // PUT /api/meeting/:id/meta — update title/tags/speakers (G9/W2)
  const mtgMetaMatch = pathname.match(/^\/api\/meeting\/([^/]+)\/meta$/);
  if (mtgMetaMatch && req.method === 'PUT') {
    const wctx = resolveWorkspace(req);
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const upd = JSON.parse(body || '{}');
        const meetingsDir = path.join(wctx.harnessDir, 'runtime', 'meetings');
        const meetingDir = path.join(meetingsDir, mtgMetaMatch[1]);
        const metaPath = path.join(meetingDir, 'meta.json');
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) {}
        if (upd.title !== undefined) meta.title = upd.title;
        if (upd.tags !== undefined) meta.tags = Array.isArray(upd.tags) ? upd.tags : [];
        if (upd.speakers !== undefined) meta.speakers = upd.speakers;
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
        meetingGitCommit(meetingsDir, mtgMetaMatch[1], 'meta updated', '老闆');
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, meta }));
      } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
    return;
  }

  // PUT /api/meeting/:id/transcript — save corrected transcript → commit (W5/W3)
  const mtgTxPutMatch = pathname.match(/^\/api\/meeting\/([^/]+)\/transcript$/);
  if (mtgTxPutMatch && req.method === 'PUT') {
    const wctx = resolveWorkspace(req);
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const { content } = JSON.parse(body || '{}');
        const meetingsDir = path.join(wctx.harnessDir, 'runtime', 'meetings');
        const meetingDir = path.join(meetingsDir, mtgTxPutMatch[1]);
        fs.writeFileSync(path.join(meetingDir, 'transcript.txt'), content || '', 'utf8');
        meetingGitCommit(meetingsDir, mtgTxPutMatch[1], 'transcript edited', '老闆');
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
    return;
  }

  // PUT /api/meeting/:id/summary — save edited summary → commit (G11/W4/W3)
  const mtgSumPutMatch = pathname.match(/^\/api\/meeting\/([^/]+)\/summary$/);
  if (mtgSumPutMatch && req.method === 'PUT') {
    const wctx = resolveWorkspace(req);
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const { content } = JSON.parse(body || '{}');
        const meetingsDir = path.join(wctx.harnessDir, 'runtime', 'meetings');
        const meetingDir = path.join(meetingsDir, mtgSumPutMatch[1]);
        fs.writeFileSync(path.join(meetingDir, 'summary.md'), content || '', 'utf8');
        meetingGitCommit(meetingsDir, mtgSumPutMatch[1], 'summary edited', '老闆');
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
    return;
  }

  // PUT /api/meeting/:id/actions — save edited Action items → commit (G11/W4/W3)
  const mtgActPutMatch = pathname.match(/^\/api\/meeting\/([^/]+)\/actions$/);
  if (mtgActPutMatch && req.method === 'PUT') {
    const wctx = resolveWorkspace(req);
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const { actions } = JSON.parse(body || '{}');
        const meetingsDir = path.join(wctx.harnessDir, 'runtime', 'meetings');
        const meetingDir = path.join(meetingsDir, mtgActPutMatch[1]);
        fs.writeFileSync(path.join(meetingDir, 'actions.json'), JSON.stringify(actions || [], null, 2), 'utf8');
        meetingGitCommit(meetingsDir, mtgActPutMatch[1], 'actions edited', '老闆');
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
    return;
  }

  // POST /api/meeting/:id/correct — MCR1: 單一模型逐字稿校正（只修辨識錯字，另存 transcript.corrected.txt）
  const mtgCorrectMatch = pathname.match(/^\/api\/meeting\/([^/]+)\/correct$/);
  if (mtgCorrectMatch && req.method === 'POST') {
    const wctx = resolveWorkspace(req);
    const meetingId = mtgCorrectMatch[1];
    const meetingsDir = path.join(wctx.harnessDir, 'runtime', 'meetings');
    const meetingDir = path.join(meetingsDir, meetingId);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(meetingDir, 'meta.json'), 'utf8')); } catch (e) {}
    let baseCheck = '';
    try { baseCheck = fs.readFileSync(path.join(meetingDir, 'transcript.labeled.txt'), 'utf8'); } catch (e) {}
    if (!baseCheck.trim()) { try { baseCheck = fs.readFileSync(path.join(meetingDir, 'transcript.txt'), 'utf8'); } catch (e) {} }
    if (!baseCheck.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: '逐字稿為空，無法校正' }));
    }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let opts = {};
      try { opts = JSON.parse(body || '{}'); } catch (e) {}
      if (_meetingCorrectInFlight.has(meetingId)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, status: 'already-running' }));
      }
      const runId = String(Date.now());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: 'processing', runId }));
      _meetingCorrectInFlight.add(meetingId);
      correctMeetingTranscript(meetingId, meetingDir, meta, { model: opts.model || DEFAULT_MEETING_MODEL, wsRoot: wctx.root, runId })
        .catch(e => console.error('[Meeting] correct error:', e.message))
        .finally(() => _meetingCorrectInFlight.delete(meetingId));
    });
    return;
  }

  // POST /api/meeting/:id/summarize — Claude → summary.md + actions.json (G11/W4)
  const mtgSumRunMatch = pathname.match(/^\/api\/meeting\/([^/]+)\/summarize$/);
  if (mtgSumRunMatch && req.method === 'POST') {
    const wctx = resolveWorkspace(req);
    const meetingId = mtgSumRunMatch[1];
    const meetingsDir = path.join(wctx.harnessDir, 'runtime', 'meetings');
    const meetingDir = path.join(meetingsDir, meetingId);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(meetingDir, 'meta.json'), 'utf8')); } catch (e) {}
    // MTG-COR-03: 有校正版就吃校正版（corrected → labeled → raw）
    let transcript = '';
    try { transcript = fs.readFileSync(path.join(meetingDir, 'transcript.corrected.txt'), 'utf8'); } catch (e) {}
    if (!transcript.trim()) { try { transcript = fs.readFileSync(path.join(meetingDir, 'transcript.labeled.txt'), 'utf8'); } catch (e) {} }
    if (!transcript.trim()) { try { transcript = fs.readFileSync(path.join(meetingDir, 'transcript.txt'), 'utf8'); } catch (e) {} }
    if (!transcript.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: '逐字稿為空，無法產摘要' }));
    }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let sumOpts = {};
      try { sumOpts = JSON.parse(body || '{}'); } catch (e) {}
      if (_meetingSummarizeInFlight.has(meetingId)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, status: 'already-running' }));
      }
      const runId = String(Date.now());   // MTG-SUM-14: returned so the poller can confirm THIS run finished (vs. reading a stale prior run's data)
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: 'processing', runId }));
      _meetingSummarizeInFlight.add(meetingId);
      meetingSummarizeToFiles(meetingId, meetingDir, meetingsDir, meta, transcript, wctx, {
        models: sumOpts.models, mode: sumOpts.mode, chosenModel: sumOpts.chosenModel, parts: sumOpts.parts, runId
      }).catch(e => console.error('[Meeting] summarize error:', e.message))
        .finally(() => _meetingSummarizeInFlight.delete(meetingId));
    });
    return;
  }

  // POST /api/meeting/:id/summary/finalize — MTG-SUM-03 收尾: pick/merge from ALREADY-generated
  // versions (no re-run of models for pick). body { mode:'pick'|'merge', chosenModel? }
  const mtgFinMatch = pathname.match(/^\/api\/meeting\/([^/]+)\/summary\/finalize$/);
  if (mtgFinMatch && req.method === 'POST') {
    const wctx = resolveWorkspace(req);
    const meetingId = mtgFinMatch[1];
    const meetingsDir = path.join(wctx.harnessDir, 'runtime', 'meetings');
    const meetingDir = path.join(meetingsDir, meetingId);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(meetingDir, 'meta.json'), 'utf8')); } catch (e) {}
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let opts = {};
      try { opts = JSON.parse(body || '{}'); } catch (e) {}
      const okParsed = _loadMeetingVersionsForFinalize(meetingDir, meta);
      const versions = (meta.summary && Array.isArray(meta.summary.versions)) ? meta.summary.versions : [];
      if (!okParsed.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: '尚無可用的模型版本，請先產生摘要' }));
      }
      const title = meta.title || meetingId;
      _finalizeMeetingSummary({ meetingId, meetingDir, meetingsDir, title, okParsed, versions, mode: opts.mode || 'pick', chosenModel: opts.chosenModel, wsRoot: wctx.root, actor: '老闆' })
        .then(fin => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, mode: fin.mode, chosenModel: fin.chosenModel })); })
        .catch(e => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); });
    });
    return;
  }

  // GET /api/meeting/:id/history — git log for this meeting (G10/W3)
  const mtgHistMatch = pathname.match(/^\/api\/meeting\/([^/]+)\/history$/);
  if (mtgHistMatch && req.method === 'GET') {
    const wctx = resolveWorkspace(req);
    const meetingId = mtgHistMatch[1];
    const meetingsDir = path.join(wctx.harnessDir, 'runtime', 'meetings');
    try {
      const { spawnSync } = require('child_process');
      const r = spawnSync('git', ['log', '--pretty=format:%H|%ai|%s', '--all', '--', meetingId + '/'], { cwd: meetingsDir });
      const lines = (r.stdout || '').toString().split('\n').filter(Boolean);
      const commits = lines.map(l => { const [hash, date, ...msg] = l.split('|'); return { hash, date, message: msg.join('|') }; });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ commits }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ commits: [] }));
    }
    return;
  }

  // GET /api/meeting/:id/diff?commit=<hash> — show diff for one commit (G10/W3)
  const mtgDiffMatch = pathname.match(/^\/api\/meeting\/([^/]+)\/diff$/);
  if (mtgDiffMatch && req.method === 'GET') {
    const wctx = resolveWorkspace(req);
    const commit = (parsedUrl.query.commit || '').toString().replace(/[^a-f0-9]/gi, '');
    const meetingsDir = path.join(wctx.harnessDir, 'runtime', 'meetings');
    try {
      const { spawnSync } = require('child_process');
      const args = commit ? ['show', '--stat', '-p', commit] : ['show', 'HEAD'];
      const r = spawnSync('git', args, { cwd: meetingsDir });
      const diff = (r.stdout || '').toString();
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ diff }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ diff: '' }));
    }
    return;
  }

  // GET /api/meeting/:id — full meeting detail: meta + summary + actions (G11)
  const mtgGetMatch = pathname.match(/^\/api\/meeting\/([^/]+)$/);
  if (mtgGetMatch && req.method === 'GET') {
    const wctx = resolveWorkspace(req);
    const meetingId = mtgGetMatch[1];
    const meetingsDir = path.join(wctx.harnessDir, 'runtime', 'meetings');
    const meetingDir = path.join(meetingsDir, meetingId);
    let meta = {}, summary = null, keypoints = null, actions = null;
    try { meta = JSON.parse(fs.readFileSync(path.join(meetingDir, 'meta.json'), 'utf8')); } catch (e) {}
    try { summary = fs.readFileSync(path.join(meetingDir, 'summary.md'), 'utf8'); } catch (e) {}
    try { keypoints = fs.readFileSync(path.join(meetingDir, 'keypoints.md'), 'utf8'); } catch (e) {}
    // P3 §5.5.5 相容: pre-P3 meetings only have 【重點】 embedded in summary.md → fall back, no migration.
    if ((!keypoints || !keypoints.trim()) && summary) keypoints = _extractLegacyKeypoints(summary);
    try { actions = JSON.parse(fs.readFileSync(path.join(meetingDir, 'actions.json'), 'utf8')); } catch (e) {}
    // MTG-SUM-05: per-model versions + MTG-SUM-03 provenance for the UI.
    const versions = _readMeetingVersions(meetingDir, meta);
    const provenance = (meta && meta.summary) || null;
    // MTG-SUM-04: lazy backfill — transcript exists but no summary.md → kick a default single-model run.
    let summarizing = _meetingSummarizeInFlight.has(meetingId);
    if (!summary || !summary.trim()) {
      let transcript = '';
      try { transcript = fs.readFileSync(path.join(meetingDir, 'transcript.labeled.txt'), 'utf8'); } catch (e) {}
      if (!transcript.trim()) { try { transcript = fs.readFileSync(path.join(meetingDir, 'transcript.txt'), 'utf8'); } catch (e) {} }
      if (transcript.trim()) summarizing = _maybeLazySummarize(meetingId, meetingDir, meetingsDir, meta, transcript, wctx);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ meta, summary, keypoints, actions, versions, provenance, summarizing }));
    return;
  }

  // GET /api/meeting/:id/export/markdown — MTG-EXP-01/03: read-only assembled markdown (§3), used
  // by the ?print=meeting PDF bootstrap. Playwright's page.goto can't set the X-Workspace header, so
  // it navigates with ?workspace=<ws> instead — resolveWorkspace() already falls back to that query
  // param (same convention as the pptx/workbook/doc-fidelity print URLs above).
  const mtgExportMdMatch = pathname.match(/^\/api\/meeting\/([^/]+)\/export\/markdown$/);
  if (mtgExportMdMatch && req.method === 'GET') {
    const wctx = resolveWorkspace(req);
    const meetingId = mtgExportMdMatch[1];
    const parsedQ = url.parse(req.url, true).query;
    const sel = parsedQ.selection || 'final';
    const inc = { actions: parsedQ.actions !== '0', transcript: parsedQ.transcript === '1' };
    const meetingsDir = path.join(wctx.harnessDir, 'runtime', 'meetings');
    const meetingDir = path.join(meetingsDir, meetingId);
    if (!path.resolve(meetingDir).startsWith(path.resolve(meetingsDir) + path.sep) || !fs.existsSync(meetingDir)) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '找不到會議' })); return;
    }
    let meta = {}; try { meta = JSON.parse(fs.readFileSync(path.join(meetingDir, 'meta.json'), 'utf8')); } catch (e) {}
    try {
      const markdown = assembleMeetingMarkdown(meetingDir, meta, { selection: sel, include: inc });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, title: meta.title || meetingId, markdown }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /api/meeting/:id/export — MTG-EXP-02/03 (SPEC-meeting-export.md §5/§6): assemble markdown
  // (§3) then hand off to whichever engine matches `format` — docx via md-to-docx.py (SAME engine as
  // /api/doc/export-docx), pdf via the ?print=meeting bootstrap + officeToPdf() (SAME Playwright
  // mechanism as export-pdf-pptx/workbook/fidelity above). 天條: read-only assembly; the only write
  // is the produced file under this meeting's own exports/ — summary/keypoints/actions/transcript
  // are never touched.
  const mtgExportMatch = pathname.match(/^\/api\/meeting\/([^/]+)\/export$/);
  if (mtgExportMatch && req.method === 'POST') {
    const wctx = resolveWorkspace(req);
    const meetingId = mtgExportMatch[1];
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { format, selection, include } = JSON.parse(body || '{}');
        const fmt = format === 'pdf' ? 'pdf' : 'docx';
        const sel = selection || 'final';
        const inc = { actions: !(include && include.actions === false), transcript: !!(include && include.transcript) };
        const meetingsDir = path.join(wctx.harnessDir, 'runtime', 'meetings');
        const meetingDir = path.join(meetingsDir, meetingId);
        if (!path.resolve(meetingDir).startsWith(path.resolve(meetingsDir) + path.sep)) {
          res.writeHead(403); res.end('Access denied'); return;
        }
        if (!fs.existsSync(meetingDir)) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '找不到會議' })); return; }
        let meta = {}; try { meta = JSON.parse(fs.readFileSync(path.join(meetingDir, 'meta.json'), 'utf8')); } catch (e) {}
        const title = meta.title || meetingId;
        const exportsDir = path.join(meetingDir, 'exports');
        fs.mkdirSync(exportsDir, { recursive: true });
        const fname = _mtgExportFilename(title, sel, fmt);
        const outPath = path.join(exportsDir, fname);

        if (fmt === 'docx') {
          const mdContent = assembleMeetingMarkdown(meetingDir, meta, { selection: sel, include: inc });
          const stamp = Date.now();
          const tmpMd = path.join(os.tmpdir(), 'harness_mtg_export_' + stamp + '.md');
          fs.writeFileSync(tmpMd, mdContent, 'utf8');
          const script = path.join(RENDER_SERVICE_DIR, 'md-to-docx.py');
          execFile(venvPython(), [script, tmpMd, outPath], { env: venvSpawnEnv(), timeout: 60000 }, (err, _stdout, stderr) => {
            try { fs.unlinkSync(tmpMd); } catch (_) {}
            if (err || !fs.existsSync(outPath)) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: '匯出失敗: ' + (stderr || (err && err.message) || '未知錯誤') }));
              return;
            }
            const buf = fs.readFileSync(outPath);
            res.writeHead(200, {
              'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(fname),
              'Content-Length': buf.length
            });
            res.end(buf);
          });
        } else {
          const { officeToPdf } = require('./render-service/doc-pdf');
          const printUrl = `http://localhost:${PORT}/?print=meeting`
            + `&id=${encodeURIComponent(meetingId)}`
            + `&selection=${encodeURIComponent(sel)}`
            + `&actions=${inc.actions ? '1' : '0'}`
            + `&transcript=${inc.transcript ? '1' : '0'}`
            + `&workspace=${encodeURIComponent(wctx.root)}`;
          const pdfBuffer = await officeToPdf(printUrl);
          fs.writeFileSync(outPath, pdfBuffer);
          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(fname),
            'Content-Length': pdfBuffer.length
          });
          res.end(pdfBuffer);
        }
      } catch (e) {
        console.error('[meeting export] error:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /api/stt/loopback/start — F6: spawn one-shot loopback_capture.py, return { captureId }
  if (pathname === '/api/stt/loopback/start' && req.method === 'POST') {
    const wctx = resolveWorkspace(req);
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const { spawn } = require('child_process');
        const opts = JSON.parse(body || '{}');
        // F7 (§6b.8): model comes from the chat STT selector (default small); no longer hard-wired medium.
        const model = opts.model || 'small';
        const lang = opts.lang || 'zh';
        const captureId = 'sttlb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const captureDir = path.join(wctx.harnessDir, 'runtime', 'stt_loopback', captureId);
        fs.mkdirSync(captureDir, { recursive: true });
        // AT2-c: same topicId resolution as the mic path (F4) — opts.topicId('' | '__none__' | id).
        const topicResolved = audioTopics.resolvePromptForRequest(HARNESS_HOME, wctx.root, opts.topicId);
        const args = ['-u', path.join(RENDER_SERVICE_DIR, 'loopback_capture.py'),
          '--dir', captureDir, '--model', model, '--lang', lang];
        if (topicResolved && topicResolved.prompt) { args.push('--prompt', String(topicResolved.prompt)); }
        const child = spawn(venvPython(), args, { env: venvSpawnEnv(), windowsHide: true });
        let errTail = '';
        child.stderr.on('data', d => { errTail += d.toString(); if (errTail.length > 4000) errTail = errTail.slice(-4000); });
        child.on('exit', (code) => {
          const e = sttLoopbackCaptures.get(captureId);
          if (e) { e.exited = true; e.exitCode = code; e.errTail = errTail; }
        });
        child.on('error', (err) => { console.error('[F6 loopback] spawn error:', err.message); });
        sttLoopbackCaptures.set(captureId, { child, captureDir });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ captureId }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /api/stt/loopback/stop — F6: signal stop (or just wait if already ending on its own),
  // block until result.json appears (manual/silence/maxDuration all converge on the same file),
  // then return { text, endedBy }. Reuses the meeting_record.py STOP-file convention.
  if (pathname === '/api/stt/loopback/stop' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { captureId } = JSON.parse(body || '{}');
        const entry = sttLoopbackCaptures.get(captureId);
        const wctx = resolveWorkspace(req);
        const captureDir = (entry && entry.captureDir) ||
          path.join(wctx.harnessDir, 'runtime', 'stt_loopback', String(captureId || ''));
        if (!fs.existsSync(captureDir)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'capture not found' }));
        }
        const resultPath = path.join(captureDir, 'result.json');
        if (!fs.existsSync(resultPath)) {
          try { fs.writeFileSync(path.join(captureDir, 'STOP'), ''); } catch (e) {}
        }
        let result = null;
        for (let i = 0; i < 240; i++) {   // up to ~2min for the python side to finalize + transcribe
          try { result = JSON.parse(fs.readFileSync(resultPath, 'utf8')); } catch (e) {}
          if (result) break;
          if (entry && entry.exited) break;   // child died without writing result → stop waiting
          await new Promise(r => setTimeout(r, 500));
        }
        sttLoopbackCaptures.delete(captureId);
        if (!result) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: '擷取未能完成', endedBy: 'error' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: result.text || '', endedBy: result.endedBy || 'manual' }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // GET /api/stt/loopback/poll — F6: non-blocking check for silence/maxDuration auto-end (never
  // writes STOP — only /stop does that). Frontend polls this so it can auto-fill without the user
  // pressing stop when the VAD or hard cap already ended the capture server-side.
  if (pathname === '/api/stt/loopback/poll' && req.method === 'GET') {
    const wctx = resolveWorkspace(req);
    const captureId = (parsedUrl.query.captureId || '').toString();
    const entry = sttLoopbackCaptures.get(captureId);
    const captureDir = (entry && entry.captureDir) ||
      path.join(wctx.harnessDir, 'runtime', 'stt_loopback', captureId);
    let result = null;
    try { result = JSON.parse(fs.readFileSync(path.join(captureDir, 'result.json'), 'utf8')); } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(result
      ? JSON.stringify({ done: true, text: result.text || '', endedBy: result.endedBy || 'silence' })
      : JSON.stringify({ done: false }));
    return;
  }

  // GET /api/stt/loopback/partial — FVOICE2-03: real-time rolling transcript while a loopback
  // capture is still recording. loopback_capture.py writes partial.json every time it cuts a
  // rolling segment (§6b.3); this just reads whatever is there right now (empty text if none yet).
  if (pathname === '/api/stt/loopback/partial' && req.method === 'GET') {
    const wctx = resolveWorkspace(req);
    const captureId = (parsedUrl.query.captureId || '').toString();
    const entry = sttLoopbackCaptures.get(captureId);
    const captureDir = (entry && entry.captureDir) ||
      path.join(wctx.harnessDir, 'runtime', 'stt_loopback', captureId);
    let partial = null;
    try { partial = JSON.parse(fs.readFileSync(path.join(captureDir, 'partial.json'), 'utf8')); } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: (partial && partial.text) || '' }));
    return;
  }

  // POST /api/stt — F4/F5 shared: audio blob (raw body) → stt.py → { text }
  if (pathname === '/api/stt' && req.method === 'POST') {
    const lang = (parsedUrl.query.lang || 'zh').toString();
    // F7 (§6b.8): model comes from the chat STT selector (default small); no longer hard-wired medium.
    const model = (parsedUrl.query.model || 'small').toString();
    // AT2-b: topicId ('' | '__none__' | id) from query, resolved against the requesting workspace.
    const topicId = (parsedUrl.query.topicId || '').toString();
    const wctxStt = resolveWorkspace(req);
    const topicResolved = audioTopics.resolvePromptForRequest(HARNESS_HOME, wctxStt.root, topicId);
    const chunks = [];
    let tooBig = false;
    req.on('data', d => { chunks.push(d); if (chunks.reduce((n, c) => n + c.length, 0) > 30 * 1024 * 1024) tooBig = true; });
    req.on('end', async () => {
      if (tooBig) { res.writeHead(413, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: '音訊過大' })); }
      let tmp = null;
      try {
        const buf = Buffer.concat(chunks);
        const ext = (req.headers['content-type'] || '').includes('ogg') ? '.ogg' : '.webm';
        tmp = path.join(os.tmpdir(), 'hana_stt_' + Date.now() + '_' + Math.random().toString(36).slice(2) + ext);
        fs.writeFileSync(tmp, buf);
        // Warm worker (no per-request model reload). Interactive short clip → beam_size 1 (greedy).
        const result = await sttTranscribe({ audio: tmp, lang, model, beamSize: 1, prompt: topicResolved && topicResolved.prompt });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: result.text || '', language: result.language || lang }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (e.message || 'stt failed').slice(-800) }));
      } finally {
        if (tmp) { try { fs.unlinkSync(tmp); } catch (_) {} }
      }
    });
    return;
  }

  // R2 (SPEC-portal-architecture.md §3.2): SPA fallback for the frontend router's /app/<view>
  // paths. Reaches here only if nothing above claimed the request (all /api, /raw, /vendor
  // handlers run first) — same no-cache index.html response as '/', so a reload/deep-link on
  // /app/chat etc. re-serves the shell and the client-side router (router.js) takes it from there.
  if (pathname === '/app' || pathname.indexOf('/app/') === 0) {
    const htmlPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' });
      res.end(fs.readFileSync(htmlPath));
      return;
    }
  }

  // 404 For any other requests
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// --- Claude MCP Integration Helpers ---
const https = require('https');
// Harness's own home in the active workspace — deliberately INDEPENDENT of .worktable (which
// is a project-governance concept). Layout:
//   .harness/knowledge/  (git-TRACKED)   memory/ + skills/  — the accumulating "brain"
//   .harness/commands/   (git-TRACKED)   slash-command registry (one .md per command)
//   .harness/runtime/    (git-IGNORED)   chat_history/ + v2a context_*.md — per-machine
// .gitignore must ignore ONLY .harness/runtime/ (a parent-ignored dir can't re-include a child).
let HARNESS_DIR = path.join(WORKSPACE_ROOT, '.harness');
let CHAT_HISTORY_DIR = path.join(HARNESS_DIR, 'runtime', 'chat_history');
let KNOWLEDGE_DIR = path.join(HARNESS_DIR, 'knowledge');   // project-scoped (MEMORY.md, PERSONA.md, skills/)
let COMMANDS_DIR = path.join(HARNESS_DIR, 'commands');
// GLOBAL knowledge — shared across ALL workspaces. Lives in the HARNESS INSTALL dir (where the
// portal runs from), NOT the active workspace and NOT ~/.harness. Rationale: same drive as the
// app (avoids C:\Users permission quirks), it's the natural "global home" since the portal boots
// here, and when _harness itself is the active workspace these files become directly viewable.
// gitignored (`global-knowledge/`) so personal memory is never committed/published.
// HARNESS_HOME (self-heal): the FIXED install root that holds DATA shared across every versioned
// release (global-knowledge, registry, …). Code runs from an immutable .releases/vN copy, but the
// data must NOT live inside a release dir (or it'd vanish on version switch). The launcher sets
// HARNESS_HOME explicitly when running a release; in dev it defaults to the root above portal/,
// so current behaviour is unchanged.
const HARNESS_HOME = process.env.HARNESS_HOME ? path.resolve(process.env.HARNESS_HOME) : path.resolve(__dirname, '..');
// Export the resolved home so EVERY spawned agent (which inherits process.env) can locate Hana's
// install dir via $HARNESS_HOME — no hardcoded path. Covers the case where we weren't launched by
// the supervisor (direct `node`), where this env var wouldn't otherwise be set.
process.env.HARNESS_HOME = HARNESS_HOME;
const GLOBAL_KNOWLEDGE_DIR = path.join(HARNESS_HOME, 'global-knowledge');
// Plugin tiers (SPEC-plugin-contract.md, TASK.md §P1) — same ship/global/project shape as
// loadCommands() above, one directory-per-plugin (holding plugin.json) instead of one-file-per-command.
const SHIP_PLUGINS_DIR = path.join(__dirname, 'plugins');
const GLOBAL_PLUGINS_DIR = path.join(GLOBAL_KNOWLEDGE_DIR, 'plugins');
const schedulerManager = new SchedulerManager(HARNESS_HOME);

// ── Shared venv python resolver (SPEC-meeting-transcriber §8) ───────────────
// All python spawns (stt.py / meeting_record.py / diarize.py) MUST use the harness venv's
// absolute interpreter — never a relative path, never `python` on PATH. The venv lives at
// HARNESS_HOME/.venv (the FIXED install root): Deploy only snapshots portal/+docgraph/, so the
// venv is never copied into the read-only .releases/ tree — code runs from a release but the
// interpreter stays in the dev tree. Override with $HARNESS_VENV if the venv ever moves.
const RENDER_SERVICE_DIR = path.join(__dirname, 'render-service');
function venvPython() {
  return process.env.HARNESS_VENV || path.join(HARNESS_HOME, '.venv', 'Scripts', 'python.exe');
}
// Standard env for every python spawn: PYTHONUTF8 so Windows console/file IO is utf-8 (cp950 would
// choke on 中文/®), and pass HF_TOKEN through (G2 diarize reads it from os.environ; never logged).
function venvSpawnEnv(extra) {
  return Object.assign({}, process.env, { PYTHONUTF8: '1' }, extra || {});
}

// ── Persistent STT worker (F4/F5 latency fix) ───────────────────────────────
// /api/stt & _sttFile used to spawn `stt.py` per request → Whisper model RELOADED every call
// (~several seconds; the in-process _MODEL_CACHE singleton only helps a long-lived process). Instead
// keep ONE warm `stt.py --serve` child: model loaded once, requests streamed as newline-delimited
// JSON over stdin/stdout. Lazily started, auto-restarts if it dies. Worker logs go to stderr only.
let _sttWorker = null;        // { child, buf, pending: Map<id,{resolve,reject}> }
let _sttReqId = 0;
function _sttWorkerStart() {
  const { spawn } = require('child_process');
  const child = spawn(venvPython(), [path.join(RENDER_SERVICE_DIR, 'stt.py'), '--serve', '--model', 'medium'],
    { env: venvSpawnEnv() });
  const w = { child, buf: '', pending: new Map() };
  child.stdout.on('data', (d) => {
    w.buf += d.toString();
    let i;
    while ((i = w.buf.indexOf('\n')) >= 0) {
      const line = w.buf.slice(0, i).trim();
      w.buf = w.buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch (e) { continue; }
      const p = w.pending.get(msg.id);
      if (p) { w.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg); }
    }
  });
  child.stderr.on('data', () => {});   // model-ready / log lines — keep OFF stdout, ignore here
  const die = (e) => {
    for (const p of w.pending.values()) p.reject(e || new Error('stt worker exited'));
    w.pending.clear();
    if (_sttWorker === w) _sttWorker = null;   // next sttTranscribe() respawns
  };
  child.on('exit', () => die(new Error('stt worker exited')));
  child.on('error', (e) => die(e));
  return w;
}
// Transcribe via the warm worker. { audio, lang, model, beamSize, prompt } → { text, language, ... }.
// `prompt` (AT1) is the audio topic's compiled initial_prompt; stt.py merges it with the Chinese
// punctuation prompt itself (see stt.py transcribe_file) — callers just pass it through or omit it.
function sttTranscribe({ audio, lang, model, beamSize, prompt }) {
  return new Promise((resolve, reject) => {
    if (!_sttWorker) _sttWorker = _sttWorkerStart();
    const w = _sttWorker;
    const id = ++_sttReqId;
    const to = setTimeout(() => { if (w.pending.has(id)) { w.pending.delete(id); reject(new Error('stt timeout')); } }, 120000);
    w.pending.set(id, {
      resolve: (v) => { clearTimeout(to); resolve(v); },
      reject: (e) => { clearTimeout(to); reject(e); },
    });
    const reqLine = JSON.stringify({ id, audio, lang: lang || 'auto', model: model || 'medium', beam_size: beamSize || 5, prompt: prompt || null });
    try { w.child.stdin.write(reqLine + '\n'); }
    catch (e) { w.pending.delete(id); clearTimeout(to); reject(e); }
  });
}

// Live meeting recorders (G1/G3): meetingId → { child, meetingDir, title }. Kept SEPARATE from the
// chat `jobs` Map on purpose — a meeting is a long-running python child, not a chat turn, and must
// not leak into listRunningJobs() (which gates deferred restarts) or abortJob(). Stop is graceful
// (write a STOP control file, §8), never taskkill — hard-kill would corrupt the wav tail + last chunk.
const meetingProcs = new Map();

// F6 loopback one-shot captures (separate from meetingProcs — no meeting object, no live transcript
// UI, just start→collect→stop→text). captureId → { child, captureDir, exited }.
const sttLoopbackCaptures = new Map();

// Telegram C&C bot — C1…C5
// Resolve how to launch the claude-code CLI, ONCE at startup (cached). Prefer a globally-installed
// `claude` binary — it skips npx's per-turn package-resolution tax, can't be silently re-downloaded
// mid-run, and lets YOU pin the version (matters for Fable 5, whose CLI support is version-gated).
// Falls back to `npx @anthropic-ai/claude-code` when no global install is present, so behaviour is
// unchanged on machines without it. A fresh `npm i -g @anthropic-ai/claude-code` is picked up on the
// next server restart (the probe runs once).
let _claudeLauncher = null;
function claudeLauncher() {
  if (_claudeLauncher) return _claudeLauncher;
  const { spawnSync } = require('child_process');
  const bin = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  try {
    const r = spawnSync(bin, ['--version'], { stdio: 'ignore', shell: true, timeout: 10000 });
    if (r.status === 0) {
      console.log(`\x1b[36m[Chat] 使用全域 claude-code CLI 真身：${bin}\x1b[0m`);
      _claudeLauncher = { cmd: bin, prefix: [], label: bin };
      return _claudeLauncher;
    }
  } catch (e) {}
  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  console.log('\x1b[33m[Chat] 找不到全域 claude → 退回 npx @anthropic-ai/claude-code\x1b[0m');
  _claudeLauncher = { cmd: npxCmd, prefix: ['@anthropic-ai/claude-code'], label: 'npx @anthropic-ai/claude-code' };
  return _claudeLauncher;
}

// chatFn: QA / read-only via claude-code --print (stdin prompt, avoids Windows length limits)
// taskFn: C4 mutating task — same spawn but targeted workspace via HARNESS_PROJECT_ROOT env
// listProjectsFn: C3 workspace picker from registry
function _tgSpawnClaude(prompt, workspaceRoot, timeoutMs) {
  return new Promise(function (resolve) {
    const { spawn } = require('child_process');
    const { cmd, prefix } = claudeLauncher();
    const env = Object.assign({}, process.env);
    if (workspaceRoot) env.HARNESS_PROJECT_ROOT = workspaceRoot;
    const child = spawn(cmd,
      [...prefix, '--print', '--dangerously-skip-permissions', '--model', 'sonnet'],
      { shell: true, stdio: ['pipe', 'pipe', 'pipe'], env, cwd: workspaceRoot || HARNESS_HOME }
    );
    let output = '';
    child.stdout.on('data', function (d) { output += d.toString(); });
    child.stderr.on('data', function (d) { output += d.toString(); });
    const killer = setTimeout(function () { try { child.kill(); } catch (e) {} }, timeoutMs || 120000);
    child.on('close', function () { clearTimeout(killer); resolve(output.trim() || '（無回應）'); });
    child.on('error', function (e) { clearTimeout(killer); resolve('⚠️ 回應失敗：' + e.message); });
    try { child.stdin.write(prompt); child.stdin.end(); } catch (e) {}
  });
}

// F5 helper: transcribe an audio file via the warm STT worker (server Whisper) → text.
// `prompt` (AT2-d) is the resolved audio topic for the chat's current workspace, if any.
function _sttFile(audioPath, lang, prompt) {
  return sttTranscribe({ audio: audioPath, lang: lang || 'zh', model: 'medium', beamSize: 1, prompt })
    .then((r) => (r && r.text) || '');
}
// F5 helper: text → edge-tts mp3 → ffmpeg ogg/opus (Telegram voice notes require OGG-Opus). Returns
// the ogg path (caller deletes it) or null on failure (best-effort: text reply still goes out).
function _ttsToOgg(text) {
  return new Promise((resolve) => {
    try {
      const { execFileSync } = require('child_process');
      const vc = loadVoiceConfig(HARNESS_HOME);   // { voice, rate } matching the browser config
      const base = path.join(os.tmpdir(), 'hana_tgv_' + Date.now() + '_' + Math.random().toString(36).slice(2));
      const txt = base + '.txt', mp3 = base + '.mp3', ogg = base + '.ogg';
      fs.writeFileSync(txt, text, 'utf8');   // -f reads from file → no shell escaping issues
      execFileSync(venvPython(), ['-m', 'edge_tts', '-f', txt, '-v', vc.voice, '--rate', vc.rate, '--write-media', mp3], { timeout: 60000, stdio: 'pipe' });
      execFileSync('ffmpeg', ['-y', '-i', mp3, '-c:a', 'libopus', '-b:a', '32k', ogg], { timeout: 60000, stdio: 'pipe' });
      try { fs.unlinkSync(txt); } catch (e) {}
      try { fs.unlinkSync(mp3); } catch (e) {}
      resolve(fs.existsSync(ogg) ? ogg : null);
    } catch (e) { console.error('[Telegram] tts->ogg error:', e.message); resolve(null); }
  });
}

const telegramBot = createTelegramBot(HARNESS_HOME, schedulerManager, {
  // C3: workspace list for /use picker
  listProjectsFn: function () {
    try { return loadRegistry().projects || []; } catch (e) { return []; }
  },

  // F5: inbound voice → text (server Whisper) and reply text → voice note (edge-tts → ogg/opus).
  // `prompt` (AT2-d): telegram.js resolves the chat's current workspace default audio topic and
  // passes the compiled prompt through here — this wrapper stays a thin forward, no lookup itself.
  sttFn: function (audioPath, lang, prompt) { return _sttFile(audioPath, lang, prompt); },
  ttsVoiceFn: function (text) { return _ttsToOgg(text); },
  voiceLang: 'zh',

  // C2 chat: QA / read-only responses
  chatFn: function (text, context, ctx) {
    const workspaceRoot = (ctx && ctx.root) || HARNESS_HOME;
    const knowledgeDir = path.join(workspaceRoot, '.harness', 'knowledge');
    const memoryBlock = injectMemoryBlock(knowledgeDir);
    const sysprompt = '你是 Hana，Harness 的 AI 助理，正透過 Telegram 指揮控制台與指揮官對話。' +
      '請直接、簡潔地回答。不要輸出程式碼或 HTML 到聊天中；需要時寫檔並回傳路徑。' +
      '你的任務看板在 .worktable/TASK.md 與 .worktable/DASHBOARD.md；要找「我們的任務 / A / B / C 系列」就讀那裡。注意「task」指 worktable 路線圖，不是排程清單。' +
      '「排程 / schedule」＝ Harness portal 排程器（絕對不是 CronList/CronCreate 工具，那是另一套、別用也別提）。排程資料在 ' + HARNESS_HOME + '/global-knowledge/schedules/schedules.json，用每筆的 workspace 欄位對應工作區——要查排程就讀這個檔（依目前脈絡工作區過濾）。要改某個排程的時間或停用，對它 PUT：curl -X PUT http://localhost:3400/api/schedules/<id> 送 JSON（改 trigger.atISO，或 enabled），server 會自動重算下次執行時間；新建用 POST、刪除用 DELETE。';
    const contextBlock = context && context.length
      ? '近期控制台紀錄：\n' +
        context.slice(-5).map(function (m) {
          return (m.role === 'user' ? '指揮官' : 'Hana') + '：' + (m.text || '').slice(0, 300);
        }).join('\n') + '\n\n'
      : '';
    const ctxBlock = ctx
      ? '目前脈絡工作區：' + ctx.label + '（' + ctx.root + '）\n\n'
      : '目前脈絡工作區：_harness（' + HARNESS_HOME + '）\n\n';
    // SN2-03: inject this workspace's unfinished sticky notes so "還有哪些待辦？" is answerable
    // straight from Telegram chat, without a separate /notes lookup.
    const notesBlock = injectNotesContext(workspaceRoot);
    const prompt = sysprompt + '\n\n' + memoryBlock + ctxBlock + contextBlock + notesBlock + '指揮官說：' + text;
    return _tgSpawnClaude(prompt, workspaceRoot, 120000);
  },

  // C4 task: mutating work — spawn targeted at the confirmed workspace
  taskFn: function (text, workspaceRoot) {
    const wsRoot = workspaceRoot || HARNESS_HOME;
    const knowledgeDir = path.join(wsRoot, '.harness', 'knowledge');
    const memoryBlock = injectMemoryBlock(knowledgeDir);
    const sysprompt = '你是 Hana，正在執行指揮官透過 Telegram 派發的任務。' +
      '工作區路徑：' + wsRoot + '。' +
      '你的任務看板在 .worktable/TASK.md 與 .worktable/DASHBOARD.md；要找「我們的任務 / A / B / C 系列」就讀那裡。注意「task」指 worktable 路線圖，不是排程清單。' +
      '「排程 / schedule」＝ Harness portal 排程器（不是 CronList/CronCreate 工具，別用那套）。排程資料在 ' + HARNESS_HOME + '/global-knowledge/schedules/schedules.json（用 workspace 欄位過濾本工作區）。要改排程時間或停用，對它 PUT：curl -X PUT http://localhost:3400/api/schedules/<id> 送 JSON（改 trigger.atISO 或 enabled），server 會自動重算下次執行；別碰 CronCreate/CronList。' +
      '請完整執行任務後，只回覆「結果摘要」與「產出檔路徑」（若有）。';
    const prompt = sysprompt + '\n\n' + memoryBlock + '任務：' + text;
    return _tgSpawnClaude(prompt, wsRoot, 3600000); // 60-min timeout per architecture note
  },

  // /meeting command: list and read meetings for a given workspace
  meetingsFn: function (workspaceRoot) {
    const meetingsDir = path.join(workspaceRoot || HARNESS_HOME, '.harness', 'runtime', 'meetings');
    const list = [];
    try {
      for (const id of fs.readdirSync(meetingsDir)) {
        try { list.push(JSON.parse(fs.readFileSync(path.join(meetingsDir, id, 'meta.json'), 'utf8'))); } catch (e) {}
      }
    } catch (e) {}
    list.sort(function (a, b) { return String(b.startedAt || '').localeCompare(String(a.startedAt || '')); });
    return list;
  },
  meetingDetailFn: function (workspaceRoot, meetingId) {
    const meetingDir = path.join(workspaceRoot || HARNESS_HOME, '.harness', 'runtime', 'meetings', meetingId);
    let meta = {}, transcript = '', summary = '';
    try { meta = JSON.parse(fs.readFileSync(path.join(meetingDir, 'meta.json'), 'utf8')); } catch (e) {}
    try { transcript = fs.readFileSync(path.join(meetingDir, 'transcript.labeled.txt'), 'utf8'); } catch (e) {}
    if (!transcript) { try { transcript = fs.readFileSync(path.join(meetingDir, 'transcript.txt'), 'utf8'); } catch (e) {} }
    try { summary = fs.readFileSync(path.join(meetingDir, 'summary.md'), 'utf8'); } catch (e) {}
    return { meta, transcript, summary };
  },
});

// Optional private plugins — any `render-service/*-plugin.js` is auto-loaded and may register
// extra HTTP routes and Telegram handlers through the generic extension points. The public
// edition simply ships no such file, so this loop registers nothing (feature absent, no error).
(function loadPlugins() {
  const dir = path.join(__dirname, 'render-service');
  let files = [];
  try { files = fs.readdirSync(dir).filter(function (f) { return /-plugin\.js$/.test(f); }); } catch (e) { return; }
  for (const f of files) {
    try {
      require('./render-service/' + f).register({
        server: { extraRoutes },
        bot: telegramBot,
        HARNESS_HOME,
        spawn: _tgSpawnClaude,
      });
      console.log('[plugin] loaded ' + f);
    } catch (e) {
      console.error('[plugin] load error (' + f + '):', e.message);
    }
  }
})();

// The self-heal release store (immutable .releases/vN + current/last-known-good pointers + the
// restart marker). Lives under the shared home, NOT the per-release code dir.
const RELEASES_DIR = path.join(HARNESS_HOME, '.releases');
function readReleaseVersion() {
  try { return (JSON.parse(fs.readFileSync(path.join(RELEASES_DIR, 'current.json'), 'utf8')).version) || null; }
  catch (e) { return null; }
}
// Re-point every harness-derived path when the active workspace changes (one place → no drift).
function recomputeHarnessPaths(root) {
  HARNESS_DIR = path.join(root, '.harness');
  CHAT_HISTORY_DIR = path.join(HARNESS_DIR, 'runtime', 'chat_history');
  KNOWLEDGE_DIR = path.join(HARNESS_DIR, 'knowledge');
  COMMANDS_DIR = path.join(HARNESS_DIR, 'commands');
}
// Make any workspace self-configuring: create the .harness scaffold and ensure that
// workspace's .gitignore keeps runtime/ out of git (knowledge/ + commands/ stay tracked).
function ensureHarnessScaffold(root) {
  try {
    for (const d of [path.join(root, '.harness', 'knowledge', 'skills'),
                     path.join(root, '.harness', 'commands'),
                     path.join(root, '.harness', 'runtime', 'chat_history')]) {
      fs.mkdirSync(d, { recursive: true });
    }
    const gi = path.join(root, '.gitignore');
    const txt = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    // Only append if the workspace has no .harness rule yet — don't fight an existing setup.
    if (!/^\s*\.harness/m.test(txt)) {
      fs.writeFileSync(gi, (txt && !txt.endsWith('\n') ? txt + '\n' : txt) + '.harness/runtime/\n', 'utf8');
    }
  } catch (e) { console.error('[Harness] ensureHarnessScaffold failed (continuing):', e.message); }
}
// Seed the GLOBAL knowledge home once: empty USER.md/AGENT.md + an editable copy of the
// shipped memory policy (so the user has a real file to tune). Runs at startup, idempotent.
function ensureGlobalScaffold() {
  try {
    fs.mkdirSync(path.join(GLOBAL_KNOWLEDGE_DIR, 'skills'), { recursive: true });
    const seeds = {
      'USER.md': '# 使用者 (USER)\n\n> 關於使用者本人、跨專案成立的長期偏好。由 /memory 維護。\n',
      'AGENT.md': '# 代理自我 (AGENT)\n\n> 這個 AI 的核心自我與自我認知，跨專案繼承。由 /memory 維護。\n'
    };
    for (const [f, seed] of Object.entries(seeds)) {
      const p = path.join(GLOBAL_KNOWLEDGE_DIR, f);
      if (!fs.existsSync(p)) fs.writeFileSync(p, seed, 'utf8');
    }
    const policyPath = path.join(GLOBAL_KNOWLEDGE_DIR, 'memory-policy.md');
    const shipped = path.join(__dirname, 'policy', 'memory-policy.md');
    if (!fs.existsSync(policyPath) && fs.existsSync(shipped)) fs.copyFileSync(shipped, policyPath);
  } catch (e) { console.error('[Harness] ensureGlobalScaffold failed (continuing):', e.message); }
}

// --- Slash-command registry ----------------------------------------------------------------
// Commands merge from TWO sources (workspace overrides global on name collision):
//   GLOBAL    portal/commands/*.md          ships with harness → in EVERY workspace (one copy)
//   WORKSPACE <ws>/.harness/commands/*.md    project-specific custom commands
// Frontmatter: { name, description, icon, type: builtin|prompt }. A `builtin` is handled by
// portal CODE (its body is just a nameplate for the menu); a `prompt` IS its body — a template
// the portal fills with {{args}} and sends to the current CLI. Either way ONE definition works
// across all CLIs, because the portal resolves it before anything reaches a model.
const GLOBAL_COMMANDS_DIR = path.join(__dirname, 'commands');
function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: m[2].trim() };
}
function loadCommands(commandsDir = COMMANDS_DIR) {
  const byName = new Map();
  // Three tiers, later wins on name collision: SHIP defaults < GLOBAL (user, inherited everywhere)
  // < PROJECT. The global tier (global-knowledge/commands) is the editable home for cross-project
  // skills like the "簡報通則" presentation rules.
  for (const tier of [
    { dir: GLOBAL_COMMANDS_DIR, source: 'ship' },                           // 出貨：portal/commands
    { dir: path.join(GLOBAL_KNOWLEDGE_DIR, 'commands'), source: 'global' },  // 全域：global-knowledge/commands
    { dir: commandsDir, source: 'project' },                                // 專案：<workspace>/.harness/commands
  ]) {
    const { dir, source } = tier;
    try {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.md')) continue;
        const parsed = parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!parsed || !parsed.meta.name) continue;
        byName.set(parsed.meta.name, {
          name: parsed.meta.name,
          description: parsed.meta.description || '',
          icon: parsed.meta.icon || 'terminal',
          type: parsed.meta.type || 'prompt',
          source,                                 // 出貨 / 全域 / 專案：此指令最終定義來自哪一層
          extends: parsed.meta.extends || null,   // a prompt skill can inherit another's body
          scope: parsed.meta.scope || null,       // `self` = only in the harness's OWN dev workspace
          body: parsed.body
        });
      }
    } catch (e) { console.error('[Commands] load failed for', dir, ':', e.message); }
  }
  // Gate `scope: self` skills (e.g. /self-heal) to the harness's OWN dev tree, so they can't be
  // triggered inside a user's project. Active workspace root = parent of <root>/.harness/commands.
  let wsRoot = null;
  try { wsRoot = path.resolve(commandsDir, '..', '..'); } catch (e) {}
  const isSelfWorkspace = wsRoot && HARNESS_HOME && wsRoot.toLowerCase() === HARNESS_HOME.toLowerCase();
  return [...byName.values()].filter(c => c.scope !== 'self' || isSelfWorkspace);
}
// Compact index of available commands/skills, injected into chat so the agent KNOWS what skills
// exist (e.g. recognises「簡報通則」by name) and can author/extend them. Full bodies on demand.
function commandsIndexForPrompt(commandsDir = COMMANDS_DIR) {
  try {
    const cmds = loadCommands(commandsDir);
    if (!cmds.length) return '';
    return '\n可用的指令／技能（使用者提到時你應知道它們存在；技能定義在 .harness/commands 或 global-knowledge/commands 下）：\n'
      + cmds.map(c => `- /${c.name}：${c.description}`).join('\n') + '\n';
  } catch (e) { return ''; }
}
// "/name rest..." → { name, rest }; otherwise null. Only fires when the message LEADS with a slash.
function detectCommand(text) {
  const m = (text || '').match(/^\/([a-zA-Z][\w-]*)\s*([\s\S]*)$/);
  return m ? { name: m[1], rest: m[2].trim() } : null;
}

// --- Long-term memory (Hermes-style: bounded files + add/replace/remove, two-tier) ----------
// The portal OWNS the write MECHANISM (so every model is consistent); the editable POLICY
// lives in policy/memory-policy.md (or a user override in GLOBAL_KNOWLEDGE_DIR). Four bounded
// files across two scopes:
//   USER  / AGENT   → GLOBAL  (~/.harness/knowledge) — inherited by every workspace
//   MEMORY/ PERSONA → PROJECT (<ws>/.harness/knowledge) — local, never leaks across projects
const MEMORY_SPECS = {
  USER:    { scope: 'global',  file: 'USER.md',    cap: 1500, desc: '使用者本人（全域、跨專案）' },
  AGENT:   { scope: 'global',  file: 'AGENT.md',   cap: 2500, desc: 'AI 核心自我（全域、跨專案）' },
  MEMORY:  { scope: 'project', file: 'MEMORY.md',  cap: 3000, desc: '本專案事實／教訓' },
  PERSONA: { scope: 'project', file: 'PERSONA.md', cap: 1500, desc: '本專案角色特化' }
};
// projDir overrides the PROJECT knowledge dir (global scope is always fixed). A background job
// passes its captured dir so a /memory that finishes after a workspace switch still writes to the
// right project. Defaults to the live KNOWLEDGE_DIR.
function memoryFilePath(name, projDir) {
  const spec = MEMORY_SPECS[name];
  if (!spec) return null;
  return path.join(spec.scope === 'global' ? GLOBAL_KNOWLEDGE_DIR : (projDir || KNOWLEDGE_DIR), spec.file);
}
function readMemoryFile(name, projDir) {
  const p = memoryFilePath(name, projDir);
  try { return p && fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; } catch (e) { return ''; }
}
function writeMemoryFileRaw(name, content, projDir) {
  const p = memoryFilePath(name, projDir);
  if (!p) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}
function loadMemoryPolicy() {
  for (const p of [path.join(GLOBAL_KNOWLEDGE_DIR, 'memory-policy.md'), path.join(__dirname, 'policy', 'memory-policy.md')]) {
    try { if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8'); } catch (e) {}
  }
  return '';
}
// Build the prompt that asks the current CLI to emit add/replace/remove ops (per the policy),
// grounded in THIS conversation + the CURRENT memory files (so it can supersede & stay bounded).
function buildMemoryUpdatePrompt(messages, guidance, projDir) {
  const convo = messages.slice(0, -1)
    .map(m => (m.role === 'user' ? 'User: ' : 'Assistant: ') + chatMsgText(m)).join('\n');
  let p = loadMemoryPolicy() + '\n\n=== 目前的記憶檔（含字數/上限）===\n';
  for (const name of Object.keys(MEMORY_SPECS)) {
    const spec = MEMORY_SPECS[name];
    const cur = readMemoryFile(name, projDir);
    p += `\n# ${name}（${spec.desc}，目前 ${cur.length}/${spec.cap} 字）\n${cur || '(空)'}\n`;
  }
  if (guidance) p += '\n=== 使用者本次的特別指示 ===\n' + guidance + '\n';
  p += '\n=== 這次對話 ===\n' + (convo || '(對話尚無內容)') + '\n=== 結束 ===\n\n請只輸出政策要求的 JSON（不要其他文字、不要 code fence）。';
  return p;
}
// Extract the ops JSON from a model reply that may be wrapped in prose / fences.
function parseMemoryOps(reply) {
  if (!reply) return null;
  const s = String(reply);
  
  // Try to find a JSON block by scanning backwards from the last '}'
  let j = s.lastIndexOf('}');
  while (j > 0) {
    let braceCount = 0;
    let i = j;
    while (i >= 0) {
      if (s[i] === '}') {
        braceCount++;
      } else if (s[i] === '{') {
        braceCount--;
        if (braceCount === 0) {
          const candidate = s.slice(i, j + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (parsed && (Array.isArray(parsed.ops) || typeof parsed.note === 'string')) {
              return parsed;
            }
          } catch (e) {
            // Not a valid JSON, or not the memory update schema. Keep searching backwards.
          }
        }
      }
      i--;
    }
    j = s.lastIndexOf('}', j - 1);
  }
  
  // Fallback to the original index-based JSON extraction
  const cleaned = s.replace(/```+\s*json/gi, '').replace(/```+/g, '');
  const first = cleaned.indexOf('{'), last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(cleaned.slice(first, last + 1)); } catch (e) {}
  }
  return null;
}
// Apply ops to the bounded files. Returns a human-readable summary of what changed.
function applyMemoryOps(parsed, projDir) {
  const summary = [];
  const ops = (parsed && Array.isArray(parsed.ops)) ? parsed.ops : [];
  for (const op of ops) {
    const name = String(op.file || '').toUpperCase();
    if (!MEMORY_SPECS[name]) continue;
    let content = readMemoryFile(name, projDir);
    if (op.action === 'add' && op.text) {
      const entry = String(op.text).trim().replace(/^[-*]\s*/, '');
      content = content.replace(/\s*$/, '') + '\n- ' + entry + '\n';
      summary.push(`${name}：＋ ${entry.slice(0, 40)}`);
    } else if (op.action === 'replace' && op.old) {
      if (content.includes(op.old)) { content = content.split(op.old).join(op.new || ''); summary.push(`${name}：改寫一條`); }
      else if (op.new) { content = content.replace(/\s*$/, '') + '\n- ' + String(op.new).trim() + '\n'; summary.push(`${name}：＋ ${String(op.new).slice(0, 40)}（原文未找到→改為新增）`); }
      else continue;
    } else if (op.action === 'remove' && op.old) {
      if (content.includes(op.old)) { content = content.split(op.old).join(''); summary.push(`${name}：刪除一條`); } else continue;
    } else continue;
    writeMemoryFileRaw(name, content, projDir);
    const cap = MEMORY_SPECS[name].cap;
    if (content.length > cap * 1.15) summary.push(`⚠️ ${name} 已超出上限（${content.length}/${cap}），下次更新時請壓縮`);
  }
  return summary;
}
// Frozen memory block injected into every chat prompt (Hermes-style). Only files with at least
// one real entry are included, so empty seed files don't bloat the prompt.
function injectMemoryBlock(projDir) {
  let block = '';
  for (const name of Object.keys(MEMORY_SPECS)) {
    const cur = readMemoryFile(name, projDir);
    if (!/^\s*-\s+\S/m.test(cur)) continue;
    // Strip the file header (#) and comment (>) lines — inject only the real entries.
    const body = cur.split(/\r?\n/).filter(l => { const t = l.trim(); return t && !t.startsWith('#') && !t.startsWith('>'); }).join('\n').trim();
    if (body) block += `\n【${name}】\n${body}\n`;
  }
  return block ? '\n=== 你的長期記憶（據此回答，勿逐字覆述）===' + block + '=== 記憶結束 ===\n' : '';
}

// --- Workspace registry (multi-project switching) ---
// Stores known project roots + the active one so the selection survives restarts. Lives in the
// harness install's global home (GLOBAL_KNOWLEDGE_DIR) — off C:\Users (avoids permission quirks),
// gitignored, and invisible in the knowledge menu (getFolderTree only lists *.md).
function getRegistryPath() {
  return path.join(GLOBAL_KNOWLEDGE_DIR, 'projects.json');
}
// Windows paths are case-insensitive and accept both separators, but path.resolve() preserves
// whatever case/separator the caller typed. Registry lookups must ignore both, or the SAME real
// directory typed two different ways (e.g. once via HARNESS_HOME with a lowercase drive letter,
// once pasted from Explorer with an uppercase one) gets registered as two separate entries — the
// frontend's active-workspace match then silently disagrees with which entry the list highlights.
function normalizeRoot(root) {
  return path.resolve(root || '').replace(/\//g, '\\').toLowerCase();
}
function loadRegistry() {
  try {
    const p = getRegistryPath();
    if (fs.existsSync(p)) {
      const reg = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (reg && Array.isArray(reg.projects)) return reg;
    }
  } catch (e) {}
  return { active: WORKSPACE_ROOT, projects: [{ name: path.basename(WORKSPACE_ROOT), root: WORKSPACE_ROOT }] };
}
function saveRegistry(reg) {
  try {
    const p = getRegistryPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(reg, null, 2), 'utf8');
  } catch (e) { console.error('[Harness] Failed to save registry:', e.message); }
}
function setActiveProject(root) {
  const resolved = path.resolve(root);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error('找不到目錄或不是資料夾: ' + resolved);
  }
  WORKSPACE_ROOT = resolved;
  WORKTABLE_DIR = path.join(resolved, '.worktable');
  recomputeHarnessPaths(resolved);
  ensureHarnessScaffold(resolved);
  ensureGlobalScaffold();
  const scaffold = ensureWorktable(resolved);
  const reg = loadRegistry();
  if (!reg.projects.some(p => normalizeRoot(p.root) === normalizeRoot(resolved))) {
    reg.projects.push({ name: path.basename(resolved), root: resolved });
  }
  reg.active = resolved;
  saveRegistry(reg);
  console.log('[Harness] Active workspace switched to: ' + resolved);
  return scaffold;
}
// On startup, the persisted registry.active wins over the env default (the env is only
// the first-run seed); falls back to the default if that dir no longer exists.
function initActiveProject() {
  const reg = loadRegistry();
  let chosen = WORKSPACE_ROOT;
  if (reg.active && fs.existsSync(reg.active)) chosen = path.resolve(reg.active);
  WORKSPACE_ROOT = chosen;
  WORKTABLE_DIR = path.join(chosen, '.worktable');
  recomputeHarnessPaths(chosen);
  ensureHarnessScaffold(chosen);
  ensureGlobalScaffold();
  ensureWorktable(chosen);
  if (!reg.projects.some(p => normalizeRoot(p.root) === normalizeRoot(chosen))) {
    reg.projects.push({ name: path.basename(chosen), root: chosen });
  }
  reg.active = chosen;
  saveRegistry(reg);
}

// --- Project manifest (configurable sidebar / tools / brand per workspace) ---
// Forced cores (chat, worktable) are always present. CodeGraph/DocGraph render only when
// their config block exists. A project without harness.json gets an auto-detected default.
// SPEC-workspace-settings.md §3 / SPEC-sidebar-worktable-card.md §6: `nav` is opt-out (a missing
// key means "shown") so every existing harness.json keeps behaving exactly as before this feature
// shipped. `dashboard`+`task` were merged into a single `worktable` key (C5) since the two buttons
// are now one card, not two independent menu rows.
const DEFAULT_NAV = {
  chat: true,
  worktable: true,
  scheduler: true,
  telegram: true,
  documents: true,
  meeting: true,
  notes: true,
  audioTopics: true,
  pm: true,
  whiteboard: true
};
function buildDefaultManifest(root) {
  const has = (d) => { try { return fs.existsSync(path.join(root, d)); } catch (e) { return false; } };
  const known = [
    { d: 'governance',  label: '法規與標準 (Governance)', icon: 'scale' },
    { d: 'legislation', label: '立法 (Legislation)',      icon: 'landmark' },
    { d: 'specs',       label: '規格 (Specs)',            icon: 'file-code' },
    { d: 'docs',        label: 'Docs',                     icon: 'book' },
    { d: 'adr',         label: 'ADR',                      icon: 'git-commit' }
  ];
  const sections = [];
  for (const k of known) if (has(k.d)) sections.push({ label: k.label, icon: k.icon, path: k.d, filter: '*.md' });
  const tools = {};
  if (has('.codegraph')) tools.codegraph = { label: 'CodeGraph 探索器', icon: 'network', scope: '' };
  if (has('.docgraph'))  tools.docgraph  = { label: 'DocGraph 知識圖譜', icon: 'git-fork', profile: 'hana' };
  return {
    name: path.basename(root),
    subtitle: 'Workspace',
    icon: 'folder-tree',
    avatar: 'portal/hana_face.png',
    nav: Object.assign({}, DEFAULT_NAV),
    worktable: { label: '工作台 (Worktable)', icon: 'layout-dashboard', path: '.worktable', progress: '.worktable/TASK.md' },
    chat: { label: 'AI 對話 (Chat)', icon: 'message-square' },
    sidebar: { sections },
    tools
  };
}
function getManifest(root) {
  const def = buildDefaultManifest(root);
  let m = null;
  try {
    const p = path.join(root, 'harness.json');
    if (fs.existsSync(p)) m = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { console.error('[Harness] harness.json parse error:', e.message); }
  if (!m) return def;
  return {
    name: m.name || def.name,
    subtitle: (m.subtitle !== undefined) ? m.subtitle : def.subtitle,
    icon: m.icon || def.icon,
    avatar: m.avatar || def.avatar,
    nav: Object.assign({}, DEFAULT_NAV, (m.nav && typeof m.nav === 'object') ? m.nav : {}),
    worktable: Object.assign({}, def.worktable, m.worktable || {}),
    chat: Object.assign({}, def.chat, m.chat || {}),
    sidebar: { sections: (m.sidebar && Array.isArray(m.sidebar.sections)) ? m.sidebar.sections : def.sidebar.sections },
    tools: (m.tools && typeof m.tools === 'object') ? m.tools : def.tools
  };
}
// --- Plugin loading (SPEC-plugin-contract.md, TASK.md §P) ---
// Trust model (D4/§5): trust:"code" plugins (they ship executable view/route files) only load for
// workspaces the registry marks trusted:true — PLUS the harness's own dev tree, which is always
// trusted (same "self" carve-out loadCommands() already uses for `scope: self` skills). trust:"prompt"
// plugins would need no gate at all, but P-phase only ships trust:"code" (P5's demo plugin), so every
// plugin discovered today is gated by this check.
function isWorkspaceTrusted(root) {
  try {
    const resolved = path.resolve(root);
    if (resolved.toLowerCase() === HARNESS_HOME.toLowerCase()) return true;
    const reg = loadRegistry();
    const entry = (reg.projects || []).find(p => path.resolve(p.root).toLowerCase() === resolved.toLowerCase());
    return !!(entry && entry.trusted === true);
  } catch (e) { return false; }
}
// Merged plugin list for a resolved workspace (wctx from resolveWorkspace()), annotated with
// `enabled`/`disabledReason` per the trust gate. Untrusted trust:"code" plugins are still RETURNED
// (so the sidebar can show them, disabled, with a reason — §6 "未信任者側欄顯示但停用並標示原因")
// rather than silently omitted.
function getPlugins(wctx) {
  const list = pluginLoader.loadPlugins({
    shipDir: SHIP_PLUGINS_DIR,
    globalDir: GLOBAL_PLUGINS_DIR,
    projectDir: path.join(wctx.harnessDir, 'plugins')
  });
  const trusted = isWorkspaceTrusted(wctx.root);
  return list.map(p => {
    const gated = p.trust === 'code' && !trusted;
    return Object.assign({}, p, {
      enabled: !gated,
      disabledReason: gated ? '未信任的工作區（trust:"code" 外掛需 registry 標記 trusted，或位於 Harness 自身開發樹）' : null
    });
  });
}
// P3 handler for /api/x/<name>/*. `require()`d fresh (cache-busted) every call, not cached across
// requests: plugin route files are meant to be editable during development (P5's demo plugin) and
// re-requiring a small module per request is cheap next to the CLI/process work the rest of the
// portal already does per request.
function requirePluginModuleFresh(absPath) {
  const resolved = require.resolve(absPath);
  delete require.cache[resolved];
  return require(resolved);
}
function handlePluginApiRoute(req, res, pathname, parsedUrl) {
  const name = pathname.split('/')[3]; // '', 'api', 'x', '<name>', ...
  const wctx = resolveWorkspace(req);
  const plugin = name && getPlugins(wctx).find(p => p.name === name);
  if (!plugin) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'unknown plugin: ' + name }));
  }
  if (!plugin.enabled) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: plugin.disabledReason || 'plugin not trusted' }));
  }
  if (!plugin.routes) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'plugin has no server routes' }));
  }
  const routesPath = path.resolve(plugin.dir, plugin.routes);
  if (!isPathSafe(routesPath, plugin.dir)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'plugin routes path escapes plugin dir' }));
  }
  let registerFn;
  try {
    const mod = requirePluginModuleFresh(routesPath);
    registerFn = typeof mod === 'function' ? mod : mod && mod.default;
    if (typeof registerFn !== 'function') throw new Error('routes module must export a register(api) function (module.exports = function(api){...})');
  } catch (e) {
    console.error('[plugins] failed to load routes for "' + name + '":', e.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'plugin route load failed: ' + e.message }));
  }
  const scoped = new ApiRouter();
  scoped.mount(name, registerFn, () => wctx);
  if (!scoped.dispatch(req, res, pathname, parsedUrl)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'no matching route in plugin "' + name + '"' }));
  }
}
function getDocgraphProfile(root = WORKSPACE_ROOT) {
  try {
    const name = ((getManifest(root).tools.docgraph) || {}).profile || 'hana';
    return require('../docgraph/profiles/' + name);
  } catch (e) { return docgraphProfile; }
}

// --- Worktable scaffolding ---
// Worktable is a forced core, so every workspace should have the standard structure.
// On activation we create .worktable + the essential files if they are missing (never
// overwriting existing ones). Wrapped in try/catch so a non-writable directory degrades
// gracefully instead of crashing the portal.
function dashboardTemplate(name) {
  const date = new Date().toISOString().slice(0, 10);
  return `# ${name} — Dashboard\n\n> 由 Harness 自動建立的工作台看板 (${date})。\n\n## 專案狀態\n\n- 建立日期：${date}\n- 狀態：🟢 Active\n\n## 進度摘要\n\n（在此記錄專案進度、里程碑與重點。）\n`;
}
function taskTemplate() {
  return `# Active TASK\n\n> 勾選的任務會反映在左上角的 Action 進度條。\n\n- [ ] 設定此工作區的第一個任務\n`;
}
function ensureWorktable(root) {
  const m = getManifest(root);
  const wtPath = (m.worktable && m.worktable.path) || '.worktable';
  const wtDir = path.join(root, wtPath);
  const created = [];
  try {
    if (!fs.existsSync(wtDir)) { fs.mkdirSync(wtDir, { recursive: true }); created.push(wtPath + '/'); }
    const files = [
      { name: 'DASHBOARD.md', content: dashboardTemplate(m.name || path.basename(root)) },
      { name: 'TASK.md', content: taskTemplate() }
    ];
    for (const f of files) {
      const fp = path.join(wtDir, f.name);
      if (!fs.existsSync(fp)) { fs.writeFileSync(fp, f.content, 'utf8'); created.push(wtPath + '/' + f.name); }
    }
    return { ok: true, created };
  } catch (e) {
    console.error('[Harness] Worktable scaffold failed:', e.message);
    return { ok: false, error: e.message, created };
  }
}

const anthropicTools = [
  {
    name: "list_specs",
    description: "Lists all available markdown specification and task files in the workspace (specs/, governance/, legislation/, .worktable/).",
    input_schema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "search_specs",
    description: "Scans all project specifications and task files for target keywords or text patterns, returning matching file paths and line snippets.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search term or keyword to scan for (e.g. \"Batch 07\", \"eval\", \"excel-service\")."
        }
      },
      required: ["query"]
    }
  },
  {
    name: "read_spec",
    description: "Reads and returns the complete text content of a specific specification or markdown file inside the workspace.",
    input_schema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "Relative path of the target file inside the workspace (e.g. \"specs/packages/layout/SPEC-LAYOUT.md\")."
        }
      },
      required: ["filePath"]
    }
  }
];

// REMOVED getClaudeToken() + callClaudeWithTools(): they read the SUBSCRIPTION OAuth accessToken out of
// ~/.claude/.credentials.json and called the API directly with it — the exact "extract the login token and
// use it in your own code" pattern Anthropic suspends accounts for. Both were dead code (never called).
// Hana talks to Claude ONLY through the official claude-code CLI (which manages its own auth) — the
// sanctioned path. Do NOT re-introduce OAuth-token extraction.

function httpsPost(urlStr, headers, payload) {
  return new Promise((resolve, reject) => {
    const parsedUrl = url.parse(urlStr);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.path,
      method: 'POST',
      headers: headers
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse response: ${data}`));
          }
        } else {
          reject(new Error(`API Error (Status ${res.statusCode}): ${data}`));
        }
      });
    });

    req.on('error', (e) => { reject(e); });
    req.write(JSON.stringify(payload));
    req.end();
  });
}

// callClaudeWithTools() removed — see the note where getClaudeToken() was (dead OAuth-token→API path).

function cleanAnsi(text) {
  if (typeof text !== 'string') return '';
  // 1. Strip OSC Operating System Command sequences (like window title setting: ESC ] 0 ; ... BEL/ESC)
  let clean = text.replace(/\u001b\].*?[\u0007\u001b]/g, '');
  // 2. Strip CSI Control Sequence Introducer sequences (standard colors, cursors, etc.)
  return clean.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

function cleanCliOutput(text) {
  if (typeof text !== 'string') return '';
  let clean = cleanAnsi(text);
  const lines = clean.split('\n');
  const filteredLines = lines.filter(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('Warning:')) return false;
    if (trimmed.startsWith('Ripgrep is not available')) return false;
    if (trimmed.startsWith('Attempt ')) return false;
    // agy status spinners (e.g. "(Waiting for background task to complete...)") are NOT the
    // answer — they show while agy works. If such a line is all we captured, dropping it makes
    // the reply correctly empty → the empty-handler returns a clear "retry" message instead of
    // showing the spinner text as if it were the answer.
    if (/^\(Waiting for .*\.\.\.\)$/.test(trimmed)) return false;
    return true;
  });
  return filteredLines.join('\n').trim();
}

// agy `--print` exits 0 and writes nothing to stdout/stderr even when the request fails.
// Parse its --log-file to recover a human-readable reason when the reply comes back empty.
// ── Resilient CLI (SPEC-resilient-cli) — Part A detection + Part B limit-aware state ──────────
// We CANNOT query remaining quota from any CLI; we only observe success / rate-limit at call time.
// So Part B reflects reality: per provider+model, remember the last outcome + (if limited) reset.
// Subscription quota is per ACCOUNT (machine-global), so this lives in the global home, not a ws.
const LIMIT_STATE_FILE = path.join(GLOBAL_KNOWLEDGE_DIR, 'cli-limit-state.json');
let limitState = {};   // `${provider}::${model}` -> { provider, model, status, lastUsedAt, resetAt, lastError, updatedAt }
function loadLimitState() { try { limitState = JSON.parse(fs.readFileSync(LIMIT_STATE_FILE, 'utf8')) || {}; } catch (e) { limitState = {}; } }
function saveLimitState() { try { fs.mkdirSync(path.dirname(LIMIT_STATE_FILE), { recursive: true }); fs.writeFileSync(LIMIT_STATE_FILE, JSON.stringify(limitState, null, 2)); } catch (e) {} }
function recordLimitOutcome(provider, model, outcome) {
  if (!provider || provider === 'memory') return;
  const key = `${provider}::${model || ''}`;
  const now = new Date().toISOString();
  const prev = limitState[key] || {};
  if (outcome.status === 'ok') {
    limitState[key] = { provider, model, status: 'ok', lastUsedAt: now, resetAt: null, lastError: null, updatedAt: now };
  } else { // limited
    limitState[key] = { provider, model, status: 'limited', lastUsedAt: prev.lastUsedAt || now, resetAt: outcome.resetAt || prev.resetAt || null, lastError: outcome.error || prev.lastError || null, updatedAt: now };
  }
  saveLimitState();
}

// "2h" / "1h30m" / "45m" / "90s" -> ms
function parseRelativeDuration(s) {
  let ms = 0; const re = /(\d+)\s*([hms])/gi; let m;
  while ((m = re.exec(s))) { const n = +m[1]; ms += m[2].toLowerCase() === 'h' ? n * 3600000 : m[2].toLowerCase() === 'm' ? n * 60000 : n * 1000; }
  return ms || null;
}
// Detect a rate-limit/quota-exhausted signal (+reset time) from a CLI's output (+ agy log). See SPEC B4.
function detectRateLimit(provider, output, logText) {
  const out = (output || '') + '\n' + (logText || '');
  // Parse a reset time. Handles absolute dates ("Jun 19th, 2026 10:01 PM"), and bare times like
  // Claude's "resets 2:30pm (Asia/Taipei)" → today (or tomorrow if already past) at that time.
  const absDate = (raw) => {
    let s = String(raw).replace(/\(.*?\)/g, '').replace(/(\d+)(st|nd|rd|th)/gi, '$1').trim();
    let d = new Date(s);
    if (isNaN(d.getTime())) {
      const tm = s.match(/^(\d{1,2}):(\d{2})\s*([ap]m)?/i);
      if (tm) {
        d = new Date(); let h = +tm[1];
        if (tm[3] && /pm/i.test(tm[3]) && h < 12) h += 12;
        if (tm[3] && /am/i.test(tm[3]) && h === 12) h = 0;
        d.setHours(h, +tm[2], 0, 0);
        if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
      }
    }
    return isNaN(d.getTime()) ? null : d.toISOString();
  };
  if (provider === 'codex') {
    if (/usage limit|hit your .{0,20}limit/i.test(out)) {
      const m = out.match(/try again at ([^.\n]+)/i);
      return { limited: true, resetAt: m ? absDate(m[1]) : null };
    }
  } else if (provider === 'gemini') {
    if (/RESOURCE_EXHAUSTED/.test(out)) {
      const m = out.match(/Resets in ([0-9hms]+)/i);
      const ms = m ? parseRelativeDuration(m[1]) : null;
      return { limited: true, resetAt: ms ? new Date(Date.now() + ms).toISOString() : null };
    }
  } else if (provider === 'claude') {
    // Claude Code's 5-hour cap says "session limit" (not "usage limit") and "resets <time>" (no "at").
    if (/usage limit|session limit|rate.?limit|too many requests|\b429\b|hit your .{0,20}limit/i.test(out)) {
      const m = out.match(/resets?(?:\s+at)?\s+([^.\n]+)/i) || out.match(/try again at ([^.\n]+)/i);
      return { limited: true, resetAt: m ? absDate(m[1]) : null };
    }
  } else if (provider === 'grok') {
    // No real rate-limit hit observed yet — best-effort generic patterns (same shape as claude/codex).
    if (/usage limit|rate.?limit|too many requests|\b429\b|quota exceeded/i.test(out)) {
      const m = out.match(/resets?(?:\s+at)?\s+([^.\n]+)/i) || out.match(/try again at ([^.\n]+)/i);
      return { limited: true, resetAt: m ? absDate(m[1]) : null };
    }
  }
  return { limited: false, resetAt: null };
}
// agy auth status from its log (Part A): "not logged into Antigravity" appears on EVERY startup
// before the keyring fallback succeeds, so only treat it as a real failure when NO success follows.
function agyAuthStatus(logText) {
  if (!logText) return 'unknown';
  if (/authenticated successfully|authenticated via keyring|effective:\s*keyring/i.test(logText)) return 'ok';
  if (/not logged into Antigravity|not authenticated/i.test(logText)) return 'auth_failed';
  return 'unknown';
}
function formatLimitMessage(provider, rl) {
  const name = provider === 'gemini' ? 'Antigravity (Gemini)' : provider === 'codex' ? 'Codex' : provider === 'grok' ? 'Grok' : 'Claude';
  let when = '';
  if (rl.resetAt) { try { when = `約 ${new Date(rl.resetAt).toLocaleString('zh-TW', { hour12: false })} 後重置。`; } catch (e) {} }
  return `⚠️ **${name} 配額已用盡（限流）**。${when} 請稍後再試，或先改用其他模型。`;
}

function extractAgyError(logFile) {
  let log = '';
  try {
    log = fs.readFileSync(logFile, 'utf8');
  } catch (e) {
    return null;
  }
  const lines = log.split('\n');

  const quotaLine = lines.find(l => l.includes('RESOURCE_EXHAUSTED'));
  if (quotaLine) {
    const reset = quotaLine.match(/Resets in ([0-9hms]+)/);
    return `⚠️ **Antigravity (Gemini) 配額已用盡** (RESOURCE_EXHAUSTED / 429)。`
      + (reset ? ` 約 ${reset[1]} 後重置。` : '')
      + ` 請稍後再試，或先改用 Claude 模型。`;
  }

  if (lines.some(l => l.includes('not logged into Antigravity') || l.includes('not authenticated'))) {
    return `⚠️ **尚未登入 Antigravity CLI**。請在終端機執行 \`agy\` 完成 Google 登入後再試。`;
  }

  const execErr = lines.filter(l => l.includes('agent executor error')).pop();
  if (execErr) {
    const msg = execErr.replace(/.*agent executor error:\s*/, '').slice(0, 300);
    return `⚠️ **Antigravity CLI 執行錯誤**：${msg}`;
  }

  return null;
}

function saveChatSession(sessionId, messages, trace, dir, filePath, origin, schedInfo, pending, scope) {
  // dir lets a background JOB save to ITS OWN workspace's history (captured at job start),
  // not the live (mutable) CHAT_HISTORY_DIR — so a job that finishes after the user switched
  // workspaces still writes to the right project.
  const targetDir = dir || CHAT_HISTORY_DIR;
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const sessionPath = path.join(targetDir, `chat_${sessionId}.json`);
  // Preserve a user-set custom title + the F2 filePath link across saves.
  let title, existingFilePath, existingOrigin, existingSchedule, existingMeetingId, existingPmIds;
  try {
    if (fs.existsSync(sessionPath)) {
      const ex = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      title = ex.title; existingFilePath = ex.filePath;
      existingOrigin = ex.origin; existingSchedule = ex.schedule;
      existingMeetingId = ex.meetingId; existingPmIds = ex.pmProjectIds;
    }
  } catch (e) {}
  // 對話脈絡（文件 / 會議 / 專案）：跟 filePath 一樣要跨存檔保留，因為歷史列表靠它判斷
  // 「這是不是從『AI 對話』直接開的對話」——有脈絡的一律不列出（見 getChatHistories）。
  const meetingId = (scope && scope.meetingId) || existingMeetingId || null;
  const pmProjectIds = (scope && scope.pmProjectIds) || existingPmIds || null;
  // H1: origin — explicit param > preserved from file > backward-compat inference from sessionId prefix.
  const effectiveOrigin = origin || existingOrigin || (sessionId.startsWith('sched_') ? 'schedule' : 'human');
  const data = {
    sessionId,
    title,
    origin: effectiveOrigin,
    // H1: schedule block present only for scheduled sessions; preserved across re-saves.
    ...(schedInfo ? { schedule: schedInfo } : (existingSchedule ? { schedule: existingSchedule } : {})),
    // F2: the file this conversation is about (relative-to-workspace path = the stable key).
    filePath: filePath || existingFilePath || null,
    ...(meetingId ? { meetingId } : {}),
    ...(pmProjectIds ? { pmProjectIds } : {}),
    updatedAt: new Date().toISOString(),
    messages,
    trace,
    // X1 (SPEC-chat-durability): unlike title/filePath/origin/schedule above, `pending` is NEVER
    // preserved from the existing file — it must be explicitly passed on every write. That's what
    // makes finalize's call (which omits it) clear it: JSON.stringify drops the `undefined` key.
    ...(pending ? { pending } : {}),
  };
  fs.writeFileSync(sessionPath, JSON.stringify(data, null, 2), 'utf8');
}

// X1-X3 (SPEC-chat-durability): write the CURRENT half-finished turn to disk — used before
// dispatching to a CLI (X1), on throttled mid-run checkpoints (X2), and by /api/chat/flush + the
// Deploy-time flush (X3). `ctx.pendingSince` is set once per job so every checkpoint of the same
// turn reports the same start time.
function saveChatPending(ctx, trace) {
  if (!ctx.pendingSince) ctx.pendingSince = new Date().toISOString();
  try {
    saveChatSession(ctx.activeSessionId, ctx.messages, trace || [], ctx.wctx && ctx.wctx.chatHistoryDir,
      ctx.filePath, ctx.origin, ctx.schedInfo,
      { since: ctx.pendingSince, model: ctx.modelArg, jobId: ctx.jobId },
      { meetingId: ctx.meetingId, pmProjectIds: ctx.pmProjectIds });
  } catch (e) { console.error('[Chat] pending save failed (continuing):', e.message); }
}

// X2: throttled (>=30s apart) checkpoint during a long-running CLI turn — called from each
// provider's stdout/onData handler with the accumulated partial output so far.
function checkpointChatSession(ctx, partialText, toolName) {
  const now = Date.now();
  if (ctx._lastCheckpointAt && now - ctx._lastCheckpointAt < 30000) return;
  ctx._lastCheckpointAt = now;
  const trace = [{ toolName, args: {}, resultPreview: cleanCliOutput(partialText || '').slice(0, 500) }];
  ctx._lastCheckpointTrace = trace;
  saveChatPending(ctx, trace);
}

// G10/W3: ensure runtime/meetings is a local git repo (audit trail, no remote, never push).
function ensureMeetingsGit(meetingsDir) {
  try {
    fs.mkdirSync(meetingsDir, { recursive: true });
    if (!fs.existsSync(path.join(meetingsDir, '.git'))) {
      const { spawnSync } = require('child_process');
      const gitEnv = Object.assign({}, process.env, {
        GIT_AUTHOR_NAME: 'Hana', GIT_AUTHOR_EMAIL: 'hana@harness',
        GIT_COMMITTER_NAME: 'Hana', GIT_COMMITTER_EMAIL: 'hana@harness',
      });
      spawnSync('git', ['init'], { cwd: meetingsDir, env: gitEnv });
      // Write .gitignore to exclude audio files (large, not useful in diff)
      fs.writeFileSync(path.join(meetingsDir, '.gitignore'), '*.wav\n*.opus\n*.mp3\nSTOP\n', 'utf8');
      spawnSync('git', ['add', '-A'], { cwd: meetingsDir, env: gitEnv });
      spawnSync('git', ['commit', '-m', 'init meetings audit repo'], { cwd: meetingsDir, env: gitEnv });
    }
  } catch (e) { console.warn('[Meeting] ensureMeetingsGit error:', e.message.slice(0, 200)); }
}

// G10/W3: auto-commit any write to the meetings audit repo.
// meetingsDir = <workspace>/.harness/runtime/meetings (the repo root)
// action      = e.g. 'started', 'stopped', 'diarized', 'summary edited', 'removed'
// actor       = 'Hana' or '老闆'
function meetingGitCommit(meetingsDir, meetingId, action, actor) {
  try {
    ensureMeetingsGit(meetingsDir);
    const { spawnSync } = require('child_process');
    const gitEnv = Object.assign({}, process.env, {
      GIT_AUTHOR_NAME: actor || 'Hana', GIT_AUTHOR_EMAIL: 'hana@harness',
      GIT_COMMITTER_NAME: actor || 'Hana', GIT_COMMITTER_EMAIL: 'hana@harness',
    });
    // timeout: a hung local git (e.g. a stale index.lock) must NOT freeze the event loop forever.
    traceSync('git add [' + meetingId + ']', () => spawnSync('git', ['add', '-A'], { cwd: meetingsDir, env: gitEnv, timeout: 20000 }));
    const msg = meetingId + ': ' + action + ' by ' + (actor || 'Hana');
    const r = traceSync('git commit [' + meetingId + ']', () => spawnSync('git', ['commit', '-m', msg], { cwd: meetingsDir, env: gitEnv, timeout: 20000 }));
    if (r.status !== 0) {
      const errStr = ((r.stderr || Buffer.from(''))).toString();
      if (!errStr.includes('nothing to commit') && !errStr.includes('nothing added to commit')) {
        console.warn('[Meeting] git commit warn:', errStr.slice(0, 300));
      }
    }
  } catch (e) { console.warn('[Meeting] meetingGitCommit failed:', e.message.slice(0, 200)); }
}

// ── MTG-SUM-01: shared primitive「跑 N 模型」(SPEC-meeting-summary §3 / SPEC-multi-model-panel) ──
// Run N models SEQUENTIALLY over ONE prompt and return N results. Serial (not concurrent) to avoid
// CLI auth contention (D4). Each model gets its own timeout; a failure/empty result is a forfeit
// (ok:false), NEVER retried. Consumed by multi-model meeting summary (Q) and (future) deep-think (§O).
//   opts = { prompt, models:['provider::model',...], perTimeoutMs, wsRoot }
//   → [{ model:'provider::model', ok, output, elapsedMs, error? }]
async function runModelsSequential({ prompt, models, perTimeoutMs, wsRoot } = {}) {
  const list = (Array.isArray(models) ? models : []).filter(Boolean);
  const timeoutMs = perTimeoutMs || 180000;
  const results = [];
  for (const modelKey of list) {
    const startedAt = Date.now();
    let ok = false, output = '', error = null;
    try {
      const { provider, modelArg } = parseChatModel(modelKey);
      output = await _spawnCliPrintOnce({ provider, modelArg, prompt, wsRoot, timeoutMs });
      const t = (output || '').trim();
      ok = !!(t && !t.startsWith('❌') && !t.startsWith('⚠️'));
    } catch (e) { error = e.message; ok = false; }
    const r = { model: modelKey, ok, output: output || '', elapsedMs: Date.now() - startedAt };
    if (error) r.error = error;
    results.push(r);
  }
  return results;
}

// One-shot, ctx-free CLI --print spawn for a single model. Reuses the same launchers/args as the
// chat engine (chatViaClaude/Codex/Gemini) but decoupled from the streaming `ctx` machinery.
// Resolves the (cleaned) reply text; rejects only on spawn error. Applies its own timeout.
function _spawnCliPrintOnce({ provider, modelArg, prompt, wsRoot, timeoutMs } = {}) {
  const { spawn } = require('child_process');
  const os = require('os');
  const cwd = wsRoot || HARNESS_HOME;
  const to = timeoutMs || 180000;
  return new Promise((resolve, reject) => {
    if (provider === 'claude') {
      const { cmd, prefix } = claudeLauncher();
      const env = Object.assign({}, process.env, { GEMINI_CLI_TRUST_WORKSPACE: 'true' });
      if (wsRoot) env.HARNESS_PROJECT_ROOT = wsRoot;
      const args = [...prefix, '--print', '--dangerously-skip-permissions', '--model', modelArg || 'sonnet'];
      const child = spawn(cmd, args, { cwd, shell: true, stdio: ['pipe', 'pipe', 'pipe'], env });
      let out = '', err = '', done = false;
      const killer = setTimeout(() => { if (!done) { try { child.kill('SIGINT'); } catch (e) {} } }, to);
      child.stdout.on('data', d => out += d.toString());
      child.stderr.on('data', d => err += d.toString());
      child.on('close', () => { if (done) return; done = true; clearTimeout(killer); resolve(cleanCliOutput(out || err)); });
      child.on('error', (e) => { if (done) return; done = true; clearTimeout(killer); reject(e); });
      try { child.stdin.write(prompt); child.stdin.end(); } catch (e) {}
      return;
    }
    if (provider === 'codex') {
      const model = modelArg || 'gpt-5.6-terra';
      const outFile = path.join(os.tmpdir(), `codex_sum_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`);
      const args = ['exec', '-m', model, '--dangerously-bypass-approvals-and-sandbox', '-c', 'model_reasoning_effort=low', '-c', 'mcp_servers={}', '--skip-git-repo-check', '--output-last-message', outFile, '-'];
      const child = spawn('codex', args, { cwd, shell: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
      let out = '', done = false;
      const killer = setTimeout(() => { if (!done) { try { child.kill('SIGINT'); } catch (e) {} } }, to);
      child.stdout.on('data', d => out += d.toString());
      child.on('close', () => {
        if (done) return; done = true; clearTimeout(killer);
        let reply = '';
        try { if (fs.existsSync(outFile)) reply = fs.readFileSync(outFile, 'utf8').trim(); } catch (e) {}
        try { fs.unlinkSync(outFile); } catch (e) {}
        if (!reply) reply = extractCodexReply(out) || cleanCliOutput(out);
        resolve(reply);
      });
      child.on('error', (e) => { if (done) return; done = true; clearTimeout(killer); try { fs.unlinkSync(outFile); } catch (_) {} reject(e); });
      try { child.stdin.write(prompt); child.stdin.end(); } catch (e) {}
      return;
    }
    if (provider === 'grok') {
      const home = process.env.USERPROFILE || path.join(process.env.HOMEDRIVE || 'C:', process.env.HOMEPATH || '');
      const grokPath = path.join(home, '.grok', 'bin', 'grok.exe');
      const model = modelArg || 'grok-4.5';
      let promptFile = null;
      const promptArgs = Buffer.byteLength(prompt, 'utf8') > 6000
        ? (promptFile = path.join(os.tmpdir(), `grok_sumprompt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`),
           fs.writeFileSync(promptFile, prompt, 'utf8'),
           ['--prompt-file', promptFile])
        : ['-p', prompt];
      const args = ['--model', model, '--output-format', 'plain', ...promptArgs];
      const child = spawn(grokPath, args, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
      let out = '', done = false;
      const cleanup = () => { if (promptFile) { try { fs.unlinkSync(promptFile); } catch (e) {} } };
      const killer = setTimeout(() => { if (!done) { try { child.kill('SIGINT'); } catch (e) {} } }, to);
      child.stdout.on('data', d => out += d.toString());
      child.on('close', () => { if (done) return; done = true; clearTimeout(killer); cleanup(); resolve(cleanCliOutput(out)); });
      child.on('error', (e) => { if (done) return; done = true; clearTimeout(killer); cleanup(); reject(e); });
      return;
    }
    if (provider === 'gemini') {
      const pty = require('node-pty');
      const home = process.env.USERPROFILE || path.join(process.env.HOMEDRIVE || 'C:', process.env.HOMEPATH || '');
      const agyPath = path.join(home, 'AppData', 'Local', 'agy', 'bin', 'agy.exe');
      const agyModelLabel = modelArg || 'gemini-3.5-flash';
      const geminiEffort = resolveGeminiEffort(agyModelLabel, null);
      const agyLogFile = path.join(os.tmpdir(), `agy_sum_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.log`);
      let agyPrompt = prompt, agyPromptFile = null;
      if (Buffer.byteLength(prompt, 'utf8') > 6000) {   // Windows argv cap — spill big prompts to a file
        try {
          agyPromptFile = path.join(os.tmpdir(), `agy_sumprompt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`);
          fs.writeFileSync(agyPromptFile, prompt, 'utf8');
          agyPrompt = `請讀取檔案 ${agyPromptFile}（UTF-8 純文字），它是你這次要執行的完整指示。讀完後嚴格依照其中要求作答，不要複述指示本身。`;
        } catch (e) { agyPrompt = prompt; agyPromptFile = null; }
      }
      const args = ['--dangerously-skip-permissions', '--model', agyModelLabel, ...(geminiEffort ? ['--effort', geminiEffort] : []), '--print-timeout', '60m', '--log-file', agyLogFile, '--print', agyPrompt];
      const cleanup = () => { try { fs.unlinkSync(agyLogFile); } catch (_) {} if (agyPromptFile) { try { fs.unlinkSync(agyPromptFile); } catch (_) {} } };
      let p;
      try { p = pty.spawn(agyPath, args, { name: 'xterm-256color', cols: 200, rows: 50, cwd, env: Object.assign({}, process.env, { GEMINI_CLI_TRUST_WORKSPACE: 'true', TERM: 'xterm-256color' }) }); }
      catch (e) { cleanup(); return reject(e); }
      let out = '', done = false;
      const killer = setTimeout(() => { if (done) return; done = true; try { p.kill(); } catch (e) {} cleanup(); resolve(cleanCliOutput(out)); }, to);
      p.onData(d => { out += d; });
      p.onExit(() => { if (done) return; done = true; clearTimeout(killer); cleanup(); const reply = cleanCliOutput(out); const parts = splitGeminiReply(reply); resolve((parts && parts.answer) || reply); });
      p.on('error', (e) => { if (done) return; done = true; clearTimeout(killer); cleanup(); reject(e); });
      return;
    }
    reject(new Error('unknown provider: ' + provider));
  });
}

const DEFAULT_MEETING_MODEL = 'claude::sonnet';
const MEETING_SUMMARY_TIMEOUT_MS = 180000;
const _meetingSummarizeInFlight = new Set();   // MTG-SUM-04: de-dup lazy + manual runs per meeting

// MCR1 (SPEC-meeting-correction §4): 校正分段常數 — 長會議必須分段餵，避免單次 prompt 過長。
const MEETING_CORRECT_CHUNK_LINES = 120;
const MEETING_CORRECT_CHUNK_CHARS = 4000;
const MEETING_CORRECT_OVERLAP_LINES = 5;
const _meetingCorrectInFlight = new Set();   // MTG-COR-02: de-dup concurrent correct runs per meeting

// P3 (§5.5.3): normalize a `parts` selection — {summary,keypoints,actions}, default all true.
function _normalizeMeetingParts(parts) {
  const p = parts || {};
  return { summary: p.summary !== false, keypoints: p.keypoints !== false, actions: p.actions !== false };
}

// P3: prompt is built dynamically from `parts` — 方案 A′ (MSUM-D1) asks the model for only the
// checked sections in ONE call. `existingSummaryMd` (when summary isn't requested this run but a
// prior version exists) is fed back as context so regenerated keypoints/actions stay consistent.
function _meetingSummaryPrompt(title, transcript, parts, existingSummaryMd) {
  parts = _normalizeMeetingParts(parts);
  const sections = [];
  if (parts.summary) sections.push('## SUMMARY\n（Markdown，整體概述敘事，總長不超過 300 字）');
  if (parts.keypoints) sections.push('## KEYPOINTS\n（Markdown 條列會議重點與決議，總長不超過 400 字）');
  if (parts.actions) sections.push(
    '## ACTIONS_JSON\n（純 JSON 陣列，每筆格式 {"id":"1","item":"...","owner":"","due":"","done":false,"source":"extracted"}，'
    + '若能從逐字稿找到 owner/due 就填，找不到留空字串。輸出必須是合法 JSON 陣列，不要加 markdown code block。）'
  );
  let p = '以下是一場會議的逐字稿，請用繁體中文輸出下列部分，嚴格遵守格式：\n\n' + sections.join('\n\n') + '\n\n會議標題：' + title + '\n';
  if (existingSummaryMd && existingSummaryMd.trim()) {
    p += '\n（此模型已有的整體摘要，僅供你保持語氣與內容一致，不必重複輸出）：\n' + existingSummaryMd.trim() + '\n';
  }
  p += '\n逐字稿：\n' + String(transcript).slice(0, 14000);
  return p;
}

// 彙整 prompt (D2/MSUM-D3): a lead model reads all N versions' 摘要+重點 → one consolidated best
// pair (actions merge separately via _mergeMeetingActions — no ACTIONS_JSON asked here).
function _meetingMergePrompt(title, okParsed) {
  let p = '以下是多個 AI 模型針對同一場會議各自整理的內容（分「整體摘要」與「會議重點」兩部分）。'
    + '請你作為主編，參考各版之長、補齊彼此的漏項，分別產出一份「最完整、最有條理」的最佳版本。'
    + '嚴格只輸出以下格式（不要評論各版差異）：\n\n'
    + '## SUMMARY\n（Markdown，整體概述敘事，總長不超過 300 字）\n\n'
    + '## KEYPOINTS\n（Markdown 條列，會議重點與決議，總長不超過 400 字）\n\n'
    + '會議標題：' + title + '\n\n';
  okParsed.forEach((v, i) => {
    p += '── 版本 ' + (i + 1) + '（模型：' + v.model + '）──\n摘要：\n' + (v.summaryMd || '（無）')
      + '\n重點：\n' + (v.keypointsMd || '（無）') + '\n\n';
  });
  return p;
}

// P3: parses up to three sections. `parts` (the request that produced rawOutput) is only used for
// the unstructured-fallback case (no headers found at all) to decide which single field to fill.
function _parseMeetingSummaryOutput(rawOutput, parts) {
  parts = _normalizeMeetingParts(parts);
  const sumMatch = rawOutput.match(/##\s*SUMMARY\s*\n([\s\S]*?)(?=##\s*KEYPOINTS\b|##\s*ACTIONS_JSON\b|$)/i);
  const kpMatch = rawOutput.match(/##\s*KEYPOINTS\s*\n([\s\S]*?)(?=##\s*ACTIONS_JSON\b|$)/i);
  const actMatch = rawOutput.match(/##\s*ACTIONS_JSON\s*\n([\s\S]*?)$/i);
  let summaryMd = sumMatch ? sumMatch[1].trim() : '';
  let keypointsMd = kpMatch ? kpMatch[1].trim() : '';
  let actions = [];
  if (actMatch) {
    try { actions = JSON.parse(actMatch[1].trim()); } catch (e) {
      const m = (actMatch[1] || '').match(/\[[\s\S]*\]/);
      if (m) { try { actions = JSON.parse(m[0]); } catch (_) {} }
    }
  }
  if (!Array.isArray(actions)) actions = [];
  if (!sumMatch && !kpMatch && !actMatch) {   // unstructured fallback: whole output → the requested part
    const fallback = rawOutput.trim() || '（產生失敗）';
    if (parts.summary) summaryMd = fallback;
    else if (parts.keypoints) keypointsMd = fallback;
  }
  return { summaryMd, keypointsMd, actions };
}

// P3 §5.5.5 相容: pre-P3 summary.md embeds 【重點】(and 【決議】) inline — pull that out as the
// keypoints fallback for meetings that never got a keypoints.md written.
function _extractLegacyKeypoints(summaryMd) {
  const s = String(summaryMd || '');
  const kp = s.match(/【重點】([\s\S]*?)(?=【決議】|【待辦】|$)/);
  const de = s.match(/【決議】([\s\S]*?)(?=【待辦】|$)/);
  let out = '';
  if (kp) out += kp[1].trim();
  if (de) out += (out ? '\n\n' : '') + '【決議】\n' + de[1].trim();
  return out.trim() || null;
}

// modelKey 'claude::opus' → filename-safe fragment 'claude.opus' (Windows disallows ':').
function modelFileKey(modelKey) {
  return String(modelKey).replace(/::/g, '.').replace(/[^\w.\-]+/g, '_');
}

// MTG-EXP-01: 'claude::sonnet' → 'Claude sonnet' — server-side mirror of index.html's
// mtgModelBrand() so §3's "模型品牌 · 產生時間" section headers stay consistent with the UI.
function _mtgModelBrandLabel(modelKey) {
  if (!modelKey) return '模型';
  const parts = String(modelKey).split('::');
  const prov = ({ claude: 'Claude', gemini: 'Gemini', codex: 'Codex', grok: 'Grok' })[parts[0]] || parts[0];
  return parts[1] ? prov + ' ' + parts[1] : prov;
}

function _mtgDurationLabel(meta) {
  if (!meta || !meta.startedAt || !meta.finishedAt) return '';
  const start = new Date(meta.startedAt), end = new Date(meta.finishedAt);
  if (isNaN(start) || isNaN(end)) return '';
  const mins = Math.round((end - start) / 60000);
  if (mins <= 0) return '';
  return mins >= 60 ? `${Math.floor(mins / 60)} 小時 ${mins % 60} 分` : `${mins} 分鐘`;
}

function _mtgSpeakersLabel(meta) {
  const sp = meta && meta.speakers;
  if (!sp) return '（未標記）';
  if (Array.isArray(sp)) return sp.join('、') || '（未標記）';
  return String(sp).trim() || '（未標記）';
}

// GFM table for the 待辦 section (§3.4).
function _mtgActionsToMdTable(actions) {
  const arr = Array.isArray(actions) ? actions : [];
  if (!arr.length) return '（無待辦事項）';
  let md = '| 項目 | 負責人 | 期限 | 狀態 |\n|---|---|---|---|\n';
  for (const a of arr) {
    const esc = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    md += `| ${esc(a.item)} | ${esc(a.owner)} | ${esc(a.due)} | ${a.done ? '✅ 已完成' : '⬜ 待辦'} |\n`;
  }
  return md;
}

// selection ('final' | modelKey | 'all') → 檔名版本標籤（MEX-D3）。
function _mtgVersionLabel(selection) {
  if (selection === 'final' || selection === 'all') return selection;
  return modelFileKey(selection);
}

function _mtgExportFilename(title, selection, ext) {
  const verLabel = _mtgVersionLabel(selection);
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const safeTitle = String(title || 'meeting').replace(/[\\/:*?"<>|]/g, '_').trim() || 'meeting';
  return `${safeTitle}_${verLabel}_${dateStr}.${ext}`;
}

// MTG-EXP-01 (SPEC-meeting-export.md §3): assemble ONE markdown doc = 標題頁 + 摘要 + 會議重點
// (+ 待辦選配 + 逐字稿選配), shared by both the docx and pdf export paths so the two engines never
// drift apart. Read-only: only ever fs.readFileSync's the meeting dir, never writes.
//   selection: 'final' → summary.md/keypoints.md/actions.json (收尾版)
//              '<modelKey>' → summary.<fileKey>.md 等（某模型版）
//              'all' → meta.summary.versions[] 逐版拼節，每節含三分項（§Q P3 P3 未落地 → 回退【重點】段）
function assembleMeetingMarkdown(meetingDir, meta, opts) {
  opts = opts || {};
  const selection = opts.selection || 'final';
  const include = opts.include || {};
  const includeActions = include.actions !== false;
  const includeTranscript = !!include.transcript;
  const title = (meta && meta.title) || path.basename(meetingDir);

  let md = `# ${title}\n\n`;
  md += `**日期**：${meta && meta.startedAt ? new Date(meta.startedAt).toLocaleString('zh-TW') : '（未知）'}`;
  const dur = _mtgDurationLabel(meta);
  if (dur) md += `　**時長**：${dur}`;
  md += `\n\n**與會者**：${_mtgSpeakersLabel(meta)}\n\n---\n\n`;

  function readPart(fileKey) {
    const sumFile = fileKey === 'final' ? 'summary.md' : `summary.${fileKey}.md`;
    const kpFile = fileKey === 'final' ? 'keypoints.md' : `keypoints.${fileKey}.md`;
    const actFile = fileKey === 'final' ? 'actions.json' : `actions.${fileKey}.json`;
    let summaryMd = ''; try { summaryMd = fs.readFileSync(path.join(meetingDir, sumFile), 'utf8'); } catch (e) {}
    let keypointsMd = ''; try { keypointsMd = fs.readFileSync(path.join(meetingDir, kpFile), 'utf8'); } catch (e) {}
    // §5.5.5 相容: P3 未落地／pre-P3 會議沒有 keypoints.* → 回退 summary.md 內【重點】段。
    if (!keypointsMd.trim() && summaryMd) keypointsMd = _extractLegacyKeypoints(summaryMd) || '';
    let actions = []; try { actions = JSON.parse(fs.readFileSync(path.join(meetingDir, actFile), 'utf8')); } catch (e) {}
    return { summaryMd: summaryMd.trim() || '（無摘要）', keypointsMd: keypointsMd.trim() || '（無）', actions };
  }

  function partsBlock(headingLevel, parts) {
    const h = '#'.repeat(headingLevel);
    let s = `${h} 摘要\n\n${parts.summaryMd}\n\n${h} 會議重點\n\n${parts.keypointsMd}\n\n`;
    if (includeActions) s += `${h} 待辦\n\n${_mtgActionsToMdTable(parts.actions)}\n\n`;
    return s;
  }

  if (selection === 'all') {
    const versions = (meta && meta.summary && Array.isArray(meta.summary.versions)) ? meta.summary.versions : [];
    const okVersions = versions.filter(v => v.ok);
    if (!okVersions.length) {
      md += partsBlock(2, readPart('final'));
    } else {
      for (const v of okVersions) {
        const time = v.generatedAt ? new Date(v.generatedAt).toLocaleString('zh-TW') : '';
        md += `## ${_mtgModelBrandLabel(v.model)}${time ? ' · ' + time : ''}\n\n`;
        md += partsBlock(3, readPart(modelFileKey(v.model)));
      }
    }
  } else if (selection === 'final') {
    md += partsBlock(2, readPart('final'));
  } else {
    md += partsBlock(2, readPart(modelFileKey(selection)));
  }

  if (includeTranscript) {
    let transcript = ''; try { transcript = fs.readFileSync(path.join(meetingDir, 'transcript.labeled.txt'), 'utf8'); } catch (e) {}
    if (!transcript.trim()) { try { transcript = fs.readFileSync(path.join(meetingDir, 'transcript.txt'), 'utf8'); } catch (e) {} }
    md += `## 逐字稿\n\n\`\`\`\n${transcript.trim() || '（無逐字稿）'}\n\`\`\`\n\n`;
  }

  return md;
}

// MTG-SUM-03: 彙整模式 actions = N 版待辦的聯集去重（最完整、漏項最少）。Dedupe by normalized item text.
function _mergeMeetingActions(actionLists) {
  const seen = new Map();
  for (const list of (Array.isArray(actionLists) ? actionLists : [])) {
    for (const a of (Array.isArray(list) ? list : [])) {
      const item = ((a && a.item) || '').trim();
      if (!item) continue;
      const key = item.toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(key)) {
        const ex = seen.get(key);                       // fill blanks from a later version
        if (!ex.owner && a.owner) ex.owner = a.owner;
        if (!ex.due && a.due) ex.due = a.due;
        continue;
      }
      seen.set(key, { id: '', item, owner: a.owner || '', due: a.due || '', done: !!a.done, source: a.source || 'extracted' });
    }
  }
  return Array.from(seen.values()).map((a, i) => ({ ...a, id: String(i + 1) }));
}

function _writeMeetingSummaryMeta(meetingDir, summaryMeta) {
  try {
    const metaPath = path.join(meetingDir, 'meta.json');
    let m = {};
    try { m = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) {}
    m.summarizedAt = summaryMeta.summarizedAt;   // keep legacy top-level field for back-compat
    m.summary = summaryMeta;                       // MTG-SUM-03 provenance block
    fs.writeFileSync(metaPath, JSON.stringify(m, null, 2), 'utf8');
  } catch (e) {}
}

// Collect per-model version content for the UI (prefers meta.summary.versions; falls back to scan).
// P3: also reads each model's keypoints.<key>.md + actions.<key>.json so the versions panel can show
// all three parts, and carries the `parts` flags (which of the three currently exist on disk).
function _readMeetingVersions(meetingDir, meta) {
  const out = [];
  const metaVers = meta && meta.summary && Array.isArray(meta.summary.versions) ? meta.summary.versions : null;
  if (metaVers) {
    for (const v of metaVers) {
      const fileKey = modelFileKey(v.model);
      if (!v.ok) { out.push({ model: v.model, generatedAt: v.generatedAt, ok: false, error: v.error || null, parts: v.parts || null }); continue; }
      let content = ''; try { content = fs.readFileSync(path.join(meetingDir, v.file), 'utf8'); } catch (e) {}
      let keypoints = ''; try { keypoints = fs.readFileSync(path.join(meetingDir, 'keypoints.' + fileKey + '.md'), 'utf8'); } catch (e) {}
      let actions = null; try { actions = JSON.parse(fs.readFileSync(path.join(meetingDir, 'actions.' + fileKey + '.json'), 'utf8')); } catch (e) {}
      out.push({ model: v.model, generatedAt: v.generatedAt, ok: true, content, keypoints, actions, elapsedMs: v.elapsedMs, parts: v.parts || null });
    }
    return out;
  }
  try {   // legacy fallback: scan summary.<key>.md (excludes summary.md itself)
    for (const f of fs.readdirSync(meetingDir)) {
      const m = f.match(/^summary\.(.+)\.md$/);
      if (m) {
        let content = ''; try { content = fs.readFileSync(path.join(meetingDir, f), 'utf8'); } catch (e) {}
        out.push({ model: m[1], generatedAt: null, ok: true, content });
      }
    }
  } catch (e) {}
  return out;
}

// MTG-COR-01 (SPEC-meeting-correction §4): 依行為單位切段，每段 ≤MEETING_CORRECT_CHUNK_LINES 行
// 且 ≤MEETING_CORRECT_CHUNK_CHARS 字；每段附前一段末尾 MEETING_CORRECT_OVERLAP_LINES 行當前後文
// （僅供模型理解語境，不併入輸出、不重複校正），避免長會議跨段語意斷裂。
function _chunkMeetingTranscriptLines(lines) {
  const chunks = [];
  let i = 0;
  while (i < lines.length) {
    let end = i, chars = 0;
    while (end < lines.length && (end - i) < MEETING_CORRECT_CHUNK_LINES && chars < MEETING_CORRECT_CHUNK_CHARS) {
      chars += (lines[end] || '').length;
      end++;
    }
    if (end === i) end = i + 1;   // safety: a single line longer than the char cap still advances
    const overlapStart = Math.max(0, i - MEETING_CORRECT_OVERLAP_LINES);
    chunks.push({ start: i, end, overlapLines: lines.slice(overlapStart, i) });
    i = end;
  }
  return chunks;
}

// MTG-COR-01: prompt only asks for 辨識錯字修正 — no rewrite/summarize/reorder/add/remove, keeps
// [HH:MM:SS] + 語者標籤 line-for-line so the model output can be reconciled against the input 1:1.
function _meetingCorrectionPrompt(meta, contextLines, targetLines) {
  const title = (meta && meta.title) || '（未命名會議）';
  const tags = (meta && Array.isArray(meta.tags) && meta.tags.length) ? meta.tags.join('、') : '（無）';
  const speakers = _mtgSpeakersLabel(meta);
  const contextBlock = contextLines.length ? contextLines.join('\n') : '（無，本段為逐字稿開頭）';
  const targetBlock = targetLines.join('\n');
  return `你是會議逐字稿校正助手。以下逐字稿由語音辨識直接產生，可能有同音字、近音字、專有名詞、數字或標點斷句錯誤。

會議主題：${title}
標籤：${tags}
與會者（專有名詞校正線索）：${speakers}

【只做以下事，其餘一律不要動】
- 只修正明顯的語音辨識錯字（同音字／近音字／專有名詞誤植／數字誤植／標點斷句錯誤）。
- 絕對不要改寫語意、不要摘要、不要重新排序、不要增刪句子或詞語。
- 每一行都要保留原本的 [HH:MM:SS] 時間戳與語者標籤，逐行對應輸出，輸出行數必須與輸入完全一致，不可合併或拆分任何一行。
- 中文一律使用台灣繁體用語。

【前後文參考（上一段末尾，僅供理解語境，不要輸出、也不要校正它】
${contextBlock}

【請逐行校正以下這段，輸出行數需與輸入相同】
${targetBlock}

請只輸出校正後的逐字稿內容（每行一句、含原始時間戳與語者標籤），不要輸出任何說明文字、不要加註解、不要加前後綴。`;
}

// MTG-COR-01「某行漏掉/行數對不上以原行補回」: 行數不符 → 整段回退原文（防當機精神：寧可少改不掉
// 行）；行數相符但某行的 [HH:MM:SS] 前綴跑掉（模型可能誤刪/誤改時間戳）→ 只該行回退原文，其餘照收。
const MEETING_CORRECT_TS_RE = /^\[\d{1,2}:\d{2}:\d{2}\]/;
function _reconcileCorrectedChunk(originalLines, correctedText) {
  let correctedLines = String(correctedText || '').split(/\r?\n/);
  while (correctedLines.length && correctedLines[correctedLines.length - 1].trim() === '') correctedLines.pop();
  if (correctedLines.length !== originalLines.length) {
    return { lines: originalLines.slice(), fellBack: true, reason: `行數不符（原 ${originalLines.length} 行，校正後 ${correctedLines.length} 行）` };
  }
  let mismatchCount = 0;
  const outLines = originalLines.map((orig, idx) => {
    const cor = correctedLines[idx];
    const origTs = (orig.match(MEETING_CORRECT_TS_RE) || [])[0];
    const corTs = (cor.match(MEETING_CORRECT_TS_RE) || [])[0];
    if (origTs && corTs !== origTs) { mismatchCount++; return orig; }
    return cor;
  });
  return { lines: outLines, fellBack: false, mismatchCount };
}

function _writeMeetingCorrectionMeta(meetingDir, correctionMeta) {
  try {
    const metaPath = path.join(meetingDir, 'meta.json');
    let m = {};
    try { m = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) {}
    m.correction = correctionMeta;
    fs.writeFileSync(metaPath, JSON.stringify(m, null, 2), 'utf8');
  } catch (e) {}
}

// MTG-COR-01 (SPEC-meeting-correction §4): 單一模型逐字稿校正。讀基底（labeled 優先，否則
// raw；空 → caller 需先 400），分段＋overlap 序列跑單一模型，逐段回填 transcript.corrected.txt +
// meta.correction（增量寫入，供輪詢）。某段模型棄權/行數對不上 → 該段保留原文 + 誠實記錄錯誤，
// 不假裝成功、不中斷其餘段落（防當機精神）。
//   opts = { model, wsRoot, runId }
async function correctMeetingTranscript(meetingId, meetingDir, meta, opts) {
  opts = opts || {};
  const model = opts.model || DEFAULT_MEETING_MODEL;
  const runId = opts.runId || String(Date.now());

  let base = 'labeled';
  let baseText = '';
  try { baseText = fs.readFileSync(path.join(meetingDir, 'transcript.labeled.txt'), 'utf8'); } catch (e) {}
  if (!baseText.trim()) { base = 'raw'; try { baseText = fs.readFileSync(path.join(meetingDir, 'transcript.txt'), 'utf8'); } catch (e) {} }
  if (!baseText.trim()) {
    const error = '逐字稿為空，無法校正';
    _writeMeetingCorrectionMeta(meetingDir, { correctedAt: new Date().toISOString(), model, base, status: 'error', error, runId });
    return { ok: false, error };
  }

  const lines = baseText.split(/\r?\n/);
  const trailingEmpty = lines.length > 0 && lines[lines.length - 1] === '';
  const bodyLines = trailingEmpty ? lines.slice(0, -1) : lines;

  const chunks = _chunkMeetingTranscriptLines(bodyLines);
  const outLines = new Array(bodyLines.length);
  const errors = [];
  let anyError = false;

  const flush = (status) => {
    const text = outLines.map(l => (l == null ? '' : l)).join('\n') + (trailingEmpty ? '\n' : '');
    try { fs.writeFileSync(path.join(meetingDir, 'transcript.corrected.txt'), text, 'utf8'); } catch (e) {}
    _writeMeetingCorrectionMeta(meetingDir, {
      correctedAt: new Date().toISOString(), model, base, status, chunks: chunks.length, runId,
      ...(errors.length ? { error: errors.join('；') } : {})
    });
  };

  _writeMeetingCorrectionMeta(meetingDir, { correctedAt: new Date().toISOString(), model, base, status: 'running', chunks: chunks.length, runId });

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const targetLines = bodyLines.slice(chunk.start, chunk.end);
    const prompt = _meetingCorrectionPrompt(meta, chunk.overlapLines, targetLines);
    let output = '', ok = false;
    try {
      const { provider, modelArg } = parseChatModel(model);
      output = await _spawnCliPrintOnce({ provider, modelArg, prompt, wsRoot: opts.wsRoot, timeoutMs: MEETING_SUMMARY_TIMEOUT_MS });
      const t = (output || '').trim();
      ok = !!(t && !t.startsWith('❌') && !t.startsWith('⚠️'));
    } catch (e) { ok = false; errors.push(`第 ${ci + 1}/${chunks.length} 段：${e.message}`); }

    if (ok) {
      const rec = _reconcileCorrectedChunk(targetLines, output);
      for (let i = 0; i < rec.lines.length; i++) outLines[chunk.start + i] = rec.lines[i];
      if (rec.fellBack) { anyError = true; errors.push(`第 ${ci + 1}/${chunks.length} 段：${rec.reason}，已保留原文`); }
    } else {
      for (let i = 0; i < targetLines.length; i++) outLines[chunk.start + i] = targetLines[i];
      anyError = true;
      errors.push(`第 ${ci + 1}/${chunks.length} 段：模型未產出，已保留原文`);
    }
    flush('running');
  }

  const finalStatus = anyError ? 'error' : 'done';
  flush(finalStatus);
  console.log('[Meeting] correction', finalStatus, 'for', meetingId, '(' + chunks.length + ' chunks)');
  return { ok: true, status: finalStatus, chunks: chunks.length, error: errors.length ? errors.join('；') : undefined };
}

// G11/W4 + MTG-SUM-02/03/04 + P3 (§5.5): multi-model "三分項" meeting summary. For each selected
// model, ONE CLI call (方案 A′/MSUM-D1) asks only for the checked `parts` and writes
// summary.<key>.md / keypoints.<key>.md / actions.<key>.json — only the requested files are
// overwritten, unrequested parts keep whatever was already on disk. "一組" 防呆 (§5.5.3): a model
// with no existing summary.<key>.md always gets `summary` forced on, regardless of the request.
// Then finalize per mode into summary.md + keypoints.md + actions.json + meta provenance.
// Called by POST /api/meeting/:id/summarize (on-demand) and finalizeMeetingSummary / lazy backfill.
//   opts = { models:['provider::model',...], mode:'single'|'pick'|'merge', chosenModel?, parts? }
async function meetingSummarizeToFiles(meetingId, meetingDir, meetingsDir, meta, transcript, wctx, opts) {
  opts = opts || {};
  let models = (Array.isArray(opts.models) && opts.models.length) ? opts.models.filter(Boolean) : [DEFAULT_MEETING_MODEL];
  models = [...new Set(models)];   // de-dup, preserve order
  const requestedMode = opts.mode || (models.length > 1 ? 'pick' : 'single');
  const requestedParts = _normalizeMeetingParts(opts.parts);
  const title = (meta && meta.title) || meetingId;
  const runId = opts.runId || String(Date.now());   // MTG-SUM-14: ties this run's incremental writes together for the poller

  const nowIso = new Date().toISOString();
  const versions = [];   // provenance rows (model + file + time + ok + parts)
  const okParsed = [];   // { model, summaryMd, keypointsMd, actions } for finalize

  // MTG-SUM-14: publish runId + empty versions immediately, before any model runs, so the first poll
  // already sees "this run started" (x/N = 0/N) instead of stale data from a prior run.
  _writeMeetingSummaryMeta(meetingDir, { runId, summarizedAt: nowIso, models, mode: requestedMode, chosenModel: opts.chosenModel || null, versions: [], lastRunError: null });

  for (const modelKey of models) {
    const fileKey = modelFileKey(modelKey);
    const summaryPath = path.join(meetingDir, 'summary.' + fileKey + '.md');
    const keypointsPath = path.join(meetingDir, 'keypoints.' + fileKey + '.md');
    const actionsPath = path.join(meetingDir, 'actions.' + fileKey + '.json');
    const priorHasSummary = fs.existsSync(summaryPath);

    const parts = { ...requestedParts };
    if (!parts.summary && !priorHasSummary) parts.summary = true;   // 一組防呆：無摘要不可只勾重點/action

    let existingSummaryMd = '';
    if (!parts.summary && priorHasSummary) { try { existingSummaryMd = fs.readFileSync(summaryPath, 'utf8'); } catch (e) {} }

    const prompt = _meetingSummaryPrompt(title, transcript, parts, existingSummaryMd);
    const startedAt = Date.now();
    let ok = false, output = '', error = null;
    try {
      const { provider, modelArg } = parseChatModel(modelKey);
      output = await _spawnCliPrintOnce({ provider, modelArg, prompt, wsRoot: wctx.root, timeoutMs: MEETING_SUMMARY_TIMEOUT_MS });
      const t = (output || '').trim();
      ok = !!(t && !t.startsWith('❌') && !t.startsWith('⚠️'));
    } catch (e) { error = e.message; ok = false; }
    const elapsedMs = Date.now() - startedAt;
    const file = 'summary.' + fileKey + '.md';

    if (ok) {
      const parsed = _parseMeetingSummaryOutput(output, parts);
      if (parts.summary && parsed.summaryMd) fs.writeFileSync(summaryPath, parsed.summaryMd, 'utf8');
      if (parts.keypoints && parsed.keypointsMd) fs.writeFileSync(keypointsPath, parsed.keypointsMd, 'utf8');
      if (parts.actions) fs.writeFileSync(actionsPath, JSON.stringify(parsed.actions, null, 2), 'utf8');

      let summaryMd = ''; try { summaryMd = fs.readFileSync(summaryPath, 'utf8'); } catch (e) {}
      let keypointsMd = ''; try { keypointsMd = fs.readFileSync(keypointsPath, 'utf8'); } catch (e) {}
      let actions = []; try { actions = JSON.parse(fs.readFileSync(actionsPath, 'utf8')); } catch (e) {}
      if (!Array.isArray(actions)) actions = [];
      okParsed.push({ model: modelKey, summaryMd, keypointsMd, actions });
      versions.push({
        model: modelKey, file, generatedAt: nowIso, ok: true, elapsedMs,
        parts: { summary: fs.existsSync(summaryPath), keypoints: fs.existsSync(keypointsPath), actions: fs.existsSync(actionsPath) }
      });
    } else {
      versions.push({
        model: modelKey, file, generatedAt: nowIso, ok: false, elapsedMs, error: error || 'no-output',
        parts: { summary: fs.existsSync(summaryPath), keypoints: fs.existsSync(keypointsPath), actions: fs.existsSync(actionsPath) }
      });
    }
    // MTG-SUM-14: write meta.summary.versions incrementally (per model), not just after the whole loop —
    // otherwise a poller sees no change until every model finishes, even though work is progressing.
    _writeMeetingSummaryMeta(meetingDir, { runId, summarizedAt: nowIso, models, mode: requestedMode, chosenModel: opts.chosenModel || null, versions: versions.slice(), lastRunError: null });
  }

  if (!okParsed.length) {
    // Every model forfeited — do NOT clobber an existing good summary.md; just record the attempt,
    // and surface an honest error so the poller doesn't report a fake success (MTG-SUM-14 缺口 A #3).
    const lastRunError = '所有模型都沒產出、已保留原摘要';
    console.error('[Meeting] all models failed for', meetingId, '(' + models.join(', ') + ')');
    _writeMeetingSummaryMeta(meetingDir, { runId, summarizedAt: nowIso, models, mode: requestedMode, chosenModel: opts.chosenModel || null, versions, lastRunError });
    meetingGitCommit(meetingsDir, meetingId, 'summarize attempted (0/' + models.length + ' models ok)', 'Hana');
    return { ok: false, versions, error: lastRunError, runId };
  }

  const fin = await _finalizeMeetingSummary({ meetingId, meetingDir, meetingsDir, title, okParsed, versions, mode: requestedMode, chosenModel: opts.chosenModel, wsRoot: wctx.root, actor: 'Hana', runId });
  console.log('[Meeting] multi-model summary written for', meetingId, '—', fin.mode + ',', okParsed.length + '/' + models.length, 'ok');
  return { ok: true, versions, mode: fin.mode, chosenModel: fin.chosenModel, runId };
}

// MTG-SUM-03/10 收尾: finalize N generated versions → summary.md + keypoints.md + actions.json +
// meta provenance, 三分項一致 (§5.5.4).
//   mode 'merge' (≥2 ok): lead model reads all versions' 摘要+重點 → best pair (MSUM-D3: lead 重寫，
//     非聯集); actions = union-dedupe of ALL versions (unchanged from P1).
//   mode 'pick'/'single': chosenModel's version (or first ok) → its 摘要/重點/actions become final.
// Preserves the `versions` provenance rows; updates mode/chosenModel/summarizedAt. Shared by the
// generate path (meetingSummarizeToFiles) and the finalize-only endpoint (no model re-run for pick).
async function _finalizeMeetingSummary({ meetingId, meetingDir, meetingsDir, title, okParsed, versions, mode, chosenModel, wsRoot, actor, runId }) {
  const nowIso = new Date().toISOString();
  const models = versions.map(v => v.model);
  let finalSummary = '', finalKeypoints = '', finalActions = [], effectiveMode, chosen;
  if (mode === 'merge' && okParsed.length > 1) {
    const lead = (chosenModel && okParsed.some(v => v.model === chosenModel)) ? chosenModel : okParsed[0].model;
    const mergeRes = await runModelsSequential({ prompt: _meetingMergePrompt(title, okParsed), models: [lead], perTimeoutMs: MEETING_SUMMARY_TIMEOUT_MS, wsRoot });
    const mr = mergeRes[0];
    if (mr && mr.ok) {
      const parsed = _parseMeetingSummaryOutput(mr.output, { summary: true, keypoints: true, actions: false });
      finalSummary = parsed.summaryMd || okParsed[0].summaryMd;
      finalKeypoints = parsed.keypointsMd || (okParsed.find(v => v.keypointsMd) || {}).keypointsMd || '';
      effectiveMode = 'merge'; chosen = lead;
    } else {   // merge failed → first ok
      finalSummary = okParsed[0].summaryMd; finalKeypoints = okParsed[0].keypointsMd || ''; effectiveMode = 'pick'; chosen = okParsed[0].model;
    }
    finalActions = _mergeMeetingActions(okParsed.map(v => v.actions));   // union-dedupe across ALL versions
  } else {
    const pick = okParsed.find(v => v.model === chosenModel) || okParsed[0];
    finalSummary = pick.summaryMd; finalKeypoints = pick.keypointsMd || ''; finalActions = pick.actions; chosen = pick.model;
    effectiveMode = okParsed.length > 1 ? 'pick' : 'single';
  }
  fs.writeFileSync(path.join(meetingDir, 'summary.md'), finalSummary, 'utf8');
  fs.writeFileSync(path.join(meetingDir, 'keypoints.md'), finalKeypoints, 'utf8');
  fs.writeFileSync(path.join(meetingDir, 'actions.json'), JSON.stringify(finalActions, null, 2), 'utf8');
  _writeMeetingSummaryMeta(meetingDir, { runId: runId || null, summarizedAt: nowIso, models, mode: effectiveMode, chosenModel: chosen, versions, lastRunError: null });
  meetingGitCommit(meetingsDir, meetingId, 'summary finalized (' + effectiveMode + ')', actor || '老闆');
  return { ok: true, mode: effectiveMode, chosenModel: chosen };
}

// Load already-generated per-model versions from disk into the {model,summaryMd,keypointsMd,actions}
// finalize shape (used by the finalize-only endpoint — no model re-run for pick).
function _loadMeetingVersionsForFinalize(meetingDir, meta) {
  const out = [];
  const vers = (meta && meta.summary && Array.isArray(meta.summary.versions)) ? meta.summary.versions : [];
  for (const v of vers) {
    if (!v.ok) continue;
    let summaryMd = '';
    try { summaryMd = fs.readFileSync(path.join(meetingDir, v.file), 'utf8'); } catch (e) { continue; }
    const fileKey = modelFileKey(v.model);
    let keypointsMd = ''; try { keypointsMd = fs.readFileSync(path.join(meetingDir, 'keypoints.' + fileKey + '.md'), 'utf8'); } catch (e) {}
    let actions = [];
    try { actions = JSON.parse(fs.readFileSync(path.join(meetingDir, 'actions.' + fileKey + '.json'), 'utf8')); } catch (e) {}
    if (!Array.isArray(actions)) actions = [];
    out.push({ model: v.model, summaryMd, keypointsMd, actions });
  }
  return out;
}

// MTG-SUM-04: lazy backfill — a meeting with a transcript but no summary.md gets a default single-model
// run kicked off in the background (guarded so lazy + manual don't double-fire). Returns true if a run
// is now in flight (so the UI can show 「自動補摘要中…」). A COOLDOWN stops a persistently-failing
// transcript from re-firing on every GET (incl. the 5s detail poll) — otherwise it would hammer the CLI.
const _meetingLazyCooldownMs = 5 * 60 * 1000;
const _meetingLazyLastFail = new Map();   // meetingId -> Date.now() of last failed lazy attempt
function _maybeLazySummarize(meetingId, meetingDir, meetingsDir, meta, transcript, wctx) {
  if (_meetingSummarizeInFlight.has(meetingId)) return true;
  const failedAt = _meetingLazyLastFail.get(meetingId);
  if (failedAt && (Date.now() - failedAt) < _meetingLazyCooldownMs) return false;   // in cooldown → don't re-fire
  _meetingSummarizeInFlight.add(meetingId);
  meetingSummarizeToFiles(meetingId, meetingDir, meetingsDir, meta, transcript, wctx, { models: [DEFAULT_MEETING_MODEL], mode: 'single' })
    .then(r => { if (r && r.ok) _meetingLazyLastFail.delete(meetingId); else _meetingLazyLastFail.set(meetingId, Date.now()); })
    .catch(e => { console.error('[Meeting] lazy summarize failed:', e.message); _meetingLazyLastFail.set(meetingId, Date.now()); })
    .finally(() => _meetingSummarizeInFlight.delete(meetingId));
  return true;
}

// G3: a finished meeting → Hana summary + transcript link written into the workspace's chat_history
// as one session (title='會議：<title>') so it can later be distilled by /memory and cited by Hana.
async function finalizeMeetingSummary(meetingId, meetingDir, wctx) {
  let transcript = '';
  try { transcript = fs.readFileSync(path.join(meetingDir, 'transcript.labeled.txt'), 'utf8'); } catch (e) {}
  if (!transcript.trim()) { try { transcript = fs.readFileSync(path.join(meetingDir, 'transcript.txt'), 'utf8'); } catch (e) {} }
  if (!transcript.trim()) return;   // empty meeting (e.g. no speech captured) → nothing to summarise
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(meetingDir, 'meta.json'), 'utf8')); } catch (e) {}
  const title = meta.title || meetingId;
  const meetingsDir = path.dirname(meetingDir);
  // G11 + MTG-SUM-04: auto-summary on stop runs ONE default model (穩、便宜) as the 保底 —
  // multi-model / merge is opt-in via the detail UI. Guarded so it won't collide with a lazy backfill.
  if (_meetingSummarizeInFlight.has(meetingId)) return;
  _meetingSummarizeInFlight.add(meetingId);
  try {
    await meetingSummarizeToFiles(meetingId, meetingDir, meetingsDir, meta, transcript, wctx, { models: [DEFAULT_MEETING_MODEL], mode: 'single' });
  } catch (e) { console.error('[Meeting] meetingSummarizeToFiles failed:', e.message); }
  finally { _meetingSummarizeInFlight.delete(meetingId); }
  // Meetings are stored in runtime/meetings (GET /api/meetings) — not in chat_history.
  // Hana's self-awareness of past meetings comes from the meetings store, not the chat feed.
}

function getChatHistories(chatHistoryDir = CHAT_HISTORY_DIR) {
  if (!fs.existsSync(chatHistoryDir)) return [];
  const list = fs.readdirSync(chatHistoryDir);
  const histories = [];

  for (const file of list) {
    if (file.startsWith('chat_') && file.endsWith('.json')) {
      const fullPath = path.join(chatHistoryDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        // H1: infer origin for backward-compat (old sessions have no origin field).
        const effectiveOrigin = data.origin || (data.sessionId?.startsWith('sched_') ? 'schedule' : 'human');
        // H1: only surface human conversations in the history list; schedule sessions are shown in
        // the scheduler panel under their respective schedule (H2 分流 UI).
        if (effectiveOrigin !== 'human') continue;
        // 只列「在 AI 對話面板裡直接開的對話」。針對特定脈絡（文件 / 會議 / 專案）開的浮動對話
        // 有自己的入口（GET /api/chat-sessions?filePath= 等），列在這裡只會讓人誤刪。
        if (data.filePath || data.meetingId || (Array.isArray(data.pmProjectIds) && data.pmProjectIds.length)) continue;
        // Custom title wins; otherwise derive from the first user message.
        let title = data.title;
        if (!title) {
          const firstUserMsg = data.messages.find(m => m.role === 'user' && typeof m.content === 'string');
          title = firstUserMsg ? firstUserMsg.content.slice(0, 30) + (firstUserMsg.content.length > 30 ? '...' : '') : '無主題對話';
        }
        histories.push({
          sessionId: data.sessionId,
          title,
          updatedAt: data.updatedAt
        });
      } catch (e) {}
    }
  }

  return histories.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// --- Gemini MCP Integration Helpers ---

const geminiTools = [
  {
    functionDeclarations: [
      {
        name: "list_specs",
        description: "Lists all available markdown specification and task files in the workspace (specs/, governance/, legislation/, .worktable/).",
        parameters: {
          type: "OBJECT",
          properties: {}
        }
      },
      {
        name: "search_specs",
        description: "Scans all project specifications and task files for target keywords or text patterns, returning matching file paths and line snippets.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: {
              type: "STRING",
              description: "The search term or keyword to scan for (e.g. \"Batch 07\", \"eval\", \"excel-service\")."
            }
          },
          required: ["query"]
        }
      },
      {
        name: "read_spec",
        description: "Reads and returns the complete text content of a specific specification or markdown file inside the workspace.",
        parameters: {
          type: "OBJECT",
          properties: {
            filePath: {
              type: "STRING",
              description: "Relative path of the target file inside the workspace (e.g. \"specs/packages/layout/SPEC-LAYOUT.md\")."
            }
          },
          required: ["filePath"]
        }
      }
    ]
  }
];

// NOTE: getGeminiCliOAuthToken() / getGoogleAdcToken() were removed. Those passed the agy
// Code Assist OAuth token (or a Google ADC user token) to the public generativelanguage API,
// which always rejected it with 401 ACCESS_TOKEN_TYPE_UNSUPPORTED. Direct Gemini calls now
// require a real GEMINI_API_KEY (AI Studio key); otherwise Gemini is served by the agy CLI.

async function callGeminiWithTools(messages, token, modelName = "gemini-3.5-flash-medium", apiKey = "") {
  let targetModel = modelName;
  if (modelName.startsWith('gemini-3.5-flash')) {
    targetModel = 'gemini-3.5-flash';
  } else if (modelName.startsWith('gemini-3.1-pro')) {
    targetModel = 'gemini-3.1-pro';
  }

  let urlStr;
  const headers = {
    "content-type": "application/json"
  };

  if (apiKey) {
    urlStr = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;
  } else if (token) {
    urlStr = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent`;
    headers["Authorization"] = `Bearer ${token}`;
    // Required for OAuth-based auth: tells the API which project to bill
    headers["x-goog-user-project"] = process.env.GOOGLE_CLOUD_PROJECT || 'gemini-cli-prod';
  } else {
    throw new Error("無效的認證：未提供 Gemini API Key 且 Google ADC Access Token 為空。");
  }

  // Map messages to Gemini's format
  let contents = [];
  for (const msg of messages) {
    let role = msg.role;
    if (role === "assistant") {
      role = "model";
    }

    if (Array.isArray(msg.content)) {
      let parts = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push({ text: block.text });
        } else if (block.type === "tool_use") {
          parts.push({
            functionCall: {
              name: block.name,
              args: block.input
            }
          });
        } else if (block.type === "tool_result") {
          role = "function";
          let respObj = {};
          try {
            respObj = JSON.parse(block.content);
          } catch(e) {
            respObj = { content: block.content };
          }
          parts.push({
            functionResponse: {
              name: block.name || block.tool_use_id,
              response: respObj
            }
          });
        }
      }
      contents.push({ role, parts });
    } else {
      contents.push({
        role: role,
        parts: [{ text: msg.content }]
      });
    }
  }

  let loopCount = 0;
  const maxLoops = 6;
  const executionTrace = [];

  while (loopCount < maxLoops) {
    loopCount++;
    const payload = {
      contents: contents,
      tools: geminiTools
    };

    console.log(`[Gemini API] Requesting ${modelName}, loop ${loopCount}...`);
    const response = await httpsPost(urlStr, headers, payload);

    if (!response.candidates || response.candidates.length === 0) {
      throw new Error(`Gemini API 回傳空內容。完整回應: ${JSON.stringify(response)}`);
    }

    const candidate = response.candidates[0];
    const candidateContent = candidate.content;
    
    // In Gemini, role must alternate, pushing model response into history context
    contents.push(candidateContent);

    const parts = candidateContent.parts || [];
    const functionCallPart = parts.find(p => p.functionCall);

    if (functionCallPart) {
      const { name: toolName, args: toolInput } = functionCallPart.functionCall;
      console.log(`[Gemini API] Gemini invoked: ${toolName}`);

      let resultText = "";
      try {
        if (toolName === "list_specs") {
          const files = mcpServer.listSpecs();
          resultText = JSON.stringify({ files });
        } else if (toolName === "search_specs") {
          const matches = mcpServer.searchSpecs(toolInput.query);
          resultText = JSON.stringify({ matches });
        } else if (toolName === "read_spec") {
          const content = mcpServer.readSpecFile(toolInput.filePath);
          resultText = JSON.stringify({ content });
        } else {
          resultText = JSON.stringify({ error: `Tool ${toolName} not found.` });
        }
      } catch (err) {
        resultText = JSON.stringify({ error: err.message });
      }

      executionTrace.push({
        toolName,
        args: toolInput,
        resultPreview: resultText.slice(0, 300) + (resultText.length > 300 ? "..." : "")
      });

      contents.push({
        role: "function",
        parts: [{
          functionResponse: {
            name: toolName,
            response: JSON.parse(resultText)
          }
        }]
      });

    } else {
      const textPart = parts.find(p => p.text);
      const replyText = textPart ? textPart.text : "";
      
      const simplifiedHistory = [];
      for (const item of contents) {
        let role = item.role;
        if (role === "model") role = "assistant";
        if (role === "function") continue; // Skip raw tool responses in output history
        
        const textParts = (item.parts || []).filter(p => p.text);
        if (textParts.length > 0) {
          simplifiedHistory.push({
            role: role,
            content: textParts.map(p => p.text).join('\n')
          });
        }
      }

      return {
        reply: replyText,
        history: simplifiedHistory,
        trace: executionTrace
      };
    }
  }

  throw new Error("超過最大工具調用循環上限");
}

// ===================== Chat: model providers + CLI routing =====================
const DEFAULT_CHAT_MODEL = 'claude::sonnet';

function parseChatModel(value) {
  if (value && value.includes('::')) {
    const i = value.indexOf('::');
    return { provider: value.slice(0, i), modelArg: value.slice(i + 2) };
  }
  // Back-compat with the old hardcoded dropdown values.
  if (value && value.startsWith('claude')) return { provider: 'claude', modelArg: value === 'claude-opus-4.6' ? 'opus' : 'sonnet' };
  if (value && value.startsWith('gpt-oss')) return { provider: 'gemini', modelArg: 'gpt-oss-120b' };
  if (value && value.startsWith('gemini')) return { provider: 'gemini', modelArg: value };
  return { provider: 'gemini', modelArg: 'gemini-3.5-flash' };
}

// Chat context v1: a sliding window of recent turns + a continuation/concise preface.
// - Model-agnostic: every CLI gets the SAME context, so the conversation continues even
//   when the user switches models mid-thread (cross-model continuity).
// - The preface tells the agent to answer directly and NOT re-run the project boot-check /
//   status report every turn (fixes the repeated boot-check) unless explicitly asked.
// - The window bounds cost so long conversations don't keep growing the prompt.
// v2a — file-based context. The PORTAL owns a model-agnostic transcript and writes the
// FULL conversation history to a gitignored file in the workspace. The prompt then points
// the agent at that file (which any CLI can read with its own tools) instead of stuffing
// the whole history into argv/stdin. This gives continuity WITHOUT window truncation or
// lossy distillation: long threads no longer grow the prompt, and references to much
// earlier turns still resolve because the agent can read the file. The last few turns are
// still inlined so short threads and agents that skip the read still have immediate context.
const CHAT_INLINE_TURNS = 3;
function chatMsgText(m) {
  return typeof m.content === 'string' ? m.content
    : (Array.isArray(m.content) ? m.content.filter(c => c.text).map(c => c.text).join('\n') : '');
}

// Write the full prior transcript to <chat_history>/context_<sessionId>.md and return its
// absolute path (or null if there's nothing to write / the write fails — callers degrade to
// inline-only). priorMessages = the conversation minus the current question.
function writeContextFile(sessionId, priorMessages, chatHistoryDir = CHAT_HISTORY_DIR) {
  if (!priorMessages || !priorMessages.length) return null;
  try {
    if (!fs.existsSync(chatHistoryDir)) fs.mkdirSync(chatHistoryDir, { recursive: true });
    let md = `# 對話歷史（session ${sessionId}）\n`;
    md += '> 這是你和使用者「目前這個對話視窗」的完整歷史記錄，依時間排序。回答時請參考此脈絡，但不要逐字覆述。\n\n';
    priorMessages.forEach((m, i) => {
      if (m.role === 'user') {
        md += `## [${i + 1}] 使用者\n${chatMsgText(m)}\n\n`;
      } else {
        const who = m.meta && m.meta.provider ? `Assistant · ${m.meta.provider}${m.meta.model ? '/' + m.meta.model : ''}` : 'Assistant';
        md += `## [${i + 1}] 你（${who}）\n${chatMsgText(m)}\n\n`;
      }
    });
    const filePath = path.join(chatHistoryDir, `context_${sessionId}.md`);
    fs.writeFileSync(filePath, md, 'utf8');
    return filePath;
  } catch (e) {
    console.error('[Chat] writeContextFile failed (degrading to inline-only):', e.message);
    return null;
  }
}

// SCHED-09: Hana 自我感知 — 把近 24h 排程執行摘要注入 prompt，讓 Hana 能回答「今天做了什麼」。
function injectActivityContext(workspaceRoot) {
  try {
    var since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    var runs = schedulerManager.queryRuns({ since: since, limit: 20 });
    if (!runs.length) return '';
    var schedules = schedulerManager.loadSchedules();
    var schedMap = {};
    var wsMap = {};
    schedules.forEach(function(s) { schedMap[s.id] = s.name; wsMap[s.id] = s.workspace; });
    // Workspace isolation: only surface runs whose schedule belongs to the active workspace
    // (null workspace = harness home, matching the runner default WORKSPACE_ROOT).
    if (workspaceRoot) {
      var norm = function (p) { try { return path.resolve(String(p || '')).toLowerCase(); } catch (e) { return ''; } };
      var active = norm(workspaceRoot);
      runs = runs.filter(function (r) { return norm(wsMap[r.scheduleId] || WORKSPACE_ROOT) === active; });
      if (!runs.length) return '';
    }
    var statusLabel = { success: '✅ 成功', failed: '❌ 失敗', 'limited-waiting': '⏳ 等待限額重置', running: '🔄 執行中', aborted: '🛑 已中止' };
    var lines = runs.map(function(r) {
      var name = schedMap[r.scheduleId] || r.scheduleId;
      var t = r.startedAt ? r.startedAt.slice(0, 16).replace('T', ' ') : '?';
      var st = statusLabel[r.status] || r.status;
      var dur = (r.usage && r.usage.runtimeMs) ? Math.round(r.usage.runtimeMs / 1000) + 's' : '';
      return '- [' + t + '] ' + name + '（' + (r.model || '?') + '）→ ' + st + (dur ? '，耗時 ' + dur : '');
    });
    return '\n\n=== 近 24 小時排程執行紀錄（Hana 自我感知）===\n' + lines.join('\n') + '\n=== 紀錄結束 ===\n';
  } catch (e) { return ''; }
}

// SN2-03: inject the current workspace's unfinished sticky notes (指揮官個人待辦便條白板) so Hana
// can answer "還有哪些待辦？" without a separate lookup. Read-only here — creation/edits always go
// through POST/PUT /api/notes (or the /note Telegram command), never written from inside a prompt.
function injectNotesContext(workspaceRoot) {
  try {
    let list = notesStore.readNotes(HARNESS_HOME).filter(function (n) { return n.status === 'active'; });
    if (workspaceRoot) {
      var active = notesStore.normWs(workspaceRoot);
      list = list.filter(function (n) { return notesStore.normWs(n.workspace || WORKSPACE_ROOT) === active; });
    }
    if (!list.length) return '';
    list.sort(function (a, b) {
      if (!a.dueAt && !b.dueAt) return 0;
      if (!a.dueAt) return 1;
      if (!b.dueAt) return -1;
      return a.dueAt.localeCompare(b.dueAt);
    });
    var todayStr = notesStore.localDateStr(new Date());
    var lines = list.slice(0, 30).map(function (n) {
      var mark = '';
      if (n.dueAt) {
        var d = n.dueAt.slice(0, 10);
        var label = d < todayStr ? '⚠️已過期' : (d === todayStr ? '📍今日到期' : ('到期 ' + n.dueAt.slice(0, 16).replace('T', ' ')));
        mark = '（' + label + '）';
      }
      return '- ' + String(n.text || '').slice(0, 200) + mark;
    });
    return '\n\n=== 指揮官的便條貼白板（未完成，個人待辦，非任務清單）===\n' + lines.join('\n') + '\n=== 便條結束 ===\n';
  } catch (e) { return ''; }
}

// PM-18: inject the current workspace's PM projects+tasks summary (progress, upcoming due dates)
// so Hana can answer "某專案進度如何/還有哪些任務沒完成" without a separate lookup. Read-only here —
// creation/edits always go through the PM API (or the /pm command), never written from inside a prompt.
function injectPmContext(workspaceRoot) {
  try {
    const { projects, tasks } = readPm();
    const active = pmStore.normWs(workspaceRoot || WORKSPACE_ROOT);
    const list = projects.filter(p => !p.archived && pmStore.normWs(p.workspace || WORKSPACE_ROOT) === active);
    if (!list.length) return '';
    const statusLabel = { todo: '待辦', in_progress: '進行中', done: '完成' };
    const lines = list.slice(0, 20).map(p => {
      const pTasks = tasks.filter(t => t.projectId === p.id).sort((a, b) => (a.order || 0) - (b.order || 0));
      if (!pTasks.length) return '- 【' + p.name + '】（無任務）';
      const done = pTasks.filter(t => t.status === 'done').length;
      const taskLines = pTasks.slice(0, 15).map(t => {
        const milestone = t.isMilestone ? '◆' : '';
        return '  · ' + milestone + t.name + '（' + t.start + '~' + t.end + '，' + (t.progress || 0) + '%，' + (statusLabel[t.status] || t.status) + '）';
      });
      return '- 【' + p.name + '】' + done + '/' + pTasks.length + ' 完成\n' + taskLines.join('\n');
    });
    return '\n\n=== 指揮官的專案管理（PM，非任務清單非便條）===\n' + lines.join('\n') + '\n=== PM 結束 ===\n';
  } catch (e) { return ''; }
}

// v0.6 (F6e-認人): the "來賓" segment is no longer just a `> 名字：` text prefix — the client now
// sends a structured, ordered `turns:[{speaker:'me'|'guest', name, text}]` on the user message.
// When a guest turn is present, inject a hidden framework (老闆 never sees this) so Hana treats
// that segment as another real person speaking to her (via loopback STT, may have transcription
// noise) and answers by addressing them by name — instead of reading it as 老闆 talking oddly.
function buildGuestFrameworkText(turns) {
  const guestTurns = Array.isArray(turns) ? turns.filter(t => t && t.speaker === 'guest' && t.text) : [];
  if (!guestTurns.length) return '';
  const names = [...new Set(guestTurns.map(t => (t.name || '').trim() || '來賓'))];
  const nameList = names.join('、');
  return '\n\n【隱藏框架 — 僅你可見，指揮官看不到】本則訊息含現場另一位真實說話者「' + nameList + '」'
    + '（透過電腦音訊 loopback 即時轉錄，逐字可能有辨識誤差，抓語意即可）。請把他當成對話的另一方，'
    + '直接稱呼他的名字回應（例如「' + names[0] + ' 你好，針對你的問題…」）。'
    + '主框內容才是指揮官 老闆對你說的（通常是備註或提問框架，可能為空）。\n'
    // F8 (§6b.7)：偵測到 guest 段＝這是即時通話 → 疊加「通話簡短模式」。對方在線上等口頭回覆、
    // 沒耐心讀長文；無 guest 段的一般開發對話走不到這裡（上面已 return ''），維持詳盡不受影響。
    + '\n【隱藏框架 — 通話簡短模式，僅你可見】這是即時通話，對方在線上等你口頭回覆、沒耐心讀長文。'
    + '請精準扼要：先稱呼對方名字，直接給結論與關鍵數字，一般 1–3 句話。'
    + '不要：逐點鋪陳、重述問題、對查不到的資料長篇免責、附「Sources:」來源清單、加免責聲明。'
    + '若資料不確定，用一句話點出即可（如「數字僅供參考」），不展開。簡短不等於亂答——重點與關鍵數字要正確。\n';
}

// MM-M1: classify a chat attachment by extension (fallback to MIME) into the kinds the injector /
// (future) STT step care about. Only image/pdf/text/office are read natively by the CLI's Read.
function attachmentKind(name, mime) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  const e = m ? m[1] : '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'heif'].includes(e)) return 'image';
  if (e === 'pdf') return 'pdf';
  if (['txt', 'md', 'markdown', 'csv', 'json', 'log', 'xml', 'yaml', 'yml', 'html', 'htm'].includes(e)) return 'text';
  if (['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods'].includes(e)) return 'office';
  if (['mp3', 'm4a', 'wav', 'ogg', 'opus', 'flac', 'aac'].includes(e)) return 'audio';
  if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v'].includes(e)) return 'video';
  const mm = String(mime || '').toLowerCase();
  if (mm.startsWith('image/')) return 'image';
  if (mm === 'application/pdf') return 'pdf';
  if (mm.startsWith('text/')) return 'text';
  if (mm.startsWith('audio/')) return 'audio';
  if (mm.startsWith('video/')) return 'video';
  return 'text';
}

// SPEC-view-chat-context.md §3.4/CTX1: one provider per context `kind`, registered here. Each
// provider takes (payload, wctx) and returns the prompt text to inject; file/meeting/pm were
// extracted verbatim from buildChatPrompt's old hardcoded if-blocks (D1: 搬移而非改寫, zero
// behavior change). `schedule` is added in CTX2 (SPEC §3.5). Unknown kind → the dispatch below
// falls through to a no-op string, so a plugin view filling in a kind the server doesn't know
// about never breaks chat — it just gets no extra context injected.
// CTX2: server-side mirror of views/schedule.js's triggerLabel() — same wording, so a schedule's
// trigger reads the same whether Hana sees it via chat context or the指揮官 sees it on screen.
function _scheduleTriggerLabel(t) {
  if (!t) return '—';
  if (t.type === 'cron') return 'Cron: ' + t.expr;
  if (t.type === 'interval') return '每 ' + Math.round((t.intervalMs || 3600000) / 60000) + ' 分鐘';
  if (t.type === 'once') return '單次: ' + (t.atISO || '');
  if (t.type === 'manual') return '手動觸發';
  return t.type;
}

const CHAT_CONTEXT_PROVIDERS = {
  file: function (payload, wctx) {
    const filePath = payload && payload.filePath;
    if (!filePath || !wctx || !wctx.root) return '';
    try {
      const rootResolved = path.resolve(wctx.root);
      const abs = path.resolve(rootResolved, filePath);
      // Stay inside the workspace (no ../ escape) and only inject real files.
      if (!((abs === rootResolved || abs.startsWith(rootResolved + path.sep)) && fs.existsSync(abs) && fs.statSync(abs).isFile())) return '';
      let content = fs.readFileSync(abs, 'utf8');
      const LIMIT = 8 * 1024;
      const truncated = content.length > LIMIT;
      if (truncated) content = content.slice(0, LIMIT);
      return '\n=== 目前開啟的檔案（你正在和使用者一起看這個檔，可直接針對它回答或修改）===\n'
        + '路徑：' + filePath + '\n--- 內容開始 ---\n' + content + '\n--- 內容結束 ---'
        + (truncated ? '\n（檔案過長，僅注入前 8KB；需要完整內容請用讀檔工具讀 ' + filePath + '）' : '') + '\n';
    } catch (e) { return ''; /* file unreadable → skip injection, still answer */ }
  },
  meeting: function (payload, wctx) {
    const meetingId = payload && payload.meetingId;
    if (!meetingId || !wctx || !wctx.root) return '';
    try {
      const meetingDir = path.join(wctx.root, '.harness', 'runtime', 'meetings', meetingId);
      if (!fs.existsSync(meetingDir)) return '';
      let mtgMeta = {}, txContent = '', summaryContent = '', actionsContent = '';
      try { mtgMeta = JSON.parse(fs.readFileSync(path.join(meetingDir, 'meta.json'), 'utf8')); } catch (e) {}
      try { txContent = fs.readFileSync(path.join(meetingDir, 'transcript.labeled.txt'), 'utf8'); } catch (e) {}
      if (!txContent) { try { txContent = fs.readFileSync(path.join(meetingDir, 'transcript.txt'), 'utf8'); } catch (e) {} }
      try { summaryContent = fs.readFileSync(path.join(meetingDir, 'summary.md'), 'utf8'); } catch (e) {}
      try {
        const acts = JSON.parse(fs.readFileSync(path.join(meetingDir, 'actions.json'), 'utf8'));
        actionsContent = JSON.stringify(acts, null, 2);
      } catch (e) {}
      const title = mtgMeta.title || meetingId;
      let p = '\n=== 會議脈絡（你正在與使用者一起討論這場會議，可回答問題、也可修改逐字稿/摘要/Action）===\n';
      p += '會議標題：' + title + '\n';
      if (mtgMeta.startedAt) p += '時間：' + mtgMeta.startedAt + (mtgMeta.finishedAt ? ' ~ ' + mtgMeta.finishedAt : '') + '\n';
      if (summaryContent) p += '\n【摘要】\n' + summaryContent.slice(0, 3000) + '\n';
      if (actionsContent) p += '\n【Action Items】\n' + actionsContent.slice(0, 2000) + '\n';
      if (txContent) {
        const txTrunc = txContent.length > 8000;
        p += '\n【逐字稿】\n' + txContent.slice(0, 8000) + (txTrunc ? '\n（逐字稿過長，僅注入前 8000 字元）' : '') + '\n';
      }
      p += '=== 會議脈絡結束 ===\n';
      p += '若使用者要求修改逐字稿、摘要或 Action，請透過 PUT /api/meeting/' + meetingId + '/transcript (或 /summary 或 /actions) 寫回，並告知使用者已修改。\n';
      return p;
    } catch (e) { return ''; /* meeting context unreadable → skip */ }
  },
  pm: function (payload, wctx) {
    // PM7: 從甘特圖頭像開的討論 — 只針對使用者當下勾選的專案（可 1 個或多個）給詳細任務清單，
    // 讓「這個排程」「這幾個排程」的提問精準對應畫面上勾的是誰，而不是退回全部專案摘要。
    const pmProjectIds = payload && payload.pmProjectIds;
    if (!Array.isArray(pmProjectIds) || !pmProjectIds.length || !wctx || !wctx.root) return '';
    try {
      const { projects, tasks } = readPm();
      const active = pmStore.normWs(wctx.root || WORKSPACE_ROOT);
      const idSet = new Set(pmProjectIds);
      const list = projects.filter(p => idSet.has(p.id) && pmStore.normWs(p.workspace || WORKSPACE_ROOT) === active);
      if (!list.length) return '';
      const statusLabel = { todo: '待辦', in_progress: '進行中', done: '完成' };
      const lines = list.map(p => {
        const pTasks = tasks.filter(t => t.projectId === p.id).sort((a, b) => (a.order || 0) - (b.order || 0));
        if (!pTasks.length) return '- 【' + p.name + '】（無任務）';
        const done = pTasks.filter(t => t.status === 'done').length;
        const taskLines = pTasks.map(t => {
          const milestone = t.isMilestone ? '◆' : '';
          return '  · ' + milestone + t.name + '（' + t.start + '~' + t.end + '，' + (t.progress || 0) + '%，' + (statusLabel[t.status] || t.status) + (t.deps && t.deps.length ? '，依賴：' + t.deps.join('、') : '') + '）';
        });
        return '- 【' + p.name + '】' + done + '/' + pTasks.length + ' 完成\n' + taskLines.join('\n');
      });
      return '\n=== 使用者目前在甘特圖中勾選的專案（你正在和使用者一起看這 ' + list.length + ' 個排程，可直接針對它們回答或修改任務）===\n'
        + lines.join('\n') + '\n=== 勾選專案結束 ===\n';
    } catch (e) { return ''; /* pm context unreadable → skip */ }
  },
  // SPEC-view-chat-context.md §3.5/CTX2: D2/D3 — 跟著畫面走。清單頁給本工作區每筆一行摘要；
  // 已進入某一筆的 detail 頁給該筆完整內容（task 指示全文 + 最近 5 筆執行記錄）。
  // 工作區過濾鐵則：schedule.workspace 與 injectActivityContext 同一套 path.resolve()+小寫正規化
  // pattern — `all` 已經是過濾後的清單，list 用它、detail 也從它裡面 find（找不到就當作不存在，
  // 不洩漏其他工作區的排程是否存在）。
  schedule: function (payload, wctx) {
    try {
      const norm = function (p) { try { return path.resolve(String(p || '')).toLowerCase(); } catch (e) { return ''; } };
      const active = norm((wctx && wctx.root) || WORKSPACE_ROOT);
      const all = schedulerManager.loadSchedules().filter(function (s) { return norm(s.workspace || WORKSPACE_ROOT) === active; });

      const taskText = function (s) {
        return (s.task && s.task.kind === 'skill')
          ? ('/' + (s.task.skill || '') + (s.task.args ? ' ' + s.task.args : ''))
          : ((s.task && s.task.prompt) || '');
      };
      // D4/寫入授權：措辭沿用 server.js 現有 Telegram taskFn/chatFn 對 Hana 講排程系統的既有說法
      // （見 tgBotConfig.chatFn/taskFn 附近），保持「這是本地 Harness 排程器，不是 CronList/
      // CronCreate 那套雲端工具」的用語一致。額度護欄：/run 會真的燒模型額度，執行前要先問。
      const authNote = '\n「排程 / schedule」＝ Harness portal 排程器（不是 CronList/CronCreate 工具，別用那套）。'
        + '可用 POST /api/schedules 新建、PUT /api/schedules/<id> 修改（trigger/enabled/task…）、DELETE /api/schedules/<id> 刪除，指揮官已授權你直接改，不必每次先問。'
        + '【額度護欄】POST /api/schedules/<id>/run 會立即真的執行、燒模型額度——執行前務必先向指揮官確認取得同意才可以按；讀取、改設定、停用不需要先問。\n';

      if (payload && payload.scheduleId) {
        const s = all.find(function (x) { return x.id === payload.scheduleId; });
        if (!s) return '';
        const runs = schedulerManager.queryRuns({ scheduleId: s.id, limit: 5 });
        const statusLabel = { success: '✅ 成功', failed: '❌ 失敗', 'limited-waiting': '⏳ 等待限額重置', running: '🔄 執行中', aborted: '🛑 已中止', interrupted: '🛑 中斷' };
        const runLines = runs.map(function (r) {
          const t = r.startedAt ? r.startedAt.slice(0, 16).replace('T', ' ') : '?';
          const st = statusLabel[r.status] || r.status;
          const dur = (r.usage && r.usage.runtimeMs) ? Math.round(r.usage.runtimeMs / 1000) + 's' : '';
          let logTail = '';
          try {
            const artIds = r.artifactIds || [];
            const lastArtId = artIds[artIds.length - 1];
            if (lastArtId) {
              const art = schedulerManager.getArtifact(s.id, r.id, lastArtId);
              if (art && art.content) logTail = String(art.content).slice(-1024);
            }
          } catch (e) {}
          return '- [' + t + '] ' + st + (dur ? '，耗時 ' + dur : '') + (r.error ? '，錯誤：' + String(r.error).slice(0, 300) : '')
            + (logTail ? '\n  log 尾端：' + logTail : '');
        });
        let taskFull = taskText(s);
        const TASK_LIMIT = 8 * 1024;
        const taskTruncated = taskFull.length > TASK_LIMIT;
        if (taskTruncated) taskFull = taskFull.slice(0, TASK_LIMIT);
        let p = '\n=== 排程詳情（你正在和使用者一起看這筆排程，可直接回答或依指示修改）===\n';
        p += '名稱：' + s.name + '（id: ' + s.id + '）\n';
        p += '觸發：' + _scheduleTriggerLabel(s.trigger) + '\n';
        p += '啟用：' + (s.enabled ? '是' : '否') + (s.archived ? '（已歸檔）' : '') + '\n';
        p += '模型：' + s.model + '\n';
        p += 'postRun.deploy：' + (s.postRun && s.postRun.deploy ? '是' : '否') + '\n';
        p += 'chainNext：' + (s.chainNext || '無') + '\n';
        p += '上次執行：' + (s.lastRunAt || '無') + '，狀態：' + (s.lastRunStatus || '無') + '\n';
        p += '下次執行：' + (s.nextRunAt || '無') + '\n';
        p += '\n【task 指示全文】\n' + taskFull + (taskTruncated ? '\n（過長，僅注入前 8KB）' : '') + '\n';
        if (runLines.length) p += '\n【最近 ' + runLines.length + ' 筆執行記錄】\n' + runLines.join('\n') + '\n';
        p += '=== 排程詳情結束 ===\n';
        p += authNote;
        return p;
      }

      if (!all.length) return '\n=== 排程清單（本工作區）===\n（本工作區目前沒有排程）\n' + authNote;
      const lines = all.map(function (s) {
        let t = taskText(s);
        if (t.length > 200) t = t.slice(0, 200) + '…';
        return '- ' + s.name + '（id: ' + s.id + '）｜觸發：' + _scheduleTriggerLabel(s.trigger) + '｜啟用：' + (s.enabled ? '是' : '否')
          + '｜模型：' + s.model + '｜postRun.deploy：' + (s.postRun && s.postRun.deploy ? '是' : '否')
          + '｜chainNext：' + (s.chainNext || '無') + '｜上次執行：' + (s.lastRunAt || '無') + '（' + (s.lastRunStatus || '無') + '）'
          + '｜task：' + t;
      });
      return '\n=== 排程清單（本工作區，共 ' + all.length + ' 筆）===\n' + lines.join('\n') + '\n=== 排程清單結束 ===\n' + authNote;
    } catch (e) { return ''; /* schedule context unreadable → skip */ }
  },
  // SPEC-view-chat-context.md §3.1 (CTX4) + SPEC-whiteboard.md §8 — 頭像在白板頁開的對話。
  // 「跟著畫面走」：payload.boardId 指的就是使用者眼前那張白板；沒有 boardId（vendor 還在載）就
  // 只給本工作區的白板清單。內容一律從 board.json 現讀（不信任前端傳來的場景），並照 whiteboards
  // API 一貫的工作區隔離走 wctx.root，不會讀到別的工作區。
  whiteboard: function (payload, wctx) {
    try {
      const root = (wctx && wctx.root) || WORKSPACE_ROOT;
      const list = whiteboardsStore.readIndex(root) || [];
      // 沿用 §8 elements API 既有措辭：Hana 可直接畫，但白板是使用者的畫布，破壞性的 replace 要先問。
      const authNote = '\n你可以直接在這張白板上畫東西：POST /api/whiteboards/<id>/elements'
        + '，body `{ elements: [...], mode: "append" | "replace" }`（Excalidraw 元素 JSON，缺的內部欄位後端會自動補齊；'
        + '箭頭要吸附就填 startBinding/endBinding）。白板面板每 2 秒輪詢，畫完使用者畫面上會自己出現，不必請他重整。'
        + '也可 PUT /api/whiteboards/<id> 改標題、GET /api/whiteboards 列出全部。'
        + '【護欄】`mode:"replace"` 會覆蓋整張白板的既有內容，屬破壞性操作——執行前先向使用者確認；append 不必問。'
        // §8.3.2 (WB5/WB-21)：涉及「A 切 B」「交集」「扇形/弓形」這類幾何精算需求，不要用四點自由曲線
        // 硬湊，改用 portal/wb-geometry.js（直線⇄圓/橢圓真實交點、弧段等角取樣、封閉輪廓組裝）。
        + '需要精算幾何交集（例如「畫出兩個圖形交接的那塊」）時，不要用猜的湊點，改用 portal/wb-geometry.js（node 直接呼叫即可，見 /whiteboard 技能 §4）。'
        // §8.3.3 (WB5/WB-22)：id 只給 Hana 自己呼叫 API 用，絕不能出現在講給指揮官聽的話裡。
        + '【重要】下面【畫面上的元素】每行開頭的 id=xxx 只給你呼叫 API 時內部對照用；回覆使用者時一律用人話描述（例如「左邊的三角形」「中間的圓」），絕對不要把 id 講出來或貼進回覆——使用者看不懂那串代號。'
        + '詳細畫法見技能 /whiteboard。\n';

      const boardId = payload && payload.boardId;
      const board = boardId ? whiteboardsStore.readBoard(root, boardId) : null;
      if (!board) {
        if (!list.length) return '\n=== 白板（本工作區）===\n（使用者正在白板面板，但本工作區目前沒有白板）\n' + authNote;
        return '\n=== 白板（本工作區，共 ' + list.length + ' 張）===\n'
          + '（使用者正在白板面板，但畫面尚未載入完某一張；以下是本工作區的白板清單）\n'
          + list.map(function (b) { return '- ' + (b.title || b.id) + '（id: ' + b.id + '，更新於 ' + (b.updatedAt || '?') + '）'; }).join('\n')
          + '\n=== 白板清單結束 ===\n' + authNote;
      }

      const els = (board.elements || []).filter(function (e) { return e && !e.isDeleted; });
      // 綁在容器裡的文字（containerId）另外掛回容器那一行，否則畫面上「框裡寫著什麼」會散成兩筆、讀不出關聯。
      const boundText = {};
      els.forEach(function (e) { if (e.type === 'text' && e.containerId) boundText[e.containerId] = (e.text || '').replace(/\s+/g, ' '); });
      const EL_LIMIT = 120; // 夠描述一張正常的架構圖；再多就只給統計，避免灌爆 prompt
      const shown = els.filter(function (e) { return !(e.type === 'text' && e.containerId); }).slice(0, EL_LIMIT);
      const counts = {};
      els.forEach(function (e) { counts[e.type] = (counts[e.type] || 0) + 1; });
      const countLine = Object.keys(counts).map(function (k) { return k + ' ' + counts[k]; }).join('、') || '（空白板）';

      // §8.3.3 (WB5/WB-22)：序號＋方位描述，取代「type + id」當主要描述——指揮官聽得懂「左邊的三角形」，
      // 聽不懂內部 id。方位以 shown 這批元素的整體 bbox 三等分（左/中/右、上/中/下）判斷；只有一個元素
      // 或 bbox 退化（全部同一點）時退回「唯一元素」。
      const bxs = shown.map(function (e) { return e.x + (e.width || 0) / 2; });
      const bys = shown.map(function (e) { return e.y + (e.height || 0) / 2; });
      const bMinX = Math.min.apply(null, bxs), bMaxX = Math.max.apply(null, bxs);
      const bMinY = Math.min.apply(null, bys), bMaxY = Math.max.apply(null, bys);
      function posLabel(e) {
        if (shown.length <= 1) return '唯一元素';
        const cx = e.x + (e.width || 0) / 2, cy = e.y + (e.height || 0) / 2;
        const spanX = bMaxX - bMinX, spanY = bMaxY - bMinY;
        const hx = spanX < 1 ? 1 : (cx - bMinX) / spanX;   // 0~1
        const hy = spanY < 1 ? 1 : (cy - bMinY) / spanY;
        const hLabel = hx < 1 / 3 ? '左' : (hx > 2 / 3 ? '右' : '中');
        const vLabel = hy < 1 / 3 ? '上' : (hy > 2 / 3 ? '下' : '中');
        if (hLabel === '中' && vLabel === '中') return '中間';
        if (vLabel === '中') return hLabel + '邊';
        if (hLabel === '中') return vLabel + '方';
        return vLabel + hLabel;
      }
      // §8.3.3：Excalidraw 沒有原生三角形——beautify 引擎（§6.2）用「三點封閉的 line」湊三角形，這裡
      // 用同樣的判斷法還原成「三角形」而不是講不出所以然的「線」，指揮官的描述才對得上畫面。
      function typeLabel(e) {
        const T = { rectangle: '矩形', diamond: '菱形', arrow: '箭頭', text: '文字', freedraw: '手繪筆跡', image: '圖片' };
        if (e.type === 'ellipse') {
          const w = e.width || 1, h = e.height || 1;
          const ratio = Math.max(w, h) / Math.max(1, Math.min(w, h));
          return ratio < 1.15 ? '圓' : '橢圓';
        }
        if (e.type === 'line') {
          const pts = Array.isArray(e.points) ? e.points : [];
          const closed = pts.length > 2 && Math.abs(pts[0][0] - pts[pts.length - 1][0]) < 1 && Math.abs(pts[0][1] - pts[pts.length - 1][1]) < 1;
          const distinct = closed ? pts.length - 1 : pts.length;
          if (closed && distinct === 3) return '三角形';
          if (closed && distinct === 4) return '四邊形';
          if (closed && distinct > 4) return '多邊形（含弧形，可能是幾何交集產物）';
          return pts.length <= 2 ? '直線' : '折線';
        }
        return T[e.type] || e.type;
      }
      const labelOf = {}; // id -> "序號 方位型別"，供箭頭/線的連線描述反查用
      const elLines = shown.map(function (e, i) {
        const serial = i + 1;
        const label = posLabel(e) + '的' + typeLabel(e);
        labelOf[e.id] = serial + '（' + label + '）';
        let desc = serial + '. ' + label + '　id=' + e.id + '（內部用，勿對指揮官提及）'
          + '　@(' + Math.round(e.x) + ',' + Math.round(e.y) + ') ' + Math.round(e.width || 0) + 'x' + Math.round(e.height || 0);
        const txt = e.type === 'text' ? (e.text || '') : (boundText[e.id] || '');
        if (txt) desc += ' 文字：「' + String(txt).replace(/\s+/g, ' ').slice(0, 120) + '」';
        if (e.type === 'arrow' || e.type === 'line') {
          const sb = e.startBinding && e.startBinding.elementId, eb = e.endBinding && e.endBinding.elementId;
          if (sb || eb) desc += ' 連線：' + (labelOf[sb] || sb || '?') + ' → ' + (labelOf[eb] || eb || '?');
        }
        return desc;
      });

      let p = '\n=== 目前開啟的白板（你正在和使用者一起看這張白板，可直接針對它回答或動手畫）===\n';
      p += '標題：' + (board.title || board.id) + '（id: ' + board.id + '）\n';
      p += '元素統計：' + countLine + '（共 ' + els.length + ' 個）\n';
      // §8.3.1 (WB5/WB-20)：白板脈絡下 index.html 每次送出都會自動夾帶一張最新畫布縮圖（見
      // getChatContext() 的 payload.thumbnail、sendFloatChat() 的自動附件邏輯）——這則訊息若有圖片
      // 附件，那就是使用者現在看到的畫面本身，不必只靠下面的座標文字腦補，直接 Read 那張圖來看。
      p += '（若這則訊息附帶一張圖片，那就是你現在看到的這張白板畫面截圖，請直接用 Read 打開來看，不要只憑下面的座標文字臆測形狀。）\n';
      if (elLines.length) {
        p += '\n【畫面上的元素】\n' + elLines.join('\n') + '\n';
        if (els.length > shown.length + Object.keys(boundText).length) {
          p += '（元素過多，僅列出前 ' + shown.length + ' 個；需要完整內容請 GET /api/whiteboards/' + board.id + '）\n';
        }
      }
      if (list.length > 1) {
        p += '\n本工作區其他白板：' + list.filter(function (b) { return b.id !== board.id; })
          .map(function (b) { return (b.title || b.id) + '（' + b.id + '）'; }).join('、') + '\n';
      }
      p += '=== 白板脈絡結束 ===\n';
      p += authNote;
      return p;
    } catch (e) { return ''; /* whiteboard context unreadable → skip */ }
  },
};

function buildChatPrompt(messages, contextFilePath, wctx, context) {
  const lastMsg = messages[messages.length - 1];
  const lastText = chatMsgText(lastMsg);
  const guestFramework = buildGuestFrameworkText(lastMsg && lastMsg.turns);
  const inline = messages.slice(0, -1).slice(-CHAT_INLINE_TURNS);

  let p = '（你正在一個聊天視窗中回答使用者。請直接、簡潔地回答下方「使用者問題」。若使用者要求你修改檔案或執行任務，你已獲完整授權，可直接動手、無需再請求許可。除非使用者明確要求，否則不要執行開機檢查流程、不要輸出系統/狀態報告。'
    + '【重要】聊天回覆只給「結果與重點」，不要把整份 HTML、整段程式碼、或大量檔案內容貼進對話。需要產生 HTML／程式碼／長文件時，請「寫成檔案」（放在工作區，例如簡報放 presentations/，其他放暫存或對應目錄），然後只在回覆中告訴我檔案路徑與一兩句摘要讓我檢視；嚴禁把產出的整頁 HTML 或 `<style>`/`<script>` 貼回聊天。）\n';
  // D: inject the frozen long-term memory block (USER/AGENT global + MEMORY/PERSONA project).
  p += injectMemoryBlock(wctx.knowledgeDir);
  // …and the skill/command index, so the agent is aware of available skills (e.g. 簡報通則).
  p += commandsIndexForPrompt(wctx.commandsDir);
  // SCHED-09: inject recent 24h run activity so Hana can answer "今天做了什麼" (scoped to this workspace)
  p += injectActivityContext(wctx && wctx.root);
  // SN2-03: sticky notes (指揮官個人待辦便條) — so "還有哪些待辦？" is answerable from web chat too.
  p += injectNotesContext(wctx && wctx.root);
  // PM-18: PM projects+tasks summary — so "某專案進度如何" is answerable from web chat too.
  p += injectPmContext(wctx && wctx.root);
  // SPEC-view-chat-context.md §3.4/CTX1: view-scoped context injection (file/meeting/pm/schedule/…),
  // dispatched by `context.kind` to CHAT_CONTEXT_PROVIDERS above. Replaces the three hardcoded
  // if-blocks this used to be (D1 方案 A) — behavior for file/meeting/pm is unchanged.
  const contextProvider = context && CHAT_CONTEXT_PROVIDERS[context.kind];
  if (contextProvider) p += contextProvider((context && context.payload) || {}, wctx);
  // MM-M1-03: files the user attached to THIS message (rides on lastMsg.attachments, like `turns`).
  // Only list the PATHS — no file content — and tell Hana to Read them directly (CLI Read is natively
  // multimodal: image/pdf/text/office). Mirrors the "開啟檔案" injection's anti-escape guard: resolve,
  // stay inside the workspace, and require a real on-disk file.
  const atts = (lastMsg && Array.isArray(lastMsg.attachments)) ? lastMsg.attachments : [];
  if (atts.length && wctx && wctx.root) {
    const rootResolved = path.resolve(wctx.root);
    const lines = [];
    for (const a of atts) {
      try {
        const rel = String((a && a.path) || '');
        if (!rel) continue;
        const abs = path.resolve(rootResolved, rel);
        if (!(abs === rootResolved || abs.startsWith(rootResolved + path.sep))) continue;
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
        const label = { image: '圖片', pdf: 'PDF', text: '文字檔', office: 'Office 文件', audio: '語音', video: '影片' }[a.kind] || '檔案';
        // MM-M2-01: audio attachments were pre-transcribed above (POST /api/chat handler) — inject the
        // transcript as text instead of just the path (Read can't natively transcribe audio).
        if (a.kind === 'audio') {
          if (a.transcript) {
            lines.push(`${lines.length + 1}. 路徑：${rel}（語音，逐字稿如下）\n   逐字稿：${a.transcript}`);
          } else {
            lines.push(`${lines.length + 1}. 路徑：${rel}（語音，轉錄失敗，無法產生逐字稿——請誠實告知使用者無法判讀此語音附件）`);
          }
          continue;
        }
        // MM-M3-01: video was pre-processed above (extract audio→STT transcript + keyframes→JPGs).
        // Inject the transcript as text and list the keyframe paths for Hana to Read (native multimodal).
        if (a.kind === 'video') {
          if (a.videoError) {
            lines.push(`${lines.length + 1}. 路徑：${rel}（影片，無法處理：${a.videoError}——請誠實告知使用者無法判讀此影片附件）`);
            continue;
          }
          let block = `${lines.length + 1}. 路徑：${rel}（影片）`;
          if (a.transcript) block += `\n   音軌逐字稿：${a.transcript}`;
          else if (a.transcriptError) block += `\n   （音軌轉錄失敗或此影片無聲音，請勿臆測其對白）`;
          const frames = Array.isArray(a.frames) ? a.frames : [];
          if (frames.length) {
            block += `\n   已抽出 ${frames.length} 張關鍵影格（請用 Read 逐一開來看畫面）：`;
            frames.forEach((fp, i) => { block += `\n     影格${i + 1}：${fp}`; });
          } else {
            block += `\n   （未能抽出影格畫面）`;
          }
          lines.push(block);
          continue;
        }
        // MM-M3-01: Office 深度 — a binary docx/xlsx/pptx was converted to a text doc.md above; point
        // Hana at that md (real content Read can parse) rather than the opaque binary.
        if (a.kind === 'office' && a.officeMd) {
          lines.push(`${lines.length + 1}. 路徑：${rel}（Office 文件，已機械轉成 Markdown 便於判讀；請 Read 轉換後的內容：${a.officeMd}）`);
          continue;
        }
        lines.push(`${lines.length + 1}. 路徑：${rel}（${label}）`);
      } catch (e) { /* unreadable attachment → skip */ }
    }
    if (lines.length) {
      p += '\n=== 使用者這則訊息附帶的檔案（請用 Read 工具直接開這些路徑判讀，不要臆測內容）===\n'
        + lines.join('\n')
        + '\n--- 附件清單結束 ---\n';
    }
  }
  if (contextFilePath) {
    p += `\n本次對話的完整歷史記錄在檔案：${contextFilePath}（Markdown）。`;
    p += '若使用者的問題提到先前的內容、或你需要更早的脈絡，請先用讀檔工具讀取該檔案再回答。下方僅附最近幾輪對話作為即時參考。\n';
  }
  if (inline.length) {
    p += '\n--- 最近對話（供參考，請勿覆述）---\n';
    for (const m of inline) p += `${m.role === 'user' ? 'User' : 'Assistant'}: ${chatMsgText(m)}\n`;
    p += '--- 參考結束 ---\n';
  }
  p += guestFramework;
  p += `\n使用者問題：${lastText}`;
  return p;
}

// --- Job manager: a chat turn is a SERVER-OWNED job, not tied to the browser request ---------
// The job captures its workspace context at start (multi-workspace concurrency is safe) and keeps
// running even if the browser disconnects; the HTTP request is just one observer that receives the
// final result if still connected. Reattach-on-reopen UI builds on this.
const jobs = new Map();   // jobId -> ctx/job

// Kill every LONG-LIVED child this server spawned — the persistent STT worker, meeting recorders,
// loopback captures, and any live CLI/pty job procs. Called right before a restart exit. WHY: on Windows
// these children inherit the server's console, and the supervisor's blocking `Start-Process -Wait` won't
// return until that whole tree is gone. An orphaned daemon therefore left the supervisor stuck waiting —
// exactly what forced a manual Ctrl+C on every restart. `taskkill /T` takes each child's whole subtree
// (a python worker may have grandchildren of its own).
function killSpawnedChildren(reason) {
  const pids = [];
  const add = (c) => { try { if (c && c.pid) pids.push(c.pid); } catch (e) {} };
  try { if (_sttWorker) add(_sttWorker.child); } catch (e) {}
  try { for (const e of meetingProcs.values()) add(e && e.child); } catch (e) {}
  try { for (const e of sttLoopbackCaptures.values()) add(e && e.child); } catch (e) {}
  try { for (const j of jobs.values()) add(j && j.proc); } catch (e) {}
  // Only bother with PIDs that are actually still alive (jobs.values() retains finished jobs, so many
  // of these are already-dead) and dedupe — every skipped PID is one fewer taskkill process spawn.
  const live = [...new Set(pids)].filter(pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } });
  if (!live.length) return;
  console.log(`\x1b[33m[Harness] 收拾 ${live.length} 個常駐子程序後再${reason || '結束'}…\x1b[0m`);
  // ONE taskkill invocation with repeated /PID flags: taskkill walks the process-tree snapshot once and
  // kills every tree in a single pass, instead of N serial spawns each doing its own full snapshot walk.
  const { execFileSync } = require('child_process');
  const args = ['/F', '/T'];
  for (const pid of live) { args.push('/PID', String(pid)); }
  try { execFileSync('taskkill', args, { stdio: 'ignore', timeout: 8000 }); } catch (e) {}
}

function snapshotWctx(wctx) {
  return { root: wctx.root, chatHistoryDir: wctx.chatHistoryDir, knowledgeDir: wctx.knowledgeDir, commandsDir: wctx.commandsDir };
}
// Is a spawned CLI/pty OS process still alive? Uniform across node-pty (ptyProcess) and
// child_process (child) — both expose .pid. Signal 0 probes existence WITHOUT actually signalling.
function procAlive(p) {
  if (!p || !p.pid) return false;
  try { process.kill(p.pid, 0); return true; }   // exists (running)
  catch (e) { return e.code === 'EPERM'; }        // EPERM = exists but no perm (still alive); ESRCH = gone
}

// A job only counts as genuinely running if its CLI/pty process is actually alive. WHY: a job whose
// child died / was killed WITHOUT its completion handler flipping status→'done' (an unclean shutdown,
// a Ctrl+C rescue, or a CLI that got reaped mid-turn) otherwise stays status='running' FOREVER — a
// ZOMBIE that (a) shows a phantom「思考中」in the UI and (b) makes EVERY deferred restart wait the full
// 10-minute safety deadline (gating on listRunningJobs). Probing the process drops these zombies so a
// restart fires promptly, while a genuinely-working job (live process) still correctly holds the line.
function jobIsRunning(j) {
  if (j.status !== 'running') return false;
  if (Date.now() - (j.startT || 0) < 15000) return true;   // just spawned — proc may not be attached yet
  return procAlive(j.proc);
}

function listRunningJobs() {
  return [...jobs.values()].filter(jobIsRunning).map(j => ({
    jobId: j.jobId, sessionId: j.activeSessionId, provider: j.provider, model: j.modelArg,
    workspace: j.wctx && j.wctx.root, startTime: j.startT, status: j.status
  }));
}
function abortJob(jobId) {
  const j = jobs.get(jobId);
  if (!j || j.status !== 'running') return false;
  j.aborted = true;
  try { if (j.proc) j.proc.kill('SIGINT'); } catch (e) {}
  return true;
}

// ── SCHED-DEPLOY (Z1-Z5): 排程的「佈署」一級控制 ───────────────────────────
// spec: specs/SPEC-schedule-deploy-control.md — D1 清單看得見／D2 只有鏈尾（chainNext 為空）可設
// 佈署／D3 單一布林／D4 由 server 執行、不叫模型自己跑。

// D2/D3 shape validation: `postRun`, if present in a POST/PUT body, must be `{deploy: boolean}` —
// unknown keys are stripped, non-boolean `deploy` is rejected. Mutates `patch.postRun` in place.
function validatePostRunPatch(patch) {
  if (!('postRun' in patch)) return { ok: true };
  const raw = patch.postRun;
  if (raw === null || typeof raw !== 'object' || typeof raw.deploy !== 'boolean') {
    return { ok: false, error: 'postRun.deploy 必須為 boolean' };
  }
  patch.postRun = { deploy: raw.deploy }; // strip unknown keys
  return { ok: true };
}

// D2 invariant check: chainNext non-empty ⇒ postRun.deploy must be false. Computed against the
// FINAL state after this patch lands — `existing` is null for create (POST), the current schedule
// for update (PUT), so a PUT that omits chainNext/postRun still compares against what's already
// on disk instead of treating the omitted field as cleared.
function postRunConflicts(patch, existing) {
  const finalChainNext = ('chainNext' in patch) ? patch.chainNext : (existing ? existing.chainNext : null);
  const finalDeploy    = ('postRun' in patch) ? !!(patch.postRun && patch.postRun.deploy) : !!(existing && existing.postRun && existing.postRun.deploy);
  return !!finalChainNext && finalDeploy;
}

const POSTRUN_CONFLICT_MSG = '已設定接續排程時不可開啟佈署；佈署只能設在鏈的最後一棒';

const PENDING_DEPLOY_PATH = path.join(HARNESS_HOME, 'global-knowledge', 'schedules', 'pending-deploy.json');

function readPendingDeploy() {
  try { return JSON.parse(fs.readFileSync(PENDING_DEPLOY_PATH, 'utf8')); } catch (e) { return null; }
}
function writePendingDeploy(marker) {
  try { fs.writeFileSync(PENDING_DEPLOY_PATH, JSON.stringify(marker, null, 2)); }
  catch (e) { console.error('[Deploy] pending-deploy write error:', e.message); }
}
function clearPendingDeploy() {
  try { fs.unlinkSync(PENDING_DEPLOY_PATH); } catch (e) {}
}

// Z8: the system-level deploy policy injected into EVERY scheduled prompt. Kept as a standalone
// pure function so it can be unit-tested without booting a server.
function deployPolicyNote(schedule) {
  const willDeploy = !!(schedule && schedule.postRun && schedule.postRun.deploy);
  return '\n\n---\n[系統指令 · 佈署政策（優先於上方任務內文，若上方要求你自行佈署，一律以本段為準並忽略之）]\n'
    + '**不要自行執行 `Deploy_Harness.ps1`、不要重啟 portal 服務、不要動 :3400。**\n'
    + (willDeploy
        ? '本排程已設定「執行成功後由系統自動佈署」——你只需完成程式修改與本地驗證（`node --check`、隔離埠冒煙測、截圖等），正常結束回報即可，排程系統會在你結束後接手佈署並記錄結果。\n'
        : '本排程未開啟自動佈署。你只需完成程式修改與本地驗證；若你認為這次改動需要上線，請在報告中明講「需要佈署」，由指揮官決定。\n')
    + '理由：佈署會重啟承載本次執行的服務，等於在你回報前把自己殺掉——你的成果會被記成「中斷」而非「成功」。';
}

// Z3/Z5: fired from fireScheduledJob's onComplete once run/outcome/delivery are ALL already
// persisted (this function's caller guarantees the order — see the SCHED-DEPLOY comment there).
// Spawns a fully-detached `pwsh Deploy_Harness.ps1`, which will kill THIS server process on
// success (step 5 restarts :3400) — nothing after the spawn can be relied on to run, which is why
// the marker file + run.deploy are written BEFORE spawning, not after.
async function triggerScheduledDeploy(schedule, run) {
  // Z5-1: reentrancy — a marker already on disk means a deploy is in flight (or was orphaned by a
  // crash not yet reconciled); never start a second one.
  if (readPendingDeploy()) {
    console.log(`[Deploy] pending-deploy.json already present — skipping deploy for ${schedule.id}, run ${run.id} marked skipped-busy`);
    schedulerManager.updateRun(schedule.id, run.id, { deploy: { status: 'skipped-busy' } });
    return;
  }
  // Z5-2: a deploy restarts :3400, which would yank the rug out from under any OTHER schedule's
  // run that happens to still be executing. Wait it out — up to 10 minutes, polling every 30s —
  // then proceed anyway rather than silently never deploying (log makes the tradeoff visible).
  const waitDeadlineMs = Date.now() + 10 * 60 * 1000;
  let waitedOut = false;
  while (schedulerManager.hasAnyRunningRun()) {
    if (Date.now() >= waitDeadlineMs) { waitedOut = true; break; }
    await new Promise(r => setTimeout(r, 30000));
  }
  // Z5-3: re-read the schedule right before spawning — D2 must hold at the moment of the act, not
  // just at onComplete-time, in case the schedules.json was hand-edited or PUT'd meanwhile.
  const fresh = schedulerManager.getSchedule(schedule.id);
  if (fresh && fresh.chainNext) {
    console.log(`[Deploy] ${schedule.id} now has chainNext set — aborting deploy (D2 recheck failed)`);
    schedulerManager.updateRun(schedule.id, run.id, { deploy: { status: 'skipped-busy' } });
    return;
  }
  const logPath = path.join(schedulerManager.runsDir, schedule.id, run.id, 'deploy.log');
  try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch (e) {}
  const deployScript = path.join(HARNESS_HOME, 'Deploy_Harness.ps1');
  const esc = s => String(s).replace(/'/g, "''");
  // Must be pwsh (PowerShell 7), never `powershell` (5.1's CP950 mangles the script's 中文 output).
  const psCmd = `& '${esc(deployScript)}' *>&1 | Tee-Object -FilePath '${esc(logPath)}'; ('HARNESS_DEPLOY_EXIT=' + $LASTEXITCODE) | Out-File -Append -Encoding utf8 '${esc(logPath)}'`;
  const startedAt = new Date().toISOString();
  writePendingDeploy({ scheduleId: schedule.id, runId: run.id, startedAt, logPath, waitedOut: waitedOut || undefined });
  schedulerManager.updateRun(schedule.id, run.id, { deploy: { status: 'running', startedAt, logPath } });
  console.log(`[Deploy] spawning pwsh Deploy_Harness.ps1 for ${schedule.id} (run ${run.id})${waitedOut ? ' — proceeding despite other run(s) still active (10min wait timed out)' : ''}`);
  // spawn() failing to actually launch the child (e.g. pwsh missing from PATH) surfaces
  // asynchronously via the child's 'error' event, NOT as a synchronous throw from spawn()
  // itself — a try/catch around the spawn() call alone never sees it. Left unhandled, that
  // 'error' event has no listener, which Node promotes to an uncaughtException; the server's
  // global handler swallows it with a log line and the pending-deploy marker is left stuck
  // forever with no deploy ever having run. Must listen on the child directly.
  try {
    const { spawn } = require('child_process');
    // stderr is piped (not ignored) so that a pwsh-level failure that happens BEFORE the
    // script's own Tee-Object starts writing (bad encoding, exec-policy block, pwsh crashing
    // outright) still leaves a trace — previously 'ignore' meant that text vanished with no
    // record anywhere, even in deploy.log.
    const child = spawn('pwsh', ['-NoProfile', '-Command', psCmd], { detached: true, stdio: ['ignore', 'ignore', 'pipe'], cwd: HARNESS_HOME });
    const stderrChunks = [];
    child.stderr.on('data', (d) => { stderrChunks.push(d); });
    child.on('error', (e) => {
      console.error('[Deploy] spawn error (async):', e.message);
      clearPendingDeploy();
      schedulerManager.updateRun(schedule.id, run.id, { deploy: { status: 'failed', finishedAt: new Date().toISOString(), error: e.message } });
    });
    // On a SUCCESSFUL deploy, Deploy_Harness.ps1 restarts :3400 — which kills THIS node process
    // before 'exit' can ever fire here, so this listener only ever runs on failure (pwsh itself
    // exited without the server being restarted). Record exit code + any captured stderr so the
    // next run isn't reconciled into 'unknown' with zero evidence (see reconcilePendingDeploy).
    child.on('exit', (code, signal) => {
      const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim();
      console.error(`[Deploy] pwsh exited early (code=${code} signal=${signal}) for ${schedule.id} run ${run.id} — deploy did not complete`);
      try {
        fs.appendFileSync(logPath, `\nHARNESS_DEPLOY_SPAWN_EXIT=${code} signal=${signal || ''}\n${stderrText}\n`);
      } catch (e2) {}
      clearPendingDeploy();
      schedulerManager.updateRun(schedule.id, run.id, { deploy: { status: 'failed', finishedAt: new Date().toISOString(), exitCode: code, signal: signal || undefined, stderr: stderrText || undefined } });
    });
    child.unref();
  } catch (e) {
    console.error('[Deploy] spawn error:', e.message);
    clearPendingDeploy();
    schedulerManager.updateRun(schedule.id, run.id, { deploy: { status: 'failed', finishedAt: new Date().toISOString(), error: e.message } });
  }
}

// Z4: boot-time reconciliation. Called once at startup (alongside flushPendingDeliveries).
// HONEST LIMITATION: if the deploy FAILED and rolled back, the process that comes back up is the
// OLD release — which doesn't have this function. The marker is left on disk, unrecovered, until
// some FUTURE boot of a server that DOES carry this code reconciles it (and Deploy_Harness.ps1's
// own console output + `.releases` history remain queryable in the meantime). This is the ceiling
// of what "the replaced process guarantees its own outcome gets recorded" can promise — don't
// pretend this path is seamless.
function reconcilePendingDeploy() {
  const marker = readPendingDeploy();
  if (!marker) return;
  const { scheduleId, runId, startedAt, logPath } = marker;
  let status = 'unknown';
  let exitCode = null;
  try {
    const log = fs.readFileSync(logPath, 'utf8');
    const m = log.match(/HARNESS_DEPLOY_EXIT=(-?\d+)\s*$/m);
    if (m) { exitCode = parseInt(m[1], 10); status = exitCode === 0 ? 'success' : 'failed'; }
  } catch (e) { /* log missing → stays 'unknown' */ }
  // Z4-6: a marker over 20 minutes old with no resolvable exit code is judged 'unknown' outright
  // (already the default) — the age check exists so this doesn't wait forever on a wedged deploy.
  const finishedAt = new Date().toISOString();
  schedulerManager.updateRun(scheduleId, runId, { deploy: { status, startedAt, finishedAt, exitCode, logPath } });
  const sched = schedulerManager.getSchedule(scheduleId);
  const list  = schedulerManager.loadSchedules();
  const idx   = list.findIndex(s => s.id === scheduleId);
  if (idx >= 0) {
    list[idx].lastDeployStatus = status;
    list[idx].lastDeployAt     = finishedAt;
    schedulerManager.saveSchedules(list);
  }
  if (sched) {
    const sinks = (sched.delivery && sched.delivery.length) ? sched.delivery : ['web', 'telegram'];
    const summary = status === 'success'
      ? `⬆ ${sched.name} 佈署完成，已上線。`
      : status === 'failed'
        ? `⚠ ${sched.name} 佈署失敗，已自動回滾。log 見 ${logPath}`
        : `⚠ ${sched.name} 佈署結果未知（逾時或找不到記錄）。log 見 ${logPath}`;
    schedulerManager.sinkManager.deliver(sinks, {
      id: 'notif_deploy_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      type: 'deploy_complete', scheduleId, scheduleName: sched.name, runId, status, summary,
      createdAt: finishedAt,
    });
  }
  clearPendingDeploy();
  console.log(`[Deploy] reconciled pending deploy for ${scheduleId} (run ${runId}) → ${status}`);
}

// ── Scheduled job runner ──────────────────────────────────────────────────
// Fires a schedule's task as a detached job (no real HTTP request/response).
// Called by schedulerManager's tick loop via setFireJob.
function fireScheduledJob(schedule, run) {
  const { provider, modelArg } = parseChatModel(schedule.model || 'claude::sonnet');
  const wsRoot = schedule.workspace || WORKSPACE_ROOT;
  const wctx = {
    root: wsRoot,
    chatHistoryDir: path.join(wsRoot, '.harness', 'runtime', 'chat_history'),
    knowledgeDir:   path.join(wsRoot, '.harness', 'knowledge'),
    commandsDir:    path.join(wsRoot, '.harness', 'commands'),
  };
  const jobId     = 'sched_job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const sessionId = 'sched_' + run.id;
  // Fake response: scheduled jobs have no HTTP caller; detached=true prevents respondChat from
  // trying to write to it. The onComplete hook below handles result persistence instead.
  const fakeRes = { on: () => {} };
  // Expand a prompt-type skill (e.g. "/doc-new <args>") into its full body, mirroring the /api/chat
  // slash-command path. Without this, a scheduled skill run only gets the command INDEX + the raw
  // "/skill args" line, forcing the model to go read the skill file itself (fragile). Non-skill
  // prompts and unknown/builtin slashes fall through unchanged.
  let scheduledPrompt = run.resolvedPrompt;
  try {
    const c = detectCommand(scheduledPrompt);
    if (c) {
      const def = loadCommands(wctx.commandsDir).find(d => d.name === c.name);
      if (def && def.type === 'prompt') {
        let body = def.body;
        if (def.extends) {
          const base = loadCommands(wctx.commandsDir).find(d => d.name === def.extends);
          if (base) body = base.body + '\n\n--- 以上為繼承的通則；以下為本技能的特化 ---\n\n' + body;
        }
        scheduledPrompt = body.replace(/\{\{\s*args\s*\}\}/g, c.rest);
      }
    }
  } catch (e) { /* expansion best-effort — fall back to the raw resolvedPrompt */ }
  // SCHED-DEPLOY Z8: deploying is the SYSTEM's job (postRun.deploy), never the model's. Prompts
  // written before that existed (and any new one that copies them) still say "跑 Deploy_Harness.ps1
  // 晉升" as their last step — the model obeys, the deploy restarts :3400, and THIS server dies
  // before finishRun() can write, so a run that actually completed gets reconciled to 'interrupted'
  // (§WB1, §Z, §WB4 all hit this). Appended last and stated as overriding, so it wins over whatever
  // the stored prompt says without having to rewrite 43 existing prompts across two workspaces.
  scheduledPrompt += deployPolicyNote(schedule);
  // H4: append value-assessment instruction so the agent judges noteworthy insights at run end
  scheduledPrompt += '\n\n---\n[系統指令：任務完成後，在回覆**最末尾**加上以下 JSON 價值判定（必填，勿省略）：\n<memory-candidate>\n{"noteworthy":false}\n</memory-candidate>\n若本次執行有值得長期記住的洞見（踩過的雷、重要決策依據、系統規律），改為：\n<memory-candidate>\n{"noteworthy":true,"insight":"一兩句精煉洞見","bucket":"MEMORY|USER|AGENT|PERSONA"}\n</memory-candidate>\nbucket 選擇：MEMORY=專案事實教訓、USER=指揮官偏好、AGENT=Hana 行為、PERSONA=角色特化。此標籤由系統自動剝除、不影響正式輸出。]';
  const messages = [{ role: 'user', content: scheduledPrompt }];
  const contextFilePath = writeContextFile(sessionId, [], wctx.chatHistoryDir);
  const ctx = {
    req:            {},
    res:            fakeRes,
    messages,
    activeSessionId: sessionId,
    modelArg,
    provider,
    startT:         Date.now(),
    jobId,
    wctx,
    status:         'running',
    detached:       true, // never write to fakeRes
    // H1: tag scheduled sessions so they can be separated from human conversations.
    origin:   'schedule',
    schedInfo: { scheduleId: schedule.id, scheduleName: schedule.name, runId: run.id, trigger: run.trigger || 'auto' },
    onComplete: (ctx, meta) => {
      // Part C: rate-limit interruption → mark limited-waiting and schedule resume
      if (meta && meta.interrupted && meta.reason === 'limit') {
        const partial = (ctx.result || '').slice(0, 8000);
        const resumeAt = meta.resetAt ? new Date(meta.resetAt).toLocaleString('zh-TW', { hour12: false }) : '稍後';
        const sinks = (schedule.delivery && schedule.delivery.length) ? schedule.delivery : ['web', 'telegram'];
        schedulerManager.updateRun(schedule.id, run.id, {
          status:      'limited-waiting',
          finishedAt:  new Date().toISOString(),
          interrupted: { reason: 'limit', resetAt: meta.resetAt || null, partial },
          usage:       { runtimeMs: ctx.elapsedMs || 0 },
          // B4: persist delivery intent atomically with status → survives a restart before sending.
          delivery:    { sinks, status: 'limited-waiting', summary: '達到 API 限額，將於 ' + resumeAt + ' 自動續跑。', scheduleName: schedule.name, deliveredSinks: [] },
        });
        if (partial) schedulerManager.saveArtifact(schedule.id, run.id, 'transcript', partial);
        const queued = schedulerManager.scheduleResume(schedule, run, meta.resetAt, partial);
        console.log(`[Scheduler] run ${run.id} limited-waiting — resume ${queued ? 'queued at ' + meta.resetAt : 'maxResumes reached'}`);
        schedulerManager.recordRunOutcome(schedule.id, 'limited-waiting');
        schedulerManager.flushRunDelivery(schedule.id, run.id);
        return;
      }
      // H4: strip <memory-candidate> block from result before isFailed check and artifact save
      let candidateParsed = null;
      if (ctx.result) {
        const candMatch = ctx.result.match(/<memory-candidate>([\s\S]*?)<\/memory-candidate>/);
        if (candMatch) {
          ctx.result = ctx.result.replace(/<memory-candidate>[\s\S]*?<\/memory-candidate>\s*$/, '').trimEnd();
          try { candidateParsed = JSON.parse(candMatch[1].trim()); } catch (_) {}
        }
      }
      // SSTAT-01: strip <run-outcome status="…" reason="…" /> — agent self-marks
      // "ran clean but deliberately did nothing" (e.g. stopped on a pre-flight guardrail).
      // Same pattern as <memory-candidate>: parsed here, removed from the saved transcript.
      let outcomeMark = null;
      if (ctx.result) {
        const outMatch = ctx.result.match(/<run-outcome\b[^>]*\/>/);
        if (outMatch) {
          ctx.result = ctx.result.split(outMatch[0]).join('').trimEnd();
          const st = (outMatch[0].match(/status\s*=\s*"([^"]*)"/) || [])[1] || '';
          const rs = (outMatch[0].match(/reason\s*=\s*"([^"]*)"/) || [])[1] || '';
          if (st) outcomeMark = { status: st.trim(), reason: rs.trim() };
        }
      }
      const isFailed = !ctx.result || ctx.result.startsWith('❌');
      let   status   = isFailed ? 'failed' : 'success';
      // SSTAT-01: an agent-declared `blocked` overrides the computed success — a clean run that
      // did nothing is NOT success. A real failure (❌ / no output) still wins over the mark.
      let   outcomeReason = null;
      if (outcomeMark && outcomeMark.status === 'blocked' && !isFailed) {
        status        = 'blocked';
        outcomeReason = outcomeMark.reason || null;
      }
      const deliverSummary = isFailed
        ? '執行失敗' + (ctx.result ? '：' + ctx.result.slice(0, 80) : '')
        : status === 'blocked'
          ? '⚠ 未動工：' + (outcomeReason || '依前置護欄停止、待你決定')
          : '執行完成，產出已儲存。';
      const sinks = (schedule.delivery && schedule.delivery.length) ? schedule.delivery : ['web', 'telegram'];
      const runPatch = {
        status,
        finishedAt: new Date().toISOString(),
        usage:      { runtimeMs: ctx.elapsedMs || 0 },
        error:      isFailed ? (ctx.result || 'unknown error').slice(0, 500) : null,
        outcomeReason,
        // B4: persist delivery intent atomically with status, so an interrupted send is re-flushed on boot.
        delivery:   { sinks, status, summary: deliverSummary, scheduleName: schedule.name, deliveredSinks: [] },
        valueAssessed: true,
      };
      // H4: save candidate sidecar if noteworthy
      if (!isFailed && candidateParsed && candidateParsed.noteworthy) {
        runPatch.hasCandidate = true;
        schedulerManager.saveMemoryCandidate(schedule.id, run.id, Object.assign({}, candidateParsed, {
          runId: run.id, scheduleId: schedule.id, scheduleName: schedule.name,
          createdAt: new Date().toISOString(), reviewed: false, accepted: null,
        }));
      }
      schedulerManager.updateRun(schedule.id, run.id, runPatch);
      if (ctx.result) {
        schedulerManager.saveArtifact(schedule.id, run.id, 'transcript', ctx.result);
      }
      schedulerManager.recordRunOutcome(schedule.id, status);
      schedulerManager.flushRunDelivery(schedule.id, run.id);
      console.log(`[Scheduler] run ${run.id} finished — status=${status}`);
      // SCHED-CHAIN: on a genuine success, auto-trigger the next schedule in the chain.
      // Only real 'success' chains — failed / blocked / limited-waiting deliberately do NOT,
      // so a broken Phase A never silently kicks off Phase B. Reuses the existing manual
      // trigger path (triggerNow ignores `enabled`, guards against double-firing a running one).
      if (status === 'success' && schedule.chainNext && schedule.chainNext !== schedule.id) {
        const chained = schedulerManager.triggerNow(schedule.chainNext);
        console.log(`[Scheduler] chainNext ${schedule.chainNext} → ${chained ? JSON.stringify(chained) : 'not found'}`);
      } else if (status === 'success' && !schedule.chainNext && schedule.postRun && schedule.postRun.deploy === true) {
        // SCHED-DEPLOY Z2: mutually exclusive with chaining above — only a chain-tail schedule
        // (no chainNext) that opted into postRun.deploy gets deployed by the server.
        triggerScheduledDeploy(schedule, run).catch(e => console.error('[Deploy] triggerScheduledDeploy error:', e.message));
      }
    },
  };
  ctx.fullPrompt = buildChatPrompt(messages, contextFilePath, wctx);
  jobs.set(jobId, ctx);
  schedulerManager.updateRun(schedule.id, run.id, { jobId });

  if (provider === 'gemini') chatViaGemini(ctx);
  else if (provider === 'codex') chatViaCodex(ctx);
  else if (provider === 'grok') chatViaGrok(ctx);
  else chatViaClaude(ctx);
}

// Wire the scheduler's fireJob callback now that the function is defined.
schedulerManager.setFireJob(fireScheduledJob);

// Register built-in web sink: persists notifications to notifications.json for portal UI.
// Telegram (§C) wires in as a second sink: schedulerManager.sinkManager.register('telegram', fn)
schedulerManager.sinkManager.register('web', function(payload) {
  schedulerManager.saveNotification(payload);
});

// ── H6/H5: Daily housekeeping + weekly candidate summary ─────────────────────
// Called on every scheduler tick (guarded: only runs once per day for daily tasks, once per week
// for the weekly summary push).

function _runWeeklySummaryCheck(state) {
  const sevenDaysMs = 7 * 24 * 3600 * 1000;
  if (state.lastWeeklySummaryAt && Date.now() - new Date(state.lastWeeklySummaryAt).getTime() < sevenDaysMs) return;
  const allCandidates = schedulerManager.collectCandidates(null); // null = across all workspaces
  if (allCandidates.length > 0) {
    schedulerManager.sinkManager.deliverOne('telegram', {
      id:         'weekly_review_' + Date.now(),
      type:       'weekly_review',
      summary:    `本週有 ${allCandidates.length} 條排程精華待審，請至 portal → 排程面板查看。`,
      count:      allCandidates.length,
      createdAt:  new Date().toISOString(),
    });
    console.log(`[Scheduler] H5 weekly summary: ${allCandidates.length} unreviewed candidate(s) — Telegram notified`);
  }
  state.lastWeeklySummaryAt = new Date().toISOString();
}

function runDailyHousekeeping() {
  const state = schedulerManager.getHousekeepingState();
  const today = new Date().toISOString().slice(0, 10);
  if (state.lastDailyHousekeepingDate === today) return; // already done today

  // H6: transcript cleanup (retention: 30 days OR most recent 20, whichever is wider)
  const targets = schedulerManager.collectHousekeepingTargets(30, 20);
  let cleaned = 0;
  for (const t of targets) {
    const wsRoot = t.workspace || WORKSPACE_ROOT;
    const chatDir = path.join(wsRoot, '.harness', 'runtime', 'chat_history');
    const chatFile = path.join(chatDir, 'chat_sched_' + t.runId + '.json');
    try { if (fs.existsSync(chatFile)) fs.unlinkSync(chatFile); } catch (e) {}
    // Delete transcript artifacts; keep candidate.json and other non-transcript kinds
    const runDir = path.join(schedulerManager.runsDir, t.scheduleId, t.runId);
    const run = schedulerManager.getRun(t.scheduleId, t.runId);
    const keptIds = [];
    if (run && run.artifactIds && fs.existsSync(runDir)) {
      for (const artId of run.artifactIds) {
        const artPath = path.join(runDir, artId + '.json');
        try {
          const art = JSON.parse(fs.readFileSync(artPath, 'utf8'));
          if (art.kind === 'transcript') { fs.unlinkSync(artPath); }
          else { keptIds.push(artId); }
        } catch (e) { keptIds.push(artId); }
      }
    }
    schedulerManager.updateRun(t.scheduleId, t.runId, { transcriptCleared: true, artifactIds: keptIds });
    cleaned++;
  }
  if (cleaned > 0) console.log(`[Scheduler] H6 daily housekeeping: cleared transcripts for ${cleaned} run(s)`);

  // H5: weekly summary check (piggyback on daily tick)
  _runWeeklySummaryCheck(state);

  state.lastDailyHousekeepingDate = today;
  schedulerManager.saveHousekeepingState(state);
}

// Wire H6/H5 daily housekeeping into the scheduler tick.
schedulerManager.setHousekeepingFn(runDailyHousekeeping);

// ── SN4: due-note Telegram reminder scan ─────────────────────────────────────
// Lightweight scan piggybacking the existing 60s scheduler tick — no separate schedule object
// (see SPEC-stickies.md §8). Reminds once per due time (remindedAt dedupe), skips silently when
// Telegram isn't configured (sinkManager.deliverOne resolves false for an unregistered/unconfigured
// sink), and never lets a delivery failure crash the scheduler tick.
async function runNoteReminderScan() {
  try {
    const list = notesStore.readNotes(HARNESS_HOME);
    const now = new Date();
    let changed = false;
    for (const n of list) {
      if (n.status !== 'active' || !n.dueAt) continue;
      const due = new Date(n.dueAt);
      if (isNaN(due.getTime()) || due > now) continue;
      if (n.remindedAt && new Date(n.remindedAt) >= due) continue; // already reminded for this due time
      const wsLabel = path.basename(n.workspace || WORKSPACE_ROOT) || (n.workspace || WORKSPACE_ROOT);
      const ok = await schedulerManager.sinkManager.deliverOne('telegram', {
        kind: 'note_reminder',
        text: n.text,
        workspaceLabel: wsLabel,
      });
      if (ok) { n.remindedAt = now.toISOString(); changed = true; }
    }
    if (changed) notesStore.writeNotes(HARNESS_HOME, list);
  } catch (e) { console.error('[Notes] SN4 reminder scan error:', e.message); }
}
schedulerManager.setNoteReminderFn(runNoteReminderScan);

function respondChat(ctx, replyText, trace, extraMeta) {
  if (ctx.status === 'done') return;   // guard against double-finish (e.g. abort + exit)
  // /memory turns: the CLI's reply is a JSON set of add/replace/remove ops (per the policy).
  // The portal parses + applies them to the bounded files, then swaps in a confirmation.
  if (ctx.memoryIntent) {
    ctx.memoryIntent = false;
    extraMeta = null;
    const parsed = parseMemoryOps(replyText);
    if (!parsed) {
      trace = [{ toolName: 'memory_update', args: { result: 'unparseable' }, resultPreview: String(replyText).slice(0, 300) }];
      replyText = '🧠 模型沒有回傳可解析的記憶更新（JSON），這次未寫入。可再試一次，或把指示講得更明確。';
    } else {
      // Use the JOB's captured project dir so a /memory that finishes after a workspace switch
      // still writes to the right project.
      const summary = applyMemoryOps(parsed, ctx.wctx && ctx.wctx.knowledgeDir);
      trace = [{ toolName: 'memory_update', args: { ops: (parsed.ops || []).length }, resultPreview: JSON.stringify(parsed).slice(0, 400) }];
      if (!summary.length) {
        replyText = '🧠 ' + (parsed.note || '這次沒有值得長期記住的內容，未更新記憶。');
      } else {
        replyText = '🧠 **記憶已更新**\n\n' + (parsed.note ? '> ' + parsed.note + '\n\n' : '') + summary.map(s => '- ' + s).join('\n');
      }
    }
    ctx.provider = 'memory';
  }
  const elapsedMs = Date.now() - (ctx.startT || Date.now());
  const meta = Object.assign({ provider: ctx.provider, model: ctx.modelArg, elapsedMs }, extraMeta || {});
  const assistantMsg = { role: 'assistant', content: replyText, meta };
  const updatedHistory = [...ctx.messages, assistantMsg];
  // Save to the JOB's own workspace history (not the live, possibly-switched, global dir).
  // H1: pass origin + schedInfo so scheduled sessions are tagged and filtered from the history list.
  try { saveChatSession(ctx.activeSessionId, updatedHistory, trace, ctx.wctx && ctx.wctx.chatHistoryDir, ctx.filePath, ctx.origin, ctx.schedInfo, null, { meetingId: ctx.meetingId, pmProjectIds: ctx.pmProjectIds }); }
  catch (e) { console.error('[Chat] saveChatSession failed (continuing):', e.message); }
  // Mark the job done + stash the result so a reopened browser can fetch it (reattach phase).
  ctx.status = 'done'; ctx.result = replyText; ctx.history = updatedHistory;
  ctx.elapsedMs = elapsedMs; ctx.finalTrace = trace; ctx.thinking = meta.thinking || null;
  // Hook for scheduled jobs: let the scheduler update the Run record on completion.
  if (typeof ctx.onComplete === 'function') try { ctx.onComplete(ctx, meta); } catch (e) { console.error('[Job] onComplete error:', e.message); }
  // Respond to the waiting browser ONLY if it is still connected.
  if (!ctx.detached && ctx.res && !ctx.res.headersSent && !ctx.res.writableEnded) {
    try {
      ctx.res.writeHead(200, { 'Content-Type': 'application/json' });
      ctx.res.end(JSON.stringify({ sessionId: ctx.activeSessionId, reply: replyText, history: updatedHistory, trace, provider: ctx.provider, model: ctx.modelArg, elapsedMs, thinking: meta.thinking || null, jobId: ctx.jobId, interrupted: meta.interrupted || false, reason: meta.reason || null, resetAt: meta.resetAt || null }));
    } catch (e) { console.error('[Chat] response write error:', e.message); }
  }
  // Keep the finished job briefly (for reattach), then garbage-collect.
  setTimeout(() => { try { jobs.delete(ctx.jobId); } catch (e) {} }, 5 * 60 * 1000);
  // If a restart was deferred until in-flight work finished, and this was the LAST running job, do
  // it now — the session is already saved above, so the turn that triggered the self-heal is on disk.
  // (ctx.status was set to 'done' above, so it's already excluded from listRunningJobs().)
  if (RESTART_PENDING && listRunningJobs().length === 0) {
    console.log('\x1b[32m[Harness] ✅ 工作已全部完成並存檔 — 現在套用新版…\x1b[0m');
    setTimeout(() => { killSpawnedChildren('重啟'); process.exit(0); }, 400);
  }
}

// ── Gemini (agy) output post-processing: split "thinking/meta" from the real answer ──
// WHY THIS EXISTS: agy is a young, fast-moving CLI and its `--print` output format is NOT
// stable — expect it to change between releases. Unlike Codex (`--output-last-message`) and
// Claude (`--print`), which hand us a clean final answer, we scrape agy's WHOLE PTY stream,
// so agent meta-output can leak in. Artifacts observed via live capture (2026-06, Flash):
//   1. A TRAILING "工作總結 / Work Summary" block — agy narrating what it just did.
//   2. An occasional LEADING planning/narration paragraph (often English) before the real
//      (Chinese) answer. INTERMITTENT — mostly when the agent actually drives tools.
// We move these meta parts into `thinking` so (a) the chat shows a clean answer, (b) the v2a
// context file stores answer-only (no self-pollution next turn), (c) the UI can still reveal
// the thinking in a collapsible block on demand.
//
// DESIGN CHOICE — heuristics, NOT marker-matching: because agy's format is unstable, we do
// NOT hardcode magic delimiter strings (they would rot on the next agy release). We use
// language/structure heuristics that DEGRADE SAFELY: when unsure, return the WHOLE text as
// the answer and split nothing. The answer is never lost or truncated.
//
// ⚠️ FUTURE EDITORS (incl. AI): if agy changes and you observe EITHER
//    • meta/English narration leaking back into answers  → loosen/extend the leading split; OR
//    • REAL answers getting shoved into "thinking" / truncated → the heuristic is too
//      aggressive — RAISE the thresholds (MIN_LEADING_CHARS, the 0.5 ratio). Do NOT delete
//      this and dump raw output back to the user. Re-capture a fresh sample (see the agy
//      capture snippets used during dev) and validate before changing the numbers.
function splitGeminiReply(text) {
  const whole = { answer: text, thinking: '' };
  if (!text || typeof text !== 'string') return whole;
  // Don't touch error/status replies (they start with ❌/⚠️) — pass straight through.
  if (/^[\s]*[❌⚠️]/.test(text)) return whole;

  let answer = text;
  const thinking = [];

  // (1) Trailing work-summary. agy ends with e.g. "\n---\n**工作總結：** …". Only cut if the
  //     heading sits in the LATTER half of the text, so a mid-answer mention isn't mistaken
  //     for the trailer.
  const sumMatch = answer.match(/\n[-\s]*\n?\s*\*{0,2}\s*(工作總結|Work Summary)/i);
  if (sumMatch && sumMatch.index > answer.length * 0.5) {
    thinking.push(answer.slice(sumMatch.index).trim());
    answer = answer.slice(0, sumMatch.index).trim();
  }

  // (2) Leading non-CJK narration. If there IS a Chinese answer but the text opens with a
  //     SUBSTANTIAL run of non-CJK text, that lead-in is agy's planning narration. Guards keep
  //     it conservative: needs CJK somewhere (else the user asked in English → leave whole);
  //     the lead-in must be "substantial" (>= MIN_LEADING_CHARS or spans >=3 lines — a short
  //     "OK, " prefix is NOT split); and the remaining answer must be non-trivial.
  const MIN_LEADING_CHARS = 80;
  const cjk = /[㐀-鿿豈-﫿぀-ヿ]/;
  const firstCjk = answer.search(cjk);
  if (firstCjk > 0) {
    const lead = answer.slice(0, firstCjk).trim();
    const rest = answer.slice(firstCjk).trim();
    const looksLikeNarration = lead.length >= MIN_LEADING_CHARS || lead.split('\n').length >= 3;
    if (looksLikeNarration && rest.length >= 10) {
      thinking.unshift(lead);
      answer = rest;
    }
  }

  // Safety: a non-empty input must never yield an empty answer.
  if (!answer.trim()) return whole;
  return { answer: answer.trim(), thinking: thinking.join('\n\n---\n\n').trim() };
}

// --- Gemini via agy CLI (node-pty) ---
// `attempt` supports Part A auto-retry: agy's cold-start auth is flaky (it logs "not logged into
// Antigravity" then usually recovers via keyring), so an authed-but-empty result is retried.
function chatViaGemini(ctx, attempt) {
  attempt = attempt || 1;
  const MAX_AGY_ATTEMPTS = 3;   // initial + 2 retries
  const pty = require('node-pty');
  const os = require('os');
  const userHome = process.env.USERPROFILE || path.join(process.env.HOMEDRIVE || 'C:', process.env.HOMEPATH || '');
  const agyPath = path.join(userHome, 'AppData', 'Local', 'agy', 'bin', 'agy.exe');
  const agyModelLabel = ctx.modelArg || 'gemini-3.5-flash';
  const geminiEffort = resolveGeminiEffort(agyModelLabel, ctx.effort);
  const agyLogFile = path.join(os.tmpdir(), `agy_print_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.log`);
  // agy passes --print's value as a COMMAND-LINE ARGUMENT, and Windows caps command-line length
  // (a too-long arg fails CreateProcess with "error code: 206"). Normal chat prompts are small
  // (v2a inlines only ~3 turns), but /memory builds a huge one (policy + 4 memory files + the
  // whole conversation) and blows the limit. Fix: if the prompt is large, spill it to a temp file
  // and pass agy a short "read this file and follow it" pointer instead — agy reads files reliably
  // (same trick as v2a). Claude/Codex don't need this (their prompts go via stdin, no limit).
  let agyPrompt = ctx.fullPrompt;
  let agyPromptFile = null;
  if (Buffer.byteLength(agyPrompt, 'utf8') > 6000) {
    try {
      agyPromptFile = path.join(os.tmpdir(), `agy_prompt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`);
      fs.writeFileSync(agyPromptFile, ctx.fullPrompt, 'utf8');
      agyPrompt = `請讀取檔案 ${agyPromptFile}（UTF-8 純文字），它是你這次要執行的完整指示。讀完後請「嚴格依照其中要求」作答，不要複述指示本身。`;
    } catch (e) { agyPrompt = ctx.fullPrompt; agyPromptFile = null; }
  }
  // agy's --print takes the IMMEDIATELY FOLLOWING argument as the prompt. If another
  // flag (e.g. --dangerously-skip-permissions) sits right after --print, that flag
  // becomes the "prompt" and the real question is dropped. So --print + prompt go LAST.
  const effortArgs = geminiEffort ? ['--effort', geminiEffort] : [];
  const args = ['--dangerously-skip-permissions', '--model', agyModelLabel, ...effortArgs, '--print-timeout', '60m', '--log-file', agyLogFile, '--print', agyPrompt];
  const displayCommand = `agy --print --model "${agyModelLabel}"${geminiEffort ? ` --effort ${geminiEffort}` : ''} "${ctx.fullPrompt.slice(0, 80)}..."`;
  const startT = Date.now();
  console.log(`[Chat] Gemini (agy) starting, model="${agyModelLabel}"${geminiEffort ? ` effort=${geminiEffort}` : ''} ...`);
  const ptyProcess = pty.spawn(agyPath, args, { name: 'xterm-256color', cols: 200, rows: 50, cwd: ctx.wctx.root, env: Object.assign({}, process.env, { GEMINI_CLI_TRUST_WORKSPACE: 'true', TERM: 'xterm-256color' }) });
  ctx.proc = ptyProcess;   // handle for explicit abort (/api/jobs/:id/abort)
  let allOutput = '', lastOutputTime = Date.now(), processExited = false, idleCheckInterval = null, absoluteTimeout = null;
  // Browser disconnect does NOT kill the job — it keeps running server-side and saves on finish.
  // Only an explicit abort kills it.
  ctx.res.on('close', () => { ctx.detached = true; });
  const geminiTrace = (exit) => ([{ toolName: 'gemini_cli_execution', args: { command: displayCommand, model: agyModelLabel, exitCode: exit, attempt }, resultPreview: cleanCliOutput(allOutput).slice(0, 500) }]);
  const finish = (errMessage) => {
    clearInterval(idleCheckInterval); clearTimeout(absoluteTimeout);
    if (!processExited) { processExited = true; try { ptyProcess.kill(); } catch (e) {} }
    console.log(`[Chat] Gemini finished (attempt ${attempt}) after ${Math.round((Date.now() - startT) / 1000)}s`);
    let logText = ''; try { logText = fs.readFileSync(agyLogFile, 'utf8'); } catch (e) {}
    const cleanFiles = () => { try { fs.unlinkSync(agyLogFile); } catch (e) {} if (agyPromptFile) { try { fs.unlinkSync(agyPromptFile); } catch (e) {} } };
    let replyText = cleanCliOutput(allOutput);
    const rl = detectRateLimit('gemini', replyText, logText);

    // Part B — rate-limited. Record it; if real partial work came through, save it as resumable (Part C).
    if (rl.limited) {
      recordLimitOutcome('gemini', agyModelLabel, { status: 'limited', resetAt: rl.resetAt, error: 'RESOURCE_EXHAUSTED' });
      cleanFiles();
      if (replyText && replyText.length > 40 && !ctx.memoryIntent) {
        const { answer } = splitGeminiReply(replyText);
        return respondChat(ctx, answer, geminiTrace(1), { interrupted: true, reason: 'limit', resetAt: rl.resetAt });
      }
      return respondChat(ctx, formatLimitMessage('gemini', rl), geminiTrace(1), { interrupted: true, reason: 'limit', resetAt: rl.resetAt });
    }

    if (!replyText) {
      const authStatus = agyAuthStatus(logText);
      if (authStatus === 'auth_failed') {
        cleanFiles();
        return respondChat(ctx, '⚠️ **尚未登入 Antigravity CLI**。請在終端機執行 `agy` 完成 Google 登入後再試。', geminiTrace(1));
      }
      // Part A — authed (or unknown) but empty = agy's flaky cold-start. Auto-retry (not on user abort).
      if (attempt < MAX_AGY_ATTEMPTS && !ctx.aborted) {
        cleanFiles();
        console.log(`[Chat] Gemini transient empty (attempt ${attempt}/${MAX_AGY_ATTEMPTS}) — retrying`);
        return setTimeout(() => chatViaGemini(ctx, attempt + 1), attempt * 800);
      }
      cleanFiles();
      let progressInfo = '';
      if (allOutput && (ctx.aborted || errMessage)) {
        const cleanLines = cleanAnsi(allOutput).split('\n').map(l => l.trim()).filter(Boolean);
        if (cleanLines.length > 0) {
          const lastLines = cleanLines.slice(-15);
          progressInfo = `\n\n**中斷前最後執行的步驟與終端畫面：**\n\`\`\`\n${lastLines.join('\n')}\n\`\`\``;
        }
      }
      const msg = (ctx.aborted ? '⛔ 已中止。'
        : `⚠️ agy 暫時取用失敗（其實已登入），已自動重試 ${attempt - 1} 次仍無回應。請稍後再試，或先改用 Claude。`
          + (errMessage ? `\n（${errMessage}）` : '')) + progressInfo;
      return respondChat(ctx, msg, geminiTrace(1));
    }

    // Part B — a real answer ⇒ this model is OK right now.
    recordLimitOutcome('gemini', agyModelLabel, { status: 'ok' });
    cleanFiles();
    // Part C — interrupted-but-has-partial (user abort / timeout): mark for resume.
    const interruptedMeta = (ctx.aborted || errMessage) && !ctx.memoryIntent
      ? { interrupted: true, reason: ctx.aborted ? 'aborted' : 'timeout' } : null;
    const { answer, thinking } = ctx.memoryIntent ? { answer: replyText, thinking: '' } : splitGeminiReply(replyText);
    respondChat(ctx, answer, geminiTrace(errMessage ? 1 : 0), Object.assign({}, thinking ? { thinking } : null, interruptedMeta));
  };
  ptyProcess.onData((d) => { allOutput += d; lastOutputTime = Date.now(); ctx.liveOutput = cleanAnsi(allOutput); checkpointChatSession(ctx, ctx.liveOutput, 'gemini_cli_execution'); });
  ptyProcess.onExit(({ exitCode }) => { processExited = true; finish(exitCode !== 0 ? `Exit code: ${exitCode}` : null); });
  ptyProcess.on('error', (err) => finish(`PTY error: ${err.message}`));
  // Idle cutoff is only a safety net for a hung agy — the REAL completion signal is onExit.
  // High reasoning / background tasks can sit on a silent "(Waiting…)" spinner for a while, so
  // 20s was too eager and cut answers off. Give 60s of quiet before we assume a hang; the 60m
  // absolute timeout is the hard backstop.
  const IDLE_TIMEOUT_MS = 300000;
  idleCheckInterval = setInterval(() => { if (processExited) return; if (allOutput.length > 100 && Date.now() - lastOutputTime > IDLE_TIMEOUT_MS) finish(); }, 2000);
  absoluteTimeout = setTimeout(() => { if (!processExited) finish('Absolute timeout of 60 minutes reached.'); }, 3600000);
}

// --- Claude via claude-code CLI (child_process) ---
function chatViaClaude(ctx) {
  const { spawn } = require('child_process');
  const { cmd, prefix, label } = claudeLauncher();
  const mappedModel = ctx.modelArg || 'sonnet';
  // Prompt goes via STDIN, NOT argv: with shell:true on Windows an argv prompt
  // containing spaces gets split into multiple shell tokens (everything after the
  // first space is dropped). stdin preserves the whole prompt verbatim.
  // --dangerously-skip-permissions: auto-approve all tool use so Claude can actually edit
  // files / run tasks in the workspace (no interactive approval channel in --print mode).
  const args = [...prefix, '--print', '--dangerously-skip-permissions', '--model', mappedModel];
  const displayCommand = `${label} --print --model ${mappedModel} "${ctx.fullPrompt.slice(0, 80)}..."`;
  const startT = Date.now();
  console.log(`[Chat] Claude (claude-code) starting, model=${mappedModel} ...`);
  const child = spawn(cmd, args, { cwd: ctx.wctx.root, shell: true, stdio: ['pipe', 'pipe', 'pipe'], env: Object.assign({}, process.env, { GEMINI_CLI_TRUST_WORKSPACE: 'true' }) });
  ctx.proc = child;   // handle for explicit abort
  let stdoutData = '', stderrData = '', processExited = false, timedOut = false;
  const absTimeout = setTimeout(() => { if (!processExited) { timedOut = true; console.log('[Chat] Claude timeout (60m) — killing process'); try { child.kill('SIGINT'); } catch (e) {} } }, 3600000);
  // Browser disconnect → detach (job survives); only explicit abort kills.
  ctx.res.on('close', () => { ctx.detached = true; });
  child.stdout.on('data', (d) => { stdoutData += d.toString(); checkpointChatSession(ctx, stdoutData, 'claude_cli_execution'); });
  child.stderr.on('data', (d) => stderrData += d.toString());
  child.on('close', (code) => {
    processExited = true; clearTimeout(absTimeout);
    console.log(`[Chat] Claude exited code=${code} after ${Math.round((Date.now() - startT) / 1000)}s`);
    let replyText = cleanCliOutput(stdoutData || stderrData);
    const rl = detectRateLimit('claude', stdoutData + '\n' + stderrData, '');
    let extraMeta = null;
    if (rl.limited) {                                         // Part B — limit
      recordLimitOutcome('claude', mappedModel, { status: 'limited', resetAt: rl.resetAt, error: 'limit' });
      if (!(replyText && replyText.length > 40)) replyText = formatLimitMessage('claude', rl);
      extraMeta = { interrupted: true, reason: 'limit', resetAt: rl.resetAt };  // Part C — ALWAYS resumable (files may be changed on disk)
    } else if (timedOut && !replyText) replyText = '❌ **錯誤**: Claude CLI 逾時（超過 60 分鐘未回應）。請改用較快的模型或簡化問題。';
    else if (code !== 0 && !replyText) replyText = `❌ **錯誤**: Claude CLI 執行失敗 (Exit Code ${code}).\n${stderrData}`;
    else if (replyText && !replyText.startsWith('❌')) recordLimitOutcome('claude', mappedModel, { status: 'ok' });   // Part B — ok
    // Part C — interrupted-but-has-partial (abort / timeout): mark for resume.
    if (!extraMeta && (ctx.aborted || (timedOut && code !== 0)) && replyText && !replyText.startsWith('❌')) extraMeta = { interrupted: true, reason: ctx.aborted ? 'aborted' : 'timeout' };
    respondChat(ctx, replyText, [{ toolName: 'claude_cli_execution', args: { command: displayCommand, exitCode: code }, resultPreview: replyText.slice(0, 500) }], extraMeta);
  });
  child.on('error', (err) => { processExited = true; ctx.status = 'done'; if (ctx.detached) return; if (!ctx.res.headersSent) { try { ctx.res.writeHead(500, { 'Content-Type': 'application/json' }); ctx.res.end(JSON.stringify({ error: `Failed to spawn Claude CLI: ${err.message}` })); } catch (e) {} } });
  try { child.stdin.write(ctx.fullPrompt); child.stdin.end(); } catch (e) {}
}

// --- Codex via codex CLI (codex exec, prompt on stdin) ---
function extractCodexReply(raw) {
  let s = cleanCliOutput(raw);
  const idx = s.lastIndexOf('\ncodex\n');
  if (idx !== -1) s = s.slice(idx + 7);
  const tok = s.indexOf('tokens used');
  if (tok !== -1) s = s.slice(0, tok);
  return s.trim();
}
function chatViaCodex(ctx) {
  const { spawn } = require('child_process');
  const os = require('os');
  const model = ctx.modelArg || 'gpt-5.6-terra';
  const outFile = path.join(os.tmpdir(), `codex_out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`);
  // Chat-tuned: codex exec is a full agent, so for Q&A we constrain it to be snappy —
  //   -s read-only            : never edit/run, just answer (faster + safe)
  //   model_reasoning_effort  : from the front-end's effort dropdown (CDX-05); undefined (no
  //                             effort sent, e.g. a scheduled job) falls back to 'low'; an
  //                             explicit 'default'/empty (only ever sent for Claude/Gemini) means
  //                             omit the flag entirely and let Codex use its own default.
  //   --output-last-message   : capture the clean final answer in a file (reliable)
  // and we preface the prompt to discourage deep repo exploration.
  // mcp_servers={} disables the codegraph MCP for chat so Codex answers directly
  // instead of booting the MCP and going off exploring the repo.
  // --skip-git-repo-check: codex exec otherwise refuses to run outside a git repo /
  // untrusted dir. Our chat is read-only sandboxed, so skipping the check is safe and
  // lets Codex work in any workspace (e.g. a freshly created, non-git folder).
  // --dangerously-bypass-approvals-and-sandbox: auto-approve + no sandbox so Codex can edit
  // files / run tasks without prompting (the web has no interactive approval channel). On
  // Windows the default workspace-write+auto-approval still blocked writes, so we bypass —
  // consistent with Claude/agy (--dangerously-skip-permissions). cwd is the workspace; git is the safety net.
  const effort = ctx.effort === undefined ? 'low' : ctx.effort;
  const effortArgs = (!effort || effort === 'default') ? [] : ['-c', `model_reasoning_effort=${effort}`];
  const args = ['exec', '-m', model, '--dangerously-bypass-approvals-and-sandbox', ...effortArgs, '-c', 'mcp_servers={}', '--skip-git-repo-check', '--output-last-message', outFile, '-'];
  const displayCommand = `codex exec -m ${model} "${ctx.fullPrompt.slice(0, 80)}..."`;
  const codexPrompt = ctx.fullPrompt;
  const startT = Date.now();
  console.log(`[Chat] Codex (codex exec) starting, model=${model} ...`);
  const child = spawn('codex', args, { cwd: ctx.wctx.root, shell: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  ctx.proc = child;   // handle for explicit abort
  let stdoutData = '', stderrData = '', processExited = false, timedOut = false;
  const absTimeout = setTimeout(() => { if (!processExited) { timedOut = true; console.log('[Chat] Codex timeout (60m) — killing'); try { child.kill('SIGINT'); } catch (e) {} } }, 3600000);
  // Browser disconnect → detach (job survives); only explicit abort kills.
  ctx.res.on('close', () => { ctx.detached = true; });
  child.stdout.on('data', (d) => { stdoutData += d.toString(); checkpointChatSession(ctx, stdoutData, 'codex_cli_execution'); });
  child.stderr.on('data', (d) => stderrData += d.toString());
  child.on('close', (code) => {
    processExited = true; clearTimeout(absTimeout);
    console.log(`[Chat] Codex exited code=${code} after ${Math.round((Date.now() - startT) / 1000)}s`);
    let replyText = '';
    try { if (fs.existsSync(outFile)) replyText = fs.readFileSync(outFile, 'utf8').trim(); } catch (e) {}
    try { fs.unlinkSync(outFile); } catch (e) {}
    if (!replyText) replyText = extractCodexReply(stdoutData) || cleanCliOutput(stdoutData);
    const rl = detectRateLimit('codex', stdoutData + '\n' + stderrData, '');
    let extraMeta = null;
    if (rl.limited) {                                         // Part B — limit
      recordLimitOutcome('codex', model, { status: 'limited', resetAt: rl.resetAt, error: 'limit' });
      if (!(replyText && replyText.length > 40)) replyText = formatLimitMessage('codex', rl);
      extraMeta = { interrupted: true, reason: 'limit', resetAt: rl.resetAt };  // Part C — ALWAYS resumable (files may be changed on disk)
    } else if (code !== 0 && !replyText) replyText = `❌ **錯誤**: Codex CLI 執行失敗 (Exit Code ${code}).\n${cleanCliOutput(stderrData)}`;
    else if (!replyText) replyText = '❌ **錯誤**: Codex 未回傳內容（可能仍在思考或逾時）。';
    else if (!replyText.startsWith('❌')) recordLimitOutcome('codex', model, { status: 'ok' });   // Part B — ok
    if (!extraMeta && (ctx.aborted || (timedOut && code !== 0)) && replyText && !replyText.startsWith('❌')) extraMeta = { interrupted: true, reason: ctx.aborted ? 'aborted' : 'timeout' };
    respondChat(ctx, replyText, [{ toolName: 'codex_cli_execution', args: { command: displayCommand, model, exitCode: code }, resultPreview: replyText.slice(0, 500) }], extraMeta);
  });
  child.on('error', (err) => { processExited = true; ctx.status = 'done'; clearTimeout(absTimeout); try { fs.unlinkSync(outFile); } catch (e) {} if (ctx.detached) return; if (!ctx.res.headersSent) { try { ctx.res.writeHead(500, { 'Content-Type': 'application/json' }); ctx.res.end(JSON.stringify({ error: `Failed to spawn Codex CLI: ${err.message}` })); } catch (e) {} } });
  try { child.stdin.write(codexPrompt); child.stdin.end(); } catch (e) {}
}

// --- Grok via xAI's official grok CLI (headless -p/--prompt-file, plain stdout, no PTY needed) ---
function chatViaGrok(ctx) {
  const { spawn } = require('child_process');
  const os = require('os');
  const home = process.env.USERPROFILE || path.join(process.env.HOMEDRIVE || 'C:', process.env.HOMEPATH || '');
  const grokPath = path.join(home, '.grok', 'bin', 'grok.exe');
  const model = ctx.modelArg || 'grok-4.5';
  // grok -p/--single does NOT read stdin (a "-" value is treated as literal prompt text), unlike
  // Claude/Codex which take the prompt on stdin. Short prompts go via -p as an argv value; long
  // prompts (same 6000-byte Windows argv cap agy hits) spill to a temp file via --prompt-file.
  let promptFile = null;
  const promptArgs = Buffer.byteLength(ctx.fullPrompt, 'utf8') > 6000
    ? (promptFile = path.join(os.tmpdir(), `grok_prompt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`),
       fs.writeFileSync(promptFile, ctx.fullPrompt, 'utf8'),
       ['--prompt-file', promptFile])
    : ['-p', ctx.fullPrompt];
  // Only 'low'/'medium'/'high' are accepted (validated against real CLI); no effort sent = grok's own default.
  const effortArgs = (ctx.effort && ctx.effort !== 'default') ? ['--effort', ctx.effort] : [];
  const args = ['--model', model, ...effortArgs, '--output-format', 'plain', ...promptArgs];
  const displayCommand = `grok -p "${ctx.fullPrompt.slice(0, 80)}..." --model ${model}${ctx.effort && ctx.effort !== 'default' ? ` --effort ${ctx.effort}` : ''}`;
  const startT = Date.now();
  console.log(`[Chat] Grok starting, model=${model}${ctx.effort && ctx.effort !== 'default' ? ` effort=${ctx.effort}` : ''} ...`);
  const child = spawn(grokPath, args, { cwd: ctx.wctx.root, shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  ctx.proc = child;   // handle for explicit abort
  let stdoutData = '', stderrData = '', processExited = false, timedOut = false;
  const cleanup = () => { if (promptFile) { try { fs.unlinkSync(promptFile); } catch (e) {} } };
  const absTimeout = setTimeout(() => { if (!processExited) { timedOut = true; console.log('[Chat] Grok timeout (60m) — killing'); try { child.kill('SIGINT'); } catch (e) {} } }, 3600000);
  // Browser disconnect → detach (job survives); only explicit abort kills.
  ctx.res.on('close', () => { ctx.detached = true; });
  child.stdout.on('data', (d) => { stdoutData += d.toString(); checkpointChatSession(ctx, stdoutData, 'grok_cli_execution'); });
  child.stderr.on('data', (d) => stderrData += d.toString());
  child.on('close', (code) => {
    processExited = true; clearTimeout(absTimeout); cleanup();
    console.log(`[Chat] Grok exited code=${code} after ${Math.round((Date.now() - startT) / 1000)}s`);
    let replyText = cleanCliOutput(stdoutData);
    const rl = detectRateLimit('grok', stdoutData + '\n' + stderrData, '');
    let extraMeta = null;
    if (rl.limited) {                                         // Part B — limit
      recordLimitOutcome('grok', model, { status: 'limited', resetAt: rl.resetAt, error: 'limit' });
      if (!(replyText && replyText.length > 40)) replyText = formatLimitMessage('grok', rl);
      extraMeta = { interrupted: true, reason: 'limit', resetAt: rl.resetAt };  // Part C — ALWAYS resumable (files may be changed on disk)
    } else if (code !== 0 && !replyText) replyText = `❌ **錯誤**: Grok CLI 執行失敗 (Exit Code ${code}).\n${cleanCliOutput(stderrData)}`;
    else if (!replyText) replyText = '❌ **錯誤**: Grok 未回傳內容（可能仍在思考或逾時）。';
    else if (!replyText.startsWith('❌')) recordLimitOutcome('grok', model, { status: 'ok' });   // Part B — ok
    if (!extraMeta && (ctx.aborted || (timedOut && code !== 0)) && replyText && !replyText.startsWith('❌')) extraMeta = { interrupted: true, reason: ctx.aborted ? 'aborted' : 'timeout' };
    respondChat(ctx, replyText, [{ toolName: 'grok_cli_execution', args: { command: displayCommand, model, exitCode: code }, resultPreview: replyText.slice(0, 500) }], extraMeta);
  });
  child.on('error', (err) => { processExited = true; ctx.status = 'done'; clearTimeout(absTimeout); cleanup(); if (ctx.detached) return; if (!ctx.res.headersSent) { try { ctx.res.writeHead(500, { 'Content-Type': 'application/json' }); ctx.res.end(JSON.stringify({ error: `Failed to spawn Grok CLI: ${err.message}` })); } catch (e) {} } });
}

// --- Provider/model discovery for the dropdown (only installed CLIs are returned) ---
function commandExists(cmd) {
  try { require('child_process').execSync((process.platform === 'win32' ? 'where ' : 'which ') + cmd, { stdio: 'ignore' }); return true; } catch (e) { return false; }
}
function detectProvider(id) {
  const home = process.env.USERPROFILE || path.join(process.env.HOMEDRIVE || 'C:', process.env.HOMEPATH || '');
  if (id === 'claude') return fs.existsSync(path.join(home, '.claude')) || commandExists('npx');
  if (id === 'gemini') return fs.existsSync(path.join(home, 'AppData', 'Local', 'agy', 'bin', 'agy.exe'));
  if (id === 'codex') return commandExists('codex');
  if (id === 'grok') return fs.existsSync(path.join(home, '.grok', 'bin', 'grok.exe'));
  return false;
}
function loadProvidersConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'cli-providers.json'), 'utf8')); } catch (e) { return { providers: [] }; }
}
// agy 1.1.8+ prints `agy models` as two columns: `<slug><spaces><Label>` (e.g.
// "gemini-3.5-flash-high     Gemini 3.5 Flash (High)"). A plain exec only sees the slug
// column truncated by the pipe width, so this needs a wide PTY (cols:200) to get both.
// Slugs ending in -low/-medium/-high are effort variants of one base model (agy's
// `--model <base> --effort <level>` syntax) — group them so the frontend gets one model
// entry with an `efforts` list instead of N unusable "whole line as value" entries.
const AGY_EFFORT_LABEL_ZH = { low: '低', medium: '中', high: '高' };
const AGY_EFFORT_ORDER = { low: 0, medium: 1, high: 2 };
function getAgyModels() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (out) => { if (done) return; done = true; resolve(out); };
    try {
      const pty = require('node-pty');
      const home = process.env.USERPROFILE || path.join(process.env.HOMEDRIVE || 'C:', process.env.HOMEPATH || '');
      const agyPath = path.join(home, 'AppData', 'Local', 'agy', 'bin', 'agy.exe');
      const p = pty.spawn(agyPath, ['models'], { name: 'xterm-256color', cols: 200, rows: 50, env: process.env });
      let out = '';
      p.onData((d) => { out += d; });
      const parse = () => {
        const clean = cleanAnsi(out);
        const lines = clean.split('\n').map(l => l.trim()).filter(l => /\)\s*$/.test(l) && !/Fetching/i.test(l) && /[A-Za-z]/.test(l));
        const bases = new Map();   // base slug -> { label, efforts: Map(effort -> {value,label}) }
        for (const line of [...new Set(lines)]) {
          const m = line.match(/^(\S+)\s+(.+)$/);
          if (!m) continue;
          const slug = m[1], label = m[2].trim();
          const em = slug.match(/^(.+)-(high|medium|low)$/i);
          if (em) {
            const base = em[1], effort = em[2].toLowerCase();
            const cleanLabel = label.replace(/\s*\((?:High|Medium|Low)\)\s*$/i, '').trim();
            if (!bases.has(base)) bases.set(base, { label: cleanLabel, efforts: new Map() });
            bases.get(base).efforts.set(effort, { value: effort, label: AGY_EFFORT_LABEL_ZH[effort] });
          } else if (!bases.has(slug)) {
            bases.set(slug, { label, efforts: new Map() });
          }
        }
        finish([...bases.entries()].map(([base, info]) => ({
          value: base,
          label: info.label,
          efforts: [...info.efforts.values()].sort((a, b) => AGY_EFFORT_ORDER[a.value] - AGY_EFFORT_ORDER[b.value])
        })));
      };
      p.onExit(parse);
      setTimeout(() => { try { p.kill(); } catch (e) {} parse(); }, 15000);
    } catch (e) { finish([]); }
  });
}
let _modelsCache = null, _modelsCacheTime = 0;
async function getCliModels(force) {
  if (!force && _modelsCache && (Date.now() - _modelsCacheTime < 3600000)) return _modelsCache;
  const config = loadProvidersConfig();
  const providers = [];
  for (const p of config.providers || []) {
    if (!detectProvider(p.id)) continue;
    let models = p.models || [];
    if (p.dynamic === 'agy') { try { models = await getAgyModels(); } catch (e) { models = []; } }
    if (models.length) providers.push({ id: p.id, label: p.label, icon: p.icon || 'cpu', models, efforts: p.efforts || [] });
  }
  _modelsCache = { providers };
  _modelsCacheTime = Date.now();
  return _modelsCache;
}
// agy requires --effort whenever the base model supports it (no implicit default) and
// rejects it outright for bases that don't. Look up the base's real `efforts` list (from
// getAgyModels, cached in _modelsCache) instead of hardcoding which bases support what.
function resolveGeminiEffort(agyModel, requestedEffort) {
  const providers = (_modelsCache && _modelsCache.providers) || [];
  const gp = providers.find(p => p.id === 'gemini');
  const modelInfo = gp && (gp.models || []).find(m => m.value === agyModel);
  const efforts = (modelInfo && modelInfo.efforts) || [];
  if (!efforts.length) return null;   // base doesn't support --effort
  const wanted = requestedEffort && requestedEffort !== 'default' && requestedEffort !== 'none' ? requestedEffort : '';
  if (wanted && efforts.some(e => e.value === wanted)) return wanted;
  if (efforts.some(e => e.value === 'medium')) return 'medium';
  return efforts[0].value;
}

initActiveProject();
// P4 (SPEC-plugin-contract.md §5): log what loaded, from where, at what trust level — at startup
// for the initial active workspace (workspace switches log again via getPlugins()'s callers if
// something inspects them; this line covers the common "did my plugin load" question).
try {
  const startupCtx = resolveWorkspace({ headers: {} });
  const startupPlugins = getPlugins(startupCtx);
  if (startupPlugins.length) {
    console.log('[plugins] loaded for ' + startupCtx.root + ':');
    startupPlugins.forEach(p => console.log('[plugins]   - ' + p.name + ' (source=' + p.source + ', trust=' + (p.trust || 'prompt') + ', enabled=' + p.enabled + (p.enabled ? '' : ', reason=' + p.disabledReason) + ')'));
  } else {
    console.log('[plugins] none found for ' + startupCtx.root);
  }
} catch (e) { console.error('[plugins] startup log failed:', e.message); }
loadLimitState();   // SPEC-resilient-cli Part B — restore CLI limit/reset state across restarts

// FAIL LOUDLY if the port is already taken. Without this, the global uncaughtException handler
// swallows EADDRINUSE — so a stale/zombie node still holding 3300 makes a "restart" silently
// keep serving OLD code (you think you restarted, but you're talking to the old server). Now a
// port conflict prints a clear message and exits, instead of pretending to run.
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\n[Harness] ✗ Port ${PORT} is ALREADY IN USE — another (old) portal is still running.`);
    console.error(`[Harness]   Kill it first, then restart:  PowerShell →  Get-Process node | Stop-Process -Force`);
    console.error(`[Harness]   (or: Get-NetTCPConnection -LocalPort ${PORT} | %{ Stop-Process -Id $_.OwningProcess -Force })\n`);
    process.exit(1);
  }
  console.error('[Harness] server error:', err);
  process.exit(1);
});
// If we just came back from a graceful restart, surface a one-time "restart complete" notice the
// frontend can show in chat (consumed here so it only fires once).
try {
  const marker = path.join(RELEASES_DIR, 'restart-pending.json');
  if (fs.existsSync(marker)) {
    const m = JSON.parse(fs.readFileSync(marker, 'utf8'));
    LAST_RESTART = {
      reason: m.reason || 'manual',
      requestedAt: m.requestedAt || null,
      version: readReleaseVersion(),
      completedBootId: BOOT_ID,
      completedAt: new Date().toISOString()
    };
    fs.unlinkSync(marker);
  }
} catch (e) { /* ignore — the notice is best-effort */ }
// SPEC-setup §12.2-3: exposed to the network with no token = anyone who can reach the port gets
// full control of this machine. Warn loudly (red) but don't block — respect the user's choice.
if (BIND === '0.0.0.0' && !PORTAL_TOKEN) {
  console.log('\x1b[41m\x1b[97m⚠  你正把完整電腦控制權暴露到網路上 (PORTAL_BIND=0.0.0.0)，且未設 PORTAL_TOKEN。請設 PORTAL_TOKEN，或改用 Tailscale／PORTAL_BIND=127.0.0.1。\x1b[0m');
}
// Dual-stack loopback: on Windows `localhost` resolves to IPv6 ::1 FIRST. Binding only to
// 127.0.0.1 means every browser connection to http://localhost:PORT stalls ~2s on the ::1
// attempt before falling back to IPv4 — the portal looks broken/slow when the server is fine.
// So when we're on IPv4 loopback, ALSO listen on the IPv6 loopback (::1) with the same handler.
// Still loopback-only: this does not expose anything to the network. Best-effort — if the box
// has no IPv6, we warn once and keep serving on IPv4.
let server6 = null;
if (BIND === '127.0.0.1' || BIND === 'localhost') {
  try {
    const handler = server.listeners('request')[0];
    server6 = http.createServer(handler);
    server6.on('error', (err) => {
      // Never fatal: IPv4 is the primary listener. EADDRINUSE here usually means another
      // portal grabbed ::1 — the IPv4 listener's own error handler already covers the real conflict.
      console.warn(`[Harness] IPv6 loopback listener unavailable (${err && err.code || err}); localhost may be slow — use http://127.0.0.1:${PORT}`);
      server6 = null;
    });
    server6.listen(PORT, '::1', () => {
      console.log(`[Worktable Portal] Also listening on http://[::1]:${PORT} (localhost dual-stack)`);
    });
  } catch (e) {
    console.warn('[Harness] could not start IPv6 loopback listener:', e.message);
  }
}
server.listen(PORT, BIND, () => {
  console.log(`[Worktable Portal] Running at http://localhost:${PORT} (bind: ${BIND})`);
  console.log(`[Worktable Portal] Active workspace: ${WORKSPACE_ROOT}`);
  console.log(`[Worktable Portal] HARNESS_HOME (shared data): ${HARNESS_HOME}`);
  console.log(`[Worktable Portal] Press Ctrl+C to terminate.`);
  // Start the scheduler loop (checks every 60s; also fires missed runs on startup).
  schedulerManager.start();
  // Telegram C&C: start outbound sink + inbound long-polling (no-op if not configured).
  telegramBot.start();
  // B4 / SCHED-11: now that every sink is registered (web above + telegram via telegramBot.start),
  // re-send notifications for any run that finished but didn't deliver before the last restart.
  try { schedulerManager.flushPendingDeliveries(); } catch (e) { console.error('[Scheduler] flushPendingDeliveries error:', e.message); }
  // SCHED-DEPLOY Z4: recover a postRun deploy that was in flight when this process got replaced.
  try { reconcilePendingDeploy(); } catch (e) { console.error('[Deploy] reconcilePendingDeploy boot error:', e.message); }
  // Reconcile orphaned recordings: deploy restarts portal and orphans the meeting_record.py child.
  // Any meeting still showing status=recording at boot has no live proc → mark aborted.
  try {
    const reg = loadRegistry();
    const roots = [HARNESS_HOME].concat((reg.projects || []).map(function(p) { return p.root; }));
    const now = new Date().toISOString();
    for (const root of roots) {
      const meetingsDir = path.join(root, '.harness', 'runtime', 'meetings');
      if (!fs.existsSync(meetingsDir)) continue;
      let entries = [];
      try { entries = fs.readdirSync(meetingsDir); } catch (e) { continue; }
      for (const id of entries) {
        const metaPath = path.join(meetingsDir, id, 'meta.json');
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          if (meta && meta.status === 'recording') {
            const updated = Object.assign({}, meta, { status: 'aborted', finishedAt: now });
            fs.writeFileSync(metaPath, JSON.stringify(updated, null, 2), 'utf8');
            console.log('[Meeting] boot reconcile: ' + id + ' marked aborted (orphaned on restart)');
          }
        } catch (e) {}
      }
    }
  } catch (e) { console.error('[Meeting] boot reconcile error:', e.message); }
  // A release becomes "last-known-good" once it has run healthy for 30s. This lets a DEFERRED
  // deploy (where Deploy couldn't verify the live boot, because the server hadn't restarted yet)
  // still advance lkg — with no polling. If this version boot-crashes within 30s, lkg is left at the
  // previous good one, so the supervisor falls back correctly.
  if (/^v\d+$/.test(RUNNING_VERSION)) {
    const t = setTimeout(() => {
      try {
        const lkgPath = path.join(RELEASES_DIR, 'last-known-good.json');
        let cur = null;
        try { cur = JSON.parse(fs.readFileSync(lkgPath, 'utf8')).version; } catch (e) {}
        if (cur !== RUNNING_VERSION) {
          fs.writeFileSync(lkgPath, JSON.stringify({ version: RUNNING_VERSION, updatedAt: new Date().toISOString(), by: 'uptime' }));
          console.log(`[Harness] ${RUNNING_VERSION} healthy for 30s → recorded as last-known-good.`);
        }
      } catch (e) { /* best effort */ }
    }, 30000);
    if (t.unref) t.unref();
  }
});

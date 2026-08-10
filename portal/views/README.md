# views/

View modules for the router (`SPEC-portal-architecture.md` §3.1, `SPEC-plugin-contract.md` §3).
Populated by the §V migration — one panel per file, e.g. `chat.js`, `codegraph.js`.

Contract:

```js
export const meta = { route: '/app/<name>', title: '...', icon: '...', menuGroup: '...' };
export function mount(container, ctx) { /* ctx: { workspace, sub, apiFetch } */ }
export function unmount() { /* teardown */ }
```

Until a view exists here, `router.js` falls back to the legacy `switchTo<Name>()` panel function.

### Optional: `getChatContext()` (SPEC-view-chat-context.md §3.1)

```js
// Optional. Return null (or omit this export) → the avatar float-chat falls back to the
// existing file mode (wiki currentFilePath). router.js's window.router.getChatContext() calls
// this on whichever view is currently mounted, wrapped in try/catch — a throwing view must
// never break the chat widget.
export function getChatContext() {
  return {
    kind: 'schedule',              // provider name — server.js's CHAT_CONTEXT_PROVIDERS dispatches on this
    key: 'schedule:list',          // context identity; float-chat only resets its session when this changes
    label: '排程清單（本工作區）', // used for the float window title ("討論：" + label)
    payload: { scope: 'list' }     // sent to the backend provider — identifiers only (id/scope), never content
  };
}
```

Rule: `payload` carries identifiers only (id, scope) — never content. The backend provider re-reads the actual content from the source of truth (file/store) on every request, so it can never go stale or be spoofed by the client.

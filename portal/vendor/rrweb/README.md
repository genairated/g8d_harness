# vendor/rrweb

- 套件：`rrweb` **2.1.7**（MIT）— 取自 `npm pack rrweb@2.1.7` 的 `dist/rrweb.umd.min.cjs`、`dist/style.min.css`
- 檔案：
  - `rrweb.umd.min.js`（= 上述 umd.min.cjs，已移除 sourceMappingURL 註解）— 掛 `window.rrweb`，同一包含 `record` 與 `Replayer`（下一階段重播直接用 `new rrweb.Replayer(events, {root})`，不需另放 rrweb-player）
  - `rrweb.min.css` — Replayer 樣式
- 離線可用，不引用外部 CDN；由 `/vendor/rrweb/...` 提供。
- 用途：SPEC-issue-report.md §5.1 殼層錄製（`portal/shell/issue-recorder.js`）。
- 完整性：`rrweb.umd.min.js` 以二進位方式取自 npm 原檔（僅移除檔尾 sourceMappingURL 註解行），`node --check` 通過；`rrweb.min.css` 與 `dist/style.min.css` 逐位元相同。
- 與另一個客戶專案自製的問題錄製工具同為 2.1.7，錄製檔格式相容。

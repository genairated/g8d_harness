// Plugin discovery (SPEC-plugin-contract.md, TASK.md §P1).
// A "plugin" is a directory containing plugin.json (+ optional view/routes files) found under one
// of three tiers, same merge model as loadCommands() in server.js: ship < global < project,
// later tier wins on name collision. Trust filtering is NOT this module's job — server.js applies
// it (registry lookup) after loading, because "trusted" is a runtime/registry concept, not a
// filesystem one.

const fs = require('fs');
const path = require('path');

function readPluginDir(dir, source) {
  const out = [];
  if (!dir || !fs.existsSync(dir)) return out;
  let entries;
  try { entries = fs.readdirSync(dir); } catch (e) { return out; }
  for (const entry of entries) {
    const pluginDir = path.join(dir, entry);
    try {
      if (!fs.statSync(pluginDir).isDirectory()) continue;
    } catch (e) { continue; }
    const jsonPath = path.join(pluginDir, 'plugin.json');
    if (!fs.existsSync(jsonPath)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      if (!meta || !meta.name) continue;
      out.push(Object.assign({}, meta, { source, dir: pluginDir }));
    } catch (e) {
      console.error('[plugins] failed to parse ' + jsonPath + ':', e.message);
    }
  }
  return out;
}

// { shipDir, globalDir, projectDir } -> merged plugin list. Same-name collision: project wins
// over global wins over ship (mirrors loadCommands()'s ship < global < project tiering).
function loadPlugins(dirs) {
  const byName = new Map();
  for (const tier of [
    { dir: dirs.shipDir, source: 'ship' },
    { dir: dirs.globalDir, source: 'global' },
    { dir: dirs.projectDir, source: 'project' },
  ]) {
    for (const p of readPluginDir(tier.dir, tier.source)) byName.set(p.name, p);
  }
  return [...byName.values()];
}

module.exports = { loadPlugins };

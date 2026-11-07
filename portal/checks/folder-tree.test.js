// IDX-TREE (SPEC-list-index.md §9.5) — pure node test, no server started.
// Extracts the real helper functions out of portal/server.js (so the shipped code is tested, not a
// copy), builds a fake 3-level workspace under _tmp/, and checks: lazy level == old full tree's
// first level, path escape is refused, search works, and before/after timing.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').split('\r\n').join('\n');
function grab(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a + 1);
  assert(a >= 0 && b > a, 'marker not found: ' + startMarker);
  return src.slice(a, b);
}
const globFn = grab('function globToRegex', '\n}\n') + '\n}\n';
const newCode = grab('// IDX-TREE (SPEC-list-index.md', '// Function to recursively crawl');
const oldStart = src.indexOf('function getFolderTree');
const oldEnd = src.indexOf('\n}\n', oldStart) + 3;
const factory = new Function('fs', 'path', 'WORKSPACE_ROOT',
  globFn + '\n' + newCode + '\n' + src.slice(oldStart, oldEnd) +
  '\nreturn { getFolderTree, getFolderLevel, resolveTreeDir, searchFolderTree };');

(async () => {
  const root = path.join(__dirname, '..', '..', '_tmp', 'idx-tree-ws');
  fs.rmSync(root, { recursive: true, force: true });
  const wt = path.join(root, '.worktable');
  fs.mkdirSync(path.join(wt, 'history'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'TASK.md'), '# t');
  fs.writeFileSync(path.join(wt, 'history', 'a.md'), '# a');
  // section "know": 3 levels, 6000 files
  let n = 0;
  for (let i = 0; i < 20; i++) for (let j = 0; j < 15; j++) {
    const d = path.join(root, 'know', 'g' + i, 'sub' + j);
    fs.mkdirSync(d, { recursive: true });
    for (let k = 0; k < 20; k++) { fs.writeFileSync(path.join(d, 'f' + k + '.md'), 'x'); n++; }
  }
  fs.writeFileSync(path.join(root, 'know', 'top.md'), 'x');
  fs.mkdirSync(path.join(root, 'know', 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'know', 'node_modules', 'skip.md'), 'x');
  fs.mkdirSync(path.join(root, 'know', '.hidden'), { recursive: true });
  // html section with an image-only folder (must stay pruned, as before) and a real deck
  fs.mkdirSync(path.join(root, 'pres', 'ep_1'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pres', 'ep_1', 'a.png'), 'x');
  fs.writeFileSync(path.join(root, 'pres', 'deck.html'), '<p>');
  fs.writeFileSync(path.join(root, 'pres', 'note.md'), 'x');
  fs.mkdirSync(path.join(root, 'secret'), { recursive: true });
  fs.writeFileSync(path.join(root, 'secret', 'pw.md'), 'x');
  console.log('fake workspace md files:', n);

  const T = factory(fs, path, root);
  const wctx = { root, worktableDir: wt };
  const manifest = { sidebar: { sections: [{ label: '知識', path: 'know', filter: null }, { label: '簡報', path: 'pres', filter: '*.html' }] } };
  const strip = (x) => ({ type: x.type, name: x.name, path: x.path });
  const hrt = () => Number(process.hrtime.bigint()) / 1e6;

  // --- equivalence: new level == first level of the old full tree
  for (const [dir, filter] of [[path.join(root, 'know'), null], [path.join(root, 'pres'), '*.html'], [wt, null]]) {
    const oldTree = T.getFolderTree(dir, root, filter).map(strip);
    const lvl = (await T.getFolderLevel(dir, root, filter)).map(strip);
    assert.deepStrictEqual(lvl, oldTree, 'first level differs for ' + dir);
  }
  const oldKnow = T.getFolderTree(path.join(root, 'know'), root, null);
  const g0old = oldKnow.find(x => x.name === 'g0').children.map(strip);
  const g0new = (await T.getFolderLevel(path.join(root, 'know', 'g0'), root, null)).map(strip);
  assert.deepStrictEqual(g0new, g0old);
  console.log('PASS equivalence (first level + a nested level; image-only folder pruned; hidden/node_modules skipped)');

  const lvl1 = await T.getFolderLevel(path.join(root, 'know'), root, null);
  assert(lvl1.filter(x => x.type === 'directory').every(x => x.hasChildren === true && x.children === undefined));
  console.log('PASS directories carry hasChildren and no children');

  // --- path validation
  const bad = [
    ['know', '../secret'], ['know', '..'], ['know', 'know/g0/../../secret'], ['worktable', '../know'],
    ['know', path.resolve(root, 'secret')], ['know', 'know/node_modules'], ['know', 'know/.hidden'], ['nope', ''],
  ];
  for (const [sec, p] of bad) {
    const r = await T.resolveTreeDir(wctx, manifest, sec, p);
    assert(r.error, 'should refuse ' + sec + ' ' + p);
  }
  assert((await T.resolveTreeDir(wctx, manifest, 'know', 'know/g0')).dir);
  assert((await T.resolveTreeDir(wctx, manifest, 'worktable', '.worktable/history')).dir);
  assert((await T.resolveTreeDir(wctx, manifest, '知識', 'know')).dir);
  assert((await T.resolveTreeDir(wctx, manifest, 'know', '')).dir);
  console.log('PASS path escape refused (../, absolute, hidden, skip dirs, unknown section); valid paths accepted');

  try {
    fs.symlinkSync(path.join(root, 'secret'), path.join(root, 'know', 'link'), 'junction');
    const r = await T.resolveTreeDir(wctx, manifest, 'know', 'know/link');
    assert(r.error, 'junction escape should be refused');
    console.log('PASS junction pointing outside the section refused');
  } catch (e) { if (e.code === 'ERR_ASSERTION') throw e; console.log('SKIP symlink test:', e.code || e.message); }

  // --- search
  const found = []; await T.searchFolderTree(path.join(root, 'know'), root, null, 'f19', found, 200);
  assert(found.length === 200);
  const found2 = []; await T.searchFolderTree(path.join(root, 'know'), root, null, 'top', found2, 200);
  assert(found2.length === 1 && found2[0].name === 'top.md');
  console.log('PASS search (cap 200, hit by name)');

  // --- timing: what /api/status builds for this workspace
  const secs = [['know', null], ['pres', '*.html']];
  const runOld = () => { T.getFolderTree(wt, root); secs.forEach(([p, f]) => T.getFolderTree(path.join(root, p), root, f)); };
  const runNew = async () => { await Promise.all([T.getFolderLevel(wt, root), ...secs.map(([p, f]) => T.getFolderLevel(path.join(root, p), root, f))]); };
  runOld(); await runNew();
  const med = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const to = [], tn = [];
  for (let i = 0; i < 7; i++) { let t = hrt(); runOld(); to.push(hrt() - t); t = hrt(); await runNew(); tn.push(hrt() - t); }
  const sizeOld = JSON.stringify(T.getFolderTree(path.join(root, 'know'), root, null)).length;
  const sizeNew = JSON.stringify(await T.getFolderLevel(path.join(root, 'know'), root, null)).length;
  console.log('TIMING tree build (' + n + ' files, warm): old ' + med(to).toFixed(1) + ' ms -> new ' + med(tn).toFixed(1) + ' ms; know JSON ' + sizeOld + ' B -> ' + sizeNew + ' B');
  fs.rmSync(root, { recursive: true, force: true });
  console.log('ALL PASS');
})().catch(e => { console.error('FAIL', e); process.exit(1); });

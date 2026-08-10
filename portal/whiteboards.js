'use strict';
// Whiteboard persistence — SPEC-whiteboard.md §5. Unlike notes.js/pm.js (one global file under
// HARNESS_HOME, workspace-tagged), whiteboards are a genuinely PER-WORKSPACE directory tree
// (天條: only ever written under <workspace>/.harness/whiteboards/) — Charles's boards for one
// client project must never leak into another workspace's list.
const fs   = require('fs');
const path = require('path');

function whiteboardsDir(root) {
  return path.join(root, '.harness', 'whiteboards');
}

function indexPath(root) {
  return path.join(whiteboardsDir(root), 'index.json');
}

function boardDir(root, id) {
  return path.join(whiteboardsDir(root), id);
}

function boardPath(root, id) {
  return path.join(boardDir(root, id), 'board.json');
}

function readIndex(root) {
  const p = indexPath(root);
  try {
    if (!fs.existsSync(p)) return [];
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (e) { return []; }
}

function writeIndex(root, list) {
  const p = indexPath(root);
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch (e) {}
  fs.writeFileSync(p, JSON.stringify(list, null, 2));
}

function readBoard(root, id) {
  const p = boardPath(root, id);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function writeBoard(root, id, board) {
  const dir = boardDir(root, id);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  fs.writeFileSync(boardPath(root, id), JSON.stringify(board, null, 2));
}

function deleteBoard(root, id) {
  const dir = boardDir(root, id);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  const list = readIndex(root).filter(b => b.id !== id);
  writeIndex(root, list);
}

function genWhiteboardId() { return 'wb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

module.exports = {
  whiteboardsDir, indexPath, boardDir, boardPath,
  readIndex, writeIndex, readBoard, writeBoard, deleteBoard, genWhiteboardId
};

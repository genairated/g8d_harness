// SPEC-whiteboard.md §6 (WB2) — L1 形狀美化引擎：純前端幾何辨識，不打模型。
// 只處理「剛完成的 freedraw」：偵測某 freedraw 元素連續 450ms 沒有新增點 → 視為畫完 → 分類 →
// 信心不足一律不動。已判定過的元素 id 一律跳過（防止美化後的元素或已決定「不動」的元素被重複處理、
// 造成無限迴圈）。
//
// 範圍刻意收窄（2026-08-10）：只處理「線畫不直」「圓圈不夠圓」這兩類低風險美化——
// 開放筆跡夠直 → 拉直成 line；封閉筆跡夠圓/橢圓 → 變正。**不做任何形狀重分類**
// （不猜三角形/矩形/菱形/箭頭），避免把數字「2」誤判成箭頭、把梯形誤判成菱形這類
// 「美化過頭、猜錯使用者原意」的問題。

const SETTLE_MS = 450;
const RESAMPLE_N = 64;
const CLOSED_GAP_RATIO = 0.15;   // 首尾距 < 周長 * 此比例 → 視為封閉
const ELLIPSE_CV_THRESHOLD = 0.12;
const CIRCLE_AXIS_RATIO = 1.15;
const LINE_R2_THRESHOLD = 0.95;

function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

function toAbsolutePoints(el) {
  return (el.points || []).map((p) => [el.x + p[0], el.y + p[1]]);
}

function pathLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += dist(points[i - 1], points[i]);
  return len;
}

// 等距重採樣：沿弧長切成 n 個等距點，讓後續幾何判斷不受手繪速度快慢（點密度不均）影響。
function resample(points, n) {
  if (points.length < 2) return points.slice();
  const total = pathLength(points);
  if (total <= 0) return points.slice();
  const out = [points[0]];
  let segIdx = 0, segStart = points[0], accumulated = 0;
  for (let i = 1; i < n; i++) {
    const target = (total * i) / (n - 1);
    while (segIdx < points.length - 1 && accumulated + dist(points[segIdx], points[segIdx + 1]) < target) {
      accumulated += dist(points[segIdx], points[segIdx + 1]);
      segIdx++;
    }
    if (segIdx >= points.length - 1) { out.push(points[points.length - 1]); continue; }
    const segLen = dist(points[segIdx], points[segIdx + 1]) || 1e-9;
    const t = (target - accumulated) / segLen;
    const a = points[segIdx], b = points[segIdx + 1];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

function bbox(points) {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

function centroid(points) {
  const n = points.length;
  const sx = points.reduce((s, p) => s + p[0], 0);
  const sy = points.reduce((s, p) => s + p[1], 0);
  return [sx / n, sy / n];
}

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stdev(arr) {
  const m = mean(arr);
  return Math.sqrt(mean(arr.map((v) => (v - m) * (v - m))));
}

// PCA 變異解釋比例，等同「線性回歸 R²」但不受方向（垂直線）影響。
function pcaVarianceRatio(points) {
  const [cx, cy] = centroid(points);
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of points) {
    const dx = x - cx, dy = y - cy;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const n = points.length;
  sxx /= n; syy /= n; sxy /= n;
  const trace = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, (trace * trace) / 4 - det));
  const l1 = trace / 2 + disc;
  const l2 = trace / 2 - disc;
  if (l1 + l2 <= 1e-9) return 0;
  return l1 / (l1 + l2);
}

// 封閉筆跡：只判圓/橢圓，不猜多邊形。質心距變異係數夠小才算「夠圓」。
function classifyClosed(resampled) {
  const box = bbox(resampled);
  const rcentroid = centroid(resampled);
  const distances = resampled.map((p) => dist(p, rcentroid));
  const cv = stdev(distances) / (mean(distances) || 1e-9);
  if (cv < ELLIPSE_CV_THRESHOLD) {
    const axisRatio = Math.max(box.width, box.height) / (Math.min(box.width, box.height) || 1e-9);
    const isCircle = axisRatio < CIRCLE_AXIS_RATIO;
    return {
      shape: isCircle ? 'circle' : 'ellipse',
      elementType: 'ellipse',
      x: box.minX, y: box.minY, width: box.width, height: box.height,
      confidence: 1 - cv / ELLIPSE_CV_THRESHOLD
    };
  }
  return null; // 信心不足 → 不動
}

// 開放筆跡：只判直線，不猜箭頭。夠直才拉直，其餘保留 freedraw 但做平滑。
function classifyOpen(rawAbs, resampled) {
  const r2 = pcaVarianceRatio(resampled);
  if (r2 > LINE_R2_THRESHOLD) {
    return { shape: 'line', elementType: 'line', points: [rawAbs[0], rawAbs[rawAbs.length - 1]], confidence: r2 };
  }
  return { shape: 'smooth', elementType: 'freedraw', points: catmullRomSmooth(resample(rawAbs, 32)), confidence: 0.5 };
}

// Catmull-Rom 內插，把稀疏點插成平滑曲線（隨手曲線但不像直線/圓時的保底美化）。
function catmullRomSmooth(points, segmentsPerSpan) {
  segmentsPerSpan = segmentsPerSpan || 6;
  if (points.length < 3) return points.slice();
  const pts = [points[0]].concat(points, [points[points.length - 1]]);
  const out = [];
  for (let i = 1; i < pts.length - 2; i++) {
    const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2];
    for (let t = 0; t < segmentsPerSpan; t++) {
      const s = t / segmentsPerSpan;
      const s2 = s * s, s3 = s2 * s;
      const x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * s + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * s2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * s3);
      const y = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * s + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * s2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * s3);
      out.push([x, y]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

// 對外主入口：給一個 freedraw 元素，回傳分類結果或 null（不動）。
export function classifyFreedraw(el) {
  const rawAbs = toAbsolutePoints(el);
  if (rawAbs.length < 5) return null; // 點太少，資訊不足，不動
  const resampled = resample(rawAbs, RESAMPLE_N);
  const perimeter = pathLength(resampled);
  const closed = dist(rawAbs[0], rawAbs[rawAbs.length - 1]) < perimeter * CLOSED_GAP_RATIO;
  if (closed) return classifyClosed(resampled);
  return classifyOpen(rawAbs, resampled);
}

function randSeed() { return Math.floor(Math.random() * 2 ** 31); }

function baseFields(type, originalEl, overrides) {
  return Object.assign({
    id: originalEl.id,
    type,
    angle: 0,
    strokeColor: originalEl.strokeColor,
    backgroundColor: originalEl.backgroundColor || 'transparent',
    fillStyle: originalEl.fillStyle || 'solid',
    strokeWidth: originalEl.strokeWidth,
    strokeStyle: originalEl.strokeStyle,
    roughness: originalEl.roughness, // 決策 5：保留手繪粗糙風
    opacity: originalEl.opacity,
    groupIds: originalEl.groupIds || [],
    frameId: originalEl.frameId || null,
    roundness: null,
    seed: originalEl.seed || randSeed(),
    version: (originalEl.version || 1) + 1,
    versionNonce: randSeed(),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false
  }, overrides);
}

function linearElement(type, absPoints, originalEl, extra) {
  const xs = absPoints.map((p) => p[0]), ys = absPoints.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  const width = Math.max(...xs) - x || 1;
  const height = Math.max(...ys) - y || 1;
  const points = absPoints.map((p) => [p[0] - x, p[1] - y]);
  return baseFields(type, originalEl, Object.assign({
    x, y, width, height, points,
    lastCommittedPoint: null,
    startBinding: null, endBinding: null,
    startArrowhead: null, endArrowhead: null
  }, extra));
}

// 依分類結果，建出取代 freedraw 用的新元素（沿用原 id，方便 undo/badge 與後續繫結）。
export function buildReplacementElement(originalEl, result) {
  switch (result.elementType) {
    case 'ellipse':
      return baseFields('ellipse', originalEl, { x: result.x, y: result.y, width: result.width, height: result.height });
    case 'line':
      return linearElement('line', result.points, originalEl, {});
    case 'freedraw': {
      const abs = result.points;
      const xs = abs.map((p) => p[0]), ys = abs.map((p) => p[1]);
      const x = Math.min(...xs), y = Math.min(...ys);
      const width = Math.max(...xs) - x || 1;
      const height = Math.max(...ys) - y || 1;
      return baseFields('freedraw', originalEl, {
        x, y, width, height,
        points: abs.map((p) => [p[0] - x, p[1] - y]),
        pressures: [], simulatePressure: true, lastCommittedPoint: null
      });
    }
    default:
      return null;
  }
}

// createBeautifyEngine：管理 settle timer / 已判定集合 / 反悔映射；不直接操作 DOM，
// 透過 opts.onReplaced(newEl, originalEl) 回呼讓 view 層畫徽章。
export function createBeautifyEngine(opts) {
  const getApi = opts.getApi;
  const isEnabled = opts.isEnabled;
  const onReplaced = opts.onReplaced || function () {};
  const seen = new Map();   // id -> { plen, timer }
  const decided = new Set();
  const originals = new Map(); // id -> original freedraw element（供反悔）

  function reset() {
    for (const v of seen.values()) if (v.timer) clearTimeout(v.timer);
    seen.clear(); decided.clear(); originals.clear();
  }

  function onSceneChange(elements) {
    if (!isEnabled()) return;
    const ids = new Set();
    for (const el of elements) {
      if (el.type !== 'freedraw' || el.isDeleted || decided.has(el.id)) continue;
      ids.add(el.id);
      const plen = el.points ? el.points.length : 0;
      const prev = seen.get(el.id);
      if (!prev || prev.plen !== plen) {
        if (prev && prev.timer) clearTimeout(prev.timer);
        const timer = setTimeout(() => trySettle(el.id), SETTLE_MS);
        seen.set(el.id, { plen, timer });
      }
    }
    // 清掉已消失（被刪除）元素的追蹤，避免記憶體累積。
    for (const id of Array.from(seen.keys())) {
      if (!ids.has(id)) { const v = seen.get(id); if (v && v.timer) clearTimeout(v.timer); seen.delete(id); }
    }
  }

  function trySettle(id) {
    seen.delete(id);
    if (decided.has(id)) return;
    const api = getApi();
    if (!api) return;
    const elements = api.getSceneElements();
    const idx = elements.findIndex((e) => e.id === id);
    if (idx === -1) return;
    const el = elements[idx];
    if (el.type !== 'freedraw' || el.isDeleted) return;
    decided.add(id);
    let result;
    try { result = classifyFreedraw(el); } catch (e) { result = null; }
    if (!result) return; // 信心不足／不像任何形狀 → 不動
    const replacement = buildReplacementElement(el, result);
    if (!replacement) return;
    const next = elements.slice();
    next[idx] = replacement;
    originals.set(id, el);
    // commitToHistory:false — 讓這次替換併入使用者剛才畫這筆的同一個 history entry，
    // Ctrl+Z 一次即可整個退回（畫＋美化視為單一動作）。
    api.updateScene({ elements: next, commitToHistory: false });
    onReplaced(replacement, el, result);
  }

  function revertTo(id) {
    const original = originals.get(id);
    if (!original) return false;
    const api = getApi();
    if (!api) return false;
    const elements = api.getSceneElements();
    const idx = elements.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    const next = elements.slice();
    next[idx] = original;
    api.updateScene({ elements: next, commitToHistory: false });
    originals.delete(id);
    return true;
  }

  return { onSceneChange, revertTo, reset };
}

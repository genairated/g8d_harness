// SPEC-whiteboard.md §6 (WB2) — L1 形狀美化引擎：純前端幾何辨識，不打模型。
// 只處理「剛完成的 freedraw」：偵測某 freedraw 元素連續 450ms 沒有新增點 → 視為畫完 → 分類 →
// 信心不足一律不動。已判定過的元素 id 一律跳過（防止美化後的元素或已決定「不動」的元素被重複處理、
// 造成無限迴圈）。

const SETTLE_MS = 450;
const RESAMPLE_N = 64;
const CLOSED_GAP_RATIO = 0.15;   // 首尾距 < 周長 * 此比例 → 視為封閉
const ELLIPSE_CV_THRESHOLD = 0.12;
const CIRCLE_AXIS_RATIO = 1.15;
const CORNER_ANGLE_DEG_TOL = 12; // 判軸對齊的角度容差
const LINE_R2_THRESHOLD = 0.95;
const ARROW_TURN_DEG = 60;       // 折返夾角門檻（越小代表轉得越急）
const POLYGON_FIT_TOLERANCE = 0.08; // 角點連線與實際筆跡的最大殘差 / 對角線，超過視為「其實是弧線」

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

function perpendicularDistance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return dist(p, a);
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (len * len);
  const proj = [a[0] + t * dx, a[1] + t * dy];
  return dist(p, proj);
}

// Ramer–Douglas–Peucker 簡化，回傳角點清單。
function rdp(points, epsilon) {
  if (points.length < 3) return points.slice();
  let maxDist = 0, idx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], points[0], points[points.length - 1]);
    if (d > maxDist) { maxDist = d; idx = i; }
  }
  if (maxDist > epsilon) {
    const left = rdp(points.slice(0, idx + 1), epsilon);
    const right = rdp(points.slice(idx), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[points.length - 1]];
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

function angleDeg(v) { return (Math.atan2(v[1], v[0]) * 180) / Math.PI; }

function normalizeAngleDiff(deg) {
  let d = Math.abs(deg) % 180;
  if (d > 90) d = 180 - d;
  return d; // 0..90, 0 = 完全平行/軸對齊
}

// 兩向量夾角（0..180 度）。
function turnAngleDeg(inVec, outVec) {
  const dot = inVec[0] * outVec[0] + inVec[1] * outVec[1];
  const magI = Math.hypot(inVec[0], inVec[1]) || 1e-9;
  const magO = Math.hypot(outVec[0], outVec[1]) || 1e-9;
  const cos = Math.max(-1, Math.min(1, dot / (magI * magO)));
  return (Math.acos(cos) * 180) / Math.PI;
}

function dedupeClosingPoint(points, perimeter) {
  if (points.length < 3) return points;
  const first = points[0], last = points[points.length - 1];
  if (dist(first, last) < Math.max(6, perimeter * 0.03)) return points.slice(0, -1);
  return points;
}

// RDP 在真實角點附近常因遞迴分割而多留一個相鄰極近的點（同一個角被拆成兩個幾乎重合的角點）。
// 每輪找出（含首尾相接，因為是封閉多邊形）距離最近的相鄰角點對，若小於 minDist 就合併成中點，
// 直到剩 3 點或最近距離已不再小於門檻，把湊巧拆出來的假角點還原成單一真實角點。
function mergeClosePoints(points, minDist) {
  let merged = points.slice();
  let guard = 0;
  while (merged.length > 3 && guard++ < 50) {
    const n = merged.length;
    let minD = Infinity, minI = -1;
    for (let i = 0; i < n; i++) {
      const d = dist(merged[i], merged[(i + 1) % n]);
      if (d < minD) { minD = d; minI = i; }
    }
    if (minD >= minDist) break;
    const a = merged[minI], b = merged[(minI + 1) % n];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    merged = (minI === n - 1)
      ? [mid].concat(merged.slice(1, n - 1))
      : merged.slice(0, minI).concat([mid], merged.slice(minI + 2));
  }
  return merged;
}

function pointToSegmentDistance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return dist(p, a);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return dist(p, [a[0] + t * dx, a[1] + t * dy]);
}

// 角點連成的多邊形，跟實際重採樣點的最大偏離（點到最近邊的距離）。
// 偏離小 → 真的是直邊多邊形；偏離大 → RDP 只是湊巧找出幾個角點，其實是弧線（該走橢圓分支）。
function polygonFitResidual(points, corners) {
  const n = corners.length;
  let maxResidual = 0;
  for (const p of points) {
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const d = pointToSegmentDistance(p, corners[i], corners[(i + 1) % n]);
      if (d < best) best = d;
    }
    if (best > maxResidual) maxResidual = best;
  }
  return maxResidual;
}

function classifyClosed(rawAbs, resampled, simplifiedRaw, perimeter) {
  const box = bbox(resampled);
  const diagonal = Math.hypot(box.width, box.height) || 1;
  const corners = mergeClosePoints(dedupeClosingPoint(simplifiedRaw, perimeter), diagonal * 0.09);

  // 先試多邊形假設（角點數 3 或 4）：等腰/正三角形、矩形、菱形都會被 RDP 簡化成乾淨的角點，
  // 且實際筆跡緊貼角點連線（殘差小）。這一步必須早於橢圓 CV 判定——
  // 等邊/近似正方形的多邊形，質心距變異係數天生就低（角點與邊中點距離差不大），
  // 會被舊版「先判橢圓」的邏輯誤吃成圓/橢圓（含菱形、正方形）。
  if (corners.length === 3 || corners.length === 4) {
    const residual = polygonFitResidual(resampled, corners);
    if (residual < diagonal * POLYGON_FIT_TOLERANCE) {
      const fitConfidence = 1 - residual / (diagonal * POLYGON_FIT_TOLERANCE);
      if (corners.length === 3) {
        return { shape: 'triangle', elementType: 'line', points: corners.concat([corners[0]]), confidence: Math.max(0.6, fitConfidence) };
      }
      // 依相鄰邊是否軸對齊判矩形 vs 菱形。
      let axisAlignedEdges = 0;
      for (let i = 0; i < 4; i++) {
        const a = corners[i], b = corners[(i + 1) % 4];
        const deg = normalizeAngleDiff(angleDeg([b[0] - a[0], b[1] - a[1]]));
        if (deg < CORNER_ANGLE_DEG_TOL || deg > 90 - CORNER_ANGLE_DEG_TOL) axisAlignedEdges++;
      }
      const cbox = bbox(corners);
      if (axisAlignedEdges >= 3) {
        return { shape: 'rectangle', elementType: 'rectangle', x: cbox.minX, y: cbox.minY, width: cbox.width, height: cbox.height, confidence: Math.max(0.6, fitConfidence) };
      }
      return { shape: 'diamond', elementType: 'diamond', x: cbox.minX, y: cbox.minY, width: cbox.width, height: cbox.height, confidence: Math.max(0.6, fitConfidence) };
    }
    // 殘差太大：角點是湊巧找到的，實際是弧線，往下走橢圓/圓判定。
  }

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
  return null; // 信心不足／角點數不符 → 不動
}

function findArrowElbow(simplified) {
  // 在後半段找一個轉得很急（夾角小）的內部角點，視為箭羽起點。
  const total = pathLength(simplified);
  let cum = 0;
  const cumAt = [0];
  for (let i = 1; i < simplified.length; i++) { cum += dist(simplified[i - 1], simplified[i]); cumAt.push(cum); }
  for (let i = 1; i < simplified.length - 1; i++) {
    if (cumAt[i] < total * 0.5) continue; // 只看後半段
    const inVec = [simplified[i][0] - simplified[i - 1][0], simplified[i][1] - simplified[i - 1][1]];
    const outVec = [simplified[i + 1][0] - simplified[i][0], simplified[i + 1][1] - simplified[i][1]];
    const turn = 180 - turnAngleDeg(inVec, outVec); // 折返角：越接近180度代表反向回折
    if (turn < ARROW_TURN_DEG) return i;
  }
  return -1;
}

const ARROW_MIN_ELONGATION = 0.5; // 箭桿本身仍須有一定延伸方向感，避免亂塗鴉裡偶然的一個急轉被誤判成箭頭

function classifyOpen(rawAbs, resampled, simplifiedRaw) {
  // 先找箭羽轉折，而非先判直線：箭頭的主軸（長長的箭桿）本身也接近直線，
  // 整體 PCA 變異解釋比例往往一樣 > 門檻，若先判直線會把箭頭誤吃成 line（原本的 bug）。
  // 純直線不會有「後半段急轉」，所以先找箭羽不會誤傷真的直線。
  const r2 = pcaVarianceRatio(resampled);
  const elbowIdx = findArrowElbow(simplifiedRaw);
  if (elbowIdx > 0 && r2 > ARROW_MIN_ELONGATION) {
    return { shape: 'arrow', elementType: 'arrow', points: [simplifiedRaw[0], simplifiedRaw[elbowIdx]], confidence: 0.75 };
  }
  if (r2 > LINE_R2_THRESHOLD) {
    return { shape: 'line', elementType: 'line', points: [rawAbs[0], rawAbs[rawAbs.length - 1]], confidence: r2 };
  }
  return { shape: 'smooth', elementType: 'freedraw', points: catmullRomSmooth(resample(rawAbs, 32)), confidence: 0.5 };
}

// Catmull-Rom 內插，把稀疏點插成平滑曲線（隨手曲線但不像任何規則形狀時的保底美化）。
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
  const box = bbox(resampled);
  const diagonal = Math.hypot(box.width, box.height) || 1;
  const simplified = rdp(resampled, diagonal * 0.05);
  const perimeter = pathLength(resampled);
  const closed = dist(rawAbs[0], rawAbs[rawAbs.length - 1]) < perimeter * CLOSED_GAP_RATIO;
  if (closed) return classifyClosed(rawAbs, resampled, simplified, perimeter);
  return classifyOpen(rawAbs, resampled, simplified);
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
    case 'rectangle':
      return baseFields('rectangle', originalEl, { x: result.x, y: result.y, width: result.width, height: result.height });
    case 'diamond':
      return baseFields('diamond', originalEl, { x: result.x, y: result.y, width: result.width, height: result.height });
    case 'line':
      return linearElement('line', result.points, originalEl, {});
    case 'arrow':
      return linearElement('arrow', result.points, originalEl, { endArrowhead: 'arrow' });
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

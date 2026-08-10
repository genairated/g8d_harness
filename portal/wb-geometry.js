// SPEC-whiteboard.md §8.3.2 (WB5/WB-21) — 幾何交集用算的，不是用猜的。
// 純函式庫（無 DOM / 無外部套件依賴），CommonJS，供 Hana 在 /whiteboard 技能執行期間用
// `node portal/wb-geometry.js '<json>'` 直接呼叫，不必每次重新推導三角函數。
// 座標系：與 Excalidraw 場景座標一致（x 向右、y 向下）；角度單位一律用弧度（Math.atan2 等原生輸出）。
'use strict';

// 線段（p1→p2）與圓（心 c、半徑 r）的真實交點，只回傳落在「線段內」（t∈[0,1]）的交點，
// 依 t 由小到大排序，0~2 個交點（相切算 1 個）。
function lineCircleIntersections(p1, p2, c, r) {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const fx = p1.x - c.x, fy = p1.y - c.y;
  const a = dx * dx + dy * dy;
  if (a === 0) return [];
  const b = 2 * (fx * dx + fy * dy);
  const cc = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * cc;
  if (disc < 0) return [];
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  const t2 = (-b + sq) / (2 * a);
  const hits = [];
  for (const t of [t1, t2]) {
    if (t >= -1e-9 && t <= 1 + 1e-9) {
      const tc = Math.min(1, Math.max(0, t));
      hits.push({ x: p1.x + dx * tc, y: p1.y + dy * tc, t: tc });
    }
  }
  hits.sort((a, b) => a.t - b.t);
  if (hits.length === 2 && Math.abs(hits[0].t - hits[1].t) < 1e-6) hits.length = 1; // 相切去重
  return hits.map(p => ({ x: p.x, y: p.y }));
}

// 線段與橢圓（心 cx,cy、半軸 rx,ry、旋轉 rotation 弧度）的真實交點：轉換到「單位圓空間」解，
// 再把結果轉回世界座標——比直接解橢圓二次式簡單、且能重用 lineCircleIntersections。
function lineEllipseIntersections(p1, p2, cx, cy, rx, ry, rotation) {
  rotation = rotation || 0;
  const cos = Math.cos(rotation), sin = Math.sin(rotation);
  const toLocal = (p) => {
    const dx = p.x - cx, dy = p.y - cy;
    const lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos; // 反旋轉
    return { x: lx / rx, y: ly / ry };
  };
  const toWorld = (p) => {
    const sx = p.x * rx, sy = p.y * ry;
    return { x: sx * cos - sy * sin + cx, y: sx * sin + sy * cos + cy };
  };
  const localHits = lineCircleIntersections(toLocal(p1), toLocal(p2), { x: 0, y: 0 }, 1);
  return localHits.map(toWorld);
}

// 圓弧等角取樣：從 startAngle 到 endAngle（弧度），依 opts.stepDeg（預設 3°）取樣。
// opts.short（預設 true）＝走角度差較小的那個方向（劣弧）；false＝走另一個方向（優弧）。
function sampleCircleArc(c, r, startAngle, endAngle, opts) {
  opts = opts || {};
  const stepDeg = opts.stepDeg || 3;
  const step = stepDeg * Math.PI / 180;
  let delta = endAngle - startAngle;
  while (delta > Math.PI * 2) delta -= Math.PI * 2;
  while (delta < -Math.PI * 2) delta += Math.PI * 2;
  const short = opts.short !== false;
  if (short) {
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
  } else {
    if (delta >= 0 && delta < Math.PI) delta -= Math.PI * 2;
    if (delta < 0 && delta > -Math.PI) delta += Math.PI * 2;
  }
  const n = Math.max(1, Math.round(Math.abs(delta) / step));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = startAngle + delta * (i / n);
    pts.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
  }
  return pts;
}

// 橢圓弧取樣：在「單位圓參數空間」等角取樣後轉回世界座標，確保是真實橢圓弧（非圓弧硬套橢圓縮放）。
function sampleEllipseArc(cx, cy, rx, ry, rotation, startAngle, endAngle, opts) {
  rotation = rotation || 0;
  const localPts = sampleCircleArc({ x: 0, y: 0 }, 1, startAngle, endAngle, opts);
  const cos = Math.cos(rotation), sin = Math.sin(rotation);
  return localPts.map(p => {
    const sx = p.x * rx, sy = p.y * ry;
    return { x: sx * cos - sy * sin + cx, y: sx * sin + sy * cos + cy };
  });
}

// 把一串世界座標點收斂成 Excalidraw `line` 元素需要的 {x,y,width,height,points}
// （points 相對 x/y，首尾自動閉合）。extra 可覆蓋/補上 strokeColor 等其餘欄位。
function toClosedLineElement(points, extra) {
  if (!points.length) throw new Error('toClosedLineElement: 至少需要 1 個點');
  const first = points[0], last = points[points.length - 1];
  const closed = points.slice();
  if (Math.hypot(first.x - last.x, first.y - last.y) > 1e-6) closed.push({ x: first.x, y: first.y });
  const xs = closed.map(p => p.x), ys = closed.map(p => p.y);
  const minX = Math.min.apply(null, xs), minY = Math.min.apply(null, ys);
  const maxX = Math.max.apply(null, xs), maxY = Math.max.apply(null, ys);
  return Object.assign({
    type: 'line',
    x: minX, y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
    points: closed.map(p => [p.x - minX, p.y - minY]),
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    roughness: 1
  }, extra || {});
}

// 便利函式：直邊切圓形成的「弓形」（一邊直的弦、一邊圓弧）——這正是本 spec §8.3 動機案例的形狀
// （「三角形一條邊切過圓」）。chordP1/chordP2＝直邊與圓的交點（用 lineCircleIntersections 先算出來，
// 或本來就已知的圓上兩點）；side:'minor'（劣弧，較小那塊弓形，預設）｜'major'（優弧，較大那塊）。
function circularSegment(c, r, chordP1, chordP2, opts) {
  opts = opts || {};
  const a1 = Math.atan2(chordP1.y - c.y, chordP1.x - c.x);
  const a2 = Math.atan2(chordP2.y - c.y, chordP2.x - c.x);
  const arcPts = sampleCircleArc(c, r, a1, a2, { stepDeg: opts.stepDeg || 3, short: (opts.side || 'minor') === 'minor' });
  // 弧的頭尾本來就是交點本身，去掉重複避免 0 長度線段，換成呼叫者給的精確 chordP1/chordP2。
  const pts = [chordP1].concat(arcPts.slice(1, -1)).concat([chordP2]);
  return toClosedLineElement(pts, opts.extra);
}

module.exports = {
  lineCircleIntersections,
  lineEllipseIntersections,
  sampleCircleArc,
  sampleEllipseArc,
  toClosedLineElement,
  circularSegment
};

// CLI：node portal/wb-geometry.js '<json>' —— 不必自己寫 script，丟參數就能拿到結果（stdout 純 JSON）。
// 支援的 op：lineCircleIntersections / lineEllipseIntersections / sampleCircleArc / sampleEllipseArc / circularSegment
// 範例（見 .harness/commands/whiteboard.md §4）：
//   node portal/wb-geometry.js "{\"op\":\"circularSegment\",\"center\":{\"x\":300,\"y\":200},\"r\":100,\"p1\":{\"x\":220,\"y\":140},\"p2\":{\"x\":360,\"y\":180},\"side\":\"minor\"}"
if (require.main === module) {
  try {
    const arg = process.argv[2];
    if (!arg) throw new Error('用法：node wb-geometry.js \'{"op":"circularSegment",...}\'');
    const input = JSON.parse(arg);
    const fns = module.exports;
    let result;
    switch (input.op) {
      case 'lineCircleIntersections':
        result = fns.lineCircleIntersections(input.p1, input.p2, input.center, input.r);
        break;
      case 'lineEllipseIntersections':
        result = fns.lineEllipseIntersections(input.p1, input.p2, input.cx, input.cy, input.rx, input.ry, input.rotation || 0);
        break;
      case 'sampleCircleArc':
        result = fns.sampleCircleArc(input.center, input.r, input.startAngle, input.endAngle, input.opts || {});
        break;
      case 'sampleEllipseArc':
        result = fns.sampleEllipseArc(input.cx, input.cy, input.rx, input.ry, input.rotation || 0, input.startAngle, input.endAngle, input.opts || {});
        break;
      case 'circularSegment':
        result = fns.circularSegment(input.center, input.r, input.p1, input.p2, input.opts || {});
        break;
      default:
        throw new Error('未知 op：' + input.op);
    }
    process.stdout.write(JSON.stringify(result));
  } catch (e) {
    process.stderr.write('錯誤：' + e.message + '\n');
    process.exit(1);
  }
}

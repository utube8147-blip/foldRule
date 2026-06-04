// hooks/magicFill/planarGraph.ts
'use client';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Segment {
  x1: number; y1: number;
  x2: number; y2: number;
}

interface Node {
  id: number;
  x: number;
  y: number;
  edges: number[];
}

interface Edge {
  id: number;
  a: number;
  b: number;
}

export interface PlanarGraph {
  nodes: Node[];
  edges: Edge[];
  nodeIndex: SpatialNodeIndex;
  edgeIndex: SpatialEdgeIndex;
  bounds: { x: number; y: number; w: number; h: number };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SNAP_EPS       = 1.5;
const MIN_EDGE_LEN   = 1.0;
const GRID_CELL      = 40;
const MAX_FACE_EDGES = 512;

// ── Spatial index for nodes ───────────────────────────────────────────────────

interface SpatialNodeIndex {
  cells: Map<number, number[]>;
  cellSize: number;
  originX: number;
  originY: number;
}

function makeNodeIndex(originX: number, originY: number): SpatialNodeIndex {
  return { cells: new Map(), cellSize: GRID_CELL, originX, originY };
}

function nodeCell(idx: SpatialNodeIndex, x: number, y: number): number {
  const col = Math.floor((x - idx.originX) / idx.cellSize);
  const row = Math.floor((y - idx.originY) / idx.cellSize);
  return row * 1_000_000 + col;
}

function indexNode(idx: SpatialNodeIndex, nodeId: number, x: number, y: number) {
  const key = nodeCell(idx, x, y);
  const arr = idx.cells.get(key);
  if (arr) arr.push(nodeId);
  else idx.cells.set(key, [nodeId]);
}

function findNearbyNodeIds(idx: SpatialNodeIndex, x: number, y: number, eps: number): number[] {
  const result: number[] = [];
  const r = Math.ceil(eps / idx.cellSize);
  const col0 = Math.floor((x - idx.originX) / idx.cellSize);
  const row0 = Math.floor((y - idx.originY) / idx.cellSize);
  for (let dr = -r; dr <= r; dr++) {
    for (let dc = -r; dc <= r; dc++) {
      const key = (row0 + dr) * 1_000_000 + (col0 + dc);
      const arr = idx.cells.get(key);
      if (arr) for (const id of arr) result.push(id);
    }
  }
  return result;
}

// ── Spatial index for edges ───────────────────────────────────────────────────

interface SpatialEdgeIndex {
  cells: Map<number, number[]>;
  cellSize: number;
  originX: number;
  originY: number;
}

function makeEdgeIndex(originX: number, originY: number): SpatialEdgeIndex {
  return { cells: new Map(), cellSize: GRID_CELL, originX, originY };
}

function indexEdge(
  idx: SpatialEdgeIndex,
  edgeId: number,
  x1: number, y1: number,
  x2: number, y2: number,
) {
  const cs = idx.cellSize;
  const col1 = Math.floor((Math.min(x1, x2) - idx.originX) / cs);
  const col2 = Math.floor((Math.max(x1, x2) - idx.originX) / cs);
  const row1 = Math.floor((Math.min(y1, y2) - idx.originY) / cs);
  const row2 = Math.floor((Math.max(y1, y2) - idx.originY) / cs);
  const seen = new Set<number>();
  for (let r = row1; r <= row2; r++) {
    for (let c = col1; c <= col2; c++) {
      const key = r * 1_000_000 + c;
      if (seen.has(key)) continue;
      seen.add(key);
      const arr = idx.cells.get(key);
      if (arr) arr.push(edgeId);
      else idx.cells.set(key, [edgeId]);
    }
  }
}

function edgesNear(idx: SpatialEdgeIndex, x: number, y: number, radius: number): number[] {
  const cs = idx.cellSize;
  const r  = Math.ceil(radius / cs);
  const col0 = Math.floor((x - idx.originX) / cs);
  const row0 = Math.floor((y - idx.originY) / cs);
  const result: number[] = [];
  const seen = new Set<number>();
  for (let dr = -r; dr <= r; dr++) {
    for (let dc = -r; dc <= r; dc++) {
      const key = (row0 + dr) * 1_000_000 + (col0 + dc);
      const arr = idx.cells.get(key);
      if (!arr) continue;
      for (const id of arr) {
        if (!seen.has(id)) { seen.add(id); result.push(id); }
      }
    }
  }
  return result;
}

// ── Transform resolution ──────────────────────────────────────────────────────

function resolveTransform(el: Element): DOMMatrix {
  const chain: Element[] = [];
  let cur: Element | null = el;
  while (cur && cur.tagName.toLowerCase() !== 'svg') {
    chain.unshift(cur);
    cur = cur.parentElement;
  }
  let m = new DOMMatrix();
  for (const node of chain) {
    const transformAttr = node.getAttribute('transform');
    if (!transformAttr) continue;
    try {
      const local = new DOMMatrix(transformAttr);
      m = m.multiply(local);
    } catch {
      m = m.multiply(parseSvgTransform(transformAttr));
    }
  }
  return m;
}

function parseSvgTransform(t: string): DOMMatrix {
  let m = new DOMMatrix();
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(t)) !== null) {
    const fn   = match[1];
    const args = match[2].trim().split(/[\s,]+/).map(Number);
    switch (fn) {
      case 'matrix':
        if (args.length >= 6)
          m = m.multiply(new DOMMatrix([args[0], args[1], args[2], args[3], args[4], args[5]]));
        break;
      case 'translate': {
        const tx = args[0] ?? 0, ty = args[1] ?? 0;
        m = m.multiply(new DOMMatrix([1, 0, 0, 1, tx, ty]));
        break;
      }
      case 'scale': {
        const sx = args[0] ?? 1, sy = args[1] ?? sx;
        m = m.multiply(new DOMMatrix([sx, 0, 0, sy, 0, 0]));
        break;
      }
      case 'rotate': {
        const deg = args[0] ?? 0;
        const cx  = args[1] ?? 0, cy = args[2] ?? 0;
        const rad = (deg * Math.PI) / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        m = m.multiply(new DOMMatrix([1, 0, 0, 1, cx, cy]));
        m = m.multiply(new DOMMatrix([cos, sin, -sin, cos, 0, 0]));
        m = m.multiply(new DOMMatrix([1, 0, 0, 1, -cx, -cy]));
        break;
      }
      case 'skewX': {
        const angle = (args[0] ?? 0) * Math.PI / 180;
        m = m.multiply(new DOMMatrix([1, 0, Math.tan(angle), 1, 0, 0]));
        break;
      }
      case 'skewY': {
        const angle = (args[0] ?? 0) * Math.PI / 180;
        m = m.multiply(new DOMMatrix([1, Math.tan(angle), 0, 1, 0, 0]));
        break;
      }
    }
  }
  return m;
}

// ── SVG path → raw points ─────────────────────────────────────────────────────

function pathToPoints(d: string): [number, number][] {
  const pts: [number, number][] = [];
  const re = /([MLHVCSQTAZmlhvcsqtaz])([^MLHVCSQTAZmlhvcsqtaz]*)/g;
  let m: RegExpExecArray | null;
  let cx = 0, cy = 0, startX = 0, startY = 0;
  const nums = (s: string) =>
    [...s.matchAll(/[-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/g)].map(Number);

  while ((m = re.exec(d)) !== null) {
    const cmd  = m[1];
    const args = nums(m[2]);
    switch (cmd) {
      case 'M': for (let i = 0; i < args.length; i += 2) { cx=args[i]; cy=args[i+1]; if(i===0){startX=cx;startY=cy;} pts.push([cx,cy]); } break;
      case 'm': for (let i = 0; i < args.length; i += 2) { cx+=args[i]; cy+=args[i+1]; if(i===0){startX=cx;startY=cy;} pts.push([cx,cy]); } break;
      case 'L': for (let i = 0; i < args.length; i += 2) { cx=args[i]; cy=args[i+1]; pts.push([cx,cy]); } break;
      case 'l': for (let i = 0; i < args.length; i += 2) { cx+=args[i]; cy+=args[i+1]; pts.push([cx,cy]); } break;
      case 'H': for (const x of args) { cx=x; pts.push([cx,cy]); } break;
      case 'h': for (const x of args) { cx+=x; pts.push([cx,cy]); } break;
      case 'V': for (const y of args) { cy=y; pts.push([cx,cy]); } break;
      case 'v': for (const y of args) { cy+=y; pts.push([cx,cy]); } break;
      case 'Z': case 'z': pts.push([startX,startY]); cx=startX; cy=startY; break;
      case 'C': for (let i = 0; i < args.length; i += 6) { cx=args[i+4]; cy=args[i+5]; pts.push([cx,cy]); } break;
      case 'c': for (let i = 0; i < args.length; i += 6) { cx+=args[i+4]; cy+=args[i+5]; pts.push([cx,cy]); } break;
      case 'S': for (let i = 0; i < args.length; i += 4) { cx=args[i+2]; cy=args[i+3]; pts.push([cx,cy]); } break;
      case 's': for (let i = 0; i < args.length; i += 4) { cx+=args[i+2]; cy+=args[i+3]; pts.push([cx,cy]); } break;
      case 'Q': for (let i = 0; i < args.length; i += 4) { cx=args[i+2]; cy=args[i+3]; pts.push([cx,cy]); } break;
      case 'q': for (let i = 0; i < args.length; i += 4) { cx+=args[i+2]; cy+=args[i+3]; pts.push([cx,cy]); } break;
      case 'T': for (let i = 0; i < args.length; i += 2) { cx=args[i]; cy=args[i+1]; pts.push([cx,cy]); } break;
      case 't': for (let i = 0; i < args.length; i += 2) { cx+=args[i]; cy+=args[i+1]; pts.push([cx,cy]); } break;
      case 'A': for (let i = 0; i < args.length; i += 7) { cx=args[i+5]; cy=args[i+6]; pts.push([cx,cy]); } break;
      case 'a': for (let i = 0; i < args.length; i += 7) { cx+=args[i+5]; cy+=args[i+6]; pts.push([cx,cy]); } break;
    }
  }
  return pts;
}

function pointsToSegments(
  pts: [number, number][],
  scale: number,
  matrix?: DOMMatrix,
): Segment[] {
  const segs: Segment[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    let x1 = pts[i][0],   y1 = pts[i][1];
    let x2 = pts[i+1][0], y2 = pts[i+1][1];
    if (matrix && !matrix.isIdentity) {
      const p1 = matrix.transformPoint({ x: x1, y: y1 });
      const p2 = matrix.transformPoint({ x: x2, y: y2 });
      x1 = p1.x; y1 = p1.y;
      x2 = p2.x; y2 = p2.y;
    }
    x1 *= scale; y1 *= scale;
    x2 *= scale; y2 *= scale;
    if (Math.hypot(x2 - x1, y2 - y1) >= MIN_EDGE_LEN)
      segs.push({ x1, y1, x2, y2 });
  }
  return segs;
}

// ── Extract all segments from SVG ─────────────────────────────────────────────

export function extractAllSegments(svgDoc: Document, scale: number): Segment[] {
  const segs: Segment[] = [];
  const svgEl = svgDoc.querySelector('svg');
  if (!svgEl) return segs;

  const TAGS = ['path','rect','line','polyline','polygon','circle','ellipse'];
  svgDoc.querySelectorAll(TAGS.join(',')).forEach(el => {
    const tag = el.tagName.toLowerCase();
    let pts: [number, number][] = [];

    if (tag === 'line') {
      const e = el as SVGLineElement;
      pts = [[e.x1.baseVal.value, e.y1.baseVal.value],[e.x2.baseVal.value, e.y2.baseVal.value]];
    } else if (tag === 'rect') {
      const e = el as SVGRectElement;
      const x = e.x.baseVal.value, y = e.y.baseVal.value;
      const w = e.width.baseVal.value, h = e.height.baseVal.value;
      if (w > 0 && h > 0) pts = [[x,y],[x+w,y],[x+w,y+h],[x,y+h],[x,y]];
    } else if (tag === 'circle') {
      const e = el as SVGCircleElement;
      const cx = e.cx.baseVal.value, cy = e.cy.baseVal.value, r = e.r.baseVal.value;
      if (r > 0) {
        const N = Math.max(12, Math.round(2 * Math.PI * r / 4));
        for (let i = 0; i <= N; i++) {
          const a = (2 * Math.PI * i) / N;
          pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
        }
      }
    } else if (tag === 'ellipse') {
      const e = el as SVGEllipseElement;
      const cx = e.cx.baseVal.value, cy = e.cy.baseVal.value;
      const rx = e.rx.baseVal.value, ry = e.ry.baseVal.value;
      if (rx > 0 && ry > 0) {
        const N = Math.max(12, Math.round(2 * Math.PI * Math.max(rx,ry) / 4));
        for (let i = 0; i <= N; i++) {
          const a = (2 * Math.PI * i) / N;
          pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
        }
      }
    } else if (tag === 'polyline' || tag === 'polygon') {
      const e = el as SVGPolylineElement;
      for (let i = 0; i < e.points.length; i++) {
        const p = e.points.getItem(i);
        pts.push([p.x, p.y]);
      }
      if (tag === 'polygon' && pts.length > 0) pts.push(pts[0]);
    } else if (tag === 'path') {
      const d = (el as SVGPathElement).getAttribute('d');
      if (d) pts = pathToPoints(d);
    }

    if (pts.length === 0) return;
    const matrix = resolveTransform(el);
    segs.push(...pointsToSegments(pts, scale, matrix));
  });

  return segs;
}

// ── Deduplicate near-identical segments ───────────────────────────────────────

function deduplicateSegments(segs: Segment[], tol: number): Segment[] {
  const snap = (v: number) => Math.round(v / tol) * tol;
  const seen = new Set<string>();
  const out: Segment[] = [];
  for (const s of segs) {
    let ax = snap(s.x1), ay = snap(s.y1), bx = snap(s.x2), by = snap(s.y2);
    if (ax > bx || (ax === bx && ay > by)) {
      [ax, bx] = [bx, ax];
      [ay, by] = [by, ay];
    }
    const key = `${ax},${ay}|${bx},${by}`;
    if (!seen.has(key)) { seen.add(key); out.push(s); }
  }
  return out;
}

// ── Snap endpoints to nearby segment interiors (T-junction repair) ────────────

function snapEndpointsToSegments(segs: Segment[], snapDist: number): Segment[] {
  const out: Segment[] = segs.map(s => ({ ...s }));
  const extra: Segment[] = [];

  for (let i = 0; i < out.length; i++) {
    for (let j = 0; j < out.length; j++) {
      if (i === j) continue;
      const s = out[j];
      const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-10) continue;

      for (const isA of [true, false] as const) {
        const ex = isA ? out[i].x1 : out[i].x2;
        const ey = isA ? out[i].y1 : out[i].y2;
        const t = ((ex - s.x1) * dx + (ey - s.y1) * dy) / len2;
        if (t <= 1e-6 || t >= 1 - 1e-6) continue;
        const px = s.x1 + t * dx, py = s.y1 + t * dy;
        const dist = Math.hypot(ex - px, ey - py);
        if (dist > 0 && dist < snapDist) {
          if (isA) { out[i] = { ...out[i], x1: px, y1: py }; }
          else      { out[i] = { ...out[i], x2: px, y2: py }; }
          extra.push({ x1: s.x1, y1: s.y1, x2: px,  y2: py  });
          extra.push({ x1: px,   y1: py,   x2: s.x2, y2: s.y2 });
          out[j] = { x1: 0, y1: 0, x2: 0, y2: 0 };
        }
      }
    }
  }

  return [...out, ...extra].filter(s =>
    Math.hypot(s.x2 - s.x1, s.y2 - s.y1) >= MIN_EDGE_LEN,
  );
}

// ── Segment intersection ──────────────────────────────────────────────────────

function segIntersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): { t: number; u: number } | null {
  const denom = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / denom;
  const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / denom;
  const EPS = 1e-6;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return { t: Math.max(0, Math.min(1, t)), u: Math.max(0, Math.min(1, u)) };
}

// ── Segment subdivision ───────────────────────────────────────────────────────

function subdivideSegments(segs: Segment[]): Segment[] {
  if (segs.length === 0) return [];

  let minX = Infinity, minY = Infinity;
  for (const s of segs) {
    minX = Math.min(minX, s.x1, s.x2);
    minY = Math.min(minY, s.y1, s.y2);
  }

  const CELL = GRID_CELL * 2;
  const grid = new Map<number, number[]>();
  const cellKey = (col: number, row: number) => row * 1_000_000 + col;
  const addToGrid = (i: number, s: Segment) => {
    const c1 = Math.floor((Math.min(s.x1, s.x2) - minX) / CELL);
    const c2 = Math.floor((Math.max(s.x1, s.x2) - minX) / CELL);
    const r1 = Math.floor((Math.min(s.y1, s.y2) - minY) / CELL);
    const r2 = Math.floor((Math.max(s.y1, s.y2) - minY) / CELL);
    for (let r = r1; r <= r2; r++)
      for (let c = c1; c <= c2; c++) {
        const k = cellKey(c, r);
        const arr = grid.get(k);
        if (arr) arr.push(i); else grid.set(k, [i]);
      }
  };
  segs.forEach((s, i) => addToGrid(i, s));

  const splits: number[][] = segs.map(() => [0, 1]);
  const checked = new Set<number>();

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const c1 = Math.floor((Math.min(s.x1, s.x2) - minX) / CELL);
    const c2 = Math.floor((Math.max(s.x1, s.x2) - minX) / CELL);
    const r1 = Math.floor((Math.min(s.y1, s.y2) - minY) / CELL);
    const r2 = Math.floor((Math.max(s.y1, s.y2) - minY) / CELL);

    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        const candidates = grid.get(cellKey(c, r));
        if (!candidates) continue;
        for (const j of candidates) {
          if (j <= i) continue;
          const pairKey = i * 1_000_000 + j;
          if (checked.has(pairKey)) continue;
          checked.add(pairKey);
          const t2 = segs[j];
          const hit = segIntersect(s.x1, s.y1, s.x2, s.y2, t2.x1, t2.y1, t2.x2, t2.y2);
          if (!hit) continue;
          splits[i].push(hit.t);
          splits[j].push(hit.u);
        }
      }
    }
  }

  const result: Segment[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const ts = [...new Set(splits[i])].sort((a, b) => a - b);
    for (let k = 0; k + 1 < ts.length; k++) {
      const t0 = ts[k], t1 = ts[k + 1];
      if (t1 - t0 < 1e-10) continue;
      const x1 = s.x1 + t0 * (s.x2 - s.x1), y1 = s.y1 + t0 * (s.y2 - s.y1);
      const x2 = s.x1 + t1 * (s.x2 - s.x1), y2 = s.y1 + t1 * (s.y2 - s.y1);
      if (Math.hypot(x2 - x1, y2 - y1) >= MIN_EDGE_LEN) result.push({ x1, y1, x2, y2 });
    }
  }
  return result;
}

// ── Build planar graph ────────────────────────────────────────────────────────

export function buildPlanarGraph(svgDoc: Document, scale: number): PlanarGraph {
  const svgEl = svgDoc.querySelector('svg');
  const vb = svgEl?.viewBox?.baseVal;
  const svgW = (vb?.width  && vb.width  > 0) ? vb.width  : parseFloat(svgEl?.getAttribute('width')  ?? '800') || 800;
  const svgH = (vb?.height && vb.height > 0) ? vb.height : parseFloat(svgEl?.getAttribute('height') ?? '600') || 600;
  const canvasW = Math.round(svgW * scale);
  const canvasH = Math.round(svgH * scale);

  const rawSegs  = extractAllSegments(svgDoc, scale);
  const deduped  = deduplicateSegments(rawSegs, SNAP_EPS * 2);
  const snapped  = snapEndpointsToSegments(deduped, SNAP_EPS * 4);
  const subSegs  = subdivideSegments(snapped);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of subSegs) {
    minX = Math.min(minX, s.x1, s.x2);
    minY = Math.min(minY, s.y1, s.y2);
    maxX = Math.max(maxX, s.x1, s.x2);
    maxY = Math.max(maxY, s.y1, s.y2);
  }
  if (!isFinite(minX)) minX = minY = 0;
  if (!isFinite(maxX)) maxX = maxY = 0;

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const nodeIdx = makeNodeIndex(minX - 1, minY - 1);
  const edgeIdx = makeEdgeIndex(minX - 1, minY - 1);

  const getOrCreateNode = (x: number, y: number): number => {
    const candidates = findNearbyNodeIds(nodeIdx, x, y, SNAP_EPS);
    for (const id of candidates) {
      const n = nodes[id];
      if (Math.hypot(n.x - x, n.y - y) <= SNAP_EPS) return id;
    }
    const id = nodes.length;
    nodes.push({ id, x, y, edges: [] });
    indexNode(nodeIdx, id, x, y);
    return id;
  };

  for (const s of subSegs) {
    const aId = getOrCreateNode(s.x1, s.y1);
    const bId = getOrCreateNode(s.x2, s.y2);
    if (aId === bId) continue;

    const aNode = nodes[aId];
    let duplicate = false;
    for (const eid of aNode.edges) {
      const e = edges[eid];
      if ((e.a === aId && e.b === bId) || (e.a === bId && e.b === aId)) {
        duplicate = true; break;
      }
    }
    if (duplicate) continue;

    const eid = edges.length;
    edges.push({ id: eid, a: aId, b: bId });
    nodes[aId].edges.push(eid);
    nodes[bId].edges.push(eid);
    indexEdge(edgeIdx, eid, s.x1, s.y1, s.x2, s.y2);
  }

  return {
    nodes, edges,
    nodeIndex: nodeIdx,
    edgeIndex: edgeIdx,
    bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
  };
}

// ── Face tracing ──────────────────────────────────────────────────────────────

function edgeAngle(x1: number, y1: number, x2: number, y2: number): number {
  return Math.atan2(y2 - y1, x2 - x1);
}

function normAngle(a: number): number {
  return ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
}

function mostClockwiseNeighbour(
  graph: PlanarGraph,
  nodeId: number,
  arrivalAngle: number,
  fromEdgeId: number,
): { nextEdgeId: number; nextNodeId: number } | null {
  const node = graph.nodes[nodeId];
  const reverseAngle = normAngle(arrivalAngle + Math.PI);
  let bestEdgeId = -1, bestNodeId = -1, bestDelta = -1;
  for (const eid of node.edges) {
    if (eid === fromEdgeId) continue;
    const e = graph.edges[eid];
    const nid = e.a === nodeId ? e.b : e.a;
    const nn  = graph.nodes[nid];
    const angle = normAngle(edgeAngle(node.x, node.y, nn.x, nn.y));
    const delta = normAngle(reverseAngle - angle);
    if (delta > bestDelta) { bestDelta = delta; bestEdgeId = eid; bestNodeId = nid; }
  }
  return bestEdgeId === -1 ? null : { nextEdgeId: bestEdgeId, nextNodeId: bestNodeId };
}

function findNearestEdge(
  graph: PlanarGraph,
  px: number, py: number,
  radius: number,
): { edgeId: number; closestT: number; dist: number } | null {
  const candidates = edgesNear(graph.edgeIndex, px, py, radius);
  let best: { edgeId: number; closestT: number; dist: number } | null = null;
  for (const eid of candidates) {
    const e  = graph.edges[eid];
    const na = graph.nodes[e.a];
    const nb = graph.nodes[e.b];
    const dx = nb.x - na.x, dy = nb.y - na.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-10) continue;
    const t = Math.max(0, Math.min(1, ((px - na.x) * dx + (py - na.y) * dy) / len2));
    const qx = na.x + t * dx, qy = na.y + t * dy;
    const dist = Math.hypot(px - qx, py - qy);
    if (dist <= radius && (!best || dist < best.dist))
      best = { edgeId: eid, closestT: t, dist };
  }
  return best;
}

function signedArea(poly: [number, number][]): number {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    area += poly[i][0] * poly[j][1] - poly[j][0] * poly[i][1];
  }
  return area / 2;
}

export function traceMinimumFace(
  graph: PlanarGraph,
  px: number, py: number,
): [number, number][] | null {
  if (graph.edges.length === 0) return null;

  let radius = GRID_CELL * 2;
  let nearest = findNearestEdge(graph, px, py, radius);
  while (!nearest && radius < 4000) { radius *= 2; nearest = findNearestEdge(graph, px, py, radius); }
  if (!nearest) return null;

  const { edgeId } = nearest;
  const e  = graph.edges[edgeId];
  const na = graph.nodes[e.a];
  const nb = graph.nodes[e.b];
  const cross = (nb.x - na.x) * (py - na.y) - (nb.y - na.y) * (px - na.x);

  let startNodeId: number, nextNodeId: number, startEdgeId: number, startAngle: number;
  if (cross >= 0) {
    startNodeId = e.a; nextNodeId = e.b;
    startAngle = edgeAngle(na.x, na.y, nb.x, nb.y);
  } else {
    startNodeId = e.b; nextNodeId = e.a;
    startAngle = edgeAngle(nb.x, nb.y, na.x, na.y);
  }
  startEdgeId = edgeId;

  const faceNodes: number[] = [startNodeId];
  let curNodeId = nextNodeId, curEdgeId = startEdgeId, curAngle = startAngle, steps = 0;

  while (curNodeId !== startNodeId && steps < MAX_FACE_EDGES) {
    faceNodes.push(curNodeId);
    const cur = graph.nodes[curNodeId];
    const next = mostClockwiseNeighbour(graph, curNodeId, curAngle, curEdgeId);
    if (!next) break;
    curAngle  = edgeAngle(cur.x, cur.y, graph.nodes[next.nextNodeId].x, graph.nodes[next.nextNodeId].y);
    curEdgeId = next.nextEdgeId;
    curNodeId = next.nextNodeId;
    steps++;
  }

  if (curNodeId !== startNodeId || faceNodes.length < 3) return null;

  const poly: [number, number][] = faceNodes.map(id => [graph.nodes[id].x, graph.nodes[id].y]);
  const area = signedArea(poly);

  if (area < 0) {
    const altStartNodeId = startNodeId === e.a ? e.b : e.a;
    const altNextNodeId  = startNodeId === e.a ? e.a : e.b;
    const altAngle = edgeAngle(
      graph.nodes[altStartNodeId].x, graph.nodes[altStartNodeId].y,
      graph.nodes[altNextNodeId].x,  graph.nodes[altNextNodeId].y,
    );
    const altFaceNodes: number[] = [altStartNodeId];
    let aCurNodeId = altNextNodeId, aCurEdgeId = edgeId, aCurAngle = altAngle, aSteps = 0;

    while (aCurNodeId !== altStartNodeId && aSteps < MAX_FACE_EDGES) {
      altFaceNodes.push(aCurNodeId);
      const aCur  = graph.nodes[aCurNodeId];
      const aNext = mostClockwiseNeighbour(graph, aCurNodeId, aCurAngle, aCurEdgeId);
      if (!aNext) break;
      aCurAngle  = edgeAngle(aCur.x, aCur.y, graph.nodes[aNext.nextNodeId].x, graph.nodes[aNext.nextNodeId].y);
      aCurEdgeId = aNext.nextEdgeId;
      aCurNodeId = aNext.nextNodeId;
      aSteps++;
    }

    if (aCurNodeId !== altStartNodeId || altFaceNodes.length < 3) return null;
    const altPoly: [number, number][] = altFaceNodes.map(id => [graph.nodes[id].x, graph.nodes[id].y]);
    if (signedArea(altPoly) < 0) return null;
    return altPoly;
  }

  return poly;
}

// ── Point-in-polygon (ray-cast) ───────────────────────────────────────────────

function pointInPolygon(poly: [number, number][], px: number, py: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if ((yi > py) !== (yj > py) &&
        px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// ── hitTestPlanarFace — rewritten ─────────────────────────────────────────────
//
// Old approach: 81 ring seeds (9×9 RING1 grid) + 8 normals per nearby edge,
// every seed calling traceMinimumFace (up to 512 node walks each), keeping all
// results and returning the smallest at the very end.
// Cost: O(seeds × MAX_FACE_EDGES) ≈ 50,000–300,000 node traversals per click.
//
// New approach:
//   1. Find the single nearest edge to the click point.
//   2. For each of the two perpendicular nudge distances (3px, 8px, 16px),
//      probe both sides of that edge — at most 6 traceMinimumFace calls total.
//   3. Return the first result that (a) has positive area, (b) contains the
//      click point, and (c) is within the canvas area guard.
//   4. If the nearest edge yields nothing (e.g. degenerate graph near borders),
//      fall back to a small ring of 5 offsets around the click — still only
//      5 extra traces, not 81.
//
// Cost: typically 1–3 traceMinimumFace calls = < 20 node traversals per click.
// Worst case (full fallback): ~11 traces = < 100 node traversals.

export function hitTestPlanarFace(
  graph: PlanarGraph,
  px: number, py: number,
  canvasW: number, canvasH: number,
): [number, number][] | null {
  if (!graph || graph.edges.length === 0) return null;

  const maxArea = canvasW * canvasH * 0.60;

  const isValid = (poly: [number, number][] | null): poly is [number, number][] => {
    if (!poly || poly.length < 3) return false;
    const area = Math.abs(signedArea(poly));
    if (area < 9 || area > maxArea) return false;
    if (!pointInPolygon(poly, px, py)) return false;
    return true;
  };

  // ── Step 1: find the nearest edge ─────────────────────────────────────────
  let searchR = GRID_CELL * 2;
  let nearest = findNearestEdge(graph, px, py, searchR);
  while (!nearest && searchR < 4000) {
    searchR *= 2;
    nearest = findNearestEdge(graph, px, py, searchR);
  }

  if (nearest) {
    const e  = graph.edges[nearest.edgeId];
    const na = graph.nodes[e.a];
    const nb = graph.nodes[e.b];
    const len = Math.hypot(nb.x - na.x, nb.y - na.y);

    if (len >= 1) {
      // Unit normal perpendicular to the edge
      const nx = -(nb.y - na.y) / len;
      const ny =  (nb.x - na.x) / len;

      // Probe point on the edge closest to click
      const qx = na.x + nearest.closestT * (nb.x - na.x);
      const qy = na.y + nearest.closestT * (nb.y - na.y);

      // Try both sides at increasing nudge distances.
      // We stop as soon as we find a face that contains the click.
      for (const nudge of [3, 8, 16]) {
        for (const sign of [1, -1]) {
          const sx = qx + nx * nudge * sign;
          const sy = qy + ny * nudge * sign;
          const poly = traceMinimumFace(graph, sx, sy);
          if (isValid(poly)) return poly;
        }
      }
    }
  }

  // ── Step 2: small fallback ring around the click itself ───────────────────
  // Only reached when the nearest-edge probes all missed (very rare on a
  // well-formed graph — typically only at canvas borders or isolated nodes).
  const FALLBACK_OFFSETS: [number, number][] = [
    [0, 0], [4, 0], [-4, 0], [0, 4], [0, -4],
  ];
  for (const [dx, dy] of FALLBACK_OFFSETS) {
    const poly = traceMinimumFace(graph, px + dx, py + dy);
    if (isValid(poly)) return poly;
  }

  return null;
}

// ── Graph cache: serialise / deserialise ──────────────────────────────────────

interface SerialIndexCell { key: number; ids: number[] }

interface SerialGraph {
  version: number;
  nodes: { id: number; x: number; y: number; edges: number[] }[];
  edges: { id: number; a: number; b: number }[];
  nodeIndex: { originX: number; originY: number; cellSize: number; cells: SerialIndexCell[] };
  edgeIndex: { originX: number; originY: number; cellSize: number; cells: SerialIndexCell[] };
  bounds: { x: number; y: number; w: number; h: number };
}

function serialiseIndex(idx: SpatialNodeIndex | SpatialEdgeIndex): SerialGraph['nodeIndex'] {
  const cells: SerialIndexCell[] = [];
  idx.cells.forEach((ids, key) => cells.push({ key, ids }));
  return { originX: idx.originX, originY: idx.originY, cellSize: idx.cellSize, cells };
}

function deserialiseIndex(s: SerialGraph['nodeIndex']): SpatialNodeIndex {
  const m = new Map<number, number[]>();
  for (const { key, ids } of s.cells) m.set(key, ids);
  return { cells: m, cellSize: s.cellSize, originX: s.originX, originY: s.originY };
}

export function serialiseGraph(graph: PlanarGraph): string {
  const serial: SerialGraph = {
    version: 1, nodes: graph.nodes, edges: graph.edges,
    nodeIndex: serialiseIndex(graph.nodeIndex),
    edgeIndex: serialiseIndex(graph.edgeIndex),
    bounds: graph.bounds,
  };
  return JSON.stringify(serial);
}

export function deserialiseGraph(json: string): PlanarGraph | null {
  try {
    const s: SerialGraph = JSON.parse(json);
    if (s.version !== 1) return null;
    return {
      nodes: s.nodes, edges: s.edges,
      nodeIndex: deserialiseIndex(s.nodeIndex),
      edgeIndex: deserialiseIndex(s.edgeIndex as SerialGraph['nodeIndex']),
      bounds: s.bounds,
    };
  } catch { return null; }
}

// ── Cache key ─────────────────────────────────────────────────────────────────
// v7: hitTestPlanarFace rewritten — nearest-edge probing, no ring seeds.

export function svgCacheKey(svgText: string, scale: number): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < svgText.length; i++) {
    h ^= svgText.charCodeAt(i);
    h = (Math.imul(h, 0x01000193) >>> 0);
  }
  return `planarGraph:v7:${scale}:${h.toString(16)}`;
}

// ── localStorage persistence ──────────────────────────────────────────────────

const STORAGE_DATA_PREFIX  = 'pgcache:data:';
const STORAGE_MANIFEST_KEY = 'pgcache:manifest';
const MAX_CACHED_GRAPHS    = 1;

interface ManifestEntry { key: string; ts: number }

function readManifest(): ManifestEntry[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_MANIFEST_KEY) ?? '[]'); }
  catch { return []; }
}

function writeManifest(entries: ManifestEntry[]) {
  try { localStorage.setItem(STORAGE_MANIFEST_KEY, JSON.stringify(entries)); } catch { /* quota */ }
}

export function loadCachedGraph(cacheKey: string): PlanarGraph | null {
  try {
    const raw = localStorage.getItem(STORAGE_DATA_PREFIX + cacheKey);
    if (!raw) return null;
    const graph = deserialiseGraph(raw);
    if (!graph) {
      localStorage.removeItem(STORAGE_DATA_PREFIX + cacheKey);
      writeManifest(readManifest().filter(e => e.key !== cacheKey));
      return null;
    }
    const manifest = readManifest().filter(e => e.key !== cacheKey);
    manifest.unshift({ key: cacheKey, ts: Date.now() });
    writeManifest(manifest);
    return graph;
  } catch { return null; }
}

export function saveCachedGraph(cacheKey: string, graph: PlanarGraph): void {
  try {
    const serialised = serialiseGraph(graph);
    let manifest = readManifest();
    for (const entry of manifest) localStorage.removeItem(STORAGE_DATA_PREFIX + entry.key);
    manifest = manifest.filter(e => e.key === cacheKey);
    while (manifest.length >= MAX_CACHED_GRAPHS) {
      const evict = manifest.pop()!;
      localStorage.removeItem(STORAGE_DATA_PREFIX + evict.key);
    }
    localStorage.setItem(STORAGE_DATA_PREFIX + cacheKey, serialised);
    manifest.unshift({ key: cacheKey, ts: Date.now() });
    writeManifest(manifest);
  } catch { /* QuotaExceededError or SSR */ }
}

export function clearGraphCache(): void {
  try {
    const manifest = readManifest();
    for (const { key } of manifest) localStorage.removeItem(STORAGE_DATA_PREFIX + key);
    localStorage.removeItem(STORAGE_MANIFEST_KEY);
  } catch { /* SSR */ }
}

export function graphCacheStats(): { count: number; bytesApprox: number } {
  try {
    const manifest = readManifest();
    let bytes = 0;
    for (const { key } of manifest) {
      const raw = localStorage.getItem(STORAGE_DATA_PREFIX + key);
      if (raw) bytes += raw.length * 2;
    }
    return { count: manifest.length, bytesApprox: bytes };
  } catch { return { count: 0, bytesApprox: 0 }; }
}
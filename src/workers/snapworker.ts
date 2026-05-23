// ─── workers/snapWorker.ts ────────────────────────────────────────────────────
//
// Runs entirely off the main thread via OffscreenCanvas.
//
// Message protocol (main → worker):
//
//   { type: 'init',
//     canvas:       OffscreenCanvas,   // transferred once, never sent again
//     dims:         { w, h },
//     snapPoints:   SvgSnapPoint[],
//     svgLines:     SvgLine[],
//     svgCurves:    SvgCurve[],
//     svgAreas:     SvgArea[],
//     proximityRadius: number,
//     snapThreshold:   number,
//   }
//
//   { type: 'data',                    // re-sent whenever SVG data changes
//     snapPoints:   SvgSnapPoint[],
//     svgLines:     SvgLine[],
//     svgCurves:    SvgCurve[],
//     svgAreas:     SvgArea[],
//   }
//
//   { type: 'transform',               // sent on every zoom / pan change
//     zoom: number,
//     panX: number,
//     panY: number,
//   }
//
//   { type: 'cursor',                  // sent on every pointer-move
//     x: number,   // PDF-pixel space
//     y: number,
//   }
//
//   { type: 'cursor_leave' }           // pointer left canvas
//
//   { type: 'settings',
//     snapThreshold:   number,
//     proximityRadius: number,
//     showPins:        boolean,
//     activeTool:      string,
//   }
//
//   { type: 'resize',
//     vpW: number,   // viewport CSS pixels
//     vpH: number,
//   }
//
// ─────────────────────────────────────────────────────────────────────────────

// ── Types (inlined — workers cannot import from project) ──────────────────────

interface SvgSnapPoint {
  nx: number; ny: number;
  type: string;
  shapeId: string;
  strokeWidth: number;
}

interface SvgCurve {
  type: 'cubic' | 'quadratic';
  nx1: number; ny1: number;
  ncp1x: number; ncp1y: number;
  ncp2x?: number; ncp2y?: number;
  nx2: number; ny2: number;
  shapeId: string;
  sw: number;
}

interface SvgLine {
  nx1: number; ny1: number;
  nx2: number; ny2: number;
  shapeId?: string;
}

interface SvgArea {
  points: Array<{ nx: number; ny: number }>;
  bounds: { minNX: number; minNY: number; maxNX: number; maxNY: number };
  label?: string;
  isDoor?: boolean;
}

interface PdfDims { w: number; h: number }

interface Candidate {
  x: number; y: number;
  type: string;
  shapeId?: string;
  strokeWidth?: number;
}

interface SpatialGrid {
  cells: Map<string, Candidate[]>;
  cellSize: number;
}

// ── State ─────────────────────────────────────────────────────────────────────

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

let dims: PdfDims = { w: 1, h: 1 };
let dpr  = 1;
let vpW  = 800;
let vpH  = 600;

let zoom = 1;
let panX = 0;
let panY = 0;

let cursorX: number | null = null;
let cursorY: number | null = null;

let snapPoints:  SvgSnapPoint[] = [];
let svgLines:    SvgLine[]      = [];
let svgCurves:   SvgCurve[]     = [];
let svgAreas:    SvgArea[]      = [];

let candidatesCache: Candidate[]    = [];
let spatialGrid:     SpatialGrid | null = null;

let snapThreshold   = 14;
let proximityRadius = 80;
let showPins        = true;
let activeTool      = 'linear';

let rafPending = false;

// ── Colours / constants ───────────────────────────────────────────────────────

const SVG_SNAP_COLOURS: Record<string, { dot: string; ring: string; fill: string }> = {
  endpoint:     { dot: 'rgba(245,158,11,0.85)',  ring: 'rgba(245,158,11,0.5)',  fill: '#f59e0b' },
  midpoint:     { dot: 'rgba(16,185,129,0.85)',  ring: 'rgba(16,185,129,0.5)',  fill: '#10b981' },
  centroid:     { dot: 'rgba(139,92,246,0.85)',  ring: 'rgba(139,92,246,0.5)',  fill: '#8b5cf6' },
  intersection: { dot: 'rgba(244,63,94,0.85)',   ring: 'rgba(244,63,94,0.5)',   fill: '#f43f5e' },
  'arc-center': { dot: 'rgba(34,211,238,0.90)',  ring: 'rgba(34,211,238,0.45)', fill: '#22d3ee' },
};

const SNAP_PRIORITY: Record<string, number> = {
  endpoint: 0, intersection: 1, midpoint: 2, centroid: 3,
};

const SNAP_SIZE: Record<string, number> = {
  intersection: 1.0, endpoint: 1.0, midpoint: 0.85, centroid: 0.85,
};

const LINE_COLOUR  = { base: 'rgba(56,189,248,{a})',  fill: '#38bdf8' };
const CURVE_COLOUR = { base: 'rgba(56,189,248,{a})',  fill: '#38bdf8' };
const AREA_COLOUR  = { stroke: 'rgba(251,146,60,{a})', fill: '#fb923c' };

function withAlpha(template: string, a: number): string {
  return template.replace('{a}', a.toFixed(2));
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

function closestPointOnSegment(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number,
): { x: number; y: number } {
  const ax = px - x1, ay = py - y1;
  const bx = x2 - x1, by = y2 - y1;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return { x: x1, y: y1 };
  const t = Math.max(0, Math.min(1, (ax * bx + ay * by) / len2));
  return { x: x1 + t * bx, y: y1 + t * by };
}

function closestPointOnPolygonEdge(
  x: number, y: number,
  points: Array<{ x: number; y: number }>,
): { x: number; y: number; dist: number } {
  let best = { x, y, dist: Infinity };
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    const c = closestPointOnSegment(x, y, points[i].x, points[i].y, points[j].x, points[j].y);
    const d = Math.hypot(c.x - x, c.y - y);
    if (d < best.dist) best = { x: c.x, y: c.y, dist: d };
  }
  return best;
}

function shapeIdIncludes(shapeId: string | undefined | null, term: string): boolean {
  return (shapeId ?? '').toLowerCase().includes(term);
}

// ── Bezier helpers ────────────────────────────────────────────────────────────

function cubicAt(t: number,
  p0x: number, p0y: number, p1x: number, p1y: number,
  p2x: number, p2y: number, p3x: number, p3y: number,
) {
  const u = 1 - t;
  return {
    x: u*u*u*p0x + 3*u*u*t*p1x + 3*u*t*t*p2x + t*t*t*p3x,
    y: u*u*u*p0y + 3*u*u*t*p1y + 3*u*t*t*p2y + t*t*t*p3y,
  };
}

function quadAt(t: number,
  p0x: number, p0y: number, p1x: number, p1y: number, p2x: number, p2y: number,
) {
  const u = 1 - t;
  return {
    x: u*u*p0x + 2*u*t*p1x + t*t*p2x,
    y: u*u*p0y + 2*u*t*p1y + t*t*p2y,
  };
}

// ── Spatial grid ──────────────────────────────────────────────────────────────

function buildGrid(candidates: Candidate[], cellSize: number): SpatialGrid {
  const cells = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const key = `${Math.floor(c.x / cellSize)},${Math.floor(c.y / cellSize)}`;
    let bucket = cells.get(key);
    if (!bucket) { bucket = []; cells.set(key, bucket); }
    bucket.push(c);
  }
  return { cells, cellSize };
}

function queryGrid(grid: SpatialGrid, x: number, y: number, radius: number): Candidate[] {
  const { cells, cellSize } = grid;
  const r  = Math.ceil(radius / cellSize);
  const cx = Math.floor(x / cellSize);
  const cy = Math.floor(y / cellSize);
  const out: Candidate[] = [];
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      const bucket = cells.get(`${cx + dx},${cy + dy}`);
      if (bucket) out.push(...bucket);
    }
  }
  return out;
}

// ── Rebuild candidates + grid from current snapPoints ─────────────────────────

function rebuildCandidates() {
  candidatesCache = snapPoints.map(p => ({
    x: p.nx * dims.w,
    y: p.ny * dims.h,
    type: p.type,
    strokeWidth: p.strokeWidth,
    shapeId: p.shapeId,
  }));
  spatialGrid = buildGrid(candidatesCache, proximityRadius);
}

// ── Coordinate helpers ────────────────────────────────────────────────────────

// PDF-pixel → canvas pixel (accounts for zoom, pan, dpr)
function pdfToCanvas(x: number, y: number): { x: number; y: number } {
  return {
    x: (x * zoom + panX) * dpr,
    y: (y * zoom + panY) * dpr,
  };
}

// ── Resize canvas to match viewport ──────────────────────────────────────────

function resizeCanvas() {
  if (!canvas) return;
  const tgtW = Math.round(vpW * dpr);
  const tgtH = Math.round(vpH * dpr);
  if (canvas.width !== tgtW || canvas.height !== tgtH) {
    canvas.width  = tgtW;
    canvas.height = tgtH;
  }
}

// ── Main draw function ────────────────────────────────────────────────────────

function draw() {
  if (!canvas || !ctx) return;

  resizeCanvas();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!showPins || activeTool === 'select') return;
  if (cursorX === null || cursorY === null) return;

  const prox   = proximityRadius;
  const thresh = snapThreshold;

  // cursor in viewport space (CSS px)
  const cursorVP = {
    x: cursorX * zoom + panX,
    y: cursorY * zoom + panY,
  };

  // ── 1. Bezier curves ────────────────────────────────────────────────────
  for (const curve of svgCurves) {
    const p0 = pdfToCanvas(curve.nx1   * dims.w, curve.ny1   * dims.h);
    const p1 = pdfToCanvas(curve.ncp1x * dims.w, curve.ncp1y * dims.h);
    const p3 = pdfToCanvas(curve.nx2   * dims.w, curve.ny2   * dims.h);
    const p2 = (curve.type === 'cubic' && curve.ncp2x !== undefined)
      ? pdfToCanvas(curve.ncp2x * dims.w, curve.ncp2y! * dims.h) : null;

    let minDist = Infinity;
    const STEPS = 24;
    for (let i = 0; i <= STEPS; i++) {
      const t  = i / STEPS;
      const pt = curve.type === 'cubic' && p2
        ? cubicAt(t, p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, p3.x, p3.y)
        : quadAt(t,  p0.x, p0.y, p1.x, p1.y,              p3.x, p3.y);
      const d = Math.hypot(cursorVP.x * dpr - pt.x, cursorVP.y * dpr - pt.y) / dpr;
      if (d < minDist) minDist = d;
    }
    if (minDist > prox) continue;

    const fade  = Math.max(0, 1 - minDist / prox);
    const alpha = 0.10 + fade * 0.60;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    if (curve.type === 'cubic' && p2) ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
    else                               ctx.quadraticCurveTo(p1.x, p1.y, p3.x, p3.y);
    ctx.strokeStyle = withAlpha(CURVE_COLOUR.base, alpha);
    ctx.lineWidth   = (0.5 + fade * 1.5) * dpr;
    ctx.stroke();
    ctx.restore();
  }

  // ── 2. SVG straight lines ───────────────────────────────────────────────
  const eligibleLines = svgLines.filter(line =>
    !shapeIdIncludes(line.shapeId, 'door') &&
    !shapeIdIncludes(line.shapeId, 'swing')
  );

  let nearestLine:     typeof eligibleLines[0] | null = null;
  let nearestLineDist  = prox;
  let nearestLineSnap  = { x: 0, y: 0 };

  for (const line of eligibleLines) {
    const x1 = line.nx1 * dims.w, y1 = line.ny1 * dims.h;
    const x2 = line.nx2 * dims.w, y2 = line.ny2 * dims.h;
    const c1 = pdfToCanvas(x1, y1);
    const c2 = pdfToCanvas(x2, y2);
    const cp = closestPointOnSegment(
      cursorVP.x * dpr, cursorVP.y * dpr,
      c1.x, c1.y, c2.x, c2.y,
    );
    const dist = Math.hypot(cursorVP.x * dpr - cp.x, cursorVP.y * dpr - cp.y) / dpr;
    if (dist < nearestLineDist) {
      nearestLineDist = dist;
      nearestLine     = line;
      nearestLineSnap = { x: cp.x, y: cp.y };
    }
  }

  for (const line of eligibleLines) {
    const x1 = line.nx1 * dims.w, y1 = line.ny1 * dims.h;
    const x2 = line.nx2 * dims.w, y2 = line.ny2 * dims.h;
    const c1 = pdfToCanvas(x1, y1);
    const c2 = pdfToCanvas(x2, y2);
    const cp = closestPointOnSegment(
      cursorVP.x * dpr, cursorVP.y * dpr,
      c1.x, c1.y, c2.x, c2.y,
    );
    const dist = Math.hypot(cursorVP.x * dpr - cp.x, cursorVP.y * dpr - cp.y) / dpr;
    if (dist >= prox) continue;

    const isNearest  = line === nearestLine;
    const isSnapping = isNearest && dist < thresh;
    const rawAlpha   = 1 - dist / prox;
    const lineAlpha  = isNearest ? rawAlpha : rawAlpha * 0.25;
    const lineWidth  = isSnapping ? 2.0 : isNearest ? 1.2 : 0.6;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(c1.x, c1.y);
    ctx.lineTo(c2.x, c2.y);
    ctx.strokeStyle = withAlpha(LINE_COLOUR.base, lineAlpha);
    ctx.lineWidth   = lineWidth * dpr;
    if (!isSnapping && isNearest) ctx.setLineDash([6 * dpr, 4 * dpr]);
    ctx.stroke();
    ctx.setLineDash([]);

    if (isSnapping) {
      ctx.beginPath();
      ctx.arc(nearestLineSnap.x, nearestLineSnap.y, 5 * dpr, 0, Math.PI * 2);
      ctx.fillStyle   = LINE_COLOUR.fill;
      ctx.fill();
      ctx.strokeStyle = 'white';
      ctx.lineWidth   = 1.5 * dpr;
      ctx.stroke();
    }
    ctx.restore();
  }

  // ── 3. Area outlines ────────────────────────────────────────────────────
  for (const area of svgAreas) {
    if (area.points.length < 3) continue;
    if (area.label === 'door' || area.isDoor) continue;

    const pts = area.points.map(p => pdfToCanvas(p.nx * dims.w, p.ny * dims.h));

    let distEdge = Infinity;
    let snapPt   = pts[0];
    for (let i = 0; i < pts.length; i++) {
      const j  = (i + 1) % pts.length;
      const cp = closestPointOnSegment(
        cursorVP.x * dpr, cursorVP.y * dpr,
        pts[i].x, pts[i].y, pts[j].x, pts[j].y,
      );
      const d = Math.hypot(cursorVP.x * dpr - cp.x, cursorVP.y * dpr - cp.y) / dpr;
      if (d < distEdge) { distEdge = d; snapPt = cp; }
    }
    if (distEdge > prox * 2) continue;

    const isSnapping = distEdge < thresh;
    const fade       = Math.max(0, 1 - distEdge / (prox * 2));
    const alpha      = isSnapping ? 0.90 : 0.15 + fade * 0.55;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    pts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
    ctx.closePath();
    ctx.strokeStyle = withAlpha(AREA_COLOUR.stroke, alpha);
    ctx.lineWidth   = (isSnapping ? 2.0 : 0.5 + fade * 1.5) * dpr;
    ctx.stroke();

    if (isSnapping) {
      ctx.beginPath();
      ctx.arc(snapPt.x, snapPt.y, 5 * dpr, 0, Math.PI * 2);
      ctx.fillStyle   = AREA_COLOUR.fill;
      ctx.fill();
      ctx.strokeStyle = 'white';
      ctx.lineWidth   = 1.5 * dpr;
      ctx.stroke();
    }
    ctx.restore();
  }

  // ── 4. Snap point candidates (spatial grid → O(1) lookup) ───────────────
  const eligibleCandidates = spatialGrid
    ? queryGrid(spatialGrid, cursorX, cursorY, prox).filter(c =>
        !shapeIdIncludes(c.shapeId, 'door') &&
        !shapeIdIncludes(c.shapeId, 'swing')
      )
    : candidatesCache.filter(c =>
        !shapeIdIncludes(c.shapeId, 'door') &&
        !shapeIdIncludes(c.shapeId, 'swing')
      );

  let nearestCandidate:     typeof eligibleCandidates[0] | null = null;
  let nearestCandidateDist  = Infinity;

  for (const c of eligibleCandidates) {
    const cp   = pdfToCanvas(c.x, c.y);
    const dist = Math.hypot(cursorVP.x - cp.x / dpr, cursorVP.y - cp.y / dpr);
    if (dist > prox) continue;
    const pri      = SNAP_PRIORITY[c.type] ?? 99;
    const nearPri  = nearestCandidate ? (SNAP_PRIORITY[nearestCandidate.type] ?? 99) : 99;
    const tooClose = nearestCandidate !== null && Math.abs(dist - nearestCandidateDist) < 4;
    if (
      nearestCandidate === null ||
      (tooClose && pri < nearPri) ||
      (!tooClose && dist < nearestCandidateDist)
    ) {
      nearestCandidateDist = dist;
      nearestCandidate     = c;
    }
  }

  // ── 4b. Draw nearest candidate only ─────────────────────────────────────
  if (nearestCandidate) {
    const c       = nearestCandidate;
    const col     = SVG_SNAP_COLOURS[c.type] ?? SVG_SNAP_COLOURS['endpoint'];
    const sizeMul = SNAP_SIZE[c.type] ?? 1.0;
    const dist    = nearestCandidateDist;
    const isSnap  = dist < thresh;
    const fade    = Math.max(0, 1 - dist / prox);
    const cp      = pdfToCanvas(c.x, c.y);

    ctx.save();

    if (isSnap) {
      const r  = 7 * dpr * sizeMul;
      const ch = 11 * dpr;

      ctx.beginPath();
      ctx.arc(cp.x, cp.y, r, 0, Math.PI * 2);
      ctx.fillStyle   = col.fill;
      ctx.globalAlpha = 0.25;
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.beginPath();
      ctx.arc(cp.x, cp.y, r, 0, Math.PI * 2);
      ctx.fillStyle = col.fill;
      ctx.fill();

      ctx.strokeStyle = 'white';
      ctx.lineWidth   = 2 * dpr;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(cp.x - ch, cp.y); ctx.lineTo(cp.x + ch, cp.y);
      ctx.moveTo(cp.x, cp.y - ch); ctx.lineTo(cp.x, cp.y + ch);
      ctx.strokeStyle = 'rgba(255,255,255,0.65)';
      ctx.lineWidth   = 1.5 * dpr;
      ctx.stroke();

    } else {
      const sz = (2.5 + fade * 4.5) * dpr * sizeMul;
      const a  = 0.20 + fade * 0.65;

      ctx.strokeStyle = col.dot;
      ctx.globalAlpha = a;
      ctx.lineWidth   = (0.8 + fade * 0.8) * dpr;

      ctx.beginPath();
      ctx.moveTo(cp.x - sz, cp.y); ctx.lineTo(cp.x + sz, cp.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cp.x, cp.y - sz); ctx.lineTo(cp.x, cp.y + sz);
      ctx.stroke();

      if (fade > 0.35) {
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, sz + 4 * dpr, 0, Math.PI * 2);
        ctx.strokeStyle = col.ring;
        ctx.globalAlpha = a * 0.35;
        ctx.lineWidth   = 0.8 * dpr;
        ctx.stroke();
      }

      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  // ── 5. Proximity dashed circle around cursor (only when candidate nearby) ─
  if (nearestCandidate !== null) {
    const cc = { x: cursorVP.x * dpr, y: cursorVP.y * dpr };
    ctx.save();
    ctx.beginPath();
    ctx.arc(cc.x, cc.y, prox * dpr, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(100,100,100,0.08)';
    ctx.lineWidth   = 0.8 * dpr;
    ctx.setLineDash([3 * dpr, 4 * dpr]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
}

// ── rAF-throttled redraw request ──────────────────────────────────────────────

function requestDraw() {
  if (rafPending) return;
  rafPending = true;
  // OffscreenCanvas workers don't have requestAnimationFrame.
  // Use setTimeout(0) as an equivalent micro-batch — still off main thread.
  setTimeout(() => {
    rafPending = false;
    draw();
  }, 0);
}

// ── Message handler ───────────────────────────────────────────────────────────

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;

  switch (msg.type) {

    case 'init': {
      canvas = msg.canvas as OffscreenCanvas;
      ctx    = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
      dims   = msg.dims;
      dpr    = msg.dpr ?? 1;
      vpW    = msg.vpW ?? 800;
      vpH    = msg.vpH ?? 600;
      snapThreshold   = msg.snapThreshold   ?? 14;
      proximityRadius = msg.proximityRadius ?? 80;
      showPins        = msg.showPins        ?? true;
      activeTool      = msg.activeTool      ?? 'linear';
      snapPoints  = msg.snapPoints  ?? [];
      svgLines    = msg.svgLines    ?? [];
      svgCurves   = msg.svgCurves   ?? [];
      svgAreas    = msg.svgAreas    ?? [];
      rebuildCandidates();
      resizeCanvas();
      break;
    }

    case 'data': {
      // SVG data changed (new drawing loaded etc.)
      snapPoints = msg.snapPoints ?? snapPoints;
      svgLines   = msg.svgLines   ?? svgLines;
      svgCurves  = msg.svgCurves  ?? svgCurves;
      svgAreas   = msg.svgAreas   ?? svgAreas;
      if (msg.dims) dims = msg.dims;
      rebuildCandidates();
      requestDraw();
      break;
    }

    case 'transform': {
      // Zoom or pan changed — just update the transform and redraw.
      // No recalculation needed — normalized coords are zoom-independent.
      zoom = msg.zoom;
      panX = msg.panX;
      panY = msg.panY;
      requestDraw();
      break;
    }

    case 'cursor': {
      cursorX = msg.x;
      cursorY = msg.y;
      requestDraw();
      break;
    }

    case 'cursor_leave': {
      cursorX = null;
      cursorY = null;
      requestDraw();
      break;
    }

    case 'settings': {
      if (msg.snapThreshold   !== undefined) snapThreshold   = msg.snapThreshold;
      if (msg.proximityRadius !== undefined) {
        proximityRadius = msg.proximityRadius;
        // Rebuild grid with new cell size
        spatialGrid = buildGrid(candidatesCache, proximityRadius);
      }
      if (msg.showPins   !== undefined) showPins   = msg.showPins;
      if (msg.activeTool !== undefined) activeTool = msg.activeTool;
      requestDraw();
      break;
    }

    case 'resize': {
      vpW = msg.vpW;
      vpH = msg.vpH;
      if (msg.dpr !== undefined) dpr = msg.dpr;
      resizeCanvas();
      requestDraw();
      break;
    }
  }
};
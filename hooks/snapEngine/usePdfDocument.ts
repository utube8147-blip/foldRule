'use client';

import { useState, useRef, useCallback } from 'react';
import type { PdfLine, PdfCurve, SnapPoint, PdfDimensions, PdfPageInfo } from '@/types/snapTypes';

export type PdfLoadStage =
  | 'idle'
  | 'reading-file'
  | 'parsing-pdf'
  | 'rendering-page'
  | 'extracting-geometry'
  | 'computing-snaps'
  | 'done'
  | 'error';

export interface UsePdfDocumentReturn {
  stage: PdfLoadStage;
  errorMessage: string | null;
  fileName: string;
  dims: PdfDimensions | null;
  pageInfo: PdfPageInfo | null;
  lines: PdfLine[];
  curves: PdfCurve[];
  snapPoints: SnapPoint[];
  loadFile: (file: File) => Promise<void>;
  renderToCanvas: (canvas: HTMLCanvasElement, scale?: number) => Promise<void>;
}

async function getPdfJs() {
  const pdfjs = await import('pdfjs-dist');
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url,
    ).toString();
  }
  return pdfjs;
}

function sanitizeArgs(fn: number, raw: unknown): any[] {
  if (raw == null) return [];
  if (fn === 91 && Array.isArray(raw)) {
    const [terminalOp, pathBufHolder, minMax] = raw as [number, unknown[], number[] | null];
    let pathBuffer: number[] = [];
    const pb = Array.isArray(pathBufHolder) ? pathBufHolder[0] : null;
    if (pb instanceof Float32Array || pb instanceof Float64Array) {
      pathBuffer = Array.from(pb);
    } else if (Array.isArray(pb)) {
      pathBuffer = pb.filter((n) => typeof n === 'number');
    }
    return [terminalOp, pathBuffer, minMax ?? null];
  }
  if (!Array.isArray(raw) && !(raw instanceof Float32Array) && !(raw instanceof Float64Array)) {
    return [];
  }
  const arr = Array.from(raw as ArrayLike<unknown>);
  return arr.map((item) => {
    if (typeof item === 'number') return item;
    if (Array.isArray(item) || item instanceof Float32Array || item instanceof Float64Array) {
      return Array.from(item as ArrayLike<number>).filter((n) => typeof n === 'number');
    }
    return NaN;
  });
}

async function extractOperators(page: any): Promise<{ fn: number; args: any[] }[]> {
  const opList = await page.getOperatorList();
  const result: { fn: number; args: any[] }[] = [];
  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    result.push({ fn, args: sanitizeArgs(fn, opList.argsArray[i]) });
  }
  return result;
}

// ─── Inline worker ────────────────────────────────────────────────────────────

const WORKER_SOURCE = `
const OPS = {
  dependency: 1, setLineWidth: 2, setLineCap: 3, setLineJoin: 4, setMiterLimit: 5,
  setDash: 6, setRenderingIntent: 7, setFlatness: 8, setGState: 9, save: 10,
  restore: 11, transform: 12, moveTo: 13, lineTo: 14, curveTo: 15, curveTo2: 16,
  curveTo3: 17, closePath: 18, rectangle: 19, stroke: 20, closeStroke: 21,
  fill: 22, eoFill: 23, fillStroke: 24, eoFillStroke: 25, closeFillStroke: 26,
  closeEOFillStroke: 27, endPath: 28, clip: 29, eoClip: 30, beginText: 31,
  endText: 32, setCharSpacing: 33, setWordSpacing: 34, setHScale: 35,
  setLeading: 36, setFont: 37, setTextRenderingMode: 38, setTextRise: 39,
  moveText: 40, setLeadingMoveText: 41, setTextMatrix: 42, nextLine: 43,
  showText: 44, showSpacedText: 45, nextLineShowText: 46,
  nextLineSetSpacingShowText: 47, setCharWidth: 48, setCharWidthAndBounds: 49,
  setStrokeColorSpace: 50, setFillColorSpace: 51, setStrokeColor: 52,
  setStrokeColorN: 53, setFillColor: 54, setFillColorN: 55, setStrokeGray: 56,
  setFillGray: 57, setStrokeRGBColor: 58, setFillRGBColor: 59,
  setStrokeCMYKColor: 60, setFillCMYKColor: 61, shadingFill: 62,
  beginInlineImage: 63, beginImageData: 64, endInlineImage: 65,
  paintXObject: 66, markPoint: 67, markPointProps: 68, beginMarkedContent: 69,
  beginMarkedContentProps: 70, endMarkedContent: 71, beginCompat: 72,
  endCompat: 73, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75,
  beginGroup: 76, endGroup: 77, beginAnnotation: 80, endAnnotation: 81,
  paintImageMaskXObject: 83, paintImageMaskXObjectGroup: 84,
  paintImageXObject: 85, paintInlineImageXObject: 86,
  paintInlineImageXObjectGroup: 87, paintImageXObjectRepeat: 88,
  paintImageMaskXObjectRepeat: 89, paintSolidColorImageMask: 90,
  constructPath: 91, setStrokeTransparent: 92, setFillTransparent: 93,
  rawFillPath: 94,
};

const DrawOPS = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 };

const STROKE_TERMINALS = new Set([
  OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke,
  OPS.closeFillStroke, OPS.closeEOFillStroke,
]);
const FILL_TERMINALS = new Set([
  OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke,
  OPS.closeFillStroke, OPS.closeEOFillStroke,
]);

const IDENTITY = [1, 0, 0, 1, 0, 0];

function multiplyMatrix(a, b) {
  return [
    a[0]*b[0] + a[2]*b[1],
    a[1]*b[0] + a[3]*b[1],
    a[0]*b[2] + a[2]*b[3],
    a[1]*b[2] + a[3]*b[3],
    a[0]*b[4] + a[2]*b[5] + a[4],
    a[1]*b[4] + a[3]*b[5] + a[5],
  ];
}

function applyMatrix(m, x, y) {
  return { x: m[0]*x + m[2]*y + m[4], y: m[1]*x + m[3]*y + m[5] };
}

function segmentLength(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }
function midpoint(a, b) { return { x: (a.x+b.x)/2, y: (a.y+b.y)/2 }; }

function arcLength(radius, startDeg, endDeg) {
  let span = endDeg - startDeg;
  if (span < 0) span += 360;
  return (span / 360) * 2 * Math.PI * radius;
}

// ─── bezierToArc ──────────────────────────────────────────────────────────────

function bezierToArc(p0, p1, p2, p3) {
  const midX = (p0.x + 3*p1.x + 3*p2.x + p3.x) / 8;
  const midY = (p0.y + 3*p1.y + 3*p2.y + p3.y) / 8;

  const chordLen = Math.hypot(p3.x - p0.x, p3.y - p0.y);
  if (chordLen > 1e-6) {
    const cross = Math.abs(
      (midX - p0.x) * (p3.y - p0.y) - (midY - p0.y) * (p3.x - p0.x)
    ) / chordLen;
    if (cross < chordLen * 0.001) return null;
  }

  const ax = p0.x, ay = p0.y, bx = midX, by = midY, cx = p3.x, cy = p3.y;
  const D = 2 * (ax*(by-cy) + bx*(cy-ay) + cx*(ay-by));
  if (Math.abs(D) < 1e-8) return null;
  const ux = ((ax*ax+ay*ay)*(by-cy) + (bx*bx+by*by)*(cy-ay) + (cx*cx+cy*cy)*(ay-by)) / D;
  const uy = ((ax*ax+ay*ay)*(cx-bx) + (bx*bx+by*by)*(ax-cx) + (cx*cx+cy*cy)*(bx-ax)) / D;
  const center = { x: ux, y: uy };
  const radius = Math.hypot(ax - ux, ay - uy);
  if (radius < 1e-6 || !isFinite(radius)) return null;
  const d1 = Math.hypot(p1.x-ux, p1.y-uy);
  const d2 = Math.hypot(p2.x-ux, p2.y-uy);
  if (Math.abs(d1-radius)/radius > 0.12 || Math.abs(d2-radius)/radius > 0.12) return null;
  const startAngle = (Math.atan2(ay-uy, ax-ux) * 180) / Math.PI;
  const endAngle   = (Math.atan2(cy-uy, cx-ux) * 180) / Math.PI;
  const isCircle = Math.hypot(p3.x-p0.x, p3.y-p0.y) < radius * 0.01;
  return { center, radius, startAngle: (startAngle+360)%360, endAngle: (endAngle+360)%360, isCircle };
}

// ─── Arc group merging ────────────────────────────────────────────────────────

const ARC_CENTER_EPSILON = 4;
const ARC_RADIUS_FRAC    = 0.03;

function sameCircle(a, b) {
  const dCenter = Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y);
  const rAvg = (a.radius + b.radius) / 2;
  if (rAvg < 1e-6) return false;
  return dCenter < ARC_CENTER_EPSILON && Math.abs(a.radius - b.radius) / rAvg < ARC_RADIUS_FRAC;
}

function mergeArcGroup(group) {
  if (group.length === 1) return group[0];

  const ref = group[0];
  let cx = 0, cy = 0, r = 0;
  for (const c of group) { cx += c.center.x; cy += c.center.y; r += c.radius; }
  cx /= group.length; cy /= group.length; r /= group.length;

  const beziers = group
    .filter(c => c.bezier)
    .map(c => c.bezier);

  let totalSpan = 0;
  for (const c of group) {
    let span = c.endAngle - c.startAngle;
    if (span < 0) span += 360;
    totalSpan += span;
  }
  const isCircle = totalSpan > 355;

  const approxLength = group.reduce((s, c) => s + (c.approxLength || 0), 0);

  return {
    id: ref.id + '_merged',
    center: { x: cx, y: cy },
    radius: r,
    startAngle: ref.startAngle,
    endAngle: group[group.length - 1].endAngle,
    isCircle,
    layer: ref.layer,
    strokeWidth: ref.strokeWidth,
    approxLength,
    fromStroke: ref.fromStroke,
    bezier: beziers.length > 0 ? beziers[0] : ref.bezier,
    beziers,
  };
}

function mergeArcSegments(rawCurves) {
  if (rawCurves.length === 0) return [];

  const merged = [];
  let group = [rawCurves[0]];

  for (let i = 1; i < rawCurves.length; i++) {
    const cur = rawCurves[i];
    const ref = group[0];

    const prev = group[group.length - 1];
    const prevEnd  = prev.bezier  ? prev.bezier.p3   : null;
    const curStart = cur.bezier   ? cur.bezier.p0    : null;
    const connected = prevEnd && curStart
      ? Math.hypot(prevEnd.x - curStart.x, prevEnd.y - curStart.y) < ARC_CENTER_EPSILON
      : true;

    if (sameCircle(cur, ref) && connected) {
      group.push(cur);
    } else {
      merged.push(mergeArcGroup(group));
      group = [cur];
    }
  }
  merged.push(mergeArcGroup(group));

  return merged;
}

// ─── Centerline deduplication ─────────────────────────────────────────────────

function dot(ax, ay, bx, by) { return ax*bx + ay*by; }

function lineAngle(a, b) {
  let angle = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
  if (angle < 0) angle += 180;
  if (angle >= 180) angle -= 180;
  return angle;
}

function ptToSegDist(px, py, ax, ay, bx, by) {
  const dx = bx-ax, dy = by-ay;
  const lenSq = dx*dx + dy*dy;
  if (lenSq < 1e-10) return Math.hypot(px-ax, py-ay);
  const t = Math.max(0, Math.min(1, ((px-ax)*dx + (py-ay)*dy) / lenSq));
  return Math.hypot(px-(ax+t*dx), py-(ay+t*dy));
}

function projectOntoLine(px, py, ax, ay, bx, by) {
  const dx = bx-ax, dy = by-ay;
  const lenSq = dx*dx + dy*dy;
  if (lenSq < 1e-10) return 0;
  return ((px-ax)*dx + (py-ay)*dy) / lenSq;
}

function deduplicateCenterlines(lines) {
  const stroked = lines.filter(l => l.fromStroke);
  const others  = lines.filter(l => !l.fromStroke);

  const ANGLE_TOL   = 2;
  const OFFSET_TOL  = 12;
  const OVERLAP_MIN = 0.5;

  const used    = new Uint8Array(stroked.length);
  const result  = [];

  for (let i = 0; i < stroked.length; i++) {
    if (used[i]) continue;
    const li = stroked[i];
    const [ai, bi] = li.vertices;
    const angleI = lineAngle(ai, bi);
    const lenI   = li.length;

    let paired = false;

    for (let j = i + 1; j < stroked.length; j++) {
      if (used[j]) continue;
      const lj = stroked[j];
      const [aj, bj] = lj.vertices;
      const angleJ = lineAngle(aj, bj);

      let angleDiff = Math.abs(angleI - angleJ);
      if (angleDiff > 90) angleDiff = 180 - angleDiff;
      if (angleDiff > ANGLE_TOL) continue;

      const mx = (aj.x + bj.x) / 2;
      const my = (aj.y + bj.y) / 2;
      const perpDist = ptToSegDist(mx, my, ai.x, ai.y, bi.x, bi.y);
      if (perpDist > OFFSET_TOL) continue;

      const t1 = projectOntoLine(aj.x, aj.y, ai.x, ai.y, bi.x, bi.y);
      const t2 = projectOntoLine(bj.x, bj.y, ai.x, ai.y, bi.x, bi.y);
      const tMin = Math.min(t1, t2);
      const tMax = Math.max(t1, t2);
      const overlapFrac = Math.max(0, Math.min(1, tMax) - Math.max(0, tMin));
      const lenJ = lj.length;
      const minLen = Math.min(lenI, lenJ);
      if (overlapFrac * lenI < OVERLAP_MIN * minLen) continue;

      const dx = bi.x - ai.x, dy = bi.y - ai.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      const ux = dx/len, uy = dy/len;
      const nx = -uy,   ny = ux;

      const sAI = 0;
      const sBI = lenI;
      const sAJ = projectOntoLine(aj.x, aj.y, ai.x, ai.y, bi.x, bi.y) * lenI;
      const sBJ = projectOntoLine(bj.x, bj.y, ai.x, ai.y, bi.x, bi.y) * lenI;

      const sStart = Math.max(Math.min(sAI, sBI), Math.min(sAJ, sBJ));
      const sEnd   = Math.min(Math.max(sAI, sBI), Math.max(sAJ, sBJ));
      if (sEnd <= sStart) continue;

      const offI = 0;
      const offJ = dot(aj.x - ai.x, aj.y - ai.y, nx, ny);
      const lateralAvg = (offI + offJ) / 2;

      const startPt = {
        x: ai.x + ux * sStart + nx * lateralAvg,
        y: ai.y + uy * sStart + ny * lateralAvg,
      };
      const endPt = {
        x: ai.x + ux * sEnd + nx * lateralAvg,
        y: ai.y + uy * sEnd + ny * lateralAvg,
      };

      result.push({
        id: li.id + '_c',
        vertices: [startPt, endPt],
        layer: li.layer,
        strokeWidth: (li.strokeWidth + lj.strokeWidth) / 2,
        length: Math.hypot(endPt.x - startPt.x, endPt.y - startPt.y),
        fromStroke: true,
      });

      used[i] = 1;
      used[j] = 1;
      paired = true;
      break;
    }

    if (!paired) {
      result.push(li);
    }
  }

  return [...result, ...others];
}

// ─── Snap computation ─────────────────────────────────────────────────────────

const CLUSTER_DIST = 2;

function clusterNear(points, nx, ny, type) {
  for (const p of points) {
    if (p.type === type && Math.hypot(p.nx-nx, p.ny-ny) < CLUSTER_DIST/1000) return true;
  }
  return false;
}

function computeLineSnaps(line, dims, out) {
  if (!line.fromStroke) return;
  const [a, b] = line.vertices;
  const addSnap = (v, type) => {
    const nx = v.x/dims.w, ny = v.y/dims.h;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
    if (!clusterNear(out, nx, ny, type))
      out.push({ nx, ny, type, sourceId: line.id, strokeWidth: line.strokeWidth });
  };
  addSnap(a, 'endpoint');
  addSnap(b, 'endpoint');
  addSnap(midpoint(a, b), 'midpoint');
}

function computeCurveSnaps(curve, dims, out) {
  if (!curve.fromStroke) return;
  const addSnap = (v, type) => {
    const nx = v.x/dims.w, ny = v.y/dims.h;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
    if (!clusterNear(out, nx, ny, type))
      out.push({ nx, ny, type, sourceId: curve.id, strokeWidth: curve.strokeWidth });
  };

  addSnap(curve.center, 'centroid');

  if (!curve.isCircle) {
    const toRad = d => d * Math.PI / 180;

    if (curve.beziers && curve.beziers.length > 0) {
      const firstBez = curve.beziers[0];
      const lastBez  = curve.beziers[curve.beziers.length - 1];
      addSnap(firstBez.p0, 'curve-node');
      addSnap(lastBez.p3,  'curve-node');
    } else if (curve.bezier) {
      addSnap(curve.bezier.p0, 'curve-node');
      addSnap(curve.bezier.p3, 'curve-node');
    } else {
      addSnap({
        x: curve.center.x + curve.radius * Math.cos(toRad(curve.startAngle)),
        y: curve.center.y + curve.radius * Math.sin(toRad(curve.startAngle)),
      }, 'curve-node');
      addSnap({
        x: curve.center.x + curve.radius * Math.cos(toRad(curve.endAngle)),
        y: curve.center.y + curve.radius * Math.sin(toRad(curve.endAngle)),
      }, 'curve-node');
    }
  }
}

function segmentIntersection(a, b) {
  const [p1, p2] = a.vertices, [p3, p4] = b.vertices;
  const d1x = p2.x-p1.x, d1y = p2.y-p1.y;
  const d2x = p4.x-p3.x, d2y = p4.y-p3.y;
  const denom = d1x*d2y - d1y*d2x;
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((p3.x-p1.x)*d2y - (p3.y-p1.y)*d2x) / denom;
  const u = ((p3.x-p1.x)*d1y - (p3.y-p1.y)*d1x) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: p1.x + t*d1x, y: p1.y + t*d1y };
}

function computeIntersections(lines, dims, out) {
  const strokedLines = lines.filter(l => l.fromStroke);
  for (let i = 0; i < strokedLines.length; i++) {
    for (let j = i+1; j < strokedLines.length; j++) {
      const pt = segmentIntersection(strokedLines[i], strokedLines[j]);
      if (!pt) continue;
      const nx = pt.x/dims.w, ny = pt.y/dims.h;
      if (nx < 0 || nx > 1 || ny < 0 || ny > 1) continue;
      if (!clusterNear(out, nx, ny, 'intersection')) {
        out.push({
          nx, ny, type: 'intersection',
          sourceId: strokedLines[i].id + 'x' + strokedLines[j].id,
          strokeWidth: (strokedLines[i].strokeWidth + strokedLines[j].strokeWidth) / 2,
        });
      }
    }
  }
}

// ─── Snap point absorption ────────────────────────────────────────────────────
// When 12+ snap points lie close together AND collectively trace a line or arc,
// collapse them to 2–3 representative snaps (endpoints + midpoint/centroid).
// Points that are not close together, or form groups smaller than 12, are left
// completely unchanged.

const ABSORB_MIN_POINTS   = 12;   // minimum cluster size to trigger absorption
const ABSORB_PROXIMITY_PX = 8;    // px — max neighbour gap to stay in a chain
const ABSORB_LINE_TOL_PX  = 2.5;  // px — max perpendicular residual for collinearity
const ABSORB_ARC_TOL_FRAC = 0.04; // fraction of radius — max radial residual for co-circularity

// Union-find helpers
function ufFind(parent, i) {
  while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
  return i;
}
function ufUnion(parent, i, j) { parent[ufFind(parent, i)] = ufFind(parent, j); }

// Cluster snap points whose canvas-px positions are within ABSORB_PROXIMITY_PX
// of at least one other point in the group (chain/flood-fill, not just pairwise).
function buildProximityClusters(points, dims) {
  const n = points.length;
  const parent = Array.from({ length: n }, (_, i) => i);

  for (let i = 0; i < n; i++) {
    const xi = points[i].nx * dims.w;
    const yi = points[i].ny * dims.h;
    for (let j = i + 1; j < n; j++) {
      const xj = points[j].nx * dims.w;
      const yj = points[j].ny * dims.h;
      if (Math.hypot(xi - xj, yi - yj) < ABSORB_PROXIMITY_PX) {
        ufUnion(parent, i, j);
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = ufFind(parent, i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }
  return [...groups.values()];
}

// PCA line fit — returns { ok, startPt, midPt, endPt } in canvas-px, or { ok: false }
function fitLinePx(pts) {
  const n  = pts.length;
  const xs = pts.map(p => p.cx);
  const ys = pts.map(p => p.cy);
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const angle  = Math.atan2(2 * sxy, sxx - syy) / 2;
  const dirX   = Math.cos(angle),  dirY  = Math.sin(angle);
  const normX  = -dirY,            normY = dirX;
  let maxDev = 0;
  for (let i = 0; i < n; i++) {
    const dev = Math.abs((xs[i] - mx) * normX + (ys[i] - my) * normY);
    if (dev > maxDev) maxDev = dev;
  }
  if (maxDev > ABSORB_LINE_TOL_PX) return { ok: false };
  const ts    = xs.map((x, i) => (x - mx) * dirX + (ys[i] - my) * dirY);
  const tMin  = Math.min(...ts), tMax = Math.max(...ts);
  const startPt = { x: mx + dirX * tMin, y: my + dirY * tMin };
  const endPt   = { x: mx + dirX * tMax, y: my + dirY * tMax };
  const midPt   = { x: (startPt.x + endPt.x) / 2, y: (startPt.y + endPt.y) / 2 };
  return { ok: true, startPt, midPt, endPt };
}

// Algebraic circle fit (Kåsa / Pratt) — returns { ok, cx, cy, r } in canvas-px
function fitCirclePx(pts) {
  const n  = pts.length;
  const xs = pts.map(p => p.cx);
  const ys = pts.map(p => p.cy);
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;

  // Shift to centroid for numerical stability
  const u = xs.map(x => x - mx);
  const v = ys.map((y) => y - my);

  let Suu = 0, Svv = 0, Suv = 0, Suuu = 0, Svvv = 0, Suuv = 0, Suvv = 0;
  for (let i = 0; i < n; i++) {
    const ui = u[i], vi = v[i];
    Suu  += ui*ui; Svv  += vi*vi; Suv  += ui*vi;
    Suuu += ui*ui*ui; Svvv += vi*vi*vi;
    Suuv += ui*ui*vi; Suvv += ui*vi*vi;
  }

  const C = [[2*Suu, 2*Suv], [2*Suv, 2*Svv]];
  const rhs = [Suuu + Suvv, Svvv + Suuv];
  const det = C[0][0]*C[1][1] - C[0][1]*C[1][0];
  if (Math.abs(det) < 1e-10) return { ok: false };

  const uc = (rhs[0]*C[1][1] - rhs[1]*C[0][1]) / det;
  const vc = (C[0][0]*rhs[1] - C[1][0]*rhs[0]) / det;
  const cx = uc + mx;
  const cy = vc + my;
  const r  = Math.sqrt(uc*uc + vc*vc + (Suu + Svv) / n);

  if (r < 1 || !isFinite(r)) return { ok: false };

  // Check residuals
  let maxDev = 0;
  for (let i = 0; i < n; i++) {
    const dev = Math.abs(Math.hypot(xs[i] - cx, ys[i] - cy) - r);
    if (dev > maxDev) maxDev = dev;
  }
  if (maxDev > r * ABSORB_ARC_TOL_FRAC) return { ok: false };

  return { ok: true, cx, cy, r };
}

// Main absorption pass — runs after all snap points are computed.
// Returns a new (smaller) array of snap points.
function absorbDenseSnapClusters(snapPoints, dims) {
  if (snapPoints.length === 0) return snapPoints;

  // Annotate with canvas-px coordinates for geometry tests
  const annotated = snapPoints.map(p => ({
    ...p,
    cx: p.nx * dims.w,
    cy: p.ny * dims.h,
  }));

  const clusters = buildProximityClusters(annotated, dims);
  const absorbed = new Set(); // indices of points that were absorbed
  const extras   = [];        // replacement representative points

  for (const idxs of clusters) {
    // Only absorb clusters of 12 or more points
    if (idxs.length < ABSORB_MIN_POINTS) continue;

    const group = idxs.map(i => annotated[i]);

    // Try line fit first (cheaper)
    const lineFit = fitLinePx(group);
    if (lineFit.ok) {
      // Mark all as absorbed
      for (const i of idxs) absorbed.add(i);

      // Emit: start endpoint, midpoint, end endpoint
      const ref = group[0];
      const toNorm = (pt) => ({ nx: pt.x / dims.w, ny: pt.y / dims.h });
      const s = toNorm(lineFit.startPt);
      const m = toNorm(lineFit.midPt);
      const e = toNorm(lineFit.endPt);
      if (s.nx >= 0 && s.nx <= 1 && s.ny >= 0 && s.ny <= 1)
        extras.push({ nx: s.nx, ny: s.ny, type: 'endpoint',  sourceId: ref.sourceId, strokeWidth: ref.strokeWidth });
      if (m.nx >= 0 && m.nx <= 1 && m.ny >= 0 && m.ny <= 1)
        extras.push({ nx: m.nx, ny: m.ny, type: 'midpoint',  sourceId: ref.sourceId, strokeWidth: ref.strokeWidth });
      if (e.nx >= 0 && e.nx <= 1 && e.ny >= 0 && e.ny <= 1)
        extras.push({ nx: e.nx, ny: e.ny, type: 'endpoint',  sourceId: ref.sourceId, strokeWidth: ref.strokeWidth });
      continue;
    }

    // Try circle / arc fit
    const circleFit = fitCirclePx(group);
    if (circleFit.ok) {
      for (const i of idxs) absorbed.add(i);

      const ref = group[0];
      const { cx, cy, r } = circleFit;

      // Centroid (center of circle)
      const ncx = cx / dims.w, ncy = cy / dims.h;
      if (ncx >= 0 && ncx <= 1 && ncy >= 0 && ncy <= 1)
        extras.push({ nx: ncx, ny: ncy, type: 'centroid', sourceId: ref.sourceId, strokeWidth: ref.strokeWidth });

      // For arcs (not full circles): also emit the two extreme endpoints.
      // Determine if this is a full circle by checking angular span.
      const angles = group.map(p => Math.atan2(p.cy - cy, p.cx - cx));
      angles.sort((a, b) => a - b);
      // Largest gap between consecutive angles → if > π, it's an arc, else full circle
      let maxGap = 0;
      for (let i = 0; i < angles.length; i++) {
        const next = angles[(i + 1) % angles.length];
        let gap = next - angles[i];
        if (gap < 0) gap += 2 * Math.PI;
        if (i === angles.length - 1) gap = angles[0] + 2 * Math.PI - angles[angles.length - 1];
        if (gap > maxGap) maxGap = gap;
      }
      const isFullCircle = maxGap < Math.PI * 0.5; // gap < 90° → full circle

      if (!isFullCircle) {
        // Arc endpoints are just after the largest gap
        let gapIdx = 0;
        let bestGap = 0;
        for (let i = 0; i < angles.length; i++) {
          const next  = (i + 1) % angles.length;
          let gap = angles[next] - angles[i];
          if (gap < 0) gap += 2 * Math.PI;
          if (i === angles.length - 1) gap = angles[0] + 2 * Math.PI - angles[angles.length - 1];
          if (gap > bestGap) { bestGap = gap; gapIdx = i; }
        }
        const startAngle = angles[(gapIdx + 1) % angles.length];
        const endAngle   = angles[gapIdx];
        const ep1 = { x: cx + r * Math.cos(startAngle), y: cy + r * Math.sin(startAngle) };
        const ep2 = { x: cx + r * Math.cos(endAngle),   y: cy + r * Math.sin(endAngle) };
        const n1 = { nx: ep1.x / dims.w, ny: ep1.y / dims.h };
        const n2 = { nx: ep2.x / dims.w, ny: ep2.y / dims.h };
        if (n1.nx >= 0 && n1.nx <= 1 && n1.ny >= 0 && n1.ny <= 1)
          extras.push({ nx: n1.nx, ny: n1.ny, type: 'curve-node', sourceId: ref.sourceId, strokeWidth: ref.strokeWidth });
        if (n2.nx >= 0 && n2.nx <= 1 && n2.ny >= 0 && n2.ny <= 1)
          extras.push({ nx: n2.nx, ny: n2.ny, type: 'curve-node', sourceId: ref.sourceId, strokeWidth: ref.strokeWidth });
      }
    }
    // If neither line nor circle fit succeeds, leave the cluster untouched
  }

  // Build result: keep non-absorbed points + replacement extras
  const result = snapPoints.filter((_, i) => !absorbed.has(i));
  return [...result, ...extras];
}

// ─── Path unpacking ───────────────────────────────────────────────────────────

function unpackPathBuffer(buf) {
  const subpaths = [];
  let current = null;
  let i = 0;
  while (i < buf.length) {
    const tag = buf[i];
    if (tag === DrawOPS.moveTo) {
      current = { start: { x: buf[i+1], y: buf[i+2] }, segs: [] };
      subpaths.push(current);
      i += 3;
    } else if (tag === DrawOPS.lineTo) {
      if (current) current.segs.push({ type: 'line', x: buf[i+1], y: buf[i+2] });
      i += 3;
    } else if (tag === DrawOPS.curveTo) {
      if (current) current.segs.push({
        type: 'curve',
        x1: buf[i+1], y1: buf[i+2],
        x2: buf[i+3], y2: buf[i+4],
        x:  buf[i+5], y: buf[i+6],
      });
      i += 7;
    } else if (tag === DrawOPS.closePath) {
      if (current) current.segs.push({ type: 'close' });
      i += 1;
    } else {
      console.warn('[pdfGeometry.worker] unknown DrawOPS tag ' + tag + ' at index ' + i);
      break;
    }
  }
  return subpaths;
}

// ─── Bezier sagitta helper ────────────────────────────────────────────────────

function bezierSagitta(p0, p1, p2, p3) {
  const midX = (p0.x + 3*p1.x + 3*p2.x + p3.x) / 8;
  const midY = (p0.y + 3*p1.y + 3*p2.y + p3.y) / 8;
  const chordLen = Math.hypot(p3.x - p0.x, p3.y - p0.y);
  if (chordLen < 1e-6) return Math.hypot(midX - p0.x, midY - p0.y);
  return Math.abs(
    (midX - p0.x) * (p3.y - p0.y) - (midY - p0.y) * (p3.x - p0.x)
  ) / chordLen;
}

// ─── Main parser ──────────────────────────────────────────────────────────────

function parseOperators(operators, dims, viewportTransform) {
  const rawLines  = [];
  const rawCurves = [];
  const baseCtm   = viewportTransform || IDENTITY;
  const ctmStack  = [baseCtm];
  let ctm         = baseCtm;
  let strokeWidth = 1;
  let lineId  = 0;
  let curveId = 0;

  const pushCtm = () => ctmStack.push([...ctm]);
  const popCtm  = () => { ctm = ctmStack.pop() || baseCtm; };
  const pt      = (x, y) => applyMatrix(ctm, x, y);

  const pageDiag = Math.hypot(dims.w, dims.h);

  for (const op of operators) {
    const args = op.args;
    switch (op.fn) {
      case OPS.save:    pushCtm(); break;
      case OPS.restore: popCtm();  break;
      case OPS.transform:
        ctm = multiplyMatrix(ctm, args); break;
      case OPS.paintFormXObjectBegin: {
        pushCtm();
        if (args[0] && args[0].length === 6) ctm = multiplyMatrix(ctm, args[0]);
        break;
      }
      case OPS.paintFormXObjectEnd: popCtm(); break;
      case OPS.setLineWidth:
        strokeWidth = typeof args[0] === 'number' ? args[0] : 1; break;

      case OPS.constructPath: {
        const terminalOp  = args[0];
        const pathBuffer  = args[1];
        if (!pathBuffer || pathBuffer.length === 0) break;

        const isStroke = STROKE_TERMINALS.has(terminalOp);
        const isFill   = FILL_TERMINALS.has(terminalOp);
        if (!isStroke && !isFill) break;

        const subpaths = unpackPathBuffer(pathBuffer);

        for (const sp of subpaths) {
          let prevCanvas  = pt(sp.start.x, sp.start.y);
          const firstCanvas = prevCanvas;

          for (const seg of sp.segs) {
            if (seg.type === 'line') {
              const v   = pt(seg.x, seg.y);
              const len = segmentLength(prevCanvas, v);
              if (len >= 0.1) {
                rawLines.push({
                  id: 'L' + (++lineId),
                  vertices: [prevCanvas, v],
                  layer: '0', strokeWidth, length: len,
                  fromStroke: isStroke,
                });
              }
              prevCanvas = v;

            } else if (seg.type === 'curve') {
              const p1 = pt(seg.x1, seg.y1);
              const p2 = pt(seg.x2, seg.y2);
              const p3 = pt(seg.x,  seg.y);

              const arc = bezierToArc(prevCanvas, p1, p2, p3);

              if (arc && arc.radius > 0.5 && arc.radius < pageDiag * 1.5) {
                rawCurves.push({
                  id: 'C' + (++curveId),
                  center: arc.center,
                  radius: arc.radius,
                  startAngle: arc.startAngle,
                  endAngle:   arc.endAngle,
                  isCircle:   arc.isCircle,
                  layer: '0', strokeWidth,
                  approxLength: arcLength(arc.radius, arc.startAngle, arc.endAngle),
                  fromStroke: isStroke,
                  bezier: { p0: prevCanvas, p1, p2, p3 },
                  beziers: null,
                });
              } else {
                const sagitta = bezierSagitta(prevCanvas, p1, p2, p3);

                if (sagitta >= 1.0) {
                  const roughCenterX = (prevCanvas.x + p3.x) / 2;
                  const roughCenterY = (prevCanvas.y + p3.y) / 2;
                  const chordLen = segmentLength(prevCanvas, p3);
                  rawCurves.push({
                    id: 'C' + (++curveId),
                    center: { x: roughCenterX, y: roughCenterY },
                    radius: chordLen / 2,
                    startAngle: 0,
                    endAngle: 180,
                    isCircle: false,
                    layer: '0', strokeWidth,
                    approxLength: chordLen,
                    fromStroke: isStroke,
                    bezier: { p0: prevCanvas, p1, p2, p3 },
                    beziers: null,
                  });
                } else {
                  const len = segmentLength(prevCanvas, p3);
                  if (len >= 0.1) {
                    rawLines.push({
                      id: 'L' + (++lineId),
                      vertices: [prevCanvas, p3],
                      layer: '0', strokeWidth, length: len,
                      fromStroke: isStroke,
                    });
                  }
                }
              }
              prevCanvas = p3;

            } else if (seg.type === 'close') {
              const len = segmentLength(prevCanvas, firstCanvas);
              if (len >= 0.1) {
                rawLines.push({
                  id: 'L' + (++lineId),
                  vertices: [prevCanvas, firstCanvas],
                  layer: '0', strokeWidth, length: len,
                  fromStroke: isStroke,
                });
              }
              prevCanvas = firstCanvas;
            }
          }
        }
        break;
      }
      default: break;
    }
  }

  const curves = mergeArcSegments(rawCurves);

  for (const c of curves) {
    if (!c.beziers && c.bezier) {
      c.beziers = [c.bezier];
    }
  }

  console.log('[pdfGeometry.worker] rawCurves: ' + rawCurves.length + ', merged arcs: ' + curves.length);
  console.log('[pdfGeometry.worker] lines: ' + rawLines.length + ', curves: ' + curves.length);

  return { lines: rawLines, curves };
}

self.onmessage = function(e) {
  const data = e.data;
  if (data.type !== 'PARSE') return;
  const { operators, dims, viewportTransform } = data;

  try {
    const { lines, curves } = parseOperators(operators, dims, viewportTransform || IDENTITY);

    const rawSnapPoints = [];
    for (const line  of lines)  computeLineSnaps(line, dims, rawSnapPoints);
    for (const curve of curves) computeCurveSnaps(curve, dims, rawSnapPoints);
    computeIntersections(lines, dims, rawSnapPoints);

    console.log('[pdfGeometry.worker] rawSnapPoints before absorption: ' + rawSnapPoints.length);

    // Absorb dense clusters of 12+ co-linear or co-circular snap points
    // into 2-3 representative snaps. Sparse points are left unchanged.
    const snapPoints = absorbDenseSnapClusters(rawSnapPoints, dims);

    console.log('[pdfGeometry.worker] snapPoints after absorption: ' + snapPoints.length);

    self.postMessage({ type: 'RESULT', lines, curves, snapPoints });
  } catch (err) {
    console.error('[pdfGeometry.worker] threw:', err);
    self.postMessage({ type: 'ERROR', message: String(err) });
  }
};
`;

function createGeometryWorker(): Worker {
  const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
  const url  = URL.createObjectURL(blob);
  const w    = new Worker(url);
  URL.revokeObjectURL(url);
  return w;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function usePdfDocument(): UsePdfDocumentReturn {
  const [stage, setStage]       = useState<PdfLoadStage>('idle');
  const [errorMessage, setErr]  = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [dims, setDims]         = useState<PdfDimensions | null>(null);
  const [pageInfo, setPageInfo] = useState<PdfPageInfo | null>(null);
  const [lines, setLines]       = useState<PdfLine[]>([]);
  const [curves, setCurves]     = useState<PdfCurve[]>([]);
  const [snapPoints, setSnaps]  = useState<SnapPoint[]>([]);

  const pdfPageRef = useRef<any>(null);
  const workerRef  = useRef<Worker | null>(null);

  const renderToCanvas = useCallback(async (canvas: HTMLCanvasElement, scale = 1) => {
    const page = pdfPageRef.current;
    if (!page) return;
    const viewport  = page.getViewport({ scale });
    canvas.width    = viewport.width;
    canvas.height   = viewport.height;
    const ctx = canvas.getContext('2d')!;
    await page.render({ canvasContext: ctx, viewport }).promise;
  }, []);

  const loadFile = useCallback(async (file: File) => {
    workerRef.current?.terminate();
    workerRef.current = null;

    setStage('reading-file');
    setErr(null);
    setFileName(file.name);
    setLines([]); setCurves([]); setSnaps([]);
    setDims(null); setPageInfo(null);
    pdfPageRef.current = null;

    try {
      const buffer = await file.arrayBuffer();

      setStage('parsing-pdf');
      const pdfjs = await getPdfJs();
      const doc   = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
      const page  = await doc.getPage(1);
      pdfPageRef.current = page;
      setPageInfo({ pageNumber: 1, pageCount: doc.numPages });

      setStage('rendering-page');
      const vp       = page.getViewport({ scale: 1 });
      const pageDims: PdfDimensions = { w: vp.width, h: vp.height };
      setDims(pageDims);
      const viewportTransform = vp.transform as number[];

      setStage('extracting-geometry');
      const operators = await extractOperators(page);

      setStage('computing-snaps');
      const worker = createGeometryWorker();
      workerRef.current = worker;

      await new Promise<void>((resolve, reject) => {
        worker.onmessage = (e) => {
          const msg = e.data;
          if (msg.type === 'RESULT') {
            setLines(msg.lines);
            setCurves(msg.curves);
            setSnaps(msg.snapPoints);
            resolve();
          } else if (msg.type === 'ERROR') {
            reject(new Error(msg.message));
          }
        };
        worker.onerror = (err) => reject(err);
        worker.postMessage({ type: 'PARSE', operators, dims: pageDims, viewportTransform });
      });

      setStage('done');
    } catch (err) {
      console.error('[usePdfDocument] error:', err);
      setErr(err instanceof Error ? err.message : String(err));
      setStage('error');
    }
  }, []);

  return { stage, errorMessage, fileName, dims, pageInfo, lines, curves, snapPoints, loadFile, renderToCanvas };
}
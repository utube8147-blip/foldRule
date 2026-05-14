// hooks/useSvgInteraction.ts
//
// CHANGES in this version:
//   • EXTRACTED: reconstructRoomsFromWalls, assignLabelsToRooms, resolveRoomLabel
//     → moved to ./detectRoomAreas.ts  (mirrors detectDoorSymbols pattern)
//   • KEPT: all matrix helpers, parsePathToPoints, chainRawSegments exported
//     (detectDoorSymbols and detectRoomAreas both import from here)
//   • KEPT: all hook logic, explicit area/line/point extraction, deduplication

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  isDecorationElement,
  isFullPageShape,
  resolveStrokeWidth,
} from './svgDecorationFilter';
import { detectDoorSymbols }  from './detectDoorSymbols';
import { detectRoomAreas, resolveRoomLabel } from './detectRoomAreas';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface SvgPoint {
  id: string;
  type: 'point';
  x: number;
  y: number;
  element: Element;
  attributes: Record<string, string>;
  label?: string;
}

export interface SvgLine {
  id: string;
  type: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  length: number;
  angle: number;
  element: Element;
  attributes: Record<string, string>;
  label?: string;
  shapeId?: string;
}

export interface SvgArea {
  id: string;
  type: 'area';
  points: Array<{ x: number; y: number }>;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  area: number;
  element: Element;
  attributes: Record<string, string>;
  label?: string;
  shapeId?: string;
  isDoor?: boolean;
}

export type SvgElement = SvgPoint | SvgLine | SvgArea;

export interface SnapResult {
  type: 'point' | 'line' | 'area';
  element: SvgElement;
  snapPoint: { x: number; y: number };
  distance: number;
}

export interface Vec2 { x: number; y: number }
export interface VBTransform { sx: number; sy: number; tx: number; ty: number }

interface UseSvgInteractionProps {
  svgContent: string | null;
  pdfDimensions: { w: number; h: number } | null;
  snapThreshold?: number;
  enabled?: boolean;
}

// ─── Matrix types + helpers (exported for detectDoorSymbols / detectRoomAreas) ─

interface Mat2D { a: number; b: number; c: number; d: number; e: number; f: number }

function identityMatrix(): Mat2D {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

function multiplyMatrix(m1: Mat2D, m2: Mat2D): Mat2D {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

export function applyMatrix(m: Mat2D, v: Vec2): Vec2 {
  return {
    x: m.a * v.x + m.c * v.y + m.e,
    y: m.b * v.x + m.d * v.y + m.f,
  };
}

function parseTransformAttr(transform: string | null): Mat2D {
  if (!transform) return identityMatrix();
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\(([^)]*)\)/g;
  const transforms: Mat2D[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(transform)) !== null) {
    const type = m[1];
    const args = m[2].trim().split(/[\s,]+/).map(parseFloat);
    let mat = identityMatrix();
    switch (type) {
      case 'matrix':
        mat = { a: args[0], b: args[1], c: args[2], d: args[3], e: args[4], f: args[5] };
        break;
      case 'translate':
        mat = { a: 1, b: 0, c: 0, d: 1, e: args[0] ?? 0, f: args[1] ?? 0 };
        break;
      case 'scale': {
        const sx = args[0] ?? 1, sy = args[1] ?? sx;
        mat = { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
        break;
      }
      case 'rotate': {
        const ang = (args[0] ?? 0) * Math.PI / 180;
        const cos = Math.cos(ang), sin = Math.sin(ang);
        const cx = args[1] ?? 0, cy = args[2] ?? 0;
        mat = { a: cos, b: sin, c: -sin, d: cos,
                e: cx - cos * cx + sin * cy, f: cy - sin * cx - cos * cy };
        break;
      }
      case 'skewX': {
        const t = Math.tan((args[0] ?? 0) * Math.PI / 180);
        mat = { a: 1, b: 0, c: t, d: 1, e: 0, f: 0 };
        break;
      }
      case 'skewY': {
        const t = Math.tan((args[0] ?? 0) * Math.PI / 180);
        mat = { a: 1, b: t, c: 0, d: 1, e: 0, f: 0 };
        break;
      }
    }
    transforms.push(mat);
  }
  let composed = identityMatrix();
  for (const t of transforms) composed = multiplyMatrix(composed, t);
  return composed;
}

export function getCTM(el: Element, svgRoot: Element): Mat2D {
  const matrices: Mat2D[] = [];
  let node: Element | null = el;
  while (node && node !== svgRoot.parentElement) {
    const t = node.getAttribute('transform');
    if (t) matrices.unshift(parseTransformAttr(t));
    node = node.parentElement;
  }
  let ctm = identityMatrix();
  for (const m of matrices) ctm = multiplyMatrix(ctm, m);
  return ctm;
}

// ─── ViewBox → canvas transform ───────────────────────────────────────────────

function buildViewBoxTransform(
  svgEl: SVGSVGElement,
  canvasW: number,
  canvasH: number,
): VBTransform {
  const vb = svgEl.getAttribute('viewBox');
  if (vb) {
    const [minX, minY, vbW, vbH] = vb.trim().split(/[\s,]+/).map(parseFloat);
    if ([minX, minY, vbW, vbH].every(n => !isNaN(n)) && vbW > 0 && vbH > 0) {
      return {
        sx: canvasW / vbW, sy: canvasH / vbH,
        tx: -minX * (canvasW / vbW), ty: -minY * (canvasH / vbH),
      };
    }
  }
  const wAttr = svgEl.getAttribute('width');
  const hAttr = svgEl.getAttribute('height');
  const svgW  = wAttr ? parseFloat(wAttr) : canvasW;
  const svgH  = hAttr ? parseFloat(hAttr) : canvasH;
  return {
    sx: svgW > 0 ? canvasW / svgW : 1,
    sy: svgH > 0 ? canvasH / svgH : 1,
    tx: 0, ty: 0,
  };
}

export function applyVBTransform(v: Vec2, t: VBTransform): Vec2 {
  return { x: v.x * t.sx + t.tx, y: v.y * t.sy + t.ty };
}

// ─── Geometry helpers (exported) ──────────────────────────────────────────────

export function closestPointOnLine(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number,
): { x: number; y: number } {
  const ax = px - x1, ay = py - y1;
  const bx = x2 - x1, by = y2 - y1;
  const dot  = ax * bx + ay * by;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return { x: x1, y: y1 };
  const t = Math.max(0, Math.min(1, dot / len2));
  return { x: x1 + t * bx, y: y1 + t * by };
}

export function pointInPolygon(
  x: number, y: number,
  points: Array<{ x: number; y: number }>,
): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, yi = points[i].y;
    const xj = points[j].x, yj = points[j].y;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

export function distanceToPolygonEdge(
  x: number, y: number,
  points: Array<{ x: number; y: number }>,
): number {
  let minDist = Infinity;
  for (let i = 0; i < points.length; i++) {
    const j       = (i + 1) % points.length;
    const closest = closestPointOnLine(x, y, points[i].x, points[i].y, points[j].x, points[j].y);
    minDist = Math.min(minDist, Math.hypot(closest.x - x, closest.y - y));
  }
  return minDist;
}

// ─── Path parser (exported — used by detectDoorSymbols + detectRoomAreas) ─────

export function parsePathToPoints(d: string): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz][^MmLlHhVvCcSsQqTtAaZz]*/g);
  if (!tokens) return points;

  let cx = 0, cy = 0, sx = 0, sy = 0;
  let lastCpX = 0, lastCpY = 0;
  let lastCmd = '';

  const push = (x: number, y: number) => points.push({ x, y });

  const sampleCubic = (
    x0: number, y0: number, x1: number, y1: number,
    x2: number, y2: number, x3: number, y3: number, steps = 8,
  ) => {
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, u = 1 - t;
      push(
        u*u*u*x0 + 3*u*u*t*x1 + 3*u*t*t*x2 + t*t*t*x3,
        u*u*u*y0 + 3*u*u*t*y1 + 3*u*t*t*y2 + t*t*t*y3,
      );
    }
  };

  const sampleQuad = (
    x0: number, y0: number, x1: number, y1: number,
    x2: number, y2: number, steps = 6,
  ) => {
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, u = 1 - t;
      push(u*u*x0 + 2*u*t*x1 + t*t*x2, u*u*y0 + 2*u*t*y1 + t*t*y2);
    }
  };

  for (const token of tokens) {
    const cmd   = token[0];
    const upper = cmd.toUpperCase();
    const rel   = cmd !== upper;
    const nums  = token.slice(1).trim()
      .split(/[\s,]+/).map(parseFloat).filter(n => !isNaN(n));
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;

    switch (upper) {
      case 'M': {
        for (let i = 0; i + 1 < nums.length; i += 2) {
          const bx = i === 0 ? ox : (rel ? cx : 0);
          const by = i === 0 ? oy : (rel ? cy : 0);
          cx = bx + nums[i]; cy = by + nums[i + 1];
          if (i === 0) { sx = cx; sy = cy; }
          push(cx, cy);
        }
        lastCpX = cx; lastCpY = cy; break;
      }
      case 'L': {
        for (let i = 0; i + 1 < nums.length; i += 2) {
          cx = ox + nums[i]; cy = oy + nums[i + 1]; push(cx, cy);
        }
        lastCpX = cx; lastCpY = cy; break;
      }
      case 'H': {
        for (const n of nums) { cx = ox + n; push(cx, cy); }
        lastCpX = cx; lastCpY = cy; break;
      }
      case 'V': {
        for (const n of nums) { cy = oy + n; push(cx, cy); }
        lastCpX = cx; lastCpY = cy; break;
      }
      case 'C': {
        for (let i = 0; i + 5 < nums.length; i += 6) {
          const x1 = ox+nums[i],   y1 = oy+nums[i+1];
          const x2 = ox+nums[i+2], y2 = oy+nums[i+3];
          const x3 = ox+nums[i+4], y3 = oy+nums[i+5];
          sampleCubic(cx, cy, x1, y1, x2, y2, x3, y3);
          lastCpX = x2; lastCpY = y2; cx = x3; cy = y3;
        }
        break;
      }
      case 'S': {
        for (let i = 0; i + 3 < nums.length; i += 4) {
          const prev = lastCmd === 'C' || lastCmd === 'S';
          const x1 = prev ? 2*cx - lastCpX : cx;
          const y1 = prev ? 2*cy - lastCpY : cy;
          const x2 = ox+nums[i],   y2 = oy+nums[i+1];
          const x3 = ox+nums[i+2], y3 = oy+nums[i+3];
          sampleCubic(cx, cy, x1, y1, x2, y2, x3, y3);
          lastCpX = x2; lastCpY = y2; cx = x3; cy = y3;
        }
        break;
      }
      case 'Q': {
        for (let i = 0; i + 3 < nums.length; i += 4) {
          const x1 = ox+nums[i],   y1 = oy+nums[i+1];
          const x2 = ox+nums[i+2], y2 = oy+nums[i+3];
          sampleQuad(cx, cy, x1, y1, x2, y2);
          lastCpX = x1; lastCpY = y1; cx = x2; cy = y2;
        }
        break;
      }
      case 'T': {
        for (let i = 0; i + 1 < nums.length; i += 2) {
          const prev = lastCmd === 'Q' || lastCmd === 'T';
          const x1 = prev ? 2*cx - lastCpX : cx;
          const y1 = prev ? 2*cy - lastCpY : cy;
          const x2 = ox+nums[i], y2 = oy+nums[i+1];
          sampleQuad(cx, cy, x1, y1, x2, y2);
          lastCpX = x1; lastCpY = y1; cx = x2; cy = y2;
        }
        break;
      }
      case 'A': {
        for (let i = 0; i + 6 < nums.length; i += 7) {
          cx = ox + nums[i + 5]; cy = oy + nums[i + 6]; push(cx, cy);
        }
        lastCpX = cx; lastCpY = cy; break;
      }
      case 'Z': {
        if (cx !== sx || cy !== sy) push(sx, sy);
        cx = sx; cy = sy; lastCpX = cx; lastCpY = cy; break;
      }
    }
    lastCmd = upper;
  }
  return points;
}

// ─── Segment chaining (exported — used by detectDoorSymbols) ─────────────────

export interface RawSeg { a: Vec2; b: Vec2; el: Element }

export function chainRawSegments(segs: RawSeg[], tol = 8.0): Vec2[][] {
  if (segs.length === 0) return [];
  const used   = new Set<number>();
  const chains: Vec2[][] = [];

  for (let i = 0; i < segs.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const pts: Vec2[] = [{ ...segs[i].a }, { ...segs[i].b }];
    let tail = segs[i].b;
    let grew = true, iters = 0;

    while (grew && iters < 200) {
      grew = false; iters++;
      let bestIdx = -1, bestDist = tol, reverse = false;
      for (let j = 0; j < segs.length; j++) {
        if (used.has(j)) continue;
        const dA = Math.hypot(segs[j].a.x - tail.x, segs[j].a.y - tail.y);
        const dB = Math.hypot(segs[j].b.x - tail.x, segs[j].b.y - tail.y);
        if (dA < bestDist) { bestDist = dA; bestIdx = j; reverse = false; }
        if (dB < bestDist) { bestDist = dB; bestIdx = j; reverse = true;  }
      }
      if (bestIdx !== -1) {
        if (reverse) { pts.push({ ...segs[bestIdx].a }); tail = segs[bestIdx].a; }
        else         { pts.push({ ...segs[bestIdx].b }); tail = segs[bestIdx].b; }
        used.add(bestIdx); grew = true;
      }
    }
    chains.push(pts);
  }
  return chains;
}

// ─── Hook constants ───────────────────────────────────────────────────────────

const MIN_AREA_THRESHOLD = 1500;
const MAX_ASPECT_RATIO   = 14;

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useSvgInteraction({
  svgContent,
  pdfDimensions,
  snapThreshold = 14,
  enabled = true,
}: UseSvgInteractionProps) {
  const [elements, setElements]               = useState<SvgElement[]>([]);
  const [hoveredElement, setHoveredElement]   = useState<SvgElement | null>(null);
  const [selectedElement, setSelectedElement] = useState<SvgElement | null>(null);
  const [loading, setLoading]                 = useState(false);
  const [error, setError]                     = useState<string | null>(null);

  const spatialIndexRef = useRef<Map<string, SvgElement>>(new Map());

  useEffect(() => {
    if (!enabled || !svgContent || !pdfDimensions) {
      setElements([]);
      spatialIndexRef.current.clear();
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const parser  = new DOMParser();
      const svgDoc  = parser.parseFromString(svgContent, 'image/svg+xml');
      const svgRoot = svgDoc.documentElement;

      if (svgRoot.querySelector('parsererror')) throw new Error('Invalid SVG format');

      const svgEl = svgDoc.querySelector('svg') as SVGSVGElement | null;
      if (!svgEl) throw new Error('No <svg> element found');

      const vbt = buildViewBoxTransform(svgEl, pdfDimensions.w, pdfDimensions.h);

      const extractedElements: SvgElement[] = [];
      let idCounter = 0;

      const getAttributes = (el: Element): Record<string, string> => {
        const attrs: Record<string, string> = {};
        for (let i = 0; i < el.attributes.length; i++) {
          attrs[el.attributes[i].name] = el.attributes[i].value;
        }
        return attrs;
      };

      const toCanvas = (el: Element, x: number, y: number) => {
        const ctm = getCTM(el, svgEl);
        return applyVBTransform(applyMatrix(ctm, { x, y }), vbt);
      };

      // ── Circles / points ─────────────────────────────────────────────────
      svgRoot.querySelectorAll(
        'circle, [data-type="point"], [data-snap="point"]',
      ).forEach(el => {
        const sw = resolveStrokeWidth(el);
        if (isDecorationElement(el, sw)) return;
        const cx    = parseFloat(el.getAttribute('cx') || el.getAttribute('x') || '0');
        const cy    = parseFloat(el.getAttribute('cy') || el.getAttribute('y') || '0');
        const label = el.getAttribute('data-label') || el.getAttribute('label') || undefined;
        const pt    = toCanvas(el, cx, cy);
        extractedElements.push({
          id: `point-${idCounter++}`, type: 'point',
          x: pt.x, y: pt.y,
          element: el, attributes: getAttributes(el), label,
        });
      });

      // ── Explicit <line> elements ─────────────────────────────────────────
      svgRoot.querySelectorAll(
        'line, [data-type="line"], [data-snap="line"]',
      ).forEach(el => {
        const sw = resolveStrokeWidth(el);
        if (isDecorationElement(el, sw)) return;
        const rx1 = parseFloat(el.getAttribute('x1') || '0');
        const ry1 = parseFloat(el.getAttribute('y1') || '0');
        const rx2 = parseFloat(el.getAttribute('x2') || '0');
        const ry2 = parseFloat(el.getAttribute('y2') || '0');
        const label = el.getAttribute('data-label') || el.getAttribute('label') || undefined;
        const p1 = toCanvas(el, rx1, ry1);
        const p2 = toCanvas(el, rx2, ry2);
        extractedElements.push({
          id: `line-${idCounter++}`, type: 'line',
          x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
          length: Math.hypot(p2.x - p1.x, p2.y - p1.y),
          angle:  Math.atan2(p2.y - p1.y, p2.x - p1.x),
          element: el, attributes: getAttributes(el), label,
        });
      });

      // ── Open <path> → SvgLine ────────────────────────────────────────────
      svgRoot.querySelectorAll('path').forEach(el => {
        const sw = resolveStrokeWidth(el);
        if (isDecorationElement(el, sw)) return;
        const d = el.getAttribute('d') ?? '';
        if (/[Zz]/.test(d)) return;
        const rawPts = parsePathToPoints(d);
        if (rawPts.length < 2) return;
        const first = rawPts[0], last = rawPts[rawPts.length - 1];
        if (Math.hypot(last.x - first.x, last.y - first.y) < 2) return;
        const label = el.getAttribute('data-label') || el.getAttribute('label') || undefined;
        const p1 = toCanvas(el, first.x, first.y);
        const p2 = toCanvas(el, last.x, last.y);
        const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        if (len < 3) return;
        extractedElements.push({
          id: `line-${idCounter++}`, type: 'line',
          x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
          length: len, angle: Math.atan2(p2.y - p1.y, p2.x - p1.x),
          element: el, attributes: getAttributes(el), label,
        });
      });

      // ── Explicit closed shapes → SvgArea ─────────────────────────────────
      svgRoot.querySelectorAll(
        'path, polygon, [data-type="area"], [data-snap="area"]',
      ).forEach(el => {
        const sw = resolveStrokeWidth(el);
        if (isDecorationElement(el, sw)) return;

        const d = el.getAttribute('d') || '';

        if (el.tagName === 'path') {
          const hasZ = /[Zz]/.test(d);
          if (!hasZ) {
            const pts = parsePathToPoints(d);
            if (pts.length < 3) return;
            const first = pts[0], last = pts[pts.length - 1];
            if (Math.hypot(last.x - first.x, last.y - first.y) >= 2) return;
          }
        }

        const ctm = getCTM(el, svgEl);
        const transformPoint = (rx: number, ry: number) =>
          applyVBTransform(applyMatrix(ctm, { x: rx, y: ry }), vbt);

        let points: Array<{ x: number; y: number }> = [];

        if (el.tagName === 'polygon') {
          const raw    = el.getAttribute('points') || '';
          const coords = raw.trim().split(/[\s,]+/).map(parseFloat);
          for (let i = 0; i + 1 < coords.length; i += 2) {
            points.push(transformPoint(coords[i], coords[i + 1]));
          }
        } else if (el.tagName === 'path') {
          points = parsePathToPoints(d).map(p => transformPoint(p.x, p.y));
        }

        if (points.length < 3) return;
        if (isFullPageShape(points, pdfDimensions.w, pdfDimensions.h)) return;

        const bounds = points.reduce(
          (b, p) => ({
            minX: Math.min(b.minX, p.x), minY: Math.min(b.minY, p.y),
            maxX: Math.max(b.maxX, p.x), maxY: Math.max(b.maxY, p.y),
          }),
          { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
        );

        let area = 0;
        for (let i = 0; i < points.length; i++) {
          const j = (i + 1) % points.length;
          area += points[i].x * points[j].y - points[j].x * points[i].y;
        }
        area = Math.abs(area) / 2;
        if (area < MIN_AREA_THRESHOLD) return;

        const shapeW  = bounds.maxX - bounds.minX;
        const shapeH  = bounds.maxY - bounds.minY;
        const shorter = Math.min(shapeW, shapeH);
        const longer  = Math.max(shapeW, shapeH);
        if (shorter > 0 && longer / shorter > MAX_ASPECT_RATIO) return;

        const rawLabel = el.getAttribute('data-label') || el.getAttribute('label') || undefined;
        const label    = rawLabel ? (resolveRoomLabel(rawLabel) ?? rawLabel) : undefined;

        extractedElements.push({
          id: `area-${idCounter++}`, type: 'area',
          points, bounds, area,
          element: el, attributes: getAttributes(el), label,
        });
      });

      // ── Door symbol detection ────────────────────────────────────────────
      const doorAreas = detectDoorSymbols(svgRoot, svgEl, vbt, idCounter);
      idCounter += doorAreas.length;
      extractedElements.push(...doorAreas);

      // ── Wall-graph room detection (extracted to detectRoomAreas.ts) ──────
      const wallRooms = detectRoomAreas(
            svgRoot, svgEl, vbt, idCounter,
            pdfDimensions.w,   // ← canvasW
            pdfDimensions.h,   // ← canvasH
      );
      idCounter += wallRooms.length;

      // Deduplicate wall rooms against explicit closed-path areas
      const existingAreas = extractedElements.filter(e => e.type === 'area') as SvgArea[];
      const deduped = wallRooms.filter(wr =>
        !existingAreas.some(ea => {
          const overlapX = Math.max(0,
            Math.min(wr.bounds.maxX, ea.bounds.maxX) - Math.max(wr.bounds.minX, ea.bounds.minX));
          const overlapY = Math.max(0,
            Math.min(wr.bounds.maxY, ea.bounds.maxY) - Math.max(wr.bounds.minY, ea.bounds.minY));
          return (overlapX * overlapY) / wr.area > 0.8;
        }),
      );
      extractedElements.push(...deduped);

      // ── Index + publish ──────────────────────────────────────────────────
      const index = new Map<string, SvgElement>();
      extractedElements.forEach(el => index.set(el.id, el));
      setElements(extractedElements);
      spatialIndexRef.current = index;
      setLoading(false);

      const pts        = extractedElements.filter(e => e.type === 'point').length;
      const lns        = extractedElements.filter(e => e.type === 'line').length;
      const ars        = extractedElements.filter(e => e.type === 'area').length;
      const labelled   = deduped.filter(r => r.label).length;
      const explicitAr = ars - deduped.length - doorAreas.length;
      console.log(
        `[useSvgInteraction] points=${pts} lines=${lns} areas=${ars} ` +
        `(${doorAreas.length} doors + ${explicitAr} explicit + ` +
        `${deduped.length} wall-graph rooms, ${labelled}/${deduped.length} labelled)`,
      );

    } catch (err) {
      console.error('[useSvgInteraction] parse error:', err);
      setError(err instanceof Error ? err.message : 'Failed to parse SVG');
      setLoading(false);
    }
  }, [svgContent, pdfDimensions, enabled]);

  // ─── Snap ──────────────────────────────────────────────────────────────────
  const findNearestSnap = useCallback((mouseX: number, mouseY: number): SnapResult | null => {
    if (!enabled || elements.length === 0) return null;
    let best: SnapResult | null = null;

    for (const el of elements) {
      if (el.type === 'point') {
        const dist = Math.hypot(el.x - mouseX, el.y - mouseY);
        if (dist < snapThreshold && (!best || dist < best.distance))
          best = { type: 'point', element: el, snapPoint: { x: el.x, y: el.y }, distance: dist };
      }
    }
    if (!best) {
      for (const el of elements) {
        if (el.type === 'line') {
          const closest = closestPointOnLine(mouseX, mouseY, el.x1, el.y1, el.x2, el.y2);
          const dist    = Math.hypot(closest.x - mouseX, closest.y - mouseY);
          if (dist < snapThreshold && (!best || dist < best.distance))
            best = { type: 'line', element: el, snapPoint: closest, distance: dist };
        }
      }
    }
    if (!best) {
      for (const el of elements) {
        if (el.type === 'area') {
          if (mouseX >= el.bounds.minX && mouseX <= el.bounds.maxX &&
              mouseY >= el.bounds.minY && mouseY <= el.bounds.maxY &&
              pointInPolygon(mouseX, mouseY, el.points)) {
            const dist = distanceToPolygonEdge(mouseX, mouseY, el.points);
            if (dist < snapThreshold && (!best || dist < best.distance))
              best = { type: 'area', element: el, snapPoint: { x: mouseX, y: mouseY }, distance: dist };
          }
        }
      }
    }
    return best;
  }, [elements, snapThreshold, enabled]);

  // ─── Hit test ──────────────────────────────────────────────────────────────
  const hitTest = useCallback((mouseX: number, mouseY: number): SvgElement | null => {
    if (!enabled || elements.length === 0) return null;
    for (const el of elements) {
      if (el.type === 'area' && pointInPolygon(mouseX, mouseY, el.points)) return el;
    }
    for (const el of elements) {
      if (el.type === 'line') {
        const closest = closestPointOnLine(mouseX, mouseY, el.x1, el.y1, el.x2, el.y2);
        if (Math.hypot(closest.x - mouseX, closest.y - mouseY) < 10) return el;
      }
    }
    for (const el of elements) {
      if (el.type === 'point' && Math.hypot(el.x - mouseX, el.y - mouseY) < 12) return el;
    }
    return null;
  }, [elements, enabled]);

  const checkHover = useCallback((mouseX: number, mouseY: number) => {
    if (!enabled) { setHoveredElement(null); return null; }
    const hit = hitTest(mouseX, mouseY);
    setHoveredElement(hit);
    return hit;
  }, [hitTest, enabled]);

  const clearSelection = useCallback(() => setSelectedElement(null), []);
  const getElementById = useCallback((id: string) => spatialIndexRef.current.get(id), []);

  return {
    elements, hoveredElement, selectedElement,
    setSelectedElement, clearSelection,
    findNearestSnap, hitTest, checkHover, getElementById,
    loading, error,
  };
}
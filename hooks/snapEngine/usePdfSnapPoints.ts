'use client';
// ─── hooks/usePdfSnapPoints.ts ────────────────────────────────────────────────
//
// Extracts SvgLine snap data directly from a PDF page's vector operators
// using PDF.js getOperatorList(). No SVG file needed — works with any PDF.
//
// Usage:
//   const { svgLines, svgSnapPoints } = usePdfSnapPoints(pdf, pageNumber, pdfDimensions);
//
// Returns normalized SvgLine[] and SvgSnapPoint[] compatible with useSnapEngine.
// Re-runs whenever pdf or pageNumber changes.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef } from 'react';
import type { SvgSnapPoint } from '@/hooks/snapEngine/useSvgSnapPoints';
import type { SvgLine } from '@/hooks/snapEngine/useSvgSnapPoints';

interface PdfDimensions { w: number; h: number }

// ─── Dedup helper ─────────────────────────────────────────────────────────────

function dedup(pts: Array<[number, number]>, radius: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [x, y] of pts) {
    if (!out.some(([ox, oy]) => Math.hypot(x - ox, y - oy) < radius)) out.push([x, y]);
  }
  return out;
}

// ─── Intersection helper ──────────────────────────────────────────────────────

function segIntersection(
  s1: { x1: number; y1: number; x2: number; y2: number },
  s2: { x1: number; y1: number; x2: number; y2: number },
): [number, number] | null {
  const dx1 = s1.x2 - s1.x1, dy1 = s1.y2 - s1.y1;
  const dx2 = s2.x2 - s2.x1, dy2 = s2.y2 - s2.y1;
  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-8) return null;
  const dx3 = s2.x1 - s1.x1, dy3 = s2.y1 - s1.y1;
  const t = (dx3 * dy2 - dy3 * dx2) / denom;
  const u = (dx3 * dy1 - dy3 * dx1) / denom;
  const EPS = 0.01;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return [s1.x1 + t * dx1, s1.y1 + t * dy1];
}

// ─── PDF operator IDs (from PDF.js OPS enum) ─────────────────────────────────
// These are the numeric IDs PDF.js uses in getOperatorList()
const OPS_moveTo        = 13;  // m
const OPS_lineTo        = 14;  // l
const OPS_curveTo       = 15;  // c
const OPS_curveTo2      = 16;  // v
const OPS_curveTo3      = 17;  // y
const OPS_closePath     = 18;  // h
const OPS_rectangle     = 19;  // re
const OPS_constructPath = 91;  // constructPath (batched in newer PDF.js)

// ─── Extract lines from PDF.js operator list ─────────────────────────────────

interface RawSeg {
  x1: number; y1: number;
  x2: number; y2: number;
  isCurve?: boolean;
  midX?: number; midY?: number;
}

function extractSegsFromOps(
  fnArray: number[],
  argsArray: any[],
  pageHeight: number,
): RawSeg[] {
  const segs: RawSeg[] = [];
  let cx = 0, cy = 0;
  let subpathStartX = 0, subpathStartY = 0;

  // Flip Y: PDF coords have origin at bottom-left, canvas at top-left
  const flipY = (y: number) => pageHeight - y;

  const pushSeg = (ax: number, ay: number, bx: number, by: number) => {
    if (Math.hypot(bx - ax, by - ay) < 0.5) return;
    segs.push({ x1: ax, y1: ay, x2: bx, y2: by });
  };

  const pushCurve = (
    ax: number, ay: number,
    cp1x: number, cp1y: number,
    cp2x: number, cp2y: number,
    bx: number, by: number,
  ) => {
    if (Math.hypot(bx - ax, by - ay) < 0.5) return;
    // Midpoint at t=0.5 on cubic bezier
    const t = 0.5, u = 0.5;
    const midX = u*u*u*ax + 3*u*u*t*cp1x + 3*u*t*t*cp2x + t*t*t*bx;
    const midY = u*u*u*ay + 3*u*u*t*cp1y + 3*u*t*t*cp2y + t*t*t*by;
    segs.push({ x1: ax, y1: ay, x2: bx, y2: by, isCurve: true, midX, midY });
  };

  for (let i = 0; i < fnArray.length; i++) {
    const fn   = fnArray[i];
    const args = argsArray[i];

    if (fn === OPS_constructPath) {
      // Newer PDF.js batches path ops — recurse into the sub-list
      const [subFns, subArgs] = args as [number[], any[][]];
      const subSegs = extractSegsFromOps(subFns, subArgs, pageHeight);
      segs.push(...subSegs);
      continue;
    }

    switch (fn) {
      case OPS_moveTo: {
        const [x, y] = args as number[];
        cx = x; cy = flipY(y);
        subpathStartX = cx; subpathStartY = cy;
        break;
      }
      case OPS_lineTo: {
        const [x, y] = args as number[];
        const nx = x, ny = flipY(y);
        pushSeg(cx, cy, nx, ny);
        cx = nx; cy = ny;
        break;
      }
      case OPS_curveTo: {
        // c: cp1x cp1y cp2x cp2y x y
        const [cp1x, cp1y, cp2x, cp2y, x, y] = args as number[];
        const ncp1x = cp1x, ncp1y = flipY(cp1y);
        const ncp2x = cp2x, ncp2y = flipY(cp2y);
        const nx = x, ny = flipY(y);
        pushCurve(cx, cy, ncp1x, ncp1y, ncp2x, ncp2y, nx, ny);
        cx = nx; cy = ny;
        break;
      }
      case OPS_curveTo2: {
        // v: cp2x cp2y x y  (cp1 = current point)
        const [cp2x, cp2y, x, y] = args as number[];
        const ncp2x = cp2x, ncp2y = flipY(cp2y);
        const nx = x, ny = flipY(y);
        pushCurve(cx, cy, cx, cy, ncp2x, ncp2y, nx, ny);
        cx = nx; cy = ny;
        break;
      }
      case OPS_curveTo3: {
        // y: cp1x cp1y x y  (cp2 = end point)
        const [cp1x, cp1y, x, y] = args as number[];
        const ncp1x = cp1x, ncp1y = flipY(cp1y);
        const nx = x, ny = flipY(y);
        pushCurve(cx, cy, ncp1x, ncp1y, nx, flipY(y), nx, ny);
        cx = nx; cy = ny;
        break;
      }
      case OPS_closePath: {
        pushSeg(cx, cy, subpathStartX, subpathStartY);
        cx = subpathStartX; cy = subpathStartY;
        break;
      }
      case OPS_rectangle: {
        const [x, y, w, h] = args as number[];
        const rx = x, ry = flipY(y);
        const rx2 = x + w, ry2 = flipY(y + h);
        pushSeg(rx,  ry,  rx2, ry);
        pushSeg(rx2, ry,  rx2, ry2);
        pushSeg(rx2, ry2, rx,  ry2);
        pushSeg(rx,  ry2, rx,  ry);
        break;
      }
    }
  }

  return segs;
}

// ─── Build snap points from segs ─────────────────────────────────────────────

function buildSnapPoints(
  segs: RawSeg[],
  pw: number,
  ph: number,
): SvgSnapPoint[] {
  const snapPoints: SvgSnapPoint[] = [];

  // Endpoints
  const endpointPx = dedup(
    segs.flatMap(s => [[s.x1, s.y1], [s.x2, s.y2]] as Array<[number, number]>),
    3.0,
  );
  for (const [x, y] of endpointPx) {
    if (x < 0 || x > pw || y < 0 || y > ph) continue;
    snapPoints.push({ nx: x / pw, ny: y / ph, type: 'endpoint', shapeId: 'pdf-seg', strokeWidth: 1 });
  }

  // Midpoints (straight segs only)
  const straightSegs = segs.filter(s => !s.isCurve);
  const midCandidates: Array<[number, number]> = straightSegs.map(s => [
    (s.x1 + s.x2) / 2,
    (s.y1 + s.y2) / 2,
  ]);
  const dedupedMids = dedup(midCandidates, 4.0);
  for (const [x, y] of dedupedMids) {
    if (x < 0 || x > pw || y < 0 || y > ph) continue;
    snapPoints.push({ nx: x / pw, ny: y / ph, type: 'midpoint', shapeId: 'pdf-seg', strokeWidth: 1 });
  }

  // Curve midpoints
  const curveMids = dedup(
    segs
      .filter(s => s.isCurve && s.midX !== undefined)
      .map(s => [s.midX!, s.midY!] as [number, number]),
    4.0,
  );
  for (const [x, y] of curveMids) {
    if (x < 0 || x > pw || y < 0 || y > ph) continue;
    snapPoints.push({ nx: x / pw, ny: y / ph, type: 'midpoint', shapeId: 'pdf-curve', strokeWidth: 1 });
  }

  // Intersections (straight segs, skip parallel/near-parallel)
  const MAX = 2000;
  const segsForX = straightSegs.length > MAX
    ? straightSegs.filter(s => Math.hypot(s.x2 - s.x1, s.y2 - s.y1) > 5)
    : straightSegs;

  const intersectionPx: Array<[number, number]> = [];
  for (let i = 0; i < segsForX.length; i++) {
    for (let j = i + 1; j < segsForX.length; j++) {
      const s1 = segsForX[i], s2 = segsForX[j];
      const a1 = Math.atan2(s1.y2 - s1.y1, s1.x2 - s1.x1);
      const a2 = Math.atan2(s2.y2 - s2.y1, s2.x2 - s2.x1);
      const diff = Math.abs(a1 - a2) % Math.PI;
      if (Math.min(diff, Math.PI - diff) < 0.26) continue;
      const pt = segIntersection(s1, s2);
      if (!pt) continue;
      const [ix, iy] = pt;
      if (ix < -pw * 0.05 || ix > pw * 1.05 || iy < -ph * 0.05 || iy > ph * 1.05) continue;
      intersectionPx.push([ix, iy]);
    }
  }
  const dedupedIntersections = dedup(intersectionPx, 6.0);
  for (const [x, y] of dedupedIntersections) {
    snapPoints.push({ nx: x / pw, ny: y / ph, type: 'intersection', shapeId: 'pdf-corner', strokeWidth: 1.5 });
  }

  return snapPoints;
}

// ─── Build SvgLine[] from segs ────────────────────────────────────────────────

function buildSvgLines(segs: RawSeg[], pw: number, ph: number): SvgLine[] {
  return segs
    .filter(s => !s.isCurve)
    .map(s => ({
      nx1:     s.x1 / pw,
      ny1:     s.y1 / ph,
      nx2:     s.x2 / pw,
      ny2:     s.y2 / ph,
      shapeId: 'pdf-line',   // always defined — no more shapeId crash
    } as unknown as SvgLine));
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function usePdfSnapPoints(
  pdf:           any,
  pageNumber:    number,
  pdfDimensions: PdfDimensions | null,
): {
  svgLines:     SvgLine[];
  svgSnapPoints: SvgSnapPoint[];
} {
  const [svgLines,      setSvgLines]      = useState<SvgLine[]>([]);
  const [svgSnapPoints, setSvgSnapPoints] = useState<SvgSnapPoint[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!pdf || !pdfDimensions) {
      setSvgLines([]);
      setSvgSnapPoints([]);
      return;
    }

    // Cancel any in-flight extraction
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const { w: pw, h: ph } = pdfDimensions;

    pdf.getPage(pageNumber).then((page: any) => {
      if (controller.signal.aborted) return;
      return page.getOperatorList();
    }).then((opList: any) => {
      if (!opList || controller.signal.aborted) return;

      // Run in a microtask to avoid blocking the render thread
      return new Promise<void>(resolve => {
        setTimeout(() => {
          if (controller.signal.aborted) { resolve(); return; }
          try {
            const segs = extractSegsFromOps(opList.fnArray, opList.argsArray, ph);
            const lines = buildSvgLines(segs, pw, ph);
            const snaps = buildSnapPoints(segs, pw, ph);

            if (!controller.signal.aborted) {
              setSvgLines(lines);
              setSvgSnapPoints(snaps);
              console.log(
                `[usePdfSnapPoints] page ${pageNumber}: ` +
                `${segs.length} segs → ${lines.length} lines, ${snaps.length} snap pts`,
              );
            }
          } catch (err) {
            if (!controller.signal.aborted) {
              console.warn('[usePdfSnapPoints] extraction error:', err);
            }
          }
          resolve();
        }, 0);
      });
    }).catch((err: any) => {
      if (!controller.signal.aborted) {
        console.warn('[usePdfSnapPoints] getOperatorList failed:', err);
      }
    });

    return () => { controller.abort(); };
  }, [pdf, pageNumber, pdfDimensions]);

  return { svgLines, svgSnapPoints };
}

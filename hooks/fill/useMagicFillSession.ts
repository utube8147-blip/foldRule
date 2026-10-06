'use client';
// ─── hooks/fill/useMagicFillSession.ts ───────────────────────────────────────
//
//  FIX: zoom-agnostic mask building
//  Previously buildNormalisedWallMask was called on pdfCanvasRef.current whose
//  bitmap resolution scales with committedScale. At low zoom, thin wall lines
//  collapse to sub-pixel and flood-fill leaks through them.
//
//  Now we render the PDF page into a dedicated off-screen canvas at a fixed
//  MASK_SCALE (3×) every time pdfRenderCount changes. The viewer's zoom has
//  no effect on mask quality. Coordinate conversion in handleMagicSingleClick
//  and handleMagicPolygonFill already uses maskWRef/maskHRef for scaling, so
//  clicks at any viewer zoom map correctly into the high-res mask space.
//
//  IMPROVEMENTS (previous revision — mirrors svgPathUtils.js improvements):
//
//  1. OUTLINE SHRINK (improvement 1) — NOW DISABLED (WALL_HALF_PX = 0)
//  2. SVG WALL-LINE SNAPPING (improvement 2)
//  3. ANGLE-CONSTRAINED RDP (improvement 3)
//  4. TIGHTER RDP + PER-SEGMENT EPSILON (improvement 4)
//
// ─────────────────────────────────────────────────────────────────────────────

import { buildWallMaskInWorker, maskCache } from './wallMaskClient';
import { maskOutlineMeasure } from './fillArea';
import { getPageRegions, putPageRegions, type StoredRegion } from '@/lib/storage/projectDb';
import { REFERENCE_LONG_EDGE } from './fillMaskAndSvgPath';
import { fillPreview } from '@/components/Viewer/RoomHoverOverlay';
import { mergeRings, ringArea, ringPerimeter } from '@/lib/geometry/ringUnion';
import { subtractShapes, intersectShapes, shapeArea } from '@/lib/geometry/regionOps';
import { pickRoomLabel, type TextItem } from '@/lib/takeoff/roomLabels';
import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { MagicFill }     from '@/hooks/fill/useMagicFill';
import type { PdfDimensions } from '@/types/viewerTypes';
import type { TakeoffRow }    from '@/types';

import {
  buildNormalisedWallMask,
} from '@/hooks/fill/fillMaskAndSvgPath';

import { SVG_PATH_UTILS_SOURCE } from '@/workers/svgPathUtils';

// ── Fixed scale used when rendering the PDF off-screen for mask building.
//    High enough that thin wall lines (≥0.5 pt) survive as ≥1-px strokes.
//    Completely independent of whatever committedScale the viewer is at.
const MASK_SCALE = 3;
/**
 * Lasso fills join pieces whose outlines are within twice this many mask
 * pixels of each other — i.e. separated by a thin drawn line, not by a wall.
 */
const LINE_BRIDGE_PX = 3;
/**
 * Cap on the off-screen mask render. At 3× an A1 sheet is ~36 million pixels
 * (≈144 MB of RGBA) — which is what froze the app when switching plans with
 * Magic Fill selected. 12 MP keeps walls crisp while staying responsive.
 */
const MAX_MASK_PIXELS = 12_000_000;

const FILL_COLORS = [
  '#60a5fa','#34d399','#fbbf24','#f87171','#a78bfa',
  '#f472b6','#22d3ee','#a3e635','#fb923c','#818cf8',
];

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

// ── SVG line segment type (normalised [0-1] coords from useSvgSnapPoints) ────
export interface NormalisedSvgLine {
  x1: number; y1: number;
  x2: number; y2: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared smoothing-pipeline source inlined into both worker blobs.
// ─────────────────────────────────────────────────────────────────────────────

const MF_SMOOTH_CONTOUR_SOURCE = /* js */`
const WALL_HALF_PX = 0;

function mfMarchingSquares(mask, w, h) {
  const W = w + 2, H = h + 2;
  const field = new Uint8Array(W * H);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (mask[y * w + x]) field[(y + 1) * W + (x + 1)] = 1;
  let startX = -1, startY = -1;
  outer: for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (field[y * W + x]) { startX = x; startY = y; break outer; }
  if (startX === -1) return [];
  const dx8 = [ 1, 1, 0,-1,-1,-1, 0, 1];
  const dy8 = [ 0, 1, 1, 1, 0,-1,-1,-1];
  const contour = [];
  let cx = startX, cy = startY;
  let backX = startX - 1, backY = startY;
  let steps = 0;
  const maxSteps = W * H * 2;
  do {
    contour.push([cx - 1, cy - 1]);
    const wantDx = backX - cx, wantDy = backY - cy;
    let startDir = 0;
    for (let d = 0; d < 8; d++)
      if (dx8[d] === wantDx && dy8[d] === wantDy) { startDir = d; break; }
    let moved = false;
    for (let t = 0; t < 8; t++) {
      const d = (startDir + t) % 8;
      const nx = cx + dx8[d], ny = cy + dy8[d];
      if (nx >= 0 && nx < W && ny >= 0 && ny < H && field[ny * W + nx]) {
        const bd = (startDir + t - 1 + 8) % 8;
        backX = cx + dx8[bd];
        backY = cy + dy8[bd];
        cx = nx; cy = ny; moved = true; break;
      }
    }
    if (!moved) break;
    if (++steps > maxSteps) break;
  } while (!(cx === startX && cy === startY));
  return contour;
}

function mfRdpSimplify(pts, eps) {
  if (pts.length <= 3) return pts;
  const distToLine = (p, a, b) => {
    const [ax, ay] = a, [bx, by] = b, [px, py] = p;
    const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px-ax)*(bx-ax) + (py-ay)*(by-ay)) / len2));
    return Math.hypot(px - (ax + t*(bx-ax)), py - (ay + t*(by-ay)));
  };
  const keep = new Set([0, pts.length - 1]);
  const rec = (lo, hi) => {
    if (hi - lo < 2) return;
    let maxD = 0, idx = lo;
    for (let i = lo + 1; i < hi; i++) {
      const d = distToLine(pts[i], pts[lo], pts[hi]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps) { keep.add(idx); rec(lo, idx); rec(idx, hi); }
  };
  rec(0, pts.length - 1);
  return [...keep].sort((a, b) => a - b).map(i => pts[i]);
}

function mfAdaptiveRdp(pts) {
  if (pts.length < 4) return pts;
  let perim = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    perim += Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
  }
  // Under one mask pixel: enough to flatten the pixel staircase of a straight
  // or diagonal wall into a single edge, but small enough that a curved wall
  // keeps its shape. (This used to grow to 3 px for large rooms, which turned
  // circles and arcs into visibly flat-sided polygons wherever the outline
  // could not be snapped onto the drawing's own arc — thick walls, mostly.)
  const eps = Math.max(0.5, Math.min(0.9, perim / 400));
  return mfRdpSimplify(pts, eps);
}

function mfPolygonPerim(pts) {
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    p += Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
  }
  return Math.round(p);
}

function mfPolygonToPath(poly) {
  if (!poly.length) return '';
  let d = 'M' + poly[0][0] + ',' + poly[0][1];
  for (let i = 1; i < poly.length; i++) d += ' L' + poly[i][0] + ',' + poly[i][1];
  return d + ' Z';
}

function mfErode(src, w, h, r) {
  const horiz = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let zeros = 0;
    for (let x = 0; x < r && x < w; x++) if (!src[y * w + x]) zeros++;
    for (let x = 0; x < w; x++) {
      const add = x + r; if (add < w && !src[y * w + add]) zeros++;
      if (zeros === 0) horiz[y * w + x] = 1;
      const rem = x - r; if (rem >= 0 && !src[y * w + rem]) zeros--;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let zeros = 0;
    for (let y = 0; y < r && y < h; y++) if (!horiz[y * w + x]) zeros++;
    for (let y = 0; y < h; y++) {
      const add = y + r; if (add < h && !horiz[add * w + x]) zeros++;
      if (zeros === 0) out[y * w + x] = 1;
      const rem = y - r; if (rem >= 0 && !horiz[rem * w + x]) zeros--;
    }
  }
  return out;
}

function mfOuterShape(filled, w, h) {
  return mfErode(filled, w, h, WALL_HALF_PX);
}

function mfBuildSmoothPolygon(mask, w, h) {
  const outer = mfOuterShape(mask, w, h);
  const raw   = mfMarchingSquares(outer, w, h);
  if (raw.length === 0) {
    let minX = w, minY = h, maxX = 0, maxY = 0;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const x = i % w, y = (i / w) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return [[minX,minY],[maxX,minY],[maxX,maxY],[minX,maxY]];
  }
  return mfAdaptiveRdp(raw);
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// RASTER WORKER — single-click flood fill
// ─────────────────────────────────────────────────────────────────────────────
export const RASTER_WORKER_SOURCE = /* js */`
${SVG_PATH_UTILS_SOURCE}
${MF_SMOOTH_CONTOUR_SOURCE}

const FILL_GROW = 3;
const OFFSETS_R = [
  [0,0],[1,0],[-1,0],[0,1],[0,-1],
  [2,0],[-2,0],[0,2],[0,-2],
  [1,1],[-1,1],[1,-1],[-1,-1],
];

function scanlineFill(mask, w, h, sx, sy) {
  if (sx < 0 || sx >= w || sy < 0 || sy >= h || mask[sy * w + sx]) return null;
  const filled  = new Uint8Array(w * h);
  const visited = new Uint8Array(w * h);
  const stack   = new Int32Array(w * h);
  let top = 0;
  stack[top++] = sy * w + sx;
  visited[sy * w + sx] = 1;
  while (top > 0) {
    const idx = stack[--top];
    const cy  = (idx / w) | 0;
    const cx  = idx % w;
    let left = cx;
    while (left > 0 && !mask[cy * w + left - 1] && !visited[cy * w + left - 1]) left--;
    let right = cx;
    while (right < w - 1 && !mask[cy * w + right + 1] && !visited[cy * w + right + 1]) right++;
    for (let x = left; x <= right; x++) { filled[cy * w + x] = 1; visited[cy * w + x] = 1; }
    const up = (cy - 1) * w, dn = (cy + 1) * w;
    for (let x = left; x <= right; x++) {
      if (cy > 0   && !mask[up + x] && !visited[up + x]) { visited[up + x] = 1; stack[top++] = up + x; }
      if (cy < h-1 && !mask[dn + x] && !visited[dn + x]) { visited[dn + x] = 1; stack[top++] = dn + x; }
    }
  }
  let count = 0;
  for (let i = 0; i < filled.length; i++) if (filled[i]) count++;
  if (count / (w * h) > 0.80) return null;
  return count > 4 ? filled : null;
}

function dilateMaskFast(src, w, h, r) {
  const horiz = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let count = 0;
    for (let x = 0; x < r && x < w; x++) if (src[y * w + x]) count++;
    for (let x = 0; x < w; x++) {
      const add = x + r; if (add < w && src[y * w + add]) count++;
      if (count > 0) horiz[y * w + x] = 1;
      const rem = x - r; if (rem >= 0 && src[y * w + rem]) count--;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y < r && y < h; y++) if (horiz[y * w + x]) count++;
    for (let y = 0; y < h; y++) {
      const add = y + r; if (add < h && horiz[add * w + x]) count++;
      if (count > 0) out[y * w + x] = 1;
      const rem = y - r; if (rem >= 0 && horiz[rem * w + x]) count--;
    }
  }
  return out;
}

function multiSeedFill(mask, w, h, cx, cy) {
  let merged = null, mergedDilated = null;
  for (const [dx, dy] of OFFSETS_R) {
    const f = scanlineFill(mask, w, h, cx + dx, cy + dy);
    if (!f) continue;
    if (!merged) {
      merged = f;
      mergedDilated = dilateMaskFast(f, w, h, FILL_GROW + 2);
    } else {
      let overlaps = false;
      for (let i = 0; i < f.length; i++) { if (f[i] && mergedDilated[i]) { overlaps = true; break; } }
      if (overlaps) {
        for (let i = 0; i < merged.length; i++) if (f[i]) merged[i] = 1;
        mergedDilated = dilateMaskFast(merged, w, h, FILL_GROW + 2);
      }
    }
  }
  if (merged) {
    let c = 0;
    for (let i = 0; i < merged.length; i++) if (merged[i]) c++;
    if (c / (w * h) > 0.80) return null;
  }
  return merged;
}

function closeHoles(filled, w, h) {
  const outside = new Uint8Array(w * h);
  const stack = [];
  const push = (i) => { if (i >= 0 && i < w * h && !filled[i] && !outside[i]) { outside[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 1; y < h - 1; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i / w) | 0;
    if (x > 0)   push(i - 1);
    if (x < w-1) push(i + 1);
    if (y > 0)   push(i - w);
    if (y < h-1) push(i + w);
  }
  const closed = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) closed[i] = filled[i] || (!outside[i] ? 1 : 0);
  return closed;
}

function paintFill(mask, d, r, g, b, opacity) {
  const newA = opacity;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const di = i * 4;
    const existA = d[di + 3] / 255;
    const outA = newA + existA * (1 - newA);
    if (outA > 0) {
      d[di]   = ((r * newA + d[di]   * existA * (1 - newA)) / outA) | 0;
      d[di+1] = ((g * newA + d[di+1] * existA * (1 - newA)) / outA) | 0;
      d[di+2] = ((b * newA + d[di+2] * existA * (1 - newA)) / outA) | 0;
      d[di+3] = (outA * 255) | 0;
    }
  }
}

function maskArea(mask) {
  let c = 0; for (let i = 0; i < mask.length; i++) if (mask[i]) c++; return c;
}

self.onmessage = ({ data }) => {
  const { maskBuffer, fillDataBuffer, w, h, cx, cy, r, g, b, opacity, svgLines } = data;
  const mask = new Uint8Array(maskBuffer);
  const fillDataArr = new Uint8ClampedArray(fillDataBuffer);
  const filled = multiSeedFill(mask, w, h, cx, cy);
  if (!filled) { self.postMessage({ empty: true }); return; }
  const closed = closeHoles(filled, w, h);
  paintFill(closed, fillDataArr, r, g, b, opacity);

  const areaPx = maskArea(closed);

  const polygon = mfBuildSmoothPolygon(closed, w, h);
  const perimPx = mfPolygonPerim(polygon);

  const svgPath = maskToSvgPath(closed, w, h, svgLines || null);

  self.postMessage(
    { fillDataBuffer: fillDataArr.buffer, closedBuffer: closed.buffer, areaPx, perimPx, polygon, svgPath },
    [fillDataArr.buffer, closed.buffer],
  );
};
`;

// ─────────────────────────────────────────────────────────────────────────────
// ROOMS WORKER — every enclosed area on the page, found once and saved.
//
// Mirrors what a click fills: 4-connected scanline regions of open space,
// islands filled in (closeHoles), smoothed outline via mfBuildSmoothPolygon.
// Each region is processed inside its own bounding box, so the total work is
// roughly one pass over the page. Tiny areas (text counters, hatch cells) are
// skipped — clicks there use the normal flood fill.
// ─────────────────────────────────────────────────────────────────────────────
/** Bump when the room-finding algorithm changes (saved rooms get rebuilt). */
export const ROOMS_VERSION = 4;   // v2: skip regions covering > 80% of the page · v3: thin lines are walls · v4: curved walls keep their shape

/** Same seed pattern as OFFSETS_R inside the raster worker (keep in sync). */
const SEED_OFFSETS: [number, number][] = [
  [0,0],[1,0],[-1,0],[0,1],[0,-1],
  [2,0],[-2,0],[0,2],[0,-2],
  [1,1],[-1,1],[1,-1],[-1,-1],
];

export const ROOMS_WORKER_SOURCE = /* js */`
${SVG_PATH_UTILS_SOURCE}
${MF_SMOOTH_CONTOUR_SOURCE}

function closeHoles(filled, w, h) {
  const outside = new Uint8Array(w * h);
  const stack = [];
  const push = (i) => { if (i >= 0 && i < w * h && !filled[i] && !outside[i]) { outside[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 1; y < h - 1; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i / w) | 0;
    if (x > 0)   push(i - 1);
    if (x < w-1) push(i + 1);
    if (y > 0)   push(i - w);
    if (y < h-1) push(i + w);
  }
  const closed = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) closed[i] = filled[i] || (!outside[i] ? 1 : 0);
  return closed;
}

self.onmessage = ({ data }) => {
  const { maskBuffer, w, h, minArea } = data;
  const mask  = new Uint8Array(maskBuffer);
  const N     = w * h;
  const label = new Int32Array(N);
  const stack = new Int32Array(N);
  const comps = [];
  let next = 1;

  // 1. Label every open-space region (same 4-connected scanline walk as a click).
  for (let s = 0; s < N; s++) {
    if (mask[s] || label[s]) continue;
    const id = next++;
    let count = 0, x0 = w, y0 = h, x1 = 0, y1 = 0, top = 0;
    stack[top++] = s; label[s] = id;
    while (top > 0) {
      const idx = stack[--top];
      const cy = (idx / w) | 0, cx = idx % w, row = cy * w;
      let left = cx;
      while (left > 0 && !mask[row + left - 1] && !label[row + left - 1]) left--;
      let right = cx;
      while (right < w - 1 && !mask[row + right + 1] && !label[row + right + 1]) right++;
      for (let x = left; x <= right; x++) label[row + x] = id;
      count += right - left + 1;
      if (left < x0) x0 = left; if (right > x1) x1 = right;
      if (cy < y0) y0 = cy;     if (cy > y1) y1 = cy;
      const up = row - w, dn = row + w;
      for (let x = left; x <= right; x++) {
        if (cy > 0     && !mask[up + x] && !label[up + x]) { label[up + x] = id; stack[top++] = up + x; }
        if (cy < h - 1 && !mask[dn + x] && !label[dn + x]) { label[dn + x] = id; stack[top++] = dn + x; }
      }
    }
    comps.push({ id, count, x0, y0, x1, y1 });
  }

  // 2. Outline each usable region inside its bounding box.
  const regions = [];
  for (const c of comps) {
    if (c.count <= 4 || c.count < minArea || c.count / N > 0.80) continue;
    const cw = c.x1 - c.x0 + 3, ch = c.y1 - c.y0 + 3;
    const crop = new Uint8Array(cw * ch);
    for (let y = c.y0; y <= c.y1; y++) {
      const src = y * w, dst = (y - c.y0 + 1) * cw + 1 - c.x0;
      for (let x = c.x0; x <= c.x1; x++) if (label[src + x] === c.id) crop[dst + x] = 1;
    }
    const closed = closeHoles(crop, cw, ch);
    let areaPx = 0;
    for (let i = 0; i < closed.length; i++) if (closed[i]) areaPx++;
    // The open space around a building closes up into (nearly) the whole
    // page — that's not a room.
    if (areaPx / N > 0.80) continue;
    const poly = mfBuildSmoothPolygon(closed, cw, ch);
    if (!poly || poly.length < 3) continue;
    const polygon = poly.map(([x, y]) => [
      Math.round((x + c.x0 - 1) * 10) / 10,
      Math.round((y + c.y0 - 1) * 10) / 10,
    ]);
    regions.push({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, areaPx, perimPx: mfPolygonPerim(polygon), polygon });
  }
  self.postMessage({ regions });
};
`;

// ─────────────────────────────────────────────────────────────────────────────
// POLYGON LASSO WORKER — fills all rooms inside a user-drawn polygon
// ─────────────────────────────────────────────────────────────────────────────
const POLYGON_WORKER_SOURCE = /* js */`
${SVG_PATH_UTILS_SOURCE}
${MF_SMOOTH_CONTOUR_SOURCE}

function cropMask(full, W, x1, y1, x2, y2) {
  const lw = x2 - x1 + 1, lh = y2 - y1 + 1;
  const local = new Uint8Array(lw * lh);
  for (let ly = 0; ly < lh; ly++) {
    const fy = (y1 + ly) * W + x1;
    const lbase = ly * lw;
    for (let lx = 0; lx < lw; lx++) local[lbase + lx] = full[fy + lx];
  }
  return local;
}

function expandLocalFill(result, seen, unioned, W) {
  const { localFilled, lw, lh, x1, y1 } = result;
  for (let ly = 0; ly < lh; ly++) {
    const fy = (y1 + ly) * W + x1;
    const lbase = ly * lw;
    for (let lx = 0; lx < lw; lx++) {
      if (localFilled[lbase + lx]) { seen[fy + lx] = 1; if (unioned) unioned[fy + lx] = 1; }
    }
  }
}

function rasterizePolygon(poly, w, h) {
  let bx1 = Infinity, by1 = Infinity, bx2 = -Infinity, by2 = -Infinity;
  for (const [px, py] of poly) {
    if (px < bx1) bx1 = px; if (px > bx2) bx2 = px;
    if (py < by1) by1 = py; if (py > by2) by2 = py;
  }
  const x1 = Math.max(0, Math.floor(bx1)), y1 = Math.max(0, Math.floor(by1));
  const x2 = Math.min(w - 1, Math.ceil(bx2)), y2 = Math.min(h - 1, Math.ceil(by2));
  const inside = new Uint8Array(w * h);
  const n = poly.length;
  for (let y = y1; y <= y2; y++) {
    const xs = [];
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi <= y && yj > y) || (yj <= y && yi > y))
        xs.push(xi + (y - yi) / (yj - yi) * (xj - xi));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const lx = Math.max(x1, Math.ceil(xs[k])), rx = Math.min(x2, Math.floor(xs[k + 1]));
      for (let x = lx; x <= rx; x++) inside[y * w + x] = 1;
    }
  }
  return { inside, x1, y1, x2, y2 };
}

function scanlineFillLocal(localMask, lw, lh, W, H, lsx, lsy) {
  if (lsx < 0 || lsx >= lw || lsy < 0 || lsy >= lh || localMask[lsy * lw + lsx]) return null;
  const filled = new Uint8Array(lw * lh), visited = new Uint8Array(lw * lh);
  const stack  = new Int32Array(lw * lh);
  let top = 0;
  stack[top++] = lsy * lw + lsx; visited[lsy * lw + lsx] = 1;
  while (top > 0) {
    const idx = stack[--top], cy = (idx / lw) | 0, cx = idx % lw;
    let left = cx, right = cx;
    while (left > 0 && !localMask[cy * lw + left - 1] && !visited[cy * lw + left - 1]) left--;
    while (right < lw - 1 && !localMask[cy * lw + right + 1] && !visited[cy * lw + right + 1]) right++;
    for (let x = left; x <= right; x++) { filled[cy * lw + x] = 1; visited[cy * lw + x] = 1; }
    const up = (cy - 1) * lw, dn = (cy + 1) * lw;
    for (let x = left; x <= right; x++) {
      if (cy > 0    && !localMask[up + x] && !visited[up + x]) { visited[up + x] = 1; stack[top++] = up + x; }
      if (cy < lh-1 && !localMask[dn + x] && !visited[dn + x]) { visited[dn + x] = 1; stack[top++] = dn + x; }
    }
  }
  let count = 0;
  for (let i = 0; i < filled.length; i++) if (filled[i]) count++;
  if (count / (W * H) > 0.80 || count <= 4) return null;
  return filled;
}

const OFFSETS = [[0,0],[1,0],[-1,0],[0,1],[0,-1],[2,0],[-2,0],[0,2],[0,-2],[1,1],[-1,1],[1,-1],[-1,-1]];
const BBOX_PAD = 32, MAX_PROBE = 4096;

function multiSeedFillLocal(fullMask, W, H, cx, cy) {
  if (cx < 0 || cx >= W || cy < 0 || cy >= H || fullMask[cy * W + cx]) return null;
  const probeVisited = new Uint8Array(W * H), probeStack = [cy * W + cx];
  probeVisited[cy * W + cx] = 1;
  let probeCount = 0, bx1 = cx, by1 = cy, bx2 = cx, by2 = cy;
  while (probeStack.length && probeCount < MAX_PROBE) {
    const idx = probeStack.pop(), py = (idx / W) | 0, px = idx % W;
    probeCount++;
    if (px < bx1) bx1 = px; if (px > bx2) bx2 = px;
    if (py < by1) by1 = py; if (py > by2) by2 = py;
    for (const d of [-1, 1, -W, W]) {
      const j = idx + d;
      if (j < 0 || j >= W * H || fullMask[j] || probeVisited[j]) continue;
      probeVisited[j] = 1; probeStack.push(j);
    }
  }
  const hitLimit = probeCount >= MAX_PROBE;
  const pad = hitLimit ? Math.max(BBOX_PAD, Math.max(bx2 - bx1, by2 - by1)) : BBOX_PAD;
  const x1 = Math.max(0, bx1 - pad), y1 = Math.max(0, by1 - pad);
  const x2 = Math.min(W - 1, bx2 + pad), y2 = Math.min(H - 1, by2 + pad);
  const lw = x2 - x1 + 1, lh = y2 - y1 + 1;
  const localMask = cropMask(fullMask, W, x1, y1, x2, y2);
  let merged = null;
  for (const [dx, dy] of OFFSETS) {
    const f = scanlineFillLocal(localMask, lw, lh, W, H, (cx + dx) - x1, (cy + dy) - y1);
    if (!f) continue;
    if (!merged) { merged = f; }
    else {
      let overlaps = false;
      const LDIRS = [-1, 1, -lw, lw, -lw-1, -lw+1, lw-1, lw+1];
      outer: for (let i = 0; i < f.length; i++) {
        if (!f[i]) continue; if (merged[i]) { overlaps = true; break; }
        for (const d of LDIRS) { const j = i + d; if (j >= 0 && j < merged.length && merged[j]) { overlaps = true; break outer; } }
      }
      if (overlaps) for (let i = 0; i < merged.length; i++) if (f[i]) merged[i] = 1;
    }
  }
  if (!merged) return null;
  let count = 0; for (let i = 0; i < merged.length; i++) if (merged[i]) count++;
  if (count / (W * H) > 0.80 || count <= 4) return null;
  return { localFilled: merged, lw, lh, x1, y1, x2, y2 };
}

function closeHolesFull(filled, w, h) {
  const outside = new Uint8Array(w * h), stack = [];
  const push = (i) => { if (i >= 0 && i < w * h && !filled[i] && !outside[i]) { outside[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 1; y < h - 1; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop(), x = i % w, y = (i / w) | 0;
    if (x > 0)   push(i - 1); if (x < w-1) push(i + 1);
    if (y > 0)   push(i - w); if (y < h-1) push(i + w);
  }
  const closed = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) closed[i] = filled[i] || (!outside[i] ? 1 : 0);
  return closed;
}

function dilateMaskFast(src, w, h, r) {
  const horiz = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let count = 0;
    for (let x = 0; x < r && x < w; x++) if (src[y * w + x]) count++;
    for (let x = 0; x < w; x++) {
      const add = x + r; if (add < w && src[y * w + add]) count++;
      if (count > 0) horiz[y * w + x] = 1;
      const rem = x - r; if (rem >= 0 && src[y * w + rem]) count--;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y < r && y < h; y++) if (horiz[y * w + x]) count++;
    for (let y = 0; y < h; y++) {
      const add = y + r; if (add < h && horiz[add * w + x]) count++;
      if (count > 0) out[y * w + x] = 1;
      const rem = y - r; if (rem >= 0 && horiz[rem * w + x]) count--;
    }
  }
  return out;
}

function erodeMaskFast(src, w, h, r) {
  const horiz = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let zeros = 0;
    for (let x = 0; x < r && x < w; x++) if (!src[y * w + x]) zeros++;
    for (let x = 0; x < w; x++) {
      const add = x + r; if (add < w && !src[y * w + add]) zeros++;
      if (zeros === 0) horiz[y * w + x] = 1;
      const rem = x - r; if (rem >= 0 && !src[y * w + rem]) zeros--;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let zeros = 0;
    for (let y = 0; y < r && y < h; y++) if (!horiz[y * w + x]) zeros++;
    for (let y = 0; y < h; y++) {
      const add = y + r; if (add < h && !horiz[add * w + x]) zeros++;
      if (zeros === 0) out[y * w + x] = 1;
      const rem = y - r; if (rem >= 0 && !horiz[rem * w + x]) zeros--;
    }
  }
  return out;
}

function maskArea(mask) { let c = 0; for (let i = 0; i < mask.length; i++) if (mask[i]) c++; return c; }

function paintFill(mask, d, r, g, b, opacity) {
  const newA = opacity;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const di = i * 4;
    const existA = d[di + 3] / 255;
    const outA = newA + existA * (1 - newA);
    if (outA > 0) {
      d[di]   = ((r * newA + d[di]   * existA * (1 - newA)) / outA) | 0;
      d[di+1] = ((g * newA + d[di+1] * existA * (1 - newA)) / outA) | 0;
      d[di+2] = ((b * newA + d[di+2] * existA * (1 - newA)) / outA) | 0;
      d[di+3] = (outA * 255) | 0;
    }
  }
}

function findRegionsInsidePolygon(fullMask, W, H, poly) {
  const { inside, x1, y1, x2, y2 } = rasterizePolygon(poly, W, H);
  const unioned = new Uint8Array(W * H), seen = new Uint8Array(W * H);
  const localResults = [];
  const bboxSide = Math.min(x2 - x1, y2 - y1);
  const step = Math.max(2, Math.min(6, Math.round(bboxSide / 120)));
  for (let sy = y1; sy <= y2; sy += step) {
    for (let sx = x1; sx <= x2; sx += step) {
      if (!inside[sy * W + sx] || fullMask[sy * W + sx] || seen[sy * W + sx]) continue;
      const result = multiSeedFillLocal(fullMask, W, H, sx, sy);
      if (!result) { seen[sy * W + sx] = 1; continue; }
      expandLocalFill(result, seen, unioned, W); localResults.push(result);
    }
  }
  for (let sy = y1; sy <= y2; sy++) {
    for (let sx = x1; sx <= x2; sx++) {
      if (!inside[sy * W + sx] || fullMask[sy * W + sx] || seen[sy * W + sx]) continue;
      const result = multiSeedFillLocal(fullMask, W, H, sx, sy);
      if (!result) { seen[sy * W + sx] = 1; continue; }
      expandLocalFill(result, seen, unioned, W); localResults.push(result);
    }
  }
  return { localResults, unioned, inside };
}

const ROOM_GROW = 10;

function buildSolidFill(unioned, inside, fullMask, w, h) {
  const seeded = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++)
    seeded[i] = (unioned[i] || (inside[i] && !fullMask[i])) ? 1 : 0;
  const grown  = dilateMaskFast(seeded, w, h, ROOM_GROW);
  const closed = closeHolesFull(grown, w, h);
  const eroded = erodeMaskFast(closed, w, h, ROOM_GROW);
  const final  = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) final[i] = (eroded[i] || seeded[i]) ? 1 : 0;
  return final;
}

self.onmessage = ({ data }) => {
  const { maskBuffer, fillDataBuffer, w, h, r, g, b, opacity, poly, svgLines } = data;
  const fullMask = new Uint8Array(maskBuffer);
  const { localResults, unioned, inside } = findRegionsInsidePolygon(fullMask, w, h, poly);
  if (localResults.length === 0) {
    let anyInside = false;
    for (let i = 0; i < w * h; i++) { if (inside[i] && !fullMask[i]) { anyInside = true; break; } }
    if (!anyInside) { self.postMessage({ empty: true }); return; }
    for (let i = 0; i < w * h; i++) { if (inside[i] && !fullMask[i]) unioned[i] = 1; }
  }
  const closed  = buildSolidFill(unioned, inside, fullMask, w, h);
  const areaPx  = maskArea(closed);
  if (areaPx / (w * h) > 0.80) { self.postMessage({ error: 'leak' }); return; }
  if (areaPx === 0) { self.postMessage({ empty: true }); return; }

  const fillDataArr = new Uint8ClampedArray(fillDataBuffer);
  paintFill(closed, fillDataArr, r, g, b, opacity);

  const polygon = mfBuildSmoothPolygon(closed, w, h);
  const perimPx = mfPolygonPerim(polygon);

  const svgPath = maskToSvgPath(closed, w, h, svgLines || null);

  const regionCount = Math.max(1, localResults.length);
  self.postMessage(
    { fillDataBuffer: fillDataArr.buffer, closedBuffer: closed.buffer, polygon, areaPx, perimPx, svgPath, regionCount },
    [fillDataArr.buffer, closed.buffer],
  );
};
`;

// ─────────────────────────────────────────────────────────────────────────────
// Worker lifecycle helpers
// ─────────────────────────────────────────────────────────────────────────────

function spawnWorker(source: string): { worker: Worker; url: string } {
  const blob = new Blob([source], { type: 'application/javascript' });
  const url  = URL.createObjectURL(blob);
  return { worker: new Worker(url), url };
}

function killWorker(
  ref:    React.MutableRefObject<Worker | null>,
  urlRef: React.MutableRefObject<string | null>,
) {
  ref.current?.terminate();
  ref.current = null;
  if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

interface UseMagicFillSessionProps {
  /**
   * Snaps a traced outline (mask pixels) onto the drawing's real lines/arcs.
   * Provided by the Viewer once the page's vector geometry is loaded.
   */
  snapOutline?:         ((poly: [number, number][], maskW: number, maskH: number) => [number, number][]) | null;
  /** Page size in PDF points (to turn mask pixels into real area). */
  pageSizePt?:          { w: number; h: number } | null;
  /** Identifies the page for saved rooms, e.g. `${drawingId}:${page}`. Null = don't save. */
  regionKey?:           string | null;
  /** Owner of saved rooms (so they're removed with the project / drawing). */
  regionOwner?:         { projectId: string; drawingId: string; page: number } | null;
  /**
   * Whether the Magic Fill tool is selected. The wall mask (an extra off-screen
   * page render + full pixel scan) is only built while it is — and only once
   * per page, since it's rendered at a fixed scale.
   */
  magicFillActive?:     boolean;
  fillCanvasRef:        React.RefObject<HTMLCanvasElement | null>;
  pdfRenderCount:       number;
  pdfCanvasRef:         React.RefObject<HTMLCanvasElement | null>;
  pdfDimensions:        PdfDimensions | null;
  scaleFactor:          number;
  isMagicFillActiveRef: React.RefObject<boolean>;
  activeDrawingId:      string | null;
  measurements:         TakeoffRow[];
  propAppendToGroupId:  string | undefined;
  onAddMeasurementProp?:    (m: any) => void;
  onUpdateMeasurementProp?: (id: string, updates: Partial<TakeoffRow>) => void;
  onDeleteMeasurementProp?: (id: string) => void;
  onAppendComplete?:        () => void;
  batchCommitMeasurements?: (rows: any[]) => void;
  svgLines?: NormalisedSvgLine[];
  // FIX: ref to the currently rendered PDF page (from useViewerPdf).
  // Used to render an off-screen high-res bitmap at MASK_SCALE so fill
  // quality never depends on the viewer's current zoom level.
  currentPdfPageRef: React.RefObject<PDFPageProxy | null>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helper (exported for use in MagicFillUI)
// ─────────────────────────────────────────────────────────────────────────────
export function fmtArea(px: number, mpp: number | null): string {
  if (!mpp) return `${px.toLocaleString()} px²`;
  const m2 = px * mpp * mpp;
  return m2 >= 1 ? `${m2.toFixed(2)} m²` : `${(m2 * 1e6).toFixed(0)} mm²`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

// ── Fill geometry helpers (mask-pixel space) ────────────────────────────────
function inRing(r: [number, number][], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if ((r[i][1] > y) !== (r[j][1] > y) && x < ((r[j][0] - r[i][0]) * (y - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
  }
  return c;
}
export function pointInFill(f: MagicFill, x: number, y: number): boolean {
  return f.polygon.length >= 3 && inRing(f.polygon, x, y) && !(f.holes ?? []).some(h => inRing(h, x, y));
}
const fillAreaPx = (f: { polygon: [number, number][]; holes?: [number, number][][] }) =>
  Math.max(0, ringArea(f.polygon) - (f.holes ?? []).reduce((t, h) => t + ringArea(h), 0));

/** Rooms worth filling in one go: not the page background, not specks, not things standing inside another room. */
export function roomsToFillAll(regions: StoredRegion[], w: number, h: number): StoredRegion[] {
  const page = w * h, edge = 3;
  const real = regions.filter(r =>
    r.polygon.length >= 3 && r.areaPx > page * 0.0004 && r.areaPx < page * 0.6 &&
    !(r.x0 <= edge || r.y0 <= edge || r.x1 >= w - 1 - edge || r.y1 >= h - 1 - edge));
  return real.filter(r => !real.some(o =>
    o !== r && o.areaPx > r.areaPx &&
    r.x0 >= o.x0 && r.y0 >= o.y0 && r.x1 <= o.x1 && r.y1 <= o.y1 &&
    r.polygon.slice(0, 12).every(([x, y]) => inRing(o.polygon, x, y))));
}


export function useMagicFillSession({
  snapOutline = null,
  pageSizePt = null,
  regionKey = null,
  regionOwner = null,
  fillCanvasRef,
  magicFillActive = true,
  pdfRenderCount,
  pdfCanvasRef,
  pdfDimensions,
  scaleFactor,
  isMagicFillActiveRef,
  activeDrawingId,
  measurements,
  propAppendToGroupId,
  onAddMeasurementProp,
  onUpdateMeasurementProp,
  onDeleteMeasurementProp,
  onAppendComplete,
  batchCommitMeasurements,
  svgLines,
  currentPdfPageRef,
}: UseMagicFillSessionProps) {

  // ── Fill state ────────────────────────────────────────────────────────────
  const [magicFills,      setMagicFills]      = useState<MagicFill[]>([]);
  const [mfHiddenIds,     setMfHiddenIds]     = useState<Set<number>>(new Set());
  const [mfSelectedId,    setMfSelectedId]    = useState<number | null>(null);
  const [mfSelectedGroup, setMfSelectedGroup] = useState<number | null>(null);
  const [mfHoveredId,     setMfHoveredId]     = useState<number | null>(null);
  const [mfHoverPos,      setMfHoverPos]      = useState({ x: 0, y: 0 });
  const [mfHolesClosed,   setMfHolesClosed]   = useState<Set<number>>(new Set());
  const [mfIsFilling,     setMfIsFilling]     = useState(false);
  const [mfFillMsg,       setMfFillMsg]       = useState('');
  const [mfFillSub,       setMfFillSub]       = useState<string | undefined>(undefined);
  const [mfFillProgress,  setMfFillProgress]  = useState<{ done: number; total: number } | null>(null);
  const [mfMetersPerPixel,setMfMetersPerPixel]= useState<number | null>(null);
  const [mfLastFillPos,   setMfLastFillPos]   = useState<{ x: number; y: number } | null>(null);
  const [showMfNameDialog,setShowMfNameDialog]= useState(false);
  const [pendingMfData,   setPendingMfData]   = useState<any>(null);

  // ── Mask bitmap dimensions (from the off-screen high-res render) ──────────
  const [maskDims, setMaskDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  // ── Color cycling ─────────────────────────────────────────────────────────
  const [activeColorIdx, setActiveColorIdx] = useState(0);
  const activeColor = FILL_COLORS[activeColorIdx];
  const cycleColor  = useCallback(() => setActiveColorIdx(i => (i + 1) % FILL_COLORS.length), []);

  // ── Internal refs ─────────────────────────────────────────────────────────
  const maskRef       = useRef<Uint8Array | null>(null);
  /** Page the current mask was built from (masks are zoom-independent). */
  const maskPageRef = useRef<unknown>(null);

  // ── Pre-computed rooms (saved per page) ──────────────────────────────────
  // A click inside a known room fills it straight from the saved outline —
  // no flood fill. Rooms are found once per page (after the wall mask exists),
  // saved locally, and loaded instantly next time.
  const regionsRef = useRef<{ key: string; w: number; h: number; regions: StoredRegion[] } | null>(null);
  const [regionsVersion, setRegionsVersion] = useState(0);
  const regionKeyRef = useRef(regionKey);
  regionKeyRef.current = regionKey;
  const regionsJobRef = useRef<string | null>(null);

  // Snap outlines onto the drawing's lines (kept raw too: geometry may load
  // after the rooms, and then they're snapped again).
  const snapRef = useRef(snapOutline);
  snapRef.current = snapOutline;
  const rawRegionsRef = useRef<{ key: string; w: number; h: number; regions: StoredRegion[] } | null>(null);
  const snapRegions = useCallback((regions: StoredRegion[], w: number, h: number) => {
    const snap = snapRef.current;
    if (!snap) return regions;
    return regions.map(r => ({ ...r, polygon: snap(r.polygon, w, h) }));
  }, []);
  const setRegions = useCallback((key: string, w: number, h: number, regions: StoredRegion[]) => {
    rawRegionsRef.current = { key, w, h, regions };
    regionsRef.current = { key, w, h, regions: snapRegions(regions, w, h) };
    setRegionsVersion(v => v + 1);
  }, [snapRegions]);
  // Metres per MASK pixel (the fill list shows areas with this). The page
  // scale is metres per PDF point; the mask is rendered larger than the page.
  useEffect(() => {
    const mw = maskDims.w || rawRegionsRef.current?.w || 0;
    setMfMetersPerPixel(scaleFactor > 0 && pageSizePt && mw ? scaleFactor * (pageSizePt.w / mw) : null);
  }, [scaleFactor, pageSizePt, maskDims.w, regionsVersion]);

  // Geometry arrived (or changed) → re-snap the current rooms.
  useEffect(() => {
    const raw = rawRegionsRef.current;
    if (!raw || !snapOutline) return;
    regionsRef.current = { ...raw, regions: snapRegions(raw.regions, raw.w, raw.h) };
    setRegionsVersion(v => v + 1);
  }, [snapOutline, snapRegions]);

  // Load saved rooms when the page changes.
  useEffect(() => {
    if (!regionKey) return;
    if (regionsRef.current?.key === regionKey) return;
    let alive = true;
    getPageRegions(regionKey).then(rec => {
      if (!alive || !rec || rec.version !== ROOMS_VERSION) return;
      setRegions(rec.key, rec.maskW, rec.maskH, rec.regions);
    }).catch(() => {});
    return () => { alive = false; };
  }, [regionKey, setRegions]);

  /** Find rooms from a finished wall mask (background worker), then save them. */
  const computeRegions = useCallback((mask: Uint8Array, w: number, h: number) => {
    const key = regionKeyRef.current;
    if (!key || regionsRef.current?.key === key || regionsJobRef.current === key) return;
    regionsJobRef.current = key;
    const { worker, url } = spawnWorker(ROOMS_WORKER_SOURCE);
    const done = () => { worker.terminate(); URL.revokeObjectURL(url); if (regionsJobRef.current === key) regionsJobRef.current = null; };
    worker.onmessage = ({ data }: MessageEvent<{ regions: StoredRegion[] }>) => {
      done();
      if (regionKeyRef.current !== key) return;
      setRegions(key, w, h, data.regions);
      const owner = regionOwnerRef.current;
      if (owner) {
        putPageRegions({
          key, projectId: owner.projectId, drawingId: owner.drawingId, page: owner.page,
          version: ROOMS_VERSION, maskW: w, maskH: h, regions: data.regions, createdAt: Date.now(),
        }).catch(err => console.warn('[MagicFill] could not save rooms', err));
      }
    };
    worker.onerror = (e) => { console.warn('[MagicFill] room finder failed', e); done(); };
    const copy = mask.slice().buffer;
    // Skip specks: at least 0.005% of the page (≈600 px on a 12 MP mask).
    worker.postMessage({ maskBuffer: copy, w, h, minArea: Math.max(200, Math.round(w * h * 0.00005)) }, [copy]);
  }, [setRegions]);
  const regionOwnerRef = useRef(regionOwner);
  regionOwnerRef.current = regionOwner;
  const maskWRef      = useRef(0);
  const maskHRef      = useRef(0);
  const fillDataRef   = useRef<ImageData | null>(null);
  const fillCountRef  = useRef(0);
  const groupCountRef = useRef(0);
  const fillPixelMaps = useRef<Map<number, Uint8Array>>(new Map());
  const snapshots     = useRef<ImageData[]>([]);
  const magicFillsRef = useRef<MagicFill[]>([]);
  const mfOpacity     = 40;

  // Generation counter — bumped every time the mask/fillData are rebuilt.
  const maskGenerationRef = useRef(0);
  const fillSessionKeyRef = useRef<string | null>(null);

  const workerRef    = useRef<Worker | null>(null);
  const workerUrlRef = useRef<string | null>(null);

  useEffect(() => { magicFillsRef.current = magicFills; }, [magicFills]);
  useEffect(() => () => killWorker(workerRef as any, workerUrlRef as any), []);

  // ── Scale normalised svgLines to mask-pixel coords ────────────────────────
  const scaledSvgLinesRef = useRef<Array<{ x1: number; y1: number; x2: number; y2: number }> | null>(null);

  useEffect(() => {
    const mw = maskDims.w;
    const mh = maskDims.h;
    if (!svgLines || svgLines.length === 0 || !mw || !mh) {
      scaledSvgLinesRef.current = null;
      return;
    }
    scaledSvgLinesRef.current = svgLines.map(l => ({
      x1: l.x1 * mw,
      y1: l.y1 * mh,
      x2: l.x2 * mw,
      y2: l.y2 * mh,
    }));
  }, [svgLines, maskDims]);

  // ── Build wall mask when PDF renders ─────────────────────────────────────
  //
  //  FIX: zoom-agnostic mask
  //
  //  We render the current PDF page into a dedicated off-screen canvas at
  //  MASK_SCALE (a fixed 3×). This means thin wall lines that would collapse
  //  at low viewer zoom are always rendered at 3× and remain solid barriers
  //  for the flood-fill. The viewer's committedScale has no effect here.
  //
  //  The fill canvas (fillCanvasRef) continues to paint at CSS dimensions
  //  (pdfDimensions) as before — only the mask bitmap uses the larger size.
  //
  //  maskW / maskH (from maskDims) flow through to MagicFillCanvas for
  //  polyRef bitmap sizing, and are used in handleMagicSingleClick /
  //  handleMagicPolygonFill for the CSS→mask coordinate conversion, so
  //  clicks remain accurate at every zoom level.
  //
  /** Redraw the zoom-sized pixel layer from the fills' outlines. */
  const repaintFillLayer = useCallback((list: MagicFill[]) => {
    const fc = fillCanvasRef.current;
    const ctx = fc?.getContext('2d');
    if (!fc || !ctx || !fc.width || !fc.height) return;
    const mw = maskWRef.current || rawRegionsRef.current?.w || 0;
    const mh = maskHRef.current || rawRegionsRef.current?.h || 0;
    ctx.clearRect(0, 0, fc.width, fc.height);
    if (mw && mh) {
      for (const f of list) {
        if (f.polygon.length < 3) continue;
        const [r, g, b] = hexToRgb(f.color);
        ctx.fillStyle = `rgba(${r},${g},${b},${(f.opacity ?? 35) / 100})`;
        ctx.beginPath();
        f.polygon.forEach(([x, y], k) => {
          const px = x * (fc.width / mw), py = y * (fc.height / mh);
          if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        });
        ctx.closePath();
        ctx.fill();
      }
    }
    fillDataRef.current = ctx.getImageData(0, 0, fc.width, fc.height);
  }, [fillCanvasRef]);
  // Fills taken back with Undo, newest last — Redo puts them back.
  // Undo history: the list of fills before each change (a lasso that makes
  // several fills at once is one step).
  const pastRef = useRef<MagicFill[][]>([]);
  const redoRef = useRef<MagicFill[][]>([]);
  const rememberLock = useRef(false);
  const [mfRedoCount, setMfRedoCount] = useState(0);
  const [mfUndoCount, setMfUndoCount] = useState(0);
  const remember = useCallback(() => {
    if (rememberLock.current) return;
    rememberLock.current = true;
    setTimeout(() => { rememberLock.current = false; }, 0);
    pastRef.current = [...pastRef.current.slice(-49), magicFillsRef.current];
    redoRef.current = [];
    setMfUndoCount(pastRef.current.length); setMfRedoCount(0);
  }, []);
  const forgetHistory = useCallback(() => {
    pastRef.current = []; redoRef.current = [];
    setMfUndoCount(0); setMfRedoCount(0);
  }, []);

  useEffect(() => {
    if (pdfRenderCount === 0) return;
    const fc = fillCanvasRef.current;
    if (!fc) return;

    const cssW = pdfDimensions?.w ?? 0;
    const cssH = pdfDimensions?.h ?? 0;
    if (!cssW || !cssH) return;

    // Reset fill canvas to current CSS dimensions.
    if (fc.width  !== cssW) fc.width  = cssW;
    if (fc.height !== cssH) fc.height = cssH;
    fc.style.width  = `${cssW}px`;
    fc.style.height = `${cssH}px`;

    killWorker(workerRef as any, workerUrlRef as any);
    maskGenerationRef.current += 1;
    const myGeneration = maskGenerationRef.current;

    setMfIsFilling(false);
    setMfFillMsg(''); setMfFillSub(undefined); setMfFillProgress(null);

    // Same page, tool still on → this is only a zoom / re-render. The fills
    // not yet finished live in mask space (which doesn't change with zoom),
    // so they are kept; only the zoom-sized pixel layer is rebuilt.
    const sessionKey = magicFillActive && regionKeyRef.current ? regionKeyRef.current : null;
    const keepFills = sessionKey !== null && sessionKey === fillSessionKeyRef.current;
    fillSessionKeyRef.current = sessionKey;
    snapshots.current = [];
    setMfHoveredId(null);

    if (keepFills) {
      repaintFillLayer(magicFillsRef.current);
    } else {
      fillDataRef.current = new ImageData(cssW, cssH);
      fillCountRef.current  = 0;
      groupCountRef.current = 0;
      forgetHistory();
      fillPixelMaps.current.clear();
      setMagicFills([]);
      setMfHiddenIds(new Set());
      setMfSelectedId(null);
      setMfSelectedGroup(null);
      setMfHolesClosed(new Set());
      setMfLastFillPos(null);
    }


    // ── Helper: fall back to the visible canvas bitmap ────────────────────
    //    Used when the page ref isn't available yet, or if the off-screen
    //    render fails.
    const fallbackToVisibleCanvas = () => {
      const bc = pdfCanvasRef.current;
      if (!bc || !bc.width || !bc.height) return;
      if (myGeneration !== maskGenerationRef.current) return;
      const ctx = bc.getContext('2d');
      if (!ctx) return;
      const id   = ctx.getImageData(0, 0, bc.width, bc.height);
      const mask = buildNormalisedWallMask(id.data, bc.width, bc.height);
      maskRef.current  = mask;
      maskPageRef.current = null;   // zoom-dependent fallback: rebuild next time
      maskWRef.current = bc.width;
      maskHRef.current = bc.height;
      setMaskDims({ w: bc.width, h: bc.height });
    };

    // Lazy + cached: build only when the tool is in use, and skip when the
    // mask for this exact page already exists (zoom doesn't change it).
    if (!magicFillActive) return;
    if (maskRef.current && maskPageRef.current && maskPageRef.current === currentPdfPageRef.current) return;

    // Seen this page before (e.g. switching plans back and forth)? Reuse it.
    const cachedPage = currentPdfPageRef.current;
    const cached = cachedPage ? maskCache.get(cachedPage) : undefined;
    if (cached) {
      maskRef.current = cached.mask;
      maskPageRef.current = cachedPage;
      maskWRef.current = cached.w;
      maskHRef.current = cached.h;
      setMaskDims({ w: cached.w, h: cached.h });
      computeRegions(cached.mask, cached.w, cached.h);
      return;
    }

    const buildMask = () => {
      const page = currentPdfPageRef.current;
      if (!page) {
        // Page ref not yet populated — fall back (zoom-dependent, but rare).
        fallbackToVisibleCanvas();
        return;
      }

      // ── Render the page at MASK_SCALE into a throwaway off-screen canvas ──
      const base  = page.getViewport({ scale: 1 });
      const scale = Math.min(MASK_SCALE, Math.sqrt(MAX_MASK_PIXELS / Math.max(1, base.width * base.height)));
      const viewport = page.getViewport({ scale });
      const offW = Math.round(viewport.width);
      const offH = Math.round(viewport.height);

      const offCanvas = document.createElement('canvas');
      offCanvas.width  = offW;
      offCanvas.height = offH;
      const offCtx = offCanvas.getContext('2d');
      if (!offCtx) { fallbackToVisibleCanvas(); return; }

      page.render({ canvas: offCanvas, canvasContext: offCtx, viewport })
        .promise
        .then(() => {
          if (myGeneration !== maskGenerationRef.current) return undefined;
          const id = offCtx.getImageData(0, 0, offW, offH);
          offCanvas.width = 0; offCanvas.height = 0;            // free the render's memory now
          // Pixel scan + closing run in a worker; the pixel buffer is handed over.
          // (Tiny pages need up-sampling, which uses a canvas — those are cheap
          // and stay on the main thread.)
          const build = Math.max(offW, offH) < REFERENCE_LONG_EDGE
            ? Promise.resolve(buildNormalisedWallMask(id.data, offW, offH))
            : buildWallMaskInWorker(id.data, offW, offH);
          return build.then(mask => {
            maskCache.set(page, { mask, w: offW, h: offH });
            if (myGeneration !== maskGenerationRef.current) return;
            maskRef.current  = mask;
            maskPageRef.current = page;
            maskWRef.current = offW;
            maskHRef.current = offH;
            setMaskDims({ w: offW, h: offH });
            computeRegions(mask, offW, offH);
          });
        })
        .catch((err: any) => {
          if (err?.name === 'RenderingCancelledException') return;
          console.error('[useMagicFillSession] off-screen mask render failed — falling back', err);
          fallbackToVisibleCanvas();
        });
    };

    // Saved rooms for this page? Then the mask is only needed for borderline
    // clicks and lasso fills — build it when the browser is idle instead of
    // now, so opening the plan stays instant.
    const key = regionKeyRef.current;
    if (!key) { buildMask(); return; }
    getPageRegions(key).then(rec => {
      if (myGeneration !== maskGenerationRef.current) return;
      if (rec && rec.version === ROOMS_VERSION) {
        if (regionsRef.current?.key !== key) setRegions(rec.key, rec.maskW, rec.maskH, rec.regions);
        const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
        if (ric) ric(() => { if (myGeneration === maskGenerationRef.current) buildMask(); }, { timeout: 4000 });
        else setTimeout(() => { if (myGeneration === maskGenerationRef.current) buildMask(); }, 1500);
      } else {
        buildMask();
      }
    }).catch(() => buildMask());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfRenderCount, magicFillActive]);

  // ── Single-click raster fill ──────────────────────────────────────────────
  /** Fill a pre-computed room directly (no flood fill). */
  const fillFromRegion = useCallback((region: StoredRegion, mw: number, mh: number, canvasX: number, canvasY: number) => {
    // Already filled → just select it (a second fill would count the room twice).
    const dup = magicFillsRef.current.find(f => f.polygon === region.polygon);
    if (dup) { setMfSelectedId(dup.id); setMfSelectedGroup(null); setMfLastFillPos({ x: canvasX, y: canvasY }); return; }
    // No ground is filled twice: a room already inside a bigger fill is not
    // added again, and a new fill that covers earlier ones replaces them.
    const N = (r: [number, number][]) => r.map(([x, y]) => ({ x: x / mw, y: y / mh }));
    const fresh = { outer: N(region.polygon), holes: [] as { x: number; y: number }[][] };
    const freshArea = shapeArea(fresh) || 1e-12;
    const covered: number[] = [];
    for (const f of magicFillsRef.current) {
      if (f.polygon.length < 3) continue;
      const old = { outer: N(f.polygon), holes: (f.holes ?? []).map(N) };
      const shared = intersectShapes([fresh, old]).reduce((t, sh) => t + shapeArea(sh), 0);
      if (shared / freshArea > 0.85) { setMfSelectedId(f.id); setMfSelectedGroup(null); setMfLastFillPos({ x: canvasX, y: canvasY }); return; }
      if (shared / (shapeArea(old) || 1e-12) > 0.85) covered.push(f.id);
    }
    const fc = fillCanvasRef.current;
    if (!fc || !fillDataRef.current) return;
    const cssW = pdfDimensions?.w ?? fc.width, cssH = pdfDimensions?.h ?? fc.height;
    snapshots.current.push(new ImageData(new Uint8ClampedArray(fillDataRef.current.data), fc.width, fc.height));

    // Paint on the fill canvas (CSS space).
    const [r, g, b] = hexToRgb(activeColor);
    const fillCtx = fc.getContext('2d')!;
    fillCtx.save();
    fillCtx.fillStyle = `rgba(${r},${g},${b},${mfOpacity / 100})`;
    fillCtx.beginPath();
    region.polygon.forEach(([x, y], i) => {
      const px = x * (cssW / mw), py = y * (cssH / mh);
      if (i === 0) fillCtx.moveTo(px, py); else fillCtx.lineTo(px, py);
    });
    fillCtx.closePath();
    fillCtx.fill();
    fillCtx.restore();
    fillDataRef.current = fillCtx.getImageData(0, 0, cssW, cssH);

    fillCountRef.current += 1;
    const id = Date.now() + fillCountRef.current;
    const fill: MagicFill = {
      id, label: `Fill ${fillCountRef.current}`, color: activeColor, opacity: mfOpacity,
      areaPx: region.areaPx, perimPx: region.perimPx, polygon: region.polygon, svgMode: false,
    };
    remember();
    setMagicFills(prev => [...prev.filter(f => !covered.includes(f.id)), fill]);
    setMfSelectedId(id);
    setMfSelectedGroup(null);
    setMfLastFillPos({ x: canvasX, y: canvasY });
    cycleColor();
  }, [fillCanvasRef, pdfDimensions, activeColor, mfOpacity, cycleColor]);

  /** The saved room a click lands in — only when every seed agrees (else null). */
  const regionAt = useCallback((canvasX: number, canvasY: number) => {
    const rs = regionsRef.current;
    if (!rs || rs.key !== regionKeyRef.current) return null;
    const cssW = pdfDimensions?.w ?? rs.w, cssH = pdfDimensions?.h ?? rs.h;
    const mx = Math.round(canvasX * (rs.w / cssW)), my = Math.round(canvasY * (rs.h / cssH));
    const inside = (reg: StoredRegion, x: number, y: number) => {
      if (x < reg.x0 || x > reg.x1 || y < reg.y0 || y > reg.y1) return false;
      let c = false;
      const p = reg.polygon;
      for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
        if ((p[i][1] > y) !== (p[j][1] > y) && x < ((p[j][0] - p[i][0]) * (y - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) c = !c;
      }
      return c;
    };
    const find = (x: number, y: number) => {
      let best: StoredRegion | null = null;
      for (const reg of rs.regions) if (inside(reg, x, y) && (!best || reg.areaPx < best.areaPx)) best = reg;
      return best;
    };
    // The room under the cursor — the same one the hover preview outlines — so
    // a click fills exactly what was previewed. (Only a click that lands on a
    // line, in no room at all, tries the neighbouring pixels.)
    let hit = find(mx, my);
    if (!hit) {
      for (const [dx, dy] of SEED_OFFSETS) { hit = find(mx + dx, my + dy); if (hit) break; }
    }
    if (!hit) return null;
    return { region: hit, w: rs.w, h: rs.h };
  }, [pdfDimensions]);

  const handleMagicSingleClick = useCallback((canvasX: number, canvasY: number) => {
    if (mfIsFilling) return;
    const fast = regionAt(canvasX, canvasY);
    if (fast && fillDataRef.current) { fillFromRegion(fast.region, fast.w, fast.h, canvasX, canvasY); return; }
    if (!maskRef.current || !fillDataRef.current) return;
    const fc = fillCanvasRef.current;
    if (!fc) return;

    const mw = maskWRef.current, mh = maskHRef.current;
    if (!mw || !mh) return;

    const myGeneration = maskGenerationRef.current;

    // CSS-space click → mask-pixel space.
    // maskW/maskH come from the MASK_SCALE off-screen render so this ratio
    // is MASK_SCALE / (devicePixelRatio used for the visible canvas), making
    // clicks accurate at every viewer zoom level.
    const cssW = pdfDimensions?.w ?? mw;
    const cssH = pdfDimensions?.h ?? mh;
    const maskX = Math.round(canvasX * (mw / cssW));
    const maskY = Math.round(canvasY * (mh / cssH));

    setMfIsFilling(true);
    setMfFillMsg('Flood filling region');
    setMfFillSub('Running off main thread…');

    snapshots.current.push(
      new ImageData(new Uint8ClampedArray(fillDataRef.current.data), fc.width, fc.height),
    );

    killWorker(workerRef as any, workerUrlRef as any);
    const { worker, url } = spawnWorker(RASTER_WORKER_SOURCE);
    workerRef.current    = worker;
    workerUrlRef.current = url;

    const [r, g, b]    = hexToRgb(activeColor);
    const maskCopy     = maskRef.current.slice().buffer;
    const fillDataCopy = fillDataRef.current.data.slice().buffer;

    worker.postMessage(
      {
        maskBuffer:     maskCopy,
        fillDataBuffer: fillDataCopy,
        w: mw, h: mh,
        cx: maskX, cy: maskY,
        r, g, b,
        opacity: mfOpacity / 100,
        svgLines: scaledSvgLinesRef.current ?? [],
      },
      [maskCopy, fillDataCopy],
    );

    worker.onmessage = ({ data: result }) => {
      killWorker(workerRef as any, workerUrlRef as any);

      if (myGeneration !== maskGenerationRef.current) return;

      if (result.empty) {
        snapshots.current.pop();
        setMfIsFilling(false); setMfFillMsg(''); setMfFillSub(undefined);
        return;
      }

      const { fillDataBuffer, closedBuffer, areaPx, perimPx, polygon, svgPath } = result;

      // The worker operated in mask-pixel space (mw × mh). The fill raster
      // it returns is also mw × mh — but fillCanvasRef is cssW × cssH.
      // We need to scale the painted pixels down to CSS space before
      // putting them on the fill canvas.
      const paintedMask = new Uint8Array(closedBuffer);

      // Scale mask pixels → CSS-space ImageData via an intermediate canvas.
      const tmpCanvas = document.createElement('canvas');
      tmpCanvas.width  = mw;
      tmpCanvas.height = mh;
      const tmpCtx = tmpCanvas.getContext('2d')!;
      const tmpImgData = new ImageData(mw, mh);
      const [pr, pg, pb] = [r, g, b];
      const pa = Math.round((mfOpacity / 100) * 255);
      for (let i = 0; i < paintedMask.length; i++) {
        if (!paintedMask[i]) continue;
        tmpImgData.data[i * 4]     = pr;
        tmpImgData.data[i * 4 + 1] = pg;
        tmpImgData.data[i * 4 + 2] = pb;
        tmpImgData.data[i * 4 + 3] = pa;
      }
      tmpCtx.putImageData(tmpImgData, 0, 0);

      // Composite scaled version onto the fill canvas.
      const fillCtx = fc.getContext('2d')!;
      fillCtx.drawImage(tmpCanvas, 0, 0, cssW, cssH);

      // Keep fillDataRef in sync.
      fillDataRef.current = fillCtx.getImageData(0, 0, cssW, cssH);

      fillCountRef.current += 1;
      const id = Date.now() + fillCountRef.current;
      fillPixelMaps.current.set(id, paintedMask);

      const fill: MagicFill = {
        id,
        label:   `Fill ${fillCountRef.current}`,
        color:   activeColor,
        opacity: mfOpacity,
        areaPx,
        perimPx,
        // Snapped onto the drawing's lines when geometry is available.
        polygon: (snapRef.current ? snapRef.current(polygon as [number, number][], mw, mh) : polygon) as [number, number][],
        svgPath,
        svgMode: !snapRef.current,
      };

      remember();
      setMagicFills(prev => [...prev, fill]);
      setMfSelectedId(id);
      setMfSelectedGroup(null);
      setMfLastFillPos({ x: canvasX, y: canvasY });
      setMfIsFilling(false); setMfFillMsg(''); setMfFillSub(undefined);
      cycleColor();
    };

    worker.onerror = (e) => {
      console.error('[MagicFill] raster worker error', e);
      killWorker(workerRef as any, workerUrlRef as any);
      if (myGeneration === maskGenerationRef.current) {
        snapshots.current.pop();
        setMfIsFilling(false); setMfFillMsg(''); setMfFillSub(undefined);
      }
    };
  }, [mfIsFilling, fillCanvasRef, activeColor, cycleColor, pdfDimensions, regionAt, fillFromRegion]);

  // ── Polygon lasso fill ────────────────────────────────────────────────────
  const handleMagicPolygonFill = useCallback((poly: [number, number][]) => {
    // Outline-based fill: every room the lasso touches is filled along its own
    // saved outline — the very shapes the preview showed while lassoing — one
    // fill per room. (The pixel-based fill below merged the rooms into a single
    // blob, grew it across the walls and re-traced it, which is where the rough
    // borders and missed corners came from. It remains only as the fallback for
    // pages whose rooms haven't been worked out yet.)
    const rs = regionsRef.current;
    if (!mfIsFilling && rs && rs.key === regionKeyRef.current && fillDataRef.current && poly.length >= 3) {
      const cssW0 = pdfDimensions?.w ?? rs.w, cssH0 = pdfDimensions?.h ?? rs.h;
      const lasso = poly.map(([x, y]): [number, number] => [x * (rs.w / cssW0), y * (rs.h / cssH0)]);
      const { tops } = fillPreview(rs.regions, lasso, null, rs.w * rs.h);
      if (tops.length > 0) {
        // Pieces separated only by a thin line (an arc across the floor, a
        // pattern line) are one space: join them into a single outline, so
        // there is no line drawn through the fill and it is one area. Real
        // walls are wider than the bridge and keep rooms apart.
        // Joining nudges points off the drawing's lines (it grows and shrinks
        // the outlines), so the joined outline is put back onto the PDF's own
        // lines and corners, the same way single rooms are.
        const snap = snapRef.current;
        const merged = mergeRings(tops.map(t => t.polygon as [number, number][]), LINE_BRIDGE_PX)
          .map(ring => (snap ? snap(ring, rs.w, rs.h) : ring))
          .filter(ring => ring.length >= 3);
        const shapes: StoredRegion[] = merged.length > 0
          ? merged.map(ring => {
              const xs = ring.map(q => q[0]), ys = ring.map(q => q[1]);
              return {
                x0: Math.floor(Math.min(...xs)), y0: Math.floor(Math.min(...ys)),
                x1: Math.ceil(Math.max(...xs)),  y1: Math.ceil(Math.max(...ys)),
                areaPx: ringArea(ring), perimPx: ringPerimeter(ring), polygon: ring,
              } as StoredRegion;
            })
          : tops;
        for (const room of shapes) {
          const cx = ((room.x0 + room.x1) / 2) * (cssW0 / rs.w);
          const cy = ((room.y0 + room.y1) / 2) * (cssH0 / rs.h);
          fillFromRegion(room, rs.w, rs.h, cx, cy);
        }
        return;
      }
    }
    if (poly.length < 3 || !maskRef.current || !fillDataRef.current || mfIsFilling) return;
    const fc = fillCanvasRef.current;
    if (!fc) return;

    const mw = maskWRef.current, mh = maskHRef.current;
    if (!mw || !mh) return;

    const myGeneration = maskGenerationRef.current;

    const cssW = pdfDimensions?.w ?? mw;
    const cssH = pdfDimensions?.h ?? mh;
    const scaleX = mw / cssW;
    const scaleY = mh / cssH;

    // Convert lasso polygon from CSS-space → mask-pixel space.
    const maskPoly = poly.map(([x, y]): [number, number] => [
      Math.round(x * scaleX),
      Math.round(y * scaleY),
    ]);

    setMfIsFilling(true);
    setMfFillMsg('Detecting regions in polygon');
    setMfFillSub('Running off main thread…');
    setMfFillProgress(null);

    snapshots.current.push(
      new ImageData(new Uint8ClampedArray(fillDataRef.current.data), fc.width, fc.height),
    );

    killWorker(workerRef as any, workerUrlRef as any);
    const { worker, url } = spawnWorker(POLYGON_WORKER_SOURCE);
    workerRef.current    = worker;
    workerUrlRef.current = url;

    const [r, g, b]    = hexToRgb(activeColor);
    const maskCopy     = maskRef.current.slice().buffer;
    const fillDataCopy = fillDataRef.current.data.slice().buffer;

    worker.postMessage(
      {
        maskBuffer:     maskCopy,
        fillDataBuffer: fillDataCopy,
        w: mw, h: mh,
        r, g, b,
        opacity: mfOpacity / 100,
        poly: maskPoly,
        svgLines: scaledSvgLinesRef.current ?? [],
      },
      [maskCopy, fillDataCopy],
    );

    worker.onmessage = ({ data: result }) => {
      killWorker(workerRef as any, workerUrlRef as any);

      if (myGeneration !== maskGenerationRef.current) return;

      if (result.empty || result.error === 'leak') {
        snapshots.current.pop();
        setMfIsFilling(false);
        setMfFillMsg(''); setMfFillSub(undefined); setMfFillProgress(null);
        return;
      }

      const { fillDataBuffer, closedBuffer, polygon, areaPx, perimPx, svgPath, regionCount } = result;
      const paintedMask = new Uint8Array(closedBuffer);

      // Scale mask-space paint → CSS-space fill canvas (same as single-click).
      const tmpCanvas = document.createElement('canvas');
      tmpCanvas.width  = mw;
      tmpCanvas.height = mh;
      const tmpCtx = tmpCanvas.getContext('2d')!;
      const tmpImgData = new ImageData(mw, mh);
      const pa = Math.round((mfOpacity / 100) * 255);
      for (let i = 0; i < paintedMask.length; i++) {
        if (!paintedMask[i]) continue;
        tmpImgData.data[i * 4]     = r;
        tmpImgData.data[i * 4 + 1] = g;
        tmpImgData.data[i * 4 + 2] = b;
        tmpImgData.data[i * 4 + 3] = pa;
      }
      tmpCtx.putImageData(tmpImgData, 0, 0);

      const fillCtx = fc.getContext('2d')!;
      fillCtx.drawImage(tmpCanvas, 0, 0, cssW, cssH);
      fillDataRef.current = fillCtx.getImageData(0, 0, cssW, cssH);

      groupCountRef.current += 1;
      const gId = groupCountRef.current;
      fillCountRef.current  += 1;
      const id = Date.now() + fillCountRef.current;

      fillPixelMaps.current.set(id, paintedMask);

      const fill: MagicFill = {
        id,
        label:   `Fill ${fillCountRef.current}`,
        color:   activeColor,
        opacity: mfOpacity,
        areaPx,
        perimPx,
        polygon: polygon as [number, number][],
        svgPath,
        groupId: gId,
        svgMode: true,
      };

      remember();
      setMagicFills(prev => [...prev, fill]);
      setMfSelectedId(null);
      setMfSelectedGroup(gId);
      setMfLastFillPos({ x: poly[0][0], y: poly[0][1] });
      setMfIsFilling(false);
      setMfFillMsg(''); setMfFillSub(undefined); setMfFillProgress(null);
      cycleColor();
    };

    worker.onerror = (e) => {
      console.error('[MagicFill] polygon worker error', e);
      killWorker(workerRef as any, workerUrlRef as any);
      if (myGeneration === maskGenerationRef.current) {
        snapshots.current.pop();
        setMfIsFilling(false);
        setMfFillMsg(''); setMfFillSub(undefined); setMfFillProgress(null);
      }
    };
  }, [mfIsFilling, fillCanvasRef, activeColor, cycleColor, pdfDimensions, fillFromRegion]);

  // ── Batch rect fill (delegates to polygon lasso) ──────────────────────────
  const handleMagicBatchRect = useCallback((
    x1: number, y1: number, x2: number, y2: number,
  ) => {
    const poly: [number, number][] = [
      [Math.min(x1, x2), Math.min(y1, y2)],
      [Math.max(x1, x2), Math.min(y1, y2)],
      [Math.max(x1, x2), Math.max(y1, y2)],
      [Math.min(x1, x2), Math.max(y1, y2)],
    ];
    handleMagicPolygonFill(poly);
  }, [handleMagicPolygonFill]);

  // ── Take a room back out (Alt-click) ──────────────────────────────────────
  // On a fill that is exactly that room → the fill is removed. Inside a
  // bigger (joined) fill → that room is cut out of it.
  const handleMagicSubtractClick = useCallback((canvasX: number, canvasY: number) => {
    if (mfIsFilling) return;
    const hit = regionAt(canvasX, canvasY);
    const rs = regionsRef.current;
    const mw = hit?.w ?? rs?.w ?? maskWRef.current, mh = hit?.h ?? rs?.h ?? maskHRef.current;
    const cssW = pdfDimensions?.w ?? mw, cssH = pdfDimensions?.h ?? mh;
    const mx = canvasX * (mw / cssW), my = canvasY * (mh / cssH);
    const fills = magicFillsRef.current;
    const target = [...fills].reverse().find(f => pointInFill(f, mx, my));
    if (!target) return;

    let next: MagicFill[];
    if (!hit || target.polygon === hit.region.polygon) {
      next = fills.filter(f => f.id !== target.id);
    } else {
      const N = (r: [number, number][]) => r.map(([x, y]) => ({ x: x / mw, y: y / mh }));
      const D = (r: { x: number; y: number }[]) => r.map(p => [p.x * mw, p.y * mh] as [number, number]);
      const pieces = subtractShapes(
        { outer: N(target.polygon), holes: (target.holes ?? []).map(N) },
        [{ outer: N(hit.region.polygon), holes: [] }],
      );
      const made: MagicFill[] = pieces.map((s, i) => {
        const polygon = D(s.outer), holes = s.holes.map(D);
        fillCountRef.current += i === 0 ? 0 : 1;
        return {
          ...target,
          id: i === 0 ? target.id : Date.now() + fillCountRef.current + i,
          label: i === 0 ? target.label : `Fill ${fillCountRef.current}`,
          polygon, holes: holes.length ? holes : undefined, svgMode: false, svgPath: undefined,
          areaPx: fillAreaPx({ polygon, holes }),
          perimPx: ringPerimeter(polygon) + holes.reduce((t, h) => t + ringPerimeter(h), 0),
        };
      });
      next = fills.flatMap(f => (f.id === target.id ? made : [f]));
    }
    remember();
    fillPixelMaps.current.delete(target.id);
    snapshots.current = [];
    magicFillsRef.current = next;
    repaintFillLayer(next);
    setMagicFills(next);
    setMfSelectedId(null); setMfHoveredId(null);
    setMfLastFillPos({ x: canvasX, y: canvasY });
  }, [mfIsFilling, regionAt, pdfDimensions, remember, repaintFillLayer]);

  // ── Fill every room on the page ───────────────────────────────────────────
  const mfRoomCount = useMemo(() => {
    const rs = regionsRef.current;
    return rs && rs.key === regionKey ? roomsToFillAll(rs.regions, rs.w, rs.h).length : 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionsVersion, regionKey]);
  const handleMagicFillAll = useCallback(() => {
    const rs = regionsRef.current;
    if (mfIsFilling || !rs || rs.key !== regionKeyRef.current) return;
    const have = new Set(magicFillsRef.current.map(f => f.polygon));
    const rooms = roomsToFillAll(rs.regions, rs.w, rs.h).filter(r => !have.has(r.polygon));
    if (!rooms.length) return;
    remember();
    const added: MagicFill[] = rooms.map(r => {
      fillCountRef.current += 1;
      return {
        id: Date.now() + fillCountRef.current, label: `Fill ${fillCountRef.current}`,
        color: activeColor, opacity: mfOpacity,
        areaPx: r.areaPx, perimPx: r.perimPx, polygon: r.polygon, svgMode: false,
      };
    });
    const next = [...magicFillsRef.current, ...added];
    snapshots.current = [];
    magicFillsRef.current = next;
    repaintFillLayer(next);
    setMagicFills(next);
    setMfSelectedId(null); setMfSelectedGroup(null);
    // Put the Finish button on the biggest room.
    const big = rooms.reduce((a, b) => (b.areaPx > a.areaPx ? b : a));
    const cssW = pdfDimensions?.w ?? rs.w, cssH = pdfDimensions?.h ?? rs.h;
    setMfLastFillPos({ x: ((big.x0 + big.x1) / 2) * (cssW / rs.w), y: ((big.y0 + big.y1) / 2) * (cssH / rs.h) });
  }, [mfIsFilling, remember, repaintFillLayer, activeColor, pdfDimensions]);

  // ── Room names printed on the drawing ─────────────────────────────────────
  // Read once per page (normalised 0–1 positions), used to name fills.
  const pageTextRef = useRef<{ page: unknown; items: TextItem[] } | null>(null);
  useEffect(() => {
    if (!magicFillActive || pdfRenderCount === 0) return;
    const page = currentPdfPageRef.current as any;
    if (!page || pageTextRef.current?.page === page) return;
    let cancelled = false;
    (async () => {
      try {
        const vp = page.getViewport({ scale: 1 });
        const tc = await page.getTextContent();
        if (cancelled) return;
        const items: TextItem[] = [];
        for (const it of tc.items as any[]) {
          const str = typeof it.str === 'string' ? it.str.trim() : '';
          if (!str || !Array.isArray(it.transform)) continue;
          const [a, b, , , e, f] = it.transform as number[];
          const size = Math.hypot(a, b) || it.height || 1;
          const ang = Math.atan2(b, a), wd = it.width || 0;
          const [vx, vy] = vp.convertToViewportPoint(e + Math.cos(ang) * wd / 2, f + Math.sin(ang) * wd / 2 + size * 0.3);
          items.push({ text: str, x: vx / vp.width, y: vy / vp.height, size: size / vp.height });
        }
        pageTextRef.current = { page, items };
      } catch { pageTextRef.current = { page, items: [] }; }
    })();
    return () => { cancelled = true; };
  }, [magicFillActive, pdfRenderCount, currentPdfPageRef]);

  const roomLabelFor = useCallback((f: MagicFill): string => {
    const t = pageTextRef.current;
    const mw = maskWRef.current || rawRegionsRef.current?.w || 0, mh = maskHRef.current || rawRegionsRef.current?.h || 0;
    if (!t?.items.length || !mw || !mh) return '';
    return pickRoomLabel(t.items, (x, y) => pointInFill(f, x * mw, y * mh));
  }, []);

  // ── Hover ─────────────────────────────────────────────────────────────────
  const handleMagicHover = useCallback((canvasX: number, canvasY: number) => {
    const mw = maskWRef.current, mh = maskHRef.current;
    const cssW = pdfDimensions?.w ?? mw;
    const cssH = pdfDimensions?.h ?? mh;
    // Scale CSS-space hover coords → mask-pixel space for hit testing.
    const bitmapX = Math.round(canvasX * (mw / cssW));
    const bitmapY = Math.round(canvasY * (mh / cssH));

    const idx = bitmapY * mw + bitmapX;
    const cf  = magicFillsRef.current;
    let found: number | null = null;
    for (let i = cf.length - 1; i >= 0; i--) {
      const map = fillPixelMaps.current.get(cf[i].id);
      if (map ? map[idx] : pointInFill(cf[i], bitmapX, bitmapY)) { found = cf[i].id; break; }
    }
    setMfHoveredId(found);
    setMfHoverPos({ x: canvasX, y: canvasY });
  }, [pdfDimensions]);

  const handleMagicHoverLeave = useCallback(() => setMfHoveredId(null), []);

  // ── Undo ──────────────────────────────────────────────────────────────────
  const handleMagicUndo = useCallback(() => {
    killWorker(workerRef as any, workerUrlRef as any);
    setMfIsFilling(false);
    setMfFillMsg(''); setMfFillSub(undefined); setMfFillProgress(null);

    const next = pastRef.current.pop();
    if (!next) return;
    redoRef.current.push(magicFillsRef.current);
    setMfUndoCount(pastRef.current.length); setMfRedoCount(redoRef.current.length);
    snapshots.current = [];
    magicFillsRef.current = next;
    repaintFillLayer(next);
    setMagicFills(next);
    setMfSelectedId(next.length ? next[next.length - 1].id : null);
    setMfSelectedGroup(null);
    setMfHoveredId(null);
  }, [repaintFillLayer]);

  const handleMagicRedo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next) return;
    pastRef.current.push(magicFillsRef.current);
    setMfUndoCount(pastRef.current.length); setMfRedoCount(redoRef.current.length);
    snapshots.current = [];
    magicFillsRef.current = next;
    repaintFillLayer(next);
    setMagicFills(next);
    setMfSelectedId(next.length ? next[next.length - 1].id : null);
    setMfSelectedGroup(null);
  }, [repaintFillLayer]);

  // ── Clear all ─────────────────────────────────────────────────────────────
  const handleMagicClear = useCallback(() => {
    killWorker(workerRef as any, workerUrlRef as any);
    const fc = fillCanvasRef.current;
    if (fc) {
      const ctx = fc.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, fc.width, fc.height);
    }
    if (fillDataRef.current) {
      fillDataRef.current.data.fill(0);
    }
    forgetHistory();
    snapshots.current       = [];
    fillCountRef.current    = 0;
    groupCountRef.current   = 0;
    fillPixelMaps.current.clear();
    setMagicFills([]);
    setMfHiddenIds(new Set());
    setMfSelectedId(null);
    setMfSelectedGroup(null);
    setMfHoveredId(null);
    setMfHolesClosed(new Set());
    setMfLastFillPos(null);
    setMfIsFilling(false);
    setMfFillMsg(''); setMfFillSub(undefined); setMfFillProgress(null);
    setActiveColorIdx(0);
  }, [fillCanvasRef]);

  const handleMagicDelete = useCallback((fId: number) => {
    remember();
    fillPixelMaps.current.delete(fId);
    setMagicFills(prev => prev.filter(x => x.id !== fId));
    if (mfSelectedId === fId) setMfSelectedId(null);
    if (mfHoveredId  === fId) setMfHoveredId(null);
  }, [mfSelectedId, mfHoveredId]);

  const handleMagicToggleHide = useCallback((fId: number) => {
    setMfHiddenIds(prev => {
      const s = new Set(prev);
      s.has(fId) ? s.delete(fId) : s.add(fId);
      return s;
    });
  }, []);

  const handleMagicFillHoles = useCallback(() => {}, []);

  const handleMagicAbortSession = useCallback(() => {
    killWorker(workerRef as any, workerUrlRef as any);
    handleMagicClear();
  }, [handleMagicClear]);

  // ── Finish ────────────────────────────────────────────────────────────────
  const handleMagicFinish = useCallback(() => {
    if (magicFillsRef.current.length === 0) return;
    setShowMfNameDialog(true);
    const fills = magicFillsRef.current;
    const only = fills.length === 1 ? roomLabelFor(fills[0]) : '';
    setPendingMfData({ id: `mf-${Date.now()}`, type: 'Area', description: only || 'Magic Fill Area' });
  }, [roomLabelFor]);

  const handleMfNameConfirm = useCallback((name: string) => {
    setShowMfNameDialog(false);
    const fills = magicFillsRef.current;
    if (fills.length === 0) return;

    // Each fill becomes a real Area shape: its (snapped) outline as normalised
    // points, area from that outline in PDF points → m² with the page scale.
    // (Previously the area was mask pixels × "metres per pixel", where that
    // factor was actually metres per PDF point — so areas came out up to 9×
    // too large, and the rows had no shape on the drawing.)
    const mw = maskWRef.current || maskDims.w || 1;
    const mh = maskHRef.current || maskDims.h || 1;
    const ptPerPxX = pageSizePt ? pageSizePt.w / mw : 1;
    const ptPerPxY = pageSizePt ? pageSizePt.h / mh : 1;
    const sf = scaleFactor > 0 ? scaleFactor : 1;
    const calibrated = !!pageSizePt && scaleFactor > 0;

    const parts = fills.map(f => {
      const usable = f.polygon.length >= 3;
      const m = usable && pageSizePt
        ? maskOutlineMeasure(f.polygon, { w: mw, h: mh }, pageSizePt, sf)
        : { area: f.areaPx * ptPerPxX * ptPerPxY * sf * sf, perimeter: f.perimPx * ptPerPxX * sf };
      // Parts taken back out (Alt-click) are deducted.
      const holes = usable && pageSizePt ? (f.holes ?? []).filter(h => h.length >= 3) : [];
      const holeArea = holes.reduce((t, h) => t + maskOutlineMeasure(h, { w: mw, h: mh }, pageSizePt!, sf).area, 0);
      return {
        fill: f,
        points: usable ? f.polygon.map(([x, y]) => ({ x: x / mw, y: y / mh })) : [],
        holes: holes.map(h => h.map(([x, y]) => ({ x: x / mw, y: y / mh }))),
        label: roomLabelFor(f),
        area: Math.max(0, m.area - holeArea),
        perim: m.perimeter,
      };
    });
    const unit = calibrated ? 'm²' : 'pt²';
    const total = parts.reduce((s, p) => s + p.area, 0);
    const totalPerim = parts.reduce((s, p) => s + p.perim, 0);
    const baseName = name || 'Magic Fill Area';
    const now = Date.now();
    const round = (v: number) => parseFloat(v.toFixed(4));

    const rowFor = (p: typeof parts[number], id: string, label: string, extra: Record<string, unknown> = {}) => ({
      id,
      drawingId:   activeDrawingId || '',
      label,
      description: label,
      type:        'Area',
      quantity:    round(p.area),
      unit,
      unitRate:    0,
      notes:       `Perimeter ${round(p.perim)} ${calibrated ? 'm' : 'pt'}`,
      points:      p.points,
      ...(p.holes.length ? { holes: p.holes } : {}),
      isOverridden: p.points.length === 0,     // no shape → quantity can't be re-derived
      color:       p.fill.color || '#60a5fa',
      isVisible:   true,
      childIds:    [],
      ...extra,
    });

    if (parts.length === 1) {
      const row: any = rowFor(parts[0], `mf-${now}`, baseName);
      if (propAppendToGroupId) { row.parentId = propAppendToGroupId; row.groupId = propAppendToGroupId; }
      onAddMeasurementProp?.(row);
    } else {
      // Several fills → a group: one row per fill, the header shows the total.
      const headerId = propAppendToGroupId || `mf-${now}`;
      const childIds = parts.map((_, i) => `mf-${now}-${i + 1}`);
      if (!propAppendToGroupId) {
        onAddMeasurementProp?.({
          id: headerId, drawingId: activeDrawingId || '', label: baseName, description: baseName,
          groupName: baseName, type: 'Area', quantity: round(total), unit, unitRate: 0,
          notes: `${parts.length} areas · perimeter ${round(totalPerim)} ${calibrated ? 'm' : 'pt'}`,
          points: [], isOverridden: false, isGroupHeader: true, isExpanded: true,
          color: parts[0].fill.color || '#60a5fa', isVisible: true, childIds,
        } as any);
      }
      parts.forEach((p, i) => {
        onAddMeasurementProp?.(rowFor(p, childIds[i], p.label || `${baseName} ${i + 1}`, { parentId: headerId, groupId: headerId }) as any);
      });
    }

    onAppendComplete?.();
    handleMagicClear();
  }, [
    activeDrawingId, scaleFactor, pageSizePt, maskDims,
    propAppendToGroupId, onAddMeasurementProp, onAppendComplete,
    handleMagicClear, roomLabelFor,
  ]);

  // Skip = keep the fills under the default name (it used to throw them away).
  const handleMfNameSkip = useCallback(() => {
    handleMfNameConfirm('');
  }, [handleMfNameConfirm]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const allVisibleFills = magicFills;
  const mfStagedCount   = magicFills.length;

  return {
    /** Saved rooms for this page (mask-pixel coordinates) — for the hover highlight. */
    mfRooms: regionsRef.current && regionsRef.current.key === regionKey ? regionsRef.current : null,
    mfRoomsVersion: regionsVersion,
    allVisibleFills,
    magicFills,
    mfStagedCount,
    maskW: maskDims.w,
    maskH: maskDims.h,
    mfSelectedId,    setMfSelectedId,
    mfSelectedGroup, setMfSelectedGroup,
    mfHoveredId,     mfHoverPos,
    mfHiddenIds,
    mfHolesClosed,
    mfIsFilling,
    mfIsRepainting: false,
    mfFillMsg,
    mfFillSub,
    mfFillProgress,
    mfMetersPerPixel,
    mfLastFillPos,
    showMfNameDialog,
    pendingMfData,
    activeColor,
    handleMagicSingleClick,
    handleMagicBatchRect,
    handleMagicPolygonFill,
    handleMagicHover,
    handleMagicHoverLeave,
    handleMagicFillHoles,
    handleMagicUndo,
    handleMagicRedo,
    mfRedoCount,
    mfUndoCount,
    handleMagicSubtractClick,
    handleMagicFillAll,
    mfRoomCount,
    handleMagicClear,
    handleMagicDelete,
    handleMagicToggleHide,
    handleMagicAbortSession,
    handleMagicFinish,
    handleMfNameConfirm,
    handleMfNameSkip,
  };
}
'use client';
// ─── hooks/fill/useMagicFillSession.ts ───────────────────────────────────────
//
//  FIX 1: Fill canvas is explicitly sized to match the PDF canvas (bc.width ×
//          bc.height) in the mask-building useEffect. Previously the fill canvas
//          could retain its default 300×150 HTML dimensions while the mask was
//          built at full PDF resolution, causing every click coordinate to be
//          wildly mis-mapped into the mask space.
//
//  FIX 2: Fill canvas style.width / style.height are also set to pdfDimensions
//          w/h in px so the CSS layout size matches the bitmap exactly. Without
//          this the canvas would stretch/squish and pointer coords would be off.
//
//  FIX 3: Single-click worker receives mask dimensions (mw × mh) and remapped
//          click coordinates (maskX, maskY) so the flood-fill hits the right
//          pixel even when fill-canvas and PDF-canvas dimensions differ.
//
//  FIX 4: Polygon lasso worker similarly remaps polygon vertices from
//          fill-canvas space into mask space before posting.
//
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useRef, useCallback, useEffect } from 'react';
import type { MagicFill }      from '@/hooks/fill/useMagicFill';
import type { PdfDimensions }  from '@/types/viewerTypes';
import type { TakeoffRow }     from '@/types';

// ─── Cycling fill color palette (must match MagicFillCanvas) ──────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// RASTER WORKER — single-click flood fill
// ─────────────────────────────────────────────────────────────────────────────
const RASTER_WORKER_SOURCE = /* js */`
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

function marchingSquaresContour(mask, w, h) {
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
  let prevX = startX - 1, prevY = startY;
  let steps = 0;
  const maxSteps = W * H * 2;
  do {
    contour.push([cx - 1, cy - 1]);
    const fromDx = cx - prevX, fromDy = cy - prevY;
    let startDir = 0;
    for (let d = 0; d < 8; d++)
      if (dx8[d] === -fromDx && dy8[d] === -fromDy) { startDir = d; break; }
    let moved = false;
    for (let t = 0; t < 8; t++) {
      const d = (startDir + t) % 8;
      const nx = cx + dx8[d], ny = cy + dy8[d];
      if (nx >= 0 && nx < W && ny >= 0 && ny < H && field[ny * W + nx]) {
        prevX = cx; prevY = cy; cx = nx; cy = ny; moved = true; break;
      }
    }
    if (!moved) break;
    if (++steps > maxSteps) break;
  } while (!(cx === startX && cy === startY));
  return contour;
}

function rdpSimplify(pts, eps) {
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

function buildPolygonFromMask(mask, w, h) {
  const eroded   = erodeMaskFast(mask, w, h, 2);
  const restored = dilateMaskFast(eroded, w, h, 2);
  const raw = marchingSquaresContour(restored, w, h);
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
  let perim = 0;
  for (let i = 0; i < raw.length; i++) {
    const j = (i + 1) % raw.length;
    perim += Math.hypot(raw[j][0] - raw[i][0], raw[j][1] - raw[i][1]);
  }
  const eps = Math.max(0.5, Math.min(3, perim / 400));
  return rdpSimplify(raw, eps);
}

function maskArea(mask) {
  let c = 0; for (let i = 0; i < mask.length; i++) if (mask[i]) c++; return c;
}

function polygonPerim(pts) {
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    p += Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
  }
  return Math.round(p);
}

self.onmessage = ({ data }) => {
  const { maskBuffer, fillDataBuffer, w, h, cx, cy, r, g, b, opacity } = data;
  const mask = new Uint8Array(maskBuffer);
  const fillDataArr = new Uint8ClampedArray(fillDataBuffer);
  const filled = multiSeedFill(mask, w, h, cx, cy);
  if (!filled) { self.postMessage({ empty: true }); return; }
  const closed = closeHoles(filled, w, h);
  paintFill(closed, fillDataArr, r, g, b, opacity);
  const areaPx  = maskArea(closed);
  const polygon = buildPolygonFromMask(closed, w, h);
  const perimPx = polygonPerim(polygon);
  self.postMessage(
    { fillDataBuffer: fillDataArr.buffer, closedBuffer: closed.buffer, areaPx, perimPx, polygon },
    [fillDataArr.buffer, closed.buffer],
  );
};
`;

// ─────────────────────────────────────────────────────────────────────────────
// POLYGON LASSO WORKER — fills all rooms inside a user-drawn polygon
// ─────────────────────────────────────────────────────────────────────────────
const POLYGON_WORKER_SOURCE = /* js */`
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
function polygonPerim(pts) {
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    p += Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
  }
  return Math.round(p);
}
function bboxPolygon(mask, W) {
  const H = (mask.length / W) | 0;
  let minX = W, minY = H, maxX = 0, maxY = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % W, y = (i / W) | 0;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]];
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
  const { maskBuffer, fillDataBuffer, w, h, r, g, b, opacity, poly } = data;
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
  const polygon     = bboxPolygon(closed, w);
  const perimPx     = polygonPerim(polygon);
  const regionCount = Math.max(1, localResults.length);
  self.postMessage(
    { fillDataBuffer: fillDataArr.buffer, closedBuffer: closed.buffer, polygon, areaPx, perimPx, regionCount },
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
}

// ─────────────────────────────────────────────────────────────────────────────
// Wall-mask constants
// ─────────────────────────────────────────────────────────────────────────────
const WALL_LUMA           = 120;
const STROKE_NEIGHBOR_MIN = 0.4;
const DILATE_R            = 2;
const ERODE_R             = 1;

function buildWallMask(
  data: Uint8ClampedArray,
  w:    number,
  h:    number,
): Uint8Array {
  const dark = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3] < 20) continue;
    const luma = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    if (luma < WALL_LUMA) dark[i] = 1;
  }
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!dark[y * w + x]) continue;
      let n = 0;
      if (x > 0   && dark[y * w + x - 1])           n++;
      if (x < w-1 && dark[y * w + x + 1])           n++;
      if (y > 0   && dark[(y-1) * w + x])           n++;
      if (y < h-1 && dark[(y+1) * w + x])           n++;
      if (x > 0   && y > 0   && dark[(y-1)*w+x-1]) n++;
      if (x < w-1 && y > 0   && dark[(y-1)*w+x+1]) n++;
      if (x > 0   && y < h-1 && dark[(y+1)*w+x-1]) n++;
      if (x < w-1 && y < h-1 && dark[(y+1)*w+x+1]) n++;
      if (n >= STROKE_NEIGHBOR_MIN) mask[y * w + x] = 1;
    }
  }
  return mask;
}

function dilateMaskMain(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
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

function erodeMaskMain(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
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

// ─────────────────────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────────────────────
export function fmtArea(px: number, mpp: number | null): string {
  if (!mpp) return `${px.toLocaleString()} px²`;
  const m2 = px * mpp * mpp;
  return m2 >= 1 ? `${m2.toFixed(2)} m²` : `${(m2 * 1e6).toFixed(0)} mm²`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

export function useMagicFillSession({
  fillCanvasRef,
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

  // ── Color cycling ─────────────────────────────────────────────────────────
  const [activeColorIdx, setActiveColorIdx] = useState(0);
  const activeColor = FILL_COLORS[activeColorIdx];
  const cycleColor  = useCallback(() => setActiveColorIdx(i => (i + 1) % FILL_COLORS.length), []);

  // ── Internal refs ─────────────────────────────────────────────────────────
  const maskRef         = useRef<Uint8Array | null>(null);
  const maskWRef        = useRef(0);
  const maskHRef        = useRef(0);
  const fillDataRef     = useRef<ImageData | null>(null);
  const fillCountRef    = useRef(0);
  const groupCountRef   = useRef(0);
  const fillPixelMaps   = useRef<Map<number, Uint8Array>>(new Map());
  const snapshots       = useRef<ImageData[]>([]);
  const magicFillsRef   = useRef<MagicFill[]>([]);
  const mfOpacity       = 40;

  const workerRef    = useRef<Worker | null>(null);
  const workerUrlRef = useRef<string | null>(null);

  useEffect(() => { magicFillsRef.current = magicFills; }, [magicFills]);

  // ── Cleanup workers on unmount ────────────────────────────────────────────
  useEffect(() => () => killWorker(workerRef as any, workerUrlRef as any), []);

  // ── Build (or rebuild) wall mask when PDF renders ──────────────────────────
  //
  //  FIX: The fill canvas must match the PDF canvas in BOTH bitmap dimensions
  //  (canvas.width / canvas.height attributes) AND CSS layout size
  //  (style.width / style.height). Without both:
  //
  //  - Bitmap mismatch: the ImageData written by workers is mw×mh but the
  //    canvas is 300×150, so putImageData draws in the wrong area and
  //    getImageData returns garbage for hover hit-testing.
  //
  //  - CSS mismatch: even if the bitmap is correct, if style.width ≠ w px,
  //    the browser scales the canvas visually and pointer events from
  //    MagicFillCanvas will be in CSS pixels, not bitmap pixels.
  //
  useEffect(() => {
    if (pdfRenderCount === 0) return;
    const bc = pdfCanvasRef.current;
    const fc = fillCanvasRef.current;
    if (!bc || !fc) return;

    const w = bc.width, h = bc.height;
    if (!w || !h) return;

    // ── FIX: sync fill canvas bitmap AND CSS size to PDF canvas ────────────
    if (fc.width  !== w) fc.width  = w;
    if (fc.height !== h) fc.height = h;
    // CSS size must match pdfDimensions (logical pixels), not bc.width/height
    // which may be multiplied by devicePixelRatio in some renderers.
    // Use pdfDimensions if available, otherwise fall back to bc intrinsic size.
    const cssW = pdfDimensions?.w ?? w;
    const cssH = pdfDimensions?.h ?? h;
    fc.style.width  = `${cssW}px`;
    fc.style.height = `${cssH}px`;

    const ctx = bc.getContext('2d');
    if (!ctx) return;

    const id  = ctx.getImageData(0, 0, w, h);
    const raw = buildWallMask(id.data, w, h);
    const dil = dilateMaskMain(raw, w, h, DILATE_R);
    const mask = erodeMaskMain(dil, w, h, ERODE_R);

    maskRef.current     = mask;
    maskWRef.current    = w;
    maskHRef.current    = h;
    fillDataRef.current = new ImageData(w, h);

    // Reset all fill state
    fillCountRef.current  = 0;
    groupCountRef.current = 0;
    fillPixelMaps.current.clear();
    snapshots.current = [];
    setMagicFills([]);
    setMfHiddenIds(new Set());
    setMfSelectedId(null);
    setMfSelectedGroup(null);
    setMfHoveredId(null);
    setMfHolesClosed(new Set());
    setMfLastFillPos(null);

    setMfMetersPerPixel(scaleFactor > 0 ? scaleFactor : null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfRenderCount]);

  // ── Put fill canvas back after PDF re-render (preserve fills) ─────────────
  const repaintFillCanvas = useCallback(() => {
    const fc = fillCanvasRef.current;
    if (!fc || !fillDataRef.current) return;
    const ctx = fc.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(fillDataRef.current, 0, 0);
  }, [fillCanvasRef]);

  // ── Single-click raster fill (web worker) ─────────────────────────────────
  //
  //  FIX: click coordinates arrive in MagicFillCanvas space (= pdfDimensions
  //  logical pixels). The mask and fillData are in pdfCanvasRef bitmap space
  //  (bc.width × bc.height). We remap via maskW/maskH so the worker always
  //  gets coordinates in its own coordinate system.
  //
  const handleMagicSingleClick = useCallback((canvasX: number, canvasY: number) => {
    if (!maskRef.current || !fillDataRef.current || mfIsFilling) return;
    const fc = fillCanvasRef.current;
    if (!fc) return;

    const mw = maskWRef.current, mh = maskHRef.current;
    if (!mw || !mh) return;

    // Remap from MagicFillCanvas logical pixels → mask/fillData bitmap pixels
    // MagicFillCanvas uses pdfDimensions.w/h as its coordinate space.
    // The mask was built from pdfCanvasRef which has bitmap size mw × mh.
    const cssW = pdfDimensions?.w ?? mw;
    const cssH = pdfDimensions?.h ?? mh;
    const maskX = Math.round(canvasX * (mw / cssW));
    const maskY = Math.round(canvasY * (mh / cssH));

    setMfIsFilling(true);
    setMfFillMsg('Flood filling region');
    setMfFillSub('Running off main thread…');

    snapshots.current.push(
      new ImageData(new Uint8ClampedArray(fillDataRef.current.data), mw, mh),
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
      },
      [maskCopy, fillDataCopy],
    );

    worker.onmessage = ({ data: result }) => {
      killWorker(workerRef as any, workerUrlRef as any);
      if (result.empty) {
        snapshots.current.pop();
        setMfIsFilling(false); setMfFillMsg(''); setMfFillSub(undefined);
        return;
      }

      const { fillDataBuffer, closedBuffer, areaPx, perimPx, polygon } = result;

      const painted = new Uint8ClampedArray(fillDataBuffer);
      fillDataRef.current = new ImageData(painted, mw, mh);
      fc.getContext('2d')!.putImageData(fillDataRef.current, 0, 0);

      const closed = new Uint8Array(closedBuffer);
      fillCountRef.current += 1;
      const id = Date.now() + fillCountRef.current;
      fillPixelMaps.current.set(id, closed);

      const fill: MagicFill = {
        id,
        label:   `Fill ${fillCountRef.current}`,
        color:   activeColor,
        opacity: mfOpacity,
        areaPx,
        perimPx,
        polygon: polygon as [number, number][],
        svgMode: false,
      };

      setMagicFills(prev => [...prev, fill]);
      setMfSelectedId(id);
      setMfSelectedGroup(null);
      setMfLastFillPos({ x: canvasX, y: canvasY });
      setMfIsFilling(false); setMfFillMsg(''); setMfFillSub(undefined);
      cycleColor();
    };

    worker.onerror = () => {
      killWorker(workerRef as any, workerUrlRef as any);
      snapshots.current.pop();
      setMfIsFilling(false); setMfFillMsg(''); setMfFillSub(undefined);
    };
  }, [mfIsFilling, fillCanvasRef, activeColor, cycleColor, pdfDimensions]);

  // ── Polygon lasso fill (web worker) ───────────────────────────────────────
  //
  //  FIX: polygon vertices are in MagicFillCanvas logical pixel space.
  //  Remap to mask bitmap space before posting to worker.
  //
  const handleMagicPolygonFill = useCallback((poly: [number, number][]) => {
    if (poly.length < 3 || !maskRef.current || !fillDataRef.current || mfIsFilling) return;
    const fc = fillCanvasRef.current;
    if (!fc) return;

    const mw = maskWRef.current, mh = maskHRef.current;
    if (!mw || !mh) return;

    const cssW = pdfDimensions?.w ?? mw;
    const cssH = pdfDimensions?.h ?? mh;
    const scaleX = mw / cssW;
    const scaleY = mh / cssH;

    const maskPoly = poly.map(([x, y]): [number, number] => [
      Math.round(x * scaleX),
      Math.round(y * scaleY),
    ]);

    setMfIsFilling(true);
    setMfFillMsg('Detecting regions in polygon');
    setMfFillSub('Running off main thread…');
    setMfFillProgress(null);

    snapshots.current.push(
      new ImageData(new Uint8ClampedArray(fillDataRef.current.data), mw, mh),
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
      },
      [maskCopy, fillDataCopy],
    );

    worker.onmessage = ({ data: result }) => {
      killWorker(workerRef as any, workerUrlRef as any);

      if (result.empty || result.error === 'leak') {
        snapshots.current.pop();
        setMfIsFilling(false);
        setMfFillMsg(''); setMfFillSub(undefined); setMfFillProgress(null);
        return;
      }

      const { fillDataBuffer, closedBuffer, polygon, areaPx, perimPx, regionCount } = result;
      const painted = new Uint8ClampedArray(fillDataBuffer);
      fillDataRef.current = new ImageData(painted, mw, mh);
      fc.getContext('2d')!.putImageData(fillDataRef.current, 0, 0);

      const closed = new Uint8Array(closedBuffer);

      groupCountRef.current += 1;
      const gId = groupCountRef.current;
      fillCountRef.current  += 1;
      const id = Date.now() + fillCountRef.current;

      fillPixelMaps.current.set(id, closed);

      const fill: MagicFill = {
        id,
        label:   `Fill ${fillCountRef.current}`,
        color:   activeColor,
        opacity: mfOpacity,
        areaPx,
        perimPx,
        polygon: polygon as [number, number][],
        groupId: gId,
        svgMode: false,
      };

      setMagicFills(prev => [...prev, fill]);
      setMfSelectedId(null);
      setMfSelectedGroup(gId);
      setMfLastFillPos({ x: poly[0][0], y: poly[0][1] });
      setMfIsFilling(false);
      setMfFillMsg(''); setMfFillSub(undefined); setMfFillProgress(null);
      cycleColor();
    };

    worker.onerror = () => {
      killWorker(workerRef as any, workerUrlRef as any);
      snapshots.current.pop();
      setMfIsFilling(false);
      setMfFillMsg(''); setMfFillSub(undefined); setMfFillProgress(null);
    };
  }, [mfIsFilling, fillCanvasRef, activeColor, cycleColor, pdfDimensions]);

  // ── Batch rect fill — converts rect to polygon and runs lasso worker ──────
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

  // ── Hover ─────────────────────────────────────────────────────────────────
  //
  //  FIX: hover coords are in MagicFillCanvas logical pixel space.
  //  Remap to fillPixelMaps bitmap space for hit-testing.
  //
  const handleMagicHover = useCallback((canvasX: number, canvasY: number) => {
    const mw = maskWRef.current, mh = maskHRef.current;
    const cssW = pdfDimensions?.w ?? mw;
    const cssH = pdfDimensions?.h ?? mh;
    const bitmapX = Math.round(canvasX * (mw / cssW));
    const bitmapY = Math.round(canvasY * (mh / cssH));

    const idx = bitmapY * mw + bitmapX;
    const cf  = magicFillsRef.current;
    let found: number | null = null;
    for (let i = cf.length - 1; i >= 0; i--) {
      const map = fillPixelMaps.current.get(cf[i].id);
      if (map && map[idx]) { found = cf[i].id; break; }
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

    setMagicFills(prev => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      let next: MagicFill[];
      if (last.groupId != null) {
        const gid = last.groupId;
        prev.filter(x => x.groupId === gid).forEach(x => fillPixelMaps.current.delete(x.id));
        next = prev.filter(x => x.groupId !== gid);
      } else {
        fillPixelMaps.current.delete(last.id);
        next = prev.slice(0, -1);
      }
      if (snapshots.current.length > 0 && fillDataRef.current) {
        const snap = snapshots.current.pop()!;
        fillDataRef.current = new ImageData(new Uint8ClampedArray(snap.data), snap.width, snap.height);
        fillCanvasRef.current?.getContext('2d')?.putImageData(fillDataRef.current, 0, 0);
      }
      const newSel = next.length ? next[next.length - 1].id : null;
      setMfSelectedId(newSel);
      setMfSelectedGroup(null);
      return next;
    });
  }, [fillCanvasRef]);

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

  // ── Delete single fill ────────────────────────────────────────────────────
  const handleMagicDelete = useCallback((fId: number) => {
    fillPixelMaps.current.delete(fId);
    setMagicFills(prev => prev.filter(x => x.id !== fId));
    if (mfSelectedId === fId) setMfSelectedId(null);
    if (mfHoveredId  === fId) setMfHoveredId(null);
  }, [mfSelectedId, mfHoveredId]);

  // ── Toggle hidden ─────────────────────────────────────────────────────────
  const handleMagicToggleHide = useCallback((fId: number) => {
    setMfHiddenIds(prev => {
      const s = new Set(prev);
      s.has(fId) ? s.delete(fId) : s.add(fId);
      return s;
    });
  }, []);

  // ── Fill holes ────────────────────────────────────────────────────────────
  const handleMagicFillHoles = useCallback(() => {}, []);

  // ── Abort session ─────────────────────────────────────────────────────────
  const handleMagicAbortSession = useCallback(() => {
    killWorker(workerRef as any, workerUrlRef as any);
    handleMagicClear();
  }, [handleMagicClear]);

  // ── Finish (commit staged fills to TakeoffContext) ─────────────────────────
  const handleMagicFinish = useCallback(() => {
    if (magicFillsRef.current.length === 0) return;
    setShowMfNameDialog(true);
    setPendingMfData({ id: `mf-${Date.now()}`, type: 'Area', description: 'Magic Fill Area' });
  }, []);

  const handleMfNameConfirm = useCallback((name: string) => {
    setShowMfNameDialog(false);
    const fills = magicFillsRef.current;
    if (fills.length === 0) return;

    const totalArea  = fills.reduce((s, f) => s + f.areaPx,  0);
    const totalPerim = fills.reduce((s, f) => s + f.perimPx, 0);
    const m2 = mfMetersPerPixel
      ? totalArea * mfMetersPerPixel * mfMetersPerPixel
      : null;

    const row: any = {
      id:          `mf-${Date.now()}`,
      drawingId:   activeDrawingId || '',
      label:       name || 'Magic Fill Area',
      description: name || 'Magic Fill Area',
      type:        'Area',
      quantity:    m2 != null ? parseFloat(m2.toFixed(4)) : totalArea,
      unit:        m2 != null ? 'm²' : 'px²',
      unitRate:    0,
      notes:       `${fills.length} fill region${fills.length !== 1 ? 's' : ''} · ${fmtArea(totalArea, mfMetersPerPixel)}`,
      isOverridden: true,
      color:        fills[0]?.color || '#60a5fa',
      isVisible:    true,
      childIds:     [],
    };

    if (propAppendToGroupId) {
      row.parentId = propAppendToGroupId;
      row.groupId  = propAppendToGroupId;
    }

    onAddMeasurementProp?.(row);
    onAppendComplete?.();
    handleMagicClear();
  }, [
    activeDrawingId, mfMetersPerPixel,
    propAppendToGroupId, onAddMeasurementProp, onAppendComplete,
    handleMagicClear,
  ]);

  const handleMfNameSkip = useCallback(() => {
    setShowMfNameDialog(false);
    handleMagicClear();
  }, [handleMagicClear]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const allVisibleFills = magicFills;
  const mfStagedCount   = magicFills.length;

  return {
    allVisibleFills,
    magicFills,
    mfStagedCount,
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
    handleMagicClear,
    handleMagicDelete,
    handleMagicToggleHide,
    handleMagicAbortSession,
    handleMagicFinish,
    handleMfNameConfirm,
    handleMfNameSkip,
  };
}
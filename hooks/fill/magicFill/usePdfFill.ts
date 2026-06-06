// hooks/fill/magicFill/usePdfFill.ts
// ── OPTIMIZED v2 ──────────────────────────────────────────────────────────────
//
// All previous fixes (v1) retained, plus:
//
//  FIX 7: rasterizePolygon — replaces pointInPolygon in the seed-scan loop.
//          Instead of calling O(V) ray-cast per grid point, we scanline-rasterize
//          the lasso polygon ONCE into a Uint8Array (O(bbox_area)), then every
//          inside check is a single array lookup O(1).
//          Old cost: O(N_seeds × V).  New cost: O(bbox_area) + O(N_seeds).
//          pointInPolygon is removed from the worker entirely.
//
'use client';
import { useState, useRef, useCallback, useEffect } from 'react';
import {
  COLORS, PDF_SCALE, FILL_GROW,
  Fill, LoadStage,
  yieldFrame, yieldMacro,
  hexToRgb, fmtArea, fmtPerim,
  dilateMaskFast, multiSeedFill, paintFill, closeHoles,
  maskArea, buildPolygonFromMask, polygonPerim,
  buildMaskAsync,
} from './fillCore';

export type { Fill, LoadStage };
export { fmtArea, fmtPerim, hexToRgb, COLORS };

export interface LassoState {
  points: [number, number][];
  isOpen: boolean;
  mousePos: [number, number] | null;
}

// ── Optimized inline worker ───────────────────────────────────────────────────

const WORKER_SOURCE = /* js */`

// ─────────────────────────────────────────────────────────────────────────────
// Morphology helpers
// ─────────────────────────────────────────────────────────────────────────────

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

function closeHoles(filled, w, h) {
  const outside = new Uint8Array(w * h);
  const stack = [];
  const push = (i) => {
    if (i >= 0 && i < w * h && !filled[i] && !outside[i]) {
      outside[i] = 1; stack.push(i);
    }
  };
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

function bboxPolygon(mask, w) {
  const h = (mask.length / w) | 0;
  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % w, y = (i / w) | 0;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]];
}

function maskArea(mask) {
  let c = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) c++;
  return c;
}

function polygonPerim(pts) {
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    p += Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
  }
  return Math.round(p);
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

// ─────────────────────────────────────────────────────────────────────────────
// FIX 7: rasterizePolygon
// Scanline-fills the lasso polygon into a Uint8Array once — O(bbox_area).
// Replaces the O(V) pointInPolygon ray-cast called per grid seed.
// Returns the mask plus the tight bounding box for the scan loop.
// ─────────────────────────────────────────────────────────────────────────────

function rasterizePolygon(poly, w, h) {
  let bx1 = Infinity, by1 = Infinity, bx2 = -Infinity, by2 = -Infinity;
  for (const [px, py] of poly) {
    if (px < bx1) bx1 = px; if (px > bx2) bx2 = px;
    if (py < by1) by1 = py; if (py > by2) by2 = py;
  }
  const x1 = Math.max(0, Math.floor(bx1));
  const y1 = Math.max(0, Math.floor(by1));
  const x2 = Math.min(w - 1, Math.ceil(bx2));
  const y2 = Math.min(h - 1, Math.ceil(by2));

  const inside = new Uint8Array(w * h);
  const n = poly.length;

  for (let y = y1; y <= y2; y++) {
    // Collect X crossings for this scanline
    const xs = [];
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if ((yi <= y && yj > y) || (yj <= y && yi > y)) {
        xs.push(xi + (y - yi) / (yj - yi) * (xj - xi));
      }
    }
    xs.sort((a, b) => a - b);
    // Fill between even/odd crossing pairs
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const lx = Math.max(x1, Math.ceil(xs[k]));
      const rx = Math.min(x2, Math.floor(xs[k + 1]));
      for (let x = lx; x <= rx; x++) inside[y * w + x] = 1;
    }
  }
  return { inside, x1, y1, x2, y2 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scanline flood fill
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// FIX 4: multiSeedFill — cheap overlap check, no inner dilateMaskFast
// ─────────────────────────────────────────────────────────────────────────────

function masksOverlap(a, b, w) {
  // Direct pixel check first — no allocation
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) return true;
  }
  // One-step neighbor scan — catches rooms separated by a 1px wall
  const DIRS = [-1, 1, -w, w, -w-1, -w+1, w-1, w+1];
  for (let i = 0; i < b.length; i++) {
    if (!b[i]) continue;
    for (const d of DIRS) {
      const j = i + d;
      if (j >= 0 && j < a.length && a[j]) return true;
    }
  }
  return false;
}

function multiSeedFill(mask, w, h, cx, cy) {
  const OFFSETS = [
    [0,0],[1,0],[-1,0],[0,1],[0,-1],
    [2,0],[-2,0],[0,2],[0,-2],
    [1,1],[-1,1],[1,-1],[-1,-1],
  ];
  let merged = null;
  for (const [dx, dy] of OFFSETS) {
    const f = scanlineFill(mask, w, h, cx + dx, cy + dy);
    if (!f) continue;
    if (!merged) {
      merged = f;
    } else {
      if (masksOverlap(merged, f, w)) {
        for (let i = 0; i < merged.length; i++) if (f[i]) merged[i] = 1;
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

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1: find regions inside the polygon
//
// FIX 6: adaptive step size — min(bbox_side/80, 8) clamped to [4,8]
// FIX 7: inside check is insideMask[sy*w+sx] — O(1), not O(V) ray cast
// FIX 3: dead-seed marking on null fills
// ─────────────────────────────────────────────────────────────────────────────

function findRegionsInsidePolygon(mask, w, h, poly) {
  // ONE polygon rasterization replaces all pointInPolygon ray-cast calls
  const { inside, x1, y1, x2, y2 } = rasterizePolygon(poly, w, h);

  const discovered = [];
  const seen = new Uint8Array(w * h);

  // FIX 6: adaptive step
  const bboxSide = Math.min(x2 - x1, y2 - y1);
  const step = Math.max(4, Math.min(8, Math.round(bboxSide / 80)));

  for (let sy = y1; sy <= y2; sy += step) {
    for (let sx = x1; sx <= x2; sx += step) {
      // FIX 7: O(1) array lookup instead of O(V) ray cast
      if (!inside[sy * w + sx]) continue;
      if (mask[sy * w + sx] || seen[sy * w + sx]) continue;

      const filled = multiSeedFill(mask, w, h, sx, sy);
      if (!filled) {
        seen[sy * w + sx] = 1; // FIX 3: mark dead seeds
        continue;
      }
      for (let i = 0; i < filled.length; i++) if (filled[i]) seen[i] = 1;
      discovered.push(filled);
    }
  }
  return { discovered, seen };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: partially-touched boundary rooms
//
// FIX 1: seen pre-populated from DILATED union before this runs
// FIX 2: candidates deduped into a Set before any fill is fired
// FIX 3: dead-seed marking on null fills
// FIX 5: MAX_BOUNDARY_ROOMS cap
// ─────────────────────────────────────────────────────────────────────────────

const MAX_BOUNDARY_ROOMS = 64;

function findBoundaryRegions(mask, w, h, grownUnion, seen) {
  // FIX 2: collect unique candidates first — no duplicate fills
  const candidates = new Set();
  const NEIGHBOR = [-1, 1, -w, w];

  for (let i = 0; i < grownUnion.length; i++) {
    if (!grownUnion[i]) continue;
    for (const d of NEIGHBOR) {
      const j = i + d;
      if (j < 0 || j >= grownUnion.length) continue;
      // FIX 1: seen already covers grown pixels
      if (grownUnion[j] || mask[j] || seen[j]) continue;
      candidates.add(j);
    }
  }

  const extra = [];
  for (const j of candidates) {
    if (seen[j]) continue; // may have been filled by a previous iteration

    const filled = multiSeedFill(mask, w, h, j % w, (j / w) | 0);
    if (!filled) {
      seen[j] = 1; // FIX 3: dead-seed
      continue;
    }

    for (let k = 0; k < filled.length; k++) if (filled[k]) seen[k] = 1;
    extra.push(filled);

    if (extra.length >= MAX_BOUNDARY_ROOMS) break; // FIX 5
  }

  return extra;
}

// ─────────────────────────────────────────────────────────────────────────────
// Message handler
// ─────────────────────────────────────────────────────────────────────────────

self.onmessage = ({ data }) => {
  const { maskBuffer, fillDataBuffer, w, h, r, g, b, opacity, FILL_GROW, poly } = data;

  const mask = new Uint8Array(maskBuffer);

  // ── Phase 1 ───────────────────────────────────────────────────────────────
  const { discovered: regions, seen } = findRegionsInsidePolygon(mask, w, h, poly);

  if (regions.length === 0) {
    self.postMessage({ empty: true });
    return;
  }

  // Union phase-1 regions
  const unioned = new Uint8Array(w * h);
  for (const filled of regions) {
    for (let i = 0; i < filled.length; i++) if (filled[i]) unioned[i] = 1;
  }

  // Dilate to bridge gaps and expose the perimeter
  const grown = dilateMaskFast(unioned, w, h, FILL_GROW);

  // FIX 1: pre-populate seen from GROWN union — boundary scan skips all of it
  for (let i = 0; i < grown.length; i++) if (grown[i]) seen[i] = 1;

  // ── Phase 2 ───────────────────────────────────────────────────────────────
  const boundary = findBoundaryRegions(mask, w, h, grown, seen);

  for (const filled of boundary) {
    for (let i = 0; i < filled.length; i++) if (filled[i]) unioned[i] = 1;
  }

  // Re-dilate after adding boundary rooms
  const grownFinal = dilateMaskFast(unioned, w, h, FILL_GROW);

  // Close interior holes (furniture islands, etc.)
  const closed = closeHoles(grownFinal, w, h);

  // Leak guard
  const areaPx = maskArea(closed);
  if (areaPx / (w * h) > 0.80) {
    self.postMessage({ error: 'leak' });
    return;
  }

  // Paint
  const fillDataArr = new Uint8ClampedArray(fillDataBuffer);
  paintFill(closed, fillDataArr, r, g, b, opacity);

  const polygon     = bboxPolygon(closed, w);
  const perimPx     = polygonPerim(polygon);
  const regionCount = regions.length + boundary.length;

  self.postMessage(
    {
      fillDataBuffer: fillDataArr.buffer,
      closedBuffer:   closed.buffer,
      polygon,
      areaPx,
      perimPx,
      regionCount,
    },
    [fillDataArr.buffer, closed.buffer],
  );
};
`;

// ── CLOSE_SNAP_RADIUS ─────────────────────────────────────────────────────────
const CLOSE_SNAP_RADIUS = 14;

// ── usePdfFill ────────────────────────────────────────────────────────────────

export function usePdfFill() {
  // ── Color cycling ──────────────────────────────────────────────────────────
  const [activeColorIdx, setActiveColorIdx] = useState(0);
  const activeColor = COLORS[activeColorIdx];
  const setActiveColor = useCallback((c: string) => {
    const idx = COLORS.indexOf(c);
    if (idx >= 0) setActiveColorIdx(idx);
  }, []);
  const cycleColor = useCallback(() => setActiveColorIdx(p => (p + 1) % COLORS.length), []);

  // ── UI state ───────────────────────────────────────────────────────────────
  const [fillOpacity,   setFillOpacity]   = useState(40);
  const [zoom,          setZoom]          = useState(1);
  const [pan,           setPan]           = useState({ x: 0, y: 0 });
  const [mode,          setMode]          = useState<'fill' | 'pan'>('fill');
  const [isDragging,    setIsDragging]    = useState(false);
  const [isFilling,     setIsFilling]     = useState(false);
  const [fillMsg,       setFillMsg]       = useState('');
  const [fillSub,       setFillSub]       = useState<string | undefined>(undefined);
  const [fillProgress,  setFillProgress]  = useState<{ done: number; total: number } | null>(null);
  const [fills,         setFills]         = useState<Fill[]>([]);
  const [hiddenIds,     setHiddenIds]     = useState<Set<number>>(new Set());
  const [selectedId,    setSelectedId]    = useState<number | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<number | null>(null);
  const [hoveredId,     setHoveredId]     = useState<number | null>(null);
  const [hoverPos,      setHoverPos]      = useState({ x: 0, y: 0 });
  const [holesClosedIds,setHolesClosedIds]= useState<Set<number>>(new Set());
  const [showPolygon,   setShowPolygon]   = useState(true);
  const [status,        setStatus]        = useState('');
  const [fileName,      setFileName]      = useState('');
  const [loadStage,     setLoadStage]     = useState<LoadStage>('idle');
  const [loadProgress,  setLoadProgress]  = useState('');
  const [pxPerM,        setPxPerM]        = useState<number | null>(null);
  const [spaceHeld,     setSpaceHeld]     = useState(false);
  const [batchMode,     setBatchMode]     = useState(false);

  // ── Lasso state ────────────────────────────────────────────────────────────
  const [lassoPoints,   setLassoPoints]   = useState<[number, number][]>([]);
  const [isLassoing,    setIsLassoing]    = useState(false);
  const [lassoMouse,    setLassoMouse]    = useState<[number, number] | null>(null);

  // ── Refs ───────────────────────────────────────────────────────────────────
  const spaceHeldRef    = useRef(false);
  const batchModeRef    = useRef(false);
  const hasDraggedRef   = useRef(false);
  const lastClickTime   = useRef(0);
  const viewportRef     = useRef<HTMLDivElement>(null);
  const wrapRef         = useRef<HTMLDivElement>(null);
  const baseCanvasRef   = useRef<HTMLCanvasElement>(null);
  const fillCanvasRef   = useRef<HTMLCanvasElement>(null);
  const polyCanvasRef   = useRef<HTMLCanvasElement>(null);
  const maskRef         = useRef<Uint8Array | null>(null);
  const fillDataRef     = useRef<ImageData | null>(null);
  const basePixelsRef   = useRef<Uint8ClampedArray | null>(null);
  const dragRef         = useRef({ mx: 0, my: 0, px: 0, py: 0 });
  const fillCountRef    = useRef(0);
  const groupCountRef   = useRef(0);
  const fileInputRef    = useRef<HTMLInputElement>(null);
  const snapshots       = useRef<ImageData[]>([]);
  const fillPixelMaps   = useRef<Map<number, Uint8Array>>(new Map());
  const fillsRef        = useRef<Fill[]>([]);
  const panRef          = useRef(pan);
  const zoomRef         = useRef(zoom);
  const showPolygonRef  = useRef(showPolygon);
  const workerRef       = useRef<Worker | null>(null);
  const workerUrlRef    = useRef<string | null>(null);
  const lassoPointsRef  = useRef<[number, number][]>([]);

  useEffect(() => { fillsRef.current       = fills;       }, [fills]);
  useEffect(() => { panRef.current         = pan;         }, [pan]);
  useEffect(() => { zoomRef.current        = zoom;        }, [zoom]);
  useEffect(() => { batchModeRef.current   = batchMode;   }, [batchMode]);
  useEffect(() => { showPolygonRef.current = showPolygon; }, [showPolygon]);
  useEffect(() => { lassoPointsRef.current = lassoPoints; }, [lassoPoints]);

  useEffect(() => {
    if (wrapRef.current)
      wrapRef.current.style.transform = `translate(${pan.x}px,${pan.y}px) scale(${zoom})`;
  }, [pan, zoom]);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      if (workerUrlRef.current) URL.revokeObjectURL(workerUrlRef.current);
    };
  }, []);

  // ── Space key ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        spaceHeldRef.current = true;
        setSpaceHeld(true);
      }
      if (e.code === 'Escape') {
        setIsLassoing(false);
        setLassoPoints([]);
        setLassoMouse(null);
        lassoPointsRef.current = [];
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceHeldRef.current = false;
        setSpaceHeld(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // ── Helpers ────────────────────────────────────────────────────────────────
  const centerCanvas = useCallback(() => {
    const vp = viewportRef.current, bc = baseCanvasRef.current;
    if (!vp || !bc) return;
    const vr = vp.getBoundingClientRect();
    const fz = Math.min((vr.width * 0.9) / bc.width, (vr.height * 0.9) / bc.height, 1);
    setZoom(fz);
    setPan({ x: (vr.width - bc.width * fz) / 2, y: (vr.height - bc.height * fz) / 2 });
  }, []);

  const screenToCanvas = useCallback((sx: number, sy: number) => {
    const vp = viewportRef.current!;
    const vr = vp.getBoundingClientRect();
    return {
      cx: Math.round((sx - vr.left - panRef.current.x) / zoomRef.current),
      cy: Math.round((sy - vr.top  - panRef.current.y) / zoomRef.current),
    };
  }, []);

  // ── Polygon redraw ─────────────────────────────────────────────────────────
  const redrawPolygons = useCallback((
    currentFills: Fill[],
    currentHidden: Set<number>,
    currentSelected: number | null,
    currentGroup: number | null,
  ) => {
    const pc = polyCanvasRef.current, bc = baseCanvasRef.current;
    if (!pc || !bc) return;
    if (pc.width !== bc.width || pc.height !== bc.height) {
      pc.width = bc.width;
      pc.height = bc.height;
    }
    const ctx = pc.getContext('2d')!;
    ctx.clearRect(0, 0, pc.width, pc.height);
    if (!showPolygonRef.current) return;

    currentFills.forEach(f => {
      if (currentHidden.has(f.id) || f.polygon.length < 3) return;
      if (!f.svgMode && f.polygon.length === 4) {
        const xs = f.polygon.map(p => p[0]), ys = f.polygon.map(p => p[1]);
        if (new Set(xs).size === 2 && new Set(ys).size === 2) return;
      }
      const pts = f.polygon;
      const [r, g, b] = hexToRgb(f.color);
      const isSelected = f.id === currentSelected;
      const isInGroup  = currentGroup != null && f.groupId === currentGroup;

      const drawPath = () => {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();
      };

      if (isSelected || isInGroup) {
        ctx.save(); drawPath();
        ctx.strokeStyle = isInGroup ? 'rgba(96,165,250,0.18)' : `rgba(${r},${g},${b},0.18)`;
        ctx.lineWidth = 8; ctx.setLineDash([]); ctx.stroke(); ctx.restore();
      }
      drawPath();
      ctx.strokeStyle = `rgba(${r},${g},${b},${isSelected || isInGroup ? 1 : 0.8})`;
      ctx.lineWidth   = isSelected ? 2.5 : isInGroup ? 2 : 1.6;
      ctx.setLineDash([]); ctx.stroke();

      const cornersToShow: [number, number][] = f.svgCornerIndices
        ? pts.filter((_, i) => f.svgCornerIndices!.has(i))
        : pts;

      const dotR = isSelected ? 6 : 5;
      const dotA = isSelected ? 1 : isInGroup ? 0.95 : 0.85;

      cornersToShow.forEach(([px, py]) => {
        ctx.beginPath();
        ctx.arc(px, py, dotR + 1.5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 2.5;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(px, py, dotR, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${r},${g},${b},${dotA})`;
        ctx.fill();

        ctx.strokeStyle = isSelected
          ? 'rgba(255,255,255,1)'
          : `rgba(${Math.min(r+80,255)},${Math.min(g+80,255)},${Math.min(b+80,255)},0.8)`;
        ctx.lineWidth = isSelected ? 2 : 1.5;
        ctx.stroke();
      });
    });
  }, []);

  useEffect(() => {
    redrawPolygons(fills, hiddenIds, selectedId, selectedGroup);
  }, [fills, selectedId, selectedGroup, hiddenIds, showPolygon, redrawPolygons]);

  // ── PDF load ───────────────────────────────────────────────────────────────
  const loadPdf = useCallback(async (file: File) => {
    setLoadProgress('Initialising PDF.js…');
    let pdfjsLib = (window as any).pdfjsLib as any;
    if (!pdfjsLib) {
      await new Promise<void>((res, rej) => {
        let tries = 0;
        const id = setInterval(() => {
          pdfjsLib = (window as any).pdfjsLib;
          if (pdfjsLib) { clearInterval(id); res(); }
          else if (++tries > 60) { clearInterval(id); rej(new Error('PDF.js timed out')); }
        }, 100);
      });
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

    setLoadProgress('Parsing PDF…'); await yieldMacro();
    const ab   = await file.arrayBuffer();
    const doc  = await pdfjsLib.getDocument({ data: ab }).promise;
    const page = await doc.getPage(1);
    const vp   = page.getViewport({ scale: PDF_SCALE });
    const bc   = baseCanvasRef.current!, fc = fillCanvasRef.current!;
    bc.width = vp.width; bc.height = vp.height;
    const ctx = bc.getContext('2d')!;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, bc.width, bc.height);

    setLoadProgress('Rendering page…'); await yieldMacro();
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    await new Promise<void>(resolve => {
      buildMaskAsync(bc, fc, polyCanvasRef.current, setLoadProgress, (mask, fillData, basePixels) => {
        maskRef.current       = mask;
        fillDataRef.current   = fillData;
        basePixelsRef.current = basePixels;
        fillCountRef.current  = 0; groupCountRef.current = 0;
        snapshots.current     = []; fillPixelMaps.current.clear();
        setFills([]); setHiddenIds(new Set()); setSelectedId(null);
        setSelectedGroup(null); setHoveredId(null); setHolesClosedIds(new Set());
        setIsLassoing(false); setLassoPoints([]); setLassoMouse(null);
        resolve();
      });
    });

    setStatus(`Loaded · page 1/${doc.numPages} · ${bc.width}×${bc.height}px`);
  }, []);

  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    e.target.value = '';
    setFileName(file.name); setLoadStage('loading'); setLoadProgress('Starting…');
    setZoom(1); setPan({ x: 0, y: 0 });
    try {
      await loadPdf(file);
      setLoadStage('ready');
      centerCanvas();
    } catch (err) {
      setLoadStage('idle');
      setStatus(`Error: ${(err as Error).message}`);
    }
  }, [loadPdf, centerCanvas]);

  // ── Raster fill (single click) ─────────────────────────────────────────────
  const doRasterFill = useCallback(async (canvasX: number, canvasY: number) => {
    if (!maskRef.current || !fillDataRef.current || !basePixelsRef.current) return;
    const bc = baseCanvasRef.current!;
    snapshots.current.push(new ImageData(
      new Uint8ClampedArray(fillDataRef.current.data),
      fillDataRef.current.width, fillDataRef.current.height,
    ));

    setFillMsg('Flood filling region'); await yieldMacro();
    const filled = multiSeedFill(maskRef.current, bc.width, bc.height, canvasX, canvasY);
    if (!filled) {
      snapshots.current.pop();
      setIsFilling(false); setFillMsg('');
      setStatus('Clicked on a wall — try the room centre');
      return;
    }

    setFillMsg('Growing fill'); await yieldMacro();
    const grown = dilateMaskFast(filled, bc.width, bc.height, FILL_GROW);
    setFillMsg('Closing holes'); await yieldMacro();
    const closed = closeHoles(grown, bc.width, bc.height);
    setFillMsg('Painting'); await yieldMacro();

    const [r, g, b] = hexToRgb(activeColor);
    paintFill(closed, fillDataRef.current, r, g, b, fillOpacity / 100);
    fillCanvasRef.current!.getContext('2d')!.putImageData(fillDataRef.current, 0, 0);

    setFillMsg('Measuring'); await yieldMacro();
    const areaPx  = maskArea(closed);
    const polygon = buildPolygonFromMask(closed, bc.width, bc.height);
    const perimPx = polygonPerim(polygon);
    fillCountRef.current += 1;

    const newFill: Fill = {
      id: Date.now(), label: `Fill ${fillCountRef.current}`,
      color: activeColor, opacity: fillOpacity,
      areaPx, perimPx, polygon, svgMode: false,
    };
    fillPixelMaps.current.set(newFill.id, closed);
    setFills(prev => {
      const next = [...prev, newFill];
      setTimeout(() => redrawPolygons(next, hiddenIds, newFill.id, null), 0);
      return next;
    });
    setSelectedId(newFill.id); setSelectedGroup(null);
    setIsFilling(false); setFillMsg('');
    setStatus(`Raster fill · ${polygon.length} corners · area ${fmtArea(areaPx, pxPerM)} · perimeter ${fmtPerim(perimPx, pxPerM)}`);
    cycleColor();
  }, [activeColor, fillOpacity, pxPerM, hiddenIds, redrawPolygons, cycleColor]);

  const doFill = useCallback(async (clientX: number, clientY: number) => {
    if (mode !== 'fill' || isFilling || loadStage !== 'ready') return;
    if (spaceHeldRef.current || batchModeRef.current) return;
    const vp = viewportRef.current!;
    const vr = vp.getBoundingClientRect();
    const cx = Math.round((clientX - vr.left - pan.x) / zoom);
    const cy = Math.round((clientY - vr.top  - pan.y) / zoom);
    const bc = baseCanvasRef.current!;
    if (cx < 0 || cx >= bc.width || cy < 0 || cy >= bc.height) return;
    setIsFilling(true); setFillMsg('Computing fill'); setFillSub(undefined);
    setFillProgress(null); setSelectedGroup(null);
    await yieldFrame();
    await doRasterFill(cx, cy);
  }, [mode, isFilling, loadStage, pan, zoom, doRasterFill]);

  // ── Polygon lasso fill (off-thread) ───────────────────────────────────────
  const commitPolygonFill = useCallback(async (poly: [number, number][]) => {
    if (poly.length < 3 || !maskRef.current || !fillDataRef.current || !basePixelsRef.current || isFilling) return;

    const bc = baseCanvasRef.current!;
    const w = bc.width, h = bc.height;

    setIsLassoing(false);
    setLassoPoints([]);
    setLassoMouse(null);
    lassoPointsRef.current = [];

    setIsFilling(true);
    setFillMsg('Detecting regions in polygon');
    setFillSub('Running off main thread…');
    setFillProgress(null);

    snapshots.current.push(new ImageData(
      new Uint8ClampedArray(fillDataRef.current.data), w, h,
    ));

    await yieldFrame();

    workerRef.current?.terminate();
    if (workerUrlRef.current) URL.revokeObjectURL(workerUrlRef.current);

    const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
    const url  = URL.createObjectURL(blob);
    workerUrlRef.current = url;
    const worker = new Worker(url);
    workerRef.current = worker;

    const [r, g, b] = hexToRgb(activeColor);

    const maskCopy     = maskRef.current.slice().buffer;
    const fillDataCopy = fillDataRef.current.data.slice().buffer;

    worker.postMessage(
      {
        maskBuffer:     maskCopy,
        fillDataBuffer: fillDataCopy,
        w, h, r, g, b,
        opacity: fillOpacity / 100,
        FILL_GROW,
        poly,
      },
      [maskCopy, fillDataCopy],
    );

    worker.onmessage = ({ data: result }) => {
      worker.terminate();
      workerRef.current = null;
      URL.revokeObjectURL(url);
      workerUrlRef.current = null;

      if (result.empty) {
        snapshots.current.pop();
        setIsFilling(false); setFillMsg(''); setFillSub(undefined); setFillProgress(null);
        setStatus('No fillable regions found inside polygon');
        return;
      }

      if (result.error === 'leak') {
        snapshots.current.pop();
        setIsFilling(false); setFillMsg(''); setFillSub(undefined); setFillProgress(null);
        setStatus('Fill leaked — try a smaller polygon');
        return;
      }

      const { fillDataBuffer, closedBuffer, polygon, areaPx, perimPx, regionCount } = result;

      const painted = new Uint8ClampedArray(fillDataBuffer);
      fillDataRef.current!.data.set(painted);
      fillCanvasRef.current!.getContext('2d')!.putImageData(fillDataRef.current!, 0, 0);

      const closed = new Uint8Array(closedBuffer);

      groupCountRef.current += 1;
      const gId = groupCountRef.current;
      fillCountRef.current  += 1;

      const newFill: Fill = {
        id:      Date.now(),
        label:   `Fill ${fillCountRef.current}`,
        color:   activeColor,
        opacity: fillOpacity,
        areaPx,
        perimPx,
        polygon: polygon as [number, number][],
        groupId: gId,
        svgMode: false,
      };

      fillPixelMaps.current.set(newFill.id, closed);

      setFills(prev => {
        const next = [...prev, newFill];
        setTimeout(() => redrawPolygons(next, hiddenIds, null, gId), 0);
        return next;
      });

      setSelectedId(null);
      setSelectedGroup(gId);
      setIsFilling(false);
      setFillMsg('');
      setFillSub(undefined);
      setFillProgress(null);
      cycleColor();
      setStatus(
        `Polygon fill · ${regionCount} region${regionCount !== 1 ? 's' : ''} · ` +
        `area ${fmtArea(areaPx, pxPerM)} · perimeter ${fmtPerim(perimPx, pxPerM)}`,
      );
    };

    worker.onerror = (e) => {
      worker.terminate();
      workerRef.current = null;
      URL.revokeObjectURL(url);
      workerUrlRef.current = null;
      snapshots.current.pop();
      setIsFilling(false); setFillMsg(''); setFillSub(undefined); setFillProgress(null);
      setStatus(`Worker error: ${e.message}`);
    };

  }, [isFilling, activeColor, fillOpacity, pxPerM, hiddenIds, redrawPolygons, cycleColor]);

  // ── Pointer handlers ───────────────────────────────────────────────────────
  const handleContextMenu = useCallback((e: React.MouseEvent) => e.preventDefault(), []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const vp = e.currentTarget as HTMLElement;
    if (e.button !== 0 && e.button !== 2) return;

    if (e.button === 0 && loadStage === 'ready') {
      const now = Date.now();
      if (now - lastClickTime.current < 300) {
        const next = !batchModeRef.current;
        batchModeRef.current = next;
        setBatchMode(next);
        if (!next) {
          setIsLassoing(false);
          setLassoPoints([]);
          setLassoMouse(null);
          lassoPointsRef.current = [];
        }
        return;
      }
      lastClickTime.current = now;
    }

    if (e.button === 2) {
      e.preventDefault();
      hasDraggedRef.current = false;
      setIsDragging(true);
      dragRef.current = { mx: e.clientX, my: e.clientY, px: panRef.current.x, py: panRef.current.y };
      vp.setPointerCapture(e.pointerId);
      return;
    }

    if (e.button === 0 && (spaceHeldRef.current || batchModeRef.current) && loadStage === 'ready') {
      e.preventDefault();
      const { cx, cy } = screenToCanvas(e.clientX, e.clientY);
      const current = lassoPointsRef.current;

      if (current.length === 0) {
        const newPts: [number, number][] = [[cx, cy]];
        lassoPointsRef.current = newPts;
        setLassoPoints(newPts);
        setIsLassoing(true);
        vp.setPointerCapture(e.pointerId);
        return;
      }

      const [fx, fy] = current[0];
      const distScreen = Math.hypot(
        (cx - fx) * zoomRef.current,
        (cy - fy) * zoomRef.current,
      );
      if (distScreen < CLOSE_SNAP_RADIUS && current.length >= 3) {
        commitPolygonFill(current);
        return;
      }

      const newPts: [number, number][] = [...current, [cx, cy]];
      lassoPointsRef.current = newPts;
      setLassoPoints(newPts);
      vp.setPointerCapture(e.pointerId);
      return;
    }

    if (e.button === 0) {
      hasDraggedRef.current = false;
      setIsDragging(true);
      dragRef.current = { mx: e.clientX, my: e.clientY, px: panRef.current.x, py: panRef.current.y };
      vp.setPointerCapture(e.pointerId);
    }
  }, [loadStage, screenToCanvas, commitPolygonFill]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (isLassoing && lassoPointsRef.current.length > 0) {
      const { cx, cy } = screenToCanvas(e.clientX, e.clientY);
      setLassoMouse([cx, cy]);
    }

    if (isDragging) {
      const dx = e.clientX - dragRef.current.mx, dy = e.clientY - dragRef.current.my;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) hasDraggedRef.current = true;
      setPan({ x: dragRef.current.px + dx, y: dragRef.current.py + dy });
      return;
    }

    if (loadStage === 'ready' && mode === 'fill') {
      const vp = viewportRef.current!, vr = vp.getBoundingClientRect();
      const px = Math.round((e.clientX - vr.left - panRef.current.x) / zoomRef.current);
      const py = Math.round((e.clientY - vr.top  - panRef.current.y) / zoomRef.current);
      const bc = baseCanvasRef.current!;
      if (px < 0 || px >= bc.width || py < 0 || py >= bc.height) { setHoveredId(null); return; }
      const idx = py * bc.width + px;
      let found: number | null = null;
      const cf = fillsRef.current;
      for (let i = cf.length - 1; i >= 0; i--) {
        const map = fillPixelMaps.current.get(cf[i].id);
        if (map && map[idx]) { found = cf[i].id; break; }
      }
      setHoveredId(found);
      setHoverPos({ x: e.clientX - vr.left, y: e.clientY - vr.top });
    }
  }, [isDragging, isLassoing, loadStage, mode, screenToCanvas]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (isDragging) {
      const wasDragging = hasDraggedRef.current;
      setIsDragging(false);
      if (e.button === 0 && !wasDragging && !spaceHeldRef.current && !batchModeRef.current && !isLassoing && loadStage === 'ready')
        doFill(e.clientX, e.clientY);
    }
  }, [isDragging, isLassoing, loadStage, doFill]);

  // ── Wheel zoom ─────────────────────────────────────────────────────────────
  const wheelHandlerRef = useRef<(e: WheelEvent) => void>(() => {});
  useEffect(() => {
    wheelHandlerRef.current = (e: WheelEvent) => {
      e.preventDefault();
      const vp = viewportRef.current; if (!vp) return;
      const vr = vp.getBoundingClientRect();
      if (e.ctrlKey) {
        const mx = e.clientX - vr.left, my = e.clientY - vr.top;
        const f  = e.deltaY > 0 ? 0.92 : 1.08;
        setZoom(z => {
          const nz = Math.min(20, Math.max(0.05, z * f));
          setPan(p => ({ x: mx - (mx - p.x) * (nz / z), y: my - (my - p.y) * (nz / z) }));
          return nz;
        });
        return;
      }
      setPan(p => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
    };
  });
  useEffect(() => {
    const vp = viewportRef.current; if (!vp) return;
    const h = (e: WheelEvent) => wheelHandlerRef.current(e);
    vp.addEventListener('wheel', h, { passive: false });
    return () => vp.removeEventListener('wheel', h);
  }, []);

  // ── Undo ───────────────────────────────────────────────────────────────────
  const handleUndo = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    if (workerUrlRef.current) { URL.revokeObjectURL(workerUrlRef.current); workerUrlRef.current = null; }
    setIsFilling(false); setFillMsg(''); setFillSub(undefined); setFillProgress(null);
    setIsLassoing(false); setLassoPoints([]); setLassoMouse(null); lassoPointsRef.current = [];

    setFills(f => {
      if (f.length === 0) return f;
      const last = f[f.length - 1];
      let next: Fill[];
      if (last.groupId != null) {
        const gid = last.groupId;
        f.filter(x => x.groupId === gid).forEach(x => fillPixelMaps.current.delete(x.id));
        next = f.filter(x => x.groupId !== gid);
      } else {
        fillPixelMaps.current.delete(last.id);
        next = f.slice(0, -1);
      }
      if (!last.svgMode && snapshots.current.length > 0 && fillDataRef.current) {
        const prev = snapshots.current.pop()!;
        fillDataRef.current.data.set(prev.data);
        fillCanvasRef.current!.getContext('2d')!.putImageData(fillDataRef.current, 0, 0);
      }
      const newSelected = next.length ? next[next.length - 1].id : null;
      setSelectedId(newSelected); setSelectedGroup(null);
      setTimeout(() => redrawPolygons(next, hiddenIds, newSelected, null), 0);
      return next;
    });
    setHoveredId(null); setStatus('Undo');
  }, [hiddenIds, redrawPolygons]);

  // ── Clear all ──────────────────────────────────────────────────────────────
  const handleClearAll = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    if (workerUrlRef.current) { URL.revokeObjectURL(workerUrlRef.current); workerUrlRef.current = null; }
    if (fillDataRef.current) {
      fillDataRef.current.data.fill(0);
      fillCanvasRef.current!.getContext('2d')!.clearRect(
        0, 0, fillCanvasRef.current!.width, fillCanvasRef.current!.height,
      );
    }
    const pc = polyCanvasRef.current;
    if (pc) pc.getContext('2d')!.clearRect(0, 0, pc.width, pc.height);
    snapshots.current = []; fillCountRef.current = 0; groupCountRef.current = 0;
    fillPixelMaps.current.clear();
    setFills([]); setHiddenIds(new Set()); setSelectedId(null); setSelectedGroup(null);
    setHoveredId(null); setHolesClosedIds(new Set()); setStatus('Cleared');
    setIsFilling(false); setFillMsg(''); setFillSub(undefined); setFillProgress(null);
    setActiveColorIdx(0);
    setIsLassoing(false); setLassoPoints([]); setLassoMouse(null); lassoPointsRef.current = [];
  }, []);

  // ── Fill holes ─────────────────────────────────────────────────────────────
  const closeFillHoles = useCallback(async (fId: number) => {
    const fill = fillsRef.current.find(f => f.id === fId);
    if (!fill || fill.svgMode || !fillDataRef.current || !basePixelsRef.current) return null;
    const pixMap = fillPixelMaps.current.get(fId);
    if (!pixMap) return null;
    const bc = baseCanvasRef.current!;
    const w = bc.width, h = bc.height;
    const closed = closeHoles(pixMap, w, h);
    const added  = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) if (closed[i] && !pixMap[i]) added[i] = 1;
    const [r, g, b] = hexToRgb(fill.color);
    paintFill(added, fillDataRef.current, r, g, b, fill.opacity / 100);
    const areaPx  = maskArea(closed);
    const polygon = buildPolygonFromMask(closed, w, h);
    const perimPx = polygonPerim(polygon);
    fillPixelMaps.current.set(fId, closed);
    return { areaPx, perimPx, polygon };
  }, []);

  const handleFillHoles = useCallback(async () => {
    if (!selectedId && selectedGroup == null) return;
    if (!fillDataRef.current || !basePixelsRef.current) return;
    const bc = baseCanvasRef.current!;
    setIsFilling(true); setFillMsg('Closing holes'); setFillSub(undefined); setFillProgress(null);
    await yieldFrame();
    snapshots.current.push(new ImageData(new Uint8ClampedArray(fillDataRef.current.data), bc.width, bc.height));

    const targetIds = selectedGroup != null
      ? fillsRef.current.filter(f => f.groupId === selectedGroup && !f.svgMode).map(f => f.id)
      : (selectedId != null ? [selectedId] : []).filter(
          id => !fillsRef.current.find(f => f.id === id)?.svgMode,
        );
    if (targetIds.length === 0) {
      snapshots.current.pop(); setIsFilling(false); setFillMsg(''); return;
    }
    if (targetIds.length > 1) setFillProgress({ done: 0, total: targetIds.length });

    const updates: Record<number, { areaPx: number; perimPx: number; polygon: [number, number][] }> = {};
    for (let i = 0; i < targetIds.length; i++) {
      if (targetIds.length > 1) { setFillProgress({ done: i, total: targetIds.length }); await yieldFrame(); }
      const res = await closeFillHoles(targetIds[i]);
      if (res) updates[targetIds[i]] = res;
    }

    fillCanvasRef.current!.getContext('2d')!.putImageData(fillDataRef.current, 0, 0);
    setFills(prev => {
      const next = prev.map(f => updates[f.id] ? { ...f, ...updates[f.id] } : f);
      setTimeout(() => redrawPolygons(next, hiddenIds, selectedId, selectedGroup), 0);
      return next;
    });
    setHolesClosedIds(prev => { const s = new Set(prev); targetIds.forEach(id => s.add(id)); return s; });
    setIsFilling(false); setFillMsg(''); setFillProgress(null);
    setStatus(targetIds.length > 1 ? `Holes closed on ${targetIds.length} regions` : 'Holes closed');
  }, [selectedId, selectedGroup, closeFillHoles, hiddenIds, redrawPolygons]);

  // ── Export PNG ─────────────────────────────────────────────────────────────
  const handleExport = useCallback(() => {
    const bc = baseCanvasRef.current, fc = fillCanvasRef.current, pc = polyCanvasRef.current;
    if (!bc || !fc) return;
    const out = document.createElement('canvas');
    out.width = bc.width; out.height = bc.height;
    const ctx = out.getContext('2d')!;
    ctx.drawImage(bc, 0, 0);
    ctx.drawImage(fc, 0, 0);
    if (pc && showPolygon) ctx.drawImage(pc, 0, 0);
    out.toBlob(bl => {
      if (!bl) return;
      const u = URL.createObjectURL(bl);
      Object.assign(document.createElement('a'), {
        href: u, download: (fileName || 'floodfill') + '_filled.png',
      }).click();
      URL.revokeObjectURL(u);
    }, 'image/png');
  }, [fileName, showPolygon]);

  // ── Delete / toggle hidden ─────────────────────────────────────────────────
  const handleDeleteFill = useCallback((fId: number) => {
    fillPixelMaps.current.delete(fId);
    setFills(prev => {
      const next = prev.filter(x => x.id !== fId);
      setTimeout(() => redrawPolygons(next, hiddenIds, selectedId, selectedGroup), 0);
      return next;
    });
    if (selectedId === fId) setSelectedId(null);
    if (hoveredId  === fId) setHoveredId(null);
  }, [hiddenIds, selectedId, selectedGroup, hoveredId, redrawPolygons]);

  const toggleHidden = useCallback((fId: number) => {
    setHiddenIds(prev => { const s = new Set(prev); s.has(fId) ? s.delete(fId) : s.add(fId); return s; });
  }, []);

  // ── Derived ────────────────────────────────────────────────────────────────
  const selectedFill = fills.find(f => f.id === selectedId) ?? null;
  const hoveredFill  = fills.find(f => f.id === hoveredId)  ?? null;
  const groupFills   = selectedGroup != null ? fills.filter(f => f.groupId === selectedGroup) : [];
  const hasSelection = selectedId != null || selectedGroup != null;
  const cursor = isLassoing ? 'crosshair'
    : batchMode ? 'crosshair'
    : spaceHeld ? 'crosshair'
    : isDragging ? 'grabbing'
    : isFilling  ? 'wait'
    : 'crosshair';

  return {
    activeColor, setActiveColor, activeColorIdx,
    fillOpacity, setFillOpacity,
    zoom, setZoom, pan, setPan,
    mode, setMode,
    isDragging, isFilling,
    fillMsg, fillSub, fillProgress,
    fills, setFills,
    hiddenIds,
    selectedId, setSelectedId,
    selectedGroup, setSelectedGroup,
    hoveredId, setHoveredId, hoverPos,
    holesClosedIds, setHolesClosedIds,
    showPolygon, setShowPolygon,
    status, fileName, loadStage, loadProgress,
    pxPerM, setPxPerM,
    lassoPoints, isLassoing, lassoMouse,
    selectRect: null,
    isSelecting: isLassoing,
    spaceHeld,
    batchMode, setBatchMode, batchModeRef,
    selectedFill, hoveredFill, groupFills, hasSelection, cursor,
    viewportRef, wrapRef, baseCanvasRef, fillCanvasRef, polyCanvasRef,
    fileInputRef, fillPixelMaps, fillDataRef,
    handleUpload, handleUndo, handleClearAll, handleFillHoles,
    handleExport,
    handleDeleteFill, toggleHidden,
    handleContextMenu, handlePointerDown, handlePointerMove, handlePointerUp,
    centerCanvas, closeFillHoles, redrawPolygons, doFill,
  };
}
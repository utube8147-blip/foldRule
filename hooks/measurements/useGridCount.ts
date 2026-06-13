// ─── hooks/useGridCount.ts ────────────────────────────────────────────────────
//
//  Encapsulates all polygon + tile-counting logic so it can be reused by any
//  overlay that needs to count tiles inside a user-drawn polygon.
//
//  The hook owns:
//    • vertex state (add, clear, close, snap-to-close)
//    • shape + spacingMm state
//    • derived spacingPx (mm → canvas px via scaleFactor)
//    • result computation (re-runs whenever vertices / spacing / shape change)
//
//  The hook does NOT own:
//    • mousePos / preview cursor (purely a draw concern — stays in the component)
//    • canvas refs, draw calls, or any DOM interaction
//    • panel layout / JSX
//
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
// Stub types for missing module - include all supported tile shapes
type TileShape = 'square' | 'rectangle' | 'hexagon' | 'hex-flat' | 'hex-pointy' | 'triangle' | 'diamond';
type Point = { x: number; y: number };
type ResultData = any;
const MIN_VERTICES = 3;
const SNAP_RADIUS_PX = 10;

// ─── Internal geometry helpers ────────────────────────────────────────────────

export function pointInPolygon(px: number, py: number, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > py) !== (yj > py)) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

export function polyBounds(poly: Point[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function triH(s: number) { return (Math.sqrt(3) / 2) * s; }

// ─── Count algorithms ─────────────────────────────────────────────────────────

function countSquare(poly: Point[], s: number): ResultData {
  const { minX, minY, maxX, maxY } = polyBounds(poly);
  let count = 0;
  for (let x = Math.floor(minX / s) * s; x <= maxX + s; x += s)
    for (let y = Math.floor(minY / s) * s; y <= maxY + s; y += s)
      if (pointInPolygon(x, y, poly)) count++;
  return { count, label: 'intersections' };
}

function countHexFlat(poly: Point[], s: number): ResultData {
  const { minX, minY, maxX, maxY } = polyBounds(poly);
  const r = s / 2, h = Math.sqrt(3) * r, colP = s * 0.75;
  let count = 0;
  for (let c = Math.floor((minX - s) / colP); c * colP < maxX + s; c++) {
    const cx = c * colP + r, yo = (c % 2 === 0) ? 0 : h / 2;
    for (let row = Math.floor((minY - h + yo) / h); row * h + yo < maxY + h; row++)
      if (pointInPolygon(cx, row * h + yo + h / 2, poly)) count++;
  }
  return { count, label: 'hexagons' };
}

function countHexPointy(poly: Point[], s: number): ResultData {
  const { minX, minY, maxX, maxY } = polyBounds(poly);
  const r = s / Math.sqrt(3), w = Math.sqrt(3) * r, h = 2 * r, rowP = h * 0.75;
  let count = 0;
  for (let row = Math.floor((minY - h) / rowP); row * rowP < maxY + h; row++) {
    const cy = row * rowP + h / 2, xo = (row % 2 === 0) ? 0 : w / 2;
    for (let c = Math.floor((minX - w + xo) / w); c * w + xo < maxX + w; c++)
      if (pointInPolygon(c * w + xo + w / 2, cy, poly)) count++;
  }
  return { count, label: 'hexagons' };
}

function countTriangle(poly: Point[], s: number): ResultData {
  const { minX, minY, maxX, maxY } = polyBounds(poly);
  const rh = triH(s);
  let count = 0;
  for (let row = Math.floor((minY - rh) / rh); row * rh < maxY + rh; row++) {
    const y0 = row * rh;
    for (let c = Math.floor((minX - s) / s) * 2; c < Math.ceil((maxX + s) / (s / 2)); c++) {
      const up = (c % 2 === 0);
      const x0 = Math.floor(c / 2) * s + (up ? 0 : s / 2);
      const cx = x0 + s / 2, cy = up ? y0 + (rh * 2) / 3 : y0 + rh / 3;
      if (pointInPolygon(cx, cy, poly)) count++;
    }
  }
  return { count, label: 'triangles' };
}

function countDiamond(poly: Point[], s: number): ResultData {
  const { minX, minY, maxX, maxY } = polyBounds(poly);
  const h = s / 2;
  let count = 0;
  for (let row = Math.floor((minY - s) / h); row * h < maxY + s; row++)
    for (let c = Math.floor((minX - s) / h); c * h < maxX + s; c++)
      if ((row + c) % 2 === 0 && pointInPolygon(c * h, row * h, poly)) count++;
  return { count, label: 'diamonds' };
}

export function computeResult(shape: TileShape, poly: Point[], sPx: number): ResultData | null {
  if (sPx <= 0 || poly.length < MIN_VERTICES) return null;
  switch (shape) {
    case 'square':     return countSquare(poly, sPx);
    case 'hex-flat':   return countHexFlat(poly, sPx);
    case 'hex-pointy': return countHexPointy(poly, sPx);
    case 'triangle':   return countTriangle(poly, sPx);
    case 'diamond':    return countDiamond(poly, sPx);
  }
}

// ─── Spacing normalisation ────────────────────────────────────────────────────

export function clampSpacing(raw: string): number {
  const v = parseFloat(raw);
  if (isNaN(v) || v <= 0) return 600;
  return Math.min(50000, Math.max(10, Math.round(v)));
}

// ─── Hook types ───────────────────────────────────────────────────────────────

export interface UseGridCountOptions {
  /** metres-per-pixel scale factor from calibration; 1 = uncalibrated */
  scaleFactor:   number;
  /** whether the parent overlay is active — resets state when false */
  active:        boolean;
}

export interface GridCountState {
  // Data
  vertices:     Point[];
  closed:       boolean;
  isPolyClosed: boolean;
  result:       ResultData | null;
  spacingPx:    number;          // derived, for use in draw calls

  // Settings (controlled by the UI)
  shape:        TileShape;
  spacingMm:    string;

  // The first vertex, exposed as a snap target when polygon is open and has ≥ MIN_VERTICES points
  snapTarget:   Point | null;

  // Actions
  addVertex:    (pt: Point) => void;
  forceClose:   () => void;
  clear:        () => void;
  setShape:     (s: TileShape) => void;
  setSpacingMm: (v: string) => void;
  commitSpacing: () => void;      // normalises on blur
  stepSpacing:  (delta: number) => void;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useGridCount({ scaleFactor, active }: UseGridCountOptions): GridCountState {
  const [vertices,   setVertices]   = useState<Point[]>([]);
  const [closed,     setClosed]     = useState(false);
  const [shape,      setShape]      = useState<TileShape>('square');
  const [spacingMm,  setSpacingMm]  = useState<string>('600');
  const [result,     setResult]     = useState<ResultData | null>(null);

  const isPolyClosed = closed && vertices.length >= MIN_VERTICES;

  // Derived spacingPx — used by draw calls and result computation
  const spacingPx = (() => {
    const smm = clampSpacing(spacingMm);
    const sf  = scaleFactor > 0 ? scaleFactor : 1;
    return (smm / 1000) / sf;
  })();

  // Reset everything when the overlay is deactivated
  useEffect(() => {
    if (!active) {
      setVertices([]);
      setClosed(false);
      setResult(null);
    }
  }, [active]);

  // Recompute tile count whenever polygon, spacing, or shape changes
  useEffect(() => {
    if (!isPolyClosed) { setResult(null); return; }
    setResult(computeResult(shape, vertices, spacingPx));
  }, [vertices, closed, spacingMm, scaleFactor, shape]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Actions ────────────────────────────────────────────────────────────────

  const addVertex = useCallback((pt: Point) => {
    if (closed) return;
    // Snap-to-close: clicking near the first vertex closes the polygon
    if (vertices.length >= MIN_VERTICES) {
      if (Math.hypot(pt.x - vertices[0].x, pt.y - vertices[0].y) < SNAP_RADIUS_PX) {
        setClosed(true);
        return;
      }
    }
    setVertices(prev => [...prev, pt]);
  }, [closed, vertices]);

  const forceClose = useCallback(() => {
    if (vertices.length >= MIN_VERTICES) setClosed(true);
  }, [vertices.length]);

  const clear = useCallback(() => {
    setVertices([]);
    setClosed(false);
    setResult(null);
  }, []);

  const commitSpacing = useCallback(() => {
    setSpacingMm(String(clampSpacing(spacingMm)));
  }, [spacingMm]);

  const stepSpacing = useCallback((delta: number) => {
    setSpacingMm(String(Math.max(10, Math.round(clampSpacing(spacingMm) + delta))));
  }, [spacingMm]);

  const snapTarget = !closed && vertices.length >= MIN_VERTICES ? vertices[0] : null;

  return {
    vertices,
    closed,
    isPolyClosed,
    result,
    spacingPx,
    shape,
    spacingMm,
    snapTarget,
    addVertex,
    forceClose,
    clear,
    setShape,
    setSpacingMm,
    commitSpacing,
    stepSpacing,
  };
}

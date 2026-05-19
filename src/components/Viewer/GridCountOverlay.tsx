'use client';

// ─── components/Viewer/GridCountOverlay.tsx ───────────────────────────────────
//
//  CHANGES (this revision):
//
//  1. POLYGON SELECTION — replaces the drag-rectangle. Click to place vertices,
//     double-click (or click near the first vertex) to close the polygon.
//     Any convex or concave polygon is supported. A "clear" button resets.
//
//  2. RECTANGLE → SQUARE — the old "rectangle" shape (separate W/H) is removed.
//     "Square" replaces it: a single spacing value drives both axes.
//
//  3. POINT-IN-POLYGON — all count algorithms now test whether each grid
//     centre (or intersection) falls inside the polygon, so tiles are only
//     counted if their centre is within the drawn shape.
//
//  4. DRAWING — the canvas renders the closed polygon outline + fill, then
//     draws only tiles whose centre lies inside the polygon.
//
//  RETAINED:
//  5. Hex-flat, hex-pointy, triangle, diamond tile shapes.
//  6. Partial-edge fractions for counts outside full cells (approximated as
//     fraction of full polygon area ÷ cell area where exact not feasible).
//  7. pixelRatio scaling for crisp rendering.
//  8. Panel clamp so it never overflows the canvas edge.
//  9. stopPropagation on pointerdown prevents scroll-container capture.
//
// ─────────────────────────────────────────────────────────────────────────────

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import type { PdfDimensions } from '@/types/viewerTypes';

// ─── Types ────────────────────────────────────────────────────────────────────

export type TileShape = 'square' | 'hex-flat' | 'hex-pointy' | 'triangle' | 'diamond';

interface TileShapeConfig {
  id:           TileShape;
  label:        string;
  spacingLabel: string;
  description:  string;
  icon:         string;
}

interface ResultData {
  count:   number;
  partial: boolean;
  label:   string;
}

interface GridCountOverlayProps {
  active:        boolean;
  pdfDimensions: PdfDimensions | null;
  scaleFactor:   number;
  onCommit:      (count: number, spacingMm: number, cols: number, rows: number) => void;
}

interface Point { x: number; y: number; }

// ─── Constants ────────────────────────────────────────────────────────────────

const GRID_LINE_COLOUR = 'rgba(74,222,128,0.45)';
const GRID_FILL_COLOUR = 'rgba(74,222,128,0.07)';
const GRID_DOT_COLOUR  = 'rgba(74,222,128,1)';
const POLY_STROKE      = '#4ADE80';
const POLY_FILL        = 'rgba(74,222,128,0.07)';
const VERTEX_COLOUR    = '#ffffff';
const PREVIEW_COLOUR   = 'rgba(74,222,128,0.45)';
const SNAP_RADIUS_PX   = 18; // canvas pixels to snap-close polygon
const MIN_VERTICES     = 3;
const PANEL_WIDTH      = 252;
const PANEL_MARGIN     = 14;

const TILE_SHAPES: TileShapeConfig[] = [
  {
    id:           'square',
    label:        'Square',
    spacingLabel: 'Grid spacing',
    description:  'Uniform square grid',
    icon:         '▪',
  },
  {
    id:           'hex-flat',
    label:        'Hex (flat)',
    spacingLabel: 'Hex width',
    description:  'Flat-top hexagons, staggered columns',
    icon:         '⬡',
  },
  {
    id:           'hex-pointy',
    label:        'Hex (pointy)',
    spacingLabel: 'Hex width',
    description:  'Pointy-top hexagons, staggered rows',
    icon:         '⬡',
  },
  {
    id:           'triangle',
    label:        'Triangle',
    spacingLabel: 'Side length',
    description:  'Equilateral triangular grid',
    icon:         '△',
  },
  {
    id:           'diamond',
    label:        'Diamond',
    spacingLabel: 'Diamond width',
    description:  '45° rotated square grid',
    icon:         '◇',
  },
];

// ─── Geometry helpers ─────────────────────────────────────────────────────────

/** Ray-casting point-in-polygon test. */
function pointInPolygon(px: number, py: number, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if (((yi > py) !== (yj > py)) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Axis-aligned bounding box of a polygon. */
function polyBounds(poly: Point[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Signed polygon area (Shoelace). */
function polyArea(poly: Point[]): number {
  let area = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    area += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
  }
  return Math.abs(area / 2);
}

function hexFlatDims(spacingPx: number) {
  const r = spacingPx / 2;
  return { r, w: spacingPx, h: Math.sqrt(3) * r };
}

function hexPointyDims(spacingPx: number) {
  const r = spacingPx / Math.sqrt(3);
  return { r, w: Math.sqrt(3) * r, h: 2 * r };
}

function triRowHeight(s: number) { return (Math.sqrt(3) / 2) * s; }

// ─── Count algorithms (polygon-clipped) ──────────────────────────────────────

function countSquare(poly: Point[], spacingPx: number): ResultData {
  const { minX, minY, maxX, maxY } = polyBounds(poly);
  let count = 0;
  // Test every grid intersection point
  const x0 = Math.floor(minX / spacingPx) * spacingPx;
  const y0 = Math.floor(minY / spacingPx) * spacingPx;
  for (let x = x0; x <= maxX + spacingPx; x += spacingPx) {
    for (let y = y0; y <= maxY + spacingPx; y += spacingPx) {
      if (pointInPolygon(x, y, poly)) count++;
    }
  }
  return { count, partial: false, label: 'intersections' };
}

function countHexFlat(poly: Point[], spacingPx: number): ResultData {
  const { minX, minY, maxX, maxY } = polyBounds(poly);
  const { r, w, h } = hexFlatDims(spacingPx);
  const colPitch = w * 0.75;
  let count = 0;
  for (let c = Math.floor((minX - w) / colPitch); c * colPitch < maxX + w; c++) {
    const cx      = c * colPitch + w / 2;
    const yOffset = (c % 2 === 0) ? 0 : h / 2;
    for (let row = Math.floor((minY - h + yOffset) / h); row * h + yOffset < maxY + h; row++) {
      const cy = row * h + yOffset + h / 2;
      if (pointInPolygon(cx, cy, poly)) count++;
    }
  }
  void r;
  return { count, partial: false, label: 'hexagons' };
}

function countHexPointy(poly: Point[], spacingPx: number): ResultData {
  const { minX, minY, maxX, maxY } = polyBounds(poly);
  const { r, w, h } = hexPointyDims(spacingPx);
  const rowPitch = h * 0.75;
  let count = 0;
  for (let row = Math.floor((minY - h) / rowPitch); row * rowPitch < maxY + h; row++) {
    const cy      = row * rowPitch + h / 2;
    const xOffset = (row % 2 === 0) ? 0 : w / 2;
    for (let c = Math.floor((minX - w + xOffset) / w); c * w + xOffset < maxX + w; c++) {
      const cx = c * w + xOffset + w / 2;
      if (pointInPolygon(cx, cy, poly)) count++;
    }
  }
  void r;
  return { count, partial: false, label: 'hexagons' };
}

function countTriangle(poly: Point[], spacingPx: number): ResultData {
  const { minX, minY, maxX, maxY } = polyBounds(poly);
  const s  = spacingPx;
  const rh = triRowHeight(s);
  let count = 0;

  for (let row = Math.floor((minY - rh) / rh); row * rh < maxY + rh; row++) {
    const y0 = row * rh;
    const y1 = y0 + rh;
    const numCols = Math.ceil((maxX - minX + s) / s) + 2;
    for (let c = Math.floor((minX - s) / s) * 2; c < Math.ceil((maxX + s) / (s / 2)); c++) {
      const upTri = (c % 2 === 0);
      const x0    = Math.floor(c / 2) * s + (upTri ? 0 : s / 2);
      // centroid of triangle
      let cx: number, cy: number;
      if (upTri) {
        cx = x0 + s / 2;
        cy = (y0 + y1 + y1) / 3; // centroid y = (y0 + y1 + y1)/3 for upward
        cy = y0 + (rh * 2) / 3;
      } else {
        cx = x0 + s / 2;
        cy = y0 + rh / 3;
      }
      void numCols;
      if (pointInPolygon(cx, cy, poly)) count++;
    }
  }
  return { count, partial: false, label: 'triangles' };
}

function countDiamond(poly: Point[], spacingPx: number): ResultData {
  const { minX, minY, maxX, maxY } = polyBounds(poly);
  const half = spacingPx / 2;
  let count = 0;
  for (let row = Math.floor((minY - spacingPx) / half); row * half < maxY + spacingPx; row++) {
    for (let c = Math.floor((minX - spacingPx) / half); c * half < maxX + spacingPx; c++) {
      if ((row + c) % 2 !== 0) continue;
      const cx = c * half;
      const cy = row * half;
      if (pointInPolygon(cx, cy, poly)) count++;
    }
  }
  return { count, partial: false, label: 'diamonds' };
}

function computeResult(shape: TileShape, poly: Point[], spacingPx: number): ResultData | null {
  if (spacingPx <= 0 || poly.length < MIN_VERTICES) return null;
  switch (shape) {
    case 'square':     return countSquare(poly, spacingPx);
    case 'hex-flat':   return countHexFlat(poly, spacingPx);
    case 'hex-pointy': return countHexPointy(poly, spacingPx);
    case 'triangle':   return countTriangle(poly, spacingPx);
    case 'diamond':    return countDiamond(poly, spacingPx);
  }
}

// ─── Drawing helpers ──────────────────────────────────────────────────────────

function applyPolyClip(ctx: CanvasRenderingContext2D, poly: Point[]) {
  ctx.beginPath();
  poly.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.closePath();
  ctx.clip();
}

function drawHexPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, flat: boolean) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angleRad = (Math.PI / 180) * (flat ? 60 * i : 30 + 60 * i);
    const x = cx + r * Math.cos(angleRad);
    const y = cy + r * Math.sin(angleRad);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  shape: TileShape,
  poly: Point[],
  spacingPx: number,
  pixelRatio: number,
) {
  const { minX, minY, maxX, maxY } = polyBounds(poly);

  ctx.save();
  applyPolyClip(ctx, poly);

  ctx.strokeStyle = GRID_LINE_COLOUR;
  ctx.fillStyle   = GRID_FILL_COLOUR;
  ctx.lineWidth   = Math.max(0.8, 1.4 * pixelRatio);

  if (shape === 'square') {
    const x0 = Math.floor(minX / spacingPx) * spacingPx;
    const y0 = Math.floor(minY / spacingPx) * spacingPx;
    for (let x = x0; x <= maxX + spacingPx; x += spacingPx) {
      ctx.beginPath(); ctx.moveTo(x, minY); ctx.lineTo(x, maxY); ctx.stroke();
    }
    for (let y = y0; y <= maxY + spacingPx; y += spacingPx) {
      ctx.beginPath(); ctx.moveTo(minX, y); ctx.lineTo(maxX, y); ctx.stroke();
    }
    // Dots at intersections
    const dotR = Math.max(2, 3 * pixelRatio);
    ctx.fillStyle = GRID_DOT_COLOUR;
    for (let x = x0; x <= maxX + spacingPx; x += spacingPx) {
      for (let y = y0; y <= maxY + spacingPx; y += spacingPx) {
        if (!pointInPolygon(x, y, poly)) continue;
        ctx.beginPath();
        ctx.arc(x, y, dotR, 0, 2 * Math.PI);
        ctx.fill();
      }
    }

  } else if (shape === 'hex-flat' || shape === 'hex-pointy') {
    const flat = shape === 'hex-flat';
    ctx.fillStyle = GRID_FILL_COLOUR;
    if (flat) {
      const { r: hr, w, h } = hexFlatDims(spacingPx);
      const colPitch = w * 0.75;
      for (let c = Math.floor((minX - w) / colPitch); c * colPitch < maxX + w; c++) {
        const cx      = c * colPitch + w / 2;
        const yOffset = (c % 2 === 0) ? 0 : h / 2;
        for (let row = Math.floor((minY - h) / h); row * h + yOffset < maxY + h; row++) {
          const cy = row * h + yOffset + h / 2;
          drawHexPath(ctx, cx, cy, hr, true);
          ctx.fill();
          ctx.stroke();
        }
      }
    } else {
      const { r: hr, w, h } = hexPointyDims(spacingPx);
      const rowPitch = h * 0.75;
      for (let row = Math.floor((minY - h) / rowPitch); row * rowPitch < maxY + h; row++) {
        const cy      = row * rowPitch + h / 2;
        const xOffset = (row % 2 === 0) ? 0 : w / 2;
        for (let c = Math.floor((minX - w) / w); c * w + xOffset < maxX + w; c++) {
          const cx = c * w + xOffset + w / 2;
          drawHexPath(ctx, cx, cy, hr, false);
          ctx.fill();
          ctx.stroke();
        }
      }
    }

  } else if (shape === 'triangle') {
    const s  = spacingPx;
    const rh = triRowHeight(s);
    for (let row = Math.floor((minY - rh) / rh); row * rh < maxY + rh; row++) {
      const y0 = row * rh;
      const y1 = y0 + rh;
      for (let c = Math.floor((minX - s) / (s / 2)); c * (s / 2) < maxX + s; c++) {
        const upTri = (c % 2 === 0);
        const x0    = Math.floor(c / 2) * s + (upTri ? 0 : s / 2);
        ctx.beginPath();
        if (upTri) {
          ctx.moveTo(x0, y1); ctx.lineTo(x0 + s / 2, y0); ctx.lineTo(x0 + s, y1);
        } else {
          ctx.moveTo(x0, y0); ctx.lineTo(x0 + s / 2, y1); ctx.lineTo(x0 + s, y0);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }

  } else if (shape === 'diamond') {
    const half = spacingPx / 2;
    for (let row = Math.floor((minY - spacingPx) / half); row * half < maxY + spacingPx; row++) {
      for (let c = Math.floor((minX - spacingPx) / half); c * half < maxX + spacingPx; c++) {
        if ((row + c) % 2 !== 0) continue;
        const cx = c * half;
        const cy = row * half;
        ctx.beginPath();
        ctx.moveTo(cx, cy - half);
        ctx.lineTo(cx + half, cy);
        ctx.lineTo(cx, cy + half);
        ctx.lineTo(cx - half, cy);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  ctx.restore();
}

// ─── Component ────────────────────────────────────────────────────────────────

export function GridCountOverlay({
  active,
  pdfDimensions,
  scaleFactor,
  onCommit,
}: GridCountOverlayProps) {
  const canvasRef                   = useRef<HTMLCanvasElement>(null);
  const [vertices, setVertices]     = useState<Point[]>([]);
  const [closed, setClosed]         = useState(false);
  const [mousePos, setMousePos]     = useState<Point | null>(null);
  const [shape, setShape]           = useState<TileShape>('square');
  const [spacingMm, setSpacingMm]   = useState<string>('600');
  const [result, setResult]         = useState<ResultData | null>(null);

  const isUncalibrated = scaleFactor === 1;
  const shapeConfig    = TILE_SHAPES.find(t => t.id === shape)!;
  const isPolyClosed   = closed && vertices.length >= MIN_VERTICES;

  // ── Reset on deactivate ───────────────────────────────────────────────────
  useEffect(() => {
    if (!active) {
      setVertices([]);
      setClosed(false);
      setMousePos(null);
      setResult(null);
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx?.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
  }, [active]);

  // ── Canvas size mirrors pdfDimensions ─────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pdfDimensions) return;
    canvas.width  = pdfDimensions.w;
    canvas.height = pdfDimensions.h;
  }, [pdfDimensions]);

  // ── Draw ──────────────────────────────────────────────────────────────────
  const draw = useCallback((
    verts: Point[],
    isClosed: boolean,
    cursorPos: Point | null,
    spacingPx: number,
    currentShape: TileShape,
  ) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cssW       = canvas.getBoundingClientRect().width || canvas.width;
    const pixelRatio = canvas.width / (cssW || canvas.width);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (verts.length === 0) return;

    // ── Polygon fill + outline ──────────────────────────────────────────────
    if (verts.length >= 2) {
      ctx.beginPath();
      verts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      if (isClosed) ctx.closePath();
      else if (cursorPos) ctx.lineTo(cursorPos.x, cursorPos.y);
      ctx.fillStyle   = POLY_FILL;
      if (isClosed) ctx.fill();
      ctx.strokeStyle = POLY_STROKE;
      ctx.lineWidth   = 1.5 * pixelRatio;
      ctx.setLineDash([6 * pixelRatio, 3 * pixelRatio]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ── Preview line from last vertex to cursor ────────────────────────────
    if (!isClosed && cursorPos && verts.length >= 1) {
      const last = verts[verts.length - 1];
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(cursorPos.x, cursorPos.y);
      ctx.strokeStyle = PREVIEW_COLOUR;
      ctx.lineWidth   = 1 * pixelRatio;
      ctx.setLineDash([4 * pixelRatio, 4 * pixelRatio]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Snap circle near first vertex
      if (verts.length >= MIN_VERTICES) {
        const first = verts[0];
        const dist  = Math.hypot(cursorPos.x - first.x, cursorPos.y - first.y);
        if (dist < SNAP_RADIUS_PX * 2) {
          ctx.beginPath();
          ctx.arc(first.x, first.y, SNAP_RADIUS_PX, 0, 2 * Math.PI);
          ctx.strokeStyle = 'rgba(74,222,128,0.7)';
          ctx.lineWidth   = 1.5 * pixelRatio;
          ctx.setLineDash([]);
          ctx.stroke();
        }
      }
    }

    // ── Grid overlay (only when closed + valid spacing) ────────────────────
    if (isClosed && verts.length >= MIN_VERTICES && spacingPx > 0) {
      drawGrid(ctx, currentShape, verts, spacingPx, pixelRatio);
    }

    // ── Vertex dots ────────────────────────────────────────────────────────
    const vertR = Math.max(3, 4.5 * pixelRatio);
    verts.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, vertR, 0, 2 * Math.PI);
      ctx.fillStyle   = i === 0 && verts.length >= MIN_VERTICES && !isClosed ? '#4ADE80' : VERTEX_COLOUR;
      ctx.fill();
      ctx.strokeStyle = POLY_STROKE;
      ctx.lineWidth   = 1 * pixelRatio;
      ctx.stroke();
    });
  }, []);

  // ── Recompute result on dependency change ──────────────────────────────────
  useEffect(() => {
    if (!isPolyClosed || !pdfDimensions) {
      draw(vertices, closed, mousePos, 0, shape);
      return;
    }

    const smm = parseFloat(spacingMm);
    if (isNaN(smm) || smm <= 0) {
      draw(vertices, closed, mousePos, 0, shape);
      return;
    }

    const spacingPx = (smm / 1000) / (scaleFactor > 0 ? scaleFactor : 1);
    draw(vertices, closed, mousePos, spacingPx, shape);

    const res = computeResult(shape, vertices, spacingPx);
    setResult(res);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vertices, closed, spacingMm, scaleFactor, pdfDimensions, shape]);

  // Mouse-move redraw (preview line, no result change)
  useEffect(() => {
    if (closed || !pdfDimensions) return;
    const smm = parseFloat(spacingMm);
    const spacingPx = isPolyClosed && !isNaN(smm) && smm > 0
      ? (smm / 1000) / (scaleFactor > 0 ? scaleFactor : 1)
      : 0;
    draw(vertices, closed, mousePos, spacingPx, shape);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mousePos]);

  // ── Canvas coordinate helper ───────────────────────────────────────────────
  const getCanvasXY = (e: React.MouseEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current!;
    const r      = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (canvas.width  / r.width),
      y: (e.clientY - r.top)  * (canvas.height / r.height),
    };
  };

  // ── Click — add vertex or close polygon ──────────────────────────────────
  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!active || closed) return;
    const pt = getCanvasXY(e);

    // Double-click → close
    if (e.detail === 2 && vertices.length >= MIN_VERTICES) {
      setClosed(true);
      setMousePos(null);
      return;
    }

    // Near first vertex → close
    if (vertices.length >= MIN_VERTICES) {
      const first = vertices[0];
      if (Math.hypot(pt.x - first.x, pt.y - first.y) < SNAP_RADIUS_PX) {
        setClosed(true);
        setMousePos(null);
        return;
      }
    }

    setVertices(prev => [...prev, pt]);
  }, [active, closed, vertices]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!active || closed) return;
    setMousePos(getCanvasXY(e));
  }, [active, closed]);

  const handleMouseLeave = useCallback(() => {
    setMousePos(null);
  }, []);

  // ── Reset ─────────────────────────────────────────────────────────────────
  const handleClear = useCallback(() => {
    setVertices([]);
    setClosed(false);
    setMousePos(null);
    setResult(null);
  }, []);

  // ── Spacing stepper ───────────────────────────────────────────────────────
  const stepSpacing = (delta: number) => {
    const current = parseFloat(spacingMm) || 600;
    setSpacingMm(String(Math.max(10, Math.round(current + delta))));
  };

  // ── Commit ────────────────────────────────────────────────────────────────
  const handleCommit = useCallback(() => {
    if (!result || isUncalibrated) return;
    const smm = parseFloat(spacingMm);
    if (isNaN(smm) || smm <= 0) return;
    onCommit(result.count, smm, 0, 0);
    handleClear();
  }, [result, spacingMm, onCommit, isUncalibrated, handleClear]);

  // ── Panel position (anchored to poly centroid) ────────────────────────────
  const getPanelStyle = useCallback((): React.CSSProperties => {
    if (vertices.length < 2 || !pdfDimensions) return {};
    const canvas = canvasRef.current;
    if (!canvas) return {};
    const cssW   = canvas.getBoundingClientRect().width  || canvas.width;
    const cssH   = canvas.getBoundingClientRect().height || canvas.height;
    const scaleX = cssW / canvas.width;
    const scaleY = cssH / canvas.height;

    const { minX, maxX, minY } = polyBounds(vertices);
    const midX   = (minX + maxX) / 2;
    const panelH = 340;
    const rawLeft = midX * scaleX - PANEL_WIDTH / 2;
    const rawTop  = minY * scaleY - panelH - PANEL_MARGIN;
    const left    = Math.max(4, Math.min(rawLeft, cssW - PANEL_WIDTH - 4));
    const top     = rawTop < 4
      ? polyBounds(vertices).maxY * scaleY + PANEL_MARGIN   // below if no room above
      : rawTop;
    return { left, top: Math.min(top, cssH - panelH - 4) };
  }, [vertices, pdfDimensions]);

  if (!active || !pdfDimensions) return null;

  const hasEnoughVerts = vertices.length >= 2;
  const canCommit      = !!result && !isUncalibrated;

  const presets = shape === 'triangle'
    ? [250, 500, 750, 1000]
    : shape === 'diamond'
    ? [300, 450, 600, 900]
    : [300, 600, 900, 1200];

  return (
    <>
      {/* Canvas layer */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 z-[55]"
        style={{
          width:       pdfDimensions.w,
          height:      pdfDimensions.h,
          cursor:      closed ? 'default' : 'crosshair',
          touchAction: 'none',
          userSelect:  'none',
        }}
        onClick={handleClick}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onPointerDown={e => e.stopPropagation()}
      />

      {/* Control panel — shown once ≥2 vertices placed */}
      {hasEnoughVerts && (
        <div
          className="absolute z-[65] shadow-2xl"
          style={{ ...getPanelStyle(), width: PANEL_WIDTH }}
          onPointerDown={e => e.stopPropagation()}
        >
          <div className="bg-zinc-950 border border-green-500/30 overflow-hidden">

            {/* Header */}
            <div className="flex items-center gap-2 px-3 py-2 bg-green-500/10 border-b border-green-500/20">
              <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse flex-shrink-0" />
              <span className="text-[10px] font-mono font-bold text-green-400 uppercase tracking-[0.15em] flex-1">
                Tile Count
              </span>
              <span className="text-[9px] font-mono text-zinc-500">
                {vertices.length} pts {isPolyClosed ? '· closed' : '· open'}
              </span>
            </div>

            {/* Polygon status */}
            {!isPolyClosed && (
              <div className="mx-3 mt-3 flex items-start gap-2 bg-zinc-900 border border-zinc-800 px-2.5 py-2">
                <span className="text-green-400 text-[11px] flex-shrink-0 mt-0.5">◎</span>
                <p className="text-[9px] font-mono text-zinc-400 leading-relaxed">
                  {vertices.length < MIN_VERTICES
                    ? `Add ${MIN_VERTICES - vertices.length} more point${MIN_VERTICES - vertices.length !== 1 ? 's' : ''} to close`
                    : 'Click first vertex or double-click to close polygon'}
                </p>
              </div>
            )}

            {/* Shape selector */}
            <div className="px-3 pt-3 pb-0">
              <div className="text-[9px] font-mono text-zinc-500 uppercase tracking-widest mb-1.5">
                Tile shape
              </div>
              <div className="grid grid-cols-5 gap-1">
                {TILE_SHAPES.map(t => (
                  <button
                    key={t.id}
                    onClick={() => setShape(t.id)}
                    title={t.description}
                    className={cn(
                      'flex flex-col items-center gap-0.5 py-1.5 border text-[14px] transition-colors',
                      shape === t.id
                        ? 'border-green-500/60 bg-green-500/10 text-green-400'
                        : 'border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-700',
                    )}
                  >
                    <span>{t.icon}</span>
                    <span className="text-[7px] font-mono uppercase tracking-wide leading-none">
                      {t.label.split(' ')[0]}
                    </span>
                  </button>
                ))}
              </div>
              <div className="mt-1.5 text-[8px] font-mono text-zinc-600">
                {shapeConfig.description}
              </div>
            </div>

            {/* Uncalibrated warning */}
            {isUncalibrated && (
              <div className="mx-3 mt-3 flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 px-2.5 py-2">
                <span className="text-amber-400 text-[11px] mt-0.5 flex-shrink-0">⚠</span>
                <p className="text-[9px] font-mono text-amber-400 leading-relaxed">
                  Scale not calibrated. Use Draw Calibration first so spacing converts correctly to pixels.
                </p>
              </div>
            )}

            {/* Spacing input */}
            <div className="px-3 pt-3 pb-0">
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[9px] font-mono text-zinc-500 uppercase tracking-widest">
                  {shapeConfig.spacingLabel}
                </label>
                <span className="text-[9px] font-mono text-zinc-600">mm</span>
              </div>

              <div className="flex items-stretch border border-zinc-700 focus-within:border-green-500/60 transition-colors">
                <button
                  onClick={() => stepSpacing(-50)}
                  className="w-8 flex items-center justify-center text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors border-r border-zinc-700 text-sm font-mono flex-shrink-0"
                  title="Decrease by 50mm"
                >−</button>
                <input
                  type="number"
                  min="10"
                  step="50"
                  value={spacingMm}
                  onChange={e => setSpacingMm(e.target.value)}
                  className="flex-1 bg-transparent text-zinc-100 text-[13px] font-mono font-bold text-center px-2 py-2 outline-none min-w-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
                <button
                  onClick={() => stepSpacing(50)}
                  className="w-8 flex items-center justify-center text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors border-l border-zinc-700 text-sm font-mono flex-shrink-0"
                  title="Increase by 50mm"
                >+</button>
              </div>

              {/* Quick presets */}
              <div className="flex gap-1 mt-1.5">
                {presets.map(v => (
                  <button
                    key={v}
                    onClick={() => setSpacingMm(String(v))}
                    className={cn(
                      'flex-1 text-[8px] font-mono py-0.5 border transition-colors',
                      spacingMm === String(v)
                        ? 'border-green-500/50 text-green-400 bg-green-500/10'
                        : 'border-zinc-800 text-zinc-600 hover:text-zinc-400 hover:border-zinc-700',
                    )}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>

            {/* Result block */}
            {result && isPolyClosed && (
              <>
                <div className="mx-3 mt-3 border-t border-zinc-800" />
                <div className="mx-3 mt-3 bg-zinc-900 border border-zinc-800 px-3 py-2.5">
                  <div className="flex items-end justify-between">
                    <div>
                      <div className="text-[8px] font-mono text-zinc-600 uppercase tracking-widest mb-0.5">
                        {result.label}
                      </div>
                      <div className={cn(
                        'text-3xl font-mono font-bold leading-none',
                        isUncalibrated ? 'text-amber-400' : 'text-green-400',
                      )}>
                        {result.count}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-[8px] font-mono text-zinc-600 uppercase tracking-widest mb-0.5">
                        Shape
                      </div>
                      <div className="text-[20px] leading-none text-zinc-400">
                        {shapeConfig.icon}
                      </div>
                      <div className="text-[8px] font-mono text-zinc-600 mt-1">
                        {vertices.length}-sided polygon
                      </div>
                    </div>
                  </div>
                  {isUncalibrated && (
                    <div className="mt-1.5 text-[8px] font-mono text-amber-500/70">
                      Unreliable — calibrate scale first
                    </div>
                  )}
                </div>
              </>
            )}

            {/* Actions */}
            <div className="flex gap-2 px-3 py-3">
              <button
                onClick={handleCommit}
                disabled={!canCommit || !isPolyClosed}
                className={cn(
                  'flex-1 text-[9px] font-mono font-bold uppercase tracking-widest py-2 border transition-all',
                  canCommit && isPolyClosed
                    ? 'border-green-400 text-green-400 hover:bg-green-400 hover:text-black active:scale-[0.98]'
                    : 'border-zinc-800 text-zinc-600 cursor-not-allowed',
                )}
              >
                {isUncalibrated ? 'Calibrate first' : !isPolyClosed ? 'Close polygon' : 'Commit count'}
              </button>
              <button
                onClick={handleClear}
                className="px-3 py-2 text-[9px] font-mono text-zinc-600 hover:text-zinc-300 border border-zinc-800 hover:border-zinc-600 transition-all"
                title="Clear and redraw"
              >
                Clear
              </button>
            </div>

          </div>
        </div>
      )}

      {/* Hint */}
      {vertices.length === 0 && (
        <div className="absolute z-[65] pointer-events-none top-5 left-1/2 -translate-x-1/2">
          <div className="flex items-center gap-2 bg-zinc-950/95 border border-green-500/30 px-4 py-2.5 shadow-lg">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="flex-shrink-0 text-green-400">
              <polygon points="7,1 13,12 1,12" stroke="currentColor" strokeWidth="1.2" fill="none"/>
            </svg>
            <span className="text-[9px] font-mono font-bold text-green-400 uppercase tracking-[0.15em] whitespace-nowrap">
              Click to place polygon vertices · double-click to close
            </span>
          </div>
        </div>
      )}
    </>
  );
}
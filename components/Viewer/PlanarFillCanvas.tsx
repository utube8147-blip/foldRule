'use client';

// ─── components/Viewer/PlanarFillCanvas.tsx ───────────────────────────────────

import React, {
  useRef, useEffect, useCallback, useState, useMemo,
} from 'react';
import type { PdfDimensions } from '@/types/viewerTypes';
import type { PlanarGraph, PlanarFillResult } from '@/hooks/fill/usePlanarFill';
import { findEnclosingPolygon } from '@/hooks/fill/usePlanarFill';
import type { SvgLine } from '@/hooks/snapEngine/useSvgSnapPoints';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PlanarFillRegion {
  id:      number;
  polygon: Array<[number, number]>;
  areaPx:  number;
  perimPx: number;
  color:   string;
  label:   string;
  originX: number;
  originY: number;
}

interface PlanarFillCanvasProps {
  pdfDimensions:  PdfDimensions | null;
  active:         boolean;
  graph:          PlanarGraph | null;
  svgLines:       SvgLine[];           // ← NEW: needed by raster fill path
  regions:        PlanarFillRegion[];
  selectedId:     number | null;
  hoveredId:      number | null;
  onFillClick:    (x: number, y: number, result: PlanarFillResult) => void;
  onHover:        (x: number, y: number) => void;
  onHoverLeave:   () => void;
  onSelect:       (id: number | null) => void;
  maxAreaPx?:     number;
}

// ── Color palette ─────────────────────────────────────────────────────────────

const FILL_PALETTE = [
  '#60a5fa', '#34d399', '#fbbf24', '#f87171', '#a78bfa',
  '#f472b6', '#22d3ee', '#a3e635', '#fb923c', '#818cf8',
];
let _colorIdx = 0;
export const getNextPlanarFillColor  = () => FILL_PALETTE[_colorIdx++ % FILL_PALETTE.length];
export const resetPlanarFillColorIdx = () => { _colorIdx = 0; };

// ── Helpers ───────────────────────────────────────────────────────────────────

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function drawPolygon(
  ctx:     CanvasRenderingContext2D,
  polygon: Array<[number, number]>,
  fill:    string,
  stroke:  string,
  lw:      number,
  dash?:   number[],
) {
  if (polygon.length < 3) return;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(polygon[0][0], polygon[0][1]);
  for (let i = 1; i < polygon.length; i++) ctx.lineTo(polygon[i][0], polygon[i][1]);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth   = lw;
  if (dash) ctx.setLineDash(dash);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

// ── Point-in-polygon (ray casting) ───────────────────────────────────────────

function pointInPolygon(x: number, y: number, poly: Array<[number, number]>): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// ── Canvas layer: committed regions ──────────────────────────────────────────

function useRegionCanvas(
  canvasRef:  React.RefObject<HTMLCanvasElement | null>,
  regions:    PlanarFillRegion[],
  selectedId: number | null,
  dims:       PdfDimensions | null,
) {
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !dims) return;
    if (c.width !== dims.w || c.height !== dims.h) {
      c.width  = dims.w;
      c.height = dims.h;
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);

    for (const region of regions) {
      const isSelected = region.id === selectedId;
      drawPolygon(
        ctx, region.polygon,
        hexToRgba(region.color, isSelected ? 0.32 : 0.18),
        hexToRgba(region.color, isSelected ? 1.0  : 0.75),
        isSelected ? 2.0 : 1.4,
      );
      if (isSelected) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(region.polygon[0][0], region.polygon[0][1]);
        for (let i = 1; i < region.polygon.length; i++)
          ctx.lineTo(region.polygon[i][0], region.polygon[i][1]);
        ctx.closePath();
        ctx.strokeStyle = hexToRgba(region.color, 0.22);
        ctx.lineWidth   = 8;
        ctx.stroke();
        ctx.restore();
      }
    }
  }, [regions, selectedId, dims, canvasRef]);
}

// ── Component ─────────────────────────────────────────────────────────────────

export function PlanarFillCanvas({
  pdfDimensions,
  active,
  graph,
  svgLines,
  regions,
  selectedId,
  hoveredId,
  onFillClick,
  onHover,
  onHoverLeave,
  onSelect,
  maxAreaPx,
}: PlanarFillCanvasProps) {

  const regionCanvasRef  = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const animRef          = useRef(0);
  const dashRef          = useRef(0);
  const hoverPolyRef     = useRef<Array<[number, number]> | null>(null);

  const effectiveMaxAreaPx = useMemo(() => {
    if (maxAreaPx !== undefined) return maxAreaPx;
    if (pdfDimensions) return pdfDimensions.w * pdfDimensions.h * 0.5;
    return 5_000_000;
  }, [maxAreaPx, pdfDimensions]);

  // ── Fill options injected with svgLines + dims ────────────────────────────
  const fillOpts = useMemo(() => ({
    maxAreaPx:  effectiveMaxAreaPx,
    _svgLines:  svgLines,
    _pdfW:      pdfDimensions?.w,
    _pdfH:      pdfDimensions?.h,
  }), [svgLines, pdfDimensions, effectiveMaxAreaPx]);

  // ── Committed region layer ────────────────────────────────────────────────
  useRegionCanvas(regionCanvasRef, regions, selectedId, pdfDimensions);

  // ── Canvas sizing ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!pdfDimensions || !active) return;
    const { w, h } = pdfDimensions;
    for (const ref of [regionCanvasRef, previewCanvasRef]) {
      const c = ref.current;
      if (!c) continue;
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      c.style.width  = `${w}px`;
      c.style.height = `${h}px`;
    }
  }, [pdfDimensions, active]);

  // ── Hover polygon: compute on cursor move ─────────────────────────────────
  // Raster fill is fast enough to run on every mousemove at half-resolution.
  const computeHoverPoly = useCallback((x: number, y: number) => {
    if (!graph || !pdfDimensions) { hoverPolyRef.current = null; return; }
    const result = findEnclosingPolygon(x, y, graph, fillOpts);
    hoverPolyRef.current = result ? result.polygon : null;
  }, [graph, fillOpts, pdfDimensions]);

  // ── Preview animation loop ────────────────────────────────────────────────
  useEffect(() => {
    const pc = previewCanvasRef.current;
    if (!pc || !active || !pdfDimensions) {
      cancelAnimationFrame(animRef.current);
      if (pc) pc.getContext('2d')?.clearRect(0, 0, pc.width, pc.height);
      return;
    }

    const loop = () => {
      dashRef.current = (dashRef.current + 0.4) % 16;
      const ctx = pc.getContext('2d');
      if (!ctx) { animRef.current = requestAnimationFrame(loop); return; }
      ctx.clearRect(0, 0, pc.width, pc.height);

      const poly = hoverPolyRef.current;
      if (poly && poly.length >= 3) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(poly[0][0], poly[0][1]);
        for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
        ctx.closePath();
        ctx.fillStyle = 'rgba(96,165,250,0.12)';
        ctx.fill();
        ctx.strokeStyle    = 'rgba(96,165,250,0.85)';
        ctx.lineWidth      = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.lineDashOffset = -dashRef.current;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
      animRef.current = requestAnimationFrame(loop);
    };

    animRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animRef.current);
  }, [active, pdfDimensions]);

  // ── Coordinate helper ─────────────────────────────────────────────────────
  const getXY = useCallback((e: React.PointerEvent<HTMLCanvasElement> | React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget as HTMLCanvasElement;
    const rect   = canvas.getBoundingClientRect();
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top)  * scaleY,
    };
  }, []);

  // ── Pointer handlers ──────────────────────────────────────────────────────
  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = getXY(e);
    onHover(x, y);
    computeHoverPoly(x, y);
  }, [getXY, onHover, computeHoverPoly]);

  const handlePointerLeave = useCallback(() => {
    hoverPolyRef.current = null;
    onHoverLeave();
  }, [onHoverLeave]);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!graph || !pdfDimensions) return;
    const { x, y } = getXY(e);

    // Check if clicking an existing region first
    for (const region of [...regions].reverse()) {
      if (pointInPolygon(x, y, region.polygon)) {
        onSelect(region.id === selectedId ? null : region.id);
        return;
      }
    }

    const result = findEnclosingPolygon(x, y, graph, fillOpts);
    if (!result || result.polygon.length < 3) return;

    onFillClick(x, y, result);
  }, [graph, pdfDimensions, regions, selectedId, onFillClick, onSelect, getXY, fillOpts]);

  if (!active || !pdfDimensions) return null;

  return (
    <>
      {/* Layer 38: committed fill polygons */}
      <canvas
        ref={regionCanvasRef}
        className="absolute inset-0 z-[38] pointer-events-none"
        style={{ width: pdfDimensions.w, height: pdfDimensions.h }}
      />
      {/* Layer 44: hover preview + click target */}
      <canvas
        ref={previewCanvasRef}
        className="absolute inset-0 z-[44]"
        style={{
          width:  pdfDimensions.w,
          height: pdfDimensions.h,
          cursor: 'crosshair',
        }}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onClick={handleClick}
      />
    </>
  );
}

// ── usePlanarFillRegions hook ─────────────────────────────────────────────────

export interface UsePlanarFillRegionsReturn {
  regions:      PlanarFillRegion[];
  selectedId:   number | null;
  hoveredId:    number | null;
  addRegion:    (x: number, y: number, result: PlanarFillResult, color?: string) => PlanarFillRegion;
  removeRegion: (id: number) => void;
  clearRegions: () => void;
  selectRegion: (id: number | null) => void;
  hoverRegion:  (id: number | null) => void;
}

let _regionIdCounter  = 0;
let _fillLabelCounter = 0;

export function usePlanarFillRegions(): UsePlanarFillRegionsReturn {
  const [regions,    setRegions]    = useState<PlanarFillRegion[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [hoveredId,  setHoveredId]  = useState<number | null>(null);

  const addRegion = useCallback((
    x: number, y: number,
    result: PlanarFillResult,
    color?: string,
  ): PlanarFillRegion => {
    const id = ++_regionIdCounter;
    _fillLabelCounter++;
    const region: PlanarFillRegion = {
      id,
      polygon: result.polygon,
      areaPx:  result.areaPx,
      perimPx: result.perimPx,
      color:   color ?? getNextPlanarFillColor(),
      label:   `Fill ${_fillLabelCounter}`,
      originX: x,
      originY: y,
    };
    setRegions(prev => [...prev, region]);
    setSelectedId(id);
    return region;
  }, []);

  const removeRegion = useCallback((id: number) => {
    setRegions(prev => prev.filter(r => r.id !== id));
    setSelectedId(prev => prev === id ? null : prev);
    setHoveredId(prev  => prev  === id ? null : prev);
  }, []);

  const clearRegions = useCallback(() => {
    setRegions([]);
    setSelectedId(null);
    setHoveredId(null);
    _fillLabelCounter = 0;
    resetPlanarFillColorIdx();
  }, []);

  return {
    regions,
    selectedId,
    hoveredId,
    addRegion,
    removeRegion,
    clearRegions,
    selectRegion: setSelectedId,
    hoverRegion:  setHoveredId,
  };
}
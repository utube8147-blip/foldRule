'use client';

// ─── components/Viewer/GridCountOverlay.tsx ───────────────────────────────────
//
//  This file is PURE UI — no counting logic lives here.
//  All polygon state, vertex management, and tile counting is in:
//    hooks/useGridCount.ts
//
//  This file owns:
//    • canvas ref + draw function
//    • mousePos (preview cursor — a draw concern only)
//    • panel position calculation
//    • all JSX
//
// ─────────────────────────────────────────────────────────────────────────────

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import type { PdfDimensions } from '@/types/viewerTypes';
import { useGridCount, polyBounds } from '@/hooks/useGridCount';
import { TILE_SHAPES, MIN_VERTICES, SNAP_RADIUS_PX } from '@/types/gridCountTypes';
import type { TileShape, Point } from '@/types/gridCountTypes';

// ─── Props ────────────────────────────────────────────────────────────────────

interface GridCountOverlayProps {
  active:        boolean;
  pdfDimensions: PdfDimensions | null;
  scaleFactor:   number;
  onCommit:      (count: number, spacingMm: number, cols: number, rows: number) => void;
}

// ─── Visual constants ─────────────────────────────────────────────────────────

const GRID_STROKE    = 'rgba(74,222,128,0.35)';
const POLY_STROKE    = 'rgba(74,222,128,0.80)';
const POLY_FILL      = 'rgba(74,222,128,0.05)';
const PREVIEW_COLOUR = 'rgba(74,222,128,0.35)';
const VERTEX_FILL    = 'rgba(255,255,255,0.92)';
const VERTEX_STROKE  = 'rgba(74,222,128,0.75)';
const VERTEX_DOT     = 'rgba(30,30,30,0.40)';
const SNAP_COLOUR    = 'rgba(74,222,128,0.55)';

const VERTEX_R       = 4.5;  // canvas-intrinsic units
const VERTEX_INNER_R = 1.4;
const PANEL_WIDTH    = 252;
const PANEL_MARGIN   = 14;

// ─── Grid drawing — net only, no fill, hairline strokes ───────────────────────

function drawGrid(
  ctx: CanvasRenderingContext2D,
  shape: TileShape,
  poly: Point[],
  sPx: number,
) {
  const { minX, minY, maxX, maxY } = polyBounds(poly);
  const pad = sPx * 1.5;

  ctx.save();
  ctx.beginPath();
  poly.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.closePath();
  ctx.clip();

  ctx.strokeStyle = GRID_STROKE;
  ctx.lineWidth   = 0.5;
  ctx.setLineDash([]);

  if (shape === 'square') {
    const x0 = Math.floor((minX - pad) / sPx) * sPx;
    for (let x = x0; x <= maxX + pad; x += sPx) {
      ctx.beginPath(); ctx.moveTo(x, minY - pad); ctx.lineTo(x, maxY + pad); ctx.stroke();
    }
    const y0 = Math.floor((minY - pad) / sPx) * sPx;
    for (let y = y0; y <= maxY + pad; y += sPx) {
      ctx.beginPath(); ctx.moveTo(minX - pad, y); ctx.lineTo(maxX + pad, y); ctx.stroke();
    }

  } else if (shape === 'hex-flat') {
    const r = sPx / 2, h = Math.sqrt(3) * r, colP = sPx * 0.75;
    for (let c = Math.floor((minX - pad) / colP); c * colP < maxX + pad; c++) {
      const cx = c * colP + r, yo = (c % 2 === 0) ? 0 : h / 2;
      for (let row = Math.floor((minY - pad) / h); row * h + yo < maxY + pad; row++) {
        const cy = row * h + yo + h / 2;
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = (Math.PI / 3) * i;
          i === 0 ? ctx.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a))
                  : ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
        }
        ctx.closePath(); ctx.stroke();
      }
    }

  } else if (shape === 'hex-pointy') {
    const r = sPx / Math.sqrt(3), w = Math.sqrt(3) * r, h = 2 * r, rowP = h * 0.75;
    for (let row = Math.floor((minY - pad) / rowP); row * rowP < maxY + pad; row++) {
      const cy = row * rowP + h / 2, xo = (row % 2 === 0) ? 0 : w / 2;
      for (let c = Math.floor((minX - pad) / w); c * w + xo < maxX + pad; c++) {
        const cx = c * w + xo + w / 2;
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = (Math.PI / 3) * i + Math.PI / 6;
          i === 0 ? ctx.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a))
                  : ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
        }
        ctx.closePath(); ctx.stroke();
      }
    }

  } else if (shape === 'triangle') {
    const rh = (Math.sqrt(3) / 2) * sPx;
    for (let row = Math.floor((minY - pad) / rh); row * rh < maxY + pad; row++) {
      const y = row * rh;
      ctx.beginPath(); ctx.moveTo(minX - pad, y); ctx.lineTo(maxX + pad, y); ctx.stroke();
    }
    const x0d = Math.floor((minX - pad) / sPx) * sPx;
    for (let x = x0d - sPx; x < maxX + pad; x += sPx) {
      ctx.beginPath(); ctx.moveTo(x, minY - pad); ctx.lineTo(x + (maxY - minY + pad * 2) / Math.sqrt(3), maxY + pad); ctx.stroke();
    }
    for (let x = x0d - sPx; x < maxX + pad * 2; x += sPx) {
      ctx.beginPath(); ctx.moveTo(x, minY - pad); ctx.lineTo(x - (maxY - minY + pad * 2) / Math.sqrt(3), maxY + pad); ctx.stroke();
    }

  } else if (shape === 'diamond') {
    for (let k = Math.floor((minX + minY - pad * 2) / sPx); k * sPx < maxX + maxY + pad * 2; k++) {
      const c = k * sPx;
      ctx.beginPath(); ctx.moveTo(minX - pad, c - (minX - pad)); ctx.lineTo(maxX + pad, c - (maxX + pad)); ctx.stroke();
    }
    for (let k = Math.floor((minX - maxY - pad * 2) / sPx); k * sPx < maxX - minY + pad * 2; k++) {
      const c = k * sPx;
      ctx.beginPath(); ctx.moveTo(minX - pad, (minX - pad) - c); ctx.lineTo(maxX + pad, (maxX + pad) - c); ctx.stroke();
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
  const canvasRef            = useRef<HTMLCanvasElement>(null);
  const [mousePos, setMousePos] = useState<Point | null>(null);

  // All counting + polygon logic lives in the hook
  const grid = useGridCount({ scaleFactor, active });

  const isUncalibrated = scaleFactor === 1;
  const shapeConfig    = TILE_SHAPES.find(t => t.id === grid.shape)!;
  const canCommit      = !!grid.result && !isUncalibrated && grid.isPolyClosed;

  // Size canvas to PDF dimensions
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !pdfDimensions) return;
    cv.width  = pdfDimensions.w;
    cv.height = pdfDimensions.h;
  }, [pdfDimensions]);

  // Clear canvas when deactivated
  useEffect(() => {
    if (!active) {
      const cv = canvasRef.current;
      if (cv) cv.getContext('2d')?.clearRect(0, 0, cv.width, cv.height);
    }
  }, [active]);

  // ── Draw ──────────────────────────────────────────────────────────────────
  const draw = useCallback((cursor: Point | null) => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;

    const { vertices, closed, isPolyClosed, spacingPx, shape, snapTarget } = grid;

    ctx.clearRect(0, 0, cv.width, cv.height);
    if (vertices.length === 0) return;

    // Polygon outline + fill
    if (vertices.length >= 2) {
      ctx.beginPath();
      vertices.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      if (closed) {
        ctx.closePath();
        ctx.fillStyle = POLY_FILL;
        ctx.fill();
      } else if (cursor) {
        ctx.lineTo(cursor.x, cursor.y);
      }
      ctx.strokeStyle = POLY_STROKE;
      ctx.lineWidth   = 1;
      ctx.setLineDash([]);
      ctx.stroke();
    }

    // Preview line + snap ring
    if (!closed && cursor && vertices.length >= 1) {
      const last = vertices[vertices.length - 1];
      ctx.beginPath();
      ctx.moveTo(last.x, last.y); ctx.lineTo(cursor.x, cursor.y);
      ctx.strokeStyle = PREVIEW_COLOUR;
      ctx.lineWidth   = 1;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      if (snapTarget) {
        if (Math.hypot(cursor.x - snapTarget.x, cursor.y - snapTarget.y) < SNAP_RADIUS_PX * 2) {
          ctx.beginPath();
          ctx.arc(snapTarget.x, snapTarget.y, SNAP_RADIUS_PX, 0, 2 * Math.PI);
          ctx.strokeStyle = SNAP_COLOUR;
          ctx.lineWidth   = 1;
          ctx.stroke();
        }
      }
    }

    // Grid net — drawGrid uses save()/restore() so nothing leaks
    if (isPolyClosed && spacingPx > 0) {
      drawGrid(ctx, shape, vertices, spacingPx);
    }

    // Vertex handles — drawn after drawGrid restore()
    vertices.forEach((p, i) => {
      const isSnap = i === 0 && vertices.length >= MIN_VERTICES && !closed;
      ctx.beginPath();
      ctx.arc(p.x, p.y, VERTEX_R, 0, 2 * Math.PI);
      ctx.fillStyle   = isSnap ? 'rgba(74,222,128,0.20)' : VERTEX_FILL;
      ctx.fill();
      ctx.strokeStyle = isSnap ? '#4ADE80' : VERTEX_STROKE;
      ctx.lineWidth   = 1;
      ctx.setLineDash([]);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, p.y, VERTEX_INNER_R, 0, 2 * Math.PI);
      ctx.fillStyle = isSnap ? '#4ADE80' : VERTEX_DOT;
      ctx.fill();
    });
  }, [grid]); // eslint-disable-line react-hooks/exhaustive-deps

  // Redraw when polygon / spacing / shape change
  useEffect(() => {
    draw(mousePos);
  }, [grid.vertices, grid.closed, grid.spacingPx, grid.shape]); // eslint-disable-line react-hooks/exhaustive-deps

  // Redraw on mouse move (preview only)
  useEffect(() => {
    if (!grid.closed) draw(mousePos);
  }, [mousePos]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Canvas helpers ────────────────────────────────────────────────────────
  const getXY = (e: React.MouseEvent<HTMLCanvasElement>): Point => {
    const cv = canvasRef.current!;
    const r  = cv.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (cv.width  / r.width),
      y: (e.clientY - r.top)  * (cv.height / r.height),
    };
  };

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!active || grid.closed) return;
    const pt = getXY(e);
    if (e.detail === 2 && grid.vertices.length >= MIN_VERTICES) {
      grid.forceClose(); setMousePos(null); return;
    }
    grid.addVertex(pt);
  }, [active, grid]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!active || grid.closed) return;
    setMousePos(getXY(e));
  }, [active, grid.closed]);

  const handleMouseLeave = useCallback(() => setMousePos(null), []);

  const handleClear = useCallback(() => {
    grid.clear(); setMousePos(null);
  }, [grid]);

  const handleCommit = useCallback(() => {
    if (!canCommit) return;
    const smm = parseFloat(grid.spacingMm);
    if (isNaN(smm) || smm <= 0) return;
    onCommit(grid.result!.count, smm, 0, 0);
    handleClear();
  }, [canCommit, grid.result, grid.spacingMm, onCommit, handleClear]);

  // Panel position: float above / below the polygon centroid
  const getPanelStyle = useCallback((): React.CSSProperties => {
    if (grid.vertices.length < 2 || !pdfDimensions) return {};
    const cv = canvasRef.current;
    if (!cv) return {};
    const r  = cv.getBoundingClientRect();
    const sx = r.width  / cv.width;
    const sy = r.height / cv.height;
    const { minX, maxX, minY } = polyBounds(grid.vertices);
    const panelH  = 340;
    const rawLeft = (minX + maxX) / 2 * sx - PANEL_WIDTH / 2;
    const rawTop  = minY * sy - panelH - PANEL_MARGIN;
    return {
      left: Math.max(4, Math.min(rawLeft, r.width - PANEL_WIDTH - 4)),
      top:  Math.min(
        rawTop < 4 ? polyBounds(grid.vertices).maxY * sy + PANEL_MARGIN : rawTop,
        r.height - panelH - 4,
      ),
    };
  }, [grid.vertices, pdfDimensions]);

  if (!active || !pdfDimensions) return null;

  const presets = grid.shape === 'triangle' ? [250, 500, 750, 1000]
    : grid.shape === 'diamond'              ? [300, 450, 600, 900]
    :                                         [300, 600, 900, 1200];

  return (
    <>
      {/* Canvas */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 z-[55]"
        style={{
          width:       pdfDimensions.w,
          height:      pdfDimensions.h,
          cursor:      grid.closed ? 'default' : 'crosshair',
          touchAction: 'none',
          userSelect:  'none',
        }}
        onClick={handleClick}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onPointerDown={e => e.stopPropagation()}
      />

      {/* Control panel — shown once ≥2 vertices are placed */}
      {grid.vertices.length >= 2 && (
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
                {grid.vertices.length} pts {grid.isPolyClosed ? '· closed' : '· open'}
              </span>
            </div>

            {/* Status hint */}
            {!grid.isPolyClosed && (
              <div className="mx-3 mt-3 flex items-start gap-2 bg-zinc-900 border border-zinc-800 px-2.5 py-2">
                <span className="text-green-400 text-[11px] flex-shrink-0 mt-0.5">◎</span>
                <p className="text-[9px] font-mono text-zinc-400 leading-relaxed">
                  {grid.vertices.length < MIN_VERTICES
                    ? `Add ${MIN_VERTICES - grid.vertices.length} more point${MIN_VERTICES - grid.vertices.length !== 1 ? 's' : ''} to close`
                    : 'Click first vertex or double-click to close'}
                </p>
              </div>
            )}

            {/* Shape selector */}
            <div className="px-3 pt-3 pb-0">
              <div className="text-[9px] font-mono text-zinc-500 uppercase tracking-widest mb-1.5">Tile shape</div>
              <div className="grid grid-cols-5 gap-1">
                {TILE_SHAPES.map(t => (
                  <button
                    key={t.id}
                    onClick={() => grid.setShape(t.id)}
                    title={t.description}
                    className={cn(
                      'flex flex-col items-center gap-0.5 py-1.5 border text-[14px] transition-colors',
                      grid.shape === t.id
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
              <div className="mt-1.5 text-[8px] font-mono text-zinc-600">{shapeConfig.description}</div>
            </div>

            {/* Calibration warning */}
            {isUncalibrated && (
              <div className="mx-3 mt-3 flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 px-2.5 py-2">
                <span className="text-amber-400 text-[11px] mt-0.5 flex-shrink-0">⚠</span>
                <p className="text-[9px] font-mono text-amber-400 leading-relaxed">
                  Scale not calibrated — use Draw Calibration first.
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
                  onClick={() => grid.stepSpacing(-50)}
                  className="w-8 flex items-center justify-center text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 border-r border-zinc-700 text-sm font-mono flex-shrink-0"
                >−</button>
                <input
                  type="number"
                  min="10"
                  max="50000"
                  step="50"
                  value={grid.spacingMm}
                  onChange={e => grid.setSpacingMm(e.target.value)}
                  onBlur={grid.commitSpacing}
                  className="flex-1 bg-transparent text-zinc-100 text-[13px] font-mono font-bold text-center px-2 py-2 outline-none min-w-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
                <button
                  onClick={() => grid.stepSpacing(50)}
                  className="w-8 flex items-center justify-center text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 border-l border-zinc-700 text-sm font-mono flex-shrink-0"
                >+</button>
              </div>
              <div className="flex gap-1 mt-1.5">
                {presets.map(v => (
                  <button
                    key={v}
                    onClick={() => grid.setSpacingMm(String(v))}
                    className={cn(
                      'flex-1 text-[8px] font-mono py-0.5 border transition-colors',
                      grid.spacingMm === String(v)
                        ? 'border-green-500/50 text-green-400 bg-green-500/10'
                        : 'border-zinc-800 text-zinc-600 hover:text-zinc-400 hover:border-zinc-700',
                    )}
                  >{v}</button>
                ))}
              </div>
            </div>

            {/* Result */}
            {grid.result && grid.isPolyClosed && (
              <>
                <div className="mx-3 mt-3 border-t border-zinc-800" />
                <div className="mx-3 mt-3 bg-zinc-900 border border-zinc-800 px-3 py-2.5">
                  <div className="flex items-end justify-between">
                    <div>
                      <div className="text-[8px] font-mono text-zinc-600 uppercase tracking-widest mb-0.5">
                        {grid.result.label}
                      </div>
                      <div className={cn(
                        'text-3xl font-mono font-bold leading-none',
                        isUncalibrated ? 'text-amber-400' : 'text-green-400',
                      )}>
                        {grid.result.count}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-[8px] font-mono text-zinc-600 uppercase tracking-widest mb-0.5">Shape</div>
                      <div className="text-[20px] leading-none text-zinc-400">{shapeConfig.icon}</div>
                      <div className="text-[8px] font-mono text-zinc-600 mt-1">
                        {grid.vertices.length}-sided polygon
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
                disabled={!canCommit}
                className={cn(
                  'flex-1 text-[9px] font-mono font-bold uppercase tracking-widest py-2 border transition-all',
                  canCommit
                    ? 'border-green-400 text-green-400 hover:bg-green-400 hover:text-black active:scale-[0.98]'
                    : 'border-zinc-800 text-zinc-600 cursor-not-allowed',
                )}
              >
                {isUncalibrated ? 'Calibrate first' : !grid.isPolyClosed ? 'Close polygon' : 'Commit count'}
              </button>
              <button
                onClick={handleClear}
                className="px-3 py-2 text-[9px] font-mono text-zinc-600 hover:text-zinc-300 border border-zinc-800 hover:border-zinc-600 transition-all"
              >
                Clear
              </button>
            </div>

          </div>
        </div>
      )}

      {/* First-click hint */}
      {grid.vertices.length === 0 && (
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
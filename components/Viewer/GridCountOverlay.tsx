'use client';

// ─── components/Viewer/GridCountOverlay.tsx ───────────────────────────────────
//
//  FIX SUMMARY (this revision — click position wrong + vertices tiny/blurry):
//
//  ROOT CAUSE (fully traced):
//
//    The canvas wrap div in ViewerCanvas has width/height = pdfDimensions.w/h.
//    The wrapStyle div in Viewer.tsx applies a CSS transform: scale(committedScale)
//    (or equivalent) so at 118% zoom the canvas CSS rendered width becomes
//    pdfDimensions.w * 1.18.
//
//    The previous code set cv.width = pdfDimensions.w in a plain useEffect,
//    which runs AFTER paint.  The ResizeObserver — which seeds displayScaleRef —
//    also fires after layout.  Their ordering is NOT guaranteed by the spec.
//
//    On first mount / first activation the ResizeObserver often fires BEFORE
//    the useEffect has set cv.width, while cv.width is still the browser
//    default of 300px.  So:
//
//      displayScaleRef = renderedCSSWidth / 300
//                     = (pdfDimensions.w * zoomScale) / 300
//                     ≈ 2480 * 1.18 / 300  ≈  9.75   ← wildly wrong
//
//    getXY then divides (clientX - r.left) by 9.75, placing vertices ~10× too
//    close to the canvas origin (near top-left, e.g. near "Desk" label).
//    draw() uses the same stale scale, making vertex handles the wrong size.
//
//    After a zoom-in/out the browser triggers a real layout pass that fires the
//    ResizeObserver again — by this time cv.width IS correct — so displayScaleRef
//    is corrected and subsequent clicks are accurate.  This exactly matches the
//    observed symptom: "first clicks wrong, then after zooming it's consistent."
//
//  FIXES APPLIED (three changes, all in this file only):
//
//  1. useEffect → useLayoutEffect for cv.width/height sizing.
//     useLayoutEffect runs synchronously after the DOM update but BEFORE the
//     browser's paint and BEFORE ResizeObserver callbacks.  This guarantees
//     cv.width = pdfDimensions.w before any ResizeObserver reading occurs.
//
//  2. Seed displayScaleRef immediately inside that same useLayoutEffect.
//     After setting cv.width we call getBoundingClientRect() right there.
//     Because this is useLayoutEffect the browser layout IS complete so the
//     rect is accurate.  displayScaleRef is never 1 or 9.75 anymore.
//
//     We also re-seed whenever `active` becomes true (without pdfDimensions
//     changing) because the component was previously returning null and the
//     canvas was not in the DOM, so the ResizeObserver had nothing to measure.
//
//  3. getXY uses e.nativeEvent.offsetX/offsetY + live cv.width/rect.width.
//     offsetX/offsetY are always relative to the canvas element in CSS px —
//     no parent-transform, no scroll-container, no layout-timing issues.
//     cv.width / rect.width is the intrinsic→CSS-px ratio computed fresh at
//     click time (layout is trivially complete when a click fires).
//     displayScaleRef is no longer used for coordinate conversion.
//
// ─────────────────────────────────────────────────────────────────────────────

import React, { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import type { PdfDimensions } from '@/types/viewerTypes';
import { useGridCount, polyBounds } from '@/hooks/measurements/useGridCount';
import { TILE_SHAPES, MIN_VERTICES, SNAP_RADIUS_PX } from '@/types/gridCountTypes';
import type { TileShape, Point } from '@/types/gridCountTypes';

// ─── Props ────────────────────────────────────────────────────────────────────

interface GridCountOverlayProps {
  active:        boolean;
  pdfDimensions: PdfDimensions | null;
  scaleFactor:   number;
  onCommit:      (count: number, spacingMm: number, cols: number, rows: number) => void;
}

// ─── Visual constants — TARGET on-screen pixel sizes ─────────────────────────

const TARGET_VERTEX_R       = 5;    // outer circle radius, screen px
const TARGET_VERTEX_INNER_R = 1.8;  // inner dot radius, screen px
const TARGET_SNAP_RING_R    = 10;   // snap-to-close ring radius, screen px
const TARGET_STROKE_W       = 1;    // polygon / preview stroke, screen px
const TARGET_GRID_W         = 0.6;  // grid hairline, screen px

const GRID_STROKE    = 'rgba(74,222,128,0.35)';
const POLY_STROKE    = 'rgba(74,222,128,0.80)';
const POLY_FILL      = 'rgba(74,222,128,0.05)';
const PREVIEW_COLOUR = 'rgba(74,222,128,0.35)';
const VERTEX_FILL    = 'rgba(255,255,255,0.92)';
const VERTEX_STROKE  = 'rgba(74,222,128,0.90)';
const VERTEX_DOT     = 'rgba(30,30,30,0.60)';
const SNAP_COLOUR    = 'rgba(74,222,128,0.55)';

const PANEL_WIDTH  = 252;
const PANEL_MARGIN = 14;

// ─── Helper — screen px → canvas-intrinsic units ─────────────────────────────
function toCU(screenPx: number, displayScale: number): number {
  return screenPx / displayScale;
}

// ─── Grid drawing ─────────────────────────────────────────────────────────────

function drawGrid(
  ctx: CanvasRenderingContext2D,
  shape: TileShape,
  poly: Point[],
  sPx: number,
  displayScale: number,
) {
  const { minX, minY, maxX, maxY } = polyBounds(poly);
  const pad = sPx * 1.5;

  ctx.save();
  ctx.beginPath();
  poly.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.closePath();
  ctx.clip();

  ctx.strokeStyle = GRID_STROKE;
  ctx.lineWidth   = toCU(TARGET_GRID_W, displayScale);
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
  const canvasRef               = useRef<HTMLCanvasElement>(null);
  const mousePosRef             = useRef<Point | null>(null);
  const [mousePos, setMousePos] = useState<Point | null>(null);

  // ── displayScaleRef — rendered CSS px per intrinsic canvas px ───────────────
  //
  //  Written in two places (in priority order):
  //    1. useLayoutEffect after setting cv.width (runs before paint, before ResizeObserver)
  //    2. ResizeObserver callback (keeps it fresh on every zoom change)
  //
  //  Read in:
  //    • draw() — to convert TARGET_* screen px to canvas-intrinsic units
  //
  //  NOT used in getXY() anymore — see fix #3 below.
  const displayScaleRef = useRef<number>(1);

  const grid = useGridCount({ scaleFactor, active });

  const isUncalibrated = scaleFactor === 1;
  const shapeConfig    = TILE_SHAPES.find(t => t.id === grid.shape)!;
  const canCommit      = !!grid.result && !isUncalibrated && grid.isPolyClosed;

  // Keep a stable ref to the latest mousePos for use inside draw callbacks
  mousePosRef.current = mousePos;

  // ── FIX #1 + #2: useLayoutEffect for canvas sizing + immediate scale seed ───
  //
  //  CHANGED FROM: useEffect (runs after paint, races with ResizeObserver)
  //  CHANGED TO:   useLayoutEffect (runs after DOM update, before paint,
  //                before ResizeObserver callbacks)
  //
  //  After setting cv.width we immediately read getBoundingClientRect() and
  //  seed displayScaleRef.  At this point in the lifecycle the browser layout
  //  IS complete (useLayoutEffect guarantees it), so the rect is accurate.
  //
  //  This eliminates the race where ResizeObserver read cv.width = 300
  //  (browser default) and stored renderedWidth/300 ≈ 9.75 into displayScaleRef.
  useLayoutEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !pdfDimensions) return;

    // Set intrinsic canvas dimensions.
    cv.width  = pdfDimensions.w;
    cv.height = pdfDimensions.h;

    // Immediately seed displayScaleRef with the correct ratio.
    // getBoundingClientRect is reliable here because useLayoutEffect runs
    // after the browser has completed its layout pass.
    const rect = cv.getBoundingClientRect();
    if (rect.width > 0) {
      displayScaleRef.current = rect.width / cv.width;
    }
  }, [pdfDimensions]);

  // ── FIX #2b: also re-seed when `active` flips to true ──────────────────────
  //
  //  When the component transitions from null (inactive) to rendered (active),
  //  pdfDimensions has NOT changed, so the useLayoutEffect above won't re-run.
  //  But the canvas just entered the DOM for the first time — we must seed
  //  displayScaleRef before the ResizeObserver fires (which would read a stale
  //  cv.width if it fires before the sizing useLayoutEffect runs on first mount).
  //
  //  Note: this useLayoutEffect runs on every `active` change, but the guard
  //  `if (!active)` makes it a no-op when deactivating.
  useLayoutEffect(() => {
    if (!active) return;
    const cv = canvasRef.current;
    if (!cv || !pdfDimensions) return;

    // Ensure intrinsic dimensions are correct (they may not be set yet if this
    // is the very first render — the [pdfDimensions] useLayoutEffect above has
    // the same effect, but React runs multiple useLayoutEffects in order so
    // this one may run first).
    if (cv.width !== pdfDimensions.w)  cv.width  = pdfDimensions.w;
    if (cv.height !== pdfDimensions.h) cv.height = pdfDimensions.h;

    const rect = cv.getBoundingClientRect();
    if (rect.width > 0) {
      displayScaleRef.current = rect.width / cv.width;
    }
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Clear canvas when deactivated ─────────────────────────────────────────
  useEffect(() => {
    if (!active) {
      const cv = canvasRef.current;
      if (cv) cv.getContext('2d')?.clearRect(0, 0, cv.width, cv.height);
    }
  }, [active]);

  // ── Draw ──────────────────────────────────────────────────────────────────
  //
  //  Reads displayScaleRef.current which is kept correct by the useLayoutEffect
  //  and ResizeObserver below.
  const draw = useCallback((cursor: Point | null) => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;

    const displayScale = displayScaleRef.current;

    const { vertices, closed, isPolyClosed, spacingPx, shape, snapTarget } = grid;

    ctx.clearRect(0, 0, cv.width, cv.height);
    if (vertices.length === 0) return;

    // ── Polygon outline + fill ─────────────────────────────────────────────
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
      ctx.lineWidth   = toCU(TARGET_STROKE_W, displayScale);
      ctx.setLineDash([]);
      ctx.stroke();
    }

    // ── Preview line + snap ring ───────────────────────────────────────────
    if (!closed && cursor && vertices.length >= 1) {
      const last = vertices[vertices.length - 1];
      ctx.beginPath();
      ctx.moveTo(last.x, last.y); ctx.lineTo(cursor.x, cursor.y);
      ctx.strokeStyle = PREVIEW_COLOUR;
      ctx.lineWidth   = toCU(TARGET_STROKE_W, displayScale);
      ctx.setLineDash([toCU(5, displayScale), toCU(4, displayScale)]);
      ctx.stroke();
      ctx.setLineDash([]);

      if (snapTarget) {
        const snapRingR = toCU(TARGET_SNAP_RING_R, displayScale);
        if (Math.hypot(cursor.x - snapTarget.x, cursor.y - snapTarget.y) < snapRingR * 2) {
          ctx.beginPath();
          ctx.arc(snapTarget.x, snapTarget.y, snapRingR, 0, 2 * Math.PI);
          ctx.strokeStyle = SNAP_COLOUR;
          ctx.lineWidth   = toCU(TARGET_STROKE_W, displayScale);
          ctx.stroke();
        }
      }
    }

    // ── Grid net ───────────────────────────────────────────────────────────
    if (isPolyClosed && spacingPx > 0) {
      drawGrid(ctx, shape, vertices, spacingPx, displayScale);
    }

    // ── Vertex handles ─────────────────────────────────────────────────────
    const vr  = toCU(TARGET_VERTEX_R, displayScale);
    const vir = toCU(TARGET_VERTEX_INNER_R, displayScale);
    const sw  = toCU(TARGET_STROKE_W, displayScale);

    vertices.forEach((p, i) => {
      const isSnap = i === 0 && vertices.length >= MIN_VERTICES && !closed;

      ctx.beginPath();
      ctx.arc(p.x, p.y, vr, 0, 2 * Math.PI);
      ctx.fillStyle   = isSnap ? 'rgba(74,222,128,0.25)' : VERTEX_FILL;
      ctx.fill();
      ctx.strokeStyle = isSnap ? '#4ADE80' : VERTEX_STROKE;
      ctx.lineWidth   = sw;
      ctx.setLineDash([]);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(p.x, p.y, vir, 0, 2 * Math.PI);
      ctx.fillStyle = isSnap ? '#4ADE80' : VERTEX_DOT;
      ctx.fill();
    });
  }, [grid]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── ResizeObserver — keeps displayScaleRef correct after zoom changes ──────
  //
  //  This fires AFTER layout completes, so getBoundingClientRect is accurate.
  //  By now the useLayoutEffect has already set cv.width = pdfDimensions.w,
  //  so rect.width / cv.width gives the correct zoom scale (not 9.75).
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;

    const ro = new ResizeObserver(() => {
      const rect = cv.getBoundingClientRect();
      if (rect.width > 0 && cv.width > 0) {
        displayScaleRef.current = rect.width / cv.width;
      }
      draw(mousePosRef.current);
    });

    ro.observe(cv);
    return () => ro.disconnect();
  }, [draw]);

  // Redraw when polygon / spacing / shape change
  useEffect(() => {
    draw(mousePos);
  }, [grid.vertices, grid.closed, grid.spacingPx, grid.shape]); // eslint-disable-line react-hooks/exhaustive-deps

  // Redraw on mouse move (preview only)
  useEffect(() => {
    if (!grid.closed) draw(mousePos);
  }, [mousePos]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── FIX #3: getXY — use offsetX/offsetY + live intrinsic/CSS ratio ─────────
  //
  //  PREVIOUS CODE:
  //    const r  = cv.getBoundingClientRect();
  //    const ds = displayScaleRef.current;          // could be stale/wrong
  //    return { x: (e.clientX - r.left) / ds, y: (e.clientY - r.top) / ds };
  //
  //  PROBLEM: displayScaleRef could hold a stale value (9.75 from the race)
  //  and (clientX - r.left) requires correct r.left which depends on scroll
  //  position, panel widths, etc. — fragile.
  //
  //  NEW CODE:
  //    offsetX/offsetY — always relative to the canvas element itself in CSS px.
  //    No parent transforms, no scroll offsets, no container layout involved.
  //    cv.width / rect.width — intrinsic-to-CSS ratio, computed LIVE at click
  //    time (layout is trivially complete when the user clicks).
  //
  //  If cv.width is still somehow wrong (extremely unlikely after the
  //  useLayoutEffect fixes), the worst case is a proportional offset within
  //  the canvas — far better than the previous 9.75× displacement.
  const getXY = useCallback((e: React.MouseEvent<HTMLCanvasElement>): Point => {
    const cv = canvasRef.current!;
    const rect = cv.getBoundingClientRect();
    // Ratio of canvas intrinsic pixels to rendered CSS pixels.
    // Computed live at click time — always correct, never stale.
    const scaleX = cv.width  / rect.width;
    const scaleY = cv.height / rect.height;
    return {
      x: e.nativeEvent.offsetX * scaleX,
      y: e.nativeEvent.offsetY * scaleY,
    };
  }, []);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!active || grid.closed) return;
    const pt = getXY(e);
    if (e.detail === 2 && grid.vertices.length >= MIN_VERTICES) {
      grid.forceClose(); setMousePos(null); return;
    }
    grid.addVertex(pt);
  }, [active, grid, getXY]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!active || grid.closed) return;
    setMousePos(getXY(e));
  }, [active, grid.closed, getXY]);

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

  // ── Panel position ────────────────────────────────────────────────────────
  //
  //  The panel is a child of the canvas wrap div (CSS size = pdfDimensions).
  //  grid.vertices are stored in canvas-intrinsic space which equals the wrap
  //  div's CSS px space (both = pdfDimensions.w/h before zoom). No scaling needed.
  const getPanelStyle = useCallback((): React.CSSProperties => {
    if (grid.vertices.length < 2 || !pdfDimensions) return {};

    const { minX, maxX, minY, maxY } = polyBounds(grid.vertices);
    const panelH  = 420;
    const rawLeft = (minX + maxX) / 2 - PANEL_WIDTH / 2;
    const rawTop  = minY - panelH - PANEL_MARGIN;

    const left = Math.max(4, Math.min(rawLeft, pdfDimensions.w - PANEL_WIDTH - 4));
    const top  = rawTop < 4
      ? maxY + PANEL_MARGIN
      : Math.min(rawTop, pdfDimensions.h - panelH - 4);

    return { left, top };
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

      {/* Control panel */}
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

'use client';

// ─── components/Viewer/MagicFillCanvas.tsx ────────────────────────────────────
//
//  ROOT CAUSE OF HUGE CROSSHAIR (confirmed):
//
//  Viewer.tsx has a CSS-zoom transition effect that sets style.width/style.height
//  on every overlay canvas ref it knows about. That list does NOT include the
//  interactRef inside MagicFillCanvas — BUT MagicFillCanvas passes style props
//  directly: style={{ width: pdfDimensions.w, height: pdfDimensions.h }}.
//
//  pdfDimensions.w/h are LOGICAL pixels (e.g. 1200 × 900). The inline style
//  value is a bare number so React renders it as "1200px" — correct.
//
//  HOWEVER: the polygon canvas (polyRef, z-42) is rendered as a sibling to the
//  interactRef canvas, and BOTH sit inside the ViewerCanvas wrapper div which
//  uses `canvasWrapStyle` — a position:absolute box sized to
//    max(pdfDimensions.w + padding*2, vw*3)  ×  max(pdfDimensions.h + padding*2, vh*3)
//
//  The interact canvas has pointer-events:auto and spans z-45.
//  getBoundingClientRect() on it returns the correct small rect.
//  getXY() is therefore correct.
//
//  The crosshair lines draw from 0 → ic.width. ic.width = canvas.width = pdfDimensions.w.
//  In canvas pixel space that IS correct.
//
//  BUT: ctx.clearRect(0, 0, ic.width, ic.height) also clears only pdfDimensions area.
//  The lines are drawn in canvas-pixel space. They will look correct IF the canvas
//  CSS size matches canvas.width. 
//
//  The ACTUAL bug: when active=true first renders, pdfDimensions may already be set
//  from the previous render cycle, so useEffect([pdfDimensions]) may not fire again.
//  The canvas starts at HTML default 300×150 (width=300, height=150).
//  Then style.width="1200px" is set from the JSX prop.
//  So canvas.width=300, style.width="1200px".
//  getBoundingClientRect().width ≈ 1200.
//  scaleX = 300/1200 = 0.25.
//  getXY returns coords * 0.25 → fills land in wrong place (top-left).
//  rAF draws crosshair from 0→300 in canvas pixels, displayed at 1200px → looks huge (4×).
//
//  FIX: In the useEffect that sizes the canvases, ALWAYS run it when active changes too,
//  so the canvas is correctly sized as soon as MagicFillCanvas mounts.
//  Also: read ic.width AFTER ensuring it matches pdfDimensions.w.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useRef, useEffect, useCallback } from 'react';
import type { PdfDimensions } from '@/types/viewerTypes';
import type { MagicFill } from '@/hooks/useMagicFill';

// ─── Color palette ────────────────────────────────────────────────────────────

const FILL_COLORS = [
  '#60a5fa','#34d399','#fbbf24','#f87171','#a78bfa',
  '#f472b6','#22d3ee','#a3e635','#fb923c','#818cf8',
];
let colorIdx = 0;
export const getNextFillColor  = () => FILL_COLORS[colorIdx++ % FILL_COLORS.length];
export const resetFillColorIdx = () => { colorIdx = 0; };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1,3), 16),
    parseInt(hex.slice(3,5), 16),
    parseInt(hex.slice(5,7), 16),
  ];
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface MagicFillCanvasProps {
  pdfDimensions:  PdfDimensions | null;
  active:         boolean;
  isFilling:      boolean;
  fills:          MagicFill[];
  hiddenIds:      Set<number>;
  selectedId:     number | null;
  selectedGroup:  number | null;
  onSingleClick:  (canvasX: number, canvasY: number) => void;
  onBatchRect:    (x1: number, y1: number, x2: number, y2: number) => void;
  onHover:        (canvasX: number, canvasY: number) => void;
  onHoverLeave:   () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function MagicFillCanvas({
  pdfDimensions,
  active,
  isFilling,
  fills,
  hiddenIds,
  selectedId,
  selectedGroup,
  onSingleClick,
  onBatchRect,
  onHover,
  onHoverLeave,
}: MagicFillCanvasProps) {
  const polyRef     = useRef<HTMLCanvasElement>(null);
  const interactRef = useRef<HTMLCanvasElement>(null);

  const animRef    = useRef(0);
  const dashRef    = useRef(0);
  const pulseRef   = useRef(0);
  const cursorRef  = useRef<{ x: number; y: number } | null>(null);

  const isDragging  = useRef(false);
  const hasDragged  = useRef(false);
  const startPt     = useRef<{ x: number; y: number } | null>(null);
  const dragRect    = useRef<{ x1:number; y1:number; x2:number; y2:number } | null>(null);

  // ── Canvas sizing ──────────────────────────────────────────────────────────
  // FIX: include `active` in deps so sizing runs immediately on mount/unmount.
  // Without this, when active flips true the canvas keeps its HTML default
  // size (300×150) until pdfDimensions next changes — causing getXY() to
  // return wrong coords and the crosshair to render at 4× the correct size.
  useEffect(() => {
    if (!pdfDimensions || !active) return;
    const { w, h } = pdfDimensions;
    for (const ref of [polyRef, interactRef]) {
      const c = ref.current;
      if (!c) continue;
      // Always sync backing-store size to logical dimensions
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      c.style.width  = `${w}px`;
      c.style.height = `${h}px`;
    }
  }, [pdfDimensions, active]); // ← active added here

  // ── Polygon redraw ────────────────────────────────────────────────────────
  const redrawPolygons = useCallback(() => {
    const pc = polyRef.current;
    if (!pc || !pdfDimensions) return;
    const ctx = pc.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, pc.width, pc.height);

    fills.forEach(f => {
      if (hiddenIds.has(f.id)) return;
      if (f.polygon.length < 3) return;

      if (f.polygon.length === 4) {
        const xs = f.polygon.map(p => p[0]);
        const ys = f.polygon.map(p => p[1]);
        if (new Set(xs).size === 2 && new Set(ys).size === 2) return;
      }

      const pts = f.polygon;
      const [r, g, b] = hexToRgb(f.color);
      const isSelected = f.id === selectedId;
      const isInGroup  = selectedGroup != null && f.groupId === selectedGroup;

      const drawPath = () => {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();
      };

      if (isSelected || isInGroup) {
        ctx.save();
        drawPath();
        ctx.strokeStyle = isInGroup
          ? 'rgba(96,165,250,0.18)'
          : `rgba(${r},${g},${b},0.18)`;
        ctx.lineWidth   = 8;
        ctx.setLineDash([]);
        ctx.stroke();
        ctx.restore();
      }

      drawPath();
      ctx.strokeStyle = `rgba(${r},${g},${b},${isSelected || isInGroup ? 1 : 0.85})`;
      ctx.lineWidth   = isSelected ? 2.5 : isInGroup ? 2 : 1.6;
      ctx.setLineDash([]);
      ctx.stroke();
    });
  }, [fills, hiddenIds, selectedId, selectedGroup, pdfDimensions]);

  useEffect(() => { redrawPolygons(); }, [redrawPolygons]);

  // ── Interaction animation loop ────────────────────────────────────────────
  useEffect(() => {
    const ic = interactRef.current;
    if (!ic || !active || !pdfDimensions) {
      cancelAnimationFrame(animRef.current);
      if (ic) ic.getContext('2d')?.clearRect(0, 0, ic.width, ic.height);
      return;
    }

    const loop = () => {
      dashRef.current  = (dashRef.current + 0.5) % 20;
      pulseRef.current = pulseRef.current + 0.06;

      const ctx = ic.getContext('2d');
      if (!ctx) { animRef.current = requestAnimationFrame(loop); return; }

      // Use canvas backing-store dimensions for all drawing.
      // These equal pdfDimensions.w/h because the sizing useEffect above
      // (which now runs on mount via the `active` dep) ensures it.
      const cw = ic.width;
      const ch = ic.height;

      ctx.clearRect(0, 0, cw, ch);

      // ── Drag rect ─────────────────────────────────────────────────────────
      if (dragRect.current && isDragging.current && hasDragged.current) {
        const { x1, y1, x2, y2 } = dragRect.current;
        const rx = Math.min(x1,x2), ry = Math.min(y1,y2);
        const rw = Math.abs(x2-x1), rh = Math.abs(y2-y1);

        ctx.save();
        ctx.fillStyle = 'rgba(96,165,250,0.07)';
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeStyle    = 'rgba(96,165,250,0.9)';
        ctx.lineWidth      = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.lineDashOffset = -dashRef.current;
        ctx.strokeRect(rx, ry, rw, rh);
        ctx.setLineDash([]);

        for (const [hx, hy] of [
          [rx, ry], [rx+rw, ry], [rx+rw, ry+rh], [rx, ry+rh],
        ] as [number,number][]) {
          ctx.fillStyle   = '#60a5fa';
          ctx.fillRect(hx-4, hy-4, 8, 8);
          ctx.strokeStyle = 'rgba(0,0,0,0.6)';
          ctx.lineWidth   = 1;
          ctx.strokeRect(hx-4, hy-4, 8, 8);
        }
        ctx.font      = '9px "Courier New",monospace';
        ctx.fillStyle = 'rgba(96,165,250,0.9)';
        ctx.fillText(`${Math.round(Math.abs(x2-x1))}×${Math.round(Math.abs(y2-y1))}`, rx+6, ry+14);
        ctx.restore();
      }

      // ── Crosshair ─────────────────────────────────────────────────────────
      if (cursorRef.current && (!isDragging.current || !hasDragged.current)) {
        const { x, y } = cursorRef.current;
        const alpha = 0.28 + 0.18 * Math.sin(pulseRef.current);

        ctx.save();
        ctx.strokeStyle = `rgba(245,158,11,${alpha})`;
        ctx.lineWidth   = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(0,  y); ctx.lineTo(cw, y); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x,  0); ctx.lineTo(x, ch); ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(245,158,11,${0.5 + 0.4 * Math.sin(pulseRef.current)})`;
        ctx.fill();
        ctx.restore();
      }

      animRef.current = requestAnimationFrame(loop);
    };

    animRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animRef.current);
  }, [active, pdfDimensions]);

  // ── Coordinate helper ─────────────────────────────────────────────────────
  // Returns canvas-pixel coords. canvas.width = pdfDimensions.w (guaranteed by
  // the sizing useEffect which now runs on mount). rect = screen CSS size.
  // scaleX = canvas.width / rect.width handles any CSS zoom or transition.
  const getXY = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget;
    const rect   = canvas.getBoundingClientRect();
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top)  * scaleY,
    };
  }, []);

  // ── Pointer handlers ──────────────────────────────────────────────────────
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const pt = getXY(e);
    startPt.current    = pt;
    isDragging.current = true;
    hasDragged.current = false;
    dragRect.current   = { x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
  }, [getXY]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const pt = getXY(e);
    cursorRef.current = pt;
    onHover(pt.x, pt.y);
    if (!isDragging.current || !startPt.current) return;
    const dx = Math.abs(pt.x - startPt.current.x);
    const dy = Math.abs(pt.y - startPt.current.y);
    if (dx > 6 || dy > 6) hasDragged.current = true;
    if (hasDragged.current) {
      dragRect.current = { x1: startPt.current.x, y1: startPt.current.y, x2: pt.x, y2: pt.y };
    }
  }, [getXY, onHover]);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDragging.current) return;
    isDragging.current = false;
    const pt = getXY(e);
    if (hasDragged.current && startPt.current) {
      onBatchRect(startPt.current.x, startPt.current.y, pt.x, pt.y);
    } else if (startPt.current) {
      onSingleClick(pt.x, pt.y);
    }
    dragRect.current   = null;
    startPt.current    = null;
    hasDragged.current = false;
  }, [getXY, onSingleClick, onBatchRect]);

  const handlePointerLeave = useCallback(() => {
    cursorRef.current = null;
    onHoverLeave();
  }, [onHoverLeave]);

  if (!active || !pdfDimensions) return null;

  return (
    <>
      {/* Layer 42: polygon outlines */}
      <canvas
        ref={polyRef}
        className="absolute inset-0 z-[42] pointer-events-none"
        style={{ width: pdfDimensions.w, height: pdfDimensions.h }}
      />
      {/* Layer 45: interaction + animated overlay */}
      <canvas
        ref={interactRef}
        className="absolute inset-0 z-[45]"
        style={{
          width:         pdfDimensions.w,
          height:        pdfDimensions.h,
          cursor:        isFilling ? 'wait' : 'crosshair',
          pointerEvents: isFilling ? 'none' : 'auto',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
      />
    </>
  );
}
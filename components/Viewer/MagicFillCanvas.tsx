'use client';

// ─── components/Viewer/MagicFillCanvas.tsx ────────────────────────────────────
//
//  FIX 1: getXY now divides by pdfDimensions.w/h instead of rect.width/height.
//          At zoom != 1, getBoundingClientRect returns the *zoomed* CSS size, so
//          c.width / rect.width = logicalPx / (logicalPx * zoom) = 1/zoom, which
//          double-counted the zoom and placed clicks at the wrong position.
//
//  FIX 2: Canvas elements are sized via BOTH the HTML width/height attributes
//          AND style.width/height so bitmap resolution matches layout size.
//
//  FIX 3: The interactRef canvas covers exactly pdfDimensions.w × pdfDimensions.h
//          in both bitmap and CSS, so pointer events map 1-to-1 with PDF pixels.
//
// ─────────────────────────────────────────────────────────────────────────────

import React, { useRef, useEffect, useCallback, useState } from 'react';
import type { PdfDimensions } from '@/types/viewerTypes';
import type { MagicFill } from '@/hooks/fill/useMagicFill';

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

const CLOSE_SNAP_RADIUS = 14; // canvas-space pixels

// ─── Props ────────────────────────────────────────────────────────────────────

interface MagicFillCanvasProps {
  pdfDimensions:  PdfDimensions | null;
  active:         boolean;
  isFilling:      boolean;
  fills:          MagicFill[];
  hiddenIds:      Set<number>;
  selectedId:     number | null;
  selectedGroup:  number | null;
  activeColor?:   string;
  onSingleClick:  (canvasX: number, canvasY: number) => void;
  onPolygonLasso: (poly: [number, number][]) => void;
  onHover:        (canvasX: number, canvasY: number) => void;
  onHoverLeave:   () => void;
}

// ─── LassoOverlay ─────────────────────────────────────────────────────────────

function LassoOverlay({
  points, mousePos, activeColor, width, height,
}: {
  points:      [number, number][];
  mousePos:    [number, number] | null;
  activeColor: string;
  width:       number;
  height:      number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current; if (!c) return;
    // FIX: set both bitmap size AND css size
    if (c.width !== width || c.height !== height) {
      c.width  = width;
      c.height = height;
    }
    c.style.width  = `${width}px`;
    c.style.height = `${height}px`;
  }, [width, height]);

  useEffect(() => {
    const c = ref.current; if (!c) return;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    if (points.length === 0) return;

    const [r, g, b] = hexToRgb(activeColor);

    // filled preview (≥3 pts)
    if (points.length >= 3) {
      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
      if (mousePos) ctx.lineTo(mousePos[0], mousePos[1]);
      ctx.closePath();
      ctx.fillStyle = `rgba(${r},${g},${b},0.10)`;
      ctx.fill();
    }

    // committed edges
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
    ctx.strokeStyle = `rgba(${r},${g},${b},0.9)`;
    ctx.lineWidth   = 1.8;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    // rubber-band to mouse
    if (mousePos) {
      const last = points[points.length - 1];
      ctx.beginPath();
      ctx.moveTo(last[0], last[1]);
      ctx.lineTo(mousePos[0], mousePos[1]);
      ctx.strokeStyle = `rgba(${r},${g},${b},0.5)`;
      ctx.lineWidth   = 1.2;
      ctx.setLineDash([4, 6]);
      ctx.stroke();
      ctx.setLineDash([]);

      // close-hint back to first point
      if (points.length >= 3) {
        const dist = Math.hypot(mousePos[0] - points[0][0], mousePos[1] - points[0][1]);
        ctx.beginPath();
        ctx.moveTo(mousePos[0], mousePos[1]);
        ctx.lineTo(points[0][0], points[0][1]);
        ctx.strokeStyle = dist < CLOSE_SNAP_RADIUS
          ? `rgba(${r},${g},${b},0.85)`
          : `rgba(${r},${g},${b},0.18)`;
        ctx.lineWidth = dist < CLOSE_SNAP_RADIUS ? 1.8 : 1;
        ctx.setLineDash([3, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // vertex dots
    points.forEach(([px, py], i) => {
      const isFirst = i === 0;
      const dotR    = isFirst ? 7 : 4.5;
      ctx.beginPath(); ctx.arc(px, py, dotR + 2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fill();
      ctx.beginPath(); ctx.arc(px, py, dotR, 0, Math.PI * 2);
      ctx.fillStyle = isFirst ? `rgba(${r},${g},${b},1)` : `rgba(${r},${g},${b},0.85)`;
      ctx.fill();
      if (isFirst && points.length >= 3) {
        ctx.beginPath(); ctx.arc(px, py, dotR - 2.5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.5; ctx.stroke();
      }
    });

    // point count badge
    if (points.length > 0) {
      const [lx, ly] = points[points.length - 1];
      ctx.fillStyle = 'rgba(10,10,10,0.85)';
      ctx.fillRect(lx + 10, ly - 12, 36, 16);
      ctx.font      = '9px "Courier New"';
      ctx.fillStyle = `rgba(${r},${g},${b},1)`;
      ctx.fillText(`${points.length}pts`, lx + 13, ly);
    }
  }, [points, mousePos, activeColor, width, height]);

  return (
    <canvas
      ref={ref}
      style={{
        position:      'absolute',
        inset:         0,
        width:         `${width}px`,
        height:        `${height}px`,
        pointerEvents: 'none',
        zIndex:        46,
      }}
    />
  );
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
  activeColor = '#60a5fa',
  onSingleClick,
  onPolygonLasso,
  onHover,
  onHoverLeave,
}: MagicFillCanvasProps) {
  const polyRef     = useRef<HTMLCanvasElement>(null);
  const interactRef = useRef<HTMLCanvasElement>(null);

  const animRef    = useRef(0);
  const pulseRef   = useRef(0);
  const cursorRef  = useRef<{ x: number; y: number } | null>(null);

  // space key tracking
  const spaceHeldRef = useRef(false);
  const [spaceHeld, setSpaceHeld] = useState(false);

  // lasso state
  const [lassoPoints, setLassoPoints] = useState<[number, number][]>([]);
  const [isLassoing,  setIsLassoing]  = useState(false);
  const [lassoMouse,  setLassoMouse]  = useState<[number, number] | null>(null);
  const lassoRef = useRef<[number, number][]>([]);

  // single-click guard (pointer moved significantly = not a click)
  const pointerDownPos = useRef<{ x: number; y: number } | null>(null);
  const hasMoved       = useRef(false);

  // ── Space key listener ────────────────────────────────────────────────────
  useEffect(() => {
    if (!active) return;
    const onDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        spaceHeldRef.current = true;
        setSpaceHeld(true);
      }
      if (e.code === 'Escape') {
        lassoRef.current = [];
        setLassoPoints([]);
        setIsLassoing(false);
        setLassoMouse(null);
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') { spaceHeldRef.current = false; setSpaceHeld(false); }
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup',   onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup',   onUp);
    };
  }, [active]);

  // ── Canvas sizing ──────────────────────────────────────────────────────────
  // FIX: Set both bitmap dimensions (width/height attributes) AND CSS size
  // so that 1 canvas pixel = 1 PDF pixel, and the canvas fills the wrapper
  // exactly regardless of device pixel ratio or zoom.
  useEffect(() => {
    if (!pdfDimensions || !active) return;
    const { w, h } = pdfDimensions;
    for (const ref of [polyRef, interactRef]) {
      const c = ref.current; if (!c) continue;
      // Bitmap size
      if (c.width !== w || c.height !== h) {
        c.width  = w;
        c.height = h;
      }
      // CSS size — must match so coordinates map correctly
      c.style.width  = `${w}px`;
      c.style.height = `${h}px`;
    }
  }, [pdfDimensions, active]);

  // ── Polygon outline redraw ─────────────────────────────────────────────────
  const redrawPolygons = useCallback(() => {
    const pc = polyRef.current; if (!pc || !pdfDimensions) return;
    const ctx = pc.getContext('2d')!;
    ctx.clearRect(0, 0, pc.width, pc.height);

    fills.forEach(f => {
      if (hiddenIds.has(f.id) || f.polygon.length < 3) return;
      if (f.polygon.length === 4) {
        const xs = f.polygon.map(p => p[0]), ys = f.polygon.map(p => p[1]);
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
        ctx.save(); drawPath();
        ctx.strokeStyle = isInGroup ? 'rgba(96,165,250,0.18)' : `rgba(${r},${g},${b},0.18)`;
        ctx.lineWidth = 8; ctx.setLineDash([]); ctx.stroke(); ctx.restore();
      }
      drawPath();
      ctx.strokeStyle = `rgba(${r},${g},${b},${isSelected || isInGroup ? 1 : 0.85})`;
      ctx.lineWidth   = isSelected ? 2.5 : isInGroup ? 2 : 1.6;
      ctx.setLineDash([]); ctx.stroke();
    });
  }, [fills, hiddenIds, selectedId, selectedGroup, pdfDimensions]);

  useEffect(() => { redrawPolygons(); }, [redrawPolygons]);

  // ── Animation loop (crosshair) ────────────────────────────────────────────
  useEffect(() => {
    const ic = interactRef.current;
    if (!ic || !active || !pdfDimensions) {
      cancelAnimationFrame(animRef.current);
      ic?.getContext('2d')?.clearRect(0, 0, ic.width, ic.height);
      return;
    }
    const loop = () => {
      pulseRef.current += 0.06;
      const ctx = ic.getContext('2d')!;
      ctx.clearRect(0, 0, ic.width, ic.height);

      if (cursorRef.current) {
        const { x, y } = cursorRef.current;
        const alpha = 0.28 + 0.18 * Math.sin(pulseRef.current);
        const [r, g, b] = hexToRgb(isLassoing ? activeColor : '#f59e0b');

        ctx.save();
        ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.lineWidth   = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(ic.width, y); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ic.height); ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${r},${g},${b},${0.5 + 0.4 * Math.sin(pulseRef.current)})`;
        ctx.fill();
        ctx.restore();
      }
      animRef.current = requestAnimationFrame(loop);
    };
    animRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animRef.current);
  }, [active, pdfDimensions, isLassoing, activeColor]);

  // ── Coordinate helper ─────────────────────────────────────────────────────
  //
  //  FIX: Use pdfDimensions.w / rect.width (not canvas.width / rect.width).
  //  pdfDimensions.w is the stable logical canvas resolution.
  //  rect.width is the current CSS (zoomed) size.
  //  Their ratio converts CSS-pixel offsets into logical PDF pixels
  //  regardless of zoom level.
  //
  const getXY = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const w = pdfDimensions?.w ?? rect.width;
    const h = pdfDimensions?.h ?? rect.height;
    return {
      x: (e.clientX - rect.left) * (w / rect.width),
      y: (e.clientY - rect.top)  * (h / rect.height),
    };
  }, [pdfDimensions]);

  // ── Pointer down ──────────────────────────────────────────────────────────
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const { x, y } = getXY(e);
    pointerDownPos.current = { x, y };
    hasMoved.current       = false;

    // ── Space held → lasso vertex placement ───────────────────────────────
    if (spaceHeldRef.current || isLassoing) {
      const current = lassoRef.current;

      if (current.length === 0) {
        const pts: [number, number][] = [[x, y]];
        lassoRef.current = pts;
        setLassoPoints(pts);
        setIsLassoing(true);
        return;
      }

      // check close-snap
      if (current.length >= 3) {
        const dist = Math.hypot(x - current[0][0], y - current[0][1]);
        if (dist < CLOSE_SNAP_RADIUS) {
          onPolygonLasso(current);
          lassoRef.current = [];
          setLassoPoints([]);
          setIsLassoing(false);
          setLassoMouse(null);
          return;
        }
      }

      // add vertex
      const pts: [number, number][] = [...current, [x, y]];
      lassoRef.current = pts;
      setLassoPoints(pts);
    }
    // non-lasso: handled on pointer-up
  }, [getXY, isLassoing, onPolygonLasso]);

  // ── Pointer move ──────────────────────────────────────────────────────────
  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = getXY(e);
    cursorRef.current = { x, y };
    onHover(x, y);

    if (isLassoing) {
      setLassoMouse([x, y]);
      return;
    }

    if (pointerDownPos.current) {
      const dx = Math.abs(x - pointerDownPos.current.x);
      const dy = Math.abs(y - pointerDownPos.current.y);
      if (dx > 4 || dy > 4) hasMoved.current = true;
    }
  }, [getXY, onHover, isLassoing]);

  // ── Pointer up ────────────────────────────────────────────────────────────
  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (isLassoing) return;
    if (!pointerDownPos.current) return;

    const { x, y } = getXY(e);
    if (!hasMoved.current) {
      onSingleClick(x, y);
    }
    pointerDownPos.current = null;
    hasMoved.current       = false;
  }, [getXY, onSingleClick, isLassoing]);

  const handlePointerLeave = useCallback(() => {
    cursorRef.current = null;
    if (isLassoing) setLassoMouse(null);
    onHoverLeave();
  }, [onHoverLeave, isLassoing]);

  if (!active || !pdfDimensions) return null;

  const { w, h } = pdfDimensions;

  return (
    <>
      {/* Layer 42: committed fill polygon outlines */}
      <canvas
        ref={polyRef}
        style={{
          position:      'absolute',
          inset:         0,
          width:         `${w}px`,
          height:        `${h}px`,
          zIndex:        42,
          pointerEvents: 'none',
        }}
      />

      {/* Layer 43: lasso-in-progress overlay */}
      {(isLassoing || lassoPoints.length > 0) && (
        <LassoOverlay
          points={lassoPoints}
          mousePos={lassoMouse}
          activeColor={activeColor}
          width={w}
          height={h}
        />
      )}

      {/* Layer 45: crosshair + interaction
          CRITICAL: This canvas must be exactly w×h in both bitmap and CSS
          so that pointer event coordinates map directly to PDF pixel space. */}
      <canvas
        ref={interactRef}
        style={{
          position:      'absolute',
          inset:         0,
          width:         `${w}px`,
          height:        `${h}px`,
          zIndex:        45,
          cursor:        isFilling ? 'wait' : 'crosshair',
          pointerEvents: isFilling ? 'none' : 'auto',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
      />

      {/* Lasso status banner */}
      {isLassoing && (
        <div style={{
          position:      'absolute',
          top:           10,
          left:          '50%',
          transform:     'translateX(-50%)',
          background:    'rgba(10,10,10,.9)',
          border:        `1px solid ${activeColor}`,
          padding:       '5px 16px',
          fontSize:      8,
          color:         activeColor,
          textTransform: 'uppercase',
          letterSpacing: '.1em',
          pointerEvents: 'none',
          zIndex:        50,
          display:       'flex',
          alignItems:    'center',
          gap:           8,
          fontFamily:    "'Courier New',monospace",
          whiteSpace:    'nowrap',
        }}>
          <span style={{ fontSize: 12, opacity: .7 }}>⬡</span>
          {lassoPoints.length < 3
            ? `Click to place vertices · ${lassoPoints.length} placed`
            : `${lassoPoints.length} vertices · click near ① to close · Esc to cancel`
          }
        </div>
      )}

      {/* Space-held hint (not yet lassoing) */}
      {spaceHeld && !isLassoing && !isFilling && (
        <div style={{
          position:      'absolute',
          top:           10,
          left:          '50%',
          transform:     'translateX(-50%)',
          background:    'rgba(10,10,10,.85)',
          border:        '1px solid #60a5fa',
          padding:       '4px 14px',
          fontSize:      8,
          color:         '#60a5fa',
          textTransform: 'uppercase',
          letterSpacing: '.1em',
          pointerEvents: 'none',
          zIndex:        50,
          fontFamily:    "'Courier New',monospace",
          whiteSpace:    'nowrap',
        }}>
          Polygon lasso — click to start placing vertices
        </div>
      )}
    </>
  );
}
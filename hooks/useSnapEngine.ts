'use client';

/**
 * useSnapEngine
 *
 * Owns the pin-canvas overlay: drawing all lines, arcs, snap points, the
 * hover highlight, the active snap crosshair, the linear chain, and the
 * selected entity indicator.
 *
 * It does NOT own pointer events — the page component handles those and
 * calls into this hook via the returned imperative API.
 */

import { useCallback, useRef, useState, useEffect } from 'react';
import type {
  SnapPoint,
  SnapPointType,
  PdfLine,
  PdfCurve,
  PdfDimensions,
  SelectedEntity,
  ChainPoint,
} from '@/types/snapTypes';

// ─── Public return type ───────────────────────────────────────────────────────

export interface UseSnapEngineReturn {
  /** Current snap result for the cursor position */
  snapResult: SnapResult;
  /** Linear measurement chain */
  linearChain: ChainPoint[];
  /** Currently selected entity */
  selected: SelectedEntity | null;
  /** Mutable ref for cursor canvas-space position, updated by the page */
  cursorPointRef: React.MutableRefObject<{ x: number; y: number } | null>;
  /** Redraws the full pin canvas — call after any state change or pan/zoom */
  redrawPinCanvas: () => void;
  /** Snap the given canvas-space point to the nearest snap point */
  snapToCorner: (x: number, y: number) => SnapResult;
  /** Hit-test lines/curves/snaps and set selection; returns true on hit */
  selectAt: (x: number, y: number) => boolean;
  /** Clear selection */
  clearSelection: () => void;
  /** Add a point to the chain */
  addChainPoint: (x: number, y: number, type: SnapPointType | 'free') => void;
  /** Remove last chain point */
  undoChainPoint: () => void;
  /** Clear entire chain */
  clearChain: () => void;
}

export interface SnapResult {
  snapped: boolean;
  point: { x: number; y: number };
  type: SnapPointType | null;
}

// ─── Config ───────────────────────────────────────────────────────────────────

interface UseSnapEngineOptions {
  pinCanvasRef: React.RefObject<HTMLCanvasElement>;
  viewportRef: React.RefObject<HTMLDivElement>;
  dimsRef: React.RefObject<PdfDimensions | null>;
  snapEnabled: boolean;
  showPins: boolean;
  showGeometry: boolean;
  snapThreshold: number; // screen px
  snapPoints: SnapPoint[];
  lines: PdfLine[];
  curves: PdfCurve[];
  linearMode: boolean;
  zoom: number;
  pan: { x: number; y: number };
}

// ─── Colours (mirrors SnapSidebar) ────────────────────────────────────────────

const SNAP_COLOURS: Record<SnapPointType, string> = {
  endpoint:     '#f59e0b',
  midpoint:     '#10b981',
  centroid:     '#8b5cf6',
  intersection: '#f43f5e',
  'curve-node': '#38bdf8',
};

const LINE_COLOUR_DIM    = 'rgba(56,189,248,0.15)';
const LINE_COLOUR_HOVER  = '#38bdf8';
const CURVE_COLOUR_DIM   = 'rgba(167,139,250,0.15)';
const CURVE_COLOUR_HOVER = '#a78bfa';
const CHAIN_COLOUR       = '#a78bfa';
const SELECT_COLOUR      = '#ffffff';

// ─── Hit-test helpers (canvas-space) ─────────────────────────────────────────

function distToSegment(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function distToArc(
  px: number, py: number,
  cx: number, cy: number,
  r: number,
): number {
  return Math.abs(Math.hypot(px - cx, py - cy) - r);
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useSnapEngine(opts: UseSnapEngineOptions): UseSnapEngineReturn {
  const {
    pinCanvasRef, viewportRef, dimsRef,
    snapEnabled, showPins, showGeometry,
    snapThreshold, snapPoints, lines, curves,
    zoom, pan,
  } = opts;

  const [linearChain, setLinearChain] = useState<ChainPoint[]>([]);
  const [selected, setSelected]       = useState<SelectedEntity | null>(null);

  const cursorPointRef = useRef<{ x: number; y: number } | null>(null);

  // Keep stable refs so redrawPinCanvas closure doesn't go stale
  const optsRef = useRef(opts);
  useEffect(() => { optsRef.current = opts; }, [opts]);

  const linearChainRef = useRef(linearChain);
  useEffect(() => { linearChainRef.current = linearChain; }, [linearChain]);

  const selectedRef = useRef(selected);
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  // ── Canvas coordinate helpers ─────────────────────────────────────────────

  /** canvas-pt → screen-px */
  const toScreen = useCallback(
    (x: number, y: number) => ({
      sx: pan.x + x * zoom,
      sy: pan.y + y * zoom,
    }),
    [pan, zoom],
  );

  // ── redrawPinCanvas ───────────────────────────────────────────────────────

  const redrawPinCanvas = useCallback(() => {
    const canvas  = pinCanvasRef.current;
    const vp      = viewportRef.current;
    const dims    = optsRef.current.dimsRef.current;
    if (!canvas || !vp) return;

    const vr = vp.getBoundingClientRect();
    canvas.width  = vr.width;
    canvas.height = vr.height;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!dims) return;

    const { snapPoints, lines, curves, showGeometry, showPins, snapEnabled, snapThreshold } = optsRef.current;
    const cur     = cursorPointRef.current; // canvas-space
    const chain   = linearChainRef.current;
    const sel     = selectedRef.current;

    const toSc = (x: number, y: number) => ({
      sx: optsRef.current.pan.x + x * optsRef.current.zoom,
      sy: optsRef.current.pan.y + y * optsRef.current.zoom,
    });
    const z = optsRef.current.zoom;
    const HIT = snapThreshold;

    // ── 1. Geometry layer (lines + curves) ──────────────────────────────────

    if (showGeometry) {
      // Lines
      for (const line of lines) {
        const [a, b] = line.vertices;
        const sa = toSc(a.x, a.y);
        const sb = toSc(b.x, b.y);

        const hovered = cur
          ? distToSegment(cur.x * z + optsRef.current.pan.x,
                          cur.y * z + optsRef.current.pan.y,
                          sa.sx, sa.sy, sb.sx, sb.sy) < HIT
          : false;

        const isSelected = sel?.kind === 'line' && sel.sourceId === line.id;

        ctx.beginPath();
        ctx.moveTo(sa.sx, sa.sy);
        ctx.lineTo(sb.sx, sb.sy);
        ctx.strokeStyle = isSelected ? SELECT_COLOUR : hovered ? LINE_COLOUR_HOVER : LINE_COLOUR_DIM;
        ctx.lineWidth   = isSelected || hovered ? 1.5 : 0.75;
        ctx.setLineDash([]);
        ctx.stroke();

        if (hovered || isSelected) {
          // Endpoint dots
          for (const v of [a, b]) {
            const sv = toSc(v.x, v.y);
            ctx.beginPath();
            ctx.arc(sv.sx, sv.sy, 4, 0, Math.PI * 2);
            ctx.fillStyle = '#f59e0b';
            ctx.fill();
          }
          // Length label
          const mx = (sa.sx + sb.sx) / 2;
          const my = (sa.sy + sb.sy) / 2;
          ctx.font = '10px monospace';
          ctx.fillStyle = LINE_COLOUR_HOVER;
          ctx.fillText(`${line.length.toFixed(1)} pt`, mx + 6, my - 4);
        }
      }

      // ── Curves / arcs ────────────────────────────────────────────────────
      // FIX: Render using the original bezier control points stored on each
      // curve, instead of reconstructing with ctx.arc(). This avoids the
      // major-arc vs minor-arc ambiguity that caused the purple ghost circles
      // to fill the wrong side of the arc.
      for (const curve of curves) {
        const sc = toSc(curve.center.x, curve.center.y);
        const sr = curve.radius * z;

        // Hit-test still uses the fitted circle (fast and correct for proximity)
        const hovered = cur
          ? distToArc(
              cur.x * z + optsRef.current.pan.x,
              cur.y * z + optsRef.current.pan.y,
              sc.sx, sc.sy, sr,
            ) < HIT
          : false;

        const isSelected = sel?.kind === 'curve' && sel.sourceId === curve.id;

        ctx.beginPath();

        if (curve.bezier) {
          // ── Preferred path: draw the exact original bezier ──────────────
          // The bezier was stored in canvas-space (already transformed by the
          // viewport matrix in the worker), so we only need to apply the
          // current pan+zoom to go from canvas-space → screen-space.
          const { p0, p1, p2, p3 } = curve.bezier;
          const s0 = toSc(p0.x, p0.y);
          const s1 = toSc(p1.x, p1.y);
          const s2 = toSc(p2.x, p2.y);
          const s3 = toSc(p3.x, p3.y);
          ctx.moveTo(s0.sx, s0.sy);
          ctx.bezierCurveTo(s1.sx, s1.sy, s2.sx, s2.sy, s3.sx, s3.sy);
        } else {
          // ── Fallback: reconstruct arc from fitted parameters ─────────────
          // Determine the shorter sweep direction so we draw the minor arc,
          // not the major arc (the original bug).
          const startRad = (curve.startAngle * Math.PI) / 180;
          const endRad   = curve.isCircle
            ? startRad + 2 * Math.PI
            : (curve.endAngle * Math.PI) / 180;

          // Normalise sweep to [0, 2π) then pick the shorter direction
          const sweep = ((endRad - startRad) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
          const anticlockwise = !curve.isCircle && sweep > Math.PI;

          ctx.arc(sc.sx, sc.sy, sr, startRad, endRad, anticlockwise);
        }

        ctx.strokeStyle = isSelected ? SELECT_COLOUR : hovered ? CURVE_COLOUR_HOVER : CURVE_COLOUR_DIM;
        ctx.lineWidth   = isSelected || hovered ? 1.5 : 0.75;
        ctx.setLineDash([]);
        ctx.stroke();

        if (hovered || isSelected) {
          // Center dot
          ctx.beginPath();
          ctx.arc(sc.sx, sc.sy, 3, 0, Math.PI * 2);
          ctx.fillStyle = CURVE_COLOUR_HOVER;
          ctx.fill();
          // Radius label
          ctx.font = '10px monospace';
          ctx.fillStyle = CURVE_COLOUR_HOVER;
          ctx.fillText(`r=${curve.radius.toFixed(1)}`, sc.sx + sr + 4, sc.sy - 2);
        }
      }
    }

    // ── 2. Snap points ────────────────────────────────────────────────────────

    if (showPins) {
      for (const sp of snapPoints) {
        const px = sp.nx * dims.w;
        const py = sp.ny * dims.h;
        const sv = toSc(px, py);

        const dist = cur ? Math.hypot(cur.x - px, cur.y - py) * z : Infinity;
        const hovered = dist < HIT;
        const isSelected = sel?.kind === 'snap' && sel.sourceId === sp.sourceId &&
          Math.abs(sel.x - px) < 1 && Math.abs(sel.y - py) < 1;

        const col = SNAP_COLOURS[sp.type];

        ctx.beginPath();
        ctx.arc(sv.sx, sv.sy, hovered || isSelected ? 6 : 3, 0, Math.PI * 2);
        ctx.fillStyle   = col;
        ctx.globalAlpha = hovered || isSelected ? 1 : 0.45;
        ctx.fill();
        ctx.globalAlpha = 1;

        if (hovered || isSelected) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth   = 1;
          ctx.stroke();
          ctx.font      = '10px monospace';
          ctx.fillStyle = col;
          ctx.fillText(sp.type, sv.sx + 9, sv.sy + 4);
        }
      }
    }

    // ── 3. Linear chain ───────────────────────────────────────────────────────

    if (chain.length > 0) {
      // Lines between chain points
      ctx.beginPath();
      for (let i = 0; i < chain.length; i++) {
        const sv = toSc(chain[i].x, chain[i].y);
        if (i === 0) ctx.moveTo(sv.sx, sv.sy);
        else ctx.lineTo(sv.sx, sv.sy);
      }
      ctx.strokeStyle = CHAIN_COLOUR;
      ctx.lineWidth   = 1;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Point markers
      chain.forEach((p, i) => {
        const sv = toSc(p.x, p.y);
        const col = p.type !== 'free' ? SNAP_COLOURS[p.type as SnapPointType] : '#f59e0b';

        ctx.beginPath();
        ctx.arc(sv.sx, sv.sy, 5, 0, Math.PI * 2);
        ctx.fillStyle   = col;
        ctx.globalAlpha = 0.9;
        ctx.fill();
        ctx.globalAlpha = 1;

        // Index label
        ctx.font      = '9px monospace';
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), sv.sx, sv.sy);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';

        // Distance label between consecutive points
        if (i > 0) {
          const prev = chain[i - 1];
          const dist = Math.hypot(p.x - prev.x, p.y - prev.y);
          const mx = (toSc(prev.x, prev.y).sx + sv.sx) / 2;
          const my = (toSc(prev.x, prev.y).sy + sv.sy) / 2;
          ctx.font      = '9px monospace';
          ctx.fillStyle = CHAIN_COLOUR;
          ctx.fillText(`${dist.toFixed(1)}`, mx + 4, my - 4);
        }
      });
    }

    // ── 4. Snap crosshair (nearest snap when cursor is active) ────────────────

    if (cur && snapEnabled) {
      const result = findNearestSnap(cur.x, cur.y, snapPoints, dims, HIT / z);
      if (result.snapped) {
        const sv = toSc(result.point.x, result.point.y);
        const col = result.type ? SNAP_COLOURS[result.type] : '#f59e0b';
        const R = 10;

        ctx.strokeStyle = col;
        ctx.lineWidth   = 1;
        // Crosshair lines
        ctx.beginPath();
        ctx.moveTo(sv.sx - R, sv.sy); ctx.lineTo(sv.sx + R, sv.sy);
        ctx.moveTo(sv.sx, sv.sy - R); ctx.lineTo(sv.sx, sv.sy + R);
        ctx.stroke();
        // Circle
        ctx.beginPath();
        ctx.arc(sv.sx, sv.sy, R * 0.6, 0, Math.PI * 2);
        ctx.stroke();
        // Type label
        ctx.font      = '9px monospace';
        ctx.fillStyle = col;
        ctx.fillText(result.type ?? '', sv.sx + R + 3, sv.sy - 2);
      }
    }
  }, [pinCanvasRef, viewportRef]);

  // ── findNearestSnap (pure, used in redraw + snapToCorner) ─────────────────

  const findNearestSnap = useCallback((
    cx: number, cy: number,
    pts: SnapPoint[],
    dims: PdfDimensions,
    thresholdPt: number,
  ): SnapResult => {
    let best: SnapResult = { snapped: false, point: { x: cx, y: cy }, type: null };
    let bestDist = Infinity;

    for (const sp of pts) {
      const px = sp.nx * dims.w;
      const py = sp.ny * dims.h;
      const d  = Math.hypot(cx - px, cy - py);
      if (d < thresholdPt && d < bestDist) {
        bestDist = d;
        best = { snapped: true, point: { x: px, y: py }, type: sp.type };
      }
    }
    return best;
  }, []);

  // ── snapToCorner ───────────────────────────────────────────────────────────

  const snapToCorner = useCallback((x: number, y: number): SnapResult => {
    const dims = dimsRef.current;
    if (!dims || !snapEnabled) return { snapped: false, point: { x, y }, type: null };
    return findNearestSnap(x, y, snapPoints, dims, snapThreshold / zoom);
  }, [dimsRef, snapEnabled, snapPoints, snapThreshold, zoom, findNearestSnap]);

  // ── selectAt ──────────────────────────────────────────────────────────────

  const selectAt = useCallback((cx: number, cy: number): boolean => {
    const dims = dimsRef.current;
    if (!dims) return false;

    const HIT_PT = snapThreshold / zoom; // threshold in canvas-pt
    const z = zoom;
    const p = optsRef.current.pan;

    const toSx = (x: number) => p.x + x * z;
    const toSy = (y: number) => p.y + y * z;
    const HIT_PX = snapThreshold;

    // Check snap points first (highest priority)
    for (const sp of snapPoints) {
      const px = sp.nx * dims.w;
      const py = sp.ny * dims.h;
      if (Math.hypot(cx - px, cy - py) < HIT_PT) {
        setSelected({
          kind: 'snap',
          sourceId: sp.sourceId,
          x: px, y: py,
          strokeWidth: sp.strokeWidth,
          snapType: sp.type,
        });
        return true;
      }
    }

    // Lines
    for (const line of lines) {
      const [a, b] = line.vertices;
      const d = distToSegment(
        toSx(cx), toSy(cy),
        toSx(a.x), toSy(a.y),
        toSx(b.x), toSy(b.y),
      );
      if (d < HIT_PX) {
        setSelected({
          kind: 'line',
          sourceId: line.id,
          x: (a.x + b.x) / 2,
          y: (a.y + b.y) / 2,
          strokeWidth: line.strokeWidth,
          length: line.length,
        });
        return true;
      }
    }

    // Curves
    for (const curve of curves) {
      const sc_x = toSx(curve.center.x);
      const sc_y = toSy(curve.center.y);
      const sr   = curve.radius * z;
      if (distToArc(toSx(cx), toSy(cy), sc_x, sc_y, sr) < HIT_PX) {
        setSelected({
          kind: 'curve',
          sourceId: curve.id,
          x: curve.center.x,
          y: curve.center.y,
          strokeWidth: curve.strokeWidth,
          approxLength: curve.approxLength,
        });
        return true;
      }
    }

    // Miss — clear selection
    setSelected(null);
    return false;
  }, [dimsRef, snapPoints, lines, curves, snapThreshold, zoom]);

  // ── Chain operations ───────────────────────────────────────────────────────

  const addChainPoint = useCallback((x: number, y: number, type: SnapPointType | 'free') => {
    setLinearChain((prev) => [...prev, { x, y, type }]);
  }, []);

  const undoChainPoint = useCallback(() => {
    setLinearChain((prev) => prev.slice(0, -1));
  }, []);

  const clearChain = useCallback(() => setLinearChain([]), []);
  const clearSelection = useCallback(() => setSelected(null), []);

  // ── snapResult (latest snap for cursor) ────────────────────────────────────
  const snapResult: SnapResult = { snapped: false, point: { x: 0, y: 0 }, type: null };

  return {
    snapResult,
    linearChain,
    selected,
    cursorPointRef,
    redrawPinCanvas,
    snapToCorner,
    selectAt,
    clearSelection,
    addChainPoint,
    undoChainPoint,
    clearChain,
  };
}
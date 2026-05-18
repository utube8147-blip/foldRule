// ─── hooks/useWallLineInteraction.ts ─────────────────────────────────────────
//
//  Manages interactive wall-line selection on the pin canvas:
//
//  HOVER  — highlights the nearest wall line within HOVER_RADIUS px;
//           draws a tooltip with the calibrated length (scaleFactor applied).
//
//  CLICK  — only active when activeTool === 'select'.
//           First click  → starts a chain with that segment.
//           Subsequent   → if the new segment shares an endpoint with the last
//                          one (within ENDPOINT_SNAP px) it chains directly;
//                          otherwise it force-connects from the last endpoint.
//           Running amber HUD shows total chained length.
//
//  COMMIT — Right-click OR Enter key → opens a lightweight type-picker dialog
//           (Linear / Area / Polygon) then calls batchCommitMeasurements.
//
//  ESC    — clears the chain without committing.
//
//  Rendering is done entirely on the existing pinCanvasRef layer — no new DOM.
//
// ─────────────────────────────────────────────────────────────────────────────

import { useRef, useState, useCallback, useEffect } from 'react';
import type React from 'react';
import type { PdfDimensions } from '@/types/viewerTypes';
import type { TakeoffRow } from '@/types';

// ── Scaled wall line (canvas-pixel space) ────────────────────────────────────
export interface ScaledWallLine {
  x1: number; y1: number;
  x2: number; y2: number;
  angle: number;
  length: number; // raw pixel length
}

// ── A single chained segment ─────────────────────────────────────────────────
export interface ChainedSegment {
  line: ScaledWallLine;
  /** The endpoint of this segment that connects TO the next one */
  entryPoint:  { x: number; y: number };
  exitPoint:   { x: number; y: number };
}

// ── Public state exposed to Viewer ───────────────────────────────────────────
export interface WallChainState {
  segments:     ChainedSegment[];
  totalLengthM: number; // calibrated metres
  isActive:     boolean;
}

// ── Return type ──────────────────────────────────────────────────────────────
export interface UseWallLineInteractionReturn {
  chainState:              WallChainState;
  hoveredLineIndex:        number | null;
  /** Call from the pin canvas mousemove handler */
  handleWallMouseMove:     (canvasX: number, canvasY: number) => void;
  /** Call from the drawing canvas click handler (select tool only) */
  handleWallClick:         (canvasX: number, canvasY: number) => void;
  /** Call from the drawing canvas contextmenu handler */
  handleWallContextMenu:   () => void;
  /** Wire to window keydown */
  handleWallKeyDown:       (e: KeyboardEvent) => void;
  /** Draws wall lines + chain + tooltip onto the pin canvas */
  drawWallOverlay:         (ctx: CanvasRenderingContext2D) => void;
  /** True when the commit-type dialog should be shown */
  showCommitDialog:        boolean;
  commitChain:             (type: 'Length' | 'Area' | 'Polygon', label: string) => void;
  cancelCommitDialog:      () => void;
  clearChain:              () => void;
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

function ptSegDist(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number,
): number {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function segPixelLength(l: ScaledWallLine): number {
  return Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
}

const ENDPOINT_SNAP = 18; // px — two endpoints are "shared" if this close
const HOVER_RADIUS  = 14; // px — max distance cursor→line to highlight

function nearestEndpoint(
  line: ScaledWallLine,
  refX: number, refY: number,
): { x: number; y: number } {
  const d1 = Math.hypot(line.x1 - refX, line.y1 - refY);
  const d2 = Math.hypot(line.x2 - refX, line.y2 - refY);
  return d1 <= d2 ? { x: line.x1, y: line.y1 } : { x: line.x2, y: line.y2 };
}

function farEndpoint(
  line: ScaledWallLine,
  nearX: number, nearY: number,
): { x: number; y: number } {
  const d1 = Math.hypot(line.x1 - nearX, line.y1 - nearY);
  const d2 = Math.hypot(line.x2 - nearX, line.y2 - nearY);
  return d1 <= d2 ? { x: line.x2, y: line.y2 } : { x: line.x1, y: line.y1 };
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export interface UseWallLineInteractionParams {
  pinCanvasRef:      React.RefObject<HTMLCanvasElement>;
  pdfDimensionsRef:  React.RefObject<PdfDimensions | null>;
  pageNumberRef:     React.RefObject<number>;
  activeTool:        string;
  scaleFactor:       number;
  getScaledWallLines: (pageIdx: number) => ScaledWallLine[];
  commitMeasurement:  (m: TakeoffRow) => void;
  activeDrawingId:    string | null;
  /** After committing, re-draw the pin canvas normally */
  redrawPinCanvas:    () => void;
}

export function useWallLineInteraction({
  pinCanvasRef,
  pdfDimensionsRef,
  pageNumberRef,
  activeTool,
  scaleFactor,
  getScaledWallLines,
  commitMeasurement,
  activeDrawingId,
  redrawPinCanvas,
}: UseWallLineInteractionParams): UseWallLineInteractionReturn {

  // ── Refs ─────────────────────────────────────────────────────────────────
  const activeToolRef  = useRef(activeTool);
  const scaleFactorRef = useRef(scaleFactor);
  useEffect(() => { activeToolRef.current  = activeTool;   }, [activeTool]);
  useEffect(() => { scaleFactorRef.current = scaleFactor;  }, [scaleFactor]);

  const cursorRef = useRef<{ x: number; y: number } | null>(null);

  // ── State ─────────────────────────────────────────────────────────────────
  const [hoveredIdx,        setHoveredIdx]        = useState<number | null>(null);
  const [chainSegments,     setChainSegments]      = useState<ChainedSegment[]>([]);
  const [showCommitDialog,  setShowCommitDialog]   = useState(false);

  const chainRef = useRef<ChainedSegment[]>([]);
  const syncChain = useCallback((segs: ChainedSegment[]) => {
    chainRef.current = segs;
    setChainSegments([...segs]);
  }, []);

  // ── Calibrated total ──────────────────────────────────────────────────────
  const totalLengthM = useCallback((segs: ChainedSegment[]): number => {
    const sf = scaleFactorRef.current;
    if (!sf || sf === 0) return 0;
    const px = segs.reduce((sum, s) => sum + segPixelLength(s.line), 0);
    return px * sf;
  }, []);

  // ── handleWallMouseMove ───────────────────────────────────────────────────
  const handleWallMouseMove = useCallback((cx: number, cy: number) => {
    cursorRef.current = { x: cx, y: cy };
    const lines = getScaledWallLines(pageNumberRef.current);
    let bestIdx  = -1;
    let bestDist = HOVER_RADIUS;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const d = ptSegDist(cx, cy, l.x1, l.y1, l.x2, l.y2);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    setHoveredIdx(bestIdx === -1 ? null : bestIdx);
  }, [getScaledWallLines, pageNumberRef]);

  // ── handleWallClick ───────────────────────────────────────────────────────
  const handleWallClick = useCallback((cx: number, cy: number) => {
    if (activeToolRef.current !== 'select') return;

    const lines = getScaledWallLines(pageNumberRef.current);
    let bestIdx  = -1;
    let bestDist = HOVER_RADIUS * 2; // slightly more generous for click
    for (let i = 0; i < lines.length; i++) {
      const d = ptSegDist(cx, cy, lines[i].x1, lines[i].y1, lines[i].x2, lines[i].y2);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    if (bestIdx === -1) return;

    const clicked = lines[bestIdx];
    const current = chainRef.current;

    if (current.length === 0) {
      // Start chain — entry at nearest endpoint to click, exit at far end
      const entry = nearestEndpoint(clicked, cx, cy);
      const exit  = farEndpoint(clicked, entry.x, entry.y);
      syncChain([{ line: clicked, entryPoint: entry, exitPoint: exit }]);
      return;
    }

    // Subsequent segment — try to share endpoint with last exit
    const lastExit = current[current.length - 1].exitPoint;
    const sharedNear = nearestEndpoint(clicked, lastExit.x, lastExit.y);
    const sharedDist = Math.hypot(sharedNear.x - lastExit.x, sharedNear.y - lastExit.y);

    let entry: { x: number; y: number };
    if (sharedDist <= ENDPOINT_SNAP) {
      // Common point found — chain naturally
      entry = sharedNear;
    } else {
      // No common point — force-connect from last exit
      entry = lastExit;
    }
    const exit = farEndpoint(clicked, entry.x, entry.y);
    syncChain([...current, { line: clicked, entryPoint: entry, exitPoint: exit }]);
  }, [getScaledWallLines, pageNumberRef, syncChain]);

  // ── handleWallContextMenu (trigger commit dialog) ─────────────────────────
  const handleWallContextMenu = useCallback(() => {
    if (chainRef.current.length === 0) return;
    setShowCommitDialog(true);
  }, []);

  // ── handleWallKeyDown ─────────────────────────────────────────────────────
  const handleWallKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      syncChain([]);
      setShowCommitDialog(false);
      return;
    }
    if (e.key === 'Enter' && chainRef.current.length > 0) {
      setShowCommitDialog(true);
    }
  }, [syncChain]);

  // ── clearChain ────────────────────────────────────────────────────────────
  const clearChain = useCallback(() => {
    syncChain([]);
    setShowCommitDialog(false);
  }, [syncChain]);

  // ── commitChain ───────────────────────────────────────────────────────────
  const commitChain = useCallback((
    type: 'Length' | 'Area' | 'Polygon',
    label: string,
  ) => {
    const segs = chainRef.current;
    if (segs.length === 0) return;

    const sf    = scaleFactorRef.current;
    const total = totalLengthM(segs);

    // Build normalised points array from the chain
    const dims = pdfDimensionsRef.current;
    const points: Array<{ x: number; y: number }> = [];
    if (dims && dims.w > 0 && dims.h > 0) {
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        if (i === 0) {
          points.push({ x: s.entryPoint.x / dims.w, y: s.entryPoint.y / dims.h });
        }
        points.push({ x: s.exitPoint.x / dims.w, y: s.exitPoint.y / dims.h });
      }
    }

    const row: TakeoffRow = {
      id:          `wall-chain-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      drawingId:   activeDrawingId ?? '',
      description: label || 'Wall Chain',
      type:        type === 'Length' ? 'Length' : type === 'Area' ? 'Area' : 'Polygon',
      quantity:    parseFloat(total.toFixed(3)),
      unit:        type === 'Area' ? 'm²' : 'm',
      unitRate:    0,
      notes:       `${segs.length} segment(s) chained from wall detection`,
      childIds:    [],
      points,
      isOverridden: false,
      color:       '#F59E0B',
      isVisible:   true,
    };

    commitMeasurement(row);
    syncChain([]);
    setShowCommitDialog(false);
    redrawPinCanvas();
  }, [
    totalLengthM, pdfDimensionsRef, activeDrawingId,
    commitMeasurement, syncChain, redrawPinCanvas,
  ]);

  const cancelCommitDialog = useCallback(() => {
    setShowCommitDialog(false);
  }, []);

  // ── drawWallOverlay ───────────────────────────────────────────────────────
  // Called by Viewer's redrawPinCanvas replacement — draws on top of the
  // normal pin canvas content.
  const drawWallOverlay = useCallback((ctx: CanvasRenderingContext2D) => {
    const lines  = getScaledWallLines(pageNumberRef.current);
    const cursor = cursorRef.current;
    const segs   = chainRef.current;
    const sf     = scaleFactorRef.current;

    const chainedSet = new Set(segs.map(s => s.line));

    // ── 1. Draw all wall lines (dim, always visible) ──────────────────────
    for (let i = 0; i < lines.length; i++) {
      const l        = lines[i];
      const isHover  = i === (cursor ? (() => {
        // inline hovered index from cursor
        let bi = -1, bd = HOVER_RADIUS;
        for (let j = 0; j < lines.length; j++) {
          const d = ptSegDist(cursor.x, cursor.y, lines[j].x1, lines[j].y1, lines[j].x2, lines[j].y2);
          if (d < bd) { bd = d; bi = j; }
        }
        return bi;
      })() : -1);
      const isChained = chainedSet.has(l);

      if (isChained) {
        // Amber — part of chain
        ctx.beginPath();
        ctx.moveTo(l.x1, l.y1);
        ctx.lineTo(l.x2, l.y2);
        ctx.strokeStyle = '#F59E0B';
        ctx.lineWidth   = 2.5;
        ctx.setLineDash([]);
        ctx.stroke();
      } else if (isHover) {
        // Bright green highlight on hover
        ctx.beginPath();
        ctx.moveTo(l.x1, l.y1);
        ctx.lineTo(l.x2, l.y2);
        ctx.strokeStyle = '#34D399';
        ctx.lineWidth   = 2.5;
        ctx.setLineDash([]);
        ctx.stroke();

        // Endpoint dots
        for (const pt of [{ x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 }]) {
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
          ctx.fillStyle = '#34D399';
          ctx.fill();
        }

        // Calibrated length tooltip
        if (cursor) {
          const lenPx = segPixelLength(l);
          const lenM  = sf > 0 ? lenPx * sf : 0;
          const label = sf > 0
            ? `${lenM.toFixed(2)} m`
            : `${Math.round(lenPx)} px (not calibrated)`;

          const midX = (l.x1 + l.x2) / 2;
          const midY = (l.y1 + l.y2) / 2;
          const pad  = 6;
          ctx.font        = 'bold 11px monospace';
          const tw        = ctx.measureText(label).width;
          const bx        = midX - tw / 2 - pad;
          const by        = midY - 20 - pad;
          const bw        = tw + pad * 2;
          const bh        = 18 + pad;

          // Background pill
          ctx.fillStyle   = 'rgba(0,0,0,0.78)';
          ctx.beginPath();
          ctx.roundRect(bx, by, bw, bh, 4);
          ctx.fill();

          // Border
          ctx.strokeStyle = '#34D399';
          ctx.lineWidth   = 1;
          ctx.setLineDash([]);
          ctx.stroke();

          // Text
          ctx.fillStyle   = '#34D399';
          ctx.fillText(label, midX - tw / 2, by + bh - pad - 1);
        }

      } else {
        // Dim background lines (always visible so user can see the wall grid)
        ctx.beginPath();
        ctx.moveTo(l.x1, l.y1);
        ctx.lineTo(l.x2, l.y2);
        ctx.strokeStyle = 'rgba(52, 211, 153, 0.18)';
        ctx.lineWidth   = 1;
        ctx.setLineDash([5, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // ── 2. Draw chain connector line (amber dashed between segment exits) ──
    if (segs.length > 0) {
      ctx.beginPath();
      ctx.moveTo(segs[0].entryPoint.x, segs[0].entryPoint.y);
      for (const s of segs) {
        ctx.lineTo(s.exitPoint.x, s.exitPoint.y);
      }
      ctx.strokeStyle = '#F59E0B';
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Entry dot (green circle)
      ctx.beginPath();
      ctx.arc(segs[0].entryPoint.x, segs[0].entryPoint.y, 5, 0, Math.PI * 2);
      ctx.fillStyle   = '#34D399';
      ctx.fill();
      ctx.strokeStyle = 'white';
      ctx.lineWidth   = 1.5;
      ctx.stroke();

      // Exit dot (amber circle)
      const last = segs[segs.length - 1];
      ctx.beginPath();
      ctx.arc(last.exitPoint.x, last.exitPoint.y, 5, 0, Math.PI * 2);
      ctx.fillStyle   = '#F59E0B';
      ctx.fill();
      ctx.strokeStyle = 'white';
      ctx.lineWidth   = 1.5;
      ctx.stroke();
    }

    // ── 3. Running total HUD near cursor ──────────────────────────────────
    if (segs.length > 0 && cursor) {
      const total = totalLengthM(segs);
      const hud   = sf > 0
        ? `Chain: ${segs.length} seg · ${total.toFixed(2)} m total — RClick/Enter to commit`
        : `Chain: ${segs.length} seg — RClick/Enter to commit`;

      const hx = cursor.x + 16;
      const hy = cursor.y - 28;
      ctx.font        = 'bold 10px monospace';
      const tw        = ctx.measureText(hud).width;
      const pad       = 6;

      ctx.fillStyle   = 'rgba(245,158,11,0.15)';
      ctx.strokeStyle = '#F59E0B';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.roundRect(hx - pad, hy - 12, tw + pad * 2, 20, 3);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#FCD34D';
      ctx.fillText(hud, hx, hy);
    }

  }, [getScaledWallLines, pageNumberRef, totalLengthM]);

  // ── Keyboard listener ─────────────────────────────────────────────────────
  useEffect(() => {
    window.addEventListener('keydown', handleWallKeyDown);
    return () => window.removeEventListener('keydown', handleWallKeyDown);
  }, [handleWallKeyDown]);

  // ── Public state ──────────────────────────────────────────────────────────
  const chainState: WallChainState = {
    segments:     chainSegments,
    totalLengthM: totalLengthM(chainSegments),
    isActive:     chainSegments.length > 0,
  };

  return {
    chainState,
    hoveredLineIndex:      hoveredIdx,
    handleWallMouseMove,
    handleWallClick,
    handleWallContextMenu,
    handleWallKeyDown,
    drawWallOverlay,
    showCommitDialog,
    commitChain,
    cancelCommitDialog,
    clearChain,
  };
}
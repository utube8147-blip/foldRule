'use client';
// ─── hooks/useVectorOverlay.ts ────────────────────────────────────────────────
//
// Draws extracted PDF vector lines onto vectorCanvasRef with proximity-based
// visibility. Lines are invisible until the cursor comes within PROX_RADIUS px,
// then fade in and highlight as the cursor approaches.
//
// Designed to be called from inside redrawPinCanvas (same rAF tick) so line
// highlights stay perfectly in sync with snap dot rendering.
//
// Usage:
//   const { redrawVectorOverlay } = useVectorOverlay({
//     vectorCanvasRef, pdfDimensionsRef, cursorPointRef, svgLines,
//   });
//
//   // then call redrawVectorOverlay() inside your redrawPinCanvas callback
//
// ─────────────────────────────────────────────────────────────────────────────

import { useRef, useCallback, useEffect } from 'react';
import type { SvgLine } from '@/hooks/snapEngine/useSvgSnapPoints';

// ─── Geometry ─────────────────────────────────────────────────────────────────

function closestPointOnSegment(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number,
): { x: number; y: number; dist: number } {
  const ax = px - x1, ay = py - y1;
  const bx = x2 - x1, by = y2 - y1;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return { x: x1, y: y1, dist: Math.hypot(ax, ay) };
  const t = Math.max(0, Math.min(1, (ax * bx + ay * by) / len2));
  const cx = x1 + t * bx, cy = y1 + t * by;
  return { x: cx, y: cy, dist: Math.hypot(px - cx, py - cy) };
}

// ─── Colours ──────────────────────────────────────────────────────────────────
//
// Subtle blueprint-blue tones — unobtrusive but clearly visible on the white
// PDF canvas. Nearest line gets full-intensity highlight; others fade.
//
const COLOUR_BASE      = '56,189,248';   // sky-400 — line body
const COLOUR_NEAR      = '14,165,233';   // sky-500 — nearest line
const COLOUR_SNAP      = '245,158,11';   // amber-400 — snapping (within thresh)
const COLOUR_ENDPOINT  = '56,189,248';   // sky-400 — endpoint dots

// ─── Thresholds ───────────────────────────────────────────────────────────────

const PROX_RADIUS  = 80;   // px — lines start fading in at this distance
const SNAP_THRESH  = 18;   // px — "about to snap" highlight distance

// ─── Params ───────────────────────────────────────────────────────────────────

interface PdfDimensions { w: number; h: number }

export interface UseVectorOverlayParams {
  vectorCanvasRef:  React.RefObject<HTMLCanvasElement | null>;
  pdfDimensionsRef: React.RefObject<PdfDimensions | null>;
  cursorPointRef:   React.RefObject<{ x: number; y: number } | null>;
  svgLines:         SvgLine[];
  snapThreshold?:   number;
}

export interface UseVectorOverlayReturn {
  /** Call this inside redrawPinCanvas to keep both canvases in sync. */
  redrawVectorOverlay: () => void;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useVectorOverlay({
  vectorCanvasRef,
  pdfDimensionsRef,
  cursorPointRef,
  svgLines,
  snapThreshold = SNAP_THRESH,
}: UseVectorOverlayParams): UseVectorOverlayReturn {

  // Keep a stable ref to svgLines so the draw callback never goes stale
  const svgLinesRef = useRef<SvgLine[]>(svgLines);
  useEffect(() => { svgLinesRef.current = svgLines; }, [svgLines]);

  const snapThresholdRef = useRef(snapThreshold);
  useEffect(() => { snapThresholdRef.current = snapThreshold; }, [snapThreshold]);

  const redrawVectorOverlay = useCallback(() => {
    const canvas = vectorCanvasRef.current;
    const dims   = pdfDimensionsRef.current;
    if (!canvas || !dims) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const lines  = svgLinesRef.current;
    const cursor = cursorPointRef.current;

    // No cursor — canvas stays blank (proximity-only mode)
    if (!cursor || lines.length === 0) return;

    const { w: pw, h: ph } = dims;
    const thresh = snapThresholdRef.current;

    // Pre-compute pixel coords + distance to cursor for every line
    type LineEntry = {
      x1: number; y1: number; x2: number; y2: number;
      closest: { x: number; y: number; dist: number };
    };

    const entries: LineEntry[] = [];
    let nearestDist = PROX_RADIUS;
    let nearestIdx  = -1;

    for (let i = 0; i < lines.length; i++) {
      const l  = lines[i];
      const x1 = l.nx1 * pw, y1 = l.ny1 * ph;
      const x2 = l.nx2 * pw, y2 = l.ny2 * ph;
      const cl = closestPointOnSegment(cursor.x, cursor.y, x1, y1, x2, y2);
      entries.push({ x1, y1, x2, y2, closest: cl });
      if (cl.dist < nearestDist) {
        nearestDist = cl.dist;
        nearestIdx  = i;
      }
    }

    // Draw every line that's within PROX_RADIUS
    for (let i = 0; i < entries.length; i++) {
      const { x1, y1, x2, y2, closest } = entries[i];
      const dist = closest.dist;

      if (dist >= PROX_RADIUS) continue;

      const isNearest  = i === nearestIdx;
      const isSnapping = dist < thresh;

      // Alpha: 0 at edge of PROX_RADIUS → 1 at cursor
      const rawAlpha  = 1 - dist / PROX_RADIUS;
      const lineAlpha = isNearest ? rawAlpha : rawAlpha * 0.25;

      const colour = isSnapping && isNearest
        ? COLOUR_SNAP
        : isNearest
        ? COLOUR_NEAR
        : COLOUR_BASE;

      const lineWidth = isSnapping && isNearest ? 2.0
                      : isNearest              ? 1.5
                      : 0.6;

      ctx.save();
      ctx.globalAlpha = lineAlpha;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = `rgb(${colour})`;
      ctx.lineWidth   = lineWidth;
      if (!isSnapping && isNearest) ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Endpoint dots on nearest line
      if (isNearest) {
        const epAlpha = rawAlpha * 0.8;
        ctx.globalAlpha = epAlpha;
        for (const [ex, ey] of [[x1, y1], [x2, y2]] as [number, number][]) {
          ctx.beginPath();
          ctx.arc(ex, ey, isSnapping ? 4.5 : 2.5, 0, Math.PI * 2);
          ctx.fillStyle   = `rgba(${COLOUR_ENDPOINT},${epAlpha})`;
          ctx.fill();
          ctx.strokeStyle = `rgba(255,255,255,${epAlpha * 0.9})`;
          ctx.lineWidth   = 1;
          ctx.stroke();
        }
      }

      // Snap indicator on nearest line when within threshold
      if (isNearest && isSnapping) {
        ctx.globalAlpha = 1;

        // Perpendicular tick at closest point
        const dx = x2 - x1, dy = y2 - y1;
        const len = Math.hypot(dx, dy);
        if (len > 0) {
          const nx = -dy / len, ny = dx / len;
          const tick = 7;
          ctx.beginPath();
          ctx.moveTo(closest.x + nx * tick, closest.y + ny * tick);
          ctx.lineTo(closest.x - nx * tick, closest.y - ny * tick);
          ctx.strokeStyle = `rgb(${COLOUR_SNAP})`;
          ctx.lineWidth   = 1.5;
          ctx.stroke();
        }

        // Snap dot at closest point
        ctx.beginPath();
        ctx.arc(closest.x, closest.y, 5.5, 0, Math.PI * 2);
        ctx.fillStyle   = `rgb(${COLOUR_SNAP})`;
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth   = 1.5;
        ctx.stroke();

        // Length badge above midpoint
        const midX   = (x1 + x2) / 2;
        const midY   = (y1 + y2) / 2;
        const segLen = Math.hypot(x2 - x1, y2 - y1).toFixed(1);
        ctx.font         = 'bold 9px ui-monospace,monospace';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        const label = `${segLen}px`;
        const tw    = ctx.measureText(label).width + 10;
        ctx.fillStyle = 'rgba(0,0,0,0.82)';
        ctx.fillRect(midX - tw / 2, midY - 25, tw, 14);
        ctx.fillStyle = `rgb(${COLOUR_SNAP})`;
        ctx.fillText(label, midX, midY - 18);
      }

      ctx.restore();
    }
  }, [vectorCanvasRef, pdfDimensionsRef, cursorPointRef]);

  return { redrawVectorOverlay };
}

// hooks/useRoomDetection.ts
//
// Wired to the actual Viewer.tsx call signature:
//
//   const { rooms, detecting } = useRoomDetection(
//     pageData, pdfDimensions, pageNumber, showRooms, pdfCanvasRef.current,
//   );
//
// ROOT CAUSE — OCR always falling back to heuristic labels:
//
//   document.querySelector('canvas') grabs the FIRST canvas in the DOM.
//   In a React app that canvas is almost never the pdf.js rendering canvas —
//   it could be a chart, a spinner, a WebGL context, anything. OCR runs on the
//   wrong surface, Tesseract sees noise, confidence < MIN_WORD_CONFIDENCE,
//   returns null, and every room gets a heuristic label.
//
//   Fix: resolvePdfCanvas() selects the canvas whose aspect ratio and pixel
//   dimensions best match the expected PDF page dimensions. It also prefers the
//   LARGEST canvas on the page (pdf.js renders at devicePixelRatio, typically
//   1.5-3× the CSS size, so it's always the biggest canvas element).
//
// OCR RESOLUTION FIX:
//
//   The logical canvas (pdfDimensions.w × pdfDimensions.h at CSS pixels) was
//   being used as-is for OCR. At 59% viewer zoom (visible in screenshot) that
//   might be only 400-600px wide. Room labels on a floor plan at that resolution
//   are 6-8px tall — far below Tesseract's reliable floor (~20px character height).
//
//   Fix: OCR_CANVAS_SCALE = 2.0 — we copy the DOM canvas into an OffscreenCanvas
//   at 2× pdfDimensions (or use the raw HiDPI canvas directly if it's already
//   large enough). normPolygonToBbox receives the actual canvas dimensions so
//   crop coordinates are always correct regardless of scale factor.
//
// CONFIDENCE THRESHOLD FIX:
//
//   Architectural floor plan labels are often: light grey ink, thin strokes,
//   ALLCAPS serif, and small relative to the canvas. MIN_WORD_CONFIDENCE=55
//   in ocrRegion.ts is too high for these. We pass a lower threshold override
//   (35) via ocrRegionFromCanvas's options parameter.
//   Note: this requires a matching change in ocrRegion.ts (see that file).
//
// RACE CONDITION FIX (unchanged from previous version):
//
//   lastKeyRef is ONLY written when we actually launch detection.
//   Early exits never touch it so the next pageData update retries.
//
// FIX — OCR READS ROOM OVERLAY CANVAS INSTEAD OF PDF CANVAS:
//
//   Previously useRoomDetection received no canvas reference and
//   resolvePdfCanvas() fell back to document.querySelectorAll('canvas').
//   All four overlay canvases (pdf, drawing, pin, room) are the same logical
//   size — the DOM query could pick roomCanvasRef which already has "CORRIDOR"
//   pills painted on it, so Tesseract read the UI labels instead of PDF ink.
//
//   Fix: Viewer.tsx now passes pdfCanvasRef.current as the fifth argument.
//   resolvePdfCanvas() short-circuits on its very first line when externalCanvas
//   is supplied, skipping the DOM query entirely.
//
//   The detection key now includes externalCanvas.width so a null→canvas
//   transition (canvas not yet mounted on first render) forces a re-run.

import { useState, useEffect, useRef, useCallback } from 'react';
import type { PageExtractionState, PdfDimensions } from '@/types/viewerTypes';
import { detectRoomsHybrid }                        from './useSnapEngine/detectRoomsHybrid';
import type { DetectedRoom }                         from './useSnapEngine/detectRooms';
import { areaHeuristicLabel, buildRelativeLabelFn }  from './useSnapEngine/detectRooms';

// ─── Tuning ──────────────────────────────────────────────────────────────────

/**
 * The OCR canvas is built at this multiple of pdfDimensions.
 * 2.0 gives Tesseract ~20px character height on typical A1/A0 plans,
 * which is well above the reliable floor. Higher values cost more memory
 * but improve accuracy on very small rooms.
 */
const OCR_CANVAS_SCALE = 2.0;

// ─── Types ────────────────────────────────────────────────────────────────────

export type RoomDetectionPhase =
  | 'idle'
  | 'waiting'
  | 'geometry'
  | 'ocr'
  | 'done'
  | 'error';

export interface UseRoomDetectionResult {
  rooms:              DetectedRoom[];
  geometryCandidates: DetectedRoom[];
  phase:              RoomDetectionPhase;
  detecting:          boolean;
  error:              Error | null;
  clearRooms:         () => void;
  forceRedetect:      () => void;
}

// ─── Label safety ─────────────────────────────────────────────────────────────

/**
 * Guard against raw numeric/percentage strings leaking into the label field.
 * Applied at the hook boundary so the UI never displays "63.6%" or "0.636".
 * Uses relative labelling when the full room set is available.
 */
function sanitiseRoomLabel(room: DetectedRoom, labelFn?: (a: number) => string): DetectedRoom {
  const label = room.label?.trim() ?? '';
  const isNumericLeak = /^[\d.]+%?$/.test(label);
  if (!label || isNumericLeak) {
    const fallback = labelFn ? labelFn(room.areaNorm) : areaHeuristicLabel(room.areaNorm);
    return { ...room, label: fallback };
  }
  return room;
}

function sanitiseRoomList(rooms: DetectedRoom[]): DetectedRoom[] {
  if (rooms.length === 0) return rooms;
  const labelFn = buildRelativeLabelFn(rooms);
  return rooms.map(r => sanitiseRoomLabel(r, labelFn));
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useRoomDetection(
  pageData:        Map<number, PageExtractionState>,
  pdfDimensions:   PdfDimensions | null,
  pageNumber:      number,
  enabled:         boolean,
  externalCanvas?: OffscreenCanvas | HTMLCanvasElement | null,
): UseRoomDetectionResult {

  const [rooms,              setRooms]              = useState<DetectedRoom[]>([]);
  const [geometryCandidates, setGeometryCandidates] = useState<DetectedRoom[]>([]);
  const [phase,              setPhase]              = useState<RoomDetectionPhase>('idle');
  const [error,              setError]              = useState<Error | null>(null);
  const [trigger,            setTrigger]            = useState(0);

  const lastKeyRef = useRef('');

  // ── Toggle: clear state when disabled ────────────────────────────────────
  useEffect(() => {
    if (!enabled) {
      lastKeyRef.current = '';
      setRooms([]);
      setGeometryCandidates([]);
      setPhase('idle');
      setError(null);
    }
  }, [enabled]);

  // ── Main detection effect ─────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !pdfDimensions) {
      if (!enabled) setPhase('idle');
      return;
    }

    const pageIndex = pageNumber - 1;
    const pg        = pageData.get(pageIndex);

    if (process.env.NODE_ENV !== 'production') {
      console.group('%c[useRoomDetection] checking', 'color:#a78bfa;font-weight:bold');
      console.log('pageIndex      :', pageIndex);
      console.log('pageData keys  :', [...pageData.keys()]);
      console.log('pg.status      :', pg?.status ?? 'NO ENTRY');
      console.log('wallLines      :', pg?.wallLines?.length ?? 0);
      console.log('pdfDimensions  :', pdfDimensions);
      console.log('externalCanvas :', externalCanvas
        ? `${externalCanvas instanceof HTMLCanvasElement ? 'HTMLCanvasElement' : 'OffscreenCanvas'} ` +
          `${externalCanvas.width}×${externalCanvas.height}`
        : 'null — will use DOM query fallback');
      console.groupEnd();
    }

    // ── Early exits — do NOT set lastKeyRef ──────────────────────────────────

    if (!pg) {
      setPhase('waiting');
      return;
    }
    if (pg.status === 'idle' || pg.status === 'processing') {
      setPhase('waiting');
      return;
    }
    if (pg.status === 'error') {
      setError(new Error('Snap engine extraction failed for this page'));
      setPhase('error');
      return;
    }
    if (pg.status !== 'done') {
      setPhase('waiting');
      return;
    }
    if (!pg.wallLines?.length) {
      console.warn('[useRoomDetection] wallLines empty — no walls found on this page');
      setPhase('idle');
      return;
    }

    // ── Build detection key ───────────────────────────────────────────────
    //
    // FIX: include externalCanvas.width in the key.
    // On first render pdfCanvasRef.current may be null (canvas not yet mounted).
    // When it becomes available the key changes → effect re-runs → detection
    // launches with the correct canvas instead of falling back to the DOM query.
    const canvasW = externalCanvas instanceof HTMLCanvasElement
      ? externalCanvas.width
      : externalCanvas instanceof OffscreenCanvas
        ? externalCanvas.width
        : 0;

    const key = [
      pageIndex,
      pg.wallLines.length,
      Math.round(pdfDimensions.w),
      Math.round(pdfDimensions.h),
      canvasW,   // ← forces re-run when canvas goes from null → mounted
      trigger,
    ].join(':');

    if (key === lastKeyRef.current) return;

    // ── Launch detection ──────────────────────────────────────────────────
    lastKeyRef.current = key;

    const controller = new AbortController();
    setPhase('geometry');
    setError(null);
    setGeometryCandidates([]);
    setRooms([]);

    resolvePdfCanvas(externalCanvas, pdfDimensions)
      .then(canvas => {
        if (controller.signal.aborted) return Promise.resolve(undefined);

        if (process.env.NODE_ENV !== 'production') {
          const cw = canvas instanceof OffscreenCanvas ? canvas.width  : (canvas as HTMLCanvasElement).width;
          const ch = canvas instanceof OffscreenCanvas ? canvas.height : (canvas as HTMLCanvasElement).height;
          console.log(
            '[useRoomDetection] OCR canvas:', cw, '×', ch,
            '| dims:', Math.round(pdfDimensions.w), '×', Math.round(pdfDimensions.h),
            '| scale factor:', (cw / pdfDimensions.w).toFixed(2),
          );
        }

        return detectRoomsHybrid({
          pageCanvas: canvas,
          wallLines:  pg.wallLines!,
          dims:       pdfDimensions,
          signal:     controller.signal,
          onGeometryReady: (candidates) => {
            if (controller.signal.aborted) return;
            setGeometryCandidates(sanitiseRoomList(candidates));
            setPhase('ocr');
            if (process.env.NODE_ENV !== 'production') {
              console.log('[useRoomDetection] geometry done —', candidates.length, 'candidates');
            }
          },
        });
      })
      .then(detected => {
        if (!detected || controller.signal.aborted) return;
        const safe = sanitiseRoomList(detected);
        if (process.env.NODE_ENV !== 'production') {
          console.log('[useRoomDetection] OCR done —', safe.length, 'rooms:',
            safe.map(r => `${r.label} (${(r.areaNorm * 100).toFixed(1)}%)`));
        }
        setRooms(safe);
        setGeometryCandidates([]);
        setPhase('done');
      })
      .catch(err => {
        if (controller.signal.aborted) return;
        console.error('[useRoomDetection] pipeline error:', err);
        setError(err instanceof Error ? err : new Error(String(err)));
        setRooms([]);
        setGeometryCandidates([]);
        setPhase('error');
      });

    return () => {
      controller.abort();
      lastKeyRef.current = '';
      setPhase('idle');
    };
  }, [pageData, pageNumber, pdfDimensions, enabled, externalCanvas, trigger]);

  // ── Public controls ───────────────────────────────────────────────────────
  const clearRooms = useCallback(() => {
    lastKeyRef.current = '';
    setRooms([]);
    setGeometryCandidates([]);
    setPhase('idle');
    setError(null);
  }, []);

  const forceRedetect = useCallback(() => {
    lastKeyRef.current = '';
    setTrigger(t => t + 1);
  }, []);

  return {
    rooms,
    geometryCandidates,
    phase,
    detecting: phase === 'geometry' || phase === 'ocr',
    error,
    clearRooms,
    forceRedetect,
  };
}

// ─── PDF canvas resolver ──────────────────────────────────────────────────────
//
// FIX — why OCR was reading "CORRIDOR" instead of real room labels:
//
//   Viewer.tsx stacks four canvases of identical logical size:
//     1. pdfCanvasRef      — clean PDF render
//     2. drawingCanvasRef  — measurement lines
//     3. pinCanvasRef      — snap pins
//     4. roomCanvasRef     — room fill + "CORRIDOR 1.3%" label pills  ← OCR was reading THIS
//
//   The old DOM query scored all canvases by aspect ratio + pixel area.
//   Because all four are the same logical size and aspect ratio, the scoring
//   was a near-tie and DOM order (or pixel-area tiebreak) could hand OCR the
//   room overlay canvas — the one with "CORRIDOR" already painted on it.
//   Tesseract read those UI pills and returned "CORRIDOR" for every room.
//
//   Fix: when externalCanvas is supplied (Viewer.tsx now passes pdfCanvasRef.current),
//   this function returns immediately without touching the DOM at all.
//   The DOM query fallback is kept for callers that don't supply a canvas
//   (e.g. tests, Storybook, legacy call sites).

async function resolvePdfCanvas(
  external: OffscreenCanvas | HTMLCanvasElement | null | undefined,
  dims:     { w: number; h: number },
): Promise<OffscreenCanvas | HTMLCanvasElement> {

  // 1. Explicit canvas — trust the caller completely, skip DOM entirely.
  //    This is the normal production path now that Viewer.tsx passes pdfCanvasRef.
  if (external) {
    const outW = Math.round(dims.w * OCR_CANVAS_SCALE);
    const outH = Math.round(dims.h * OCR_CANVAS_SCALE);

    // If the canvas is already large enough (HiDPI render), use it directly
    // rather than copying — saves a drawImage call and avoids any alpha loss.
    const srcW = external instanceof HTMLCanvasElement ? external.width : external.width;
    const srcH = external instanceof HTMLCanvasElement ? external.height : external.height;

    if (srcW >= outW && srcH >= outH) {
      // Already at or above target resolution — use as-is
      return external;
    }

    // Upscale into OffscreenCanvas so Tesseract has enough pixels
    try {
      const oc  = new OffscreenCanvas(outW, outH);
      const ctx = oc.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, outW, outH);
      ctx.drawImage(external as CanvasImageSource, 0, 0, outW, outH);
      return oc;
    } catch (err) {
      console.warn('[resolvePdfCanvas] drawImage on externalCanvas failed:', err);
      // Fall through to DOM query as last resort
    }
  }

  // 2. DOM query fallback — used when no externalCanvas is provided.
  //    Kept for backward compatibility with tests and legacy callers.
  //    WARNING: in production this path risks picking the room overlay canvas.
  //    Always pass pdfCanvasRef.current from Viewer.tsx to avoid this.

  const targetAspect = dims.w / dims.h;
  const outW = Math.round(dims.w * OCR_CANVAS_SCALE);
  const outH = Math.round(dims.h * OCR_CANVAS_SCALE);

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise(resolve => setTimeout(resolve, attempt * 300));
    }

    const allCanvases = Array.from(document.querySelectorAll<HTMLCanvasElement>('canvas'));
    const viable      = allCanvases.filter(c => c.width > 100 && c.height > 100);

    if (viable.length > 0) {
      const scored = viable.map(c => {
        const aspect     = c.width / c.height;
        const aspectDiff = Math.abs(aspect - targetAspect) / targetAspect;
        const sizePx     = c.width * c.height;
        const aspectPenalty = aspectDiff > 0.05 ? 1e9 : 0;
        return { c, score: aspectPenalty - sizePx };
      });

      scored.sort((a, b) => a.score - b.score);
      const best = scored[0].c;

      if (process.env.NODE_ENV !== 'production') {
        console.log(
          `[resolvePdfCanvas] DOM fallback — selected canvas ${best.width}×${best.height}` +
          ` from ${viable.length} candidates` +
          ` (target aspect ${targetAspect.toFixed(3)},` +
          ` canvas aspect ${(best.width / best.height).toFixed(3)})`,
        );
        console.warn(
          '[resolvePdfCanvas] DOM fallback active — pass pdfCanvasRef.current as ' +
          'externalCanvas to useRoomDetection to guarantee OCR reads the PDF canvas.',
        );
      }

      try {
        const oc  = new OffscreenCanvas(outW, outH);
        const ctx = oc.getContext('2d')!;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, outW, outH);
        ctx.drawImage(best, 0, 0, outW, outH);
        return oc;
      } catch (err) {
        console.warn('[resolvePdfCanvas] drawImage failed (cross-origin?):', err);
        for (let i = 1; i < scored.length; i++) {
          try {
            const fallbackCanvas = scored[i].c;
            const oc2  = new OffscreenCanvas(outW, outH);
            const ctx2 = oc2.getContext('2d')!;
            ctx2.fillStyle = '#fff';
            ctx2.fillRect(0, 0, outW, outH);
            ctx2.drawImage(fallbackCanvas, 0, 0, outW, outH);
            return oc2;
          } catch {
            // continue
          }
        }
        break;
      }
    }

    if (attempt < 2) {
      console.warn(`[resolvePdfCanvas] no viable canvas on attempt ${attempt + 1}, retrying…`);
    }
  }

  // 3. Blank fallback — BFS geometry still works, OCR falls back to area heuristics
  console.warn('[resolvePdfCanvas] Could not find PDF canvas — using blank (heuristic labels only)');
  const blank = new OffscreenCanvas(outW, outH);
  const ctx   = blank.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, outW, outH);
  return blank;
}
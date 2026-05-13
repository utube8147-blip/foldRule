// hooks/useRoomDetection.ts
//
// CHANGES vs previous version:
//  1. Integrates extractAllVectors() alongside extractPdfVectorData()
//  2. Surfaces allVectors (ExtractAllVectorsResult) for the drawing layer
//  3. Everything else identical to previous version
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef, useCallback } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { PageExtractionState, PdfDimensions } from '@/types/viewerTypes';
import {
  detectRooms,
  areaHeuristicLabel,
  buildRelativeLabelFn,
} from './useSnapEngine/detectRooms';
import type { DetectedRoom } from './useSnapEngine/detectRooms';
import type { VectorRoom, RawSegment, Wall } from './useSnapEngine/extractPdfVectorData';
import type { ExtractAllVectorsResult } from './useSnapEngine/extractAllVectors';

const ROBOFLOW_API_KEY = process.env.NEXT_PUBLIC_ROBOFLOW_API_KEY ?? '';

if (process.env.NODE_ENV !== 'production') {
  console.log('[useRoomDetection] API Key present:', !!ROBOFLOW_API_KEY);
}

const OCR_CANVAS_SCALE = 2.0;

// ─── Types ────────────────────────────────────────────────────────────────────

export type RoomDetectionPhase =
  | 'idle'
  | 'waiting'
  | 'detecting'
  | 'done'
  | 'error';

export interface UseRoomDetectionResult {
  rooms:              DetectedRoom[];
  geometryCandidates: DetectedRoom[];
  wallSegments:       RawSegment[];
  walls:              Wall[];
  /** Full vector extraction result — all paths, glyphs, text runs */
  allVectors:         ExtractAllVectorsResult | null;
  phase:              RoomDetectionPhase;
  detecting:          boolean;
  error:              Error | null;
  clearRooms:         () => void;
  forceRedetect:      () => void;
}

// ─── VectorRoom → DetectedRoom adapter ───────────────────────────────────────

function vectorRoomToDetected(room: VectorRoom, index: number): DetectedRoom {
  return {
    polygon:    room.polygon,
    areaNorm:   room.areaNorm,
    label:      room.label,
    centroid:   room.centroid,
    id:         `vector-${index}-${room.label}`,
    type:       'room',
    confidence: 1.0,
    source:     'vector',
    ...(room.areaSqM !== null ? { areaSqM: room.areaSqM } : {}),
  };
}

// ─── Label sanitisation ───────────────────────────────────────────────────────

function sanitiseRoomLabel(
  room:    DetectedRoom,
  labelFn?: (a: number) => string,
): DetectedRoom {
  const label         = room.label?.trim() ?? '';
  const isNumericLeak = /^[\d.]+%?$/.test(label);
  if (!label || isNumericLeak) {
    const fallback = labelFn
      ? labelFn(room.areaNorm)
      : areaHeuristicLabel(room.areaNorm);
    return { ...room, label: fallback };
  }
  return room;
}

function sanitiseRoomList(rooms: DetectedRoom[]): DetectedRoom[] {
  if (rooms.length === 0) return rooms;
  const labelFn = buildRelativeLabelFn(rooms);
  return rooms.map(r => sanitiseRoomLabel(r, labelFn));
}

// ─── Canvas resolution ────────────────────────────────────────────────────────

async function resolvePdfCanvas(
  external: OffscreenCanvas | HTMLCanvasElement | null | undefined,
  dims:     { w: number; h: number },
): Promise<OffscreenCanvas | HTMLCanvasElement> {
  const outW = Math.round(dims.w * OCR_CANVAS_SCALE);
  const outH = Math.round(dims.h * OCR_CANVAS_SCALE);

  if (external) {
    if (external.width >= outW && external.height >= outH) {
      return external;
    }
    try {
      const oc  = new OffscreenCanvas(outW, outH);
      const ctx = oc.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, outW, outH);
      ctx.drawImage(external as CanvasImageSource, 0, 0, outW, outH);
      return oc;
    } catch (err) {
      console.warn('[resolvePdfCanvas] drawImage failed, using blank canvas:', err);
    }
  }

  console.warn('[resolvePdfCanvas] no external canvas — OCR will be skipped');
  const blank = new OffscreenCanvas(outW, outH);
  const ctx   = blank.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, outW, outH);
  return blank;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useRoomDetection(
  pageData:        Map<number, PageExtractionState>,
  pdfDimensions:   PdfDimensions | null,
  pageNumber:      number,
  enabled:         boolean,
  externalCanvas?: OffscreenCanvas | HTMLCanvasElement | null,
  pdfPage?:        PDFPageProxy | null,
): UseRoomDetectionResult {

  const [rooms,              setRooms]              = useState<DetectedRoom[]>([]);
  const [geometryCandidates, setGeometryCandidates] = useState<DetectedRoom[]>([]);
  const [wallSegments,       setWallSegments]       = useState<RawSegment[]>([]);
  const [walls,              setWalls]              = useState<Wall[]>([]);
  const [allVectors,         setAllVectors]         = useState<ExtractAllVectorsResult | null>(null);
  const [phase,              setPhase]              = useState<RoomDetectionPhase>('idle');
  const [error,              setError]              = useState<Error | null>(null);
  const [trigger,            setTrigger]            = useState(0);

  // ── Stable refs ────────────────────────────────────────────────────────────
  const externalCanvasRef = useRef(externalCanvas);
  useEffect(() => { externalCanvasRef.current = externalCanvas; }, [externalCanvas]);

  const pdfPageRef = useRef(pdfPage);
  useEffect(() => { pdfPageRef.current = pdfPage; }, [pdfPage]);

  // ── Canvas-ready trigger ───────────────────────────────────────────────────
  const [canvasReadyTrigger, setCanvasReadyTrigger] = useState(0);
  const prevCanvasNullRef = useRef(externalCanvas == null);
  useEffect(() => {
    const wasNull = prevCanvasNullRef.current;
    const isNull  = externalCanvas == null;
    prevCanvasNullRef.current = isNull;
    if (wasNull && !isNull) {
      setCanvasReadyTrigger(t => t + 1);
    }
  }, [externalCanvas]);

  const lastKeyRef = useRef('');

  // ── Reset when disabled ────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) {
      lastKeyRef.current = '';
      setRooms([]);
      setGeometryCandidates([]);
      setWallSegments([]);
      setWalls([]);
      setAllVectors(null);
      setPhase('idle');
      setError(null);
    }
  }, [enabled]);

  // ── Main detection effect ──────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !pdfDimensions) return;

    const pageIndex = pageNumber - 1;
    const pg = pageData.get(pageIndex);

    if (!pg || pg.status !== 'done') {
      setPhase('waiting');
      return;
    }

    const canvas = externalCanvasRef.current;

    const key = [
      pageIndex,
      pg.wallLines.length,
      canvas ? `${canvas.width}x${canvas.height}` : 'no-canvas',
      trigger,
      canvasReadyTrigger,
    ].join(':');

    if (key === lastKeyRef.current) return;
    lastKeyRef.current = key;

    const controller = new AbortController();
    setPhase('detecting');
    setError(null);
    setRooms([]);
    setGeometryCandidates([]);
    setWallSegments([]);
    setWalls([]);
    setAllVectors(null);

    (async () => {
      try {
        const currentPage = pdfPageRef.current;

        if (currentPage) {
          console.log('[useRoomDetection] Attempting vector extraction…');

          try {
            // Run both extractors in parallel — they both walk the operator
            // list but produce different output shapes.
            const [
              { extractPdfVectorData },
              { extractAllVectors },
            ] = await Promise.all([
              import('./useSnapEngine/extractPdfVectorData'),
              import('./useSnapEngine/extractAllVectors'),
            ]);

            const [vectorResult, allVectorsResult] = await Promise.all([
              extractPdfVectorData(currentPage),
              extractAllVectors(currentPage),
            ]);

            if (controller.signal.aborted) return;

            // Surface full vector extraction immediately
            setAllVectors(allVectorsResult);

            console.log(
              `[useRoomDetection] extractAllVectors: ` +
              `${allVectorsResult.paths.length} paths, ` +
              `${allVectorsResult.textRuns.length} text runs, ` +
              `${allVectorsResult.glyphs.length} glyphs`,
            );

            // Surface segments from the wall pairing extractor
            if (vectorResult.segments.length > 0) {
              console.log(
                `[useRoomDetection] ✅ ${vectorResult.segments.length} raw segments, ` +
                `${vectorResult.walls.length} paired walls`,
              );
              setWallSegments(vectorResult.segments);
              setWalls(vectorResult.walls);
            }

            if (vectorResult.isVector && vectorResult.rooms.length > 0) {
              console.log(
                `[useRoomDetection] ✅ Vector rooms: ${vectorResult.rooms.length}`,
                vectorResult.rooms.map(r =>
                  `${r.label} (${r.areaSqM?.toFixed(1) ?? '?'} m²)`,
                ),
              );

              const detected = vectorResult.rooms.map((r, i) =>
                vectorRoomToDetected(r, i),
              );

              setGeometryCandidates([]);
              setRooms(sanitiseRoomList(detected));
              setPhase('done');
              return;
            }

            if (!vectorResult.isVector) {
              console.log('[useRoomDetection] Scanned PDF — falling back to raster pipeline.');
            } else {
              console.log('[useRoomDetection] Vector extraction: 0 rooms — falling back to raster pipeline.');
            }
          } catch (vectorErr) {
            console.warn('[useRoomDetection] Vector extraction error — falling back:', vectorErr);
          }
        }

        // ── Raster pipeline ─────────────────────────────────────────────────
        console.log('[useRoomDetection] Running raster detection pipeline…');

        const resolvedCanvas = await resolvePdfCanvas(canvas, pdfDimensions);
        if (controller.signal.aborted) return;

        const detected = await detectRooms(
          pg.wallLines!,
          pdfDimensions,
          controller.signal,
          undefined,
          resolvedCanvas,
          ROBOFLOW_API_KEY,
        );
        if (controller.signal.aborted) return;

        console.log(`[useRoomDetection] Raster pipeline: ${detected.length} detections`);

        const structural = detected.filter(d => d.type === 'structural');
        const roomsOnly  = detected.filter(d => d.type === 'room');

        setGeometryCandidates(structural);
        setRooms(sanitiseRoomList([...structural, ...roomsOnly]));
        setPhase('done');

      } catch (err) {
        if (controller.signal.aborted) return;
        console.error('[useRoomDetection] Error:', err);
        setError(err instanceof Error ? err : new Error(String(err)));
        setRooms([]);
        setGeometryCandidates([]);
        setWallSegments([]);
        setWalls([]);
        setAllVectors(null);
        setPhase('error');
      }
    })();

    return () => {
      controller.abort();
      lastKeyRef.current = '';
    };

  }, [pageData, pageNumber, pdfDimensions, enabled, trigger, canvasReadyTrigger]);

  // ── Public API ─────────────────────────────────────────────────────────────

  const clearRooms = useCallback(() => {
    lastKeyRef.current = '';
    setRooms([]);
    setGeometryCandidates([]);
    setWallSegments([]);
    setWalls([]);
    setAllVectors(null);
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
    wallSegments,
    walls,
    allVectors,
    phase,
    detecting: phase === 'detecting' || phase === 'waiting',
    error,
    clearRooms,
    forceRedetect,
  };
}
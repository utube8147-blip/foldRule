// hooks/useRoomDetection.ts

import { useState, useEffect, useRef, useCallback } from 'react';
import type { PageExtractionState, PdfDimensions } from '@/types/viewerTypes';
import { detectRooms, areaHeuristicLabel, buildRelativeLabelFn } from './useSnapEngine/detectRooms';
import type { DetectedRoom } from './useSnapEngine/detectRooms';

const ROBOFLOW_API_KEY = process.env.NEXT_PUBLIC_ROBOFLOW_API_KEY ?? '';

if (process.env.NODE_ENV !== 'production') {
  console.log('[useRoomDetection] API Key present:', !!ROBOFLOW_API_KEY);
}

const OCR_CANVAS_SCALE = 2.0;

export type RoomDetectionPhase =
  | 'idle'
  | 'waiting'
  | 'detecting'
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

export function useRoomDetection(
  pageData: Map<number, PageExtractionState>,
  pdfDimensions: PdfDimensions | null,
  pageNumber: number,
  enabled: boolean,
  externalCanvas?: OffscreenCanvas | HTMLCanvasElement | null,
): UseRoomDetectionResult {

  const [rooms, setRooms] = useState<DetectedRoom[]>([]);
  const [phase, setPhase] = useState<RoomDetectionPhase>('idle');
  const [error, setError] = useState<Error | null>(null);
  const [trigger, setTrigger] = useState(0);

  const lastKeyRef = useRef('');

  useEffect(() => {
    if (!enabled) {
      console.log('[useRoomDetection] Disabled');
      lastKeyRef.current = '';
      setRooms([]);
      setPhase('idle');
      setError(null);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !pdfDimensions) {
      return;
    }

    const pageIndex = pageNumber - 1;
    const pg = pageData.get(pageIndex);

    if (!pg) { setPhase('waiting'); return; }
    if (pg.status !== 'done') { setPhase('waiting'); return; }
    if (!externalCanvas) return;

    const key = [pageIndex, pg.wallLines.length, trigger].join(':');
    if (key === lastKeyRef.current) return;
    lastKeyRef.current = key;

    const controller = new AbortController();
    setPhase('detecting');
    setError(null);
    setRooms([]);

    resolvePdfCanvas(externalCanvas, pdfDimensions)
      .then(canvas => {
        if (controller.signal.aborted) return undefined;
        return detectRooms(
          pg.wallLines!,
          pdfDimensions,
          controller.signal,
          undefined,
          canvas,
          ROBOFLOW_API_KEY
        );
      })
      .then(detected => {
        if (!detected || controller.signal.aborted) return;
        console.log(`[useRoomDetection] Got ${detected.length} detections`);
        const safe = sanitiseRoomList(detected);
        setRooms(safe);
        setPhase('done');
      })
      .catch(err => {
        if (controller.signal.aborted) return;
        console.error('[useRoomDetection] Error:', err);
        setError(err instanceof Error ? err : new Error(String(err)));
        setRooms([]);
        setPhase('error');
      });

    return () => {
      controller.abort();
      lastKeyRef.current = '';
    };
  }, [pageData, pageNumber, pdfDimensions, enabled, externalCanvas, trigger]);

  const clearRooms = useCallback(() => {
    lastKeyRef.current = '';
    setRooms([]);
    setPhase('idle');
    setError(null);
  }, []);

  const forceRedetect = useCallback(() => {
    lastKeyRef.current = '';
    setTrigger(t => t + 1);
  }, []);

  return {
    rooms,
    geometryCandidates: [],
    phase,
    detecting: phase === 'detecting',
    error,
    clearRooms,
    forceRedetect,
  };
}

async function resolvePdfCanvas(
  external: OffscreenCanvas | HTMLCanvasElement | null | undefined,
  dims: { w: number; h: number },
): Promise<OffscreenCanvas | HTMLCanvasElement> {
  const outW = Math.round(dims.w * OCR_CANVAS_SCALE);
  const outH = Math.round(dims.h * OCR_CANVAS_SCALE);

  if (external) {
    const srcW = external.width;
    const srcH = external.height;

    if (srcW >= outW && srcH >= outH) {
      return external;
    }

    try {
      const oc = new OffscreenCanvas(outW, outH);
      const ctx = oc.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, outW, outH);
      ctx.drawImage(external as CanvasImageSource, 0, 0, outW, outH);
      return oc;
    } catch (err) {
      console.warn('[resolvePdfCanvas] drawImage failed:', err);
    }
  }

  const blank = new OffscreenCanvas(outW, outH);
  const ctx = blank.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, outW, outH);
  return blank;
}
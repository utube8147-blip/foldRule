// ─── useSamSegmentation.ts ────────────────────────────────────────────────────

import { useRef, useState, useCallback, useEffect } from 'react';
// Stub types for missing module
type Point = { x: number; y: number };
function maskToPolygon(mask: any, options?: any): Point[] {
  return [];
}

export type SamStatus =
  | 'idle'
  | 'loading'
  | 'encoding'
  | 'ready'
  | 'segmenting'
  | 'error';

export interface UseSamSegmentationReturn {
  status:         SamStatus;
  statusMsg:      string;
  encodePage:     (canvas: HTMLCanvasElement) => Promise<void>;
  segmentPoint:   (x: number, y: number, canvasW: number, canvasH: number) => Promise<Point[] | null>;
  isLoading:      boolean;
  isBusy:         boolean;
  resetEmbedding: () => void;
}

export function useSamSegmentation(): UseSamSegmentationReturn {
  const [status,    setStatus]    = useState<SamStatus>('idle');
  const [statusMsg, setStatusMsg] = useState('');

  const workerRef         = useRef<Worker | null>(null);
  const pendingEncodeRef  = useRef<{ resolve: () => void; reject: (e: Error) => void } | null>(null);
  const pendingSegmentRef = useRef<{ resolve: (p: Point[] | null) => void; reject: (e: Error) => void } | null>(null);
  const lastCanvasDimsRef = useRef<{ w: number; h: number }>({ w: 1, h: 1 });

  // ── Boot worker ────────────────────────────────────────────────────────────
  useEffect(() => {
    const worker = new Worker('/workers/samWorker.js');
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;

      switch (msg.type) {
        case 'progress':
          setStatus('loading');
          setStatusMsg(msg.step);
          break;

        case 'encoded':
          setStatus('ready');
          setStatusMsg('Ready to segment');
          pendingEncodeRef.current?.resolve();
          pendingEncodeRef.current = null;
          break;

        case 'mask': {
          const { mask, maskW, maskH } = msg;
          const { w: canvasW, h: canvasH } = lastCanvasDimsRef.current;

          const polygon = maskToPolygon(mask, {
            maskW, maskH, canvasW, canvasH,
            epsilon: 3,
            minArea: 400,
          });

          setStatus('ready');
          setStatusMsg(polygon ? `${polygon.length} pts` : 'No region found');
          pendingSegmentRef.current?.resolve(polygon);
          pendingSegmentRef.current = null;
          break;
        }

        case 'error': {
          const err = new Error(msg.message);
          setStatus('error');
          setStatusMsg(msg.message);
          // ✅ Reject both pending promises so callers don't hang forever
          pendingEncodeRef.current?.reject(err);
          pendingSegmentRef.current?.reject(err);
          pendingEncodeRef.current  = null;
          pendingSegmentRef.current = null;
          break;
        }
      }
    };

    worker.onerror = (err) => {
      const error = new Error(err.message ?? 'Worker crashed');
      setStatus('error');
      setStatusMsg(error.message);
      pendingEncodeRef.current?.reject(error);
      pendingSegmentRef.current?.reject(error);
      pendingEncodeRef.current  = null;
      pendingSegmentRef.current = null;
    };

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  // ── encodePage ─────────────────────────────────────────────────────────────
  const encodePage = useCallback(async (canvas: HTMLCanvasElement): Promise<void> => {
    const worker = workerRef.current;
    if (!worker) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { width, height } = canvas;

    // ✅ Guard: don't encode a blank canvas (PDF.js may not have finished rendering)
    const probe   = ctx.getImageData(0, 0, 4, 4);
    const isEmpty = probe.data.every(v => v === 0);
    if (isEmpty) {
      console.warn('[SAM] encodePage skipped — canvas is blank (PDF still rendering?)');
      return;
    }

    lastCanvasDimsRef.current = { w: width, h: height };

    const imageData = ctx.getImageData(0, 0, width, height);

    setStatus('encoding');
    setStatusMsg('Building embedding…');

    // ✅ Promise resolves only when worker posts { type: 'encoded' },
    //    and rejects on { type: 'error' } — callers can safely await this.
    return new Promise<void>((resolve, reject) => {
      pendingEncodeRef.current = { resolve, reject };
      worker.postMessage(
        { type: 'encode', imageData, width, height },
        [imageData.data.buffer], // transfer — avoids copying the pixel buffer
      );
    });
  }, []);

  // ── segmentPoint ───────────────────────────────────────────────────────────
  const segmentPoint = useCallback(async (
    x: number,
    y: number,
    canvasW: number,
    canvasH: number,
  ): Promise<Point[] | null> => {
    const worker = workerRef.current;
    if (!worker) return null;

    // ✅ Only hard-bail on actual error — the overlay awaits encodePage before
    //    calling segmentPoint, so status will already be 'ready' by this point.
    if (status === 'error') return null;

    lastCanvasDimsRef.current = { w: canvasW, h: canvasH };

    setStatus('segmenting');
    setStatusMsg('Segmenting…');

    return new Promise<Point[] | null>((resolve, reject) => {
      pendingSegmentRef.current = { resolve, reject };
      worker.postMessage({ type: 'segment', x, y, width: canvasW, height: canvasH });
    });
  }, [status]);

  // ── resetEmbedding ─────────────────────────────────────────────────────────
  const resetEmbedding = useCallback(() => {
    setStatus('idle');
    setStatusMsg('');
    pendingEncodeRef.current  = null;
    pendingSegmentRef.current = null;
  }, []);

  return {
    status,
    statusMsg,
    encodePage,
    segmentPoint,
    isLoading: status === 'loading',
    isBusy:    status === 'encoding' || status === 'segmenting' || status === 'loading',
    resetEmbedding,
  };
}

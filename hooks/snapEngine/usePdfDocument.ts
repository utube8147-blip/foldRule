'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { destroyPdf } from '@/lib/pdf/destroyPdf';
import type { PdfLine, PdfCurve, SnapPoint, PdfDimensions, PdfPageInfo } from '@/types/snapTypes';

export type PdfLoadStage =
  | 'idle'
  | 'reading-file'
  | 'parsing-pdf'
  | 'rendering-page'
  | 'extracting-geometry'
  | 'computing-snaps'
  | 'done'
  | 'error';

export interface UsePdfDocumentReturn {
  stage: PdfLoadStage;
  errorMessage: string | null;
  fileName: string;
  dims: PdfDimensions | null;
  pageInfo: PdfPageInfo | null;
  lines: PdfLine[];
  curves: PdfCurve[];
  snapPoints: SnapPoint[];
  loadFile: (file: File) => Promise<void>;
  /**
   * Extract snap geometry for one page of an already-open document (no re-parse).
   * Used by the production viewer so snapping follows the page on screen.
   */
  loadPage: (doc: any, pageNumber: number, cacheKey?: string) => Promise<void>;
  /** Drop the current page's snap geometry (e.g. while a new page loads). */
  clear: () => void;
  renderToCanvas: (canvas: HTMLCanvasElement, scale?: number) => Promise<void>;
}

async function getPdfJs() {
  const pdfjs = await import('pdfjs-dist');
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url,
    ).toString();
  }
  return pdfjs;
}

function sanitizeArgs(fn: number, raw: unknown): any[] {
  if (raw == null) return [];
  if (fn === 91 && Array.isArray(raw)) {
    const [terminalOp, pathBufHolder, minMax] = raw as [number, unknown[], number[] | null];
    let pathBuffer: number[] | Float32Array | Float64Array = [];
    const pb = Array.isArray(pathBufHolder) ? pathBufHolder[0] : null;
    if (pb instanceof Float32Array || pb instanceof Float64Array) {
      // Keep it binary: a private copy we can hand to the worker without
      // cloning (pdf.js may reuse its own buffer).
      pathBuffer = pb.slice();
    } else if (Array.isArray(pb)) {
      pathBuffer = pb.filter((n) => typeof n === 'number');
    }
    return [terminalOp, pathBuffer, minMax ?? null];
  }
  if (!Array.isArray(raw) && !(raw instanceof Float32Array) && !(raw instanceof Float64Array)) {
    return [];
  }
  const arr = Array.from(raw as ArrayLike<unknown>);
  return arr.map((item) => {
    if (typeof item === 'number') return item;
    if (Array.isArray(item) || item instanceof Float32Array || item instanceof Float64Array) {
      return Array.from(item as ArrayLike<number>).filter((n) => typeof n === 'number');
    }
    return NaN;
  });
}

/**
 * PDF operator ids the geometry worker actually reads (see the `case OPS.x`
 * branches in workers/pdfGeometry.worker.js). Everything else — text, images,
 * colours — is ignored by the worker, so it isn't copied to it at all.
 */
const GEOMETRY_OPS = new Set<number>([
  2,              // setLineWidth
  10, 11, 12,     // save, restore, transform
  13, 14, 15, 16, 17, 18, 19, // moveTo, lineTo, curveTo(1-3), closePath, rectangle
  20, 21, 22, 23, 24, 25, 26, 27, 28, // stroke / fill variants, endPath
  74, 75,         // paintFormXObjectBegin / End (nested transforms)
  91,             // constructPath
]);

// ─── Snap geometry cache ──────────────────────────────────────────────────────
// Re-opening a page you've already visited reuses its geometry instantly.
// Small LRU: each entry can hold ~10k segments, so keep only a few.
interface SnapCacheEntry {
  lines: PdfLine[]; curves: PdfCurve[]; snapPoints: SnapPoint[];
  dims: PdfDimensions; pageInfo: PdfPageInfo;
}
const SNAP_CACHE_MAX = 6;
const snapCache = new Map<string, SnapCacheEntry>();
function cacheGet(key: string): SnapCacheEntry | undefined {
  const hit = snapCache.get(key);
  if (hit) { snapCache.delete(key); snapCache.set(key, hit); }   // mark as most recent
  return hit;
}
function cachePut(key: string, entry: SnapCacheEntry) {
  snapCache.delete(key);
  snapCache.set(key, entry);
  while (snapCache.size > SNAP_CACHE_MAX) snapCache.delete(snapCache.keys().next().value as string);
}
/** True when geometry for this drawing/page is already cached. */
export const hasSnapGeometry = (key: string) => snapCache.has(key);

/** Let the browser handle input between chunks of work. */
const yieldToBrowser = () => new Promise<void>(resolve => {
  const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (sched?.yield) sched.yield().then(resolve); else setTimeout(resolve, 0);
});

async function extractOperators(page: any, isStale: () => boolean = () => false): Promise<{ fn: number; args: any[] }[]> {
  const opList = await page.getOperatorList();
  const result: { fn: number; args: any[] }[] = [];
  const n = opList.fnArray.length;
  const CHUNK = 4000;
  for (let start = 0; start < n; start += CHUNK) {
    const end = Math.min(n, start + CHUNK);
    for (let i = start; i < end; i++) {
      const fn = opList.fnArray[i];
      if (!GEOMETRY_OPS.has(fn)) continue;
      result.push({ fn, args: sanitizeArgs(fn, opList.argsArray[i]) });
    }
    if (end < n) {
      await yieldToBrowser();
      if (isStale()) return [];
    }
  }
  return result;
}

// ─── Inline worker ────────────────────────────────────────────────────────────


function createGeometryWorker(): Worker {
  return new Worker(new URL('../../workers/pdfGeometry.worker.js', import.meta.url));
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function usePdfDocument(): UsePdfDocumentReturn {
  const [stage, setStage]       = useState<PdfLoadStage>('idle');
  const [errorMessage, setErr]  = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [dims, setDims]         = useState<PdfDimensions | null>(null);
  const [pageInfo, setPageInfo] = useState<PdfPageInfo | null>(null);
  const [lines, setLines]       = useState<PdfLine[]>([]);
  const [curves, setCurves]     = useState<PdfCurve[]>([]);
  const [snapPoints, setSnaps]  = useState<SnapPoint[]>([]);

  const pdfPageRef = useRef<any>(null);
  const workerRef  = useRef<Worker | null>(null);

  const renderToCanvas = useCallback(async (canvas: HTMLCanvasElement, scale = 1) => {
    const page = pdfPageRef.current;
    if (!page) return;
    const viewport  = page.getViewport({ scale });
    canvas.width    = viewport.width;
    canvas.height   = viewport.height;
    const ctx = canvas.getContext('2d')!;
    await page.render({ canvasContext: ctx, viewport }).promise;
  }, []);

  const ownDocRef = useRef<any>(null);
  const requestIdRef = useRef(0);

  // Shared: extract geometry from one page and run the snap worker.
  const extractFromPage = useCallback(async (page: any, pageNumber: number, pageCount: number, reqId: number, cacheKey?: string) => {
    pdfPageRef.current = page;
    setPageInfo({ pageNumber, pageCount });

    setStage('rendering-page');
    const vp       = page.getViewport({ scale: 1 });
    const pageDims: PdfDimensions = { w: vp.width, h: vp.height };
    setDims(pageDims);
    const viewportTransform = vp.transform as number[];

    setStage('extracting-geometry');
    const operators = await extractOperators(page, () => reqId !== requestIdRef.current);
    if (reqId !== requestIdRef.current) return;

    setStage('computing-snaps');
    const worker = createGeometryWorker();
    workerRef.current = worker;

    await new Promise<void>((resolve, reject) => {
      worker.onmessage = (e) => {
        const msg = e.data;
        if (reqId !== requestIdRef.current) { resolve(); return; }
        if (msg.type === 'RESULT') {
          setLines(msg.lines);
          setCurves(msg.curves);
          setSnaps(msg.snapPoints);
          if (cacheKey) {
            cachePut(cacheKey, {
              lines: msg.lines, curves: msg.curves, snapPoints: msg.snapPoints,
              dims: pageDims, pageInfo: { pageNumber, pageCount },
            });
          }
          resolve();
        } else if (msg.type === 'ERROR') {
          reject(new Error(msg.message));
        }
      };
      worker.onerror = (err) => reject(err);
      // Transfer the path buffers (zero-copy) instead of cloning them.
      const transfer: ArrayBuffer[] = [];
      for (const op of operators) {
        const buf = op.fn === 91 ? op.args[1] : null;
        if (buf && ArrayBuffer.isView(buf) && buf.buffer instanceof ArrayBuffer) transfer.push(buf.buffer);
      }
      worker.postMessage({ type: 'PARSE', operators, dims: pageDims, viewportTransform }, transfer);
    });
    worker.terminate();
    if (workerRef.current === worker) workerRef.current = null;
    if (reqId === requestIdRef.current) setStage('done');
  }, []);

  const resetForLoad = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    setErr(null);
    setLines([]); setCurves([]); setSnaps([]);
    setDims(null); setPageInfo(null);
    pdfPageRef.current = null;
    return ++requestIdRef.current;
  }, []);

  const loadFile = useCallback(async (file: File) => {
    const reqId = resetForLoad();
    setStage('reading-file');
    setFileName(file.name);
    try {
      const buffer = await file.arrayBuffer();
      setStage('parsing-pdf');
      const pdfjs = await getPdfJs();
      const doc   = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
      if (reqId !== requestIdRef.current) { destroyPdf(doc); return; }
      destroyPdf(ownDocRef.current);
      ownDocRef.current = doc;
      const page = await doc.getPage(1);
      await extractFromPage(page, 1, doc.numPages, reqId);
    } catch (err) {
      if (reqId !== requestIdRef.current) return;
      console.error('[usePdfDocument] error:', err);
      setErr(err instanceof Error ? err.message : String(err));
      setStage('error');
    }
  }, [extractFromPage, resetForLoad]);

  const loadPage = useCallback(async (doc: any, pageNumber: number, cacheKey?: string) => {
    if (!doc) return;
    const reqId = resetForLoad();
    const hit = cacheKey ? cacheGet(cacheKey) : undefined;
    if (hit) {
      setDims(hit.dims); setPageInfo(hit.pageInfo);
      setLines(hit.lines); setCurves(hit.curves); setSnaps(hit.snapPoints);
      setStage('done');
      doc.getPage(pageNumber).then((p: any) => { if (reqId === requestIdRef.current) pdfPageRef.current = p; }).catch(() => {});
      return;
    }
    setStage('parsing-pdf');
    try {
      const page = await doc.getPage(pageNumber);
      if (reqId !== requestIdRef.current) return;
      await extractFromPage(page, pageNumber, doc.numPages, reqId, cacheKey);
    } catch (err) {
      if (reqId !== requestIdRef.current) return;
      console.error('[usePdfDocument] page geometry error:', err);
      setErr(err instanceof Error ? err.message : String(err));
      setStage('error');
    }
  }, [extractFromPage, resetForLoad]);

  const clear = useCallback(() => { resetForLoad(); setStage('idle'); }, [resetForLoad]);

  // Clean up worker / owned document on unmount.
  useEffect(() => () => {
    requestIdRef.current++;
    workerRef.current?.terminate();
    destroyPdf(ownDocRef.current);
  }, []);

  return { stage, errorMessage, fileName, dims, pageInfo, lines, curves, snapPoints, loadFile, loadPage, clear, renderToCanvas };
}
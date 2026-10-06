'use client';

// ─── hooks/useViewerPdf.ts ────────────────────────────────────────────────────
//
//  CHANGE: Added pageChangeCount — a counter that increments ONLY when the
//  PDF document or page number changes, NOT on zoom re-renders. This lets
//  useMagicFillSession build its expensive 3× off-screen mask only when
//  something actually changed (new doc / new page), avoiding the loading
//  feel that happened when pdfRenderCount (which bumps on every zoom commit)
//  was used as the mask-rebuild trigger.
//
//  FIX — InvalidStateError: Cannot resize canvas after transferControlToOffscreen
//  pinCanvasRef is excluded from both resize loops (bitmap and CSS-only zoom).
//
// ─────────────────────────────────────────────────────────────────────────────

import { wheelMode } from '@/lib/shortcuts';
import {
  useState, useEffect, useRef, useCallback, useMemo,
} from 'react';
import pdfjsLib from "@/lib/pdf/pdfClient";
import { destroyPdf } from '@/lib/pdf/destroyPdf';

// ─── Parsed-document cache ────────────────────────────────────────────────────
// Switching back to a recently opened plan reuses its parsed PDF (no re-read,
// no re-parse, fonts already loaded). Older documents are released.
const DOC_CACHE_MAX = 3;
const docCache = new Map<string, PDFDocumentProxy>();
function keepDoc(key: string, doc: PDFDocumentProxy) {
  docCache.delete(key);
  docCache.set(key, doc);
  while (docCache.size > DOC_CACHE_MAX) {
    const [oldKey, oldDoc] = docCache.entries().next().value as [string, PDFDocumentProxy];
    docCache.delete(oldKey);
    if (oldDoc !== doc) destroyPdf(oldDoc);
  }
}
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { PdfDimensions } from '@/types/viewerTypes';

import {
  CANVAS_PADDING, ZOOM_SENSITIVITY, MIN_ZOOM, MAX_ZOOM,
} from '@/components/Viewer/ViewerConstants';

// ── Public interface ───────────────────────────────────────────────────────────

export interface UseViewerPdfOptions {
  containerRef:     React.RefObject<HTMLDivElement>;
  pdfCanvasRef:     React.RefObject<HTMLCanvasElement>;
  drawingCanvasRef: React.RefObject<HTMLCanvasElement>;
  pinCanvasRef:     React.RefObject<HTMLCanvasElement>;
  vectorCanvasRef:  React.RefObject<HTMLCanvasElement>;
  fillCanvasRef:    React.RefObject<HTMLCanvasElement>;
  activeDrawingId:  string | null;
  activeDrawingUrl: string | null;
  activeDrawingFile?: File;
  onPdfLoaded?: (doc: PDFDocumentProxy, file?: File) => void;
  onPageRendered?: () => void;
  onScaleSet: (metersPerPixel: number) => void;
  shouldPreserveFillCanvas: React.RefObject<boolean>;
  onZoom?: () => void;
}

export interface UseViewerPdfReturn {
  pdf:              PDFDocumentProxy | null;
  pageNumber:       number;
  setPageNumber:    (n: number) => void;
  loading:          boolean;
  scale:            number;
  setScale:         (s: number | ((prev: number) => number)) => void;
  committedScale:   number;
  pdfDimensions:    PdfDimensions | null;
  pdfRenderCount:   number;
  // NEW: only increments on doc load or page change, never on zoom.
  // Use this as the trigger for expensive operations like mask building.
  pageChangeCount:  number;
  isPanning:        boolean;
  setIsPanning:     (v: boolean) => void;
  spaceHeld:        boolean;
  spaceHeldRef:     React.RefObject<boolean>;
  wrapStyle:        React.CSSProperties | undefined;
  fitToScreen:      (doc?: PDFDocumentProxy, pageNum?: number) => Promise<void>;
  centerDocumentInViewport: () => void;
  handleManualScale: () => void;
  handleContainerPointerDown: (e: React.PointerEvent, leftDragPans?: boolean) => void;
  handleContainerPointerMove: (e: React.PointerEvent) => void;
  handleContainerPointerUp:   () => void;
  handleDrawingCanvasPointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  currentPdfPageRef: React.RefObject<PDFPageProxy | null>;
  pdfRef:            React.RefObject<PDFDocumentProxy | null>;
  pageNumberRef:     React.RefObject<number>;
  scaleRef:          React.RefObject<number>;
  dimsScaleRef:      React.RefObject<number>;
  pdfDimensionsRef:  React.RefObject<PdfDimensions | null>;
  onScaleSetRef:     React.RefObject<(v: number) => void>;
  pan: { x: number; y: number };
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * Gap left around the page when fitting it to the window. (Not CANVAS_PADDING:
 * that is the scrollable space around the page, far larger than the window, and
 * subtracting it made "fit" compute a zero or tiny zoom.)
 */
const FIT_MARGIN = 24;

export function useViewerPdf({
  containerRef,
  pdfCanvasRef,
  drawingCanvasRef,
  pinCanvasRef,
  vectorCanvasRef,
  fillCanvasRef,
  activeDrawingId,
  activeDrawingUrl,
  activeDrawingFile,
  onPdfLoaded,
  onPageRendered,
  onScaleSet,
  shouldPreserveFillCanvas,
  onZoom,
}: UseViewerPdfOptions): UseViewerPdfReturn {

  // ── Core state ─────────────────────────────────────────────────────────────
  const [pdf,            setPdf]            = useState<PDFDocumentProxy | null>(null);
  const [pageNumber,     setPageNumber]     = useState(1);
  const [loading,        setLoading]        = useState(false);
  const [isPanning,      setIsPanning]      = useState(false);
  const [spaceHeld,      setSpaceHeld]      = useState(false);
  const spaceHeldRef                        = useRef(false);
  const [scale,          setScale]          = useState(1.5);
  const [committedScale, setCommittedScale] = useState(1.5);
  const [pdfDimensions,  setPdfDimensions]  = useState<PdfDimensions | null>(null);
  const [pdfRenderCount, setPdfRenderCount] = useState(0);

  // NEW: increments only on doc load or page number change, never on zoom.
  const [pageChangeCount, setPageChangeCount] = useState(0);

  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // ── Stable refs ────────────────────────────────────────────────────────────
  const pdfRef            = useRef<PDFDocumentProxy | null>(null);
  const pageNumberRef     = useRef(pageNumber);
  const scaleRef          = useRef(scale);
  const pdfDimensionsRef  = useRef<PdfDimensions | null>(null);
  /** Zoom level at which pdfDimensions were computed (see render effect). */
  const dimsScaleRef      = useRef(1);
  const loadedDocRef      = useRef<PDFDocumentProxy | null>(null);
  const onScaleSetRef     = useRef(onScaleSet);
  const currentPdfPageRef = useRef<PDFPageProxy | null>(null);
  const activeDrawingFileRef = useRef<File | undefined>(activeDrawingFile);
  const onZoomRef         = useRef(onZoom);

  useEffect(() => { pdfRef.current              = pdf;              }, [pdf]);
  useEffect(() => { pageNumberRef.current       = pageNumber;       }, [pageNumber]);
  useEffect(() => { scaleRef.current            = scale;            }, [scale]);
  useEffect(() => { pdfDimensionsRef.current    = pdfDimensions;    }, [pdfDimensions]);
  useEffect(() => { onScaleSetRef.current       = onScaleSet;       }, [onScaleSet]);
  useEffect(() => { activeDrawingFileRef.current = activeDrawingFile; }, [activeDrawingFile]);
  useEffect(() => { onZoomRef.current           = onZoom;           }, [onZoom]);

  // ── Committed scale (debounced 150 ms) ────────────────────────────────────
  useEffect(() => {
    const t = setTimeout(() => setCommittedScale(scale), 150);
    return () => clearTimeout(t);
  }, [scale]);

  // ── Viewport helpers ───────────────────────────────────────────────────────
  const centerDocumentInViewport = useCallback(() => {
    const c = containerRef.current;
    if (!c) return;
    requestAnimationFrame(() => {
      c.scrollLeft = Math.round((c.scrollWidth  - c.clientWidth)  / 2);
      c.scrollTop  = Math.round((c.scrollHeight - c.clientHeight) / 2);
    });
  }, [containerRef]);

  const fitToScreen = useCallback(async (
    pdfDoc?: PDFDocumentProxy,
    pageNum?: number,
  ) => {
    const doc  = pdfDoc  ?? pdfRef.current;
    const page = pageNum ?? pageNumberRef.current;
    if (!doc || !containerRef.current) return;
    try {
      const p  = await doc.getPage(page);
      const vp = p.getViewport({ scale: 1 });
      const vW = containerRef.current.clientWidth  - FIT_MARGIN * 2;
      const vH = containerRef.current.clientHeight - FIT_MARGIN * 2;
      if (vW <= 0 || vH <= 0) return;
      setScale(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM,
        Math.min(vW / vp.width, vH / vp.height) * 0.97)));
      setTimeout(() => centerDocumentInViewport(), 150);
    } catch (err) {
      console.error('Fit error', err);
    }
  }, [containerRef, centerDocumentInViewport]);

  const handleManualScale = useCallback(() => {
    const s = window.prompt(
      'Enter scale ratio (e.g. 1:100) or pixels per unit (e.g. 0.05):',
    );
    if (!s) return;
    if (s.includes(':')) {
      const [paper, real] = s.split(':').map(parseFloat);
      if (!isNaN(paper) && !isNaN(real) && real > 0) onScaleSetRef.current(real / paper);
    } else {
      const f = parseFloat(s);
      if (!isNaN(f) && f > 0) onScaleSetRef.current(f);
    }
  }, []);

  // ── Scroll → pan ──────────────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const compute = () => {
      const dims = pdfDimensionsRef.current;
      if (!dims) return;
      const vw    = el.clientWidth;
      const vh    = el.clientHeight;
      const wrapW = Math.max(dims.w + CANVAS_PADDING * 2, vw  * 3);
      const wrapH = Math.max(dims.h + CANVAS_PADDING * 2, vh * 3);
      const pdfLeft = Math.round((wrapW - dims.w) / 2);
      const pdfTop  = Math.round((wrapH - dims.h) / 2);
      setPan({
        x: pdfLeft - el.scrollLeft,
        y: pdfTop  - el.scrollTop,
      });
    };

    el.addEventListener('scroll', compute, { passive: true });
    compute();
    const t = setTimeout(compute, 200);
    return () => {
      el.removeEventListener('scroll', compute);
      clearTimeout(t);
    };
  }, [containerRef, pdfDimensionsRef]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !pdfDimensions) return;
    const vw    = el.clientWidth;
    const vh    = el.clientHeight;
    const wrapW = Math.max(pdfDimensions.w + CANVAS_PADDING * 2, vw  * 3);
    const wrapH = Math.max(pdfDimensions.h + CANVAS_PADDING * 2, vh * 3);
    const pdfLeft = Math.round((wrapW - pdfDimensions.w) / 2);
    const pdfTop  = Math.round((wrapH - pdfDimensions.h) / 2);
    setPan({
      x: pdfLeft - el.scrollLeft,
      y: pdfTop  - el.scrollTop,
    });
  }, [pdfDimensions, containerRef]);

  // ── PDF load ───────────────────────────────────────────────────────────────
  useEffect(() => {
    let mounted = true;
    if (!activeDrawingUrl) {
      setPdf(null);
      setPdfDimensions(null);
      currentPdfPageRef.current = null;
      return;
    }
    setLoading(true);

    if (!pdfjsLib) {
      console.error('pdfjsLib is null');
      setLoading(false);
      return;
    }

    const cacheKey = `${activeDrawingId}|${activeDrawingUrl}`;

    const onLoad = async (doc: PDFDocumentProxy) => {
      keepDoc(cacheKey, doc);               // cached even if we switched away meanwhile
      if (!mounted) return;
      loadedDocRef.current = doc;
      const page = await doc.getPage(1);
      const vp   = page.getViewport({ scale: 1 });
      let fit = 1.5;
      if (containerRef.current) {
        const vW = (containerRef.current.clientWidth  || containerRef.current.offsetWidth  || window.innerWidth)  - FIT_MARGIN * 2;
        const vH = (containerRef.current.clientHeight || containerRef.current.offsetHeight || window.innerHeight) - FIT_MARGIN * 2;
        if (vW > 0 && vH > 0)
          fit = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM,
            Math.min(vW / vp.width, vH / vp.height) * 0.97));
      }
      setPdf(doc);
      setPageNumber(1);
      setScale(fit);
      setCommittedScale(fit);
      // NEW: bump pageChangeCount on new document load.
      setPageChangeCount(c => c + 1);
      // Next frames (not fixed delays): let layout settle, then centre.
      requestAnimationFrame(() => {
        if (!mounted) return;
        onPdfLoaded?.(doc, activeDrawingFileRef.current);
        requestAnimationFrame(() => {
          if (mounted) {
            centerDocumentInViewport();
            setLoading(false);
          }
        });
      });
    };

    const onErr = (err: any) => {
      console.error(err);
      if (mounted) setLoading(false);
    };

    const cached = docCache.get(cacheKey);
    const file = activeDrawingFileRef.current;
    if (cached) {
      void onLoad(cached);
    } else if (file) {
      file.arrayBuffer()
        .then(buf => (mounted ? pdfjsLib!.getDocument({ data: new Uint8Array(buf) }).promise.then(onLoad) : undefined))
        .catch(onErr);
    } else {
      pdfjsLib!.getDocument(activeDrawingUrl!).promise.then(onLoad).catch(onErr);
    }

    return () => {
      mounted = false;
      // The document stays in docCache; the cache releases old ones itself.
      loadedDocRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDrawingId, activeDrawingUrl]);

  // ── Page number change → bump pageChangeCount ─────────────────────────────
  // We track the previous page number in a ref so we only bump when it
  // actually changes (not on initial render).
  const prevPageNumberRef = useRef<number | null>(null);
  useEffect(() => {
    if (prevPageNumberRef.current !== null && prevPageNumberRef.current !== pageNumber) {
      setPageChangeCount(c => c + 1);
    }
    prevPageNumberRef.current = pageNumber;
  }, [pageNumber]);

  // ── PDF render ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!pdf) return;
    let active = true;
    let task: any = null;

    (async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        if (!active) return;
        currentPdfPageRef.current = page;

        const rawDpr  = window.devicePixelRatio || 1;
        const logVP   = page.getViewport({ scale: committedScale });
        const safeDpr = Math.sqrt(16_000_000 / (logVP.width * logVP.height));
        const dpr     = Math.min(rawDpr, safeDpr, 3);
        const physVP  = page.getViewport({ scale: committedScale * dpr });

        const canvas = pdfCanvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Render into an off-screen buffer and swap it in when finished.
        // Resizing the visible canvas would blank it for the whole render; this
        // way the previous bitmap stays on screen (CSS-scaled) until the sharp
        // one is ready.
        // A fresh buffer per render, so a cancelled render can never paint
        // into the buffer of the next one.
        const buffer = document.createElement('canvas');
        buffer.width  = physVP.width;
        buffer.height = physVP.height;
        const bctx = buffer.getContext('2d');
        if (!bctx) return;

        canvas.style.width  = `${logVP.width}px`;
        canvas.style.height = `${logVP.height}px`;

        // pinCanvasRef intentionally excluded — owned by snap worker after
        // transferControlToOffscreen(); resizing it here throws InvalidStateError.
        for (const ref of [drawingCanvasRef, vectorCanvasRef, fillCanvasRef]) {
          const c = ref.current;
          if (!c) continue;

          if (c.width !== logVP.width || c.height !== logVP.height) {
            if (
              ref === fillCanvasRef &&
              c.width > 0 &&
              c.height > 0 &&
              shouldPreserveFillCanvas.current
            ) {
              const tmp = document.createElement('canvas');
              tmp.width  = c.width;
              tmp.height = c.height;
              tmp.getContext('2d')!.drawImage(c, 0, 0);
              c.width  = logVP.width;
              c.height = logVP.height;
              c.getContext('2d')!.drawImage(tmp, 0, 0, logVP.width, logVP.height);
            } else {
              c.width  = logVP.width;
              c.height = logVP.height;
            }
          }

          c.style.width  = `${logVP.width}px`;
          c.style.height = `${logVP.height}px`;
        }

        // Keep dimensions and the zoom they were measured at in lock-step, so
        // quantity maths never mixes a committed canvas size with a live zoom.
        pdfDimensionsRef.current = { w: logVP.width, h: logVP.height };
        dimsScaleRef.current     = committedScale;
        setPdfDimensions(prev =>
          prev?.w === logVP.width && prev?.h === logVP.height
            ? prev
            : { w: logVP.width, h: logVP.height },
        );

        task = page.render({
          canvasContext: bctx,
          viewport:      physVP,
          canvas:        buffer as any,
        } as any);
        await task.promise;

        if (active) {
          if (canvas.width !== physVP.width || canvas.height !== physVP.height) {
            canvas.width  = physVP.width;
            canvas.height = physVP.height;
          } else {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
          }
          ctx.drawImage(buffer, 0, 0);
          // Release the buffer's pixel memory until the next render.
          buffer.width = 0; buffer.height = 0;

          onPageRendered?.();
          setPdfRenderCount(c => c + 1);
          // NOTE: pageChangeCount is NOT bumped here — zoom re-renders go
          // through this path and we deliberately don't want them to trigger
          // the expensive mask rebuild in useMagicFillSession.
        }
      } catch (err: any) {
        if (err?.name !== 'RenderingCancelledException') console.error(err);
      }
    })();

    return () => { active = false; task?.cancel(); };
  }, [pdf, pageNumber, committedScale]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── CSS-only scale during live zoom ───────────────────────────────────────
  // pinCanvasRef intentionally excluded — snap worker handles its own sizing.
  useEffect(() => {
    if (scale === committedScale || !pdfDimensions) return;
    const ratio = scale / committedScale;
    const newW  = pdfDimensions.w * ratio;
    const newH  = pdfDimensions.h * ratio;
    for (const ref of [drawingCanvasRef, vectorCanvasRef, fillCanvasRef]) {
      const c = ref.current;
      if (!c) continue;
      c.style.width  = `${newW}px`;
      c.style.height = `${newH}px`;
    }
  }, [scale, committedScale, pdfDimensions]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Center on page change ──────────────────────────────────────────────────
  useEffect(() => {
    if (pdf && pdfDimensions) centerDocumentInViewport();
  }, [pageNumber, pdfDimensions, centerDocumentInViewport, pdf]);

  // ── Wheel zoom ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // The wheel zooms. Ctrl + wheel scrolls up/down, Shift + wheel sideways.
      // (A trackpad pinch also arrives as Ctrl + wheel, with small fractional
      // steps — that still zooms.)
      if (e.shiftKey && !e.ctrlKey && !e.metaKey) return;                 // browser scrolls sideways
      const mod = e.ctrlKey || e.metaKey;
      const pinch = mod && (!Number.isInteger(e.deltaY) || Math.abs(e.deltaY) < 40);
      // The user can swap the two (Shortcuts panel): wheel scrolls, Ctrl + wheel zooms.
      if (wheelMode() === 'scroll' && !mod) return;                       // browser scrolls
      if (wheelMode() === 'zoom' && mod && !pinch) {
        e.preventDefault();                                               // not the browser's page zoom
        el.scrollTop  += e.deltaY;
        el.scrollLeft += e.deltaX;
        return;
      }
      e.preventDefault();
      onZoomRef.current?.();
      const delta =
        (e.deltaY > 0 ? -1 : 1) *
        ZOOM_SENSITIVITY *
        (1 + Math.min(Math.abs(e.deltaY) / 100, 1) * 0.5);
      const rect = el.getBoundingClientRect();
      const cx   = e.clientX - rect.left + el.scrollLeft;
      const cy   = e.clientY - rect.top  + el.scrollTop;
      setScale(prev => {
        const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev + delta));
        if (next === prev) return prev;
        const ratio = next / prev;
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const c = containerRef.current;
            if (!c) return;
            c.scrollLeft = cx * ratio - (e.clientX - rect.left);
            c.scrollTop  = cy * ratio - (e.clientY - rect.top);
          }),
        );
        return next;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [containerRef]);

  // ── Spacebar pan ───────────────────────────────────────────────────────────
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || (e.target as HTMLElement).tagName === 'INPUT') return;
      e.preventDefault();
      if (!e.repeat) { spaceHeldRef.current = true; setSpaceHeld(true); }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      spaceHeldRef.current = false;
      setSpaceHeld(false);
      setIsPanning(false);
      if (containerRef.current) containerRef.current.style.cursor = '';
    };
    window.addEventListener('keydown', onDown, { capture: true });
    window.addEventListener('keyup',   onUp,   { capture: true });
    return () => {
      window.removeEventListener('keydown', onDown, { capture: true });
      window.removeEventListener('keyup',   onUp,   { capture: true });
    };
  }, [containerRef]);

  // ── Pan helpers ────────────────────────────────────────────────────────────
  // Pan state lives in refs so the very first pointer moves are handled
  // (React state would only update after a re-render); `isPanning` state is
  // kept for the cursor.
  const isPanningRef  = useRef(false);
  /** Left-button press in Select mode: pan only once the pointer really moves,
   *  so a plain click still selects a measurement. */
  const pendingPanRef = useRef<{ x: number; y: number; pointerId: number; target: HTMLElement } | null>(null);
  const PAN_THRESHOLD_PX = 4;

  const beginPan = useCallback((pointerId: number, target: HTMLElement) => {
    try { target.setPointerCapture(pointerId); } catch { /* pointer already released */ }
    isPanningRef.current = true;
    setIsPanning(true);
    if (containerRef.current) containerRef.current.style.cursor = 'grabbing';
  }, [containerRef]);

  const startPan = useCallback((e: React.PointerEvent, target: HTMLElement) => {
    if (!pdfRef.current) return;
    e.preventDefault();
    pendingPanRef.current = null;
    beginPan(e.pointerId, target);
  }, [beginPan]);

  /**
   * Container pointer-down. Middle button or Space+drag pan immediately;
   * `leftDragPans` (Select tool) arms a pan that starts after a small move.
   */
  const handleContainerPointerDown = useCallback((e: React.PointerEvent, leftDragPans = false) => {
    if (e.button === 1 || (e.button === 0 && spaceHeldRef.current)) {
      startPan(e, e.currentTarget as HTMLElement);
      return;
    }
    if (e.button === 0 && leftDragPans && pdfRef.current && e.pointerType === 'mouse') {
      pendingPanRef.current = {
        x: e.clientX, y: e.clientY, pointerId: e.pointerId, target: e.currentTarget as HTMLElement,
      };
    }
  }, [startPan]);

  const handleContainerPointerMove = useCallback((e: React.PointerEvent) => {
    const pending = pendingPanRef.current;
    if (pending && !isPanningRef.current) {
      if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) < PAN_THRESHOLD_PX) return;
      pendingPanRef.current = null;
      beginPan(pending.pointerId, pending.target);
    }
    if (isPanningRef.current && containerRef.current) {
      containerRef.current.scrollLeft -= e.movementX;
      containerRef.current.scrollTop  -= e.movementY;
    }
  }, [beginPan, containerRef]);

  const handleContainerPointerUp = useCallback(() => {
    pendingPanRef.current = null;
    if (!isPanningRef.current) return;
    isPanningRef.current = false;
    setIsPanning(false);
    if (containerRef.current) containerRef.current.style.cursor = '';
  }, [containerRef]);

  const handleDrawingCanvasPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.button === 1 || (e.button === 0 && spaceHeldRef.current)) {
        e.stopPropagation();
        if (containerRef.current) startPan(e, containerRef.current);
      }
    },
    [containerRef, startPan],
  );

  // ── wrapStyle ──────────────────────────────────────────────────────────────
  const wrapStyle = useMemo((): React.CSSProperties | undefined => {
    if (!pdf || !pdfDimensions) return undefined;
    const el = containerRef.current;
    const vw = el
      ? (el.clientWidth  || el.offsetWidth  || window.innerWidth)
      : window.innerWidth;
    const vh = el
      ? (el.clientHeight || el.offsetHeight || window.innerHeight)
      : window.innerHeight;
    return {
      width:  Math.max(pdfDimensions.w + CANVAS_PADDING * 2, vw  * 3),
      height: Math.max(pdfDimensions.h + CANVAS_PADDING * 2, vh * 3),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf, pdfDimensions]);

  return {
    pdf,
    pageNumber,
    setPageNumber,
    loading,
    scale,
    setScale,
    committedScale,
    pdfDimensions,
    pdfRenderCount,
    pageChangeCount,      // NEW
    isPanning,
    setIsPanning,
    spaceHeld,
    spaceHeldRef,
    wrapStyle,
    fitToScreen,
    centerDocumentInViewport,
    handleManualScale,
    handleContainerPointerDown,
    handleContainerPointerMove,
    handleContainerPointerUp,
    handleDrawingCanvasPointerDown,
    currentPdfPageRef,
    pdfRef,
    pageNumberRef,
    scaleRef,
    dimsScaleRef,
    pdfDimensionsRef,
    onScaleSetRef,
    pan,
  };
}
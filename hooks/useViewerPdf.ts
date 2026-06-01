'use client';

// ─── hooks/useViewerPdf.ts ────────────────────────────────────────────────────
//
//  FIX — InvalidStateError: Cannot resize canvas after transferControlToOffscreen
//
//  pinCanvasRef is transferred to the OffscreenCanvas worker by useSnapEngine
//  via transferControlToOffscreen(). After that call the main thread can no
//  longer write canvas.width, canvas.height, or canvas.style.width/height on
//  that element — the worker owns the canvas entirely.
//
//  Two places were doing exactly that:
//
//   1. The PDF render useEffect loops over [drawingCanvasRef, pinCanvasRef,
//      vectorCanvasRef, fillCanvasRef] and sets c.width / c.height on each.
//      Fix: skip pinCanvasRef in that loop — the worker handles its own resize
//      via the 'resize' postMessage.
//
//   2. The CSS-only scale useEffect (live zoom) also loops over the same four
//      refs and sets c.style.width / c.style.height. Setting style on a
//      transferred canvas is technically allowed by the spec but it is a no-op
//      (the worker's OffscreenCanvas ignores it) and confuses Chrome into
//      sometimes throwing. Fix: skip pinCanvasRef there too.
//
//  All other logic is unchanged from the previous version.

import {
  useState, useEffect, useRef, useCallback, useMemo,
} from 'react';
import pdfjsLib from "@/lib/pdfClient";
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
  /** Called after a new PDF is loaded so snap extraction can begin. */
  onPdfLoaded?: (doc: PDFDocumentProxy, file?: File) => void;
  /** Called after each successful page render. */
  onPageRendered?: () => void;
  onScaleSet: (metersPerPixel: number) => void;
  /**
   * Ref that is `true` only while the magic-fill tool is active.
   * When true, fillCanvasRef contents are preserved across PDF re-renders.
   * When false the canvas is simply cleared on resize.
   */
  shouldPreserveFillCanvas: React.RefObject<boolean>;
  /**
   * Called on every wheel zoom event (before scale is updated).
   * Viewer.tsx passes markZoomStart here so the isZooming flag is set
   * from a single listener rather than a duplicate one on the container.
   */
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
  isPanning:        boolean;
  setIsPanning:     (v: boolean) => void;
  spaceHeld:        boolean;
  spaceHeldRef:     React.RefObject<boolean>;
  wrapStyle:        React.CSSProperties | undefined;
  fitToScreen:      (doc?: PDFDocumentProxy, pageNum?: number) => Promise<void>;
  centerDocumentInViewport: () => void;
  handleManualScale: () => void;
  /** Attach to the scroll container's onPointerDown. */
  handleContainerPointerDown: (e: React.PointerEvent) => void;
  /** Attach to the scroll container's onPointerMove. */
  handleContainerPointerMove: (e: React.PointerEvent) => void;
  /** Attach to the scroll container's onPointerUp / onPointerLeave. */
  handleContainerPointerUp:   () => void;
  /** Attach to the drawing canvas's onPointerDown to support mid-canvas pan. */
  handleDrawingCanvasPointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  currentPdfPageRef: React.RefObject<PDFPageProxy | null>;
  /** Stable ref always pointing at current pdf — useful for imperative callers. */
  pdfRef:            React.RefObject<PDFDocumentProxy | null>;
  pageNumberRef:     React.RefObject<number>;
  scaleRef:          React.RefObject<number>;
  pdfDimensionsRef:  React.RefObject<PdfDimensions | null>;
  onScaleSetRef:     React.RefObject<(v: number) => void>;
  /**
   * Current PDF-origin position in viewport-space pixels.
   * x = distance from left edge of viewport to left edge of PDF.
   * y = distance from top  edge of viewport to top  edge of PDF.
   * Updated on every scroll event. Used by useSnapEngine to project
   * PDF-pixel coords → screen coords for the pin canvas overlay.
   */
  pan: { x: number; y: number };
}

// ── Hook ──────────────────────────────────────────────────────────────────────

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

  // pan state — PDF origin in viewport-space pixels.
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // ── Stable refs ────────────────────────────────────────────────────────────
  const pdfRef            = useRef<PDFDocumentProxy | null>(null);
  const pageNumberRef     = useRef(pageNumber);
  const scaleRef          = useRef(scale);
  const pdfDimensionsRef  = useRef<PdfDimensions | null>(null);
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
      const vW = containerRef.current.clientWidth  - CANVAS_PADDING * 2;
      const vH = containerRef.current.clientHeight - CANVAS_PADDING * 2;
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
  // Tracks the PDF origin in viewport-space on every scroll event.
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

  // Re-initialise pan whenever PDF dimensions change (new document / new page)
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

    const onLoad = async (doc: PDFDocumentProxy) => {
      if (!mounted) return;
      const page = await doc.getPage(1);
      const vp   = page.getViewport({ scale: 1 });
      let fit = 1.5;
      if (containerRef.current) {
        const vW = (containerRef.current.clientWidth  || containerRef.current.offsetWidth  || window.innerWidth)  - CANVAS_PADDING * 2;
        const vH = (containerRef.current.clientHeight || containerRef.current.offsetHeight || window.innerHeight) - CANVAS_PADDING * 2;
        if (vW > 0 && vH > 0)
          fit = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM,
            Math.min(vW / vp.width, vH / vp.height) * 0.97));
      }
      setPdf(doc);
      setPageNumber(1);
      setScale(fit);
      setCommittedScale(fit);
      setTimeout(() => {
        if (!mounted) return;
        onPdfLoaded?.(doc, activeDrawingFileRef.current);
        setTimeout(() => {
          if (mounted) {
            centerDocumentInViewport();
            setLoading(false);
          }
        }, 150);
      }, 50);
    };

    const onErr = (err: any) => {
      console.error(err);
      if (mounted) setLoading(false);
    };

    const file = activeDrawingFileRef.current;
    if (file) {
      const r = new FileReader();
      r.onload = () => {
        if (!mounted) return;
        pdfjsLib!
          .getDocument({ data: new Uint8Array(r.result as ArrayBuffer) })
          .promise.then(onLoad)
          .catch(onErr);
      };
      r.readAsArrayBuffer(file);
    } else {
      pdfjsLib!.getDocument(activeDrawingUrl!).promise.then(onLoad).catch(onErr);
    }

    return () => { mounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDrawingId, activeDrawingUrl]);

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

        if (canvas.width !== physVP.width || canvas.height !== physVP.height) {
          canvas.width  = physVP.width;
          canvas.height = physVP.height;
        }
        canvas.style.width  = `${logVP.width}px`;
        canvas.style.height = `${logVP.height}px`;

        // FIX: pinCanvasRef is intentionally excluded from this loop.
        //
        // Once useSnapEngine calls transferControlToOffscreen() on pinCanvasRef,
        // the main thread loses ownership of that canvas. Any attempt to write
        // canvas.width or canvas.height on it throws:
        //   InvalidStateError: Cannot resize canvas after transferControlToOffscreen()
        //
        // The snap worker receives a 'resize' postMessage and manages its own
        // OffscreenCanvas dimensions — we must not touch them from here.
        //
        // drawingCanvasRef, vectorCanvasRef, fillCanvasRef are normal canvases
        // (never transferred) so they are safe to resize as before.
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

        setPdfDimensions(prev =>
          prev?.w === logVP.width && prev?.h === logVP.height
            ? prev
            : { w: logVP.width, h: logVP.height },
        );

        task = page.render({
          canvasContext: ctx,
          viewport:      physVP,
          canvas:        canvas as any,
        } as any);
        await task.promise;

        if (active) {
          onPageRendered?.();
          setPdfRenderCount(c => c + 1);
        }
      } catch (err: any) {
        if (err?.name !== 'RenderingCancelledException') console.error(err);
      }
    })();

    return () => { active = false; task?.cancel(); };
  }, [pdf, pageNumber, committedScale]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── CSS-only scale during live zoom ───────────────────────────────────────
  // FIX: pinCanvasRef is intentionally excluded from this loop.
  //
  // The pin canvas is an OffscreenCanvas controlled by the snap worker after
  // transferControlToOffscreen(). The worker positions itself as a full-viewport
  // screen-space overlay (position:absolute, top:0, left:0 in Viewer.tsx) and
  // redraws at the correct scale on every 'transform' postMessage — it does not
  // need CSS scaling from the main thread.
  //
  // Touching style.width / style.height on a transferred canvas is a no-op at
  // best and occasionally throws in some browsers. Skip it entirely.
  useEffect(() => {
    if (scale === committedScale || !pdfDimensions) return;
    const ratio = scale / committedScale;
    const newW  = pdfDimensions.w * ratio;
    const newH  = pdfDimensions.h * ratio;
    // pinCanvasRef intentionally omitted — see comment above
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
  // onZoom (markZoomStart) is called here so Viewer.tsx does not need
  // a duplicate wheel listener on the same container element.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
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
  const startPan = useCallback((e: React.PointerEvent, target: HTMLElement) => {
    if (!pdfRef.current) return;
    e.preventDefault();
    target.setPointerCapture(e.pointerId);
    setIsPanning(true);
    if (containerRef.current) containerRef.current.style.cursor = 'grabbing';
  }, [containerRef]);

  const handleContainerPointerDown = useCallback((e: React.PointerEvent) => {
    if (
      e.button === 1 ||
      (e.button === 0 && spaceHeldRef.current) ||
      (e.button === 0 && (e.currentTarget as any).__activeTool === 'select')
    ) {
      startPan(e, e.currentTarget as HTMLElement);
    }
  }, [startPan]);

  const handleContainerPointerMove = useCallback((e: React.PointerEvent) => {
    if (isPanning && containerRef.current) {
      containerRef.current.scrollLeft -= e.movementX;
      containerRef.current.scrollTop  -= e.movementY;
    }
  }, [isPanning, containerRef]);

  const handleContainerPointerUp = useCallback(() => {
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
    pdfDimensionsRef,
    onScaleSetRef,
    pan,
  };
}
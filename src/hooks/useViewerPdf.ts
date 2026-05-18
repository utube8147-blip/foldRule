'use client';

// ─── hooks/useViewerPdf.ts ────────────────────────────────────────────────────
//
//  Owns everything related to PDF loading and viewport management:
//    • PDF document load (file or URL)
//    • PDF page render (with DPR-aware physical canvas sizing)
//    • CSS-only scale during live zoom (before committedScale catches up)
//    • Wheel zoom (Ctrl/Cmd + scroll)
//    • Spacebar pan (space-hold + drag)
//    • fitToScreen / centerDocumentInViewport
//    • wrapStyle (canvas wrap dimensions)
//
//  Returns everything Viewer needs to wire up scrolling, zooming, and panning.

import {
  useState, useEffect, useRef, useCallback, useMemo,
} from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFPageProxy } from 'pdfjs-dist';
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
  onPdfLoaded?: (doc: pdfjsLib.PDFDocumentProxy, file?: File) => void;
  /** Called after each successful page render. */
  onPageRendered?: () => void;
  onScaleSet:      (metersPerPixel: number) => void;
}

export interface UseViewerPdfReturn {
  pdf:              pdfjsLib.PDFDocumentProxy | null;
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
  fitToScreen:      (doc?: pdfjsLib.PDFDocumentProxy, pageNum?: number) => Promise<void>;
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
  pdfRef:            React.RefObject<pdfjsLib.PDFDocumentProxy | null>;
  pageNumberRef:     React.RefObject<number>;
  scaleRef:          React.RefObject<number>;
  pdfDimensionsRef:  React.RefObject<PdfDimensions | null>;
  onScaleSetRef:     React.RefObject<(v: number) => void>;
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
}: UseViewerPdfOptions): UseViewerPdfReturn {

  // ── Core state ─────────────────────────────────────────────────────────────
  const [pdf,            setPdf]            = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pageNumber,     setPageNumber]     = useState(1);
  const [loading,        setLoading]        = useState(false);
  const [isPanning,      setIsPanning]      = useState(false);
  const [spaceHeld,      setSpaceHeld]      = useState(false);
  const spaceHeldRef                        = useRef(false);
  const [scale,          setScale]          = useState(1.5);
  const [committedScale, setCommittedScale] = useState(1.5);
  const [pdfDimensions,  setPdfDimensions]  = useState<PdfDimensions | null>(null);
  const [pdfRenderCount, setPdfRenderCount] = useState(0);

  // ── Stable refs ────────────────────────────────────────────────────────────
  const pdfRef            = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const pageNumberRef     = useRef(pageNumber);
  const scaleRef          = useRef(scale);
  const pdfDimensionsRef  = useRef<PdfDimensions | null>(null);
  const onScaleSetRef     = useRef(onScaleSet);
  const currentPdfPageRef = useRef<PDFPageProxy | null>(null);
  const activeDrawingFileRef = useRef<File | undefined>(activeDrawingFile);

  useEffect(() => { pdfRef.current           = pdf;           }, [pdf]);
  useEffect(() => { pageNumberRef.current    = pageNumber;    }, [pageNumber]);
  useEffect(() => { scaleRef.current         = scale;         }, [scale]);
  useEffect(() => { pdfDimensionsRef.current = pdfDimensions; }, [pdfDimensions]);
  useEffect(() => { onScaleSetRef.current    = onScaleSet;    }, [onScaleSet]);
  useEffect(() => { activeDrawingFileRef.current = activeDrawingFile; }, [activeDrawingFile]);

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
    pdfDoc?: pdfjsLib.PDFDocumentProxy,
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

    const onLoad = async (doc: pdfjsLib.PDFDocumentProxy) => {
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
        pdfjsLib
          .getDocument({ data: new Uint8Array(r.result as ArrayBuffer) })
          .promise.then(onLoad)
          .catch(onErr);
      };
      r.readAsArrayBuffer(file);
    } else {
      pdfjsLib.getDocument(activeDrawingUrl!).promise.then(onLoad).catch(onErr);
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

        for (const ref of [drawingCanvasRef, pinCanvasRef, vectorCanvasRef, fillCanvasRef]) {
          const c = ref.current;
          if (!c) continue;
          if (c.width !== logVP.width || c.height !== logVP.height) {
            if (ref === fillCanvasRef && c.width > 0 && c.height > 0) {
              // Preserve fill canvas contents across resize
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
  useEffect(() => {
    if (scale === committedScale || !pdfDimensions) return;
    const ratio = scale / committedScale;
    const newW  = pdfDimensions.w * ratio;
    const newH  = pdfDimensions.h * ratio;
    for (const ref of [drawingCanvasRef, pinCanvasRef, vectorCanvasRef, fillCanvasRef]) {
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
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
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
  };
}
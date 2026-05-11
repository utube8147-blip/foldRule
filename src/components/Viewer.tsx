'use client';

// ─── Viewer.tsx ───────────────────────────────────────────────────────────────
//
//  Root component. Owns all state and hooks; delegates rendering to:
//    • ViewerToolbar  — top bar
//    • ViewerCanvas   — canvas stack + PDF scroll area
//    • ViewerDialogs  — all modals / overlays
//
//  CHANGES:
//    • FIX 1: Escape with no tempPoints now switches to 'select' tool (was a no-op)
//    • FIX 1: Escape hint in the status bar updated to reflect both behaviours
//    • FIX 2: double-click to finish — handled here via onDoubleClick on the
//             container; useMeasurementCommit also needs e.detail===2 guard
//             (see useMeasurementCommit.ts patch below)
//
// ─────────────────────────────────────────────────────────────────────────────

import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToolType, TakeoffRow } from '@/types';
import type { PdfDimensions } from '@/types/viewerTypes';

import { Minimap }           from './Minimap';
import { SnapSettingsPanel } from './SnapSettingsPanel';
import { useSnapEngine }     from '@/hooks/useSnapEngine';
import { useMeasurements }   from '@/hooks/useMeasurements';
import { useTakeoffContext }  from '@/context/TakeoffContext';

import { ViewerToolbar }  from './Viewer/ViewerToolbar';
import { ViewerCanvas }   from './Viewer/ViewerCanvas';
import {
  CalibrationDialog, AppendGroupBanner,
  SnapCandidateWired, MeasurementDetailsWired, PresetDrawerWired,
} from './Viewer/ViewerDialogs';
import {
  CANVAS_PADDING, ZOOM_SENSITIVITY, MIN_ZOOM, MAX_ZOOM, VIEWER_TOOLS,
} from './Viewer/ViewerConstants';

export type { ViewerProps, ViewerToolbarAPI } from './Viewer/ViewerConstants';

// ─── Component ────────────────────────────────────────────────────────────────

export function Viewer({
  activeTool, setActiveTool,
  measurements,
  onAddMeasurement: onAddMeasurementProp,
  onUpdateMeasurement: onUpdateMeasurementProp,
  scaleFactor, onScaleSet, activeDrawing, onDrawingAdded,
  showPresetDrawer, onClosePresetDrawer, onSelectPreset,
  hideToolbar = false,
  appendToGroupId: propAppendToGroupId,
  onAppendComplete,
  onToolbarReady,
}: import('./Viewer/ViewerConstants').ViewerProps) {

  // ── Refs ───────────────────────────────────────────────────────────────────
  const pdfCanvasRef     = useRef<HTMLCanvasElement>(null);
  const drawingCanvasRef = useRef<HTMLCanvasElement>(null);
  const pinCanvasRef     = useRef<HTMLCanvasElement>(null);
  const containerRef     = useRef<HTMLDivElement>(null);

  // ── State ──────────────────────────────────────────────────────────────────
  const [pdf, setPdf]               = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale]           = useState(1.5);
  const [loading, setLoading]       = useState(false);
  const [isPanning, setIsPanning]   = useState(false);
  const [spaceHeld, setSpaceHeld]   = useState(false);
  const spaceHeldRef                = useRef(false);
  const [pdfDimensions, setPdfDimensions] = useState<PdfDimensions | null>(null);

  const pdfDimensionsRef = useRef<PdfDimensions | null>(null);
  useEffect(() => { pdfDimensionsRef.current = pdfDimensions; }, [pdfDimensions]);
  const pageNumberRef = useRef(pageNumber);
  useEffect(() => { pageNumberRef.current = pageNumber; }, [pageNumber]);
  const scaleRef = useRef(scale);
  useEffect(() => { scaleRef.current = scale; }, [scale]);
  const pdfRef = useRef<pdfjsLib.PDFDocumentProxy | null>(pdf);
  useEffect(() => { pdfRef.current = pdf; }, [pdf]);
  const onScaleSetRef = useRef(onScaleSet);
  useEffect(() => { onScaleSetRef.current = onScaleSet; }, [onScaleSet]);

  const activeDrawingId  = activeDrawing?.id     ?? null;
  const activeDrawingUrl = activeDrawing?.fileUrl ?? null;
  const activeDrawingFileRef = useRef<File | undefined>(activeDrawing?.file);
  useEffect(() => { activeDrawingFileRef.current = activeDrawing?.file; }, [activeDrawing?.file]);
  const startExtractionRef = useRef<((...args: any[]) => void) | null>(null);

  // ── Settings ───────────────────────────────────────────────────────────────
  const [snapEnabled,      setSnapEnabled]      = useState(true);
  const [showPins,         setShowPins]         = useState(true);
  const [snapThreshold,    setSnapThreshold]    = useState(14);
  const [confidenceFilter, setConfidenceFilter] = useState(0.1);
  const [showSnapSettings, setShowSnapSettings] = useState(false);

  // ── Dialog state ───────────────────────────────────────────────────────────
  const [showCalibrationDialog, setShowCalibrationDialog] = useState(false);
  const [pendingPtLen,          setPendingPtLen]          = useState(0);
  const [calibrationInput,      setCalibrationInput]      = useState('');
  const [showMeasurementDialog,  setShowMeasurementDialog]  = useState(false);
  const [pendingMeasurementData, setPendingMeasurementData] = useState<
    { id: string; type: string; description: string } | null>(null);

  // ── Stable callbacks ───────────────────────────────────────────────────────
  const onUpdateMeasurement = useCallback(
    (id: string, updates: Partial<TakeoffRow>) => onUpdateMeasurementProp?.(id, updates),
    [onUpdateMeasurementProp],
  );

  // ── Context ────────────────────────────────────────────────────────────────
  const {
    tempPoints, pushPoint, commitMeasurement, batchCommitMeasurements,
    clearTempPoints, undo, redo, canUndo, canRedo,
  } = useTakeoffContext();

  const undoRedoRef = useRef<{ setCursorPoint: (p: any) => void }>({ setCursorPoint: () => {} });
  const handleUndo  = useCallback(() => { undo();  undoRedoRef.current.setCursorPoint(null); }, [undo]);
  const handleRedo  = useCallback(() => { redo();  undoRedoRef.current.setCursorPoint(null); }, [redo]);

  // ── Snap engine ────────────────────────────────────────────────────────────
  const {
    pageData, analysisStatus, analysisPage, snapFlashes,
    startExtraction, getScaledCorners,
    snapToCorner, triggerSnapFlash, redrawPinCanvas, cursorPointRef,
  } = useSnapEngine({
    pinCanvasRef:     pinCanvasRef     as React.RefObject<HTMLCanvasElement>,
    pdfDimensionsRef: pdfDimensionsRef as React.RefObject<PdfDimensions>,
    pageNumberRef:    pageNumberRef    as React.RefObject<number>,
    snapEnabled, showPins, snapThreshold, confidenceFilter,
  });

  useEffect(() => { startExtractionRef.current = startExtraction; }, [startExtraction]);

  const setActiveToolString = useCallback((t: string) => setActiveTool(t as ToolType), [setActiveTool]);

  // ── Calibration ────────────────────────────────────────────────────────────
  const handleScalePrompt = useCallback((ptLen: number) => {
    setPendingPtLen(ptLen); setCalibrationInput(''); setShowCalibrationDialog(true);
  }, []);

  const handleCalibrationConfirm = useCallback(() => {
    const r = parseFloat(calibrationInput);
    if (!isNaN(r) && r > 0 && pendingPtLen > 0) onScaleSetRef.current(r / pendingPtLen);
    setShowCalibrationDialog(false);
  }, [calibrationInput, pendingPtLen]);

  // ── Measurements engine ────────────────────────────────────────────────────
  const {
    pendingSnapCandidates, setPendingSnapCandidates,
    finishMeasurement, handleCanvasClick, handleContextMenu,
    handleCanvasPointerMove, handleCanvasPointerDown,
    handleCanvasPointerUp, toCanvas, setCursorPoint,
  } = useMeasurements({
    drawingCanvasRef: drawingCanvasRef as React.RefObject<HTMLCanvasElement>,
    pdfDimensionsRef: pdfDimensionsRef as React.RefObject<PdfDimensions>,
    pageNumberRef:    pageNumberRef    as React.RefObject<number>,
    scaleRef:         scaleRef        as React.RefObject<number>,
    activeTool, setActiveTool: setActiveToolString,
    measurements, tempPoints, pushPoint,
    commitMeasurement, batchCommitMeasurements,
    appendToGroupId: propAppendToGroupId, onAppendComplete,
    onScalePrompt: handleScalePrompt,
    clearTempPoints, scaleFactor, onUpdateMeasurement,
    isPanning, snapToCorner, getScaledCorners,
    triggerSnapFlash, snapEnabled, snapThreshold,
    redrawPinCanvas, cursorPointRef, activeDrawingId,
  });

  useEffect(() => { undoRedoRef.current.setCursorPoint = setCursorPoint; }, [setCursorPoint]);

  // ── Viewport helpers ───────────────────────────────────────────────────────
  const centerDocumentInViewport = useCallback(() => {
    const c = containerRef.current; if (!c) return;
    requestAnimationFrame(() => {
      c.scrollLeft = Math.round((c.scrollWidth  - c.clientWidth)  / 2);
      c.scrollTop  = Math.round((c.scrollHeight - c.clientHeight) / 2);
    });
  }, []);

  const fitToScreen = useCallback(async (
    pdfDoc?: pdfjsLib.PDFDocumentProxy, pageNum?: number,
  ) => {
    const doc  = pdfDoc ?? pdfRef.current;
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
    } catch (err) { console.error('Fit error', err); }
  }, [centerDocumentInViewport]);

  const handleManualScale = useCallback(() => {
    const s = window.prompt('Enter scale ratio (e.g. 1:100) or pixels per unit (e.g. 0.05):');
    if (!s) return;
    if (s.includes(':')) {
      const [paper, real] = s.split(':').map(parseFloat);
      if (!isNaN(paper) && !isNaN(real) && real > 0) {
        alert('Ratio parsing applied. Use Draw Calibration for pixel-accurate mapping.');
        onScaleSetRef.current(real / paper);
      }
    } else {
      const f = parseFloat(s); if (!isNaN(f) && f > 0) onScaleSetRef.current(f);
    }
  }, []);

  // ── Finish + dialog flow ───────────────────────────────────────────────────
  const handleFinishMeasurement = useCallback(() => {
    const minPts = activeTool === 'count' || activeTool === 'point' ? 1 : 2;
    if (tempPoints.length < minPts) { finishMeasurement(); return; }
    if (propAppendToGroupId) { finishMeasurement(); onAppendComplete?.(); return; }
    const type = activeTool === 'polygon' || activeTool === 'rectangle'
      ? 'Polygon' : activeTool === 'linear' ? 'Length'
      : activeTool === 'count' ? 'Count' : 'Point';
    setPendingMeasurementData({ id: `temp-${Date.now()}`, type, description: `New ${type}` });
    setShowMeasurementDialog(true);
  }, [tempPoints.length, activeTool, finishMeasurement, propAppendToGroupId, onAppendComplete]);

  const handleDialogConfirm = useCallback((name: string, _: string, icon?: string) => {
    setShowMeasurementDialog(false);
    finishMeasurement(undefined, { label: name.trim() || `New ${pendingMeasurementData?.type || 'Measurement'}`, icon });
  }, [finishMeasurement, pendingMeasurementData]);

  const handleDialogSkip = useCallback(() => {
    setShowMeasurementDialog(false); finishMeasurement();
  }, [finishMeasurement]);

  // ── Toolbar API ────────────────────────────────────────────────────────────
  const toolbarAPI = useMemo(() => ({
    tools: [...VIEWER_TOOLS] as any,
    activeTool, setActiveTool, scale, setScale, scaleFactor,
    snapEnabled, setSnapEnabled, showSnapSettings, setShowSnapSettings,
    showPins, setShowPins, snapThreshold, setSnapThreshold,
    confidenceFilter, setConfidenceFilter, analysisStatus,
    analysisPage: analysisPage ?? null,
    currentPageCorners: pageData.get(pageNumber - 1)?.corners.length ?? 0,
    pdf, pageNumber,
    fitToScreen: () => fitToScreen(), handleManualScale,
    canUndo, canRedo, handleUndo, handleRedo,
  }), [
    activeTool, setActiveTool, scale, scaleFactor,
    snapEnabled, showSnapSettings, showPins, snapThreshold, confidenceFilter,
    analysisStatus, analysisPage, pageData, pageNumber, pdf,
    fitToScreen, handleManualScale, canUndo, canRedo, handleUndo, handleRedo,
  ]);

  useEffect(() => { onToolbarReady?.(toolbarAPI); }, [onToolbarReady, toolbarAPI]);

  // ── File upload ────────────────────────────────────────────────────────────
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) =>
    Array.from(e.target.files ?? []).forEach(f =>
      onDrawingAdded(f.name, URL.createObjectURL(f), f));

  // ── PDF load ───────────────────────────────────────────────────────────────
  useEffect(() => {
    let mounted = true;
    if (!activeDrawingUrl) { setPdf(null); setPdfDimensions(null); return; }
    setLoading(true);

    const onLoad = async (doc: pdfjsLib.PDFDocumentProxy) => {
      if (!mounted) return;
      const page = await doc.getPage(1);
      const vp   = page.getViewport({ scale: 1 });
      let fit    = 1.5;
      if (containerRef.current) {
        const vW = (containerRef.current.clientWidth  || containerRef.current.offsetWidth)  - CANVAS_PADDING * 2;
        const vH = (containerRef.current.clientHeight || containerRef.current.offsetHeight) - CANVAS_PADDING * 2;
        if (vW > 0 && vH > 0)
          fit = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(vW / vp.width, vH / vp.height) * 0.97));
      }
      setPdf(doc); setPageNumber(1); setScale(fit);
      setTimeout(() => {
        if (!mounted) return;
        startExtractionRef.current?.(doc, activeDrawingFileRef.current);
        setTimeout(() => { if (mounted) { centerDocumentInViewport(); setLoading(false); } }, 150);
      }, 50);
    };

    const file = activeDrawingFileRef.current;
    const onErr = (err: any) => { console.error(err); if (mounted) setLoading(false); };
    if (file) {
      const r = new FileReader();
      r.onload = () => { if (!mounted) return;
        pdfjsLib.getDocument({ data: new Uint8Array(r.result as ArrayBuffer) }).promise.then(onLoad).catch(onErr); };
      r.readAsArrayBuffer(file);
    } else {
      pdfjsLib.getDocument(activeDrawingUrl!).promise.then(onLoad).catch(onErr);
    }
    return () => { mounted = false; };
  }, [activeDrawingId, activeDrawingUrl, centerDocumentInViewport]);

  // ── PDF render ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!pdf) return;
    let active = true; let task: any = null;
    (async () => {
      try {
        const page   = await pdf.getPage(pageNumber); if (!active) return;
        const rawDpr = window.devicePixelRatio || 1;
        const logVP  = page.getViewport({ scale });
        const safeDpr = Math.sqrt(16_000_000 / (logVP.width * logVP.height));
        const dpr    = Math.min(rawDpr, safeDpr, 3);
        const physVP = page.getViewport({ scale: scale * dpr });
        const canvas = pdfCanvasRef.current; if (!canvas) return;
        const ctx    = canvas.getContext('2d'); if (!ctx) return;
        canvas.width = physVP.width; canvas.height = physVP.height;
        canvas.style.width = `${logVP.width}px`; canvas.style.height = `${logVP.height}px`;
        for (const ref of [drawingCanvasRef, pinCanvasRef]) {
          const c = ref.current; if (!c) continue;
          c.width = logVP.width; c.height = logVP.height;
          c.style.width = `${logVP.width}px`; c.style.height = `${logVP.height}px`;
        }
        setPdfDimensions({ w: logVP.width, h: logVP.height });
        task = page.render({ canvasContext: ctx, viewport: physVP, canvas: canvas as any } as any);
        await task.promise;
      } catch (err: any) { if (err?.name !== 'RenderingCancelledException') console.error(err); }
    })();
    return () => { active = false; task?.cancel(); };
  }, [pdf, pageNumber, scale]);

  useEffect(() => { if (pdf && pdfDimensions) centerDocumentInViewport(); },
    [pageNumber, pdfDimensions, centerDocumentInViewport, pdf]);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
        const map: Record<string, ToolType> = { v:'select', l:'linear', r:'rectangle', p:'polygon', n:'count', t:'point' };
        if (map[e.key.toLowerCase()]) { e.preventDefault(); setActiveTool(map[e.key.toLowerCase()]); return; }
      }
      const cm = e.ctrlKey || e.metaKey;
      if (cm && (e.key === '+' || e.key === '=')) { e.preventDefault(); setScale(s => Math.min(MAX_ZOOM, s + ZOOM_SENSITIVITY)); return; }
      if (cm && e.key === '-')                     { e.preventDefault(); setScale(s => Math.max(MIN_ZOOM, s - ZOOM_SENSITIVITY)); return; }
      if (cm && e.key === '0')                     { e.preventDefault(); fitToScreen(); return; }
      if (cm && e.key === 'z' && !e.shiftKey)      { e.preventDefault(); handleUndo(); return; }
      if (cm && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); handleRedo(); return; }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [fitToScreen, handleUndo, handleRedo, setActiveTool]);

  // ── Wheel zoom ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return; e.preventDefault();
      const delta = (e.deltaY > 0 ? -1 : 1) * ZOOM_SENSITIVITY * (1 + Math.min(Math.abs(e.deltaY) / 100, 1) * 0.5);
      const rect  = el.getBoundingClientRect();
      const cx    = e.clientX - rect.left + el.scrollLeft;
      const cy    = e.clientY - rect.top  + el.scrollTop;
      setScale(prev => {
        const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev + delta));
        if (next === prev) return prev;
        const ratio = next / prev;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const c = containerRef.current; if (!c) return;
          c.scrollLeft = cx * ratio - (e.clientX - rect.left);
          c.scrollTop  = cy * ratio - (e.clientY - rect.top);
        }));
        return next;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ── Spacebar pan ───────────────────────────────────────────────────────────
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || (e.target as HTMLElement).tagName === 'INPUT') return;
      e.preventDefault();
      if (!e.repeat) { spaceHeldRef.current = true; setSpaceHeld(true); }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      spaceHeldRef.current = false; setSpaceHeld(false); setIsPanning(false);
      if (containerRef.current) containerRef.current.style.cursor = '';
    };
    window.addEventListener('keydown', onDown, { capture: true });
    window.addEventListener('keyup',   onUp,   { capture: true });
    return () => {
      window.removeEventListener('keydown', onDown, { capture: true });
      window.removeEventListener('keyup',   onUp,   { capture: true });
    };
  }, []);

  // ── Pan helpers ────────────────────────────────────────────────────────────
  const startPan = useCallback((e: React.PointerEvent, target: HTMLElement) => {
    if (!pdfRef.current) return;
    e.preventDefault(); target.setPointerCapture(e.pointerId);
    setIsPanning(true);
    if (containerRef.current) containerRef.current.style.cursor = 'grabbing';
  }, []);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button === 1 || (e.button === 0 && spaceHeldRef.current) || (e.button === 0 && activeTool === 'select'))
      startPan(e, e.currentTarget as HTMLElement);
  };
  const handlePointerUp = () => { setIsPanning(false); if (containerRef.current) containerRef.current.style.cursor = ''; };
  const handleContainerPointerMove = (e: React.PointerEvent) => {
    if (isPanning && containerRef.current) {
      containerRef.current.scrollLeft -= e.movementX;
      containerRef.current.scrollTop  -= e.movementY;
    }
  };
  const handleDrawingCanvasPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button === 1 || (e.button === 0 && spaceHeldRef.current)) {
      e.stopPropagation(); if (containerRef.current) startPan(e, containerRef.current);
    }
  }, [startPan]);

  // ── Wrap dims ──────────────────────────────────────────────────────────────
  const wrapDims = pdf && pdfDimensions && containerRef.current ? (() => {
    const vw = containerRef.current.clientWidth;
    const vh = containerRef.current.clientHeight;
    return { width: Math.max(pdfDimensions.w + CANVAS_PADDING * 2, vw * 3), height: Math.max(pdfDimensions.h + CANVAS_PADDING * 2, vh * 3) };
  })() : undefined;

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 relative bg-industrial-black blueprint-grid flex flex-col overflow-hidden h-full">

      {!hideToolbar && (
        <ViewerToolbar
          activeTool={activeTool} setActiveTool={setActiveTool}
          canUndo={canUndo} canRedo={canRedo} handleUndo={handleUndo} handleRedo={handleRedo}
          tempPointsCount={tempPoints.length}
          snapEnabled={snapEnabled} setSnapEnabled={setSnapEnabled}
          showSnapSettings={showSnapSettings} setShowSnapSettings={setShowSnapSettings}
          scaleFactor={scaleFactor} handleManualScale={handleManualScale}
          analysisStatus={analysisStatus} analysisPage={analysisPage ?? null}
          currentPageCorners={pageData.get(pageNumber - 1)?.corners.length ?? 0}
          scale={scale} setScale={setScale} fitToScreen={() => fitToScreen()}
          MIN_ZOOM={MIN_ZOOM} MAX_ZOOM={MAX_ZOOM} ZOOM_SENSITIVITY={ZOOM_SENSITIVITY}
        />
      )}

      {showSnapSettings && (
        <SnapSettingsPanel
          showPins={showPins}              onShowPinsChange={setShowPins}
          snapThreshold={snapThreshold}    onSnapThresholdChange={setSnapThreshold}
          confidenceFilter={confidenceFilter} onConfidenceFilterChange={setConfidenceFilter}
          snapEnabled={snapEnabled}        onSnapEnabledChange={setSnapEnabled}
        />
      )}

      <div
        ref={containerRef}
        className="flex-1 overflow-auto custom-scrollbar relative outline-none select-none"
        onKeyDown={e => {
          if (e.code === 'Space') e.preventDefault();

          // ── FIX 1: Escape ─────────────────────────────────────────────────
          // If drawing: finish the current measurement (same as before).
          // If idle:    switch to the select tool so users can exit any active
          //             drawing tool without clicking the toolbar.
          if (e.key === 'Escape') {
            if (tempPoints.length > 0) {
              handleFinishMeasurement();
            } else {
              setActiveTool('select');
            }
          }

          // Enter to finish (existing)
          if (e.key === 'Enter') { e.preventDefault(); if (tempPoints.length > 0) handleFinishMeasurement(); }
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handleContainerPointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        tabIndex={0}
      >
        <div className={cn(!pdf ? 'min-h-full min-w-full flex items-center justify-center p-8' : 'relative')} style={wrapDims}>
          <ViewerCanvas
            pdfCanvasRef={pdfCanvasRef} drawingCanvasRef={drawingCanvasRef} pinCanvasRef={pinCanvasRef}
            pdf={pdf} loading={loading} pdfDimensions={pdfDimensions}
            activeTool={activeTool} showPins={showPins} isPanning={isPanning} spaceHeld={spaceHeld}
            tempPoints={tempPoints} measurements={measurements} activeDrawingId={activeDrawingId}
            snapFlashes={snapFlashes} toCanvas={toCanvas}
            handleCanvasClick={handleCanvasClick} handleContextMenu={handleContextMenu}
            handleCanvasPointerMove={handleCanvasPointerMove}
            handleCanvasPointerDown={handleCanvasPointerDown as (e: React.PointerEvent<HTMLCanvasElement>) => boolean | undefined}
            handleCanvasPointerUp={handleCanvasPointerUp}
            handleDrawingCanvasPointerDown={handleDrawingCanvasPointerDown}
            setCursorPoint={setCursorPoint} cursorPointRef={cursorPointRef}
            redrawPinCanvas={redrawPinCanvas}
            handleFinishMeasurement={handleFinishMeasurement}
            handleFileUpload={handleFileUpload}
            containerRef={containerRef} CANVAS_PADDING={CANVAS_PADDING}
          />
        </div>

        <SnapCandidateWired
          pendingSnapCandidates={pendingSnapCandidates}
          setPendingSnapCandidates={setPendingSnapCandidates}
          measurements={measurements} onUpdateMeasurement={onUpdateMeasurement}
        />
      </div>

      {pdf && pdfDimensions && (
        <div className="absolute bottom-12 left-2 z-40">
          <Minimap
            pdf={pdf} pageNumber={pageNumber}
            containerRef={containerRef as React.RefObject<HTMLDivElement>}
            pdfDimensions={pdfDimensions} canvasPadding={CANVAS_PADDING}
            activeTool={activeTool}
          />
        </div>
      )}

      {pdf && (
        <div className="h-10 flex-shrink-0 bg-industrial-panel border-t border-industrial-border px-4 flex items-center justify-between z-20 font-mono relative shadow-sm">
          <div className="flex items-center gap-4">
            <button onClick={() => setPageNumber(p => Math.max(1, p - 1))} disabled={pageNumber <= 1} className="p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-50">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-tighter">
              PAGE {pageNumber} OF {pdf.numPages}
            </span>
            <button onClick={() => setPageNumber(p => Math.min(pdf.numPages, p + 1))} disabled={pageNumber >= pdf.numPages} className="p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-50">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          {/* ── FIX 1: updated hint to reflect Escape-to-select behaviour ── */}
          <div className="hidden md:flex items-center gap-4 text-[9px] text-zinc-500 uppercase tracking-widest">
            <span>Double-click or right-click to finish · ESC to cancel / select · Enter to finish · Space+drag to pan</span>
            <div className="w-px h-3 bg-industrial-border" />
            <span>RENDER_ENGINE: PDF.JS V{pdfjsLib.version}</span>
          </div>
        </div>
      )}

      <CalibrationDialog
        show={showCalibrationDialog} calibrationInput={calibrationInput}
        setCalibrationInput={setCalibrationInput}
        onConfirm={handleCalibrationConfirm} onCancel={() => setShowCalibrationDialog(false)}
      />
      <MeasurementDetailsWired
        show={showMeasurementDialog} pendingMeasurementData={pendingMeasurementData}
        onConfirm={handleDialogConfirm} onSkip={handleDialogSkip}
      />
      <PresetDrawerWired
        showPresetDrawer={showPresetDrawer}
        onClosePresetDrawer={onClosePresetDrawer}
        onSelectPreset={onSelectPreset}
      />
      <AppendGroupBanner appendToGroupId={propAppendToGroupId} onCancel={() => onAppendComplete?.()} />

      <style>{`
        @keyframes snapPulse {
          0%   { transform: translate(-50%,-50%) scale(0.5); opacity: 1; }
          100% { transform: translate(-50%,-50%) scale(2.5); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
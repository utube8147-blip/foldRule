'use client';

// ─── components/Viewer/Viewer.tsx ─────────────────────────────────────────────
//
//  FIX SUMMARY (this revision — green blob bleed when switching to grid-count):
//
//  1. Triple-rAF fill-canvas clear — useMagicFillSession schedules async
//     repaints on fillCanvasRef (triggered by pdfRenderCount changes). Even
//     the previous double-rAF clear could be beaten by a repaint that was
//     queued during the same React flush. A third nested rAF guarantees we
//     are the LAST writer on the fill canvas after any in-flight repaints,
//     eliminating the green blob bleed that appeared when switching to the
//     grid-count tool after a magic-fill session.
//
//  PREVIOUS FIX SUMMARY (grid-count tool not working):
//
//  2. handleContainerPointerDown — early return when activeTool === 'grid-count'
//     so the container never calls setPointerCapture and steals pointer events
//     away from the GridCountOverlay canvas.
//
//  3. prevToolRef effect — clears fillCanvasRef whenever activeTool !== 'magic-fill'.
//
//  4. handleGridCountCommit — deferred setActiveTool('select') via setTimeout(0)
//     so the commit flushes before the prevToolRef clear effect runs.
//
//  5. prevToolRef effect — abort + clear only runs when tool actually changes.
//
// ─────────────────────────────────────────────────────────────────────────────

import React, {
  useRef, useEffect, useState, useCallback, useMemo,
} from 'react';
import type * as pdfjsLibTypes from "pdfjs-dist/legacy/build/pdf";
import { ChevronLeft, ChevronRight, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToolType, TakeoffRow } from '@/types';

import { Minimap }           from './Minimap';
import { SnapSettingsPanel } from './SnapSettingsPanel';
import { useSnapEngine }     from '@/hooks/useSnapEngine';
import { useMeasurements }   from '@/hooks/useMeasurements';
import { useTakeoffContext }  from '@/context/TakeoffContext';
import { useViewerPdf }      from '@/hooks/useViewerPdf';
import { useMagicFillSession } from '@/hooks/useMagicFillSession';

import { ViewerToolbar }  from './Viewer/ViewerToolbar';
import { ViewerCanvas }   from './Viewer/ViewerCanvas';
import {
  CalibrationDialog, AppendGroupBanner,
  SnapCandidateWired, MeasurementDetailsWired, PresetDrawerWired,
} from './Viewer/ViewerDialogs';
import {
  CANVAS_PADDING, ZOOM_SENSITIVITY, MIN_ZOOM, MAX_ZOOM, VIEWER_TOOLS,
} from './Viewer/ViewerConstants';

import {
  MagicFillCanvas,
} from '@/components/Viewer/MagicFillCanvas';
import {
  MagicFillProgressOverlay,
  MagicFillHoverTooltip,
  MagicFillGroupPanel,
  MagicFillSelectedPanel,
  fmtArea,
} from '@/components/Viewer/MagicFillUI';

import {
  stagedArcCount as calcStagedArcCount,
  stagedRadiusCount,
} from '@/hooks/useMeasurements/useMeasurementCommit';

export type { ViewerProps, ViewerToolbarAPI } from './Viewer/ViewerConstants';

function getPdfLib(): typeof pdfjsLibTypes {
  if (typeof window === "undefined") throw new Error("pdfjs not available on server");
  return require("pdfjs-dist/legacy/build/pdf");
}

interface PendingMeasurementData {
  id: string;
  type: string;
  description: string;
}

interface UndoRedoRefValue {
  setCursorPoint: (p: React.SetStateAction<{ x: number; y: number } | null>) => void;
}

export function Viewer(props: import('./Viewer/ViewerConstants').ViewerProps) {
  const {
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
  } = props as any;

  const onDeleteMeasurementProp = (props as any).onDeleteMeasurement as
    | ((...args: any[]) => any)
    | undefined;

  // ── Canvas refs ────────────────────────────────────────────────────────────
  const pdfCanvasRef     = useRef<HTMLCanvasElement>(null!);
  const drawingCanvasRef = useRef<HTMLCanvasElement>(null!);
  const pinCanvasRef     = useRef<HTMLCanvasElement>(null!);
  const vectorCanvasRef  = useRef<HTMLCanvasElement>(null!);
  const fillCanvasRef    = useRef<HTMLCanvasElement>(null!);
  const containerRef     = useRef<HTMLDivElement>(null!);

  const activeDrawingId  = activeDrawing?.id     ?? null;
  const activeDrawingUrl = activeDrawing?.fileUrl ?? null;

  // ── Settings ───────────────────────────────────────────────────────────────
  const [snapEnabled,      setSnapEnabled]      = useState(true);
  const [showPins,         setShowPins]         = useState(true);
  const [snapThreshold,    setSnapThreshold]    = useState(14);
  const [confidenceFilter, setConfidenceFilter] = useState(0.1);
  const [showSnapSettings, setShowSnapSettings] = useState(false);

  // ── Dialog state ───────────────────────────────────────────────────────────
  const [showCalibrationDialog,  setShowCalibrationDialog]  = useState(false);
  const [pendingPtLen,           setPendingPtLen]           = useState(0);
  const [calibrationInput,       setCalibrationInput]       = useState('');
  const [showMeasurementDialog,  setShowMeasurementDialog]  = useState(false);
  const [pendingMeasurementData, setPendingMeasurementData] = useState<PendingMeasurementData | null>(null);

  // ── Context ────────────────────────────────────────────────────────────────
  const {
    tempPoints, pushPoint, commitMeasurement, batchCommitMeasurements,
    clearTempPoints, undo, redo, canUndo, canRedo,
    selectedId, projectState, updateMeasurement,
  } = useTakeoffContext();

  const undoRedoRef = useRef<UndoRedoRefValue>({ setCursorPoint: () => {} });
  const handleUndo  = useCallback(() => { undo();  undoRedoRef.current.setCursorPoint(null); }, [undo]);
  const handleRedo  = useCallback(() => { redo();  undoRedoRef.current.setCursorPoint(null); }, [redo]);

  // ── isMagicFillActiveRef — hoisted so useViewerPdf can read it ───────────
  const isMagicFillActiveRef = useRef(activeTool === 'magic-fill');
  isMagicFillActiveRef.current = activeTool === 'magic-fill';

  // ── PDF hook ───────────────────────────────────────────────────────────────
  const startExtractionRef = useRef<((pdf: any, file?: File) => void) | null>(null);

  const {
    pdf, pageNumber, setPageNumber, loading,
    scale, setScale, committedScale,
    pdfDimensions, pdfRenderCount,
    isPanning, spaceHeld, spaceHeldRef,
    wrapStyle, fitToScreen, centerDocumentInViewport, handleManualScale,
    handleContainerPointerDown: pdfContainerPointerDown,
    handleContainerPointerMove,
    handleContainerPointerUp,
    handleDrawingCanvasPointerDown,
    pdfRef, pageNumberRef, scaleRef, pdfDimensionsRef, onScaleSetRef,
  } = useViewerPdf({
    containerRef,
    pdfCanvasRef,
    drawingCanvasRef,
    pinCanvasRef,
    vectorCanvasRef,
    fillCanvasRef,
    activeDrawingId,
    activeDrawingUrl,
    activeDrawingFile: activeDrawing?.file,
    onPdfLoaded: (doc, file) => startExtractionRef.current?.(doc, file),
    onScaleSet,
    shouldPreserveFillCanvas: isMagicFillActiveRef,
  });

  const appendToGroupId = propAppendToGroupId ?? undefined;

  // ── Snap engine ────────────────────────────────────────────────────────────
  const {
    pageData, analysisStatus, analysisPage, snapFlashes,
    startExtraction, getScaledCorners,
    snapToCorner, triggerSnapFlash, redrawPinCanvas, cursorPointRef,
  } = useSnapEngine({
    pinCanvasRef:     pinCanvasRef     as React.RefObject<HTMLCanvasElement>,
    pdfDimensionsRef: pdfDimensionsRef as React.RefObject<NonNullable<typeof pdfDimensions>>,
    pageNumberRef:    pageNumberRef    as React.RefObject<number>,
    viewportRef:      containerRef     as React.RefObject<HTMLDivElement>,
    zoom:             scale,
    pan:              { x: 0, y: 0 },
    snapEnabled, showPins, snapThreshold, confidenceFilter,
  });

  const stagedArcs = calcStagedArcCount(tempPoints);

  useEffect(() => { startExtractionRef.current = startExtraction; }, [startExtraction]);

  const setActiveToolString = useCallback(
    (t: string) => setActiveTool(t as ToolType),
    [setActiveTool],
  );

  // ── Calibration ────────────────────────────────────────────────────────────
  const handleScalePrompt = useCallback((ptLen: number) => {
    setPendingPtLen(ptLen);
    setCalibrationInput('');
    setShowCalibrationDialog(true);
  }, []);

  const handleCalibrationConfirm = useCallback(() => {
    const r = parseFloat(calibrationInput);
    if (!isNaN(r) && r > 0 && pendingPtLen > 0) onScaleSetRef.current(r / pendingPtLen);
    setShowCalibrationDialog(false);
  }, [calibrationInput, pendingPtLen, onScaleSetRef]);

  const onUpdateMeasurement = useCallback(
    (id: string, updates: Partial<TakeoffRow>) => onUpdateMeasurementProp?.(id, updates),
    [onUpdateMeasurementProp],
  );

  // ── Measurements engine ────────────────────────────────────────────────────
  const {
    pendingSnapCandidates, setPendingSnapCandidates,
    finishMeasurement, handleCanvasClick, handleContextMenu,
    handleCanvasPointerMove, handleCanvasPointerDown,
    handleCanvasPointerUp, toCanvas, setCursorPoint,
  } = useMeasurements({
    drawingCanvasRef: drawingCanvasRef as React.RefObject<HTMLCanvasElement>,
    pdfDimensionsRef: pdfDimensionsRef as React.RefObject<NonNullable<typeof pdfDimensions>>,
    pageNumberRef:    pageNumberRef    as React.RefObject<number>,
    scaleRef:         scaleRef        as React.RefObject<number>,
    activeTool, setActiveTool: setActiveToolString,
    measurements, tempPoints, pushPoint,
    commitMeasurement, batchCommitMeasurements,
    appendToGroupId, onAppendComplete,
    onScalePrompt: handleScalePrompt,
    clearTempPoints, scaleFactor, onUpdateMeasurement,
    isPanning, snapToCorner: snapToCorner as any, getScaledCorners,
    triggerSnapFlash, snapEnabled, snapThreshold,
    redrawPinCanvas, cursorPointRef, activeDrawingId,
  });

  useEffect(() => { undoRedoRef.current.setCursorPoint = setCursorPoint; }, [setCursorPoint]);

  // ── Grid-count commit handler ──────────────────────────────────────────────
  //
  //  FIX: Deferred setActiveTool('select') via setTimeout(0) so the commit
  //  flush + fillCanvasRef paint complete before the prevToolRef clear runs.
  const handleGridCountCommit = useCallback((
    count: number,
    spacingMm: number,
    cols: number,
    rows: number,
  ) => {
    const id    = crypto.randomUUID();
    const color = '#4ADE80';
    commitMeasurement({
      id,
      drawingId:   activeDrawingId || '',
      description: `Grid Count (${cols}×${rows})`,
      label:       'Grid Count',
      type:        'Count',
      quantity:    count,
      unit:        'intersections',
      unitRate:    0,
      notes:       `Grid spacing: ${spacingMm}mm  |  ${cols} cols × ${rows} rows`,
      points:      [],
      isOverridden: true,
      color,
      isVisible:   true,
      childIds:    [],
      gridSpacing: spacingMm,
    });

    setTimeout(() => setActiveTool('select'), 0);
  }, [commitMeasurement, activeDrawingId, setActiveTool]);

  // ── Magic Fill session ─────────────────────────────────────────────────────
  const {
    allVisibleFills, magicFills, mfStagedCount,
    mfSelectedId, setMfSelectedId,
    mfSelectedGroup, setMfSelectedGroup,
    mfHoveredId, mfHoverPos,
    mfHolesClosed, mfHiddenIds,
    mfIsFilling, mfIsRepainting,
    mfFillMsg, mfFillSub, mfFillProgress,
    mfMetersPerPixel, mfLastFillPos,
    showMfNameDialog, pendingMfData,
    handleMagicSingleClick, handleMagicBatchRect,
    handleMagicHover, handleMagicHoverLeave,
    handleMagicFillHoles, handleMagicUndo,
    handleMagicClear, handleMagicDelete,
    handleMagicToggleHide, handleMagicAbortSession,
    handleMagicFinish, handleMfNameConfirm, handleMfNameSkip,
  } = useMagicFillSession({
    fillCanvasRef,
    pdfRenderCount,
    pdfCanvasRef,
    pdfDimensions,
    scaleFactor,
    isMagicFillActiveRef,
    activeDrawingId,
    measurements,
    propAppendToGroupId: appendToGroupId,
    onAddMeasurementProp,
    onUpdateMeasurementProp,
    onDeleteMeasurementProp,
    onAppendComplete,
    batchCommitMeasurements,
  });

  // ── Tool-switch side effects: abort magic-fill + clear fill canvas ─────────
  //
  //  GREEN BLOB BLEED FIX:
  //  useMagicFillSession repaints fillCanvasRef asynchronously in response to
  //  pdfRenderCount changes. The previous double-rAF clear could be beaten by
  //  a repaint queued during the same React flush. We now use a triple nested
  //  rAF: by the time the third frame fires, all same-flush async repaints
  //  will have completed, making our clear the guaranteed last writer.
  //
  //  isMagicFillActiveRef is checked before every clear so we never erase a
  //  legitimate magic-fill repaint if the user switches back quickly.
  const prevToolRef = useRef(activeTool);

  useEffect(() => {
    const prev = prevToolRef.current;

    // Only act when the tool actually changed.
    if (prev === activeTool) return;

    prevToolRef.current = activeTool;

    // Abort any in-progress magic-fill session when leaving the tool.
    if (prev === 'magic-fill' && activeTool !== 'magic-fill') {
      handleMagicAbortSession();
    }

    // Clear the fill canvas whenever we leave magic-fill.
    if (activeTool !== 'magic-fill') {
      const clearFillCanvas = () => {
        const canvas = fillCanvasRef.current;
        if (canvas) {
          const ctx = canvas.getContext('2d');
          if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
      };

      // Synchronous clear — removes any paint already on the canvas now.
      clearFillCanvas();

      // Triple nested rAF clear:
      //   rAF 1 — fires after current frame's queued micro/macrotasks.
      //   rAF 2 — fires after any repaints triggered by rAF-1 callbacks.
      //   rAF 3 — fires after any repaints triggered by rAF-2 callbacks.
      //           By this point all useMagicFillSession async repaints that
      //           were in-flight at the time of the tool switch will have run,
      //           so this clear is guaranteed to be the last writer.
      const rafId = requestAnimationFrame(() => {
        if (!isMagicFillActiveRef.current) {
          clearFillCanvas();
          requestAnimationFrame(() => {
            if (!isMagicFillActiveRef.current) {
              clearFillCanvas();
              requestAnimationFrame(() => {
                if (!isMagicFillActiveRef.current) clearFillCanvas();
              });
            }
          });
        }
      });

      return () => cancelAnimationFrame(rafId);
    }
  }, [activeTool, handleMagicAbortSession]);

  // ── Finish + measurement name dialog ──────────────────────────────────────
  const handleFinishMeasurement = useCallback(() => {
    const minPts = activeTool === 'count' || activeTool === 'point' ? 1 : 2;
    if (tempPoints.length < minPts) { finishMeasurement(); return; }
    if (propAppendToGroupId) { finishMeasurement(); onAppendComplete?.(); return; }
    const type =
      activeTool === 'polygon' || activeTool === 'rectangle' ? 'Polygon' :
      activeTool === 'linear'  ? 'Length' :
      activeTool === 'arc'     ? 'Length' :
      activeTool === 'radius'  ? 'Length' :
      activeTool === 'count'   ? 'Count'  : 'Point';
    setPendingMeasurementData({ id: `temp-${Date.now()}`, type, description: `New ${type}` });
    setShowMeasurementDialog(true);
  }, [tempPoints.length, activeTool, finishMeasurement, propAppendToGroupId, onAppendComplete]);

  const handleDialogConfirm = useCallback((name: string, _: string, icon?: string) => {
    setShowMeasurementDialog(false);
    finishMeasurement(undefined, {
      label: name.trim() || `New ${pendingMeasurementData?.type || 'Measurement'}`,
      icon,
    });
  }, [finishMeasurement, pendingMeasurementData]);

  const handleDialogSkip = useCallback(() => {
    setShowMeasurementDialog(false);
    finishMeasurement();
  }, [finishMeasurement]);

  // ── Pitch factor — apply to selected measurement row ──────────────────────
  const handleApplyPitchFactor = useCallback((factor: number) => {
    if (!selectedId) return;
    const row = projectState?.measurements?.find((m: TakeoffRow) => m.id === selectedId);
    if (!row || (row as any).isGroupHeader || row.type !== 'Length') return;
    const newQty = +(row.quantity * factor).toFixed(4);
    updateMeasurement(row.id, {
      quantity:     newQty,
      isOverridden: true,
      notes: [(row as any).notes, `Pitch ×${factor.toFixed(4)} applied`]
        .filter(Boolean).join(' | '),
    });
  }, [selectedId, projectState, updateMeasurement]);

  // ── Toolbar API ────────────────────────────────────────────────────────────
  const toolbarAPI = useMemo(() => ({
    tools: VIEWER_TOOLS as any,
    activeTool, setActiveTool, scale, setScale, scaleFactor,
    snapEnabled, setSnapEnabled, showSnapSettings, setShowSnapSettings,
    showPins, setShowPins, snapThreshold, setSnapThreshold,
    confidenceFilter, setConfidenceFilter, analysisStatus,
    analysisPage: analysisPage ?? null,
    currentPageCorners: pageData.get(pageNumber - 1)?.corners.length ?? 0,
    pdf, pageNumber,
    fitToScreen: () => fitToScreen(),
    handleManualScale,
    canUndo, canRedo, handleUndo, handleRedo,
  }), [
    activeTool, setActiveTool, scale, scaleFactor,
    snapEnabled, showSnapSettings, showPins, snapThreshold, confidenceFilter,
    analysisStatus, analysisPage, pageData, pageNumber, pdf,
    fitToScreen, handleManualScale, canUndo, canRedo, handleUndo, handleRedo,
  ]);

  useEffect(() => { onToolbarReady?.(toolbarAPI); }, [onToolbarReady, toolbarAPI]);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (activeTool === 'magic-fill' && mfStagedCount > 0) {
          handleMagicAbortSession(); return;
        }
      }
      const tag = (e.target as HTMLElement).tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
        const map: Record<string, ToolType> = {
          v: 'select',    l: 'linear',   r: 'rectangle',
          p: 'polygon',   n: 'count',    t: 'point',
          b: 'arc',
          g: 'grid-count',
        };
        if (map[e.key.toLowerCase()]) {
          e.preventDefault();
          setActiveTool(map[e.key.toLowerCase()]);
          return;
        }
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
  }, [activeTool, mfStagedCount, fitToScreen, handleUndo, handleRedo, setActiveTool, handleMagicAbortSession, setScale]);

  // ── Pan: activeTool-aware container pointer down ───────────────────────────
  //
  //  FIX: Early-return when activeTool === 'grid-count' so the container
  //  never calls setPointerCapture, leaving the GridCountOverlay canvas free
  //  to handle its own full drag sequence.
  const handleContainerPointerDown = useCallback((e: React.PointerEvent) => {
    if (activeTool === 'grid-count') return;

    if (
      e.button === 1 ||
      (e.button === 0 && spaceHeldRef.current) ||
      (e.button === 0 && activeTool === 'select')
    ) {
      pdfContainerPointerDown(e);
    }
  }, [activeTool, spaceHeldRef, pdfContainerPointerDown]);

  // ── File upload ────────────────────────────────────────────────────────────
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) =>
    Array.from(e.target.files ?? []).forEach(f =>
      onDrawingAdded(f.name, URL.createObjectURL(f), f));

  // ── Derived state ──────────────────────────────────────────────────────────
  const isMagicFillTool = activeTool === 'magic-fill';
  const isGridCountTool = activeTool === 'grid-count';

  const mfHoveredFill  = allVisibleFills.find(f => f.id === mfHoveredId)  ?? null;
  const mfSelectedFill = allVisibleFills.find(f => f.id === mfSelectedId) ?? null;
  const mfGroupFills   = mfSelectedGroup != null
    ? magicFills.filter(f => f.groupId === mfSelectedGroup)
    : [];

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 relative bg-industrial-black blueprint-grid flex flex-col overflow-hidden h-full">

      {!hideToolbar && (
        <div className="relative z-30 flex-shrink-0">
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
            onApplyPitchFactor={handleApplyPitchFactor}
          />
        </div>
      )}

      {showSnapSettings && (
        <SnapSettingsPanel
          showPins={showPins}                 onShowPinsChange={setShowPins}
          snapThreshold={snapThreshold}       onSnapThresholdChange={setSnapThreshold}
          confidenceFilter={confidenceFilter} onConfidenceFilterChange={setConfidenceFilter}
          snapEnabled={snapEnabled}           onSnapEnabledChange={setSnapEnabled}
        />
      )}

      <div className="flex flex-1 overflow-hidden min-h-0 relative isolate">

        {isMagicFillTool && (
          <MagicFillProgressOverlay
            active={mfIsFilling || mfIsRepainting}
            message={mfIsRepainting ? 'Updating fills…' : mfFillMsg}
            sub={mfIsRepainting ? undefined : mfFillSub}
            progress={mfIsRepainting ? null : mfFillProgress}
          />
        )}

        <div
          ref={containerRef}
          className="flex-1 overflow-auto custom-scrollbar relative outline-none select-none"
          onKeyDown={e => {
            if (e.code === 'Space') e.preventDefault();
            if (e.key === 'Escape') {
              if (activeTool === 'magic-fill' && mfStagedCount > 0) {
                handleMagicAbortSession();
              } else if (tempPoints.length > 0) {
                handleFinishMeasurement();
              } else {
                setActiveTool('select');
              }
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              if (activeTool === 'magic-fill' && mfStagedCount > 0) {
                handleMagicFinish();
              } else if (tempPoints.length > 0) {
                handleFinishMeasurement();
              }
            }
          }}
          onPointerDown={handleContainerPointerDown}
          onPointerMove={handleContainerPointerMove}
          onPointerUp={handleContainerPointerUp}
          onPointerLeave={handleContainerPointerUp}
          tabIndex={0}
        >
          <div
            className={cn(!pdf ? 'min-h-full min-w-full flex items-center justify-center p-8' : 'relative')}
            style={wrapStyle}
          >
            <ViewerCanvas
              pdfCanvasRef={pdfCanvasRef}
              drawingCanvasRef={drawingCanvasRef}
              pinCanvasRef={pinCanvasRef}
              vectorCanvasRef={vectorCanvasRef}
              fillCanvasRef={fillCanvasRef}
              pdf={pdf} loading={loading} pdfDimensions={pdfDimensions}
              activeTool={activeTool} showPins={showPins} isPanning={isPanning} spaceHeld={spaceHeld}
              tempPoints={tempPoints} measurements={measurements} activeDrawingId={activeDrawingId}
              snapFlashes={snapFlashes.map(f => ({ ...f, id: String(f.id) }))} toCanvas={toCanvas}
              readyToDraw={true}
              handleCanvasClick={handleCanvasClick}
              handleContextMenu={handleContextMenu}
              handleCanvasPointerMove={handleCanvasPointerMove}
              handleCanvasPointerDown={handleCanvasPointerDown as (e: React.PointerEvent<HTMLCanvasElement>) => boolean | undefined}
              handleCanvasPointerUp={handleCanvasPointerUp}
              handleDrawingCanvasPointerDown={handleDrawingCanvasPointerDown}
              setCursorPoint={setCursorPoint} cursorPointRef={cursorPointRef}
              redrawPinCanvas={redrawPinCanvas}
              handleFinishMeasurement={handleFinishMeasurement}
              handleFileUpload={handleFileUpload}
              containerRef={containerRef} CANVAS_PADDING={CANVAS_PADDING}
              isGridCountActive={isGridCountTool}
              scaleFactor={scaleFactor}
              onGridCountCommit={handleGridCountCommit}
              stagedArcCount={stagedArcs}
            >
              <MagicFillCanvas
                pdfDimensions={pdfDimensions}
                active={isMagicFillTool}
                isFilling={mfIsFilling || mfIsRepainting}
                fills={allVisibleFills}
                hiddenIds={mfHiddenIds}
                selectedId={mfSelectedId}
                selectedGroup={mfSelectedGroup}
                onSingleClick={handleMagicSingleClick}
                onBatchRect={handleMagicBatchRect}
                onHover={handleMagicHover}
                onHoverLeave={handleMagicHoverLeave}
              />

              {isMagicFillTool &&
                mfStagedCount > 0 &&
                !mfIsFilling &&
                !mfIsRepainting &&
                !propAppendToGroupId &&
                mfLastFillPos && (
                  <button
                    className="absolute z-[70] flex items-center justify-center gap-1.5 bg-amber-400 text-black font-bold font-mono text-[10px] uppercase tracking-widest px-3 py-1.5 shadow-lg whitespace-nowrap hover:bg-amber-300 active:scale-95 transition-transform"
                    style={{ left: mfLastFillPos.x + 15, top: mfLastFillPos.y + 15 }}
                    onClick={e => { e.stopPropagation(); handleMagicFinish(); }}
                    onPointerDown={e => e.stopPropagation()}
                  >
                    <Check className="w-3 h-3" />
                    Finish ({mfStagedCount} fill{mfStagedCount !== 1 ? 's' : ''})
                  </button>
                )}

              {isMagicFillTool && mfHoveredFill && !mfIsFilling && !mfIsRepainting && (
                <MagicFillHoverTooltip
                  fill={mfHoveredFill}
                  metersPerPixel={mfMetersPerPixel}
                  holesClosed={mfHolesClosed}
                  viewportPos={mfHoverPos}
                />
              )}

              {isMagicFillTool && mfSelectedGroup != null && mfGroupFills.length > 0 && !mfHoveredFill && !mfIsRepainting && (
                <MagicFillGroupPanel
                  groupFills={mfGroupFills}
                  groupId={mfSelectedGroup}
                  metersPerPixel={mfMetersPerPixel}
                  holesClosed={mfHolesClosed}
                />
              )}

              {isMagicFillTool && mfSelectedFill && mfSelectedGroup == null && !mfHoveredFill && !mfIsRepainting && (
                <MagicFillSelectedPanel
                  fill={mfSelectedFill}
                  metersPerPixel={mfMetersPerPixel}
                  holesClosed={mfHolesClosed}
                />
              )}
            </ViewerCanvas>
          </div>

          <SnapCandidateWired
            pendingSnapCandidates={pendingSnapCandidates}
            setPendingSnapCandidates={setPendingSnapCandidates}
            measurements={measurements} onUpdateMeasurement={onUpdateMeasurement}
          />
        </div>
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
            <button
              onClick={() => setPageNumber(Math.max(1, pageNumber - 1))}
              disabled={pageNumber <= 1}
              className="p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-50"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-tighter">
              PAGE {pageNumber} OF {pdf.numPages}
            </span>
            <button
              onClick={() => setPageNumber(Math.min(pdf.numPages, pageNumber + 1))}
              disabled={pageNumber >= pdf.numPages}
              className="p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-50"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <div className="hidden md:flex items-center gap-4 text-[9px] text-zinc-500 uppercase tracking-widest">
            {isMagicFillTool ? (
              <>
                <span className={mfStagedCount > 0 ? 'text-amber-400' : ''}>
                  ⊕ Magic Fill
                  {mfStagedCount > 0
                    ? ` — ${mfStagedCount} staged`
                    : magicFills.length > 0
                    ? ` — ${magicFills.length} committed`
                    : ''}
                </span>
                {magicFills.length > 0 && mfStagedCount === 0 && (
                  <>
                    <div className="w-px h-3 bg-industrial-border" />
                    <span>
                      Total: {fmtArea(magicFills.reduce((s, f) => s + f.areaPx, 0), mfMetersPerPixel)}
                    </span>
                  </>
                )}
                <div className="w-px h-3 bg-industrial-border" />
                {mfStagedCount > 0 ? (
                  <span className="text-amber-400">Click Finish or press Enter to commit · Esc to discard</span>
                ) : (
                  <span>Click: fill · Drag: batch fill</span>
                )}
              </>
            ) : isGridCountTool ? (
              <span className="text-green-400">
                Grid Count — drag to define area · Enter spacing · click Commit
              </span>
            ) : activeTool === 'arc' ? (
              <span className="text-teal-400">
                {calcStagedArcCount(tempPoints) > 0
                  ? `Arc — ${calcStagedArcCount(tempPoints)} staged · click to add more · Finish or Enter to commit · Right-click cancels current arc`
                  : `Arc — click ${tempPoints.length === 0 ? 'start' : tempPoints.length === 1 ? 'midpoint' : 'end'} point · Right-click to cancel`
                }
              </span>
            ) : activeTool === 'radius' ? (
              <span className="text-purple-400">
                {stagedRadiusCount(tempPoints) > 0
                  ? `Radius — ${stagedRadiusCount(tempPoints)} staged · click to add more · Finish or Enter to commit · Right-click cancels current`
                  : `Radius — click ${tempPoints.filter(p => p.segmentId !== '__radius_break__').length === 0 ? 'centre' : 'edge'} point · Right-click to cancel`
                }
              </span>
            ) : (
              <span>
                Double-click or right-click to finish · ESC to cancel · Enter to finish
              </span>
            )}
            <span>RENDER_ENGINE: PDF.JS V{getPdfLib().version}</span>
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

      <MeasurementDetailsWired
        show={showMfNameDialog} pendingMeasurementData={pendingMfData}
        onConfirm={(name) => handleMfNameConfirm(name)}
        onSkip={handleMfNameSkip}
      />

      <PresetDrawerWired
        showPresetDrawer={showPresetDrawer ?? false}
        onClosePresetDrawer={onClosePresetDrawer ?? (() => {})}
        onSelectPreset={onSelectPreset ?? (() => {})}
      />

      <AppendGroupBanner
        appendToGroupId={propAppendToGroupId}
        onCancel={() => onAppendComplete?.()}
      />

      <style>{`
        @keyframes snapPulse {
          0%   { transform: translate(-50%,-50%) scale(0.5); opacity: 1; }
          100% { transform: translate(-50%,-50%) scale(2.5); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
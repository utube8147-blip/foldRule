'use client';

// ─── components/Viewer/Viewer.tsx ─────────────────────────────────────────────
//
//  Orchestration layer only. Heavy logic lives in:
//    • useViewerPdf        — PDF load, render, zoom, pan, wrapStyle
//    • useMagicFillSession — staged/session/commit fill orchestration
//
//  This file owns:
//    • Canvas refs
//    • Snap engine wiring
//    • Measurements engine wiring
//    • Toolbar API assembly
//    • Dialog state (calibration, measurement name, magic-fill name)
//    • Keyboard shortcuts
//    • JSX render

import React, {
  useRef, useEffect, useState, useCallback, useMemo,
} from 'react';
import pdfjsLib from "@/lib/pdfClient";
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

export type { ViewerProps, ViewerToolbarAPI } from './Viewer/ViewerConstants';

interface PendingMeasurementData {
  id: string;
  type: string;
  description: string;
}

interface UndoRedoRefValue {
  setCursorPoint: (p: React.SetStateAction<{ x: number; y: number } | null>) => void;
}

interface MagicFillHit {
  id: number;
  groupId: number | null;
  areaPx: number;
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

  // backward-compat: ViewerProps may not declare onDeleteMeasurement, read if present
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

  const activeDrawingId      = activeDrawing?.id     ?? null;
  const activeDrawingUrl     = activeDrawing?.fileUrl ?? null;

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
  } = useTakeoffContext();

  const undoRedoRef = useRef<UndoRedoRefValue>({ setCursorPoint: () => {} });
  const handleUndo  = useCallback(() => { undo();  undoRedoRef.current.setCursorPoint(null); }, [undo]);
  const handleRedo  = useCallback(() => { redo();  undoRedoRef.current.setCursorPoint(null); }, [redo]);

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
  });

  // Normalize appendToGroupId: ensure it's string | undefined (not null)
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
    snapEnabled, showPins, snapThreshold, confidenceFilter,
  });

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
    appendToGroupId: appendToGroupId, onAppendComplete,
    onScalePrompt: handleScalePrompt,
    clearTempPoints, scaleFactor, onUpdateMeasurement,
    isPanning, snapToCorner: snapToCorner as any, getScaledCorners,
    triggerSnapFlash, snapEnabled, snapThreshold,
    redrawPinCanvas, cursorPointRef, activeDrawingId,
  });

  useEffect(() => { undoRedoRef.current.setCursorPoint = setCursorPoint; }, [setCursorPoint]);

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
    activeDrawingId,
    measurements,
    propAppendToGroupId: appendToGroupId,
    onAddMeasurementProp,
    onUpdateMeasurementProp,
    onDeleteMeasurementProp,
    onAppendComplete,
    batchCommitMeasurements,
  });

  // ── Abort magic-fill session on tool switch ────────────────────────────────
  const prevToolRef = useRef(activeTool);
  useEffect(() => {
    const prev = prevToolRef.current;
    prevToolRef.current = activeTool;
    if (prev === 'magic-fill' && activeTool !== 'magic-fill') {
      handleMagicAbortSession();
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

  // ── Toolbar API ────────────────────────────────────────────────────────────
  const toolbarAPI = useMemo(() => ({
    // preserve tuple type of VIEWER_TOOLS to satisfy ViewerToolbarAPI
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
          v: 'select', l: 'linear', r: 'rectangle',
          p: 'polygon', n: 'count',  t: 'point',
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
  // useViewerPdf exposes a generic handler; we add the 'select' tool condition here.
  const handleContainerPointerDown = useCallback((e: React.PointerEvent) => {
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

  // ── Derived magic-fill state ───────────────────────────────────────────────
  const isMagicFillTool = activeTool === 'magic-fill';

  const mfHoveredFill  = allVisibleFills.find(f => f.id === mfHoveredId)  ?? null;
  const mfSelectedFill = allVisibleFills.find(f => f.id === mfSelectedId) ?? null;
  const mfGroupFills   = mfSelectedGroup != null
    ? magicFills.filter(f => f.groupId === mfSelectedGroup)
    : [];

  // ── Render ─────────────────────────────────────────────────────────────────
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
          showPins={showPins}                 onShowPinsChange={setShowPins}
          snapThreshold={snapThreshold}       onSnapThresholdChange={setSnapThreshold}
          confidenceFilter={confidenceFilter} onConfidenceFilterChange={setConfidenceFilter}
          snapEnabled={snapEnabled}           onSnapEnabledChange={setSnapEnabled}
        />
      )}

      <div className="flex flex-1 overflow-hidden min-h-0 relative">

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
              readyToDraw={true /* controlled inside ViewerCanvas via its own guard */}
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

              {/* Floating Finish button */}
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
            ) : (
              <span>
                Double-click or right-click to finish · ESC to cancel · Enter to finish
              </span>
            )}
            <span>RENDER_ENGINE: PDF.JS V{pdfjsLib.version}</span>
          </div>
        </div>
      )}

      <CalibrationDialog
        show={showCalibrationDialog} calibrationInput={calibrationInput}
        setCalibrationInput={setCalibrationInput}
        onConfirm={handleCalibrationConfirm} onCancel={() => setShowCalibrationDialog(false)}
      />

      {/* Regular measurement name dialog */}
      <MeasurementDetailsWired
        show={showMeasurementDialog} pendingMeasurementData={pendingMeasurementData}
        onConfirm={handleDialogConfirm} onSkip={handleDialogSkip}
      />

      {/* Magic fill group name dialog — reuses same component, different state */}
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
'use client';

// ─── components/Viewer/ViewerCanvas.tsx ───────────────────────────────────────
//
//  CHANGE vs previous:
//
//  Pin canvas (layer 50) — removed `w-full h-full` Tailwind classes and the
//  inline width/height CSS. The canvas pixel dimensions are now set explicitly
//  by Viewer.tsx via useLayoutEffect (canvas.width = dims.w / canvas.height =
//  dims.h). Keeping CSS `width: 100%; height: 100%` alongside an explicit
//  canvas.width causes the browser to stretch the pixel buffer, which makes
//  snap dots draw in the wrong place. Instead we let the canvas render at its
//  natural pixel size (matching pdfDimensions) and position it absolutely
//  over the PDF. The `pointer-events-none` and z-index are unchanged.
//
//  All other logic (finish buttons, arc/radius helpers, pointer leave handler,
//  onDrawingCanvasPointerLeave prop) is identical to the previous version.
//
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';
import { FolderOpen, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToolType, TakeoffRow } from '@/types';
import type { PdfDimensions } from '@/types/viewerTypes';
import type { InProgressPoint } from '@/context/TakeoffContext';
import { CountPinOverlay } from '@/components/features/overlays/CountPinOverlay';
import { GridCountOverlay } from './GridCountOverlay';

import {
  splitArcPoints, isArcSentinel,
  splitRadiusPoints,
} from '@/hooks/measurements/useMeasurements/useMeasurementCommit';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SnapFlash { id: string; x: number; y: number; }

interface ViewerCanvasProps {
  pdfCanvasRef:     React.RefObject<HTMLCanvasElement | null>;
  drawingCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  pinCanvasRef:     React.RefObject<HTMLCanvasElement | null>;
  vectorCanvasRef:  React.RefObject<HTMLCanvasElement | null>;
  fillCanvasRef:    React.RefObject<HTMLCanvasElement | null>;

  pdf:             any;
  loading:         boolean;
  pdfDimensions:   PdfDimensions | null;
  activeTool:      ToolType;
  showPins:        boolean;
  isPanning:       boolean;
  spaceHeld:       boolean;
  tempPoints:      InProgressPoint[];
  measurements:    TakeoffRow[];
  activeDrawingId: string | null;
  snapFlashes:     SnapFlash[];

  readyToDraw?: boolean;

  stagedArcCount: number;

  toCanvas: (x: number, y: number) => { x: number; y: number };

  handleCanvasClick:              (e: React.MouseEvent<HTMLCanvasElement>)   => void;
  handleContextMenu:              (e: React.MouseEvent<HTMLCanvasElement>)   => void;
  handleCanvasPointerMove:        (e: React.PointerEvent<HTMLCanvasElement>) => void;
  handleCanvasPointerDown:        (e: React.PointerEvent<HTMLCanvasElement>) => boolean | undefined;
  handleCanvasPointerUp:          (e: React.PointerEvent<HTMLCanvasElement>) => void;
  handleDrawingCanvasPointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  setCursorPoint:                 (p: any) => void;
  cursorPointRef:                 React.RefObject<any>;
  redrawPinCanvas:                () => void;

  onDrawingCanvasPointerLeave?:   () => void;

  handleFinishMeasurement: () => void;
  handleFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;

  containerRef:   React.RefObject<HTMLDivElement | null>;
  CANVAS_PADDING: number;

  isGridCountActive: boolean;
  scaleFactor:       number;
  onGridCountCommit: (count: number, spacingMm: number, cols: number, rows: number) => void;

  children?: React.ReactNode;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pdfPtToWrapPx(pt: InProgressPoint): { x: number; y: number } {
  return { x: pt.x, y: pt.y };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ViewerCanvas({
  pdfCanvasRef, drawingCanvasRef, pinCanvasRef,
  vectorCanvasRef, fillCanvasRef,
  pdf, loading, pdfDimensions,
  activeTool, showPins, isPanning, spaceHeld,
  tempPoints, measurements, activeDrawingId,
  snapFlashes, toCanvas,
  readyToDraw = true,
  stagedArcCount,
  handleCanvasClick, handleContextMenu,
  handleCanvasPointerMove, handleCanvasPointerDown,
  handleCanvasPointerUp, handleDrawingCanvasPointerDown,
  setCursorPoint, cursorPointRef, redrawPinCanvas,
  onDrawingCanvasPointerLeave,
  handleFinishMeasurement, handleFileUpload,
  containerRef, CANVAS_PADDING,
  isGridCountActive,
  scaleFactor,
  onGridCountCommit,
  children,
}: ViewerCanvasProps) {

  // ── Cursor class ──────────────────────────────────────────────────────────
  const drawingCanvasCursor = spaceHeld
    ? isPanning ? 'cursor-grabbing' : 'cursor-grab'
    : activeTool !== 'select' && !isPanning
    ? 'cursor-crosshair'
    : isPanning ? 'cursor-grabbing' : 'cursor-grab';

  // ── Canvas wrap positioning ───────────────────────────────────────────────
  const canvasWrapStyle: React.CSSProperties | undefined = pdfDimensions
    ? (() => {
        const vw    = containerRef.current?.clientWidth  ?? 0;
        const vh    = containerRef.current?.clientHeight ?? 0;
        const wrapW = Math.max(pdfDimensions.w + CANVAS_PADDING * 2, vw  * 3);
        const wrapH = Math.max(pdfDimensions.h + CANVAS_PADDING * 2, vh * 3);
        return {
          position: 'absolute' as const,
          left:  Math.round((wrapW - pdfDimensions.w) / 2),
          top:   Math.round((wrapH - pdfDimensions.h) / 2),
          width:  pdfDimensions.w,
          height: pdfDimensions.h,
        };
      })()
    : undefined;

  // ── Arc/radius point helpers ──────────────────────────────────────────────
  const lastNonSentinelPoint = [...tempPoints]
    .reverse()
    .find(p => p.segmentId !== '__arc_break__' && p.segmentId !== '__radius_break__');

  const inProgressArcPts = (() => {
    const pts: InProgressPoint[] = [];
    for (let i = tempPoints.length - 1; i >= 0; i--) {
      if (tempPoints[i].segmentId === '__arc_break__') break;
      pts.unshift(tempPoints[i]);
    }
    return pts;
  })();

  // ── Finish button position helpers ────────────────────────────────────────
  const lastPt = tempPoints.length > 0
    ? pdfPtToWrapPx(tempPoints[tempPoints.length - 1])
    : null;

  const arcBtnPos = lastNonSentinelPoint
    ? pdfPtToWrapPx(lastNonSentinelPoint)
    : lastPt;

  // ── Pointer leave handler ─────────────────────────────────────────────────
  const handlePointerLeave = onDrawingCanvasPointerLeave ?? (() => {
    setCursorPoint(null);
    cursorPointRef.current = null;
    redrawPinCanvas();
  });

  // ── Pin canvas visibility ─────────────────────────────────────────────────
  // showPins hides the canvas via opacity so it doesn't intercept any events
  // (pointer-events-none is always set). The canvas pixel dimensions are
  // managed externally by Viewer.tsx useLayoutEffect — do not set w-full /
  // h-full here as that creates a CSS-vs-pixel size mismatch.
  const pinCanvasVisible = showPins && readyToDraw;

  return (
    <>
      {/* ── Empty state ── */}
      {!pdf && !loading && (
        <div className="flex flex-col items-center gap-6 p-12 border-2 border-dashed border-industrial-border bg-industrial-panel/50 backdrop-blur-sm max-w-xl w-full text-center">
          <FolderOpen className="w-12 h-12 text-zinc-700" />
          <div>
            <h2 className="text-xl font-mono font-bold tracking-tighter text-zinc-200 mb-2">
              IMPORT PROJECT DRAWING
            </h2>
            <p className="text-xs text-zinc-500 font-mono leading-relaxed uppercase tracking-widest">
              DRAG AND DROP OR SELECT A PDF, DWG, OR IMAGE FILE TO BEGIN MEASURING QUANTITIES.
            </p>
          </div>
          <label className="bg-amber-400 hover:bg-amber-300 text-black px-10 py-3 font-mono font-bold text-xs uppercase tracking-widest cursor-pointer transition-all shadow-xl shadow-amber-400/10 active:scale-95">
            Select File(s)
            <input
              type="file" multiple className="hidden"
              accept=".pdf,.png,.jpg,.jpeg,.dwg"
              onChange={handleFileUpload}
            />
          </label>
        </div>
      )}

      {/* ── Loading ── */}
      {loading && (
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-zinc-800 border-t-amber-400 rounded-full animate-spin" />
          <span className="text-[10px] font-mono font-bold text-amber-400 tracking-[0.2em] uppercase animate-pulse">
            Processing Vector Data...
          </span>
        </div>
      )}

      {/* ── Canvas stack ── */}
      {pdf && (
        <div
          className="relative shadow-2xl border border-industrial-border bg-white"
          style={canvasWrapStyle}
        >
          {/* Layer 0: PDF raster */}
          <canvas ref={pdfCanvasRef} className="absolute inset-0 z-0 pointer-events-none" />

          {/* Layer 10: Vector overlay */}
          <canvas
            ref={vectorCanvasRef}
            className="absolute inset-0 z-10 pointer-events-none"
          />

          {/* Layer 39: Magic Fill paint canvas */}
          <canvas
            ref={fillCanvasRef}
            className="absolute inset-0 z-[39] pointer-events-none"
            style={{ width: pdfDimensions?.w, height: pdfDimensions?.h }}
          />

          {/* Layer 40: Drawing canvas */}
          <canvas
            ref={drawingCanvasRef}
            onClick={handleCanvasClick}
            onContextMenu={handleContextMenu}
            onPointerMove={handleCanvasPointerMove}
            onPointerDown={(e) => {
              const handled = handleCanvasPointerDown(e) ?? false;
              if (!handled) handleDrawingCanvasPointerDown(e);
            }}
            onPointerUp={handleCanvasPointerUp}
            onPointerLeave={handlePointerLeave}
            className={cn(
              'absolute inset-0 z-40 w-full h-full mix-blend-multiply',
              drawingCanvasCursor,
            )}
            style={{
              opacity:       readyToDraw ? 1 : 0,
              transition:    readyToDraw ? 'opacity 0.15s' : 'none',
              pointerEvents: isGridCountActive ? 'none' : undefined,
            }}
          />

          {/* Layer 50: Snap pin canvas
              NOTE: No w-full/h-full here. The canvas.width/height pixel
              dimensions are set by Viewer.tsx useLayoutEffect to match
              pdfDimensions exactly. CSS width/height are left at their
              natural size (= pixel dimensions) so there is no stretch.
              position:absolute + inset-0 keeps it aligned with the PDF. */}
          <canvas
            ref={pinCanvasRef}
            className="absolute inset-0 z-50 pointer-events-none"
            style={{
              opacity:    pinCanvasVisible ? 1 : 0,
              transition: 'opacity 0.2s',
              // width/height intentionally omitted — driven by canvas.width/height
              // set in Viewer.tsx. Do not add w-full/h-full or explicit px sizes.
            }}
          />

          {/* Layer 55: Grid-count overlay */}
          <GridCountOverlay
            active={isGridCountActive}
            pdfDimensions={pdfDimensions}
            scaleFactor={scaleFactor}
            onCommit={onGridCountCommit}
          />

          {/* Layer 60: Count pin overlay */}
          <div
            className="absolute inset-0 z-[60] pointer-events-none"
            style={{ opacity: readyToDraw ? 1 : 0, transition: readyToDraw ? 'opacity 0.15s' : 'none' }}
          >
            <CountPinOverlay
              measurements={measurements}
              pdfDimensions={pdfDimensions}
              toCanvas={toCanvas}
              activeDrawingId={activeDrawingId}
              activeTool={activeTool}
            />
          </div>

          {/* Layer 65: Snap flashes */}
          {readyToDraw && snapFlashes.map(flash => (
            <div
              key={flash.id}
              className="absolute pointer-events-none z-[65]"
              style={{ left: flash.x, top: flash.y, transform: 'translate(-50%,-50%)' }}
            >
              <div
                className="w-8 h-8 rounded-full border-2 border-green-400"
                style={{ animation: 'snapPulse 0.6s ease-out forwards' }}
              />
            </div>
          ))}

          {/* Layer 70: Finish button — Count */}
          {readyToDraw &&
            activeTool === 'count' &&
            tempPoints.length > 0 &&
            lastPt && (
              <button
                className="absolute z-[70] flex items-center justify-center gap-1.5 bg-amber-400 text-black font-bold font-mono text-[10px] uppercase tracking-widest px-3 py-1.5 shadow-lg whitespace-nowrap hover:bg-amber-300 active:scale-95 transition-transform"
                style={{ left: lastPt.x + 15, top: lastPt.y + 15 }}
                onClick={e => { e.stopPropagation(); handleFinishMeasurement(); }}
                onPointerDown={e => e.stopPropagation()}
              >
                <Check className="w-3 h-3" />
                Finish ({tempPoints.length} counts)
              </button>
            )}

          {/* Layer 70: Finish button — Polygon / Rectangle / Linear */}
          {readyToDraw &&
            (activeTool === 'polygon' || activeTool === 'rectangle' || activeTool === 'linear') &&
            tempPoints.length > 1 &&
            lastPt && (
              <button
                className="absolute z-[70] flex items-center justify-center gap-1.5 bg-amber-400 text-black font-bold font-mono text-[10px] uppercase tracking-widest px-3 py-1.5 shadow-lg whitespace-nowrap hover:bg-amber-300 active:scale-95 transition-transform"
                style={{ left: lastPt.x + 15, top: lastPt.y + 15 }}
                onClick={e => { e.stopPropagation(); handleFinishMeasurement(); }}
                onPointerDown={e => e.stopPropagation()}
              >
                <Check className="w-3 h-3" />
                Finish ({tempPoints.filter(p => p.snapped).length}/{tempPoints.length} snapped)
              </button>
            )}

          {/* Layer 70: Arc tool UI */}
          {readyToDraw && activeTool === 'arc' && (() => {
            if (stagedArcCount > 0 && arcBtnPos) {
              return (
                <button
                  className="absolute z-[70] flex items-center justify-center gap-1.5 bg-teal-500 text-black font-bold font-mono text-[10px] uppercase tracking-widest px-3 py-1.5 shadow-lg whitespace-nowrap hover:bg-teal-400 active:scale-95 transition-transform"
                  style={{ left: arcBtnPos.x + 15, top: arcBtnPos.y + 15 }}
                  onClick={e => { e.stopPropagation(); handleFinishMeasurement(); }}
                  onPointerDown={e => e.stopPropagation()}
                >
                  <Check className="w-3 h-3" />
                  Finish ({stagedArcCount} arc{stagedArcCount !== 1 ? 's' : ''})
                  {inProgressArcPts.length > 0 && (
                    <span className="ml-1 opacity-70">
                      +{inProgressArcPts.length}pt
                    </span>
                  )}
                </button>
              );
            }

            if (inProgressArcPts.length === 2 && arcBtnPos) {
              return (
                <div
                  className="absolute z-[70] bg-teal-900/80 border border-teal-500/50 px-3 py-1.5 font-mono text-[9px] text-teal-300 uppercase tracking-widest pointer-events-none whitespace-nowrap"
                  style={{ left: arcBtnPos.x + 15, top: arcBtnPos.y + 15 }}
                >
                  Click end point · right-click to cancel arc
                </div>
              );
            }

            return null;
          })()}

          {/* Layer 70: Finish button — Radius */}
          {readyToDraw && activeTool === 'radius' && (() => {
            const staged = splitRadiusPoints(tempPoints).filter(g => g.length === 2);
            if (staged.length === 0 || !lastNonSentinelPoint) return null;
            const lastEdge = pdfPtToWrapPx(staged[staged.length - 1][1]);
            return (
              <button
                className="absolute z-[70] flex items-center justify-center gap-1.5 bg-purple-500 text-white font-bold font-mono text-[10px] uppercase tracking-widest px-3 py-1.5 shadow-lg whitespace-nowrap hover:bg-purple-400 active:scale-95 transition-transform"
                style={{ left: lastEdge.x + 15, top: lastEdge.y + 15 }}
                onClick={e => { e.stopPropagation(); handleFinishMeasurement(); }}
                onPointerDown={e => e.stopPropagation()}
              >
                <Check className="w-3 h-3" />
                Finish ({staged.length} circle{staged.length !== 1 ? 's' : ''})
              </button>
            );
          })()}

          {/* Slot for MagicFillCanvas layers and overlays */}
          {children}
        </div>
      )}
    </>
  );
}

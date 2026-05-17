'use client';

// ─── components/Viewer/ViewerCanvas.tsx ───────────────────────────────────────

import React from 'react';
import { FolderOpen, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToolType, TakeoffRow } from '@/types';
import type { PdfDimensions } from '@/types/viewerTypes';
import type { InProgressPoint } from '@/context/TakeoffContext';
import { CountPinOverlay } from '../CountPinOverlay';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SnapFlash { id: string; x: number; y: number; }

interface ViewerCanvasProps {
  pdfCanvasRef:     React.RefObject<HTMLCanvasElement | null>;
  drawingCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  pinCanvasRef:     React.RefObject<HTMLCanvasElement | null>;
  vectorCanvasRef:  React.RefObject<HTMLCanvasElement | null>;
  /** Canvas that receives magic-fill paint output */
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

  handleFinishMeasurement: () => void;
  handleFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;

  containerRef:   React.RefObject<HTMLDivElement | null>;
  CANVAS_PADDING: number;

  /** Children inserted into the canvas stack (e.g. MagicFillCanvas layers) */
  children?: React.ReactNode;
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
  handleCanvasClick, handleContextMenu,
  handleCanvasPointerMove, handleCanvasPointerDown,
  handleCanvasPointerUp, handleDrawingCanvasPointerDown,
  setCursorPoint, cursorPointRef, redrawPinCanvas,
  handleFinishMeasurement, handleFileUpload,
  containerRef, CANVAS_PADDING,
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
        const vw   = containerRef.current?.clientWidth  ?? 0;
        const vh   = containerRef.current?.clientHeight ?? 0;
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
            style={{
              width:  pdfDimensions?.w,
              height: pdfDimensions?.h,
            }}
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
            onPointerLeave={() => {
              setCursorPoint(null);
              cursorPointRef.current = null;
              redrawPinCanvas();
            }}
            className={cn(
              'absolute inset-0 z-40 w-full h-full mix-blend-multiply',
              drawingCanvasCursor,
            )}
            style={{
              opacity:    readyToDraw ? 1 : 0,
              transition: readyToDraw ? 'opacity 0.15s' : 'none',
            }}
          />

          {/* Layer 50: Snap pin canvas */}
          <canvas
            ref={pinCanvasRef}
            className="absolute inset-0 z-50 w-full h-full pointer-events-none"
            style={{
              opacity: showPins && activeTool !== 'select' && readyToDraw ? 1 : 0,
              transition: 'opacity 0.2s',
            }}
          />

          {/* Layer 6: Count pin overlay */}
          <div
            style={{
              opacity:    readyToDraw ? 1 : 0,
              transition: readyToDraw ? 'opacity 0.15s' : 'none',
            }}
          >
            <CountPinOverlay
              measurements={measurements}
              pdfDimensions={pdfDimensions}
              toCanvas={toCanvas}
              activeDrawingId={activeDrawingId}
              activeTool={activeTool}
            />
          </div>

          {/* Layer 7: Snap flashes */}
          {readyToDraw && snapFlashes.map(flash => (
            <div
              key={flash.id}
              className="absolute pointer-events-none z-[60]"
              style={{ left: flash.x, top: flash.y, transform: 'translate(-50%,-50%)' }}
            >
              <div
                className="w-8 h-8 rounded-full border-2 border-green-400"
                style={{ animation: 'snapPulse 0.6s ease-out forwards' }}
              />
            </div>
          ))}

          {/* Layer 8: Finish button — Count */}
          {readyToDraw && tempPoints.length > 0 && activeTool === 'count' && (() => {
            const last = toCanvas(
              tempPoints[tempPoints.length - 1].x,
              tempPoints[tempPoints.length - 1].y,
            );
            return (
              <button
                className="absolute z-[70] flex items-center justify-center gap-1.5 bg-amber-400 text-black font-bold font-mono text-[10px] uppercase tracking-widest px-3 py-1.5 shadow-lg whitespace-nowrap hover:bg-amber-300 active:scale-95 transition-transform"
                style={{ left: last.x + 15, top: last.y + 15 }}
                onClick={e => { e.stopPropagation(); handleFinishMeasurement(); }}
                onPointerDown={e => e.stopPropagation()}
              >
                <Check className="w-3 h-3" />
                Finish ({tempPoints.length} counts)
              </button>
            );
          })()}

          {/* Layer 8: Finish button — Polygon / Rectangle / Linear */}
          {readyToDraw &&
            tempPoints.length > 1 &&
            (activeTool === 'polygon' || activeTool === 'rectangle' || activeTool === 'linear') &&
            (() => {
              const last = toCanvas(
                tempPoints[tempPoints.length - 1].x,
                tempPoints[tempPoints.length - 1].y,
              );
              return (
                <button
                  className="absolute z-[70] flex items-center justify-center gap-1.5 bg-amber-400 text-black font-bold font-mono text-[10px] uppercase tracking-widest px-3 py-1.5 shadow-lg whitespace-nowrap hover:bg-amber-300 active:scale-95 transition-transform"
                  style={{ left: last.x + 15, top: last.y + 15 }}
                  onClick={e => { e.stopPropagation(); handleFinishMeasurement(); }}
                  onPointerDown={e => e.stopPropagation()}
                >
                  <Check className="w-3 h-3" />
                  Finish ({tempPoints.filter(p => p.snapped).length}/{tempPoints.length} snapped)
                </button>
              );
            })()}

          {/* Slot for MagicFillCanvas layers (42 + 45) and overlays */}
          {children}
        </div>
      )}
    </>
  );
}
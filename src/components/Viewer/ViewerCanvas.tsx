'use client';

// ─── ViewerCanvas.tsx ─────────────────────────────────────────────────────────
import React from 'react';
import { FolderOpen, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToolType, TakeoffRow } from '@/types';
import type { PdfDimensions } from '@/types/viewerTypes';
import type { InProgressPoint } from '@/context/TakeoffContext';
import type { DetectedRoom } from '@/hooks/useSnapEngine/detectRooms';
import { CountPinOverlay } from '../CountPinOverlay';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Ray-casting point-in-polygon test (normalised or canvas coords, consistent) */
function pointInPolygon(
  x: number, y: number,
  poly: Array<{ x: number; y: number }>,
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface SnapFlash {
  id: string;
  x: number;
  y: number;
}

interface ViewerCanvasProps {
  // Refs
  pdfCanvasRef:     React.RefObject<HTMLCanvasElement | null>;
  drawingCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  pinCanvasRef:     React.RefObject<HTMLCanvasElement | null>;
  roomCanvasRef:    React.RefObject<HTMLCanvasElement | null>;

  // State
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

  // Room detection
  showRooms:       boolean;
  rooms:           DetectedRoom[];
  hoveredRoomId:   string | null;
  setHoveredRoomId:(id: string | null) => void;
  onRoomClick:     (room: DetectedRoom) => void;

  // Geometry helper
  toCanvas: (x: number, y: number) => { x: number; y: number };

  // Canvas event handlers
  handleCanvasClick:              (e: React.MouseEvent<HTMLCanvasElement>)   => void;
  handleContextMenu:              (e: React.MouseEvent<HTMLCanvasElement>)   => void;
  handleCanvasPointerMove:        (e: React.PointerEvent<HTMLCanvasElement>) => void;
  handleCanvasPointerDown:        (e: React.PointerEvent<HTMLCanvasElement>) => boolean | undefined;
  handleCanvasPointerUp:          (e: React.PointerEvent<HTMLCanvasElement>) => void;
  handleDrawingCanvasPointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  setCursorPoint:                 (p: any) => void;
  cursorPointRef:                 React.RefObject<any>;
  redrawPinCanvas:                () => void;

  // Finish action
  handleFinishMeasurement: () => void;

  // File upload
  handleFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;

  // Layout
  containerRef:   React.RefObject<HTMLDivElement | null>;
  CANVAS_PADDING: number;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ViewerCanvas({
  pdfCanvasRef, drawingCanvasRef, pinCanvasRef, roomCanvasRef,
  pdf, loading, pdfDimensions,
  activeTool, showPins, isPanning, spaceHeld,
  tempPoints, measurements, activeDrawingId,
  snapFlashes, toCanvas,
  showRooms, rooms, hoveredRoomId, setHoveredRoomId, onRoomClick,
  handleCanvasClick, handleContextMenu,
  handleCanvasPointerMove, handleCanvasPointerDown,
  handleCanvasPointerUp, handleDrawingCanvasPointerDown,
  setCursorPoint, cursorPointRef, redrawPinCanvas,
  handleFinishMeasurement,
  handleFileUpload,
  containerRef, CANVAS_PADDING,
}: ViewerCanvasProps) {

  const drawingCanvasCursor = spaceHeld
    ? isPanning ? 'cursor-grabbing' : 'cursor-grab'
    : activeTool !== 'select' && !isPanning
    ? 'cursor-crosshair'
    : isPanning
    ? 'cursor-grabbing'
    : 'cursor-grab';

  // Room canvas pointer move — hit-test rooms and update hover state
  const handleRoomPointerMove = React.useCallback((
    e: React.PointerEvent<HTMLCanvasElement>,
  ) => {
    if (!showRooms || !pdfDimensions || !rooms.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mx   = e.clientX - rect.left;
    const my   = e.clientY - rect.top;

    const hit = rooms.find(r => {
      const pts = r.polygon.map(p => ({
        x: p.nx * pdfDimensions.w,
        y: p.ny * pdfDimensions.h,
      }));
      return pointInPolygon(mx, my, pts);
    });
    setHoveredRoomId(hit?.id ?? null);
  }, [showRooms, pdfDimensions, rooms, setHoveredRoomId]);

  const handleRoomClick = React.useCallback((
    e: React.MouseEvent<HTMLCanvasElement>,
  ) => {
    if (!showRooms || !hoveredRoomId) return;
    const room = rooms.find(r => r.id === hoveredRoomId);
    if (room) { e.stopPropagation(); onRoomClick(room); }
  }, [showRooms, hoveredRoomId, rooms, onRoomClick]);

  return (
    <>
      {/* ── Empty state: file upload ── */}
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
              type="file"
              multiple
              className="hidden"
              accept=".pdf,.png,.jpg,.jpeg,.dwg"
              onChange={handleFileUpload}
            />
          </label>
        </div>
      )}

      {/* ── Loading spinner ── */}
      {loading && (
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-zinc-800 border-t-amber-400 rounded-full animate-spin" />
          <span className="text-[10px] font-mono font-bold text-amber-400 tracking-[0.2em] uppercase animate-pulse">
            Processing Vector Data...
          </span>
        </div>
      )}

      {/* ── Canvas stack (only when PDF loaded) ── */}
      {/* FIX: We render the wrapper as long as `pdf` exists. Dimensions fall back safely. */}
      {pdf && (
        <div
          className="relative shadow-2xl border border-industrial-border bg-white"
          style={pdfDimensions ? (() => {
            const vw = containerRef.current?.clientWidth ?? 0;
            const vh = containerRef.current?.clientHeight ?? 0;
            const wrapW = Math.max(pdfDimensions.w + CANVAS_PADDING * 2, vw * 3);
            const wrapH = Math.max(pdfDimensions.h + CANVAS_PADDING * 2, vh * 3);
            const left = Math.round((wrapW - pdfDimensions.w) / 2);
            const top  = Math.round((wrapH - pdfDimensions.h) / 2);
            return {
              position: 'absolute' as const,
              left, top,
              width:  pdfDimensions.w,
              height: pdfDimensions.h,
            };
          })() : {}}
        >
          {/* ── Layer 0: PDF raster ────────────────────────────────────────── */}
          <canvas
            ref={pdfCanvasRef}
            className="absolute inset-0 z-0 pointer-events-none"
          />

          {/* ── Layer 1: Room detection overlay ───────────────────────────── */}
          {/* FIXED: Removed w-full h-full classes to allow proper sizing from inline styles */}
          <canvas
            ref={roomCanvasRef}
            className="absolute inset-0 z-15"
            style={{
              opacity:       showRooms ? 1 : 0,
              transition:    'opacity 0.2s',
              pointerEvents: showRooms ? 'auto' : 'none',
              cursor:        showRooms && hoveredRoomId ? 'pointer' : 'default',
            }}
            onPointerMove={handleRoomPointerMove}
            onPointerLeave={() => setHoveredRoomId(null)}
            onClick={handleRoomClick}
          />

          {/* ── Layer 2: Drawing / measurement canvas ─────────────────────── */}
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
              'absolute inset-0 z-10 w-full h-full mix-blend-multiply',
              drawingCanvasCursor,
            )}
          />

          {/* ── Layer 3: Snap pin canvas ───────────────────────────────────── */}
          <canvas
            ref={pinCanvasRef}
            className="absolute inset-0 z-20 w-full h-full pointer-events-none"
            style={{
              opacity:    showPins && activeTool !== 'select' ? 1 : 0,
              transition: 'opacity 0.2s',
            }}
          />

          {/* ── Layer 4: Count pin overlay (DOM) ──────────────────────────── */}
          <CountPinOverlay
            measurements={measurements}
            pdfDimensions={pdfDimensions}
            toCanvas={toCanvas}
            activeDrawingId={activeDrawingId}
            activeTool={activeTool}
          />

          {/* ── Layer 5: Snap flash animations ────────────────────────────── */}
          {snapFlashes.map(flash => (
            <div
              key={flash.id}
              className="absolute pointer-events-none z-30"
              style={{ left: flash.x, top: flash.y, transform: 'translate(-50%,-50%)' }}
            >
              <div
                className="w-8 h-8 rounded-full border-2 border-green-400"
                style={{ animation: 'snapPulse 0.6s ease-out forwards' }}
              />
            </div>
          ))}

          {/* ── Layer 6: Finish button — Count tool ───────────────────────── */}
          {tempPoints.length > 0 && activeTool === 'count' && (() => {
            const last = toCanvas(
              tempPoints[tempPoints.length - 1].x,
              tempPoints[tempPoints.length - 1].y,
            );
            return (
              <button
                className="absolute z-30 flex items-center justify-center gap-1.5 bg-amber-400 text-black font-bold font-mono text-[10px] uppercase tracking-widest px-3 py-1.5 shadow-lg whitespace-nowrap hover:bg-amber-300 active:scale-95 transition-transform"
                style={{ left: last.x + 15, top: last.y + 15 }}
                onClick={e => { e.stopPropagation(); handleFinishMeasurement(); }}
                onPointerDown={e => e.stopPropagation()}
              >
                <Check className="w-3 h-3" />
                Finish ({tempPoints.length} counts)
              </button>
            );
          })()}

          {/* ── Layer 6: Finish button — Polygon / Rectangle / Linear ─────── */}
          {tempPoints.length > 1 &&
            (activeTool === 'polygon' || activeTool === 'rectangle' || activeTool === 'linear') &&
            (() => {
              const last = toCanvas(
                tempPoints[tempPoints.length - 1].x,
                tempPoints[tempPoints.length - 1].y,
              );
              return (
                <button
                  className="absolute z-30 flex items-center justify-center gap-1.5 bg-amber-400 text-black font-bold font-mono text-[10px] uppercase tracking-widest px-3 py-1.5 shadow-lg whitespace-nowrap hover:bg-amber-300 active:scale-95 transition-transform"
                  style={{ left: last.x + 15, top: last.y + 15 }}
                  onClick={e => { e.stopPropagation(); handleFinishMeasurement(); }}
                  onPointerDown={e => e.stopPropagation()}
                >
                  <Check className="w-3 h-3" />
                  Finish ({tempPoints.filter(p => p.snapped).length}/{tempPoints.length} snapped)
                </button>
              );
            })()}
        </div>
      )}
    </>
  );
}
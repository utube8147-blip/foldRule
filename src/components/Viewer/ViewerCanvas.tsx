'use client';

// ─── ViewerCanvas.tsx ─────────────────────────────────────────────────────────
//
// CHANGES:
//   • selectedClusterId state (useState) — tracks which cluster is selected
//   • drawClusterCanvas now receives selectedClusterId
//   • clusterCanvasRef onClick handler — hit-tests clusters, toggles selection
//   • Escape key clears selection
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';
import { FolderOpen, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToolType, TakeoffRow } from '@/types';
import type { PdfDimensions } from '@/types/viewerTypes';
import type { InProgressPoint } from '@/context/TakeoffContext';
import type { DetectedRoom } from '@/hooks/useSnapEngine/detectRooms';
import { CountPinOverlay } from '../CountPinOverlay';
import { SVG_SNAP_COLOURS } from '@/hooks/useSvgSnapPoints';
import type { SvgSnapPoint } from '@/hooks/useSvgSnapPoints';
import type { SvgArea } from '@/hooks/useSvgInteraction';

import { drawSvgAreaCanvas }              from '@/hooks/drawSvgAreaCanvas';
import { drawClusterCanvas, hitTestClusters } from '@/hooks/drawClusterCanvas';
import { getRoomCategory, CATEGORY_COLORS }   from '@/lib/svgLabelUtils';
import type { ShapeCluster }              from '@/hooks/useShapeCluster';

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

interface SnapFlash { id: string; x: number; y: number; }

interface ViewerCanvasProps {
  pdfCanvasRef:      React.RefObject<HTMLCanvasElement | null>;
  drawingCanvasRef:  React.RefObject<HTMLCanvasElement | null>;
  pinCanvasRef:      React.RefObject<HTMLCanvasElement | null>;
  roomCanvasRef:     React.RefObject<HTMLCanvasElement | null>;
  wallCanvasRef:     React.RefObject<HTMLCanvasElement | null>;
  vectorCanvasRef:   React.RefObject<HTMLCanvasElement | null>;
  svgAreaCanvasRef:  React.RefObject<HTMLCanvasElement | null>;
  roomLabelCanvasRef?: React.RefObject<HTMLCanvasElement | null>;

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

  showVectors:      boolean;
  vectorPathCount:  number;
  showWalls:        boolean;
  wallSegmentCount: number;

  showRooms:       boolean;
  rooms:           DetectedRoom[];
  hoveredRoomId:   string | null;
  setHoveredRoomId:(id: string | null) => void;
  onRoomClick:     (room: DetectedRoom) => void;

  svgContent?:       string | null;
  showSvgOverlay?:   boolean;
  svgAreas?:         SvgArea[];
  svgSnapPoints?:    SvgSnapPoint[];
  showSvgSnapDebug?: boolean;

  clusters?:     ShapeCluster[];
  showClusters?: boolean;

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
}

// ─── SVG snap debug overlay ───────────────────────────────────────────────────

function drawSvgSnapDebugCanvas(
  canvas: HTMLCanvasElement,
  points: SvgSnapPoint[],
  pdfDimensions: PdfDimensions,
) {
  const { w, h } = pdfDimensions;
  canvas.width = w; canvas.height = h;
  canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);

  for (const pt of points) {
    const px = pt.nx * w, py = pt.ny * h;
    const colour = SVG_SNAP_COLOURS[pt.type] ?? 'rgba(255,255,255,0.7)';
    if (pt.type === 'arc-center') {
      const R = 7;
      ctx.save();
      ctx.strokeStyle = colour; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(px, py, R, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(px - R - 4, py); ctx.lineTo(px + R + 4, py); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(px, py - R - 4); ctx.lineTo(px, py + R + 4); ctx.stroke();
      ctx.beginPath(); ctx.arc(px, py, 2, 0, Math.PI * 2); ctx.fillStyle = colour; ctx.fill();
      ctx.restore();
    } else {
      ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.strokeStyle = colour; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.beginPath(); ctx.arc(px, py, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = colour; ctx.fill();
    }
  }
}

// ─── Room labels canvas ───────────────────────────────────────────────────────

function drawRoomLabelsCanvas(
  canvas: HTMLCanvasElement,
  rooms: DetectedRoom[],
  pdfDimensions: PdfDimensions,
  showRooms: boolean,
) {
  const { w, h } = pdfDimensions;
  canvas.width = w; canvas.height = h;
  canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  if (!showRooms || rooms.length === 0) return;

  for (const room of rooms) {
    let cx = 0, cy = 0;
    for (const p of room.polygon) { cx += p.nx * w; cy += p.ny * h; }
    cx /= room.polygon.length; cy /= room.polygon.length;

    const label  = room.label || 'ROOM';
    const colors = CATEGORY_COLORS[getRoomCategory(label)] ?? CATEGORY_COLORS.default;

    ctx.font = 'bold 11px ui-monospace,SFMono-Regular,Menlo,monospace';
    const tw = ctx.measureText(label).width;
    const pillW = tw + 16, pillH = 20;

    ctx.shadowBlur = 6; ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.fillStyle = colors.pill;
    ctx.beginPath();
    (ctx as any).roundRect?.(cx - pillW / 2, cy - pillH / 2, pillW, pillH, 5);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle    = '#ffffff';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, cy);
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ViewerCanvas({
  pdfCanvasRef, drawingCanvasRef, pinCanvasRef, roomCanvasRef,
  wallCanvasRef, vectorCanvasRef, svgAreaCanvasRef,
  roomLabelCanvasRef,
  pdf, loading, pdfDimensions,
  activeTool, showPins, isPanning, spaceHeld,
  tempPoints, measurements, activeDrawingId,
  snapFlashes, toCanvas,
  showVectors, vectorPathCount,
  showWalls, wallSegmentCount,
  showRooms, rooms, hoveredRoomId, setHoveredRoomId, onRoomClick,
  svgContent       = null,
  showSvgOverlay   = true,
  svgAreas         = [],
  svgSnapPoints    = [],
  showSvgSnapDebug = false,
  clusters         = [],
  showClusters     = true,
  handleCanvasClick, handleContextMenu,
  handleCanvasPointerMove, handleCanvasPointerDown,
  handleCanvasPointerUp, handleDrawingCanvasPointerDown,
  setCursorPoint, cursorPointRef, redrawPinCanvas,
  handleFinishMeasurement,
  handleFileUpload,
  containerRef, CANVAS_PADDING,
}: ViewerCanvasProps) {

  const svgCanvasRef      = React.useRef<HTMLCanvasElement | null>(null);
  const svgDebugCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const clusterCanvasRef  = React.useRef<HTMLCanvasElement | null>(null);

  // ── Cluster selection state ───────────────────────────────────────────────
  const [selectedClusterId, setSelectedClusterId] = React.useState<string | null>(null);

  // Clear selection on Escape
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedClusterId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── Cluster canvas click — hit test + toggle selection ────────────────────
  const handleClusterCanvasClick = React.useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!pdfDimensions || clusters.length === 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const nx   = (e.clientX - rect.left)  / pdfDimensions.w;
      const ny   = (e.clientY - rect.top)   / pdfDimensions.h;
      const hit  = hitTestClusters(nx, ny, clusters);
      // Toggle: clicking the same cluster deselects; clicking another selects it
      setSelectedClusterId(prev => prev === hit ? null : hit);
      // If we hit something, stop it reaching the drawing canvas
      if (hit) e.stopPropagation();
    },
    [pdfDimensions, clusters],
  );

  // ── SVG raster overlay ────────────────────────────────────────────────────
  React.useEffect(() => {
    const canvas = svgCanvasRef.current;
    if (!canvas) return;
    if (!svgContent || !pdfDimensions || !showSvgOverlay) {
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const { w, h } = pdfDimensions;
    canvas.width = w; canvas.height = h;
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    const blob = new Blob([svgContent], { type: 'image/svg+xml;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const img  = new Image();
    img.onload  = () => { ctx.drawImage(img, 0, 0, w, h); URL.revokeObjectURL(url); };
    img.onerror = () => { console.error('[ViewerCanvas] SVG render failed'); URL.revokeObjectURL(url); };
    img.src = url;
  }, [svgContent, pdfDimensions, showSvgOverlay]);

  // ── SVG area canvas ───────────────────────────────────────────────────────
  React.useEffect(() => {
    const canvas = svgAreaCanvasRef.current;
    if (!canvas || !pdfDimensions) return;
    if (svgAreas.length === 0) {
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    drawSvgAreaCanvas(canvas, svgAreas, pdfDimensions, showSvgOverlay);
  }, [svgAreas, showSvgOverlay, pdfDimensions, svgAreaCanvasRef]);

  // ── SVG snap debug ────────────────────────────────────────────────────────
  React.useEffect(() => {
    const canvas = svgDebugCanvasRef.current;
    if (!canvas || !pdfDimensions) return;
    if (!showSvgSnapDebug || svgSnapPoints.length === 0) {
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    drawSvgSnapDebugCanvas(canvas, svgSnapPoints, pdfDimensions);
  }, [svgSnapPoints, showSvgSnapDebug, pdfDimensions]);

  // ── Cluster canvas — redraws on clusters, visibility, OR selection change ─
  React.useEffect(() => {
    const canvas = clusterCanvasRef.current;
    if (!canvas || !pdfDimensions) return;
    drawClusterCanvas(canvas, clusters, pdfDimensions, showClusters, selectedClusterId);
  }, [clusters, showClusters, pdfDimensions, selectedClusterId]);

  // ── Room labels ───────────────────────────────────────────────────────────
  React.useEffect(() => {
    const canvas = roomLabelCanvasRef?.current;
    if (!canvas || !pdfDimensions) return;
    drawRoomLabelsCanvas(canvas, rooms, pdfDimensions, showRooms);
  }, [rooms, showRooms, pdfDimensions, roomLabelCanvasRef]);

  const drawingCanvasCursor = spaceHeld
    ? isPanning ? 'cursor-grabbing' : 'cursor-grab'
    : activeTool !== 'select' && !isPanning
    ? 'cursor-crosshair'
    : isPanning ? 'cursor-grabbing' : 'cursor-grab';

  const handleRoomPointerMove = React.useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!showRooms || !pdfDimensions || !rooms.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const hit = rooms.find(r => {
      const pts = r.polygon.map(p => ({ x: p.nx * pdfDimensions.w, y: p.ny * pdfDimensions.h }));
      return pointInPolygon(mx, my, pts);
    });
    setHoveredRoomId(hit?.id ?? null);
  }, [showRooms, pdfDimensions, rooms, setHoveredRoomId]);

  const handleRoomClick = React.useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!showRooms || !hoveredRoomId) return;
    const room = rooms.find(r => r.id === hoveredRoomId);
    if (room) { e.stopPropagation(); onRoomClick(room); }
  }, [showRooms, hoveredRoomId, rooms, onRoomClick]);

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
            <input type="file" multiple className="hidden" accept=".pdf,.png,.jpg,.jpeg,.dwg" onChange={handleFileUpload} />
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
          style={pdfDimensions ? (() => {
            const vw    = containerRef.current?.clientWidth  ?? 0;
            const vh    = containerRef.current?.clientHeight ?? 0;
            const wrapW = Math.max(pdfDimensions.w + CANVAS_PADDING * 2, vw  * 3);
            const wrapH = Math.max(pdfDimensions.h + CANVAS_PADDING * 2, vh * 3);
            const left  = Math.round((wrapW - pdfDimensions.w) / 2);
            const top   = Math.round((wrapH - pdfDimensions.h) / 2);
            return { position: 'absolute' as const, left, top, width: pdfDimensions.w, height: pdfDimensions.h };
          })() : {}}
        >
          {/* Layer 0: PDF raster */}
          <canvas ref={pdfCanvasRef} className="absolute inset-0 z-0 pointer-events-none" />

          {/* Layer 1: Vector overlay */}
          <canvas
            ref={vectorCanvasRef}
            className="absolute inset-0 z-10 pointer-events-none"
            style={{ opacity: showVectors && vectorPathCount > 0 ? 1 : 0, transition: 'opacity 0.2s' }}
          />

          {/* Layer 1.5: SVG raster */}
          {svgContent && (
            <canvas
              ref={svgCanvasRef}
              className="absolute inset-0 z-[15] pointer-events-none"
              style={{
                opacity:    showSvgOverlay ? 1 : 0,
                transition: 'opacity 0.2s',
                width:      pdfDimensions?.w,
                height:     pdfDimensions?.h,
              }}
            />
          )}

          {/* Layer 1.6: SVG area canvas */}
          <canvas
            ref={svgAreaCanvasRef}
            className="absolute inset-0 z-[16] pointer-events-none"
            style={{
              opacity:    svgAreas.length > 0 ? 1 : 0,
              transition: 'opacity 0.2s',
              width:      pdfDimensions?.w,
              height:     pdfDimensions?.h,
            }}
          />

          {/* Layer 1.65: Cluster bounding boxes — INTERACTIVE */}
          <canvas
            ref={clusterCanvasRef}
            className="absolute inset-0 z-[165]"
            style={{
              opacity:    showClusters && clusters.length > 0 ? 1 : 0,
              transition: 'opacity 0.2s',
              width:      pdfDimensions?.w,
              height:     pdfDimensions?.h,
              // Show pointer cursor when clusters are visible so user knows it's clickable
              cursor:     showClusters && clusters.length > 0 ? 'pointer' : 'default',
              // When a tool is active (not select), let events pass through
              pointerEvents: activeTool === 'select' && showClusters ? 'auto' : 'none',
            }}
            onClick={handleClusterCanvasClick}
          />

          {/* Layer 1.7: SVG snap debug */}
          <canvas
            ref={svgDebugCanvasRef}
            className="absolute inset-0 z-[17] pointer-events-none"
            style={{
              opacity:    showSvgSnapDebug && svgSnapPoints.length > 0 ? 1 : 0,
              transition: 'opacity 0.2s',
              width:      pdfDimensions?.w,
              height:     pdfDimensions?.h,
            }}
          />

          {/* Layer 1.8: Raster room fills */}
          <canvas
            ref={roomCanvasRef}
            className="absolute inset-0 z-[18] pointer-events-none"
            style={{ opacity: showRooms ? 1 : 0, transition: 'opacity 0.2s' }}
          />

          {/* Layer 2: Wall overlay */}
          <canvas
            ref={wallCanvasRef}
            className="absolute inset-0 z-[20] pointer-events-none"
            style={{ opacity: showWalls && wallSegmentCount > 0 ? 1 : 0, transition: 'opacity 0.2s' }}
          />

          {/* Layer 4: Drawing canvas */}
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
            className={cn('absolute inset-0 z-40 w-full h-full mix-blend-multiply', drawingCanvasCursor)}
          />

          {/* Layer 5: Snap pin canvas */}
          <canvas
            ref={pinCanvasRef}
            className="absolute inset-0 z-50 w-full h-full pointer-events-none"
            style={{ opacity: showPins && activeTool !== 'select' ? 1 : 0, transition: 'opacity 0.2s' }}
          />

          {/* Layer 6: Count pin overlay */}
          <CountPinOverlay
            measurements={measurements}
            pdfDimensions={pdfDimensions}
            toCanvas={toCanvas}
            activeDrawingId={activeDrawingId}
            activeTool={activeTool}
          />

          {/* Layer 7: Snap flashes */}
          {snapFlashes.map(flash => (
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
          {tempPoints.length > 0 && activeTool === 'count' && (() => {
            const last = toCanvas(tempPoints[tempPoints.length - 1].x, tempPoints[tempPoints.length - 1].y);
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
          {tempPoints.length > 1 &&
            (activeTool === 'polygon' || activeTool === 'rectangle' || activeTool === 'linear') &&
            (() => {
              const last = toCanvas(tempPoints[tempPoints.length - 1].x, tempPoints[tempPoints.length - 1].y);
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

          {/* ── Selected cluster info tooltip ── */}
          {selectedClusterId && (() => {
            const c = clusters.find(x => x.id === selectedClusterId);
            if (!c || !pdfDimensions) return null;
            // Position tooltip near the first instance
            const b  = c.instanceBounds[0];
            const px = b.minNX * pdfDimensions.w;
            const py = b.minNY * pdfDimensions.h;
            return (
              <div
                className="absolute z-[80] pointer-events-none"
                style={{ left: px, top: Math.max(0, py - 52) }}
              >
                <div className="bg-zinc-900 border border-zinc-600 text-zinc-100 font-mono text-[10px] px-3 py-1.5 shadow-xl flex items-center gap-2 whitespace-nowrap">
                  <span className="text-amber-400 font-bold">{c.label}</span>
                  <span className="text-zinc-400">×{c.count} instances</span>
                  <span className="text-zinc-600">·</span>
                  <span className="text-zinc-500">ESC to deselect</span>
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </>
  );
}
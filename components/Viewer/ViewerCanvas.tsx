'use client';
// ─── components/Viewer/ViewerCanvas.tsx ───────────────────────────────────────
//
//  FIX: fillCanvasRef <canvas> now has explicit width and height attributes
//       set via a useEffect that tracks pdfDimensions. Without this the canvas
//       bitmap defaults to 300×150 while the mask is built at full PDF
//       resolution, causing every pixel operation to map into the wrong area.
//
//  FIX: style.width / style.height on fillCanvasRef are set to pdfDimensions
//       w/h so the CSS layout size matches the bitmap exactly.
//
// ─────────────────────────────────────────────────────────────────────────────

import React, { useEffect } from 'react';
import { FolderOpen, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToolType, TakeoffRow } from '@/types';
import type { PdfDimensions } from '@/types/viewerTypes';
import type { InProgressPoint } from '@/context/TakeoffContext';
import type { OffsetOutputType } from '@/hooks/perimeterOffset/usePerimeterOffset';
import { CountPinOverlay } from '@/components/features/overlays/CountPinOverlay';
import { GridCountOverlay } from './GridCountOverlay';

import {
  splitRadiusPoints,
  splitPolyarcSegments,
} from '@/hooks/measurements/useMeasurements/useMeasurementCommit';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SnapFlash { id: string; x: number; y: number; }

export interface OffsetEligibleShape {
  id:            string;
  pts:           Array<{ x: number; y: number }>;
  isClosed:      boolean;
  isPolygonType: boolean;
}

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

  polyarcHasContent?: boolean;
  polyarcMode?:       'line' | 'arc';

  offsetEligiblePolygons?: OffsetEligibleShape[] | null;
  offsetHoveredId?:        string | null;
  offsetSelectedId?:       string | null;
  offsetOutputType?:       OffsetOutputType;
  offsetPreviewPolygons?:  Array<{ x: number; y: number }[]> | null;
  offsetSourcePolygon?:    Array<{ x: number; y: number }> | null;
  offsetIsOpenPath?:       boolean;
  offsetOpenEndStyle?:     'square' | 'round' | 'butt' | 'none';
  offsetOpenOutputType?:   string;

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

// ─── buildPathD ───────────────────────────────────────────────────────────────

function buildPathD(
  poly:  Array<{ x: number; y: number }>,
  w:     number,
  h:     number,
  close: boolean = true,
): string {
  if (poly.length === 0) return '';
  const d = poly
    .map((p, j) =>
      `${j === 0 ? 'M' : 'L'} ${(p.x * w).toFixed(2)} ${(p.y * h).toFixed(2)}`
    )
    .join(' ');
  return close ? d + ' Z' : d;
}

// ─── OffsetEligibilityOverlay ─────────────────────────────────────────────────

function OffsetEligibilityOverlay({
  shapes,
  hoveredId,
  selectedId,
  pdfDimensions,
}: {
  shapes:        OffsetEligibleShape[];
  hoveredId:     string | null;
  selectedId:    string | null;
  pdfDimensions: PdfDimensions;
}) {
  const { w, h } = pdfDimensions;

  return (
    <svg
      className="absolute inset-0 z-[61] pointer-events-none"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{ width: w, height: h }}
    >
      {shapes.map((shape) => {
        const { id, pts, isClosed, isPolygonType } = shape;
        if (pts.length < 2) return null;

        const isSelected = id === selectedId;
        const isHovered  = id === hoveredId && !isSelected;

        const shouldClose = isClosed;
        const d = buildPathD(pts, w, h, shouldClose);
        if (!d) return null;

        if (isSelected) {
          return (
            <g key={id}>
              {isPolygonType && (
                <path d={d} fill="rgba(251,191,36,0.12)" stroke="none" />
              )}
              <path d={d} fill="none" stroke="#FBBF24" strokeWidth="2" strokeLinejoin="round" />
            </g>
          );
        }

        if (isHovered) {
          return (
            <g key={id}>
              {isPolygonType && (
                <path d={d} fill="rgba(45,212,191,0.14)" stroke="none" />
              )}
              <path d={d} fill="none" stroke="#2DD4BF" strokeWidth="2" strokeLinejoin="round" />
            </g>
          );
        }

        return (
          <g key={id}>
            {isPolygonType && (
              <path d={d} fill="rgba(45,212,191,0.04)" stroke="none" />
            )}
            <path
              d={d}
              fill="none"
              stroke="#2DD4BF"
              strokeWidth="1.2"
              strokeDasharray="5 4"
              strokeLinejoin="round"
              opacity="0.55"
            />
          </g>
        );
      })}
    </svg>
  );
}

// ─── OffsetPreviewOverlay ─────────────────────────────────────────────────────

function OffsetPreviewOverlay({
  polygons,
  pdfDimensions,
  outputType,
  sourcePolygon,
  isOpenPath = false,
  openEndStyle,
  openOutputType,
}: {
  polygons:        Array<{ x: number; y: number }[]>;
  pdfDimensions:   PdfDimensions;
  outputType:      OffsetOutputType;
  sourcePolygon:   Array<{ x: number; y: number }> | null | undefined;
  isOpenPath?:     boolean;
  openEndStyle?:   'square' | 'round' | 'butt' | 'none';
  openOutputType?: string;
}) {
  const { w, h } = pdfDimensions;

  const renderOpen = openEndStyle === 'none';
  const isDonut = !isOpenPath && (outputType === 'donut' || outputType === 'donut-both');

  const showFill = (() => {
    if (renderOpen) return false;
    if (isDonut)    return true;
    if (!isOpenPath) {
      return outputType === 'area' || outputType === 'donut' || outputType === 'donut-both';
    }
    return openOutputType === 'one-side-area' || openOutputType === 'buffer-area';
  })();

  const sourcePd = (isDonut && sourcePolygon && sourcePolygon.length >= 3)
    ? buildPathD(sourcePolygon, w, h, true)
    : null;

  return (
    <svg
      className="absolute inset-0 z-[62] pointer-events-none"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{ width: w, height: h }}
    >
      {polygons.map((poly, i) => {
        if (poly.length < 2) return null;

        const shouldClose = !renderOpen;
        const offsetD = buildPathD(poly, w, h, shouldClose);
        if (!offsetD) return null;

        if (isDonut && sourcePd) {
          const compoundD = `${offsetD} ${sourcePd}`;
          return (
            <g key={i}>
              <path
                d={compoundD}
                fill="rgba(251,191,36,0.18)"
                stroke="none"
                fillRule="evenodd"
              />
              <path
                d={offsetD}
                fill="none"
                stroke="#FBBF24"
                strokeWidth="1.5"
                strokeDasharray="6 4"
                strokeLinejoin="round"
              />
              <path
                d={sourcePd}
                fill="none"
                stroke="#FBBF24"
                strokeWidth="1"
                strokeDasharray="3 4"
                strokeLinejoin="round"
                opacity="0.5"
              />
            </g>
          );
        }

        return (
          <g key={i}>
            {showFill && (
              <path d={offsetD} fill="rgba(251,191,36,0.12)" stroke="none" />
            )}
            <path
              d={offsetD}
              fill="none"
              stroke="#FBBF24"
              strokeWidth="1.5"
              strokeDasharray="6 4"
              strokeLinejoin="round"
            />
          </g>
        );
      })}
    </svg>
  );
}

// ─── FillCanvasSizer ──────────────────────────────────────────────────────────
//
//  FIX: This component is the single source of truth for sizing fillCanvasRef.
//  It runs a useEffect whenever pdfDimensions changes and sets both the bitmap
//  dimensions (canvas.width / canvas.height) and CSS size (style.width/height).
//
//  Why not just set width/height in JSX?
//  React treats canvas width/height as controlled attributes and will reset them
//  to the JSX values after every render, which can race with the PDF renderer
//  which also sets these. By using a ref + useEffect we apply the size exactly
//  once per dimension change without causing React to fight the PDF renderer.
//
function FillCanvasSizer({
  fillCanvasRef,
  pdfDimensions,
}: {
  fillCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  pdfDimensions: PdfDimensions | null;
}) {
  useEffect(() => {
    const fc = fillCanvasRef.current;
    if (!fc || !pdfDimensions) return;
    const { w, h } = pdfDimensions;
    // Bitmap size — must match pdfCanvasRef bitmap so ImageData maps 1-to-1
    if (fc.width  !== w) fc.width  = w;
    if (fc.height !== h) fc.height = h;
    // CSS layout size — must match pdfDimensions so the canvas occupies
    // exactly the same pixel area as the rendered PDF in the DOM
    fc.style.width  = `${w}px`;
    fc.style.height = `${h}px`;
  }, [fillCanvasRef, pdfDimensions]);

  return null; // renders nothing — side-effects only
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
  polyarcHasContent = false,
  polyarcMode,
  offsetEligiblePolygons,
  offsetHoveredId,
  offsetSelectedId,
  offsetOutputType = 'length',
  offsetPreviewPolygons,
  offsetSourcePolygon,
  offsetIsOpenPath = false,
  offsetOpenEndStyle,
  offsetOpenOutputType,
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

  const isOffsetTool = activeTool === 'perimeter-offset';

  const drawingCanvasCursor = spaceHeld
    ? isPanning ? 'cursor-grabbing' : 'cursor-grab'
    : isOffsetTool
    ? (offsetHoveredId ? 'cursor-pointer' : 'cursor-default')
    : activeTool !== 'select' && !isPanning
    ? 'cursor-crosshair'
    : isPanning ? 'cursor-grabbing' : 'cursor-grab';

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

  const lastPt = tempPoints.length > 0
    ? pdfPtToWrapPx(tempPoints[tempPoints.length - 1])
    : null;

  const arcBtnPos = lastNonSentinelPoint
    ? pdfPtToWrapPx(lastNonSentinelPoint)
    : lastPt;

  const polyarcSegments  = activeTool === 'polyarc' ? splitPolyarcSegments(tempPoints) : [];
  const polyarcLineCount = polyarcSegments.filter(s => s.type === 'line').length;
  const polyarcArcCount  = polyarcSegments.filter(s => s.type === 'arc').length;

  const handlePointerLeave = onDrawingCanvasPointerLeave ?? (() => {
    setCursorPoint(null);
    cursorPointRef.current = null;
    redrawPinCanvas();
  });

  const pinCanvasVisible = showPins && readyToDraw;

  const showEligibilityOverlay =
    readyToDraw &&
    isOffsetTool &&
    !!offsetEligiblePolygons &&
    offsetEligiblePolygons.length > 0 &&
    !!pdfDimensions;

  const showOffsetPreview =
    readyToDraw &&
    isOffsetTool &&
    !!offsetPreviewPolygons &&
    offsetPreviewPolygons.length > 0 &&
    !!pdfDimensions;

  return (
    <>
      {!pdf && !loading && (
        <div className="flex flex-col items-center gap-6 p-12 border-2 border-dashed border-industrial-border bg-industrial-panel/50 backdrop-blur-sm max-w-xl w-full text-center">
          <FolderOpen className="w-12 h-12 text-zinc-700" />
          <div>
            <h2 className="text-xl font-mono font-bold tracking-tighter text-zinc-200 mb-2">
              IMPORT PROJECT DRAWING
            </h2>
            <p className="text-xs text-zinc-500 font-mono leading-relaxed uppercase tracking-widest">
              DRAG AND DROP A PDF HERE, OR SELECT ONE TO BEGIN MEASURING QUANTITIES.
            </p>
          </div>
          <ol className="grid grid-cols-3 gap-3 w-full text-left font-mono">
            {[
              ['01', 'Add a PDF', 'Multi-page sets are fine.'],
              ['02', 'Set the scale', 'Calibrate (K) on a known dimension.'],
              ['03', 'Measure', 'Areas, lengths and counts. Export to Excel.'],
            ].map(([n, t, d]) => (
              <li key={n} className="border border-industrial-border bg-industrial-black/40 p-3">
                <span className="text-[10px] font-bold text-amber-400">{n}</span>
                <p className="mt-1 text-[11px] font-bold uppercase tracking-widest text-zinc-200">{t}</p>
                <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">{d}</p>
              </li>
            ))}
          </ol>
          <label className="bg-amber-400 hover:bg-amber-300 text-black px-10 py-3 font-mono font-bold text-xs uppercase tracking-widest cursor-pointer transition-all shadow-xl shadow-amber-400/10 active:scale-95">
            Select File(s)
            <input
              type="file" multiple className="hidden"
              accept=".pdf,application/pdf"
              onChange={handleFileUpload}
            />
          </label>
        </div>
      )}

      {loading && (
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-zinc-800 border-t-amber-400 rounded-full animate-spin" />
          <span className="text-[10px] font-mono font-bold text-amber-400 tracking-[0.2em] uppercase animate-pulse">
            Processing Vector Data...
          </span>
        </div>
      )}

      {pdf && (
        <div
          className="relative shadow-2xl border border-industrial-border bg-white"
          style={canvasWrapStyle}
        >
          {/* FIX: FillCanvasSizer keeps fillCanvasRef bitmap + CSS size in
              sync with pdfDimensions whenever dimensions change. This is the
              root fix for the "fill covers the whole scroll area" bug. */}
          <FillCanvasSizer
            fillCanvasRef={fillCanvasRef}
            pdfDimensions={pdfDimensions}
          />

          <canvas ref={pdfCanvasRef} className="absolute inset-0 z-0 pointer-events-none" />

          <canvas
            ref={vectorCanvasRef}
            className="absolute inset-0 z-10 pointer-events-none"
          />

          {/* FIX: fillCanvasRef — no explicit width/height JSX attributes.
              Dimensions are controlled exclusively by FillCanvasSizer above
              to avoid React overwriting them on re-render. The canvas must
              sit at z-[39] so it renders below MagicFillCanvas overlays
              (z-42 through z-46) but above the vector layer (z-10).
              style.width and style.height are set by FillCanvasSizer in px
              matching pdfDimensions so it exactly overlaps the PDF page. */}
          <canvas
            ref={fillCanvasRef}
            className="absolute inset-0 z-[39] pointer-events-none"
          />

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
              'absolute inset-0 z-40 w-full h-full',
              drawingCanvasCursor,
            )}
            style={{
              opacity:       readyToDraw ? 1 : 0,
              transition:    readyToDraw ? 'opacity 0.15s' : 'none',
              pointerEvents: isGridCountActive ? 'none' : undefined,
            }}
          />

          <canvas
            ref={pinCanvasRef}
            className="absolute inset-0 z-50 pointer-events-none"
            style={{
              opacity:    pinCanvasVisible ? 1 : 0,
              transition: 'opacity 0.2s',
            }}
          />

          <GridCountOverlay
            active={isGridCountActive}
            pdfDimensions={pdfDimensions}
            scaleFactor={scaleFactor}
            onCommit={onGridCountCommit}
          />

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

          {showEligibilityOverlay && (
            <OffsetEligibilityOverlay
              shapes={offsetEligiblePolygons!}
              hoveredId={offsetHoveredId ?? null}
              selectedId={offsetSelectedId ?? null}
              pdfDimensions={pdfDimensions!}
            />
          )}

          {showOffsetPreview && (
            <OffsetPreviewOverlay
              polygons={offsetPreviewPolygons!}
              pdfDimensions={pdfDimensions!}
              outputType={offsetOutputType}
              sourcePolygon={offsetSourcePolygon ?? null}
              isOpenPath={offsetIsOpenPath}
              openEndStyle={offsetOpenEndStyle}
              openOutputType={offsetOpenOutputType}
            />
          )}

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

          {readyToDraw && activeTool === 'count' && tempPoints.length > 0 && lastPt && (
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

          {readyToDraw &&
            (activeTool === 'polygon' || activeTool === 'rectangle' || activeTool === 'linear') &&
            tempPoints.length > 1 && lastPt && (
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

          {readyToDraw && activeTool === 'polyarc' && polyarcHasContent && lastPt && (
            <button
              className="absolute z-[70] flex items-center justify-center gap-1.5 bg-orange-500 text-white font-bold font-mono text-[10px] uppercase tracking-widest px-3 py-1.5 shadow-lg whitespace-nowrap hover:bg-orange-400 active:scale-95 transition-transform"
              style={{ left: lastPt.x + 15, top: lastPt.y + 15 }}
              onClick={e => { e.stopPropagation(); handleFinishMeasurement(); }}
              onPointerDown={e => e.stopPropagation()}
            >
              <Check className="w-3 h-3" />
              Finish
              {(polyarcLineCount > 0 || polyarcArcCount > 0) && (
                <span className="ml-1 opacity-80 normal-case font-normal">
                  ({polyarcLineCount > 0 ? `${polyarcLineCount}L` : ''}{polyarcLineCount > 0 && polyarcArcCount > 0 ? '+' : ''}{polyarcArcCount > 0 ? `${polyarcArcCount}A` : ''})
                </span>
              )}
            </button>
          )}

          {readyToDraw && activeTool === 'polyarc' && !polyarcHasContent && tempPoints.length === 0 && polyarcMode && (
            <div className="absolute z-[70] top-3 left-1/2 -translate-x-1/2 pointer-events-none">
              <div className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 font-mono text-[9px] uppercase tracking-widest border',
                polyarcMode === 'arc'
                  ? 'bg-teal-900/80 border-teal-500/50 text-teal-300'
                  : 'bg-zinc-900/80 border-zinc-600/50 text-zinc-300',
              )}>
                {polyarcMode === 'arc' ? '⌒ ARC MODE' : '— LINE MODE'}
                <span className="text-zinc-500 ml-1">· Press A to toggle · Drag for arc</span>
              </div>
            </div>
          )}

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
                    <span className="ml-1 opacity-70">+{inProgressArcPts.length}pt</span>
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

          {children}
        </div>
      )}
    </>
  );
}
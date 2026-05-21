/**
 * TemplateSamplerOverlay.tsx  v1.0
 * ─────────────────────────────────
 * Three visual layers rendered inside the snap engine viewport:
 *
 *  1. RUBBER-BAND  — while the user drags to define the sample box
 *  2. CANDIDATE HIGHLIGHT — paths inside the box; click to toggle in/out
 *  3. MATCH RENDERER — bounding boxes + snap points for every match result
 *
 * Coordinate space:
 *   All SVG/canvas coords → viewport coords via:
 *     vx = svgX * zoom + pan.x
 *     vy = svgY * zoom + pan.y
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { MatchResult, SnapPointResult, TemplatePath } from '@/hooks/useTemplateMatcher';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DrawBox {
  x: number; y: number;   // viewport coords (px)
  w: number; h: number;
}

interface PdfDimensions { w: number; h: number }

interface Props {
  // Mode control
  isDrawing:     boolean;   // rubber-band drag in progress
  drawBox:       DrawBox | null;

  // Candidate paths (paths inside the drawn box)
  candidates:    TemplatePath[];
  onTogglePath:  (el: SVGElement) => void;

  // Match results
  matches:       MatchResult[];

  // Coordinate helpers
  pdfDims:       PdfDimensions | null;
  zoom:          number;
  pan:           { x: number; y: number };

  // State
  isSearching:   boolean;
  hasSignature:  boolean;
}

// ─── Colour palette ───────────────────────────────────────────────────────────

const C = {
  rubberBand:   '#f59e0b',
  candidateOn:  '#38bdf8',
  candidateOff: '#374151',
  matchBox:     '#f43f5e',
  matchSnap: {
    endpoint:   '#f59e0b',
    midpoint:   '#10b981',
    centroid:   '#8b5cf6',
  } as Record<SnapPointResult['type'], string>,
};

// ─── Coord helpers ────────────────────────────────────────────────────────────

function toVP(svgX: number, svgY: number, zoom: number, pan: { x: number; y: number }) {
  return { x: svgX * zoom + pan.x, y: svgY * zoom + pan.y };
}

// ─── Rubber-band overlay ──────────────────────────────────────────────────────

function RubberBand({ box }: { box: DrawBox }) {
  return (
    <svg
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 35, overflow: 'visible' }}
      width="100%" height="100%"
    >
      <defs>
        <pattern id="rb-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke={C.rubberBand} strokeWidth="1" strokeOpacity="0.25" />
        </pattern>
      </defs>
      <rect
        x={box.x} y={box.y} width={box.w} height={box.h}
        fill="url(#rb-hatch)"
        stroke={C.rubberBand}
        strokeWidth={1.5}
        strokeDasharray="5 3"
      />
      {/* Corner ticks */}
      {[
        [box.x, box.y], [box.x + box.w, box.y],
        [box.x, box.y + box.h], [box.x + box.w, box.y + box.h],
      ].map(([cx, cy], i) => (
        <g key={i}>
          <line x1={cx - 5} y1={cy} x2={cx + 5} y2={cy} stroke={C.rubberBand} strokeWidth={1.5} />
          <line x1={cx} y1={cy - 5} x2={cx} y2={cy + 5} stroke={C.rubberBand} strokeWidth={1.5} />
        </g>
      ))}
      {/* Dimension labels */}
      <text x={box.x + box.w / 2} y={box.y - 6} textAnchor="middle"
        fill={C.rubberBand} fontSize={9} fontFamily="'Courier New', monospace">
        {box.w.toFixed(0)} × {box.h.toFixed(0)}
      </text>
    </svg>
  );
}

// ─── Candidate highlight overlay ──────────────────────────────────────────────

function CandidateHighlights({
  candidates, onTogglePath, zoom, pan,
}: {
  candidates:   TemplatePath[];
  onTogglePath: (el: SVGElement) => void;
  zoom:         number;
  pan:          { x: number; y: number };
}) {
  if (candidates.length === 0) return null;
  return (
    <svg
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 36, overflow: 'visible' }}
      width="100%" height="100%"
    >
      {candidates.map((c, i) => {
        const b  = c.svgBBox;
        const tl = toVP(b.x,           b.y,            zoom, pan);
        const br = toVP(b.x + b.width, b.y + b.height, zoom, pan);
        const vw = br.x - tl.x, vh = br.y - tl.y;
        const col = c.toggled ? C.candidateOn : C.candidateOff;
        return (
          <g key={i} style={{ pointerEvents: 'auto', cursor: 'pointer' }}
            onClick={() => onTogglePath(c.el)}>
            <rect
              x={tl.x - 2} y={tl.y - 2} width={vw + 4} height={vh + 4}
              fill={c.toggled ? `${C.candidateOn}18` : 'transparent'}
              stroke={col}
              strokeWidth={c.toggled ? 1.5 : 1}
              strokeDasharray={c.toggled ? 'none' : '4 3'}
              rx={2}
            />
            {/* Toggle icon */}
            <circle
              cx={tl.x + vw / 2} cy={tl.y + vh / 2} r={8}
              fill="#0d0d0d" stroke={col} strokeWidth={1}
            />
            <text
              x={tl.x + vw / 2} y={tl.y + vh / 2 + 3.5}
              textAnchor="middle" fontSize={9}
              fill={col} fontFamily="'Courier New', monospace" fontWeight={700}
            >
              {c.toggled ? '✓' : '×'}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ─── Match result renderer ────────────────────────────────────────────────────

function MatchRenderer({
  matches, zoom, pan,
}: {
  matches: MatchResult[];
  zoom:    number;
  pan:     { x: number; y: number };
}) {
  if (matches.length === 0) return null;
  return (
    <svg
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 34, overflow: 'visible' }}
      width="100%" height="100%"
    >
      <defs>
        <filter id="match-glow">
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      {matches.map(match => {
        const { bbox } = match;
        const tl = toVP(bbox.x,          bbox.y,          zoom, pan);
        const br = toVP(bbox.x + bbox.w,  bbox.y + bbox.h, zoom, pan);
        const vw = br.x - tl.x, vh = br.y - tl.y;

        return (
          <g key={match.id}>
            {/* Bounding box */}
            <rect
              x={tl.x} y={tl.y} width={vw} height={vh}
              fill={`${C.matchBox}08`}
              stroke={C.matchBox}
              strokeWidth={1.5}
              rx={2}
              filter="url(#match-glow)"
            />
            {/* Score chip */}
            <rect
              x={tl.x} y={tl.y - 16} width={44} height={14}
              fill={C.matchBox} rx={2}
            />
            <text
              x={tl.x + 22} y={tl.y - 5}
              textAnchor="middle" fontSize={8}
              fill="#fff" fontFamily="'Courier New', monospace" fontWeight={700}
            >
              {Math.round(match.score * 100)}%
            </text>

            {/* Snap points */}
            {match.snapPoints.map((sp, j) => {
              const vp  = toVP(sp.x, sp.y, zoom, pan);
              const col = C.matchSnap[sp.type];
              const size = sp.type === 'centroid' ? 5 : sp.type === 'endpoint' ? 4 : 3;
              return (
                <g key={j}>
                  <circle cx={vp.x} cy={vp.y} r={size + 2} fill="none" stroke={col} strokeWidth={0.8} strokeOpacity={0.4} />
                  <circle cx={vp.x} cy={vp.y} r={size} fill={col} fillOpacity={0.9} />
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

// ─── Searching indicator ──────────────────────────────────────────────────────

function SearchingBadge() {
  return (
    <div style={{
      position: 'absolute', top: 48, left: '50%', transform: 'translateX(-50%)',
      background: 'rgba(13,13,13,0.95)', border: '1px solid #f43f5e44',
      padding: '6px 14px', display: 'flex', alignItems: 'center', gap: 8,
      zIndex: 50, pointerEvents: 'none',
    }}>
      <style>{`@keyframes sp2{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>
      <div style={{ width: 10, height: 10, border: '1.5px solid transparent', borderTopColor: '#f43f5e', borderRadius: '50%', animation: 'sp2 .6s linear infinite' }} />
      <span style={{ fontSize: 8, color: '#f43f5e', textTransform: 'uppercase', letterSpacing: '.1em', fontFamily: "'Courier New', monospace" }}>
        Searching…
      </span>
    </div>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function TemplateSamplerOverlay({
  isDrawing, drawBox,
  candidates, onTogglePath,
  matches,
  pdfDims, zoom, pan,
  isSearching, hasSignature,
}: Props) {
  return (
    <>
      {isDrawing && drawBox && <RubberBand box={drawBox} />}

      {!isDrawing && candidates.length > 0 && (
        <CandidateHighlights
          candidates={candidates}
          onTogglePath={onTogglePath}
          zoom={zoom}
          pan={pan}
        />
      )}

      {matches.length > 0 && (
        <MatchRenderer matches={matches} zoom={zoom} pan={pan} />
      )}

      {isSearching && <SearchingBadge />}
    </>
  );
}

// ─── Rubber-band draw hook (used in SnapEnginePage) ───────────────────────────

/**
 * Attaches pointer-event listeners to a viewport div and tracks a rubber-band
 * box while the user holds the mouse button in "sampler draw mode".
 *
 * Returns:
 *   drawBox     — current box in viewport px (null when not drawing)
 *   isDrawing   — true during the drag
 *   startDraw   — call on pointerdown to begin a draw
 */
export function useRubberBand(
  viewportRef: React.RefObject<HTMLDivElement | null>,
  enabled:     boolean,
  onBoxCommit: (box: DrawBox) => void,
) {
  const [drawBox,   setDrawBox]   = useState<DrawBox | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const activeRef = useRef(false);

  const startDraw = useCallback((e: React.PointerEvent) => {
    if (!enabled) return;
    const vr = viewportRef.current!.getBoundingClientRect();
    startRef.current  = { x: e.clientX - vr.left, y: e.clientY - vr.top };
    activeRef.current = true;
    setIsDrawing(true);
    setDrawBox({ x: startRef.current.x, y: startRef.current.y, w: 0, h: 0 });
  }, [enabled, viewportRef]);

  useEffect(() => {
    if (!enabled) return;
    const vp = viewportRef.current;
    if (!vp) return;

    const onMove = (e: PointerEvent) => {
      if (!activeRef.current || !startRef.current) return;
      const vr = vp.getBoundingClientRect();
      const cx = e.clientX - vr.left;
      const cy = e.clientY - vr.top;
      setDrawBox({
        x: Math.min(startRef.current.x, cx),
        y: Math.min(startRef.current.y, cy),
        w: Math.abs(cx - startRef.current.x),
        h: Math.abs(cy - startRef.current.y),
      });
    };

    const onUp = (e: PointerEvent) => {
      if (!activeRef.current || !startRef.current) return;
      const vr = vp.getBoundingClientRect();
      const cx = e.clientX - vr.left;
      const cy = e.clientY - vr.top;
      const box: DrawBox = {
        x: Math.min(startRef.current.x, cx),
        y: Math.min(startRef.current.y, cy),
        w: Math.abs(cx - startRef.current.x),
        h: Math.abs(cy - startRef.current.y),
      };
      activeRef.current = false;
      setIsDrawing(false);
      setDrawBox(null);
      startRef.current = null;
      if (box.w > 5 && box.h > 5) onBoxCommit(box);
    };

    vp.addEventListener('pointermove', onMove);
    vp.addEventListener('pointerup',   onUp);
    return () => {
      vp.removeEventListener('pointermove', onMove);
      vp.removeEventListener('pointerup',   onUp);
    };
  }, [enabled, viewportRef, onBoxCommit]);

  return { drawBox, isDrawing, startDraw };
}
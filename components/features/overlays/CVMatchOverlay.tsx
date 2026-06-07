/**
 * CVMatchOverlay.tsx  v3.0
 * ─────────────────────────
 * Visual overlay for OpenCV template match results.
 *
 * v3.0 changes:
 *  ─ CVMatchOverlay now renders a ROTATED rectangle for each match instead of
 *    an axis-aligned bbox.  The rectangle is a centred polygon rotated by
 *    match.rotation degrees, so it exactly frames the detected symbol.
 *  ─ Snap-point positions are computed from the rotated bbox corners, not the
 *    raw (c,r) top-left, so they sit on the visible symbol edges.
 *  ─ Label badge is positioned at the rotated top-left corner.
 *  ─ All v2.x features retained (CVWorkerBanner, CVRubberBand,
 *    CVSamplerSidebar, useCVRubberBand, TemplatePreview, worker log).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CVMatchResult, UseOpenCVMatcherReturn } from '@/hooks/detection/useOpenCVMatcher';

// ─── Colour palette ───────────────────────────────────────────────────────────

const C = {
  matchBox:   '#f43f5e',
  rubberBand: '#38bdf8',
  worker:     '#a78bfa',
  snap: {
    endpoint: '#f59e0b',
    midpoint: '#10b981',
    centroid: '#8b5cf6',
  } as Record<string, string>,
};

// ─── Coord helpers ────────────────────────────────────────────────────────────

/** Convert source-canvas pixel → viewport pixel */
function toVP(canvasX: number, canvasY: number, zoom: number, pan: { x: number; y: number }) {
  return { x: canvasX * zoom + pan.x, y: canvasY * zoom + pan.y };
}

/** Rotate a point (px,py) around centre (cx,cy) by deg degrees */
function rotatePoint(
  px: number, py: number,
  cx: number, cy: number,
  deg: number,
): { x: number; y: number } {
  const rad  = (deg * Math.PI) / 180;
  const cos  = Math.cos(rad);
  const sin  = Math.sin(rad);
  const dx   = px - cx;
  const dy   = py - cy;
  return {
    x: cx + dx * cos - dy * sin,
    y: cy + dx * sin + dy * cos,
  };
}

/**
 * Compute the four rotated corners of a match in SOURCE pixel space.
 *
 * Strategy (NaN-free):
 *  1. The worker stores the rotated-template bounding box as bbox + rotatedW/H.
 *     The bbox top-left (bbox.x, bbox.y) is already in source coords.
 *  2. We know the original (unrotated) template dims because the worker stores
 *     them in bbox.w / bbox.h — those are ALWAYS the original dims passed into
 *     rotateTemplateMat (see useOpenCVMatcher buildTemplate).
 *     Wait — actually bbox.w/h = rotatedW/H in v3.0.  So we recover oW/oH
 *     geometrically without any division:
 *        At angle θ:  rW = oW·|cos θ| + oH·|sin θ|
 *                     rH = oW·|sin θ| + oH·|cos θ|
 *     Adding:    rW + rH = (oW + oH)(|cos θ| + |sin θ|)  → oW+oH
 *     Subtracting: rW - rH = (oW - oH)(|cos θ| - |sin θ|)  → oW-oH  (if |cos θ| ≠ |sin θ|)
 *     At exactly 45°/135°: |cos|=|sin|, so rW=rH=o·√2 → oW=oH=rW/√2.
 *  3. Build the four unrotated corners centred at origin, rotate by +θ, translate
 *     to the match centre.  No matrix inversion, no division by near-zero det.
 */
function matchCorners(match: CVMatchResult): Array<{ x: number; y: number }> {
  const { bbox, rotatedW, rotatedH, rotation, flipped } = match;

  // Guard: if any input is NaN/non-finite, return a degenerate 1px square so
  // we never emit NaN into SVG attributes.
  if (!isFinite(bbox.x) || !isFinite(bbox.y) || !isFinite(rotatedW) || !isFinite(rotatedH)) {
    const px = isFinite(bbox.x) ? bbox.x : 0;
    const py = isFinite(bbox.y) ? bbox.y : 0;
    return [px, px+1, px+1, px].map((x, i) => ({ x, y: i < 2 ? py : py + 1 }));
  }

  const rW = Math.max(2, rotatedW);
  const rH = Math.max(2, rotatedH);

  // Normalise angle to [0, 360)
  const deg  = ((rotation % 360) + 360) % 360;
  const rad  = (deg * Math.PI) / 180;
  const cosA = Math.abs(Math.cos(rad));
  const sinA = Math.abs(Math.sin(rad));

  // Recover original dims without division by near-zero determinant
  let oW: number, oH: number;
  const DIAG_THRESH = 0.05; // |cos| and |sin| both close to 1/√2
  if (cosA < DIAG_THRESH || sinA < DIAG_THRESH) {
    // Cardinal angle (0°, 90°, 180°, 270°): one of cosA/sinA ≈ 0
    // rW ≈ oW·cosA + oH·sinA collapses to rW≈oW or rW≈oH
    oW = cosA >= sinA ? rW : rH;
    oH = cosA >= sinA ? rH : rW;
  } else if (Math.abs(cosA - sinA) < DIAG_THRESH) {
    // Diagonal (45°, 135°, 225°, 315°): |cos|=|sin|=1/√2, rW=rH=(oW+oH)/√2
    const side = (rW + rH) / (2 * Math.SQRT2);
    oW = side;
    oH = side;
  } else {
    // General angle: solve the 2×2 system safely
    // det = cosA² - sinA²  (non-zero since we're not at 45°)
    const det = cosA * cosA - sinA * sinA;
    oW = Math.max(2, (rW * cosA - rH * sinA) / det);
    oH = Math.max(2, (rH * cosA - rW * sinA) / det);
  }

  // Centre of the matched region in source space
  const cx = bbox.x + rW / 2;
  const cy = bbox.y + rH / 2;

  // Rotation trig (signed, not abs)
  const effDeg = flipped ? -deg : deg;
  const effRad = (effDeg * Math.PI) / 180;
  const cosR   = Math.cos(effRad);
  const sinR   = Math.sin(effRad);

  // Four corners of the ORIGINAL template centred at origin, rotated by effDeg
  const hw = oW / 2;
  const hh = oH / 2;
  const local = [
    { x: -hw, y: -hh },
    { x:  hw, y: -hh },
    { x:  hw, y:  hh },
    { x: -hw, y:  hh },
  ];

  return local.map(({ x, y }) => ({
    x: cx + x * cosR - y * sinR,
    y: cy + x * sinR + y * cosR,
  }));
}

// ─── Match overlay ────────────────────────────────────────────────────────────

interface CVMatchOverlayProps {
  matches: CVMatchResult[];
  zoom:    number;
  pan:     { x: number; y: number };
}

export function CVMatchOverlay({ matches, zoom, pan }: CVMatchOverlayProps) {
  if (matches.length === 0) return null;

  return (
    <svg
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 34, overflow: 'visible' }}
      width="100%"
      height="100%"
    >
      <defs>
        <filter id="cv-glow">
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        {/* Hatch pattern for the rotated fill */}
        <pattern id="cv-match-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="8" stroke={C.matchBox} strokeWidth="0.8" strokeOpacity="0.18" />
        </pattern>
      </defs>

      {matches.map((match, idx) => {
        // Rotated corners in source pixel space
        const srcCorners = matchCorners(match);

        // Convert to viewport space; clamp any residual NaN/Inf to 0
        const safe = (n: number) => (isFinite(n) ? n : 0);
        const vpCorners = srcCorners.map(({ x, y }) => {
          const vp = toVP(x, y, zoom, pan);
          return { x: safe(vp.x), y: safe(vp.y) };
        });

        // SVG polygon points string
        const pts = vpCorners.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

        // Label position: rotated top-left corner (first corner)
        const labelPt = vpCorners[0];

        // Centre of the polygon in viewport space (for snap points)
        const vpCx = vpCorners.reduce((s, p) => s + p.x, 0) / 4;
        const vpCy = vpCorners.reduce((s, p) => s + p.y, 0) / 4;

        // Orientation label
        const orientLabel = match.orientationLabel ?? `${match.rotation}°`;

        // Derive snap points in viewport space from the rotated corners
        const vpSnap = [
          // centroid
          { x: vpCx, y: vpCy, type: 'centroid' as const },
          // corners → endpoints
          ...vpCorners.map(p => ({ x: p.x, y: p.y, type: 'endpoint' as const })),
          // edge midpoints → midpoints
          ...([0, 1, 2, 3] as const).map(i => {
            const a = vpCorners[i];
            const b = vpCorners[(i + 1) % 4];
            return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, type: 'midpoint' as const };
          }),
        ];

        // Badge dimensions
        const badgeW = 80;
        const badgeH = 16;

        return (
          <g key={match.id} filter="url(#cv-glow)">
            {/* Hatch fill */}
            <polygon
              points={pts}
              fill="url(#cv-match-hatch)"
            />
            {/* Stroke outline */}
            <polygon
              points={pts}
              fill="none"
              stroke={C.matchBox}
              strokeWidth={1.5}
            />

            {/* Corner tick marks */}
            {vpCorners.map((corner, ci) => {
              const prev = vpCorners[(ci + 3) % 4];
              const next = vpCorners[(ci + 1) % 4];
              const tickLen = 6;

              const toPrev = { x: prev.x - corner.x, y: prev.y - corner.y };
              const toNext = { x: next.x - corner.x, y: next.y - corner.y };
              const lenP   = Math.hypot(toPrev.x, toPrev.y) || 1;
              const lenN   = Math.hypot(toNext.x, toNext.y) || 1;
              const p1 = { x: corner.x + (toPrev.x / lenP) * tickLen, y: corner.y + (toPrev.y / lenP) * tickLen };
              const p2 = { x: corner.x + (toNext.x / lenN) * tickLen, y: corner.y + (toNext.y / lenN) * tickLen };

              return (
                <g key={ci}>
                  <line x1={corner.x} y1={corner.y} x2={p1.x} y2={p1.y} stroke={C.matchBox} strokeWidth={2} />
                  <line x1={corner.x} y1={corner.y} x2={p2.x} y2={p2.y} stroke={C.matchBox} strokeWidth={2} />
                </g>
              );
            })}

            {/* Score + orientation badge — at the rotated top-left corner */}
            <rect
              x={labelPt.x}
              y={labelPt.y - badgeH - 2}
              width={badgeW}
              height={badgeH}
              fill={C.matchBox}
              rx={2}
            />
            <text
              x={labelPt.x + badgeW / 2}
              y={labelPt.y - badgeH / 2 - 2 + 4}
              textAnchor="middle"
              fontSize={8}
              fill="#fff"
              fontFamily="'Courier New', monospace"
              fontWeight={700}
            >
              {Math.round(match.score * 100)}% {orientLabel} #{idx + 1}
            </text>

            {/* Snap points */}
            {vpSnap.map((sp, j) => {
              const col = C.snap[sp.type] ?? '#fff';
              const r   = sp.type === 'centroid' ? 5 : sp.type === 'endpoint' ? 4 : 3;
              return (
                <g key={j}>
                  {sp.type === 'centroid' && (
                    <>
                      <line x1={sp.x - 8} y1={sp.y} x2={sp.x + 8} y2={sp.y} stroke={col} strokeWidth={1} strokeOpacity={0.6} />
                      <line x1={sp.x} y1={sp.y - 8} x2={sp.x} y2={sp.y + 8} stroke={col} strokeWidth={1} strokeOpacity={0.6} />
                    </>
                  )}
                  <circle cx={sp.x} cy={sp.y} r={r + 2} fill="none" stroke={col} strokeWidth={0.8} strokeOpacity={0.4} />
                  <circle cx={sp.x} cy={sp.y} r={r}     fill={col} fillOpacity={0.9} />
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

// ─── Worker phase banner ──────────────────────────────────────────────────────

interface CVWorkerBannerProps {
  isSearching:  boolean;
  workerPhase:  string;
  workerDetail: string;
}

export function CVWorkerBanner({ isSearching, workerPhase, workerDetail }: CVWorkerBannerProps) {
  if (!isSearching) return null;

  const isTextPhase =
    workerPhase.toLowerCase().includes('text') ||
    workerDetail.toLowerCase().includes('text');

  const phaseColor = isTextPhase ? '#f59e0b' : C.worker;

  return (
    <div style={{
      position:      'absolute',
      top:           48,
      left:          '50%',
      transform:     'translateX(-50%)',
      background:    'rgba(13,13,13,0.96)',
      border:        `1px solid ${phaseColor}44`,
      padding:       '6px 14px',
      display:       'flex',
      flexDirection: 'column',
      alignItems:    'center',
      gap:           4,
      zIndex:        50,
      pointerEvents: 'none',
      minWidth:      240,
    }}>
      <style>{`@keyframes cvspin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{
          width: 10, height: 10,
          border: `1.5px solid transparent`,
          borderTopColor: phaseColor,
          borderRadius: '50%',
          animation: 'cvspin .6s linear infinite',
          flexShrink: 0,
        }} />
        <span style={{
          fontSize: 8, color: phaseColor,
          textTransform: 'uppercase', letterSpacing: '.1em',
          fontFamily: "'Courier New', monospace",
        }}>
          {workerPhase || 'Working…'}
        </span>
      </div>
      {workerDetail && (
        <span style={{
          fontSize: 7, color: isTextPhase ? '#f59e0b' : '#555',
          textTransform: 'uppercase', letterSpacing: '.07em',
          fontFamily: "'Courier New', monospace",
        }}>
          {workerDetail}
        </span>
      )}
    </div>
  );
}

// ─── Rubber-band overlay ──────────────────────────────────────────────────────

interface DrawBox { x: number; y: number; w: number; h: number }

interface CVRubberBandProps {
  isDrawing:    boolean;
  drawBox:      DrawBox | null;
  tooLarge:     boolean;
  isSearching:  boolean;
  workerPhase:  string;
  workerDetail: string;
}

export function CVRubberBand({ isDrawing, drawBox, tooLarge }: CVRubberBandProps) {
  if (!isDrawing || !drawBox) return null;
  const col = tooLarge ? '#f43f5e' : C.rubberBand;
  return (
    <svg style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 35, overflow: 'visible' }} width="100%" height="100%">
      <defs>
        <pattern id="cv-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke={col} strokeWidth="1" strokeOpacity="0.25" />
        </pattern>
      </defs>
      <rect
        x={drawBox.x} y={drawBox.y} width={drawBox.w} height={drawBox.h}
        fill="url(#cv-hatch)" stroke={col} strokeWidth={1.5} strokeDasharray={tooLarge ? '6 3' : '5 3'}
      />
      {[[drawBox.x, drawBox.y], [drawBox.x + drawBox.w, drawBox.y], [drawBox.x, drawBox.y + drawBox.h], [drawBox.x + drawBox.w, drawBox.y + drawBox.h]].map(([cx, cy], i) => (
        <g key={i}>
          <line x1={cx - 5} y1={cy} x2={cx + 5} y2={cy} stroke={col} strokeWidth={1.5} />
          <line x1={cx} y1={cy - 5} x2={cx} y2={cy + 5} stroke={col} strokeWidth={1.5} />
        </g>
      ))}
      <text x={drawBox.x + drawBox.w / 2} y={drawBox.y - 6} textAnchor="middle" fill={col} fontSize={9} fontFamily="'Courier New',monospace">
        {tooLarge ? 'Zoom in — box too large' : `${drawBox.w.toFixed(0)} × ${drawBox.h.toFixed(0)} vp`}
      </text>
    </svg>
  );
}

// ─── Sidebar helpers ──────────────────────────────────────────────────────────

function TRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
      <span style={{ fontSize: 7, color: '#555', textTransform: 'uppercase', letterSpacing: '.07em' }}>{label}</span>
      <span style={{ fontSize: 8, color: '#e5e5e5', fontWeight: 700 }}>{value}</span>
    </div>
  );
}

function tbBtn(active: boolean, colour?: string): React.CSSProperties {
  const c = colour ?? '#38bdf8';
  return {
    fontSize: 8, textTransform: 'uppercase', letterSpacing: '.07em',
    border: `1px solid ${active ? c : '#2a2a2a'}`,
    background: active ? `${c}12` : 'transparent',
    color: active ? c : '#777',
    padding: '3px 7px', cursor: 'pointer', fontFamily: 'inherit',
    whiteSpace: 'nowrap', flexShrink: 0,
  };
}

// ─── Template preview canvas ──────────────────────────────────────────────────

function TemplatePreview({ crop, label, labelColor }: { crop: ImageData; label: string; labelColor: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const maxDim = 100;
    const scale  = Math.min(maxDim / crop.width, maxDim / crop.height, 1);
    canvas.width  = Math.round(crop.width  * scale);
    canvas.height = Math.round(crop.height * scale);
    const ctx = canvas.getContext('2d')!;
    const tmp = document.createElement('canvas');
    tmp.width  = crop.width;
    tmp.height = crop.height;
    tmp.getContext('2d')!.putImageData(crop, 0, 0);
    ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
  }, [crop]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1 }}>
      <div style={{ fontSize: 6, color: labelColor, textTransform: 'uppercase', letterSpacing: '.08em' }}>{label}</div>
      <canvas
        ref={ref}
        style={{ display: 'block', border: `1px solid ${labelColor}44`, background: '#fff', maxWidth: '100%', imageRendering: 'pixelated' }}
      />
      <div style={{ fontSize: 6, color: '#333' }}>{crop.width}×{crop.height}px</div>
    </div>
  );
}

// ─── Worker log entry type ────────────────────────────────────────────────────

interface WorkerLogEntry {
  ts:     number;
  phase:  string;
  detail: string;
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

type SamplerMode = 'idle' | 'drawing' | 'matched';

interface CVSamplerSidebarProps {
  matcher:      UseOpenCVMatcherReturn;
  samplerMode:  SamplerMode;
  onEnterDraw:  () => void;
  onClear:      () => void;
  threshold:    number;
  onThreshold:  (v: number) => void;
  rotations:    number[];
  onRotations:  (v: number[]) => void;
  flips:        boolean[];
  onFlips:      (v: boolean[]) => void;
  removeText:   boolean;
  onRemoveText: (v: boolean) => void;
}

export function CVSamplerSidebar({
  matcher, samplerMode, onEnterDraw, onClear,
  threshold, onThreshold,
  rotations, onRotations,
  flips, onFlips,
  removeText, onRemoveText,
}: CVSamplerSidebarProps) {
  const COL    = '#38bdf8';
  const SNAP_C = { endpoint: '#f59e0b', midpoint: '#10b981', centroid: '#8b5cf6' };

  // Full rotation presets including diagonals
  const PRESET_ROTS = [0, 45, 90, 135, 180, 225, 270, 315];

  const hasCleanedVersion =
    removeText &&
    matcher.rawTemplateCrop !== null &&
    matcher.templateCrop    !== null &&
    matcher.templateCrop !== matcher.rawTemplateCrop;

  // ── Worker log ──────────────────────────────────────────────────────────────
  const [log, setLog] = useState<WorkerLogEntry[]>([]);

  useEffect(() => {
    if (!matcher.workerPhase) return;
    setLog(prev => {
      const last = prev[prev.length - 1];
      if (last && last.phase === matcher.workerPhase) return prev;
      const entry: WorkerLogEntry = { ts: Date.now(), phase: matcher.workerPhase, detail: matcher.workerDetail };
      return [...prev.slice(-9), entry];
    });
  }, [matcher.workerPhase, matcher.workerDetail]);

  useEffect(() => {
    if (matcher.isSearching) setLog([]);
  }, [matcher.isSearching]);

  return (
    <>
      {/* ── Header ── */}
      <div style={{ padding: '8px 10px', borderBottom: '1px solid #1a1a1a', flexShrink: 0 }}>
        <div style={{ fontSize: 8, color: '#3a3a3a', textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 8 }}>OpenCV Sampler</div>

        {/* Ready indicator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, background: 'rgba(56,189,248,0.06)', border: '1px solid #38bdf822', padding: '4px 8px' }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: matcher.isReady ? '#22c55e' : '#f59e0b', flexShrink: 0 }} />
          <span style={{ fontSize: 7, color: matcher.isReady ? '#22c55e' : '#f59e0b', textTransform: 'uppercase', letterSpacing: '.07em' }}>
            {matcher.isReady ? 'Worker · OpenCV ready' : 'Worker · Loading…'}
          </span>
        </div>

        {/* Step indicators */}
        {(['Draw', 'Match'] as const).map((step, i) => {
          const stepMode = ['drawing', 'matched'][i];
          const done     = i === 0 && samplerMode === 'matched';
          const active   = samplerMode === stepMode;
          return (
            <div key={step} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <div style={{
                width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
                background: done ? '#1a3a1a' : active ? '#1a2a3a' : '#111',
                border: `1px solid ${done ? '#22c55e' : active ? COL : '#2a2a2a'}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 8, color: done ? '#22c55e' : active ? COL : '#333',
              }}>
                {done ? '✓' : i + 1}
              </div>
              <span style={{ fontSize: 8, color: active ? '#ccc' : done ? '#555' : '#2a2a2a', textTransform: 'uppercase', letterSpacing: '.07em' }}>{step}</span>
            </div>
          );
        })}

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 4, marginTop: 10, flexWrap: 'wrap' as const }}>
          {samplerMode === 'idle' && (
            <button onClick={onEnterDraw} style={{ ...tbBtn(true, COL), flex: 1 }}>⊡ Draw Sample</button>
          )}
          {samplerMode === 'drawing' && (
            <div style={{ fontSize: 7, color: COL, textTransform: 'uppercase', letterSpacing: '.07em', padding: '3px 0', lineHeight: 1.8 }}>
              Drag a tight box around<br />ONE symbol on the canvas
            </div>
          )}
          {samplerMode === 'matched' && (
            <>
              <button onClick={onEnterDraw} style={{ ...tbBtn(false, COL), flex: 1 }}>⊡ New Sample</button>
              <button onClick={onClear}     style={{ ...tbBtn(false), padding: '3px 7px' }}>✕</button>
            </>
          )}
        </div>
      </div>

      {/* ── Settings ── */}
      <div style={{ padding: '6px 10px', borderBottom: '1px solid #1a1a1a', flexShrink: 0 }}>
        <div style={{ fontSize: 7, color: '#333', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 6 }}>Settings</div>

        {/* Threshold */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <span style={{ fontSize: 7, color: '#555', textTransform: 'uppercase', letterSpacing: '.06em', minWidth: 56 }}>Threshold</span>
          <input type="range" min={30} max={95} step={1} value={Math.round(threshold * 100)}
            onChange={e => onThreshold(+e.target.value / 100)} style={{ flex: 1, accentColor: COL }} />
          <span style={{ fontSize: 8, color: COL, minWidth: 28 }}>{Math.round(threshold * 100)}%</span>
        </div>

        {/* Rotations — now includes 45° increments */}
        <div style={{ marginBottom: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
            <span style={{ fontSize: 7, color: '#555', textTransform: 'uppercase', letterSpacing: '.06em', minWidth: 56 }}>Rotations</span>
            <button
              onClick={() => onRotations(PRESET_ROTS)}
              style={{ fontSize: 6, padding: '1px 4px', cursor: 'pointer', border: '1px solid #2a2a2a', background: 'transparent', color: '#444', fontFamily: 'inherit', textTransform: 'uppercase' }}
            >all</button>
            <button
              onClick={() => onRotations([])}
              style={{ fontSize: 6, padding: '1px 4px', cursor: 'pointer', border: '1px solid #2a2a2a', background: 'transparent', color: '#444', fontFamily: 'inherit', textTransform: 'uppercase' }}
            >none</button>
          </div>
          <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' as const }}>
            {PRESET_ROTS.map(deg => {
              const on = rotations.includes(deg);
              return (
                <button key={deg}
                  onClick={() => onRotations(on ? rotations.filter(r => r !== deg) : [...rotations, deg])}
                  style={{
                    fontSize: 7, padding: '2px 5px', cursor: 'pointer',
                    border: `1px solid ${on ? COL : '#2a2a2a'}`,
                    background: on ? `${COL}15` : 'transparent',
                    color: on ? COL : '#444',
                    fontFamily: 'inherit', textTransform: 'uppercase',
                  }}>
                  {deg}°
                </button>
              );
            })}
          </div>
        </div>

        {/* Remove text */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
          <span style={{ fontSize: 7, color: '#555', textTransform: 'uppercase', letterSpacing: '.06em', minWidth: 56 }}>Text</span>
          <button
            onClick={() => onRemoveText(!removeText)}
            style={{
              fontSize: 7, padding: '2px 5px', cursor: 'pointer',
              border: `1px solid ${removeText ? '#f43f5e' : '#2a2a2a'}`,
              background: removeText ? 'rgba(244,63,94,0.1)' : 'transparent',
              color: removeText ? '#f43f5e' : '#444',
              fontFamily: 'inherit', textTransform: 'uppercase',
            }}
            title="Strip text labels from symbols before matching"
          >
            {removeText ? '✕ strip text' : '· keep text'}
          </button>
          <span style={{ fontSize: 7, color: '#2a2a2a', letterSpacing: '.04em' }}>
            {removeText ? 'ignores labels' : 'exact match'}
          </span>
        </div>

        {/* Flips */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 7, color: '#555', textTransform: 'uppercase', letterSpacing: '.06em', minWidth: 56 }}>Mirror</span>
          {([false, true] as const).map(f => {
            const on  = flips.includes(f);
            const lbl = f ? '↔ flip' : 'normal';
            return (
              <button key={String(f)}
                onClick={() => onFlips(on ? flips.filter(x => x !== f) : [...flips, f])}
                style={{
                  fontSize: 7, padding: '2px 5px', cursor: 'pointer',
                  border: `1px solid ${on ? COL : '#2a2a2a'}`,
                  background: on ? `${COL}15` : 'transparent',
                  color: on ? COL : '#444',
                  fontFamily: 'inherit', textTransform: 'uppercase',
                }}>
                {lbl}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Worker log ── */}
      <div style={{ padding: '6px 10px', borderBottom: '1px solid #1a1a1a', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div style={{ fontSize: 7, color: '#333', textTransform: 'uppercase', letterSpacing: '.08em' }}>Worker log</div>
          {matcher.isSearching && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <style>{`@keyframes cvspin2{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>
              <div style={{ width: 6, height: 6, border: '1px solid transparent', borderTopColor: C.worker, borderRadius: '50%', animation: 'cvspin2 .5s linear infinite' }} />
              <span style={{ fontSize: 7, color: C.worker, textTransform: 'uppercase', letterSpacing: '.06em' }}>running</span>
            </div>
          )}
        </div>

        {matcher.workerPhase && (
          <div style={{ background: '#0a0a0a', border: `1px solid ${C.worker}22`, padding: '3px 6px', marginBottom: 4 }}>
            <div style={{ fontSize: 7, color: C.worker, letterSpacing: '.06em', textTransform: 'uppercase' }}>
              {matcher.workerPhase}
            </div>
            {matcher.workerDetail && (
              <div style={{ fontSize: 7, color: matcher.workerDetail.startsWith('✓') ? '#22c55e' : '#f59e0b', letterSpacing: '.05em', marginTop: 2 }}>
                {matcher.workerDetail}
              </div>
            )}
          </div>
        )}

        <div style={{ maxHeight: 80, overflowY: 'auto' }}>
          {log.map((entry, i) => {
            const isTextEntry = entry.phase.toLowerCase().includes('text') || entry.detail.toLowerCase().includes('text');
            const isLast      = i === log.length - 1;
            return (
              <div key={entry.ts} style={{ display: 'flex', alignItems: 'baseline', gap: 4, marginBottom: 1, opacity: isLast ? 1 : 0.4 }}>
                <span style={{ fontSize: 6, color: isTextEntry ? '#f59e0b' : '#2a2a2a', flexShrink: 0 }}>›</span>
                <span style={{ fontSize: 6, color: isTextEntry ? '#f59e0b' : '#3a3a3a', textTransform: 'uppercase', letterSpacing: '.04em', lineHeight: 1.6 }}>
                  {entry.phase}{entry.detail ? ` · ${entry.detail}` : ''}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Template previews ── */}
      {matcher.rawTemplateCrop && (
        <div style={{ padding: '6px 10px', borderBottom: '1px solid #1a1a1a', flexShrink: 0 }}>
          <div style={{ fontSize: 7, color: '#333', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 6 }}>
            Template preview
          </div>
          {hasCleanedVersion ? (
            <>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <TemplatePreview crop={matcher.rawTemplateCrop} label="Original"       labelColor="#555" />
                <TemplatePreview crop={matcher.templateCrop!}   label="Text stripped ✓" labelColor="#22c55e" />
              </div>
              <div style={{ marginTop: 5, fontSize: 6, color: '#2a2a2a', textTransform: 'uppercase', letterSpacing: '.06em', lineHeight: 1.8 }}>
                White areas = erased text blobs · right image is what was matched
              </div>
            </>
          ) : (
            <>
              <TemplatePreview
                crop={matcher.rawTemplateCrop}
                label={matcher.isSearching && removeText ? 'Original (stripping text…)' : 'Original'}
                labelColor={matcher.isSearching && removeText ? '#f59e0b' : '#555'}
              />
              {matcher.isSearching && removeText && (
                <div style={{ marginTop: 4, fontSize: 6, color: '#f59e0b', textTransform: 'uppercase', letterSpacing: '.06em' }}>
                  ⟳ Text-erased preview will appear here
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Results ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 6 }}>
        {matcher.isSearching && (
          <p style={{ fontSize: 8, color: '#555', textAlign: 'center', textTransform: 'uppercase', letterSpacing: '.08em', padding: '20px 0' }}>Running OpenCV in worker…</p>
        )}
        {!matcher.isSearching && samplerMode === 'matched' && matcher.matches.length === 0 && (
          <p style={{ fontSize: 8, color: '#2a2a2a', textAlign: 'center', textTransform: 'uppercase', letterSpacing: '.08em', padding: '20px 8px', lineHeight: 2.2 }}>
            No matches at {Math.round(threshold * 100)}% threshold.<br />Try lowering threshold or<br />drawing a tighter sample.
          </p>
        )}
        {!matcher.isSearching && matcher.matches.length > 0 && (
          <>
            <div style={{ fontSize: 7, color: '#333', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 6, padding: '2px 4px' }}>
              {matcher.matches.length} match{matcher.matches.length !== 1 ? 'es' : ''} · pixel-accurate
            </div>
            {matcher.matches.map((match, i) => (
              <div key={match.id} style={{ border: '1px solid #1a1a1a', padding: '6px 8px', marginBottom: 4, background: '#0a0a0a' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <div style={{ width: 8, height: 8, borderRadius: 1, background: '#f43f5e', flexShrink: 0 }} />
                  <span style={{ fontSize: 8, color: '#888', textTransform: 'uppercase', letterSpacing: '.05em', flex: 1 }}>Match {i + 1}</span>
                  <span style={{ fontSize: 8, color: '#f43f5e', fontWeight: 700 }}>{Math.round(match.score * 100)}%</span>
                </div>
                <div style={{ paddingLeft: 14 }}>
                  <TRow label="Position"    value={`${match.bbox.x.toFixed(0)}, ${match.bbox.y.toFixed(0)}`} />
                  <TRow label="Orig size"   value={`${match.bbox.w} × ${match.bbox.h} px`} />
                  <TRow label="Orientation" value={match.orientationLabel ?? `${match.rotation}°`} />
                  <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                    {(['endpoint', 'midpoint', 'centroid'] as const).map(type => {
                      const count = match.snapPoints.filter(s => s.type === type).length;
                      if (!count) return null;
                      return (
                        <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                          <div style={{ width: 6, height: 6, borderRadius: '50%', background: SNAP_C[type] }} />
                          <span style={{ fontSize: 7, color: '#444' }}>{count}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            ))}
          </>
        )}
        {samplerMode === 'idle' && (
          <p style={{ fontSize: 8, color: '#2a2a2a', textAlign: 'center', textTransform: 'uppercase', letterSpacing: '.08em', padding: '28px 8px', lineHeight: 2.2 }}>
            Draw a sample box around<br />any symbol to find all<br />matching instances
          </p>
        )}
      </div>
    </>
  );
}

// ─── Rubber-band draw hook ────────────────────────────────────────────────────

const MAX_BOX_VP_FRAC = 0.35;

interface DrawBox2 { x: number; y: number; w: number; h: number }

export function useCVRubberBand(
  viewportRef: React.RefObject<HTMLDivElement | null>,
  enabled:     boolean,
  onCommit:    (box: DrawBox2) => void,
) {
  const [drawBox,   setDrawBox]   = useState<DrawBox2 | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [tooLarge,  setTooLarge]  = useState(false);
  const startRef  = useRef<{ x: number; y: number } | null>(null);
  const activeRef = useRef(false);

  const isTooLarge = useCallback((box: DrawBox2): boolean => {
    const vp = viewportRef.current; if (!vp) return false;
    const vr = vp.getBoundingClientRect();
    return box.w > vr.width * MAX_BOX_VP_FRAC || box.h > vr.height * MAX_BOX_VP_FRAC;
  }, [viewportRef]);

  const startDraw = useCallback((e: React.PointerEvent) => {
    if (!enabled) return;
    const vr = viewportRef.current!.getBoundingClientRect();
    startRef.current  = { x: e.clientX - vr.left, y: e.clientY - vr.top };
    activeRef.current = true;
    setIsDrawing(true); setTooLarge(false);
    setDrawBox({ x: startRef.current.x, y: startRef.current.y, w: 0, h: 0 });
  }, [enabled, viewportRef]);

  useEffect(() => {
    if (!enabled) return;
    const vp = viewportRef.current; if (!vp) return;
    const onMove = (e: PointerEvent) => {
      if (!activeRef.current || !startRef.current) return;
      const vr = vp.getBoundingClientRect();
      const box: DrawBox2 = {
        x: Math.min(startRef.current.x, e.clientX - vr.left),
        y: Math.min(startRef.current.y, e.clientY - vr.top),
        w: Math.abs(e.clientX - vr.left - startRef.current.x),
        h: Math.abs(e.clientY - vr.top  - startRef.current.y),
      };
      setDrawBox(box); setTooLarge(isTooLarge(box));
    };
    const onUp = (e: PointerEvent) => {
      if (!activeRef.current || !startRef.current) return;
      const vr = vp.getBoundingClientRect();
      const box: DrawBox2 = {
        x: Math.min(startRef.current.x, e.clientX - vr.left),
        y: Math.min(startRef.current.y, e.clientY - vr.top),
        w: Math.abs(e.clientX - vr.left - startRef.current.x),
        h: Math.abs(e.clientY - vr.top  - startRef.current.y),
      };
      activeRef.current = false; setIsDrawing(false); setDrawBox(null); setTooLarge(false); startRef.current = null;
      if (box.w > 5 && box.h > 5 && !isTooLarge(box)) onCommit(box);
    };
    vp.addEventListener('pointermove', onMove);
    vp.addEventListener('pointerup', onUp);
    return () => { vp.removeEventListener('pointermove', onMove); vp.removeEventListener('pointerup', onUp); };
  }, [enabled, viewportRef, onCommit, isTooLarge]);

  return { drawBox, isDrawing, tooLarge, startDraw };
}
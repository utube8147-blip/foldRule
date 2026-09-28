/**
 * CVMatchOverlay.tsx  v7.0
 * ─────────────────────────
 * Visual overlay + sidebar for multi-template two-stage coarse→fine matching.
 *
 * v7.0 changes over v6.0:
 *  ─ CVMatchOverlay draws ROTATED bounding boxes using cx/cy/rotation from
 *    each result. No more axis-aligned rectangles for angled matches.
 *  ─ Corner ticks and snap points all follow the rotated frame.
 *  ─ CVSamplerSidebar gains a "Templates" section that lists every template
 *    with its colour swatch, label, thumbnail, and a remove button.
 *  ─ "+ Add Variation" button lets the user draw a second (third…) template
 *    box without clearing existing matches.
 *  ─ Match cards colour-coded by templateIndex using TEMPLATE_PALETTE.
 *  ─ Template count and per-template match breakdown shown in results header.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CVMatchResult, UseOpenCVMatcherReturn } from '@/hooks/detection/useOpenCVMatcher';
import { templateColor, TEMPLATE_PALETTE } from '@/hooks/detection/useOpenCVMatcher';

// ─── Colour helpers ───────────────────────────────────────────────────────────

const C = {
  rubberBand: '#38bdf8',
  worker:     '#a78bfa',
  snap: {
    endpoint: '#f59e0b',
    midpoint: '#10b981',
    centroid: '#8b5cf6',
  } as Record<string, string>,
};

function scoreColor(score: number): string {
  const t = Math.max(0, Math.min(1, (score - 0.5) / 0.5));
  const h = Math.round(t * 120);
  return `hsl(${h},90%,55%)`;
}

// ─── Rotated box corner helper ────────────────────────────────────────────────
//
//  Given a match result with cx/cy (canvas centre), tmplW/H, rotation and
//  scale, returns the 4 viewport-space corners of the rotated rectangle.

function rotatedVPCorners(
  match: CVMatchResult,
  zoom:  number,
  pan:   { x: number; y: number },
): Array<{ x: number; y: number }> {
  const { cx, cy, tmplW, tmplH, rotation, scale } = match;
  const w   = tmplW * (isFinite(scale) ? scale : 1);
  const h   = tmplH * (isFinite(scale) ? scale : 1);
  const hw  = w / 2;
  const hh  = h / 2;
  const rad = rotation * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  // Four corners in canvas space (rotated around centre)
  const canvasCorners = [
    [-hw, -hh], [ hw, -hh], [ hw,  hh], [-hw,  hh],
  ].map(([dx, dy]) => ({
    x: cx + dx * cos - dy * sin,
    y: cy + dx * sin + dy * cos,
  }));

  // Map to viewport space
  return canvasCorners.map(p => ({
    x: p.x * zoom + pan.x,
    y: p.y * zoom + pan.y,
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
      style={{ position:'absolute',inset:0,pointerEvents:'none',zIndex:34,overflow:'visible' }}
      width="100%" height="100%"
    >
      <defs>
        <filter id="cv-glow">
          <feGaussianBlur stdDeviation="1.5" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        {TEMPLATE_PALETTE.map((col, i) => (
          <pattern key={i} id={`cv-hatch-${i}`} width="8" height="8"
            patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="8" stroke={col}
              strokeWidth="0.8" strokeOpacity="0.15" />
          </pattern>
        ))}
      </defs>

      {matches.map((match, idx) => {
        const safe      = (n: number) => (isFinite(n) ? n : 0);
        const corners   = rotatedVPCorners(match, zoom, pan)
                            .map(p => ({ x: safe(p.x), y: safe(p.y) }));
        const pts       = corners.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
        const vpCx      = corners.reduce((s, p) => s + p.x, 0) / 4;
        const vpCy      = corners.reduce((s, p) => s + p.y, 0) / 4;
        const labelPt   = corners[0];               // top-left rotated corner
        const tIdx      = match.templateIndex ?? 0;
        const boxCol    = templateColor(tIdx);
        const scaleVal  = isFinite(match.scale) ? match.scale : 1;
        const showScale = Math.abs(scaleVal - 1.0) > 0.01;
        const badgeW    = 120;
        const badgeH    = 16;
        const rotLabel  = Number.isInteger(match.rotation)
          ? `${match.rotation}°`
          : `${match.rotation.toFixed(1)}°`;

        // Snap points in VP space — from pre-computed canvas-space snap points
        const vpSnap = match.snapPoints.map(sp => ({
          x: sp.x * zoom + pan.x,
          y: sp.y * zoom + pan.y,
          type: sp.type,
        }));

        return (
          <g key={match.id} filter="url(#cv-glow)">
            {/* Filled hatch */}
            <polygon points={pts} fill={`url(#cv-hatch-${tIdx % TEMPLATE_PALETTE.length})`} />

            {/* Outline */}
            <polygon points={pts} fill="none" stroke={boxCol} strokeWidth={1.5} />

            {/* Corner ticks */}
            {corners.map((corner, ci) => {
              const prev  = corners[(ci + 3) % 4];
              const next  = corners[(ci + 1) % 4];
              const tick  = 7;
              const toP   = { x: prev.x - corner.x, y: prev.y - corner.y };
              const toN   = { x: next.x - corner.x, y: next.y - corner.y };
              const lenP  = Math.hypot(toP.x, toP.y) || 1;
              const lenN  = Math.hypot(toN.x, toN.y) || 1;
              const p1    = { x: corner.x + (toP.x / lenP) * tick, y: corner.y + (toP.y / lenP) * tick };
              const p2    = { x: corner.x + (toN.x / lenN) * tick, y: corner.y + (toN.y / lenN) * tick };
              return (
                <g key={ci}>
                  <line x1={corner.x} y1={corner.y} x2={p1.x} y2={p1.y} stroke={boxCol} strokeWidth={2.5} />
                  <line x1={corner.x} y1={corner.y} x2={p2.x} y2={p2.y} stroke={boxCol} strokeWidth={2.5} />
                </g>
              );
            })}

            {/* Badge — anchored to first rotated corner */}
            <rect
              x={labelPt.x} y={labelPt.y - badgeH - 3}
              width={badgeW} height={badgeH}
              fill={boxCol} rx={2}
            />
            <text
              x={labelPt.x + badgeW / 2} y={labelPt.y - badgeH / 2 - 3 + 4}
              textAnchor="middle" fontSize={8} fill="#000"
              fontFamily="'Courier New',monospace" fontWeight={700}
            >
              T{tIdx + 1} · {Math.round(match.score * 100)}% · {rotLabel}
              {match.flipped ? '↔' : ''} #{idx + 1}
            </text>

            {/* Scale badge */}
            {showScale && (
              <>
                <rect x={vpCx - 18} y={vpCy - 8} width={36} height={14}
                  fill="rgba(0,0,0,0.7)" rx={2} />
                <text x={vpCx} y={vpCy + 3} textAnchor="middle" fontSize={7} fill={boxCol}
                  fontFamily="'Courier New',monospace" fontWeight={700}>
                  ×{scaleVal.toFixed(2)}
                </text>
              </>
            )}

            {/* Snap points */}
            {vpSnap.map((sp, j) => {
              const spCol = C.snap[sp.type] ?? '#fff';
              const r     = sp.type === 'centroid' ? 5 : sp.type === 'endpoint' ? 4 : 3;
              return (
                <g key={j}>
                  {sp.type === 'centroid' && (
                    <>
                      <line x1={sp.x - 8} y1={sp.y} x2={sp.x + 8} y2={sp.y}
                        stroke={spCol} strokeWidth={1} strokeOpacity={0.6} />
                      <line x1={sp.x} y1={sp.y - 8} x2={sp.x} y2={sp.y + 8}
                        stroke={spCol} strokeWidth={1} strokeOpacity={0.6} />
                    </>
                  )}
                  <circle cx={sp.x} cy={sp.y} r={r + 2} fill="none"
                    stroke={spCol} strokeWidth={0.8} strokeOpacity={0.4} />
                  <circle cx={sp.x} cy={sp.y} r={r} fill={spCol} fillOpacity={0.9} />
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
  const isCoarse    = workerPhase.toLowerCase().includes('coarse');
  const isFine      = workerPhase.toLowerCase().includes('fine');
  const isTextPhase = workerPhase.toLowerCase().includes('text');
  const phaseColor  = isTextPhase ? '#f59e0b' : isFine ? '#22c55e' : isCoarse ? '#38bdf8' : C.worker;

  return (
    <div style={{
      position:'absolute',top:48,left:'50%',transform:'translateX(-50%)',
      background:'rgba(13,13,13,0.96)',border:`1px solid ${phaseColor}44`,
      padding:'6px 14px',display:'flex',flexDirection:'column',
      alignItems:'center',gap:4,zIndex:50,pointerEvents:'none',minWidth:280,
    }}>
      <style>{`@keyframes cvspin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>
      <div style={{ display:'flex',alignItems:'center',gap:8 }}>
        <div style={{ width:10,height:10,border:'1.5px solid transparent',borderTopColor:phaseColor,borderRadius:'50%',animation:'cvspin .6s linear infinite',flexShrink:0 }} />
        <span style={{ fontSize:8,color:phaseColor,textTransform:'uppercase',letterSpacing:'.1em',fontFamily:"'Courier New',monospace" }}>
          {workerPhase || 'Working…'}
        </span>
      </div>
      {workerDetail && (
        <span style={{ fontSize:7,color:isTextPhase?'#f59e0b':'#888',textTransform:'uppercase',letterSpacing:'.07em',fontFamily:"'Courier New',monospace" }}>
          {workerDetail}
        </span>
      )}
    </div>
  );
}

// ─── Rubber-band overlay ──────────────────────────────────────────────────────

interface DrawBox { x: number; y: number; w: number; h: number }

interface CVRubberBandProps {
  isDrawing:   boolean;
  drawBox:     DrawBox | null;
  tooLarge:    boolean;
  isSearching: boolean;
  workerPhase: string;
  workerDetail:string;
  /** Colour for the band — defaults to sky blue (primary) */
  bandColor?:  string;
}

export function CVRubberBand({ isDrawing, drawBox, tooLarge, bandColor }: CVRubberBandProps) {
  if (!isDrawing || !drawBox) return null;
  const col = tooLarge ? '#f43f5e' : (bandColor ?? C.rubberBand);
  return (
    <svg style={{ position:'absolute',inset:0,pointerEvents:'none',zIndex:35,overflow:'visible' }} width="100%" height="100%">
      <defs>
        <pattern id="cv-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke={col} strokeWidth="1" strokeOpacity="0.25" />
        </pattern>
      </defs>
      <rect x={drawBox.x} y={drawBox.y} width={drawBox.w} height={drawBox.h}
        fill="url(#cv-hatch)" stroke={col} strokeWidth={1.5} strokeDasharray={tooLarge ? '6 3' : '5 3'} />
      {[[drawBox.x,drawBox.y],[drawBox.x+drawBox.w,drawBox.y],[drawBox.x,drawBox.y+drawBox.h],[drawBox.x+drawBox.w,drawBox.y+drawBox.h]].map(([cx,cy],i) => (
        <g key={i}>
          <line x1={cx-5} y1={cy} x2={cx+5} y2={cy} stroke={col} strokeWidth={1.5}/>
          <line x1={cx} y1={cy-5} x2={cx} y2={cy+5} stroke={col} strokeWidth={1.5}/>
        </g>
      ))}
      <text x={drawBox.x+drawBox.w/2} y={drawBox.y-6} textAnchor="middle" fill={col} fontSize={9} fontFamily="'Courier New',monospace">
        {tooLarge ? 'Zoom in — box too large' : `${drawBox.w.toFixed(0)} × ${drawBox.h.toFixed(0)} vp`}
      </text>
    </svg>
  );
}

// ─── Sidebar helpers ──────────────────────────────────────────────────────────

function TRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display:'flex',justifyContent:'space-between',marginBottom:3 }}>
      <span style={{ fontSize:7,color:'#555',textTransform:'uppercase',letterSpacing:'.07em' }}>{label}</span>
      <span style={{ fontSize:8,color:'#e5e5e5',fontWeight:700 }}>{value}</span>
    </div>
  );
}

function tbBtn(active: boolean, colour?: string): React.CSSProperties {
  const c = colour ?? '#38bdf8';
  return {
    fontSize:8,textTransform:'uppercase',letterSpacing:'.07em',
    border:`1px solid ${active?c:'#2a2a2a'}`,
    background:active?`${c}12`:'transparent',
    color:active?c:'#777',
    padding:'3px 7px',cursor:'pointer',fontFamily:'inherit',
    whiteSpace:'nowrap',flexShrink:0,
  };
}

// ─── Template thumbnail ───────────────────────────────────────────────────────

function TemplateThumbnail({ crop, size = 48 }: { crop: ImageData; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const scale  = Math.min(size / crop.width, size / crop.height, 1);
    canvas.width  = Math.round(crop.width  * scale);
    canvas.height = Math.round(crop.height * scale);
    const ctx = canvas.getContext('2d')!;
    const tmp = document.createElement('canvas');
    tmp.width = crop.width; tmp.height = crop.height;
    tmp.getContext('2d')!.putImageData(crop, 0, 0);
    ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
  }, [crop, size]);
  return (
    <canvas ref={ref} style={{ display:'block',background:'#fff',imageRendering:'pixelated',flexShrink:0 }} />
  );
}

// ─── Worker log ───────────────────────────────────────────────────────────────

interface WorkerLogEntry { ts: number; phase: string; detail: string }

// ─── Presets ──────────────────────────────────────────────────────────────────

const SCALE_PRESETS = [0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3];
const PRESET_ROTS   = [0, 45, 90, 135, 180, 225, 270, 315];

// ─── Sidebar ──────────────────────────────────────────────────────────────────

type SamplerMode = 'idle' | 'drawing' | 'adding' | 'matched';

interface CVSamplerSidebarProps {
  matcher:        UseOpenCVMatcherReturn;
  samplerMode:    SamplerMode;
  onEnterDraw:    () => void;
  onEnterAdd:     () => void;      // draw a new variation without clearing
  onClear:        () => void;
  onRemoveTemplate:(index: number) => void;
  threshold:      number;
  onThreshold:    (v: number) => void;
  rotations:      number[];
  onRotations:    (v: number[]) => void;
  flips:          boolean[];
  onFlips:        (v: boolean[]) => void;
  removeText:     boolean;
  onRemoveText:   (v: boolean) => void;
  scales:         number[];
  onScales:       (v: number[]) => void;
  fineStep:       number;
  onFineStep:     (v: number) => void;
}

export function CVSamplerSidebar({
  matcher, samplerMode, onEnterDraw, onEnterAdd, onClear, onRemoveTemplate,
  threshold, onThreshold,
  rotations, onRotations,
  flips, onFlips,
  removeText, onRemoveText,
  scales, onScales,
  fineStep, onFineStep,
}: CVSamplerSidebarProps) {
  const COL    = '#38bdf8';
  const SNAP_C = { endpoint: '#f59e0b', midpoint: '#10b981', centroid: '#8b5cf6' };

  // Worker log
  const [log, setLog] = useState<WorkerLogEntry[]>([]);
  useEffect(() => {
    if (!matcher.workerPhase) return;
    setLog(prev => {
      const last = prev[prev.length - 1];
      if (last && last.phase === matcher.workerPhase && last.detail === matcher.workerDetail) return prev;
      return [...prev.slice(-9), { ts: Date.now(), phase: matcher.workerPhase, detail: matcher.workerDetail }];
    });
  }, [matcher.workerPhase, matcher.workerDetail]);
  useEffect(() => { if (matcher.isSearching) setLog([]); }, [matcher.isSearching]);

  const sortedRots  = rotations.slice().sort((a, b) => a - b);
  const coarseStep  = sortedRots.length > 1 ? sortedRots[1] - sortedRots[0] : 45;
  const halfRange   = coarseStep / 2;
  const fineAnglesN = Math.round(halfRange * 2 / fineStep) + 1;
  const totalCoarse = rotations.length * flips.length * scales.length;
  const finePerCand = fineAnglesN * flips.length * scales.length;

  // Per-template match counts
  const tmplMatchCount = matcher.templates.map((_, ti) =>
    matcher.matches.filter(m => m.templateIndex === ti).length
  );

  const hasTemplates   = matcher.templates.length > 0;
  const isDrawing      = samplerMode === 'drawing';
  const isAdding       = samplerMode === 'adding';
  const isMatched      = samplerMode === 'matched';
  const canAddMore     = isMatched && !matcher.isSearching;

  return (
    <>
      {/* ── Header ── */}
      <div style={{ padding:'8px 10px',borderBottom:'1px solid #1a1a1a',flexShrink:0 }}>
        <div style={{ fontSize:8,color:'#3a3a3a',textTransform:'uppercase',letterSpacing:'.1em',marginBottom:8 }}>
          CV Match · Multi-Template
        </div>

        {/* Ready indicator */}
        <div style={{ display:'flex',alignItems:'center',gap:6,marginBottom:10,background:'rgba(56,189,248,0.06)',border:'1px solid #38bdf822',padding:'4px 8px' }}>
          <div style={{ width:7,height:7,borderRadius:'50%',background:matcher.isReady?'#22c55e':'#f59e0b',flexShrink:0 }} />
          <span style={{ fontSize:7,color:matcher.isReady?'#22c55e':'#f59e0b',textTransform:'uppercase',letterSpacing:'.07em' }}>
            {matcher.isReady ? 'OpenCV ready' : 'Loading…'}
          </span>
        </div>

        {/* Action buttons */}
        <div style={{ display:'flex',gap:4,flexWrap:'wrap' as const }}>
          {(samplerMode === 'idle' || samplerMode === 'matched') && (
            <button onClick={onEnterDraw} style={{ ...tbBtn(isDrawing, COL), flex:1 }}>
              ⊡ {hasTemplates ? 'Replace Primary' : 'Draw Sample'}
            </button>
          )}
          {(isDrawing || isAdding) && (
            <div style={{ fontSize:7,color:isAdding ? templateColor(matcher.templates.length) : COL,
              textTransform:'uppercase',letterSpacing:'.07em',padding:'3px 0',lineHeight:1.8 }}>
              {isAdding
                ? `Drag box for Variation ${matcher.templates.length}`
                : 'Drag tight box around ONE symbol'}
            </div>
          )}
          {isMatched && (
            <>
              {canAddMore && (
                <button
                  onClick={onEnterAdd}
                  style={{ ...tbBtn(true, templateColor(matcher.templates.length)), flex:1 }}
                  title="Draw another sample for a missed variation"
                >
                  + Add Variation
                </button>
              )}
              <button onClick={onClear} style={{ ...tbBtn(false), padding:'3px 7px' }}>✕ Clear All</button>
            </>
          )}
        </div>
      </div>

      {/* ── Templates list ── */}
      {matcher.templates.length > 0 && (
        <div style={{ padding:'6px 10px',borderBottom:'1px solid #1a1a1a',flexShrink:0 }}>
          <div style={{ fontSize:7,color:'#333',textTransform:'uppercase',letterSpacing:'.08em',marginBottom:6 }}>
            Templates ({matcher.templates.length})
          </div>
          {matcher.templates.map((t, ti) => {
            const col   = templateColor(ti);
            const count = tmplMatchCount[ti] ?? 0;
            return (
              <div key={ti} style={{ display:'flex',alignItems:'center',gap:6,marginBottom:5,background:'#0a0a0a',border:`1px solid ${col}33`,padding:'4px 6px' }}>
                {/* Colour swatch */}
                <div style={{ width:8,height:8,borderRadius:1,background:col,flexShrink:0 }} />
                {/* Thumbnail */}
                <div style={{ border:`1px solid ${col}44`,overflow:'hidden',flexShrink:0 }}>
                  <TemplateThumbnail crop={t.imageData} size={36} />
                </div>
                {/* Label + size + match count */}
                <div style={{ flex:1,minWidth:0 }}>
                  <div style={{ fontSize:7,color:col,textTransform:'uppercase',letterSpacing:'.07em',marginBottom:1 }}>
                    T{ti+1} · {t.label}
                  </div>
                  <div style={{ fontSize:6,color:'#333',letterSpacing:'.05em' }}>
                    {t.imageData.width}×{t.imageData.height}px
                  </div>
                  {isMatched && (
                    <div style={{ fontSize:7,color:count > 0 ? col : '#333',fontWeight:700,letterSpacing:'.05em' }}>
                      {count} match{count !== 1 ? 'es' : ''}
                    </div>
                  )}
                </div>
                {/* Remove */}
                <button
                  onClick={() => onRemoveTemplate(ti)}
                  title="Remove this template"
                  style={{ background:'transparent',border:'1px solid #2a2a2a',color:'#444',fontSize:10,cursor:'pointer',padding:'1px 4px',fontFamily:'inherit',flexShrink:0 }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Settings ── */}
      <div style={{ padding:'6px 10px',borderBottom:'1px solid #1a1a1a',flexShrink:0 }}>
        <div style={{ fontSize:7,color:'#333',textTransform:'uppercase',letterSpacing:'.08em',marginBottom:6 }}>Settings</div>

        {/* Threshold */}
        <div style={{ display:'flex',alignItems:'center',gap:6,marginBottom:6 }}>
          <span style={{ fontSize:7,color:'#555',textTransform:'uppercase',letterSpacing:'.06em',minWidth:56 }}>Threshold</span>
          <input type="range" min={40} max={98} step={1} value={Math.round(threshold * 100)}
            onChange={e => onThreshold(+e.target.value / 100)} style={{ flex:1,accentColor:COL }} />
          <span style={{ fontSize:8,color:COL,minWidth:28 }}>{Math.round(threshold * 100)}%</span>
        </div>
        <div style={{ fontSize:6,color:'#2a2a2a',marginBottom:8,letterSpacing:'.05em',lineHeight:1.6 }}>
          Final threshold · coarse uses −18% automatically.
        </div>

        {/* Rotations */}
        <div style={{ marginBottom:8 }}>
          <div style={{ display:'flex',alignItems:'center',gap:4,marginBottom:4 }}>
            <span style={{ fontSize:7,color:'#555',textTransform:'uppercase',letterSpacing:'.06em',minWidth:56 }}>Coarse rots</span>
            <button onClick={() => onRotations(PRESET_ROTS)} style={{ fontSize:6,padding:'1px 4px',cursor:'pointer',border:'1px solid #2a2a2a',background:'transparent',color:'#444',fontFamily:'inherit',textTransform:'uppercase' }}>all</button>
            <button onClick={() => onRotations([0])}         style={{ fontSize:6,padding:'1px 4px',cursor:'pointer',border:'1px solid #2a2a2a',background:'transparent',color:'#444',fontFamily:'inherit',textTransform:'uppercase' }}>0°</button>
          </div>
          <div style={{ display:'flex',gap:3,flexWrap:'wrap' as const }}>
            {PRESET_ROTS.map(deg => {
              const on = rotations.includes(deg);
              return (
                <button key={deg}
                  onClick={() => onRotations(on ? rotations.filter(r => r !== deg) : [...rotations, deg].sort((a,b)=>a-b))}
                  style={{ fontSize:7,padding:'2px 5px',cursor:'pointer',
                    border:`1px solid ${on?COL:'#2a2a2a'}`,
                    background:on?`${COL}15`:'transparent',
                    color:on?COL:'#444',
                    fontFamily:'inherit',textTransform:'uppercase' }}>
                  {deg}°
                </button>
              );
            })}
          </div>
          <div style={{ fontSize:6,color:'#2a2a2a',marginTop:4,letterSpacing:'.05em' }}>
            Coarse step: {coarseStep}° · fine range: ±{halfRange}°
          </div>
        </div>

        {/* Fine step */}
        <div style={{ marginBottom:8,background:'rgba(34,197,94,0.04)',border:'1px solid #22c55e18',padding:'6px 8px' }}>
          <div style={{ display:'flex',alignItems:'center',gap:6,marginBottom:4 }}>
            <span style={{ fontSize:7,color:'#22c55e',textTransform:'uppercase',letterSpacing:'.06em',minWidth:56 }}>Fine step</span>
            <input type="range" min={1} max={15} step={1} value={fineStep}
              onChange={e => onFineStep(+e.target.value)} style={{ flex:1,accentColor:'#22c55e' }} />
            <span style={{ fontSize:8,color:'#22c55e',minWidth:28 }}>{fineStep}°</span>
          </div>
          <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center' }}>
            <div style={{ fontSize:6,color:'#2a2a2a',letterSpacing:'.05em' }}>
              {fineAnglesN} angles/cand · {fineStep <= 3 ? 'precise' : fineStep <= 7 ? 'balanced' : 'fast'}
            </div>
            <div style={{ display:'flex',gap:3 }}>
              {[1, 3, 5, 10].map(v => (
                <button key={v} onClick={() => onFineStep(v)} style={{
                  fontSize:6,padding:'1px 4px',cursor:'pointer',
                  border:`1px solid ${fineStep===v?'#22c55e':'#2a2a2a'}`,
                  background:fineStep===v?'rgba(34,197,94,0.1)':'transparent',
                  color:fineStep===v?'#22c55e':'#444',
                  fontFamily:'inherit',textTransform:'uppercase',
                }}>{v}°</button>
              ))}
            </div>
          </div>
        </div>

        {/* Scales */}
        <div style={{ marginBottom:8 }}>
          <div style={{ display:'flex',alignItems:'center',gap:4,marginBottom:4 }}>
            <span style={{ fontSize:7,color:'#555',textTransform:'uppercase',letterSpacing:'.06em',minWidth:56 }}>Scales</span>
            <button onClick={() => onScales(SCALE_PRESETS)} style={{ fontSize:6,padding:'1px 4px',cursor:'pointer',border:'1px solid #2a2a2a',background:'transparent',color:'#444',fontFamily:'inherit',textTransform:'uppercase' }}>all</button>
            <button onClick={() => onScales([1.0])}         style={{ fontSize:6,padding:'1px 4px',cursor:'pointer',border:'1px solid #2a2a2a',background:'transparent',color:'#444',fontFamily:'inherit',textTransform:'uppercase' }}>1×</button>
          </div>
          <div style={{ display:'flex',gap:3,flexWrap:'wrap' as const }}>
            {SCALE_PRESETS.map(s => {
              const on = scales.includes(s);
              return (
                <button key={s}
                  onClick={() => onScales(on ? scales.filter(x => x !== s) : [...scales, s].sort((a,b)=>a-b))}
                  style={{ fontSize:7,padding:'2px 5px',cursor:'pointer',
                    border:`1px solid ${on?COL:'#2a2a2a'}`,
                    background:on?`${COL}15`:'transparent',
                    color:on?COL:'#444',
                    fontFamily:'inherit',textTransform:'uppercase' }}>
                  ×{s.toFixed(1)}
                </button>
              );
            })}
          </div>
        </div>

        {/* Mirror */}
        <div style={{ display:'flex',alignItems:'center',gap:4,marginBottom:8 }}>
          <span style={{ fontSize:7,color:'#555',textTransform:'uppercase',letterSpacing:'.06em',minWidth:56 }}>Mirror</span>
          {([false, true] as const).map(f => {
            const on  = flips.includes(f);
            const lbl = f ? '↔ flip' : 'normal';
            return (
              <button key={String(f)}
                onClick={() => onFlips(on ? flips.filter(x => x !== f) : [...flips, f])}
                style={{ fontSize:7,padding:'2px 5px',cursor:'pointer',
                  border:`1px solid ${on?COL:'#2a2a2a'}`,
                  background:on?`${COL}15`:'transparent',
                  color:on?COL:'#444',
                  fontFamily:'inherit',textTransform:'uppercase' }}>
                {lbl}
              </button>
            );
          })}
        </div>

        {/* Remove text */}
        <div style={{ display:'flex',alignItems:'center',gap:4,marginBottom:8 }}>
          <span style={{ fontSize:7,color:'#555',textTransform:'uppercase',letterSpacing:'.06em',minWidth:56 }}>Text</span>
          <button
            onClick={() => onRemoveText(!removeText)}
            style={{ fontSize:7,padding:'2px 5px',cursor:'pointer',
              border:`1px solid ${removeText?'#f43f5e':'#2a2a2a'}`,
              background:removeText?'rgba(244,63,94,0.1)':'transparent',
              color:removeText?'#f43f5e':'#444',
              fontFamily:'inherit',textTransform:'uppercase' }}>
            {removeText ? '✕ strip text' : '· keep text'}
          </button>
          <span style={{ fontSize:7,color:'#2a2a2a',letterSpacing:'.04em' }}>
            {removeText ? 'ignores labels' : 'exact match'}
          </span>
        </div>

        {/* Pass count summary */}
        <div style={{ padding:'4px 6px',background:'#0a0a0a',border:'1px solid #1a1a1a',fontSize:7,color:'#3a3a3a',letterSpacing:'.05em',lineHeight:1.8 }}>
          <div>Templates: <span style={{ color:'#555' }}>{matcher.templates.length}</span></div>
          <div>Stage 1: <span style={{ color:'#555' }}>{totalCoarse} coarse pass{totalCoarse!==1?'es':''} / tmpl</span></div>
          <div>Stage 2: <span style={{ color:'#22c55e' }}>{finePerCand} fine passes / candidate</span></div>
          {totalCoarse > 16 && <div style={{ color:'#f59e0b' }}>⚠ many coarse passes — may be slow</div>}
        </div>
      </div>

      {/* ── Worker log ── */}
      <div style={{ padding:'6px 10px',borderBottom:'1px solid #1a1a1a',flexShrink:0 }}>
        <div style={{ display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:4 }}>
          <div style={{ fontSize:7,color:'#333',textTransform:'uppercase',letterSpacing:'.08em' }}>Worker log</div>
          {matcher.isSearching && (
            <div style={{ display:'flex',alignItems:'center',gap:4 }}>
              <style>{`@keyframes cvspin2{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>
              <div style={{ width:6,height:6,border:'1px solid transparent',borderTopColor:C.worker,borderRadius:'50%',animation:'cvspin2 .5s linear infinite' }} />
              <span style={{ fontSize:7,color:C.worker,textTransform:'uppercase',letterSpacing:'.06em' }}>running</span>
            </div>
          )}
        </div>
        {matcher.workerPhase && (
          <div style={{ background:'#0a0a0a',border:`1px solid ${C.worker}22`,padding:'3px 6px',marginBottom:4 }}>
            <div style={{ fontSize:7,color:C.worker,letterSpacing:'.06em',textTransform:'uppercase' }}>{matcher.workerPhase}</div>
            {matcher.workerDetail && (
              <div style={{ fontSize:7,color:'#f59e0b',letterSpacing:'.05em',marginTop:2 }}>{matcher.workerDetail}</div>
            )}
          </div>
        )}
        <div style={{ maxHeight:70,overflowY:'auto' }}>
          {log.map((entry, i) => {
            const isCoarse = entry.phase.toLowerCase().includes('coarse');
            const isFine   = entry.phase.toLowerCase().includes('fine');
            const isText   = entry.phase.toLowerCase().includes('text');
            const col      = isText ? '#f59e0b' : isFine ? '#22c55e' : isCoarse ? '#38bdf8' : '#3a3a3a';
            const isLast   = i === log.length - 1;
            return (
              <div key={entry.ts} style={{ display:'flex',alignItems:'baseline',gap:4,marginBottom:1,opacity:isLast?1:0.4 }}>
                <span style={{ fontSize:6,color:col,flexShrink:0 }}>›</span>
                <span style={{ fontSize:6,color:col,textTransform:'uppercase',letterSpacing:'.04em',lineHeight:1.6 }}>
                  {entry.phase}{entry.detail ? ` · ${entry.detail}` : ''}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Results list ── */}
      <div style={{ flex:1,overflowY:'auto',padding:6 }}>
        {matcher.isSearching && (
          <p style={{ fontSize:8,color:'#555',textAlign:'center',textTransform:'uppercase',letterSpacing:'.08em',padding:'20px 0',lineHeight:2.2 }}>
            Running coarse→fine…<br />
            <span style={{ color:'#22c55e' }}>Stage 2 refines each hit</span>
          </p>
        )}
        {!matcher.isSearching && samplerMode === 'matched' && matcher.matches.length === 0 && (
          <p style={{ fontSize:8,color:'#2a2a2a',textAlign:'center',textTransform:'uppercase',letterSpacing:'.08em',padding:'20px 8px',lineHeight:2.2 }}>
            No matches at {Math.round(threshold * 100)}%.<br />
            Try "+ Add Variation" to draw<br />the missed symbol variant.
          </p>
        )}
        {!matcher.isSearching && matcher.matches.length > 0 && (
          <>
            <div style={{ fontSize:7,color:'#333',textTransform:'uppercase',letterSpacing:'.08em',marginBottom:6,padding:'2px 4px',display:'flex',justifyContent:'space-between',alignItems:'center' }}>
              <span>{matcher.matches.length} total match{matcher.matches.length !== 1 ? 'es' : ''}</span>
              <span style={{ fontSize:6,color:'#2a2a2a' }}>
                {matcher.templates.map((_, ti) => `T${ti+1}:${tmplMatchCount[ti]??0}`).join(' · ')}
              </span>
            </div>
            {matcher.matches.map((match, i) => {
              const tIdx     = match.templateIndex ?? 0;
              const col      = templateColor(tIdx);
              const rotLabel = Number.isInteger(match.rotation)
                ? `${match.rotation}°`
                : `${match.rotation.toFixed(1)}°`;
              return (
                <div key={match.id} style={{ border:`1px solid ${col}33`,padding:'6px 8px',marginBottom:4,background:'#0a0a0a' }}>
                  <div style={{ display:'flex',alignItems:'center',gap:6,marginBottom:4 }}>
                    <div style={{ width:8,height:8,borderRadius:1,background:col,flexShrink:0 }} />
                    <span style={{ fontSize:7,color:'#555',textTransform:'uppercase',letterSpacing:'.05em' }}>T{tIdx+1}</span>
                    <span style={{ fontSize:8,color:'#888',textTransform:'uppercase',letterSpacing:'.05em',flex:1 }}>Match {i+1}</span>
                    <span style={{ fontSize:8,color:col,fontWeight:700 }}>{Math.round(match.score*100)}%</span>
                  </div>
                  <div style={{ paddingLeft:14 }}>
                    <TRow label="Centre"   value={`${match.cx.toFixed(0)}, ${match.cy.toFixed(0)}`} />
                    <TRow label="Size"     value={`${match.tmplW} × ${match.tmplH} px`} />
                    <TRow label="Scale"    value={`×${(isFinite(match.scale)?match.scale:1).toFixed(2)}`} />
                    <TRow label="Rotation" value={`${rotLabel}${match.flipped?' ↔':''}`} />
                    <div style={{ display:'flex',gap:6,marginTop:4 }}>
                      {(['endpoint','midpoint','centroid'] as const).map(type => {
                        const count = match.snapPoints.filter(s => s.type === type).length;
                        if (!count) return null;
                        return (
                          <div key={type} style={{ display:'flex',alignItems:'center',gap:3 }}>
                            <div style={{ width:6,height:6,borderRadius:'50%',background:SNAP_C[type] }} />
                            <span style={{ fontSize:7,color:'#444' }}>{count}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })}
          </>
        )}
        {samplerMode === 'idle' && (
          <p style={{ fontSize:8,color:'#2a2a2a',textAlign:'center',textTransform:'uppercase',letterSpacing:'.08em',padding:'28px 8px',lineHeight:2.2 }}>
            Draw a sample box around<br />any symbol — then add<br />variations for missed instances
          </p>
        )}
      </div>
    </>
  );
}

// ─── Rubber-band draw hook ────────────────────────────────────────────────────

const MAX_BOX_VP_FRAC = 0.35;

export function useCVRubberBand(
  viewportRef: React.RefObject<HTMLDivElement | null>,
  enabled:     boolean,
  onCommit:    (box: { x: number; y: number; w: number; h: number }) => void,
) {
  const [drawBox,   setDrawBox]   = useState<{ x:number;y:number;w:number;h:number }|null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [tooLarge,  setTooLarge]  = useState(false);
  const startRef  = useRef<{ x:number; y:number }|null>(null);
  const activeRef = useRef(false);

  const isTooLarge = useCallback((box: { w:number; h:number }): boolean => {
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
      const vr  = vp.getBoundingClientRect();
      const box = {
        x: Math.min(startRef.current.x, e.clientX - vr.left),
        y: Math.min(startRef.current.y, e.clientY - vr.top),
        w: Math.abs(e.clientX - vr.left - startRef.current.x),
        h: Math.abs(e.clientY - vr.top  - startRef.current.y),
      };
      setDrawBox(box); setTooLarge(isTooLarge(box));
    };
    const onUp = (e: PointerEvent) => {
      if (!activeRef.current || !startRef.current) return;
      const vr  = vp.getBoundingClientRect();
      const box = {
        x: Math.min(startRef.current.x, e.clientX - vr.left),
        y: Math.min(startRef.current.y, e.clientY - vr.top),
        w: Math.abs(e.clientX - vr.left - startRef.current.x),
        h: Math.abs(e.clientY - vr.top  - startRef.current.y),
      };
      activeRef.current = false; setIsDrawing(false); setDrawBox(null); setTooLarge(false); startRef.current = null;
      if (box.w > 5 && box.h > 5 && !isTooLarge(box)) onCommit(box);
    };
    vp.addEventListener('pointermove', onMove);
    vp.addEventListener('pointerup',   onUp);
    return () => { vp.removeEventListener('pointermove', onMove); vp.removeEventListener('pointerup', onUp); };
  }, [enabled, viewportRef, onCommit, isTooLarge]);

  return { drawBox, isDrawing, tooLarge, startDraw };
}
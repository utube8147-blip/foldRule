/**
 * CVMatchOverlay.tsx  v6.0
 * ─────────────────────────
 * Visual overlay + sidebar for two-stage coarse→fine template match results.
 *
 * v6.0 changes over v5.0:
 *  ─ CVSamplerSidebarProps gains fineStep / onFineStep.
 *  ─ Fine Step slider added to Settings section (1°–15°, default 3°).
 *  ─ Pass count summary updated to reflect two-stage logic.
 *  ─ Worker log colours updated for new phase names (Coarse N/M, Fine N/M).
 *  ─ Match cards show refined rotation (decimal degrees from fine sweep).
 *  ─ All v5.0 features retained (corner ticks, snap points, template preview, log).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CVMatchResult, UseOpenCVMatcherReturn } from '@/hooks/detection/useOpenCVMatcher';

// ─── Colour helpers ───────────────────────────────────────────────────────────

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

function scoreColor(score: number): string {
  const t = Math.max(0, Math.min(1, (score - 0.5) / 0.5));
  const h = Math.round(t * 120);
  return `hsl(${h},90%,55%)`;
}

// ─── Coord helpers ────────────────────────────────────────────────────────────

function toVP(canvasX: number, canvasY: number, zoom: number, pan: { x: number; y: number }) {
  return { x: canvasX * zoom + pan.x, y: canvasY * zoom + pan.y };
}

function matchVPCorners(
  match: CVMatchResult,
  zoom:  number,
  pan:   { x: number; y: number },
): Array<{ x: number; y: number }> {
  const { bbox } = match;
  const rW = isFinite((match as any).rotatedW) ? (match as any).rotatedW : bbox.w;
  const rH = isFinite((match as any).rotatedH) ? (match as any).rotatedH : bbox.h;

  if (!isFinite(bbox.x) || !isFinite(bbox.y) || !isFinite(rW) || !isFinite(rH)) {
    const px = isFinite(bbox.x) ? bbox.x : 0;
    const py = isFinite(bbox.y) ? bbox.y : 0;
    return [px, px+1, px+1, px].map((x, i) => toVP(x, i < 2 ? py : py+1, zoom, pan));
  }

  const x0 = bbox.x, y0 = bbox.y, x1 = bbox.x + rW, y1 = bbox.y + rH;
  return [
    toVP(x0, y0, zoom, pan),
    toVP(x1, y0, zoom, pan),
    toVP(x1, y1, zoom, pan),
    toVP(x0, y1, zoom, pan),
  ];
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
      width="100%"
      height="100%"
    >
      <defs>
        <filter id="cv-glow">
          <feGaussianBlur stdDeviation="1.5" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <pattern id="cv-match-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="8" stroke={C.matchBox} strokeWidth="0.8" strokeOpacity="0.15" />
        </pattern>
      </defs>

      {matches.map((match, idx) => {
        const safe      = (n: number) => (isFinite(n) ? n : 0);
        const vpCorners = matchVPCorners(match, zoom, pan).map(p => ({ x: safe(p.x), y: safe(p.y) }));
        const pts       = vpCorners.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
        const labelPt   = vpCorners[0];
        const vpCx      = vpCorners.reduce((s, p) => s + p.x, 0) / 4;
        const vpCy      = vpCorners.reduce((s, p) => s + p.y, 0) / 4;
        const col       = scoreColor(match.score);
        const scaleVal  = isFinite(match.scale) ? match.scale : 1;
        const showScale = Math.abs(scaleVal - 1.0) > 0.01;
        const badgeW    = 110;
        const badgeH    = 16;
        const rotLabel  = Number.isInteger(match.rotation)
          ? `${match.rotation}°`
          : `${match.rotation.toFixed(1)}°`;

        const vpSnap = [
          { x: vpCx, y: vpCy, type: 'centroid' as const },
          ...vpCorners.map(p => ({ x: p.x, y: p.y, type: 'endpoint' as const })),
          ...([0, 1, 2, 3] as const).map(i => {
            const a = vpCorners[i], b = vpCorners[(i+1) % 4];
            return { x: (a.x+b.x)/2, y: (a.y+b.y)/2, type: 'midpoint' as const };
          }),
        ];

        return (
          <g key={match.id} filter="url(#cv-glow)">
            <polygon points={pts} fill="url(#cv-match-hatch)" />
            <polygon points={pts} fill="none" stroke={col} strokeWidth={1.5} />

            {/* Corner ticks */}
            {vpCorners.map((corner, ci) => {
              const prev   = vpCorners[(ci+3)%4];
              const next   = vpCorners[(ci+1)%4];
              const tick   = 6;
              const toPrev = { x: prev.x-corner.x, y: prev.y-corner.y };
              const toNext = { x: next.x-corner.x, y: next.y-corner.y };
              const lenP   = Math.hypot(toPrev.x, toPrev.y) || 1;
              const lenN   = Math.hypot(toNext.x, toNext.y) || 1;
              const p1     = { x: corner.x+(toPrev.x/lenP)*tick, y: corner.y+(toPrev.y/lenP)*tick };
              const p2     = { x: corner.x+(toNext.x/lenN)*tick, y: corner.y+(toNext.y/lenN)*tick };
              return (
                <g key={ci}>
                  <line x1={corner.x} y1={corner.y} x2={p1.x} y2={p1.y} stroke={col} strokeWidth={2} />
                  <line x1={corner.x} y1={corner.y} x2={p2.x} y2={p2.y} stroke={col} strokeWidth={2} />
                </g>
              );
            })}

            {/* Score / rotation / index badge */}
            <rect x={labelPt.x} y={labelPt.y-badgeH-2} width={badgeW} height={badgeH} fill={col} rx={2} />
            <text
              x={labelPt.x+badgeW/2} y={labelPt.y-badgeH/2-2+4}
              textAnchor="middle" fontSize={8} fill="#000"
              fontFamily="'Courier New',monospace" fontWeight={700}
            >
              {Math.round(match.score*100)}% · {rotLabel}{match.flipped ? '↔' : ''} #{idx+1}
            </text>

            {/* Scale badge */}
            {showScale && (
              <>
                <rect x={vpCx-18} y={vpCy-8} width={36} height={14} fill="rgba(0,0,0,0.7)" rx={2} />
                <text x={vpCx} y={vpCy+3} textAnchor="middle" fontSize={7} fill={col}
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
                      <line x1={sp.x-8} y1={sp.y} x2={sp.x+8} y2={sp.y} stroke={spCol} strokeWidth={1} strokeOpacity={0.6} />
                      <line x1={sp.x} y1={sp.y-8} x2={sp.x} y2={sp.y+8} stroke={spCol} strokeWidth={1} strokeOpacity={0.6} />
                    </>
                  )}
                  <circle cx={sp.x} cy={sp.y} r={r+2} fill="none" stroke={spCol} strokeWidth={0.8} strokeOpacity={0.4} />
                  <circle cx={sp.x} cy={sp.y} r={r}   fill={spCol} fillOpacity={0.9} />
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
  const isTextPhase = workerPhase.toLowerCase().includes('text') || workerDetail.toLowerCase().includes('text');
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

// ─── Template preview ─────────────────────────────────────────────────────────

function TemplatePreview({ crop, label, labelColor }: { crop: ImageData; label: string; labelColor: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const maxDim = 100;
    const scale  = Math.min(maxDim/crop.width, maxDim/crop.height, 1);
    canvas.width  = Math.round(crop.width  * scale);
    canvas.height = Math.round(crop.height * scale);
    const ctx = canvas.getContext('2d')!;
    const tmp = document.createElement('canvas');
    tmp.width  = crop.width; tmp.height = crop.height;
    tmp.getContext('2d')!.putImageData(crop, 0, 0);
    ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
  }, [crop]);
  return (
    <div style={{ display:'flex',flexDirection:'column',gap:3,flex:1 }}>
      <div style={{ fontSize:6,color:labelColor,textTransform:'uppercase',letterSpacing:'.08em' }}>{label}</div>
      <canvas ref={ref} style={{ display:'block',border:`1px solid ${labelColor}44`,background:'#fff',maxWidth:'100%',imageRendering:'pixelated' }} />
      <div style={{ fontSize:6,color:'#333' }}>{crop.width}×{crop.height}px</div>
    </div>
  );
}

// ─── Worker log ───────────────────────────────────────────────────────────────

interface WorkerLogEntry { ts: number; phase: string; detail: string }

// ─── Presets ──────────────────────────────────────────────────────────────────

const SCALE_PRESETS = [0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3];
const PRESET_ROTS   = [0, 45, 90, 135, 180, 225, 270, 315];

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
  scales:       number[];
  onScales:     (v: number[]) => void;
  fineStep:     number;       // ← NEW v6.0
  onFineStep:   (v: number) => void;  // ← NEW v6.0
}

export function CVSamplerSidebar({
  matcher, samplerMode, onEnterDraw, onClear,
  threshold, onThreshold,
  rotations, onRotations,
  flips, onFlips,
  removeText, onRemoveText,
  scales, onScales,
  fineStep, onFineStep,
}: CVSamplerSidebarProps) {
  const COL    = '#38bdf8';
  const SNAP_C = { endpoint: '#f59e0b', midpoint: '#10b981', centroid: '#8b5cf6' };

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
      const last = prev[prev.length-1];
      if (last && last.phase === matcher.workerPhase && last.detail === matcher.workerDetail) return prev;
      return [...prev.slice(-9), { ts: Date.now(), phase: matcher.workerPhase, detail: matcher.workerDetail }];
    });
  }, [matcher.workerPhase, matcher.workerDetail]);
  useEffect(() => { if (matcher.isSearching) setLog([]); }, [matcher.isSearching]);

  // Compute coarse step for display
  const sortedRots  = rotations.slice().sort((a,b) => a-b);
  const coarseStep  = sortedRots.length > 1 ? sortedRots[1] - sortedRots[0] : 45;
  const halfRange   = coarseStep / 2;
  const fineAnglesN = Math.round(halfRange * 2 / fineStep) + 1;
  const totalCoarse = rotations.length * flips.length * scales.length;
  // Fine passes are per-candidate (unknown count), just show the per-candidate cost
  const finePerCand = fineAnglesN * flips.length * scales.length;

  return (
    <>
      {/* ── Header ── */}
      <div style={{ padding:'8px 10px',borderBottom:'1px solid #1a1a1a',flexShrink:0 }}>
        <div style={{ fontSize:8,color:'#3a3a3a',textTransform:'uppercase',letterSpacing:'.1em',marginBottom:8 }}>
          OpenCV Sampler · Coarse→Fine
        </div>

        {/* Ready indicator */}
        <div style={{ display:'flex',alignItems:'center',gap:6,marginBottom:10,background:'rgba(56,189,248,0.06)',border:'1px solid #38bdf822',padding:'4px 8px' }}>
          <div style={{ width:7,height:7,borderRadius:'50%',background:matcher.isReady?'#22c55e':'#f59e0b',flexShrink:0 }} />
          <span style={{ fontSize:7,color:matcher.isReady?'#22c55e':'#f59e0b',textTransform:'uppercase',letterSpacing:'.07em' }}>
            {matcher.isReady ? 'Worker · OpenCV ready' : 'Worker · Loading…'}
          </span>
        </div>

        {/* Steps */}
        {(['Draw','Match'] as const).map((step, i) => {
          const stepMode = ['drawing','matched'][i];
          const done     = i === 0 && samplerMode === 'matched';
          const active   = samplerMode === stepMode;
          return (
            <div key={step} style={{ display:'flex',alignItems:'center',gap:6,marginBottom:4 }}>
              <div style={{
                width:16,height:16,borderRadius:'50%',flexShrink:0,
                background:done?'#1a3a1a':active?'#1a2a3a':'#111',
                border:`1px solid ${done?'#22c55e':active?COL:'#2a2a2a'}`,
                display:'flex',alignItems:'center',justifyContent:'center',
                fontSize:8,color:done?'#22c55e':active?COL:'#333',
              }}>
                {done ? '✓' : i+1}
              </div>
              <span style={{ fontSize:8,color:active?'#ccc':done?'#555':'#2a2a2a',textTransform:'uppercase',letterSpacing:'.07em' }}>{step}</span>
            </div>
          );
        })}

        {/* Action buttons */}
        <div style={{ display:'flex',gap:4,marginTop:10,flexWrap:'wrap' as const }}>
          {samplerMode === 'idle' && (
            <button onClick={onEnterDraw} style={{ ...tbBtn(true, COL), flex:1 }}>⊡ Draw Sample</button>
          )}
          {samplerMode === 'drawing' && (
            <div style={{ fontSize:7,color:COL,textTransform:'uppercase',letterSpacing:'.07em',padding:'3px 0',lineHeight:1.8 }}>
              Drag a tight box around<br />ONE symbol on the canvas
            </div>
          )}
          {samplerMode === 'matched' && (
            <>
              <button onClick={onEnterDraw} style={{ ...tbBtn(false, COL), flex:1 }}>⊡ New Sample</button>
              <button onClick={onClear}     style={{ ...tbBtn(false), padding:'3px 7px' }}>✕</button>
            </>
          )}
        </div>
      </div>

      {/* ── Settings ── */}
      <div style={{ padding:'6px 10px',borderBottom:'1px solid #1a1a1a',flexShrink:0 }}>
        <div style={{ fontSize:7,color:'#333',textTransform:'uppercase',letterSpacing:'.08em',marginBottom:6 }}>Settings</div>

        {/* Threshold */}
        <div style={{ display:'flex',alignItems:'center',gap:6,marginBottom:6 }}>
          <span style={{ fontSize:7,color:'#555',textTransform:'uppercase',letterSpacing:'.06em',minWidth:56 }}>Threshold</span>
          <input type="range" min={40} max={98} step={1} value={Math.round(threshold*100)}
            onChange={e => onThreshold(+e.target.value/100)} style={{ flex:1,accentColor:COL }} />
          <span style={{ fontSize:8,color:COL,minWidth:28 }}>{Math.round(threshold*100)}%</span>
        </div>
        <div style={{ fontSize:6,color:'#2a2a2a',marginBottom:8,letterSpacing:'.05em',lineHeight:1.6 }}>
          Final threshold · coarse uses -{Math.round(18)}% automatically.
        </div>

        {/* Rotations */}
        <div style={{ marginBottom:8 }}>
          <div style={{ display:'flex',alignItems:'center',gap:4,marginBottom:4 }}>
            <span style={{ fontSize:7,color:'#555',textTransform:'uppercase',letterSpacing:'.06em',minWidth:56 }}>Coarse rots</span>
            <button onClick={() => onRotations(PRESET_ROTS)} style={{ fontSize:6,padding:'1px 4px',cursor:'pointer',border:'1px solid #2a2a2a',background:'transparent',color:'#444',fontFamily:'inherit',textTransform:'uppercase' }}>all</button>
            <button onClick={() => onRotations([0])}         style={{ fontSize:6,padding:'1px 4px',cursor:'pointer',border:'1px solid #2a2a2a',background:'transparent',color:'#444',fontFamily:'inherit',textTransform:'uppercase' }}>0° only</button>
          </div>
          <div style={{ display:'flex',gap:3,flexWrap:'wrap' as const }}>
            {PRESET_ROTS.map(deg => {
              const on = rotations.includes(deg);
              return (
                <button key={deg}
                  onClick={() => onRotations(on ? rotations.filter(r => r !== deg) : [...rotations, deg].sort((a,b)=>a-b))}
                  style={{
                    fontSize:7,padding:'2px 5px',cursor:'pointer',
                    border:`1px solid ${on?COL:'#2a2a2a'}`,
                    background:on?`${COL}15`:'transparent',
                    color:on?COL:'#444',
                    fontFamily:'inherit',textTransform:'uppercase',
                  }}>
                  {deg}°
                </button>
              );
            })}
          </div>
          <div style={{ fontSize:6,color:'#2a2a2a',marginTop:4,letterSpacing:'.05em',lineHeight:1.6 }}>
            Coarse step: {coarseStep}° · fine range: ±{halfRange}°
          </div>
        </div>

        {/* Fine step — NEW v6.0 */}
        <div style={{ marginBottom:8,background:'rgba(34,197,94,0.04)',border:'1px solid #22c55e18',padding:'6px 8px' }}>
          <div style={{ display:'flex',alignItems:'center',gap:6,marginBottom:4 }}>
            <span style={{ fontSize:7,color:'#22c55e',textTransform:'uppercase',letterSpacing:'.06em',minWidth:56 }}>Fine step</span>
            <input type="range" min={1} max={15} step={1} value={fineStep}
              onChange={e => onFineStep(+e.target.value)} style={{ flex:1,accentColor:'#22c55e' }} />
            <span style={{ fontSize:8,color:'#22c55e',minWidth:28 }}>{fineStep}°</span>
          </div>
          <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center' }}>
            <div style={{ fontSize:6,color:'#2a2a2a',letterSpacing:'.05em',lineHeight:1.6 }}>
              {fineAnglesN} angles/candidate · {fineStep <= 3 ? 'precise' : fineStep <= 7 ? 'balanced' : 'fast'}
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
            <button onClick={() => onScales([1.0])}         style={{ fontSize:6,padding:'1px 4px',cursor:'pointer',border:'1px solid #2a2a2a',background:'transparent',color:'#444',fontFamily:'inherit',textTransform:'uppercase' }}>1× only</button>
          </div>
          <div style={{ display:'flex',gap:3,flexWrap:'wrap' as const }}>
            {SCALE_PRESETS.map(s => {
              const on = scales.includes(s);
              return (
                <button key={s}
                  onClick={() => onScales(on ? scales.filter(x => x !== s) : [...scales, s].sort((a,b)=>a-b))}
                  style={{
                    fontSize:7,padding:'2px 5px',cursor:'pointer',
                    border:`1px solid ${on?COL:'#2a2a2a'}`,
                    background:on?`${COL}15`:'transparent',
                    color:on?COL:'#444',
                    fontFamily:'inherit',textTransform:'uppercase',
                  }}>
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
                style={{
                  fontSize:7,padding:'2px 5px',cursor:'pointer',
                  border:`1px solid ${on?COL:'#2a2a2a'}`,
                  background:on?`${COL}15`:'transparent',
                  color:on?COL:'#444',
                  fontFamily:'inherit',textTransform:'uppercase',
                }}>
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
            style={{
              fontSize:7,padding:'2px 5px',cursor:'pointer',
              border:`1px solid ${removeText?'#f43f5e':'#2a2a2a'}`,
              background:removeText?'rgba(244,63,94,0.1)':'transparent',
              color:removeText?'#f43f5e':'#444',
              fontFamily:'inherit',textTransform:'uppercase',
            }}>
            {removeText ? '✕ strip text' : '· keep text'}
          </button>
          <span style={{ fontSize:7,color:'#2a2a2a',letterSpacing:'.04em' }}>
            {removeText ? 'ignores labels' : 'exact match'}
          </span>
        </div>

        {/* Pass count summary */}
        <div style={{ marginTop:4,padding:'4px 6px',background:'#0a0a0a',border:'1px solid #1a1a1a',fontSize:7,color:'#3a3a3a',letterSpacing:'.05em',lineHeight:1.8 }}>
          <div>Stage 1: <span style={{ color:'#555' }}>{totalCoarse} coarse pass{totalCoarse!==1?'es':''}</span></div>
          <div>Stage 2: <span style={{ color:'#22c55e' }}>{finePerCand} fine passes/candidate</span></div>
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
              <div style={{ fontSize:7,color:matcher.workerDetail.startsWith('✓')?'#22c55e':'#f59e0b',letterSpacing:'.05em',marginTop:2 }}>
                {matcher.workerDetail}
              </div>
            )}
          </div>
        )}
        <div style={{ maxHeight:80,overflowY:'auto' }}>
          {log.map((entry, i) => {
            const isCoarse = entry.phase.toLowerCase().includes('coarse');
            const isFine   = entry.phase.toLowerCase().includes('fine');
            const isText   = entry.phase.toLowerCase().includes('text') || entry.detail.toLowerCase().includes('text');
            const col      = isText ? '#f59e0b' : isFine ? '#22c55e' : isCoarse ? '#38bdf8' : '#3a3a3a';
            const isLast   = i === log.length-1;
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

      {/* ── Template previews ── */}
      {matcher.rawTemplateCrop && (
        <div style={{ padding:'6px 10px',borderBottom:'1px solid #1a1a1a',flexShrink:0 }}>
          <div style={{ fontSize:7,color:'#333',textTransform:'uppercase',letterSpacing:'.08em',marginBottom:6 }}>Template preview</div>
          {hasCleanedVersion ? (
            <>
              <div style={{ display:'flex',gap:8,alignItems:'flex-start' }}>
                <TemplatePreview crop={matcher.rawTemplateCrop} label="Original"        labelColor="#555" />
                <TemplatePreview crop={matcher.templateCrop!}   label="Text stripped ✓" labelColor="#22c55e" />
              </div>
              <div style={{ marginTop:5,fontSize:6,color:'#2a2a2a',textTransform:'uppercase',letterSpacing:'.06em',lineHeight:1.8 }}>
                White areas = erased text · right image matched
              </div>
            </>
          ) : (
            <>
              <TemplatePreview
                crop={matcher.rawTemplateCrop}
                label={matcher.isSearching && removeText ? 'Original (stripping…)' : 'Original'}
                labelColor={matcher.isSearching && removeText ? '#f59e0b' : '#555'}
              />
              {matcher.isSearching && removeText && (
                <div style={{ marginTop:4,fontSize:6,color:'#f59e0b',textTransform:'uppercase',letterSpacing:'.06em' }}>
                  ⟳ Text-erased preview will appear here
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Results list ── */}
      <div style={{ flex:1,overflowY:'auto',padding:6 }}>
        {matcher.isSearching && (
          <p style={{ fontSize:8,color:'#555',textAlign:'center',textTransform:'uppercase',letterSpacing:'.08em',padding:'20px 0',lineHeight:2.2 }}>
            Running coarse→fine…<br/>
            <span style={{ color:'#22c55e' }}>Stage 2 refines each hit</span>
          </p>
        )}
        {!matcher.isSearching && samplerMode === 'matched' && matcher.matches.length === 0 && (
          <p style={{ fontSize:8,color:'#2a2a2a',textAlign:'center',textTransform:'uppercase',letterSpacing:'.08em',padding:'20px 8px',lineHeight:2.2 }}>
            No matches at {Math.round(threshold*100)}% threshold.<br />
            Try lowering threshold<br />or adding rotations.
          </p>
        )}
        {!matcher.isSearching && matcher.matches.length > 0 && (
          <>
            <div style={{ fontSize:7,color:'#333',textTransform:'uppercase',letterSpacing:'.08em',marginBottom:6,padding:'2px 4px' }}>
              {matcher.matches.length} match{matcher.matches.length!==1?'es':''} · coarse→fine
            </div>
            {matcher.matches.map((match, i) => {
              const col      = scoreColor(match.score);
              const rotLabel = Number.isInteger(match.rotation)
                ? `${match.rotation}°`
                : `${match.rotation.toFixed(1)}°`;
              return (
                <div key={match.id} style={{ border:'1px solid #1a1a1a',padding:'6px 8px',marginBottom:4,background:'#0a0a0a' }}>
                  <div style={{ display:'flex',alignItems:'center',gap:6,marginBottom:4 }}>
                    <div style={{ width:8,height:8,borderRadius:1,background:col,flexShrink:0 }} />
                    <span style={{ fontSize:8,color:'#888',textTransform:'uppercase',letterSpacing:'.05em',flex:1 }}>Match {i+1}</span>
                    <span style={{ fontSize:8,color:col,fontWeight:700 }}>{Math.round(match.score*100)}%</span>
                  </div>
                  <div style={{ paddingLeft:14 }}>
                    <TRow label="Position" value={`${match.bbox.x.toFixed(0)}, ${match.bbox.y.toFixed(0)}`} />
                    <TRow label="Size"     value={`${match.bbox.w} × ${match.bbox.h} px`} />
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
            Draw a sample box around<br />any symbol to find all<br />matching instances
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
    startRef.current  = { x: e.clientX-vr.left, y: e.clientY-vr.top };
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
        x: Math.min(startRef.current.x, e.clientX-vr.left),
        y: Math.min(startRef.current.y, e.clientY-vr.top),
        w: Math.abs(e.clientX-vr.left - startRef.current.x),
        h: Math.abs(e.clientY-vr.top  - startRef.current.y),
      };
      setDrawBox(box); setTooLarge(isTooLarge(box));
    };
    const onUp = (e: PointerEvent) => {
      if (!activeRef.current || !startRef.current) return;
      const vr  = vp.getBoundingClientRect();
      const box = {
        x: Math.min(startRef.current.x, e.clientX-vr.left),
        y: Math.min(startRef.current.y, e.clientY-vr.top),
        w: Math.abs(e.clientX-vr.left - startRef.current.x),
        h: Math.abs(e.clientY-vr.top  - startRef.current.y),
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
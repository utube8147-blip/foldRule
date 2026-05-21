/**
 * CVMatchOverlay.tsx  v1.1
 * ─────────────────────────
 * Visual overlay for OpenCV template match results.
 * Updated to show orientationLabel (e.g. "90°↔") including flip state.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CVMatchResult, UseOpenCVMatcherReturn } from '@/hooks/useOpenCVMatcher';

// ─── Colour palette ───────────────────────────────────────────────────────────

const C = {
  matchBox:  '#f43f5e',
  snap: {
    endpoint: '#f59e0b',
    midpoint: '#10b981',
    centroid: '#8b5cf6',
  } as Record<string, string>,
  rubberBand: '#38bdf8',
  template:   '#38bdf8',
};

// ─── Coord helper ─────────────────────────────────────────────────────────────

function toVP(canvasX: number, canvasY: number, zoom: number, pan: { x: number; y: number }) {
  return { x: canvasX * zoom + pan.x, y: canvasY * zoom + pan.y };
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
      width="100%" height="100%"
    >
      <defs>
        <filter id="cv-glow">
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      {matches.map((match, idx) => {
        const { bbox } = match;
        const tl = toVP(bbox.x,         bbox.y,          zoom, pan);
        const br = toVP(bbox.x + bbox.w, bbox.y + bbox.h, zoom, pan);
        const vw = br.x - tl.x;
        const vh = br.y - tl.y;

        // Use orientationLabel (e.g. "90°↔") if available, fallback to rotation
        const orientLabel = match.orientationLabel ?? `${match.rotation}°`;

        return (
          <g key={match.id}>
            <rect
              x={tl.x} y={tl.y} width={vw} height={vh}
              fill={`${C.matchBox}10`} stroke={C.matchBox}
              strokeWidth={1.5} rx={2} filter="url(#cv-glow)"
            />
            <rect x={tl.x} y={tl.y - 18} width={66} height={16} fill={C.matchBox} rx={2} />
            <text
              x={tl.x + 33} y={tl.y - 7}
              textAnchor="middle" fontSize={8}
              fill="#fff" fontFamily="'Courier New', monospace" fontWeight={700}
            >
              {Math.round(match.score * 100)}% {orientLabel} #{idx + 1}
            </text>

            {match.snapPoints.map((sp, j) => {
              const vp  = toVP(sp.x, sp.y, zoom, pan);
              const col = C.snap[sp.type] ?? '#fff';
              const r   = sp.type === 'centroid' ? 5 : sp.type === 'endpoint' ? 4 : 3;
              return (
                <g key={j}>
                  {sp.type === 'centroid' && (
                    <>
                      <line x1={vp.x-8} y1={vp.y} x2={vp.x+8} y2={vp.y} stroke={col} strokeWidth={1} strokeOpacity={0.6} />
                      <line x1={vp.x} y1={vp.y-8} x2={vp.x} y2={vp.y+8} stroke={col} strokeWidth={1} strokeOpacity={0.6} />
                    </>
                  )}
                  <circle cx={vp.x} cy={vp.y} r={r+2} fill="none" stroke={col} strokeWidth={0.8} strokeOpacity={0.4} />
                  <circle cx={vp.x} cy={vp.y} r={r} fill={col} fillOpacity={0.9} />
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

// ─── Rubber-band overlay ──────────────────────────────────────────────────────

interface DrawBox { x: number; y: number; w: number; h: number }

interface CVRubberBandProps {
  isDrawing:   boolean;
  drawBox:     DrawBox | null;
  tooLarge:    boolean;
  isSearching: boolean;
}

export function CVRubberBand({ isDrawing, drawBox, tooLarge, isSearching }: CVRubberBandProps) {
  if (isSearching) {
    return (
      <div style={{
        position: 'absolute', top: 48, left: '50%', transform: 'translateX(-50%)',
        background: 'rgba(13,13,13,0.95)', border: '1px solid #f43f5e44',
        padding: '6px 14px', display: 'flex', alignItems: 'center', gap: 8,
        zIndex: 50, pointerEvents: 'none',
      }}>
        <style>{`@keyframes cvspin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>
        <div style={{ width:10,height:10,border:'1.5px solid transparent',borderTopColor:'#f43f5e',borderRadius:'50%',animation:'cvspin .6s linear infinite' }} />
        <span style={{ fontSize:8,color:'#f43f5e',textTransform:'uppercase',letterSpacing:'.1em',fontFamily:"'Courier New',monospace" }}>
          OpenCV matching…
        </span>
      </div>
    );
  }
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
        fill="url(#cv-hatch)" stroke={col} strokeWidth={1.5} strokeDasharray={tooLarge?'6 3':'5 3'} />
      {[[drawBox.x,drawBox.y],[drawBox.x+drawBox.w,drawBox.y],[drawBox.x,drawBox.y+drawBox.h],[drawBox.x+drawBox.w,drawBox.y+drawBox.h]].map(([cx,cy],i)=>(
        <g key={i}>
          <line x1={cx-5} y1={cy} x2={cx+5} y2={cy} stroke={col} strokeWidth={1.5} />
          <line x1={cx} y1={cy-5} x2={cx} y2={cy+5} stroke={col} strokeWidth={1.5} />
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
    border:`1px solid ${active ? c : '#2a2a2a'}`,
    background:active ? `${c}12` : 'transparent',
    color:active ? c : '#777',
    padding:'3px 7px',cursor:'pointer',fontFamily:'inherit',
    whiteSpace:'nowrap',flexShrink:0,
  };
}

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
}

export function CVSamplerSidebar({
  matcher, samplerMode, onEnterDraw, onClear,
  threshold, onThreshold,
  rotations, onRotations,
  flips, onFlips,
}: CVSamplerSidebarProps) {
  const COL    = '#38bdf8';
  const SNAP_C = { endpoint: '#f59e0b', midpoint: '#10b981', centroid: '#8b5cf6' };
  const ALL_ROTS = [0, 90, 180, 270];

  return (
    <>
      {/* Header */}
      <div style={{ padding:'8px 10px',borderBottom:'1px solid #1a1a1a',flexShrink:0 }}>
        <div style={{ fontSize:8,color:'#3a3a3a',textTransform:'uppercase',letterSpacing:'.1em',marginBottom:8 }}>OpenCV Sampler</div>

        <div style={{ display:'flex',alignItems:'center',gap:6,marginBottom:10,background:'rgba(56,189,248,0.06)',border:'1px solid #38bdf822',padding:'4px 8px' }}>
          <div style={{ width:7,height:7,borderRadius:'50%',background:matcher.isReady?'#22c55e':'#f59e0b' }} />
          <span style={{ fontSize:7,color:matcher.isReady?'#22c55e':'#f59e0b',textTransform:'uppercase',letterSpacing:'.07em' }}>
            {matcher.isReady ? 'OpenCV ready' : 'Loading OpenCV…'}
          </span>
        </div>

        {(['Draw','Match'] as const).map((step,i)=>{
          const stepMode = ['drawing','matched'][i];
          const done     = i===0 && samplerMode==='matched';
          const active   = samplerMode===stepMode;
          return (
            <div key={step} style={{ display:'flex',alignItems:'center',gap:6,marginBottom:4 }}>
              <div style={{ width:16,height:16,borderRadius:'50%',flexShrink:0,background:done?'#1a3a1a':active?'#1a2a3a':'#111',border:`1px solid ${done?'#22c55e':active?COL:'#2a2a2a'}`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:8,color:done?'#22c55e':active?COL:'#333' }}>
                {done ? '✓' : i+1}
              </div>
              <span style={{ fontSize:8,color:active?'#ccc':done?'#555':'#2a2a2a',textTransform:'uppercase',letterSpacing:'.07em' }}>{step}</span>
            </div>
          );
        })}

        <div style={{ display:'flex',gap:4,marginTop:10,flexWrap:'wrap' as const }}>
          {samplerMode==='idle' && (
            <button onClick={onEnterDraw} style={{ ...tbBtn(true,COL),flex:1 }}>⊡ Draw Sample</button>
          )}
          {samplerMode==='drawing' && (
            <div style={{ fontSize:7,color:COL,textTransform:'uppercase',letterSpacing:'.07em',padding:'3px 0',lineHeight:1.8 }}>
              Drag a tight box around<br />ONE symbol on the canvas
            </div>
          )}
          {samplerMode==='matched' && (
            <>
              <button onClick={onEnterDraw} style={{ ...tbBtn(false,COL),flex:1 }}>⊡ New Sample</button>
              <button onClick={onClear} style={{ ...tbBtn(false),padding:'3px 7px' }}>✕</button>
            </>
          )}
        </div>
      </div>

      {/* Settings */}
      <div style={{ padding:'6px 10px',borderBottom:'1px solid #1a1a1a',flexShrink:0 }}>
        <div style={{ fontSize:7,color:'#333',textTransform:'uppercase',letterSpacing:'.08em',marginBottom:6 }}>Settings</div>

        {/* Threshold */}
        <div style={{ display:'flex',alignItems:'center',gap:6,marginBottom:8 }}>
          <span style={{ fontSize:7,color:'#555',textTransform:'uppercase',letterSpacing:'.06em',minWidth:56 }}>Threshold</span>
          <input type="range" min={30} max={95} step={1} value={Math.round(threshold*100)}
            onChange={e=>onThreshold(+e.target.value/100)} style={{ flex:1,accentColor:COL }} />
          <span style={{ fontSize:8,color:COL,minWidth:28 }}>{Math.round(threshold*100)}%</span>
        </div>

        {/* Rotations */}
        <div style={{ display:'flex',alignItems:'center',gap:4,marginBottom:6 }}>
          <span style={{ fontSize:7,color:'#555',textTransform:'uppercase',letterSpacing:'.06em',minWidth:56 }}>Rotations</span>
          {ALL_ROTS.map(deg=>{
            const on = rotations.includes(deg);
            return (
              <button key={deg} onClick={()=>onRotations(on?rotations.filter(r=>r!==deg):[...rotations,deg])}
                style={{ fontSize:7,padding:'2px 5px',cursor:'pointer',border:`1px solid ${on?COL:'#2a2a2a'}`,background:on?`${COL}15`:'transparent',color:on?COL:'#444',fontFamily:'inherit',textTransform:'uppercase' }}>
                {deg}°
              </button>
            );
          })}
        </div>

        {/* Flips — NEW */}
        <div style={{ display:'flex',alignItems:'center',gap:4 }}>
          <span style={{ fontSize:7,color:'#555',textTransform:'uppercase',letterSpacing:'.06em',minWidth:56 }}>Mirror</span>
          {([false, true] as const).map(f=>{
            const on = flips.includes(f);
            const lbl = f ? '↔ flip' : 'normal';
            return (
              <button key={String(f)} onClick={()=>onFlips(on?flips.filter(x=>x!==f):[...flips,f])}
                style={{ fontSize:7,padding:'2px 5px',cursor:'pointer',border:`1px solid ${on?COL:'#2a2a2a'}`,background:on?`${COL}15`:'transparent',color:on?COL:'#444',fontFamily:'inherit',textTransform:'uppercase' }}>
                {lbl}
              </button>
            );
          })}
        </div>
      </div>

      {/* Template preview */}
      {matcher.templateCrop && (
        <div style={{ padding:'6px 10px',borderBottom:'1px solid #1a1a1a',flexShrink:0 }}>
          <div style={{ fontSize:7,color:'#333',textTransform:'uppercase',letterSpacing:'.08em',marginBottom:4 }}>Template</div>
          <TRow label="Size" value={`${matcher.templateCrop.width} × ${matcher.templateCrop.height} px`} />
          <TemplatePreview crop={matcher.templateCrop} />
        </div>
      )}

      {/* Results */}
      <div style={{ flex:1,overflowY:'auto',padding:6 }}>
        {matcher.isSearching && (
          <p style={{ fontSize:8,color:'#555',textAlign:'center',textTransform:'uppercase',letterSpacing:'.08em',padding:'20px 0' }}>Running OpenCV…</p>
        )}
        {!matcher.isSearching && samplerMode==='matched' && matcher.matches.length===0 && (
          <p style={{ fontSize:8,color:'#2a2a2a',textAlign:'center',textTransform:'uppercase',letterSpacing:'.08em',padding:'20px 8px',lineHeight:2.2 }}>
            No matches at {Math.round(threshold*100)}% threshold.<br />Try lowering threshold or<br />drawing a tighter sample.
          </p>
        )}
        {!matcher.isSearching && matcher.matches.length>0 && (
          <>
            <div style={{ fontSize:7,color:'#333',textTransform:'uppercase',letterSpacing:'.08em',marginBottom:6,padding:'2px 4px' }}>
              {matcher.matches.length} match{matcher.matches.length!==1?'es':''} · pixel-accurate
            </div>
            {matcher.matches.map((match,i)=>(
              <div key={match.id} style={{ border:'1px solid #1a1a1a',padding:'6px 8px',marginBottom:4,background:'#0a0a0a' }}>
                <div style={{ display:'flex',alignItems:'center',gap:6,marginBottom:4 }}>
                  <div style={{ width:8,height:8,borderRadius:1,background:'#f43f5e',flexShrink:0 }} />
                  <span style={{ fontSize:8,color:'#888',textTransform:'uppercase',letterSpacing:'.05em',flex:1 }}>Match {i+1}</span>
                  <span style={{ fontSize:8,color:'#f43f5e',fontWeight:700 }}>{Math.round(match.score*100)}%</span>
                </div>
                <div style={{ paddingLeft:14 }}>
                  <TRow label="Position"    value={`${match.bbox.x}, ${match.bbox.y}`} />
                  <TRow label="Size"        value={`${match.bbox.w} × ${match.bbox.h} px`} />
                  <TRow label="Orientation" value={match.orientationLabel ?? `${match.rotation}°`} />
                  <div style={{ display:'flex',gap:6,marginTop:4 }}>
                    {(['endpoint','midpoint','centroid'] as const).map(type=>{
                      const count = match.snapPoints.filter(s=>s.type===type).length;
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
            ))}
          </>
        )}
        {samplerMode==='idle' && (
          <p style={{ fontSize:8,color:'#2a2a2a',textAlign:'center',textTransform:'uppercase',letterSpacing:'.08em',padding:'28px 8px',lineHeight:2.2 }}>
            Draw a sample box around<br />any symbol to find all<br />matching instances
          </p>
        )}
      </div>
    </>
  );
}

// ─── Template preview canvas ──────────────────────────────────────────────────

function TemplatePreview({ crop }: { crop: ImageData }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(()=>{
    const canvas = ref.current; if (!canvas) return;
    const maxDim = 100;
    const scale  = Math.min(maxDim/crop.width, maxDim/crop.height, 1);
    canvas.width  = Math.round(crop.width*scale);
    canvas.height = Math.round(crop.height*scale);
    const ctx = canvas.getContext('2d')!;
    const tmp = document.createElement('canvas');
    tmp.width=crop.width; tmp.height=crop.height;
    tmp.getContext('2d')!.putImageData(crop,0,0);
    ctx.drawImage(tmp,0,0,canvas.width,canvas.height);
  },[crop]);
  return <canvas ref={ref} style={{ display:'block',marginTop:6,border:'1px solid #38bdf844',background:'#fff',maxWidth:'100%' }} />;
}

// ─── Rubber-band draw hook ────────────────────────────────────────────────────

const MAX_BOX_VP_FRAC = 0.35;

interface DrawBox2 { x:number; y:number; w:number; h:number }

export function useCVRubberBand(
  viewportRef: React.RefObject<HTMLDivElement | null>,
  enabled:     boolean,
  onCommit:    (box: DrawBox2) => void,
) {
  const [drawBox,   setDrawBox]   = useState<DrawBox2|null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [tooLarge,  setTooLarge]  = useState(false);
  const startRef  = useRef<{x:number;y:number}|null>(null);
  const activeRef = useRef(false);

  const isTooLarge = useCallback((box: DrawBox2): boolean => {
    const vp = viewportRef.current; if (!vp) return false;
    const vr = vp.getBoundingClientRect();
    return box.w > vr.width*MAX_BOX_VP_FRAC || box.h > vr.height*MAX_BOX_VP_FRAC;
  },[viewportRef]);

  const startDraw = useCallback((e: React.PointerEvent)=>{
    if (!enabled) return;
    const vr = viewportRef.current!.getBoundingClientRect();
    startRef.current  = { x:e.clientX-vr.left, y:e.clientY-vr.top };
    activeRef.current = true;
    setIsDrawing(true); setTooLarge(false);
    setDrawBox({ x:startRef.current.x, y:startRef.current.y, w:0, h:0 });
  },[enabled,viewportRef]);

  useEffect(()=>{
    if (!enabled) return;
    const vp = viewportRef.current; if (!vp) return;
    const onMove = (e: PointerEvent)=>{
      if (!activeRef.current||!startRef.current) return;
      const vr=vp.getBoundingClientRect();
      const box: DrawBox2 = { x:Math.min(startRef.current.x,e.clientX-vr.left), y:Math.min(startRef.current.y,e.clientY-vr.top), w:Math.abs(e.clientX-vr.left-startRef.current.x), h:Math.abs(e.clientY-vr.top-startRef.current.y) };
      setDrawBox(box); setTooLarge(isTooLarge(box));
    };
    const onUp = (e: PointerEvent)=>{
      if (!activeRef.current||!startRef.current) return;
      const vr=vp.getBoundingClientRect();
      const box: DrawBox2 = { x:Math.min(startRef.current.x,e.clientX-vr.left), y:Math.min(startRef.current.y,e.clientY-vr.top), w:Math.abs(e.clientX-vr.left-startRef.current.x), h:Math.abs(e.clientY-vr.top-startRef.current.y) };
      activeRef.current=false; setIsDrawing(false); setDrawBox(null); setTooLarge(false); startRef.current=null;
      if (box.w>5&&box.h>5&&!isTooLarge(box)) onCommit(box);
    };
    vp.addEventListener('pointermove',onMove);
    vp.addEventListener('pointerup',onUp);
    return()=>{ vp.removeEventListener('pointermove',onMove); vp.removeEventListener('pointerup',onUp); };
  },[enabled,viewportRef,onCommit,isTooLarge]);

  return { drawBox, isDrawing, tooLarge, startDraw };
}
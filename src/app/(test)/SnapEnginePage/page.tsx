'use client';

import React, {
  useState, useEffect, useRef, useCallback, useMemo,
} from 'react';

import { useSvgSnapPoints, type SvgSnapPoint } from '@/hooks/useSvgSnapPoints';
import { useSnapEngine }                        from '@/hooks/useSnapEngine';
import type { SvgLine }                         from '@/hooks/useSvgInteraction';
import type { PdfDimensions }                   from '@/types/viewerTypes';

import { useShapeDetector }                                from '@/hooks/useShapeDetector';
import { ShapeOverlayAdapted, LABEL_CONFIG }               from '@/components/ShapeOverlay';
import type { ShapeLabel, DetectedRegion }                 from '@/hooks/useShapeDetector';

// ── NEW: worker-based OpenCV matcher ─────────────────────────────────────────
import { useOpenCVMatcher }                                from '@/hooks/useOpenCVMatcher';
import {
  CVMatchOverlay,
  CVWorkerBanner,        // ← new: floating progress banner on canvas
  CVRubberBand,
  CVSamplerSidebar,
  useCVRubberBand,
} from '@/components/CVMatchOverlay';

// ── Constants ─────────────────────────────────────────────────────────────────

const SNAP_COLOURS: Record<SvgSnapPoint['type'], string> = {
  endpoint:     '#f59e0b',
  midpoint:     '#10b981',
  centroid:     '#8b5cf6',
  intersection: '#f43f5e',
};

const LOAD_LINES = [
  'Reading SVG document',
  'Extracting vector geometry',
  'Classifying stroke connectivity',
  'Computing snap point candidates',
  'Building line index',
  'Deduplicating intersection points',
];

const DRAG_THRESHOLD = 5;

const yieldFrame = () => new Promise<void>(r => requestAnimationFrame(() => r()));

// ── SVG line extractor ────────────────────────────────────────────────────────

function numA(el: Element, n: string, fb = 0): number {
  const v = parseFloat(el.getAttribute(n) ?? ''); return isNaN(v) ? fb : v;
}
function identMat() { return { a:1,b:0,c:0,d:1,e:0,f:0 }; }
function mulMat(m1: any, m2: any) {
  return {
    a:m1.a*m2.a+m1.c*m2.b, b:m1.b*m2.a+m1.d*m2.b,
    c:m1.a*m2.c+m1.c*m2.d, d:m1.b*m2.c+m1.d*m2.d,
    e:m1.a*m2.e+m1.c*m2.f+m1.e, f:m1.b*m2.e+m1.d*m2.f+m1.f,
  };
}
function applyMat(m: any, x: number, y: number) {
  return { x:m.a*x+m.c*y+m.e, y:m.b*x+m.d*y+m.f };
}
function parseTfm(t: string | null): any {
  if (!t) return identMat();
  const re = /(matrix|translate|scale|rotate)\(([^)]*)\)/g;
  const mats: any[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const args = m[2].trim().split(/[\s,]+/).map(parseFloat);
    let mat = identMat();
    if (m[1]==='matrix')         mat={a:args[0],b:args[1],c:args[2],d:args[3],e:args[4],f:args[5]};
    else if (m[1]==='translate') mat={...identMat(),e:args[0]??0,f:args[1]??0};
    else if (m[1]==='scale')     {const s=args[0]??1,sy=args[1]??s;mat={a:s,b:0,c:0,d:sy,e:0,f:0};}
    else if (m[1]==='rotate')    {const a=(args[0]??0)*Math.PI/180,cos=Math.cos(a),sin=Math.sin(a);mat={a:cos,b:sin,c:-sin,d:cos,e:0,f:0};}
    mats.push(mat);
  }
  return mats.reduce((acc,mx)=>mulMat(acc,mx),identMat());
}
function getCTM(el: Element, root: Element): any {
  const mats: any[] = [];
  let node: Element|null = el;
  while (node && node !== root.parentElement) {
    const t = node.getAttribute('transform');
    if (t) mats.unshift(parseTfm(t));
    node = node.parentElement;
  }
  return mats.reduce((acc,mx)=>mulMat(acc,mx),identMat());
}

export function extractSvgLines(svgText: string, pdfW: number, pdfH: number): SvgLine[] {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(svgText,'image/svg+xml');
  if (doc.querySelector('parsererror')) return [];
  const svgEl = doc.querySelector('svg');
  if (!svgEl) return [];
  let sx=1,sy=1,tx=0,ty=0;
  const vb = svgEl.getAttribute('viewBox');
  if (vb) {
    const [minX,minY,vbW,vbH]=vb.trim().split(/[\s,]+/).map(parseFloat);
    if (vbW>0&&vbH>0){sx=pdfW/vbW;sy=pdfH/vbH;tx=-minX*sx;ty=-minY*sy;}
  } else {
    const wa=parseFloat(svgEl.getAttribute('width')??'0')||pdfW;
    const ha=parseFloat(svgEl.getAttribute('height')??'0')||pdfH;
    sx=pdfW/wa;sy=pdfH/ha;
  }
  const toCanvas=(x:number,y:number,ctm:any)=>{const p=applyMat(ctm,x,y);return{x:p.x*sx+tx,y:p.y*sy+ty};};
  const lines:SvgLine[]=[];
  const pushLine=(ax:number,ay:number,bx:number,by:number,ctm:any)=>{
    const a=toCanvas(ax,ay,ctm),b=toCanvas(bx,by,ctm);
    if(Math.hypot(a.x-b.x,a.y-b.y)<0.5)return;
    lines.push(({nx1:a.x/pdfW,ny1:a.y/pdfH,nx2:b.x/pdfW,ny2:b.y/pdfH}as unknown)as SvgLine);
  };
  svgEl.querySelectorAll('line,polyline,polygon,rect').forEach(el=>{
    const tag=el.tagName.toLowerCase();
    const ctm=getCTM(el,svgEl);
    if(tag==='line'){pushLine(numA(el,'x1'),numA(el,'y1'),numA(el,'x2'),numA(el,'y2'),ctm);}
    else if(tag==='polyline'||tag==='polygon'){
      const raw=el.getAttribute('points')??'';
      const nums=raw.trim().split(/[\s,]+/).map(parseFloat).filter(n=>!isNaN(n));
      for(let i=0;i+3<nums.length;i+=2)pushLine(nums[i],nums[i+1],nums[i+2],nums[i+3],ctm);
      if(tag==='polygon'&&nums.length>=4)pushLine(nums[nums.length-2],nums[nums.length-1],nums[0],nums[1],ctm);
    } else if(tag==='rect'){
      const x=numA(el,'x'),y=numA(el,'y'),w=numA(el,'width'),h=numA(el,'height');
      if(w>0&&h>0){pushLine(x,y,x+w,y,ctm);pushLine(x+w,y,x+w,y+h,ctm);pushLine(x+w,y+h,x,y+h,ctm);pushLine(x,y+h,x,y,ctm);}
    }
  });
  return lines;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const S = {
  root:       { display:'flex',flexDirection:'column' as const,height:'100vh',background:'#151515',color:'#ccc',fontFamily:"'Courier New',monospace",overflow:'hidden' },
  toolbar:    { display:'flex',alignItems:'center',gap:5,padding:'5px 10px',background:'#0d0d0d',borderBottom:'1px solid #222',flexShrink:0,height:42,flexWrap:'nowrap' as const,overflow:'hidden' },
  main:       { display:'flex',flex:1,overflow:'hidden',minHeight:0 },
  viewport:   { flex:1,position:'relative' as const,overflow:'hidden',background:'#F8F7F3',backgroundImage:'radial-gradient(circle, #D0CEC8 1px, transparent 1px)',backgroundSize:'20px 20px',userSelect:'none' as const },
  canvasWrap: { position:'absolute' as const,top:0,left:0,transformOrigin:'0 0',willChange:'transform' },
  sidebar:    { width:240,background:'#0f0f0f',borderLeft:'1px solid #1e1e1e',display:'flex',flexDirection:'column' as const,flexShrink:0,overflow:'hidden' },
  statusbar:  { height:24,background:'#0a0a0a',borderTop:'1px solid #1a1a1a',display:'flex',alignItems:'center',padding:'0 10px',gap:12,flexShrink:0 },
  sep:        { width:1,height:18,background:'#222',flexShrink:0 },
  barSep:     { width:1,height:12,background:'#1e1e1e' },
  lblStyle:   { fontSize:8,color:'#444',textTransform:'uppercase' as const,letterSpacing:'.08em',whiteSpace:'nowrap' as const },
  sbLabel:    { fontSize:8,color:'#3a3a3a',textTransform:'uppercase' as const,letterSpacing:'.1em',marginBottom:8 },
  statusTxt:  { fontSize:8,color:'#555',textTransform:'uppercase' as const,letterSpacing:'.07em',maxWidth:340,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const },
};

function tbBtn(active: boolean, colour?: string): React.CSSProperties {
  const c = colour ?? '#f59e0b';
  return {
    fontSize:8,textTransform:'uppercase',letterSpacing:'.07em',
    border:`1px solid ${active ? c : '#2a2a2a'}`,
    background:active ? `${c}12` : 'transparent',
    color:active ? c : '#777',
    padding:'3px 7px',cursor:'pointer',fontFamily:'inherit',
    whiteSpace:'nowrap',flexShrink:0,
  };
}

// ── Loading overlay ───────────────────────────────────────────────────────────

function LoadingOverlay({ active, fileName }: { active: boolean; fileName: string }) {
  const [dots, setDots] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) { setTick(0); setDots(''); return; }
    const id = setInterval(() => { setDots(d=>d.length>=3?'':d+'.'); setTick(t=>(t+1)%(LOAD_LINES.length*3)); }, 380);
    return () => clearInterval(id);
  }, [active]);
  if (!active) return null;
  const lineIdx = tick % LOAD_LINES.length;
  return (
    <div style={{ position:'absolute',inset:0,zIndex:90,background:'rgba(10,10,10,0.72)',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',pointerEvents:'none' }}>
      <style>{`@keyframes sp{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
      <div style={{ background:'#0d0d0d',border:'1px solid #2a2a2a',padding:'20px 32px',display:'flex',flexDirection:'column',alignItems:'center',gap:14,minWidth:260 }}>
        <div style={{ position:'relative',width:36,height:36 }}>
          <div style={{ position:'absolute',inset:0,border:'1.5px solid #1c1c1c',borderRadius:'50%' }} />
          <div style={{ position:'absolute',inset:0,border:'1.5px solid transparent',borderTopColor:'#f59e0b',borderRadius:'50%',animation:'sp .8s linear infinite' }} />
          <div style={{ position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize:14,color:'#f59e0b' }}>⊕</div>
        </div>
        <div style={{ fontSize:9,color:'#444',textTransform:'uppercase',letterSpacing:'.09em',maxWidth:220,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{fileName}</div>
        <div style={{ width:'100%' }}>
          {LOAD_LINES.map((line,i) => {
            const isActive=i===lineIdx,isDone=i<lineIdx;
            return (
              <div key={line} style={{ display:'flex',alignItems:'center',gap:8,padding:'2px 0',opacity:isActive?1:isDone?0.3:0.1,transition:'opacity .3s' }}>
                <span style={{ fontSize:10,color:isActive?'#f59e0b':isDone?'#444':'#222',minWidth:10 }}>{isActive?'›':isDone?'✓':'·'}</span>
                <span style={{ fontSize:8,color:isActive?'#bbb':'#444',textTransform:'uppercase',letterSpacing:'.07em' }}>{line}{isActive?dots:''}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Idle screen ───────────────────────────────────────────────────────────────

function IdleScreen() {
  return (
    <div style={{ position:'absolute',inset:0,zIndex:80,background:'#0c0c0c',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',fontFamily:"'Courier New',monospace" }}>
      <style>{`@keyframes gm{from{background-position:0 0}to{background-position:40px 40px}}`}</style>
      <div style={{ position:'absolute',inset:0,opacity:.04,backgroundImage:'linear-gradient(#f59e0b 1px,transparent 1px),linear-gradient(90deg,#f59e0b 1px,transparent 1px)',backgroundSize:'40px 40px',animation:'gm 6s linear infinite',pointerEvents:'none' }} />
      <div style={{ position:'relative',zIndex:1,textAlign:'center',width:320 }}>
        <div style={{ fontSize:28,color:'#f59e0b',marginBottom:18 }}>⊕</div>
        <div style={{ fontSize:10,fontWeight:700,color:'#f59e0b',textTransform:'uppercase',letterSpacing:'.18em',marginBottom:6 }}>SVG Snap Engine</div>
        <p style={{ fontSize:8,color:'#444',textTransform:'uppercase',letterSpacing:'.1em',margin:'12px 0 20px',lineHeight:2 }}>Load a floor plan SVG to begin</p>
        <p style={{ fontSize:8,color:'#222',textTransform:'uppercase',letterSpacing:'.07em',marginTop:20,lineHeight:2 }}>Hover: reveal snaps · Click: snap / chain<br />Ctrl+scroll: zoom · Drag: pan</p>
      </div>
    </div>
  );
}

// ── Sidebar helpers ───────────────────────────────────────────────────────────

function TRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display:'flex',justifyContent:'space-between',marginBottom:3 }}>
      <span style={{ fontSize:7,color:'#555',textTransform:'uppercase',letterSpacing:'.07em' }}>{label}</span>
      <span style={{ fontSize:8,color:'#e5e5e5',fontWeight:700 }}>{value}</span>
    </div>
  );
}

// ── Flash ─────────────────────────────────────────────────────────────────────

interface Flash { id:number; x:number; y:number; color:string }
function SnapFlashes({ flashes }: { flashes: Flash[] }) {
  return (
    <>
      <style>{`@keyframes sfade{0%{opacity:.9;transform:scale(1)}100%{opacity:0;transform:scale(2.8)}}`}</style>
      {flashes.map(f=>(
        <div key={f.id} style={{ position:'absolute',left:f.x-10,top:f.y-10,width:20,height:20,borderRadius:'50%',background:f.color,animation:'sfade .6s ease-out forwards',pointerEvents:'none',zIndex:50 }} />
      ))}
    </>
  );
}

// ── Chain sidebar ─────────────────────────────────────────────────────────────

function ChainSidebar({ chain, pdfDims, onRemove, onJump }: {
  chain: ReturnType<typeof useSnapEngine>['linearChain'];
  pdfDims: PdfDimensions | null;
  onRemove: (i: number) => void;
  onJump: (i: number) => void;
}) {
  const totalLen = chain.length >= 2
    ? chain.reduce((sum,p,i)=>i===0?0:sum+Math.hypot(p.x-chain[i-1].x,p.y-chain[i-1].y),0)
    : 0;
  return (
    <>
      <div style={{ padding:'8px 10px',borderBottom:'1px solid #1a1a1a',flexShrink:0 }}>
        <div style={{ fontSize:8,color:'#3a3a3a',textTransform:'uppercase',letterSpacing:'.1em',marginBottom:6 }}>Linear chain</div>
        <div style={{ display:'flex',gap:10,alignItems:'baseline' }}>
          <span style={{ fontSize:8,color:'#555' }}>Pts</span>
          <span style={{ fontSize:13,color:'#f59e0b',fontWeight:700 }}>{chain.length}</span>
          <span style={{ fontSize:8,color:'#555',marginLeft:6 }}>Total</span>
          <span style={{ fontSize:11,color:'#38bdf8',fontWeight:700 }}>{chain.length>=2?totalLen.toFixed(1):'—'}</span>
        </div>
      </div>
      <div style={{ flex:1,overflowY:'auto',padding:6,display:'flex',flexDirection:'column',gap:2 }}>
        {chain.length===0 ? (
          <p style={{ fontSize:8,color:'#2a2a2a',textAlign:'center',textTransform:'uppercase',letterSpacing:'.08em',padding:'20px 8px',lineHeight:2.2 }}>
            Enable Linear mode<br />click corners to chain
          </p>
        ) : (
          chain.map((p,i) => {
            const col=p.type!=='free'?SNAP_COLOURS[p.type as SvgSnapPoint['type']]:'#f59e0b';
            return (
              <React.Fragment key={i}>
                <div onClick={()=>onJump(i)} style={{ border:'1px solid #1e1e1e',padding:'4px 6px',fontSize:8,cursor:'pointer',display:'flex',alignItems:'center',gap:6 }}>
                  <div style={{ width:7,height:7,borderRadius:'50%',background:col,flexShrink:0 }} />
                  <span style={{ color:'#f59e0b',minWidth:12 }}>{i+1}</span>
                  <span style={{ flex:1,color:'#555',fontSize:7 }}>{p.x.toFixed(1)}, {p.y.toFixed(1)}</span>
                  <span onClick={e=>{e.stopPropagation();onRemove(i);}} style={{ color:'#2a2a2a',cursor:'pointer',padding:'0 2px',fontSize:11,lineHeight:1 }} title="remove">×</span>
                </div>
                {i>0&&(
                  <div style={{ border:'1px solid #0e2a33',background:'rgba(56,189,248,.02)',padding:'3px 6px',fontSize:7,display:'flex',justifyContent:'space-between',marginLeft:8 }}>
                    <span style={{ color:'#38bdf8' }}>{Math.hypot(p.x-chain[i-1].x,p.y-chain[i-1].y).toFixed(1)}</span>
                    <span style={{ color:'#333' }}>units</span>
                  </div>
                )}
              </React.Fragment>
            );
          })
        )}
      </div>
    </>
  );
}

// ── Snap point list item ──────────────────────────────────────────────────────

function PointItem({ point, pdfDims, isHighlighted, onClick }: { point: SvgSnapPoint; pdfDims: PdfDimensions | null; isHighlighted: boolean; onClick: () => void }) {
  const col=SNAP_COLOURS[point.type];
  const px=pdfDims?(point.nx*pdfDims.w).toFixed(1):'—';
  const py=pdfDims?(point.ny*pdfDims.h).toFixed(1):'—';
  return (
    <div onClick={onClick} style={{ border:`1px solid ${isHighlighted?'#f59e0b':'#1e1e1e'}`,padding:'5px 7px',fontSize:9,cursor:'pointer',background:isHighlighted?'rgba(245,158,11,.04)':'transparent',transition:'border-color .1s' }}>
      <div style={{ display:'flex',alignItems:'center',gap:6,marginBottom:3 }}>
        <div style={{ width:9,height:9,borderRadius:1,background:col,flexShrink:0 }} />
        <span style={{ flex:1,color:'#888',textTransform:'uppercase',letterSpacing:'.05em' }}>{point.type}</span>
        <span style={{ fontSize:7,border:'1px solid #2a2a2a',padding:'1px 4px',color:'#555',textTransform:'uppercase' }}>{point.shapeId.length>12?point.shapeId.slice(0,12)+'…':point.shapeId}</span>
      </div>
      <div style={{ paddingLeft:15,fontSize:7,color:'#444' }}>x:{px} y:{py} · sw:{point.strokeWidth.toFixed(1)}</div>
    </div>
  );
}

// ── Shapes sidebar tab ────────────────────────────────────────────────────────

function ShapesSidebar({ regions, isScanning, onRescan, onJump, pdfDims, zoom, pan }: {
  regions: DetectedRegion[];
  isScanning: boolean;
  onRescan: () => void;
  onJump: (r: DetectedRegion) => void;
  pdfDims: PdfDimensions | null;
  zoom: number;
  pan: { x:number; y:number };
}) {
  const [selected, setSelected] = useState<string|null>(null);
  const grouped = regions.reduce((acc,r)=>{(acc[r.label]=acc[r.label]??[]).push(r);return acc;},{} as Record<ShapeLabel,DetectedRegion[]>);
  return (
    <>
      <div style={{ padding:'8px 10px',borderBottom:'1px solid #1a1a1a',flexShrink:0 }}>
        <div style={{ fontSize:8,color:'#3a3a3a',textTransform:'uppercase',letterSpacing:'.1em',marginBottom:6 }}>Shape detection</div>
        <div style={{ display:'flex',gap:10,alignItems:'baseline' }}>
          <span style={{ fontSize:8,color:'#555' }}>Found</span>
          <span style={{ fontSize:13,color:'#f43f5e',fontWeight:700 }}>{regions.length}</span>
          <button onClick={onRescan} disabled={isScanning} style={{ marginLeft:'auto',...tbBtn(isScanning,'#f43f5e'),padding:'2px 6px' }}>{isScanning?'⟳':'⟳ scan'}</button>
        </div>
      </div>
      <div style={{ flex:1,overflowY:'auto',padding:6,display:'flex',flexDirection:'column',gap:4 }}>
        {regions.length===0 ? (
          <p style={{ fontSize:8,color:'#2a2a2a',textAlign:'center',textTransform:'uppercase',letterSpacing:'.08em',padding:'20px 8px',lineHeight:2.2 }}>{isScanning?'Scanning…':'No shapes detected.\nEnable Detect and rescan.'}</p>
        ) : (
          Object.entries(grouped).map(([label,items])=>{
            const cfg=LABEL_CONFIG[label as ShapeLabel];
            const color=items[0].color;
            return (
              <div key={label}>
                <div style={{ display:'flex',alignItems:'center',gap:6,padding:'3px 4px',marginBottom:2,borderBottom:'1px solid #181818' }}>
                  <div style={{ width:8,height:8,borderRadius:1,background:color,flexShrink:0 }} />
                  <span style={{ fontSize:7,color:'#666',textTransform:'uppercase',letterSpacing:'.08em',flex:1 }}>{cfg.name}</span>
                  <span style={{ fontSize:7,color:'#333' }}>{items.length}</span>
                </div>
                {items.map(region=>{
                  const isSel=selected===region.id;
                  return (
                    <div key={region.id} onClick={()=>{setSelected(isSel?null:region.id);onJump(region);}}
                      style={{ border:`1px solid ${isSel?color:'#1e1e1e'}`,padding:'4px 6px',fontSize:8,cursor:'pointer',background:isSel?`${color}10`:'transparent',marginBottom:2,marginLeft:8,transition:'border-color .1s' }}>
                      <div style={{ display:'flex',alignItems:'center',gap:4 }}>
                        <span style={{ color:'#555',flex:1,fontSize:7 }}>{pdfDims?`${(region.normX*pdfDims.w).toFixed(0)}, ${(region.normY*pdfDims.h).toFixed(0)}`:`${region.normX.toFixed(3)}, ${region.normY.toFixed(3)}`}</span>
                        <span style={{ color:isSel?color:'#333',fontSize:7 }}>{Math.round(region.confidence*100)}%</span>
                      </div>
                      <div style={{ fontSize:7,color:'#333',marginTop:1 }}>{region.pathCount} paths · {region.bbox.w.toFixed(0)}×{region.bbox.h.toFixed(0)}px</div>
                    </div>
                  );
                })}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

type SidebarTab  = 'chain'|'points'|'shapes'|'sampler';
type SamplerMode = 'idle'|'drawing'|'matched';

export default function SnapEnginePage() {
  // ── Core state ──────────────────────────────────────────────────────────────
  const [svgContent,  setSvgContent]  = useState<string|null>(null);
  const [svgLines,    setSvgLines]    = useState<SvgLine[]>([]);
  const [pdfDims,     setPdfDims]     = useState<PdfDimensions|null>(null);
  const [fileName,    setFileName]    = useState('');
  const [isLoading,   setIsLoading]   = useState(false);
  const [isIdle,      setIsIdle]      = useState(true);
  const [status,      setStatus]      = useState('');
  const [zoom,        setZoom]        = useState(1);
  const [pan,         setPan]         = useState({ x:0, y:0 });

  // ── Snap toggles ─────────────────────────────────────────────────────────────
  const [snapEnabled,     setSnapEnabled]     = useState(true);
  const [showPins,        setShowPins]        = useState(true);
  const [snapThresh,      setSnapThresh]      = useState(22);
  const [showLines,       setShowLines]       = useState(true);
  const [proximityRadius, setProximityRadius] = useState(40);
  const [linearMode,      setLinearMode]      = useState(true);

  // ── Shape detection ──────────────────────────────────────────────────────────
  const [detectEnabled,    setDetectEnabled]    = useState(false);
  const [shapeThreshold,   setShapeThreshold]   = useState(72);
  const [showShapeOverlay, setShowShapeOverlay] = useState(true);

  // ── CV Sampler state ─────────────────────────────────────────────────────────
  const [samplerMode,  setSamplerMode]  = useState<SamplerMode>('idle');
  const [cvThreshold,  setCVThreshold]  = useState(0.60);
  const [cvRotations,  setCVRotations]  = useState<number[]>([0, 90, 180, 270]);
  const [cvFlips,      setCVFlips]      = useState<boolean[]>([false, true]);
  const [cvRemoveText, setCVRemoveText] = useState(true);

  // ── UI state ─────────────────────────────────────────────────────────────────
  const [sidebarTab,   setSidebarTab]   = useState<SidebarTab>('chain');
  const [highlightIdx, setHighlightIdx] = useState<number|null>(null);

  // ── Refs ──────────────────────────────────────────────────────────────────────
  const viewportRef   = useRef<HTMLDivElement>(null);
  const wrapRef       = useRef<HTMLDivElement>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const pinCanvasRef  = useRef<HTMLCanvasElement>(null);
  const fileInputRef  = useRef<HTMLInputElement>(null);
  const hiddenSvgRef  = useRef<SVGSVGElement>(null);

  const pointerDownRef = useRef(false);
  const isDraggingRef  = useRef(false);
  const dragRef        = useRef({ mx:0,my:0,px:0,py:0 });

  const panRef         = useRef(pan);
  const zoomRef        = useRef(zoom);
  const flashIdRef     = useRef(0);
  const pdfDimsRef     = useRef<PdfDimensions|null>(null);
  const pageNumberRef  = useRef(1);
  const samplerModeRef = useRef<SamplerMode>('idle');

  const [flashes, setFlashes] = useState<Flash[]>([]);

  useEffect(()=>{ panRef.current     = pan;        },[pan]);
  useEffect(()=>{ zoomRef.current    = zoom;       },[zoom]);
  useEffect(()=>{ pdfDimsRef.current = pdfDims;    },[pdfDims]);
  useEffect(()=>{ samplerModeRef.current = samplerMode; },[samplerMode]);

  // ── Snap hooks ────────────────────────────────────────────────────────────────
  const { snapPoints, svgCurves } = useSvgSnapPoints(svgContent, pdfDims, zoom);

  const engine = useSnapEngine({
    pinCanvasRef:     pinCanvasRef as React.RefObject<HTMLCanvasElement>,
    viewportRef:      viewportRef  as React.RefObject<HTMLDivElement>,
    pdfDimensionsRef: pdfDimsRef,
    pageNumberRef,
    snapEnabled,
    showPins,
    snapThreshold:    snapThresh,
    confidenceFilter: 0,
    proximityRadius,
    linearMode,
    svgSnapPoints:    snapPoints,
    svgLines:         showLines ? svgLines : [],
    svgCurves:        showLines ? svgCurves : [],
    svgAreas:         [],
    zoom,
    pan,
  });

  // ── Shape detection ──────────────────────────────────────────────────────────
  const { regions, isScanning, rescan } = useShapeDetector(hiddenSvgRef, {
    enabled:   detectEnabled,
    threshold: shapeThreshold/100,
  });

  // ── OpenCV matcher (worker-based) ─────────────────────────────────────────────
  const cvMatcher = useOpenCVMatcher();

  // ── Rubber-band (CV version) ─────────────────────────────────────────────────
  const isDrawMode = samplerMode === 'drawing';

  const handleBoxCommit = useCallback(async (box: { x:number; y:number; w:number; h:number }) => {
    const canvas = baseCanvasRef.current;
    if (!canvas) return;
    cvMatcher.buildTemplate(canvas, box, zoomRef.current, panRef.current);
    setSamplerMode('matched');
    await cvMatcher.findMatches(canvas, cvThreshold, cvRotations, cvFlips, cvRemoveText);
  }, [cvMatcher, cvThreshold, cvRotations, cvFlips, cvRemoveText]);

  const { drawBox, isDrawing, tooLarge, startDraw } = useCVRubberBand(
    viewportRef as React.RefObject<HTMLDivElement>,
    isDrawMode,
    handleBoxCommit,
  );

  const handleClearSampler = useCallback(() => {
    cvMatcher.clearAll();
    setSamplerMode('idle');
  }, [cvMatcher]);

  const handleEnterDraw = useCallback(() => {
    cvMatcher.clearAll();
    setSamplerMode('drawing');
  }, [cvMatcher]);

  // ── Canvas transform ─────────────────────────────────────────────────────────
  useEffect(()=>{
    if(wrapRef.current)
      wrapRef.current.style.transform=`translate(${pan.x}px,${pan.y}px) scale(${zoom})`;
  },[pan,zoom]);

  const fitCanvas = useCallback(()=>{
    const vp=viewportRef.current,bc=baseCanvasRef.current;
    if(!vp||!bc)return;
    const vr=vp.getBoundingClientRect();
    const fz=Math.min((vr.width*.9)/bc.width,(vr.height*.9)/bc.height,2);
    setZoom(fz);
    setPan({x:(vr.width-bc.width*fz)/2,y:(vr.height-bc.height*fz)/2});
  },[]);

  // ── SVG loader ────────────────────────────────────────────────────────────────
  const loadSvgText = useCallback(async (text: string, name: string)=>{
    setFileName(name); setIsLoading(true); setIsIdle(false);
    await yieldFrame();
    try {
      const parser=new DOMParser();
      const doc=parser.parseFromString(text,'image/svg+xml');
      if(doc.querySelector('parsererror'))throw new Error('Invalid SVG');
      const svgEl=doc.querySelector('svg') as SVGSVGElement|null;
      if(!svgEl)throw new Error('No <svg> element');
      let w=800,h=600;
      const vb=svgEl.getAttribute('viewBox');
      if(vb){const parts=vb.trim().split(/[\s,]+/).map(parseFloat);if(parts.length>=4&&parts[2]>0&&parts[3]>0){w=parts[2];h=parts[3];}}
      else{const wa=parseFloat(svgEl.getAttribute('width')??'0');if(wa>0)w=wa;const ha=parseFloat(svgEl.getAttribute('height')??'0');if(ha>0)h=ha;}
      const dims:PdfDimensions={w,h};
      setPdfDims(dims);pdfDimsRef.current=dims;
      const lines=extractSvgLines(text,w,h);
      setSvgLines(lines);
      if(hiddenSvgRef.current){
        const hsvg=hiddenSvgRef.current;
        hsvg.setAttribute('viewBox',svgEl.getAttribute('viewBox')??`0 0 ${w} ${h}`);
        hsvg.setAttribute('width',String(w));hsvg.setAttribute('height',String(h));
        hsvg.innerHTML=svgEl.innerHTML;
      }
      const blob=new Blob([text],{type:'image/svg+xml'});
      const url=URL.createObjectURL(blob);
      const img=new Image();
      await new Promise<void>((res,rej)=>{img.onload=()=>res();img.onerror=()=>rej(new Error('Render failed'));img.src=url;});
      URL.revokeObjectURL(url);
      const bc=baseCanvasRef.current!;bc.width=w;bc.height=h;
      const ctx=bc.getContext('2d')!;
      ctx.fillStyle='#ffffff';ctx.fillRect(0,0,w,h);
      ctx.drawImage(img,0,0,w,h);
      setSvgContent(text);
      engine.clearChain();
      handleClearSampler();
      setIsLoading(false);
      fitCanvas();
      setStatus(`Loaded · ${w.toFixed(0)}×${h.toFixed(0)}px · ${lines.length} line segs · parsing snaps…`);
      if(detectEnabled)setTimeout(rescan,600);
    } catch(err){
      setIsLoading(false);setIsIdle(true);
      setStatus(`Error: ${(err as Error).message}`);
    }
  },[fitCanvas,engine,detectEnabled,rescan,handleClearSampler]);

  // ── Status line ───────────────────────────────────────────────────────────────
  useEffect(()=>{
    if(snapPoints.length===0||!pdfDims)return;
    const counts=snapPoints.reduce((acc,p)=>{acc[p.type]=(acc[p.type]??0)+1;return acc;},{} as Record<string,number>);
    const summary=(Object.entries(counts) as [string,number][]).map(([k,v])=>`${k}:${v}`).join(' · ');
    const shapePart=detectEnabled?` · ${regions.length} shapes`:'';
    const matcherPart=cvMatcher.matches.length>0?` · ${cvMatcher.matches.length} CV matches`:'';
    const workerPart=cvMatcher.isSearching?` · [worker: ${cvMatcher.workerPhase}]`:'';
    setStatus(`${snapPoints.length} snap pts · ${svgLines.length} line segs · ${svgCurves.length} curves${shapePart}${matcherPart}${workerPart} — ${summary}`);
  },[snapPoints,pdfDims,svgLines.length,svgCurves.length,regions.length,detectEnabled,cvMatcher.matches.length,cvMatcher.isSearching,cvMatcher.workerPhase]);

  // ── File upload ───────────────────────────────────────────────────────────────
  const handleUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>)=>{
    const file=e.target.files?.[0];if(!file)return;
    e.target.value='';
    const reader=new FileReader();
    reader.onload=ev=>loadSvgText(ev.target!.result as string,file.name);
    reader.readAsText(file);
  },[loadSvgText]);

  // ── Canvas coordinate helpers ─────────────────────────────────────────────────
  const getCanvasXY = useCallback((e: React.PointerEvent|MouseEvent)=>{
    const vr=viewportRef.current!.getBoundingClientRect();
    return{x:(e.clientX-vr.left-panRef.current.x)/zoomRef.current,y:(e.clientY-vr.top-panRef.current.y)/zoomRef.current};
  },[]);

  const getViewportXY = useCallback((e: React.PointerEvent|MouseEvent)=>{
    const vr=viewportRef.current!.getBoundingClientRect();
    return{x:e.clientX-vr.left,y:e.clientY-vr.top};
  },[]);

  // ── Pointer handlers ──────────────────────────────────────────────────────────
  const handlePointerDown = useCallback((e: React.PointerEvent)=>{
    if(e.button!==0)return;
    if(samplerModeRef.current==='drawing'){startDraw(e);return;}
    pointerDownRef.current=true;
    isDraggingRef.current=false;
    dragRef.current={mx:e.clientX,my:e.clientY,px:panRef.current.x,py:panRef.current.y};
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  },[startDraw]);

  const handlePointerMove = useCallback((e: React.PointerEvent)=>{
    if(samplerModeRef.current==='drawing')return;
    if(pointerDownRef.current&&!isDraggingRef.current){
      const dx=e.clientX-dragRef.current.mx,dy=e.clientY-dragRef.current.my;
      if(Math.hypot(dx,dy)>DRAG_THRESHOLD)isDraggingRef.current=true;
    }
    if(isDraggingRef.current){
      setPan({x:dragRef.current.px+(e.clientX-dragRef.current.mx),y:dragRef.current.py+(e.clientY-dragRef.current.my)});
      return;
    }
    if(!pdfDimsRef.current)return;
    const cxy=getCanvasXY(e);
    engine.cursorPointRef.current=cxy;
    engine.redrawPinCanvas();
  },[engine,getCanvasXY]);

  const handlePointerUp = useCallback((e: React.PointerEvent)=>{
    if(samplerModeRef.current==='drawing')return;
    const wasActualDrag=isDraggingRef.current;
    pointerDownRef.current=false;
    isDraggingRef.current=false;
    if(wasActualDrag)return;
    if(!pdfDimsRef.current)return;
    const cxy=getCanvasXY(e);
    const vxy=getViewportXY(e);
    const result=engine.snapToCorner(cxy.x,cxy.y);
    if(linearMode){
      const px=result.snapped?result.point.x:cxy.x;
      const py=result.snapped?result.point.y:cxy.y;
      const snappedType=result.snapped
        ? (snapPoints.find(p=>{const dims=pdfDimsRef.current!;return Math.hypot(p.nx*dims.w-result.point.x,p.ny*dims.h-result.point.y)<2;})?.type??'free')
        : 'free';
      engine.addChainPoint(px,py,snappedType as any);
      const color=snappedType!=='free'?SNAP_COLOURS[snappedType as SvgSnapPoint['type']]:'#f59e0b';
      const id=++flashIdRef.current;
      setFlashes(prev=>[...prev,{id,x:vxy.x,y:vxy.y,color}]);
      setTimeout(()=>setFlashes(prev=>prev.filter(f=>f.id!==id)),700);
      setStatus(`Chain pt ${engine.linearChain.length+1}: (${px.toFixed(1)}, ${py.toFixed(1)})${snappedType!=='free'?' · '+snappedType:' · free'}`);
    } else {
      if(!result.snapped)return;
      const color='#f59e0b';
      const id=++flashIdRef.current;
      setFlashes(prev=>[...prev,{id,x:vxy.x,y:vxy.y,color}]);
      setTimeout(()=>setFlashes(prev=>prev.filter(f=>f.id!==id)),700);
      engine.triggerSnapFlash(result.point.x,result.point.y);
      setStatus(`Snapped → (${result.point.x.toFixed(1)}, ${result.point.y.toFixed(1)})`);
    }
  },[linearMode,engine,getCanvasXY,getViewportXY,snapPoints]);

  const handlePointerLeave = useCallback(()=>{
    pointerDownRef.current=false;
    isDraggingRef.current=false;
    engine.cursorPointRef.current=null;
    engine.redrawPinCanvas();
  },[engine]);

  const wheelRef = useRef<(e:WheelEvent)=>void>(()=>{});
  useEffect(()=>{
    wheelRef.current=(e:WheelEvent)=>{
      e.preventDefault();
      const vp=viewportRef.current;if(!vp)return;
      const vr=vp.getBoundingClientRect();
      if(e.ctrlKey){
        const mx=e.clientX-vr.left,my=e.clientY-vr.top;
        const f=e.deltaY>0?.9:1.1;
        setZoom(z=>{const nz=Math.min(20,Math.max(0.05,z*f));setPan(p=>({x:mx-(mx-p.x)*(nz/z),y:my-(my-p.y)*(nz/z)}));return nz;});
      } else {
        setPan(p=>({x:p.x-e.deltaX,y:p.y-e.deltaY}));
      }
      engine.redrawPinCanvas();
    };
  });
  useEffect(()=>{
    const vp=viewportRef.current;if(!vp)return;
    const h=(e:WheelEvent)=>wheelRef.current(e);
    vp.addEventListener('wheel',h,{passive:false});
    return()=>vp.removeEventListener('wheel',h);
  },[]);

  useEffect(()=>{ engine.redrawPinCanvas(); },[zoom,pan,showLines,engine]);

  // ── Jump helpers ──────────────────────────────────────────────────────────────
  const jumpToPoint = useCallback((idx: number)=>{
    const p=snapPoints[idx];if(!p||!pdfDims)return;
    setHighlightIdx(idx);
    const px=p.nx*pdfDims.w,py=p.ny*pdfDims.h;
    const vr=viewportRef.current!.getBoundingClientRect();
    setPan({x:(vr.width/2)-px*zoomRef.current,y:(vr.height/2)-py*zoomRef.current});
    const color=SNAP_COLOURS[p.type];
    const id=++flashIdRef.current;
    setFlashes(prev=>[...prev,{id,x:vr.width/2,y:vr.height/2,color}]);
    setTimeout(()=>setFlashes(prev=>prev.filter(f=>f.id!==id)),700);
    engine.redrawPinCanvas();
  },[snapPoints,pdfDims,engine]);

  const jumpToChainPoint = useCallback((idx: number)=>{
    const p=engine.linearChain[idx];if(!p)return;
    const vr=viewportRef.current!.getBoundingClientRect();
    setPan({x:(vr.width/2)-p.x*zoomRef.current,y:(vr.height/2)-p.y*zoomRef.current});
    engine.redrawPinCanvas();
  },[engine]);

  const jumpToRegion = useCallback((region: DetectedRegion)=>{
    if(!pdfDims)return;
    const cx=(region.normX+region.normW/2)*pdfDims.w;
    const cy=(region.normY+region.normH/2)*pdfDims.h;
    const vr=viewportRef.current!.getBoundingClientRect();
    setPan({x:(vr.width/2)-cx*zoomRef.current,y:(vr.height/2)-cy*zoomRef.current});
  },[pdfDims]);

  const removeChainPoint = useCallback((idx: number)=>{
    const updated=engine.linearChain.filter((_,i)=>i!==idx);
    engine.clearChain();
    updated.forEach(p=>engine.addChainPoint(p.x,p.y,p.type));
  },[engine]);

  // ── Derived ───────────────────────────────────────────────────────────────────
  const cursor = pdfDims || samplerMode !== 'idle' ? 'crosshair' : 'default';
  const typeCounts = snapPoints.reduce((acc,p)=>{acc[p.type]=(acc[p.type]??0)+1;return acc;},{} as Record<string,number>);

  const tabConfig: { key: SidebarTab; label: string; color: string }[] = [
    { key:'chain',   label:`Chain (${engine.linearChain.length})`,  color:'#a78bfa' },
    { key:'points',  label:`Snaps (${snapPoints.length})`,           color:'#f59e0b' },
    { key:'shapes',  label:`Shapes (${regions.length})`,             color:'#f43f5e' },
    { key:'sampler', label:`CV${cvMatcher.matches.length>0?` (${cvMatcher.matches.length})`:''}`, color:'#38bdf8' },
  ];

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div style={S.root}>
      {/* Hidden SVG for shape detector */}
      <svg ref={hiddenSvgRef} style={{ position:'absolute',width:0,height:0,overflow:'hidden',pointerEvents:'none',opacity:0 }} aria-hidden="true" />

      {/* ── Toolbar ── */}
      <div style={S.toolbar}>
        <span style={{ fontSize:9,fontWeight:700,color:'#555',textTransform:'uppercase',letterSpacing:'.1em',marginRight:4 }}>⊕ Snap Engine</span>
        <div style={S.sep} />
        <label style={{ fontSize:8,textTransform:'uppercase',letterSpacing:'.07em',border:'1px solid #383838',background:'transparent',color:'#999',padding:'3px 9px',cursor:'pointer',fontFamily:'inherit',flexShrink:0 }}>
          ↑ Load SVG
          <input ref={fileInputRef} type="file" accept=".svg" style={{ display:'none' }} onChange={handleUpload} />
        </label>
        <div style={S.sep} />
        <button onClick={()=>setSnapEnabled(v=>!v)} style={tbBtn(snapEnabled)}>Snap {snapEnabled?'●':'○'}</button>
        <button onClick={()=>setShowPins(v=>!v)}    style={tbBtn(showPins)}>Pins {showPins?'●':'○'}</button>
        <button onClick={()=>setShowLines(v=>!v)}   style={tbBtn(showLines,'#38bdf8')}>Lines {showLines?'●':'○'}</button>
        <div style={S.sep} />
        <button onClick={()=>{setLinearMode(v=>!v);setSidebarTab('chain');}} style={tbBtn(linearMode,'#a78bfa')}>
          Linear {linearMode?'●':'○'}
        </button>
        {linearMode&&(
          <>
            <button onClick={()=>engine.undoChainPoint()} style={tbBtn(false)}>Undo</button>
            <button onClick={()=>engine.clearChain()} style={{ ...tbBtn(false),color:'#f43f5e',borderColor:engine.linearChain.length>0?'#f43f5e44':'#2a2a2a' }}>Clear</button>
            <span style={{ fontSize:8,border:'1px solid #2a2a2a',padding:'2px 6px',color:engine.linearChain.length>0?'#a78bfa':'#333' }}>
              {engine.linearChain.length} pts
            </span>
          </>
        )}
        <div style={S.sep} />
        <button
          onClick={()=>{const next=!detectEnabled;setDetectEnabled(next);if(next){setSidebarTab('shapes');setTimeout(rescan,200);}}}
          style={tbBtn(detectEnabled,'#f43f5e')}
        >Detect {detectEnabled?'●':'○'}</button>
        {detectEnabled&&(
          <>
            <button onClick={()=>setShowShapeOverlay(v=>!v)} style={tbBtn(showShapeOverlay,'#f43f5e')}>Overlay {showShapeOverlay?'●':'○'}</button>
            <span style={S.lblStyle}>Conf</span>
            <input type="range" min={40} max={95} step={1} value={shapeThreshold} onChange={e=>setShapeThreshold(+e.target.value)} style={{ width:48,accentColor:'#f43f5e' }} />
            <span style={{ fontSize:8,color:'#f43f5e',minWidth:28 }}>{shapeThreshold}%</span>
            <button onClick={rescan} style={{ ...tbBtn(isScanning,'#f43f5e'),opacity:isScanning?.5:1 }} disabled={isScanning}>{isScanning?'⟳':'⟳ scan'}</button>
          </>
        )}
        <div style={S.sep} />
        {/* CV Sampler toolbar button */}
        <button
          onClick={()=>{setSidebarTab('sampler');if(samplerMode==='idle')handleEnterDraw();}}
          style={tbBtn(samplerMode!=='idle','#38bdf8')}
        >
          ⊡ CV Match {samplerMode!=='idle'?'●':'○'}
        </button>
        {cvMatcher.matches.length>0&&(
          <span style={{ fontSize:8,border:'1px solid #38bdf844',padding:'2px 6px',color:'#38bdf8',letterSpacing:'.07em',flexShrink:0 }}>
            {cvMatcher.matches.length} CV matches
          </span>
        )}
        <div style={S.sep} />
        <span style={S.lblStyle}>Threshold</span>
        <input type="range" min={8} max={80} step={1} value={snapThresh} onChange={e=>setSnapThresh(+e.target.value)} style={{ width:56,accentColor:'#f59e0b' }} />
        <span style={{ fontSize:8,color:'#f59e0b',minWidth:28 }}>{snapThresh}px</span>
        <div style={S.sep} />
        <span style={S.lblStyle}>Radius</span>
        <input type="range" min={40} max={300} step={5} value={proximityRadius} onChange={e=>setProximityRadius(+e.target.value)} style={{ width:56,accentColor:'#38bdf8' }} />
        <span style={{ fontSize:8,color:'#38bdf8',minWidth:32 }}>{proximityRadius}px</span>
        <div style={S.sep} />
        <span style={{ fontSize:8,border:'1px solid #2a2a2a',padding:'2px 6px',color:snapPoints.length>0?'#f59e0b':'#333',letterSpacing:'.07em',flexShrink:0 }}>{snapPoints.length} pts</span>
        <div style={{ flex:1 }} />
        <span style={S.statusTxt}>{status}</span>
        <div style={S.sep} />
        <button onClick={()=>setZoom(z=>Math.max(.05,z*.85))} style={tbBtn(false)}>−</button>
        <span style={{ fontSize:8,color:'#555',minWidth:38,textAlign:'center' }}>{Math.round(zoom*100)}%</span>
        <button onClick={()=>setZoom(z=>Math.min(20,z*1.15))} style={tbBtn(false)}>+</button>
        <button onClick={fitCanvas} style={tbBtn(false)}>⊡</button>
      </div>

      {/* ── Main ── */}
      <div style={S.main}>
        {/* Viewport */}
        <div
          ref={viewportRef}
          style={{ ...S.viewport, cursor }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerLeave}
          onContextMenu={e=>e.preventDefault()}
        >
          {isIdle    && <IdleScreen />}
          {isLoading && <LoadingOverlay active={isLoading} fileName={fileName} />}

          {/* Base canvas */}
          <div ref={wrapRef} style={S.canvasWrap}>
            <canvas ref={baseCanvasRef} style={{ display:'block',imageRendering:'auto' }} />
          </div>

          {/* Snap pin overlay */}
          <canvas ref={pinCanvasRef} style={{ position:'absolute',top:0,left:0,pointerEvents:'none',width:'100%',height:'100%' }} />

          {/* Shape overlay */}
          {detectEnabled&&showShapeOverlay&&pdfDims&&(
            <ShapeOverlayAdapted regions={regions} pdfDims={pdfDims} zoom={zoom} pan={pan} isScanning={isScanning} onRescan={rescan} visible={showShapeOverlay} />
          )}

          {/* ── CV worker progress banner (floats above canvas, non-blocking) ── */}
          <CVWorkerBanner
            isSearching={cvMatcher.isSearching}
            workerPhase={cvMatcher.workerPhase}
            workerDetail={cvMatcher.workerDetail}
          />

          {/* ── CV rubber-band + match overlay ── */}
          <CVRubberBand
            isDrawing={isDrawing}
            drawBox={tooLarge ? null : drawBox}
            tooLarge={tooLarge}
            isSearching={cvMatcher.isSearching}
            workerPhase={cvMatcher.workerPhase}
            workerDetail={cvMatcher.workerDetail}
          />
          <CVMatchOverlay
            matches={cvMatcher.matches}
            zoom={zoom}
            pan={pan}
          />

          {/* Too-large warning */}
          {isDrawing && tooLarge && drawBox && (
            <svg style={{ position:'absolute',inset:0,pointerEvents:'none',zIndex:36,overflow:'visible' }} width="100%" height="100%">
              <rect x={drawBox.x} y={drawBox.y} width={drawBox.w} height={drawBox.h}
                fill="rgba(244,63,94,0.06)" stroke="#f43f5e" strokeWidth={1.5} strokeDasharray="6 3" />
              <rect x={drawBox.x+drawBox.w/2-110} y={drawBox.y+drawBox.h/2-13} width={220} height={24}
                fill="#0d0d0d" stroke="#f43f5e44" rx={3} />
              <text x={drawBox.x+drawBox.w/2} y={drawBox.y+drawBox.h/2+4}
                textAnchor="middle" fontSize={9} fill="#f43f5e" fontFamily="'Courier New', monospace">
                Zoom in — box covers too much of viewport
              </text>
            </svg>
          )}

          {/* Flash effects */}
          <div style={{ position:'absolute',inset:0,pointerEvents:'none',zIndex:40 }}>
            <SnapFlashes flashes={flashes} />
          </div>

          {/* File name badge */}
          {!isIdle&&!isLoading&&fileName&&(
            <div style={{ position:'absolute',bottom:10,left:10,background:'rgba(255,255,255,.92)',border:'1px solid #ccc',padding:'3px 8px',fontSize:9,color:'#666',textTransform:'uppercase',letterSpacing:'.08em',pointerEvents:'none' }}>
              {fileName}
            </div>
          )}

          {/* Mode badges */}
          {linearMode&&(
            <div style={{ position:'absolute',top:10,left:10,background:'rgba(167,139,250,.15)',border:'1px solid rgba(167,139,250,.4)',padding:'3px 8px',fontSize:8,color:'#a78bfa',textTransform:'uppercase',letterSpacing:'.1em',pointerEvents:'none' }}>
              Linear mode · click to chain
            </div>
          )}
          {samplerMode==='drawing'&&(
            <div style={{ position:'absolute',top:linearMode?36:10,left:10,background:'rgba(56,189,248,.12)',border:'1px solid rgba(56,189,248,.4)',padding:'3px 8px',fontSize:8,color:'#38bdf8',textTransform:'uppercase',letterSpacing:'.1em',pointerEvents:'none' }}>
              {tooLarge ? '⚠ Zoom in more — box too large' : 'CV Sampler · drag tight box around ONE symbol'}
            </div>
          )}
          {samplerMode==='matched'&&cvMatcher.matches.length>0&&!cvMatcher.isSearching&&(
            <div style={{ position:'absolute',top:linearMode?36:10,left:10,background:'rgba(244,63,94,.12)',border:'1px solid rgba(244,63,94,.3)',padding:'3px 8px',fontSize:8,color:'#f43f5e',textTransform:'uppercase',letterSpacing:'.1em',pointerEvents:'none' }}>
              {cvMatcher.matches.length} CV match{cvMatcher.matches.length!==1?'es':''} · pixel-accurate
            </div>
          )}
        </div>

        {/* ── Sidebar ── */}
        <div style={S.sidebar}>
          <div style={{ display:'flex',borderBottom:'1px solid #1a1a1a',flexShrink:0 }}>
            {tabConfig.map(tab=>(
              <button key={tab.key} onClick={()=>setSidebarTab(tab.key)}
                style={{ flex:1,fontSize:7,textTransform:'uppercase',letterSpacing:'.04em',padding:'6px 0',border:'none',background:sidebarTab===tab.key?'#111':'transparent',color:sidebarTab===tab.key?tab.color:'#333',cursor:'pointer',borderBottom:sidebarTab===tab.key?`1px solid ${tab.color}`:'1px solid transparent',fontFamily:'inherit',whiteSpace:'nowrap' }}>
                {tab.label}
              </button>
            ))}
          </div>

          {sidebarTab==='chain'&&(
            <ChainSidebar chain={engine.linearChain} pdfDims={pdfDims} onRemove={removeChainPoint} onJump={jumpToChainPoint} />
          )}

          {sidebarTab==='points'&&(
            <>
              <div style={{ padding:10,borderBottom:'1px solid #1a1a1a' }}>
                <div style={S.sbLabel}>Snap types</div>
                {(Object.entries(SNAP_COLOURS) as [SvgSnapPoint['type'],string][]).map(([type,col])=>(
                  <div key={type} style={{ display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:5 }}>
                    <div style={{ display:'flex',alignItems:'center',gap:8 }}>
                      <div style={{ width:9,height:9,borderRadius:2,background:col,flexShrink:0 }} />
                      <span style={{ fontSize:8,color:'#777',textTransform:'uppercase',letterSpacing:'.06em' }}>{type}</span>
                    </div>
                    <span style={{ fontSize:8,color:'#444' }}>{typeCounts[type]??0}</span>
                  </div>
                ))}
                <div style={{ display:'flex',alignItems:'center',justifyContent:'space-between',marginTop:3 }}>
                  <div style={{ display:'flex',alignItems:'center',gap:8 }}>
                    <div style={{ width:9,height:3,background:'#38bdf8',flexShrink:0 }} />
                    <span style={{ fontSize:8,color:'#777',textTransform:'uppercase',letterSpacing:'.06em' }}>lines</span>
                  </div>
                  <span style={{ fontSize:8,color:'#444' }}>{svgLines.length}</span>
                </div>
                <div style={{ display:'flex',alignItems:'center',justifyContent:'space-between',marginTop:3 }}>
                  <div style={{ display:'flex',alignItems:'center',gap:8 }}>
                    <div style={{ width:9,height:3,background:'#38bdf8',borderRadius:1,flexShrink:0,opacity:0.6 }} />
                    <span style={{ fontSize:8,color:'#777',textTransform:'uppercase',letterSpacing:'.06em' }}>curves</span>
                  </div>
                  <span style={{ fontSize:8,color:'#444' }}>{svgCurves.length}</span>
                </div>
              </div>
              <div style={{ padding:'6px 10px',borderBottom:'1px solid #1a1a1a' }}>
                <span style={{ fontSize:8,color:'#3a3a3a',textTransform:'uppercase',letterSpacing:'.09em' }}>
                  Points ({snapPoints.length}{snapPoints.length>300?', showing 300':''})
                </span>
              </div>
              <div style={{ flex:1,overflowY:'auto',padding:6,display:'flex',flexDirection:'column',gap:3 }}>
                {snapPoints.length===0
                  ? <p style={{ fontSize:8,color:'#2a2a2a',textAlign:'center',textTransform:'uppercase',letterSpacing:'.08em',padding:'28px 8px',lineHeight:2.2 }}>Load an SVG to see<br />detected snap points</p>
                  : snapPoints.slice(0,300).map((p,i)=>(
                    <PointItem key={`${p.nx.toFixed(5)}-${p.ny.toFixed(5)}-${p.type}-${i}`} point={p} pdfDims={pdfDims} isHighlighted={highlightIdx===i} onClick={()=>jumpToPoint(i)} />
                  ))
                }
              </div>
            </>
          )}

          {sidebarTab==='shapes'&&(
            <ShapesSidebar regions={regions} isScanning={isScanning} onRescan={rescan} onJump={jumpToRegion} pdfDims={pdfDims} zoom={zoom} pan={pan} />
          )}

          {sidebarTab==='sampler'&&(
            <CVSamplerSidebar
              matcher={cvMatcher}
              samplerMode={samplerMode}
              onEnterDraw={handleEnterDraw}
              onClear={handleClearSampler}
              threshold={cvThreshold}
              onThreshold={setCVThreshold}
              rotations={cvRotations}
              onRotations={setCVRotations}
              flips={cvFlips}
              onFlips={setCVFlips}
              removeText={cvRemoveText}
              onRemoveText={setCVRemoveText}
            />
          )}
        </div>
      </div>

      {/* ── Status bar ── */}
      <div style={S.statusbar}>
        {(samplerMode==='drawing'
          ? [tooLarge?'⚠ Zoom in more':'Drag tight box around ONE symbol']
          : linearMode
          ? ['Hover: nearest snap','Click: add chain point','Ctrl+scroll: zoom','Drag: pan']
          : ['Hover: nearest snap','Click: snap indicator','Ctrl+scroll: zoom','Drag: pan']
        ).map((h,i)=>(
          <React.Fragment key={h}>
            {i>0&&<div style={S.barSep} />}
            <span style={{ fontSize:8,color:samplerMode==='drawing'?(tooLarge?'#f43f5e':'#38bdf8'):'#2e2e2e',textTransform:'uppercase',letterSpacing:'.07em' }}>{h}</span>
          </React.Fragment>
        ))}
        <div style={{ flex:1 }} />
        {/* Live worker phase in status bar */}
        {cvMatcher.isSearching&&(
          <><span style={{ fontSize:8,color:'#a78bfa',textTransform:'uppercase',letterSpacing:'.07em' }}>
            ⟳ {cvMatcher.workerPhase}{cvMatcher.workerDetail?' · '+cvMatcher.workerDetail:''}
          </span><div style={S.barSep} /></>
        )}
        {cvMatcher.matches.length>0&&!cvMatcher.isSearching&&(
          <><span style={{ fontSize:8,color:'#38bdf8',textTransform:'uppercase',letterSpacing:'.07em' }}>{cvMatcher.matches.length} CV matches · pixel-accurate</span><div style={S.barSep} /></>
        )}
        {detectEnabled&&(
          <><span style={{ fontSize:8,color:isScanning?'#f43f5e':'#2e2e2e',textTransform:'uppercase',letterSpacing:'.07em' }}>{isScanning?'⟳ scanning':`${regions.length} shapes`}</span><div style={S.barSep} /></>
        )}
        <span style={{ fontSize:8,color:'#2e2e2e',textTransform:'uppercase',letterSpacing:'.07em' }}>{fileName}</span>
      </div>
    </div>
  );
}
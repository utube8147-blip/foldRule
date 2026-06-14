'use client';

import React, {
  useState, useEffect, useRef, useCallback,
} from 'react';

import { useSvgSnapPoints, type SvgSnapPoint } from '@/hooks/snapEngine/useSvgSnapPoints-test';
import { useSnapEngine }                        from '@/hooks/snapEngine/useSnapEngine-test';
import type { SvgLine }                         from '@/hooks/snapEngine/useSvgSnapPoints';
import type { PdfDimensions }                   from '@/types/viewerTypes';

// ── CV Matcher (single-template) ──────────────────────────────────────────────
import { useOpenCVMatcher }  from '@/hooks/detection/useOpenCVMatcher';
import {
  CVMatchOverlay,
  CVWorkerBanner,
  CVRubberBand,
  CVSamplerSidebar,
  useCVRubberBand,
} from '@/components/features/overlays/CVMatchOverlay';

// ── Pattern Painter (multi-pattern) ───────────────────────────────────────────
import { usePatternPainter } from '@/hooks/canvas/usePatternPainter';
import {
  PatternPainterOverlay,
  PatternPainterSidebar,
  PatternRubberBand,
  PatternWorkerBanner,
  usePatternRubberBand,
} from '@/components/features/tools/PatternPainter';

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

// ── Active tool type ──────────────────────────────────────────────────────────

type ActiveTool = 'snap' | 'cv' | 'painter' | null;

interface CVBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

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
  statusbar:  { height:24,background:'#0a0a0a',borderTop:'1px solid #1a1a1a',display:'flex',alignItems:'center',padding:'0 10px',gap:12,flexShrink:0 },
  sep:        { width:1,height:18,background:'#222',flexShrink:0 },
  barSep:     { width:1,height:12,background:'#1e1e1e' },
  statusTxt:  { fontSize:8,color:'#555',textTransform:'uppercase' as const,letterSpacing:'.07em',maxWidth:340,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const },
  lblStyle:   { fontSize:8,color:'#444',textTransform:'uppercase' as const,letterSpacing:'.08em',whiteSpace:'nowrap' as const },
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

// ── Tool button — larger, with icon + label ───────────────────────────────────

function ToolBtn({
  icon, label, active, color, onClick,
}: { icon: string; label: string; active: boolean; color: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display:        'flex',
        flexDirection:  'column',
        alignItems:     'center',
        justifyContent: 'center',
        gap:            2,
        width:          52,
        height:         32,
        border:         `1px solid ${active ? color : '#2a2a2a'}`,
        background:     active ? `${color}15` : 'transparent',
        color:          active ? color : '#555',
        cursor:         'pointer',
        fontFamily:     "'Courier New', monospace",
        flexShrink:     0,
        position:       'relative' as const,
        transition:     'border-color .15s, color .15s, background .15s',
      }}
    >
      <span style={{ fontSize: 11, lineHeight: 1 }}>{icon}</span>
      <span style={{ fontSize: 6, textTransform: 'uppercase', letterSpacing: '.07em', lineHeight: 1 }}>{label}</span>
      {active && (
        <div style={{
          position: 'absolute',
          bottom:   0,
          left:     0,
          right:    0,
          height:   2,
          background: color,
        }} />
      )}
    </button>
  );
}

// ── Sidebar shell ─────────────────────────────────────────────────────────────

function SidebarShell({
  activeTool,
  children,
}: { activeTool: ActiveTool; children: React.ReactNode }) {
  if (activeTool === null) return null;

  const WIDTH = activeTool === 'painter' ? 260 : 240;

  return (
    <div style={{
      width:           WIDTH,
      background:      '#0f0f0f',
      borderLeft:      '1px solid #1e1e1e',
      display:         'flex',
      flexDirection:   'column',
      flexShrink:      0,
      overflow:        'hidden',
      transition:      'width .15s',
    }}>
      {children}
    </div>
  );
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
        <p style={{ fontSize:8,color:'#222',textTransform:'uppercase',letterSpacing:'.07em',marginTop:20,lineHeight:2 }}>Select a tool from the toolbar · Ctrl+scroll: zoom · Drag: pan</p>
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
        <div style={{ fontSize:8,color:'#3a3a3a',textTransform:'uppercase',letterSpacing:'.1em',marginBottom:4 }}>Linear Chain</div>
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
            Click corners on the canvas<br />to build a chain
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

// ── Snap points sidebar ───────────────────────────────────────────────────────

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

// ── Snap tool sidebar (chain + points tabbed) ─────────────────────────────────

function SnapToolSidebar({
  engine, snapPoints, svgLines, svgCurves, pdfDims,
  highlightIdx, setHighlightIdx,
  onJumpPoint, onJumpChain, onRemoveChain,
}: {
  engine: ReturnType<typeof useSnapEngine>;
  snapPoints: SvgSnapPoint[];
  svgLines: SvgLine[];
  svgCurves: any[];
  pdfDims: PdfDimensions | null;
  highlightIdx: number | null;
  setHighlightIdx: (i: number | null) => void;
  onJumpPoint: (i: number) => void;
  onJumpChain: (i: number) => void;
  onRemoveChain: (i: number) => void;
}) {
  const [tab, setTab] = useState<'chain'|'points'>('chain');
  const typeCounts = snapPoints.reduce((acc,p)=>{acc[p.type]=(acc[p.type]??0)+1;return acc;},{} as Record<string,number>);

  return (
    <>
      {/* Sub-tabs */}
      <div style={{ display:'flex',borderBottom:'1px solid #1a1a1a',flexShrink:0 }}>
        {([['chain','Chain','#a78bfa'],['points','Points','#f59e0b']] as const).map(([key,label,color])=>(
          <button key={key} onClick={()=>setTab(key)}
            style={{ flex:1,fontSize:7,textTransform:'uppercase',letterSpacing:'.05em',padding:'6px 0',border:'none',background:tab===key?'#111':'transparent',color:tab===key?color:'#333',cursor:'pointer',borderBottom:tab===key?`1px solid ${color}`:'1px solid transparent',fontFamily:'inherit' }}>
            {label} ({key==='chain'?engine.linearChain.length:snapPoints.length})
          </button>
        ))}
      </div>

      {tab==='chain' && (
        <ChainSidebar chain={engine.linearChain} pdfDims={pdfDims} onRemove={onRemoveChain} onJump={onJumpChain} />
      )}

      {tab==='points' && (
        <>
          <div style={{ padding:10,borderBottom:'1px solid #1a1a1a' }}>
            <div style={{ fontSize:8,color:'#3a3a3a',textTransform:'uppercase',letterSpacing:'.1em',marginBottom:6 }}>Snap types</div>
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
                <PointItem key={`${p.nx.toFixed(5)}-${p.ny.toFixed(5)}-${p.type}-${i}`} point={p} pdfDims={pdfDims} isHighlighted={highlightIdx===i} onClick={()=>onJumpPoint(i)} />
              ))
            }
          </div>
        </>
      )}
    </>
  );
}

// ── Sidebar header label ──────────────────────────────────────────────────────

function SidebarHeader({ icon, label, color, onClose }: { icon: string; label: string; color: string; onClose: () => void }) {
  return (
    <div style={{
      display:       'flex',
      alignItems:    'center',
      gap:           8,
      padding:       '7px 10px',
      borderBottom:  '1px solid #1a1a1a',
      flexShrink:    0,
      background:    `${color}08`,
    }}>
      <span style={{ fontSize: 12, color }}>{icon}</span>
      <span style={{ fontSize: 8, color, textTransform: 'uppercase', letterSpacing: '.12em', fontWeight: 700, flex: 1 }}>{label}</span>
      <button
        onClick={onClose}
        title="Close panel"
        style={{ background:'transparent',border:'none',color:'#333',fontSize:13,cursor:'pointer',padding:'0 2px',lineHeight:1,fontFamily:'inherit' }}
      >×</button>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

// Extended to include 'adding' mode for multi-template CV matching
type CVSamplerMode = 'idle' | 'drawing' | 'adding' | 'matched';
type PainterDrawState = 'idle' | 'drawing' | 'naming';

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

  // ── Active tool ──────────────────────────────────────────────────────────────
  const [activeTool, setActiveTool] = useState<ActiveTool>(null);

  // ── Snap toggles ─────────────────────────────────────────────────────────────
  const [snapEnabled,     setSnapEnabled]     = useState(true);
  const [showPins,        setShowPins]        = useState(true);
  const [snapThresh,      setSnapThresh]      = useState(22);
  const [showLines,       setShowLines]       = useState(true);
  const [proximityRadius, setProximityRadius] = useState(40);
  const [linearMode,      setLinearMode]      = useState(true);

  // ── CV Sampler state ─────────────────────────────────────────────────────────
  const [cvSamplerMode, setCVSamplerMode] = useState<CVSamplerMode>('idle');
  const [cvThreshold,   setCVThreshold]   = useState(0.60);
  const [cvRotations,   setCVRotations]   = useState<number[]>([0, 45, 90, 135, 180, 225, 270, 315]);
  const [cvFlips,       setCVFlips]       = useState<boolean[]>([false, true]);
  const [cvRemoveText,  setCVRemoveText]  = useState(false);
  const [cvScales,      setCVScales]      = useState<number[]>([0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3]);
  const [cvFineStep,    setCVFineStep]    = useState(3);   // ← NEW: fine rotation step (degrees)

  // ── Pattern Painter state ─────────────────────────────────────────────────────
  const [painterDrawState, setPainterDrawState] = useState<PainterDrawState>('idle');
  const [painterRotations, setPainterRotations] = useState<number[]>([0, 90, 180, 270]);
  const [painterFlips,     setPainterFlips]     = useState<boolean[]>([false, true]);
  const [painterRemoveText,setPainterRemoveText] = useState(false);
  const pendingPainterBoxRef = useRef<{ x:number;y:number;w:number;h:number } | null>(null);

  // ── UI state ─────────────────────────────────────────────────────────────────
  const [highlightIdx, setHighlightIdx] = useState<number|null>(null);

  // ── Refs ──────────────────────────────────────────────────────────────────────
  const viewportRef   = useRef<HTMLDivElement>(null);
  const wrapRef       = useRef<HTMLDivElement>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const pinCanvasRef  = useRef<HTMLCanvasElement>(null);
  const fileInputRef  = useRef<HTMLInputElement>(null);

  const pointerDownRef = useRef(false);
  const isDraggingRef  = useRef(false);
  const dragRef        = useRef({ mx:0,my:0,px:0,py:0 });

  const panRef         = useRef(pan);
  const zoomRef        = useRef(zoom);
  const flashIdRef     = useRef(0);
  const pdfDimsRef     = useRef<PdfDimensions|null>(null);
  const pageNumberRef  = useRef(1);
  const activeToolRef  = useRef<ActiveTool>(null);

  const [flashes, setFlashes] = useState<Flash[]>([]);

  useEffect(()=>{ panRef.current     = pan;        },[pan]);
  useEffect(()=>{ zoomRef.current    = zoom;       },[zoom]);
  useEffect(()=>{ pdfDimsRef.current = pdfDims;    },[pdfDims]);
  useEffect(()=>{ activeToolRef.current = activeTool; },[activeTool]);

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

  // ── CV Matcher ────────────────────────────────────────────────────────────────
  const cvMatcher = useOpenCVMatcher();

  // Commit a rubber-band box as a CV template (primary or variation)
  const handleCVBoxCommit = useCallback(async (box: CVBox): Promise<void> => {
    const canvas = baseCanvasRef.current;
    if (!canvas) return;
    cvMatcher.buildTemplate(canvas, box, zoomRef.current, panRef.current);
    setCVSamplerMode('matched');
    await cvMatcher.findMatches(canvas, cvThreshold, cvRotations, cvFlips, cvRemoveText, cvScales);
  }, [cvMatcher, cvThreshold, cvRotations, cvFlips, cvRemoveText, cvScales]);

  // Clear everything
  const handleClearCV = useCallback(() => {
    cvMatcher.clearAll();
    setCVSamplerMode('idle');
  }, [cvMatcher]);

  // Enter primary-draw mode (clears existing templates first)
  const handleEnterCVDraw = useCallback(() => {
    cvMatcher.clearAll();
    setCVSamplerMode('drawing');
  }, [cvMatcher]);

  // Enter add-variation mode (keeps existing templates, draws a new one)
  const handleEnterCVAdd = useCallback(() => {
    setCVSamplerMode('adding');
  }, []);

  // Remove a single template by index
  const handleRemoveCVTemplate = useCallback((index: number) => {
    if (typeof cvMatcher.removeTemplate === 'function') {
      cvMatcher.removeTemplate(index);
    } else {
      // Fallback: if hook doesn't expose removeTemplate yet, clear all
      cvMatcher.clearAll();
      setCVSamplerMode('idle');
    }
  }, [cvMatcher]);

  // Drawing mode is active when either 'drawing' (primary) or 'adding' (variation)
  const isCVDrawMode =
    activeTool === 'cv' &&
    (cvSamplerMode === 'drawing' || cvSamplerMode === 'adding');

  const {
    drawBox:   cvDrawBox,
    isDrawing: cvIsDrawing,
    tooLarge:  cvTooLarge,
    startDraw: cvStartDraw,
  } = useCVRubberBand(
    viewportRef as React.RefObject<HTMLDivElement>,
    isCVDrawMode,
    handleCVBoxCommit,
  );

  // ── Pattern Painter ────────────────────────────────────────────────────────────
  const painter = usePatternPainter();

  const isPainterDrawMode = activeTool === 'painter' && painterDrawState === 'drawing';

  const handlePainterBoxCommit = useCallback((box: { x:number; y:number; w:number; h:number }) => {
    pendingPainterBoxRef.current = box;
    setPainterDrawState('naming');
  }, []);

  const handlePainterConfirmName = useCallback(async (name: string) => {
    const box    = pendingPainterBoxRef.current;
    const canvas = baseCanvasRef.current;
    if (!box || !canvas) { setPainterDrawState('idle'); return; }
    pendingPainterBoxRef.current = null;
    setPainterDrawState('idle');
    await painter.addPattern(name, canvas, box, zoomRef.current, panRef.current, {
      threshold:   0.60,
      rotations:   painterRotations,
      flips:       painterFlips,
      removeText:  painterRemoveText,
    });
  }, [painter, painterRotations, painterFlips, painterRemoveText]);

  const handlePainterCancelDraw = useCallback(() => {
    pendingPainterBoxRef.current = null;
    setPainterDrawState('idle');
  }, []);

  const handleEnterPainterDraw = useCallback(() => {
    setPainterDrawState('drawing');
  }, []);

  const {
    drawBox:   painterDrawBox,
    isDrawing: painterIsDrawing,
    tooLarge:  painterTooLarge,
    startDraw: painterStartDraw,
  } = usePatternRubberBand(
    viewportRef as React.RefObject<HTMLDivElement>,
    isPainterDrawMode,
    handlePainterBoxCommit,
  );

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
      handleClearCV();
      painter.clearAll();
      setIsLoading(false);
      fitCanvas();
      setStatus(`Loaded · ${w.toFixed(0)}×${h.toFixed(0)}px · ${lines.length} line segs · parsing snaps…`);
    } catch(err){
      setIsLoading(false);setIsIdle(true);
      setStatus(`Error: ${(err as Error).message}`);
    }
  },[fitCanvas,engine,handleClearCV,painter]);

  // ── Status line ───────────────────────────────────────────────────────────────
  useEffect(()=>{
    if(snapPoints.length===0||!pdfDims)return;
    const counts=snapPoints.reduce((acc,p)=>{acc[p.type]=(acc[p.type]??0)+1;return acc;},{} as Record<string,number>);
    const summary=(Object.entries(counts) as [string,number][]).map(([k,v])=>`${k}:${v}`).join(' · ');
    const cvPart=cvMatcher.matches.length>0?` · ${cvMatcher.matches.length} CV matches`:'';
    const ppPart=painter.patterns.length>0?` · ${painter.patterns.reduce((s,p)=>s+p.matches.length,0)} painted`:'';
    setStatus(`${snapPoints.length} snap pts · ${svgLines.length} segs · ${svgCurves.length} curves${cvPart}${ppPart} — ${summary}`);
  },[snapPoints,pdfDims,svgLines.length,svgCurves.length,cvMatcher.matches.length,painter.patterns]);

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
    const tool = activeToolRef.current;
    if(tool==='cv' && (cvSamplerMode==='drawing'||cvSamplerMode==='adding')){ cvStartDraw(e); return; }
    if(tool==='painter' && painterDrawState==='drawing'){ painterStartDraw(e); return; }
    pointerDownRef.current=true;
    isDraggingRef.current=false;
    dragRef.current={mx:e.clientX,my:e.clientY,px:panRef.current.x,py:panRef.current.y};
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[cvSamplerMode, painterDrawState, cvStartDraw, painterStartDraw]);

  const handlePointerMove = useCallback((e: React.PointerEvent)=>{
    const tool = activeToolRef.current;
    if((tool==='cv' && (cvSamplerMode==='drawing'||cvSamplerMode==='adding'))||(tool==='painter' && painterDrawState==='drawing'))return;
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[engine,getCanvasXY,cvSamplerMode,painterDrawState]);

  const handlePointerUp = useCallback((e: React.PointerEvent)=>{
    const tool = activeToolRef.current;
    if((tool==='cv'&&(cvSamplerMode==='drawing'||cvSamplerMode==='adding'))||(tool==='painter'&&painterDrawState==='drawing'))return;
    const wasActualDrag=isDraggingRef.current;
    pointerDownRef.current=false;
    isDraggingRef.current=false;
    if(wasActualDrag)return;
    if(!pdfDimsRef.current)return;
    // Only handle snap clicks when snap tool is active
    if(tool!=='snap')return;
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
      const id=++flashIdRef.current;
      setFlashes(prev=>[...prev,{id,x:vxy.x,y:vxy.y,color:'#f59e0b'}]);
      setTimeout(()=>setFlashes(prev=>prev.filter(f=>f.id!==id)),700);
      engine.triggerSnapFlash(result.point.x,result.point.y);
      setStatus(`Snapped → (${result.point.x.toFixed(1)}, ${result.point.y.toFixed(1)})`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[linearMode,engine,getCanvasXY,getViewportXY,snapPoints,cvSamplerMode,painterDrawState]);

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

  const removeChainPoint = useCallback((idx: number)=>{
    const updated=engine.linearChain.filter((_,i)=>i!==idx);
    engine.clearChain();
    updated.forEach(p=>engine.addChainPoint(p.x,p.y,p.type));
  },[engine]);

  // ── Tool switching ────────────────────────────────────────────────────────────
  const switchTool = useCallback((tool: ActiveTool) => {
    setActiveTool(prev => prev === tool ? null : tool);
    if (tool === 'cv') {
      setCVSamplerMode('idle');
    }
    if (tool === 'painter') {
      setPainterDrawState('idle');
    }
  }, []);

  // ── Cursor ────────────────────────────────────────────────────────────────────
  const isAnyDrawMode =
    (activeTool === 'cv' && (cvSamplerMode === 'drawing' || cvSamplerMode === 'adding')) ||
    (activeTool === 'painter' && painterDrawState === 'drawing');

  const cursor = (pdfDims || isAnyDrawMode) ? 'crosshair' : 'default';

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div style={S.root}>
      {/* ── Toolbar ── */}
      <div style={S.toolbar}>
        <span style={{ fontSize:9,fontWeight:700,color:'#555',textTransform:'uppercase',letterSpacing:'.1em',marginRight:4,flexShrink:0 }}>⊕ Snap Engine</span>
        <div style={S.sep} />

        {/* Load */}
        <label style={{ fontSize:8,textTransform:'uppercase',letterSpacing:'.07em',border:'1px solid #383838',background:'transparent',color:'#999',padding:'3px 9px',cursor:'pointer',fontFamily:'inherit',flexShrink:0 }}>
          ↑ Load SVG
          <input ref={fileInputRef} type="file" accept=".svg" style={{ display:'none' }} onChange={handleUpload} />
        </label>
        <div style={S.sep} />

        {/* ── Tool buttons ── */}
        <ToolBtn icon="⊕" label="Snap"    active={activeTool==='snap'}    color="#f59e0b" onClick={()=>switchTool('snap')} />
        <ToolBtn icon="⊡" label="CV Match" active={activeTool==='cv'}      color="#38bdf8" onClick={()=>switchTool('cv')} />
        <ToolBtn icon="◈" label="Painter"  active={activeTool==='painter'} color="#a78bfa" onClick={()=>switchTool('painter')} />
        <div style={S.sep} />

        {/* Snap tool sub-controls (only when snap tool active) */}
        {activeTool==='snap' && (
          <>
            <button onClick={()=>setSnapEnabled(v=>!v)} style={tbBtn(snapEnabled)}>Snap {snapEnabled?'●':'○'}</button>
            <button onClick={()=>setShowPins(v=>!v)}    style={tbBtn(showPins)}>Pins {showPins?'●':'○'}</button>
            <button onClick={()=>setShowLines(v=>!v)}   style={tbBtn(showLines,'#38bdf8')}>Lines {showLines?'●':'○'}</button>
            <div style={S.sep} />
            <button onClick={()=>setLinearMode(v=>!v)} style={tbBtn(linearMode,'#a78bfa')}>
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
            <span style={S.lblStyle}>Threshold</span>
            <input type="range" min={8} max={80} step={1} value={snapThresh} onChange={e=>setSnapThresh(+e.target.value)} style={{ width:56,accentColor:'#f59e0b' }} />
            <span style={{ fontSize:8,color:'#f59e0b',minWidth:28 }}>{snapThresh}px</span>
            <div style={S.sep} />
            <span style={S.lblStyle}>Radius</span>
            <input type="range" min={40} max={300} step={5} value={proximityRadius} onChange={e=>setProximityRadius(+e.target.value)} style={{ width:56,accentColor:'#38bdf8' }} />
            <span style={{ fontSize:8,color:'#38bdf8',minWidth:32 }}>{proximityRadius}px</span>
            <div style={S.sep} />
            <span style={{ fontSize:8,border:'1px solid #2a2a2a',padding:'2px 6px',color:snapPoints.length>0?'#f59e0b':'#333',letterSpacing:'.07em',flexShrink:0 }}>{snapPoints.length} pts</span>
          </>
        )}

        {/* CV tool sub-controls */}
        {activeTool==='cv' && (
          <>
            {cvSamplerMode==='idle' && (
              <button onClick={handleEnterCVDraw} style={tbBtn(false,'#38bdf8')}>⊡ Draw box</button>
            )}
            {(cvSamplerMode==='drawing' || cvSamplerMode==='adding') && (
              <span style={{ fontSize:8,color: cvSamplerMode==='adding' ? '#a78bfa' : '#38bdf8',textTransform:'uppercase',letterSpacing:'.07em' }}>
                {cvTooLarge
                  ? '⚠ Zoom in more'
                  : cvSamplerMode==='adding'
                  ? 'Drag box for new variation'
                  : 'Drag tight box around ONE symbol'}
              </span>
            )}
            {cvSamplerMode==='matched' && (
              <>
                <span style={{ fontSize:8,border:'1px solid #38bdf844',padding:'2px 6px',color:'#38bdf8',flexShrink:0 }}>
                  {cvMatcher.matches.length} matches
                </span>
                <button onClick={handleClearCV} style={tbBtn(false,'#f43f5e')}>Clear</button>
              </>
            )}
          </>
        )}

        {/* Painter sub-controls */}
        {activeTool==='painter' && (
          <>
            {painterDrawState==='idle' && (
              <button onClick={handleEnterPainterDraw} style={tbBtn(false,'#a78bfa')}>◈ Add pattern</button>
            )}
            {painterDrawState==='drawing' && (
              <span style={{ fontSize:8,color:'#a78bfa',textTransform:'uppercase',letterSpacing:'.07em' }}>
                {painterTooLarge ? '⚠ Zoom in more' : 'Drag tight box around ONE symbol'}
              </span>
            )}
            {painterDrawState==='naming' && (
              <span style={{ fontSize:8,color:'#a78bfa',textTransform:'uppercase',letterSpacing:'.07em' }}>
                Name pattern in sidebar →
              </span>
            )}
            {painter.patterns.length > 0 && (
              <span style={{ fontSize:8,border:'1px solid #a78bfa44',padding:'2px 6px',color:'#a78bfa',flexShrink:0 }}>
                {painter.patterns.length} pattern{painter.patterns.length!==1?'s':''} · {painter.patterns.reduce((s,p)=>s+p.matches.length,0)} instances
              </span>
            )}
          </>
        )}

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

        {/* ── Viewport ── */}
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

          {/* Snap pin overlay — always present but only draws when snap tool active */}
          <canvas
            ref={pinCanvasRef}
            style={{ position:'absolute',top:0,left:0,pointerEvents:'none',width:'100%',height:'100%',opacity: activeTool==='snap' ? 1 : 0.3 }}
          />

          {/* ── CV Match overlays ── */}
          {activeTool==='cv' && (
            <>
              <CVWorkerBanner
                isSearching={cvMatcher.isSearching}
                workerPhase={cvMatcher.workerPhase}
                workerDetail={cvMatcher.workerDetail}
              />
              <CVRubberBand
                isDrawing={cvIsDrawing}
                drawBox={cvTooLarge ? null : cvDrawBox}
                tooLarge={cvTooLarge}
                isSearching={cvMatcher.isSearching}
                workerPhase={cvMatcher.workerPhase}
                workerDetail={cvMatcher.workerDetail}
              />
              {cvIsDrawing && cvTooLarge && cvDrawBox && (
                <svg style={{ position:'absolute',inset:0,pointerEvents:'none',zIndex:36,overflow:'visible' }} width="100%" height="100%">
                  <rect x={cvDrawBox.x} y={cvDrawBox.y} width={cvDrawBox.w} height={cvDrawBox.h}
                    fill="rgba(244,63,94,0.06)" stroke="#f43f5e" strokeWidth={1.5} strokeDasharray="6 3" />
                  <rect x={cvDrawBox.x+cvDrawBox.w/2-110} y={cvDrawBox.y+cvDrawBox.h/2-13} width={220} height={24}
                    fill="#0d0d0d" stroke="#f43f5e44" rx={3} />
                  <text x={cvDrawBox.x+cvDrawBox.w/2} y={cvDrawBox.y+cvDrawBox.h/2+4}
                    textAnchor="middle" fontSize={9} fill="#f43f5e" fontFamily="'Courier New', monospace">
                    Zoom in — box covers too much of viewport
                  </text>
                </svg>
              )}
            </>
          )}
          <CVMatchOverlay matches={cvMatcher.matches} zoom={zoom} pan={pan} />

          {/* ── Pattern Painter overlays ── */}
          <PatternPainterOverlay painter={painter} zoom={zoom} pan={pan} />
          {activeTool==='painter' && (
            <>
              <PatternWorkerBanner painter={painter} />
              <PatternRubberBand
                isDrawing={painterIsDrawing}
                drawBox={painterTooLarge ? null : painterDrawBox}
                tooLarge={painterTooLarge}
              />
              {painterIsDrawing && painterTooLarge && painterDrawBox && (
                <svg style={{ position:'absolute',inset:0,pointerEvents:'none',zIndex:36,overflow:'visible' }} width="100%" height="100%">
                  <rect x={painterDrawBox.x} y={painterDrawBox.y} width={painterDrawBox.w} height={painterDrawBox.h}
                    fill="rgba(244,63,94,0.06)" stroke="#f43f5e" strokeWidth={1.5} strokeDasharray="6 3" />
                  <text x={painterDrawBox.x+painterDrawBox.w/2} y={painterDrawBox.y+painterDrawBox.h/2}
                    textAnchor="middle" fontSize={9} fill="#f43f5e" fontFamily="'Courier New', monospace">
                    Zoom in — box covers too much of viewport
                  </text>
                </svg>
              )}
            </>
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

          {/* Active mode badge */}
          {activeTool==='snap'&&linearMode&&(
            <div style={{ position:'absolute',top:10,left:10,background:'rgba(167,139,250,.15)',border:'1px solid rgba(167,139,250,.4)',padding:'3px 8px',fontSize:8,color:'#a78bfa',textTransform:'uppercase',letterSpacing:'.1em',pointerEvents:'none' }}>
              Snap · Linear mode — click to chain
            </div>
          )}
          {activeTool==='cv'&&cvSamplerMode==='drawing'&&(
            <div style={{ position:'absolute',top:10,left:10,background:'rgba(56,189,248,.12)',border:'1px solid rgba(56,189,248,.4)',padding:'3px 8px',fontSize:8,color:'#38bdf8',textTransform:'uppercase',letterSpacing:'.1em',pointerEvents:'none' }}>
              {cvTooLarge ? '⚠ Zoom in more — box too large' : 'CV Match · drag tight box around ONE symbol'}
            </div>
          )}
          {activeTool==='cv'&&cvSamplerMode==='adding'&&(
            <div style={{ position:'absolute',top:10,left:10,background:'rgba(167,139,250,.12)',border:'1px solid rgba(167,139,250,.4)',padding:'3px 8px',fontSize:8,color:'#a78bfa',textTransform:'uppercase',letterSpacing:'.1em',pointerEvents:'none' }}>
              {cvTooLarge ? '⚠ Zoom in more — box too large' : 'CV Match · drag box for new variation'}
            </div>
          )}
          {activeTool==='cv'&&cvSamplerMode==='matched'&&cvMatcher.matches.length>0&&!cvMatcher.isSearching&&(
            <div style={{ position:'absolute',top:10,left:10,background:'rgba(56,189,248,.12)',border:'1px solid rgba(56,189,248,.3)',padding:'3px 8px',fontSize:8,color:'#38bdf8',textTransform:'uppercase',letterSpacing:'.1em',pointerEvents:'none' }}>
              {cvMatcher.matches.length} CV match{cvMatcher.matches.length!==1?'es':''} · pixel-accurate
            </div>
          )}
          {activeTool==='painter'&&painterDrawState==='drawing'&&(
            <div style={{ position:'absolute',top:10,left:10,background:'rgba(167,139,250,.12)',border:'1px solid rgba(167,139,250,.4)',padding:'3px 8px',fontSize:8,color:'#a78bfa',textTransform:'uppercase',letterSpacing:'.1em',pointerEvents:'none' }}>
              {painterTooLarge ? '⚠ Zoom in more — box too large' : 'Pattern Painter · drag tight box around ONE symbol'}
            </div>
          )}
          {activeTool===null&&!isIdle&&(
            <div style={{ position:'absolute',top:10,left:10,background:'rgba(0,0,0,.5)',border:'1px solid #222',padding:'3px 8px',fontSize:8,color:'#444',textTransform:'uppercase',letterSpacing:'.1em',pointerEvents:'none' }}>
              Select a tool · Ctrl+scroll zoom · drag pan
            </div>
          )}
        </div>

        {/* ── Context-sensitive Sidebar ── */}
        <SidebarShell activeTool={activeTool}>

          {activeTool==='snap' && (
            <>
              <SidebarHeader icon="⊕" label="Snap Tool" color="#f59e0b" onClose={()=>setActiveTool(null)} />
              <SnapToolSidebar
                engine={engine}
                snapPoints={snapPoints}
                svgLines={svgLines}
                svgCurves={svgCurves}
                pdfDims={pdfDims}
                highlightIdx={highlightIdx}
                setHighlightIdx={setHighlightIdx}
                onJumpPoint={jumpToPoint}
                onJumpChain={jumpToChainPoint}
                onRemoveChain={removeChainPoint}
              />
            </>
          )}

          {activeTool==='cv' && (
            <>
              <SidebarHeader icon="⊡" label="CV Match" color="#38bdf8" onClose={()=>setActiveTool(null)} />
              <CVSamplerSidebar
                matcher={cvMatcher}
                samplerMode={cvSamplerMode}
                onEnterDraw={handleEnterCVDraw}
                onEnterAdd={handleEnterCVAdd}
                onClear={handleClearCV}
                onRemoveTemplate={handleRemoveCVTemplate}
                threshold={cvThreshold}
                onThreshold={setCVThreshold}
                rotations={cvRotations}
                onRotations={setCVRotations}
                flips={cvFlips}
                onFlips={setCVFlips}
                removeText={cvRemoveText}
                onRemoveText={setCVRemoveText}
                scales={cvScales}
                onScales={setCVScales}
                fineStep={cvFineStep}
                onFineStep={setCVFineStep}
              />
            </>
          )}

          {activeTool==='painter' && (
            <>
              <SidebarHeader icon="◈" label="Pattern Painter" color="#a78bfa" onClose={()=>setActiveTool(null)} />
              <PatternPainterSidebar
                painter={painter}
                drawState={painterDrawState}
                onEnterDraw={handleEnterPainterDraw}
                onCancelDraw={handlePainterCancelDraw}
                onConfirmName={handlePainterConfirmName}
                rotations={painterRotations}
                onRotations={setPainterRotations}
                flips={painterFlips}
                onFlips={setPainterFlips}
                removeText={painterRemoveText}
                onRemoveText={setPainterRemoveText}
                canvasRef={baseCanvasRef}
              />
            </>
          )}

        </SidebarShell>
      </div>

      {/* ── Status bar ── */}
      <div style={S.statusbar}>
        {activeTool==='snap' ? (
          (linearMode
            ? ['Hover: nearest snap','Click: add chain point','Ctrl+scroll: zoom','Drag: pan']
            : ['Hover: nearest snap','Click: snap indicator','Ctrl+scroll: zoom','Drag: pan']
          ).map((h,i)=>(
            <React.Fragment key={h}>
              {i>0&&<div style={S.barSep} />}
              <span style={{ fontSize:8,color:'#2e2e2e',textTransform:'uppercase',letterSpacing:'.07em' }}>{h}</span>
            </React.Fragment>
          ))
        ) : activeTool==='cv' ? (
          (cvSamplerMode==='drawing'
            ? [cvTooLarge?'⚠ Zoom in more':'Drag tight box around ONE symbol']
            : cvSamplerMode==='adding'
            ? [cvTooLarge?'⚠ Zoom in more':'Drag box to add a variation template']
            : ['Draw box to sample','Find all matches','Ctrl+scroll: zoom','Drag: pan']
          ).map((h,i)=>(
            <React.Fragment key={h}>
              {i>0&&<div style={S.barSep} />}
              <span style={{ fontSize:8,color:(cvSamplerMode==='drawing'||cvSamplerMode==='adding')&&cvTooLarge?'#f43f5e':'#38bdf8',textTransform:'uppercase',letterSpacing:'.07em' }}>{h}</span>
            </React.Fragment>
          ))
        ) : activeTool==='painter' ? (
          (painterDrawState==='drawing'
            ? [painterTooLarge?'⚠ Zoom in more':'Drag tight box · release to name']
            : painterDrawState==='naming'
            ? ['Enter name in sidebar → confirm']
            : ['Add patterns · each gets own color','Ctrl+scroll: zoom','Drag: pan']
          ).map((h,i)=>(
            <React.Fragment key={h}>
              {i>0&&<div style={S.barSep} />}
              <span style={{ fontSize:8,color:'#a78bfa',textTransform:'uppercase',letterSpacing:'.07em' }}>{h}</span>
            </React.Fragment>
          ))
        ) : (
          <span style={{ fontSize:8,color:'#2a2a2a',textTransform:'uppercase',letterSpacing:'.07em' }}>
            Select a tool from the toolbar to begin
          </span>
        )}

        <div style={{ flex:1 }} />

        {cvMatcher.isSearching&&(
          <><span style={{ fontSize:8,color:'#38bdf8',textTransform:'uppercase',letterSpacing:'.07em' }}>
            ⟳ {cvMatcher.workerPhase}{cvMatcher.workerDetail?' · '+cvMatcher.workerDetail:''}
          </span><div style={S.barSep} /></>
        )}
        {painter.patterns.some(p=>p.isRunning)&&(
          <><span style={{ fontSize:8,color:'#a78bfa',textTransform:'uppercase',letterSpacing:'.07em' }}>
            ⟳ {painter.workerPhase}
          </span><div style={S.barSep} /></>
        )}

        <span style={{ fontSize:8,color:'#2e2e2e',textTransform:'uppercase',letterSpacing:'.07em' }}>{fileName}</span>
      </div>
    </div>
  );
}
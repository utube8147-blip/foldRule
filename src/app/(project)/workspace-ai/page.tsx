'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Script from 'next/script';

// ── Constants ────────────────────────────────────────────────────────────────

const COLORS = [
  '#60a5fa','#34d399','#fbbf24','#f87171','#a78bfa',
  '#f472b6','#22d3ee','#a3e635','#fb923c','#818cf8',
];

const WALL_LUMA           = 120;
const STROKE_NEIGHBOR_MIN = 2;
const DILATE_R            = 2;
const ERODE_R             = 1;
const PDF_SCALE           = 3;
const SVG_SCALE           = 3;
const FILL_GROW           = 3;
const RDP_EPSILON         = 3;   // final cleanup pass after corner detection
const CORNER_ANGLE_TOL    = 15;  // degrees — direction must change by this much to count as a corner

// ── Types ─────────────────────────────────────────────────────────────────────

interface Fill {
  id: number;
  label: string;
  color: string;
  opacity: number;
  areaPx: number;
  perimPx: number;
  polygon: [number, number][];
}
type LoadStage = 'idle' | 'loading' | 'ready';

// ── Mask helpers ──────────────────────────────────────────────────────────────

function buildWallMask(data: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const dark = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (data[i*4+3] < 20) continue;
    const luma = 0.299*data[i*4] + 0.587*data[i*4+1] + 0.114*data[i*4+2];
    if (luma < WALL_LUMA) dark[i] = 1;
  }
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!dark[y*w+x]) continue;
      let n = 0;
      if (x>0   && dark[y*w+x-1])     n++;
      if (x<w-1 && dark[y*w+x+1])     n++;
      if (y>0   && dark[(y-1)*w+x])   n++;
      if (y<h-1 && dark[(y+1)*w+x])   n++;
      if (x>0   && y>0   && dark[(y-1)*w+x-1]) n++;
      if (x<w-1 && y>0   && dark[(y-1)*w+x+1]) n++;
      if (x>0   && y<h-1 && dark[(y+1)*w+x-1]) n++;
      if (x<w-1 && y<h-1 && dark[(y+1)*w+x+1]) n++;
      if (n >= STROKE_NEIGHBOR_MIN) mask[y*w+x] = 1;
    }
  }
  return mask;
}

function dilateMaskFast(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const horiz = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let count = 0;
    for (let x = 0; x < r && x < w; x++) if (src[y*w+x]) count++;
    for (let x = 0; x < w; x++) {
      const add = x + r; if (add < w && src[y*w+add]) count++;
      if (count > 0) horiz[y*w+x] = 1;
      const rem = x - r; if (rem >= 0 && src[y*w+rem]) count--;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y < r && y < h; y++) if (horiz[y*w+x]) count++;
    for (let y = 0; y < h; y++) {
      const add = y + r; if (add < h && horiz[add*w+x]) count++;
      if (count > 0) out[y*w+x] = 1;
      const rem = y - r; if (rem >= 0 && horiz[rem*w+x]) count--;
    }
  }
  return out;
}

function erodeMaskFast(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const horiz = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let zeros = 0;
    for (let x = 0; x < r && x < w; x++) if (!src[y*w+x]) zeros++;
    for (let x = 0; x < w; x++) {
      const add = x + r; if (add < w && !src[y*w+add]) zeros++;
      if (zeros === 0) horiz[y*w+x] = 1;
      const rem = x - r; if (rem >= 0 && !src[y*w+rem]) zeros--;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let zeros = 0;
    for (let y = 0; y < r && y < h; y++) if (!horiz[y*w+x]) zeros++;
    for (let y = 0; y < h; y++) {
      const add = y + r; if (add < h && !horiz[add*w+x]) zeros++;
      if (zeros === 0) out[y*w+x] = 1;
      const rem = y - r; if (rem >= 0 && !horiz[rem*w+x]) zeros--;
    }
  }
  return out;
}

function scanlineFill(mask: Uint8Array, w: number, h: number, sx: number, sy: number): Uint8Array | null {
  if (sx < 0 || sx >= w || sy < 0 || sy >= h || mask[sy*w+sx]) return null;
  const filled  = new Uint8Array(w * h);
  const visited = new Uint8Array(w * h);
  const stack   = new Int32Array(w * h);
  let top = 0;
  stack[top++] = sy * w + sx;
  visited[sy*w+sx] = 1;
  while (top > 0) {
    const idx = stack[--top];
    const cy  = (idx / w) | 0;
    const cx  = idx % w;
    let left = cx;
    while (left > 0 && !mask[cy*w+left-1] && !visited[cy*w+left-1]) left--;
    let right = cx;
    while (right < w-1 && !mask[cy*w+right+1] && !visited[cy*w+right+1]) right++;
    for (let x = left; x <= right; x++) { filled[cy*w+x] = 1; visited[cy*w+x] = 1; }
    const up = (cy-1)*w, dn = (cy+1)*w;
    for (let x = left; x <= right; x++) {
      if (cy > 0   && !mask[up+x] && !visited[up+x]) { visited[up+x]=1; stack[top++]=up+x; }
      if (cy < h-1 && !mask[dn+x] && !visited[dn+x]) { visited[dn+x]=1; stack[top++]=dn+x; }
    }
  }
  let count = 0;
  for (let i = 0; i < filled.length; i++) if (filled[i]) count++;
  return count > 4 ? filled : null;
}

function multiSeedFill(mask: Uint8Array, w: number, h: number, cx: number, cy: number): Uint8Array | null {
  const OFFSETS: [number,number][] = [
    [0,0],[1,0],[-1,0],[0,1],[0,-1],
    [2,0],[-2,0],[0,2],[0,-2],
    [1,1],[-1,1],[1,-1],[-1,-1],
  ];
  let merged: Uint8Array | null = null;
  let mergedDilated: Uint8Array | null = null;
  for (const [dx, dy] of OFFSETS) {
    const f = scanlineFill(mask, w, h, cx+dx, cy+dy);
    if (!f) continue;
    if (!merged) {
      merged = f;
      mergedDilated = dilateMaskFast(f, w, h, FILL_GROW + 2);
    } else {
      let overlaps = false;
      for (let i = 0; i < f.length; i++) { if (f[i] && mergedDilated![i]) { overlaps = true; break; } }
      if (overlaps) {
        for (let i = 0; i < merged.length; i++) if (f[i]) merged[i] = 1;
        mergedDilated = dilateMaskFast(merged, w, h, FILL_GROW + 2);
      }
    }
  }
  return merged;
}

function paintFill(
  filled: Uint8Array, fillData: ImageData,
  r: number, g: number, b: number, opacity: number,
): number {
  let count = 0;
  const newA = opacity;
  const d = fillData.data;
  for (let i = 0; i < filled.length; i++) {
    if (!filled[i]) continue;
    count++;
    const di = i * 4;
    const existA = d[di+3] / 255;
    const outA = newA + existA * (1 - newA);
    if (outA > 0) {
      d[di]   = ((r * newA + d[di]   * existA * (1 - newA)) / outA) | 0;
      d[di+1] = ((g * newA + d[di+1] * existA * (1 - newA)) / outA) | 0;
      d[di+2] = ((b * newA + d[di+2] * existA * (1 - newA)) / outA) | 0;
      d[di+3] = (outA * 255) | 0;
    }
  }
  return count;
}

function closeHoles(filled: Uint8Array, w: number, h: number): Uint8Array {
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number) => {
    if (i >= 0 && i < w * h && !filled[i] && !outside[i]) { outside[i] = 1; stack.push(i); }
  };
  for (let x = 0; x < w; x++) { push(x); push((h-1)*w+x); }
  for (let y = 1; y < h-1; y++) { push(y*w); push(y*w+w-1); }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w, y = (i / w) | 0;
    if (x > 0)   push(i - 1);
    if (x < w-1) push(i + 1);
    if (y > 0)   push(i - w);
    if (y < h-1) push(i + w);
  }
  const closed = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) closed[i] = filled[i] || (!outside[i] ? 1 : 0);
  return closed;
}

// ── Outer shape: small erode/dilate to keep corners sharp ─────────────────────
// Using radius 2 (was 6) so rectangular corners are preserved.
function outerShape(filled: Uint8Array, w: number, h: number): Uint8Array {
  const eroded   = erodeMaskFast(filled,  w, h, 2);
  const restored = dilateMaskFast(eroded, w, h, 2);
  return restored;
}

function findPerimeter(filled: Uint8Array, w: number, h: number): Uint8Array {
  const perim = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!filled[y * w + x]) continue;
      if (
        x === 0     || !filled[y * w + (x - 1)] ||
        x === w - 1 || !filled[y * w + (x + 1)] ||
        y === 0     || !filled[(y - 1) * w + x] ||
        y === h - 1 || !filled[(y + 1) * w + x]
      ) perim[y * w + x] = 1;
    }
  }
  return perim;
}

function measurePerim(perimMask: Uint8Array, w: number, h: number): number {
  let c = 0;
  for (let i = 0; i < perimMask.length; i++) {
    if (!perimMask[i]) continue;
    const x = i % w, y = (i / w) | 0;
    const diag =
      (x > 0   && y > 0   && perimMask[(y-1)*w+(x-1)]) ||
      (x < w-1 && y > 0   && perimMask[(y-1)*w+(x+1)]) ||
      (x > 0   && y < h-1 && perimMask[(y+1)*w+(x-1)]) ||
      (x < w-1 && y < h-1 && perimMask[(y+1)*w+(x+1)]);
    c += diag ? 1.41 : 1;
  }
  return Math.round(c);
}

// ── 4-directional contour tracing (no diagonals = no zigzag steps) ────────────
// Uses square tracing algorithm: always tries to turn right first.
// Produces a clean axis-aligned chain that RDP can then aggressively simplify.
function traceContour(perim: Uint8Array, w: number, h: number): [number, number][] {
  // Find topmost-leftmost perimeter pixel
  let startIdx = -1;
  for (let i = 0; i < perim.length; i++) {
    if (perim[i]) { startIdx = i; break; }
  }
  if (startIdx === -1) return [];

  // 4 directions: right=0, down=1, left=2, up=3
  const DX = [1, 0, -1, 0];
  const DY = [0, 1, 0, -1];

  const pts: [number, number][] = [];
  const sx = startIdx % w, sy = (startIdx / w) | 0;
  let cx = sx, cy = sy;
  // Starting moving right; try right-turn first (clockwise boundary walk)
  let dir = 0;
  const maxSteps = perim.length;
  let steps = 0;

  do {
    pts.push([cx, cy]);
    // Try turning right, then straight, then left, then back
    let moved = false;
    for (let t = 0; t < 4; t++) {
      const nd = (dir + 3 + t) % 4; // right turn = (dir-1+4)%4, then straight, left, back
      const nx = cx + DX[nd], ny = cy + DY[nd];
      if (nx >= 0 && nx < w && ny >= 0 && ny < h && perim[ny * w + nx]) {
        cx = nx; cy = ny; dir = nd; moved = true; break;
      }
    }
    if (!moved) break;
    if (++steps > maxSteps) break;
  } while (cx !== sx || cy !== sy);

  return pts;
}

// ── Remove collinear points (runs of same direction) ─────────────────────────
// This is the KEY step: a straight wall produces dozens of collinear pixels.
// Merging them before RDP means RDP gets clean segment endpoints, not noise.
function removeCollinear(pts: [number, number][], tol: number): [number, number][] {
  if (pts.length < 3) return pts;
  const distToLine = (p: [number,number], a: [number,number], b: [number,number]) => {
    const [ax, ay] = a, [bx, by] = b, [px, py] = p;
    const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px-ax)*(bx-ax) + (py-ay)*(by-ay)) / len2));
    return Math.hypot(px - (ax + t*(bx-ax)), py - (ay + t*(by-ay)));
  };
  const out: [number, number][] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToLine(pts[i], out[out.length - 1], pts[i + 1]);
    if (d > tol) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// ── Ramer-Douglas-Peucker simplification ─────────────────────────────────────
function rdpSimplify(pts: [number, number][], eps: number): [number, number][] {
  if (pts.length <= 2) return pts;

  const distToLine = (p: [number,number], a: [number,number], b: [number,number]) => {
    const [ax, ay] = a, [bx, by] = b, [px, py] = p;
    const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px-ax)*(bx-ax) + (py-ay)*(by-ay)) / len2));
    return Math.hypot(px - (ax + t*(bx-ax)), py - (ay + t*(by-ay)));
  };

  const keep = new Set<number>([0, pts.length - 1]);
  const rec = (lo: number, hi: number) => {
    if (hi - lo < 2) return;
    let maxD = 0, idx = lo;
    for (let i = lo + 1; i < hi; i++) {
      const d = distToLine(pts[i], pts[lo], pts[hi]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps) { keep.add(idx); rec(lo, idx); rec(idx, hi); }
  };
  rec(0, pts.length - 1);
  return [...keep].sort((a, b) => a - b).map(i => pts[i]);
}

// ── Combined: trace → remove collinear → RDP ─────────────────────────────────
function buildPolygon(perim: Uint8Array, w: number, h: number): [number, number][] {
  const raw        = traceContour(perim, w, h);
  const decollined = removeCollinear(raw, COLLINEAR_TOL);
  const simplified = rdpSimplify(decollined, RDP_EPSILON);
  return simplified;
}

// ── Misc helpers ───────────────────────────────────────────────────────────────

function hexToRgb(hex: string) {
  return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)] as const;
}

function fmtArea(px: number, pxPerM: number | null): string {
  if (!pxPerM) return `${px.toLocaleString()} px²`;
  const m2 = px / (pxPerM * pxPerM);
  return m2 >= 1 ? `${m2.toFixed(2)} m²` : `${(m2 * 1e6).toFixed(0)} mm²`;
}

function fmtPerim(px: number, pxPerM: number | null): string {
  if (!pxPerM) return `${px.toLocaleString()} px`;
  const m = px / pxPerM;
  return m >= 1 ? `${m.toFixed(2)} m` : `${(m * 100).toFixed(1)} cm`;
}

// ── Loading screen ─────────────────────────────────────────────────────────────

const LOAD_LINES = [
  'Parsing document structure',
  'Rasterising vector geometry',
  'Sampling pixel luminance',
  'Classifying stroke connectivity',
  'Morphological mask refinement',
  'Indexing fill regions',
];

function LoadingScreen({ stage, progress, fileName }: { stage: LoadStage; progress: string; fileName: string }) {
  const [dots, setDots] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (stage !== 'loading') { setTick(0); setDots(''); return; }
    const id = setInterval(() => {
      setDots(d => d.length >= 3 ? '' : d + '.');
      setTick(t => (t + 1) % (LOAD_LINES.length * 4));
    }, 420);
    return () => clearInterval(id);
  }, [stage]);
  if (stage === 'ready') return null;
  const lineIdx = tick % LOAD_LINES.length;
  return (
    <div style={{ position:'absolute',inset:0,zIndex:100,background:'#0c0c0c',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',fontFamily:"'Courier New',monospace" }}>
      <style>{`@keyframes gridmove{from{background-position:0 0}to{background-position:40px 40px}}@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
      <div style={{ position:'absolute',inset:0,opacity:.055,backgroundImage:'linear-gradient(#f59e0b 1px,transparent 1px),linear-gradient(90deg,#f59e0b 1px,transparent 1px)',backgroundSize:'40px 40px',animation:'gridmove 6s linear infinite',pointerEvents:'none' }}/>
      <div style={{ position:'relative',zIndex:1,textAlign:'center',width:320 }}>
        <div style={{ position:'relative',width:56,height:56,margin:'0 auto 26px' }}>
          <div style={{ position:'absolute',inset:0,border:'1.5px solid #1c1c1c',borderRadius:'50%' }}/>
          {stage==='loading' && <div style={{ position:'absolute',inset:0,border:'1.5px solid transparent',borderTopColor:'#f59e0b',borderRadius:'50%',animation:'spin .9s linear infinite' }}/>}
          <div style={{ position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize:22,color:'#f59e0b' }}>⊕</div>
        </div>
        <div style={{ fontSize:10,fontWeight:700,color:'#f59e0b',textTransform:'uppercase',letterSpacing:'.18em',marginBottom:4 }}>
          {stage==='idle' ? 'FloodFill Studio' : 'Processing'}
        </div>
        {stage==='idle' && (
          <>
            <p style={{ fontSize:9,color:'#333',textTransform:'uppercase',letterSpacing:'.1em',margin:'14px 0 20px' }}>Load a PDF or SVG floor plan to begin</p>
            <div style={{ display:'flex',gap:10,justifyContent:'center' }}>
              {['PDF','SVG'].map(t=><div key={t} style={{ border:'1px solid #1e1e1e',padding:'6px 18px',fontSize:9,color:'#2a2a2a',textTransform:'uppercase',letterSpacing:'.12em' }}>{t}</div>)}
            </div>
            <p style={{ fontSize:8,color:'#222',textTransform:'uppercase',letterSpacing:'.08em',marginTop:20,lineHeight:2 }}>Perimeter highlighted · Area + perimeter measured · Wall-safe outline</p>
          </>
        )}
        {stage==='loading' && (
          <>
            <div style={{ fontSize:9,color:'#444',marginBottom:22,minHeight:13 }}>{fileName}</div>
            <div style={{ textAlign:'left',padding:'0 8px',marginBottom:20 }}>
              {LOAD_LINES.map((line,i) => {
                const isActive=i===lineIdx, isDone=i<lineIdx;
                return (
                  <div key={line} style={{ display:'flex',alignItems:'center',gap:10,padding:'3px 0',opacity:isActive?1:isDone?.3:.1,transition:'opacity .35s' }}>
                    <span style={{ fontSize:10,color:isActive?'#f59e0b':isDone?'#444':'#222',minWidth:10 }}>{isActive?'›':isDone?'✓':'·'}</span>
                    <span style={{ fontSize:9,color:isActive?'#bbb':'#444',textTransform:'uppercase',letterSpacing:'.07em' }}>{line}{isActive?dots:''}</span>
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize:8,color:'#2a2a2a',textTransform:'uppercase',letterSpacing:'.1em' }}>{progress}</div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Scale bar ─────────────────────────────────────────────────────────────────

function ScaleBar({ pxPerM, onChange }: { pxPerM: number | null; onChange: (v: number | null) => void }) {
  const [raw, setRaw] = useState('');
  const [editing, setEditing] = useState(false);
  const commit = () => { const n=parseFloat(raw); onChange(isFinite(n)&&n>0?n:null); setEditing(false); };
  return (
    <div style={{ display:'flex',alignItems:'center',gap:4,flexShrink:0 }}>
      <span style={lblStyle}>px/m</span>
      {editing
        ? <input autoFocus value={raw} onChange={e=>setRaw(e.target.value)} onBlur={commit}
            onKeyDown={e=>{ if(e.key==='Enter') commit(); if(e.key==='Escape') setEditing(false); }}
            style={{ width:52,fontSize:8,fontFamily:'inherit',background:'#111',color:'#f59e0b',border:'1px solid #f59e0b',padding:'2px 4px',textAlign:'right' }} placeholder="e.g. 120"/>
        : <button onClick={()=>{ setRaw(pxPerM!=null?String(pxPerM):''); setEditing(true); }}
            style={{ ...tbBtn(pxPerM!=null),minWidth:52,textAlign:'right' as const }}>
            {pxPerM!=null?pxPerM:'— set —'}
          </button>
      }
      {pxPerM!=null && <button onClick={()=>onChange(null)} style={{ ...tbBtn(false),color:'#555',padding:'3px 4px' }}>✕</button>}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function FloodFillPage() {
  const [activeColor,    setActiveColor]    = useState(COLORS[0]);
  const [fillOpacity,    setFillOpacity]    = useState(40);
  const [zoom,           setZoom]           = useState(1);
  const [pan,            setPan]            = useState({ x:0, y:0 });
  const [mode,           setMode]           = useState<'fill'|'pan'>('fill');
  const [isDragging,     setIsDragging]     = useState(false);
  const [isFilling,      setIsFilling]      = useState(false);
  const [fills,          setFills]          = useState<Fill[]>([]);
  const [hiddenIds,      setHiddenIds]      = useState<Set<number>>(new Set());
  const [selectedId,     setSelectedId]     = useState<number|null>(null);
  const [hoveredId,      setHoveredId]      = useState<number|null>(null);
  const [hoverPos,       setHoverPos]       = useState<{x:number,y:number}>({x:0,y:0});
  const [holesClosedIds, setHolesClosedIds] = useState<Set<number>>(new Set());
  const [showPolygon,    setShowPolygon]    = useState(true);
  const [status,         setStatus]         = useState('');
  const [fileName,       setFileName]       = useState('');
  const [loadStage,      setLoadStage]      = useState<LoadStage>('idle');
  const [loadProgress,   setLoadProgress]   = useState('');
  const [pxPerM,         setPxPerM]         = useState<number|null>(null);

  const viewportRef   = useRef<HTMLDivElement>(null);
  const wrapRef       = useRef<HTMLDivElement>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const fillCanvasRef = useRef<HTMLCanvasElement>(null);
  const polyCanvasRef = useRef<HTMLCanvasElement>(null);
  const maskRef       = useRef<Uint8Array|null>(null);
  const fillDataRef   = useRef<ImageData|null>(null);
  const basePixelsRef = useRef<Uint8ClampedArray|null>(null);
  const dragRef       = useRef({ mx:0,my:0,px:0,py:0 });
  const fillCountRef  = useRef(0);
  const fileInputRef  = useRef<HTMLInputElement>(null);
  const snapshots     = useRef<ImageData[]>([]);
  const fillPixelMaps = useRef<Map<number, Uint8Array>>(new Map());
  const fillsRef      = useRef<Fill[]>([]);
  useEffect(() => { fillsRef.current = fills; }, [fills]);

  const showPolygonRef = useRef(showPolygon);
  useEffect(() => { showPolygonRef.current = showPolygon; }, [showPolygon]);

  useEffect(() => {
    if (wrapRef.current)
      wrapRef.current.style.transform = `translate(${pan.x}px,${pan.y}px) scale(${zoom})`;
  }, [pan, zoom]);

  const centerCanvas = useCallback(() => {
    const vp=viewportRef.current, bc=baseCanvasRef.current; if(!vp||!bc) return;
    const vr=vp.getBoundingClientRect();
    const fz=Math.min((vr.width*.9)/bc.width,(vr.height*.9)/bc.height,1);
    setZoom(fz); setPan({ x:(vr.width-bc.width*fz)/2, y:(vr.height-bc.height*fz)/2 });
  }, []);

  // ── Polygon canvas redraw ──────────────────────────────────────────────────

  const redrawPolygons = useCallback((
    currentFills: Fill[],
    currentHidden: Set<number>,
    currentSelected: number | null,
  ) => {
    const pc = polyCanvasRef.current, bc = baseCanvasRef.current;
    if (!pc || !bc) return;
    if (pc.width !== bc.width || pc.height !== bc.height) {
      pc.width = bc.width; pc.height = bc.height;
    }
    const ctx = pc.getContext('2d')!;
    ctx.clearRect(0, 0, pc.width, pc.height);

    if (!showPolygonRef.current) return;

    currentFills.forEach(f => {
      if (currentHidden.has(f.id) || f.polygon.length < 3) return;
      const pts = f.polygon;
      const [r, g, b] = hexToRgb(f.color);
      const isSelected = f.id === currentSelected;

      // Outer polygon stroke
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
      ctx.strokeStyle = `rgba(${r},${g},${b},${isSelected ? 1 : 0.7})`;
      ctx.lineWidth   = isSelected ? 2.5 : 1.8;
      ctx.setLineDash([]);
      ctx.stroke();

      // Dashed inner outline
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
      ctx.strokeStyle = `rgba(255,255,255,${isSelected ? 0.25 : 0.12})`;
      ctx.lineWidth   = isSelected ? 1 : 0.7;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Vertex dots
      pts.forEach(([x, y]) => {
        ctx.beginPath();
        ctx.arc(x, y, isSelected ? 5 : 3.5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,${isSelected ? 0.9 : 0.6})`;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(x, y, isSelected ? 3.5 : 2.5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${r},${g},${b},1)`;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(x, y, isSelected ? 1.5 : 1, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fill();
      });
    });
  }, []);

  useEffect(() => {
    redrawPolygons(fills, hiddenIds, selectedId);
  }, [fills, selectedId, hiddenIds, showPolygon, redrawPolygons]);

  // ── Mask building ──────────────────────────────────────────────────────────

  const buildMaskAsync = useCallback((bc: HTMLCanvasElement, fc: HTMLCanvasElement): Promise<void> => {
    return new Promise(resolve => {
      const ctx=bc.getContext('2d')!;
      const id=ctx.getImageData(0,0,bc.width,bc.height);
      const w=bc.width, h=bc.height;
      const step=(fn:()=>void,label:string,next:()=>void)=>{ setLoadProgress(label); setTimeout(()=>{ fn(); next(); },0); };
      step(()=>{},'Classifying stroke connectivity…',()=>{
        const raw=buildWallMask(id.data,w,h);
        step(()=>{},'Dilating mask…',()=>{
          const dilated=dilateMaskFast(raw,w,h,DILATE_R);
          step(()=>{},'Eroding mask…',()=>{
            maskRef.current       = erodeMaskFast(dilated,w,h,ERODE_R);
            fillDataRef.current   = new ImageData(w,h);
            basePixelsRef.current = new Uint8ClampedArray(id.data);
            fillCountRef.current  = 0;
            snapshots.current     = [];
            fillPixelMaps.current.clear();
            fc.width=w; fc.height=h;
            const pc = polyCanvasRef.current;
            if (pc) { pc.width=w; pc.height=h; pc.getContext('2d')!.clearRect(0,0,w,h); }
            setFills([]); setHiddenIds(new Set()); setSelectedId(null);
            setHoveredId(null); setHolesClosedIds(new Set());
            resolve();
          });
        });
      });
    });
  }, []);

  const loadPdf = useCallback(async (file: File) => {
    setLoadProgress('Initialising PDF.js…');
    let pdfjsLib=(window as any).pdfjsLib as any;
    if (!pdfjsLib) {
      await new Promise<void>((res,rej)=>{
        let tries=0;
        const id=setInterval(()=>{ pdfjsLib=(window as any).pdfjsLib; if(pdfjsLib){clearInterval(id);res();} else if(++tries>60){clearInterval(id);rej(new Error('PDF.js timed out'));} },100);
      });
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
    setLoadProgress('Parsing PDF…'); await new Promise(r=>setTimeout(r,0));
    const ab=await file.arrayBuffer();
    const doc=await pdfjsLib.getDocument({data:ab}).promise;
    const page=await doc.getPage(1);
    const vp=page.getViewport({scale:PDF_SCALE});
    const bc=baseCanvasRef.current!, fc=fillCanvasRef.current!;
    bc.width=vp.width; bc.height=vp.height;
    const ctx=bc.getContext('2d')!;
    ctx.fillStyle='#ffffff'; ctx.fillRect(0,0,bc.width,bc.height);
    setLoadProgress('Rendering page…'); await new Promise(r=>setTimeout(r,0));
    await page.render({canvasContext:ctx,viewport:vp}).promise;
    await buildMaskAsync(bc,fc);
    setStatus(`Loaded · page 1/${doc.numPages} · ${bc.width}×${bc.height}px`);
  }, [buildMaskAsync]);

  const loadSvg = useCallback(async (file: File) => {
    setLoadProgress('Reading SVG…'); await new Promise(r=>setTimeout(r,0));
    const text=await file.text();
    const parser=new DOMParser();
    const d=parser.parseFromString(text,'image/svg+xml');
    const svg=d.querySelector('svg'); if(!svg) throw new Error('Invalid SVG');
    const sw=Math.max(2,Math.ceil(SVG_SCALE*1.2));
    const st=d.createElementNS('http://www.w3.org/2000/svg','style');
    st.textContent=`line,polyline,polygon,rect,circle,ellipse,path{stroke:#000!important;stroke-width:${sw}px!important;stroke-opacity:1!important;paint-order:stroke fill;}`;
    svg.insertBefore(st,svg.firstChild);
    const blob=new Blob([new XMLSerializer().serializeToString(d)],{type:'image/svg+xml'});
    const url=URL.createObjectURL(blob);
    const img=new Image();
    await new Promise<void>((res,rej)=>{ img.onload=()=>res(); img.onerror=rej; img.src=url; });
    URL.revokeObjectURL(url);
    const vb=svg.viewBox?.baseVal;
    const W=vb?.width||img.width||800, H=vb?.height||img.height||600;
    const cw=Math.round(W*SVG_SCALE), ch=Math.round(H*SVG_SCALE);
    const bc=baseCanvasRef.current!, fc=fillCanvasRef.current!;
    bc.width=cw; bc.height=ch;
    const ctx=bc.getContext('2d')!;
    ctx.fillStyle='#ffffff'; ctx.fillRect(0,0,cw,ch); ctx.drawImage(img,0,0,cw,ch);
    await buildMaskAsync(bc,fc);
    setStatus(`Loaded · ${cw}×${ch}px`);
  }, [buildMaskAsync]);

  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file=e.target.files?.[0]; if(!file) return;
    e.target.value='';
    const isPdf=file.name.toLowerCase().endsWith('.pdf');
    setFileName(file.name); setLoadStage('loading'); setLoadProgress('Starting…');
    setZoom(1); setPan({x:0,y:0});
    try {
      if(isPdf) await loadPdf(file); else await loadSvg(file);
      setLoadStage('ready'); centerCanvas();
    } catch(err) {
      setLoadStage('idle'); setStatus(`Error: ${(err as Error).message}`);
    }
  }, [loadPdf, loadSvg, centerCanvas]);

  // ── Shared fill processing ─────────────────────────────────────────────────
  // Uses outerShape (small r=2 erode/dilate) → findPerimeter → buildPolygon
  // (4-dir trace → removeCollinear → rdpSimplify with eps=8)

  const processFilledMask = useCallback((grown: Uint8Array, w: number, h: number) => {
    const areaPx = (() => { let c=0; for(let i=0;i<grown.length;i++) if(grown[i]) c++; return c; })();
    const outer     = outerShape(grown, w, h);
    const perimMask = findPerimeter(outer, w, h);
    const perimPx   = measurePerim(perimMask, w, h);
    const polygon   = buildPolygon(perimMask, w, h);
    return { areaPx, perimPx, polygon };
  }, []);

  // ── Fill click ─────────────────────────────────────────────────────────────

  const doFill = useCallback(async (e: React.MouseEvent) => {
    if (mode!=='fill'||isFilling||loadStage!=='ready') return;
    if (!maskRef.current||!fillDataRef.current||!basePixelsRef.current) return;
    const vp=viewportRef.current!;
    const vr=vp.getBoundingClientRect();
    const px=Math.round((e.clientX-vr.left-pan.x)/zoom);
    const py=Math.round((e.clientY-vr.top -pan.y)/zoom);
    const bc=baseCanvasRef.current!;
    if(px<0||px>=bc.width||py<0||py>=bc.height) return;

    setIsFilling(true); setStatus('Filling…');
    await new Promise<void>(r=>requestAnimationFrame(()=>r()));

    snapshots.current.push(new ImageData(
      new Uint8ClampedArray(fillDataRef.current!.data),
      fillDataRef.current!.width, fillDataRef.current!.height,
    ));

    const filled=multiSeedFill(maskRef.current,bc.width,bc.height,px,py);
    if(!filled) {
      snapshots.current.pop(); setIsFilling(false);
      setStatus('Clicked on a wall — try the room centre'); return;
    }

    const grown = dilateMaskFast(filled, bc.width, bc.height, FILL_GROW);
    const [r,g,b] = hexToRgb(activeColor);

    paintFill(grown, fillDataRef.current!, r, g, b, fillOpacity/100);
    fillCanvasRef.current!.getContext('2d')!.putImageData(fillDataRef.current!, 0, 0);

    const { areaPx, perimPx, polygon } = processFilledMask(grown, bc.width, bc.height);

    fillCountRef.current += 1;
    const newFill: Fill = {
      id: Date.now(),
      label: `Fill ${fillCountRef.current}`,
      color: activeColor,
      opacity: fillOpacity,
      areaPx,
      perimPx,
      polygon,
    };

    fillPixelMaps.current.set(newFill.id, grown);

    setFills(prev => {
      const next = [...prev, newFill];
      setTimeout(() => redrawPolygons(next, hiddenIds, newFill.id), 0);
      return next;
    });
    setSelectedId(newFill.id);
    setIsFilling(false);
    setStatus(`Filled · ${polygon.length} corners · area ${fmtArea(areaPx,pxPerM)} · perimeter ${fmtPerim(perimPx,pxPerM)}`);
  }, [mode,isFilling,loadStage,pan,zoom,activeColor,fillOpacity,pxPerM,hiddenIds,redrawPolygons,processFilledMask]);

  // ── Undo ───────────────────────────────────────────────────────────────────

  const handleUndo = useCallback(() => {
    if(!snapshots.current.length||!fillDataRef.current) return;
    const prev = snapshots.current.pop()!;
    fillDataRef.current.data.set(prev.data);
    fillCanvasRef.current!.getContext('2d')!.putImageData(fillDataRef.current, 0, 0);
    setFills(f => {
      const next = f.slice(0,-1);
      if(f.length > 0) fillPixelMaps.current.delete(f[f.length-1].id);
      const newSelected = next.length ? next[next.length-1].id : null;
      setSelectedId(newSelected);
      setTimeout(() => redrawPolygons(next, hiddenIds, newSelected), 0);
      return next;
    });
    setHoveredId(null);
    setStatus('Undo');
  }, [hiddenIds, redrawPolygons]);

  // ── Clear all ──────────────────────────────────────────────────────────────

  const handleClearAll = useCallback(() => {
    if(!fillDataRef.current) return;
    fillDataRef.current.data.fill(0);
    fillCanvasRef.current!.getContext('2d')!.clearRect(0,0,fillCanvasRef.current!.width,fillCanvasRef.current!.height);
    const pc = polyCanvasRef.current;
    if(pc) pc.getContext('2d')!.clearRect(0,0,pc.width,pc.height);
    snapshots.current = []; fillCountRef.current = 0;
    fillPixelMaps.current.clear();
    setFills([]); setHiddenIds(new Set()); setSelectedId(null);
    setHoveredId(null); setHolesClosedIds(new Set()); setStatus('Cleared');
  }, []);

  // ── Fill holes ─────────────────────────────────────────────────────────────

  const handleFillHoles = useCallback(async () => {
    if (!selectedId || !fillDataRef.current || !basePixelsRef.current) return;
    const pixMap = fillPixelMaps.current.get(selectedId);
    if (!pixMap) return;
    const bc = baseCanvasRef.current!;
    const w = bc.width, h = bc.height;
    const fill = fillsRef.current.find(f => f.id === selectedId);
    if (!fill) return;

    setIsFilling(true); setStatus('Closing holes…');
    await new Promise<void>(r => requestAnimationFrame(() => r()));

    snapshots.current.push(new ImageData(
      new Uint8ClampedArray(fillDataRef.current!.data), w, h,
    ));

    const closed = closeHoles(pixMap, w, h);
    const added  = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) if (closed[i] && !pixMap[i]) added[i] = 1;

    const [r, g, b] = hexToRgb(fill.color);
    paintFill(added, fillDataRef.current!, r, g, b, fill.opacity / 100);
    fillCanvasRef.current!.getContext('2d')!.putImageData(fillDataRef.current!, 0, 0);

    const { areaPx, perimPx, polygon } = processFilledMask(closed, w, h);
    fillPixelMaps.current.set(selectedId, closed);

    setFills(prev => {
      const next = prev.map(f =>
        f.id === selectedId ? { ...f, areaPx, perimPx, polygon } : f
      );
      setTimeout(() => redrawPolygons(next, hiddenIds, selectedId), 0);
      return next;
    });
    setHolesClosedIds(prev => new Set(prev).add(selectedId));
    setIsFilling(false);
    setStatus(`Holes closed · ${polygon.length} corners · area ${fmtArea(areaPx, pxPerM)} · perimeter ${fmtPerim(perimPx, pxPerM)}`);
  }, [selectedId, pxPerM, hiddenIds, redrawPolygons, processFilledMask]);

  // ── Hover hit-test ─────────────────────────────────────────────────────────

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (loadStage !== 'ready' || mode !== 'fill') { setHoveredId(null); return; }
    const vp = viewportRef.current!;
    const vr = vp.getBoundingClientRect();
    const px = Math.round((e.clientX - vr.left - pan.x) / zoom);
    const py = Math.round((e.clientY - vr.top  - pan.y) / zoom);
    const bc = baseCanvasRef.current!;
    if (px < 0 || px >= bc.width || py < 0 || py >= bc.height) { setHoveredId(null); return; }
    const idx = py * bc.width + px;
    let found: number | null = null;
    const cf = fillsRef.current;
    for (let i = cf.length - 1; i >= 0; i--) {
      const map = fillPixelMaps.current.get(cf[i].id);
      if (map && map[idx]) { found = cf[i].id; break; }
    }
    setHoveredId(found);
    setHoverPos({ x: e.clientX - vr.left, y: e.clientY - vr.top });
  }, [loadStage, mode, pan, zoom]);

  // ── Wheel zoom ─────────────────────────────────────────────────────────────

  const wheelHandlerRef = useRef<(e:WheelEvent)=>void>(()=>{});
  useEffect(() => {
    wheelHandlerRef.current = (e: WheelEvent) => {
      e.preventDefault();
      const vp = viewportRef.current; if(!vp) return;
      const vr = vp.getBoundingClientRect();
      if(e.ctrlKey){
        const mx=e.clientX-vr.left, my=e.clientY-vr.top;
        const f=e.deltaY>0?.92:1.08;
        setZoom(z=>{ const nz=Math.min(20,Math.max(0.05,z*f)); setPan(p=>({x:mx-(mx-p.x)*(nz/z),y:my-(my-p.y)*(nz/z)})); return nz; });
        return;
      }
      setPan(p=>({x:p.x-e.deltaX,y:p.y-e.deltaY}));
    };
  });
  useEffect(() => {
    const vp = viewportRef.current; if(!vp) return;
    const h = (e:WheelEvent) => wheelHandlerRef.current(e);
    vp.addEventListener('wheel',h,{passive:false});
    return () => vp.removeEventListener('wheel',h);
  }, []);

  // ── Pointer pan ────────────────────────────────────────────────────────────

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if(mode!=='pan') return;
    setIsDragging(true);
    dragRef.current = { mx:e.clientX, my:e.clientY, px:pan.x, py:pan.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, [mode, pan]);
  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if(!isDragging) return;
    setPan({ x:dragRef.current.px+e.clientX-dragRef.current.mx, y:dragRef.current.py+e.clientY-dragRef.current.my });
  }, [isDragging]);
  const handlePointerUp = useCallback(() => setIsDragging(false), []);

  // ── Export ─────────────────────────────────────────────────────────────────

  const handleExport = useCallback(() => {
    const bc=baseCanvasRef.current, fc=fillCanvasRef.current, pc=polyCanvasRef.current;
    if(!bc||!fc) return;
    const out = document.createElement('canvas'); out.width=bc.width; out.height=bc.height;
    const ctx = out.getContext('2d')!;
    ctx.drawImage(bc,0,0);
    ctx.drawImage(fc,0,0);
    if(pc && showPolygon) ctx.drawImage(pc,0,0);
    out.toBlob(bl=>{ if(!bl) return; const url=URL.createObjectURL(bl); Object.assign(document.createElement('a'),{href:url,download:(fileName||'floodfill')+'_filled.png'}).click(); URL.revokeObjectURL(url); },'image/png');
  }, [fileName, showPolygon]);

  const selectedFill = fills.find(f=>f.id===selectedId) ?? null;
  const hoveredFill  = fills.find(f=>f.id===hoveredId)  ?? null;
  const cursor = mode==='fill' ? (isFilling?'wait':'crosshair') : (isDragging?'grabbing':'grab');
  const tooltipLeft = hoverPos.x + 20;
  const tooltipTop  = hoverPos.y - 10;

  return (
    <div style={{ display:'flex',flexDirection:'column',height:'100vh',background:'#151515',color:'#ccc',fontFamily:"'Courier New',monospace",overflow:'hidden' }}>
      <Script src="https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js" strategy="lazyOnload"/>

      {/* Toolbar */}
      <div style={{ display:'flex',alignItems:'center',gap:5,padding:'5px 10px',background:'#0d0d0d',borderBottom:'1px solid #222',flexShrink:0,height:42,flexWrap:'nowrap',overflow:'hidden' }}>
        <span style={{ fontSize:9,fontWeight:700,color:'#555',textTransform:'uppercase',letterSpacing:'.1em',marginRight:4 }}>⊕ FloodFill</span>
        <Sep/>
        <label style={uploadStyle}>
          ↑ Load PDF / SVG
          <input ref={fileInputRef} type="file" accept=".pdf,.svg" style={{ display:'none' }} onChange={handleUpload}/>
        </label>
        <Sep/>
        {(['fill','pan'] as const).map(m=>(
          <button key={m} onClick={()=>setMode(m)} style={tbBtn(mode===m)}>{m==='fill'?'Fill ⊕':'Pan ⊙'}</button>
        ))}
        <Sep/>
        <div style={{ display:'flex',gap:3,alignItems:'center' }}>
          {COLORS.map(c=>(
            <button key={c} onClick={()=>setActiveColor(c)} style={{ width:15,height:15,borderRadius:2,background:c,cursor:'pointer',flexShrink:0,border:activeColor===c?'2px solid #fff':'2px solid transparent',transform:activeColor===c?'scale(1.3)':'scale(1)',transition:'transform .1s' }}/>
          ))}
        </div>
        <Sep/>
        <span style={lblStyle}>Opacity</span>
        <input type="range" min={10} max={100} step={1} value={fillOpacity} onChange={e=>setFillOpacity(+e.target.value)} style={{ width:60,accentColor:'#f59e0b' }}/>
        <span style={{ fontSize:8,color:'#f59e0b',fontWeight:700,minWidth:28 }}>{fillOpacity}%</span>
        <Sep/>
        <button onClick={()=>setShowPolygon(v=>!v)} style={tbBtn(showPolygon)}>Polygon {showPolygon?'●':'○'}</button>
        <Sep/>
        <ScaleBar pxPerM={pxPerM} onChange={setPxPerM}/>
        <Sep/>
        {fills.length>0 && <button onClick={handleUndo} style={tbBtn(false)}>↩ Undo</button>}
        {selectedId!=null && (
          <button onClick={handleFillHoles}
            style={{...tbBtn(false),color:'#34d399',borderColor:'rgba(52,211,153,.35)'}}
            title="Close enclosed gaps in selected fill">⊞ Fill Holes</button>
        )}
        {fills.length>0 && <button onClick={handleClearAll} style={{...tbBtn(false),color:'#f87171'}}>✕ Clear</button>}
        <div style={{ flex:1 }}/>
        <span style={{ fontSize:8,color:'#555',textTransform:'uppercase',letterSpacing:'.07em',maxWidth:300,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>
          {isFilling && <span style={{ color:'#f59e0b',marginRight:4 }}>●</span>}{status}
        </span>
        <Sep/>
        <button onClick={()=>setZoom(z=>Math.max(0.05,z*0.85))} style={tbBtn(false)}>−</button>
        <span style={{ fontSize:8,color:'#555',minWidth:36,textAlign:'center' }}>{Math.round(zoom*100)}%</span>
        <button onClick={()=>setZoom(z=>Math.min(20,z*1.15))} style={tbBtn(false)}>+</button>
        <button onClick={centerCanvas} style={tbBtn(false)} title="Fit">⊡</button>
      </div>

      {/* Main */}
      <div style={{ display:'flex',flex:1,overflow:'hidden',minHeight:0 }}>

        {/* Viewport */}
        <div
          ref={viewportRef}
          style={{ flex:1,position:'relative',overflow:'hidden',background:'#F8F7F3',backgroundImage:'radial-gradient(circle,#D0CEC8 1px,transparent 1px)',backgroundSize:'20px 20px',cursor,userSelect:'none' }}
          onClick={doFill}
          onMouseMove={handleMouseMove}
          onMouseLeave={()=>setHoveredId(null)}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          <LoadingScreen stage={loadStage} progress={loadProgress} fileName={fileName}/>

          <div ref={wrapRef} style={{ position:'absolute',top:0,left:0,transformOrigin:'0 0',willChange:'transform' }}>
            <canvas ref={baseCanvasRef} style={{ display:'block',imageRendering:'auto' }}/>
            <canvas ref={fillCanvasRef} style={{ display:'block',position:'absolute',top:0,left:0,pointerEvents:'none',imageRendering:'auto' }}/>
            <canvas ref={polyCanvasRef} style={{ display:'block',position:'absolute',top:0,left:0,pointerEvents:'none',imageRendering:'auto' }}/>
          </div>

          {loadStage==='ready' && fileName && (
            <div style={{ position:'absolute',bottom:10,left:10,background:'rgba(255,255,255,.92)',border:'1px solid #ccc',padding:'3px 8px',fontSize:9,color:'#666',textTransform:'uppercase',letterSpacing:'.08em',pointerEvents:'none' }}>
              {fileName}
            </div>
          )}

          {/* Hover tooltip */}
          {hoveredFill && loadStage==='ready' && (
            <div style={{ position:'absolute',left:tooltipLeft,top:tooltipTop,background:'rgba(10,10,10,.97)',border:'1px solid #2a2a2a',padding:'10px 14px',pointerEvents:'none',minWidth:210,zIndex:50,boxShadow:'0 4px 24px rgba(0,0,0,.6)' }}>
              <div style={{ fontSize:8,color:'#f59e0b',textTransform:'uppercase',letterSpacing:'.1em',marginBottom:8,display:'flex',alignItems:'center',gap:6 }}>
                <div style={{ width:9,height:9,borderRadius:1,background:hoveredFill.color,flexShrink:0 }}/>
                {hoveredFill.label}
              </div>
              <div style={{ height:1,background:'#1e1e1e',marginBottom:8 }}/>
              <MeasRow label="Area"      value={fmtArea(hoveredFill.areaPx,   pxPerM)} sub={`${hoveredFill.areaPx.toLocaleString()} px²`}/>
              <MeasRow label="Perimeter" value={fmtPerim(hoveredFill.perimPx, pxPerM)} sub={`${hoveredFill.perimPx.toLocaleString()} px`}/>
              <MeasRow label="Corners"   value={String(hoveredFill.polygon.length)} sub="outer polygon"/>
              {holesClosedIds.has(hoveredFill.id) && (
                <div style={{ marginTop:7,display:'flex',alignItems:'center',gap:5,borderTop:'1px solid #1e1e1e',paddingTop:6 }}>
                  <span style={{ fontSize:8,color:'#34d399' }}>⊞</span>
                  <span style={{ fontSize:7,color:'#34d399',textTransform:'uppercase',letterSpacing:'.07em' }}>Holes closed · outer perimeter</span>
                </div>
              )}
              {pxPerM == null && (
                <div style={{ fontSize:7,color:'#3a3a3a',marginTop:8,textTransform:'uppercase',letterSpacing:'.07em',lineHeight:1.7,borderTop:'1px solid #181818',paddingTop:6 }}>
                  Set px/m in toolbar for real-world units
                </div>
              )}
            </div>
          )}

          {/* Pinned selected panel */}
          {selectedFill && !hoveredFill && loadStage==='ready' && (
            <div style={{ position:'absolute',bottom:10,right:10,background:'rgba(13,13,13,.95)',border:'1px solid #2a2a2a',padding:'10px 14px',pointerEvents:'none',minWidth:210,boxShadow:'0 4px 24px rgba(0,0,0,.5)' }}>
              <div style={{ fontSize:8,color:'#f59e0b',textTransform:'uppercase',letterSpacing:'.1em',marginBottom:7,display:'flex',alignItems:'center',gap:6 }}>
                <div style={{ width:8,height:8,borderRadius:1,background:selectedFill.color }}/>
                {selectedFill.label}
                <span style={{ color:'#383838',marginLeft:2,fontSize:7 }}>selected</span>
              </div>
              <div style={{ height:1,background:'#1e1e1e',marginBottom:8 }}/>
              <MeasRow label="Area"      value={fmtArea(selectedFill.areaPx,   pxPerM)} sub={`${selectedFill.areaPx.toLocaleString()} px²`}/>
              <MeasRow label="Perimeter" value={fmtPerim(selectedFill.perimPx, pxPerM)} sub={`${selectedFill.perimPx.toLocaleString()} px`}/>
              <MeasRow label="Corners"   value={String(selectedFill.polygon.length)} sub="outer polygon"/>
              {holesClosedIds.has(selectedFill.id) && (
                <div style={{ marginTop:7,display:'flex',alignItems:'center',gap:5,borderTop:'1px solid #1e1e1e',paddingTop:6 }}>
                  <span style={{ fontSize:8,color:'#34d399' }}>⊞</span>
                  <span style={{ fontSize:7,color:'#34d399',textTransform:'uppercase',letterSpacing:'.07em' }}>Holes closed · outer perimeter</span>
                </div>
              )}
              {pxPerM == null && (
                <div style={{ fontSize:7,color:'#3a3a3a',marginTop:8,textTransform:'uppercase',letterSpacing:'.07em',lineHeight:1.7,borderTop:'1px solid #181818',paddingTop:6 }}>
                  Set px/m in toolbar for real-world units
                </div>
              )}
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div style={{ width:220,background:'#0f0f0f',borderLeft:'1px solid #1e1e1e',display:'flex',flexDirection:'column',flexShrink:0,overflow:'hidden' }}>
          <div style={{ padding:10,borderBottom:'1px solid #1a1a1a' }}>
            <div style={sectionLabel}>Active fill</div>
            <div style={{ display:'flex',alignItems:'center',gap:8 }}>
              <div style={{ width:28,height:28,borderRadius:3,background:activeColor,border:'1px solid #333' }}/>
              <div>
                <div style={{ fontSize:10,color:'#ccc' }}>{activeColor}</div>
                <div style={{ fontSize:9,color:'#555' }}>{fillOpacity}% opacity</div>
              </div>
            </div>
          </div>

          {fills.length>0 && (
            <div style={{ padding:10,borderBottom:'1px solid #1a1a1a' }}>
              <div style={sectionLabel}>Totals — {fills.length} fills</div>
              <MeasRow label="Area"      value={fmtArea(fills.reduce((s,f)=>s+f.areaPx,0),   pxPerM)} sub={`${fills.reduce((s,f)=>s+f.areaPx,0).toLocaleString()} px²`}/>
              <MeasRow label="Perimeter" value={fmtPerim(fills.reduce((s,f)=>s+f.perimPx,0), pxPerM)} sub={`${fills.reduce((s,f)=>s+f.perimPx,0).toLocaleString()} px`}/>
            </div>
          )}

          <div style={{ padding:'6px 10px',borderBottom:'1px solid #1a1a1a' }}>
            <span style={{ fontSize:8,color:'#3a3a3a',textTransform:'uppercase',letterSpacing:'.09em' }}>Fills ({fills.length})</span>
          </div>

          <div style={{ flex:1,overflowY:'auto',padding:6,display:'flex',flexDirection:'column',gap:3 }}>
            {fills.length===0
              ? <p style={{ fontSize:8,color:'#2a2a2a',textAlign:'center',textTransform:'uppercase',letterSpacing:'.08em',padding:'28px 8px',lineHeight:2.2 }}>Switch to Fill mode<br/>then click any room</p>
              : fills.map(f=>(
                <div
                  key={f.id}
                  onClick={()=>setSelectedId(f.id)}
                  style={{
                    border:`1px solid ${selectedId===f.id?'#f59e0b':hoveredId===f.id?'#555':'#1e1e1e'}`,
                    padding:'5px 6px', fontSize:9,
                    opacity:hiddenIds.has(f.id)?.35:1,
                    cursor:'pointer',
                    background:selectedId===f.id?'rgba(245,158,11,.04)':hoveredId===f.id?'rgba(255,255,255,.02)':'transparent',
                    transition:'border-color .1s,background .1s',
                  }}
                >
                  <div style={{ display:'flex',alignItems:'center',gap:6,marginBottom:3 }}>
                    <div style={{ width:10,height:10,borderRadius:2,background:f.color,flexShrink:0 }}/>
                    <span style={{ flex:1,color:'#777' }}>{f.label}</span>
                    <span style={{ color:'#444',fontSize:8 }}>{f.opacity}%</span>
                    <button
                      title="Close enclosed holes"
                      onClick={e=>{ e.stopPropagation(); setSelectedId(f.id); setTimeout(()=>handleFillHoles(),0); }}
                      style={{ background:'none',border:'none',color:'#34d399',cursor:'pointer',fontSize:10,padding:'0 2px',lineHeight:1 }}>⊞</button>
                    <button
                      onClick={e=>{ e.stopPropagation(); setHiddenIds(p=>{ const s=new Set(p); s.has(f.id)?s.delete(f.id):s.add(f.id); return s; }); }}
                      style={{ background:'none',border:'none',color:'#444',cursor:'pointer',fontSize:11,padding:'0 2px',lineHeight:1 }}>
                      {hiddenIds.has(f.id)?'○':'●'}
                    </button>
                    <button
                      onClick={e=>{ e.stopPropagation(); fillPixelMaps.current.delete(f.id); setFills(p=>{ const next=p.filter(x=>x.id!==f.id); setTimeout(()=>redrawPolygons(next,hiddenIds,selectedId),0); return next; }); if(selectedId===f.id) setSelectedId(null); if(hoveredId===f.id) setHoveredId(null); }}
                      style={{ background:'none',border:'none',color:'#444',cursor:'pointer',fontSize:11,padding:'0 2px',lineHeight:1 }}>✕</button>
                  </div>
                  <div style={{ paddingLeft:16,display:'flex',flexDirection:'column',gap:2 }}>
                    <FillMeasRow icon="▣" label="Area"    value={fmtArea(f.areaPx,   pxPerM)}/>
                    <FillMeasRow icon="◻" label="Perim"   value={fmtPerim(f.perimPx, pxPerM)}/>
                    <FillMeasRow icon="⬡" label="Corners" value={String(f.polygon.length)}/>
                  </div>
                </div>
              ))
            }
          </div>

          {fills.length>0 && (
            <div style={{ padding:8,borderTop:'1px solid #1a1a1a',flexShrink:0 }}>
              <button onClick={handleExport}
                style={{ width:'100%',fontSize:8,textTransform:'uppercase',letterSpacing:'.07em',border:'1px solid rgba(245,158,11,.4)',color:'#f59e0b',background:'transparent',padding:'7px 0',cursor:'pointer',fontFamily:'inherit' }}
                onMouseEnter={e=>(e.currentTarget.style.background='rgba(245,158,11,.07)')}
                onMouseLeave={e=>(e.currentTarget.style.background='transparent')}>
                ↓ Export PNG
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Status bar */}
      <div style={{ height:24,background:'#0a0a0a',borderTop:'1px solid #1a1a1a',display:'flex',alignItems:'center',padding:'0 10px',gap:12,flexShrink:0 }}>
        {['Fill: click room centre','Pan: drag in pan mode','Ctrl+scroll to zoom','Hover filled region to inspect'].map((h,i)=>(
          <React.Fragment key={h}>
            {i>0 && <div style={{ width:1,height:12,background:'#1e1e1e' }}/>}
            <span style={{ fontSize:8,color:'#2e2e2e',textTransform:'uppercase',letterSpacing:'.07em' }}>{h}</span>
          </React.Fragment>
        ))}
        <div style={{ flex:1 }}/>
        <span style={{ fontSize:8,color:'#2e2e2e',textTransform:'uppercase',letterSpacing:'.07em' }}>{fileName}</span>
      </div>
    </div>
  );
}

// ── Subcomponents ─────────────────────────────────────────────────────────────

function MeasRow({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:3 }}>
      <span style={{ fontSize:8,color:'#555',textTransform:'uppercase',letterSpacing:'.07em' }}>{label}</span>
      <div style={{ textAlign:'right' }}>
        <span style={{ fontSize:9,color:'#e5e5e5',fontWeight:700 }}>{value}</span>
        {sub && <div style={{ fontSize:7,color:'#333' }}>{sub}</div>}
      </div>
    </div>
  );
}

function FillMeasRow({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div style={{ display:'flex',alignItems:'center',gap:4 }}>
      <span style={{ fontSize:7,color:'#2e2e2e',minWidth:10 }}>{icon}</span>
      <span style={{ fontSize:7,color:'#444',minWidth:36,textTransform:'uppercase' }}>{label}</span>
      <span style={{ fontSize:8,color:'#aaa',marginLeft:'auto' }}>{value}</span>
    </div>
  );
}

const Sep = () => <div style={{ width:1,height:18,background:'#222',flexShrink:0 }}/>;
const sectionLabel: React.CSSProperties = { fontSize:8,color:'#3a3a3a',textTransform:'uppercase',letterSpacing:'.1em',marginBottom:8 };
const lblStyle: React.CSSProperties = { fontSize:8,color:'#444',textTransform:'uppercase',letterSpacing:'.08em',whiteSpace:'nowrap' };
const uploadStyle: React.CSSProperties = { fontSize:8,textTransform:'uppercase',letterSpacing:'.07em',border:'1px solid #383838',background:'transparent',color:'#999',padding:'3px 9px',cursor:'pointer',fontFamily:'inherit',flexShrink:0,whiteSpace:'nowrap' };
function tbBtn(active: boolean): React.CSSProperties {
  return { fontSize:8,textTransform:'uppercase',letterSpacing:'.07em',border:`1px solid ${active?'#f59e0b':'#2a2a2a'}`,background:active?'rgba(245,158,11,.07)':'transparent',color:active?'#f59e0b':'#777',padding:'3px 7px',cursor:'pointer',fontFamily:'inherit',whiteSpace:'nowrap',flexShrink:0 };
}
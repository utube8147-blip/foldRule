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
const PDF_SCALE           = 3;   // 3× is still crisp but much faster than 4×
const SVG_SCALE           = 3;
const FILL_GROW           = 3;

// ── Types ─────────────────────────────────────────────────────────────────────

interface Fill { id: number; label: string; color: string; opacity: number; }
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

/** Linear-time separable dilation (horizontal pass → vertical pass, O(n·r)) */
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

/** Linear-time separable erosion */
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

/** Fast scanline flood fill using a flat integer stack (avoids GC) */
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

/** Multi-seed: merges nearby fills that are spatially adjacent */
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

function paintFill(filled: Uint8Array, fillData: ImageData, r: number, g: number, b: number, opacity: number): number {
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

function hexToRgb(hex: string) {
  return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)] as const;
}

// ── Loading Screen ─────────────────────────────────────────────────────────────

const LOAD_LINES = [
  'Parsing document structure',
  'Rasterising vector geometry',
  'Sampling pixel luminance',
  'Classifying stroke connectivity',
  'Morphological mask refinement',
  'Indexing fill regions',
];

function LoadingScreen({ stage, progress, fileName }: { stage: LoadStage; progress: string; fileName: string }) {
  const [dots,  setDots]  = useState('');
  const [tick,  setTick]  = useState(0);

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
    <div style={{
      position: 'absolute', inset: 0, zIndex: 100,
      background: '#0c0c0c',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      fontFamily: "'Courier New', monospace",
    }}>
      <style>{`
        @keyframes gridmove{from{background-position:0 0}to{background-position:40px 40px}}
        @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
        @keyframes fadein{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
        @keyframes blink{0%,100%{opacity:.25}50%{opacity:1}}
      `}</style>

      {/* Animated grid */}
      <div style={{
        position: 'absolute', inset: 0, opacity: .055,
        backgroundImage: 'linear-gradient(#f59e0b 1px,transparent 1px),linear-gradient(90deg,#f59e0b 1px,transparent 1px)',
        backgroundSize: '40px 40px',
        animation: 'gridmove 6s linear infinite',
        pointerEvents: 'none',
      }}/>

      <div style={{ position: 'relative', zIndex: 1, textAlign: 'center', width: 320 }}>

        {/* Spinner */}
        <div style={{ position: 'relative', width: 56, height: 56, margin: '0 auto 26px' }}>
          <div style={{ position:'absolute',inset:0,border:'1.5px solid #1c1c1c',borderRadius:'50%' }}/>
          {stage === 'loading' && (
            <div style={{
              position:'absolute',inset:0,
              border:'1.5px solid transparent',
              borderTopColor:'#f59e0b',
              borderRadius:'50%',
              animation:'spin .9s linear infinite',
            }}/>
          )}
          <div style={{
            position:'absolute',inset:0,
            display:'flex',alignItems:'center',justifyContent:'center',
            fontSize:22,color:'#f59e0b',
          }}>⊕</div>
        </div>

        {/* Title */}
        <div style={{ fontSize:10, fontWeight:700, color:'#f59e0b', textTransform:'uppercase', letterSpacing:'.18em', marginBottom:4 }}>
          {stage === 'idle' ? 'FloodFill Studio' : 'Processing'}
        </div>

        {stage === 'idle' && (
          <>
            <p style={{ fontSize:9, color:'#333', textTransform:'uppercase', letterSpacing:'.1em', margin:'14px 0 20px' }}>
              Load a PDF or SVG floor plan to begin
            </p>
            <div style={{ display:'flex', gap:10, justifyContent:'center' }}>
              {['PDF','SVG'].map(t=>(
                <div key={t} style={{
                  border:'1px solid #1e1e1e', padding:'6px 18px',
                  fontSize:9, color:'#2a2a2a', textTransform:'uppercase', letterSpacing:'.12em',
                }}>{t}</div>
              ))}
            </div>
            <p style={{ fontSize:8, color:'#222', textTransform:'uppercase', letterSpacing:'.08em', marginTop:20, lineHeight:2 }}>
              Click walls auto-detected · Text ignored · Multi-seed thin regions
            </p>
          </>
        )}

        {stage === 'loading' && (
          <>
            <div style={{ fontSize:9, color:'#444', marginBottom:22, minHeight:13 }}>
              {fileName}
            </div>

            <div style={{ textAlign:'left', padding:'0 8px', marginBottom:20 }}>
              {LOAD_LINES.map((line, i) => {
                const isActive = i === lineIdx;
                const isDone   = i < lineIdx;
                return (
                  <div key={line} style={{
                    display:'flex', alignItems:'center', gap:10,
                    padding:'3px 0',
                    opacity: isActive ? 1 : isDone ? 0.3 : 0.1,
                    transition:'opacity .35s',
                  }}>
                    <span style={{ fontSize:10, color: isActive ? '#f59e0b' : isDone ? '#444' : '#222', minWidth:10 }}>
                      {isActive ? '›' : isDone ? '✓' : '·'}
                    </span>
                    <span style={{
                      fontSize:9, color: isActive ? '#bbb' : '#444',
                      textTransform:'uppercase', letterSpacing:'.07em',
                    }}>
                      {line}{isActive ? dots : ''}
                    </span>
                  </div>
                );
              })}
            </div>

            <div style={{ fontSize:8, color:'#2a2a2a', textTransform:'uppercase', letterSpacing:'.1em' }}>
              {progress}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function FloodFillPage() {
  const [activeColor,   setActiveColor]   = useState(COLORS[0]);
  const [fillOpacity,   setFillOpacity]   = useState(40);
  const [zoom,          setZoom]          = useState(1);
  const [pan,           setPan]           = useState({ x:0, y:0 });
  const [mode,          setMode]          = useState<'fill'|'pan'>('fill');
  const [isDragging,    setIsDragging]    = useState(false);
  const [isFilling,     setIsFilling]     = useState(false);
  const [fills,         setFills]         = useState<Fill[]>([]);
  const [hiddenIds,     setHiddenIds]     = useState<Set<number>>(new Set());
  const [status,        setStatus]        = useState('');
  const [fileName,      setFileName]      = useState('');
  const [loadStage,     setLoadStage]     = useState<LoadStage>('idle');
  const [loadProgress,  setLoadProgress]  = useState('');

  const viewportRef   = useRef<HTMLDivElement>(null);
  const wrapRef       = useRef<HTMLDivElement>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const fillCanvasRef = useRef<HTMLCanvasElement>(null);
  const maskRef       = useRef<Uint8Array|null>(null);
  const fillDataRef   = useRef<ImageData|null>(null);
  const dragRef       = useRef({mx:0,my:0,px:0,py:0});
  const fillCountRef  = useRef(0);
  const fileInputRef  = useRef<HTMLInputElement>(null);
  const snapshots     = useRef<ImageData[]>([]);

  useEffect(() => {
    if (wrapRef.current)
      wrapRef.current.style.transform = `translate(${pan.x}px,${pan.y}px) scale(${zoom})`;
  }, [pan, zoom]);

  const centerCanvas = useCallback(() => {
    const vp = viewportRef.current, bc = baseCanvasRef.current;
    if (!vp || !bc) return;
    const vr = vp.getBoundingClientRect();
    const fz = Math.min((vr.width*.9)/bc.width, (vr.height*.9)/bc.height, 1);
    setZoom(fz);
    setPan({ x:(vr.width - bc.width*fz)/2, y:(vr.height - bc.height*fz)/2 });
  }, []);

  /** Build mask in yielded steps so the loading animation stays live */
  const buildMaskAsync = useCallback((bc: HTMLCanvasElement, fc: HTMLCanvasElement): Promise<void> => {
    return new Promise(resolve => {
      const ctx = bc.getContext('2d')!;
      const id  = ctx.getImageData(0, 0, bc.width, bc.height);
      const w = bc.width, h = bc.height;

      const step = (fn: () => void, label: string, next: () => void) => {
        setLoadProgress(label);
        setTimeout(() => { fn(); next(); }, 0);
      };

      step(
        () => {},
        'Classifying stroke connectivity…',
        () => {
          const raw = buildWallMask(id.data, w, h);
          step(
            () => {},
            'Dilating mask…',
            () => {
              const dilated = dilateMaskFast(raw, w, h, DILATE_R);
              step(
                () => {},
                'Eroding mask…',
                () => {
                  const eroded = erodeMaskFast(dilated, w, h, ERODE_R);
                  maskRef.current     = eroded;
                  fillDataRef.current = new ImageData(w, h);
                  fillCountRef.current = 0;
                  snapshots.current   = [];
                  fc.width = w; fc.height = h;
                  setFills([]); setHiddenIds(new Set());
                  resolve();
                }
              );
            }
          );
        }
      );
    });
  }, []);

  const loadPdf = useCallback(async (file: File) => {
    setLoadProgress('Initialising PDF.js…');
    let pdfjsLib = (window as any).pdfjsLib as any;
    if (!pdfjsLib) {
      await new Promise<void>((res, rej) => {
        let tries = 0;
        const id = setInterval(() => {
          pdfjsLib = (window as any).pdfjsLib;
          if (pdfjsLib) { clearInterval(id); res(); }
          else if (++tries > 60) { clearInterval(id); rej(new Error('PDF.js timed out')); }
        }, 100);
      });
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

    setLoadProgress('Parsing PDF…');
    await new Promise(r => setTimeout(r, 0));

    const ab   = await file.arrayBuffer();
    const doc  = await pdfjsLib.getDocument({ data: ab }).promise;
    const page = await doc.getPage(1);
    const vp   = page.getViewport({ scale: PDF_SCALE });

    const bc = baseCanvasRef.current!, fc = fillCanvasRef.current!;
    bc.width = vp.width; bc.height = vp.height;
    const ctx = bc.getContext('2d')!;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, bc.width, bc.height);

    setLoadProgress('Rendering page…');
    await new Promise(r => setTimeout(r, 0));
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    await buildMaskAsync(bc, fc);
    setStatus(`Loaded · page 1/${doc.numPages} · ${bc.width}×${bc.height}px`);
  }, [buildMaskAsync]);

  const loadSvg = useCallback(async (file: File) => {
    setLoadProgress('Reading SVG…');
    await new Promise(r => setTimeout(r, 0));

    const text = await file.text();
    const parser = new DOMParser();
    const d   = parser.parseFromString(text, 'image/svg+xml');
    const svg = d.querySelector('svg');
    if (!svg) throw new Error('Invalid SVG');

    const sw = Math.max(2, Math.ceil(SVG_SCALE * 1.2));
    const st = d.createElementNS('http://www.w3.org/2000/svg', 'style');
    st.textContent = `line,polyline,polygon,rect,circle,ellipse,path{stroke:#000!important;stroke-width:${sw}px!important;stroke-opacity:1!important;paint-order:stroke fill;}`;
    svg.insertBefore(st, svg.firstChild);

    const blob = new Blob([new XMLSerializer().serializeToString(d)], { type: 'image/svg+xml' });
    const url  = URL.createObjectURL(blob);
    const img  = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = rej; img.src = url; });
    URL.revokeObjectURL(url);

    const vb = svg.viewBox?.baseVal;
    const W = vb?.width || img.width || 800, H = vb?.height || img.height || 600;
    const cw = Math.round(W * SVG_SCALE), ch = Math.round(H * SVG_SCALE);

    const bc = baseCanvasRef.current!, fc = fillCanvasRef.current!;
    bc.width = cw; bc.height = ch;
    const ctx = bc.getContext('2d')!;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(img, 0, 0, cw, ch);

    await buildMaskAsync(bc, fc);
    setStatus(`Loaded · ${cw}×${ch}px`);
  }, [buildMaskAsync]);

  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    e.target.value = '';
    const isPdf = file.name.toLowerCase().endsWith('.pdf');
    setFileName(file.name);
    setLoadStage('loading');
    setLoadProgress('Starting…');
    setZoom(1); setPan({ x:0, y:0 });
    try {
      if (isPdf) await loadPdf(file); else await loadSvg(file);
      setLoadStage('ready');
      centerCanvas();
    } catch (err) {
      setLoadStage('idle');
      setStatus(`Error: ${(err as Error).message}`);
    }
  }, [loadPdf, loadSvg, centerCanvas]);

  // ── Fill click ─────────────────────────────────────────────────────────────

  const doFill = useCallback(async (e: React.MouseEvent) => {
    if (mode !== 'fill' || isFilling || loadStage !== 'ready') return;
    if (!maskRef.current || !fillDataRef.current) return;

    const vp = viewportRef.current!;
    const vr = vp.getBoundingClientRect();
    const px = Math.round((e.clientX - vr.left - pan.x) / zoom);
    const py = Math.round((e.clientY - vr.top  - pan.y) / zoom);
    const bc = baseCanvasRef.current!;
    if (px < 0 || px >= bc.width || py < 0 || py >= bc.height) return;

    setIsFilling(true); setStatus('Filling…');
    await new Promise<void>(r => requestAnimationFrame(() => r()));

    const snap = new ImageData(
      new Uint8ClampedArray(fillDataRef.current!.data),
      fillDataRef.current!.width, fillDataRef.current!.height,
    );
    snapshots.current.push(snap);

    const filled = multiSeedFill(maskRef.current, bc.width, bc.height, px, py);
    if (!filled) {
      snapshots.current.pop();
      setIsFilling(false);
      setStatus('Clicked on a wall — try the room centre');
      return;
    }

    const grown = dilateMaskFast(filled, bc.width, bc.height, FILL_GROW);
    const [r, g, b] = hexToRgb(activeColor);
    const count = paintFill(grown, fillDataRef.current!, r, g, b, fillOpacity / 100);

    fillCanvasRef.current!.getContext('2d')!.putImageData(fillDataRef.current!, 0, 0);
    fillCountRef.current += 1;
    setFills(prev => [...prev, {
      id: Date.now(), label: `Fill ${fillCountRef.current}`,
      color: activeColor, opacity: fillOpacity,
    }]);
    setIsFilling(false);
    setStatus(`Filled · ${count.toLocaleString()} px`);
  }, [mode, isFilling, loadStage, pan, zoom, activeColor, fillOpacity]);

  // ── Undo / Clear ───────────────────────────────────────────────────────────

  const handleUndo = useCallback(() => {
    if (!snapshots.current.length || !fillDataRef.current) return;
    const prev = snapshots.current.pop()!;
    fillDataRef.current.data.set(prev.data);
    fillCanvasRef.current!.getContext('2d')!.putImageData(fillDataRef.current, 0, 0);
    setFills(f => f.slice(0,-1)); setStatus('Undo');
  }, []);

  const handleClearAll = useCallback(() => {
    if (!fillDataRef.current) return;
    fillDataRef.current.data.fill(0);
    const fc = fillCanvasRef.current!;
    fc.getContext('2d')!.clearRect(0, 0, fc.width, fc.height);
    snapshots.current = []; fillCountRef.current = 0;
    setFills([]); setHiddenIds(new Set()); setStatus('Cleared');
  }, []);

  // ── Wheel zoom ─────────────────────────────────────────────────────────────

  const wheelHandlerRef = useRef<(e:WheelEvent)=>void>(()=>{});
  useEffect(() => {
    wheelHandlerRef.current = (e: WheelEvent) => {
      e.preventDefault();
      const vp = viewportRef.current; if (!vp) return;
      const vr = vp.getBoundingClientRect();
      if (e.ctrlKey) {
        const mx = e.clientX - vr.left, my = e.clientY - vr.top;
        const f = e.deltaY > 0 ? 0.92 : 1.08;
        setZoom(z => {
          const nz = Math.min(20, Math.max(0.05, z*f));
          setPan(p => ({ x: mx-(mx-p.x)*(nz/z), y: my-(my-p.y)*(nz/z) }));
          return nz;
        });
        return;
      }
      setPan(p => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
    };
  });
  useEffect(() => {
    const vp = viewportRef.current; if (!vp) return;
    const h = (e: WheelEvent) => wheelHandlerRef.current(e);
    vp.addEventListener('wheel', h, { passive: false });
    return () => vp.removeEventListener('wheel', h);
  }, []);

  // ── Pointer pan ────────────────────────────────────────────────────────────

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (mode !== 'pan') return;
    setIsDragging(true);
    dragRef.current = { mx: e.clientX, my: e.clientY, px: pan.x, py: pan.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, [mode, pan]);
  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging) return;
    setPan({ x: dragRef.current.px + e.clientX - dragRef.current.mx, y: dragRef.current.py + e.clientY - dragRef.current.my });
  }, [isDragging]);
  const handlePointerUp = useCallback(() => setIsDragging(false), []);

  // ── Export ─────────────────────────────────────────────────────────────────

  const handleExport = useCallback(() => {
    const bc = baseCanvasRef.current, fc = fillCanvasRef.current;
    if (!bc || !fc) return;
    const out = document.createElement('canvas');
    out.width = bc.width; out.height = bc.height;
    const ctx = out.getContext('2d')!;
    ctx.drawImage(bc, 0, 0); ctx.drawImage(fc, 0, 0);
    out.toBlob(bl => {
      if (!bl) return;
      const url = URL.createObjectURL(bl);
      Object.assign(document.createElement('a'), { href: url, download: (fileName||'floodfill')+'_filled.png' }).click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  }, [fileName]);

  const cursor = mode === 'fill' ? (isFilling ? 'wait' : 'crosshair') : (isDragging ? 'grabbing' : 'grab');

  return (
    <div style={{ display:'flex',flexDirection:'column',height:'100vh',background:'#151515',color:'#ccc',fontFamily:"'Courier New',monospace",overflow:'hidden' }}>
      <Script src="https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js" strategy="lazyOnload" />

      {/* ── Toolbar ── */}
      <div style={{ display:'flex',alignItems:'center',gap:5,padding:'5px 10px',background:'#0d0d0d',borderBottom:'1px solid #222',flexShrink:0,height:42,flexWrap:'nowrap',overflow:'hidden' }}>
        <span style={{ fontSize:9,fontWeight:700,color:'#555',textTransform:'uppercase',letterSpacing:'.1em',marginRight:4 }}>⊕ FloodFill</span>
        <Sep/>
        <label style={uploadStyle}>
          ↑ Load PDF / SVG
          <input ref={fileInputRef} type="file" accept=".pdf,.svg" style={{ display:'none' }} onChange={handleUpload}/>
        </label>
        <Sep/>
        {(['fill','pan'] as const).map(m=>(
          <button key={m} onClick={()=>setMode(m)} style={tbBtn(mode===m)}>
            {m==='fill'?'Fill ⊕':'Pan ⊙'}
          </button>
        ))}
        <Sep/>
        <div style={{ display:'flex',gap:3,alignItems:'center' }}>
          {COLORS.map(c=>(
            <button key={c} onClick={()=>setActiveColor(c)} style={{
              width:15,height:15,borderRadius:2,background:c,cursor:'pointer',flexShrink:0,
              border:activeColor===c?'2px solid #fff':'2px solid transparent',
              transform:activeColor===c?'scale(1.3)':'scale(1)',transition:'transform .1s',
            }}/>
          ))}
        </div>
        <Sep/>
        <span style={lblStyle}>Opacity</span>
        <input type="range" min={10} max={100} step={1} value={fillOpacity}
          onChange={e=>setFillOpacity(+e.target.value)}
          style={{ width:60,accentColor:'#f59e0b' }}/>
        <span style={{ fontSize:8,color:'#f59e0b',fontWeight:700,minWidth:28 }}>{fillOpacity}%</span>
        <Sep/>
        {fills.length>0 && <button onClick={handleUndo} style={tbBtn(false)}>↩ Undo</button>}
        {fills.length>0 && <button onClick={handleClearAll} style={{...tbBtn(false),color:'#f87171'}}>✕ Clear</button>}
        <div style={{ flex:1 }}/>
        <span style={{ fontSize:8,color:'#555',textTransform:'uppercase',letterSpacing:'.07em',maxWidth:260,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>
          {isFilling && <span style={{ color:'#f59e0b',marginRight:4 }}>●</span>}{status}
        </span>
        <Sep/>
        <button onClick={()=>setZoom(z=>Math.max(0.05,z*0.85))} style={tbBtn(false)}>−</button>
        <span style={{ fontSize:8,color:'#555',minWidth:36,textAlign:'center' }}>{Math.round(zoom*100)}%</span>
        <button onClick={()=>setZoom(z=>Math.min(20,z*1.15))} style={tbBtn(false)}>+</button>
        <button onClick={centerCanvas} style={tbBtn(false)} title="Fit">⊡</button>
      </div>

      {/* ── Main ── */}
      <div style={{ display:'flex',flex:1,overflow:'hidden',minHeight:0 }}>

        {/* Viewport */}
        <div ref={viewportRef}
          style={{ flex:1,position:'relative',overflow:'hidden',background:'#F8F7F3',
            backgroundImage:'radial-gradient(circle,#D0CEC8 1px,transparent 1px)',
            backgroundSize:'20px 20px',cursor,userSelect:'none' }}
          onClick={doFill}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}>

          <LoadingScreen stage={loadStage} progress={loadProgress} fileName={fileName}/>

          <div ref={wrapRef} style={{ position:'absolute',top:0,left:0,transformOrigin:'0 0',willChange:'transform' }}>
            <canvas ref={baseCanvasRef} style={{ display:'block',imageRendering:'auto' }}/>
            <canvas ref={fillCanvasRef} style={{ display:'block',position:'absolute',top:0,left:0,pointerEvents:'none',imageRendering:'auto' }}/>
          </div>

          {loadStage==='ready' && fileName && (
            <div style={{ position:'absolute',bottom:10,left:10,background:'rgba(255,255,255,.92)',border:'1px solid #ccc',padding:'3px 8px',fontSize:9,color:'#666',textTransform:'uppercase',letterSpacing:'.08em',pointerEvents:'none' }}>
              {fileName}
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div style={{ width:210,background:'#0f0f0f',borderLeft:'1px solid #1e1e1e',display:'flex',flexDirection:'column',flexShrink:0,overflow:'hidden' }}>
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

          <div style={{ padding:10,borderBottom:'1px solid #1a1a1a' }}>
            <div style={sectionLabel}>Engine</div>
            {([
              ['Algorithm','Multi-seed scanline'],
              ['Wall detection','Stroke-connected'],
              ['Text pixels','Pass-through'],
              ['Dilation','O(n·r) separable'],
              ['PDF scale',`${PDF_SCALE}×`],
              ['Fill grow',`${FILL_GROW}px`],
            ] as [string,string][]).map(([k,v])=>(
              <div key={k} style={{ display:'flex',justifyContent:'space-between',marginBottom:2 }}>
                <span style={{ fontSize:8,color:'#444' }}>{k}</span>
                <span style={{ fontSize:8,color:'#f59e0b',fontWeight:700 }}>{v}</span>
              </div>
            ))}
          </div>

          <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 10px',borderBottom:'1px solid #1a1a1a' }}>
            <span style={{ fontSize:8,color:'#444',textTransform:'uppercase',letterSpacing:'.09em' }}>Fills ({fills.length})</span>
          </div>

          <div style={{ flex:1,overflowY:'auto',padding:6,display:'flex',flexDirection:'column',gap:3 }}>
            {fills.length===0 ? (
              <p style={{ fontSize:8,color:'#333',textAlign:'center',textTransform:'uppercase',letterSpacing:'.08em',padding:'24px 8px',lineHeight:2 }}>Fill mode<br/>click any room</p>
            ) : fills.map(f=>(
              <div key={f.id} style={{ display:'flex',alignItems:'center',gap:6,border:'1px solid #1e1e1e',padding:'4px 6px',fontSize:9,opacity:hiddenIds.has(f.id)?0.35:1 }}>
                <div style={{ width:10,height:10,borderRadius:2,background:f.color,flexShrink:0 }}/>
                <span style={{ flex:1,color:'#777' }}>{f.label}</span>
                <span style={{ color:'#444',fontSize:8 }}>{f.opacity}%</span>
                <button onClick={()=>setHiddenIds(p=>{const s=new Set(p);s.has(f.id)?s.delete(f.id):s.add(f.id);return s;})}
                  style={{ background:'none',border:'none',color:'#444',cursor:'pointer',fontSize:11,padding:'0 2px',lineHeight:1 }}>
                  {hiddenIds.has(f.id)?'○':'●'}
                </button>
                <button onClick={()=>setFills(p=>p.filter(x=>x.id!==f.id))}
                  style={{ background:'none',border:'none',color:'#444',cursor:'pointer',fontSize:11,padding:'0 2px',lineHeight:1 }}>✕</button>
              </div>
            ))}
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

      {/* ── Status bar ── */}
      <div style={{ height:24,background:'#0a0a0a',borderTop:'1px solid #1a1a1a',display:'flex',alignItems:'center',padding:'0 10px',gap:12,flexShrink:0 }}>
        {['Fill: click room centre','Pan: drag in pan mode','Ctrl+scroll to zoom'].map((h,i)=>(
          <React.Fragment key={h}>
            {i>0 && <div style={{ width:1,height:12,background:'#1e1e1e' }}/>}
            <span style={{ fontSize:8,color:'#333',textTransform:'uppercase',letterSpacing:'.07em' }}>{h}</span>
          </React.Fragment>
        ))}
        <div style={{ flex:1 }}/>
        <span style={{ fontSize:8,color:'#333',textTransform:'uppercase',letterSpacing:'.07em' }}>{fileName}</span>
      </div>
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
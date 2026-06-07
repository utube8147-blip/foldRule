// app/(test)/PdfCVMatchPage/page.tsx
'use client';

import React, {
  useState, useEffect, useRef, useCallback,
} from 'react';
import Script from 'next/script';

import { useOpenCVMatcher }  from '@/hooks/detection/useOpenCVMatcher';
import {
  CVMatchOverlay,
  CVWorkerBanner,
  CVRubberBand,
  CVSamplerSidebar,
  useCVRubberBand,
} from '@/components/features/overlays/CVMatchOverlay';

// ── Constants ─────────────────────────────────────────────────────────────────

const DRAG_THRESHOLD    = 5;
const BASE_SCALE        = 1.5;
const MAX_RENDER_SCALE  = 6.0;
const ZOOM_RENDER_RATIO = 1.2;

const PDFJS_CDN_JS     = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
const PDFJS_CDN_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

const LOAD_LINES = [
  'Parsing PDF structure',
  'Decoding page geometry',
  'Rasterising vector graphics',
  'Compositing page layers',
  'Transferring to canvas',
  'Building pixel index',
];

const yieldFrame = () => new Promise<void>(r => requestAnimationFrame(() => r()));

// ── Styles ────────────────────────────────────────────────────────────────────

const S = {
  root:      { display:'flex',flexDirection:'column' as const,height:'100vh',background:'#151515',color:'#ccc',fontFamily:"'Courier New',monospace",overflow:'hidden' },
  toolbar:   { display:'flex',alignItems:'center',gap:5,padding:'5px 10px',background:'#0d0d0d',borderBottom:'1px solid #222',flexShrink:0,height:42,flexWrap:'nowrap' as const,overflow:'hidden' },
  main:      { display:'flex',flex:1,overflow:'hidden',minHeight:0 },
  viewport:  { flex:1,position:'relative' as const,overflow:'hidden',background:'#F8F7F3',backgroundImage:'radial-gradient(circle, #D0CEC8 1px, transparent 1px)',backgroundSize:'20px 20px',userSelect:'none' as const },
  canvasWrap:{ position:'absolute' as const,top:0,left:0,transformOrigin:'0 0',willChange:'transform' },
  statusbar: { height:24,background:'#0a0a0a',borderTop:'1px solid #1a1a1a',display:'flex',alignItems:'center',padding:'0 10px',gap:12,flexShrink:0 },
  sep:       { width:1,height:18,background:'#222',flexShrink:0 },
  barSep:    { width:1,height:12,background:'#1e1e1e' },
  statusTxt: { fontSize:8,color:'#555',textTransform:'uppercase' as const,letterSpacing:'.07em',maxWidth:360,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const },
};

function tbBtn(active: boolean, colour = '#f59e0b'): React.CSSProperties {
  return {
    fontSize:8,textTransform:'uppercase',letterSpacing:'.07em',
    border:`1px solid ${active ? colour : '#2a2a2a'}`,
    background:active ? `${colour}12` : 'transparent',
    color:active ? colour : '#777',
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
    const id = setInterval(() => {
      setDots(d => d.length >= 3 ? '' : d + '.');
      setTick(t => (t + 1) % (LOAD_LINES.length * 3));
    }, 380);
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
          {LOAD_LINES.map((line, i) => {
            const isActive = i === lineIdx, isDone = i < lineIdx;
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

function IdleScreen({ pdfJsReady }: { pdfJsReady: boolean }) {
  return (
    <div style={{ position:'absolute',inset:0,zIndex:80,background:'#0c0c0c',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',fontFamily:"'Courier New',monospace" }}>
      <style>{`@keyframes gm{from{background-position:0 0}to{background-position:40px 40px}}`}</style>
      <div style={{ position:'absolute',inset:0,opacity:.04,backgroundImage:'linear-gradient(#f59e0b 1px,transparent 1px),linear-gradient(90deg,#f59e0b 1px,transparent 1px)',backgroundSize:'40px 40px',animation:'gm 6s linear infinite',pointerEvents:'none' }} />
      <div style={{ position:'relative',zIndex:1,textAlign:'center',width:340 }}>
        <div style={{ fontSize:28,color:'#f59e0b',marginBottom:18 }}>⊕</div>
        <div style={{ fontSize:10,fontWeight:700,color:'#f59e0b',textTransform:'uppercase',letterSpacing:'.18em',marginBottom:6 }}>PDF CV Match</div>
        <p style={{ fontSize:8,color:'#444',textTransform:'uppercase',letterSpacing:'.1em',margin:'12px 0 20px',lineHeight:2 }}>
          Load a floor plan PDF to begin<br />Quality increases automatically as you zoom in
        </p>
        <div style={{ display:'flex',alignItems:'center',justifyContent:'center',gap:6,marginBottom:16 }}>
          <div style={{ width:6,height:6,borderRadius:'50%',background:pdfJsReady?'#22c55e':'#f59e0b',flexShrink:0 }} />
          <span style={{ fontSize:7,color:pdfJsReady?'#22c55e':'#f59e0b',textTransform:'uppercase',letterSpacing:'.08em' }}>
            {pdfJsReady ? 'PDF.js ready' : 'Loading PDF.js…'}
          </span>
        </div>
        <p style={{ fontSize:8,color:'#222',textTransform:'uppercase',letterSpacing:'.07em',lineHeight:2 }}>
          Ctrl+scroll: zoom · Drag: pan · Drop PDF anywhere
        </p>
      </div>
    </div>
  );
}

// ── Quality badge ─────────────────────────────────────────────────────────────

function QualityBadge({ renderScale, isRerendering }: { renderScale: number; isRerendering: boolean }) {
  const dpi = Math.round(renderScale * 72);
  return (
    <div style={{
      position:'absolute',bottom:10,right:10,
      background:'rgba(0,0,0,0.75)',border:'1px solid #2a2a2a',
      padding:'3px 8px',fontSize:8,
      color:isRerendering?'#f59e0b':'#444',
      textTransform:'uppercase',letterSpacing:'.08em',pointerEvents:'none',
      display:'flex',alignItems:'center',gap:6,
    }}>
      {isRerendering && <>
        <style>{`@keyframes qspin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>
        <div style={{ width:6,height:6,border:'1px solid transparent',borderTopColor:'#f59e0b',borderRadius:'50%',animation:'qspin .5s linear infinite' }} />
      </>}
      {isRerendering ? 'Upscaling…' : `${dpi} DPI`}
    </div>
  );
}

// ── Sidebar shell ─────────────────────────────────────────────────────────────

function SidebarShell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ width:240,background:'#0f0f0f',borderLeft:'1px solid #1e1e1e',display:'flex',flexDirection:'column',flexShrink:0,overflow:'hidden' }}>
      {children}
    </div>
  );
}

function SidebarHeader({ onClose }: { onClose: () => void }) {
  return (
    <div style={{ display:'flex',alignItems:'center',gap:8,padding:'7px 10px',borderBottom:'1px solid #1a1a1a',flexShrink:0,background:'#38bdf808' }}>
      <span style={{ fontSize:12,color:'#38bdf8' }}>⊡</span>
      <span style={{ fontSize:8,color:'#38bdf8',textTransform:'uppercase',letterSpacing:'.12em',fontWeight:700,flex:1 }}>CV Match</span>
      <button onClick={onClose} style={{ background:'transparent',border:'none',color:'#333',fontSize:13,cursor:'pointer',padding:'0 2px',lineHeight:1,fontFamily:'inherit' }}>×</button>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

type CVSamplerMode = 'idle' | 'drawing' | 'matched';

export default function PdfCVMatchPage() {

  // ── PDF.js script state ───────────────────────────────────────────────────────
  const [pdfJsReady, setPdfJsReady] = useState(false);

  // ── Core state ────────────────────────────────────────────────────────────────
  const [fileName,      setFileName]      = useState('');
  const [isLoading,     setIsLoading]     = useState(false);
  const [isIdle,        setIsIdle]        = useState(true);
  const [status,        setStatus]        = useState('');
  const [zoom,          setZoom]          = useState(1);
  const [pan,           setPan]           = useState({ x:0, y:0 });
  const [showSidebar,   setShowSidebar]   = useState(true);
  const [renderScale,   setRenderScale]   = useState(BASE_SCALE);
  const [isRerendering, setIsRerendering] = useState(false);

  // ── CV state — sane defaults for direct matchTemplate ─────────────────────────
  const [cvSamplerMode, setCVSamplerMode] = useState<CVSamplerMode>('idle');
  const [cvThreshold,   setCVThreshold]   = useState(0.70);   // ↑ was 0.60
  const [cvRotations,   setCVRotations]   = useState<number[]>([0, 90, 180, 270]);
  const [cvFlips,       setCVFlips]       = useState<boolean[]>([false]);        // ↓ no flip by default
  const [cvRemoveText,  setCVRemoveText]  = useState(false);
  const [cvScales,      setCVScales]      = useState<number[]>([1.0]);           // 1× only by default

  // ── Refs ──────────────────────────────────────────────────────────────────────
  const viewportRef    = useRef<HTMLDivElement>(null);
  const wrapRef        = useRef<HTMLDivElement>(null);
  const baseCanvasRef  = useRef<HTMLCanvasElement>(null);
  const fileInputRef   = useRef<HTMLInputElement>(null);
  const pointerDownRef = useRef(false);
  const isDraggingRef  = useRef(false);
  const dragRef        = useRef({ mx:0,my:0,px:0,py:0 });
  const panRef         = useRef(pan);
  const zoomRef        = useRef(zoom);
  const renderScaleRef = useRef(renderScale);
  const pdfDocRef      = useRef<any>(null);
  const rerenderTimer  = useRef<ReturnType<typeof setTimeout>|null>(null);
  const renderTaskRef  = useRef<any>(null);

  useEffect(() => { panRef.current         = pan;         }, [pan]);
  useEffect(() => { zoomRef.current        = zoom;        }, [zoom]);
  useEffect(() => { renderScaleRef.current = renderScale; }, [renderScale]);

  // ── CV matcher ────────────────────────────────────────────────────────────────
  const cvMatcher = useOpenCVMatcher();

  // ── Get pdfjsLib ─────────────────────────────────────────────────────────────
  const getPdfJs = useCallback(() => {
    const lib = (window as any).pdfjsLib;
    if (!lib) throw new Error('PDF.js not loaded yet — please wait a moment and try again');
    return lib;
  }, []);

  // ── Render page at given scale ────────────────────────────────────────────────
  const renderPage = useCallback(async (pdfDoc: any, scale: number) => {
    if (renderTaskRef.current) {
      try { renderTaskRef.current.cancel(); } catch (_) {}
      renderTaskRef.current = null;
      await new Promise<void>(r => requestAnimationFrame(() => r()));
    }

    const page     = await pdfDoc.getPage(1);
    const viewport = page.getViewport({ scale });
    const canvas   = baseCanvasRef.current!;
    canvas.width   = Math.round(viewport.width);
    canvas.height  = Math.round(viewport.height);
    const ctx      = canvas.getContext('2d')!;
    ctx.fillStyle  = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const task = page.render({ canvasContext: ctx, viewport });
    renderTaskRef.current = task;
    try {
      await task.promise;
    } catch (err: any) {
      if (err?.name === 'RenderingCancelledException') return { w: canvas.width, h: canvas.height };
      throw err;
    } finally {
      renderTaskRef.current = null;
    }

    return { w: canvas.width, h: canvas.height };
  }, []);

  // ── Fit to viewport ───────────────────────────────────────────────────────────
  const fitCanvas = useCallback(() => {
    const vp = viewportRef.current, bc = baseCanvasRef.current;
    if (!vp || !bc) return;
    const vr = vp.getBoundingClientRect();
    const fz = Math.min((vr.width * 0.9) / bc.width, (vr.height * 0.9) / bc.height, 2);
    setZoom(fz);
    setPan({ x: (vr.width - bc.width * fz) / 2, y: (vr.height - bc.height * fz) / 2 });
  }, []);

  // ── Adaptive re-render on zoom ────────────────────────────────────────────────
  const scheduleRerender = useCallback((newZoom: number) => {
    if (!pdfDocRef.current) return;
    if (rerenderTimer.current) clearTimeout(rerenderTimer.current);
    rerenderTimer.current = setTimeout(async () => {
      const cur    = renderScaleRef.current;
      const needed = Math.min(newZoom * BASE_SCALE, MAX_RENDER_SCALE);
      if (needed <= cur * ZOOM_RENDER_RATIO) return;

      setIsRerendering(true);
      try {
        const { w, h } = await renderPage(pdfDocRef.current, needed);
        setRenderScale(needed);
        const ratio = needed / cur;
        const vr    = viewportRef.current!.getBoundingClientRect();
        const cx    = vr.width / 2, cy = vr.height / 2;
        setPan(p  => ({ x: cx - (cx - p.x) * ratio, y: cy - (cy - p.y) * ratio }));
        setZoom(z => z / ratio);
        setStatus(`Re-rendered · ${Math.round(needed * 72)} DPI · ${w}×${h}px`);
      } catch (e) {
        console.error('Re-render failed', e);
      } finally {
        setIsRerendering(false);
      }
    }, 600);
  }, [renderPage]);

  // ── Load PDF ──────────────────────────────────────────────────────────────────
  const loadPdf = useCallback(async (arrayBuffer: ArrayBuffer, name: string) => {
    setFileName(name); setIsLoading(true); setIsIdle(false);
    cvMatcher.clearAll(); setCVSamplerMode('idle');
    await yieldFrame();
    try {
      const pdfjsLib = getPdfJs();
      pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_CDN_WORKER;

      const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      pdfDocRef.current = pdfDoc;

      const { w, h } = await renderPage(pdfDoc, BASE_SCALE);
      setRenderScale(BASE_SCALE);
      setIsLoading(false);
      fitCanvas();
      setStatus(`Loaded · ${w}×${h}px · ${Math.round(BASE_SCALE * 72)} DPI · ${pdfDoc.numPages} page${pdfDoc.numPages !== 1 ? 's' : ''}`);
    } catch (err) {
      setIsLoading(false); setIsIdle(true);
      setStatus(`Error: ${(err as Error).message}`);
    }
  }, [getPdfJs, renderPage, fitCanvas, cvMatcher]);

  // ── File input ────────────────────────────────────────────────────────────────
  const handleUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    e.target.value = '';
    const reader = new FileReader();
    reader.onload = ev => loadPdf(ev.target!.result as ArrayBuffer, file.name);
    reader.readAsArrayBuffer(file);
  }, [loadPdf]);

  // ── Drag and drop ─────────────────────────────────────────────────────────────
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file || !file.name.toLowerCase().endsWith('.pdf')) return;
    const reader = new FileReader();
    reader.onload = ev => loadPdf(ev.target!.result as ArrayBuffer, file.name);
    reader.readAsArrayBuffer(file);
  }, [loadPdf]);

  // ── Canvas transform ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (wrapRef.current)
      wrapRef.current.style.transform = `translate(${pan.x}px,${pan.y}px) scale(${zoom})`;
  }, [pan, zoom]);

  // ── CV handlers ───────────────────────────────────────────────────────────────
  const handleCVBoxCommit = useCallback(async (box: { x:number;y:number;w:number;h:number }) => {
    const canvas = baseCanvasRef.current; if (!canvas) return;
    cvMatcher.buildTemplate(canvas, box, zoomRef.current, panRef.current);
    setCVSamplerMode('matched');
    await cvMatcher.findMatches(canvas, cvThreshold, cvRotations, cvFlips, cvRemoveText, cvScales);
  }, [cvMatcher, cvThreshold, cvRotations, cvFlips, cvRemoveText, cvScales]);

  const handleClearCV     = useCallback(() => { cvMatcher.clearAll(); setCVSamplerMode('idle');    }, [cvMatcher]);
  const handleEnterCVDraw = useCallback(() => { cvMatcher.clearAll(); setCVSamplerMode('drawing'); }, [cvMatcher]);

  const isCVDrawMode = cvSamplerMode === 'drawing';

  const { drawBox, isDrawing, tooLarge, startDraw } = useCVRubberBand(
    viewportRef as React.RefObject<HTMLDivElement>,
    isCVDrawMode,
    handleCVBoxCommit,
  );

  // ── Pointer ───────────────────────────────────────────────────────────────────
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (isCVDrawMode) { startDraw(e); return; }
    pointerDownRef.current = true;
    isDraggingRef.current  = false;
    dragRef.current = { mx:e.clientX,my:e.clientY,px:panRef.current.x,py:panRef.current.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, [isCVDrawMode, startDraw]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (isCVDrawMode) return;
    if (pointerDownRef.current && !isDraggingRef.current) {
      if (Math.hypot(e.clientX - dragRef.current.mx, e.clientY - dragRef.current.my) > DRAG_THRESHOLD)
        isDraggingRef.current = true;
    }
    if (isDraggingRef.current)
      setPan({ x: dragRef.current.px + (e.clientX - dragRef.current.mx), y: dragRef.current.py + (e.clientY - dragRef.current.my) });
  }, [isCVDrawMode]);

  const handlePointerUp    = useCallback(() => { pointerDownRef.current = false; isDraggingRef.current = false; }, []);
  const handlePointerLeave = useCallback(() => { pointerDownRef.current = false; isDraggingRef.current = false; }, []);

  // ── Wheel ─────────────────────────────────────────────────────────────────────
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  useEffect(() => {
    wheelRef.current = (e: WheelEvent) => {
      e.preventDefault();
      const vp = viewportRef.current; if (!vp) return;
      const vr = vp.getBoundingClientRect();
      if (e.ctrlKey) {
        const mx = e.clientX - vr.left, my = e.clientY - vr.top;
        const f  = e.deltaY > 0 ? 0.9 : 1.1;
        setZoom(z => {
          const nz = Math.min(20, Math.max(0.05, z * f));
          setPan(p => ({ x: mx - (mx - p.x) * (nz / z), y: my - (my - p.y) * (nz / z) }));
          scheduleRerender(nz);
          return nz;
        });
      } else {
        setPan(p => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
      }
    };
  });
  useEffect(() => {
    const vp = viewportRef.current; if (!vp) return;
    const h  = (e: WheelEvent) => wheelRef.current(e);
    vp.addEventListener('wheel', h, { passive: false });
    return () => vp.removeEventListener('wheel', h);
  }, []);

  // ── Status on CV done ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!cvMatcher.isSearching && cvMatcher.matches.length > 0)
      setStatus(`${cvMatcher.matches.length} match${cvMatcher.matches.length !== 1 ? 'es' : ''} · direct · ${Math.round(renderScaleRef.current * 72)} DPI`);
  }, [cvMatcher.isSearching, cvMatcher.matches.length]);

  const cursor = isCVDrawMode ? 'crosshair' : (pdfDocRef.current ? 'grab' : 'default');

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div style={S.root}>

      <Script src={PDFJS_CDN_JS} strategy="lazyOnload" onLoad={() => setPdfJsReady(true)} />

      {/* ── Toolbar ── */}
      <div style={S.toolbar}>
        <span style={{ fontSize:9,fontWeight:700,color:'#555',textTransform:'uppercase',letterSpacing:'.1em',marginRight:4,flexShrink:0 }}>⊕ PDF CV Match</span>
        <div style={S.sep} />

        <label style={{ fontSize:8,textTransform:'uppercase',letterSpacing:'.07em',border:'1px solid #383838',background:'transparent',color: pdfJsReady ? '#999' : '#444',padding:'3px 9px',cursor: pdfJsReady ? 'pointer' : 'not-allowed',fontFamily:'inherit',flexShrink:0 }}>
          ↑ Load PDF
          <input ref={fileInputRef} type="file" accept=".pdf" style={{ display:'none' }} onChange={handleUpload} disabled={!pdfJsReady} />
        </label>
        <div style={S.sep} />

        {/* PDF.js status dot */}
        <div style={{ display:'flex',alignItems:'center',gap:4,flexShrink:0 }}>
          <div style={{ width:5,height:5,borderRadius:'50%',background: pdfJsReady ? '#22c55e' : '#f59e0b' }} />
          <span style={{ fontSize:7,color: pdfJsReady ? '#22c55e' : '#f59e0b',textTransform:'uppercase',letterSpacing:'.06em' }}>
            {pdfJsReady ? 'PDF.js' : 'Loading…'}
          </span>
        </div>
        <div style={S.sep} />

        {/* CV controls */}
        {cvSamplerMode === 'idle' && pdfDocRef.current && (
          <button onClick={handleEnterCVDraw} style={tbBtn(false, '#38bdf8')}>⊡ Draw Box</button>
        )}
        {cvSamplerMode === 'drawing' && (
          <span style={{ fontSize:8,color: tooLarge ? '#f43f5e' : '#38bdf8',textTransform:'uppercase',letterSpacing:'.07em' }}>
            {tooLarge ? '⚠ Zoom in more' : 'Drag tight box around ONE symbol'}
          </span>
        )}
        {cvSamplerMode === 'matched' && (
          <>
            <span style={{ fontSize:8,border:'1px solid #38bdf844',padding:'2px 6px',color:'#38bdf8',flexShrink:0 }}>
              {cvMatcher.matches.length} match{cvMatcher.matches.length !== 1 ? 'es' : ''}
            </span>
            <button onClick={handleEnterCVDraw} style={tbBtn(false,'#38bdf8')}>⊡ New</button>
            <button onClick={handleClearCV}     style={tbBtn(false)}>✕ Clear</button>
          </>
        )}

        <div style={{ flex:1 }} />
        <span style={S.statusTxt}>{status}</span>
        <div style={S.sep} />

        <button onClick={() => setZoom(z => Math.max(0.05, z * 0.85))} style={tbBtn(false)}>−</button>
        <span style={{ fontSize:8,color:'#555',minWidth:38,textAlign:'center' }}>{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom(z => Math.min(20, z * 1.15))} style={tbBtn(false)}>+</button>
        <button onClick={fitCanvas} style={tbBtn(false)} title="Fit to window">⊡</button>
        <div style={S.sep} />
        <button onClick={() => setShowSidebar(v => !v)} style={tbBtn(showSidebar, '#38bdf8')}>
          Panel {showSidebar ? '●' : '○'}
        </button>
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
          onContextMenu={e => e.preventDefault()}
          onDragOver={e => e.preventDefault()}
          onDrop={handleDrop}
        >
          {isIdle    && <IdleScreen pdfJsReady={pdfJsReady} />}
          {isLoading && <LoadingOverlay active fileName={fileName} />}

          <div ref={wrapRef} style={S.canvasWrap}>
            <canvas ref={baseCanvasRef} style={{ display:'block',imageRendering:'auto' }} />
          </div>

          {/* CV overlays */}
          <CVWorkerBanner isSearching={cvMatcher.isSearching} workerPhase={cvMatcher.workerPhase} workerDetail={cvMatcher.workerDetail} />
          <CVRubberBand
            isDrawing={isDrawing} drawBox={tooLarge ? null : drawBox} tooLarge={tooLarge}
            isSearching={cvMatcher.isSearching} workerPhase={cvMatcher.workerPhase} workerDetail={cvMatcher.workerDetail}
          />
          {isDrawing && tooLarge && drawBox && (
            <svg style={{ position:'absolute',inset:0,pointerEvents:'none',zIndex:36,overflow:'visible' }} width="100%" height="100%">
              <rect x={drawBox.x} y={drawBox.y} width={drawBox.w} height={drawBox.h} fill="rgba(244,63,94,0.06)" stroke="#f43f5e" strokeWidth={1.5} strokeDasharray="6 3" />
              <text x={drawBox.x+drawBox.w/2} y={drawBox.y+drawBox.h/2} textAnchor="middle" fontSize={9} fill="#f43f5e" fontFamily="'Courier New',monospace">
                Zoom in — box covers too much of viewport
              </text>
            </svg>
          )}
          <CVMatchOverlay matches={cvMatcher.matches} zoom={zoom} pan={pan} />

          {/* Badges */}
          {!isIdle && !isLoading && <QualityBadge renderScale={renderScale} isRerendering={isRerendering} />}

          {!isIdle && !isLoading && fileName && (
            <div style={{ position:'absolute',bottom:10,left:10,background:'rgba(255,255,255,.92)',border:'1px solid #ccc',padding:'3px 8px',fontSize:9,color:'#666',textTransform:'uppercase',letterSpacing:'.08em',pointerEvents:'none' }}>
              {fileName}
            </div>
          )}
          {cvSamplerMode === 'drawing' && (
            <div style={{ position:'absolute',top:10,left:10,background:'rgba(56,189,248,.12)',border:'1px solid rgba(56,189,248,.4)',padding:'3px 8px',fontSize:8,color:'#38bdf8',textTransform:'uppercase',letterSpacing:'.1em',pointerEvents:'none' }}>
              {tooLarge ? '⚠ Zoom in more — box too large' : 'Direct CV Match · drag tight box around ONE symbol'}
            </div>
          )}
          {cvSamplerMode === 'matched' && cvMatcher.matches.length > 0 && !cvMatcher.isSearching && (
            <div style={{ position:'absolute',top:10,left:10,background:'rgba(56,189,248,.12)',border:'1px solid rgba(56,189,248,.3)',padding:'3px 8px',fontSize:8,color:'#38bdf8',textTransform:'uppercase',letterSpacing:'.1em',pointerEvents:'none' }}>
              {cvMatcher.matches.length} match{cvMatcher.matches.length !== 1 ? 'es' : ''} · direct · pixel-precise
            </div>
          )}
        </div>

        {/* ── Sidebar ── */}
        {showSidebar && (
          <SidebarShell>
            <SidebarHeader onClose={() => setShowSidebar(false)} />
            <CVSamplerSidebar
              matcher={cvMatcher}
              samplerMode={cvSamplerMode}
              onEnterDraw={handleEnterCVDraw}
              onClear={handleClearCV}
              threshold={cvThreshold}   onThreshold={setCVThreshold}
              rotations={cvRotations}   onRotations={setCVRotations}
              flips={cvFlips}           onFlips={setCVFlips}
              removeText={cvRemoveText} onRemoveText={setCVRemoveText}
              scales={cvScales}         onScales={setCVScales}
            />
          </SidebarShell>
        )}
      </div>

      {/* ── Status bar ── */}
      <div style={S.statusbar}>
        {cvSamplerMode === 'drawing' ? (
          <span style={{ fontSize:8,color:tooLarge?'#f43f5e':'#38bdf8',textTransform:'uppercase',letterSpacing:'.07em' }}>
            {tooLarge ? '⚠ Zoom in more' : 'Drag tight box around ONE symbol'}
          </span>
        ) : (
          ['Draw box to sample','Find all matches','Ctrl+scroll: zoom','Drag: pan'].map((h, i) => (
            <React.Fragment key={h}>
              {i > 0 && <div style={S.barSep} />}
              <span style={{ fontSize:8,color:'#38bdf8',textTransform:'uppercase',letterSpacing:'.07em' }}>{h}</span>
            </React.Fragment>
          ))
        )}
        <div style={{ flex:1 }} />
        {isRerendering && (
          <><span style={{ fontSize:8,color:'#f59e0b',textTransform:'uppercase',letterSpacing:'.07em' }}>⟳ Upscaling…</span><div style={S.barSep} /></>
        )}
        {cvMatcher.isSearching && (
          <><span style={{ fontSize:8,color:'#38bdf8',textTransform:'uppercase',letterSpacing:'.07em' }}>
            ⟳ {cvMatcher.workerPhase}{cvMatcher.workerDetail ? ' · ' + cvMatcher.workerDetail : ''}
          </span><div style={S.barSep} /></>
        )}
        <span style={{ fontSize:8,color:'#2e2e2e',textTransform:'uppercase',letterSpacing:'.07em' }}>{fileName}</span>
      </div>
    </div>
  );
}
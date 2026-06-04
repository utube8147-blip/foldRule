// app/(test)/magicFill/page.tsx
'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Script from 'next/script';
import { usePdfFill, hexToRgb, fmtArea, fmtPerim, COLORS } from '@/hooks/fill/magicFill/usePdfFill';
import { useSvgFill } from '@/hooks/fill/magicFill/useSvgFill';
import { FillToolbar } from '@/components/magicFill/FillToolbar';
import { FillSidebar, MeasRow } from '@/components/magicFill/FillSidebar';
import { PlanarGraphDebug } from '@/components/magicFill/PlanarGraphDebug';

// ── Loading screen ───────────────────────────────────────────────────────────

const LOAD_LINES = [
  'Parsing document structure',
  'Rasterising vector geometry',
  'Sampling pixel luminance',
  'Classifying stroke connectivity',
  'Morphological mask refinement',
  'Indexing fill regions',
];

function LoadingScreen({ stage, progress, fileName }: { stage: string; progress: string; fileName: string }) {
  const [dots, setDots] = React.useState('');
  const [tick, setTick] = React.useState(0);
  useEffect(() => {
    if (stage !== 'loading') { setTick(0); setDots(''); return; }
    const id = setInterval(() => {
      setDots(d => (d.length >= 3 ? '' : d + '.'));
      setTick(t => (t + 1) % (LOAD_LINES.length * 4));
    }, 420);
    return () => clearInterval(id);
  }, [stage]);
  if (stage === 'ready') return null;
  const lineIdx = tick % LOAD_LINES.length;
  return (
    <div style={{ position:'absolute',inset:0,zIndex:100,background:'#0c0c0c',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',fontFamily:"'Courier New',monospace" }}>
      <style>{`@keyframes gridmove{from{background-position:0 0}to{background-position:40px 40px}}@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
      <div style={{ position:'absolute',inset:0,opacity:0.055,backgroundImage:'linear-gradient(#f59e0b 1px,transparent 1px),linear-gradient(90deg,#f59e0b 1px,transparent 1px)',backgroundSize:'40px 40px',animation:'gridmove 6s linear infinite',pointerEvents:'none' }}/>
      <div style={{ position:'relative',zIndex:1,textAlign:'center',width:320 }}>
        <div style={{ position:'relative',width:56,height:56,margin:'0 auto 26px' }}>
          <div style={{ position:'absolute',inset:0,border:'1.5px solid #1c1c1c',borderRadius:'50%' }}/>
          {stage === 'loading' && <div style={{ position:'absolute',inset:0,border:'1.5px solid transparent',borderTopColor:'#f59e0b',borderRadius:'50%',animation:'spin .9s linear infinite' }}/>}
          <div style={{ position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize:22,color:'#f59e0b' }}>⊕</div>
        </div>
        <div style={{ fontSize:10,fontWeight:700,color:'#f59e0b',textTransform:'uppercase',letterSpacing:'.18em',marginBottom:4 }}>
          {stage === 'idle' ? 'FloodFill Studio' : 'Processing'}
        </div>
        {stage === 'idle' && (
          <>
            <p style={{ fontSize:9,color:'#333',textTransform:'uppercase',letterSpacing:'.1em',margin:'14px 0 20px' }}>Load a PDF or SVG floor plan to begin</p>
            <div style={{ display:'flex',gap:10,justifyContent:'center' }}>
              {['PDF','SVG'].map(t => <div key={t} style={{ border:'1px solid #1e1e1e',padding:'6px 18px',fontSize:9,color:'#2a2a2a',textTransform:'uppercase',letterSpacing:'.12em' }}>{t}</div>)}
            </div>
            <p style={{ fontSize:8,color:'#222',textTransform:'uppercase',letterSpacing:'.08em',marginTop:20,lineHeight:2 }}>Left-click: fill · Drag: pan · Space+drag: select multiple</p>
          </>
        )}
        {stage === 'loading' && (
          <>
            <div style={{ fontSize:9,color:'#444',marginBottom:22,minHeight:13 }}>{fileName}</div>
            <div style={{ textAlign:'left',padding:'0 8px',marginBottom:20 }}>
              {LOAD_LINES.map((line, i) => {
                const isActive = i === lineIdx, isDone = i < lineIdx;
                return (
                  <div key={line} style={{ display:'flex',alignItems:'center',gap:10,padding:'3px 0',opacity:isActive?1:isDone?0.3:0.1,transition:'opacity .35s' }}>
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

function FillProgressOverlay({ active, message, sub, progress }: { active: boolean; message: string; sub?: string; progress?: { done: number; total: number } | null }) {
  const [dots, setDots] = React.useState('');
  useEffect(() => {
    if (!active) { setDots(''); return; }
    const id = setInterval(() => setDots(d => (d.length >= 3 ? '' : d + '.')), 350);
    return () => clearInterval(id);
  }, [active]);
  if (!active) return null;
  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : null;
  return (
    <div style={{ position:'absolute',inset:0,zIndex:80,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',background:'rgba(10,10,10,0.45)',backdropFilter:'blur(1px)',pointerEvents:'none' }}>
      <style>{`@keyframes fillspin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}@keyframes fillpulse{0%,100%{opacity:.7}50%{opacity:1}}`}</style>
      <div style={{ background:'#0d0d0d',border:'1px solid #2a2a2a',padding:'20px 32px',display:'flex',flexDirection:'column',alignItems:'center',gap:14,minWidth:240,boxShadow:'0 8px 40px rgba(0,0,0,0.7)' }}>
        <div style={{ position:'relative',width:36,height:36 }}>
          <div style={{ position:'absolute',inset:0,border:'1.5px solid #1c1c1c',borderRadius:'50%' }}/>
          <div style={{ position:'absolute',inset:0,border:'1.5px solid transparent',borderTopColor:'#f59e0b',borderRadius:'50%',animation:'fillspin .7s linear infinite' }}/>
          <div style={{ position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize:14,color:'#f59e0b',animation:'fillpulse 1.4s ease-in-out infinite' }}>⊕</div>
        </div>
        <div style={{ textAlign:'center',width:'100%' }}>
          <div style={{ fontSize:9,color:'#ccc',textTransform:'uppercase',letterSpacing:'.1em',fontFamily:"'Courier New',monospace" }}>{message}{dots}</div>
          {sub && <div style={{ fontSize:8,color:'#555',textTransform:'uppercase',letterSpacing:'.07em',marginTop:5,fontFamily:"'Courier New',monospace" }}>{sub}</div>}
          {pct !== null && (
            <div style={{ marginTop:12,width:'100%' }}>
              <div style={{ height:3,background:'#1a1a1a',borderRadius:2,overflow:'hidden' }}>
                <div style={{ height:'100%',width:`${pct}%`,background:'linear-gradient(90deg,#f59e0b,#fbbf24)',borderRadius:2,transition:'width 0.15s ease',boxShadow:'0 0 8px rgba(245,158,11,0.6)' }}/>
              </div>
              <div style={{ fontSize:8,color:'#555',textAlign:'right',marginTop:4,fontFamily:"'Courier New',monospace",letterSpacing:'.05em' }}>{progress!.done}/{progress!.total}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SelectionOverlay({ rect, zoom, pan }: { rect: { x1:number;y1:number;x2:number;y2:number }|null; zoom:number; pan:{x:number;y:number} }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvasRef.current; if (!c) return;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0,0,c.width,c.height);
    if (!rect) return;
    const sx=rect.x1*zoom+pan.x, sy=rect.y1*zoom+pan.y, sw=(rect.x2-rect.x1)*zoom, sh=(rect.y2-rect.y1)*zoom;
    ctx.fillStyle='rgba(96,165,250,0.08)'; ctx.fillRect(sx,sy,sw,sh);
    ctx.strokeStyle='rgba(96,165,250,0.9)'; ctx.lineWidth=1.5; ctx.setLineDash([6,4]); ctx.strokeRect(sx,sy,sw,sh); ctx.setLineDash([]);
    for (const [hx,hy] of [[sx,sy],[sx+sw,sy],[sx+sw,sy+sh],[sx,sy+sh]] as [number,number][]) {
      ctx.fillStyle='#60a5fa'; ctx.fillRect(hx-4,hy-4,8,8);
      ctx.strokeStyle='#0f172a'; ctx.lineWidth=1; ctx.strokeRect(hx-4,hy-4,8,8);
    }
    ctx.font='10px "Courier New"'; ctx.fillStyle='rgba(96,165,250,0.85)';
    ctx.fillText(`${Math.abs(rect.x2-rect.x1)}×${Math.abs(rect.y2-rect.y1)}px`,sx+6,sy+16);
  }, [rect,zoom,pan]);
  useEffect(() => {
    const resize = () => { const c=canvasRef.current; if(!c) return; c.width=c.offsetWidth; c.height=c.offsetHeight; };
    resize(); window.addEventListener('resize',resize); return ()=>window.removeEventListener('resize',resize);
  }, []);
  return <canvas ref={canvasRef} style={{ position:'absolute',inset:0,width:'100%',height:'100%',pointerEvents:'none',zIndex:20 }}/>;
}

// ── SvgOverlay — wrapped in React.memo so it never re-renders during pan/zoom.
// Pan and zoom are handled by the CSS transform on wrapRef; this component only
// needs to re-render when fill data, selection, or visibility actually changes.
interface SvgOverlayFillLocal { id:number;pathD:string;color:string;opacity:number;selected:boolean;inGroup:boolean;hidden:boolean }

const SvgOverlay = React.memo(function SvgOverlay({ fills, canvasW, canvasH }: {
  fills: SvgOverlayFillLocal[];
  canvasW: number;
  canvasH: number;
}) {
  if (canvasW === 0 || canvasH === 0) return null;
  return (
    <svg
      width={canvasW}
      height={canvasH}
      viewBox={`0 0 ${canvasW} ${canvasH}`}
      style={{ position:'absolute', top:0, left:0, pointerEvents:'none', display:'block' }}
      xmlns="http://www.w3.org/2000/svg"
    >
      {fills.map(f => {
        if (f.hidden) return null;
        const [r,g,b] = hexToRgb(f.color);
        return (
          <g key={f.id}>
            <path d={f.pathD} fill={`rgba(${r},${g},${b},${f.opacity/100})`} stroke="none"/>
            <path
              d={f.pathD}
              fill="none"
              stroke={
                f.selected   ? `rgba(${r},${g},${b},1)`
                : f.inGroup  ? 'rgba(96,165,250,0.9)'
                :               `rgba(${r},${g},${b},0.75)`
              }
              strokeWidth={f.selected ? 2.5 : f.inGroup ? 2 : 1.6}
              strokeLinejoin="round"
            />
          </g>
        );
      })}
    </svg>
  );
});

function NextColorDot({ color }: { color: string }) {
  return (
    <div style={{ position:'absolute',bottom:48,left:10,zIndex:30,display:'flex',alignItems:'center',gap:6,background:'rgba(10,10,10,0.85)',border:'1px solid #2a2a2a',padding:'4px 10px',pointerEvents:'none' }}>
      <span style={{ fontSize:7,color:'#444',textTransform:'uppercase',letterSpacing:'.08em' }}>Next</span>
      <div style={{ width:10,height:10,borderRadius:2,background:color,border:'1px solid rgba(255,255,255,0.2)' }}/>
    </div>
  );
}

function GraphDebugToggle({ active, onClick, nodeCount, edgeCount }: { active:boolean;onClick:()=>void;nodeCount:number;edgeCount:number }) {
  return (
    <button onClick={onClick} title="Toggle planar graph debug overlay" style={{ position:'absolute',bottom:48,right:10,zIndex:30,display:'flex',alignItems:'center',gap:6,background:active?'rgba(255,102,0,0.18)':'rgba(10,10,10,0.85)',border:`1px solid ${active?'rgba(255,102,0,0.7)':'#2a2a2a'}`,padding:'4px 10px',cursor:'pointer',fontFamily:"'Courier New',monospace",color:active?'#ff6600':'#444',transition:'all 0.15s' }}>
      <span style={{ fontSize:10 }}>⬡</span>
      <span style={{ fontSize:7,textTransform:'uppercase',letterSpacing:'.08em' }}>Graph{active?` · ${nodeCount}N ${edgeCount}E`:''}</span>
    </button>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function FloodFillPage() {
  const [fileType, setFileType] = useState<'pdf'|'svg'>('pdf');
  const [showGraphDebug, setShowGraphDebug] = useState(true);

  // rAF ref for throttling pointermove — prevents expensive redraws from firing
  // at 120Hz; caps work to one frame (≈16ms) regardless of device polling rate.
  const rafRef = useRef<number | null>(null);

  const pdfState = usePdfFill();
  const svgState = useSvgFill();

  const isSvgMode = fileType === 'svg';
  const state     = isSvgMode ? svgState : pdfState;

  const setViewportRef = (el: HTMLDivElement | null) => {
    (pdfState.viewportRef as React.MutableRefObject<HTMLDivElement|null>).current = el;
    (svgState.viewportRef as React.MutableRefObject<HTMLDivElement|null>).current = el;
  };

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const isSvg = file.name.toLowerCase().endsWith('.svg');
    setFileType(isSvg ? 'svg' : 'pdf');
    if (isSvg) svgState.handleUpload(e);
    else pdfState.handleUpload(e);
  };

  const loadStage    = isSvgMode ? svgState.loadStage    : pdfState.loadStage;
  const loadProgress = isSvgMode ? svgState.loadProgress : pdfState.loadProgress;

  const {
    activeColor, activeColorIdx, fillOpacity,
    zoom, setZoom, pan,
    mode, setMode,
    isFilling, fillMsg, fillSub, fillProgress,
    fills, hiddenIds,
    selectedId, setSelectedId,
    selectedGroup, setSelectedGroup,
    hoveredId, hoverPos,
    holesClosedIds, setHolesClosedIds,
    showPolygon, setShowPolygon,
    status, fileName,
    pxPerM,
    selectRect, isSelecting, spaceHeld,
    batchMode, setBatchMode, batchModeRef,
    selectedFill, hoveredFill, groupFills,
    hasSelection, cursor,
    wrapRef, baseCanvasRef, fillCanvasRef, polyCanvasRef, fileInputRef,
    handleUndo, handleClearAll, handleFillHoles, handleExport,
    handleDeleteFill, toggleHidden,
    handleContextMenu, handlePointerDown, handlePointerMove, handlePointerUp,
    centerCanvas, closeFillHoles, redrawPolygons,
    setActiveColor, setFillOpacity, setPxPerM, setFills,
  } = state;

  // Throttled pointermove — the raw handler may trigger redrawPolygons, hover
  // state, and cursor updates. Without rAF this fires at device polling rate
  // (up to 120–240 Hz on modern screens), causing multiple expensive canvas
  // redraws per display frame. We coalesce all events into one per frame.
  const handlePointerMoveFn = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (rafRef.current !== null) return;
    // Persist the synthetic event before the rAF fires (React pools events).
    e.persist();
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      handlePointerMove(e);
    });
  }, [handlePointerMove]);

  const handleCloseHoles = useCallback(async (id: number) => {
    const result = await closeFillHoles(id);
    if (!result) return;
    setFills(prev => prev.map(f => f.id===id ? {...f,...result} : f));
    setHolesClosedIds(prev => new Set(prev).add(id));
    redrawPolygons(fills.map(f => f.id===id?{...f,...result}:f), hiddenIds, selectedId, selectedGroup);
  }, [closeFillHoles, setFills, setHolesClosedIds, redrawPolygons, fills, hiddenIds, selectedId, selectedGroup]);

  // SVG-only values
  const svgFillsList    = isSvgMode ? svgState.svgFillsList    : [];
  const svgOverlayFills = isSvgMode ? svgState.svgOverlayFills : [];
  const svgCanvasSize   = isSvgMode ? svgState.svgCanvasSize   : { w:0, h:0 };
  const svgShapesRef    = isSvgMode ? svgState.svgShapesRef    : { current: [] };
  const handleSvgExport = isSvgMode ? svgState.handleSvgExport : () => {};

  // Planar graph
  const planarGraph    = isSvgMode ? svgState.planarGraphRef.current : null;
  const graphNodeCount = planarGraph?.nodes.length ?? 0;
  const graphEdgeCount = planarGraph?.edges.length ?? 0;

  const nextColor   = COLORS[(activeColorIdx + 1) % COLORS.length];
  const tooltipLeft = hoverPos.x + 20;
  const tooltipTop  = hoverPos.y - 10;

  return (
    <div style={{ display:'flex',flexDirection:'column',height:'100vh',background:'#151515',color:'#ccc',fontFamily:"'Courier New',monospace",overflow:'hidden' }}>
      <Script src="https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js" strategy="lazyOnload"/>

      <FillToolbar
        isSvgMode={isSvgMode} loadStage={loadStage} fileName={fileName}
        mode={mode} setMode={setMode}
        batchMode={batchMode} setBatchMode={setBatchMode} batchModeRef={batchModeRef}
        spaceHeld={spaceHeld}
        activeColor={activeColor} setActiveColor={setActiveColor}
        fillOpacity={fillOpacity} setFillOpacity={setFillOpacity}
        showPolygon={showPolygon} setShowPolygon={setShowPolygon}
        pxPerM={pxPerM} setPxPerM={setPxPerM}
        zoom={zoom} setZoom={setZoom} centerCanvas={centerCanvas}
        fills={fills} hasSelection={hasSelection} selectedFill={selectedFill}
        selectedGroup={selectedGroup} groupFills={groupFills}
        isFilling={isFilling} status={status}
        handleUndo={handleUndo} handleFillHoles={handleFillHoles} handleClearAll={handleClearAll}
        fileInputRef={fileInputRef as React.RefObject<HTMLInputElement>}
        handleUpload={handleUpload}
      />

      <div style={{ display:'flex',flex:1,overflow:'hidden',minHeight:0 }}>
        <div
          ref={setViewportRef}
          style={{ flex:1,position:'relative',overflow:'hidden',background:'#F8F7F3',backgroundImage:'radial-gradient(circle,#D0CEC8 1px,transparent 1px)',backgroundSize:'20px 20px',cursor,userSelect:'none' }}
          onMouseLeave={() => state.setHoveredId(null)}
          onContextMenu={handleContextMenu}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMoveFn}
          onPointerUp={handlePointerUp}
          onPointerLeave={() => state.setHoveredId(null)}
        >
          <LoadingScreen stage={loadStage} progress={loadProgress} fileName={fileName}/>

          <div ref={wrapRef} style={{ position:'absolute',top:0,left:0,transformOrigin:'0 0',willChange:'transform' }}>
            <canvas ref={baseCanvasRef} style={{ display:'block',imageRendering:'auto' }}/>
            <canvas ref={fillCanvasRef} style={{ display:'block',position:'absolute',top:0,left:0,pointerEvents:'none',imageRendering:'auto' }}/>

            {/* SvgOverlay lives here — same as before. It moves with wrapRef's
                CSS transform for free. React.memo ensures it never re-renders
                during pan/zoom; only re-renders when fill data changes. */}
            {isSvgMode && svgOverlayFills.length > 0 && (
              <SvgOverlay
                fills={svgOverlayFills}
                canvasW={svgCanvasSize.w}
                canvasH={svgCanvasSize.h}
              />
            )}

            <canvas ref={polyCanvasRef} style={{ display:'block',position:'absolute',top:0,left:0,pointerEvents:'none',imageRendering:'auto' }}/>

            {isSvgMode && (
              <PlanarGraphDebug
                graphRef={svgState.planarGraphRef}
                canvasW={svgCanvasSize.w}
                canvasH={svgCanvasSize.h}
                visible={showGraphDebug && loadStage === 'ready'}
                graphReady={svgState.graphReady}
              />
            )}
          </div>

          <SelectionOverlay rect={selectRect} zoom={zoom} pan={pan}/>
          <FillProgressOverlay active={isFilling} message={fillMsg} sub={fillSub} progress={fillProgress}/>

          {isSelecting && (
            <div style={{ position:'absolute',top:10,left:'50%',transform:'translateX(-50%)',background:'rgba(10,10,10,.85)',border:'1px solid #60a5fa',padding:'4px 12px',fontSize:8,color:'#60a5fa',textTransform:'uppercase',letterSpacing:'.1em',pointerEvents:'none',zIndex:30 }}>
              {isSvgMode ? 'Release to fill all shapes in selection' : 'Release to fill all rooms in selection'}
            </div>
          )}

          {isSvgMode && loadStage === 'ready' && (
            <div style={{ position:'absolute',top:10,right:10,background:'rgba(13,13,13,.9)',border:'1px solid rgba(52,211,153,.4)',padding:'3px 10px',fontSize:8,color:'#34d399',textTransform:'uppercase',letterSpacing:'.09em',pointerEvents:'none',zIndex:30 }}>
              ⬡ Vector mode · {svgShapesRef.current.length} shapes indexed
            </div>
          )}

          {loadStage === 'ready' && fileName && (
            <div style={{ position:'absolute',bottom:10,left:10,background:'rgba(255,255,255,.92)',border:'1px solid #ccc',padding:'3px 8px',fontSize:9,color:'#666',textTransform:'uppercase',letterSpacing:'.08em',pointerEvents:'none' }}>
              {fileName}
            </div>
          )}

          {loadStage === 'ready' && fills.length > 0 && <NextColorDot color={nextColor}/>}

          {isSvgMode && loadStage === 'ready' && (
            <GraphDebugToggle
              active={showGraphDebug}
              onClick={() => setShowGraphDebug(v => !v)}
              nodeCount={graphNodeCount}
              edgeCount={graphEdgeCount}
            />
          )}

          {hoveredFill && loadStage === 'ready' && (
            <div style={{ position:'absolute',left:tooltipLeft,top:tooltipTop,background:'rgba(10,10,10,.97)',border:'1px solid #2a2a2a',padding:'10px 14px',pointerEvents:'none',minWidth:210,zIndex:50,boxShadow:'0 4px 24px rgba(0,0,0,.6)' }}>
              <div style={{ fontSize:8,color:'#f59e0b',textTransform:'uppercase',letterSpacing:'.1em',marginBottom:8,display:'flex',alignItems:'center',gap:6 }}>
                <div style={{ width:9,height:9,borderRadius:1,background:hoveredFill.color,flexShrink:0 }}/>
                {hoveredFill.label}
                {hoveredFill.svgMode && <span style={{ color:'#34d399',fontSize:7,border:'1px solid rgba(52,211,153,.3)',padding:'1px 3px' }}>VEC</span>}
                {hoveredFill.groupId!=null && <span style={{ color:'#60a5fa',fontSize:7,marginLeft:2 }}>· group {hoveredFill.groupId}</span>}
              </div>
              <div style={{ height:1,background:'#1e1e1e',marginBottom:8 }}/>
              <MeasRow label="Area" value={fmtArea(hoveredFill.areaPx,pxPerM)} sub={`${hoveredFill.areaPx.toLocaleString()} px²`}/>
              <MeasRow label="Perimeter" value={fmtPerim(hoveredFill.perimPx,pxPerM)} sub={`${hoveredFill.perimPx.toLocaleString()} px`}/>
              <MeasRow label="Corners" value={String(hoveredFill.polygon.length)} sub={hoveredFill.svgMode?'from vector path':'marching squares'}/>
              {holesClosedIds.has(hoveredFill.id) && (
                <div style={{ marginTop:7,display:'flex',alignItems:'center',gap:5,borderTop:'1px solid #1e1e1e',paddingTop:6 }}>
                  <span style={{ fontSize:8,color:'#34d399' }}>⊞</span>
                  <span style={{ fontSize:7,color:'#34d399',textTransform:'uppercase',letterSpacing:'.07em' }}>Holes closed</span>
                </div>
              )}
            </div>
          )}

          {selectedGroup!=null && groupFills.length>0 && !hoveredFill && loadStage==='ready' && (
            <div style={{ position:'absolute',bottom:10,right:10,background:'rgba(13,13,13,.95)',border:'1px solid #60a5fa',padding:'10px 14px',pointerEvents:'none',minWidth:230,boxShadow:'0 4px 24px rgba(0,0,0,.5)' }}>
              <div style={{ fontSize:8,color:'#60a5fa',textTransform:'uppercase',letterSpacing:'.1em',marginBottom:7,display:'flex',alignItems:'center',gap:6 }}>
                <span style={{ fontSize:11 }}>⬡</span>
                {groupFills.length} regions selected
                <span style={{ color:'#383838',marginLeft:2,fontSize:7 }}>group {selectedGroup}</span>
                {groupFills.some(f=>f.svgMode) && <span style={{ color:'#34d399',fontSize:7,border:'1px solid rgba(52,211,153,.25)',padding:'1px 3px' }}>VEC</span>}
              </div>
              <div style={{ height:1,background:'#1e1e1e',marginBottom:8 }}/>
              <MeasRow label="Total Area" value={fmtArea(groupFills.reduce((s,f)=>s+f.areaPx,0),pxPerM)} sub={`${groupFills.reduce((s,f)=>s+f.areaPx,0).toLocaleString()} px²`}/>
              <MeasRow label="Total Perim" value={fmtPerim(groupFills.reduce((s,f)=>s+f.perimPx,0),pxPerM)} sub={`${groupFills.reduce((s,f)=>s+f.perimPx,0).toLocaleString()} px`}/>
              <div style={{ marginTop:8,borderTop:'1px solid #1a1a1a',paddingTop:7 }}>
                {groupFills.map(f => (
                  <div key={f.id} style={{ display:'flex',alignItems:'center',gap:5,marginBottom:3 }}>
                    <div style={{ width:7,height:7,borderRadius:1,background:f.color,flexShrink:0 }}/>
                    <span style={{ fontSize:7,color:'#555',flex:1 }}>{f.label}</span>
                    <span style={{ fontSize:7,color:'#888' }}>{fmtArea(f.areaPx,pxPerM)}</span>
                    {f.svgMode && <span style={{ fontSize:6,color:'#34d399' }}>V</span>}
                    {holesClosedIds.has(f.id) && <span style={{ fontSize:7,color:'#34d399' }}>⊞</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {selectedFill && !hoveredFill && selectedGroup==null && loadStage==='ready' && (
            <div style={{ position:'absolute',bottom:10,right:10,background:'rgba(13,13,13,.95)',border:'1px solid #2a2a2a',padding:'10px 14px',pointerEvents:'none',minWidth:210,boxShadow:'0 4px 24px rgba(0,0,0,.5)' }}>
              <div style={{ fontSize:8,color:'#f59e0b',textTransform:'uppercase',letterSpacing:'.1em',marginBottom:7,display:'flex',alignItems:'center',gap:6 }}>
                <div style={{ width:8,height:8,borderRadius:1,background:selectedFill.color }}/>
                {selectedFill.label}
                {selectedFill.svgMode && <span style={{ color:'#34d399',fontSize:7,border:'1px solid rgba(52,211,153,.3)',padding:'1px 3px' }}>VEC</span>}
                <span style={{ color:'#383838',marginLeft:2,fontSize:7 }}>selected</span>
              </div>
              <div style={{ height:1,background:'#1e1e1e',marginBottom:8 }}/>
              <MeasRow label="Area" value={fmtArea(selectedFill.areaPx,pxPerM)} sub={`${selectedFill.areaPx.toLocaleString()} px²`}/>
              <MeasRow label="Perimeter" value={fmtPerim(selectedFill.perimPx,pxPerM)} sub={`${selectedFill.perimPx.toLocaleString()} px`}/>
              <MeasRow label="Corners" value={String(selectedFill.polygon.length)} sub={selectedFill.svgMode?'from vector path':'marching squares'}/>
            </div>
          )}
        </div>

        <FillSidebar
          activeColor={activeColor} fillOpacity={fillOpacity}
          fills={fills} hiddenIds={hiddenIds}
          selectedId={selectedId} selectedGroup={selectedGroup} hoveredId={hoveredId}
          holesClosedIds={holesClosedIds} pxPerM={pxPerM}
          isSvgMode={isSvgMode} svgFillsList={svgFillsList}
          setSelectedId={setSelectedId} setSelectedGroup={setSelectedGroup}
          toggleHidden={toggleHidden} handleDeleteFill={handleDeleteFill}
          onCloseHoles={handleCloseHoles} handleExport={handleExport} handleSvgExport={handleSvgExport}
        />
      </div>

      <div style={{ height:24,background:'#0a0a0a',borderTop:'1px solid #1a1a1a',display:'flex',alignItems:'center',padding:'0 10px',gap:12,flexShrink:0 }}>
        {[
          isSvgMode?'Click: fill shape':'Click: fill room',
          'Drag: pan','Space+drag: select multiple','Ctrl+scroll: zoom','Colors auto-cycle per fill',
          ...(isSvgMode?['Vec fills: crisp at any zoom']:[]),
        ].map((h,i) => (
          <React.Fragment key={h}>
            {i>0 && <div style={{ width:1,height:12,background:'#1e1e1e' }}/>}
            <span style={{ fontSize:8,color:'#2e2e2e',textTransform:'uppercase',letterSpacing:'.07em' }}>{h}</span>
          </React.Fragment>
        ))}
        <div style={{ flex:1 }}/>
        <div style={{ display:'flex',alignItems:'center',gap:5 }}>
          <span style={{ fontSize:7,color:'#2e2e2e',textTransform:'uppercase',letterSpacing:'.07em' }}>Fill color</span>
          <div style={{ width:9,height:9,borderRadius:1,background:activeColor,border:'1px solid rgba(255,255,255,0.1)' }}/>
        </div>
        <div style={{ width:1,height:12,background:'#1e1e1e' }}/>
        <span style={{ fontSize:8,color:'#2e2e2e',textTransform:'uppercase',letterSpacing:'.07em' }}>{fileName}</span>
      </div>
    </div>
  );
}
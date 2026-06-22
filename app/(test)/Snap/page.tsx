'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { usePdfDocument } from '@/hooks/usePdfDocument';
import { useSnapEngine } from '@/hooks/useSnapEngine';
import { SnapSidebar } from '@/components/SnapSidebar';
import { LoadingOverlay, IdleScreen } from '@/components/LoadingOverlay';
import type { SnapPoint } from '@/types/snapTypes';

const DRAG_THRESHOLD = 5;

interface Flash {
  id: number;
  x: number;
  y: number;
  color: string;
}

const SNAP_COLOURS: Record<SnapPoint['type'], string> = {
  endpoint:     '#f59e0b',
  midpoint:     '#10b981',
  centroid:     '#8b5cf6',
  intersection: '#f43f5e',
  'curve-node': '#38bdf8',
};

// ─── Flash ring ───────────────────────────────────────────────────────────────

function SnapFlashes({ flashes }: { flashes: Flash[] }) {
  return (
    <>
      <style>{`@keyframes sfade{0%{opacity:.9;transform:scale(1)}100%{opacity:0;transform:scale(2.8)}}`}</style>
      {flashes.map((f) => (
        <div
          key={f.id}
          className="absolute rounded-full pointer-events-none"
          style={{
            left: f.x - 10, top: f.y - 10,
            width: 20, height: 20,
            background: f.color,
            animation: 'sfade .6s ease-out forwards',
            zIndex: 50,
          }}
        />
      ))}
    </>
  );
}

function tbBtn(active: boolean, colour = '#f59e0b'): React.CSSProperties {
  return {
    fontSize: 8,
    textTransform: 'uppercase',
    letterSpacing: '.07em',
    border: `1px solid ${active ? colour : '#2a2a2a'}`,
    background: active ? `${colour}12` : 'transparent',
    color: active ? colour : '#777',
    padding: '3px 7px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PdfSnapEnginePage() {
  const pdf = usePdfDocument();

  const [zoom, setZoom]               = useState(1);
  const [pan, setPan]                 = useState({ x: 0, y: 0 });
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [showPins, setShowPins]       = useState(true);
  const [showGeometry, setShowGeometry] = useState(true); // default ON so hover works immediately
  const [snapThresh, setSnapThresh]   = useState(16);
  const [linearMode, setLinearMode]   = useState(true);
  const [tab, setTab]                 = useState<'chain' | 'points' | 'select'>('chain');
  const [flashes, setFlashes]         = useState<Flash[]>([]);

  const viewportRef   = useRef<HTMLDivElement>(null);
  const wrapRef       = useRef<HTMLDivElement>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const pinCanvasRef  = useRef<HTMLCanvasElement>(null);
  const fileInputRef  = useRef<HTMLInputElement>(null);

  const pointerDownRef = useRef(false);
  const isDraggingRef  = useRef(false);
  const dragRef        = useRef({ mx: 0, my: 0, px: 0, py: 0 });
  const panRef         = useRef(pan);
  const zoomRef        = useRef(zoom);
  const flashIdRef     = useRef(0);
  const dimsRef        = useRef(pdf.dims);

  useEffect(() => { panRef.current  = pan;      }, [pan]);
  useEffect(() => { zoomRef.current = zoom;     }, [zoom]);
  useEffect(() => { dimsRef.current = pdf.dims; }, [pdf.dims]);

  // ── Snap engine ─────────────────────────────────────────────────────────────

  const engine = useSnapEngine({
    pinCanvasRef:  pinCanvasRef  as React.RefObject<HTMLCanvasElement>,
    viewportRef:   viewportRef   as React.RefObject<HTMLDivElement>,
    dimsRef,
    snapEnabled,
    showPins,
    showGeometry,
    snapThreshold: snapThresh,
    snapPoints:    pdf.snapPoints,
    lines:         pdf.lines,
    curves:        pdf.curves,
    linearMode,
    zoom,
    pan,
  });

  // ── CSS transform ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (wrapRef.current) {
      wrapRef.current.style.transform = `translate(${pan.x}px,${pan.y}px) scale(${zoom})`;
    }
  }, [pan, zoom]);

  // ── Fit canvas to viewport ───────────────────────────────────────────────────

  const fitCanvas = useCallback(() => {
    const vp = viewportRef.current;
    const bc = baseCanvasRef.current;
    if (!vp || !bc || bc.width === 0) return;
    const vr = vp.getBoundingClientRect();
    const fz = Math.min((vr.width * 0.9) / bc.width, (vr.height * 0.9) / bc.height, 2);
    setZoom(fz);
    setPan({ x: (vr.width - bc.width * fz) / 2, y: (vr.height - bc.height * fz) / 2 });
  }, []);

  // ── File upload ──────────────────────────────────────────────────────────────

  const handleUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      e.target.value = '';
      engine.clearChain();
      engine.clearSelection();
      await pdf.loadFile(file);
    },
    [pdf, engine],
  );

  // After PDF done — render base canvas then fit
  useEffect(() => {
    if (pdf.stage === 'done' && baseCanvasRef.current && pdf.dims) {
      pdf.renderToCanvas(baseCanvasRef.current, 1).then(fitCanvas);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf.stage]);

  // ── Pointer coordinate helpers ───────────────────────────────────────────────

  const getCanvasXY = useCallback((e: React.PointerEvent | MouseEvent) => {
    const vr = viewportRef.current!.getBoundingClientRect();
    return {
      x: (e.clientX - vr.left - panRef.current.x) / zoomRef.current,
      y: (e.clientY - vr.top  - panRef.current.y) / zoomRef.current,
    };
  }, []);

  const getViewportXY = useCallback((e: React.PointerEvent | MouseEvent) => {
    const vr = viewportRef.current!.getBoundingClientRect();
    return { x: e.clientX - vr.left, y: e.clientY - vr.top };
  }, []);

  // ── Pointer handlers ─────────────────────────────────────────────────────────

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    pointerDownRef.current  = true;
    isDraggingRef.current   = false;
    dragRef.current = { mx: e.clientX, my: e.clientY, px: panRef.current.x, py: panRef.current.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      // Drag detection
      if (pointerDownRef.current && !isDraggingRef.current) {
        const dx = e.clientX - dragRef.current.mx;
        const dy = e.clientY - dragRef.current.my;
        if (Math.hypot(dx, dy) > DRAG_THRESHOLD) isDraggingRef.current = true;
      }

      if (isDraggingRef.current) {
        setPan({
          x: dragRef.current.px + (e.clientX - dragRef.current.mx),
          y: dragRef.current.py + (e.clientY - dragRef.current.my),
        });
        return;
      }

      if (!dimsRef.current) return;
      const cxy = getCanvasXY(e);
      engine.cursorPointRef.current = cxy;
      engine.redrawPinCanvas();
    },
    [engine, getCanvasXY],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      const wasActualDrag   = isDraggingRef.current;
      pointerDownRef.current = false;
      isDraggingRef.current  = false;
      if (wasActualDrag) return;
      if (!dimsRef.current) return;

      const cxy = getCanvasXY(e);
      const vxy = getViewportXY(e);

      // Selection — always active
      const newlySelected = engine.selectAt(cxy.x, cxy.y);
      if (newlySelected) {
        const selId = ++flashIdRef.current;
        setFlashes((prev) => [...prev, { id: selId, x: vxy.x, y: vxy.y, color: '#ffffff' }]);
        setTimeout(() => setFlashes((prev) => prev.filter((f) => f.id !== selId)), 700);
      }

      const result = engine.snapToCorner(cxy.x, cxy.y);

      if (linearMode) {
        const px = result.snapped ? result.point.x : cxy.x;
        const py = result.snapped ? result.point.y : cxy.y;
        const snappedType: SnapPoint['type'] | 'free' =
          result.snapped && result.type ? result.type : 'free';
        engine.addChainPoint(px, py, snappedType);
        const color = snappedType !== 'free' ? SNAP_COLOURS[snappedType] : '#f59e0b';
        const id    = ++flashIdRef.current;
        setFlashes((prev) => [...prev, { id, x: vxy.x, y: vxy.y, color }]);
        setTimeout(() => setFlashes((prev) => prev.filter((f) => f.id !== id)), 700);
      } else if (result.snapped) {
        const color = result.type ? SNAP_COLOURS[result.type] : '#f59e0b';
        const id    = ++flashIdRef.current;
        setFlashes((prev) => [...prev, { id, x: vxy.x, y: vxy.y, color }]);
        setTimeout(() => setFlashes((prev) => prev.filter((f) => f.id !== id)), 700);
      }
    },
    [linearMode, engine, getCanvasXY, getViewportXY],
  );

  const handlePointerLeave = useCallback(() => {
    pointerDownRef.current         = false;
    isDraggingRef.current          = false;
    engine.cursorPointRef.current  = null;
    engine.redrawPinCanvas();
  }, [engine]);

  // ── Keyboard ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') engine.clearSelection();
      if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        engine.undoChainPoint();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engine]);

  // ── Wheel zoom / pan ──────────────────────────────────────────────────────────

  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  useEffect(() => {
    wheelRef.current = (e: WheelEvent) => {
      e.preventDefault();
      const vp = viewportRef.current;
      if (!vp) return;
      const vr = vp.getBoundingClientRect();
      if (e.ctrlKey) {
        const mx = e.clientX - vr.left;
        const my = e.clientY - vr.top;
        const f  = e.deltaY > 0 ? 0.9 : 1.1;
        setZoom((z) => {
          const nz = Math.min(20, Math.max(0.05, z * f));
          setPan((p) => ({
            x: mx - (mx - p.x) * (nz / z),
            y: my - (my - p.y) * (nz / z),
          }));
          return nz;
        });
      } else {
        setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
      }
      engine.redrawPinCanvas();
    };
  });
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const h = (e: WheelEvent) => wheelRef.current(e);
    vp.addEventListener('wheel', h, { passive: false });
    return () => vp.removeEventListener('wheel', h);
  }, []);

  // Redraw whenever display state changes
  useEffect(() => {
    engine.redrawPinCanvas();
  }, [zoom, pan, showPins, showGeometry, engine]);

  // ── Chain jump / remove ───────────────────────────────────────────────────────

  const jumpToChainPoint = useCallback(
    (idx: number) => {
      const p = engine.linearChain[idx];
      if (!p) return;
      const vr = viewportRef.current!.getBoundingClientRect();
      setPan({ x: vr.width / 2 - p.x * zoomRef.current, y: vr.height / 2 - p.y * zoomRef.current });
    },
    [engine],
  );

  const removeChainPoint = useCallback(
    (idx: number) => {
      const updated = engine.linearChain.filter((_, i) => i !== idx);
      engine.clearChain();
      updated.forEach((p) => engine.addChainPoint(p.x, p.y, p.type));
    },
    [engine],
  );

  const jumpToSelection = useCallback(() => {
    if (!engine.selected) return;
    const vr = viewportRef.current!.getBoundingClientRect();
    setPan({
      x: vr.width  / 2 - engine.selected.x * zoomRef.current,
      y: vr.height / 2 - engine.selected.y * zoomRef.current,
    });
  }, [engine]);

  // ── Render ────────────────────────────────────────────────────────────────────

  const isIdle    = pdf.stage === 'idle' || pdf.stage === 'error';
  const isLoading = !isIdle && pdf.stage !== 'done';
  const cursor    = pdf.dims ? 'crosshair' : 'default';

  return (
    <div className="flex flex-col h-screen bg-[#151515] text-[#ccc] font-mono overflow-hidden">

      {/* ── Toolbar ── */}
      <div className="flex items-center gap-[5px] px-[10px] bg-[#0d0d0d] border-b border-[#222] flex-shrink-0 h-[42px] overflow-hidden">

        <span className="text-[9px] font-bold text-[#555] uppercase tracking-[.1em] mr-1 flex-shrink-0">⊕ PDF Snap Engine</span>
        <div className="w-px h-[18px] bg-[#222] flex-shrink-0" />

        <label className="text-[8px] uppercase tracking-[.07em] border border-[#383838] text-[#999] px-[9px] py-[3px] cursor-pointer flex-shrink-0">
          ↑ Load PDF
          <input ref={fileInputRef} type="file" accept=".pdf" className="hidden" onChange={handleUpload} />
        </label>
        <div className="w-px h-[18px] bg-[#222] flex-shrink-0" />

        <button onClick={() => setSnapEnabled((v) => !v)} style={tbBtn(snapEnabled)}>
          Snap {snapEnabled ? '●' : '○'}
        </button>
        <button onClick={() => setShowPins((v) => !v)} style={tbBtn(showPins)}>
          Pins {showPins ? '●' : '○'}
        </button>
        <button onClick={() => setShowGeometry((v) => !v)} style={tbBtn(showGeometry, '#38bdf8')}>
          Geometry {showGeometry ? '●' : '○'}
        </button>
        <div className="w-px h-[18px] bg-[#222] flex-shrink-0" />

        <button onClick={() => setLinearMode((v) => !v)} style={tbBtn(linearMode, '#a78bfa')}>
          Linear {linearMode ? '●' : '○'}
        </button>

        {linearMode && (
          <>
            <button onClick={() => engine.undoChainPoint()} style={tbBtn(false)}>
              Undo
            </button>
            <button
              onClick={() => engine.clearChain()}
              style={{ ...tbBtn(false), color: '#f43f5e', borderColor: engine.linearChain.length > 0 ? '#f43f5e44' : '#2a2a2a' }}
            >
              Clear
            </button>
            <span
              className="text-[8px] border border-[#2a2a2a] px-[6px] py-[2px]"
              style={{ color: engine.linearChain.length > 0 ? '#a78bfa' : '#333' }}
            >
              {engine.linearChain.length} pts
            </span>
          </>
        )}

        <div className="w-px h-[18px] bg-[#222] flex-shrink-0" />
        <span className="text-[8px] text-[#444] uppercase tracking-[.08em] whitespace-nowrap">Threshold</span>
        <input
          type="range" min={4} max={60} step={1} value={snapThresh}
          onChange={(e) => setSnapThresh(+e.target.value)}
          className="w-[56px] accent-[#f59e0b]"
        />
        <span className="text-[8px] text-[#f59e0b] min-w-[28px]">{snapThresh}px</span>

        {engine.selected && (
          <>
            <div className="w-px h-[18px] bg-[#222] flex-shrink-0" />
            <span className="text-[8px] border border-[#3a3a3a] px-[6px] py-[2px] text-[#fff] uppercase tracking-[.06em] whitespace-nowrap">
              Selected: {engine.selected.kind}
            </span>
          </>
        )}

        <div className="flex-1" />
        <span className="text-[8px] text-[#555] uppercase tracking-[.07em] max-w-[340px] overflow-hidden text-ellipsis whitespace-nowrap">
          {pdf.dims
            ? `${pdf.lines.length} lines · ${pdf.curves.length} curves · ${pdf.snapPoints.length} snap pts`
            : pdf.errorMessage ?? ''}
        </span>
        <div className="w-px h-[18px] bg-[#222] flex-shrink-0" />
        <button onClick={() => setZoom((z) => Math.max(0.05, z * 0.85))} style={tbBtn(false)}>−</button>
        <span className="text-[8px] text-[#555] min-w-[38px] text-center">{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom((z) => Math.min(20, z * 1.15))} style={tbBtn(false)}>+</button>
        <button onClick={fitCanvas} style={tbBtn(false)}>⊡</button>
      </div>

      {/* ── Main area ── */}
      <div className="flex flex-1 overflow-hidden min-h-0">

        {/* ── Viewport ── */}
        <div
          ref={viewportRef}
          className="flex-1 relative overflow-hidden select-none"
          style={{
            cursor,
            background: '#F8F7F3',
            backgroundImage: 'radial-gradient(circle, #D0CEC8 1px, transparent 1px)',
            backgroundSize: '20px 20px',
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerLeave}
          onContextMenu={(e) => e.preventDefault()}
        >
          {isIdle    && <IdleScreen errorMessage={pdf.errorMessage} />}
          {isLoading && <LoadingOverlay stage={pdf.stage} fileName={pdf.fileName} />}

          {/* PDF base render */}
          <div ref={wrapRef} className="absolute top-0 left-0 origin-top-left will-change-transform">
            <canvas ref={baseCanvasRef} style={{ display: 'block' }} />
          </div>

          {/* Pin / geometry overlay canvas — full viewport, pointer-events none */}
          <canvas
            ref={pinCanvasRef}
            className="absolute top-0 left-0 pointer-events-none w-full h-full"
          />

          {/* Flash rings */}
          <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 40 }}>
            <SnapFlashes flashes={flashes} />
          </div>

          {/* File name badge */}
          {!isIdle && !isLoading && pdf.fileName && (
            <div className="absolute bottom-[10px] left-[10px] bg-[rgba(255,255,255,.92)] border border-[#ccc] px-[8px] py-[3px] text-[9px] text-[#666] uppercase tracking-[.08em] pointer-events-none">
              {pdf.fileName}
              {pdf.pageInfo && pdf.pageInfo.pageCount > 1
                ? ` · pg ${pdf.pageInfo.pageNumber}/${pdf.pageInfo.pageCount}`
                : ''}
            </div>
          )}

          {/* Mode indicator */}
          {linearMode && pdf.dims && (
            <div className="absolute top-[10px] left-[10px] bg-[rgba(167,139,250,.15)] border border-[rgba(167,139,250,.4)] px-[8px] py-[3px] text-[8px] text-[#a78bfa] uppercase tracking-[.1em] pointer-events-none">
              Linear mode — click to chain
            </div>
          )}

          {/* Hover hint when geometry is off */}
          {pdf.dims && !showGeometry && (
            <div className="absolute top-[10px] right-[10px] bg-[rgba(56,189,248,.08)] border border-[rgba(56,189,248,.2)] px-[8px] py-[3px] text-[8px] text-[#38bdf8] uppercase tracking-[.1em] pointer-events-none">
              Enable Geometry to hover lines &amp; arcs
            </div>
          )}
        </div>

        {/* ── Sidebar ── */}
        <SnapSidebar
          engine={engine}
          snapPoints={pdf.snapPoints}
          lineCount={pdf.lines.length}
          curveCount={pdf.curves.length}
          dims={pdf.dims}
          tab={tab}
          setTab={setTab}
          onJumpChain={jumpToChainPoint}
          onRemoveChain={removeChainPoint}
          onJumpSelection={jumpToSelection}
        />
      </div>

      {/* ── Status bar ── */}
      <div className="h-[24px] bg-[#0a0a0a] border-t border-[#1a1a1a] flex items-center px-[10px] gap-[12px] flex-shrink-0">
        {[
          'Hover: highlight line / arc / snap',
          linearMode ? 'Click: add chain point' : 'Click: snap indicator',
          'Click: select entity',
          'Esc: deselect · Ctrl+Z: undo',
          'Ctrl+scroll: zoom',
          'Drag: pan',
        ].map((h, i) => (
          <React.Fragment key={h}>
            {i > 0 && <div className="w-px h-[12px] bg-[#1e1e1e]" />}
            <span className="text-[8px] text-[#2e2e2e] uppercase tracking-[.07em]">{h}</span>
          </React.Fragment>
        ))}
        <div className="flex-1" />
        <span className="text-[8px] text-[#2e2e2e] uppercase tracking-[.07em]">{pdf.fileName}</span>
      </div>
    </div>
  );
}
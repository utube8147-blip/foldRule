// hooks/magicFill/useSvgFill.ts
'use client';

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  COLORS, SVG_SCALE, FILL_GROW,
  Fill, LoadStage, SelectRect, SvgShape, SvgOverlayFill,
  yieldFrame, yieldMacro,
  hexToRgb, fmtArea, fmtPerim,
  dilateMaskFast, multiSeedFill, paintFill, closeHoles,
  maskArea, buildPolygonFromMask, polygonPerim,
  findRegionsInRect,
  buildMaskAsync,
  extractSvgShapes, pointInPath2D,
} from './fillCore';
import { measureSvgPathVector } from './parseSvgPath';
import {
  PlanarGraph,
  buildPlanarGraph,
  hitTestPlanarFace,
  svgCacheKey,
  loadCachedGraph,
  saveCachedGraph,
} from './planarGraph';

export type { Fill, LoadStage, SelectRect, SvgShape, SvgOverlayFill };
export { fmtArea, fmtPerim, hexToRgb, COLORS };

// ── Polygon utilities (minimal set still needed for vector fill) ──────────────

function polygonToPathD(poly: [number, number][]): string {
  return (
    poly
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(2)},${p[1].toFixed(2)}`)
      .join(' ') + ' Z'
  );
}

function polygonShoelaceArea(poly: [number, number][]): number {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    area += poly[i][0] * poly[j][1] - poly[j][0] * poly[i][1];
  }
  return Math.abs(area) / 2;
}

function polygonPerimFromPts(poly: [number, number][]): number {
  let p = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    p += Math.hypot(poly[j][0] - poly[i][0], poly[j][1] - poly[i][1]);
  }
  return Math.round(p);
}

// ── useSvgFill hook ───────────────────────────────────────────────────────────

export function useSvgFill() {
  // ── Color cycling ──────────────────────────────────────────────────────────
  const [activeColorIdx, setActiveColorIdx] = useState(0);
  const activeColor = COLORS[activeColorIdx];
  const setActiveColor = useCallback((c: string) => {
    const idx = COLORS.indexOf(c);
    if (idx >= 0) setActiveColorIdx(idx);
  }, []);
  const cycleColor = useCallback(() => setActiveColorIdx(p => (p + 1) % COLORS.length), []);

  // ── UI state ───────────────────────────────────────────────────────────────
  const [fillOpacity,   setFillOpacity]   = useState(40);
  const [zoom,          setZoom]          = useState(1);
  const [pan,           setPan]           = useState({ x: 0, y: 0 });
  const [mode,          setMode]          = useState<'fill' | 'pan'>('fill');
  const [isDragging,    setIsDragging]    = useState(false);
  const [isFilling,     setIsFilling]     = useState(false);
  const [fillMsg,       setFillMsg]       = useState('');
  const [fillSub,       setFillSub]       = useState<string | undefined>(undefined);
  const [fillProgress,  setFillProgress]  = useState<{ done: number; total: number } | null>(null);
  const [fills,         setFills]         = useState<Fill[]>([]);
  const [hiddenIds,     setHiddenIds]     = useState<Set<number>>(new Set());
  const [selectedId,    setSelectedId]    = useState<number | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<number | null>(null);
  const [hoveredId,     setHoveredId]     = useState<number | null>(null);
  const [hoverPos,      setHoverPos]      = useState({ x: 0, y: 0 });
  const [holesClosedIds,setHolesClosedIds]= useState<Set<number>>(new Set());
  const [showPolygon,   setShowPolygon]   = useState(true);
  const [status,        setStatus]        = useState('');
  const [fileName,      setFileName]      = useState('');
  const [loadStage,     setLoadStage]     = useState<LoadStage>('idle');
  const [loadProgress,  setLoadProgress]  = useState('');
  const [pxPerM,        setPxPerM]        = useState<number | null>(null);
  const [svgCanvasSize, setSvgCanvasSize] = useState({ w: 0, h: 0 });
  const [selectRect,    setSelectRect]    = useState<SelectRect | null>(null);
  const [isSelecting,   setIsSelecting]   = useState(false);
  const [spaceHeld,     setSpaceHeld]     = useState(false);
  const [batchMode,     setBatchMode]     = useState(false);

  // ── NEW: reactive flag so consumers re-render when graph is built ──────────
  const [graphReady,    setGraphReady]    = useState(false);

  // ── Refs ───────────────────────────────────────────────────────────────────
  const isRectSelecting = useRef(false);
  const rectStart       = useRef<{ cx: number; cy: number; sx: number; sy: number } | null>(null);
  const spaceHeldRef    = useRef(false);
  const batchModeRef    = useRef(false);
  const hasDraggedRef   = useRef(false);
  const lastClickTime   = useRef(0);
  const svgShapesRef    = useRef<SvgShape[]>([]);
  const planarGraphRef  = useRef<PlanarGraph | null>(null);
  const svgDocRef       = useRef<Document | null>(null);
  const viewportRef     = useRef<HTMLDivElement>(null);
  const wrapRef         = useRef<HTMLDivElement>(null);
  const baseCanvasRef   = useRef<HTMLCanvasElement>(null);
  const fillCanvasRef   = useRef<HTMLCanvasElement>(null);
  const polyCanvasRef   = useRef<HTMLCanvasElement>(null);
  const hitCanvasRef    = useRef<HTMLCanvasElement | null>(null);
  const maskRef         = useRef<Uint8Array | null>(null);
  const fillDataRef     = useRef<ImageData | null>(null);
  const basePixelsRef   = useRef<Uint8ClampedArray | null>(null);
  const dragRef         = useRef({ mx: 0, my: 0, px: 0, py: 0 });
  const fillCountRef    = useRef(0);
  const groupCountRef   = useRef(0);
  const fileInputRef    = useRef<HTMLInputElement>(null);
  const snapshots       = useRef<ImageData[]>([]);
  const fillPixelMaps   = useRef<Map<number, Uint8Array>>(new Map());
  const fillsRef        = useRef<Fill[]>([]);
  const panRef          = useRef(pan);
  const zoomRef         = useRef(zoom);
  const showPolygonRef  = useRef(showPolygon);

  useEffect(() => { fillsRef.current       = fills;       }, [fills]);
  useEffect(() => { panRef.current         = pan;         }, [pan]);
  useEffect(() => { zoomRef.current        = zoom;        }, [zoom]);
  useEffect(() => { batchModeRef.current   = batchMode;   }, [batchMode]);
  useEffect(() => { showPolygonRef.current = showPolygon; }, [showPolygon]);

  useEffect(() => {
    if (wrapRef.current)
      wrapRef.current.style.transform = `translate(${pan.x}px,${pan.y}px) scale(${zoom})`;
  }, [pan, zoom]);

  // ── Space key ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        spaceHeldRef.current = true;
        setSpaceHeld(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceHeldRef.current = false;
        setSpaceHeld(false);
        if (isRectSelecting.current && !batchModeRef.current) {
          isRectSelecting.current = false;
          rectStart.current = null;
          setIsSelecting(false);
          setSelectRect(null);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup',   onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup',   onKeyUp);
    };
  }, []);

  // ── Helpers ────────────────────────────────────────────────────────────────
  const centerCanvas = useCallback(() => {
    const vp = viewportRef.current, bc = baseCanvasRef.current;
    if (!vp || !bc) return;
    const vr = vp.getBoundingClientRect();
    const fz = Math.min((vr.width * 0.9) / bc.width, (vr.height * 0.9) / bc.height, 1);
    setZoom(fz);
    setPan({ x: (vr.width - bc.width * fz) / 2, y: (vr.height - bc.height * fz) / 2 });
  }, []);

  const ensureHitCanvas = useCallback((w: number, h: number) => {
    if (!hitCanvasRef.current) hitCanvasRef.current = document.createElement('canvas');
    hitCanvasRef.current.width  = w;
    hitCanvasRef.current.height = h;
  }, []);

  const screenToCanvas = useCallback((sx: number, sy: number) => {
    const vp = viewportRef.current!;
    const vr = vp.getBoundingClientRect();
    return {
      cx: Math.round((sx - vr.left - panRef.current.x) / zoomRef.current),
      cy: Math.round((sy - vr.top  - panRef.current.y) / zoomRef.current),
    };
  }, []);

  // ── Polygon redraw ─────────────────────────────────────────────────────────
  const redrawPolygons = useCallback((
    currentFills: Fill[],
    currentHidden: Set<number>,
    currentSelected: number | null,
    currentGroup: number | null,
  ) => {
    const pc = polyCanvasRef.current, bc = baseCanvasRef.current;
    if (!pc || !bc) return;
    if (pc.width !== bc.width || pc.height !== bc.height) {
      pc.width = bc.width;
      pc.height = bc.height;
    }
    const ctx = pc.getContext('2d')!;
    ctx.clearRect(0, 0, pc.width, pc.height);
    if (!showPolygonRef.current) return;

    currentFills.forEach(f => {
      if (currentHidden.has(f.id) || f.polygon.length < 3) return;
      if (!f.svgMode && f.polygon.length === 4) {
        const xs = f.polygon.map(p => p[0]), ys = f.polygon.map(p => p[1]);
        if (new Set(xs).size === 2 && new Set(ys).size === 2) return;
      }
      const pts = f.polygon;
      const [r, g, b] = hexToRgb(f.color);
      const isSelected = f.id === currentSelected;
      const isInGroup  = currentGroup != null && f.groupId === currentGroup;

      const drawPath = () => {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();
      };

      if (isSelected || isInGroup) {
        ctx.save(); drawPath();
        ctx.strokeStyle = isInGroup ? 'rgba(96,165,250,0.18)' : `rgba(${r},${g},${b},0.18)`;
        ctx.lineWidth = 8; ctx.setLineDash([]); ctx.stroke(); ctx.restore();
      }
      drawPath();
      ctx.strokeStyle = `rgba(${r},${g},${b},${isSelected || isInGroup ? 1 : 0.8})`;
      ctx.lineWidth   = isSelected ? 2.5 : isInGroup ? 2 : 1.6;
      ctx.setLineDash([]); ctx.stroke();

      const cornersToShow: [number, number][] = f.svgCornerIndices
        ? pts.filter((_, i) => f.svgCornerIndices!.has(i))
        : pts;

      const dotR = isSelected ? 6 : 5;
      const dotA = isSelected ? 1 : isInGroup ? 0.95 : 0.85;

      cornersToShow.forEach(([px, py]) => {
        ctx.beginPath();
        ctx.arc(px, py, dotR + 1.5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 2.5;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(px, py, dotR, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${r},${g},${b},${dotA})`;
        ctx.fill();

        ctx.strokeStyle = isSelected
          ? 'rgba(255,255,255,1)'
          : `rgba(${Math.min(r+80,255)},${Math.min(g+80,255)},${Math.min(b+80,255)},0.8)`;
        ctx.lineWidth = isSelected ? 2 : 1.5;
        ctx.stroke();
      });
    });
  }, []);

  useEffect(() => {
    redrawPolygons(fills, hiddenIds, selectedId, selectedGroup);
  }, [fills, selectedId, selectedGroup, hiddenIds, showPolygon, redrawPolygons]);

  // ── SVG load ───────────────────────────────────────────────────────────────
  const loadSvg = useCallback(async (file: File) => {
    setGraphReady(false);
    setLoadProgress('Reading SVG…'); await yieldMacro();
    const text   = await file.text();
    const parser = new DOMParser();
    const svgDoc = parser.parseFromString(text, 'image/svg+xml');
    const svgEl  = svgDoc.querySelector('svg');
    if (!svgEl) throw new Error('Invalid SVG');

    svgDocRef.current = svgDoc;

    const thickDoc = parser.parseFromString(text, 'image/svg+xml');
    const thickSvg = thickDoc.querySelector('svg')!;
    const sw = Math.max(2, Math.ceil(SVG_SCALE * 1.2));
    const st = thickDoc.createElementNS('http://www.w3.org/2000/svg', 'style');
    st.textContent = `line,polyline,polygon,rect,circle,ellipse,path{stroke:#000!important;stroke-width:${sw}px!important;stroke-opacity:1!important;paint-order:stroke fill;}`;
    thickSvg.insertBefore(st, thickSvg.firstChild);

    const blob = new Blob([new XMLSerializer().serializeToString(thickDoc)], { type: 'image/svg+xml' });
    const url  = URL.createObjectURL(blob);
    const img  = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = rej; img.src = url; });
    URL.revokeObjectURL(url);

    const vb = svgEl.viewBox?.baseVal;
    const W  = vb?.width  || img.width  || 800;
    const H  = vb?.height || img.height || 600;
    const cw = Math.round(W * SVG_SCALE), ch = Math.round(H * SVG_SCALE);

    const bc = baseCanvasRef.current!, fc = fillCanvasRef.current!;
    bc.width = cw; bc.height = ch;
    const ctx = bc.getContext('2d')!;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(img, 0, 0, cw, ch);

    await new Promise<void>(resolve => {
      buildMaskAsync(bc, fc, polyCanvasRef.current, setLoadProgress, (mask, fillData, basePixels) => {
        maskRef.current       = mask;
        fillDataRef.current   = fillData;
        basePixelsRef.current = basePixels;
        fillCountRef.current  = 0; groupCountRef.current = 0;
        snapshots.current     = []; fillPixelMaps.current.clear();
        setFills([]); setHiddenIds(new Set()); setSelectedId(null);
        setSelectedGroup(null); setHoveredId(null); setHolesClosedIds(new Set());
        ensureHitCanvas(cw, ch);
        resolve();
      });
    });

    // ── Build planar graph (cache-aware) ───────────────────────────────────
    setLoadProgress('Building planar graph…'); await yieldMacro();
    const cacheKey = svgCacheKey(text, SVG_SCALE);
    let graph = loadCachedGraph(cacheKey);
    if (graph) {
      setLoadProgress('Planar graph loaded from cache ✓'); await yieldMacro();
    } else {
      graph = buildPlanarGraph(svgDoc, SVG_SCALE);
      saveCachedGraph(cacheKey, graph);
    }
    planarGraphRef.current = graph;
    // Signal to consumers that the graph ref is now populated
    setGraphReady(true);

    // ── Extract vector shapes (kept for batch fill hit-testing) ────────────
    setLoadProgress('Extracting vector shapes…'); await yieldMacro();
    const { shapes } = extractSvgShapes(svgDoc, SVG_SCALE);
    svgShapesRef.current = shapes;

    setSvgCanvasSize({ w: cw, h: ch });
    const g = planarGraphRef.current;
    setStatus(
      `Loaded · ${g.nodes.length} nodes · ${g.edges.length} edges · ` +
      `${shapes.length} shapes · ${cw}×${ch}px`,
    );
  }, [ensureHitCanvas]);

  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    e.target.value = '';
    svgShapesRef.current = [];
    planarGraphRef.current = null;
    setGraphReady(false);
    setFileName(file.name); setLoadStage('loading'); setLoadProgress('Starting…');
    setZoom(1); setPan({ x: 0, y: 0 });
    try {
      await loadSvg(file);
      setLoadStage('ready');
      centerCanvas();
    } catch (err) {
      setLoadStage('idle');
      setStatus(`Error: ${(err as Error).message}`);
    }
  }, [loadSvg, centerCanvas]);

  // ── SVG planar-graph fill ──────────────────────────────────────────────────
  const doSvgFill = useCallback(async (canvasX: number, canvasY: number): Promise<boolean> => {
    const graph = planarGraphRef.current;
    if (!graph || graph.edges.length === 0) return false;

    const bc = baseCanvasRef.current!;

    setIsFilling(true);
    setFillMsg('Tracing planar face');
    setFillSub(undefined);
    setFillProgress(null);
    await yieldFrame();

    const facePoly = hitTestPlanarFace(graph, canvasX, canvasY, bc.width, bc.height);

    if (!facePoly) {
      setIsFilling(false);
      setFillMsg('');
      return false;
    }

    const areaPx  = polygonShoelaceArea(facePoly);
    const perimPx = polygonPerimFromPts(facePoly);

    if (areaPx < 50) {
      setIsFilling(false);
      setFillMsg('');
      setStatus('Region too small — try clicking near the room centre');
      return true;
    }

    const pathD        = polygonToPathD(facePoly);
    const cornerIndices = new Set<number>(facePoly.map((_, i) => i));

    fillCountRef.current += 1;
    const newFill: Fill = {
      id:      Date.now(),
      label:   `Fill ${fillCountRef.current}`,
      color:   activeColor,
      opacity: fillOpacity,
      areaPx,
      perimPx,
      polygon: facePoly,
      svgMode: true,
      svgPathD: pathD,
      svgBBox: {
        x: Math.min(...facePoly.map(p => p[0])),
        y: Math.min(...facePoly.map(p => p[1])),
        w: Math.max(...facePoly.map(p => p[0])) - Math.min(...facePoly.map(p => p[0])),
        h: Math.max(...facePoly.map(p => p[1])) - Math.min(...facePoly.map(p => p[1])),
      },
      svgCornerIndices: cornerIndices,
    };

    setFills(prev => {
      const next = [...prev, newFill];
      setTimeout(() => redrawPolygons(next, hiddenIds, newFill.id, null), 0);
      return next;
    });
    setSelectedId(newFill.id);
    setSelectedGroup(null);
    setIsFilling(false);
    setFillMsg('');
    setStatus(
      `Planar face fill · ${facePoly.length} vertices · ` +
      `area ${fmtArea(areaPx, pxPerM)} · perimeter ${fmtPerim(perimPx, pxPerM)}`,
    );
    cycleColor();
    return true;
  }, [activeColor, fillOpacity, pxPerM, hiddenIds, redrawPolygons, cycleColor]);

  // ── Raster fill ────────────────────────────────────────────────────────────
  const doRasterFill = useCallback(async (canvasX: number, canvasY: number) => {
    if (!maskRef.current || !fillDataRef.current || !basePixelsRef.current) return;
    const bc = baseCanvasRef.current!;
    snapshots.current.push(new ImageData(
      new Uint8ClampedArray(fillDataRef.current.data),
      fillDataRef.current.width,
      fillDataRef.current.height,
    ));

    setFillMsg('Flood filling region'); await yieldMacro();
    const filled = multiSeedFill(maskRef.current, bc.width, bc.height, canvasX, canvasY);
    if (!filled) {
      snapshots.current.pop();
      setIsFilling(false); setFillMsg('');
      setStatus('Clicked on a wall — try the room centre');
      return;
    }

    setFillMsg('Growing fill'); await yieldMacro();
    const grown = dilateMaskFast(filled, bc.width, bc.height, FILL_GROW);
    setFillMsg('Closing holes'); await yieldMacro();
    const closed = closeHoles(grown, bc.width, bc.height);
    setFillMsg('Painting'); await yieldMacro();

    const [r, g, b] = hexToRgb(activeColor);
    paintFill(closed, fillDataRef.current, r, g, b, fillOpacity / 100);
    fillCanvasRef.current!.getContext('2d')!.putImageData(fillDataRef.current, 0, 0);

    setFillMsg('Measuring'); await yieldMacro();
    const areaPx  = maskArea(closed);
    const polygon = buildPolygonFromMask(closed, bc.width, bc.height);
    const perimPx = polygonPerim(polygon);
    fillCountRef.current += 1;

    const newFill: Fill = {
      id: Date.now(), label: `Fill ${fillCountRef.current}`,
      color: activeColor, opacity: fillOpacity,
      areaPx, perimPx, polygon, svgMode: false,
    };
    fillPixelMaps.current.set(newFill.id, closed);
    setFills(prev => {
      const next = [...prev, newFill];
      setTimeout(() => redrawPolygons(next, hiddenIds, newFill.id, null), 0);
      return next;
    });
    setSelectedId(newFill.id); setSelectedGroup(null);
    setIsFilling(false); setFillMsg('');
    setStatus(`Raster fill · ${polygon.length} corners · area ${fmtArea(areaPx, pxPerM)} · perimeter ${fmtPerim(perimPx, pxPerM)}`);
    cycleColor();
  }, [activeColor, fillOpacity, pxPerM, hiddenIds, redrawPolygons, cycleColor]);

  // ── Unified click fill ─────────────────────────────────────────────────────
  const doFill = useCallback(async (clientX: number, clientY: number) => {
    if (mode !== 'fill' || isFilling || loadStage !== 'ready') return;
    if (spaceHeldRef.current) return;
    const vp = viewportRef.current!;
    const vr = vp.getBoundingClientRect();
    const cx = Math.round((clientX - vr.left - pan.x) / zoom);
    const cy = Math.round((clientY - vr.top  - pan.y) / zoom);
    const bc = baseCanvasRef.current!;
    if (cx < 0 || cx >= bc.width || cy < 0 || cy >= bc.height) return;
    setIsFilling(true); setFillMsg('Computing fill'); setFillSub(undefined);
    setFillProgress(null); setSelectedGroup(null);
    await yieldFrame();
    const handled = await doSvgFill(cx, cy);
    if (!handled) await doRasterFill(cx, cy);
  }, [mode, isFilling, loadStage, pan, zoom, doSvgFill, doRasterFill]);

  // ── Batch rect-select fill ─────────────────────────────────────────────────
  const commitRectSelect = useCallback(async (x1: number, y1: number, x2: number, y2: number) => {
    const rw = Math.abs(x2 - x1), rh = Math.abs(y2 - y1);
    if (rw < 5 || rh < 5) return;
    const bc = baseCanvasRef.current!;

    if (svgShapesRef.current.length > 0) {
      const rx1 = Math.min(x1, x2), ry1 = Math.min(y1, y2);
      const rx2 = Math.max(x1, x2), ry2 = Math.max(y1, y2);
      const hits = svgShapesRef.current.filter(s => {
        const cx = s.bbox.x + s.bbox.width  / 2;
        const cy = s.bbox.y + s.bbox.height / 2;
        return cx >= rx1 && cx <= rx2 && cy >= ry1 && cy <= ry2;
      });
      if (hits.length === 0) { setStatus('No vector shapes found in selection'); return; }

      setIsFilling(true); setFillMsg(`Filling ${hits.length} vector shapes`);
      setFillProgress({ done: 0, total: hits.length });
      // One initial yield so the progress UI paints before the sync work starts
      await yieldFrame();

      groupCountRef.current += 1;
      const gId = groupCountRef.current;
      const newFills: Fill[] = [];
      let batchColorIdx = COLORS.indexOf(activeColor);

      // ── Time-based yielding ──────────────────────────────────────────────
      // measureSvgPathVector is pure math (shoelace, no canvas rasterisation)
      // so each shape is fast. We only yield when a full frame (~16ms) has
      // elapsed, keeping the progress bar alive without adding unnecessary
      // forced waits between every few shapes.
      let lastYield = performance.now();

      for (let i = 0; i < hits.length; i++) {
        setFillProgress({ done: i, total: hits.length });

        const now = performance.now();
        if (now - lastYield > 32) {
          // Cap yields to ~30fps so the progress bar updates visibly
          await yieldFrame();
          lastYield = performance.now();
        }

        const shape = hits[i];
        if (shape.bbox.width < 6 || shape.bbox.height < 6) continue;

        const batchColor = COLORS[batchColorIdx % COLORS.length];
        const { areaPx, perimPx, polygon } = measureSvgPathVector(shape.pathD, bc.width, bc.height);

        if (areaPx > bc.width * bc.height * 0.80) continue;
        if (areaPx < 100) continue;

        fillCountRef.current += 1;
        newFills.push({
          id: Date.now() + Math.random(), label: `Fill ${fillCountRef.current}`,
          color: batchColor, opacity: fillOpacity,
          areaPx, perimPx, polygon,
          svgMode: true, svgPathD: shape.pathD,
          svgBBox: { x: shape.bbox.x, y: shape.bbox.y, w: shape.bbox.width, h: shape.bbox.height },
          groupId: gId,
        });
        batchColorIdx++;
      }

      setFillProgress({ done: hits.length, total: hits.length });
      setFills(prev => {
        const next = [...prev, ...newFills];
        setTimeout(() => redrawPolygons(next, hiddenIds, null, gId), 0);
        return next;
      });
      setSelectedId(null); setSelectedGroup(gId);
      setIsFilling(false); setFillMsg(''); setFillProgress(null);
      setActiveColorIdx(batchColorIdx % COLORS.length);
      setStatus(`Batch vector fill · ${newFills.length} shapes · total area ${fmtArea(newFills.reduce((s, f) => s + f.areaPx, 0), pxPerM)}`);
      return;
    }

    if (!maskRef.current || !fillDataRef.current || !basePixelsRef.current || isFilling) return;
    setIsFilling(true); setFillMsg('Detecting regions'); setFillSub('Scanning selection…'); setFillProgress(null);
    await yieldFrame();

    const regions = findRegionsInRect(
      maskRef.current, bc.width, bc.height,
      Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2),
    );
    if (regions.length === 0) {
      setIsFilling(false); setFillMsg('');
      setStatus('No fillable regions found in selection');
      return;
    }

    setFillSub(`Found ${regions.length} region${regions.length > 1 ? 's' : ''}`);
    setFillProgress({ done: 0, total: regions.length }); await yieldFrame();
    snapshots.current.push(new ImageData(new Uint8ClampedArray(fillDataRef.current.data), bc.width, bc.height));
    groupCountRef.current += 1;
    const gId = groupCountRef.current;
    const newFills: Fill[] = [];
    let batchColorIdx = COLORS.indexOf(activeColor);

    // ── Time-based yielding for raster batch ──────────────────────────────
    // Raster fills are heavier (dilateMask + closeHoles + buildPolygon) so
    // we yield more frequently, but still time-gated rather than every N steps.
    let lastYield = performance.now();

    for (let i = 0; i < regions.length; i++) {
      setFillMsg(`Filling region ${i + 1} / ${regions.length}`);
      setFillProgress({ done: i, total: regions.length });

      const now = performance.now();
      if (now - lastYield > 16) {
        await yieldFrame();
        lastYield = performance.now();
      }

      const { filled } = regions[i];
      const grown  = dilateMaskFast(filled, bc.width, bc.height, FILL_GROW);
      const closed = closeHoles(grown, bc.width, bc.height);
      const batchColor = COLORS[batchColorIdx % COLORS.length];
      const [r, g, b] = hexToRgb(batchColor);
      paintFill(closed, fillDataRef.current, r, g, b, fillOpacity / 100);
      const areaPx  = maskArea(closed);
      const polygon = buildPolygonFromMask(closed, bc.width, bc.height);
      const perimPx = polygonPerim(polygon);
      fillCountRef.current += 1;
      const nf: Fill = {
        id: Date.now() + Math.random(), label: `Fill ${fillCountRef.current}`,
        color: batchColor, opacity: fillOpacity,
        areaPx, perimPx, polygon, groupId: gId, svgMode: false,
      };
      fillPixelMaps.current.set(nf.id, closed);
      newFills.push(nf);
      batchColorIdx++;
      if (i % 5 === 0 || i === regions.length - 1)
        fillCanvasRef.current!.getContext('2d')!.putImageData(fillDataRef.current, 0, 0);
    }

    setFillProgress({ done: regions.length, total: regions.length });
    setFillMsg('Finalising'); await yieldFrame();
    fillCanvasRef.current!.getContext('2d')!.putImageData(fillDataRef.current, 0, 0);
    setFills(prev => {
      const next = [...prev, ...newFills];
      setTimeout(() => redrawPolygons(next, hiddenIds, null, gId), 0);
      return next;
    });
    setSelectedId(null); setSelectedGroup(gId);
    setIsFilling(false); setFillMsg(''); setFillProgress(null);
    setActiveColorIdx(batchColorIdx % COLORS.length);
    setStatus(`Batch filled ${newFills.length} regions · total area ${fmtArea(newFills.reduce((s, f) => s + f.areaPx, 0), pxPerM)}`);
  }, [isFilling, activeColor, fillOpacity, pxPerM, hiddenIds, redrawPolygons]);

  // ── Pointer handlers ───────────────────────────────────────────────────────
  const handleContextMenu = useCallback((e: React.MouseEvent) => e.preventDefault(), []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const vp = e.currentTarget as HTMLElement;
    if (e.button !== 0 && e.button !== 2) return;
    if (e.button === 0 && loadStage === 'ready') {
      const now = Date.now();
      if (now - lastClickTime.current < 300) {
        const next = !batchModeRef.current; batchModeRef.current = next; setBatchMode(next); return;
      }
      lastClickTime.current = now;
    }
    if (e.button === 2) {
      e.preventDefault(); hasDraggedRef.current = false; setIsDragging(true);
      dragRef.current = { mx: e.clientX, my: e.clientY, px: panRef.current.x, py: panRef.current.y };
      vp.setPointerCapture(e.pointerId); return;
    }
    if (e.button === 0 && (spaceHeldRef.current || batchModeRef.current) && loadStage === 'ready') {
      e.preventDefault(); setIsDragging(false);
      const { cx, cy } = screenToCanvas(e.clientX, e.clientY);
      rectStart.current = { cx, cy, sx: e.clientX, sy: e.clientY };
      isRectSelecting.current = true; setIsSelecting(true); setSelectRect(null);
      vp.setPointerCapture(e.pointerId); return;
    }
    if (e.button === 0) {
      hasDraggedRef.current = false; setIsDragging(true);
      dragRef.current = { mx: e.clientX, my: e.clientY, px: panRef.current.x, py: panRef.current.y };
      vp.setPointerCapture(e.pointerId);
    }
  }, [loadStage, screenToCanvas]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (isRectSelecting.current && rectStart.current) {
      const { cx: x1, cy: y1 } = rectStart.current;
      const { cx: x2, cy: y2 } = screenToCanvas(e.clientX, e.clientY);
      setSelectRect({ x1, y1, x2, y2, sx: 0, sy: 0, sw: 0, sh: 0 }); return;
    }
    if (isDragging) {
      const dx = e.clientX - dragRef.current.mx, dy = e.clientY - dragRef.current.my;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) hasDraggedRef.current = true;
      setPan({ x: dragRef.current.px + dx, y: dragRef.current.py + dy }); return;
    }
    if (loadStage === 'ready' && mode === 'fill') {
      const vp = viewportRef.current!, vr = vp.getBoundingClientRect();
      const px = Math.round((e.clientX - vr.left - panRef.current.x) / zoomRef.current);
      const py = Math.round((e.clientY - vr.top  - panRef.current.y) / zoomRef.current);
      const bc = baseCanvasRef.current!;
      if (px < 0 || px >= bc.width || py < 0 || py >= bc.height) { setHoveredId(null); return; }

      let found: number | null = null;
      const cf = fillsRef.current;
      const hc = hitCanvasRef.current;

      if (hc) {
        for (let i = cf.length - 1; i >= 0; i--) {
          const f = cf[i];
          if (!f.svgMode || !f.svgPathD) continue;
          if (pointInPath2D(f.svgPathD, px, py, hc)) { found = f.id; break; }
        }
      }
      if (found === null) {
        const idx = py * bc.width + px;
        for (let i = cf.length - 1; i >= 0; i--) {
          const map = fillPixelMaps.current.get(cf[i].id);
          if (map && map[idx]) { found = cf[i].id; break; }
        }
      }
      setHoveredId(found);
      setHoverPos({ x: e.clientX - vr.left, y: e.clientY - vr.top });
    }
  }, [isDragging, loadStage, mode, screenToCanvas]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (isDragging) {
      const wasDragging = hasDraggedRef.current;
      setIsDragging(false);
      if (e.button === 0 && !wasDragging && !spaceHeldRef.current && !batchModeRef.current && loadStage === 'ready')
        doFill(e.clientX, e.clientY);
      return;
    }
    if (isRectSelecting.current && rectStart.current) {
      const { cx: x1, cy: y1 } = rectStart.current;
      const { cx: x2, cy: y2 } = screenToCanvas(e.clientX, e.clientY);
      isRectSelecting.current = false; rectStart.current = null;
      setIsSelecting(false); setSelectRect(null);
      commitRectSelect(x1, y1, x2, y2);
    }
  }, [isDragging, loadStage, screenToCanvas, commitRectSelect, doFill]);

  // ── Wheel zoom ─────────────────────────────────────────────────────────────
  const wheelHandlerRef = useRef<(e: WheelEvent) => void>(() => {});
  useEffect(() => {
    wheelHandlerRef.current = (e: WheelEvent) => {
      e.preventDefault();
      const vp = viewportRef.current; if (!vp) return;
      const vr = vp.getBoundingClientRect();
      if (e.ctrlKey) {
        const mx = e.clientX - vr.left, my = e.clientY - vr.top;
        const f  = e.deltaY > 0 ? 0.92 : 1.08;
        setZoom(z => {
          const nz = Math.min(20, Math.max(0.05, z * f));
          setPan(p => ({ x: mx - (mx - p.x) * (nz / z), y: my - (my - p.y) * (nz / z) }));
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

  // ── Undo ───────────────────────────────────────────────────────────────────
  const handleUndo = useCallback(() => {
    setFills(f => {
      if (f.length === 0) return f;
      const last = f[f.length - 1];
      let next: Fill[];
      if (last.groupId != null) {
        const gid = last.groupId;
        f.filter(x => x.groupId === gid).forEach(x => fillPixelMaps.current.delete(x.id));
        next = f.filter(x => x.groupId !== gid);
      } else {
        fillPixelMaps.current.delete(last.id);
        next = f.slice(0, -1);
      }
      if (!last.svgMode && snapshots.current.length > 0 && fillDataRef.current) {
        const prev = snapshots.current.pop()!;
        fillDataRef.current.data.set(prev.data);
        fillCanvasRef.current!.getContext('2d')!.putImageData(fillDataRef.current, 0, 0);
      }
      const newSelected = next.length ? next[next.length - 1].id : null;
      setSelectedId(newSelected); setSelectedGroup(null);
      setTimeout(() => redrawPolygons(next, hiddenIds, newSelected, null), 0);
      return next;
    });
    setHoveredId(null); setStatus('Undo');
  }, [hiddenIds, redrawPolygons]);

  // ── Clear all ──────────────────────────────────────────────────────────────
  const handleClearAll = useCallback(() => {
    if (fillDataRef.current) {
      fillDataRef.current.data.fill(0);
      fillCanvasRef.current!.getContext('2d')!.clearRect(
        0, 0, fillCanvasRef.current!.width, fillCanvasRef.current!.height,
      );
    }
    const pc = polyCanvasRef.current;
    if (pc) pc.getContext('2d')!.clearRect(0, 0, pc.width, pc.height);
    snapshots.current = []; fillCountRef.current = 0; groupCountRef.current = 0;
    fillPixelMaps.current.clear();
    setFills([]); setHiddenIds(new Set()); setSelectedId(null); setSelectedGroup(null);
    setHoveredId(null); setHolesClosedIds(new Set()); setStatus('Cleared');
    setActiveColorIdx(0);
  }, []);

  // ── Fill holes ─────────────────────────────────────────────────────────────
  const closeFillHoles = useCallback(async (fId: number) => {
    const fill = fillsRef.current.find(f => f.id === fId);
    if (!fill || fill.svgMode || !fillDataRef.current || !basePixelsRef.current) return null;
    const pixMap = fillPixelMaps.current.get(fId);
    if (!pixMap) return null;
    const bc = baseCanvasRef.current!;
    const w = bc.width, h = bc.height;
    const closed = closeHoles(pixMap, w, h);
    const added  = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) if (closed[i] && !pixMap[i]) added[i] = 1;
    const [r, g, b] = hexToRgb(fill.color);
    paintFill(added, fillDataRef.current, r, g, b, fill.opacity / 100);
    const areaPx  = maskArea(closed);
    const polygon = buildPolygonFromMask(closed, w, h);
    const perimPx = polygonPerim(polygon);
    fillPixelMaps.current.set(fId, closed);
    return { areaPx, perimPx, polygon };
  }, []);

  const handleFillHoles = useCallback(async () => {
    if (!selectedId && selectedGroup == null) return;
    if (!fillDataRef.current || !basePixelsRef.current) return;
    const bc = baseCanvasRef.current!;
    setIsFilling(true); setFillMsg('Closing holes'); setFillSub(undefined); setFillProgress(null);
    await yieldFrame();
    snapshots.current.push(new ImageData(new Uint8ClampedArray(fillDataRef.current.data), bc.width, bc.height));

    const targetIds = selectedGroup != null
      ? fillsRef.current.filter(f => f.groupId === selectedGroup && !f.svgMode).map(f => f.id)
      : (selectedId != null ? [selectedId] : []).filter(
          id => !fillsRef.current.find(f => f.id === id)?.svgMode,
        );
    if (targetIds.length === 0) {
      snapshots.current.pop(); setIsFilling(false); setFillMsg(''); return;
    }
    if (targetIds.length > 1) setFillProgress({ done: 0, total: targetIds.length });

    const updates: Record<number, { areaPx: number; perimPx: number; polygon: [number, number][] }> = {};
    for (let i = 0; i < targetIds.length; i++) {
      if (targetIds.length > 1) { setFillProgress({ done: i, total: targetIds.length }); await yieldFrame(); }
      const res = await closeFillHoles(targetIds[i]);
      if (res) updates[targetIds[i]] = res;
    }

    fillCanvasRef.current!.getContext('2d')!.putImageData(fillDataRef.current, 0, 0);
    setFills(prev => {
      const next = prev.map(f => updates[f.id] ? { ...f, ...updates[f.id] } : f);
      setTimeout(() => redrawPolygons(next, hiddenIds, selectedId, selectedGroup), 0);
      return next;
    });
    setHolesClosedIds(prev => { const s = new Set(prev); targetIds.forEach(id => s.add(id)); return s; });
    setIsFilling(false); setFillMsg(''); setFillProgress(null);
    setStatus(targetIds.length > 1 ? `Holes closed on ${targetIds.length} regions` : 'Holes closed');
  }, [selectedId, selectedGroup, closeFillHoles, hiddenIds, redrawPolygons]);

  // ── Export PNG ─────────────────────────────────────────────────────────────
  const handleExport = useCallback(() => {
    const bc = baseCanvasRef.current, fc = fillCanvasRef.current, pc = polyCanvasRef.current;
    if (!bc || !fc) return;
    const out = document.createElement('canvas');
    out.width = bc.width; out.height = bc.height;
    const ctx = out.getContext('2d')!;
    ctx.drawImage(bc, 0, 0);

    const svgFills = fills.filter(f => f.svgMode && !hiddenIds.has(f.id));
    if (svgFills.length > 0) {
      const svgStr =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${bc.width}" height="${bc.height}" viewBox="0 0 ${bc.width} ${bc.height}">` +
        svgFills.map(f => {
          const [r, g, b] = hexToRgb(f.color);
          return `<path d="${f.svgPathD}" fill="rgba(${r},${g},${b},${f.opacity / 100})" stroke="rgba(${r},${g},${b},0.8)" stroke-width="1.6"/>`;
        }).join('') +
        '</svg>';
      const blob = new Blob([svgStr], { type: 'image/svg+xml' });
      const url  = URL.createObjectURL(blob);
      const img  = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0); URL.revokeObjectURL(url);
        if (fc) ctx.drawImage(fc, 0, 0);
        if (pc && showPolygon) ctx.drawImage(pc, 0, 0);
        out.toBlob(bl => {
          if (!bl) return;
          const u = URL.createObjectURL(bl);
          Object.assign(document.createElement('a'), {
            href: u, download: (fileName || 'floodfill') + '_filled.png',
          }).click();
          URL.revokeObjectURL(u);
        }, 'image/png');
      };
      img.src = url; return;
    }

    ctx.drawImage(fc, 0, 0);
    if (pc && showPolygon) ctx.drawImage(pc, 0, 0);
    out.toBlob(bl => {
      if (!bl) return;
      const u = URL.createObjectURL(bl);
      Object.assign(document.createElement('a'), {
        href: u, download: (fileName || 'floodfill') + '_filled.png',
      }).click();
      URL.revokeObjectURL(u);
    }, 'image/png');
  }, [fileName, showPolygon, fills, hiddenIds]);

  // ── Export SVG ─────────────────────────────────────────────────────────────
  const handleSvgExport = useCallback(() => {
    const svgFills = fills.filter(f => f.svgMode && !hiddenIds.has(f.id));
    if (svgFills.length === 0) return;
    const bc = baseCanvasRef.current!;
    const svgStr =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${bc.width}" height="${bc.height}" viewBox="0 0 ${bc.width} ${bc.height}">\n` +
      svgFills.map(f => {
        const [r, g, b] = hexToRgb(f.color);
        return `  <path d="${f.svgPathD}" fill="rgba(${r},${g},${b},${f.opacity / 100})" stroke="rgba(${r},${g},${b},0.85)" stroke-width="1.5" stroke-linejoin="round"/>`;
      }).join('\n') +
      '\n</svg>';
    const blob = new Blob([svgStr], { type: 'image/svg+xml' });
    const url  = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), {
      href: url, download: (fileName || 'floodfill') + '_fills.svg',
    }).click();
    URL.revokeObjectURL(url);
  }, [fills, hiddenIds, fileName]);

  // ── Delete / toggle hidden ─────────────────────────────────────────────────
  const handleDeleteFill = useCallback((fId: number) => {
    fillPixelMaps.current.delete(fId);
    setFills(prev => {
      const next = prev.filter(x => x.id !== fId);
      setTimeout(() => redrawPolygons(next, hiddenIds, selectedId, selectedGroup), 0);
      return next;
    });
    if (selectedId === fId) setSelectedId(null);
    if (hoveredId  === fId) setHoveredId(null);
  }, [hiddenIds, selectedId, selectedGroup, hoveredId, redrawPolygons]);

  const toggleHidden = useCallback((fId: number) => {
    setHiddenIds(prev => { const s = new Set(prev); s.has(fId) ? s.delete(fId) : s.add(fId); return s; });
  }, []);

  // ── Derived ────────────────────────────────────────────────────────────────
  const selectedFill  = fills.find(f => f.id === selectedId) ?? null;
  const hoveredFill   = fills.find(f => f.id === hoveredId)  ?? null;
  const groupFills    = selectedGroup != null ? fills.filter(f => f.groupId === selectedGroup) : [];
  const svgFillsList  = fills.filter(f => f.svgMode);
  const hasSelection  = selectedId != null || selectedGroup != null;
  const svgOverlayFills = useMemo(
    () =>
      fills
        .filter(f => f.svgMode && !!f.svgPathD)
        .map(f => ({
          id:      f.id,
          pathD:   f.svgPathD!,
          color:   f.color,
          opacity: f.opacity,
          selected: f.id === selectedId,
          inGroup:  selectedGroup != null && f.groupId === selectedGroup,
          hidden:   hiddenIds.has(f.id),
        })),
    [fills, selectedId, selectedGroup, hiddenIds],
  );
  const cursor = spaceHeld || batchMode ? 'crosshair'
    : isDragging  ? 'grabbing'
    : isFilling   ? 'wait'
    : 'crosshair';

  return {
    activeColor, setActiveColor, activeColorIdx,
    fillOpacity, setFillOpacity,
    zoom, setZoom, pan, setPan,
    mode, setMode,
    isDragging, isFilling,
    fillMsg, fillSub, fillProgress,
    fills, setFills,
    hiddenIds,
    selectedId, setSelectedId,
    selectedGroup, setSelectedGroup,
    hoveredId, setHoveredId, hoverPos,
    holesClosedIds, setHolesClosedIds,
    showPolygon, setShowPolygon,
    status, fileName, loadStage, loadProgress,
    pxPerM, setPxPerM,
    svgCanvasSize,
    selectRect, isSelecting, spaceHeld,
    batchMode, setBatchMode, batchModeRef,
    selectedFill, hoveredFill, groupFills,
    svgFillsList, svgOverlayFills, hasSelection, cursor,
    viewportRef, wrapRef, baseCanvasRef, fillCanvasRef, polyCanvasRef,
    fileInputRef, svgShapesRef, fillPixelMaps, fillDataRef,
    planarGraphRef, graphReady,
    handleUpload, handleUndo, handleClearAll, handleFillHoles,
    handleExport, handleSvgExport,
    handleDeleteFill, toggleHidden,
    handleContextMenu, handlePointerDown, handlePointerMove, handlePointerUp,
    centerCanvas, closeFillHoles, redrawPolygons, doFill,
  };
}
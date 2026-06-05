// hooks/fill/magicFill/usePdfFill.ts
'use client';
import { useState, useRef, useCallback, useEffect } from 'react';
import {
  COLORS, PDF_SCALE, FILL_GROW,
  Fill, LoadStage, SelectRect,
  yieldFrame, yieldMacro,
  hexToRgb, fmtArea, fmtPerim,
  dilateMaskFast, multiSeedFill, paintFill, closeHoles,
  maskArea, buildPolygonFromMask, polygonPerim,
  buildMaskAsync,
} from './fillCore';

export type { Fill, LoadStage, SelectRect };
export { fmtArea, fmtPerim, hexToRgb, COLORS };

// ── Inline worker source ──────────────────────────────────────────────────────
//
// Runs entirely off the main thread. Receives the wall mask + rect coords,
// finds all fillable regions inside the rect, unions them, dilates, closes
// holes, paints, and returns the result.
//
// findRegionsInRect (and all its dependencies) now live here — removing the
// main-thread block that previously caused the browser to freeze for ~200ms
// before the spinner even appeared.
//
// All large ArrayBuffers are TRANSFERRED (zero-copy), not copied.

const WORKER_SOURCE = /* js */`
// ── Morphology helpers ────────────────────────────────────────────────────────

function dilateMaskFast(src, w, h, r) {
  const horiz = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let count = 0;
    for (let x = 0; x < r && x < w; x++) if (src[y * w + x]) count++;
    for (let x = 0; x < w; x++) {
      const add = x + r; if (add < w && src[y * w + add]) count++;
      if (count > 0) horiz[y * w + x] = 1;
      const rem = x - r; if (rem >= 0 && src[y * w + rem]) count--;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y < r && y < h; y++) if (horiz[y * w + x]) count++;
    for (let y = 0; y < h; y++) {
      const add = y + r; if (add < h && horiz[add * w + x]) count++;
      if (count > 0) out[y * w + x] = 1;
      const rem = y - r; if (rem >= 0 && horiz[rem * w + x]) count--;
    }
  }
  return out;
}

function closeHoles(filled, w, h) {
  const outside = new Uint8Array(w * h);
  const stack = [];
  const push = (i) => {
    if (i >= 0 && i < w * h && !filled[i] && !outside[i]) {
      outside[i] = 1; stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 1; y < h - 1; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop();
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

function bboxPolygon(mask, w) {
  const h = (mask.length / w) | 0;
  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % w, y = (i / w) | 0;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]];
}

function maskArea(mask) {
  let c = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) c++;
  return c;
}

function polygonPerim(pts) {
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    p += Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
  }
  return Math.round(p);
}

function paintFill(mask, d, r, g, b, opacity) {
  const newA = opacity;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const di = i * 4;
    const existA = d[di + 3] / 255;
    const outA = newA + existA * (1 - newA);
    if (outA > 0) {
      d[di]   = ((r * newA + d[di]   * existA * (1 - newA)) / outA) | 0;
      d[di+1] = ((g * newA + d[di+1] * existA * (1 - newA)) / outA) | 0;
      d[di+2] = ((b * newA + d[di+2] * existA * (1 - newA)) / outA) | 0;
      d[di+3] = (outA * 255) | 0;
    }
  }
}

// ── Region finder (moved from main thread) ────────────────────────────────────

function scanlineFill(mask, w, h, sx, sy) {
  if (sx < 0 || sx >= w || sy < 0 || sy >= h || mask[sy * w + sx]) return null;
  const filled  = new Uint8Array(w * h);
  const visited = new Uint8Array(w * h);
  const stack   = new Int32Array(w * h);
  let top = 0;
  stack[top++] = sy * w + sx;
  visited[sy * w + sx] = 1;
  while (top > 0) {
    const idx = stack[--top];
    const cy  = (idx / w) | 0;
    const cx  = idx % w;
    let left = cx;
    while (left > 0 && !mask[cy * w + left - 1] && !visited[cy * w + left - 1]) left--;
    let right = cx;
    while (right < w - 1 && !mask[cy * w + right + 1] && !visited[cy * w + right + 1]) right++;
    for (let x = left; x <= right; x++) { filled[cy * w + x] = 1; visited[cy * w + x] = 1; }
    const up = (cy - 1) * w, dn = (cy + 1) * w;
    for (let x = left; x <= right; x++) {
      if (cy > 0   && !mask[up + x] && !visited[up + x]) { visited[up + x] = 1; stack[top++] = up + x; }
      if (cy < h-1 && !mask[dn + x] && !visited[dn + x]) { visited[dn + x] = 1; stack[top++] = dn + x; }
    }
  }
  let count = 0;
  for (let i = 0; i < filled.length; i++) if (filled[i]) count++;
  if (count / (w * h) > 0.80) return null;
  return count > 4 ? filled : null;
}

function multiSeedFill(mask, w, h, cx, cy) {
  const OFFSETS = [
    [0,0],[1,0],[-1,0],[0,1],[0,-1],
    [2,0],[-2,0],[0,2],[0,-2],
    [1,1],[-1,1],[1,-1],[-1,-1],
  ];
  let merged = null, mergedDilated = null;
  for (const [dx, dy] of OFFSETS) {
    const f = scanlineFill(mask, w, h, cx + dx, cy + dy);
    if (!f) continue;
    if (!merged) {
      merged = f;
      mergedDilated = dilateMaskFast(f, w, h, 5);
    } else {
      let overlaps = false;
      for (let i = 0; i < f.length; i++) {
        if (f[i] && mergedDilated[i]) { overlaps = true; break; }
      }
      if (overlaps) {
        for (let i = 0; i < merged.length; i++) if (f[i]) merged[i] = 1;
        mergedDilated = dilateMaskFast(merged, w, h, 5);
      }
    }
  }
  if (merged) {
    let c = 0;
    for (let i = 0; i < merged.length; i++) if (merged[i]) c++;
    if (c / (w * h) > 0.80) return null;
  }
  return merged;
}

function findRegionsInRect(mask, w, h, x1, y1, x2, y2) {
  const discovered = [];
  const seen = new Uint8Array(w * h);
  const step = Math.max(4, Math.round(Math.min(x2 - x1, y2 - y1) / 80));
  for (let sy = y1; sy <= y2; sy += step) {
    for (let sx = x1; sx <= x2; sx += step) {
      if (mask[sy * w + sx] || seen[sy * w + sx]) continue;
      const filled = multiSeedFill(mask, w, h, sx, sy);
      if (!filled) continue;
      let overlaps = false;
      for (let ty = y1; ty <= y2 && !overlaps; ty++)
        for (let tx = x1; tx <= x2 && !overlaps; tx++)
          if (filled[ty * w + tx]) overlaps = true;
      if (!overlaps) continue;
      for (let i = 0; i < filled.length; i++) if (filled[i]) seen[i] = 1;
      discovered.push(filled);
    }
  }
  return discovered;
}

// ── Message handler ───────────────────────────────────────────────────────────

self.onmessage = ({ data }) => {
  const { maskBuffer, fillDataBuffer, w, h, r, g, b, opacity, FILL_GROW, x1, y1, x2, y2 } = data;

  const mask = new Uint8Array(maskBuffer);

  // Step 1: find regions — was blocking the main thread before
  const regions = findRegionsInRect(mask, w, h, x1, y1, x2, y2);

  if (regions.length === 0) {
    self.postMessage({ empty: true });
    return;
  }

  // Step 2: union all region masks
  const unioned = new Uint8Array(w * h);
  for (const filled of regions) {
    for (let i = 0; i < filled.length; i++) if (filled[i]) unioned[i] = 1;
  }

  // Step 3: dilate to bridge furniture-to-wall gaps before closing holes
  const grown = dilateMaskFast(unioned, w, h, FILL_GROW);

  // Step 4: close holes — furniture interiors are now enclosed islands
  const closed = closeHoles(grown, w, h);

  // Leak guard
  const areaPx = maskArea(closed);
  if (areaPx / (w * h) > 0.80) {
    self.postMessage({ error: 'leak' });
    return;
  }

  // Step 5: paint single color onto fillData
  const fillDataArr = new Uint8ClampedArray(fillDataBuffer);
  paintFill(closed, fillDataArr, r, g, b, opacity);

  // Step 6: bbox polygon — fast O(n), no marching squares needed for batch
  const polygon = bboxPolygon(closed, w);
  const perimPx = polygonPerim(polygon);

  self.postMessage(
    {
      fillDataBuffer: fillDataArr.buffer,
      closedBuffer:   closed.buffer,
      polygon,
      areaPx,
      perimPx,
      regionCount:    regions.length,
    },
    [fillDataArr.buffer, closed.buffer],
  );
};
`;

// ── usePdfFill ────────────────────────────────────────────────────────────────

export function usePdfFill() {
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
  const [selectRect,    setSelectRect]    = useState<SelectRect | null>(null);
  const [isSelecting,   setIsSelecting]   = useState(false);
  const [spaceHeld,     setSpaceHeld]     = useState(false);
  const [batchMode,     setBatchMode]     = useState(false);

  // ── Refs ───────────────────────────────────────────────────────────────────
  const isRectSelecting = useRef(false);
  const rectStart       = useRef<{ cx: number; cy: number } | null>(null);
  const spaceHeldRef    = useRef(false);
  const batchModeRef    = useRef(false);
  const hasDraggedRef   = useRef(false);
  const lastClickTime   = useRef(0);
  const viewportRef     = useRef<HTMLDivElement>(null);
  const wrapRef         = useRef<HTMLDivElement>(null);
  const baseCanvasRef   = useRef<HTMLCanvasElement>(null);
  const fillCanvasRef   = useRef<HTMLCanvasElement>(null);
  const polyCanvasRef   = useRef<HTMLCanvasElement>(null);
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
  const workerRef       = useRef<Worker | null>(null);
  const workerUrlRef    = useRef<string | null>(null);

  useEffect(() => { fillsRef.current       = fills;       }, [fills]);
  useEffect(() => { panRef.current         = pan;         }, [pan]);
  useEffect(() => { zoomRef.current        = zoom;        }, [zoom]);
  useEffect(() => { batchModeRef.current   = batchMode;   }, [batchMode]);
  useEffect(() => { showPolygonRef.current = showPolygon; }, [showPolygon]);

  useEffect(() => {
    if (wrapRef.current)
      wrapRef.current.style.transform = `translate(${pan.x}px,${pan.y}px) scale(${zoom})`;
  }, [pan, zoom]);

  // Cleanup worker on unmount
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      if (workerUrlRef.current) URL.revokeObjectURL(workerUrlRef.current);
    };
  }, []);

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
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
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

  // ── PDF load ───────────────────────────────────────────────────────────────
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

    setLoadProgress('Parsing PDF…'); await yieldMacro();
    const ab   = await file.arrayBuffer();
    const doc  = await pdfjsLib.getDocument({ data: ab }).promise;
    const page = await doc.getPage(1);
    const vp   = page.getViewport({ scale: PDF_SCALE });
    const bc   = baseCanvasRef.current!, fc = fillCanvasRef.current!;
    bc.width = vp.width; bc.height = vp.height;
    const ctx = bc.getContext('2d')!;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, bc.width, bc.height);

    setLoadProgress('Rendering page…'); await yieldMacro();
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    await new Promise<void>(resolve => {
      buildMaskAsync(bc, fc, polyCanvasRef.current, setLoadProgress, (mask, fillData, basePixels) => {
        maskRef.current       = mask;
        fillDataRef.current   = fillData;
        basePixelsRef.current = basePixels;
        fillCountRef.current  = 0; groupCountRef.current = 0;
        snapshots.current     = []; fillPixelMaps.current.clear();
        setFills([]); setHiddenIds(new Set()); setSelectedId(null);
        setSelectedGroup(null); setHoveredId(null); setHolesClosedIds(new Set());
        resolve();
      });
    });

    setStatus(`Loaded · page 1/${doc.numPages} · ${bc.width}×${bc.height}px`);
  }, []);

  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    e.target.value = '';
    setFileName(file.name); setLoadStage('loading'); setLoadProgress('Starting…');
    setZoom(1); setPan({ x: 0, y: 0 });
    try {
      await loadPdf(file);
      setLoadStage('ready');
      centerCanvas();
    } catch (err) {
      setLoadStage('idle');
      setStatus(`Error: ${(err as Error).message}`);
    }
  }, [loadPdf, centerCanvas]);

  // ── Raster fill (single click) ─────────────────────────────────────────────
  const doRasterFill = useCallback(async (canvasX: number, canvasY: number) => {
    if (!maskRef.current || !fillDataRef.current || !basePixelsRef.current) return;
    const bc = baseCanvasRef.current!;
    snapshots.current.push(new ImageData(
      new Uint8ClampedArray(fillDataRef.current.data),
      fillDataRef.current.width, fillDataRef.current.height,
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
    await doRasterFill(cx, cy);
  }, [mode, isFilling, loadStage, pan, zoom, doRasterFill]);

  // ── Batch rect-select fill (fully off-thread) ──────────────────────────────
  //
  // The main thread now only:
  //   1. Takes a snapshot for undo
  //   2. Transfers mask + fillData buffers to the worker
  //   3. Shows the spinner immediately via yieldFrame()
  //
  // The worker handles everything:
  //   findRegionsInRect → union → dilate → closeHoles → paint
  //
  // This eliminates the ~200ms main-thread block that previously caused the
  // browser to freeze before the spinner appeared on large PDFs.

  const commitRectSelect = useCallback(async (x1: number, y1: number, x2: number, y2: number) => {
    const rw = Math.abs(x2 - x1), rh = Math.abs(y2 - y1);
    if (rw < 5 || rh < 5 || !maskRef.current || !fillDataRef.current || !basePixelsRef.current || isFilling) return;

    const bc = baseCanvasRef.current!;
    const w = bc.width, h = bc.height;

    setIsFilling(true);
    setFillMsg('Detecting regions');
    setFillSub('Running off main thread…');
    setFillProgress(null);

    // Snapshot for undo BEFORE handing off to worker
    snapshots.current.push(new ImageData(
      new Uint8ClampedArray(fillDataRef.current.data), w, h,
    ));

    // Yield immediately so the spinner renders before any work starts
    await yieldFrame();

    // Terminate any previous worker still running
    workerRef.current?.terminate();
    if (workerUrlRef.current) URL.revokeObjectURL(workerUrlRef.current);

    const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
    const url  = URL.createObjectURL(blob);
    workerUrlRef.current = url;
    const worker = new Worker(url);
    workerRef.current = worker;

    const [r, g, b] = hexToRgb(activeColor);

    // Transfer mask + fillData zero-copy. slice() gives a fresh transferable
    // ArrayBuffer so maskRef.current stays valid on the main thread.
    const maskCopy     = maskRef.current.slice().buffer;
    const fillDataCopy = fillDataRef.current.data.slice().buffer;

    worker.postMessage(
      {
        maskBuffer:     maskCopy,
        fillDataBuffer: fillDataCopy,
        w, h, r, g, b,
        opacity: fillOpacity / 100,
        FILL_GROW,
        x1: Math.min(x1, x2),
        y1: Math.min(y1, y2),
        x2: Math.max(x1, x2),
        y2: Math.max(y1, y2),
      },
      [maskCopy, fillDataCopy],
    );

    worker.onmessage = ({ data: result }) => {
      worker.terminate();
      workerRef.current = null;
      URL.revokeObjectURL(url);
      workerUrlRef.current = null;

      if (result.empty) {
        snapshots.current.pop();
        setIsFilling(false); setFillMsg(''); setFillSub(undefined); setFillProgress(null);
        setStatus('No fillable regions found in selection');
        return;
      }

      if (result.error === 'leak') {
        snapshots.current.pop();
        setIsFilling(false); setFillMsg(''); setFillSub(undefined); setFillProgress(null);
        setStatus('Fill leaked — try a smaller selection');
        return;
      }

      const { fillDataBuffer, closedBuffer, polygon, areaPx, perimPx, regionCount } = result;

      // Write painted pixels back
      const painted = new Uint8ClampedArray(fillDataBuffer);
      fillDataRef.current!.data.set(painted);
      fillCanvasRef.current!.getContext('2d')!.putImageData(fillDataRef.current!, 0, 0);

      const closed = new Uint8Array(closedBuffer);

      groupCountRef.current += 1;
      const gId = groupCountRef.current;
      fillCountRef.current  += 1;

      const newFill: Fill = {
        id:      Date.now(),
        label:   `Fill ${fillCountRef.current}`,
        color:   activeColor,
        opacity: fillOpacity,
        areaPx,
        perimPx,
        polygon: polygon as [number, number][],
        groupId: gId,
        svgMode: false,
      };

      fillPixelMaps.current.set(newFill.id, closed);

      setFills(prev => {
        const next = [...prev, newFill];
        setTimeout(() => redrawPolygons(next, hiddenIds, null, gId), 0);
        return next;
      });

      setSelectedId(null);
      setSelectedGroup(gId);
      setIsFilling(false);
      setFillMsg('');
      setFillSub(undefined);
      setFillProgress(null);
      cycleColor();
      setStatus(
        `Batch filled · ${regionCount} region${regionCount !== 1 ? 's' : ''} merged · ` +
        `area ${fmtArea(areaPx, pxPerM)} · perimeter ${fmtPerim(perimPx, pxPerM)}`,
      );
    };

    worker.onerror = (e) => {
      worker.terminate();
      workerRef.current = null;
      URL.revokeObjectURL(url);
      workerUrlRef.current = null;
      snapshots.current.pop();
      setIsFilling(false); setFillMsg(''); setFillSub(undefined); setFillProgress(null);
      setStatus(`Worker error: ${e.message}`);
    };

  }, [isFilling, activeColor, fillOpacity, pxPerM, hiddenIds, redrawPolygons, cycleColor]);

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
      rectStart.current = { cx, cy };
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
      const idx = py * bc.width + px;
      let found: number | null = null;
      const cf = fillsRef.current;
      for (let i = cf.length - 1; i >= 0; i--) {
        const map = fillPixelMaps.current.get(cf[i].id);
        if (map && map[idx]) { found = cf[i].id; break; }
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
    workerRef.current?.terminate();
    workerRef.current = null;
    if (workerUrlRef.current) { URL.revokeObjectURL(workerUrlRef.current); workerUrlRef.current = null; }
    setIsFilling(false); setFillMsg(''); setFillSub(undefined); setFillProgress(null);

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
    workerRef.current?.terminate();
    workerRef.current = null;
    if (workerUrlRef.current) { URL.revokeObjectURL(workerUrlRef.current); workerUrlRef.current = null; }
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
    setIsFilling(false); setFillMsg(''); setFillSub(undefined); setFillProgress(null);
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
  }, [fileName, showPolygon]);

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
  const selectedFill = fills.find(f => f.id === selectedId) ?? null;
  const hoveredFill  = fills.find(f => f.id === hoveredId)  ?? null;
  const groupFills   = selectedGroup != null ? fills.filter(f => f.groupId === selectedGroup) : [];
  const hasSelection = selectedId != null || selectedGroup != null;
  const cursor = spaceHeld || batchMode ? 'crosshair'
    : isDragging ? 'grabbing'
    : isFilling  ? 'wait'
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
    selectRect, isSelecting, spaceHeld,
    batchMode, setBatchMode, batchModeRef,
    selectedFill, hoveredFill, groupFills, hasSelection, cursor,
    viewportRef, wrapRef, baseCanvasRef, fillCanvasRef, polyCanvasRef,
    fileInputRef, fillPixelMaps, fillDataRef,
    handleUpload, handleUndo, handleClearAll, handleFillHoles,
    handleExport,
    handleDeleteFill, toggleHidden,
    handleContextMenu, handlePointerDown, handlePointerMove, handlePointerUp,
    centerCanvas, closeFillHoles, redrawPolygons, doFill,
  };
}
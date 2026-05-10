'use client';

import React, {
  useState, useRef, useEffect, useCallback, useMemo,
} from 'react';
import {
  ArrowLeft, Crosshair, Eye, EyeOff,
  ChevronLeft, ChevronRight, ZoomIn, ZoomOut,
  Upload, Activity, Ruler, Square, MousePointer,
  Minus, RotateCcw, Target, Maximize,
  Settings2, Check, X, Hash, MapPin, AlertTriangle,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useSnapEngine } from '@/hooks/useSnapEngine1';

function cn(...classes: (string | boolean | undefined | null)[]) {
  return classes.filter(Boolean).join(' ');
}

interface Point { x: number; y: number }
type ToolMode = 'pointer' | 'calibrate' | 'linear' | 'polygon' | 'rectangle' | 'count' | 'point';

interface CalibrationState {
  step: 'idle' | 'picking-end' | 'entering-value' | 'done';
  start: Point | null; end: Point | null;
  pixelDistance: number; realDistance: number; unit: string;
}

interface DrawnLine  { id: string; start: Point; end: Point; colorIndex: number; pageNum: number }
interface FilledArea { id: string; points: Point[]; area: number; colorIndex: number; pageNum: number }
interface CountPin   { id: string; point: Point; colorIndex: number; pageNum: number }

const WALL_PROXIMITY   = 140;
const CORNER_PROXIMITY = 80;
const HOVER_DIST       = 12;

const WARN_CORNERS = 1500;
const WARN_WALLS   = 400;

const ANALYSIS_TIMEOUT_MS = 60_000;

const PALETTE = [
  { stroke: '#f59e0b', fill: '#f59e0b28', label: '#fcd34d' },
  { stroke: '#3b82f6', fill: '#3b82f628', label: '#93c5fd' },
  { stroke: '#10b981', fill: '#10b98128', label: '#6ee7b7' },
  { stroke: '#ec4899', fill: '#ec489928', label: '#f9a8d4' },
  { stroke: '#8b5cf6', fill: '#8b5cf628', label: '#c4b5fd' },
  { stroke: '#f97316', fill: '#f9731628', label: '#fdba74' },
  { stroke: '#06b6d4', fill: '#06b6d428', label: '#67e8f9' },
  { stroke: '#84cc16', fill: '#84cc1628', label: '#bef264' },
];

function nextColor(items: { colorIndex: number }[]): number {
  if (items.length === 0) return 0;
  return (items[items.length - 1].colorIndex + 1) % PALETTE.length;
}
function uid() { return Math.random().toString(36).slice(2, 9); }
function ptDist(a: Point, b: Point) { return Math.hypot(a.x - b.x, a.y - b.y); }

function distToSeg(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y, lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return ptDist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return ptDist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

function polyArea(pts: Point[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(a) / 2;
}

function inPoly(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > p.y) !== (yj > p.y)) && p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function centroid(pts: Point[]): Point {
  return { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
}

function drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, offsetY = -14) {
  ctx.save();
  ctx.font = 'bold 10px ui-monospace,monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 10;
  ctx.fillStyle = 'rgba(0,0,0,0.82)';
  ctx.fillRect(x - w / 2, y + offsetY - 7, w, 14);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y + offsetY);
  ctx.restore();
}

function Brackets({ active = false }: { active?: boolean }) {
  const c = active ? 'border-amber-500' : 'border-zinc-800 group-hover:border-amber-500/40';
  return (
    <>
      <div className={cn('absolute top-0 left-0 w-3 h-3 border-t border-l transition-colors pointer-events-none', c)} />
      <div className={cn('absolute top-0 right-0 w-3 h-3 border-t border-r transition-colors pointer-events-none', c)} />
      <div className={cn('absolute bottom-0 left-0 w-3 h-3 border-b border-l transition-colors pointer-events-none', c)} />
      <div className={cn('absolute bottom-0 right-0 w-3 h-3 border-b border-r transition-colors pointer-events-none', c)} />
    </>
  );
}

function CalibrationModal({ pixelDist, onConfirm, onCancel }: {
  pixelDist: number; onConfirm: (real: number, unit: string) => void; onCancel: () => void;
}) {
  const [val, setVal] = useState(''); const [unit, setUnit] = useState('m');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="relative bg-[#161616] border border-amber-500/40 max-w-sm w-full mx-4 p-8 flex flex-col gap-5">
        <Brackets active />
        <span className="text-[10px] font-black uppercase tracking-widest text-amber-400">Set Real-World Distance</span>
        <p className="text-[9px] text-zinc-500 uppercase tracking-widest">
          Pixel span: <span className="text-amber-300 font-bold">{Math.round(pixelDist)} px</span>
        </p>
        <div className="flex gap-2">
          <input autoFocus type="number" min="0" step="any" placeholder="e.g. 5" value={val}
            onChange={e => setVal(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { const n = parseFloat(val); if (n > 0) onConfirm(n, unit); }
              if (e.key === 'Escape') onCancel();
            }}
            className="flex-1 bg-zinc-900 border border-zinc-700 text-zinc-200 text-sm font-mono px-3 py-2 focus:outline-none focus:border-amber-500" />
          <select value={unit} onChange={e => setUnit(e.target.value)}
            className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-sm font-mono px-3 py-2 focus:outline-none focus:border-amber-500">
            {['m', 'ft', 'cm', 'mm', 'in'].map(u => <option key={u}>{u}</option>)}
          </select>
        </div>
        <div className="flex gap-2">
          <button onClick={() => { const n = parseFloat(val); if (n > 0) onConfirm(n, unit); }}
            className="flex-1 bg-amber-500 hover:bg-amber-400 text-black text-[10px] font-black uppercase tracking-widest px-4 py-2">Confirm</button>
          <button onClick={onCancel}
            className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px] font-black uppercase tracking-widest px-4 py-2">Cancel</button>
        </div>
      </div>
    </div>
  );
}

const TOOLS: { id: ToolMode; label: string; icon: React.ElementType; shortcut: string; hint: string }[] = [
  { id: 'pointer',   label: 'Select',    icon: MousePointer, shortcut: 'V', hint: 'Pan & inspect' },
  { id: 'calibrate', label: 'Calibrate', icon: Ruler,        shortcut: 'C', hint: 'Click 2 pts → enter real dist' },
  { id: 'linear',    label: 'Linear',    icon: Minus,        shortcut: 'L', hint: 'Click start → click end' },
  { id: 'rectangle', label: 'Rectangle', icon: Square,       shortcut: 'R', hint: 'Click corner → opposite corner' },
  { id: 'polygon',   label: 'Polygon',   icon: Activity,     shortcut: 'P', hint: 'Click pts → right-click / close to finish' },
  { id: 'count',     label: 'Count',     icon: Hash,         shortcut: 'N', hint: 'Click to place count pins' },
  { id: 'point',     label: 'Point',     icon: MapPin,       shortcut: 'T', hint: 'Drop a labeled point' },
];

export default function SnapPage() {
  const router = useRouter();

  const [pdfDoc, setPdfDoc]               = useState<any>(null);
  const [loading, setLoading]             = useState(false);
  const [pageNumber, setPageNumber]       = useState(1);
  const [scale, setScale]                 = useState(1.2);
  const [pdfDimensions, setPdfDimensions] = useState<{ w: number; h: number } | null>(null);
  const [pdfjsReady, setPdfjsReady]       = useState(false);

  const [snapEnabled, setSnapEnabled]           = useState(true);
  const [showPins, setShowPins]                 = useState(true);
  const [snapThreshold, setSnapThreshold]       = useState(14);
  const [confidenceFilter, setConfidenceFilter] = useState(0.0);
  const [showSettings, setShowSettings]         = useState(false);

  const [detectionWarning, setDetectionWarning] = useState<string | null>(null);

  const [toolMode, setToolMode] = useState<ToolMode>('pointer');

  const [calib, setCalib] = useState<CalibrationState>({
    step: 'idle', start: null, end: null, pixelDistance: 0, realDistance: 1, unit: 'm',
  });

  const [drawnLines,  setDrawnLines]  = useState<DrawnLine[]>([]);
  const [filledAreas, setFilledAreas] = useState<FilledArea[]>([]);
  const [countPins,   setCountPins]   = useState<CountPin[]>([]);

  const currentPolyRef = useRef<Point[]>([]);
  const [currentPoly,  setCurrentPoly]  = useState<Point[]>([]);
  const [linearStart,  setLinearStart]  = useState<Point | null>(null);
  const [rectStart,    setRectStart]    = useState<Point | null>(null);

  const cursorRef = useRef<Point | null>(null);
  const [cursor, setCursorState] = useState<Point | null>(null);

  // ── Undo stack ────────────────────────────────────────────────────────────
  type UndoEntry =
    | { type: 'line';  payload: DrawnLine }
    | { type: 'area';  payload: FilledArea }
    | { type: 'pin';   payload: CountPin }
    | { type: 'rect';  lines: DrawnLine[]; area: FilledArea };
  const undoStack = useRef<UndoEntry[]>([]);
  const [canUndo, setCanUndo] = useState(false);

  const [engineStats, setEngineStats] = useState({ status: 'idle', corners: 0, walls: 0, timeMs: 0 });

  const startTimeRef     = useRef(0);
  const analysisTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pdfDimensionsRef = useRef(pdfDimensions);
  const pageNumberRef    = useRef(pageNumber);
  const renderTaskRef    = useRef<any>(null);

  const pdfCanvasRef     = useRef<HTMLCanvasElement>(null);
  const drawingCanvasRef = useRef<HTMLCanvasElement>(null);
  const pinCanvasRef     = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef     = useRef<HTMLDivElement>(null);

  useEffect(() => { pdfDimensionsRef.current = pdfDimensions; }, [pdfDimensions]);
  useEffect(() => { pageNumberRef.current    = pageNumber;    }, [pageNumber]);

  useEffect(() => {
    (async () => {
      const pdfjs = await import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc =
        `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.js`;
      setPdfjsReady(true);
    })();
  }, []);

  const snapEngine = useSnapEngine({
    pinCanvasRef:     pinCanvasRef     as React.RefObject<HTMLCanvasElement>,
    pdfDimensionsRef: pdfDimensionsRef as React.MutableRefObject<{ w: number; h: number } | null>,
    pageNumberRef:    pageNumberRef    as React.MutableRefObject<number>,
    snapEnabled, showPins, snapThreshold, confidenceFilter,
  });

  // ── Analysis status watcher ───────────────────────────────────────────────
  useEffect(() => {
    if (analysisTimerRef.current) {
      clearTimeout(analysisTimerRef.current);
      analysisTimerRef.current = null;
    }

    if (snapEngine.analysisStatus === 'analyzing') {
      analysisTimerRef.current = setTimeout(() => {
        console.warn('Analysis timed out — forcing loading clear');
        setLoading(false);
        setDetectionWarning(
          'Analysis timed out. The PDF may be too complex or large. ' +
          'Measurements still work — snap points may be limited.'
        );
        setEngineStats(prev => ({ ...prev, status: 'done' }));
      }, ANALYSIS_TIMEOUT_MS);
      return () => {
        if (analysisTimerRef.current) clearTimeout(analysisTimerRef.current);
      };
    }

    if (snapEngine.analysisStatus === 'done') {
      const pg = snapEngine.pageData.get(pageNumber - 1);

      if (pg && (pg.status === 'done' || pg.status === 'error')) {
        const corners   = pg.corners?.length    ?? 0;
        // wallLines is the new field from useSnapEngine
        const walls     = pg.wallLines?.length  ?? pg.walls?.length ?? 0;

        setEngineStats({
          status: 'done',
          corners,
          walls,
          timeMs: Math.round(performance.now() - startTimeRef.current),
        });
        setLoading(false);

        if (pg.status === 'error') {
          setDetectionWarning(
            'Analysis failed for this page. Measurements still work — snap points unavailable.'
          );
        } else if (corners >= WARN_CORNERS || walls >= WARN_WALLS) {
          setDetectionWarning(
            `High detection count (${corners} corners, ${walls} walls) — this PDF may not be a floor plan. Snap points may be unreliable.`
          );
        } else if (corners === 0) {
          setDetectionWarning('No snap points detected. Try a higher-resolution or cleaner floor plan PDF.');
        } else {
          setDetectionWarning(null);
        }
      } else if (!pg) {
        setLoading(false);
        setEngineStats(prev => ({ ...prev, status: 'done' }));
      }
    }
  }, [snapEngine.analysisStatus, snapEngine.pageData, pageNumber]);

  useEffect(() => {
    return () => {
      if (analysisTimerRef.current) clearTimeout(analysisTimerRef.current);
    };
  }, []);

  const pixelsPerUnit = useMemo(() =>
    calib.step === 'done' && calib.realDistance > 0 ? calib.pixelDistance / calib.realDistance : null,
  [calib]);

  const fmtLen = useCallback((px: number) => {
    if (!pixelsPerUnit) return `${Math.round(px)} px`;
    return `${(px / pixelsPerUnit).toFixed(2)} ${calib.unit}`;
  }, [pixelsPerUnit, calib.unit]);

  const fmtArea = useCallback((pxSq: number) => {
    if (!pixelsPerUnit) return `${Math.round(pxSq)} px²`;
    return `${(pxSq / pixelsPerUnit ** 2).toFixed(2)} ${calib.unit}²`;
  }, [pixelsPerUnit, calib.unit]);

  const getCanvasPoint = useCallback((e: React.PointerEvent<HTMLCanvasElement>): Point => {
    const rect = e.currentTarget.getBoundingClientRect();
    const c    = e.currentTarget;
    return {
      x: (e.clientX - rect.left) * ((c.width  || pdfDimensions?.w || 1) / rect.width),
      y: (e.clientY - rect.top)  * ((c.height || pdfDimensions?.h || 1) / rect.height),
    };
  }, [pdfDimensions]);

  const getSnapped = useCallback((raw: Point): Point => {
    if (!snapEnabled) return raw;
    return snapEngine.getSnapPoint(raw);
  }, [snapEngine, snapEnabled]);

  const pushUndo = useCallback((e: UndoEntry) => {
    undoStack.current.push(e); setCanUndo(true);
  }, []);

  const handleUndo = useCallback(() => {
    const entry = undoStack.current.pop();
    if (!entry) return;
    setCanUndo(undoStack.current.length > 0);
    if (entry.type === 'line') {
      setDrawnLines(prev => prev.filter(l => l.id !== entry.payload.id));
    } else if (entry.type === 'area') {
      setFilledAreas(prev => prev.filter(a => a.id !== entry.payload.id));
    } else if (entry.type === 'pin') {
      setCountPins(prev => prev.filter(p => p.id !== entry.payload.id));
    } else if (entry.type === 'rect') {
      const ids = new Set(entry.lines.map(l => l.id));
      setDrawnLines(prev => prev.filter(l => !ids.has(l.id)));
      setFilledAreas(prev => prev.filter(a => a.id !== entry.area.id));
    }
  }, []);

  const switchTool = useCallback((mode: ToolMode) => {
    setToolMode(mode); setLinearStart(null); setRectStart(null);
    currentPolyRef.current = []; setCurrentPoly([]);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (!e.ctrlKey && !e.metaKey) {
        const t = TOOLS.find(t => t.shortcut.toLowerCase() === e.key.toLowerCase());
        if (t) { switchTool(t.id); return; }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); handleUndo(); return; }
      if (e.key === 'Escape') {
        setLinearStart(null); setRectStart(null);
        currentPolyRef.current = []; setCurrentPoly([]);
        if (calib.step === 'picking-end') setCalib(c => ({ ...c, step: 'idle', start: null }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleUndo, calib.step, switchTool]);

  const handleFileUpload = useCallback(async (file: File) => {
    if (!pdfjsReady) return;
    setLoading(true);
    setDetectionWarning(null);
    setEngineStats({ status: 'idle', corners: 0, walls: 0, timeMs: 0 });
    startTimeRef.current = performance.now();
    try {
      const pdfjs = await import('pdfjs-dist');
      const ab    = await file.arrayBuffer();
      const pdf   = await pdfjs.getDocument({ data: ab }).promise;
      setPdfDoc(pdf);
      setPageNumber(1);
      const vp = (await pdf.getPage(1)).getViewport({ scale });
      setPdfDimensions({ w: vp.width, h: vp.height });
      snapEngine.startExtraction(pdf, file);
    } catch (err) {
      console.error(err);
      setLoading(false);
      setDetectionWarning('Failed to load PDF. Please try a different file.');
    }
  }, [pdfjsReady, scale, snapEngine]);

  const renderPdfPage = useCallback(async (pageNum: number, s: number) => {
    if (!pdfDoc || !pdfCanvasRef.current) return null;
    if (renderTaskRef.current) { try { renderTaskRef.current.cancel(); } catch (_) {} renderTaskRef.current = null; }
    try {
      const page = await pdfDoc.getPage(pageNum);
      const vp   = page.getViewport({ scale: s });
      const canvas = pdfCanvasRef.current, ctx = canvas.getContext('2d');
      if (!ctx) return null;
      canvas.width = vp.width; canvas.height = vp.height;
      canvas.style.width = `${vp.width}px`; canvas.style.height = `${vp.height}px`;
      ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      const task = page.render({ canvasContext: ctx, viewport: vp });
      renderTaskRef.current = task; await task.promise; renderTaskRef.current = null;
      return { w: vp.width, h: vp.height };
    } catch (err: any) { if (err?.name !== 'RenderingCancelledException') console.error(err); return null; }
  }, [pdfDoc]);

  useEffect(() => {
    if (!pdfDoc) return;
    renderPdfPage(pageNumber, scale).then(d => { if (d) setPdfDimensions(d); });
  }, [pdfDoc, pageNumber, scale, renderPdfPage]);

  useEffect(() => {
    if (!pdfDimensions) return;
    const { w, h } = pdfDimensions;
    [drawingCanvasRef, pinCanvasRef, overlayCanvasRef].forEach(ref => {
      if (!ref.current) return;
      ref.current.width = w; ref.current.height = h;
      ref.current.style.width  = `${w}px`;
      ref.current.style.height = `${h}px`;
      ref.current.getContext('2d')?.clearRect(0, 0, w, h);
    });
    snapEngine.redrawPinCanvas();
  }, [pdfDimensions, snapEngine]);

  const fitToScreen = useCallback(async () => {
    if (!pdfDoc || !containerRef.current) return;
    const page = await pdfDoc.getPage(pageNumber);
    const vp   = page.getViewport({ scale: 1 });
    const vw   = containerRef.current.clientWidth - 48, vh = containerRef.current.clientHeight - 48;
    setScale(Math.min(vw / vp.width, vh / vp.height) * 0.97);
  }, [pdfDoc, pageNumber]);

  useEffect(() => {
    const el = containerRef.current; if (!el) return;
    const h = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return; e.preventDefault();
      setScale(s => Math.min(3, Math.max(0.3, +(s + (e.deltaY > 0 ? -0.1 : 0.1)).toFixed(2))));
    };
    el.addEventListener('wheel', h, { passive: false });
    return () => el.removeEventListener('wheel', h);
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  //  OVERLAY DRAW
  // ─────────────────────────────────────────────────────────────────────────
  const redrawOverlay = useCallback(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas || !pdfDimensions) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const cur = cursorRef.current;

    const hoverSeg  = (a: Point, b: Point) => !!cur && distToSeg(cur, a, b) <= HOVER_DIST;
    const hoverPt   = (p: Point)           => !!cur && ptDist(cur, p)        <= HOVER_DIST + 4;
    const hoverPoly = (pts: Point[])       => !!cur && (inPoly(cur, pts) || pts.some(p => ptDist(cur, p) <= HOVER_DIST));

    const pg = snapEngine.pageData?.get(pageNumber - 1);
    if (pg?.status === 'done') {
      const dims = pdfDimensions;
      const scaleX = dims.w / (pg.width  || dims.w);
      const scaleY = dims.h / (pg.height || dims.h);

      // ─── Wall Lines (from new wallLines array) ─────────────────────────
      // wallLines has nx1/ny1/nx2/ny2 (normalised) — multiply by canvas dims
      // to get canvas-pixel coords, which are already zoom-proportional.
      const wallLines: any[] = pg.wallLines ?? [];

      wallLines.forEach((wall, idx) => {
        // nx1/ny1/nx2/ny2 are stored in [0,1] normalised space
        const x1 = wall.nx1 * dims.w;
        const y1 = wall.ny1 * dims.h;
        const x2 = wall.nx2 * dims.w;
        const y2 = wall.ny2 * dims.h;

        const midX = (x1 + x2) / 2;
        const midY = (y1 + y2) / 2;

        if (!cur || Math.hypot(cur.x - midX, cur.y - midY) > WALL_PROXIMITY * 3) return;

        const distFromCursor = distToSeg(cur, { x: x1, y: y1 }, { x: x2, y: y2 });
        const isHovered = distFromCursor < HOVER_DIST * 2;
        const proximity = Math.max(0, 1 - Math.hypot(cur.x - midX, cur.y - midY) / (WALL_PROXIMITY * 3));

        const alpha = isHovered ? 0.9 : 0.25 + proximity * 0.35;
        const lw    = isHovered ? 2.5 : 1.5;

        const pal = PALETTE[idx % PALETTE.length];

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = pal.stroke + Math.round(alpha * 255).toString(16).padStart(2, '0');
        ctx.lineWidth = lw;
        // Horizontal walls solid, vertical walls dashed to distinguish
        if (wall.angle === 90) {
          ctx.setLineDash([5, 3]);
        } else {
          ctx.setLineDash([]);
        }
        ctx.stroke();
        ctx.setLineDash([]);

        // Endpoint dots
        [{ x: x1, y: y1 }, { x: x2, y: y2 }].forEach(pt => {
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, isHovered ? 4 : 2.5, 0, Math.PI * 2);
          ctx.fillStyle = pal.stroke;
          ctx.fill();
        });

        // Hover label — show real-world length if calibrated
        if (isHovered) {
          const pxLen = Math.hypot(x2 - x1, y2 - y1);
          const label = fmtLen(pxLen);
          drawLabel(ctx, label, midX, midY, pal.label, -14);
        }
      });

      // ─── Wall Corners ──────────────────────────────────────────────────
      const wallCorners: any[] = pg.wallCorners ?? [];
      wallCorners.forEach((corner) => {
        const cx = corner.nx * dims.w;
        const cy = corner.ny * dims.h;
        if (!cur || ptDist(cur, { x: cx, y: cy }) > CORNER_PROXIMITY) return;

        const dist    = ptDist(cur, { x: cx, y: cy });
        const alpha   = Math.max(0, 1 - dist / CORNER_PROXIMITY);
        const isClose = dist < 20;
        const size    = isClose ? 8 : 5;

        ctx.save();
        ctx.strokeStyle = isClose
          ? `rgba(20,184,166,${alpha})`       // teal — wall corner
          : `rgba(20,184,166,${alpha * 0.7})`;
        ctx.lineWidth = isClose ? 2 : 1.2;
        ctx.beginPath(); ctx.moveTo(cx - size, cy); ctx.lineTo(cx + size, cy); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx, cy - size); ctx.lineTo(cx, cy + size); ctx.stroke();
        if (isClose) {
          ctx.strokeStyle = `rgba(20,184,166,${alpha * 0.5})`;
          ctx.beginPath(); ctx.arc(cx, cy, 12, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.restore();
      });

      // ─── Generic corner snap-point indicators near cursor ──────────────
      const corners = pg.corners ?? [];
      corners.forEach((corner: any) => {
        const cx = corner.nx * dims.w;
        const cy = corner.ny * dims.h;
        if (!cur || ptDist(cur, { x: cx, y: cy }) > CORNER_PROXIMITY) return;

        // Skip if a wall corner is already drawn here
        const nearWall = wallCorners.some((wc: any) =>
          Math.hypot(wc.nx * dims.w - cx, wc.ny * dims.h - cy) < 16
        );
        if (nearWall) return;

        const dist    = ptDist(cur, { x: cx, y: cy });
        const alpha   = Math.max(0, 1 - dist / CORNER_PROXIMITY);
        const isClose = dist < 20;
        const size    = isClose ? 7 : 4;

        ctx.save();
        ctx.strokeStyle = isClose
          ? `rgba(99,202,255,${alpha})`
          : `rgba(99,202,255,${alpha * 0.7})`;
        ctx.lineWidth = isClose ? 1.5 : 1;
        ctx.beginPath(); ctx.moveTo(cx - size, cy); ctx.lineTo(cx + size, cy); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx, cy - size); ctx.lineTo(cx, cy + size); ctx.stroke();
        if (isClose) {
          ctx.strokeStyle = `rgba(99,202,255,${alpha * 0.5})`;
          ctx.beginPath(); ctx.arc(cx, cy, 10, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.restore();
      });
    }

    // ── User-drawn filled areas ───────────────────────────────────────────
    filledAreas.filter(a => a.pageNum === pageNumber).forEach(area => {
      const pal = PALETTE[area.colorIndex % PALETTE.length];
      const isHovered = hoverPoly(area.points);

      ctx.beginPath();
      ctx.moveTo(area.points[0].x, area.points[0].y);
      area.points.forEach(p => ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.fillStyle   = isHovered ? pal.stroke + '33' : pal.fill;
      ctx.strokeStyle = isHovered ? pal.stroke : pal.stroke + 'bb';
      ctx.lineWidth   = isHovered ? 2 : 1.5;
      ctx.fill(); ctx.stroke();

      area.points.forEach(p => {
        ctx.beginPath(); ctx.arc(p.x, p.y, isHovered ? 4 : 2.5, 0, Math.PI * 2);
        ctx.fillStyle = pal.stroke; ctx.fill();
      });

      const c = centroid(area.points);
      // Always show label; on hover show calibrated value, otherwise px
      const areaLabel = fmtArea(area.area);
      drawLabel(ctx, areaLabel, c.x, c.y, pal.label, 0);

      // Extra perimeter label on hover
      if (isHovered) {
        const perim = area.points.reduce((s, p, i) => s + ptDist(p, area.points[(i + 1) % area.points.length]), 0);
        drawLabel(ctx, `P: ${fmtLen(perim)}`, c.x, c.y, pal.label, -16);
      }
    });

    // ── User-drawn lines ──────────────────────────────────────────────────
    drawnLines.filter(l => l.pageNum === pageNumber).forEach(line => {
      const pal = PALETTE[line.colorIndex % PALETTE.length];
      const isHovered = hoverSeg(line.start, line.end);

      ctx.beginPath(); ctx.moveTo(line.start.x, line.start.y); ctx.lineTo(line.end.x, line.end.y);
      ctx.strokeStyle = isHovered ? pal.stroke : pal.stroke + 'cc';
      ctx.lineWidth   = isHovered ? 2.5 : 1.5; ctx.stroke();

      [line.start, line.end].forEach(p => {
        ctx.beginPath(); ctx.arc(p.x, p.y, isHovered ? 4.5 : 3, 0, Math.PI * 2);
        ctx.fillStyle = pal.stroke; ctx.fill();
      });

      const mx = (line.start.x + line.end.x) / 2, my = (line.start.y + line.end.y) / 2;
      // Always show calibrated label — fmtLen handles both px and real-world
      drawLabel(ctx, fmtLen(ptDist(line.start, line.end)), mx, my, pal.label);
    });

    // ── Count / point pins ────────────────────────────────────────────────
    countPins.filter(p => p.pageNum === pageNumber).forEach((pin, idx) => {
      const pal = PALETTE[pin.colorIndex % PALETTE.length];
      const isHovered = hoverPt(pin.point);
      const r = isHovered ? 8 : 5;
      ctx.beginPath(); ctx.arc(pin.point.x, pin.point.y, r, 0, Math.PI * 2);
      ctx.fillStyle = pal.stroke + (isHovered ? 'ee' : '99'); ctx.fill();
      ctx.strokeStyle = pal.stroke; ctx.lineWidth = 1.5; ctx.stroke();
      drawLabel(ctx, `#${idx + 1}`, pin.point.x, pin.point.y, pal.label, -18);
    });

    // ── In-progress: polygon ──────────────────────────────────────────────
    if (currentPoly.length >= 1) {
      const pal = PALETTE[nextColor([...filledAreas]) % PALETTE.length];
      const livePts: Point[] = cur ? [...currentPoly, cur] : [...currentPoly];

      if (livePts.length >= 3) {
        ctx.beginPath();
        ctx.moveTo(livePts[0].x, livePts[0].y);
        livePts.forEach(p => ctx.lineTo(p.x, p.y));
        ctx.closePath();
        ctx.fillStyle = pal.fill; ctx.fill();

        ctx.beginPath();
        ctx.moveTo(livePts[0].x, livePts[0].y);
        livePts.forEach(p => ctx.lineTo(p.x, p.y));
        ctx.closePath();
        ctx.strokeStyle = pal.stroke + 'cc'; ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);

        const c = centroid(livePts);
        drawLabel(ctx, fmtArea(polyArea(livePts)), c.x, c.y, pal.label, 0);
      } else {
        ctx.beginPath(); ctx.moveTo(currentPoly[0].x, currentPoly[0].y);
        if (cur) ctx.lineTo(cur.x, cur.y);
        ctx.strokeStyle = pal.stroke + 'cc'; ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);
      }

      if (cur && currentPoly.length >= 1) {
        let total = 0;
        for (let i = 1; i < currentPoly.length; i++) total += ptDist(currentPoly[i - 1], currentPoly[i]);
        total += ptDist(currentPoly[currentPoly.length - 1], cur);
        drawLabel(ctx, fmtLen(total), cur.x + 8, cur.y - 24, pal.label, 0);
      }

      currentPoly.forEach((p, i) => {
        ctx.beginPath(); ctx.arc(p.x, p.y, i === 0 ? 6 : 3.5, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? pal.stroke : pal.stroke + 'bb'; ctx.fill();
        if (i === 0 && cur && ptDist(cur, p) < snapThreshold * 2) {
          ctx.beginPath(); ctx.arc(p.x, p.y, 11, 0, Math.PI * 2);
          ctx.strokeStyle = pal.stroke; ctx.lineWidth = 1.5; ctx.stroke();
        }
      });
    }

    // ── In-progress: linear ───────────────────────────────────────────────
    if (linearStart && cur) {
      const pal = PALETTE[nextColor(drawnLines) % PALETTE.length];
      ctx.beginPath(); ctx.moveTo(linearStart.x, linearStart.y); ctx.lineTo(cur.x, cur.y);
      ctx.strokeStyle = pal.stroke; ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(linearStart.x, linearStart.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = pal.stroke; ctx.fill();
      // Show calibrated length while drawing
      drawLabel(ctx, fmtLen(ptDist(linearStart, cur)),
        (linearStart.x + cur.x) / 2, (linearStart.y + cur.y) / 2, pal.label);
    }

    // ── In-progress: rectangle ────────────────────────────────────────────
    if (rectStart && cur) {
      const pal = PALETTE[nextColor([...drawnLines, ...filledAreas]) % PALETTE.length];
      const corners: Point[] = [rectStart, { x: cur.x, y: rectStart.y }, cur, { x: rectStart.x, y: cur.y }];
      ctx.beginPath();
      ctx.rect(Math.min(rectStart.x, cur.x), Math.min(rectStart.y, cur.y),
               Math.abs(cur.x - rectStart.x), Math.abs(cur.y - rectStart.y));
      ctx.strokeStyle = pal.stroke; ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = pal.fill; ctx.fill();
      // Width × Height labels on edges
      const w = Math.abs(cur.x - rectStart.x);
      const h = Math.abs(cur.y - rectStart.y);
      const cx = (rectStart.x + cur.x) / 2;
      const cy = (rectStart.y + cur.y) / 2;
      drawLabel(ctx, fmtArea(polyArea(corners)), cx, cy, pal.label, 0);
      drawLabel(ctx, `W: ${fmtLen(w)}`, cx, Math.min(rectStart.y, cur.y), pal.label, -14);
      drawLabel(ctx, `H: ${fmtLen(h)}`, Math.max(rectStart.x, cur.x), cy, pal.label, -14);
    }

    // ── Calibration preview ───────────────────────────────────────────────
    if (calib.step === 'picking-end' && calib.start && cur) {
      ctx.beginPath(); ctx.moveTo(calib.start.x, calib.start.y); ctx.lineTo(cur.x, cur.y);
      ctx.strokeStyle = '#34d399'; ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]);
      [calib.start, cur].forEach(p => {
        ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#34d399'; ctx.fill();
      });
      drawLabel(ctx, `${Math.round(ptDist(calib.start, cur))} px`,
        (calib.start.x + cur.x) / 2, (calib.start.y + cur.y) / 2, '#6ee7b7');
    }
    if (calib.step === 'done' && calib.start && calib.end) {
      ctx.beginPath(); ctx.moveTo(calib.start.x, calib.start.y); ctx.lineTo(calib.end.x, calib.end.y);
      ctx.strokeStyle = '#34d39955'; ctx.lineWidth = 1; ctx.stroke();
    }
  }, [
    filledAreas, drawnLines, countPins, currentPoly, calib,
    pixelsPerUnit, fmtLen, fmtArea, snapEngine.pageData, pageNumber,
    linearStart, rectStart, snapThreshold, pdfDimensions,
  ]);

  useEffect(() => { redrawOverlay(); }, [redrawOverlay, cursor]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pdfDimensions) return;
    const raw = getCanvasPoint(e);
    cursorRef.current = raw;
    snapEngine.cursorPointRef.current = raw;
    setCursorState({ ...raw });
    snapEngine.redrawPinCanvas();
  }, [pdfDimensions, getCanvasPoint, snapEngine]);

  const handlePointerLeave = useCallback(() => {
    cursorRef.current = null;
    snapEngine.cursorPointRef.current = null;
    setCursorState(null);
    snapEngine.redrawPinCanvas();
  }, [snapEngine]);

  const handleCanvasClick = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pdfDimensions) return;
    const raw = getCanvasPoint(e);
    const pt  = getSnapped(raw);

    if (toolMode === 'calibrate') {
      if (calib.step === 'idle' || calib.step === 'done') {
        setCalib(c => ({ ...c, step: 'picking-end', start: pt, end: null }));
      } else if (calib.step === 'picking-end' && calib.start) {
        setCalib(c => ({ ...c, step: 'entering-value', end: pt, pixelDistance: ptDist(calib.start!, pt) }));
      }
      return;
    }

    if (toolMode === 'linear') {
      if (!linearStart) { setLinearStart(pt); return; }
      const line: DrawnLine = { id: uid(), start: linearStart, end: pt, colorIndex: nextColor(drawnLines), pageNum: pageNumber };
      setDrawnLines(prev => [...prev, line]);
      pushUndo({ type: 'line', payload: line });
      setLinearStart(null); return;
    }

    if (toolMode === 'rectangle') {
      if (!rectStart) { setRectStart(pt); return; }
      const corners: Point[] = [rectStart, { x: pt.x, y: rectStart.y }, pt, { x: rectStart.x, y: pt.y }];
      const ci = nextColor([...drawnLines, ...filledAreas]);
      const edges: DrawnLine[] = corners.map((p, i) => ({
        id: uid(), start: p, end: corners[(i + 1) % 4], colorIndex: ci, pageNum: pageNumber,
      }));
      const area: FilledArea = { id: uid(), points: corners, area: polyArea(corners), colorIndex: ci, pageNum: pageNumber };
      setDrawnLines(prev => [...prev, ...edges]);
      setFilledAreas(prev => [...prev, area]);
      pushUndo({ type: 'rect', lines: edges, area });
      setRectStart(null); return;
    }

    if (toolMode === 'polygon') {
      const poly = currentPolyRef.current;
      if (poly.length === 0) {
        currentPolyRef.current = [pt]; setCurrentPoly([pt]); return;
      }
      if (poly.length >= 3 && ptDist(pt, poly[0]) < snapThreshold * 2) {
        const ci = nextColor(filledAreas);
        const area: FilledArea = { id: uid(), points: poly, area: polyArea(poly), colorIndex: ci, pageNum: pageNumber };
        setFilledAreas(prev => [...prev, area]);
        pushUndo({ type: 'area', payload: area });
        currentPolyRef.current = []; setCurrentPoly([]); return;
      }
      const np = [...poly, pt]; currentPolyRef.current = np; setCurrentPoly(np); return;
    }

    if (toolMode === 'count' || toolMode === 'point') {
      const pin: CountPin = { id: uid(), point: pt, colorIndex: nextColor(countPins), pageNum: pageNumber };
      setCountPins(prev => [...prev, pin]);
      pushUndo({ type: 'pin', payload: pin }); return;
    }
  }, [
    toolMode, calib, linearStart, rectStart, pdfDimensions,
    getCanvasPoint, getSnapped, snapThreshold,
    drawnLines, filledAreas, countPins, pushUndo, pageNumber,
  ]);

  const handleRightClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (toolMode === 'polygon' && currentPolyRef.current.length >= 3) {
      const poly = currentPolyRef.current;
      const ci   = nextColor(filledAreas);
      const area: FilledArea = { id: uid(), points: poly, area: polyArea(poly), colorIndex: ci, pageNum: pageNumber };
      setFilledAreas(prev => [...prev, area]);
      pushUndo({ type: 'area', payload: area });
      currentPolyRef.current = []; setCurrentPoly([]);
    }
    setLinearStart(null); setRectStart(null);
  }, [toolMode, filledAreas, pushUndo, pageNumber]);

  const pageLines = drawnLines.filter(l => l.pageNum === pageNumber);
  const pageAreas = filledAreas.filter(a => a.pageNum === pageNumber);
  const pagePins  = countPins.filter(p => p.pageNum === pageNumber);
  const totalLen  = pageLines.reduce((s, l) => s + ptDist(l.start, l.end), 0);
  const totalArea = pageAreas.reduce((s, a) => s + a.area, 0);

  const cursorStyle = toolMode === 'pointer' ? 'default' : 'crosshair';

  if (!pdfjsReady) return (
    <div className="h-screen flex items-center justify-center bg-[#0d0d0d] font-mono">
      <div className="flex flex-col items-center gap-4">
        <div className="w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-black">Initialising PDF engine…</p>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col h-screen bg-[#0d0d0d] overflow-hidden font-mono">

      {loading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
          <div className="relative bg-[#161616] border border-amber-500/40 max-w-sm w-full mx-4 p-8 flex flex-col items-center gap-5">
            <Brackets active />
            <div className="w-10 h-10 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-[10px] font-black uppercase tracking-widest text-amber-400">Analysing floor plan…</span>
            <span className="text-[9px] text-zinc-500">
              {snapEngine.analysisStatus === 'analyzing'
                ? `Page ${snapEngine.analysisPage?.current ?? '?'} / ${snapEngine.analysisPage?.total ?? '?'}`
                : snapEngine.analysisStatus}
            </span>
            <button
              onClick={() => { setLoading(false); setDetectionWarning('Analysis cancelled. Measurements still work without snap.'); }}
              className="text-[9px] text-zinc-600 hover:text-zinc-400 uppercase tracking-widest font-bold transition-colors mt-1">
              Cancel analysis
            </button>
          </div>
        </div>
      )}

      {calib.step === 'entering-value' && (
        <CalibrationModal
          pixelDist={calib.pixelDistance}
          onConfirm={(real, unit) => setCalib(c => ({ ...c, step: 'done', realDistance: real, unit }))}
          onCancel={() => setCalib(c => ({ ...c, step: 'idle', start: null, end: null }))}
        />
      )}

      {/* ─── Top toolbar ──────────────────────────────────────────────────── */}
      <div className="h-14 flex-shrink-0 bg-[#111] border-b border-zinc-800 flex items-center gap-2 px-3 z-40">
        <button onClick={() => router.back()} className="flex items-center gap-1.5 text-zinc-500 hover:text-zinc-200 transition-colors group mr-1">
          <ArrowLeft className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" />
          <span className="text-[10px] font-black uppercase tracking-widest hidden sm:inline">Back</span>
        </button>
        <div className="w-px h-5 bg-zinc-800 mr-1" />

        <div className="flex gap-px bg-zinc-900/60 border border-zinc-800 p-0.5">
          {TOOLS.map(t => (
            <button key={t.id} onClick={() => switchTool(t.id)}
              title={`${t.label} [${t.shortcut}] — ${t.hint}`}
              className={cn(
                'relative flex items-center gap-1.5 px-2.5 py-1.5 text-[9px] font-black uppercase tracking-wider transition-all',
                toolMode === t.id ? 'bg-amber-500 text-black' : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800',
              )}>
              <t.icon className="w-3 h-3" />
              <span className="hidden md:inline">{t.label}</span>
              <span className={cn('absolute -top-1 -right-0.5 text-[7px] font-black leading-none',
                toolMode === t.id ? 'text-black/50' : 'text-zinc-700')}>{t.shortcut}</span>
            </button>
          ))}
        </div>

        <div className="w-px h-5 bg-zinc-800" />
        <button onClick={handleUndo} disabled={!canUndo} title="Undo (Ctrl+Z)"
          className={cn('p-2 transition-colors', canUndo ? 'text-zinc-400 hover:text-amber-400' : 'text-zinc-700 cursor-not-allowed')}>
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
        <div className="w-px h-5 bg-zinc-800" />

        {pdfDoc && (
          <div className="flex items-center bg-zinc-900 border border-zinc-800">
            <button onClick={() => setPageNumber(p => Math.max(1, p - 1))} disabled={pageNumber <= 1}
              className="px-1.5 py-1.5 text-zinc-500 hover:text-amber-400 disabled:opacity-30 transition-colors">
              <ChevronLeft className="w-3 h-3" />
            </button>
            <span className="text-[10px] font-black tabular-nums px-2 text-zinc-400 select-none">{pageNumber}/{pdfDoc.numPages}</span>
            <button onClick={() => setPageNumber(p => Math.min(pdfDoc.numPages, p + 1))} disabled={pageNumber >= pdfDoc.numPages}
              className="px-1.5 py-1.5 text-zinc-500 hover:text-amber-400 disabled:opacity-30 transition-colors">
              <ChevronRight className="w-3 h-3" />
            </button>
          </div>
        )}

        <div className="flex items-center bg-zinc-900 border border-zinc-800">
          <button onClick={() => setScale(s => Math.max(0.3, +(s - 0.1).toFixed(2)))}
            className="px-1.5 py-1.5 text-zinc-500 hover:text-amber-400 transition-colors"><ZoomOut className="w-3 h-3" /></button>
          <span className="text-[10px] font-black tabular-nums px-2 text-zinc-400 w-11 text-center select-none">{Math.round(scale * 100)}%</span>
          <button onClick={() => setScale(s => Math.min(3, +(s + 0.1).toFixed(2)))}
            className="px-1.5 py-1.5 text-zinc-500 hover:text-amber-400 transition-colors"><ZoomIn className="w-3 h-3" /></button>
          <button onClick={fitToScreen}
            className="px-1.5 py-1.5 text-zinc-500 hover:text-amber-400 transition-colors border-l border-zinc-800"><Maximize className="w-3 h-3" /></button>
        </div>

        <div className="flex-1" />

        <button onClick={() => setSnapEnabled(v => !v)}
          className={cn('flex items-center gap-1.5 px-2.5 py-1.5 text-[9px] font-black uppercase tracking-widest border transition-all',
            snapEnabled ? 'border-green-700 text-green-400 bg-green-500/5' : 'border-zinc-800 text-zinc-600 hover:border-zinc-700')}>
          <Target className="w-3 h-3" />
          <span className="hidden sm:inline">Snap</span>
        </button>
        <button onClick={() => setShowSettings(v => !v)}
          className={cn('p-2 border transition-all',
            showSettings ? 'border-zinc-600 text-zinc-200 bg-zinc-800' : 'border-zinc-800 text-zinc-600 hover:border-zinc-700')}>
          <Settings2 className="w-3.5 h-3.5" />
        </button>

        {(drawnLines.length > 0 || filledAreas.length > 0 || countPins.length > 0) && (
          <button onClick={() => {
            setDrawnLines([]); setFilledAreas([]); setCountPins([]);
            setCurrentPoly([]); setLinearStart(null); setRectStart(null);
            currentPolyRef.current = []; undoStack.current = []; setCanUndo(false);
          }} className="flex items-center gap-1 px-2.5 py-1.5 text-[9px] font-black uppercase tracking-widest border border-red-900 text-red-400 hover:bg-red-500/10 transition-all">
            <X className="w-3 h-3" /><span className="hidden sm:inline">Clear</span>
          </button>
        )}

        <label className="flex items-center gap-1.5 bg-amber-500 hover:bg-amber-400 active:scale-95 text-black px-3 py-2 text-[10px] font-black uppercase tracking-widest cursor-pointer transition-all">
          <Upload className="w-3 h-3" />
          <span className="hidden sm:inline">Upload</span>
          <input type="file" accept=".pdf" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleFileUpload(f); e.target.value = ''; }} />
        </label>
      </div>

      {showSettings && (
        <div className="flex-shrink-0 bg-[#0f0f0f] border-b border-zinc-800/60 px-5 py-2.5 flex items-center gap-5 flex-wrap">
          <button onClick={() => setShowPins(v => !v)}
            className={cn('flex items-center gap-1.5 px-2.5 py-1 text-[9px] font-black uppercase tracking-widest border transition-all',
              showPins ? 'border-blue-700 text-blue-400 bg-blue-500/5' : 'border-zinc-800 text-zinc-600')}>
            {showPins ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />} Pins
          </button>
          <label className="flex items-center gap-2">
            <span className="text-[9px] font-bold text-zinc-600 uppercase tracking-widest">Snap px</span>
            <input type="range" min="5" max="30" value={snapThreshold} onChange={e => setSnapThreshold(+e.target.value)} className="w-20 accent-amber-500" />
            <span className="text-[9px] font-black text-amber-400 tabular-nums w-7">{snapThreshold}</span>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-[9px] font-bold text-zinc-600 uppercase tracking-widest">Confidence</span>
            <input type="range" min="0" max="0.5" step="0.01" value={confidenceFilter} onChange={e => setConfidenceFilter(+e.target.value)} className="w-20 accent-amber-500" />
            <span className="text-[9px] font-black text-amber-400 tabular-nums w-9">{confidenceFilter.toFixed(2)}</span>
          </label>
          <button
            onClick={() => { setSnapThreshold(14); setConfidenceFilter(0.0); setSnapEnabled(true); setShowPins(true); }}
            className="flex items-center gap-1 px-2.5 py-1 text-[9px] font-black uppercase tracking-widest border border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 transition-all">
            <RotateCcw className="w-2.5 h-2.5" /> Reset defaults
          </button>
        </div>
      )}

      {/* Detection quality warning banner */}
      {detectionWarning && (
        <div className="flex-shrink-0 bg-amber-950/60 border-b border-amber-800/60 px-4 py-2 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
          <span className="text-[9px] text-amber-300 font-bold flex-1">{detectionWarning}</span>
          <button onClick={() => setDetectionWarning(null)} className="text-amber-600 hover:text-amber-400 transition-colors">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* ─── Status bar ───────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 bg-[#0f0f0f] border-b border-zinc-800/50 px-3 py-1 flex items-center gap-2 flex-wrap min-h-[32px]">
        <div className="flex items-center gap-1.5">
          {(() => { const t = TOOLS.find(t => t.id === toolMode); return t ? <t.icon className="w-2.5 h-2.5 text-amber-400" /> : null; })()}
          <span className="text-[8px] text-zinc-600 uppercase tracking-widest font-bold">
            {TOOLS.find(t => t.id === toolMode)?.hint}
          </span>
        </div>
        {linearStart && (
          <span className="flex items-center gap-1 border border-amber-800 px-2 py-0.5 bg-amber-500/5 text-[8px] text-amber-400 font-black uppercase animate-pulse">
            <Minus className="w-2.5 h-2.5" /> Click end point
          </span>
        )}
        {rectStart && (
          <span className="flex items-center gap-1 border border-amber-800 px-2 py-0.5 bg-amber-500/5 text-[8px] text-amber-400 font-black uppercase animate-pulse">
            <Square className="w-2.5 h-2.5" /> Click opposite corner
          </span>
        )}
        {currentPoly.length > 0 && (
          <span className="flex items-center gap-1 border border-blue-800 px-2 py-0.5 bg-blue-500/5 text-[8px] text-blue-400 font-black uppercase">
            <Activity className="w-2.5 h-2.5" /> {currentPoly.length} pts · close or right-click
          </span>
        )}
        <div className="flex-1" />

        <div className="flex items-center gap-1.5 border border-zinc-800 px-2 py-0.5 bg-black/20">
          <Ruler className="w-2.5 h-2.5 text-green-400" />
          {calib.step === 'done' ? (
            <>
              <span className="text-[8px] font-black text-green-400 font-mono">{calib.pixelDistance.toFixed(0)} px = {calib.realDistance} {calib.unit}</span>
              <button onClick={() => setCalib({ step: 'idle', start: null, end: null, pixelDistance: 0, realDistance: 1, unit: calib.unit })}
                className="text-[8px] text-red-500 hover:text-red-400 ml-0.5">✕</button>
            </>
          ) : (
            <span className="text-[8px] text-zinc-600 font-mono">
              {calib.step === 'idle' ? 'Not calibrated' : calib.step === 'picking-end' ? 'Click 2nd point…' : '…'}
            </span>
          )}
        </div>

        {engineStats.status === 'done' && (
          <>
            <div className="flex items-center gap-1 border border-zinc-800 px-2 py-0.5 bg-black/20">
              <span className="text-[7px] text-zinc-600 uppercase font-bold">Corners</span>
              <span className={cn(
                'text-[9px] font-black font-mono',
                engineStats.corners >= WARN_CORNERS ? 'text-amber-400' : 'text-blue-400',
              )}>{engineStats.corners}</span>
            </div>
            <div className="flex items-center gap-1 border border-zinc-800 px-2 py-0.5 bg-black/20">
              <span className="text-[7px] text-zinc-600 uppercase font-bold">Walls</span>
              <span className={cn(
                'text-[9px] font-black font-mono',
                engineStats.walls >= WARN_WALLS ? 'text-amber-400' : 'text-purple-400',
              )}>{engineStats.walls}</span>
            </div>
          </>
        )}
        {pageLines.length > 0 && (
          <div className="flex items-center gap-1 border border-amber-900 px-2 py-0.5 bg-amber-500/5">
            <Minus className="w-2.5 h-2.5 text-amber-400" />
            <span className="text-[8px] font-black font-mono text-amber-400">{fmtLen(totalLen)}</span>
          </div>
        )}
        {pageAreas.length > 0 && (
          <div className="flex items-center gap-1 border border-blue-900 px-2 py-0.5 bg-blue-500/5">
            <Square className="w-2.5 h-2.5 text-blue-400" />
            <span className="text-[8px] font-black font-mono text-blue-400">{fmtArea(totalArea)}</span>
          </div>
        )}
        {pagePins.length > 0 && (
          <div className="flex items-center gap-1 border border-green-900 px-2 py-0.5 bg-green-500/5">
            <Hash className="w-2.5 h-2.5 text-green-400" />
            <span className="text-[8px] font-black font-mono text-green-400">×{pagePins.length}</span>
          </div>
        )}
      </div>

      {/* ─── Canvas viewport ──────────────────────────────────────────────── */}
      <div ref={containerRef} className="flex-1 overflow-auto bg-[#0d0d0d]"
        style={{ scrollbarWidth: 'thin', scrollbarColor: '#222 transparent' }}>
        <div className="relative mx-auto"
          style={pdfDimensions
            ? { width: `${pdfDimensions.w}px`, height: `${pdfDimensions.h}px`, margin: '24px auto' }
            : { minWidth: '100%', minHeight: '200px' }}>

          <canvas ref={pdfCanvasRef}
            style={{ position: 'absolute', top: 0, left: 0, zIndex: 0, display: 'block', backgroundColor: 'white' }} />
          <canvas ref={pinCanvasRef}
            style={{ position: 'absolute', top: 0, left: 0, zIndex: 10, pointerEvents: 'none' }} />
          <canvas ref={overlayCanvasRef}
            style={{ position: 'absolute', top: 0, left: 0, zIndex: 20, pointerEvents: 'none' }} />
          <canvas ref={drawingCanvasRef}
            style={{ position: 'absolute', top: 0, left: 0, zIndex: 30, cursor: cursorStyle, backgroundColor: 'transparent' }}
            onPointerMove={handlePointerMove}
            onPointerLeave={handlePointerLeave}
            onClick={handleCanvasClick}
            onContextMenu={handleRightClick}
          />

          {currentPoly.length >= 3 && cursor && (
            <button
              className="absolute z-40 flex items-center gap-1.5 bg-amber-400 hover:bg-amber-300 text-black font-black font-mono text-[9px] uppercase tracking-widest px-3 py-1.5 shadow-lg transition-all active:scale-95"
              style={{ left: currentPoly[currentPoly.length - 1].x + 18, top: currentPoly[currentPoly.length - 1].y + 18 }}
              onClick={e => { e.stopPropagation(); handleRightClick(e as any); }}>
              <Check className="w-3 h-3" /> Finish ({currentPoly.length} pts)
            </button>
          )}

          {engineStats.status === 'done' && engineStats.corners > 0 && (
            <div className="absolute bottom-3 right-3 bg-black/80 border border-zinc-800 px-2.5 py-1.5 z-40 pointer-events-none">
              <span className={cn('text-[9px] font-black font-mono', engineStats.corners >= WARN_CORNERS ? 'text-amber-400' : 'text-blue-400')}>
                {engineStats.corners}
              </span>
              <span className="text-[9px] text-zinc-600 ml-1 uppercase tracking-widest font-bold">snap pts</span>
              {engineStats.walls > 0 && (
                <>
                  <span className="text-zinc-700 mx-1">·</span>
                  <span className={cn('text-[9px] font-black font-mono', engineStats.walls >= WARN_WALLS ? 'text-amber-400' : 'text-purple-400')}>
                    {engineStats.walls}
                  </span>
                  <span className="text-[9px] text-zinc-600 ml-1 uppercase tracking-widest font-bold">walls</span>
                </>
              )}
            </div>
          )}

          {!pdfDoc && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-5">
              <div className="w-20 h-20 border border-zinc-800 flex items-center justify-center">
                <Crosshair className="w-8 h-8 text-zinc-700" />
              </div>
              <div className="text-center">
                <p className="text-[11px] text-zinc-500 uppercase tracking-widest font-black mb-1">Upload a floor plan PDF to begin</p>
                <p className="text-[9px] text-zinc-700 uppercase tracking-widest">Multi-page · Corner snap · Scale calibration</p>
              </div>
            </div>
          )}
        </div>
      </div>

      <footer className="h-6 flex-shrink-0 bg-[#0a0a0a] border-t border-zinc-800 flex items-center justify-between px-4">
        <div className="flex items-center gap-4">
          <span className="text-[8px] text-zinc-700 uppercase tracking-widest font-bold">Snap Engine v2 · Harris + Wall Lines</span>
          {pdfDoc && <><div className="w-px h-3 bg-zinc-800" /><span className="text-[8px] text-zinc-700 font-bold font-mono">{pdfDoc.numPages} pages · {Math.round(scale * 100)}%</span></>}
          {pixelsPerUnit && <><div className="w-px h-3 bg-zinc-800" /><span className="text-[8px] text-green-700 font-bold font-mono">1 {calib.unit} = {pixelsPerUnit.toFixed(1)} px</span></>}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[8px] text-zinc-700 uppercase tracking-widest hidden md:inline">
            {calib.step === 'done' ? `Calibrated · all measurements in ${calib.unit}` : 'Measurements in px until calibrated'}
          </span>
          <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
        </div>
      </footer>
    </div>
  );
}
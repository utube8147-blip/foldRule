import React, { useRef, useEffect, useState, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import {
  ZoomIn, ZoomOut, Maximize, ChevronLeft, ChevronRight,
  MousePointer2, CircleDot, Ruler, Square, Hash, FolderOpen,
  Check, Scaling, Target, Settings2,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { ToolType, Point, TakeoffRow, MeasurementType, Drawing } from '../types';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { SnapSettingsPanel } from './SnapSettingsPanel';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// ─── Corner Detection Types ───────────────────────────────────────────────────

interface DetectedCorner {
  x: number; y: number;
  confidence: number;
  nx: number; ny: number;
}

interface DetectedLine {
  x1: number; y1: number;
  x2: number; y2: number;
  angle: number; length: number;
}

interface ExtractionResult {
  pageIndex: number;
  corners: DetectedCorner[];
  lines: DetectedLine[];
  intersections: DetectedCorner[];
  width: number; height: number;
}

interface PageExtractionState {
  status: 'idle' | 'pending' | 'processing' | 'done' | 'error';
  step?: string;
  corners: DetectedCorner[];
  lines: DetectedLine[];
  intersections: DetectedCorner[];
  width: number; height: number;
}

interface SnapResult {
  point: { x: number; y: number };
  snapped: boolean;
}

// ─── Snap Candidate Dialog ────────────────────────────────────────────────────

interface SnapCandidateDialogProps {
  count: number;
  onAccept: () => void;
  onDismiss: () => void;
}

function SnapCandidateDialog({ count, onAccept, onDismiss }: SnapCandidateDialogProps) {
  return (
    <div className="absolute bottom-14 left-1/2 -translate-x-1/2 z-50 bg-zinc-900 border border-amber-400/60 shadow-xl shadow-amber-400/10 p-4 flex items-center gap-4 font-mono">
      <Target className="w-4 h-4 text-amber-400 flex-shrink-0" />
      <div>
        <div className="text-[11px] font-bold text-zinc-200">
          {count} point{count > 1 ? 's' : ''} can be snapped to nearby corners
        </div>
        <div className="text-[9px] text-zinc-500 uppercase tracking-wider mt-0.5">Auto-fix detected loose placements</div>
      </div>
      <div className="flex gap-2">
        <button
          onClick={onAccept}
          className="text-[10px] font-bold px-3 py-1.5 bg-amber-400 text-black uppercase tracking-widest hover:bg-amber-300 transition-all"
        >
          FIX
        </button>
        <button
          onClick={onDismiss}
          className="text-[10px] font-bold px-3 py-1.5 border border-zinc-700 text-zinc-400 uppercase tracking-widest hover:border-zinc-500 transition-all"
        >
          KEEP
        </button>
      </div>
    </div>
  );
}

// ─── Snap Flash Overlay ───────────────────────────────────────────────────────

interface SnapFlash {
  x: number; y: number; id: number;
}

// ─── Inline Worker Source ─────────────────────────────────────────────────────

function getWorkerSource(): string {
  return `
function gaussianBlur(data,w,h){const kernel=[2,4,5,4,2,4,9,12,9,4,5,12,15,12,5,4,9,12,9,4,2,4,5,4,2];const kSum=159;const out=new Float32Array(w*h);for(let y=2;y<h-2;y++){for(let x=2;x<w-2;x++){let v=0,ki=0;for(let ky=-2;ky<=2;ky++){for(let kx=-2;kx<=2;kx++){const idx=((y+ky)*w+(x+kx))*4;v+=(0.299*data[idx]+0.587*data[idx+1]+0.114*data[idx+2])*kernel[ki++];}}out[y*w+x]=v/kSum;}}return out;}

function sobelGradients(gray,w,h){const gx=new Float32Array(w*h);const gy=new Float32Array(w*h);for(let y=1;y<h-1;y++){for(let x=1;x<w-1;x++){const tl=gray[(y-1)*w+(x-1)],tc=gray[(y-1)*w+x],tr=gray[(y-1)*w+(x+1)];const ml=gray[y*w+(x-1)],mr=gray[y*w+(x+1)];const bl=gray[(y+1)*w+(x-1)],bc=gray[(y+1)*w+x],br=gray[(y+1)*w+(x+1)];gx[y*w+x]=-tl-2*ml-bl+tr+2*mr+br;gy[y*w+x]=-tl-2*tc-tr+bl+2*bc+br;}}return{gx,gy};}

function harrisResponse(gx,gy,w,h,k){k=k===undefined?0.05:k;const R=new Float32Array(w*h);const win=3;for(let y=win;y<h-win;y++){for(let x=win;x<w-win;x++){let Ixx=0,Iyy=0,Ixy=0;for(let wy=-win;wy<=win;wy++){for(let wx=-win;wx<=win;wx++){const i=(y+wy)*w+(x+wx);Ixx+=gx[i]*gx[i];Iyy+=gy[i]*gy[i];Ixy+=gx[i]*gy[i];}}const det=Ixx*Iyy-Ixy*Ixy;const trace=Ixx+Iyy;R[y*w+x]=det-k*trace*trace;}}return R;}

function nonMaxSuppression(R,w,h,win){win=win===undefined?10:win;let maxR=0;for(let i=0;i<R.length;i++)if(R[i]>maxR)maxR=R[i];const threshold=maxR*0.01;const corners=[];for(let y=win;y<h-win;y++){for(let x=win;x<w-win;x++){const r=R[y*w+x];if(r<threshold)continue;let isMax=true;outer:for(let wy=-win;wy<=win;wy++){for(let wx=-win;wx<=win;wx++){if(wy===0&&wx===0)continue;if(R[(y+wy)*w+(x+wx)]>=r){isMax=false;break outer;}}}if(isMax){corners.push({x,y,confidence:Math.min(1,r/(maxR*0.1)),nx:x/w,ny:y/h});}}}return corners;}

function detectLines(gx,gy,w,h){const mag=new Float32Array(w*h);let maxMag=0;for(let i=0;i<w*h;i++){mag[i]=Math.sqrt(gx[i]*gx[i]+gy[i]*gy[i]);if(mag[i]>maxMag)maxMag=mag[i];}const threshold=maxMag*0.15;const lines=[];for(let y=0;y<h;y+=4){let s=-1;for(let x=0;x<w;x++){if(mag[y*w+x]>threshold){if(s===-1)s=x;}else{if(s!==-1&&x-s>30)lines.push({x1:s,y1:y,x2:x-1,y2:y,angle:0,length:x-1-s});s=-1;}}}for(let x=0;x<w;x+=4){let s=-1;for(let y=0;y<h;y++){if(mag[y*w+x]>threshold){if(s===-1)s=y;}else{if(s!==-1&&y-s>30)lines.push({x1:x,y1:s,x2:x,y2:y-1,angle:90,length:y-1-s});s=-1;}}}return lines;}

function findIntersections(lines,imgW,imgH){const hLines=lines.filter(function(l){return l.angle===0;});const vLines=lines.filter(function(l){return l.angle===90;});const result=[];for(var hi=0;hi<hLines.length;hi++){var hl=hLines[hi];for(var vi=0;vi<vLines.length;vi++){var vl=vLines[vi];var ix=vl.x1,iy=hl.y1;if(ix>=Math.min(hl.x1,hl.x2)&&ix<=Math.max(hl.x1,hl.x2)&&iy>=Math.min(vl.y1,vl.y2)&&iy<=Math.max(vl.y1,vl.y2)){var tooClose=result.some(function(r){return Math.hypot(r.x-ix,r.y-iy)<20;});if(!tooClose)result.push({x:ix,y:iy,confidence:1.0,nx:ix/imgW,ny:iy/imgH});}}}return result;}

self.onmessage=function(e){var data=e.data;var imageData=data.imageData;var pageIndex=data.pageIndex;var width=data.width;var height=data.height;try{self.postMessage({type:'progress',pageIndex:pageIndex,step:'blurring'});var blurred=gaussianBlur(imageData.data,width,height);self.postMessage({type:'progress',pageIndex:pageIndex,step:'gradients'});var grads=sobelGradients(blurred,width,height);self.postMessage({type:'progress',pageIndex:pageIndex,step:'harris'});var R=harrisResponse(grads.gx,grads.gy,width,height);self.postMessage({type:'progress',pageIndex:pageIndex,step:'suppression'});var corners=nonMaxSuppression(R,width,height);self.postMessage({type:'progress',pageIndex:pageIndex,step:'lines'});var lines=detectLines(grads.gx,grads.gy,width,height);var intersections=findIntersections(lines,width,height);var mergedCorners=intersections.slice();for(var i=0;i<corners.length;i++){var c=corners[i];var nearInt=intersections.some(function(pt){return Math.hypot(pt.x-c.x,pt.y-c.y)<15;});if(!nearInt)mergedCorners.push(c);}self.postMessage({type:'result',result:{pageIndex:pageIndex,corners:mergedCorners.sort(function(a,b){return b.confidence-a.confidence;}).slice(0,2000),lines:lines,intersections:intersections,width:width,height:height}});}catch(err){self.postMessage({type:'error',pageIndex:pageIndex,error:String(err)});}};
`;
}

// ─── Session Cache ────────────────────────────────────────────────────────────

const sessionCache = new Map<string, Map<number, ExtractionResult>>();

function fileHash(file: File): string {
  return `${file.name}_${file.size}_${file.lastModified}`;
}

// ─── Viewer Props ─────────────────────────────────────────────────────────────

interface ViewerProps {
  activeTool: ToolType;
  setActiveTool: (tool: ToolType) => void;
  measurements: TakeoffRow[];
  onAddMeasurement: (m: Omit<TakeoffRow, 'id' | 'color' | 'isVisible' | 'drawingId'>) => void;
  onUpdateMeasurement?: (id: string, updates: Partial<TakeoffRow>) => void;
  scaleFactor: number;
  onScaleSet: (factor: number) => void;
  activeDrawing: Drawing | null;
  onDrawingAdded: (name: string, fileUrl: string, file?: File) => void;
}

// ─── Pending Snap Candidate ───────────────────────────────────────────────────

interface PendingSnapCandidate {
  pointIndex: number;
  measurementId: string;
  // stored in normalized [0,1] space, same as measurement points
  snapTarget: { x: number; y: number };
}

// ─── Main Viewer Component ────────────────────────────────────────────────────

export function Viewer({
  activeTool, setActiveTool, measurements, onAddMeasurement,
  onUpdateMeasurement, scaleFactor, onScaleSet, activeDrawing, onDrawingAdded,
}: ViewerProps) {
  const pdfCanvasRef     = useRef<HTMLCanvasElement>(null);
  const drawingCanvasRef = useRef<HTMLCanvasElement>(null);
  const pinCanvasRef     = useRef<HTMLCanvasElement>(null);
  const containerRef     = useRef<HTMLDivElement>(null);

  const [pdf, setPdf]               = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale]           = useState(1.5);
  const [loading, setLoading]       = useState(false);

  // tempPoints are stored in NORMALIZED [0,1] coordinates relative to PDF page size.
  // They are converted to canvas pixels only at render time.
  const [tempPoints, setTempPoints] = useState<Array<{ x: number; y: number; snapped: boolean }>>([]);

  // cursorPoint is kept in CANVAS PIXEL coordinates (only used for live preview overlay,
  // never persisted to measurements).
  const [cursorPoint, setCursorPoint] = useState<{ x: number; y: number } | null>(null);

  const [pdfDimensions, setPdfDimensions] = useState<{ w: number; h: number } | null>(null);
  const [isPanning, setIsPanning]   = useState(false);

  // ── Corner Detection State ──────────────────────────────────────────────────
  const workerRef           = useRef<Worker | null>(null);
  const [pageData, setPageData] = useState<Map<number, PageExtractionState>>(new Map());
  const [analysisStatus, setAnalysisStatus] = useState<'idle' | 'analyzing' | 'done'>('idle');
  const [analysisPage, setAnalysisPage]     = useState<{ current: number; total: number } | null>(null);
  const extractionQueueRef  = useRef<Array<{ pageIndex: number; pdf: any; cacheKey: string }>>([]);
  const extractingRef       = useRef(false);
  const cacheKeyRef         = useRef('');

  // ── Snap Settings State ─────────────────────────────────────────────────────
  const [snapEnabled, setSnapEnabled]           = useState(true);
  const [showPins, setShowPins]                 = useState(true);
  const [snapThreshold, setSnapThreshold]       = useState(14);
  const [confidenceFilter, setConfidenceFilter] = useState(0.1);
  const [showSnapSettings, setShowSnapSettings] = useState(false);

  const snapEnabledRef      = useRef(snapEnabled);
  const snapThresholdRef    = useRef(snapThreshold);
  const confidenceFilterRef = useRef(confidenceFilter);
  const showPinsRef         = useRef(showPins);
  useEffect(() => { snapEnabledRef.current      = snapEnabled;      }, [snapEnabled]);
  useEffect(() => { snapThresholdRef.current    = snapThreshold;    }, [snapThreshold]);
  useEffect(() => { confidenceFilterRef.current = confidenceFilter; }, [confidenceFilter]);
  useEffect(() => { showPinsRef.current         = showPins;         }, [showPins]);

  // ── Snap Flash Animations ───────────────────────────────────────────────────
  const [snapFlashes, setSnapFlashes] = useState<SnapFlash[]>([]);
  const flashIdRef = useRef(0);

  const hoveredCornerRef = useRef<{ x: number; y: number } | null>(null);
  const cursorPointRef   = useRef<{ x: number; y: number } | null>(null);

  // ── Post-Draw Correction ────────────────────────────────────────────────────
  const [pendingSnapCandidates, setPendingSnapCandidates] =
    useState<PendingSnapCandidate[] | null>(null);

  // ─── processExtractionQueue via ref ──────────────────────────────────────
  const processExtractionQueueRef = useRef<() => Promise<void>>(async () => {});

  const processExtractionQueue = useCallback(async () => {
    if (extractingRef.current || extractionQueueRef.current.length === 0) {
      if (extractionQueueRef.current.length === 0) {
        setAnalysisStatus('done');
        setAnalysisPage(null);
      }
      return;
    }

    const item = extractionQueueRef.current.shift()!;
    extractingRef.current = true;

    const cached = sessionCache.get(item.cacheKey)?.get(item.pageIndex);
    if (cached) {
      setPageData(prev => {
        const next = new Map(prev);
        next.set(item.pageIndex, {
          status: 'done',
          corners: cached.corners,
          lines: cached.lines,
          intersections: cached.intersections,
          width: cached.width,
          height: cached.height,
        });
        return next;
      });
      extractingRef.current = false;
      processExtractionQueueRef.current();
      return;
    }

    try {
      const page     = await item.pdf.getPage(item.pageIndex + 1);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas   = new OffscreenCanvas(viewport.width, viewport.height);
      const ctx      = canvas.getContext('2d') as any;
      await page.render({ canvasContext: ctx, viewport }).promise;
      const imageData = ctx.getImageData(0, 0, viewport.width, viewport.height);
      workerRef.current?.postMessage(
        { imageData, pageIndex: item.pageIndex, width: viewport.width, height: viewport.height },
        [imageData.data.buffer],
      );
    } catch (err) {
      console.error('Extraction render error:', err);
      extractingRef.current = false;
      processExtractionQueueRef.current();
    }
  }, []);

  useEffect(() => {
    processExtractionQueueRef.current = processExtractionQueue;
  }, [processExtractionQueue]);

  // ─── Worker Setup ─────────────────────────────────────────────────────────

  useEffect(() => {
    const blob = new Blob([getWorkerSource()], { type: 'application/javascript' });
    const url  = URL.createObjectURL(blob);
    workerRef.current = new Worker(url);

    workerRef.current.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        setPageData(prev => {
          const next = new Map(prev);
          const ex   = next.get(msg.pageIndex) ?? makeEmptyPageState();
          next.set(msg.pageIndex, { ...ex, status: 'processing', step: msg.step });
          return next;
        });
        setAnalysisPage(prev => prev ? { ...prev, current: msg.pageIndex + 1 } : null);

      } else if (msg.type === 'result') {
        const result: ExtractionResult = msg.result;
        const cacheKey = cacheKeyRef.current;
        if (cacheKey) {
          if (!sessionCache.has(cacheKey)) sessionCache.set(cacheKey, new Map());
          sessionCache.get(cacheKey)!.set(result.pageIndex, result);
        }
        setPageData(prev => {
          const next = new Map(prev);
          next.set(result.pageIndex, {
            status: 'done',
            corners: result.corners,
            lines: result.lines,
            intersections: result.intersections,
            width: result.width,
            height: result.height,
          });
          return next;
        });
        extractingRef.current = false;
        processExtractionQueueRef.current();

      } else if (msg.type === 'error') {
        console.error('Worker error page', msg.pageIndex, msg.error);
        setPageData(prev => {
          const next = new Map(prev);
          const ex   = next.get(msg.pageIndex) ?? makeEmptyPageState();
          next.set(msg.pageIndex, { ...ex, status: 'error' });
          return next;
        });
        extractingRef.current = false;
        processExtractionQueueRef.current();
      }
    };

    return () => {
      workerRef.current?.terminate();
      URL.revokeObjectURL(url);
    };
  }, []);

  const makeEmptyPageState = (): PageExtractionState => ({
    status: 'idle', corners: [], lines: [], intersections: [], width: 0, height: 0,
  });

  const startExtraction = useCallback(async (pdfDoc: pdfjsLib.PDFDocumentProxy, file?: File) => {
    const numPages = pdfDoc.numPages;
    const cacheKey = file ? fileHash(file) : `pdf_${numPages}_${Date.now()}`;
    cacheKeyRef.current = cacheKey;

    setAnalysisStatus('analyzing');
    setAnalysisPage({ current: 1, total: numPages });
    extractionQueueRef.current = [];
    extractingRef.current = false;

    const initial = new Map<number, PageExtractionState>();
    for (let i = 0; i < numPages; i++) {
      const cached = sessionCache.get(cacheKey)?.get(i);
      if (cached) {
        initial.set(i, {
          status: 'done',
          corners: cached.corners,
          lines: cached.lines,
          intersections: cached.intersections,
          width: cached.width,
          height: cached.height,
        });
      } else {
        initial.set(i, makeEmptyPageState());
        extractionQueueRef.current.push({ pageIndex: i, pdf: pdfDoc, cacheKey });
      }
    }
    setPageData(initial);

    if (extractionQueueRef.current.length === 0) {
      setAnalysisStatus('done');
      setAnalysisPage(null);
    } else {
      processExtractionQueueRef.current();
    }
  }, []);

  // ─── Refs for stable callbacks ────────────────────────────────────────────

  const pageDataRef = useRef(pageData);
  useEffect(() => { pageDataRef.current = pageData; }, [pageData]);

  const pdfDimensionsRef = useRef(pdfDimensions);
  useEffect(() => { pdfDimensionsRef.current = pdfDimensions; }, [pdfDimensions]);

  const pageNumberRef = useRef(pageNumber);
  useEffect(() => { pageNumberRef.current = pageNumber; }, [pageNumber]);

  // ─── Coordinate Conversion Helpers ───────────────────────────────────────
  //
  // KEY FIX: All measurement points are stored in NORMALIZED [0,1] coordinates
  // relative to the PDF page dimensions. They are converted to canvas pixels
  // only at render time by multiplying by pdfDimensions.w / .h.
  //
  // This means zoom in/out simply changes pdfDimensions, and every point
  // automatically renders at the correct position without any stored data
  // needing to change.

  // canvas pixels → normalized [0,1]  (used when STORING a clicked point)
  const toNorm = useCallback((canvasX: number, canvasY: number): { x: number; y: number } => {
    const dims = pdfDimensionsRef.current;
    if (!dims) return { x: canvasX, y: canvasY };
    return { x: canvasX / dims.w, y: canvasY / dims.h };
  }, []);

  // normalized [0,1] → canvas pixels  (used when RENDERING a stored point)
  const toCanvas = useCallback((normX: number, normY: number): { x: number; y: number } => {
    const dims = pdfDimensionsRef.current;
    if (!dims) return { x: normX, y: normY };
    return { x: normX * dims.w, y: normY * dims.h };
  }, []);

  // ─── Snap Logic ──────────────────────────────────────────────────────────
  //
  // getScaledCorners returns corners in CANVAS PIXEL coordinates so they can
  // be compared directly against raw mouse positions (also canvas pixels).
  // Corner nx/ny are already normalized [0,1], so we just multiply by dims.

  const getScaledCorners = useCallback(
    (pageIdx: number): Array<{ x: number; y: number; confidence: number }> => {
      const dims = pdfDimensionsRef.current;
      if (!dims) return [];
      const pg = pageDataRef.current.get(pageIdx - 1);
      if (!pg || pg.status !== 'done') return [];
      return pg.corners
        .filter(c => c.confidence >= confidenceFilterRef.current)
        .map(c => ({ x: c.nx * dims.w, y: c.ny * dims.h, confidence: c.confidence }));
    },
    [],
  );

  // snapToCorner works in CANVAS PIXEL space (input and output are canvas pixels)
  const snapToCorner = useCallback((rawX: number, rawY: number): SnapResult => {
    if (!snapEnabledRef.current || !pdfDimensionsRef.current) {
      return { point: { x: rawX, y: rawY }, snapped: false };
    }
    const corners = getScaledCorners(pageNumberRef.current);
    let bestCorner: { x: number; y: number } | null = null;
    let bestDist = snapThresholdRef.current;
    for (const c of corners) {
      const dist = Math.hypot(rawX - c.x, rawY - c.y);
      if (dist < bestDist) { bestDist = dist; bestCorner = c; }
    }
    return bestCorner
      ? { point: { x: bestCorner.x, y: bestCorner.y }, snapped: true }
      : { point: { x: rawX, y: rawY }, snapped: false };
  }, [getScaledCorners]);

  const triggerSnapFlash = useCallback((x: number, y: number) => {
    const id = ++flashIdRef.current;
    setSnapFlashes(prev => [...prev, { x, y, id }]);
    setTimeout(() => setSnapFlashes(prev => prev.filter(f => f.id !== id)), 700);
  }, []);

  // ─── Hover corner detection (canvas pixel space) ──────────────────────────

  const handlePinHover = useCallback((canvasX: number, canvasY: number) => {
    cursorPointRef.current = { x: canvasX, y: canvasY };
    if (!showPinsRef.current || !pdfDimensionsRef.current) {
      hoveredCornerRef.current = null;
      return;
    }
    const corners = getScaledCorners(pageNumberRef.current);
    let closest: { x: number; y: number } | null = null;
    let closestDist = 16;
    for (const c of corners) {
      const dist = Math.hypot(canvasX - c.x, canvasY - c.y);
      if (dist < closestDist) { closestDist = dist; closest = c; }
    }
    hoveredCornerRef.current = closest;
  }, [getScaledCorners]);

  // ─── Pin Canvas Rendering (all canvas pixel space) ────────────────────────

  const redrawPinCanvas = useCallback(() => {
    const canvas = pinCanvasRef.current;
    if (!canvas || !pdfDimensionsRef.current) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!showPinsRef.current) return;

    const corners = getScaledCorners(pageNumberRef.current);
    const cursor  = cursorPointRef.current;
    const thresh  = snapThresholdRef.current;

    // Visibility radius: 4× the snap threshold.
    // getScaledCorners() works in canvas-pixel space, which already scales with
    // zoom — so this radius automatically grows/shrinks proportionally. No extra
    // math needed; zoom handles it for free.
    const VISIBLE_RADIUS = thresh * 8;

    if (!cursor) return; // nothing to show until the cursor enters the canvas

    for (const c of corners) {
      const dist      = Math.hypot(cursor.x - c.x, cursor.y - c.y);
      const isInSnap  = dist < thresh;
      const isVisible = dist < VISIBLE_RADIUS;

      if (!isVisible) continue;

      // Smooth fade-in: 0 at the outer edge, 1 at the snap threshold boundary
      const proximity = 1 - Math.min(1, (dist - thresh) / (VISIBLE_RADIUS - thresh));

      ctx.beginPath();
      if (isInSnap) {
        // Inside snap range → bright amber, full opacity
        ctx.arc(c.x, c.y, 7, 0, Math.PI * 2);
        ctx.fillStyle   = '#F59E0B';
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth   = 1.5;
        ctx.stroke();
      } else {
        // Within awareness zone → blue, fades with distance
        const alpha = 0.25 + proximity * 0.6;
        const r     = 3 + c.confidence * 2;
        ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
        ctx.fillStyle   = `rgba(96, 165, 250, ${alpha * 0.55})`;
        ctx.fill();
        ctx.strokeStyle = `rgba(96, 165, 250, ${alpha})`;
        ctx.lineWidth   = 1;
        ctx.stroke();
      }
    }
  }, [getScaledCorners]);

  useEffect(() => {
    redrawPinCanvas();
  }, [redrawPinCanvas, pageData, showPins, snapThreshold, confidenceFilter, pageNumber]);

  // ─── Clear temp points when tool changes ─────────────────────────────────

  useEffect(() => {
    setTempPoints([]);
    setCursorPoint(null);
    cursorPointRef.current = null;
  }, [activeTool]);

  // ─── Fit to screen ────────────────────────────────────────────────────────

  const fitToScreen = useCallback(async (pdfDoc: pdfjsLib.PDFDocumentProxy, pageNum: number) => {
    try {
      const page     = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1 });
      if (containerRef.current) {
        const { width, height } = containerRef.current.getBoundingClientRect();
        const fitScale = Math.min((width - 64) / viewport.width, (height - 64) / viewport.height);
        setScale(Math.max(0.1, fitScale));
      }
    } catch (err) { console.error('Fit error', err); }
  }, []);

  // ─── File Upload ──────────────────────────────────────────────────────────

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    Array.from(files).forEach(file => {
      const url = URL.createObjectURL(file);
      onDrawingAdded(file.name, url, file);
    });
  };

  // ─── PDF Load ─────────────────────────────────────────────────────────────

  useEffect(() => {
    let isMounted = true;
    if (!activeDrawing?.fileUrl) { setPdf(null); return; }
    setLoading(true);

    const handlePdfLoad = (pdfDoc: pdfjsLib.PDFDocumentProxy) => {
      if (!isMounted) return;
      setPdf(pdfDoc);
      setPageNumber(1);
      fitToScreen(pdfDoc, 1);
      setLoading(false);
      startExtraction(pdfDoc, activeDrawing.file);
    };

    if (activeDrawing.file) {
      const reader = new FileReader();
      reader.onload = () => {
        if (!isMounted) return;
        pdfjsLib.getDocument({ data: new Uint8Array(reader.result as ArrayBuffer) }).promise
          .then(handlePdfLoad).catch(err => { console.error(err); if (isMounted) setLoading(false); });
      };
      reader.readAsArrayBuffer(activeDrawing.file);
    } else {
      pdfjsLib.getDocument(activeDrawing.fileUrl).promise
        .then(handlePdfLoad).catch(err => { console.error(err); if (isMounted) setLoading(false); });
    }

    return () => { isMounted = false; };
  }, [activeDrawing, fitToScreen, startExtraction]);

  // ─── PDF Rendering ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!pdf) return;
    let active = true;
    let renderTask: any = null;

    const renderPage = async () => {
      try {
        const page     = await pdf.getPage(pageNumber);
        if (!active) return;
        const viewport = page.getViewport({ scale });
        const canvas   = pdfCanvasRef.current;
        if (!canvas) return;
        const context  = canvas.getContext('2d');
        if (!context) return;
        canvas.height  = viewport.height;
        canvas.width   = viewport.width;
        if (drawingCanvasRef.current) {
          drawingCanvasRef.current.width  = viewport.width;
          drawingCanvasRef.current.height = viewport.height;
        }
        if (pinCanvasRef.current) {
          pinCanvasRef.current.width  = viewport.width;
          pinCanvasRef.current.height = viewport.height;
        }
        setPdfDimensions({ w: viewport.width, h: viewport.height });
        renderTask = page.render({ canvasContext: context, viewport });
        await renderTask.promise;
      } catch (err: any) {
        if (err?.name !== 'RenderingCancelledException') console.error('Render error:', err);
      }
    };

    renderPage();
    return () => { active = false; if (renderTask) renderTask.cancel(); };
  }, [pdf, pageNumber, scale]);

  // ─── Measurement Drawing ──────────────────────────────────────────────────
  //
  // KEY FIX: measurements[].points are in normalized [0,1] space.
  // We call toCanvas() on each point before drawing. This means the drawing
  // always matches the current zoom level perfectly.

  useEffect(() => {
    const canvas = drawingCanvasRef.current;
    if (!canvas || !pdfDimensions) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    measurements.forEach(m => {
      if (!m.isVisible || m.points.length === 0) return;

      // Convert stored normalized points → canvas pixels for rendering
      const canvasPts = m.points.map(p => toCanvas(p.x, p.y));

      ctx.strokeStyle = m.color;
      ctx.fillStyle   = m.color + '60';
      ctx.lineWidth   = 3;
      ctx.beginPath();
      ctx.moveTo(canvasPts[0].x, canvasPts[0].y);
      canvasPts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
      if (m.type === 'Area') ctx.closePath();
      ctx.stroke();
      if (m.type === 'Area') ctx.fill();
      canvasPts.forEach((p, idx) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
        if (m.type === 'Count') {
          ctx.fillStyle = 'white';
          ctx.font = '12px monospace';
          ctx.fillText((idx + 1).toString(), p.x + 8, p.y - 8);
          ctx.fillStyle = m.color + '60';
        }
      });
    });

    // Temp points preview
    // tempPoints are in normalized space — convert to canvas pixels for drawing
    const tempCanvasPts = tempPoints.map(p => ({ ...toCanvas(p.x, p.y), snapped: p.snapped }));

    if (tempCanvasPts.length > 0 || (cursorPoint && activeTool !== 'select')) {
      ctx.strokeStyle = '#F59E0B';
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 2;

      const allPts = [...tempCanvasPts.map(p => ({ x: p.x, y: p.y }))];
      if (cursorPoint && tempCanvasPts.length > 0) allPts.push(cursorPoint);

      if (allPts.length > 0) {
        ctx.beginPath();
        ctx.moveTo(allPts[0].x, allPts[0].y);
        allPts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
        if (activeTool === 'area' && allPts.length > 2) {
          ctx.lineTo(allPts[0].x, allPts[0].y);
          ctx.fillStyle = '#F59E0B40';
          ctx.fill();
        }
        ctx.stroke();
        ctx.setLineDash([]);

        tempCanvasPts.forEach(p => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.snapped ? 6 : 4, 0, Math.PI * 2);
          ctx.fillStyle = p.snapped ? '#22C55E' : '#F59E0B';
          ctx.fill();
          if (p.snapped) {
            ctx.strokeStyle = '#22C55E';
            ctx.lineWidth   = 1.5;
            ctx.stroke();
          }
        });

        if (cursorPoint) {
          ctx.beginPath();
          ctx.arc(cursorPoint.x, cursorPoint.y, 4, 0, Math.PI * 2);
          ctx.fillStyle = '#F59E0B';
          ctx.fill();
        }

        if (allPts.length > 1 && cursorPoint) {
          let text = '';
          if (activeTool === 'area' && allPts.length > 2) {
            // Area calculation uses canvas pixels (correct — scaleFactor bridges px→real)
            let area = 0;
            for (let i = 0; i < allPts.length; i++) {
              const j = (i + 1) % allPts.length;
              area += allPts[i].x * allPts[j].y - allPts[j].x * allPts[i].y;
            }
            text = `${(Math.abs(area) / 2 * scaleFactor * scaleFactor).toFixed(2)} sq m`;
          } else if (activeTool === 'linear' || activeTool === 'scale') {
            let len = 0;
            for (let i = 1; i < allPts.length; i++) {
              len += Math.hypot(allPts[i].x - allPts[i - 1].x, allPts[i].y - allPts[i - 1].y);
            }
            text = activeTool === 'scale'
              ? `${len.toFixed(2)} px`
              : `${(len * scaleFactor).toFixed(2)} m`;
          }
          if (text) {
            ctx.font = 'bold 12px monospace';
            const tw = ctx.measureText(text).width;
            ctx.fillStyle = '#F59E0B';
            ctx.fillRect(cursorPoint.x + 10, cursorPoint.y - 22, tw + 10, 20);
            ctx.fillStyle = 'black';
            ctx.fillText(text, cursorPoint.x + 15, cursorPoint.y - 7);
          }
        }
      }
    }
  }, [measurements, tempPoints, cursorPoint, pdfDimensions, activeTool, scaleFactor, toCanvas]);

  // ─── Finish Measurement ───────────────────────────────────────────────────
  //
  // tempPoints are in normalized [0,1] space.
  // For quantity calculations we convert to canvas pixels first (so scaleFactor
  // still works correctly as pixels-per-unit). The points stored in the
  // measurement row stay normalized.

  const finishMeasurement = useCallback((currentTempPoints?: Array<{ x: number; y: number; snapped: boolean }>) => {
    const pts = currentTempPoints ?? tempPoints;

    if (pts.length < 2) { setTempPoints([]); setCursorPoint(null); return; }

    if (activeTool === 'scale') {
      // pts are normalized — convert to canvas pixels for pixel distance
      const p0 = toCanvas(pts[0].x, pts[0].y);
      const p1 = toCanvas(pts[1].x, pts[1].y);
      const px = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const realStr = window.prompt('Enter real world length in meters (e.g. 5):', '5');
      if (realStr) {
        const realLen = parseFloat(realStr);
        if (!isNaN(realLen) && realLen > 0) onScaleSet(realLen / px);
      }
      setTempPoints([]); setCursorPoint(null);
      setActiveTool('select');
      return;
    }

    let type: MeasurementType = 'Length';
    let qty = 0;
    let unit = 'm';

    // Normalized points for storage
    const normPoints = pts.map(p => ({ x: p.x, y: p.y }));

    // Canvas-pixel points for quantity calculation
    const canvasPts = pts.map(p => toCanvas(p.x, p.y));

    if (activeTool === 'area') {
      type = 'Area';
      let area = 0;
      for (let i = 0; i < canvasPts.length; i++) {
        const j = (i + 1) % canvasPts.length;
        area += canvasPts[i].x * canvasPts[j].y - canvasPts[j].x * canvasPts[i].y;
      }
      qty  = Math.abs(area) / 2 * scaleFactor * scaleFactor;
      unit = 'sq m';
    } else if (activeTool === 'linear') {
      type = 'Length';
      for (let i = 1; i < canvasPts.length; i++) {
        qty += Math.hypot(canvasPts[i].x - canvasPts[i - 1].x, canvasPts[i].y - canvasPts[i - 1].y);
      }
      qty *= scaleFactor;
      unit = 'm';
    }

    const newMeasurementId = crypto.randomUUID();

    onAddMeasurement({
      description: `New ${type}`,
      type, quantity: qty, unit, unitRate: 0, notes: '',
      points: normPoints,   // ← stored as normalized [0,1]
      isOverridden: false,
    });

    // Post-draw correction: check unsnapped points near corners
    if (snapEnabledRef.current && pdfDimensionsRef.current) {
      const freePoints = pts
        .map((p, i) => ({ ...p, index: i }))
        .filter(p => !p.snapped);

      if (freePoints.length > 0) {
        const pageCorners = getScaledCorners(pageNumberRef.current);
        const candidates: PendingSnapCandidate[] = [];

        for (const fp of freePoints) {
          // fp is normalized — convert to canvas pixels to compare with corners
          const fpCanvas = toCanvas(fp.x, fp.y);
          let bestDist   = snapThresholdRef.current * 2;
          let bestTarget: { x: number; y: number } | null = null;
          for (const c of pageCorners) {
            const dist = Math.hypot(fpCanvas.x - c.x, fpCanvas.y - c.y);
            if (dist < bestDist) { bestDist = dist; bestTarget = { x: c.x, y: c.y }; }
          }
          if (bestTarget) {
            // Store snap target in normalized space so it survives zoom changes
            const normTarget = toNorm(bestTarget.x, bestTarget.y);
            candidates.push({
              pointIndex: fp.index,
              measurementId: newMeasurementId,
              snapTarget: normTarget,
            });
          }
        }

        if (candidates.length > 0) {
          setPendingSnapCandidates(candidates);
        }
      }
    }

    setTempPoints([]); setCursorPoint(null);
  }, [tempPoints, activeTool, scaleFactor, onAddMeasurement, onScaleSet, setActiveTool, getScaledCorners, toCanvas, toNorm]);

  // Auto-finish scale after 2 points
  useEffect(() => {
    if (activeTool === 'scale' && tempPoints.length === 2) {
      finishMeasurement(tempPoints);
    }
  }, [tempPoints, activeTool, finishMeasurement]);

  // ─── Canvas Click ─────────────────────────────────────────────────────────
  //
  // Raw mouse position is in canvas pixel space. We snap (also canvas pixels),
  // then normalize before storing into tempPoints.

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (activeTool === 'select') return;
    if (e.button === 2) { finishMeasurement(); return; }

    const rect = drawingCanvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const rawX = (e.clientX - rect.left) * (drawingCanvasRef.current!.width / rect.width);
    const rawY = (e.clientY - rect.top)  * (drawingCanvasRef.current!.height / rect.height);

    // Snap in canvas pixel space
    const snapResult = snapToCorner(rawX, rawY);
    const finalCanvasPt = snapResult.point;
    if (snapResult.snapped) triggerSnapFlash(finalCanvasPt.x, finalCanvasPt.y);

    // Normalize to [0,1] for storage
    const norm = toNorm(finalCanvasPt.x, finalCanvasPt.y);

    if (activeTool === 'count') {
      onAddMeasurement({
        description: 'New Count', type: 'Count',
        quantity: measurements.filter(m => m.type === 'Count').length + 1,
        unit: 'EA', unitRate: 0, notes: '',
        points: [norm],   // ← normalized
        isOverridden: false,
      });
      return;
    }

    if (activeTool === 'point') {
      onAddMeasurement({
        description: 'Point Marker', type: 'Point',
        quantity: 1, unit: 'PT', unitRate: 0, notes: '',
        points: [norm],   // ← normalized
        isOverridden: false,
      });
      return;
    }

    setTempPoints(prev => [...prev, { x: norm.x, y: norm.y, snapped: snapResult.snapped }]);
  };

  const handleContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (activeTool !== 'select') finishMeasurement();
  };

  const handleCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (activeTool === 'select' || isPanning) return;

    const rect = drawingCanvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const rawX = (e.clientX - rect.left) * (drawingCanvasRef.current!.width / rect.width);
    const rawY = (e.clientY - rect.top)  * (drawingCanvasRef.current!.height / rect.height);

    handlePinHover(rawX, rawY);
    redrawPinCanvas();

    // cursorPoint stays in canvas pixel space — it's only used for the live
    // rubber-band preview and never persisted.
    const snapResult = snapToCorner(rawX, rawY);
    setCursorPoint(snapResult.point);
    cursorPointRef.current = snapResult.point;
  };

  // ─── Wheel Zoom ───────────────────────────────────────────────────────────

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        setScale(s => {
          const newScale = Math.max(0.1, s + delta);
          if (newScale !== s) {
            const ratio       = newScale / s;
            const canvasRect  = drawingCanvasRef.current?.getBoundingClientRect();
            if (canvasRect) {
              setTimeout(() => {
                if (containerRef.current) {
                  containerRef.current.scrollLeft += (e.clientX - canvasRect.left) * (ratio - 1);
                  containerRef.current.scrollTop  += (e.clientY - canvasRect.top)  * (ratio - 1);
                }
              }, 0);
            }
          }
          return newScale;
        });
      }
    };
    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, []);

  // ─── Panning ──────────────────────────────────────────────────────────────

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button === 1 || (e.button === 0 && activeTool === 'select')) {
      e.preventDefault();
      setIsPanning(true);
      if (containerRef.current) containerRef.current.style.cursor = 'grabbing';
    }
  };
  const handlePointerUp = () => {
    setIsPanning(false);
    if (containerRef.current) containerRef.current.style.cursor = '';
  };
  const handleContainerPointerMove = (e: React.PointerEvent) => {
    if (isPanning && containerRef.current) {
      containerRef.current.scrollLeft -= e.movementX;
      containerRef.current.scrollTop  -= e.movementY;
    }
  };

  // ─── Manual Scale ─────────────────────────────────────────────────────────

  const handleManualScale = () => {
    const ratioStr = window.prompt('Enter scale ratio (e.g. 1:100) or pixels per unit (e.g. 0.05):');
    if (!ratioStr) return;
    if (ratioStr.includes(':')) {
      const [paper, real] = ratioStr.split(':').map(parseFloat);
      if (!isNaN(paper) && !isNaN(real) && real > 0) {
        alert('Ratio parsing applied. Use Draw Calibration for pixel-accurate mapping.');
        onScaleSet(real / paper);
      }
    } else {
      const factor = parseFloat(ratioStr);
      if (!isNaN(factor) && factor > 0) onScaleSet(factor);
    }
  };

  // ─── Tools ───────────────────────────────────────────────────────────────

  const tools = [
    { id: 'select', icon: MousePointer2, label: 'Select (Pan)', shortcut: 'V' },
    { id: 'point',  icon: CircleDot,     label: 'Point',        shortcut: 'P' },
    { id: 'linear', icon: Ruler,         label: 'Linear',       shortcut: 'L' },
    { id: 'area',   icon: Square,        label: 'Area',         shortcut: 'A' },
    { id: 'count',  icon: Hash,          label: 'Count',        shortcut: 'C' },
    { id: 'scale',  icon: Scaling,       label: 'Calibrate',    shortcut: 'S' },
  ];

  const currentPageData = pageData.get(pageNumber - 1);
  const isAnalyzing     = analysisStatus === 'analyzing';

  return (
    <div className="flex-1 relative bg-industrial-black blueprint-grid flex flex-col overflow-hidden">
      {/* Header / Tools */}
      <div className="h-12 bg-industrial-panel border-b border-industrial-border flex flex-shrink-0 items-center justify-between px-4 z-20 shadow-sm relative">
        <div className="flex gap-1">
          {tools.map(tool => (
            <button
              key={tool.id}
              onClick={() => setActiveTool(tool.id as ToolType)}
              className={cn(
                'w-9 h-9 flex items-center justify-center transition-all relative group border',
                activeTool === tool.id
                  ? 'bg-zinc-800 border-amber-400 text-amber-400'
                  : 'bg-transparent border-transparent text-zinc-500 hover:text-zinc-200',
              )}
              title={`${tool.label} (${tool.shortcut})`}
            >
              <tool.icon className="w-4 h-4" />
              <div className="absolute top-10 transform -translate-x-1/2 left-1/2 px-2 py-1 bg-zinc-900 border border-industrial-border text-[9px] text-zinc-400 invisible group-hover:visible whitespace-nowrap pointer-events-none uppercase tracking-widest font-mono z-50">
                {tool.label} [{tool.shortcut}]
              </div>
            </button>
          ))}
        </div>

        <div className="flex flex-col md:flex-row items-center gap-2">
          {isAnalyzing && analysisPage && (
            <div className="flex items-center gap-1.5 border border-blue-500/40 bg-blue-500/10 px-2 py-1">
              <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
              <span className="text-[9px] font-mono text-blue-400 uppercase tracking-widest">
                Analyzing plan… {analysisPage.current}/{analysisPage.total}
              </span>
            </div>
          )}
          {analysisStatus === 'done' && (
            <div className="flex items-center gap-1.5 border border-green-500/40 bg-green-500/10 px-2 py-1">
              <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
              <span className="text-[9px] font-mono text-green-400 uppercase tracking-widest">
                {currentPageData?.corners.length ?? 0} corners detected
              </span>
            </div>
          )}

          <button
            onClick={() => setSnapEnabled(s => !s)}
            className={cn(
              'flex items-center gap-1 text-[9px] font-mono font-bold uppercase tracking-widest px-2 py-1 border transition-all',
              snapEnabled
                ? 'bg-green-500/10 border-green-500/50 text-green-400 hover:bg-green-500/20'
                : 'bg-transparent border-zinc-700 text-zinc-500 hover:border-zinc-500',
            )}
            title="Toggle corner snapping"
          >
            <Target className="w-3 h-3" />
            {snapEnabled ? 'SNAP ON' : 'SNAP OFF'}
          </button>

          <button
            onClick={() => setShowSnapSettings(s => !s)}
            className={cn(
              'flex items-center gap-1 text-[9px] font-mono font-bold uppercase tracking-widest px-2 py-1 border transition-all',
              showSnapSettings
                ? 'bg-zinc-800 border-zinc-500 text-zinc-200'
                : 'bg-transparent border-zinc-700 text-zinc-500 hover:border-zinc-500',
            )}
            title="Snap settings"
          >
            <Settings2 className="w-3 h-3" />
            SNAP
          </button>

          <div className="flex items-center gap-1 border border-industrial-border bg-stone-900 px-2 py-1">
            <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-tighter">Scale:</span>
            <span className="text-[10px] font-mono font-bold text-amber-400 tracking-tighter whitespace-nowrap">
              {scaleFactor === 1 ? 'NOT CALIBRATED' : `1px = ${scaleFactor.toFixed(4)}u`}
            </span>
          </div>
          <button
            onClick={() => setActiveTool('scale')}
            className={cn(
              'text-[10px] font-mono font-bold uppercase tracking-widest px-3 py-1 transition-all border',
              activeTool === 'scale'
                ? 'bg-amber-400 text-black border-amber-400'
                : 'text-amber-400 border-amber-400 hover:bg-amber-400 hover:text-black',
            )}
          >
            DRAW CALIBRATION
          </button>
          <button
            onClick={handleManualScale}
            className="text-[10px] font-mono font-bold uppercase tracking-widest px-3 py-1 transition-all border text-amber-400 border-amber-400 hover:bg-amber-400 hover:text-black"
          >
            MANUAL SCALE
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button onClick={() => setScale(s => Math.max(0.1, s - 0.1))} className="p-1.5 text-zinc-500 hover:text-zinc-200">
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className="text-[10px] font-mono text-zinc-400 w-12 text-center">{Math.round(scale * 100)}%</span>
          <button onClick={() => setScale(s => s + 0.1)} className="p-1.5 text-zinc-500 hover:text-zinc-200">
            <ZoomIn className="w-4 h-4" />
          </button>
          <div className="w-px h-4 bg-industrial-border mx-1" />
          <button onClick={() => pdf && fitToScreen(pdf, pageNumber)} className="p-1.5 text-zinc-500 hover:text-zinc-200">
            <Maximize className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Snap Settings Panel */}
      {showSnapSettings && (
        <SnapSettingsPanel
          showPins={showPins}
          onShowPinsChange={setShowPins}
          snapThreshold={snapThreshold}
          onSnapThresholdChange={setSnapThreshold}
          confidenceFilter={confidenceFilter}
          onConfidenceFilterChange={setConfidenceFilter}
          snapEnabled={snapEnabled}
          onSnapEnabledChange={setSnapEnabled}
        />
      )}

      {/* Main Canvas Area */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto custom-scrollbar relative outline-none select-none"
        onKeyDown={e => {
          if (e.key === 'Escape') {
            if (tempPoints.length > 0) finishMeasurement();
            else setActiveTool('select');
          }
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handleContainerPointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        tabIndex={0}
      >
        <div className={cn('min-h-full min-w-full flex w-max h-max', !pdf ? 'items-center justify-center p-8' : 'p-[50vh] xl:p-[100vh]')}>
          {!pdf && !loading && (
            <div className="flex flex-col items-center gap-6 p-12 border-2 border-dashed border-industrial-border bg-industrial-panel/50 backdrop-blur-sm max-w-xl w-full text-center">
              <FolderOpen className="w-12 h-12 text-zinc-700" />
              <div>
                <h2 className="text-xl font-mono font-bold tracking-tighter text-zinc-200 mb-2">IMPORT PROJECT DRAWING</h2>
                <p className="text-xs text-zinc-500 font-mono leading-relaxed uppercase tracking-widest">
                  DRAG AND DROP OR SELECT A PDF, DWG, OR IMAGE FILE TO BEGIN MEASURING QUANTITIES.
                </p>
              </div>
              <label className="bg-amber-400 hover:bg-amber-300 text-black px-10 py-3 font-mono font-bold text-xs uppercase tracking-widest cursor-pointer transition-all shadow-xl shadow-amber-400/10 active:scale-95">
                Select File(s)
                <input type="file" multiple className="hidden" accept=".pdf,.png,.jpg,.jpeg,.dwg" onChange={handleFileUpload} />
              </label>
            </div>
          )}

          {loading && (
            <div className="flex flex-col items-center gap-4 m-auto">
              <div className="w-12 h-12 border-4 border-zinc-800 border-t-amber-400 rounded-full animate-spin" />
              <span className="text-[10px] font-mono font-bold text-amber-400 tracking-[0.2em] uppercase animate-pulse">Processing Vector Data...</span>
            </div>
          )}

          {pdf && (
            <div
              className="relative shadow-2xl border border-industrial-border bg-white transition-all flex-shrink-0 m-auto"
              style={pdfDimensions ? { width: pdfDimensions.w, height: pdfDimensions.h } : {}}
            >
              {/* PDF canvas */}
              <canvas ref={pdfCanvasRef} className="absolute inset-0 z-0 pointer-events-none" />

              {/* Measurement drawing canvas */}
              <canvas
                ref={drawingCanvasRef}
                onClick={handleCanvasClick}
                onContextMenu={handleContextMenu}
                onPointerMove={handleCanvasPointerMove}
                onPointerLeave={() => {
                  setCursorPoint(null);
                  cursorPointRef.current   = null;
                  hoveredCornerRef.current = null;
                  redrawPinCanvas();
                }}
                className={cn(
                  'absolute inset-0 z-10 w-full h-full mix-blend-multiply',
                  activeTool !== 'select' && !isPanning ? 'cursor-crosshair' : isPanning ? 'cursor-grabbing' : 'cursor-grab',
                )}
              />

              {/* Pin overlay canvas */}
              <canvas
                ref={pinCanvasRef}
                className="absolute inset-0 z-20 w-full h-full pointer-events-none"
                style={{ opacity: showPins && activeTool !== 'select' ? 1 : 0, transition: 'opacity 0.2s' }}
              />

              {/* Snap flash animations */}
              {snapFlashes.map(flash => (
                <div
                  key={flash.id}
                  className="absolute pointer-events-none z-30"
                  style={{ left: flash.x, top: flash.y, transform: 'translate(-50%,-50%)' }}
                >
                  <div className="w-8 h-8 rounded-full border-2 border-green-400"
                    style={{ animation: 'snapPulse 0.6s ease-out forwards' }}
                  />
                </div>
              ))}

              {/* Finish button — position derived from last tempPoint converted to canvas pixels */}
              {tempPoints.length > 1 && (activeTool === 'area' || activeTool === 'linear') && (() => {
                const lastPt = toCanvas(
                  tempPoints[tempPoints.length - 1].x,
                  tempPoints[tempPoints.length - 1].y,
                );
                return (
                  <button
                    className="absolute z-30 flex items-center justify-center gap-1.5 bg-amber-400 text-black font-bold font-mono text-[10px] uppercase tracking-widest px-3 py-1.5 shadow-lg whitespace-nowrap hover:bg-amber-300 active:scale-95 transition-transform"
                    style={{ left: lastPt.x + 15, top: lastPt.y + 15 }}
                    onClick={e => { e.stopPropagation(); finishMeasurement(); }}
                    onPointerDown={e => e.stopPropagation()}
                  >
                    <Check className="w-3 h-3" />
                    Finish ({tempPoints.filter(p => p.snapped).length}/{tempPoints.length} snapped)
                  </button>
                );
              })()}
            </div>
          )}
        </div>

        {/* Post-draw snap correction dialog */}
        {pendingSnapCandidates && pendingSnapCandidates.length > 0 && (
          <SnapCandidateDialog
            count={pendingSnapCandidates.length}
            onAccept={() => {
              if (onUpdateMeasurement && pendingSnapCandidates.length > 0) {
                const byId = new Map<string, PendingSnapCandidate[]>();
                for (const cand of pendingSnapCandidates) {
                  if (!byId.has(cand.measurementId)) byId.set(cand.measurementId, []);
                  byId.get(cand.measurementId)!.push(cand);
                }

                byId.forEach((candidates, measurementId) => {
                  const target =
                    measurements.find(m => m.id === measurementId) ??
                    measurements[measurements.length - 1];
                  if (!target) return;

                  const updatedPoints = [...target.points];
                  for (const c of candidates) {
                    if (c.pointIndex < updatedPoints.length) {
                      // snapTarget is already in normalized [0,1] space
                      updatedPoints[c.pointIndex] = c.snapTarget;
                    }
                  }
                  onUpdateMeasurement(target.id, { points: updatedPoints });
                });
              }
              setPendingSnapCandidates(null);
            }}
            onDismiss={() => setPendingSnapCandidates(null)}
          />
        )}
      </div>

      {/* Footer */}
      {pdf && (
        <div className="h-10 flex-shrink-0 bg-industrial-panel border-t border-industrial-border px-4 flex items-center justify-between z-20 font-mono relative shadow-sm">
          <div className="flex items-center gap-4">
            <button
              onClick={() => setPageNumber(p => Math.max(1, p - 1))}
              className="p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-50"
              disabled={pageNumber <= 1}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-tighter">
              PAGE {pageNumber} OF {pdf.numPages}
            </span>
            <button
              onClick={() => setPageNumber(p => Math.min(pdf.numPages, p + 1))}
              className="p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-50"
              disabled={pageNumber >= pdf.numPages}
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          <div className="hidden md:flex items-center gap-4 text-[9px] text-zinc-500 uppercase tracking-widest">
            <span>Right-click to finish · ESC to cancel</span>
            <div className="w-px h-3 bg-industrial-border" />
            {snapEnabled && (
              <>
                <span className="text-green-500">⦿ SNAP ACTIVE {snapThreshold}px</span>
                <div className="w-px h-3 bg-industrial-border" />
              </>
            )}
            <span>RENDER_ENGINE: PDF.JS V{pdfjsLib.version}</span>
          </div>
        </div>
      )}

      <style>{`
        @keyframes snapPulse {
          0%   { transform: translate(-50%,-50%) scale(0.5); opacity: 1; }
          100% { transform: translate(-50%,-50%) scale(2.5); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
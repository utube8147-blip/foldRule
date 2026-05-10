// ─── useSnapEngine1.ts ─────────────────────────────────────────────────────────
// Encapsulates:
//   • Inline Web Worker (Harris corner + line detection + wall detection)
//   • Session-level extraction cache
//   • Per-page extraction queue
//   • snapToCorner() — canvas-pixel space
//   • getScaledCorners() — canvas-pixel space
//   • getScaledWallCorners() — wall-specific corners in canvas-pixel space
//   • getScaledWallLines() — wall-specific lines in canvas-pixel space
//   • redrawPinCanvas() — proximity-only corner dots
//   • Snap flash animation state

import { useRef, useState, useCallback, useEffect } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import {
  DetectedCorner, ExtractionResult, PageExtractionState,
  SnapFlash, SnapResult, PdfDimensions,
} from './viewerTypes';

// ─── Wall-specific types ───────────────────────────────────────────────────────

export interface WallLine {
  x1: number; y1: number;
  x2: number; y2: number;
  angle: number;       // degrees: 0 = horizontal, 90 = vertical
  length: number;
  /** Normalised coords [0,1] for both endpoints */
  nx1: number; ny1: number;
  nx2: number; ny2: number;
}

export interface WallCorner {
  x: number; y: number;
  confidence: number;
  nx: number; ny: number;
  /** Which wall lines meet here (indices into wallLines array) */
  lineIndices: number[];
}

// ─── Worker source (inlined so no extra build step) ──────────────────────────

function getWorkerSource(): string {
  return `
function gaussianBlur(data,w,h){const kernel=[2,4,5,4,2,4,9,12,9,4,5,12,15,12,5,4,9,12,9,4,2,4,5,4,2];const kSum=159;const out=new Float32Array(w*h);for(let y=2;y<h-2;y++){for(let x=2;x<w-2;x++){let v=0,ki=0;for(let ky=-2;ky<=2;ky++){for(let kx=-2;kx<=2;kx++){const idx=((y+ky)*w+(x+kx))*4;v+=(0.299*data[idx]+0.587*data[idx+1]+0.114*data[idx+2])*kernel[ki++];}}out[y*w+x]=v/kSum;}}return out;}

function sobelGradients(gray,w,h){const gx=new Float32Array(w*h);const gy=new Float32Array(w*h);for(let y=1;y<h-1;y++){for(let x=1;x<w-1;x++){const tl=gray[(y-1)*w+(x-1)],tc=gray[(y-1)*w+x],tr=gray[(y-1)*w+(x+1)];const ml=gray[y*w+(x-1)],mr=gray[y*w+(x+1)];const bl=gray[(y+1)*w+(x-1)],bc=gray[(y+1)*w+x],br=gray[(y+1)*w+(x+1)];gx[y*w+x]=-tl-2*ml-bl+tr+2*mr+br;gy[y*w+x]=-tl-2*tc-tr+bl+2*bc+br;}}return{gx,gy};}

function harrisResponse(gx,gy,w,h,k){k=k===undefined?0.05:k;const R=new Float32Array(w*h);const win=3;for(let y=win;y<h-win;y++){for(let x=win;x<w-win;x++){let Ixx=0,Iyy=0,Ixy=0;for(let wy=-win;wy<=win;wy++){for(let wx=-win;wx<=win;wx++){const i=(y+wy)*w+(x+wx);Ixx+=gx[i]*gx[i];Iyy+=gy[i]*gy[i];Ixy+=gx[i]*gy[i];}}const det=Ixx*Iyy-Ixy*Ixy;const trace=Ixx+Iyy;R[y*w+x]=det-k*trace*trace;}}return R;}

function nonMaxSuppression(R,w,h,win){win=win===undefined?10:win;let maxR=0;for(let i=0;i<R.length;i++)if(R[i]>maxR)maxR=R[i];const threshold=maxR*0.01;const corners=[];for(let y=win;y<h-win;y++){for(let x=win;x<w-win;x++){const r=R[y*w+x];if(r<threshold)continue;let isMax=true;outer:for(let wy=-win;wy<=win;wy++){for(let wx=-win;wx<=win;wx++){if(wy===0&&wx===0)continue;if(R[(y+wy)*w+(x+wx)]>=r){isMax=false;break outer;}}}if(isMax){corners.push({x,y,confidence:Math.min(1,r/(maxR*0.1)),nx:x/w,ny:y/h});}}}return corners;}

function detectLines(gx,gy,w,h){const mag=new Float32Array(w*h);let maxMag=0;for(let i=0;i<w*h;i++){mag[i]=Math.sqrt(gx[i]*gx[i]+gy[i]*gy[i]);if(mag[i]>maxMag)maxMag=mag[i];}const threshold=maxMag*0.15;const lines=[];for(let y=0;y<h;y+=4){let s=-1;for(let x=0;x<w;x++){if(mag[y*w+x]>threshold){if(s===-1)s=x;}else{if(s!==-1&&x-s>30)lines.push({x1:s,y1:y,x2:x-1,y2:y,angle:0,length:x-1-s});s=-1;}}}for(let x=0;x<w;x+=4){let s=-1;for(let y=0;y<h;y++){if(mag[y*w+x]>threshold){if(s===-1)s=y;}else{if(s!==-1&&y-s>30)lines.push({x1:x,y1:s,x2:x,y2:y-1,angle:90,length:y-1-s});s=-1;}}}return lines;}

function findIntersections(lines,imgW,imgH){const hLines=lines.filter(function(l){return l.angle===0;});const vLines=lines.filter(function(l){return l.angle===90;});const result=[];for(var hi=0;hi<hLines.length;hi++){var hl=hLines[hi];for(var vi=0;vi<vLines.length;vi++){var vl=vLines[vi];var ix=vl.x1,iy=hl.y1;if(ix>=Math.min(hl.x1,hl.x2)&&ix<=Math.max(hl.x1,hl.x2)&&iy>=Math.min(vl.y1,vl.y2)&&iy<=Math.max(vl.y1,vl.y2)){var tooClose=result.some(function(r){return Math.hypot(r.x-ix,r.y-iy)<20;});if(!tooClose)result.push({x:ix,y:iy,confidence:1.0,nx:ix/imgW,ny:iy/imgH});}}}return result;}

// ─── Wall detection helpers ──────────────────────────────────────────────────
// Strategy:
//   1. Build an edge-magnitude map from the Sobel gradients.
//   2. Scan horizontal and vertical scanlines (denser than generic line detect).
//   3. Keep only LONG, strong runs — these are structural walls.
//   4. Merge nearby parallel runs into single wall segments.
//   5. Find intersections between H-wall and V-wall segments → wall corners.

function detectWallLines(gx,gy,w,h,imgW,imgH){
  // Build magnitude map
  var mag=new Float32Array(w*h);
  var maxMag=0;
  for(var i=0;i<w*h;i++){
    mag[i]=Math.sqrt(gx[i]*gx[i]+gy[i]*gy[i]);
    if(mag[i]>maxMag)maxMag=mag[i];
  }

  // Walls need a stronger, longer edge than generic lines
  // minLength: at least 8% of the dimension; threshold: top 20% of magnitude
  var hThresh = maxMag * 0.20;
  var vThresh = maxMag * 0.20;
  var minHLen = Math.floor(w * 0.08);
  var minVLen = Math.floor(h * 0.08);

  var rawH=[], rawV=[];

  // Horizontal scan (every 2px for better coverage)
  for(var y=2;y<h-2;y+=2){
    var s=-1;
    for(var x=0;x<w;x++){
      if(mag[y*w+x]>hThresh){
        if(s===-1)s=x;
      } else {
        if(s!==-1){
          var len=x-1-s;
          if(len>=minHLen) rawH.push({x1:s,y1:y,x2:x-1,y2:y,length:len});
          s=-1;
        }
      }
    }
    if(s!==-1){var len=w-1-s;if(len>=minHLen)rawH.push({x1:s,y1:y,x2:w-1,y2:y,length:len});}
  }

  // Vertical scan (every 2px)
  for(var x=2;x<w-2;x+=2){
    var s=-1;
    for(var y=0;y<h;y++){
      if(mag[y*w+x]>vThresh){
        if(s===-1)s=y;
      } else {
        if(s!==-1){
          var len=y-1-s;
          if(len>=minVLen) rawV.push({x1:x,y1:s,x2:x,y2:y-1,length:len});
          s=-1;
        }
      }
    }
    if(s!==-1){var len=h-1-s;if(len>=minVLen)rawV.push({x1:x,y1:s,x2:x,y2:h-1,length:len});}
  }

  // Merge nearby parallel segments: group by coordinate band (±BAND pixels)
  var BAND=6;

  function mergeGroup(group,isHorizontal){
    // For H lines: group by y; pick the span that covers the most x range
    // For V lines: group by x; pick the span that covers the most y range
    if(group.length===0)return null;
    var coord=isHorizontal
      ? Math.round(group.reduce(function(s,l){return s+l.y1;},0)/group.length)
      : Math.round(group.reduce(function(s,l){return s+l.x1;},0)/group.length);
    var mn=Infinity,mx=-Infinity;
    group.forEach(function(l){
      var a=isHorizontal?l.x1:l.y1;
      var b=isHorizontal?l.x2:l.y2;
      if(a<mn)mn=a;if(b>mx)mx=b;
    });
    var len=mx-mn;
    if(isHorizontal){
      return{x1:mn,y1:coord,x2:mx,y2:coord,angle:0,length:len,nx1:mn/imgW,ny1:coord/imgH,nx2:mx/imgW,ny2:coord/imgH};
    } else {
      return{x1:coord,y1:mn,x2:coord,y2:mx,angle:90,length:len,nx1:coord/imgW,ny1:mn/imgH,nx2:coord/imgW,ny2:mx/imgH};
    }
  }

  function clusterAndMerge(raw,isHorizontal,minFinalLen){
    // Sort by primary coord
    raw.sort(function(a,b){return (isHorizontal?a.y1:a.x1)-(isHorizontal?b.y1:b.x1);});
    var merged=[];
    var i=0;
    while(i<raw.length){
      var group=[raw[i]];
      var coord=isHorizontal?raw[i].y1:raw[i].x1;
      var j=i+1;
      while(j<raw.length){
        var c2=isHorizontal?raw[j].y1:raw[j].x1;
        if(Math.abs(c2-coord)<=BAND){group.push(raw[j]);j++;}
        else break;
      }
      var seg=mergeGroup(group,isHorizontal);
      if(seg&&seg.length>=minFinalLen)merged.push(seg);
      i=j;
    }
    return merged;
  }

  var minFinalH=Math.floor(w*0.12);
  var minFinalV=Math.floor(h*0.12);
  var wallH=clusterAndMerge(rawH,true,minFinalH);
  var wallV=clusterAndMerge(rawV,false,minFinalV);

  return{wallH:wallH,wallV:wallV};
}

function findWallCorners(wallH,wallV,imgW,imgH){
  var corners=[];
  var SNAP=12; // px tolerance for T/L intersections
  for(var hi=0;hi<wallH.length;hi++){
    var hl=wallH[hi];
    for(var vi=0;vi<wallV.length;vi++){
      var vl=wallV[vi];
      var ix=vl.x1;
      var iy=hl.y1;
      // Check if ix falls on horizontal segment and iy falls on vertical segment
      var onH=(ix>=Math.min(hl.x1,hl.x2)-SNAP && ix<=Math.max(hl.x1,hl.x2)+SNAP);
      var onV=(iy>=Math.min(vl.y1,vl.y2)-SNAP && iy<=Math.max(vl.y1,vl.y2)+SNAP);
      if(onH&&onV){
        var tooClose=corners.some(function(c){return Math.hypot(c.x-ix,c.y-iy)<18;});
        if(!tooClose){
          // Confidence: longer wall lines = more confident corner
          var conf=Math.min(1,(hl.length+vl.length)/(imgW+imgH)*2);
          corners.push({x:ix,y:iy,confidence:conf,nx:ix/imgW,ny:iy/imgH,lineIndices:[hi,vi]});
        }
      }
    }
  }
  return corners;
}

self.onmessage=function(e){
  var data=e.data;
  var imageData=data.imageData;
  var pageIndex=data.pageIndex;
  var width=data.width;
  var height=data.height;
  try{
    self.postMessage({type:'progress',pageIndex:pageIndex,step:'blurring'});
    var blurred=gaussianBlur(imageData.data,width,height);

    self.postMessage({type:'progress',pageIndex:pageIndex,step:'gradients'});
    var grads=sobelGradients(blurred,width,height);

    self.postMessage({type:'progress',pageIndex:pageIndex,step:'harris'});
    var R=harrisResponse(grads.gx,grads.gy,width,height);

    self.postMessage({type:'progress',pageIndex:pageIndex,step:'suppression'});
    var corners=nonMaxSuppression(R,width,height);

    self.postMessage({type:'progress',pageIndex:pageIndex,step:'lines'});
    var lines=detectLines(grads.gx,grads.gy,width,height);
    var intersections=findIntersections(lines,width,height);

    self.postMessage({type:'progress',pageIndex:pageIndex,step:'walls'});
    var wallResult=detectWallLines(grads.gx,grads.gy,width,height,width,height);
    var wallLines=wallResult.wallH.concat(wallResult.wallV);
    var wallCorners=findWallCorners(wallResult.wallH,wallResult.wallV,width,height);

    var mergedCorners=intersections.slice();
    for(var i=0;i<corners.length;i++){
      var c=corners[i];
      var nearInt=intersections.some(function(pt){return Math.hypot(pt.x-c.x,pt.y-c.y)<15;});
      if(!nearInt)mergedCorners.push(c);
    }

    self.postMessage({
      type:'result',
      result:{
        pageIndex:pageIndex,
        corners:mergedCorners.sort(function(a,b){return b.confidence-a.confidence;}).slice(0,2000),
        lines:lines,
        intersections:intersections,
        width:width,
        height:height,
        // ── NEW wall-specific outputs ──
        wallLines:wallLines,
        wallCorners:wallCorners.sort(function(a,b){return b.confidence-a.confidence;}),
      }
    });
  }catch(err){
    self.postMessage({type:'error',pageIndex:pageIndex,error:String(err)});
  }
};
`;
}

// ─── Session cache (module-level, survives re-renders) ────────────────────────

const sessionCache = new Map<string, Map<number, ExtractionResult>>();

function fileHash(file: File): string {
  return `${file.name}_${file.size}_${file.lastModified}`;
}

function makeEmptyPageState(): PageExtractionState {
  return {
    status: 'idle',
    corners: [],
    lines: [],
    intersections: [],
    width: 0,
    height: 0,
    wallLines: [],
    wallCorners: [],
  };
}

// ─── Hook params ──────────────────────────────────────────────────────────────

export interface UseSnapEngineParams {
  pinCanvasRef: React.RefObject<HTMLCanvasElement>;
  pdfDimensionsRef: React.MutableRefObject<PdfDimensions | null>;
  pageNumberRef: React.MutableRefObject<number>;
  snapEnabled: boolean;
  showPins: boolean;
  snapThreshold: number;
  confidenceFilter: number;
}

// ─── Hook return ──────────────────────────────────────────────────────────────

export interface UseSnapEngineReturn {
  // State
  pageData: Map<number, PageExtractionState>;
  analysisStatus: 'idle' | 'analyzing' | 'done';
  analysisPage: { current: number; total: number } | null;
  snapFlashes: SnapFlash[];
  // Callbacks
  startExtraction: (pdf: pdfjsLib.PDFDocumentProxy, file?: File) => void;
  getScaledCorners: (pageIdx: number) => Array<{ x: number; y: number; confidence: number }>;
  /** Wall corners in canvas-pixel space for the given page */
  getScaledWallCorners: (pageIdx: number) => Array<{ x: number; y: number; confidence: number; lineIndices: number[] }>;
  /** Wall lines in canvas-pixel space for the given page */
  getScaledWallLines: (pageIdx: number) => Array<{
    x1: number; y1: number; x2: number; y2: number;
    angle: number; length: number;
  }>;
  snapToCorner: (rawX: number, rawY: number) => SnapResult;
  triggerSnapFlash: (x: number, y: number) => void;
  redrawPinCanvas: () => void;
  // Refs callers can write to drive pin rendering
  cursorPointRef: React.MutableRefObject<{ x: number; y: number } | null>;
}

// ─── useSnapEngine ────────────────────────────────────────────────────────────

export function useSnapEngine({
  pinCanvasRef,
  pdfDimensionsRef,
  pageNumberRef,
  snapEnabled,
  showPins,
  snapThreshold,
  confidenceFilter,
}: UseSnapEngineParams): UseSnapEngineReturn {

  // ── Stable refs for settings (avoid stale closures in callbacks) ────────────
  const snapEnabledRef      = useRef(snapEnabled);
  const showPinsRef         = useRef(showPins);
  const snapThresholdRef    = useRef(snapThreshold);
  const confidenceFilterRef = useRef(confidenceFilter);
  useEffect(() => { snapEnabledRef.current      = snapEnabled;      }, [snapEnabled]);
  useEffect(() => { showPinsRef.current         = showPins;         }, [showPins]);
  useEffect(() => { snapThresholdRef.current    = snapThreshold;    }, [snapThreshold]);
  useEffect(() => { confidenceFilterRef.current = confidenceFilter; }, [confidenceFilter]);

  // ── State ───────────────────────────────────────────────────────────────────
  const [pageData, setPageData]             = useState<Map<number, PageExtractionState>>(new Map());
  const [analysisStatus, setAnalysisStatus] = useState<'idle' | 'analyzing' | 'done'>('idle');
  const [analysisPage, setAnalysisPage]     = useState<{ current: number; total: number } | null>(null);
  const [snapFlashes, setSnapFlashes]       = useState<SnapFlash[]>([]);

  // ── Internal refs ───────────────────────────────────────────────────────────
  const workerRef          = useRef<Worker | null>(null);
  const extractionQueueRef = useRef<Array<{ pageIndex: number; pdf: any; cacheKey: string }>>([]);
  const extractingRef      = useRef(false);
  const cacheKeyRef        = useRef('');
  const flashIdRef         = useRef(0);
  const pageDataRef        = useRef(pageData);
  useEffect(() => { pageDataRef.current = pageData; }, [pageData]);

  const cursorPointRef = useRef<{ x: number; y: number } | null>(null);

  // ── processExtractionQueue ──────────────────────────────────────────────────
  const processExtractionQueueRef = useRef<() => void>(() => {});

  const processExtractionQueue = useCallback(() => {
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
          wallLines: cached.wallLines ?? [],
          wallCorners: cached.wallCorners ?? [],
        });
        return next;
      });
      extractingRef.current = false;
      processExtractionQueueRef.current();
      return;
    }

    (async () => {
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
    })();
  }, []);

  useEffect(() => { processExtractionQueueRef.current = processExtractionQueue; }, [processExtractionQueue]);

  // ── Worker lifecycle ────────────────────────────────────────────────────────
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
        const result = msg.result;
        const key = cacheKeyRef.current;
        if (key) {
          if (!sessionCache.has(key)) sessionCache.set(key, new Map());
          sessionCache.get(key)!.set(result.pageIndex, result);
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
            wallLines: result.wallLines ?? [],
            wallCorners: result.wallCorners ?? [],
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

    return () => { workerRef.current?.terminate(); URL.revokeObjectURL(url); };
  }, []);

  // ── startExtraction ─────────────────────────────────────────────────────────
  const startExtraction = useCallback((pdfDoc: pdfjsLib.PDFDocumentProxy, file?: File) => {
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
          wallLines: (cached as any).wallLines ?? [],
          wallCorners: (cached as any).wallCorners ?? [],
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

  // ── getScaledCorners ─────────────────────────────────────────────────────────
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
    [pdfDimensionsRef],
  );

  // ── getScaledWallCorners — wall corners in canvas-pixel space ────────────────
  const getScaledWallCorners = useCallback(
    (pageIdx: number): Array<{ x: number; y: number; confidence: number; lineIndices: number[] }> => {
      const dims = pdfDimensionsRef.current;
      if (!dims) return [];
      const pg = pageDataRef.current.get(pageIdx - 1);
      if (!pg || pg.status !== 'done') return [];
      return (pg.wallCorners ?? []).map(c => ({
        x: c.nx * dims.w,
        y: c.ny * dims.h,
        confidence: c.confidence,
        lineIndices: c.lineIndices,
      }));
    },
    [pdfDimensionsRef],
  );

  // ── getScaledWallLines — wall lines in canvas-pixel space ────────────────────
  const getScaledWallLines = useCallback(
    (pageIdx: number): Array<{ x1: number; y1: number; x2: number; y2: number; angle: number; length: number }> => {
      const dims = pdfDimensionsRef.current;
      if (!dims) return [];
      const pg = pageDataRef.current.get(pageIdx - 1);
      if (!pg || pg.status !== 'done') return [];
      return (pg.wallLines ?? []).map(l => ({
        x1: l.nx1 * dims.w,
        y1: l.ny1 * dims.h,
        x2: l.nx2 * dims.w,
        y2: l.ny2 * dims.h,
        angle: l.angle,
        length: l.length,
      }));
    },
    [pdfDimensionsRef],
  );

  // ── snapToCorner — snaps to wall corners first, then generic corners ─────────
  const snapToCorner = useCallback((rawX: number, rawY: number): SnapResult => {
    if (!snapEnabledRef.current || !pdfDimensionsRef.current) {
      return { point: { x: rawX, y: rawY }, snapped: false };
    }

    // Prefer wall corners (structural) over generic Harris corners
    const wallCorners = getScaledWallCorners(pageNumberRef.current);
    let bestCorner: { x: number; y: number } | null = null;
    let bestDist = snapThresholdRef.current;

    for (const c of wallCorners) {
      const dist = Math.hypot(rawX - c.x, rawY - c.y);
      if (dist < bestDist) { bestDist = dist; bestCorner = c; }
    }

    // Fall back to generic corners if no wall corner close enough
    if (!bestCorner) {
      const corners = getScaledCorners(pageNumberRef.current);
      for (const c of corners) {
        const dist = Math.hypot(rawX - c.x, rawY - c.y);
        if (dist < bestDist) { bestDist = dist; bestCorner = c; }
      }
    }

    return bestCorner
      ? { point: { x: bestCorner.x, y: bestCorner.y }, snapped: true }
      : { point: { x: rawX, y: rawY }, snapped: false };
  }, [getScaledWallCorners, getScaledCorners, pdfDimensionsRef, pageNumberRef]);

  // ── triggerSnapFlash ─────────────────────────────────────────────────────────
  const triggerSnapFlash = useCallback((x: number, y: number) => {
    const id = ++flashIdRef.current;
    setSnapFlashes(prev => [...prev, { x, y, id }]);
    setTimeout(() => setSnapFlashes(prev => prev.filter(f => f.id !== id)), 700);
  }, []);

  // ── redrawPinCanvas ──────────────────────────────────────────────────────────
  // Draws wall lines (green) + wall corners (teal) near cursor,
  // plus generic corners (blue) as fallback.
  const redrawPinCanvas = useCallback(() => {
    const canvas = pinCanvasRef.current;
    if (!canvas || !pdfDimensionsRef.current) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!showPinsRef.current) return;

    const cursor     = cursorPointRef.current;
    const thresh     = snapThresholdRef.current;
    const VISIBLE_R  = thresh * 4;

    // ── Draw wall lines near cursor ───────────────────────────────────────────
    const wallLines = getScaledWallLines(pageNumberRef.current);
    for (const l of wallLines) {
      // Distance from cursor to line segment mid-point (cheap approximation)
      if (!cursor) break;
      const mx = (l.x1 + l.x2) / 2;
      const my = (l.y1 + l.y2) / 2;
      const dist = Math.hypot(cursor.x - mx, cursor.y - my);
      // Show wall lines within a wider radius so the user can see the structure
      if (dist > VISIBLE_R * 3) continue;
      const alpha = Math.max(0.08, 0.45 - dist / (VISIBLE_R * 3) * 0.37);
      ctx.beginPath();
      ctx.moveTo(l.x1, l.y1);
      ctx.lineTo(l.x2, l.y2);
      ctx.strokeStyle = `rgba(52, 211, 153, ${alpha})`; // emerald-400
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ── Draw wall corners near cursor ─────────────────────────────────────────
    const wallCorners = getScaledWallCorners(pageNumberRef.current);
    for (const c of wallCorners) {
      if (!cursor) break;
      const dist     = Math.hypot(cursor.x - c.x, cursor.y - c.y);
      const isInSnap = dist < thresh;
      if (dist > VISIBLE_R) continue;

      const proximity = 1 - Math.min(1, Math.max(0, (dist - thresh) / (VISIBLE_R - thresh)));

      ctx.beginPath();
      if (isInSnap) {
        // Highlighted snap ring — teal for wall corners
        ctx.arc(c.x, c.y, 8, 0, Math.PI * 2);
        ctx.fillStyle   = '#14B8A6'; // teal-500
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth   = 2;
        ctx.stroke();
        // Cross-hair lines to reinforce the corner
        ctx.beginPath();
        ctx.moveTo(c.x - 12, c.y); ctx.lineTo(c.x + 12, c.y);
        ctx.moveTo(c.x, c.y - 12); ctx.lineTo(c.x, c.y + 12);
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth   = 1;
        ctx.stroke();
      } else {
        const alpha = 0.30 + proximity * 0.65;
        ctx.arc(c.x, c.y, 5, 0, Math.PI * 2);
        ctx.fillStyle   = `rgba(20, 184, 166, ${alpha * 0.6})`; // teal
        ctx.fill();
        ctx.strokeStyle = `rgba(20, 184, 166, ${alpha})`;
        ctx.lineWidth   = 1.5;
        ctx.stroke();
      }
    }

    // ── Draw generic corners (blue) — only if no wall corner is nearby ────────
    const corners = getScaledCorners(pageNumberRef.current);
    for (const c of corners) {
      if (!cursor) break;
      const dist     = Math.hypot(cursor.x - c.x, cursor.y - c.y);
      const isInSnap = dist < thresh;
      if (dist > VISIBLE_R) continue;

      // Skip if a wall corner is already drawn close by
      const nearWall = wallCorners.some(wc => Math.hypot(wc.x - c.x, wc.y - c.y) < thresh);
      if (nearWall) continue;

      const proximity = 1 - Math.min(1, Math.max(0, (dist - thresh) / (VISIBLE_R - thresh)));

      ctx.beginPath();
      if (isInSnap) {
        ctx.arc(c.x, c.y, 7, 0, Math.PI * 2);
        ctx.fillStyle   = '#F59E0B'; // amber
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth   = 1.5;
        ctx.stroke();
      } else {
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
  }, [pinCanvasRef, pdfDimensionsRef, pageNumberRef, getScaledCorners, getScaledWallCorners, getScaledWallLines]);

  // Redraw whenever page or settings change
  useEffect(() => {
    redrawPinCanvas();
  }, [redrawPinCanvas, pageData, showPins, snapThreshold, confidenceFilter]);

  return {
    pageData,
    analysisStatus,
    analysisPage,
    snapFlashes,
    startExtraction,
    getScaledCorners,
    getScaledWallCorners,
    getScaledWallLines,
    snapToCorner,
    triggerSnapFlash,
    redrawPinCanvas,
    cursorPointRef,
  };
}
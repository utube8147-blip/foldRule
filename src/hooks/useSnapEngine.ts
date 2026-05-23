// ─── hooks/useSnapEngine/useSnapEngine.tsx ────────────────────────────────────
//
// INLINE WORKER VERSION  (with optional debug instrumentation)
//
// Toggle SNAP_WORKER_DEBUG = true to activate the instrumented worker.
// The debug worker renders a live HUD on the OffscreenCanvas and posts
// 'debug_stats' messages to the main thread every second.
// Set back to false for production — zero overhead.
//
// PERF FIX — reference-guarded data effect:
//
//   Previously there were two separate useEffect blocks that both depended on
//   svgSnapPoints / svgLines / svgCurves / svgAreas:
//     1. Grid rebuild  (main-thread candidatesCache + spatialGrid)
//     2. Worker data forward  (postMessage with full serialized payload)
//
//   Both fired on every zoom tick because Viewer.tsx re-renders on scale state
//   change and React treats every render's local variable as a potential new
//   reference. Even though useSvgSnapPoints memos correctly, the zoom-triggered
//   re-render was enough to cause React to re-run those effects.
//
//   Fix: a single consolidated effect with a strict reference-equality guard.
//   If all four array props are the same object references as last time, the
//   effect body returns immediately (0ms). The expensive grid build and the
//   25-second structured-clone postMessage only happen when data genuinely
//   changes — i.e. when the SVG is first loaded or the PDF page changes.
//
//   The transform effect (zoom / pan) is kept separate and lightweight — it
//   only posts 3 numbers and is the only effect that fires on zoom.
//
// ─────────────────────────────────────────────────────────────────────────────

import { useRef, useState, useCallback, useEffect } from 'react';
import type { SvgSnapPoint, SvgCurve } from '@/hooks/useSvgSnapPoints';
import type { SvgLine, SvgArea } from '@/hooks/useSvgInteraction';

type PdfDimensions        = { w: number; h: number };
type ExtractionResult     = any;
type PageExtractionState  = any;
type SnapFlash            = { x: number; y: number; id: number };
type SnapResult           = { point: { x: number; y: number }; snapped: boolean };

export type {
  ExtractionResult, PageExtractionState,
  SnapFlash, SnapResult, PdfDimensions,
};

export interface LinearChainPoint {
  x: number; y: number; type: string; label?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
//  TOGGLE THIS to enable the debug worker
// ─────────────────────────────────────────────────────────────────────────────
const SNAP_WORKER_DEBUG = true;

// ── Shared worker body (shared between production and debug variants) ─────────
//
// The production worker is PROD_WORKER_SOURCE.
// The debug worker is DEBUG_WORKER_SOURCE — it wraps every draw section with
// performance.now() timers, renders a live on-canvas HUD, and posts
// 'debug_stats' messages to the main thread every second so you can
// console.log them or display them in your UI.

const PROD_WORKER_SOURCE = /* js */`
// ── State ─────────────────────────────────────────────────────────────────────
let canvas = null, ctx = null;
let dims = { w: 1, h: 1 }, dpr = 1, vpW = 800, vpH = 600;
let zoom = 1, panX = 0, panY = 0;
let cursorX = null, cursorY = null;
let snapPoints = [], svgLines = [], svgCurves = [], svgAreas = [];
let candidatesCache = [], spatialGrid = null;
let eligibleLinesCache = [], eligibleAreasCache = [], eligibleCurvesCache = [];
let snapThreshold = 14, proximityRadius = 80, showPins = true, activeTool = 'linear';
let rafHandle = null;

const SVG_SNAP_COLOURS = {
  endpoint:     { dot:'rgba(245,158,11,0.85)', ring:'rgba(245,158,11,0.5)',  fill:'#f59e0b' },
  midpoint:     { dot:'rgba(16,185,129,0.85)', ring:'rgba(16,185,129,0.5)',  fill:'#10b981' },
  centroid:     { dot:'rgba(139,92,246,0.85)', ring:'rgba(139,92,246,0.5)',  fill:'#8b5cf6' },
  intersection: { dot:'rgba(244,63,94,0.85)',  ring:'rgba(244,63,94,0.5)',   fill:'#f43f5e' },
  'arc-center': { dot:'rgba(34,211,238,0.90)', ring:'rgba(34,211,238,0.45)',fill:'#22d3ee' },
};
const SNAP_PRIORITY = { endpoint:0, intersection:1, midpoint:2, centroid:3 };
const SNAP_SIZE     = { intersection:1.0, endpoint:1.0, midpoint:0.85, centroid:0.85 };
const LINE_COLOUR  = { base:'rgba(56,189,248,{a})',  fill:'#38bdf8' };
const CURVE_COLOUR = { base:'rgba(56,189,248,{a})',  fill:'#38bdf8' };
const AREA_COLOUR  = { stroke:'rgba(251,146,60,{a})',fill:'#fb923c' };

function withAlpha(t,a){ return t.replace('{a}',a.toFixed(2)); }
function isDoorOrSwing(s){ const v=(s??'').toLowerCase(); return v.includes('door')||v.includes('swing'); }
function pdfXtoC(x){ return (x*zoom+panX)*dpr; }
function pdfYtoC(y){ return (y*zoom+panY)*dpr; }

function buildGrid(cands, cellSize){
  const cells=new Map();
  for(const c of cands){
    const key=Math.floor(c.x/cellSize)+','+Math.floor(c.y/cellSize);
    let b=cells.get(key); if(!b){b=[];cells.set(key,b);} b.push(c);
  }
  return {cells,cellSize};
}
function queryGrid(grid,x,y,radius){
  const {cells,cellSize}=grid, r=Math.ceil(radius/cellSize),
    cx=Math.floor(x/cellSize), cy=Math.floor(y/cellSize), out=[];
  for(let dx=-r;dx<=r;dx++) for(let dy=-r;dy<=r;dy++){
    const b=cells.get((cx+dx)+','+(cy+dy)); if(b) out.push(...b);
  }
  return out;
}
function rebuildCandidates(){
  candidatesCache=snapPoints.map(p=>({x:p.nx*dims.w,y:p.ny*dims.h,type:p.type,strokeWidth:p.strokeWidth,shapeId:p.shapeId}));
  spatialGrid=buildGrid(candidatesCache,proximityRadius);
}
function rebuildEligibleCaches(){
  eligibleLinesCache=svgLines.filter(l=>!isDoorOrSwing(l.shapeId));
  eligibleAreasCache=svgAreas.filter(a=>a.points.length>=3&&a.label!=='door'&&!a.isDoor);
  eligibleCurvesCache=svgCurves;
}
function resizeCanvas(){
  if(!canvas) return;
  const tw=Math.round(vpW*dpr),th=Math.round(vpH*dpr);
  if(canvas.width!==tw||canvas.height!==th){canvas.width=tw;canvas.height=th;}
}

function draw(){
  rafHandle=null;
  if(!canvas||!ctx) return;
  const shouldDraw=showPins&&activeTool!=='select'&&cursorX!==null&&cursorY!==null;
  resizeCanvas();
  ctx.clearRect(0,0,canvas.width,canvas.height);
  if(!shouldDraw) return;

  const prox=proximityRadius, thresh=snapThreshold, W=canvas.width, H=canvas.height;
  const cxPx=(cursorX*zoom+panX)*dpr, cyPx=(cursorY*zoom+panY)*dpr, proxPx=prox*dpr;
  const pdfMinX=(-panX)/zoom, pdfMinY=(-panY)/zoom;
  const pdfMaxX=(W/dpr-panX)/zoom, pdfMaxY=(H/dpr-panY)/zoom;
  const proxPdf=prox/zoom;
  const cullMinX=pdfMinX-proxPdf,cullMinY=pdfMinY-proxPdf;
  const cullMaxX=pdfMaxX+proxPdf,cullMaxY=pdfMaxY+proxPdf;

  // 1. Curves
  for(let ci=0;ci<eligibleCurvesCache.length;ci++){
    const cv=eligibleCurvesCache[ci];
    const ex1=cv.nx1*dims.w,ey1=cv.ny1*dims.h,ex2=cv.nx2*dims.w,ey2=cv.ny2*dims.h;
    if(Math.max(ex1,ex2)<cullMinX||Math.min(ex1,ex2)>cullMaxX||Math.max(ey1,ey2)<cullMinY||Math.min(ey1,ey2)>cullMaxY) continue;
    const p0x=pdfXtoC(ex1),p0y=pdfYtoC(ey1),p1x=pdfXtoC(cv.ncp1x*dims.w),p1y=pdfYtoC(cv.ncp1y*dims.h);
    const p3x=pdfXtoC(ex2),p3y=pdfYtoC(ey2);
    const isCubic=cv.type==='cubic'&&cv.ncp2x!==undefined;
    const p2x=isCubic?pdfXtoC(cv.ncp2x*dims.w):0, p2y=isCubic?pdfYtoC(cv.ncp2y*dims.h):0;
    let minD=Infinity;
    for(let i=0;i<=16;i++){
      const t=i/16,u=1-t;
      const ptx=isCubic?u*u*u*p0x+3*u*u*t*p1x+3*u*t*t*p2x+t*t*t*p3x:u*u*p0x+2*u*t*p1x+t*t*p3x;
      const pty=isCubic?u*u*u*p0y+3*u*u*t*p1y+3*u*t*t*p2y+t*t*t*p3y:u*u*p0y+2*u*t*p1y+t*t*p3y;
      const d=Math.hypot(cxPx-ptx,cyPx-pty); if(d<minD) minD=d;
    }
    if(minD>proxPx) continue;
    const fade=Math.max(0,1-minD/proxPx),alpha=0.10+fade*0.60;
    ctx.save(); ctx.beginPath(); ctx.moveTo(p0x,p0y);
    if(isCubic) ctx.bezierCurveTo(p1x,p1y,p2x,p2y,p3x,p3y);
    else ctx.quadraticCurveTo(p1x,p1y,p3x,p3y);
    ctx.strokeStyle=withAlpha(CURVE_COLOUR.base,alpha); ctx.lineWidth=(0.5+fade*1.5)*dpr; ctx.stroke(); ctx.restore();
  }

  // 2. Lines — single pass
  let nearestLineIdx=-1, nearestLineDist=prox, nearestLineSnapX=0, nearestLineSnapY=0;
  const lineDrawCache=[];
  for(let li=0;li<eligibleLinesCache.length;li++){
    const line=eligibleLinesCache[li];
    const x1p=line.nx1*dims.w,y1p=line.ny1*dims.h,x2p=line.nx2*dims.w,y2p=line.ny2*dims.h;
    if(Math.max(x1p,x2p)<cullMinX||Math.min(x1p,x2p)>cullMaxX||Math.max(y1p,y2p)<cullMinY||Math.min(y1p,y2p)>cullMaxY) continue;
    const c1x=pdfXtoC(x1p),c1y=pdfYtoC(y1p),c2x=pdfXtoC(x2p),c2y=pdfYtoC(y2p);
    const ax=cxPx-c1x,ay=cyPx-c1y,bx=c2x-c1x,by=c2y-c1y,len2=bx*bx+by*by;
    let cpx,cpy;
    if(len2===0){cpx=c1x;cpy=c1y;}else{const t=Math.max(0,Math.min(1,(ax*bx+ay*by)/len2));cpx=c1x+t*bx;cpy=c1y+t*by;}
    const distPx=Math.hypot(cxPx-cpx,cyPx-cpy), distCSS=distPx/dpr;
    if(distPx>proxPx) continue;
    lineDrawCache.push({c1x,c1y,c2x,c2y,cpx,cpy,dist:distCSS,idx:li});
    if(distCSS<nearestLineDist){nearestLineDist=distCSS;nearestLineIdx=li;nearestLineSnapX=cpx;nearestLineSnapY=cpy;}
  }
  for(let di=0;di<lineDrawCache.length;di++){
    const {c1x,c1y,c2x,c2y,dist,idx}=lineDrawCache[di];
    const isN=idx===nearestLineIdx, isSnap=isN&&dist<thresh;
    const ra=1-dist/prox, la=isN?ra:ra*0.25, lw=isSnap?2.0:isN?1.2:0.6;
    ctx.save(); ctx.beginPath(); ctx.moveTo(c1x,c1y); ctx.lineTo(c2x,c2y);
    ctx.strokeStyle=withAlpha(LINE_COLOUR.base,la); ctx.lineWidth=lw*dpr;
    if(!isSnap&&isN) ctx.setLineDash([6*dpr,4*dpr]);
    ctx.stroke(); ctx.setLineDash([]);
    if(isSnap){
      ctx.beginPath(); ctx.arc(nearestLineSnapX,nearestLineSnapY,5*dpr,0,Math.PI*2);
      ctx.fillStyle=LINE_COLOUR.fill; ctx.fill(); ctx.strokeStyle='white'; ctx.lineWidth=1.5*dpr; ctx.stroke();
    }
    ctx.restore();
  }

  // 3. Areas
  for(let ai=0;ai<eligibleAreasCache.length;ai++){
    const area=eligibleAreasCache[ai], b=area.bounds;
    if(b.maxNX*dims.w<cullMinX||b.minNX*dims.w>cullMaxX||b.maxNY*dims.h<cullMinY||b.minNY*dims.h>cullMaxY) continue;
    const pts=area.points, n=pts.length;
    let distEdge=Infinity, snapPtX=0, snapPtY=0;
    for(let i=0;i<n;i++){
      const j=(i+1)%n;
      const ix=pdfXtoC(pts[i].nx*dims.w),iy=pdfYtoC(pts[i].ny*dims.h);
      const jx=pdfXtoC(pts[j].nx*dims.w),jy=pdfYtoC(pts[j].ny*dims.h);
      const ax=cxPx-ix,ay=cyPx-iy,bx2=jx-ix,by2=jy-iy,len2=bx2*bx2+by2*by2;
      let cpx,cpy;
      if(len2===0){cpx=ix;cpy=iy;}else{const t=Math.max(0,Math.min(1,(ax*bx2+ay*by2)/len2));cpx=ix+t*bx2;cpy=iy+t*by2;}
      const d=Math.hypot(cxPx-cpx,cyPx-cpy)/dpr;
      if(d<distEdge){distEdge=d;snapPtX=cpx;snapPtY=cpy;}
    }
    if(distEdge>prox*2) continue;
    const isSnap=distEdge<thresh,fade=Math.max(0,1-distEdge/(prox*2)),alpha=isSnap?0.90:0.15+fade*0.55;
    ctx.save(); ctx.beginPath(); ctx.moveTo(pdfXtoC(pts[0].nx*dims.w),pdfYtoC(pts[0].ny*dims.h));
    for(let i=1;i<n;i++) ctx.lineTo(pdfXtoC(pts[i].nx*dims.w),pdfYtoC(pts[i].ny*dims.h));
    ctx.closePath(); ctx.strokeStyle=withAlpha(AREA_COLOUR.stroke,alpha); ctx.lineWidth=(isSnap?2.0:0.5+fade*1.5)*dpr; ctx.stroke();
    if(isSnap){
      ctx.beginPath(); ctx.arc(snapPtX,snapPtY,5*dpr,0,Math.PI*2);
      ctx.fillStyle=AREA_COLOUR.fill; ctx.fill(); ctx.strokeStyle='white'; ctx.lineWidth=1.5*dpr; ctx.stroke();
    }
    ctx.restore();
  }

  // 4. Snap candidates
  const nearby=spatialGrid?queryGrid(spatialGrid,cursorX,cursorY,prox):candidatesCache;
  let nearestC=null, nearestCDist=Infinity;
  for(let ci=0;ci<nearby.length;ci++){
    const c=nearby[ci]; if(isDoorOrSwing(c.shapeId)) continue;
    const cpx=pdfXtoC(c.x),cpy=pdfYtoC(c.y),dist=Math.hypot(cxPx-cpx,cyPx-cpy)/dpr;
    if(dist>prox) continue;
    const pri=SNAP_PRIORITY[c.type]??99,nearPri=nearestC?(SNAP_PRIORITY[nearestC.type]??99):99;
    const tooClose=nearestC!==null&&Math.abs(dist-nearestCDist)<4;
    if(nearestC===null||(tooClose&&pri<nearPri)||(!tooClose&&dist<nearestCDist)){nearestCDist=dist;nearestC=c;}
  }
  if(nearestC){
    const c=nearestC,col=SVG_SNAP_COLOURS[c.type]??SVG_SNAP_COLOURS['endpoint'];
    const sm=SNAP_SIZE[c.type]??1.0,dist=nearestCDist,isSnap=dist<thresh;
    const fade=Math.max(0,1-dist/prox),cpx=pdfXtoC(c.x),cpy=pdfYtoC(c.y);
    ctx.save();
    if(isSnap){
      const r=7*dpr*sm,ch=11*dpr;
      ctx.beginPath();ctx.arc(cpx,cpy,r,0,Math.PI*2);ctx.fillStyle=col.fill;ctx.globalAlpha=0.25;ctx.fill();ctx.globalAlpha=1;
      ctx.beginPath();ctx.arc(cpx,cpy,r,0,Math.PI*2);ctx.fillStyle=col.fill;ctx.fill();ctx.strokeStyle='white';ctx.lineWidth=2*dpr;ctx.stroke();
      ctx.beginPath();ctx.moveTo(cpx-ch,cpy);ctx.lineTo(cpx+ch,cpy);ctx.moveTo(cpx,cpy-ch);ctx.lineTo(cpx,cpy+ch);
      ctx.strokeStyle='rgba(255,255,255,0.65)';ctx.lineWidth=1.5*dpr;ctx.stroke();
    }else{
      const sz=(2.5+fade*4.5)*dpr*sm,a=0.20+fade*0.65;
      ctx.strokeStyle=col.dot;ctx.globalAlpha=a;ctx.lineWidth=(0.8+fade*0.8)*dpr;
      ctx.beginPath();ctx.moveTo(cpx-sz,cpy);ctx.lineTo(cpx+sz,cpy);ctx.stroke();
      ctx.beginPath();ctx.moveTo(cpx,cpy-sz);ctx.lineTo(cpx,cpy+sz);ctx.stroke();
      if(fade>0.35){ctx.beginPath();ctx.arc(cpx,cpy,sz+4*dpr,0,Math.PI*2);ctx.strokeStyle=col.ring;ctx.globalAlpha=a*0.35;ctx.lineWidth=0.8*dpr;ctx.stroke();}
      ctx.globalAlpha=1;
    }
    ctx.restore();
  }

  // 5. Proximity circle
  if(nearestC!==null){
    ctx.save();ctx.beginPath();ctx.arc(cxPx,cyPx,proxPx,0,Math.PI*2);
    ctx.strokeStyle='rgba(100,100,100,0.08)';ctx.lineWidth=0.8*dpr;ctx.setLineDash([3*dpr,4*dpr]);ctx.stroke();ctx.setLineDash([]);ctx.restore();
  }
}

function requestDraw(){ if(rafHandle!==null) return; rafHandle=requestAnimationFrame(draw); }

self.onmessage=(e)=>{
  const msg=e.data;
  switch(msg.type){
    case 'init':{
      canvas=msg.canvas; ctx=canvas.getContext('2d');
      dims=msg.dims; dpr=msg.dpr??1; vpW=msg.vpW??800; vpH=msg.vpH??600;
      zoom=msg.zoom??1; panX=msg.panX??0; panY=msg.panY??0;
      snapThreshold=msg.snapThreshold??14; proximityRadius=msg.proximityRadius??80;
      showPins=msg.showPins??true; activeTool=msg.activeTool??'linear';
      snapPoints=msg.snapPoints??[]; svgLines=msg.svgLines??[]; svgCurves=msg.svgCurves??[]; svgAreas=msg.svgAreas??[];
      rebuildCandidates(); rebuildEligibleCaches(); resizeCanvas(); break;
    }
    case 'data':{
      snapPoints=msg.snapPoints??snapPoints; svgLines=msg.svgLines??svgLines;
      svgCurves=msg.svgCurves??svgCurves; svgAreas=msg.svgAreas??svgAreas;
      if(msg.dims) dims=msg.dims;
      rebuildCandidates(); rebuildEligibleCaches(); requestDraw(); break;
    }
    case 'transform':{ zoom=msg.zoom; panX=msg.panX; panY=msg.panY; requestDraw(); break; }
    case 'cursor':{ cursorX=msg.x; cursorY=msg.y; requestDraw(); break; }
    case 'cursor_leave':{ cursorX=null; cursorY=null; requestDraw(); break; }
    case 'settings':{
      if(msg.snapThreshold!==undefined) snapThreshold=msg.snapThreshold;
      if(msg.proximityRadius!==undefined){ proximityRadius=msg.proximityRadius; spatialGrid=buildGrid(candidatesCache,proximityRadius); }
      if(msg.showPins!==undefined) showPins=msg.showPins;
      if(msg.activeTool!==undefined) activeTool=msg.activeTool;
      requestDraw(); break;
    }
    case 'resize':{ vpW=msg.vpW; vpH=msg.vpH; if(msg.dpr!==undefined) dpr=msg.dpr; resizeCanvas(); requestDraw(); break; }
  }
};
`;

// ─────────────────────────────────────────────────────────────────────────────
//  DEBUG WORKER
//  Wraps every draw() phase with performance.now() timers.
//  Renders a live HUD directly on the OffscreenCanvas (top-left corner).
//  Posts 'debug_stats' to the main thread every second — listen with:
//
//    worker.onmessage = (e) => {
//      if (e.data.type === 'debug_stats') console.table(e.data);
//    };
// ─────────────────────────────────────────────────────────────────────────────

const DEBUG_WORKER_SOURCE = /* js */`
// ── State (same as prod) ──────────────────────────────────────────────────────
let canvas = null, ctx = null;
let dims = { w: 1, h: 1 }, dpr = 1, vpW = 800, vpH = 600;
let zoom = 1, panX = 0, panY = 0;
let cursorX = null, cursorY = null;
let snapPoints = [], svgLines = [], svgCurves = [], svgAreas = [];
let candidatesCache = [], spatialGrid = null;
let eligibleLinesCache = [], eligibleAreasCache = [], eligibleCurvesCache = [];
let snapThreshold = 14, proximityRadius = 80, showPins = true, activeTool = 'linear';
let rafHandle = null;

// ── Debug accumulators (reset every second) ───────────────────────────────────
let dbg = {
  frameCount: 0,
  msgCount:   0,
  drawMsSum:  0,
  phase: { curves: 0, lines: 0, areas: 0, candidates: 0 },
  counts: {
    curves: 0, curvesCulled: 0,
    lines: 0, linesCulled: 0, linesDrawn: 0,
    areas: 0, areasCulled: 0, areasDrawn: 0,
    candidates: 0,
  },
};
// Last reported stats (for HUD when no new frames)
let lastStats = null;

// Report + reset every second
setInterval(() => {
  const fc = dbg.frameCount || 1;
  const stats = {
    type:       'debug_stats',
    fps:         dbg.frameCount,
    msgPerSec:   dbg.msgCount,
    drawMs:      +(dbg.drawMsSum / fc).toFixed(3),
    phase: {
      curves:     +(dbg.phase.curves     / fc).toFixed(3),
      lines:      +(dbg.phase.lines      / fc).toFixed(3),
      areas:      +(dbg.phase.areas      / fc).toFixed(3),
      candidates: +(dbg.phase.candidates / fc).toFixed(3),
    },
    counts: { ...dbg.counts },
    state: { activeTool, showPins, zoom: +zoom.toFixed(3), proximityRadius, snapThreshold },
  };
  self.postMessage(stats);
  lastStats = stats;
  // Reset
  dbg = {
    frameCount: 0, msgCount: 0, drawMsSum: 0,
    phase: { curves:0, lines:0, areas:0, candidates:0 },
    counts: {
      curves:0, curvesCulled:0,
      lines:0, linesCulled:0, linesDrawn:0,
      areas:0, areasCulled:0, areasDrawn:0,
      candidates:0,
    },
  };
}, 1000);

// ── Colours / constants ───────────────────────────────────────────────────────
const SVG_SNAP_COLOURS = {
  endpoint:     { dot:'rgba(245,158,11,0.85)', ring:'rgba(245,158,11,0.5)',  fill:'#f59e0b' },
  midpoint:     { dot:'rgba(16,185,129,0.85)', ring:'rgba(16,185,129,0.5)',  fill:'#10b981' },
  centroid:     { dot:'rgba(139,92,246,0.85)', ring:'rgba(139,92,246,0.5)',  fill:'#8b5cf6' },
  intersection: { dot:'rgba(244,63,94,0.85)',  ring:'rgba(244,63,94,0.5)',   fill:'#f43f5e' },
  'arc-center': { dot:'rgba(34,211,238,0.90)', ring:'rgba(34,211,238,0.45)',fill:'#22d3ee' },
};
const SNAP_PRIORITY = { endpoint:0, intersection:1, midpoint:2, centroid:3 };
const SNAP_SIZE     = { intersection:1.0, endpoint:1.0, midpoint:0.85, centroid:0.85 };
const LINE_COLOUR  = { base:'rgba(56,189,248,{a})',  fill:'#38bdf8' };
const CURVE_COLOUR = { base:'rgba(56,189,248,{a})',  fill:'#38bdf8' };
const AREA_COLOUR  = { stroke:'rgba(251,146,60,{a})',fill:'#fb923c' };

function withAlpha(t,a){ return t.replace('{a}',a.toFixed(2)); }
function isDoorOrSwing(s){ const v=(s??'').toLowerCase(); return v.includes('door')||v.includes('swing'); }
function pdfXtoC(x){ return (x*zoom+panX)*dpr; }
function pdfYtoC(y){ return (y*zoom+panY)*dpr; }

function buildGrid(cands, cellSize){
  const cells=new Map();
  for(const c of cands){
    const key=Math.floor(c.x/cellSize)+','+Math.floor(c.y/cellSize);
    let b=cells.get(key); if(!b){b=[];cells.set(key,b);} b.push(c);
  }
  return {cells,cellSize};
}
function queryGrid(grid,x,y,radius){
  const {cells,cellSize}=grid, r=Math.ceil(radius/cellSize),
    cx=Math.floor(x/cellSize), cy=Math.floor(y/cellSize), out=[];
  for(let dx=-r;dx<=r;dx++) for(let dy=-r;dy<=r;dy++){
    const b=cells.get((cx+dx)+','+(cy+dy)); if(b) out.push(...b);
  }
  return out;
}
function rebuildCandidates(){
  candidatesCache=snapPoints.map(p=>({x:p.nx*dims.w,y:p.ny*dims.h,type:p.type,strokeWidth:p.strokeWidth,shapeId:p.shapeId}));
  spatialGrid=buildGrid(candidatesCache,proximityRadius);
}
function rebuildEligibleCaches(){
  eligibleLinesCache=svgLines.filter(l=>!isDoorOrSwing(l.shapeId));
  eligibleAreasCache=svgAreas.filter(a=>a.points.length>=3&&a.label!=='door'&&!a.isDoor);
  eligibleCurvesCache=svgCurves;
}
function resizeCanvas(){
  if(!canvas) return;
  const tw=Math.round(vpW*dpr),th=Math.round(vpH*dpr);
  if(canvas.width!==tw||canvas.height!==th){canvas.width=tw;canvas.height=th;}
}

// ── HUD renderer ──────────────────────────────────────────────────────────────
function drawHUD(frameCounts, framePhaseMs) {
  if (!ctx) return;
  const s = lastStats;

  const lines = [
    '── snap worker debug ──',
    '',
    'fps:        ' + (s ? s.fps : '--'),
    'msg/sec:    ' + (s ? s.msgPerSec : '--'),
    'draw avg:   ' + (s ? s.drawMs + ' ms' : '--'),
    '',
    '── this frame (ms) ──',
    'curves:     ' + framePhaseMs.curves.toFixed(2),
    'lines:      ' + framePhaseMs.lines.toFixed(2),
    'areas:      ' + framePhaseMs.areas.toFixed(2),
    'candidates: ' + framePhaseMs.candidates.toFixed(2),
    '',
    '── counts (this frame) ──',
    'curves:     ' + frameCounts.curves + ' / culled ' + frameCounts.curvesCulled,
    'lines:      ' + frameCounts.lines + ' / culled ' + frameCounts.linesCulled + ' / drawn ' + frameCounts.linesDrawn,
    'areas:      ' + frameCounts.areas + ' / culled ' + frameCounts.areasCulled + ' / drawn ' + frameCounts.areasDrawn,
    'candidates: ' + frameCounts.candidates,
    '',
    '── state ──',
    'tool:       ' + activeTool,
    'showPins:   ' + showPins,
    'zoom:       ' + zoom.toFixed(3),
    'prox r:     ' + proximityRadius,
    'snap thr:   ' + snapThreshold,
  ];

  const PAD = 12 * dpr;
  const LINE_H = 14 * dpr;
  const FONT_SIZE = 11 * dpr;
  const boxW = 210 * dpr;
  const boxH = (lines.length + 1) * LINE_H + PAD;

  ctx.save();

  ctx.fillStyle = 'rgba(0,0,0,0.78)';
  ctx.beginPath();
  ctx.roundRect(PAD, PAD, boxW, boxH, 6 * dpr);
  ctx.fill();

  ctx.font = 'bold ' + FONT_SIZE + 'px monospace';
  ctx.textBaseline = 'top';

  let y = PAD + LINE_H * 0.5;
  for (const line of lines) {
    if (line === '') { y += LINE_H * 0.6; continue; }

    let color = '#e2e8f0';
    if (line.startsWith('──')) color = '#94a3b8';
    else if (line.includes(' ms')) {
      const ms = parseFloat(line.split(':')[1]);
      if (!isNaN(ms)) {
        if (ms < 1)   color = '#4ade80';
        else if (ms < 4) color = '#facc15';
        else           color = '#f87171';
      }
    } else if (line.startsWith('fps:')) {
      const fps = parseInt(line.split(':')[1]);
      if (!isNaN(fps)) {
        if (fps >= 55)      color = '#4ade80';
        else if (fps >= 30) color = '#facc15';
        else                color = '#f87171';
      }
    }

    ctx.fillStyle = color;
    ctx.fillText(line, PAD + 8 * dpr, y);
    y += LINE_H;
  }

  ctx.restore();
}

// ── Instrumented draw ─────────────────────────────────────────────────────────
function draw() {
  rafHandle = null;
  if (!canvas || !ctx) return;

  const shouldDraw = showPins && activeTool !== 'select' && cursorX !== null && cursorY !== null;
  resizeCanvas();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const frameStart = performance.now();
  dbg.frameCount++;

  const fc = {
    curves: eligibleCurvesCache.length, curvesCulled: 0,
    lines: eligibleLinesCache.length, linesCulled: 0, linesDrawn: 0,
    areas: eligibleAreasCache.length, areasCulled: 0, areasDrawn: 0,
    candidates: 0,
  };
  const fms = { curves: 0, lines: 0, areas: 0, candidates: 0 };

  if (!shouldDraw) {
    drawHUD(fc, fms);
    return;
  }

  const prox = proximityRadius, thresh = snapThreshold, W = canvas.width, H = canvas.height;
  const cxPx = (cursorX * zoom + panX) * dpr, cyPx = (cursorY * zoom + panY) * dpr;
  const proxPx = prox * dpr;
  const pdfMinX = (-panX) / zoom, pdfMinY = (-panY) / zoom;
  const pdfMaxX = (W / dpr - panX) / zoom, pdfMaxY = (H / dpr - panY) / zoom;
  const proxPdf = prox / zoom;
  const cullMinX = pdfMinX - proxPdf, cullMinY = pdfMinY - proxPdf;
  const cullMaxX = pdfMaxX + proxPdf, cullMaxY = pdfMaxY + proxPdf;

  // ── 1. Curves ────────────────────────────────────────────────────────────
  let t0 = performance.now();
  for (let ci = 0; ci < eligibleCurvesCache.length; ci++) {
    const cv = eligibleCurvesCache[ci];
    const ex1 = cv.nx1 * dims.w, ey1 = cv.ny1 * dims.h, ex2 = cv.nx2 * dims.w, ey2 = cv.ny2 * dims.h;
    if (Math.max(ex1,ex2)<cullMinX||Math.min(ex1,ex2)>cullMaxX||Math.max(ey1,ey2)<cullMinY||Math.min(ey1,ey2)>cullMaxY) { fc.curvesCulled++; continue; }
    const p0x=pdfXtoC(ex1),p0y=pdfYtoC(ey1),p1x=pdfXtoC(cv.ncp1x*dims.w),p1y=pdfYtoC(cv.ncp1y*dims.h);
    const p3x=pdfXtoC(ex2),p3y=pdfYtoC(ey2);
    const isCubic=cv.type==='cubic'&&cv.ncp2x!==undefined;
    const p2x=isCubic?pdfXtoC(cv.ncp2x*dims.w):0, p2y=isCubic?pdfYtoC(cv.ncp2y*dims.h):0;
    let minD=Infinity;
    for(let i=0;i<=16;i++){
      const t=i/16,u=1-t;
      const ptx=isCubic?u*u*u*p0x+3*u*u*t*p1x+3*u*t*t*p2x+t*t*t*p3x:u*u*p0x+2*u*t*p1x+t*t*p3x;
      const pty=isCubic?u*u*u*p0y+3*u*u*t*p1y+3*u*t*t*p2y+t*t*t*p3y:u*u*p0y+2*u*t*p1y+t*t*p3y;
      const d=Math.hypot(cxPx-ptx,cyPx-pty); if(d<minD) minD=d;
    }
    if(minD>proxPx) continue;
    const fade=Math.max(0,1-minD/proxPx),alpha=0.10+fade*0.60;
    ctx.save(); ctx.beginPath(); ctx.moveTo(p0x,p0y);
    if(isCubic) ctx.bezierCurveTo(p1x,p1y,p2x,p2y,p3x,p3y);
    else ctx.quadraticCurveTo(p1x,p1y,p3x,p3y);
    ctx.strokeStyle=withAlpha(CURVE_COLOUR.base,alpha); ctx.lineWidth=(0.5+fade*1.5)*dpr; ctx.stroke(); ctx.restore();
  }
  fms.curves = performance.now() - t0;
  dbg.phase.curves += fms.curves;
  dbg.counts.curves += fc.curves;
  dbg.counts.curvesCulled += fc.curvesCulled;

  // ── 2. Lines ──────────────────────────────────────────────────────────────
  t0 = performance.now();
  let nearestLineIdx=-1, nearestLineDist=prox, nearestLineSnapX=0, nearestLineSnapY=0;
  const lineDrawCache=[];
  for(let li=0;li<eligibleLinesCache.length;li++){
    const line=eligibleLinesCache[li];
    const x1p=line.nx1*dims.w,y1p=line.ny1*dims.h,x2p=line.nx2*dims.w,y2p=line.ny2*dims.h;
    if(Math.max(x1p,x2p)<cullMinX||Math.min(x1p,x2p)>cullMaxX||Math.max(y1p,y2p)<cullMinY||Math.min(y1p,y2p)>cullMaxY){ fc.linesCulled++; continue; }
    const c1x=pdfXtoC(x1p),c1y=pdfYtoC(y1p),c2x=pdfXtoC(x2p),c2y=pdfYtoC(y2p);
    const ax=cxPx-c1x,ay=cyPx-c1y,bx=c2x-c1x,by=c2y-c1y,len2=bx*bx+by*by;
    let cpx,cpy;
    if(len2===0){cpx=c1x;cpy=c1y;}else{const t=Math.max(0,Math.min(1,(ax*bx+ay*by)/len2));cpx=c1x+t*bx;cpy=c1y+t*by;}
    const distPx=Math.hypot(cxPx-cpx,cyPx-cpy),distCSS=distPx/dpr;
    if(distPx>proxPx) continue;
    fc.linesDrawn++;
    lineDrawCache.push({c1x,c1y,c2x,c2y,cpx,cpy,dist:distCSS,idx:li});
    if(distCSS<nearestLineDist){nearestLineDist=distCSS;nearestLineIdx=li;nearestLineSnapX=cpx;nearestLineSnapY=cpy;}
  }
  for(let di=0;di<lineDrawCache.length;di++){
    const {c1x,c1y,c2x,c2y,dist,idx}=lineDrawCache[di];
    const isN=idx===nearestLineIdx,isSnap=isN&&dist<thresh;
    const ra=1-dist/prox,la=isN?ra:ra*0.25,lw=isSnap?2.0:isN?1.2:0.6;
    ctx.save(); ctx.beginPath(); ctx.moveTo(c1x,c1y); ctx.lineTo(c2x,c2y);
    ctx.strokeStyle=withAlpha(LINE_COLOUR.base,la); ctx.lineWidth=lw*dpr;
    if(!isSnap&&isN) ctx.setLineDash([6*dpr,4*dpr]);
    ctx.stroke(); ctx.setLineDash([]);
    if(isSnap){
      ctx.beginPath(); ctx.arc(nearestLineSnapX,nearestLineSnapY,5*dpr,0,Math.PI*2);
      ctx.fillStyle=LINE_COLOUR.fill; ctx.fill(); ctx.strokeStyle='white'; ctx.lineWidth=1.5*dpr; ctx.stroke();
    }
    ctx.restore();
  }
  fms.lines = performance.now() - t0;
  dbg.phase.lines += fms.lines;
  dbg.counts.lines += fc.lines;
  dbg.counts.linesCulled += fc.linesCulled;
  dbg.counts.linesDrawn += fc.linesDrawn;

  // ── 3. Areas ──────────────────────────────────────────────────────────────
  t0 = performance.now();
  for(let ai=0;ai<eligibleAreasCache.length;ai++){
    const area=eligibleAreasCache[ai],b=area.bounds;
    if(b.maxNX*dims.w<cullMinX||b.minNX*dims.w>cullMaxX||b.maxNY*dims.h<cullMinY||b.minNY*dims.h>cullMaxY){ fc.areasCulled++; continue; }
    const pts=area.points,n=pts.length;
    let distEdge=Infinity,snapPtX=0,snapPtY=0;
    for(let i=0;i<n;i++){
      const j=(i+1)%n;
      const ix=pdfXtoC(pts[i].nx*dims.w),iy=pdfYtoC(pts[i].ny*dims.h);
      const jx=pdfXtoC(pts[j].nx*dims.w),jy=pdfYtoC(pts[j].ny*dims.h);
      const ax=cxPx-ix,ay=cyPx-iy,bx2=jx-ix,by2=jy-iy,len2=bx2*bx2+by2*by2;
      let cpx,cpy;
      if(len2===0){cpx=ix;cpy=iy;}else{const t=Math.max(0,Math.min(1,(ax*bx2+ay*by2)/len2));cpx=ix+t*bx2;cpy=iy+t*by2;}
      const d=Math.hypot(cxPx-cpx,cyPx-cpy)/dpr;
      if(d<distEdge){distEdge=d;snapPtX=cpx;snapPtY=cpy;}
    }
    if(distEdge>prox*2){ continue; }
    fc.areasDrawn++;
    const isSnap=distEdge<thresh,fade=Math.max(0,1-distEdge/(prox*2)),alpha=isSnap?0.90:0.15+fade*0.55;
    ctx.save(); ctx.beginPath(); ctx.moveTo(pdfXtoC(pts[0].nx*dims.w),pdfYtoC(pts[0].ny*dims.h));
    for(let i=1;i<n;i++) ctx.lineTo(pdfXtoC(pts[i].nx*dims.w),pdfYtoC(pts[i].ny*dims.h));
    ctx.closePath(); ctx.strokeStyle=withAlpha(AREA_COLOUR.stroke,alpha); ctx.lineWidth=(isSnap?2.0:0.5+fade*1.5)*dpr; ctx.stroke();
    if(isSnap){
      ctx.beginPath(); ctx.arc(snapPtX,snapPtY,5*dpr,0,Math.PI*2);
      ctx.fillStyle=AREA_COLOUR.fill; ctx.fill(); ctx.strokeStyle='white'; ctx.lineWidth=1.5*dpr; ctx.stroke();
    }
    ctx.restore();
  }
  fms.areas = performance.now() - t0;
  dbg.phase.areas += fms.areas;
  dbg.counts.areas += fc.areas;
  dbg.counts.areasCulled += fc.areasCulled;
  dbg.counts.areasDrawn += fc.areasDrawn;

  // ── 4. Snap candidates ────────────────────────────────────────────────────
  t0 = performance.now();
  const nearby=spatialGrid?queryGrid(spatialGrid,cursorX,cursorY,prox):candidatesCache;
  fc.candidates = nearby.length;
  let nearestC=null,nearestCDist=Infinity;
  for(let ci=0;ci<nearby.length;ci++){
    const c=nearby[ci]; if(isDoorOrSwing(c.shapeId)) continue;
    const cpx=pdfXtoC(c.x),cpy=pdfYtoC(c.y),dist=Math.hypot(cxPx-cpx,cyPx-cpy)/dpr;
    if(dist>prox) continue;
    const pri=SNAP_PRIORITY[c.type]??99,nearPri=nearestC?(SNAP_PRIORITY[nearestC.type]??99):99;
    const tooClose=nearestC!==null&&Math.abs(dist-nearestCDist)<4;
    if(nearestC===null||(tooClose&&pri<nearPri)||(!tooClose&&dist<nearestCDist)){nearestCDist=dist;nearestC=c;}
  }
  if(nearestC){
    const c=nearestC,col=SVG_SNAP_COLOURS[c.type]??SVG_SNAP_COLOURS['endpoint'];
    const sm=SNAP_SIZE[c.type]??1.0,dist=nearestCDist,isSnap=dist<thresh;
    const fade=Math.max(0,1-dist/prox),cpx=pdfXtoC(c.x),cpy=pdfYtoC(c.y);
    ctx.save();
    if(isSnap){
      const r=7*dpr*sm,ch=11*dpr;
      ctx.beginPath();ctx.arc(cpx,cpy,r,0,Math.PI*2);ctx.fillStyle=col.fill;ctx.globalAlpha=0.25;ctx.fill();ctx.globalAlpha=1;
      ctx.beginPath();ctx.arc(cpx,cpy,r,0,Math.PI*2);ctx.fillStyle=col.fill;ctx.fill();ctx.strokeStyle='white';ctx.lineWidth=2*dpr;ctx.stroke();
      ctx.beginPath();ctx.moveTo(cpx-ch,cpy);ctx.lineTo(cpx+ch,cpy);ctx.moveTo(cpx,cpy-ch);ctx.lineTo(cpx,cpy+ch);
      ctx.strokeStyle='rgba(255,255,255,0.65)';ctx.lineWidth=1.5*dpr;ctx.stroke();
    }else{
      const sz=(2.5+fade*4.5)*dpr*sm,a=0.20+fade*0.65;
      ctx.strokeStyle=col.dot;ctx.globalAlpha=a;ctx.lineWidth=(0.8+fade*0.8)*dpr;
      ctx.beginPath();ctx.moveTo(cpx-sz,cpy);ctx.lineTo(cpx+sz,cpy);ctx.stroke();
      ctx.beginPath();ctx.moveTo(cpx,cpy-sz);ctx.lineTo(cpx,cpy+sz);ctx.stroke();
      if(fade>0.35){ctx.beginPath();ctx.arc(cpx,cpy,sz+4*dpr,0,Math.PI*2);ctx.strokeStyle=col.ring;ctx.globalAlpha=a*0.35;ctx.lineWidth=0.8*dpr;ctx.stroke();}
      ctx.globalAlpha=1;
    }
    ctx.restore();
    ctx.save();ctx.beginPath();ctx.arc(cxPx,cyPx,proxPx,0,Math.PI*2);
    ctx.strokeStyle='rgba(100,100,100,0.08)';ctx.lineWidth=0.8*dpr;ctx.setLineDash([3*dpr,4*dpr]);ctx.stroke();ctx.setLineDash([]);ctx.restore();
  }
  fms.candidates = performance.now() - t0;
  dbg.phase.candidates += fms.candidates;
  dbg.counts.candidates += fc.candidates;

  const totalMs = performance.now() - frameStart;
  dbg.drawMsSum += totalMs;

  drawHUD(fc, fms);
}

function requestDraw(){ if(rafHandle!==null) return; rafHandle=requestAnimationFrame(draw); }

self.onmessage=(e)=>{
  const msg=e.data;
  dbg.msgCount++;
  switch(msg.type){
    case 'init':{
      canvas=msg.canvas; ctx=canvas.getContext('2d');
      dims=msg.dims; dpr=msg.dpr??1; vpW=msg.vpW??800; vpH=msg.vpH??600;
      zoom=msg.zoom??1; panX=msg.panX??0; panY=msg.panY??0;
      snapThreshold=msg.snapThreshold??14; proximityRadius=msg.proximityRadius??80;
      showPins=msg.showPins??true; activeTool=msg.activeTool??'linear';
      snapPoints=msg.snapPoints??[]; svgLines=msg.svgLines??[]; svgCurves=msg.svgCurves??[]; svgAreas=msg.svgAreas??[];
      rebuildCandidates(); rebuildEligibleCaches(); resizeCanvas(); requestDraw(); break;
    }
    case 'data':{
      snapPoints=msg.snapPoints??snapPoints; svgLines=msg.svgLines??svgLines;
      svgCurves=msg.svgCurves??svgCurves; svgAreas=msg.svgAreas??svgAreas;
      if(msg.dims) dims=msg.dims;
      rebuildCandidates(); rebuildEligibleCaches(); requestDraw(); break;
    }
    case 'transform':{ zoom=msg.zoom; panX=msg.panX; panY=msg.panY; requestDraw(); break; }
    case 'cursor':{ cursorX=msg.x; cursorY=msg.y; requestDraw(); break; }
    case 'cursor_leave':{ cursorX=null; cursorY=null; requestDraw(); break; }
    case 'settings':{
      if(msg.snapThreshold!==undefined) snapThreshold=msg.snapThreshold;
      if(msg.proximityRadius!==undefined){ proximityRadius=msg.proximityRadius; spatialGrid=buildGrid(candidatesCache,proximityRadius); }
      if(msg.showPins!==undefined) showPins=msg.showPins;
      if(msg.activeTool!==undefined) activeTool=msg.activeTool;
      requestDraw(); break;
    }
    case 'resize':{ vpW=msg.vpW; vpH=msg.vpH; if(msg.dpr!==undefined) dpr=msg.dpr; resizeCanvas(); requestDraw(); break; }
  }
};
`;

const WORKER_SOURCE = SNAP_WORKER_DEBUG ? DEBUG_WORKER_SOURCE : PROD_WORKER_SOURCE;

// ── Transferred-canvas guard ──────────────────────────────────────────────────
// WeakMap keyed on the canvas DOM node so Strict Mode double-invoke can't
// re-transfer an already-transferred canvas (the node survives remounts).
const transferredCanvases = new WeakMap<HTMLCanvasElement, true>();

// ── Blob-URL factory ──────────────────────────────────────────────────────────
let workerBlobUrl: string | null = null;
let workerBlobRefCount = 0;

function acquireWorkerBlobUrl(): string {
  if (!workerBlobUrl) {
    const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
    workerBlobUrl = URL.createObjectURL(blob);
  }
  workerBlobRefCount++;
  return workerBlobUrl;
}

function releaseWorkerBlobUrl() {
  workerBlobRefCount--;
  if (workerBlobRefCount <= 0 && workerBlobUrl) {
    URL.revokeObjectURL(workerBlobUrl);
    workerBlobUrl = null;
    workerBlobRefCount = 0;
  }
}

// ── Geometry helpers (main-thread snapToCorner only) ─────────────────────────

function closestPointOnSegment(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number,
): { x: number; y: number } {
  const ax = px - x1, ay = py - y1;
  const bx = x2 - x1, by = y2 - y1;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return { x: x1, y: y1 };
  const t = Math.max(0, Math.min(1, (ax * bx + ay * by) / len2));
  return { x: x1 + t * bx, y: y1 + t * by };
}

function closestPointOnPolygonEdge(
  x: number, y: number,
  points: Array<{ x: number; y: number }>,
): { x: number; y: number; dist: number } {
  let best = { x, y, dist: Infinity };
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    const c = closestPointOnSegment(x, y, points[i].x, points[i].y, points[j].x, points[j].y);
    const d = Math.hypot(c.x - x, c.y - y);
    if (d < best.dist) best = { x: c.x, y: c.y, dist: d };
  }
  return best;
}

function shapeIdIncludes(id: string | undefined | null, term: string): boolean {
  return (id ?? '').toLowerCase().includes(term);
}

// ── Spatial grid (main thread — snapToCorner hit-test only) ───────────────────

interface Candidate {
  x: number; y: number; type: string; shapeId?: string;
}

interface SpatialGrid {
  cells:    Map<string, Candidate[]>;
  cellSize: number;
}

function buildGrid(candidates: Candidate[], cellSize: number): SpatialGrid {
  const cells = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const key = `${Math.floor(c.x / cellSize)},${Math.floor(c.y / cellSize)}`;
    let bucket = cells.get(key);
    if (!bucket) { bucket = []; cells.set(key, bucket); }
    bucket.push(c);
  }
  return { cells, cellSize };
}

function queryGrid(grid: SpatialGrid, x: number, y: number, radius: number): Candidate[] {
  const { cells, cellSize } = grid;
  const r  = Math.ceil(radius / cellSize);
  const cx = Math.floor(x / cellSize);
  const cy = Math.floor(y / cellSize);
  const out: Candidate[] = [];
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      const bucket = cells.get(`${cx + dx},${cy + dy}`);
      if (bucket) out.push(...bucket);
    }
  }
  return out;
}

// ── Hook params / return (unchanged public interface) ─────────────────────────

export interface UseSnapEngineParams {
  pinCanvasRef:     React.RefObject<HTMLCanvasElement | null>;
  pdfDimensionsRef: React.MutableRefObject<PdfDimensions | null>;
  pageNumberRef:    React.MutableRefObject<number>;
  scaleRef?:        React.MutableRefObject<number>;
  snapEnabled:      boolean;
  showPins:         boolean;
  snapThreshold:    number;
  confidenceFilter: number;
  svgSnapPoints?:   SvgSnapPoint[];
  svgLines?:        SvgLine[];
  svgAreas?:        SvgArea[];
  svgCurves?:       SvgCurve[];
  isZooming?:       boolean;
  activeTool?:      string;
  viewportRef:      React.RefObject<HTMLDivElement | null>;
  zoom:             number;
  pan:              { x: number; y: number };
  proximityRadius?: number;
}

export interface UseSnapEngineReturn {
  pageData:             Map<number, PageExtractionState>;
  analysisStatus:       'idle' | 'analyzing' | 'done';
  analysisPage:         { current: number; total: number } | null;
  snapFlashes:          SnapFlash[];
  startExtraction:      (pdf: any, file?: File) => void;
  getScaledCorners:     (pageIdx: number) => Array<{ x: number; y: number; confidence: number }>;
  getScaledWallCorners: (pageIdx: number) => Array<{ x: number; y: number; confidence: number; lineIndices: number[] }>;
  getScaledWallLines:   (pageIdx: number) => Array<{ x1: number; y1: number; x2: number; y2: number; angle: number; length: number }>;
  snapToCorner:         (rawX: number, rawY: number) => SnapResult;
  triggerSnapFlash:     (x: number, y: number) => void;
  redrawPinCanvas:      () => void;
  cursorPointRef:       React.MutableRefObject<{ x: number; y: number } | null>;
  linearChain:          LinearChainPoint[];
  addChainPoint:        (x: number, y: number, type: string) => void;
  undoChainPoint:       () => void;
  clearChain:           () => void;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useSnapEngine({
  pinCanvasRef,
  pdfDimensionsRef,
  pageNumberRef,
  scaleRef,
  snapEnabled,
  showPins,
  snapThreshold,
  confidenceFilter,
  svgSnapPoints = [],
  svgLines      = [],
  svgAreas      = [],
  svgCurves     = [],
  isZooming     = false,
  activeTool    = 'linear',
  viewportRef,
  zoom,
  pan,
  proximityRadius = 80,
}: UseSnapEngineParams): UseSnapEngineReturn {

  const workerRef      = useRef<Worker | null>(null);
  const workerReadyRef = useRef(false);

  const snapEnabledRef   = useRef(snapEnabled);
  const snapThresholdRef = useRef(snapThreshold);
  const svgLinesRef      = useRef<SvgLine[]>(svgLines);
  const svgAreasRef      = useRef<SvgArea[]>(svgAreas);
  const proximityRef     = useRef(proximityRadius);

  const candidatesCacheRef = useRef<Candidate[]>([]);
  const spatialGridRef     = useRef<SpatialGrid | null>(null);

  useEffect(() => { snapEnabledRef.current   = snapEnabled;    }, [snapEnabled]);
  useEffect(() => { snapThresholdRef.current = snapThreshold;  }, [snapThreshold]);
  useEffect(() => { svgLinesRef.current      = svgLines;       }, [svgLines]);
  useEffect(() => { svgAreasRef.current      = svgAreas;       }, [svgAreas]);
  useEffect(() => { proximityRef.current     = proximityRadius; }, [proximityRadius]);

  const [pageData]       = useState<Map<number, PageExtractionState>>(new Map());
  const [analysisStatus] = useState<'idle' | 'analyzing' | 'done'>('done');
  const [analysisPage]   = useState<{ current: number; total: number } | null>(null);
  const [snapFlashes, setSnapFlashes] = useState<SnapFlash[]>([]);
  const [linearChain, setLinearChain] = useState<LinearChainPoint[]>([]);

  const cursorPointRef = useRef<{ x: number; y: number } | null>(null);
  const flashIdRef     = useRef(0);

  const post = useCallback((msg: object) => {
    if (workerRef.current && workerReadyRef.current) {
      workerRef.current.postMessage(msg);
    }
  }, []);

  // ── Spawn worker ──────────────────────────────────────────────────────────
  useEffect(() => {
    const blobUrl = acquireWorkerBlobUrl();
    const worker  = new Worker(blobUrl);
    workerRef.current      = worker;
    workerReadyRef.current = true;

    if (SNAP_WORKER_DEBUG) {
      worker.onmessage = (e) => {
        if (e.data?.type === 'debug_stats') {
          const s = e.data;
          console.log(
            `[SnapWorker] fps=${s.fps} msg/s=${s.msgPerSec} draw=${s.drawMs}ms` +
            ` | curves=${s.phase.curves}ms(${s.counts.curves}/${s.counts.curvesCulled}culled)` +
            ` lines=${s.phase.lines}ms(${s.counts.lines}/${s.counts.linesCulled}culled/${s.counts.linesDrawn}drawn)` +
            ` areas=${s.phase.areas}ms(${s.counts.areas}/${s.counts.areasCulled}culled/${s.counts.areasDrawn}drawn)` +
            ` cands=${s.phase.candidates}ms(${s.counts.candidates})` +
            ` | tool=${s.state.activeTool} zoom=${s.state.zoom}`
          );
        }
      };
    }

    return () => {
      worker.terminate();
      workerRef.current      = null;
      workerReadyRef.current = false;
      const canvas = pinCanvasRef.current;
      if (canvas) transferredCanvases.delete(canvas);
      releaseWorkerBlobUrl();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Transfer OffscreenCanvas ──────────────────────────────────────────────
  useEffect(() => {
    const tryTransfer = () => {
      const canvas = pinCanvasRef.current;
      const worker = workerRef.current;
      if (!canvas || !worker || transferredCanvases.has(canvas)) return;
      if (!('transferControlToOffscreen' in canvas)) {
        console.warn('[useSnapEngine] OffscreenCanvas not supported, snap overlay disabled');
        return;
      }
      const offscreen = canvas.transferControlToOffscreen();
      const dims      = pdfDimensionsRef.current ?? { w: 1, h: 1 };
      const vp        = viewportRef?.current;
      transferredCanvases.set(canvas, true);
      worker.postMessage(
        {
          type: 'init', canvas: offscreen, dims,
          dpr:  window.devicePixelRatio || 1,
          vpW:  vp?.clientWidth  ?? 800,
          vpH:  vp?.clientHeight ?? 600,
          zoom, panX: pan.x, panY: pan.y,
          snapPoints: svgSnapPoints, svgLines, svgCurves, svgAreas,
          snapThreshold, proximityRadius, showPins, activeTool,
        },
        [offscreen],
      );
    };
    tryTransfer();
    const raf = requestAnimationFrame(tryTransfer);
    return () => cancelAnimationFrame(raf);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── CONSOLIDATED DATA EFFECT ──────────────────────────────────────────────
  //
  // This single effect handles BOTH the main-thread grid rebuild AND the worker
  // data forward. It uses strict reference equality to bail immediately when
  // zoom causes re-renders but the data hasn't changed.
  //
  // WHY: zoom changes scale state → Viewer re-renders → useSnapEngine called
  // again with the same array props. Without the ref guard, React sees the
  // effect deps as potentially changed and re-runs the effect, triggering a
  // 25-second structured-clone postMessage on every wheel tick.
  //
  // With the guard: same reference → return immediately → 0ms on zoom.
  // Data only serialized once when SVG first loads or PDF page changes.
  //
  const lastSentSnapPointsRef = useRef<SvgSnapPoint[]>([]);
  const lastSentSvgLinesRef   = useRef<SvgLine[]>([]);
  const lastSentSvgCurvesRef  = useRef<SvgCurve[]>([]);
  const lastSentSvgAreasRef   = useRef<SvgArea[]>([]);

  useEffect(() => {
    // Strict reference equality check — if all four are the same objects as
    // last time, the data hasn't changed (zoom caused the re-render, not new
    // SVG data). Bail immediately with zero work done.
    const unchanged =
      svgSnapPoints === lastSentSnapPointsRef.current &&
      svgLines      === lastSentSvgLinesRef.current   &&
      svgCurves     === lastSentSvgCurvesRef.current  &&
      svgAreas      === lastSentSvgAreasRef.current;

    if (unchanged) return;

    // Data genuinely changed — update sentinel refs
    lastSentSnapPointsRef.current = svgSnapPoints;
    lastSentSvgLinesRef.current   = svgLines;
    lastSentSvgCurvesRef.current  = svgCurves;
    lastSentSvgAreasRef.current   = svgAreas;

    // 1. Rebuild main-thread spatial grid (used by synchronous snapToCorner)
    const dims = pdfDimensionsRef.current;
    if (dims) {
      const candidates: Candidate[] = svgSnapPoints.map(p => ({
        x: p.nx * dims.w, y: p.ny * dims.h,
        type: p.type, shapeId: p.shapeId,
      }));
      candidatesCacheRef.current = candidates;
      spatialGridRef.current     = buildGrid(candidates, proximityRadius);
    }

    // 2. Forward to worker — only fires when data genuinely changes
    const canvas = pinCanvasRef.current;
    if (!canvas || !transferredCanvases.has(canvas)) return;
    const dims2 = pdfDimensionsRef.current ?? { w: 1, h: 1 };
    post({
      type: 'data',
      snapPoints: svgSnapPoints,
      svgLines,
      svgCurves,
      svgAreas,
      dims: dims2,
    });

  }, [svgSnapPoints, svgLines, svgCurves, svgAreas, proximityRadius, post, pdfDimensionsRef]);

  // ── Transform effect — the ONLY effect that fires on zoom ─────────────────
  // Posts just 3 numbers. No array serialization. Negligible cost.
  useEffect(() => {
    post({ type: 'transform', zoom, panX: pan.x, panY: pan.y });
  }, [zoom, pan.x, pan.y, post]);

  // ── Settings effect ───────────────────────────────────────────────────────
  useEffect(() => {
    post({ type: 'settings', showPins, activeTool, snapThreshold, proximityRadius });
  }, [showPins, activeTool, snapThreshold, proximityRadius, post]);

  // ── Resize observer ───────────────────────────────────────────────────────
  useEffect(() => {
    const el = viewportRef?.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        post({ type: 'resize', vpW: width, vpH: height, dpr: window.devicePixelRatio || 1 });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [viewportRef, post]);

  // ── redrawPinCanvas ───────────────────────────────────────────────────────
  const redrawPinCanvas = useCallback(() => {
    const cursor = cursorPointRef.current;
    if (cursor) post({ type: 'cursor', x: cursor.x, y: cursor.y });
    else        post({ type: 'cursor_leave' });
  }, [post]);

  // ── snapToCorner (main thread, synchronous) ───────────────────────────────
  const snapToCorner = useCallback((rawX: number, rawY: number): SnapResult => {
    if (!snapEnabledRef.current || !pdfDimensionsRef.current)
      return { point: { x: rawX, y: rawY }, snapped: false };
    const dims   = pdfDimensionsRef.current;
    const thresh = snapThresholdRef.current;
    let bestPoint: { x: number; y: number } | null = null;
    let bestDist  = thresh;
    const nearby = spatialGridRef.current
      ? queryGrid(spatialGridRef.current, rawX, rawY, thresh)
      : candidatesCacheRef.current;
    for (const c of nearby) {
      if (shapeIdIncludes(c.shapeId, 'door') || shapeIdIncludes(c.shapeId, 'swing')) continue;
      const dist = Math.hypot(rawX - c.x, rawY - c.y);
      if (dist < bestDist) { bestDist = dist; bestPoint = { x: c.x, y: c.y }; }
    }
    if (!bestPoint) {
      for (const line of svgLinesRef.current) {
        if (shapeIdIncludes((line as any).shapeId, 'door')) continue;
        const x1 = line.nx1 * dims.w, y1 = line.ny1 * dims.h;
        const x2 = line.nx2 * dims.w, y2 = line.ny2 * dims.h;
        const cp   = closestPointOnSegment(rawX, rawY, x1, y1, x2, y2);
        const dist = Math.hypot(rawX - cp.x, rawY - cp.y);
        if (dist < bestDist) { bestDist = dist; bestPoint = { x: cp.x, y: cp.y }; }
      }
    }
    if (!bestPoint) {
      for (const area of svgAreasRef.current) {
        if (area.label === 'door' || area.isDoor) continue;
        const b = {
          minX: area.bounds.minNX * dims.w, minY: area.bounds.minNY * dims.h,
          maxX: area.bounds.maxNX * dims.w, maxY: area.bounds.maxNY * dims.h,
        };
        if (rawX < b.minX - thresh || rawX > b.maxX + thresh ||
            rawY < b.minY - thresh || rawY > b.maxY + thresh) continue;
        const pts    = area.points.map(p => ({ x: p.nx * dims.w, y: p.ny * dims.h }));
        const onEdge = closestPointOnPolygonEdge(rawX, rawY, pts);
        if (onEdge.dist < bestDist) { bestDist = onEdge.dist; bestPoint = { x: onEdge.x, y: onEdge.y }; }
      }
    }
    return bestPoint
      ? { point: bestPoint, snapped: true }
      : { point: { x: rawX, y: rawY }, snapped: false };
  }, [pdfDimensionsRef]);

  // ── triggerSnapFlash ──────────────────────────────────────────────────────
  const triggerSnapFlash = useCallback((x: number, y: number) => {
    const id = ++flashIdRef.current;
    setSnapFlashes(prev => [...prev, { x, y, id }]);
    setTimeout(() => setSnapFlashes(prev => prev.filter(f => f.id !== id)), 700);
  }, []);

  // ── Linear chain ──────────────────────────────────────────────────────────
  const addChainPoint  = useCallback((x: number, y: number, type: string) => {
    setLinearChain(prev => [...prev, { x, y, type }]);
  }, []);
  const undoChainPoint = useCallback(() => setLinearChain(prev => prev.slice(0, -1)), []);
  const clearChain     = useCallback(() => setLinearChain([]), []);

  const startExtraction      = useCallback(() => {}, []);
  const getScaledCorners     = useCallback(() => [], []);
  const getScaledWallCorners = useCallback(() => [], []);
  const getScaledWallLines   = useCallback(() => [], []);

  return {
    pageData, analysisStatus, analysisPage, snapFlashes,
    startExtraction, getScaledCorners, getScaledWallCorners, getScaledWallLines,
    snapToCorner, triggerSnapFlash, redrawPinCanvas, cursorPointRef,
    linearChain, addChainPoint, undoChainPoint, clearChain,
  };
}
/**
 * useSvgSnapPoints.ts
 *
 * PERF: SVG parsing + snap-point computation moved into an inline Web Worker.
 *
 * The main thread:
 *   1. Spawns a single worker (blob URL, created once per module load).
 *   2. Posts { svgContent, pw, ph } whenever the SVG or PDF dims change.
 *   3. Keeps the LAST successfully computed result in state and returns it
 *      immediately — so zoom / pan never stall waiting for a new parse.
 *   4. When the worker finishes, state is updated and components re-render
 *      with the fresh snap data.
 *
 * zoom param intentionally absent — snap points are normalised (0-1) and
 * are zoom-independent.  Passing zoom previously caused the entire list to
 * be rebuilt on every wheel tick, hanging the browser.
 */

import { useState, useEffect, useRef } from 'react';

// ─── Public types (unchanged API) ─────────────────────────────────────────────

export interface SvgSnapPoint {
  nx:          number;
  ny:          number;
  type:        'endpoint' | 'midpoint' | 'centroid' | 'intersection';
  shapeId:     string;
  strokeWidth: number;
}

export interface SvgCurve {
  type:    'cubic' | 'quadratic';
  nx1:     number; ny1:    number;
  ncp1x:   number; ncp1y:  number;
  ncp2x?:  number; ncp2y?: number;
  nx2:     number; ny2:    number;
  shapeId: string;
  sw:      number;
}

interface PdfDimensions { w: number; h: number }

// ─── Worker source ─────────────────────────────────────────────────────────────
//
// Everything inside WORKER_SRC runs in a separate thread.
// It receives  { type:'compute', svgContent, pw, ph }
// and posts back { type:'result', snapPoints, svgCurves }  (or { type:'error' }).

const WORKER_SRC = /* javascript */ `

// ── Matrix helpers ────────────────────────────────────────────────────────────
function identMat() { return { a:1,b:0,c:0,d:1,e:0,f:0 }; }
function mulMat(m1,m2) {
  return {
    a:m1.a*m2.a+m1.c*m2.b, b:m1.b*m2.a+m1.d*m2.b,
    c:m1.a*m2.c+m1.c*m2.d, d:m1.b*m2.c+m1.d*m2.d,
    e:m1.a*m2.e+m1.c*m2.f+m1.e, f:m1.b*m2.e+m1.d*m2.f+m1.f,
  };
}
function applyMat(m,x,y) { return [m.a*x+m.c*y+m.e, m.b*x+m.d*y+m.f]; }
function parseTfm(t) {
  if (!t) return identMat();
  const re=/(matrix|translate|scale|rotate|skewX|skewY)\\(([^)]*)\\)/g;
  const mats=[]; let m;
  while((m=re.exec(t))!==null){
    const args=m[2].trim().split(/[\\s,]+/).map(parseFloat);
    let mat=identMat();
    switch(m[1]){
      case'matrix':    mat={a:args[0],b:args[1],c:args[2],d:args[3],e:args[4],f:args[5]}; break;
      case'translate': mat={...identMat(),e:args[0]??0,f:args[1]??0}; break;
      case'scale':     { const sx=args[0]??1,sy=args[1]??sx; mat={a:sx,b:0,c:0,d:sy,e:0,f:0}; break; }
      case'rotate':    {
        const ang=(args[0]??0)*Math.PI/180,cos=Math.cos(ang),sin=Math.sin(ang);
        const cx=args[1]??0,cy=args[2]??0;
        mat={a:cos,b:sin,c:-sin,d:cos,e:cx-cos*cx+sin*cy,f:cy-sin*cx-cos*cy}; break;
      }
    }
    mats.push(mat);
  }
  return mats.reduce((acc,mm)=>mulMat(acc,mm),identMat());
}
function getCTM(el,root){
  const mats=[]; let node=el;
  while(node&&node!==root.parentElement){
    const t=node.getAttribute('transform');
    if(t) mats.unshift(parseTfm(t));
    node=node.parentElement;
  }
  return mats.reduce((acc,mm)=>mulMat(acc,mm),identMat());
}

// ── ViewBox → page-unit transform ─────────────────────────────────────────────
function buildVBTransform(svgEl,pw,ph){
  const vb=svgEl.getAttribute('viewBox');
  if(vb){
    const [minX,minY,vbW,vbH]=vb.trim().split(/[\\s,]+/).map(parseFloat);
    if([minX,minY,vbW,vbH].every(n=>!isNaN(n))&&vbW>0&&vbH>0)
      return{sx:pw/vbW,sy:ph/vbH,tx:-minX*(pw/vbW),ty:-minY*(ph/vbH)};
  }
  const wa=parseFloat(svgEl.getAttribute('width')??'0')||pw;
  const ha=parseFloat(svgEl.getAttribute('height')??'0')||ph;
  return{sx:pw/wa,sy:ph/ha,tx:0,ty:0};
}
function applyVB(x,y,vb){ return[x*vb.sx+vb.tx,y*vb.sy+vb.ty]; }

function resolveStroke(el){
  let node=el;
  while(node){
    const sw=node.getAttribute('stroke-width')??node.getAttribute('strokeWidth');
    if(sw){const v=parseFloat(sw);if(!isNaN(v)&&v>0)return v;}
    const style=node.getAttribute('style')??'';
    const mm=style.match(/stroke-width\\s*:\\s*([\\d.]+)/);
    if(mm){const v=parseFloat(mm[1]);if(!isNaN(v)&&v>0)return v;}
    node=node.parentElement;
  }
  return 1.0;
}

// ── Merge collinear straight segments ─────────────────────────────────────────
function mergeCollinear(segs){
  if(segs.length<2)return segs;
  const merged=[],used=new Set(),EPS_ANGLE=0.01,EPS_DIST=2;
  for(let i=0;i<segs.length;i++){
    if(used.has(i))continue;
    let cur={...segs[i]},changed=true;
    while(changed){
      changed=false;
      for(let j=0;j<segs.length;j++){
        if(used.has(j)||i===j)continue;
        const seg=segs[j];
        const a1=Math.atan2(cur.y2-cur.y1,cur.x2-cur.x1);
        const a2=Math.atan2(seg.y2-seg.y1,seg.x2-seg.x1);
        const diff=Math.abs(a1-a2)%Math.PI;
        if(Math.min(diff,Math.PI-diff)>EPS_ANGLE)continue;
        if(Math.hypot(cur.x2-seg.x1,cur.y2-seg.y1)<EPS_DIST){cur.x2=seg.x2;cur.y2=seg.y2;used.add(j);changed=true;}
        else if(Math.hypot(cur.x1-seg.x2,cur.y1-seg.y2)<EPS_DIST){cur.x1=seg.x1;cur.y1=seg.y1;used.add(j);changed=true;}
        else if(Math.abs(cur.x1-seg.x1)<EPS_DIST&&Math.abs(cur.y1-seg.y1)<EPS_DIST){cur.x1=seg.x2;cur.y1=seg.y2;used.add(j);changed=true;}
        else if(Math.abs(cur.x2-seg.x2)<EPS_DIST&&Math.abs(cur.y2-seg.y2)<EPS_DIST){cur.x2=seg.x1;cur.y2=seg.y1;used.add(j);changed=true;}
      }
    }
    if(Math.hypot(cur.x2-cur.x1,cur.y2-cur.y1)>2)merged.push(cur);
  }
  return merged;
}

// ── Bezier midpoints ──────────────────────────────────────────────────────────
function cubicMid(x0,y0,cx1,cy1,cx2,cy2,x3,y3){
  const t=.5,u=.5;
  return[u*u*u*x0+3*u*u*t*cx1+3*u*t*t*cx2+t*t*t*x3,
         u*u*u*y0+3*u*u*t*cy1+3*u*t*t*cy2+t*t*t*y3];
}
function quadMid(x0,y0,cx,cy,x2,y2){
  const t=.5,u=.5;
  return[u*u*x0+2*u*t*cx+t*t*x2,u*u*y0+2*u*t*cy+t*t*y2];
}

// ── Path → segments ───────────────────────────────────────────────────────────
function pathToSegs(d,ctm,vb,shapeId,sw,pw,ph){
  const segs=[];
  let cx=0,cy=0,sx=0,sy=0,lastCpX=0,lastCpY=0,lastCmd='';
  const toPage=(x,y)=>{ const[mx,my]=applyMat(ctm,x,y); return applyVB(mx,my,vb); };
  const pushStraight=(ax,ay,bx,by)=>{
    const[pax,pay]=toPage(ax,ay),[pbx,pby]=toPage(bx,by);
    if(Math.hypot(pbx-pax,pby-pay)<.5)return;
    segs.push({kind:'straight',x1:pax,y1:pay,x2:pbx,y2:pby,shapeId,sw});
  };
  const pushCubic=(ax,ay,c1x,c1y,c2x,c2y,bx,by)=>{
    const[pax,pay]=toPage(ax,ay),[pbx,pby]=toPage(bx,by);
    const[pc1x,pc1y]=toPage(c1x,c1y),[pc2x,pc2y]=toPage(c2x,c2y);
    if(Math.hypot(pbx-pax,pby-pay)<.5)return;
    const[midX,midY]=cubicMid(pax,pay,pc1x,pc1y,pc2x,pc2y,pbx,pby);
    segs.push({kind:'curve',curveType:'cubic',x1:pax,y1:pay,x2:pbx,y2:pby,midX,midY,cp1x:pc1x,cp1y:pc1y,cp2x:pc2x,cp2y:pc2y,shapeId,sw});
  };
  const pushQuad=(ax,ay,c1x,c1y,bx,by)=>{
    const[pax,pay]=toPage(ax,ay),[pbx,pby]=toPage(bx,by),[pc1x,pc1y]=toPage(c1x,c1y);
    if(Math.hypot(pbx-pax,pby-pay)<.5)return;
    const[midX,midY]=quadMid(pax,pay,pc1x,pc1y,pbx,pby);
    segs.push({kind:'curve',curveType:'quadratic',x1:pax,y1:pay,x2:pbx,y2:pby,midX,midY,cp1x:pc1x,cp1y:pc1y,shapeId,sw});
  };
  const tokens=d.match(/[MmLlHhVvCcSsQqTtAaZz][^MmLlHhVvCcSsQqTtAaZz]*/g);
  if(!tokens)return segs;
  for(const token of tokens){
    const cmd=token[0],upper=cmd.toUpperCase(),rel=cmd!==upper;
    const nums=token.slice(1).trim().split(/[\\s,]+/).map(parseFloat).filter(n=>!isNaN(n));
    const ox=rel?cx:0,oy=rel?cy:0;
    switch(upper){
      case'M':
        for(let i=0;i+1<nums.length;i+=2){
          const bx=i===0?ox:(rel?cx:0),by=i===0?oy:(rel?cy:0);
          cx=bx+nums[i];cy=by+nums[i+1];
          if(i===0){sx=cx;sy=cy;}
        }
        lastCpX=cx;lastCpY=cy;break;
      case'L':
        for(let i=0;i+1<nums.length;i+=2){const nx=ox+nums[i],ny=oy+nums[i+1];pushStraight(cx,cy,nx,ny);cx=nx;cy=ny;}
        lastCpX=cx;lastCpY=cy;break;
      case'H':
        for(const n of nums){const nx=ox+n;pushStraight(cx,cy,nx,cy);cx=nx;}
        lastCpX=cx;lastCpY=cy;break;
      case'V':
        for(const n of nums){const ny=oy+n;pushStraight(cx,cy,cx,ny);cy=ny;}
        lastCpX=cx;lastCpY=cy;break;
      case'C':
        for(let i=0;i+5<nums.length;i+=6){
          const c1x=ox+nums[i],c1y=oy+nums[i+1],c2x=ox+nums[i+2],c2y=oy+nums[i+3],nx=ox+nums[i+4],ny=oy+nums[i+5];
          pushCubic(cx,cy,c1x,c1y,c2x,c2y,nx,ny);lastCpX=c2x;lastCpY=c2y;cx=nx;cy=ny;
        }break;
      case'S':{
        for(let i=0;i+3<nums.length;i+=4){
          const prev=lastCmd==='C'||lastCmd==='S';
          const c1x=prev?2*cx-lastCpX:cx,c1y=prev?2*cy-lastCpY:cy;
          const c2x=ox+nums[i],c2y=oy+nums[i+1],nx=ox+nums[i+2],ny=oy+nums[i+3];
          pushCubic(cx,cy,c1x,c1y,c2x,c2y,nx,ny);lastCpX=c2x;lastCpY=c2y;cx=nx;cy=ny;
        }break;
      }
      case'Q':
        for(let i=0;i+3<nums.length;i+=4){
          const c1x=ox+nums[i],c1y=oy+nums[i+1],nx=ox+nums[i+2],ny=oy+nums[i+3];
          pushQuad(cx,cy,c1x,c1y,nx,ny);lastCpX=c1x;lastCpY=c1y;cx=nx;cy=ny;
        }break;
      case'T':{
        for(let i=0;i+1<nums.length;i+=2){
          const prev=lastCmd==='Q'||lastCmd==='T';
          const c1x=prev?2*cx-lastCpX:cx,c1y=prev?2*cy-lastCpY:cy;
          const nx=ox+nums[i],ny=oy+nums[i+1];
          pushQuad(cx,cy,c1x,c1y,nx,ny);lastCpX=c1x;lastCpY=c1y;cx=nx;cy=ny;
        }break;
      }
      case'A':
        for(let i=0;i+6<nums.length;i+=7){const nx=ox+nums[i+5],ny=oy+nums[i+6];pushStraight(cx,cy,nx,ny);cx=nx;cy=ny;}
        lastCpX=cx;lastCpY=cy;break;
      case'Z':
        if(Math.hypot(cx-sx,cy-sy)>.5)pushStraight(cx,cy,sx,sy);
        cx=sx;cy=sy;lastCpX=cx;lastCpY=cy;break;
    }
    lastCmd=upper;
  }
  return segs;
}

// ── Intersection helpers ──────────────────────────────────────────────────────
function segIntersection(s1,s2){
  const dx1=s1.x2-s1.x1,dy1=s1.y2-s1.y1,dx2=s2.x2-s2.x1,dy2=s2.y2-s2.y1;
  const denom=dx1*dy2-dy1*dx2;
  if(Math.abs(denom)<1e-8)return null;
  const dx3=s2.x1-s1.x1,dy3=s2.y1-s1.y1;
  const t=(dx3*dy2-dy3*dx2)/denom,u=(dx3*dy1-dy3*dx1)/denom;
  const EPS=0.01;
  if(t<-EPS||t>1+EPS||u<-EPS||u>1+EPS)return null;
  return[s1.x1+t*dx1,s1.y1+t*dy1];
}
function dedup(pts,radius){
  const out=[];
  for(const[x,y]of pts)
    if(!out.some(([ox,oy])=>Math.hypot(x-ox,y-oy)<radius))out.push([x,y]);
  return out;
}

// ── Circle / ellipse snap points ──────────────────────────────────────────────
function circleSnapPoints(el,ctm,vb,shapeId,sw,pw,ph){
  const pts=[];
  const toNorm=(x,y)=>{const[mx,my]=applyMat(ctm,x,y);const[vx,vy]=applyVB(mx,my,vb);return[vx/pw,vy/ph];};
  const tag=el.tagName.toLowerCase();
  if(tag==='circle'){
    const cx2=parseFloat(el.getAttribute('cx')??'0'),cy2=parseFloat(el.getAttribute('cy')??'0');
    const r=parseFloat(el.getAttribute('r')??'0');
    if(r<=0)return pts;
    const[cnx,cny]=toNorm(cx2,cy2);
    pts.push({nx:cnx,ny:cny,type:'centroid',shapeId,strokeWidth:sw});
    for(const[dx,dy]of[[0,-r],[0,r],[-r,0],[r,0]]){
      const[enx,eny]=toNorm(cx2+dx,cy2+dy);
      if(enx>=0&&enx<=1&&eny>=0&&eny<=1)pts.push({nx:enx,ny:eny,type:'endpoint',shapeId,strokeWidth:sw});
    }
  } else if(tag==='ellipse'){
    const cx2=parseFloat(el.getAttribute('cx')??'0'),cy2=parseFloat(el.getAttribute('cy')??'0');
    const rx=parseFloat(el.getAttribute('rx')??'0'),ry=parseFloat(el.getAttribute('ry')??'0');
    if(rx<=0||ry<=0)return pts;
    const[cnx,cny]=toNorm(cx2,cy2);
    pts.push({nx:cnx,ny:cny,type:'centroid',shapeId,strokeWidth:sw});
    for(const[dx,dy]of[[0,-ry],[0,ry],[-rx,0],[rx,0]]){
      const[enx,eny]=toNorm(cx2+dx,cy2+dy);
      if(enx>=0&&enx<=1&&eny>=0&&eny<=1)pts.push({nx:enx,ny:eny,type:'endpoint',shapeId,strokeWidth:sw});
    }
  }
  return pts;
}

// ── Main compute function ─────────────────────────────────────────────────────
const MIN_PDF_PX_FOR_MIDPOINT=12;

function compute(svgContent,pw,ph){
  const parser=new DOMParser();
  const svgDoc=parser.parseFromString(svgContent,'image/svg+xml');
  const svgRoot=svgDoc.documentElement;
  if(svgRoot.querySelector('parsererror'))throw new Error('Invalid SVG');
  const svgEl=svgDoc.querySelector('svg');
  if(!svgEl)throw new Error('No <svg>');

  const vb=buildVBTransform(svgEl,pw,ph);
  const rawStraight=[],curveSegs=[];
  let idCounter=0;

  const processEl=el=>{
    const tag=el.tagName.toLowerCase();
    if(['circle','ellipse','rect'].includes(tag))return;
    const ctm=getCTM(el,svgEl),sw=resolveStroke(el),id='shape-'+idCounter++;
    if(tag==='line'){
      const x1=parseFloat(el.getAttribute('x1')||'0'),y1=parseFloat(el.getAttribute('y1')||'0');
      const x2=parseFloat(el.getAttribute('x2')||'0'),y2=parseFloat(el.getAttribute('y2')||'0');
      const[ax,ay]=applyVB(...applyMat(ctm,x1,y1),vb),[bx,by]=applyVB(...applyMat(ctm,x2,y2),vb);
      if(Math.hypot(bx-ax,by-ay)>.5)rawStraight.push({kind:'straight',x1:ax,y1:ay,x2:bx,y2:by,shapeId:id,sw});
    } else if(tag==='path'){
      for(const seg of pathToSegs(el.getAttribute('d')??'',ctm,vb,id,sw,pw,ph)){
        if(seg.kind==='straight')rawStraight.push(seg); else curveSegs.push(seg);
      }
    } else if(tag==='polyline'||tag==='polygon'){
      const raw=el.getAttribute('points')??'';
      const nums=raw.trim().split(/[\\s,]+/).map(parseFloat).filter(n=>!isNaN(n));
      const pxpts=[];
      for(let i=0;i+1<nums.length;i+=2)pxpts.push(applyVB(...applyMat(ctm,nums[i],nums[i+1]),vb));
      for(let i=0;i+1<pxpts.length;i++){
        const[ax,ay]=pxpts[i],[bx,by]=pxpts[i+1];
        if(Math.hypot(bx-ax,by-ay)>.5)rawStraight.push({kind:'straight',x1:ax,y1:ay,x2:bx,y2:by,shapeId:id,sw});
      }
      if(tag==='polygon'&&pxpts.length>=2){
        const[ax,ay]=pxpts[pxpts.length-1],[bx,by]=pxpts[0];
        if(Math.hypot(bx-ax,by-ay)>.5)rawStraight.push({kind:'straight',x1:ax,y1:ay,x2:bx,y2:by,shapeId:id,sw});
      }
    }
  };

  svgRoot.querySelectorAll('line,path,polyline,polygon').forEach(processEl);

  const merged=mergeCollinear(rawStraight);

  const straightEndPx=dedup(merged.flatMap(s=>[[s.x1,s.y1],[s.x2,s.y2]]),2.0);
  const curveEndPx=curveSegs.flatMap(s=>[[s.x1,s.y1],[s.x2,s.y2]]);
  const allEndPx=dedup([...straightEndPx,...curveEndPx],2.0);

  const segsForX=merged.length>3000?merged.filter(s=>s.sw>0.3):merged;
  const intersectionPx=[];
  for(let i=0;i<segsForX.length;i++){
    for(let j=i+1;j<segsForX.length;j++){
      const s1=segsForX[i],s2=segsForX[j];
      const a1=Math.atan2(s1.y2-s1.y1,s1.x2-s1.x1),a2=Math.atan2(s2.y2-s2.y1,s2.x2-s2.x1);
      const diff=Math.abs(a1-a2)%Math.PI;
      if(Math.min(diff,Math.PI-diff)<0.26)continue;
      const pt=segIntersection(s1,s2);
      if(!pt)continue;
      const[ix,iy]=pt;
      if(ix<-pw*.05||ix>pw*1.05||iy<-ph*.05||iy>ph*1.05)continue;
      intersectionPx.push([ix,iy]);
    }
  }
  const dedupedIntersections=dedup(intersectionPx,6.0);

  const circlePts=[];
  svgRoot.querySelectorAll('circle,ellipse').forEach(el=>{
    circlePts.push(...circleSnapPoints(el,getCTM(el,svgEl),vb,'shape-'+idCounter++,resolveStroke(el),pw,ph));
  });

  // ── Build snap point list ─────────────────────────────────────────────────
  const snapPoints=[];

  for(const[x,y]of allEndPx){
    if(x<0||x>pw||y<0||y>ph)continue;
    snapPoints.push({nx:x/pw,ny:y/ph,type:'endpoint',shapeId:'corner',strokeWidth:1});
  }

  for(const seg of merged){
    const svgDist=Math.hypot(seg.x2-seg.x1,seg.y2-seg.y1);
    if(svgDist<MIN_PDF_PX_FOR_MIDPOINT)continue;
    const midX=(seg.x1+seg.x2)/2,midY=(seg.y1+seg.y2)/2;
    const mnx=midX/pw,mny=midY/ph;
    if(mnx<0||mnx>1||mny<0||mny>1)continue;
    snapPoints.push({nx:mnx,ny:mny,type:'midpoint',shapeId:'seg',strokeWidth:1});
  }

  for(const seg of curveSegs){
    const mnx=seg.midX/pw,mny=seg.midY/ph;
    if(mnx<0||mnx>1||mny<0||mny>1)continue;
    snapPoints.push({nx:mnx,ny:mny,type:'midpoint',shapeId:'curve',strokeWidth:1});
  }

  snapPoints.push(...circlePts);

  for(const[x,y]of dedupedIntersections){
    if(x<-pw*.02||x>pw*1.02||y<-ph*.02||y>ph*1.02)continue;
    snapPoints.push({nx:x/pw,ny:y/ph,type:'intersection',shapeId:'corner',strokeWidth:1.5});
  }

  // ── Build SVG curves list ─────────────────────────────────────────────────
  const svgCurves=curveSegs.map(s=>({
    type:s.curveType,
    nx1:s.x1/pw,ny1:s.y1/ph,
    ncp1x:s.cp1x/pw,ncp1y:s.cp1y/ph,
    ...(s.curveType==='cubic'&&s.cp2x!==undefined?{ncp2x:s.cp2x/pw,ncp2y:s.cp2y/ph}:{}),
    nx2:s.x2/pw,ny2:s.y2/ph,
    shapeId:s.shapeId,sw:s.sw,
  }));

  return{snapPoints,svgCurves};
}

// ── Worker message handler ────────────────────────────────────────────────────
self.onmessage=function(e){
  const{type,svgContent,pw,ph,requestId}=e.data;
  if(type!=='compute')return;
  try{
    const result=compute(svgContent,pw,ph);
    self.postMessage({type:'result',requestId,...result});
  }catch(err){
    self.postMessage({type:'error',requestId,message:String(err)});
  }
};
`;

// ─── Singleton worker (created once per module load) ──────────────────────────
//
// We use a module-level singleton so that:
//   a) The blob URL is created only once (cheap).
//   b) Multiple component instances share the same worker thread.
//   c) Cleanup on HMR / module unload is handled in the hook via a WeakRef
//      approach — we just terminate when all hooks unmount.

let _workerInstance: Worker | null = null;
let _workerRefCount = 0;

function acquireWorker(): Worker {
  if (!_workerInstance) {
    const blob = new Blob([WORKER_SRC], { type: 'application/javascript' });
    const url  = URL.createObjectURL(blob);
    _workerInstance = new Worker(url);
    // The blob URL can be revoked immediately; the worker holds its own copy.
    URL.revokeObjectURL(url);
  }
  _workerRefCount++;
  return _workerInstance;
}

function releaseWorker(): void {
  _workerRefCount--;
  if (_workerRefCount <= 0) {
    _workerInstance?.terminate();
    _workerInstance = null;
    _workerRefCount = 0;
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

const EMPTY: { snapPoints: SvgSnapPoint[]; svgCurves: SvgCurve[] } = {
  snapPoints: [],
  svgCurves:  [],
};

export function useSvgSnapPoints(
  svgContent: string | null,
  pdfDims: PdfDimensions | null,
): { snapPoints: SvgSnapPoint[]; svgCurves: SvgCurve[] } {

  const [result, setResult] = useState(EMPTY);

  // Stable ref to the worker so effect cleanup can unsubscribe correctly.
  const workerRef   = useRef<Worker | null>(null);
  // Incrementing request ID so stale responses from a previous SVG/dims pair
  // are silently discarded.
  const requestIdRef = useRef(0);

  useEffect(() => {
    // Acquire the shared worker on first mount.
    workerRef.current = acquireWorker();

    return () => {
      releaseWorker();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!svgContent || !pdfDims) {
      setResult(EMPTY);
      return;
    }

    const worker = workerRef.current;
    if (!worker) return;

    // Tag this request so we can ignore any in-flight older response.
    const requestId = ++requestIdRef.current;

    const handleMessage = (e: MessageEvent) => {
      const { type, requestId: rid, snapPoints, svgCurves, message } = e.data;
      // Discard stale responses.
      if (rid !== requestId) return;

      if (type === 'result') {
        setResult({ snapPoints, svgCurves });
        console.log(
          `[useSvgSnapPoints worker] ${snapPoints.length} snap pts, ` +
          `${svgCurves.length} curves`,
        );
      } else if (type === 'error') {
        console.error('[useSvgSnapPoints worker] parse error:', message);
        setResult(EMPTY);
      }
    };

    worker.addEventListener('message', handleMessage);

    // Post work to the worker — main thread returns immediately.
    worker.postMessage({
      type: 'compute',
      requestId,
      svgContent,
      pw: pdfDims.w,
      ph: pdfDims.h,
    });

    return () => {
      worker.removeEventListener('message', handleMessage);
    };
  }, [svgContent, pdfDims]);

  return result;
}
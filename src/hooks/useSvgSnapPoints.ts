'use client';

import { useMemo } from 'react';
import type { PdfDimensions } from '@/types/viewerTypes';
import { isDecorationElement, resolveStrokeWidth } from './svgDecorationFilter';

export type SvgSnapPointType = 'endpoint' | 'midpoint' | 'centroid' | 'intersection';

export interface SvgSnapPoint {
  nx: number; ny: number;
  type: SvgSnapPointType;
  strokeWidth: number;
  shapeId: string;
}

interface Vec2  { x: number; y: number }
interface Mat2D { a: number; b: number; c: number; d: number; e: number; f: number }

interface Segment {
  a: Vec2; b: Vec2;
  strokeWidth: number;
  shapeId: string;
  isArcApprox?: boolean;
}

const MAX_CHAIN_SEGS         = 500;
const MAX_SEGS_FOR_CHAIN     = 300;
const MAX_SEGS_FOR_INTERSECT = 800;

// ─── Matrix helpers ───────────────────────────────────────────────────────────

function identityMatrix(): Mat2D { return { a:1,b:0,c:0,d:1,e:0,f:0 }; }

function multiplyMatrix(m1: Mat2D, m2: Mat2D): Mat2D {
  return {
    a: m1.a*m2.a+m1.c*m2.b, b: m1.b*m2.a+m1.d*m2.b,
    c: m1.a*m2.c+m1.c*m2.d, d: m1.b*m2.c+m1.d*m2.d,
    e: m1.a*m2.e+m1.c*m2.f+m1.e, f: m1.b*m2.e+m1.d*m2.f+m1.f,
  };
}

function applyMatrix(m: Mat2D, v: Vec2): Vec2 {
  return { x: m.a*v.x+m.c*v.y+m.e, y: m.b*v.x+m.d*v.y+m.f };
}

function parseTransformAttr(transform: string | null): Mat2D {
  if (!transform) return identityMatrix();
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\(([^)]*)\)/g;
  const tfs: Mat2D[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(transform)) !== null) {
    const args = m[2].trim().split(/[\s,]+/).map(parseFloat);
    let mat = identityMatrix();
    switch (m[1]) {
      case 'matrix':    mat={a:args[0],b:args[1],c:args[2],d:args[3],e:args[4],f:args[5]}; break;
      case 'translate': mat={...identityMatrix(),e:args[0]??0,f:args[1]??0}; break;
      case 'scale': { const sx=args[0]??1,sy=args[1]??sx; mat={a:sx,b:0,c:0,d:sy,e:0,f:0}; break; }
      case 'rotate': {
        const ang=(args[0]??0)*Math.PI/180,cos=Math.cos(ang),sin=Math.sin(ang);
        const cx=args[1]??0,cy=args[2]??0;
        mat={a:cos,b:sin,c:-sin,d:cos,e:cx-cos*cx+sin*cy,f:cy-sin*cx-cos*cy}; break;
      }
      case 'skewX': { const t=Math.tan((args[0]??0)*Math.PI/180); mat={a:1,b:0,c:t,d:1,e:0,f:0}; break; }
      case 'skewY': { const t=Math.tan((args[0]??0)*Math.PI/180); mat={a:1,b:t,c:0,d:1,e:0,f:0}; break; }
    }
    tfs.push(mat);
  }
  return tfs.reduce((acc,t)=>multiplyMatrix(acc,t), identityMatrix());
}

function getCTM(el: Element, svgRoot: Element): Mat2D {
  const mats: Mat2D[] = [];
  let node: Element|null = el;
  while (node && node !== svgRoot.parentElement) {
    const t = node.getAttribute('transform');
    if (t) mats.unshift(parseTransformAttr(t));
    node = node.parentElement;
  }
  return mats.reduce((acc,m)=>multiplyMatrix(acc,m), identityMatrix());
}

interface VBTransform { sx:number; sy:number; tx:number; ty:number }

function buildViewBoxTransform(svgEl: SVGSVGElement, pdfW: number, pdfH: number): VBTransform {
  const vb = svgEl.getAttribute('viewBox');
  if (vb) {
    const [minX,minY,vbW,vbH] = vb.trim().split(/[\s,]+/).map(parseFloat);
    if ([minX,minY,vbW,vbH].every(n=>!isNaN(n)) && vbW>0 && vbH>0)
      return { sx:pdfW/vbW, sy:pdfH/vbH, tx:-minX*(pdfW/vbW), ty:-minY*(pdfH/vbH) };
  }
  const svgW = parseFloat(svgEl.getAttribute('width')??'0')||pdfW;
  const svgH = parseFloat(svgEl.getAttribute('height')??'0')||pdfH;
  return { sx:svgW>0?pdfW/svgW:1, sy:svgH>0?pdfH/svgH:1, tx:0, ty:0 };
}

function applyVBT(v: Vec2, t: VBTransform): Vec2 { return { x:v.x*t.sx+t.tx, y:v.y*t.sy+t.ty }; }

function attr(el: Element, n: string): string { return el.getAttribute(n)??''; }
function numAttr(el: Element, n: string, fb=0): number { const v=parseFloat(attr(el,n)); return isNaN(v)?fb:v; }

// ─── Curve helpers ────────────────────────────────────────────────────────────

function cubicBez(p0:Vec2,p1:Vec2,p2:Vec2,p3:Vec2,t:number):Vec2 {
  const u=1-t;
  return {x:u*u*u*p0.x+3*u*u*t*p1.x+3*u*t*t*p2.x+t*t*t*p3.x,
          y:u*u*u*p0.y+3*u*u*t*p1.y+3*u*t*t*p2.y+t*t*t*p3.y};
}
function quadBez(p0:Vec2,p1:Vec2,p2:Vec2,t:number):Vec2 {
  const u=1-t;
  return {x:u*u*p0.x+2*u*t*p1.x+t*t*p2.x, y:u*u*p0.y+2*u*t*p1.y+t*t*p2.y};
}

function arcToPoints(x1:number,y1:number,rx:number,ry:number,xRot:number,
    largeArc:number,sweep:number,x2:number,y2:number,steps=12):Vec2[] {
  if (rx===0||ry===0) return [{x:x2,y:y2}];
  const phi=(xRot*Math.PI)/180, cosPhi=Math.cos(phi), sinPhi=Math.sin(phi);
  const dx2=(x1-x2)/2, dy2=(y1-y2)/2;
  const x1p= cosPhi*dx2+sinPhi*dy2, y1p=-sinPhi*dx2+cosPhi*dy2;
  let rxA=Math.abs(rx), ryA=Math.abs(ry);
  const lam=(x1p*x1p)/(rxA*rxA)+(y1p*y1p)/(ryA*ryA);
  if (lam>1){rxA*=Math.sqrt(lam);ryA*=Math.sqrt(lam);}
  const sign=largeArc===sweep?-1:1;
  const sq=Math.max(0,(rxA*rxA*ryA*ryA-rxA*rxA*y1p*y1p-ryA*ryA*x1p*x1p)/(rxA*rxA*y1p*y1p+ryA*ryA*x1p*x1p));
  const coef=sign*Math.sqrt(sq);
  const cxp=coef*(rxA*y1p)/ryA, cyp=coef*-(ryA*x1p)/rxA;
  const cx=cosPhi*cxp-sinPhi*cyp+(x1+x2)/2, cy=sinPhi*cxp+cosPhi*cyp+(y1+y2)/2;
  const ux=(x1p-cxp)/rxA, uy=(y1p-cyp)/ryA, vx=(-x1p-cxp)/rxA, vy=(-y1p-cyp)/ryA;
  const n=Math.sqrt(ux*ux+uy*uy);
  const theta1=uy>=0?Math.acos(Math.max(-1,Math.min(1,ux/n))):-Math.acos(Math.max(-1,Math.min(1,ux/n)));
  const mag=Math.sqrt((ux*ux+uy*uy)*(vx*vx+vy*vy));
  let dTheta=(ux*vy-uy*vx)>=0?Math.acos(Math.max(-1,Math.min(1,(ux*vx+uy*vy)/mag))):-Math.acos(Math.max(-1,Math.min(1,(ux*vx+uy*vy)/mag)));
  if (!sweep&&dTheta>0) dTheta-=2*Math.PI;
  if ( sweep&&dTheta<0) dTheta+=2*Math.PI;
  const pts:Vec2[]=[];
  for (let i=1;i<=steps;i++){
    const t=i/steps, ang=theta1+t*dTheta;
    pts.push({x:cosPhi*rxA*Math.cos(ang)-sinPhi*ryA*Math.sin(ang)+cx,
               y:sinPhi*rxA*Math.cos(ang)+cosPhi*ryA*Math.sin(ang)+cy});
  }
  return pts;
}

// ─── pathToSegments ───────────────────────────────────────────────────────────

function pathToSegments(d: string, sw: number, shapeId: string): Segment[] {
  const segs: Segment[] = [];
  let cx=0,cy=0,sx=0,sy=0,lastCp:Vec2|null=null;

  const push = (a:Vec2,b:Vec2,approx=false) => segs.push({a,b,strokeWidth:sw,shapeId,isArcApprox:approx});
  const poly = (pts:Vec2[],approx:boolean) => { for(let i=0;i<pts.length-1;i++) push(pts[i],pts[i+1],approx); };

  const re=/([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
  let m:RegExpExecArray|null;
  while((m=re.exec(d))!==null) {
    const cmd=m[1], rel=cmd===cmd.toLowerCase()&&cmd!=='Z'&&cmd!=='z';
    const args=m[2].trim()===''?[]:m[2].trim().split(/[\s,]+/).map(parseFloat).filter(n=>!isNaN(n));
    const ox=rel?cx:0, oy=rel?cy:0;
    switch(cmd.toUpperCase()) {
      case 'M':
        for(let i=0;i+1<args.length;i+=2){
          const nx=args[i]+(i===0?ox:(rel?cx:0)), ny=args[i+1]+(i===0?oy:(rel?cy:0));
          if(i===0){cx=nx;cy=ny;sx=cx;sy=cy;}else{push({x:cx,y:cy},{x:nx,y:ny},false);cx=nx;cy=ny;}
        } lastCp=null; break;
      case 'L':
        for(let i=0;i+1<args.length;i+=2){const nx=args[i]+ox,ny=args[i+1]+oy;push({x:cx,y:cy},{x:nx,y:ny},false);cx=nx;cy=ny;}
        lastCp=null; break;
      case 'H':
        for(const ax of args){const nx=ax+ox;push({x:cx,y:cy},{x:nx,y:cy},false);cx=nx;} lastCp=null; break;
      case 'V':
        for(const ay of args){const ny=ay+oy;push({x:cx,y:cy},{x:cx,y:ny},false);cy=ny;} lastCp=null; break;
      case 'C':
        for(let i=0;i+5<args.length;i+=6){
          const p0:Vec2={x:cx,y:cy},p1:Vec2={x:args[i]+ox,y:args[i+1]+oy},
                p2:Vec2={x:args[i+2]+ox,y:args[i+3]+oy},p3:Vec2={x:args[i+4]+ox,y:args[i+5]+oy};
          const pts=[p0];for(let t=1;t<=8;t++)pts.push(cubicBez(p0,p1,p2,p3,t/8));
          poly(pts,true);lastCp=p2;cx=p3.x;cy=p3.y;
        } break;
      case 'S':
        for(let i=0;i+3<args.length;i+=4){
          const p0:Vec2={x:cx,y:cy},p1:Vec2=lastCp?{x:2*cx-lastCp.x,y:2*cy-lastCp.y}:{x:cx,y:cy},
                p2:Vec2={x:args[i]+ox,y:args[i+1]+oy},p3:Vec2={x:args[i+2]+ox,y:args[i+3]+oy};
          const pts=[p0];for(let t=1;t<=8;t++)pts.push(cubicBez(p0,p1,p2,p3,t/8));
          poly(pts,true);lastCp=p2;cx=p3.x;cy=p3.y;
        } break;
      case 'Q':
        for(let i=0;i+3<args.length;i+=4){
          const p0:Vec2={x:cx,y:cy},p1:Vec2={x:args[i]+ox,y:args[i+1]+oy},p2:Vec2={x:args[i+2]+ox,y:args[i+3]+oy};
          const pts=[p0];for(let t=1;t<=6;t++)pts.push(quadBez(p0,p1,p2,t/6));
          poly(pts,true);lastCp=p1;cx=p2.x;cy=p2.y;
        } break;
      case 'T':
        for(let i=0;i+1<args.length;i+=2){
          const p0:Vec2={x:cx,y:cy},p1:Vec2=lastCp?{x:2*cx-lastCp.x,y:2*cy-lastCp.y}:{x:cx,y:cy},p2:Vec2={x:args[i]+ox,y:args[i+1]+oy};
          const pts=[p0];for(let t=1;t<=6;t++)pts.push(quadBez(p0,p1,p2,t/6));
          poly(pts,true);lastCp=p1;cx=p2.x;cy=p2.y;
        } break;
      case 'A':
        for(let i=0;i+6<args.length;i+=7){
          const x2=args[i+5]+ox,y2=args[i+6]+oy;
          const arcPts=arcToPoints(cx,cy,args[i],args[i+1],args[i+2],args[i+3],args[i+4],x2,y2);
          poly([{x:cx,y:cy},...arcPts],true);
          cx=x2;cy=y2;lastCp=null;
        } break;
      case 'Z':
        if(cx!==sx||cy!==sy) push({x:cx,y:cy},{x:sx,y:sy},false);
        cx=sx;cy=sy;lastCp=null; break;
    }
  }
  return segs;
}

// ─── Element extractors ───────────────────────────────────────────────────────

function extractLine(el:Element,sw:number,id:string):Segment[]{
  return [{a:{x:numAttr(el,'x1'),y:numAttr(el,'y1')},b:{x:numAttr(el,'x2'),y:numAttr(el,'y2')},strokeWidth:sw,shapeId:id}];
}
function extractPolyPoints(el:Element,sw:number,id:string,close:boolean):Segment[]{
  const raw=attr(el,'points').trim(); if(!raw)return[];
  const nums=raw.split(/[\s,]+/).map(parseFloat).filter(n=>!isNaN(n));
  const pts:Vec2[]=[]; for(let i=0;i+1<nums.length;i+=2)pts.push({x:nums[i],y:nums[i+1]});
  if(pts.length<2)return[];
  const segs:Segment[]=[];
  for(let i=0;i<pts.length-1;i++)segs.push({a:pts[i],b:pts[i+1],strokeWidth:sw,shapeId:id});
  if(close&&pts.length>2)segs.push({a:pts[pts.length-1],b:pts[0],strokeWidth:sw,shapeId:id});
  return segs;
}
function extractRect(el:Element,sw:number,id:string):Segment[]{
  const x=numAttr(el,'x'),y=numAttr(el,'y'),w=numAttr(el,'width'),h=numAttr(el,'height');
  if(w<=0||h<=0)return[];
  const p=[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}];
  return [{a:p[0],b:p[1],strokeWidth:sw,shapeId:id},{a:p[1],b:p[2],strokeWidth:sw,shapeId:id},
          {a:p[2],b:p[3],strokeWidth:sw,shapeId:id},{a:p[3],b:p[0],strokeWidth:sw,shapeId:id}];
}
function extractCircle(el:Element,sw:number,id:string):Segment[]{
  const cx=numAttr(el,'cx'),cy=numAttr(el,'cy'),r=numAttr(el,'r');
  if(r<=0)return[];
  return pathToSegments(`M${cx-r},${cy} A${r},${r} 0 1 1 ${cx+r},${cy} A${r},${r} 0 1 1 ${cx-r},${cy} Z`,sw,id);
}
function extractEllipse(el:Element,sw:number,id:string):Segment[]{
  const cx=numAttr(el,'cx'),cy=numAttr(el,'cy'),rx=numAttr(el,'rx'),ry=numAttr(el,'ry');
  if(rx<=0||ry<=0)return[];
  return pathToSegments(`M${cx-rx},${cy} A${rx},${ry} 0 1 1 ${cx+rx},${cy} A${rx},${ry} 0 1 1 ${cx-rx},${cy} Z`,sw,id);
}

// ─── Chain assembly ───────────────────────────────────────────────────────────

const CHAIN_TOL = 5.0;
function snapKey(v:Vec2,dx:number,dy:number){return `${Math.round(v.x/CHAIN_TOL)+dx},${Math.round(v.y/CHAIN_TOL)+dy}`;}

function assembleChain(segs: Segment[]): Segment[] | null {
  if (segs.length===0) return null;
  if (segs.length===1) return [segs[0]];
  if (segs.length>MAX_CHAIN_SEGS) return null;
  const shapeId=segs[0].shapeId;
  type Entry={idx:number;end:'a'|'b'};
  const epMap=new Map<string,Entry[]>();
  const reg=(v:Vec2,idx:number,end:'a'|'b')=>{
    for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){
      const k=snapKey(v,dx,dy);const arr=epMap.get(k)??[];arr.push({idx,end});epMap.set(k,arr);
    }
  };
  for(let i=0;i<segs.length;i++){reg(segs[i].a,i,'a');reg(segs[i].b,i,'b');}
  const used=new Set<number>([0]);
  const ordered:Segment[]=[segs[0]];
  let tail=segs[0].b;
  while(ordered.length<segs.length){
    const candidates=epMap.get(snapKey(tail,0,0))??[];
    let advanced=false;
    for(const{idx,end}of candidates){
      if(used.has(idx))continue;
      const seg=segs[idx];
      const cp=end==='a'?seg.a:seg.b;
      if(Math.hypot(cp.x-tail.x,cp.y-tail.y)>CHAIN_TOL)continue;
      used.add(idx);
      if(end==='a'){ordered.push(seg);tail=seg.b;}
      else{ordered.push({...seg,a:seg.b,b:seg.a,shapeId});tail=seg.a;}
      advanced=true;break;
    }
    if(!advanced)break;
  }
  if(ordered.length!==segs.length)return null;
  return ordered;
}

// ─── emitArcRun ──────────────────────────────────────────────────────────────

type RawPoint = Omit<SvgSnapPoint,'nx'|'ny'> & Vec2;

function emitArcRun(run:Segment[],sw:number,shapeId:string,out:RawPoint[]):void {
  if(run.length===0)return;
  const midIdx=Math.floor(run.length/2);
  out.push({...run[0].a,             type:'endpoint',strokeWidth:sw,shapeId});
  out.push({...run[midIdx].a,        type:'midpoint',strokeWidth:sw,shapeId});
  out.push({...run[run.length-1].b,  type:'endpoint',strokeWidth:sw,shapeId});
}

// ─── buildSnapPointsForShape ──────────────────────────────────────────────────

function buildSnapPointsForShape(segs:Segment[],shapeId:string):RawPoint[] {
  if(segs.length===0)return[];
  const sw=segs[0].strokeWidth;
  const out:RawPoint[]=[];

  function processFlat(list:Segment[]) {
    let i=0;
    while(i<list.length){
      if(list[i].isArcApprox){
        const run:Segment[]=[];
        while(i<list.length&&list[i].isArcApprox)run.push(list[i++]);
        emitArcRun(run,sw,shapeId,out);
      } else {
        const seg=list[i++];
        out.push({...seg.a,type:'endpoint',strokeWidth:sw,shapeId});
        out.push({x:(seg.a.x+seg.b.x)/2,y:(seg.a.y+seg.b.y)/2,type:'midpoint',strokeWidth:sw,shapeId});
        if(i>=list.length||list[i].isArcApprox){
          out.push({...seg.b,type:'endpoint',strokeWidth:sw,shapeId});
        }
      }
    }
  }

  if(segs.length===1){
    if(segs[0].isArcApprox){emitArcRun(segs,sw,shapeId,out);}
    else{
      out.push({...segs[0].a,type:'endpoint',strokeWidth:sw,shapeId});
      out.push({x:(segs[0].a.x+segs[0].b.x)/2,y:(segs[0].a.y+segs[0].b.y)/2,type:'midpoint',strokeWidth:sw,shapeId});
      out.push({...segs[0].b,type:'endpoint',strokeWidth:sw,shapeId});
    }
    return out;
  }

  if(segs.length>MAX_SEGS_FOR_CHAIN){processFlat(segs);return out;}

  const ordered=assembleChain(segs);
  if(ordered!==null){processFlat(ordered);return out;}

  processFlat(segs);
  return out;
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────

function polygonCentroid(pts:Vec2[]):Vec2 {
  let area=0,cx=0,cy=0;
  for(let i=0,j=pts.length-1;i<pts.length;j=i++){
    const cross=pts[j].x*pts[i].y-pts[i].x*pts[j].y;
    area+=cross;cx+=(pts[j].x+pts[i].x)*cross;cy+=(pts[j].y+pts[i].y)*cross;
  }
  area/=2;
  if(Math.abs(area)<1e-9)return{x:pts.reduce((s,p)=>s+p.x,0)/pts.length,y:pts.reduce((s,p)=>s+p.y,0)/pts.length};
  return{x:cx/(6*area),y:cy/(6*area)};
}

function segmentIntersection(a:Vec2,b:Vec2,c:Vec2,d:Vec2):Vec2|null {
  const r={x:b.x-a.x,y:b.y-a.y},s={x:d.x-c.x,y:d.y-c.y};
  const denom=r.x*s.y-r.y*s.x;
  if(Math.abs(denom)<1e-10)return null;
  const t=((c.x-a.x)*s.y-(c.y-a.y)*s.x)/denom;
  const u=((c.x-a.x)*r.y-(c.y-a.y)*r.x)/denom;
  const EPS=1e-9;
  if(t>=EPS&&t<=1-EPS&&u>=EPS&&u<=1-EPS)return{x:a.x+t*r.x,y:a.y+t*r.y};
  return null;
}

// FIX: Removed shapeId same-shape guard — walls from one large path element
// crossing walls from another would be skipped. We only skip arc-approx segments
// to avoid false intersections inside curved geometry.
// We also use a spatial grid to avoid O(n²) on large files.

function buildGrid(segs: Segment[], cellSize: number): Map<string, number[]> {
  const grid = new Map<string, number[]>();
  const addCell = (gx: number, gy: number, idx: number) => {
    const k = `${gx},${gy}`;
    const arr = grid.get(k) ?? [];
    arr.push(idx);
    grid.set(k, arr);
  };
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const x0 = Math.floor(Math.min(s.a.x, s.b.x) / cellSize);
    const x1 = Math.floor(Math.max(s.a.x, s.b.x) / cellSize);
    const y0 = Math.floor(Math.min(s.a.y, s.b.y) / cellSize);
    const y1 = Math.floor(Math.max(s.a.y, s.b.y) / cellSize);
    for (let gx = x0; gx <= x1; gx++)
      for (let gy = y0; gy <= y1; gy++)
        addCell(gx, gy, i);
  }
  return grid;
}

function computeIntersections(segs: Segment[]): RawPoint[] {
  const out: RawPoint[] = [];
  // Only use non-arc segments for intersection — arc tessellation points
  // produce masses of false intersections
  const real = segs.filter(s => !s.isArcApprox);
  if (real.length === 0 || real.length > MAX_SEGS_FOR_INTERSECT) return out;

  // Determine a reasonable cell size (~10% of average segment length or 20px min)
  const avgLen = real.reduce((s, seg) => s + Math.hypot(seg.b.x - seg.a.x, seg.b.y - seg.a.y), 0) / real.length;
  const cellSize = Math.max(20, avgLen * 3);

  const grid = buildGrid(real, cellSize);
  const checked = new Set<string>();

  for (let i = 0; i < real.length; i++) {
    const sa = real[i];
    const x0 = Math.floor(Math.min(sa.a.x, sa.b.x) / cellSize);
    const x1 = Math.floor(Math.max(sa.a.x, sa.b.x) / cellSize);
    const y0 = Math.floor(Math.min(sa.a.y, sa.b.y) / cellSize);
    const y1 = Math.floor(Math.max(sa.a.y, sa.b.y) / cellSize);

    const candidates = new Set<number>();
    for (let gx = x0; gx <= x1; gx++)
      for (let gy = y0; gy <= y1; gy++)
        (grid.get(`${gx},${gy}`) ?? []).forEach(j => candidates.add(j));

    for (const j of candidates) {
      if (j <= i) continue;
      const key = `${i}:${j}`;
      if (checked.has(key)) continue;
      checked.add(key);

      const sb = real[j];
      // Skip segments that share an endpoint (they "intersect" trivially at the join)
      const sharesEndpoint =
        (Math.hypot(sa.a.x - sb.a.x, sa.a.y - sb.a.y) < 2) ||
        (Math.hypot(sa.a.x - sb.b.x, sa.a.y - sb.b.y) < 2) ||
        (Math.hypot(sa.b.x - sb.a.x, sa.b.y - sb.a.y) < 2) ||
        (Math.hypot(sa.b.x - sb.b.x, sa.b.y - sb.b.y) < 2);
      if (sharesEndpoint) continue;

      const pt = segmentIntersection(sa.a, sa.b, sb.a, sb.b);
      if (pt) {
        out.push({
          ...pt,
          type: 'intersection',
          strokeWidth: Math.max(sa.strokeWidth, sb.strokeWidth),
          shapeId: `${sa.shapeId}:${sb.shapeId}`,
        });
      }
    }
  }
  return out;
}

const MERGE_DIST_PX=3;
function dedup(rawPts:RawPoint[]):RawPoint[] {
  const out:RawPoint[]=[];const d2=MERGE_DIST_PX*MERGE_DIST_PX;
  for(const pt of rawPts)if(!out.some(e=>(pt.x-e.x)**2+(pt.y-e.y)**2<d2))out.push(pt);
  return out;
}

function parseSvgSegments(svgEl:Element):Segment[] {
  if(typeof window==='undefined')return[];
  const allSegs:Segment[]=[];let autoId=0;
  svgEl.querySelectorAll('line,polyline,polygon,path,rect,circle,ellipse').forEach(el=>{
    const sw=resolveStrokeWidth(el);
    if(isDecorationElement(el,sw))return;
    const id=el.id||el.getAttribute('data-id')||`shape-${autoId++}`;
    const ctm=getCTM(el,svgEl);
    const tag=el.tagName.toLowerCase();
    let raw:Segment[]=[];
    switch(tag){
      case 'line':     raw=extractLine(el,sw,id);              break;
      case 'polyline': raw=extractPolyPoints(el,sw,id,false);  break;
      case 'polygon':  raw=extractPolyPoints(el,sw,id,true);   break;
      case 'path':     raw=pathToSegments(attr(el,'d'),sw,id); break;
      case 'rect':     raw=extractRect(el,sw,id);              break;
      case 'circle':   raw=extractCircle(el,sw,id);            break;
      case 'ellipse':  raw=extractEllipse(el,sw,id);           break;
    }
    for(const seg of raw)allSegs.push({...seg,a:applyMatrix(ctm,seg.a),b:applyMatrix(ctm,seg.b)});
  });
  return allSegs;
}

export const SVG_SNAP_COLOURS:Record<string,string>={
  endpoint:'rgba(251,191,36,0.90)',midpoint:'rgba(52,211,153,0.80)',
  centroid:'rgba(167,139,250,0.85)',intersection:'rgba(248,113,113,0.85)',
};

export function useSvgSnapPoints(svgContent:string|null,pdfDimensions:PdfDimensions|null):SvgSnapPoint[] {
  return useMemo<SvgSnapPoint[]>(()=>{
    if(!svgContent||!pdfDimensions)return[];
    const{w:pdfW,h:pdfH}=pdfDimensions;
    const parser=new DOMParser();
    const doc=parser.parseFromString(svgContent,'image/svg+xml');
    if(doc.querySelector('parsererror')){console.warn('[useSvgSnapPoints] SVG parse error');return[];}
    const svgEl=doc.querySelector('svg') as SVGSVGElement|null;
    if(!svgEl)return[];

    const vbt=buildViewBoxTransform(svgEl,pdfW,pdfH);
    const allSegs=parseSvgSegments(svgEl);
    const transformedSegs:Segment[]=allSegs.map(seg=>({...seg,a:applyVBT(seg.a,vbt),b:applyVBT(seg.b,vbt)}));
    if(transformedSegs.length===0)return[];

    const byShape=new Map<string,Segment[]>();
    for(const seg of transformedSegs){const arr=byShape.get(seg.shapeId)??[];arr.push(seg);byShape.set(seg.shapeId,arr);}

    const raw:RawPoint[]=[];

    for(const[shapeId,segs]of byShape){
      raw.push(...buildSnapPointsForShape(segs,shapeId));

      if(segs.length>=3&&segs.length<=MAX_SEGS_FOR_CHAIN){
        const ordered=assembleChain(segs);
        if(ordered!==null){
          const verts=ordered.map(s=>s.a); verts.push(ordered[ordered.length-1].b);
          const isClosed=Math.hypot(verts[verts.length-1].x-verts[0].x,verts[verts.length-1].y-verts[0].y)<CHAIN_TOL*2;
          if(isClosed){
            const realV=ordered.filter(s=>!s.isArcApprox).map(s=>s.a);
            const poly=realV.length>=3?realV:verts.slice(0,-1);
            const c=polygonCentroid(poly);
            if(c.x>=0&&c.x<=pdfW&&c.y>=0&&c.y<=pdfH)
              raw.push({...c,type:'centroid',strokeWidth:segs[0].strokeWidth,shapeId});
          }
        }
      }
    }

    // FIX: Use new grid-based cross-shape intersection detection
    raw.push(...computeIntersections(transformedSegs));

    const dedupedRaw=dedup(raw);
    const snapPoints:SvgSnapPoint[]=dedupedRaw
      .filter(p=>p.x>=0&&p.x<=pdfW&&p.y>=0&&p.y<=pdfH)
      .map(({x,y,type,strokeWidth,shapeId})=>({nx:x/pdfW,ny:y/pdfH,type,strokeWidth,shapeId}));

    const tc=snapPoints.reduce((acc,p)=>{acc[p.type]=(acc[p.type]||0)+1;return acc;},{} as Record<string,number>);
    console.log(`[useSvgSnapPoints] ${snapPoints.length} pts (${transformedSegs.length} segs, ${byShape.size} shapes) — `+Object.entries(tc).map(([k,v])=>`${k}:${v}`).join(' '));
    return snapPoints;
  },[svgContent,pdfDimensions]);
}
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
interface Mat2D { a:number; b:number; c:number; d:number; e:number; f:number }
interface Segment {
  a: Vec2; b: Vec2;
  strokeWidth: number;
  shapeId: string;
  isArcApprox?: boolean;
}
type RawPoint = Omit<SvgSnapPoint,'nx'|'ny'> & Vec2;

// ─── Constants ────────────────────────────────────────────────────────────────

const BEND_ANGLE_DEG     = 10;
const CLUSTER_TOL        = 4.0;   // FIX: was 6.0, tighter to not merge nearby but distinct corners
const MERGE_DIST_PX      = 1.2;   // FIX: was 2.5, was merging distinct wall corners
const MAX_CHAIN_SEGS     = 500;
const MAX_SEGS_FOR_CHAIN = 300;
const MAX_SEGS_INTERSECT = 5000;
const T_JOINT_TOL        = 4.0;   // FIX: was 5.0

// ─── Matrix helpers ───────────────────────────────────────────────────────────

function identMat(): Mat2D { return {a:1,b:0,c:0,d:1,e:0,f:0}; }
function mulMat(m1:Mat2D, m2:Mat2D): Mat2D {
  return {
    a:m1.a*m2.a+m1.c*m2.b, b:m1.b*m2.a+m1.d*m2.b,
    c:m1.a*m2.c+m1.c*m2.d, d:m1.b*m2.c+m1.d*m2.d,
    e:m1.a*m2.e+m1.c*m2.f+m1.e, f:m1.b*m2.e+m1.d*m2.f+m1.f,
  };
}
function applyMat(m:Mat2D, v:Vec2): Vec2 {
  return {x:m.a*v.x+m.c*v.y+m.e, y:m.b*v.x+m.d*v.y+m.f};
}
function parseTfm(transform: string|null): Mat2D {
  if (!transform) return identMat();
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\(([^)]*)\)/g;
  const tfs: Mat2D[] = [];
  let m: RegExpExecArray|null;
  while ((m = re.exec(transform)) !== null) {
    const a = m[2].trim().split(/[\s,]+/).map(parseFloat);
    let mat = identMat();
    switch (m[1]) {
      case 'matrix':    mat={a:a[0],b:a[1],c:a[2],d:a[3],e:a[4],f:a[5]}; break;
      case 'translate': mat={...identMat(),e:a[0]??0,f:a[1]??0}; break;
      case 'scale':   { const sx=a[0]??1,sy=a[1]??sx; mat={a:sx,b:0,c:0,d:sy,e:0,f:0}; break; }
      case 'rotate':  {
        const ang=(a[0]??0)*Math.PI/180,cos=Math.cos(ang),sin=Math.sin(ang);
        const cx=a[1]??0,cy=a[2]??0;
        mat={a:cos,b:sin,c:-sin,d:cos,e:cx-cos*cx+sin*cy,f:cy-sin*cx-cos*cy}; break;
      }
      case 'skewX': { const t=Math.tan((a[0]??0)*Math.PI/180); mat={a:1,b:0,c:t,d:1,e:0,f:0}; break; }
      case 'skewY': { const t=Math.tan((a[0]??0)*Math.PI/180); mat={a:1,b:t,c:0,d:1,e:0,f:0}; break; }
    }
    tfs.push(mat);
  }
  return tfs.reduce((acc,t)=>mulMat(acc,t), identMat());
}
function getCTM(el:Element, root:Element): Mat2D {
  const mats:Mat2D[] = [];
  let node:Element|null = el;
  while (node && node !== root.parentElement) {
    const t = node.getAttribute('transform');
    if (t) mats.unshift(parseTfm(t));
    node = node.parentElement;
  }
  return mats.reduce((acc,m)=>mulMat(acc,m), identMat());
}

interface VBT { sx:number; sy:number; tx:number; ty:number }
function buildVBT(svgEl:SVGSVGElement, pdfW:number, pdfH:number): VBT {
  const vb = svgEl.getAttribute('viewBox');
  if (vb) {
    const [minX,minY,vbW,vbH] = vb.trim().split(/[\s,]+/).map(parseFloat);
    if ([minX,minY,vbW,vbH].every(n=>!isNaN(n)) && vbW>0 && vbH>0)
      return {sx:pdfW/vbW, sy:pdfH/vbH, tx:-minX*(pdfW/vbW), ty:-minY*(pdfH/vbH)};
  }
  const svgW=parseFloat(svgEl.getAttribute('width')??'0')||pdfW;
  const svgH=parseFloat(svgEl.getAttribute('height')??'0')||pdfH;
  return {sx:svgW>0?pdfW/svgW:1, sy:svgH>0?pdfH/svgH:1, tx:0, ty:0};
}
function applyVBT(v:Vec2, t:VBT): Vec2 { return {x:v.x*t.sx+t.tx, y:v.y*t.sy+t.ty}; }

function na(el:Element, n:string, fb=0): number {
  const v=parseFloat(el.getAttribute(n)??''); return isNaN(v)?fb:v;
}

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
  const phi=(xRot*Math.PI)/180,cosPhi=Math.cos(phi),sinPhi=Math.sin(phi);
  const dx2=(x1-x2)/2,dy2=(y1-y2)/2;
  const x1p=cosPhi*dx2+sinPhi*dy2,y1p=-sinPhi*dx2+cosPhi*dy2;
  let rxA=Math.abs(rx),ryA=Math.abs(ry);
  const lam=(x1p*x1p)/(rxA*rxA)+(y1p*y1p)/(ryA*ryA);
  if(lam>1){rxA*=Math.sqrt(lam);ryA*=Math.sqrt(lam);}
  const sign=largeArc===sweep?-1:1;
  const sq=Math.max(0,(rxA*rxA*ryA*ryA-rxA*rxA*y1p*y1p-ryA*ryA*x1p*x1p)
                     /(rxA*rxA*y1p*y1p+ryA*ryA*x1p*x1p));
  const coef=sign*Math.sqrt(sq);
  const cxp=coef*(rxA*y1p)/ryA,cyp=coef*-(ryA*x1p)/rxA;
  const cx=cosPhi*cxp-sinPhi*cyp+(x1+x2)/2,cy=sinPhi*cxp+cosPhi*cyp+(y1+y2)/2;
  const ux=(x1p-cxp)/rxA,uy=(y1p-cyp)/ryA,vx=(-x1p-cxp)/rxA,vy=(-y1p-cyp)/ryA;
  const n=Math.sqrt(ux*ux+uy*uy);
  const theta1=uy>=0?Math.acos(Math.max(-1,Math.min(1,ux/n))):-Math.acos(Math.max(-1,Math.min(1,ux/n)));
  const mag=Math.sqrt((ux*ux+uy*uy)*(vx*vx+vy*vy));
  let dTheta=(ux*vy-uy*vx)>=0
    ?Math.acos(Math.max(-1,Math.min(1,(ux*vx+uy*vy)/mag)))
    :-Math.acos(Math.max(-1,Math.min(1,(ux*vx+uy*vy)/mag)));
  if(!sweep&&dTheta>0) dTheta-=2*Math.PI;
  if(sweep&&dTheta<0) dTheta+=2*Math.PI;
  const pts:Vec2[]=[];
  for(let i=1;i<=steps;i++){
    const t=i/steps,ang=theta1+t*dTheta;
    pts.push({x:cosPhi*rxA*Math.cos(ang)-sinPhi*ryA*Math.sin(ang)+cx,
               y:sinPhi*rxA*Math.cos(ang)+cosPhi*ryA*Math.sin(ang)+cy});
  }
  return pts;
}

// ─── pathToSegments ───────────────────────────────────────────────────────────

function pathToSegments(d:string, sw:number, shapeId:string): Segment[] {
  const segs:Segment[]=[];
  let cx=0,cy=0,sx=0,sy=0,lastCp:Vec2|null=null;
  const push=(a:Vec2,b:Vec2,approx=false)=>segs.push({a,b,strokeWidth:sw,shapeId,isArcApprox:approx});
  const poly=(pts:Vec2[],approx:boolean)=>{for(let i=0;i<pts.length-1;i++)push(pts[i],pts[i+1],approx);};
  const re=/([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
  let m:RegExpExecArray|null;
  while((m=re.exec(d))!==null){
    const cmd=m[1],rel=cmd===cmd.toLowerCase()&&cmd!=='Z'&&cmd!=='z';
    const args=m[2].trim()===''?[]:m[2].trim().split(/[\s,]+/).map(parseFloat).filter(n=>!isNaN(n));
    const ox=rel?cx:0,oy=rel?cy:0;
    switch(cmd.toUpperCase()){
      case 'M':
        for(let i=0;i+1<args.length;i+=2){
          const nx=args[i]+(i===0?ox:(rel?cx:0)),ny=args[i+1]+(i===0?oy:(rel?cy:0));
          if(i===0){cx=nx;cy=ny;sx=cx;sy=cy;}else{push({x:cx,y:cy},{x:nx,y:ny});cx=nx;cy=ny;}
        }lastCp=null;break;
      case 'L':
        for(let i=0;i+1<args.length;i+=2){const nx=args[i]+ox,ny=args[i+1]+oy;push({x:cx,y:cy},{x:nx,y:ny});cx=nx;cy=ny;}
        lastCp=null;break;
      case 'H':for(const ax of args){const nx=ax+ox;push({x:cx,y:cy},{x:nx,y:cy});cx=nx;}lastCp=null;break;
      case 'V':for(const ay of args){const ny=ay+oy;push({x:cx,y:cy},{x:cx,y:ny});cy=ny;}lastCp=null;break;
      case 'C':
        for(let i=0;i+5<args.length;i+=6){
          const p0:Vec2={x:cx,y:cy},p1:Vec2={x:args[i]+ox,y:args[i+1]+oy},
                p2:Vec2={x:args[i+2]+ox,y:args[i+3]+oy},p3:Vec2={x:args[i+4]+ox,y:args[i+5]+oy};
          const pts=[p0];for(let t=1;t<=8;t++)pts.push(cubicBez(p0,p1,p2,p3,t/8));
          poly(pts,true);lastCp=p2;cx=p3.x;cy=p3.y;
        }break;
      case 'S':
        for(let i=0;i+3<args.length;i+=4){
          const p0:Vec2={x:cx,y:cy},p1:Vec2=lastCp?{x:2*cx-lastCp.x,y:2*cy-lastCp.y}:{x:cx,y:cy},
                p2:Vec2={x:args[i]+ox,y:args[i+1]+oy},p3:Vec2={x:args[i+2]+ox,y:args[i+3]+oy};
          const pts=[p0];for(let t=1;t<=8;t++)pts.push(cubicBez(p0,p1,p2,p3,t/8));
          poly(pts,true);lastCp=p2;cx=p3.x;cy=p3.y;
        }break;
      case 'Q':
        for(let i=0;i+3<args.length;i+=4){
          const p0:Vec2={x:cx,y:cy},p1:Vec2={x:args[i]+ox,y:args[i+1]+oy},p2:Vec2={x:args[i+2]+ox,y:args[i+3]+oy};
          const pts=[p0];for(let t=1;t<=6;t++)pts.push(quadBez(p0,p1,p2,t/6));
          poly(pts,true);lastCp=p1;cx=p2.x;cy=p2.y;
        }break;
      case 'T':
        for(let i=0;i+1<args.length;i+=2){
          const p0:Vec2={x:cx,y:cy},p1:Vec2=lastCp?{x:2*cx-lastCp.x,y:2*cy-lastCp.y}:{x:cx,y:cy},p2:Vec2={x:args[i]+ox,y:args[i+1]+oy};
          const pts=[p0];for(let t=1;t<=6;t++)pts.push(quadBez(p0,p1,p2,t/6));
          poly(pts,true);lastCp=p1;cx=p2.x;cy=p2.y;
        }break;
      case 'A':
        for(let i=0;i+6<args.length;i+=7){
          const x2=args[i+5]+ox,y2=args[i+6]+oy;
          const arcPts=arcToPoints(cx,cy,args[i],args[i+1],args[i+2],args[i+3],args[i+4],x2,y2);
          poly([{x:cx,y:cy},...arcPts],true);cx=x2;cy=y2;lastCp=null;
        }break;
      case 'Z':
        if(cx!==sx||cy!==sy)push({x:cx,y:cy},{x:sx,y:sy});
        cx=sx;cy=sy;lastCp=null;break;
    }
  }
  return segs;
}

// ─── Element extractors ───────────────────────────────────────────────────────

function extractLine(el:Element,sw:number,id:string):Segment[]{
  return [{a:{x:na(el,'x1'),y:na(el,'y1')},b:{x:na(el,'x2'),y:na(el,'y2')},strokeWidth:sw,shapeId:id}];
}
function extractPoly(el:Element,sw:number,id:string,close:boolean):Segment[]{
  const raw=el.getAttribute('points')?.trim();if(!raw)return[];
  const nums=raw.split(/[\s,]+/).map(parseFloat).filter(n=>!isNaN(n));
  const pts:Vec2[]=[];for(let i=0;i+1<nums.length;i+=2)pts.push({x:nums[i],y:nums[i+1]});
  if(pts.length<2)return[];
  const segs:Segment[]=[];
  for(let i=0;i<pts.length-1;i++)segs.push({a:pts[i],b:pts[i+1],strokeWidth:sw,shapeId:id});
  if(close&&pts.length>2)segs.push({a:pts[pts.length-1],b:pts[0],strokeWidth:sw,shapeId:id});
  return segs;
}
function extractRect(el:Element,sw:number,id:string):Segment[]{
  const x=na(el,'x'),y=na(el,'y'),w=na(el,'width'),h=na(el,'height');
  if(w<=0||h<=0)return[];
  const p=[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}];
  return[{a:p[0],b:p[1],strokeWidth:sw,shapeId:id},{a:p[1],b:p[2],strokeWidth:sw,shapeId:id},
         {a:p[2],b:p[3],strokeWidth:sw,shapeId:id},{a:p[3],b:p[0],strokeWidth:sw,shapeId:id}];
}
function extractCircle(el:Element,sw:number,id:string):Segment[]{
  const cx=na(el,'cx'),cy=na(el,'cy'),r=na(el,'r');if(r<=0)return[];
  return pathToSegments(`M${cx-r},${cy} A${r},${r} 0 1 1 ${cx+r},${cy} A${r},${r} 0 1 1 ${cx-r},${cy} Z`,sw,id);
}
function extractEllipse(el:Element,sw:number,id:string):Segment[]{
  const cx=na(el,'cx'),cy=na(el,'cy'),rx=na(el,'rx'),ry=na(el,'ry');if(rx<=0||ry<=0)return[];
  return pathToSegments(`M${cx-rx},${cy} A${rx},${ry} 0 1 1 ${cx+rx},${cy} A${rx},${ry} 0 1 1 ${cx-rx},${cy} Z`,sw,id);
}

// ─── Angle helper ─────────────────────────────────────────────────────────────

function angleBetweenDeg(d1:Vec2, d2:Vec2): number {
  const l1=Math.hypot(d1.x,d1.y), l2=Math.hypot(d2.x,d2.y);
  if(l1<1e-9||l2<1e-9) return 0;
  // correct dot product
  const dot=(d1.x*d2.x+d1.y*d2.y)/(l1*l2);
  return Math.acos(Math.max(-1,Math.min(1,dot)))*180/Math.PI;
}

// ─── CORNER / BEND DETECTION ──────────────────────────────────────────────────

/**
 * PASS 1 — Bend-point detection within each shape's segment chain.
 * Emits intersection at every vertex where direction changes >= BEND_ANGLE_DEG.
 * FIX: each emitted point now uses the correct shapeId from its own segment.
 */
function detectBendCorners(segs: Segment[]): RawPoint[] {
  const out: RawPoint[] = [];
  const straight = segs.filter(s => !s.isArcApprox);
  if (straight.length < 2) return out;

  for (let i = 0; i < straight.length - 1; i++) {
    const sa = straight[i];
    const sb = straight[i + 1];

    // FIX: use the individual segment's shapeId and strokeWidth, not always segs[0]
    const sw  = Math.max(sa.strokeWidth, sb.strokeWidth);
    const sid = sa.shapeId;

    const dAB  = Math.hypot(sa.b.x-sb.a.x, sa.b.y-sb.a.y);
    const dABr = Math.hypot(sa.b.x-sb.b.x, sa.b.y-sb.b.y);
    const dAA  = Math.hypot(sa.a.x-sb.a.x, sa.a.y-sb.a.y);
    const dAAr = Math.hypot(sa.a.x-sb.b.x, sa.a.y-sb.b.y);

    // FIX: tolerance was 1.5 — use 0.01 for exact matches (same path element),
    // and fall back to a scaled tolerance based on segment length for near-matches
    const segLen = Math.max(
      Math.hypot(sa.b.x-sa.a.x, sa.b.y-sa.a.y),
      Math.hypot(sb.b.x-sb.a.x, sb.b.y-sb.a.y),
      1
    );
    const connTol = Math.max(0.01, segLen * 0.005); // 0.5% of segment length

    let vertex: Vec2|null = null;
    let inDir: Vec2, outDir: Vec2;

    if (dAB <= connTol) {
      vertex = sa.b;
      inDir  = {x:sa.b.x-sa.a.x, y:sa.b.y-sa.a.y};
      outDir = {x:sb.b.x-sb.a.x, y:sb.b.y-sb.a.y};
    } else if (dABr <= connTol) {
      vertex = sa.b;
      inDir  = {x:sa.b.x-sa.a.x, y:sa.b.y-sa.a.y};
      outDir = {x:sb.a.x-sb.b.x, y:sb.a.y-sb.b.y};
    } else if (dAA <= connTol) {
      vertex = sa.a;
      inDir  = {x:sa.a.x-sa.b.x, y:sa.a.y-sa.b.y};
      outDir = {x:sb.b.x-sb.a.x, y:sb.b.y-sb.a.y};
    } else if (dAAr <= connTol) {
      vertex = sa.a;
      inDir  = {x:sa.a.x-sa.b.x, y:sa.a.y-sa.b.y};
      outDir = {x:sb.a.x-sb.b.x, y:sb.a.y-sb.b.y};
    } else {
      continue;
    }

    const angle = angleBetweenDeg(inDir, outDir);
    if (angle >= BEND_ANGLE_DEG) {
      out.push({x:vertex.x, y:vertex.y, type:'intersection', strokeWidth:sw, shapeId:sid});
    }
  }
  return out;
}

// ─── Spatial grid ─────────────────────────────────────────────────────────────

function buildGrid(segs:Segment[], cellSize:number): Map<string,number[]> {
  const grid=new Map<string,number[]>();
  for(let i=0;i<segs.length;i++){
    const s=segs[i];
    const x0=Math.floor(Math.min(s.a.x,s.b.x)/cellSize);
    const x1=Math.floor(Math.max(s.a.x,s.b.x)/cellSize);
    const y0=Math.floor(Math.min(s.a.y,s.b.y)/cellSize);
    const y1=Math.floor(Math.max(s.a.y,s.b.y)/cellSize);
    for(let gx=x0;gx<=x1;gx++)for(let gy=y0;gy<=y1;gy++){
      const k=`${gx},${gy}`;const arr=grid.get(k)??[];arr.push(i);grid.set(k,arr);
    }
  }
  return grid;
}

function gridCandidates(segs:Segment[], i:number, grid:Map<string,number[]>, cellSize:number): Set<number> {
  const s=segs[i];
  const x0=Math.floor(Math.min(s.a.x,s.b.x)/cellSize);
  const x1=Math.floor(Math.max(s.a.x,s.b.x)/cellSize);
  const y0=Math.floor(Math.min(s.a.y,s.b.y)/cellSize);
  const y1=Math.floor(Math.max(s.a.y,s.b.y)/cellSize);
  const res=new Set<number>();
  for(let gx=x0;gx<=x1;gx++)for(let gy=y0;gy<=y1;gy++)
    (grid.get(`${gx},${gy}`)??[]).forEach(j=>res.add(j));
  return res;
}

function collinear(sa:Segment, sb:Segment): boolean {
  const ra={x:sa.b.x-sa.a.x,y:sa.b.y-sa.a.y};
  const rb={x:sb.b.x-sb.a.x,y:sb.b.y-sb.a.y};
  const la=Math.hypot(ra.x,ra.y),lb=Math.hypot(rb.x,rb.y);
  if(la<1e-6||lb<1e-6) return false;
  return Math.abs(ra.x/la*rb.y/lb - ra.y/la*rb.x/lb) < 0.09;
}

function ptToSegDist(p:Vec2,a:Vec2,b:Vec2):{dist:number;t:number;closest:Vec2} {
  const ax=b.x-a.x,ay=b.y-a.y,len2=ax*ax+ay*ay;
  if(len2<1e-10) return {dist:Math.hypot(p.x-a.x,p.y-a.y),t:0,closest:a};
  const t=Math.max(0,Math.min(1,((p.x-a.x)*ax+(p.y-a.y)*ay)/len2));
  const cx=a.x+t*ax,cy=a.y+t*ay;
  return {dist:Math.hypot(p.x-cx,p.y-cy),t,closest:{x:cx,y:cy}};
}

function segIntersect(a:Vec2,b:Vec2,c:Vec2,d:Vec2): Vec2|null {
  const rx=b.x-a.x,ry=b.y-a.y,sx=d.x-c.x,sy=d.y-c.y;
  const denom=rx*sy-ry*sx;
  if(Math.abs(denom)<1e-10) return null;
  const t=((c.x-a.x)*sy-(c.y-a.y)*sx)/denom;
  const u=((c.x-a.x)*ry-(c.y-a.y)*rx)/denom;
  if(t>=-1e-6&&t<=1+1e-6&&u>=-1e-6&&u<=1+1e-6)
    return {x:a.x+t*rx,y:a.y+t*ry};
  return null;
}

/**
 * PASS 2 — Cross-segment intersection + T-joint detection.
 * FIX: T_JOINT_TOL tightened to 4.0 to reduce false positives on furniture.
 */
function detectCrossIntersections(allSegs: Segment[]): RawPoint[] {
  const out: RawPoint[] = [];
  const real = allSegs.filter(s=>!s.isArcApprox);
  if (real.length < 2) return out;
  const working = real.length > MAX_SEGS_INTERSECT ? real.slice(0,MAX_SEGS_INTERSECT) : real;

  const avgLen = working.reduce((s,seg)=>s+Math.hypot(seg.b.x-seg.a.x,seg.b.y-seg.a.y),0)/working.length;
  const cellSize = Math.max(10, avgLen*2);
  const grid = buildGrid(working, cellSize);
  const checked = new Set<string>();

  for (let i=0;i<working.length;i++) {
    const sa=working[i];
    const cands=gridCandidates(working,i,grid,cellSize);
    for (const j of cands) {
      if(j<=i) continue;
      const key=`${i}:${j}`;
      if(checked.has(key)) continue;
      checked.add(key);
      const sb=working[j];
      if(collinear(sa,sb)) continue;

      const shareEp=
        Math.hypot(sa.a.x-sb.a.x,sa.a.y-sb.a.y)<0.5||
        Math.hypot(sa.a.x-sb.b.x,sa.a.y-sb.b.y)<0.5||
        Math.hypot(sa.b.x-sb.a.x,sa.b.y-sb.a.y)<0.5||
        Math.hypot(sa.b.x-sb.b.x,sa.b.y-sb.b.y)<0.5;
      if(shareEp) continue;

      const pt=segIntersect(sa.a,sa.b,sb.a,sb.b);
      if(pt){
        out.push({x:pt.x,y:pt.y,type:'intersection',
          strokeWidth:Math.max(sa.strokeWidth,sb.strokeWidth),
          shapeId:`X:${sa.shapeId}:${sb.shapeId}`});
      }
    }
  }

  // T-joint: endpoint of one segment lands on body of another
  for (let i=0;i<working.length;i++) {
    const sa=working[i];
    const cands=gridCandidates(working,i,grid,cellSize);
    for (const j of cands) {
      if(i===j) continue;
      const sb=working[j];
      if(collinear(sa,sb)) continue;
      for (const ep of [sa.a,sa.b]) {
        const {dist,t,closest}=ptToSegDist(ep,sb.a,sb.b);
        if(dist<T_JOINT_TOL && t>0.02 && t<0.98){
          out.push({x:closest.x,y:closest.y,type:'intersection',
            strokeWidth:Math.max(sa.strokeWidth,sb.strokeWidth),
            shapeId:`T:${sa.shapeId}:${sb.shapeId}`});
        }
      }
    }
  }

  return out;
}

/**
 * PASS 3 — Endpoint proximity clustering.
 * FIX: CLUSTER_TOL tightened, also now scales with average segment length
 * so it works correctly regardless of SVG coordinate unit scale.
 */
function detectEndpointClusters(allSegs: Segment[]): RawPoint[] {
  const out: RawPoint[] = [];
  const real = allSegs.filter(s=>!s.isArcApprox);
  if (real.length < 2) return out;

  // FIX: compute a scale-aware tolerance
  const avgLen = real.reduce((s,seg)=>s+Math.hypot(seg.b.x-seg.a.x,seg.b.y-seg.a.y),0)/real.length;
  // Use 2% of average segment length as cluster tolerance, clamped to CLUSTER_TOL
  const clusterTol = Math.min(CLUSTER_TOL * Math.max(1, avgLen / 50), avgLen * 0.08);

  interface EP { p:Vec2; dir:Vec2; sw:number; sid:string; segIdx:number }
  const eps: EP[] = [];
  for (let i=0;i<real.length;i++) {
    const s=real[i];
    const dir={x:s.b.x-s.a.x, y:s.b.y-s.a.y};
    eps.push({p:s.a, dir:{x:-dir.x,y:-dir.y}, sw:s.strokeWidth, sid:s.shapeId, segIdx:i});
    eps.push({p:s.b, dir,                      sw:s.strokeWidth, sid:s.shapeId, segIdx:i});
  }

  const cellSize = clusterTol * 2;
  const epGrid = new Map<string, number[]>();
  for (let i=0;i<eps.length;i++) {
    const {p}=eps[i];
    const gx=Math.floor(p.x/cellSize),gy=Math.floor(p.y/cellSize);
    for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){
      const k=`${gx+dx},${gy+dy}`;
      const arr=epGrid.get(k)??[];arr.push(i);epGrid.set(k,arr);
    }
  }

  const visited=new Set<string>();

  for (let i=0;i<eps.length;i++) {
    const ei=eps[i];
    const gx=Math.floor(ei.p.x/cellSize),gy=Math.floor(ei.p.y/cellSize);
    const nearby=epGrid.get(`${gx},${gy}`)??[];

    const group: EP[] = [ei];
    const seenSegs = new Set<number>([ei.segIdx]);

    for (const j of nearby) {
      if(j===i) continue;
      const ej=eps[j];
      if(seenSegs.has(ej.segIdx)) continue;
      if(Math.hypot(ei.p.x-ej.p.x,ei.p.y-ej.p.y)>clusterTol) continue;
      const li=Math.hypot(ei.dir.x,ei.dir.y),lj=Math.hypot(ej.dir.x,ej.dir.y);
      if(li<1e-6||lj<1e-6){group.push(ej);seenSegs.add(ej.segIdx);continue;}
      const cross=Math.abs(ei.dir.x/li*ej.dir.y/lj - ei.dir.y/li*ej.dir.x/lj);
      if(cross>0.09){
        group.push(ej);
        seenSegs.add(ej.segIdx);
      }
    }

    if(group.length>=2){
      const cx=group.reduce((s,e)=>s+e.p.x,0)/group.length;
      const cy=group.reduce((s,e)=>s+e.p.y,0)/group.length;
      const ck=`${Math.round(cx/clusterTol)},${Math.round(cy/clusterTol)}`;
      if(!visited.has(ck)){
        visited.add(ck);
        const maxSw=Math.max(...group.map(e=>e.sw));
        out.push({x:cx,y:cy,type:'intersection',strokeWidth:maxSw,
          shapeId:`CL:${ei.sid}`});
      }
    }
  }
  return out;
}

// ─── Chain assembly ───────────────────────────────────────────────────────────

// FIX: make CHAIN_TOL scale-aware based on actual segment lengths
function getChainTol(segs: Segment[]): number {
  if (segs.length === 0) return 5.0;
  const avgLen = segs.reduce((s,seg)=>s+Math.hypot(seg.b.x-seg.a.x,seg.b.y-seg.a.y),0)/segs.length;
  // 1% of average length, clamped between 0.1 and 20
  return Math.max(0.1, Math.min(20, avgLen * 0.01));
}

function snapKey(v:Vec2,tol:number,dx:number,dy:number){
  return `${Math.round(v.x/tol)+dx},${Math.round(v.y/tol)+dy}`;
}

function assembleChain(segs:Segment[]): Segment[]|null {
  if(segs.length===0)return null;
  if(segs.length===1)return[segs[0]];
  if(segs.length>MAX_CHAIN_SEGS)return null;
  const shapeId=segs[0].shapeId;
  const chainTol = getChainTol(segs);

  type Entry={idx:number;end:'a'|'b'};
  const epMap=new Map<string,Entry[]>();
  const reg=(v:Vec2,idx:number,end:'a'|'b')=>{
    for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){
      const k=snapKey(v,chainTol,dx,dy);
      const arr=epMap.get(k)??[];arr.push({idx,end});epMap.set(k,arr);
    }
  };
  for(let i=0;i<segs.length;i++){reg(segs[i].a,i,'a');reg(segs[i].b,i,'b');}
  const used=new Set<number>([0]);
  const ordered:Segment[]=[segs[0]];
  let tail=segs[0].b;
  while(ordered.length<segs.length){
    const candidates=epMap.get(snapKey(tail,chainTol,0,0))??[];
    let advanced=false;
    for(const{idx,end}of candidates){
      if(used.has(idx))continue;
      const seg=segs[idx];
      const cp=end==='a'?seg.a:seg.b;
      if(Math.hypot(cp.x-tail.x,cp.y-tail.y)>chainTol*3)continue;
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

// ─── Snap points for one shape ────────────────────────────────────────────────

type ArcRun = Segment[];

function emitArcRun(run:ArcRun,sw:number,shapeId:string,out:RawPoint[]):void {
  if(run.length===0)return;
  const mid=Math.floor(run.length/2);
  out.push({...run[0].a,           type:'endpoint',strokeWidth:sw,shapeId});
  out.push({...run[mid].a,         type:'midpoint',strokeWidth:sw,shapeId});
  out.push({...run[run.length-1].b,type:'endpoint',strokeWidth:sw,shapeId});
}

function buildSnapPointsForShape(segs:Segment[],shapeId:string):RawPoint[] {
  if(segs.length===0)return[];
  const sw=segs[0].strokeWidth;
  const out:RawPoint[]=[];

  function processFlat(list:Segment[]) {
    // Bend corners first
    out.push(...detectBendCorners(list));

    let i=0;
    while(i<list.length){
      if(list[i].isArcApprox){
        const run:ArcRun=[];
        while(i<list.length&&list[i].isArcApprox)run.push(list[i++]);
        emitArcRun(run,sw,shapeId,out);
      } else {
        const seg=list[i++];
        out.push({...seg.a,type:'endpoint',strokeWidth:sw,shapeId});
        out.push({x:(seg.a.x+seg.b.x)/2,y:(seg.a.y+seg.b.y)/2,type:'midpoint',strokeWidth:sw,shapeId});
        if(i>=list.length||list[i].isArcApprox)
          out.push({...seg.b,type:'endpoint',strokeWidth:sw,shapeId});
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

// ─── Polygon centroid ─────────────────────────────────────────────────────────

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

// ─── Deduplication ────────────────────────────────────────────────────────────

function dedup(rawPts:RawPoint[], mergeDist: number):RawPoint[] {
  const priority:Record<SvgSnapPointType,number>={intersection:0,endpoint:1,midpoint:2,centroid:3};
  const sorted=[...rawPts].sort((a,b)=>priority[a.type]-priority[b.type]);
  const out:RawPoint[]=[];
  const d2=mergeDist*mergeDist;
  for(const pt of sorted)
    if(!out.some(e=>(pt.x-e.x)**2+(pt.y-e.y)**2<d2))out.push(pt);
  return out;
}

// ─── SVG parsing ──────────────────────────────────────────────────────────────

function parseSvgSegments(svgEl:Element): Segment[] {
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
      case 'line':     raw=extractLine(el,sw,id);         break;
      case 'polyline': raw=extractPoly(el,sw,id,false);   break;
      case 'polygon':  raw=extractPoly(el,sw,id,true);    break;
      case 'path':     raw=pathToSegments(el.getAttribute('d')??'',sw,id); break;
      case 'rect':     raw=extractRect(el,sw,id);         break;
      case 'circle':   raw=extractCircle(el,sw,id);       break;
      case 'ellipse':  raw=extractEllipse(el,sw,id);      break;
    }
    for(const seg of raw)
      allSegs.push({...seg,a:applyMat(ctm,seg.a),b:applyMat(ctm,seg.b)});
  });
  return allSegs;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export const SVG_SNAP_COLOURS:Record<string,string>={
  endpoint:    'rgba(251,191,36,0.90)',
  midpoint:    'rgba(52,211,153,0.80)',
  centroid:    'rgba(167,139,250,0.85)',
  intersection:'rgba(248,113,113,0.85)',
};

export function useSvgSnapPoints(
  svgContent:string|null,
  pdfDimensions:PdfDimensions|null,
): SvgSnapPoint[] {
  return useMemo<SvgSnapPoint[]>(()=>{
    if(!svgContent||!pdfDimensions)return[];
    const{w:pdfW,h:pdfH}=pdfDimensions;
    const parser=new DOMParser();
    const doc=parser.parseFromString(svgContent,'image/svg+xml');
    if(doc.querySelector('parsererror')){console.warn('[useSvgSnapPoints] SVG parse error');return[];}
    const svgEl=doc.querySelector('svg') as SVGSVGElement|null;
    if(!svgEl)return[];

    const vbt=buildVBT(svgEl,pdfW,pdfH);

    // === DIAGNOSTIC: Log coordinate scale info ===
    console.log('[useSvgSnapPoints] pdfDims:', {pdfW, pdfH}, 'vbt:', vbt);

    const allSegs=parseSvgSegments(svgEl);
    const tSegs:Segment[]=allSegs.map(seg=>({
      ...seg,
      a:applyVBT(seg.a,vbt),
      b:applyVBT(seg.b,vbt),
    }));
    if(tSegs.length===0)return[];

    // FIX: compute scale-aware merge distance
    // Average segment length in PDF units, use 0.3% as merge distance
    const avgSegLen = tSegs.reduce((s,seg)=>s+Math.hypot(seg.b.x-seg.a.x,seg.b.y-seg.a.y),0)/tSegs.length;
    const mergeDist = Math.max(MERGE_DIST_PX, Math.min(avgSegLen * 0.003, 5.0));
    console.log('[useSvgSnapPoints] avgSegLen:', avgSegLen.toFixed(1), 'mergeDist:', mergeDist.toFixed(2));

    const byShape=new Map<string,Segment[]>();
    for(const seg of tSegs){
      const arr=byShape.get(seg.shapeId)??[];arr.push(seg);byShape.set(seg.shapeId,arr);
    }

    const raw:RawPoint[]=[];

    // Per-shape: endpoints, midpoints, bend corners, centroids
    for(const[shapeId,segs]of byShape){
      raw.push(...buildSnapPointsForShape(segs,shapeId));

      if(segs.length>=3&&segs.length<=MAX_SEGS_FOR_CHAIN){
        const ordered=assembleChain(segs);
        if(ordered!==null){
          const chainTol=getChainTol(segs);
          const verts=ordered.map(s=>s.a);verts.push(ordered[ordered.length-1].b);
          const isClosed=Math.hypot(verts[verts.length-1].x-verts[0].x,verts[verts.length-1].y-verts[0].y)<chainTol*4;
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

    // Global: crossing intersections + T-joints
    raw.push(...detectCrossIntersections(tSegs));

    // Global: endpoint proximity clustering
    raw.push(...detectEndpointClusters(tSegs));

    const deduped=dedup(raw, mergeDist);
    const snapPoints:SvgSnapPoint[]=deduped
      .filter(p=>p.x>=0&&p.x<=pdfW&&p.y>=0&&p.y<=pdfH)
      .map(({x,y,type,strokeWidth,shapeId})=>({nx:x/pdfW,ny:y/pdfH,type,strokeWidth,shapeId}));

    const tc=snapPoints.reduce((acc,p)=>{acc[p.type]=(acc[p.type]||0)+1;return acc;},{} as Record<string,number>);
    console.log(`[useSvgSnapPoints] ${snapPoints.length} pts — `+
      Object.entries(tc).map(([k,v])=>`${k}:${v}`).join(' '));

    // === DIAGNOSTIC: Show first few points in absolute coords ===
    if(snapPoints.length>0){
      console.log('[useSvgSnapPoints] Sample pts (SVG units):',
        snapPoints.slice(0,5).map(p=>({
          type:p.type,
          x:(p.nx*pdfW).toFixed(1),
          y:(p.ny*pdfH).toFixed(1),
        }))
      );
    }

    return snapPoints;
  },[svgContent,pdfDimensions]);
}
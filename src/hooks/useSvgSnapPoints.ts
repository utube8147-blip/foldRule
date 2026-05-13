'use client';

// ─── useSvgSnapPoints.ts ──────────────────────────────────────────────────────
//
//  CHANGES in this version:
//    • ADDED: Enhanced door detection to filter snap points
//    • ADDED: For doors, ONLY arc-center points are shown (no endpoints/midpoints)
//    • FIXED: Arc chains now correctly identify door swings
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo } from 'react';
import type { PdfDimensions } from '@/types/viewerTypes';
import {
  isDecorationElement,
  resolveStrokeWidth,
} from './svgDecorationFilter';

// ─── Public types ─────────────────────────────────────────────────────────────

export type SvgSnapPointType =
  | 'endpoint'
  | 'midpoint'
  | 'centroid'
  | 'intersection'
  | 'arc-center';

export interface SvgSnapPoint {
  nx: number;
  ny: number;
  type: SvgSnapPointType;
  strokeWidth: number;
  shapeId: string;
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface Vec2    { x: number; y: number }
interface Mat2D   { a: number; b: number; c: number; d: number; e: number; f: number }
interface Segment { a: Vec2; b: Vec2; strokeWidth: number; shapeId: string }

// ─── Matrix helpers ───────────────────────────────────────────────────────────

function identityMatrix(): Mat2D {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

function multiplyMatrix(m1: Mat2D, m2: Mat2D): Mat2D {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

function applyMatrix(m: Mat2D, v: Vec2): Vec2 {
  return {
    x: m.a * v.x + m.c * v.y + m.e,
    y: m.b * v.x + m.d * v.y + m.f,
  };
}

function parseTransformAttr(transform: string | null): Mat2D {
  if (!transform) return identityMatrix();
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\(([^)]*)\)/g;
  const transforms: Mat2D[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(transform)) !== null) {
    const type = m[1];
    const args = m[2].trim().split(/[\s,]+/).map(parseFloat);
    let mat = identityMatrix();
    switch (type) {
      case 'matrix':
        mat = { a:args[0], b:args[1], c:args[2], d:args[3], e:args[4], f:args[5] }; break;
      case 'translate':
        mat = { a:1, b:0, c:0, d:1, e:args[0]??0, f:args[1]??0 }; break;
      case 'scale': {
        const sx = args[0]??1, sy = args[1]??sx;
        mat = { a:sx, b:0, c:0, d:sy, e:0, f:0 }; break;
      }
      case 'rotate': {
        const ang = (args[0]??0)*Math.PI/180;
        const cos = Math.cos(ang), sin = Math.sin(ang);
        const cx = args[1]??0, cy = args[2]??0;
        mat = { a:cos, b:sin, c:-sin, d:cos,
                e:cx-cos*cx+sin*cy, f:cy-sin*cx-cos*cy }; break;
      }
      case 'skewX': {
        const t = Math.tan((args[0]??0)*Math.PI/180);
        mat = { a:1, b:0, c:t, d:1, e:0, f:0 }; break;
      }
      case 'skewY': {
        const t = Math.tan((args[0]??0)*Math.PI/180);
        mat = { a:1, b:t, c:0, d:1, e:0, f:0 }; break;
      }
    }
    transforms.push(mat);
  }
  let composed = identityMatrix();
  for (const t of transforms) composed = multiplyMatrix(composed, t);
  return composed;
}

function getCTM(el: Element, svgRoot: Element): Mat2D {
  const matrices: Mat2D[] = [];
  let node: Element | null = el;
  while (node && node !== svgRoot.parentElement) {
    const t = node.getAttribute('transform');
    if (t) matrices.unshift(parseTransformAttr(t));
    node = node.parentElement;
  }
  let ctm = identityMatrix();
  for (const m of matrices) ctm = multiplyMatrix(ctm, m);
  return ctm;
}

// ─── ViewBox → PDF pixel transform ───────────────────────────────────────────

interface VBTransform { sx: number; sy: number; tx: number; ty: number }

function buildViewBoxTransform(svgEl: SVGSVGElement, pdfW: number, pdfH: number): VBTransform {
  const vb = svgEl.getAttribute('viewBox');
  if (vb) {
    const [minX, minY, vbW, vbH] = vb.trim().split(/[\s,]+/).map(parseFloat);
    if ([minX,minY,vbW,vbH].every(n => !isNaN(n)) && vbW > 0 && vbH > 0) {
      return { sx:pdfW/vbW, sy:pdfH/vbH, tx:-minX*(pdfW/vbW), ty:-minY*(pdfH/vbH) };
    }
  }
  const wAttr = svgEl.getAttribute('width');
  const hAttr = svgEl.getAttribute('height');
  const svgW  = wAttr ? parseFloat(wAttr) : pdfW;
  const svgH  = hAttr ? parseFloat(hAttr) : pdfH;
  return { sx:svgW>0?pdfW/svgW:1, sy:svgH>0?pdfH/svgH:1, tx:0, ty:0 };
}

function applyVBTransform(v: Vec2, t: VBTransform): Vec2 {
  return { x: v.x*t.sx+t.tx, y: v.y*t.sy+t.ty };
}

// ─── SVG attribute helpers ────────────────────────────────────────────────────

function attr(el: Element, name: string): string { return el.getAttribute(name) ?? ''; }
function numAttr(el: Element, name: string, fallback = 0): number {
  const v = parseFloat(attr(el, name)); return isNaN(v) ? fallback : v;
}

// ─── Path `d` tokeniser & segment builder ─────────────────────────────────────

type PathToken = { cmd: string; args: number[] };

function tokenisePath(d: string): PathToken[] {
  const tokens: PathToken[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d)) !== null) {
    const args = m[2].trim() === ''
      ? []
      : m[2].trim().split(/[\s,]+/).map(parseFloat).filter(n => !isNaN(n));
    tokens.push({ cmd: m[1], args });
  }
  return tokens;
}

function cubicBezier(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const u = 1-t;
  return {
    x: u*u*u*p0.x+3*u*u*t*p1.x+3*u*t*t*p2.x+t*t*t*p3.x,
    y: u*u*u*p0.y+3*u*u*t*p1.y+3*u*t*t*p2.y+t*t*t*p3.y,
  };
}

function quadBezier(p0: Vec2, p1: Vec2, p2: Vec2, t: number): Vec2 {
  const u = 1-t;
  return { x:u*u*p0.x+2*u*t*p1.x+t*t*p2.x, y:u*u*p0.y+2*u*t*p1.y+t*t*p2.y };
}

function arcToPoints(
  x1: number, y1: number, rx: number, ry: number, xRot: number,
  largeArc: number, sweep: number, x2: number, y2: number, steps = 12,
): Vec2[] {
  if (rx === 0 || ry === 0) return [{ x: x2, y: y2 }];
  const phi    = (xRot*Math.PI)/180;
  const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);
  const dx2 = (x1-x2)/2, dy2 = (y1-y2)/2;
  const x1p =  cosPhi*dx2+sinPhi*dy2;
  const y1p = -sinPhi*dx2+cosPhi*dy2;
  let rxA = Math.abs(rx), ryA = Math.abs(ry);
  const lambda = (x1p*x1p)/(rxA*rxA)+(y1p*y1p)/(ryA*ryA);
  if (lambda > 1) { rxA *= Math.sqrt(lambda); ryA *= Math.sqrt(lambda); }
  const sign  = largeArc===sweep ? -1 : 1;
  const sq    = Math.max(0, (rxA*rxA*ryA*ryA-rxA*rxA*y1p*y1p-ryA*ryA*x1p*x1p)/(rxA*rxA*y1p*y1p+ryA*ryA*x1p*x1p));
  const coef  = sign*Math.sqrt(sq);
  const cxp   = coef*(rxA*y1p)/ryA;
  const cyp   = coef*-(ryA*x1p)/rxA;
  const cx    = cosPhi*cxp-sinPhi*cyp+(x1+x2)/2;
  const cy    = sinPhi*cxp+cosPhi*cyp+(y1+y2)/2;
  const ux    = (x1p-cxp)/rxA, uy = (y1p-cyp)/ryA;
  const vx    = (-x1p-cxp)/rxA, vy = (-y1p-cyp)/ryA;
  const n     = Math.sqrt(ux*ux+uy*uy);
  let theta1  = uy>=0 ? Math.acos(Math.max(-1,Math.min(1,ux/n))) : -Math.acos(Math.max(-1,Math.min(1,ux/n)));
  const mag   = Math.sqrt((ux*ux+uy*uy)*(vx*vx+vy*vy));
  const dotUV = ux*vx+uy*vy;
  let dTheta  = (ux*vy-uy*vx)>=0
    ? Math.acos(Math.max(-1,Math.min(1,dotUV/mag)))
    : -Math.acos(Math.max(-1,Math.min(1,dotUV/mag)));
  if (!sweep && dTheta>0) dTheta -= 2*Math.PI;
  if ( sweep && dTheta<0) dTheta += 2*Math.PI;
  const pts: Vec2[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i/steps, ang = theta1+t*dTheta;
    pts.push({
      x: cosPhi*rxA*Math.cos(ang)-sinPhi*ryA*Math.sin(ang)+cx,
      y: sinPhi*rxA*Math.cos(ang)+cosPhi*ryA*Math.sin(ang)+cy,
    });
  }
  return pts;
}

function pathToSegments(d: string, strokeWidth: number, shapeId: string): Segment[] {
  const tokens = tokenisePath(d);
  const segs: Segment[] = [];
  let cx = 0, cy = 0, sx = 0, sy = 0;
  let lastCp: Vec2 | null = null;
  const pushSeg = (a: Vec2, b: Vec2) => segs.push({ a, b, strokeWidth, shapeId });
  const addPoly = (pts: Vec2[]) => { for (let i = 0; i < pts.length-1; i++) pushSeg(pts[i], pts[i+1]); };

  for (const { cmd, args } of tokens) {
    const rel = cmd === cmd.toLowerCase() && cmd !== 'Z' && cmd !== 'z';
    const ox = rel ? cx : 0, oy = rel ? cy : 0;
    switch (cmd.toUpperCase()) {
      case 'M':
        for (let i = 0; i+1 < args.length; i += 2) {
          const nx = args[i]+(i===0?ox:(rel?cx:0));
          const ny = args[i+1]+(i===0?oy:(rel?cy:0));
          if (i === 0) { cx=nx; cy=ny; sx=cx; sy=cy; }
          else { pushSeg({x:cx,y:cy},{x:nx,y:ny}); cx=nx; cy=ny; }
        }
        lastCp=null; break;
      case 'L':
        for (let i = 0; i+1 < args.length; i += 2) {
          const nx=args[i]+ox, ny=args[i+1]+oy;
          pushSeg({x:cx,y:cy},{x:nx,y:ny}); cx=nx; cy=ny;
        }
        lastCp=null; break;
      case 'H':
        for (const ax of args) { const nx=ax+ox; pushSeg({x:cx,y:cy},{x:nx,y:cy}); cx=nx; }
        lastCp=null; break;
      case 'V':
        for (const ay of args) { const ny=ay+oy; pushSeg({x:cx,y:cy},{x:cx,y:ny}); cy=ny; }
        lastCp=null; break;
      case 'C':
        for (let i = 0; i+5 < args.length; i += 6) {
          const p0:Vec2={x:cx,y:cy};
          const p1:Vec2={x:args[i]+ox,y:args[i+1]+oy};
          const p2:Vec2={x:args[i+2]+ox,y:args[i+3]+oy};
          const p3:Vec2={x:args[i+4]+ox,y:args[i+5]+oy};
          const pts=[p0]; for (let t=1;t<=8;t++) pts.push(cubicBezier(p0,p1,p2,p3,t/8));
          addPoly(pts); lastCp=p2; cx=p3.x; cy=p3.y;
        }
        break;
      case 'S':
        for (let i = 0; i+3 < args.length; i += 4) {
          const p0:Vec2={x:cx,y:cy};
          const p1:Vec2=lastCp?{x:2*cx-lastCp.x,y:2*cy-lastCp.y}:p0;
          const p2:Vec2={x:args[i]+ox,y:args[i+1]+oy};
          const p3:Vec2={x:args[i+2]+ox,y:args[i+3]+oy};
          const pts=[p0]; for (let t=1;t<=8;t++) pts.push(cubicBezier(p0,p1,p2,p3,t/8));
          addPoly(pts); lastCp=p2; cx=p3.x; cy=p3.y;
        }
        break;
      case 'Q':
        for (let i = 0; i+3 < args.length; i += 4) {
          const p0:Vec2={x:cx,y:cy};
          const p1:Vec2={x:args[i]+ox,y:args[i+1]+oy};
          const p2:Vec2={x:args[i+2]+ox,y:args[i+3]+oy};
          const pts=[p0]; for (let t=1;t<=6;t++) pts.push(quadBezier(p0,p1,p2,t/6));
          addPoly(pts); lastCp=p1; cx=p2.x; cy=p2.y;
        }
        break;
      case 'T':
        for (let i = 0; i+1 < args.length; i += 2) {
          const p0:Vec2={x:cx,y:cy};
          const p1:Vec2=lastCp?{x:2*cx-lastCp.x,y:2*cy-lastCp.y}:p0;
          const p2:Vec2={x:args[i]+ox,y:args[i+1]+oy};
          const pts=[p0]; for (let t=1;t<=6;t++) pts.push(quadBezier(p0,p1,p2,t/6));
          addPoly(pts); lastCp=p1; cx=p2.x; cy=p2.y;
        }
        break;
      case 'A':
        for (let i = 0; i+6 < args.length; i += 7) {
          const x2=args[i+5]+ox, y2=args[i+6]+oy;
          const arcPts=arcToPoints(cx,cy,args[i],args[i+1],args[i+2],args[i+3],args[i+4],x2,y2);
          addPoly([{x:cx,y:cy},...arcPts]);
          cx=x2; cy=y2; lastCp=null;
        }
        break;
      case 'Z':
        if (cx!==sx||cy!==sy) pushSeg({x:cx,y:cy},{x:sx,y:sy});
        cx=sx; cy=sy; lastCp=null; break;
    }
  }
  return segs;
}

// ─── Element → segment extractors ────────────────────────────────────────────

function extractLine(el: Element, sw: number, id: string): Segment[] {
  return [{ a:{x:numAttr(el,'x1'),y:numAttr(el,'y1')}, b:{x:numAttr(el,'x2'),y:numAttr(el,'y2')}, strokeWidth:sw, shapeId:id }];
}

function extractPolyPoints(el: Element, sw: number, id: string, close: boolean): Segment[] {
  const raw = attr(el,'points').trim(); if (!raw) return [];
  const nums = raw.split(/[\s,]+/).map(parseFloat).filter(n => !isNaN(n));
  const pts: Vec2[] = [];
  for (let i = 0; i+1 < nums.length; i += 2) pts.push({ x:nums[i], y:nums[i+1] });
  if (pts.length < 2) return [];
  const segs: Segment[] = [];
  for (let i = 0; i < pts.length-1; i++) segs.push({ a:pts[i], b:pts[i+1], strokeWidth:sw, shapeId:id });
  if (close && pts.length > 2) segs.push({ a:pts[pts.length-1], b:pts[0], strokeWidth:sw, shapeId:id });
  return segs;
}

function extractRect(el: Element, sw: number, id: string): Segment[] {
  const x=numAttr(el,'x'), y=numAttr(el,'y'), w=numAttr(el,'width'), h=numAttr(el,'height');
  if (w<=0||h<=0) return [];
  const pts=[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}];
  return [
    {a:pts[0],b:pts[1],strokeWidth:sw,shapeId:id},
    {a:pts[1],b:pts[2],strokeWidth:sw,shapeId:id},
    {a:pts[2],b:pts[3],strokeWidth:sw,shapeId:id},
    {a:pts[3],b:pts[0],strokeWidth:sw,shapeId:id},
  ];
}

function extractCircle(el: Element, sw: number, id: string): Segment[] {
  const cx=numAttr(el,'cx'), cy=numAttr(el,'cy'), r=numAttr(el,'r');
  if (r<=0) return [];
  return pathToSegments(`M${cx-r},${cy} A${r},${r} 0 1 1 ${cx+r},${cy} A${r},${r} 0 1 1 ${cx-r},${cy} Z`, sw, id);
}

function extractEllipse(el: Element, sw: number, id: string): Segment[] {
  const cx=numAttr(el,'cx'), cy=numAttr(el,'cy'), rx=numAttr(el,'rx'), ry=numAttr(el,'ry');
  if (rx<=0||ry<=0) return [];
  return pathToSegments(`M${cx-rx},${cy} A${rx},${ry} 0 1 1 ${cx+rx},${cy} A${rx},${ry} 0 1 1 ${cx-rx},${cy} Z`, sw, id);
}

// ─── Chain assembly ───────────────────────────────────────────────────────────

const CHAIN_TOL = 5.0;

function assembleChain(segs: Segment[]): Vec2[] | null {
  if (segs.length === 0) return null;
  if (segs.length === 1) return [segs[0].a, segs[0].b];

  const shapeId = segs[0].shapeId;
  const ordered: Segment[] = [segs[0]];
  const used = new Set<number>([0]);
  let tail = segs[0].b;
  let grew = true;

  while (grew && ordered.length < segs.length) {
    grew = false;
    for (let j = 1; j < segs.length; j++) {
      if (used.has(j)) continue;
      const dA = Math.hypot(segs[j].a.x - tail.x, segs[j].a.y - tail.y);
      const dB = Math.hypot(segs[j].b.x - tail.x, segs[j].b.y - tail.y);
      if (dA <= CHAIN_TOL) {
        ordered.push(segs[j]);
        used.add(j); tail = segs[j].b; grew = true; break;
      } else if (dB <= CHAIN_TOL) {
        ordered.push({ a: segs[j].b, b: segs[j].a, strokeWidth: segs[j].strokeWidth, shapeId });
        used.add(j); tail = segs[j].a; grew = true; break;
      }
    }
  }

  if (ordered.length !== segs.length) return null;

  const vertices: Vec2[] = ordered.map(s => s.a);
  vertices.push(ordered[ordered.length - 1].b);
  return vertices;
}

// ─── Arc / circle detection ───────────────────────────────────────────────────

const ARC_R_VAR_MAX   = 0.08;
const ARC_MIN_SEGS    = 3;

interface CircleFit { cx: number; cy: number; r: number; rVar: number }

function fitCircleToPoints(pts: Vec2[]): CircleFit | null {
  const n = pts.length;
  if (n < 4) return null;

  let sumX=0, sumY=0, sumZ=0, sumXX=0, sumXY=0, sumYY=0, sumXZ=0, sumYZ=0;
  for (const p of pts) {
    const z = p.x*p.x + p.y*p.y;
    sumX  += p.x; sumY  += p.y; sumZ  += z;
    sumXX += p.x*p.x; sumXY += p.x*p.y; sumYY += p.y*p.y;
    sumXZ += p.x*z;   sumYZ += p.y*z;
  }

  const a00=sumXX, a01=sumXY, a02=sumX;
  const a10=sumXY, a11=sumYY, a12=sumY;
  const a20=sumX,  a21=sumY,  a22=n;
  const b0=sumXZ*0.5, b1=sumYZ*0.5, b2=sumZ*0.5;

  const det =
    a00*(a11*a22-a12*a21) -
    a01*(a10*a22-a12*a20) +
    a02*(a10*a21-a11*a20);
  if (Math.abs(det) < 1e-10) return null;

  const cx = (
    b0*(a11*a22-a12*a21) -
    a01*(b1*a22-a12*b2) +
    a02*(b1*a21-a11*b2)
  ) / det;

  const cy = (
    a00*(b1*a22-a12*b2) -
    b0*(a10*a22-a12*a20) +
    a02*(a10*b2-b1*a20)
  ) / det;

  const radii  = pts.map(p => Math.hypot(p.x-cx, p.y-cy));
  const rMean  = radii.reduce((s, r) => s+r, 0) / n;
  if (rMean < 1) return null;

  const rVar   = Math.sqrt(radii.reduce((s, r) => s+(r-rMean)**2, 0) / n) / rMean;

  return { cx, cy, r: rMean, rVar };
}

// ─── Enhanced door detection ───────────────────────────────────────────────────

function isDoorShape(shapeId: string, segs: Segment[], circleFit: CircleFit | null): boolean {
  // Check shapeId for door-related keywords
  const doorKeywords = ['door', 'Door', 'DOOR', 'door-swing', 'door-leaf', 'swing', 'arc', 'threshold'];
  if (doorKeywords.some(keyword => shapeId.includes(keyword))) {
    console.log(`[Door Detection] shapeId "${shapeId}" matched keyword`);
    return true;
  }
  
  // Check if it's an arc with door-like angle (70-110 degrees)
  if (circleFit !== null && segs.length >= ARC_MIN_SEGS) {
    const vertices = assembleChain(segs);
    if (vertices && vertices.length >= 2) {
      const start = vertices[0];
      const end = vertices[vertices.length - 1];
      const startAngle = Math.atan2(start.y - circleFit.cy, start.x - circleFit.cx);
      const endAngle = Math.atan2(end.y - circleFit.cy, end.x - circleFit.cx);
      let angleSpan = Math.abs(endAngle - startAngle);
      if (angleSpan > Math.PI) angleSpan = 2 * Math.PI - angleSpan;
      
      const angleDeg = angleSpan * 180 / Math.PI;
      // Door swings are typically 90°, but allow 60-120° range
      if (angleDeg >= 60 && angleDeg <= 120) {
        console.log(`[Door Detection] Arc with ${angleDeg.toFixed(1)}° detected as door (shapeId: ${shapeId})`);
        return true;
      }
    }
  }
  
  return false;
}

// ─── Snap point builder with door filtering ───────────────────────────────────

const MID_COINCIDENCE_PX = 1.0;

type RawPoint = Omit<SvgSnapPoint, 'nx' | 'ny'> & Vec2;

function buildSnapPointsForShape(segs: Segment[], shapeId: string): RawPoint[] {
  if (segs.length === 0) return [];

  const sw = segs[0].strokeWidth;
  const out: RawPoint[] = [];
  
  // Try to detect if this is a door
  let circleFit: CircleFit | null = null;
  let isArc = false;
  
  if (segs.length >= ARC_MIN_SEGS) {
    const vertices = assembleChain(segs);
    if (vertices && vertices.length >= 4) {
      circleFit = fitCircleToPoints(vertices);
      if (circleFit !== null && circleFit.rVar <= ARC_R_VAR_MAX) {
        isArc = true;
      }
    }
  }
  
  const isDoor = isDoorShape(shapeId, segs, circleFit);

  // ── Single segment ────────────────────────────────────────────────────────
  if (segs.length === 1) {
    const seg = segs[0];
    
    if (isDoor) {
      // For door segments: NO snap points
      console.log(`[Door Filter] Single-segment door "${shapeId}" → filtering all points`);
      return [];
    }
    
    out.push({ ...seg.a, type: 'endpoint', strokeWidth: sw, shapeId });
    out.push({ ...seg.b, type: 'endpoint', strokeWidth: sw, shapeId });
    out.push({
      x: (seg.a.x + seg.b.x) / 2,
      y: (seg.a.y + seg.b.y) / 2,
      type: 'midpoint', strokeWidth: sw, shapeId,
    });
    return out;
  }

  // ── Multi-segment: attempt chain ──────────────────────────────────────────
  const vertices = assembleChain(segs);
  
  if (vertices !== null) {
    const start = vertices[0];
    const end   = vertices[vertices.length - 1];

    // For doors: ONLY add arc-center point if it's an arc
    if (isDoor && isArc && circleFit !== null) {
      console.log(`[Door Filter] Door arc "${shapeId}" → ONLY arc-center point`);
      out.push({
        x: circleFit.cx, y: circleFit.cy,
        type: 'arc-center', strokeWidth: sw, shapeId,
      });
      return out;
    }
    
    // For doors that are not arcs: return empty (no points)
    if (isDoor) {
      console.log(`[Door Filter] Non-arc door "${shapeId}" → filtering all points`);
      return [];
    }

    // For non-doors: emit standard points
    // Always emit both terminal endpoints
    out.push({ ...start, type: 'endpoint', strokeWidth: sw, shapeId });
    out.push({ ...end,   type: 'endpoint', strokeWidth: sw, shapeId });

    if (isArc && circleFit !== null) {
      // Non-door arc - emit arc-center
      out.push({
        x: circleFit.cx, y: circleFit.cy,
        type: 'arc-center', strokeWidth: sw, shapeId,
      });
      console.log(`[Arc Detection] Non-door arc: shapeId=${shapeId} r=${circleFit.r.toFixed(1)}`);
      return out;
    }

    // Non-arc chain: emit vertex midpoint
    const midIdx = Math.floor((vertices.length - 1) / 2);
    const mid    = vertices[midIdx];

    const midEqStart = Math.hypot(mid.x - start.x, mid.y - start.y) < MID_COINCIDENCE_PX;
    const midEqEnd   = Math.hypot(mid.x - end.x,   mid.y - end.y)   < MID_COINCIDENCE_PX;
    if (!midEqStart && !midEqEnd) {
      out.push({ ...mid, type: 'midpoint', strokeWidth: sw, shapeId });
    }
    return out;
  }

  // ── Non-chain fallback (disconnected segments) ────────────────────────────
  for (const seg of segs) {
    if (isDoor) {
      // Skip door segments entirely
      continue;
    }
    out.push({ ...seg.a, type: 'endpoint', strokeWidth: sw, shapeId });
    out.push({ ...seg.b, type: 'endpoint', strokeWidth: sw, shapeId });
    out.push({
      x: (seg.a.x + seg.b.x) / 2,
      y: (seg.a.y + seg.b.y) / 2,
      type: 'midpoint', strokeWidth: sw, shapeId,
    });
  }
  return out;
}

// ─── Snap point helpers ───────────────────────────────────────────────────────

function polygonCentroid(pts: Vec2[]): Vec2 {
  let area = 0, cx = 0, cy = 0;
  for (let i = 0, j = pts.length-1; i < pts.length; j = i++) {
    const cross = pts[j].x*pts[i].y - pts[i].x*pts[j].y;
    area += cross; cx += (pts[j].x+pts[i].x)*cross; cy += (pts[j].y+pts[i].y)*cross;
  }
  area /= 2;
  if (Math.abs(area) < 1e-9) {
    return { x:pts.reduce((s,p)=>s+p.x,0)/pts.length, y:pts.reduce((s,p)=>s+p.y,0)/pts.length };
  }
  return { x:cx/(6*area), y:cy/(6*area) };
}

function segmentIntersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const r={x:b.x-a.x,y:b.y-a.y}, s={x:d.x-c.x,y:d.y-c.y};
  const denom = r.x*s.y-r.y*s.x;
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((c.x-a.x)*s.y-(c.y-a.y)*s.x)/denom;
  const u = ((c.x-a.x)*r.y-(c.y-a.y)*r.x)/denom;
  const EPS = 1e-9;
  if (t>=EPS&&t<=1-EPS&&u>=EPS&&u<=1-EPS)
    return { x:a.x+t*r.x, y:a.y+t*r.y };
  return null;
}

function computeIntersections(segsA: Segment[], segsB: Segment[]): RawPoint[] {
  const out: RawPoint[] = [];
  for (const sa of segsA) for (const sb of segsB) {
    if (sa.shapeId === sb.shapeId) continue;
    const pt = segmentIntersection(sa.a, sa.b, sb.a, sb.b);
    if (pt) out.push({ ...pt, type:'intersection',
      strokeWidth:Math.max(sa.strokeWidth,sb.strokeWidth),
      shapeId:`${sa.shapeId}:${sb.shapeId}` });
  }
  return out;
}

// ─── Deduplication ────────────────────────────────────────────────────────────

const MERGE_DIST_PX = 1;

function dedup(rawPts: RawPoint[]): RawPoint[] {
  const out: RawPoint[] = [];
  const d2 = MERGE_DIST_PX * MERGE_DIST_PX;
  for (const pt of rawPts) {
    if (!out.some(e => (pt.x-e.x)**2+(pt.y-e.y)**2 < d2)) out.push(pt);
  }
  return out;
}

// ─── SVG segment parser with shapeId preservation ─────────────────────────────

function parseSvgSegments(svgEl: Element): Segment[] {
  if (typeof window === 'undefined') return [];
  const allSegs: Segment[] = [];
  let autoId = 0;

  svgEl.querySelectorAll('line, polyline, polygon, path, rect, circle, ellipse').forEach(el => {
    const sw = resolveStrokeWidth(el);
    if (isDecorationElement(el, sw)) return;

    // Preserve original ID or generate one
    const id = el.id || el.getAttribute('data-id') || `shape-${autoId++}`;
    const ctm = getCTM(el, svgEl);
    const tag = el.tagName.toLowerCase();

    let rawSegs: Segment[] = [];
    switch (tag) {
      case 'line':     rawSegs = extractLine(el, sw, id);              break;
      case 'polyline': rawSegs = extractPolyPoints(el, sw, id, false); break;
      case 'polygon':  rawSegs = extractPolyPoints(el, sw, id, true);  break;
      case 'path':     rawSegs = pathToSegments(attr(el,'d'), sw, id); break;
      case 'rect':     rawSegs = extractRect(el, sw, id);              break;
      case 'circle':   rawSegs = extractCircle(el, sw, id);            break;
      case 'ellipse':  rawSegs = extractEllipse(el, sw, id);           break;
    }

    for (const seg of rawSegs) {
      allSegs.push({
        ...seg,
        a: applyMatrix(ctm, seg.a),
        b: applyMatrix(ctm, seg.b),
      });
    }
  });

  return allSegs;
}

// ─── Colour map for debug overlay ─────────────────────────────────────────────

export const SVG_SNAP_COLOURS: Record<string, string> = {
  endpoint:     'rgba(251, 191, 36, 0.90)',   // amber
  midpoint:     'rgba(52,  211, 153, 0.80)',  // emerald
  centroid:     'rgba(167, 139, 250, 0.85)',  // violet
  intersection: 'rgba(248, 113, 113, 0.85)',  // red
  'arc-center': 'rgba(34,  211, 238, 0.95)',  // cyan
};

// ─── Main export ──────────────────────────────────────────────────────────────

export function useSvgSnapPoints(
  svgContent: string | null,
  pdfDimensions: PdfDimensions | null,
): SvgSnapPoint[] {
  return useMemo<SvgSnapPoint[]>(() => {
    if (!svgContent || !pdfDimensions) return [];

    const { w: pdfW, h: pdfH } = pdfDimensions;

    const parser = new DOMParser();
    const doc    = parser.parseFromString(svgContent, 'image/svg+xml');
    if (doc.querySelector('parsererror')) {
      console.warn('[useSvgSnapPoints] SVG parse error');
      return [];
    }

    const svgEl = doc.querySelector('svg') as SVGSVGElement | null;
    if (!svgEl) return [];

    const vbt = buildViewBoxTransform(svgEl, pdfW, pdfH);
    const allSegs = parseSvgSegments(svgEl);

    const transformedSegs: Segment[] = allSegs.map(seg => ({
      ...seg,
      a: applyVBTransform(seg.a, vbt),
      b: applyVBTransform(seg.b, vbt),
    }));

    if (transformedSegs.length === 0) return [];

    // ── Group segments by shapeId ────────────────────────────────────────────
    const byShape = new Map<string, Segment[]>();
    for (const seg of transformedSegs) {
      const arr = byShape.get(seg.shapeId) ?? [];
      arr.push(seg);
      byShape.set(seg.shapeId, arr);
    }

    // ── Build snap points with door filtering ────────────────────────────────
    const raw: RawPoint[] = [];

    for (const [shapeId, segs] of byShape) {
      // Pass shapeId to buildSnapPointsForShape for door detection
      raw.push(...buildSnapPointsForShape(segs, shapeId));

      // Centroid for closed polygon shapes (skip for doors)
      const isDoor = shapeId.toLowerCase().includes('door') || 
                     shapeId.toLowerCase().includes('swing');
      
      if (!isDoor && segs.length >= 3) {
        const vertices = assembleChain(segs);
        if (vertices !== null) {
          const head = vertices[0];
          const tail = vertices[vertices.length - 1];
          const isClosed = Math.hypot(tail.x - head.x, tail.y - head.y) < CHAIN_TOL * 2;
          if (isClosed) {
            const poly = vertices.slice(0, -1);
            const c    = polygonCentroid(poly);
            if (c.x >= 0 && c.x <= pdfW && c.y >= 0 && c.y <= pdfH) {
              raw.push({ ...c, type: 'centroid', strokeWidth: segs[0].strokeWidth, shapeId });
            }
          }
        }
      }
    }

    // ── Intersection snap points (skip for performance) ───────────────────────
    if (transformedSegs.length <= 2000) {
      raw.push(...computeIntersections(transformedSegs, transformedSegs));
    }

    // ── Deduplicate and normalise to [0,1] ────────────────────────────────────
    const dedupedRaw = dedup(raw);

    const snapPoints: SvgSnapPoint[] = dedupedRaw
      .filter(p => p.x >= 0 && p.x <= pdfW && p.y >= 0 && p.y <= pdfH)
      .map(({ x, y, type, strokeWidth, shapeId }) => ({
        nx: x / pdfW,
        ny: y / pdfH,
        type,
        strokeWidth,
        shapeId,
      }));

    // Count breakdown for logging
    const typeCounts = snapPoints.reduce((acc, p) => {
      acc[p.type] = (acc[p.type] || 0) + 1; return acc;
    }, {} as Record<string, number>);

    const doorCount = Array.from(byShape.keys()).filter(id => 
      id.toLowerCase().includes('door') || id.toLowerCase().includes('swing')
    ).length;

    console.log(
      `[useSvgSnapPoints] Extracted ${snapPoints.length} snap points ` +
      `(${transformedSegs.length} segments, ${byShape.size} shapes, ${doorCount} doors detected) — ` +
      Object.entries(typeCounts).map(([k,v]) => `${k}:${v}`).join(' '),
    );

    return snapPoints;
  }, [svgContent, pdfDimensions]);
}
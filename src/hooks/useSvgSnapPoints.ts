/**
 * useSvgSnapPoints.ts
 *
 * PERF FIX: zoom param removed entirely from both phases.
 *
 * Previously zoom was a useMemo dependency in phase 2 which caused the entire
 * snap point list to be rebuilt on every wheel tick, hanging the browser.
 *
 * Snap points are normalised (0-1) and are zoom-independent — there is no
 * reason to recompute them when zoom changes.
 *
 * Phase 1: parse SVG → segs (runs only when svgContent or pdfDims change)
 * Phase 2: build snap point list (runs only when parsed changes)
 *
 * Produces ONLY:
 *   - Corner points (where lines change direction / bezier anchors)
 *   - One midpoint per continuous straight line
 *   - One midpoint per bezier curve (at t=0.5)
 *   - Circle/ellipse endpoints and centroids
 *   - Line intersections
 */

import { useMemo } from 'react';

export interface SvgSnapPoint {
  nx:          number;
  ny:          number;
  type:        'endpoint' | 'midpoint' | 'centroid' | 'intersection';
  shapeId:     string;
  strokeWidth: number;
}

/** A bezier curve stored with real control points for smooth canvas rendering. */
export interface SvgCurve {
  type:    'cubic' | 'quadratic';
  nx1:     number; ny1:    number;
  ncp1x:   number; ncp1y:  number;
  ncp2x?:  number; ncp2y?: number; // cubic only
  nx2:     number; ny2:    number;
  shapeId: string;
  sw:      number;
}

interface PdfDimensions { w: number; h: number }

// Minimum distance in PDF-pixel space for a midpoint to be worth showing.
// No zoom multiplication — snap points are zoom-independent.
const MIN_PDF_PX_FOR_MIDPOINT = 12;

// ── Matrix helpers ────────────────────────────────────────────────────────────

interface Mat { a:number; b:number; c:number; d:number; e:number; f:number }
function identMat(): Mat { return { a:1,b:0,c:0,d:1,e:0,f:0 }; }
function mulMat(m1: Mat, m2: Mat): Mat {
  return {
    a: m1.a*m2.a+m1.c*m2.b, b: m1.b*m2.a+m1.d*m2.b,
    c: m1.a*m2.c+m1.c*m2.d, d: m1.b*m2.c+m1.d*m2.d,
    e: m1.a*m2.e+m1.c*m2.f+m1.e, f: m1.b*m2.e+m1.d*m2.f+m1.f,
  };
}
function applyMat(m: Mat, x: number, y: number): [number, number] {
  return [m.a*x+m.c*y+m.e, m.b*x+m.d*y+m.f];
}
function parseTfm(t: string | null): Mat {
  if (!t) return identMat();
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\(([^)]*)\)/g;
  const mats: Mat[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const args = m[2].trim().split(/[\s,]+/).map(parseFloat);
    let mat = identMat();
    switch (m[1]) {
      case 'matrix':    mat = {a:args[0],b:args[1],c:args[2],d:args[3],e:args[4],f:args[5]}; break;
      case 'translate': mat = {...identMat(), e:args[0]??0, f:args[1]??0}; break;
      case 'scale': { const sx=args[0]??1,sy=args[1]??sx; mat={a:sx,b:0,c:0,d:sy,e:0,f:0}; break; }
      case 'rotate': {
        const ang=(args[0]??0)*Math.PI/180,cos=Math.cos(ang),sin=Math.sin(ang);
        const cx=args[1]??0,cy=args[2]??0;
        mat={a:cos,b:sin,c:-sin,d:cos,e:cx-cos*cx+sin*cy,f:cy-sin*cx-cos*cy}; break;
      }
    }
    mats.push(mat);
  }
  return mats.reduce((acc,mm)=>mulMat(acc,mm), identMat());
}
function getCTM(el: Element, root: Element): Mat {
  const mats: Mat[] = [];
  let node: Element | null = el;
  while (node && node !== root.parentElement) {
    const t = node.getAttribute('transform');
    if (t) mats.unshift(parseTfm(t));
    node = node.parentElement;
  }
  return mats.reduce((acc,mm)=>mulMat(acc,mm), identMat());
}

// ── ViewBox → page-unit transform ─────────────────────────────────────────────

function buildVBTransform(svgEl: SVGSVGElement, pw: number, ph: number) {
  const vb = svgEl.getAttribute('viewBox');
  if (vb) {
    const [minX,minY,vbW,vbH] = vb.trim().split(/[\s,]+/).map(parseFloat);
    if ([minX,minY,vbW,vbH].every(n=>!isNaN(n)) && vbW>0 && vbH>0)
      return { sx:pw/vbW, sy:ph/vbH, tx:-minX*(pw/vbW), ty:-minY*(ph/vbH) };
  }
  const wa = parseFloat(svgEl.getAttribute('width')??'0') || pw;
  const ha = parseFloat(svgEl.getAttribute('height')??'0') || ph;
  return { sx:pw/wa, sy:ph/ha, tx:0, ty:0 };
}
function applyVB(x: number, y: number, vb: ReturnType<typeof buildVBTransform>): [number,number] {
  return [x*vb.sx+vb.tx, y*vb.sy+vb.ty];
}

function resolveStroke(el: Element): number {
  let node: Element | null = el;
  while (node) {
    const sw = node.getAttribute('stroke-width') ?? node.getAttribute('strokeWidth');
    if (sw) { const v=parseFloat(sw); if (!isNaN(v)&&v>0) return v; }
    const style = node.getAttribute('style')??'';
    const mm = style.match(/stroke-width\s*:\s*([\d.]+)/);
    if (mm) { const v=parseFloat(mm[1]); if (!isNaN(v)&&v>0) return v; }
    node = node.parentElement;
  }
  return 1.0;
}

// ── Segment types ─────────────────────────────────────────────────────────────

interface StraightSeg {
  kind: 'straight';
  x1: number; y1: number;
  x2: number; y2: number;
  mx: number; my: number;
  shapeId: string;
  sw: number;
}

interface CurveSeg {
  kind: 'curve';
  x1: number; y1: number;
  x2: number; y2: number;
  midX: number; midY: number;
  cp1x: number; cp1y: number;
  cp2x?: number; cp2y?: number;
  curveType: 'cubic' | 'quadratic';
  shapeId: string;
  sw: number;
}

type Seg = StraightSeg | CurveSeg;

// ── Merge collinear straight segments ─────────────────────────────────────────

function mergeCollinearSegments(segs: StraightSeg[]): StraightSeg[] {
  if (segs.length < 2) return segs;

  const merged: StraightSeg[] = [];
  const used = new Set<number>();
  const EPS_ANGLE = 0.01;
  const EPS_DIST  = 2;

  for (let i = 0; i < segs.length; i++) {
    if (used.has(i)) continue;

    let current = { ...segs[i] };
    let changed = true;

    while (changed) {
      changed = false;
      for (let j = 0; j < segs.length; j++) {
        if (used.has(j) || i === j) continue;
        const seg = segs[j];

        const angle1 = Math.atan2(current.y2 - current.y1, current.x2 - current.x1);
        const angle2 = Math.atan2(seg.y2 - seg.y1, seg.x2 - seg.x1);
        const angleDiff = Math.abs(angle1 - angle2) % Math.PI;
        if (Math.min(angleDiff, Math.PI - angleDiff) > EPS_ANGLE) continue;

        if (Math.hypot(current.x2 - seg.x1, current.y2 - seg.y1) < EPS_DIST) {
          current.x2 = seg.x2; current.y2 = seg.y2; used.add(j); changed = true;
        } else if (Math.hypot(current.x1 - seg.x2, current.y1 - seg.y2) < EPS_DIST) {
          current.x1 = seg.x1; current.y1 = seg.y1; used.add(j); changed = true;
        } else if (Math.abs(current.x1 - seg.x1) < EPS_DIST && Math.abs(current.y1 - seg.y1) < EPS_DIST) {
          current.x1 = seg.x2; current.y1 = seg.y2; used.add(j); changed = true;
        } else if (Math.abs(current.x2 - seg.x2) < EPS_DIST && Math.abs(current.y2 - seg.y2) < EPS_DIST) {
          current.x2 = seg.x1; current.y2 = seg.y1; used.add(j); changed = true;
        }
      }
    }

    const length = Math.hypot(current.x2 - current.x1, current.y2 - current.y1);
    if (length > 2) {
      // Recompute midpoint after merging
      current.mx = (current.x1 + current.x2) / 2;
      current.my = (current.y1 + current.y2) / 2;
      merged.push(current);
    }
  }

  return merged;
}

// ── Bezier midpoint at t=0.5 ──────────────────────────────────────────────────

function cubicMidpoint(
  x0:number,y0:number, cx1:number,cy1:number,
  cx2:number,cy2:number, x3:number,y3:number,
): [number,number] {
  const t=0.5, u=0.5;
  return [
    u*u*u*x0 + 3*u*u*t*cx1 + 3*u*t*t*cx2 + t*t*t*x3,
    u*u*u*y0 + 3*u*u*t*cy1 + 3*u*t*t*cy2 + t*t*t*y3,
  ];
}

function quadMidpoint(
  x0:number,y0:number, cx:number,cy:number, x2:number,y2:number,
): [number,number] {
  const t=0.5, u=0.5;
  return [u*u*x0+2*u*t*cx+t*t*x2, u*u*y0+2*u*t*cy+t*t*y2];
}

// ── Path → segs ───────────────────────────────────────────────────────────────

function pathToSegs(
  d: string,
  ctm: Mat,
  vb: ReturnType<typeof buildVBTransform>,
  shapeId: string, sw: number,
  pw: number, ph: number,
): Seg[] {
  const segs: Seg[] = [];
  let cx=0,cy=0,sx=0,sy=0;
  let lastCpX=0,lastCpY=0,lastCmd='';

  const toPage = (x: number, y: number): [number,number] => {
    const [mx,my] = applyMat(ctm,x,y);
    return applyVB(mx,my,vb);
  };

  const pushStraight = (ax:number,ay:number, bx:number,by:number) => {
    const [pax,pay]=toPage(ax,ay), [pbx,pby]=toPage(bx,by);
    if (Math.hypot(pbx-pax,pby-pay)<0.5) return;
    segs.push({ kind:'straight', x1:pax,y1:pay, x2:pbx,y2:pby,
      mx:(pax+pbx)/2, my:(pay+pby)/2, shapeId, sw });
  };

  const pushCubic = (
    ax:number,ay:number,
    c1x:number,c1y:number, c2x:number,c2y:number,
    bx:number,by:number,
  ) => {
    const [pax,pay]   = toPage(ax,ay);
    const [pbx,pby]   = toPage(bx,by);
    const [pc1x,pc1y] = toPage(c1x,c1y);
    const [pc2x,pc2y] = toPage(c2x,c2y);
    if (Math.hypot(pbx-pax,pby-pay)<0.5) return;
    const [midX,midY] = cubicMidpoint(pax,pay,pc1x,pc1y,pc2x,pc2y,pbx,pby);
    segs.push({ kind:'curve', curveType:'cubic',
      x1:pax,y1:pay, x2:pbx,y2:pby,
      midX,midY,
      cp1x:pc1x,cp1y:pc1y, cp2x:pc2x,cp2y:pc2y,
      shapeId, sw });
  };

  const pushQuad = (
    ax:number,ay:number, c1x:number,c1y:number, bx:number,by:number,
  ) => {
    const [pax,pay]   = toPage(ax,ay);
    const [pbx,pby]   = toPage(bx,by);
    const [pc1x,pc1y] = toPage(c1x,c1y);
    if (Math.hypot(pbx-pax,pby-pay)<0.5) return;
    const [midX,midY] = quadMidpoint(pax,pay,pc1x,pc1y,pbx,pby);
    segs.push({ kind:'curve', curveType:'quadratic',
      x1:pax,y1:pay, x2:pbx,y2:pby,
      midX,midY,
      cp1x:pc1x,cp1y:pc1y,
      shapeId, sw });
  };

  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz][^MmLlHhVvCcSsQqTtAaZz]*/g);
  if (!tokens) return segs;

  for (const token of tokens) {
    const cmd=token[0], upper=cmd.toUpperCase(), rel=cmd!==upper;
    const nums=token.slice(1).trim().split(/[\s,]+/).map(parseFloat).filter(n=>!isNaN(n));
    const ox=rel?cx:0, oy=rel?cy:0;

    switch (upper) {
      case 'M':
        for (let i=0;i+1<nums.length;i+=2) {
          const bx=i===0?ox:(rel?cx:0), by=i===0?oy:(rel?cy:0);
          cx=bx+nums[i]; cy=by+nums[i+1];
          if (i===0){sx=cx;sy=cy;}
        }
        lastCpX=cx; lastCpY=cy; break;

      case 'L':
        for (let i=0;i+1<nums.length;i+=2) {
          const nx=ox+nums[i], ny=oy+nums[i+1];
          pushStraight(cx,cy,nx,ny); cx=nx; cy=ny;
        }
        lastCpX=cx; lastCpY=cy; break;

      case 'H':
        for (const n of nums) { const nx=ox+n; pushStraight(cx,cy,nx,cy); cx=nx; }
        lastCpX=cx; lastCpY=cy; break;

      case 'V':
        for (const n of nums) { const ny=oy+n; pushStraight(cx,cy,cx,ny); cy=ny; }
        lastCpX=cx; lastCpY=cy; break;

      case 'C':
        for (let i=0;i+5<nums.length;i+=6) {
          const c1x=ox+nums[i],   c1y=oy+nums[i+1];
          const c2x=ox+nums[i+2], c2y=oy+nums[i+3];
          const nx =ox+nums[i+4], ny =oy+nums[i+5];
          pushCubic(cx,cy, c1x,c1y, c2x,c2y, nx,ny);
          lastCpX=c2x; lastCpY=c2y;
          cx=nx; cy=ny;
        } break;

      case 'S': {
        for (let i=0;i+3<nums.length;i+=4) {
          const prev = lastCmd==='C'||lastCmd==='S';
          const c1x = prev ? 2*cx-lastCpX : cx;
          const c1y = prev ? 2*cy-lastCpY : cy;
          const c2x=ox+nums[i],   c2y=oy+nums[i+1];
          const nx =ox+nums[i+2], ny =oy+nums[i+3];
          pushCubic(cx,cy, c1x,c1y, c2x,c2y, nx,ny);
          lastCpX=c2x; lastCpY=c2y;
          cx=nx; cy=ny;
        } break;
      }

      case 'Q':
        for (let i=0;i+3<nums.length;i+=4) {
          const c1x=ox+nums[i],   c1y=oy+nums[i+1];
          const nx =ox+nums[i+2], ny =oy+nums[i+3];
          pushQuad(cx,cy, c1x,c1y, nx,ny);
          lastCpX=c1x; lastCpY=c1y;
          cx=nx; cy=ny;
        } break;

      case 'T': {
        for (let i=0;i+1<nums.length;i+=2) {
          const prev = lastCmd==='Q'||lastCmd==='T';
          const c1x = prev ? 2*cx-lastCpX : cx;
          const c1y = prev ? 2*cy-lastCpY : cy;
          const nx=ox+nums[i], ny=oy+nums[i+1];
          pushQuad(cx,cy, c1x,c1y, nx,ny);
          lastCpX=c1x; lastCpY=c1y;
          cx=nx; cy=ny;
        } break;
      }

      case 'A':
        for (let i=0;i+6<nums.length;i+=7) {
          const nx=ox+nums[i+5], ny=oy+nums[i+6];
          pushStraight(cx,cy,nx,ny);
          cx=nx; cy=ny;
        }
        lastCpX=cx; lastCpY=cy; break;

      case 'Z':
        if (Math.hypot(cx-sx,cy-sy)>0.5) pushStraight(cx,cy,sx,sy);
        cx=sx; cy=sy; lastCpX=cx; lastCpY=cy; break;
    }
    lastCmd=upper;
  }
  return segs;
}

// ── Intersection detection ────────────────────────────────────────────────────

interface LineSeg { x1:number;y1:number;x2:number;y2:number; sw:number }

function segIntersection(s1: LineSeg, s2: LineSeg): [number,number]|null {
  const dx1=s1.x2-s1.x1,dy1=s1.y2-s1.y1;
  const dx2=s2.x2-s2.x1,dy2=s2.y2-s2.y1;
  const denom=dx1*dy2-dy1*dx2;
  if (Math.abs(denom)<1e-8) return null;
  const dx3=s2.x1-s1.x1,dy3=s2.y1-s1.y1;
  const t=(dx3*dy2-dy3*dx2)/denom;
  const u=(dx3*dy1-dy3*dx1)/denom;
  const EPS=0.01;
  if (t<-EPS||t>1+EPS||u<-EPS||u>1+EPS) return null;
  return [s1.x1+t*dx1, s1.y1+t*dy1];
}

function dedup(pts: Array<[number,number]>, radius: number): Array<[number,number]> {
  const out: Array<[number,number]> = [];
  for (const [x,y] of pts) {
    if (!out.some(([ox,oy])=>Math.hypot(x-ox,y-oy)<radius)) out.push([x,y]);
  }
  return out;
}

// ── Circle/ellipse snap points ─────────────────────────────────────────────────

function circleSnapPoints(
  el: Element, ctm: Mat, vb: ReturnType<typeof buildVBTransform>,
  shapeId: string, sw: number, pw: number, ph: number,
): SvgSnapPoint[] {
  const pts: SvgSnapPoint[] = [];
  const toNorm = (x:number,y:number):[number,number] => {
    const [mx,my]=applyMat(ctm,x,y);
    const [vx,vy]=applyVB(mx,my,vb);
    return [vx/pw, vy/ph];
  };
  const tag = el.tagName.toLowerCase();
  if (tag==='circle') {
    const cx2=parseFloat(el.getAttribute('cx')??'0');
    const cy2=parseFloat(el.getAttribute('cy')??'0');
    const r  =parseFloat(el.getAttribute('r') ??'0');
    if (r<=0) return pts;
    const [cnx,cny]=toNorm(cx2,cy2);
    pts.push({nx:cnx,ny:cny,type:'centroid',shapeId,strokeWidth:sw});
    for (const [dx,dy] of [[0,-r],[0,r],[-r,0],[r,0]] as [number,number][]) {
      const [enx,eny]=toNorm(cx2+dx,cy2+dy);
      if (enx>=0&&enx<=1&&eny>=0&&eny<=1)
        pts.push({nx:enx,ny:eny,type:'endpoint',shapeId,strokeWidth:sw});
    }
  } else if (tag==='ellipse') {
    const cx2=parseFloat(el.getAttribute('cx')??'0');
    const cy2=parseFloat(el.getAttribute('cy')??'0');
    const rx =parseFloat(el.getAttribute('rx')??'0');
    const ry =parseFloat(el.getAttribute('ry')??'0');
    if (rx<=0||ry<=0) return pts;
    const [cnx,cny]=toNorm(cx2,cy2);
    pts.push({nx:cnx,ny:cny,type:'centroid',shapeId,strokeWidth:sw});
    for (const [dx,dy] of [[0,-ry],[0,ry],[-rx,0],[rx,0]] as [number,number][]) {
      const [enx,eny]=toNorm(cx2+dx,cy2+dy);
      if (enx>=0&&enx<=1&&eny>=0&&eny<=1)
        pts.push({nx:enx,ny:eny,type:'endpoint',shapeId,strokeWidth:sw});
    }
  }
  return pts;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useSvgSnapPoints(
  svgContent: string | null,
  pdfDims: PdfDimensions | null,
  // zoom param intentionally removed — snap points are normalised (0-1) and
  // are zoom-independent. Passing zoom caused useMemo to re-run on every wheel
  // tick, rebuilding thousands of snap points and hanging the browser.
): { snapPoints: SvgSnapPoint[]; svgCurves: SvgCurve[] } {

  // ── Phase 1: parse SVG → segs (zoom-independent, expensive) ───────────────
  const parsed = useMemo(() => {
    if (!svgContent || !pdfDims) return null;
    const { w: pw, h: ph } = pdfDims;

    try {
      const parser  = new DOMParser();
      const svgDoc  = parser.parseFromString(svgContent, 'image/svg+xml');
      const svgRoot = svgDoc.documentElement;
      if (svgRoot.querySelector('parsererror')) throw new Error('Invalid SVG');
      const svgEl = svgDoc.querySelector('svg') as SVGSVGElement|null;
      if (!svgEl) throw new Error('No <svg>');

      const vb = buildVBTransform(svgEl, pw, ph);
      const rawStraightSegs: StraightSeg[] = [];
      const curveSegs: CurveSeg[] = [];
      let idCounter = 0;

      const processEl = (el: Element) => {
        const tag = el.tagName.toLowerCase();
        if (['circle','ellipse','rect'].includes(tag)) return;
        const ctm = getCTM(el, svgEl);
        const sw  = resolveStroke(el);
        const id  = `shape-${idCounter++}`;

        if (tag==='line') {
          const x1=parseFloat(el.getAttribute('x1')||'0');
          const y1=parseFloat(el.getAttribute('y1')||'0');
          const x2=parseFloat(el.getAttribute('x2')||'0');
          const y2=parseFloat(el.getAttribute('y2')||'0');
          const [ax,ay]=applyVB(...applyMat(ctm,x1,y1),vb);
          const [bx,by]=applyVB(...applyMat(ctm,x2,y2),vb);
          if (Math.hypot(bx-ax,by-ay)>0.5)
            rawStraightSegs.push({ kind:'straight', x1:ax,y1:ay, x2:bx,y2:by,
              mx:(ax+bx)/2, my:(ay+by)/2, shapeId:id, sw });
        } else if (tag==='path') {
          const segs = pathToSegs(el.getAttribute('d')??'',ctm,vb,id,sw,pw,ph);
          for (const seg of segs) {
            if (seg.kind === 'straight') rawStraightSegs.push(seg);
            else curveSegs.push(seg);
          }
        } else if (tag==='polyline'||tag==='polygon') {
          const raw=el.getAttribute('points')??'';
          const nums=raw.trim().split(/[\s,]+/).map(parseFloat).filter(n=>!isNaN(n));
          const pxpts: Array<[number,number]> = [];
          for (let i=0;i+1<nums.length;i+=2)
            pxpts.push(applyVB(...applyMat(ctm,nums[i],nums[i+1]),vb));
          for (let i=0;i+1<pxpts.length;i++) {
            const [ax,ay]=pxpts[i],[bx,by]=pxpts[i+1];
            if (Math.hypot(bx-ax,by-ay)>0.5)
              rawStraightSegs.push({ kind:'straight', x1:ax,y1:ay, x2:bx,y2:by,
                mx:(ax+bx)/2, my:(ay+by)/2, shapeId:id, sw });
          }
          if (tag==='polygon'&&pxpts.length>=2) {
            const [ax,ay]=pxpts[pxpts.length-1],[bx,by]=pxpts[0];
            if (Math.hypot(bx-ax,by-ay)>0.5)
              rawStraightSegs.push({ kind:'straight', x1:ax,y1:ay, x2:bx,y2:by,
                mx:(ax+bx)/2, my:(ay+by)/2, shapeId:id, sw });
          }
        }
      };

      svgRoot.querySelectorAll('line,path,polyline,polygon').forEach(processEl);

      const mergedStraightSegs = mergeCollinearSegments(rawStraightSegs);

      console.log(`[useSvgSnapPoints] ${rawStraightSegs.length} raw segs → ${mergedStraightSegs.length} merged lines`);

      // Endpoints from merged straight segs
      const straightEndpointPx = dedup(
        mergedStraightSegs.flatMap(s=>[[s.x1,s.y1],[s.x2,s.y2]] as Array<[number,number]>),
        2.0,
      );

      // Endpoints from curve anchor points only (not samples)
      const curveEndpointPx: Array<[number,number]> = curveSegs
        .flatMap(s=>[[s.x1,s.y1],[s.x2,s.y2]] as Array<[number,number]>);

      const allEndpointPx = dedup([...straightEndpointPx, ...curveEndpointPx], 2.0);

      // Intersections — only straight segs participate
      const straightSegsForIntersection: LineSeg[] = mergedStraightSegs
        .map(s=>({ x1:s.x1,y1:s.y1, x2:s.x2,y2:s.y2, sw:s.sw }));

      const MAX = 3000;
      const segsForX = straightSegsForIntersection.length > MAX
        ? straightSegsForIntersection.filter(s=>s.sw>0.3)
        : straightSegsForIntersection;

      const intersectionPx: Array<[number,number]> = [];
      for (let i=0;i<segsForX.length;i++) {
        for (let j=i+1;j<segsForX.length;j++) {
          const s1=segsForX[i], s2=segsForX[j];
          const a1=Math.atan2(s1.y2-s1.y1,s1.x2-s1.x1);
          const a2=Math.atan2(s2.y2-s2.y1,s2.x2-s2.x1);
          const diff=Math.abs(a1-a2)%Math.PI;
          if (Math.min(diff,Math.PI-diff)<0.26) continue;
          const pt=segIntersection(s1,s2);
          if (!pt) continue;
          const [ix,iy]=pt;
          if (ix<-pw*0.05||ix>pw*1.05||iy<-ph*0.05||iy>ph*1.05) continue;
          intersectionPx.push([ix,iy]);
        }
      }
      const dedupedIntersections = dedup(intersectionPx, 6.0);

      const circlePts: SvgSnapPoint[] = [];
      svgRoot.querySelectorAll('circle,ellipse').forEach(el => {
        circlePts.push(...circleSnapPoints(
          el, getCTM(el,svgEl), vb, `shape-${idCounter++}`, resolveStroke(el), pw, ph,
        ));
      });

      const svgCurves: SvgCurve[] = curveSegs.map(s => ({
        type:   s.curveType,
        nx1:    s.x1/pw,  ny1:  s.y1/ph,
        ncp1x:  s.cp1x/pw, ncp1y: s.cp1y/ph,
        ...(s.curveType==='cubic' && s.cp2x!==undefined
          ? { ncp2x: s.cp2x/pw, ncp2y: s.cp2y!/ph }
          : {}),
        nx2:    s.x2/pw,  ny2:  s.y2/ph,
        shapeId: s.shapeId,
        sw:      s.sw,
      }));

      return {
        mergedStraightSegs,
        curveSegs,
        allEndpointPx,
        dedupedIntersections,
        circlePts,
        svgCurves,
        pw, ph,
      };
    } catch(err) {
      console.error('[useSvgSnapPoints] parse error:', err);
      return null;
    }
  }, [svgContent, pdfDims]);

  // ── Phase 2: build snap point list ────────────────────────────────────────
  // zoom intentionally omitted from deps — normalised coords are zoom-independent.
  // This memo now only re-runs when SVG content or PDF dimensions change,
  // never on wheel/zoom events.
  return useMemo(() => {
    if (!parsed) return { snapPoints: [], svgCurves: [] };
    const { mergedStraightSegs, curveSegs, allEndpointPx, dedupedIntersections, circlePts, svgCurves, pw, ph } = parsed;

    const snapPoints: SvgSnapPoint[] = [];

    // Endpoints (corner points where lines change direction)
    for (const [x,y] of allEndpointPx) {
      if (x<0||x>pw||y<0||y>ph) continue;
      snapPoints.push({ nx:x/pw, ny:y/ph, type:'endpoint', shapeId:'corner', strokeWidth:1 });
    }

    // One midpoint per merged straight line.
    // Raw PDF-pixel distance — no zoom multiplication needed since these are
    // computed once at parse time and stored as normalised coords.
    for (const seg of mergedStraightSegs) {
      const svgDist = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1);
      if (svgDist < MIN_PDF_PX_FOR_MIDPOINT) continue;
      const mnx = seg.mx / pw, mny = seg.my / ph;
      if (mnx<0||mnx>1||mny<0||mny>1) continue;
      snapPoints.push({ nx:mnx, ny:mny, type:'midpoint', shapeId:'seg', strokeWidth:1 });
    }

    // One midpoint per bezier curve (at t=0.5) — always shown, one per curve
    const curveMidCandidates: Array<[number,number]> = curveSegs
      .map(s => [s.midX, s.midY] as [number,number]);
    const dedupedCurveMids = dedup(curveMidCandidates, 4.0);
    for (const [x,y] of dedupedCurveMids) {
      if (x<0||x>pw||y<0||y>ph) continue;
      snapPoints.push({ nx:x/pw, ny:y/ph, type:'midpoint', shapeId:'curve', strokeWidth:1 });
    }

    // Circle / ellipse points
    snapPoints.push(...circlePts);

    // Intersections
    for (const [x,y] of dedupedIntersections) {
      if (x<-pw*0.02||x>pw*1.02||y<-ph*0.02||y>ph*1.02) continue;
      snapPoints.push({ nx:x/pw, ny:y/ph, type:'intersection', shapeId:'corner', strokeWidth:1.5 });
    }

    console.log(
      `[useSvgSnapPoints] ${snapPoints.length} pts: ` +
      `${allEndpointPx.length} corners, ` +
      `${mergedStraightSegs.length} straight-mids, ` +
      `${dedupedCurveMids.length} curve-mids, ` +
      `${circlePts.length} circle, ` +
      `${dedupedIntersections.length} intersections | ` +
      `${svgCurves.length} bezier curves`,
    );

    return { snapPoints, svgCurves };
  }, [parsed]); // zoom intentionally omitted — normalised coords are zoom-independent
}
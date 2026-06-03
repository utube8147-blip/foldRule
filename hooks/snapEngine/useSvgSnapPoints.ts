/**
 * useSvgSnapPoints.ts
 *
 * PERF ARCHITECTURE:
 *
 *  Parsing strategy — EAGER, on PDF/SVG arrival:
 *    - Parse fires immediately when svgContent + pdfDims are available.
 *    - snapEnabled has ZERO effect on when parsing happens.
 *    - If a user enables snap mid-session the data is already ready —
 *      instant, no delay, no flash of "parsing…".
 *    - Results are module-level cached keyed on svgContent string identity.
 *      Same SVG loaded again (e.g. page navigation) → O(1) cache hit.
 *
 *  Phase 1 (Main thread, inside startTransition):
 *    - DOMParser, segment walk, merge collinear segs, collect
 *      endpoints/curves. React deprioritises it via startTransition so
 *      it never blocks a paint frame.
 *    - DOMParser is NOT reliably available in Web Workers across all
 *      environments (fails in Next.js dev/Turbopack). Main thread is
 *      the correct, portable solution.
 *
 *  Phase 2 (Web Worker, async):
 *    - O(N²) intersection pipeline with two-level spatial culling.
 *    - Worker contains ZERO DOM APIs — pure arithmetic only.
 *    - Posts results back; hook merges into snap state via startTransition.
 *
 *  snapEnabled:
 *    - Controls ONLY what the hook returns — when false, returns empty
 *      arrays so the snap engine and pin canvas have nothing to draw.
 *    - Never gates parsing. Toggling snap on is always instant from cache.
 *
 *  Stroke pre-filter:
 *    - Elements with stroke-width < 0.3px are skipped (hairline
 *      hatch/dimension lines that are never snap targets).
 *
 *  Intersection algorithm (worker):
 *    Level 1 — Angle buckets (4°-wide bins, 45 buckets)
 *    Level 2 — Adaptive spatial grid
 */

import { useState, useEffect, useRef, startTransition } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

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

export interface SvgLine {
  nx1:     number; ny1: number;
  nx2:     number; ny2: number;
  shapeId: string;
}

interface PdfDimensions { w: number; h: number }

// ─────────────────────────────────────────────────────────────────────────────
// Internal parse result (produced on main thread, module-level cached)
// ─────────────────────────────────────────────────────────────────────────────

interface ParseResult {
  mergedSegs:  Array<{ x1:number; y1:number; x2:number; y2:number; mx:number; my:number; sw:number }>;
  curves:      Array<{
    curveType: 'cubic' | 'quadratic';
    x1:number; y1:number; x2:number; y2:number;
    midX:number; midY:number;
    cp1x:number; cp1y:number;
    cp2x?:number; cp2y?:number;
    sw:number;
  }>;
  endpointsPx: Array<[number, number]>;
  circlePts:   SvgSnapPoint[];
  svgCurves:   SvgCurve[];
  pw:          number;
  ph:          number;
  timings:     Record<string, number>;
  counts:      Record<string, number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level caches — survive zoom/pan re-renders
// ─────────────────────────────────────────────────────────────────────────────

const parseCache        = new Map<string, ParseResult>();
const intersectionCache = new Map<string, Array<[number, number]>>();

// ─────────────────────────────────────────────────────────────────────────────
// Main-thread geometry helpers
// ─────────────────────────────────────────────────────────────────────────────

type Mat = { a:number; b:number; c:number; d:number; e:number; f:number };

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
    let mat: Mat = identMat();
    switch (m[1]) {
      case 'matrix':    mat={a:args[0],b:args[1],c:args[2],d:args[3],e:args[4],f:args[5]}; break;
      case 'translate': mat={...identMat(),e:args[0]??0,f:args[1]??0}; break;
      case 'scale': { const sx=args[0]??1, sy=args[1]??sx; mat={a:sx,b:0,c:0,d:sy,e:0,f:0}; break; }
      case 'rotate': {
        const ang=(args[0]??0)*Math.PI/180, cos=Math.cos(ang), sin=Math.sin(ang);
        const cx=args[1]??0, cy=args[2]??0;
        mat={a:cos,b:sin,c:-sin,d:cos,e:cx-cos*cx+sin*cy,f:cy-sin*cx-cos*cy}; break;
      }
    }
    mats.push(mat);
  }
  return mats.reduce((acc, mm) => mulMat(acc, mm), identMat());
}

function getCTM(el: Element, root: Element): Mat {
  const mats: Mat[] = [];
  let node: Element | null = el;
  while (node && node !== root.parentElement) {
    const t = node.getAttribute('transform');
    if (t) mats.unshift(parseTfm(t));
    node = node.parentElement;
  }
  return mats.reduce((acc, mm) => mulMat(acc, mm), identMat());
}

type VBT = { sx:number; sy:number; tx:number; ty:number };

function buildVBTransform(svgEl: Element, pw: number, ph: number): VBT {
  const vb = svgEl.getAttribute('viewBox');
  if (vb) {
    const [minX,minY,vbW,vbH] = vb.trim().split(/[\s,]+/).map(parseFloat);
    if ([minX,minY,vbW,vbH].every(n => !isNaN(n)) && vbW>0 && vbH>0)
      return { sx:pw/vbW, sy:ph/vbH, tx:-minX*(pw/vbW), ty:-minY*(ph/vbH) };
  }
  const wa = parseFloat(svgEl.getAttribute('width')||'0') || pw;
  const ha = parseFloat(svgEl.getAttribute('height')||'0') || ph;
  return { sx:pw/wa, sy:ph/ha, tx:0, ty:0 };
}

function applyVB(x: number, y: number, vb: VBT): [number, number] {
  return [x*vb.sx+vb.tx, y*vb.sy+vb.ty];
}

function resolveStroke(el: Element): number {
  let node: Element | null = el;
  while (node) {
    const sw = node.getAttribute('stroke-width') || node.getAttribute('strokeWidth');
    if (sw) { const v = parseFloat(sw); if (!isNaN(v) && v > 0) return v; }
    const style = node.getAttribute('style') || '';
    const mm = style.match(/stroke-width\s*:\s*([\d.]+)/);
    if (mm) { const v = parseFloat(mm[1]); if (!isNaN(v) && v > 0) return v; }
    node = node.parentElement;
  }
  return 1.0;
}

function dedupPts(pts: Array<[number, number]>, radius: number): Array<[number, number]> {
  const inv = 1 / radius;
  const seen = new Map<number, true>();
  const out: Array<[number, number]> = [];
  for (const [x, y] of pts) {
    const cx = Math.round(x * inv), cy = Math.round(y * inv);
    const key = (cx + 32768) * 65536 + (cy + 32768);
    if (!seen.has(key)) { seen.set(key, true); out.push([x, y]); }
  }
  return out;
}

function cubicMidpoint(
  x0:number, y0:number, cx1:number, cy1:number,
  cx2:number, cy2:number, x3:number, y3:number,
): [number, number] {
  return [
    0.125*x0+0.375*cx1+0.375*cx2+0.125*x3,
    0.125*y0+0.375*cy1+0.375*cy2+0.125*y3,
  ];
}

function quadMidpoint(x0:number, y0:number, cx:number, cy:number, x2:number, y2:number): [number, number] {
  return [0.25*x0+0.5*cx+0.25*x2, 0.25*y0+0.5*cy+0.25*y2];
}

// ─────────────────────────────────────────────────────────────────────────────
// Merge collinear segments
// ─────────────────────────────────────────────────────────────────────────────

interface RawSeg {
  x1:number; y1:number; x2:number; y2:number;
  mx:number; my:number; sw:number;
}

function mergeCollinearSegments(segs: RawSeg[]): RawSeg[] {
  if (segs.length < 2) return segs;
  const EPS_DIST      = 2;
  const ANGLE_BUCKETS = 180;
  const byAngle       = new Map<number, RawSeg[]>();

  for (const s of segs) {
    let ang = Math.atan2(s.y2-s.y1, s.x2-s.x1) * (180/Math.PI);
    if (ang < 0) ang += 180;
    const bucket = Math.round(ang) % ANGLE_BUCKETS;
    let g = byAngle.get(bucket);
    if (!g) { g = []; byAngle.set(bucket, g); }
    g.push(s);
  }

  const merged: RawSeg[] = [];
  for (const group of byAngle.values()) {
    if (group.length === 1) {
      const s = group[0];
      if (Math.hypot(s.x2-s.x1, s.y2-s.y1) > 2) merged.push(s);
      continue;
    }
    const ref = group[0];
    const dx  = ref.x2-ref.x1, dy = ref.y2-ref.y1;
    const len = Math.hypot(dx, dy) || 1;
    const ux  = dx/len, uy = dy/len;
    const project = (x: number, y: number) => x*ux + y*uy;
    group.sort((a, b) => project(a.x1, a.y1) - project(b.x1, b.y1));

    let cur = { ...group[0] };
    for (let i = 1; i < group.length; i++) {
      const s  = group[i];
      const d1 = Math.hypot(cur.x2-s.x1, cur.y2-s.y1);
      const d2 = Math.hypot(cur.x2-s.x2, cur.y2-s.y2);
      const d3 = Math.hypot(cur.x1-s.x1, cur.y1-s.y1);
      const d4 = Math.hypot(cur.x1-s.x2, cur.y1-s.y2);
      if      (d1 < EPS_DIST) { cur.x2=s.x2; cur.y2=s.y2; }
      else if (d2 < EPS_DIST) { cur.x2=s.x1; cur.y2=s.y1; }
      else if (d3 < EPS_DIST) { cur.x1=s.x2; cur.y1=s.y2; }
      else if (d4 < EPS_DIST) { cur.x1=s.x1; cur.y1=s.y1; }
      else {
        const l = Math.hypot(cur.x2-cur.x1, cur.y2-cur.y1);
        if (l > 2) { cur.mx=(cur.x1+cur.x2)/2; cur.my=(cur.y1+cur.y2)/2; merged.push(cur); }
        cur = { ...s };
      }
    }
    const l = Math.hypot(cur.x2-cur.x1, cur.y2-cur.y1);
    if (l > 2) { cur.mx=(cur.x1+cur.x2)/2; cur.my=(cur.y1+cur.y2)/2; merged.push(cur); }
  }
  return merged;
}

// ─────────────────────────────────────────────────────────────────────────────
// Path → segments
// ─────────────────────────────────────────────────────────────────────────────

const MIN_STROKE_WIDTH = 0.3;

type AnySeg =
  | { kind:'straight'; x1:number; y1:number; x2:number; y2:number; mx:number; my:number; shapeId:string; sw:number }
  | { kind:'curve'; curveType:'cubic'|'quadratic'; x1:number; y1:number; x2:number; y2:number; midX:number; midY:number; cp1x:number; cp1y:number; cp2x?:number; cp2y?:number; shapeId:string; sw:number };

function pathToSegs(
  d: string, ctm: Mat, vb: VBT,
  shapeId: string, sw: number,
  pw: number, ph: number,
): AnySeg[] {
  const segs: AnySeg[] = [];
  let cx=0, cy=0, sx=0, sy=0, lastCpX=0, lastCpY=0, lastCmd='';

  const toPage = (x: number, y: number): [number, number] =>
    applyVB(...applyMat(ctm, x, y), vb);

  const pushStraight = (ax:number,ay:number,bx:number,by:number) => {
    const [pax,pay]=toPage(ax,ay), [pbx,pby]=toPage(bx,by);
    if (Math.hypot(pbx-pax,pby-pay) < 0.5) return;
    segs.push({ kind:'straight', x1:pax,y1:pay,x2:pbx,y2:pby, mx:(pax+pbx)/2,my:(pay+pby)/2, shapeId, sw });
  };

  const pushCubic = (ax:number,ay:number,c1x:number,c1y:number,c2x:number,c2y:number,bx:number,by:number) => {
    const [pax,pay]=toPage(ax,ay), [pbx,pby]=toPage(bx,by);
    const [pc1x,pc1y]=toPage(c1x,c1y), [pc2x,pc2y]=toPage(c2x,c2y);
    if (Math.hypot(pbx-pax,pby-pay) < 0.5) return;
    const [midX,midY] = cubicMidpoint(pax,pay,pc1x,pc1y,pc2x,pc2y,pbx,pby);
    segs.push({ kind:'curve', curveType:'cubic', x1:pax,y1:pay,x2:pbx,y2:pby, midX,midY, cp1x:pc1x,cp1y:pc1y,cp2x:pc2x,cp2y:pc2y, shapeId, sw });
  };

  const pushQuad = (ax:number,ay:number,c1x:number,c1y:number,bx:number,by:number) => {
    const [pax,pay]=toPage(ax,ay), [pbx,pby]=toPage(bx,by), [pc1x,pc1y]=toPage(c1x,c1y);
    if (Math.hypot(pbx-pax,pby-pay) < 0.5) return;
    const [midX,midY] = quadMidpoint(pax,pay,pc1x,pc1y,pbx,pby);
    segs.push({ kind:'curve', curveType:'quadratic', x1:pax,y1:pay,x2:pbx,y2:pby, midX,midY, cp1x:pc1x,cp1y:pc1y, shapeId, sw });
  };

  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz][^MmLlHhVvCcSsQqTtAaZz]*/g);
  if (!tokens) return segs;

  for (const token of tokens) {
    const cmd   = token[0], upper = cmd.toUpperCase(), rel = cmd !== upper;
    const nums  = token.slice(1).trim().split(/[\s,]+/).map(parseFloat).filter(n => !isNaN(n));
    const ox    = rel ? cx : 0, oy = rel ? cy : 0;

    switch (upper) {
      case 'M':
        for (let i=0; i+1<nums.length; i+=2) {
          const bx=i===0?ox:(rel?cx:0), by=i===0?oy:(rel?cy:0);
          cx=bx+nums[i]; cy=by+nums[i+1];
          if (i===0) { sx=cx; sy=cy; }
        }
        lastCpX=cx; lastCpY=cy; break;

      case 'L':
        for (let i=0; i+1<nums.length; i+=2) {
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
        for (let i=0; i+5<nums.length; i+=6) {
          const c1x=ox+nums[i],c1y=oy+nums[i+1],c2x=ox+nums[i+2],c2y=oy+nums[i+3];
          const nx=ox+nums[i+4],ny=oy+nums[i+5];
          pushCubic(cx,cy,c1x,c1y,c2x,c2y,nx,ny);
          lastCpX=c2x; lastCpY=c2y; cx=nx; cy=ny;
        }
        break;

      case 'S':
        for (let i=0; i+3<nums.length; i+=4) {
          const prev=lastCmd==='C'||lastCmd==='S';
          const c1x=prev?2*cx-lastCpX:cx, c1y=prev?2*cy-lastCpY:cy;
          const c2x=ox+nums[i],c2y=oy+nums[i+1],nx=ox+nums[i+2],ny=oy+nums[i+3];
          pushCubic(cx,cy,c1x,c1y,c2x,c2y,nx,ny);
          lastCpX=c2x; lastCpY=c2y; cx=nx; cy=ny;
        }
        break;

      case 'Q':
        for (let i=0; i+3<nums.length; i+=4) {
          const c1x=ox+nums[i],c1y=oy+nums[i+1],nx=ox+nums[i+2],ny=oy+nums[i+3];
          pushQuad(cx,cy,c1x,c1y,nx,ny);
          lastCpX=c1x; lastCpY=c1y; cx=nx; cy=ny;
        }
        break;

      case 'T':
        for (let i=0; i+1<nums.length; i+=2) {
          const prev=lastCmd==='Q'||lastCmd==='T';
          const c1x=prev?2*cx-lastCpX:cx, c1y=prev?2*cy-lastCpY:cy;
          const nx=ox+nums[i], ny=oy+nums[i+1];
          pushQuad(cx,cy,c1x,c1y,nx,ny);
          lastCpX=c1x; lastCpY=c1y; cx=nx; cy=ny;
        }
        break;

      case 'A':
        for (let i=0; i+6<nums.length; i+=7) {
          const nx=ox+nums[i+5], ny=oy+nums[i+6];
          pushStraight(cx,cy,nx,ny); cx=nx; cy=ny;
        }
        lastCpX=cx; lastCpY=cy; break;

      case 'Z':
        if (Math.hypot(cx-sx,cy-sy) > 0.5) pushStraight(cx,cy,sx,sy);
        cx=sx; cy=sy; lastCpX=cx; lastCpY=cy; break;
    }
    lastCmd = upper;
  }
  return segs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Circle / ellipse snap points
// ─────────────────────────────────────────────────────────────────────────────

function circleSnapPoints(
  el: Element, ctm: Mat, vb: VBT,
  shapeId: string, sw: number,
  pw: number, ph: number,
): SvgSnapPoint[] {
  const pts: SvgSnapPoint[] = [];
  const toNorm = (x: number, y: number): [number, number] => {
    const [mx,my] = applyMat(ctm,x,y);
    const [vx,vy] = applyVB(mx,my,vb);
    return [vx/pw, vy/ph];
  };
  const tag = el.tagName.toLowerCase();

  if (tag === 'circle') {
    const cx2=parseFloat(el.getAttribute('cx')||'0');
    const cy2=parseFloat(el.getAttribute('cy')||'0');
    const r  =parseFloat(el.getAttribute('r') ||'0');
    if (r <= 0) return pts;
    const [cnx,cny] = toNorm(cx2,cy2);
    pts.push({ nx:cnx, ny:cny, type:'centroid', shapeId, strokeWidth:sw });
    for (const [dx,dy] of [[0,-r],[0,r],[-r,0],[r,0]] as [number,number][]) {
      const [enx,eny] = toNorm(cx2+dx, cy2+dy);
      if (enx>=0&&enx<=1&&eny>=0&&eny<=1)
        pts.push({ nx:enx, ny:eny, type:'endpoint', shapeId, strokeWidth:sw });
    }
  } else if (tag === 'ellipse') {
    const cx2=parseFloat(el.getAttribute('cx')||'0');
    const cy2=parseFloat(el.getAttribute('cy')||'0');
    const rx =parseFloat(el.getAttribute('rx')||'0');
    const ry =parseFloat(el.getAttribute('ry')||'0');
    if (rx<=0||ry<=0) return pts;
    const [cnx,cny] = toNorm(cx2,cy2);
    pts.push({ nx:cnx, ny:cny, type:'centroid', shapeId, strokeWidth:sw });
    for (const [dx,dy] of [[0,-ry],[0,ry],[-rx,0],[rx,0]] as [number,number][]) {
      const [enx,eny] = toNorm(cx2+dx, cy2+dy);
      if (enx>=0&&enx<=1&&eny>=0&&eny<=1)
        pts.push({ nx:enx, ny:eny, type:'endpoint', shapeId, strokeWidth:sw });
    }
  }
  return pts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1: parse SVG on main thread
// ─────────────────────────────────────────────────────────────────────────────

function parseSvgOnMainThread(svgContent: string, pw: number, ph: number): ParseResult {
  const t0   = performance.now();
  const tP0  = performance.now();

  const parser  = new DOMParser();
  const doc     = parser.parseFromString(svgContent, 'image/svg+xml');
  const svgRoot = doc.documentElement;
  if (svgRoot.querySelector('parseerror')) throw new Error('Invalid SVG');
  const svgEl = doc.querySelector('svg');
  if (!svgEl) throw new Error('No <svg> element found');
  const tParseMs = performance.now() - tP0;

  const vb           = buildVBTransform(svgEl, pw, ph);
  const rawStraight: RawSeg[]                          = [];
  const curveSeg:    Array<AnySeg & { kind:'curve' }>  = [];
  let   idCounter    = 0;

  const tW0 = performance.now();
  svgRoot.querySelectorAll('line,path,polyline,polygon').forEach(el => {
    const sw = resolveStroke(el);
    if (sw < MIN_STROKE_WIDTH) return;
    const tag = el.tagName.toLowerCase();
    const ctm = getCTM(el, svgEl);
    const id  = 'shape-' + (idCounter++);

    if (tag === 'line') {
      const x1=parseFloat(el.getAttribute('x1')||'0'), y1=parseFloat(el.getAttribute('y1')||'0');
      const x2=parseFloat(el.getAttribute('x2')||'0'), y2=parseFloat(el.getAttribute('y2')||'0');
      const [ax,ay] = applyVB(...applyMat(ctm,x1,y1), vb);
      const [bx,by] = applyVB(...applyMat(ctm,x2,y2), vb);
      if (Math.hypot(bx-ax,by-ay) > 0.5)
        rawStraight.push({ x1:ax,y1:ay,x2:bx,y2:by, mx:(ax+bx)/2,my:(ay+by)/2, sw });

    } else if (tag === 'path') {
      const segs = pathToSegs(el.getAttribute('d')||'', ctm, vb, id, sw, pw, ph);
      for (const s of segs) {
        if (s.kind === 'straight')
          rawStraight.push({ x1:s.x1,y1:s.y1,x2:s.x2,y2:s.y2, mx:s.mx,my:s.my, sw:s.sw });
        else
          curveSeg.push(s as AnySeg & { kind:'curve' });
      }

    } else if (tag === 'polyline' || tag === 'polygon') {
      const nums  = (el.getAttribute('points')||'').trim().split(/[\s,]+/).map(parseFloat).filter(n => !isNaN(n));
      const pxpts: [number,number][] = [];
      for (let i=0; i+1<nums.length; i+=2)
        pxpts.push(applyVB(...applyMat(ctm, nums[i], nums[i+1]), vb));
      for (let i=0; i+1<pxpts.length; i++) {
        const [ax,ay]=pxpts[i], [bx,by]=pxpts[i+1];
        if (Math.hypot(bx-ax,by-ay) > 0.5)
          rawStraight.push({ x1:ax,y1:ay,x2:bx,y2:by, mx:(ax+bx)/2,my:(ay+by)/2, sw });
      }
      if (tag === 'polygon' && pxpts.length >= 2) {
        const [ax,ay]=pxpts[pxpts.length-1], [bx,by]=pxpts[0];
        if (Math.hypot(bx-ax,by-ay) > 0.5)
          rawStraight.push({ x1:ax,y1:ay,x2:bx,y2:by, mx:(ax+bx)/2,my:(ay+by)/2, sw });
      }
    }
  });
  const tWalkMs = performance.now() - tW0;

  const tM0          = performance.now();
  const mergedSegs   = mergeCollinearSegments(rawStraight);
  const tMergeMs     = performance.now() - tM0;

  const tE0          = performance.now();
  const straightEpPx = dedupPts(mergedSegs.flatMap(s => [[s.x1,s.y1],[s.x2,s.y2]] as [number,number][]), 2.0);
  const curveEpPx    = curveSeg.flatMap(s => [[s.x1,s.y1],[s.x2,s.y2]] as [number,number][]);
  const endpointsPx  = dedupPts([...straightEpPx,...curveEpPx], 2.0);
  const tEpMs        = performance.now() - tE0;

  const tC0       = performance.now();
  const circlePts: SvgSnapPoint[] = [];
  svgRoot.querySelectorAll('circle,ellipse').forEach(el => {
    const sw = resolveStroke(el);
    circlePts.push(...circleSnapPoints(el, getCTM(el, svgEl), vb, 'shape-'+(idCounter++), sw, pw, ph));
  });
  const tCircleMs = performance.now() - tC0;

  const svgCurves: SvgCurve[] = curveSeg.map(s => ({
    type:  s.curveType,
    nx1:   s.x1/pw, ny1: s.y1/ph,
    ncp1x: s.cp1x/pw, ncp1y: s.cp1y/ph,
    ...(s.curveType==='cubic' && s.cp2x !== undefined
      ? { ncp2x:s.cp2x/pw, ncp2y:(s.cp2y??0)/ph }
      : {}),
    nx2:     s.x2/pw, ny2: s.y2/ph,
    shapeId: s.shapeId, sw: s.sw,
  }));

  const curves = curveSeg.map(s => ({
    curveType: s.curveType,
    x1:s.x1, y1:s.y1, x2:s.x2, y2:s.y2,
    midX:s.midX, midY:s.midY,
    cp1x:s.cp1x, cp1y:s.cp1y,
    ...(s.cp2x !== undefined ? { cp2x:s.cp2x, cp2y:s.cp2y } : {}),
    sw: s.sw,
  }));

  const totalMs = performance.now() - t0;
  return {
    mergedSegs: mergedSegs.map(s => ({ x1:s.x1,y1:s.y1,x2:s.x2,y2:s.y2,mx:s.mx,my:s.my,sw:s.sw })),
    curves,
    endpointsPx,
    circlePts,
    svgCurves,
    pw, ph,
    timings: {
      domParse:  +tParseMs.toFixed(1),
      walkSegs:  +tWalkMs.toFixed(1),
      merge:     +tMergeMs.toFixed(1),
      endpoints: +tEpMs.toFixed(1),
      circles:   +tCircleMs.toFixed(1),
    },
    counts: {
      rawSegs:    rawStraight.length,
      mergedSegs: mergedSegs.length,
      curves:     curveSeg.length,
      endpoints:  endpointsPx.length,
      svgCurves:  svgCurves.length,
      totalMs:    +totalMs.toFixed(1),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 worker: intersections only — zero DOM APIs
// ─────────────────────────────────────────────────────────────────────────────

const INTERSECT_WORKER_SOURCE = /* js */`
const NUM_ANGLE_BUCKETS = 45;
const MIN_BUCKET_DIFF   = 2;
const MAX_INPUT_SEGS    = 2000;

function dedup(pts, radius) {
  const inv = 1 / radius;
  const seen = new Map();
  const out  = [];
  for (const [x, y] of pts) {
    const cx  = Math.round(x * inv), cy = Math.round(y * inv);
    const key = (cx + 32768) * 65536 + (cy + 32768);
    if (!seen.has(key)) { seen.set(key, true); out.push([x, y]); }
  }
  return out;
}

function segIntersection(s1, s2) {
  const dx1=s1.x2-s1.x1, dy1=s1.y2-s1.y1;
  const dx2=s2.x2-s2.x1, dy2=s2.y2-s2.y1;
  const denom = dx1*dy2 - dy1*dx2;
  if (Math.abs(denom) < 1e-8) return null;
  const dx3=s2.x1-s1.x1, dy3=s2.y1-s1.y1;
  const t = (dx3*dy2 - dy3*dx2) / denom;
  const u = (dx3*dy1 - dy3*dx1) / denom;
  const EPS = 0.01;
  if (t<-EPS||t>1+EPS||u<-EPS||u>1+EPS) return null;
  return [s1.x1+t*dx1, s1.y1+t*dy1];
}

self.onmessage = function(e) {
  const { segs, pw, ph, cacheKey } = e.data;
  const t0 = performance.now();

  const input = segs.slice().sort((a,b) => b.sw-a.sw).slice(0, MAX_INPUT_SEGS);
  const N     = input.length;
  if (N < 2) {
    self.postMessage({ cacheKey, intersections:[], ms:0, pairsTested:0 });
    return;
  }

  // Level 1 — angle buckets
  const angleBucket = new Int32Array(N);
  for (let i=0; i<N; i++) {
    const s = input[i];
    let ang = Math.atan2(s.y2-s.y1, s.x2-s.x1) * (180/Math.PI);
    if (ang < 0) ang += 180;
    angleBucket[i] = Math.floor(ang / (180/NUM_ANGLE_BUCKETS)) % NUM_ANGLE_BUCKETS;
  }

  // Level 2 — adaptive spatial grid
  const rawCellSize = Math.max(pw,ph) / Math.sqrt(N);
  const cellSize    = Math.max(60, Math.min(200, rawCellSize));
  const BIG         = 100000;
  const segCells    = new Array(N);
  for (let i=0; i<N; i++) {
    const s      = input[i];
    const minCol = Math.floor(Math.min(s.x1,s.x2)/cellSize);
    const maxCol = Math.floor(Math.max(s.x1,s.x2)/cellSize);
    const minRow = Math.floor(Math.min(s.y1,s.y2)/cellSize);
    const maxRow = Math.floor(Math.max(s.y1,s.y2)/cellSize);
    const cells  = new Set();
    for (let col=minCol; col<=maxCol; col++)
      for (let row=minRow; row<=maxRow; row++)
        cells.add(row*BIG+col);
    segCells[i] = cells;
  }

  const grid = new Map();
  for (let i=0; i<N; i++) {
    for (const key of segCells[i]) {
      let bucket = grid.get(key);
      if (!bucket) { bucket=[]; grid.set(key,bucket); }
      bucket.push(i);
    }
  }

  const testedPairKeys = new Set();
  const candidates     = [];
  for (const bucket of grid.values()) {
    if (bucket.length < 2) continue;
    for (let a=0; a<bucket.length; a++) {
      for (let b=a+1; b<bucket.length; b++) {
        const i=bucket[a], j=bucket[b];
        const lo=i<j?i:j, hi=i<j?j:i;
        const pairKey = lo*MAX_INPUT_SEGS+hi;
        if (testedPairKeys.has(pairKey)) continue;
        testedPairKeys.add(pairKey);
        const bd      = Math.abs(angleBucket[lo]-angleBucket[hi]);
        const angDiff = Math.min(bd, NUM_ANGLE_BUCKETS-bd);
        if (angDiff < MIN_BUCKET_DIFF) continue;
        candidates.push([lo, hi]);
      }
    }
  }

  const raw = [];
  for (const [i,j] of candidates) {
    const pt = segIntersection(input[i], input[j]);
    if (!pt) continue;
    const [ix,iy] = pt;
    if (ix<-pw*0.05||ix>pw*1.05||iy<-ph*0.05||iy>ph*1.05) continue;
    raw.push([ix, iy]);
  }

  const intersections = dedup(raw, 6.0);
  const ms            = performance.now() - t0;
  self.postMessage({ cacheKey, intersections, ms:+ms.toFixed(1), pairsTested:candidates.length });
};
`;

// ─────────────────────────────────────────────────────────────────────────────
// Worker lifecycle — one singleton, reused across hook invocations
// ─────────────────────────────────────────────────────────────────────────────

let _workerBlobUrl: string | null = null;
let _worker:        Worker | null = null;
let _workerRefs                   = 0;

function acquireWorker(): Worker {
  if (!_workerBlobUrl) {
    const blob = new Blob([INTERSECT_WORKER_SOURCE], { type: 'application/javascript' });
    _workerBlobUrl = URL.createObjectURL(blob);
  }
  if (!_worker) _worker = new Worker(_workerBlobUrl);
  _workerRefs++;
  return _worker;
}

function releaseWorker() {
  _workerRefs--;
  if (_workerRefs <= 0 && _worker) {
    _worker.terminate();
    _worker        = null;
    _workerRefs    = 0;
    if (_workerBlobUrl) { URL.revokeObjectURL(_workerBlobUrl); _workerBlobUrl = null; }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook state
// ─────────────────────────────────────────────────────────────────────────────

const LOG                    = '[SnapPoints]';
const MIN_PDF_PX_FOR_MIDPOINT = 12;

interface SnapState {
  forContent:    string;
  parsed:        ParseResult | null;
  intersections: Array<[number, number]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

export function useSvgSnapPoints(
  svgContent:  string | null,
  pdfDims:     PdfDimensions | null,
  snapEnabled: boolean,
): { snapPoints: SvgSnapPoint[]; svgCurves: SvgCurve[]; svgLines: SvgLine[] } {

  const [snapState, setSnapState] = useState<SnapState | null>(null);

  // Guards — prevent re-dispatching the same content
  const dispatchedParseRef     = useRef<string | null>(null);
  const dispatchedIntersectRef = useRef<string | null>(null);

  // ── EAGER PARSE EFFECT ─────────────────────────────────────────────────────
  // Fires as soon as svgContent + pdfDims are available.
  // snapEnabled is intentionally NOT a dependency — we always parse eagerly
  // so that enabling snap mid-session is instant from cache.
  useEffect(() => {
    if (!svgContent || !pdfDims) return;

    const pw = pdfDims.w;
    const ph = pdfDims.h;

    const cachedParse     = parseCache.get(svgContent);
    const cachedIntersect = intersectionCache.get(svgContent);

    // ── Both caches hit — just hydrate state ──────────────────────────────
    if (cachedParse && cachedIntersect) {
      if (snapState?.forContent !== svgContent) {
        startTransition(() =>
          setSnapState({ forContent:svgContent, parsed:cachedParse, intersections:cachedIntersect })
        );
      }
      return;
    }

    // ── Phase 1: parse on main thread ────────────────────────────────────
    if (!cachedParse && dispatchedParseRef.current !== svgContent) {
      dispatchedParseRef.current = svgContent;

      startTransition(() => {
        let parsed: ParseResult;
        try {
          parsed = parseSvgOnMainThread(svgContent, pw, ph);
          parseCache.set(svgContent, parsed);
          const timingStr = Object.entries(parsed.timings).map(([k,v]) => `${k}=${v}ms`).join(' | ');
          const countStr  = Object.entries(parsed.counts).map(([k,v])  => `${k}=${v}`).join(' ');
          console.log(`${LOG} [phase1:main] ${timingStr} — ${countStr}`);
        } catch (err) {
          console.error(`${LOG} [parse_error]`, err);
          return;
        }

        setSnapState(prev => ({
          forContent:    svgContent,
          parsed,
          intersections: prev?.forContent === svgContent ? prev.intersections : [],
        }));

        // ── Phase 2: dispatch intersections to worker ────────────────────
        const cachedI = intersectionCache.get(svgContent);
        if (cachedI) {
          console.log(`${LOG} [intersect] cache hit — ${cachedI.length} intersections`);
          setSnapState(prev => prev?.forContent === svgContent
            ? { ...prev, intersections: cachedI }
            : prev
          );
          return;
        }

        if (dispatchedIntersectRef.current === svgContent) return;
        dispatchedIntersectRef.current = svgContent;

        const worker        = acquireWorker();
        const segsForWorker = parsed.mergedSegs.map(s => ({ x1:s.x1,y1:s.y1,x2:s.x2,y2:s.y2,sw:s.sw }));
        console.log(`${LOG} [intersect] dispatching ${segsForWorker.length} segs to worker`);

        const onMessage = (e: MessageEvent) => {
          if (e.data?.cacheKey !== svgContent) return;
          const { intersections, ms, pairsTested } = e.data as {
            intersections: Array<[number,number]>; ms: number; pairsTested: number; cacheKey: string;
          };
          console.log(`${LOG} [intersect] done — ${intersections.length} pts, ${pairsTested} pairs, ${ms}ms`);
          intersectionCache.set(svgContent, intersections);
          startTransition(() => {
            setSnapState(prev => prev?.forContent === svgContent
              ? { ...prev, intersections }
              : prev
            );
          });
          worker.removeEventListener('message', onMessage);
          releaseWorker();
        };

        worker.addEventListener('message', onMessage);
        worker.postMessage({ segs: segsForWorker, pw, ph, cacheKey: svgContent });
      });

      return;
    }

    // ── Parse cached, intersect not yet dispatched ────────────────────────
    if (cachedParse && !cachedIntersect && dispatchedIntersectRef.current !== svgContent) {
      if (!snapState || snapState.forContent !== svgContent) {
        startTransition(() =>
          setSnapState({ forContent:svgContent, parsed:cachedParse, intersections:[] })
        );
      }

      dispatchedIntersectRef.current = svgContent;
      const worker        = acquireWorker();
      const segsForWorker = cachedParse.mergedSegs.map(s => ({ x1:s.x1,y1:s.y1,x2:s.x2,y2:s.y2,sw:s.sw }));

      const onMessage = (e: MessageEvent) => {
        if (e.data?.cacheKey !== svgContent) return;
        const { intersections, ms, pairsTested } = e.data as {
          intersections: Array<[number,number]>; ms: number; pairsTested: number; cacheKey: string;
        };
        console.log(`${LOG} [intersect] done — ${intersections.length} pts, ${pairsTested} pairs, ${ms}ms`);
        intersectionCache.set(svgContent, intersections);
        startTransition(() => {
          setSnapState(prev => prev?.forContent === svgContent
            ? { ...prev, intersections }
            : prev
          );
        });
        worker.removeEventListener('message', onMessage);
        releaseWorker();
      };

      worker.addEventListener('message', onMessage);
      worker.postMessage({ segs: segsForWorker, pw, ph, cacheKey: svgContent });
    }

  // pdfDims primitives only — immune to zoom-triggered object identity churn.
  // snapEnabled deliberately excluded — parsing must never depend on it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svgContent, pdfDims?.w, pdfDims?.h]);

  // ── Return empty when snap is off — zero assembly work ────────────────────
  // Parsing still ran above and results are cached. Toggling snap back on
  // is instant — this guard just stops the engine from receiving data.
  if (!snapEnabled) {
    return { snapPoints: [], svgCurves: [], svgLines: [] };
  }

  // ── Assemble final snap point list ────────────────────────────────────────
  if (!snapState || snapState.forContent !== svgContent || !snapState.parsed) {
    return { snapPoints: [], svgCurves: [], svgLines: [] };
  }

  const { parsed, intersections } = snapState;
  const { mergedSegs, curves, endpointsPx, circlePts, svgCurves, pw, ph } = parsed;

  const snapPoints: SvgSnapPoint[] = [];

  // Endpoints (corners)
  for (const [x, y] of endpointsPx) {
    if (x < 0 || x > pw || y < 0 || y > ph) continue;
    snapPoints.push({ nx:x/pw, ny:y/ph, type:'endpoint', shapeId:'corner', strokeWidth:1 });
  }

  // Straight midpoints
  for (const seg of mergedSegs) {
    if (Math.hypot(seg.x2-seg.x1, seg.y2-seg.y1) < MIN_PDF_PX_FOR_MIDPOINT) continue;
    const mnx = seg.mx/pw, mny = seg.my/ph;
    if (mnx < 0 || mnx > 1 || mny < 0 || mny > 1) continue;
    snapPoints.push({ nx:mnx, ny:mny, type:'midpoint', shapeId:'seg', strokeWidth:1 });
  }

  // Curve midpoints
  const curveMidsPx = dedupMain(curves.map(s => [s.midX, s.midY] as [number,number]), 4.0);
  for (const [x, y] of curveMidsPx) {
    if (x < 0 || x > pw || y < 0 || y > ph) continue;
    snapPoints.push({ nx:x/pw, ny:y/ph, type:'midpoint', shapeId:'curve', strokeWidth:1 });
  }

  // Circle / ellipse
  snapPoints.push(...circlePts);

  // Intersections
  for (const [x, y] of intersections) {
    if (x < -pw*0.02 || x > pw*1.02 || y < -ph*0.02 || y > ph*1.02) continue;
    snapPoints.push({ nx:x/pw, ny:y/ph, type:'intersection', shapeId:'corner', strokeWidth:1.5 });
  }

  // SvgLines — built from already-computed mergedSegs, no re-parse
  const svgLines: SvgLine[] = mergedSegs.map(seg => ({
    nx1: seg.x1/pw, ny1: seg.y1/ph,
    nx2: seg.x2/pw, ny2: seg.y2/ph,
    shapeId: 'seg',
  }));

  console.log(
    `${LOG} [assemble] total=${snapPoints.length}` +
    ` corners=${endpointsPx.length} straightMids=${mergedSegs.length}` +
    ` curveMids=${curveMidsPx.length} circlePts=${circlePts.length}` +
    ` intersections=${intersections.length} curves=${svgCurves.length}` +
    ` lines=${svgLines.length}`
  );

  return { snapPoints, svgCurves, svgLines };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main-thread dedup helper (assembly only — small arrays)
// ─────────────────────────────────────────────────────────────────────────────

function dedupMain(pts: Array<[number,number]>, radius: number): Array<[number,number]> {
  const inv  = 1 / radius;
  const seen = new Map<number, true>();
  const out: Array<[number,number]> = [];
  for (const [x, y] of pts) {
    const cx  = Math.round(x*inv), cy = Math.round(y*inv);
    const key = (cx+32768)*65536 + (cy+32768);
    if (!seen.has(key)) { seen.set(key, true); out.push([x, y]); }
  }
  return out;
}
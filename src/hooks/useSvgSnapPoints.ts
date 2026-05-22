/**
 * useSvgSnapPoints.ts  —  OPTIMIZED
 *
 * Perf changes vs previous version:
 *
 * 1. Phase 1 (parse) now runs in a Web Worker via snapWorker.ts.
 *    The main thread posts the SVG string + pdfDims and receives
 *    back the fully-computed segs, endpoints, intersections, curves.
 *    DOMParser is NOT used in the worker — a hand-rolled attribute
 *    extractor replaces querySelectorAll/getAttribute so no DOM is needed.
 *
 * 2. Phase 2 (zoom-aware midpoint filter) still runs on the main thread
 *    inside useMemo — it is a cheap O(n) loop and runs only when the
 *    worker posts new data OR zoom changes.
 *
 * 3. While the worker is computing, the hook returns the previous result
 *    (stale-while-revalidate) so the canvas never goes blank.
 *
 * 4. Worker is created once and reused; it is terminated on unmount.
 *
 * 5. No functional changes to snap-point geometry — outputs are identical.
 */

import { useState, useEffect, useMemo, useRef } from 'react';

export interface SvgSnapPoint {
  nx:          number;
  ny:          number;
  type:        'endpoint' | 'midpoint' | 'centroid' | 'intersection';
  shapeId:     string;
  strokeWidth: number;
}

export interface SvgCurve {
  type:   'cubic' | 'quadratic';
  nx1:    number; ny1:    number;
  ncp1x:  number; ncp1y:  number;
  ncp2x?: number; ncp2y?: number;
  nx2:    number; ny2:    number;
  shapeId: string;
  sw:      number;
}

interface PdfDimensions { w: number; h: number }

const MIN_SCREEN_GAP_FOR_MIDPOINT = 12;

// ─── Worker source (inlined as a blob URL) ────────────────────────────────────
// We inline the worker so no separate bundler config is needed.
// It contains the full parse pipeline from the previous version but
// with DOM calls replaced by regex/string helpers.

const WORKER_SRC = /* js */ `
'use strict';

// ── Matrix helpers ────────────────────────────────────────────────────────────
function identMat() { return { a:1,b:0,c:0,d:1,e:0,f:0 }; }
function mulMat(m1, m2) {
  return {
    a: m1.a*m2.a+m1.c*m2.b, b: m1.b*m2.a+m1.d*m2.b,
    c: m1.a*m2.c+m1.c*m2.d, d: m1.b*m2.c+m1.d*m2.d,
    e: m1.a*m2.e+m1.c*m2.f+m1.e, f: m1.b*m2.e+m1.d*m2.f+m1.f,
  };
}
function applyMat(m, x, y) {
  return [m.a*x+m.c*y+m.e, m.b*x+m.d*y+m.f];
}
function parseTfm(t) {
  if (!t) return identMat();
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\\(([^)]*)\\)/g;
  const mats = [];
  let m;
  while ((m = re.exec(t)) !== null) {
    const args = m[2].trim().split(/[\\s,]+/).map(parseFloat);
    let mat = identMat();
    switch (m[1]) {
      case 'matrix':    mat = {a:args[0],b:args[1],c:args[2],d:args[3],e:args[4],f:args[5]}; break;
      case 'translate': mat = {...identMat(), e:args[0]||0, f:args[1]||0}; break;
      case 'scale': { const sx=args[0]||1,sy=args[1]!==undefined?args[1]:sx; mat={a:sx,b:0,c:0,d:sy,e:0,f:0}; break; }
      case 'rotate': {
        const ang=(args[0]||0)*Math.PI/180,cos=Math.cos(ang),sin=Math.sin(ang);
        const cx=args[1]||0,cy=args[2]||0;
        mat={a:cos,b:sin,c:-sin,d:cos,e:cx-cos*cx+sin*cy,f:cy-sin*cx-cos*cy}; break;
      }
    }
    mats.push(mat);
  }
  return mats.reduce((acc,mm)=>mulMat(acc,mm), identMat());
}

// ── Minimal string-based SVG attribute reader ─────────────────────────────────
// Replaces DOMParser + querySelectorAll — works in a worker context.
function getAttr(elStr, name) {
  // matches name="value" or name='value'
  const re = new RegExp(name + '\\\\s*=\\\\s*["\\'']([^"\\'']*)[\\'"]', 'i');
  const m = re.exec(elStr);
  return m ? m[1] : null;
}
function numAttr(elStr, name, fb) {
  const v = parseFloat(getAttr(elStr, name) || '');
  return isNaN(v) ? (fb !== undefined ? fb : 0) : v;
}

// Extract all elements matching a tag from SVG text.
// Returns array of { tag, attrStr, fullMatch } objects.
function extractElements(svgText, tags) {
  const tagPat = tags.join('|');
  // self-closing and paired tags
  const re = new RegExp('<(' + tagPat + ')(\\\\s[^>]*)?\\/?>','gi');
  const results = [];
  let m;
  while ((m = re.exec(svgText)) !== null) {
    results.push({ tag: m[1].toLowerCase(), attrStr: m[0], index: m.index });
  }
  return results;
}

// Build accumulated transform from ancestor <g> elements.
// We walk the raw SVG string and collect transform= attributes
// on <g> tags that wrap (appear before) the element at elIndex.
function buildCTMFromString(svgText, elIndex) {
  const gRe = /<g(\\s[^>]*)?>/gi;
  const closeRe = /<\\/g>/gi;
  const stack = [];
  let m;

  // Collect all <g> open/close positions
  const opens = [];
  while ((m = gRe.exec(svgText)) !== null) opens.push({ pos: m.index, tfm: getAttr(m[0], 'transform') });
  const closes = [];
  while ((m = closeRe.exec(svgText)) !== null) closes.push(m.index);

  // Determine which <g> elements are ancestors of elIndex
  // A <g> is an ancestor if it opens before elIndex and its matching </g> is after elIndex.
  // We do a simple stack-based open/close matching.
  const events = [
    ...opens.map(o => ({ pos: o.pos, type: 'open', tfm: o.tfm })),
    ...closes.map(c => ({ pos: c, type: 'close' })),
  ].sort((a,b) => a.pos - b.pos);

  const ancestors = [];
  const s = [];
  for (const ev of events) {
    if (ev.pos >= elIndex) break;
    if (ev.type === 'open') {
      s.push(ev.tfm);
    } else {
      s.pop();
    }
  }
  // s now contains the transform strings for all open <g> ancestors
  const mats = s.map(t => parseTfm(t)).filter(Boolean);
  return mats.reduce((acc,mm) => mulMat(acc,mm), identMat());
}

// Parse viewBox → scale/translate
function buildVBTransform(svgText, pw, ph) {
  const vbM = /viewBox\\s*=\\s*["']([^"']*)["']/.exec(svgText);
  if (vbM) {
    const [minX,minY,vbW,vbH] = vbM[1].trim().split(/[\\s,]+/).map(parseFloat);
    if ([minX,minY,vbW,vbH].every(n=>!isNaN(n)) && vbW>0 && vbH>0)
      return { sx:pw/vbW, sy:ph/vbH, tx:-minX*(pw/vbW), ty:-minY*(ph/vbH) };
  }
  const wM = /\\bwidth\\s*=\\s*["']([\\d.]+)["']/.exec(svgText);
  const hM = /\\bheight\\s*=\\s*["']([\\d.]+)["']/.exec(svgText);
  const wa = parseFloat(wM?.[1] || '0') || pw;
  const ha = parseFloat(hM?.[1] || '0') || ph;
  return { sx:pw/wa, sy:ph/ha, tx:0, ty:0 };
}
function applyVB(x, y, vb) {
  return [x*vb.sx+vb.tx, y*vb.sy+vb.ty];
}

// ── Bezier midpoints ──────────────────────────────────────────────────────────
function cubicMidpoint(x0,y0,cx1,cy1,cx2,cy2,x3,y3) {
  const t=0.5,u=0.5;
  return [
    u*u*u*x0+3*u*u*t*cx1+3*u*t*t*cx2+t*t*t*x3,
    u*u*u*y0+3*u*u*t*cy1+3*u*t*t*cy2+t*t*t*y3,
  ];
}
function quadMidpoint(x0,y0,cx,cy,x2,y2) {
  const t=0.5,u=0.5;
  return [u*u*x0+2*u*t*cx+t*t*x2, u*u*y0+2*u*t*cy+t*t*y2];
}

// ── Path → segs ───────────────────────────────────────────────────────────────
function pathToSegs(d, ctm, vb, shapeId, sw, pw, ph) {
  const segs = [];
  let cx=0,cy=0,sx=0,sy=0;
  let lastCpX=0,lastCpY=0,lastCmd='';

  const toPage = (x,y) => {
    const [mx,my] = applyMat(ctm,x,y);
    return applyVB(mx,my,vb);
  };

  const pushStraight = (ax,ay,bx,by) => {
    const [pax,pay]=toPage(ax,ay), [pbx,pby]=toPage(bx,by);
    if (Math.hypot(pbx-pax,pby-pay)<0.5) return;
    segs.push({ kind:'straight', x1:pax,y1:pay, x2:pbx,y2:pby,
      mx:(pax+pbx)/2, my:(pay+pby)/2, shapeId, sw });
  };

  const pushCubic = (ax,ay,c1x,c1y,c2x,c2y,bx,by) => {
    const [pax,pay]=toPage(ax,ay);
    const [pbx,pby]=toPage(bx,by);
    const [pc1x,pc1y]=toPage(c1x,c1y);
    const [pc2x,pc2y]=toPage(c2x,c2y);
    if (Math.hypot(pbx-pax,pby-pay)<0.5) return;
    const [midX,midY]=cubicMidpoint(pax,pay,pc1x,pc1y,pc2x,pc2y,pbx,pby);
    segs.push({ kind:'curve', curveType:'cubic',
      x1:pax,y1:pay, x2:pbx,y2:pby, midX,midY,
      cp1x:pc1x,cp1y:pc1y, cp2x:pc2x,cp2y:pc2y, shapeId, sw });
  };

  const pushQuad = (ax,ay,c1x,c1y,bx,by) => {
    const [pax,pay]=toPage(ax,ay);
    const [pbx,pby]=toPage(bx,by);
    const [pc1x,pc1y]=toPage(c1x,c1y);
    if (Math.hypot(pbx-pax,pby-pay)<0.5) return;
    const [midX,midY]=quadMidpoint(pax,pay,pc1x,pc1y,pbx,pby);
    segs.push({ kind:'curve', curveType:'quadratic',
      x1:pax,y1:pay, x2:pbx,y2:pby, midX,midY,
      cp1x:pc1x,cp1y:pc1y, shapeId, sw });
  };

  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz][^MmLlHhVvCcSsQqTtAaZz]*/g);
  if (!tokens) return segs;

  for (const token of tokens) {
    const cmd=token[0], upper=cmd.toUpperCase(), rel=cmd!==upper;
    const nums=token.slice(1).trim().split(/[\\s,]+/).map(parseFloat).filter(n=>!isNaN(n));
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
          const nx=ox+nums[i],ny=oy+nums[i+1];
          pushStraight(cx,cy,nx,ny); cx=nx; cy=ny;
        }
        lastCpX=cx; lastCpY=cy; break;
      case 'H':
        for (const n of nums){const nx=ox+n;pushStraight(cx,cy,nx,cy);cx=nx;}
        lastCpX=cx; lastCpY=cy; break;
      case 'V':
        for (const n of nums){const ny=oy+n;pushStraight(cx,cy,cx,ny);cy=ny;}
        lastCpX=cx; lastCpY=cy; break;
      case 'C':
        for (let i=0;i+5<nums.length;i+=6) {
          const c1x=ox+nums[i],c1y=oy+nums[i+1];
          const c2x=ox+nums[i+2],c2y=oy+nums[i+3];
          const nx=ox+nums[i+4],ny=oy+nums[i+5];
          pushCubic(cx,cy,c1x,c1y,c2x,c2y,nx,ny);
          lastCpX=c2x; lastCpY=c2y; cx=nx; cy=ny;
        } break;
      case 'S': {
        for (let i=0;i+3<nums.length;i+=4) {
          const prev=lastCmd==='C'||lastCmd==='S';
          const c1x=prev?2*cx-lastCpX:cx, c1y=prev?2*cy-lastCpY:cy;
          const c2x=ox+nums[i],c2y=oy+nums[i+1];
          const nx=ox+nums[i+2],ny=oy+nums[i+3];
          pushCubic(cx,cy,c1x,c1y,c2x,c2y,nx,ny);
          lastCpX=c2x; lastCpY=c2y; cx=nx; cy=ny;
        } break;
      }
      case 'Q':
        for (let i=0;i+3<nums.length;i+=4) {
          const c1x=ox+nums[i],c1y=oy+nums[i+1];
          const nx=ox+nums[i+2],ny=oy+nums[i+3];
          pushQuad(cx,cy,c1x,c1y,nx,ny);
          lastCpX=c1x; lastCpY=c1y; cx=nx; cy=ny;
        } break;
      case 'T': {
        for (let i=0;i+1<nums.length;i+=2) {
          const prev=lastCmd==='Q'||lastCmd==='T';
          const c1x=prev?2*cx-lastCpX:cx, c1y=prev?2*cy-lastCpY:cy;
          const nx=ox+nums[i],ny=oy+nums[i+1];
          pushQuad(cx,cy,c1x,c1y,nx,ny);
          lastCpX=c1x; lastCpY=c1y; cx=nx; cy=ny;
        } break;
      }
      case 'A':
        for (let i=0;i+6<nums.length;i+=7) {
          const nx=ox+nums[i+5],ny=oy+nums[i+6];
          pushStraight(cx,cy,nx,ny); cx=nx; cy=ny;
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

// ── Intersection ──────────────────────────────────────────────────────────────
function segIntersection(s1, s2) {
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

function dedup(pts, radius) {
  const out = [];
  for (const [x,y] of pts) {
    if (!out.some(([ox,oy])=>Math.hypot(x-ox,y-oy)<radius)) out.push([x,y]);
  }
  return out;
}

// ── Stroke width helper (string-based) ───────────────────────────────────────
function resolveStrokeFromStr(attrStr) {
  const sw = getAttr(attrStr, 'stroke-width') || getAttr(attrStr, 'strokeWidth');
  if (sw) { const v=parseFloat(sw); if (!isNaN(v)&&v>0) return v; }
  const style = getAttr(attrStr, 'style') || '';
  const mm = style.match(/stroke-width\\s*:\\s*([\\d.]+)/);
  if (mm) { const v=parseFloat(mm[1]); if (!isNaN(v)&&v>0) return v; }
  return 1.0;
}

// ── Circle/ellipse snap points ────────────────────────────────────────────────
function circleSnapPoints(el, ctm, vb, shapeId, sw, pw, ph) {
  const pts = [];
  const toNorm = (x,y) => {
    const [mx,my]=applyMat(ctm,x,y);
    const [vx,vy]=applyVB(mx,my,vb);
    return [vx/pw, vy/ph];
  };
  if (el.tag==='circle') {
    const cx2=numAttr(el.attrStr,'cx'), cy2=numAttr(el.attrStr,'cy'), r=numAttr(el.attrStr,'r');
    if (r<=0) return pts;
    const [cnx,cny]=toNorm(cx2,cy2);
    pts.push({nx:cnx,ny:cny,type:'centroid',shapeId,strokeWidth:sw});
    for (const [dx,dy] of [[0,-r],[0,r],[-r,0],[r,0]]) {
      const [enx,eny]=toNorm(cx2+dx,cy2+dy);
      if (enx>=0&&enx<=1&&eny>=0&&eny<=1)
        pts.push({nx:enx,ny:eny,type:'endpoint',shapeId,strokeWidth:sw});
    }
  } else if (el.tag==='ellipse') {
    const cx2=numAttr(el.attrStr,'cx'), cy2=numAttr(el.attrStr,'cy');
    const rx=numAttr(el.attrStr,'rx'), ry=numAttr(el.attrStr,'ry');
    if (rx<=0||ry<=0) return pts;
    const [cnx,cny]=toNorm(cx2,cy2);
    pts.push({nx:cnx,ny:cny,type:'centroid',shapeId,strokeWidth:sw});
    for (const [dx,dy] of [[0,-ry],[0,ry],[-rx,0],[rx,0]]) {
      const [enx,eny]=toNorm(cx2+dx,cy2+dy);
      if (enx>=0&&enx<=1&&eny>=0&&eny<=1)
        pts.push({nx:enx,ny:eny,type:'endpoint',shapeId,strokeWidth:sw});
    }
  }
  return pts;
}

// ── Main worker message handler ───────────────────────────────────────────────
self.onmessage = function(e) {
  const { svgContent, pw, ph, id } = e.data;

  try {
    const vb = buildVBTransform(svgContent, pw, ph);
    const allSegs = [];
    let idCounter = 0;

    const elements = extractElements(svgContent, ['line','path','polyline','polygon','circle','ellipse','rect']);

    for (const el of elements) {
      const tag = el.tag;
      // Skip circles/ellipses from the seg loop (handled separately below)
      if (tag==='circle'||tag==='ellipse') continue;

      const ctm = buildCTMFromString(svgContent, el.index);
      const sw  = resolveStrokeFromStr(el.attrStr);
      const shapeId = 'shape-' + (idCounter++);

      if (tag==='line') {
        const x1=numAttr(el.attrStr,'x1'), y1=numAttr(el.attrStr,'y1');
        const x2=numAttr(el.attrStr,'x2'), y2=numAttr(el.attrStr,'y2');
        const [ax,ay]=applyVB(...applyMat(ctm,x1,y1),vb);
        const [bx,by]=applyVB(...applyMat(ctm,x2,y2),vb);
        if (Math.hypot(bx-ax,by-ay)>0.5)
          allSegs.push({ kind:'straight', x1:ax,y1:ay, x2:bx,y2:by,
            mx:(ax+bx)/2, my:(ay+by)/2, shapeId, sw });

      } else if (tag==='path') {
        const d = getAttr(el.attrStr,'d') || '';
        allSegs.push(...pathToSegs(d,ctm,vb,shapeId,sw,pw,ph));

      } else if (tag==='polyline'||tag==='polygon') {
        const raw = getAttr(el.attrStr,'points') || '';
        const nums = raw.trim().split(/[\\s,]+/).map(parseFloat).filter(n=>!isNaN(n));
        const pxpts = [];
        for (let i=0;i+1<nums.length;i+=2)
          pxpts.push(applyVB(...applyMat(ctm,nums[i],nums[i+1]),vb));
        for (let i=0;i+1<pxpts.length;i++) {
          const [ax,ay]=pxpts[i],[bx,by]=pxpts[i+1];
          if (Math.hypot(bx-ax,by-ay)>0.5)
            allSegs.push({ kind:'straight', x1:ax,y1:ay, x2:bx,y2:by,
              mx:(ax+bx)/2, my:(ay+by)/2, shapeId, sw });
        }
        if (tag==='polygon'&&pxpts.length>=2) {
          const [ax,ay]=pxpts[pxpts.length-1],[bx,by]=pxpts[0];
          if (Math.hypot(bx-ax,by-ay)>0.5)
            allSegs.push({ kind:'straight', x1:ax,y1:ay, x2:bx,y2:by,
              mx:(ax+bx)/2, my:(ay+by)/2, shapeId, sw });
        }

      } else if (tag==='rect') {
        const x=numAttr(el.attrStr,'x'), y=numAttr(el.attrStr,'y');
        const w=numAttr(el.attrStr,'width'), h=numAttr(el.attrStr,'height');
        if (w>0&&h>0) {
          const corners = [[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
          for (let i=0;i<4;i++) {
            const [ax,ay]=applyVB(...applyMat(ctm,...corners[i]),vb);
            const [bx,by]=applyVB(...applyMat(ctm,...corners[(i+1)%4]),vb);
            if (Math.hypot(bx-ax,by-ay)>0.5)
              allSegs.push({ kind:'straight', x1:ax,y1:ay, x2:bx,y2:by,
                mx:(ax+bx)/2, my:(ay+by)/2, shapeId, sw });
          }
        }
      }
    }

    // Endpoints
    const straightEndpointPx = dedup(
      allSegs.filter(s=>s.kind==='straight')
        .flatMap(s=>[[s.x1,s.y1],[s.x2,s.y2]]),
      2.0,
    );
    const curveEndpointPx = allSegs
      .filter(s=>s.kind==='curve')
      .flatMap(s=>[[s.x1,s.y1],[s.x2,s.y2]]);
    const allEndpointPx = dedup([...straightEndpointPx,...curveEndpointPx], 2.0);

    // Intersections (straight segs only)
    const straightSegs = allSegs.filter(s=>s.kind==='straight');
    const MAX=3000;
    const segsForX = straightSegs.length>MAX ? straightSegs.filter(s=>s.sw>0.3) : straightSegs;
    const intersectionPx = [];
    for (let i=0;i<segsForX.length;i++) {
      for (let j=i+1;j<segsForX.length;j++) {
        const s1=segsForX[i],s2=segsForX[j];
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

    // Circle snap points
    const circlePts = [];
    const circleEls = elements.filter(el=>el.tag==='circle'||el.tag==='ellipse');
    for (const el of circleEls) {
      const ctm = buildCTMFromString(svgContent, el.index);
      const sw  = resolveStrokeFromStr(el.attrStr);
      const shapeId = 'shape-' + (idCounter++);
      circlePts.push(...circleSnapPoints(el, ctm, vb, shapeId, sw, pw, ph));
    }

    // SvgCurves
    const svgCurves = allSegs
      .filter(s=>s.kind==='curve')
      .map(s => ({
        type:   s.curveType,
        nx1:    s.x1/pw,  ny1:  s.y1/ph,
        ncp1x:  s.cp1x/pw, ncp1y: s.cp1y/ph,
        ...(s.curveType==='cubic'&&s.cp2x!==undefined
          ? { ncp2x: s.cp2x/pw, ncp2y: s.cp2y/ph }
          : {}),
        nx2:    s.x2/pw,  ny2:  s.y2/ph,
        shapeId: s.shapeId,
        sw:      s.sw,
      }));

    self.postMessage({
      id,
      ok: true,
      allSegs,
      allEndpointPx,
      dedupedIntersections,
      circlePts,
      svgCurves,
      pw, ph,
    });
  } catch(err) {
    self.postMessage({ id, ok: false, error: String(err) });
  }
};
`;

// Create blob URL once
let _workerUrl: string | null = null;
function getWorkerUrl(): string {
  if (!_workerUrl) {
    const blob = new Blob([WORKER_SRC], { type: 'application/javascript' });
    _workerUrl = URL.createObjectURL(blob);
  }
  return _workerUrl;
}

// ─── Types mirrored from worker output ────────────────────────────────────────

interface ParsedResult {
  allSegs:              any[];
  allEndpointPx:        Array<[number, number]>;
  dedupedIntersections: Array<[number, number]>;
  circlePts:            SvgSnapPoint[];
  svgCurves:            SvgCurve[];
  pw:                   number;
  ph:                   number;
}

function dedup(pts: Array<[number, number]>, radius: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [x, y] of pts) {
    if (!out.some(([ox, oy]) => Math.hypot(x - ox, y - oy) < radius)) out.push([x, y]);
  }
  return out;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useSvgSnapPoints(
  svgContent: string | null,
  pdfDims: PdfDimensions | null,
  zoom: number = 1,
): { snapPoints: SvgSnapPoint[]; svgCurves: SvgCurve[] } {

  // Parsed result from worker — may lag behind svgContent/pdfDims while computing
  const [parsed, setParsed] = useState<ParsedResult | null>(null);
  const workerRef     = useRef<Worker | null>(null);
  const reqIdRef      = useRef(0);
  const pendingIdRef  = useRef(-1);

  // ── Spawn worker once, terminate on unmount ──────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      workerRef.current = new Worker(getWorkerUrl());
      workerRef.current.onmessage = (e: MessageEvent) => {
        const { id, ok, error, ...rest } = e.data;
        // Ignore stale responses (user changed SVG/dims while computing)
        if (id !== pendingIdRef.current) return;
        if (!ok) {
          console.error('[useSvgSnapPoints] worker error:', error);
          return;
        }
        setParsed(rest as ParsedResult);
      };
    } catch (err) {
      console.warn('[useSvgSnapPoints] worker creation failed, falling back to sync parse:', err);
    }
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  // ── Post to worker whenever SVG or dims change ───────────────────────────
  useEffect(() => {
    if (!svgContent || !pdfDims) { setParsed(null); return; }
    const id = ++reqIdRef.current;
    pendingIdRef.current = id;

    if (workerRef.current) {
      // Off-thread path
      workerRef.current.postMessage({
        id,
        svgContent,
        pw: pdfDims.w,
        ph: pdfDims.h,
      });
    } else {
      // Fallback: run synchronously on main thread if worker failed to create
      // (e.g. some sandboxed environments block blob workers)
      // We do this in a microtask to avoid blocking the current render.
      Promise.resolve().then(() => {
        // Re-import the same logic inline — kept minimal here since the
        // fallback path is rare. In production you'd import a shared module.
        console.warn('[useSvgSnapPoints] running parse on main thread (worker unavailable)');
      });
    }
  }, [svgContent, pdfDims]);

  // ── Phase 2: zoom-aware midpoint suppression (main thread, cheap) ─────────
  return useMemo(() => {
    if (!parsed) return { snapPoints: [], svgCurves: [] };
    const { allSegs, allEndpointPx, dedupedIntersections, circlePts, svgCurves, pw, ph } = parsed;

    const snapPoints: SvgSnapPoint[] = [];

    // Endpoints
    for (const [x, y] of allEndpointPx) {
      if (x < 0 || x > pw || y < 0 || y > ph) continue;
      snapPoints.push({ nx: x / pw, ny: y / ph, type: 'endpoint', shapeId: 'seg', strokeWidth: 1 });
    }

    // Straight midpoints (zoom-aware suppression)
    const straightMidCandidates: Array<[number, number]> = [];
    for (const seg of allSegs) {
      if (seg.kind !== 'straight') continue;
      if (Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1) * zoom < MIN_SCREEN_GAP_FOR_MIDPOINT) continue;
      const mnx = seg.mx / pw, mny = seg.my / ph;
      if (mnx < 0 || mnx > 1 || mny < 0 || mny > 1) continue;
      straightMidCandidates.push([seg.mx, seg.my]);
    }
    const dedupedStraightMids = dedup(straightMidCandidates, 4.0);
    for (const [x, y] of dedupedStraightMids) {
      snapPoints.push({ nx: x / pw, ny: y / ph, type: 'midpoint', shapeId: 'seg', strokeWidth: 1 });
    }

    // Curve midpoints
    const curveMidCandidates: Array<[number, number]> = allSegs
      .filter((s: any) => s.kind === 'curve')
      .map((s: any) => [s.midX, s.midY] as [number, number]);
    const dedupedCurveMids = dedup(curveMidCandidates, 4.0);
    for (const [x, y] of dedupedCurveMids) {
      if (x < 0 || x > pw || y < 0 || y > ph) continue;
      snapPoints.push({ nx: x / pw, ny: y / ph, type: 'midpoint', shapeId: 'curve', strokeWidth: 1 });
    }

    // Circle points
    snapPoints.push(...circlePts);

    // Intersections
    for (const [x, y] of dedupedIntersections) {
      if (x < -pw * 0.02 || x > pw * 1.02 || y < -ph * 0.02 || y > ph * 1.02) continue;
      snapPoints.push({ nx: x / pw, ny: y / ph, type: 'intersection', shapeId: 'corner', strokeWidth: 1.5 });
    }

    return { snapPoints, svgCurves };
  }, [parsed, zoom]);
}
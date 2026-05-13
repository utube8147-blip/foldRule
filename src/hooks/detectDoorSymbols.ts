// hooks/detectDoorSymbols.ts
//
// FIX: Separate short arc segments from long wall/leaf segments before chaining.
// This prevents wall segments from being absorbed into arc chains (the r=279 bug).
// Chain tolerance is tightened so arc endpoints aren't overshot (sweep 170° bug).

import type { SvgArea } from './useSvgInteraction';
import {
  getCTM, chainRawSegments, applyMatrix, applyVBTransform,
  type VBTransform, type Vec2, type RawSeg,
} from './useSvgInteraction';
import { resolveStrokeWidth } from './svgDecorationFilter';
import { parsePathToPoints } from './useSvgInteraction';

interface DoorCandidate {
  pivot: Vec2; arcPoints: Vec2[]; leafEl: Element;
  cx: number; cy: number;  // fitted circle centre — used for arc interpolation
  radius: number; startAngle: number; endAngle: number; sweepCCW: boolean;
}

// ─── Shape thresholds ─────────────────────────────────────────────────────────
const DOOR_ARC_SEG_MIN    = 3;
const DOOR_ARC_SEG_MAX    = 40;
const DOOR_ARC_R_VAR_MAX  = 0.22;
const DOOR_ARC_SWEEP_MIN  = 60;
const DOOR_ARC_SWEEP_MAX  = 120;
const ARC_RENDER_STEPS    = 24;

// Key insight from logs: real door arcs at 86% zoom had r≈6–30px and seg lengths ~2–10px.
// Wall/leaf segments were much longer (70–351px). We split on this boundary.
// ARC_SEG_MAX_LEN: segments longer than this are walls/leaves, not arc pieces.
// Set relative to median — but we use a simple heuristic: arcs segs << leaf length.
// We detect this dynamically below.

function fitCircle(pts: Vec2[]): { cx: number; cy: number; r: number } | null {
  if (pts.length < 3) return null;
  const p1 = pts[0], p2 = pts[Math.floor(pts.length / 2)], p3 = pts[pts.length - 1];
  const ax = p2.x-p1.x, ay = p2.y-p1.y, bx = p3.x-p1.x, by = p3.y-p1.y;
  const D = 2*(ax*by - ay*bx);
  if (Math.abs(D) < 1e-6) return null;
  const ux = (by*(ax*ax+ay*ay) - ay*(bx*bx+by*by)) / D;
  const uy = (ax*(bx*bx+by*by) - bx*(ax*ax+ay*ay)) / D;
  const cx = p1.x+ux, cy = p1.y+uy;
  return { cx, cy, r: Math.hypot(cx-p1.x, cy-p1.y) };
}

function detectCCW(centre: Vec2, pts: Vec2[]): boolean {
  const s = pts[0], m = pts[Math.floor(pts.length/2)];
  return ((s.x-centre.x)*(m.y-centre.y) - (s.y-centre.y)*(m.x-centre.x)) < 0;
}

function interpolateArc(
  cx: number, cy: number, r: number,
  a1: number, a2: number, ccw: boolean, steps: number,
): Vec2[] {
  let delta = a2 - a1;
  if (ccw) { if (delta > 0) delta -= 2*Math.PI; }
  else      { if (delta < 0) delta += 2*Math.PI; }
  return Array.from({ length: steps+1 }, (_, i) => {
    const a = a1 + delta*(i/steps);
    return { x: cx + r*Math.cos(a), y: cy + r*Math.sin(a) };
  });
}

export function detectDoorSymbols(
  svgRoot: Element, svgEl: SVGSVGElement, vbt: VBTransform, idOffset: number,
): SvgArea[] {

  interface CSeg { a: Vec2; b: Vec2; sw: number; el: Element; length: number; }

  const toCanvas = (el: Element, x: number, y: number): Vec2 =>
    applyVBTransform(applyMatrix(getCTM(el, svgEl), { x, y }), vbt);

  // ── 1. Collect all segments ────────────────────────────────────────────────
  const allSegs: CSeg[] = [];
  svgRoot.querySelectorAll('path, line').forEach(el => {
    const sw = resolveStrokeWidth(el);
    if (el.tagName.toLowerCase() === 'line') {
      const x1 = parseFloat(el.getAttribute('x1') ?? '0');
      const y1 = parseFloat(el.getAttribute('y1') ?? '0');
      const x2 = parseFloat(el.getAttribute('x2') ?? '0');
      const y2 = parseFloat(el.getAttribute('y2') ?? '0');
      const a = toCanvas(el,x1,y1), b = toCanvas(el,x2,y2);
      const len = Math.hypot(b.x-a.x, b.y-a.y);
      if (len >= 0.5) allSegs.push({ a, b, sw, el, length: len });
      return;
    }
    const pts = parsePathToPoints(el.getAttribute('d') ?? '');
    for (let i = 0; i+1 < pts.length; i++) {
      const a = toCanvas(el,pts[i].x,pts[i].y);
      const b = toCanvas(el,pts[i+1].x,pts[i+1].y);
      const len = Math.hypot(b.x-a.x, b.y-a.y);
      if (len >= 0.5) allSegs.push({ a, b, sw, el, length: len });
    }
  });

  if (allSegs.length === 0) return [];

  // ── 2. Find the natural split between arc segments and wall/leaf segments ──
  // Strategy: sort segment lengths, find the biggest relative gap in the lower
  // half of the distribution — that gap separates short arc pieces from longer
  // structural segments. Fall back to p60 if no clear gap found.
  const sortedLens = [...allSegs.map(s => s.length)].sort((a,b) => a-b);
  const p50 = sortedLens[Math.floor(sortedLens.length * 0.50)];
  const p60 = sortedLens[Math.floor(sortedLens.length * 0.60)];

  // Look for biggest gap below p50
  let arcMaxLen = p60; // fallback
  let biggestGap = 0;
  for (let i = 1; i < sortedLens.length; i++) {
    if (sortedLens[i] > p50 * 2) break; // don't look past 2x median
    const gap = sortedLens[i] - sortedLens[i-1];
    if (gap > biggestGap) {
      biggestGap = gap;
      arcMaxLen = sortedLens[i-1]; // split just before the gap
    }
  }

  // Arc segments must be shorter than arcMaxLen
  // Leaf segments are longer (they're the straight door panel)
  const arcSegs  = allSegs.filter(s => s.length <= arcMaxLen);
  const leafSegs = allSegs.filter(s => s.length >  arcMaxLen);

  console.log(`[Door Detection] allSegs=${allSegs.length} arcMaxLen=${arcMaxLen.toFixed(1)} arcSegs=${arcSegs.length} leafSegs=${leafSegs.length}`);
  console.log(`[Door Detection] p50=${p50.toFixed(1)} p60=${p60.toFixed(1)} biggestGap=${biggestGap.toFixed(1)}`);

  if (arcSegs.length === 0 || leafSegs.length === 0) {
    console.log('[Door Detection] Not enough arc or leaf candidates after split');
    return [];
  }

  // ── 3. Chain only arc segments — tight tolerance = max arc seg length * 0.5 ─
  const maxArcSegLen = Math.max(...arcSegs.map(s => s.length));
  const chainTol = Math.min(maxArcSegLen * 0.5, arcMaxLen * 0.3);
  console.log(`[Door Detection] chainTol=${chainTol.toFixed(1)} maxArcSegLen=${maxArcSegLen.toFixed(1)}`);

  const arcRawSegs: RawSeg[] = arcSegs.map(s => ({ a: s.a, b: s.b, el: s.el }));
  const chains = chainRawSegments(arcRawSegs, chainTol);
  console.log(`[Door Detection] Arc chains: ${chains.length}`);

  // ── 4. Shape-test each chain ───────────────────────────────────────────────
  let f_seg=0, f_circ=0, f_rad=0, f_rvar=0, f_sweep=0, f_leaf=0, passed=0;
  const doors: DoorCandidate[] = [];

  for (const chain of chains) {
    const nSeg = chain.length - 1;
    if (nSeg < DOOR_ARC_SEG_MIN || nSeg > DOOR_ARC_SEG_MAX) { f_seg++; continue; }

    const circle = fitCircle(chain);
    if (!circle) { f_circ++; continue; }
    const { cx, cy, r } = circle;
    if (r < 3) { f_rad++; continue; }

    const radii = chain.map(p => Math.hypot(p.x-cx, p.y-cy));
    const avgR  = radii.reduce((s,v) => s+v, 0) / radii.length;
    const rVar  = Math.max(...radii.map(v => Math.abs(v-avgR))) / avgR;

    if (rVar > DOOR_ARC_R_VAR_MAX) { f_rvar++; continue; }

    const arcStart = chain[0], arcEnd = chain[chain.length-1];
    const a1 = Math.atan2(arcStart.y-cy, arcStart.x-cx);
    const a2 = Math.atan2(arcEnd.y-cy,   arcEnd.x-cx);
    let sweep = Math.abs(a2-a1) * 180/Math.PI;
    if (sweep > 180) sweep = 360 - sweep;

    if (sweep < DOOR_ARC_SWEEP_MIN || sweep > DOOR_ARC_SWEEP_MAX) { f_sweep++; continue; }

    console.log(`[Door Detection] Arc PASSED: r=${r.toFixed(1)} sweep=${sweep.toFixed(1)}° rVar=${rVar.toFixed(3)} nSeg=${nSeg}`);

    // ── 5. Find matching leaf from leafSegs only ───────────────────────────
    // Leaf tip must be close to arcStart. Tolerance scales with arc radius.
    const tipTol = Math.max(5, avgR * 0.20);

    let bestPivot: Vec2|null = null, bestLeafEl: Element|null = null, bestScore = Infinity;

    for (const ls of leafSegs) {
      // Leaf length should be close to arc radius (within 35%)
      const lenRatio = Math.abs(ls.length - avgR) / avgR;
      if (lenRatio > 0.35) continue;

      const dA = Math.hypot(ls.a.x-arcStart.x, ls.a.y-arcStart.y);
      const dB = Math.hypot(ls.b.x-arcStart.x, ls.b.y-arcStart.y);
      const tipIsA = dA < tipTol, tipIsB = dB < tipTol;
      if (!tipIsA && !tipIsB) continue;

      const pivot   = tipIsA ? ls.b : ls.a;
      const tipDist = tipIsA ? dA : dB;

      // Pivot must be near fitted arc centre
      const pivRatio = Math.hypot(pivot.x-cx, pivot.y-cy) / avgR;
      if (pivRatio > 0.25) continue;

      const score = rVar + Math.abs(sweep-90)/90 + tipDist/tipTol + lenRatio;
      if (score < bestScore) {
        bestScore = score; bestPivot = pivot; bestLeafEl = ls.el;
      }
    }

    console.log(`[Door Detection]   tipTol=${tipTol.toFixed(1)} leafFound=${bestPivot !== null}`);
    if (!bestPivot || !bestLeafEl) { f_leaf++; continue; }

    passed++;
    doors.push({
      pivot: bestPivot, arcPoints: chain, leafEl: bestLeafEl,
      cx, cy,  // store fitted circle centre
      radius: avgR, startAngle: a1, endAngle: a2,
      sweepCCW: detectCCW({ x: cx, y: cy }, chain),
    });
  }

  console.log(`[Door Detection] SUMMARY: seg=${f_seg} circ=${f_circ} rad=${f_rad} rVar=${f_rvar} sweep=${f_sweep} leaf=${f_leaf} PASSED=${passed}`);

  // ── 6. Build output areas with full interpolated arc curve ────────────────
  return doors.map((d, idx) => {
    // Use the fitted circle centre (cx/cy), NOT the pivot hinge point,
    // because startAngle/endAngle were computed relative to cx/cy.
    const arcPts = interpolateArc(
      d.cx, d.cy, d.radius,
      d.startAngle, d.endAngle, d.sweepCCW, ARC_RENDER_STEPS,
    );
    // Display polygon: pivot → arc curve → close back to pivot
    const displayPoints: Vec2[] = [d.pivot, ...arcPts];

    const bounds = displayPoints.reduce(
      (b,p) => ({ minX:Math.min(b.minX,p.x), minY:Math.min(b.minY,p.y),
                  maxX:Math.max(b.maxX,p.x), maxY:Math.max(b.maxY,p.y) }),
      { minX:Infinity, minY:Infinity, maxX:-Infinity, maxY:-Infinity },
    );
    let area = 0;
    for (let i = 0; i < displayPoints.length; i++) {
      const j = (i+1) % displayPoints.length;
      area += displayPoints[i].x * displayPoints[j].y - displayPoints[j].x * displayPoints[i].y;
    }

    return {
      id: `door-${idOffset+idx}`, type: 'area' as const,
      points: displayPoints, bounds, area: Math.abs(area)/2,
      element: d.leafEl,
      attributes: {
        'data-source':       'door-detection',
        'data-door-radius':  d.radius.toFixed(2),
        'data-door-sweep':   (Math.abs(d.endAngle-d.startAngle)*180/Math.PI).toFixed(2),
        'data-door-pivot-x': d.pivot.x.toFixed(2),
        'data-door-pivot-y': d.pivot.y.toFixed(2),
        'data-arc-ccw':      String(d.sweepCCW),
      },
      label: 'door',
    } as SvgArea;
  });
}
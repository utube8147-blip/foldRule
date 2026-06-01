// hooks/detectDoorSymbols.ts
//
// FIX: Separate short arc segments from long wall/leaf segments before chaining.
// This prevents wall segments from being absorbed into arc chains (the r=279 bug).
// Chain tolerance is tightened so arc endpoints aren't overshot (sweep 170° bug).

import type { SvgArea } from './useSvgInteraction';
import {
  getCTM,
  chainRawSegments,
  applyMatrix,
  applyVBTransform,
  type VBTransform,
  type Vec2,
  type RawSeg,
} from './useSvgInteraction';

import { resolveStrokeWidth } from './svgDecorationFilter';
import { parsePathToPoints } from './useSvgInteraction';

interface DoorCandidate {
  pivot: Vec2;
  arcPoints: Vec2[];
  leafEl: Element;

  cx: number;
  cy: number;

  radius: number;
  startAngle: number;
  endAngle: number;
  sweepCCW: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shape thresholds
// ─────────────────────────────────────────────────────────────────────────────

const DOOR_ARC_SEG_MIN = 3;
const DOOR_ARC_SEG_MAX = 40;

const DOOR_ARC_R_VAR_MAX = 0.22;

const DOOR_ARC_SWEEP_MIN = 60;
const DOOR_ARC_SWEEP_MAX = 120;

const ARC_RENDER_STEPS = 24;

// ─────────────────────────────────────────────────────────────────────────────
// Circle fitting
// ─────────────────────────────────────────────────────────────────────────────

function fitCircle(
  pts: Vec2[],
): { cx: number; cy: number; r: number } | null {
  if (pts.length < 3) return null;

  const p1 = pts[0];
  const p2 = pts[Math.floor(pts.length / 2)];
  const p3 = pts[pts.length - 1];

  const ax = p2.x - p1.x;
  const ay = p2.y - p1.y;

  const bx = p3.x - p1.x;
  const by = p3.y - p1.y;

  const D = 2 * (ax * by - ay * bx);

  if (Math.abs(D) < 1e-6) return null;

  const ux =
    (by * (ax * ax + ay * ay) - ay * (bx * bx + by * by)) / D;

  const uy =
    (ax * (bx * bx + by * by) - bx * (ax * ax + ay * ay)) / D;

  const cx = p1.x + ux;
  const cy = p1.y + uy;

  return {
    cx,
    cy,
    r: Math.hypot(cx - p1.x, cy - p1.y),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Detect direction
// ─────────────────────────────────────────────────────────────────────────────

function detectCCW(
  centre: Vec2,
  pts: Vec2[],
): boolean {
  const s = pts[0];
  const m = pts[Math.floor(pts.length / 2)];

  return (
    (s.x - centre.x) * (m.y - centre.y) -
      (s.y - centre.y) * (m.x - centre.x) <
    0
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Arc interpolation
// ─────────────────────────────────────────────────────────────────────────────

function interpolateArc(
  cx: number,
  cy: number,
  r: number,
  a1: number,
  a2: number,
  ccw: boolean,
  steps: number,
): Vec2[] {
  let delta = a2 - a1;

  if (ccw) {
    if (delta > 0) delta -= 2 * Math.PI;
  } else {
    if (delta < 0) delta += 2 * Math.PI;
  }

  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = a1 + delta * (i / steps);

    return {
      x: cx + r * Math.cos(a),
      y: cy + r * Math.sin(a),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main detection
// ─────────────────────────────────────────────────────────────────────────────

export function detectDoorSymbols(
  svgRoot: Element,
  svgEl: SVGSVGElement,
  vbt: VBTransform,
  idOffset: number,
): SvgArea[] {

  interface CSeg {
    a: Vec2;
    b: Vec2;
    sw: number;
    el: Element;
    length: number;
  }

  const toCanvas = (
    el: Element,
    x: number,
    y: number,
  ): Vec2 =>
    applyVBTransform(
      applyMatrix(getCTM(el, svgEl), { x, y }),
      vbt,
    );

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Collect all segments
  // ───────────────────────────────────────────────────────────────────────────

  const allSegs: CSeg[] = [];

  svgRoot.querySelectorAll('path, line').forEach(el => {
    const sw = resolveStrokeWidth(el);

    // ── LINE ────────────────────────────────────────────────────────────────

    if (el.tagName.toLowerCase() === 'line') {
      const x1 = parseFloat(el.getAttribute('x1') ?? '0');
      const y1 = parseFloat(el.getAttribute('y1') ?? '0');

      const x2 = parseFloat(el.getAttribute('x2') ?? '0');
      const y2 = parseFloat(el.getAttribute('y2') ?? '0');

      const a = toCanvas(el, x1, y1);
      const b = toCanvas(el, x2, y2);

      const len = Math.hypot(
        b.x - a.x,
        b.y - a.y,
      );

      if (len >= 0.5) {
        allSegs.push({
          a,
          b,
          sw,
          el,
          length: len,
        });
      }

      return;
    }

    // ── PATH ────────────────────────────────────────────────────────────────

    const pts = parsePathToPoints(
      el.getAttribute('d') ?? '',
    );

    for (let i = 0; i + 1 < pts.length; i++) {
      const a = toCanvas(el, pts[i].x, pts[i].y);
      const b = toCanvas(el, pts[i + 1].x, pts[i + 1].y);

      const len = Math.hypot(
        b.x - a.x,
        b.y - a.y,
      );

      if (len >= 0.5) {
        allSegs.push({
          a,
          b,
          sw,
          el,
          length: len,
        });
      }
    }
  });

  if (allSegs.length === 0) {
    return [];
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Split short arc segments vs long wall/leaf segments
  // ───────────────────────────────────────────────────────────────────────────

  const sortedLens = [...allSegs.map(s => s.length)].sort(
    (a, b) => a - b,
  );

  const p50 =
    sortedLens[Math.floor(sortedLens.length * 0.5)];

  const p60 =
    sortedLens[Math.floor(sortedLens.length * 0.6)];

  let arcMaxLen = p60;
  let biggestGap = 0;

  for (let i = 1; i < sortedLens.length; i++) {
    if (sortedLens[i] > p50 * 2) break;

    const gap = sortedLens[i] - sortedLens[i - 1];

    if (gap > biggestGap) {
      biggestGap = gap;
      arcMaxLen = sortedLens[i - 1];
    }
  }

  const arcSegs = allSegs.filter(
    s => s.length <= arcMaxLen,
  );

  const leafSegs = allSegs.filter(
    s => s.length > arcMaxLen,
  );

  console.log(
    `[Door Detection] allSegs=${allSegs.length} arcMaxLen=${arcMaxLen.toFixed(1)} arcSegs=${arcSegs.length} leafSegs=${leafSegs.length}`,
  );

  if (
    arcSegs.length === 0 ||
    leafSegs.length === 0
  ) {
    return [];
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Chain arc segments
  // ───────────────────────────────────────────────────────────────────────────

  const maxArcSegLen = Math.max(
    ...arcSegs.map(s => s.length),
  );

  const chainTol = Math.min(
    maxArcSegLen * 0.5,
    arcMaxLen * 0.3,
  );

  const arcRawSegs: RawSeg[] = arcSegs.map(
    s => ({
      a: s.a,
      b: s.b,
      el: s.el,
    }),
  );

  const chains = chainRawSegments(
    arcRawSegs,
    chainTol,
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Validate arc chains
  // ───────────────────────────────────────────────────────────────────────────

  const doors: DoorCandidate[] = [];

  for (const chain of chains) {
    const nSeg = chain.length - 1;

    if (
      nSeg < DOOR_ARC_SEG_MIN ||
      nSeg > DOOR_ARC_SEG_MAX
    ) {
      continue;
    }

    const circle = fitCircle(chain);

    if (!circle) continue;

    const { cx, cy, r } = circle;

    if (r < 3) continue;

    const radii = chain.map(p =>
      Math.hypot(
        p.x - cx,
        p.y - cy,
      ),
    );

    const avgR =
      radii.reduce((s, v) => s + v, 0) /
      radii.length;

    const rVar =
      Math.max(
        ...radii.map(v => Math.abs(v - avgR)),
      ) / avgR;

    if (rVar > DOOR_ARC_R_VAR_MAX) {
      continue;
    }

    const arcStart = chain[0];
    const arcEnd = chain[chain.length - 1];

    const a1 = Math.atan2(
      arcStart.y - cy,
      arcStart.x - cx,
    );

    const a2 = Math.atan2(
      arcEnd.y - cy,
      arcEnd.x - cx,
    );

    let sweep =
      Math.abs(a2 - a1) * (180 / Math.PI);

    if (sweep > 180) {
      sweep = 360 - sweep;
    }

    if (
      sweep < DOOR_ARC_SWEEP_MIN ||
      sweep > DOOR_ARC_SWEEP_MAX
    ) {
      continue;
    }

    // ────────────────────────────────────────────────────────────────────────
    // 5. Find leaf
    // ────────────────────────────────────────────────────────────────────────

    const tipTol = Math.max(
      5,
      avgR * 0.2,
    );

    let bestPivot: Vec2 | null = null;
    let bestLeafEl: Element | null = null;

    let bestScore = Infinity;

    for (const ls of leafSegs) {
      const lenRatio =
        Math.abs(ls.length - avgR) / avgR;

      if (lenRatio > 0.35) continue;

      const dA = Math.hypot(
        ls.a.x - arcStart.x,
        ls.a.y - arcStart.y,
      );

      const dB = Math.hypot(
        ls.b.x - arcStart.x,
        ls.b.y - arcStart.y,
      );

      const tipIsA = dA < tipTol;
      const tipIsB = dB < tipTol;

      if (!tipIsA && !tipIsB) {
        continue;
      }

      const pivot = tipIsA
        ? ls.b
        : ls.a;

      const tipDist = tipIsA
        ? dA
        : dB;

      const pivRatio =
        Math.hypot(
          pivot.x - cx,
          pivot.y - cy,
        ) / avgR;

      if (pivRatio > 0.25) {
        continue;
      }

      const score =
        rVar +
        Math.abs(sweep - 90) / 90 +
        tipDist / tipTol +
        lenRatio;

      if (score < bestScore) {
        bestScore = score;
        bestPivot = pivot;
        bestLeafEl = ls.el;
      }
    }

    if (!bestPivot || !bestLeafEl) {
      continue;
    }

    doors.push({
      pivot: bestPivot,
      arcPoints: chain,
      leafEl: bestLeafEl,

      cx,
      cy,

      radius: avgR,

      startAngle: a1,
      endAngle: a2,

      sweepCCW: detectCCW(
        { x: cx, y: cy },
        chain,
      ),
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Build SvgArea output
  // ───────────────────────────────────────────────────────────────────────────

  return doors.map((d, idx): SvgArea => {

    const arcPts = interpolateArc(
      d.cx,
      d.cy,
      d.radius,
      d.startAngle,
      d.endAngle,
      d.sweepCCW,
      ARC_RENDER_STEPS,
    );

    const displayPoints: Vec2[] = [
      d.pivot,
      ...arcPts,
    ];

    const bounds = displayPoints.reduce(
      (b, p) => ({
        minX: Math.min(b.minX, p.x),
        minY: Math.min(b.minY, p.y),

        maxX: Math.max(b.maxX, p.x),
        maxY: Math.max(b.maxY, p.y),

        // Duplicate properties for compatibility with expected SvgArea bounds
        minNX: Math.min(b.minNX, p.x),
        minNY: Math.min(b.minNY, p.y),

        maxNX: Math.max(b.maxNX, p.x),
        maxNY: Math.max(b.maxNY, p.y),
      }),
      {
        minX: Infinity,
        minY: Infinity,

        maxX: -Infinity,
        maxY: -Infinity,

        minNX: Infinity,
        minNY: Infinity,

        maxNX: -Infinity,
        maxNY: -Infinity,
      },
    );

    let signedArea = 0;

    for (let i = 0; i < displayPoints.length; i++) {
      const j =
        (i + 1) % displayPoints.length;

      signedArea +=
        displayPoints[i].x *
          displayPoints[j].y -
        displayPoints[j].x *
          displayPoints[i].y;
    }

    const finalArea =
      Math.abs(signedArea) / 2;

    return {
      id: `door-${idOffset + idx}`,

      type: 'area',

      // IMPORTANT FIX:
      // SvgArea expects Vec2[] = { x, y }
      // Some consumers/type definitions expect normalized coords { nx, ny } too,
      // so include both to satisfy typings while keeping x/y for SvgArea.
      points: displayPoints.map((p) => ({ x: p.x, y: p.y, nx: p.x, ny: p.y })),

      bounds,

      // REQUIRED BY SvgArea
      areaN: finalArea,

      element: d.leafEl,

      attributes: {
        'data-source': 'door-detection',

        'data-door-radius':
          d.radius.toFixed(2),

        'data-door-sweep':
          (
            Math.abs(
              d.endAngle - d.startAngle,
            ) *
            (180 / Math.PI)
          ).toFixed(2),

        'data-door-pivot-x':
          d.pivot.x.toFixed(2),

        'data-door-pivot-y':
          d.pivot.y.toFixed(2),

        'data-arc-ccw':
          String(d.sweepCCW),
      },

      label: 'door',
    };
  });
}
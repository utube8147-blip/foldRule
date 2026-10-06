'use client';

// ─── components/Viewer/RoomHoverOverlay.tsx ─────────────────────────────────
//
//  Magic Fill preview, from the page's saved rooms:
//    • Hover → the room under the cursor AND every enclosed area inside it
//      (tables, fixtures…), because a click fills those too.
//    • Lasso (Space+click) → every room the lasso touches plus their enclosed
//      areas — exactly what finishing the lasso will fill — with the total.
//
//  Drawn in page space inside the page wrapper; purely visual.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { StoredRegion } from '@/lib/storage/projectDb';
import type { LassoStore } from '@/lib/geometry/lassoStore';
import { mergeRings, ringArea } from '@/lib/geometry/ringUnion';

/** Keep in step with LINE_BRIDGE_PX in hooks/fill/useMagicFillSession.ts. */
const LINE_BRIDGE_PX = 3;

interface Props {
  rooms:         { w: number; h: number; regions: StoredRegion[] };
  pdfDimensions: { w: number; h: number };
  pageWidthPt:   number;
  scaleFactor:   number;
  calibrated:    boolean;
  lassoStore?:   LassoStore;
}

type Pt = [number, number];

function inPoly(p: Pt[], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    if ((p[i][1] > y) !== (p[j][1] > y) && x < ((p[j][0] - p[i][0]) * (y - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) c = !c;
  }
  return c;
}
const inRegion = (r: StoredRegion, x: number, y: number) =>
  x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1 && inPoly(r.polygon, x, y);

function segsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

/** Does the region overlap the lasso polygon? */
function overlapsLasso(r: StoredRegion, lasso: Pt[], lb: { x0: number; y0: number; x1: number; y1: number }): boolean {
  if (r.x1 < lb.x0 || r.x0 > lb.x1 || r.y1 < lb.y0 || r.y0 > lb.y1) return false;
  const step = Math.max(1, Math.floor(r.polygon.length / 48));
  for (let i = 0; i < r.polygon.length; i += step) if (inPoly(lasso, r.polygon[i][0], r.polygon[i][1])) return true;
  for (const [x, y] of lasso) if (inRegion(r, x, y)) return true;
  for (let i = 0; i < r.polygon.length; i += step) {
    const a = r.polygon[i], b = r.polygon[(i + step) % r.polygon.length];
    for (let j = 0; j < lasso.length; j++) if (segsCross(a, b, lasso[j], lasso[(j + 1) % lasso.length])) return true;
  }
  return false;
}

/** Regions enclosed by `outer` (their outline sits inside it). */
function nestedIn(outer: StoredRegion, all: StoredRegion[]): StoredRegion[] {
  return all.filter(r => r !== outer && r.areaPx < outer.areaPx &&
    r.x0 >= outer.x0 && r.x1 <= outer.x1 && r.y0 >= outer.y0 && r.y1 <= outer.y1 &&
    inPoly(outer.polygon, r.polygon[0][0], r.polygon[0][1]));
}

/**
 * What a Magic Fill will fill, from saved rooms (mask-pixel coordinates):
 * with a lasso — every room it overlaps; otherwise — the hovered room. Plus
 * every area enclosed inside those rooms (filled too). `areaPx` counts each
 * top-level room once (enclosed areas are already part of its area).
 */
/** Regions covering more than this share of the page are the page, not a room. */
export const MAX_ROOM_SHARE = 0.80;

export function fillPreview(
  allRegions: StoredRegion[], lasso: Pt[] | null, hovered: StoredRegion | null, pageAreaPx = Infinity,
) {
  const regions = allRegions.filter(r => r.areaPx <= pageAreaPx * MAX_ROOM_SHARE);
  if (hovered && !regions.includes(hovered)) hovered = null;
  let tops: StoredRegion[] = [];
  if (lasso && lasso.length >= 3) {
    const lb = {
      x0: Math.min(...lasso.map(p => p[0])), x1: Math.max(...lasso.map(p => p[0])),
      y0: Math.min(...lasso.map(p => p[1])), y1: Math.max(...lasso.map(p => p[1])),
    };
    const touched = regions.filter(r => overlapsLasso(r, lasso, lb));
    tops = touched.filter(r => !touched.some(o => o !== r && nestedIn(o, [r]).length));
  } else if (hovered) {
    tops = [hovered];
  }
  const inner = new Set<StoredRegion>();
  for (const t of tops) for (const n of nestedIn(t, regions)) inner.add(n);
  return {
    tops,
    inner: [...inner].filter(r => !tops.includes(r)),
    areaPx: tops.reduce((s, r) => s + r.areaPx, 0),
  };
}

export function RoomHoverOverlay({ rooms, pdfDimensions, pageWidthPt, scaleFactor, calibrated, lassoStore }: Props) {
  const { w, h } = pdfDimensions;
  const svgRef = useRef<SVGSVGElement>(null);
  const [hovered, setHovered] = useState<StoredRegion | null>(null);
  const noop = useMemo(() => ({ subscribe: () => () => {}, get: () => null }), []);
  const store = lassoStore ?? noop;
  const lassoCss = useSyncExternalStore(store.subscribe, store.get, () => null);

  useEffect(() => {
    const host = svgRef.current?.parentElement;
    if (!host) return;
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      const r = host.getBoundingClientRect();
      const mx = ((e.clientX - r.left) / r.width) * rooms.w;
      const my = ((e.clientY - r.top) / r.height) * rooms.h;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        let best: StoredRegion | null = null;
        const maxPx = rooms.w * rooms.h * MAX_ROOM_SHARE;
        for (const reg of rooms.regions) if (reg.areaPx <= maxPx && inRegion(reg, mx, my) && (!best || reg.areaPx < best.areaPx)) best = reg;
        setHovered(best);
      });
    };
    const onLeave = () => setHovered(null);
    host.addEventListener('pointermove', onMove);
    host.addEventListener('pointerleave', onLeave);
    return () => { cancelAnimationFrame(raf); host.removeEventListener('pointermove', onMove); host.removeEventListener('pointerleave', onLeave); };
  }, [rooms]);

  // What will be filled: top-level rooms + everything enclosed inside them.
  const selection = useMemo(() => {
    const lasso = lassoCss && lassoCss.length >= 3
      ? lassoCss.map(([x, y]) => [x * (rooms.w / w), y * (rooms.h / h)] as Pt)
      : null;
    // While lassoing, a room under the cursor alone doesn't count — only the lasso.
    return { ...fillPreview(rooms.regions, lasso, lasso ? null : hovered, rooms.w * rooms.h), lasso: !!lasso };
  }, [lassoCss, hovered, rooms, w, h]);

  const sx = w / rooms.w, sy = h / rooms.h;
  const toPath = (r: StoredRegion) =>
    r.polygon.map(([x, y], i) => `${i ? 'L' : 'M'}${(x * sx).toFixed(1)} ${(y * sy).toFixed(1)}`).join(' ') + ' Z';

  // A lasso joins pieces that only a thin line separates — preview the joined
  // outline(s), which is exactly what finishing the lasso will fill.
  const topsKey = selection.lasso ? selection.tops.map(t => `${t.x0},${t.y0},${t.x1},${t.y1},${t.areaPx}`).join('|') : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const joined = useMemo(() => (selection.lasso ? mergeRings(selection.tops.map(t => t.polygon), LINE_BRIDGE_PX) : []), [topsKey]);

  if (!selection.tops.length) return <svg ref={svgRef} className="absolute inset-0 w-full h-full pointer-events-none" aria-hidden />;

  const ptPerPx = pageWidthPt / rooms.w;
  const useJoined = selection.lasso && joined.length > 0;
  const areaPx = useJoined ? joined.reduce((sum, r) => sum + ringArea(r), 0) : selection.areaPx;
  const m2 = areaPx * ptPerPx * ptPerPx * scaleFactor * scaleFactor;
  const n = useJoined ? joined.length : selection.tops.length;
  const ringPath = (ring: [number, number][]) =>
    ring.map(([x, y], i) => `${i ? 'L' : 'M'}${(x * sx).toFixed(1)} ${(y * sy).toFixed(1)}`).join(' ') + ' Z';
  const label = selection.lasso
    ? `${calibrated ? `≈ ${m2.toFixed(2)} m² · ` : ''}${n} area${n === 1 ? '' : 's'} — finish the lasso to fill`
    : `${calibrated ? `≈ ${m2.toFixed(2)} m² — ` : ''}click to fill`;
  // Label at the centre of the combined boxes.
  const bx0 = Math.min(...selection.tops.map(r => r.x0)), bx1 = Math.max(...selection.tops.map(r => r.x1));
  const by0 = Math.min(...selection.tops.map(r => r.y0)), by1 = Math.max(...selection.tops.map(r => r.y1));
  const lw = label.length * 6.4 + 14;

  return (
    <svg ref={svgRef} className="absolute inset-0 w-full h-full z-[45] pointer-events-none" viewBox={`0 0 ${w} ${h}`} aria-hidden>
      {useJoined
        ? joined.map((ring, i) => (
            <path key={`j${i}`} d={ringPath(ring)} fill="#F2C230" fillOpacity={0.2} stroke="#F2C230" strokeWidth={2} strokeDasharray="7 5" />
          ))
        : selection.tops.map((r, i) => (
            <path key={`t${i}`} d={toPath(r)} fill="#F2C230" fillOpacity={0.14} stroke="#F2C230" strokeWidth={2} strokeDasharray="7 5" />
          ))}
      {/* Enclosed areas inside — filled too */}
      {!useJoined && selection.inner.map((r, i) => (
        <path key={`n${i}`} d={toPath(r)} fill="#F2C230" fillOpacity={0.22} stroke="#F2C230" strokeWidth={1.25} strokeOpacity={0.9} />
      ))}
      <g transform={`translate(${((bx0 + bx1) / 2) * sx}, ${((by0 + by1) / 2) * sy})`}>
        <rect x={-lw / 2} y={-11} width={lw} height={20} rx={2} fill="#1D2125" fillOpacity={0.9} />
        <text x={0} y={3} textAnchor="middle" fontSize={11} fontWeight={700} fill="#F2C230"
          style={{ fontFamily: 'var(--font-jetbrains), ui-monospace, monospace' }}>{label}</text>
      </g>
    </svg>
  );
}

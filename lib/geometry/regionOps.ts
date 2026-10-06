// Combine and cut areas: union, subtract, intersect, split by a line.
// Works on normalised page coordinates (0–1). A shape is an outer outline plus
// any holes (cut-outs) inside it.

import ClipperLib from 'clipper-lib';

export type Pt = { x: number; y: number };
export interface Shape { outer: Pt[]; holes: Pt[][] }

const SCALE = 1e8;                    // normalised → clipper integers
const MIN_AREA = 1e-9;                // drop slivers smaller than this (normalised²)

type IPath = { X: number; Y: number }[];
const toPath = (ring: Pt[]): IPath => ring.map(p => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));
const toRing = (path: IPath): Pt[] => path.map(p => ({ x: p.X / SCALE, y: p.Y / SCALE }));

export function ringArea(ring: Pt[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}
export const shapeArea = (s: Shape) => Math.max(0, ringArea(s.outer) - s.holes.reduce((t, h) => t + ringArea(h), 0));

const shapePaths = (s: Shape): IPath[] => [s.outer, ...s.holes].filter(r => r.length >= 3).map(toPath);

function run(subject: Shape[], clip: Shape[], type: number): Shape[] {
  const c = new ClipperLib.Clipper();
  // Even-odd, so each shape's holes stay holes.
  for (const s of subject) c.AddPaths(shapePaths(s), ClipperLib.PolyType.ptSubject, true);
  for (const s of clip)    c.AddPaths(shapePaths(s), ClipperLib.PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(type, tree, ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftEvenOdd);
  const ex = ClipperLib.JS.PolyTreeToExPolygons(tree) as { outer: IPath; holes: IPath[] }[];
  return ex
    .map(e => ({
      outer: toRing(ClipperLib.Clipper.CleanPolygon(e.outer, 2)),
      holes: e.holes.map(h => toRing(ClipperLib.Clipper.CleanPolygon(h, 2))).filter(h => h.length >= 3 && ringArea(h) > MIN_AREA),
    }))
    .filter(s => s.outer.length >= 3 && shapeArea(s) > MIN_AREA)
    .sort((a, b) => shapeArea(b) - shapeArea(a));
}

/** Each shape normalised on its own (self-overlaps removed). */
const solo = (s: Shape): Shape[] => run([s], [], ClipperLib.ClipType.ctUnion);

/** Join shapes. Shapes that touch or overlap become one; separate ones stay separate. */
export function unionShapes(shapes: Shape[]): Shape[] {
  let acc: Shape[] = [];
  for (const s of shapes) acc = acc.length ? run(acc, solo(s), ClipperLib.ClipType.ctUnion) : solo(s);
  return acc;
}

/** `base` with every cutter removed. May return several pieces, or none. */
export function subtractShapes(base: Shape, cutters: Shape[]): Shape[] {
  let acc = solo(base);
  for (const k of cutters) { if (!acc.length) break; acc = run(acc, solo(k), ClipperLib.ClipType.ctDifference); }
  return acc;
}

/** The part shared by all shapes. */
export function intersectShapes(shapes: Shape[]): Shape[] {
  if (!shapes.length) return [];
  let acc = solo(shapes[0]);
  for (const s of shapes.slice(1)) { if (!acc.length) break; acc = run(acc, solo(s), ClipperLib.ClipType.ctIntersection); }
  return acc;
}

/**
 * Cut a shape in two along a line drawn across it. The line is extended at
 * both ends, so it only has to cross the shape roughly.
 */
export function splitShape(shape: Shape, line: Pt[]): Shape[] {
  if (line.length < 2) return [shape];
  const a = line[0], b = line[line.length - 1];
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
  if (len < 1e-9) return [shape];
  const ux = dx / len, uy = dy / len, FAR = 8;
  const d0 = dir(line[1], line[0]), d1 = dir(line[line.length - 2], line[line.length - 1]);
  const start = { x: a.x + d0.x * FAR, y: a.y + d0.y * FAR };
  const end   = { x: b.x + d1.x * FAR, y: b.y + d1.y * FAR };
  const nx = -uy, ny = ux;                 // one side of the line
  const side: Shape = {
    outer: [start, ...line, end, { x: end.x + nx * FAR * 3, y: end.y + ny * FAR * 3 }, { x: start.x + nx * FAR * 3, y: start.y + ny * FAR * 3 }],
    holes: [],
  };
  const one = run(solo(shape), [side], ClipperLib.ClipType.ctIntersection);
  const two = run(solo(shape), [side], ClipperLib.ClipType.ctDifference);
  if (!one.length || !two.length) return [shape];   // the line missed the shape
  return [...one, ...two].sort((p, q) => shapeArea(q) - shapeArea(p));
}
function dir(from: Pt, to: Pt): Pt {
  const dx = to.x - from.x, dy = to.y - from.y, l = Math.hypot(dx, dy) || 1;
  return { x: dx / l, y: dy / l };
}

/** Is the point inside the shape (and not in one of its holes)? */
export function pointInShape(p: Pt, s: Shape): boolean {
  const inRing = (r: Pt[]) => {
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[i], b = r[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  };
  return inRing(s.outer) && !s.holes.some(inRing);
}

/** Nearest outline edge to a point: which ring (-1 = outer), which edge, how far (in px given page size). */
export function nearestEdge(p: Pt, s: Shape, w: number, h: number) {
  let best = { ring: -1, index: 0, dist: Infinity, point: p };
  const rings = [s.outer, ...s.holes];
  rings.forEach((r, ri) => {
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      const ax = a.x * w, ay = a.y * h, bx = b.x * w, by = b.y * h, px = p.x * w, py = p.y * h;
      const l2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1;
      const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / l2));
      const qx = ax + t * (bx - ax), qy = ay + t * (by - ay);
      const d = Math.hypot(px - qx, py - qy);
      if (d < best.dist) best = { ring: ri - 1, index: i, dist: d, point: { x: qx / w, y: qy / h } };
    }
  });
  return best;
}

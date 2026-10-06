// Join neighbouring outlines into one. Rooms found by Magic Fill stop at every
// drawn line, so a space crossed by a thin line (a setting-out arc, a floor
// pattern, the edge of a rug) comes out as several pieces with a hairline gap
// between them. `mergeRings` closes gaps up to `2 × bridge` wide and returns
// the outer outline(s) of what results: pieces separated only by a thin line
// become one shape, pieces separated by a real wall stay separate.

import ClipperLib from 'clipper-lib';

export type Ring = [number, number][];

const SCALE = 100;   // 0.01-unit precision in clipper's integer space

const toPath = (ring: Ring) => ring.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));
const toRing = (path: { X: number; Y: number }[]): Ring => path.map(p => [p.X / SCALE, p.Y / SCALE]);

function offset(paths: { X: number; Y: number }[][], delta: number): { X: number; Y: number }[][] {
  const co = new ClipperLib.ClipperOffset(2, 0.25 * SCALE);
  co.AddPaths(paths, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
  const out: { X: number; Y: number }[][] = [];
  co.Execute(out, delta * SCALE);
  return out;
}

export function ringArea(ring: Ring): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

export function ringPerimeter(ring: Ring): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length];
    s += Math.hypot(x2 - x1, y2 - y1);
  }
  return s;
}

/**
 * Union of `rings`, bridging gaps narrower than `2 × bridge`. Returns outer
 * outlines only, largest first — anything fully enclosed (a table standing on
 * the joining line, say) is part of the shape, as it is for a single room.
 */
export function mergeRings(rings: Ring[], bridge: number): Ring[] {
  const paths = rings.filter(r => r.length >= 3).map(toPath);
  if (paths.length === 0) return [];
  // Clipper wants a consistent winding.
  for (const p of paths) if (!ClipperLib.Clipper.Orientation(p)) p.reverse();

  const grown  = offset(paths, bridge);            // overlapping results are unioned
  const shrunk = offset(grown, -bridge);
  const outers = shrunk.filter(p => p.length >= 3 && ClipperLib.Clipper.Orientation(p));
  return outers
    .map(p => toRing(ClipperLib.Clipper.CleanPolygon(p, 0.05 * SCALE)))
    .filter(r => r.length >= 3)
    .sort((a, b) => ringArea(b) - ringArea(a));
}

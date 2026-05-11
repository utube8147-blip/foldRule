// /hooks/useSnapEngine/deriveWallCorners.ts
// For vector walls, corners = intersections of H and V wall centerlines.
// Much simpler than the raster version because lines are already clean.

import { WallLineNorm, WallCornerNorm } from '@/types/viewerTypes';

export function deriveWallCorners(walls: WallLineNorm[]): WallCornerNorm[] {
  const hWalls = walls.filter(w => w.angle === 0);
  const vWalls = walls.filter(w => w.angle === 90);
  const corners: WallCornerNorm[] = [];
  const SNAP = 0.005; // 0.5% of page — tolerance for T and L junctions

  for (const h of hWalls) {
    for (const v of vWalls) {
      const ix = v.nx1; // vertical wall x
      const iy = h.ny1; // horizontal wall y

      const onH = ix >= Math.min(h.nx1, h.nx2) - SNAP &&
                  ix <= Math.max(h.nx1, h.nx2) + SNAP;
      const onV = iy >= Math.min(v.ny1, v.ny2) - SNAP &&
                  iy <= Math.max(v.ny1, v.ny2) + SNAP;

      if (onH && onV) {
        const tooClose = corners.some(c => Math.hypot(c.nx - ix, c.ny - iy) < SNAP);
        if (!tooClose) {
          corners.push({
            nx: ix,
            ny: iy,
            // x,y are not part of WallCornerNorm here; scaled coordinates
            // are populated later by getScaledWallCorners()
            confidence: 1.0,
            lineIndices: [],
          });
        }
      }
    }
  }

  return corners;
}
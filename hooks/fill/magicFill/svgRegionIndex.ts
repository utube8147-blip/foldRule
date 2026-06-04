// hooks/magicFill/svgRegionIndex.ts
//
// Strict raster-based region pre-computation.
//
// Strategy:
//   1. At load time, rasterise every SVG stroke onto a wall mask (same way
//      usePdfFill does for PDFs — luminance threshold → dilate → erode).
//   2. Flood-fill the entire canvas exhaustively, storing every closed region
//      as a Uint8Array pixel map + bounding box + area.
//   3. On click, find all regions whose bounding box contains the click point
//      AND whose pixel map has a set pixel at that point → pick the smallest.
//
// Because regions are found purely from the raster, shared edges between a
// small room and the large outer box are handled naturally: each enclosed
// pocket is its own flood region, no matter what shares its boundary.

import {
  buildWallMask,
  dilateMaskFast,
  erodeMaskFast,
  scanlineFill,
  maskArea,
  buildPolygonFromMask,
  polygonPerim,
  DILATE_R,
  ERODE_R,
  FILL_GROW,
} from './fillCore';

export interface RasterRegion {
  id: number;
  pixels: Uint8Array;       // length = canvasW * canvasH, 1 = inside region
  areaPx: number;
  perimPx: number;
  polygon: [number, number][];
  bbox: { x1: number; y1: number; x2: number; y2: number };
  centroid: [number, number];
}

export interface RasterRegionIndex {
  regions: RasterRegion[];
  canvasW: number;
  canvasH: number;
  // Flat lookup: pixelToRegionIds[y * canvasW + x] = smallest-region id + 1
  // (0 = wall / unassigned). Used for O(1) hover.
  pixelToSmallest: Int32Array;
}

// ── Build ─────────────────────────────────────────────────────────────────────

export async function buildRasterRegionIndex(
  baseCanvas: HTMLCanvasElement,
  onProgress?: (msg: string) => void,
): Promise<RasterRegionIndex> {
  const w = baseCanvas.width;
  const h = baseCanvas.height;
  const ctx = baseCanvas.getContext('2d')!;
  const id  = ctx.getImageData(0, 0, w, h);

  onProgress?.('Building wall mask…');
  await yieldMacro();

  // Wall mask: same pipeline as PDF mode
  const raw     = buildWallMask(id.data, w, h);
  const dilated = dilateMaskFast(raw, w, h, DILATE_R);
  const mask    = erodeMaskFast(dilated, w, h, ERODE_R);

  onProgress?.('Scanning for enclosed regions…');
  await yieldMacro();

  // Track which pixels have already been assigned to a region
  const visited = new Uint8Array(w * h);
  // Mark all wall pixels as visited so we never seed from them
  for (let i = 0; i < w * h; i++) if (mask[i]) visited[i] = 1;

  const regions: RasterRegion[] = [];
  let regionId = 0;

  // Scan every unvisited non-wall pixel as a potential seed
  // Step by STEP pixels to be fast; scanlineFill is O(region size) not O(canvas)
  const STEP = 3;
  let lastYield = performance.now();

  for (let y = 0; y < h; y += STEP) {
    for (let x = 0; x < w; x += STEP) {
      const idx = y * w + x;
      if (visited[idx] || mask[idx]) continue;

      // Try to fill from this seed
      const filled = scanlineFill(mask, w, h, x, y);
      if (!filled) {
        // Mark this pixel visited so we don't retry it
        visited[idx] = 1;
        continue;
      }

      // Mark all filled pixels visited
      for (let i = 0; i < w * h; i++) if (filled[i]) visited[i] = 1;

      // Grow slightly to cover anti-aliased edges
      const grown = dilateMaskFast(filled, w, h, FILL_GROW);

      const areaPx = maskArea(grown);
      // Filter out tiny noise regions (< 200 px²)
      if (areaPx < 200) continue;

      const polygon  = buildPolygonFromMask(grown, w, h);
      const perimPx  = polygonPerim(polygon);

      // Bounding box
      let x1 = w, y1 = h, x2 = 0, y2 = 0;
      let cx = 0, cy = 0, cnt = 0;
      for (let i = 0; i < w * h; i++) {
        if (!grown[i]) continue;
        const px = i % w, py = (i / w) | 0;
        if (px < x1) x1 = px; if (px > x2) x2 = px;
        if (py < y1) y1 = py; if (py > y2) y2 = py;
        cx += px; cy += py; cnt++;
      }

      regions.push({
        id: regionId++,
        pixels: grown,
        areaPx,
        perimPx,
        polygon,
        bbox: { x1, y1, x2, y2 },
        centroid: cnt > 0 ? [cx / cnt, cy / cnt] : [x, y],
      });

      // Yield periodically so the UI stays alive
      const now = performance.now();
      if (now - lastYield > 30) {
        onProgress?.(`Found ${regions.length} regions…`);
        await yieldMacro();
        lastYield = performance.now();
      }
    }
  }

  onProgress?.(`Indexing ${regions.length} regions…`);
  await yieldMacro();

  // Sort by area ascending — smallest first for the hover lookup
  regions.sort((a, b) => a.areaPx - b.areaPx);
  // Re-assign ids after sort
  regions.forEach((r, i) => { r.id = i; });

  // Build flat pixel→smallest-region lookup
  // For each pixel, we want the id of the smallest region that covers it.
  // Since regions are sorted smallest-first, the first region that sets a
  // pixel wins (smallest).
  const pixelToSmallest = new Int32Array(w * h).fill(-1);
  for (const region of regions) {
    for (let i = 0; i < w * h; i++) {
      if (region.pixels[i] && pixelToSmallest[i] === -1) {
        pixelToSmallest[i] = region.id;
      }
    }
  }

  return { regions, canvasW: w, canvasH: h, pixelToSmallest };
}

// ── Hit test ──────────────────────────────────────────────────────────────────

/**
 * Returns the smallest region whose pixel map includes (px, py).
 * Falls back to a bbox+pixel scan if the flat lookup misses.
 */
export function hitTestRegion(
  index: RasterRegionIndex,
  px: number,
  py: number,
): RasterRegion | null {
  const { canvasW, canvasH, regions, pixelToSmallest } = index;
  if (px < 0 || px >= canvasW || py < 0 || py >= canvasH) return null;

  // O(1) lookup via flat map
  const id = pixelToSmallest[py * canvasW + px];
  if (id >= 0 && id < regions.length) return regions[id];

  // Fallback: linear scan (only for pixels that weren't covered — shouldn't happen often)
  for (const region of regions) {
    if (px < region.bbox.x1 || px > region.bbox.x2) continue;
    if (py < region.bbox.y1 || py > region.bbox.y2) continue;
    if (region.pixels[py * canvasW + px]) return region;
  }
  return null;
}

// ── Async helpers (duplicated here to avoid circular imports) ─────────────────

function yieldMacro(): Promise<void> {
  return new Promise(r => setTimeout(r, 0));
}
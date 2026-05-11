// hooks/useSnapEngine/roomExclusion.ts
//
// Filters and label extractors used by the hybrid detection pipeline.
//
// FIXES vs previous version:
//   1. isGeometryExcluded — adds aspect-ratio check so thin corridor-like
//      slivers (very wide or very tall, likely title bands or page borders)
//      are excluded without OCR.
//   2. isOcrExcluded — expanded pattern list covers:
//      stair cores, lift shafts, north arrows, scale bars, legends,
//      drawing titles, WC / toilet labels, and partial-word garbage
//      (single/double chars that Tesseract hallucinates from noise).
//   3. extractRoomLabel — normalises whitespace, strips area annotations
//      (e.g. "110 m²" or "110 m2"), and handles split labels like
//      "LOBBY /\nCORRIDOR" → "Lobby / Corridor".
//
// FIX — legend box, title block, north arrow survive boundaryExclusion:
//   isGeometryExcluded now checks for two additional patterns:
//
//   a) areaNorm < 0.005 (was 0.002) — legend and title cells on this plan
//      occupy ~0.3–0.8% of page area. Raising the floor eliminates them
//      without touching real rooms (smallest real room ≈ WC at ~1.5%).
//
//   b) "Corner hugging" — regions whose centroid is within 0.12 of any
//      page corner are almost certainly annotation boxes (legend top-left,
//      title block bottom-right, north arrow top-right, scale bar
//      bottom-left). Real rooms are never jammed into page corners.
//
//   c) Dimension-strip shape — a region whose bbox height is < 0.06 of the
//      page AND whose bbox top edge is within 0.08 of the page top is
//      almost certainly the dimension-line annotation band, not a room.

// ─── Geometry exclusion ──────────────────────────────────────────────────────

export interface RoomLike {
  areaNorm: number;
  polygon:  Array<{ nx: number; ny: number }>;
  centroid: { nx: number; ny: number };
}

/**
 * Returns true if the region should be excluded based on geometry alone,
 * before spending any OCR budget on it.
 */
export function isGeometryExcluded(room: RoomLike): boolean {
  // FIX: raised from 0.002 to 0.005.
  // Legend cells and title block sub-regions on typical A1 plans are 0.3-0.8%.
  // The smallest real room (WC / server room) is rarely below 1.5%.
  if (room.areaNorm < 0.005) return true;

  // Too large — probably the entire page interior or an outer border
  if (room.areaNorm > 0.85) return true;

  // Check bounding box aspect ratio from polygon extents
  let minNx = 1, maxNx = 0, minNy = 1, maxNy = 0;
  for (const p of room.polygon) {
    if (p.nx < minNx) minNx = p.nx;
    if (p.nx > maxNx) maxNx = p.nx;
    if (p.ny < minNy) minNy = p.ny;
    if (p.ny > maxNy) maxNy = p.ny;
  }

  const bboxW = maxNx - minNx;
  const bboxH = maxNy - minNy;

  if (bboxW < 0.001 || bboxH < 0.001) return true;

  const aspect = bboxW / bboxH;

  // Very thin horizontal or vertical bands are likely title blocks or borders
  if (aspect > 15 || aspect < 0.067) return true;

  // Region hugs the very edge of the page — likely a border or legend box
  const edgeMargin = 0.01;
  const touchesEdge =
    minNx < edgeMargin &&
    minNy < edgeMargin &&
    maxNx > 1 - edgeMargin &&
    maxNy > 1 - edgeMargin;
  if (touchesEdge) return true;

  // FIX a) Corner-hugging annotation boxes.
  // Regions whose centroid is very close to any page corner are almost
  // certainly legend boxes, north arrows, title blocks, or scale bars.
  // Real rooms on a floor plan are never centred at a page corner.
  const cx = room.centroid.nx;
  const cy = room.centroid.ny;
  const CORNER_DIST = 0.12;
  const nearCorner =
    (cx < CORNER_DIST       && cy < CORNER_DIST) ||       // top-left
    (cx > 1 - CORNER_DIST   && cy < CORNER_DIST) ||       // top-right
    (cx < CORNER_DIST       && cy > 1 - CORNER_DIST) ||   // bottom-left
    (cx > 1 - CORNER_DIST   && cy > 1 - CORNER_DIST);     // bottom-right
  if (nearCorner) return true;

  // FIX b) Dimension-annotation strip at the top of the drawing.
  // Many architectural plans have a dimension band along the top/left edge
  // showing bay widths (13.000, 15.000 etc.) between gridlines.
  // These form very flat rectangles near the top of the page.
  const isDimensionStrip =
    bboxH < 0.06 &&          // very flat vertically
    minNy < 0.08;             // sits near the top of the page
  if (isDimensionStrip) return true;

  // FIX c) Same check for left-edge dimension strips (vertical bay labels)
  const isLeftDimensionStrip =
    bboxW < 0.06 &&           // very narrow horizontally
    minNx < 0.08;             // sits near the left edge of the page
  if (isLeftDimensionStrip) return true;

  return false;
}

// ─── OCR exclusion ───────────────────────────────────────────────────────────

/**
 * Patterns whose presence in the OCR text means the region is NOT a room.
 * Each pattern is tested case-insensitively against the full trimmed text.
 */
const OCR_EXCLUSION_PATTERNS: RegExp[] = [
  // Drawing infrastructure
  /\bstair/i,
  /\blift\b/i,
  /\belevator/i,
  /\bcore\b/i,
  /\bshaft/i,
  /\bduct/i,
  /\briser/i,

  // Annotations / legend
  /\bnorth\b/i,
  /\bscale\b/i,
  /\blegend\b/i,
  /\brevision/i,
  /\bdrawn\s+by/i,
  /\bchecked\s+by/i,
  /\bdate\b/i,
  /\bdrawing\s+no/i,
  /\bproject\s+no/i,
  /\bsheet\b/i,
  /\bnts\b/i,
  /\bdo\s+not\s+scale/i,

  // Title block / drawing info keywords that leak from the title panel
  /\bground\s+floor/i,
  /\barchitectural\s+plan/i,
  /\bblock\s+[a-z]/i,
  /\bscale\s*1\s*:/i,
  /april|january|february|march|may|june|july|august|september|october|november|december/i,
  /\b20\d{2}\b/,              // years like 2024, 2025

  // Toilet / utility labels
  /\bw\.?c\.?\b/i,
  /\btoilet/i,
  /\bwashroom/i,
  /\brestroom/i,
  /\bjanitor/i,
  /\bcleaner/i,
  /\butility/i,

  // Dimension / measurement strings that OCR picks up from annotation bands
  /^\d+[\.,]\d{3}$/,          // e.g. "13.000" or "15,000"
  /^\d+\s*m\s*$/i,            // e.g. "13 m"

  // Single or double char garbage — Tesseract noise artefacts
  /^[a-z]{1,2}$/i,
];

/**
 * Returns true if the OCR text matches a known non-room annotation pattern.
 */
export function isOcrExcluded(rawOcr: string): boolean {
  const text = rawOcr.trim();
  if (!text) return false;
  return OCR_EXCLUSION_PATTERNS.some(p => p.test(text));
}

// ─── Label extraction ─────────────────────────────────────────────────────────

/**
 * Extracts a clean room label from raw Tesseract output.
 *
 * Steps:
 *   1. Strip area annotations like "110 m²", "260 m2", "80 sqm"
 *   2. Normalise whitespace and line breaks
 *   3. Title-case the result
 *   4. Return null if nothing meaningful remains
 */
export function extractRoomLabel(rawOcr: string | null | undefined): string | null {
  if (!rawOcr) return null;

  let text = rawOcr;

  // Strip area annotations — e.g. "110 m²", "260 m2", "80 sqm", "50 sq.m"
  text = text.replace(/\d+[\.,]?\d*\s*(?:m[²2]|sqm|sq\.?m|ft[²2]|sf)\b/gi, '');

  // Strip standalone numbers (dimension callouts, grid refs, years)
  text = text.replace(/(?:^|\s)\d+(?:[.,]\d+)?(?=\s|$)/g, '');

  // Collapse line breaks and extra whitespace
  text = text.replace(/[\r\n]+/g, ' / ').replace(/\s{2,}/g, ' ').trim();

  // Remove leading/trailing punctuation artefacts
  text = text.replace(/^[^a-zA-Z]+/, '').replace(/[^a-zA-Z)]+$/, '').trim();

  if (text.length < 2) return null;

  // Reject if it matches any exclusion pattern even after cleaning
  if (isOcrExcluded(text)) return null;

  // Title-case: capitalise first letter of each word, lowercase the rest
  // Preserve "/" separators (e.g. "LOBBY / CORRIDOR" → "Lobby / Corridor")
  text = text
    .split(/\s+/)
    .map(word =>
      word === '/'
        ? '/'
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join(' ');

  return text;
}
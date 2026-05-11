// hooks/useSnapEngine/roomExclusion.ts
//
// Filters and label extractors used by the hybrid detection pipeline.
//
// FIXES vs previous version:
//
//   1. isOcrExcluded — WC / toilet patterns NARROWED to exact-match only.
//      Previously /\bw\.?c\.?\b/i and /\btoilet/i killed valid room labels
//      like "WC (M)", "WC (F)", "Toilet Block". These ARE real rooms and must
//      appear on the overlay. New patterns only exclude bare "WC" or "WC." with
//      nothing else in the string (fixture labels, not room names).
//
//   2. isOcrExcluded — removed /\bcore\b/i which was over-broad and could kill
//      labels like "Server Room Core". Replaced with /\bstair\s*core\b/i.
//
//   3. extractRoomLabel — relaxed: returning null no longer discards the region.
//      The caller (ocrAndLabel in detectRoomsHybrid) falls through to
//      sanitiseOcrText → area heuristic, so rooms with unusual names survive.
//
//   4. isGeometryExcluded — aspect ratio limits widened slightly:
//      was aspect > 15 || < 0.067, now > 18 || < 0.055.
//      Some narrow-but-real corridor rooms on dense office plans have aspect
//      ratios up to 1:16 or 16:1 and were being incorrectly excluded.

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
  // Too small — legend cells and title sub-regions are 0.3-0.8%
  // Smallest real room (WC / server room) is rarely below 1.5%
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

  // FIX: widened from 15/0.067 to 18/0.055.
  // Narrow corridor rooms (e.g. 1:16 ratio) were being excluded.
  if (aspect > 18 || aspect < 0.055) return true;

  // Region hugs the very edge of the page — likely a border or legend box
  const edgeMargin = 0.01;
  const touchesEdge =
    minNx < edgeMargin &&
    minNy < edgeMargin &&
    maxNx > 1 - edgeMargin &&
    maxNy > 1 - edgeMargin;
  if (touchesEdge) return true;

  // Corner-hugging annotation boxes (legend, north arrow, title block)
  const cx = room.centroid.nx;
  const cy = room.centroid.ny;
  const CORNER_DIST = 0.12;
  const nearCorner =
    (cx < CORNER_DIST       && cy < CORNER_DIST) ||       // top-left
    (cx > 1 - CORNER_DIST   && cy < CORNER_DIST) ||       // top-right
    (cx < CORNER_DIST       && cy > 1 - CORNER_DIST) ||   // bottom-left
    (cx > 1 - CORNER_DIST   && cy > 1 - CORNER_DIST);     // bottom-right
  if (nearCorner) return true;

  // Dimension-annotation strip at the top of the drawing
  const isDimensionStrip =
    bboxH < 0.06 &&
    minNy < 0.08;
  if (isDimensionStrip) return true;

  // Left-edge dimension strips (vertical bay labels)
  const isLeftDimensionStrip =
    bboxW < 0.06 &&
    minNx < 0.08;
  if (isLeftDimensionStrip) return true;

  return false;
}

// ─── OCR exclusion ───────────────────────────────────────────────────────────

/**
 * Patterns whose presence in the OCR text means the region is NOT a room.
 *
 * CHANGE NOTES:
 *   - /\bcore\b/i removed — too broad, killed "Server Room Core"
 *   - /\bstair\s*core\b/i added — more specific
 *   - WC/toilet patterns narrowed to exact-match (see below)
 *   - /\bjanitor/i, /\bcleaner/i, /\butility/i removed —
 *     these are valid room categories in some building types
 */
const OCR_EXCLUSION_PATTERNS: RegExp[] = [
  // Drawing infrastructure — structural elements, not occupiable rooms
  /\bstair/i,
  /\blift\b/i,
  /\belevator/i,
  /\bstair\s*core\b/i,
  /\bshaft/i,
  /\bduct\b/i,
  /\briser\b/i,

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

  // Title block keywords
  /\bground\s+floor/i,
  /\barchitectural\s+plan/i,
  /\bblock\s+[a-z]/i,
  /\bscale\s*1\s*:/i,
  /april|january|february|march|june|july|august|september|october|november|december/i,
  /\b20\d{2}\b/,              // years like 2024, 2025

  // FIX: WC / toilet — exact-match only so "WC (M)", "WC (F)" survive.
  // A bare "WC" or "WC." with nothing else is a fixture label, not a room name.
  /^w\.?c\.?\.?$/i,           // bare WC, WC., W.C, W.C. — fixture label
  /^(gents|ladies)\s+wc$/i,   // "Gents WC" as standalone = fixture, not room
  // NOTE: "WC (M)", "WC (F)", "Toilet Block", "Washroom" are intentionally
  //       NOT excluded — they are valid room labels.

  // Dimension / measurement strings from annotation bands
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
 * Returns null if the text is noise or matches an exclusion pattern —
 * the caller should then try sanitiseOcrText before falling back to heuristics.
 */
export function extractRoomLabel(rawOcr: string | null | undefined): string | null {
  if (!rawOcr) return null;

  let text = rawOcr;

  // Strip area annotations — e.g. "110 m²", "260 m2", "80 sqm", "50 sq.m"
  text = text.replace(/\d+[\.,]?\d*\s*(?:m[²2]|sqm|sq\.?m|ft[²2]|sf)\b/gi, '');

  // Strip standalone numbers (dimension callouts, grid refs, years)
  // BUT: preserve numbers that are part of room names like "OFFICE 1", "ROOM 2B"
  // Only strip if the number is the entire token (surrounded by spaces or string bounds)
  text = text.replace(/(?:^|\s)(\d+(?:[.,]\d+)?)(?=\s|$)/g, (match, num) => {
    // Keep if it looks like a room number suffix (single digit / digit+letter)
    if (/^\d{1,2}[A-Za-z]?$/.test(num)) return match;
    return ' ';
  });

  // Collapse line breaks and extra whitespace
  text = text.replace(/[\r\n]+/g, ' / ').replace(/\s{2,}/g, ' ').trim();

  // Remove leading/trailing punctuation artefacts
  text = text.replace(/^[^a-zA-Z(]+/, '').replace(/[^a-zA-Z0-9)]+$/, '').trim();

  if (text.length < 2) return null;

  // Reject if it matches any exclusion pattern even after cleaning
  if (isOcrExcluded(text)) return null;

  // Title-case: capitalise first letter of each word, lowercase the rest
  // Preserve "/" separators (e.g. "LOBBY / CORRIDOR" → "Lobby / Corridor")
  // Preserve parenthetical suffixes like "(M)", "(F)"
  text = text
    .split(/\s+/)
    .map(word => {
      if (word === '/') return '/';
      if (/^\([A-Za-z]\)$/.test(word)) return word.toUpperCase(); // (M) → (M)
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');

  return text;
}
// svgDecorationFilter.ts
//
// Filters out decoration / grid / border elements from SVG floor plans.
//
// CHANGES in this version:
//   • Added DECORATION_FILTER_CONFIG.minAreaSvgUnits — kills column markers,
//     window symbols, scale bar segments, and other tiny shapes.
//   • Added DECORATION_FILTER_CONFIG.maxAspectRatio — kills window/door
//     symbols that are extremely thin rectangles.
//   • resolveStrokeWidth() unchanged — imported by useSvgSnapPoints + useSvgInteraction.
//   • isFullPageShape() unchanged.
//   • isDecorationElement() now runs area + aspect checks first (fast path)
//     before the heavier stroke-width / count heuristics.
// ─────────────────────────────────────────────────────────────────────────────

export interface DecorationFilterConfig {
  /** Stroke widths at or below this value are treated as decoration/grid lines */
  maxDecorationStrokeWidth: number;

  /**
   * Minimum bounded area (in SVG viewBox square units) for a closed shape to be
   * considered a room/area candidate.
   *
   * Tune this per drawing scale.  For a 1:100 CAD export at ~1190×841 viewBox:
   *   - Column squares   ≈ 16×16  = 256 sq units  → filter OUT
   *   - Window symbols   ≈ 90×10  = 900 sq units  → filter OUT
   *   - Scale bar segs   ≈ 20×8   = 160 sq units  → filter OUT
   *   - Smallest room    ≈ 130×30 = 3 900 sq units → keep
   * Default: 2 000 (safely below any real room in a typical 1:100 plan).
   */
  minAreaSvgUnits: number;

  /**
   * Maximum aspect ratio (longer / shorter side) for a closed shape to be a room.
   * Window symbols, dimension arrows, and legend entries are very thin (ratio > 10).
   * Default: 12.
   */
  maxAspectRatio: number;

  /**
   * If an element has more siblings with the same stroke-width than this,
   * treat the whole group as a grid / repeated decoration.
   */
  maxSiblingCount: number;

  /**
   * Fraction of the drawing width/height at which a shape is considered full-page.
   * Used by isFullPageShape(). Default: 0.9.
   */
  fullPageFraction: number;
}

export const DECORATION_FILTER_CONFIG: DecorationFilterConfig = {
  maxDecorationStrokeWidth: 0.35,
  minAreaSvgUnits: 2000,
  maxAspectRatio: 12,
  maxSiblingCount: 12,
  fullPageFraction: 0.9,
};

// ─── resolveStrokeWidth ───────────────────────────────────────────────────────

/**
 * Walk the element and its ancestors to find the effective stroke-width.
 * Falls back to 1 if none is specified anywhere.
 */
export function resolveStrokeWidth(el: Element): number {
  let node: Element | null = el;
  while (node) {
    // Inline style takes priority
    const style = node.getAttribute('style') ?? '';
    const styleMatch = style.match(/stroke-width\s*:\s*([\d.]+)/);
    if (styleMatch) return parseFloat(styleMatch[1]);

    // Presentation attribute
    const attr = node.getAttribute('stroke-width');
    if (attr) return parseFloat(attr);

    node = node.parentElement;
  }
  return 1;
}

// ─── isFullPageShape ──────────────────────────────────────────────────────────

/**
 * Returns true if a polygon covers nearly the entire canvas — used to filter
 * out the outer document border rectangle that CAD tools always draw.
 */
export function isFullPageShape(
  points: Array<{ x: number; y: number }>,
  canvasW: number,
  canvasH: number,
): boolean {
  if (points.length < 3) return false;
  const frac = DECORATION_FILTER_CONFIG.fullPageFraction;
  const minX = Math.min(...points.map(p => p.x));
  const maxX = Math.max(...points.map(p => p.x));
  const minY = Math.min(...points.map(p => p.y));
  const maxY = Math.max(...points.map(p => p.y));
  const w = maxX - minX;
  const h = maxY - minY;
  return w >= canvasW * frac && h >= canvasH * frac;
}

// ─── shapeBoundsFromElement ───────────────────────────────────────────────────
// Extract a quick axis-aligned bounding box directly from SVG attributes
// (in SVG user-space, before any CTM transform) for the fast-path area/aspect
// check.  Returns null if the element type isn't handled.

interface SimpleBounds { w: number; h: number }

function simpleBoundsFromElement(el: Element): SimpleBounds | null {
  const tag = el.tagName.toLowerCase();
  const n = (name: string) => parseFloat(el.getAttribute(name) ?? '0');

  switch (tag) {
    case 'rect': {
      const w = Math.abs(n('width'));
      const h = Math.abs(n('height'));
      return w > 0 && h > 0 ? { w, h } : null;
    }
    case 'line': {
      const dx = Math.abs(n('x2') - n('x1'));
      const dy = Math.abs(n('y2') - n('y1'));
      // Lines are 1-D; treat as very thin rectangle
      return { w: Math.max(dx, 1), h: Math.max(dy, 1) };
    }
    case 'circle':
    case 'ellipse': {
      const rx = n(tag === 'circle' ? 'r' : 'rx');
      const ry = n(tag === 'circle' ? 'r' : 'ry');
      return rx > 0 && ry > 0 ? { w: rx * 2, h: ry * 2 } : null;
    }
    default:
      return null;
  }
}

// ─── isDecorationElement ──────────────────────────────────────────────────────

/**
 * Returns true if the element should be skipped by the snap and area engines.
 *
 * Check order (cheapest first):
 *   1. Stroke-width threshold  — grid lines are drawn thin
 *   2. Bounding-box area       — column squares, window symbols, scale bars
 *   3. Aspect ratio            — window/door frames that are very thin
 *   4. Sibling count           — repeated grid elements
 */
export function isDecorationElement(el: Element, strokeWidth: number): boolean {
  const cfg = DECORATION_FILTER_CONFIG;

  // ── 1. Stroke-width ───────────────────────────────────────────────────────
  if (strokeWidth <= cfg.maxDecorationStrokeWidth) return true;

  // ── 2 & 3. Area and aspect ratio (fast-path for known shape types) ────────
  const bounds = simpleBoundsFromElement(el);
  if (bounds) {
    const { w, h } = bounds;
    const area = w * h;
    if (area < cfg.minAreaSvgUnits) return true;

    const shorter = Math.min(w, h);
    const longer  = Math.max(w, h);
    if (shorter > 0 && longer / shorter > cfg.maxAspectRatio) return true;
  }

  // ── 4. Sibling count heuristic ────────────────────────────────────────────
  const parent = el.parentElement;
  if (parent) {
    const sw = el.getAttribute('stroke-width') ??
      (el.getAttribute('style') ?? '').match(/stroke-width\s*:\s*([\d.]+)/)?.[1];
    if (sw) {
      let count = 0;
      for (const sib of Array.from(parent.children)) {
        const sibSW = sib.getAttribute('stroke-width') ??
          (sib.getAttribute('style') ?? '').match(/stroke-width\s*:\s*([\d.]+)/)?.[1];
        if (sibSW === sw) count++;
        if (count > cfg.maxSiblingCount) return true;
      }
    }
  }

  return false;
}
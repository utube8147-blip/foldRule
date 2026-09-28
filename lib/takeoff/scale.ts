import type { Drawing, TakeoffRow } from '@/types';

/** Effective page for a row (legacy rows without pageNumber belong to page 1). */
export const rowPage = (m: Pick<TakeoffRow, 'pageNumber'>): number => m.pageNumber ?? 1;

/**
 * Calibrated scale for a page, or null when the page has not been calibrated.
 * Falls back to the legacy drawing-wide scaleFactor if it was explicitly set (≠ 1).
 */
export function getPageScale(drawing: Drawing | null | undefined, page: number): number | null {
  if (!drawing) return null;
  const s = drawing.pageScales?.[page];
  if (typeof s === 'number' && s > 0) return s;
  if (!drawing.pageScales && drawing.scaleFactor && drawing.scaleFactor !== 1) return drawing.scaleFactor;
  return null;
}

/** Scale to use for computing quantities: calibrated value, or 1 (uncalibrated). */
export const effectivePageScale = (drawing: Drawing | null | undefined, page: number): number =>
  getPageScale(drawing, page) ?? 1;

const LENGTH_TYPES = new Set(['Length']);
const AREA_TYPES   = new Set(['Area', 'Polygon', 'Rectangle']);

/**
 * When a page is (re)calibrated, rescale every drawn, non-overridden measurement on
 * that page so "measure first, calibrate later" gives correct quantities.
 * Length-type rows scale linearly, area-type rows by the square; counts are untouched.
 */
export function rescaleMeasurementsForPage(
  measurements: TakeoffRow[],
  drawingId: string,
  page: number,
  oldScale: number,
  newScale: number,
): TakeoffRow[] {
  if (!(oldScale > 0) || !(newScale > 0) || oldScale === newScale) return measurements;
  const r = newScale / oldScale;
  let changed = false;
  const out = measurements.map(m => {
    if (m.drawingId !== drawingId || rowPage(m) !== page) return m;
    if (m.isGroupHeader || m.isOverridden || !m.points?.length) return m;
    let factor = 0;
    if (LENGTH_TYPES.has(m.type)) factor = r;
    else if (AREA_TYPES.has(m.type)) factor = r * r;
    if (!factor) return m;
    changed = true;
    return {
      ...m,
      quantity: m.quantity * factor,
      ...(m.arcRadius != null ? { arcRadius: m.arcRadius * r } : {}),
    };
  });
  return changed ? out : measurements;
}

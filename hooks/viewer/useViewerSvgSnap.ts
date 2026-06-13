'use client';

// ─── hooks/useViewerSvgSnap.ts ────────────────────────────────────────────────
//
//  Fetches the hardcoded floor-plan SVG from /floor-plan.svg (public folder),
//  parses snap points via useSvgSnapPoints, and returns the snap data ready
//  to be fed into the Viewer's existing useSnapEngine call.
//
//  SWAP POINT: change SVG_PATH to point at a different file in /public and
//  nothing else in the codebase needs to change.
//
//  Returns stable empty arrays (not null/undefined) while loading or on error
//  so callers can spread directly into useSnapEngine without null checks.
//
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react';
import { useSvgSnapPoints }     from '@/hooks/snapEngine/useSvgSnapPoints';
import type { SvgSnapPoint }    from '@/hooks/snapEngine/useSvgSnapPoints';
import type { SvgLine }         from '@/hooks/snapEngine/useSvgSnapPoints';
import type { PdfDimensions }   from '@/types/viewerTypes';

// ── Path to the SVG in /public ────────────────────────────────────────────────
const SVG_PATH = '/floor-plan.svg';

// ── Return shape ──────────────────────────────────────────────────────────────
export interface ViewerSvgSnapData {
  /** Snap points derived from the SVG (endpoints, midpoints, centroids, intersections). */
  svgSnapPoints: SvgSnapPoint[];
  /** Line segments extracted from the SVG. */
  svgLines: SvgLine[];
  /** Curve segments extracted from the SVG. */
  svgCurves: SvgLine[];
  /** True while the SVG is being fetched / parsed. */
  isLoading: boolean;
  /** Non-null if the fetch or parse failed. */
  error: string | null;
}

const EMPTY: ViewerSvgSnapData = {
  svgSnapPoints: [],
  svgLines:      [],
  svgCurves:     [],
  isLoading:     false,
  error:         null,
};

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * Loads the hardcoded SVG overlay from the public folder and returns snap data
 * ready to pass to useSnapEngine's `svgSnapPoints`, `svgLines`, `svgCurves` props.
 *
 * @param pdfDimensions  Current PDF canvas dimensions (w/h in PDF pixels).
 *                       Pass null while the PDF hasn't loaded yet — the hook
 *                       will return empty arrays until dimensions are available.
 * @param zoom           Current viewer zoom level (forwarded to useSvgSnapPoints).
 * @param enabled        Set false to skip loading entirely (e.g. feature flag).
 */
export function useViewerSvgSnap(
  pdfDimensions: PdfDimensions | null,
  zoom:          number,
  enabled        = true,
): ViewerSvgSnapData {
  const [svgText,    setSvgText]    = useState<string | null>(null);
  const [isLoading,  setIsLoading]  = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  // ── Fetch SVG once on mount (or when enabled flips true) ──────────────────
  useEffect(() => {
    if (!enabled) { setSvgText(null); return; }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    fetch(SVG_PATH)
      .then(res => {
        if (!res.ok) throw new Error(`Failed to load ${SVG_PATH}: ${res.status} ${res.statusText}`);
        return res.text();
      })
      .then(text => {
        if (!cancelled) {
          setSvgText(text);
          setIsLoading(false);
        }
      })
      .catch(err => {
        if (!cancelled) {
          console.warn('[useViewerSvgSnap]', err.message);
          setError(err.message);
          setIsLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [enabled]);

  // ── Parse snap points whenever SVG text or PDF dims are ready ─────────────
  //
  //  useSvgSnapPoints expects the SVG viewBox to be mapped onto pdfDimensions
  //  so that snap coordinates are in the same PDF-pixel space as tempPoints.
  //  While pdfDimensions is null we pass a dummy 1×1 dims — useSvgSnapPoints
  //  will return empty arrays because all computed distances will be 0.
  const effectiveDims: PdfDimensions = pdfDimensions ?? { w: 1, h: 1 };

  const { snapPoints, svgCurves } = useSvgSnapPoints(
    svgText,        // null → hook returns [], safe
    effectiveDims,
    true,           // snapEnabled
  );

  // ── extractSvgLines is re-exported from SnapEnginePage / shared utils ─────
  //  We inline the import here so this hook has no dependency on the page file.
  //  If you already have extractSvgLines in a shared lib, import from there.
  const svgLines = useSvgLines(svgText, effectiveDims);

  if (!enabled || !pdfDimensions || !svgText) {
    return { ...EMPTY, isLoading, error };
  }

  return {
    svgSnapPoints: snapPoints,
    svgLines,
    svgCurves,
    isLoading,
    error,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  useSvgLines
//  Thin wrapper that memoises extractSvgLines so we don't re-parse on every
//  render.  extractSvgLines is the same function defined in SnapEnginePage —
//  move it to a shared util (e.g. lib/extractSvgLines.ts) and import from
//  there instead of duplicating it.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo }            from 'react';
import { extractSvgLines }    from '@/lib/svg/extractSvgLines'; // ← see extractSvgLines.ts

function useSvgLines(svgText: string | null, dims: PdfDimensions): SvgLine[] {
  return useMemo(() => {
    if (!svgText) return [];
    try { return extractSvgLines(svgText, dims.w, dims.h); }
    catch { return []; }
  }, [svgText, dims.w, dims.h]);
}

'use client';

import { useCallback, useRef, useState } from 'react';
import { usePdfFill, Fill, LoadStage, SelectRect, fmtArea, fmtPerim, hexToRgb, COLORS } from './usePdfFill';
import { useSvgFill, SvgShape, SvgOverlayFill } from './useSvgFill';

export type { Fill, LoadStage, SelectRect, SvgShape, SvgOverlayFill };
export { fmtArea, fmtPerim, hexToRgb, COLORS };

const EMPTY_SVG_SHAPES_REF = { current: [] as SvgShape[] };
const EMPTY_SVG_FILLS: SvgOverlayFill[] = [];

export function useFillState() {
  const pdf = usePdfFill();
  const svg = useSvgFill();

  const [isSvgMode, setIsSvgMode] = useState(false);

  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.name.toLowerCase().endsWith('.pdf')) {
      setIsSvgMode(false);
      await pdf.handleUpload(e);
    } else {
      setIsSvgMode(true);
      await svg.handleUpload(e);
    }
  }, [pdf, svg]);

  const active = isSvgMode ? svg : pdf;

  return {
    ...active,
    isSvgMode,
    handleUpload,
    // SVG-only fields — safe fallbacks when in PDF mode
    svgCanvasSize:   isSvgMode ? svg.svgCanvasSize   : { w: 0, h: 0 },
    svgOverlayFills: isSvgMode ? svg.svgOverlayFills : EMPTY_SVG_FILLS,
    svgFillsList:    isSvgMode ? svg.svgFillsList     : [],
    svgShapesRef:    isSvgMode ? svg.svgShapesRef     : EMPTY_SVG_SHAPES_REF,
    handleSvgExport: isSvgMode ? svg.handleSvgExport  : () => {},
  };
}
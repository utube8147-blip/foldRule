// hooks/useSnapEngine/detectExtractionMode.ts
import * as pdfjsLib from 'pdfjs-dist';

export type ExtractionMode = 'vector' | 'raster';

export interface DetectionResult {
  mode: ExtractionMode;
  /** Fraction of operators that are path/geometry ops — higher = more vector */
  vectorScore: number;
}

const VECTOR_OPS = new Set([
  pdfjsLib.OPS.moveTo,
  pdfjsLib.OPS.lineTo,
  pdfjsLib.OPS.curveTo,
  pdfjsLib.OPS.rectangle,
  pdfjsLib.OPS.stroke,
  pdfjsLib.OPS.fill,
  pdfjsLib.OPS.eoFill,
  pdfjsLib.OPS.fillStroke,
  pdfjsLib.OPS.setLineWidth,
  pdfjsLib.OPS.closePath,
]);

const RASTER_OPS = new Set([
  pdfjsLib.OPS.paintImageXObject,
  pdfjsLib.OPS.paintInlineImageXObject,
]);

export async function detectExtractionMode(
  page: pdfjsLib.PDFPageProxy,
): Promise<DetectionResult> {
  const opList = await page.getOperatorList();
  const { fnArray } = opList;

  let vectorCount = 0;
  let rasterCount = 0;

  for (const fn of fnArray) {
    if (VECTOR_OPS.has(fn)) vectorCount++;
    if (RASTER_OPS.has(fn)) rasterCount++;
  }

  const total = vectorCount + rasterCount;
  if (total === 0) return { mode: 'raster', vectorScore: 0 };

  const vectorScore = vectorCount / total;
  // If >20% of meaningful ops are vector geometry, treat as vector PDF
  return {
    mode: vectorScore > 0.2 ? 'vector' : 'raster',
    vectorScore,
  };
}
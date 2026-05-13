// hooks/useSnapEngine/drawWallsOnCanvas.ts
//
// Draws raw vector segments (RawSegment[]) onto a canvas overlay.
//
// FIX: dims parameter is now IGNORED for coordinate scaling.
//      We always use canvas.width / canvas.height (the canvas's own intrinsic
//      pixel size) so that the drawing coordinates match exactly what the PDF
//      render effect set them to — regardless of zoom level or React state
//      timing. Passing { w: canvas.width, h: canvas.height } or pdfDimensions
//      both work correctly now because we don't use the argument.
//
// IMPORTANT: This file was rewritten to match the new RawSegment type from
// extractPdfVectorData.ts. The old version drew AABBs (box corners nx0,ny0 →
// nx1,ny1). RawSegment also has nx0,ny0,nx1,ny1 but they are actual line
// ENDPOINTS, not box corners, so we draw ctx.lineTo() not ctx.rect().
//
// Rendering strategy:
//   • Each RawSegment is drawn as a line from (nx0,ny0) → (nx1,ny1)
//     scaled to canvas pixel dimensions.
//   • strokeWidth is used to bucket segments into thick (walls) vs thin
//     (annotation / dimension lines) so they can be styled differently.
//   • Curve segments (isCurve=true) are drawn in a slightly different color
//     so door swings / arcs are visually distinct from straight walls.
//   • All drawing is batched into a single beginPath() per style bucket
//     for performance on plans with thousands of segments.
// ─────────────────────────────────────────────────────────────────────────────

import type { RawSegment } from './extractPdfVectorData';

export interface DrawWallsOptions {
  /** Color for thick structural lines (strokeWidth ≥ thickThreshold) */
  wallColor?:       string;
  /** Color for thin annotation / dimension lines */
  thinColor?:       string;
  /** Color for curve segments (door swings, arcs) */
  curveColor?:      string;
  /** strokeWidth threshold (PDF points) above which a segment is "wall" */
  thickThreshold?:  number;
  /** Canvas line width for thick segments */
  wallLineWidth?:   number;
  /** Canvas line width for thin segments */
  thinLineWidth?:   number;
  /** Canvas line width for curve segments */
  curveLineWidth?:  number;
  /** If true, hide annotation/thin lines entirely */
  wallsOnly?:       boolean;
}

const DEFAULTS: Required<DrawWallsOptions> = {
  wallColor:      'rgba(59, 130, 246, 0.75)',   // blue-500
  thinColor:      'rgba(148, 163, 184, 0.35)',  // slate-400 faint
  curveColor:     'rgba(16, 185, 129, 0.70)',   // emerald-500 — door swings
  thickThreshold: 0.8,                           // PDF points — most wall lines ≥ 1pt
  wallLineWidth:  1.5,
  thinLineWidth:  0.5,
  curveLineWidth: 1.2,
  wallsOnly:      false,
};

export function drawWallsOnCanvas(
  canvas:   HTMLCanvasElement,
  segments: RawSegment[],
  // dims is kept for API compatibility but is NOT used for scaling.
  // We always derive W/H from canvas.width / canvas.height so that
  // this function is immune to React state timing races between
  // pdfDimensions updates and pdfRenderCount bumps.
  _dims:    { w: number; h: number },
  options:  DrawWallsOptions = {},
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!segments.length) return;

  const opt = { ...DEFAULTS, ...options };

  // ✅ FIX: always use the canvas's own pixel dimensions, not the dims arg.
  // The PDF render effect sets canvas.width/canvas.height to logVP dimensions
  // synchronously before awaiting task.promise, so by the time this runs
  // (after pdfRenderCount bumps) these values are always correct.
  const W = canvas.width;
  const H = canvas.height;

  console.log(
    `[drawWallsOnCanvas] canvas=${W}x${H} segments=${segments.length}`,
  );

  // ── Bucket segments by style ─────────────────────────────────────────────
  const thickLines:  RawSegment[] = [];
  const thinLines:   RawSegment[] = [];
  const curveLines:  RawSegment[] = [];

  for (const seg of segments) {
    if (seg.isCurve) {
      curveLines.push(seg);
    } else if (seg.strokeWidth >= opt.thickThreshold) {
      thickLines.push(seg);
    } else {
      thinLines.push(seg);
    }
  }

  // ── Draw helper: batch all segments in one path per style ────────────────
  function drawBatch(segs: RawSegment[], color: string, lineWidth: number) {
    if (!segs.length) return;
    ctx!.strokeStyle = color;
    ctx!.lineWidth   = lineWidth;
    ctx!.lineCap     = 'round';
    ctx!.beginPath();
    for (const seg of segs) {
      // nx/ny are normalised [0,1] — scale to canvas logical pixels
      ctx!.moveTo(seg.nx0 * W, seg.ny0 * H);
      ctx!.lineTo(seg.nx1 * W, seg.ny1 * H);
    }
    ctx!.stroke();
  }

  // ── Render order: thin behind thick behind curves ────────────────────────
  if (!opt.wallsOnly) {
    drawBatch(thinLines,  opt.thinColor,  opt.thinLineWidth);
  }
  drawBatch(thickLines,  opt.wallColor,  opt.wallLineWidth);
  drawBatch(curveLines,  opt.curveColor, opt.curveLineWidth);

  // ── Debug: log bucket counts ──────────────────────────────────────────────
  console.log(
    `[drawWallsOnCanvas] thick=${thickLines.length} thin=${thinLines.length} curves=${curveLines.length}`,
  );
}
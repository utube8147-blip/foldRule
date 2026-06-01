// hooks/useSnapEngine/drawAllVectorsOnCanvas.ts
//
// Draws every extracted vector element (paths + text runs) from
// ExtractAllVectorsResult onto a canvas overlay.
//
// Rendering layers (bottom → top within this canvas):
//   1. Filled polygons / rects  — semi-transparent fills
//   2. Stroked lines / polylines — full opacity strokes
//   3. Text runs                — labels at correct position + size
//
// All coordinates are normalised [0,1] — scaled to canvas.width/height.
// White / near-white elements were already filtered by extractAllVectors,
// so everything here is intentional drawn content.
// ─────────────────────────────────────────────────────────────────────────────

import type { ExtractAllVectorsResult, VectorPath, VectorTextRun } from './extractAllVectors';

export interface DrawAllVectorsOptions {
  /** Overall opacity multiplier for the whole overlay (default 1.0) */
  opacity?:          number;
  /** Stroke opacity override — useful to dim lines without hiding text */
  strokeOpacity?:    number;
  /** Fill opacity for filled shapes (default 0.08 — very subtle) */
  fillOpacity?:      number;
  /** Text opacity (default 1.0) */
  textOpacity?:      number;
  /** Min stroke width in canvas pixels; prevents hairlines from disappearing */
  minStrokeWidth?:   number;
  /** Hide filled shapes entirely (show only lines + text) */
  linesOnly?:        boolean;
  /** Hide text runs */
  hideText?:         boolean;
  /** Scale factor: multiply extracted strokeWidth by this for display */
  strokeScale?:      number;
}

const DEFAULTS: Required<DrawAllVectorsOptions> = {
  opacity:         1.0,
  strokeOpacity:   0.85,
  fillOpacity:     0.08,
  textOpacity:     1.0,
  minStrokeWidth:  0.5,
  linesOnly:       false,
  hideText:        false,
  strokeScale:     1.0,
};

// ─── Hex color → rgba string ──────────────────────────────────────────────────

function hexToRgba(hex: string, alpha: number): string {
  const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return `rgba(0,0,0,${alpha})`;
  return `rgba(${parseInt(m[1],16)},${parseInt(m[2],16)},${parseInt(m[3],16)},${alpha})`;
}

// ─── Draw a single path ───────────────────────────────────────────────────────

function drawPath(
  ctx:     CanvasRenderingContext2D,
  path:    VectorPath,
  W:       number,
  H:       number,
  opt:     Required<DrawAllVectorsOptions>,
  pass:    'fill' | 'stroke',
): void {
  if (path.points.length < 2) return;

  ctx.beginPath();
  ctx.moveTo(path.points[0].nx * W, path.points[0].ny * H);
  for (let i = 1; i < path.points.length; i++) {
    ctx.lineTo(path.points[i].nx * W, path.points[i].ny * H);
  }

  if (pass === 'fill' && path.isFilled && path.fillColor) {
    ctx.fillStyle = hexToRgba(path.fillColor, opt.fillOpacity * opt.opacity);
    ctx.fill();
  }

  if (pass === 'stroke' && path.isStroked && path.strokeColor) {
    const sw = Math.max(opt.minStrokeWidth, path.strokeWidth * opt.strokeScale);
    ctx.strokeStyle  = hexToRgba(path.strokeColor, opt.strokeOpacity * opt.opacity);
    ctx.lineWidth    = sw;
    ctx.lineCap      = 'round';
    ctx.lineJoin     = 'round';
    ctx.stroke();
  }
}

// ─── Main draw function ───────────────────────────────────────────────────────

export function drawAllVectorsOnCanvas(
  canvas:  HTMLCanvasElement,
  vectors: ExtractAllVectorsResult,
  options: DrawAllVectorsOptions = {},
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const opt = { ...DEFAULTS, ...options };

  // Use canvas intrinsic size (always correct — set by PDF render effect)
  const W = canvas.width;
  const H = canvas.height;

  if (!vectors.paths.length && !vectors.textRuns.length) return;

  ctx.save();

  // ── Pass 1: Filled shapes (bottom layer) ────────────────────────────────
  if (!opt.linesOnly) {
    for (const path of vectors.paths) {
      if (path.isFilled) drawPath(ctx, path, W, H, opt, 'fill');
    }
  }

  // ── Pass 2: Stroked lines / polylines (middle layer) ────────────────────
  for (const path of vectors.paths) {
    if (path.isStroked) drawPath(ctx, path, W, H, opt, 'stroke');
  }

  // ── Pass 3: Text runs (top layer) ────────────────────────────────────────
  if (!opt.hideText) {
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign    = 'left';

    for (const run of vectors.textRuns) {
      // Font size in canvas pixels: nFontSize is normalised to page height
      const fs = Math.max(6, run.nFontSize * H);
      ctx.font      = `${fs.toFixed(1)}px ${run.fontName !== 'unknown' ? `"${run.fontName}", ` : ''}monospace`;
      ctx.fillStyle = hexToRgba(run.color, opt.textOpacity * opt.opacity);
      ctx.fillText(run.text, run.nx * W, run.ny * H);
    }
  }

  ctx.restore();

  console.log(
    `[drawAllVectorsOnCanvas] ${vectors.paths.length} paths, ` +
    `${vectors.textRuns.length} text runs → ${W}x${H} canvas`,
  );
}
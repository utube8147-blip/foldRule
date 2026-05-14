// ─── drawSvgAreaCanvas.ts ──────────────────────────────────────────────────────
// Extracted canvas-drawing logic for SVG areas (rooms, pillars, windows, doors).
// Previously inlined inside ViewerCanvas.tsx.
//
// Import and call drawSvgAreaCanvas() from ViewerCanvas useEffect — no other
// changes needed in ViewerCanvas.
// ─────────────────────────────────────────────────────────────────────────────

import type { SvgArea }     from '@/hooks/useSvgInteraction';
import type { PdfDimensions } from '@/types/viewerTypes';
import {
  isSvgDoor, isSvgPillar, isSvgWindow, isSvgStructural,
  getRoomCategory, CATEGORY_COLORS,
} from '../lib/svgLabelUtils';

// ── roundRect polyfill ────────────────────────────────────────────────────────

function ensureRoundRect() {
  if (
    typeof CanvasRenderingContext2D !== 'undefined' &&
    !(CanvasRenderingContext2D.prototype as any).roundRect
  ) {
    (CanvasRenderingContext2D.prototype as any).roundRect = function (
      x: number, y: number, w: number, h: number, r: number,
    ) {
      if (w < 2 * r) r = w / 2;
      if (h < 2 * r) r = h / 2;
      this.moveTo(x + r, y);
      this.lineTo(x + w - r, y);
      this.quadraticCurveTo(x + w, y, x + w, y + r);
      this.lineTo(x + w, y + h - r);
      this.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      this.lineTo(x + r, y + h);
      this.quadraticCurveTo(x, y + h, x, y + h - r);
      this.lineTo(x, y + r);
      this.quadraticCurveTo(x, y, x + r, y);
      return this;
    };
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function resizeCanvas(canvas: HTMLCanvasElement, w: number, h: number) {
  canvas.width  = w; canvas.height = h;
  canvas.style.width  = `${w}px`;
  canvas.style.height = `${h}px`;
}

/** Trace a polygon path from normalized points onto ctx (does NOT fill/stroke). */
function tracePolygon(
  ctx: CanvasRenderingContext2D,
  points: Array<{ nx: number; ny: number }>,
  w: number,
  h: number,
) {
  ctx.beginPath();
  ctx.moveTo(points[0].nx * w, points[0].ny * h);
  for (let i = 1; i < points.length; i++)
    ctx.lineTo(points[i].nx * w, points[i].ny * h);
  ctx.closePath();
}

/** Compute pixel centroid from normalized points. */
function centroid(
  points: Array<{ nx: number; ny: number }>,
  w: number,
  h: number,
): { cx: number; cy: number } {
  let cx = 0, cy = 0;
  for (const p of points) { cx += p.nx * w; cy += p.ny * h; }
  return { cx: cx / points.length, cy: cy / points.length };
}

// ── Pass renderers ────────────────────────────────────────────────────────────

function drawRooms(
  ctx: CanvasRenderingContext2D,
  areas: SvgArea[],
  w: number,
  h: number,
) {
  for (const area of areas) {
    if (isSvgStructural(area) || area.points.length < 3) continue;

    const colors = CATEGORY_COLORS[getRoomCategory(area.label ?? '')] ?? CATEGORY_COLORS.default;

    tracePolygon(ctx, area.points, w, h);
    ctx.fillStyle   = colors.fill;
    ctx.fill();
    ctx.strokeStyle = colors.stroke;
    ctx.lineWidth   = 1.5;
    ctx.stroke();
  }
}

function drawPillars(
  ctx: CanvasRenderingContext2D,
  areas: SvgArea[],
  w: number,
  h: number,
) {
  for (const area of areas) {
    if (!isSvgPillar(area) || area.points.length < 3) continue;

    tracePolygon(ctx, area.points, w, h);
    ctx.fillStyle   = 'rgba(120,53,15,0.35)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(245,158,11,0.90)';
    ctx.lineWidth   = 2.5;
    ctx.stroke();

    const { cx, cy } = centroid(area.points, w, h);

    // Badge circle
    ctx.beginPath();
    ctx.arc(cx, cy, 12, 0, Math.PI * 2);
    ctx.fillStyle   = 'rgba(120,53,15,0.85)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(245,158,11,0.95)';
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    // 'P' label
    ctx.fillStyle     = '#fbbf24';
    ctx.font          = 'bold 11px monospace';
    ctx.textAlign     = 'center';
    ctx.textBaseline  = 'middle';
    ctx.fillText('P', cx, cy);

    // Sub-label
    ctx.font      = '9px monospace';
    ctx.fillStyle = 'rgba(245,158,11,0.9)';
    ctx.fillText('pillar', cx, cy + 18);
  }
}

function drawWindows(
  ctx: CanvasRenderingContext2D,
  areas: SvgArea[],
  w: number,
  h: number,
) {
  for (const area of areas) {
    if (!isSvgWindow(area) || area.points.length < 3) continue;

    tracePolygon(ctx, area.points, w, h);
    ctx.fillStyle   = 'rgba(6,182,212,0.15)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(6,182,212,0.80)';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([8, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    const { cx, cy } = centroid(area.points, w, h);

    // Badge rect
    ctx.beginPath();
    ctx.rect(cx - 10, cy - 8, 20, 16);
    ctx.fillStyle   = 'rgba(6,182,212,0.25)';
    ctx.fill();
    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    // 'W' label
    ctx.fillStyle    = '#06b6d4';
    ctx.font         = 'bold 10px monospace';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('W', cx, cy);

    // Sub-label
    ctx.font      = '8px monospace';
    ctx.fillStyle = 'rgba(6,182,212,0.8)';
    ctx.fillText('window', cx, cy + 14);
  }
}

function drawDoors(
  ctx: CanvasRenderingContext2D,
  areas: SvgArea[],
  w: number,
  h: number,
) {
  for (const area of areas) {
    if (!isSvgDoor(area) || area.points.length < 3) continue;

    // area.points layout: [pivot, ...arcPts]
    const pivot   = area.points[0];
    const arcPts  = area.points.slice(1);
    if (arcPts.length < 2) continue;

    const pivotPx    = { x: pivot.nx   * w, y: pivot.ny   * h };
    const arcPxPts   = arcPts.map(p => ({ x: p.nx * w, y: p.ny * h }));
    const arcStartPx = arcPxPts[0];

    // Filled pie slice
    ctx.beginPath();
    ctx.moveTo(pivotPx.x, pivotPx.y);
    for (const p of arcPxPts) ctx.lineTo(p.x, p.y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(34,197,94,0.18)';
    ctx.fill();

    // Door leaf
    ctx.beginPath();
    ctx.moveTo(pivotPx.x, pivotPx.y);
    ctx.lineTo(arcStartPx.x, arcStartPx.y);
    ctx.strokeStyle = 'rgba(34,197,94,0.90)';
    ctx.lineWidth   = 2;
    ctx.setLineDash([]);
    ctx.stroke();

    // Swing arc polyline (dashed)
    ctx.beginPath();
    ctx.moveTo(arcPxPts[0].x, arcPxPts[0].y);
    for (let i = 1; i < arcPxPts.length; i++) ctx.lineTo(arcPxPts[i].x, arcPxPts[i].y);
    ctx.strokeStyle = 'rgba(34,197,94,0.70)';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([5, 5]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Badge at arc midpoint
    const mid = arcPxPts[Math.floor(arcPxPts.length / 2)];
    ctx.beginPath();
    ctx.arc(mid.x, mid.y, 10, 0, Math.PI * 2);
    ctx.fillStyle   = 'rgba(34,197,94,0.75)';
    ctx.fill();
    ctx.strokeStyle = 'white';
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    ctx.fillStyle    = 'white';
    ctx.font         = 'bold 12px monospace';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🚪', mid.x, mid.y);

    ctx.font      = '8px monospace';
    ctx.fillStyle = 'rgba(34,197,94,0.9)';
    ctx.fillText('door', mid.x, mid.y + 14);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Render all SVG areas onto `canvas` in the correct layer order:
 *   1. Room fills (category-coloured)
 *   2. Pillars  (amber, 'P' badge)
 *   3. Windows  (cyan dashed, 'W' badge)
 *   4. Doors    (green swing arc, door emoji) — only when showSvgOverlay=true
 */
export function drawSvgAreaCanvas(
  canvas: HTMLCanvasElement,
  areas: SvgArea[],
  pdfDimensions: PdfDimensions,
  showSvgOverlay: boolean,
) {
  ensureRoundRect();

  const { w, h } = pdfDimensions;
  resizeCanvas(canvas, w, h);

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);

  drawRooms(ctx, areas, w, h);
//   drawPillars(ctx, areas, w, h);
  drawWindows(ctx, areas, w, h);
  if (showSvgOverlay) drawDoors(ctx, areas, w, h);
}

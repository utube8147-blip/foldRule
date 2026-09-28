'use client';

// hooks/drawClusterCanvas.ts
//
// Draws one bounding box per INSTANCE of each cluster.
// When selectedClusterId is set:
//   • Selected cluster instances → bright solid border + stronger fill
//   • All other clusters         → dimmed to 15% opacity (emphasis by contrast)

import type { ShapeCluster } from '@/hooks/detection/useShapeCluster';
import type { PdfDimensions } from '@/types/viewerTypes';

// ─── Colour palette ───────────────────────────────────────────────────────────

interface ClusterColour {
  stroke:       string;
  fill:         string;
  fillSelected: string;
  text:         string;
  textBg:       string;
}

const LABEL_COLOURS: Record<string, ClusterColour> = {
  Pillar:    { stroke: '#f59e0b', fill: 'rgba(245,158,11,0.10)',  fillSelected: 'rgba(245,158,11,0.22)', text: '#000', textBg: '#f59e0b' },
  Window:    { stroke: '#38bdf8', fill: 'rgba(56,189,248,0.10)',  fillSelected: 'rgba(56,189,248,0.22)', text: '#000', textBg: '#38bdf8' },
  Door:      { stroke: '#34d399', fill: 'rgba(52,211,153,0.10)',  fillSelected: 'rgba(52,211,153,0.22)', text: '#000', textBg: '#34d399' },
  Toilet:    { stroke: '#a78bfa', fill: 'rgba(167,139,250,0.10)', fillSelected: 'rgba(167,139,250,0.22)', text: '#000', textBg: '#a78bfa' },
  Basin:     { stroke: '#c084fc', fill: 'rgba(192,132,252,0.10)', fillSelected: 'rgba(192,132,252,0.22)', text: '#000', textBg: '#c084fc' },
  Bath:      { stroke: '#818cf8', fill: 'rgba(129,140,248,0.10)', fillSelected: 'rgba(129,140,248,0.22)', text: '#000', textBg: '#818cf8' },
  Sanitary:  { stroke: '#a78bfa', fill: 'rgba(167,139,250,0.10)', fillSelected: 'rgba(167,139,250,0.22)', text: '#000', textBg: '#a78bfa' },
  Fixture:   { stroke: '#fb923c', fill: 'rgba(251,146,60,0.10)',  fillSelected: 'rgba(251,146,60,0.22)',  text: '#000', textBg: '#fb923c' },
  Furniture: { stroke: '#4ade80', fill: 'rgba(74,222,128,0.10)',  fillSelected: 'rgba(74,222,128,0.22)',  text: '#000', textBg: '#4ade80' },
  Chair:     { stroke: '#86efac', fill: 'rgba(134,239,172,0.10)', fillSelected: 'rgba(134,239,172,0.22)', text: '#000', textBg: '#86efac' },
  Urinal:    { stroke: '#e879f9', fill: 'rgba(232,121,249,0.10)', fillSelected: 'rgba(232,121,249,0.22)', text: '#000', textBg: '#e879f9' },
  Shower:    { stroke: '#67e8f9', fill: 'rgba(103,232,249,0.10)', fillSelected: 'rgba(103,232,249,0.22)', text: '#000', textBg: '#67e8f9' },
  Symbol:    { stroke: '#94a3b8', fill: 'rgba(148,163,184,0.08)', fillSelected: 'rgba(148,163,184,0.18)', text: '#000', textBg: '#94a3b8' },
};

const DEFAULT_COLOUR: ClusterColour = {
  stroke: '#94a3b8', fill: 'rgba(148,163,184,0.08)',
  fillSelected: 'rgba(148,163,184,0.18)', text: '#000', textBg: '#94a3b8',
};

function colourFor(label: string): ClusterColour {
  return LABEL_COLOURS[label] ?? DEFAULT_COLOUR;
}

// ─── roundRect polyfill ───────────────────────────────────────────────────────

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  if ((ctx as any).roundRect) {
    (ctx as any).roundRect(x, y, w, h, r);
  } else {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
}

// ─── Main draw function ───────────────────────────────────────────────────────

export function drawClusterCanvas(
  canvas:            HTMLCanvasElement,
  clusters:          ShapeCluster[],
  pdfDimensions:     PdfDimensions,
  show:              boolean,
  selectedClusterId: string | null = null,
): void {
  const { w, h } = pdfDimensions;
  canvas.width        = w;
  canvas.height       = h;
  canvas.style.width  = `${w}px`;
  canvas.style.height = `${h}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  if (!show || clusters.length === 0) return;

  const hasSelection = selectedClusterId !== null;

  for (const cluster of clusters) {
    const isSelected = cluster.id === selectedClusterId;
    const col        = colourFor(cluster.label);

    // When something else is selected, dim this cluster heavily
    const globalAlpha = hasSelection && !isSelected ? 0.12 : 1.0;
    ctx.globalAlpha   = globalAlpha;

    const instances = cluster.instanceBounds ?? [cluster.repBounds];

    for (let i = 0; i < instances.length; i++) {
      const b  = instances[i];
      const x  = b.minNX * w;
      const y  = b.minNY * h;
      const bw = (b.maxNX - b.minNX) * w;
      const bh = (b.maxNY - b.minNY) * h;

      // Fill
      ctx.fillStyle = isSelected ? col.fillSelected : col.fill;
      ctx.beginPath();
      roundRect(ctx, x, y, bw, bh, 3);
      ctx.fill();

      // Border
      ctx.strokeStyle = col.stroke;
      ctx.lineWidth   = isSelected ? 2.0 : 1.5;
      if (!isSelected) ctx.setLineDash([4, 3]);
      ctx.beginPath();
      roundRect(ctx, x, y, bw, bh, 3);
      ctx.stroke();
      ctx.setLineDash([]);

      // Glow on selected instances
      if (isSelected) {
        ctx.save();
        ctx.strokeStyle = col.stroke;
        ctx.lineWidth   = 6;
        ctx.globalAlpha = 0.18;
        ctx.beginPath();
        roundRect(ctx, x - 2, y - 2, bw + 4, bh + 4, 4);
        ctx.stroke();
        ctx.restore();
        ctx.globalAlpha = globalAlpha; // restore
      }

      // Badge on first instance only
      if (i === 0) {
        drawBadge(ctx, cluster.label, cluster.count, x, y, col, isSelected);
      }
    }
  }

  ctx.globalAlpha = 1;
}

// ─── Badge drawing ────────────────────────────────────────────────────────────

function drawBadge(
  ctx:        CanvasRenderingContext2D,
  label:      string,
  count:      number,
  x:          number,
  y:          number,
  col:        ClusterColour,
  selected:   boolean,
) {
  const text   = `${label} ×${count}`;
  const font   = `bold ${selected ? 11 : 10}px ui-monospace,SFMono-Regular,Menlo,monospace`;
  ctx.font     = font;
  const tw     = ctx.measureText(text).width;
  const padX   = 6, padY = 3;
  const badgeW = tw + padX * 2;
  const badgeH = (selected ? 11 : 10) + padY * 2;
  const bx     = x;
  const by     = Math.max(0, y - badgeH - 2);

  // Shadow for selected
  if (selected) {
    ctx.save();
    ctx.shadowColor  = col.stroke;
    ctx.shadowBlur   = 8;
    ctx.fillStyle    = col.textBg;
    ctx.beginPath();
    roundRect(ctx, bx, by, badgeW, badgeH, 3);
    ctx.fill();
    ctx.restore();
  } else {
    ctx.fillStyle = col.textBg;
    ctx.beginPath();
    roundRect(ctx, bx, by, badgeW, badgeH, 3);
    ctx.fill();
  }

  ctx.fillStyle    = col.text;
  ctx.font         = font;
  ctx.textBaseline = 'top';
  ctx.textAlign    = 'left';
  ctx.fillText(text, bx + padX, by + padY);
}

// ─── Hit testing — returns clusterId if click lands on any instance bbox ──────

export function hitTestClusters(
  nx:            number,    // normalised click x (0–1)
  ny:            number,    // normalised click y (0–1)
  clusters:      ShapeCluster[],
): string | null {
  // Test in reverse order so top-rendered clusters are hit first
  for (let ci = clusters.length - 1; ci >= 0; ci--) {
    const c = clusters[ci];
    for (const b of c.instanceBounds) {
      if (nx >= b.minNX && nx <= b.maxNX && ny >= b.minNY && ny <= b.maxNY) {
        return c.id;
      }
    }
  }
  return null;
}

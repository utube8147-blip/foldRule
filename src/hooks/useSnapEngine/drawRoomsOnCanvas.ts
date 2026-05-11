// hooks/useSnapEngine/drawRoomsOnCanvas.ts
//
// Uses plain rgba fills with built-in alpha — no mix-blend-multiply needed.
// This avoids the compositing layer that can blank the PDF canvas in some browsers.

import type { DetectedRoom } from './detectRooms';

const ROOM_COLORS = [
  { fill: 'rgba(59,130,246,0.13)',  stroke: 'rgba(59,130,246,0.55)',  text: 'rgba(29,78,216,0.9)'   },
  { fill: 'rgba(16,185,129,0.13)', stroke: 'rgba(16,185,129,0.55)', text: 'rgba(6,95,70,0.9)'      },
  { fill: 'rgba(245,158,11,0.13)', stroke: 'rgba(245,158,11,0.55)', text: 'rgba(120,53,15,0.9)'    },
  { fill: 'rgba(139,92,246,0.13)', stroke: 'rgba(139,92,246,0.55)', text: 'rgba(76,29,149,0.9)'    },
  { fill: 'rgba(236,72,153,0.13)', stroke: 'rgba(236,72,153,0.55)', text: 'rgba(131,24,67,0.9)'    },
  { fill: 'rgba(20,184,166,0.13)', stroke: 'rgba(20,184,166,0.55)', text: 'rgba(19,78,74,0.9)'     },
  { fill: 'rgba(249,115,22,0.13)', stroke: 'rgba(249,115,22,0.55)', text: 'rgba(124,45,18,0.9)'    },
  { fill: 'rgba(168,85,247,0.13)', stroke: 'rgba(168,85,247,0.55)', text: 'rgba(88,28,135,0.9)'    },
];

export function drawRoomsOnCanvas(
  canvas:  HTMLCanvasElement,
  rooms:   DetectedRoom[],
  dims:    { w: number; h: number },
  hoverId: string | null = null,
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Full clear — no compositing artefacts
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!rooms.length) return;

  rooms.forEach((room, i) => {
    const pal     = ROOM_COLORS[i % ROOM_COLORS.length];
    const isHover = room.id === hoverId;
    const pts     = room.polygon.map(p => ({
      x: p.nx * dims.w,
      y: p.ny * dims.h,
    }));
    if (pts.length < 3) return;

    // ── Fill ──────────────────────────────────────────────────────────────
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
    ctx.closePath();
    ctx.fillStyle = isHover
      ? pal.fill.replace('0.13', '0.28')
      : pal.fill;
    ctx.fill();

    // ── Stroke ────────────────────────────────────────────────────────────
    ctx.strokeStyle = pal.stroke;
    ctx.lineWidth   = isHover ? 2 : 1.5;
    ctx.setLineDash(isHover ? [] : [6, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    // ── Label ─────────────────────────────────────────────────────────────
    const cx = room.centroid.nx * dims.w;
    const cy = room.centroid.ny * dims.h;

    // Label background pill
    const labelText = room.label.toUpperCase();
    ctx.font = `${isHover ? 500 : 400} ${isHover ? 12 : 11}px ui-monospace,monospace`;
    const tw = ctx.measureText(labelText).width;
    const ph = 18, pw = tw + 14;

    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.roundRect(cx - pw / 2, cy - ph / 2 - 6, pw, ph, 3);
    ctx.fill();

    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(labelText, cx, cy - 6);

    // Area sub-label (small, below)
    if (room.areaNorm > 0.005) {
      const areaText = `${(room.areaNorm * 100).toFixed(1)}%`;
      ctx.font      = '400 9px ui-monospace,monospace';
      ctx.fillStyle = pal.text;
      ctx.fillText(areaText, cx, cy + 10);
    }
  });
}
// hooks/useSnapEngine/drawRoomsOnCanvas.ts

import type { DetectedRoom } from './detectRooms';

// Element-specific colors
const ELEMENT_COLORS: Record<string, { fill: string; stroke: string; text: string }> = {
  WINDOW: {
    fill: 'rgba(59,130,246,0.15)',   // Blue tint
    stroke: 'rgba(59,130,246,0.7)',
    text: 'rgba(29,78,216,0.95)'
  },
  WALL: {
    fill: 'rgba(107,114,128,0.15)',  // Gray tint
    stroke: 'rgba(107,114,128,0.7)',
    text: 'rgba(55,65,81,0.95)'
  },
  DOOR: {
    fill: 'rgba(16,185,129,0.15)',   // Green tint
    stroke: 'rgba(16,185,129,0.7)',
    text: 'rgba(6,95,70,0.95)'
  },
  ROOM: {
    fill: 'rgba(245,158,11,0.15)',   // Orange tint
    stroke: 'rgba(245,158,11,0.7)',
    text: 'rgba(120,53,15,0.95)'
  },
  KITCHEN: {
    fill: 'rgba(236,72,153,0.15)',   // Pink tint
    stroke: 'rgba(236,72,153,0.7)',
    text: 'rgba(131,24,67,0.95)'
  },
  BEDROOM: {
    fill: 'rgba(139,92,246,0.15)',   // Purple tint
    stroke: 'rgba(139,92,246,0.7)',
    text: 'rgba(76,29,149,0.95)'
  },
  BATHROOM: {
    fill: 'rgba(20,184,166,0.15)',   // Teal tint
    stroke: 'rgba(20,184,166,0.7)',
    text: 'rgba(19,78,74,0.95)'
  },
  LIVING: {
    fill: 'rgba(249,115,22,0.15)',   // Amber tint
    stroke: 'rgba(249,115,22,0.7)',
    text: 'rgba(124,45,18,0.95)'
  },
  // Default for any other element type
  DEFAULT: {
    fill: 'rgba(156,163,175,0.15)',  // Light gray
    stroke: 'rgba(156,163,175,0.7)',
    text: 'rgba(75,85,99,0.95)'
  }
};

function getElementColor(label: string) {
  const upperLabel = label.toUpperCase();
  
  // Check for exact match
  if (ELEMENT_COLORS[upperLabel]) {
    return ELEMENT_COLORS[upperLabel];
  }
  
  // Check for partial matches (e.g., "WINDOW-1" should match "WINDOW")
  for (const [key, color] of Object.entries(ELEMENT_COLORS)) {
    if (upperLabel.includes(key)) {
      return color;
    }
  }
  
  // Return default if no match found
  return ELEMENT_COLORS.DEFAULT;
}

export function drawRoomsOnCanvas(
  canvas: HTMLCanvasElement,
  rooms: DetectedRoom[],
  dims: { w: number; h: number },
  hoverId: string | null = null,
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Full clear
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!rooms.length) return;

  rooms.forEach((room) => {
    const isHover = room.id === hoverId;
    const colors = getElementColor(room.label);
    
    const pts = room.polygon.map(p => ({
      x: p.nx * dims.w,
      y: p.ny * dims.h,
    }));
    
    if (pts.length < 3) return;

    // ── Fill ──────────────────────────────────────────────────────────────
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
    ctx.closePath();
    
    // Use brighter fill on hover
    ctx.fillStyle = isHover
      ? colors.fill.replace('0.15', '0.3')
      : colors.fill;
    ctx.fill();

    // ── Stroke ────────────────────────────────────────────────────────────
    ctx.strokeStyle = colors.stroke;
    ctx.lineWidth = isHover ? 2.5 : 1.5;
    ctx.setLineDash(isHover ? [] : [6, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    // ── Label Background Pill ─────────────────────────────────────────────
    const cx = room.centroid.nx * dims.w;
    const cy = room.centroid.ny * dims.h;

    const labelText = room.label;
    ctx.font = `${isHover ? 600 : 500} ${isHover ? 12 : 11}px ui-monospace,monospace`;
    const tw = ctx.measureText(labelText).width;
    const ph = 18, pw = tw + 12;

    // Background with element-specific color
    ctx.fillStyle = colors.text.replace('0.95', '0.85');
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(cx - pw / 2, cy - ph / 2 - 8, pw, ph, 4);
    } else {
      ctx.rect(cx - pw / 2, cy - ph / 2 - 8, pw, ph);
    }
    ctx.fill();

    // Label text
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(labelText, cx, cy - 8);

    // ── Type indicator (small dot or icon) ─────────────────────────────────
    const typeIndicator = room.label.charAt(0);
    ctx.font = 'bold 8px monospace';
    ctx.fillStyle = colors.stroke;
    ctx.fillText(typeIndicator, cx - pw / 2 + 8, cy - 8);

    // ── Confidence / Area (if available) ──────────────────────────────────
    if (room.areaNorm > 0.005) {
      const areaPercent = `${(room.areaNorm * 100).toFixed(0)}%`;
      ctx.font = '400 9px ui-monospace,monospace';
      ctx.fillStyle = colors.text;
      ctx.fillText(areaPercent, cx, cy + 10);
    }
  });
}

// Add roundRect if it doesn't exist
if (!(CanvasRenderingContext2D.prototype as any).roundRect) {
  (CanvasRenderingContext2D.prototype as any).roundRect = function(x: number, y: number, w: number, h: number, r: number) {
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
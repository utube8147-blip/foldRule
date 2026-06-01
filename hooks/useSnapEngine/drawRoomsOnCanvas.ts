// hooks/useSnapEngine/drawRoomsOnCanvas.ts

import type { DetectedRoom } from './detectRooms';

type DetectedRoomWithArea = DetectedRoom & { areaSqM?: number | null };

// ─── Room category mapping ──────────────────────────────────────────────────
// Define which category each room type belongs to
const ROOM_CATEGORY: Record<string, string> = {
  // Office spaces
  OFFICE: 'office',
  DIRECTOR: 'office',
  STUDY: 'office',
  PRIVATE_OFFICE: 'office',
  DESK: 'office',
  CUBICLE: 'office',
  
  // Meeting spaces
  MEETING: 'meeting',
  BOARDROOM: 'meeting',
  CONFERENCE: 'meeting',
  BREAKOUT: 'meeting',
  TRAINING: 'meeting',
  SEMINAR: 'meeting',
  
  // Circulation
  CORRIDOR: 'circulation',
  HALLWAY: 'circulation',
  HALL: 'circulation',
  LOBBY: 'circulation',
  FOYER: 'circulation',
  ENTRANCE: 'circulation',
  ENTRY: 'circulation',
  RECEPTION: 'circulation',
  STAIRS: 'circulation',
  STAIRWELL: 'circulation',
  STAIRCASE: 'circulation',
  LIFT: 'circulation',
  ELEVATOR: 'circulation',
  PASSAGE: 'circulation',
  
  // Wet areas
  KITCHEN: 'wet',
  KITCHENETTE: 'wet',
  BREAKROOM: 'wet',
  BREAK_ROOM: 'wet',
  PANTRY: 'wet',
  CANTEEN: 'wet',
  CAFETERIA: 'wet',
  BATHROOM: 'wet',
  WC: 'wet',
  TOILET: 'wet',
  RESTROOM: 'wet',
  SHOWER: 'wet',
  LAUNDRY: 'wet',
  LOCKER: 'wet',
  CHANGING: 'wet',
  
  // Storage/Utility
  STORAGE: 'utility',
  STORE: 'utility',
  STOREROOM: 'utility',
  ARCHIVE: 'utility',
  ARCHIVES: 'utility',
  PLANT: 'utility',
  PLANT_ROOM: 'utility',
  UTILITY: 'utility',
  UTILITY_ROOM: 'utility',
  ELECTRICAL: 'utility',
  SWITCH_ROOM: 'utility',
  SERVER: 'utility',
  SERVER_ROOM: 'utility',
  COMMS: 'utility',
  IT_ROOM: 'utility',
  DATA_ROOM: 'utility',
  MAIL_ROOM: 'utility',
  PRINT_ROOM: 'utility',
  COPY_ROOM: 'utility',
  
  // Living spaces
  BEDROOM: 'living',
  BED: 'living',
  LIVING: 'living',
  LIVING_ROOM: 'living',
  LOUNGE: 'living',
  DINING: 'living',
  DINING_ROOM: 'living',
  FAMILY: 'living',
  FAMILY_ROOM: 'living',
  STUDY_ROOM: 'living',
  
  // Outdoor
  BALCONY: 'outdoor',
  PATIO: 'outdoor',
  TERRACE: 'outdoor',
  GARDEN: 'outdoor',
  YARD: 'outdoor',
  GARAGE: 'outdoor',
  CARPARK: 'outdoor',
  PARKING: 'outdoor',
  CAR_PARK: 'outdoor',
  
  // Open plan
  OPEN_PLAN: 'open',
  OPEN_OFFICE: 'open',
  WORKSPACE: 'open',
  COWORKING: 'open',
  
  // Medical/Healthcare
  EXAM: 'medical',
  EXAMINATION: 'medical',
  CONSULTATION: 'medical',
  TREATMENT: 'medical',
  PATIENT: 'medical',
  NURSES: 'medical',
  DOCTOR: 'office',
  DENTAL: 'medical',
  PHARMACY: 'retail',
  
  // Retail
  RETAIL: 'retail',
  SHOP: 'retail',
  DISPLAY: 'retail',
  SALES: 'retail',
  SHOWROOM: 'retail',
};

// Category color palette - visually distinct for each category
const CATEGORY_COLORS: Record<string, { fill: string; stroke: string; pill: string; text: string }> = {
  office: {
    fill: 'rgba(59,130,246,0.18)',   // blue
    stroke: 'rgba(59,130,246,0.80)',
    pill: 'rgba(29,78,216,0.90)',
    text: '#ffffff',
  },
  meeting: {
    fill: 'rgba(139,92,246,0.18)',   // purple
    stroke: 'rgba(139,92,246,0.80)',
    pill: 'rgba(76,29,149,0.90)',
    text: '#ffffff',
  },
  circulation: {
    fill: 'rgba(245,158,11,0.18)',   // amber/orange
    stroke: 'rgba(245,158,11,0.80)',
    pill: 'rgba(120,53,15,0.90)',
    text: '#ffffff',
  },
  wet: {
    fill: 'rgba(20,184,166,0.18)',   // teal
    stroke: 'rgba(20,184,166,0.80)',
    pill: 'rgba(15,118,110,0.90)',
    text: '#ffffff',
  },
  utility: {
    fill: 'rgba(244,63,94,0.18)',    // rose/red
    stroke: 'rgba(244,63,94,0.80)',
    pill: 'rgba(136,19,55,0.90)',
    text: '#ffffff',
  },
  living: {
    fill: 'rgba(34,197,94,0.18)',    // green
    stroke: 'rgba(34,197,94,0.80)',
    pill: 'rgba(20,83,45,0.90)',
    text: '#ffffff',
  },
  outdoor: {
    fill: 'rgba(168,162,158,0.18)',  // cool gray
    stroke: 'rgba(168,162,158,0.80)',
    pill: 'rgba(87,83,78,0.90)',
    text: '#ffffff',
  },
  open: {
    fill: 'rgba(99,102,241,0.18)',   // indigo
    stroke: 'rgba(99,102,241,0.80)',
    pill: 'rgba(49,46,129,0.90)',
    text: '#ffffff',
  },
  medical: {
    fill: 'rgba(236,72,153,0.18)',   // pink
    stroke: 'rgba(236,72,153,0.80)',
    pill: 'rgba(157,23,77,0.90)',
    text: '#ffffff',
  },
  retail: {
    fill: 'rgba(251,191,36,0.18)',   // yellow/amber
    stroke: 'rgba(251,191,36,0.80)',
    pill: 'rgba(146,64,14,0.90)',
    text: '#ffffff',
  },
  // Default fallback
  default: {
    fill: 'rgba(156,163,175,0.18)',  // gray
    stroke: 'rgba(156,163,175,0.80)',
    pill: 'rgba(75,85,99,0.90)',
    text: '#ffffff',
  },
};

function getRoomCategory(label: string): string {
  if (!label) return 'default';
  
  const up = label.toUpperCase().trim();
  
  // Exact match first
  if (ROOM_CATEGORY[up]) return ROOM_CATEGORY[up];
  
  // Check prefix matches (e.g., "MEETING ROOM 1" starts with "MEETING")
  for (const [key, category] of Object.entries(ROOM_CATEGORY)) {
    if (up === key) return category;
  }
  
  // Check starts with
  for (const [key, category] of Object.entries(ROOM_CATEGORY)) {
    if (up.startsWith(key) || up.startsWith(key + ' ') || up.startsWith(key + '/')) {
      return category;
    }
  }
  
  // Check contains
  for (const [key, category] of Object.entries(ROOM_CATEGORY)) {
    if (up.includes(key)) return category;
  }
  
  return 'default';
}

function getRoomColor(label: string) {
  const category = getRoomCategory(label);
  return CATEGORY_COLORS[category] || CATEGORY_COLORS.default;
}

// ─── roundRect polyfill ───────────────────────────────────────────────────────
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

// ─── Geometry helpers ─────────────────────────────────────────────────────────
function polygonCentroid(pts: Array<{ x: number; y: number }>): { x: number; y: number } {
  let area = 0, cx = 0, cy = 0;
  const n = pts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const cross = pts[j].x * pts[i].y - pts[i].x * pts[j].y;
    area += cross;
    cx += (pts[j].x + pts[i].x) * cross;
    cy += (pts[j].y + pts[i].y) * cross;
  }
  area *= 0.5;
  if (Math.abs(area) < 1e-6) {
    return {
      x: pts.reduce((s, p) => s + p.x, 0) / n,
      y: pts.reduce((s, p) => s + p.y, 0) / n,
    };
  }
  const inv6A = 1 / (6 * area);
  return { x: cx * inv6A, y: cy * inv6A };
}

// ─── Source dot colours ───────────────────────────────────────────────────────
const SOURCE_DOT: Record<string, string> = {
  cubicasa:               'rgba(107,114,128,0.9)',
  'room-model':           'rgba(59,130,246,0.9)',
  'room-model+ocr':       'rgba(16,185,129,0.9)',
  'room-model+heuristic': 'rgba(245,158,11,0.9)',
  workflow:               'rgba(99,102,241,0.9)',
  vector:                 'rgba(6,182,212,0.9)',
  inferred:               'rgba(245,158,11,0.9)',
};

function sourceDot(source: string | undefined): string {
  if (!source) return SOURCE_DOT.inferred;
  if (SOURCE_DOT[source]) return SOURCE_DOT[source];
  for (const [k, v] of Object.entries(SOURCE_DOT)) if (source.startsWith(k)) return v;
  return SOURCE_DOT.inferred;
}

// ─── Pill drawing ─────────────────────────────────────────────────────────────
interface PillResult { pillW: number; pillH: number; pillTop: number; pillRight: number }

function drawPill(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  bgColor: string,
  fontSize = 11,
): PillResult {
  const PILL_H   = 20;
  const PAD_X    = 14;
  const MIN_W    = 48;

  ctx.font = `600 ${fontSize}px ui-monospace,SFMono-Regular,Menlo,monospace`;
  const tw    = ctx.measureText(text).width;
  const pillW = Math.max(MIN_W, tw + PAD_X);
  const pillLeft = cx - pillW / 2;
  const pillTop  = cy - PILL_H / 2;

  ctx.fillStyle = bgColor;
  ctx.beginPath();
  if (typeof (ctx as any).roundRect === 'function') {
    (ctx as any).roundRect(pillLeft, pillTop, pillW, PILL_H, 5);
  } else {
    ctx.rect(pillLeft, pillTop, pillW, PILL_H);
  }
  ctx.fill();

  ctx.fillStyle    = '#ffffff';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, cy);

  return { pillW, pillH: PILL_H, pillTop, pillRight: pillLeft + pillW };
}

// ─── Main export - draw rooms with category-based colors ──────────────────────
export function drawRoomsOnCanvas(
  canvas:  HTMLCanvasElement,
  rooms:   DetectedRoomWithArea[],
  dims:    { w: number; h: number },
  hoverId: string | null = null,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!rooms.length) return;

  for (const room of rooms) {
    const isHover    = room.id === hoverId;
    const isVector   = room.source?.startsWith('vector') ?? false;
    const isInferred = (room.source ?? '').includes('heuristic') && !isVector;

    // Get color based on room category (same category = same color)
    const colors = getRoomColor(room.label || 'default');

    // ── Pixel polygon ────────────────────────────────────────────────────────
    const pts = room.polygon.map(p => ({ x: p.nx * dims.w, y: p.ny * dims.h }));
    if (pts.length < 3) continue;

    // ── Fill ─────────────────────────────────────────────────────────────────
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
    ctx.closePath();

    // Hover: boost fill alpha
    if (isHover) {
      ctx.fillStyle = colors.fill.replace(/[\d.]+\)$/, '0.35)');
    } else {
      ctx.fillStyle = colors.fill;
    }
    ctx.fill();

    // ── Stroke ────────────────────────────────────────────────────────────────
    ctx.strokeStyle = colors.stroke;
    ctx.lineWidth   = isHover ? 2.5 : isVector ? 2.0 : 1.5;
    ctx.setLineDash(isInferred ? [4, 5] : []);
    ctx.stroke();
    ctx.setLineDash([]);

    // ── Label pill at polygon centroid ────────────────────────────────────────
    const { x: cx, y: cy } = polygonCentroid(pts);
    const labelText = (room.label || 'ROOM').trim();
    const fontSize  = isHover ? 12 : 11;

    if (isHover) {
      ctx.shadowColor   = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur    = 6;
      ctx.shadowOffsetY = 2;
    }

    const { pillW, pillH, pillTop, pillRight } = drawPill(
      ctx, labelText, cx, cy, colors.pill, fontSize,
    );

    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

    // ── Area badge ────────────────────────────────────────────────────────────
    const { areaSqM } = room;
    if (typeof areaSqM === 'number' && areaSqM > 0) {
      ctx.font         = `400 9px ui-monospace,SFMono-Regular,Menlo,monospace`;
      ctx.fillStyle    = colors.stroke;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(`${areaSqM.toFixed(1)} m²`, cx, pillTop + pillH + 2);
    }

    // ── Confidence badge (raster rooms, low confidence only) ─────────────────
    const conf = room.confidence ?? 1;
    if (!isVector && conf < 0.75 && room.areaNorm > 0.005) {
      const badgeY = (typeof areaSqM === 'number' && areaSqM > 0)
        ? pillTop + pillH + 14
        : pillTop + pillH + 2;
      ctx.font         = `400 9px ui-monospace,SFMono-Regular,Menlo,monospace`;
      ctx.fillStyle    = isInferred ? 'rgba(245,158,11,0.85)' : colors.stroke;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(`${Math.round(conf * 100)}%`, cx, badgeY);
    }

    // ── Source dot (top-right corner of pill) ─────────────────────────────────
    ctx.fillStyle = sourceDot(room.source);
    ctx.beginPath();
    ctx.arc(pillRight - 4, pillTop + 4, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}
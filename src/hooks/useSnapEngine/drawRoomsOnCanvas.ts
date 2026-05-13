// hooks/useSnapEngine/drawRoomsOnCanvas.ts
//
// Changes vs previous version:
//  1. ctx.font weight uses quoted string ('600') not bare number — bare numeric
//     weights are invalid in the Canvas 2D font shorthand and cause measureText
//     to return 0, collapsing the label pill to a sliver with invisible text.
//  2. SOURCE_DOT_COLORS extended with 'vector' key (cyan) so vector-extracted
//     rooms get a distinct dot colour instead of falling back to amber.
//  3. getElementColor handles multi-word / numbered labels:
//       "OFFICE 1", "OFFICE 2"   → OFFICE color
//       "MEETING RM 1"           → MEETING color
//       "OPEN PLAN A/B/C"        → OPEN color
//       "WC (M)", "WC (F)"       → WC / BATHROOM color
//  4. Pill always rendered even when label is empty (shows "ROOM" fallback).
//  5. Minimum pill width enforced (48px) so short labels don't clip.
//  6. areaSqM rendered as a second line below the label pill when present —
//     shows the architect's own area figure from PDF vector data.
//  7. Vector rooms skip the confidence badge entirely (confidence = 1.0 exact).
//  8. Dashed stroke only for genuinely inferred (heuristic) rooms, not all
//     non-hover rooms — removes visual noise on vector-extracted polygons.
// ─────────────────────────────────────────────────────────────────────────────

import type { DetectedRoom } from './detectRooms';

// ─── Types ────────────────────────────────────────────────────────────────────

// DetectedRoom extended with optional areaSqM from vector extraction.
// If your DetectedRoom interface already has areaSqM, this is a no-op.
type DetectedRoomWithArea = DetectedRoom & { areaSqM?: number | null };

// ─── Color palette ────────────────────────────────────────────────────────────

const ELEMENT_COLORS: Record<string, { fill: string; stroke: string; text: string }> = {
  WINDOW:    { fill: 'rgba(59,130,246,0.15)',  stroke: 'rgba(59,130,246,0.7)',  text: 'rgba(29,78,216,0.95)'   },
  WALL:      { fill: 'rgba(107,114,128,0.15)', stroke: 'rgba(107,114,128,0.7)', text: 'rgba(55,65,81,0.95)'    },
  DOOR:      { fill: 'rgba(16,185,129,0.15)',  stroke: 'rgba(16,185,129,0.7)',  text: 'rgba(6,95,70,0.95)'     },
  ROOM:      { fill: 'rgba(245,158,11,0.15)',  stroke: 'rgba(245,158,11,0.7)',  text: 'rgba(120,53,15,0.95)'   },
  KITCHEN:   { fill: 'rgba(236,72,153,0.15)',  stroke: 'rgba(236,72,153,0.7)',  text: 'rgba(131,24,67,0.95)'   },
  BEDROOM:   { fill: 'rgba(139,92,246,0.15)',  stroke: 'rgba(139,92,246,0.7)',  text: 'rgba(76,29,149,0.95)'   },
  BATHROOM:  { fill: 'rgba(20,184,166,0.15)',  stroke: 'rgba(20,184,166,0.7)',  text: 'rgba(19,78,74,0.95)'    },
  LIVING:    { fill: 'rgba(249,115,22,0.15)',  stroke: 'rgba(249,115,22,0.7)',  text: 'rgba(124,45,18,0.95)'   },
  CORRIDOR:  { fill: 'rgba(156,163,175,0.12)', stroke: 'rgba(156,163,175,0.6)', text: 'rgba(75,85,99,0.95)'    },
  OFFICE:    { fill: 'rgba(99,102,241,0.15)',  stroke: 'rgba(99,102,241,0.7)',  text: 'rgba(49,46,129,0.95)'   },
  GARAGE:    { fill: 'rgba(75,85,99,0.15)',    stroke: 'rgba(75,85,99,0.7)',    text: 'rgba(31,41,55,0.95)'    },
  BALCONY:   { fill: 'rgba(34,197,94,0.15)',   stroke: 'rgba(34,197,94,0.7)',   text: 'rgba(20,83,45,0.95)'    },
  MEETING:   { fill: 'rgba(168,85,247,0.15)',  stroke: 'rgba(168,85,247,0.7)',  text: 'rgba(88,28,135,0.95)'   },
  BOARDROOM: { fill: 'rgba(168,85,247,0.15)',  stroke: 'rgba(168,85,247,0.7)',  text: 'rgba(88,28,135,0.95)'   },
  OPEN:      { fill: 'rgba(6,182,212,0.15)',   stroke: 'rgba(6,182,212,0.7)',   text: 'rgba(21,94,117,0.95)'   },
  LOBBY:     { fill: 'rgba(251,191,36,0.15)',  stroke: 'rgba(251,191,36,0.7)',  text: 'rgba(120,53,15,0.95)'   },
  SERVER:    { fill: 'rgba(239,68,68,0.15)',   stroke: 'rgba(239,68,68,0.7)',   text: 'rgba(127,29,29,0.95)'   },
  BREAKOUT:  { fill: 'rgba(52,211,153,0.15)',  stroke: 'rgba(52,211,153,0.7)',  text: 'rgba(6,78,59,0.95)'     },
  STAIRS:    { fill: 'rgba(251,146,60,0.15)',  stroke: 'rgba(251,146,60,0.7)',  text: 'rgba(124,45,18,0.95)'   },
  STORAGE:   { fill: 'rgba(148,163,184,0.15)', stroke: 'rgba(148,163,184,0.7)', text: 'rgba(51,65,85,0.95)'    },
  WC:        { fill: 'rgba(20,184,166,0.15)',  stroke: 'rgba(20,184,166,0.7)',  text: 'rgba(19,78,74,0.95)'    },
  DIRECTOR:  { fill: 'rgba(99,102,241,0.15)',  stroke: 'rgba(99,102,241,0.7)',  text: 'rgba(49,46,129,0.95)'   },
  LAUNDRY:   { fill: 'rgba(20,184,166,0.12)',  stroke: 'rgba(20,184,166,0.6)',  text: 'rgba(19,78,74,0.95)'    },
  UTILITY:   { fill: 'rgba(148,163,184,0.15)', stroke: 'rgba(148,163,184,0.7)', text: 'rgba(51,65,85,0.95)'    },
  RECEPTION: { fill: 'rgba(251,191,36,0.15)',  stroke: 'rgba(251,191,36,0.7)',  text: 'rgba(120,53,15,0.95)'   },
  STUDY:     { fill: 'rgba(99,102,241,0.12)',  stroke: 'rgba(99,102,241,0.6)',  text: 'rgba(49,46,129,0.95)'   },
  GYM:       { fill: 'rgba(239,68,68,0.15)',   stroke: 'rgba(239,68,68,0.7)',   text: 'rgba(127,29,29,0.95)'   },
  DEFAULT:   { fill: 'rgba(156,163,175,0.15)', stroke: 'rgba(156,163,175,0.7)', text: 'rgba(75,85,99,0.95)'    },
};

// Source dot: 3px dot top-right of the pill — tells you where the data came from
const SOURCE_DOT_COLORS: Record<string, string> = {
  'cubicasa':                'rgba(107,114,128,0.9)',  // gray   — CubiCasa v6
  'room-model':              'rgba(59,130,246,0.9)',   // blue   — Roboflow room model
  'room-model+model-label':  'rgba(59,130,246,0.9)',   // blue
  'room-model+ocr':          'rgba(16,185,129,0.9)',   // green  — Roboflow + OCR
  'room-model+heuristic':    'rgba(245,158,11,0.9)',   // amber  — Roboflow + heuristic
  'workflow':                'rgba(99,102,241,0.9)',   // indigo — workflow fallback
  'vector':                  'rgba(6,182,212,0.9)',    // cyan   — PDF vector extraction
  'inferred':                'rgba(245,158,11,0.9)',   // amber  — area heuristic only
};

function getSourceDotColor(source: string | undefined): string {
  if (!source) return SOURCE_DOT_COLORS['inferred'];
  // Exact match first
  if (SOURCE_DOT_COLORS[source]) return SOURCE_DOT_COLORS[source];
  // Prefix match (e.g. "vector+user-relabelled")
  for (const [key, color] of Object.entries(SOURCE_DOT_COLORS)) {
    if (source.startsWith(key)) return color;
  }
  return SOURCE_DOT_COLORS['inferred'];
}

// ─── Color lookup ─────────────────────────────────────────────────────────────
//
// Priority:
//   1. Exact match:         "OFFICE"         → OFFICE
//   2. Strip trailing:      "OFFICE 1"       → "OFFICE"  → OFFICE
//                           "OPEN PLAN A"    → "OPEN PLAN" → "OPEN" → OPEN
//                           "WC (M)"         → "WC"       → WC
//                           "MEETING RM 1"   → "MEETING RM" → "MEETING" → MEETING
//   3. Substring scan:      first key that appears anywhere in the label
//   4. Fallback:            DEFAULT

function getElementColor(label: string): { fill: string; stroke: string; text: string } {
  const up = label.toUpperCase().trim();

  // 1. Exact match
  if (ELEMENT_COLORS[up]) return ELEMENT_COLORS[up];

  // 2. Progressive right-trim: remove last word until we get a match
  //    "OFFICE 1" → "OFFICE", "OPEN PLAN A" → "OPEN PLAN" → "OPEN"
  //    "WC (M)"   → "WC (M" → "WC"
  //    "MEETING RM 1" → "MEETING RM" → "MEETING"
  const words = up.split(/[\s(]+/);
  for (let i = words.length - 1; i >= 1; i--) {
    const candidate = words.slice(0, i).join(' ').trim();
    if (ELEMENT_COLORS[candidate]) return ELEMENT_COLORS[candidate];
  }

  // 3. Substring scan — first palette key that appears inside the label
  for (const [key, color] of Object.entries(ELEMENT_COLORS)) {
    if (key !== 'DEFAULT' && up.includes(key)) return color;
  }

  return ELEMENT_COLORS.DEFAULT;
}

// ─── roundRect polyfill (browser-only, guards against SSR) ───────────────────

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function drawPill(
  ctx:     CanvasRenderingContext2D,
  text:    string,
  cx:      number,
  cy:      number,
  bgColor: string,
  fontSize = 11,
): { pillW: number; pillH: number } {
  const MIN_PILL_W = 48;
  const PILL_H     = 20;
  const PADDING_X  = 14;

  // FIXED: font weight MUST be a quoted string in Canvas 2D font shorthand.
  // Bare numeric weights (500, 600) are invalid and cause measureText → 0.
  ctx.font = `'600' ${fontSize}px ui-monospace,SFMono-Regular,Menlo,monospace`;
  const tw   = ctx.measureText(text).width;
  const pillW = Math.max(MIN_PILL_W, tw + PADDING_X);

  const x = cx - pillW / 2;
  const y = cy - PILL_H / 2;

  ctx.fillStyle = bgColor;
  ctx.beginPath();
  if (typeof (ctx as any).roundRect === 'function') {
    (ctx as any).roundRect(x, y, pillW, PILL_H, 5);
  } else {
    ctx.rect(x, y, pillW, PILL_H);
  }
  ctx.fill();

  ctx.fillStyle    = '#ffffff';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, cy);

  return { pillW, pillH: PILL_H };
}

function drawAreaBadge(
  ctx:    CanvasRenderingContext2D,
  areaSqM: number,
  cx:     number,
  topY:   number,   // y just below the label pill
  color:  string,
) {
  const text = `${areaSqM.toFixed(1)} m²`;
  ctx.font          = `'400' 9px ui-monospace,SFMono-Regular,Menlo,monospace`;
  ctx.fillStyle     = color;
  ctx.textAlign     = 'center';
  ctx.textBaseline  = 'top';
  ctx.fillText(text, cx, topY + 2);
}

// ─── Main export ──────────────────────────────────────────────────────────────

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
    // Only genuinely heuristic rooms get a dashed stroke — not vector rooms
    const isInferred = (room.source ?? '').includes('heuristic') && !isVector;
    const colors     = getElementColor(room.label || 'ROOM');

    // ── Convert normalised polygon → canvas pixels ──────────────────────────
    const pts = room.polygon.map(p => ({
      x: p.nx * dims.w,
      y: p.ny * dims.h,
    }));
    if (pts.length < 3) continue;

    // ── Polygon fill ────────────────────────────────────────────────────────
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
    ctx.closePath();

    ctx.fillStyle = isHover
      ? colors.fill.replace(/[\d.]+\)$/, '0.30)')
      : colors.fill;
    ctx.fill();

    // ── Polygon stroke ──────────────────────────────────────────────────────
    ctx.strokeStyle = colors.stroke;
    ctx.lineWidth   = isHover ? 2.5 : isVector ? 2.0 : 1.5;
    // Dashed only for heuristic-inferred rooms; vector and model rooms solid
    ctx.setLineDash(isInferred ? [4, 5] : []);
    ctx.stroke();
    ctx.setLineDash([]);

    // ── Label pill ──────────────────────────────────────────────────────────
    const cx = room.centroid.nx * dims.w;
    const cy = room.centroid.ny * dims.h;

    const labelText = (room.label || 'ROOM').trim();
    const fontSize  = isHover ? 12 : 11;

    // Hover drop shadow
    if (isHover) {
      ctx.shadowColor   = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur    = 6;
      ctx.shadowOffsetY = 2;
    }

    const bgColor = colors.text.replace(/[\d.]+\)$/, '0.90)');
    const pillY   = isHover ? cy - 12 : cy - 9;

    const { pillW, pillH } = drawPill(ctx, labelText, cx, pillY, bgColor, fontSize);

    // Clear shadow after pill so it doesn't bleed into other elements
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur  = 0;
    ctx.shadowOffsetY = 0;

    // ── Area badge (vector rooms only — shows architect's exact m²) ─────────
    // areaSqM is set by extractPdfVectorData; raster rooms don't have it.
    const areaSqM = (room as DetectedRoomWithArea).areaSqM;
    if (isVector && typeof areaSqM === 'number' && areaSqM > 0) {
      drawAreaBadge(
        ctx,
        areaSqM,
        cx,
        pillY + pillH / 2,   // just below the pill bottom edge
        colors.text.replace(/[\d.]+\)$/, '0.80)'),
      );
    }

    // ── Confidence badge (raster rooms only, shown when conf < 0.75) ────────
    // Vector rooms always have confidence = 1.0 (exact) so we skip this.
    const conf = room.confidence ?? 1;
    if (!isVector && conf < 0.75 && room.areaNorm > 0.005) {
      const confText = `${Math.round(conf * 100)}%`;
      ctx.font          = `'400' 9px ui-monospace,SFMono-Regular,Menlo,monospace`;
      ctx.fillStyle     = isInferred
        ? 'rgba(245,158,11,0.85)'
        : colors.text.replace(/[\d.]+\)$/, '0.75)');
      ctx.textAlign     = 'center';
      ctx.textBaseline  = 'top';
      ctx.fillText(confText, cx, pillY + pillH / 2 + 2);
    }

    // ── Source dot (3px, top-right corner of pill) ───────────────────────────
    ctx.fillStyle = getSourceDotColor(room.source);
    ctx.beginPath();
    ctx.arc(cx + pillW / 2 - 4, pillY - pillH / 2 + 4, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

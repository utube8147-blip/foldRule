// hooks/useSvgInteraction.ts
//
// CHANGES in this version:
//   • ADDED: assignLabelsToRooms() — matches SVG <text> nodes to wall-graph rooms
//   • ADDED: ROOM_NAME_ALLOWLIST — only accept strings that look like real room names
//   • ADDED: ROOM_NAME_MAP — normalise common abbreviations/aliases
//   • FIXED: Wall-graph rooms now carry proper labels (CORRIDOR, BREAKOUT, etc.)
//   • KEPT: detectDoorSymbols(), reconstructRoomsFromWalls(), all prior logic

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  isDecorationElement,
  isFullPageShape,
  resolveStrokeWidth,
} from './svgDecorationFilter';
import { detectDoorSymbols } from './detectDoorSymbols';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface SvgPoint {
  id: string;
  type: 'point';
  x: number;
  y: number;
  element: Element;
  attributes: Record<string, string>;
  label?: string;
}

export interface SvgLine {
  id: string;
  type: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  length: number;
  angle: number;
  element: Element;
  attributes: Record<string, string>;
  label?: string;
}

export interface SvgArea {
  id: string;
  type: 'area';
  points: Array<{ x: number; y: number }>;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  area: number;
  element: Element;
  attributes: Record<string, string>;
  label?: string;
}

export type SvgElement = SvgPoint | SvgLine | SvgArea;

export interface SnapResult {
  type: 'point' | 'line' | 'area';
  element: SvgElement;
  snapPoint: { x: number; y: number };
  distance: number;
}

interface UseSvgInteractionProps {
  svgContent: string | null;
  pdfDimensions: { w: number; h: number } | null;
  snapThreshold?: number;
  enabled?: boolean;
}

// ─── Room label allowlist + normalisation map ─────────────────────────────────
//
// ALLOWLIST: a candidate string passes if it matches at least one of these
//   patterns. Add new patterns freely — order doesn't matter.
//
// MAP: applied after allowlist; keys are uppercase trimmed input, values are
//   the canonical display name. Handles abbreviations, typos, aliases.

const ROOM_NAME_PATTERNS: RegExp[] = [
  // Generic room words
  /\b(room|rm|office|offc|ofc)\b/i,
  /\b(corridor|corr|hallway|hall|passage|lobby|foyer|entry|reception|recep)\b/i,
  /\b(open\s*plan|openplan)\b/i,
  /\b(breakout|break\s*out|break\s*room|breakroom)\b/i,
  /\b(meeting|conf|conference|boardroom|board\s*room)\b/i,
  /\b(toilet|wc|restroom|bathroom|shower|amenity|amenities)\b/i,
  /\b(kitchen|kitchenette|canteen|cafe|cafeteria|pantry)\b/i,
  /\b(server|it\s*room|comms|communications|network|data\s*room)\b/i,
  /\b(store|storage|storeroom|store\s*room|archive|archives|plant|utility)\b/i,
  /\b(lift|elevator|stair|stairwell|staircase|stairs|fire\s*exit|exit)\b/i,
  /\b(lounge|waiting|seating|atrium|concourse)\b/i,
  /\b(print|copy|copies|photocopier|mail\s*room|mailroom)\b/i,
  /\b(car\s*park|parking|garage|loading|dock)\b/i,
  /\b(plant\s*room|electrical|switch\s*room|switchroom|riser|shaft)\b/i,
  /\b(disabled|accessible|accessible\s*wc)\b/i,
  /\b(block|wing|floor|level|zone|area|suite)\b/i,
  // Alphanumeric room codes like "A01", "B-02", "R101", "GF.01"
  /^[a-z]{1,3}[-.]?\d{1,4}$/i,
  // Pure room-number pattern like "101", "2A" — only if 2–4 chars
  /^[a-z]?\d{1,3}[a-z]?$/i,
];

// Strings that always disqualify a candidate regardless of the allowlist
const DISQUALIFY_PATTERNS: RegExp[] = [
  /^\d+(\.\d+)?\s*m[²2]?\s*$/,            // "260 m²", "50m2"
  /^\d+(\.\d+)?$/,                          // bare numbers "1234"
  /^scale\s*\d/i,                           // "SCALE 1:100"
  /^ground\s*floor/i,                       // drawing title
  /^first\s*floor/i,
  /^second\s*floor/i,
  /^\d+(st|nd|rd|th)\s*floor/i,
  /^block\s*[a-z]$/i,                       // "BLOCK A" alone — too generic
  /^(plan|drawing|sheet|revision|rev|dwg|date|drawn|checked|approved)/i,
  /^[^a-z\d]/i,                             // starts with symbol
  /^\s*$/,                                   // whitespace only
];

// Canonical name map — key: UPPERCASED input (trimmed), value: display name
const ROOM_NAME_MAP: Record<string, string> = {
  'CORR':            'Corridor',
  'CORRIDOR':        'Corridor',
  'HALL':            'Hallway',
  'HALLWAY':         'Hallway',
  'LOBBY':           'Lobby',
  'RECEPTION':       'Reception',
  'RECEP':           'Reception',
  'WC':              'WC',
  'TOILET':          'Toilet',
  'TOILETS':         'Toilets',
  'RESTROOM':        'Restroom',
  'BATHROOM':        'Bathroom',
  'SHOWER':          'Shower Room',
  'KITCHEN':         'Kitchen',
  'KITCHENETTE':     'Kitchenette',
  'CANTEEN':         'Canteen',
  'PANTRY':          'Pantry',
  'MEETING':         'Meeting Room',
  'MEETING ROOM':    'Meeting Room',
  'CONF':            'Conference Room',
  'CONFERENCE':      'Conference Room',
  'BOARDROOM':       'Boardroom',
  'BOARD ROOM':      'Boardroom',
  'OPEN PLAN':       'Open Plan',
  'OPEN PLAN A':     'Open Plan A',
  'OPEN PLAN B':     'Open Plan B',
  'OPEN PLAN C':     'Open Plan C',
  'OPEN PLAN D':     'Open Plan D',
  'BREAKOUT':        'Breakout',
  'BREAKOUT ROOM':   'Breakout Room',
  'BREAK OUT':       'Breakout',
  'BREAK ROOM':      'Break Room',
  'LOUNGE':          'Lounge',
  'SERVER RM':       'Server Room',
  'SERVER ROOM':     'Server Room',
  'IT ROOM':         'IT Room',
  'COMMS':           'Comms Room',
  'COMMS ROOM':      'Comms Room',
  'NETWORK ROOM':    'Network Room',
  'DATA ROOM':       'Data Room',
  'STORE':           'Store',
  'STORAGE':         'Storage',
  'STOREROOM':       'Store Room',
  'STORE ROOM':      'Store Room',
  'ARCHIVE':         'Archive',
  'ARCHIVES':        'Archives',
  'PLANT':           'Plant Room',
  'PLANT ROOM':      'Plant Room',
  'UTILITY':         'Utility Room',
  'ELECTRICAL':      'Electrical Room',
  'SWITCH ROOM':     'Switch Room',
  'SWITCHROOM':      'Switch Room',
  'PRINT ROOM':      'Print Room',
  'PRINT':           'Print Room',
  'COPY ROOM':       'Copy Room',
  'MAIL ROOM':       'Mail Room',
  'MAILROOM':        'Mail Room',
  'OFFICE':          'Office',
  'OPEN OFFICE':     'Open Office',
  'PRIVATE OFFICE':  'Private Office',
  'STAIR':           'Stairwell',
  'STAIRS':          'Stairs',
  'STAIRWELL':       'Stairwell',
  'STAIRCASE':       'Staircase',
  'LIFT':            'Lift',
  'ELEVATOR':        'Elevator',
  'LIFT LOBBY':      'Lift Lobby',
  'CAR PARK':        'Car Park',
  'PARKING':         'Parking',
  'GARAGE':          'Garage',
  'LOADING':         'Loading Bay',
  'LOADING DOCK':    'Loading Dock',
  'ATRIUM':          'Atrium',
  'CONCOURSE':       'Concourse',
  'WAITING':         'Waiting Area',
  'SEATING':         'Seating Area',
  'FOYER':           'Foyer',
  'ENTRY':           'Entry',
  'ENTRANCE':        'Entrance',
  'EXIT':            'Exit',
};

/**
 * Returns the canonical display name for a raw text string extracted from SVG,
 * or null if the string should be rejected.
 */
function resolveRoomLabel(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length < 2) return null;

  // Hard disqualify first
  for (const re of DISQUALIFY_PATTERNS) {
    if (re.test(trimmed)) return null;
  }

  const upper = trimmed.toUpperCase();

  // Check canonical map first (exact match)
  if (ROOM_NAME_MAP[upper]) return ROOM_NAME_MAP[upper];

  // Check if any allowlist pattern matches
  const allowed = ROOM_NAME_PATTERNS.some(re => re.test(trimmed));
  if (!allowed) return null;

  // Title-case the string as a fallback display name
  return trimmed
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());
}

// ─── Matrix types + helpers ───────────────────────────────────────────────────

interface Mat2D { a: number; b: number; c: number; d: number; e: number; f: number }
interface Vec2   { x: number; y: number }

function identityMatrix(): Mat2D {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

function multiplyMatrix(m1: Mat2D, m2: Mat2D): Mat2D {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

export function applyMatrix(m: Mat2D, v: Vec2): Vec2 {
  return {
    x: m.a * v.x + m.c * v.y + m.e,
    y: m.b * v.x + m.d * v.y + m.f,
  };
}

function parseTransformAttr(transform: string | null): Mat2D {
  if (!transform) return identityMatrix();
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\(([^)]*)\)/g;
  const transforms: Mat2D[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(transform)) !== null) {
    const type = m[1];
    const args = m[2].trim().split(/[\s,]+/).map(parseFloat);
    let mat = identityMatrix();
    switch (type) {
      case 'matrix':
        mat = { a: args[0], b: args[1], c: args[2], d: args[3], e: args[4], f: args[5] };
        break;
      case 'translate':
        mat = { a: 1, b: 0, c: 0, d: 1, e: args[0] ?? 0, f: args[1] ?? 0 };
        break;
      case 'scale': {
        const sx = args[0] ?? 1, sy = args[1] ?? sx;
        mat = { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
        break;
      }
      case 'rotate': {
        const ang = (args[0] ?? 0) * Math.PI / 180;
        const cos = Math.cos(ang), sin = Math.sin(ang);
        const cx = args[1] ?? 0, cy = args[2] ?? 0;
        mat = { a: cos, b: sin, c: -sin, d: cos,
                e: cx - cos*cx + sin*cy, f: cy - sin*cx - cos*cy };
        break;
      }
      case 'skewX': {
        const t = Math.tan((args[0] ?? 0) * Math.PI / 180);
        mat = { a: 1, b: 0, c: t, d: 1, e: 0, f: 0 };
        break;
      }
      case 'skewY': {
        const t = Math.tan((args[0] ?? 0) * Math.PI / 180);
        mat = { a: 1, b: t, c: 0, d: 1, e: 0, f: 0 };
        break;
      }
    }
    transforms.push(mat);
  }
  let composed = identityMatrix();
  for (const t of transforms) composed = multiplyMatrix(composed, t);
  return composed;
}

export function getCTM(el: Element, svgRoot: Element): Mat2D {
  const matrices: Mat2D[] = [];
  let node: Element | null = el;
  while (node && node !== svgRoot.parentElement) {
    const t = node.getAttribute('transform');
    if (t) matrices.unshift(parseTransformAttr(t));
    node = node.parentElement;
  }
  let ctm = identityMatrix();
  for (const m of matrices) ctm = multiplyMatrix(ctm, m);
  return ctm;
}

// ─── ViewBox → canvas pixel transform ────────────────────────────────────────

interface VBTransform { sx: number; sy: number; tx: number; ty: number }

function buildViewBoxTransform(svgEl: SVGSVGElement, canvasW: number, canvasH: number): VBTransform {
  const vb = svgEl.getAttribute('viewBox');
  if (vb) {
    const [minX, minY, vbW, vbH] = vb.trim().split(/[\s,]+/).map(parseFloat);
    if ([minX, minY, vbW, vbH].every(n => !isNaN(n)) && vbW > 0 && vbH > 0) {
      return { sx: canvasW / vbW, sy: canvasH / vbH,
               tx: -minX * (canvasW / vbW), ty: -minY * (canvasH / vbH) };
    }
  }
  const wAttr = svgEl.getAttribute('width');
  const hAttr = svgEl.getAttribute('height');
  const svgW  = wAttr ? parseFloat(wAttr) : canvasW;
  const svgH  = hAttr ? parseFloat(hAttr) : canvasH;
  return { sx: svgW > 0 ? canvasW / svgW : 1, sy: svgH > 0 ? canvasH / svgH : 1, tx: 0, ty: 0 };
}

export function applyVBTransform(v: Vec2, t: VBTransform): Vec2 {
  return { x: v.x * t.sx + t.tx, y: v.y * t.sy + t.ty };
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────

export function closestPointOnLine(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number,
): { x: number; y: number } {
  const ax = px - x1, ay = py - y1;
  const bx = x2 - x1, by = y2 - y1;
  const dot  = ax * bx + ay * by;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return { x: x1, y: y1 };
  const t = Math.max(0, Math.min(1, dot / len2));
  return { x: x1 + t * bx, y: y1 + t * by };
}

export function pointInPolygon(
  x: number, y: number,
  points: Array<{ x: number; y: number }>,
): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, yi = points[i].y;
    const xj = points[j].x, yj = points[j].y;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

export function distanceToPolygonEdge(
  x: number, y: number,
  points: Array<{ x: number; y: number }>,
): number {
  let minDist = Infinity;
  for (let i = 0; i < points.length; i++) {
    const j       = (i + 1) % points.length;
    const closest = closestPointOnLine(x, y, points[i].x, points[i].y, points[j].x, points[j].y);
    minDist = Math.min(minDist, Math.hypot(closest.x - x, closest.y - y));
  }
  return minDist;
}

// ─── Path parser ──────────────────────────────────────────────────────────────

export function parsePathToPoints(d: string): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz][^MmLlHhVvCcSsQqTtAaZz]*/g);
  if (!tokens) return points;

  let cx = 0, cy = 0, sx = 0, sy = 0;
  let lastCpX = 0, lastCpY = 0;
  let lastCmd = '';

  const push = (x: number, y: number) => points.push({ x, y });

  const sampleCubic = (
    x0: number, y0: number, x1: number, y1: number,
    x2: number, y2: number, x3: number, y3: number, steps = 8,
  ) => {
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, u = 1 - t;
      push(u*u*u*x0+3*u*u*t*x1+3*u*t*t*x2+t*t*t*x3,
           u*u*u*y0+3*u*u*t*y1+3*u*t*t*y2+t*t*t*y3);
    }
  };

  const sampleQuad = (
    x0: number, y0: number, x1: number, y1: number,
    x2: number, y2: number, steps = 6,
  ) => {
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, u = 1 - t;
      push(u*u*x0+2*u*t*x1+t*t*x2, u*u*y0+2*u*t*y1+t*t*y2);
    }
  };

  for (const token of tokens) {
    const cmd   = token[0];
    const upper = cmd.toUpperCase();
    const rel   = cmd !== upper;
    const nums  = token.slice(1).trim()
      .split(/[\s,]+/).map(parseFloat).filter(n => !isNaN(n));
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;

    switch (upper) {
      case 'M': {
        for (let i = 0; i + 1 < nums.length; i += 2) {
          const bx = i === 0 ? ox : (rel ? cx : 0);
          const by = i === 0 ? oy : (rel ? cy : 0);
          cx = bx + nums[i]; cy = by + nums[i + 1];
          if (i === 0) { sx = cx; sy = cy; }
          push(cx, cy);
        }
        lastCpX = cx; lastCpY = cy; break;
      }
      case 'L': {
        for (let i = 0; i + 1 < nums.length; i += 2) {
          cx = ox + nums[i]; cy = oy + nums[i + 1]; push(cx, cy);
        }
        lastCpX = cx; lastCpY = cy; break;
      }
      case 'H': {
        for (const n of nums) { cx = ox + n; push(cx, cy); }
        lastCpX = cx; lastCpY = cy; break;
      }
      case 'V': {
        for (const n of nums) { cy = oy + n; push(cx, cy); }
        lastCpX = cx; lastCpY = cy; break;
      }
      case 'C': {
        for (let i = 0; i + 5 < nums.length; i += 6) {
          const x1 = ox+nums[i], y1 = oy+nums[i+1];
          const x2 = ox+nums[i+2], y2 = oy+nums[i+3];
          const x3 = ox+nums[i+4], y3 = oy+nums[i+5];
          sampleCubic(cx,cy,x1,y1,x2,y2,x3,y3);
          lastCpX = x2; lastCpY = y2; cx = x3; cy = y3;
        }
        break;
      }
      case 'S': {
        for (let i = 0; i + 3 < nums.length; i += 4) {
          const prev = lastCmd === 'C' || lastCmd === 'S';
          const x1 = prev ? 2*cx-lastCpX : cx, y1 = prev ? 2*cy-lastCpY : cy;
          const x2 = ox+nums[i], y2 = oy+nums[i+1];
          const x3 = ox+nums[i+2], y3 = oy+nums[i+3];
          sampleCubic(cx,cy,x1,y1,x2,y2,x3,y3);
          lastCpX = x2; lastCpY = y2; cx = x3; cy = y3;
        }
        break;
      }
      case 'Q': {
        for (let i = 0; i + 3 < nums.length; i += 4) {
          const x1 = ox+nums[i], y1 = oy+nums[i+1];
          const x2 = ox+nums[i+2], y2 = oy+nums[i+3];
          sampleQuad(cx,cy,x1,y1,x2,y2);
          lastCpX = x1; lastCpY = y1; cx = x2; cy = y2;
        }
        break;
      }
      case 'T': {
        for (let i = 0; i + 1 < nums.length; i += 2) {
          const prev = lastCmd === 'Q' || lastCmd === 'T';
          const x1 = prev ? 2*cx-lastCpX : cx, y1 = prev ? 2*cy-lastCpY : cy;
          const x2 = ox+nums[i], y2 = oy+nums[i+1];
          sampleQuad(cx,cy,x1,y1,x2,y2);
          lastCpX = x1; lastCpY = y1; cx = x2; cy = y2;
        }
        break;
      }
      case 'A': {
        for (let i = 0; i + 6 < nums.length; i += 7) {
          cx = ox+nums[i+5]; cy = oy+nums[i+6]; push(cx, cy);
        }
        lastCpX = cx; lastCpY = cy; break;
      }
      case 'Z': {
        if (cx !== sx || cy !== sy) push(sx, sy);
        cx = sx; cy = sy; lastCpX = cx; lastCpY = cy; break;
      }
    }
    lastCmd = upper;
  }
  return points;
}

// ─── Segment chaining ─────────────────────────────────────────────────────────

interface RawSeg { a: Vec2; b: Vec2; el: Element }

export function chainRawSegments(segs: RawSeg[], tol = 8.0): Vec2[][] {
  if (segs.length === 0) return [];
  const used   = new Set<number>();
  const chains: Vec2[][] = [];

  for (let i = 0; i < segs.length; i++) {
    if (used.has(i)) continue;
    used.add(i);

    const pts: Vec2[] = [{ ...segs[i].a }, { ...segs[i].b }];
    let tail  = segs[i].b;
    let grew  = true;
    let iters = 0;

    while (grew && iters < 200) {
      grew  = false;
      iters++;
      let bestIdx  = -1;
      let bestDist = tol;
      let reverse  = false;

      for (let j = 0; j < segs.length; j++) {
        if (used.has(j)) continue;
        const dA = Math.hypot(segs[j].a.x - tail.x, segs[j].a.y - tail.y);
        const dB = Math.hypot(segs[j].b.x - tail.x, segs[j].b.y - tail.y);
        if (dA < bestDist) { bestDist = dA; bestIdx = j; reverse = false; }
        if (dB < bestDist) { bestDist = dB; bestIdx = j; reverse = true;  }
      }

      if (bestIdx !== -1) {
        if (reverse) {
          pts.push({ ...segs[bestIdx].a });
          tail = segs[bestIdx].a;
        } else {
          pts.push({ ...segs[bestIdx].b });
          tail = segs[bestIdx].b;
        }
        used.add(bestIdx);
        grew = true;
      }
    }

    chains.push(pts);
  }

  return chains;
}

// ─── Wall-graph room reconstruction ──────────────────────────────────────────

const WALL_MIN_STROKE_WIDTH = 1.5;
const SNAP_TOL              = 4;
const MIN_ROOM_AREA         = 800;

interface WallSeg {
  dir:   'h' | 'v';
  fixed: number;
  lo:    number;
  hi:    number;
}

function snapVal(v: number, grid: number[], tol: number): number {
  for (const g of grid) { if (Math.abs(v - g) <= tol) return g; }
  return v;
}

function buildGrid(values: number[], tol: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const grid: number[] = [];
  for (const v of sorted) {
    if (grid.length === 0 || v - grid[grid.length - 1] > tol) grid.push(v);
  }
  return grid;
}

function segCoversRange(
  segs: WallSeg[], dir: 'h' | 'v', fixed: number, lo: number, hi: number, tol: number,
): boolean {
  const matching = segs.filter(s => s.dir === dir && Math.abs(s.fixed - fixed) <= tol);
  if (matching.length === 0) return false;
  const intervals = matching
    .filter(s => s.lo < hi && s.hi > lo)
    .map(s => ({ lo: Math.min(s.lo, s.hi), hi: Math.max(s.lo, s.hi) }))
    .sort((a, b) => a.lo - b.lo);
  let covered = lo;
  for (const { lo: iLo, hi: iHi } of intervals) {
    if (iLo > covered + tol) break;
    covered = Math.max(covered, iHi);
    if (covered >= hi - tol) return true;
  }
  return false;
}

// ─── Label assignment — matches SVG <text> nodes to wall-graph rooms ──────────

function assignLabelsToRooms(
  rooms: SvgArea[],
  svgRoot: Element,
  svgEl: SVGSVGElement,
  vbt: VBTransform,
): SvgArea[] {
  // Collect all <text> and <tspan> nodes, transform to canvas coords
  const candidates: Array<{ text: string; x: number; y: number }> = [];

  svgRoot.querySelectorAll('text').forEach(textEl => {
    // Prefer the <text> element's own x/y; fall back to first <tspan>
    const getXY = (el: Element): { x: number; y: number } => {
      const rx = parseFloat(el.getAttribute('x') ?? '0');
      const ry = parseFloat(el.getAttribute('y') ?? '0');
      const ctm = getCTM(el, svgEl);
      return applyVBTransform(applyMatrix(ctm, { x: rx, y: ry }), vbt);
    };

    // Collect text from this node and all its tspan children
    const collectText = (el: Element): void => {
      // Direct text content of this element (not children)
      const direct = Array.from(el.childNodes)
        .filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent?.trim() ?? '')
        .join('');

      if (direct.length >= 2) {
        const pos = getXY(el);
        candidates.push({ text: direct, x: pos.x, y: pos.y });
      }

      // Recurse into tspan children
      el.querySelectorAll('tspan').forEach(ts => {
        const tsText = ts.textContent?.trim() ?? '';
        if (tsText.length >= 2) {
          const pos = getXY(ts);
          candidates.push({ text: tsText, x: pos.x, y: pos.y });
        }
      });
    };

    collectText(textEl);

    // Also try the full concatenated text content as one candidate
    const full = textEl.textContent?.trim() ?? '';
    if (full.length >= 2) {
      const pos = getXY(textEl);
      candidates.push({ text: full, x: pos.x, y: pos.y });
    }
  });

  console.log(
    `[assignLabelsToRooms] ${candidates.length} text candidates for ${rooms.length} rooms`,
  );

  return rooms.map(room => {
    // Find candidates whose position falls inside this room's bounding box + polygon
    const inside = candidates.filter(c =>
      c.x >= room.bounds.minX &&
      c.x <= room.bounds.maxX &&
      c.y >= room.bounds.minY &&
      c.y <= room.bounds.maxY &&
      pointInPolygon(c.x, c.y, room.points),
    );

    if (inside.length === 0) return room;

    // Run each candidate through the allowlist + map
    const resolved = inside
      .map(c => ({ raw: c.text, label: resolveRoomLabel(c.text) }))
      .filter((c): c is { raw: string; label: string } => c.label !== null);

    if (resolved.length === 0) {
      console.log(
        `[assignLabelsToRooms] room @ (${Math.round(room.bounds.minX)},${Math.round(room.bounds.minY)}) ` +
        `— ${inside.length} candidates, none passed allowlist: ` +
        inside.map(c => JSON.stringify(c.text)).join(', '),
      );
      return room;
    }

    // Prefer longer resolved labels (room name > short code)
    // Break ties by preferring uppercase (original drawing text is often ALL CAPS)
    resolved.sort((a, b) => {
      const lenDiff = b.label.length - a.label.length;
      if (lenDiff !== 0) return lenDiff;
      const aUpper = a.raw === a.raw.toUpperCase() ? 1 : 0;
      const bUpper = b.raw === b.raw.toUpperCase() ? 1 : 0;
      return bUpper - aUpper;
    });

    const winner = resolved[0].label;
    console.log(
      `[assignLabelsToRooms] room @ (${Math.round(room.bounds.minX)},${Math.round(room.bounds.minY)}) ` +
      `→ "${winner}" (from "${resolved[0].raw}")`,
    );

    return { ...room, label: winner };
  });
}

// ─── reconstructRoomsFromWalls ────────────────────────────────────────────────

function reconstructRoomsFromWalls(
  svgRoot: Element,
  svgEl: SVGSVGElement,
  vbt: VBTransform,
  pdfW: number,
  pdfH: number,
  idOffset: number,
): SvgArea[] {
  const wallSegs: WallSeg[] = [];
  const allRawX: number[]   = [];
  const allRawY: number[]   = [];

  svgRoot.querySelectorAll('line, path').forEach(el => {
    const sw = resolveStrokeWidth(el);
    if (sw < WALL_MIN_STROKE_WIDTH) return;

    const ctm = getCTM(el, svgEl);
    const tag = el.tagName.toLowerCase();

    const toCanvas = (x: number, y: number): Vec2 => {
      const p = applyMatrix(ctm, { x, y });
      return applyVBTransform(p, vbt);
    };

    if (tag === 'line') {
      const x1 = parseFloat(el.getAttribute('x1') ?? '0');
      const y1 = parseFloat(el.getAttribute('y1') ?? '0');
      const x2 = parseFloat(el.getAttribute('x2') ?? '0');
      const y2 = parseFloat(el.getAttribute('y2') ?? '0');
      const p1 = toCanvas(x1, y1), p2 = toCanvas(x2, y2);
      const dx = Math.abs(p2.x-p1.x), dy = Math.abs(p2.y-p1.y);
      if (dy < SNAP_TOL && dx > SNAP_TOL) {
        const fixedY = (p1.y+p2.y)/2;
        wallSegs.push({ dir:'h', fixed:fixedY, lo:Math.min(p1.x,p2.x), hi:Math.max(p1.x,p2.x) });
        allRawX.push(p1.x, p2.x); allRawY.push(fixedY);
      } else if (dx < SNAP_TOL && dy > SNAP_TOL) {
        const fixedX = (p1.x+p2.x)/2;
        wallSegs.push({ dir:'v', fixed:fixedX, lo:Math.min(p1.y,p2.y), hi:Math.max(p1.y,p2.y) });
        allRawX.push(fixedX); allRawY.push(p1.y, p2.y);
      }
    } else {
      const d = el.getAttribute('d') ?? '';
      const rawPts = parsePathToPoints(d);
      for (let i = 0; i + 1 < rawPts.length; i++) {
        const p1 = toCanvas(rawPts[i].x, rawPts[i].y);
        const p2 = toCanvas(rawPts[i+1].x, rawPts[i+1].y);
        const dx = Math.abs(p2.x-p1.x), dy = Math.abs(p2.y-p1.y);
        const len = Math.hypot(dx, dy);
        if (len < SNAP_TOL) continue;
        if (dy < SNAP_TOL && dx > SNAP_TOL) {
          const fixedY = (p1.y+p2.y)/2;
          wallSegs.push({ dir:'h', fixed:fixedY, lo:Math.min(p1.x,p2.x), hi:Math.max(p1.x,p2.x) });
          allRawX.push(p1.x, p2.x); allRawY.push(fixedY);
        } else if (dx < SNAP_TOL && dy > SNAP_TOL) {
          const fixedX = (p1.x+p2.x)/2;
          wallSegs.push({ dir:'v', fixed:fixedX, lo:Math.min(p1.y,p2.y), hi:Math.max(p1.y,p2.y) });
          allRawX.push(fixedX); allRawY.push(p1.y, p2.y);
        }
      }
    }
  });

  if (wallSegs.length === 0) return [];

  const gridX = buildGrid(allRawX, SNAP_TOL);
  const gridY = buildGrid(allRawY, SNAP_TOL);

  const snappedSegs: WallSeg[] = wallSegs.map(s => ({
    dir:   s.dir,
    fixed: snapVal(s.fixed, s.dir==='h' ? gridY : gridX, SNAP_TOL),
    lo:    snapVal(s.lo,    s.dir==='h' ? gridX : gridY, SNAP_TOL),
    hi:    snapVal(s.hi,    s.dir==='h' ? gridX : gridY, SNAP_TOL),
  }));

  const isBounded = (x1: number, y1: number, x2: number, y2: number): boolean => {
    const t = SNAP_TOL;
    return (
      segCoversRange(snappedSegs, 'h', y1, x1, x2, t) &&
      segCoversRange(snappedSegs, 'h', y2, x1, x2, t) &&
      segCoversRange(snappedSegs, 'v', x1, y1, y2, t) &&
      segCoversRange(snappedSegs, 'v', x2, y1, y2, t)
    );
  };

  const allBounded: Array<[number,number,number,number]> = [];
  for (let i = 0; i < gridX.length-1; i++) {
    for (let k = i+1; k < gridX.length; k++) {
      for (let j = 0; j < gridY.length-1; j++) {
        for (let l = j+1; l < gridY.length; l++) {
          const x1=gridX[i], x2=gridX[k], y1=gridY[j], y2=gridY[l];
          if ((x2-x1)*(y2-y1) < MIN_ROOM_AREA) continue;
          if (isBounded(x1,y1,x2,y2)) allBounded.push([x1,y1,x2,y2]);
        }
      }
    }
  }

  const containsStrictly = (
    [ox1,oy1,ox2,oy2]: [number,number,number,number],
    [ix1,iy1,ix2,iy2]: [number,number,number,number],
  ): boolean => {
    const t = SNAP_TOL;
    if (ox1===ix1 && oy1===iy1 && ox2===ix2 && oy2===iy2) return false;
    return ox1-t<=ix1 && oy1-t<=iy1 && ox2+t>=ix2 && oy2+t>=iy2;
  };

  const minimal = allBounded.filter(
    r => !allBounded.some(other => containsStrictly(r, other)),
  );

  // Build raw rooms first, then assign labels from SVG text nodes
  const rawRooms: SvgArea[] = minimal.map(([x1,y1,x2,y2], idx) => {
    const pts = [{ x:x1,y:y1 },{ x:x2,y:y1 },{ x:x2,y:y2 },{ x:x1,y:y2 }];
    return {
      id:         `wall-room-${idOffset+idx}`,
      type:       'area' as const,
      points:     pts,
      bounds:     { minX:x1, minY:y1, maxX:x2, maxY:y2 },
      area:       (x2-x1)*(y2-y1),
      element:    svgEl as unknown as Element,
      attributes: { 'data-source': 'wall-graph' },
      label:      undefined,
    };
  });

  // Assign labels — text nodes matched spatially + filtered through allowlist
  return assignLabelsToRooms(rawRooms, svgRoot, svgEl, vbt);
}

// ─── Hook constants ───────────────────────────────────────────────────────────

const MIN_AREA_THRESHOLD = 1500;
const MAX_ASPECT_RATIO   = 14;

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useSvgInteraction({
  svgContent,
  pdfDimensions,
  snapThreshold = 14,
  enabled = true,
}: UseSvgInteractionProps) {
  const [elements, setElements]               = useState<SvgElement[]>([]);
  const [hoveredElement, setHoveredElement]   = useState<SvgElement | null>(null);
  const [selectedElement, setSelectedElement] = useState<SvgElement | null>(null);
  const [loading, setLoading]                 = useState(false);
  const [error, setError]                     = useState<string | null>(null);

  const spatialIndexRef = useRef<Map<string, SvgElement>>(new Map());

  useEffect(() => {
    if (!enabled || !svgContent || !pdfDimensions) {
      setElements([]);
      spatialIndexRef.current.clear();
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const parser  = new DOMParser();
      const svgDoc  = parser.parseFromString(svgContent, 'image/svg+xml');
      const svgRoot = svgDoc.documentElement;

      if (svgRoot.querySelector('parsererror')) throw new Error('Invalid SVG format');

      const svgEl = svgDoc.querySelector('svg') as SVGSVGElement | null;
      if (!svgEl) throw new Error('No <svg> element found');

      const vbt = buildViewBoxTransform(svgEl, pdfDimensions.w, pdfDimensions.h);

      const extractedElements: SvgElement[] = [];
      let idCounter = 0;

      const getAttributes = (el: Element): Record<string, string> => {
        const attrs: Record<string, string> = {};
        for (let i = 0; i < el.attributes.length; i++) {
          attrs[el.attributes[i].name] = el.attributes[i].value;
        }
        return attrs;
      };

      const toCanvas = (el: Element, x: number, y: number) => {
        const ctm = getCTM(el, svgEl);
        const p   = applyMatrix(ctm, { x, y });
        return applyVBTransform(p, vbt);
      };

      // ── Circles / points ───────────────────────────────────────────────────
      svgRoot.querySelectorAll(
        'circle, [data-type="point"], [data-snap="point"]',
      ).forEach(el => {
        const sw = resolveStrokeWidth(el);
        if (isDecorationElement(el, sw)) return;
        const cx    = parseFloat(el.getAttribute('cx') || el.getAttribute('x') || '0');
        const cy    = parseFloat(el.getAttribute('cy') || el.getAttribute('y') || '0');
        const label = el.getAttribute('data-label') || el.getAttribute('label') || undefined;
        const pt    = toCanvas(el, cx, cy);
        extractedElements.push({
          id: `point-${idCounter++}`, type: 'point',
          x: pt.x, y: pt.y,
          element: el, attributes: getAttributes(el), label,
        });
      });

      // ── Explicit <line> elements ───────────────────────────────────────────
      svgRoot.querySelectorAll(
        'line, [data-type="line"], [data-snap="line"]',
      ).forEach(el => {
        const sw = resolveStrokeWidth(el);
        if (isDecorationElement(el, sw)) return;
        const rx1 = parseFloat(el.getAttribute('x1') || '0');
        const ry1 = parseFloat(el.getAttribute('y1') || '0');
        const rx2 = parseFloat(el.getAttribute('x2') || '0');
        const ry2 = parseFloat(el.getAttribute('y2') || '0');
        const label = el.getAttribute('data-label') || el.getAttribute('label') || undefined;
        const p1 = toCanvas(el, rx1, ry1);
        const p2 = toCanvas(el, rx2, ry2);
        extractedElements.push({
          id: `line-${idCounter++}`, type: 'line',
          x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
          length: Math.hypot(p2.x-p1.x, p2.y-p1.y),
          angle:  Math.atan2(p2.y-p1.y, p2.x-p1.x),
          element: el, attributes: getAttributes(el), label,
        });
      });

      // ── Open <path> elements → SvgLine ─────────────────────────────────────
      svgRoot.querySelectorAll('path').forEach(el => {
        const sw = resolveStrokeWidth(el);
        if (isDecorationElement(el, sw)) return;
        const d = el.getAttribute('d') ?? '';
        if (/[Zz]/.test(d)) return;
        const rawPts = parsePathToPoints(d);
        if (rawPts.length < 2) return;
        const first = rawPts[0], last = rawPts[rawPts.length - 1];
        if (Math.hypot(last.x-first.x, last.y-first.y) < 2) return;
        const label = el.getAttribute('data-label') || el.getAttribute('label') || undefined;
        const p1 = toCanvas(el, first.x, first.y);
        const p2 = toCanvas(el, last.x,  last.y);
        const len = Math.hypot(p2.x-p1.x, p2.y-p1.y);
        if (len < 3) return;
        extractedElements.push({
          id: `line-${idCounter++}`, type: 'line',
          x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
          length: len,
          angle:  Math.atan2(p2.y-p1.y, p2.x-p1.x),
          element: el, attributes: getAttributes(el), label,
        });
      });

      // ── Explicit closed shapes ─────────────────────────────────────────────
      svgRoot.querySelectorAll(
        'path, polygon, [data-type="area"], [data-snap="area"]',
      ).forEach(el => {
        const sw = resolveStrokeWidth(el);
        if (isDecorationElement(el, sw)) return;

        const d = el.getAttribute('d') || '';

        if (el.tagName === 'path') {
          const hasZ = /[Zz]/.test(d);
          if (!hasZ) {
            const pts = parsePathToPoints(d);
            if (pts.length < 3) return;
            const first = pts[0], last = pts[pts.length - 1];
            if (Math.hypot(last.x-first.x, last.y-first.y) >= 2) return;
          }
        }

        const ctm = getCTM(el, svgEl);
        const transformPoint = (rx: number, ry: number) => {
          const p = applyMatrix(ctm, { x: rx, y: ry });
          return applyVBTransform(p, vbt);
        };

        let points: Array<{ x: number; y: number }> = [];

        if (el.tagName === 'polygon') {
          const raw    = el.getAttribute('points') || '';
          const coords = raw.trim().split(/[\s,]+/).map(parseFloat);
          for (let i = 0; i + 1 < coords.length; i += 2) {
            points.push(transformPoint(coords[i], coords[i+1]));
          }
        } else if (el.tagName === 'path') {
          const rawPts = parsePathToPoints(d);
          points = rawPts.map(p => transformPoint(p.x, p.y));
        }

        if (points.length < 3) return;
        if (isFullPageShape(points, pdfDimensions.w, pdfDimensions.h)) return;

        const bounds = points.reduce(
          (b, p) => ({
            minX: Math.min(b.minX, p.x), minY: Math.min(b.minY, p.y),
            maxX: Math.max(b.maxX, p.x), maxY: Math.max(b.maxY, p.y),
          }),
          { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
        );

        let area = 0;
        for (let i = 0; i < points.length; i++) {
          const j = (i + 1) % points.length;
          area += points[i].x * points[j].y - points[j].x * points[i].y;
        }
        area = Math.abs(area) / 2;

        if (area < MIN_AREA_THRESHOLD) return;
        const shapeW = bounds.maxX - bounds.minX;
        const shapeH = bounds.maxY - bounds.minY;
        const shorter = Math.min(shapeW, shapeH);
        const longer  = Math.max(shapeW, shapeH);
        if (shorter > 0 && longer / shorter > MAX_ASPECT_RATIO) return;

        const rawLabel = el.getAttribute('data-label') || el.getAttribute('label') || undefined;
        const label    = rawLabel ? (resolveRoomLabel(rawLabel) ?? rawLabel) : undefined;
        extractedElements.push({
          id: `area-${idCounter++}`, type: 'area',
          points, bounds, area,
          element: el, attributes: getAttributes(el), label,
        });
      });

      // ── Door symbol detection ──────────────────────────────────────────────
      const doorAreas = detectDoorSymbols(svgRoot, svgEl, vbt, idCounter);
      idCounter += doorAreas.length;
      extractedElements.push(...doorAreas);

      // ── Wall-graph room reconstruction (with label assignment) ─────────────
      const wallRooms = reconstructRoomsFromWalls(
        svgRoot, svgEl, vbt, pdfDimensions.w, pdfDimensions.h, idCounter,
      );
      idCounter += wallRooms.length;

      // Deduplicate against any explicit areas already extracted
      const existingAreas = extractedElements.filter(e => e.type === 'area') as SvgArea[];
      const deduped = wallRooms.filter(wr =>
        !existingAreas.some(ea => {
          const overlapX = Math.max(0,
            Math.min(wr.bounds.maxX, ea.bounds.maxX) - Math.max(wr.bounds.minX, ea.bounds.minX));
          const overlapY = Math.max(0,
            Math.min(wr.bounds.maxY, ea.bounds.maxY) - Math.max(wr.bounds.minY, ea.bounds.minY));
          return (overlapX * overlapY) / wr.area > 0.8;
        }),
      );
      extractedElements.push(...deduped);

      const index = new Map<string, SvgElement>();
      extractedElements.forEach(el => index.set(el.id, el));
      setElements(extractedElements);
      spatialIndexRef.current = index;
      setLoading(false);

      const pts = extractedElements.filter(e => e.type === 'point').length;
      const lns = extractedElements.filter(e => e.type === 'line').length;
      const ars = extractedElements.filter(e => e.type === 'area').length;
      const labelled = deduped.filter(r => r.label).length;
      console.log(
        `[useSvgInteraction] extracted: points=${pts} lines=${lns} areas=${ars} ` +
        `(${doorAreas.length} doors + ${ars - deduped.length - doorAreas.length} explicit ` +
        `+ ${deduped.length} wall-graph rooms, ${labelled}/${deduped.length} labelled)`,
      );

    } catch (err) {
      console.error('Error parsing SVG:', err);
      setError(err instanceof Error ? err.message : 'Failed to parse SVG');
      setLoading(false);
    }
  }, [svgContent, pdfDimensions, enabled]);

  // ─── Snap to nearest element ────────────────────────────────────────────────
  const findNearestSnap = useCallback((mouseX: number, mouseY: number): SnapResult | null => {
    if (!enabled || elements.length === 0) return null;
    let best: SnapResult | null = null;

    for (const el of elements) {
      if (el.type === 'point') {
        const dist = Math.hypot(el.x-mouseX, el.y-mouseY);
        if (dist < snapThreshold && (!best || dist < best.distance))
          best = { type:'point', element:el, snapPoint:{x:el.x,y:el.y}, distance:dist };
      }
    }
    if (!best) {
      for (const el of elements) {
        if (el.type === 'line') {
          const closest = closestPointOnLine(mouseX, mouseY, el.x1, el.y1, el.x2, el.y2);
          const dist    = Math.hypot(closest.x-mouseX, closest.y-mouseY);
          if (dist < snapThreshold && (!best || dist < best.distance))
            best = { type:'line', element:el, snapPoint:closest, distance:dist };
        }
      }
    }
    if (!best) {
      for (const el of elements) {
        if (el.type === 'area') {
          if (mouseX >= el.bounds.minX && mouseX <= el.bounds.maxX &&
              mouseY >= el.bounds.minY && mouseY <= el.bounds.maxY) {
            if (pointInPolygon(mouseX, mouseY, el.points)) {
              const dist = distanceToPolygonEdge(mouseX, mouseY, el.points);
              if (dist < snapThreshold && (!best || dist < best.distance))
                best = { type:'area', element:el, snapPoint:{x:mouseX,y:mouseY}, distance:dist };
            }
          }
        }
      }
    }
    return best;
  }, [elements, snapThreshold, enabled]);

  // ─── Hit test ───────────────────────────────────────────────────────────────
  const hitTest = useCallback((mouseX: number, mouseY: number): SvgElement | null => {
    if (!enabled || elements.length === 0) return null;
    for (const el of elements) {
      if (el.type === 'area' && pointInPolygon(mouseX, mouseY, el.points)) return el;
    }
    for (const el of elements) {
      if (el.type === 'line') {
        const closest = closestPointOnLine(mouseX, mouseY, el.x1, el.y1, el.x2, el.y2);
        if (Math.hypot(closest.x-mouseX, closest.y-mouseY) < 10) return el;
      }
    }
    for (const el of elements) {
      if (el.type === 'point' && Math.hypot(el.x-mouseX, el.y-mouseY) < 12) return el;
    }
    return null;
  }, [elements, enabled]);

  const checkHover = useCallback((mouseX: number, mouseY: number) => {
    if (!enabled) { setHoveredElement(null); return null; }
    const hit = hitTest(mouseX, mouseY);
    setHoveredElement(hit);
    return hit;
  }, [hitTest, enabled]);

  const clearSelection  = useCallback(() => setSelectedElement(null), []);
  const getElementById  = useCallback((id: string) => spatialIndexRef.current.get(id), []);

  return {
    elements, hoveredElement, selectedElement,
    setSelectedElement, clearSelection,
    findNearestSnap, hitTest, checkHover, getElementById,
    loading, error,
  };
}
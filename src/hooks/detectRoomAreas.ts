// hooks/detectRoomAreas.ts
//
// ARCHITECTURE: DCEL (Doubly Connected Edge List) Planar Graph Room Detection
//
// Detects rooms of ANY shape from SVG floor plan wall segments:
//   ✅ Rectangular, L-shaped, U-shaped, T-shaped, diagonal-walled rooms
//   ✅ Robust gap bridging (PDF exports often have 2-15px gaps at junctions)
//   ✅ Filters outer boundary, title blocks, legend boxes
//   ✅ Assigns text labels from <text>/<tspan> elements
//
// Pipeline:
//   1. EXTRACT   — wall segments from <line>, <path>, <polyline>, <polygon>
//   2. SNAP      — cluster endpoints into unique vertices (generous tolerance)
//   3. GAP-BRIDGE— connect near-endpoints that are almost-touching
//   4. SPLIT     — subdivide at T-junctions and crossings
//   5. PRUNE     — remove dangling edges (furniture, dims, annotations)
//   6. BUILD     — DCEL half-edge structure
//   7. LINK      — clockwise-sort at each vertex → minimal face cycles
//   8. TRACE     — walk .next chains → face polygons
//   9. CLASSIFY  — filter outer boundary, title blocks, degenerate faces
//  10. LABEL     — match <text> elements to room polygons

import type { SvgArea } from './useSvgInteraction';
import {
  getCTM,
  applyMatrix,
  applyVBTransform,
  parsePathToPoints,
  pointInPolygon,
  type VBTransform,
  type Vec2,
} from './useSvgInteraction';
import { resolveStrokeWidth } from './svgDecorationFilter';

// ─── Constants ────────────────────────────────────────────────────────────────

const SNAP_TOL           = 12;    // px — endpoint clustering (generous for PDF gaps)
const GAP_BRIDGE_TOL     = 20;    // px — bridge near-endpoints that almost touch
const INTERSECT_TOL      = 4;     // px — T-junction / crossing detection
const MIN_EDGE_LENGTH    = 3;     // px — discard micro-segments
const WALL_MIN_STROKE    = 0.5;   // pt — minimum stroke width to be a wall
const MIN_ROOM_AREA      = 800;   // px² — discard tiny faces
const MAX_ROOM_AREA_FRAC = 0.45;  // fraction of canvas — anything larger = boundary/outer
const MIN_ASPECT         = 0.08;  // width/height min ratio
const MAX_ASPECT         = 12.0;  // width/height max ratio
const MAX_PRUNE_ITERS    = 60;    // dangling-edge prune passes
const MAX_FACE_EDGES     = 500;   // safety limit per face cycle

// ─── Room label allowlist ─────────────────────────────────────────────────────

const ROOM_NAME_PATTERNS: RegExp[] = [
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
  /\b(director|manager|director['']?s?)\b/i,
  /\b(boardroom|board)\b/i,
  /^[a-z]{1,3}[-.]?\d{1,4}$/i,
  /^[a-z]?\d{1,3}[a-z]?$/i,
];

const DISQUALIFY_PATTERNS: RegExp[] = [
  /^\d+(\.\d+)?\s*m[²2]?\s*$/,
  /^\d+(\.\d+)?$/,
  /^scale\s*\d/i,
  /^(ground|first|second|third)\s*floor/i,
  /^\d+(st|nd|rd|th)\s*floor/i,
  /^block\s*[a-z]$/i,
  /^(plan|drawing|sheet|revision|rev|dwg|date|drawn|checked|approved)/i,
  /^[^a-z\d]/i,
  /^\s*$/,
];

const ROOM_NAME_MAP: Record<string, string> = {
  'CORR': 'Corridor', 'CORRIDOR': 'Corridor',
  'HALL': 'Hallway', 'HALLWAY': 'Hallway',
  'LOBBY': 'Lobby', 'RECEPTION': 'Reception', 'RECEP': 'Reception',
  'WC': 'WC', 'TOILET': 'Toilet', 'TOILETS': 'Toilets',
  'RESTROOM': 'Restroom', 'BATHROOM': 'Bathroom', 'SHOWER': 'Shower Room',
  'KITCHEN': 'Kitchen', 'KITCHENETTE': 'Kitchenette',
  'CANTEEN': 'Canteen', 'PANTRY': 'Pantry',
  'MEETING': 'Meeting Room', 'MEETING ROOM': 'Meeting Room',
  'MEETING RM': 'Meeting Room', 'MEETING RM 1': 'Meeting Rm 1',
  'MEETING RM 2': 'Meeting Rm 2', 'CONF': 'Conference Room',
  'CONFERENCE': 'Conference Room', 'BOARDROOM': 'Boardroom',
  'BOARD ROOM': 'Boardroom', 'OPEN PLAN': 'Open Plan',
  'OPEN PLAN A': 'Open Plan A', 'OPEN PLAN B': 'Open Plan B',
  'OPEN PLAN C': 'Open Plan C', 'OPEN PLAN D': 'Open Plan D',
  'BREAKOUT': 'Breakout', 'BREAKOUT ROOM': 'Breakout Room',
  'LOUNGE': 'Lounge', 'SERVER ROOM': 'Server Room', 'SERVER RM': 'Server Room',
  'IT ROOM': 'IT Room', 'COMMS': 'Comms Room', 'DATA ROOM': 'Data Room',
  'STORE': 'Store', 'STORAGE': 'Storage', 'STORE ROOM': 'Store Room',
  'ARCHIVE': 'Archive', 'PLANT ROOM': 'Plant Room', 'UTILITY': 'Utility Room',
  'ELECTRICAL': 'Electrical Room', 'SWITCH ROOM': 'Switch Room',
  'PRINT ROOM': 'Print Room', 'MAIL ROOM': 'Mail Room',
  'OFFICE': 'Office', 'OFFICE 1': 'Office 1', 'OFFICE 2': 'Office 2',
  'OFFICE 3': 'Office 3', 'DIRECTOR': 'Director',
  'STAIR': 'Stairwell', 'STAIRS': 'Stairs', 'STAIRWELL': 'Stairwell',
  'STAIR CORE': 'Stair Core', 'CORE': 'Core',
  'LIFT': 'Lift', 'ELEVATOR': 'Elevator', 'LIFT LOBBY': 'Lift Lobby',
  'CAR PARK': 'Car Park', 'PARKING': 'Parking', 'GARAGE': 'Garage',
  'ATRIUM': 'Atrium', 'WAITING': 'Waiting Area', 'FOYER': 'Foyer',
  'ENTRY': 'Entry', 'ENTRANCE': 'Entrance', 'EXIT': 'Exit',
};

export function resolveRoomLabel(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length < 2) return null;
  for (const re of DISQUALIFY_PATTERNS) if (re.test(trimmed)) return null;
  const upper = trimmed.toUpperCase();
  if (ROOM_NAME_MAP[upper]) return ROOM_NAME_MAP[upper];
  if (!ROOM_NAME_PATTERNS.some(re => re.test(trimmed))) return null;
  return trimmed.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

// ─── DCEL Types ───────────────────────────────────────────────────────────────

interface Vertex {
  id:       number;
  x:        number;
  y:        number;
  outgoing: HalfEdge[];
}

interface HalfEdge {
  id:      number;
  origin:  Vertex;
  twin:    HalfEdge;
  next:    HalfEdge | null;
  prev:    HalfEdge | null;
  face:    Face | null;
  angle:   number;
  visited: boolean;
}

interface Face {
  id:       number;
  points:   Vec2[];
  area:     number;
  isOuter:  boolean;
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────

function computeBounds(pts: Vec2[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function polygonCentroid(pts: Vec2[]): Vec2 {
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  return { x: cx / pts.length, y: cy / pts.length };
}

function dist(a: Vec2, b: Vec2) { return Math.hypot(b.x - a.x, b.y - a.y); }

// ─── Step 1: Extract raw wall segments ───────────────────────────────────────

interface RawEdge { a: Vec2; b: Vec2 }

function extractWallSegments(
  svgRoot: Element,
  svgEl: SVGSVGElement,
  vbt: VBTransform,
): RawEdge[] {
  const edges: RawEdge[] = [];

  const toCanvas = (el: Element, x: number, y: number): Vec2 => {
    const ctm = getCTM(el, svgEl);
    return applyVBTransform(applyMatrix(ctm, { x, y }), vbt);
  };

  svgRoot.querySelectorAll('line, path, polyline, polygon').forEach(el => {
    const sw = resolveStrokeWidth(el);
    if (sw < WALL_MIN_STROKE) return;

    const tag = el.tagName.toLowerCase();

    if (tag === 'line') {
      const x1 = parseFloat(el.getAttribute('x1') ?? '0');
      const y1 = parseFloat(el.getAttribute('y1') ?? '0');
      const x2 = parseFloat(el.getAttribute('x2') ?? '0');
      const y2 = parseFloat(el.getAttribute('y2') ?? '0');
      const a = toCanvas(el, x1, y1), b = toCanvas(el, x2, y2);
      if (dist(a, b) >= MIN_EDGE_LENGTH) edges.push({ a, b });
    }

    else if (tag === 'path') {
      const d = el.getAttribute('d') ?? '';
      const rawPts = parsePathToPoints(d);
      const closed = /[Zz]/.test(d);
      const limit = closed ? rawPts.length : rawPts.length - 1;
      for (let i = 0; i < limit; i++) {
        const j = (i + 1) % rawPts.length;
        const a = toCanvas(el, rawPts[i].x, rawPts[i].y);
        const b = toCanvas(el, rawPts[j].x, rawPts[j].y);
        if (dist(a, b) >= MIN_EDGE_LENGTH) edges.push({ a, b });
      }
    }

    else if (tag === 'polyline' || tag === 'polygon') {
      const raw = (el.getAttribute('points') ?? '').trim();
      const nums = raw.split(/[\s,]+/).map(Number).filter(n => !isNaN(n));
      const pts: Vec2[] = [];
      for (let i = 0; i + 1 < nums.length; i += 2)
        pts.push(toCanvas(el, nums[i], nums[i + 1]));
      const limit = tag === 'polygon' ? pts.length : pts.length - 1;
      for (let i = 0; i < limit; i++) {
        const j = (i + 1) % pts.length;
        if (dist(pts[i], pts[j]) >= MIN_EDGE_LENGTH) edges.push({ a: pts[i], b: pts[j] });
      }
    }
  });

  console.log(`[DCEL] extracted ${edges.length} raw segments`);
  return edges;
}

// ─── Step 2: Snap endpoints → unique vertices ─────────────────────────────────

function snapVertices(edges: RawEdge[]): {
  verts: Vertex[];
  edges: Array<{ a: number; b: number }>;
} {
  const verts: Vertex[] = [];
  let vId = 0;

  const find = (p: Vec2): number => {
    let best = -1, bestD = SNAP_TOL;
    for (let i = 0; i < verts.length; i++) {
      const d = dist(verts[i], p);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best !== -1) {
      // Weighted average toward new point for better centroid accuracy
      verts[best].x = (verts[best].x * 2 + p.x) / 3;
      verts[best].y = (verts[best].y * 2 + p.y) / 3;
      return best;
    }
    verts.push({ id: vId++, x: p.x, y: p.y, outgoing: [] });
    return verts.length - 1;
  };

  const snapped: Array<{ a: number; b: number }> = [];
  for (const e of edges) {
    const ai = find(e.a), bi = find(e.b);
    if (ai !== bi) snapped.push({ a: ai, b: bi });
  }

  console.log(`[DCEL] snapped: ${verts.length} vertices, ${snapped.length} edges`);
  return { verts, edges: snapped };
}

// ─── Step 3: Bridge small gaps between near-endpoints ────────────────────────
// PDF exports often have 2-20px gaps where walls should meet.
// For each vertex with degree 1 (open end), if another vertex is within
// GAP_BRIDGE_TOL, add a synthetic bridging edge.

function bridgeGaps(
  verts: Vertex[],
  edges: Array<{ a: number; b: number }>,
): Array<{ a: number; b: number }> {
  // Count degree
  const degree = new Map<number, number>();
  for (const e of edges) {
    degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
    degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
  }

  const open = verts.filter(v => (degree.get(v.id) ?? 0) === 1);
  const bridged = [...edges];
  const bridgedPairs = new Set<string>();

  for (const v of open) {
    let bestD = GAP_BRIDGE_TOL, bestU: Vertex | null = null;
    for (const u of verts) {
      if (u.id === v.id) continue;
      const d = dist(v, u);
      if (d > 0 && d < bestD) { bestD = d; bestU = u; }
    }
    if (bestU) {
      const key = `${Math.min(v.id, bestU.id)}-${Math.max(v.id, bestU.id)}`;
      if (!bridgedPairs.has(key)) {
        bridgedPairs.add(key);
        bridged.push({ a: v.id, b: bestU.id });
      }
    }
  }

  const newBridges = bridged.length - edges.length;
  if (newBridges > 0) console.log(`[DCEL] bridged ${newBridges} gaps`);
  return bridged;
}

// ─── Step 4: Split at T-junctions and crossings ───────────────────────────────

function splitIntersections(
  verts: Vertex[],
  edges: Array<{ a: number; b: number }>,
): Array<{ a: number; b: number }> {
  let vId = verts.length;

  const findOrAdd = (p: Vec2): number => {
    for (let i = 0; i < verts.length; i++)
      if (dist(verts[i], p) <= INTERSECT_TOL) return i;
    verts.push({ id: vId++, x: p.x, y: p.y, outgoing: [] });
    return verts.length - 1;
  };

  const onSeg = (
    px: number, py: number,
    ax: number, ay: number, bx: number, by: number,
  ): number | null => {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1) return null;
    const t = ((px - ax) * dx + (py - ay) * dy) / len2;
    const margin = INTERSECT_TOL / Math.sqrt(len2);
    if (t <= margin || t >= 1 - margin) return null;
    const ex = ax + t * dx - px, ey = ay + t * dy - py;
    return Math.hypot(ex, ey) <= INTERSECT_TOL ? t : null;
  };

  const segCross = (a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): Vec2 | null => {
    const d1x = a2.x - a1.x, d1y = a2.y - a1.y;
    const d2x = b2.x - b1.x, d2y = b2.y - b1.y;
    const cross = d1x * d2y - d1y * d2x;
    if (Math.abs(cross) < 1e-8) return null;
    const ex = b1.x - a1.x, ey = b1.y - a1.y;
    const t = (ex * d2y - ey * d2x) / cross;
    const u = (ex * d1y - ey * d1x) / cross;
    const eps = INTERSECT_TOL / Math.max(Math.hypot(d1x, d1y), Math.hypot(d2x, d2y), 1);
    if (t <= eps || t >= 1 - eps || u <= eps || u >= 1 - eps) return null;
    return { x: a1.x + t * d1x, y: a1.y + t * d1y };
  };

  let cur = [...edges];
  let changed = true, passes = 0;

  while (changed && passes < 8) {
    changed = false; passes++;
    const next: Array<{ a: number; b: number }> = [];

    for (const edge of cur) {
      const va = verts[edge.a], vb = verts[edge.b];
      const splits: Array<{ t: number; vi: number }> = [];

      // T-junctions
      for (let i = 0; i < verts.length; i++) {
        if (i === edge.a || i === edge.b) continue;
        const t = onSeg(verts[i].x, verts[i].y, va.x, va.y, vb.x, vb.y);
        if (t !== null) splits.push({ t, vi: i });
      }

      // Crossings
      for (const other of cur) {
        if (other === edge) continue;
        const p = segCross(va, vb, verts[other.a], verts[other.b]);
        if (p) {
          const vi = findOrAdd(p);
          const dx = vb.x - va.x, dy = vb.y - va.y;
          const len2 = dx * dx + dy * dy;
          const t = ((p.x - va.x) * dx + (p.y - va.y) * dy) / len2;
          splits.push({ t, vi });
          changed = true;
        }
      }

      if (splits.length === 0) { next.push(edge); continue; }

      splits.sort((a, b) => a.t - b.t);
      const unique = splits.filter((s, i) => i === 0 || s.vi !== splits[i - 1].vi);

      let prev = edge.a;
      for (const { vi } of unique) {
        if (prev !== vi) next.push({ a: prev, b: vi });
        prev = vi;
      }
      if (prev !== edge.b) next.push({ a: prev, b: edge.b });
      changed = true;
    }
    cur = next;
  }

  // Dedup and remove zero-length
  const seen = new Set<string>();
  const final = cur.filter(e => {
    if (e.a === e.b) return false;
    if (dist(verts[e.a], verts[e.b]) < MIN_EDGE_LENGTH) return false;
    const key = `${Math.min(e.a, e.b)}-${Math.max(e.a, e.b)}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });

  console.log(`[DCEL] after split (${passes} passes): ${final.length} edges`);
  return final;
}

// ─── Step 5: Prune dangling edges ─────────────────────────────────────────────

function pruneDangling(
  verts: Vertex[],
  edges: Array<{ a: number; b: number }>,
): Array<{ a: number; b: number }> {
  let cur = [...edges];
  for (let iter = 0; iter < MAX_PRUNE_ITERS; iter++) {
    const deg = new Map<number, number>();
    for (const e of cur) {
      deg.set(e.a, (deg.get(e.a) ?? 0) + 1);
      deg.set(e.b, (deg.get(e.b) ?? 0) + 1);
    }
    const before = cur.length;
    cur = cur.filter(e => (deg.get(e.a) ?? 0) > 1 && (deg.get(e.b) ?? 0) > 1);
    if (cur.length === before) break;
  }
  console.log(`[DCEL] after prune: ${cur.length} edges`);
  return cur;
}

// ─── Step 6: Build DCEL ───────────────────────────────────────────────────────

function buildDCEL(
  verts: Vertex[],
  edges: Array<{ a: number; b: number }>,
): HalfEdge[] {
  const halfEdges: HalfEdge[] = [];
  let heId = 0;

  for (const v of verts) v.outgoing = [];

  for (const e of edges) {
    const va = verts[e.a], vb = verts[e.b];
    const h1: HalfEdge = {
      id: heId++, origin: va, twin: null!, next: null, prev: null,
      face: null, angle: Math.atan2(vb.y - va.y, vb.x - va.x), visited: false,
    };
    const h2: HalfEdge = {
      id: heId++, origin: vb, twin: null!, next: null, prev: null,
      face: null, angle: Math.atan2(va.y - vb.y, va.x - vb.x), visited: false,
    };
    h1.twin = h2; h2.twin = h1;
    va.outgoing.push(h1);
    vb.outgoing.push(h2);
    halfEdges.push(h1, h2);
  }

  // Sort outgoing by angle at each vertex
  for (const v of verts) v.outgoing.sort((a, b) => a.angle - b.angle);

  // Link next pointers:
  // In SVG Y-down space, for a half-edge h arriving at vertex v,
  // h.next = the outgoing edge making the most-clockwise (tightest right) turn.
  // With angles sorted ascending (= increasing clockwise in Y-down), the
  // most-clockwise next from h.twin is the outgoing edge JUST BEFORE h.twin
  // in the sorted list (i.e. the one with the largest angle less than h.twin).
  for (const h of halfEdges) {
    const v = h.twin.origin;
    const out = v.outgoing;
    const idx = out.indexOf(h.twin);
    if (idx === -1) continue;
    // idx - 1 = previous in sorted order = most-clockwise in Y-down screen space
    h.next = out[(idx - 1 + out.length) % out.length];
  }

  // Backfill prev
  for (const h of halfEdges) {
    if (h.next) h.next.prev = h;
  }

  return halfEdges;
}

// ─── Step 7 & 8: Trace faces + compute winding ────────────────────────────────

function traceFaces(halfEdges: HalfEdge[]): Face[] {
  const faces: Face[] = [];
  let faceId = 0;

  for (const start of halfEdges) {
    if (start.visited || !start.next) continue;

    const cycle: HalfEdge[] = [];
    let h: HalfEdge = start;
    let steps = 0;

    while (steps < MAX_FACE_EDGES) {
      if (h.visited) break;
      h.visited = true;
      cycle.push(h);
      if (!h.next) break;
      h = h.next;
      steps++;
      if (h === start) break;
    }

    if (cycle.length < 3) continue;

    const pts = cycle.map(he => ({ x: he.origin.x, y: he.origin.y }));

    // Signed area (shoelace) — positive = CW in Y-down = inner face (room)
    let signed = 0;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      signed += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
    }
    signed /= 2;
    const area = Math.abs(signed);

    // In SVG Y-down: CW winding → signed > 0 → inner face
    const isOuter = signed <= 0;

    const face: Face = { id: faceId++, points: pts, area, isOuter };
    cycle.forEach(he => { he.face = face; });
    faces.push(face);
  }

  console.log(`[DCEL] traced ${faces.length} faces — ${faces.filter(f => !f.isOuter).length} inner`);
  return faces;
}

// ─── Step 9: Classify + filter rooms ─────────────────────────────────────────

function classifyRooms(
  faces: Face[],
  canvasW: number,
  canvasH: number,
): Face[] {
  const safeW = isFinite(canvasW) && canvasW > 0 ? canvasW : 10000;
  const safeH = isFinite(canvasH) && canvasH > 0 ? canvasH : 10000;
  const maxArea = safeW * safeH * MAX_ROOM_AREA_FRAC;

  // All inner faces (CW winding in Y-down)
  const inner = faces.filter(f => !f.isOuter);

  // Find the largest inner face — it's almost always the building outline or
  // entire floor plate. Suppress it and anything within 20% of its size.
  const sorted = [...inner].sort((a, b) => b.area - a.area);
  const outerThreshold = sorted.length > 0 ? sorted[0].area * 0.80 : Infinity;

  const rooms = inner.filter(f => {
    if (f.area < MIN_ROOM_AREA) return false;
    if (f.area > maxArea) return false;
    if (f.area >= outerThreshold) return false;   // suppress building outline

    const b = computeBounds(f.points);
    const bw = b.maxX - b.minX, bh = b.maxY - b.minY;
    if (bw === 0 || bh === 0) return false;
    const aspect = bw / bh;
    if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) return false;

    return true;
  });

  console.log(
    `[DCEL] classify: ${inner.length} inner faces → ${rooms.length} rooms ` +
    `(outer threshold=${Math.round(outerThreshold)}px², max=${Math.round(maxArea)}px²)`,
  );
  return rooms;
}

// ─── Step 10: Assign text labels ─────────────────────────────────────────────

function assignLabels(
  rooms: SvgArea[],
  svgRoot: Element,
  svgEl: SVGSVGElement,
  vbt: VBTransform,
): SvgArea[] {
  const candidates: Array<{ text: string; x: number; y: number }> = [];

  const getXY = (el: Element): Vec2 => {
    const rx = parseFloat(el.getAttribute('x') ?? '0');
    const ry = parseFloat(el.getAttribute('y') ?? '0');
    const ctm = getCTM(el, svgEl);
    return applyVBTransform(applyMatrix(ctm, { x: rx, y: ry }), vbt);
  };

  svgRoot.querySelectorAll('text').forEach(textEl => {
    // Full text content
    const full = textEl.textContent?.trim() ?? '';
    if (full.length >= 2) candidates.push({ text: full, ...getXY(textEl) });

    // Individual tspans (multi-line labels)
    textEl.querySelectorAll('tspan').forEach(ts => {
      const t = ts.textContent?.trim() ?? '';
      if (t.length >= 2) candidates.push({ text: t, ...getXY(ts) });
    });
  });

  return rooms.map(room => {
    const inside = candidates.filter(c =>
      c.x >= room.bounds.minX && c.x <= room.bounds.maxX &&
      c.y >= room.bounds.minY && c.y <= room.bounds.maxY &&
      pointInPolygon(c.x, c.y, room.points),
    );
    if (inside.length === 0) return room;

    const resolved = inside
      .map(c => ({ raw: c.text, label: resolveRoomLabel(c.text) }))
      .filter((c): c is { raw: string; label: string } => c.label !== null);

    if (resolved.length === 0) return room;

    // Prefer longer labels; prefer ALL-CAPS (primary label text in floor plans)
    resolved.sort((a, b) => {
      const lenD = b.label.length - a.label.length;
      if (lenD !== 0) return lenD;
      return (b.raw === b.raw.toUpperCase() ? 1 : 0) - (a.raw === a.raw.toUpperCase() ? 1 : 0);
    });

    const winner = resolved[0].label;
    console.log(`[DCEL] label: "${winner}" → room@(${Math.round(room.bounds.minX)},${Math.round(room.bounds.minY)})`);
    return { ...room, label: winner };
  });
}

// ─── Deduplicate overlapping rooms ───────────────────────────────────────────

function deduplicateRooms(rooms: SvgArea[]): SvgArea[] {
  const kept: SvgArea[] = [];
  for (const room of rooms) {
    const c = polygonCentroid(room.points);
    const dup = kept.some(existing => {
      const ec = polygonCentroid(existing.points);
      const d = dist(c, ec);
      const areaRatio = Math.abs(room.area - existing.area) / Math.max(room.area, existing.area, 1);
      return d < SNAP_TOL * 6 && areaRatio < 0.15;
    });
    if (!dup) kept.push(room);
  }
  return kept;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function detectRoomAreas(
  svgRoot: Element,
  svgEl: SVGSVGElement,
  vbt: VBTransform,
  idOffset: number,
  canvasW: number,
  canvasH: number,
): SvgArea[] {
  console.log('[DCEL] ── Starting room detection ──────────────────────────');

  // 1. Extract
  const rawEdges = extractWallSegments(svgRoot, svgEl, vbt);
  if (rawEdges.length === 0) { console.log('[DCEL] No segments found'); return []; }

  // 2. Snap
  const { verts, edges: snapped } = snapVertices(rawEdges);

  // 3. Bridge gaps
  const bridged = bridgeGaps(verts, snapped);

  // 4. Split
  const split = splitIntersections(verts, bridged);

  // 5. Prune
  const pruned = pruneDangling(verts, split);
  if (pruned.length === 0) { console.log('[DCEL] Nothing survived prune'); return []; }

  // 6. Build DCEL
  const halfEdges = buildDCEL(verts, pruned);

  // 7 & 8. Trace + classify
  const faces = traceFaces(halfEdges);
  const roomFaces = classifyRooms(faces, canvasW, canvasH);
  if (roomFaces.length === 0) { console.log('[DCEL] No rooms after classify'); return []; }

  // Convert to SvgArea[]
  let areas: SvgArea[] = roomFaces.map((face, idx) => {
    const bounds = computeBounds(face.points);
    return {
      id:         `dcel-room-${idOffset + idx}`,
      type:       'area' as const,
      points:     face.points,
      bounds,
      area:       face.area,
      element:    svgEl as unknown as Element,
      attributes: { 'data-source': 'dcel' },
      label:      undefined,
    };
  });

  // 8b. Deduplicate
  areas = deduplicateRooms(areas);

  // 9. Label
  const labelled = assignLabels(areas, svgRoot, svgEl, vbt);

  console.log(
    `[DCEL] ── DONE: ${labelled.length} rooms, ` +
    `${labelled.filter(r => r.label).length} labelled ────────────────────`,
  );
  return labelled;
}
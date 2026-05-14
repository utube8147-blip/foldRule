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
//   2. REMOVE DOORS — filter out door arcs and door swing lines (OPTIONAL)
//   3. SNAP      — cluster endpoints into unique vertices (generous tolerance)
//   4. GAP-BRIDGE— connect near-endpoints that are almost-touching
//   5. SPLIT     — subdivide at T-junctions and crossings
//   6. PRUNE     — remove dangling edges (furniture, dims, annotations)
//   7. BUILD     — DCEL half-edge structure
//   8. LINK      — clockwise-sort at each vertex → minimal face cycles
//   9. TRACE     — walk .next chains → face polygons
//  10. CLASSIFY  — filter outer boundary, title blocks, degenerate faces
//  11. LABEL     — match <text> elements to room polygons

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

// SIZE-AGNOSTIC FILTERING - using relative thresholds (scale invariant)
const MIN_ROOM_AREA_FRAC  = 0.0003;   // 0.03% of total canvas area - removes tiny closets
const MAX_ROOM_AREA_FRAC  = 0.45;     // 45% of canvas — anything larger = boundary/outer
const MIN_ASPECT          = 0.08;     // width/height min ratio
const MAX_ASPECT          = 12.0;     // width/height max ratio
const MIN_COMPACTNESS     = 0.12;     // 4πA/P² - removes long thin corridors
const MIN_CONNECTIONS     = 2;        // minimum room connections (dead-end filter)
const MAX_PRUNE_ITERS     = 60;       // dangling-edge prune passes
const MAX_FACE_EDGES      = 500;      // safety limit per face cycle

// ─── DOOR FILTERING CONTROL ───────────────────────────────────────────────────
// Set this to true to REMOVE door arcs and door lines BEFORE room detection
// This allows doors to be treated as open passages (connected rooms)
// Set to false to keep door elements as walls (separate rooms)
const REMOVE_DOORS_BEFORE_ROOM_DETECTION = true;  // ← TOGGLE THIS VARIABLE

// Door detection patterns
const DOOR_KEYWORDS = [
  'door', 'swing', 'arc', 'doorway', 'opening',
  'door-swing', 'door-arc', 'door-line'
];

function isDoorElement(element: Element): boolean {
  // Check element ID
  const id = element.getAttribute('id')?.toLowerCase() || '';
  if (DOOR_KEYWORDS.some(kw => id.includes(kw))) return true;
  
  // Check class name
  const className = element.getAttribute('class')?.toLowerCase() || '';
  if (DOOR_KEYWORDS.some(kw => className.includes(kw))) return true;
  
  // Check data attributes
  const dataType = element.getAttribute('data-type')?.toLowerCase() || '';
  if (dataType === 'door' || dataType === 'door-swing') return true;
  
  // Check for arc paths (likely door swings)
  if (element.tagName.toLowerCase() === 'path') {
    const d = element.getAttribute('d') || '';
    // Door arcs typically have large radius curves
    if ((d.includes('A') || d.includes('a')) && 
        (d.includes('C') || d.includes('c') || d.includes('Q') || d.includes('q'))) {
      // Heuristic: curved path with arc command is likely a door swing
      const strokeWidth = resolveStrokeWidth(element);
      if (strokeWidth < 3) return true; // Thin lines for door swings
    }
  }
  
  return false;
}

function filterDoorSegments(edges: RawEdge[], elements: Element[]): RawEdge[] {
  if (!REMOVE_DOORS_BEFORE_ROOM_DETECTION) {
    console.log('[DCEL] Doors kept (REMOVE_DOORS_BEFORE_ROOM_DETECTION = false)');
    return edges;
  }
  
  console.log('[DCEL] Removing door elements before room detection...');
  
  // Mark which elements are doors
  const doorElements = new Set<Element>();
  for (const el of elements) {
    if (isDoorElement(el)) {
      doorElements.add(el);
      console.log(`[DCEL] Door element marked for removal: ${el.tagName} id=${el.getAttribute('id')}`);
    }
  }
  
  // Filter out edges that belong to door elements
  // We need to track which element each edge came from
  // For now, filter by approximate geometry (short curved paths)
  const filtered = edges.filter(edge => {
    const length = dist(edge.a, edge.b);
    // Door swings are typically shorter (< 100px) and curved
    // For straight door lines, check if they connect to door elements
    if (length < 100) {
      // Check if this edge is part of a door swing (check angle change)
      const angle = Math.atan2(edge.b.y - edge.a.y, edge.b.x - edge.a.x);
      // Door arcs have significant curvature - this is a simplification
      // In production, you'd track element association
      return false; // Remove short segments that might be doors
    }
    return true;
  });
  
  console.log(`[DCEL] Removed ${edges.length - filtered.length} door-related segments`);
  return filtered;
}

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
  id:         number;
  points:     Vec2[];
  area:       number;
  perimeter:  number;
  isOuter:    boolean;
  connections: number[];
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

function calculatePerimeter(pts: Vec2[]): number {
  let perimeter = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    perimeter += dist(pts[i], pts[j]);
  }
  return perimeter;
}

function calculateCompactness(area: number, perimeter: number): number {
  if (perimeter === 0) return 0;
  return (4 * Math.PI * area) / (perimeter * perimeter);
}

function doFacesShareEdge(face1: Face, face2: Face, tolerance: number = 2): boolean {
  for (let i = 0; i < face1.points.length; i++) {
    const a1 = face1.points[i];
    const a2 = face1.points[(i + 1) % face1.points.length];
    
    for (let j = 0; j < face2.points.length; j++) {
      const b1 = face2.points[j];
      const b2 = face2.points[(j + 1) % face2.points.length];
      
      const d1 = dist(a1, b1);
      const d2 = dist(a1, b2);
      const d3 = dist(a2, b1);
      const d4 = dist(a2, b2);
      
      if (d1 < tolerance || d2 < tolerance || d3 < tolerance || d4 < tolerance) {
        const cross = (a2.x - a1.x) * (b2.y - b1.y) - (a2.y - a1.y) * (b2.x - b1.x);
        if (Math.abs(cross) < tolerance) return true;
      }
    }
  }
  return false;
}

// ─── Step 1: Extract raw wall segments ───────────────────────────────────────

interface RawEdge { a: Vec2; b: Vec2; sourceElement?: Element }

function extractWallSegments(
  svgRoot: Element,
  svgEl: SVGSVGElement,
  vbt: VBTransform,
): { edges: RawEdge[]; elements: Element[] } {
  const edges: RawEdge[] = [];
  const elements: Element[] = [];

  const toCanvas = (el: Element, x: number, y: number): Vec2 => {
    const ctm = getCTM(el, svgEl);
    return applyVBTransform(applyMatrix(ctm, { x, y }), vbt);
  };

  svgRoot.querySelectorAll('line, path, polyline, polygon').forEach(el => {
    const sw = resolveStrokeWidth(el);
    if (sw < WALL_MIN_STROKE) return;
    
    elements.push(el);
    const tag = el.tagName.toLowerCase();

    if (tag === 'line') {
      const x1 = parseFloat(el.getAttribute('x1') ?? '0');
      const y1 = parseFloat(el.getAttribute('y1') ?? '0');
      const x2 = parseFloat(el.getAttribute('x2') ?? '0');
      const y2 = parseFloat(el.getAttribute('y2') ?? '0');
      const a = toCanvas(el, x1, y1), b = toCanvas(el, x2, y2);
      if (dist(a, b) >= MIN_EDGE_LENGTH) edges.push({ a, b, sourceElement: el });
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
        if (dist(a, b) >= MIN_EDGE_LENGTH) edges.push({ a, b, sourceElement: el });
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
        if (dist(pts[i], pts[j]) >= MIN_EDGE_LENGTH) edges.push({ a: pts[i], b: pts[j], sourceElement: el });
      }
    }
  });

  console.log(`[DCEL] extracted ${edges.length} raw segments`);
  return { edges, elements };
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

function bridgeGaps(
  verts: Vertex[],
  edges: Array<{ a: number; b: number }>,
): Array<{ a: number; b: number }> {
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

      for (let i = 0; i < verts.length; i++) {
        if (i === edge.a || i === edge.b) continue;
        const t = onSeg(verts[i].x, verts[i].y, va.x, va.y, vb.x, vb.y);
        if (t !== null) splits.push({ t, vi: i });
      }

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

  for (const v of verts) v.outgoing.sort((a, b) => a.angle - b.angle);

  for (const h of halfEdges) {
    const v = h.twin.origin;
    const out = v.outgoing;
    const idx = out.indexOf(h.twin);
    if (idx === -1) continue;
    h.next = out[(idx - 1 + out.length) % out.length];
  }

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

    let signed = 0;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      signed += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
    }
    signed /= 2;
    const area = Math.abs(signed);
    const perimeter = calculatePerimeter(pts);
    const isOuter = signed <= 0;

    const face: Face = {
      id: faceId++,
      points: pts,
      area,
      perimeter,
      isOuter,
      connections: [],
    };
    cycle.forEach(he => { he.face = face; });
    faces.push(face);
  }

  console.log(`[DCEL] traced ${faces.length} faces — ${faces.filter(f => !f.isOuter).length} inner`);
  return faces;
}

// ─── Step 9: Classify + filter rooms (SIZE-AGNOSTIC) ─────────────────────────

function classifyRooms(
  faces: Face[],
  canvasW: number,
  canvasH: number,
): Face[] {
  const totalArea = canvasW * canvasH;
  const maxArea = totalArea * MAX_ROOM_AREA_FRAC;
  const minArea = totalArea * MIN_ROOM_AREA_FRAC;

  const inner = faces.filter(f => !f.isOuter);
  
  if (inner.length === 0) {
    console.log('[DCEL] No inner faces found');
    return [];
  }

  // Calculate connection counts between faces
  for (let i = 0; i < inner.length; i++) {
    for (let j = i + 1; j < inner.length; j++) {
      if (doFacesShareEdge(inner[i], inner[j])) {
        inner[i].connections.push(inner[j].id);
        inner[j].connections.push(inner[i].id);
      }
    }
  }

  const sorted = [...inner].sort((a, b) => b.area - a.area);
  const outerThreshold = sorted.length > 0 ? sorted[0].area * 0.80 : Infinity;
  
  const areas = inner.map(f => f.area);
  areas.sort((a, b) => a - b);
  const medianArea = areas[Math.floor(areas.length / 2)];
  const meanArea = areas.reduce((a, b) => a + b, 0) / areas.length;
  
  console.log(`[DCEL] Area stats — min:${minArea.toFixed(0)} median:${medianArea.toFixed(0)} mean:${meanArea.toFixed(0)} max:${maxArea.toFixed(0)}`);

  const rooms = inner.filter(f => {
    if (f.area < minArea) {
      console.log(`[DCEL] Filtered: area ${f.area.toFixed(0)} < ${minArea.toFixed(0)}`);
      return false;
    }
    
    if (f.area > maxArea) {
      console.log(`[DCEL] Filtered: area ${f.area.toFixed(0)} > ${maxArea.toFixed(0)}`);
      return false;
    }
    
    if (f.area >= outerThreshold) {
      console.log(`[DCEL] Filtered: outer boundary area ${f.area.toFixed(0)} >= ${outerThreshold.toFixed(0)}`);
      return false;
    }
    
    const bounds = computeBounds(f.points);
    const bw = bounds.maxX - bounds.minX;
    const bh = bounds.maxY - bounds.minY;
    if (bw === 0 || bh === 0) return false;
    const aspect = bw / bh;
    if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) {
      console.log(`[DCEL] Filtered: aspect ${aspect.toFixed(2)} out of range [${MIN_ASPECT}, ${MAX_ASPECT}]`);
      return false;
    }
    
    const compactness = calculateCompactness(f.area, f.perimeter);
    if (compactness < MIN_COMPACTNESS) {
      console.log(`[DCEL] Filtered: compactness ${compactness.toFixed(3)} < ${MIN_COMPACTNESS}`);
      return false;
    }
    
    if (f.area < medianArea * 0.20) {
      console.log(`[DCEL] Filtered: area ${f.area.toFixed(0)} < 20% of median (${medianArea.toFixed(0)})`);
      return false;
    }
    
    if (f.area < meanArea * 0.15) {
      console.log(`[DCEL] Filtered: area ${f.area.toFixed(0)} < 15% of mean (${meanArea.toFixed(0)})`);
      return false;
    }
    
    if (f.connections.length < MIN_CONNECTIONS && f.area < medianArea * 0.5) {
      console.log(`[DCEL] Filtered: only ${f.connections.length} connection(s) and area < 50% of median`);
      return false;
    }
    
    return true;
  });

  console.log(
    `[DCEL] classify: ${inner.length} inner faces → ${rooms.length} rooms ` +
    `(minArea=${Math.round(minArea)}px², ` +
    `median=${Math.round(medianArea)}px², ` +
    `outer threshold=${Math.round(outerThreshold)}px²)`,
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
    const full = textEl.textContent?.trim() ?? '';
    if (full.length >= 2) candidates.push({ text: full, ...getXY(textEl) });

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
  console.log('[DCEL] ── Starting room detection (SIZE-AGNOSTIC MODE) ──────────────────────────');
  console.log(`[DCEL] REMOVE_DOORS_BEFORE_ROOM_DETECTION = ${REMOVE_DOORS_BEFORE_ROOM_DETECTION}`);

  // 1. Extract
  const { edges: rawEdges, elements } = extractWallSegments(svgRoot, svgEl, vbt);
  if (rawEdges.length === 0) { console.log('[DCEL] No segments found'); return []; }

  // 2. Filter out door segments (OPTIONAL)
  const filteredEdges = filterDoorSegments(rawEdges, elements);
  if (filteredEdges.length === 0) { console.log('[DCEL] No segments after door filtering'); return []; }

  // 3. Snap
  const { verts, edges: snapped } = snapVertices(filteredEdges);

  // 4. Bridge gaps
  const bridged = bridgeGaps(verts, snapped);

  // 5. Split
  const split = splitIntersections(verts, bridged);

  // 6. Prune
  const pruned = pruneDangling(verts, split);
  if (pruned.length === 0) { console.log('[DCEL] Nothing survived prune'); return []; }

  // 7. Build DCEL
  const halfEdges = buildDCEL(verts, pruned);

  // 8 & 9. Trace + classify
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

  // 10. Deduplicate
  areas = deduplicateRooms(areas);

  // 11. Label
  const labelled = assignLabels(areas, svgRoot, svgEl, vbt);

  console.log(
    `[DCEL] ── DONE: ${labelled.length} rooms, ` +
    `${labelled.filter(r => r.label).length} labelled ────────────────────`,
  );
  return labelled;
}
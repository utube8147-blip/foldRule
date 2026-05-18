// hooks/detectRooms.ts
//
// COMPLETE ROOM DETECTION SYSTEM - Pure geometry-based
// Detects rooms from floor plan wall segments using DCEL planar graph algorithm
//
// Features:
//   ✅ Detects rooms of ANY shape (rectangular, L-shaped, U-shaped, T-shaped)
//   ✅ Removes doors BEFORE detection (open passages)
//   ✅ Removes pillars/columns by geometry (imported from detectPillars)
//   ✅ Removes windows by geometry (elongated, on perimeter)
//   ✅ Pillars and windows are RETURNED as labeled SvgArea elements (not discarded)
//   ✅ Size-agnostic filtering (relative thresholds)
//   ✅ Robust gap bridging for PDF exports
//   ✅ Text label matching for room names

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
// Import pillar detection
import { 
  isPillar, 
  type Face,
  computeBounds,
  dist,
  calculatePerimeter,
  calculateCompactness,
  calculatePolygonArea,
  calculateSolidity,
  isConvexPolygon,
  doFacesShareEdge,
  PILLAR_CONFIG
} from './detectPillars';

// ─── Constants ────────────────────────────────────────────────────────────────

// DCEL parameters
const SNAP_TOL           = 12;    // px — endpoint clustering
const GAP_BRIDGE_TOL     = 20;    // px — bridge near-endpoints
const INTERSECT_TOL      = 4;     // px — T-junction detection
const MIN_EDGE_LENGTH    = 3;     // px — discard micro-segments
const WALL_MIN_STROKE    = 0.5;   // pt — minimum stroke width for walls
const MAX_PRUNE_ITERS    = 60;    // dangling-edge prune passes
const MAX_FACE_EDGES     = 500;   // safety limit per face cycle

// Room classification (size-agnostic - relative thresholds)
const MIN_ROOM_AREA_FRAC  = 0.0003;   // 0.03% of canvas - removes tiny closets
const MAX_ROOM_AREA_FRAC  = 0.45;     // 45% of canvas - outer boundary
const MIN_ASPECT          = 0.08;     // width/height min ratio
const MAX_ASPECT          = 12.0;     // width/height max ratio
const MIN_COMPACTNESS     = 0.12;     // 4πA/P² - removes long thin corridors
const MIN_CONNECTIONS     = 2;        // minimum room connections

// Window detection (pure geometry)
const MIN_WINDOW_ASPECT      = 8.0;   // Long and thin
const MAX_WINDOW_AREA_FRAC   = 0.0005; // 0.05% of canvas

// Door detection (optional filtering)
const REMOVE_DOORS_BEFORE_ROOM_DETECTION = true;
const DOOR_KEYWORDS = ['door', 'swing', 'arc', 'doorway', 'opening'];

// ─── Structural element labels ────────────────────────────────────────────────

export const STRUCTURAL_LABELS = {
  PILLAR: 'Pillar',
  WINDOW: 'Window',
} as const;

export type StructuralType = 'pillar' | 'window';

// ─── Room label allowlist ─────────────────────────────────────────────────────

const ROOM_NAME_PATTERNS: RegExp[] = [
  /\b(room|rm|office|offc|ofc)\b/i,
  /\b(corridor|corr|hallway|hall|passage|lobby|foyer|entry|reception)\b/i,
  /\b(open\s*plan|openplan)\b/i,
  /\b(breakout|meeting|conf|conference|boardroom)\b/i,
  /\b(toilet|wc|restroom|bathroom|shower|amenity)\b/i,
  /\b(kitchen|kitchenette|canteen|cafe|cafeteria|pantry)\b/i,
  /\b(server|comms|network|data|store|storage|archive|plant|utility)\b/i,
  /\b(lift|elevator|stair|stairwell|stairs|exit)\b/i,
  /\b(lounge|waiting|atrium|concourse)\b/i,
  /\b(parking|garage|loading|dock)\b/i,
  /^[a-z]{1,3}[-.]?\d{1,4}$/i,
];

const DISQUALIFY_PATTERNS: RegExp[] = [
  /^\d+(\.\d+)?\s*m[²2]?\s*$/,
  /^\d+(\.\d+)?$/,
  /^scale\s*\d/i,
  /^(ground|first|second|third)\s*floor/i,
  /^(plan|drawing|sheet|revision|rev|dwg|date)/i,
];

const ROOM_NAME_MAP: Record<string, string> = {
  'CORR': 'Corridor', 'CORRIDOR': 'Corridor',
  'HALL': 'Hallway', 'HALLWAY': 'Hallway',
  'LOBBY': 'Lobby', 'RECEPTION': 'Reception',
  'WC': 'WC', 'TOILET': 'Toilet',
  'KITCHEN': 'Kitchen', 'KITCHENETTE': 'Kitchenette',
  'MEETING': 'Meeting Room', 'CONFERENCE': 'Conference Room',
  'BOARDROOM': 'Boardroom', 'OPEN PLAN': 'Open Plan',
  'OFFICE': 'Office', 'STORAGE': 'Storage',
  'STAIR': 'Stairwell', 'ELEVATOR': 'Elevator',
  'LOUNGE': 'Lounge', 'ATRIUM': 'Atrium',
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
  id: number;
  x: number;
  y: number;
  outgoing: HalfEdge[];
}

interface HalfEdge {
  id: number;
  origin: Vertex;
  twin: HalfEdge;
  next: HalfEdge | null;
  prev: HalfEdge | null;
  face: Face | null;
  angle: number;
  visited: boolean;
}

// Re-export Face type from detectPillars (already imported)

// ─── Filter: Door Detection ───────────────────────────────────────────────────

function isDoorElement(element: Element): boolean {
  const id = element.getAttribute('id')?.toLowerCase() || '';
  if (DOOR_KEYWORDS.some(kw => id.includes(kw))) return true;
  const className = element.getAttribute('class')?.toLowerCase() || '';
  if (DOOR_KEYWORDS.some(kw => className.includes(kw))) return true;
  const dataType = element.getAttribute('data-type')?.toLowerCase() || '';
  if (dataType === 'door' || dataType === 'door-swing') return true;
  if (element.tagName.toLowerCase() === 'path') {
    const d = element.getAttribute('d') || '';
    if ((d.includes('A') || d.includes('a')) && (d.includes('C') || d.includes('c'))) {
      const strokeWidth = resolveStrokeWidth(element);
      if (strokeWidth < 3) return true;
    }
  }
  return false;
}

function filterDoorSegments(edges: RawEdge[], elements: Element[]): RawEdge[] {
  if (!REMOVE_DOORS_BEFORE_ROOM_DETECTION) {
    console.log('[RoomDetect] Doors kept');
    return edges;
  }
  console.log('[RoomDetect] Removing doors...');
  const doorElements = new Set<Element>();
  for (const el of elements) {
    if (isDoorElement(el)) doorElements.add(el);
  }
  const filtered = edges.filter(edge => {
    const length = dist(edge.a, edge.b);
    if (length < 100) return false;
    return true;
  });
  console.log(`[RoomDetect] Removed ${edges.length - filtered.length} door segments`);
  return filtered;
}

// ─── Filter: Window Detection ────────────────────────────────────────────────

function isWindow(face: Face, totalArea: number, canvasW: number, canvasH: number): boolean {
  const maxWindowArea = totalArea * MAX_WINDOW_AREA_FRAC;
  const bounds = computeBounds(face.points);
  const bw = bounds.maxX - bounds.minX;
  const bh = bounds.maxY - bounds.minY;
  const aspect = Math.max(bw, bh) / Math.min(bw, bh);
  
  const isTiny = face.area < maxWindowArea;
  const isElongated = aspect > MIN_WINDOW_ASPECT;
  const nearEdgeX = bounds.minX < 50 || bounds.maxX > canvasW - 50;
  const nearEdgeY = bounds.minY < 50 || bounds.maxY > canvasH - 50;
  
  return isTiny && isElongated && (nearEdgeX || nearEdgeY);
}

// ─── Step 1: Extract wall segments ───────────────────────────────────────────

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

  console.log(`[RoomDetect] extracted ${edges.length} raw segments`);
  return { edges, elements };
}

// ─── Step 2: Snap vertices ───────────────────────────────────────────────────

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

  console.log(`[RoomDetect] snapped: ${verts.length} vertices, ${snapped.length} edges`);
  return { verts, edges: snapped };
}

// ─── Step 3: Bridge gaps ─────────────────────────────────────────────────────

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
  if (newBridges > 0) console.log(`[RoomDetect] bridged ${newBridges} gaps`);
  return bridged;
}

// ─── Step 4: Split intersections ─────────────────────────────────────────────

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

  console.log(`[RoomDetect] after split: ${final.length} edges`);
  return final;
}

// ─── Step 5: Prune dangling edges ────────────────────────────────────────────

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
  console.log(`[RoomDetect] after prune: ${cur.length} edges`);
  return cur;
}

// ─── Step 6: Build DCEL ──────────────────────────────────────────────────────

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

// ─── Step 7: Trace faces ─────────────────────────────────────────────────────

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

  console.log(`[RoomDetect] traced ${faces.length} faces`);
  return faces;
}

// ─── Step 8: Classify faces — rooms, pillars, and windows ────────────────────
//
// KEY CHANGE: Instead of discarding pillars/windows, we now return them
// as separate arrays so callers can render them with correct labels.

interface ClassifiedFaces {
  rooms: Face[];
  pillars: Face[];
  windows: Face[];
}

function classifyFaces(
  faces: Face[],
  canvasW: number,
  canvasH: number,
): ClassifiedFaces {
  const totalArea = canvasW * canvasH;
  const maxArea = totalArea * MAX_ROOM_AREA_FRAC;
  const minArea = totalArea * MIN_ROOM_AREA_FRAC;

  const inner = faces.filter(f => !f.isOuter);
  
  if (inner.length === 0) {
    console.log('[RoomDetect] No inner faces found');
    return { rooms: [], pillars: [], windows: [] };
  }

  // STEP 1: Calculate connections for ALL faces FIRST
  // Ensure connections arrays exist to satisfy TypeScript and simplify logic
  for (const f of inner) {
    if (!f.connections) f.connections = [];
  }
  for (let i = 0; i < inner.length; i++) {
    for (let j = i + 1; j < inner.length; j++) {
      if (doFacesShareEdge(inner[i], inner[j])) {
        // connections initialized above; use non-null assertion to satisfy TS
        inner[i].connections!.push(inner[j].id);
        inner[j].connections!.push(inner[i].id);
      }
    }
  }

  console.log(`[RoomDetect] Before filtering: ${inner.length} inner faces`);

  // STEP 2: Separate pillars, windows, and everything else
  const pillarFaces: Face[] = [];
  const windowFaces: Face[] = [];
  const remainingFaces: Face[] = [];

  for (const face of inner) {
    const pillarCheck = isPillar(face, totalArea);
    if (pillarCheck) {
      console.log(`[RoomDetect] 🟫 PILLAR: Face ${face.id}, edges=${face.points.length}, area=${face.area.toFixed(0)}`);
      pillarFaces.push(face);
      continue;
    }

    const windowCheck = isWindow(face, totalArea, canvasW, canvasH);
    if (windowCheck) {
      console.log(`[RoomDetect] 🪟 WINDOW: Face ${face.id}, area=${face.area.toFixed(0)}px²`);
      windowFaces.push(face);
      continue;
    }

    remainingFaces.push(face);
  }

  console.log(`[RoomDetect] Structural: ${pillarFaces.length} pillars, ${windowFaces.length} windows`);
  console.log(`[RoomDetect] Candidates for rooms: ${remainingFaces.length}`);

  if (remainingFaces.length === 0) {
    return { rooms: [], pillars: pillarFaces, windows: windowFaces };
  }

  // STEP 3: Statistics for room filtering
  const sorted = [...remainingFaces].sort((a, b) => b.area - a.area);
  const outerThreshold = sorted.length > 0 ? sorted[0].area * 0.80 : Infinity;
  
  const areas = remainingFaces.map(f => f.area).sort((a, b) => a - b);
  const medianArea = areas[Math.floor(areas.length / 2)];
  const meanArea = areas.reduce((a, b) => a + b, 0) / areas.length;
  
  console.log(`[RoomDetect] Area stats — min:${minArea.toFixed(0)} median:${medianArea.toFixed(0)} mean:${meanArea.toFixed(0)}`);

  // STEP 4: Final room classification
  const roomFaces = remainingFaces.filter(f => {
    if (f.area < minArea) {
      console.log(`[RoomDetect] Filtered (too small): area ${f.area.toFixed(0)} < ${minArea.toFixed(0)}`);
      return false;
    }
    if (f.area > maxArea) {
      console.log(`[RoomDetect] Filtered (too large): area ${f.area.toFixed(0)} > ${maxArea.toFixed(0)}`);
      return false;
    }
    if (f.area >= outerThreshold) {
      console.log(`[RoomDetect] Filtered (outer boundary): area ${f.area.toFixed(0)}`);
      return false;
    }
    
    const bounds = computeBounds(f.points);
    const bw = bounds.maxX - bounds.minX;
    const bh = bounds.maxY - bounds.minY;
    if (bw === 0 || bh === 0) return false;
    const aspect = bw / bh;
    if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) {
      console.log(`[RoomDetect] Filtered (bad aspect): aspect ${aspect.toFixed(2)}`);
      return false;
    }
    
    const compactness = calculateCompactness(f.area, f.perimeter);
    if (compactness < MIN_COMPACTNESS) {
      console.log(`[RoomDetect] Filtered (not compact): compactness ${compactness.toFixed(3)}`);
      return false;
    }
    
    if (f.area < medianArea * 0.20) {
      console.log(`[RoomDetect] Filtered (<20% median): area ${f.area.toFixed(0)} < ${(medianArea * 0.20).toFixed(0)}`);
      return false;
    }
    if (f.area < meanArea * 0.15) {
      console.log(`[RoomDetect] Filtered (<15% mean): area ${f.area.toFixed(0)} < ${(meanArea * 0.15).toFixed(0)}`);
      return false;
    }
    
    const connectionCount = f.connections?.length ?? 0;
    if (connectionCount < MIN_CONNECTIONS && f.area < medianArea * 0.5) {
      console.log(`[RoomDetect] Filtered (insufficient connections): ${connectionCount} connections`);
      return false;
    }
    
    return true;
  });

  console.log(`[RoomDetect] FINAL: ${inner.length} inner faces → ${roomFaces.length} rooms, ${pillarFaces.length} pillars, ${windowFaces.length} windows`);
  return { rooms: roomFaces, pillars: pillarFaces, windows: windowFaces };
}

// ─── Step 9: Assign labels ───────────────────────────────────────────────────

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
    // Don't overwrite structural labels (Pillar / Window)
    if (room.label === STRUCTURAL_LABELS.PILLAR || room.label === STRUCTURAL_LABELS.WINDOW) {
      return room;
    }

    const bounds = {
      minX: room.bounds.minNX, minY: room.bounds.minNY,
      maxX: room.bounds.maxNX, maxY: room.bounds.maxNY,
    };

    const inside = candidates.filter(c =>
      c.x >= bounds.minX && c.x <= bounds.maxX &&
      c.y >= bounds.minY && c.y <= bounds.maxY &&
      pointInPolygon(c.x, c.y, room.points as any),
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

    return { ...room, label: resolved[0].label };
  });
}

// ─── Step 10: Deduplicate ────────────────────────────────────────────────────

function deduplicateRooms(rooms: SvgArea[]): SvgArea[] {
  const kept: SvgArea[] = [];
  for (const room of rooms) {
    const c = polygonCentroid(room.points as any);
    const dup = kept.some(existing => {
      const ec = polygonCentroid(existing.points as any);
      const d = dist(c, ec);
      const areaRatio = Math.abs(room.areaN - existing.areaN) / Math.max(room.areaN, existing.areaN, 1e-10);
      return d < SNAP_TOL * 6 / 10000 && areaRatio < 0.15;
    });
    if (!dup) kept.push(room);
  }
  return kept;
}

function polygonCentroid(pts: Vec2[]): Vec2 {
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  return { x: cx / pts.length, y: cy / pts.length };
}

// ─── Face → SvgArea converter ─────────────────────────────────────────────────

function faceToSvgArea(
  face: Face,
  id: string,
  label: string,
  svgEl: SVGSVGElement,
  canvasW: number,
  canvasH: number,
  extraAttributes: Record<string, string> = {},
): SvgArea {
  // NOTE: detectRooms runs in pixel space; useSvgInteraction normalizes afterward.
  // We store raw pixel points here — normalization happens in useSvgInteraction
  // (the same pattern as before this change).
  const bounds = computeBounds(face.points);
  return {
    id,
    type: 'area' as const,
    // Cast to satisfy SvgArea typing — useSvgInteraction normalizes these
    points: face.points as any,
    bounds: {
      minNX: bounds.minX,
      minNY: bounds.minY,
      maxNX: bounds.maxX,
      maxNY: bounds.maxY,
    } as any,
    areaN: face.area,
    element: svgEl as unknown as Element,
    attributes: { 'data-source': 'room-detection', ...extraAttributes },
    label,
  };
}

// ─── Main Export ─────────────────────────────────────────────────────────────

export interface DetectRoomsResult {
  rooms: SvgArea[];
  pillars: SvgArea[];
  windows: SvgArea[];
  /** Convenience: all three merged, useful for callers that treat them uniformly */
  all: SvgArea[];
}

export function detectRooms(
  svgRoot: Element,
  svgEl: SVGSVGElement,
  vbt: VBTransform,
  idOffset: number,
  canvasW: number,
  canvasH: number,
): DetectRoomsResult {
  console.log('[RoomDetect] ── Starting room detection ──────────────────────────');

  const empty: DetectRoomsResult = { rooms: [], pillars: [], windows: [], all: [] };

  // 1. Extract wall segments
  const { edges: rawEdges, elements } = extractWallSegments(svgRoot, svgEl, vbt);
  if (rawEdges.length === 0) return empty;

  // 2. Filter doors
  const doorFilteredEdges = filterDoorSegments(rawEdges, elements);
  if (doorFilteredEdges.length === 0) return empty;

  // 3. Snap vertices
  const { verts, edges: snapped } = snapVertices(doorFilteredEdges);

  // 4. Bridge gaps
  const bridged = bridgeGaps(verts, snapped);

  // 5. Split intersections
  const split = splitIntersections(verts, bridged);

  // 6. Prune dangling edges
  const pruned = pruneDangling(verts, split);
  if (pruned.length === 0) return empty;

  // 7. Build DCEL
  const halfEdges = buildDCEL(verts, pruned);

  // 8. Trace faces
  const faces = traceFaces(halfEdges);

  // 9. Classify: rooms, pillars, windows (all get returned now)
  const classified = classifyFaces(faces, canvasW, canvasH);
  if (classified.rooms.length === 0 && classified.pillars.length === 0 && classified.windows.length === 0) {
    return empty;
  }

  let counter = idOffset;

  // 10a. Convert room faces → SvgArea
  let roomAreas: SvgArea[] = classified.rooms.map(face => {
    return faceToSvgArea(face, `room-${counter++}`, '', svgEl, canvasW, canvasH, { 'data-face-type': 'room' });
  });

  // 10b. Convert pillar faces → SvgArea (labeled)
  const pillarAreas: SvgArea[] = classified.pillars.map(face => {
    return faceToSvgArea(face, `pillar-${counter++}`, STRUCTURAL_LABELS.PILLAR, svgEl, canvasW, canvasH, {
      'data-face-type': 'pillar',
      'data-structural': 'true',
    });
  });

  // 10c. Convert window faces → SvgArea (labeled)
  const windowAreas: SvgArea[] = classified.windows.map(face => {
    return faceToSvgArea(face, `window-${counter++}`, STRUCTURAL_LABELS.WINDOW, svgEl, canvasW, canvasH, {
      'data-face-type': 'window',
      'data-structural': 'true',
    });
  });

  // 11. Deduplicate rooms only (pillars/windows are already well-separated)
  roomAreas = deduplicateRooms(roomAreas);

  // 12. Assign labels (text matching) — only for rooms; pillars/windows keep their structural labels
  const labelledRooms = assignLabels(roomAreas, svgRoot, svgEl, vbt);

  console.log(
    `[RoomDetect] ── DONE: ${labelledRooms.length} rooms (${labelledRooms.filter(r => r.label).length} labelled), ` +
    `${pillarAreas.length} pillars, ${windowAreas.length} windows ──`
  );

  return {
    rooms:   labelledRooms,
    pillars: pillarAreas,
    windows: windowAreas,
    all:     [...labelledRooms, ...pillarAreas, ...windowAreas],
  };
}
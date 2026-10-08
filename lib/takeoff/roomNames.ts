// Rooms named on a drawing. Architects label rooms ("BEDROOM 2") and often print the area
// beside the name ("14.20 m²") or the size ("4.50 x 3.20"). This reads those from the page's
// text, and uses them to suggest names for measurements: a floor area drawn round the label
// "Bedroom 1" is probably Bedroom 1's floor. Suggestions only; nothing is renamed without a click.
// A scanned plan has no text, so there is nothing to read.

export interface TextItem { str: string; x: number; y: number; w: number; h: number }
export interface Room {
  name: string;
  /** Centre of the label, in the same units as the text items. */
  x: number; y: number;
  /** Area printed on the drawing, m². */
  statedArea?: number;
  /** How the area was found. */
  from?: 'area label' | 'dimensions';
  /** The text it was read from. */
  evidence?: string;
}

const ROOM_WORDS = /\b(bed\s?room|master|living|dining|kitchen|pantry|bath(room)?|toilet|w\.?c\.?|powder|lobby|hall|corridor|passage|store|storage|laundry|maid'?s?|driver|majlis|office|balcony|terrace|garage|parking|stair(case|s)?|lift|entrance|entry|family|guest|dressing|closet|wardrobe|prayer|utility|study|lounge|foyer|reception|shop|sitting|play\s?room|gym|pump|electrical|plant|server|meeting|conference|room|rm\.?)\b/i;
const NOT_ROOMS = /\b(scale|drawing|drawn|checked|date|rev(ision)?|project|client|sheet|title|plan|level|floor plan|section|elevation|detail|notes?|legend|north|door|window|schedule|typ(ical)?|ffl|sfl|architect|consultant|contractor|dimension)\b/i;
const AREA = /(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:m²|m2|sq\.?\s?m\.?|sqm|㎡)/i;
const AREA_PREFIX = /\b(?:area|a)\s*[=:]\s*(\d{1,4}(?:[.,]\d{1,2})?)\b/i;
const DIMS = /(\d{1,3}(?:[.,]\d{1,3})?)\s*(?:m|mm)?\s*[x×*]\s*(\d{1,3}(?:[.,]\d{1,3})?)\s*(m|mm)?/i;
const num = (s: string) => parseFloat(s.replace(',', '.'));

/** pdf.js hands words over in pieces: join the ones sitting side by side on a line. */
export function joinLines(items: TextItem[]): TextItem[] {
  const sorted = items.filter(i => i.str.trim()).sort((a, b) => a.y - b.y || a.x - b.x);
  const out: TextItem[] = [];
  for (const it of sorted) {
    const last = out[out.length - 1];
    const sameLine = last && Math.abs(last.y - it.y) < Math.max(last.h, it.h) * 0.5;
    const gap = last ? it.x - (last.x + last.w) : Infinity;
    if (sameLine && gap > -it.h && gap < Math.max(last.h, it.h) * 1.2) {
      last.str = `${last.str}${gap > it.h * 0.25 && !/\s$/.test(last.str) ? ' ' : ''}${it.str}`;
      last.w = it.x + it.w - last.x; last.h = Math.max(last.h, it.h);
    } else out.push({ ...it, str: it.str });
  }
  return out.map(o => ({ ...o, str: o.str.replace(/\s+/g, ' ').trim() }));
}

function areaIn(s: string): { area: number; from: Room['from'] } | null {
  const a = s.match(AREA) ?? s.match(AREA_PREFIX);
  if (a) { const v = num(a[1]); if (v > 0.5 && v < 5000) return { area: v, from: 'area label' }; }
  const d = s.match(DIMS);
  if (d) {
    let p = num(d[1]), q = num(d[2]);
    if (d[3]?.toLowerCase() === 'mm' || (p > 100 && q > 100)) { p /= 1000; q /= 1000; }
    if (p > 0.5 && q > 0.5 && p < 60 && q < 60) return { area: Math.round(p * q * 100) / 100, from: 'dimensions' };
  }
  return null;
}

const isRoomName = (s: string) => {
  const words = s.split(' ').length;
  return s.length >= 2 && s.length <= 32 && words <= 4 && /[a-z]/i.test(s) && ROOM_WORDS.test(s) && !NOT_ROOMS.test(s);
};
const tidy = (s: string) => s.replace(AREA, '').replace(AREA_PREFIX, '').replace(DIMS, '').replace(/[\s\-–:,(]+$/g, '').replace(/\s+/g, ' ').trim()
  .toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()).replace(/\bWc\b/i, 'WC');

/** Rooms named on a page, each with the area printed nearest its label (if any). */
export function findRooms(items: TextItem[]): Room[] {
  const lines = joinLines(items);
  const labels = lines.filter(l => isRoomName(tidy(l.str)));
  const numbers = lines.map(l => ({ l, a: areaIn(l.str) })).filter(n => n.a);
  const taken = new Set<TextItem>();
  const rooms: Room[] = [];
  for (const l of labels) {
    const cx = l.x + l.w / 2, cy = l.y + l.h / 2;
    const room: Room = { name: tidy(l.str), x: cx, y: cy };
    const own = areaIn(l.str);                               // "BEDROOM 1  14.2 m²" on one line
    if (own) { room.statedArea = own.area; room.from = own.from; room.evidence = l.str; }
    else {
      // Otherwise the closest area text, within a few label-heights and not across the page.
      let best: typeof numbers[number] | undefined, bestD = Infinity;
      for (const n of numbers) {
        if (taken.has(n.l) || n.l === l) continue;
        const dx = n.l.x + n.l.w / 2 - cx, dy = n.l.y + n.l.h / 2 - cy;
        const d = Math.hypot(dx, dy * 1.2);
        if (d < bestD && Math.abs(dy) < l.h * 6 && Math.abs(dx) < Math.max(l.w * 1.5, l.h * 8)) { best = n; bestD = d; }
      }
      if (best) { taken.add(best.l); room.statedArea = best.a!.area; room.from = best.a!.from; room.evidence = best.l.str; }
    }
    rooms.push(room);
  }
  // The same room name twice ("Bedroom" in two flats) gets a number so rows can be told apart.
  const seen = new Map<string, number>();
  const dupes = new Set(rooms.map(r => r.name).filter((n, i, a) => a.indexOf(n) !== i));
  return rooms.map(r => {
    if (!dupes.has(r.name)) return r;
    const k = (seen.get(r.name) ?? 0) + 1; seen.set(r.name, k);
    return { ...r, name: `${r.name} (${k})` };
  });
}

// ─── Suggesting names for measurements ───────────────────────────────────────

type Pt = { x: number; y: number };

function inside(poly: Pt[], p: Pt): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if ((poly[i].y > p.y) !== (poly[j].y > p.y) && p.x < ((poly[j].x - poly[i].x) * (p.y - poly[i].y)) / (poly[j].y - poly[i].y) + poly[i].x) c = !c;
  }
  return c;
}
function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export interface RowShape { type: string; points: Pt[]; isGroupHeader?: boolean }

const AREA_TYPES = /area|polygon|rectangle|circle|fill/i;
const COUNT_TYPES = /count|point/i;

/**
 * The room a measurement most likely belongs to, with labels and points in the same
 * (normalised) page coordinates. An outline takes the one room label inside it; a line takes
 * the label clearly nearest to it. Ambiguous cases (two labels inside, two equally near) give nothing.
 */
export function roomFor(row: RowShape, rooms: Room[]): Room | null {
  if (row.isGroupHeader || COUNT_TYPES.test(row.type) || !rooms.length) return null;
  const pts = (row.points ?? []).filter(p => p.x >= 0 && p.y >= 0);      // drop arc markers
  if (pts.length < 2) return null;
  const closed = pts.length >= 3 && (AREA_TYPES.test(row.type) || Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 0.004);
  if (closed) {
    const within = rooms.filter(r => inside(pts, r));
    return within.length === 1 ? within[0] : null;
  }
  const ranked = rooms.map(r => {
    let d = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) d = Math.min(d, distToSegment(r, pts[i], pts[i + 1]));
    return { r, d };
  }).sort((a, b) => a.d - b.d);
  const best = ranked[0];
  if (!best || best.d > 0.08) return null;                                   // nothing near the line
  if (ranked[1] && ranked[1].d < best.d * 1.5) return null;                  // a wall between two rooms
  return best.r;
}

const GENERIC = /^(new )?(area|length|polygon|rectangle|polyline|line|perimeter|arc|polyarc|circle|measurement|untitled|unnamed)$/i;

/**
 * A name using the room: "Tile 1 Floor Area 3" → "Tile 1 Floor Area – Bedroom 1"; a bare
 * "Area 4" → "Bedroom 1 – floor". Nothing when the name already says the room.
 */
export function nameWithRoom(current: string, room: string, type: string): string | null {
  const name = (current || '').trim();
  if (!room || name.toLowerCase().includes(room.toLowerCase())) return null;
  const base = name.replace(/\s+\d+$/, '').replace(/\s+[–-]\s*$/, '').trim();
  if (!base || GENERIC.test(base)) return `${room} – ${AREA_TYPES.test(type) ? 'floor' : 'wall'}`;
  return `${base} – ${room}`;
}

// ─── Labels of the pages that have been opened (filled in by the viewer) ─────

const store = new Map<string, Room[]>();
let current = '';
const listeners = new Set<() => void>();
const EMPTY: Room[] = [];
let version = 0;

export const pageKey = (drawingId: string | null | undefined, page: number | undefined) => `${drawingId ?? ''}:${page ?? 1}`;
/** Called by the viewer when a page's text has been read. Coordinates are 0–1 of the page. */
export function setPageRooms(key: string, rooms: Room[], isCurrent = true): void {
  store.set(key, rooms);
  if (isCurrent) current = key;
  version++;
  listeners.forEach(l => l());
}
export const getPageRooms = (key: string): Room[] => store.get(key) ?? EMPTY;
export const getCurrentPageRooms = (): Room[] => store.get(current) ?? EMPTY;
export const subscribePageRooms = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
export const pageRoomsVersion = () => version;

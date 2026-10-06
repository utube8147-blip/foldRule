'use client';
// Actions on shapes that are already drawn: merge, cut out, split, intersect,
// add / delete a point, open ↔ closed, duplicate, and "convert" (work out a
// second quantity from the same shape).

import { isDeleteKey } from '@/lib/shortcuts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TakeoffRow } from '@/types';
import { getNextMeasurementColor } from '@/hooks/measurements/useMeasurements/colors';
import { tessellatePoints, getEffectivePoints, isSentinel } from '@/hooks/perimeterOffset/perimeterOffsetGeometry';
import {
  unionShapes, subtractShapes, intersectShapes, splitShape, ringArea, shapeArea,
  type Pt, type Shape,
} from '@/lib/geometry/regionOps';

export type PendingOp = { kind: 'cutout' | 'split'; targetId: string; label: string };
export type ConvertKind = 'perimeter' | 'volume' | 'wallArea' | 'stripArea' | 'waste' | 'slope';

interface Params {
  measurements:   TakeoffRow[];
  selectedId:     string | null;
  setSelectedId:  (id: string | null) => void;
  extraSelected:  string[];
  setExtraSelected: (ids: string[]) => void;
  pageSizePt:     { w: number; h: number } | null;
  scaleFactor:    number;
  activeTool:     string;
  tempPointCount: number;
  replaceMeasurements: (removeIds: string[], add?: TakeoffRow[], updates?: Record<string, Partial<TakeoffRow>>) => void;
  startDrawing:   (kind: 'area' | 'line') => void;
  backToSelect:   () => void;
}

const AREA_TYPES = new Set(['Polygon', 'Rectangle', 'Area']);
const round = (v: number) => parseFloat(v.toFixed(4));
const newId = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `s-${Date.now()}-${Math.random()}`);

export const isAreaRow = (m: TakeoffRow | null | undefined) =>
  !!m && !m.isGroupHeader && AREA_TYPES.has(m.type) && (m.points?.length ?? 0) >= 2;
/** A row whose points are plain corners (no arc encoding) — these can be edited point by point. */
export const hasPlainPoints = (m: TakeoffRow | null | undefined) =>
  !!m && !m.isGroupHeader && m.arcRadius == null && (m.points?.length ?? 0) >= 2 &&
  !m.points.some(isSentinel) &&
  (AREA_TYPES.has(m.type) || m.type === 'Length');

export function useShapeActions({
  measurements, selectedId, setSelectedId, extraSelected, setExtraSelected,
  pageSizePt, scaleFactor, activeTool, tempPointCount,
  replaceMeasurements, startDrawing, backToSelect,
}: Params) {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingOp | null>(null);
  const pendingRef = useRef<PendingOp | null>(null);
  pendingRef.current = pending;
  const all = useRef(measurements); all.current = measurements;

  const say = useCallback((text: string) => {
    setMessage(text);
    window.setTimeout(() => setMessage(m => (m === text ? null : m)), 4500);
  }, []);

  const W = pageSizePt?.w ?? 1, H = pageSizePt?.h ?? 1, sf = scaleFactor > 0 ? scaleFactor : 1;
  const areaOf = useCallback((s: Shape) =>
    Math.max(0, ringArea(s.outer) - s.holes.reduce((t, h) => t + ringArea(h), 0)) * W * H * sf * sf, [W, H, sf]);
  const lengthOf = useCallback((pts: Pt[], closed: boolean) => {
    let t = 0;
    const n = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      t += Math.hypot((b.x - a.x) * W, (b.y - a.y) * H);
    }
    return t * sf;
  }, [W, H, sf]);

  /** Outline of a row as plain points (arcs become short straight steps). */
  const outline = useCallback((m: TakeoffRow, among: TakeoffRow[] = all.current): Pt[] => {
    let pts = tessellatePoints(getEffectivePoints(m, among), W, H) as Pt[];
    if (m.type === 'Rectangle' && pts.length === 2) {
      const [a, b] = pts;
      pts = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
    }
    if (pts.length > 2) {
      const f = pts[0], l = pts[pts.length - 1];
      if (Math.hypot((f.x - l.x) * W, (f.y - l.y) * H) < 0.01) pts = pts.slice(0, -1);
    }
    return pts.map(p => ({ x: p.x, y: p.y }));
  }, [W, H]);
  const shapeOf = useCallback((m: TakeoffRow): Shape => ({ outer: outline(m), holes: (m.holes ?? []).map(h => h.map(p => ({ ...p }))) }), [outline]);

  const selectedRows = useMemo(() => {
    const ids = [selectedId, ...extraSelected].filter(Boolean) as string[];
    return [...new Set(ids)].map(id => measurements.find(m => m.id === id)).filter(Boolean) as TakeoffRow[];
  }, [selectedId, extraSelected, measurements]);
  const primary = selectedRows[0] ?? null;

  const asArea = useCallback((s: Shape): Partial<TakeoffRow> => ({
    type: 'Polygon', points: s.outer, holes: s.holes.length ? s.holes : undefined,
    quantity: round(areaOf(s)), unit: 'sq m', isOverridden: false,
    arcRadius: undefined, sweepAngle: undefined,
  }), [areaOf]);

  const pieceRow = useCallback((src: TakeoffRow, s: Shape, n: number): TakeoffRow => ({
    ...src, ...asArea(s), id: newId(), childIds: [],
    label: `${src.label || src.description} (${n})`, description: `${src.description || src.label} (${n})`,
  } as TakeoffRow), [asArea]);

  /** Put the result of an operation back: biggest piece stays as `base`, the rest become new rows. */
  const applyPieces = useCallback((base: TakeoffRow, pieces: Shape[], removeIds: string[]) => {
    // Each new piece gets its own colour, different from the original and from each other.
    const used = new Set([base.color?.toLowerCase()]);
    const extra = pieces.slice(1).map((s, i) => {
      let color = getNextMeasurementColor();
      for (let k = 0; k < 12 && used.has(color.toLowerCase()); k++) color = getNextMeasurementColor();
      used.add(color.toLowerCase());
      return { ...pieceRow(base, s, i + 2), color };
    });
    replaceMeasurements(removeIds, extra, { [base.id]: asArea(pieces[0]) });
    setExtraSelected([]);
    setSelectedId(base.id);
  }, [pieceRow, asArea, replaceMeasurements, setExtraSelected, setSelectedId]);

  // ── Combine ───────────────────────────────────────────────────────────────
  const merge = useCallback(() => {
    const rows = selectedRows.filter(isAreaRow);
    if (rows.length < 2) return say('Select two or more areas to merge (Shift-click adds to the selection).');
    const out = unionShapes(rows.map(shapeOf));
    if (out.length !== 1) return say('These areas don’t touch, so they can’t become one shape. Move or redraw them so they meet.');
    applyPieces(rows[0], out, rows.slice(1).map(r => r.id));
  }, [selectedRows, shapeOf, applyPieces, say]);

  const subtract = useCallback((keepOthers: boolean) => {
    const rows = selectedRows.filter(isAreaRow);
    if (rows.length < 2) return say('Select the area to keep first, then Shift-click the area(s) to take away.');
    const before = areaOf(shapeOf(rows[0]));
    const out = subtractShapes(shapeOf(rows[0]), rows.slice(1).map(shapeOf));
    if (!out.length) return say('Nothing would be left of the first area.');
    if (Math.abs(areaOf(out[0]) - before) < 1e-9 && out.length === 1) return say('These areas don’t overlap, so there is nothing to take away.');
    applyPieces(rows[0], out, keepOthers ? [] : rows.slice(1).map(r => r.id));
  }, [selectedRows, shapeOf, areaOf, applyPieces, say]);

  const intersect = useCallback(() => {
    const rows = selectedRows.filter(isAreaRow);
    if (rows.length < 2) return say('Select two areas to keep only where they overlap.');
    const out = intersectShapes(rows.map(shapeOf));
    if (!out.length) return say('These areas don’t overlap.');
    applyPieces(rows[0], out, rows.slice(1).map(r => r.id));
  }, [selectedRows, shapeOf, applyPieces, say]);

  // ── Cut out / split by drawing ────────────────────────────────────────────
  const begin = useCallback((kind: PendingOp['kind']) => {
    if (!isAreaRow(primary)) return say('Select an area first.');
    setExtraSelected([]);
    setPending({ kind, targetId: primary!.id, label: primary!.label || primary!.description || 'area' });
    startDrawing(kind === 'cutout' ? 'area' : 'line');
  }, [primary, say, setExtraSelected, startDrawing]);

  const cancelPending = useCallback(() => {
    if (!pendingRef.current) return;
    setPending(null);
    backToSelect();
  }, [backToSelect]);

  /**
   * Called with the row(s) the drawing tools are about to save. While a cut-out
   * or split is in progress they are used as the cutter instead of being saved.
   * Returns true when the rows were consumed.
   */
  const consumeDrawn = useCallback((rows: TakeoffRow[]): boolean => {
    const op = pendingRef.current;
    if (!op) return false;
    const target = all.current.find(m => m.id === op.targetId);
    const head = rows.find(r => r.isGroupHeader) ?? rows[0];
    const drawn = head ? outline(head, rows) : [];
    setPending(null);
    pendingRef.current = null;
    backToSelect();
    if (!target) return true;
    setSelectedId(target.id);
    if (op.kind === 'cutout') {
      if (drawn.length < 3) { say('A cut-out needs at least three points.'); return true; }
      const before = areaOf(shapeOf(target));
      const out = subtractShapes(shapeOf(target), [{ outer: drawn, holes: [] }]);
      if (!out.length) { say('That would remove the whole area.'); return true; }
      if (out.length === 1 && Math.abs(areaOf(out[0]) - before) < 1e-9) { say('The cut-out doesn’t overlap the area, so nothing changed.'); return true; }
      applyPieces(target, out, []);
      say(`Cut out ${round(before - out.reduce((t, s) => t + areaOf(s), 0))} sq m.`);
    } else {
      if (drawn.length < 2) { say('Draw a line across the area to split it.'); return true; }
      const out = splitShape(shapeOf(target), drawn);
      if (out.length < 2) { say('The line has to cross the area to split it.'); return true; }
      applyPieces(target, out, []);
      say(`Split into ${out.length} areas.`);
    }
    return true;
  }, [outline, shapeOf, areaOf, applyPieces, backToSelect, setSelectedId, say]);

  // Esc cancels a cut-out / split that hasn't been started; leaving the drawing tool cancels too.
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && tempPointCount === 0) { e.stopPropagation(); cancelPending(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pending, tempPointCount, cancelPending]);
  const toolSeen = useRef(false);
  useEffect(() => {
    if (!pending) { toolSeen.current = false; return; }
    if (activeTool !== 'select') toolSeen.current = true;
    else if (toolSeen.current) setPending(null);
  }, [activeTool, pending]);

  // ── Points ────────────────────────────────────────────────────────────────
  const ringsOf = (m: TakeoffRow): Pt[][] => [m.points as Pt[], ...(m.holes ?? [])];
  const withRings = useCallback((m: TakeoffRow, rings: Pt[][]): Partial<TakeoffRow> => {
    const [outer, ...holes] = rings;
    const closed = AREA_TYPES.has(m.type);
    const keptHoles = holes.filter(h => h.length >= 3);
    return closed
      ? { points: outer, holes: keptHoles.length ? keptHoles : undefined, type: m.type === 'Rectangle' ? 'Polygon' : m.type,
          quantity: round(areaOf({ outer, holes: keptHoles })) }
      : { points: outer, quantity: round(lengthOf(outer, false)) };
  }, [areaOf, lengthOf]);

  /** What is under a point of the selected shape: a corner, an edge, or nothing. */
  const probe = useCallback((at: Pt, tolPx: number) => {
    const m = primary;
    if (!m || !hasPlainPoints(m)) return null;
    const closed = AREA_TYPES.has(m.type);
    let vertex: { ring: number; index: number; d: number } | null = null;
    let edge: { ring: number; index: number; d: number; point: Pt } | null = null;
    ringsOf(m).forEach((r, ri) => {
      const isClosed = ri > 0 || closed;
      r.forEach((p, i) => {
        const d = Math.hypot((p.x - at.x) * W, (p.y - at.y) * H);
        if (d <= tolPx && (!vertex || d < vertex.d)) vertex = { ring: ri, index: i, d };
      });
      const n = isClosed ? r.length : r.length - 1;
      for (let i = 0; i < n; i++) {
        const a = r[i], b = r[(i + 1) % r.length];
        const ax = a.x * W, ay = a.y * H, bx = b.x * W, by = b.y * H, px = at.x * W, py = at.y * H;
        const l2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1;
        const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / l2));
        const qx = ax + t * (bx - ax), qy = ay + t * (by - ay);
        const d = Math.hypot(px - qx, py - qy);
        if (d <= tolPx && (!edge || d < edge.d)) edge = { ring: ri, index: i, d, point: { x: qx / W, y: qy / H } };
      }
    });
    return { vertex: vertex as { ring: number; index: number } | null, edge: edge as { ring: number; index: number; point: Pt } | null };
  }, [primary, W, H]);

  const addPoint = useCallback((at: Pt, tolPx: number) => {
    const hit = probe(at, tolPx);
    if (!primary || !hit?.edge) return say('Right-click on an edge of the selected shape to add a point there.');
    const rings = ringsOf(primary).map(r => r.map(p => ({ x: p.x, y: p.y })));
    rings[hit.edge.ring].splice(hit.edge.index + 1, 0, hit.edge.point);
    replaceMeasurements([], [], { [primary.id]: withRings(primary, rings) });
  }, [probe, primary, withRings, replaceMeasurements, say]);

  const deletePoint = useCallback((at: Pt, tolPx: number) => {
    const hit = probe(at, tolPx);
    if (!primary || !hit?.vertex) return say('Right-click on a corner of the selected shape to delete it.');
    const rings = ringsOf(primary).map(r => r.map(p => ({ x: p.x, y: p.y })));
    const min = hit.vertex.ring === 0 ? (AREA_TYPES.has(primary.type) ? 3 : 2) : 0;
    if (rings[hit.vertex.ring].length <= min) return say('A shape needs at least that many points — delete the shape instead.');
    rings[hit.vertex.ring].splice(hit.vertex.index, 1);
    replaceMeasurements([], [], { [primary.id]: withRings(primary, rings) });
  }, [probe, primary, withRings, replaceMeasurements, say]);

  const removeCutouts = useCallback(() => {
    if (!primary?.holes?.length) return;
    replaceMeasurements([], [], { [primary.id]: asArea({ outer: outline(primary), holes: [] }) });
  }, [primary, asArea, outline, replaceMeasurements]);

  const toggleClosed = useCallback(() => {
    const m = primary;
    if (!m || !hasPlainPoints(m) || m.parentId) return say('Only a single, straight-edged shape can be opened or closed.');
    const pts = (m.points as Pt[]).map(p => ({ x: p.x, y: p.y }));
    if (m.type === 'Length') {
      if (pts.length < 3) return say('A line needs at least three points to become an area.');
      replaceMeasurements([], [], { [m.id]: asArea({ outer: pts, holes: [] }) });
    } else {
      replaceMeasurements([], [], { [m.id]: { type: 'Length', points: pts, holes: undefined, quantity: round(lengthOf(pts, false)), unit: 'm' } });
    }
  }, [primary, asArea, lengthOf, replaceMeasurements, say]);

  // ── Copy / delete ─────────────────────────────────────────────────────────
  const duplicate = useCallback(() => {
    const rows = selectedRows.filter(m => !m.isGroupHeader && m.points?.length);
    if (!rows.length) return;
    const dx = 14 / W, dy = 14 / H;
    const copies = rows.map(m => ({
      ...m, id: newId(), childIds: [], parentId: undefined, groupId: undefined,
      label: `${m.label || m.description} copy`, description: `${m.description || m.label} copy`,
      points: m.points.map((p: any) => (!isSentinel(p) ? { ...p, x: p.x + dx, y: p.y + dy } : p)),
      holes: m.holes?.map(h => h.map(p => ({ x: p.x + dx, y: p.y + dy }))),
    } as TakeoffRow));
    replaceMeasurements([], copies);
    setExtraSelected(copies.slice(1).map(c => c.id));
    setSelectedId(copies[0].id);
  }, [selectedRows, W, H, replaceMeasurements, setExtraSelected, setSelectedId]);

  /** Shift every point of a row by a normalised offset (optionally mirrored first). */
  const shifted = (m: TakeoffRow, f: (p: Pt) => Pt): Pick<TakeoffRow, 'points' | 'holes'> => ({
    points: m.points.map((p: any) => (isSentinel(p) ? p : { ...p, ...f(p) })),
    holes: m.holes?.map(h => h.map(f)),
  });
  const movable = useMemo(() => selectedRows.filter(m => !m.isGroupHeader && m.points?.length), [selectedRows]);

  /** Move the selection (normalised page units). One undo step. */
  const moveBy = useCallback((dx: number, dy: number) => {
    if (!movable.length || (!dx && !dy)) return;
    const updates: Record<string, Partial<TakeoffRow>> = {};
    for (const m of movable) updates[m.id] = shifted(m, p => ({ x: p.x + dx, y: p.y + dy }));
    replaceMeasurements([], [], updates);
  }, [movable, replaceMeasurements]);

  const bbox = (rows: TakeoffRow[]) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const m of rows) for (const p of m.points as any[]) {
      if (isSentinel(p)) continue;
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    return { x0, y0, x1, y1 };
  };
  const addCopies = useCallback((copies: TakeoffRow[], note: string) => {
    if (!copies.length) return;
    replaceMeasurements([], copies);
    setExtraSelected(copies.slice(1).map(c => c.id));
    setSelectedId(copies[0].id);
    say(note);
  }, [replaceMeasurements, setExtraSelected, setSelectedId, say]);
  const copyOf = (m: TakeoffRow, tag: string, f: (p: Pt) => Pt): TakeoffRow => ({
    ...m, ...shifted(m, f), id: newId(), childIds: [], parentId: undefined, groupId: undefined, derived: undefined,
    label: `${m.label || m.description} ${tag}`, description: `${m.description || m.label} ${tag}`,
  } as TakeoffRow);

  /** A mirrored copy, flipped about the right edge ('h') or the bottom edge ('v') of the selection. */
  const mirror = useCallback((axis: 'h' | 'v') => {
    if (!movable.length) return;
    const b = bbox(movable);
    addCopies(
      movable.map(m => copyOf(m, 'mirror', p => (axis === 'h' ? { x: 2 * b.x1 - p.x, y: p.y } : { x: p.x, y: 2 * b.y1 - p.y }))),
      'Mirrored copy added next to the original — drag it into place.',
    );
  }, [movable, addCopies]);

  /** `count` more copies, each `dxM` / `dyM` metres further along. */
  const repeat = useCallback((count: number, dxM: number, dyM: number) => {
    const n = Math.max(1, Math.min(200, Math.round(count)));
    if (!movable.length || (!dxM && !dyM)) return say('Give a spacing across or down (in metres).');
    const dx = dxM / sf / W, dy = dyM / sf / H;
    const copies: TakeoffRow[] = [];
    for (let i = 1; i <= n; i++) for (const m of movable) copies.push(copyOf(m, `#${i + 1}`, p => ({ x: p.x + dx * i, y: p.y + dy * i })));
    addCopies(copies, `Added ${n} cop${n === 1 ? 'y' : 'ies'}.`);
  }, [movable, sf, W, H, addCopies, say]);

  /** One edge of the selected shape as its own length row (for a partial perimeter). */
  const edgeLength = useCallback((at: Pt, tolPx: number) => {
    const hit = probe(at, tolPx);
    const m = primary;
    if (!m || !hit?.edge) return say('Right-click on an edge of the selected shape.');
    const r = ringsOf(m)[hit.edge.ring];
    const a = r[hit.edge.index], b = r[(hit.edge.index + 1) % r.length];
    const name = m.label || m.description || 'Shape';
    const row = {
      id: newId(), drawingId: m.drawingId, pageNumber: m.pageNumber, type: 'Length', unit: 'm', unitRate: 0,
      label: `${name} – edge`, description: `${name} – edge`, notes: `One edge of “${name}”`,
      quantity: round(lengthOf([a, b], false)), points: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }],
      isOverridden: false, color: m.color, isVisible: true, childIds: [],
    } as TakeoffRow;
    replaceMeasurements([], [row]);
    say(`Added “${row.label}”: ${row.quantity} m.`);
  }, [probe, primary, lengthOf, replaceMeasurements, say]);

  // ── Overlaps: areas that share ground are counted twice ───────────────────
  const overlaps = useMemo(() => {
    const rows = measurements.filter(m => isAreaRow(m) && m.isVisible !== false && (m.points?.length ?? 0) >= 3).slice(0, 160);
    const items = rows.map(m => {
      const s = shapeOf(m);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of s.outer) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
      return { m, s, x0, y0, x1, y1, a: shapeArea(s) };
    });
    const out: { a: TakeoffRow; b: TakeoffRow; area: number }[] = [];
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const p = items[i], q = items[j];
      if (p.x1 <= q.x0 || q.x1 <= p.x0 || p.y1 <= q.y0 || q.y1 <= p.y0) continue;
      const shared = intersectShapes([p.s, q.s]).reduce((t, s) => t + shapeArea(s), 0);
      if (shared > Math.min(p.a, q.a) * 0.005) out.push({ a: p.m, b: q.m, area: round(shared * W * H * sf * sf) });
    }
    return out;
  }, [measurements, shapeOf, W, H, sf]);
  const selectPair = useCallback((a: string, b: string) => { setSelectedId(a); setExtraSelected([b]); }, [setSelectedId, setExtraSelected]);

  // Arrow keys nudge the selection (Shift = bigger steps).
  useEffect(() => {
    if (activeTool !== 'select' || !movable.length) return;
    const onKey = (e: KeyboardEvent) => {
      const d = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>)[e.key];
      if (!d || e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.target as HTMLElement | null)?.closest?.('input,textarea,select,[contenteditable]')) return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;       // PDF points
      moveBy((d[0] * step) / W, (d[1] * step) / H);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeTool, movable.length, moveBy, W, H]);

  const remove = useCallback(() => {
    if (!selectedRows.length) return;
    // A group goes with its rows.
    replaceMeasurements(selectedRows.flatMap(m => [m.id, ...(m.isGroupHeader ? m.childIds ?? [] : [])]));
    setExtraSelected([]); setSelectedId(null);
  }, [selectedRows, replaceMeasurements, setExtraSelected, setSelectedId]);

  // ── Convert: a second quantity from the same shape ────────────────────────
  const convert = useCallback((kind: ConvertKind, value = 0) => {
    const m = primary;
    if (!m) return;
    const name = m.label || m.description || 'Shape';
    const base = {
      drawingId: m.drawingId, pageNumber: m.pageNumber, unitRate: 0, isVisible: true, childIds: [] as string[],
      color: m.color, isOverridden: false,
    };
    let row: TakeoffRow | null = null;
    if (kind === 'perimeter' && isAreaRow(m)) {
      const o = outline(m);
      const pts = [...o, o[0]];
      row = { ...base, id: newId(), type: 'Length', unit: 'm', label: `${name} – perimeter`, description: `${name} – perimeter`,
        quantity: round(lengthOf(o, true)), points: pts, notes: `Outer edge of “${name}”` } as TakeoffRow;
    } else if ((kind === 'waste' || kind === 'slope') && value > 0 && (isAreaRow(m) || m.type === 'Length')) {
      // Same kind of quantity, scaled: + waste %, or plan size → true size on a slope.
      const factor = kind === 'waste' ? 1 + value / 100 : Math.sqrt(1 + (value / 100) ** 2);
      const tag = kind === 'waste' ? `+ ${value}% waste` : `on ${value}% slope`;
      row = { ...base, id: newId(), type: m.type, unit: m.unit, label: `${name} ${tag}`, description: `${name} ${tag}`,
        quantity: round(m.quantity * factor), points: [], notes: `“${name}” × ${round(factor)} — follows it when it changes`,
        derived: { sourceId: m.id, factor, what: tag } } as TakeoffRow;
    } else if (value > 0) {
      const spec = kind === 'volume'   ? { ok: isAreaRow(m),        type: 'Volume', unit: 'cu m', tag: 'volume',    what: `× ${value} m deep` }
                 : kind === 'wallArea' ? { ok: m.type === 'Length', type: 'Area',   unit: 'sq m', tag: 'wall area', what: `× ${value} m high` }
                 :                       { ok: m.type === 'Length', type: 'Area',   unit: 'sq m', tag: 'strip area', what: `× ${value} m wide` };
      if (!spec.ok) return;
      row = { ...base, id: newId(), type: spec.type as TakeoffRow['type'], unit: spec.unit,
        label: `${name} – ${spec.tag}`, description: `${name} – ${spec.tag}`,
        quantity: round(m.quantity * value), points: [], notes: `“${name}” ${spec.what} — follows it when it changes`,
        derived: { sourceId: m.id, factor: value, what: spec.what } } as TakeoffRow;
    }
    if (!row) return;
    replaceMeasurements([], [row]);
    say(`Added “${row.label}”: ${row.quantity} ${row.unit}.`);
  }, [primary, outline, lengthOf, replaceMeasurements, say]);

  // ── Move to another group ────────────────────────────────────────────────
  const kindOfType = (t: string) => (AREA_TYPES.has(t) ? 'area' : t);
  /** Groups the whole selection could go into (same kind of quantity). */
  const groupTargets = useMemo(() => {
    const rows = selectedRows.filter(m => !m.isGroupHeader);
    if (!rows.length) return [];
    const kind = kindOfType(rows[0].type);
    if (rows.some(r => kindOfType(r.type) !== kind)) return [];
    return measurements.filter(h => h.isGroupHeader && !h.presetId && kindOfType(h.type) === kind && !rows.every(r => r.parentId === h.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRows, measurements]);
  const inGroup = selectedRows.some(m => !m.isGroupHeader && m.parentId);
  const moveToGroup = useCallback((groupId: string | null) => {
    const rows = selectedRows.filter(m => !m.isGroupHeader && m.parentId !== (groupId ?? undefined));
    if (!rows.length) return;
    const header = groupId ? measurements.find(m => m.id === groupId) : null;
    if (groupId && !header) return;
    const name = header ? header.groupName || header.label || header.description || 'Group' : '';
    const n0 = header?.childIds?.length ?? 0;
    const moved = rows.map((r, i) => (header
      ? { ...r, parentId: header.id, groupId: header.id, color: header.color, label: `${name} ${n0 + i + 1}`, description: `${name} ${n0 + i + 1}`,
          ...(header.materialId ? { materialId: header.materialId, unitRate: header.unitRate } : {}) }
      : { ...r, parentId: undefined, groupId: undefined }) as TakeoffRow);
    replaceMeasurements(rows.map(r => r.id), moved);
    say(header ? `Moved to “${name}”.` : 'Taken out of its group.');
  }, [selectedRows, measurements, replaceMeasurements, say]);

  // Delete or Backspace removes the selection (not while typing).
  useEffect(() => {
    // Not while something is being drawn (Backspace steps back there) or in Magic fill (it undoes a fill).
    if (activeTool === 'magic-fill' || tempPointCount > 0 || pending || !selectedRows.length) return;
    const onKey = (e: KeyboardEvent) => {
      // Esc lets go of the selection.
      if (e.key === 'Escape' && activeTool === 'select') {
        if ((e.target as HTMLElement | null)?.closest?.('input,textarea,select,[contenteditable]')) return;
        setExtraSelected([]); setSelectedId(null);
        return;
      }
      if (!isDeleteKey(e)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('input,textarea,select,[contenteditable]')) return;
      e.preventDefault();
      remove();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeTool, tempPointCount, pending, selectedRows.length, remove, setExtraSelected, setSelectedId]);

  return {
    selectedRows, primary, message, pending,
    merge, subtract, intersect,
    beginCutout: () => begin('cutout'), beginSplit: () => begin('split'), cancelPending, consumeDrawn,
    probe, addPoint, deletePoint, removeCutouts, toggleClosed,
    groupTargets, inGroup, moveToGroup,
    duplicate, remove, convert, moveBy, mirror, repeat, edgeLength, overlaps, selectPair, movable,
    clearSelection: () => { setExtraSelected([]); setSelectedId(null); },
  };
}
export type ShapeActionsApi = ReturnType<typeof useShapeActions>;

'use client';
// "What am I measuring?" — name an item once (e.g. "Tile – 1st floor") and
// every shape drawn after that is added to it, until another item is chosen.
// One item is remembered per kind of quantity: area, length, count.

import { useCallback, useMemo, useRef, useState } from 'react';
import type { TakeoffRow } from '@/types';
import type { DrawMode } from '@/lib/geometry/pathShapes';
import { getNextMeasurementColor } from '@/hooks/measurements/useMeasurements/colors';

export type ItemKind = 'area' | 'length' | 'count';
export interface ActiveItem { id: string; name: string; color: string }

const KIND_TYPES: Record<ItemKind, { types: string[]; header: TakeoffRow['type']; unit: string; what: string }> = {
  area:   { types: ['Polygon', 'Rectangle', 'Area'], header: 'Polygon', unit: 'sq m', what: 'area' },
  length: { types: ['Length'],                       header: 'Length',  unit: 'm',    what: 'length' },
  count:  { types: ['Count'],                        header: 'Count',   unit: 'EA',   what: 'count' },
};

/** Which kind of quantity the current tool measures (null: not a measuring tool). */
export function kindOfTool(tool: string, mode: DrawMode): ItemKind | null {
  switch (tool) {
    case 'polyarc': case 'radius': return mode.area ? 'area' : 'length';
    case 'rectangle': case 'polygon': case 'magic-fill': return 'area';
    case 'linear': case 'arc': return 'length';
    case 'count': return 'count';
    default: return null;
  }
}

const uid = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `i-${Date.now()}-${Math.random()}`);

/** The kind of quantity a group holds, from its row type. */
export function kindOfType(type: string): ItemKind | null {
  return (Object.keys(KIND_TYPES) as ItemKind[]).find(k => KIND_TYPES[k].types.includes(type)) ?? null;
}

export function useActiveItem({ measurements, activeDrawingId, kind, replaceMeasurements }: {
  measurements: TakeoffRow[];
  activeDrawingId: string | null | undefined;
  kind: ItemKind | null;
  replaceMeasurements: (removeIds: string[], add?: TakeoffRow[], updates?: Record<string, Partial<TakeoffRow>>) => void;
}) {
  // 'none' = the user chose to name each shape separately for this kind.
  const [items, setItems] = useState<Partial<Record<ItemKind, ActiveItem | 'none'>>>({});
  const all = useRef(measurements); all.current = measurements;
  const kindRef = useRef(kind); kindRef.current = kind;
  const itemsRef = useRef(items); itemsRef.current = items;
  const counter = useRef<{ id: string; n: number }>({ id: '', n: 0 });

  const chosen = kind ? items[kind] : undefined;
  const item = chosen && chosen !== 'none' ? chosen : null;
  const header = item ? measurements.find(m => m.id === item.id && m.isGroupHeader) ?? null : null;
  /** A measuring tool is active and nothing has been decided yet → ask. */
  const needsName = !!kind && chosen === undefined;

  const headerRow = (it: ActiveItem, k: ItemKind, kids: TakeoffRow[] = []): TakeoffRow => ({
    id: it.id, drawingId: activeDrawingId || '', label: it.name, description: it.name, groupName: it.name,
    type: KIND_TYPES[k].header, quantity: kids.reduce((t, r) => t + r.quantity, 0), unit: kids[0]?.unit ?? KIND_TYPES[k].unit,
    unitRate: 0, notes: '', points: [], isOverridden: false, isGroupHeader: true, isExpanded: true,
    color: it.color, isVisible: true, childIds: kids.map(r => r.id),
  } as TakeoffRow);

  /** Start a new item: its (empty) row appears in the takeoff straight away. */
  const start = useCallback((name: string) => {
    const k = kindRef.current, clean = name.trim();
    if (!k || !clean) return;
    const it: ActiveItem = { id: uid(), name: clean, color: getNextMeasurementColor() };
    replaceMeasurements([], [headerRow(it, k)]);
    setItems(s => ({ ...s, [k]: it }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replaceMeasurements, activeDrawingId]);

  /** Carry on with a group that already exists. */
  const use = useCallback((groupId: string) => {
    const k = kindRef.current;
    const g = all.current.find(m => m.id === groupId);
    if (!k || !g) return;
    setItems(s => ({ ...s, [k]: { id: g.id, name: g.label || g.groupName || g.description || 'Item', color: g.color } }));
  }, []);

  /** Make a given group the active item for its kind (used by "add to this group" in the takeoff). */
  const useFor = useCallback((k: ItemKind, g: Pick<TakeoffRow, 'id' | 'label' | 'groupName' | 'description' | 'color'>) => {
    setItems(s => ({ ...s, [k]: { id: g.id, name: g.groupName || g.label || g.description || 'Item', color: g.color } }));
  }, []);

  /** The tool was left for good (Esc / Select): next time, ask what is being measured. */
  const lastUsed = useRef<Partial<Record<ItemKind, string>>>({});
  const forget = useCallback((k: ItemKind) => {
    setItems(s => {
      const cur = s[k];
      if (cur === undefined) return s;
      if (cur !== 'none') lastUsed.current[k] = cur.id;
      const n = { ...s }; delete n[k]; return n;
    });
  }, []);

  /** Ask again (undefined) or stop grouping for this kind ('none'). */
  const clear = useCallback((mode: 'ask' | 'none') => {
    const k = kindRef.current;
    if (!k) return;
    setItems(s => { const n = { ...s }; if (mode === 'none') n[k] = 'none'; else delete n[k]; return n; });
  }, []);

  /** Groups of the same kind on this drawing, to pick from. */
  const existing = useMemo(() => {
    if (!kind) return [];
    const ok = new Set(KIND_TYPES[kind].types);
    const last = lastUsed.current[kind];
    return measurements.filter(m => m.isGroupHeader && ok.has(m.type) && !m.presetId)
      .map(m => ({ id: m.id, name: m.label || m.groupName || m.description || 'Group', quantity: m.quantity, unit: m.unit }))
      .sort((a, b) => Number(b.id === last) - Number(a.id === last));       // the one just used comes first
  }, [measurements, kind]);

  /**
   * Called with the row(s) a tool is about to save. With an item active they
   * are added to it instead. Returns true when the rows were taken.
   */
  const adopt = useCallback((rows: TakeoffRow[]): boolean => {
    const k = kindRef.current;
    const it = k ? itemsRef.current[k] : undefined;
    if (!k || !it || it === 'none') return false;
    const ok = new Set(KIND_TYPES[k].types);
    const leaves = rows.filter(r => !r.isGroupHeader && (r.points?.length ?? 0) > 0);
    if (!leaves.length || leaves.some(r => !ok.has(r.type))) return false;
    const head = all.current.find(m => m.id === it.id && m.isGroupHeader);
    // Several calls can arrive before the list refreshes — keep counting from the last one.
    const n0 = Math.max(head?.childIds?.length ?? 0, counter.current.id === it.id ? counter.current.n : 0);
    counter.current = { id: it.id, n: n0 + leaves.length };
    const kids = leaves.map((r, i) => ({
      ...r, parentId: it.id, groupId: it.id, color: it.color, childIds: [],
      // A material set on the group applies to everything added to it.
      ...(head?.materialId ? { materialId: head.materialId, unitRate: head.unitRate } : {}),
      label: `${it.name} ${n0 + i + 1}`, description: `${it.name} ${n0 + i + 1}`,
    } as TakeoffRow));
    // The group row is recreated if it was deleted in the meantime.
    replaceMeasurements([], head ? kids : [headerRow(it, k, kids), ...kids]);
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replaceMeasurements, activeDrawingId]);

  return { kind, item, header, needsName, existing, start, use, useFor, clear, forget, adopt, what: kind ? KIND_TYPES[kind].what : '' };
}
export type ActiveItemApi = ReturnType<typeof useActiveItem>;

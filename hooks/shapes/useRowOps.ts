'use client';
// Things that can be done to a takeoff row or group from a menu: move between groups,
// duplicate, make a group, set a material for one row or a whole group. Shared by the
// pages that list the takeoff so they all offer the same actions.

import { useCallback } from 'react';
import type { Material, TakeoffRow } from '@/types';
import { useTakeoffData } from '@/context/TakeoffContext';
import { PALETTE_GRID } from '@/hooks/measurements/useMeasurements/colors';
import { materialRate } from '@/lib/takeoff/valueEngineering';

const uid = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `r-${Date.now()}-${Math.random()}`);
export const kindOf = (t: string) => (t === 'Polygon' || t === 'Rectangle' || t === 'Area' ? 'area' : t === 'Length' ? 'length' : t === 'Count' ? 'count' : t);
/** Can this row go into that group? Same kind of quantity only (an area can't join a length group). */
export const canJoin = (row: TakeoffRow | undefined, header: TakeoffRow | undefined) =>
  !!row && !!header && !row.isGroupHeader && !!header.isGroupHeader && row.parentId !== header.id && kindOf(row.type) === kindOf(header.type);
export const groupRows = (header: TakeoffRow, measurements: TakeoffRow[]) => {
  const gid = header.groupId || header.id;
  return measurements.filter(m => !m.isGroupHeader && (m.parentId === header.id || m.groupId === gid || header.childIds?.includes(m.id)));
};
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
const nudge = (r: TakeoffRow): TakeoffRow => ({
  ...r,
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  points: (r.points ?? []).map((q: any) => (q && typeof q.x === 'number' && q.segmentId == null ? { ...q, x: q.x + 0.012, y: q.y + 0.012 } : q)),
  holes: r.holes?.map(h => h.map(q => ({ x: q.x + 0.012, y: q.y + 0.012 }))),
});

export function useRowOps(measurements: TakeoffRow[], materials: Material[]) {
  const { replaceMeasurements, ungroupMeasurements, deleteMeasurement, toggleVisibility, displayUnit } = useTakeoffData();

  const moveRow = useCallback((rowId: string, targetId: string | null) => {
    const row = measurements.find(m => m.id === rowId);
    if (!row || row.isGroupHeader) return;
    if (targetId === null) {
      if (row.parentId) replaceMeasurements([row.id], [{ ...row, parentId: undefined, groupId: undefined }]);
      return;
    }
    const header = measurements.find(m => m.id === targetId);
    if (!canJoin(row, header) || !header) return;
    const name = header.groupName || header.label || header.description || 'Group';
    const n = (header.childIds?.length ?? 0) + 1;
    // The row takes the group's name, colour and material, so it reads as part of it.
    replaceMeasurements([row.id], [{
      ...row, parentId: header.id, groupId: header.id, color: header.color,
      label: `${name} ${n}`, description: `${name} ${n}`,
      ...(header.materialId ? { materialId: header.materialId, unitRate: header.unitRate } : {}),
    }]);
  }, [measurements, replaceMeasurements]);

  const makeGroupFrom = useCallback((rowId: string) => {
    const row = measurements.find(m => m.id === rowId);
    if (!row || row.isGroupHeader || row.parentId) return;
    const name = (row.description || row.label || 'Group').replace(/\s+\d+$/, '');
    const id = uid();
    replaceMeasurements([row.id], [
      { id, drawingId: row.drawingId, pageNumber: row.pageNumber, label: name, description: name, groupName: name,
        type: kindOf(row.type) === 'area' ? 'Polygon' : row.type, quantity: row.quantity, unit: kindOf(row.type) === 'area' ? `sq ${displayUnit}` : displayUnit, unitRate: row.unitRate ?? 0,
        materialId: row.materialId, notes: '', points: [], isOverridden: false, isGroupHeader: true, isExpanded: true,
        color: row.color, isVisible: true, childIds: [row.id] } as TakeoffRow,
      { ...row, parentId: id, groupId: id, label: `${name} 1`, description: `${name} 1` },
    ]);
  }, [displayUnit, measurements, replaceMeasurements]);

  const duplicateRow = useCallback((rowId: string) => {
    const row = measurements.find(m => m.id === rowId);
    if (!row || row.isGroupHeader) return;
    const name = `${row.description || row.label || 'Item'} copy`;
    replaceMeasurements([], [{ ...nudge(row), id: uid(), childIds: [], derived: undefined, review: undefined, label: name, description: name }]);
  }, [measurements, replaceMeasurements]);

  /** `withShapes` false → an empty group with the same material and rate; true → its shapes are copied too. */
  const duplicateGroup = useCallback((headerId: string, withShapes: boolean) => {
    const header = measurements.find(m => m.id === headerId);
    if (!header) return;
    const kids = withShapes ? groupRows(header, measurements) : [];
    const base = header.groupName || header.label || header.description || 'Group';
    const taken = new Set(measurements.filter(m => m.isGroupHeader).map(m => (m.groupName || m.label || m.description || '').toLowerCase()));
    let name = `${base} copy`;
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base} copy ${i}`;
    const id = uid();
    const used = measurements.map(m => (m.color || '').toLowerCase());
    const free = PALETTE_GRID.flatMap(h => [h.shades[2], h.shades[3], h.shades[1]]).find(c => !used.includes(c.toLowerCase())) ?? header.color;
    const copies = kids.map((k, i) => ({
      ...nudge(k), id: uid(), parentId: id, groupId: id, childIds: [], derived: undefined, review: undefined, color: free,
      label: `${name} ${i + 1}`, description: `${name} ${i + 1}`,
    } as TakeoffRow));
    replaceMeasurements([], [{
      ...header, id, groupId: id, label: name, description: name, groupName: name, color: free,
      childIds: copies.map(c => c.id), quantity: copies.reduce((t, c) => t + c.quantity, 0), points: [], isExpanded: true,
    } as TakeoffRow, ...copies]);
  }, [measurements, replaceMeasurements]);

  /** One material (and its rate) for a row, or for a group and every row in it. Null clears it. */
  const setMaterial = useCallback((rowId: string, materialId: string | null) => {
    const row = measurements.find(m => m.id === rowId);
    if (!row) return;
    const mat = materialId ? materials.find(m => m.id === materialId) : undefined;
    const upd: Partial<TakeoffRow> = mat ? { materialId: mat.id, unitRate: materialRate(mat) } : { materialId: undefined, unitRate: 0 };
    const targets = row.isGroupHeader ? [row, ...groupRows(row, measurements)] : [row];
    replaceMeasurements([], [], Object.fromEntries(targets.map(t => [t.id, upd])));
  }, [measurements, materials, replaceMeasurements]);

  /** Show or hide a group with everything in it. */
  const setGroupVisible = useCallback((headerId: string, visible: boolean) => {
    const header = measurements.find(m => m.id === headerId);
    if (!header) return;
    replaceMeasurements([], [], Object.fromEntries([header, ...groupRows(header, measurements)].map(t => [t.id, { isVisible: visible }])));
  }, [measurements, replaceMeasurements]);

  const markChecked = useCallback((rowId: string) => {
    const row = measurements.find(m => m.id === rowId);
    if (row?.review) replaceMeasurements([], [], { [rowId]: { review: { revision: row.review.revision, status: 'done' } } });
  }, [measurements, replaceMeasurements]);

  return { moveRow, makeGroupFrom, duplicateRow, duplicateGroup, setMaterial, setGroupVisible, markChecked, ungroup: ungroupMeasurements, remove: deleteMeasurement, toggleVisibility };
}
export type RowOps = ReturnType<typeof useRowOps>;

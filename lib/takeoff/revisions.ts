// Accepting a drawing revision: the measurements taken on the old sheet are carried
// onto the new one, the ones sitting on a change are marked for checking, and the
// quantities as they stood are kept so the change can be reported afterwards.

import type { Drawing, Material, TakeoffRow } from '@/types';
import { billedQuantities } from './timesing';
import { followDerived } from './assemblies';

export interface RevisionSnapshotRow {
  id: string;
  description: string;
  group?: string;
  unit: string;
  type: string;
  /** Billed quantity (timesing applied) when the revision was accepted. */
  quantity: number;
  rate: number;
}

export interface RevisionRecord {
  id: string;
  /** ISO date-time the revision was accepted. */
  at: string;
  from: { drawingId: string; name: string; page: number };
  to: { drawingId: string; name: string; page: number };
  rows: RevisionSnapshotRow[];
  /** Rows that sat on a change. */
  flagged: string[];
  /** Rows that were already on the new sheet (not part of this change). */
  existing: string[];
  /** Version number of the old sheet (1 = the first issue); the new sheet is this + 1. */
  fromVersion?: number;
  /**
   * The takeoff of the old sheet exactly as it stood: shapes, quantities and groups,
   * frozen. It is kept for the record and never counted in totals or exports.
   */
  archive?: TakeoffRow[];
  /** Set when the old version was restored: the date, and the new version's takeoff as it stood then. */
  reverted?: string;
  toArchive?: TakeoffRow[];
}

/** "Version 2" label of a record's old and new sheets. */
export const versionOf = (r: RevisionRecord) => ({ from: r.fromVersion ?? 1, to: (r.fromVersion ?? 1) + 1 });

type DrawingLite = Pick<Drawing, 'id' | 'name' | 'pageTimes'>;
const pageOf = (m: TakeoffRow) => m.pageNumber ?? 1;
const round4 = (n: number) => parseFloat(n.toFixed(4));

function snapshotRows(rows: TakeoffRow[], all: TakeoffRow[], drawings: DrawingLite[], materials: Material[]): RevisionSnapshotRow[] {
  const billed = billedQuantities(all, drawings);
  const mats = new Map(materials.map(m => [m.id, m]));
  const byId = new Map(all.map(m => [m.id, m]));
  return rows.filter(m => !m.isGroupHeader).map(m => {
    const parent = m.parentId ? byId.get(m.parentId) : undefined;
    return {
      id: m.id, description: m.description || m.label || 'Untitled',
      ...(parent?.isGroupHeader ? { group: parent.groupName || parent.description || parent.label } : {}),
      unit: m.unit, type: m.type, quantity: billed.get(m.id) ?? m.quantity,
      rate: m.unitRate || (m.materialId ? mats.get(m.materialId)?.unitRate ?? 0 : 0),
    };
  });
}

export interface CarryOverInput {
  measurements: TakeoffRow[];
  drawings: DrawingLite[];
  materials: Material[];
  from: { drawingId: string; page: number };
  to: { drawingId: string; name: string; page: number };
  /** Where the old sheet sits on the new one, as a fraction of the page (new = old − shift). */
  shift?: { x: number; y: number };
  flaggedIds: string[];
  /** Proposed outlines by row id, in the old sheet's frame (from the snap check). */
  suggestions?: Record<string, { points: Array<{ x: number; y: number }>; quantity: number }>;
  revisionId: string;
  at?: string;
  /** Revisions accepted earlier, to number this one. */
  previous?: RevisionRecord[];
}

/**
 * Work out the carry-over: every measurement of the old page moves to the new sheet,
 * flagged ones are marked "check", and a record of the quantities before is returned.
 */
export function planCarryOver(input: CarryOverInput): { updates: Record<string, Partial<TakeoffRow>>; record: RevisionRecord } {
  const { measurements, from, to, flaggedIds, revisionId } = input;
  const sx = input.shift?.x ?? 0, sy = input.shift?.y ?? 0;
  const moving = measurements.filter(m =>
    !m.isGroupHeader && m.drawingId === from.drawingId && pageOf(m) === from.page && (m.points?.length || m.derived));
  const movingIds = new Set(moving.map(m => m.id));
  const flagged = new Set(flaggedIds.filter(id => movingIds.has(id)));
  // Sentinel points (arc markers) carry negative coordinates and must stay as they are.
  const move = <P extends { x: number; y: number }>(p: P): P => (p.x < 0 || (!sx && !sy) ? p : { ...p, x: p.x - sx, y: p.y - sy });

  const updates: Record<string, Partial<TakeoffRow>> = {};
  for (const m of moving) {
    updates[m.id] = {
      drawingId: to.drawingId, pageNumber: to.page,
      ...(m.points?.length ? { points: m.points.map(move) } : {}),
      ...(m.holes?.length ? { holes: m.holes.map(h => h.map(move)) } : {}),
      ...(flagged.has(m.id) ? { review: {
        revision: revisionId, status: 'check' as const,
        ...(input.suggestions?.[m.id] ? { suggest: { points: input.suggestions[m.id].points.map(move), quantity: input.suggestions[m.id].quantity } } : {}),
      } } : {}),
    };
  }
  // A group follows its rows.
  for (const h of measurements) {
    if (h.isGroupHeader && h.drawingId === from.drawingId && h.childIds?.some(id => movingIds.has(id))) {
      updates[h.id] = { drawingId: to.drawingId, pageNumber: to.page };
    }
  }
  const fromName = input.drawings.find(d => d.id === from.drawingId)?.name ?? 'Old sheet';
  // The old sheet is one version on from whichever revision produced it.
  const parent = [...(input.previous ?? [])].reverse().find(r => r.to.drawingId === from.drawingId && r.to.page === from.page);
  const fromVersion = parent ? versionOf(parent).to : 1;
  const frozen = new Set([...movingIds, ...Object.keys(updates)]);
  const archive = measurements.filter(m => frozen.has(m.id)).map(m => ({
    ...m, points: m.points.map(p => ({ ...p })), ...(m.holes ? { holes: m.holes.map(h => h.map(p => ({ ...p }))) } : {}),
  }));
  return {
    updates,
    record: {
      id: revisionId, at: input.at ?? new Date().toISOString(),
      from: { ...from, name: fromName }, to,
      rows: snapshotRows(moving, measurements, input.drawings, input.materials),
      flagged: [...flagged],
      existing: measurements.filter(m => !m.isGroupHeader && m.drawingId === to.drawingId && pageOf(m) === to.page).map(m => m.id),
      fromVersion, archive,
    },
  };
}

export interface ChangeLine {
  id: string;
  description: string;
  group?: string;
  unit: string;
  before: number;
  after: number;
  diff: number;
  rate: number;
  /** Cost of the change at the row's rate. */
  cost: number;
  status: 'changed' | 'same' | 'removed' | 'added';
}

export interface RevisionChanges {
  record: RevisionRecord;
  lines: ChangeLine[];
  /** Net cost of all changes. */
  cost: number;
  counts: { changed: number; added: number; removed: number; same: number };
}

/** What a revision did to the quantities: the snapshot against the takeoff as it stands now. */
export function revisionChanges(record: RevisionRecord, measurements: TakeoffRow[], drawings: DrawingLite[], materials: Material[]): RevisionChanges {
  const billed = billedQuantities(measurements, drawings);
  const byId = new Map(measurements.map(m => [m.id, m]));
  const mats = new Map(materials.map(m => [m.id, m]));
  const rateOf = (m: TakeoffRow) => m.unitRate || (m.materialId ? mats.get(m.materialId)?.unitRate ?? 0 : 0);
  const lines: ChangeLine[] = [];
  const seen = new Set<string>();
  for (const s of record.rows) {
    seen.add(s.id);
    const now = byId.get(s.id);
    const after = now ? billed.get(s.id) ?? now.quantity : 0;
    const rate = now ? rateOf(now) || s.rate : s.rate;
    const diff = round4(after - s.quantity);
    lines.push({
      id: s.id, description: now?.description || s.description, group: s.group, unit: now?.unit || s.unit,
      before: s.quantity, after, diff, rate, cost: round4(diff * rate),
      status: !now ? 'removed' : Math.abs(diff) < 0.0005 ? 'same' : 'changed',
    });
  }
  // Anything measured on the new sheet since then is an addition of this revision.
  const existing = new Set(record.existing ?? []);
  for (const m of measurements) {
    if (m.isGroupHeader || seen.has(m.id) || existing.has(m.id)) continue;
    if (m.drawingId !== record.to.drawingId || pageOf(m) !== record.to.page) continue;
    if (!(m.points?.length || m.derived)) continue;
    const parent = m.parentId ? byId.get(m.parentId) : undefined;
    const after = billed.get(m.id) ?? m.quantity;
    const rate = rateOf(m);
    lines.push({
      id: m.id, description: m.description || m.label || 'Untitled',
      ...(parent?.isGroupHeader ? { group: parent.groupName || parent.description || parent.label } : {}),
      unit: m.unit, before: 0, after, diff: after, rate, cost: round4(after * rate), status: 'added',
    });
  }
  const counts = { changed: 0, added: 0, removed: 0, same: 0 };
  for (const l of lines) counts[l.status] += 1;
  return { record, lines, cost: round4(lines.reduce((t, l) => t + l.cost, 0)), counts };
}

/** How far the checking of a revision has got. */
export function reviewProgress(measurements: TakeoffRow[], revisionId?: string) {
  const rows = measurements.filter(m => m.review && (!revisionId || m.review.revision === revisionId));
  const toCheck = rows.filter(m => m.review!.status === 'check');
  return { open: toCheck.length, total: rows.length, openIds: toCheck.map(m => m.id) };
}

// ─── Versions, like commits ─────────────────────────────────────────────────

const cloneRow = (m: TakeoffRow): TakeoffRow => ({
  ...m, points: m.points.map(p => ({ ...p })), ...(m.holes ? { holes: m.holes.map(h => h.map(p => ({ ...p }))) } : {}),
  ...(m.childIds ? { childIds: [...m.childIds] } : {}),
});

/** A later revision of the same sheet that is still in force (so this one cannot be stepped over). */
export function activeChild(record: RevisionRecord, log: RevisionRecord[]): RevisionRecord | undefined {
  const i = log.findIndex(r => r.id === record.id);
  return log.find((r, k) => k > i && !r.reverted && r.from.drawingId === record.to.drawingId && r.from.page === record.to.page);
}

/** Rows measured on the new sheet since it was accepted (not carried over, not there before). */
export function newWorkSince(record: RevisionRecord, measurements: TakeoffRow[]): TakeoffRow[] {
  const known = new Set([...(record.archive ?? []).map(m => m.id), ...(record.existing ?? [])]);
  const fresh = measurements.filter(m => !m.isGroupHeader && !known.has(m.id) &&
    m.drawingId === record.to.drawingId && pageOf(m) === record.to.page && (m.points?.length || m.derived));
  const ids = new Set(fresh.map(m => m.id));
  // Groups made up entirely of new rows go with them.
  const headers = measurements.filter(h => h.isGroupHeader && !known.has(h.id) && h.childIds?.length && h.childIds.every(id => ids.has(id)));
  return [...headers, ...fresh];
}

export interface SwitchResult { measurements: TakeoffRow[]; record: RevisionRecord; error?: string }

/**
 * Move between the two versions of a revision.
 *  - 'from': restore the old version. The frozen takeoff becomes live again on the old sheet;
 *    the new version's takeoff is frozen in its place so it can be gone back to.
 *  - 'to': go back to the new version after a restore.
 * `keepNew` (restore only) leaves rows measured on the new sheet since acceptance where they are.
 */
export function switchVersion(record: RevisionRecord, measurements: TakeoffRow[], log: RevisionRecord[], target: 'from' | 'to', keepNew = false): SwitchResult {
  const fail = (error: string): SwitchResult => ({ measurements, record, error });
  if (!record.archive) return fail('This revision was accepted before versions were kept, so there is nothing to restore.');
  const put = (live: TakeoffRow[], remove: Set<string>, rows: TakeoffRow[]) => {
    const incoming = new Map(rows.map(m => [m.id, cloneRow(m)]));
    const out: TakeoffRow[] = [];
    for (const m of live) {
      const r = incoming.get(m.id);
      if (r) { out.push(r); incoming.delete(m.id); }
      else if (!remove.has(m.id)) out.push(m);
    }
    return [...out, ...incoming.values()];
  };

  if (target === 'from') {
    if (record.reverted) return fail('This version is already the one you are working on.');
    if (activeChild(record, log)) return fail('A newer revision of this sheet is in force. Restore that one first, then this one.');
    const ids = new Set(record.archive.map(m => m.id));
    const carried = measurements.filter(m => ids.has(m.id));
    const fresh = keepNew ? [] : newWorkSince(record, measurements);
    const gone = new Set([...carried, ...fresh].map(m => m.id));
    return {
      measurements: followDerived(put(measurements, gone, record.archive)),
      record: { ...record, reverted: new Date().toISOString(), toArchive: [...carried, ...fresh].map(cloneRow) },
    };
  }

  if (!record.reverted || !record.toArchive) return fail('This version is already the one you are working on.');
  const ids = new Set(record.archive.map(m => m.id));
  const current = measurements.filter(m => ids.has(m.id));
  const { reverted: _r, toArchive, ...rest } = record;
  return {
    measurements: followDerived(put(measurements, new Set(current.map(m => m.id)), toArchive)),
    // The old version may have been touched while it was live: freeze it as it is now.
    record: { ...rest, archive: current.length ? current.map(cloneRow) : record.archive },
  };
}

export interface VersionNode {
  key: string;
  record: RevisionRecord;
  side: 'from' | 'to';
  version: number;
  name: string;
  drawingId: string;
  page: number;
  /** When this version came into the project (accepted), if known. */
  date?: string;
  status: 'current' | 'superseded' | 'set aside';
  /** Frozen takeoff of this version; undefined when it is the live one. */
  rows?: TakeoffRow[];
  /** How to make this version the live one, when that is possible right now. */
  restore?: { recordId: string; target: 'from' | 'to' };
  /** Why it cannot be restored right now. */
  blocked?: string;
}

/** Every version of every sheet, oldest first, with what can be done with each. */
export function versionNodes(log: RevisionRecord[]): VersionNode[] {
  const out: VersionNode[] = [];
  for (const r of log) {
    const v = versionOf(r);
    const hasParent = log.some(p => p !== r && p.to.drawingId === r.from.drawingId && p.to.page === r.from.page);
    const child = activeChild(r, log);
    if (!hasParent) {
      const live = !!r.reverted;
      out.push({
        key: `${r.id}:from`, record: r, side: 'from', version: v.from, name: r.from.name, drawingId: r.from.drawingId, page: r.from.page,
        status: live ? 'current' : 'superseded', rows: live ? undefined : r.archive,
        ...(live ? {} : !r.archive ? { blocked: 'Only the quantities of this version were kept.' }
          : child ? { blocked: `Restore version ${versionOf(child).from} first.` } : { restore: { recordId: r.id, target: 'from' as const } }),
      });
    }
    if (r.reverted) {
      out.push({
        key: `${r.id}:to`, record: r, side: 'to', version: v.to, name: r.to.name, drawingId: r.to.drawingId, page: r.to.page, date: r.at,
        status: 'set aside', rows: r.toArchive ?? [], restore: { recordId: r.id, target: 'to' },
      });
    } else if (child) {
      const grand = activeChild(child, log);
      out.push({
        key: `${r.id}:to`, record: r, side: 'to', version: v.to, name: r.to.name, drawingId: r.to.drawingId, page: r.to.page, date: r.at,
        status: 'superseded', rows: child.archive,
        ...(!child.archive ? { blocked: 'Only the quantities of this version were kept.' }
          : grand ? { blocked: `Restore version ${versionOf(grand).from} first.` } : { restore: { recordId: child.id, target: 'from' as const } }),
      });
    } else {
      out.push({ key: `${r.id}:to`, record: r, side: 'to', version: v.to, name: r.to.name, drawingId: r.to.drawingId, page: r.to.page, date: r.at, status: 'current' });
    }
  }
  return out;
}

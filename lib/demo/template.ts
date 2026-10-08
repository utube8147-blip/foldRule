// EXPERIMENT 1: a past project as a template. What carries over is what took judgement to
// set up (groups, their materials and rates, the price list, markups, currency, VAT, notes);
// what does not is anything tied to the old drawings (measurements, quantities, revisions, history).

import type { TakeoffRow } from '@/types';
import type { StoredProjectState } from '@/lib/storage/projectDb';

export interface TemplateSummary { groups: number; materialsUsed: number; hasMarkups: boolean; currency?: string; vatPercent?: number }

const newId = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `t-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`);

/** What a project would hand on, for the confirmation screen. */
export function summariseTemplate(src: StoredProjectState): TemplateSummary {
  const headers = src.measurements.filter(m => m.isGroupHeader && !m.presetId);
  const used = new Set(src.measurements.map(m => m.materialId).filter(Boolean));
  const mk = src.markups;
  return {
    groups: headers.length, materialsUsed: used.size, currency: src.currency, vatPercent: src.vatPercent,
    hasMarkups: !!mk && [mk.prelimsPercent, mk.prelimsSum, mk.contingencyPercent, mk.overheadPercent, mk.profitPercent].some(n => (n ?? 0) > 0),
  };
}

/** A group keeps the material and rate its rows shared, so new rows measured into it arrive priced. */
function emptyGroup(header: TakeoffRow, rows: TakeoffRow[]): TakeoffRow {
  const id = newId();
  const kids = rows.filter(r => !r.isGroupHeader && (r.parentId === header.id || (header.groupId && r.groupId === header.groupId) || header.childIds?.includes(r.id)));
  const mats = new Set(kids.map(k => k.materialId ?? ''));
  const rates = new Set(kids.map(k => k.unitRate || 0));
  const materialId = header.materialId ?? (mats.size === 1 && !mats.has('') ? kids[0].materialId : undefined);
  const unitRate = header.unitRate || (rates.size === 1 ? kids[0]?.unitRate ?? 0 : 0);
  return {
    ...header, id, groupId: header.groupId ? id : header.groupId, childIds: [], quantity: 0, points: [], holes: undefined,
    drawingId: '', pageNumber: undefined, materialId, unitRate, review: undefined, derived: undefined, times: undefined, isOverridden: false, isVisible: true,
    unit: header.unit || kids[0]?.unit || header.unit,
  };
}

/** The state of a new project started from `src`. `base` is an empty project (name, number, defaults). */
export function templateFromProject(src: StoredProjectState, base: StoredProjectState): StoredProjectState {
  const headers = src.measurements.filter(m => m.isGroupHeader && !m.presetId);
  return {
    ...base,
    materials: src.materials,
    currency: src.currency, vatPercent: src.vatPercent, markups: src.markups ? { ...src.markups, provisional: [] } : undefined,
    stakeholders: src.stakeholders, generalAssumptions: src.generalAssumptions, excludedItems: src.excludedItems,
    measurements: headers.map(h => emptyGroup(h, src.measurements)),
    drawings: [], activeDrawingId: null,
    revisionLog: undefined, veProposals: undefined, auditLog: undefined,
  };
}

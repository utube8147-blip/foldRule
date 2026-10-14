// The project as it is sent for export (no PDFs) → what the sheet builders take.
// Used by the browser (export page, quick export) and by POST /api/export.

import type { Material, TakeoffRow } from '@/types';
import type { TakeoffExportInput } from './exportTypes';

export interface ExportPayload {
  projectName: string;
  projectNumber?: string;
  projectLocation?: string;
  projectPhase?: string;
  kitchenType?: string;
  totalUnits?: number;
  documentTitle?: string;
  documentDate?: string;
  revision?: string;
  currency?: string;
  vatPercent?: number;
  stakeholders?: { mainContractor?: string; designConsultant?: string; supervision?: string; client?: string; projectManager?: string };
  drawingReferences?: string[];
  generalAssumptions?: Array<{ category: string; content: string }>;
  excludedItems?: Array<{ item: string; reason: string }>;
  drawings: Array<{ id: string; name: string; scaleFactor?: number; pageScales?: Record<string | number, number> }>;
  measurements: unknown[];
  materials: unknown[];
  estimate?: TakeoffExportInput['estimate'];
  auditLog?: TakeoffExportInput['auditLog'];
  valueEngineering?: TakeoffExportInput['valueEngineering'];
  revisionChanges?: TakeoffExportInput['revisionChanges'];
}

const text = (s?: string) => (s ?? '').trim() || undefined;

export function payloadToInput(p: ExportPayload): TakeoffExportInput {
  return {
    projectName:   p.projectName,
    projectNumber: text(p.projectNumber),
    location:      text(p.projectLocation),
    phase:         text(p.projectPhase),
    projectType:   text(p.kitchenType),
    totalUnits:    p.totalUnits,
    stakeholders:  p.stakeholders,
    drawingReferences: p.drawingReferences?.map(s => s.trim()).filter(Boolean),
    assumptions:   p.generalAssumptions?.filter(a => a.category || a.content).map(a => ({ category: a.category, content: a.content })),
    exclusions:    p.excludedItems?.filter(e => e.item || e.reason).map(e => ({ item: e.item, reason: e.reason })),
    documentTitle: text(p.documentTitle),
    documentDate:  text(p.documentDate),
    revision:      text(p.revision),
    currency:      p.currency,
    vatPercent:    p.vatPercent,
    drawings: p.drawings.map(d => ({
      id: d.id, name: d.name, scaleFactor: d.scaleFactor,
      pageScales: d.pageScales ? Object.fromEntries(Object.entries(d.pageScales).map(([k, v]) => [Number(k), v])) : undefined,
    })),
    measurements:  p.measurements as TakeoffRow[],
    materials:     p.materials as Material[],
    estimate:      p.estimate,
    auditLog:      p.auditLog,
    valueEngineering: p.valueEngineering,
    revisionChanges:  p.revisionChanges,
  };
}

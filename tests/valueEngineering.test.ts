import { describe, it, expect } from 'vitest';
import type { Material, TakeoffRow } from '@/types';
import { materialsInUse, veSummary, acceptProposal, restoreDesigned, setProposalStatus, type VeProposal } from '@/lib/takeoff/valueEngineering';

const row = (o: Partial<TakeoffRow>): TakeoffRow => ({
  id: 'x', childIds: [], drawingId: 'd', description: '', type: 'Area', quantity: 0, unit: 'sq m', unitRate: 0,
  notes: '', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], isOverridden: false, color: '#fff', isVisible: true, ...o,
});
const mat = (id: string, name: string, unitRate: number) => ({ id, name, code: '', category: '09', unit: 'sq m', unitRate, materialCost: 0, laborCost: 0, equipmentCost: 0 }) as Material;
const materials = [mat('marble', 'Marble flooring', 400), mat('porcelain', 'Porcelain tile', 310), mat('vinyl', 'Vinyl plank', 150), mat('paint', 'Emulsion paint', 20)];
const drawings = [{ id: 'd', pageTimes: { 2: 10 } }];
const rows = [
  row({ id: 'h', isGroupHeader: true, childIds: ['f1', 'f2'], points: [] }),
  row({ id: 'f1', parentId: 'h', quantity: 100, materialId: 'marble', unitRate: 400 }),
  row({ id: 'f2', parentId: 'h', quantity: 15, pageNumber: 2, materialId: 'marble', unitRate: 400 }),   // × 10 floors
  row({ id: 'p1', quantity: 500, materialId: 'paint', unitRate: 20 }),
  row({ id: 'n', quantity: 9 }),
];
const prop = (o: Partial<VeProposal>): VeProposal => ({ id: 'v1', fromMaterialId: 'marble', toMaterialId: 'porcelain', status: 'proposed', createdAt: '2026-10-07', ...o });

describe('value engineering', () => {
  it('lists the materials in use with billed quantity and cost, dearest first', () => {
    const use = materialsInUse(rows, drawings, materials);
    expect(use.map(u => u.materialId)).toEqual(['marble', 'paint']);
    expect(use[0]).toMatchObject({ quantity: 250, rows: 2, cost: 100000, rate: 400 });
  });

  it('prices an alternative across every row on the designed material', () => {
    const s = veSummary([prop({})], rows, drawings, materials);
    expect(s.lines[0]).toMatchObject({
      designed: 'Marble flooring', alternative: 'Porcelain tile', quantity: 250, rows: 2,
      designedCost: 100000, alternativeCost: 77500, saving: 22500, savingPercent: 22.5,
    });
    expect(s).toMatchObject({ accepted: 0, pending: 22500 });
  });

  it('counts only the best of several pending options for one material', () => {
    const s = veSummary([prop({}), prop({ id: 'v2', toMaterialId: 'vinyl' })], rows, drawings, materials);
    expect(s.pending).toBe(62500);
  });

  it('accepting swaps the material and rate on the rows, keeps the saving, and sets the other options aside', () => {
    const proposals = [prop({}), prop({ id: 'v2', toMaterialId: 'vinyl' })];
    const a = acceptProposal('v1', proposals, rows, materials, 'now');
    expect(a.measurements.find(m => m.id === 'f1')).toMatchObject({ materialId: 'porcelain', unitRate: 310 });
    expect(a.measurements.find(m => m.id === 'p1')).toMatchObject({ materialId: 'paint', unitRate: 20 });
    expect(a.proposals.map(p => p.status)).toEqual(['accepted', 'rejected']);
    const s = veSummary(a.proposals, a.measurements, drawings, materials);
    expect(s.lines[0]).toMatchObject({ designedCost: 100000, alternativeCost: 77500, saving: 22500 });
    expect(s).toMatchObject({ accepted: 22500, pending: 0 });
    // the takeoff really is cheaper now
    expect(materialsInUse(a.measurements, drawings, materials).find(u => u.materialId === 'porcelain')!.cost).toBe(77500);
  });

  it('the designed material can be put back, leaving rows changed since alone', () => {
    const a = acceptProposal('v1', [prop({})], rows, materials);
    const touched = a.measurements.map(m => (m.id === 'f2' ? { ...m, materialId: 'vinyl', unitRate: 150 } : m));
    const back = restoreDesigned('v1', a.proposals, touched);
    expect(back.measurements.find(m => m.id === 'f1')).toMatchObject({ materialId: 'marble', unitRate: 400 });
    expect(back.measurements.find(m => m.id === 'f2')).toMatchObject({ materialId: 'vinyl' });
    expect(back.proposals[0]).toMatchObject({ status: 'proposed', applied: undefined });
  });

  it('rejecting leaves the takeoff untouched and drops the saving from the pending total', () => {
    const p = setProposalStatus('v1', 'rejected', [prop({})]);
    expect(p[0].status).toBe('rejected');
    expect(veSummary(p, rows, drawings, materials).pending).toBe(0);
  });
});

import * as ExcelJS from 'exceljs';
import { buildProjectWorkbook } from '@/lib/export/projectWorkbook';

describe('value engineering sheet', () => {
  it('is added to the workbook with the comparison and totals', async () => {
    const s = veSummary([prop({ note: 'Same slip rating' })], rows, drawings, materials);
    const wb = await buildProjectWorkbook({
      projectName: 'Villa', currency: 'AED', drawings: [], materials: [], measurements: [],
      valueEngineering: { pending: s.pending, lines: s.lines.map(({ proposal, ...l }) => ({ ...l, status: proposal.status, note: proposal.note })) },
    });
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(await wb.xlsx.writeBuffer() as ArrayBuffer);
    const ws = back.getWorksheet('Value engineering')!;
    expect([ws.getCell('A5').value, ws.getCell('B5').value, ws.getCell('C5').value, ws.getCell('F5').value, ws.getCell('H5').value])
      .toEqual(['Marble flooring', 'Porcelain tile', 250, 100000, 77500]);
    expect(ws.getCell('K5').value).toBe('Proposed');
    expect(ws.getCell('L5').value).toBe('Same slip rating');
    expect(ws.getCell('I8').value).toBe(22500);
    expect((await buildProjectWorkbook({ projectName: 'V', drawings: [], materials: [], measurements: [] })).getWorksheet('Value engineering')).toBeUndefined();
  });
});

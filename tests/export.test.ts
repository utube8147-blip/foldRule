import { describe, it, expect } from 'vitest';
import * as ExcelJS from 'exceljs';
import { buildProjectWorkbook, safeXlsxFilename } from '@/lib/export/projectWorkbook';
import { orderRowsForExport, type TakeoffExportInput } from '@/lib/export/takeoffSheet';
import { buildWorkbookModel, cleanName } from '@/lib/export/workbookModel';
import { changeLogEntries } from '@/lib/export/changeLogSheet';
import { contextToBOQData } from '@/lib/export/boqMapping';
import type { Material, TakeoffRow } from '@/types';

const row = (over: Partial<TakeoffRow>): TakeoffRow => ({
  id: 'x', drawingId: 'd1', pageNumber: 1, description: 'Item', type: 'Length', quantity: 1,
  unit: 'm', unitRate: 0, notes: '', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], isOverridden: false,
  childIds: [], color: '#000', isVisible: true, ...over,
});

const input = (): TakeoffExportInput => ({
  projectName: 'Test House',
  currency: 'LKR',
  vatPercent: 18,
  drawings: [{ id: 'd1', name: 'A-101.pdf', pageScales: { 1: 0.01 } }],
  materials: [],
  measurements: [
    row({ id: 'g', isGroupHeader: true, groupName: 'Walls', childIds: ['a', 'b'], points: [], type: 'Length' }),
    row({ id: 'a', parentId: 'g', description: 'Wall A', quantity: 12.5, unitRate: 100 }),
    row({ id: 'b', parentId: 'g', description: 'Wall B', quantity: 7.5,  unitRate: 100 }),
    row({ id: 'c', description: 'Floor', type: 'Polygon', quantity: 20, unit: 'm²', unitRate: 50 }),
    row({ id: 'orphan', parentId: 'deleted-group', description: 'Orphan', quantity: 3, unitRate: 10 }),
  ],
});

const mat = (o: Partial<Material>): Material => ({
  id: 'm', name: 'M', code: '06', category: '06 Wood', unit: 'm²', unitRate: 10, materialCost: 8, laborCost: 2, equipmentCost: 0, ...o,
});

/** The RAK Doors case: one veneer used by area and by length, two "Solid Wood"s, a copied group. */
const doors = (): TakeoffExportInput => ({
  projectName: 'RAK Doors', currency: 'AED', vatPercent: 5,
  drawings: [{ id: 'd1', name: 'D-277.pdf', pageScales: { 1: 0.001 } }],
  materials: [
    mat({ id: 'veneer', name: 'Wrapping\nVeneer\nWD002\n', unit: 'm2', unitRate: 30, materialCost: 22, laborCost: 8 }),
    mat({ id: 'solid-a', name: 'Solid\nWood', unit: 'm²', unitRate: 0, materialCost: 0, laborCost: 0 }),
    mat({ id: 'solid-l', name: 'Solid\nWood', unit: 'm', unitRate: 57, materialCost: 45, laborCost: 12 }),
  ],
  measurements: [
    row({ id: 'g1', isGroupHeader: true, groupName: 'Door Leaf', childIds: ['l1'], points: [] }),
    row({ id: 'l1', parentId: 'g1', description: 'Door Leaf', type: 'Polygon', unit: 'sq m', quantity: 4.0849, materialId: 'veneer' }),
    row({ id: 'g2', isGroupHeader: true, groupName: 'Door Frame', childIds: ['f1', 'f2', 'f3'], points: [] }),
    row({ id: 'f1', parentId: 'g2', description: 'Door Frame 1', quantity: 5.3324, materialId: 'solid-l' }),
    row({ id: 'f2', parentId: 'g2', description: 'Door Frame 2', quantity: 2.1992, materialId: 'veneer' }),
    row({ id: 'f3', parentId: 'g2', description: 'Door Frame section', type: 'Polygon', unit: 'sq m', quantity: 0.0084, materialId: 'solid-a' }),
    // A copied group that still lists the same children — they must not be counted twice.
    row({ id: 'g3', isGroupHeader: true, groupName: 'Door Frame', childIds: ['f1', 'f2', 'f3'], points: [] }),
  ],
});

async function roundTrip(wb: ExcelJS.Workbook) {
  const buf = await wb.xlsx.writeBuffer();
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(buf as ArrayBuffer);
  return back;
}

const formulasIn = (ws: ExcelJS.Worksheet, column: number) => {
  const out: string[] = [];
  ws.eachRow(r => { const v = r.getCell(column).value as { formula?: string } | null; if (v && typeof v === 'object' && v.formula) out.push(v.formula); });
  return out;
};

describe('Takeoff sheet', () => {
  it('orders group children under their header and keeps orphans', () => {
    const ids = orderRowsForExport(input().measurements).map(r => `${r.row.id}:${r.level}`);
    expect(ids).toEqual(['g:0', 'a:1', 'b:1', 'c:0', 'orphan:0']);
  });

  it('exports the user’s real measurements (not sample data), after a Summary cover', async () => {
    const wb = await roundTrip(await buildProjectWorkbook(input()));
    expect(wb.worksheets.map(w => w.name)).toEqual(['Summary', 'Takeoff', 'Bill of Quantities']);
    const ws = wb.getWorksheet('Takeoff')!;
    const descs: string[] = [];
    ws.eachRow(r => { const v = r.getCell(3).value; if (typeof v === 'string') descs.push(v.trim()); });
    expect(descs).toEqual(expect.arrayContaining(['Walls', 'Wall A', 'Wall B', 'Floor', 'Orphan']));
    const all: string[] = [];
    for (const s of wb.worksheets) s.eachRow(r => r.eachCell(c => { if (typeof c.value === 'string') all.push(c.value); }));
    expect(all.join(' ')).not.toMatch(/kitchen/i);
  });

  it('writes amount, group subtotal and total formulas', async () => {
    const ws = (await roundTrip(await buildProjectWorkbook(input()))).getWorksheet('Takeoff')!;
    const formulas = formulasIn(ws, 11);
    expect(formulas.some(f => /^SUM\(K\d+:K\d+\)$/.test(f))).toBe(true);   // group subtotal
    expect(formulas.some(f => f.startsWith('SUMIF(M'))).toBe(true);        // subtotal w/o double count
    expect(formulas.some(f => /\*18\/100$/.test(f))).toBe(true);          // VAT
  });

  it('warns when a page was not calibrated', async () => {
    const i = input(); i.drawings[0].pageScales = {};
    const ws = (await roundTrip(await buildProjectWorkbook(i))).getWorksheet('Takeoff')!;
    expect(String(ws.getCell('B5').value)).toMatch(/calibrated/);
  });

  it('shows the material instead of the shape, and multiplies by the number of units', async () => {
    const i = doors(); i.totalUnits = 3;
    const ws = (await roundTrip(await buildProjectWorkbook(i))).getWorksheet('Takeoff')!;
    const materials: string[] = [];
    ws.eachRow(r => { const v = r.getCell(7).value; if (typeof v === 'string') materials.push(v); });
    expect(materials).toEqual(expect.arrayContaining(['Wrapping Veneer WD002', 'Solid Wood']));
    expect(formulasIn(ws, 11).some(f => /^K\d+\*3$/.test(f))).toBe(true);
  });
});

describe('workbook model', () => {
  it('cleans multi-line material names', () => {
    expect(cleanName('Wrapping\nVeneer\nWD002\n')).toBe('Wrapping Veneer WD002');
  });

  it('never adds lengths to areas: one column per material and unit', () => {
    const m = buildWorkbookModel(doors());
    const veneer = m.columns.filter(c => c.material.id === 'veneer');
    expect(veneer.map(c => [c.unit, c.net])).toEqual([['m²', 4.0849], ['m', 2.1992]]);
    expect(veneer[1].unitMismatch).toBe(true);
    expect(veneer[0].unitMismatch).toBe(false);
  });

  it('counts a row once even when two groups list it', () => {
    const m = buildWorkbookModel(doors());
    expect(m.rows.filter(r => r.row.id === 'f1')).toHaveLength(1);
    expect(m.columns.find(c => c.material.id === 'solid-l')!.net).toBe(5.3324);
    expect(m.sections.flatMap(s => s.components).map(c => c.name)).toEqual(['Door Leaf', 'Door Frame']);
  });

  it('labels same-named materials with their unit', () => {
    const labels = buildWorkbookModel(doors()).columns.map(c => c.label);
    expect(labels).toEqual(expect.arrayContaining(['Solid Wood (m)', 'Solid Wood (m²)', 'Wrapping Veneer WD002 (m)']));
  });
});

describe('material sheets', () => {
  it('adds BOQ_Matrix, Materials and Cost_Breakdown only when measurements use materials', async () => {
    const unused = input();
    unused.materials = [mat({ id: 'm1' })];
    expect((await buildProjectWorkbook(unused)).worksheets.map(w => w.name)).toEqual(['Summary', 'Takeoff', 'Bill of Quantities']);
    const names = (await buildProjectWorkbook(doors())).worksheets.map(w => w.name);
    expect(names).toEqual(['Summary', 'Takeoff', 'Bill of Quantities', 'BOQ_Matrix', 'Materials', 'Cost_Breakdown']);
  });

  it('puts the measured quantity in the matrix (not 1) and links Materials and Cost_Breakdown to it', async () => {
    const wb = await roundTrip(await buildProjectWorkbook(doors()));
    const matrix = wb.getWorksheet('BOQ_Matrix')!;
    const measured: unknown[] = [];
    matrix.eachRow(r => { if (r.getCell(2).value === '1.1') measured.push(r.getCell(6).value); });
    expect(measured).toEqual([4.0849]);
    expect(formulasIn(matrix, 7).every(f => /^F\d+\*IF\(E\d+<>"",E\d+,1\)$/.test(f))).toBe(true);
    // No board-size division hidden in the project totals.
    const all: string[] = [];
    matrix.eachRow(r => r.eachCell(c => { const v = c.value as { formula?: string }; if (v?.formula) all.push(v.formula); }));
    expect(all.join(' ')).not.toMatch(/2\.88/);

    const materials = wb.getWorksheet('Materials')!;
    expect(formulasIn(materials, 6).every(f => f.startsWith("'BOQ_Matrix'!"))).toBe(true);
    const cost = wb.getWorksheet('Cost_Breakdown')!;
    expect(formulasIn(cost, 6).some(f => f.startsWith("'Materials'!F"))).toBe(true);
  });
});

describe('change log', () => {
  it('is newest first and folds away "group added" noise', () => {
    const log = [
      { at: '2026-10-13T10:00:00Z', by: 'a', what: 'added', target: 'Wall', to: '5 m' },
      { at: '2026-10-14T10:00:00Z', by: 'a', what: 'quantity', target: 'Wall', from: '5 m', to: '6 m' },
      { at: '2026-10-14T10:00:00Z', by: 'a', what: 'added', target: 'Walls', to: 'group' },
    ];
    expect(changeLogEntries(log).map(e => e.what)).toEqual(['quantity', 'added']);
  });
});

describe('BOQ mapping', () => {
  it('keeps children whose group header was deleted', () => {
    const boq = contextToBOQData({ projectName: 'P', materials: [], measurements: input().measurements });
    const items = boq.sections.flatMap(s => s.components.flatMap(c => c.items.map(i => i.description)));
    expect(items).toContain('Orphan');
  });
});

describe('safeXlsxFilename', () => {
  it('strips header-breaking characters', () => {
    const f = safeXlsxFilename('evil"\r\nX-Injected: 1', 'P');
    expect(f).not.toMatch(/["\r\n:]/);
    expect(f.endsWith('.xlsx')).toBe(true);
  });
  it('falls back to the project name', () => {
    expect(safeXlsxFilename(undefined, 'My House')).toMatch(/^BOQ_My_House_\d{4}-\d{2}-\d{2}\.xlsx$/);
  });
});

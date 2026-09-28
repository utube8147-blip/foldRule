import { describe, it, expect } from 'vitest';
import * as ExcelJS from 'exceljs';
import { buildProjectWorkbook, safeXlsxFilename } from '@/lib/export/projectWorkbook';
import { orderRowsForExport, type TakeoffExportInput } from '@/lib/export/takeoffSheet';
import { contextToBOQData } from '@/lib/export/boqMapping';
import type { TakeoffRow } from '@/types';

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

async function roundTrip(wb: ExcelJS.Workbook) {
  const buf = await wb.xlsx.writeBuffer();
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(buf as ArrayBuffer);
  return back;
}

describe('Takeoff sheet', () => {
  it('orders group children under their header and keeps orphans', () => {
    const ids = orderRowsForExport(input().measurements).map(r => `${r.row.id}:${r.level}`);
    expect(ids).toEqual(['g:0', 'a:1', 'b:1', 'c:0', 'orphan:0']);
  });

  it('exports the user’s real measurements (not sample data)', async () => {
    const wb = await roundTrip(await buildProjectWorkbook(input()));
    expect(wb.worksheets.map(w => w.name)).toEqual(['Takeoff']);
    const ws = wb.getWorksheet('Takeoff')!;
    const descs: string[] = [];
    ws.eachRow(r => { const v = r.getCell(2).value; if (typeof v === 'string') descs.push(v.trim()); });
    expect(descs).toEqual(expect.arrayContaining(['Walls', 'Wall A', 'Wall B', 'Floor', 'Orphan']));
    expect(JSON.stringify(descs)).not.toMatch(/kitchen/i);
  });

  it('writes amount, group subtotal and total formulas', async () => {
    const wb = await roundTrip(await buildProjectWorkbook(input()));
    const ws = wb.getWorksheet('Takeoff')!;
    const formulas: string[] = [];
    ws.eachRow(r => {
      const v = r.getCell(9).value as { formula?: string } | null;
      if (v && typeof v === 'object' && v.formula) formulas.push(v.formula);
    });
    expect(formulas.some(f => /^SUM\(I\d+:I\d+\)$/.test(f))).toBe(true);   // group subtotal
    expect(formulas.some(f => f.startsWith('SUMIF(K'))).toBe(true);        // subtotal w/o double count
    expect(formulas.some(f => /\*18\/100$/.test(f))).toBe(true);          // VAT
  });

  it('warns when a page was not calibrated', async () => {
    const i = input(); i.drawings[0].pageScales = {};
    const ws = (await roundTrip(await buildProjectWorkbook(i))).getWorksheet('Takeoff')!;
    expect(String(ws.getCell('A3').value)).toMatch(/calibrated/);
  });

  it('adds the BOQ sheets when a material library exists', async () => {
    const i = input();
    i.materials = [{ id: 'm1', name: 'MDF 18mm', code: 'MDF18', category: 'Board', unit: 'm²', unitRate: 10, materialCost: 8, laborCost: 2, equipmentCost: 0 }];
    const wb = await buildProjectWorkbook(i);
    expect(wb.worksheets.length).toBeGreaterThan(1);
    expect(wb.worksheets[0].name).toBe('Takeoff');
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

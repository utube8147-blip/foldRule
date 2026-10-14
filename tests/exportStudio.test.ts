import { describe, it, expect } from 'vitest';
import * as ExcelJS from 'exceljs';
import { buildBase, studioState, exportXlsx } from '@/lib/export/studio/pipeline';
import { addEdit, parseInput, snapshot, type CellEdit } from '@/lib/export/studio/edits';
import { valueAt, recalc } from '@/lib/export/studio/recalc';
import { addr, key, parseAddr, type SheetModel } from '@/lib/export/studio/sheetModel';
import { display } from '@/lib/export/studio/format';
import { paletteFor, Palette } from '@/lib/export/theme';
import type { TakeoffExportInput } from '@/lib/export/exportTypes';
import type { Material, TakeoffRow } from '@/types';

const row = (o: Partial<TakeoffRow>): TakeoffRow => ({
  id: 'x', drawingId: 'd1', pageNumber: 1, description: 'Item', type: 'Polygon', quantity: 1, unit: 'sq m', unitRate: 0,
  notes: '', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], isOverridden: false, childIds: [], color: '#000', isVisible: true, ...o,
});
const mat = (o: Partial<Material>): Material => ({ id: 'm', name: 'M', code: '06', category: '06 Wood', unit: 'm²', unitRate: 10, materialCost: 8, laborCost: 2, equipmentCost: 0, ...o });

const input = (): TakeoffExportInput => ({
  projectName: 'RAK Doors', currency: 'AED', vatPercent: 5,
  drawings: [{ id: 'd1', name: 'D-277.pdf', pageScales: { 1: 0.001 } }],
  materials: [mat({ id: 'core', name: 'Door core', unitRate: 100, materialCost: 85, laborCost: 15 }), mat({ id: 'veneer', name: 'Veneer', unitRate: 30, materialCost: 22, laborCost: 8 })],
  measurements: [
    row({ id: 'g', isGroupHeader: true, groupName: 'Door Leaf', childIds: ['a', 'b'], points: [] }),
    row({ id: 'a', parentId: 'g', description: 'Core', quantity: 2, materialId: 'core' }),
    row({ id: 'b', parentId: 'g', description: 'Veneer', quantity: 4, materialId: 'veneer' }),
  ],
});

const sheet = (sheets: SheetModel[], name: string) => sheets.find(s => s.name === name)!;
/** Row of the first cell in column `c` whose value is `text`. */
function findRow(s: SheetModel, c: number, text: string): number {
  for (const [k, cell] of s.cells) { const [r, cc] = k.split(':').map(Number); if (cc === c && String(cell.v).trim() === text) return r; }
  throw new Error(`no "${text}" in column ${c} of ${s.name}`);
}

describe('export studio engine', () => {
  it('reads addresses and typed input like Excel', () => {
    expect(parseAddr('$K$12')).toEqual({ r: 12, c: 11 });
    expect(addr(12, 28)).toBe('AB12');
    expect(parseInput('=F9*2')).toEqual({ f: 'F9*2', v: null });
    expect(parseInput('1,250.5')).toEqual({ v: 1250.5 });
    expect(parseInput('5%')).toEqual({ v: 0.05 });
    expect(parseInput('Door')).toEqual({ v: 'Door' });
    expect(display(1234.5, '"AED "#,##0.00')).toBe('AED 1,234.50');
  });

  it('works out every formula, across sheets, and the totals agree', async () => {
    const st = studioState(await buildBase(input(), {}), []);
    const takeoff = sheet(st.sheets, 'Takeoff');
    const total = findRow(takeoff, 10, 'Total');
    expect(valueAt(st.values, takeoff, total, 11)).toBeCloseTo((2 * 100 + 4 * 30) * 1.05, 6);
    const cost = sheet(st.sheets, 'Cost_Breakdown');
    const diff = findRow(cost, 8, 'Difference (should be 0)');
    expect(valueAt(st.values, cost, diff, 11)).toBe(0);
    const errors = [...st.values.values()].flatMap(m => [...m.values()]).filter(v => typeof v === 'string' && v.startsWith('#'));
    expect(errors).toEqual([]);
  });

  it('an edited rate flows into the amount, the totals and the Summary', async () => {
    const base = await buildBase(input(), {});
    const takeoff = sheet(base, 'Takeoff');
    const r = findRow(takeoff, 3, 'Veneer');
    const rate = addr(r, 10);
    const edit: CellEdit = { sheet: 'Takeoff', addr: rate, input: '40', was: snapshot(takeoff.cells.get(key(r, 10))) };
    const st = studioState(base, [edit]);
    expect(st.applied).toHaveLength(1);
    const t = sheet(st.sheets, 'Takeoff');
    expect(valueAt(st.values, t, r, 11)).toBe(160);
    const summary = sheet(st.sheets, 'Summary');
    const measured = findRow(summary, 2, 'Measured work');
    expect(valueAt(st.values, summary, measured, 6)).toBe(360);
  });

  it('a quantity changed on the Takeoff flows to the Bill, Matrix, Materials and Cost_Breakdown', async () => {
    const base = await buildBase(input(), {});
    const takeoff = sheet(base, 'Takeoff');
    const r = findRow(takeoff, 3, 'Veneer');
    const st = studioState(base, [{ sheet: 'Takeoff', addr: addr(r, 8), input: '10', was: snapshot(takeoff.cells.get(key(r, 8))) }]);
    const total = (name: string, label: string, labelCol: number, valueCol: number) => {
      const s = sheet(st.sheets, name);
      return valueAt(st.values, s, findRow(s, labelCol, label), valueCol);
    };
    const expected = 2 * 100 + 10 * 30;
    expect(total('Takeoff', 'Subtotal', 10, 11)).toBe(expected);
    expect(total('Bill of Quantities', 'Subtotal', 5, 7)).toBeCloseTo(expected, 6);
    expect(total('Cost_Breakdown', 'Subtotal  (excl. VAT)', 8, 11)).toBeCloseTo(expected, 6);
    expect(total('Cost_Breakdown', 'Difference (should be 0)', 8, 11)).toBe(0);
    const materials = sheet(st.sheets, 'Materials');
    expect(valueAt(st.values, materials, findRow(materials, 4, 'Veneer'), 6)).toBe(10);
  });

  it('holds back an edit whose cell changed since (stale), until forced', async () => {
    const base = await buildBase(input(), {});
    const e: CellEdit = { sheet: 'Takeoff', addr: 'J9', input: '99', was: 'something else' };
    expect(studioState(base, [e]).stale).toHaveLength(1);
    expect(studioState(base, [{ ...e, force: true }]).applied).toHaveLength(1);
  });

  it('folds repeated edits of one cell together', () => {
    let edits: CellEdit[] = [];
    edits = addEdit(edits, { sheet: 'S', addr: 'A1', input: '1', was: '' });
    edits = addEdit(edits, { sheet: 'S', addr: 'A1', style: { bold: true }, was: 'ignored' });
    expect(edits).toEqual([{ sheet: 'S', addr: 'A1', input: '1', style: { bold: true }, was: '' }]);
  });

  it('marks circular references instead of hanging', () => {
    const s: SheetModel = { name: 'S', nRows: 2, nCols: 1, colWidths: [0, 9], rowHeights: [0, 15, 15], merges: [],
      cells: new Map([[key(1, 1), { v: null, f: 'A2+1', s: {} }], [key(2, 1), { v: null, f: 'A1+1', s: {} }]]) };
    const v = recalc([s]);
    expect(v.get('S')!.get(key(1, 1))).toBe('#CYCLE!');
  });

  it('saves edits, results and styles, and turns links to left-out sheets into values', async () => {
    const base = await buildBase(input(), {});
    const takeoff = sheet(base, 'Takeoff');
    const r = findRow(takeoff, 3, 'Veneer');
    const edits: CellEdit[] = [
      { sheet: 'Takeoff', addr: addr(r, 10), input: '40', was: snapshot(takeoff.cells.get(key(r, 10))) },
      { sheet: 'Takeoff', addr: addr(r, 3), style: { bg: '#FF0000', bold: true }, was: snapshot(takeoff.cells.get(key(r, 3))) },
    ];
    const blob = await exportXlsx(input(), { edits, exclude: ['Takeoff', 'Change log'] });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await blob.arrayBuffer());
    expect(wb.getWorksheet('Takeoff')).toBeUndefined();
    const summary = wb.getWorksheet('Summary')!;
    let measured: ExcelJS.CellValue = null;
    const listed: string[] = [];
    summary.eachRow(rw => {
      if (rw.getCell(2).value === 'Measured work') measured = rw.getCell(6).value;
      if (typeof rw.getCell(2).value === 'string') listed.push(rw.getCell(2).value as string);
    });
    expect(measured).toBe(360);                    // was ='Takeoff'!K…, now the value
    expect(listed).not.toContain('Takeoff');       // not named in "In this workbook"
    // Formulas that stay keep a stored result.
    const bill = wb.getWorksheet('Bill of Quantities')!;
    let withResult = 0;
    bill.eachRow(rw => rw.eachCell(c => { const v = c.value as ExcelJS.CellFormulaValue; if (v?.formula && v.result !== undefined) withResult++; }));
    expect(withResult).toBeGreaterThan(3);

    const kept = await exportXlsx(input(), { edits });
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(await kept.arrayBuffer());
    const cell = wb2.getWorksheet('Takeoff')!.getCell(addr(r, 3));
    expect((cell.fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFFF0000');
    expect(cell.font.bold).toBe(true);
    expect(wb2.getWorksheet('Takeoff')!.getCell(addr(r, 10)).value).toBe(40);
  });

  it('paints with the chosen theme and puts the default back afterwards', async () => {
    expect(paletteFor(undefined).NAVY).toBe('FF0D1B2A');
    const base = await buildBase(input(), { theme: { preset: 'foldrule', colors: { accent: '#FF6600' } } });
    const banner = sheet(base, 'Takeoff').cells.get(key(2, 2))!;
    expect(banner.s.bg).toBe('#1D2125');
    expect(sheet(base, 'Takeoff').cells.get(key(1, 2))!.s.bg).toBe('#FF6600');
    expect(Palette.NAVY).toBe('FF0D1B2A');
  });
});

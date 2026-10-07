import { describe, it, expect } from 'vitest';
import * as ExcelJS from 'exceljs';
import type { Material, TakeoffRow } from '@/types';
import { buildBill, classify, roundBillQuantity, billUnit, itemRef } from '@/lib/takeoff/pomi';
import { excelMoneyFormat, formatMoney, currencyInfo } from '@/lib/takeoff/currency';
import { buildProjectWorkbook } from '@/lib/export/projectWorkbook';

const row = (o: Partial<TakeoffRow>): TakeoffRow => ({
  id: 'x', childIds: [], drawingId: 'd', description: '', type: 'Area', quantity: 0, unit: 'sq m', unitRate: 0,
  notes: '', points: [], isOverridden: false, color: '#fff', isVisible: true, ...o,
});
const mat = (id: string, division: string, unitRate = 0) => ({ id, name: id, code: '', category: '', unit: '', unitRate,
  materialCost: 0, laborCost: 0, equipmentCost: 0, division }) as Material;

describe('POMI bill', () => {
  it('classifies by hand, then by material, then by wording', () => {
    const mats = new Map([['m', mat('m', '04')]]);
    expect(classify(row({ description: 'Paint', section: 'K' }), mats)).toBe('K');
    expect(classify(row({ description: 'Paint', materialId: 'm' }), mats)).toBe('D');
    expect(classify(row({ description: 'Wall A – Plaster, both sides' }), mats)).toBe('J');
    expect(classify(row({ description: 'Wall A – Blockwork' }), mats)).toBe('D');
    expect(classify(row({ description: 'Ground slab – Concrete slab' }), mats)).toBe('C');
    expect(classify(row({ description: 'D1 doors' }), mats)).toBe('H');
    expect(classify(row({ description: 'Zone 3' }), mats)).toBe('');
  });

  it('rounds billed quantities to whole units, never to nothing; tonnes to two places', () => {
    expect(roundBillQuantity(12.49, 'sq m')).toBe(12);
    expect(roundBillQuantity(12.5, 'sq m')).toBe(13);
    expect(roundBillQuantity(0.2, 'm')).toBe(1);
    expect(roundBillQuantity(0, 'm')).toBe(0);
    expect(roundBillQuantity(3.456, 't')).toBe(3.46);
    expect([billUnit('sq m'), billUnit('cu m'), billUnit('EA'), billUnit('m')]).toEqual(['m²', 'm³', 'nr', 'm']);
  });

  it('letters items without I or O', () => {
    expect([0, 7, 8, 12, 13, 23, 24].map(itemRef)).toEqual(['A', 'H', 'J', 'N', 'P', 'Z', 'AA']);
  });

  it('bills a group as one item, in section order, leaving out empty rows', () => {
    const rows = [
      row({ id: 'p', description: 'Wall A – Plaster, both sides', quantity: 56.22, unitRate: 30 }),
      row({ id: 'h', isGroupHeader: true, groupName: 'Blockwork 200mm', childIds: ['a', 'b'] }),
      row({ id: 'a', parentId: 'h', description: 'seg 1', quantity: 10.3, unitRate: 100 }),
      row({ id: 'b', parentId: 'h', description: 'seg 2', quantity: 5.3, unitRate: 100 }),
      row({ id: 'z', description: 'Zone 3', quantity: 4 }),
      row({ id: 'e', description: 'Paint', quantity: 0 }),
    ];
    const bill = buildBill(rows, []);
    expect(bill.map(s => s.code)).toEqual(['D', 'J', '']);
    expect(bill[0].items).toEqual([{ ref: 'A', description: 'Blockwork 200mm', measured: 15.6, quantity: 16, unit: 'm²', rate: 100, rowIds: ['a', 'b'] }]);
    expect(bill[1].items[0].quantity).toBe(56);
    expect(bill[2].title).toBe('Not yet classified');
  });

  it('leaves out a shape that is only the working for an assembly, unless it is priced', () => {
    const wall = row({ id: 'w', type: 'Length', unit: 'm', description: 'Wall W1', quantity: 10 });
    const plaster = row({ id: 'p', description: 'Wall W1 – Plaster', quantity: 60, derived: { sourceId: 'w', factor: 6, what: '' } });
    expect(buildBill([wall, plaster], []).flatMap(s => s.items.map(i => i.description))).toEqual(['Wall W1 – Plaster']);
    expect(buildBill([{ ...wall, unitRate: 5 }, plaster], []).flatMap(s => s.items).length).toBe(2);
  });

  it('formats Gulf currencies with the right decimals', () => {
    expect(excelMoneyFormat('BHD')).toBe('"BHD "#,##0.000');
    expect(excelMoneyFormat('AED')).toBe('"AED "#,##0.00');
    expect(formatMoney(1234.5, 'KWD')).toBe('KWD 1,234.500');
    expect(formatMoney(1234.5, 'SAR')).toBe('SAR 1,234.50');
    expect(currencyInfo('sar')?.vat).toBe(15);
  });

  it('adds a Bill of Quantities sheet with section totals, summary and VAT', async () => {
    const wb = await buildProjectWorkbook({
      projectName: 'Villa', currency: 'AED', vatPercent: 5, drawings: [], materials: [],
      measurements: [
        row({ id: 'a', description: 'Blockwork 200mm', quantity: 15.6, unitRate: 100 }),
        row({ id: 'p', description: 'Plaster', quantity: 56.22, unitRate: 30 }),
      ],
    });
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(await wb.xlsx.writeBuffer() as ArrayBuffer);
    const ws = back.getWorksheet('Bill of Quantities')!;
    const text: string[] = [];
    ws.eachRow(r => r.eachCell(c => { if (typeof c.value === 'string') text.push(c.value); }));
    expect(text).toEqual(expect.arrayContaining(['MASONRY', 'FINISHES', 'SUMMARY', 'VAT 5%', 'Total']));
    expect(ws.getCell('C7').value).toBe(16);
    expect(ws.getCell('F7').numFmt).toBe('"AED "#,##0.00');
  });
});

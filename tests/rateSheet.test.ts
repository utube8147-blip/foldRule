import { describe, it, expect } from 'vitest';
import { readRateTable, matchRates, pricesOfLine, rfqTable, parseCsv, toNumber } from '@/lib/takeoff/rateSheet';
import type { Material } from '@/types';

const mat = (id: string, code: string, name: string): Material =>
  ({ id, code, name, category: '09', unit: 'm²', unitRate: 0, materialCost: 0, laborCost: 0, equipmentCost: 0 });
const bank = [mat('a', '09 30 13', 'Ceramic floor tiles'), mat('b', '04 22 00', 'Concrete block wall, 150 mm'), mat('c', '04 22 00', 'Concrete block wall, 200 mm')];

describe('rate sheets', () => {
  it('reads numbers written the way people write prices', () => {
    expect(toNumber('AED 1,250.50')).toBe(1250.5);
    expect(toNumber('35')).toBe(35);
    expect(toNumber('')).toBeUndefined();
    expect(toNumber('tbc')).toBeUndefined();
  });

  it('round-trips the request sheet by reference', () => {
    const table = rfqTable([{ id: 'a', code: '09 30 13', name: 'Renamed by supplier', unit: 'm²', quantity: 120.456 }]);
    expect(table[1][4]).toBe(120.46);
    table[1][5] = 40; table[1][6] = 12;
    const m = matchRates(readRateTable(table), bank);
    expect(m.matched).toHaveLength(1);
    expect(m.matched[0].by).toBe('ref');
    expect(m.matched[0].prices).toEqual({ materialCost: 40, laborCost: 12, equipmentCost: 0, unitRate: 52 });
  });

  it('finds the heading row under a title and matches a supplier list by name', () => {
    const lines = readRateTable([
      ['Al Noor Trading - quotation'], [],
      ['Item', 'Description', 'UOM', 'Unit Price'],
      ['1', 'ceramic floor tiles', 'm2', '45.00'],
      ['2', 'Marble slab', 'm2', '300'],
      ['3', 'Concrete block wall, 200 mm', 'm2', ''],
    ]);
    const m = matchRates(lines, bank);
    expect(m.matched.map(x => x.material.id)).toEqual(['a']);
    expect(m.matched[0].prices.unitRate).toBe(45);
    expect(m.unmatched.map(l => l.name)).toEqual(['Marble slab']);
    expect(m.blank).toBe(1);
  });

  it('does not guess when a code fits two materials', () => {
    const m = matchRates([{ code: '04 22 00', rate: 60 }], bank);
    expect(m.matched).toHaveLength(0);
    expect(m.unmatched).toHaveLength(1);
  });

  it('prefers a breakdown over a single rate and ignores empty lines', () => {
    expect(pricesOfLine({ material: 10, labour: 5, rate: 99 })?.unitRate).toBe(15);
    expect(pricesOfLine({ rate: 0 })).toBeNull();
  });

  it('reads CSV with quoted commas', () => {
    const rows = parseCsv('Description,Rate\n"Concrete block wall, 150 mm",55\n');
    const m = matchRates(readRateTable(rows), bank);
    expect(m.matched[0].material.id).toBe('b');
  });
});

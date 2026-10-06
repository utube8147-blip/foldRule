import { describe, it, expect } from 'vitest';
import { takeoffToCsv } from '@/lib/export/csvExport';
import type { TakeoffRow } from '@/types';

const row = (o: Partial<TakeoffRow>): TakeoffRow => ({
  id: 'x', drawingId: 'd', description: '', type: 'Polygon', quantity: 0, unit: 'sq m', unitRate: 0, notes: '',
  points: [], isOverridden: false, childIds: [], color: '#000', isVisible: true, ...o,
} as TakeoffRow);

describe('CSV export', () => {
  const csv = takeoffToCsv({
    projectName: 'P',
    drawings: [{ id: 'd', name: 'Plan, level 1' }],
    measurements: [
      row({ id: 'g', description: 'Floors', isGroupHeader: true, childIds: ['a', 'b'], quantity: 30 }),
      row({ id: 'a', parentId: 'g', description: 'Living "big" room', quantity: 20, unitRate: 5 }),
      row({ id: 'b', parentId: 'g', description: 'Bed', quantity: 10, unitRate: 5 }),
      row({ id: 'c', description: '=SUM(A1)', type: 'Length', unit: 'm', quantity: 4 }),
    ],
  });
  it('numbers groups and children, and escapes text', () => {
    expect(csv).toContain('1,Floors,Group,30,sq m');
    expect(csv).toContain('1.1,"Living ""big"" room",Area,20,sq m,5,100');
    expect(csv).toContain('"Plan, level 1"');
    expect(csv).toContain("2,'=SUM(A1),Length,4,m");       // not run as a formula
  });
  it('totals by type without counting group headers twice', () => {
    expect(csv).toContain('Area,sq m,2,30,150');
    expect(csv).toContain('Grand total,,,,150');
  });
});

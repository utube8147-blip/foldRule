import { describe, it, expect } from 'vitest';
import { unitKind, kindForMeasurement } from '@/components/common/MaterialPicker';
import { DEFAULT_MATERIALS } from '@/data/materials';

describe('unit matching for the material picker', () => {
  it('recognises common ways of writing units', () => {
    for (const u of ['m', 'LM', 'lm', 'rm', 'metre']) expect(unitKind(u)).toBe('length');
    for (const u of ['m²', 'm2', 'sqm', 'Sq.m']) expect(unitKind(u)).toBe('area');
    for (const u of ['m³', 'm3', 'cum']) expect(unitKind(u)).toBe('volume');
    for (const u of ['EA', 'nr', 'Nos', 'pcs', 'set', 'pair']) expect(unitKind(u)).toBe('count');
    for (const u of ['kg', 't', 'sum', 'kW', '']) expect(unitKind(u)).toBe('other');
  });

  it('maps measurement types to the unit they are priced in', () => {
    expect(kindForMeasurement('Length')).toBe('length');
    for (const t of ['Area', 'Polygon', 'Rectangle']) expect(kindForMeasurement(t)).toBe('area');
    for (const t of ['Count', 'Point']) expect(kindForMeasurement(t)).toBe('count');
    expect(kindForMeasurement(undefined)).toBeNull();
  });

  it('a length sees no m² items from the catalogue, and still has plenty to pick', () => {
    const forLength = DEFAULT_MATERIALS.filter(m => unitKind(m.unit) === 'length');
    expect(forLength.length).toBeGreaterThan(20);
    expect(forLength.some(m => m.unit === 'm²')).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { DEFAULT_MATERIALS, MATERIAL_CATEGORIES, defaultMaterialBank, groupMaterialsByDivision, loadMaterialCatalog } from '@/data/materials';

describe('material catalogue', () => {
  it('has unique, stable ids', () => {
    const ids = DEFAULT_MATERIALS.map(m => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(id => id.startsWith('std-'))).toBe(true);
  });

  it('covers every division with materials that are well-formed', () => {
    for (const c of MATERIAL_CATEGORIES) {
      expect(DEFAULT_MATERIALS.some(m => m.division === c.code)).toBe(true);
    }
    for (const m of DEFAULT_MATERIALS) {
      expect(m.name.length).toBeGreaterThan(2);
      expect(m.unit.length).toBeGreaterThan(0);
      expect(m.code.startsWith(m.division!)).toBe(true);
      expect(m.category.startsWith(`${m.division} - `)).toBe(true);
    }
  });

  it('gives each project its own editable copy', () => {
    const a = defaultMaterialBank();
    a[0].unitRate = 999;
    expect(defaultMaterialBank()[0].unitRate).toBe(0);
    expect(DEFAULT_MATERIALS[0].unitRate).toBe(0);
  });

  it('groups materials by division in catalogue order', async () => {
    const groups = groupMaterialsByDivision(await loadMaterialCatalog());
    expect(groups.map(g => g.label.slice(0, 2))).toEqual(MATERIAL_CATEGORIES.map(c => c.code));
  });
});

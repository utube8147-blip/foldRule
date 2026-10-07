import { describe, it, expect } from 'vitest';
import type { Material } from '@/types';
import { reconcile, priceState, masterMaterials, setMaster, rateOf, type MasterBank } from '@/lib/takeoff/masterBank';

const mat = (id: string, rate = 0, o: Partial<Material> = {}): Material => ({
  id, name: id, code: '', category: '09', unit: 'm²', unitRate: rate, materialCost: 0, laborCost: 0, equipmentCost: 0, ...o,
});
const catalogue = [mat('tile', 0, { builtIn: true }), mat('paint', 0, { builtIn: true }), mat('block', 0, { builtIn: true }), mat('screed', 0, { builtIn: true })];
const bank = (items: Material[]): MasterBank => ({ items: Object.fromEntries(items.map(m => [m.id, m])) });

describe('master material bank', () => {
  it('tells the five price situations apart', () => {
    expect(priceState(mat('a'), mat('a'))).toBe('both-empty');
    expect(priceState(mat('a'), mat('a', 10))).toBe('project-empty');
    expect(priceState(mat('a', 10), mat('a'))).toBe('master-empty');
    expect(priceState(mat('a', 10), mat('a', 10.001))).toBe('same');
    expect(priceState(mat('a', 10), mat('a', 12))).toBe('differs');
    expect(rateOf(mat('a', 99, { materialCost: 5, laborCost: 3 }))).toBe(8);   // the breakdown wins
  });

  it('the master list is the catalogue with your prices on top, then your own materials', () => {
    const list = masterMaterials(bank([mat('tile', 120), mat('mine', 45)]), catalogue);
    expect(list.map(m => `${m.id}:${rateOf(m)}`)).toEqual(['tile:120', 'paint:0', 'block:0', 'screed:0', 'mine:45']);
    expect(list[0].builtIn).toBe(true);
  });

  it('fills an empty price from the other side and leaves two different prices alone', () => {
    const project = [mat('tile'), mat('paint', 18), mat('block', 60), mat('screed')];
    const r = reconcile(project, bank([mat('tile', 120), mat('block', 55)]), catalogue);
    // tile: project was empty → takes the master's
    expect(rateOf(r.project.find(m => m.id === 'tile'))).toBe(120);
    expect(r.filledProject).toEqual(['tile']);
    // paint: master was empty → takes the project's
    expect(rateOf(r.bank.items.paint)).toBe(18);
    expect(r.filledMaster).toEqual(['paint']);
    // block: both priced, differently → nothing changes, it is reported
    expect(rateOf(r.project.find(m => m.id === 'block'))).toBe(60);
    expect(rateOf(r.bank.items.block)).toBe(55);
    expect(r.differs).toEqual(['block']);
    // screed: nobody has a price → nothing to do
    expect(r.bank.items.screed).toBeUndefined();
  });

  it('carries the cost breakdown, not just the total', () => {
    const r = reconcile([mat('tile')], bank([mat('tile', 0, { materialCost: 80, laborCost: 30, equipmentCost: 5 })]), catalogue);
    expect(r.project[0]).toMatchObject({ materialCost: 80, laborCost: 30, equipmentCost: 5, unitRate: 115 });
  });

  it('shares your own materials both ways, so the master grows with each project', () => {
    const r = reconcile([mat('tile'), mat('local-aac', 35)], bank([mat('imported-stone', 400)]), catalogue);
    expect(rateOf(r.bank.items['local-aac'])).toBe(35);                        // made in this project → into the master
    expect(r.project.map(m => m.id)).toEqual(['tile', 'local-aac', 'imported-stone']);   // from another project → available here
    // a second project then starts with both prices
    const next = reconcile([mat('tile'), mat('paint')], r.bank, catalogue);
    expect(next.project.map(m => m.id).sort()).toEqual(['imported-stone', 'local-aac', 'paint', 'tile']);
  });

  it('returns the same list when nothing needed filling', () => {
    const project = [mat('tile', 120)];
    expect(reconcile(project, bank([mat('tile', 120)]), catalogue).project).toBe(project);
    expect(rateOf(setMaster({ items: {} }, mat('tile', 0, { materialCost: 7 })).items.tile)).toBe(7);
  });
});

import { mergeStoredBanks, type StoredBank } from '@/lib/takeoff/masterBank';
describe('merging the bank with the folder copy', () => {
  const m = (id: string, rate: number) => ({ id, name: id, code: '', category: '', unit: 'm', unitRate: rate, materialCost: rate, laborCost: 0, equipmentCost: 0 });
  const sb = (items: [string, number, number][], gone: [string, number][] = []): StoredBank => ({
    items: Object.fromEntries(items.map(([id, rate]) => [id, m(id, rate)])),
    stamps: Object.fromEntries([...items.map(([id, , at]) => [id, at]), ...gone]),
  });

  it('takes the newer price item by item, from either side', () => {
    const r = mergeStoredBanks(sb([['tile', 10, 100], ['block', 50, 300]]), sb([['tile', 12, 200], ['block', 40, 100], ['paint', 5, 50]]));
    expect(r.merged.items.tile.unitRate).toBe(12);
    expect(r.merged.items.block.unitRate).toBe(50);
    expect(r.merged.items.paint.unitRate).toBe(5);
    expect([r.localChanged, r.remoteChanged]).toEqual([true, true]);
  });

  it('does not bring back something removed later', () => {
    const r = mergeStoredBanks(sb([], [['tile', 500]]), sb([['tile', 12, 200]]));
    expect(r.merged.items.tile).toBeUndefined();
    expect(r.remoteChanged).toBe(true);
    expect(r.localChanged).toBe(false);
  });

  it('is quiet when both copies agree, and fills an empty computer from the folder', () => {
    const a = sb([['tile', 10, 100]]);
    expect(mergeStoredBanks(a, a)).toMatchObject({ localChanged: false, remoteChanged: false });
    const r = mergeStoredBanks({ items: {}, stamps: {} }, a);
    expect(r.merged.items.tile.unitRate).toBe(10);
    expect([r.localChanged, r.remoteChanged]).toEqual([true, false]);
  });
});

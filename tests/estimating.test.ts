import { describe, it, expect } from 'vitest';
import { unitRateOf, orderFor, orderSchedule } from '@/lib/takeoff/materialRate';
import { buildUp } from '@/lib/takeoff/estimate';
import { sanityWarnings } from '@/lib/takeoff/sanity';
import { suggestMaterials } from '@/lib/takeoff/suggestMaterial';
import { findScales } from '@/lib/takeoff/detectScale';
import { diffAudit, appendAudit } from '@/lib/takeoff/audit';
import type { Material, TakeoffRow } from '@/types';

const mat = (id: string, name: string, unit: string, o: Partial<Material> = {}): Material =>
  ({ id, name, code: '', category: '', unit, unitRate: 0, materialCost: 0, laborCost: 0, equipmentCost: 0, ...o });
const row = (id: string, o: Partial<TakeoffRow> = {}): TakeoffRow =>
  ({ id, drawingId: 'd', description: id, type: 'Area', quantity: 10, unit: 'm²', unitRate: 0, notes: '', points: [], isOverridden: false, childIds: [], color: '#fff', isVisible: true, ...o } as TakeoffRow);

describe('rates with waste and buying units', () => {
  it('leaves a plain rate alone', () => {
    expect(unitRateOf(mat('a', 'A', 'm²', { materialCost: 30, laborCost: 10 }))).toBe(40);
    expect(unitRateOf(mat('a', 'A', 'm²', { unitRate: 12 }))).toBe(12);
  });
  it('puts waste on the material only', () => {
    expect(unitRateOf(mat('a', 'A', 'm²', { materialCost: 30, laborCost: 10, wastePercent: 10 }))).toBe(43);
  });
  it('converts a price per box into a rate per square metre', () => {
    const tile = mat('t', 'Tile', 'm²', { materialCost: 72, laborCost: 15, purchase: { unit: 'box', covers: 1.44 }, wastePercent: 8 });
    expect(unitRateOf(tile)).toBe(69);                      // 72 / 1.44 = 50; × 1.08 = 54; + 15
    const o = orderFor(tile, 100);
    expect([o.orderQty, o.buyUnit, o.cost]).toEqual([75, 'box', 5400]);   // 108 m² / 1.44 = 75 boxes
  });
  it('rounds whole packs up and lists the dearest material first', () => {
    const block = mat('b', 'Block', 'm²', { materialCost: 2, purchase: { unit: 'nr', covers: 0.08 } });
    expect(orderFor(block, 10.01).orderQty).toBe(126);
    const s = orderSchedule([row('1', { materialId: 'b', quantity: 10 }), row('2', { materialId: 'x' }), row('3', { materialId: 'b', quantity: 5 })], [block]);
    expect(s).toHaveLength(1);
    expect(s[0].net).toBe(15);
  });
});

describe('estimate build-up', () => {
  it('is just measured work plus VAT with no markups', () => {
    const b = Object.fromEntries(buildUp(1000, undefined, 5).map(l => [l.key, l.amount]));
    expect([b.tender, b.vat, b.total]).toEqual([1000, 50, 1050]);
  });
  it('stacks preliminaries, provisional sums, contingency, overheads and profit in order', () => {
    const b = Object.fromEntries(buildUp(100000, { prelimsPercent: 10, provisional: [{ id: 'p', name: 'Signage', amount: 5000 }], contingencyPercent: 5, overheadPercent: 8, profitPercent: 10 }, 5).map(l => [l.key, l.amount]));
    expect(b.works).toBe(115000);
    expect(b.contingency).toBe(5750);
    expect(b.overheads).toBe(9660);
    expect(b.profit).toBe(13041);
    expect(b.tender).toBe(143451);
    expect(b.total).toBe(150623.55);
  });
  it('takes a lump sum for preliminaries over a percentage', () => {
    expect(buildUp(1000, { prelimsPercent: 10, prelimsSum: 250 }, 0).find(l => l.key === 'prelims')!.amount).toBe(250);
  });
});

describe('sanity checks', () => {
  it('catches a scale that makes a sheet half a kilometre wide', () => {
    const w = sanityWarnings({ measurements: [], materials: [], pages: [{ drawing: { id: 'd', name: 'arc house.pdf' }, page: 1, metresPerPoint: 0.5123 }] });
    expect(w[0].kind).toBe('scale');
    expect(w[0].level).toBe('likely-wrong');
  });
  it('flags a unit mismatch, a rate far from the bank, and a duplicate shape', () => {
    const pts = [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }, { x: 0.2, y: 0.2 }];
    const w = sanityWarnings({
      measurements: [
        row('wall', { unit: 'm', materialId: 'tile', unitRate: 5 }),
        row('floor', { materialId: 'tile', unitRate: 500, points: pts as TakeoffRow['points'] }),
        row('again', { points: pts as TakeoffRow['points'] }),
        row('fine', { materialId: 'tile', unitRate: 48 }),
      ],
      materials: [mat('tile', 'Tile', 'm²', { materialCost: 50 })], usual: [mat('tile', 'Tile', 'm²', { materialCost: 50 })],
    });
    expect(w.map(x => `${x.kind}:${x.rowId}`).sort()).toEqual(['duplicate:again', 'rate:floor', 'rate:wall', 'unit:wall']);
  });
  it('says nothing about an ordinary takeoff', () => {
    expect(sanityWarnings({ measurements: [row('a', { materialId: 't', unitRate: 50 })], materials: [mat('t', 'T', 'm²', { materialCost: 50 })], pages: [{ drawing: { id: 'd', name: 'p' }, page: 1, metresPerPoint: 0.03528 }] })).toEqual([]);
  });
});

describe('suggesting a material', () => {
  const bank = [mat('1', 'Ceramic floor tiles', 'm²'), mat('2', 'Ceramic wall tiles', 'm²'), mat('3', 'Power cable', 'm'), mat('4', 'Concrete block wall, 150 mm', 'm²'), mat('5', 'Solid timber door', 'EA'), mat('6', 'Tile adhesive', 'kg')];
  it('finds floor tiles for "Tile 1 floor area"', () => {
    expect(suggestMaterials('TILE 1 FLOOR AREA', bank, { unit: 'm²' })[0].material.id).toBe('1');
  });
  it('uses the unit: a wall measured in metres does not get a per-m² block first… unless that is all there is', () => {
    expect(suggestMaterials('Doors', bank, { unit: 'EA' })[0].material.id).toBe('5');
    expect(suggestMaterials('Wall', bank, { unit: 'm²' })[0].material.id).toBe('4');
  });
  it('offers nothing rather than a wild guess', () => {
    expect(suggestMaterials('Zone B', bank)).toEqual([]);
  });
});

describe('reading the scale from the drawing', () => {
  it('reads a labelled scale and prefers it', () => {
    expect(findScales(['GROUND FLOOR PLAN', 'SCALE 1:100', 'detail 1:20'])[0]).toMatchObject({ ratio: 100, confident: true });
    expect(findScales(['Scale: 1 / 50 @ A1'])[0].ratio).toBe(50);
  });
  it('ignores mix ratios, slopes and odd numbers', () => {
    expect(findScales(['concrete 1:2:4', 'ramp 1:12', 'ref 1:37'])).toEqual([]);
  });
});

describe('audit trail', () => {
  const base = [row('a', { quantity: 10, unitRate: 5 })];
  it('records quantity, rate and material changes with before and after', () => {
    const next = [{ ...base[0], quantity: 12, unitRate: 6, materialId: 'm' }];
    const e = diffAudit({ measurements: base }, { measurements: next, materials: [mat('m', 'Tile', 'm²')] }, 'qs@example.com');
    expect(e.map(x => `${x.what}:${x.from}>${x.to}`)).toEqual(['quantity:10 m²>12 m²', 'rate:5>6', 'material:none>Tile']);
    expect(e[0].by).toBe('qs@example.com');
  });
  it('records adds, removals and markups', () => {
    const e = diffAudit({ measurements: base, markups: { profitPercent: 5 } }, { measurements: [row('b')], markups: { profitPercent: 10 } }, 'me');
    expect(e.map(x => x.what)).toEqual(['added', 'removed', 'markup']);
  });
  it('merges quick repeated edits and drops a change that was undone', () => {
    const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
    let log = appendAudit(undefined, [{ at: t(0), by: 'me', what: 'rate', target: 'a', targetId: 'a', from: '5', to: '6' }]);
    log = appendAudit(log, [{ at: t(10), by: 'me', what: 'rate', target: 'a', targetId: 'a', from: '6', to: '7' }]);
    expect(log).toHaveLength(1);
    expect([log![0].from, log![0].to]).toEqual(['5', '7']);
    log = appendAudit(log, [{ at: t(20), by: 'me', what: 'rate', target: 'a', targetId: 'a', from: '7', to: '5' }]);
    expect(log).toHaveLength(0);
  });
});

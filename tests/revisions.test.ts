import { describe, it, expect } from 'vitest';
import type { TakeoffRow } from '@/types';
import { planCarryOver, revisionChanges, reviewProgress } from '@/lib/takeoff/revisions';

const row = (o: Partial<TakeoffRow>): TakeoffRow => ({
  id: 'x', childIds: [], drawingId: 'A', description: '', type: 'Length', quantity: 0, unit: 'm', unitRate: 0,
  notes: '', points: [{ x: 0.2, y: 0.2 }, { x: 0.6, y: 0.2 }], isOverridden: false, color: '#fff', isVisible: true, ...o,
});
const drawings = [{ id: 'A', name: 'Plan rev A', pageTimes: { 1: 2 } }, { id: 'B', name: 'Plan rev B', pageTimes: { 1: 2 } }];

const before = [
  row({ id: 'h', isGroupHeader: true, groupName: 'Walls', childIds: ['w1', 'w2'], points: [] }),
  row({ id: 'w1', parentId: 'h', description: 'Wall 1', quantity: 10, unitRate: 100 }),
  row({ id: 'w2', parentId: 'h', description: 'Wall 2', quantity: 5, unitRate: 100 }),
  row({ id: 'p', description: 'Wall 1 – Plaster', type: 'Area', unit: 'sq m', quantity: 60, unitRate: 10, points: [],
    derived: { sourceId: 'w1', factor: 6, what: '' } }),
  row({ id: 'arc', description: 'Curve', quantity: 3, points: [{ x: -1, y: -1 }, { x: 0.3, y: 0.3 }, { x: -1, y: -1 }] }),
  row({ id: 'other', description: 'Page 2 wall', pageNumber: 2, quantity: 7 }),
  row({ id: 'manual', description: 'Typed row', points: [], quantity: 1 }),
  row({ id: 'onB', drawingId: 'B', description: 'Already on B', quantity: 4 }),
];
const plan = () => planCarryOver({
  measurements: before, drawings, materials: [], from: { drawingId: 'A', page: 1 }, to: { drawingId: 'B', name: 'Plan rev B', page: 1 },
  shift: { x: 0.01, y: -0.02 }, flaggedIds: ['w1', 'other', 'nope'], revisionId: 'r1', at: '2026-10-07T00:00:00Z',
});
const apply = (rows: TakeoffRow[], u: Record<string, Partial<TakeoffRow>>) => rows.map(m => (u[m.id] ? { ...m, ...u[m.id] } : m));

describe('accepting a revision', () => {
  it('carries the page’s measurements and their group to the new sheet, and nothing else', () => {
    const { updates } = plan();
    expect(Object.keys(updates).sort()).toEqual(['arc', 'h', 'p', 'w1', 'w2']);
    expect(updates.w1.drawingId).toBe('B');
    expect(updates.h.drawingId).toBe('B');
  });

  it('moves shapes by the alignment and leaves arc markers alone', () => {
    const { updates } = plan();
    expect(updates.w1.points![0].x).toBeCloseTo(0.19, 9);
    expect(updates.w1.points![0].y).toBeCloseTo(0.22, 9);
    expect(updates.arc.points![0]).toEqual({ x: -1, y: -1 });
    expect(updates.arc.points![1].x).toBeCloseTo(0.29, 9);
  });

  it('marks only the rows on a change for checking', () => {
    const { updates, record } = plan();
    expect(updates.w1.review).toEqual({ revision: 'r1', status: 'check' });
    expect(updates.w2.review).toBeUndefined();
    expect(record.flagged).toEqual(['w1']);
    const after = apply(before, updates);
    expect(reviewProgress(after, 'r1')).toMatchObject({ open: 1, total: 1 });
    const ticked = after.map(m => (m.id === 'w1' ? { ...m, review: { revision: 'r1', status: 'done' as const } } : m));
    expect(reviewProgress(ticked, 'r1')).toMatchObject({ open: 0, total: 1 });
  });

  it('keeps the billed quantities as they stood, with group and rate', () => {
    const { record } = plan();
    expect(record.rows.find(r => r.id === 'w1')).toEqual({ id: 'w1', description: 'Wall 1', group: 'Walls', unit: 'm', type: 'Length', quantity: 20, rate: 100 });
    expect(record.rows.find(r => r.id === 'p')!.quantity).toBe(120);
    expect(record.existing).toEqual(['onB']);
  });

  it('reports what the revision changed: longer, removed, added, with the cost', () => {
    const { updates, record } = plan();
    let after = apply(before, updates);
    // On the new sheet wall 1 grew (and its plaster with it), wall 2 was deleted, a new wall was measured.
    after = after.filter(m => m.id !== 'w2').map(m =>
      m.id === 'w1' ? { ...m, quantity: 12 } : m.id === 'p' ? { ...m, quantity: 72 } : m);
    after.push(row({ id: 'new', drawingId: 'B', description: 'New wall', quantity: 3, unitRate: 100 }));
    const c = revisionChanges(record, after, drawings, []);
    const by = Object.fromEntries(c.lines.map(l => [l.id, l]));
    expect(by.w1).toMatchObject({ before: 20, after: 24, diff: 4, cost: 400, status: 'changed' });
    expect(by.p).toMatchObject({ before: 120, after: 144, diff: 24, cost: 240, status: 'changed' });
    expect(by.w2).toMatchObject({ before: 10, after: 0, diff: -10, cost: -1000, status: 'removed' });
    expect(by.new).toMatchObject({ before: 0, after: 6, status: 'added', cost: 600 });
    expect(by.arc.status).toBe('same');
    expect(by.onB).toBeUndefined();
    expect(c.cost).toBe(240);
    expect(c.counts).toEqual({ changed: 2, added: 1, removed: 1, same: 1 });
  });
});

import * as ExcelJS from 'exceljs';
import { buildProjectWorkbook } from '@/lib/export/projectWorkbook';

describe('revision changes sheet', () => {
  it('is added to the workbook only when a revision changed something', async () => {
    const base = { projectName: 'Villa', currency: 'AED', drawings: [], materials: [], measurements: [] };
    const none = await buildProjectWorkbook({ ...base, revisionChanges: [{ record: { at: '2026-10-07', from: { name: 'A' }, to: { name: 'B' } }, cost: 0,
      lines: [{ description: 'Wall', unit: 'm', before: 5, after: 5, diff: 0, rate: 1, cost: 0, status: 'same' }] }] });
    expect(none.getWorksheet('Revision changes')).toBeUndefined();
    const wb = await buildProjectWorkbook({ ...base, revisionChanges: [{ record: { at: '2026-10-07T01:00:00Z', from: { name: 'Rev A' }, to: { name: 'Rev B' } }, cost: 400,
      lines: [{ description: 'Wall 1', group: 'Walls', unit: 'm', before: 20, after: 24, diff: 4, rate: 100, cost: 400, status: 'changed' }] }] });
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(await wb.xlsx.writeBuffer() as ArrayBuffer);
    const ws = back.getWorksheet('Revision changes')!;
    expect(ws.getCell('A4').value).toContain('Rev A');
    expect(ws.getCell('A6').value).toBe('Wall 1 (Walls)');
    expect(ws.getCell('C6').value).toBe(20);
    expect(ws.getCell('D6').value).toBe(24);
  });
});

describe('revision versions', () => {
  it('freezes the old takeoff with its shapes and numbers the versions', () => {
    const first = plan().record;
    expect(first.fromVersion).toBe(1);
    expect(first.archive!.map(m => m.id).sort()).toEqual(['arc', 'h', 'p', 'w1', 'w2']);
    const frozenWall = first.archive!.find(m => m.id === 'w1')!;
    expect(frozenWall.drawingId).toBe('A');
    expect(frozenWall.points[0]).toEqual({ x: 0.2, y: 0.2 });           // not shifted, not shared
    expect(frozenWall.points[0]).not.toBe(before.find(m => m.id === 'w1')!.points[0]);
    expect(frozenWall.review).toBeUndefined();

    // Rev B is later replaced by Rev C: that old sheet is version 2.
    const onB = apply(before, plan().updates);
    const second = planCarryOver({
      measurements: onB, drawings: [...drawings, { id: 'C', name: 'Plan rev C' }], materials: [],
      from: { drawingId: 'B', page: 1 }, to: { drawingId: 'C', name: 'Plan rev C', page: 1 },
      flaggedIds: [], revisionId: 'r2', previous: [first],
    }).record;
    expect(second.fromVersion).toBe(2);
    expect(second.archive!.find(m => m.id === 'w1')!.points[0].x).toBeCloseTo(0.19, 9);
  });
});

import { switchVersion, versionNodes, newWorkSince, activeChild } from '@/lib/takeoff/revisions';

describe('moving between versions', () => {
  const accept = () => { const pl = plan(); return { live: apply(before, pl.updates), record: pl.record }; };
  const ids = (rows: TakeoffRow[], drawingId: string) => rows.filter(m => m.drawingId === drawingId).map(m => m.id).sort();

  it('restoring the old version puts its takeoff back and freezes the new one', () => {
    const { live, record } = accept();
    // work done on the new sheet: wall 1 lengthened, a new wall measured
    const worked = [...live.map(m => (m.id === 'w1' ? { ...m, quantity: 12 } : m)), row({ id: 'new', drawingId: 'B', description: 'New wall', quantity: 3 })];
    expect(newWorkSince(record, worked).map(m => m.id)).toEqual(['new']);

    const back = switchVersion(record, worked, [record], 'from');
    expect(back.error).toBeUndefined();
    expect(ids(back.measurements, 'A')).toEqual(['arc', 'h', 'manual', 'other', 'p', 'w1', 'w2']);
    expect(ids(back.measurements, 'B')).toEqual(['onB']);                    // new work discarded with the version
    const w1 = back.measurements.find(m => m.id === 'w1')!;
    expect(w1.quantity).toBe(10);
    expect(w1.points[0]).toEqual({ x: 0.2, y: 0.2 });
    expect(w1.review).toBeUndefined();
    expect(back.record.reverted).toBeTruthy();
    expect(back.record.toArchive!.map(m => m.id).sort()).toEqual(['arc', 'h', 'new', 'p', 'w1', 'w2']);
    expect(back.measurements.length).toBe(before.length);

    // …and going back to the new version brings that work back exactly
    const again = switchVersion(back.record, back.measurements, [back.record], 'to');
    expect(again.error).toBeUndefined();
    expect(again.record.reverted).toBeUndefined();
    expect(again.measurements.find(m => m.id === 'w1')).toMatchObject({ drawingId: 'B', quantity: 12 });
    expect(again.measurements.find(m => m.id === 'new')).toBeTruthy();
    expect(ids(again.measurements, 'B')).toEqual(['arc', 'h', 'new', 'onB', 'p', 'w1', 'w2']);
  });

  it('can keep what was measured on the new sheet when restoring', () => {
    const { live, record } = accept();
    const worked = [...live, row({ id: 'new', drawingId: 'B', description: 'New wall', quantity: 3 })];
    const back = switchVersion(record, worked, [record], 'from', true);
    expect(ids(back.measurements, 'B')).toEqual(['new', 'onB']);
  });

  it('brings back a carried row that was deleted on the new sheet', () => {
    const { live, record } = accept();
    const back = switchVersion(record, live.filter(m => m.id !== 'w2'), [record], 'from');
    expect(back.measurements.find(m => m.id === 'w2')).toMatchObject({ drawingId: 'A', quantity: 5 });
  });

  it('steps back one revision at a time and lists versions with their state', () => {
    const { live, record: r1 } = accept();
    const p2 = planCarryOver({
      measurements: live, drawings: [...drawings, { id: 'C', name: 'Plan rev C' }], materials: [],
      from: { drawingId: 'B', page: 1 }, to: { drawingId: 'C', name: 'Plan rev C', page: 1 }, flaggedIds: [], revisionId: 'r2', previous: [r1],
    });
    const log = [r1, p2.record];
    const onC = apply(live, p2.updates);
    expect(activeChild(r1, log)?.id).toBe('r2');
    expect(switchVersion(r1, onC, log, 'from').error).toMatch(/newer revision/);

    let nodes = versionNodes(log);
    expect(nodes.map(n => `${n.version}:${n.status}`)).toEqual(['1:superseded', '2:superseded', '3:current']);
    expect(nodes[0].blocked).toMatch(/version 2/);
    expect(nodes[1].restore).toEqual({ recordId: 'r2', target: 'from' });
    expect(nodes[2].rows).toBeUndefined();

    const back = switchVersion(p2.record, onC, log, 'from');
    nodes = versionNodes([r1, back.record]);
    expect(nodes.map(n => `${n.version}:${n.status}`)).toEqual(['1:superseded', '2:current', '3:set aside']);
    expect(nodes[0].restore).toEqual({ recordId: 'r1', target: 'from' });
    expect(nodes[2].restore).toEqual({ recordId: 'r2', target: 'to' });
  });
});

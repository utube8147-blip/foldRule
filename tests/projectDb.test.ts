import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import {
  createProject, getProject, listProjects, saveProjectState, saveDrawingFile, loadDrawingFiles,
  deleteProject, duplicateProject, exportProjectBackup, importProjectBackup, renameProject,
} from '@/lib/storage/projectDb';
import type { ProjectState } from '@/context/TakeoffContext';

const pdf = (text: string) => new File([`%PDF-1.4 ${text}`], 'A-101.pdf', { type: 'application/pdf' });

async function seed() {
  const rec = await createProject('Colombo Residence', 'P-042');
  const state: ProjectState = {
    ...(rec.state as ProjectState),
    drawings: [{ id: 'd1', name: 'A-101.pdf', fileUrl: 'blob:x', file: pdf('one'), scaleFactor: 1, pageScales: { 1: 0.02 }, pageCount: 2 }],
    activeDrawingId: 'd1',
    measurements: [{
      id: 'm1', drawingId: 'd1', pageNumber: 1, description: 'Wall', type: 'Length', quantity: 12,
      unit: 'm', unitRate: 0, notes: '', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], isOverridden: false,
      childIds: [], color: '#f00', isVisible: true,
    }],
  };
  await saveProjectState(rec.id, state);
  await saveDrawingFile(rec.id, 'd1', pdf('one'));
  return rec.id;
}

describe('projectDb', () => {
  it('saves state without File objects or blob URLs, and keeps PDFs separately', async () => {
    const id  = await seed();
    const rec = await getProject(id);
    expect(rec?.measurementCount).toBe(1);
    expect(rec?.state.drawings[0]).not.toHaveProperty('file');
    expect(rec?.state.drawings[0]).not.toHaveProperty('fileUrl');
    expect(rec?.state.drawings[0].pageScales).toEqual({ 1: 0.02 });
    const files = await loadDrawingFiles(id);
    expect(await files.get('d1')!.text()).toContain('one');
  });

  it('round-trips a project through a backup file', async () => {
    const id = await seed();
    const { blob, filename } = await exportProjectBackup(id);
    expect(filename).toBe('colombo-residence.foldrule');
    const imported = await importProjectBackup(new File([blob], filename));
    expect(imported.id).not.toBe(id);
    expect(imported.state.measurements[0].quantity).toBe(12);
    expect(await (await loadDrawingFiles(imported.id)).get('d1')!.text()).toContain('one');
  });

  it('rejects files that are not backups', async () => {
    await expect(importProjectBackup(new File(['{"hello":1}'], 'x.qsproj'))).rejects.toThrow(/not a Foldrule/);
    await expect(importProjectBackup(new File(['nope'], 'x.qsproj'))).rejects.toThrow(/not a valid/);
  });

  it('duplicates, renames and deletes (including stored PDFs)', async () => {
    const id   = await seed();
    const copy = await duplicateProject(id);
    expect(copy?.name).toBe('Colombo Residence (copy)');
    expect((await loadDrawingFiles(copy!.id)).size).toBe(1);

    await renameProject(copy!.id, 'Renamed');
    expect((await getProject(copy!.id))?.state.projectName).toBe('Renamed');

    await deleteProject(copy!.id);
    expect(await getProject(copy!.id)).toBeNull();
    expect((await loadDrawingFiles(copy!.id)).size).toBe(0);
    expect((await loadDrawingFiles(id)).size).toBe(1); // original untouched
    expect((await listProjects()).some(p => p.id === id)).toBe(true);
  });
});

describe('saved Magic Fill rooms', () => {
  it('saves, loads, and is removed with its drawing or project', async () => {
    const { putPageRegions, getPageRegions, deleteDrawingRegions } = await import('@/lib/storage/projectDb');
    const rec = (drawingId: string, projectId: string, page = 1) => ({
      key: `${drawingId}:${page}`, projectId, drawingId, page, version: 1, maskW: 100, maskH: 80,
      regions: [{ x0: 1, y0: 1, x1: 10, y1: 10, areaPx: 81, perimPx: 36, polygon: [[1, 1], [10, 1], [10, 10], [1, 10]] as [number, number][] }],
      createdAt: Date.now(),
    });
    const p = await createProject('Rooms test');
    await putPageRegions(rec('dA', p.id));
    await putPageRegions(rec('dB', p.id));
    expect((await getPageRegions('dA:1'))?.regions[0].areaPx).toBe(81);

    await deleteDrawingRegions('dA');
    expect(await getPageRegions('dA:1')).toBeNull();
    expect(await getPageRegions('dB:1')).not.toBeNull();

    await deleteProject(p.id);
    expect(await getPageRegions('dB:1')).toBeNull();
  });
});

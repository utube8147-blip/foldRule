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
    expect(filename).toBe('colombo-residence.qsproj');
    const imported = await importProjectBackup(new File([blob], filename));
    expect(imported.id).not.toBe(id);
    expect(imported.state.measurements[0].quantity).toBe(12);
    expect(await (await loadDrawingFiles(imported.id)).get('d1')!.text()).toContain('one');
  });

  it('rejects files that are not backups', async () => {
    await expect(importProjectBackup(new File(['{"hello":1}'], 'x.qsproj'))).rejects.toThrow(/not a Quantity Savior/);
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

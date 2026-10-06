import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as db from '@/lib/storage/projectDb';
import * as fs from '@/lib/storage/folderSync';

// ── A tiny in-memory File System Access implementation ──────────────────────
class FakeFile {
  kind = 'file' as const;
  constructor(public name: string, public data: Blob = new Blob([])) {}
  async getFile() { return new File([this.data], this.name); }
  async createWritable() {
    const chunks: BlobPart[] = [];
    return {
      write: async (d: BlobPart) => { chunks.push(d); },
      close: async () => { this.data = new Blob(chunks); },
    };
  }
}
class FakeDir {
  kind = 'directory' as const;
  entries = new Map<string, FakeDir | FakeFile>();
  permission: PermissionState = 'granted';
  constructor(public name: string) {}
  async *values() { yield* this.entries.values(); }
  async getDirectoryHandle(name: string, o?: { create?: boolean }) {
    const e = this.entries.get(name);
    if (e instanceof FakeDir) return e;
    if (!o?.create) throw Object.assign(new Error('nf'), { name: 'NotFoundError' });
    const d = new FakeDir(name); this.entries.set(name, d); return d;
  }
  async getFileHandle(name: string, o?: { create?: boolean }) {
    const e = this.entries.get(name);
    if (e instanceof FakeFile) return e;
    if (!o?.create) throw Object.assign(new Error('nf'), { name: 'NotFoundError' });
    const f = new FakeFile(name); this.entries.set(name, f); return f;
  }
  async removeEntry(name: string) { this.entries.delete(name); }
  async queryPermission() { return this.permission; }
  async requestPermission() { this.permission = 'granted'; return this.permission; }
}

let root: FakeDir;
(globalThis as unknown as { window: unknown }).window = globalThis;
(globalThis as unknown as { showDirectoryPicker: () => Promise<FakeDir> }).showDirectoryPicker = async () => root;


const pdf = () => new File(['%PDF-1.4 test'], 'A-101.pdf', { type: 'application/pdf' });

async function seedProject(name: string) {
  const rec = await db.createProject(name);
  const drawingId = db.newId();
  await db.putProjectRecord({
    ...rec, drawingCount: 1, updatedAt: Date.now(),
    state: { ...rec.state, drawings: [{ id: drawingId, name: 'A-101.pdf', scaleFactor: 1, pageScales: {}, pageCount: 1 }], activeDrawingId: drawingId },
  }, new Map([[drawingId, pdf()]]));
  return rec.id;
}

async function wipeLocal() {
  for (const p of await db.listProjects()) await db.deleteProject(p.id);
}

describe('folder sync', () => {
  beforeEach(async () => {
    root = new FakeDir('Projects');
    fs.__resetFolderSyncForTests();
    await wipeLocal();
  });

  it('connecting writes each project as a folder with project.json and its PDFs', async () => {
    const id = await seedProject('Colombo Residence');
    expect(await fs.connectFolder()).toBe(true);
    await fs.syncFolder();

    const dir = [...root.entries.values()][0] as FakeDir;
    expect(dir.name).toMatch(/^Colombo-Residence__[0-9a-z]{8}$/);
    const json = JSON.parse(await (await ((await dir.getFileHandle('project.json')) as FakeFile).getFile()).text());
    expect(json.project.id).toBe(id);
    const drawings = await dir.getDirectoryHandle('drawings');
    expect([...drawings.entries.keys()][0]).toMatch(/^A-101__[0-9a-z]{8}\.pdf$/);
  });

  it('pulls projects that exist only in the folder (e.g. from another computer)', async () => {
    const id = await seedProject('Warehouse');
    await fs.connectFolder();
    await fs.syncFolder();
    await wipeLocal();                             // "another computer" with an empty browser
    expect(await db.listProjects()).toHaveLength(0);

    const r = await fs.syncFolder();
    expect(r?.pulled).toBe(1);
    const back = await db.getProject(id);
    expect(back?.name).toBe('Warehouse');
    expect((await db.loadDrawingFiles(id)).size).toBe(1);
  });

  it('newer copy wins in each direction', async () => {
    const id = await seedProject('Kitchen');
    await fs.connectFolder();
    await fs.syncFolder();

    // Folder copy edited elsewhere, 1 minute later
    const dir = [...root.entries.values()][0] as FakeDir;
    const fh = (await dir.getFileHandle('project.json')) as FakeFile;
    const json = JSON.parse(await (await fh.getFile()).text());
    json.project.updatedAt += 60_000;
    json.project.state.projectName = 'Kitchen (edited elsewhere)';
    json.project.name = 'Kitchen (edited elsewhere)';
    fh.data = new Blob([JSON.stringify(json)]);

    const r = await fs.syncFolder();
    expect(r?.pulled).toBe(1);
    expect((await db.getProject(id))?.name).toBe('Kitchen (edited elsewhere)');
  });

  it('pauses without prompting when permission lapses, and catches up after "Allow"', async () => {
    await seedProject('One');
    await fs.connectFolder();
    await fs.syncFolder();

    root.permission = 'prompt';                    // e.g. browser restarted, not installed
    const id2 = await seedProject('Two');
    await fs.pushProjectToFolder(id2);
    expect(fs.getFolderStatus().permission).toBe('prompt');
    expect(root.entries.size).toBe(1);             // nothing written while paused

    expect(await fs.resumeFolder()).toBe(true);    // user clicks "Allow access"
    expect(root.entries.size).toBe(2);             // caught up
  });

  it('deleting a project removes its folder, even if access was paused at the time', async () => {
    const id = await seedProject('Temp');
    await fs.connectFolder();
    await fs.syncFolder();

    root.permission = 'prompt';
    await db.deleteProject(id);
    await fs.removeProjectFromFolder(id);          // remembered as a tombstone
    root.permission = 'granted';
    fs.__resetFolderSyncForTests();
    await fs.connectFolder();                      // re-open with access
    await fs.syncFolder();

    expect(root.entries.size).toBe(0);             // folder copy removed…
    expect(await db.getProject(id)).toBeNull();    // …and not re-imported
  });

  it('a second window (browser tab ↔ installed app) picks up the folder connected in the first', async () => {
    const id = await seedProject('Shared');
    // This window started with no folder connected.
    await db.deleteSetting('folderHandle');
    await fs.initFolderSync();
    expect(fs.getFolderStatus().folderName).toBeNull();

    // The other window connects a folder: the handle lands in the shared IndexedDB.
    const spy = vi.spyOn(db, 'getSetting').mockImplementation(async (key: string) =>
      (key === 'folderHandle' ? root : undefined) as never);
    try {
      await fs.refreshFolderState();               // what focus / the broadcast triggers
      expect(fs.getFolderStatus().folderName).toBe('Projects');
      expect(fs.getFolderStatus().permission).toBe('granted');
      await fs.syncFolder();
      expect(root.entries.size).toBe(1);           // and it starts saving there
      expect(await db.getProject(id)).not.toBeNull();

      // The other window stops using the folder: this one lets go too.
      spy.mockImplementation(async () => undefined as never);
      await fs.refreshFolderState();
      expect(fs.getFolderStatus().folderName).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as db from '@/lib/storage/projectDb';

describe('browser storage unavailable → run from memory', () => {
  afterEach(() => { vi.restoreAllMocks(); db.__resetStorageModeForTests(); });

  it('falls back when the database cannot be opened, and keeps working', async () => {
    db.__resetStorageModeForTests();
    vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      throw new DOMException('Internal error opening backing store for indexedDB.open.', 'UnknownError');
    });
    const seen: string[] = [];
    const off = db.subscribeStorageMode(() => seen.push(db.getStorageMode()));

    const rec = await db.createProject('Disk is full');
    expect(db.getStorageMode()).toBe('memory');
    expect(seen).toContain('memory');
    expect(db.getStorageModeReason()).toMatch(/disk is full/i);

    // Everything the app needs still works against the in-memory store.
    expect((await db.listProjects()).map(p => p.id)).toContain(rec.id);
    await db.saveDrawingFile(rec.id, 'd1', new File(['%PDF'], 'a.pdf', { type: 'application/pdf' }));
    expect((await db.loadDrawingFiles(rec.id)).size).toBe(1);
    await db.setSetting('k', 1);
    expect(await db.getSetting('k')).toBe(1);
    await db.deleteProject(rec.id);
    expect(await db.getProject(rec.id)).toBeNull();
    off();
  });
});

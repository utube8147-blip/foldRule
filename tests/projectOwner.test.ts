import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach } from 'vitest';
import * as db from '@/lib/storage/projectDb';

async function wipe() {
  db.setStorageOwner(null);
  for (const p of await db.listProjects()) await db.deleteProject(p.id);
}

describe('projects belong to the signed-in account', () => {
  afterEach(wipe);

  it('each account sees only its own projects on a shared computer', async () => {
    await wipe();
    db.setStorageOwner('alice');
    const a = await db.createProject('Alice house');
    db.setStorageOwner('bob');
    const b = await db.createProject('Bob shop');

    expect((await db.listProjects()).map(p => p.name)).toEqual(['Bob shop']);
    expect(await db.getProject(a.id)).toBeNull();                 // can't open Alice's by its link either
    expect((await db.getProject(b.id))?.ownerId).toBe('bob');

    db.setStorageOwner('alice');
    expect((await db.listProjects()).map(p => p.name)).toEqual(['Alice house']);
  });

  it('projects made before accounts are adopted by the first account that opens the list', async () => {
    await wipe();                                                  // local mode
    const old = await db.createProject('Old local project');
    expect(old.ownerId).toBeUndefined();

    db.setStorageOwner('alice');
    expect((await db.listProjects()).map(p => p.name)).toEqual(['Old local project']);
    expect((await db.getProject(old.id))?.ownerId).toBe('alice');

    db.setStorageOwner('bob');                                     // …and are then hers, not Bob's
    expect(await db.listProjects()).toHaveLength(0);
  });

  it('saving keeps the owner; duplicating and importing give the copy to the current account', async () => {
    await wipe();
    db.setStorageOwner('alice');
    const a = await db.createProject('Plan');
    await db.saveProjectState(a.id, { ...(a.state as never as object), projectName: 'Plan v2', drawings: [], measurements: [] } as never);
    expect((await db.getProject(a.id))?.ownerId).toBe('alice');
    const copy = await db.duplicateProject(a.id);
    expect(copy && (await db.getProject(copy.id))?.ownerId).toBe('alice');

    const { blob, filename } = await db.exportProjectBackup(a.id);
    db.setStorageOwner('bob');
    const imported = await db.importProjectBackup(new File([blob], filename));
    expect((await db.getProject(imported.id))?.ownerId).toBe('bob');
  });

  it('local mode (no accounts) shows everything', async () => {
    await wipe();
    db.setStorageOwner('alice');
    await db.createProject('A');
    db.setStorageOwner(null);
    await db.createProject('B');
    expect(await db.listProjects()).toHaveLength(2);
  });
});

describe('demo-account ids never lock a project', () => {
  afterEach(wipe);

  it('a project stamped by a demo account is adopted by the first real account', async () => {
    await wipe();
    const p = await db.createProject('Made in demo mode');
    await db.putProjectRecord({ ...p, ownerId: 'mock-1234' }, new Map());

    db.setStorageOwner('real-user');
    expect((await db.listProjects()).map(x => x.name)).toEqual(['Made in demo mode']);
    expect((await db.getProject(p.id))?.ownerId).toBe('real-user');
    expect(db.isForeignProject({ ownerId: 'mock-9999' })).toBe(false);
    expect(db.isForeignProject({ ownerId: 'someone-else' })).toBe(true);
  });
});

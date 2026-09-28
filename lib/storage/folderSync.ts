'use client';

// ─── lib/storage/folderSync.ts ───────────────────────────────────────────────
//
//  Optional "save projects to a folder" (File System Access API — Edge/Chrome).
//
//  Browser storage (projectDb) stays the working copy: saving NEVER waits on
//  the folder or on a permission. The folder is a mirror of real files:
//
//    <chosen folder>/
//      Colombo-Residence__1a2b3c4d/
//        project.json                 ← project state (measurements, groups…)
//        drawings/A-101__9f8e7d6c.pdf ← the original PDFs, written once
//
//  • The workspace pushes each save to the folder (when access is granted).
//  • The dashboard syncs both ways: folder copies that are newer (e.g. edited
//    on another computer via OneDrive) are pulled in; newer local ones pushed.
//  • Permission is only ever requested from a click (browsers require it).
//    If it lapses, the UI shows a small inline "Allow" — never a pop-up.
// ─────────────────────────────────────────────────────────────────────────────

import {
  getSetting, setSetting, deleteSetting, getProject, listProjects,
  loadDrawingFiles, putProjectRecord, SCHEMA_VERSION, type ProjectRecord,
} from './projectDb';

const HANDLE_KEY     = 'folderHandle';
const TOMBSTONES_KEY = 'deletedProjectIds';
const PROJECT_FILE   = 'project.json';
const DRAWINGS_DIR   = 'drawings';
const FORMAT         = 'foldrule-project-folder';
/** Ignore tiny clock differences when comparing copies. */
const NEWER_BY_MS    = 1000;

// ── Status store (read with useFolderStatus) ─────────────────────────────────

export interface FolderStatus {
  supported:   boolean;
  loaded:      boolean;
  folderName:  string | null;
  /** 'granted' = saving to folder; 'prompt' = paused until the user allows; 'denied' = blocked. */
  permission:  PermissionState | null;
  syncing:     boolean;
  lastSyncAt:  number | null;
  error:       string | null;
}

const initial: FolderStatus = {
  supported: false, loaded: false, folderName: null, permission: null,
  syncing: false, lastSyncAt: null, error: null,
};

let status: FolderStatus = initial;
const listeners = new Set<() => void>();
let rootHandle: FileSystemDirectoryHandle | null = null;
let initPromise: Promise<void> | null = null;

/** Test hook: forget in-memory state (the stored handle is untouched). */
export function __resetFolderSyncForTests(): void {
  rootHandle = null; initPromise = null; status = initial; syncChain = Promise.resolve();
}

function set(patch: Partial<FolderStatus>) {
  status = { ...status, ...patch };
  listeners.forEach(l => l());
}

export function subscribeFolderStatus(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
export const getFolderStatus = (): FolderStatus => status;
export const getServerFolderStatus = (): FolderStatus => initial;

export function isFolderSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

async function queryPermission(h: FileSystemDirectoryHandle): Promise<PermissionState> {
  try { return (await h.queryPermission?.({ mode: 'readwrite' })) ?? 'granted'; }
  catch { return 'prompt'; }
}

/** Load the saved folder (if any) and check — without prompting — whether we may use it. */
export function initFolderSync(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const supported = isFolderSupported();
    if (!supported) { set({ supported, loaded: true }); return; }
    try {
      const h = await getSetting<FileSystemDirectoryHandle>(HANDLE_KEY);
      if (h) {
        rootHandle = h;
        set({ supported, loaded: true, folderName: h.name, permission: await queryPermission(h) });
      } else {
        set({ supported, loaded: true });
      }
    } catch {
      set({ supported, loaded: true });
    }
  })();
  return initPromise;
}

// ── User actions (call from click handlers) ──────────────────────────────────

/** Let the user pick a folder. Returns false if they cancelled. */
export async function connectFolder(): Promise<boolean> {
  if (!window.showDirectoryPicker) return false;
  let h: FileSystemDirectoryHandle;
  try {
    h = await window.showDirectoryPicker({ id: 'foldrule-projects', mode: 'readwrite', startIn: 'documents' });
  } catch (err) {
    if ((err as DOMException)?.name === 'AbortError') return false;
    set({ error: 'Couldn’t open that folder. Try a different one.' });
    return false;
  }
  rootHandle = h;
  try { await setSetting(HANDLE_KEY, h); }
  catch (err) { console.warn('[folder] could not remember the folder for next time', err); }
  set({ folderName: h.name, permission: await queryPermission(h), error: null });
  await syncFolder();
  return true;
}

/** Re-grant access after it lapsed. Must run inside a click handler. */
export async function resumeFolder(): Promise<boolean> {
  if (!rootHandle) return false;
  try {
    const p = (await rootHandle.requestPermission?.({ mode: 'readwrite' })) ?? 'granted';
    set({ permission: p, error: null });
    if (p === 'granted') { await syncFolder(); return true; }
  } catch {
    set({ error: 'The browser didn’t allow access to that folder.' });
  }
  return false;
}

/** Stop mirroring to the folder. Files already there are left untouched. */
export async function disconnectFolder(): Promise<void> {
  rootHandle = null;
  await deleteSetting(HANDLE_KEY);
  set({ folderName: null, permission: null, lastSyncAt: null, error: null });
}

// ── File helpers ─────────────────────────────────────────────────────────────

const slug = (s: string) =>
  s.normalize('NFKD').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'Project';
const short = (id: string) => id.replace(/-/g, '').slice(0, 8).toLowerCase();
const SUFFIX = /__([0-9a-z]{8})$/;

async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: Blob | string) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w  = await fh.createWritable();
  await w.write(data);
  await w.close();
}

async function findProjectDir(root: FileSystemDirectoryHandle, id: string): Promise<FileSystemDirectoryHandle | null> {
  const s = short(id);
  for await (const entry of root.values()) {
    if (entry.kind === 'directory' && entry.name.endsWith(`__${s}`)) return entry as FileSystemDirectoryHandle;
  }
  return null;
}

async function writeProjectToDir(root: FileSystemDirectoryHandle, rec: ProjectRecord, files: Map<string, File>) {
  const dir = (await findProjectDir(root, rec.id))
    ?? await root.getDirectoryHandle(`${slug(rec.name)}__${short(rec.id)}`, { create: true });

  const payload = { format: FORMAT, schemaVersion: SCHEMA_VERSION, savedAt: new Date().toISOString(), project: rec };
  await writeFile(dir, PROJECT_FILE, JSON.stringify(payload, null, 1));

  // PDFs: write missing ones, remove ones whose drawing was deleted.
  const dDir = await dir.getDirectoryHandle(DRAWINGS_DIR, { create: true });
  const existing = new Map<string, string>(); // short drawing id → file name
  for await (const entry of dDir.values()) {
    const m = entry.kind === 'file' && entry.name.match(/__([0-9a-z]{8})\.pdf$/i);
    if (m) existing.set(m[1].toLowerCase(), entry.name);
  }
  const wanted = new Set<string>();
  for (const d of rec.state.drawings) {
    const s = short(d.id);
    wanted.add(s);
    const file = files.get(d.id);
    if (file && !existing.has(s)) {
      const base = slug(d.name.replace(/\.pdf$/i, ''));
      await writeFile(dDir, `${base}__${s}.pdf`, file);
    }
  }
  for (const [s, name] of existing) {
    if (!wanted.has(s)) await dDir.removeEntry(name).catch(() => {});
  }
}

async function readFolderProject(dir: FileSystemDirectoryHandle): Promise<ProjectRecord | null> {
  try {
    const fh   = await dir.getFileHandle(PROJECT_FILE);
    const data = JSON.parse(await (await fh.getFile()).text());
    if (data?.format !== FORMAT || !data.project?.id || !data.project?.state) return null;
    if (data.schemaVersion > SCHEMA_VERSION) return null; // made by a newer app version
    return data.project as ProjectRecord;
  } catch {
    return null;
  }
}

async function readFolderDrawings(dir: FileSystemDirectoryHandle, rec: ProjectRecord): Promise<Map<string, File>> {
  const out = new Map<string, File>();
  let dDir: FileSystemDirectoryHandle;
  try { dDir = await dir.getDirectoryHandle(DRAWINGS_DIR); } catch { return out; }
  const byShort = new Map(rec.state.drawings.map(d => [short(d.id), d]));
  for await (const entry of dDir.values()) {
    const m = entry.kind === 'file' && entry.name.match(/__([0-9a-z]{8})\.pdf$/i);
    const d = m ? byShort.get(m[1].toLowerCase()) : undefined;
    if (d) {
      const f = await (entry as FileSystemFileHandle).getFile();
      out.set(d.id, new File([f], d.name, { type: 'application/pdf' }));
    }
  }
  return out;
}

function describe(err: unknown): string {
  const name = (err as DOMException)?.name;
  if (name === 'NotFoundError') return 'The folder can’t be found — it may have been moved or deleted. Choose it again.';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'The browser blocked access to the folder.';
  if (name === 'QuotaExceededError') return 'The disk is full.';
  return 'Couldn’t save to the folder.';
}

// ── Sync ─────────────────────────────────────────────────────────────────────

let syncChain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = syncChain.then(fn, fn);
  syncChain = next.catch(() => {});
  return next;
};

const canWrite = () => !!rootHandle && status.permission === 'granted';

/**
 * Two-way sync (dashboard). Pulls newer folder copies into the browser and
 * pushes newer browser copies to the folder. No-op unless access is granted.
 */
export function syncFolder(): Promise<{ pulled: number; pushed: number } | null> {
  return serial(async () => {
    if (!rootHandle) return null;
    const permission = await queryPermission(rootHandle);
    if (permission !== 'granted') { set({ permission }); return null; }

    set({ syncing: true, permission });
    let pulled = 0, pushed = 0;
    try {
      const root       = rootHandle;
      const tombstones = new Set((await getSetting<string[]>(TOMBSTONES_KEY)) ?? []);
      const local      = new Map((await listProjects()).map(p => [p.id, p]));
      const inFolder   = new Map<string, { dir: FileSystemDirectoryHandle; rec: ProjectRecord }>();

      for await (const entry of root.values()) {
        if (entry.kind !== 'directory' || !SUFFIX.test(entry.name)) continue;
        const dir = entry as FileSystemDirectoryHandle;
        const rec = await readFolderProject(dir);
        if (!rec) continue;
        if (tombstones.has(rec.id)) {                 // deleted in the app
          await root.removeEntry(entry.name, { recursive: true }).catch(() => {});
          continue;
        }
        inFolder.set(rec.id, { dir, rec });
      }

      for (const { dir, rec } of inFolder.values()) {  // pull
        const mine = local.get(rec.id);
        if (!mine || rec.updatedAt > mine.updatedAt + NEWER_BY_MS) {
          await putProjectRecord(rec, await readFolderDrawings(dir, rec));
          pulled++;
        }
      }
      for (const p of local.values()) {                 // push
        const theirs = inFolder.get(p.id);
        if (!theirs || p.updatedAt > theirs.rec.updatedAt + NEWER_BY_MS) {
          const rec = await getProject(p.id);
          if (rec) { await writeProjectToDir(root, rec, await loadDrawingFiles(p.id)); pushed++; }
        }
      }
      await deleteSetting(TOMBSTONES_KEY);
      set({ syncing: false, lastSyncAt: Date.now(), error: null });
    } catch (err) {
      console.error('[folder] sync failed', err);
      set({ syncing: false, error: describe(err) });
    }
    return { pulled, pushed };
  });
}

/** Push one project after it was saved (workspace autosave). Never prompts. */
export function pushProjectToFolder(projectId: string): Promise<void> {
  if (!rootHandle) return Promise.resolve();
  return serial(async () => {
    if (!rootHandle) return;
    const permission = await queryPermission(rootHandle);
    if (permission !== 'granted') { set({ permission }); return; }
    try {
      const rec = await getProject(projectId);
      if (rec) await writeProjectToDir(rootHandle, rec, await loadDrawingFiles(projectId));
      set({ permission, lastSyncAt: Date.now(), error: null });
    } catch (err) {
      console.error('[folder] save failed', err);
      set({ error: describe(err) });
    }
  });
}

/** Remember a deletion so the folder copy is removed (now, or at the next sync). */
export async function removeProjectFromFolder(projectId: string): Promise<void> {
  if (!rootHandle) return;
  if (canWrite()) {
    await serial(async () => {
      const dir = await findProjectDir(rootHandle!, projectId);
      if (dir) await rootHandle!.removeEntry(dir.name, { recursive: true }).catch(() => {});
    });
    return;
  }
  const list = (await getSetting<string[]>(TOMBSTONES_KEY)) ?? [];
  if (!list.includes(projectId)) await setSetting(TOMBSTONES_KEY, [...list, projectId]);
}

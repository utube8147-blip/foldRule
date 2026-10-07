'use client';

// ─── lib/storage/folderSync.ts ───────────────────────────────────────────────
//
//  Optional "save projects to a folder" (File System Access API — Edge/Chrome).
//
//  Browser storage (projectDb) stays the working copy: saving NEVER waits on
//  the folder or on a permission. The folder is a mirror of real files:
//
//    <chosen folder>/
//      master-bank.json               ← your price list (all currencies), merged item by item
//      Colombo-Residence__1a2b3c4d/
//        project.json                 ← project state (measurements, groups…)
//        drawings/A-101__9f8e7d6c.pdf ← the original PDFs, written once
//
//  • The workspace pushes each save to the folder (when access is granted).
//  • The dashboard syncs both ways: folder copies that are newer (e.g. edited
//    on another computer via OneDrive) are pulled in; newer local ones pushed.
//  • Permission is only ever requested from a click (browsers require it).
//    If it lapses, the UI shows a small inline "Allow" — never a pop-up.
//  • THE FOLDER IS THE STORAGE. As soon as a folder is connected and the first
//    sync has put every project in it, project data stops being kept in the
//    browser at all (projectDb → setFolderPrimary): the browser remembers only
//    which folder it is. Projects are read from the folder when the app opens
//    (project.json up front, PDFs when a project is opened) and every save is
//    written straight back. Disconnecting copies everything back into the
//    browser first.
//  • ONE folder per device. The chosen folder is stored in IndexedDB, which the
//    browser tab and the installed app share (same browser profile). Every open
//    window therefore uses the same folder: connecting, changing, allowing or
//    disconnecting it in one window is announced to the others (BroadcastChannel)
//    and each window also re-checks whenever it regains focus. Writes from
//    different windows are serialised with a Web Lock.
// ─────────────────────────────────────────────────────────────────────────────

import {
  getSetting, setSetting, deleteSetting, getProject, listProjects,
  loadDrawingFiles, putProjectRecord, requestPersistentStorage, isForeignProject, SCHEMA_VERSION, type ProjectRecord,
  getStorageMode, isFolderPrimary, setFolderPrimary, setFolderFileLoader, copyProjectDataToDisk,
  copyMyDiskProjectsToMemory, deleteDiskProjects,
} from './projectDb';
import { mergeBanksWithCopy, MASTER_BANK_CHANGED, type StoredBank } from '@/lib/takeoff/masterBank';

/** Fired on `window` after a sync brought projects in from the folder. */
export const PROJECTS_PULLED_EVENT = 'foldrule:projects-pulled';

const HANDLE_KEY     = 'folderHandle';
const TOMBSTONES_KEY = 'deletedProjectIds';
const PROJECT_FILE   = 'project.json';
const DRAWINGS_DIR   = 'drawings';
const FORMAT         = 'foldrule-project-folder';
/** The company price list, kept beside the projects so it survives a cleared browser and travels with the folder. */
const BANK_FILE      = 'master-bank.json';
const BANK_FORMAT    = 'foldrule-master-bank';
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
  setFolderPrimary(false);
  rootHandle = null; initPromise = null; status = initial; syncChain = Promise.resolve();
}

// ── Keeping every window (browser tab + installed app) on the same folder ────

const CHANNEL_NAME = 'foldrule-folder';
const LOCK_NAME    = 'foldrule-folder-write';
let channel: BroadcastChannel | null = null;
let watching = false;

/** Tell the other open windows that the folder or its permission changed. */
function announce(): void {
  try { channel?.postMessage({ type: 'folder-changed' }); } catch { /* channel closed */ }
}

async function sameFolder(a: FileSystemDirectoryHandle | null, b: FileSystemDirectoryHandle | null): Promise<boolean> {
  if (a === b) return true;
  if (!a || !b) return false;
  try { return await a.isSameEntry(b); } catch { return false; }
}

/**
 * Re-read the saved folder and its permission. Picks up a folder that was
 * connected / changed / allowed / disconnected in another window (the browser
 * tab or the installed app). Never prompts.
 */
export async function refreshFolderState(): Promise<void> {
  if (!isFolderSupported()) return;
  if (initPromise) await initPromise;
  let stored: FileSystemDirectoryHandle | undefined;
  try { stored = await getSetting<FileSystemDirectoryHandle>(HANDLE_KEY); }
  catch { return; }

  if (!stored) {
    if (rootHandle) {
      rootHandle = null;
      set({ folderName: null, permission: null, lastSyncAt: null, error: null });
    }
    return;
  }

  const changed = !(await sameFolder(rootHandle, stored));
  if (changed) rootHandle = stored;
  const before     = status.permission;
  const permission = await queryPermission(rootHandle!);
  if (changed || permission !== before || status.folderName !== rootHandle!.name) {
    set({
      folderName: rootHandle!.name, permission,
      ...(changed ? { lastSyncAt: null, error: null } : {}),
      ...(permission === 'granted' && before !== 'granted' ? { error: null } : {}),
    });
  }
  // Newly usable here (connected or allowed elsewhere): bring both sides up to date.
  if (permission === 'granted' && (changed || before !== 'granted')) void syncFolder();
}

function startWatching(): void {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  if (typeof BroadcastChannel === 'function') {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = () => { void refreshFolderState(); };
  }
  const onWake = () => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') void refreshFolderState();
  };
  window.addEventListener?.('focus', onWake);
  window.addEventListener?.('pageshow', onWake);
  if (typeof document !== 'undefined') document.addEventListener?.('visibilitychange', onWake);
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

/** PDFs are read from the folder on demand when projects live there. */
function registerFileLoader(): void {
  setFolderFileLoader(async (projectId) => {
    const root = rootHandle;
    if (!root || (await queryPermission(root)) !== 'granted') throw new Error('folder not available');
    const rec = await getProject(projectId);
    const dir = rec ? await findProjectDir(root, projectId) : null;
    return rec && dir ? readFolderDrawings(dir, rec) : new Map<string, File>();
  });
}

/** Load the saved folder (if any) and check — without prompting — whether we may use it. */
export function initFolderSync(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const supported = isFolderSupported();
    if (!supported) { set({ supported, loaded: true }); return; }
    startWatching();
    watchMasterBank();
    registerFileLoader();
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
  registerFileLoader();
  try { await setSetting(HANDLE_KEY, h); }
  catch (err) { console.warn('[folder] could not remember the folder for next time', err); }
  // Ask the browser not to evict our storage (it holds the remembered folder).
  void requestPersistentStorage();
  set({ folderName: h.name, permission: await queryPermission(h), lastSyncAt: null, error: null });
  announce();
  await syncFolder();
  return true;
}

/** Re-grant access after it lapsed. Must run inside a click handler. */
export async function resumeFolder(): Promise<boolean> {
  if (!rootHandle) return false;
  try {
    const p = (await rootHandle.requestPermission?.({ mode: 'readwrite' })) ?? 'granted';
    set({ permission: p, error: null });
    if (p === 'granted') { announce(); await syncFolder(); return true; }
  } catch {
    set({ error: 'The browser didn’t allow access to that folder.' });
  }
  return false;
}

/** Stop mirroring to the folder. Files already there are left untouched. */
export async function disconnectFolder(): Promise<void> {
  // Projects live in the folder: bring them (and their PDFs) back into the
  // browser before letting go of it, or they would vanish from the app.
  if (isFolderPrimary()) {
    try {
      await copyProjectDataToDisk();
    } catch (err) {
      console.error('[folder] could not copy projects back into the browser', err);
      set({ error: 'Couldn’t copy your projects back into this browser (is the disk full?), so the folder is still in use.' });
      return;
    }
    setFolderPrimary(false);
  }
  rootHandle = null;
  await deleteSetting(HANDLE_KEY);
  set({ folderName: null, permission: null, lastSyncAt: null, error: null });
  announce();
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
/** One folder operation at a time — in this window, and across windows (Web Locks). */
const locked = <T>(fn: () => Promise<T>): Promise<T> => {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks?.request ? (locks.request(LOCK_NAME, fn) as Promise<T>) : fn();
};
const serial = <T>(work: () => Promise<T>): Promise<T> => {
  const fn = () => locked(work);
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
    const first = await syncOnce();
    // First clean sync with a folder: from here on the folder IS the storage.
    // Everything is in it now, so stop keeping project data in the browser —
    // load it from the folder (second pass) and clear the browser's copies.
    if (first && !status.error && !isFolderPrimary() && getStorageMode() === 'browser') {
      setFolderPrimary(true);
      const second = await syncOnce();
      // (That pass also removes this account's copies from the browser, and only
      // once they are safely in the folder — see syncOnce.)
      if (!second || status.error) { setFolderPrimary(false); return first; }
      return { pulled: first.pulled, pushed: first.pushed };
    }
    return first;
  });
}

async function syncOnce(): Promise<{ pulled: number; pushed: number } | null> {
  {
    if (!rootHandle) return null;
    const permission = await queryPermission(rootHandle);
    if (permission !== 'granted') { set({ permission }); return null; }

    set({ syncing: true, permission });
    let pulled = 0, pushed = 0;
    try {
      const root       = rootHandle;
      // Projects live in the folder: anything of this account's still sitting in
      // the browser database joins the sync, and is removed from the browser
      // only after the folder has it.
      const fromDisk   = isFolderPrimary() ? await copyMyDiskProjectsToMemory() : [];
      const tombstones = new Set((await getSetting<string[]>(TOMBSTONES_KEY)) ?? []);
      const local      = new Map((await listProjects()).map(p => [p.id, p]));
      const inFolder   = new Map<string, { dir: FileSystemDirectoryHandle; rec: ProjectRecord }>();

      for await (const entry of root.values()) {
        if (entry.kind !== 'directory' || !SUFFIX.test(entry.name)) continue;
        const dir = entry as FileSystemDirectoryHandle;
        const rec = await readFolderProject(dir);
        if (!rec) continue;
        // Someone else's project (several accounts can share one folder): leave it alone.
        if (isForeignProject(rec)) continue;
        if (tombstones.has(rec.id)) {                 // deleted in the app
          await root.removeEntry(entry.name, { recursive: true }).catch(() => {});
          continue;
        }
        inFolder.set(rec.id, { dir, rec });
      }

      for (const { dir, rec } of inFolder.values()) {  // pull
        const mine = local.get(rec.id);
        if (!mine || rec.updatedAt > mine.updatedAt + NEWER_BY_MS) {
          // Projects kept in the folder: only the record now, PDFs when it is opened.
          await putProjectRecord(rec, getStorageMode() === 'browser' ? await readFolderDrawings(dir, rec) : new Map());
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
      await syncBankFile(root);
      await deleteSetting(TOMBSTONES_KEY);
      await deleteDiskProjects(fromDisk).catch(err => console.warn('[folder] could not clear the browser copies', err));
      set({ syncing: false, lastSyncAt: Date.now(), error: null });
      // Lets an open screen that couldn't find its project (e.g. browser storage
      // is unavailable and the folder was just chosen) load it now.
      if (pulled > 0 && typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof Event === 'function') {
        window.dispatchEvent(new Event(PROJECTS_PULLED_EVENT));
      }
    } catch (err) {
      console.error('[folder] sync failed', err);
      set({ syncing: false, error: describe(err) });
    }
    return { pulled, pushed };
  }
}

// ── Master bank ──────────────────────────────────────────────────────────────

async function syncBankFile(root: FileSystemDirectoryHandle): Promise<boolean> {
  let remote: Record<string, StoredBank> = {};
  let exists = false;
  try {
    const fh = await root.getFileHandle(BANK_FILE);
    const data = JSON.parse(await (await fh.getFile()).text());
    if (data?.format === BANK_FORMAT && data.banks && typeof data.banks === 'object') { remote = data.banks; exists = true; }
  } catch { /* no file yet, or unreadable: this computer's copy is written */ }
  const { banks, localChanged, remoteChanged } = mergeBanksWithCopy(remote);
  const anything = Object.values(banks).some(b => Object.keys(b.items).length || Object.keys(b.stamps).length);
  if (anything && (!exists || remoteChanged)) {
    await writeFile(root, BANK_FILE, JSON.stringify({ format: BANK_FORMAT, savedAt: new Date().toISOString(), banks }, null, 1));
  }
  return localChanged;
}

/**
 * Two-way sync of the master bank with `master-bank.json` in the folder. Returns true when
 * newer prices were brought in. No-op unless access is granted; never prompts.
 */
export function syncMasterBank(): Promise<boolean> {
  if (!rootHandle) return Promise.resolve(false);
  return serial(async () => {
    if (!rootHandle || (await queryPermission(rootHandle)) !== 'granted') return false;
    try { return await syncBankFile(rootHandle); }
    catch (err) { console.error('[folder] master bank not saved', err); set({ error: describe(err) }); return false; }
  });
}

let bankTimer: ReturnType<typeof setTimeout> | null = null;
let bankWatching = false;
/** Write the bank to the folder shortly after it changes. */
function watchMasterBank(): void {
  if (bankWatching || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  bankWatching = true;
  window.addEventListener(MASTER_BANK_CHANGED, () => {
    if (bankTimer) clearTimeout(bankTimer);
    bankTimer = setTimeout(() => { void syncMasterBank(); }, 600);
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

// ─── lib/storage/projectDb.ts ────────────────────────────────────────────────
//
//  Local-first persistence for projects, using IndexedDB (not localStorage):
//    • handles large PDF blobs (localStorage caps at ~5 MB and is string-only)
//    • async, so saving never blocks the canvas
//
//  Stores
//    projects  { id, name, number, createdAt, updatedAt, measurementCount,
//                drawingCount, state }         state = ProjectState without File/URL
//    files     { key: `${projectId}:${drawingId}`, projectId, drawingId,
//                name, type, blob }
//
//  When a backend is added later, keep this module's function signatures and
//  swap the implementation (or sync from here) — callers won't need to change.
// ─────────────────────────────────────────────────────────────────────────────

import { DEFAULT_CURRENCY, currencyInfo } from '@/lib/takeoff/currency';
import type { ProjectState } from '@/context/TakeoffContext';
import type { Drawing } from '@/types';
import { defaultMaterialBank } from '@/data/materials';

// NOTE: internal IDs predate the Foldrule rename. Do not change them — the
// database name and backup format string identify existing users' data.
const DB_NAME    = 'quantity-savior';
const DB_VERSION = 3; // v2: `settings` store · v3: `regions` store (Magic Fill rooms)
const PROJECTS   = 'projects';
const FILES      = 'files';
const SETTINGS   = 'settings';
const REGIONS    = 'regions';

export const SCHEMA_VERSION = 1;

export type StoredDrawing = Omit<Drawing, 'file' | 'fileUrl'>;
export type StoredProjectState = Omit<ProjectState, 'drawings'> & { drawings: StoredDrawing[] };

export interface ProjectRecord {
  id:               string;
  name:             string;
  number:           string;
  createdAt:        number;
  updatedAt:        number;
  measurementCount: number;
  drawingCount:     number;
  schemaVersion:    number;
  /** Account that owns this project (absent on projects made before accounts, or in local mode). */
  ownerId?:         string;
  state:            StoredProjectState;
}

export type ProjectSummary = Omit<ProjectRecord, 'state'>;

interface FileRecord {
  key:       string;
  projectId: string;
  drawingId: string;
  name:      string;
  type:      string;
  blob:      Blob;
}

// ── Low-level helpers ────────────────────────────────────────────────────────

let dbPromise: Promise<IDBDatabase> | null = null;

export function isStorageAvailable(): boolean {
  return typeof globalThis !== 'undefined' && typeof globalThis.indexedDB !== 'undefined';
}

function createStores(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(PROJECTS)) {
    db.createObjectStore(PROJECTS, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(FILES)) {
    const files = db.createObjectStore(FILES, { keyPath: 'key' });
    files.createIndex('projectId', 'projectId', { unique: false });
  }
  if (!db.objectStoreNames.contains(SETTINGS)) {
    db.createObjectStore(SETTINGS);
  }
  if (!db.objectStoreNames.contains(REGIONS)) {
    const r = db.createObjectStore(REGIONS, { keyPath: 'key' });
    r.createIndex('projectId', 'projectId', { unique: false });
    r.createIndex('drawingId', 'drawingId', { unique: false });
  }
}

// ── Storage mode ─────────────────────────────────────────────────────────────
//
//  'browser'  normal: IndexedDB on disk.
//  'memory'   the browser's storage is broken on this computer (typically the
//             disk holding the browser profile is full: "Internal error opening
//             backing store", FILE_ERROR_NO_SPACE). The app then runs on an
//             in-memory database with the same API, so everything keeps
//             working — and the projects FOLDER (lib/storage/folderSync.ts)
//             becomes the only thing that persists. Nothing in memory survives
//             a reload, so the UI asks for the folder (StorageModeBanner).
//
//  Why IndexedDB at all when a folder is connected? The browser can only
//  remember the chosen folder *in IndexedDB*, folder access can lapse until the
//  user clicks "Allow", and network/cloud folders can be slow or offline — so
//  the browser copy is what makes every save instant and prompt-free. When it
//  is unavailable we fall back to folder-only rather than refusing to work.

export type StorageMode = 'browser' | 'memory' | 'folder';

// ── "Projects live in my folder" ─────────────────────────────────────────────
//
//  Once a projects folder is connected (lib/storage/folderSync.ts) it becomes
//  THE place projects and PDFs are stored. The browser then keeps only the
//  small settings store on disk — which folder it is, mainly — and project
//  data is held in memory while the app is open, read from the folder and
//  written back to it on every save. Nothing bulky goes into the browser
//  profile (so a full C: drive stops mattering), and the folder is always the
//  complete, current copy.
//
//  The choice is a flag in localStorage so it is known before any data is
//  touched. getStorageMode() reports 'folder' in this state.

const FOLDER_PRIMARY_KEY = 'foldrule:projects-in-folder';
let folderPrimary: boolean = (() => {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(FOLDER_PRIMARY_KEY) === '1'; }
  catch { return false; }
})();
let memDataPromise: Promise<IDBDatabase> | null = null;
/** The disk database opens, but project data can't be written to it (e.g. quota). */
let dataOnDiskBroken = false;

export const isFolderPrimary = (): boolean => folderPrimary;

/** Switch where project data is kept. Does not move anything — see folderSync. */
export function setFolderPrimary(on: boolean): void {
  if (folderPrimary === on) return;
  folderPrimary = on;
  if (!on) { memDataPromise = null; hydratedFromFolder.clear(); }
  try {
    if (typeof localStorage !== 'undefined') {
      if (on) localStorage.setItem(FOLDER_PRIMARY_KEY, '1'); else localStorage.removeItem(FOLDER_PRIMARY_KEY);
    }
  } catch { /* storage blocked: the choice lasts for this session */ }
  modeListeners.forEach(l => l());
}

/**
 * Reads a project's PDFs from the folder the first time they are needed (set
 * by folderSync). Keeps opening the project list cheap: only project.json
 * files are read up front, drawings when a project is actually opened.
 */
type FolderFileLoader = (projectId: string) => Promise<Map<string, File>>;
let folderFileLoader: FolderFileLoader | null = null;
const hydratedFromFolder = new Set<string>();
export function setFolderFileLoader(fn: FolderFileLoader | null): void { folderFileLoader = fn; }

/**
 * Projects of the current account that are still in the on-disk browser
 * database (made before the folder took over, or by an account that hadn't
 * synced yet) are copied into memory so the next folder sync writes them out.
 * Returns their ids; call deleteDiskProjects(ids) once that sync has succeeded.
 * Other accounts' projects are left where they are.
 */
export async function copyMyDiskProjectsToMemory(): Promise<string[]> {
  if (!folderPrimary || storageMode === 'memory') return [];
  const disk = await openDiskDb();
  const mine = (await reqToPromise(disk.transaction(PROJECTS, 'readonly').objectStore(PROJECTS).getAll() as IDBRequest<ProjectRecord[]>)).filter(isMine);
  if (mine.length === 0) return [];
  const mem = await openDb();
  for (const rec of mine) {
    const have = await reqToPromise(mem.transaction(PROJECTS, 'readonly').objectStore(PROJECTS).get(rec.id) as IDBRequest<ProjectRecord | undefined>);
    if (have && have.updatedAt >= rec.updatedAt) continue;         // the folder's copy is as new or newer
    const files = await reqToPromise(disk.transaction(FILES, 'readonly').objectStore(FILES).index('projectId').getAll(rec.id) as IDBRequest<FileRecord[]>);
    const tx = mem.transaction([PROJECTS, FILES], 'readwrite');
    tx.objectStore(PROJECTS).put(owned(rec));
    for (const f of files) tx.objectStore(FILES).put(f);
    await txDone(tx);
  }
  return mine.map(r => r.id);
}

/** Remove these projects (and their PDFs / saved rooms) from the on-disk browser database. */
export async function deleteDiskProjects(ids: string[]): Promise<void> {
  if (ids.length === 0 || storageMode === 'memory') return;
  const disk = await openDiskDb();
  const tx = disk.transaction([PROJECTS, FILES, REGIONS], 'readwrite');
  for (const id of ids) {
    tx.objectStore(PROJECTS).delete(id);
    for (const store of [FILES, REGIONS]) {
      const keys = await reqToPromise(tx.objectStore(store).index('projectId').getAllKeys(id));
      for (const k of keys) tx.objectStore(store).delete(k);
    }
  }
  await txDone(tx);
}

/** Copy every project (with its PDFs) from memory into the on-disk browser database. */
export async function copyProjectDataToDisk(): Promise<void> {
  if (!folderPrimary || storageMode === 'memory') return;
  const mem = await openDb();
  const all = await reqToPromise(mem.transaction(PROJECTS, 'readonly').objectStore(PROJECTS).getAll() as IDBRequest<ProjectRecord[]>);
  const disk = await openDiskDb();
  for (const rec of all) {
    const files = await loadDrawingFiles(rec.id);       // pulls PDFs in from the folder if needed
    const tx = disk.transaction([PROJECTS, FILES], 'readwrite');
    tx.objectStore(PROJECTS).put(rec);
    for (const [drawingId, file] of files) {
      tx.objectStore(FILES).put({
        key: `${rec.id}:${drawingId}`, projectId: rec.id, drawingId,
        name: file.name, type: file.type || 'application/pdf', blob: file,
      } satisfies FileRecord);
    }
    await txDone(tx);
  }
}
let storageMode: StorageMode = 'browser';
let storageModeReason: string | null = null;
const modeListeners = new Set<() => void>();
export const getStorageMode = (): StorageMode =>
  (storageMode === 'memory' ? 'memory' : folderPrimary ? 'folder' : dataOnDiskBroken ? 'memory' : 'browser');
/** True when even the small settings store (which remembers the folder) can't be kept on disk. */
export const isBrowserStorageUnusable = (): boolean => storageMode === 'memory';
export const getServerStorageMode = (): StorageMode => 'browser';
export const getStorageModeReason = (): string | null => storageModeReason;
export function subscribeStorageMode(cb: () => void): () => void {
  modeListeners.add(cb);
  return () => { modeListeners.delete(cb); };
}

/** Test hook: back to on-disk storage. */
export function __resetStorageModeForTests(): void {
  storageMode = 'browser'; storageModeReason = null; dbPromise = null;
  folderPrimary = false; memDataPromise = null; dataOnDiskBroken = false; hydratedFromFolder.clear();
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(FOLDER_PRIMARY_KEY); } catch { /* ignore */ }
}

function openMemoryDb(): Promise<IDBDatabase> {
  return import('fake-indexeddb').then(({ IDBFactory: MemoryFactory }) => new Promise<IDBDatabase>((resolve, reject) => {
    const req = new MemoryFactory().open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => createStores(req.result as unknown as IDBDatabase);
    req.onsuccess = () => resolve(req.result as unknown as IDBDatabase);
    req.onerror   = () => reject(req.error);
  }));
}

/**
 * Stop using on-disk browser storage for this session and run from memory.
 * Safe to call repeatedly. Returns the in-memory database.
 */
export function fallBackToMemory(reason: unknown): Promise<IDBDatabase> {
  if (storageMode === 'memory' && dbPromise) return dbPromise;
  const old = dbPromise;
  storageMode = 'memory';
  storageModeReason = describeStorageError(reason);
  console.warn('[storage] browser storage unavailable — running from memory', reason);
  const mem = openMemoryDb();
  dbPromise = mem;
  // Close the on-disk connection if there was one. (`old` may be the open
  // attempt that is itself resolving to the memory database — don't close that.)
  void Promise.all([old, mem]).then(([oldDb, memDb]) => {
    if (oldDb && oldDb !== memDb) { try { oldDb.close(); } catch { /* already closed */ } }
  }).catch(() => {});
  modeListeners.forEach(l => l());
  return mem;
}

function openDiskDb(): Promise<IDBDatabase> {
  if (!isStorageAvailable()) return Promise.reject(new Error('IndexedDB is not available in this browser'));
  if (dbPromise) return dbPromise;
  const thisOpen: Promise<IDBDatabase> = new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (err) { fallBackToMemory(err).then(resolve, reject); return; }
    req.onupgradeneeded = () => createStores(req.result);
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgraded the schema: release this connection so it can.
      db.onversionchange = () => { db.close(); if (dbPromise === thisOpen) dbPromise = null; };
      // The browser closed the connection itself (disk full, storage cleared,
      // profile error). Forget it so the next call opens a fresh one instead
      // of failing forever with "The database connection is closing".
      db.onclose = () => { if (dbPromise === thisOpen) dbPromise = null; };
      resolve(db);
    };
    // The on-disk database can't be opened at all ("Internal error opening
    // backing store", full disk, corrupt profile): run from memory instead.
    req.onerror   = (e) => { e.preventDefault?.(); fallBackToMemory(req.error).then(resolve, reject); };
    req.onblocked = () => reject(new Error('Database upgrade blocked — close other tabs of this app'));
  });
  dbPromise = thisOpen;
  return thisOpen;
}

/** The database project data goes through: memory when projects live in the folder, else disk. */
function openDb(): Promise<IDBDatabase> {
  if ((folderPrimary || dataOnDiskBroken) && storageMode !== 'memory') {
    if (!memDataPromise) memDataPromise = openMemoryDb();
    return memDataPromise;
  }
  return openDiskDb();
}

/**
 * Last resort when the browser's database for this site can't be opened even
 * though the disk has room again (a full disk can leave it damaged): delete it
 * and start a clean one. Everything stored ONLY in the browser is lost —
 * projects kept in a folder are untouched. Returns true if storage works again.
 */
export async function repairBrowserStorage(): Promise<boolean> {
  if (!isStorageAvailable()) return false;
  const old = dbPromise;
  dbPromise = null;
  await old?.then(db => { try { db.close(); } catch { /* ignore */ } }).catch(() => {});
  const deleted = await new Promise<boolean>(resolve => {
    try {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve(true);
      req.onerror   = () => resolve(false);
      req.onblocked = () => resolve(false);
    } catch { resolve(false); }
  });
  const works = deleted && await new Promise<boolean>(resolve => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => createStores(req.result);
      req.onsuccess = () => { req.result.close(); resolve(true); };
      req.onerror   = (e) => { e.preventDefault?.(); resolve(false); };
      req.onblocked = () => resolve(false);
    } catch { resolve(false); }
  });
  if (works) {
    storageMode = 'browser'; storageModeReason = null; dataOnDiskBroken = false;
    modeListeners.forEach(l => l());
  }
  return works;
}

/** Drop the cached connection (it will be reopened on the next call). */
export function resetDbConnection(): void {
  const old = dbPromise;
  dbPromise = null;
  void old?.then(db => { try { db.close(); } catch { /* already closed */ } }).catch(() => {});
}

/** The connection died under us (as opposed to the write itself being refused). */
export function isClosedConnectionError(err: unknown): boolean {
  const e = err as DOMException | undefined;
  return e?.name === 'InvalidStateError' || /connection is clos/i.test(String(e?.message ?? ''));
}

/** A short, human explanation of why a save failed. */
export function describeStorageError(err: unknown): string {
  const e = err as DOMException | undefined;
  const text = `${e?.name ?? ''} ${e?.message ?? ''}`;
  if (e?.name === 'QuotaExceededError' || /NO_SPACE|quota|disk.*full|backing store|IO error/i.test(text)) {
    return 'This computer’s disk is full, so the browser can’t save. Free up some space on the drive that holds your browser profile (usually C:), then click to retry. Until then, new changes are not saved.';
  }
  if (isClosedConnectionError(err)) {
    return 'The browser closed its storage (this usually follows a full disk or cleared site data). Click to retry.';
  }
  return 'The browser refused the save. Free up disk space or leave private browsing, then click to retry.';
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
    tx.onabort    = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── Serialization ────────────────────────────────────────────────────────────

export function toStoredState(state: ProjectState): StoredProjectState {
  return {
    ...state,
    drawings: state.drawings.map(({ file: _file, fileUrl: _url, ...rest }) => rest),
  };
}

export function emptyProjectState(name: string, number = ''): StoredProjectState {
  return {
    projectName:     name,
    projectNumber:   number,
    unit:            'm',
    drawings:        [],
    activeDrawingId: null,
    measurements:    [],
    materials:       defaultMaterialBank(),
    currency:        DEFAULT_CURRENCY,
    vatPercent:      currencyInfo(DEFAULT_CURRENCY)?.vat ?? 0,
    documentDate:    new Date().toISOString().slice(0, 10),
  };
}

// ── Whose projects ───────────────────────────────────────────────────────────
//
//  Projects live on this computer, but several people may sign in on it. Each
//  project is stamped with its owner's account id; listing and opening only
//  return the signed-in user's. Projects with no owner (made before accounts
//  existed, or in local mode) are adopted by whoever lists them first.
//  Owner `null` = local mode: no accounts, everything is visible.

let storageOwner: string | null = null;
export function setStorageOwner(id: string | null): void { storageOwner = id; }
export const getStorageOwner = (): string | null => storageOwner;

/** Demo-account ids (lib/auth/mockAuth.ts) are not real owners: such projects count as unclaimed. */
const realOwner = (id: string | undefined): string | undefined => (id && !id.startsWith('mock-') ? id : undefined);
/** True when the record belongs to another real account. */
export const isForeignProject = (r: { ownerId?: string }): boolean =>
  !!storageOwner && !!realOwner(r.ownerId) && r.ownerId !== storageOwner;
const isMine = (r: { ownerId?: string }) => !isForeignProject(r);
/** Stamp a record with the current owner unless it already has one. */
function owned<T extends { ownerId?: string }>(r: T): T {
  return storageOwner && !realOwner(r.ownerId) ? { ...r, ownerId: storageOwner } : r;
}

// ── Projects ─────────────────────────────────────────────────────────────────

export async function listProjects(): Promise<ProjectSummary[]> {
  const db  = await openDb();
  const tx  = db.transaction(PROJECTS, 'readonly');
  const all = await reqToPromise(tx.objectStore(PROJECTS).getAll() as IDBRequest<ProjectRecord[]>);
  const mine = all.filter(isMine);
  // Adopt projects that have no owner yet (they were made on this computer
  // before anyone signed in), so they stay with this account from now on.
  const unclaimed = storageOwner ? mine.filter(r => !realOwner(r.ownerId)) : [];
  if (unclaimed.length > 0) {
    const wtx = db.transaction(PROJECTS, 'readwrite');
    for (const r of unclaimed) { r.ownerId = storageOwner!; wtx.objectStore(PROJECTS).put(r); }
    await txDone(wtx).catch(() => {});
  }
  return mine
    .map(({ state: _s, ...summary }) => summary)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProject(id: string): Promise<ProjectRecord | null> {
  const db = await openDb();
  const tx = db.transaction(PROJECTS, 'readonly');
  const r  = await reqToPromise(tx.objectStore(PROJECTS).get(id) as IDBRequest<ProjectRecord | undefined>);
  return r && isMine(r) ? r : null;
}

export async function createProject(name: string, number = ''): Promise<ProjectRecord> {
  const now = Date.now();
  const clean = name.trim() || 'Untitled project';
  const record: ProjectRecord = {
    id:               newId(),
    name:             clean,
    number:           number.trim(),
    createdAt:        now,
    updatedAt:        now,
    measurementCount: 0,
    drawingCount:     0,
    schemaVersion:    SCHEMA_VERSION,
    state:            emptyProjectState(clean, number.trim()),
  };
  const db = await openDb();
  const tx = db.transaction(PROJECTS, 'readwrite');
  tx.objectStore(PROJECTS).put(owned(record));
  await txDone(tx);
  return record;
}

/** Save, reopening the database once if its connection had been closed. */
export async function saveProjectState(id: string, state: ProjectState): Promise<number> {
  try {
    return await writeProjectState(id, state);
  } catch (err) {
    if (storageMode === 'memory') throw err;
    if (isClosedConnectionError(err)) {
      resetDbConnection();
      try { return await writeProjectState(id, state); }
      catch (again) { err = again; }
    }
    // The disk copy can't be written (full disk / dead connection). Keep the
    // session alive in memory; the projects folder, if connected, still gets
    // every save (see pushProjectToFolder).
    if (!isDiskFailure(err)) throw err;
    // Only project DATA moves to memory. The settings store (which remembers
    // the projects folder) stays on disk as long as it can be opened at all.
    dataOnDiskBroken = true;
    storageModeReason = describeStorageError(err);
    console.warn('[storage] could not write project data to the browser — keeping it in memory', err);
    modeListeners.forEach(l => l());
    return writeProjectState(id, state);
  }
}

/** Failures of the on-disk store itself, as opposed to bad data. */
function isDiskFailure(err: unknown): boolean {
  const e = err as DOMException | undefined;
  const text = `${e?.name ?? ''} ${e?.message ?? ''}`;
  return isClosedConnectionError(err) || e?.name === 'QuotaExceededError' || e?.name === 'UnknownError'
    || /NO_SPACE|quota|backing store|disk.*full|IO error/i.test(text);
}

async function writeProjectState(id: string, state: ProjectState): Promise<number> {
  const db       = await openDb();
  const tx       = db.transaction(PROJECTS, 'readwrite');
  const store    = tx.objectStore(PROJECTS);
  const existing = await reqToPromise(store.get(id) as IDBRequest<ProjectRecord | undefined>);
  const now      = Date.now();
  const stored   = toStoredState(state);
  const record: ProjectRecord = {
    id,
    name:             state.projectName || existing?.name || 'Untitled project',
    number:           state.projectNumber ?? existing?.number ?? '',
    createdAt:        existing?.createdAt ?? now,
    updatedAt:        now,
    measurementCount: state.measurements.filter(m => !m.isGroupHeader).length,
    drawingCount:     state.drawings.length,
    schemaVersion:    SCHEMA_VERSION,
    ...(existing?.ownerId ? { ownerId: existing.ownerId } : {}),
    state:            stored,
  };
  store.put(owned(record));
  await txDone(tx);
  return now;
}

export async function renameProject(id: string, name: string): Promise<void> {
  const rec = await getProject(id);
  if (!rec) return;
  const clean = name.trim() || rec.name;
  const db = await openDb();
  const tx = db.transaction(PROJECTS, 'readwrite');
  tx.objectStore(PROJECTS).put({
    ...rec,
    name: clean,
    updatedAt: Date.now(),
    state: { ...rec.state, projectName: clean },
  });
  await txDone(tx);
}

export async function deleteProject(id: string): Promise<void> {
  hydratedFromFolder.delete(id);
  await deleteRegionsWhere('projectId', id).catch(() => {});
  const db = await openDb();
  const tx = db.transaction([PROJECTS, FILES], 'readwrite');
  tx.objectStore(PROJECTS).delete(id);
  const idx  = tx.objectStore(FILES).index('projectId');
  const keys = await reqToPromise(idx.getAllKeys(id));
  for (const k of keys) tx.objectStore(FILES).delete(k);
  await txDone(tx);
}

export async function duplicateProject(id: string): Promise<ProjectRecord | null> {
  const rec = await getProject(id);
  if (!rec) return null;
  const files = await loadDrawingFiles(id);
  const copy  = await createProject(`${rec.name} (copy)`, rec.number);
  const state = { ...rec.state, projectName: copy.name };
  const db = await openDb();
  const tx = db.transaction([PROJECTS, FILES], 'readwrite');
  tx.objectStore(PROJECTS).put(owned({ ...copy, state, measurementCount: rec.measurementCount, drawingCount: rec.drawingCount }));
  for (const [drawingId, file] of files) {
    tx.objectStore(FILES).put({
      key: `${copy.id}:${drawingId}`, projectId: copy.id, drawingId,
      name: file.name, type: file.type, blob: file,
    } satisfies FileRecord);
  }
  await txDone(tx);
  return copy;
}

// ── Drawing files ────────────────────────────────────────────────────────────

export async function saveDrawingFile(projectId: string, drawingId: string, file: File): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(FILES, 'readwrite');
  tx.objectStore(FILES).put({
    key: `${projectId}:${drawingId}`, projectId, drawingId,
    name: file.name, type: file.type || 'application/pdf', blob: file,
  } satisfies FileRecord);
  await txDone(tx);
}

export async function deleteDrawingFile(projectId: string, drawingId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(FILES, 'readwrite');
  tx.objectStore(FILES).delete(`${projectId}:${drawingId}`);
  await txDone(tx);
}

/** Map of drawingId → File for every drawing stored with the project. */
export async function loadDrawingFiles(projectId: string): Promise<Map<string, File>> {
  const db   = await openDb();
  const tx   = db.transaction(FILES, 'readonly');
  const recs = await reqToPromise(
    tx.objectStore(FILES).index('projectId').getAll(projectId) as IDBRequest<FileRecord[]>,
  );
  const out = new Map<string, File>();
  for (const r of recs) {
    out.set(r.drawingId, new File([r.blob], r.name, { type: r.type || 'application/pdf' }));
  }
  // Projects kept in the folder: fetch this project's PDFs from it once per session.
  if (getStorageMode() !== 'browser' && folderFileLoader && !hydratedFromFolder.has(projectId)) {
    const fromFolder = await folderFileLoader(projectId).catch(() => null);
    if (fromFolder) {
      hydratedFromFolder.add(projectId);
      const missing = [...fromFolder].filter(([drawingId]) => !out.has(drawingId));
      if (missing.length > 0) {
        const wtx = (await openDb()).transaction(FILES, 'readwrite');
        for (const [drawingId, file] of missing) {
          out.set(drawingId, file);
          wtx.objectStore(FILES).put({
            key: `${projectId}:${drawingId}`, projectId, drawingId,
            name: file.name, type: file.type || 'application/pdf', blob: file,
          } satisfies FileRecord);
        }
        await txDone(wtx).catch(() => {});
      }
    }
  }
  return out;
}

// ── Backup (export / import a whole project as one .foldrule file) ──────────

interface BackupFile {
  format:        'quantity-savior-project';
  schemaVersion: number;
  exportedAt:    string;
  project:       Omit<ProjectRecord, 'id'>;
  files:         { drawingId: string; name: string; type: string; dataBase64: string }[];
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf   = new Uint8Array(await blob.arrayBuffer());
  let binary  = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBlob(b64: string, type: string): Blob {
  const binary = atob(b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

export async function exportProjectBackup(id: string): Promise<{ blob: Blob; filename: string }> {
  const rec = await getProject(id);
  if (!rec) throw new Error('Project not found');
  const files = await loadDrawingFiles(id);
  const payload: BackupFile = {
    format:        'quantity-savior-project',
    schemaVersion: SCHEMA_VERSION,
    exportedAt:    new Date().toISOString(),
    project:       (({ id: _id, ...rest }) => rest)(rec),
    files: await Promise.all(
      [...files].map(async ([drawingId, f]) => ({
        drawingId, name: f.name, type: f.type, dataBase64: await blobToBase64(f),
      })),
    ),
  };
  const safe = rec.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
  return {
    blob:     new Blob([JSON.stringify(payload)], { type: 'application/json' }),
    filename: `${safe}.foldrule`,
  };
}

export async function importProjectBackup(file: File): Promise<ProjectRecord> {
  let payload: BackupFile;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    throw new Error('This file is not a valid project backup');
  }
  if (payload?.format !== 'quantity-savior-project' || !payload.project?.state) {
    throw new Error('This file is not a Foldrule project backup');
  }
  if (payload.schemaVersion > SCHEMA_VERSION) {
    throw new Error('This backup was made by a newer version of the app');
  }
  const id  = newId();
  const now = Date.now();
  const record: ProjectRecord = { ...payload.project, id, updatedAt: now, ownerId: storageOwner ?? undefined };
  const db = await openDb();
  const tx = db.transaction([PROJECTS, FILES], 'readwrite');
  tx.objectStore(PROJECTS).put(owned(record));
  for (const f of payload.files ?? []) {
    tx.objectStore(FILES).put({
      key: `${id}:${f.drawingId}`, projectId: id, drawingId: f.drawingId,
      name: f.name, type: f.type, blob: base64ToBlob(f.dataBase64, f.type),
    } satisfies FileRecord);
  }
  await txDone(tx);
  return record;
}

/** Best-effort request that the browser not evict our data under storage pressure. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* ignore */ }
  return false;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke later — revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// ── Settings (small key/value store: folder handle, tombstones, prefs) ──────

export async function getSetting<T>(key: string): Promise<T | undefined> {
  const db = await openDiskDb();
  const tx = db.transaction(SETTINGS, 'readonly');
  return reqToPromise(tx.objectStore(SETTINGS).get(key) as IDBRequest<T | undefined>);
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const db = await openDiskDb();
  const tx = db.transaction(SETTINGS, 'readwrite');
  tx.objectStore(SETTINGS).put(value, key);
  await txDone(tx);
}

export async function deleteSetting(key: string): Promise<void> {
  const db = await openDiskDb();
  const tx = db.transaction(SETTINGS, 'readwrite');
  tx.objectStore(SETTINGS).delete(key);
  await txDone(tx);
}

/**
 * Write a complete project record (keeping its id and updatedAt) plus any
 * drawing files — used when pulling a newer copy in from a synced folder.
 */
export async function putProjectRecord(record: ProjectRecord, files: Map<string, File>): Promise<void> {
  // A newer copy arrived from the folder without its PDFs: fetch them afresh when needed.
  if (files.size === 0) hydratedFromFolder.delete(record.id);
  const db = await openDb();
  const tx = db.transaction([PROJECTS, FILES], 'readwrite');
  tx.objectStore(PROJECTS).put(owned(record));
  for (const [drawingId, file] of files) {
    tx.objectStore(FILES).put({
      key: `${record.id}:${drawingId}`, projectId: record.id, drawingId,
      name: file.name, type: file.type || 'application/pdf', blob: file,
    } satisfies FileRecord);
  }
  await txDone(tx);
}

/** New project containing the given PDFs as drawings (used by "Open with Foldrule"). */
export async function createProjectFromPdfs(pdfs: File[]): Promise<ProjectRecord> {
  const first = pdfs[0];
  const name  = first.name.replace(/\.pdf$/i, '') || 'New project';
  const rec   = await createProject(name);
  const files = new Map<string, File>();
  const drawings: StoredDrawing[] = pdfs.map(f => {
    const id = newId();
    files.set(id, f);
    return { id, name: f.name, scaleFactor: 1, pageScales: {}, pageCount: 1 };
  });
  const full: ProjectRecord = {
    ...rec,
    drawingCount: drawings.length,
    updatedAt: Date.now(),
    state: { ...rec.state, drawings, activeDrawingId: drawings[0].id },
  };
  await putProjectRecord(full, files);
  return full;
}

// ── Magic Fill rooms (pre-computed regions per drawing page) ──────────────────

export interface StoredRegion {
  /** Bounding box in mask pixels. */
  x0: number; y0: number; x1: number; y1: number;
  /** Filled pixel count (islands included) — what a click would fill. */
  areaPx:  number;
  perimPx: number;
  /** Smoothed outline, mask pixels. */
  polygon: [number, number][];
}

export interface PageRegionsRecord {
  key:       string;          // `${drawingId}:${page}`
  projectId: string;
  drawingId: string;
  page:      number;
  version:   number;          // bump when the room-finding algorithm changes
  maskW:     number;
  maskH:     number;
  regions:   StoredRegion[];
  createdAt: number;
}

export async function getPageRegions(key: string): Promise<PageRegionsRecord | null> {
  const db = await openDb();
  const tx = db.transaction(REGIONS, 'readonly');
  return (await reqToPromise(tx.objectStore(REGIONS).get(key) as IDBRequest<PageRegionsRecord | undefined>)) ?? null;
}

export async function putPageRegions(rec: PageRegionsRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(REGIONS, 'readwrite');
  tx.objectStore(REGIONS).put(rec);
  await txDone(tx);
}

async function deleteRegionsWhere(index: 'projectId' | 'drawingId', value: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(REGIONS, 'readwrite');
  const keys = await reqToPromise(tx.objectStore(REGIONS).index(index).getAllKeys(value));
  for (const k of keys) tx.objectStore(REGIONS).delete(k);
  await txDone(tx);
}

/** Remove saved rooms for a drawing (it was removed from the project). */
export const deleteDrawingRegions = (drawingId: string) => deleteRegionsWhere('drawingId', drawingId);

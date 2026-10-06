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

function openDb(): Promise<IDBDatabase> {
  if (!isStorageAvailable()) return Promise.reject(new Error('IndexedDB is not available in this browser'));
  if (dbPromise) return dbPromise;
  const thisOpen: Promise<IDBDatabase> = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
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
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgraded the schema: release this connection so it can.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      // The browser closed the connection itself (disk full, storage cleared,
      // profile error). Forget it so the next call opens a fresh one instead
      // of failing forever with "The database connection is closing".
      db.onclose = () => { if (dbPromise === thisOpen) dbPromise = null; };
      resolve(db);
    };
    req.onerror   = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => reject(new Error('Database upgrade blocked — close other tabs of this app'));
  });
  dbPromise = thisOpen;
  return thisOpen;
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
  if (e?.name === 'QuotaExceededError' || /NO_SPACE|quota|disk.*full/i.test(text)) {
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
    currency:        'LKR',
    vatPercent:      0,
    documentDate:    new Date().toISOString().slice(0, 10),
  };
}

// ── Projects ─────────────────────────────────────────────────────────────────

export async function listProjects(): Promise<ProjectSummary[]> {
  const db  = await openDb();
  const tx  = db.transaction(PROJECTS, 'readonly');
  const all = await reqToPromise(tx.objectStore(PROJECTS).getAll() as IDBRequest<ProjectRecord[]>);
  return all
    .map(({ state: _s, ...summary }) => summary)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProject(id: string): Promise<ProjectRecord | null> {
  const db = await openDb();
  const tx = db.transaction(PROJECTS, 'readonly');
  const r  = await reqToPromise(tx.objectStore(PROJECTS).get(id) as IDBRequest<ProjectRecord | undefined>);
  return r ?? null;
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
  tx.objectStore(PROJECTS).put(record);
  await txDone(tx);
  return record;
}

/** Save, reopening the database once if its connection had been closed. */
export async function saveProjectState(id: string, state: ProjectState): Promise<number> {
  try {
    return await writeProjectState(id, state);
  } catch (err) {
    if (!isClosedConnectionError(err)) throw err;
    resetDbConnection();
    return writeProjectState(id, state);
  }
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
    state:            stored,
  };
  store.put(record);
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
  await deleteRegionsWhere('projectId', id).catch(() => {});
  const db = await openDb();
  const tx = db.transaction([PROJECTS, FILES], 'readwrite');
  tx.objectStore(PROJECTS).delete(id);
  const idx  = tx.objectStore(FILES).index('projectId');
  const keys = await reqToPromise(idx.getAllKeys(IDBKeyRange.only(id)));
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
  tx.objectStore(PROJECTS).put({ ...copy, state, measurementCount: rec.measurementCount, drawingCount: rec.drawingCount });
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
    tx.objectStore(FILES).index('projectId').getAll(IDBKeyRange.only(projectId)) as IDBRequest<FileRecord[]>,
  );
  const out = new Map<string, File>();
  for (const r of recs) {
    out.set(r.drawingId, new File([r.blob], r.name, { type: r.type || 'application/pdf' }));
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
  const record: ProjectRecord = { ...payload.project, id, updatedAt: now };
  const db = await openDb();
  const tx = db.transaction([PROJECTS, FILES], 'readwrite');
  tx.objectStore(PROJECTS).put(record);
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
  const db = await openDb();
  const tx = db.transaction(SETTINGS, 'readonly');
  return reqToPromise(tx.objectStore(SETTINGS).get(key) as IDBRequest<T | undefined>);
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(SETTINGS, 'readwrite');
  tx.objectStore(SETTINGS).put(value, key);
  await txDone(tx);
}

export async function deleteSetting(key: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(SETTINGS, 'readwrite');
  tx.objectStore(SETTINGS).delete(key);
  await txDone(tx);
}

/**
 * Write a complete project record (keeping its id and updatedAt) plus any
 * drawing files — used when pulling a newer copy in from a synced folder.
 */
export async function putProjectRecord(record: ProjectRecord, files: Map<string, File>): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([PROJECTS, FILES], 'readwrite');
  tx.objectStore(PROJECTS).put(record);
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
  const keys = await reqToPromise(tx.objectStore(REGIONS).index(index).getAllKeys(IDBKeyRange.only(value)));
  for (const k of keys) tx.objectStore(REGIONS).delete(k);
  await txDone(tx);
}

/** Remove saved rooms for a drawing (it was removed from the project). */
export const deleteDrawingRegions = (drawingId: string) => deleteRegionsWhere('drawingId', drawingId);

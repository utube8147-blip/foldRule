'use client';

// ─── TakeoffContext.tsx ───────────────────────────────────────────────────────
//
//  UNIFIED STATE: This context is the single source of truth for:
//    - measurements[]     committed takeoff rows
//    - tempPoints[]       in-progress drawing points (lifted from Viewer)
//    - undo/redo stack    before/after snapshots of both arrays
//
//  EXTENDED: ProjectState now includes full BOQ metadata:
//    - Project identity   (location, phase, kitchen type, total units)
//    - Document metadata  (title, date, revision, currency, VAT)
//    - Stakeholders       (main contractor, design consultant, supervision)
//    - Drawing references (list of referenced drawing numbers)
//    - Scope notes        (general assumptions, excluded items)
//
//  ADDED: displayUnit / setDisplayUnit — unit conversion toggle (m/cm/mm/ft/in)
//         Stored here so any consumer (sidebar, canvas labels, BOQ export)
//         reads the same value without prop-drilling.
//
//  ADDED: retagTempPoints — atomic in-place retag of all temp points.
//         Used by Viewer.tsx when upgrading linear↔arc → polyarc so points
//         are never cleared and re-pushed (which caused RAF race conditions
//         and visible canvas blanking).
//
//  CHANGE: InProgressPoint gains an optional `segmentType` field used by the
//          new 'polyarc' tool to tag each point as belonging to a straight-line
//          segment or a 3-point arc segment. All existing tools leave it
//          undefined, so there is zero impact on anything that already works.
//
//  All new fields are optional — zero impact on existing consumers.
//
// ─────────────────────────────────────────────────────────────────────────────

import React, {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { TakeoffRow, Drawing, Material } from '@/types';
import { effectivePageScale, rescaleMeasurementsForPage } from '@/lib/takeoff/scale';
import { defaultMaterialBank } from '@/data/materials';
import {
  getProject, loadDrawingFiles, saveDrawingFile, deleteDrawingFile,
  saveProjectState, requestPersistentStorage, newId, deleteDrawingRegions, describeStorageError, getStorageMode,
} from '@/lib/storage/projectDb';
import { initFolderSync, pushProjectToFolder, syncFolder, getFolderStatus, PROJECTS_PULLED_EVENT } from '@/lib/storage/folderSync';
import type { DisplayUnit } from '@/hooks/measurements/useMeasurements/unitConversion';

// ─── Stakeholders ─────────────────────────────────────────────────────────────
export type Stakeholders = {
  mainContractor?:   string;
  designConsultant?: string;
  supervision?:      string;
  client?:           string;
  projectManager?:   string;
};

// ─── Scope assumption entry ───────────────────────────────────────────────────
export type ScopeAssumption = {
  id:       number;
  category: string;
  content:  string;
};

// ─── Excluded scope item ──────────────────────────────────────────────────────
export type ExcludedItem = {
  id:     number;
  item:   string;
  reason: string;
};

// ─── Project State ────────────────────────────────────────────────────────────
export type ProjectState = {
  projectName:     string;
  projectNumber:   string;
  unit:            string;
  drawings:        Drawing[];
  activeDrawingId: string | null;
  measurements:    TakeoffRow[];
  materials:       unknown[];

  projectLocation?:  string;
  projectPhase?:     string;
  kitchenType?:      string;
  totalUnits?:       number;

  documentTitle?:    string;
  documentDate?:     string;
  revision?:         string;
  currency?:         string;
  vatPercent?:       number;

  stakeholders?:     Stakeholders;
  drawingReferences?: string[];
  generalAssumptions?:   ScopeAssumption[];
  excludedItems?:        ExcludedItem[];
};

// ─── InProgressPoint ──────────────────────────────────────────────────────────
// segmentType — optional field used by the 'polyarc' tool only.
//   'line' = this point belongs to a straight polyline segment (default).
//   'arc'  = this point is one of a 3-point arc triplet; the drawing canvas
//            and commit hook use this to decide how to render / measure.
// All other tools leave this undefined (treated as 'line').
export type InProgressPoint = {
  x:            number;
  y:            number;
  snapped:      boolean;
  segmentId?:   string;
  segmentType?: 'line' | 'arc';
};

export type PendingMeasurement = {
  id: string;
  type: 'Length' | 'Area' | 'Polygon' | 'Rectangle' | 'Count' | 'Point';
  color: string;
  description: string;
};

type UndoEntry = {
  measurementsBefore: TakeoffRow[];
  tempPointsBefore:   InProgressPoint[];
  measurementsAfter:  TakeoffRow[];
  tempPointsAfter:    InProgressPoint[];
  undoneMeasurement?: TakeoffRow;
  /** Only set for entries that also change drawings (e.g. scale calibration). */
  drawingsBefore?:    Drawing[];
  drawingsAfter?:     Drawing[];
};

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'not-found' | 'error';
export type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'error';

const MAX_HISTORY = 100;

// ── Context shape ─────────────────────────────────────────────────────────────
interface TakeoffContextValue {
  projectState:        ProjectState;
  setProjectState:     React.Dispatch<React.SetStateAction<ProjectState>>;

  activeTool:          string;
  setActiveTool:       (t: string) => void;
  selectedId:          string | null;
  setSelectedId:       (id: string | null) => void;

  addDrawing:          (name: string, fileUrl: string, file?: File) => void;
  removeDrawing:       (id: string) => void;
  /** Record how many pages a drawing's PDF has (set when it loads). */
  setDrawingPageCount: (id: string, pageCount: number) => void;

  // ── Navigation / linking ─────────────────────────────────────────────────
  /** A page the viewer should switch to (consumed by the Viewer). */
  pendingPage:         number | null;
  clearPendingPage:    () => void;
  /** Open a drawing at a page. */
  goToPage:            (drawingId: string, page: number) => void;
  /** Select a measurement and bring it into view (switches drawing/page if needed). */
  focusMeasurement:    (id: string) => void;
  /** Increments on every focusMeasurement call so the viewer can re-centre. */
  focusSeq:            number;

  // ── Material bank ─────────────────────────────────────────────────────────
  materialLibraryOpen:    boolean;
  setMaterialLibraryOpen: (open: boolean) => void;
  /**
   * Material to attach to the next measurement(s) committed (set by the naming
   * dialog just before it finishes a shape). Pass null to clear.
   */
  setNextMaterial:        (materialId: string | null) => void;

  // ── Display preferences ───────────────────────────────────────────────────
  showLabels:          boolean;
  setShowLabels:       (v: boolean) => void;
  /** Overlay the lines/arcs extracted from the PDF (what snapping uses). */
  showGeometry:        boolean;
  setShowGeometry:     (v: boolean) => void;
  setActiveDrawingId:  (id: string) => void;
  /** Calibrate one page of a drawing. Rescales that page's existing measurements. */
  updateDrawingScale:  (id: string, factor: number, page?: number) => void;

  /** Page currently shown in the viewer (1-based). */
  activePage:          number;
  setActivePage:       (page: number) => void;

  // ── Persistence ───────────────────────────────────────────────────────────
  projectId:   string | null;
  loadStatus:  LoadStatus;
  loadError:   string | null;
  /** Save status lives in a separate context — see useSaveStatus(). */
  saveNow:     () => Promise<void>;

  addMeasurement:      (m: TakeoffRow) => void;
  updateMeasurement:   (id: string, updates: Partial<TakeoffRow>) => void;
  deleteMeasurement:   (id: string) => void;
  clearAll:            () => void;
  toggleVisibility:    (id?: string) => void;

  createGroup:         (groupName: string, measurementIds: string[], groupType?: string) => string;
  deleteGroup:         (groupId: string, deleteChildren?: boolean) => void;
  ungroupMeasurements: (groupId: string) => void;
  toggleGroupExpanded: (groupId: string) => void;

  tempPoints:          InProgressPoint[];
  pendingMeasurement:  PendingMeasurement | null;
  setPendingMeasurement: (m: PendingMeasurement | null) => void;

  pushPoint:               (point: InProgressPoint) => void;
  commitMeasurement:       (m: TakeoffRow) => void;
  batchCommitMeasurements: (measurements: TakeoffRow[]) => void;
  clearTempPoints:         () => void;
  // ── NEW: atomic retag without clear/repush cycle ──────────────────────────
  retagTempPoints:         (updater: (pts: InProgressPoint[]) => InProgressPoint[]) => void;

  undo:    () => void;
  redo:    () => void;
  canUndo: boolean;
  canRedo: boolean;

  updateProjectMeta: (updates: Partial<Omit<ProjectState,
    'drawings' | 'activeDrawingId' | 'measurements' | 'materials'
  >>) => void;

  getEffectiveQuantity: (measurement: TakeoffRow) => number;
  getEffectiveUnit:     (measurement: TakeoffRow) => string;

  // ── Unit conversion ───────────────────────────────────────────────────────
  displayUnit:    DisplayUnit;
  setDisplayUnit: (unit: DisplayUnit) => void;
}

// ─── Default project state ────────────────────────────────────────────────────
const defaultProject = (): ProjectState => ({
  projectName:     'New Project',
  projectNumber:   '',
  unit:            'm',
  drawings:        [],
  activeDrawingId: null,
  measurements:    [],
  materials:       defaultMaterialBank(),
  projectLocation:  undefined,
  projectPhase:     undefined,
  kitchenType:      undefined,
  totalUnits:       undefined,
  documentTitle:    undefined,
  documentDate:     undefined,
  revision:         undefined,
  currency:         undefined,
  vatPercent:       undefined,
  stakeholders: {
    mainContractor:   undefined,
    designConsultant: undefined,
    supervision:      undefined,
    client:           undefined,
    projectManager:   undefined,
  },
  drawingReferences:  undefined,
  generalAssumptions: undefined,
  excludedItems:      undefined,
});

// ─── Context ──────────────────────────────────────────────────────────────────
/** Everything except the fast-changing drawing-interaction values. */
export type TakeoffDataValue = Omit<TakeoffContextValue, 'tempPoints' | 'pendingMeasurement'>;
interface InteractionValue { tempPoints: InProgressPoint[]; pendingMeasurement: PendingMeasurement | null; }

const TakeoffContext     = createContext<TakeoffDataValue | null>(null);
// In-progress points change on every click while drawing; only the Viewer
// needs them, so they are published separately.
const InteractionContext = createContext<InteractionValue>({ tempPoints: [], pendingMeasurement: null });

// Save status changes several times per edit (unsaved → saving → saved). It has
// its own context so only the save indicator re-renders, not the workspace.
interface SaveStatusValue { saveStatus: SaveStatus; lastSavedAt: number | null; /** Why the last save failed (when saveStatus is 'error'). */ saveError?: string | null; }
const SaveStatusContext = createContext<SaveStatusValue>({ saveStatus: 'saved', lastSavedAt: null });
export function useSaveStatus(): SaveStatusValue { return useContext(SaveStatusContext); }

export function TakeoffProvider({
  children,
  projectId = null,
}: {
  children: React.ReactNode;
  /** Local project to load/autosave. null = in-memory only (e.g. lab pages). */
  projectId?: string | null;
}) {
  const [projectState, setProjectState] = useState<ProjectState>(defaultProject);
  const [activePage,   setActivePage]   = useState<number>(1);
  const [loadStatus,   setLoadStatus]   = useState<LoadStatus>(projectId ? 'loading' : 'idle');
  const [loadError,    setLoadError]    = useState<string | null>(null);
  const [saveStatus,   setSaveStatus]   = useState<SaveStatus>('saved');
  const [lastSavedAt,  setLastSavedAt]  = useState<number | null>(null);
  const [saveError,    setSaveError]    = useState<string | null>(null);
  const [activeTool,   setActiveTool]   = useState<string>('select');
  const [selectedId,   setSelectedId]   = useState<string | null>(null);
  const [pendingPage,  setPendingPage]  = useState<number | null>(null);
  const [focusSeq,     setFocusSeq]     = useState(0);
  const [showLabels,   setShowLabelsState] = useState(false);
  const [showGeometry, setShowGeometryState] = useState(false);
  useEffect(() => {
    try {
      setShowLabelsState(localStorage.getItem('foldrule:show-labels') === '1');
      setShowGeometryState(localStorage.getItem('foldrule:show-geometry') === '1');
    } catch { /* ignore */ }
  }, []);
  const setShowGeometry = useCallback((v: boolean) => {
    setShowGeometryState(v);
    try { localStorage.setItem('foldrule:show-geometry', v ? '1' : '0'); } catch { /* ignore */ }
  }, []);
  const setShowLabels = useCallback((v: boolean) => {
    setShowLabelsState(v);
    try { localStorage.setItem('foldrule:show-labels', v ? '1' : '0'); } catch { /* ignore */ }
  }, []);
  const clearPendingPage = useCallback(() => setPendingPage(null), []);
  const [materialLibraryOpen, setMaterialLibraryOpen] = useState(false);
  const nextMaterialRef = useRef<string | null>(null);
  const materialsRef    = useRef<Material[]>(projectState.materials as Material[]);
  useLayoutEffect(() => { materialsRef.current = projectState.materials as Material[]; }, [projectState.materials]);
  const setNextMaterial = useCallback((id: string | null) => { nextMaterialRef.current = id; }, []);

  const [tempPoints,          setTempPoints]          = useState<InProgressPoint[]>([]);
  const [pendingMeasurement,  setPendingMeasurement]  = useState<PendingMeasurement | null>(null);

  // ── Display unit state ────────────────────────────────────────────────────
  const [displayUnit, setDisplayUnit] = useState<DisplayUnit>('m');

  // Undo history lives in refs and is mutated only from event handlers — never
  // inside React state updaters (which React may run twice). `historyVersion`
  // just triggers re-render so canUndo/canRedo stay current.
  const undoPastRef   = useRef<UndoEntry[]>([]);
  const undoFutureRef = useRef<UndoEntry[]>([]);
  const [historyLen, setHistoryLen] = useState({ past: 0, future: 0 });
  const bumpHistory = useCallback(() => setHistoryLen({
    past:   undoPastRef.current.length,
    future: undoFutureRef.current.length,
  }), []);
  const drawingsRef = useRef<Drawing[]>([]);
  const activeDrawingIdRef = useRef<string | null>(null);
  const activePageRef = useRef(1);
  useLayoutEffect(() => { activePageRef.current = activePage; }, [activePage]);
  /**
   * Give new standalone rows distinguishable names: a second "Point" on the
   * same drawing becomes "Point 2", and so on. Group children are already numbered.
   */
  const uniqueName = useCallback((m: TakeoffRow): TakeoffRow => {
    if (m.isGroupHeader || m.parentId || !m.description) return m;
    const base = m.description.replace(/\s+\d+$/, '');
    const taken = new Set(
      measurementsRef.current
        .filter(x => x.drawingId === m.drawingId && !x.parentId)
        .map(x => x.description),
    );
    if (!taken.has(m.description)) return m;
    let n = 2;
    while (taken.has(`${base} ${n}`)) n++;
    const name = `${base} ${n}`;
    return { ...m, description: name, label: m.label === m.description ? name : m.label };
  }, []);

  /** Attach the material chosen in the naming dialog (rate from the bank). */
  const applyNextMaterial = useCallback((m: TakeoffRow): TakeoffRow => {
    const id = nextMaterialRef.current;
    if (!id || m.isGroupHeader || m.materialId) return m;
    const mat = materialsRef.current.find(x => x.id === id);
    if (!mat) return m;
    const rate = (mat.materialCost ?? 0) + (mat.laborCost ?? 0) + (mat.equipmentCost ?? 0) || mat.unitRate || 0;
    return { ...m, materialId: mat.id, unitRate: m.unitRate > 0 ? m.unitRate : rate };
  }, []);

  /** Every measurement is tied to the page it was drawn on. */
  const stampPage = useCallback((m: TakeoffRow): TakeoffRow =>
    (m.pageNumber != null ? m : { ...m, pageNumber: activePageRef.current }), []);

  const measurementsRef = useRef<TakeoffRow[]>([]);
  const tempPointsRef   = useRef<InProgressPoint[]>([]);

  const syncedSetProjectState: typeof setProjectState = useCallback((updater) => {
    setProjectState(prev => {
      const next = typeof updater === 'function' ? (updater as (p: ProjectState) => ProjectState)(prev) : updater;
      measurementsRef.current = next.measurements;
      drawingsRef.current     = next.drawings;
      activeDrawingIdRef.current = next.activeDrawingId;
      return next;
    });
  }, []);

  const syncedSetTempPoints: typeof setTempPoints = useCallback((updater) => {
    setTempPoints(prev => {
      const next = typeof updater === 'function' ? (updater as (p: InProgressPoint[]) => InProgressPoint[])(prev) : updater;
      tempPointsRef.current = next;
      return next;
    });
  }, []);

  const pushEntry = useCallback((entry: UndoEntry) => {
    undoPastRef.current   = [...undoPastRef.current.slice(-(MAX_HISTORY - 1)), entry];
    undoFutureRef.current = [];
    bumpHistory();
  }, [bumpHistory]);

  const resetHistory = useCallback(() => {
    undoPastRef.current   = [];
    undoFutureRef.current = [];
    bumpHistory();
  }, [bumpHistory]);

  const applySnapshot = useCallback((
    measurements: TakeoffRow[],
    tempPts:      InProgressPoint[],
    drawings?:    Drawing[],
  ) => {
    measurementsRef.current = measurements;
    if (drawings) drawingsRef.current = drawings;
    syncedSetProjectState(prev => (
      drawings ? { ...prev, measurements, drawings } : { ...prev, measurements }
    ));
    tempPointsRef.current = tempPts;
    syncedSetTempPoints(() => tempPts);
  }, [syncedSetProjectState, syncedSetTempPoints]);

  const recalculateParentTotal = useCallback((parentId: string, measurements: TakeoffRow[]): TakeoffRow[] => {
    const parentIndex = measurements.findIndex(m => m.id === parentId);
    if (parentIndex === -1) return measurements;

    const parent = measurements[parentIndex];
    if (!parent.isGroupHeader || !parent.childIds) return measurements;

    const childIds = parent.childIds as string[];
    const existingChildren = measurements.filter(m => childIds.includes(m.id));

    if (existingChildren.length === 0) {
      return measurements.filter(m => m.id !== parentId);
    }

    let newTotal = 0;
    let newUnit = parent.unit;

    for (const child of existingChildren) {
      if (child.type === 'Length' || child.type === 'Area' || child.type === 'Count') {
        newTotal += child.quantity;
        newUnit = child.unit;
      }
    }

    const updatedMeasurements = [...measurements];
    updatedMeasurements[parentIndex] = { ...parent, quantity: newTotal, unit: newUnit };
    return updatedMeasurements;
  }, []);

  const getEffectiveQuantity = useCallback((measurement: TakeoffRow): number => {
    if (measurement.isGroupHeader && measurement.childIds && measurement.childIds.length > 0) {
      const childIds = measurement.childIds as string[];
      const children = measurementsRef.current.filter(m => childIds.includes(m.id));
      return children.reduce((sum, child) => sum + (child.quantity || 0), 0);
    }
    return measurement.quantity || 0;
  }, []);

  const getEffectiveUnit = useCallback((measurement: TakeoffRow): string => {
    if (measurement.isGroupHeader && measurement.childIds && measurement.childIds.length > 0) {
      const childIds = measurement.childIds as string[];
      const children = measurementsRef.current.filter(m => childIds.includes(m.id));
      if (children.length > 0) return children[0].unit || measurement.unit;
    }
    return measurement.unit || '';
  }, []);

  const updateProjectMeta = useCallback((
    updates: Partial<Omit<ProjectState, 'drawings' | 'activeDrawingId' | 'measurements' | 'materials'>>
  ) => {
    syncedSetProjectState(prev => ({ ...prev, ...updates }));
  }, [syncedSetProjectState]);

  // ── Undo / Redo ────────────────────────────────────────────────────────────
  const recalcAllParents = useCallback((list: TakeoffRow[]): TakeoffRow[] => {
    const parentIds = new Set<string>();
    for (const m of list) if (m.parentId) parentIds.add(m.parentId);
    let out = list;
    for (const pid of parentIds) out = recalculateParentTotal(pid, out);
    return out;
  }, [recalculateParentTotal]);

  const undo = useCallback(() => {
    const past = undoPastRef.current;
    if (past.length === 0) return;
    const entry = past[past.length - 1];
    undoPastRef.current   = past.slice(0, -1);
    undoFutureRef.current = [entry, ...undoFutureRef.current];

    applySnapshot(
      recalcAllParents([...entry.measurementsBefore]),
      [...entry.tempPointsBefore],
      entry.drawingsBefore,
    );

    if (entry.undoneMeasurement && entry.tempPointsBefore.length > 0) {
      setPendingMeasurement({
        id:          entry.undoneMeasurement.id,
        type:        entry.undoneMeasurement.type,
        color:       entry.undoneMeasurement.color,
        description: entry.undoneMeasurement.description,
      });
    } else {
      setPendingMeasurement(null);
    }
    bumpHistory();
  }, [applySnapshot, recalcAllParents, bumpHistory]);

  const redo = useCallback(() => {
    const future = undoFutureRef.current;
    if (future.length === 0) return;
    const entry = future[0];
    undoFutureRef.current = future.slice(1);
    undoPastRef.current   = [...undoPastRef.current, entry];

    applySnapshot(
      recalcAllParents([...entry.measurementsAfter]),
      [...entry.tempPointsAfter],
      entry.drawingsAfter,
    );
    setPendingMeasurement(null);
    bumpHistory();
  }, [applySnapshot, recalcAllParents, bumpHistory]);

  // ── pushPoint ──────────────────────────────────────────────────────────────
  const pushPoint = useCallback((point: InProgressPoint) => {
    const mBefore = measurementsRef.current;
    const tBefore = tempPointsRef.current;
    const tAfter  = [...tBefore, point];

    // Update the ref NOW, not inside the state updater: React may run the
    // updater later, so several pushPoint calls in one handler (e.g. an arc's
    // start, middle, end and break marker) would each read the same stale list
    // and overwrite each other — only the last point survived.
    tempPointsRef.current = tAfter;
    syncedSetTempPoints(() => tAfter);

    pushEntry({
      measurementsBefore: mBefore,
      tempPointsBefore:   tBefore,
      measurementsAfter:  mBefore,
      tempPointsAfter:    tAfter,
    });
  }, [pushEntry, syncedSetTempPoints]);

  // ── retagTempPoints ────────────────────────────────────────────────────────
  // Atomically retags all in-progress points without clearing and re-pushing.
  // Used by Viewer.tsx during the linear↔arc → polyarc upgrade so that points
  // are never absent from the canvas (eliminates the RAF race condition).
  // Does NOT push an undo entry — the retag is a tool-switch side-effect, not
  // a user action that should be undoable on its own.
  const retagTempPoints = useCallback((updater: (pts: InProgressPoint[]) => InProgressPoint[]) => {
    const next = updater(tempPointsRef.current);
    tempPointsRef.current = next;          // immediately, for calls later in the same handler
    syncedSetTempPoints(() => next);
  }, [syncedSetTempPoints]);

  // ── commitMeasurement ──────────────────────────────────────────────────────
  const commitMeasurement = useCallback((m: TakeoffRow) => {
    m = applyNextMaterial(uniqueName(stampPage(m)));
    const mBefore = measurementsRef.current;
    let mAfter = [...mBefore, m];

    const isChild = !!m.parentId;
    if (isChild && m.parentId) {
      mAfter = recalculateParentTotal(m.parentId, mAfter);
    }

    syncedSetProjectState(prev => {
      measurementsRef.current = mAfter;
      return { ...prev, measurements: mAfter };
    });

    if (!isChild) {
      pushEntry({
        measurementsBefore: mBefore,
        tempPointsBefore:   tempPointsRef.current,
        measurementsAfter:  mAfter,
        tempPointsAfter:    tempPointsRef.current,
        undoneMeasurement:  m,
      });
    }
  }, [pushEntry, syncedSetProjectState, recalculateParentTotal]);

  // ── batchCommitMeasurements ────────────────────────────────────────────────
  const batchCommitMeasurements = useCallback((measurements: TakeoffRow[]) => {
    if (measurements.length === 0) return;
    measurements = measurements.map(r => applyNextMaterial(stampPage(r)));

    const mBefore = measurementsRef.current;
    const tBefore = tempPointsRef.current;
    let mAfter = [...mBefore, ...measurements];

    const parentIdsNeedingRecalc = new Set<string>();
    for (const m of measurements) {
      if (m.parentId) parentIdsNeedingRecalc.add(m.parentId);
    }
    for (const parentId of parentIdsNeedingRecalc) {
      mAfter = recalculateParentTotal(parentId, mAfter);
    }

    syncedSetProjectState(prev => {
      measurementsRef.current = mAfter;
      return { ...prev, measurements: mAfter };
    });

    pushEntry({
      measurementsBefore: mBefore,
      tempPointsBefore:   tBefore,
      measurementsAfter:  mAfter,
      tempPointsAfter:    tBefore,
      undoneMeasurement:  measurements.find(m => m.isGroupHeader),
    });
  }, [pushEntry, syncedSetProjectState, recalculateParentTotal]);

  const clearTempPoints = useCallback(() => {
    tempPointsRef.current = [];
    syncedSetTempPoints(() => []);
  }, [syncedSetTempPoints]);

  // ── addMeasurement ─────────────────────────────────────────────────────────
  const addMeasurement = useCallback((m: TakeoffRow) => {
    m = applyNextMaterial(uniqueName(stampPage(m)));
    const mBefore = measurementsRef.current;
    const tBefore = tempPointsRef.current;
    let mAfter  = [...mBefore, m];

    if (m.parentId) {
      mAfter = recalculateParentTotal(m.parentId, mAfter);
    }

    syncedSetProjectState(prev => {
      measurementsRef.current = mAfter;
      return { ...prev, measurements: mAfter };
    });

    pushEntry({
      measurementsBefore: mBefore,
      tempPointsBefore:   tBefore,
      measurementsAfter:  mAfter,
      tempPointsAfter:    tBefore,
    });
  }, [pushEntry, syncedSetProjectState, recalculateParentTotal]);

  // ── updateMeasurement ──────────────────────────────────────────────────────
  const updateMeasurement = useCallback((id: string, updates: Partial<TakeoffRow>) => {
    const mBefore = measurementsRef.current;
    const tBefore = tempPointsRef.current;
    let mAfter  = mBefore.map(m => m.id === id ? { ...m, ...updates } : m);

    const updatedMeasurement = mAfter.find(m => m.id === id);
    if (updatedMeasurement?.parentId) {
      mAfter = recalculateParentTotal(updatedMeasurement.parentId, mAfter);
    }

    syncedSetProjectState(prev => {
      measurementsRef.current = mAfter;
      return { ...prev, measurements: mAfter };
    });

    pushEntry({
      measurementsBefore: mBefore,
      tempPointsBefore:   tBefore,
      measurementsAfter:  mAfter,
      tempPointsAfter:    tBefore,
    });
  }, [pushEntry, syncedSetProjectState, recalculateParentTotal]);

  // ── deleteMeasurement ──────────────────────────────────────────────────────
  const deleteMeasurement = useCallback((id: string) => {
    const mBefore = measurementsRef.current;
    const tBefore = tempPointsRef.current;

    const deletedMeasurement = mBefore.find(m => m.id === id);
    if (!deletedMeasurement) return;

    let mAfter = mBefore.filter(m => m.id !== id);

    if (deletedMeasurement.parentId) {
      mAfter = recalculateParentTotal(deletedMeasurement.parentId, mAfter);
    }

    if (deletedMeasurement.isGroupHeader && deletedMeasurement.childIds) {
      const childIdsToDelete = deletedMeasurement.childIds ?? [];
      mAfter = mAfter.filter(m => !childIdsToDelete.includes(m.id as never));
    }

    syncedSetProjectState(prev => {
      measurementsRef.current = mAfter;
      return { ...prev, measurements: mAfter };
    });

    pushEntry({
      measurementsBefore: mBefore,
      tempPointsBefore:   tBefore,
      measurementsAfter:  mAfter,
      tempPointsAfter:    tBefore,
    });
  }, [pushEntry, syncedSetProjectState, recalculateParentTotal]);

  // ── toggleVisibility ───────────────────────────────────────────────────────
  const toggleVisibility = useCallback((id?: string) => {
    if (!id) return;
    syncedSetProjectState(prev => ({
      ...prev,
      measurements: prev.measurements.map(m =>
        m.id === id ? { ...m, isVisible: !m.isVisible } : m
      ),
    }));
  }, [syncedSetProjectState]);

  // ── clearAll ───────────────────────────────────────────────────────────────
  const clearAll = useCallback(() => {
    const mBefore = measurementsRef.current;
    const tBefore = tempPointsRef.current;

    syncedSetProjectState(prev => {
      measurementsRef.current = [];
      return { ...prev, measurements: [] };
    });
    tempPointsRef.current = [];
    syncedSetTempPoints(() => []);

    pushEntry({
      measurementsBefore: mBefore,
      tempPointsBefore:   tBefore,
      measurementsAfter:  [],
      tempPointsAfter:    [],
    });
  }, [pushEntry, syncedSetProjectState, syncedSetTempPoints]);

  // ── createGroup ────────────────────────────────────────────────────────────
  const createGroup = useCallback((groupName: string, measurementIds: string[], groupType?: string) => {
    const groupId = `group-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const mBefore = measurementsRef.current;

    const groupHeader: TakeoffRow = {
      id:            groupId,
      drawingId:     projectState.activeDrawingId || '',
      description:   groupName,
      type:          groupType === 'count' ? 'Count' : 'Length',
      quantity:      0,
      unit:          groupType === 'count' ? 'EA' : 'm',
      unitRate:      0,
      notes:         '',
      points:        [],
      isOverridden:  false,
      color:         '#3B82F6',
      isVisible:     true,
      isGroupHeader: true,
      isExpanded:    true,
      childIds:      measurementIds,
    };

    const mAfter = mBefore.map(m =>
      measurementIds.includes(m.id)
        ? { ...m, groupId, parentId: groupId }
        : m
    );

    const firstMeasurementIndex = mAfter.findIndex(m => measurementIds.includes(m.id));
    if (firstMeasurementIndex >= 0) {
      mAfter.splice(firstMeasurementIndex, 0, groupHeader);
    } else {
      mAfter.push(groupHeader);
    }

    syncedSetProjectState(prev => {
      measurementsRef.current = mAfter;
      return { ...prev, measurements: mAfter };
    });

    pushEntry({
      measurementsBefore: mBefore,
      tempPointsBefore:   [],
      measurementsAfter:  mAfter,
      tempPointsAfter:    [],
    });

    return groupId;
  }, [projectState, pushEntry, syncedSetProjectState]);

  // ── deleteGroup ────────────────────────────────────────────────────────────
  const deleteGroup = useCallback((groupId: string, deleteChildren: boolean = false) => {
    const mBefore = measurementsRef.current;
    let mAfter = mBefore;

    if (deleteChildren) {
      mAfter = mBefore.filter(m => m.id !== groupId && m.parentId !== groupId);
    } else {
      mAfter = mBefore
        .map(m => m.parentId === groupId ? { ...m, groupId: undefined, parentId: undefined } : m)
        .filter(m => m.id !== groupId);
    }

    syncedSetProjectState(prev => {
      measurementsRef.current = mAfter;
      return { ...prev, measurements: mAfter };
    });

    pushEntry({
      measurementsBefore: mBefore,
      tempPointsBefore:   [],
      measurementsAfter:  mAfter,
      tempPointsAfter:    [],
    });
  }, [pushEntry, syncedSetProjectState]);

  // ── ungroupMeasurements ────────────────────────────────────────────────────
  const ungroupMeasurements = useCallback((groupId: string) => {
    const mBefore = measurementsRef.current;
    const mAfter = mBefore
      .map(m => m.parentId === groupId ? { ...m, groupId: undefined, parentId: undefined } : m)
      .filter(m => m.id !== groupId);

    syncedSetProjectState(prev => {
      measurementsRef.current = mAfter;
      return { ...prev, measurements: mAfter };
    });

    pushEntry({
      measurementsBefore: mBefore,
      tempPointsBefore:   [],
      measurementsAfter:  mAfter,
      tempPointsAfter:    [],
    });
  }, [pushEntry, syncedSetProjectState]);

  // ── toggleGroupExpanded ────────────────────────────────────────────────────
  const toggleGroupExpanded = useCallback((groupId: string) => {
    syncedSetProjectState(prev => ({
      ...prev,
      measurements: prev.measurements.map(m =>
        m.id === groupId ? { ...m, isExpanded: !m.isExpanded } : m
      ),
    }));
  }, [syncedSetProjectState]);

  // ── Drawing helpers ────────────────────────────────────────────────────────
  const projectIdRef = useRef<string | null>(projectId);
  useEffect(() => { projectIdRef.current = projectId; }, [projectId]);

  const addDrawing = useCallback((name: string, fileUrl: string, file?: File) => {
    const id = newId();
    syncedSetProjectState(prev => ({
      ...prev,
      drawings: [...prev.drawings, { id, name, fileUrl, file, scaleFactor: 1, pageScales: {}, pageCount: 1 }],
      activeDrawingId: id,
    }));
    setActivePage(1);
    const pid = projectIdRef.current;
    if (pid && file) {
      saveDrawingFile(pid, id, file).then(() => pushProjectToFolder(pid)).catch(err => {
        console.error('[storage] failed to store drawing file', err);
        setSaveStatus('error');
      });
    }
  }, [syncedSetProjectState]);

  const removeDrawing = useCallback((id: string) => {
    const target = drawingsRef.current.find(d => d.id === id);
    const mAfter = measurementsRef.current.filter(m => m.drawingId !== id);
    measurementsRef.current = mAfter;
    syncedSetProjectState(prev => {
      const drawings = prev.drawings.filter(d => d.id !== id);
      return {
        ...prev,
        drawings,
        measurements: mAfter,
        activeDrawingId: prev.activeDrawingId === id ? (drawings[0]?.id ?? null) : prev.activeDrawingId,
      };
    });
    tempPointsRef.current = [];
    syncedSetTempPoints(() => []);
    // Removing a drawing deletes its file; it can't be undone, so drop history.
    resetHistory();
    if (target?.fileUrl?.startsWith('blob:')) URL.revokeObjectURL(target.fileUrl);
    const pid = projectIdRef.current;
    if (pid) deleteDrawingFile(pid, id).catch(err => console.error('[storage] delete file failed', err));
    deleteDrawingRegions(id).catch(() => {});
  }, [syncedSetProjectState, syncedSetTempPoints, resetHistory]);

  const setActiveDrawingId = useCallback((id: string) => {
    syncedSetProjectState(prev => ({ ...prev, activeDrawingId: id }));
    setActivePage(1);
    tempPointsRef.current = [];
    syncedSetTempPoints(() => []);
  }, [syncedSetProjectState, syncedSetTempPoints]);

  const setDrawingPageCount = useCallback((id: string, pageCount: number) => {
    if (!(pageCount > 0)) return;
    if (drawingsRef.current.find(d => d.id === id)?.pageCount === pageCount) return;
    syncedSetProjectState(prev => ({
      ...prev,
      drawings: prev.drawings.map(d => (d.id === id ? { ...d, pageCount } : d)),
    }));
  }, [syncedSetProjectState]);

  const goToPage = useCallback((drawingId: string, page: number) => {
    const current = drawingsRef.current.find(d => d.id === drawingId);
    if (!current) return;
    syncedSetProjectState(prev => (prev.activeDrawingId === drawingId ? prev : { ...prev, activeDrawingId: drawingId }));
    setPendingPage(Math.max(1, page));
  }, [syncedSetProjectState]);

  const focusMeasurement = useCallback((id: string) => {
    const m = measurementsRef.current.find(x => x.id === id);
    setSelectedId(id);
    setFocusSeq(n => n + 1);
    if (!m || m.isGroupHeader || !m.points?.length) return;
    const page = m.pageNumber ?? 1;
    const sameDrawing = activeDrawingIdRef.current === m.drawingId;
    if (!sameDrawing || activePageRef.current !== page) goToPage(m.drawingId, page);
  }, [goToPage]);

  const updateDrawingScale = useCallback((id: string, factor: number, page: number = 1) => {
    if (!(factor > 0) || !Number.isFinite(factor)) return;
    const dBefore = drawingsRef.current;
    const drawing = dBefore.find(d => d.id === id);
    if (!drawing) return;

    const oldScale = effectivePageScale(drawing, page);
    const dAfter   = dBefore.map(d => d.id === id
      ? { ...d, pageScales: { ...(d.pageScales ?? {}), [page]: factor } }
      : d);

    const mBefore = measurementsRef.current;
    const mAfter  = recalcAllParents(
      rescaleMeasurementsForPage(mBefore, id, page, oldScale, factor),
    );

    measurementsRef.current = mAfter;
    drawingsRef.current     = dAfter;
    syncedSetProjectState(prev => ({ ...prev, drawings: dAfter, measurements: mAfter }));

    pushEntry({
      measurementsBefore: mBefore,
      tempPointsBefore:   tempPointsRef.current,
      measurementsAfter:  mAfter,
      tempPointsAfter:    tempPointsRef.current,
      drawingsBefore:     dBefore,
      drawingsAfter:      dAfter,
    });
  }, [syncedSetProjectState, pushEntry, recalcAllParents]);

  // ── Load project from local storage ────────────────────────────────────────
  const hydratedRef = useRef(false);
  const objectUrlsRef = useRef<string[]>([]);

  // If the project wasn't found (or failed to load) and a folder sync then
  // brings projects in, try again — this is how a project opens when browser
  // storage is unavailable and the user has just chosen their projects folder.
  const [reloadTick, setReloadTick] = useState(0);
  const loadStatusRef = useRef(loadStatus);
  loadStatusRef.current = loadStatus;
  useEffect(() => {
    const onPulled = () => {
      if (loadStatusRef.current === 'not-found' || loadStatusRef.current === 'error') setReloadTick(t => t + 1);
    };
    window.addEventListener(PROJECTS_PULLED_EVENT, onPulled);
    return () => window.removeEventListener(PROJECTS_PULLED_EVENT, onPulled);
  }, []);

  useEffect(() => {
    hydratedRef.current = false;
    if (!projectId) { setLoadStatus('idle'); return; }
    void initFolderSync();

    let cancelled = false;
    setLoadStatus('loading');
    setLoadError(null);

    (async () => {
      try {
        // Projects kept in the folder: read them from it first (no-op, and no
        // prompt, if access hasn't been allowed yet — the screen then asks).
        if (getStorageMode() !== 'browser') { await initFolderSync(); await syncFolder(); }
        const rec = await getProject(projectId);
        if (cancelled) return;
        if (!rec) { setLoadStatus('not-found'); return; }

        const files = await loadDrawingFiles(projectId);
        if (cancelled) return;

        const urls: string[] = [];
        const drawings: Drawing[] = rec.state.drawings.map(d => {
          const file = files.get(d.id);
          const fileUrl = file ? URL.createObjectURL(file) : '';
          if (fileUrl) urls.push(fileUrl);
          return { ...d, file, fileUrl, pageScales: d.pageScales ?? {} };
        });
        objectUrlsRef.current = urls;

        const next: ProjectState = {
          ...defaultProject(),
          ...rec.state,
          // Projects saved with an empty material bank get the built-in catalogue.
          materials: rec.state.materials?.length ? rec.state.materials : defaultMaterialBank(),
          drawings,
          activeDrawingId: rec.state.activeDrawingId && drawings.some(d => d.id === rec.state.activeDrawingId)
            ? rec.state.activeDrawingId
            : (drawings[0]?.id ?? null),
        };
        measurementsRef.current = next.measurements;
        drawingsRef.current     = next.drawings;
        activeDrawingIdRef.current = next.activeDrawingId;
        tempPointsRef.current   = [];
        setProjectState(next);
        setTempPoints([]);
        setActivePage(1);
        resetHistory();
        setSaveStatus('saved');
        setLastSavedAt(rec.updatedAt);
        setLoadStatus('ready');
        // Enable autosave only after the loaded state has been committed.
        setTimeout(() => { if (!cancelled) hydratedRef.current = true; }, 0);
        requestPersistentStorage();
      } catch (err) {
        if (cancelled) return;
        console.error('[storage] failed to load project', err);
        setLoadError(err instanceof Error ? err.message : String(err));
        setLoadStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      for (const u of objectUrlsRef.current) URL.revokeObjectURL(u);
      objectUrlsRef.current = [];
    };
  }, [projectId, resetHistory, reloadTick]);

  // ── Autosave (debounced) ───────────────────────────────────────────────────
  const latestStateRef = useRef(projectState);
  useLayoutEffect(() => { latestStateRef.current = projectState; }, [projectState]);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveNow = useCallback(async () => {
    const pid = projectIdRef.current;
    if (!pid || !hydratedRef.current) return;
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    setSaveStatus('saving');
    try {
      const at = await saveProjectState(pid, latestStateRef.current);
      if (getStorageMode() !== 'browser') {
        // The folder IS the storage: it only counts as saved once it is written there.
        await pushProjectToFolder(pid);
        const f = getFolderStatus();
        if (!f.folderName || f.permission !== 'granted' || f.error) {
          setSaveError(f.error ?? (f.folderName
            ? `Not saved: access to your projects folder “${f.folderName}” needs to be allowed again. Use “Allow” next to this message.`
            : 'Not saved: choose your projects folder.'));
          setSaveStatus('error');
          return;
        }
      } else {
        // Mirror to the user's folder if they chose one (never prompts, never blocks).
        void pushProjectToFolder(pid);
      }
      setLastSavedAt(at);
      setSaveStatus('saved');
      setSaveError(null);
    } catch (err) {
      console.error('[storage] autosave failed', err);
      setSaveError(describeStorageError(err));
      setSaveStatus('error');
    }
  }, []);

  useEffect(() => {
    if (!projectId || !hydratedRef.current) return;
    setSaveStatus('unsaved');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => { void saveNow(); }, 700);
  }, [projectState, projectId, saveNow]);

  // Flush pending changes when the tab is hidden or closed.
  useEffect(() => {
    const flush = () => { if (saveTimerRef.current) void saveNow(); };
    const onVis = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', flush);
    };
  }, [saveNow]);

  // ── Context value ──────────────────────────────────────────────────────────
  const canUndo = historyLen.past   > 0;
  const canRedo = historyLen.future > 0;

  const value = useMemo<TakeoffDataValue>(() => ({
    projectState,
    setProjectState: syncedSetProjectState,
    activeTool,
    setActiveTool,
    selectedId,
    setSelectedId,
    addDrawing,
    removeDrawing,
    setDrawingPageCount,
    pendingPage,
    clearPendingPage,
    goToPage,
    focusMeasurement,
    focusSeq,
    showLabels,
    setShowLabels,
    showGeometry,
    setShowGeometry,
    materialLibraryOpen,
    setMaterialLibraryOpen,
    setNextMaterial,
    activePage,
    setActivePage,
    projectId,
    loadStatus,
    loadError,
    saveNow,
    setActiveDrawingId,
    updateDrawingScale,
    addMeasurement,
    updateMeasurement,
    deleteMeasurement,
    clearAll,
    toggleVisibility,
    createGroup,
    deleteGroup,
    ungroupMeasurements,
    toggleGroupExpanded,
    setPendingMeasurement,
    pushPoint,
    commitMeasurement,
    batchCommitMeasurements,
    clearTempPoints,
    retagTempPoints,
    undo,
    redo,
    canUndo,
    canRedo,
    updateProjectMeta,
    getEffectiveQuantity,
    getEffectiveUnit,
    displayUnit,
    setDisplayUnit,
  }), [
    projectState, syncedSetProjectState, activeTool, selectedId, addDrawing, removeDrawing,
    setDrawingPageCount, pendingPage, clearPendingPage, goToPage, focusMeasurement, focusSeq, showLabels, setShowLabels, showGeometry, setShowGeometry, materialLibraryOpen, setNextMaterial,
    activePage, projectId, loadStatus, loadError, saveNow,
    setActiveDrawingId, updateDrawingScale, addMeasurement, updateMeasurement, deleteMeasurement,
    clearAll, toggleVisibility, createGroup, deleteGroup, ungroupMeasurements, toggleGroupExpanded,
    pushPoint, commitMeasurement, batchCommitMeasurements,
    clearTempPoints, retagTempPoints, undo, redo, canUndo, canRedo, updateProjectMeta,
    getEffectiveQuantity, getEffectiveUnit, displayUnit,
  ]);

  const interactionValue = useMemo<InteractionValue>(
    () => ({ tempPoints, pendingMeasurement }),
    [tempPoints, pendingMeasurement],
  );
  const saveStatusValue = useMemo(() => ({ saveStatus, lastSavedAt, saveError }), [saveStatus, lastSavedAt, saveError]);

  return (
    <TakeoffContext.Provider value={value}>
      <InteractionContext.Provider value={interactionValue}>
        <SaveStatusContext.Provider value={saveStatusValue}>
          {children}
        </SaveStatusContext.Provider>
      </InteractionContext.Provider>
    </TakeoffContext.Provider>
  );
}

/**
 * Full context including in-progress drawing points. Re-renders on every
 * drawing click — use in the Viewer. Elsewhere prefer useTakeoffData().
 */
export function useTakeoffContext(): TakeoffContextValue {
  const ctx = useContext(TakeoffContext);
  if (!ctx) throw new Error('useTakeoffContext must be used inside TakeoffProvider');
  const interaction = useContext(InteractionContext);
  return useMemo(() => ({ ...ctx, ...interaction }), [ctx, interaction]);
}

/** Project data + actions, without the per-click drawing state. */
export function useTakeoffData(): TakeoffDataValue {
  const ctx = useContext(TakeoffContext);
  if (!ctx) throw new Error('useTakeoffData must be used inside TakeoffProvider');
  return ctx;
}

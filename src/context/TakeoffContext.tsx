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
//  All new fields are optional — zero impact on existing consumers.
//
// ─────────────────────────────────────────────────────────────────────────────

import React, {
  createContext, useCallback, useContext, useRef, useState,
} from 'react';
import { TakeoffRow, Drawing } from '@/types';

// ─── Stakeholders ─────────────────────────────────────────────────────────────
export type Stakeholders = {
  mainContractor?:   string;   // e.g. "ARCO GROUP"
  designConsultant?: string;   // e.g. "HOPKINS ARCHITECTS"
  supervision?:      string;   // e.g. "DEWAN ARCHITECTS + ENGINEERS"
  client?:           string;   // optional — client / employer name
  projectManager?:   string;   // optional — PM firm
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

  // ── Core (pre-existing, required) ─────────────────────────────────────────
  projectName:     string;
  projectNumber:   string;
  unit:            string;
  drawings:        Drawing[];
  activeDrawingId: string | null;
  measurements:    TakeoffRow[];
  materials:       unknown[];

  // ── Project Identity (optional) ───────────────────────────────────────────
  projectLocation?:  string;   // e.g. "EXPO CITY DUBAI"
  projectPhase?:     string;   // e.g. "Phase-01 – Mobility District"
  kitchenType?:      string;   // e.g. "C01"
  totalUnits?:       number;   // e.g. 58  — multiply per-unit qty by this for project total

  // ── Document Metadata (optional) ──────────────────────────────────────────
  documentTitle?:    string;   // e.g. "BILL OF QUANTITIES – KITCHEN FITOUT"
  documentDate?:     string;   // ISO-8601 date  e.g. "2026-03-21"
  revision?:         string;   // e.g. "Rev 1 – First Issue"
  currency?:         string;   // ISO-4217 code  e.g. "AED", "USD"
  vatPercent?:       number;   // e.g. 5  (stored as %, applied as / 100 when calculating)

  // ── Stakeholders (optional) ───────────────────────────────────────────────
  stakeholders?:     Stakeholders;

  // ── Drawing References (optional) ─────────────────────────────────────────
  drawingReferences?: string[];  // e.g. ["C5128-SDW-2TR5600-FO-6000001", ...]

  // ── Scope Notes (optional) ────────────────────────────────────────────────
  generalAssumptions?:   ScopeAssumption[];   // general BOQ assumptions
  excludedItems?:        ExcludedItem[];       // items explicitly out-of-scope
};

// ── InProgressPoint (re-exported so Viewer/useMeasurements can import from here)
export type InProgressPoint = { x: number; y: number; snapped: boolean; segmentId?: string };

// ── PendingMeasurement — metadata for restored measurements during undo
export type PendingMeasurement = {
  id: string;
  type: 'Length' | 'Area' | 'Polygon' | 'Rectangle' | 'Count' | 'Point';
  color: string;
  description: string;
};

// ── Undo entry — full before/after snapshot of both arrays ───────────────────
type UndoEntry = {
  measurementsBefore: TakeoffRow[];
  tempPointsBefore:   InProgressPoint[];
  measurementsAfter:  TakeoffRow[];
  tempPointsAfter:    InProgressPoint[];
  undoneMeasurement?: TakeoffRow;
};

const MAX_HISTORY = 100;

// ── Context shape ─────────────────────────────────────────────────────────────
interface TakeoffContextValue {
  projectState:        ProjectState;
  setProjectState:     React.Dispatch<React.SetStateAction<ProjectState>>;

  // Tool selection
  activeTool:          string;
  setActiveTool:       (t: string) => void;
  selectedId:          string | null;
  setSelectedId:       (id: string | null) => void;

  // Drawing management
  addDrawing:          (name: string, fileUrl: string, file?: File) => void;
  setActiveDrawingId:  (id: string) => void;
  updateDrawingScale:  (id: string, factor: number) => void;

  // ── Committed measurements ────────────────────────────────────────────────
  addMeasurement:      (m: TakeoffRow) => void;
  updateMeasurement:   (id: string, updates: Partial<TakeoffRow>) => void;
  deleteMeasurement:   (id: string) => void;
  clearAll:            () => void;
  toggleVisibility:    (id?: string) => void;

  // ── Group management ──────────────────────────────────────────────────────
  createGroup:         (groupName: string, measurementIds: string[], groupType?: string) => string;
  deleteGroup:         (groupId: string, deleteChildren?: boolean) => void;
  ungroupMeasurements: (groupId: string) => void;
  toggleGroupExpanded: (groupId: string) => void;

  // ── In-progress drawing points ────────────────────────────────────────────
  tempPoints:          InProgressPoint[];
  pendingMeasurement:  PendingMeasurement | null;
  setPendingMeasurement: (m: PendingMeasurement | null) => void;

  pushPoint:           (point: InProgressPoint) => void;
  commitMeasurement:   (m: TakeoffRow) => void;
  batchCommitMeasurements: (measurements: TakeoffRow[]) => void;
  clearTempPoints:     () => void;

  // ── Undo / Redo ───────────────────────────────────────────────────────────
  undo:                () => void;
  redo:                () => void;
  canUndo:             boolean;
  canRedo:             boolean;

  // ── Metadata helpers ──────────────────────────────────────────────────────
  updateProjectMeta:   (updates: Partial<Omit<ProjectState,
    'drawings' | 'activeDrawingId' | 'measurements' | 'materials'
  >>) => void;

  // ── Helper to get effective quantity (computes from children for groups) ──
  getEffectiveQuantity: (measurement: TakeoffRow) => number;
  getEffectiveUnit: (measurement: TakeoffRow) => string;
}

// ─── Default project state ────────────────────────────────────────────────────
const defaultProject = (): ProjectState => ({
  // ── Core (required) ───────────────────────────────────────────────────────
  projectName:     'New Project',
  projectNumber:   '',
  unit:            'm',
  drawings:        [],
  activeDrawingId: null,
  measurements:    [],
  materials:       [],

  // ── Project Identity ──────────────────────────────────────────────────────
  projectLocation:  undefined,
  projectPhase:     undefined,
  kitchenType:      undefined,
  totalUnits:       undefined,

  // ── Document Metadata ─────────────────────────────────────────────────────
  documentTitle:    undefined,
  documentDate:     undefined,
  revision:         undefined,
  currency:         undefined,
  vatPercent:       undefined,

  // ── Stakeholders ──────────────────────────────────────────────────────────
  stakeholders: {
    mainContractor:   undefined,
    designConsultant: undefined,
    supervision:      undefined,
    client:           undefined,
    projectManager:   undefined,
  },

  // ── Drawing References ────────────────────────────────────────────────────
  drawingReferences: undefined,

  // ── Scope Notes ───────────────────────────────────────────────────────────
  generalAssumptions: undefined,
  excludedItems:      undefined,
});

// ─── Context ──────────────────────────────────────────────────────────────────
const TakeoffContext = createContext<TakeoffContextValue | null>(null);

export function TakeoffProvider({ children }: { children: React.ReactNode }) {
  const [projectState, setProjectState] = useState<ProjectState>(defaultProject);
  const [activeTool,   setActiveTool]   = useState<string>('select');
  const [selectedId,   setSelectedId]   = useState<string | null>(null);

  const [tempPoints, setTempPoints] = useState<InProgressPoint[]>([]);
  const [pendingMeasurement, setPendingMeasurement] = useState<PendingMeasurement | null>(null);

  const [undoPast,   setUndoPast]   = useState<UndoEntry[]>([]);
  const [undoFuture, setUndoFuture] = useState<UndoEntry[]>([]);

  const measurementsRef = useRef<TakeoffRow[]>([]);
  const tempPointsRef   = useRef<InProgressPoint[]>([]);

  const syncedSetProjectState: typeof setProjectState = useCallback((updater) => {
    setProjectState(prev => {
      const next = typeof updater === 'function' ? (updater as (p: ProjectState) => ProjectState)(prev) : updater;
      measurementsRef.current = next.measurements;
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
    setUndoPast(p => [...p.slice(-MAX_HISTORY), entry]);
    setUndoFuture([]);
  }, []);

  const applySnapshot = useCallback((
    measurements: TakeoffRow[],
    tempPts:      InProgressPoint[],
  ) => {
    syncedSetProjectState(prev => {
      measurementsRef.current = measurements;
      return { ...prev, measurements };
    });
    syncedSetTempPoints(() => {
      tempPointsRef.current = tempPts;
      return tempPts;
    });
  }, [syncedSetProjectState, syncedSetTempPoints]);

  // ── Helper to recalculate parent total based on children ───────────────────
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

  // ── Get effective quantity (computes from children for groups) ─────────────
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

  // ── Metadata update helper ─────────────────────────────────────────────────
  // Intentionally NOT pushed into undo/redo — metadata changes shouldn't be
  // undone via Ctrl+Z alongside measurement edits.
  const updateProjectMeta = useCallback((
    updates: Partial<Omit<ProjectState, 'drawings' | 'activeDrawingId' | 'measurements' | 'materials'>>
  ) => {
    syncedSetProjectState(prev => ({ ...prev, ...updates }));
  }, [syncedSetProjectState]);

  // ── Undo / Redo ────────────────────────────────────────────────────────────
  const undo = useCallback(() => {
    setUndoPast(past => {
      if (past.length === 0) return past;
      const entry = past[past.length - 1];
      const rest  = past.slice(0, -1);

      let measurements = [...entry.measurementsBefore];
      const tempPts = [...entry.tempPointsBefore];

      const parentIdsNeedingRecalc = new Set<string>();
      for (const m of measurements) {
        if (m.parentId) parentIdsNeedingRecalc.add(m.parentId);
      }
      for (const parentId of parentIdsNeedingRecalc) {
        measurements = recalculateParentTotal(parentId, measurements);
      }

      applySnapshot(measurements, tempPts);

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

      setUndoFuture(f => [entry, ...f]);
      return rest;
    });
  }, [applySnapshot, recalculateParentTotal]);

  const redo = useCallback(() => {
    setUndoFuture(future => {
      if (future.length === 0) return future;
      const entry = future[0];
      const rest  = future.slice(1);

      let measurements = [...entry.measurementsAfter];
      const tempPts = [...entry.tempPointsAfter];

      const parentIdsNeedingRecalc = new Set<string>();
      for (const m of measurements) {
        if (m.parentId) parentIdsNeedingRecalc.add(m.parentId);
      }
      for (const parentId of parentIdsNeedingRecalc) {
        measurements = recalculateParentTotal(parentId, measurements);
      }

      applySnapshot(measurements, tempPts);
      setPendingMeasurement(null);
      setUndoPast(p => [...p, entry]);
      return rest;
    });
  }, [applySnapshot, recalculateParentTotal]);

  // ── pushPoint ──────────────────────────────────────────────────────────────
  const pushPoint = useCallback((point: InProgressPoint) => {
    const mBefore = measurementsRef.current;
    const tBefore = tempPointsRef.current;
    const tAfter  = [...tBefore, point];

    syncedSetTempPoints(() => {
      tempPointsRef.current = tAfter;
      return tAfter;
    });

    pushEntry({
      measurementsBefore: mBefore,
      tempPointsBefore:   tBefore,
      measurementsAfter:  mBefore,
      tempPointsAfter:    tAfter,
    });
  }, [pushEntry, syncedSetTempPoints]);

  // ── commitMeasurement — single commit ──────────────────────────────────────
  const commitMeasurement = useCallback((m: TakeoffRow) => {
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

  // ── batchCommitMeasurements — eliminates race condition ───────────────────
  const batchCommitMeasurements = useCallback((measurements: TakeoffRow[]) => {
    if (measurements.length === 0) return;

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
    syncedSetTempPoints(() => {
      tempPointsRef.current = [];
      return [];
    });
  }, [syncedSetTempPoints]);

  // ── addMeasurement ─────────────────────────────────────────────────────────
  const addMeasurement = useCallback((m: TakeoffRow) => {
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
    syncedSetTempPoints(() => {
      tempPointsRef.current = [];
      return [];
    });

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

    let mAfter = mBefore.map(m =>
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
  const addDrawing = useCallback((name: string, fileUrl: string, file?: File) => {
    const id: string = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    syncedSetProjectState(prev => ({
      ...prev,
      drawings: [...prev.drawings, { id, name, fileUrl, file, scaleFactor: 1, pageCount: 1 }],
      activeDrawingId: id,
    }));
  }, [syncedSetProjectState]);

  const setActiveDrawingId = useCallback((id: string) => {
    syncedSetProjectState(prev => ({ ...prev, activeDrawingId: id }));
    syncedSetTempPoints(() => {
      tempPointsRef.current = [];
      return [];
    });
  }, [syncedSetProjectState, syncedSetTempPoints]);

  const updateDrawingScale = useCallback((id: string, factor: number) => {
    syncedSetProjectState(prev => ({
      ...prev,
      drawings: prev.drawings.map(d => d.id === id ? { ...d, scaleFactor: factor } : d),
    }));
  }, [syncedSetProjectState]);

  // ── Context value ──────────────────────────────────────────────────────────
  const value: TakeoffContextValue = {
    projectState,
    setProjectState: syncedSetProjectState,
    activeTool,
    setActiveTool,
    selectedId,
    setSelectedId,
    addDrawing,
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
    tempPoints,
    pendingMeasurement,
    setPendingMeasurement,
    pushPoint,
    commitMeasurement,
    batchCommitMeasurements,
    clearTempPoints,
    undo,
    redo,
    canUndo:  undoPast.length   > 0,
    canRedo:  undoFuture.length > 0,
    updateProjectMeta,
    getEffectiveQuantity,
    getEffectiveUnit,
  };

  return (
    <TakeoffContext.Provider value={value}>
      {children}
    </TakeoffContext.Provider>
  );
}

export function useTakeoffContext() {
  const ctx = useContext(TakeoffContext);
  if (!ctx) throw new Error('useTakeoffContext must be used inside TakeoffProvider');
  return ctx;
}
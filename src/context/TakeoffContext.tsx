'use client';

// ─── TakeoffContext.tsx ───────────────────────────────────────────────────────
//
//  UNIFIED STATE: This context is the single source of truth for:
//    - measurements[]     committed takeoff rows
//    - tempPoints[]       in-progress drawing points (lifted from Viewer)
//    - undo/redo stack    before/after snapshots of both arrays
//
// ─────────────────────────────────────────────────────────────────────────────

import React, {
  createContext, useCallback, useContext, useRef, useState,
} from 'react';
import { TakeoffRow, Drawing, ProjectState } from '@/types';

// ── InProgressPoint (re-exported so Viewer/useMeasurements can import from here)
export type InProgressPoint = { x: number; y: number; snapped: boolean; segmentId?: string };

// ── PendingMeasurement — metadata for restored measurements during undo
export type PendingMeasurement = {
  id: string;
  type: 'Length' | 'Polygon' | 'Rectangle' | 'Count' | 'Point';
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
  
  /** Commit a single measurement */
  commitMeasurement:   (m: TakeoffRow) => void;
  
  /** Batch commit multiple measurements atomically - NO race condition */
  batchCommitMeasurements: (measurements: TakeoffRow[]) => void;
  
  clearTempPoints:     () => void;

  // ── Undo / Redo ───────────────────────────────────────────────────────────
  undo:                () => void;
  redo:                () => void;
  canUndo:             boolean;
  canRedo:             boolean;
}

// ─── Default project state ────────────────────────────────────────────────────
const defaultProject = (): ProjectState => ({
  projectName:     'New Project',
  projectNumber:   '',
  unit:            'm',
  drawings:        [],
  activeDrawingId: null,
  measurements:    [],
  materials:       [],
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

  const undo = useCallback(() => {
    setUndoPast(past => {
      if (past.length === 0) return past;
      const entry = past[past.length - 1];
      const rest  = past.slice(0, -1);
      applySnapshot(entry.measurementsBefore, entry.tempPointsBefore);
      if (entry.undoneMeasurement && entry.tempPointsBefore.length > 0) {
        setPendingMeasurement({
          id: entry.undoneMeasurement.id,
          type: entry.undoneMeasurement.type,
          color: entry.undoneMeasurement.color,
          description: entry.undoneMeasurement.description,
        });
      } else {
        setPendingMeasurement(null);
      }
      setUndoFuture(f => [entry, ...f]);
      return rest;
    });
  }, [applySnapshot]);

  const redo = useCallback(() => {
    setUndoFuture(future => {
      if (future.length === 0) return future;
      const entry = future[0];
      const rest  = future.slice(1);
      applySnapshot(entry.measurementsAfter, entry.tempPointsAfter);
      setPendingMeasurement(null);
      setUndoPast(p => [...p, entry]);
      return rest;
    });
  }, [applySnapshot]);

  const pushPoint = useCallback((point: InProgressPoint) => {
    const mBefore  = measurementsRef.current;
    const tBefore  = tempPointsRef.current;
    const tAfter   = [...tBefore, point];

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

  // ── Single commit ──────────────────────────────────────────────────────────
  const commitMeasurement = useCallback((m: TakeoffRow) => {
    const mBefore = measurementsRef.current;
    const mAfter = [...mBefore, m];
    
    const isChild = !!m.parentId;
    
    syncedSetProjectState(prev => {
      measurementsRef.current = mAfter;
      return { ...prev, measurements: mAfter };
    });
    
    if (!isChild) {
      pushEntry({
        measurementsBefore: mBefore,
        tempPointsBefore: tempPointsRef.current,
        measurementsAfter: mAfter,
        tempPointsAfter: tempPointsRef.current,
        undoneMeasurement: m,
      });
    }
  }, [pushEntry, syncedSetProjectState]);

  // ── BATCH COMMIT - eliminates race condition ───────────────────────────────
  const batchCommitMeasurements = useCallback((measurements: TakeoffRow[]) => {
    if (measurements.length === 0) return;
    
    const mBefore = measurementsRef.current;
    const tBefore = tempPointsRef.current;
    
    // Add ALL measurements at once - no race condition!
    const mAfter = [...mBefore, ...measurements];
    
    syncedSetProjectState(prev => {
      measurementsRef.current = mAfter;
      return { ...prev, measurements: mAfter };
    });
    
    // Single undo entry for the entire batch
    pushEntry({
      measurementsBefore: mBefore,
      tempPointsBefore: tBefore,
      measurementsAfter: mAfter,
      tempPointsAfter: tBefore,
      undoneMeasurement: measurements.find(m => m.isGroupHeader),
    });
  }, [pushEntry, syncedSetProjectState]);

  const clearTempPoints = useCallback(() => {
    syncedSetTempPoints(() => {
      tempPointsRef.current = [];
      return [];
    });
  }, [syncedSetTempPoints]);

  const addMeasurement = useCallback((m: TakeoffRow) => {
    const mBefore = measurementsRef.current;
    const tBefore = tempPointsRef.current;
    const mAfter  = [...mBefore, m];

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
  }, [pushEntry, syncedSetProjectState]);

  const updateMeasurement = useCallback((id: string, updates: Partial<TakeoffRow>) => {
    const mBefore = measurementsRef.current;
    const tBefore = tempPointsRef.current;
    const mAfter  = mBefore.map(m => m.id === id ? { ...m, ...updates } : m);

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
  }, [pushEntry, syncedSetProjectState]);

  const deleteMeasurement = useCallback((id: string) => {
    const mBefore = measurementsRef.current;
    const tBefore = tempPointsRef.current;
    const mAfter  = mBefore.filter(m => m.id !== id);

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
  }, [pushEntry, syncedSetProjectState]);

  const toggleVisibility = useCallback((id?: string) => {
    if (!id) return;
    syncedSetProjectState(prev => ({
      ...prev,
      measurements: prev.measurements.map(m =>
        m.id === id ? { ...m, isVisible: !m.isVisible } : m
      ),
    }));
  }, [syncedSetProjectState]);

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

  const createGroup = useCallback((groupName: string, measurementIds: string[], groupType?: string) => {
    const groupId = `group-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const mBefore = measurementsRef.current;
    
    const groupHeader: TakeoffRow = {
      id: groupId,
      drawingId: projectState.activeDrawingId || '',
      description: groupName,
      type: 'Length',
      quantity: 0,
      unit: '',
      unitRate: 0,
      notes: '',
      points: [],
      isOverridden: false,
      color: '#3B82F6',
      isVisible: true,
      isGroupHeader: true,
      isExpanded: true,
      childIds: measurementIds,
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
      tempPointsBefore: [],
      measurementsAfter: mAfter,
      tempPointsAfter: [],
    });

    return groupId;
  }, [projectState, pushEntry, syncedSetProjectState]);

  const deleteGroup = useCallback((groupId: string, deleteChildren: boolean = false) => {
    const mBefore = measurementsRef.current;
    let mAfter = mBefore;

    if (deleteChildren) {
      mAfter = mBefore.filter(m => m.id !== groupId && m.parentId !== groupId);
    } else {
      mAfter = mBefore.map(m => 
        m.parentId === groupId 
          ? { ...m, groupId: undefined, parentId: undefined }
          : m
      ).filter(m => m.id !== groupId);
    }

    syncedSetProjectState(prev => {
      measurementsRef.current = mAfter;
      return { ...prev, measurements: mAfter };
    });

    pushEntry({
      measurementsBefore: mBefore,
      tempPointsBefore: [],
      measurementsAfter: mAfter,
      tempPointsAfter: [],
    });
  }, [pushEntry, syncedSetProjectState]);

  const ungroupMeasurements = useCallback((groupId: string) => {
    const mBefore = measurementsRef.current;
    const mAfter = mBefore.map(m => 
      m.parentId === groupId 
        ? { ...m, groupId: undefined, parentId: undefined }
        : m
    ).filter(m => m.id !== groupId);

    syncedSetProjectState(prev => {
      measurementsRef.current = mAfter;
      return { ...prev, measurements: mAfter };
    });

    pushEntry({
      measurementsBefore: mBefore,
      tempPointsBefore: [],
      measurementsAfter: mAfter,
      tempPointsAfter: [],
    });
  }, [pushEntry, syncedSetProjectState]);

  const toggleGroupExpanded = useCallback((groupId: string) => {
    syncedSetProjectState(prev => ({
      ...prev,
      measurements: prev.measurements.map(m =>
        m.id === groupId 
          ? { ...m, isExpanded: !m.isExpanded }
          : m
      ),
    }));
  }, [syncedSetProjectState]);

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
    canUndo: undoPast.length   > 0,
    canRedo: undoFuture.length > 0,
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
'use client';

// ─── TakeoffContext.tsx ───────────────────────────────────────────────────────
//
//  UNIFIED STATE: This context is the single source of truth for:
//    - measurements[]     committed takeoff rows
//    - tempPoints[]       in-progress drawing points (lifted from Viewer)
//    - undo/redo stack    before/after snapshots of both arrays
//
//  FIX: Parent quantities are recalculated dynamically when children change
//  FIX: Undo/redo properly updates parent totals
//
// ─────────────────────────────────────────────────────────────────────────────

import React, {
  createContext, useCallback, useContext, useRef, useState,
} from 'react';
import { TakeoffRow, Drawing } from '@/types';

type ProjectState = {
  projectName: string;
  projectNumber: string;
  unit: string;
  drawings: Drawing[];
  activeDrawingId: string | null;
  measurements: TakeoffRow[];
  materials: unknown[];
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
  
  // ── Helper to get effective quantity (computes from children for groups) ──
  getEffectiveQuantity: (measurement: TakeoffRow) => number;
  getEffectiveUnit: (measurement: TakeoffRow) => string;
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

  // ── Helper to recalculate parent total based on children ───────────────────
  const recalculateParentTotal = useCallback((parentId: string, measurements: TakeoffRow[]): TakeoffRow[] => {
    const parentIndex = measurements.findIndex(m => m.id === parentId);
    if (parentIndex === -1) return measurements;
    
    const parent = measurements[parentIndex];
    if (!parent.isGroupHeader || !parent.childIds) return measurements;
    
    const childIds = parent.childIds as string[];
    // Find all children that still exist
    const existingChildren = measurements.filter(m => childIds.includes(m.id));
    
    if (existingChildren.length === 0) {
      // If no children left, remove the parent entirely
      return measurements.filter(m => m.id !== parentId);
    }
    
    // Recalculate total based on child quantities
    let newTotal = 0;
    let newUnit = parent.unit;
    
    for (const child of existingChildren) {
      if (child.type === 'Length') {
        newTotal += child.quantity;
        newUnit = child.unit;
      } else if (child.type === 'Area') {
        newTotal += child.quantity;
        newUnit = child.unit;
      } else if (child.type === 'Count') {
        newTotal += child.quantity;
        newUnit = child.unit;
      }
    }
    
    // Update parent with new total
    const updatedMeasurements = [...measurements];
    updatedMeasurements[parentIndex] = { 
      ...parent, 
      quantity: newTotal, 
      unit: newUnit 
    };
    
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
      if (children.length > 0) {
        return children[0].unit || measurement.unit;
      }
    }
    return measurement.unit || '';
  }, []);

  // ── Undo / Redo ────────────────────────────────────────────────────────────
  const undo = useCallback(() => {
    setUndoPast(past => {
      if (past.length === 0) return past;
      const entry = past[past.length - 1];
      const rest  = past.slice(0, -1);
      
      // Apply the before state
      let measurements = [...entry.measurementsBefore];
      const tempPts = [...entry.tempPointsBefore];
      
      // Recalculate all parent totals to ensure consistency
      const parentIdsNeedingRecalc = new Set<string>();
      for (const m of measurements) {
        if (m.parentId) {
          parentIdsNeedingRecalc.add(m.parentId);
        }
      }
      
      for (const parentId of parentIdsNeedingRecalc) {
        measurements = recalculateParentTotal(parentId, measurements);
      }
      
      applySnapshot(measurements, tempPts);
      
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
  }, [applySnapshot, recalculateParentTotal]);

  const redo = useCallback(() => {
    setUndoFuture(future => {
      if (future.length === 0) return future;
      const entry = future[0];
      const rest  = future.slice(1);
      
      // Apply the after state
      let measurements = [...entry.measurementsAfter];
      const tempPts = [...entry.tempPointsAfter];
      
      // Recalculate all parent totals to ensure consistency
      const parentIdsNeedingRecalc = new Set<string>();
      for (const m of measurements) {
        if (m.parentId) {
          parentIdsNeedingRecalc.add(m.parentId);
        }
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

  // ── commitMeasurement - single commit ──────────────────────────────────────
  const commitMeasurement = useCallback((m: TakeoffRow) => {
    const mBefore = measurementsRef.current;
    let mAfter = [...mBefore, m];
    
    const isChild = !!m.parentId;
    
    // If this is a child, update the parent's total
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
        tempPointsBefore: tempPointsRef.current,
        measurementsAfter: mAfter,
        tempPointsAfter: tempPointsRef.current,
        undoneMeasurement: m,
      });
    }
  }, [pushEntry, syncedSetProjectState, recalculateParentTotal]);

  // ── BATCH COMMIT - eliminates race condition ───────────────────────────────
  const batchCommitMeasurements = useCallback((measurements: TakeoffRow[]) => {
    if (measurements.length === 0) return;
    
    const mBefore = measurementsRef.current;
    const tBefore = tempPointsRef.current;
    
    // Add ALL measurements at once - no race condition!
    let mAfter = [...mBefore, ...measurements];
    
    // After adding all measurements, recalculate parent totals for any children
    const parentIdsNeedingRecalc = new Set<string>();
    for (const m of measurements) {
      if (m.parentId) {
        parentIdsNeedingRecalc.add(m.parentId);
      }
    }
    
    for (const parentId of parentIdsNeedingRecalc) {
      mAfter = recalculateParentTotal(parentId, mAfter);
    }
    
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
  }, [pushEntry, syncedSetProjectState, recalculateParentTotal]);

  const clearTempPoints = useCallback(() => {
    syncedSetTempPoints(() => {
      tempPointsRef.current = [];
      return [];
    });
  }, [syncedSetTempPoints]);

  const addMeasurement = useCallback((m: TakeoffRow) => {
    const mBefore = measurementsRef.current;
    const tBefore = tempPointsRef.current;
    let mAfter  = [...mBefore, m];
    
    // If this is a child, update the parent's total
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

  const updateMeasurement = useCallback((id: string, updates: Partial<TakeoffRow>) => {
    const mBefore = measurementsRef.current;
    const tBefore = tempPointsRef.current;
    let mAfter  = mBefore.map(m => m.id === id ? { ...m, ...updates } : m);
    
    // Find the measurement being updated and recalculate its parent if needed
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

  const deleteMeasurement = useCallback((id: string) => {
    const mBefore = measurementsRef.current;
    const tBefore = tempPointsRef.current;
    
    // Find the measurement being deleted
    const deletedMeasurement = mBefore.find(m => m.id === id);
    if (!deletedMeasurement) return;
    
    let mAfter = mBefore.filter(m => m.id !== id);
    
    // If the deleted measurement had a parent, recalculate the parent's total
    if (deletedMeasurement.parentId) {
      mAfter = recalculateParentTotal(deletedMeasurement.parentId, mAfter);
    }
    
    // If the deleted measurement was a group header, also delete all its children
    if (deletedMeasurement.isGroupHeader && deletedMeasurement.childIds) {
      mAfter = mAfter.filter(m => !(deletedMeasurement.childIds ?? []).includes(m.id));
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
      type: groupType === 'count' ? 'Count' : 'Length',
      quantity: 0,
      unit: groupType === 'count' ? 'EA' : 'm',
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

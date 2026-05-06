// ─── useUndoRedo.ts ───────────────────────────────────────────────────────────
//
//  Generic undo/redo stack.
//
//  NEW: replaceCurrent(updater) — mutates present in-place WITHOUT pushing a
//  new history entry and WITHOUT clearing the redo stack.  This is what
//  finishMeasurement uses so the pre-finish tempPoints are preserved in the
//  commit snapshot and restored correctly on Ctrl+Z.
//
//  Full undo flow after:  Line A (pt1_A → pt2_A → finish)  + pt1_B in progress
//
//  Stack after pt1_B placed:
//    past[0]  { tempPoints: [],              lastCommittedId: null }
//    past[1]  { tempPoints: [pt1_A],         lastCommittedId: null }
//    past[2]  { tempPoints: [pt1_A, pt2_A],  lastCommittedId: null }
//    past[3]  { tempPoints: [pt1_A, pt2_A],  lastCommittedId: "lineA-id" }  ← replaceCurrent
//    present  { tempPoints: [pt1_B],          lastCommittedId: null }
//
//  Ctrl+Z × 4:
//    1st undo → present: past[3] = { [pt1_A,pt2_A], "lineA-id" }   tempPoints restored to [pt1_A,pt2_A]
//    2nd undo → lastCommittedId != null → DELETE lineA, then undoAction()
//               present: past[2] = { [pt1_A,pt2_A], null }          still drawing! ✅
//    3rd undo → present: past[1] = { [pt1_A], null }
//    4th undo → present: past[0] = { [], null }
//
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useCallback } from 'react';

const MAX_HISTORY = 100;

export interface UseUndoRedoReturn<T> {
  present:        T;
  push:           (next: T) => void;
  /** Mutate present in-place — no new history entry, redo stack preserved. */
  replaceCurrent: (updater: (prev: T) => T) => void;
  undo:           () => void;
  redo:           () => void;
  canUndo:        boolean;
  canRedo:        boolean;
}

export function useUndoRedo<T>(initial: T): UseUndoRedoReturn<T> {
  const [past,    setPast]    = useState<T[]>([]);
  const [present, setPresent] = useState<T>(initial);
  const [future,  setFuture]  = useState<T[]>([]);

  // Push a new entry — clears redo stack.
  const push = useCallback((next: T) => {
    setPast(p => [...p.slice(-MAX_HISTORY), present]);
    setPresent(next);
    setFuture([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [present]);

  // Mutate present without touching past or future.
  // Used by finishMeasurement so pre-finish tempPoints survive in the stack.
  const replaceCurrent = useCallback((updater: (prev: T) => T) => {
    setPresent(prev => updater(prev));
  }, []);

  const undo = useCallback(() => {
    setPast(p => {
      if (p.length === 0) return p;
      const prev = p[p.length - 1];
      const rest = p.slice(0, -1);
      setFuture(f => [present, ...f]);
      setPresent(prev);
      return rest;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [present]);

  const redo = useCallback(() => {
    setFuture(f => {
      if (f.length === 0) return f;
      const next = f[0];
      const rest = f.slice(1);
      setPast(p => [...p, present]);
      setPresent(next);
      return rest;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [present]);

  return {
    present,
    push,
    replaceCurrent,
    undo,
    redo,
    canUndo: past.length   > 0,
    canRedo: future.length > 0,
  };
}
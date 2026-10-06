'use client';

// ─── ViewerDialogs.tsx ────────────────────────────────────────────────────────
//
//  All dialogs and overlays rendered by the Viewer:
//    • CalibrationDialog    — user enters a known real-world distance
//    • AppendGroupBanner    — blue banner shown while appending to a group
//    • MeasurementDetailsDialog (re-exported with wiring props)
//    • SnapCandidateDialog  (re-exported with wiring props)
//    • PresetDrawer         (re-exported)
//
//  Each section is clearly delimited for easy navigation.
//
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';
import { Scaling } from 'lucide-react';
import { TakeoffRow } from '@/types';
import type { PresetTemplate } from '../presets/PresetTemplates';
import { PresetDrawer } from '../presets/PresetDrawer';
import { MeasurementDetailsDialog } from '@/components/features/measurements/MeasurementDetailsDialog';
import { SnapCandidateDialog } from './SnapCandidateDialog';


// ─────────────────────────────────────────────────────────────────────────────
// 1. Calibration Dialog
// ─────────────────────────────────────────────────────────────────────────────

interface CalibrationDialogProps {
  show:              boolean;
  calibrationInput:  string;
  setCalibrationInput: (v: string) => void;
  onConfirm:         () => void;
  onCancel:          () => void;
}

export function CalibrationDialog({
  show, calibrationInput, setCalibrationInput, onConfirm, onCancel,
}: CalibrationDialogProps) {
  if (!show) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-amber-400/40 shadow-2xl shadow-amber-400/10 p-6 w-80 font-mono">
        <div className="flex items-center gap-2 mb-4">
          <Scaling className="w-4 h-4 text-amber-400 flex-shrink-0" />
          <span className="text-xs font-bold text-amber-400 uppercase tracking-widest">
            Calibrate Scale
          </span>
        </div>
        <p className="text-[11px] text-zinc-400 uppercase tracking-wider mb-4 leading-relaxed">
          You drew a line across a known distance.<br />
          Enter the real-world length in meters.
        </p>
        <input
          autoFocus
          type="number"
          min="0.001"
          step="any"
          placeholder="e.g. 5"
          value={calibrationInput}
          onChange={e => setCalibrationInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') onConfirm();
            if (e.key === 'Escape') onCancel();
          }}
          className="w-full bg-zinc-800 border border-zinc-600 focus:border-amber-400 text-zinc-100 text-sm font-mono px-3 py-2 outline-none mb-4 transition-colors"
        />
        <div className="flex gap-2">
          <button
            onClick={onConfirm}
            disabled={!calibrationInput || isNaN(parseFloat(calibrationInput))}
            className="flex-1 bg-amber-400 disabled:bg-zinc-700 disabled:text-zinc-500 text-black font-bold text-[11px] uppercase tracking-widest py-2 transition-all hover:bg-amber-300"
          >
            Set Scale
          </button>
          <button
            onClick={onCancel}
            className="flex-1 border border-zinc-700 text-zinc-400 font-bold text-[11px] uppercase tracking-widest py-2 hover:border-zinc-500 transition-all"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Append Group Banner
// ─────────────────────────────────────────────────────────────────────────────

interface AppendGroupBannerProps {
  appendToGroupId: string | null | undefined;
  onCancel:        () => void;
}

export function AppendGroupBanner({ appendToGroupId, onCancel }: AppendGroupBannerProps) {
  if (!appendToGroupId) return null;

  return (
    <div className="absolute top-14 left-1/2 -translate-x-1/2 z-50 bg-blue-500/20 border border-blue-400/60 px-4 py-2 font-mono text-[11px] text-blue-300 uppercase tracking-widest flex items-center gap-2">
      <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
      Adding segment to group — draw line then right-click or press Finish
      <button onClick={onCancel} className="ml-2 text-blue-500 hover:text-blue-300">✕</button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Snap Candidate Dialog (wired)
// ─────────────────────────────────────────────────────────────────────────────

interface SnapCandidateWiredProps {
  pendingSnapCandidates: any[] | null;
  setPendingSnapCandidates: (v: any[] | null) => void;
  measurements: TakeoffRow[];
  onUpdateMeasurement?: (id: string, updates: Partial<TakeoffRow>) => void;
}

export function SnapCandidateWired({
  pendingSnapCandidates,
  setPendingSnapCandidates,
  measurements,
  onUpdateMeasurement,
}: SnapCandidateWiredProps) {
  if (!pendingSnapCandidates || pendingSnapCandidates.length === 0) return null;

  const handleAccept = () => {
    if (onUpdateMeasurement && pendingSnapCandidates.length > 0) {
      const byId = new Map<string, typeof pendingSnapCandidates>();
      for (const cand of pendingSnapCandidates) {
        if (!byId.has(cand.measurementId)) byId.set(cand.measurementId, []);
        byId.get(cand.measurementId)!.push(cand);
      }
      byId.forEach((candidates, measurementId) => {
        const target =
          measurements.find(m => m.id === measurementId) ??
          measurements[measurements.length - 1];
        if (!target) return;
        const updatedPoints = [...target.points];
        for (const c of candidates) {
          if (c.pointIndex < updatedPoints.length) {
            updatedPoints[c.pointIndex] = c.snapTarget;
          }
        }
        onUpdateMeasurement(target.id, { points: updatedPoints });
      });
    }
    setPendingSnapCandidates(null);
  };

  return (
    <SnapCandidateDialog
      count={pendingSnapCandidates.length}
      onAccept={handleAccept}
      onDismiss={() => setPendingSnapCandidates(null)}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Measurement Details Dialog (wired)
// ─────────────────────────────────────────────────────────────────────────────

interface MeasurementDetailsWiredProps {
  show:                  boolean;
  pendingMeasurementData: { id: string; type: string; description: string } | null;
  onConfirm:             (name: string, material: string, icon?: string) => void;
  onSkip:                () => void;
}

export function MeasurementDetailsWired({
  show, pendingMeasurementData, onConfirm, onSkip,
}: MeasurementDetailsWiredProps) {
  return (
    <MeasurementDetailsDialog
      isOpen={show}
      defaultName={pendingMeasurementData?.description || ''}
      defaultMaterial=""
      measurementType={pendingMeasurementData?.type}
      onConfirm={onConfirm}
      onSkip={onSkip}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Preset Drawer (wired)
// ─────────────────────────────────────────────────────────────────────────────

interface PresetDrawerWiredProps {
  showPresetDrawer:    boolean;
  onClosePresetDrawer: () => void;
  onSelectPreset:      (data: Record<string, any>, template: PresetTemplate) => void;
}

export function PresetDrawerWired({
  showPresetDrawer, onClosePresetDrawer, onSelectPreset,
}: PresetDrawerWiredProps) {
  return (
    <PresetDrawer
      isOpen={showPresetDrawer}
      onClose={onClosePresetDrawer}
      onSelectPreset={onSelectPreset}
    />
  );
}

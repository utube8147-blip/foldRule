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

import React, { useState } from 'react';
import { Scaling, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { checkScale } from '@/lib/takeoff/scale';
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
  /** Length of the drawn line in PDF points. */
  ptLen?:            number;
  /** Current scale of the page (metres per PDF point), or null when it has none yet. */
  currentScale?:     number | null;
  displayUnit?:      'm' | 'cm' | 'mm' | 'ft' | 'in';
}

const pct = (v: number) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(Math.abs(v) < 0.1 ? 1 : 0)}%`;
/** "50% too short" / "12% too long" */
const off = (v: number) => `${(Math.abs(v) * 100).toFixed(Math.abs(v) < 0.1 ? 1 : 0)}% too ${v < 0 ? 'small' : 'big'}`;

export function CalibrationDialog({
  show, calibrationInput, setCalibrationInput, onConfirm, onCancel, ptLen = 0, currentScale = null, displayUnit = 'm',
}: CalibrationDialogProps) {
  const [selectedUnit, setSelectedUnit] = useState(displayUnit);
  const toMetres: Record<string, number> = { m: 1, cm: 0.01, mm: 0.001, ft: 0.3048, in: 0.0254 };
  if (!show) return null;

  // On a page that already has a scale, the same gesture checks it against a printed dimension.
  const checking = currentScale != null && currentScale > 0 && ptLen > 0;
  const entered  = parseFloat(calibrationInput);
  const enteredMetres = entered * (toMetres[selectedUnit] ?? 1);
  const displayedLength = ptLen * (currentScale ?? 0) / (toMetres[selectedUnit] ?? 1);
  const check    = checking ? checkScale(ptLen, enteredMetres, currentScale) : null;
  const valid    = !!calibrationInput && !isNaN(entered) && entered > 0;
  const passed   = !!check?.ok;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-amber-400/40 shadow-2xl shadow-amber-400/10 p-6 w-[min(28rem,calc(100vw-2rem))] font-mono">
        <div className="flex items-center gap-2 mb-4">
          <Scaling className="w-4 h-4 text-amber-400 flex-shrink-0" />
          <span className="text-xs font-bold text-amber-400 uppercase tracking-widest">
            {checking ? 'Check Scale' : 'Calibrate Scale'}
          </span>
        </div>
        <p className="text-[11px] text-zinc-400 uppercase tracking-wider mb-4 leading-relaxed">
          {checking ? (
            <>
              This page&apos;s scale reads your line as{' '}
              <span className="text-zinc-100">{displayedLength.toFixed(3)} {selectedUnit}</span>.<br />
              Enter the dimension printed on the drawing in {selectedUnit}.
            </>
          ) : (
            <>
              You drew a line across a known distance.<br />
              Enter the real-world length using the selected unit. The saved calibration remains in meters.
            </>
          )}
        </p>
        <div className="flex gap-2 mb-4">
          <input
            autoFocus
          type="number"
          min="0.001"
          step="any"
          placeholder="e.g. 5"
          value={calibrationInput}
          onChange={e => setCalibrationInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') { if (passed) onCancel(); else if (valid) onConfirm(); }
            if (e.key === 'Escape') onCancel();
          }}
            className="flex-1 bg-zinc-800 border border-zinc-600 focus:border-amber-400 text-zinc-100 text-sm font-mono px-3 py-2 outline-none transition-colors"
          />
          <select
            aria-label="Calibration unit"
            value={selectedUnit}
            onChange={e => {
              setSelectedUnit(e.target.value as 'm' | 'cm' | 'mm' | 'ft' | 'in');
              const next = e.target.value;
              const metres = parseFloat(calibrationInput) * (toMetres[selectedUnit] ?? 1);
              setCalibrationInput(Number.isFinite(metres) ? String(metres / (toMetres[next] ?? 1)) : calibrationInput);
            }}
            className="w-20 bg-zinc-800 border border-zinc-600 focus:border-amber-400 text-zinc-100 text-sm font-mono px-2 py-2 outline-none transition-colors"
          >
            {['m', 'cm', 'mm', 'ft', 'in'].map(unit => <option key={unit} value={unit}>{unit}</option>)}
          </select>
        </div>
        {check && (
          <div
            role="status"
            className={`flex gap-2 border px-3 py-2 mb-4 text-[11px] leading-relaxed ${
              check.ok ? 'border-green-500/40 text-green-400' : 'border-red-500/50 text-red-400'
            }`}
          >
            {check.ok
              ? <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
              : <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />}
            {check.ok ? (
              <span>Scale matches the printed dimension ({pct(check.error)}).</span>
            ) : (
              <span>
                Scale does not match. Lengths on this page read {off(check.error)} and
                areas {off(check.areaError)}. Fixing the scale updates every measurement on this page.
              </span>
            )}
          </div>
        )}
        <div className="flex gap-2">
          {passed ? (
            <button
              onClick={onCancel}
              className="flex-1 bg-amber-400 text-black font-bold text-[11px] uppercase tracking-widest py-2 transition-all hover:bg-amber-300"
            >
              Done
            </button>
          ) : (
            <>
              <button
                onClick={onConfirm}
                disabled={!valid}
                className="flex-1 bg-amber-400 disabled:bg-zinc-700 disabled:text-zinc-500 text-black font-bold text-[11px] uppercase tracking-widest py-2 transition-all hover:bg-amber-300"
              >
                {checking ? 'Fix Scale' : 'Set Scale'}
              </button>
              <button
                onClick={onCancel}
                className="flex-1 border border-zinc-700 text-zinc-400 font-bold text-[11px] uppercase tracking-widest py-2 hover:border-zinc-500 transition-all"
              >
                {checking ? 'Keep Scale' : 'Cancel'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─���─────────────────────────────────────────────��─────────────────────────────
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

'use client';

// ─── components/Viewer/ViewerToolbar.tsx ──────────────────────────────────────
//
// CHANGES vs previous version:
//
//   TOOL GROUPING WITH DIVIDERS
//     VIEWER_TOOLS now carries a `group` field. The toolbar renders a thin
//     vertical divider between each group (selection | area | linear | point)
//     so the user can scan tools by category rather than reading every label.
//
//   DISABLED TOOL STATES
//     Tools with `disabled: true` render at reduced opacity with a "Soon" pill
//     on hover. Clicking them does nothing. This lets you ship the full intended
//     toolbar layout now and enable tools one by one as they're built.
//
//   ADVANCED DROPDOWN — now imports ADVANCED_CANVAS_TOOLS from ViewerConstants
//     The duplicate inline definition is removed. Icons are mapped from a local
//     lookup table so ViewerConstants stays icon-free (no React imports needed
//     there). Disabled tools show a "Soon" badge and cannot be clicked.
//
//   REMOVED onApplyPitchFactor PROP
//     Pitch apply logic now lives entirely inside the standalone
//     AdvancedToolsDropdown.tsx (context-wired). The prop variant is gone.
//
//   tempPointsCount FIXED
//     Now read from toolbarAPI (not hardcoded 0). Polyarc upgrade hint and
//     undo "pop point" label now work correctly.
//
//   KEYBOARD SHORTCUT LEGEND
//     Each tool button tooltip now shows the correct shortcut, including the
//     updated G for polygon.
//
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';
import {
  ZoomIn, ZoomOut, Maximize,
  Undo2, Redo2, Target,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToolType } from '@/types';
import { VIEWER_TOOLS } from './ViewerConstants';
import type { ToolGroup } from './ViewerConstants';
import { useTakeoffData } from '@/context/TakeoffContext';
import { UNIT_OPTIONS } from '@/hooks/measurements/useMeasurements/unitConversion';
import type { DisplayUnit } from '@/hooks/measurements/useMeasurements/unitConversion';
import { AdvancedToolsDropdown } from './AdvancedToolsDropdown';


interface ViewerToolbarProps {
  /**
   * 'vertical' renders only the tools as a narrow rail for the left edge of the
   * drawing (the workspace layout). Drawing aids and zoom then live in the bar
   * under the drawing — see ViewerStatusControls.
   */
  orientation?: 'horizontal' | 'vertical';
  /** Quantity labels on the drawing (toggle shown when provided). */
  showLabels?: boolean;
  setShowLabels?: (v: boolean) => void;
  /** Overlay of the PDF's extracted lines/arcs (toggle shown when provided). */
  showGeometry?: boolean;
  setShowGeometry?: (v: boolean) => void;
  /** Rendered after the zoom controls (e.g. the workspace's "show takeoff panel" button). */
  trailing?: React.ReactNode;
  /** Rendered before the tool buttons (e.g. the workspace's "expand sidebar" button). */
  leading?: React.ReactNode;
  /** Leave out Undo/Redo (the workspace shows them in the page header). */
  hideHistory?: boolean;
  /** Leave out Scale · Unit · Calibrate (shown in the page header instead). */
  hideScale?: boolean;
  activeTool:      ToolType;
  setActiveTool:   (tool: ToolType) => void;
  canUndo:         boolean;
  canRedo:         boolean;
  handleUndo:      () => void;
  handleRedo:      () => void;
  tempPointsCount: number;          // live value — no longer hardcoded 0
  showPins:            boolean;
  setShowPins:         (v: boolean) => void;
  snapEnabled:         boolean;
  setSnapEnabled:      (v: boolean) => void;
  showSnapSettings:    boolean;
  /** Angle lock (0°/45°/90°). Button shown when the setter is provided. */
  orthoEnabled?:       boolean;
  setOrthoEnabled?:    (v: boolean) => void;
  setShowSnapSettings: (v: boolean) => void;
  scaleFactor:       number;
  handleManualScale: () => void;
  analysisStatus:    string;
  analysisPage:      { current: number; total: number } | null;
  currentPageCorners: number;
  scale:       number;
  setScale:    React.Dispatch<React.SetStateAction<number>>;
  fitToScreen: () => void;
  MIN_ZOOM:         number;
  MAX_ZOOM:         number;
  ZOOM_SENSITIVITY: number;
  polyarcMode?:       'line' | 'arc';
  togglePolyarcMode?: () => void;
}

// ─── Toolbar component ────────────────────────────────────────────────────────

// ─── Extracted groups (also placed in the workspace header) ─────────────────

export function HistoryControls({
  canUndo, canRedo, handleUndo, handleRedo, tempPointsCount = 0,
}: {
  canUndo: boolean; canRedo: boolean;
  handleUndo: () => void; handleRedo: () => void;
  tempPointsCount?: number;
}) {
  return (
    <div className="flex items-center gap-1">
    {/* Undo */}
    <button
      onClick={handleUndo}
      disabled={!canUndo}
      className={cn(
        'w-9 h-9 flex items-center justify-center transition-all relative group border',
        canUndo
          ? 'bg-transparent border-transparent text-zinc-500 hover:text-zinc-200 hover:border-zinc-700'
          : 'bg-transparent border-transparent text-zinc-700 cursor-not-allowed',
      )}
      title="Undo (Ctrl+Z)"
      aria-label="Undo"
    >
      <Undo2 className="w-4 h-4" />
      {canUndo && (
        <div className="absolute top-10 transform -translate-x-1/2 left-1/2 px-2 py-1 bg-zinc-900 border border-industrial-border text-[10px] text-zinc-400 invisible group-hover:visible whitespace-nowrap pointer-events-none uppercase tracking-widest font-mono z-50">
          Undo [Ctrl+Z]
          {tempPointsCount > 0 && (
            <span className="text-amber-400 ml-1">· pop point</span>
          )}
        </div>
      )}
    </button>

    {/* Redo */}
    <button
      onClick={handleRedo}
      disabled={!canRedo}
      className={cn(
        'w-9 h-9 flex items-center justify-center transition-all relative group border',
        canRedo
          ? 'bg-transparent border-transparent text-zinc-500 hover:text-zinc-200 hover:border-zinc-700'
          : 'bg-transparent border-transparent text-zinc-700 cursor-not-allowed',
      )}
      title="Redo (Ctrl+Y)"
      aria-label="Redo"
    >
      <Redo2 className="w-4 h-4" />
      {canRedo && (
        <div className="absolute top-10 transform -translate-x-1/2 left-1/2 px-2 py-1 bg-zinc-900 border border-industrial-border text-[10px] text-zinc-400 invisible group-hover:visible whitespace-nowrap pointer-events-none uppercase tracking-widest font-mono z-50">
          Redo [Ctrl+Y]
        </div>
      )}
    </button>
    </div>
  );
}

const SCALE_RATIOS = [1, 2, 5, 10, 20, 25, 50, 75, 100, 125, 200, 250, 500, 1000, 1250, 2500];
/** Long side of ISO paper sizes, in mm. */
const PAPER_LONG_MM: Record<string, number> = { A0: 1189, A1: 841, A2: 594, A3: 420, A4: 297 };
const MM_PER_PT = 25.4 / 72;

/**
 * Metres per PDF point for a drawing at 1:N. If the drawing was drawn for a
 * paper size different from the PDF page (e.g. an A1 sheet printed to A3),
 * the ratio of the long sides corrects for it.
 */
export function presetScaleFactor(ratio: number, paper: string, pageLongPt: number | null): number {
  let fit = 1;
  const target = PAPER_LONG_MM[paper];
  if (target && pageLongPt && pageLongPt > 0) fit = target / (pageLongPt * MM_PER_PT);
  return (ratio * MM_PER_PT * fit) / 1000;
}

function ScalePresets({ pageSizePt, onApply }: {
  pageSizePt: { w: number; h: number } | null | undefined;
  onApply: (factor: number) => void;
}) {
  const [open,  setOpen]  = React.useState(false);
  const [ratio, setRatio] = React.useState(100);
  const [paper, setPaper] = React.useState('actual');
  const boxRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false); };
    const onKey  = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);

  const pageLongPt = pageSizePt ? Math.max(pageSizePt.w, pageSizePt.h) : null;
  const pageLabel = pageLongPt
    ? (Object.entries(PAPER_LONG_MM).find(([, mm]) => Math.abs(mm - pageLongPt * MM_PER_PT) < 8)?.[0] ?? `${Math.round(pageLongPt * MM_PER_PT)} mm`)
    : null;

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        disabled={!pageSizePt}
        title={pageSizePt ? 'Set the scale from the drawing’s stated scale (e.g. 1:100)' : 'Open a drawing first'}
        className="text-[11px] font-mono font-bold uppercase tracking-widest px-2 py-1 border border-industrial-border text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        1:N ▾
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-[80] w-64 bg-industrial-panel border border-industrial-border shadow-2xl p-4 font-mono text-xs text-zinc-300 space-y-3">
          <p className="text-[11px] uppercase tracking-widest text-zinc-500">Scale from the title block</p>
          <label className="flex items-center justify-between gap-2">
            <span>Drawing scale</span>
            <select value={ratio} onChange={e => setRatio(Number(e.target.value))}
              className="bg-stone-900 border border-industrial-border px-2 py-1 text-amber-400 font-bold">
              {SCALE_RATIOS.map(r => <option key={r} value={r}>1:{r}</option>)}
            </select>
          </label>
          <label className="flex items-center justify-between gap-2">
            <span>Drawn for paper</span>
            <select value={paper} onChange={e => setPaper(e.target.value)}
              className="bg-stone-900 border border-industrial-border px-2 py-1 text-amber-400 font-bold">
              <option value="actual">This PDF{pageLabel ? ` (${pageLabel})` : ''}</option>
              {Object.keys(PAPER_LONG_MM).map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <p className="text-[11px] leading-relaxed text-zinc-500">
            Use “Drawn for paper” when the sheet says e.g. “1:100 @ A1” but this PDF is a different size.
            Check one known dimension afterwards.
          </p>
          <button
            type="button"
            onClick={() => { onApply(presetScaleFactor(ratio, paper, pageLongPt)); setOpen(false); }}
            className="w-full bg-amber-400 hover:bg-amber-300 text-black font-bold uppercase tracking-widest py-2 text-[11px]"
          >
            Apply to this page
          </button>
        </div>
      )}
    </div>
  );
}

export function ScaleControls({
  scaleFactor, calibrating, onCalibrate, pageSizePt, onApplyScale,
}: {
  scaleFactor: number; calibrating: boolean; onCalibrate: () => void;
  pageSizePt?: { w: number; h: number } | null;
  onApplyScale?: (factor: number) => void;
}) {
  const { displayUnit, setDisplayUnit } = useTakeoffData();
  return (
    <div className="flex items-center gap-2">
    {/* Scale display */}
    <div className="flex items-center gap-1 border border-industrial-border bg-stone-900 px-2 py-1">
      <span className="text-[11px] font-mono text-zinc-500 uppercase tracking-tighter">Scale:</span>
      <span className="text-[11px] font-mono font-bold text-amber-400 tracking-tighter whitespace-nowrap">
        {scaleFactor === 1 ? 'NOT CALIBRATED' : `1pt = ${scaleFactor.toFixed(4)}m`}
      </span>
    </div>

    {/* Unit selector */}
    <div
      className="flex items-center gap-1 border border-industrial-border bg-stone-900 px-1 py-0.5"
      title="Display unit"
    >
      <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-tighter pl-1">Unit:</span>
      <select
        aria-label="Display unit"
        value={displayUnit}
        onChange={e => setDisplayUnit(e.target.value as DisplayUnit)}
        className="h-6 px-1 text-[11px] font-mono font-bold bg-transparent border-none text-amber-400 focus:outline-none cursor-pointer"
      >
        {UNIT_OPTIONS.map(u => (
          <option key={u.value} value={u.value} className="bg-zinc-900 text-zinc-200">
            {u.label}
          </option>
        ))}
      </select>
    </div>

    {/* Calibration */}
    <button
      onClick={onCalibrate}
      aria-pressed={calibrating}
      title="Set the scale for this page (K)"
      className={cn(
        'text-[11px] font-mono font-bold uppercase tracking-widest px-3 py-1 transition-all border',
        calibrating
          ? 'bg-amber-400 text-black border-amber-400'
          : 'text-amber-400 border-amber-400 hover:bg-amber-400 hover:text-black',
      )}
    >
      CALIBRATE
    </button>
    {onApplyScale && <ScalePresets pageSizePt={pageSizePt} onApply={onApplyScale} />}
    </div>
  );
}

function ViewerToolbarImpl({
  activeTool, setActiveTool,
  canUndo, canRedo, handleUndo, handleRedo, tempPointsCount,
  snapEnabled, setSnapEnabled,
  showSnapSettings, setShowSnapSettings,
  showPins, setShowPins,
  orthoEnabled, setOrthoEnabled,
  scaleFactor, handleManualScale,
  analysisStatus, analysisPage, currentPageCorners,
  scale, setScale, fitToScreen,
  MIN_ZOOM, MAX_ZOOM, ZOOM_SENSITIVITY,
  polyarcMode,
  togglePolyarcMode,
  orientation = 'horizontal',
  hideHistory = false,
  hideScale = false,
  leading,
  trailing,
  showLabels,
  setShowLabels,
  showGeometry,
  setShowGeometry,
}: ViewerToolbarProps) {
  const isAnalyzing = analysisStatus === 'analyzing';

  // Whether switching linear↔arc mid-draw would upgrade to polyarc
  const canUpgradeToPolyarc =
    tempPointsCount > 0 &&
    (activeTool === 'linear' || activeTool === 'arc');

  // Render a divider between tool groups
  const vertical = orientation === 'vertical';
  const divider = (key: string) => (
    <div key={key} className={cn('bg-zinc-700/60 self-center', vertical ? 'h-px w-6 my-1' : 'w-px h-5 mx-0.5')} />
  );
  // Tooltips open under the button in the top bar, beside it in the rail.
  const tipPos = vertical
    ? 'left-11 top-1/2 -translate-y-1/2 text-left'
    : 'top-10 left-1/2 -translate-x-1/2';

  // Build tool buttons with group dividers
  const toolButtons: React.ReactNode[] = [];
  let lastGroup: ToolGroup | null = null;

  VIEWER_TOOLS.forEach((tool, idx) => {
    // Insert divider when group changes (skip before first item)
    if (lastGroup !== null && tool.group !== lastGroup) {
      toolButtons.push(divider(`div-${tool.group}`));
    }
    lastGroup = tool.group;

    const isActive   = activeTool === tool.id;
    const isDisabled = tool.disabled;

    // Tooltip upgrade hint for linear↔arc
    const upgradeHint =
      canUpgradeToPolyarc &&
      ((activeTool === 'linear' && tool.id === 'arc') ||
       (activeTool === 'arc'   && tool.id === 'linear'))
        ? ' → upgrades to Polyarc'
        : '';

    // Active colour per tool family
    const activeClass = isActive
      ? tool.id === 'magic-fill'
        ? 'bg-zinc-800 border-violet-400 text-violet-400'
        : tool.id === 'arc' || tool.id === 'polyarc'
        ? 'bg-zinc-800 border-teal-400 text-teal-400'
        : 'bg-zinc-800 border-amber-400 text-amber-400'
      : 'bg-transparent border-transparent text-zinc-500 hover:text-zinc-200';

    toolButtons.push(
      <button
        key={tool.id}
        onClick={() => {
          if (isDisabled) return;
          setActiveTool(tool.id as ToolType);
        }}
        disabled={isDisabled}
        className={cn(
          'w-9 h-9 flex items-center justify-center transition-all relative group border',
          isDisabled
            ? 'bg-transparent border-transparent text-zinc-700 cursor-not-allowed opacity-40'
            : activeClass,
        )}
        title={`${tool.label} (${tool.shortcut})${upgradeHint}`}
        aria-label={tool.label}
      >
        <tool.icon className="w-4 h-4" />

        {/* Pulse ring for arc/magic-fill */}
        {tool.id === 'arc' && isActive && (
          <span className="absolute inset-0 rounded-sm animate-pulse bg-teal-400/10 pointer-events-none" />
        )}
        {tool.id === 'magic-fill' && isActive && (
          <span className="absolute inset-0 rounded-sm animate-pulse bg-violet-400/10 pointer-events-none" />
        )}

        {/* Tooltip */}
        <div className={cn('absolute transform px-2 py-1 bg-zinc-900 border border-industrial-border text-[10px] text-zinc-400 invisible group-hover:visible group-focus-visible:visible whitespace-nowrap pointer-events-none uppercase tracking-widest font-mono z-[70] shadow-lg', tipPos)}>
          {tool.label} [{tool.shortcut}]{upgradeHint}
          {tool.id === 'arc' && (
            <span className="block text-teal-400 mt-0.5">
              Click 3 points — start, mid, end
            </span>
          )}
          {tool.id === 'magic-fill' && (
            <span className="block text-violet-400 mt-0.5">
              Click inside a closed area to fill
            </span>
          )}
          {tool.id === 'polyarc' && (
            <span className="block text-teal-400 mt-0.5">
              Mixed line + arc segments · press A to toggle
            </span>
          )}
          {upgradeHint && (
            <span className="block text-orange-400 mt-0.5">
              Mid-draw: switches to Polyarc
            </span>
          )}
          {isDisabled && (
            <span className="block text-zinc-500 mt-0.5">Coming soon</span>
          )}
        </div>
      </button>
    );
  });

  if (vertical) {
    return (
      <nav
        aria-label="Measuring tools"
        className="w-12 flex-shrink-0 bg-industrial-panel border-r border-industrial-border flex flex-col items-center gap-0.5 py-2 z-[60] relative"
      >
        {leading}
        {toolButtons}

        {activeTool === 'polyarc' && polyarcMode && togglePolyarcMode && (
          <button
            onClick={togglePolyarcMode}
            className={cn(
              'w-9 h-6 flex items-center justify-center border text-[9px] font-mono font-bold uppercase tracking-wider transition-all',
              polyarcMode === 'arc'
                ? 'border-teal-400 text-teal-400 bg-teal-400/10 hover:bg-teal-400/20'
                : 'border-zinc-500 text-zinc-300 bg-zinc-800 hover:bg-zinc-700',
            )}
            title="Polyarc segment type — click or press A to switch between line and arc"
          >
            {polyarcMode === 'arc' ? 'ARC' : 'LINE'}
          </button>
        )}

        {divider('div-before-advanced')}
        <AdvancedToolsDropdown activeTool={activeTool} setActiveTool={setActiveTool} placement="right" />
        {trailing}
      </nav>
    );
  }

  return (
    <div className="h-12 bg-industrial-panel border-b border-industrial-border flex flex-shrink-0 items-center justify-between px-4 z-30 shadow-sm relative">

      {/* ── Left: tool buttons ── */}
      <div className="flex gap-1 items-center">
        {leading}

        {toolButtons}

        {/* Polyarc mode pill — only when polyarc is active */}
        {activeTool === 'polyarc' && polyarcMode && togglePolyarcMode && (
          <button
            onClick={togglePolyarcMode}
            className={cn(
              'h-6 flex items-center gap-1 px-2 border text-[10px] font-mono font-bold uppercase tracking-widest transition-all ml-1',
              polyarcMode === 'arc'
                ? 'border-teal-400 text-teal-400 bg-teal-400/10 hover:bg-teal-400/20'
                : 'border-zinc-500 text-zinc-300 bg-zinc-800 hover:bg-zinc-700',
            )}
            title="Click or press A to toggle line / arc mode"
          >
            {polyarcMode === 'arc' ? '⌒ ARC' : '— LINE'}
          </button>
        )}

        {divider('div-before-advanced')}

        {/* Advanced tools dropdown — uses standalone context-wired component */}
        <AdvancedToolsDropdown
          activeTool={activeTool}
          setActiveTool={setActiveTool}
        />

        {!hideHistory && (
          <>
            {divider('div-before-undo')}
            <HistoryControls
              canUndo={canUndo} canRedo={canRedo}
              handleUndo={handleUndo} handleRedo={handleRedo}
              tempPointsCount={tempPointsCount}
            />
          </>
        )}
      </div>

      {/* ── Centre: status / config ── */}
      <div className="flex flex-row items-center gap-2 flex-1 justify-center">

        {snapEnabled && isAnalyzing && analysisPage && (
          <div className="flex items-center gap-1.5 border border-blue-500/40 bg-blue-500/10 px-2 py-1">
            <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
            <span className="text-[10px] font-mono text-blue-400 uppercase tracking-widest">
              Analyzing… {analysisPage.current}/{analysisPage.total}
            </span>
          </div>
        )}

        {/* Snap toggle */}
        <button
          onClick={() => setSnapEnabled(!snapEnabled)}
          className={cn(
            'flex items-center gap-1 text-[10px] font-mono font-bold uppercase tracking-widest px-3 py-1 border transition-all',
            snapEnabled
              ? 'bg-green-500/10 border-green-500/50 text-green-400 hover:bg-green-500/20'
              : 'bg-transparent border-zinc-700 text-zinc-500 hover:border-zinc-500',
          )}
          title={`${snapEnabled ? 'Snap on' : 'Snap off'} — toggle with S`}
        >
          {snapEnabled ? 'SNAP ON' : 'SNAP OFF'}
        </button>

        {/* Angle lock */}
        {setOrthoEnabled && (
          <button
            type="button"
            onClick={() => setOrthoEnabled(!orthoEnabled)}
            aria-pressed={!!orthoEnabled}
            className={cn(
              'flex items-center gap-1 text-[10px] font-mono font-bold uppercase tracking-widest px-3 py-1 border transition-all',
              orthoEnabled
                ? 'bg-sky-500/10 border-sky-500/50 text-sky-300 hover:bg-sky-500/20'
                : 'bg-transparent border-zinc-700 text-zinc-500 hover:border-zinc-500',
            )}
            title="Angle lock: keep lines and polygon edges at 0° / 45° / 90° from the last point — toggle with F8. Exact snap points still win."
          >
            {orthoEnabled ? 'ANGLE LOCK ON' : 'ANGLE LOCK'}
          </button>
        )}

        {/* Pins toggle */}
        <button
          onClick={() => setShowPins(!showPins)}
          className={cn(
            'flex items-center gap-1 text-[10px] font-mono font-bold uppercase tracking-widest px-3 py-1 border transition-all',
            showPins
              ? 'bg-blue-500/10 border-blue-500/50 text-blue-400 hover:bg-blue-500/20'
              : 'bg-transparent border-zinc-700 text-zinc-500 hover:border-zinc-500',
          )}
          title={showPins ? 'Pins visible' : 'Pins hidden'}
        >
          <Target className="w-3 h-3" />
          {showPins ? 'PINS ON' : 'PINS OFF'}
        </button>

        {setShowLabels && (
          <button
            type="button"
            onClick={() => setShowLabels(!showLabels)}
            aria-pressed={!!showLabels}
            className={cn(
              'flex items-center gap-1 text-[10px] font-mono font-bold uppercase tracking-widest px-3 py-1 border transition-all',
              showLabels
                ? 'bg-amber-400/10 border-amber-400/50 text-amber-300 hover:bg-amber-400/20'
                : 'bg-transparent border-zinc-700 text-zinc-500 hover:border-zinc-500',
            )}
            title="Show each quantity on the drawing"
          >
            {showLabels ? 'LABELS ON' : 'LABELS OFF'}
          </button>
        )}

        {setShowGeometry && (
          <button
            type="button"
            onClick={() => setShowGeometry(!showGeometry)}
            aria-pressed={!!showGeometry}
            className={cn(
              'flex items-center gap-1 text-[10px] font-mono font-bold uppercase tracking-widest px-3 py-1 border transition-all',
              showGeometry
                ? 'bg-sky-400/10 border-sky-400/50 text-sky-300 hover:bg-sky-400/20'
                : 'bg-transparent border-zinc-700 text-zinc-500 hover:border-zinc-500',
            )}
            title="Show the lines and arcs read from the PDF — what snapping uses"
          >
            {showGeometry ? 'GEOMETRY ON' : 'GEOMETRY OFF'}
          </button>
        )}

        {!hideScale && (
          <>
            <div className="w-px h-4 bg-zinc-700/60 mx-0.5" />
            <ScaleControls
              scaleFactor={scaleFactor}
              calibrating={activeTool === 'scale'}
              onCalibrate={() => setActiveTool('scale')}
            />
          </>
        )}
      </div>

      {/* ── Right: zoom controls ── */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          onClick={() => setScale(s => Math.max(MIN_ZOOM, s - ZOOM_SENSITIVITY))}
          className="p-1.5 text-zinc-500 hover:text-zinc-200 transition-colors"
          title="Zoom out (Ctrl/Cmd –)"
          aria-label="Zoom out"
        >
          <ZoomOut className="w-4 h-4" />
        </button>
        <span className="text-[11px] font-mono text-zinc-400 w-12 text-center font-bold">
          {Math.round(scale * 100)}%
        </span>
        <button
          onClick={() => setScale(s => Math.min(MAX_ZOOM, s + ZOOM_SENSITIVITY))}
          className="p-1.5 text-zinc-500 hover:text-zinc-200 transition-colors"
          title="Zoom in (Ctrl/Cmd +)"
          aria-label="Zoom in"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
        <div className="w-px h-4 bg-industrial-border mx-1" />
        <button
          onClick={fitToScreen}
          className="p-1.5 text-zinc-500 hover:text-zinc-200 transition-colors"
          title="Fit to screen (Ctrl/Cmd 0)"
          aria-label="Fit to screen"
        >
          <Maximize className="w-4 h-4" />
        </button>
        {trailing}
      </div>

    </div>
  );
}

/** Memoized: skips re-rendering when its props are unchanged. */
export const ViewerToolbar = React.memo(ViewerToolbarImpl);

'use client';

// ─── components/Viewer/MagicFillUI.tsx ───────────────────────────────────────
//
//  FIX: fmtArea and fmtPerim previously treated scaleFactor (which is
//  metersPerPixel) as pixelsPerMeter, causing area/perimeter to be displayed
//  as astronomically large numbers.
//
//  scaleFactor = real / ptLen  (e.g. 5m / 200px = 0.025 m/px)
//
//  OLD (wrong):
//    area  = px / (pxPerM * pxPerM)   →  divides by (m/px)² → 1,600× too large
//    perim = px / pxPerM              →  divides by (m/px)  →    40× too large
//
//  NEW (correct):
//    area  = px * metersPerPixel²     →  px × (m/px)² = m²  ✓
//    perim = px * metersPerPixel      →  px × (m/px)  = m   ✓
//
//  All other exports unchanged.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useEffect, useState } from 'react';
import { Eye, EyeOff, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MagicFill } from '@/hooks/fill/useMagicFill';

// ─── Formatters ───────────────────────────────────────────────────────────────
//
// metersPerPixel = scaleFactor passed down from Viewer (real / ptLen).
// To convert pixel measurements to real-world units we MULTIPLY, not divide.

export function fmtArea(px: number, metersPerPixel: number | null): string {
  if (!metersPerPixel) return `${px.toLocaleString()} px²`;
  const m2 = px * metersPerPixel * metersPerPixel;
  return m2 >= 1 ? `${m2.toFixed(2)} m²` : `${(m2 * 1e6).toFixed(0)} mm²`;
}

export function fmtPerim(px: number, metersPerPixel: number | null): string {
  if (!metersPerPixel) return `${px.toLocaleString()} px`;
  const m = px * metersPerPixel;
  return m >= 1 ? `${m.toFixed(2)} m` : `${(m * 100).toFixed(1)} cm`;
}

// ─── MagicFillProgressOverlay ─────────────────────────────────────────────────

interface ProgressOverlayProps {
  active:    boolean;
  message:   string;
  sub?:      string;
  progress?: { done: number; total: number } | null;
}

export function MagicFillProgressOverlay({
  active, message, sub, progress,
}: ProgressOverlayProps) {
  const [dots, setDots] = useState('');

  useEffect(() => {
    if (!active) { setDots(''); return; }
    const id = setInterval(
      () => setDots(d => (d.length >= 3 ? '' : d + '.')),
      350,
    );
    return () => clearInterval(id);
  }, [active]);

  if (!active) return null;

  const pct =
    progress && progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : null;

  return (
    <div
      className="absolute inset-0 z-[80] flex items-center justify-center pointer-events-none"
      style={{ background: 'rgba(10,10,10,0.45)', backdropFilter: 'blur(1px)' }}
    >
      <style>{`
        @keyframes mf-spin   { from { transform: rotate(0deg)  } to { transform: rotate(360deg) } }
        @keyframes mf-pulse  { 0%,100% { opacity:.7 } 50% { opacity:1 } }
      `}</style>

      <div
        className="flex flex-col items-center gap-3.5 px-8 py-5 min-w-[240px]"
        style={{
          background:  '#0d0d0d',
          border:      '1px solid #2a2a2a',
          boxShadow:   '0 8px 40px rgba(0,0,0,.7)',
        }}
      >
        {/* Spinner */}
        <div className="relative w-9 h-9">
          <div className="absolute inset-0 rounded-full" style={{ border: '1.5px solid #1c1c1c' }} />
          <div
            className="absolute inset-0 rounded-full"
            style={{
              border:         '1.5px solid transparent',
              borderTopColor: '#f59e0b',
              animation:      'mf-spin .7s linear infinite',
            }}
          />
          <div
            className="absolute inset-0 flex items-center justify-center text-sm text-amber-400"
            style={{ animation: 'mf-pulse 1.4s ease-in-out infinite' }}
          >
            ⊕
          </div>
        </div>

        {/* Text block */}
        <div className="text-center w-full font-mono">
          <div className="text-[9px] text-zinc-300 uppercase tracking-widest">
            {message}{dots}
          </div>

          {sub && (
            <div className="text-[8px] text-zinc-600 uppercase tracking-wider mt-1">
              {sub}
            </div>
          )}

          {pct !== null && (
            <div className="mt-3 w-full">
              <div
                className="h-[3px] rounded-full overflow-hidden"
                style={{ background: '#1a1a1a' }}
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width:      `${pct}%`,
                    background: 'linear-gradient(90deg,#f59e0b,#fbbf24)',
                    boxShadow:  '0 0 8px rgba(245,158,11,0.6)',
                    transition: 'width 0.15s ease',
                  }}
                />
              </div>
              <div className="text-right text-[8px] text-zinc-600 font-mono mt-1">
                {progress!.done} / {progress!.total}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── MagicFillHoverTooltip ────────────────────────────────────────────────────

interface HoverTooltipProps {
  fill:        MagicFill | null;
  metersPerPixel: number | null;
  holesClosed: Set<number>;
  viewportPos: { x: number; y: number };
}

export function MagicFillHoverTooltip({ fill, metersPerPixel, holesClosed, viewportPos }: HoverTooltipProps) {
  if (!fill) return null;
  return (
    <div
      className="absolute z-[75] pointer-events-none font-mono"
      style={{ left: viewportPos.x + 20, top: viewportPos.y - 10 }}
    >
      <div
        className="flex flex-col gap-2 px-3.5 py-2.5 min-w-[210px]"
        style={{
          background: 'rgba(10,10,10,.97)',
          border:     '1px solid #2a2a2a',
          boxShadow:  '0 4px 24px rgba(0,0,0,.6)',
        }}
      >
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: fill.color }} />
          <span className="text-[8px] text-amber-400 uppercase tracking-widest flex-1">{fill.label}</span>
          {fill.groupId != null && (
            <span className="text-[7px] text-blue-400 border border-blue-400/30 px-0.5">
              G{fill.groupId}
            </span>
          )}
        </div>
        <div className="h-px bg-[#1e1e1e]" />
        <TooltipRow label="Area"      value={fmtArea(fill.areaPx,   metersPerPixel)} sub={`${fill.areaPx.toLocaleString()} px²`} />
        <TooltipRow label="Perimeter" value={fmtPerim(fill.perimPx, metersPerPixel)} sub={`${fill.perimPx.toLocaleString()} px`} />
        <TooltipRow label="Corners"   value={String(fill.polygon.length)}             sub="outer polygon" />
        {holesClosed.has(fill.id) && (
          <div className="flex items-center gap-1.5 pt-1.5 border-t border-[#1e1e1e]">
            <span className="text-[8px] text-emerald-400">⊞</span>
            <span className="text-[7px] text-emerald-400 uppercase tracking-wider">Holes closed</span>
          </div>
        )}
      </div>
    </div>
  );
}

function TooltipRow({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex justify-between items-baseline">
      <span className="text-[8px] text-zinc-600 uppercase tracking-wider">{label}</span>
      <div className="text-right">
        <span className="text-[9px] text-zinc-100 font-bold">{value}</span>
        {sub && <div className="text-[7px] text-zinc-700">{sub}</div>}
      </div>
    </div>
  );
}

// ─── MagicFillGroupPanel ──────────────────────────────────────────────────────

interface GroupPanelProps {
  groupFills:     MagicFill[];
  groupId:        number;
  metersPerPixel: number | null;
  holesClosed:    Set<number>;
}

export function MagicFillGroupPanel({ groupFills, groupId, metersPerPixel, holesClosed }: GroupPanelProps) {
  if (groupFills.length === 0) return null;
  const totalArea  = groupFills.reduce((s, f) => s + f.areaPx,  0);
  const totalPerim = groupFills.reduce((s, f) => s + f.perimPx, 0);
  return (
    <div
      className="absolute bottom-10 right-3 z-[72] pointer-events-none font-mono min-w-[230px]"
      style={{
        background: 'rgba(13,13,13,.95)',
        border:     '1px solid rgba(96,165,250,.4)',
        boxShadow:  '0 4px 24px rgba(0,0,0,.5)',
      }}
    >
      <div className="px-3.5 py-2.5 flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5 text-blue-400">
          <span className="text-sm">⬡</span>
          <span className="text-[8px] uppercase tracking-widest flex-1">
            {groupFills.length} regions · group {groupId}
          </span>
        </div>
        <div className="h-px bg-[#1e1e1e]" />
        <TooltipRow label="Total Area"  value={fmtArea(totalArea,   metersPerPixel)} sub={`${totalArea.toLocaleString()} px²`} />
        <TooltipRow label="Total Perim" value={fmtPerim(totalPerim, metersPerPixel)} sub={`${totalPerim.toLocaleString()} px`} />
        <div className="h-px bg-[#1a1a1a] mt-1" />
        <div className="flex flex-col gap-0.5 mt-0.5">
          {groupFills.map(f => (
            <div key={f.id} className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: f.color }} />
              <span className="text-[7px] text-zinc-600 flex-1 truncate">{f.label}</span>
              <span className="text-[7px] text-zinc-500">{fmtArea(f.areaPx, metersPerPixel)}</span>
              {holesClosed.has(f.id) && <span className="text-[7px] text-emerald-400">⊞</span>}
            </div>
          ))}
        </div>
        {!metersPerPixel && (
          <div className="text-[7px] text-zinc-700 uppercase tracking-wider mt-1 pt-1.5 border-t border-[#181818] leading-relaxed">
            Set calibration for real-world units
          </div>
        )}
      </div>
    </div>
  );
}

// ─── MagicFillSelectedPanel ───────────────────────────────────────────────────

interface SelectedPanelProps {
  fill:           MagicFill;
  metersPerPixel: number | null;
  holesClosed:    Set<number>;
}

export function MagicFillSelectedPanel({ fill, metersPerPixel, holesClosed }: SelectedPanelProps) {
  return (
    <div
      className="absolute bottom-10 right-3 z-[72] pointer-events-none font-mono min-w-[210px]"
      style={{
        background: 'rgba(13,13,13,.95)',
        border:     '1px solid #2a2a2a',
        boxShadow:  '0 4px 24px rgba(0,0,0,.5)',
      }}
    >
      <div className="px-3.5 py-2.5 flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-sm" style={{ background: fill.color }} />
          <span className="text-[8px] text-amber-400 uppercase tracking-widest flex-1">{fill.label}</span>
          <span className="text-[7px] text-zinc-600">selected</span>
        </div>
        <div className="h-px bg-[#1e1e1e]" />
        <TooltipRow label="Area"      value={fmtArea(fill.areaPx,   metersPerPixel)} sub={`${fill.areaPx.toLocaleString()} px²`} />
        <TooltipRow label="Perimeter" value={fmtPerim(fill.perimPx, metersPerPixel)} sub={`${fill.perimPx.toLocaleString()} px`} />
        <TooltipRow label="Corners"   value={String(fill.polygon.length)}             sub="outer polygon" />
        {holesClosed.has(fill.id) && (
          <div className="flex items-center gap-1.5 pt-1.5 border-t border-[#1e1e1e]">
            <span className="text-[8px] text-emerald-400">⊞</span>
            <span className="text-[7px] text-emerald-400 uppercase tracking-wider">Holes closed</span>
          </div>
        )}
        {!metersPerPixel && (
          <div className="text-[7px] text-zinc-700 uppercase tracking-wider mt-0.5 pt-1.5 border-t border-[#181818] leading-relaxed">
            Set calibration for real-world units
          </div>
        )}
      </div>
    </div>
  );
}

// ─── MagicFillSidebar ─────────────────────────────────────────────────────────

interface MagicFillSidebarProps {
  fills:          MagicFill[];
  hiddenIds:      Set<number>;
  selectedId:     number | null;
  selectedGroup:  number | null;
  metersPerPixel: number | null;
  holesClosed:    Set<number>;
  canUndo:        boolean;
  onSelect:       (id: number) => void;
  onToggleHide:   (id: number) => void;
  onDelete:       (id: number) => void;
  onFillHoles:    (id: number) => void;
  onUndo:         () => void;
  onClear:        () => void;
}

export function MagicFillSidebar({
  fills, hiddenIds, selectedId, selectedGroup, metersPerPixel, holesClosed,
  canUndo, onSelect, onToggleHide, onDelete, onFillHoles, onUndo, onClear,
}: MagicFillSidebarProps) {
  const groupFills = selectedGroup != null
    ? fills.filter(f => f.groupId === selectedGroup)
    : [];

  return (
    <div className="w-56 bg-[#0f0f0f] border-l border-[#1e1e1e] flex flex-col flex-shrink-0 overflow-hidden font-mono">

      {/* Header */}
      <div className="px-3 py-2 border-b border-[#1a1a1a] flex items-center justify-between">
        <span className="text-[9px] text-[#3a3a3a] uppercase tracking-widest">
          Fills ({fills.length})
        </span>
        <div className="flex gap-1">
          {canUndo && (
            <button
              onClick={onUndo}
              className="text-[8px] text-[#555] hover:text-[#aaa] uppercase tracking-wider px-1 border border-[#222] hover:border-[#444] transition-colors"
            >
              ↩ Undo
            </button>
          )}
          {fills.length > 0 && (
            <button
              onClick={onClear}
              className="text-[8px] text-[#f87171] hover:text-[#f87171]/80 uppercase tracking-wider px-1 border border-[#2a1a1a] hover:border-[#f87171]/40 transition-colors"
            >
              ✕ Clear
            </button>
          )}
        </div>
      </div>

      {/* Totals */}
      {fills.length > 0 && (
        <div className="px-3 py-2 border-b border-[#1a1a1a]">
          <p className="text-[7px] text-[#2e2e2e] uppercase tracking-widest mb-1.5">Total</p>
          <SidebarRow label="Area"  value={fmtArea(fills.reduce((s, f) => s + f.areaPx,  0), metersPerPixel)} />
          <SidebarRow label="Perim" value={fmtPerim(fills.reduce((s, f) => s + f.perimPx, 0), metersPerPixel)} />
        </div>
      )}

      {/* Group summary */}
      {selectedGroup != null && groupFills.length > 0 && (
        <div className="px-3 py-2 border-b border-blue-400/20 bg-blue-400/[0.02]">
          <p className="text-[7px] text-blue-400 uppercase tracking-widest mb-1.5">
            Group {selectedGroup} · {groupFills.length} regions
          </p>
          <SidebarRow label="Area"  value={fmtArea(groupFills.reduce((s, f) => s + f.areaPx,  0), metersPerPixel)} />
          <SidebarRow label="Perim" value={fmtPerim(groupFills.reduce((s, f) => s + f.perimPx, 0), metersPerPixel)} />
        </div>
      )}

      {/* Fill list */}
      <div className="flex-1 overflow-y-auto p-1.5 flex flex-col gap-1">
        {fills.length === 0 ? (
          <p className="text-[8px] text-[#2a2a2a] text-center uppercase tracking-widest p-6 leading-loose">
            Click to fill a room<br />Drag to batch fill
          </p>
        ) : fills.map(f => {
          const isGrouped = f.groupId != null;
          const isInSel   =
            f.id === selectedId ||
            (selectedGroup != null && f.groupId === selectedGroup);
          return (
            <div
              key={f.id}
              onClick={() => onSelect(f.id)}
              className={cn(
                'border px-2 py-1.5 cursor-pointer transition-colors',
                isInSel
                  ? isGrouped
                    ? 'border-blue-400/40 bg-blue-400/[0.04]'
                    : 'border-amber-400/40 bg-amber-400/[0.04]'
                  : 'border-[#1e1e1e] hover:border-[#333]',
                hiddenIds.has(f.id) ? 'opacity-35' : '',
              )}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: f.color }} />
                <span className="text-[8px] text-[#777] flex-1 truncate">{f.label}</span>
                {isGrouped && (
                  <span className="text-[7px] text-blue-400 border border-blue-400/30 px-0.5">
                    G{f.groupId}
                  </span>
                )}
                <button
                  title="Close interior holes"
                  onClick={e => { e.stopPropagation(); onFillHoles(f.id); }}
                  className={cn(
                    'text-[9px] transition-colors p-px',
                    holesClosed.has(f.id)
                      ? 'text-emerald-400'
                      : 'text-[#333] hover:text-emerald-400',
                  )}
                >⊞</button>
                <button
                  title="Toggle visibility"
                  onClick={e => { e.stopPropagation(); onToggleHide(f.id); }}
                  className="text-[#444] hover:text-[#aaa] transition-colors p-px"
                >
                  {hiddenIds.has(f.id) ? <EyeOff className="w-2.5 h-2.5" /> : <Eye className="w-2.5 h-2.5" />}
                </button>
                <button
                  title="Delete fill"
                  onClick={e => { e.stopPropagation(); onDelete(f.id); }}
                  className="text-[#444] hover:text-[#f87171] transition-colors p-px"
                >
                  <Trash2 className="w-2.5 h-2.5" />
                </button>
              </div>
              <div className="pl-4 flex flex-col gap-0.5">
                <SidebarRow label="Area"    value={fmtArea(f.areaPx,   metersPerPixel)} />
                <SidebarRow label="Perim"   value={fmtPerim(f.perimPx, metersPerPixel)} />
                <SidebarRow label="Corners" value={String(f.polygon.length)} />
                {holesClosed.has(f.id) && (
                  <div className="flex items-center gap-1 mt-0.5">
                    <span className="text-[7px] text-emerald-400">⊞ holes closed</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {!metersPerPixel && fills.length > 0 && (
        <div className="px-3 py-2 border-t border-[#1a1a1a]">
          <p className="text-[7px] text-[#2a2a2a] uppercase tracking-widest leading-relaxed">
            Use Draw Calibration for real-world units
          </p>
        </div>
      )}
    </div>
  );
}

function SidebarRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-baseline">
      <span className="text-[7px] text-[#333] uppercase">{label}</span>
      <span className="text-[7px] text-[#888]">{value}</span>
    </div>
  );
}
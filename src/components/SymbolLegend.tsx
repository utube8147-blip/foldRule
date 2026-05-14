// components/SymbolLegend.tsx
//
// Sidebar panel showing auto-detected symbol clusters.
// Clicking a row selects/deselects that cluster.
// Industrial aesthetic to match the existing ViewerCanvas UI.

'use client';

import React from 'react';
import { Layers, ChevronRight, X, Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SymbolCluster } from '@/lib/symbolClusterer';
import type { UseSymbolSelectionReturn } from '@/hooks/useSymbolSelection';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SymbolLegendProps {
  clusters: SymbolCluster[];
  selection: UseSymbolSelectionReturn;
  /** Whether the legend panel is visible */
  visible: boolean;
  onClose: () => void;
  /** Called when user renames a cluster label */
  onRenameCluster?: (clusterId: string, newLabel: string) => void;
  className?: string;
}

// ─── Fingerprint mini-preview ─────────────────────────────────────────────────

function ClusterPreview({
  cluster,
  size = 32,
}: {
  cluster: SymbolCluster;
  size?: number;
}) {
  const fp = cluster.centroidFingerprint;

  // Draw a simple SVG preview based on fingerprint characteristics
  const isCircular = fp.circularity > 0.7;
  const isArc      = fp.hasArc;
  const isRect     = fp.aspectRatio > 0.6 && fp.aspectRatio < 1.8 && !isCircular;
  const isWide     = fp.aspectRatio >= 1.8;
  const isTall     = fp.aspectRatio <= 0.55;

  const pad = 4;
  const w   = size - pad * 2;
  const h   = size - pad * 2;
  const cx  = size / 2;
  const cy  = size / 2;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="flex-shrink-0">
      {isCircular && (
        <circle cx={cx} cy={cy} r={w / 2 - 1} fill="none" stroke={cluster.color} strokeWidth="1.5" />
      )}
      {isArc && !isCircular && (
        <>
          <path
            d={`M ${pad} ${cy} Q ${cx} ${pad} ${size - pad} ${cy}`}
            fill="none" stroke={cluster.color} strokeWidth="1.5"
          />
          <line x1={pad} y1={cy} x2={pad} y2={cy + h / 3} stroke={cluster.color} strokeWidth="1.5" />
          <line x1={size - pad} y1={cy} x2={size - pad} y2={cy + h / 3} stroke={cluster.color} strokeWidth="1.5" />
        </>
      )}
      {isWide && (
        <rect x={pad} y={cy - h / 4} width={w} height={h / 2} fill="none" stroke={cluster.color} strokeWidth="1.5" rx="1" />
      )}
      {isTall && (
        <rect x={cx - w / 4} y={pad} width={w / 2} height={h} fill="none" stroke={cluster.color} strokeWidth="1.5" rx="1" />
      )}
      {isRect && !isWide && !isTall && (
        <rect x={pad + 2} y={pad + 2} width={w - 4} height={h - 4} fill="none" stroke={cluster.color} strokeWidth="1.5" rx="1" />
      )}
    </svg>
  );
}

// ─── Editable label ───────────────────────────────────────────────────────────

function EditableLabel({
  value,
  onChange,
  color,
}: {
  value: string;
  onChange: (v: string) => void;
  color: string;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft]     = React.useState(value);
  const inputRef              = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) onChange(trimmed);
    else setDraft(value);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(value); setEditing(false); } }}
        onClick={e => e.stopPropagation()}
        className="bg-transparent border-b font-mono text-[11px] font-bold uppercase tracking-widest outline-none w-full"
        style={{ color, borderColor: color }}
      />
    );
  }

  return (
    <span
      className="font-mono text-[11px] font-bold uppercase tracking-widest cursor-text hover:underline underline-offset-2 truncate"
      style={{ color }}
      title="Click to rename"
      onClick={e => { e.stopPropagation(); setEditing(true); setDraft(value); }}
    >
      {value}
    </span>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SymbolLegend({
  clusters,
  selection,
  visible,
  onClose,
  onRenameCluster,
  className,
}: SymbolLegendProps) {
  const [hiddenClusters, setHiddenClusters] = React.useState<Set<string>>(new Set());

  const toggleHide = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setHiddenClusters(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  if (!visible) return null;

  return (
    <div
      className={cn(
        'flex flex-col bg-zinc-950 border border-zinc-800 shadow-2xl',
        'w-64 max-h-[calc(100vh-8rem)] overflow-hidden',
        className,
      )}
    >
      {/* ── Header ── */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 bg-zinc-900 flex-shrink-0">
        <div className="flex items-center gap-2">
          <Layers className="w-3.5 h-3.5 text-amber-400" />
          <span className="font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-zinc-300">
            Detected Symbols
          </span>
        </div>
        <button
          onClick={onClose}
          className="text-zinc-600 hover:text-zinc-300 transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* ── Cluster count summary ── */}
      <div className="px-3 py-2 border-b border-zinc-800/50 flex-shrink-0">
        <p className="font-mono text-[9px] text-zinc-500 uppercase tracking-widest">
          {clusters.length === 0
            ? 'No repeating symbols found'
            : `${clusters.length} group${clusters.length > 1 ? 's' : ''} · ${clusters.reduce((s, c) => s + c.members.length, 0)} instances`}
        </p>
        {selection.selectedCluster && (
          <button
            onClick={selection.clearSelection}
            className="mt-1 font-mono text-[9px] text-amber-400 hover:text-amber-300 uppercase tracking-widest flex items-center gap-1"
          >
            <X className="w-2.5 h-2.5" />
            Clear selection
          </button>
        )}
      </div>

      {/* ── Cluster list ── */}
      <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-800">
        {clusters.length === 0 && (
          <div className="px-3 py-8 text-center">
            <p className="font-mono text-[10px] text-zinc-600 leading-relaxed">
              Load an SVG floor plan to<br />auto-detect repeating symbols.
            </p>
          </div>
        )}

        {clusters.map(cluster => {
          const isSelected = selection.selectedClusterId === cluster.id;
          const isHidden   = hiddenClusters.has(cluster.id);

          return (
            <div
              key={cluster.id}
              onClick={() => selection.handleClusterSelect(cluster.id)}
              className={cn(
                'group flex items-center gap-2.5 px-3 py-2.5 cursor-pointer transition-all',
                'border-b border-zinc-800/40 last:border-0',
                isSelected
                  ? 'bg-zinc-800/80'
                  : 'hover:bg-zinc-900/80',
                isHidden && 'opacity-40',
              )}
            >
              {/* Color swatch + preview */}
              <div className="relative flex-shrink-0">
                <ClusterPreview cluster={cluster} size={28} />
                {/* Dot indicator */}
                <div
                  className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full border border-zinc-950"
                  style={{ backgroundColor: cluster.color }}
                />
              </div>

              {/* Label + count */}
              <div className="flex-1 min-w-0">
                {onRenameCluster ? (
                  <EditableLabel
                    value={cluster.label}
                    onChange={v => onRenameCluster(cluster.id, v)}
                    color={isSelected ? cluster.color : '#a1a1aa'}
                  />
                ) : (
                  <span
                    className="font-mono text-[11px] font-bold uppercase tracking-widest truncate block"
                    style={{ color: isSelected ? cluster.color : '#a1a1aa' }}
                  >
                    {cluster.label}
                  </span>
                )}
                <span className="font-mono text-[9px] text-zinc-600 uppercase tracking-widest">
                  {cluster.members.length} instance{cluster.members.length !== 1 ? 's' : ''}
                </span>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={e => toggleHide(cluster.id, e)}
                  className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-zinc-300 transition-all"
                  title={isHidden ? 'Show' : 'Hide'}
                >
                  {isHidden
                    ? <EyeOff className="w-3 h-3" />
                    : <Eye    className="w-3 h-3" />}
                </button>
                <ChevronRight
                  className={cn(
                    'w-3 h-3 transition-transform',
                    isSelected ? 'rotate-90 text-amber-400' : 'text-zinc-700 group-hover:text-zinc-500',
                  )}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Footer hint ── */}
      {clusters.length > 0 && (
        <div className="px-3 py-2 border-t border-zinc-800/50 flex-shrink-0">
          <p className="font-mono text-[9px] text-zinc-600 leading-relaxed">
            Click row or canvas instance<br />to select all in group.
          </p>
        </div>
      )}
    </div>
  );
}
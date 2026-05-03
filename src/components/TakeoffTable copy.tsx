// components/TakeoffTable.tsx
import React, { useState, useEffect, useRef } from 'react';
import {
  Trash2, Plus, Pencil, Eye, EyeOff,
  ChevronDown, ChevronRight, FolderOpen, Package,
  Maximize2, Minimize2, AlertTriangle, RefreshCw,
  BarChart2, CheckSquare, RotateCcw,
} from 'lucide-react';
import { cn, formatCurrency } from '../lib/utils';
import { TakeoffRow, MaterialSpec } from '../types';

interface TakeoffTableProps {
  measurements: TakeoffRow[];
  materials: MaterialSpec[];
  onUpdate: (id: string, updates: Partial<TakeoffRow>) => void;
  onDelete: (id: string) => void;
  onAddManual: () => void;
  onToggleVisibility: (id?: string) => void;
  /** Pass the current project name so the overlay header can display it */
  projectName?: string;
  /** Pass current project number / version string */
  projectNumber?: string;
}

export function TakeoffTable({
  measurements,
  materials,
  onUpdate,
  onDelete,
  onAddManual,
  onToggleVisibility,
  projectName = 'Untitled Project',
  projectNumber = '',
}: TakeoffTableProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [isOverlay, setIsOverlay] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);

  // Close overlay on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOverlay) setIsOverlay(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOverlay]);

  /* ─── data organisation ──────────────────────────────────────── */
  const organizedData = React.useMemo(() => {
    const groups = new Map<string, { header: TakeoffRow; items: TakeoffRow[] }>();
    const ungrouped: TakeoffRow[] = [];
    measurements.forEach((m) => {
      if (m.isGroupHeader && m.groupId) {
        groups.set(m.groupId, { header: m, items: [] });
      } else if (m.groupId && groups.has(m.groupId)) {
        groups.get(m.groupId)!.items.push(m);
      } else if (!m.isGroupHeader) {
        ungrouped.push(m);
      }
    });
    return { groups, ungrouped };
  }, [measurements]);

  const toggleGroup = (groupId: string) =>
    setExpandedGroups((prev) => {
      const s = new Set(prev);
      s.has(groupId) ? s.delete(groupId) : s.add(groupId);
      return s;
    });

  const groupTotal = (items: TakeoffRow[], mode: 'cost' | 'qty' = 'cost') =>
    items.reduce((sum, i) => sum + (mode === 'qty' ? i.quantity : i.quantity * i.unitRate), 0);

  const totalCost = measurements.reduce((s, m) => s + m.quantity * m.unitRate, 0);
  const totalQty  = measurements.reduce((s, m) => s + m.quantity, 0);
  const allVisible = measurements.every((m) => m.isVisible !== false);

  // Flagged = rows whose quantity has been overridden (changed from preset)
  const flaggedRows = measurements.filter((m) => m.isOverridden && !m.isGroupHeader);

  /* ─── inline cell editor ─────────────────────────────────────── */
  const renderCell = (
    row: TakeoffRow,
    field: keyof TakeoffRow,
    type: 'text' | 'number' | 'material' = 'text',
    compact = false,
  ) => {
    const isEditing = editingId === row.id && editingField === field;
    const value = row[field];

    if (isEditing) {
      if (type === 'material') {
        return (
          <select
            autoFocus
            defaultValue={value as string}
            onBlur={(e) => {
              const val = e.target.value;
              const mat = materials.find((m) => m.name === val);
              if (mat) {
                onUpdate(row.id, {
                  description: mat.name,
                  unitRate: mat.materialCost + mat.laborCost + mat.equipmentCost,
                  unit: mat.unit,
                });
              } else {
                onUpdate(row.id, { description: val });
              }
              setEditingId(null); setEditingField(null);
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            className="w-full bg-stone-900 border border-amber-accent text-[11px] font-mono p-1 outline-none text-zinc-200"
          >
            <option value={value as string}>{value}</option>
            {materials.map((m) => (
              <option key={m.id} value={m.name}>
                {m.code} – {m.name} ({formatCurrency(m.materialCost + m.laborCost + m.equipmentCost)}/{m.unit})
              </option>
            ))}
          </select>
        );
      }
      return (
        <input
          autoFocus
          type={type}
          defaultValue={value as string | number}
          onBlur={(e) => {
            const val = type === 'number' ? parseFloat(e.target.value) : e.target.value;
            onUpdate(row.id, { [field]: val });
            setEditingId(null); setEditingField(null);
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          className="w-full bg-stone-900 border border-amber-accent text-[11px] font-mono p-1 outline-none text-zinc-200"
        />
      );
    }

    return (
      <div
        onClick={() => { if (!row.isGroupHeader) { setEditingId(row.id); setEditingField(field); } }}
        className={cn(
          'cursor-text hover:text-amber-accent transition-colors truncate min-h-[16px] w-full',
          row.isGroupHeader && 'cursor-default',
          compact && 'text-[13px]',
        )}
      >
        {type === 'number' && typeof value === 'number' ? value.toFixed(2) : (value as string)}
      </div>
    );
  };

  /* ─── shared table head ──────────────────────────────────────── */
  const TableHead = ({ compact = false }: { compact?: boolean }) => (
    <thead className="bg-stone-900/80 sticky top-0 z-10">
      <tr className={cn(
        'border-b border-industrial-border text-zinc-500 uppercase tracking-tighter',
        compact ? 'text-[11px]' : 'text-[10px]',
      )}>
        <th className={cn('text-center border-r border-industrial-border w-8', compact ? 'p-3' : 'p-2')}>#</th>
        <th className={cn('border-r border-industrial-border', compact ? 'p-3' : 'p-2')}>Description</th>
        <th className={cn('border-r border-industrial-border text-right', compact ? 'p-3' : 'p-2')}>Qty</th>
        <th className={cn('border-r border-industrial-border', compact ? 'p-3' : 'p-2')}>Unit</th>
        <th className={cn('border-r border-industrial-border text-right', compact ? 'p-3' : 'p-2')}>Rate</th>
        <th className={cn('border-r border-industrial-border text-right', compact ? 'p-3' : 'p-2')}>Total</th>
        <th className={cn('text-center w-16', compact ? 'p-3' : 'p-2')}>Actions</th>
      </tr>
    </thead>
  );

  /* ─── shared table body ──────────────────────────────────────── */
  const TableBody = ({ compact = false }: { compact?: boolean }) => (
    <tbody className="divide-y divide-industrial-border">
      {/* Groups */}
      {Array.from(organizedData.groups.entries()).map(([groupId, { header, items }], gIdx) => {
        const expanded = expandedGroups.has(groupId);
        return (
          <React.Fragment key={groupId}>
            <tr
              className="border-t border-amber-500/20 bg-[#1a1a1a] cursor-pointer hover:bg-[#222] transition-colors group"
              onClick={() => toggleGroup(groupId)}
            >
              <td className={cn('border-r border-industrial-border text-amber-500 font-bold text-center', compact ? 'p-3' : 'p-2')}>
                {gIdx + 1}
              </td>
              <td className={cn('border-r border-industrial-border', compact ? 'p-3' : 'p-2')}>
                <div className="flex items-center gap-2">
                  {expanded
                    ? <ChevronDown className="w-3 h-3 text-amber-500 shrink-0" />
                    : <ChevronRight className="w-3 h-3 text-amber-500 shrink-0" />}
                  <FolderOpen className="w-3 h-3 text-amber-500/60 shrink-0" />
                  <span className={cn('font-bold text-amber-500 uppercase tracking-wider', compact ? 'text-[13px]' : 'text-[11px]')}>
                    {header.groupName}
                  </span>
                  <span className="text-[8px] text-zinc-600 ml-1">({items.length} items)</span>
                </div>
              </td>
              <td className={cn('border-r border-industrial-border text-right', compact ? 'p-3' : 'p-2')}>
                <span className={cn('font-mono text-amber-400', compact ? 'text-[13px]' : 'text-[11px]')}>
                  {groupTotal(items, 'qty').toFixed(1)}
                </span>
              </td>
              <td className={cn('border-r border-industrial-border', compact ? 'p-3' : 'p-2')}>
                <span className="text-[9px] text-zinc-600">assembly</span>
              </td>
              <td className={cn('border-r border-industrial-border text-right', compact ? 'p-3' : 'p-2')}>
                <span className="text-zinc-500">—</span>
              </td>
              <td className={cn('text-right border-r border-industrial-border font-bold text-amber-500', compact ? 'p-3 text-[14px]' : 'p-2')}>
                {formatCurrency(groupTotal(items))}
              </td>
              <td className={cn('text-center', compact ? 'p-3' : 'p-2')}>
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(header.id); }}
                  className="text-zinc-700 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </td>
            </tr>

            {expanded && items.map((item, iIdx) => {
              const isFlagged = item.isOverridden;
              return (
                <tr
                  key={item.id}
                  className={cn(
                    'border-t transition-colors group/item',
                    isFlagged
                      ? 'border-amber-900/30 bg-amber-500/5 hover:bg-amber-500/10'
                      : 'border-[#1a1a1a] hover:bg-stone-900/50',
                  )}
                >
                  <td className={cn('text-center border-r border-industrial-border', compact ? 'p-3' : 'p-2')}>
                    {isFlagged
                      ? <AlertTriangle className="w-3 h-3 text-amber-500 mx-auto" />
                      : <span className="text-zinc-600 text-[9px]">{gIdx + 1}.{iIdx + 1}</span>}
                  </td>
                  <td className={cn('border-r border-industrial-border', compact ? 'p-3 pl-9' : 'p-2 pl-7')}>
                    <div className="flex items-center gap-2">
                      <Package className="w-2.5 h-2.5 text-zinc-600 shrink-0" />
                      <div className="flex flex-col flex-1 min-w-0">
                        <div className={cn('text-zinc-300', compact ? 'text-[13px]' : 'text-[10px]')}>
                          {renderCell(item, 'description', item.category === 'Board Materials' ? 'material' : 'text', compact)}
                        </div>
                        {item.notes && (
                          <div className="text-[7px] text-zinc-600 font-mono truncate">{item.notes}</div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className={cn('border-r border-industrial-border text-right', compact ? 'p-3' : 'p-2')}>
                    <div className="flex justify-end items-center gap-1">
                      <span className={cn(isFlagged ? 'text-amber-500 font-bold' : '')}>
                        {renderCell(item, 'quantity', 'number', compact)}
                      </span>
                      {item.isOverridden && <Pencil className="w-2 h-2 text-amber-accent/60" />}
                    </div>
                  </td>
                  <td className={cn('border-r border-industrial-border text-zinc-500', compact ? 'p-3' : 'p-2')}>
                    {renderCell(item, 'unit', 'text', compact)}
                  </td>
                  <td className={cn('border-r border-industrial-border text-right', compact ? 'p-3' : 'p-2')}>
                    {renderCell(item, 'unitRate', 'number', compact)}
                  </td>
                  <td className={cn(
                    'text-right border-r border-industrial-border font-bold',
                    isFlagged ? 'text-amber-500' : 'text-zinc-300',
                    compact ? 'p-3 text-[14px]' : 'p-2',
                  )}>
                    {(item.quantity * item.unitRate).toFixed(2)}
                  </td>
                  <td className={cn('text-center', compact ? 'p-3' : 'p-2')}>
                    <div className="flex items-center justify-center gap-2">
                      <label className="cursor-pointer">
                        <input type="color" value={item.color || '#EF9F27'}
                          onChange={(e) => onUpdate(item.id, { color: e.target.value })}
                          className="opacity-0 w-0 h-0 absolute pointer-events-none" />
                        <div className="w-3 h-3 rounded-full hover:scale-110 transition-transform"
                          style={{ backgroundColor: item.color || '#EF9F27' }} />
                      </label>
                      <button onClick={() => onToggleVisibility(item.id)}
                        className={cn('transition-colors',
                          item.isVisible !== false ? 'text-zinc-500 hover:text-amber-accent' : 'text-zinc-700 hover:text-amber-accent')}>
                        {item.isVisible !== false ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                      </button>
                      <button onClick={() => onDelete(item.id)}
                        className="text-zinc-700 hover:text-red-500 transition-colors opacity-0 group-hover/item:opacity-100">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}

            {expanded && items.length > 0 && (
              <tr className="bg-[#111] border-t border-[#1e1e1e]">
                <td colSpan={7} className="p-1.5 px-3 text-right">
                  <div className="flex items-center justify-end gap-3 text-[8px] text-zinc-600 font-mono">
                    <span>Subtotal: {formatCurrency(groupTotal(items))}</span>
                    <span className="w-px h-2 bg-zinc-700" />
                    <span>+10% waste: {formatCurrency(groupTotal(items) * 0.1)}</span>
                    <span className="w-px h-2 bg-zinc-700" />
                    <span className="text-amber-500">Total: {formatCurrency(groupTotal(items) * 1.1)}</span>
                  </div>
                </td>
              </tr>
            )}
          </React.Fragment>
        );
      })}

      {/* Ungrouped rows */}
      {organizedData.ungrouped.map((row, idx) => {
        const isFlagged = row.isOverridden;
        return (
          <tr
            key={row.id}
            className={cn(
              'border-t transition-colors group',
              isFlagged
                ? 'border-amber-900/30 bg-amber-500/5 hover:bg-amber-500/10'
                : 'border-industrial-border hover:bg-stone-900/50',
            )}
          >
            <td className={cn('text-center border-r border-industrial-border', compact ? 'p-3' : 'p-2')}>
              {isFlagged
                ? <AlertTriangle className="w-3 h-3 text-amber-500 mx-auto" />
                : <span className="text-zinc-600 font-bold text-[9px]">
                    {(organizedData.groups.size + idx + 1).toString().padStart(2, '0')}
                  </span>}
            </td>
            <td className={cn('border-r border-industrial-border font-medium text-zinc-200', compact ? 'p-3' : 'p-2')}>
              <div className="flex flex-col">
                {renderCell(row, 'description', 'material', compact)}
                {row.notes && <div className="text-[7px] text-zinc-600 font-mono">{row.notes}</div>}
              </div>
            </td>
            <td className={cn('border-r border-industrial-border text-right', isFlagged ? 'text-amber-500 font-bold' : 'text-amber-accent font-bold', compact ? 'p-3' : 'p-2')}>
              <div className="flex justify-end items-center gap-1">
                {renderCell(row, 'quantity', 'number', compact)}
                {row.isOverridden && <Pencil className="w-2.5 h-2.5 text-amber-accent/60" />}
              </div>
            </td>
            <td className={cn('border-r border-industrial-border text-zinc-500', compact ? 'p-3' : 'p-2')}>
              {renderCell(row, 'unit', 'text', compact)}
            </td>
            <td className={cn('border-r border-industrial-border text-right text-zinc-500', compact ? 'p-3' : 'p-2')}>
              {renderCell(row, 'unitRate', 'number', compact)}
            </td>
            <td className={cn(
              'text-right border-r border-industrial-border font-bold',
              isFlagged ? 'text-amber-500' : 'text-zinc-200',
              compact ? 'p-3 text-[14px]' : 'p-2',
            )}>
              {(row.quantity * row.unitRate).toFixed(2)}
            </td>
            <td className={cn('text-center', compact ? 'p-3' : 'p-2')}>
              <div className="flex items-center justify-center gap-2">
                <label className="cursor-pointer">
                  <input type="color" value={row.color || '#EF9F27'}
                    onChange={(e) => onUpdate(row.id, { color: e.target.value })}
                    className="opacity-0 w-0 h-0 absolute pointer-events-none" />
                  <div className="w-3 h-3 rounded-full hover:scale-110 transition-transform"
                    style={{ backgroundColor: row.color || '#EF9F27' }} />
                </label>
                <button onClick={() => onToggleVisibility(row.id)}
                  className={cn('transition-colors',
                    row.isVisible !== false ? 'text-zinc-500 hover:text-amber-accent' : 'text-zinc-700 hover:text-amber-accent')}>
                  {row.isVisible !== false ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                </button>
                <button onClick={() => onDelete(row.id)}
                  className="text-zinc-700 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100">
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </td>
          </tr>
        );
      })}

      {measurements.length === 0 && (
        <tr>
          <td colSpan={7} className="p-12 text-center text-zinc-700 uppercase tracking-widest leading-loose">
            No active measurements.<br />Click canvas tools to begin.
          </td>
        </tr>
      )}
    </tbody>
  );

  /* ─── shared footer ──────────────────────────────────────────── */
  const TableFooter = ({ compact = false }: { compact?: boolean }) => (
    <div className={cn('bg-stone-900 border-t border-industrial-border shrink-0', compact ? 'p-5' : 'p-4')}>
      <div className="mb-4">
        <div className="flex justify-between items-end mb-1">
          <span className={cn('font-bold text-zinc-500 uppercase tracking-widest', compact ? 'text-[11px]' : 'text-[10px]')}>
            Total Estimated Cost
          </span>
          <span className={cn('font-bold text-amber-accent tracking-tighter', compact ? 'text-2xl' : 'text-xl')}>
            {formatCurrency(totalCost)}
          </span>
        </div>
        <div className="h-0.5 bg-zinc-800 w-full rounded-full overflow-hidden">
          <div className="h-full bg-amber-accent shadow-[0_0_8px_rgba(245,158,11,0.5)] w-[65%]" />
        </div>
      </div>
      <button className={cn(
        'w-full bg-[#262626] hover:bg-zinc-800 border border-industrial-border',
        'text-zinc-400 hover:text-zinc-200 font-bold uppercase tracking-widest transition-all',
        compact ? 'py-4 text-[11px]' : 'py-3 text-[10px]',
      )}>
        Generate Full Analysis
      </button>
    </div>
  );

  /* ─── EXPANDED OVERLAY matching ESTIMATOR_PRO_V1 design ─────── */
  const ExpandedOverlay = () => (
    <div
      ref={backdropRef}
      className="absolute inset-0 z-50"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(1px)' }}
      onClick={(e) => { if (e.target === backdropRef.current) setIsOverlay(false); }}
    >
      {/*
       * Panel covers from just after the left Sidebar to the right edge.
       * Sidebar collapsed = ~56px, expanded = ~240px.
       * We use `left: 0` so the panel itself starts at the workspace boundary
       * (the parent flex row already starts after the sidebar).
       */}
      <div className="absolute inset-0 flex bg-[#131313] font-mono overflow-hidden">

        {/* ── Left: table area ── */}
        <div className="flex-1 flex flex-col border-r border-zinc-800 overflow-hidden">

          {/* Stats header */}
          <div className="p-4 bg-zinc-950/70 flex items-center justify-between border-b border-zinc-800 shrink-0">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-zinc-500 text-[10px] font-bold uppercase tracking-widest">
                  {projectName}
                </span>
                <span className="text-zinc-700 text-xs">/</span>
                <span className="text-[15px] font-bold text-zinc-100 tracking-tight">
                  Takeoff Data — Expanded View
                </span>
              </div>
              {projectNumber && (
                <div className="text-[11px] text-zinc-600 mt-0.5 uppercase tracking-widest">
                  {projectNumber}
                </div>
              )}
            </div>
            <div className="flex items-center gap-3">
              {/* Stat boxes */}
              <div className="px-4 py-2 bg-zinc-900 border border-zinc-800">
                <div className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Total Estimate</div>
                <div className="text-[18px] font-bold text-amber-500 tracking-tight">{formatCurrency(totalCost)}</div>
              </div>
              <div className="px-4 py-2 bg-zinc-900 border border-zinc-800">
                <div className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Objects</div>
                <div className="text-[18px] font-bold text-zinc-100 tracking-tight">{measurements.length}</div>
              </div>
              <div className="px-4 py-2 bg-zinc-900 border border-zinc-800">
                <div className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Total Qty</div>
                <div className="text-[18px] font-bold text-zinc-100 tracking-tight">{totalQty.toFixed(1)}</div>
              </div>
              {/* Collapse button */}
              <button
                onClick={() => setIsOverlay(false)}
                className="ml-2 flex items-center gap-2 border border-zinc-700 text-zinc-400 hover:text-amber-500 hover:border-amber-500 transition-colors px-3 py-2 text-[10px] font-bold uppercase tracking-widest"
              >
                <Minimize2 className="w-3.5 h-3.5" />
                Collapse
              </button>
            </div>
          </div>

          {/* Configurator strip */}
          <div className="bg-zinc-900/50 px-4 py-2 border-b border-zinc-800 flex items-center gap-5 shrink-0 overflow-x-auto">
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-amber-500 text-sm">⚙</span>
              <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">Takeoff Actions</span>
            </div>
            <div className="w-px h-5 bg-zinc-800 shrink-0" />
            <button
              onClick={() => onToggleVisibility()}
              className="flex items-center gap-1.5 text-zinc-500 hover:text-amber-accent transition-colors text-[10px] font-bold uppercase tracking-widest shrink-0"
            >
              {allVisible ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
              {allVisible ? 'Hide All' : 'Show All'}
            </button>
            <button
              onClick={onAddManual}
              className="flex items-center gap-1.5 text-zinc-500 hover:text-amber-accent transition-colors text-[10px] font-bold uppercase tracking-widest shrink-0"
            >
              <Plus className="w-3 h-3" />
              Add Row
            </button>
            {flaggedRows.length > 0 && (
              <>
                <div className="w-px h-5 bg-zinc-800 shrink-0" />
                <span className="text-[11px] text-amber-500 font-bold italic shrink-0">
                  {flaggedRows.length} Overridden Item{flaggedRows.length > 1 ? 's' : ''}
                </span>
                <button className="bg-amber-500 text-zinc-950 px-3 py-1 text-[10px] font-black uppercase tracking-widest shrink-0 hover:bg-amber-400 transition-colors">
                  Review Changes
                </button>
              </>
            )}
          </div>

          {/* Table — the main expanded data */}
          <div className="flex-1 overflow-auto bg-[#0d0d0d] custom-scrollbar">
            <table className="w-full text-[12px] border-collapse">
              <TableHead compact />
              <TableBody compact />
            </table>
          </div>

          {/* Footer */}
          <TableFooter compact />
        </div>

        {/* ── Right: Analysis panel (mirrors Sync Status from reference) ── */}
        <div className="w-80 bg-zinc-950 flex flex-col shrink-0">
          {/* Panel header */}
          <div className="p-4 border-b border-zinc-800 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2">
              <BarChart2 className="w-4 h-4 text-amber-500" />
              <span className="text-[15px] font-bold text-zinc-100 tracking-tight">Analysis</span>
            </div>
            {flaggedRows.length > 0 && (
              <div className="px-2 py-0.5 bg-amber-500/10 border border-amber-500 text-amber-500 text-[9px] font-bold uppercase tracking-widest">
                {flaggedRows.length} Flagged
              </div>
            )}
          </div>

          <div className="flex-1 overflow-auto p-4 space-y-4 custom-scrollbar">

            {/* Cost breakdown card */}
            <div className="border border-amber-500/40 bg-amber-500/5 p-3 relative overflow-hidden">
              <div className="absolute top-1 right-1 opacity-10">
                <BarChart2 className="w-10 h-10 text-amber-500" />
              </div>
              <div className="text-[9px] text-amber-500 font-bold uppercase tracking-widest mb-2">Cost Breakdown</div>
              <div className="text-zinc-100 text-[13px] font-semibold mb-0.5">
                {formatCurrency(totalCost)} Total
              </div>
              <p className="text-zinc-500 text-[11px] leading-relaxed">
                Across {measurements.filter(m => !m.isGroupHeader).length} line items in{' '}
                {organizedData.groups.size} group{organizedData.groups.size !== 1 ? 's' : ''} and{' '}
                {organizedData.ungrouped.length} standalone item{organizedData.ungrouped.length !== 1 ? 's' : ''}.
              </p>
              <div className="mt-3 border-t border-amber-500/20 pt-3 flex items-center justify-between">
                <span className="text-[9px] text-zinc-400 font-bold uppercase tracking-widest">With 10% Waste</span>
                <span className="text-[13px] font-bold font-mono text-amber-500">
                  {formatCurrency(totalCost * 1.1)}
                </span>
              </div>
            </div>

            {/* Flagged / overridden items */}
            {flaggedRows.length > 0 && (
              <div className="space-y-2">
                <div className="text-[9px] text-zinc-500 font-bold uppercase tracking-widest">
                  Overridden Items ({flaggedRows.length})
                </div>
                {flaggedRows.slice(0, 5).map((row) => {
                  const cost = row.quantity * row.unitRate;
                  const pct = totalCost > 0 ? (cost / totalCost) * 100 : 0;
                  return (
                    <div key={row.id} className="p-2 border border-zinc-800 bg-zinc-900 hover:border-zinc-600 transition-all cursor-pointer">
                      <div className="flex justify-between items-start mb-1">
                        <span className="text-[11px] font-bold text-zinc-200 truncate mr-2">{row.description}</span>
                        <span className="text-[9px] text-amber-500 font-bold uppercase shrink-0">Flagged</span>
                      </div>
                      <div className="text-[9px] text-zinc-600 mb-2 truncate">
                        {row.category || row.type} · {row.quantity.toFixed(2)} {row.unit}
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 bg-zinc-950 h-1.5 border border-zinc-800">
                          <div className="bg-amber-500 h-full" style={{ width: `${Math.min(pct, 100)}%` }} />
                        </div>
                        <span className="text-[9px] font-mono text-zinc-400">{pct.toFixed(0)}%</span>
                      </div>
                    </div>
                  );
                })}
                {flaggedRows.length > 5 && (
                  <div className="text-[9px] text-zinc-600 text-center py-1">
                    +{flaggedRows.length - 5} more…
                  </div>
                )}
              </div>
            )}

            {/* Category breakdown */}
            {(() => {
              const cats = new Map<string, number>();
              measurements.filter(m => !m.isGroupHeader).forEach(m => {
                const cat = m.category || 'Uncategorised';
                cats.set(cat, (cats.get(cat) || 0) + m.quantity * m.unitRate);
              });
              if (cats.size === 0) return null;
              return (
                <div className="space-y-2">
                  <div className="text-[9px] text-zinc-500 font-bold uppercase tracking-widest">
                    By Category
                  </div>
                  {Array.from(cats.entries())
                    .sort((a, b) => b[1] - a[1])
                    .map(([cat, cost]) => (
                      <div key={cat} className="flex items-center gap-2">
                        <span className="text-[10px] text-zinc-400 truncate flex-1">{cat}</span>
                        <span className="text-[10px] font-mono text-zinc-300 shrink-0">{formatCurrency(cost)}</span>
                      </div>
                    ))}
                </div>
              );
            })()}

            {flaggedRows.length === 0 && measurements.length > 0 && (
              <div className="text-center py-6">
                <div className="w-8 h-8 mx-auto mb-2 rounded-full bg-emerald-500/10 flex items-center justify-center">
                  <span className="text-emerald-500 text-sm">✓</span>
                </div>
                <div className="text-[10px] text-zinc-600 uppercase tracking-widest">All items nominal</div>
              </div>
            )}
          </div>

          {/* Footer actions */}
          <div className="p-4 border-t border-zinc-800 bg-zinc-900/50 space-y-2 shrink-0">
            <button className="w-full bg-amber-500 text-zinc-950 py-2.5 font-black uppercase text-[10px] tracking-widest hover:bg-amber-400 active:scale-95 transition-all flex items-center justify-center gap-2">
              <CheckSquare className="w-3.5 h-3.5" />
              Accept All Changes
            </button>
            <button className="w-full border border-zinc-700 text-zinc-400 py-2.5 font-black uppercase text-[10px] tracking-widest hover:bg-zinc-800 active:scale-95 transition-all flex items-center justify-center gap-2">
              <RotateCcw className="w-3.5 h-3.5" />
              Discard &amp; Revert
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  /* ─── NORMAL sidebar panel ───────────────────────────────────── */
  return (
    <>
      <aside className="w-96 bg-industrial-panel border-l border-industrial-border flex flex-col h-full font-mono">
        {/* Header */}
        <div className="p-3 border-b border-industrial-border bg-stone-900/50 flex justify-between items-center shrink-0">
          <span className="text-[10px] font-bold text-zinc-500 tracking-widest uppercase">Takeoff Data</span>
          <div className="flex items-center gap-3">
            <button
              onClick={() => onToggleVisibility()}
              className="text-zinc-500 hover:text-amber-accent transition-colors flex items-center gap-1 text-[10px] font-bold"
              title={allVisible ? 'Hide All' : 'Show All'}
            >
              {allVisible ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
            </button>
            <button
              onClick={onAddManual}
              className="text-zinc-500 hover:text-amber-accent transition-colors flex items-center gap-1 text-[10px] font-bold"
            >
              <Plus className="w-3 h-3" />
              ADD ROW
            </button>
            {/* ← This is the only trigger for the overlay */}
            <button
              onClick={() => setIsOverlay(true)}
              className="border-l border-industrial-border pl-3 ml-1 text-zinc-500 hover:text-amber-accent transition-colors"
              title="Expand over canvas"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto custom-scrollbar">
          <table className="w-full text-[10px] border-collapse">
            <TableHead />
            <TableBody />
          </table>
        </div>

        <TableFooter />
      </aside>

      {/* Overlay — covers the viewer/canvas, left sidebar stays untouched */}
      {isOverlay && <ExpandedOverlay />}
    </>
  );
}
// components/TakeoffTable.tsx
import React, { useState, useMemo, useCallback, memo } from 'react';
import { Trash2, Plus, Pencil, Eye, EyeOff, ChevronDown, ChevronRight, FolderOpen, Package, ExternalLink, ChevronUp } from 'lucide-react';
import { cn, formatCurrency } from '../lib/utils';
import { TakeoffRow, Material } from '../types';

interface TakeoffTableProps {
  measurements: TakeoffRow[];
  materials: Material[];
  onUpdate: (id: string, updates: Partial<TakeoffRow>) => void;
  onDelete: (id: string) => void;
  onAddManual: () => void;
  onToggleVisibility: (id?: string) => void;
  onExpand?: () => void;
}

export function TakeoffTable({
  measurements,
  materials,
  onUpdate,
  onDelete,
  onAddManual,
  onToggleVisibility,
  onExpand,
}: TakeoffTableProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  // Track which rows have their accordion detail panel open
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  // ── Helpers ────────────────────────────────────────────────────────────────

  const stopEditing = () => {
    setEditingId(null);
    setEditingField(null);
  };

  const startEditing = (id: string, field: string, e?: React.MouseEvent) => {
    e?.stopPropagation(); // prevent accordion toggle when clicking to edit
    setEditingId(id);
    setEditingField(field);
  };

  const getMaterial = (materialId?: string) =>
    materials.find((m) => m.id === materialId);

  const toggleRowExpand = (id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // ── Group helpers ──────────────────────────────────────────────────────────

  const organizedData = React.useMemo(() => {
    const groups: Map<string, { header: TakeoffRow; items: TakeoffRow[] }> = new Map();
    const ungrouped: TakeoffRow[] = [];

    measurements.forEach((measurement) => {
      // Handle old-style groupId grouping
      if (measurement.isGroupHeader && measurement.groupId) {
        groups.set(measurement.groupId, { header: measurement, items: [] });
      } else if (measurement.groupId && groups.has(measurement.groupId)) {
        groups.get(measurement.groupId)!.items.push(measurement);
      }
      // Handle new-style parent-child grouping (childIds/parentId)
      else if (measurement.isGroupHeader && measurement.childIds) {
        groups.set(measurement.id, { header: measurement, items: [] });
      } else if (measurement.parentId && groups.has(measurement.parentId)) {
        groups.get(measurement.parentId)!.items.push(measurement);
      } 
      // Ungrouped: no groupId, no parentId, not a group header
      else if (!measurement.isGroupHeader && !measurement.groupId && !measurement.parentId) {
        ungrouped.push(measurement);
      }
    });

    return { groups, ungrouped };
  }, [measurements]);

  const toggleGroup = (groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      next.has(groupId) ? next.delete(groupId) : next.add(groupId);
      return next;
    });
  };

  // Helper to get groupId for a measurement (works with both old and new grouping styles)
  const getGroupId = (measurement: TakeoffRow): string | null => {
    if (measurement.isGroupHeader) {
      return measurement.groupId || measurement.id;
    }
    return measurement.groupId || measurement.parentId || null;
  };

  const calculateGroupTotal = (items: TakeoffRow[], type: 'cost' | 'quantity' = 'cost') =>
    type === 'quantity'
      ? items.reduce((sum, i) => sum + i.quantity, 0)
      : items.reduce((sum, i) => sum + i.quantity * i.unitRate, 0);

  const totalCost = measurements.reduce((sum, m) => sum + m.quantity * m.unitRate, 0);
  const allVisible = measurements.every((m) => m.isVisible !== false);

  // ── Cell renderers ─────────────────────────────────────────────────────────

  const renderEditableText = (
    row: TakeoffRow,
    field: keyof TakeoffRow,
    type: 'text' | 'number' = 'text',
    className = ''
  ) => {
    const isEditing = editingId === row.id && editingField === field;
    const value = row[field];

    if (isEditing) {
      return (
        <input
          autoFocus
          type={type}
          defaultValue={value as string | number}
          onBlur={(e) => {
            const val = type === 'number' ? parseFloat(e.target.value) : e.target.value;
            onUpdate(row.id, { [field]: val });
            stopEditing();
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          onClick={(e) => e.stopPropagation()}
          className="w-full bg-stone-900 border border-amber-accent text-[11px] font-mono p-1 outline-none text-zinc-200"
        />
      );
    }

    return (
      <span
        onClick={(e) => startEditing(row.id, field, e)}
        className={cn('cursor-text hover:text-amber-accent transition-colors', className)}
      >
        {type === 'number' && typeof value === 'number' ? value.toFixed(2) : (value as string)}
      </span>
    );
  };

  const renderMaterialSelect = (row: TakeoffRow) => {
    const isEditing = editingId === row.id && editingField === 'materialId';
    const matched = getMaterial(row.materialId);

    // Helper to get total cost from material (handles missing fields)
    const getMaterialTotal = (mat: Material) => 
      (mat.materialCost ?? 0) + (mat.laborCost ?? 0) + (mat.equipmentCost ?? 0) || mat.unitRate || 0;

    if (isEditing) {
      return (
        <select
          autoFocus
          defaultValue={row.materialId || ''}
          onBlur={(e) => {
            const selectedId = e.target.value;
            const mat = materials.find((m) => m.id === selectedId);
            if (mat) {
              const total = getMaterialTotal(mat);
              onUpdate(row.id, { materialId: mat.id, unitRate: total, unit: mat.unit });
            } else {
              onUpdate(row.id, { materialId: undefined });
            }
            stopEditing();
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          onClick={(e) => e.stopPropagation()}
          className="w-full bg-stone-900 border border-amber-accent text-[11px] font-mono p-1 outline-none text-zinc-200"
        >
          <option value="">— None —</option>
          {materials.map((m) => (
            <option key={m.id} value={m.id}>
              {m.code || m.id.slice(0,6)} – {m.name} ({formatCurrency(getMaterialTotal(m))}/{m.unit})
            </option>
          ))}
        </select>
      );
    }

    return (
      <span
        onClick={(e) => startEditing(row.id, 'materialId', e)}
        className="cursor-pointer hover:text-amber-accent transition-colors"
      >
        {matched ? (
          <span className="flex flex-col gap-0.5">
            <span className="text-[10px] text-zinc-300 font-mono">{matched.code || matched.id.slice(0,6)}</span>
            <span className="text-[8px] text-zinc-500 leading-tight">{matched.name}</span>
          </span>
        ) : (
          <span className="text-[10px] text-zinc-600 italic">— assign —</span>
        )}
      </span>
    );
  };

  // ── Inline action buttons (color dot · eye · trash) ──────────────────────

  const renderInlineActions = (row: TakeoffRow) => (
    <div className="flex items-center justify-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
      <label className="cursor-pointer">
        <input
          type="color"
          value={row.color || '#EF9F27'}
          onChange={(e) => onUpdate(row.id, { color: e.target.value })}
          className="opacity-0 w-0 h-0 absolute pointer-events-none"
        />
        <div
          className="w-3 h-3 rounded-full shadow-sm hover:scale-110 transition-transform"
          style={{ backgroundColor: row.color || '#EF9F27' }}
        />
      </label>
      <button
        onClick={() => onToggleVisibility(row.id)}
        className={cn(
          'transition-colors',
          row.isVisible !== false ? 'text-zinc-500 hover:text-amber-accent' : 'text-zinc-700 hover:text-amber-accent'
        )}
      >
        {row.isVisible !== false ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
      </button>
      <button
        onClick={() => onDelete(row.id)}
        className="text-zinc-700 hover:text-red-500 transition-colors"
      >
        <Trash2 className="w-3 h-3" />
      </button>
    </div>
  );

  // ── Accordion detail panel ─────────────────────────────────────────────────

  const renderDetailPanel = (row: TakeoffRow) => {
    const matched = getMaterial(row.materialId);
    return (
      <tr key={`${row.id}-detail`} className="bg-[#0d0d0d]">
        <td colSpan={3} className="px-3 pb-3 pt-0">
          <div className="border border-zinc-800 rounded-sm bg-[#111] p-3 mt-1 space-y-3">

            {/* Label row (for Count measurements) */}
            {row.label && (
              <div className="flex items-start gap-3">
                <span className="text-[8px] text-zinc-600 uppercase tracking-widest w-16 shrink-0 pt-0.5">Label</span>
                <span className="text-[9px] text-zinc-400 font-mono">{row.label}</span>
              </div>
            )}

            {/* Material row */}
            <div className="flex items-start gap-3">
              <span className="text-[8px] text-zinc-600 uppercase tracking-widest w-16 shrink-0 pt-0.5">Material</span>
              <div className="flex-1 min-w-0">
                {renderMaterialSelect(row)}
              </div>
            </div>

            {/* Qty + Unit Rate */}
            <div className="flex gap-4">
              <div className="flex items-center gap-3 flex-1">
                <span className="text-[8px] text-zinc-600 uppercase tracking-widest w-16 shrink-0">Qty</span>
                <div className="flex items-center gap-1.5">
                  {renderEditableText(row, 'quantity', 'number', 'text-[11px] text-amber-accent font-mono font-bold')}
                  {row.isOverridden && <Pencil className="w-2 h-2 text-amber-accent/60" />}
                  {row.unit && <span className="text-[9px] text-zinc-600">{row.unit}</span>}
                </div>
              </div>
              <div className="flex items-center gap-3 flex-1">
                <span className="text-[8px] text-zinc-600 uppercase tracking-widest w-16 shrink-0">Rate</span>
                {renderEditableText(row, 'unitRate', 'number', 'text-[11px] text-zinc-300 font-mono')}
              </div>
            </div>

            {/* Notes */}
            {row.notes && (
              <div className="flex items-start gap-3">
                <span className="text-[8px] text-zinc-600 uppercase tracking-widest w-16 shrink-0 pt-0.5">Notes</span>
                <span className="text-[9px] text-zinc-500 font-mono">{row.notes}</span>
              </div>
            )}
          </div>
        </td>
      </tr>
    );
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <aside className="w-full min-w-0 bg-industrial-panel border-l border-industrial-border flex flex-col h-full font-mono">

      {/* Header */}
      <div className="p-3 border-b border-industrial-border bg-stone-900/50 flex justify-between items-center flex-shrink-0">
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
          {onExpand && (
            <>
              <div className="w-px h-3 bg-zinc-700" />
              <button
                onClick={onExpand}
                className="text-zinc-500 hover:text-amber-400 transition-colors flex items-center gap-1 text-[10px] font-bold"
                title="Open full-page takeoff view"
              >
                <ExternalLink className="w-3 h-3" />
                EXPAND
              </button>
            </>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto custom-scrollbar">
        <table className="w-full text-[10px] border-collapse">
          <thead className="bg-stone-900/80 sticky top-0 z-20">
            <tr className="border-b border-industrial-border text-zinc-500 uppercase tracking-tighter">
              <th className="p-2 text-center w-8 border-r border-industrial-border">#</th>
              <th className="p-2 border-r border-industrial-border text-left">Description</th>
              <th className="p-2 text-right pr-3">Cost</th>
            </tr>
          </thead>

          <tbody className="divide-y divide-industrial-border">

            {/* ── Groups ───────────────────────────────────────────────────── */}
            {Array.from(organizedData.groups.entries()).map(([groupId, { header, items }], groupIdx) => {
              const isGroupExpanded = expandedGroups.has(groupId);
              return (
                <React.Fragment key={groupId}>

                  {/* Group header row */}
                  <tr
                    className="border-t border-amber-500/20 bg-[#1a1a1a] cursor-pointer hover:bg-[#222] transition-colors group"
                    onClick={() => toggleGroup(groupId)}
                  >
                    <td className="p-2 text-center border-r border-industrial-border text-amber-500 font-bold whitespace-nowrap">
                      {groupIdx + 1}
                    </td>
                    <td className="p-2 border-r border-industrial-border">
                      <div className="flex items-center gap-2">
                        {isGroupExpanded
                          ? <ChevronDown className="w-3 h-3 text-amber-500 shrink-0" />
                          : <ChevronRight className="w-3 h-3 text-amber-500 shrink-0" />}
                        <FolderOpen className="w-3 h-3 text-amber-500/60 shrink-0" />
                        <span className="text-[11px] font-bold text-amber-500 uppercase tracking-wider truncate">
                          {header.groupName || header.description}
                        </span>
                        <span className="text-[8px] text-zinc-600 shrink-0">({items.length})</span>
                      </div>
                    </td>
                    <td className="p-2 text-right font-bold text-amber-500 whitespace-nowrap pr-3">
                      {formatCurrency(calculateGroupTotal(items))}
                    </td>
                  </tr>

                  {/* Group items */}
                  {isGroupExpanded && items.map((item, itemIdx) => {
                    const isRowExpanded = expandedRows.has(item.id);
                    return (
                      <React.Fragment key={item.id}>
                        <tr
                          className={cn(
                            'border-t border-[#1a1a1a] transition-colors cursor-pointer',
                            isRowExpanded ? 'bg-stone-900' : 'hover:bg-stone-900/50'
                          )}
                          onClick={() => toggleRowExpand(item.id)}
                        >
                          <td className="p-2 text-center border-r border-industrial-border text-zinc-600 text-[9px] whitespace-nowrap">
                            {groupIdx + 1}.{itemIdx + 1}
                          </td>
                          <td className="p-2 border-r border-industrial-border pl-7">
                            <div className="flex items-center gap-2">
                              <Package className="w-2.5 h-2.5 text-zinc-600 shrink-0" />
                              {editingId === item.id && editingField === 'description' ? (
                                <input
                                  autoFocus
                                  type="text"
                                  defaultValue={item.description}
                                  onBlur={(e) => { onUpdate(item.id, { description: e.target.value }); stopEditing(); }}
                                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                                  onClick={(e) => e.stopPropagation()}
                                  className="flex-1 min-w-0 bg-stone-900 border border-amber-accent text-[11px] font-mono p-1 outline-none text-zinc-200"
                                />
                              ) : (
                                <span
                                  className="truncate text-zinc-200 cursor-text hover:text-amber-accent transition-colors flex-1 min-w-0"
                                  onClick={(e) => startEditing(item.id, 'description', e)}
                                >
                                  {item.description || <span className="text-zinc-600 italic">No description</span>}
                                </span>
                              )}
                              <div className="ml-auto flex items-center gap-2 shrink-0">
                                {renderInlineActions(item)}
                                <span className="text-zinc-700">
                                  {isRowExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                                </span>
                              </div>
                            </div>
                          </td>
                          <td className="p-2 text-right font-bold text-zinc-300 whitespace-nowrap pr-3">
                            {formatCurrency(item.quantity * item.unitRate)}
                          </td>
                        </tr>
                        {isRowExpanded && renderDetailPanel(item)}
                      </React.Fragment>
                    );
                  })}

                  {/* Group summary */}
                  {isGroupExpanded && items.length > 0 && (
                    <tr className="bg-[#111] border-t border-[#1e1e1e]">
                      <td colSpan={3} className="p-1.5 px-3 text-right">
                        <div className="flex items-center justify-end gap-3 text-[8px] text-zinc-600 font-mono">
                          <span>Subtotal: {formatCurrency(calculateGroupTotal(items))}</span>
                          <span className="w-px h-2 bg-zinc-700" />
                          <span>+10% waste: {formatCurrency(calculateGroupTotal(items) * 0.1)}</span>
                          <span className="w-px h-2 bg-zinc-700" />
                          <span className="text-amber-500">Total: {formatCurrency(calculateGroupTotal(items) * 1.1)}</span>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}

            {/* ── Ungrouped rows ────────────────────────────────────────────── */}
            {organizedData.ungrouped.map((row, idx) => {
              const isRowExpanded = expandedRows.has(row.id);
              return (
                <React.Fragment key={row.id}>
                  <tr
                    className={cn(
                      'border-t border-industrial-border transition-colors cursor-pointer',
                      isRowExpanded ? 'bg-stone-900' : 'hover:bg-stone-900/50'
                    )}
                    onClick={() => toggleRowExpand(row.id)}
                  >
                    <td className="p-2 text-center border-r border-industrial-border text-zinc-600 font-bold whitespace-nowrap">
                      {(organizedData.groups.size + idx + 1).toString().padStart(2, '0')}
                    </td>
                    <td className="p-2 border-r border-industrial-border font-medium">
                      <div className="flex items-center gap-2">
                        {editingId === row.id && editingField === 'description' ? (
                          <input
                            autoFocus
                            type="text"
                            defaultValue={row.description}
                            onBlur={(e) => { onUpdate(row.id, { description: e.target.value }); stopEditing(); }}
                            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                            onClick={(e) => e.stopPropagation()}
                            className="flex-1 min-w-0 bg-stone-900 border border-amber-accent text-[11px] font-mono p-1 outline-none text-zinc-200"
                          />
                        ) : (
                          <span
                            className="truncate text-zinc-200 cursor-text hover:text-amber-accent transition-colors flex-1 min-w-0"
                            onClick={(e) => startEditing(row.id, 'description', e)}
                          >
                            {row.description || <span className="text-zinc-600 italic">No description</span>}
                          </span>
                        )}
                        <div className="ml-auto flex items-center gap-2 shrink-0">
                          {renderInlineActions(row)}
                          <span className="text-zinc-700">
                            {isRowExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="p-2 text-right font-bold text-zinc-200 whitespace-nowrap pr-3">
                      {formatCurrency(row.quantity * row.unitRate)}
                    </td>
                  </tr>
                  {isRowExpanded && renderDetailPanel(row)}
                </React.Fragment>
              );
            })}

            {measurements.length === 0 && (
              <tr>
                <td colSpan={3} className="p-12 text-center text-zinc-700 uppercase tracking-widest leading-loose">
                  No active measurements.<br />Click canvas tools to begin.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Footer */}
      <div className="p-4 bg-stone-900 border-t border-industrial-border">
        <div className="mb-4">
          <div className="flex justify-between items-end mb-1">
            <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Total Estimated Cost</span>
            <span className="text-xl font-bold text-amber-accent tracking-tighter">{formatCurrency(totalCost)}</span>
          </div>
          <div className="h-0.5 bg-zinc-800 w-full rounded-full overflow-hidden">
            <div className="h-full bg-amber-accent shadow-[0_0_8px_rgba(245,158,11,0.5)] w-[65%]" />
          </div>
        </div>
        <button className="w-full bg-[#262626] hover:bg-zinc-800 border border-industrial-border text-zinc-400 hover:text-zinc-200 py-3 text-[10px] font-bold uppercase tracking-widest transition-all">
          Generate Full Analysis
        </button>
      </div>
    </aside>
  );
}

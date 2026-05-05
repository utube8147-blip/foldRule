// components/TakeoffTable.tsx
import React, { useState } from 'react';
import { Trash2, Plus, Pencil, Eye, EyeOff, ChevronDown, ChevronRight, FolderOpen, Package, ExternalLink } from 'lucide-react';
import { cn, formatCurrency } from '../lib/utils';
import { TakeoffRow, MaterialSpec } from '../types';

interface TakeoffTableProps {
  measurements: TakeoffRow[];
  materials: MaterialSpec[];
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

  // ── Helpers ────────────────────────────────────────────────────────────────

  const stopEditing = () => {
    setEditingId(null);
    setEditingField(null);
  };

  const startEditing = (id: string, field: string) => {
    setEditingId(id);
    setEditingField(field);
  };

  const getMaterial = (materialId?: string) =>
    materials.find((m) => m.id === materialId);

  // ── Group helpers ──────────────────────────────────────────────────────────

  const organizedData = React.useMemo(() => {
    const groups: Map<string, { header: TakeoffRow; items: TakeoffRow[] }> = new Map();
    const ungrouped: TakeoffRow[] = [];

    measurements.forEach((measurement) => {
      if (measurement.isGroupHeader && measurement.groupId) {
        groups.set(measurement.groupId, { header: measurement, items: [] });
      } else if (measurement.groupId && groups.has(measurement.groupId)) {
        groups.get(measurement.groupId)!.items.push(measurement);
      } else if (!measurement.isGroupHeader) {
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

  const calculateGroupTotal = (items: TakeoffRow[], type: 'cost' | 'quantity' = 'cost') =>
    type === 'quantity'
      ? items.reduce((sum, i) => sum + i.quantity, 0)
      : items.reduce((sum, i) => sum + i.quantity * i.unitRate, 0);

  const totalCost = measurements.reduce((sum, m) => sum + m.quantity * m.unitRate, 0);
  const allVisible = measurements.every((m) => m.isVisible !== false);

  // ── Cell renderers ─────────────────────────────────────────────────────────

  const renderTextCell = (
    row: TakeoffRow,
    field: keyof TakeoffRow,
    type: 'text' | 'number' = 'text'
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
          className="w-full bg-stone-900 border border-amber-accent text-[11px] font-mono p-1 outline-none text-zinc-200"
        />
      );
    }

    return (
      <div
        onClick={() => !row.isGroupHeader && startEditing(row.id, field)}
        className={cn(
          'cursor-text hover:text-amber-accent transition-colors truncate min-h-[16px] w-full',
          row.isGroupHeader && 'cursor-default'
        )}
      >
        {type === 'number' && typeof value === 'number' ? value.toFixed(2) : (value as string)}
      </div>
    );
  };

  const renderDescriptionCell = (row: TakeoffRow) => {
    const isEditing = editingId === row.id && editingField === 'description';

    if (isEditing) {
      return (
        <input
          autoFocus
          type="text"
          defaultValue={row.description}
          onBlur={(e) => {
            onUpdate(row.id, { description: e.target.value });
            stopEditing();
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          className="w-full bg-stone-900 border border-amber-accent text-[11px] font-mono p-1 outline-none text-zinc-200"
        />
      );
    }

    return (
      <div
        onClick={() => startEditing(row.id, 'description')}
        className="cursor-text hover:text-amber-accent transition-colors truncate min-h-[16px] w-full text-zinc-200"
      >
        {row.description || <span className="text-zinc-600 italic">No description</span>}
      </div>
    );
  };

  const renderMaterialCell = (row: TakeoffRow) => {
    const isEditing = editingId === row.id && editingField === 'materialId';
    const matched = getMaterial(row.materialId);

    if (isEditing) {
      return (
        <select
          autoFocus
          defaultValue={row.materialId || ''}
          onBlur={(e) => {
            const selectedId = e.target.value;
            const mat = materials.find((m) => m.id === selectedId);
            if (mat) {
              const total = mat.materialCost + mat.laborCost + mat.equipmentCost;
              onUpdate(row.id, {
                materialId: mat.id,
                unitRate: total,
                unit: mat.unit,
              });
            } else {
              onUpdate(row.id, { materialId: undefined });
            }
            stopEditing();
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          className="w-full bg-stone-900 border border-amber-accent text-[11px] font-mono p-1 outline-none text-zinc-200"
        >
          <option value="">— None —</option>
          {materials.map((m) => (
            <option key={m.id} value={m.id}>
              {m.code} – {m.name} ({formatCurrency(m.materialCost + m.laborCost + m.equipmentCost)}/{m.unit})
            </option>
          ))}
        </select>
      );
    }

    return (
      <div
        onClick={() => !row.isGroupHeader && startEditing(row.id, 'materialId')}
        className="cursor-pointer hover:text-amber-accent transition-colors min-h-[16px] w-full"
      >
        {matched ? (
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] text-zinc-300 font-mono">{matched.code}</span>
            <span className="text-[8px] text-zinc-500 truncate leading-tight">{matched.name}</span>
          </div>
        ) : (
          <span className="text-[10px] text-zinc-600 italic">— assign —</span>
        )}
      </div>
    );
  };

  // ── Row renderers ──────────────────────────────────────────────────────────

  const renderActionButtons = (row: TakeoffRow) => (
    <div className="flex items-center justify-center gap-2">
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
        className="text-zinc-700 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100 group-hover/item:opacity-100"
      >
        <Trash2 className="w-3 h-3" />
      </button>
    </div>
  );

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

      {/* Table wrapper with horizontal scroll */}
      <div className="flex-1 overflow-auto custom-scrollbar">
        {/* Table with auto-sizing columns (no min-width on table) */}
        <table className="w-auto min-w-full text-[10px] border-collapse">
          <thead className="bg-stone-900/80 sticky top-0 z-20">
            <tr className="border-b border-industrial-border text-zinc-500 uppercase tracking-tighter">
              {/* # column - minimal width */}
              <th className="p-2 text-center w-8 border-r border-industrial-border sticky left-0 z-30 bg-stone-900">
                #
              </th>

              {/* Description column - minimal width based on content */}
              <th className="p-2 border-r border-industrial-border text-left sticky left-8 z-30 bg-stone-900 shadow-[2px_0_6px_rgba(0,0,0,0.5)]">
                Description
              </th>

              {/* Material column - minimal width */}
              <th className="p-2 border-r border-industrial-border text-left whitespace-nowrap">
                Material
              </th>

              {/* Quantity column - minimal */}
              <th className="p-2 border-r border-industrial-border text-right whitespace-nowrap">
                Qty
              </th>

              {/* Cost column - minimal */}
              <th className="p-2 border-r border-industrial-border text-right whitespace-nowrap">
                Cost
              </th>

              {/* Actions column - fixed small width */}
              <th className="p-2 w-16 text-center whitespace-nowrap">
                Actions
              </th>
            </tr>
          </thead>

          <tbody className="divide-y divide-industrial-border">

            {/* ── Groups ───────────────────────────────────────────────────── */}
            {Array.from(organizedData.groups.entries()).map(([groupId, { header, items }], groupIdx) => {
              const isExpanded = expandedGroups.has(groupId);
              return (
                <React.Fragment key={groupId}>

                  {/* Group header row */}
                  <tr
                    className="border-t border-amber-500/20 bg-[#1a1a1a] cursor-pointer hover:bg-[#222] transition-colors group"
                    onClick={() => toggleGroup(groupId)}
                  >
                    {/* Sticky # cell for group header */}
                    <td className="p-2 text-center border-r border-industrial-border text-amber-500 font-bold sticky left-0 z-10 bg-[#1a1a1a] whitespace-nowrap">
                      {groupIdx + 1}
                    </td>

                    {/* Sticky Description cell for group header (colSpan=2 covers Description+Material) */}
                    <td
                      className="p-2 border-r border-industrial-border sticky left-8 z-10 bg-[#1a1a1a] shadow-[2px_0_6px_rgba(0,0,0,0.5)]"
                      colSpan={2}
                    >
                      <div className="flex items-center gap-2 whitespace-nowrap">
                        {isExpanded
                          ? <ChevronDown className="w-3 h-3 text-amber-500" />
                          : <ChevronRight className="w-3 h-3 text-amber-500" />}
                        <FolderOpen className="w-3 h-3 text-amber-500/60" />
                        <span className="text-[11px] font-bold text-amber-500 uppercase tracking-wider">
                          {header.groupName}
                        </span>
                        <span className="text-[8px] text-zinc-600">({items.length})</span>
                      </div>
                    </td>

                    <td className="p-2 border-r border-industrial-border text-right whitespace-nowrap">
                      <span className="text-[11px] font-mono text-amber-400">
                        {calculateGroupTotal(items, 'quantity').toFixed(1)}
                      </span>
                    </td>
                    <td className="p-2 text-right border-r border-industrial-border font-bold text-amber-500 whitespace-nowrap">
                      {formatCurrency(calculateGroupTotal(items))}
                    </td>
                    <td className="p-2 text-center">
                      <button
                        onClick={(e) => { e.stopPropagation(); onDelete(header.id); }}
                        className="text-zinc-700 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </td>
                  </tr>

                  {/* Group items */}
                  {isExpanded && items.map((item, itemIdx) => (
                    <tr
                      key={item.id}
                      className="border-t border-[#1a1a1a] hover:bg-stone-900/50 transition-colors group/item"
                    >
                      {/* Sticky # cell for group items */}
                      <td className="p-2 text-center border-r border-industrial-border text-zinc-600 text-[9px] sticky left-0 z-10 bg-[#111] whitespace-nowrap">
                        {groupIdx + 1}.{itemIdx + 1}
                      </td>

                      {/* Sticky Description cell for group items */}
                      <td className="p-2 border-r border-industrial-border pl-7 sticky left-8 z-10 bg-[#111] shadow-[2px_0_6px_rgba(0,0,0,0.5)]">
                        <div className="flex items-center gap-2">
                          <Package className="w-2.5 h-2.5 text-zinc-600 shrink-0" />
                          <div className="flex flex-col flex-1 min-w-0">
                            {renderDescriptionCell(item)}
                            {item.notes && (
                              <div className="text-[7px] text-zinc-600 font-mono truncate">{item.notes}</div>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* Material column - minimal width */}
                      <td className="p-2 border-r border-industrial-border">
                        {renderMaterialCell(item)}
                      </td>

                      {/* Quantity column - minimal */}
                      <td className="p-2 border-r border-industrial-border text-right whitespace-nowrap">
                        <div className="flex justify-end items-center gap-1">
                          {renderTextCell(item, 'quantity', 'number')}
                          {item.isOverridden && <Pencil className="w-2 h-2 text-amber-accent/60" />}
                        </div>
                      </td>

                      {/* Cost column - minimal */}
                      <td className="p-2 text-right border-r border-industrial-border font-bold text-zinc-300 whitespace-nowrap">
                        {(item.quantity * item.unitRate).toFixed(2)}
                      </td>

                      <td className="p-2 text-center">{renderActionButtons(item)}</td>
                    </tr>
                  ))}

                  {/* Group summary */}
                  {isExpanded && items.length > 0 && (
                    <tr className="bg-[#111] border-t border-[#1e1e1e]">
                      <td colSpan={6} className="p-1.5 px-3 text-right">
                        <div className="flex items-center justify-end gap-3 text-[8px] text-zinc-600 font-mono whitespace-nowrap">
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
            {organizedData.ungrouped.map((row, idx) => (
              <tr
                key={row.id}
                className="border-t border-industrial-border hover:bg-stone-900/50 transition-colors group"
              >
                {/* Sticky # cell for ungrouped rows */}
                <td className="p-2 text-center border-r border-industrial-border text-zinc-600 font-bold sticky left-0 z-10 bg-[#111] whitespace-nowrap">
                  {(organizedData.groups.size + idx + 1).toString().padStart(2, '0')}
                </td>

                {/* Sticky Description cell for ungrouped rows */}
                <td className="p-2 border-r border-industrial-border font-medium sticky left-8 z-10 bg-[#111] shadow-[2px_0_6px_rgba(0,0,0,0.5)]">
                  <div className="flex flex-col">
                    {renderDescriptionCell(row)}
                    {row.notes && (
                      <div className="text-[7px] text-zinc-600 font-mono">{row.notes}</div>
                    )}
                  </div>
                </td>

                {/* Material column - minimal */}
                <td className="p-2 border-r border-industrial-border">
                  {renderMaterialCell(row)}
                </td>

                {/* Quantity column - minimal */}
                <td className="p-2 border-r border-industrial-border text-right font-bold text-amber-accent whitespace-nowrap">
                  <div className="flex justify-end items-center gap-1">
                    {renderTextCell(row, 'quantity', 'number')}
                    {row.isOverridden && <Pencil className="w-2.5 h-2.5 text-amber-accent/60" />}
                  </div>
                </td>

                {/* Cost column - minimal */}
                <td className="p-2 text-right border-r border-industrial-border font-bold text-zinc-200 whitespace-nowrap">
                  {(row.quantity * row.unitRate).toFixed(2)}
                </td>

                <td className="p-2 text-center">{renderActionButtons(row)}</td>
              </tr>
            ))}

            {measurements.length === 0 && (
              <tr>
                <td colSpan={6} className="p-12 text-center text-zinc-700 uppercase tracking-widest leading-loose">
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
// components/TakeoffTable.tsx
import React, { useState } from 'react';
import { Trash2, Plus, Pencil, Check, Eye, EyeOff, ChevronDown, ChevronRight, FolderOpen, Package } from 'lucide-react';
import { cn, formatCurrency } from '../lib/utils';
import { TakeoffRow, MaterialSpec } from '../types';

interface TakeoffTableProps {
  measurements: TakeoffRow[];
  materials: MaterialSpec[];
  onUpdate: (id: string, updates: Partial<TakeoffRow>) => void;
  onDelete: (id: string) => void;
  onAddManual: () => void;
  onToggleVisibility: (id?: string) => void;
}

export function TakeoffTable({ measurements, materials, onUpdate, onDelete, onAddManual, onToggleVisibility }: TakeoffTableProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Organize measurements into groups
  const organizedData = React.useMemo(() => {
    const groups: Map<string, { header: TakeoffRow; items: TakeoffRow[] }> = new Map();
    const ungrouped: TakeoffRow[] = [];

    measurements.forEach(measurement => {
      if (measurement.isGroupHeader && measurement.groupId) {
        groups.set(measurement.groupId, {
          header: measurement,
          items: []
        });
      } else if (measurement.groupId && groups.has(measurement.groupId)) {
        groups.get(measurement.groupId)!.items.push(measurement);
      } else if (!measurement.isGroupHeader) {
        ungrouped.push(measurement);
      }
    });

    return { groups, ungrouped };
  }, [measurements]);

  const toggleGroup = (groupId: string) => {
    setExpandedGroups(prev => {
      const newSet = new Set(prev);
      if (newSet.has(groupId)) {
        newSet.delete(groupId);
      } else {
        newSet.add(groupId);
      }
      return newSet;
    });
  };

  const calculateGroupTotal = (items: TakeoffRow[], type: 'cost' | 'quantity' = 'cost') => {
    if (type === 'quantity') {
      return items.reduce((sum, item) => sum + item.quantity, 0);
    }
    return items.reduce((sum, item) => sum + (item.quantity * item.unitRate), 0);
  };

  const totalCost = measurements.reduce((sum, m) => sum + (m.quantity * m.unitRate), 0);
  const allVisible = measurements.every(m => m.isVisible !== false);

  const renderCell = (row: TakeoffRow, field: keyof TakeoffRow, type: 'text' | 'number' | 'material' = 'text') => {
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
              const matchedMaterial = materials.find(m => m.name === val);
              if (matchedMaterial) {
                const total = matchedMaterial.materialCost + matchedMaterial.laborCost + matchedMaterial.equipmentCost;
                onUpdate(row.id, { 
                  description: matchedMaterial.name,
                  unitRate: total,
                  unit: matchedMaterial.unit
                });
              } else {
                onUpdate(row.id, { description: val });
              }
              setEditingId(null);
              setEditingField(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            className="w-full bg-stone-900 border border-amber-accent text-[11px] font-mono p-1 outline-none text-zinc-200"
          >
            <option value={value as string}>{value}</option>
            {materials.map(m => (
              <option key={m.id} value={m.name}>
                {m.code} - {m.name} ({formatCurrency(m.materialCost + m.laborCost + m.equipmentCost)}/{m.unit})
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
            setEditingId(null);
            setEditingField(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          className="w-full bg-stone-900 border border-amber-accent text-[11px] font-mono p-1 outline-none text-zinc-200"
        />
      );
    }

    return (
      <div 
        onClick={() => {
          if (!row.isGroupHeader) {
            setEditingId(row.id);
            setEditingField(field);
          }
        }}
        className={cn(
          "cursor-text hover:text-amber-accent transition-colors truncate min-h-[16px] w-full",
          row.isGroupHeader && "cursor-default"
        )}
      >
        {type === 'number' && typeof value === 'number' ? value.toFixed(2) : value as string}
      </div>
    );
  };

  return (
    <aside className="w-96 bg-industrial-panel border-l border-industrial-border flex flex-col h-full font-mono">
      <div className="p-3 border-b border-industrial-border bg-stone-900/50 flex justify-between items-center">
        <span className="text-[10px] font-bold text-zinc-500 tracking-widest uppercase">Takeoff Data</span>
        <div className="flex items-center gap-3">
          <button 
            onClick={() => onToggleVisibility()}
            className="text-zinc-500 hover:text-amber-accent transition-colors flex items-center gap-1 text-[10px] font-bold"
            title={allVisible ? "Hide All" : "Show All"}
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
        </div>
      </div>

      <div className="flex-1 overflow-auto custom-scrollbar">
        <table className="w-full text-[10px] border-collapse">
          <thead className="bg-stone-900/80 sticky top-0 z-10">
            <tr className="border-b border-industrial-border text-zinc-500 uppercase tracking-tighter">
              <th className="p-2 text-center w-8 border-r border-industrial-border">#</th>
              <th className="p-2 border-r border-industrial-border">Description</th>
              <th className="p-2 border-r border-industrial-border text-right">Qty</th>
              <th className="p-2 border-r border-industrial-border">Unit</th>
              <th className="p-2 border-r border-industrial-border text-right">Rate</th>
              <th className="p-2 border-r border-industrial-border">Cost</th>
              <th className="p-2 w-16 text-center">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-industrial-border">
            {/* Render Groups */}
            {Array.from(organizedData.groups.entries()).map(([groupId, { header, items }], groupIdx) => {
              const isExpanded = expandedGroups.has(groupId);
              
              return (
                <React.Fragment key={groupId}>
                  {/* Group Header Row */}
                  <tr 
                    className="border-t border-amber-500/20 bg-[#1a1a1a] cursor-pointer hover:bg-[#222] transition-colors group"
                    onClick={() => toggleGroup(groupId)}
                  >
                    <td className="p-2 text-center border-r border-industrial-border text-amber-500 font-bold">
                      {groupIdx + 1}
                    </td>
                    <td className="p-2 border-r border-industrial-border">
                      <div className="flex items-center gap-2">
                        {isExpanded ? 
                          <ChevronDown className="w-3 h-3 text-amber-500" /> : 
                          <ChevronRight className="w-3 h-3 text-amber-500" />
                        }
                        <FolderOpen className="w-3 h-3 text-amber-500/60" />
                        <span className="text-[11px] font-bold text-amber-500 uppercase tracking-wider">
                          {header.groupName}
                        </span>
                        <span className="text-[8px] text-zinc-600 ml-2">
                          ({items.length} items)
                        </span>
                      </div>
                    </td>
                    <td className="p-2 border-r border-industrial-border text-right">
                      <span className="text-[11px] font-mono text-amber-400">
                        {calculateGroupTotal(items, 'quantity').toFixed(1)}
                      </span>
                    </td>
                    <td className="p-2 border-r border-industrial-border">
                      <span className="text-[9px] text-zinc-600">assembly</span>
                    </td>
                    <td className="p-2 border-r border-industrial-border text-right">
                      <span className="text-[11px] font-mono text-zinc-500">-</span>
                    </td>
                    <td className="p-2 text-right border-r border-industrial-border font-bold text-amber-500">
                      {formatCurrency(calculateGroupTotal(items))}
                    </td>
                    <td className="p-2 text-center">
                      <div className="flex items-center justify-center gap-2">
                        <button 
                          onClick={() => onDelete(header.id)}
                          className="text-zinc-700 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </td>
                  </tr>
                  
                  {/* Group Items (if expanded) */}
                  {isExpanded && items.map((item, itemIdx) => (
                    <tr key={item.id} className="border-t border-[#1a1a1a] hover:bg-stone-900/50 transition-colors group/item">
                      <td className="p-2 text-center border-r border-industrial-border text-zinc-600 text-[9px]">
                        {groupIdx + 1}.{itemIdx + 1}
                      </td>
                      <td className="p-2 border-r border-industrial-border pl-7">
                        <div className="flex items-center gap-2">
                          <Package className="w-2.5 h-2.5 text-zinc-600 shrink-0" />
                          <div className="flex flex-col flex-1 min-w-0">
                            <div className="text-zinc-300 text-[10px]">
                              {renderCell(item, 'description', item.category === 'Board Materials' ? 'material' : 'text')}
                            </div>
                            {item.notes && (
                              <div className="text-[7px] text-zinc-600 font-mono truncate">
                                {item.notes}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="p-2 border-r border-industrial-border text-right">
                        <div className="flex justify-end items-center gap-1">
                          {renderCell(item, 'quantity', 'number')}
                          {item.isOverridden && (
                            <Pencil className="w-2 h-2 text-amber-accent/60" />
                          )}
                        </div>
                      </td>
                      <td className="p-2 border-r border-industrial-border text-zinc-500">
                        {renderCell(item, 'unit')}
                      </td>
                      <td className="p-2 border-r border-industrial-border text-right">
                        {renderCell(item, 'unitRate', 'number')}
                      </td>
                      <td className="p-2 text-right border-r border-industrial-border font-bold text-zinc-300">
                        {(item.quantity * item.unitRate).toFixed(2)}
                      </td>
                      <td className="p-2 text-center">
                        <div className="flex items-center justify-center gap-2">
                          <label className="cursor-pointer">
                            <input 
                              type="color" 
                              value={item.color || '#EF9F27'} 
                              onChange={(e) => onUpdate(item.id, { color: e.target.value })}
                              className="opacity-0 w-0 h-0 absolute pointer-events-none" 
                            />
                            <div 
                              className="w-3 h-3 rounded-full shadow-sm hover:scale-110 transition-transform" 
                              style={{ backgroundColor: item.color || '#EF9F27' }}
                            />
                          </label>
                          <button 
                            onClick={() => onToggleVisibility(item.id)}
                            className={cn(
                              "transition-colors",
                              item.isVisible !== false ? "text-zinc-500 hover:text-amber-accent" : "text-zinc-700 hover:text-amber-accent"
                            )}
                          >
                            {item.isVisible !== false ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                          </button>
                          <button 
                            onClick={() => onDelete(item.id)}
                            className="text-zinc-700 hover:text-red-500 transition-colors opacity-0 group-hover/item:opacity-100"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  
                  {/* Group Summary (if expanded) */}
                  {isExpanded && items.length > 0 && (
                    <tr className="bg-[#111] border-t border-[#1e1e1e]">
                      <td colSpan={7} className="p-1.5 px-3 text-right">
                        <div className="flex items-center justify-end gap-3 text-[8px] text-zinc-600 font-mono">
                          <span>Subtotal: {formatCurrency(calculateGroupTotal(items))}</span>
                          <span className="w-px h-2 bg-zinc-700" />
                          <span>+10% waste: {formatCurrency(calculateGroupTotal(items) * 0.1)}</span>
                          <span className="w-px h-2 bg-zinc-700" />
                          <span className="text-amber-500">
                            Total: {formatCurrency(calculateGroupTotal(items) * 1.1)}
                          </span>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
            
            {/* Ungrouped Items (simple presets) */}
            {organizedData.ungrouped.map((row, idx) => (
              <tr key={row.id} className="border-t border-industrial-border hover:bg-stone-900/50 transition-colors group">
                <td className="p-2 text-center border-r border-industrial-border text-zinc-600 font-bold">
                  {(organizedData.groups.size + idx + 1).toString().padStart(2, '0')}
                </td>
                <td className="p-2 border-r border-industrial-border font-medium text-zinc-200">
                  <div className="flex flex-col">
                    {renderCell(row, 'description', 'material')}
                    {row.notes && (
                      <div className="text-[7px] text-zinc-600 font-mono">{row.notes}</div>
                    )}
                  </div>
                </td>
                <td className="p-2 border-r border-industrial-border text-right font-bold text-amber-accent relative">
                  <div className="flex justify-end items-center gap-1">
                    {renderCell(row, 'quantity', 'number')}
                    {row.isOverridden && (
                      <Pencil className="w-2.5 h-2.5 text-amber-accent/60" />
                    )}
                  </div>
                </td>
                <td className="p-2 border-r border-industrial-border text-zinc-500">
                  {renderCell(row, 'unit')}
                </td>
                <td className="p-2 border-r border-industrial-border text-right text-zinc-500">
                  {renderCell(row, 'unitRate', 'number')}
                </td>
                <td className="p-2 text-right border-r border-industrial-border font-bold text-zinc-200">
                  {(row.quantity * row.unitRate).toFixed(2)}
                </td>
                <td className="p-2 text-center">
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
                        "transition-colors",
                        row.isVisible !== false ? "text-zinc-500 hover:text-amber-accent" : "text-zinc-700 hover:text-amber-accent"
                      )}
                    >
                      {row.isVisible !== false ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                    </button>
                    <button 
                      onClick={() => onDelete(row.id)}
                      className="text-zinc-700 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}

            {measurements.length === 0 && (
              <tr>
                <td colSpan={7} className="p-12 text-center text-zinc-700 uppercase tracking-widest leading-loose">
                  No active measurements.<br />Click canvas tools to begin.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="p-4 bg-stone-900 border-t border-industrial-border">
        <div className="mb-4">
          <div className="flex justify-between items-end mb-1">
            <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Total Estimated cost</span>
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
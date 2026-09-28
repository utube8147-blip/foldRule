// components/TakeoffTable.tsx
import React, { useState, useCallback } from 'react';
import { Trash2, Plus, Pencil, Eye, EyeOff, ChevronDown, ChevronRight, FolderOpen, Package, ExternalLink, ChevronUp, AlertTriangle, X, Copy, Check } from 'lucide-react';
import { cn, formatCurrency } from '@/lib/utils';
import { TakeoffRow, Material } from '@/types';

interface TakeoffTableProps {
  measurements: TakeoffRow[];
  materials: Material[];
  onUpdate: (id: string, updates: Partial<TakeoffRow>) => void;
  onDelete: (id: string) => void;
  onAddManual: () => void;
  onToggleVisibility: (id?: string) => void;
  onExpand?: () => void;
  onAddSegmentToGroup?: (groupId: string, groupType: string) => void;
  batchUpdateMeasurements?: (updates: { id: string; updates: Partial<TakeoffRow> }[]) => void;
}

// ─── Confirmation Dialog Component ───────────────────────────────────────────
interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  type?: 'danger' | 'warning' | 'info';
}

function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmText = 'Delete',
  cancelText = 'Cancel',
  onConfirm,
  onCancel,
  type = 'danger'
}: ConfirmDialogProps) {
  if (!isOpen) return null;

  const typeStyles = {
    danger: {
      icon: <AlertTriangle className="w-5 h-5 text-red-500" />,
      button: 'bg-red-600 hover:bg-red-700 text-white',
      border: 'border-red-500/30'
    },
    warning: {
      icon: <AlertTriangle className="w-5 h-5 text-amber-500" />,
      button: 'bg-amber-600 hover:bg-amber-700 text-white',
      border: 'border-amber-500/30'
    },
    info: {
      icon: <AlertTriangle className="w-5 h-5 text-blue-500" />,
      button: 'bg-blue-600 hover:bg-blue-700 text-white',
      border: 'border-blue-500/30'
    }
  };

  const style = typeStyles[type];

  return (
    <>
      <div
        className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 animate-in fade-in duration-200"
        onClick={onCancel}
      />
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-96 animate-in zoom-in-95 fade-in duration-200">
        <div className={cn("bg-stone-900 border rounded-lg shadow-2xl", style.border)}>
          <div className="flex items-center justify-between p-4 border-b border-stone-800">
            <div className="flex items-center gap-3">
              <div className="p-1.5 bg-stone-800/50 rounded-full">{style.icon}</div>
              <h3 className="text-sm font-bold text-zinc-100 uppercase tracking-wider">{title}</h3>
            </div>
            <button onClick={onCancel} className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors rounded-lg hover:bg-stone-800">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="p-4">
            <p className="text-xs text-zinc-400 leading-relaxed font-mono">{message}</p>
          </div>
          <div className="flex items-center justify-end gap-2 p-4 border-t border-stone-800 bg-stone-900/50 rounded-b-lg">
            <button onClick={onCancel} className="px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest text-zinc-400 hover:text-zinc-200 transition-colors">
              {cancelText}
            </button>
            <button onClick={onConfirm} className={cn("px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest rounded transition-all", style.button)}>
              {confirmText}
            </button>
          </div>
        </div>
      </div>
      <style>{`
        @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes zoom-in-95 { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
        .animate-in { animation-duration: 0.2s; animation-fill-mode: both; }
        .fade-in { animation-name: fade-in; }
        .zoom-in-95 { animation-name: zoom-in-95; }
      `}</style>
    </>
  );
}

// ─── useCopyToClipboard hook ─────────────────────────────────────────────
function useCopyToClipboard() {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = useCallback((id: string, text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      if (timerRef.current) clearTimeout(timerRef.current);
      setCopiedId(id);
      timerRef.current = setTimeout(() => setCopiedId(null), 1500);
    }).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      if (timerRef.current) clearTimeout(timerRef.current);
      setCopiedId(id);
      timerRef.current = setTimeout(() => setCopiedId(null), 1500);
    });
  }, []);

  React.useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return { copiedId, copy };
}

// ─── Component ────────────────────────────────────────────────────────────────

function TakeoffTableImpl({
  measurements,
  materials,
  onUpdate,
  onDelete,
  onAddManual,
  onToggleVisibility,
  onExpand,
  onAddSegmentToGroup,
  batchUpdateMeasurements,
}: TakeoffTableProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);

  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    groupName: string;
    groupId: string;
  }>({ isOpen: false, groupName: '', groupId: '' });

  const { copiedId, copy } = useCopyToClipboard();

  const stopEditing = () => {
    setEditingId(null);
    setEditingField(null);
    setEditingGroupId(null);
  };

  const startEditing = (id: string, field: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setEditingId(id);
    setEditingField(field);
  };

  const startEditingGroup = (groupId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setEditingGroupId(groupId);
  };

  const getMaterial = (materialId?: string) => materials.find((m) => m.id === materialId);

  const toggleRowExpand = (id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const organizedData = React.useMemo(() => {
    const groups: Map<string, { header: TakeoffRow; items: TakeoffRow[] }> = new Map();
    const ungrouped: TakeoffRow[] = [];

    // Pass 1: register every group header (order in the array doesn't matter).
    for (const m of measurements) {
      if (!m.isGroupHeader) continue;
      if (m.groupId) groups.set(m.groupId, { header: m, items: [] });
      else if (m.childIds) groups.set(m.id, { header: m, items: [] });
    }
    // Pass 2: attach children; anything whose group no longer exists is shown
    // as ungrouped instead of silently disappearing from the table.
    for (const m of measurements) {
      if (m.isGroupHeader) continue;
      const g =
        (m.groupId  && groups.get(m.groupId)) ||
        (m.parentId && groups.get(m.parentId)) ||
        null;
      if (g) g.items.push(m);
      else ungrouped.push(m);
    }

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

  const totalCost  = React.useMemo(
    () => measurements.reduce((sum, m) => sum + m.quantity * m.unitRate, 0),
    [measurements],
  );
  const allVisible = React.useMemo(() => measurements.every((m) => m.isVisible !== false), [measurements]);

  const batchUpdateGroup = useCallback((groupId: string, items: TakeoffRow[], updates: Partial<TakeoffRow>) => {
    if (!batchUpdateMeasurements) {
      items.forEach(item => onUpdate(item.id, updates));
      return;
    }
    batchUpdateMeasurements(items.map(item => ({ id: item.id, updates })));
  }, [batchUpdateMeasurements, onUpdate]);

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
        className={cn('cursor-text hover:text-amber-accent transition-colors block truncate max-w-[200px]', className)}
        style={{ 
          display: 'block',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}
      >
        {type === 'number' && typeof value === 'number' ? value.toFixed(3) : (value as string)}
      </span>
    );
  };

  const renderEditableQuantity = (row: TakeoffRow) => {
    const isEditing = editingId === row.id && editingField === 'quantity';
    const value = row.quantity;
    const isCopied = copiedId === row.id;
    const copyText = `${value.toFixed(3)} ${row.unit ?? ''}`.trim();

    if (isEditing) {
      return (
        <input
          autoFocus
          type="number"
          step="0.01"
          defaultValue={value}
          onBlur={(e) => {
            const val = parseFloat(e.target.value);
            onUpdate(row.id, { quantity: isNaN(val) ? 0 : val });
            stopEditing();
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          onClick={(e) => e.stopPropagation()}
          className="w-20 bg-stone-900 border border-amber-accent text-[11px] font-mono p-1 outline-none text-zinc-200 text-right"
        />
      );
    }

    return (
      <div className="flex items-center justify-end gap-1 group/qty">
        <button
          onClick={(e) => { e.stopPropagation(); copy(row.id, copyText); }}
          className={cn(
            'opacity-0 group-hover/qty:opacity-100 transition-all duration-150 p-0.5 -ml-8 rounded',
            isCopied
              ? 'text-green-400 opacity-100'
              : 'text-zinc-600 hover:text-amber-400',
          )}
          title={`Copy: ${copyText}`}
        >
          {isCopied
            ? <Check className="w-2.5 h-2.5" />
            : <Copy className="w-2.5 h-2.5" />}
        </button>

        <span
          onClick={(e) => startEditing(row.id, 'quantity', e)}
          className="cursor-text hover:text-amber-accent transition-colors font-mono font-bold text-amber-accent"
        >
          {value.toFixed(3)}
        </span>
        {row.isOverridden && <Pencil className="w-2 h-2 text-amber-accent/60" />}
        {row.unit && <span className="text-[9px] text-zinc-600">{row.unit}</span>}
      </div>
    );
  };

  const renderMaterialSelect = (row: TakeoffRow) => {
    const isEditing = editingId === row.id && editingField === 'materialId';
    const matched = getMaterial(row.materialId);
    const getMaterialTotal = (mat: Material) => (mat.materialCost ?? 0) + (mat.laborCost ?? 0) + (mat.equipmentCost ?? 0) || mat.unitRate || 0;

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
              {m.code || m.id.slice(0, 6)} – {m.name} ({formatCurrency(getMaterialTotal(m))}/{m.unit})
            </option>
          ))}
        </select>
      );
    }

    return (
      <span onClick={(e) => startEditing(row.id, 'materialId', e)} className="cursor-pointer hover:text-amber-accent transition-colors">
        {matched ? (
          <span className="flex flex-col gap-0.5">
            <span className="text-[10px] text-zinc-300 font-mono">{matched.code || matched.id.slice(0, 6)}</span>
            <span className="text-[8px] text-zinc-500 leading-tight truncate max-w-[150px]">{matched.name}</span>
          </span>
        ) : (
          <span className="text-[10px] text-zinc-600 italic">— assign —</span>
        )}
      </span>
    );
  };

  const renderRowActions = (row: TakeoffRow) => (
    <div className="flex items-center justify-end gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
      <label className="cursor-pointer">
        <input
          type="color"
          value={row.color || '#EF9F27'}
          onChange={(e) => { e.stopPropagation(); onUpdate(row.id, { color: e.target.value }); }}
          onClick={(e) => e.stopPropagation()}
          className="opacity-0 w-0 h-0 absolute pointer-events-none"
        />
        <div className="w-3 h-3 rounded-full shadow-sm hover:scale-110 transition-transform" style={{ backgroundColor: row.color || '#EF9F27' }} />
      </label>
      <button
        onClick={(e) => { e.stopPropagation(); onToggleVisibility(row.id); }}
        className={cn('transition-colors', row.isVisible !== false ? 'text-zinc-500 hover:text-amber-accent' : 'text-zinc-700 hover:text-amber-accent')}
      >
        {row.isVisible !== false ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
      </button>
      <button onClick={(e) => { e.stopPropagation(); onDelete(row.id); }} className="text-zinc-700 hover:text-red-500 transition-colors">
        <Trash2 className="w-3 h-3" />
      </button>
    </div>
  );

  const renderDetailPanel = (row: TakeoffRow) => {
    const itemTotalCost = row.quantity * row.unitRate;
    return (
      <tr key={`${row.id}-detail`} className="bg-[#0d0d0d]">
        <td colSpan={3} className="px-3 pb-3 pt-0">
          <div className="border border-zinc-800 rounded-sm bg-[#111] p-3 mt-1 space-y-3">
            {row.label && (
              <div className="flex items-start gap-3">
                <span className="text-[8px] text-zinc-600 uppercase tracking-widest w-16 shrink-0 pt-0.5">Label</span>
                <span className="text-[9px] text-zinc-400 font-mono truncate">{row.label}</span>
              </div>
            )}
            <div className="flex items-start gap-3">
              <span className="text-[8px] text-zinc-600 uppercase tracking-widest w-16 shrink-0 pt-0.5">Material</span>
              <div className="flex-1 min-w-0">{renderMaterialSelect(row)}</div>
            </div>
            <div className="flex gap-4">
              <div className="flex items-center gap-3 flex-1">
                <span className="text-[8px] text-zinc-600 uppercase tracking-widest w-16 shrink-0">Rate</span>
                {renderEditableText(row, 'unitRate', 'number', 'text-[11px] text-zinc-300 font-mono')}
                <span className="text-[9px] text-zinc-600">/ {row.unit || 'unit'}</span>
              </div>
              <div className="flex items-center gap-3 flex-1">
                <span className="text-[8px] text-zinc-600 uppercase tracking-widest w-16 shrink-0">Cost</span>
                <span className="text-[11px] font-bold text-amber-accent">{formatCurrency(itemTotalCost)}</span>
              </div>
            </div>
            {row.notes && (
              <div className="flex items-start gap-3">
                <span className="text-[8px] text-zinc-600 uppercase tracking-widest w-16 shrink-0 pt-0.5">Notes</span>
                <span className="text-[9px] text-zinc-500 font-mono truncate">{row.notes}</span>
              </div>
            )}
          </div>
        </td>
      </tr>
    );
  };

  return (
    <aside className="w-full min-w-0 bg-industrial-panel border-l border-industrial-border flex flex-col h-full font-mono">
      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        title="Delete Group"
        message={`Are you sure you want to delete "${confirmDialog.groupName}" and all its items? This action cannot be undone.`}
        confirmText="Delete Group"
        cancelText="Cancel"
        type="danger"
        onConfirm={() => { onDelete(confirmDialog.groupId); setConfirmDialog({ isOpen: false, groupName: '', groupId: '' }); }}
        onCancel={() => setConfirmDialog({ isOpen: false, groupName: '', groupId: '' })}
      />

      <div className="p-3 border-b border-industrial-border bg-stone-900/50 flex justify-between items-center flex-shrink-0">
        <span className="text-[10px] font-bold text-zinc-500 tracking-widest uppercase">Takeoff Data</span>
        <div className="flex items-center gap-3">
          <button onClick={() => onToggleVisibility()} className="text-zinc-500 hover:text-amber-accent transition-colors flex items-center gap-1 text-[10px] font-bold" title={allVisible ? 'Hide All' : 'Show All'}>
            {allVisible ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
          </button>
          <button onClick={onAddManual} className="text-zinc-500 hover:text-amber-accent transition-colors flex items-center gap-1 text-[10px] font-bold">
            <Plus className="w-3 h-3" /> ADD ROW
          </button>
          {onExpand && (
            <>
              <div className="w-px h-3 bg-zinc-700" />
              <button onClick={onExpand} className="text-zinc-500 hover:text-amber-400 transition-colors flex items-center gap-1 text-[10px] font-bold" title="Open full-page takeoff view">
                <ExternalLink className="w-3 h-3" /> EXPAND
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto custom-scrollbar">
        <table className="w-full text-[10px] border-collapse">
          <thead className="bg-stone-900/80 sticky top-0 z-20">
            <tr className="border-b border-industrial-border text-zinc-500 uppercase tracking-tighter">
              <th className="p-2 text-center w-8 border-r border-industrial-border">#</th>
              <th className="p-2 border-r border-industrial-border text-left max-w-[150px]">Description</th>
              <th className="p-2 text-right pr-3">Qty / Actions</th>
            </tr>
          </thead>

          <tbody className="divide-y divide-industrial-border">
            {Array.from(organizedData.groups.entries()).map(([groupId, { header, items }], groupIdx) => {
              const isGroupExpanded = expandedGroups.has(groupId);
              const groupTotalQuantity = calculateGroupTotal(items, 'quantity');
              const isEditingGroup = editingGroupId === groupId;

              // ── FIX: group is "all visible" only when BOTH the header AND
              //         all children have isVisible !== false.
              //         This keeps the eye icon in sync with the actual canvas state.
              const allItemsVisible =
                header.isVisible !== false &&
                items.every(item => item.isVisible !== false);

              const groupCopyText = `${groupTotalQuantity.toFixed(3)} ${items[0]?.unit ?? ''}`.trim();
              const isGroupCopied = copiedId === `group-${groupId}`;

              return (
                <React.Fragment key={groupId}>
                  <tr
                    className="border-t border-amber-500/20 bg-[#1a1a1a] cursor-pointer hover:bg-[#222] transition-colors group"
                    onClick={() => toggleGroup(groupId)}
                  >
                    <td className="p-2 text-center border-r border-industrial-border text-amber-500 font-bold whitespace-nowrap">
                      {groupIdx + 1}
                    </td>
                    <td className="p-2 border-r border-industrial-border max-w-[150px]">
                      <div className="flex items-center gap-2">
                        {isGroupExpanded ? <ChevronDown className="w-3 h-3 text-amber-500 shrink-0" /> : <ChevronRight className="w-3 h-3 text-amber-500 shrink-0" />}
                        <FolderOpen className="w-3 h-3 text-amber-500/60 shrink-0" />
                        {isEditingGroup ? (
                          <input
                            autoFocus
                            type="text"
                            defaultValue={header.groupName || header.description}
                            onBlur={(e) => {
                              const newName = e.target.value;
                              onUpdate(header.id, { groupName: newName, description: newName });
                              stopEditing();
                            }}
                            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                            onClick={(e) => e.stopPropagation()}
                            className="bg-stone-900 border border-amber-accent text-[11px] font-mono p-1 outline-none text-zinc-200 flex-1 min-w-0"
                          />
                        ) : (
                          <span
                            className="text-[11px] font-bold text-amber-500 uppercase tracking-wider truncate cursor-text hover:text-amber-300 transition-colors"
                            style={{
                              display: 'block',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              maxWidth: '180px'
                            }}
                            onClick={(e) => startEditingGroup(groupId, e)}
                          >
                            {header.groupName || header.description}
                          </span>
                        )}
                        <span className="text-[8px] text-zinc-600 shrink-0">({items.length})</span>
                      </div>
                    </td>
                    <td className="p-2 text-right pr-3">
                      <div className="flex items-center justify-end gap-3">
                        <div className="flex items-center gap-1 group/gqty">
                          <button
                            onClick={(e) => { e.stopPropagation(); copy(`group-${groupId}`, groupCopyText); }}
                            className={cn(
                              'opacity-0 group-hover/gqty:opacity-100 transition-all duration-150 p-0.5 -ml-12 rounded',
                              isGroupCopied ? 'text-green-400 opacity-100' : 'text-zinc-600 hover:text-amber-400',
                            )}
                            title={`Copy: ${groupCopyText}`}
                          >
                            {isGroupCopied ? <Check className="w-2.5 h-2.5" /> : <Copy className="w-2.5 h-2.5" />}
                          </button>
                          <span className="font-bold text-amber-500 whitespace-nowrap">
                            {groupTotalQuantity.toFixed(3)} {items[0]?.unit || ''}
                          </span>
                        </div>

                        <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                          <label className="cursor-pointer">
                            <input
                              type="color"
                              value={header.color || '#EF9F27'}
                              onChange={(e) => {
                                e.stopPropagation();
                                const color = e.target.value;
                                onUpdate(header.id, { color });
                                batchUpdateGroup(groupId, items, { color });
                              }}
                              onClick={(e) => e.stopPropagation()}
                              className="opacity-0 w-0 h-0 absolute pointer-events-none"
                            />
                            <div className="w-3 h-3 rounded-full shadow-sm hover:scale-110 transition-transform" style={{ backgroundColor: header.color || '#EF9F27' }} />
                          </label>

                          {/* ── FIX: single source of truth for the toggle.
                                    Always batch-update header + all children together
                                    so isVisible stays in sync across the whole group. */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              const newVisibility = !allItemsVisible;
                              // Update header and all children in one atomic batch
                              onUpdate(header.id, { isVisible: newVisibility });
                              batchUpdateGroup(groupId, items, { isVisible: newVisibility });
                            }}
                            className={cn(
                              'transition-colors',
                              allItemsVisible
                                ? 'text-zinc-500 hover:text-amber-accent'
                                : 'text-zinc-700 hover:text-amber-accent',
                            )}
                            title={allItemsVisible ? 'Hide group' : 'Show group'}
                          >
                            {allItemsVisible
                              ? <Eye className="w-3 h-3" />
                              : <EyeOff className="w-3 h-3" />}
                          </button>

                          <button
                            onClick={(e) => { e.stopPropagation(); onAddSegmentToGroup?.(groupId, header.groupType || header.type); }}
                            className="text-zinc-600 hover:text-blue-400 transition-colors"
                            title="Add segment to this group"
                          >
                            <Plus className="w-3 h-3" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmDialog({
                                isOpen: true,
                                groupName: header.groupName || header.description || 'this group',
                                groupId: header.id,
                              });
                            }}
                            className="text-zinc-700 hover:text-red-500 transition-colors"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>

                  {isGroupExpanded && items.map((item, itemIdx) => {
                    const isRowExpanded = expandedRows.has(item.id);
                    return (
                      <React.Fragment key={item.id}>
                        <tr
                          className={cn('border-t border-[#1a1a1a] transition-colors cursor-pointer', isRowExpanded ? 'bg-stone-900' : 'hover:bg-stone-900/50')}
                          onClick={() => toggleRowExpand(item.id)}
                        >
                          <td className="p-2 text-center border-r border-industrial-border text-zinc-600 text-[9px] whitespace-nowrap">
                            {groupIdx + 1}.{itemIdx + 1}
                          </td>
                          <td className="p-2 border-r border-industrial-border pl-7 max-w-[150px]">
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
                                  style={{
                                    display: 'block',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap'
                                  }}
                                  onClick={(e) => startEditing(item.id, 'description', e)}
                                >
                                  {item.description || <span className="text-zinc-600 italic">No description</span>}
                                </span>
                              )}
                              <span className="text-zinc-700 shrink-0">
                                {isRowExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                              </span>
                            </div>
                          </td>
                          <td className="p-2 text-right pr-1">
                            <div className="flex items-center justify-end gap-3">
                              {renderEditableQuantity(item)}
                              {renderRowActions(item)}
                            </div>
                          </td>
                        </tr>
                        {isRowExpanded && renderDetailPanel(item)}
                      </React.Fragment>
                    );
                  })}
                </React.Fragment>
              );
            })}

            {organizedData.ungrouped.map((row, idx) => {
              const isRowExpanded = expandedRows.has(row.id);
              return (
                <React.Fragment key={row.id}>
                  <tr
                    className={cn('border-t border-industrial-border transition-colors cursor-pointer', isRowExpanded ? 'bg-stone-900' : 'hover:bg-stone-900/50')}
                    onClick={() => toggleRowExpand(row.id)}
                  >
                    <td className="p-2 text-center border-r border-industrial-border text-zinc-600 font-bold whitespace-nowrap">
                      {(organizedData.groups.size + idx + 1).toString().padStart(2, '0')}
                    </td>
                    <td className="p-2 border-r border-industrial-border font-medium max-w-[150px]">
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
                            style={{
                              display: 'block',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap'
                            }}
                            onClick={(e) => startEditing(row.id, 'description', e)}
                          >
                            {row.description || <span className="text-zinc-600 italic">No description</span>}
                          </span>
                        )}
                        <span className="text-zinc-700 shrink-0">
                          {isRowExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                        </span>
                      </div>
                    </td>
                    <td className="p-2 text-right pr-1">
                      <div className="flex items-center justify-end gap-3">
                        {renderEditableQuantity(row)}
                        {renderRowActions(row)}
                      </div>
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

/** Memoized: skips re-rendering when its props are unchanged. */
export const TakeoffTable = React.memo(TakeoffTableImpl);

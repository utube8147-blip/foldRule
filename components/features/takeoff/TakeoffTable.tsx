// components/TakeoffTable.tsx
import { reviewProgress } from '@/lib/takeoff/revisions';
import { POMI_SECTIONS, classify } from '@/lib/takeoff/pomi';
import { timesIndex, billedQuantities, timesLabel } from '@/lib/takeoff/timesing';
import { explainDerived } from '@/lib/takeoff/assemblies';
import { ColorSwatchPicker } from '@/components/common/ColorSwatchPicker';
import { PALETTE_GRID } from '@/hooks/measurements/useMeasurements/colors';
import React, { useState, useCallback } from 'react';
import { Trash2, Plus, Pencil, Eye, EyeOff, ChevronDown, ChevronRight, FolderOpen, Package, ExternalLink, ChevronUp, AlertTriangle, X, Copy, Check, PanelRightClose } from 'lucide-react';
import { cn, formatCurrency } from '@/lib/utils';
import { TakeoffRow, Material } from '@/types';
import { useTakeoffData } from '@/context/TakeoffContext';
import { MaterialPicker } from '@/components/common/MaterialPicker';
import { useConfirm } from '@/components/common/ConfirmDialog';

interface TakeoffTableProps {
  measurements: TakeoffRow[];
  materials: Material[];
  onUpdate: (id: string, updates: Partial<TakeoffRow>) => void;
  onDelete: (id: string) => void;
  onAddManual: () => void;
  onToggleVisibility: (id?: string) => void;
  onExpand?: () => void;
  /** Collapse the takeoff panel (button at the end of the panel header). */
  onCollapse?: () => void;
  /** Open the project analysis (totals, unpriced rows, pages without a scale). */
  onOpenAnalysis?: () => void;
  onOpenCompare?: () => void;
  onOpenChanges?: () => void;
  onAddSegmentToGroup?: (groupId: string, groupType: string) => void;
  batchUpdateMeasurements?: (updates: { id: string; updates: Partial<TakeoffRow> }[]) => void;
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
  onCollapse,
  onOpenAnalysis,
  onOpenCompare,
  onOpenChanges,
  onAddSegmentToGroup,
  batchUpdateMeasurements,
}: TakeoffTableProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const { selectedId, focusMeasurement, setMaterialLibraryOpen, replaceMeasurements, ungroupMeasurements, projectState } = useTakeoffData();
  // Timesing: rows show what was measured; costs and totals use the billed quantity.
  const drawings = projectState.drawings;
  const timesOf = React.useMemo(() => timesIndex(measurements, drawings), [measurements, drawings]);
  const billed  = React.useMemo(() => billedQuantities(measurements, drawings), [measurements, drawings]);
  const bq = (r: TakeoffRow) => billed.get(r.id) ?? r.quantity;
  const review = React.useMemo(() => reviewProgress(measurements), [measurements]);

  // ── Moving a row to another group (drag & drop, or right-click → Move to) ──
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropGroup, setDropGroup] = useState<string | null>(null);
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; rowId: string; group?: boolean } | null>(null);
  const kindOf = (t: string) => (t === 'Polygon' || t === 'Rectangle' || t === 'Area' ? 'area' : t === 'Length' ? 'length' : t === 'Count' ? 'count' : t);
  /** Can this row go into that group? Same kind of quantity only (an area can't join a length group). */
  const canJoin = (row: TakeoffRow | undefined, header: TakeoffRow | undefined) =>
    !!row && !!header && !row.isGroupHeader && header.isGroupHeader && row.parentId !== header.id && kindOf(row.type) === kindOf(header.type);
  const moveRow = (rowId: string, targetId: string | null) => {
    const row = measurements.find(m => m.id === rowId);
    if (!row || row.isGroupHeader) return;
    if (targetId === null) {
      if (!row.parentId) return;
      replaceMeasurements([row.id], [{ ...row, parentId: undefined, groupId: undefined }]);
      return;
    }
    const header = measurements.find(m => m.id === targetId);
    if (!canJoin(row, header) || !header) return;
    const name = header.groupName || header.label || header.description || 'Group';
    const n = (header.childIds?.length ?? 0) + 1;
    // The row takes the group's name, colour and material, so it reads as part of it.
    replaceMeasurements([row.id], [{
      ...row, parentId: header.id, groupId: header.id, color: header.color,
      label: `${name} ${n}`, description: `${name} ${n}`,
      ...(header.materialId ? { materialId: header.materialId, unitRate: header.unitRate } : {}),
    }]);
    setExpandedGroups(prev => new Set(prev).add(header.groupId || header.id));
  };
  const uid = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `r-${Date.now()}-${Math.random()}`);
  const nudge = (r: TakeoffRow): TakeoffRow => ({
    ...r,
    points: (r.points ?? []).map((q: any) => (q && typeof q.x === 'number' && q.segmentId == null ? { ...q, x: q.x + 0.012, y: q.y + 0.012 } : q)),
    holes: r.holes?.map(h => h.map(q => ({ x: q.x + 0.012, y: q.y + 0.012 }))),
  });
  /** Turn one loose row into a group of its own, so more can be added to it later. */
  const makeGroupFrom = (rowId: string) => {
    const row = measurements.find(m => m.id === rowId);
    if (!row || row.isGroupHeader || row.parentId) return;
    const name = (row.description || row.label || 'Group').replace(/\s+\d+$/, '');
    const id = uid();
    replaceMeasurements([row.id], [
      { id, drawingId: row.drawingId, pageNumber: row.pageNumber, label: name, description: name, groupName: name,
        type: kindOf(row.type) === 'area' ? 'Polygon' : row.type, quantity: row.quantity, unit: row.unit, unitRate: row.unitRate ?? 0,
        materialId: row.materialId, notes: '', points: [], isOverridden: false, isGroupHeader: true, isExpanded: true,
        color: row.color, isVisible: true, childIds: [row.id] } as TakeoffRow,
      { ...row, parentId: id, groupId: id, label: `${name} 1`, description: `${name} 1` },
    ]);
    setExpandedGroups(prev => new Set(prev).add(id));
  };
  /** A copy of one row, placed just beside the original, in the same group. */
  const duplicateRow = (rowId: string) => {
    const row = measurements.find(m => m.id === rowId);
    if (!row || row.isGroupHeader) return;
    const name = `${row.description || row.label || 'Item'} copy`;
    replaceMeasurements([], [{ ...nudge(row), id: uid(), childIds: [], derived: undefined, label: name, description: name }]);
  };
  /**
   * A copy of a group with its material, rate, unit and settings.
   * `withShapes` false → an empty group ready to measure into (e.g. the next floor);
   * true → its shapes are copied too, placed just beside the originals.
   */
  const duplicateGroup = (headerId: string, withShapes: boolean) => {
    const header = measurements.find(m => m.id === headerId);
    if (!header) return;
    const gid = header.groupId || header.id;
    const kids = withShapes ? measurements.filter(m => !m.isGroupHeader && (m.parentId === header.id || m.groupId === gid)) : [];
    const base = header.groupName || header.label || header.description || 'Group';
    const taken = new Set(measurements.filter(m => m.isGroupHeader).map(m => (m.groupName || m.label || m.description || '').toLowerCase()));
    let name = `${base} copy`;
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base} copy ${i}`;
    const id = uid();
    const free = PALETTE_GRID.flatMap(h => [h.shades[2], h.shades[3], h.shades[1]]).find(c => !usedColors.some(u => (u || '').toLowerCase() === c.toLowerCase())) ?? header.color;
    const copies = kids.map((k, i) => ({
      ...nudge(k), id: uid(), parentId: id, groupId: id, childIds: [], derived: undefined, color: free,
      label: `${name} ${i + 1}`, description: `${name} ${i + 1}`,
    } as TakeoffRow));
    replaceMeasurements([], [{
      ...header, id, groupId: id, label: name, description: name, groupName: name, color: free,
      childIds: copies.map(c => c.id), quantity: copies.reduce((t, c) => t + c.quantity, 0), points: [], isExpanded: true,
    } as TakeoffRow, ...copies]);
    setExpandedGroups(prev => new Set(prev).add(id));
  };

  React.useEffect(() => {
    if (!rowMenu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      // Clicks and scrolling inside the menu itself must not close it.
      if (!(e instanceof KeyboardEvent) && (e.target as HTMLElement | null)?.closest?.('[data-row-menu]')) return;
      setRowMenu(null);
    };
    window.addEventListener('pointerdown', close, true); window.addEventListener('keydown', close, true); window.addEventListener('wheel', close, true);
    return () => { window.removeEventListener('pointerdown', close, true); window.removeEventListener('keydown', close, true); window.removeEventListener('wheel', close, true); };
  }, [rowMenu]);
  /** Props that make a row draggable and give it the right-click menu. */
  const rowMoveProps = (row: TakeoffRow) => ({
    draggable: editingId !== row.id,
    onDragStart: (e: React.DragEvent) => { e.dataTransfer.setData('text/plain', row.id); e.dataTransfer.effectAllowed = 'move'; setDragId(row.id); },
    onDragEnd: () => { setDragId(null); setDropGroup(null); },
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); setRowMenu({ x: e.clientX, y: e.clientY, rowId: row.id }); },
  });
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);

  const { confirm } = useConfirm();

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
      ? items.reduce((sum, i) => sum + bq(i), 0)
      : items.reduce((sum, i) => sum + bq(i) * i.unitRate, 0);

  // Bring the selected row into view (expanding its group if needed) when the
  // selection comes from the drawing.
  React.useEffect(() => {
    if (!selectedId) return;
    for (const [key, g] of organizedData.groups) {
      if (g.items.some(i => i.id === selectedId) && !expandedGroups.has(key)) {
        setExpandedGroups(prev => new Set(prev).add(key));
        break;
      }
    }
    const raf = requestAnimationFrame(() => {
      const row = bodyRef.current?.querySelector<HTMLElement>(`tr[data-row-id="${CSS.escape(selectedId)}"]`);
      row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Rows without any rate (their cost is missing from the total).
  const pricing = React.useMemo(() => {
    const items = measurements.filter(m => !m.isGroupHeader);
    const matRate = new Map(materials.map(mt => [mt.id, mt.unitRate]));
    const unpriced = items.filter(m => !(m.unitRate > 0) && !((m.materialId && matRate.get(m.materialId)) || 0));
    return { total: items.length, unpriced: unpriced.length };
  }, [measurements, materials]);

  const totalCost  = React.useMemo(
    () => measurements.reduce((sum, m) => sum + (m.isGroupHeader ? m.quantity : billed.get(m.id) ?? m.quantity) * m.unitRate, 0),
    [measurements, billed],
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
          className="w-full bg-stone-900 border border-amber-accent text-xs font-mono p-1 outline-none text-zinc-200"
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
          className="w-20 bg-stone-900 border border-amber-accent text-xs font-mono p-1 outline-none text-zinc-200 text-right"
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
        {row.unit && <span className="text-[10px] text-zinc-600">{row.unit}</span>}
        {timesOf(row).total !== 1 && (
          <span
            className="text-[10px] font-mono font-bold text-black bg-amber-accent px-1"
            title={`Timesing: billed as ${bq(row).toFixed(3)} ${row.unit ?? ''}`}
          >{timesLabel(timesOf(row).total)}</span>
        )}
      </div>
    );
  };

  const renderMaterialSelect = (row: TakeoffRow) => {
    const isEditing = editingId === row.id && editingField === 'materialId';
    const matched = getMaterial(row.materialId);
    const getMaterialTotal = (mat: Material) => (mat.materialCost ?? 0) + (mat.laborCost ?? 0) + (mat.equipmentCost ?? 0) || mat.unitRate || 0;

    if (isEditing) {
      return (
        <MaterialPicker
          size="sm"
          autoOpen
          materials={materials}
          value={row.materialId ?? null}
          measurementType={row.points?.length ? row.type : undefined}
          onOpenBank={() => { stopEditing(); setMaterialLibraryOpen(true); }}
          onClose={stopEditing}
          onChange={(id) => {
            const mat = id ? materials.find((m) => m.id === id) : undefined;
            if (mat) {
              // Measured rows keep their measured unit (m, m², EA); manual rows take the material's.
              onUpdate(row.id, {
                materialId: mat.id,
                unitRate: getMaterialTotal(mat),
                ...(row.points?.length ? {} : { unit: mat.unit }),
              });
            } else {
              onUpdate(row.id, { materialId: undefined });
            }
          }}
        />
      );
    }

    return (
      <span onClick={(e) => startEditing(row.id, 'materialId', e)} className="cursor-pointer hover:text-amber-accent transition-colors">
        {matched ? (
          <span className="flex flex-col gap-0.5">
            <span className="text-[11px] text-zinc-300 font-mono">{matched.code || matched.id.slice(0, 6)}</span>
            <span className="text-[10px] text-zinc-500 leading-tight truncate max-w-[150px]">{matched.name}</span>
          </span>
        ) : (
          <span className="text-[11px] text-zinc-600 italic">— assign —</span>
        )}
      </span>
    );
  };

  // Colours in use (one per group or loose row), so the picker can show which are free.
  const usedColors = Array.from(new Set(measurements.filter(m => m.isGroupHeader || !m.parentId).map(m => m.color).filter(Boolean)));

  const renderRowActions = (row: TakeoffRow) => (
    <div className="flex items-center justify-end gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
      {row.review?.status === 'check' && row.review.suggest && (
        <button
          type="button"
          onClick={() => {
            const s = row.review!.suggest!;
            replaceMeasurements([], [], { [row.id]: {
              points: s.points.map((p, i) => ({ ...row.points[i], ...p })), quantity: s.quantity,
              review: { revision: row.review!.revision, status: 'done' },
            } });
            focusMeasurement(row.id);
          }}
          title={`Suggested from the new plan’s lines: move the corners that shifted. Quantity ${row.quantity.toFixed(2)} → ${row.review.suggest.quantity.toFixed(2)} ${row.unit}. Ctrl+Z undoes it.`}
          className="text-[9px] font-mono font-black uppercase px-1 py-0.5 border border-amber-accent bg-amber-accent text-black"
        >Fix</button>
      )}
      {row.review && (
        <button
          type="button"
          onClick={() => onUpdate(row.id, { review: { ...row.review!, status: row.review!.status === 'check' ? 'done' : 'check' } })}
          title={row.review.status === 'check'
            ? 'This sits on a change in the new revision. Adjust it on the drawing, then click to tick it off.'
            : 'Checked against the new revision. Click to mark it for checking again.'}
          className={cn('text-[9px] font-mono font-black uppercase px-1 py-0.5 border',
            row.review.status === 'check' ? 'bg-red-500 border-red-500 text-white' : 'border-green-600 text-green-500')}
        >{row.review.status === 'check' ? 'Check' : '✓'}</button>
      )}
      <ColorSwatchPicker
        value={row.color || '#EF9F27'} used={usedColors} label={row.label || row.description}
        onChange={color => onUpdate(row.id, { color })}
      />
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

  const renderMaterialChip = (row: TakeoffRow) => {
    const mat = getMaterial(row.materialId);
    const open = (e: React.MouseEvent) => {
      e.stopPropagation();
      setExpandedRows(prev => new Set(prev).add(row.id));
      startEditing(row.id, 'materialId', e);
    };
    return (
      <button
        type="button"
        onClick={open}
        title={mat ? 'Change material' : 'Assign a material from the bank'}
        className={cn(
          'mt-0.5 block max-w-full truncate text-left text-[10px] font-mono transition-colors',
          mat ? 'text-zinc-500 hover:text-amber-accent' : 'text-zinc-700 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-amber-accent',
        )}
      >
        {mat ? `${mat.code ? `${mat.code} · ` : ''}${mat.name}` : '+ material'}
      </button>
    );
  };

  const renderDetailPanel = (row: TakeoffRow) => {
    const itemTotalCost = bq(row) * row.unitRate;
    const t = timesOf(row);
    const header = measurements.find(m => m.isGroupHeader && m.id !== row.id && (m.id === row.parentId || (!!row.groupId && m.groupId === row.groupId)));
    const timesInput = (target: TakeoffRow, label: string) => (
      <label className="flex items-center gap-1 text-[10px] text-zinc-500">
        {label} ×
        <input
          key={`${target.id}-${target.times ?? 1}`}
          aria-label={`${label} multiplier`} inputMode="decimal" defaultValue={target.times ?? 1}
          onClick={e => e.stopPropagation()}
          onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); }}
          onBlur={e => {
            const n = parseFloat(e.target.value);
            const next = Number.isFinite(n) && n > 0 && n !== 1 ? n : undefined;
            if (next !== target.times) onUpdate(target.id, { times: next });
          }}
          className="w-12 bg-stone-900 border border-zinc-700 focus:border-amber-accent text-xs font-mono px-1 py-0.5 outline-none text-zinc-200 text-right"
        />
      </label>
    );
    const autoCode = classify({ ...row, section: undefined }, new Map(materials.map(m => [m.id, m])));
    const autoSection = POMI_SECTIONS.find(s => s.code === autoCode);
    const working = row.derived ? explainDerived(row, new Map(measurements.map(m => [m.id, m]))) : null;
    return (
      <tr key={`${row.id}-detail`} className="bg-[#0d0d0d]">
        <td colSpan={3} className="px-3 pb-3 pt-0">
          <div className="w-0 min-w-full border border-zinc-800 rounded-sm bg-[#111] p-3 mt-1 space-y-3">
            {row.label && (
              <div className="flex items-start gap-3">
                <span className="text-[10px] text-zinc-600 uppercase tracking-widest w-16 shrink-0 pt-0.5">Label</span>
                <span className="text-[10px] text-zinc-400 font-mono truncate">{row.label}</span>
              </div>
            )}
            <div className="flex items-start gap-3">
              <span className="text-[10px] text-zinc-600 uppercase tracking-widest w-16 shrink-0 pt-0.5">Material</span>
              <div className="flex-1 min-w-0">{renderMaterialSelect(row)}</div>
            </div>
            <div className="flex gap-4">
              <div className="flex items-center gap-3 flex-1">
                <span className="text-[10px] text-zinc-600 uppercase tracking-widest w-16 shrink-0">Rate</span>
                {renderEditableText(row, 'unitRate', 'number', 'text-xs text-zinc-300 font-mono')}
                <span className="text-[10px] text-zinc-600">/ {row.unit || 'unit'}</span>
              </div>
              <div className="flex items-center gap-3 flex-1">
                <span className="text-[10px] text-zinc-600 uppercase tracking-widest w-16 shrink-0">Cost</span>
                <span className="text-xs font-bold text-amber-accent">{formatCurrency(itemTotalCost)}</span>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[10px] text-zinc-600 uppercase tracking-widest w-16 shrink-0">Section</span>
              <select
                aria-label="Bill section" value={row.section ?? ''}
                onClick={e => e.stopPropagation()}
                onChange={e => onUpdate(row.id, { section: e.target.value || undefined })}
                className="flex-1 min-w-0 bg-stone-900 border border-zinc-700 focus:border-amber-accent text-[11px] font-mono px-1 py-0.5 outline-none text-zinc-300"
              >
                <option value="">{autoSection ? `Auto: ${autoSection.code} ${autoSection.title}` : 'Auto: not classified yet'}</option>
                {POMI_SECTIONS.map(s => <option key={s.code} value={s.code}>{s.code} {s.title}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[10px] text-zinc-600 uppercase tracking-widest w-16 shrink-0">Times</span>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 flex-1 min-w-0">
                {timesInput(row, 'This row')}
                {header && !row.derived && timesInput(header, 'Group')}
                {t.page !== 1 && <span className="text-[10px] text-zinc-500">Page × {parseFloat(t.page.toFixed(3))}</span>}
                {row.derived && t.total !== (row.times ?? 1) && <span className="text-[10px] text-zinc-500">follows its shape</span>}
                {t.total !== 1 && (
                  <span className="text-[10px] font-mono text-zinc-200 ml-auto">= {bq(row).toFixed(2)} {row.unit}</span>
                )}
              </div>
            </div>
            {working && (
              <div className="flex items-start gap-3">
                <span className="text-[10px] text-zinc-600 uppercase tracking-widest w-16 shrink-0 pt-0.5">Working</span>
                <div className="flex-1 min-w-0 space-y-0.5">
                  {working.map((w, i) => (
                    <button
                      key={i} type="button" disabled={!w.sourceId}
                      title={w.sourceId ? 'Show on the drawing' : undefined}
                      onClick={e => { e.stopPropagation(); if (w.sourceId) focusMeasurement(w.sourceId); }}
                      className="w-full flex items-baseline gap-2 text-left text-[10px] font-mono text-zinc-400 enabled:hover:text-amber-accent"
                    >
                      <span className="flex-1 min-w-0">{w.text}</span>
                      <span className="tabular-nums shrink-0">{w.value.toFixed(2)}</span>
                    </button>
                  ))}
                  <div className="flex items-baseline gap-2 border-t border-zinc-800 pt-0.5 text-[10px] font-mono text-zinc-200">
                    <span className="flex-1">{row.isOverridden ? 'Quantity typed in by hand' : 'Quantity'}</span>
                    <span className="tabular-nums">{row.quantity.toFixed(2)} {row.unit}</span>
                  </div>
                </div>
              </div>
            )}
            {row.notes && (
              <div className="flex items-start gap-3">
                <span className="text-[10px] text-zinc-600 uppercase tracking-widest w-16 shrink-0 pt-0.5">Notes</span>
                <span className="text-[10px] text-zinc-500 font-mono truncate">{row.notes}</span>
              </div>
            )}
          </div>
        </td>
      </tr>
    );
  };

  return (
    <aside className="w-full min-w-0 bg-industrial-panel border-l border-industrial-border flex flex-col h-full font-mono">

      <div className="p-3 border-b border-industrial-border bg-stone-900/50 flex justify-between items-center flex-shrink-0">
        <span className="text-[11px] font-bold text-zinc-500 tracking-widest uppercase">Takeoff Data</span>
        <div className="flex items-center gap-3">
          <button onClick={() => onToggleVisibility()} className="text-zinc-500 hover:text-amber-accent transition-colors flex items-center gap-1 text-[11px] font-bold" title={allVisible ? 'Hide All' : 'Show All'}>
            {allVisible ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
          </button>
          <button onClick={onAddManual} className="text-zinc-500 hover:text-amber-accent transition-colors flex items-center gap-1 text-[11px] font-bold">
            <Plus className="w-3 h-3" /> ADD ROW
          </button>
          {onExpand && (
            <>
              <div className="w-px h-3 bg-zinc-700" />
              <button onClick={onExpand} className="text-zinc-500 hover:text-amber-400 transition-colors flex items-center gap-1 text-[11px] font-bold" title="Open full-page takeoff view">
                <ExternalLink className="w-3 h-3" /> EXPAND
              </button>
            </>
          )}
          {onCollapse && (
            <>
              <div className="w-px h-3 bg-zinc-700" aria-hidden />
              <button
                type="button"
                onClick={onCollapse}
                title="Hide takeoff panel (])"
                aria-label="Hide takeoff panel"
                className="text-zinc-500 hover:text-amber-accent transition-colors"
              >
                <PanelRightClose className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>
      </div>

      {(review.total > 0 || onOpenChanges) && (
        <div className="px-3 py-2 border-b border-industrial-border bg-red-500/10 flex items-center gap-2 text-[11px] flex-shrink-0">
          <span className="flex-1 min-w-0 text-zinc-200">
            {review.total === 0 ? 'Revision accepted: nothing to check.'
              : review.open > 0 ? <><span className="font-bold text-red-400">{review.open}</span> of {review.total} to check after the revision</>
              : <span className="text-green-400">Revision checked: all {review.total} done</span>}
          </span>
          {review.open > 0 && (
            <button onClick={() => focusMeasurement(review.openIds[0])} className="font-bold uppercase tracking-widest text-[10px] text-amber-accent hover:underline">Next</button>
          )}
          {onOpenChanges && (
            <button onClick={onOpenChanges} className="font-bold uppercase tracking-widest text-[10px] border border-zinc-600 px-2 py-1 text-zinc-200 hover:border-amber-accent hover:text-amber-accent">Revision history</button>
          )}
        </div>
      )}
      <div ref={bodyRef} className="flex-1 overflow-auto custom-scrollbar">
        <table className="w-full text-[11px] border-collapse">
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
                    className={cn('border-t border-amber-500/20 bg-[#1a1a1a] cursor-pointer hover:bg-[#222] transition-colors group',
                      dropGroup === header.id && 'outline outline-2 -outline-offset-2 outline-amber-400 bg-amber-400/10',
                      dragId && !canJoin(measurements.find(m => m.id === dragId), header) && 'opacity-40')}
                    onClick={() => toggleGroup(groupId)}
                    onDragOver={e => {
                      if (!dragId || !canJoin(measurements.find(m => m.id === dragId), header)) return;
                      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
                      if (dropGroup !== header.id) setDropGroup(header.id);
                    }}
                    onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setRowMenu({ x: e.clientX, y: e.clientY, rowId: header.id, group: true }); }}
                    onDragLeave={() => setDropGroup(g => (g === header.id ? null : g))}
                    onDrop={e => { e.preventDefault(); const id = e.dataTransfer.getData('text/plain') || dragId; setDragId(null); setDropGroup(null); if (id) moveRow(id, header.id); }}
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
                            className="bg-stone-900 border border-amber-accent text-xs font-mono p-1 outline-none text-zinc-200 flex-1 min-w-0"
                          />
                        ) : (
                          <span
                            className="text-xs font-bold text-amber-500 uppercase tracking-wider truncate cursor-text hover:text-amber-300 transition-colors"
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
                        <span className="text-[10px] text-zinc-600 shrink-0">({items.length})</span>
                      </div>
                      {/* One material for the whole group: it is applied to every row in it. */}
                      <div className="pl-8 mt-0.5" onClick={e => e.stopPropagation()}>
                        {editingId === header.id && editingField === 'groupMaterial' ? (
                          <MaterialPicker
                            size="sm" autoOpen materials={materials} value={header.materialId ?? null}
                            measurementType={items[0]?.type ?? header.type}
                            onOpenBank={() => { stopEditing(); setMaterialLibraryOpen(true); }}
                            onClose={stopEditing}
                            onChange={(id) => {
                              const mat = id ? materials.find(m => m.id === id) : undefined;
                              const rate = mat ? ((mat.materialCost ?? 0) + (mat.laborCost ?? 0) + (mat.equipmentCost ?? 0) || mat.unitRate || 0) : 0;
                              const upd = mat ? { materialId: mat.id, unitRate: rate } : { materialId: undefined, unitRate: 0 };
                              onUpdate(header.id, upd);
                              batchUpdateGroup(groupId, items, upd);
                            }}
                          />
                        ) : (() => {
                          const gm = getMaterial(header.materialId);
                          const mixed = !gm && items.some(i => i.materialId);
                          return (
                            <button
                              type="button" onClick={e => startEditing(header.id, 'groupMaterial', e)}
                              title={gm ? 'Change the material for every row in this group' : 'Set one material for every row in this group'}
                              className={cn('block max-w-full truncate text-left text-[10px] font-mono transition-colors hover:text-amber-accent',
                                gm ? 'text-zinc-400' : mixed ? 'text-zinc-500' : 'text-zinc-700 opacity-0 group-hover:opacity-100 focus-visible:opacity-100')}
                            >
                              {gm ? `${gm.code ? `${gm.code} · ` : ''}${gm.name}` : mixed ? 'materials set per row · set one for all' : '+ material for the group'}
                            </button>
                          );
                        })()}
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
                          <ColorSwatchPicker
                            value={header.color || '#EF9F27'} used={usedColors} label={header.label || header.description}
                            onChange={color => { onUpdate(header.id, { color }); batchUpdateGroup(groupId, items, { color }); }}
                          />

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
                            title="Draw more into this group"
                          >
                            <Plus className="w-3 h-3" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              const name = header.groupName || header.description || 'this group';
                              void confirm({
                                title: 'Delete group',
                                message: <>Delete <span className="text-zinc-100 font-bold">{name}</span> and all its items?</>,
                                detail: 'This can’t be undone.',
                                confirmText: 'Delete group',
                              }).then(ok => { if (ok) onDelete(header.id); });
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
                          data-row-id={item.id}
                          {...rowMoveProps(item)}
                          className={cn('group/row border-t border-[#1a1a1a] transition-colors cursor-pointer',
                            item.id === selectedId ? 'bg-amber-400/[0.08] shadow-[inset_2px_0_0_#F2C230]' : isRowExpanded ? 'bg-stone-900' : 'hover:bg-stone-900/50')}
                          onClick={() => { toggleRowExpand(item.id); focusMeasurement(item.id); }}
                        >
                          <td className="p-2 text-center border-r border-industrial-border text-zinc-600 text-[10px] whitespace-nowrap">
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
                                  className="flex-1 min-w-0 bg-stone-900 border border-amber-accent text-xs font-mono p-1 outline-none text-zinc-200"
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
                            {renderMaterialChip(item)}
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
                    data-row-id={row.id}
                    {...rowMoveProps(row)}
                    className={cn('group/row border-t border-industrial-border transition-colors cursor-pointer',
                      row.id === selectedId ? 'bg-amber-400/[0.08] shadow-[inset_2px_0_0_#F2C230]' : isRowExpanded ? 'bg-stone-900' : 'hover:bg-stone-900/50')}
                    onClick={() => { toggleRowExpand(row.id); focusMeasurement(row.id); }}
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
                            className="flex-1 min-w-0 bg-stone-900 border border-amber-accent text-xs font-mono p-1 outline-none text-zinc-200"
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
                      {renderMaterialChip(row)}
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
            <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">Total Estimated Cost</span>
            <span className="text-xl font-bold text-amber-accent tracking-tighter">{formatCurrency(totalCost)}</span>
          </div>
          <div className="h-0.5 bg-zinc-800 w-full rounded-full overflow-hidden">
            <div
              className="h-full bg-amber-accent shadow-[0_0_8px_rgba(242,194,48,0.5)] transition-[width] duration-500"
              style={{ width: `${pricing.total ? Math.round(((pricing.total - pricing.unpriced) / pricing.total) * 100) : 0}%` }}
            />
          </div>
          {pricing.total > 0 && (
            <p className="mt-2 text-[11px] text-zinc-500">
              {pricing.unpriced === 0
                ? 'Every row is priced.'
                : <>
                    <span className="text-amber-300">{pricing.unpriced} of {pricing.total} rows have no rate</span>
                    {' '}— their cost isn’t in this total.
                  </>}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onOpenAnalysis}
          disabled={!onOpenAnalysis}
          className="w-full bg-[#2E353C] hover:bg-zinc-800 border border-industrial-border text-zinc-400 hover:text-zinc-200 py-3 text-[11px] font-bold uppercase tracking-widest transition-all disabled:opacity-50"
        >
          Generate Full Analysis
        </button>
        {onOpenCompare && (
          <button
            type="button"
            onClick={onOpenCompare}
            className="w-full mt-2 border border-industrial-border text-zinc-400 hover:text-amber-accent hover:border-amber-accent py-2.5 text-[11px] font-bold uppercase tracking-widest transition-all"
          >
            Compare with a new revision
          </button>
        )}
      </div>
      {rowMenu && (() => {
        const row = measurements.find(m => m.id === rowMenu.rowId);
        if (!row) return null;
        const close = () => setRowMenu(null);
        // One line per action; the longer explanation is the tooltip.
        const Item = ({ label, hint, onClick, danger }: { label: React.ReactNode; hint?: string; onClick: () => void; danger?: boolean }) => (
          <button role="menuitem" title={hint} onClick={() => { close(); onClick(); }}
            className={cn('w-full px-3 py-1.5 text-left truncate hover:bg-zinc-800', danger ? 'text-red-400' : 'text-zinc-100')}>
            {label}
          </button>
        );
        const Divider = () => <div className="border-t border-zinc-700 my-1" />;
        const shell = 'fixed z-[200] w-60 max-h-[70vh] overflow-y-auto custom-scrollbar bg-zinc-900 border border-zinc-600 shadow-2xl py-1 text-xs';
        const place = (rows: number) => ({
          left: Math.min(rowMenu.x, window.innerWidth - 250),
          top: Math.max(8, Math.min(rowMenu.y, window.innerHeight - 24 - rows * 30)),
        });

        if (rowMenu.group) {
          const gid = row.groupId || row.id;
          const items = measurements.filter(m => !m.isGroupHeader && (m.parentId === row.id || m.groupId === gid));
          const name = row.groupName || row.label || row.description || 'Group';
          return (
            <div data-row-menu role="menu" className={shell} style={place(8)} onContextMenu={e => e.preventDefault()}>
              <div className="px-3 py-1 text-[10px] font-mono uppercase tracking-widest text-zinc-500 truncate">{name}</div>
              <Item label={`Select all ${items.filter(i => (i.points?.length ?? 0) > 0).length} on the drawing`} hint="Selects every shape in this group at once, ready to move, join, merge or delete"
                onClick={() => window.dispatchEvent(new CustomEvent('foldrule:select-rows', { detail: { ids: items.filter(i => (i.points?.length ?? 0) > 0).map(i => i.id) } }))} />
              <Item label="Set material for the group" hint="One material and rate for every row in it" onClick={() => { setEditingId(row.id); setEditingField('groupMaterial'); }} />
              <Item label="Duplicate as an empty group" hint="Same material, rate and unit — ready for the next floor or area" onClick={() => duplicateGroup(row.id, false)} />
              <Item label="Duplicate with its shapes" hint="Copies every shape too, placed just beside the originals" onClick={() => duplicateGroup(row.id, true)} />
              <Item label="Ungroup" hint="Keep the rows, remove the group" onClick={() => ungroupMeasurements(row.id)} />
              <Divider />
              <Item danger label="Delete group" hint="Deletes the group and its rows. Ctrl+Z brings it back." onClick={() => {
                void confirm({ title: 'Delete group', message: <>Delete <span className="text-zinc-100 font-bold">{name}</span> and all its items?</>, detail: 'Ctrl+Z brings it back.', confirmText: 'Delete group' })
                  .then(ok => { if (ok) onDelete(row.id); });
              }} />
            </div>
          );
        }

        const targets = measurements.filter(h => canJoin(row, h));
        return (
          <div data-row-menu role="menu" className={shell} style={place(5 + Math.min(8, targets.length + 1))} onContextMenu={e => e.preventDefault()}>
            <div className="px-3 py-1 text-[10px] font-mono uppercase tracking-widest text-zinc-500 truncate">{row.description || row.label}</div>
            <Item label={row.materialId ? 'Change material' : 'Set material'} hint="For this row only" onClick={() => { setExpandedRows(prev => new Set(prev).add(row.id)); setEditingId(row.id); setEditingField('materialId'); }} />
            {(row.points?.length ?? 0) > 0 && <Item label="Duplicate" hint="A copy just beside it, in the same group" onClick={() => duplicateRow(row.id)} />}
            <Divider />
            {targets.length > 0 && <div className="px-3 py-1 text-[10px] font-mono uppercase tracking-widest text-zinc-500">Move to</div>}
            {targets.map(h => (
              <button key={h.id} role="menuitem" onClick={() => { moveRow(row.id, h.id); close(); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-zinc-100 hover:bg-zinc-800">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: h.color }} />
                <span className="truncate">{h.groupName || h.label || h.description}</span>
              </button>
            ))}
            {row.parentId && <Item label="Take it out of its group" onClick={() => moveRow(row.id, null)} />}
            {!row.parentId && ['area', 'length', 'count'].includes(kindOf(row.type)) && <Item label="Make it a group" hint="Turns this row into a group of its own, so you can add more to it with +" onClick={() => makeGroupFrom(row.id)} />}
            <Divider />
            <Item danger label="Delete" hint="Ctrl+Z brings it back" onClick={() => onDelete(row.id)} />
          </div>
        );
      })()}
    </aside>
  );
}

/** Memoized: skips re-rendering when its props are unchanged. */
export const TakeoffTable = React.memo(TakeoffTableImpl);

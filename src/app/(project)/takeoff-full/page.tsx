// FILE: src/app/(project)/takeoff-full/page.tsx
// Redesigned to match ESTIMATOR_PRO_V1 reference UI:
//   • Fixed top nav bar with project breadcrumb + stat chips + Share / Export BOQ
//   • Icon-only left sidebar (Files, Layers, Snap, Tools, History, Team)
//   • Configurator strip (Wall Type, Stud Spacing, Track Depth + Recalculate)
//   • High-density takeoff table (Code, Description, Material, Quantity, Unit, Rate, Total)
//     with amber "flagged" rows for items with unitRate changes
//   • Right panel: Sync Status — Change Detection card, Impacted Line Items,
//     Visual Reference placeholder, Accept / Discard footer

'use client';

import React, { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTakeoffContext } from '@/context/TakeoffContext';
import {
  FolderOpen, Layers, Target, Wrench, History,
  Users, HelpCircle, Settings, Share2, Download,
  RefreshCw, AlertTriangle, TriangleAlert, Eye, EyeOff,
  Trash2, Plus, Search, ChevronDown, ChevronRight,
  Package, FolderOpenDot, Pencil, ArrowLeft,
  BarChart3, Zap,
} from 'lucide-react';
import { cn, formatCurrency } from '@/lib/utils';
import { TakeoffRow, MaterialSpec } from '@/types';

// ─── Editable cell for text/number ────────────────────────────────────────────
function EditableCell({
  row, field, type = 'text', onUpdate,
}: {
  row: TakeoffRow;
  field: keyof TakeoffRow;
  type?: 'text' | 'number';
  onUpdate: (id: string, updates: Partial<TakeoffRow>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const value = row[field];

  if (editing) {
    return (
      <input
        autoFocus
        type={type}
        defaultValue={value as string | number}
        onBlur={e => {
          const val = type === 'number' ? parseFloat(e.target.value) : e.target.value;
          onUpdate(row.id, { [field]: val });
          setEditing(false);
        }}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        className="w-full bg-zinc-950 border border-amber-500 text-[11px] font-mono p-1 outline-none text-zinc-200 rounded-none"
      />
    );
  }

  return (
    <div
      onClick={() => { if (!row.isGroupHeader) setEditing(true); }}
      className={cn(
        'truncate min-h-[16px] w-full',
        !row.isGroupHeader && 'cursor-text hover:text-amber-400 transition-colors',
      )}
    >
      {type === 'number' && typeof value === 'number' ? value.toFixed(2) : value as string}
    </div>
  );
}

// ─── Material cell (dropdown, separate from description) ──────────────────────
function MaterialCell({
  row, materials, onUpdate,
}: {
  row: TakeoffRow;
  materials: MaterialSpec[];
  onUpdate: (id: string, updates: Partial<TakeoffRow>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const matched = materials.find(m => m.id === row.materialId);

  if (editing) {
    return (
      <select
        autoFocus
        defaultValue={row.materialId || ''}
        onBlur={e => {
          const selectedId = e.target.value;
          const mat = materials.find(m => m.id === selectedId);
          if (mat) {
            const total = mat.materialCost + mat.laborCost + mat.equipmentCost;
            onUpdate(row.id, {
              materialId: mat.id,
              unitRate: total,
              unit: mat.unit,
              // description is NOT updated here
            });
          } else {
            onUpdate(row.id, { materialId: undefined });
          }
          setEditing(false);
        }}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        className="w-full bg-zinc-950 border border-amber-500 text-[11px] font-mono p-1 outline-none text-zinc-200 rounded-none"
      >
        <option value="">— None —</option>
        {materials.map(m => (
          <option key={m.id} value={m.id}>
            {m.code} – {m.name} ({formatCurrency(m.materialCost + m.laborCost + m.equipmentCost)}/{m.unit})
          </option>
        ))}
      </select>
    );
  }

  return (
    <div
      onClick={() => !row.isGroupHeader && setEditing(true)}
      className="cursor-pointer hover:text-amber-400 transition-colors min-h-[16px] w-full"
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
}

// ─── Left icon sidebar item ───────────────────────────────────────────────────
function SideNavItem({
  icon: Icon, label, active = false, onClick,
}: {
  icon: React.ElementType;
  label: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={cn(
        'w-12 h-12 flex flex-col items-center justify-center gap-0.5 transition-all',
        active
          ? 'bg-amber-500/10 text-amber-500 border-r-2 border-amber-500'
          : 'text-zinc-600 hover:bg-zinc-800 hover:text-zinc-400',
      )}
    >
      <Icon className="w-4 h-4" />
      <span className="text-[8px] font-bold uppercase tracking-wider leading-none">{label}</span>
    </button>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function TakeoffFullPage() {
  const router = useRouter();

  const {
    projectState: ps,
    addMeasurement,
    updateMeasurement,
    deleteMeasurement,
    toggleVisibility,
  } = useTakeoffContext();

  const [search, setSearch]                 = useState('');
  const [activeNav, setActiveNav]           = useState('Files');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [filterType, setFilterType]         = useState('All');

  // Configurator strip state (cosmetic — wire to real logic as needed)
  const [wallType, setWallType]       = useState('A1 - LOAD BEARING');
  const [studSpacing, setStudSpacing] = useState('450');
  const [pendingSync, setPendingSync] = useState(false);

  const all = ps.measurements;

  // Determine "flagged" rows: items that have a unitRate > 0 (i.e. configured/changed)
  const isFlagged = (row: TakeoffRow) => row.unitRate > 0 && row.isOverridden;

  const filtered = useMemo(() => all.filter((m: { description: string; notes: any; presetId: any; }) => {
    const q = search.toLowerCase();
    return (
      m.description.toLowerCase().includes(q) ||
      (m.notes ?? '').toLowerCase().includes(q) ||
      (m.presetId ?? '').toLowerCase().includes(q)
    );
  }), [all, search]);

  // Organise into groups + ungrouped
  const { groups, ungrouped } = useMemo(() => {
    const groups = new Map<string, { header: TakeoffRow; items: TakeoffRow[] }>();
    const ungrouped: TakeoffRow[] = [];
    filtered.forEach((m: TakeoffRow) => {
      if (m.isGroupHeader && m.groupId) {
        groups.set(m.groupId, { header: m, items: [] });
      } else if (m.groupId && groups.has(m.groupId)) {
        groups.get(m.groupId)!.items.push(m);
      } else if (!m.isGroupHeader) {
        ungrouped.push(m);
      }
    });
    return { groups, ungrouped };
  }, [filtered]);

  const totalCost  = all.reduce((s: number, m: { quantity: number; unitRate: number; }) => s + m.quantity * m.unitRate, 0);
  const totalArea  = all.filter((m: { unit: string; }) => m.unit === 'm²').reduce((s: any, m: { quantity: any; }) => s + m.quantity, 0);
  const flaggedRows = [...ungrouped, ...Array.from(groups.values()).flatMap(g => g.items)]
    .filter(isFlagged);
  const costDelta  = flaggedRows.reduce((s, r) => s + r.quantity * r.unitRate * 0.33, 0);

  const groupCost = (items: TakeoffRow[]) => items.reduce((s, i) => s + i.quantity * i.unitRate, 0);
  const groupQty  = (items: TakeoffRow[]) => items.reduce((s, i) => s + i.quantity, 0);

  const toggleGroup = (id: string) =>
    setExpandedGroups(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // Generate a short code from preset ID or description
  const rowCode = (row: TakeoffRow, idx: number) => {
    if (row.presetId) {
      return `${row.presetId.slice(0, 1).toUpperCase()}-${String(idx + 100).padStart(3, '0')}-${row.type?.slice(0, 1) ?? 'X'}`;
    }
    return `M-${String(idx + 1).padStart(3, '0')}-A`;
  };

  const handleRecalculate = () => {
    setPendingSync(false);
  };

  const handleAcceptAll = () => {
    setPendingSync(false);
  };

  const handleAddManual = () =>
    addMeasurement({
      description:  'Manual Item',
      type:         'Length',
      quantity:     0,
      unit:         'm',
      unitRate:     0,
      notes:        '',
      points:       [],
      isOverridden: false,
      color:        '#EF9F27',
      isVisible:    true,
    } as any);

  const allRows = [...Array.from(groups.values()).flatMap(g => g.items), ...ungrouped];

  return (
    <div className="flex flex-col h-screen bg-[#131313] font-mono overflow-hidden">

      {/* ── Top navigation bar ─────────────────────────────────────────────────── */}
      <header className="fixed top-0 left-0 right-0 h-14 z-50 bg-zinc-950 border-b border-zinc-800 flex items-center justify-between px-4">
        {/* Left: brand + nav links */}
        <div className="flex items-center gap-8">
          <div className="text-[17px] font-black text-amber-500 tracking-tighter uppercase">
            ESTIMATOR_PRO_V1
          </div>
          <nav className="hidden md:flex gap-6 items-center h-14">
            {['Projects', 'Takeoffs', 'Library', 'Reports'].map(link => (
              <a
                key={link}
                href="#"
                className={cn(
                  'text-[13px] font-bold uppercase tracking-tight h-14 flex items-center border-b-2 transition-colors',
                  link === 'Projects'
                    ? 'text-amber-500 border-amber-500'
                    : 'text-zinc-500 border-transparent hover:text-zinc-300',
                )}
              >
                {link}
              </a>
            ))}
          </nav>
        </div>

        {/* Right: actions */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-zinc-500 hover:text-zinc-300 border border-zinc-700 px-3 py-1.5 transition-all"
          >
            <ArrowLeft className="w-3 h-3" />
            Workspace
          </button>
          <button className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-zinc-400 border border-zinc-700 px-3 py-1.5 hover:bg-zinc-900 transition-all">
            <Share2 className="w-3 h-3" />
            Share
          </button>
          <button
            onClick={() => {
              fetch('/api/export', { method: 'POST' })
                .then(res => res.blob())
                .then(blob => {
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = 'export.xlsx';
                  a.click();
                  URL.revokeObjectURL(url);
                })
                .catch(err => console.error('Export failed:', err));
            }}
            className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-zinc-950 bg-amber-500 hover:bg-amber-400 px-4 py-1.5 transition-all active:scale-95"
          >
            <Download className="w-3 h-3" />
            Export BOQ
          </button>
          <div className="flex gap-1 ml-1 border-l border-zinc-800 pl-3">
            <button className="w-8 h-8 flex items-center justify-center text-zinc-500 hover:text-zinc-300 transition-colors">
              <Settings className="w-4 h-4" />
            </button>
            <button className="w-8 h-8 flex items-center justify-center text-zinc-500 hover:text-zinc-300 transition-colors">
              <HelpCircle className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <div className="flex flex-1 pt-14 h-screen overflow-hidden">

        {/* ── Icon sidebar ───────────────────────────────────────────────────────── */}
        <aside className="fixed left-0 top-14 h-[calc(100vh-3.5rem)] w-20 bg-zinc-900 border-r border-zinc-800 flex flex-col items-center py-4 z-40">
          <div className="flex flex-col gap-1 w-full items-center flex-1">
            {[
              { icon: FolderOpen, label: 'Files'    },
              { icon: Layers,     label: 'Layers'   },
              { icon: Target,     label: 'Snap'     },
              { icon: Wrench,     label: 'Tools'    },
              { icon: History,    label: 'History'  },
              { icon: Users,      label: 'Team'     },
            ].map(({ icon, label }) => (
              <SideNavItem
                key={label}
                icon={icon}
                label={label}
                active={activeNav === label}
                onClick={() => setActiveNav(label)}
              />
            ))}
          </div>
          <div className="flex flex-col gap-1 w-full items-center">
            <SideNavItem icon={HelpCircle} label="Help"     />
            <SideNavItem icon={Settings}   label="Settings" />
          </div>
        </aside>

        {/* ── Main content (left of right panel) ─────────────────────────────────── */}
        <main className="ml-20 flex-1 flex overflow-hidden border-r border-zinc-800">
          <div className="flex-1 flex flex-col bg-[#131313] overflow-hidden">

            {/* Project breadcrumb + stat chips */}
            <div className="p-4 bg-zinc-950/50 border-b border-zinc-800 flex items-center justify-between flex-shrink-0">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[11px] text-zinc-500 font-bold uppercase tracking-widest">
                    {ps.projectName || 'Project Alpha'}
                  </span>
                  <span className="text-zinc-700 text-xs">/</span>
                  <span className="text-[15px] font-bold text-zinc-100 tracking-tight">
                    Takeoff Summary
                  </span>
                </div>
                <div className="text-[11px] text-zinc-600">
                  {all.length} measurements · {groups.size} assemblies
                </div>
              </div>
              <div className="flex gap-3">
                <div className="px-4 py-2 bg-zinc-900 border border-zinc-800">
                  <div className="text-[9px] text-zinc-500 font-bold uppercase tracking-widest mb-0.5">Total Estimate</div>
                  <div className="text-[17px] font-black text-amber-500 leading-none">{formatCurrency(totalCost)}</div>
                </div>
                <div className="px-4 py-2 bg-zinc-900 border border-zinc-800">
                  <div className="text-[9px] text-zinc-500 font-bold uppercase tracking-widest mb-0.5">Total Area</div>
                  <div className="text-[17px] font-black text-zinc-100 leading-none">{totalArea.toFixed(2)} M²</div>
                </div>
              </div>
            </div>

            {/* Configurator strip */}
            <div className="bg-zinc-900/50 border-b border-zinc-800 px-4 py-2.5 flex items-center gap-5 overflow-x-auto flex-shrink-0">
              <div className="flex items-center gap-2 flex-shrink-0">
                <Settings className="w-3.5 h-3.5 text-amber-500" />
                <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">Configurator</span>
              </div>
              <div className="h-5 w-px bg-zinc-800 flex-shrink-0" />

              {/* Wall type */}
              <div className="flex flex-col flex-shrink-0">
                <label className="text-[9px] text-zinc-500 uppercase font-bold tracking-widest mb-1">Wall Type</label>
                <select
                  value={wallType}
                  onChange={e => { setWallType(e.target.value); setPendingSync(true); }}
                  className="bg-zinc-950 border border-zinc-800 text-[11px] text-zinc-200 py-1 px-2 focus:border-amber-500 outline-none rounded-none font-mono"
                >
                  <option>A1 - LOAD BEARING</option>
                  <option>B2 - PARTITION</option>
                  <option>C3 - EXTERNAL</option>
                </select>
              </div>

              {/* Stud spacing */}
              <div className="flex flex-col flex-shrink-0">
                <label className="text-[9px] text-zinc-500 uppercase font-bold tracking-widest mb-1">Stud Spacing</label>
                <div className="flex items-center">
                  <input
                    type="text"
                    value={studSpacing}
                    onChange={e => { setStudSpacing(e.target.value); setPendingSync(true); }}
                    className={cn(
                      'w-16 bg-zinc-950 border text-[11px] py-1 px-2 outline-none rounded-none font-mono',
                      pendingSync
                        ? 'border-amber-500 text-amber-500'
                        : 'border-zinc-800 text-zinc-200',
                    )}
                  />
                  <span className="bg-zinc-800 px-2 py-1 text-[9px] text-zinc-500 border border-l-0 border-zinc-800 font-mono">MM</span>
                </div>
              </div>

              {/* Track depth — disabled */}
              <div className="flex flex-col flex-shrink-0 opacity-50">
                <label className="text-[9px] text-zinc-500 uppercase font-bold tracking-widest mb-1">Track Depth</label>
                <div className="flex items-center">
                  <input
                    disabled
                    type="text"
                    defaultValue="92"
                    className="w-16 bg-zinc-950 border border-zinc-800 text-[11px] text-zinc-500 py-1 px-2 rounded-none font-mono"
                  />
                  <span className="bg-zinc-800 px-2 py-1 text-[9px] text-zinc-500 border border-l-0 border-zinc-800 font-mono">MM</span>
                </div>
              </div>

              {/* Search */}
              <div className="flex items-center gap-2 bg-zinc-950 border border-zinc-800 px-2 py-1 ml-2 focus-within:border-amber-500/50 transition-colors flex-shrink-0">
                <Search className="w-3 h-3 text-zinc-600" />
                <input
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search…"
                  className="bg-transparent text-[10px] font-mono text-zinc-300 placeholder-zinc-700 focus:outline-none w-28"
                />
              </div>

              <div className="ml-auto flex items-center gap-3 flex-shrink-0">
                {pendingSync && (
                  <span className="text-[11px] text-amber-500 font-bold italic">Changes Pending Sync</span>
                )}
                <button
                  onClick={handleRecalculate}
                  className="bg-amber-500 hover:bg-amber-400 text-zinc-950 px-3 py-1 text-[10px] font-black uppercase tracking-widest active:scale-95 transition-all"
                >
                  Recalculate
                </button>
                <button
                  onClick={handleAddManual}
                  className="flex items-center gap-1.5 border border-zinc-700 text-zinc-400 px-3 py-1 text-[10px] font-bold uppercase tracking-widest hover:bg-zinc-800 transition-all"
                >
                  <Plus className="w-3 h-3" />
                  Add Row
                </button>
              </div>
            </div>

            {/* ── Takeoff table ───────────────────────────────────────────────── */}
            <div className="flex-1 overflow-auto bg-[#0d0d0d]"
                 style={{ scrollbarWidth: 'thin', scrollbarColor: '#2a2a2a transparent' }}>
              <table className="w-full text-left border-collapse min-w-[800px]">
                <thead className="sticky top-0 bg-zinc-900 z-10">
                  <tr className="border-b border-zinc-700">
                    <th className="w-10 p-2 border-r border-zinc-800" />
                    <th className="p-2 text-[9px] font-bold text-zinc-400 uppercase tracking-widest border-r border-zinc-800">Code</th>
                    <th className="p-2 text-[9px] font-bold text-zinc-400 uppercase tracking-widest border-r border-zinc-800">Description</th>
                    <th className="p-2 text-[9px] font-bold text-zinc-400 uppercase tracking-widest border-r border-zinc-800">Material</th>
                    <th className="p-2 text-[9px] font-bold text-zinc-400 uppercase tracking-widest border-r border-zinc-800 text-right">Quantity</th>
                    <th className="p-2 text-[9px] font-bold text-zinc-400 uppercase tracking-widest border-r border-zinc-800 text-center">Unit</th>
                    <th className="p-2 text-[9px] font-bold text-zinc-400 uppercase tracking-widest border-r border-zinc-800 text-right">Rate</th>
                    <th className="p-2 text-[9px] font-bold text-zinc-400 uppercase tracking-widest text-right">Total</th>
                    <th className="w-20 p-2 text-[9px] font-bold text-zinc-400 uppercase tracking-widest text-center border-l border-zinc-800">Actions</th>
                  </tr>
                </thead>
                <tbody className="text-[12px]">

                  {/* Groups */}
                  {Array.from(groups.entries()).map(([groupId, { header, items }], gIdx) => {
                    const expanded = expandedGroups.has(groupId);
                    const gCode = `G-${String(gIdx + 1).padStart(3, '0')}-A`;
                    return (
                      <React.Fragment key={groupId}>
                        {/* Group header row */}
                        <tr
                          className="border-b border-zinc-800 bg-zinc-900/30 cursor-pointer hover:bg-zinc-800/40 transition-colors group"
                          onClick={() => toggleGroup(groupId)}
                        >
                          <td className="p-2 border-r border-zinc-800 text-center">
                            <FolderOpenDot className="w-3.5 h-3.5 text-amber-500 mx-auto" />
                          </td>
                          <td className="p-2 border-r border-zinc-800 text-amber-500 font-bold">{gCode}</td>
                          <td className="p-2 border-r border-zinc-800" colSpan={2}>
                            <div className="flex items-center gap-2">
                              {expanded
                                ? <ChevronDown className="w-3 h-3 text-amber-500 flex-shrink-0" />
                                : <ChevronRight className="w-3 h-3 text-amber-500 flex-shrink-0" />}
                              <span className="font-black text-amber-500 uppercase text-[11px] tracking-wide">
                                {header.groupName}
                              </span>
                              <span className="text-[9px] text-zinc-600">({items.length} items)</span>
                            </div>
                          </td>
                          <td className="p-2 border-r border-zinc-800 text-right text-amber-400 font-bold">
                            {groupQty(items).toFixed(2)}
                          </td>
                          <td className="p-2 border-r border-zinc-800 text-center text-zinc-600 text-[10px]">ASSY</td>
                          <td className="p-2 border-r border-zinc-800 text-right text-zinc-600">—</td>
                          <td className="p-2 text-right font-black text-amber-500">{formatCurrency(groupCost(items))}</td>
                          <td className="p-2 text-center border-l border-zinc-800">
                            <button
                              onClick={e => { e.stopPropagation(); deleteMeasurement(header.id); }}
                              className="text-zinc-700 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                           </td>
                         </tr>

                        {/* Group items */}
                        {expanded && items.map((item, iIdx) => {
                          const flagged = isFlagged(item);
                          const code = rowCode(item, gIdx * 100 + iIdx);
                          return (
                            <tr
                              key={item.id}
                              className={cn(
                                'border-b transition-colors group/item',
                                flagged
                                  ? 'border-amber-900/30 bg-amber-500/5 hover:bg-amber-500/10'
                                  : 'border-zinc-800 bg-zinc-900/10 hover:bg-zinc-800/30',
                              )}
                            >
                              <td className="p-2 border-r border-zinc-800 text-center">
                                {flagged
                                  ? <TriangleAlert className="w-3.5 h-3.5 text-amber-500 mx-auto" style={{ fill: 'currentColor', opacity: 0.9 }} />
                                  : <span className="w-2 h-2 inline-block bg-zinc-700 mx-auto" />}
                               </td>
                              <td className={cn('p-2 border-r border-zinc-800 font-bold pl-6', flagged ? 'text-amber-500' : 'text-zinc-400')}>
                                {code}
                               </td>
                              {/* Description — free text, not affected by material */}
                              <td className="p-2 border-r border-zinc-800">
                                <div className="flex items-center gap-2 pl-4">
                                  <Package className="w-3 h-3 text-zinc-700 flex-shrink-0" />
                                  <EditableCell row={item} field="description" type="text" onUpdate={updateMeasurement} />
                                </div>
                               </td>
                              {/* Material — separate dropdown */}
                              <td className="p-2 border-r border-zinc-800">
                                <MaterialCell row={item} materials={ps.materials} onUpdate={updateMeasurement} />
                               </td>
                              <td className={cn('p-2 border-r border-zinc-800 text-right font-bold', flagged ? 'text-amber-500' : '')}>
                                <div className="flex justify-end items-center gap-1">
                                  <EditableCell row={item} field="quantity" type="number" onUpdate={updateMeasurement} />
                                  {item.isOverridden && <Pencil className="w-2 h-2 text-amber-500/50 flex-shrink-0" />}
                                </div>
                               </td>
                              <td className="p-2 border-r border-zinc-800 text-center text-zinc-400">
                                <EditableCell row={item} field="unit" onUpdate={updateMeasurement} />
                               </td>
                              <td className="p-2 border-r border-zinc-800 text-right text-zinc-400">
                                <EditableCell row={item} field="unitRate" type="number" onUpdate={updateMeasurement} />
                               </td>
                              <td className={cn('p-2 text-right font-bold', flagged ? 'text-amber-500' : 'text-zinc-200')}>
                                {formatCurrency(item.quantity * item.unitRate)}
                               </td>
                              <td className="p-2 text-center border-l border-zinc-800">
                                <div className="flex items-center justify-center gap-1.5">
                                  <button onClick={() => toggleVisibility(item.id)}
                                    className="text-zinc-700 hover:text-amber-400 transition-colors opacity-0 group-hover/item:opacity-100">
                                    {item.isVisible !== false ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                                  </button>
                                  <button onClick={() => deleteMeasurement(item.id)}
                                    className="text-zinc-700 hover:text-red-500 transition-colors opacity-0 group-hover/item:opacity-100">
                                    <Trash2 className="w-3 h-3" />
                                  </button>
                                </div>
                               </td>
                             </tr>
                          );
                        })}

                        {/* Group subtotal row */}
                        {expanded && items.length > 0 && (
                          <tr className="bg-zinc-950 border-b border-zinc-900">
                            <td colSpan={9} className="p-1.5 px-4 text-right">
                              <div className="flex items-center justify-end gap-4 text-[9px] text-zinc-600">
                                <span>Subtotal: {formatCurrency(groupCost(items))}</span>
                                <span className="w-px h-2 bg-zinc-800" />
                                <span>+10% waste: {formatCurrency(groupCost(items) * 0.1)}</span>
                                <span className="w-px h-2 bg-zinc-800" />
                                <span className="text-amber-500 font-bold">Total: {formatCurrency(groupCost(items) * 1.1)}</span>
                              </div>
                             </td>
                           </tr>
                        )}
                      </React.Fragment>
                    );
                  })}

                  {/* Ungrouped rows */}
                  {ungrouped.map((row, idx) => {
                    const flagged = isFlagged(row);
                    const code = rowCode(row, idx);
                    return (
                      <tr
                        key={row.id}
                        className={cn(
                          'border-b transition-colors group',
                          flagged
                            ? 'border-amber-900/30 bg-amber-500/5 hover:bg-amber-500/10'
                            : idx % 2 === 0 ? 'border-zinc-800 bg-[#121212] hover:bg-zinc-800/30' : 'border-zinc-800 hover:bg-zinc-800/30',
                        )}
                      >
                        <td className="p-2 border-r border-zinc-800 text-center">
                          {flagged
                            ? <TriangleAlert className="w-3.5 h-3.5 text-amber-500 mx-auto" style={{ fill: 'currentColor', opacity: 0.9 }} />
                            : <span className="w-2 h-2 inline-block bg-zinc-700 mx-auto" />}
                         </td>
                        <td className={cn('p-2 border-r border-zinc-800 font-bold', flagged ? 'text-amber-500' : 'text-zinc-400')}>
                          {code}
                         </td>
                        {/* Description — free text */}
                        <td className="p-2 border-r border-zinc-800 text-zinc-200">
                          <div className="flex flex-col">
                            <EditableCell row={row} field="description" type="text" onUpdate={updateMeasurement} />
                            {row.notes && (
                              <span className="text-[9px] text-zinc-600 mt-0.5 truncate">{row.notes}</span>
                            )}
                          </div>
                         </td>
                        {/* Material — separate dropdown */}
                        <td className="p-2 border-r border-zinc-800">
                          <MaterialCell row={row} materials={ps.materials} onUpdate={updateMeasurement} />
                         </td>
                        <td className={cn('p-2 border-r border-zinc-800 text-right font-bold', flagged ? 'text-amber-500' : '')}>
                          <div className="flex justify-end items-center gap-1">
                            <EditableCell row={row} field="quantity" type="number" onUpdate={updateMeasurement} />
                            {row.isOverridden && <Pencil className="w-2.5 h-2.5 text-amber-500/50 flex-shrink-0" />}
                          </div>
                         </td>
                        <td className="p-2 border-r border-zinc-800 text-center text-zinc-400">
                          <EditableCell row={row} field="unit" onUpdate={updateMeasurement} />
                         </td>
                        <td className="p-2 border-r border-zinc-800 text-right text-zinc-400">
                          <EditableCell row={row} field="unitRate" type="number" onUpdate={updateMeasurement} />
                         </td>
                        <td className={cn('p-2 text-right font-bold', flagged ? 'text-amber-500' : 'text-zinc-200')}>
                          {formatCurrency(row.quantity * row.unitRate)}
                         </td>
                        <td className="p-2 text-center border-l border-zinc-800">
                          <div className="flex items-center justify-center gap-1.5">
                            <label className="cursor-pointer" title="Change colour">
                              <input type="color" value={row.color || '#EF9F27'}
                                onChange={e => updateMeasurement(row.id, { color: e.target.value })}
                                className="opacity-0 w-0 h-0 absolute pointer-events-none" />
                              <div className="w-3 h-3 rounded-full hover:scale-110 transition-transform shadow-sm opacity-0 group-hover:opacity-100"
                                style={{ backgroundColor: row.color || '#EF9F27' }} />
                            </label>
                            <button onClick={() => toggleVisibility(row.id)}
                              className="text-zinc-700 hover:text-amber-400 transition-colors opacity-0 group-hover:opacity-100">
                              {row.isVisible !== false ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                            </button>
                            <button onClick={() => deleteMeasurement(row.id)}
                              className="text-zinc-700 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100">
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                         </td>
                       </tr>
                    );
                  })}

                  {/* Empty state */}
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={9} className="p-16 text-center text-zinc-700 uppercase tracking-widest text-[10px]">
                        {search
                          ? 'No rows match your search.'
                          : 'No measurements yet. Return to Workspace and start measuring.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* ── Status bar ─────────────────────────────────────────────────── */}
            <div className="flex-shrink-0 h-7 flex items-center justify-between px-4 bg-zinc-950 border-t border-zinc-800">
              <div className="flex items-center gap-2 text-[9px] text-zinc-700">
                <span className="w-2 h-2 border-l border-t border-zinc-700" />
                <span>DATA SOURCE: LOCALDB_V04</span>
                <span className="w-2 h-2 border-r border-b border-zinc-700" />
              </div>
              <div className="flex items-center gap-4 text-[9px] text-zinc-600">
                <span>{all.length} rows</span>
                <span className="w-px h-2 bg-zinc-800" />
                <span>{groups.size} groups</span>
                <span className="w-px h-2 bg-zinc-800" />
                <span>{ungrouped.length} ungrouped</span>
              </div>
            </div>
          </div>
        </main>

        {/* ── Right panel: Sync Status ──────────────────────────────────────────── */}
        <aside className="w-80 flex-shrink-0 bg-zinc-950 flex flex-col border-l border-zinc-800 overflow-hidden">
          {/* Panel header */}
          <div className="p-4 border-b border-zinc-800 flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-500" style={{ fill: 'currentColor' }} />
              <span className="text-[15px] font-bold text-zinc-100">Sync Status</span>
            </div>
            <div className={cn(
              'px-2 py-0.5 border text-[9px] font-bold uppercase',
              pendingSync || flaggedRows.length > 0
                ? 'bg-amber-500/10 border-amber-500 text-amber-500'
                : 'bg-green-500/10 border-green-500 text-green-400',
            )}>
              {pendingSync || flaggedRows.length > 0 ? 'Action Required' : 'In Sync'}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-5"
               style={{ scrollbarWidth: 'thin', scrollbarColor: '#2a2a2a transparent' }}>

            {/* Change Detection card */}
            <div className="border border-amber-500/40 bg-amber-500/5 p-3 relative overflow-hidden">
              <div className="absolute top-1 right-1 opacity-10">
                <BarChart3 className="w-10 h-10 text-amber-500" />
              </div>
              <div className="text-[9px] text-amber-500 font-bold uppercase tracking-widest mb-2">
                Change Detection
              </div>
              {pendingSync ? (
                <>
                  <div className="text-[13px] font-bold text-zinc-100 mb-1">
                    Stud Spacing: 450mm → {studSpacing}mm
                  </div>
                  <p className="text-zinc-500 text-[11px] leading-relaxed">
                    Changing stud spacing affects linear meter requirements for all framing members.
                  </p>
                </>
              ) : flaggedRows.length > 0 ? (
                <>
                  <div className="text-[13px] font-bold text-zinc-100 mb-1">
                    {flaggedRows.length} item{flaggedRows.length > 1 ? 's' : ''} with active rates
                  </div>
                  <p className="text-zinc-500 text-[11px] leading-relaxed">
                    Flagged rows have configured unit rates. Review totals before exporting.
                  </p>
                </>
              ) : (
                <>
                  <div className="text-[13px] font-bold text-zinc-100 mb-1">No changes detected</div>
                  <p className="text-zinc-500 text-[11px] leading-relaxed">
                    All line items are in sync with the current configuration.
                  </p>
                </>
              )}
              <div className="mt-3 flex items-center justify-between border-t border-amber-500/20 pt-3">
                <div className="text-[9px] text-zinc-400 font-bold uppercase tracking-widest">Cost Delta</div>
                <div className="text-[14px] font-black text-amber-500 font-mono">
                  +{formatCurrency(costDelta)}
                </div>
              </div>
            </div>

            {/* Impacted line items */}
            {flaggedRows.length > 0 && (
              <div className="space-y-2">
                <div className="text-[9px] text-zinc-500 font-bold uppercase tracking-widest">
                  Impacted Line Items ({flaggedRows.length})
                </div>
                {flaggedRows.slice(0, 4).map((row, i) => (
                  <div key={row.id}
                    className="p-2.5 border border-zinc-800 bg-zinc-900 hover:border-zinc-600 cursor-pointer transition-all">
                    <div className="flex justify-between items-start mb-1">
                      <span className="text-[11px] font-bold text-zinc-100">{rowCode(row, i)}</span>
                      <span className="text-[9px] text-amber-500 font-bold uppercase">Flagged</span>
                    </div>
                    <div className="text-[10px] text-zinc-500 truncate mb-2">{row.description}</div>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 bg-zinc-950 h-1.5 border border-zinc-800">
                        <div className="bg-amber-500 h-full transition-all"
                          style={{ width: `${Math.min((row.quantity / 10) * 100, 100)}%` }} />
                      </div>
                      <span className="text-[9px] font-mono text-zinc-400">
                        {row.quantity.toFixed(1)} {row.unit}
                      </span>
                    </div>
                  </div>
                ))}
                {flaggedRows.length > 4 && (
                  <div className="text-[9px] text-zinc-600 text-center py-1">
                    +{flaggedRows.length - 4} more flagged items
                  </div>
                )}
              </div>
            )}

            {/* Visual reference placeholder */}
            <div className="space-y-2">
              <div className="text-[9px] text-zinc-500 font-bold uppercase tracking-widest">Visual Reference</div>
              <div className="aspect-video bg-zinc-900 border border-zinc-800 relative overflow-hidden group">
                {/* Blueprint grid overlay */}
                <div className="absolute inset-0"
                  style={{
                    backgroundImage: 'linear-gradient(#3f3f46 1px, transparent 1px), linear-gradient(90deg, #3f3f46 1px, transparent 1px)',
                    backgroundSize: '16px 16px',
                    opacity: 0.3,
                  }} />
                {/* SVG structural diagram */}
                <svg viewBox="0 0 240 135" className="absolute inset-0 w-full h-full" xmlns="http://www.w3.org/2000/svg">
                  {/* Vertical studs */}
                  {[30, 70, 110, 150, 190, 210].map((x, i) => (
                    <rect key={i} x={x} y="10" width="6" height="115" fill="#292524" stroke="#52525b" strokeWidth="1" />
                  ))}
                  {/* Top track */}
                  <rect x="20" y="8" width="200" height="8" fill="#3f3f46" stroke="#52525b" strokeWidth="0.8" />
                  {/* Bottom track */}
                  <rect x="20" y="119" width="200" height="8" fill="#3f3f46" stroke="#52525b" strokeWidth="0.8" />
                  {/* Noggins */}
                  {[50, 85].map((y, i) => (
                    <rect key={i} x="20" y={y} width="200" height="5" fill="#1c1917" stroke="#52525b" strokeWidth="0.8" strokeDasharray="4,2" />
                  ))}
                  {/* Amber dimension line */}
                  <line x1="30" y1="130" x2="70" y2="130" stroke="#f59e0b" strokeWidth="1" />
                  <line x1="30" y1="127" x2="30" y2="133" stroke="#f59e0b" strokeWidth="1" />
                  <line x1="70" y1="127" x2="70" y2="133" stroke="#f59e0b" strokeWidth="1" />
                  <text x="47" y="129" fill="#f59e0b" fontSize="6" fontFamily="monospace" textAnchor="middle">{studSpacing}mm</text>
                </svg>
                {/* Label overlay */}
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <div className="text-[9px] font-bold bg-zinc-950/80 px-2 py-1 border border-zinc-800 text-zinc-300 uppercase tracking-widest">
                    SECTION A-A: STUDS @ {studSpacing}MM
                  </div>
                  <div className="mt-2 w-20 h-px bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]" />
                </div>
              </div>
            </div>
          </div>

          {/* Footer actions */}
          <div className="flex-shrink-0 p-4 border-t border-zinc-800 bg-zinc-900/50 space-y-2">
            <button
              onClick={handleAcceptAll}
              className="w-full bg-amber-500 hover:bg-amber-400 text-zinc-950 py-2 text-[10px] font-black uppercase tracking-widest active:scale-95 transition-all"
            >
              Accept All Changes
            </button>
            <button
              onClick={() => { setPendingSync(false); setStudSpacing('450'); }}
              className="w-full border border-zinc-700 text-zinc-400 hover:bg-zinc-800 py-2 text-[10px] font-black uppercase tracking-widest active:scale-95 transition-all"
            >
              Discard &amp; Revert
            </button>
          </div>
        </aside>

      </div>
    </div>
  );
}
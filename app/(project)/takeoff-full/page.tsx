// FILE: src/app/(project)/takeoff-full/page.tsx
// Redesigned to match ESTIMATOR_PRO_V1 reference UI:
//   • Fixed top nav bar with project breadcrumb + stat chips + Share / Export BOQ
//   • Icon-only left sidebar (Files, Layers, Snap, Tools, History, Team)
//   • Configurator strip: currency, VAT, bill standard, Value engineering and Revision history, Recalculate
//   • High-density takeoff table (Code, Description, Material, Quantity, Unit, Rate, Total)
//     with amber "flagged" rows for items waiting on a decision (revision check or pending alternative)
//   • Right panel: Sync Status — Change Detection card, Impacted Line Items, Visual Reference
//     (the selected row on its drawing), value engineering, drawing revisions, Accept / Discard footer
//   • FIXED: Proper hierarchical display of groups and children with indentation

'use client';

import { unitRateOf } from '@/lib/takeoff/materialRate';

import { billedQuantities, billedRows } from '@/lib/takeoff/timesing';
import { veSummary, acceptProposal, setProposalStatus, type VeProposal } from '@/lib/takeoff/valueEngineering';
import { revisionChanges, reviewProgress } from '@/lib/takeoff/revisions';
import { followDerived } from '@/lib/takeoff/assemblies';
import { AnalysisDialog } from '@/components/features/dialogs/WorkspaceDialogs';
import { takeoffToCsv, downloadCsv } from '@/lib/export/csvExport';
import { downloadBlob } from '@/lib/storage/projectDb';
import { RowContextMenu, type RowMenuState } from '@/components/features/takeoff/RowContextMenu';
import { MaterialPicker } from '@/components/common/MaterialPicker';
import { useRowOps } from '@/hooks/shapes/useRowOps';
import { versionNodes, newWorkSince } from '@/lib/takeoff/revisions';
import { Lock } from 'lucide-react';
import { RowPreview } from '@/components/features/takeoff/RowPreview';
import { CURRENCIES, currencyInfo } from '@/lib/takeoff/currency';
import { ValueEngineeringDialog } from '@/components/features/dialogs/ValueEngineeringDialog';
import { RevisionChangesDialog } from '@/components/features/dialogs/RevisionChangesDialog';
import React, { useState, useMemo } from 'react';
import { exportProjectToExcel } from '@/lib/export/clientExport';
import { useProjectHref } from '@/lib/nav/projectHref';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { AnimatePresence } from 'motion/react';
import { Library } from 'lucide-react';
import type { Material } from '@/types';
import { MaterialLibrary } from '@/components/features/takeoff/MaterialLibrary';
import { useRouter } from 'next/navigation';
import { useTakeoffData } from '@/context/TakeoffContext';
import {
  FolderOpen, Layers, Target, Wrench, History,
  Users, HelpCircle, Settings, Share2, Download, TriangleAlert, Eye, EyeOff,
  Trash2, Plus, Search, ChevronDown, ChevronRight,
  Package, FolderOpenDot, Pencil, ArrowLeft,
  BarChart3, Zap, Calculator,
} from 'lucide-react';
import { cn, formatCurrency } from '@/lib/utils';
import { EstimatePanel } from '@/components/features/estimate/EstimatePanel';
import { ChecksStrip, ActivityList } from '@/components/features/estimate/Checks';
import { buildUp, hasMarkups, type Markups } from '@/lib/takeoff/estimate';
import { orderSchedule } from '@/lib/takeoff/materialRate';
import { sanityWarnings } from '@/lib/takeoff/sanity';
import { suggestMaterials } from '@/lib/takeoff/suggestMaterial';
import { getPageScale } from '@/lib/takeoff/scale';
import { loadMasterBank, masterMaterials } from '@/lib/takeoff/masterBank';
import { DEFAULT_MATERIALS } from '@/data/materials';
import { GettingStarted, openGuide } from '@/components/features/onboarding/GettingStarted';
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
        className="w-full bg-zinc-950 border border-amber-accent text-xs font-mono p-1 outline-none text-zinc-200 rounded-none"
      />
    );
  }

  return (
    <div
      onClick={() => { if (!row.isGroupHeader) setEditing(true); }}
      className={cn(
        'truncate min-h-[16px] w-full',
        !row.isGroupHeader && 'cursor-text hover:text-amber-accent transition-colors',
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
            const total = unitRateOf(mat);
            onUpdate(row.id, {
              materialId: mat.id,
              unitRate: total,
              unit: mat.unit,
            });
          } else {
            onUpdate(row.id, { materialId: undefined });
          }
          setEditing(false);
        }}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        className="w-full bg-zinc-950 border border-amber-accent text-xs font-mono p-1 outline-none text-zinc-200 rounded-none"
      >
        <option value="">— None —</option>
        {materials.map(m => (
          <option key={m.id} value={m.id}>
            {m.code} – {m.name} ({formatCurrency(unitRateOf(m))}/{m.unit})
          </option>
        ))}
      </select>
    );
  }

  return (
    <div
      onClick={() => !row.isGroupHeader && setEditing(true)}
      className="cursor-pointer hover:text-amber-accent transition-colors min-h-[16px] w-full"
    >
      {matched ? (
        <div className="flex flex-col gap-0.5">
          <span className="text-[11px] text-zinc-300 font-mono">{matched.code}</span>
          <span className="text-[10px] text-zinc-500 truncate leading-tight">{matched.name}</span>
        </div>
      ) : (
        <span className="text-[11px] text-zinc-600 italic">— assign —</span>
      )}
    </div>
  );
}

// ─── Left icon sidebar item ───────────────────────────────────────────────────
function SideNavItem({
  icon: Icon, label, active = false, onClick, locked = false, hint, guide,
}: {
  /** Name the getting-started guide points at. */
  guide?: string;
  icon: React.ElementType;
  label: string;
  active?: boolean;
  onClick?: () => void;
  /** Shown but not usable yet. */
  locked?: boolean;
  hint?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={locked}
      data-guide={guide}
      title={locked ? `${label}: not available yet` : hint ?? label}
      className={cn(
        'relative w-12 h-12 flex flex-col items-center justify-center gap-0.5 transition-all',
        active
          ? 'bg-amber-accent/10 text-amber-accent border-r-2 border-amber-accent'
          : locked ? 'text-zinc-700 cursor-not-allowed'
          : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300',
      )}
    >
      {locked && <Lock className="absolute top-1 right-1 w-2.5 h-2.5" />}
      <Icon className="w-4 h-4" />
      <span className="text-[10px] font-bold uppercase tracking-wider leading-none">{label}</span>
    </button>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function TakeoffFullPage() {
  const router = useRouter();
  const href = useProjectHref();
  const [exporting, setExporting] = useState(false);
  const { alert: showAlert, confirm } = useConfirm();

  const {
    projectState: ps,
    addMeasurement,
    updateMeasurement,
    deleteMeasurement,
    toggleVisibility,
    setProjectState,
    materialLibraryOpen,
    setMaterialLibraryOpen,
    switchRevisionVersion,
    updateProjectMeta,
    focusMeasurement,
  } = useTakeoffData();

  const [search, setSearch] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [filterType, setFilterType] = useState('All');

  // Full pages opened from here
  const [showVe, setShowVe] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  /** Row shown in the Visual Reference box. */
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [recalculated, setRecalculated] = useState(false);
  /** Main area: the takeoff table, or value engineering as a section of this page. */
  const [section, setSection] = useState<'takeoff' | 'estimate' | 've' | 'revisions' | 'reports'>('takeoff');
  // Right panel: closed by default where the section needs the width (value engineering),
  // open elsewhere. Opening or closing it by hand is remembered for that section.
  const [panelPref, setPanelPref] = useState<Partial<Record<'takeoff' | 'estimate' | 've' | 'revisions' | 'reports', boolean>>>({});
  const panelOpen = panelPref[section] ?? (section !== 've' && section !== 'estimate');
  const setPanelOpen = (open: boolean) => setPanelPref(prev => ({ ...prev, [section]: open }));
  const setPanelOpenFor = (sec: typeof section) => setPanelPref(prev => ({ ...prev, [sec]: true }));
  const [showAnalysis, setShowAnalysis] = useState(false);
  const [reportBusy, setReportBusy] = useState<string | null>(null);
  /** Right panel: sync status, or the versions of each sheet. */
  const [panelTab, setPanelTab] = useState<'sync' | 'versions' | 'activity'>('sync');
  const [rowMenu, setRowMenu] = useState<RowMenuState | null>(null);
  /** Row or group a material is being chosen for. */
  const [materialFor, setMaterialFor] = useState<string | null>(null);
  const [veMaterial, setVeMaterial] = useState<string | null>(null);
  const [bankUnrated, setBankUnrated] = useState(false);
  const [historyKey, setHistoryKey] = useState<string | undefined>(undefined);

  const all = ps.measurements;
  // Costs and totals use billed quantities (timesing applied); cells stay editable as measured.
  const billed = billedQuantities(ps.measurements, ps.drawings);
  const bq = (r: { id: string; quantity: number }) => billed.get(r.id) ?? r.quantity;
  // An estimate is only as complete as its rates.
  const lineItems = all.filter(m => !m.isGroupHeader);
  const unpricedRows = lineItems.filter(m => !(m.unitRate > 0)).length;
  const noMaterialRows = lineItems.filter(m => !m.materialId && !(m.unitRate > 0)).length;
  const usedIds = new Set(lineItems.map(m => m.materialId).filter(Boolean) as string[]);
  const usedMaterialCount = usedIds.size;
  const unratedMaterials = (ps.materials as Material[]).filter(m => usedIds.has(m.id) && !(unitRateOf(m) > 0)).length;
  // The next thing without a material: its group if it is in one, else the item itself.
  const firstBare = lineItems.find(m => !m.materialId && !(m.unitRate > 0));
  // A group with nothing in it yet still needs a material, or what is measured into it later arrives unpriced.
  const emptyBareGroups = all.filter(h => h.isGroupHeader && !h.materialId && !lineItems.some(i => (h.childIds ?? []).includes(i.id)));
  const step1Open = noMaterialRows > 0 || emptyBareGroups.length > 0;
  const nextNoMaterial = firstBare ? all.find(h => h.isGroupHeader && (h.childIds ?? []).includes(firstBare.id)) ?? firstBare : emptyBareGroups[0];

  // ── Changes in play: value engineering and drawing revisions ──────────────
  const materialsList = ps.materials as Material[];
  const proposals = useMemo(() => ps.veProposals ?? [], [ps.veProposals]);
  const ve = useMemo(() => veSummary(proposals, ps.measurements, ps.drawings, materialsList), [proposals, ps.measurements, ps.drawings, materialsList]);
  const pendingVe = ve.lines.filter(l => l.proposal.status === 'proposed').sort((x, y) => y.saving - x.saving);
  const acceptedVe = ve.lines.filter(l => l.proposal.status === 'accepted');
  const pendingMaterials = useMemo(() => new Set(pendingVe.map(l => l.proposal.fromMaterialId)), [pendingVe]);
  const review = useMemo(() => reviewProgress(ps.measurements), [ps.measurements]);
  const lastRevision = useMemo(() => [...(ps.revisionLog ?? [])].reverse().find(r => !r.reverted), [ps.revisionLog]);
  const revision = useMemo(
    () => (lastRevision ? revisionChanges(lastRevision, ps.measurements, ps.drawings, materialsList) : null),
    [lastRevision, ps.measurements, ps.drawings, materialsList],
  );
  const revisionLines = revision ? revision.lines.filter(l => l.status !== 'same') : [];
  const applyVe = (next: { measurements?: TakeoffRow[]; materials?: Material[]; proposals: VeProposal[] }) =>
    setProjectState(prev => ({
      ...prev,
      ...(next.measurements ? { measurements: next.measurements } : {}),
      ...(next.materials ? { materials: next.materials } : {}),
      veProposals: next.proposals,
    }));
  /** Accept the best pending alternative of every material that has one (only real savings). */
  const acceptBest = () => {
    let cur = { measurements: ps.measurements, proposals };
    const done = new Set<string>();
    for (const l of pendingVe) {
      if (l.saving <= 0 || done.has(l.proposal.fromMaterialId)) continue;
      done.add(l.proposal.fromMaterialId);
      cur = acceptProposal(l.proposal.id, cur.proposals, cur.measurements, materialsList);
    }
    applyVe(cur);
  };
  const bestCount = new Set(pendingVe.filter(l => l.saving > 0).map(l => l.proposal.fromMaterialId)).size;
  const actionNeeded = pendingVe.length > 0 || review.open > 0;

  const ops = useRowOps(ps.measurements, materialsList);
  const versions = useMemo(() => [...versionNodes(ps.revisionLog ?? [])].reverse(), [ps.revisionLog]);
  const openMenu = (e: React.MouseEvent, rowId: string) => { e.preventDefault(); e.stopPropagation(); setRowMenu({ x: e.clientX, y: e.clientY, rowId }); };
  const openVe = (materialId?: string | null) => { setVeMaterial(materialId ?? null); setSection('ve'); };
  const materialTarget = materialFor ? all.find(m => m.id === materialFor) : undefined;
  const materialSuggestions = React.useMemo(() => {
    if (!materialTarget || materialTarget.materialId) return [];
    const first = materialTarget.isGroupHeader ? all.find(m => materialTarget.childIds?.includes(m.id)) : materialTarget;
    const prefer = new Set(all.map(m => m.materialId).filter(Boolean) as string[]);
    return suggestMaterials(materialTarget.groupName || materialTarget.description || materialTarget.label || '', ps.materials as Material[], { unit: first?.unit, preferIds: prefer });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materialTarget?.id, materialTarget?.materialId, ps.materials]);
  const restoreVersion = (recordId: string, target: 'from' | 'to', key: string) => {
    const rec = (ps.revisionLog ?? []).find(r => r.id === recordId);
    // Restoring an older version with new work on the newer plan needs a decision: ask on the history page.
    if (target === 'from' && rec && newWorkSince(rec, ps.measurements).length > 0) { setHistoryKey(key); setShowHistory(true); return; }
    const err = switchRevisionVersion(recordId, target, false);
    if (err) void showAlert({ title: 'Could not restore', message: err, confirmText: 'OK' });
  };

  const rejectAllPending = () => {
    let next = proposals;
    for (const l of pendingVe) next = setProposalStatus(l.proposal.id, 'rejected', next);
    applyVe({ proposals: next });
  };
  /** Work every quantity that follows another out again (assembly rows, group totals). */
  const handleRecalculate = () => {
    setProjectState(prev => ({ ...prev, measurements: followDerived(prev.measurements) }));
    setRecalculated(true);
    window.setTimeout(() => setRecalculated(false), 2500);
  };
  // What the changes so far have done to the estimate: revisions add or remove, accepted alternatives save.
  const costDelta = (revision?.cost ?? 0) - ve.accepted;

  // A row is flagged when something about it is waiting for a decision.
  const isFlagged = (row: TakeoffRow) =>
    row.review?.status === 'check' || (!!row.materialId && pendingMaterials.has(row.materialId));

  const filtered = useMemo(() => all.filter((m: TakeoffRow) => {
    const q = search.toLowerCase();
    return (
      m.description.toLowerCase().includes(q) ||
      (m.notes ?? '').toLowerCase().includes(q) ||
      ((m.presetId ?? '') as string).toLowerCase().includes(q) ||
      (m.groupName ?? '').toLowerCase().includes(q)
    );
  }), [all, search]);

  // ─── FIXED: Organise into groups + ungrouped with proper hierarchy ──────────
  const { groups, ungrouped } = useMemo(() => {
    const groups = new Map<string, { header: TakeoffRow; items: TakeoffRow[] }>();
    const ungrouped: TakeoffRow[] = [];
    
    // First pass: find all group headers
    filtered.forEach((m: TakeoffRow) => {
      // Check if this is a group header
      if (m.isGroupHeader === true || (m.childIds && m.childIds.length > 0)) {
        groups.set(m.id, { header: m, items: [] });
      }
    });
    
    // Second pass: assign children to their parents
    filtered.forEach((m: TakeoffRow) => {
      // Skip if this is a group header itself
      if (groups.has(m.id)) return;
      
      // Check if it has a parentId
      if (m.parentId && groups.has(m.parentId)) {
        groups.get(m.parentId)!.items.push(m);
        return;
      }
      
      // Check if it's referenced in any header's childIds
      let assigned = false;
      for (const [groupId, group] of groups) {
        if (group.header.childIds?.includes(m.id)) {
          group.items.push(m);
          assigned = true;
          break;
        }
      }
      
      // If not assigned to any group, it's ungrouped
      if (!assigned && !m.isGroupHeader) {
        ungrouped.push(m);
      }
    });
    
    // Sort items within each group by index or description
    for (const [_, group] of groups) {
      group.items.sort((a, b) => {
        // Try to maintain order based on childIds if available
        if (group.header.childIds) {
          const aIdx = group.header.childIds.indexOf(a.id);
          const bIdx = group.header.childIds.indexOf(b.id);
          if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
        }
        return a.description.localeCompare(b.description);
      });
    }
    
    return { groups, ungrouped };
  }, [filtered]);

  const totalCost = all.reduce((s: number, m: TakeoffRow) => s + (m.isGroupHeader ? m.quantity : bq(m)) * m.unitRate, 0);
  // Measured work → tender sum, the buying list, and the checks.
  const measuredCost = lineItems.reduce((s2, m) => s2 + bq(m) * (m.unitRate || 0), 0);
  const estimateLines = buildUp(measuredCost, ps.markups, ps.vatPercent);
  const tenderSum = estimateLines.find(l => l.key === 'tender')!.amount;
  const order = React.useMemo(() => orderSchedule(billedRows(ps.measurements, ps.drawings), ps.materials as Material[]), [ps.measurements, ps.drawings, ps.materials]);
  const warnings = React.useMemo(() => {
    const pages = ps.drawings.filter(d => !d.supersededBy).flatMap(d =>
      Array.from({ length: Math.max(1, d.pageCount || 1) }, (_, i) => ({ drawing: d, page: i + 1, metresPerPoint: getPageScale(d, i + 1) ?? 0 })).filter(p => p.metresPerPoint > 0));
    let usual: Material[] = [];
    try { usual = masterMaterials(loadMasterBank(ps.currency), DEFAULT_MATERIALS); } catch { /* no storage */ }
    return sanityWarnings({ measurements: ps.measurements, materials: ps.materials as Material[], usual, pages });
  }, [ps.measurements, ps.materials, ps.drawings, ps.currency]);
  const showRow = (id: string) => { setSection('takeoff'); setPreviewId(id); setPanelOpenFor('takeoff'); };
  const totalArea = all.filter(m => !m.isGroupHeader && ['m²', 'sq m', 'm2'].includes(m.unit)).reduce((s, m) => s + bq(m), 0);
  const flaggedRows = [...ungrouped, ...Array.from(groups.values()).flatMap(g => g.items)].filter(isFlagged);
  const previewRow = all.find(m => m.id === previewId) ?? flaggedRows[0] ?? all.find(m => !m.isGroupHeader && m.points?.length);
  const maxFlaggedQty = Math.max(1, ...flaggedRows.map(r => bq(r)));

  const groupCost = (items: TakeoffRow[]) => items.reduce((s, i) => s + bq(i) * i.unitRate, 0);
  const groupQty = (items: TakeoffRow[]) => items.reduce((s, i) => s + bq(i), 0);

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

  const handleAddManual = () =>
    addMeasurement({
      description: 'Manual Item',
      type: 'Length',
      quantity: 0,
      unit: 'm',
      unitRate: 0,
      notes: '',
      points: [],
      isOverridden: false,
      color: '#EF9F27',
      isVisible: true,
    } as any);

  // Helper to get group icon based on type
  const getGroupIcon = (groupType: string) => {
    switch (groupType) {
      case 'carcass': return '🚪';
      case 'staircase': return '🪜';
      case 'roof': return '🏠';
      case 'ceiling': return '⬆️';
      default: return '📁';
    }
  };

  return (
    <div className="flex flex-col h-screen bg-[#131313] font-mono overflow-hidden">

      {/* ── Top navigation bar ─────────────────────────────────────────────────── */}
      <header className="fixed top-0 left-0 right-0 h-14 z-50 bg-zinc-950 border-b border-zinc-800 flex items-center justify-between px-4">
        <div className="flex items-center gap-8">
          <div className="text-[17px] font-black text-amber-accent tracking-tighter uppercase">
            ESTIMATOR_PRO_V1
          </div>
          <nav className="hidden md:flex gap-6 items-center h-14">
            {([
              { label: 'Projects', run: () => router.push('/dashboard'), active: false },
              { label: 'Takeoffs', run: () => setSection('takeoff'), active: section === 'takeoff' },
              { label: 'Estimate', run: () => setSection('estimate'), active: section === 'estimate' },
              { label: 'Value Engineering', run: () => openVe(), active: section === 've', badge: pendingVe.length },
              { label: 'Revisions', run: () => setSection('revisions'), active: section === 'revisions', badge: review.open },
              { label: 'Library', run: () => setMaterialLibraryOpen(true), active: false },
              { label: 'Reports', run: () => setSection('reports'), active: section === 'reports' },
            ] as { label: string; run?: () => void; active: boolean; locked?: boolean; badge?: number }[]).map(link => (
              <button
                key={link.label} type="button" onClick={link.run} disabled={link.locked}
                title={link.locked ? `${link.label}: not available yet` : undefined}
                className={cn(
                  'text-[13px] font-bold uppercase tracking-tight h-14 flex items-center gap-1.5 border-b-2 transition-colors',
                  link.active ? 'text-amber-accent border-amber-accent'
                    : link.locked ? 'text-zinc-700 border-transparent cursor-not-allowed'
                    : 'text-zinc-500 border-transparent hover:text-zinc-300',
                )}
              >
                {link.label}
                {link.locked && <Lock className="w-3 h-3" />}
                {!!link.badge && <span className="bg-amber-accent text-zinc-950 text-[10px] px-1 leading-4">{link.badge}</span>}
              </button>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push(href('/workspace'))}
            className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-zinc-500 hover:text-zinc-300 border border-zinc-700 px-3 py-1.5 transition-all"
          >
            <ArrowLeft className="w-3 h-3" />
            Workspace
          </button>
          <button
            type="button"
            onClick={() => setMaterialLibraryOpen(true)}
            className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-zinc-400 border border-zinc-700 px-3 py-1.5 hover:bg-zinc-900 hover:text-amber-accent transition-all"
          >
            <Library className="w-3 h-3" />
            Material bank
          </button>
          <button
            data-guide="export"
            onClick={() => {
              setExporting(true);
              exportProjectToExcel(ps)
                .catch(err => showAlert({ title: 'Export failed', message: err instanceof Error ? err.message : String(err), tone: 'danger', confirmText: 'OK' }))
                .finally(() => setExporting(false));
            }}
            className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-widest text-zinc-950 bg-amber-accent hover:bg-[#F7D354] px-4 py-1.5 transition-all active:scale-95"
          >
            <Download className="w-3 h-3" />
            {exporting ? 'Exporting…' : 'Export BOQ'}
          </button>
          <div className="flex gap-1 ml-1 border-l border-zinc-800 pl-3">
            <button disabled title="Settings: not available yet" className="relative w-8 h-8 flex items-center justify-center text-zinc-700 cursor-not-allowed">
              <Settings className="w-4 h-4" /><Lock className="absolute right-0.5 bottom-0.5 w-2.5 h-2.5" />
            </button>
            <button type="button" onClick={openGuide} title="Getting started guide" aria-label="Getting started guide" className="w-8 h-8 flex items-center justify-center text-zinc-400 hover:text-amber-accent">
              <HelpCircle className="w-4 h-4" />
            </button>
            <GettingStarted project={ps} page="summary" noButton />
          </div>
        </div>
      </header>

      <div className="flex flex-1 pt-14 h-screen overflow-hidden">

        {/* ── Icon sidebar ───────────────────────────────────────────────────────── */}
        <aside className="fixed left-0 top-14 h-[calc(100vh-3.5rem)] w-20 bg-zinc-900 border-r border-zinc-800 flex flex-col items-center py-4 z-40">
          <div className="flex flex-col gap-1 w-full items-center flex-1">
            <SideNavItem icon={FolderOpen} label="Takeoff" hint="The takeoff table" active={section === 'takeoff'} onClick={() => setSection('takeoff')} />
            <SideNavItem icon={Calculator} label="Estimate" guide="estimate" hint="Preliminaries, contingency, overheads, profit and the buying list" active={section === 'estimate'} onClick={() => setSection('estimate')} />
            <SideNavItem icon={BarChart3} label="Savings" guide="savings" hint="Value engineering: cheaper alternatives and their savings" active={section === 've'} onClick={() => openVe()} />
            <SideNavItem icon={History} label="Revisions" hint="Drawing revisions: every version of a sheet and what each one changed" active={section === 'revisions'} onClick={() => setSection('revisions')} />
            <SideNavItem icon={Download} label="Reports" hint="Excel workbook, CSV, marked-up drawings and the full analysis" active={section === 'reports'} onClick={() => setSection('reports')} />
            {/* EXPERIMENTS LINK: delete this line with lib/demo (see lib/demo/README.md) */}<SideNavItem icon={Zap} label="Labs" hint="Experiments on trial: count symbols, rooms from text, project as a template" onClick={() => router.push(`/demo${typeof window !== 'undefined' ? window.location.search : ''}`)} />
            <SideNavItem icon={Layers} label="Layers" locked />
            <SideNavItem icon={Target} label="Snap" locked />
            <SideNavItem icon={Wrench} label="Tools" locked />
            <SideNavItem icon={Users} label="Team" locked />
          </div>
          <div className="flex flex-col gap-1 w-full items-center">
            <SideNavItem icon={HelpCircle} label="Guide" hint="Getting started: the steps from a drawing to a priced bill" onClick={openGuide} />
            <SideNavItem icon={Settings} label="Settings" locked />
          </div>
        </aside>

        {/* ── Main content (left of right panel) ─────────────────────────────────── */}
        <main className="ml-20 flex-1 flex overflow-hidden border-r border-zinc-800">
          <div className="flex-1 flex flex-col bg-[#131313] overflow-hidden">

            {/* Project breadcrumb + stat chips */}
            <div className="p-4 bg-zinc-950/50 border-b border-zinc-800 flex items-center justify-between flex-shrink-0">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs text-zinc-500 font-bold uppercase tracking-widest">
                    {ps.projectName || 'Project Alpha'}
                  </span>
                  <span className="text-zinc-700 text-xs">/</span>
                  <span className="text-[15px] font-bold text-zinc-100 tracking-tight">
                    Takeoff Summary
                  </span>
                </div>
                <div className="text-xs text-zinc-600">
                  {lineItems.length} item{lineItems.length === 1 ? '' : 's'} · {groups.size} group{groups.size === 1 ? '' : 's'}{ungrouped.length ? ` · ${ungrouped.length} not in a group` : ''}
                </div>
              </div>
              <div className="flex gap-3">
                <div className="px-4 py-2 bg-zinc-900 border border-zinc-800">
                  <div className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest mb-0.5">Measured work</div>
                  <div className={cn('text-[17px] font-black leading-none', hasMarkups(ps.markups) ? 'text-zinc-100' : 'text-amber-accent')}>{formatCurrency(totalCost)}</div>
                </div>
                <button type="button" onClick={() => setSection('estimate')} title="Open the estimate build-up"
                  className="px-4 py-2 bg-zinc-900 border border-zinc-800 text-left hover:border-amber-accent/60">
                  <div className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest mb-0.5">Tender sum <span className="normal-case tracking-normal font-normal">before VAT</span></div>
                  <div className="text-[17px] font-black text-amber-accent leading-none">
                    {hasMarkups(ps.markups) ? formatCurrency(tenderSum) : <span className="text-[11px] font-bold text-zinc-400">+ add markups</span>}
                  </div>
                </button>
                <div className="px-4 py-2 bg-zinc-900 border border-zinc-800">
                  <div className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest mb-0.5">Total Area</div>
                  <div className="text-[17px] font-black text-zinc-100 leading-none">{totalArea.toFixed(2)} M²</div>
                </div>
              </div>
            </div>

            {section === 'estimate' ? (
              <EstimatePanel
                measured={measuredCost} markups={ps.markups} vatPercent={ps.vatPercent} unpricedRows={unpricedRows} order={order}
                onChange={(m: Markups) => setProjectState(prev => ({ ...prev, markups: m }))}
                onOpenBank={() => setMaterialLibraryOpen(true)}
              />
            ) : section === 've' ? (
              <ValueEngineeringDialog
                key={veMaterial ?? 'all'} embedded initialMaterialId={veMaterial}
                measurements={ps.measurements} drawings={ps.drawings} materials={materialsList} proposals={proposals}
                onClose={() => setSection('takeoff')} onChange={applyVe}
              />
            ) : section === 'revisions' ? (
              (ps.revisionLog?.length ?? 0) > 0 ? (
                <RevisionChangesDialog
                  embedded log={ps.revisionLog!} measurements={ps.measurements} drawings={ps.drawings} materials={materialsList} projectName={ps.projectName}
                  onClose={() => setSection('takeoff')}
                  onFocus={id => { focusMeasurement(id); router.push(href('/workspace')); }}
                  onSwitch={(recordId, target, keepNew) => switchRevisionVersion(recordId, target, keepNew)}
                />
              ) : (
                <div className="flex-1 p-8 bg-[#0d0d0d]">
                  <div className="max-w-xl border border-zinc-800 bg-zinc-900 p-5">
                    <div className="text-[10px] text-amber-accent font-bold uppercase tracking-widest mb-2">Drawing revisions</div>
                    <div className="text-[13px] font-bold text-zinc-100 mb-2">No revision has been accepted yet</div>
                    <p className="text-zinc-500 text-xs leading-relaxed mb-4">
                      When a drawing is reissued, open the workspace, press “New revision” under the takeoff table, compare the two plans and accept the new one.
                      The old takeoff is kept here as Version 1, with what changed and what it cost.
                    </p>
                    <button onClick={() => router.push(href('/workspace'))}
                      className="bg-amber-accent hover:bg-[#F7D354] text-zinc-950 px-4 py-2 text-[11px] font-black uppercase tracking-widest">Go to the workspace</button>
                  </div>
                </div>
              )
            ) : section === 'reports' ? (
              <div className="flex-1 overflow-auto p-6 bg-[#0d0d0d]" style={{ scrollbarWidth: 'thin', scrollbarColor: '#2a2a2a transparent' }}>
                <div className="grid gap-4 max-w-5xl" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
                  {([
                    {
                      key: 'xlsx', title: 'Excel workbook', action: 'Download .xlsx',
                      text: `Takeoff and Bill of Quantities${revisionLines.length ? ', Revision changes' : ''}${proposals.length ? ', Value engineering' : ''}. Quantities are as billed; accepted alternatives are already in the prices.`,
                      run: () => exportProjectToExcel(ps).then(() => undefined),
                    },
                    {
                      key: 'billpdf', title: 'Bill and estimate as a PDF', action: 'Download .pdf',
                      text: 'The estimate summary (measured work to tender sum and VAT) and the Bill of Quantities by section, on A4 with page numbers. For clients who want a document rather than a spreadsheet.',
                      run: async () => {
                        const { buildBillPdf } = await import('@/lib/export/billPdf');
                        const pdf = await buildBillPdf({
                          projectName: ps.projectName, projectNumber: ps.projectNumber, location: ps.projectLocation, documentTitle: ps.documentTitle, documentDate: ps.documentDate,
                          revision: ps.revision, currency: ps.currency, vatPercent: ps.vatPercent, markups: ps.markups,
                          measurements: billedRows(ps.measurements, ps.drawings), materials: materialsList,
                        });
                        downloadBlob(new Blob([pdf as BlobPart], { type: 'application/pdf' }), `${ps.projectName.replace(/[^\w\- ]+/g, '') || 'project'}-bill.pdf`);
                      },
                    },
                    {
                      key: 'csv', title: 'CSV', action: 'Download .csv',
                      text: 'Every row with its quantity, rate and amount, then totals by type. Opens in any spreadsheet.',
                      run: async () => downloadCsv(takeoffToCsv({ projectName: ps.projectName, measurements: billedRows(ps.measurements, ps.drawings), materials: materialsList, drawings: ps.drawings }), `${ps.projectName}-takeoff`),
                    },
                    {
                      key: 'analysis', title: 'Full analysis', action: 'Open',
                      text: 'Totals by type and by group, rows without a rate, and pages without a scale.',
                      run: async () => setShowAnalysis(true),
                    },
                    ...ps.drawings.filter(d => ps.measurements.some(m => m.drawingId === d.id && m.points?.length)).map(d => ({
                      key: `pdf-${d.id}`, title: `Marked-up drawing: ${d.name}`, action: 'Download .pdf',
                      text: `The drawing with its measurements in colour and labelled, and a legend page.${d.supersededBy ? ' This sheet has been superseded.' : ''}`,
                      run: async () => {
                        const bytes = d.file ? await d.file.arrayBuffer() : await (await fetch(d.fileUrl)).arrayBuffer();
                        const { buildMarkedUpPdf } = await import('@/lib/export/markupPdf');
                        const pdf = await buildMarkedUpPdf({ pdfBytes: bytes, drawing: d, measurements: ps.measurements, projectName: ps.projectName });
                        downloadBlob(new Blob([pdf as BlobPart], { type: 'application/pdf' }), `${d.name.replace(/\.pdf$/i, '')}-marked-up.pdf`);
                      },
                    })),
                  ]).map(r => (
                    <div key={r.key} className="border border-zinc-800 bg-zinc-900 p-4 flex flex-col">
                      <div className="text-[13px] font-bold text-zinc-100 mb-1 truncate" title={r.title}>{r.title}</div>
                      <p className="text-zinc-500 text-xs leading-relaxed flex-1 mb-3">{r.text}</p>
                      <button
                        disabled={reportBusy === r.key}
                        onClick={() => {
                          setReportBusy(r.key);
                          r.run().catch(err => showAlert({ title: 'Report failed', message: err instanceof Error ? err.message : String(err), tone: 'danger', confirmText: 'OK' }))
                            .finally(() => setReportBusy(null));
                        }}
                        className="self-start bg-amber-accent hover:bg-[#F7D354] text-zinc-950 px-4 py-1.5 text-[11px] font-black uppercase tracking-widest disabled:opacity-50"
                      >{reportBusy === r.key ? 'Working…' : r.action}</button>
                    </div>
                  ))}
                </div>
                <p className="mt-5 text-[11px] text-zinc-600 max-w-2xl leading-relaxed">
                  A marked-up PDF of an older version of a sheet is under Revisions: open that version and use its download button.
                </p>
              </div>
            ) : (<>
            {(unpricedRows > 0 || emptyBareGroups.length > 0) && (
              <div role="status" aria-label="Steps to a priced estimate" data-guide="steps" className="flex flex-wrap items-stretch gap-3 px-6 py-2.5 border-b border-amber-accent/40 bg-amber-accent/[0.07] text-xs">
                <div className="flex items-center gap-2 text-amber-200 pr-2">
                  <TriangleAlert className="w-4 h-4 text-amber-accent shrink-0" />
                  <span>{unpricedRows > 0 ? 'The estimate is incomplete.' : 'One thing left to tidy.'}<br /><span className="text-zinc-400">Two steps to price it:</span></span>
                </div>
                {/* Step 1: what each item is made of */}
                <div className={cn('flex-1 min-w-[260px] flex items-center gap-3 border px-3 py-2', step1Open ? 'border-amber-accent bg-amber-accent/10' : 'border-zinc-700')}>
                  <span className={cn('w-6 h-6 shrink-0 flex items-center justify-center font-bold text-[11px]', step1Open ? 'bg-amber-accent text-black' : 'bg-emerald-600 text-white')}>{step1Open ? '1' : '✓'}</span>
                  <span className="flex-1 min-w-0">
                    <b className="text-zinc-100">Choose a material for each group</b>
                    <span className="block text-zinc-400">
                      {noMaterialRows > 0
                        ? <>{noMaterialRows} of {lineItems.length} items have no material. Click “+ Material for the group” in a row.</>
                        : emptyBareGroups.length > 0
                          ? <>Every item has a material, but {emptyBareGroups.length === 1 ? <>the empty group “{emptyBareGroups[0].description || emptyBareGroups[0].label}” has</> : <>{emptyBareGroups.length} empty groups have</>} none.</>
                          : 'Every item and group has a material.'}
                    </span>
                  </span>
                  {step1Open && nextNoMaterial && (
                    <button type="button" onClick={() => setMaterialFor(nextNoMaterial.id)}
                      className="shrink-0 px-3 py-1 bg-amber-accent text-black text-[11px] font-bold uppercase tracking-widest hover:bg-amber-400">
                      Choose for {(nextNoMaterial.description || nextNoMaterial.label || 'next').slice(0, 18)}
                    </button>
                  )}
                </div>
                {/* Step 2: what each material costs */}
                <div className={cn('flex-1 min-w-[260px] flex items-center gap-3 border px-3 py-2', !step1Open ? 'border-amber-accent bg-amber-accent/10' : 'border-zinc-700')}>
                  <span className={cn('w-6 h-6 shrink-0 flex items-center justify-center font-bold text-[11px]', !step1Open ? 'bg-amber-accent text-black' : 'bg-zinc-700 text-zinc-300')}>2</span>
                  <span className="flex-1 min-w-0">
                    <b className="text-zinc-100">Set the rate of each material</b>
                    <span className="block text-zinc-400">
                      {usedMaterialCount === 0
                        ? 'Nothing to price yet: do step 1 first.'
                        : unratedMaterials > 0
                          ? <>{unratedMaterials} of {usedMaterialCount} material{usedMaterialCount === 1 ? '' : 's'} in use {unratedMaterials === 1 ? 'has' : 'have'} no rate. One rate prices every item on that material.</>
                          : 'Every material in use has a rate.'}
                    </span>
                  </span>
                  <button type="button" disabled={unratedMaterials === 0} onClick={() => { setBankUnrated(true); setMaterialLibraryOpen(true); }}
                    className={cn('shrink-0 px-3 py-1 text-[11px] font-bold uppercase tracking-widest disabled:opacity-40 disabled:cursor-not-allowed',
                      !step1Open ? 'bg-amber-accent text-black hover:bg-amber-400' : 'border border-amber-accent/60 text-amber-accent hover:bg-amber-accent/10')}>
                    Set {unratedMaterials || ''} rate{unratedMaterials === 1 ? '' : 's'}
                  </button>
                </div>
              </div>
            )}
            <ChecksStrip warnings={warnings} onShow={showRow} />
            {/* Configurator strip */}
            <div className="bg-zinc-900/50 border-b border-zinc-800 px-4 py-2.5 flex items-center gap-5 overflow-x-auto flex-shrink-0">
              <div className="flex items-center gap-2 flex-shrink-0">
                <Settings className="w-3.5 h-3.5 text-amber-accent" />
                <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-widest">Configurator</span>
              </div>
              <div className="h-5 w-px bg-zinc-800 flex-shrink-0" />

              <div className="flex flex-col flex-shrink-0" data-guide="money">
                <label htmlFor="cfg-currency" className="text-[10px] text-zinc-500 uppercase font-bold tracking-widest mb-1">Currency</label>
                <select
                  id="cfg-currency"
                  value={ps.currency ?? ''}
                  onChange={e => {
                    const info = currencyInfo(e.target.value);
                    updateProjectMeta({ currency: e.target.value || undefined, ...(info ? { vatPercent: info.vat } : {}) });
                  }}
                  className="bg-zinc-950 border border-zinc-800 text-xs text-zinc-200 py-1 px-2 focus:border-amber-accent outline-none rounded-none font-mono"
                >
                  {!currencyInfo(ps.currency) && <option value={ps.currency ?? ''}>{ps.currency || '—'}</option>}
                  {CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.code}</option>)}
                </select>
              </div>

              <div className="flex flex-col flex-shrink-0">
                <label htmlFor="cfg-vat" className="text-[10px] text-zinc-500 uppercase font-bold tracking-widest mb-1">VAT</label>
                <div className="flex items-center">
                  <input
                    id="cfg-vat" type="text" inputMode="decimal"
                    key={ps.vatPercent ?? 'none'} defaultValue={ps.vatPercent ?? ''}
                    onBlur={e => { const n = parseFloat(e.target.value); updateProjectMeta({ vatPercent: Number.isFinite(n) && n >= 0 ? n : undefined }); }}
                    onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                    className="w-16 bg-zinc-950 border border-zinc-800 text-xs text-zinc-200 py-1 px-2 outline-none rounded-none font-mono focus:border-amber-accent"
                  />
                  <span className="bg-zinc-800 px-2 py-1 text-[10px] text-zinc-500 border border-l-0 border-zinc-800 font-mono">%</span>
                </div>
              </div>

              <div className="flex flex-col flex-shrink-0 opacity-60" title="The bill is laid out to the Principles of Measurement (International)">
                <label className="text-[10px] text-zinc-500 uppercase font-bold tracking-widest mb-1">Bill Standard</label>
                <div className="flex items-center">
                  <input disabled type="text" value="POMI" readOnly className="w-16 bg-zinc-950 border border-zinc-800 text-xs text-zinc-500 py-1 px-2 rounded-none font-mono" />
                </div>
              </div>

              <div className="flex items-center gap-2 bg-zinc-950 border border-zinc-800 px-2 py-1 ml-2 focus-within:border-amber-accent/50 transition-colors flex-shrink-0">
                <Search className="w-3 h-3 text-zinc-600" />
                <input
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search…"
                  className="bg-transparent text-[11px] font-mono text-zinc-300 placeholder-zinc-700 focus:outline-none w-28"
                />
              </div>

              <div className="ml-auto flex items-center gap-3 flex-shrink-0">
                {actionNeeded && !recalculated && (
                  <span className="text-xs text-amber-accent font-bold italic">Changes Pending</span>
                )}
                {recalculated && <span className="text-xs text-green-400 font-bold italic">Recalculated</span>}
                <button
                  onClick={handleRecalculate}
                  title="Work out every quantity that follows another again (assembly rows, group totals)"
                  className="bg-amber-accent hover:bg-[#F7D354] text-zinc-950 px-3 py-1 text-[11px] font-black uppercase tracking-widest active:scale-95 transition-all"
                >
                  Recalculate
                </button>
                <button
                  onClick={handleAddManual}
                  className="flex items-center gap-1.5 border border-zinc-700 text-zinc-400 px-3 py-1 text-[11px] font-bold uppercase tracking-widest hover:bg-zinc-800 transition-all"
                >
                  <Plus className="w-3 h-3" />
                  Add Row
                </button>
              </div>
            </div>

            {/* ── Takeoff table with hierarchy ───────────────────────────────────── */}
            <div className="flex-1 overflow-auto bg-[#0d0d0d]"
                 style={{ scrollbarWidth: 'thin', scrollbarColor: '#2a2a2a transparent' }}>
              <table className="w-full text-left border-collapse min-w-[1000px]">
                <thead className="sticky top-0 bg-zinc-900 z-10">
                  <tr className="border-b border-zinc-700">
                    <th className="w-10 p-2 border-r border-zinc-800" />
                    <th className="p-2 text-[10px] font-bold text-zinc-400 uppercase tracking-widest border-r border-zinc-800">Code</th>
                    <th className="p-2 text-[10px] font-bold text-zinc-400 uppercase tracking-widest border-r border-zinc-800">Description</th>
                    <th className="p-2 text-[10px] font-bold text-zinc-400 uppercase tracking-widest border-r border-zinc-800">Material</th>
                    <th className="p-2 text-[10px] font-bold text-zinc-400 uppercase tracking-widest border-r border-zinc-800 text-right">Quantity</th>
                    <th className="p-2 text-[10px] font-bold text-zinc-400 uppercase tracking-widest border-r border-zinc-800 text-center">Unit</th>
                    <th className="p-2 text-[10px] font-bold text-zinc-400 uppercase tracking-widest border-r border-zinc-800 text-right">Rate</th>
                    <th className="p-2 text-[10px] font-bold text-zinc-400 uppercase tracking-widest text-right">Total</th>
                    <th className="w-20 p-2 text-[10px] font-bold text-zinc-400 uppercase tracking-widest text-center border-l border-zinc-800">Actions</th>
                  </tr>
                </thead>
                <tbody className="text-[12px]">

                  {/* GROUPS SECTION */}
                  {Array.from(groups.entries()).map(([groupId, { header, items }], gIdx) => {
                    const expanded = expandedGroups.has(groupId);
                    const gCode = `G-${String(gIdx + 1).padStart(3, '0')}-A`;
                    const groupTotal = groupCost(items);
                    const groupTotalQty = groupQty(items);
                    
                    return (
                      <React.Fragment key={groupId}>
                        {/* GROUP HEADER ROW - with visual hierarchy indicator */}
                        <tr
                          className="border-t-2 border-amber-accent/30 bg-zinc-900/60 cursor-pointer hover:bg-zinc-800/60 transition-colors group"
                          onClick={() => toggleGroup(groupId)}
                          onContextMenu={e => openMenu(e, header.id)}
                        >
                          <td className="p-2 border-r border-zinc-800 text-center">
                            <FolderOpenDot className="w-4 h-4 text-amber-accent mx-auto" />
                          </td>
                          <td className="p-2 border-r border-zinc-800">
                            <span className="text-amber-accent font-bold text-[11px] bg-amber-accent/10 px-1.5 py-0.5 rounded">
                              {gCode}
                            </span>
                          </td>
                          <td className="p-2 border-r border-zinc-800">
                            <div className="flex items-center gap-2">
                              {expanded
                                ? <ChevronDown className="w-3.5 h-3.5 text-amber-accent flex-shrink-0" />
                                : <ChevronRight className="w-3.5 h-3.5 text-amber-accent flex-shrink-0" />}
                              <span className="text-[12px] font-black text-amber-accent uppercase tracking-wide">
                                {header.groupName || header.description}
                              </span>
                              <span className="text-[10px] text-zinc-600 bg-zinc-800/50 px-2 py-0.5 rounded">
                                {items.length} {items.length === 1 ? 'item' : 'items'}
                              </span>
                              {header.presetId && (
                                <span className="text-[10px] text-zinc-700 border border-zinc-700 px-1.5 py-0.5 rounded">
                                  {header.presetId}
                                </span>
                              )}
                            </div>
                          </td>
                          {/* One material for the whole group: applied to every row in it. */}
                          <td className="p-2 border-r border-zinc-800" onClick={e => e.stopPropagation()}>
                            {(() => {
                              const ids = new Set(items.map(i => i.materialId ?? ''));
                              const one = ids.size === 1 && !ids.has('') ? materialsList.find(m => m.id === items[0].materialId)
                                : !items.length && header.materialId ? materialsList.find(m => m.id === header.materialId) : undefined;
                              const some = items.some(i => i.materialId);
                              return (
                                <button
                                  type="button" onClick={() => setMaterialFor(header.id)}
                                  title="Set one material and its rate for every row in this group"
                                  className={cn(
                                    'w-full text-left text-[11px] px-1.5 py-1 border border-dashed transition-colors truncate',
                                    one ? 'border-transparent text-zinc-300 hover:border-amber-accent/60 hover:text-amber-accent'
                                      : cn('text-zinc-500 hover:border-amber-accent hover:text-amber-accent', header.id === nextNoMaterial?.id ? 'border-amber-accent text-amber-accent animate-pulse' : 'border-zinc-700'),
                                  )}
                                >
                                  {one ? <>{one.code ? <span className="text-zinc-500">{one.code} · </span> : null}{one.name}</>
                                    : some ? 'Mixed materials · set one for all'
                                    : items.length ? '+ Material for the group' : '+ Material'}
                                </button>
                              );
                            })()}
                          </td>
                          <td className="p-2 border-r border-zinc-800 text-right">
                            {new Set(items.map(i => i.unit)).size > 1
                              ? <span className="text-zinc-600 text-xs" title="The items use different units, so they cannot be added up">—</span>
                              : <span className="text-amber-accent font-bold text-xs">{groupTotalQty.toFixed(2)}</span>}
                           </td>
                          <td className="p-2 border-r border-zinc-800 text-center text-zinc-500 text-[11px]">{(() => { const u = new Set(items.map(i => i.unit)); return u.size === 1 ? items[0].unit : u.size ? 'mixed' : '—'; })()}</td>
                          <td className="p-2 border-r border-zinc-800 text-right text-zinc-600">
                            {(() => {
                              const rates = new Set(items.map(i => i.unitRate || 0));
                              return rates.size === 1 && items[0]?.unitRate > 0 ? <span className="text-zinc-300 text-xs">{items[0].unitRate.toFixed(2)}</span> : '—';
                            })()}
                          </td>
                          <td className="p-2 text-right">
                            <span className="font-black text-amber-accent text-[12px]">{formatCurrency(groupTotal)}</span>
                           </td>
                          <td className="p-2 text-center border-l border-zinc-800">
                            <button
                              onClick={e => { e.stopPropagation(); deleteMeasurement(header.id); }}
                              className="text-zinc-700 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                           </td>
                         </tr>

                        {/* GROUP CHILDREN - with indentation to show hierarchy */}
                        {expanded && items.map((item, iIdx) => {
                          const flagged = isFlagged(item);
                          const childCode = `${gCode}.${String(iIdx + 1).padStart(2, '0')}`;
                          return (
                            <tr
                              key={item.id}
                              onClick={() => setPreviewId(item.id)}
                              onContextMenu={e => openMenu(e, item.id)}
                              className={cn(
                                'border-b transition-colors group/item hover:bg-zinc-800/20',
                                flagged
                                  ? 'border-amber-accent/20 bg-amber-accent/5 hover:bg-amber-accent/10'
                                  : 'border-zinc-800/50',
                                iIdx % 2 === 1 && !flagged && 'bg-zinc-900/20',
                              )}
                            >
                              <td className="p-2 border-r border-zinc-800 text-center">
                                {flagged
                                  ? <TriangleAlert className="w-3.5 h-3.5 text-amber-accent mx-auto" />
                                  : <div className="w-1.5 h-1.5 rounded-full bg-zinc-600 mx-auto" />}
                               </td>
                              <td className="p-2 border-r border-zinc-800">
                                <span className={cn('text-[11px] font-mono', flagged ? 'text-amber-accent' : 'text-zinc-500')}>
                                  {childCode}
                                </span>
                               </td>
                              {/* INDENTED DESCRIPTION - shows hierarchy clearly */}
                              <td className="p-2 border-r border-zinc-800">
                                <div className="flex items-center gap-2 pl-6">
                                  <div className="w-4 h-px bg-zinc-700" />
                                  <Package className="w-2.5 h-2.5 text-zinc-600 flex-shrink-0" />
                                  <EditableCell row={item} field="description" type="text" onUpdate={updateMeasurement} />
                                </div>
                               </td>
                              <td className="p-2 border-r border-zinc-800">
                                <MaterialCell row={item} materials={ps.materials as any} onUpdate={updateMeasurement} />
                               </td>
                              <td className={cn('p-2 border-r border-zinc-800 text-right', flagged ? 'text-amber-accent' : '')}>
                                <div className="flex justify-end items-center gap-1">
                                  <EditableCell row={item} field="quantity" type="number" onUpdate={updateMeasurement} />
                                  {item.isOverridden && <Pencil className="w-2 h-2 text-amber-accent/50 flex-shrink-0" />}
                                </div>
                               </td>
                              <td className="p-2 border-r border-zinc-800 text-center text-zinc-500 text-[11px]">
                                {item.unit}
                               </td>
                              <td className="p-2 border-r border-zinc-800 text-right">
                                <EditableCell row={item} field="unitRate" type="number" onUpdate={updateMeasurement} />
                               </td>
                              <td className={cn('p-2 text-right font-bold', flagged ? 'text-amber-accent' : 'text-zinc-300')}>
                                {formatCurrency(bq(item) * item.unitRate)}
                               </td>
                              <td className="p-2 text-center border-l border-zinc-800">
                                <div className="flex items-center justify-center gap-1.5">
                                  <label className="cursor-pointer">
                                    <input type="color" value={item.color || '#EF9F27'}
                                      onChange={e => updateMeasurement(item.id, { color: e.target.value })}
                                      className="opacity-0 w-0 h-0 absolute pointer-events-none" />
                                    <div className="w-3 h-3 rounded-full hover:scale-110 transition-transform shadow-sm opacity-0 group-hover/item:opacity-100"
                                      style={{ backgroundColor: item.color || '#EF9F27' }} />
                                  </label>
                                  <button onClick={() => toggleVisibility(item.id)}
                                    className="text-zinc-700 hover:text-amber-accent transition-colors opacity-0 group-hover/item:opacity-100">
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

                        {/* GROUP SUBTOTAL ROW - shows group summary */}
                        {expanded && items.length > 0 && (
                          <tr className="bg-zinc-950/80 border-b border-zinc-800">
                            <td colSpan={8} className="p-2 px-4 text-right">
                              <div className="flex items-center justify-end gap-4 text-[10px]">
                                <span className="text-zinc-600">Group Subtotal:</span>
                                <span className="text-amber-accent font-bold">{formatCurrency(groupCost(items))}</span>
                                <span className="text-zinc-700">|</span>
                                <span className="text-zinc-600">+10% waste:</span>
                                <span className="text-amber-accent/80">{formatCurrency(groupCost(items) * 0.1)}</span>
                                <span className="text-zinc-700">|</span>
                                <span className="text-zinc-600">Total:</span>
                                <span className="text-amber-accent font-black">{formatCurrency(groupCost(items) * 1.1)}</span>
                              </div>
                             </td>
                            <td className="p-2 border-l border-zinc-800" />
                           </tr>
                        )}
                      </React.Fragment>
                    );
                  })}

                  {/* UNGROUPED ROWS SECTION */}
                  {ungrouped.map((row, idx) => {
                    const flagged = isFlagged(row);
                    const code = rowCode(row, idx);
                    return (
                      <tr
                        key={row.id}
                        onClick={() => setPreviewId(row.id)}
                        onContextMenu={e => openMenu(e, row.id)}
                        className={cn(
                          'border-b transition-colors group',
                          flagged
                            ? 'border-amber-accent/20 bg-amber-accent/5 hover:bg-amber-accent/10'
                            : idx % 2 === 0 ? 'border-zinc-800 bg-[#121212] hover:bg-zinc-800/30' : 'border-zinc-800 hover:bg-zinc-800/30',
                        )}
                      >
                        <td className="p-2 border-r border-zinc-800 text-center">
                          {flagged
                            ? <TriangleAlert className="w-3.5 h-3.5 text-amber-accent mx-auto" />
                            : <div className="w-1.5 h-1.5 rounded-full bg-zinc-600 mx-auto" />}
                         </td>
                        <td className="p-2 border-r border-zinc-800">
                          <span className={cn('text-[11px] font-mono', flagged ? 'text-amber-accent' : 'text-zinc-500')}>
                            {code}
                          </span>
                         </td>
                        <td className="p-2 border-r border-zinc-800">
                          <div className="flex items-center gap-2">
                            <Package className="w-2.5 h-2.5 text-zinc-600 flex-shrink-0" />
                            <EditableCell row={row} field="description" type="text" onUpdate={updateMeasurement} />
                          </div>
                          {row.notes && (
                            <div className="text-[10px] text-zinc-600 mt-0.5 truncate pl-5">{row.notes}</div>
                          )}
                         </td>
                        <td className="p-2 border-r border-zinc-800">
                          <MaterialCell row={row} materials={ps.materials as MaterialSpec[]} onUpdate={updateMeasurement} />
                         </td>
                        <td className={cn('p-2 border-r border-zinc-800 text-right', flagged ? 'text-amber-accent' : '')}>
                          <div className="flex justify-end items-center gap-1">
                            <EditableCell row={row} field="quantity" type="number" onUpdate={updateMeasurement} />
                            {row.isOverridden && <Pencil className="w-2 h-2 text-amber-accent/50 flex-shrink-0" />}
                          </div>
                         </td>
                        <td className="p-2 border-r border-zinc-800 text-center text-zinc-500 text-[11px]">
                          {row.unit}
                         </td>
                        <td className="p-2 border-r border-zinc-800 text-right">
                          <EditableCell row={row} field="unitRate" type="number" onUpdate={updateMeasurement} />
                         </td>
                        <td className={cn('p-2 text-right font-bold', flagged ? 'text-amber-accent' : 'text-zinc-300')}>
                          {formatCurrency(bq(row) * row.unitRate)}
                         </td>
                        <td className="p-2 text-center border-l border-zinc-800">
                          <div className="flex items-center justify-center gap-1.5">
                            <label className="cursor-pointer">
                              <input type="color" value={row.color || '#EF9F27'}
                                onChange={e => updateMeasurement(row.id, { color: e.target.value })}
                                className="opacity-0 w-0 h-0 absolute pointer-events-none" />
                              <div className="w-3 h-3 rounded-full hover:scale-110 transition-transform shadow-sm opacity-0 group-hover:opacity-100"
                                style={{ backgroundColor: row.color || '#EF9F27' }} />
                            </label>
                            <button onClick={() => toggleVisibility(row.id)}
                              className="text-zinc-700 hover:text-amber-accent transition-colors opacity-0 group-hover:opacity-100">
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
                      <td colSpan={9} className="p-16 text-center text-zinc-700 uppercase tracking-widest text-[11px]">
                        {search
                          ? 'No rows match your search.'
                          : 'No measurements yet. Return to Workspace and start measuring.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            </>)}

            {/* ── Status bar ─────────────────────────────────────────────────── */}
            <div className="flex-shrink-0 h-7 flex items-center justify-between px-4 bg-zinc-950 border-t border-zinc-800">
              <div className="flex items-center gap-2 text-[10px] text-zinc-700">
                <span className="w-2 h-2 border-l border-t border-zinc-700" />
                <span>DATA SOURCE: LOCALDB_V04</span>
                <span className="w-2 h-2 border-r border-b border-zinc-700" />
              </div>
              <div className="flex items-center gap-4 text-[10px] text-zinc-600">
                <span className="flex items-center gap-1">
                  <FolderOpenDot className="w-2.5 h-2.5" />
                  {groups.size} groups
                </span>
                <span className="w-px h-2 bg-zinc-800" />
                <span className="flex items-center gap-1">
                  <Package className="w-2.5 h-2.5" />
                  {ungrouped.length} ungrouped
                </span>
                <span className="w-px h-2 bg-zinc-800" />
                <span className="flex items-center gap-1">
                  <TriangleAlert className="w-2.5 h-2.5 text-amber-accent" />
                  {flaggedRows.length} flagged
                </span>
              </div>
            </div>
          </div>
        </main>

        {/* ── Right panel: Sync Status ──────────────────────────────────────────── */}
        {!panelOpen && (
          <aside className="w-10 flex-shrink-0 bg-zinc-950 border-l border-zinc-800 flex flex-col items-center">
            <button type="button" onClick={() => setPanelOpen(true)} aria-expanded={false} aria-label="Open the sync status panel"
              title={`Sync status: ${actionNeeded ? 'action required' : 'in sync'}. Click to open.`}
              className="w-full flex-1 flex flex-col items-center gap-3 py-4 text-zinc-500 hover:text-amber-accent hover:bg-zinc-900">
              <ChevronRight className="w-4 h-4 rotate-180" />
              <Zap className="w-4 h-4 text-amber-accent" style={{ fill: 'currentColor' }} />
              <span className={cn('w-2 h-2 rounded-full', actionNeeded ? 'bg-amber-accent' : 'bg-green-500')} />
              <span className="text-[10px] font-bold uppercase tracking-widest [writing-mode:vertical-rl]">Sync status</span>
            </button>
          </aside>
        )}
        <aside className={cn('w-80 flex-shrink-0 bg-zinc-950 flex-col border-l border-zinc-800 overflow-hidden', panelOpen ? 'flex' : 'hidden')}>
          <div className="p-4 border-b border-zinc-800 flex items-center justify-between gap-2 flex-shrink-0">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-accent" style={{ fill: 'currentColor' }} />
              <span className="text-[15px] font-bold text-zinc-100">Sync Status</span>
            </div>
            <div className={cn(
              'px-2 py-0.5 border text-[10px] font-bold uppercase',
              actionNeeded ? 'bg-amber-accent/10 border-amber-accent text-amber-accent' : 'bg-green-500/10 border-green-500 text-green-400',
            )}>
              {actionNeeded ? 'Action Required' : 'In Sync'}
            </div>
            <button type="button" onClick={() => setPanelOpen(false)} aria-expanded aria-label="Collapse the sync status panel" title="Collapse this panel"
              className="text-zinc-500 hover:text-amber-accent -mr-1">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <div role="tablist" className="flex border-b border-zinc-800 flex-shrink-0">
            {([['sync', 'Sync status'], ['versions', `Versions${versions.length ? ` (${versions.length})` : ''}`], ['activity', 'Activity']] as const).map(([k, label]) => (
              <button key={k} role="tab" aria-selected={panelTab === k} onClick={() => setPanelTab(k)}
                className={cn('flex-1 py-2 text-[10px] font-bold uppercase tracking-widest border-b-2 transition-colors',
                  panelTab === k ? 'text-amber-accent border-amber-accent' : 'text-zinc-500 border-transparent hover:text-zinc-300')}>{label}</button>
            ))}
          </div>

          {panelTab === 'activity' ? (
            <div className="flex-1 overflow-y-auto p-4" style={{ scrollbarWidth: 'thin', scrollbarColor: '#2a2a2a transparent' }}>
              <ActivityList log={ps.auditLog ?? []} onShow={showRow} />
            </div>
          ) : panelTab === 'versions' ? (
            <div className="flex-1 overflow-y-auto p-4 space-y-3" style={{ scrollbarWidth: 'thin', scrollbarColor: '#2a2a2a transparent' }}>
              <p className="text-zinc-500 text-xs leading-relaxed">
                Every accepted drawing revision keeps the takeoff of the version before it. Only the current version is counted.
              </p>
              {versions.map(n => (
                <div key={n.key} className={cn('p-2.5 border bg-zinc-900', n.status === 'current' ? 'border-green-700/60' : 'border-zinc-800')}>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-xs font-bold text-zinc-100">Version {n.version}</span>
                    <span className={cn('text-[9px] font-bold uppercase tracking-widest px-1 border',
                      n.status === 'current' ? 'border-green-700 text-green-400' : n.status === 'set aside' ? 'border-amber-accent/70 text-amber-accent' : 'border-zinc-600 text-zinc-500')}>{n.status}</span>
                  </div>
                  <div className="text-[11px] text-zinc-400 truncate" title={n.name}>{n.name}</div>
                  <div className="text-[10px] text-zinc-600 mb-2">
                    {n.date ? `accepted ${n.date.slice(0, 10)}` : 'first issue'}{n.rows ? ` · ${n.rows.filter(m => !m.isGroupHeader).length} items kept` : ''}
                  </div>
                  <div className="flex gap-1.5">
                    <button onClick={() => { setHistoryKey(n.key); setShowHistory(true); }}
                      className="px-2 py-0.5 text-[10px] font-bold uppercase border border-zinc-700 text-zinc-300 hover:border-amber-accent hover:text-amber-accent">
                      {n.status === 'current' ? 'What changed' : 'View takeoff'}
                    </button>
                    {n.restore && (
                      <button onClick={() => restoreVersion(n.restore!.recordId, n.restore!.target, n.key)}
                        className="px-2 py-0.5 text-[10px] font-bold uppercase border border-amber-accent/70 text-amber-accent hover:bg-amber-accent/10">Restore</button>
                    )}
                    {!n.restore && n.blocked && <span className="text-[10px] text-zinc-600 self-center" title={n.blocked}>{n.blocked}</span>}
                  </div>
                </div>
              ))}
              {versions.length === 0 && (
                <div className="p-3 border border-zinc-800 bg-zinc-900 text-zinc-500 text-xs leading-relaxed">
                  No versions yet. When a drawing is reissued, use “New revision” in the workspace and accept the new plan; the old takeoff is then kept here as Version 1.
                </div>
              )}
            </div>
          ) : (<>
          <div className="flex-1 overflow-y-auto p-4 space-y-5" style={{ scrollbarWidth: 'thin', scrollbarColor: '#2a2a2a transparent' }}>

            {/* Change Detection card */}
            <div className="border border-amber-accent/40 bg-amber-accent/5 p-3 relative overflow-hidden">
              <div className="absolute top-1 right-1 opacity-10"><BarChart3 className="w-10 h-10 text-amber-accent" /></div>
              <div className="text-[10px] text-amber-accent font-bold uppercase tracking-widest mb-2">Change Detection</div>
              <div className="text-[13px] font-bold text-zinc-100 mb-1">
                {review.open > 0 && pendingVe.length > 0 ? `${review.open} revision check${review.open > 1 ? 's' : ''} and ${pendingVe.length} alternative${pendingVe.length > 1 ? 's' : ''} waiting`
                  : review.open > 0 ? `${review.open} measurement${review.open > 1 ? 's' : ''} to check after the revision`
                  : pendingVe.length > 0 ? `${pendingVe.length} alternative${pendingVe.length > 1 ? 's' : ''} waiting for a decision`
                  : 'No changes waiting'}
              </div>
              <p className="text-zinc-500 text-xs leading-relaxed">
                {actionNeeded
                  ? 'Flagged rows are waiting on a decision: a drawing revision to check, or a cheaper alternative to accept or reject.'
                  : 'Every line item is in step with the current drawings and materials.'}
              </p>
              <div className="mt-3 flex items-center justify-between border-t border-amber-accent/20 pt-3">
                <div className="text-[10px] text-zinc-400 font-bold uppercase tracking-widest" title="Cost of the latest drawing revision, less the savings from accepted alternatives">Cost Delta</div>
                <div className={cn('text-[14px] font-black font-mono', costDelta < 0 ? 'text-green-400' : 'text-amber-accent')}>
                  {costDelta < 0 ? '−' : '+'}{formatCurrency(Math.abs(costDelta))}
                </div>
              </div>
            </div>

            {/* Impacted line items */}
            {flaggedRows.length > 0 && (
              <div className="space-y-2">
                <div className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Impacted Line Items ({flaggedRows.length})</div>
                {flaggedRows.slice(0, 4).map((row, i) => (
                  <div
                    key={row.id} role="button" tabIndex={0}
                    onClick={() => setPreviewId(row.id)} onKeyDown={e => { if (e.key === 'Enter') setPreviewId(row.id); }}
                    className={cn('p-2.5 border bg-zinc-900 hover:border-zinc-600 cursor-pointer transition-all', previewRow?.id === row.id ? 'border-amber-accent/70' : 'border-zinc-800')}
                  >
                    <div className="flex justify-between items-start mb-1">
                      <span className="text-xs font-bold text-zinc-100">{rowCode(row, i)}</span>
                      <span className="text-[10px] text-amber-accent font-bold uppercase">{row.review?.status === 'check' ? 'Check revision' : 'Alternative'}</span>
                    </div>
                    <div className="text-[11px] text-zinc-500 truncate mb-2">{row.description}</div>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 bg-zinc-950 h-1.5 border border-zinc-800">
                        <div className="bg-amber-accent h-full transition-all" style={{ width: `${Math.min((bq(row) / maxFlaggedQty) * 100, 100)}%` }} />
                      </div>
                      <span className="text-[10px] font-mono text-zinc-400">{bq(row).toFixed(1)} {row.unit}</span>
                    </div>
                  </div>
                ))}
                {flaggedRows.length > 4 && <div className="text-[10px] text-zinc-600 text-center py-1">+{flaggedRows.length - 4} more flagged items</div>}
              </div>
            )}

            {/* Visual reference: where the selected row is on its drawing */}
            <div className="space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Visual Reference</span>
                <span className="text-[10px] text-zinc-400 truncate" title={previewRow?.description}>{previewRow?.description ?? 'Click a row'}</span>
              </div>
              <RowPreview row={previewRow} measurements={ps.measurements} drawings={ps.drawings} />
            </div>

            {/* Value engineering */}
            <div className="border border-amber-accent/40 bg-amber-accent/5 p-3 relative overflow-hidden">
              <div className="absolute top-1 right-1 opacity-10"><BarChart3 className="w-10 h-10 text-amber-accent" /></div>
              <div className="text-[10px] text-amber-accent font-bold uppercase tracking-widest mb-2">Value engineering</div>
              <div className="text-[13px] font-bold text-zinc-100 mb-1">
                {proposals.length === 0 ? 'No alternatives proposed yet'
                  : pendingVe.length > 0 ? `${pendingVe.length} alternative${pendingVe.length > 1 ? 's' : ''} waiting for a decision`
                  : `${acceptedVe.length} accepted, none waiting`}
              </div>
              <p className="text-zinc-500 text-xs leading-relaxed">
                {proposals.length === 0
                  ? 'Propose a cheaper or better-value material and see the saving across every row that uses it.'
                  : 'Same quantities, different material and rate. The designed material is always kept.'}
              </p>
              <div className="mt-3 space-y-1 border-t border-amber-accent/20 pt-3">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-zinc-400 font-bold uppercase tracking-widest">Saving accepted</span>
                  <span className="text-[14px] font-black text-green-400 font-mono">{formatCurrency(ve.accepted)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-zinc-400 font-bold uppercase tracking-widest">Still on offer</span>
                  <span className="text-[14px] font-black text-amber-accent font-mono">{formatCurrency(ve.pending)}</span>
                </div>
              </div>
            </div>

            {pendingVe.length > 0 && (
              <div className="space-y-2">
                <div className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Alternatives to decide ({pendingVe.length})</div>
                {pendingVe.slice(0, 5).map(l => (
                  <div key={l.proposal.id} className="p-2.5 border border-zinc-800 bg-zinc-900">
                    <div className="text-[11px] text-zinc-500 truncate" title={l.designed}>{l.designed}</div>
                    <div className="text-xs font-bold text-zinc-100 truncate" title={l.alternative}>→ {l.alternative}</div>
                    <div className="flex items-center justify-between mt-2">
                      <span className={cn('text-[11px] font-mono font-bold', l.saving > 0 ? 'text-green-400' : 'text-red-400')}>
                        {l.saving >= 0 ? 'saves ' : 'costs '}{formatCurrency(Math.abs(l.saving))}{l.saving > 0 ? ` (${l.savingPercent}%)` : ' more'}
                      </span>
                      <span className="flex gap-1">
                        <button onClick={() => applyVe(acceptProposal(l.proposal.id, proposals, ps.measurements, materialsList))}
                          className="px-2 py-0.5 text-[10px] font-bold uppercase border border-green-700 text-green-400 hover:bg-green-500/10">Accept</button>
                        <button onClick={() => applyVe({ proposals: setProposalStatus(l.proposal.id, 'rejected', proposals) })}
                          className="px-2 py-0.5 text-[10px] font-bold uppercase border border-zinc-700 text-zinc-400 hover:bg-zinc-800">Reject</button>
                      </span>
                    </div>
                  </div>
                ))}
                {pendingVe.length > 5 && <div className="text-[10px] text-zinc-600 text-center py-1">+{pendingVe.length - 5} more in Value engineering</div>}
              </div>
            )}

            {/* Drawing revisions */}
            <div className="border border-zinc-800 bg-zinc-900 p-3">
              <div className="text-[10px] text-zinc-400 font-bold uppercase tracking-widest mb-2">Drawing revisions</div>
              {revision && lastRevision ? (
                <>
                  <div className="text-[13px] font-bold text-zinc-100 mb-1 truncate" title={`${lastRevision.from.name} → ${lastRevision.to.name}`}>
                    {lastRevision.from.name} → {lastRevision.to.name}
                  </div>
                  <p className="text-zinc-500 text-xs leading-relaxed">
                    {revision.counts.changed} changed · {revision.counts.added} added · {revision.counts.removed} removed
                    {review.total > 0 && <> · <span className={review.open > 0 ? 'text-red-400' : 'text-green-400'}>{review.open > 0 ? `${review.open} of ${review.total} still to check` : 'all checked'}</span></>}
                  </p>
                  <div className="mt-3 flex items-center justify-between border-t border-zinc-800 pt-3">
                    <span className="text-[10px] text-zinc-400 font-bold uppercase tracking-widest">Cost of the changes</span>
                    <span className="text-[14px] font-black text-amber-accent font-mono">{revision.cost < 0 ? '−' : '+'}{formatCurrency(Math.abs(revision.cost))}</span>
                  </div>
                  {revisionLines.slice(0, 4).map(l => (
                    <div key={l.id} className="flex items-baseline gap-2 mt-2 text-[11px]">
                      <span className="flex-1 min-w-0 truncate text-zinc-400" title={l.description}>{l.description}</span>
                      <span className="font-mono text-zinc-200">{l.diff > 0 ? '+' : ''}{l.diff.toFixed(2)} {l.unit}</span>
                    </div>
                  ))}
                  {revisionLines.length > 4 && <div className="text-[10px] text-zinc-600 mt-2">+{revisionLines.length - 4} more in Revision history</div>}
                </>
              ) : (
                <p className="text-zinc-500 text-xs leading-relaxed">
                  No revision accepted yet. When a drawing is reissued, use “Compare with a new revision” in the workspace; what it changed will show here.
                </p>
              )}
            </div>
          </div>

          {/* Footer actions */}
          <div className="flex-shrink-0 p-4 border-t border-zinc-800 bg-zinc-900/50 space-y-2">
            <button
              onClick={acceptBest}
              disabled={bestCount === 0}
              title={bestCount > 0 ? `Accept the best alternative for ${bestCount} material${bestCount > 1 ? 's' : ''}` : 'No alternative with a saving is waiting'}
              className="w-full bg-amber-accent hover:bg-[#F7D354] text-zinc-950 py-2 text-[11px] font-black uppercase tracking-widest active:scale-95 transition-all disabled:opacity-40 disabled:active:scale-100"
            >
              Accept All Changes
            </button>
            <button
              onClick={rejectAllPending}
              disabled={pendingVe.length === 0}
              title="Reject every alternative still waiting; the takeoff stays as designed"
              className="w-full border border-zinc-700 text-zinc-400 hover:bg-zinc-800 py-2 text-[11px] font-black uppercase tracking-widest active:scale-95 transition-all disabled:opacity-40 disabled:active:scale-100"
            >
              Discard &amp; Revert
            </button>
          </div>
          </>)}
        </aside>

      </div>
      {showAnalysis && (
        <AnalysisDialog
          measurements={billedRows(ps.measurements, ps.drawings)} drawings={ps.drawings} materials={materialsList}
          onClose={() => setShowAnalysis(false)}
          onFocus={id => { focusMeasurement(id); router.push(href('/workspace')); }}
          onGoToPage={() => router.push(href('/workspace'))}
        />
      )}
      {rowMenu && (
        <RowContextMenu
          menu={rowMenu} measurements={ps.measurements} ops={ops}
          onClose={() => setRowMenu(null)}
          onPreview={setPreviewId}
          onOpenInWorkspace={id => { focusMeasurement(id); router.push(href('/workspace')); }}
          onPickMaterial={setMaterialFor}
          onProposeAlternative={openVe}
          onConfirmDelete={row => {
            const name = row.groupName || row.description || row.label || 'this row';
            void confirm({
              title: row.isGroupHeader ? 'Delete group' : 'Delete row',
              message: <>Delete <span className="text-zinc-100 font-bold">{name}</span>{row.isGroupHeader ? ' and all its rows' : ''}?</>,
              detail: 'Ctrl+Z in the workspace brings it back.', confirmText: 'Delete',
            }).then(ok => { if (ok) deleteMeasurement(row.id); });
          }}
        />
      )}
      {materialTarget && (
        <div className="fixed inset-0 z-[140] flex items-start justify-center pt-32 bg-black/60" onPointerDown={e => { if (e.target === e.currentTarget) setMaterialFor(null); }}>
          <div className="w-[26rem] bg-zinc-900 border border-amber-accent/60 p-4 shadow-2xl">
            <div className="text-[10px] text-amber-accent font-bold uppercase tracking-widest mb-1">
              {materialTarget.isGroupHeader ? 'Material for the whole group' : 'Material for this row'}
            </div>
            <div className="text-xs text-zinc-100 mb-3 truncate">
              {materialTarget.groupName || materialTarget.description || materialTarget.label}
              {materialTarget.isGroupHeader && <span className="text-zinc-500"> · applies to every row in it</span>}
            </div>
            {materialSuggestions.length > 0 && (
              <div className="mb-3" aria-label="Suggested materials">
                <div className="text-[10px] text-zinc-500 uppercase tracking-widest mb-1.5">Suggested from the name</div>
                <div className="flex flex-col gap-1">
                  {materialSuggestions.map(sg => (
                    <button key={sg.material.id} type="button"
                      onClick={() => { ops.setMaterial(materialTarget.id, sg.material.id); setMaterialFor(null); }}
                      className="flex items-baseline gap-2 px-2 py-1.5 border border-zinc-700 text-left text-xs text-zinc-100 hover:border-amber-accent hover:bg-amber-accent/10">
                      <span className="flex-1 min-w-0 truncate">{sg.material.name}</span>
                      <span className="text-[10px] text-zinc-500 whitespace-nowrap">{unitRateOf(sg.material) > 0 ? `${formatCurrency(unitRateOf(sg.material))} / ` : 'no price / '}{sg.material.unit}</span>
                    </button>
                  ))}
                </div>
                <div className="text-[10px] text-zinc-600 mt-1.5">Or search the whole bank:</div>
              </div>
            )}
            <MaterialPicker
              autoOpen materials={materialsList} value={materialTarget.materialId ?? null}
              measurementType={materialTarget.isGroupHeader
                ? all.find(m => materialTarget.childIds?.includes(m.id))?.type ?? materialTarget.type
                : materialTarget.points?.length ? materialTarget.type : undefined}
              onOpenBank={() => { setMaterialFor(null); setMaterialLibraryOpen(true); }}
              onClose={() => setMaterialFor(null)}
              onChange={id => { ops.setMaterial(materialTarget.id, id); setMaterialFor(null); }}
            />
          </div>
        </div>
      )}
      {showVe && (
        <ValueEngineeringDialog
          measurements={ps.measurements} drawings={ps.drawings} materials={materialsList} proposals={proposals}
          onClose={() => setShowVe(false)} onChange={applyVe}
        />
      )}
      {showHistory && (ps.revisionLog?.length ?? 0) > 0 && (
        <RevisionChangesDialog
          log={ps.revisionLog!} measurements={ps.measurements} drawings={ps.drawings} materials={materialsList} projectName={ps.projectName}
          initialKey={historyKey}
          onClose={() => { setShowHistory(false); setHistoryKey(undefined); }}
          onFocus={() => setShowHistory(false)}
          onSwitch={(recordId, target, keepNew) => switchRevisionVersion(recordId, target, keepNew)}
        />
      )}
      <AnimatePresence>
        {materialLibraryOpen && (
          <MaterialLibrary
            materials={ps.materials as Material[]}
            onUpdateMaterials={(mats: Material[]) => setProjectState(prev => ({ ...prev, materials: mats }))}
            onClose={() => { setMaterialLibraryOpen(false); setBankUnrated(false); }}
            initialUnrated={bankUnrated}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
import React, { useState } from 'react';
import {
  FileText, FolderOpen, Filter, Search, Settings2, Plus, PanelLeftClose,
  Database, Info, Layers, Building2, FileCheck2, Users2,
  BookOpen, ChevronDown, ChevronRight, AlertTriangle, Ban, Trash2, X,
} from 'lucide-react';
import { useTakeoffData } from '@/context/TakeoffContext';
import { getPageScale } from '@/lib/takeoff/scale';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { cn } from '@/lib/utils';
import { Material } from '@/types';
import {
  Stakeholders,
  ScopeAssumption,
  ExcludedItem,
} from '@/context/TakeoffContext';

// ─── Props ────────────────────────────────────────────────────────────────────

interface ProjectState {
  drawings:         { id: string; name: string }[];
  activeDrawingId?: string;

  // Core
  projectName:    string;
  projectNumber?: string;

  // Project Identity
  projectLocation?: string;
  projectPhase?:    string;
  kitchenType?:     string;
  totalUnits?:      number;

  // Document Metadata
  documentTitle?: string;
  documentDate?:  string;
  revision?:      string;
  currency?:      string;
  vatPercent?:    number;

  // Stakeholders
  stakeholders?: Stakeholders;

  // Drawing References
  drawingReferences?: string[];

  // Scope Notes
  generalAssumptions?: ScopeAssumption[];
  excludedItems?:      ExcludedItem[];
}

interface SidebarProps {
  isCollapsed:            boolean;
  /** Collapse the sidebar (button in the Project Explorer strip). */
  onCollapse?:            () => void;
  projectState:           ProjectState;
  onUpdateMaterials:      (materials: Material[]) => void;
  onOpenMaterialLibrary?: () => void;
  onDrawingAdded:         (name: string, fileUrl: string, file?: File) => void;
  onSelectDrawing:        (id: string) => void;
  // Metadata update — single handler, partial updates only
  onUpdateProjectMeta:    (updates: Partial<Omit<ProjectState,
    'drawings' | 'activeDrawingId'
  >>) => void;
}

// ─── Small reusable pieces ────────────────────────────────────────────────────

function SectionHeader({
  icon: Icon,
  label,
  expanded,
  onToggle,
}: {
  icon: React.ElementType;
  label: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center justify-between group mb-2"
    >
      <span className="text-[11px] font-bold text-amber-accent uppercase tracking-widest flex items-center gap-2">
        <Icon className="w-3.5 h-3.5" />
        {label}
      </span>
      {expanded
        ? <ChevronDown className="w-3 h-3 text-zinc-600 group-hover:text-zinc-400 transition-colors" />
        : <ChevronRight className="w-3 h-3 text-zinc-600 group-hover:text-zinc-400 transition-colors" />
      }
    </button>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-[10px] text-zinc-500 uppercase tracking-widest font-bold block mb-1">
        {label}
      </label>
      {children}
    </div>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
}: {
  value:       string;
  onChange:    (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
      className="w-full bg-[#16191C] border border-zinc-800 p-2 text-xs font-bold text-zinc-200 outline-none focus:border-amber-accent transition-colors uppercase placeholder:normal-case placeholder:text-zinc-700 placeholder:font-normal"
    />
  );
}

function NumberInput({
  value,
  onChange,
  placeholder,
}: {
  value:        number | undefined;
  onChange:     (v: number | undefined) => void;
  placeholder?: string;
}) {
  return (
    <input
      type="number"
      value={value ?? ''}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      className="w-full bg-[#16191C] border border-zinc-800 p-2 text-xs font-bold text-zinc-200 outline-none focus:border-amber-accent transition-colors placeholder:text-zinc-700 placeholder:font-normal"
    />
  );
}

function Divider() {
  return <div className="h-px bg-zinc-800/50 w-full" />;
}

// ─── Main Component ───────────────────────────────────────────────────────────

function SidebarImpl({
  isCollapsed,
  onCollapse,
  projectState,
  onUpdateMaterials,
  onOpenMaterialLibrary,
  onDrawingAdded,
  onSelectDrawing,
  onUpdateProjectMeta,
}: SidebarProps) {
  const [activeTab, setActiveTab] = useState<'drawings' | 'specs'>('drawings');
  const { activePage, goToPage, removeDrawing, projectState: fullProject } = useTakeoffData();
  const [searchOpen,  setSearchOpen]  = useState(false);
  const [query,       setQuery]       = useState('');
  const [needsScale,  setNeedsScale]  = useState(false);

  // Per-drawing calibration summary (cheap: page counts are small).
  const pageInfo = React.useMemo(() => {
    const out = new Map<string, { pages: number; calibrated: boolean[] }>();
    for (const d of fullProject.drawings) {
      const pages = Math.max(1, d.pageCount || 1);
      out.set(d.id, { pages, calibrated: Array.from({ length: pages }, (_, i) => getPageScale(d, i + 1) !== null) });
    }
    return out;
  }, [fullProject.drawings]);

  const visibleDrawings = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return fullProject.drawings.filter(d =>
      (!q || d.name.toLowerCase().includes(q)) &&
      (!needsScale || (pageInfo.get(d.id)?.calibrated.some(c => !c) ?? true)));
  }, [fullProject.drawings, query, needsScale, pageInfo]);

  const totals = React.useMemo(() => {
    let pages = 0, done = 0;
    for (const info of pageInfo.values()) { pages += info.pages; done += info.calibrated.filter(Boolean).length; }
    const measured = fullProject.measurements.filter(m => !m.isGroupHeader).length;
    return { pages, done, measured };
  }, [pageInfo, fullProject.measurements]);

  const { confirm } = useConfirm();
  const confirmRemoveDrawing = async (id: string, name: string) => {
    const count = fullProject.measurements.filter(m => m.drawingId === id && !m.isGroupHeader).length;
    const ok = await confirm({
      title: 'Remove drawing',
      message: <>Remove <span className="text-zinc-100 font-bold">{name}</span> from this project?</>,
      detail: count
        ? `Its ${count} measurement${count === 1 ? '' : 's'} will be deleted too. This can’t be undone.`
        : 'This can’t be undone.',
      confirmText: 'Remove',
    });
    if (ok) removeDrawing(id);
  };

  // Collapsible section state
  const [open, setOpen] = useState({
    identity:     true,
    document:     false,
    stakeholders: false,
    drawingRefs:  false,
    assumptions:  false,
    excluded:     false,
    library:      true,
  });

  const toggle = (key: keyof typeof open) =>
    setOpen(prev => ({ ...prev, [key]: !prev[key] }));

  // Convenience: update a single stakeholder field
  const updateStakeholder = (field: keyof Stakeholders, value: string) => {
    onUpdateProjectMeta({
      stakeholders: { ...projectState.stakeholders, [field]: value || undefined },
    });
  };

  // Convenience: update a drawing reference by index
  const updateDrawingRef = (index: number, value: string) => {
    const refs = [...(projectState.drawingReferences ?? [])];
    refs[index] = value;
    onUpdateProjectMeta({ drawingReferences: refs.filter(Boolean) });
  };

  const addDrawingRef = () => {
    onUpdateProjectMeta({
      drawingReferences: [...(projectState.drawingReferences ?? []), ''],
    });
  };

  const removeDrawingRef = (index: number) => {
    const refs = [...(projectState.drawingReferences ?? [])];
    refs.splice(index, 1);
    onUpdateProjectMeta({ drawingReferences: refs });
  };

  return (
    <aside
      className={cn(
        "bg-industrial-panel border-r border-industrial-border flex flex-col h-full transition-all duration-300 ease-in-out font-mono",
        isCollapsed ? "w-0 overflow-hidden border-none" : "w-72 shrink-0"
      )}
    >
      {/* ── Header ── */}
      <div className="p-3 border-b border-industrial-border bg-stone-900/50 flex justify-between items-center shrink-0">
        <span className="text-[11px] font-bold text-zinc-500 my-1 tracking-widest uppercase">
          Project Explorer
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => { setNeedsScale(v => !v); setActiveTab('drawings'); }}
            aria-pressed={needsScale}
            title={needsScale ? 'Show all drawings' : 'Show only drawings with pages that need a scale'}
            className={cn('transition-colors', needsScale ? 'text-amber-accent' : 'text-zinc-600 hover:text-zinc-300')}
          >
            <Filter className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => { setSearchOpen(v => !v); if (searchOpen) setQuery(''); setActiveTab('drawings'); }}
            aria-pressed={searchOpen}
            title="Search drawings"
            className={cn('transition-colors', searchOpen ? 'text-amber-accent' : 'text-zinc-600 hover:text-zinc-300')}
          >
            <Search className="w-3.5 h-3.5" />
          </button>
          {onCollapse && (
            <>
              <span className="w-px h-3.5 bg-industrial-border self-center" aria-hidden />
              <button
                type="button"
                onClick={onCollapse}
                title="Hide Project Explorer ([)"
                aria-label="Hide Project Explorer"
                className="text-zinc-600 hover:text-amber-accent transition-colors"
              >
                <PanelLeftClose className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>
      </div>

      {searchOpen && (
        <div className="px-3 py-2 border-b border-industrial-border bg-stone-900/40 flex items-center gap-2 shrink-0">
          <Search className="w-3 h-3 text-zinc-500 shrink-0" aria-hidden />
          <input
            autoFocus
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') { setQuery(''); setSearchOpen(false); } }}
            placeholder="Search drawings…"
            aria-label="Search drawings"
            className="flex-1 min-w-0 bg-transparent text-xs text-zinc-200 placeholder:text-zinc-600 outline-none"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className="text-zinc-500 hover:text-zinc-200">
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      )}

      {/* ── Tabs ── */}
      <div className="flex border-b border-industrial-border shrink-0">
        <button
          onClick={() => setActiveTab('drawings')}
          className={cn(
            "flex-1 py-3 text-[11px] font-bold tracking-widest uppercase transition-colors flex items-center justify-center gap-2",
            activeTab === 'drawings'
              ? "text-amber-accent border-b-2 border-amber-accent bg-zinc-800/20"
              : "text-zinc-600 hover:text-zinc-400"
          )}
        >
          <FolderOpen className="w-3.5 h-3.5" />
          Drawings
        </button>
        <button
          onClick={() => setActiveTab('specs')}
          className={cn(
            "flex-1 py-3 text-[11px] font-bold tracking-widest uppercase transition-colors flex items-center justify-center gap-2",
            activeTab === 'specs'
              ? "text-amber-accent border-b-2 border-amber-accent bg-zinc-800/20"
              : "text-zinc-600 hover:text-zinc-400"
          )}
        >
          <Settings2 className="w-3.5 h-3.5" />
          Scope / Specs
        </button>
      </div>

      {/* ── Body ── */}
      <div className="flex-1 overflow-y-auto custom-scrollbar p-0">

        {/* ════ DRAWINGS TAB ════ */}
        {activeTab === 'drawings' ? (
          <div className="space-y-px flex flex-col h-full">
            <div className="flex-1 overflow-y-auto">
              {projectState.drawings.length === 0 && (
                <div className="text-center py-10 px-4 flex flex-col items-center">
                  <FileText className="w-8 h-8 text-zinc-700 mb-3" />
                  <p className="text-[11px] text-zinc-500 font-bold uppercase tracking-widest">No Drawings</p>
                  <p className="text-[10px] text-zinc-600 mt-2 uppercase tracking-widest">
                    Select files in the main view or below
                  </p>
                </div>
              )}
              {projectState.drawings.length > 0 && visibleDrawings.length === 0 && (
                <p className="px-4 py-6 text-[11px] text-zinc-500 uppercase tracking-widest text-center">
                  {needsScale && !query ? 'Every page has a scale' : 'No drawings match'}
                </p>
              )}
              {visibleDrawings.map(file => {
                const active = file.id === projectState.activeDrawingId;
                const info = pageInfo.get(file.id);
                const missing = info ? info.calibrated.filter(c => !c).length : 0;
                return (
                  <div key={file.id} className={cn('group border-l-2', active ? 'bg-zinc-800/50 border-amber-accent' : 'border-transparent hover:bg-zinc-800/30')}>
                    <div className="flex items-center">
                      <button
                        type="button"
                        onClick={() => onSelectDrawing(file.id)}
                        aria-current={active ? 'true' : undefined}
                        className={cn(
                          'flex-1 min-w-0 flex items-center gap-3 pl-4 pr-2 py-3 text-left transition-colors',
                          active ? 'text-amber-accent' : 'text-zinc-400 hover:text-zinc-200',
                        )}
                      >
                        <FileText className="w-4 h-4 shrink-0" />
                        <span className="text-xs truncate font-medium uppercase tracking-tight">{file.name}</span>
                        {missing > 0 && (
                          <span className="ml-auto shrink-0 w-1.5 h-1.5 rounded-full bg-amber-400" title={`${missing} page${missing === 1 ? '' : 's'} without a scale`} />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => void confirmRemoveDrawing(file.id, file.name)}
                        title="Remove drawing"
                        aria-label={`Remove ${file.name}`}
                        className="mr-2 p-1.5 text-zinc-700 group-hover:text-zinc-500 hover:!text-red-400 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    {active && info && info.pages > 1 && (
                      <div className="flex flex-wrap gap-1 pl-11 pr-3 pb-3" role="group" aria-label="Pages">
                        {info.calibrated.map((ok, i) => {
                          const page = i + 1;
                          const current = page === activePage;
                          return (
                            <button
                              key={page}
                              type="button"
                              onClick={() => goToPage(file.id, page)}
                              aria-current={current ? 'page' : undefined}
                              title={`Page ${page}${ok ? ' · scale set' : ' · needs a scale'}`}
                              className={cn(
                                'relative min-w-[26px] h-6 px-1.5 text-[11px] font-bold border transition-colors',
                                current ? 'border-amber-accent text-amber-accent bg-amber-accent/10' : 'border-industrial-border text-zinc-400 hover:border-zinc-500 hover:text-zinc-200',
                              )}
                            >
                              {page}
                              <span className={cn('absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full', ok ? 'bg-emerald-500' : 'bg-amber-400')} aria-hidden />
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {projectState.drawings.length > 0 && (
              <div className="p-4 border-t border-industrial-border mt-auto shrink-0 bg-industrial-black/50">
                <label className="w-full bg-stone-800 hover:bg-stone-700 text-zinc-300 font-bold uppercase tracking-widest text-[11px] py-2.5 transition-colors flex items-center justify-center gap-2 cursor-pointer border border-zinc-700">
                  <Plus className="w-3.5 h-3.5" /> Upload Drawing
                  <input
                    type="file"
                    multiple
                    className="hidden"
                    accept=".pdf,application/pdf"
                    onChange={e => {
                      const files = e.target.files;
                      if (!files) return;
                      Array.from(files).forEach((file: File) => {
                        onDrawingAdded(file.name, URL.createObjectURL(file), file);
                      });
                    }}
                  />
                </label>
              </div>
            )}
          </div>

        ) : (

          /* ════ SPECS TAB ════ */
          <div className="p-4 flex flex-col gap-5">

            {/* ── 1. Project Identity ── */}
            <div>
              <SectionHeader
                icon={Info}
                label="Project Identity"
                expanded={open.identity}
                onToggle={() => toggle('identity')}
              />
              {open.identity && (
                <div className="space-y-3 mt-3">
                  <Field label="Project Name">
                    <TextInput
                      value={projectState.projectName}
                      onChange={v => onUpdateProjectMeta({ projectName: v })}
                    />
                  </Field>
                  <Field label="Project Number">
                    <TextInput
                      value={projectState.projectNumber ?? ''}
                      onChange={v => onUpdateProjectMeta({ projectNumber: v || undefined })}
                    />
                  </Field>
                  <Field label="Location">
                    <TextInput
                      value={projectState.projectLocation ?? ''}
                      placeholder="e.g. Expo City Dubai"
                      onChange={v => onUpdateProjectMeta({ projectLocation: v || undefined })}
                    />
                  </Field>
                  <Field label="Phase">
                    <TextInput
                      value={projectState.projectPhase ?? ''}
                      placeholder="e.g. Phase-01 – Mobility District"
                      onChange={v => onUpdateProjectMeta({ projectPhase: v || undefined })}
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Kitchen Type">
                      <TextInput
                        value={projectState.kitchenType ?? ''}
                        placeholder="e.g. C01"
                        onChange={v => onUpdateProjectMeta({ kitchenType: v || undefined })}
                      />
                    </Field>
                    <Field label="Total Units">
                      <NumberInput
                        value={projectState.totalUnits}
                        placeholder="e.g. 58"
                        onChange={v => onUpdateProjectMeta({ totalUnits: v })}
                      />
                    </Field>
                  </div>
                </div>
              )}
            </div>

            <Divider />

            {/* ── 2. Document Metadata ── */}
            <div>
              <SectionHeader
                icon={FileCheck2}
                label="Document Metadata"
                expanded={open.document}
                onToggle={() => toggle('document')}
              />
              {open.document && (
                <div className="space-y-3 mt-3">
                  <Field label="Document Title">
                    <TextInput
                      value={projectState.documentTitle ?? ''}
                      placeholder="e.g. Bill of Quantities – Kitchen Fitout"
                      onChange={v => onUpdateProjectMeta({ documentTitle: v || undefined })}
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Date">
                      <input
                        type="date"
                        value={projectState.documentDate ?? ''}
                        onChange={e => onUpdateProjectMeta({ documentDate: e.target.value || undefined })}
                        className="w-full bg-[#16191C] border border-zinc-800 p-2 text-xs font-bold text-zinc-200 outline-none focus:border-amber-accent transition-colors"
                      />
                    </Field>
                    <Field label="Revision">
                      <TextInput
                        value={projectState.revision ?? ''}
                        placeholder="e.g. Rev 1"
                        onChange={v => onUpdateProjectMeta({ revision: v || undefined })}
                      />
                    </Field>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Currency">
                      <TextInput
                        value={projectState.currency ?? ''}
                        placeholder="e.g. AED"
                        onChange={v => onUpdateProjectMeta({ currency: v || undefined })}
                      />
                    </Field>
                    <Field label="VAT %">
                      <NumberInput
                        value={projectState.vatPercent}
                        placeholder="e.g. 5"
                        onChange={v => onUpdateProjectMeta({ vatPercent: v })}
                      />
                    </Field>
                  </div>
                </div>
              )}
            </div>

            <Divider />

            {/* ── 3. Stakeholders ── */}
            <div>
              <SectionHeader
                icon={Users2}
                label="Stakeholders"
                expanded={open.stakeholders}
                onToggle={() => toggle('stakeholders')}
              />
              {open.stakeholders && (
                <div className="space-y-3 mt-3">
                  {(
                    [
                      { key: 'mainContractor',   label: 'Main Contractor'    },
                      { key: 'designConsultant', label: 'Design Consultant'  },
                      { key: 'supervision',      label: 'Supervision'        },
                      { key: 'client',           label: 'Client / Employer'  },
                      { key: 'projectManager',   label: 'Project Manager'    },
                    ] as { key: keyof Stakeholders; label: string }[]
                  ).map(({ key, label }) => (
                    <Field key={key} label={label}>
                      <TextInput
                        value={projectState.stakeholders?.[key] ?? ''}
                        onChange={v => updateStakeholder(key, v)}
                      />
                    </Field>
                  ))}
                </div>
              )}
            </div>

            <Divider />

            {/* ── 4. Drawing References ── */}
            <div>
              <SectionHeader
                icon={BookOpen}
                label="Drawing References"
                expanded={open.drawingRefs}
                onToggle={() => toggle('drawingRefs')}
              />
              {open.drawingRefs && (
                <div className="space-y-2 mt-3">
                  {(projectState.drawingReferences ?? []).map((ref, i) => (
                    <div key={i} className="flex gap-2 items-center">
                      <input
                        type="text"
                        value={ref}
                        onChange={e => updateDrawingRef(i, e.target.value)}
                        className="flex-1 bg-[#16191C] border border-zinc-800 p-2 text-xs font-bold text-zinc-200 outline-none focus:border-amber-accent transition-colors uppercase"
                      />
                      <button
                        onClick={() => removeDrawingRef(i)}
                        className="text-zinc-600 hover:text-red-400 transition-colors shrink-0"
                      >
                        <Ban className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={addDrawingRef}
                    className="w-full flex items-center justify-center gap-2 border border-dashed border-zinc-700 py-2 text-[11px] font-bold text-zinc-500 hover:text-zinc-300 hover:border-zinc-500 transition-colors uppercase tracking-widest"
                  >
                    <Plus className="w-3 h-3" /> Add Reference
                  </button>
                </div>
              )}
            </div>

            <Divider />

            {/* ── 5. General Assumptions ── */}
            <div>
              <SectionHeader
                icon={AlertTriangle}
                label="Assumptions"
                expanded={open.assumptions}
                onToggle={() => toggle('assumptions')}
              />
              {open.assumptions && (
                <div className="space-y-2 mt-3">
                  {(projectState.generalAssumptions ?? []).length === 0 && (
                    <p className="text-[11px] text-zinc-600 uppercase tracking-widest">
                      No assumptions recorded
                    </p>
                  )}
                  {(projectState.generalAssumptions ?? []).map(a => (
                    <div
                      key={a.id}
                      className="bg-zinc-900/60 border border-zinc-800 p-2.5 space-y-1"
                    >
                      <span className="text-[10px] font-bold text-amber-accent/70 uppercase tracking-widest">
                        {a.category}
                      </span>
                      <p className="text-[11px] text-zinc-400 leading-relaxed">
                        {a.content}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <Divider />

            {/* ── 6. Excluded Items ── */}
            <div>
              <SectionHeader
                icon={Building2}
                label="Excluded from Scope"
                expanded={open.excluded}
                onToggle={() => toggle('excluded')}
              />
              {open.excluded && (
                <div className="space-y-2 mt-3">
                  {(projectState.excludedItems ?? []).length === 0 && (
                    <p className="text-[11px] text-zinc-600 uppercase tracking-widest">
                      No exclusions recorded
                    </p>
                  )}
                  {(projectState.excludedItems ?? []).map(e => (
                    <div
                      key={e.id}
                      className="bg-zinc-900/60 border border-zinc-800 p-2.5 space-y-1"
                    >
                      <span className="text-[11px] font-bold text-zinc-300 uppercase tracking-tight">
                        {e.item}
                      </span>
                      <p className="text-[11px] text-zinc-500 leading-relaxed">
                        {e.reason}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <Divider />

            {/* ── 7. Master Library ── */}
            <div>
              <SectionHeader
                icon={Layers}
                label="Master Specifications"
                expanded={open.library}
                onToggle={() => toggle('library')}
              />
              {open.library && (
                <>
                  <p className="text-[11px] text-zinc-400 uppercase tracking-widest leading-relaxed mb-4 mt-3">
                    Manage unit costs, labour rates, and equipment expenses globally.
                  </p>
                  <button
                    onClick={() => onOpenMaterialLibrary?.()}
                    className="w-full bg-amber-accent hover:bg-amber-400 text-black font-bold uppercase tracking-widest text-[11px] py-3.5 transition-colors flex items-center justify-center gap-2 shadow-[0_0_15px_rgba(242,194,48,0.15)] hover:shadow-[0_0_20px_rgba(242,194,48,0.25)] active:scale-95"
                  >
                    <Database className="w-3.5 h-3.5" /> Open Master Library
                  </button>
                </>
              )}
            </div>

          </div>
        )}
      </div>

      {/* ── Footer ── */}
      <div className="p-4 bg-industrial-black border-t border-industrial-border shrink-0">
        <div className="flex items-center gap-2 mb-3">
          <div className={cn('w-2 h-2 rounded-full', totals.pages === 0 ? 'bg-zinc-600' : totals.done === totals.pages ? 'bg-emerald-500' : 'bg-amber-400')} />
          <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">
            {totals.pages === 0 ? 'No drawings yet'
              : totals.done === totals.pages ? 'All pages have a scale'
              : `${totals.pages - totals.done} page${totals.pages - totals.done === 1 ? '' : 's'} need${totals.pages - totals.done === 1 ? 's' : ''} a scale`}
          </span>
        </div>
        <div className="text-[11px] font-bold text-zinc-600 uppercase tracking-tighter flex justify-between">
          <span>{fullProject.drawings.length} drawing{fullProject.drawings.length === 1 ? '' : 's'} · {totals.done}/{totals.pages} pages</span>
          <span>{totals.measured} qty</span>
        </div>
      </div>
    </aside>
  );
}

/** Memoized: skips re-rendering when its props are unchanged. */
export const Sidebar = React.memo(SidebarImpl);

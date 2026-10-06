'use client';
// ─── workspace/page.tsx ───────────────────────────────────────────────────────
//  Main takeoff workspace. Project data comes from TakeoffContext, which is
//  loaded from / autosaved to local storage by app/(project)/ProjectSession.
//  Keyboard shortcuts are owned by Viewer.tsx (single registry).
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/layout/Sidebar';
import { Navbar } from '@/components/layout/Navbar';
import dynamic from 'next/dynamic';
import type { ViewerToolbarAPI } from '@/components/Viewer/Viewer';
import { Material, TakeoffRow, ToolType } from '@/types';
import { HistoryControls, ScaleControls } from '@/components/Viewer/ViewerToolbar';
import { ToolRail } from '@/components/Viewer/ToolGroups';

const Viewer = dynamic(
  () => import('@/components/Viewer/Viewer').then(m => m.Viewer),
  { ssr: false }
);

import { TakeoffTable } from '@/components/features/takeoff/TakeoffTable';
import { MaterialLibrary } from '@/components/features/takeoff/MaterialLibrary';
import { ExportModal } from '@/components/features/dialogs/ExportModal';
import { ToastContainer } from '@/components/Toast';
import type { PresetTemplate } from '@/components/presets/PresetTemplates';
import { useTakeoffData } from '@/context/TakeoffContext';
import {
  PanelRightOpen,
  FolderOpen,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { AnimatePresence } from 'motion/react';
import { exportProjectToExcel } from '@/lib/export/clientExport';
import { takeoffToCsv, downloadCsv } from '@/lib/export/csvExport';
import { actionForKey } from '@/lib/shortcuts';
import { getPageScale, effectivePageScale } from '@/lib/takeoff/scale';
import { useProjectHref } from '@/lib/nav/projectHref';
// Loaded on first open — they cost nothing until used.
const AnalysisDialog  = dynamic(() => import('@/components/features/dialogs/WorkspaceDialogs').then(m => m.AnalysisDialog),  { ssr: false });
const ShortcutsDialog = dynamic(() => import('@/components/features/dialogs/WorkspaceDialogs').then(m => m.ShortcutsDialog), { ssr: false });

// ─── Stable color palette for presets ────────────────────────────────────────
const PRESET_COLORS = [
  '#EF9F27', '#85B7EB', '#7EC8A4', '#E07B7B', '#B07BE0',
  '#E0C47B', '#7BE0D4', '#E07BB0', '#9BE07B', '#7B9BE0',
];
let colorIndex = 0;
const getPresetColor = () => PRESET_COLORS[colorIndex++ % PRESET_COLORS.length];

// ─── Safe row builder ─────────────────────────────────────────────────────────
function buildRow(overrides: Partial<TakeoffRow> & { id: string; drawingId: string }): TakeoffRow {
  return {
    label:         '',
    description:   'Untitled',
    type:          'Length',
    quantity:      0,
    unit:          'm',
    unitRate:      0,
    notes:         '',
    points:        [],
    isOverridden:  false,
    childIds:      [],
    color:         '#EF9F27',
    isVisible:     true,
    isGroupHeader: false,
    ...overrides,
  };
}

const TABLE_WIDTH_KEY     = 'foldrule:takeoff-panel-width';
const TABLE_WIDTH_DEFAULT = 384;
const TABLE_WIDTH_MIN     = 320;
const clampTableWidth = (w: number) => {
  const max = typeof window === 'undefined' ? 760 : Math.max(TABLE_WIDTH_MIN, Math.min(760, window.innerWidth - 560));
  return Math.round(Math.min(max, Math.max(TABLE_WIDTH_MIN, w)));
};

export default function Workspace() {
  const router = useRouter();

  const {
    projectState: ps,
    setProjectState,
    activeTool,
    setActiveTool,
    selectedId,
    setSelectedId,
    addDrawing,
    setActiveDrawingId,
    updateDrawingScale,
    addMeasurement,
    updateMeasurement,
    deleteMeasurement,
    clearAll,
    toggleVisibility,
    updateProjectMeta,
    activePage,
    showLabels,
    setShowLabels,
    showGeometry,
    setShowGeometry,
    materialLibraryOpen: showMaterialLibrary,
    setMaterialLibraryOpen: setShowMaterialLibrary,
    focusMeasurement,
    goToPage,
  } = useTakeoffData();
  const href = useProjectHref();

  // Project Explorer drawer: closed by default so the drawing gets the room.
  const [leftCollapsed,       setLeftCollapsed]       = useState(true);
  const [rightCollapsed,      setRightCollapsed]      = useState(false);
  const [showExportModal,     setShowExportModal]     = useState(false);
  const [showPresetDrawer,    setShowPresetDrawer]    = useState(false);
  const [toasts,              setToasts]              = useState<any[]>([]);
  const [isMounted,           setIsMounted]           = useState(false);
  const [toolbarAPI,          setToolbarAPI]          = useState<ViewerToolbarAPI | null>(null);
  const [appendToGroupId,     setAppendToGroupId]     = useState<string | null>(null);

  // ── Toolbar state ─────────────────────────────────────────────────────────
  // Snap on/off and the snap-settings panel live in the Viewer (it does the
  // snapping; S toggles it) — the toolbar reads/writes them through the
  // Viewer's toolbar API so the button always matches reality.
  // Pins are owned here and passed down to the Viewer.
  const [showPins,         setShowPins]         = useState(false);

  // ── Takeoff panel width (drag the divider; remembered on this computer) ────
  const [tableWidth, setTableWidth] = useState(TABLE_WIDTH_DEFAULT);
  const [resizing,   setResizing]   = useState(false);
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(TABLE_WIDTH_KEY));
      if (saved) setTableWidth(clampTableWidth(saved));
    } catch { /* storage blocked */ }
  }, []);
  const startResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = tableWidth;
    let latest = startW;
    setResizing(true);
    const onMove = (ev: PointerEvent) => {
      latest = clampTableWidth(startW + (startX - ev.clientX));
      setTableWidth(latest);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setResizing(false);
      try { localStorage.setItem(TABLE_WIDTH_KEY, String(latest)); } catch { /* ignore */ }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [tableWidth]);
  const nudgeTableWidth = useCallback((delta: number) => {
    setTableWidth(w => {
      const next = clampTableWidth(w + delta);
      try { localStorage.setItem(TABLE_WIDTH_KEY, String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  useEffect(() => { setIsMounted(true); }, []);

  // ── Fix existing groups with mismatched types ─────────────────────────────
  useEffect(() => {
    ps.measurements
      .filter(m => m.isGroupHeader && m.childIds && m.childIds.length > 0)
      .forEach(group => {
        const firstChild = ps.measurements.find(c => c.id === group.childIds?.[0]);
        if (firstChild && group.type !== firstChild.type) {
          updateMeasurement(group.id, { type: firstChild.type });
        }
      });
  }, [ps.measurements, updateMeasurement]);

  // ── Derived values ────────────────────────────────────────────────────────
  const activeDrawing = useMemo(
    () => ps.drawings.find((d: { id: any }) => d.id === ps.activeDrawingId) || null,
    [ps.drawings, ps.activeDrawingId],
  );

  // Scale is per page. Uncalibrated pages measure in drawing units (factor 1).
  const currentScaleFactor = useMemo(
    () => effectivePageScale(activeDrawing, activePage),
    [activeDrawing, activePage],
  );
  const isPageCalibrated = useMemo(
    () => getPageScale(activeDrawing, activePage) !== null,
    [activeDrawing, activePage],
  );

  const activeMeasurements = useMemo(
    () => ps.measurements.filter((m: { drawingId: any }) => m.drawingId === ps.activeDrawingId),
    [ps.measurements, ps.activeDrawingId],
  );

  const toolbarAPIRef = useRef<ViewerToolbarAPI | null>(null);
  useEffect(() => { toolbarAPIRef.current = toolbarAPI; }, [toolbarAPI]);

  // ── Toast helper ──────────────────────────────────────────────────────────
  const addToast = useCallback((message: string, type: 'success' | 'info' = 'info') => {
    const id = Math.random().toString(36).substr(2, 9);
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000);
  }, []);

  // ── Carcass preset generator ──────────────────────────────────────────────
  const generateGroupedCarcassMeasurements = useCallback((
    data: Record<string, any>,
    template: PresetTemplate,
    drawingId: string,
    groupId: string,
  ): { measurements: Partial<TakeoffRow>[]; groupName: string } => {
    const measurements: Partial<TakeoffRow>[] = [];

    const W     = parseFloat(data.width          ?? 600) / 1000;
    const H     = parseFloat(data.height         ?? 720) / 1000;
    const D     = parseFloat(data.depth          ?? 550) / 1000;
    const T     = parseFloat(data.panelThickness ?? 18)  / 1000;
    const shelves   = parseInt(data.shelfCount ?? 2);
    const doorCount = parseInt(data.doorCount  ?? 1);

    const iW = W - 2 * T;
    const iH = H - 2 * T;

    const groupName = `${data.customName || 'Cabinet'} (${data.width || 600}×${data.height || 720}×${data.depth || 550}mm)`;

    if (data.hasBack !== false)      measurements.push({ description: 'Back Panel',       type: 'Area',   quantity: +(iW * iH).toFixed(3),         unit: 'm²',   notes: `Material: ${data.boardMaterial || '18mm MDF'}`,                                                                         category: 'Board Materials', isOverridden: true });
    if (data.hasTop  !== false)      measurements.push({ description: 'Top Panel',        type: 'Area',   quantity: +(iW * D).toFixed(3),          unit: 'm²',   notes: `Material: ${data.boardMaterial || '18mm MDF'}`,                                                                         category: 'Board Materials', isOverridden: true });
    if (data.hasBottom !== false)    measurements.push({ description: 'Bottom Panel',     type: 'Area',   quantity: +(iW * D).toFixed(3),          unit: 'm²',   notes: `Material: ${data.boardMaterial || '18mm MDF'}`,                                                                         category: 'Board Materials', isOverridden: true });
    if (data.hasLeftSide  !== false) measurements.push({ description: 'Left Side Panel',  type: 'Area',   quantity: +(D * H).toFixed(3),           unit: 'm²',   notes: `Material: ${data.boardMaterial || '18mm MDF'}`,                                                                         category: 'Board Materials', isOverridden: true });
    if (data.hasRightSide !== false) measurements.push({ description: 'Right Side Panel', type: 'Area',   quantity: +(D * H).toFixed(3),           unit: 'm²',   notes: `Material: ${data.boardMaterial || '18mm MDF'}`,                                                                         category: 'Board Materials', isOverridden: true });

    if (shelves > 0) measurements.push({ description: `Shelves (${shelves} pcs)`, type: 'Area', quantity: +(iW * D * shelves).toFixed(3), unit: 'm²', notes: `Material: ${data.shelfMaterial || data.boardMaterial || '18mm MDF'} | Spacing: ${data.shelfSpacing || 'Equal'}`, category: 'Shelves', isOverridden: true });

    if (data.hasDoors) {
      const doorArea = (W / doorCount) * H * doorCount;
      measurements.push({ description: `Doors (${doorCount} pcs)`,  type: 'Area',  quantity: +doorArea.toFixed(3), unit: 'm²',   notes: `Material: ${data.doorMaterial || 'MDF Primed'} | Style: ${data.doorSwing || 'Standard'}`, category: 'Doors',     isOverridden: true });
      measurements.push({ description: 'Door Hardware',              type: 'Count', quantity: doorCount,            unit: 'sets', notes: `Hinges (2 per door), handles (1 per door) | Type: ${data.hingeType || 'Concealed'}`,       category: 'Hardware',  isOverridden: true });
    }
    if (data.hasDrawers) {
      const drawerCount = parseInt(data.drawerCount ?? 2);
      measurements.push({ description: `Drawer Fronts (${drawerCount} pcs)`, type: 'Count', quantity: drawerCount, unit: 'pcs',  notes: `Material: ${data.drawerMaterial || 'Match doors'}`, category: 'Drawers',  isOverridden: true });
      measurements.push({ description: 'Drawer Hardware',                      type: 'Count', quantity: drawerCount, unit: 'sets', notes: `Drawer slides (1 pair per drawer), handles`,          category: 'Hardware', isOverridden: true });
    }

    let edgeBanding = 0;
    if (data.hasTop      !== false) edgeBanding += 2 * (iW + D);
    if (data.hasBottom   !== false) edgeBanding += 2 * (iW + D);
    if (data.hasLeftSide !== false) edgeBanding += 2 * (D + H);
    if (data.hasRightSide!== false) edgeBanding += 2 * (D + H);
    if (shelves > 0)                edgeBanding += (2 * iW + D) * shelves;

    if (edgeBanding > 0) measurements.push({ description: 'Edge Banding', type: 'Length', quantity: +(edgeBanding * 1.1).toFixed(2), unit: 'm', notes: `Material: ${data.edgeTape || 'PVC 0.4mm'} | All exposed edges +10% waste`, category: 'Finishing', isOverridden: true });

    measurements.push({ description: 'Assembly & Installation', type: 'Count', quantity: 1, unit: 'each', notes: `Labor, cam locks, fixing brackets, assembly hardware`, category: 'Labor', isOverridden: true });

    if (data.hasToeKick) measurements.push({ description: 'Toe Kick / Plinth', type: 'Length', quantity: W, unit: 'm', notes: `Material: ${data.kickboardMaterial || 'Same as carcass'} | Height: ${data.kickboardHeight || '100mm'}`, category: 'Finishing', isOverridden: true });

    return { measurements, groupName };
  }, []);

  // ── Preset select handler ─────────────────────────────────────────────────
  const handlePresetSelect = useCallback((data: Record<string, any>, template: PresetTemplate) => {
    if (!activeDrawing) {
      addToast('PLEASE SELECT OR IMPORT A DRAWING FIRST', 'info');
      return;
    }

    const groupId    = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const groupColor = getPresetColor();

    if (template.id === 'carcass') {
      const { measurements, groupName } = generateGroupedCarcassMeasurements(data, template, activeDrawing.id, groupId);
      const headerId = `${groupId}-header`;
      const childRows: TakeoffRow[] = measurements.map((m, i) =>
        buildRow({
          id:          `${groupId}-child-${i}-${Date.now()}`,
          drawingId:   activeDrawing.id,
          groupId,
          parentId:    headerId,
          label:       m.description || '',
          description: m.description || '',
          type:        m.type        || 'Length',
          quantity:    m.quantity    ?? 0,
          unit:        m.unit        || 'm',
          unitRate:    0,
          notes:       m.notes       || '',
          isOverridden: true,
          category:    m.category,
          presetData:  data,
          presetId:    template.id,
          color:       groupColor,
          isVisible:   true,
        }),
      );
      const headerRow = buildRow({
        id:            headerId,
        drawingId:     activeDrawing.id,
        groupId,
        groupName,
        groupType:     template.id,
        isGroupHeader: true,
        isExpanded:    true,
        childIds:      childRows.map(c => c.id),
        label:         groupName,
        description:   groupName,
        type:          'Count',
        quantity:      1,
        unit:          'assembly',
        unitRate:      0,
        notes:         `Complete ${template.name.toLowerCase()} assembly`,
        isOverridden:  true,
        presetId:      template.id,
        presetData:    data,
        category:      'Group Header',
        color:         groupColor,
        isVisible:     true,
      });
      addMeasurement(headerRow);
      childRows.forEach(row => addMeasurement(row));
      addToast(`${groupName} ADDED (${childRows.length} components)`, 'success');
    } else {
      let quantity = 0;
      let unit     = 'm';
      switch (template.measurementType) {
        case 'linear':
          quantity = parseFloat(data.length ?? data.pipeLength ?? data.roofPitch ?? 0) || 0;
          unit = 'm';
          break;
        case 'area':
          quantity = parseFloat(data.area ?? data.roofArea ?? 0)
            || (parseFloat(data.width ?? 0) * parseFloat(data.height ?? 0)) / 1e6
            || 0;
          unit = 'm²';
          break;
        case 'count':
          quantity = parseInt(data.quantity ?? data.doorCount ?? data.windowCount ?? 1);
          unit = 'pcs';
          break;
      }
      addMeasurement(buildRow({
        id:           `${activeDrawing.id}-preset-${Date.now()}`,
        drawingId:    activeDrawing.id,
        label:        template.name,
        description:  template.name,
        type:         template.measurementType === 'linear' ? 'Length'
                    : template.measurementType === 'area'   ? 'Area'
                    : 'Count',
        quantity,
        unit,
        unitRate:     0,
        notes:        `Preset: ${template.name} · ${template.category}`,
        isOverridden: true,
        presetData:   data,
        presetId:     template.id,
        color:        groupColor,
        isVisible:    true,
      }));
      addToast(`${template.name.toUpperCase()} ADDED`, 'success');
    }
  }, [activeDrawing, addMeasurement, addToast, generateGroupedCarcassMeasurements]);

  // ── Group append handlers ─────────────────────────────────────────────────
  const handleAddSegmentToGroup = useCallback((groupId: string, groupType: string) => {
    setAppendToGroupId(groupId);
    const toolMap: Record<string, ToolType> = {
      'Length':     'linear',
      'Polygon':    'polygon',
      'Rectangle':  'rectangle',
      'Count':      'count',
      'Point':      'point',
      'Area':       'magic-fill',
      'magic-fill': 'magic-fill',
    };
    // Area, length and count groups: the viewer makes the group the active
    // item and switches to the normal drawing tool for it (see Viewer).
    if (['Length', 'Polygon', 'Rectangle', 'Area', 'Count', 'magic-fill'].includes(groupType)) return;
    const newTool = toolMap[groupType] || 'linear';
    setActiveTool(newTool);
    addToast(`ADDING TO GROUP: Use ${newTool} tool to draw new item`, 'info');
  }, [setActiveTool, addToast]);

  const handleAppendComplete = useCallback(() => setAppendToGroupId(null), []);

  // ── onAddMeasurement ──────────────────────────────────────────────────────
  const handleAddMeasurement = useCallback((m: any) => {
    if (!activeDrawing) {
      addToast('PLEASE SELECT OR IMPORT A DRAWING FIRST', 'info');
      return;
    }
    addMeasurement(buildRow({
      ...m,
      id:            m.id            || crypto.randomUUID(),
      drawingId:     activeDrawing.id,
      label:         m.label         ?? '',
      description:   m.description   || 'Untitled Measurement',
      type:          m.type          || 'Length',
      quantity:      m.quantity      ?? 0,
      unit:          m.unit          || 'm',
      unitRate:      m.unitRate      ?? 0,
      notes:         m.notes         || '',
      points:        m.points        || [],
      isOverridden:  m.isOverridden  ?? false,
      childIds:      m.childIds      || [],
      color:         m.color         || '#EF9F27',
      isVisible:     m.isVisible     ?? true,
      isGroupHeader: m.isGroupHeader || false,
      parentId:      m.parentId,
      groupId:       m.groupId,
      groupName:     m.groupName,
      groupType:     m.groupType,
      presetData:    m.presetData,
      presetId:      m.presetId,
      category:      m.category,
      icon:          m.icon,
    }));
  }, [activeDrawing, addMeasurement, addToast]);

  const handleExport = useCallback(() => setShowExportModal(true), []);

  const executeExport = useCallback((filename: string) => {
    exportProjectToExcel(ps, filename || undefined)
      .then(name => {
        addToast(`Exported ${name}`, 'success');
        setShowExportModal(false);
      })
      .catch(err => {
        console.error('Export failed:', err);
        addToast(`Export failed: ${err instanceof Error ? err.message : String(err)}`, 'info');
      });
  }, [ps, addToast]);

  const handleScaleSet = useCallback((f: number) => {
    if (activeDrawing) {
      updateDrawingScale(activeDrawing.id, f, activePage);
      addToast(`Page ${activePage} calibrated — existing measurements on this page were updated`, 'success');
    }
  }, [activeDrawing, activePage, updateDrawingScale, addToast]);

  // ── Stable props for memoized children ────────────────────────────────────
  const sidebarProjectState = useMemo(
    () => ({ ...ps, activeDrawingId: ps.activeDrawingId ?? undefined }),
    [ps],
  );
  const handleUpdateMaterials = useCallback(
    (mats: Material[]) => setProjectState(prev => ({ ...prev, materials: mats })),
    [setProjectState],
  );
  const openMaterialLibrary = useCallback(() => setShowMaterialLibrary(true), [setShowMaterialLibrary]);
  const collapseSidebar     = useCallback(() => setLeftCollapsed(true), []);
  const selectDrawingFromDrawer = useCallback((id: string) => {
    setActiveDrawingId(id);
    setLeftCollapsed(true);
  }, [setActiveDrawingId]);
  const collapseTable       = useCallback(() => setRightCollapsed(true), []);
  const [showAnalysis,  setShowAnalysis]  = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const openAnalysis        = useCallback(() => setShowAnalysis(true), []);
  const expandTable         = useCallback(() => setRightCollapsed(false), []);

  // [ and ] toggle the side panels (ignored while typing or with modifiers).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const act = actionForKey(e.key);
      if (act === 'help') { e.preventDefault(); setShowShortcuts(v => !v); }
      else if (e.key === 'Escape') { setLeftCollapsed(true); }
      else if (act === 'drawer') { e.preventDefault(); setLeftCollapsed(v => !v); }
      else if (act === 'takeoff') { e.preventDefault(); setRightCollapsed(v => !v); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const openFullTable       = useCallback(() => router.push(href('/takeoff-full')), [router, href]);
  const handleAddManual     = useCallback(() => handleAddMeasurement({
                  id:          crypto.randomUUID(),
                  drawingId:   activeDrawing?.id || '',
                  description: 'Manual Item',
                  type:        'Length',
                  quantity:    0,
                  unit:        'm',
                  unitRate:    0,
                  notes:       '',
                  points:      [],
                  childIds:    [],
                  isOverridden: true,
                  label:       '',
                  color:       '#EF9F27',
                  isVisible:   true,
                } as TakeoffRow), [handleAddMeasurement, activeDrawing]);
  const handleProjectNameChange = useCallback(
    (name: string) => updateProjectMeta({ projectName: name }),
    [updateProjectMeta],
  );
  const openPresetDrawer  = useCallback(() => setShowPresetDrawer(true), []);
  const closePresetDrawer = useCallback(() => setShowPresetDrawer(false), []);

  const handleToolbarReady = useCallback((api: ViewerToolbarAPI) => {
    setToolbarAPI(api);
  }, []);

  const api = toolbarAPI;

  if (!isMounted) {
    return (
      <div className="flex flex-col h-screen bg-industrial-black">
        <Navbar
          projectName={ps.projectName}
          onProjectNameChange={handleProjectNameChange}
          onExport={handleExport}
          onOpenPresets={openPresetDrawer}
        />
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <div className="w-12 h-12 border-4 border-zinc-800 border-t-amber-400 rounded-full animate-spin" />
            <span className="text-[11px] font-mono font-bold text-amber-400 tracking-[0.2em] uppercase animate-pulse">
              LOADING WORKSPACE...
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-industrial-black">

      <Navbar
        projectName={ps.projectName}
        onProjectNameChange={handleProjectNameChange}
        onExport={handleExport}
        onOpenPresets={openPresetDrawer}
        center={
          <>
            <HistoryControls
              canUndo={api?.canUndo ?? false}
              canRedo={api?.canRedo ?? false}
              handleUndo={() => api?.handleUndo?.()}
              handleRedo={() => api?.handleRedo?.()}
              tempPointsCount={api?.tempPointsCount ?? 0}
            />
            <div className="w-px h-6 bg-industrial-border" aria-hidden />
            <ScaleControls
              scaleFactor={currentScaleFactor}
              calibrating={activeTool === 'scale'}
              onCalibrate={() => (api?.setActiveTool ? api.setActiveTool('scale') : setActiveTool('scale'))}
              pageSizePt={api?.pageSizePt}
              onApplyScale={handleScaleSet}
            />
          </>
        }
      />

      <div className="flex flex-1 overflow-hidden mt-14">


        <div className="flex flex-col flex-1 overflow-hidden min-w-0">

          <div className="flex flex-1 overflow-hidden relative min-h-0">

            {/* ── Tool rail (left edge of the drawing) ──
                Tool changes go through the Viewer's handler (api.setActiveTool)
                so the linear↔arc → polyarc upgrade logic runs. Drawing aids and
                zoom are in the bar under the drawing. */}
            <ToolRail
              activeTool={activeTool as ToolType}
              drawMode={api?.drawMode}
              setToolMode={(tool, mode) => (api?.setToolMode ? api.setToolMode(tool, mode) : setActiveTool(tool))}
              setActiveTool={(tool: ToolType) => (api?.setActiveTool ? api.setActiveTool(tool) : setActiveTool(tool))}
              polyarcMode={api?.polyarcMode}
              togglePolyarcMode={api?.togglePolyarcMode}
              leading={
                <>
                  <button
                    type="button"
                    onClick={() => setLeftCollapsed(v => !v)}
                    aria-expanded={!leftCollapsed}
                    aria-label="Drawings and project details"
                    className={cn(
                      'w-12 h-10 flex items-center justify-center border transition-colors relative group',
                      leftCollapsed
                        ? 'border-transparent text-zinc-400 hover:text-amber-accent hover:border-zinc-700'
                        : 'bg-zinc-800 border-amber-400 text-amber-400',
                    )}
                  >
                    <FolderOpen className="w-4 h-4" />
                    {ps.drawings.length > 1 && (
                      <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-0.5 bg-amber-accent text-black text-[9px] font-mono font-bold leading-[14px] text-center">
                        {ps.drawings.length}
                      </span>
                    )}
                    <span className="absolute left-[3.25rem] top-1/2 -translate-y-1/2 px-2 py-1 bg-zinc-900 border border-industrial-border text-[10px] text-zinc-400 invisible group-hover:visible whitespace-nowrap pointer-events-none uppercase tracking-widest font-mono z-[70] shadow-lg text-left">
                      Drawings &amp; project details [ [ ]
                    </span>
                  </button>
                  <div className="h-px w-8 bg-zinc-700/60 my-0.5" aria-hidden />
                </>
              }
            />

            <div className="flex-1 min-w-0 flex flex-col">
              <div className="flex-1 min-h-0 relative">
              {/* Project Explorer: a drawer over the drawing (opened from the top of
                  the tool rail or with [), so it takes no room while measuring. */}
              {!leftCollapsed && (
                <div className="absolute inset-0 z-[54] bg-black/30" onPointerDown={collapseSidebar} aria-hidden />
              )}
              <div className={cn(
                'absolute left-0 top-0 bottom-0 z-[55] shadow-[8px_0_30px_-8px_rgba(0,0,0,0.7)]',
                leftCollapsed && 'pointer-events-none',
              )}>
                <Sidebar
                  isCollapsed={leftCollapsed}
                  onCollapse={collapseSidebar}
                  projectState={sidebarProjectState}
                  onUpdateMaterials={handleUpdateMaterials}
                  onOpenMaterialLibrary={openMaterialLibrary}
                  onDrawingAdded={addDrawing}
                  onSelectDrawing={selectDrawingFromDrawer}
                  onUpdateProjectMeta={updateProjectMeta}
                />
              </div>
              <Viewer
                activeTool={activeTool as ToolType}
                setActiveTool={setActiveTool as (tool: ToolType) => void}
                measurements={activeMeasurements}
                onAddMeasurement={handleAddMeasurement}
                onUpdateMeasurement={updateMeasurement}
                onDeleteMeasurement={deleteMeasurement}
                scaleFactor={currentScaleFactor}
                onScaleSet={handleScaleSet}
                activeDrawing={activeDrawing}
                onDrawingAdded={addDrawing}
                showPresetDrawer={showPresetDrawer}
                onClosePresetDrawer={closePresetDrawer}
                onSelectPreset={handlePresetSelect}
                hideToolbar={true}
                onToolbarReady={handleToolbarReady}
                appendToGroupId={appendToGroupId}
                onAppendComplete={handleAppendComplete}
                isPageCalibrated={isPageCalibrated}
                showPins={showPins}
                onShowPinsChange={setShowPins}
              />
              {rightCollapsed && (
                <button
                  type="button"
                  onClick={expandTable}
                  title="Show takeoff panel (])"
                  aria-label="Show takeoff panel"
                  className="absolute top-2 right-2 z-40 w-9 h-9 flex items-center justify-center bg-industrial-panel border border-industrial-border text-zinc-400 hover:text-amber-accent hover:border-amber-accent/60 shadow-lg transition-colors"
                >
                  <PanelRightOpen className="w-4 h-4" />
                </button>
              )}
              </div>
            </div>

            {!rightCollapsed && (
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize takeoff panel"
                aria-valuenow={tableWidth}
                aria-valuemin={TABLE_WIDTH_MIN}
                tabIndex={0}
                title="Drag to resize · double-click to reset"
                onPointerDown={startResize}
                onDoubleClick={() => nudgeTableWidth(TABLE_WIDTH_DEFAULT - tableWidth)}
                onKeyDown={e => {
                  if (e.key === 'ArrowLeft')  { e.preventDefault(); nudgeTableWidth(24); }
                  if (e.key === 'ArrowRight') { e.preventDefault(); nudgeTableWidth(-24); }
                }}
                className={cn(
                  'w-1 flex-shrink-0 cursor-col-resize touch-none transition-colors outline-none',
                  'hover:bg-amber-accent/70 focus-visible:bg-amber-accent',
                  resizing ? 'bg-amber-accent' : 'bg-industrial-border',
                )}
              />
            )}
            {resizing && <div className="fixed inset-0 z-[90] cursor-col-resize" aria-hidden />}

            <div
              style={{ width: rightCollapsed ? 0 : tableWidth }}
              className={cn(
                'flex flex-col h-full overflow-hidden flex-shrink-0',
                !resizing && 'transition-[width] duration-300 ease-in-out',
              )}
            >
              <TakeoffTable
                measurements={ps.measurements}
                materials={ps.materials as Material[]}
                onUpdate={updateMeasurement}
                onDelete={deleteMeasurement}
                onToggleVisibility={toggleVisibility}
                onExpand={openFullTable}
                onCollapse={collapseTable}
                onOpenAnalysis={openAnalysis}
                onAddSegmentToGroup={handleAddSegmentToGroup}
                onAddManual={handleAddManual}
              />
            </div>

          </div>
        </div>
      </div>

      <AnimatePresence>
        {showMaterialLibrary && (
          <MaterialLibrary
            materials={ps.materials as Material[]}
            onUpdateMaterials={(mats: Material[]) => setProjectState((prev: any) => ({ ...prev, materials: mats }))}
            onClose={() => setShowMaterialLibrary(false)}
          />
        )}
        {showExportModal && (
          <ExportModal
            projectState={ps}
            onClose={() => setShowExportModal(false)}
            onExport={executeExport}
            onExportCsv={filename => {
              downloadCsv(takeoffToCsv({ projectName: ps.projectName, measurements: ps.measurements, materials: ps.materials as never, drawings: ps.drawings }), filename || `${ps.projectName}-takeoff`);
              addToast('Exported CSV', 'success');
              setShowExportModal(false);
            }}
          />
        )}
      </AnimatePresence>

      <ToastContainer
        toasts={toasts}
        onRemove={(id) => setToasts(prev => prev.filter(t => t.id !== id))}
      />

      <footer className="h-6 bg-industrial-black border-t border-industrial-border flex-shrink-0 z-50 font-mono grid grid-cols-[1fr_auto_1fr] items-center px-4 relative">

        <div className="flex items-center gap-6">
<button
            type="button"
            onClick={() => setLeftCollapsed(v => !v)}
            title="Switch drawing ([)"
            className="text-[10px] text-zinc-400 hover:text-amber-accent tracking-wide font-semibold truncate max-w-[260px]"
          >
            {activeDrawing ? activeDrawing.name : 'No drawing open'}
            {ps.drawings.length > 1 && <span className="text-zinc-600"> · {ps.drawings.length} drawings</span>}
          </button>
          <div className="w-px h-3 bg-zinc-800" />
          <span className="text-[10px] text-zinc-600 uppercase tracking-widest font-bold">
            {ps.measurements.filter(m => !m.isGroupHeader).length} measurements
          </span>
        </div>

        <div className="relative flex items-center justify-center group">
          <div className={cn(
            'absolute bottom-7 left-1/2 -translate-x-1/2 z-[100]',
            'bg-[#111] border border-amber-400/60 px-4 py-2.5 min-w-[160px]',
            'transition-all duration-150 pointer-events-none opacity-0 translate-y-1',
            'group-hover:opacity-100 group-hover:translate-y-0 group-hover:pointer-events-auto',
          )}>
            <p className="text-[10px] text-zinc-600 uppercase tracking-[0.2em] font-bold text-center mb-2">
              — Presets —
            </p>
            {['Carcass Cabinet', 'Door Assembly', 'Roof Framing', 'Pipe Run', 'Window Unit'].map(label => (
              <button
                key={label}
                onClick={() => setShowPresetDrawer(true)}
                className="flex items-center gap-1.5 w-full text-left text-[10px] text-zinc-500 uppercase tracking-widest font-bold py-0.5 hover:text-amber-400 transition-colors"
              >
                <span className="text-[10px]">▸</span>
                {label}
              </button>
            ))}
          </div>

          <button
            onClick={() => setShowPresetDrawer(prev => !prev)}
            className={cn(
              'relative flex items-center gap-1.5 px-3 h-[22px] overflow-hidden',
              'border text-[10px] uppercase tracking-widest font-bold transition-all duration-150 group/btn',
              showPresetDrawer
                ? 'bg-amber-400 text-black border-amber-400'
                : 'border-amber-400/70 text-amber-400 hover:bg-amber-400 hover:text-black',
            )}
          >
            <span className="absolute top-0 left-[-60%] w-[40%] h-full bg-gradient-to-r from-transparent via-white/25 to-transparent pointer-events-none group-hover/btn:animate-[shimmer_0.45s_linear_forwards]" />
            <span className="flex flex-col items-center gap-[1px] animate-[bounceUp_1.4s_ease-in-out_infinite]">
              <svg width="8" height="5" viewBox="0 0 8 5" fill="none">
                <polyline points="0,5 4,1 8,5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <svg width="8" height="5" viewBox="0 0 8 5" fill="none" opacity={0.4}>
                <polyline points="0,5 4,1 8,5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            PRESETS
          </button>
        </div>

        <div className="flex items-center gap-4 justify-end">
          {activeDrawing && (
            <span className="text-[10px] text-zinc-600 tracking-wide font-semibold">
              Page {activePage} · {isPageCalibrated ? 'calibrated' : 'not calibrated'}
            </span>
          )}
          <button
            type="button"
            onClick={() => setShowShortcuts(true)}
            className="text-[10px] font-bold uppercase tracking-widest text-zinc-600 hover:text-zinc-300"
            title="Keyboard shortcuts (?)"
          >
            Shortcuts <kbd className="ml-1 border border-zinc-700 px-1 text-zinc-500">?</kbd>
          </button>
        </div>

      </footer>

      {showAnalysis && (
        <AnalysisDialog
          measurements={ps.measurements}
          drawings={ps.drawings}
          materials={ps.materials as Material[]}
          onClose={() => setShowAnalysis(false)}
          onFocus={focusMeasurement}
          onGoToPage={goToPage}
        />
      )}
      {showShortcuts && <ShortcutsDialog onClose={() => setShowShortcuts(false)} />}

      <style>{`
        @keyframes bounceUp {
          0%, 100% { transform: translateY(0); }
          50%       { transform: translateY(-2px); }
        }
        @keyframes shimmer {
          0%   { left: -60%; }
          100% { left: 160%; }
        }
      `}</style>
    </div>
  );
}
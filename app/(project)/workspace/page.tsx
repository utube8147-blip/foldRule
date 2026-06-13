'use client';
// ─── workspace/page.tsx ───────────────────────────────────────────────────────
//
//  CHANGES vs previous version:
//
//  1. REMOVED 'a' KEY FROM WORKSPACE KEYBOARD HANDLER
//     The workspace keydown handler mapped 'a' → setActiveTool('area').
//     This fired before Viewer.tsx's handler and stole the key, making the
//     polyarc mode toggle (and any future A-key use in canvas tools) impossible.
//     Removed 'a' from the workspace handler entirely. Area tool can be
//     reached via the toolbar button.
//
//  2. FIXED TOOLBAR WIRING — was using raw setActiveTool, now passes through
//     the Viewer's handleSetActiveTool so the linear↔arc→polyarc upgrade
//     logic runs when the user clicks toolbar buttons at workspace level.
//     The toolbar in workspace now reads polyarcMode / togglePolyarcMode from
//     toolbarAPI which Viewer exposes via onToolbarReady.
//
//  3. SHIFT+CLICK ARC MODE — polyarcMode / togglePolyarcMode props removed
//     from the workspace-level ViewerToolbar render since the A-key toggle is
//     gone and shift+click handles arc mode inline. The toolbar pill that
//     showed LINE/ARC still lives inside Viewer's own ViewerToolbar render.
//
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/layout/Sidebar';
import { Navbar } from '@/components/layout/Navbar';
import dynamic from 'next/dynamic';
import type { ViewerToolbarAPI } from '@/components/Viewer';
import { Material, TakeoffRow, ToolType } from '@/types';
import { ViewerToolbar } from '@/components/Viewer/ViewerToolbar';

const Viewer = dynamic(
  () => import('@/components/Viewer').then(m => m.Viewer),
  { ssr: false }
);

import { TakeoffTable } from '@/components/features/takeoff/TakeoffTable';
import { MaterialLibrary } from '@/components/features/takeoff/MaterialLibrary';
import { ExportModal } from '@/components/features/dialogs/ExportModal';
import { ToastContainer } from '@/components/Toast';
import { PresetTemplate } from '@/components/presets/PresetTemplates';
import { useTakeoffContext } from '@/context/TakeoffContext';
import {
  PanelRightClose,
  Sidebar as SidebarIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { AnimatePresence } from 'motion/react';

// ─── SVG snap layout URL ──────────────────────────────────────────────────────
const SNAP_SVG_URL = '/floorplan.svg';

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
  } = useTakeoffContext();

  const [leftCollapsed,       setLeftCollapsed]       = useState(false);
  const [rightCollapsed,      setRightCollapsed]      = useState(false);
  const [showMaterialLibrary, setShowMaterialLibrary] = useState(false);
  const [showExportModal,     setShowExportModal]     = useState(false);
  const [showPresetDrawer,    setShowPresetDrawer]    = useState(false);
  const [toasts,              setToasts]              = useState<any[]>([]);
  const [isMounted,           setIsMounted]           = useState(false);
  const [toolbarAPI,          setToolbarAPI]          = useState<ViewerToolbarAPI | null>(null);
  const [appendToGroupId,     setAppendToGroupId]     = useState<string | null>(null);

  // ── Toolbar state managed at workspace level ──────────────────────────────
  const [snapEnabled,      setSnapEnabled]      = useState(false);
  const [showSnapSettings, setShowSnapSettings] = useState(false);
  const [showPins,         setShowPins]         = useState(false);

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

  const currentScaleFactor = useMemo(
    () => (activeDrawing ? activeDrawing.scaleFactor : 1),
    [activeDrawing],
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
    const newTool = toolMap[groupType] || 'linear';
    setActiveTool(newTool);
    addToast(`ADDING TO GROUP: Use ${newTool} tool to draw new item`, 'info');
  }, [setActiveTool, addToast]);

  const handleAppendComplete = useCallback(() => setAppendToGroupId(null), []);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  // IMPORTANT: 'a' is intentionally NOT mapped here.
  // The Viewer's internal keydown handler owns 'a' for the polyarc toggle.
  // Mapping 'a' here caused the tool to switch away from polyarc the moment
  // the user tried to change arc mode.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['input', 'textarea'].includes((e.target as HTMLElement).tagName.toLowerCase())) return;
      switch (e.key.toLowerCase()) {
        case 'l': setActiveTool('linear'      as ToolType); break;
        // 'a' deliberately omitted — owned by Viewer for polyarc toggle
        case 'c': setActiveTool('count'       as ToolType); break;
        case 'p': setActiveTool('point'       as ToolType); break;
        case 'v': setActiveTool('select'      as ToolType); break;
        case 'm': setActiveTool('magic-fill'  as ToolType); break;
        case 'escape': setActiveTool('select' as ToolType); break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setActiveTool]);

  // ── onAddMeasurement ──────────────────────────────────────────────────────
  const handleAddMeasurement = useCallback((m: any) => {
    if (!activeDrawing) {
      addToast('PLEASE SELECT OR IMPORT A DRAWING FIRST', 'info');
      return;
    }
    addMeasurement(buildRow({
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
    fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename }),
    })
      .then(async res => {
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(err.details || err.error || `HTTP ${res.status}`);
        }
        const disposition = res.headers.get('Content-Disposition');
        const match       = disposition?.match(/filename="(.+)"/);
        const finalName   = filename || match?.[1] || `BOQ_${new Date().toISOString().split('T')[0]}.xlsx`;
        const blob = await res.blob();
        return { blob, filename: finalName };
      })
      .then(({ blob, filename: finalName }) => {
        const url = URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href = url; a.download = finalName; a.click();
        URL.revokeObjectURL(url);
        addToast('TAKEOFF EXPORTED SUCCESSFULLY', 'success');
        setShowExportModal(false);
      })
      .catch(err => {
        console.error('Export failed:', err);
        addToast(`EXPORT FAILED — ${err.message}`, 'info');
      });
  }, [addToast]);

  const handleScaleSet = useCallback((f: number) => {
    if (activeDrawing) {
      updateDrawingScale(activeDrawing.id, f);
      addToast(`SCALE CALIBRATED: 1px = ${f.toFixed(4)}u`, 'info');
    }
  }, [activeDrawing, updateDrawingScale, addToast]);

  const handleToolbarReady = useCallback((api: ViewerToolbarAPI) => {
    setToolbarAPI(api);
  }, []);

  const api = toolbarAPI;

  if (!isMounted) {
    return (
      <div className="flex flex-col h-screen bg-industrial-black">
        <Navbar
          projectName={ps.projectName}
          onProjectNameChange={(name) => updateProjectMeta({ projectName: name })}
          onExport={handleExport}
          onOpenPresets={() => setShowPresetDrawer(true)}
        />
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <div className="w-12 h-12 border-4 border-zinc-800 border-t-amber-400 rounded-full animate-spin" />
            <span className="text-[10px] font-mono font-bold text-amber-400 tracking-[0.2em] uppercase animate-pulse">
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
        onProjectNameChange={(name) => updateProjectMeta({ projectName: name })}
        onExport={handleExport}
        onOpenPresets={() => setShowPresetDrawer(true)}
      />

      <div className="flex flex-1 overflow-hidden mt-14">

        <Sidebar
          isCollapsed={leftCollapsed}
          projectState={{ ...ps, activeDrawingId: ps.activeDrawingId ?? undefined }}
          onUpdateMaterials={(mats) => setProjectState((prev: any) => ({ ...prev, materials: mats }))}
          onOpenMaterialLibrary={() => setShowMaterialLibrary(true)}
          onDrawingAdded={addDrawing}
          onSelectDrawing={setActiveDrawingId}
          onUpdateProjectMeta={updateProjectMeta}
        />

        <div className="absolute left-0 bottom-10 z-[60] ml-2 flex flex-col gap-2">
          <button
            onClick={() => setLeftCollapsed(!leftCollapsed)}
            className="bg-industrial-panel border border-industrial-border p-1.5 text-zinc-500 hover:text-amber-accent transition-colors shadow-lg"
            title={leftCollapsed ? 'Expand Sidebar' : 'Collapse Sidebar'}
          >
            <SidebarIcon className={cn('w-4 h-4 transition-transform', leftCollapsed && 'rotate-180')} />
          </button>
        </div>

        <div className="flex flex-col flex-1 overflow-hidden min-w-0">

          {/* ── Toolbar (hoisted to workspace) ── */}
          {/* FIXED: setActiveTool now routes through api.setActiveTool which is
              Viewer's handleSetActiveTool — so the polyarc upgrade logic runs
              correctly when toolbar buttons are clicked at workspace level.
              polyarcMode / togglePolyarcMode are read from toolbarAPI so the
              toolbar pill stays in sync with Viewer's internal state. */}
          <ViewerToolbar
            activeTool={activeTool as ToolType}
            setActiveTool={(tool: ToolType) => api?.setActiveTool
              ? api.setActiveTool(tool)
              : setActiveTool(tool)
            }
            canUndo={api?.canUndo ?? false}
            canRedo={api?.canRedo ?? false}
            handleUndo={() => api?.handleUndo?.()}
            handleRedo={() => api?.handleRedo?.()}
            tempPointsCount={0}
            showPins={showPins}
            setShowPins={setShowPins}
            snapEnabled={snapEnabled}
            setSnapEnabled={setSnapEnabled}
            showSnapSettings={showSnapSettings}
            setShowSnapSettings={setShowSnapSettings}
            scaleFactor={currentScaleFactor}
            handleManualScale={() => api?.handleManualScale?.()}
            analysisStatus={api?.analysisStatus ?? 'idle'}
            analysisPage={api?.analysisPage ?? null}
            currentPageCorners={api?.currentPageCorners ?? 0}
            scale={api?.scale ?? 1}
            setScale={(s) => api?.setScale?.(s)}
            fitToScreen={() => api?.fitToScreen?.()}
            MIN_ZOOM={0.1}
            MAX_ZOOM={5}
            ZOOM_SENSITIVITY={0.1}
            polyarcMode={api?.polyarcMode}
            togglePolyarcMode={api?.togglePolyarcMode}
          />

          <div className="flex flex-1 overflow-hidden relative min-h-0">

            <div className="flex-1 min-w-0 relative">
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
                onClosePresetDrawer={() => setShowPresetDrawer(false)}
                onSelectPreset={handlePresetSelect}
                hideToolbar={true}
                onToolbarReady={handleToolbarReady}
                appendToGroupId={appendToGroupId}
                onAppendComplete={handleAppendComplete}
                svgUrl={SNAP_SVG_URL}
                showPins={showPins}
                onShowPinsChange={setShowPins}
              />
            </div>

            <div className={cn(
              'flex flex-col h-full overflow-hidden transition-all duration-300 flex-shrink-0',
              rightCollapsed ? 'w-0' : 'w-96',
            )}>
              <TakeoffTable
                measurements={ps.measurements}
                materials={ps.materials as Material[]}
                onUpdate={updateMeasurement}
                onDelete={deleteMeasurement}
                onToggleVisibility={toggleVisibility}
                onExpand={() => router.push('/takeoff-full')}
                onAddSegmentToGroup={handleAddSegmentToGroup}
                onAddManual={() => handleAddMeasurement({
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
                } as TakeoffRow)}
              />
            </div>

            <div className="absolute right-0 bottom-10 z-[60] mr-2">
              <button
                onClick={() => setRightCollapsed(!rightCollapsed)}
                className="bg-industrial-panel border border-industrial-border p-1.5 text-zinc-500 hover:text-amber-accent transition-colors shadow-lg"
                title={rightCollapsed ? 'Expand Data Panel' : 'Collapse Data Panel'}
              >
                <PanelRightClose className={cn('w-4 h-4 transition-transform', rightCollapsed && 'rotate-180')} />
              </button>
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
          />
        )}
      </AnimatePresence>

      <ToastContainer
        toasts={toasts}
        onRemove={(id) => setToasts(prev => prev.filter(t => t.id !== id))}
      />

      <footer className="h-6 bg-industrial-black border-t border-industrial-border flex-shrink-0 z-50 font-mono grid grid-cols-[1fr_auto_1fr] items-center px-4 relative">

        <div className="flex items-center gap-6">
          <span className="text-[9px] text-zinc-600 uppercase tracking-widest font-bold">
            Workspace: LOGISTICS_HUB_P2
          </span>
          <div className="w-px h-3 bg-zinc-800" />
          <span className="text-[9px] text-zinc-600 uppercase tracking-widest font-bold">
            Objects: {ps.measurements.length}
          </span>
        </div>

        <div className="relative flex items-center justify-center group">
          <div className={cn(
            'absolute bottom-7 left-1/2 -translate-x-1/2 z-[100]',
            'bg-[#111] border border-amber-400/60 px-4 py-2.5 min-w-[160px]',
            'transition-all duration-150 pointer-events-none opacity-0 translate-y-1',
            'group-hover:opacity-100 group-hover:translate-y-0 group-hover:pointer-events-auto',
          )}>
            <p className="text-[8px] text-zinc-600 uppercase tracking-[0.2em] font-bold text-center mb-2">
              — Presets —
            </p>
            {['Carcass Cabinet', 'Door Assembly', 'Roof Framing', 'Pipe Run', 'Window Unit'].map(label => (
              <button
                key={label}
                onClick={() => setShowPresetDrawer(true)}
                className="flex items-center gap-1.5 w-full text-left text-[9px] text-zinc-500 uppercase tracking-widest font-bold py-0.5 hover:text-amber-400 transition-colors"
              >
                <span className="text-[8px]">▸</span>
                {label}
              </button>
            ))}
          </div>

          <button
            onClick={() => setShowPresetDrawer(prev => !prev)}
            className={cn(
              'relative flex items-center gap-1.5 px-3 h-[22px] overflow-hidden',
              'border text-[9px] uppercase tracking-widest font-bold transition-all duration-150 group/btn',
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
          <span className="text-[9px] text-zinc-600 uppercase tracking-widest font-bold">
            LAT: 34.0522 N / LON: 118.2437 W
          </span>
          <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
        </div>

      </footer>

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
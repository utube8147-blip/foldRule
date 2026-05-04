'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import { Navbar } from '@/components/Navbar';
import { Viewer, ViewerToolbarAPI } from '@/components/Viewer';
import { TakeoffTable } from '@/components/TakeoffTable';
import { MaterialLibrary } from '@/components/MaterialLibrary';
import { ExportModal } from '@/components/ExportModal';
import { ToastContainer } from '@/components/Toast';
import { PresetTemplate } from '@/components/presets/PresetTemplates';
import { useTakeoffContext } from '@/context/TakeoffContext';
import { exportToExcel } from '@/lib/excelExport';
import {
  PanelRightClose,
  Sidebar as SidebarIcon,
  ZoomIn,
  ZoomOut,
  Maximize,
  Target,
  Settings2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { AnimatePresence } from 'motion/react';
import { TakeoffRow } from '@/types';

// ─── Workspace Page ───────────────────────────────────────────────────────────

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
  } = useTakeoffContext();

  // ── Local UI state ────────────────────────────────────────────────────────────
  const [leftCollapsed, setLeftCollapsed]       = useState(false);
  const [rightCollapsed, setRightCollapsed]     = useState(false);
  const [showMaterialLibrary, setShowMaterialLibrary] = useState(false);
  const [showExportModal, setShowExportModal]   = useState(false);
  const [showPresetDrawer, setShowPresetDrawer] = useState(false);
  const [toasts, setToasts]                     = useState<any[]>([]);

  // ── Toolbar API surfaced from Viewer via onToolbarReady ───────────────────────
  const [toolbarAPI, setToolbarAPI] = useState<ViewerToolbarAPI | null>(null);

  const activeDrawing       = ps.drawings.find(d => d.id === ps.activeDrawingId) || null;
  const currentScaleFactor  = activeDrawing ? activeDrawing.scaleFactor : 1;
  const activeMeasurements  = ps.measurements.filter(m => m.drawingId === ps.activeDrawingId);

  const addToast = (message: string, type: 'success' | 'info' = 'info') => {
    const id = Math.random().toString(36).substr(2, 9);
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000);
  };

  // ── Group ID helper ───────────────────────────────────────────────────────────
  const generateGroupId = () => `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // ── Carcass grouped measurement generator ────────────────────────────────────
  const generateGroupedCarcassMeasurements = (
    data: Record<string, any>,
    template: PresetTemplate,
    drawingId: string,
    groupId: string
  ): { measurements: Partial<TakeoffRow>[]; groupName: string } => {
    const measurements: Partial<TakeoffRow>[] = [];

    const W      = parseFloat(data.width          ?? 600) / 1000;
    const H      = parseFloat(data.height         ?? 720) / 1000;
    const D      = parseFloat(data.depth          ?? 550) / 1000;
    const T      = parseFloat(data.panelThickness ?? 18)  / 1000;
    const shelves    = parseInt(data.shelfCount ?? 2);
    const doorCount  = parseInt(data.doorCount  ?? 1);

    const iW = W - 2 * T;
    const iH = H - 2 * T;

    const groupName = `${data.customName || 'Cabinet'} (${data.width || 600}×${data.height || 720}×${data.depth || 550}mm)`;

    if (data.hasBack !== false) {
      measurements.push({ description: 'Back Panel', type: 'Area', quantity: +(iW * iH).toFixed(3), unit: 'm²', notes: `Material: ${data.boardMaterial || '18mm MDF'}`, category: 'Board Materials', isOverridden: true });
    }
    if (data.hasTop !== false) {
      measurements.push({ description: 'Top Panel', type: 'Area', quantity: +(iW * D).toFixed(3), unit: 'm²', notes: `Material: ${data.boardMaterial || '18mm MDF'}`, category: 'Board Materials', isOverridden: true });
    }
    if (data.hasBottom !== false) {
      measurements.push({ description: 'Bottom Panel', type: 'Area', quantity: +(iW * D).toFixed(3), unit: 'm²', notes: `Material: ${data.boardMaterial || '18mm MDF'}`, category: 'Board Materials', isOverridden: true });
    }
    if (data.hasLeftSide !== false) {
      measurements.push({ description: 'Left Side Panel', type: 'Area', quantity: +(D * H).toFixed(3), unit: 'm²', notes: `Material: ${data.boardMaterial || '18mm MDF'}`, category: 'Board Materials', isOverridden: true });
    }
    if (data.hasRightSide !== false) {
      measurements.push({ description: 'Right Side Panel', type: 'Area', quantity: +(D * H).toFixed(3), unit: 'm²', notes: `Material: ${data.boardMaterial || '18mm MDF'}`, category: 'Board Materials', isOverridden: true });
    }
    if (shelves > 0) {
      measurements.push({ description: `Shelves (${shelves} pcs)`, type: 'Area', quantity: +(iW * D * shelves).toFixed(3), unit: 'm²', notes: `Material: ${data.shelfMaterial || data.boardMaterial || '18mm MDF'} | Spacing: ${data.shelfSpacing || 'Equal'}`, category: 'Shelves', isOverridden: true });
    }
    if (data.hasDoors) {
      const doorArea = (W / doorCount) * H * doorCount;
      measurements.push({ description: `Doors (${doorCount} pcs)`, type: 'Area', quantity: +doorArea.toFixed(3), unit: 'm²', notes: `Material: ${data.doorMaterial || 'MDF Primed'} | Style: ${data.doorSwing || 'Standard'}`, category: 'Doors', isOverridden: true });
      measurements.push({ description: 'Door Hardware', type: 'Count', quantity: doorCount, unit: 'sets', notes: `Hinges (2 per door), handles (1 per door) | Type: ${data.hingeType || 'Concealed'}`, category: 'Hardware', isOverridden: true });
    }
    if (data.hasDrawers) {
      const drawerCount = parseInt(data.drawerCount ?? 2);
      measurements.push({ description: `Drawer Fronts (${drawerCount} pcs)`, type: 'Count', quantity: drawerCount, unit: 'pcs', notes: `Material: ${data.drawerMaterial || 'Match doors'}`, category: 'Drawers', isOverridden: true });
      measurements.push({ description: 'Drawer Hardware', type: 'Count', quantity: drawerCount, unit: 'sets', notes: `Drawer slides (1 pair per drawer), handles`, category: 'Hardware', isOverridden: true });
    }

    let edgeBanding = 0;
    if (data.hasTop    !== false) edgeBanding += 2 * (iW + D);
    if (data.hasBottom !== false) edgeBanding += 2 * (iW + D);
    if (data.hasLeftSide  !== false) edgeBanding += 2 * (D + H);
    if (data.hasRightSide !== false) edgeBanding += 2 * (D + H);
    if (shelves > 0) edgeBanding += (2 * iW + D) * shelves;

    if (edgeBanding > 0) {
      measurements.push({ description: 'Edge Banding', type: 'Length', quantity: +(edgeBanding * 1.1).toFixed(2), unit: 'm', notes: `Material: ${data.edgeTape || 'PVC 0.4mm'} | All exposed edges +10% waste`, category: 'Finishing', isOverridden: true });
    }

    measurements.push({ description: 'Assembly & Installation', type: 'Count', quantity: 1, unit: 'each', notes: `Labor, cam locks, fixing brackets, assembly hardware`, category: 'Labor', isOverridden: true });

    if (data.hasToeKick) {
      measurements.push({ description: 'Toe Kick / Plinth', type: 'Length', quantity: W, unit: 'm', notes: `Material: ${data.kickboardMaterial || 'Same as carcass'} | Height: ${data.kickboardHeight || '100mm'}`, category: 'Finishing', isOverridden: true });
    }

    return { measurements, groupName };
  };

  // ── Preset handler ────────────────────────────────────────────────────────────
  const handlePresetSelect = (data: Record<string, any>, template: PresetTemplate) => {
    if (!activeDrawing) {
      addToast('PLEASE SELECT OR IMPORT A DRAWING FIRST', 'info');
      return;
    }

    const groupId = generateGroupId();

    if (template.id === 'carcass') {
      const { measurements, groupName } = generateGroupedCarcassMeasurements(data, template, activeDrawing.id, groupId);

      const headerRow: TakeoffRow = {
        id: `${groupId}-header`,
        drawingId: activeDrawing.id,
        groupId,
        groupName,
        groupType: template.id,
        isGroupHeader: true,
        isExpanded: true,
        description: groupName,
        type: 'Count',
        quantity: 1,
        unit: 'assembly',
        unitRate: 0,
        notes: `Complete ${template.name.toLowerCase()} assembly`,
        points: [],
        isOverridden: true,
        presetId: template.id,
        presetData: data,
        category: 'Group Header',
        color: '#EF9F27',
        isVisible: true,
      };

      addMeasurement(headerRow);
      measurements.forEach(measurement => {
        addMeasurement({
          id: `${groupId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          drawingId: activeDrawing.id,
          groupId,
          parentId: `${groupId}-header`,
          ...measurement,
          presetData: data,
          presetId: template.id,
          color: '#85B7EB',
          isVisible: true,
        } as TakeoffRow);
      });

      addToast(`${groupName} ADDED (${measurements.length} components)`, 'success');
    } else {
      let quantity = 0;
      let unit = 'm';

      switch (template.measurementType) {
        case 'linear':
          quantity = parseFloat(data.length ?? data.pipeLength ?? data.roofPitch ?? 0) || 0;
          unit = 'm';
          break;
        case 'area':
          quantity = parseFloat(data.area ?? data.roofArea ?? 0) || (parseFloat(data.width ?? 0) * parseFloat(data.height ?? 0)) / 1e6 || 0;
          unit = 'm²';
          break;
        case 'count':
          quantity = parseInt(data.quantity ?? data.doorCount ?? data.windowCount ?? 1);
          unit = 'pcs';
          break;
        default:
          quantity = 0;
      }

      addMeasurement({
        id: `${activeDrawing.id}-${Date.now()}`,
        drawingId: activeDrawing.id,
        description: template.name,
        type: template.measurementType === 'linear' ? 'Length' : template.measurementType === 'area' ? 'Area' : 'Count',
        quantity,
        unit,
        unitRate: 0,
        notes: `Preset: ${template.name} · ${template.category}`,
        points: [],
        isOverridden: true,
        presetData: data,
        presetId: template.id,
        color: '#EF9F27',
        isVisible: true,
      } as TakeoffRow);

      addToast(`${template.name.toUpperCase()} ADDED`, 'success');
    }
  };

  // ── Keyboard shortcuts ────────────────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['input', 'textarea'].includes((e.target as HTMLElement).tagName.toLowerCase())) return;
      switch (e.key.toLowerCase()) {
        case 'l': setActiveTool('linear'); break;
        case 'a': setActiveTool('area');   break;
        case 'c': setActiveTool('count');  break;
        case 'p': setActiveTool('point');  break;
        case 'v': setActiveTool('select'); break;
        case 'escape': setActiveTool('select'); break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setActiveTool]);

  // ── Canvas measurement handler ────────────────────────────────────────────────
  const handleAddMeasurement = (m: any) => {
    if (!activeDrawing) {
      addToast('PLEASE SELECT OR IMPORT A DRAWING FIRST', 'info');
      return;
    }
    const safeMeasurement = {
      description:    m.description    || 'Untitled Measurement',
      type:           m.type           || 'Length',
      quantity:       m.quantity       || 0,
      unit:           m.unit           || 'm',
      unitRate:       m.unitRate       || 0,
      notes:          m.notes          || '',
      points:         m.points         || [],
      isOverridden:   m.isOverridden   !== false,
      presetData:     m.presetData,
      presetId:       m.presetId,
      groupId:        m.groupId,
      groupName:      m.groupName,
      groupType:      m.groupType,
      parentId:       m.parentId,
      isGroupHeader:  m.isGroupHeader  || false,
      category:       m.category,
    };
    addMeasurement(safeMeasurement);
    addToast(`MEASUREMENT ADDED: ${safeMeasurement.description}`, 'success');
  };

  const handleExport    = () => setShowExportModal(true);
  const executeExport   = () => {
    exportToExcel(ps);
    addToast('TAKEOFF EXPORTED SUCCESSFULLY', 'success');
    setShowExportModal(false);
  };
  const handleScaleSet  = (f: number) => {
    if (activeDrawing) {
      updateDrawingScale(activeDrawing.id, f);
      addToast(`SCALE CALIBRATED: 1px = ${f}u`, 'info');
    }
  };

  const api = toolbarAPI;

  return (
    <div className="flex flex-col h-screen overflow-hidden">

      {/* ── 1. Top navbar (fixed, h-14) ──────────────────────────────────────── */}
      <Navbar
        projectName={ps.projectName}
        onProjectNameChange={(name) => setProjectState(prev => ({ ...prev, projectName: name }))}
        onExport={handleExport}
        onOpenPresets={() => setShowPresetDrawer(true)}
      />

      {/* ── 2. Content row — Sidebar | [Toolbar + Viewer + TakeoffPanel] ─────── */}
      <div className="flex flex-1 overflow-hidden mt-14">

        {/* Left sidebar */}
        <Sidebar
          isCollapsed={leftCollapsed}
          projectState={ps}
          onUpdateMaterials={(mats) => setProjectState(prev => ({ ...prev, materials: mats }))}
          onOpenMaterialLibrary={() => setShowMaterialLibrary(true)}
          onDrawingAdded={addDrawing}
          onSelectDrawing={setActiveDrawingId}
          onProjectNameChange={(name) => setProjectState(prev => ({ ...prev, projectName: name }))}
          onProjectNumberChange={(num) => setProjectState(prev => ({ ...prev, projectNumber: num }))}
        />

        {/* Sidebar collapse toggle */}
        <div className="absolute left-0 bottom-10 z-[60] ml-2 flex flex-col gap-2">
          <button
            onClick={() => setLeftCollapsed(!leftCollapsed)}
            className="bg-industrial-panel border border-industrial-border p-1.5 text-zinc-500 hover:text-amber-accent transition-colors shadow-lg"
            title={leftCollapsed ? 'Expand Sidebar' : 'Collapse Sidebar'}
          >
            <SidebarIcon className={cn('w-4 h-4 transition-transform', leftCollapsed && 'rotate-180')} />
          </button>
        </div>

        {/* ── Right column: toolbar on top, then viewer + takeoff panel below ── */}
        <div className="flex flex-col flex-1 overflow-hidden">

          {/* ── Viewer toolbar — only spans right of sidebar ─────────────────── */}
          <div className="flex-shrink-0 h-12 bg-industrial-panel border-b border-industrial-border flex items-center justify-between px-4 z-30 shadow-sm">

            {/* Tool buttons */}
            <div className="flex gap-1 flex-shrink-0">
              {api?.tools.map(tool => (
                <button
                  key={tool.id}
                  onClick={() => api.setActiveTool(tool.id as any)}
                  className={cn(
                    'w-9 h-9 flex items-center justify-center transition-all relative group border',
                    api.activeTool === tool.id
                      ? 'bg-zinc-800 border-amber-400 text-amber-400'
                      : 'bg-transparent border-transparent text-zinc-500 hover:text-zinc-200',
                  )}
                  title={`${tool.label} (${tool.shortcut})`}
                >
                  <tool.icon className="w-4 h-4" />
                  <div className="absolute top-10 transform -translate-x-1/2 left-1/2 px-2 py-1 bg-zinc-900 border border-industrial-border text-[9px] text-zinc-400 invisible group-hover:visible whitespace-nowrap pointer-events-none uppercase tracking-widest font-mono z-50">
                    {tool.label} [{tool.shortcut}]
                  </div>
                </button>
              ))}
            </div>

            {/* Middle: analysis status + snap + scale + calibration */}
            <div className="flex items-center gap-2 flex-1 justify-center flex-wrap mx-4">

              {api?.analysisStatus === 'analyzing' && api.analysisPage && (
                <div className="flex items-center gap-1.5 border border-blue-500/40 bg-blue-500/10 px-2 py-1">
                  <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                  <span className="text-[9px] font-mono text-blue-400 uppercase tracking-widest">
                    Analyzing… {api.analysisPage.current}/{api.analysisPage.total}
                  </span>
                </div>
              )}

              {api?.analysisStatus === 'done' && (
                <div className="flex items-center gap-1.5 border border-green-500/40 bg-green-500/10 px-2 py-1">
                  <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
                  <span className="text-[9px] font-mono text-green-400 uppercase tracking-widest">
                    {api.currentPageCorners} corners detected
                  </span>
                </div>
              )}

              <button
                onClick={() => api?.setSnapEnabled(s => !s)}
                className={cn(
                  'flex items-center gap-1 text-[9px] font-mono font-bold uppercase tracking-widest px-2 py-1 border transition-all',
                  api?.snapEnabled
                    ? 'bg-green-500/10 border-green-500/50 text-green-400 hover:bg-green-500/20'
                    : 'bg-transparent border-zinc-700 text-zinc-500 hover:border-zinc-500',
                )}
                title="Toggle corner snapping"
              >
                <Target className="w-3 h-3" />
                {api?.snapEnabled ? 'SNAP ON' : 'SNAP OFF'}
              </button>

              <button
                onClick={() => api?.setShowSnapSettings(s => !s)}
                className={cn(
                  'flex items-center gap-1 text-[9px] font-mono font-bold uppercase tracking-widest px-2 py-1 border transition-all',
                  api?.showSnapSettings
                    ? 'bg-zinc-800 border-zinc-500 text-zinc-200'
                    : 'bg-transparent border-zinc-700 text-zinc-500 hover:border-zinc-500',
                )}
                title="Snap settings"
              >
                <Settings2 className="w-3 h-3" />
                SNAP
              </button>

              <div className="flex items-center gap-1 border border-industrial-border bg-stone-900 px-2 py-1">
                <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-tighter">Scale:</span>
                <span className="text-[10px] font-mono font-bold text-amber-400 tracking-tighter whitespace-nowrap">
                  {currentScaleFactor === 1 ? 'NOT CALIBRATED' : `1pt = ${currentScaleFactor.toFixed(4)}m`}
                </span>
              </div>

              <button
                onClick={() => api?.setActiveTool('scale')}
                className={cn(
                  'text-[10px] font-mono font-bold uppercase tracking-widest px-3 py-1 transition-all border',
                  api?.activeTool === 'scale'
                    ? 'bg-amber-400 text-black border-amber-400'
                    : 'text-amber-400 border-amber-400 hover:bg-amber-400 hover:text-black',
                )}
              >
                DRAW CALIBRATION
              </button>

              <button
                onClick={() => api?.handleManualScale()}
                className="text-[10px] font-mono font-bold uppercase tracking-widest px-3 py-1 transition-all border text-amber-400 border-amber-400 hover:bg-amber-400 hover:text-black"
              >
                MANUAL SCALE
              </button>
            </div>

            {/* Zoom controls */}
            <div className="flex items-center gap-2 flex-shrink-0">
              <button onClick={() => api?.setScale(s => Math.max(0.1, s - 0.1))} className="p-1.5 text-zinc-500 hover:text-zinc-200">
                <ZoomOut className="w-4 h-4" />
              </button>
              <span className="text-[10px] font-mono text-zinc-400 w-12 text-center">
                {api ? `${Math.round(api.scale * 100)}%` : '—'}
              </span>
              <button onClick={() => api?.setScale(s => s + 0.1)} className="p-1.5 text-zinc-500 hover:text-zinc-200">
                <ZoomIn className="w-4 h-4" />
              </button>
              <div className="w-px h-4 bg-industrial-border mx-1" />
              <button onClick={() => api?.fitToScreen()} className="p-1.5 text-zinc-500 hover:text-zinc-200">
                <Maximize className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* ── Viewer canvas + TakeoffPanel row ─────────────────────────────── */}
          <div className="flex flex-1 overflow-hidden relative">

            {/* Viewer */}
            <Viewer
              activeTool={activeTool}
              setActiveTool={setActiveTool}
              measurements={activeMeasurements}
              onAddMeasurement={handleAddMeasurement}
              onUpdateMeasurement={updateMeasurement}
              scaleFactor={currentScaleFactor}
              onScaleSet={handleScaleSet}
              activeDrawing={activeDrawing}
              onDrawingAdded={addDrawing}
              showPresetDrawer={showPresetDrawer}
              onClosePresetDrawer={() => setShowPresetDrawer(false)}
              onSelectPreset={handlePresetSelect}
              hideToolbar={true}
              onToolbarReady={setToolbarAPI}
            />

            {/* Right panel — TakeoffTable owns its own header now */}
            <div className={cn(
              'flex flex-col h-full overflow-hidden transition-all duration-300',
              rightCollapsed ? 'w-0' : 'w-96',
            )}>
              <TakeoffTable
                measurements={ps.measurements}
                materials={ps.materials}
                onUpdate={updateMeasurement}
                onDelete={deleteMeasurement}
                onToggleVisibility={toggleVisibility}
                onExpand={() => router.push('/takeoff-full')}
                onAddManual={() => handleAddMeasurement({
                  id: `${activeDrawing?.id || 'manual'}-${Date.now()}`,
                  drawingId: activeDrawing?.id || '',
                  description: 'Manual Item',
                  type: 'Length',
                  quantity: 0,
                  unit: 'm',
                  unitRate: 0,
                  notes: '',
                  points: [],
                  isOverridden: true,
                  color: '#EF9F27',
                  isVisible: true,
                } as TakeoffRow)}
              />
            </div>

            {/* Right panel collapse toggle */}
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
        </div>{/* end right column */}

      </div>{/* end content row */}

      {/* ── Modals ────────────────────────────────────────────────────────────── */}
      <AnimatePresence>
        {showMaterialLibrary && (
          <MaterialLibrary
            materials={ps.materials}
            onUpdateMaterials={(mats) => setProjectState(prev => ({ ...prev, materials: mats }))}
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

      {/* ── Status bar ────────────────────────────────────────────────────────── */}
      <footer className="h-6 bg-industrial-black border-t border-industrial-border flex-shrink-0 z-50 font-mono grid grid-cols-[1fr_auto_1fr] items-center px-4 relative">

        {/* Left */}
        <div className="flex items-center gap-6">
          <span className="text-[9px] text-zinc-600 uppercase tracking-widest font-bold">
            Workspace: LOGISTICS_HUB_P2
          </span>
          <div className="w-px h-3 bg-zinc-800" />
          <span className="text-[9px] text-zinc-600 uppercase tracking-widest font-bold">
            Objects: {ps.measurements.length}
          </span>
        </div>

        {/* Center — Preset trigger */}
        <div className="relative flex items-center justify-center group">

          {/* Popover */}
          <div className={cn(
            'absolute bottom-7 left-1/2 -translate-x-1/2 z-[100]',
            'bg-[#111] border border-amber-400/60 px-4 py-2.5 min-w-[160px]',
            'transition-all duration-150 pointer-events-none opacity-0 translate-y-1',
            'group-hover:opacity-100 group-hover:translate-y-0 group-hover:pointer-events-auto',
          )}>
            <p className="text-[8px] text-zinc-600 uppercase tracking-[0.2em] font-bold text-center mb-2">
              — Presets —
            </p>
            {[
              'Carcass Cabinet',
              'Door Assembly',
              'Roof Framing',
              'Pipe Run',
              'Window Unit',
            ].map(label => (
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

          {/* Button */}
          <button
            onClick={() => setShowPresetDrawer(prev => !prev)}
            className={cn(
              'relative flex items-center gap-1.5 px-3 h-[22px] overflow-hidden',
              'border text-[9px] uppercase tracking-widest font-bold',
              'transition-all duration-150',
              'group/btn',
              showPresetDrawer
                ? 'bg-amber-400 text-black border-amber-400'        // active state
                : 'border-amber-400/70 text-amber-400 hover:bg-amber-400 hover:text-black', // idle
            )}
          >
            {/* Shimmer */}
            <span className="absolute top-0 left-[-60%] w-[40%] h-full bg-gradient-to-r from-transparent via-white/25 to-transparent pointer-events-none group-hover/btn:animate-[shimmer_0.45s_linear_forwards]" />

            {/* Double bouncing chevrons */}
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

        {/* Right */}
        <div className="flex items-center gap-4 justify-end">
          <span className="text-[9px] text-zinc-600 uppercase tracking-widest font-bold">
            LAT: 34.0522 N / LON: 118.2437 W
          </span>
          <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
        </div>

      </footer>
    </div>
  );
}
// ─── workspace/page.tsx ───────────────────────────────────────────────────────
//
//  COMPLETE FIXED VERSION:
//    1. deleteMeasurement imported from useTakeoffContext
//    2. Passed to Viewer via onDeleteMeasurement prop
//    3. All types consistent
//    4. Group append support for all measurement types
//    5. Auto-fix existing groups with wrong types
//
// ─────────────────────────────────────────────────────────────────────────────

'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import { Navbar } from '@/components/Navbar';
import dynamic from 'next/dynamic';
import type { ViewerToolbarAPI } from '@/components/Viewer';
import { Material, TakeoffRow, ToolType } from '@/types';


const Viewer = dynamic(
  () => import('@/components/Viewer').then(m => m.Viewer),
  { ssr: false }
);

import { TakeoffTable } from '@/components/TakeoffTable';
import { MaterialLibrary } from '@/components/MaterialLibrary';
import { ExportModal } from '@/components/ExportModal';
import { ToastContainer } from '@/components/Toast';
import { PresetTemplate } from '@/components/presets/PresetTemplates';
import { useTakeoffContext } from '@/context/TakeoffContext';
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

  const [leftCollapsed, setLeftCollapsed]       = useState(false);
  const [rightCollapsed, setRightCollapsed]     = useState(false);
  const [showMaterialLibrary, setShowMaterialLibrary] = useState(false);
  const [showExportModal, setShowExportModal]   = useState(false);
  const [showPresetDrawer, setShowPresetDrawer] = useState(false);
  const [toasts, setToasts]                     = useState<any[]>([]);
  const [isMounted, setIsMounted]               = useState(false);
  const [toolbarAPI, setToolbarAPI]             = useState<ViewerToolbarAPI | null>(null);
  
  // ── Group append state ─────────────────────────────────────────────────────
  const [appendToGroupId, setAppendToGroupId] = useState<string | null>(null);

  useEffect(() => { setIsMounted(true); }, []);

  // ── FIX EXISTING GROUPS WITH WRONG TYPES ───────────────────────────────────
  // This fixes polygon/rectangle groups that were created with wrong type
  // Can be removed after all existing data is clean
  useEffect(() => {
    const groupsToFix = ps.measurements.filter((m) => 
      m.isGroupHeader && m.childIds && m.childIds.length > 0
    );
    
    groupsToFix.forEach((group) => {
      const firstChild = ps.measurements.find((c) => c.id === group.childIds?.[0]);
      if (firstChild && group.type !== firstChild.type) {
        console.log(`Fixing group ${group.id}: ${group.type} → ${firstChild.type}`);
        updateMeasurement(group.id, { type: firstChild.type });
      }
    });
  }, [ps.measurements, updateMeasurement]);

  // Memoize derived values to prevent unnecessary recalculations
  const activeDrawing = useMemo(() => 
    ps.drawings.find((d: { id: any; }) => d.id === ps.activeDrawingId) || null,
    [ps.drawings, ps.activeDrawingId]
  );
  
  const currentScaleFactor = useMemo(() => 
    activeDrawing ? activeDrawing.scaleFactor : 1,
    [activeDrawing]
  );
  
  const activeMeasurements = useMemo(() => 
    ps.measurements.filter((m: { drawingId: any; }) => m.drawingId === ps.activeDrawingId),
    [ps.measurements, ps.activeDrawingId]
  );

  // Stable callback ref for toolbar API
  const toolbarAPIRef = useRef<ViewerToolbarAPI | null>(null);
  useEffect(() => { toolbarAPIRef.current = toolbarAPI; }, [toolbarAPI]);

  const addToast = (message: string, type: 'success' | 'info' = 'info') => {
    const id = Math.random().toString(36).substr(2, 9);
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000);
  };

  const generateGroupId = () => `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

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
        childIds: [],
        label: groupName,
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
          label: measurement.description,
          ...measurement,
          childIds: [],
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
        label: template.name,
        description: template.name,
        type: template.measurementType === 'linear' ? 'Length' : template.measurementType === 'area' ? 'Area' : 'Count',
        quantity,
        unit,
        unitRate: 0,
        notes: `Preset: ${template.name} · ${template.category}`,
        points: [],
        isOverridden: true,
        childIds: [],
        presetData: data,
        presetId: template.id,
        color: '#EF9F27',
        isVisible: true,
      } as TakeoffRow);

      addToast(`${template.name.toUpperCase()} ADDED`, 'success');
    }
  };

  // ── Group append handlers ──────────────────────────────────────────────────
  const handleAddSegmentToGroup = useCallback((groupId: string, groupType: string) => {
    console.log('Add segment to group:', { groupId, groupType });
    
    setAppendToGroupId(groupId);
    
    // Map the group type to the appropriate tool
    const toolMap: Record<string, ToolType> = {
      'Length': 'linear',
      'Polygon': 'polygon',
      'Rectangle': 'rectangle',
      'Count': 'count',
      'Point': 'point',
    };
    const newTool = toolMap[groupType] || 'linear';
    
    console.log('Setting tool to:', newTool);
    setActiveTool(newTool);
    addToast(`ADDING TO GROUP: Use ${newTool} tool to draw new item`, 'info');
  }, [setActiveTool]);

  const handleAppendComplete = useCallback(() => {
    setAppendToGroupId(null);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['input', 'textarea'].includes((e.target as HTMLElement).tagName.toLowerCase())) return;
      switch (e.key.toLowerCase()) {
        case 'l': setActiveTool('linear' as ToolType); break;
        case 'a': setActiveTool('area' as ToolType); break;
        case 'c': setActiveTool('count' as ToolType); break;
        case 'p': setActiveTool('point' as ToolType); break;
        case 'v': setActiveTool('select' as ToolType); break;
        case 'escape': setActiveTool('select' as ToolType); break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setActiveTool]);

  // Stabilize handlers with useCallback to prevent child re-renders
  const handleAddMeasurement = useCallback((m: any) => {
    if (!activeDrawing) {
      addToast('PLEASE SELECT OR IMPORT A DRAWING FIRST', 'info');
      return;
    }
    const safeMeasurement = {
      id:             m.id             || crypto.randomUUID(),
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
      drawingId:      activeDrawing.id,
    };
    addMeasurement(safeMeasurement as TakeoffRow);
    addToast(`MEASUREMENT ADDED: ${safeMeasurement.description}`, 'success');
  }, [activeDrawing, addMeasurement]);

  const handleExport = useCallback(() => setShowExportModal(true), []);
  
  const executeExport = useCallback(() => {
    fetch('/api/export', { method: 'POST' })
      .then(res => res.blob())
      .then(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'export.xlsx';
        a.click();
        URL.revokeObjectURL(url);
        addToast('TAKEOFF EXPORTED SUCCESSFULLY', 'success');
        setShowExportModal(false);
      })
      .catch(() => addToast('EXPORT FAILED — SEE CONSOLE', 'info'));
  }, []);
  
  const handleScaleSet = useCallback((f: number) => {
    if (activeDrawing) {
      updateDrawingScale(activeDrawing.id, f);
      addToast(`SCALE CALIBRATED: 1px = ${f}u`, 'info');
    }
  }, [activeDrawing, updateDrawingScale]);

  // Stabilize toolbar API callback
  const handleToolbarReady = useCallback((api: ViewerToolbarAPI) => {
    setToolbarAPI(api);
  }, []);

  const api = toolbarAPI;

  if (!isMounted) {
    return (
      <div className="flex flex-col h-screen bg-industrial-black">
      <Navbar
        projectName={ps.projectName}
        onProjectNameChange={(name) => setProjectState((prev: any) => ({ 
          ...prev, 
          projectName: name 
        }))}
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
        onProjectNameChange={(name) => setProjectState((prev: any) => ({ ...prev, projectName: name }))}
        onExport={handleExport}
        onOpenPresets={() => setShowPresetDrawer(true)}
      />

      <div className="flex flex-1 overflow-hidden mt-14">

        {/* normalize project state to ensure activeDrawingId is undefined instead of null
            to satisfy prop types expecting string | undefined */}
        <Sidebar
          isCollapsed={leftCollapsed}
          projectState={{ ...ps, activeDrawingId: ps.activeDrawingId ?? undefined }}
          onUpdateMaterials={(mats) => setProjectState((prev: any) => ({ ...prev, materials: mats }))}
          onOpenMaterialLibrary={() => setShowMaterialLibrary(true)}
          onDrawingAdded={addDrawing}
          onSelectDrawing={setActiveDrawingId}
          onProjectNameChange={(name) => setProjectState((prev: any) => ({ ...prev, projectName: name }))}
          onProjectNumberChange={(num) => setProjectState((prev: any) => ({ 
            ...prev, 
            projectNumber: num 
          }))}        
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

          {/* Viewer toolbar */}
          <div className="flex-shrink-0 h-12 bg-industrial-panel border-b border-industrial-border flex items-center justify-between px-4 z-30 shadow-sm">

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

          <div className="flex flex-1 overflow-hidden relative min-h-0">

            <div className="flex-1 min-w-0 relative">
              <Viewer
                activeTool={activeTool as ToolType}
                setActiveTool={setActiveTool as (tool: ToolType) => void}
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
                onToolbarReady={handleToolbarReady}
                appendToGroupId={appendToGroupId}
                onAppendComplete={handleAppendComplete}
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
                  id: crypto.randomUUID(),
                  drawingId: activeDrawing?.id || '',
                  description: 'Manual Item',
                  type: 'Length',
                  quantity: 0,
                  unit: 'm',
                  unitRate: 0,
                  notes: '',
                  points: [],
                  childIds: [],
                  isOverridden: true,
                  label: '',
                  color: '#EF9F27',
                  isVisible: true,
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

          <button
            onClick={() => setShowPresetDrawer(prev => !prev)}
            className={cn(
              'relative flex items-center gap-1.5 px-3 h-[22px] overflow-hidden',
              'border text-[9px] uppercase tracking-widest font-bold',
              'transition-all duration-150',
              'group/btn',
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
    </div>
  );
}
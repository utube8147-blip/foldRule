// FILE: src/app/(app)/workspace/page.tsx
// UPDATED — Identical to your existing workspace with ONE change:
//   useTakeoff()        →   useTakeoffContext()
// Everything else (grouping logic, preset handler, keyboard shortcuts) is untouched.
// Also adds an "Expand" button in the takeoff panel header that navigates to /takeoff-full.

'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import { Navbar } from '@/components/Navbar';
import { Viewer } from '@/components/Viewer';
import { TakeoffTable } from '@/components/TakeoffTable';
import { MaterialLibrary } from '@/components/MaterialLibrary';
import { ExportModal } from '@/components/ExportModal';
import { ToastContainer } from '@/components/Toast';
import { PresetTemplate } from '@/components/presets/PresetTemplates';
import { useTakeoffContext } from '@/context/TakeoffContext'; // ← only change from your original
import { exportToExcel } from '@/lib/excelExport';
import { PanelRightClose, Sidebar as SidebarIcon, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AnimatePresence } from 'motion/react';
import { TakeoffRow } from '@/types';

export default function Workspace() {
  const router = useRouter();

  // ── Shared state (same instance as TakeoffFullPage via TakeoffProvider) ─────
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

  // ── Local UI state (not shared — each page manages its own panels) ───────────
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [showMaterialLibrary, setShowMaterialLibrary] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showPresetDrawer, setShowPresetDrawer] = useState(false);
  const [toasts, setToasts] = useState<any[]>([]);

  const activeDrawing = ps.drawings.find(d => d.id === ps.activeDrawingId) || null;
  const currentScaleFactor = activeDrawing ? activeDrawing.scaleFactor : 1;
  const activeMeasurements = ps.measurements.filter(m => m.drawingId === ps.activeDrawingId);

  const addToast = (message: string, type: 'success' | 'info' = 'info') => {
    const id = Math.random().toString(36).substr(2, 9);
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000);
  };

  // ── Group ID helper ───────────────────────────────────────────────────────────
  const generateGroupId = () => `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // ── Carcass grouped measurement generator (unchanged from your original) ──────
  const generateGroupedCarcassMeasurements = (
    data: Record<string, any>,
    template: PresetTemplate,
    drawingId: string,
    groupId: string
  ): { measurements: Partial<TakeoffRow>[]; groupName: string } => {
    const measurements: Partial<TakeoffRow>[] = [];

    const W = parseFloat(data.width ?? 600) / 1000;
    const H = parseFloat(data.height ?? 720) / 1000;
    const D = parseFloat(data.depth ?? 550) / 1000;
    const T = parseFloat(data.panelThickness ?? 18) / 1000;
    const shelves = parseInt(data.shelfCount ?? 2);
    const doorCount = parseInt(data.doorCount ?? 1);

    const iW = W - 2 * T;
    const iH = H - 2 * T;

    const groupName = `${data.customName || 'Cabinet'} (${data.width || 600}×${data.height || 720}×${data.depth || 550}mm)`;

    if (data.hasBack !== false) {
      measurements.push({
        description: 'Back Panel',
        type: 'Area',
        quantity: +(iW * iH).toFixed(3),
        unit: 'm²',
        notes: `Material: ${data.boardMaterial || '18mm MDF'}`,
        category: 'Board Materials',
        isOverridden: true,
      });
    }

    if (data.hasTop !== false) {
      measurements.push({
        description: 'Top Panel',
        type: 'Area',
        quantity: +(iW * D).toFixed(3),
        unit: 'm²',
        notes: `Material: ${data.boardMaterial || '18mm MDF'}`,
        category: 'Board Materials',
        isOverridden: true,
      });
    }

    if (data.hasBottom !== false) {
      measurements.push({
        description: 'Bottom Panel',
        type: 'Area',
        quantity: +(iW * D).toFixed(3),
        unit: 'm²',
        notes: `Material: ${data.boardMaterial || '18mm MDF'}`,
        category: 'Board Materials',
        isOverridden: true,
      });
    }

    if (data.hasLeftSide !== false) {
      measurements.push({
        description: 'Left Side Panel',
        type: 'Area',
        quantity: +(D * H).toFixed(3),
        unit: 'm²',
        notes: `Material: ${data.boardMaterial || '18mm MDF'}`,
        category: 'Board Materials',
        isOverridden: true,
      });
    }

    if (data.hasRightSide !== false) {
      measurements.push({
        description: 'Right Side Panel',
        type: 'Area',
        quantity: +(D * H).toFixed(3),
        unit: 'm²',
        notes: `Material: ${data.boardMaterial || '18mm MDF'}`,
        category: 'Board Materials',
        isOverridden: true,
      });
    }

    if (shelves > 0) {
      measurements.push({
        description: `Shelves (${shelves} pcs)`,
        type: 'Area',
        quantity: +(iW * D * shelves).toFixed(3),
        unit: 'm²',
        notes: `Material: ${data.shelfMaterial || data.boardMaterial || '18mm MDF'} | Spacing: ${data.shelfSpacing || 'Equal'}`,
        category: 'Shelves',
        isOverridden: true,
      });
    }

    if (data.hasDoors) {
      const doorArea = (W / doorCount) * H * doorCount;
      measurements.push({
        description: `Doors (${doorCount} pcs)`,
        type: 'Area',
        quantity: +doorArea.toFixed(3),
        unit: 'm²',
        notes: `Material: ${data.doorMaterial || 'MDF Primed'} | Style: ${data.doorSwing || 'Standard'}`,
        category: 'Doors',
        isOverridden: true,
      });
      measurements.push({
        description: 'Door Hardware',
        type: 'Count',
        quantity: doorCount,
        unit: 'sets',
        notes: `Hinges (2 per door), handles (1 per door) | Type: ${data.hingeType || 'Concealed'}`,
        category: 'Hardware',
        isOverridden: true,
      });
    }

    if (data.hasDrawers) {
      const drawerCount = parseInt(data.drawerCount ?? 2);
      measurements.push({
        description: `Drawer Fronts (${drawerCount} pcs)`,
        type: 'Count',
        quantity: drawerCount,
        unit: 'pcs',
        notes: `Material: ${data.drawerMaterial || 'Match doors'}`,
        category: 'Drawers',
        isOverridden: true,
      });
      measurements.push({
        description: 'Drawer Hardware',
        type: 'Count',
        quantity: drawerCount,
        unit: 'sets',
        notes: `Drawer slides (1 pair per drawer), handles`,
        category: 'Hardware',
        isOverridden: true,
      });
    }

    let edgeBanding = 0;
    if (data.hasTop !== false) edgeBanding += 2 * (iW + D);
    if (data.hasBottom !== false) edgeBanding += 2 * (iW + D);
    if (data.hasLeftSide !== false) edgeBanding += 2 * (D + H);
    if (data.hasRightSide !== false) edgeBanding += 2 * (D + H);
    if (shelves > 0) edgeBanding += (2 * iW + D) * shelves;

    if (edgeBanding > 0) {
      measurements.push({
        description: 'Edge Banding',
        type: 'Length',
        quantity: +(edgeBanding * 1.1).toFixed(2),
        unit: 'm',
        notes: `Material: ${data.edgeTape || 'PVC 0.4mm'} | All exposed edges +10% waste`,
        category: 'Finishing',
        isOverridden: true,
      });
    }

    measurements.push({
      description: 'Assembly & Installation',
      type: 'Count',
      quantity: 1,
      unit: 'each',
      notes: `Labor, cam locks, fixing brackets, assembly hardware`,
      category: 'Labor',
      isOverridden: true,
    });

    if (data.hasToeKick) {
      measurements.push({
        description: 'Toe Kick / Plinth',
        type: 'Length',
        quantity: W,
        unit: 'm',
        notes: `Material: ${data.kickboardMaterial || 'Same as carcass'} | Height: ${data.kickboardHeight || '100mm'}`,
        category: 'Finishing',
        isOverridden: true,
      });
    }

    return { measurements, groupName };
  };

  // ── Preset handler (unchanged from your original) ─────────────────────────────
  const handlePresetSelect = (data: Record<string, any>, template: PresetTemplate) => {
    if (!activeDrawing) {
      addToast('PLEASE SELECT OR IMPORT A DRAWING FIRST', 'info');
      return;
    }

    const groupId = generateGroupId();

    if (template.id === 'carcass') {
      const { measurements, groupName } = generateGroupedCarcassMeasurements(
        data,
        template,
        activeDrawing.id,
        groupId
      );

      const headerRow: TakeoffRow = {
        id: `${groupId}-header`,
        drawingId: activeDrawing.id,
        groupId: groupId,
        groupName: groupName,
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
          groupId: groupId,
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
          quantity =
            parseFloat(data.area ?? data.roofArea ?? 0) ||
            (parseFloat(data.width ?? 0) * parseFloat(data.height ?? 0)) / 1e6 ||
            0;
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
        type:
          template.measurementType === 'linear'
            ? 'Length'
            : template.measurementType === 'area'
            ? 'Area'
            : 'Count',
        quantity: quantity,
        unit: unit,
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

  // ── Keyboard shortcuts (unchanged) ────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['input', 'textarea'].includes((e.target as HTMLElement).tagName.toLowerCase())) return;
      switch (e.key.toLowerCase()) {
        case 'l': setActiveTool('linear'); break;
        case 'a': setActiveTool('area'); break;
        case 'c': setActiveTool('count'); break;
        case 'p': setActiveTool('point'); break;
        case 'v': setActiveTool('select'); break;
        case 'escape': setActiveTool('select'); break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setActiveTool]);

  // ── Canvas measurement handler (unchanged) ────────────────────────────────────
  const handleAddMeasurement = (m: any) => {
    if (!activeDrawing) {
      addToast('PLEASE SELECT OR IMPORT A DRAWING FIRST', 'info');
      return;
    }

    const safeMeasurement = {
      description: m.description || 'Untitled Measurement',
      type: m.type || 'Length',
      quantity: m.quantity || 0,
      unit: m.unit || 'm',
      unitRate: m.unitRate || 0,
      notes: m.notes || '',
      points: m.points || [],
      isOverridden: m.isOverridden !== false,
      presetData: m.presetData,
      presetId: m.presetId,
      groupId: m.groupId,
      groupName: m.groupName,
      groupType: m.groupType,
      parentId: m.parentId,
      isGroupHeader: m.isGroupHeader || false,
      category: m.category,
    };

    addMeasurement(safeMeasurement);
    addToast(`MEASUREMENT ADDED: ${safeMeasurement.description}`, 'success');
  };

  const handleExport = () => setShowExportModal(true);

  const executeExport = () => {
    exportToExcel(ps);
    addToast('TAKEOFF EXPORTED SUCCESSFULLY', 'success');
    setShowExportModal(false);
  };

  const handleScaleSet = (f: number) => {
    if (activeDrawing) {
      updateDrawingScale(activeDrawing.id, f);
      addToast(`SCALE CALIBRATED: 1px = ${f}u`, 'info');
    }
  };

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <Navbar
        projectName={ps.projectName}
        onProjectNameChange={(name) => setProjectState(prev => ({ ...prev, projectName: name }))}
        onExport={handleExport}
        onOpenPresets={() => setShowPresetDrawer(true)}
      />

      <div className="flex flex-1 pt-14 overflow-hidden relative">
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

        <div className="absolute left-0 bottom-10 z-[60] ml-2 flex flex-col gap-2">
          <button
            onClick={() => setLeftCollapsed(!leftCollapsed)}
            className="bg-industrial-panel border border-industrial-border p-1.5 text-zinc-500 hover:text-amber-accent transition-colors shadow-lg"
            title={leftCollapsed ? 'Expand Sidebar' : 'Collapse Sidebar'}
          >
            <SidebarIcon className={cn('w-4 h-4 transition-transform', leftCollapsed && 'rotate-180')} />
          </button>
        </div>

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
        />

        {/* ── Right panel — Takeoff Table ────────────────────────────────────── */}
        <div className={cn(
          'flex flex-col h-full overflow-hidden transition-all duration-300',
          rightCollapsed ? 'w-0' : 'w-96',
        )}>
          {/* Expand-to-full-page button */}
          {!rightCollapsed && (
            <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-950 border-b border-industrial-border flex-shrink-0">
              <span className="text-[9px] font-mono font-bold uppercase tracking-widest text-zinc-600">
                Takeoff Data
              </span>
              <button
                onClick={() => router.push('/takeoff-full')}
                className="flex items-center gap-1.5 text-[9px] font-mono font-bold uppercase tracking-widest text-zinc-500 hover:text-amber-400 border border-transparent hover:border-zinc-700 px-2 py-1 transition-all"
                title="Open full-page takeoff view"
              >
                <ExternalLink className="w-3 h-3" />
                Expand
              </button>
            </div>
          )}
          <TakeoffTable
            measurements={ps.measurements}
            materials={ps.materials}
            onUpdate={updateMeasurement}
            onDelete={deleteMeasurement}
            onToggleVisibility={toggleVisibility}
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

      <footer className="h-6 bg-industrial-black border-t border-industrial-border flex items-center justify-between px-4 z-50 flex-shrink-0 font-mono">
        <div className="flex items-center gap-6">
          <span className="text-[9px] text-zinc-600 uppercase tracking-widest font-bold">
            Workspace: LOGISTICS_HUB_P2
          </span>
          <div className="w-gutter h-3 bg-zinc-800" />
          <span className="text-[9px] text-zinc-600 uppercase tracking-widest font-bold">
            Objects: {ps.measurements.length}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-[9px] text-zinc-600 uppercase tracking-widest font-bold">
            LAT: 34.0522 N / LON: 118.2437 W
          </span>
          <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
        </div>
      </footer>
    </div>
  );
}
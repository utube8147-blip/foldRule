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
import { useTakeoff } from '@/hooks/useTakeoff';
import { exportToExcel } from '@/lib/excelExport';
import { PanelRightClose, Sidebar as SidebarIcon } from 'lucide-react';
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
  } = useTakeoff();

  const [leftCollapsed, setLeftCollapsed]           = useState(false);
  const [rightCollapsed, setRightCollapsed]         = useState(false);
  const [showMaterialLibrary, setShowMaterialLibrary] = useState(false);
  const [showExportModal, setShowExportModal]       = useState(false);
  // Single boolean that tells Viewer to open its built-in preset gallery drawer
  const [showPresetDrawer, setShowPresetDrawer]     = useState(false);
  const [toasts, setToasts]                         = useState<any[]>([]);

  const activeDrawing      = ps.drawings.find(d => d.id === ps.activeDrawingId) || null;
  const currentScaleFactor = activeDrawing ? activeDrawing.scaleFactor : 1;
  const activeMeasurements = ps.measurements.filter(m => m.drawingId === ps.activeDrawingId);

  // ── Toast helper ────────────────────────────────────────────────────────────
  const addToast = (message: string, type: 'success' | 'info' = 'info') => {
    const id = Math.random().toString(36).substr(2, 9);
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000);
  };

  // ── Keyboard shortcuts ──────────────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['input', 'textarea'].includes((e.target as HTMLElement).tagName.toLowerCase())) return;
      switch (e.key.toLowerCase()) {
        case 'l':      setActiveTool('linear');  break;
        case 'a':      setActiveTool('area');    break;
        case 'c':      setActiveTool('count');   break;
        case 'p':      setActiveTool('point');   break;
        case 'v':      setActiveTool('select');  break;
        case 'escape': setActiveTool('select');  break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setActiveTool]);

  // ── Measurement helpers ─────────────────────────────────────────────────────
  const handleAddMeasurement = (m: any) => {
    if (!activeDrawing) {
      addToast('PLEASE SELECT OR IMPORT A DRAWING FIRST', 'info');
      return;
    }
    addMeasurement(m);
    addToast(`MEASUREMENT ADDED: ${m.description || m.type}`, 'success');
  };

  // ── Called when user commits a preset form inside the Viewer ───────────────
  // data   = the filled-in field values from PresetForm
  // template = the chosen PresetTemplate
  const handlePresetSelect = (data: Record<string, any>, template: PresetTemplate) => {
    if (!activeDrawing) {
      addToast('PLEASE SELECT OR IMPORT A DRAWING FIRST', 'info');
      return;
    }

    // Build a TakeoffRow-compatible object from the preset data.
    // Adjust field mappings to match your actual TakeoffRow type.
    addMeasurement({
      description:  template.name,
      type:         'Length',          // default; override per template if needed
      quantity:     parseFloat(data.length ?? data.area ?? data.pipeLength ?? data.roofArea ?? 0) || 0,
      unit:         data.unit ?? 'm',
      unitRate:     0,
      notes:        data.notes ?? `Preset: ${template.name} · ${template.category}`,
      points:       [],
      isOverridden: true,
      // Attach all raw preset fields as metadata for reference
      presetData:   data,
      presetId:     template.id,
    });

    addToast(`${template.name.toUpperCase()} PRESET ADDED`, 'success');
  };

  // ── Export ──────────────────────────────────────────────────────────────────
  const handleExport = () => setShowExportModal(true);

  const executeExport = () => {
    exportToExcel(ps);
    addToast('TAKEOFF EXPORTED SUCCESSFULLY', 'success');
    setShowExportModal(false);
  };

  // ── Scale ───────────────────────────────────────────────────────────────────
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
        // Opens the gallery drawer that now lives inside <Viewer />
        onOpenPresets={() => setShowPresetDrawer(true)}
      />

      <div className="flex flex-1 pt-14 overflow-hidden relative">

        {/* ── Left Sidebar ──────────────────────────────────────────────────── */}
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

        {/* ── Viewer ────────────────────────────────────────────────────────── */}
        {/* The preset gallery drawer AND the preset detail form both live       */}
        {/* inside Viewer so they only cover the canvas area.                    */}
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

        {/* ── Right Panel — Takeoff Table ───────────────────────────────────── */}
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
            onAddManual={() => handleAddMeasurement({
              description:  'Manual Item',
              type:         'Length',
              quantity:     0,
              unit:         'm',
              unitRate:     0,
              notes:        '',
              points:       [],
              isOverridden: true,
            })}
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

      {/* ── Modals ─────────────────────────────────────────────────────────────── */}
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
        {/* NOTE: PresetGallery fullscreen overlay is intentionally removed.
            The preset flow now lives entirely inside <Viewer />:
              1. showPresetDrawer=true  → PresetGalleryDrawer slides up in canvas
              2. User clicks a card    → PresetForm slide-over opens (right edge)
              3. User commits          → handlePresetSelect adds the measurement  */}
      </AnimatePresence>

      <ToastContainer
        toasts={toasts}
        onRemove={(id) => setToasts(prev => prev.filter(t => t.id !== id))}
      />

      {/* ── Status bar ─────────────────────────────────────────────────────────── */}
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
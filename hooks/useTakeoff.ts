// hooks/useTakeoff.ts
import { useState, useCallback } from 'react';
import { TakeoffRow, ToolType, Drawing } from '../types';

type ProjectState = {
  projectName: string;
  projectNumber: string;
  unit: string;
  drawings: Drawing[];
  activeDrawingId: string | null;
  measurements: TakeoffRow[];
  materials: Array<{
    id: string;
    division: string;
    code: string;
    name: string;
    unit: string;
    materialCost: number;
    laborCost: number;
    equipmentCost: number;
  }>;
};

const PALETTE = [
  '#F59E0B', // Amber
  '#3B82F6', // Blue
  '#10B981', // Emerald
  '#EF4444', // Red
  '#8B5CF6', // Purple
  '#EC4899', // Pink
  '#06B6D4', // Cyan
  '#F97316', // Orange
];

export function useTakeoff() {
  const [projectState, setProjectState] = useState<ProjectState>({
    projectName: 'PROJECT_ALPHA',
    projectNumber: 'EST-2024-001',
    unit: 'm',
    drawings: [],
    activeDrawingId: null,
    measurements: [],
    materials: [
      { id: '1', division: '03', code: '03 30 00.1', name: 'CONC READY-MIX 4000 PSI HIGH EARLY', unit: 'M3', materialCost: 145.00, laborCost: 65.50, equipmentCost: 12.00 },
      { id: '2', division: '03', code: '03 21 00.A', name: 'REINFORCING STEEL - GRADE 60', unit: 'TON', materialCost: 980.00, laborCost: 1250.00, equipmentCost: 450.00 },
      { id: '3', division: '03', code: '03 11 00.B', name: 'WALL FORMWORK - PLYWOOD SYSTEM', unit: 'M2', materialCost: 12.40, laborCost: 38.20, equipmentCost: 4.10 },
      { id: '4', division: '03', code: '03 35 00.5', name: 'CONCRETE FINISHING - EXPOSED AGG', unit: 'M2', materialCost: 4.50, laborCost: 18.90, equipmentCost: 2.00 },
      { id: '5', division: '03', code: '03 05 00.X', name: 'CONCRETE CURING COMPOUND', unit: 'LTR', materialCost: 0.85, laborCost: 1.20, equipmentCost: 0.00 },
      { id: '6', division: '04', code: '04 22 00.1', name: 'CONCRETE MASONRY UNITS 8X8X16', unit: 'EA', materialCost: 1.80, laborCost: 4.50, equipmentCost: 0.20 },
      { id: '7', division: '05', code: '05 12 00.A', name: 'STRUCTURAL STEEL W-SHAPES', unit: 'TON', materialCost: 1200.00, laborCost: 800.00, equipmentCost: 350.00 },
      { id: '8', division: '06', code: '06 11 00.1', name: 'DIMENSIONAL LUMBER 2X4', unit: 'LF', materialCost: 0.60, laborCost: 1.10, equipmentCost: 0.05 },
      { id: '9', division: '07', code: '07 21 00.A', name: 'BATT INSULATION R-19', unit: 'M2', materialCost: 4.20, laborCost: 2.50, equipmentCost: 0.00 },
    ]
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<ToolType>('select');

  const addDrawing = useCallback((name: string, fileUrl: string, file?: File) => {
    const newDrawing: Drawing = {
      id: crypto.randomUUID(),
      name,
      fileUrl,
      file,
      scaleFactor: 1,
      pageCount: 1
    };
    setProjectState(prev => ({
      ...prev,
      drawings: [...prev.drawings, newDrawing],
      activeDrawingId: prev.activeDrawingId || newDrawing.id
    }));
  }, []);

  const setActiveDrawingId = useCallback((id: string) => {
    setProjectState(prev => ({ ...prev, activeDrawingId: id }));
  }, []);

  const updateDrawingScale = useCallback((id: string, scaleFactor: number) => {
    setProjectState(prev => ({
      ...prev,
      drawings: prev.drawings.map(d => d.id === id ? { ...d, scaleFactor } : d)
    }));
  }, []);

  // FIXED: Add safety checks for activeDrawingId
  const addMeasurement = useCallback((measurement: Omit<TakeoffRow, 'id' | 'color' | 'isVisible' | 'drawingId'>) => {
    setProjectState(prev => {
      // Check if there's an active drawing
      if (!prev.activeDrawingId) {
        console.warn('Cannot add measurement: No active drawing selected');
        return prev;
      }
      
      // Count measurements for this drawing only
      const activeMeasurements = prev.measurements.filter(m => m.drawingId === prev.activeDrawingId);
      const nextColor = PALETTE[activeMeasurements.length % PALETTE.length];
      
      const newMeasurement: TakeoffRow = {
        ...measurement,
        id: crypto.randomUUID(),
        drawingId: prev.activeDrawingId,
        color: nextColor,
        isVisible: true,
        // Ensure these fields exist with defaults
        points: measurement.points || [],
        notes: measurement.notes || '',
        unitRate: measurement.unitRate || 0,
        quantity: measurement.quantity || 0,
      };
      
      return {
        ...prev,
        measurements: [...prev.measurements, newMeasurement],
      };
    });
  }, []);

  const updateMeasurement = useCallback((id: string, updates: Partial<TakeoffRow>) => {
    setProjectState(prev => ({
      ...prev,
      measurements: prev.measurements.map(m => (m.id === id ? { ...m, ...updates } : m)),
    }));
  }, []);

  const deleteMeasurement = useCallback((id: string) => {
    setProjectState(prev => ({
      ...prev,
      measurements: prev.measurements.filter(m => m.id !== id),
    }));
    if (selectedId === id) setSelectedId(null);
  }, [selectedId]);

  const toggleVisibility = useCallback((id?: string) => {
    setProjectState(prev => {
      if (id) {
        return {
          ...prev,
          measurements: prev.measurements.map(m => 
            m.id === id ? { ...m, isVisible: !m.isVisible } : m
          )
        };
      } else {
        // Safe check: if no measurements, default to true
        const allVisible = prev.measurements.length === 0 || prev.measurements.every(m => m.isVisible);
        return {
          ...prev,
          measurements: prev.measurements.map(m => ({ ...m, isVisible: !allVisible }))
        };
      }
    });
  }, []);

  const clearAll = useCallback(() => {
    setProjectState(prev => ({ ...prev, measurements: [] }));
    setSelectedId(null);
  }, []);

  return {
    projectState,
    setProjectState,
    selectedId,
    setSelectedId,
    activeTool,
    setActiveTool,
    addDrawing,
    setActiveDrawingId,
    updateDrawingScale,
    addMeasurement,
    updateMeasurement,
    deleteMeasurement,
    toggleVisibility,
    clearAll,
    measurements: projectState.measurements,
    materials: projectState.materials
  };
}

// ─── Shared Types ──────────────────────────────────────────────────────────────

export interface PresetTemplate {
  id: string;
  name: string;
  category: string;
  description: string;
  measurementType: 'linear' | 'area' | 'count' | 'point';
  fields: {
    key: string;
    label: string;
    type: 'text' | 'number' | 'select' | 'boolean';
    default?: any;
    options?: string[];
    unit?: string;
    placeholder?: string;
    required?: boolean;
    fullWidth?: boolean;
    hint?: string;
  }[];
}

export interface PresetFormComponentProps {
  formData: Record<string, any>;
  onChange: (key: string, value: any) => void;
  template: PresetTemplate;
}

export interface TakeoffItem {
  id: string;
  presetId: string;
  presetName: string;
  label: string;
  formData: Record<string, any>;
  quantities: Record<string, { value: number | string; unit: string }>;
  addedAt: number;
}

export interface ThreeDViewerProps {
  presetId: string;
  formData: Record<string, any>;
}

export const ELEMENT_PRESETS: PresetTemplate[] = [
  { id: 'carcass',    name: 'Carcass',    category: 'Structure', measurementType: 'area',   description: 'Cabinet / joinery unit — kitchen, wardrobe, shelving', fields: [] },
  { id: 'stud-wall',  name: 'Stud Wall',  category: 'Walls',     measurementType: 'linear', description: 'Timber or metal stud internal wall partition',         fields: [] },
  { id: 'floor-slab', name: 'Floor Slab', category: 'Structure', measurementType: 'area',   description: 'Concrete floor slabs and screeds',                     fields: [] },
  { id: 'roof',       name: 'Roof',       category: 'Envelope',  measurementType: 'area',   description: 'Pitched or flat roof structures and coverings',        fields: [] },
  { id: 'door',       name: 'Door',       category: 'Openings',  measurementType: 'count',  description: 'Door leaf, frame, architrave and hardware',            fields: [] },
  { id: 'window',     name: 'Window',     category: 'Openings',  measurementType: 'count',  description: 'Window frames, glazing and sills',                     fields: [] },
  { id: 'ceiling',    name: 'Ceiling',    category: 'Interior',  measurementType: 'area',   description: 'Plasterboard or suspended grid ceiling systems',       fields: [] },
  { id: 'staircase',  name: 'Staircase',  category: 'Structure', measurementType: 'count',  description: 'Timber, concrete or steel stair construction',         fields: [] },
  { id: 'beam',       name: 'Beam',       category: 'Structure', measurementType: 'linear', description: 'Structural beams, lintels and supports',              fields: [] },
  { id: 'column',     name: 'Column',     category: 'Structure', measurementType: 'count',  description: 'Structural columns and posts',                         fields: [] },
  { id: 'tiling',     name: 'Tiling',     category: 'Finishes',  measurementType: 'area',   description: 'Wall and floor tile installation',                     fields: [] },
  { id: 'plumbing',   name: 'Plumbing',   category: 'Services',  measurementType: 'linear', description: 'Water supply, waste and drainage pipe runs',           fields: [] },
];
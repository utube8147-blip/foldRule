// types/index.ts
export interface TakeoffRow {
  id: string;
  drawingId: string;
  
  // Grouping fields
  groupId?: string;
  groupName?: string;
  groupType?: string;
  parentId?: string;
  isGroupHeader?: boolean;
  isExpanded?: boolean;
  
  // Regular fields
  description: string;
  type: 'Length' | 'Area' | 'Count' | 'Volume' | 'Weight';
  quantity: number;
  unit: string;
  unitRate: number;
  notes: string;
  points?: any[];
  isOverridden: boolean;
  presetData?: any;
  presetId?: string;
  category?: string;
  color?: string;
  isVisible?: boolean;
}

export interface MaterialSpec {
  id: string;
  code: string;
  name: string;
  category: string;
  unit: string;
  materialCost: number;
  laborCost: number;
  equipmentCost: number;
  
}
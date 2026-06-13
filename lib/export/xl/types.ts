// types.ts
export interface BOQData {
  project_info: ProjectInfo;
  kitchen_sections?: KitchenSection[];
  sections?: KitchenSection[];
  installed_fixtures?: Fixture[];
  section_grouping?: Record<string, SectionGroup>;
  material_columns?: MaterialColumn[];
  calculation_rules?: CalculationRules;
  material_identification?: MaterialIdentification;
  additional_notes?: AdditionalNotes;
  drawings?: string[];
}

export interface ProjectInfo {
  name: string;
  location?: string;
  phase?: string;
  kitchen_type?: string;
  total_kitchen_units?: number;
  stakeholders?: {
    main_contractor?: string;
    design_consultant?: string;
    supervision?: string;
  };
  document_metadata?: {
    title?: string;
    date?: string;
    revision?: string;
    currency?: string;
    vat_percent?: number;
  };
}

export interface KitchenSection {
  section_id: string;
  notes?: string;
  components?: Component[];
  items?: Component[];
}

export interface Component {
  component_name?: string;
  name?: string;
  dimensions?: DimensionSet;
  items?: MatrixItem[];
}

export interface DimensionSet {
  L?: DimensionValue;
  W?: DimensionValue;
  H?: DimensionValue;
}

export interface DimensionValue {
  value: number;
  label?: string;
}

export interface MatrixItem {
  item_number: string;
  description: string;
  measurement_unit?: string;
  unit?: string;
  remarks?: string;
  panel_count?: number;
  material?: string;
  specification?: string;
  qty_formula?: string;
  shelf_length?: DimensionValue;
}

export interface Fixture {
  item_number: string;
  description: string;
  measurement_unit?: string;
  quantity_per_unit?: number;
  remarks?: string;
  unit_rate?: number;
}

export interface SectionGroup {
  elevation?: string;
  cabinet_type?: string;
  unit_type?: string;
}

export interface MaterialColumn {
  id?: string;
  key?: string;
  display_name?: string;
  label?: string;
  calculation_type?: string;
  column_width?: number;
  width?: number;
  remarks?: string;
  unit_rate?: number;
}

export interface CalculationRules {
  sheet_area_square_meters?: number;
  excel_formatting?: {
    bottom_padding_rows?: number;
    padding_bottom?: number;
    border_padding_cells?: boolean;
    freeze_panes?: string;
  };
  unit_type_mapping?: Record<string, string[]>;
  parametric_rules?: {
    auto_calculation_rules?: Record<string, unknown>;
  };
}

export interface MaterialIdentification {
  sheet_materials?: Array<{
    material_id: string;
    required_thickness?: string;
    material_type?: string;
    context_keywords?: string[];
  }>;
  additional_materials?: Array<{
    material_id: string;
    triggers_in_specification?: string[];
    triggers_in_description?: string[];
    size_filter?: string;
  }>;
  subsection_organization?: Array<{
    subsection_name: string;
    detection_keywords: string[];
    has_dimensions: boolean;
  }>;
  description_prefixes_to_remove?: string[];
}

export interface AdditionalNotes {
  general_assumptions?: Array<{ category: string; content: string }>;
  excluded_from_scope?: Array<{ item: string; reason: string }>;
}
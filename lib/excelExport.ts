// excelExport.ts  –  drawings fix: pass project_info.drawings to transformedDoc
import * as ExcelJS from 'exceljs';
import boq_data from './boq_data.json';
import {
  BOQData, ProjectInfo, KitchenSection, Component, MatrixItem,
  Fixture, MaterialColumn, CalculationRules,
} from './xl/types';
import {
  Colors, getColumnLetter, createFill, createFont, createAlignment,
  createBorder, createFullBorder, createThickBorder,
} from './xl/styles';
import { buildSummarySheet }      from './xl/sheet-summary';
import { buildBOQMatrixSheet, getDefaultUnitCategories, MAT_START } from './xl/sheet-boq-matrix';
import { buildMaterialsListSheet } from './xl/sheet-materials-list';
import { buildCostBreakdownSheet } from './xl/sheet-cost-breakdown';

// Add this function to sanitize the data
function sanitizeBOQData(data: any): BOQData {
  const result = JSON.parse(JSON.stringify(data));
  
  const processItem = (item: any) => {
    if (item.panel_count === null) {
      delete item.panel_count;
    }
    if (item.qty_per_unit === undefined && item.qty_formula) {
      item.qty_per_unit = 1;
    }
    // Ensure item_number is a string
    if (item.item_number !== undefined && typeof item.item_number !== 'string') {
      item.item_number = String(item.item_number);
    }
    // Ensure description exists
    if (!item.description) {
      item.description = 'N/A';
    }
    return item;
  };
  
  const processComponent = (comp: any) => {
    if (comp.items && Array.isArray(comp.items)) {
      comp.items = comp.items.map(processItem);
    }
    // Ensure component_name exists
    if (!comp.component_name && comp.name) {
      comp.component_name = comp.name;
    }
    if (!comp.component_name) {
      comp.component_name = 'Unnamed Component';
    }
    return comp;
  };
  
  const processSection = (section: any) => {
    if (section.components && Array.isArray(section.components)) {
      section.components = section.components.map(processComponent);
    }
    // Ensure section_id exists
    if (!section.section_id && section.id) {
      section.section_id = section.id;
    }
    if (!section.section_id) {
      section.section_id = 'UNKNOWN_SECTION';
    }
    return section;
  };
  
  if (result.sections) {
    result.sections = result.sections.map(processSection);
  }
  if (result.kitchen_sections) {
    result.kitchen_sections = result.kitchen_sections.map(processSection);
  }
  
  // Ensure project_info has required fields
  if (!result.project_info) {
    result.project_info = {};
  }
  if (!result.project_info.name) {
    result.project_info.name = 'UNKNOWN_PROJECT';
  }
  if (!result.project_info.document_metadata) {
    result.project_info.document_metadata = {};
  }
  if (!result.project_info.document_metadata.currency) {
    result.project_info.document_metadata.currency = 'AED';
  }
  if (result.project_info.document_metadata.vat_percent === undefined) {
    result.project_info.document_metadata.vat_percent = 5;
  }
  
  return result as BOQData;
}

function getMockBOQData(): BOQData {
  return sanitizeBOQData(boq_data);
}

// ExcelJS custom interface - not extending CalculationRules to avoid type conflicts
interface CalculationRulesExtended {
  unit_type_mapping?: Record<string, string[]>;
  excel_formatting?: Record<string, unknown>;
  sheet_area_square_meters?: number;
}

interface MaterialIdentification {
  sheet_materials?: Array<{
    material_id: string;
    required_thickness: number;
    material_type: string;
    context_keywords: string[];
  }>;
  additional_materials?: Array<{
    material_id: string;
    triggers_in_specification: string[];
    triggers_in_description: string[];
    size_filter?: string;
  }>;
  subsection_organization?: Array<{
    subsection_name: string;
    detection_keywords: string[];
    has_dimensions: boolean;
  }>;
  description_prefixes_to_remove?: string[];
}

interface TransformedMaterialRules {
  board_rules: Array<{
    key: string;
    thickness: number;
    material: string;
    context: string[];
  }>;
  addon_rules: Array<{
    key: string;
    trigger_spec: string[];
    trigger_desc: string[];
    size_filter?: string;
  }>;
  subgroup_keywords: Array<{
    label: string;
    keywords: string[];
    has_dims: boolean;
  }>;
  desc_strip_prefixes: string[];
}

interface TransformedProjectInfo extends ProjectInfo {
  drawings: string[];
  material_detection_rules: TransformedMaterialRules;
  additional_notes: Record<string, unknown>;
}

export async function buildWorkbook(data?: BOQData): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  const boqData  = data || getMockBOQData();

  const doc             = boqData.project_info;
  const rawSections     = boqData.kitchen_sections || (boqData as unknown as Record<string, unknown>).sections || [];
  const sections        = Array.isArray(rawSections) ? rawSections : [];
  const fixtures        = boqData.installed_fixtures || [];
  const sectionMap      = boqData.section_grouping || {};
  const materialColumns = boqData.material_columns || [];
  const calcRules       = boqData.calculation_rules as CalculationRulesExtended || {};
  const unitCategories  = calcRules.unit_type_mapping || getDefaultUnitCategories();
  const outputOptions   = calcRules.excel_formatting || {};
  const sheetAreaM2     = calcRules.sheet_area_square_meters || 2.88;

  const transformedMaterialColumns: MaterialColumn[] = materialColumns.map(col => {
    const colWithExt = col as MaterialColumn & Record<string, unknown>;
    const calcType = (colWithExt.calculation_type as string) || 'area_based';
    const colId    = (colWithExt.id as string) || (colWithExt.key as string) || '';
    const transformed: MaterialColumn = {
      key:              calcType === 'spacer' ? `_blank_${colId}` : colId,
      id:               colId,
      display_name:     (colWithExt.display_name as string) || (colWithExt.label as string) || '',
      label:            (colWithExt.display_name as string) || (colWithExt.label as string) || '',
      column_width:     ((colWithExt.column_width as number) || (colWithExt.width as number) || 14),
      width:            ((colWithExt.column_width as number) || (colWithExt.width as number) || 14),
      remarks:          (colWithExt.remarks as string) || '',
      unit_rate:        colWithExt.unit_rate as number | undefined,
      calculation_type: calcType,
    };
    return transformed;
  });

  const matId = (boqData as unknown as Record<string, unknown>).material_identification as MaterialIdentification || {};
  const transformedMatRules: TransformedMaterialRules = {
    board_rules: ((matId.sheet_materials || []) as Array<{
      material_id: string;
      required_thickness: number;
      material_type: string;
      context_keywords: string[];
    }>).map((rule) => ({
      key:       rule.material_id,
      thickness: rule.required_thickness,
      material:  rule.material_type,
      context:   rule.context_keywords,
    })),
    addon_rules: ((matId.additional_materials || []) as Array<{
      material_id: string;
      triggers_in_specification: string[];
      triggers_in_description: string[];
      size_filter?: string;
    }>).map((rule) => ({
      key:          rule.material_id,
      trigger_spec: rule.triggers_in_specification || [],
      trigger_desc: rule.triggers_in_description || [],
      size_filter:  rule.size_filter,
    })),
    subgroup_keywords: ((matId.subsection_organization || []) as Array<{
      subsection_name: string;
      detection_keywords: string[];
      has_dimensions: boolean;
    }>).map((rule) => ({
      label:    rule.subsection_name,
      keywords: rule.detection_keywords,
      has_dims: rule.has_dimensions,
    })),
    desc_strip_prefixes: matId.description_prefixes_to_remove || [],
  };

  // ── CRITICAL: resolve drawings from all possible JSON locations ───────────
  const docWithExt = doc as ProjectInfo & Record<string, unknown>;
  const boqDataExt = boqData as unknown as Record<string, unknown>;
  const docMetaExt = doc.document_metadata as Record<string, unknown> | undefined;

  const drawings: string[] =
    (Array.isArray(docWithExt.drawings) && (docWithExt.drawings as string[]).length > 0 ? docWithExt.drawings as string[] : null) ||
    (Array.isArray(boqDataExt.drawings) && (boqDataExt.drawings as string[]).length > 0 ? boqDataExt.drawings as string[] : null) ||
    (Array.isArray(docWithExt.drawing_references) && (docWithExt.drawing_references as string[]).length > 0 ? docWithExt.drawing_references as string[] : null) ||
    (docMetaExt && Array.isArray(docMetaExt.drawings) && (docMetaExt.drawings as string[]).length > 0 ? docMetaExt.drawings as string[] : null) ||
    [];

  const transformedDoc: TransformedProjectInfo = {
    ...doc,
    document_metadata: doc.document_metadata || {},
    material_detection_rules: transformedMatRules,
    additional_notes: (boqDataExt.additional_notes as Record<string, unknown>) || {},
    drawings,
  };

  // Validate required data before building sheets
  if (sections.length === 0) {
    console.warn('[v0] No sections found in BOQ data');
  }

  workbook.creator = 'BOQ Export System';
  workbook.created = new Date();

  try {
    await buildSummarySheet(workbook, transformedDoc, sections, sectionMap);
  } catch (error) {
    console.error('[v0] Error building summary sheet:', error);
    throw new Error(`Failed to build summary sheet: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  let gtRow = 10; // Default fallback row
  try {
    gtRow = await buildBOQMatrixSheet(
      workbook, transformedDoc, sections, fixtures, sectionMap,
      transformedMaterialColumns, sheetAreaM2, outputOptions, unitCategories,
    );
  } catch (error) {
    console.error('[v0] Error building BOQ matrix sheet:', error);
    throw new Error(`Failed to build BOQ matrix sheet: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  let matListStartRow = 5; // Default fallback row
  try {
    matListStartRow = await buildMaterialsListSheet(
      workbook, transformedDoc, transformedMaterialColumns, gtRow, sheetAreaM2, fixtures,
    );
  } catch (error) {
    console.error('[v0] Error building materials list sheet:', error);
    throw new Error(`Failed to build materials list sheet: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  try {
    await buildCostBreakdownSheet(
      workbook, transformedDoc, transformedMaterialColumns, matListStartRow, fixtures,
    );
  } catch (error) {
    console.error('[v0] Error building cost breakdown sheet:', error);
    throw new Error(`Failed to build cost breakdown sheet: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  return workbook;
}

export async function exportToExcel(data?: BOQData): Promise<void> {
  try {
    const workbook = await buildWorkbook(data);
    const boqData  = data || getMockBOQData();
    const doc      = boqData.project_info;

    const dateStr  = new Date().toISOString().split('T')[0];
    const projectName = (doc as ProjectInfo & Record<string, unknown>).name || 
                        (doc as ProjectInfo & Record<string, unknown>).project_name || 
                        'boq';
    const safeName = String(projectName)
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '');
    const filename = `BOQ_${safeName}_${dateStr}.xlsx`;

    const buffer = await workbook.xlsx.writeBuffer();
    const blob   = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const link      = document.createElement('a');
    link.href       = URL.createObjectURL(blob);
    link.download   = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  } catch (error) {
    console.error('[v0] Error exporting to Excel:', error);
    throw new Error(`Failed to export Excel file: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export default exportToExcel;

export {
  buildSummarySheet,
  buildBOQMatrixSheet,
  buildMaterialsListSheet,
  buildCostBreakdownSheet,
  getMockBOQData,
  getDefaultUnitCategories,
  MAT_START,
};

export type {
  BOQData, ProjectInfo, KitchenSection, Component, MatrixItem,
  Fixture, MaterialColumn, CalculationRules,
};
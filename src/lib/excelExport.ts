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

function getMockBOQData(): BOQData {
  return boq_data;
}

interface CalculationRulesExtended extends CalculationRules {
  unit_type_mapping?: Record<string, unknown>;
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
  const sections        = boqData.kitchen_sections || (boqData as unknown as Record<string, unknown>).sections || [];
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
  // The JSON may store drawing references as:
  //   - project_info.drawings          (most common in the Python version)
  //   - top-level boqData.drawings     (some variants)
  //   - project_info.document_metadata.drawings
  //   - project_info.drawing_references
  const docWithExt = doc as ProjectInfo & Record<string, unknown>;
  const boqDataExt = boqData as unknown as Record<string, unknown>;
  const docMetaExt = doc.document_metadata as Record<string, unknown> | undefined;
  
  const drawings: string[] =
    (Array.isArray(doc.drawings) && doc.drawings.length > 0                                     ? doc.drawings                                                           : null) ||
    (Array.isArray(boqDataExt.drawings) && (boqDataExt.drawings as string[]).length > 0          ? boqDataExt.drawings as string[]                                        : null) ||
    (Array.isArray(docWithExt.drawing_references) && (docWithExt.drawing_references as string[]).length > 0 ? docWithExt.drawing_references as string[] : null) ||
    (docMetaExt && Array.isArray(docMetaExt.drawings) && (docMetaExt.drawings as string[]).length > 0       ? docMetaExt.drawings as string[]          : null) ||
    [];

  const transformedDoc: TransformedProjectInfo = {
    // spread raw project_info first so all its fields are available
    ...doc,
    // explicit mapped keys
    project:          docWithExt.name as string,
    document_metadata: doc.document_metadata || {},
    material_detection_rules: transformedMatRules,
    additional_notes: (boqDataExt.additional_notes as Record<string, unknown>) || {},
    // ── drawings resolved above ──
    drawings,
  };

  workbook.creator = 'BOQ Export System';
  workbook.created = new Date();

  await buildSummarySheet(workbook, transformedDoc, sections, sectionMap);

  const gtRow = await buildBOQMatrixSheet(
    workbook, transformedDoc, sections, fixtures, sectionMap,
    transformedMaterialColumns, sheetAreaM2, outputOptions, unitCategories,
  );

  const matListStartRow = await buildMaterialsListSheet(
    workbook, transformedDoc, transformedMaterialColumns, gtRow, sheetAreaM2, fixtures,
  );

  await buildCostBreakdownSheet(
    workbook, transformedDoc, transformedMaterialColumns, matListStartRow, fixtures,
  );

  return workbook;
}

export async function exportToExcel(data?: BOQData): Promise<void> {
  try {
    const workbook = await buildWorkbook(data);
    const boqData  = data || getMockBOQData();
    const doc      = boqData.project_info;

    const dateStr  = new Date().toISOString().split('T')[0];
    const projectName = (doc as ProjectInfo & Record<string, unknown>).name || 'boq';
    const safeName = (projectName as string)
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
    link.click();
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
  buildWorkbook,
  getMockBOQData,
  getDefaultUnitCategories,
  MAT_START,
};

export type {
  BOQData, ProjectInfo, KitchenSection, Component, MatrixItem,
  Fixture, MaterialColumn, CalculationRules,
};

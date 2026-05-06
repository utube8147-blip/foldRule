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

export async function buildWorkbook(data?: BOQData): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  const boqData  = data || getMockBOQData();

  const doc             = boqData.project_info;
  const sections        = boqData.kitchen_sections || (boqData as any).sections || [];
  const fixtures        = boqData.installed_fixtures || [];
  const sectionMap      = boqData.section_grouping || {};
  const materialColumns = boqData.material_columns || [];
  const calcRules       = boqData.calculation_rules || {};
  const unitCategories  = (calcRules as any).unit_type_mapping || getDefaultUnitCategories();
  const outputOptions   = (calcRules as any).excel_formatting || {};
  const sheetAreaM2     = (calcRules as any).sheet_area_square_meters || 2.88;

  const transformedMaterialColumns: MaterialColumn[] = materialColumns.map(col => {
    const calcType = (col as any).calculation_type || 'area_based';
    const colId    = (col as any).id || (col as any).key || '';
    const transformed: any = {
      key:              calcType === 'spacer' ? `_blank_${colId}` : colId,
      id:               colId,
      display_name:     (col as any).display_name || (col as any).label || '',
      label:            (col as any).display_name || (col as any).label || '',
      column_width:     (col as any).column_width || (col as any).width || 14,
      width:            (col as any).column_width || (col as any).width || 14,
      remarks:          (col as any).remarks || '',
      unit_rate:        (col as any).unit_rate,
      calculation_type: calcType,
    };
    return transformed;
  });

  const matId = (boqData as any).material_identification || {};
  const transformedMatRules: any = {
    board_rules: (matId.sheet_materials || []).map((rule: any) => ({
      key:       rule.material_id,
      thickness: rule.required_thickness,
      material:  rule.material_type,
      context:   rule.context_keywords,
    })),
    addon_rules: (matId.additional_materials || []).map((rule: any) => ({
      key:          rule.material_id,
      trigger_spec: rule.triggers_in_specification || [],
      trigger_desc: rule.triggers_in_description || [],
      size_filter:  rule.size_filter,
    })),
    subgroup_keywords: (matId.subsection_organization || []).map((rule: any) => ({
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
  const drawings: string[] =
    (Array.isArray(doc.drawings)                                     && (doc.drawings as any).length > 0                                     ? doc.drawings as unknown as string[]                                     : null) ||
    (Array.isArray((boqData as any).drawings)                        && (boqData as any).drawings.length > 0                                  ? (boqData as any).drawings                                               : null) ||
    (Array.isArray((doc as any).drawing_references)                  && (doc as any).drawing_references.length > 0                            ? (doc as any).drawing_references                                         : null) ||
    (Array.isArray((doc.document_metadata as any)?.drawings)         && (doc.document_metadata as any).drawings.length > 0                    ? (doc.document_metadata as any).drawings                                 : null) ||
    [];

  const transformedDoc = {
    // spread raw project_info first so all its fields are available
    ...doc,
    // explicit mapped keys
    project:          (doc as any).name,
    document_metadata: (doc as any).document_metadata || {},
    material_detection_rules: transformedMatRules,
    additional_notes: (boqData as any).additional_notes || {},
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
  const workbook = await buildWorkbook(data);
  const boqData  = data || getMockBOQData();
  const doc      = boqData.project_info;

  const dateStr  = new Date().toISOString().split('T')[0];
  const safeName = ((doc as any).name || 'boq')
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
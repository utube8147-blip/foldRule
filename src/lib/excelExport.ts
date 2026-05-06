// excelExport.ts
import * as ExcelJS from 'exceljs';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ════

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

// ═══════════════════════════════════════════════════════════════════════════
// COLOR CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const Colors = {
  NAVY: 'FF0D1B2A',
  GOLD: 'FFB8962E',
  GOLD_LIGHT: 'FFC8A84B',
  MID_BLUE: 'FF1A3A5C',
  CHARCOAL: 'FF2C3E50',
  WHITE: 'FFFFFFFF',
  PALE_BLUE: 'FFEBF3FB',
  MID_GREY: 'FF6C7A8D',
  DARK_TEXT: 'FF1C1C1C',
  LIME_HL: 'FFE2EFDA',
  PEACH_HL: 'FFFCE4D6',
  SUBGRP_BG: 'FFD9E1F2',
  SEC_BAR_BG: 'FF0D1B2A',
  SEC_ACCENT: 'FFB8962E',
  SEC_TAG_BG: 'FF1A3A5C',
  SEC_TAG_FG: 'FFC8A84B',
  GREEN_HL: 'FFE8F5E9',
  AMBER_HL: 'FFFFF8E7',
  BORDER_LIGHT: 'FFE0E0E0',
  BORDER_DARK: 'FFBBBBBB',
};

const FONT_FACE = 'Calibri';
const BASE_H = 16;

// ═══════════════════════════════════════════════════════════════════════════
// STYLE HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function getColumnLetter(col: number): string {
  let result = '';
  while (col > 0) {
    col--;
    result = String.fromCharCode(65 + (col % 26)) + result;
    col = Math.floor(col / 26);
  }
  return result;
}

function createFill(color: string): Partial<ExcelJS.Fill> {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
}

function createFont(size: number, bold: boolean = false, color: string = Colors.DARK_TEXT, italic: boolean = false): Partial<ExcelJS.Font> {
  return { name: FONT_FACE, size, bold, color: { argb: color }, italic };
}

function createAlignment(horizontal: 'left' | 'center' | 'right' = 'left', vertical: 'center' | 'top' | 'bottom' = 'center', wrap: boolean = false): Partial<ExcelJS.Alignment> {
  return { horizontal, vertical, wrapText: wrap };
}

function createBorder(style: 'thin' | 'medium' | 'thick' = 'thin', color: string = Colors.BORDER_DARK): Partial<ExcelJS.Border> {
  return { style, color: { argb: color } };
}

function createFullBorder(color: string = Colors.BORDER_DARK): Partial<ExcelJS.Borders> {
  const border = createBorder('thin', color);
  return { top: border, bottom: border, left: border, right: border };
}

function createThickBorder(color: string = Colors.GOLD_LIGHT): Partial<ExcelJS.Borders> {
  const border = createBorder('medium', color);
  return { top: border, bottom: border, left: border, right: border };
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function getDefaultUnitCategories(): Record<string, string[]> {
  return {
    area_based: ['M²', 'm2', 'SQ M', 'SQM', 'M2'],
    volume_based: ['M³', 'm3', 'CU M', 'M3'],
    linear_based: ['LM', 'lm', 'L M', 'M', 'm'],
    count_based: ['Nr', 'nos', 'PC', 'pcs', 'Each', 'each'],
    pair_based: ['Pr', 'Pair'],
    set_based: ['Set', 'Kit', 'Box'],
  };
}

function getCalculationType(unit: string, unitCategories: Record<string, string[]>): string {
  const unitUpper = (unit || '').toUpperCase();
  for (const [calcType, units] of Object.entries(unitCategories)) {
    if (units.some(u => u.toUpperCase() === unitUpper)) {
      return calcType;
    }
  }
  if (['NR', 'NOS', 'PC', 'PCS', 'EACH'].includes(unitUpper)) return 'count_based';
  if (['PR', 'PAIR'].includes(unitUpper)) return 'pair_based';
  if (['SET', 'KIT', 'BOX'].includes(unitUpper)) return 'set_based';
  if (['M²', 'M2', 'SQ M', 'SQM'].includes(unitUpper)) return 'area_based';
  if (['M³', 'M3', 'CU M'].includes(unitUpper)) return 'volume_based';
  if (['LM', 'L M', 'M'].includes(unitUpper)) return 'linear_based';
  return 'count_based';
}

function detectMaterials(item: MatrixItem, materialRules: MaterialIdentification): string[] {
  const spec = (item.specification || '').toLowerCase();
  const desc = (item.description || '').toLowerCase();
  const detected: string[] = [];

  // Board rules
  for (const rule of materialRules.sheet_materials || []) {
    const tOk = !rule.required_thickness || spec.includes(rule.required_thickness.toLowerCase());
    const mOk = !rule.material_type || spec.includes(rule.material_type.toLowerCase());
    let cOk = true;
    if (rule.context_keywords) {
      cOk = rule.context_keywords.some(kw => desc.includes(kw.toLowerCase()));
    }
    if (tOk && mOk && cOk) {
      detected.push(rule.material_id);
      break;
    }
  }

  // Addon rules
  for (const rule of materialRules.additional_materials || []) {
    const triggerSpec = rule.triggers_in_specification || [];
    const triggerDesc = rule.triggers_in_description || [];
    const specMatch = triggerSpec.some(t => spec.includes(t.toLowerCase()));
    const descMatch = triggerDesc.some(t => desc.includes(t.toLowerCase()));
    if (specMatch || descMatch) {
      detected.push(rule.material_id);
    }
  }

  return [...new Set(detected)];
}

function buildQtyFormula(unit: string, row: number, activeDimCols: string[], unitCategories: Record<string, string[]>): string {
  const timesCol = getColumnLetter(5); // COL_TIMES
  const calcType = getCalculationType(unit, unitCategories);

  if (calcType === 'area_based') {
    if (activeDimCols.length === 0) {
      return `=IF(${timesCol}${row}<>"",${timesCol}${row},1)`;
    }
    const dimMult = activeDimCols.map(col => `${col}${row}`).join('*');
    return `=IFERROR(${dimMult}*IF(${timesCol}${row}<>"",${timesCol}${row},1),"")`;
  } else if (calcType === 'volume_based') {
    if (activeDimCols.length < 3) return '""';
    const dimMult = activeDimCols.map(col => `${col}${row}`).join('*');
    return `=IFERROR(${dimMult}*IF(${timesCol}${row}<>"",${timesCol}${row},1),"")`;
  } else if (calcType === 'linear_based') {
    if (activeDimCols.length > 0) {
      return `=IFERROR(${activeDimCols[0]}${row}*IF(${timesCol}${row}<>"",${timesCol}${row},1),"")`;
    }
    return `=IF(${timesCol}${row}<>"",${timesCol}${row},0)`;
  } else {
    return `=IF(${timesCol}${row}<>"",${timesCol}${row},0)`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MOCK DATA (if no data provided)
// ═══════════════════════════════════════════════════════════════════════════

function getMockBOQData(): BOQData {
  return {
    project_info: {
      name: "Al Waha Residence",
      location: "Dubai Hills Estate, Dubai",
      phase: "Phase 1",
      kitchen_type: "Standard Luxury",
      total_kitchen_units: 48,
      stakeholders: {
        main_contractor: "Al Waha Construction LLC",
        design_consultant: "Archtectonica Design Studio",
        supervision: "Eng. Ahmed Al Mazroui"
      },
      document_metadata: {
        title: "BILL OF QUANTITIES",
        date: new Date().toISOString().split('T')[0],
        revision: "P02",
        currency: "AED",
        vat_percent: 5
      }
    },
    kitchen_sections: [
      {
        section_id: "KIT-01",
        notes: "Main kitchen cabinetry",
        components: [
          {
            component_name: "Base Cabinets",
            dimensions: { L: { value: 600 }, W: { value: 600 }, H: { value: 850 } },
            items: [
              {
                item_number: "01",
                description: "MDF Cabinet Body",
                measurement_unit: "M²",
                material: "MDF_18MM",
                specification: "18mm MR grade MDF, E1 class",
                panel_count: 12,
                remarks: "Main carcass"
              },
              {
                item_number: "02",
                description: "PVC Edge Banding",
                measurement_unit: "LM",
                material: "EDGE_PVC_2MM",
                specification: "2mm PVC, colour matched",
                panel_count: 48
              }
            ]
          },
          {
            component_name: "Upper Cabinets",
            dimensions: { L: { value: 600 }, W: { value: 350 }, H: { value: 720 } },
            items: [
              {
                item_number: "03",
                description: "MDF Cabinet Body",
                measurement_unit: "M²",
                material: "MDF_18MM",
                panel_count: 8
              }
            ]
          }
        ]
      },
      {
        section_id: "KIT-02",
        notes: "Island unit",
        components: [
          {
            component_name: "Island Base",
            dimensions: { L: { value: 1200 }, W: { value: 900 }, H: { value: 900 } },
            items: [
              {
                item_number: "04",
                description: "MDF Cabinet Body",
                measurement_unit: "M²",
                material: "MDF_18MM",
                panel_count: 6
              }
            ]
          }
        ]
      }
    ],
    installed_fixtures: [
      {
        item_number: "FX-01",
        description: "Soft close hinge",
        measurement_unit: "Each",
        quantity_per_unit: 24,
        remarks: "Blum or equivalent"
      },
      {
        item_number: "FX-02",
        description: "Full extension drawer runner",
        measurement_unit: "Pair",
        quantity_per_unit: 12,
        remarks: "500mm, soft close"
      }
    ],
    section_grouping: {
      "KIT-01": { elevation: "A", cabinet_type: "Standard Cabinets" },
      "KIT-02": { elevation: "B", cabinet_type: "Island Unit" }
    },
    material_columns: [
      { id: "MDF_18MM", display_name: "18mm MR MDF", calculation_type: "area_based", width: 16, unit_rate: 85.50 },
      { id: "MDF_9MM", display_name: "9mm Back Panel", calculation_type: "area_based", width: 16, unit_rate: 55.00 },
      { id: "EDGE_PVC_2MM", display_name: "PVC Edge 2mm", calculation_type: "linear_based", width: 14, unit_rate: 8.50 },
      { id: "SPACER_1", display_name: "", calculation_type: "spacer" }
    ],
    calculation_rules: {
      sheet_area_square_meters: 2.88,
      excel_formatting: {
        bottom_padding_rows: 10,
        border_padding_cells: true,
        freeze_panes: "C10"
      },
      unit_type_mapping: getDefaultUnitCategories()
    },
    material_identification: {
      sheet_materials: [
        { material_id: "MDF_18MM", required_thickness: "18mm", material_type: "mdf", context_keywords: ["cabinet", "carcass"] }
      ],
      additional_materials: [
        { material_id: "EDGE_PVC_2MM", triggers_in_specification: ["pvc", "edge"], triggers_in_description: ["edging"] }
      ],
      subsection_organization: [],
      description_prefixes_to_remove: ["MDF ", "PVC "]
    },
    additional_notes: {
      general_assumptions: [
        { category: "Material Grade", content: "All MDF to be MR (Moisture Resistant) grade, E1 emissions compliant" },
        { category: "Installation", content: "Installation by certified joinery specialists only" }
      ],
      excluded_from_scope: [
        { item: "MEP Connections", reason: "By main MEP contractor" },
        { item: "Under-cabinet Lighting", reason: "Client supply / separate scope" }
      ]
    },
    drawings: ["A-101 (Kitchen Layout)", "A-102 (Elevations)", "A-103 (Sections)"]
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SHEET 1: SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

async function buildSummarySheet(
  workbook: ExcelJS.Workbook,
  doc: any,
  sections: KitchenSection[],
  sectionMap: Record<string, SectionGroup>
): Promise<void> {
  const ws = workbook.addWorksheet('Summary');
  ws.views = [{ showGridLines: false }];

  // Column widths
  ws.columns = [
    { width: 0 },  // A
    { width: 22 }, // B
    { width: 36 }, // C
    { width: 16 }, // D
    { width: 16 }, // E
    { width: 0 },  // F
  ];
  const COLS = 6;

  let r = 1;

  // Gold stripe
  ws.getRow(r).height = 4;
  for (let ci = 1; ci <= COLS; ci++) {
    ws.getCell(r, ci).fill = createFill(Colors.GOLD);
  }
  r++;

  // Navy bar with title
  ws.getRow(r).height = 36;
  for (let ci = 1; ci <= COLS; ci++) {
    ws.getCell(r, ci).fill = createFill(Colors.NAVY);
    ws.getCell(r, ci).border = { bottom: createBorder('medium', Colors.GOLD) };
  }
  ws.getCell(r, 1).fill = createFill(Colors.GOLD);
  ws.mergeCells(r, 2, r, 5);
  ws.getCell(r, 2).value = `BILL OF QUANTITIES · KITCHEN FITOUT · TYPE ${doc.kitchen_type || 'N/A'}`;
  ws.getCell(r, 2).font = createFont(13, true, Colors.WHITE);
  ws.getCell(r, 2).fill = createFill(Colors.NAVY);
  ws.getCell(r, 2).alignment = createAlignment('left', 'center');
  r++;

  // Subtitle row
  ws.getRow(r).height = 20;
  for (let ci = 1; ci <= COLS; ci++) {
    ws.getCell(r, ci).fill = createFill(Colors.MID_BLUE);
  }
  ws.getCell(r, 1).fill = createFill(Colors.GOLD);
  ws.mergeCells(r, 2, r, 5);
  ws.getCell(r, 2).value = `${doc.project || doc.name || ''} · ${doc.location || ''} · ${doc.phase || ''}`;
  ws.getCell(r, 2).font = createFont(10, false, Colors.GOLD_LIGHT, true);
  ws.getCell(r, 2).fill = createFill(Colors.MID_BLUE);
  ws.getCell(r, 2).alignment = createAlignment('left', 'center');
  r++;

  // Gold stripe
  ws.getRow(r).height = 3;
  for (let ci = 1; ci <= COLS; ci++) {
    ws.getCell(r, ci).fill = createFill(Colors.GOLD);
  }
  r++;

  // Section header
  ws.getRow(r).height = 26;
  for (let ci = 1; ci <= COLS; ci++) {
    ws.getCell(r, ci).fill = createFill(Colors.CHARCOAL);
    ws.getCell(r, ci).border = {
      top: createBorder('medium', Colors.GOLD),
      bottom: createBorder('thin', Colors.GOLD_LIGHT)
    };
  }
  ws.getCell(r, 1).fill = createFill(Colors.GOLD);
  ws.mergeCells(r, 2, r, 5);
  ws.getCell(r, 2).value = 'PROJECT INFORMATION';
  ws.getCell(r, 2).font = createFont(10, true, Colors.GOLD_LIGHT);
  ws.getCell(r, 2).fill = createFill(Colors.CHARCOAL);
  ws.getCell(r, 2).alignment = createAlignment('left', 'center');
  r++;

  // Project info rows
  const infoItems = [
    ['Main Contractor', doc.stakeholders?.main_contractor || 'N/A'],
    ['Design Consultant', doc.stakeholders?.design_consultant || 'N/A'],
    ['Supervision', doc.stakeholders?.supervision || 'N/A'],
    ['Kitchen Type', doc.kitchen_type || 'N/A'],
    ['Total Units', doc.total_kitchen_units || 0],
    ['Date', doc.document_metadata?.date || new Date().toLocaleDateString('en-GB')],
    ['Revision', doc.document_metadata?.revision || 'N/A'],
    ['Currency / VAT', `${doc.document_metadata?.currency || 'AED'} (VAT ${doc.document_metadata?.vat_percent || 5}%)`],
  ];

  for (let i = 0; i < infoItems.length; i++) {
    const [label, value] = infoItems[i];
    const alt = i % 2 === 0;
    const bg = alt ? Colors.PALE_BLUE : Colors.WHITE;

    ws.getRow(r).height = 22;
    ws.getCell(r, 1).fill = createFill(Colors.GOLD);
    ws.getCell(r, 1).border = { bottom: createBorder('thin') };

    ws.getCell(r, 2).value = label;
    ws.getCell(r, 2).font = createFont(9, true, Colors.MID_GREY);
    ws.getCell(r, 2).fill = createFill(bg);
    ws.getCell(r, 2).alignment = createAlignment('left', 'center');
    ws.getCell(r, 2).border = { left: createBorder('medium', Colors.GOLD), bottom: createBorder('thin') };

    ws.mergeCells(r, 3, r, 5);
    ws.getCell(r, 3).value = String(value);
    ws.getCell(r, 3).font = createFont(10, true, Colors.NAVY);
    ws.getCell(r, 3).fill = createFill(bg);
    ws.getCell(r, 3).alignment = createAlignment('left', 'center');
    ws.getCell(r, 3).border = { right: createBorder('medium', Colors.GOLD), bottom: createBorder('thin') };

    ws.getCell(r, 6).fill = createFill(bg);
    ws.getCell(r, 6).border = { bottom: createBorder('thin') };
    r++;
  }

  // Spacer
  ws.getRow(r).height = 8;
  r++;

  // Drawing References section
  ws.getRow(r).height = 26;
  for (let ci = 1; ci <= COLS; ci++) {
    ws.getCell(r, ci).fill = createFill(Colors.CHARCOAL);
    ws.getCell(r, ci).border = {
      top: createBorder('medium', Colors.GOLD),
      bottom: createBorder('thin', Colors.GOLD_LIGHT)
    };
  }
  ws.getCell(r, 1).fill = createFill(Colors.GOLD);
  ws.mergeCells(r, 2, r, 5);
  ws.getCell(r, 2).value = 'DRAWING REFERENCES';
  ws.getCell(r, 2).font = createFont(10, true, Colors.GOLD_LIGHT);
  ws.getCell(r, 2).fill = createFill(Colors.CHARCOAL);
  ws.getCell(r, 2).alignment = createAlignment('left', 'center');
  r++;

  const drawings = doc.drawings || [];
  for (let i = 0; i < Math.max(drawings.length, 1); i++) {
    const alt = i % 2 === 0;
    const bg = alt ? Colors.PALE_BLUE : Colors.WHITE;
    ws.getRow(r).height = 22;
    ws.getCell(r, 1).fill = createFill(Colors.GOLD);
    ws.getCell(r, 2).value = `Ref ${String(i + 1).padStart(2, '0')}`;
    ws.getCell(r, 2).font = createFont(9, true, Colors.MID_GREY);
    ws.getCell(r, 2).fill = createFill(bg);
    ws.getCell(r, 2).alignment = createAlignment('left', 'center');
    ws.getCell(r, 2).border = { left: createBorder('medium', Colors.GOLD), bottom: createBorder('thin') };
    ws.mergeCells(r, 3, r, 5);
    ws.getCell(r, 3).value = drawings[i] || '—';
    ws.getCell(r, 3).font = createFont(10, true, Colors.NAVY);
    ws.getCell(r, 3).fill = createFill(bg);
    ws.getCell(r, 3).alignment = createAlignment('left', 'center');
    ws.getCell(r, 3).border = { right: createBorder('medium', Colors.GOLD), bottom: createBorder('thin') };
    ws.getCell(r, 6).fill = createFill(bg);
    ws.getCell(r, 6).border = { bottom: createBorder('thin') };
    r++;
  }

  // Spacer
  ws.getRow(r).height = 8;
  r++;

  // Section Summary header
  ws.getRow(r).height = 26;
  for (let ci = 1; ci <= COLS; ci++) {
    ws.getCell(r, ci).fill = createFill(Colors.CHARCOAL);
    ws.getCell(r, ci).border = {
      top: createBorder('medium', Colors.GOLD),
      bottom: createBorder('thin', Colors.GOLD_LIGHT)
    };
  }
  ws.getCell(r, 1).fill = createFill(Colors.GOLD);
  ws.mergeCells(r, 2, r, 5);
  ws.getCell(r, 2).value = 'SECTION SUMMARY';
  ws.getCell(r, 2).font = createFont(10, true, Colors.GOLD_LIGHT);
  ws.getCell(r, 2).fill = createFill(Colors.CHARCOAL);
  ws.getCell(r, 2).alignment = createAlignment('left', 'center');
  r++;

  // Column headers
  ws.getRow(r).height = 26;
  for (let ci = 1; ci <= COLS; ci++) {
    ws.getCell(r, ci).fill = createFill(Colors.MID_BLUE);
    ws.getCell(r, ci).border = {
      top: createBorder('medium', Colors.GOLD),
      bottom: createBorder('medium', Colors.GOLD)
    };
  }
  ws.getCell(r, 1).fill = createFill(Colors.GOLD);
  ws.getCell(r, 2).value = 'Section';
  ws.getCell(r, 2).font = createFont(9, true, Colors.WHITE);
  ws.getCell(r, 2).fill = createFill(Colors.MID_BLUE);
  ws.getCell(r, 2).alignment = createAlignment('center', 'center');
  ws.getCell(r, 3).value = 'Reference';
  ws.getCell(r, 3).font = createFont(9, true, Colors.WHITE);
  ws.getCell(r, 3).fill = createFill(Colors.MID_BLUE);
  ws.getCell(r, 3).alignment = createAlignment('center', 'center');
  ws.getCell(r, 4).value = 'Description';
  ws.getCell(r, 4).font = createFont(9, true, Colors.WHITE);
  ws.getCell(r, 4).fill = createFill(Colors.MID_BLUE);
  ws.getCell(r, 4).alignment = createAlignment('center', 'center');
  ws.getCell(r, 5).value = 'Items';
  ws.getCell(r, 5).font = createFont(9, true, Colors.WHITE);
  ws.getCell(r, 5).fill = createFill(Colors.MID_BLUE);
  ws.getCell(r, 5).alignment = createAlignment('center', 'center');
  r++;

  // Section rows
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const sid = sec.section_id || '';
    const sg = sectionMap[sid] || {};
    const alt = i % 2 === 0;
    const bg = alt ? Colors.PALE_BLUE : Colors.WHITE;

    ws.getRow(r).height = 22;
    ws.getCell(r, 1).fill = createFill(Colors.GOLD);
    ws.getCell(r, 1).border = { bottom: createBorder('thin') };

    ws.getCell(r, 2).value = sid;
    ws.getCell(r, 2).font = createFont(10, false, Colors.NAVY);
    ws.getCell(r, 2).fill = createFill(bg);
    ws.getCell(r, 2).alignment = createAlignment('center', 'center');
    ws.getCell(r, 2).border = { left: createBorder('medium', Colors.GOLD), bottom: createBorder('thin') };

    ws.getCell(r, 3).value = sg.elevation || '—';
    ws.getCell(r, 3).font = createFont(10, false, Colors.NAVY);
    ws.getCell(r, 3).fill = createFill(bg);
    ws.getCell(r, 3).alignment = createAlignment('center', 'center');

    ws.getCell(r, 4).value = sg.cabinet_type || sg.unit_type || '—';
    ws.getCell(r, 4).font = createFont(10, false, Colors.DARK_TEXT);
    ws.getCell(r, 4).fill = createFill(bg);
    ws.getCell(r, 4).alignment = createAlignment('left', 'center');

    ws.getCell(r, 5).value = (sec.components || sec.items || []).reduce((acc, comp) => acc + (comp.items || []).length, 0);
    ws.getCell(r, 5).font = createFont(10, false, Colors.NAVY);
    ws.getCell(r, 5).fill = createFill(bg);
    ws.getCell(r, 5).alignment = createAlignment('center', 'center');
    ws.getCell(r, 5).border = { right: createBorder('medium', Colors.GOLD), bottom: createBorder('thin') };

    ws.getCell(r, 6).fill = createFill(bg);
    ws.getCell(r, 6).border = { bottom: createBorder('thin') };
    r++;
  }

  // Spacer
  ws.getRow(r).height = 8;
  r++;

  // Assumptions section
  const assumptions = doc.additional_notes?.general_assumptions || [];
  if (assumptions.length > 0) {
    ws.getRow(r).height = 26;
    for (let ci = 1; ci <= COLS; ci++) {
      ws.getCell(r, ci).fill = createFill(Colors.CHARCOAL);
      ws.getCell(r, ci).border = {
        top: createBorder('medium', Colors.GOLD),
        bottom: createBorder('thin', Colors.GOLD_LIGHT)
      };
    }
    ws.getCell(r, 1).fill = createFill(Colors.GOLD);
    ws.mergeCells(r, 2, r, 5);
    ws.getCell(r, 2).value = 'GENERAL ASSUMPTIONS';
    ws.getCell(r, 2).font = createFont(10, true, Colors.GOLD_LIGHT);
    ws.getCell(r, 2).fill = createFill(Colors.CHARCOAL);
    ws.getCell(r, 2).alignment = createAlignment('left', 'center');
    r++;

    for (let i = 0; i < assumptions.length; i++) {
      const note = assumptions[i];
      const alt = i % 2 === 0;
      const bg = alt ? Colors.PALE_BLUE : Colors.WHITE;
      ws.getRow(r).height = 22;
      ws.getCell(r, 1).fill = createFill(Colors.GOLD);
      ws.getCell(r, 2).value = note.category || '';
      ws.getCell(r, 2).font = createFont(9, true, Colors.MID_GREY);
      ws.getCell(r, 2).fill = createFill(bg);
      ws.getCell(r, 2).alignment = createAlignment('left', 'center');
      ws.getCell(r, 2).border = { left: createBorder('medium', Colors.GOLD), bottom: createBorder('thin') };
      ws.mergeCells(r, 3, r, 5);
      ws.getCell(r, 3).value = note.content || '';
      ws.getCell(r, 3).font = createFont(10, true, Colors.NAVY);
      ws.getCell(r, 3).fill = createFill(bg);
      ws.getCell(r, 3).alignment = createAlignment('left', 'center');
      ws.getCell(r, 3).border = { right: createBorder('medium', Colors.GOLD), bottom: createBorder('thin') };
      ws.getCell(r, 6).fill = createFill(bg);
      ws.getCell(r, 6).border = { bottom: createBorder('thin') };
      r++;
    }
    ws.getRow(r).height = 8;
    r++;
  }

  // Exclusions section
  const exclusions = doc.additional_notes?.excluded_from_scope || [];
  if (exclusions.length > 0) {
    ws.getRow(r).height = 26;
    for (let ci = 1; ci <= COLS; ci++) {
      ws.getCell(r, ci).fill = createFill(Colors.CHARCOAL);
      ws.getCell(r, ci).border = {
        top: createBorder('medium', Colors.GOLD),
        bottom: createBorder('thin', Colors.GOLD_LIGHT)
      };
    }
    ws.getCell(r, 1).fill = createFill(Colors.GOLD);
    ws.mergeCells(r, 2, r, 5);
    ws.getCell(r, 2).value = 'EXCLUDED FROM SCOPE';
    ws.getCell(r, 2).font = createFont(10, true, Colors.GOLD_LIGHT);
    ws.getCell(r, 2).fill = createFill(Colors.CHARCOAL);
    ws.getCell(r, 2).alignment = createAlignment('left', 'center');
    r++;

    for (let i = 0; i < exclusions.length; i++) {
      const excl = exclusions[i];
      const alt = i % 2 === 0;
      const bg = alt ? Colors.PALE_BLUE : Colors.WHITE;
      ws.getRow(r).height = 22;
      ws.getCell(r, 1).fill = createFill(Colors.GOLD);
      ws.getCell(r, 2).value = excl.item || '';
      ws.getCell(r, 2).font = createFont(9, true, Colors.MID_GREY);
      ws.getCell(r, 2).fill = createFill(bg);
      ws.getCell(r, 2).alignment = createAlignment('left', 'center');
      ws.getCell(r, 2).border = { left: createBorder('medium', Colors.GOLD), bottom: createBorder('thin') };
      ws.mergeCells(r, 3, r, 5);
      ws.getCell(r, 3).value = excl.reason || '';
      ws.getCell(r, 3).font = createFont(10, true, Colors.NAVY);
      ws.getCell(r, 3).fill = createFill(bg);
      ws.getCell(r, 3).alignment = createAlignment('left', 'center');
      ws.getCell(r, 3).border = { right: createBorder('medium', Colors.GOLD), bottom: createBorder('thin') };
      ws.getCell(r, 6).fill = createFill(bg);
      ws.getCell(r, 6).border = { bottom: createBorder('thin') };
      r++;
    }
  }

  // Footer
  ws.getRow(r).height = 3;
  for (let ci = 1; ci <= COLS; ci++) {
    ws.getCell(r, ci).fill = createFill(Colors.GOLD);
  }
  r++;

  ws.getRow(r).height = 20;
  ws.mergeCells(r, 1, r, COLS);
  ws.getCell(r, 1).value = 'All quantities subject to field verification. Unit rates to be inserted by tendering contractor.';
  ws.getCell(r, 1).font = createFont(8, false, Colors.MID_GREY, true);
  ws.getCell(r, 1).fill = createFill(Colors.NAVY);
  ws.getCell(r, 1).alignment = createAlignment('center', 'center');
}

// ═══════════════════════════════════════════════════════════════════════════
// SHEET 2: BOQ MATRIX
// ═══════════════════════════════════════════════════════════════════════════

// Column indices
const COL_SNO = 2;
const COL_DESC = 3;
const COL_UNIT = 4;
const COL_TIMES = 5;
const COL_L = 6;
const COL_W = 7;
const COL_H = 8;
const COL_QTY = 9;
const MAT_START = 10;

async function buildBOQMatrixSheet(
  workbook: ExcelJS.Workbook,
  doc: any,
  sections: KitchenSection[],
  fixtures: Fixture[],
  sectionMap: Record<string, SectionGroup>,
  materialCols: MaterialColumn[],
  sheetAreaM2: number,
  outputOptions: any,
  unitCategories: Record<string, string[]>
): Promise<number> {
  const ws = workbook.addWorksheet('BOQ_Matrix');
  ws.views = [{ showGridLines: false }];

  const paddingBottom = outputOptions?.bottom_padding_rows || outputOptions?.padding_bottom || 10;

  const materialColumns = materialCols.filter(c => !c.key?.startsWith('_blank'));
  const spacerColumns = materialCols.filter(c => c.key?.startsWith('_blank'));

  const countOnlyKeys = new Set(materialCols.filter(c => 
    c.calculation_type === 'count_based' || 
    c.calculation_type === 'pair_based' || 
    c.calculation_type === 'set_based' ||
    c.calculation_type === 'fixture_based'
  ).map(c => c.key || c.id || ''));

  const REM_INTERNAL = MAT_START + materialColumns.length + spacerColumns.length;
  const TOTAL_COLS = REM_INTERNAL;

  // Track column widths for auto-fit
  const colMax: Record<number, number> = {
    1: 0, 2: 10, 3: 46, 4: 9, 5: 9, 6: 9, 7: 9, 8: 9, 9: 17
  };
  for (let i = 0; i < materialColumns.length; i++) {
    colMax[MAT_START + i] = materialColumns[i].column_width || materialColumns[i].width || 14;
  }
  for (let i = 0; i < spacerColumns.length; i++) {
    colMax[MAT_START + materialColumns.length + i] = 3.5;
  }
  colMax[REM_INTERNAL] = 34;

  function trackWidth(ci: number, text: string | number) {
    if (text) {
      const str = String(text);
      for (const line of str.split('\n')) {
        colMax[ci] = Math.max(colMax[ci] || 10, line.length + 3);
      }
    }
  }

  let currentRow = 1;

  // Title
  ws.getRow(currentRow).height = 30;
  ws.mergeCells(currentRow, 1, currentRow, REM_INTERNAL);
  const titleCell = ws.getCell(currentRow, 1);
  titleCell.value = `${doc.document_metadata?.title || 'BILL OF QUANTITIES'} (TYPE ${doc.kitchen_type || 'N/A'}) · ${doc.project || doc.name || ''} · ${doc.location || ''} · ${doc.phase || ''}`;
  titleCell.font = createFont(14, true, Colors.WHITE);
  titleCell.fill = createFill(Colors.NAVY);
  titleCell.alignment = createAlignment('center', 'center');
  currentRow++;

  // Info bar with total units
  ws.getRow(currentRow).height = 24;
  for (let ci = 1; ci <= TOTAL_COLS; ci++) {
    ws.getCell(currentRow, ci).fill = createFill(Colors.MID_BLUE);
    ws.getCell(currentRow, ci).border = { bottom: createBorder('medium', Colors.GOLD) };
  }
  ws.getCell(currentRow, COL_H).value = doc.total_kitchen_units || 0;
  ws.getCell(currentRow, COL_H).font = createFont(11, true, Colors.MID_BLUE);
  ws.getCell(currentRow, COL_H).fill = createFill(Colors.MID_BLUE);
  currentRow++;

  let firstDataRow = currentRow;
  const totalUnitRows: number[] = [];

  // Helper functions
  function writeSectionHeader(row: number, elevation: string, unitType: string, note: string = ''): number {
    ws.getRow(row).height = 45;
    const goldBorder = createBorder('medium', Colors.GOLD);
    for (let ci = 1; ci <= TOTAL_COLS; ci++) {
      ws.getCell(row, ci).fill = createFill(Colors.SEC_BAR_BG);
      ws.getCell(row, ci).border = { top: goldBorder, bottom: goldBorder };
    }
    ws.getCell(row, COL_SNO).value = `  ${elevation}  `;
    ws.getCell(row, COL_SNO).font = createFont(11, true, Colors.SEC_TAG_FG);
    ws.getCell(row, COL_SNO).fill = createFill(Colors.SEC_TAG_BG);
    ws.getCell(row, COL_SNO).alignment = createAlignment('center', 'center');
    ws.getCell(row, COL_SNO).border = {
      left: createBorder('medium', Colors.GOLD),
      right: createBorder('thin', Colors.GOLD_LIGHT),
      top: goldBorder,
      bottom: goldBorder
    };
    ws.getCell(row, COL_DESC).value = unitType.toUpperCase();
    ws.getCell(row, COL_DESC).font = createFont(13, true, Colors.WHITE);
    ws.getCell(row, COL_DESC).fill = createFill(Colors.SEC_BAR_BG);
    ws.getCell(row, COL_DESC).alignment = createAlignment('left', 'center');
    ws.getCell(row, COL_DESC).border = { top: goldBorder, bottom: goldBorder };
    if (note) {
      ws.getCell(row, REM_INTERNAL).value = note.substring(0, 100);
      ws.getCell(row, REM_INTERNAL).font = createFont(10, false, Colors.SEC_ACCENT, true);
      ws.getCell(row, REM_INTERNAL).fill = createFill(Colors.SEC_BAR_BG);
      ws.getCell(row, REM_INTERNAL).alignment = createAlignment('right', 'center', true);
      ws.getCell(row, REM_INTERNAL).border = { top: goldBorder, bottom: goldBorder };
      trackWidth(REM_INTERNAL, note);
    }
    return row + 1;
  }

  function writeColumnHeaders(row: number) {
    ws.getRow(row).height = 60;
    const headerFill = createFill(Colors.MID_BLUE);
    const headerFont = createFont(11, true, Colors.WHITE);
    const headerAlign = createAlignment('center', 'center', true);
    const thickBorder = createThickBorder();

    const headers = ['', 'S.No', 'Description', 'Unit', 'Times', 'L', 'W', 'H', 'Total QTY'];
    for (let ci = 1; ci <= headers.length; ci++) {
      ws.getCell(row, ci).value = headers[ci - 1];
      ws.getCell(row, ci).font = headerFont;
      ws.getCell(row, ci).fill = headerFill;
      ws.getCell(row, ci).alignment = headerAlign;
      ws.getCell(row, ci).border = thickBorder;
      trackWidth(ci, headers[ci - 1]);
    }

    for (let i = 0; i < materialColumns.length; i++) {
      const ci = MAT_START + i;
      ws.getCell(row, ci).value = materialColumns[i].display_name || materialColumns[i].label || '';
      ws.getCell(row, ci).font = headerFont;
      ws.getCell(row, ci).fill = headerFill;
      ws.getCell(row, ci).alignment = headerAlign;
      ws.getCell(row, ci).border = thickBorder;
      trackWidth(ci, materialColumns[i].display_name || materialColumns[i].label || '');
    }

    for (let i = 0; i < spacerColumns.length; i++) {
      const ci = MAT_START + materialColumns.length + i;
      ws.getCell(row, ci).fill = createFill(Colors.CHARCOAL);
      ws.getCell(row, ci).border = thickBorder;
    }

    ws.getCell(row, REM_INTERNAL).value = 'Remarks';
    ws.getCell(row, REM_INTERNAL).font = headerFont;
    ws.getCell(row, REM_INTERNAL).fill = headerFill;
    ws.getCell(row, REM_INTERNAL).alignment = headerAlign;
    ws.getCell(row, REM_INTERNAL).border = thickBorder;
  }

  function writeComponentHeader(row: number, name: string, dims: Record<string, number>): { row: number; hrefs: Record<string, string> } {
    ws.getRow(row).height = 28;
    for (let ci = 1; ci <= TOTAL_COLS; ci++) {
      ws.getCell(row, ci).fill = createFill(Colors.SUBGRP_BG);
    }
    ws.getCell(row, COL_DESC).value = name;
    ws.getCell(row, COL_DESC).fill = createFill(Colors.SUBGRP_BG);
    ws.getCell(row, COL_DESC).font = createFont(11, true, Colors.MID_BLUE);
    ws.getCell(row, COL_DESC).alignment = createAlignment('left', 'center');
    trackWidth(COL_DESC, name);

    const dimBorder = {
      left: createBorder('medium', Colors.GOLD),
      right: createBorder('medium', Colors.GOLD),
      top: createBorder('thin', Colors.GOLD),
      bottom: createBorder('thin', Colors.GOLD)
    };
    const hrefs: Record<string, string> = {};

    const dimColumns = [
      { key: 'L', col: COL_L },
      { key: 'W', col: COL_W },
      { key: 'H', col: COL_H }
    ];

    for (const { key, col } of dimColumns) {
      const val = dims[key];
      const cell = ws.getCell(row, col);
      if (val !== undefined && val !== null) {
        cell.value = val;
        cell.fill = createFill(Colors.GOLD_LIGHT);
        cell.font = createFont(11, true, Colors.NAVY);
        cell.alignment = createAlignment('center', 'center');
        cell.border = dimBorder;
        cell.numFmt = '0.000';
        hrefs[key] = `$${getColumnLetter(col)}$${row}`;
      } else {
        cell.value = '—';
        cell.fill = createFill(Colors.SUBGRP_BG);
        cell.font = createFont(11, false, Colors.CHARCOAL);
        cell.alignment = createAlignment('center', 'center');
        cell.border = dimBorder;
      }
    }

    return { row: row + 1, hrefs };
  }

  function writeItem(
    row: number,
    itemNo: string,
    desc: string,
    unit: string,
    timesVal: number | null,
    hrefs: Record<string, string>,
    materialSet: Set<string>,
    remarks: string,
    alt: boolean
  ) {
    ws.getRow(row).height = 18;
    const bg = alt ? 'FFF8F9FC' : Colors.WHITE;
    const borderColor = alt ? 'FFE8ECF1' : 'FFEEF2F7';
    const brd = {
      left: createBorder('thin', borderColor),
      right: createBorder('thin', borderColor),
      top: createBorder('thin', borderColor),
      bottom: createBorder('thin', borderColor)
    };

    ws.getCell(row, COL_SNO).value = itemNo;
    ws.getCell(row, COL_SNO).fill = createFill(bg);
    ws.getCell(row, COL_SNO).font = createFont(10, true, Colors.NAVY);
    ws.getCell(row, COL_SNO).alignment = createAlignment('center', 'center');
    ws.getCell(row, COL_SNO).border = brd;

    ws.getCell(row, COL_DESC).value = desc;
    ws.getCell(row, COL_DESC).fill = createFill(bg);
    ws.getCell(row, COL_DESC).font = createFont(10, false, Colors.DARK_TEXT);
    ws.getCell(row, COL_DESC).alignment = createAlignment('left', 'center', true);
    ws.getCell(row, COL_DESC).border = brd;
    trackWidth(COL_DESC, desc);

    ws.getCell(row, COL_UNIT).value = unit;
    ws.getCell(row, COL_UNIT).fill = createFill(bg);
    ws.getCell(row, COL_UNIT).font = createFont(10, false, Colors.MID_GREY);
    ws.getCell(row, COL_UNIT).alignment = createAlignment('center', 'center');
    ws.getCell(row, COL_UNIT).border = brd;

    const timesCell = ws.getCell(row, COL_TIMES);
    if (timesVal !== null && timesVal !== 1) {
      timesCell.value = timesVal;
      timesCell.fill = createFill(Colors.AMBER_HL);
      timesCell.font = createFont(10, true, Colors.GOLD);
    } else {
      timesCell.value = '';
      timesCell.fill = createFill(bg);
    }
    timesCell.alignment = createAlignment('center', 'center');
    timesCell.border = brd;

    const activeDims: string[] = [];
    const dimCols = [
      { key: 'L', col: COL_L },
      { key: 'W', col: COL_W },
      { key: 'H', col: COL_H }
    ];

    for (const { key, col } of dimCols) {
      const hrefVal = hrefs[key];
      const cell = ws.getCell(row, col);
      if (hrefVal) {
        cell.value = `=${hrefVal}`;
        cell.font = createFont(10, false, Colors.MID_BLUE);
        activeDims.push(getColumnLetter(col));
      } else {
        cell.value = '';
        cell.font = createFont(10, false, Colors.MID_GREY);
      }
      cell.fill = createFill(bg);
      cell.alignment = createAlignment('center', 'center');
      cell.border = brd;
      cell.numFmt = '0.000';
    }

    const qtyFormula = buildQtyFormula(unit, row, activeDims, unitCategories);
    const qtyCell = ws.getCell(row, COL_QTY);
    qtyCell.value = qtyFormula;
    qtyCell.font = createFont(10, true, Colors.DARK_TEXT);
    qtyCell.fill = createFill(Colors.GREEN_HL);
    qtyCell.alignment = createAlignment('center', 'center');
    qtyCell.border = brd;
    qtyCell.numFmt = '0.000';

    const qtyRef = `${getColumnLetter(COL_QTY)}${row}`;

    for (let i = 0; i < materialColumns.length; i++) {
      const ci = MAT_START + i;
      const key = materialColumns[i].key || materialColumns[i].id || '';
      const cell = ws.getCell(row, ci);
      if (materialSet.has(key)) {
        cell.value = `=${qtyRef}`;
        cell.fill = createFill(Colors.PALE_BLUE);
        cell.font = createFont(10, false, Colors.MID_BLUE);
        cell.numFmt = '0.000';
      } else {
        cell.fill = createFill(bg);
      }
      cell.border = brd;
      cell.alignment = createAlignment('center', 'center');
    }

    for (let i = 0; i < spacerColumns.length; i++) {
      const ci = MAT_START + materialColumns.length + i;
      ws.getCell(row, ci).fill = createFill(bg);
      ws.getCell(row, ci).border = brd;
    }

    const remarksCell = ws.getCell(row, REM_INTERNAL);
    remarksCell.value = remarks;
    remarksCell.fill = createFill(bg);
    remarksCell.font = createFont(9, false, Colors.MID_GREY, true);
    remarksCell.alignment = createAlignment('left', 'center', true);
    remarksCell.border = brd;
    trackWidth(REM_INTERNAL, remarks);
  }

  function writeSummary(puRow: number, totRow: number, iStart: number, iEnd: number) {
    if (materialColumns.length === 0) return;

    ws.getRow(puRow).height = 20;
    const perUnitCell = ws.getCell(puRow, COL_QTY);
    perUnitCell.value = 'Per Unit';
    perUnitCell.font = createFont(11, true);
    perUnitCell.fill = createFill(Colors.LIME_HL);
    perUnitCell.alignment = createAlignment('center', 'center');

    for (let i = 0; i < materialColumns.length; i++) {
      const ci = MAT_START + i;
      const colLetter = getColumnLetter(ci);
      const cell = ws.getCell(puRow, ci);
      cell.value = `=SUM(${colLetter}${iStart}:${colLetter}${iEnd})`;
      cell.font = createFont(11, false);
      cell.fill = createFill(Colors.LIME_HL);
      cell.alignment = createAlignment('center', 'center');
      cell.border = createFullBorder();
      cell.numFmt = '0.000';
    }

    ws.getRow(totRow).height = 22;
    ws.getCell(totRow, COL_H).value = '=H2';
    ws.getCell(totRow, COL_H).font = createFont(13, true, 'FFFF0000');
    ws.getCell(totRow, COL_H).alignment = createAlignment('center', 'center');

    const totalCell = ws.getCell(totRow, COL_QTY);
    totalCell.value = 'Total Unit';
    totalCell.font = createFont(11, true);
    totalCell.fill = createFill(Colors.PEACH_HL);
    totalCell.alignment = createAlignment('center', 'center');
    totalCell.border = createFullBorder();

    for (let i = 0; i < materialColumns.length; i++) {
      const ci = MAT_START + i;
      const colLetter = getColumnLetter(ci);
      const key = materialColumns[i].key || materialColumns[i].id || '';
      const cell = ws.getCell(totRow, ci);
      if (countOnlyKeys.has(key)) {
        cell.value = `=${colLetter}${puRow}*H2`;
      } else {
        cell.value = `=${colLetter}${puRow}*H2/${sheetAreaM2}`;
      }
      cell.font = createFont(11, false);
      cell.fill = createFill(Colors.PEACH_HL);
      cell.alignment = createAlignment('center', 'center');
      cell.border = createFullBorder();
      cell.numFmt = '0.000';
    }
  }

  // Process sections
  const descStripPrefixes = doc.material_detection_rules?.desc_strip_prefixes || [];

  for (const sec of sections) {
    const sid = sec.section_id || '';
    const secNote = sec.notes || '';
    const sg = sectionMap[sid] || {};
    const elevation = sg.elevation || sid;
    const unitType = sg.cabinet_type || sg.unit_type || 'Section';

    currentRow = writeSectionHeader(currentRow, elevation, unitType, secNote);
    writeColumnHeaders(currentRow);
    currentRow++;

    const iStart = currentRow;
    let alt = false;

    const components = sec.components || sec.items || [];
    for (const comp of components) {
      const compName = comp.component_name || comp.name || '';
      const rawDims = comp.dimensions || {};
      const dims: Record<string, number> = {};
      for (const k of ['L', 'W', 'H'] as const) {
        const v = rawDims[k];
        if (v) {
          dims[k] = typeof v === 'number' ? v : v.value;
        }
      }

      const { row: newRow, hrefs } = writeComponentHeader(currentRow, compName, dims);
      currentRow = newRow;

      const items = comp.items || [];
      for (const item of items) {
        let desc = item.description || '';
        for (const prefix of descStripPrefixes) {
          if (desc.startsWith(prefix)) {
            desc = desc.substring(prefix.length);
            break;
          }
        }

        const unit = item.measurement_unit || item.unit || 'M²';
        const remarks = item.remarks || '';
        const panelCount = item.panel_count;
        const timesVal = (panelCount && panelCount !== 0 && panelCount !== 1) ? panelCount : null;

        const assignedMaterial = item.material;
        const materialSet = assignedMaterial 
          ? new Set([assignedMaterial]) 
          : new Set(detectMaterials(item, doc.material_detection_rules || {}));

        // Filter hrefs based on formula
        const formula = (item.qty_formula || '').toLowerCase();
        const filteredHrefs: Record<string, string> = {};
        if (formula && !formula.includes('fixed') && formula.trim() !== '') {
          for (const [dimKey, href] of Object.entries(hrefs)) {
            const dimLabel = rawDims[dimKey]?.label?.toLowerCase() || '';
            if (dimLabel && formula.includes(dimLabel)) {
              filteredHrefs[dimKey] = href;
            }
          }
          // Handle shelf length
          const shelf = item.shelf_length;
          if (shelf) {
            const shelfLabel = (typeof shelf === 'object' ? shelf.label : '').toLowerCase();
            const shelfValue = typeof shelf === 'object' ? shelf.value : shelf;
            if (shelfLabel && formula.includes(shelfLabel)) {
              filteredHrefs['L'] = `__value__:${shelfValue}`;
            }
          }
        } else {
          Object.assign(filteredHrefs, hrefs);
        }

        writeItem(currentRow, item.item_number, desc, unit, timesVal, filteredHrefs, materialSet, remarks, alt);
        alt = !alt;
        currentRow++;
      }
    }

    const iEnd = currentRow - 1;
    const puRow = currentRow;
    const totRow = currentRow + 1;
    writeSummary(puRow, totRow, iStart, iEnd);
    totalUnitRows.push(totRow);
    currentRow += 2;

    // Spacer
    ws.getRow(currentRow).height = 10;
    currentRow++;
  }

  // Fixtures section
  if (fixtures && fixtures.length > 0) {
    currentRow = writeSectionHeader(currentRow, 'FX', 'Kitchen Fixtures – Installed Items Schedule', '');

    ws.getRow(currentRow).height = 48;
    for (let ci = 1; ci <= TOTAL_COLS; ci++) {
      ws.getCell(currentRow, ci).fill = createFill(Colors.CHARCOAL);
      ws.getCell(currentRow, ci).border = {
        top: createBorder('medium', Colors.GOLD),
        bottom: createBorder('medium', Colors.GOLD)
      };
    }
    ws.getCell(currentRow, 1).fill = createFill(Colors.GOLD);

    // Merge material columns area
    const matStartCol = MAT_START;
    const matEndCol = REM_INTERNAL - 1;
    if (matEndCol >= matStartCol) {
      ws.mergeCells(currentRow, matStartCol, currentRow, matEndCol);
      const mergedCell = ws.getCell(currentRow, matStartCol);
      mergedCell.value = '— MATERIAL SCOPE N/A · Installed Fixtures Only —';
      mergedCell.font = createFont(9, false, Colors.MID_GREY, true);
      mergedCell.fill = createFill(Colors.CHARCOAL);
      mergedCell.alignment = createAlignment('center', 'center');
      mergedCell.border = {
        top: createBorder('medium', Colors.GOLD),
        bottom: createBorder('medium', Colors.GOLD)
      };
    }

    const fxHeaders = [
      { col: COL_SNO, label: 'S.No', align: 'center', size: 9 },
      { col: COL_DESC, label: 'Description', align: 'left', size: 11 },
      { col: COL_UNIT, label: 'Unit', align: 'center', size: 9 },
      { col: COL_TIMES, label: 'Qty / Unit', align: 'center', size: 10 },
      { col: COL_QTY, label: 'Total Qty\n(Project)', align: 'center', size: 10 },
      { col: REM_INTERNAL, label: 'Remarks', align: 'left', size: 9 }
    ];

    for (const { col, label, align, size } of fxHeaders) {
      const cell = ws.getCell(currentRow, col);
      cell.value = label;
      cell.font = createFont(size, true, Colors.WHITE);
      cell.fill = createFill(Colors.MID_BLUE);
      cell.alignment = createAlignment(align as any, 'center', true);
      cell.border = {
        top: createBorder('medium', Colors.GOLD),
        bottom: createBorder('medium', Colors.GOLD),
        left: createBorder('thin', Colors.GOLD_LIGHT),
        right: createBorder('thin', Colors.GOLD_LIGHT)
      };
      trackWidth(col, label);
    }
    currentRow++;

    let alt = false;
    for (let fxIdx = 0; fxIdx < fixtures.length; fxIdx++) {
      const fx = fixtures[fxIdx];
      const bg = alt ? 'FFF2F4F8' : Colors.WHITE;
      const borderColor = alt ? 'FFDDE3EE' : 'FFE8EDF5';

      ws.getRow(currentRow).height = 22;
      const brd = {
        left: createBorder('thin', borderColor),
        right: createBorder('thin', borderColor),
        top: createBorder('thin', borderColor),
        bottom: createBorder('thin', borderColor)
      };

      for (let ci = 1; ci <= TOTAL_COLS; ci++) {
        ws.getCell(currentRow, ci).fill = createFill(bg);
        ws.getCell(currentRow, ci).border = brd;
      }
      ws.getCell(currentRow, 1).fill = createFill(Colors.GOLD);
      ws.getCell(currentRow, 1).border = { bottom: createBorder('thin', 'FFE0C060') };

      ws.getCell(currentRow, COL_SNO).value = fx.item_number;
      ws.getCell(currentRow, COL_SNO).font = createFont(10, true, Colors.NAVY);
      ws.getCell(currentRow, COL_SNO).alignment = createAlignment('center', 'center');

      ws.getCell(currentRow, COL_DESC).value = fx.description;
      ws.getCell(currentRow, COL_DESC).font = createFont(10, false, Colors.DARK_TEXT);
      ws.getCell(currentRow, COL_DESC).alignment = createAlignment('left', 'center', true);
      trackWidth(COL_DESC, fx.description);

      ws.getCell(currentRow, COL_UNIT).value = fx.measurement_unit || 'Each';
      ws.getCell(currentRow, COL_UNIT).font = createFont(10, false, Colors.MID_GREY);
      ws.getCell(currentRow, COL_UNIT).alignment = createAlignment('center', 'center');

      const qtyPerUnit = fx.quantity_per_unit || 1;
      ws.getCell(currentRow, COL_TIMES).value = qtyPerUnit;
      ws.getCell(currentRow, COL_TIMES).font = createFont(10, true, Colors.NAVY);
      ws.getCell(currentRow, COL_TIMES).fill = createFill(Colors.PALE_BLUE);
      ws.getCell(currentRow, COL_TIMES).alignment = createAlignment('center', 'center');

      // Merge L, W, H cells
      ws.mergeCells(currentRow, COL_L, currentRow, COL_H);
      const dimCell = ws.getCell(currentRow, COL_L);
      dimCell.value = '—';
      dimCell.font = createFont(9, false, Colors.MID_GREY, true);
      dimCell.fill = createFill(bg);
      dimCell.alignment = createAlignment('center', 'center');

      const qtyCell = ws.getCell(currentRow, COL_QTY);
      qtyCell.value = `=${getColumnLetter(COL_TIMES)}${currentRow}*H2`;
      qtyCell.font = createFont(10, true, Colors.DARK_TEXT);
      qtyCell.fill = createFill(Colors.GREEN_HL);
      qtyCell.alignment = createAlignment('center', 'center');
      qtyCell.numFmt = '0';

      // Merge material columns
      if (matEndCol >= matStartCol) {
        ws.mergeCells(currentRow, matStartCol, currentRow, matEndCol);
        const matCell = ws.getCell(currentRow, matStartCol);
        matCell.value = '—';
        matCell.font = createFont(9, false, Colors.MID_GREY, true);
        matCell.fill = createFill('FFF0F2F5');
        matCell.alignment = createAlignment('center', 'center');
        matCell.border = {
          left: createBorder('thin', borderColor),
          right: createBorder('thin', borderColor),
          top: createBorder('thin', borderColor),
          bottom: createBorder('thin', borderColor)
        };
      }

      ws.getCell(currentRow, REM_INTERNAL).value = fx.remarks || '';
      ws.getCell(currentRow, REM_INTERNAL).font = createFont(9, false, Colors.MID_GREY, true);
      ws.getCell(currentRow, REM_INTERNAL).alignment = createAlignment('left', 'center', true);
      trackWidth(REM_INTERNAL, fx.remarks || '');

      alt = !alt;
      currentRow++;
    }

    ws.getRow(currentRow).height = 10;
    currentRow += 2;
  }

  // Grand Total section
  ws.getRow(currentRow).height = 10;
  for (let ci = 1; ci <= TOTAL_COLS; ci++) {
    ws.getCell(currentRow, ci).fill = createFill(Colors.GOLD);
  }
  currentRow++;

  ws.getRow(currentRow).height = 5;
  for (let ci = 1; ci <= TOTAL_COLS; ci++) {
    ws.getCell(currentRow, ci).fill = createFill(Colors.GOLD);
  }
  currentRow++;

  ws.mergeCells(currentRow, 1, currentRow, REM_INTERNAL);
  ws.getCell(currentRow, 1).value = 'PROJECT TOTALS — All Sections';
  ws.getCell(currentRow, 1).font = createFont(13, true, Colors.WHITE);
  ws.getCell(currentRow, 1).fill = createFill(Colors.CHARCOAL);
  ws.getCell(currentRow, 1).alignment = createAlignment('center', 'center');
  ws.getRow(currentRow).height = 26;
  currentRow++;

  const gtRow = currentRow;
  ws.getRow(gtRow).height = 28;
  ws.getCell(gtRow, COL_QTY).value = 'Total QTY';
  ws.getCell(gtRow, COL_QTY).font = createFont(12, true, Colors.WHITE);
  ws.getCell(gtRow, COL_QTY).fill = createFill(Colors.NAVY);
  ws.getCell(gtRow, COL_QTY).alignment = createAlignment('center', 'center');
  ws.getCell(gtRow, COL_QTY).border = createThickBorder();

  if (materialColumns.length > 0 && totalUnitRows.length > 0) {
    for (let i = 0; i < materialColumns.length; i++) {
      const ci = MAT_START + i;
      const colLetter = getColumnLetter(ci);
      const sumFormula = totalUnitRows.map(r => `${colLetter}${r}`).join('+');
      const cell = ws.getCell(gtRow, ci);
      cell.value = `=${sumFormula}`;
      cell.font = createFont(12, true, Colors.GOLD);
      cell.fill = createFill(Colors.NAVY);
      cell.alignment = createAlignment('center', 'center');
      cell.border = createThickBorder();
      cell.numFmt = '0.000';
    }
  }

  // Apply column widths
  for (const [ci, width] of Object.entries(colMax)) {
    const colNum = parseInt(ci);
    if (colNum <= TOTAL_COLS) {
      ws.getColumn(colNum).width = Math.max(width as number, 8);
    }
  }

  // Apply freeze panes
  if (outputOptions?.freeze_panes) {
    const freezeParts = outputOptions.freeze_panes.match(/([A-Z]+)(\d+)/);
    if (freezeParts) {
      ws.views = [{ state: 'frozen', xSplit: freezeParts[1].length, ySplit: parseInt(freezeParts[2]) - 1 }];
    }
  }

  return gtRow;
}

// ═══════════════════════════════════════════════════════════════════════════
// SHEET 3: MATERIALS LIST
// ═══════════════════════════════════════════════════════════════════════════

async function buildMaterialsListSheet(
  workbook: ExcelJS.Workbook,
  doc: any,
  materialCols: MaterialColumn[],
  gtRow: number,
  sheetAreaM2: number,
  fixtures?: Fixture[]
): Promise<number> {
  const ws = workbook.addWorksheet('Materials_List');
  ws.views = [{ showGridLines: false }];

  const materialColumns = materialCols.filter(c => !c.key?.startsWith('_blank'));
  const countOnlyKeys = new Set(materialCols.filter(c => 
    c.calculation_type === 'count_based' || 
    c.calculation_type === 'pair_based' || 
    c.calculation_type === 'set_based'
  ).map(c => c.key || c.id || ''));

  // Track column widths for auto-fit
  const colContentMax: Record<number, number> = {
    1: 0, 2: 4, 3: 14, 4: 36, 5: 8, 6: 14, 7: 14, 8: 12, 9: 30
  };

  function trackWidth(ci: number, text: string) {
    if (text) {
      for (const line of text.split('\n')) {
        colContentMax[ci] = Math.max(colContentMax[ci] || 10, line.length + 3);
      }
    }
  }

  // Seed with headers
  const headers = ['', '#', 'Material ID', 'Description / Specification', 'Unit', 'Total\nQuantity', 'Sheet Size\n(m²)', 'Sheets\nNeeded', 'Remarks'];
  for (let ci = 1; ci <= headers.length; ci++) {
    trackWidth(ci, headers[ci - 1]);
  }

  const LAST_COL = 9;
  let r = 1;

  // Header banner
  ws.getRow(r).height = 5;
  for (let ci = 1; ci <= LAST_COL; ci++) {
    ws.getCell(r, ci).fill = createFill(Colors.GOLD);
  }
  r++;

  ws.getRow(r).height = 36;
  ws.mergeCells(r, 2, r, LAST_COL);
  ws.getCell(r, 2).value = 'MATERIALS LIST · PROJECT TOTAL QUANTITIES';
  ws.getCell(r, 2).font = createFont(14, true, Colors.WHITE);
  ws.getCell(r, 2).fill = createFill(Colors.NAVY);
  ws.getCell(r, 2).alignment = createAlignment('left', 'center');
  ws.getCell(r, 2).border = { bottom: createBorder('medium', Colors.GOLD) };
  for (let ci = 1; ci <= LAST_COL; ci++) {
    ws.getCell(r, ci).fill = createFill(Colors.NAVY);
  }
  r++;

  ws.getRow(r).height = 22;
  ws.mergeCells(r, 2, r, LAST_COL);
  ws.getCell(r, 2).value = `${doc.project || doc.name || ''} · ${doc.location || ''} · TYPE ${doc.kitchen_type || 'N/A'} · ${doc.total_kitchen_units || 0} Units`;
  ws.getCell(r, 2).font = createFont(10, false, Colors.GOLD_LIGHT, true);
  ws.getCell(r, 2).fill = createFill(Colors.MID_BLUE);
  ws.getCell(r, 2).alignment = createAlignment('left', 'center');
  for (let ci = 1; ci <= LAST_COL; ci++) {
    ws.getCell(r, ci).fill = createFill(Colors.MID_BLUE);
  }
  r++;

  ws.getRow(r).height = 4;
  for (let ci = 1; ci <= LAST_COL; ci++) {
    ws.getCell(r, ci).fill = createFill(Colors.GOLD);
  }
  r++;

  ws.getRow(r).height = 20;
  ws.mergeCells(r, 2, r, LAST_COL);
  ws.getCell(r, 2).value = `★ All quantities are live-linked from BOQ_Matrix row ${gtRow}. Edit dimensions in BOQ_Matrix; this sheet updates automatically.`;
  ws.getCell(r, 2).font = createFont(9, false, Colors.MID_GREY, true);
  ws.getCell(r, 2).fill = createFill(Colors.PALE_BLUE);
  ws.getCell(r, 2).alignment = createAlignment('left', 'center');
  for (let ci = 1; ci <= LAST_COL; ci++) {
    ws.getCell(r, ci).fill = createFill(Colors.PALE_BLUE);
  }
  r++;

  ws.getRow(r).height = 8;
  r++;

  // Column headers
  ws.getRow(r).height = 50;
  const headerHdrs = ['', '#', 'Material ID', 'Description / Specification', 'Unit', 'Total\nQuantity', 'Sheet Size\n(m²)', 'Sheets\nNeeded', 'Remarks'];
  for (let ci = 1; ci <= headerHdrs.length; ci++) {
    const cell = ws.getCell(r, ci);
    cell.value = headerHdrs[ci - 1];
    cell.font = createFont(11, true, Colors.WHITE);
    cell.fill = createFill(Colors.MID_BLUE);
    cell.alignment = createAlignment('center', 'center', true);
    cell.border = createThickBorder();
    trackWidth(ci, headerHdrs[ci - 1]);
  }
  r++;

  const materialColumnsList = materialColumns.filter(c => c.key && !c.key.startsWith('_blank'));
  const dataStartRow = r;

  for (let idx = 0; idx < materialColumnsList.length; idx++) {
    const col = materialColumnsList[idx];
    const key = col.key || col.id || '';
    const label = col.display_name || col.label || '';
    const alt = idx % 2 === 0;
    const bg = alt ? Colors.PALE_BLUE : Colors.WHITE;

    ws.getRow(r).height = 22;
    const brd = {
      left: createBorder('thin', alt ? 'FFDDEEFF' : 'FFE8E8E8'),
      right: createBorder('thin', alt ? 'FFDDEEFF' : 'FFE8E8E8'),
      top: createBorder('thin', alt ? 'FFDDEEFF' : 'FFE8E8E8'),
      bottom: createBorder('thin', alt ? 'FFDDEEFF' : 'FFE8E8E8')
    };

    ws.getCell(r, 1).fill = createFill(Colors.GOLD);
    ws.getCell(r, 1).border = { bottom: createBorder('thin', 'FFE8E8E8') };

    ws.getCell(r, 2).value = idx + 1;
    ws.getCell(r, 2).font = createFont(10, true, Colors.NAVY);
    ws.getCell(r, 2).fill = createFill(bg);
    ws.getCell(r, 2).alignment = createAlignment('center', 'center');
    ws.getCell(r, 2).border = { left: createBorder('medium', Colors.GOLD), bottom: brd.bottom };

    ws.getCell(r, 3).value = key;
    ws.getCell(r, 3).font = createFont(9, false, Colors.MID_GREY, true);
    ws.getCell(r, 3).fill = createFill(bg);
    ws.getCell(r, 3).alignment = createAlignment('left', 'center');
    ws.getCell(r, 3).border = brd;
    trackWidth(3, key);

    const labelClean = label.replace(/\n/g, ' ');
    ws.getCell(r, 4).value = labelClean;
    ws.getCell(r, 4).font = createFont(10, false, Colors.DARK_TEXT);
    ws.getCell(r, 4).fill = createFill(bg);
    ws.getCell(r, 4).alignment = createAlignment('left', 'center', true);
    ws.getCell(r, 4).border = brd;
    trackWidth(4, labelClean);

    const isCount = countOnlyKeys.has(key);
    const isLinear = key.toLowerCase().includes('lipping') || key.toLowerCase().includes('lm') || key.toLowerCase().includes('skirting') || key.toLowerCase().includes('runner');
    const isVolume = key.toLowerCase().includes('volume') || key.toLowerCase().includes('timber');
    
    let unitStr = 'M²';
    if (isCount) unitStr = 'Nr / Pr';
    else if (isVolume) unitStr = 'M³';
    else if (isLinear) unitStr = 'LM';
    
    ws.getCell(r, 5).value = unitStr;
    ws.getCell(r, 5).font = createFont(10, false, Colors.MID_GREY);
    ws.getCell(r, 5).fill = createFill(bg);
    ws.getCell(r, 5).alignment = createAlignment('center', 'center');
    ws.getCell(r, 5).border = brd;

    // Link to BOQ_Matrix grand total
    const boqColIndex = MAT_START + idx;
    const boqColLetter = getColumnLetter(boqColIndex);
    ws.getCell(r, 6).value = `=BOQ_Matrix!${boqColLetter}${gtRow}`;
    ws.getCell(r, 6).font = createFont(11, true, Colors.DARK_TEXT);
    ws.getCell(r, 6).fill = createFill(Colors.GREEN_HL);
    ws.getCell(r, 6).alignment = createAlignment('center', 'center');
    ws.getCell(r, 6).border = brd;
    ws.getCell(r, 6).numFmt = '0.000';

    // Sheet size
    if (!isCount && !isLinear && !isVolume) {
      ws.getCell(r, 7).value = sheetAreaM2;
      ws.getCell(r, 7).font = createFont(10, false, Colors.CHARCOAL);
      ws.getCell(r, 7).fill = createFill(Colors.AMBER_HL);
      ws.getCell(r, 7).alignment = createAlignment('center', 'center');
      ws.getCell(r, 7).border = brd;
      ws.getCell(r, 7).numFmt = '0.00';
    } else {
      ws.getCell(r, 7).value = '—';
      ws.getCell(r, 7).font = createFont(10, false, Colors.MID_GREY);
      ws.getCell(r, 7).fill = createFill(bg);
      ws.getCell(r, 7).alignment = createAlignment('center', 'center');
      ws.getCell(r, 7).border = brd;
    }

    // Sheets needed
    if (!isCount && !isLinear && !isVolume) {
      ws.getCell(r, 8).value = `=IFERROR(CEILING(F${r}/G${r},1),"")`;
      ws.getCell(r, 8).font = createFont(11, true, Colors.NAVY);
      ws.getCell(r, 8).fill = createFill(Colors.PALE_BLUE);
      ws.getCell(r, 8).alignment = createAlignment('center', 'center');
      ws.getCell(r, 8).border = brd;
      ws.getCell(r, 8).numFmt = '0';
    } else {
      ws.getCell(r, 8).value = '—';
      ws.getCell(r, 8).font = createFont(10, false, Colors.MID_GREY);
      ws.getCell(r, 8).fill = createFill(bg);
      ws.getCell(r, 8).alignment = createAlignment('center', 'center');
      ws.getCell(r, 8).border = brd;
    }

    const remarks = col.remarks || '';
    ws.getCell(r, 9).value = remarks;
    ws.getCell(r, 9).font = createFont(9, false, Colors.MID_GREY, true);
    ws.getCell(r, 9).fill = createFill(bg);
    ws.getCell(r, 9).alignment = createAlignment('left', 'center', true);
    ws.getCell(r, 9).border = { right: createBorder('medium', Colors.GOLD), bottom: brd.bottom, left: brd.left, top: brd.top };
    trackWidth(9, remarks);

    r++;
  }

  // Fixtures section in Materials_List
  if (fixtures && fixtures.length > 0) {
    ws.getRow(r).height = 8;
    r++;

    ws.getRow(r).height = 30;
    for (let ci = 1; ci <= LAST_COL; ci++) {
      ws.getCell(r, ci).fill = createFill(Colors.CHARCOAL);
      ws.getCell(r, ci).border = {
        top: createBorder('medium', Colors.GOLD),
        bottom: createBorder('medium', Colors.GOLD)
      };
    }
    ws.mergeCells(r, 2, r, LAST_COL);
    ws.getCell(r, 2).value = 'INSTALLED FIXTURES · SCHEDULE OF QUANTITIES';
    ws.getCell(r, 2).font = createFont(11, true, Colors.GOLD_LIGHT);
    ws.getCell(r, 2).fill = createFill(Colors.CHARCOAL);
    ws.getCell(r, 2).alignment = createAlignment('left', 'center');
    r++;

    ws.getRow(r).height = 40;
    const fxHeaders = ['', '#', 'Item No', 'Description', 'Unit', 'Qty / Unit', 'Total Qty\n(Project)', '—', 'Remarks'];
    for (let ci = 1; ci <= fxHeaders.length; ci++) {
      const cell = ws.getCell(r, ci);
      cell.value = fxHeaders[ci - 1];
      cell.font = createFont(10, true, Colors.WHITE);
      cell.fill = createFill(Colors.MID_BLUE);
      cell.alignment = createAlignment('center', 'center', true);
      cell.border = {
        top: createBorder('medium', Colors.GOLD),
        bottom: createBorder('medium', Colors.GOLD),
        left: createBorder('thin', Colors.GOLD_LIGHT),
        right: createBorder('thin', Colors.GOLD_LIGHT)
      };
      trackWidth(ci, fxHeaders[ci - 1]);
    }
    r++;

    let alt = false;
    for (let fxIdx = 0; fxIdx < fixtures.length; fxIdx++) {
      const fx = fixtures[fxIdx];
      const bg = alt ? Colors.PALE_BLUE : Colors.WHITE;
      const borderColor = alt ? 'FFDDEEFF' : 'FFE8E8E8';

      ws.getRow(r).height = 22;
      const brd = {
        left: createBorder('thin', borderColor),
        right: createBorder('thin', borderColor),
        top: createBorder('thin', borderColor),
        bottom: createBorder('thin', borderColor)
      };

      ws.getCell(r, 1).fill = createFill(Colors.GOLD);
      ws.getCell(r, 1).border = { bottom: brd.bottom };

      ws.getCell(r, 2).value = fxIdx + 1;
      ws.getCell(r, 2).font = createFont(10, true, Colors.NAVY);
      ws.getCell(r, 2).fill = createFill(bg);
      ws.getCell(r, 2).alignment = createAlignment('center', 'center');
      ws.getCell(r, 2).border = { left: createBorder('medium', Colors.GOLD), bottom: brd.bottom };

      ws.getCell(r, 3).value = fx.item_number;
      ws.getCell(r, 3).font = createFont(9, false, Colors.MID_GREY, true);
      ws.getCell(r, 3).fill = createFill(bg);
      ws.getCell(r, 3).alignment = createAlignment('left', 'center');
      ws.getCell(r, 3).border = brd;
      trackWidth(3, fx.item_number);

      ws.getCell(r, 4).value = fx.description;
      ws.getCell(r, 4).font = createFont(10, false, Colors.DARK_TEXT);
      ws.getCell(r, 4).fill = createFill(bg);
      ws.getCell(r, 4).alignment = createAlignment('left', 'center', true);
      ws.getCell(r, 4).border = brd;
      trackWidth(4, fx.description);

      ws.getCell(r, 5).value = fx.measurement_unit || 'Each';
      ws.getCell(r, 5).font = createFont(10, false, Colors.MID_GREY);
      ws.getCell(r, 5).fill = createFill(bg);
      ws.getCell(r, 5).alignment = createAlignment('center', 'center');
      ws.getCell(r, 5).border = brd;

      const qtyPerUnit = fx.quantity_per_unit || 1;
      ws.getCell(r, 6).value = qtyPerUnit;
      ws.getCell(r, 6).font = createFont(10, true, Colors.NAVY);
      ws.getCell(r, 6).fill = createFill(Colors.GREEN_HL);
      ws.getCell(r, 6).alignment = createAlignment('center', 'center');
      ws.getCell(r, 6).border = brd;
      ws.getCell(r, 6).numFmt = '0';

      ws.getCell(r, 7).value = `=F${r}*BOQ_Matrix!H2`;
      ws.getCell(r, 7).font = createFont(11, true, Colors.DARK_TEXT);
      ws.getCell(r, 7).fill = createFill(Colors.GREEN_HL);
      ws.getCell(r, 7).alignment = createAlignment('center', 'center');
      ws.getCell(r, 7).border = brd;
      ws.getCell(r, 7).numFmt = '0';

      ws.getCell(r, 8).value = '—';
      ws.getCell(r, 8).font = createFont(10, false, Colors.MID_GREY);
      ws.getCell(r, 8).fill = createFill(bg);
      ws.getCell(r, 8).alignment = createAlignment('center', 'center');
      ws.getCell(r, 8).border = brd;

      ws.getCell(r, 9).value = fx.remarks || '';
      ws.getCell(r, 9).font = createFont(9, false, Colors.MID_GREY, true);
      ws.getCell(r, 9).fill = createFill(bg);
      ws.getCell(r, 9).alignment = createAlignment('left', 'center', true);
      ws.getCell(r, 9).border = { right: createBorder('medium', Colors.GOLD), bottom: brd.bottom, left: brd.left, top: brd.top };
      trackWidth(9, fx.remarks || '');

      alt = !alt;
      r++;
    }
  }

  // Footer
  ws.getRow(r).height = 5;
  for (let ci = 1; ci <= LAST_COL; ci++) {
    ws.getCell(r, ci).fill = createFill(Colors.GOLD);
  }
  r++;

  ws.getRow(r).height = 20;
  ws.mergeCells(r, 2, r, LAST_COL);
  ws.getCell(r, 2).value = `Sheet size basis: ${sheetAreaM2} m² per board · Sheets Needed rounds UP to whole boards · Count/Linear/Volume items show actual quantities.`;
  ws.getCell(r, 2).font = createFont(8, false, Colors.MID_GREY, true);
  ws.getCell(r, 2).fill = createFill(Colors.NAVY);
  ws.getCell(r, 2).alignment = createAlignment('center', 'center');
  for (let ci = 1; ci <= LAST_COL; ci++) {
    ws.getCell(r, ci).fill = createFill(Colors.NAVY);
  }

  // Apply column widths
  for (const [ci, width] of Object.entries(colContentMax)) {
    const colNum = parseInt(ci);
    const minWidths: Record<number, number> = { 1: 0, 2: 5, 3: 14, 4: 36, 5: 8, 6: 14, 7: 14, 8: 12, 9: 30 };
    ws.getColumn(colNum).width = Math.max(width, minWidths[colNum] || 10);
  }
  ws.getColumn(10).width = 0; // Hide column 10

  return dataStartRow;
}

// ═══════════════════════════════════════════════════════════════════════════
// SHEET 4: COST BREAKDOWN
// ═══════════════════════════════════════════════════════════════════════════

async function buildCostBreakdownSheet(
  workbook: ExcelJS.Workbook,
  doc: any,
  materialCols: MaterialColumn[],
  matListDataStartRow: number,
  fixtures?: Fixture[]
): Promise<void> {
  const ws = workbook.addWorksheet('Cost_Breakdown');
  ws.views = [{ showGridLines: false }];

  const materialColumns = materialCols.filter(c => !c.key?.startsWith('_blank'));
  const countOnlyKeys = new Set(materialCols.filter(c => 
    c.calculation_type === 'count_based' || 
    c.calculation_type === 'pair_based' || 
    c.calculation_type === 'set_based'
  ).map(c => c.key || c.id || ''));

  const currency = doc.document_metadata?.currency || 'AED';
  const vatRate = (doc.document_metadata?.vat_percent || 5) / 100;
  const vatPctLabel = `${doc.document_metadata?.vat_percent || 5}%`;

  // Track column widths
  const colContentMax: Record<number, number> = {
    1: 0, 2: 4, 3: 14, 4: 36, 5: 8, 6: 14, 7: 18, 8: 18, 9: 30
  };

  function trackWidth(ci: number, text: string) {
    if (text) {
      for (const line of text.split('\n')) {
        colContentMax[ci] = Math.max(colContentMax[ci] || 10, line.length + 3);
      }
    }
  }

  const headers = ['', '#', 'Material ID', 'Description / Specification', 'Unit', 'Total Qty', `Unit Rate\n(${currency} / unit)`, `Amount\n(${currency})`, 'Notes'];
  for (let ci = 1; ci <= headers.length; ci++) {
    trackWidth(ci, headers[ci - 1]);
  }

  const LAST_COL = 9;
  let r = 1;

  // Header
  ws.getRow(r).height = 5;
  for (let ci = 1; ci <= LAST_COL; ci++) {
    ws.getCell(r, ci).fill = createFill(Colors.GOLD);
  }
  r++;

  ws.getRow(r).height = 36;
  ws.mergeCells(r, 2, r, LAST_COL);
  ws.getCell(r, 2).value = 'COST BREAKDOWN · MATERIAL QUANTITIES × UNIT RATES';
  ws.getCell(r, 2).font = createFont(14, true, Colors.WHITE);
  ws.getCell(r, 2).fill = createFill(Colors.NAVY);
  ws.getCell(r, 2).alignment = createAlignment('left', 'center');
  ws.getCell(r, 2).border = { bottom: createBorder('medium', Colors.GOLD) };
  for (let ci = 1; ci <= LAST_COL; ci++) {
    ws.getCell(r, ci).fill = createFill(Colors.NAVY);
  }
  r++;

  ws.getRow(r).height = 22;
  ws.mergeCells(r, 2, r, LAST_COL);
  ws.getCell(r, 2).value = `${doc.project || doc.name || ''} · ${doc.location || ''} · TYPE ${doc.kitchen_type || 'N/A'} · ${doc.total_kitchen_units || 0} Units · Currency: ${currency} · VAT: ${vatPctLabel}`;
  ws.getCell(r, 2).font = createFont(10, false, Colors.GOLD_LIGHT, true);
  ws.getCell(r, 2).fill = createFill(Colors.MID_BLUE);
  ws.getCell(r, 2).alignment = createAlignment('left', 'center');
  for (let ci = 1; ci <= LAST_COL; ci++) {
    ws.getCell(r, ci).fill = createFill(Colors.MID_BLUE);
  }
  r++;

  ws.getRow(r).height = 4;
  for (let ci = 1; ci <= LAST_COL; ci++) {
    ws.getCell(r, ci).fill = createFill(Colors.GOLD);
  }
  r++;

  ws.getRow(r).height = 20;
  ws.mergeCells(r, 2, r, LAST_COL);
  ws.getCell(r, 2).value = '★ Unit rates in column G are pre-filled where cost data exists in the source JSON. Amber cells = contractor to fill. Green cells = rate from data. Amount = Total Qty × Unit Rate.';
  ws.getCell(r, 2).font = createFont(9, false, Colors.MID_GREY, true);
  ws.getCell(r, 2).fill = createFill(Colors.PALE_BLUE);
  ws.getCell(r, 2).alignment = createAlignment('left', 'center');
  for (let ci = 1; ci <= LAST_COL; ci++) {
    ws.getCell(r, ci).fill = createFill(Colors.PALE_BLUE);
  }
  r++;

  ws.getRow(r).height = 8;
  r++;

  // Column headers
  ws.getRow(r).height = 50;
  const costHeaders = ['', '#', 'Material ID', 'Description / Specification', 'Unit', 'Total Qty', `Unit Rate\n(${currency} / unit)`, `Amount\n(${currency})`, 'Notes'];
  for (let ci = 1; ci <= costHeaders.length; ci++) {
    const cell = ws.getCell(r, ci);
    cell.value = costHeaders[ci - 1];
    cell.font = createFont(11, true, Colors.WHITE);
    cell.fill = createFill(Colors.MID_BLUE);
    cell.alignment = createAlignment('center', 'center', true);
    cell.border = createThickBorder();
    trackWidth(ci, costHeaders[ci - 1]);
  }
  r++;

  const firstDataRow = r;
  const amountRows: number[] = [];

  for (let idx = 0; idx < materialColumns.length; idx++) {
    const col = materialColumns[idx];
    const key = col.key || col.id || '';
    const label = col.display_name || col.label || '';
    const alt = idx % 2 === 0;
    const bg = alt ? Colors.PALE_BLUE : Colors.WHITE;

    ws.getRow(r).height = 22;
    const brd = {
      left: createBorder('thin', alt ? 'FFDDEEFF' : 'FFE8E8E8'),
      right: createBorder('thin', alt ? 'FFDDEEFF' : 'FFE8E8E8'),
      top: createBorder('thin', alt ? 'FFDDEEFF' : 'FFE8E8E8'),
      bottom: createBorder('thin', alt ? 'FFDDEEFF' : 'FFE8E8E8')
    };

    ws.getCell(r, 1).fill = createFill(Colors.GOLD);
    ws.getCell(r, 1).border = { bottom: brd.bottom };

    ws.getCell(r, 2).value = idx + 1;
    ws.getCell(r, 2).font = createFont(10, true, Colors.NAVY);
    ws.getCell(r, 2).fill = createFill(bg);
    ws.getCell(r, 2).alignment = createAlignment('center', 'center');
    ws.getCell(r, 2).border = { left: createBorder('medium', Colors.GOLD), bottom: brd.bottom };

    ws.getCell(r, 3).value = key;
    ws.getCell(r, 3).font = createFont(9, false, Colors.MID_GREY, true);
    ws.getCell(r, 3).fill = createFill(bg);
    ws.getCell(r, 3).alignment = createAlignment('left', 'center');
    ws.getCell(r, 3).border = brd;
    trackWidth(3, key);

    const labelClean = label.replace(/\n/g, ' ');
    ws.getCell(r, 4).value = labelClean;
    ws.getCell(r, 4).font = createFont(10, false, Colors.DARK_TEXT);
    ws.getCell(r, 4).fill = createFill(bg);
    ws.getCell(r, 4).alignment = createAlignment('left', 'center', true);
    ws.getCell(r, 4).border = brd;
    trackWidth(4, labelClean);

    const isCount = countOnlyKeys.has(key);
    const isLinear = key.toLowerCase().includes('lipping') || key.toLowerCase().includes('lm') || key.toLowerCase().includes('skirting');
    const isVolume = key.toLowerCase().includes('volume') || key.toLowerCase().includes('timber');
    
    let unitStr = 'M²';
    if (isCount) unitStr = 'Nr / Pr';
    else if (isVolume) unitStr = 'M³';
    else if (isLinear) unitStr = 'LM';
    
    ws.getCell(r, 5).value = unitStr;
    ws.getCell(r, 5).font = createFont(10, false, Colors.MID_GREY);
    ws.getCell(r, 5).fill = createFill(bg);
    ws.getCell(r, 5).alignment = createAlignment('center', 'center');
    ws.getCell(r, 5).border = brd;

    // Link to Materials_List total quantity
    const matQtyRow = matListDataStartRow + idx;
    ws.getCell(r, 6).value = `=Materials_List!F${matQtyRow}`;
    ws.getCell(r, 6).font = createFont(11, true, Colors.DARK_TEXT);
    ws.getCell(r, 6).fill = createFill(Colors.GREEN_HL);
    ws.getCell(r, 6).alignment = createAlignment('center', 'center');
    ws.getCell(r, 6).border = brd;
    ws.getCell(r, 6).numFmt = '0.000';

    // Unit rate (from JSON or editable)
    const unitRate = col.unit_rate;
    const hasRate = unitRate !== undefined && unitRate !== null;
    ws.getCell(r, 7).value = hasRate ? unitRate : null;
    ws.getCell(r, 7).font = createFont(11, hasRate, hasRate ? Colors.DARK_TEXT : Colors.NAVY);
    ws.getCell(r, 7).fill = createFill(hasRate ? Colors.GREEN_HL : Colors.AMBER_HL);
    ws.getCell(r, 7).alignment = createAlignment('center', 'center');
    ws.getCell(r, 7).border = {
      left: createBorder('medium', Colors.GOLD),
      right: createBorder('medium', Colors.GOLD),
      top: createBorder('thin', Colors.GOLD),
      bottom: createBorder('thin', Colors.GOLD)
    };
    ws.getCell(r, 7).numFmt = `"${currency} "#,##0.00`;

    // Amount
    ws.getCell(r, 8).value = `=IFERROR(F${r}*G${r},"")`;
    ws.getCell(r, 8).font = createFont(11, true, Colors.NAVY);
    ws.getCell(r, 8).fill = createFill(Colors.PALE_BLUE);
    ws.getCell(r, 8).alignment = createAlignment('center', 'center');
    ws.getCell(r, 8).border = brd;
    ws.getCell(r, 8).numFmt = `"${currency} "#,##0.00`;
    amountRows.push(r);

    const remarks = col.remarks || '';
    ws.getCell(r, 9).value = remarks;
    ws.getCell(r, 9).font = createFont(9, false, Colors.MID_GREY, true);
    ws.getCell(r, 9).fill = createFill(bg);
    ws.getCell(r, 9).alignment = createAlignment('left', 'center', true);
    ws.getCell(r, 9).border = { right: createBorder('medium', Colors.GOLD), bottom: brd.bottom, left: brd.left, top: brd.top };
    trackWidth(9, remarks);

    r++;
  }

  // Fixtures section in Cost Breakdown
  const fixtureAmountRows: number[] = [];
  if (fixtures && fixtures.length > 0) {
    ws.getRow(r).height = 8;
    r++;

    ws.getRow(r).height = 30;
    for (let ci = 1; ci <= LAST_COL; ci++) {
      ws.getCell(r, ci).fill = createFill(Colors.CHARCOAL);
      ws.getCell(r, ci).border = {
        top: createBorder('medium', Colors.GOLD),
        bottom: createBorder('medium', Colors.GOLD)
      };
    }
    ws.mergeCells(r, 2, r, LAST_COL);
    ws.getCell(r, 2).value = 'INSTALLED FIXTURES · SUPPLY & INSTALLATION RATES';
    ws.getCell(r, 2).font = createFont(11, true, Colors.GOLD_LIGHT);
    ws.getCell(r, 2).fill = createFill(Colors.CHARCOAL);
    ws.getCell(r, 2).alignment = createAlignment('left', 'center');
    r++;

    ws.getRow(r).height = 48;
    const fxHeaders = ['', '#', 'Item No', 'Description', 'Unit', 'Total Qty', `Unit Rate\n(${currency} / unit)`, `Amount\n(${currency})`, 'Notes'];
    for (let ci = 1; ci <= fxHeaders.length; ci++) {
      const cell = ws.getCell(r, ci);
      cell.value = fxHeaders[ci - 1];
      cell.font = createFont(10, true, Colors.WHITE);
      cell.fill = createFill(Colors.MID_BLUE);
      cell.alignment = createAlignment('center', 'center', true);
      cell.border = {
        top: createBorder('medium', Colors.GOLD),
        bottom: createBorder('medium', Colors.GOLD),
        left: createBorder('thin', Colors.GOLD_LIGHT),
        right: createBorder('thin', Colors.GOLD_LIGHT)
      };
      trackWidth(ci, fxHeaders[ci - 1]);
    }
    r++;

    const fxMatListStart = matListDataStartRow + materialColumns.length + 3;

    let alt = false;
    for (let fxIdx = 0; fxIdx < fixtures.length; fxIdx++) {
      const fx = fixtures[fxIdx];
      const bg = alt ? Colors.PALE_BLUE : Colors.WHITE;
      const borderColor = alt ? 'FFDDEEFF' : 'FFE8E8E8';

      ws.getRow(r).height = 22;
      const brd = {
        left: createBorder('thin', borderColor),
        right: createBorder('thin', borderColor),
        top: createBorder('thin', borderColor),
        bottom: createBorder('thin', borderColor)
      };

      ws.getCell(r, 1).fill = createFill(Colors.GOLD);
      ws.getCell(r, 1).border = { bottom: brd.bottom };

      ws.getCell(r, 2).value = fxIdx + 1;
      ws.getCell(r, 2).font = createFont(10, true, Colors.NAVY);
      ws.getCell(r, 2).fill = createFill(bg);
      ws.getCell(r, 2).alignment = createAlignment('center', 'center');
      ws.getCell(r, 2).border = { left: createBorder('medium', Colors.GOLD), bottom: brd.bottom };

      ws.getCell(r, 3).value = fx.item_number;
      ws.getCell(r, 3).font = createFont(9, false, Colors.MID_GREY, true);
      ws.getCell(r, 3).fill = createFill(bg);
      ws.getCell(r, 3).alignment = createAlignment('left', 'center');
      ws.getCell(r, 3).border = brd;
      trackWidth(3, fx.item_number);

      ws.getCell(r, 4).value = fx.description;
      ws.getCell(r, 4).font = createFont(10, false, Colors.DARK_TEXT);
      ws.getCell(r, 4).fill = createFill(bg);
      ws.getCell(r, 4).alignment = createAlignment('left', 'center', true);
      ws.getCell(r, 4).border = brd;
      trackWidth(4, fx.description);

      ws.getCell(r, 5).value = fx.measurement_unit || 'Each';
      ws.getCell(r, 5).font = createFont(10, false, Colors.MID_GREY);
      ws.getCell(r, 5).fill = createFill(bg);
      ws.getCell(r, 5).alignment = createAlignment('center', 'center');
      ws.getCell(r, 5).border = brd;

      // Link to Materials_List fixture total quantity
      const fxRow = fxMatListStart + fxIdx;
      ws.getCell(r, 6).value = `=Materials_List!G${fxRow}`;
      ws.getCell(r, 6).font = createFont(11, true, Colors.DARK_TEXT);
      ws.getCell(r, 6).fill = createFill(Colors.GREEN_HL);
      ws.getCell(r, 6).alignment = createAlignment('center', 'center');
      ws.getCell(r, 6).border = brd;
      ws.getCell(r, 6).numFmt = '0';

      const fxRate = fx.unit_rate;
      const hasRate = fxRate !== undefined && fxRate !== null;
      ws.getCell(r, 7).value = hasRate ? fxRate : null;
      ws.getCell(r, 7).font = createFont(11, hasRate, hasRate ? Colors.DARK_TEXT : Colors.NAVY);
      ws.getCell(r, 7).fill = createFill(hasRate ? Colors.GREEN_HL : Colors.AMBER_HL);
      ws.getCell(r, 7).alignment = createAlignment('center', 'center');
      ws.getCell(r, 7).border = {
        left: createBorder('medium', Colors.GOLD),
        right: createBorder('medium', Colors.GOLD),
        top: createBorder('thin', Colors.GOLD),
        bottom: createBorder('thin', Colors.GOLD)
      };
      ws.getCell(r, 7).numFmt = `"${currency} "#,##0.00`;

      ws.getCell(r, 8).value = `=IFERROR(F${r}*G${r},"")`;
      ws.getCell(r, 8).font = createFont(11, true, Colors.NAVY);
      ws.getCell(r, 8).fill = createFill(Colors.PALE_BLUE);
      ws.getCell(r, 8).alignment = createAlignment('center', 'center');
      ws.getCell(r, 8).border = brd;
      ws.getCell(r, 8).numFmt = `"${currency} "#,##0.00`;
      fixtureAmountRows.push(r);

      ws.getCell(r, 9).value = fx.remarks || '';
      ws.getCell(r, 9).font = createFont(9, false, Colors.MID_GREY, true);
      ws.getCell(r, 9).fill = createFill(bg);
      ws.getCell(r, 9).alignment = createAlignment('left', 'center', true);
      ws.getCell(r, 9).border = { right: createBorder('medium', Colors.GOLD), bottom: brd.bottom, left: brd.left, top: brd.top };
      trackWidth(9, fx.remarks || '');

      alt = !alt;
      r++;
    }

    ws.getRow(r).height = 8;
    r++;
  }

  // Summary rows (Subtotal, VAT, Grand Total)
  const allAmountRows = [...amountRows, ...fixtureAmountRows];
  if (allAmountRows.length > 0) {
    const sumParts = allAmountRows.map(row => `IFERROR(H${row},0)`).join('+');
    const subRow = r;
    
    ws.getRow(subRow).height = 28;
    for (let ci = 1; ci <= LAST_COL; ci++) {
      ws.getCell(subRow, ci).fill = createFill(Colors.CHARCOAL);
    }
    ws.mergeCells(subRow, 3, subRow, 7);
    ws.getCell(subRow, 3).value = 'SUBTOTAL (excl. VAT)';
    ws.getCell(subRow, 3).font = createFont(12, true, Colors.WHITE);
    ws.getCell(subRow, 3).fill = createFill(Colors.CHARCOAL);
    ws.getCell(subRow, 3).alignment = createAlignment('right', 'center');
    ws.getCell(subRow, 3).border = {
      top: createBorder('medium', Colors.GOLD),
      bottom: createBorder('medium', Colors.GOLD)
    };
    ws.getCell(subRow, 8).value = `=${sumParts}`;
    ws.getCell(subRow, 8).font = createFont(13, true, Colors.GOLD);
    ws.getCell(subRow, 8).fill = createFill(Colors.CHARCOAL);
    ws.getCell(subRow, 8).alignment = createAlignment('center', 'center');
    ws.getCell(subRow, 8).border = {
      left: createBorder('medium', Colors.GOLD),
      right: createBorder('medium', Colors.GOLD),
      top: createBorder('medium', Colors.GOLD),
      bottom: createBorder('medium', Colors.GOLD)
    };
    ws.getCell(subRow, 8).numFmt = `"${currency} "#,##0.00`;
    r++;

    const vatRow = r;
    ws.getRow(vatRow).height = 28;
    for (let ci = 1; ci <= LAST_COL; ci++) {
      ws.getCell(vatRow, ci).fill = createFill(Colors.MID_BLUE);
    }
    ws.mergeCells(vatRow, 3, vatRow, 7);
    ws.getCell(vatRow, 3).value = `VAT (${vatPctLabel})`;
    ws.getCell(vatRow, 3).font = createFont(12, true, Colors.GOLD_LIGHT);
    ws.getCell(vatRow, 3).fill = createFill(Colors.MID_BLUE);
    ws.getCell(vatRow, 3).alignment = createAlignment('right', 'center');
    ws.getCell(vatRow, 3).border = {
      top: createBorder('medium', Colors.GOLD),
      bottom: createBorder('medium', Colors.GOLD)
    };
    ws.getCell(vatRow, 8).value = `=H${subRow}*${vatRate}`;
    ws.getCell(vatRow, 8).font = createFont(13, true, Colors.GOLD_LIGHT);
    ws.getCell(vatRow, 8).fill = createFill(Colors.MID_BLUE);
    ws.getCell(vatRow, 8).alignment = createAlignment('center', 'center');
    ws.getCell(vatRow, 8).border = {
      left: createBorder('medium', Colors.GOLD),
      right: createBorder('medium', Colors.GOLD),
      top: createBorder('medium', Colors.GOLD),
      bottom: createBorder('medium', Colors.GOLD)
    };
    ws.getCell(vatRow, 8).numFmt = `"${currency} "#,##0.00`;
    r++;

    const grandRow = r;
    ws.getRow(grandRow).height = 34;
    for (let ci = 1; ci <= LAST_COL; ci++) {
      ws.getCell(grandRow, ci).fill = createFill(Colors.NAVY);
    }
    ws.mergeCells(grandRow, 3, grandRow, 7);
    ws.getCell(grandRow, 3).value = 'GRAND TOTAL (incl. VAT)';
    ws.getCell(grandRow, 3).font = createFont(12, true, Colors.WHITE);
    ws.getCell(grandRow, 3).fill = createFill(Colors.NAVY);
    ws.getCell(grandRow, 3).alignment = createAlignment('right', 'center');
    ws.getCell(grandRow, 3).border = {
      top: createBorder('medium', Colors.GOLD),
      bottom: createBorder('medium', Colors.GOLD)
    };
    ws.getCell(grandRow, 8).value = `=H${subRow}+H${vatRow}`;
    ws.getCell(grandRow, 8).font = createFont(14, true, Colors.GOLD);
    ws.getCell(grandRow, 8).fill = createFill(Colors.NAVY);
    ws.getCell(grandRow, 8).alignment = createAlignment('center', 'center');
    ws.getCell(grandRow, 8).border = {
      left: createBorder('medium', Colors.GOLD),
      right: createBorder('medium', Colors.GOLD),
      top: createBorder('medium', Colors.GOLD),
      bottom: createBorder('medium', Colors.GOLD)
    };
    ws.getCell(grandRow, 8).numFmt = `"${currency} "#,##0.00`;
    r++;
  }

  // Footer
  ws.getRow(r).height = 5;
  for (let ci = 1; ci <= LAST_COL; ci++) {
    ws.getCell(r, ci).fill = createFill(Colors.GOLD);
  }
  r++;

  ws.getRow(r).height = 20;
  ws.mergeCells(r, 2, r, LAST_COL);
  ws.getCell(r, 2).value = `Rates to be provided by tendering contractor. All quantities are indicative and subject to field verification. Currency: ${currency} · VAT @ ${vatPctLabel}`;
  ws.getCell(r, 2).font = createFont(8, false, Colors.MID_GREY, true);
  ws.getCell(r, 2).fill = createFill(Colors.NAVY);
  ws.getCell(r, 2).alignment = createAlignment('center', 'center');
  for (let ci = 1; ci <= LAST_COL; ci++) {
    ws.getCell(r, ci).fill = createFill(Colors.NAVY);
  }

  // Apply column widths
  for (const [ci, width] of Object.entries(colContentMax)) {
    const colNum = parseInt(ci);
    const minWidths: Record<number, number> = { 1: 0, 2: 5, 3: 14, 4: 36, 5: 8, 6: 14, 7: 18, 8: 18, 9: 30 };
    ws.getColumn(colNum).width = Math.max(width, minWidths[colNum] || 10);
  }
  ws.getColumn(10).width = 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// SHARED: BUILD WORKBOOK (server-safe, no browser APIs)
// ═══════════════════════════════════════════════════════════════════════════

export async function buildWorkbook(data?: BOQData): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  const boqData = data || getMockBOQData();

  const doc = boqData.project_info;
  const sections = boqData.kitchen_sections || boqData.sections || [];
  const fixtures = boqData.installed_fixtures || [];
  const sectionMap = boqData.section_grouping || {};
  const materialColumns = boqData.material_columns || [];
  const calcRules = boqData.calculation_rules || {};
  const unitCategories = calcRules.unit_type_mapping || getDefaultUnitCategories();
  const outputOptions = calcRules.excel_formatting || {};
  const sheetAreaM2 = calcRules.sheet_area_square_meters || 2.88;

  const transformedDoc = {
    ...doc,
    project: doc.name,
    document_metadata: doc.document_metadata || {},
    material_detection_rules: boqData.material_identification || {},
    additional_notes: boqData.additional_notes || {},
    drawings: boqData.drawings || [],
  };

  workbook.creator = 'BOQ Export System';
  workbook.created = new Date();

  await buildSummarySheet(workbook, transformedDoc, sections, sectionMap);

  const gtRow = await buildBOQMatrixSheet(
    workbook, transformedDoc, sections, fixtures, sectionMap,
    materialColumns, sheetAreaM2, outputOptions, unitCategories
  );

  const matListStartRow = await buildMaterialsListSheet(
    workbook, transformedDoc, materialColumns, gtRow, sheetAreaM2, fixtures
  );

  await buildCostBreakdownSheet(
    workbook, transformedDoc, materialColumns, matListStartRow, fixtures
  );

  return workbook;
}

// ═══════════════════════════════════════════════════════════════════════════
// BROWSER EXPORT — triggers file download (client-side only)
// ═══════════════════════════════════════════════════════════════════════════

export async function exportToExcel(data?: BOQData): Promise<void> {
  const workbook = await buildWorkbook(data);
  const boqData = data || getMockBOQData();
  const doc = boqData.project_info;

  const dateStr = new Date().toISOString().split('T')[0];
  const safeName = (doc.name || 'boq')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
  const filename = `BOQ_${safeName}_${dateStr}.xlsx`;

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
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
  BOQData,
  ProjectInfo,
  KitchenSection,
  Component,
  MatrixItem,
  Fixture,
  MaterialColumn,
  CalculationRules,
};
import { unitRateOf } from '@/lib/takeoff/materialRate';
// ─── lib/boqMapping.ts ────────────────────────────────────────────────────────
//
//  Maps ProjectState (TakeoffContext) → BOQData (Excel export JSON schema)
//
//  FUTURE ADDITIONS are marked with: // [FUTURE: description]
//  These require new fields on TakeoffRow or ProjectState before they work.
//
// ─────────────────────────────────────────────────────────────────────────────

import { ProjectState } from '@/context/TakeoffContext';

// ─── BOQ output types ─────────────────────────────────────────────────────────

export type BOQMaterialColumn = {
  id:               string;
  display_name:     string;
  calculation_type: string;
  column_width:     number;
  unit_rate:        number;
  remarks:          string;
};

export type BOQItem = {
  item_number:      string;
  description:      string;
  specification:    string;   // from child.notes
  material:         string;   // [FUTURE: TakeoffRow.materialId] — currently ''
  measurement_unit: string;
  panel_count:      number | null;   // [FUTURE: TakeoffRow.panelCount]
  qty_formula:      string;          // [FUTURE: TakeoffRow.qtyFormula]
  qty_per_unit:     number;
  remarks:          string;
  // [FUTURE: TakeoffRow.laminateCoverageM2] → laminate_coverage_m2
  // [FUTURE: TakeoffRow.isFixture]          → moves row to installed_fixtures[]
};

export type BOQComponent = {
  component_id:   string;
  component_name: string;
  component_type: string;
  items:          BOQItem[];
  // [FUTURE: TakeoffRow.dimensions] → dimensions: { L, W, H }
};

export type BOQSection = {
  section_id:        string;
  title:             string;
  drawing_reference: string;
  notes:             string;
  components:        BOQComponent[];
};

export type BOQFixture = {
  item_number:        string;
  description:        string;
  specification:      string;
  measurement_unit:   string;
  quantity_per_unit:  number;
  assigned_material:  string;
  unit_rate:          number;
  remarks:            string;
};

export type BOQData = {
  project_info: {
    name:                string | undefined;
    location:            string | undefined;
    phase:               string | undefined;
    kitchen_type:        string | undefined;
    total_kitchen_units: number;
    document_metadata: {
      title:       string | undefined;
      date:        string | undefined;
      revision:    string | undefined;
      currency:    string;
      vat_percent: number;
    };
    stakeholders: {
      main_contractor:   string | undefined;
      design_consultant: string | undefined;
      supervision:       string | undefined;
      // [FUTURE: ProjectState.stakeholders.client]         → client
      // [FUTURE: ProjectState.stakeholders.projectManager] → project_manager
    };
    drawings: string[];
  };
  calculation_rules: {
    sheet_area_square_meters: number;
    unit_type_mapping: Record<string, string[]>;
  };
  material_columns:  BOQMaterialColumn[];
  sections:          BOQSection[];
  installed_fixtures: BOQFixture[];   // [FUTURE: populated from isFixture rows]
  additional_notes: {
    general_assumptions: { id: number; category: string; content: string }[];
    excluded_from_scope: { id: number; item: string; reason: string }[];
  };
};

// ─── Unit → calculation_type ──────────────────────────────────────────────────

export function unitToCalcType(unit: string): string {
  const u = (unit ?? '').toLowerCase().trim();
  if (['m²', 'm2', 'sqm', 'sq m'].includes(u))  return 'area_based';
  if (['m³', 'm3', 'cu m'].includes(u))           return 'volume_based';
  if (['m', 'lm', 'l m'].includes(u))             return 'linear_based';
  if (['pr', 'pair'].includes(u))                  return 'pair_based';
  if (['set', 'kit', 'box'].includes(u))           return 'set_based';
  return 'count_based';  // Nr, nos, PC, pcs, Each, sets, assembly, each...
}

// ─── Section letter from index ────────────────────────────────────────────────

function sectionLetter(i: number): string {
  return String.fromCharCode(65 + (i % 26));
}

// ─── Main mapping function ────────────────────────────────────────────────────

export function contextToBOQData(ps: Pick<ProjectState, 'projectName' | 'measurements' | 'materials'> & Partial<ProjectState>): BOQData {

  // ── 1. Material columns from library ───────────────────────────────────────
  //       MaterialLibrary stores: id, name, unit, materialCost, laborCost, equipmentCost
  //       [FUTURE: add column_width, display_name override, spacer flag to Material type]
  const material_columns: BOQMaterialColumn[] = (ps.materials as any[]).map(m => ({
    id:               m.id,
    display_name:     m.name,
    calculation_type: unitToCalcType(m.unit ?? ''),
    column_width:     16,
    unit_rate:        unitRateOf(m),
    remarks:          `Per ${m.unit ?? 'unit'} supplied`,
  }));

  // ── 2. Fixtures ─────────────────────────────────────────────────────────────
  //       [FUTURE: TakeoffRow.isFixture = true] — currently empty
  //       When isFixture is added, filter these out before building components
  //       and map them here instead.
  const installed_fixtures: BOQFixture[] = (ps.measurements as any[])
    .filter(m => m.isFixture === true && !m.isGroupHeader)
    .map((m, i) => ({
      item_number:       `F${i + 1}`,
      description:       m.description || m.label || '',
      specification:     m.notes || '',
      measurement_unit:  m.unit || 'Each',
      quantity_per_unit: m.quantity ?? 1,
      assigned_material: m.materialId || '',   // [FUTURE: TakeoffRow.materialId]
      unit_rate:         m.unitRate ?? 0,
      remarks:           m.notes || '',
    }));

  // ── 3. Components: group headers → component, children → items ──────────────
  //       Hierarchy: isGroupHeader row = component, childIds rows = items
  //       Standalone rows (no group) → misc component

  const fixtureIds = new Set(installed_fixtures.map((_, i) =>
    (ps.measurements as any[]).filter(m => m.isFixture === true)[i]?.id
  ));

  const groupHeaders = ps.measurements.filter(
    m => m.isGroupHeader && !fixtureIds.has(m.id)
  );

  // Anything not inside an existing group header is standalone — including
  // children whose header was deleted (previously these were silently dropped).
  const headerIds = new Set(groupHeaders.map(h => h.id));
  const childOfHeader = new Set(groupHeaders.flatMap(h => h.childIds ?? []));
  const standaloneItems = ps.measurements.filter(
    m =>
      !m.isGroupHeader &&
      !(m.parentId && headerIds.has(m.parentId)) &&
      !childOfHeader.has(m.id) &&
      !(m as any).isFixture
  );

  const components: BOQComponent[] = [

    ...groupHeaders.map((group, gi) => {
      const children = ps.measurements.filter(
        m =>
          (m.parentId === group.id || (group.childIds ?? []).includes(m.id)) &&
          !(m as any).isFixture
      );

      return {
        component_id:   group.id,
        component_name: (group as any).groupName || group.description || group.label || 'Unnamed Group',
        component_type: (group as any).groupType || 'general',

        // [FUTURE: group.dimensions] → dimensions: { L, W, H }

        items: children.map((child, ci) => ({
          item_number:      `${sectionLetter(gi)}${ci + 1}`,
          description:      child.description || child.label || '',
          specification:    child.notes || '',

          // [FUTURE: TakeoffRow.materialId] — links to material_columns[].id
          material:         (child as any).materialId || '',

          measurement_unit: child.unit || '',

          // [FUTURE: TakeoffRow.panelCount]
          panel_count:      (child as any).panelCount ?? null,

          // [FUTURE: TakeoffRow.qtyFormula] — e.g. "L × W × 2"
          qty_formula:      (child as any).qtyFormula || '',

          qty_per_unit:     child.quantity ?? 0,
          remarks:          child.notes || '',

          // [FUTURE: TakeoffRow.laminateCoverageM2] → laminate_coverage_m2
        })),
      };
    }),

    // Standalone rows → misc component
    ...(standaloneItems.length > 0
      ? [{
          component_id:   'misc',
          component_name: 'Miscellaneous',
          component_type: 'general',
          items: standaloneItems.map((m, i) => ({
            item_number:      `MISC.${i + 1}`,
            description:      m.description || m.label || '',
            specification:    m.notes || '',
            material:         (m as any).materialId || '',
            measurement_unit: m.unit || '',
            panel_count:      (m as any).panelCount ?? null,
            qty_formula:      (m as any).qtyFormula || '',
            qty_per_unit:     m.quantity ?? 0,
            remarks:          m.notes || '',
          })),
        }]
      : []
    ),
  ];

  // ── 4. One section containing all components ────────────────────────────────
  //       [FUTURE: TakeoffRow.sectionId] — user-assigned section per group header
  //       When sectionId is added, group components by sectionId here instead
  //       of putting everything in one section.
  const sections: BOQSection[] = [{
    section_id:        'A',
    title:             ps.documentTitle || ps.projectName || 'Bill of Quantities',
    drawing_reference: (ps.drawingReferences ?? [])[0] ?? '',
    notes:             '',
    components,
  }];

  // ── 5. Assemble final BOQData ───────────────────────────────────────────────
  return {
    project_info: {
      name:                ps.projectName,
      location:            ps.projectLocation,
      phase:               ps.projectPhase,
      kitchen_type:        ps.kitchenType,
      total_kitchen_units: ps.totalUnits ?? 1,
      document_metadata: {
        title:       ps.documentTitle,
        date:        ps.documentDate,
        revision:    ps.revision,
        currency:    ps.currency    || 'AED',
        vat_percent: ps.vatPercent  ?? 0,
      },
      stakeholders: {
        main_contractor:   ps.stakeholders?.mainContractor,
        design_consultant: ps.stakeholders?.designConsultant,
        supervision:       ps.stakeholders?.supervision,
        // [FUTURE: ps.stakeholders?.client]
        // [FUTURE: ps.stakeholders?.projectManager]
      },
      drawings: ps.drawingReferences ?? [],
    },

    calculation_rules: {
      sheet_area_square_meters: 2.88,
      unit_type_mapping: {
        area_based:   ['M²', 'm2', 'SQ M', 'SQM'],
        volume_based: ['M³', 'm3', 'CU M'],
        linear_based: ['LM', 'lm', 'L M', 'M', 'm'],
        count_based:  ['Nr', 'nos', 'PC', 'pcs', 'Each', 'sets', 'assembly', 'each'],
        pair_based:   ['Pr', 'Pair'],
        set_based:    ['Set', 'Kit', 'Box'],
      },
    },

    material_columns,
    sections,
    installed_fixtures,

    additional_notes: {
      general_assumptions: (ps.generalAssumptions ?? []).map(a => ({
        id:       a.id,
        category: a.category,
        content:  a.content,
      })),
      excluded_from_scope: (ps.excludedItems ?? []).map(e => ({
        id:     e.id,
        item:   e.item,
        reason: e.reason,
      })),
    },
  };
}
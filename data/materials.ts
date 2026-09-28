// ─── data/materials.ts ───────────────────────────────────────────────────────
//
//  Built-in material catalogue, organised by CSI MasterFormat division (the
//  standard classification used in BOQs and specifications).
//
//  • Every new project starts with a copy of this catalogue in its material
//    bank; projects with an empty bank get it when they're opened.
//  • Items can be edited, added or deleted per project in the material bank.
//  • Rates are 0 on purpose: prices vary by region, supplier and date, so set
//    your own in the material bank (or load them from a database later).
//
//  Moving to a database later: keep `loadMaterialCatalog()`'s signature and
//  fetch from your API inside it — callers already treat it as async.
// ─────────────────────────────────────────────────────────────────────────────

import type { Material } from '@/types';

export interface MaterialCategory {
  /** Two-digit MasterFormat division, e.g. "06". */
  code: string;
  name: string;
}

export const MATERIAL_CATEGORIES: MaterialCategory[] = [
  { code: '01', name: 'General Requirements' },
  { code: '02', name: 'Existing Conditions' },
  { code: '03', name: 'Concrete' },
  { code: '04', name: 'Masonry' },
  { code: '05', name: 'Metals' },
  { code: '06', name: 'Wood, Plastics & Composites' },
  { code: '07', name: 'Thermal & Moisture Protection' },
  { code: '08', name: 'Openings' },
  { code: '09', name: 'Finishes' },
  { code: '10', name: 'Specialties' },
  { code: '11', name: 'Equipment' },
  { code: '12', name: 'Furnishings' },
  { code: '13', name: 'Special Construction' },
  { code: '14', name: 'Conveying Equipment' },
  { code: '21', name: 'Fire Suppression' },
  { code: '22', name: 'Plumbing' },
  { code: '23', name: 'HVAC' },
  { code: '26', name: 'Electrical' },
  { code: '27', name: 'Communications' },
  { code: '28', name: 'Electronic Safety & Security' },
  { code: '31', name: 'Earthwork' },
  { code: '32', name: 'Exterior Improvements' },
  { code: '33', name: 'Utilities' },
];

/** "06 - Wood, Plastics & Composites" — the label stored on each material. */
export const categoryLabel = (c: MaterialCategory) => `${c.code} - ${c.name}`;

// [MasterFormat section, name, unit]
type Row = [string, string, string];

const CATALOG: Record<string, Row[]> = {
  '01': [
    ['01 71 23', 'Setting out and site survey', 'sum'],
    ['01 50 00', 'Temporary site facilities (office, stores, welfare)', 'sum'],
    ['01 51 00', 'Temporary electricity and water', 'sum'],
    ['01 56 26', 'Temporary hoarding / site fencing', 'm'],
    ['01 54 23', 'Scaffolding', 'm²'],
    ['01 74 13', 'Progress and final cleaning', 'm²'],
    ['01 74 19', 'Construction waste removal', 'm³'],
    ['01 45 00', 'Material testing and quality control', 'sum'],
  ],
  '02': [
    ['02 41 16', 'Demolition of structures', 'm³'],
    ['02 41 19', 'Selective demolition — walls', 'm²'],
    ['02 41 19', 'Selective demolition — floor finishes', 'm²'],
    ['02 41 19', 'Remove existing doors and windows', 'EA'],
    ['02 41 19', 'Strip out existing kitchen / joinery', 'm'],
    ['02 32 00', 'Geotechnical investigation (borehole)', 'EA'],
  ],
  '03': [
    ['03 11 13', 'Formwork — foundations and ground beams', 'm²'],
    ['03 11 13', 'Formwork — columns', 'm²'],
    ['03 11 13', 'Formwork — beams and slab soffits', 'm²'],
    ['03 21 00', 'Reinforcement bars — high yield, T10–T25', 'kg'],
    ['03 21 00', 'Reinforcement bars — mild steel links, R6–R8', 'kg'],
    ['03 22 00', 'Welded fabric mesh reinforcement (BRC)', 'm²'],
    ['03 30 00', 'Blinding concrete, grade 15', 'm³'],
    ['03 30 00', 'Concrete grade 20 — foundations and footings', 'm³'],
    ['03 30 00', 'Concrete grade 25 — columns, beams and slabs', 'm³'],
    ['03 30 00', 'Concrete grade 30 — structural members', 'm³'],
    ['03 35 00', 'Power-floated concrete finish', 'm²'],
    ['03 41 00', 'Precast concrete lintels', 'm'],
    ['03 54 00', 'Cement–sand floor screed, 50 mm', 'm²'],
    ['03 15 00', 'Waterstop / construction joint', 'm'],
  ],
  '04': [
    ['04 22 00', 'Concrete block wall, 100 mm', 'm²'],
    ['04 22 00', 'Concrete block wall, 150 mm', 'm²'],
    ['04 22 00', 'Concrete block wall, 200 mm', 'm²'],
    ['04 21 13', 'Clay brick wall, half brick (115 mm)', 'm²'],
    ['04 21 13', 'Clay brick wall, one brick (225 mm)', 'm²'],
    ['04 43 00', 'Random rubble masonry', 'm³'],
    ['04 05 13', 'Cement mortar 1:5', 'm³'],
    ['04 05 19', 'Masonry wall ties and reinforcement', 'm'],
    ['04 72 00', 'Cast stone copings and sills', 'm'],
  ],
  '05': [
    ['05 12 00', 'Structural steel sections (UB, UC, channels)', 't'],
    ['05 12 00', 'Structural hollow sections (SHS / RHS)', 't'],
    ['05 05 23', 'Anchor bolts and base plates', 'EA'],
    ['05 31 00', 'Steel roof and floor decking', 'm²'],
    ['05 40 00', 'Light-gauge steel framing (C / Z purlins)', 'm'],
    ['05 51 00', 'Steel staircase', 'EA'],
    ['05 52 13', 'Stainless steel handrail', 'm'],
    ['05 52 00', 'Mild steel balustrade, painted', 'm'],
    ['05 50 00', 'Miscellaneous metal fabrications', 'kg'],
    ['05 53 00', 'Metal gratings', 'm²'],
  ],
  '06': [
    ['06 10 00', 'Softwood timber, sawn, treated', 'm³'],
    ['06 11 00', 'Timber roof framing (rafters, purlins)', 'm'],
    ['06 16 00', 'Plywood sheathing, 12 mm', 'm²'],
    ['06 41 00', 'Melamine-faced MDF board, 18 mm', 'm²'],
    ['06 41 00', 'Moisture-resistant (HMR) MDF board, 18 mm', 'm²'],
    ['06 41 00', 'Melamine-faced chipboard (MFC), 16 mm', 'm²'],
    ['06 41 00', 'Marine plywood, 18 mm', 'm²'],
    ['06 41 00', 'MDF back panel, 6 mm', 'm²'],
    ['06 41 16', 'High-pressure laminate (HPL), 0.8 mm', 'm²'],
    ['06 41 13', 'Natural wood veneer panel', 'm²'],
    ['06 41 00', 'PVC edge banding, 2 mm', 'm'],
    ['06 41 00', 'PVC edge banding, 0.8 mm', 'm'],
    ['06 41 00', 'Kitchen base unit, 600 mm', 'EA'],
    ['06 41 00', 'Kitchen wall unit, 600 mm', 'EA'],
    ['06 41 00', 'Kitchen tall unit, 600 mm', 'EA'],
    ['06 41 00', 'Wardrobe unit, full height', 'm'],
    ['06 41 00', 'Vanity unit', 'EA'],
    ['06 41 00', 'Kitchen plinth / kickboard', 'm'],
    ['06 41 00', 'Crown / light rail moulding', 'm'],
    ['06 41 19', 'Soft-close concealed hinge', 'EA'],
    ['06 41 19', 'Soft-close drawer runner (pair)', 'EA'],
    ['06 41 19', 'Cabinet handle', 'EA'],
    ['06 41 19', 'Adjustable cabinet leg', 'EA'],
    ['06 22 00', 'Timber skirting', 'm'],
    ['06 22 00', 'Timber architrave', 'm'],
    ['06 20 00', 'Timber wall panelling', 'm²'],
    ['06 43 00', 'Timber staircase', 'EA'],
    ['06 61 16', 'Solid surface countertop, 12 mm', 'm'],
  ],
  '07': [
    ['07 11 13', 'Bituminous damp-proof course', 'm'],
    ['07 13 00', 'Sheet waterproofing membrane (torch-on)', 'm²'],
    ['07 14 00', 'Liquid-applied waterproofing — wet areas', 'm²'],
    ['07 14 00', 'Cementitious waterproofing', 'm²'],
    ['07 21 00', 'Thermal insulation — roof', 'm²'],
    ['07 21 00', 'Thermal insulation — walls', 'm²'],
    ['07 32 13', 'Clay roof tiles', 'm²'],
    ['07 41 13', 'Metal roof sheeting (colour-coated)', 'm²'],
    ['07 62 00', 'Sheet-metal flashing', 'm'],
    ['07 71 23', 'Gutter', 'm'],
    ['07 71 23', 'Downpipe', 'm'],
    ['07 92 00', 'Silicone joint sealant', 'm'],
    ['07 84 00', 'Firestopping at penetrations', 'EA'],
  ],
  '08': [
    ['08 14 16', 'Flush timber door, complete with frame', 'EA'],
    ['08 14 33', 'Solid timber panelled door, complete with frame', 'EA'],
    ['08 11 13', 'Hollow metal door and frame', 'EA'],
    ['08 13 13', 'Fire-rated door set', 'EA'],
    ['08 33 23', 'Rolling shutter', 'm²'],
    ['08 51 13', 'Aluminium sliding window', 'm²'],
    ['08 51 13', 'Aluminium casement window', 'm²'],
    ['08 32 13', 'Aluminium sliding door', 'm²'],
    ['08 41 13', 'Aluminium shopfront / storefront', 'm²'],
    ['08 44 13', 'Glazed curtain wall', 'm²'],
    ['08 80 00', 'Clear float glass, 6 mm', 'm²'],
    ['08 80 00', 'Toughened glass, 10 mm', 'm²'],
    ['08 83 00', 'Mirror', 'm²'],
    ['08 71 00', 'Door ironmongery set', 'set'],
    ['08 71 00', 'Door closer', 'EA'],
  ],
  '09': [
    ['09 24 00', 'Cement plaster, internal walls', 'm²'],
    ['09 24 00', 'Cement plaster / render, external walls', 'm²'],
    ['09 24 00', 'Plaster to ceilings', 'm²'],
    ['09 21 16', 'Gypsum board partition, single layer both sides', 'm²'],
    ['09 29 00', 'Gypsum board ceiling, suspended', 'm²'],
    ['09 51 13', 'Acoustic mineral-fibre ceiling tiles', 'm²'],
    ['09 30 13', 'Ceramic floor tiles', 'm²'],
    ['09 30 13', 'Ceramic wall tiles', 'm²'],
    ['09 30 16', 'Porcelain floor tiles, 600 × 600', 'm²'],
    ['09 30 00', 'Tile skirting', 'm'],
    ['09 63 40', 'Granite / marble floor finish', 'm²'],
    ['09 66 13', 'Terrazzo floor finish', 'm²'],
    ['09 64 29', 'Engineered timber flooring', 'm²'],
    ['09 65 19', 'Vinyl (LVT) flooring', 'm²'],
    ['09 68 13', 'Carpet tiles', 'm²'],
    ['09 67 23', 'Epoxy floor coating', 'm²'],
    ['09 91 23', 'Emulsion paint, internal walls (3 coats)', 'm²'],
    ['09 91 23', 'Emulsion paint, ceilings', 'm²'],
    ['09 91 13', 'Weather-resistant paint, external walls', 'm²'],
    ['09 91 00', 'Enamel paint to metal / timber', 'm²'],
    ['09 93 00', 'Wood stain and varnish', 'm²'],
    ['09 97 00', 'Wall putty / skim coat', 'm²'],
  ],
  '10': [
    ['10 14 00', 'Signage', 'EA'],
    ['10 21 13', 'Toilet cubicle partitions', 'EA'],
    ['10 28 13', 'Toilet accessories set', 'set'],
    ['10 28 13', 'Grab bar', 'EA'],
    ['10 44 16', 'Fire extinguisher', 'EA'],
    ['10 51 13', 'Metal lockers', 'EA'],
    ['10 22 26', 'Operable / folding partition', 'm²'],
    ['10 73 00', 'Canopy / awning', 'm²'],
  ],
  '11': [
    ['11 31 13', 'Built-in oven', 'EA'],
    ['11 31 13', 'Hob', 'EA'],
    ['11 31 13', 'Cooker hood', 'EA'],
    ['11 31 13', 'Integrated refrigerator', 'EA'],
    ['11 31 13', 'Dishwasher', 'EA'],
    ['11 40 00', 'Commercial kitchen equipment', 'sum'],
    ['11 52 13', 'Projection screen', 'EA'],
  ],
  '12': [
    ['12 36 61', 'Quartz countertop, 20 mm', 'm'],
    ['12 36 40', 'Granite countertop, 20 mm', 'm'],
    ['12 36 00', 'Laminate countertop, 38 mm', 'm'],
    ['12 36 00', 'Countertop cut-out (sink / hob)', 'EA'],
    ['12 35 30', 'Residential kitchen casework (complete)', 'm'],
    ['12 32 00', 'Manufactured wood casework / shelving', 'm'],
    ['12 21 13', 'Venetian blinds', 'm²'],
    ['12 24 13', 'Roller blinds', 'm²'],
    ['12 22 00', 'Curtains and tracks', 'm'],
    ['12 48 13', 'Entrance matting', 'm²'],
    ['12 51 00', 'Office furniture', 'EA'],
    ['12 93 00', 'Site furnishings (benches, bins)', 'EA'],
  ],
  '13': [
    ['13 11 00', 'Swimming pool (shell and finishes)', 'm²'],
    ['13 12 00', 'Water feature / fountain', 'EA'],
    ['13 34 19', 'Pre-engineered metal building', 'm²'],
    ['13 21 00', 'Cold room', 'EA'],
  ],
  '14': [
    ['14 21 00', 'Passenger lift', 'EA'],
    ['14 24 00', 'Hydraulic lift', 'EA'],
    ['14 31 00', 'Escalator', 'EA'],
    ['14 42 00', 'Wheelchair platform lift', 'EA'],
    ['14 11 00', 'Dumbwaiter', 'EA'],
  ],
  '21': [
    ['21 13 13', 'Sprinkler head (wet-pipe system)', 'EA'],
    ['21 13 13', 'Sprinkler piping', 'm'],
    ['21 12 00', 'Fire hose reel', 'EA'],
    ['21 12 00', 'Standpipe / riser', 'm'],
    ['21 30 00', 'Fire pump set', 'EA'],
  ],
  '22': [
    ['22 11 16', 'PPR water supply pipe, 20–32 mm', 'm'],
    ['22 11 16', 'uPVC water supply pipe', 'm'],
    ['22 13 16', 'uPVC soil and waste pipe, 110 mm', 'm'],
    ['22 13 16', 'uPVC waste pipe, 50 mm', 'm'],
    ['22 14 00', 'Rainwater / storm drainage pipe', 'm'],
    ['22 13 19', 'Floor trap / floor drain', 'EA'],
    ['22 12 23', 'Overhead water storage tank', 'EA'],
    ['22 33 00', 'Electric water heater', 'EA'],
    ['22 33 30', 'Solar water heater', 'EA'],
    ['22 41 13', 'Water closet (WC) complete', 'EA'],
    ['22 41 16', 'Wash basin complete', 'EA'],
    ['22 41 16', 'Kitchen sink, stainless steel', 'EA'],
    ['22 41 23', 'Shower set', 'EA'],
    ['22 41 39', 'Taps and mixers', 'EA'],
    ['22 11 19', 'Water meter and valves', 'EA'],
  ],
  '23': [
    ['23 81 26', 'Split air conditioner, wall-mounted', 'EA'],
    ['23 81 26', 'Ceiling cassette air conditioner', 'EA'],
    ['23 31 13', 'Galvanised steel ductwork', 'm²'],
    ['23 07 13', 'Duct insulation', 'm²'],
    ['23 37 13', 'Diffuser / grille', 'EA'],
    ['23 34 23', 'Exhaust fan', 'EA'],
    ['23 23 00', 'Refrigerant piping', 'm'],
  ],
  '26': [
    ['26 24 16', 'Distribution board', 'EA'],
    ['26 05 19', 'Power cable', 'm'],
    ['26 05 33', 'PVC conduit', 'm'],
    ['26 05 36', 'Cable tray / trunking', 'm'],
    ['26 27 26', 'Light switch', 'EA'],
    ['26 27 26', 'Socket outlet, 13 A', 'EA'],
    ['26 27 26', 'Power point, 15 A', 'EA'],
    ['26 51 00', 'LED downlight', 'EA'],
    ['26 51 00', 'LED panel light, 600 × 600', 'EA'],
    ['26 51 00', 'LED strip light (under-cabinet)', 'm'],
    ['26 56 00', 'External / landscape light', 'EA'],
    ['26 05 26', 'Earthing and bonding', 'sum'],
    ['26 32 13', 'Standby generator', 'EA'],
    ['26 31 00', 'Solar PV system', 'kW'],
  ],
  '27': [
    ['27 15 00', 'Data cable, Cat 6', 'm'],
    ['27 15 00', 'Data outlet', 'EA'],
    ['27 11 16', 'Network cabinet / rack', 'EA'],
    ['27 41 00', 'TV outlet', 'EA'],
  ],
  '28': [
    ['28 31 00', 'Smoke detector', 'EA'],
    ['28 31 00', 'Fire alarm panel', 'EA'],
    ['28 31 00', 'Manual call point', 'EA'],
    ['28 23 00', 'CCTV camera', 'EA'],
    ['28 13 00', 'Access control point', 'EA'],
    ['28 16 00', 'Intruder alarm system', 'sum'],
  ],
  '31': [
    ['31 11 00', 'Site clearance', 'm²'],
    ['31 23 16', 'Excavation for foundations', 'm³'],
    ['31 23 16', 'Excavation in rock', 'm³'],
    ['31 23 23', 'Backfill with excavated material', 'm³'],
    ['31 23 23', 'Imported fill, compacted', 'm³'],
    ['31 23 19', 'Dewatering', 'sum'],
    ['31 31 16', 'Anti-termite treatment', 'm²'],
    ['31 63 29', 'Bored cast-in-place piles', 'm'],
    ['31 62 00', 'Driven piles', 'm'],
  ],
  '32': [
    ['32 14 13', 'Interlocking concrete paving', 'm²'],
    ['32 13 13', 'Concrete paving / hardstanding', 'm²'],
    ['32 12 16', 'Asphalt paving', 'm²'],
    ['32 11 23', 'Aggregate base course', 'm³'],
    ['32 16 13', 'Kerbs', 'm'],
    ['32 31 13', 'Chain-link fence', 'm'],
    ['32 31 00', 'Boundary wall / gate', 'm'],
    ['32 92 00', 'Turfing', 'm²'],
    ['32 93 00', 'Planting', 'EA'],
    ['32 84 00', 'Irrigation', 'm²'],
  ],
  '33': [
    ['33 11 00', 'Water main', 'm'],
    ['33 31 00', 'Sewer pipe', 'm'],
    ['33 39 13', 'Manhole / inspection chamber', 'EA'],
    ['33 41 00', 'Storm drainage pipe', 'm'],
    ['33 44 00', 'Surface drain (U-drain) with cover', 'm'],
    ['33 36 13', 'Septic tank', 'EA'],
    ['33 36 13', 'Soakage pit', 'EA'],
    ['33 46 00', 'Subsoil drainage', 'm'],
  ],
};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

/** The built-in catalogue as Material records (stable ids, rates not set). */
export const DEFAULT_MATERIALS: Material[] = MATERIAL_CATEGORIES.flatMap(cat =>
  (CATALOG[cat.code] ?? []).map(([section, name, unit]) => ({
    id: `std-${section.replace(/\s/g, '')}-${slug(name)}`,
    code: section,
    name,
    category: categoryLabel(cat),
    division: cat.code,
    unit,
    unitRate: 0,
    materialCost: 0,
    laborCost: 0,
    equipmentCost: 0,
    builtIn: true,
  })),
);

/** A fresh, editable copy of the catalogue for a project's material bank. */
export function defaultMaterialBank(): Material[] {
  return DEFAULT_MATERIALS.map(m => ({ ...m }));
}

/**
 * Where the catalogue comes from. Today: the hardcoded list above.
 * Later: replace the body with a fetch from your database / API.
 */
export async function loadMaterialCatalog(): Promise<Material[]> {
  return defaultMaterialBank();
}

/** Materials grouped by division, in catalogue order — for grouped pickers. */
export function groupMaterialsByDivision(materials: Material[]): { label: string; items: Material[] }[] {
  const groups = new Map<string, Material[]>();
  for (const m of materials) {
    const div = m.division || (m.category || '').slice(0, 2) || '—';
    const list = groups.get(div) ?? [];
    list.push(m);
    groups.set(div, list);
  }
  const order = new Map(MATERIAL_CATEGORIES.map((c, i) => [c.code, i]));
  return [...groups.entries()]
    .sort(([a], [b]) => (order.get(a) ?? 99) - (order.get(b) ?? 99) || a.localeCompare(b))
    .map(([div, items]) => {
      const cat = MATERIAL_CATEGORIES.find(c => c.code === div);
      return { label: cat ? categoryLabel(cat) : items[0]?.category || 'Other', items };
    });
}

# Construction Takeoff — Element Template Reference

A guide to all recommended preset element types, their customisable parameters, panel/component checklists, and the equations used to derive quantities automatically.

---

## Template Architecture

Every element template shares a common structure:

```
Element Type
  ├── Dimensions (sourced from PDF drawing or manual entry)
  ├── Component Checklist (tick what applies)
  ├── Auto-calculated Quantities (derived from dimensions + checklist)
  ├── Override Flags (any overridden value is marked)
  └── 3D Preview (optional visual confirmation)
```

**Core dimension variables used across all templates:**

| Variable | Meaning |
|---|---|
| W | Width (horizontal span) |
| H | Height (vertical span) |
| D | Depth (front to back) |
| L | Length (run length, for linear elements) |
| T | Material thickness (panel, slab, wall leaf) |
| Q | Quantity / count |

---

## 1. Carcass (Cabinet / Joinery Unit)

**Use case:** Kitchen units, wardrobes, shelving units, vanities, storage boxes.

### Dimensions
- Width (W)
- Height (H)
- Depth (D)
- Panel thickness (T) — default 18mm

### Component Checklist
- [ ] Back panel
- [ ] Top panel
- [ ] Bottom panel
- [ ] Left side panel
- [ ] Right side panel
- [ ] Shelves (specify count or spacing)
- [ ] Doors (specify count, swing type)
- [ ] Drawer fronts (specify count)
- [ ] Toe kick / plinth

### Equations

```
Back Panel Area        = (W - 2T) × (H - 2T)
Top Panel Area         = (W - 2T) × D
Bottom Panel Area      = (W - 2T) × D
Left Side Area         = D × H
Right Side Area        = D × H
Each Shelf Area        = (W - 2T) × D
Total Shelf Area       = Each Shelf Area × shelf_count
Door Area (per door)   = (W / door_count) × H   [adjustable]
Toe Kick Area          = W × toe_kick_height     [default 150mm]

Total Board Area       = sum of all ticked panels
Linear Edge Banding    = sum of all exposed panel edges
```

### Notes
- Shelves can be defined by count or by spacing (H / spacing = auto shelf count)
- Door count affects individual door width
- Face frame variant: add 4 stiles + rails as separate linear items

---

## 2. Stud Wall / Partition

**Use case:** Timber or metal stud internal walls, plasterboard partitions.

### Dimensions
- Length (L)
- Height (H)
- Stud spacing (default 450mm or 600mm)
- Number of leaves (single or double)

### Component Checklist
- [ ] Top plate (timber)
- [ ] Bottom plate (timber)
- [ ] Noggins (mid-height blocking)
- [ ] Studs
- [ ] Plasterboard — face side
- [ ] Plasterboard — back side
- [ ] Insulation
- [ ] Door / window openings (deduct)

### Equations

```
Stud Count             = floor(L / stud_spacing) + 1
Top Plate Length       = L
Bottom Plate Length    = L
Noggin Count           = Stud Count × noggin_rows   [default 1 row]
Noggin Length (each)   = stud_spacing - stud_width
Total Timber (lin m)   = Top Plate + Bottom Plate + (Stud Count × H) + (Noggin Count × Noggin Length)

Face Plasterboard Area = L × H  [minus openings]
Back Plasterboard Area = L × H  [minus openings]  (if double-sided)
Insulation Area        = L × H  [minus openings]

Opening Deduction      = opening_W × opening_H  [per opening, repeatable]
```

---

## 3. Floor Slab / Screed

**Use case:** Concrete slabs, floor screeds, tiled floors, timber flooring.

### Dimensions
- Area (drawn as polygon on PDF — uses existing area tool)
- Thickness (T)
- Wastage factor (default 10%)

### Component Checklist
- [ ] Concrete / screed volume
- [ ] DPM (damp proof membrane)
- [ ] Insulation board
- [ ] Reinforcement mesh
- [ ] Formwork (perimeter)
- [ ] Topping / finish layer

### Equations

```
Gross Area             = polygon area (from drawing)
Net Area               = Gross Area × (1 + wastage%)
Volume                 = Net Area × T
Perimeter              = polygon perimeter (auto from drawing)
DPM Area               = Net Area
Insulation Area        = Net Area
Mesh Area              = Net Area
Formwork Length        = Perimeter
```

---

## 4. Roof / Pitched Roof

**Use case:** Flat roofs, pitched roofs, roof membranes, insulation.

### Dimensions
- Plan area (W × L or polygon)
- Pitch angle (degrees) — for pitched roofs
- Eaves overhang

### Component Checklist
- [ ] Roof decking / boarding
- [ ] Membrane / felt
- [ ] Insulation
- [ ] Battens (for pitched)
- [ ] Rafters / joists
- [ ] Fascia / soffit
- [ ] Guttering

### Equations

```
Slope Factor           = 1 / cos(pitch_angle)
Actual Roof Area       = Plan Area × Slope Factor
Decking Area           = Actual Roof Area × (1 + wastage%)
Membrane Area          = Actual Roof Area × (1 + wastage%)
Insulation Area        = Actual Roof Area
Batten Length (lin m)  = (Actual Roof Area / batten_spacing) × 2  [both sides]
Rafter Count           = floor(L / rafter_spacing) + 1
Rafter Length (each)   = (W/2) / cos(pitch_angle) + eaves_overhang
Fascia Length          = Perimeter
Guttering Length       = eaves_length
```

---

## 5. Door Assembly

**Use case:** Internal doors, external doors, fire doors.

### Dimensions
- Door width (W)
- Door height (H)
- Frame / lining width
- Wall thickness (to set reveal depth)

### Component Checklist
- [ ] Door leaf
- [ ] Door frame / lining (head + 2 jambs)
- [ ] Architrave (head + 2 legs, both sides)
- [ ] Door stop (head + 2 jambs)
- [ ] Threshold / sill
- [ ] Hardware (handle, hinges, lock)

### Equations

```
Door Leaf Area         = W × H
Frame Head Length      = W + (2 × frame_width)
Frame Jamb Length      = H   [× 2 jambs]
Total Frame Length     = Frame Head + (2 × Frame Jamb)

Architrave Head        = W + (2 × architrave_width) + 2 mitre allowance
Architrave Leg         = H + architrave_width + mitre allowance  [× 2]
Total Architrave       = Architrave Head + (2 × Architrave Leg)  [× 2 sides if required]

Door Stop Length       = Total Frame Length
Threshold Length       = W
```

---

## 6. Window Assembly

**Use case:** Fixed windows, casements, double glazed units.

### Dimensions
- Overall width (W)
- Overall height (H)
- Frame depth
- Glazing unit thickness

### Component Checklist
- [ ] Window frame
- [ ] Glazing unit(s)
- [ ] Sill (internal)
- [ ] Sill (external)
- [ ] Architrave / reveals
- [ ] Mastic / sealant (perimeter)

### Equations

```
Frame Perimeter        = 2 × (W + H)
Glazing Area           = (W - frame_rebate × 2) × (H - frame_rebate × 2)
Sill Length            = W + 2 × sill_overhang
Reveal Area            = frame_depth × (2H + W)  [3 sides]
Sealant Run            = Frame Perimeter
```

---

## 7. Ceiling / Suspended Ceiling

**Use case:** Plasterboard ceilings, suspended grid ceilings, acoustic tiles.

### Dimensions
- Area (W × L or polygon from drawing)
- Drop height (for suspended)
- Grid module size (e.g. 600 × 600)

### Component Checklist
- [ ] Ceiling board / tiles
- [ ] Primary grid sections
- [ ] Secondary grid sections
- [ ] Wall angle / perimeter trim
- [ ] Hangers / fixings
- [ ] Insulation above

### Equations

```
Ceiling Area           = polygon area (from drawing) × (1 + wastage%)
Tile Count             = ceil(W / grid_W) × ceil(L / grid_L)
Primary Grid Length    = ceil(L / 1200) × W   [typical 1200mm primary spacing]
Secondary Grid Length  = ceil(W / grid_W) × L
Perimeter Trim         = perimeter of room
Hanger Count           = ceil(Ceiling Area / 1.44)   [1 per 1.2m²]
```

---

## 8. Staircase

**Use case:** Timber staircases, concrete stairs, steel staircases.

### Dimensions
- Total rise (floor to floor height)
- Total going (horizontal run)
- Stair width
- Riser height (default 175mm)
- Tread depth (default 250mm)

### Component Checklist
- [ ] Treads
- [ ] Risers
- [ ] Stringers (2)
- [ ] Handrail
- [ ] Balustrade / spindles
- [ ] Newel posts (top + bottom)
- [ ] Nosings

### Equations

```
Number of Risers       = round(Total Rise / riser_height)
Number of Treads       = Number of Risers - 1
Actual Riser Height    = Total Rise / Number of Risers
Actual Tread Depth     = Total Going / Number of Treads
Stringer Length        = sqrt(Total Rise² + Total Going²)

Tread Area (each)      = stair_width × Actual Tread Depth
Riser Area (each)      = stair_width × Actual Riser Height
Handrail Length        = Stringer Length + extensions
Spindle Count          = floor(Number of Treads × stair_width / spindle_spacing)
Nosing Length          = stair_width × Number of Treads
```

---

## 9. Beam / Lintel

**Use case:** Timber beams, steel sections, concrete lintels.

### Dimensions
- Span (L)
- Width (W)
- Depth (D)
- Count (Q)

### Component Checklist
- [ ] Beam volume (concrete)
- [ ] Beam linear length (timber / steel)
- [ ] Formwork (soffit + sides)
- [ ] Reinforcement

### Equations

```
Volume (each)          = L × W × D
Total Volume           = Volume × Q
Linear Length (each)   = L
Total Linear Length    = L × Q
Formwork (soffit)      = L × W × Q
Formwork (sides)       = L × D × 2 × Q
Reinforcement Length   = L × bar_count × Q
```

---

## 10. Column

**Use case:** Concrete columns, timber posts, steel columns.

### Dimensions
- Height (H)
- Width (W)
- Depth (D) — or diameter for round columns
- Count (Q)

### Component Checklist
- [ ] Column volume (concrete)
- [ ] Formwork area
- [ ] Reinforcement

### Equations

```
Cross-section Area     = W × D   [or π × (diameter/2)²]
Volume (each)          = Cross-section Area × H
Total Volume           = Volume × Q
Formwork (each)        = perimeter × H  [perimeter = 2(W+D) or π×diameter]
Total Formwork         = Formwork × Q
```

---

## 11. Tiling / Cladding

**Use case:** Wall tiles, floor tiles, external cladding panels.

### Dimensions
- Area (drawn as polygon or rectangle)
- Tile / panel size (W × H)
- Grout joint width

### Component Checklist
- [ ] Tiles / panels
- [ ] Adhesive
- [ ] Grout
- [ ] Edge trim / border tiles
- [ ] Waterproofing membrane (wet areas)

### Equations

```
Gross Area             = polygon area (from drawing)
Net Tile Area          = Gross Area  [before wastage]
Tile Count             = ceil(Gross Area / (tile_W × tile_H)) × (1 + wastage%)
Adhesive Coverage      = Gross Area × adhesive_kg_per_m²
Grout Coverage         = Gross Area × grout_kg_per_m²
Perimeter Trim Length  = perimeter of tiled area
```

---

## 12. Plumbing Rough-in (Wet Wall)

**Use case:** Bathrooms, kitchens — pipe runs, fixture rough-ins.

### Dimensions
- Wall length (L)
- Wall height (H)
- Number of fixtures

### Component Checklist
- [ ] Hot water pipe (lin m)
- [ ] Cold water pipe (lin m)
- [ ] Waste / drain pipe (lin m)
- [ ] Fixture rough-in sets (per fixture)

### Equations

```
Supply Pipe Run        = L + H  [approximate per fixture, user adjustable]
Waste Pipe Run         = L      [approximate]
Total Hot Water        = Supply Pipe Run × hot_fixture_count
Total Cold Water       = Supply Pipe Run × fixture_count
Rough-in Sets          = fixture_count
```

---

## Template Design Principles

### Extensibility Rules
1. Every element is defined as a JSON schema — new elements can be added without code changes
2. Every calculated field has an `isOverridden` flag matching the existing measurement model
3. Dimensions can be sourced from: PDF drawing click, manual entry, or linked to another element
4. All equations are stored as evaluable expressions so they can be displayed to the user and audited

### Override Behaviour
- Any auto-calculated value can be overridden by the user
- Overridden values display an **orange indicator** in the takeoff table
- Recalculating (e.g. after changing a dimension) prompts: *"This will reset overridden values — continue?"*

### 3D Preview Priority (build order suggestion)
| Phase | Elements |
|---|---|
| Phase 1 | Carcass, Stud Wall, Floor Slab |
| Phase 2 | Door, Window, Ceiling |
| Phase 3 | Roof, Staircase, Beam/Column |

---

## Suggested Data Schema (per element instance)

```typescript
interface ElementTemplate {
  id: string;
  type: ElementType;          // 'carcass' | 'stud_wall' | 'floor_slab' | ...
  label: string;              // user-facing name e.g. "Kitchen Base Unit B1"
  dimensions: {
    [key: string]: {
      value: number;
      unit: 'mm' | 'm';
      source: 'drawing' | 'manual';
      drawingMeasurementId?: string;  // links back to a takeoff row
    };
  };
  components: {
    [key: string]: boolean;   // checklist — which panels/parts are included
  };
  quantities: {
    [key: string]: {
      value: number;
      unit: string;
      isOverridden: boolean;
      overrideValue?: number;
    };
  };
  shelfCount?: number;
  customFields?: Record<string, number>;  // user-added extra inputs
}
```
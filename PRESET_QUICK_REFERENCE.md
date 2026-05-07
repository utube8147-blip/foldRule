# PRESET QUICK REFERENCE

## Status Matrix

```
PRESET         | 3D VIZ | FORM QUALITY | CALC | READY? | PRIORITY
===============+========+=============+======+=========+==========
Carcass        | ✅    | ⭐⭐⭐⭐⭐ | ✅  | YES    | PERFECT
Tiling         | ❌    | ⭐⭐⭐⭐  | ✅  | GOOD   | Add 3D
Stud Wall      | ❌    | ⭐⭐⭐⭐  | ✅  | GOOD   | Add 3D (HIGH)
Door           | ❌    | ⭐⭐⭐⭐  | -   | GOOD   | Add 3D (HIGH)
Window         | ❌    | ⭐⭐⭐⭐  | ✅  | GOOD   | Add 3D (HIGH)
Beam           | ❌    | ⭐⭐⭐⭐  | -   | GOOD   | Fix inputs
Column         | ❌    | ⭐⭐⭐⭐  | -   | GOOD   | Fix inputs
Floor Slab     | ❌    | ⭐⭐⭐   | ✅  | OK     | Add edges
Staircase      | ❌    | ⭐⭐⭐   | ✅  | OK     | Add dims
Plumbing       | ❌    | ⭐⭐⭐   | -   | OK     | Clarify fields
Roof           | ❌    | ⭐⭐    | -   | BASIC  | Add options
Ceiling        | ❌    | ⭐⭐    | -   | BASIC  | Expand form
===============+========+=============+======+==========
```

## 3D Visualization Status

### IMPLEMENTED ✅
- **Carcass** - Full legend, all panels shown, door/drawer visualization

### NOT IMPLEMENTED ❌ (11 presets)
Priority for implementation:
1. **HIGH:** Stud Wall, Door, Window (common, simple geometry)
2. **MEDIUM:** Tiling, Floor Slab, Beam (moderate complexity)
3. **LOW:** Staircase, Roof, Ceiling, Column, Plumbing (complex)

## Form Completeness by Category

### Complete & Professional ✅
- **Carcass** - All necessary parameters
- **Tiling** - Good area/tile count with waste
- **Stud Wall** - Spacing, noggins, plasterboard

### Good Foundation 👍
- **Door** - Quantity, dimensions, types covered
- **Window** - Glass area calculation, glazing options
- **Floor Slab** - Area and volume calculations
- **Beam** - Quantity, length, section (text input issue)
- **Column** - Similar to beam
- **Staircase** - Rise calculation working well

### Needs Enhancement ⚠️
- **Roof** - Pitch input unclear, missing edges/gutters
- **Ceiling** - Too sparse, missing panel/suspension details
- **Plumbing** - Fittings quantity units unclear

## Key Issues by Preset

### Critical 🔴
- **Beam/Column:** Text input for section size → use dropdown instead
- **Plumbing:** Clarify what "fittings quantity" means

### Important 🟡
- **Door:** Missing fire rating, hardware options
- **Window:** Missing frame depth, transom options
- **Roof:** Pitch input needs presets + edge details
- **Stair:** Missing tread depth, width dimension
- **Ceiling:** Too sparse, needs expansion

### Minor 🟢
- **Tiling:** Add edge/trim specifications
- **Floor Slab:** Add edge treatment options
- **Stud Wall:** Custom spacing doesn't work yet

## UI/UX Notes

### ✅ What's Working
- Consistent color scheme across all presets
- Grid layout is standard and predictable
- SectionHeading component groups fields logically
- Number inputs with +/- buttons are intuitive
- StatStrip displays calculations nicely (where used)

### ⚠️ Minor Improvements
- Apply StatStrip to more presets (Door, Plumbing, Beam, Column)
- Expand Ceiling form with more options
- Standardize dropdown vs text input usage

### 🔄 Layout (All Consistent)
- 2-column grid: `grid grid-cols-2 gap-x-4 gap-y-3` ✅
- 3D visualizer beside form: `withViz()` wrapper ✅
- Section headers: `SectionHeading` component ✅
- Statistics display: `StatStrip` component ✅

## Recommended Next Steps

### Phase 1: Fix Critical Issues (1-2 days)
1. Replace Beam/Column text inputs with dropdown
2. Clarify Plumbing fittings quantity field
3. Add fire rating to Door preset

### Phase 2: Add Missing Features (2-3 days)
1. Implement 3D visualizers for Door, Window, Stud Wall
2. Enhance Roof with pitch presets and edge details
3. Expand Ceiling form with panel/suspension options

### Phase 3: Polish & Enhancement (3-5 days)
1. Add 3D visualizers for Tiling, Floor Slab, Beam
2. Add hardware/finish options to Door/Window
3. Implement custom spacing input for Stud Wall
4. Add transoms/sidelights to Window

## File Locations

- **Preset Forms:** `src/components/presets/PresetTemplates.tsx`
- **3D Renderers:** `src/components/presets/Preset3DVisualizer.tsx`
- **Gallery/Drawer:** `src/components/presets/PresetGallery.tsx`

## Integration Notes

All presets are **fully integrated** into:
- ✅ PresetGallery (browsable)
- ✅ PresetDrawer (detailed view)
- ✅ Data export system
- ✅ Project save/load
- ⚠️ 3D visualization (only Carcass)

Form data flows correctly to measurement system for all 12 presets.

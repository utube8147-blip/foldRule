# 🛠️ Toolbar & Canvas Section

## Toolbar — What Should Be There

### Drawing / Measurement Tools

#### Existing
- ✅ Select / Pan (`V`)
- ✅ Linear / Length (`L`)
- ✅ Polygon / Area (`P`)
- ✅ Rectangle (`R`)
- ✅ Count / Point (`N`, `T`)
- ✅ Arc (`B`)
- ✅ Radius / Circle *(Advanced)*
- ✅ Grid Count *(Advanced)*
- ✅ Magic Fill / Auto-Area
- ✅ Scale / Calibration

#### Planned / Soon
- ⏳ Volume
- ⏳ Symbol Detect
- ⏳ Perimeter Offset

### Missing Toolbar Features

#### 🔴 Must-Have
- [ ] **Void / Hole Tool**
  - Subtract from an existing area
  - Should be a first-class toolbar button, not hidden in menus

- [ ] **Text / Label Tool**
  - Drop free text annotations anywhere on the drawing

- [ ] **Eraser / Delete Region**
  - Click or lasso specific measurements to remove directly from canvas

#### 🟠 High Priority
- [ ] **Cloud / Revision Markup**
  - Standard revision clouds like Bluebeam
  - Highlights revised drawing regions

- [ ] **Arrow / Leader Line**
  - Point to a location with a callout label

- [ ] **Stamp Tool**
  - Drop pre-configured symbols (fixtures, outlets, fittings)
  - Automatically creates count rows

---

## Snap & Accuracy Controls

### Existing
- ✅ Snap toggle
- ✅ Snap settings panel
- ✅ Snap threshold slider

### Missing
- [ ] **Snap to Grid**
  - Snap cursor to regular grid overlay

- [ ] **Snap to Angle (Ortho Mode)**
  - Constrain drawing to:
    - 0°
    - 45°
    - 90°

- [ ] **Snap to Midpoint**
  - Detect and snap to edge midpoints explicitly

---

## Calibration Controls

### Existing
- ✅ Draw calibration line
- ✅ Scale display

### Missing
- [ ] **Scale Preset Picker**
  - Common presets:
    - 1:50
    - 1:100
    - 1:200

- [ ] **Auto-Detect Scale**
  - Read scale bar directly from PDF

---

## View Controls

### Existing
- ✅ Zoom in/out
- ✅ Fit to screen
- ✅ Zoom % display
- ✅ Page navigation (footer)

### Missing

#### 🟠 High Priority
- [ ] **Zoom to Selection**
  - Focus viewport on selected measurement bounds

- [ ] **Rotate Page**
  - Handle rotated/scanned PDFs

#### 🟡 Medium Priority
- [ ] **Page Thumbnail Strip**
  - Horizontal/vertical thumbnails for quick navigation
  - Standard in Bluebeam / PlanSwift

#### 🟢 Nice-to-Have
- [ ] **Full Screen / Presentation Mode**
  - Hide UI chrome
  - Show only drawing + overlays

- [ ] **Split View**
  - View two sheets side-by-side

---

## Undo / Redo
- ✅ Undo
- ✅ Redo

---

## Unit Selector
- ✅ Present

---

# 🖼️ Canvas — What Should Be There

## Layers / Overlays

### Existing
- ✅ PDF render layer
- ✅ Drawing/measurement overlay
- ✅ Snap pin overlay
- ✅ Magic fill canvas

### Missing

#### 🟡 Medium Priority
- [ ] **Grid Overlay**
  - Toggleable canvas grid

- [ ] **Trade Layer Toggles**
  - Show/hide measurements by trade

- [ ] **Background Opacity Slider**
  - Dim PDF to emphasize measurements

---

## Measurement Visuals

### Existing
- ✅ Lines, polygons, arcs
- ✅ Snap flash animations
- ✅ Hover tooltips on fills

### Missing

#### 🔴 Must-Have
- [ ] **Dimension Labels on Canvas**
  - Display values directly on drawing
  - Example: `14.3 m²`

- [ ] **Measurement Highlight on Hover**
  - Hover row in table → pulse/highlight shape on canvas

#### 🟡 Medium Priority
- [ ] **Colour-Coded by Trade**
  - Distinct colours:
    - Civil
    - Structural
    - Electrical
    - Architectural

- [ ] **Hatching / Fill Patterns**
  - Different visual fills:
    - Solid
    - Diagonal hatch
    - Cross hatch

---

## Context Menu (Right Click)

#### 🟠 High Priority
- [ ] Edit measurement
- [ ] Delete measurement
- [ ] Duplicate / copy shape
- [ ] Assign to group / trade
- [ ] Add void inside polygon
- [ ] Zoom to measurement

---

## Minimap
- ✅ Present

---

# 📋 Takeoff Table Section

## Column Structure

### Existing
- ✅ Description / Label
- ✅ Type
- ✅ Quantity
- ✅ Unit
- ✅ Unit Rate
- ✅ Total

### Missing Columns

#### 🔴 Must-Have
- [ ] **Colour Swatch**
  - Matches canvas colour
  - Click to edit colour

- [ ] **Visibility Toggle**
  - Eye icon to show/hide shape

- [ ] **Override Indicator**
  - Visual indicator for manually overridden quantities

#### 🟠 High Priority
- [ ] **Drawing Reference**
  - Example:
    - `A-101 Rev B`

- [ ] **Lock Toggle**
  - Prevent accidental edits

- [ ] **Waste %**
  - Allowance factor per row

- [ ] **Notes / Comments**
  - Estimator notes field

- [ ] **Revision Delta**
  - Example:
    - `▲ +2.4 m²`

---

# 📑 Row Types

### Existing
- ✅ Measurement rows
- ✅ Group header rows

### Missing

#### 🟠 High Priority
- [ ] **Deduction Rows**
  - Negative quantities
  - Linked to void/exclusion system

- [ ] **Subtotal Rows**
  - Auto-summed totals per group

#### 🟡 Medium Priority
- [ ] **Assembly / Build-Up Rows**
  - Auto-calculate materials/labour from parent quantity

- [ ] **Allowance / Provisional Rows**
  - Manual entries not tied to drawing

- [ ] **Section / Trade Divider Rows**
  - Civil / Structural / Architectural separators

---

# 🔄 Table Interactions

## Selection & Focus

#### 🔴 Must-Have
- [ ] Click row → highlight shape on canvas
- [ ] Click shape → scroll table to row

#### 🟠 High Priority
- [ ] Multi-select rows
  - Shift/Ctrl selection

---

## Editing

#### 🔴 Must-Have
- [ ] Inline quantity edit
- [ ] Inline description edit

#### 🟠 High Priority
- [ ] Inline rate edit
- [ ] Drag to reorder rows
- [ ] Drag row between groups

---

## Grouping & Organisation

#### 🟠 High Priority
- [ ] Create group
- [ ] Move to group

### Existing
- ✅ Collapse / expand groups

#### 🟡 Medium Priority
- [ ] Auto-group by:
  - Trade
  - Measurement type

---

## Bulk Actions

#### 🟠 High Priority
- [ ] Bulk delete
- [ ] Bulk colour change
- [ ] Bulk assign to group
- [ ] Bulk apply waste %

---

## Sorting & Filtering

#### 🟡 Medium Priority
- [ ] Sort by column
- [ ] Filter by type
- [ ] Filter by trade/group
- [ ] Search rows
- [ ] Hide zero-quantity rows

---

## Export Controls

#### 🟠 High Priority
- [ ] Export CSV / Excel
- [ ] Export PDF report with overlays
- [ ] Copy table to clipboard
- [ ] Print table

---

# 🚦Priority Summary

| Priority | Feature | Section |
|---|---|---|
| 🔴 Must | Void / Hole Tool | Toolbar + Canvas |
| 🔴 Must | Table ↔ Canvas Highlight Sync | Table + Canvas |
| 🔴 Must | Dimension Labels on Canvas | Canvas |
| 🔴 Must | Inline Quantity / Description Edit | Table |
| 🔴 Must | Colour Swatch + Visibility Toggle | Table |
| 🟠 High | Ortho / Angle Snap | Toolbar |
| 🟠 High | Deduction / Negative Rows | Table |
| 🟠 High | Subtotal Rows | Table |
| 🟠 High | Right-Click Context Menu | Canvas |
| 🟠 High | Page Thumbnail Strip | Toolbar |
| 🟡 Medium | Trade Layer Toggles | Canvas + Table |
| 🟡 Medium | Assembly / Build-Up Rows | Table |
| 🟡 Medium | Hatching / Fill Patterns | Canvas |
| 🟡 Medium | Sort + Filter Table | Table |
| 🟢 Nice | Split View | Canvas |
| 🟢 Nice | Revision Delta Column | Table |
| 🟢 Nice | Full Screen / Presentation Mode | Toolbar |

---
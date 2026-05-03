# Quantity Savior - Preset Element Templates System

## Overview
The Preset System enables users to quickly create standardized measurements for common construction elements without manual drawing analysis. It includes 12 pre-configured element templates that can be filled out and added to the takeoff measurements.

## Architecture

### Components
- **PresetTemplates.tsx** - Defines all 12 element template schemas with fields and validation
- **PresetGallery.tsx** - Gallery view showing all available preset templates with search and selection
- **PresetOutput.tsx** - Displays collected preset measurements in a professional format
- **Integrated into Workspace** - Accessible via PRESETS button in the navbar

### Data Flow
1. User clicks "PRESETS" button in navbar
2. PresetGallery modal opens with all 12 templates
3. User selects a template (e.g., Carcass, Window, Door)
4. Form opens with required/optional fields specific to that element
5. User fills in measurements and properties
6. Form submits and measurement is added to PresetOutput
7. All preset measurements can be viewed, exported, or deleted

## Available Preset Templates

### 1. Carcass
**Category:** Structure
**Fields:**
- Length (m)
- Width (m)
- Height (m)
- Material (Concrete/Steel/Mixed)
- Notes

### 2. Stud Wall
**Category:** Walls
**Fields:**
- Wall Height (m)
- Wall Length (m)
- Material (Wood/Metal)
- Stud Spacing (mm)
- Number of Studs
- Notes

### 3. Floor Slab
**Category:** Floors
**Fields:**
- Length (m)
- Width (m)
- Thickness (mm)
- Material (Concrete/Composite)
- Reinforcement Type
- Notes

### 4. Roof
**Category:** Roofing
**Fields:**
- Area (sq m)
- Pitch (degrees)
- Material (Tiles/Metal/Wood)
- Slope Direction
- Notes

### 5. Door
**Category:** Openings
**Fields:**
- Width (mm)
- Height (mm)
- Type (Single/Double/Sliding)
- Material (Wood/Metal/Glass)
- Frame Material
- Notes

### 6. Window
**Category:** Openings
**Fields:**
- Width (mm)
- Height (mm)
- Type (Single/Double/Sliding)
- Material (Wood/Metal/uPVC)
- Frame Material
- Notes

### 7. Ceiling
**Category:** Finishes
**Fields:**
- Area (sq m)
- Height from Floor (m)
- Type (Drywall/Plaster/Suspended)
- Material
- Notes

### 8. Staircase
**Category:** Structure
**Fields:**
- Number of Treads
- Rise Height (mm)
- Tread Depth (mm)
- Material (Wood/Concrete/Metal)
- Handrail Type
- Notes

### 9. Beam
**Category:** Structure
**Fields:**
- Length (m)
- Width (mm)
- Height (mm)
- Material (Concrete/Steel)
- Load Rating (kN)
- Notes

### 10. Column
**Category:** Structure
**Fields:**
- Height (m)
- Width (mm)
- Depth (mm)
- Material (Concrete/Steel)
- Load Rating (kN)
- Notes

### 11. Tiling
**Category:** Finishes
**Fields:**
- Area (sq m)
- Tile Size (mm)
- Material (Ceramic/Porcelain/Natural Stone)
- Grout Type
- Notes

### 12. Plumbing
**Category:** MEP
**Fields:**
- Pipe Length (m)
- Pipe Diameter (mm)
- Material (PVC/Copper/Steel)
- Type (Supply/Waste/Vent)
- Number of Fixtures
- Notes

## Usage

### In the Workspace
1. Navigate to the main Workspace page
2. Click the "PRESETS" button in the navbar (top right)
3. The preset gallery modal opens
4. Browse or search for the element type you need
5. Click to select a template
6. Fill in the measurement form
7. Click "Add Measurement" to include it in your takeoff
8. View all preset measurements in the PresetOutput section
9. Delete or modify measurements as needed

### Integration with Takeoff Table
Preset measurements are managed separately from manual measurements but can be:
- Exported together to Excel
- Tracked in the project history
- Modified or deleted individually

## Tailwind CSS Styling

All preset components use Tailwind CSS v4 with the following color scheme:
- **Primary:** Amber accent (#FBBF24)
- **Background:** Dark slate/stone (bg-stone-900, bg-slate-900)
- **Text:** Zinc/slate grays with amber accents
- **Borders:** Industrial dark borders (border-amber-900/30)

## Component Props

### PresetGallery
```tsx
<PresetGallery 
  onSelectPreset={(data, template) => {
    // Handle preset selection
    // data: Record<string, any> - Form data
    // template: PresetTemplate - Selected template
  }}
/>
```

### PresetOutput
```tsx
<PresetOutput 
  measurements={presetMeasurements}
  onDelete={(id) => {
    // Handle measurement deletion
  }}
/>
```

## Future Enhancements
- Add custom preset templates
- Template categorization and filtering
- Preset templates library management
- Bulk import/export of presets
- Regional measurement unit support
- Cost calculation integration with material library

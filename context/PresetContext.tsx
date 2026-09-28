'use client';

import React, { createContext, useContext, useState } from 'react';
import type { PresetTemplate } from '@/components/presets/PresetTemplates';

type FormFieldValue = string | number | boolean | null | undefined;

interface FormData {
  [key: string]: FormFieldValue;
}

interface PresetFormDataMap {
  [templateId: string]: FormData;
}

interface PresetContextValue {
  selectedTemplate:       PresetTemplate | null;
  setSelectedTemplate:    (t: PresetTemplate | null) => void;
  formData:               PresetFormDataMap;
  setFormField:           (templateId: string, key: string, value: FormFieldValue) => void;
  resetForm:              (templateId: string) => void;
  getFormData:            (templateId: string) => FormData;
  searchTerm:             string;
  setSearchTerm:          React.Dispatch<React.SetStateAction<string>>;
  activeCategory:         string | null;
  setActiveCategory:      React.Dispatch<React.SetStateAction<string | null>>;
  showEnterpriseModal:    boolean;
  setShowEnterpriseModal: React.Dispatch<React.SetStateAction<boolean>>;
}

// ─── Canonical defaults ───────────────────────────────────────────────────────
// Every key here matches what the 3D renderer reads from `fd`.
// The form checkboxes and number inputs also use these as their initial values.

const PRESET_DEFAULTS: Record<string, FormData> = {

  carcass: {
    width:          600,
    height:         720,
    depth:          550,
    panelThickness: 18,
    // panels — 3D uses `!== false` so they render unless explicitly false.
    // We set true here so the form checkboxes start checked to match.
    hasBack:      true,
    hasTop:       true,
    hasBottom:    true,
    hasLeftSide:  true,
    hasRightSide: true,
    // optional extras — off by default in both form and 3D
    hasDoors:    false,
    hasDrawers:  false,
    hasToeKick:  false,
    hasDivider:  false,
    // counts — match 3D fallbacks
    shelfCount:   2,
    doorCount:    2,   // 3D: fd.doorCount ?? 2
    drawerCount:  2,   // 3D: fd.drawerCount ?? 2
    dividerCount: 1,
    // materials
    boardMaterial: '18mm MDF',
    edgeTape:      'PVC 0.4mm',
    shelfMaterial: '18mm MDF',
    doorMaterial:  'MDF Primed',
    shelfSpacing:  'Equal',
  },

  'stud-wall': {
    length:  5000,
    height:  2700,
    spacing: '450mm',   // 3D: fd.spacing === '600mm' ? 600 : 450
    thickness: '70mm',  // 3D: parseFloat(fd.thickness?.replace('mm','') ?? 70)
    nogginRows: '1 Row',
    facePlasterboard: false,
    backPlasterboard: false,
    insulation:       false,
  },

  'floor-slab': {
    // 3D uses raw metres; form labels say M — keep as metres
    length:        10,
    width:          8,
    thickness:    '150mm',   // 3D: parseInt(fd.thickness ?? 150)
    reinforcement: 'Mesh',
    finishType:    'Smooth',
  },

  roof: {
    roofArea:    100,
    roofPitch:    30,          // 3D: fd.roofPitch ?? 30
    roofType:    'Pitched',
    material:    'Tile',
    insulation:  '100mm',      // truthy string — 3D: !!fd.insulation
    guttering:   'Aluminium',
    underlayType:'Breathable',
    hasDecking:   true,
    hasMembrane:  true,
    hasGuttering: true,
    hasInsulation:false,
  },

  door: {
    quantity:  1,
    width:    '800mm',    // 3D: parseFloat(fd.width?.replace('mm','') ?? 800)
    height:   '2100mm',   // 3D: parseFloat(fd.height?.replace('mm','') ?? 2100)
    doorType:  'Swing',
    material:  'Wood',    // 3D 色: 0xD2B48C
    frameType: 'Timber',
    fireRating:'None',
    acoustic:  'Standard',
  },

  window: {
    quantity:   1,
    width:    1200,        // 3D: parseFloat(fd.width ?? 1200)
    height:    900,        // 3D: parseFloat(fd.height ?? 900)
    windowType:'Casement',
    glazing:   'Double',
    frameType: 'UPVC',
  },

  // ── ceiling: form uses `ceilingType`, 3D uses `fd.type` ──────────────────
  // We store the value under `type` (matching 3D) and read it as `type` in
  // CeilingForm too — see the note below about updating CeilingForm.
  ceiling: {
    area:     20,
    height:    2.4,
    type:     'Suspended',   // KEY IS `type` — matches 3D check: fd.type === 'Suspended'
    gridType: 'T-bar',
    fireRating:'None',
    panelType: 'Mineral',
    panelSize: '600x600',
    hasBoard:   true,
    hasGrid:    true,
    acousticAbsorption: false,
    hasInsulation:      false,
  },

  // ── staircase: form used stepCount/treadWidth, 3D uses steps/treadsDepth ──
  // We store under the 3D keys; update StaircaseForm reads below.
  staircase: {
    quantity:     1,
    steps:       12,          // was `stepCount` in form — use `steps` to match 3D
    riserHeight: 175,         // 3D: fd.riserHeight ?? 200 — form was calculating from flightRise
    treadsDepth: 250,         // was `treadWidth` in form
    width:       900,         // 3D: fd.width ?? 900
    flightRise:  2.1,         // keep for the form's calculated-riser display
    stairWidth:  900,
    stringType:  'Closed',
    material:    'Timber',
    railing:     'Timber',
    hasRisers:    true,
    hasTreads:    true,
    hasStringers: true,
    handrail:     true,
    hasNosings:   false,
  },

  beam: {
    quantity: 1,
    length:   6000,   // 3D: fd.length ?? 6000 (in mm → /1000)
    beamType: 'I-Beam',
    material: 'Steel',
    sectionSize:    '305×165×40 UB',
    fireProtection: 'None',
  },

  column: {
    quantity:   1,
    height:     3,
    columnType: 'Square',
    material:   'Steel',
    sectionSize:'200mm',
    foundations:'Pad',
  },

  tiling: {
    area:           10,
    tilingLocation: 'Floor',
    tileSize:      '300x300',
    material:      'Ceramic',
    groutType:     'Cement',
    jointWidth:    '3mm',
  },

  plumbing: {
    pipeLength:   10,
    pipeDiameter: '20mm',
    pipeType:     'Copper',
    systemType:   'Cold Water',
    fittings:     'Compression',
    quantity:      4,
  },
};

// ─── Context ──────────────────────────────────────────────────────────────────

const PresetContext = createContext<PresetContextValue | null>(null);

export function usePresetContext() {
  const ctx = useContext(PresetContext);
  if (!ctx) throw new Error('usePresetContext must be used inside PresetProvider');
  return ctx;
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function PresetProvider({ children }: { children: React.ReactNode }) {
  const [selectedTemplate, setSelectedTemplate] = useState<PresetTemplate | null>(null);
  const [formData, setFormData]                 = useState<PresetFormDataMap>({});
  const [searchTerm, setSearchTerm]             = useState('');
  const [activeCategory, setActiveCategory]     = useState<string | null>(null);
  const [showEnterpriseModal, setShowEnterpriseModal] = useState(false);

  const setFormField = (templateId: string, key: string, value: FormFieldValue): void => {
    setFormData(prev => ({
      ...prev,
      [templateId]: {
        ...(prev[templateId] ?? {}),
        [key]: value,
      },
    }));
  };

  const resetForm = (templateId: string): void => {
    setFormData(prev => {
      const next = { ...prev };
      delete next[templateId];
      return next;
    });
  };

  // Merge: canonical defaults → any user edits stored in state.
  // Both the form and the 3D renderer call this, so they always agree.
  const getFormData = (templateId: string): FormData => ({
    ...(PRESET_DEFAULTS[templateId] ?? {}),
    ...(formData[templateId] ?? {}),
  });

  return (
    <PresetContext.Provider value={{
      selectedTemplate,
      setSelectedTemplate,
      formData,
      setFormField,
      resetForm,
      getFormData,
      searchTerm,
      setSearchTerm,
      activeCategory,
      setActiveCategory,
      showEnterpriseModal,
      setShowEnterpriseModal,
    }}>
      {children}
    </PresetContext.Provider>
  );
}
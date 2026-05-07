'use client';

import React, { createContext, useContext, useState } from 'react';
import { PresetTemplate } from '@/components/presets/PresetTemplates';

// ─── Types ────────────────────────────────────────────────────────────────────

type FormFieldValue = string | number | boolean | null | undefined;

interface FormData {
  [key: string]: FormFieldValue;
}

interface PresetFormDataMap {
  [templateId: string]: FormData;
}

interface PresetContextValue {
  // template selection
  selectedTemplate:    PresetTemplate | null;
  setSelectedTemplate: (t: PresetTemplate | null) => void;

  // form data — keyed by template id so switching templates doesn't bleed state
  formData:            PresetFormDataMap;
  setFormField:        (templateId: string, key: string, value: FormFieldValue) => void;
  resetForm:           (templateId: string) => void;
  getFormData:         (templateId: string) => FormData;

  // gallery UI state
  searchTerm:          string;
  setSearchTerm:       React.Dispatch<React.SetStateAction<string>>;
  activeCategory:      string | null;
  setActiveCategory:   React.Dispatch<React.SetStateAction<string | null>>;

  // enterprise modal
  showEnterpriseModal:    boolean;
  setShowEnterpriseModal: React.Dispatch<React.SetStateAction<boolean>>;
}

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

  // ── form helpers ────────────────────────────────────────────────────────────

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

  const getFormData = (templateId: string): FormData =>
    formData[templateId] ?? {};

  // ── value ───────────────────────────────────────────────────────────────────

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

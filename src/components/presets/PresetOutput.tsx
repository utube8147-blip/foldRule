'use client';

import React from 'react';
import { Trash2, FileDown } from 'lucide-react';
import { PresetTemplate } from './PresetTemplates';

export interface PresetMeasurement {
  id: string;
  template: PresetTemplate;
  data: Record<string, any>;
  createdAt: string;
}

interface PresetOutputProps {
  measurements: PresetMeasurement[];
  onDelete: (id: string) => void;
  onExport?: () => void;
}

export function PresetOutput({ measurements, onDelete, onExport }: PresetOutputProps) {
  if (measurements.length === 0) {
    return (
      <div className="w-full bg-slate-900 rounded-lg border border-slate-700 p-12 text-center">
        <div className="text-5xl mb-4">📋</div>
        <h3 className="text-xl font-bold text-white mb-2">No Measurements Yet</h3>
        <p className="text-slate-400">Add preset elements from the gallery to start building your takeoff</p>
      </div>
    );
  }

  return (
    <div className="w-full bg-slate-900 rounded-lg border border-slate-700 p-6">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold text-white mb-1">Measurements</h2>
          <p className="text-slate-400">{measurements.length} item{measurements.length !== 1 ? 's' : ''}</p>
        </div>
        {onExport && (
          <button
            onClick={onExport}
            className="flex items-center gap-2 bg-amber-500 hover:bg-amber-600 text-black font-bold py-2 px-4 rounded-lg transition"
          >
            <FileDown size={20} />
            Export
          </button>
        )}
      </div>

      {/* Measurements List */}
      <div className="space-y-4 max-h-96 overflow-y-auto">
        {measurements.map((measurement, index) => (
          <div
            key={measurement.id}
            className="bg-slate-800 border border-slate-700 rounded-lg p-4 hover:border-amber-500 transition"
          >
            {/* Template Header */}
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-3 flex-1">
                <span className="text-3xl">{measurement.template.icon}</span>
                <div>
                  <h4 className="text-lg font-bold text-white">{measurement.template.name}</h4>
                  <p className="text-xs text-slate-500">{new Date(measurement.createdAt).toLocaleString()}</p>
                </div>
              </div>
              <button
                onClick={() => onDelete(measurement.id)}
                className="p-2 text-slate-400 hover:text-red-500 hover:bg-slate-700 rounded transition"
              >
                <Trash2 size={20} />
              </button>
            </div>

            {/* Data Display */}
            <div className="bg-slate-900 rounded-lg p-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {Object.entries(measurement.data).map(([key, value]) => {
                // Skip empty values
                if (value === '' || value === undefined || value === null) return null;

                // Format the key for display
                const displayKey = key
                  .replace(/([A-Z])/g, ' $1')
                  .split('_')
                  .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                  .join(' ')
                  .trim();

                // Format the value
                let displayValue = value;
                if (typeof value === 'boolean') {
                  displayValue = value ? 'Yes' : 'No';
                } else if (typeof value === 'number') {
                  displayValue = value.toFixed(2);
                }

                return (
                  <div key={key} className="text-sm">
                    <p className="text-slate-500 mb-1">{displayKey}</p>
                    <p className="text-white font-semibold">{displayValue}</p>
                  </div>
                );
              })}
            </div>

            {/* Category Badge */}
            <div className="mt-3 flex gap-2">
              <span className="inline-block px-2 py-1 bg-amber-500 bg-opacity-20 text-amber-400 rounded text-xs font-semibold">
                {measurement.template.category}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

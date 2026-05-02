import * as XLSX from 'xlsx';
import { ProjectState } from '../types';

export function exportToExcel(state: ProjectState) {
  const dateStr = new Date().toISOString().split('T')[0];
  const filename = `quantity-savior-${state.projectName.toLowerCase().replace(/\s+/g, '-')}-${dateStr}.xlsx`;

  // 1. Summary Sheet
  const summaryData = state.measurements.map((m, idx) => ({
    '#': (idx + 1).toString().padStart(2, '0'),
    'Description': m.description,
    'Type': m.type,
    'Quantity': m.quantity,
    'Unit': m.unit,
    'Unit Rate': m.unitRate,
    'Total Cost': m.quantity * m.unitRate,
    'Notes': m.notes,
  }));

  const wb = XLSX.utils.book_new();
  const wsSummary = XLSX.utils.json_to_sheet([
    { 'A': 'QUANTITY SAVIOR TAKEOFF SUMMARY' },
    { 'A': `Project: ${state.projectName}` },
    { 'A': `Export Date: ${dateStr}` },
    {}, // Empty row
    ...summaryData
  ], { skipHeader: true });

  // Add summary header manually for styling (simulated headers in first object array)
  XLSX.utils.sheet_add_aoa(wsSummary, [[
    '#', 'Description', 'Type', 'Quantity', 'Unit', 'Unit Rate', 'Total Cost', 'Notes'
  ]], { origin: 'A5' });

  XLSX.utils.book_append_sheet(wb, wsSummary, 'Takeoff Summary');

  // 2. Raw Measurements Sheet
  const rawData = state.measurements.flatMap((m) => 
    m.points.map((p, pIdx) => ({
      'ID': m.id,
      'Description': m.description,
      'Point Index': pIdx,
      'X': p.x,
      'Y': p.y,
    }))
  );
  const wsRaw = XLSX.utils.json_to_sheet(rawData);
  XLSX.utils.book_append_sheet(wb, wsRaw, 'Measurements Log');

  // Trigger download
  XLSX.writeFile(wb, filename);
}

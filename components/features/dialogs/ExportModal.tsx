import React, { useState } from 'react';
import { X, Pencil, Table, Download } from 'lucide-react';
import * as motion from 'motion/react-m';

interface ExportModalProps {
  projectState: any;
  onClose: () => void;
  onExport: (filename: string) => void; // ← now accepts filename
  onExportCsv?: (filename: string) => void;
}

export function ExportModal({ projectState, onClose, onExport, onExportCsv }: ExportModalProps) {
  const [fileName, setFileName] = useState(
    `${projectState.projectName.toLowerCase().replace(/\s+/g, '-')}-takeoff.xlsx`
  );

  const handleExport = () => {
    onExport(fileName); // ← passes the filename the user typed
  };

  const filesCount = new Set(projectState.measurements.map((m: { drawingId: any }) => m.drawingId)).size;
  const pointsCount = projectState.measurements.length;

  return (
    <div className="absolute inset-0 z-[150] flex items-center justify-center bg-[#16191C]/75 backdrop-blur-[2px] font-mono">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="bg-[#1D2125] border border-amber-accent w-full max-w-[440px] relative overflow-hidden shadow-[0_0_50px_rgba(0,0,0,0.8)]"
      >
        {/* Modal Header */}
        <div className="bg-[#1a1a1a] border-b border-amber-accent px-6 py-4 flex justify-between items-center">
          <h2 className="text-amber-accent text-lg uppercase tracking-widest font-black">EXPORT TO EXCEL</h2>
          <button onClick={onClose} className="text-stone-600 hover:text-white transition-colors">
            <X className="w-5 h-5 pointer-events-none" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 space-y-6">
          {/* Filename Input */}
          <div>
            <label className="block text-[11px] text-stone-500 uppercase tracking-[0.2em] mb-3 font-bold">
              Target Filename
            </label>
            <div className="bg-[#16191C] border border-[#2E353C] px-4 py-3 flex items-center gap-3 group focus-within:border-amber-accent transition-colors">
              <Pencil className="w-4 h-4 text-stone-600" />
              <input
                className="bg-transparent border-none p-0 focus:ring-0 text-stone-200 text-sm font-bold w-full outline-none lowercase"
                type="text"
                value={fileName}
                onChange={(e) => setFileName(e.target.value)}
              />
            </div>
          </div>

          {/* Two Column Settings */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="block text-[11px] text-stone-500 uppercase tracking-[0.2em] font-bold">Includes</label>
              <div className="flex items-center gap-3 bg-[#16191C] border border-[#2E353C] p-3 cursor-pointer hover:border-stone-700 transition-colors">
                <div className="w-3 h-3 bg-amber-accent"></div>
                <span className="text-[11px] uppercase text-stone-300 font-bold tracking-widest">ALL MEASUREMENTS</span>
              </div>
            </div>
            <div className="space-y-2">
              <label className="block text-[11px] text-stone-500 uppercase tracking-[0.2em] font-bold">Format</label>
              <div className="flex items-center gap-3 bg-[#16191C] border border-[#2E353C] p-3 cursor-pointer hover:border-stone-700 transition-colors">
                <Table className="w-4 h-4 text-stone-500" />
                <span className="text-[11px] uppercase text-stone-300 font-bold tracking-widest">STANDARD XLSX</span>
              </div>
            </div>
          </div>

          {/* Calculation Engine Status */}
          <div className="bg-[#1a1a1a] p-4 border border-[#2E353C] space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-[10px] text-stone-500 uppercase tracking-widest font-bold">CALCULATION ENGINE</span>
              <span className="text-amber-accent text-[10px] uppercase font-black tracking-widest">VERIFIED</span>
            </div>
            <div className="h-1 bg-[#16191C] w-full">
              <div className="h-full bg-amber-accent w-full"></div>
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="px-6 pb-6 pt-2">
          <button
            onClick={handleExport}
            className="w-full bg-amber-accent text-[#16191C] font-black text-xs py-4 hover:bg-amber-400 transition-colors flex items-center justify-center gap-3 shadow-lg active:translate-y-px uppercase tracking-[0.2em]"
          >
            <Download className="w-5 h-5 pointer-events-none text-black stroke-[3]" />
            Download .xlsx
          </button>
          {onExportCsv && (
            <button
              onClick={() => onExportCsv(fileName)}
              className="w-full mt-2 border border-[#2E353C] text-stone-300 font-black text-[11px] py-3 hover:border-amber-accent hover:text-amber-accent transition-colors uppercase tracking-[0.2em]"
            >
              Download .csv (rows + totals by type)
            </button>
          )}
          <p className="text-[10px] text-center text-stone-600 mt-4 uppercase tracking-widest font-bold">
            EXPORTING {filesCount} FILES WITH {pointsCount} TOTAL TAKEOFF POINTS
          </p>
        </div>
      </motion.div>
    </div>
  );
}
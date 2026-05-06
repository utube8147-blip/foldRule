import React, { useState } from 'react';
import { X } from 'lucide-react';

interface GroupNamingDialogProps {
  isOpen: boolean;
  selectedMeasurementIds: string[];
  onConfirm: (groupName: string, groupType: string) => void;
  onCancel: () => void;
}

export function GroupNamingDialog({
  isOpen,
  selectedMeasurementIds,
  onConfirm,
  onCancel,
}: GroupNamingDialogProps) {
  const [groupName, setGroupName] = useState('');
  const [groupType, setGroupType] = useState('mixed');

  if (!isOpen) return null;

  const handleConfirm = () => {
    if (groupName.trim()) {
      onConfirm(groupName.trim(), groupType);
      setGroupName('');
      setGroupType('mixed');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleConfirm();
    if (e.key === 'Escape') {
      onCancel();
      setGroupName('');
      setGroupType('mixed');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl w-96 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-bold text-zinc-200 uppercase tracking-widest">Create Group</h2>
          <button
            onClick={() => {
              onCancel();
              setGroupName('');
              setGroupType('mixed');
            }}
            className="text-zinc-500 hover:text-zinc-300"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-xs font-bold text-zinc-400 uppercase tracking-widest block mb-2">
              Group Name
            </label>
            <input
              type="text"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="e.g., Inner Walls, Exterior Perimeter"
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-amber-400 transition-colors"
              autoFocus
            />
          </div>

          <div>
            <label className="text-xs font-bold text-zinc-400 uppercase tracking-widest block mb-2">
              Group Type
            </label>
            <select
              value={groupType}
              onChange={(e) => setGroupType(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-amber-400 transition-colors"
            >
              <option value="mixed">Mixed (Lines + Polygons)</option>
              <option value="lineals">Lineals Only</option>
              <option value="polygons">Polygons Only</option>
              <option value="rectangles">Rectangles Only</option>
            </select>
          </div>

          <div className="text-xs text-zinc-500 bg-zinc-800/50 p-3 rounded">
            {selectedMeasurementIds.length} measurement{selectedMeasurementIds.length !== 1 ? 's' : ''} selected
          </div>
        </div>

        <div className="flex gap-3 mt-6 justify-end">
          <button
            onClick={() => {
              onCancel();
              setGroupName('');
              setGroupType('mixed');
            }}
            className="px-4 py-2 text-xs font-bold text-zinc-400 border border-zinc-700 rounded hover:border-zinc-600 hover:text-zinc-300 transition-colors uppercase tracking-widest"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!groupName.trim()}
            className="px-4 py-2 text-xs font-bold text-black bg-amber-400 rounded hover:bg-amber-300 transition-colors uppercase tracking-widest disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Create Group
          </button>
        </div>
      </div>
    </div>
  );
}

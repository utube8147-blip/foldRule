import React, { useState, useEffect } from 'react';
import { Material } from '../types';
import { X, Search, Filter, ArrowUpDown, Database, Download, Plus, Trash2, Settings, Bell, Info, Compass, Layers, Droplet } from 'lucide-react';
import { formatCurrency, cn } from '../lib/utils';
import { motion } from 'motion/react';

// Extend Material type for internal use with division field
interface MaterialWithDivision extends Material {
  division?: string;
}

interface MaterialLibraryProps {
  materials: Material[];
  onUpdateMaterials: (materials: Material[]) => void;
  onClose: () => void;
}

export function MaterialLibrary({ materials, onUpdateMaterials, onClose }: MaterialLibraryProps) {
  const [activeCategory, setActiveCategory] = useState('03 - Concrete');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedMaterial, setSelectedMaterial] = useState<MaterialWithDivision | null>(null);

  // Cast materials to internal type with division
  const materialsWithDivision = materials as MaterialWithDivision[];

  const categories = [
    { code: '01', name: 'General Requirements', icon: Info },
    { code: '03', name: 'Concrete', icon: Compass },
    { code: '04', name: 'Masonry', icon: Database },
    { code: '05', name: 'Metals', icon: Compass },
    { code: '06', name: 'Wood/Plastics', icon: Layers },
    { code: '07', name: 'Thermal/Moisture', icon: Droplet }
  ];

  const handleAddMaterial = () => {
    const newId = crypto.randomUUID();
    const div = activeCategory.split(' - ')[0]; // E.g. '03'
    const newMaterial: MaterialWithDivision = {
      id: newId,
      code: `${div} ${Math.floor(Math.random() * 99)} 00.X`,
      name: 'NEW SPECIFICATION ITEM',
      category: activeCategory,
      unit: 'EA',
      unitRate: 0,
      materialCost: 0,
      laborCost: 0,
      equipmentCost: 0,
      division: div
    };
    onUpdateMaterials([newMaterial, ...materials]);
    setSelectedMaterial(newMaterial);
  };

  const handleUpdateSelected = (updates: Partial<MaterialWithDivision>) => {
    if (!selectedMaterial) return;
    const updated = { ...selectedMaterial, ...updates };
    setSelectedMaterial(updated);
    onUpdateMaterials(materials.map(m => m.id === updated.id ? updated : m));
  };

  const handleDelete = (id: string) => {
    onUpdateMaterials(materials.filter(m => m.id !== id));
    if (selectedMaterial?.id === id) {
      setSelectedMaterial(null);
    }
  };

  const activeDivision = activeCategory.split(' - ')[0];
  
  const filteredMaterials = materialsWithDivision.filter(m => 
    m.division === activeDivision &&
    (m.name.toLowerCase().includes(searchQuery.toLowerCase()) || (m.code || '').toLowerCase().includes(searchQuery.toLowerCase()))
  );

  useEffect(() => {
    if (!selectedMaterial || selectedMaterial.division !== activeDivision) {
      const matsInDiv = materialsWithDivision.filter(m => m.division === activeDivision);
      setSelectedMaterial(matsInDiv.length > 0 ? matsInDiv[0] : null);
    }
  }, [activeDivision, materialsWithDivision]);

  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      className="fixed inset-0 z-[100] bg-[#0D0D0D] text-zinc-200 font-mono flex flex-col"
    >
      <div className="absolute inset-0 z-0 opacity-20 pointer-events-none" style={{ backgroundImage: 'radial-gradient(circle, #fff 1px, transparent 1px)', backgroundSize: '64px 64px' }} />

      {/* TopNavBar */}
      <header className="fixed top-0 w-full border-b border-zinc-800 bg-[#0D0D0D] text-amber-500 font-mono tracking-widest z-50 flex justify-between items-center h-12 px-4 shadow-sm select-none">
        <div className="flex items-center gap-6 h-full">
          <span className="text-xl font-black text-amber-accent flex-shrink-0 uppercase">KINETIC_PRECISION</span>
          <nav className="hidden md:flex gap-4 h-full items-center uppercase text-[10px] font-bold">
            <button 
              onClick={onClose}
              className="text-zinc-400 hover:text-amber-400 transition-colors h-full flex items-center"
            >
              Project Scope
            </button>
            <div className="text-amber-accent border-b-2 border-amber-accent h-full flex items-center pt-[2px]">
              Company Standards
            </div>
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <Settings className="w-5 h-5 cursor-pointer text-zinc-400 hover:text-amber-accent transition-colors" />
          <Bell className="w-5 h-5 cursor-pointer text-zinc-400 hover:text-amber-accent transition-colors" />
          <div className="w-8 h-8 rounded-none border border-zinc-700 overflow-hidden">
            <img alt="User profile" className="w-full h-full object-cover" src="https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=100&h=100&fit=crop" />
          </div>
        </div>
      </header>

      <div className="flex flex-1 pt-12 overflow-hidden relative z-10">
        {/* SideNavBar */}
        <aside className="w-64 border-r border-zinc-800 bg-[#161616] flex flex-col py-4 shrink-0 font-mono uppercase">
          <div className="px-4 mb-6">
            <div className="text-amber-accent font-bold text-sm">PROJECT_ALPHA</div>
            <div className="text-zinc-500 text-[10px] tracking-widest">EST-2024-001</div>
          </div>
          
          <nav className="flex-1 overflow-y-auto custom-scrollbar uppercase tracking-tighter text-xs font-bold">
            {categories.map(cat => (
              <div 
                key={cat.code}
                onClick={() => setActiveCategory(`${cat.code} - ${cat.name}`)}
                className={cn(
                  "flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-all",
                  activeCategory.startsWith(cat.code)
                    ? "bg-zinc-800/50 text-amber-accent border-l-2 border-amber-accent"
                    : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 border-l-2 border-transparent"
                )}
              >
                <cat.icon className="w-4 h-4" />
                <span>{cat.name}</span>
              </div>
            ))}
          </nav>

          <div className="mt-auto px-4 pt-4 border-t border-zinc-800 space-y-4">
            <button 
              onClick={onClose}
              className="w-full py-2 bg-amber-accent text-black font-bold tracking-widest text-[10px] uppercase hover:bg-amber-400 transition-all active:scale-95 shadow-[0_0_15px_rgba(245,158,11,0.15)]"
            >
              Export Takeoff
            </button>
            <div className="flex flex-col gap-2 pb-2 text-[10px] font-bold text-zinc-500">
              <div className="flex items-center gap-3 hover:text-zinc-200 cursor-pointer transition-colors">
                <Info className="w-4 h-4" />
                <span>Support</span>
              </div>
              <div className="flex items-center gap-3 hover:text-zinc-200 cursor-pointer transition-colors">
                <Database className="w-4 h-4" />
                <span>Logs</span>
              </div>
            </div>
          </div>
        </aside>

        {/* Main Workspace */}
        <main className="flex-1 flex flex-col p-6 lg:p-8 bg-[#0D0D0D]/50 gap-6 min-w-0">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4 border-b border-zinc-800 pb-4 uppercase tracking-widest">
            <div>
              <h1 className="text-2xl font-bold text-amber-accent mb-1">{`Division ${activeCategory}`}</h1>
              <p className="text-[10px] text-zinc-400 font-bold">Material Rates and Master Specifications</p>
            </div>
            <div className="flex bg-[#161616] p-1 border border-zinc-800 text-[10px] font-bold shadow-sm">
              <button className="px-4 py-2 text-[#161616] bg-amber-accent shadow-sm">Project_Specific_Rates</button>
              <button className="px-4 py-2 text-zinc-500 hover:text-zinc-300 transition-colors">Global_Company_Library</button>
            </div>
          </div>

          {/* Filters */}
          <div className="flex flex-col xl:flex-row gap-4 items-center justify-between">
            <div className="flex flex-1 max-w-2xl gap-2 w-full">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                <input 
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-[#161616] border border-zinc-800 py-2.5 pl-10 pr-4 text-xs text-amber-accent placeholder-zinc-700 focus:outline-none focus:border-amber-accent uppercase tracking-widest" 
                  placeholder="Search materials by code or name..." 
                />
              </div>
              <button className="px-4 border border-zinc-800 text-zinc-400 flex items-center gap-2 hover:bg-zinc-800 transition-colors uppercase tracking-widest text-[10px] font-bold">
                <Filter className="w-3.5 h-3.5" /> Filter
              </button>
              <button className="px-4 border border-zinc-800 text-zinc-400 flex items-center gap-2 hover:bg-zinc-800 transition-colors uppercase tracking-widest text-[10px] font-bold">
                <ArrowUpDown className="w-3.5 h-3.5" /> Sort
              </button>
            </div>
            
            <div className="flex gap-4 text-[10px] font-bold text-zinc-500 tracking-widest uppercase items-center">
              <div className="flex items-center gap-2"><div className="w-2 h-2 bg-amber-accent" /> Active Items: {materials.length}</div>
              <div className="flex items-center gap-2"><div className="w-2 h-2 bg-zinc-700" /> Archived: 0</div>
            </div>
          </div>

          <div className="flex flex-1 min-h-0 gap-6">
            {/* Table Area */}
            <div className="flex-1 bg-[#161616] border border-zinc-800 flex flex-col min-w-0 shadow-xl">
              <div className="flex-1 overflow-auto custom-scrollbar">
                <table className="w-full text-left border-collapse whitespace-nowrap min-w-max">
                  <thead className="sticky top-0 bg-[#1C1C1C] z-10 text-[10px] uppercase tracking-widest text-zinc-500 font-bold shadow-md">
                    <tr>
                      <th className="p-4 border-b border-zinc-800">Code</th>
                      <th className="p-4 border-b border-zinc-800">Description</th>
                      <th className="p-4 border-b border-zinc-800">Unit</th>
                      <th className="p-4 border-b border-zinc-800 text-right">Mat. Cost</th>
                      <th className="p-4 border-b border-zinc-800 text-right">Labor</th>
                      <th className="p-4 border-b border-zinc-800 text-right">Equip.</th>
                      <th className="p-4 border-b border-zinc-800 text-right text-amber-accent">Total Rate</th>
                    </tr>
                  </thead>
                  <tbody className="text-xs">
                    {filteredMaterials.map((mat, idx) => (
                      <tr 
                        key={mat.id} 
                        onClick={() => setSelectedMaterial(mat)}
                        className={cn(
                          "cursor-pointer transition-colors group",
                          selectedMaterial?.id === mat.id 
                            ? "bg-[#121212] border-l-2 border-amber-accent" 
                            : idx % 2 !== 0 
                              ? "bg-[#121212] hover:bg-zinc-800/30 border-l-2 border-transparent"
                              : "hover:bg-zinc-800/30 border-l-2 border-transparent"
                        )}
                      >
                        <td className="p-4 text-zinc-500 font-bold">{mat.code}</td>
                        <td className="p-4 text-zinc-200">{mat.name}</td>
                        <td className="p-4 text-zinc-500">{mat.unit}</td>
                        <td className="p-4 text-right">{formatCurrency(mat.materialCost)}</td>
                        <td className="p-4 text-right">{formatCurrency(mat.laborCost)}</td>
                        <td className="p-4 text-right">{formatCurrency(mat.equipmentCost)}</td>
                        <td className="p-4 text-right text-amber-accent font-bold">
                          {formatCurrency(mat.materialCost + mat.laborCost + mat.equipmentCost)}
                        </td>
                      </tr>
                    ))}
                    {filteredMaterials.length === 0 && (
                      <tr>
                        <td colSpan={7} className="p-12 text-center text-zinc-600 uppercase tracking-widest text-xs font-bold">
                          No specifications found matching search criteria.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="p-3 border-t border-zinc-800 bg-[#0D0D0D] flex justify-between items-center text-[9px] text-zinc-600 uppercase tracking-widest font-bold">
                <span>Last Sync: {new Date().toISOString().replace('T', ' ').substring(0,19)}</span>
                <div className="flex gap-4">
                  <span className="hover:text-amber-accent cursor-pointer transition-colors">Prev</span>
                  <span className="text-zinc-400">1 of 1</span>
                  <span className="hover:text-amber-accent cursor-pointer transition-colors">Next</span>
                </div>
              </div>
            </div>

            {/* Detail Panel */}
            {selectedMaterial && (
              <aside className="w-80 shrink-0 bg-[#161616] border border-zinc-800 flex flex-col p-4 shadow-xl overflow-y-auto custom-scrollbar">
                <div className="flex justify-between items-start mb-4">
                  <span className="text-amber-accent font-bold uppercase tracking-widest text-xs">Material Specification</span>
                  <div className="flex gap-2">
                    <button onClick={() => handleDelete(selectedMaterial.id)} className="text-zinc-600 hover:text-red-500 transition-colors">
                      <Trash2 className="w-4 h-4" />
                    </button>
                    <button onClick={() => setSelectedMaterial(null)} className="text-zinc-500 hover:text-white transition-colors">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div className="aspect-square bg-[#0D0D0D] border border-zinc-800 mb-4 relative overflow-hidden group shrink-0">
                  <img 
                    className="w-full h-full object-cover grayscale opacity-50 group-hover:opacity-100 transition-opacity" 
                    src="https://images.unsplash.com/photo-1541888086425-d81bb19040d1?q=80&w=600&auto=format&fit=crop" 
                    alt="Material Structure" 
                  />
                  <div className="absolute top-2 left-2 flex gap-1">
                    <div className="w-1.5 h-1.5 bg-amber-accent"></div>
                    <div className="w-1.5 h-1.5 bg-amber-accent"></div>
                  </div>
                </div>

                <div className="space-y-4 flex-1">
                  <div>
                    <label className="text-[11px] text-zinc-500 uppercase tracking-widest font-bold block mb-1">Description</label>
                    <textarea 
                      value={selectedMaterial.name}
                      onChange={(e) => handleUpdateSelected({ name: e.target.value })}
                      className="w-full bg-transparent border-none p-0 text-[13px] font-bold text-zinc-200 outline-none focus:ring-0 uppercase resize-none placeholder:text-zinc-700 leading-tight" 
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-[11px] text-zinc-500 uppercase tracking-widest font-bold block mb-1">M/F Code</label>
                      <input 
                        type="text"
                        value={selectedMaterial.code}
                        onChange={(e) => handleUpdateSelected({ code: e.target.value })}
                        className="w-full bg-transparent border-none p-0 text-[13px] font-bold text-zinc-200 outline-none uppercase"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-zinc-500 uppercase tracking-widest font-bold block mb-1">Unit</label>
                      <input 
                        type="text"
                        value={selectedMaterial.unit}
                        onChange={(e) => handleUpdateSelected({ unit: e.target.value })}
                        className="w-full bg-transparent border-none p-0 text-[13px] font-bold text-zinc-200 outline-none uppercase"
                      />
                    </div>
                  </div>

                  <div className="border-t border-zinc-800 pt-4 space-y-3">
                    <h4 className="text-[11px] text-amber-accent font-bold uppercase tracking-widest">Rate Breakdown</h4>
                    
                    <div className="space-y-2 text-xs font-bold w-full uppercase">
                      <div className="flex justify-between items-center bg-[#0D0D0D] border border-zinc-800 p-2">
                        <span className="text-zinc-500 tracking-widest text-[9px]">Material</span>
                        <div className="flex items-center text-zinc-200">
                          <span className="text-zinc-500 mr-1">$</span>
                          <input 
                            type="number"
                            value={selectedMaterial.materialCost}
                            onChange={(e) => handleUpdateSelected({ materialCost: parseFloat(e.target.value) || 0 })}
                            className="bg-transparent border-none p-0 w-16 text-right outline-none text-xs"
                          />
                        </div>
                      </div>
                      
                      <div className="flex justify-between items-center bg-[#0D0D0D] border border-zinc-800 p-2">
                        <span className="text-zinc-500 tracking-widest text-[9px]">Labor</span>
                        <div className="flex items-center text-zinc-200">
                          <span className="text-zinc-500 mr-1">$</span>
                          <input 
                            type="number"
                            value={selectedMaterial.laborCost}
                            onChange={(e) => handleUpdateSelected({ laborCost: parseFloat(e.target.value) || 0 })}
                            className="bg-transparent border-none p-0 w-16 text-right outline-none text-xs"
                          />
                        </div>
                      </div>
                      
                      <div className="flex justify-between items-center bg-[#0D0D0D] border border-zinc-800 p-2">
                        <span className="text-zinc-500 tracking-widest text-[9px]">Equipment</span>
                        <div className="flex items-center text-zinc-200">
                          <span className="text-zinc-500 mr-1">$</span>
                          <input 
                            type="number"
                            value={selectedMaterial.equipmentCost}
                            onChange={(e) => handleUpdateSelected({ equipmentCost: parseFloat(e.target.value) || 0 })}
                            className="bg-transparent border-none p-0 w-16 text-right outline-none text-xs"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="flex justify-between items-center text-xs font-bold bg-[#0D0D0D] border-l-2 border-amber-accent p-2">
                      <span className="text-amber-accent uppercase tracking-widest text-[9px]">Total Rate</span>
                      <span className="text-amber-accent text-[13px]">{formatCurrency(selectedMaterial.materialCost + selectedMaterial.laborCost + selectedMaterial.equipmentCost)}</span>
                    </div>
                  </div>

                  <div className="border-t border-zinc-800 pt-4 space-y-3">
                    <h4 className="text-[11px] text-amber-accent font-bold uppercase tracking-widest">Sustainability Data</h4>
                    <div className="flex justify-between items-center text-[10px]">
                      <span className="text-zinc-500">Recycled Content</span>
                      <span className="text-zinc-200 font-bold">85%</span>
                    </div>
                    <div className="w-full bg-[#0D0D0D] h-1">
                      <div className="h-full bg-amber-accent" style={{ width: '85%' }}></div>
                    </div>
                    <div className="flex justify-between items-center text-[10px]">
                      <span className="text-zinc-500">Carbon Footprint</span>
                      <span className="text-zinc-200 font-bold">1.2 TCO2/TON</span>
                    </div>
                  </div>

                  <div className="border-t border-zinc-800 pt-4">
                    <label className="text-[11px] text-zinc-500 uppercase tracking-widest font-bold block mb-1">Manufacturer Specs</label>
                    <p className="text-[12px] text-zinc-400 leading-tight">Structural specifications standard compliant for high-tensile applications and high-quality finishes.</p>
                    <button className="mt-4 w-full border border-zinc-700 py-2 text-zinc-400 text-[11px] font-bold uppercase tracking-widest hover:text-white hover:border-zinc-500 transition-colors flex items-center justify-center gap-2">
                      <Download className="w-3.5 h-3.5" /> PDF Datasheet
                    </button>
                  </div>
                </div>
              </aside>
            )}
          </div>
        </main>
      </div>
    </motion.div>
  );
}

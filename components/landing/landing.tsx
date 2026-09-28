'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import {
  HardHat, ArrowRight, Layers, FileSpreadsheet, Maximize, ArrowUpRight,
  Shapes, Wand2, Frame, FolderTree, Box, ShieldCheck,
} from 'lucide-react';
import * as motion from 'motion/react-m';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import { Logo } from '@/components/brand/Logo';

export function Landing() {
  const router = useRouter();

  const navLinks = [
    { label: 'FEATURES', href: '#features' },
    { label: 'HOW IT WORKS', href: '#how-it-works' },
    { label: 'WHO IT’S FOR', href: '#who-its-for' },
    { label: 'MY PROJECTS', href: '/dashboard' },
  ];

  return (
    <div className="min-h-screen bg-[#16191C] text-zinc-200 font-mono overflow-y-auto selection:bg-[#F2C230]/30">
      {/* Background Grids */}
      <div className="fixed inset-0 blueprint-grid opacity-10 pointer-events-none" />

      {/* Header */}
      <header className="h-20 border-b border-[#2E353C] bg-[#16191C]/90 backdrop-blur-md px-8 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <Link href="/" aria-label="Foldrule home"><Logo size={22} /></Link>
        </div>
        
        <nav className="hidden md:flex items-center gap-8 text-[10px] font-bold uppercase tracking-[0.15em]">
          {navLinks.map((link, i) => (
            <a 
              key={link.label} 
              href={link.href}
              className={cn(
                "hover:text-[#F2C230] transition-colors py-2 border-b-2",
                i === 0 ? "border-[#F2C230] text-[#F2C230]" : "border-transparent text-zinc-400"
              )}
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-6">
          <button 
            onClick={() => router.push('/login')}
            className="text-[10px] font-bold uppercase tracking-widest text-zinc-300 hover:text-white transition-colors"
          >
            Login
          </button>
          <button 
            onClick={() => router.push('/register')}
            className="bg-[#F2C230] hover:bg-[#F6CF55] text-black px-6 py-2.5 text-[10px] font-bold uppercase tracking-widest transition-all shadow-[0_0_15px_rgba(242,194,48,0.1)]"
          >
            Get Started
          </button>
        </div>
      </header>

      <main className="flex flex-col items-center relative z-10 px-4 md:px-8">
        {/* Hero Section */}
        <section className="flex flex-col items-center text-center mt-20 md:mt-32 max-w-4xl mx-auto w-full">
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-center gap-2 border border-[#2E353C] rounded-full px-4 py-1.5 mb-8 bg-[#1D2125]"
          >
            <span className="w-1.5 h-1.5 bg-[#F2C230]" />
            <span className="text-[9px] font-bold text-zinc-400 uppercase tracking-widest">Runs in your browser · No install</span>
          </motion.div>
          
          <motion.h1 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="text-5xl md:text-7xl font-sans font-medium tracking-tight leading-[1.1] mb-6"
          >
            ESTIMATION AT THE <br />
            <span className="text-[#F2C230]">SPEED OF LIGHT</span>
          </motion.h1>
          
          <motion.p 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="text-base text-zinc-400 max-w-2xl mx-auto mb-10 font-sans leading-relaxed"
          >
            Industrial-grade precision for modern estimators. Measure PDF drawings with tools that snap to the linework, calibrate every page, and export a priced BOQ to Excel in seconds.
          </motion.p>

          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="flex flex-col sm:flex-row items-center justify-center gap-4 w-full"
          >
            <button 
              onClick={() => router.push('/register')}
              className="w-full sm:w-auto bg-[#F2C230] hover:bg-[#F6CF55] text-black px-8 py-4 text-[11px] font-bold uppercase tracking-widest transition-all"
            >
              Get Started Free
            </button>
            <a
              href="#how-it-works"
              className="inline-block text-center w-full sm:w-auto border border-[#2E353C] hover:border-zinc-600 bg-[#1D2125] px-8 py-4 text-[11px] font-bold uppercase tracking-widest text-zinc-300 hover:text-white transition-all"
            >
              See How It Works
            </a>
          </motion.div>
        </section>

        {/* Hero Image Mockup */}
        <motion.section 
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="mt-24 w-full max-w-6xl relative"
        >
          <div className="relative aspect-[16/10] bg-[#1D2125] border border-[#2E353C] shadow-2xl p-4 md:p-8 flex flex-col justify-end overflow-hidden group">
            {/* Fake UI Header */}
            <div className="absolute top-4 left-4 flex gap-1.5 opacity-50">
              <div className="w-2 h-2 bg-zinc-600" />
              <div className="w-2 h-2 bg-zinc-600" />
              <div className="w-2 h-2 bg-zinc-600" />
            </div>
            
            {/* Screen Image Content */}
            <div className="w-full h-full border border-[#2E353C] bg-[#16191C] relative overflow-hidden mt-6">
              <img 
                src="https://images.unsplash.com/photo-1503387762-592deb58ef4e?q=80&w=2831&auto=format&fit=crop" 
                alt="" 
                className="w-full h-full object-cover opacity-30 grayscale mix-blend-screen"
              />
              <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-[#16191C] to-transparent pointer-events-none" />
            </div>

            {/* Floating Widget */}
            <div className="absolute -bottom-6 -right-6 md:bottom-8 md:right-[-24px] bg-[#1D2125] border border-[#2E353C] p-6 shadow-2xl z-20 w-64 group-hover:-translate-y-2 transition-transform duration-500">
              <div className="flex justify-between items-start mb-2">
                <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-widest">Calculated Area</span>
                <span className="w-2 h-2 bg-[#F2C230]" />
              </div>
              <div className="text-2xl font-sans font-medium text-white mb-3">1,450.82 M²</div>
              <div className="w-full h-1 bg-[#2E353C]">
                <div className="w-[85%] h-full bg-[#F2C230]" />
              </div>
            </div>
          </div>
          
          {/* Monitor Stand (decorative) */}
          <div className="w-1/3 h-16 md:h-24 bg-gradient-to-b from-[#1D2125] to-[#16191C] mx-auto border-x border-[#2E353C]" />
          <div className="w-1/2 h-2 bg-zinc-800 mx-auto rounded-full blur-[2px]" />
        </motion.section>

        {/* Trusted By */}
        <section id="who-its-for" className="mt-32 w-full border-t border-[#2E353C] pt-16 pb-16">
          <p className="text-center text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-10">
            Built for the people who price the work
          </p>
          <div className="flex flex-wrap justify-center gap-12 md:gap-24 opacity-50 grayscale">
            {['ESTIMATORS', 'QUANTITY SURVEYORS', 'CONTRACTORS', 'JOINERY SHOPS'].map((name, i) => (
              <div key={i} className="flex items-center gap-2">
                <HardHat className="w-5 h-5" />
                <span className="text-[11px] font-bold uppercase tracking-widest">{name}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Features Section */}
        <section id="features" className="w-full max-w-6xl py-24 border-t border-[#2E353C]">
          <div className="mb-16">
            <h2 className="text-4xl md:text-5xl font-sans font-medium text-white mb-4 uppercase tracking-tight">
              Built for the field,<br />
              <span className="text-[#F2C230]">Refined for the office</span>
            </h2>
            <div className="w-16 h-1 bg-[#F2C230]" />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {[
              {
                icon: Layers,
                title: 'Precision Takeoffs',
                desc: 'Points snap to the real linework inside your PDF — endpoints, midpoints, corners, intersections and centres — so every measurement lands exactly on the drawing, at any zoom.'
              },
              {
                icon: Maximize,
                title: 'Per-Page Scaling',
                desc: 'Calibrate each sheet from one known dimension, so mixed-scale drawing sets measure correctly. Recalibrate later and everything already measured on that page updates.'
              },
              {
                icon: FileSpreadsheet,
                title: 'One-Click Excel Export',
                desc: 'Download a clean BOQ workbook with amounts, group subtotals, VAT and grand total as live Excel formulas — ready to send, check or adjust in your own rates.'
              },
              {
                icon: Shapes,
                title: 'Every Measuring Tool',
                desc: 'Linear runs, rectangles, polygons, arcs and polyarcs, counts and grid counts. Undo and redo any step, and switch tools from the keyboard.'
              },
              {
                icon: Wand2,
                title: 'Magic Fill',
                desc: 'Click inside a room and Foldrule traces its boundary for you, turning enclosed spaces into measured areas in a single click.'
              },
              {
                icon: Frame,
                title: 'Perimeter Offsets',
                desc: 'Offset any outline inwards or outwards to measure skirting, edge trims, wall centrelines and set-backs without redrawing.'
              },
              {
                icon: FolderTree,
                title: 'Groups, Rates & Materials',
                desc: 'Organise quantities into groups, attach unit rates and materials from your library, and watch the totals price themselves as you measure.'
              },
              {
                icon: Box,
                title: 'Joinery Presets',
                desc: 'Reuse presets for the items you price again and again, with a live 3D preview to check the build before it goes into the takeoff.'
              },
              {
                icon: ShieldCheck,
                title: 'Private by Design',
                desc: 'Drawings open straight in your browser and never upload. Projects save automatically on your device, and backup files move them between computers.'
              },
            ].map((feat, i) => (
              <div key={i} className="relative p-8 bg-[#1D2125] group transition-colors hover:bg-zinc-900 border border-[#2E353C]">
                {/* Corner Accents */}
                <div className="absolute top-0 left-0 w-2 h-2 border-t border-l border-zinc-500" />
                <div className="absolute top-0 right-0 w-2 h-2 border-t border-r border-zinc-500" />
                <div className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-zinc-500" />
                <div className="absolute bottom-0 right-0 w-2 h-2 border-b border-r border-zinc-500" />

                <div className="w-10 h-10 border border-[#3A4148] flex items-center justify-center mb-6 text-[#F2C230] group-hover:bg-[#F2C230] group-hover:text-black transition-colors">
                  <feat.icon className="w-4 h-4" />
                </div>
                <h3 className="text-[13px] font-bold text-white uppercase tracking-widest mb-4">{feat.title}</h3>
                <p className="text-sm font-sans text-zinc-400 leading-relaxed mb-8">{feat.desc}</p>
                <Link href="/dashboard" className="inline-flex items-center gap-2 text-[10px] font-bold text-[#F2C230] uppercase tracking-widest hover:text-[#F6CF55] group/link">
                  Try It
                  <ArrowRight className="w-3 h-3 transition-transform group-hover/link:translate-x-1" />
                </Link>
              </div>
            ))}
          </div>
        </section>

        {/* Workflow Section */}
        <section id="how-it-works" className="w-full py-24 border-t border-[#2E353C] flex flex-col items-center">
          <div className="text-center mb-16">
            <h3 className="text-sm font-bold text-white uppercase tracking-widest mb-2">Upload. Measure. Estimate.</h3>
            <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-[0.2em]">From PDF to BOQ in four steps</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-8 max-w-6xl w-full">
            {[
              { title: 'Upload', desc: 'Drop in single sheets or full multi-page drawing sets. Linework is read instantly for snapping.' },
              { title: 'Calibrate', desc: 'Click two points on a known dimension and type its length. Each page keeps its own scale.' },
              { title: 'Measure', desc: 'Trace areas, lengths and counts. Group them and add rates — the BOQ builds as you go.' },
              { title: 'Export', desc: 'Download a priced BOQ workbook for Excel, with live formulas, subtotals and VAT.', filled: true },
            ].map((step, i) => (
              <div key={i} className="flex flex-col items-center text-center">
                <div className={cn(
                  "w-14 h-14 flex items-center justify-center mb-6 font-mono font-medium text-lg",
                  step.filled ? "bg-[#F2C230] text-black" : "border border-[#F2C230] text-[#F2C230]"
                )}>
                  0{i + 1}
                </div>
                <h4 className="text-[11px] font-bold text-white uppercase tracking-widest mb-3">{step.title}</h4>
                <p className="text-[11px] font-sans text-zinc-500 leading-relaxed px-4">{step.desc}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="w-full border-t border-[#2E353C] bg-[#16191C] py-8 px-8 flex flex-col md:flex-row justify-between items-center gap-6 z-20 relative">
        <div className="flex flex-col gap-2">
          <Logo size={18} />
          <span className="text-[9px] font-bold text-zinc-600 uppercase tracking-[0.1em]">
            © {new Date().getFullYear()} Foldrule. Precision built for estimators.
          </span>
        </div>
        <div className="flex items-center gap-6 text-[9px] font-bold text-zinc-500 uppercase tracking-widest">
          <a href="#" className="hover:text-white transition-colors">Terms of Service</a>
          <a href="#" className="hover:text-white transition-colors">Privacy Policy</a>
          <a href="#" className="hover:text-white transition-colors">Documentation</a>
          <a href="#" className="hover:text-white transition-colors">Support</a>
        </div>
      </footer>
    </div>
  );
}

import React from 'react';
import { useLocation } from 'wouter';
import { HardHat, ArrowRight, Layers, FileSpreadsheet, Maximize, ArrowUpRight } from 'lucide-react';
import { motion } from 'motion/react';
import { cn } from '../lib/utils';

export function Landing() {
  const [, setLocation] = useLocation();

  const navLinks = ['FEATURES', 'HOW IT WORKS', 'PRICING', 'ENTERPRISE'];

  return (
    <div className="min-h-screen bg-[#0A0A0A] text-zinc-200 font-mono overflow-y-auto selection:bg-amber-500/30">
      {/* Background Grids */}
      <div className="fixed inset-0 blueprint-grid opacity-10 pointer-events-none" />

      {/* Header */}
      <header className="h-20 border-b border-[#262626] bg-[#0A0A0A]/90 backdrop-blur-md px-8 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <span className="text-xl font-black tracking-tighter text-[#F59E0B] uppercase font-['Space_Grotesk']">Quantity Savior</span>
        </div>
        
        <nav className="hidden md:flex items-center gap-8 text-[10px] font-bold uppercase tracking-[0.15em]">
          {navLinks.map((link, i) => (
            <a 
              key={link} 
              href="#" 
              className={cn(
                "hover:text-[#F59E0B] transition-colors py-2 border-b-2",
                i === 0 ? "border-[#F59E0B] text-[#F59E0B]" : "border-transparent text-zinc-400"
              )}
            >
              {link}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-6">
          <button 
            onClick={() => setLocation('/login')}
            className="text-[10px] font-bold uppercase tracking-widest text-zinc-300 hover:text-white transition-colors"
          >
            Login
          </button>
          <button 
            onClick={() => setLocation('/register')}
            className="bg-[#F59E0B] hover:bg-amber-400 text-black px-6 py-2.5 text-[10px] font-bold uppercase tracking-widest transition-all shadow-[0_0_15px_rgba(245,158,11,0.1)]"
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
            className="flex items-center gap-2 border border-[#262626] rounded-full px-4 py-1.5 mb-8 bg-[#161616]"
          >
            <span className="w-1.5 h-1.5 bg-[#F59E0B]" />
            <span className="text-[9px] font-bold text-zinc-400 uppercase tracking-widest">V2.4.0 Engine Active</span>
          </motion.div>
          
          <motion.h1 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="text-5xl md:text-7xl font-sans font-medium tracking-tight leading-[1.1] mb-6"
          >
            ESTIMATION AT THE <br />
            <span className="text-[#F59E0B]">SPEED OF LIGHT</span>
          </motion.h1>
          
          <motion.p 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="text-base text-zinc-400 max-w-2xl mx-auto mb-10 font-sans leading-relaxed"
          >
            Industrial-grade precision for modern estimators. Auto-count, auto-scale, and export to Excel in seconds.
          </motion.p>

          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="flex flex-col sm:flex-row items-center justify-center gap-4 w-full"
          >
            <button 
              onClick={() => setLocation('/register')}
              className="w-full sm:w-auto bg-[#F59E0B] hover:bg-amber-400 text-black px-8 py-4 text-[11px] font-bold uppercase tracking-widest transition-all"
            >
              Get Started Free
            </button>
            <button 
              className="w-full sm:w-auto border border-[#262626] hover:border-zinc-600 bg-[#161616] px-8 py-4 text-[11px] font-bold uppercase tracking-widest text-zinc-300 hover:text-white transition-all"
            >
              Book a Demo
            </button>
          </motion.div>
        </section>

        {/* Hero Image Mockup */}
        <motion.section 
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="mt-24 w-full max-w-6xl relative"
        >
          <div className="relative aspect-[16/10] bg-[#161616] border border-[#262626] shadow-2xl p-4 md:p-8 flex flex-col justify-end overflow-hidden group">
            {/* Fake UI Header */}
            <div className="absolute top-4 left-4 flex gap-1.5 opacity-50">
              <div className="w-2 h-2 bg-zinc-600" />
              <div className="w-2 h-2 bg-zinc-600" />
              <div className="w-2 h-2 bg-zinc-600" />
            </div>
            
            {/* Screen Image Content */}
            <div className="w-full h-full border border-[#262626] bg-[#0A0A0A] relative overflow-hidden mt-6">
              <img 
                src="https://images.unsplash.com/photo-1503387762-592deb58ef4e?q=80&w=2831&auto=format&fit=crop" 
                alt="App interface" 
                className="w-full h-full object-cover opacity-30 grayscale mix-blend-screen"
              />
              <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-[#0A0A0A] to-transparent pointer-events-none" />
            </div>

            {/* Floating Widget */}
            <div className="absolute -bottom-6 -right-6 md:bottom-8 md:right-[-24px] bg-[#161616] border border-[#262626] p-6 shadow-2xl z-20 w-64 group-hover:-translate-y-2 transition-transform duration-500">
              <div className="flex justify-between items-start mb-2">
                <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-widest">Calculated Area</span>
                <span className="w-2 h-2 bg-[#F59E0B]" />
              </div>
              <div className="text-2xl font-sans font-medium text-white mb-3">1,450.82 M²</div>
              <div className="w-full h-1 bg-[#262626]">
                <div className="w-[85%] h-full bg-[#F59E0B]" />
              </div>
            </div>
          </div>
          
          {/* Monitor Stand (decorative) */}
          <div className="w-1/3 h-16 md:h-24 bg-gradient-to-b from-[#161616] to-[#0A0A0A] mx-auto border-x border-[#262626]" />
          <div className="w-1/2 h-2 bg-zinc-800 mx-auto rounded-full blur-[2px]" />
        </motion.section>

        {/* Trusted By */}
        <section className="mt-32 w-full border-t border-[#262626] pt-16 pb-16">
          <p className="text-center text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-10">
            Trusted by 500+ Engineering Firms
          </p>
          <div className="flex flex-wrap justify-center gap-12 md:gap-24 opacity-50 grayscale">
            {['STRUCTURA', 'CORE BUILD', 'PRIME ENG', 'AXIS ARCH'].map((name, i) => (
              <div key={i} className="flex items-center gap-2">
                <HardHat className="w-5 h-5" />
                <span className="text-[11px] font-bold uppercase tracking-widest">{name}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Features Section */}
        <section className="w-full max-w-6xl py-24 border-t border-[#262626]">
          <div className="mb-16">
            <h2 className="text-4xl md:text-5xl font-sans font-medium text-white mb-4 uppercase tracking-tight">
              Built for the field,<br />
              <span className="text-[#F59E0B]">Refined for the office</span>
            </h2>
            <div className="w-16 h-1 bg-[#F59E0B]" />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {[
              { 
                icon: Layers, 
                title: 'Precision Takeoffs', 
                desc: 'Vector-based accuracy that snaps to your PDF geometry. No more guessing pixel-by-pixel. Precision within 0.001mm.' 
              },
              { 
                icon: Maximize, 
                title: 'Auto-Scaling', 
                desc: 'OCR-powered ratio detection instantly recognizes drawing scales. Calibrate once, and let the engine handle the rest.' 
              },
              { 
                icon: FileSpreadsheet, 
                title: 'One-Click Excel Export', 
                desc: 'Industry-standard formatting that integrates directly with your existing cost databases. Clean, structured, and audit-ready.' 
              }
            ].map((feat, i) => (
              <div key={i} className="relative p-8 bg-[#161616] group transition-colors hover:bg-zinc-900 border border-[#262626]">
                {/* Corner Accents */}
                <div className="absolute top-0 left-0 w-2 h-2 border-t border-l border-zinc-500" />
                <div className="absolute top-0 right-0 w-2 h-2 border-t border-r border-zinc-500" />
                <div className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-zinc-500" />
                <div className="absolute bottom-0 right-0 w-2 h-2 border-b border-r border-zinc-500" />

                <div className="w-10 h-10 border border-[#404040] flex items-center justify-center mb-6 text-[#F59E0B] group-hover:bg-[#F59E0B] group-hover:text-black transition-colors">
                  <feat.icon className="w-4 h-4" />
                </div>
                <h3 className="text-[13px] font-bold text-white uppercase tracking-widest mb-4">{feat.title}</h3>
                <p className="text-sm font-sans text-zinc-400 leading-relaxed mb-8">{feat.desc}</p>
                <a href="#" className="inline-flex items-center gap-2 text-[10px] font-bold text-[#F59E0B] uppercase tracking-widest hover:text-amber-400 group/link">
                  Learn More
                  <ArrowRight className="w-3 h-3 transition-transform group-hover/link:translate-x-1" />
                </a>
              </div>
            ))}
          </div>
        </section>

        {/* Workflow Section */}
        <section className="w-full py-24 border-t border-[#262626] flex flex-col items-center">
          <div className="text-center mb-16">
            <h3 className="text-sm font-bold text-white uppercase tracking-widest mb-2">Scan. Measure. Estimate.</h3>
            <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-[0.2em]">Simplified Workflow</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-8 max-w-6xl w-full">
            {[
              { title: 'Upload', desc: 'Drag and drop your PDF blueprints. Our engine parses vector data instantly.' },
              { title: 'Identify', desc: 'Mark areas, count fixtures, and measure lengths with smart snapping tools.' },
              { title: 'Quantify', desc: 'Automatic generation of BOQs with intelligent classification and grouping.' },
              { title: 'Export', desc: 'Finalize and export to XLS or CSV formatted for your procurement ERP.', filled: true },
            ].map((step, i) => (
              <div key={i} className="flex flex-col items-center text-center">
                <div className={cn(
                  "w-14 h-14 flex items-center justify-center mb-6 font-mono font-medium text-lg",
                  step.filled ? "bg-[#F59E0B] text-black" : "border border-[#F59E0B] text-[#F59E0B]"
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
      <footer className="w-full border-t border-[#262626] bg-[#0A0A0A] py-8 px-8 flex flex-col md:flex-row justify-between items-center gap-6 z-20 relative">
        <div className="flex flex-col gap-2">
          <span className="text-sm font-black tracking-tighter text-white uppercase font-['Space_Grotesk']">Quantity Savior</span>
          <span className="text-[9px] font-bold text-zinc-600 uppercase tracking-[0.1em]">
            © 2026 Quantity Savior. Precision built for estimators.
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

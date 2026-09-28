'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Lock } from 'lucide-react';
import * as motion from 'motion/react-m';
import { saveProfile, nameFromEmail } from '@/lib/profile';

export default function Register() {
  const router = useRouter();
  const [name,  setName]  = useState('');
  const [firm,  setFirm]  = useState('');
  const [email, setEmail] = useState('');

  const handleRegister = () => {
    const cleanEmail = email.trim();
    const cleanName  = name.trim() || (cleanEmail ? nameFromEmail(cleanEmail) : '');
    if (cleanName) saveProfile({ name: cleanName, firm: firm.trim() || undefined, email: cleanEmail || undefined });
    router.push('/dashboard');
  };

  return (
    <div className="min-h-screen bg-[#16191C] flex relative overflow-hidden font-mono">
      {/* Background decoration */}
      <div className="absolute inset-0" style={{ 
        backgroundImage: 'radial-gradient(circle, #333 1px, transparent 1px)', 
        backgroundSize: '40px 40px' 
      }} />

      <div className="w-full max-w-7xl mx-auto flex flex-col lg:flex-row relative z-10 p-8 lg:p-12 items-center">
        
        {/* Left Column */}
        <div className="flex-1 lg:pr-24 space-y-16 hidden lg:block border-r border-zinc-800/50 h-full py-12">
          <div className="flex justify-between items-end border-b border-zinc-800/50 pb-4 pr-12">
            <h1 className="text-amber-accent font-bold tracking-widest uppercase">Foldrule</h1>
            <span className="text-zinc-600 text-xs tracking-widest uppercase">EST. MOD // 2024</span>
          </div>

          <div className="space-y-12 pr-12">
            <div className="relative pl-6">
              <div className="absolute left-0 top-0 bottom-0 w-2 bg-amber-accent" />
              <h3 className="text-zinc-200 text-sm font-bold tracking-widest uppercase mb-2">Precision Takeoffs</h3>
              <p className="text-zinc-400 text-sm leading-relaxed">
                Advanced CAD-grade measurement engine with mathematical verification for every vertex.
              </p>
            </div>

            <div className="relative pl-6">
              <div className="absolute left-0 top-0 bottom-0 w-2 border border-amber-accent bg-transparent" />
              <h3 className="text-zinc-200 text-sm font-bold tracking-widest uppercase mb-2">Auto-Scaling</h3>
              <p className="text-zinc-400 text-sm leading-relaxed">
                Instant ratio calibration using OCR to detect plan scales across multiple PDF sheets.
              </p>
            </div>
            
            <div className="relative pl-6">
              <div className="absolute left-0 top-0 bottom-0 w-2 bg-zinc-700" />
              <h3 className="text-zinc-200 text-sm font-bold tracking-widest uppercase mb-2">Excel Export</h3>
              <p className="text-zinc-400 text-sm leading-relaxed">
                Direct formatting into industry-standard workbooks with categorized cost codes.
              </p>
            </div>
          </div>

          <div className="pt-8 border-t border-zinc-800/50 pr-12 flex gap-6">
            <div className="border border-zinc-800 p-4 flex-1">
              <div className="text-[10px] text-zinc-500 uppercase tracking-widest mb-1">Uptime Protocol</div>
              <div className="text-zinc-300 font-bold tracking-wide">99.982% CLUSTER</div>
            </div>
            <div className="border border-zinc-800 p-4 flex-1">
              <div className="text-[10px] text-zinc-500 uppercase tracking-widest mb-1">Data Security</div>
              <div className="text-zinc-300 font-bold tracking-wide">AES-256 ENCRYPTED</div>
            </div>
          </div>
        </div>

        {/* Right Column - Form */}
        <div className="flex-1 w-full lg:pl-24 max-w-xl mx-auto py-12">
          <motion.div 
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            className="relative bg-[#1A1A1A] p-10 border border-zinc-800"
          >
            {/* Corner accents */}
            <div className="absolute top-0 left-0 w-2 h-2 bg-amber-accent -translate-x-1/2 -translate-y-1/2" />
            <div className="absolute bottom-0 right-0 w-2 h-2 bg-amber-accent translate-x-1/2 translate-y-1/2" />

            {/* Header */}
            <div className="mb-10">
              <h2 className="text-zinc-200 text-sm font-bold tracking-widest uppercase mb-3">New Account</h2>
              <p className="text-zinc-400 text-sm leading-relaxed max-w-sm">
                Initialize user profile for professional takeoff suite.
              </p>
            </div>

            {/* Form */}
            <div className="space-y-6">
              <div className="space-y-2">
                <label htmlFor="reg-name" className="text-xs text-zinc-300 tracking-wide block">
                  Full Name
                </label>
                <input
                  id="reg-name"
                  type="text"
                  autoComplete="name"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="ENTER OPERATOR NAME"
                  className="w-full bg-[#111] border border-zinc-800 text-zinc-200 text-xs py-3.5 px-4 outline-none focus:border-amber-accent transition-colors placeholder:text-zinc-700 uppercase"
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="reg-firm" className="text-xs text-zinc-300 tracking-wide block">
                  Company
                </label>
                <input
                  id="reg-firm"
                  type="text"
                  autoComplete="organization"
                  value={firm}
                  onChange={e => setFirm(e.target.value)}
                  placeholder="ENTER FIRM IDENTIFIER"
                  className="w-full bg-[#111] border border-zinc-800 text-zinc-200 text-xs py-3.5 px-4 outline-none focus:border-amber-accent transition-colors placeholder:text-zinc-700 uppercase"
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="reg-email" className="text-xs text-zinc-300 tracking-wide block">
                  Email Address
                </label>
                <input
                  id="reg-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="SYSTEM@DOMAIN.TLD"
                  className="w-full bg-[#111] border border-zinc-800 text-zinc-200 text-xs py-3.5 px-4 outline-none focus:border-amber-accent transition-colors placeholder:text-zinc-700 uppercase"
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="reg-password" className="text-xs text-zinc-300 tracking-wide block">
                  Password
                </label>
                <input
                  id="reg-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder="••••••••••••"
                  className="w-full bg-[#111] border border-zinc-800 text-zinc-200 text-xs py-3.5 px-4 outline-none focus:border-amber-accent transition-colors placeholder:text-zinc-700 uppercase"
                />
              </div>
              
              <button
                type="button"
                onClick={handleRegister}
                className="w-full bg-amber-accent hover:bg-amber-400 text-[#111] font-bold tracking-widest text-xs py-4 flex items-center justify-center gap-3 transition-colors mt-8 uppercase"
              >
                <Lock className="w-3.5 h-3.5" />
                <span>Create Account</span>
              </button>
              
              <div className="pt-6 text-center text-sm text-zinc-400">
                Already registered?{' '}
                <button 
                  onClick={() => router.push('/login')}
                  className="text-amber-accent hover:text-amber-300 transition-colors border-b border-amber-accent/30 hover:border-amber-accent pb-0.5"
                >
                  Sign In
                </button>
              </div>
            </div>
          </motion.div>
          
          <div className="flex justify-end mt-4 text-[9px] text-zinc-600 gap-6 uppercase tracking-widest">
            <div className="text-right">
              <div>Lat: 34.0522 N</div>
              <div>Lon: 118.2437 W</div>
            </div>
            <div className="text-right">
              <div>Status: ONLINE</div>
              <div>ID: QS-99-ALPHA</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

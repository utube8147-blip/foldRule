'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Lock, ArrowRight, AtSign } from 'lucide-react';
import * as motion from 'motion/react-m';
import { getProfile, saveProfile, nameFromEmail } from '@/lib/profile';

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState('');

  const handleLogin = () => {
    const existing = getProfile();
    const clean = email.trim();
    if (clean) {
      saveProfile({
        ...existing,
        email: clean,
        name: existing?.email === clean && existing.name ? existing.name : nameFromEmail(clean),
      });
    }
    router.push('/dashboard');
  };

  return (
    <div className="min-h-screen bg-[#16191C] flex items-center justify-center relative overflow-hidden font-mono">
      {/* Background decoration */}
      <div className="absolute inset-0" style={{ 
        backgroundImage: 'radial-gradient(circle, #333 1px, transparent 1px)', 
        backgroundSize: '40px 40px' 
      }} />
      
      <div className="relative z-10 w-full max-w-[400px]">
        {/* Header Text */}
        <div className="text-center mb-8 space-y-2 uppercase">
          <h1 className="text-amber-accent text-sm tracking-widest font-bold">Foldrule</h1>
          <div className="flex items-center justify-center gap-2 text-zinc-400 text-[10px] tracking-widest">
            <div className="w-1.5 h-1.5 bg-amber-accent" />
            <span>Industrial Estimation Suite</span>
            <div className="w-1.5 h-1.5 bg-amber-accent" />
          </div>
        </div>

        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="relative bg-[#1A1A1A] p-8 border border-zinc-800"
        >
          {/* Corner accents */}
          <div className="absolute top-0 left-0 w-2 h-2 border-t-2 border-l-2 border-amber-accent" />
          <div className="absolute top-0 right-0 w-2 h-2 border-t-2 border-r-2 border-amber-accent" />
          <div className="absolute bottom-0 left-0 w-2 h-2 border-b-2 border-l-2 border-amber-accent" />
          <div className="absolute bottom-0 right-0 w-2 h-2 border-b-2 border-r-2 border-amber-accent" />

          {/* Header */}
          <div className="flex justify-between items-baseline mb-8 pb-4 border-b border-zinc-800">
            <h2 className="text-zinc-200 text-sm tracking-widest uppercase">Terminal Login</h2>
            <span className="text-[9px] text-zinc-500 uppercase tracking-widest">Auth_Mode: Secure</span>
          </div>

          {/* Form */}
          <div className="space-y-6">
            <div className="space-y-2">
              <label htmlFor="login-email" className="text-[10px] text-zinc-400 uppercase tracking-widest block">
                User_Email_ID
              </label>
              <div className="relative">
                <AtSign className="w-3.5 h-3.5 text-zinc-600 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  id="login-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleLogin(); }}
                  placeholder="OPERATOR@FOLDRULE.APP"
                  className="w-full bg-[#111] border border-zinc-800 text-zinc-200 text-xs py-3 pl-10 pr-4 outline-none focus:border-amber-accent transition-colors placeholder:text-zinc-700 uppercase"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor="login-password" className="text-[10px] text-zinc-400 uppercase tracking-widest block">
                Access_Key
              </label>
              <div className="relative">
                <Lock className="w-3.5 h-3.5 text-zinc-600 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  id="login-password"
                  type="password"
                  autoComplete="current-password"
                  onKeyDown={e => { if (e.key === 'Enter') handleLogin(); }}
                  placeholder="••••••••••••"
                  className="w-full bg-[#111] border border-zinc-800 text-zinc-200 text-xs py-3 pl-10 pr-4 outline-none focus:border-amber-accent transition-colors placeholder:text-zinc-700"
                />
              </div>
            </div>
            
            <div className="flex justify-between items-center text-[10px] tracking-widest uppercase mt-4">
              <label className="flex items-center gap-2 cursor-pointer text-zinc-500 hover:text-zinc-300">
                <input type="checkbox" className="form-checkbox bg-[#111] border-zinc-800 rounded-none w-3 h-3 text-amber-accent focus:ring-0 focus:ring-offset-0" />
                <span>Persist Session</span>
              </label>
              <a href="#" className="text-amber-accent hover:text-amber-300">Recovery_Path</a>
            </div>

            <button
              type="button"
              onClick={handleLogin}
              className="w-full bg-amber-accent hover:bg-amber-400 text-[#111] font-bold uppercase tracking-widest text-xs py-4 flex items-center justify-center gap-3 transition-colors mt-6"
            >
              <span>Login</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
            
            <div className="pt-8 border-t border-zinc-800 text-center space-y-4">
              <p className="text-[10px] text-zinc-500 uppercase tracking-widest">New Operator?</p>
              <button 
                onClick={() => router.push('/register')}
                className="w-full bg-transparent border border-amber-accent text-amber-accent hover:bg-amber-accent/10 font-bold uppercase tracking-widest text-xs py-3 transition-colors"
              >
                Create_Account
              </button>
            </div>
          </div>
        </motion.div>
        
        <div className="flex justify-between items-center mt-6 text-[9px] text-zinc-600 uppercase tracking-widest px-4">
          <span>v2.0.48_BUILD_STABLE</span>
          <div className="flex gap-1">
            <div className="w-1 h-1 bg-amber-accent" />
            <div className="w-1 h-1 bg-zinc-600" />
            <div className="w-1 h-1 bg-zinc-600" />
          </div>
        </div>
      </div>

      <div className="fixed bottom-12 right-12 max-w-sm hidden lg:block">
        <h3 className="text-amber-accent text-sm font-bold tracking-widest uppercase mb-2">Precision Data Engine</h3>
        <p className="text-xs text-zinc-500 leading-relaxed">
          System designed for professional takeoff and industrial estimation workflows. 
          Integrity verified via 256-bit encryption. All mathematical models compliant 
          with ISO-9001 standards.
        </p>
      </div>
    </div>
  );
}

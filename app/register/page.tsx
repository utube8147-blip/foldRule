'use client';

// Profile screen. Foldrule has no accounts: the name and firm entered here are
// kept in this browser only (lib/profile.ts) and shown on the dashboard and in
// exports. No password is asked for, because nothing is sent anywhere.

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, HardDrive, ShieldCheck, UserRound } from 'lucide-react';
import { Logo } from '@/components/brand/Logo';
import { getProfile, saveProfile, clearProfile } from '@/lib/profile';

const field =
  'mt-1.5 w-full bg-industrial-black border border-industrial-border px-3 py-2.5 text-sm text-zinc-100 ' +
  'outline-none focus:border-amber-accent transition-colors placeholder:text-zinc-600';

export default function ProfilePage() {
  const router = useRouter();
  const [name,  setName]  = useState('');
  const [firm,  setFirm]  = useState('');
  const [email, setEmail] = useState('');
  const [existing, setExisting] = useState(false);

  useEffect(() => {
    const p = getProfile();
    if (!p) return;
    setExisting(true);
    setName(p.name ?? '');
    setFirm(p.firm ?? '');
    setEmail(p.email ?? '');
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = name.trim();
    if (!clean) return;
    saveProfile({ name: clean, firm: firm.trim() || undefined, email: email.trim() || undefined });
    router.push('/dashboard');
  };

  const remove = () => {
    clearProfile();
    router.push('/dashboard');
  };

  return (
    <div className="min-h-screen bg-industrial-black text-zinc-200 flex flex-col">
      <div className="fixed inset-0 blueprint-grid opacity-10 pointer-events-none" aria-hidden />

      <header className="relative z-10 h-16 border-b border-industrial-border px-6 flex items-center justify-between">
        <Link href="/" aria-label="Foldrule home"><Logo size={22} /></Link>
        <Link href="/dashboard" className="text-xs font-semibold text-zinc-400 hover:text-zinc-100">
          Skip — go to my projects
        </Link>
      </header>

      <main className="relative z-10 flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <div className="flex items-center gap-3 mb-2">
            <span className="w-9 h-9 border border-industrial-border bg-industrial-panel flex items-center justify-center text-amber-accent">
              <UserRound className="w-4 h-4" aria-hidden />
            </span>
            <h1 className="text-2xl font-semibold tracking-tight text-white">
              {existing ? 'Your profile' : 'Set up your profile'}
            </h1>
          </div>
          <p className="text-sm text-zinc-400 leading-relaxed">
            Optional. Your name and firm appear on your dashboard. Foldrule has no accounts and no
            password — this stays in this browser.
          </p>

          <form onSubmit={submit} className="mt-8 bg-industrial-panel border border-industrial-border p-6 space-y-5">
            <label className="block text-xs font-semibold text-zinc-300" htmlFor="pf-name">
              Your name
              <input id="pf-name" required autoFocus maxLength={80} autoComplete="name" value={name}
                onChange={e => setName(e.target.value)} placeholder="e.g. Nimal Perera" className={field} />
            </label>
            <label className="block text-xs font-semibold text-zinc-300" htmlFor="pf-firm">
              Firm <span className="font-normal text-zinc-500">(optional)</span>
              <input id="pf-firm" maxLength={80} autoComplete="organization" value={firm}
                onChange={e => setFirm(e.target.value)} placeholder="e.g. Perera Quantity Surveyors" className={field} />
            </label>
            <label className="block text-xs font-semibold text-zinc-300" htmlFor="pf-email">
              Email <span className="font-normal text-zinc-500">(optional)</span>
              <input id="pf-email" type="email" maxLength={120} autoComplete="email" value={email}
                onChange={e => setEmail(e.target.value)} placeholder="you@firm.com" className={field} />
            </label>

            <button
              type="submit"
              disabled={!name.trim()}
              className="w-full bg-amber-accent hover:bg-amber-400 disabled:opacity-40 text-black font-bold text-sm py-3 flex items-center justify-center gap-2 transition-colors"
            >
              {existing ? 'Save profile' : 'Save and open my projects'}
              <ArrowRight className="w-4 h-4" aria-hidden />
            </button>

            {existing && (
              <button type="button" onClick={remove}
                className="w-full text-xs font-semibold text-zinc-500 hover:text-red-300 transition-colors">
                Remove profile from this browser
              </button>
            )}
          </form>

          <ul className="mt-6 space-y-2.5 text-xs text-zinc-500">
            <li className="flex gap-2.5">
              <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden />
              Nothing on this page is uploaded. Your drawings and projects stay on this computer too.
            </li>
            <li className="flex gap-2.5">
              <HardDrive className="w-4 h-4 text-zinc-500 shrink-0" aria-hidden />
              Removing the profile does not touch your projects.
            </li>
          </ul>
        </div>
      </main>
    </div>
  );
}

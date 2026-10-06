'use client';

import React, { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, LogOut } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { RequireAuth, goAfterSignOut } from '@/components/auth/RequireAuth';
import { Logo } from '@/components/brand/Logo';
import { Field, SubmitButton, FormMessage, LocalModeNotice } from '@/components/auth/AuthShell';

function Account() {
  const { status, mode, user, updateProfile, updatePassword, signOut } = useAuth();
  const [name, setName] = useState('');
  const [firm, setFirm] = useState('');
  const [pBusy, setPBusy] = useState(false);
  const [pMsg, setPMsg]   = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [password, setPassword] = useState('');
  const [wBusy, setWBusy] = useState(false);
  const [wMsg, setWMsg]   = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  useEffect(() => { if (user) { setName(user.name); setFirm(user.firm); } }, [user]);
  if (status === 'local') return <LocalModeNotice />;
  if (!user) return null;

  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setPBusy(true); setPMsg(null);
    const r = await updateProfile({ name, firm });
    setPBusy(false);
    setPMsg(r.ok ? { kind: 'success', text: 'Saved.' } : { kind: 'error', text: r.error });
  };
  const savePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) { setWMsg({ kind: 'error', text: 'Use at least 8 characters.' }); return; }
    setWBusy(true); setWMsg(null);
    const r = await updatePassword(password);
    setWBusy(false);
    setWMsg(r.ok ? { kind: 'success', text: 'Password changed.' } : { kind: 'error', text: r.error });
    if (r.ok) setPassword('');
  };

  return (
    <div className="min-h-screen bg-industrial-black text-zinc-200">
      <header className="h-16 border-b border-industrial-border bg-industrial-panel px-6 flex items-center justify-between">
        <Link href="/dashboard" aria-label="Foldrule — my projects"><Logo size={22} /></Link>
        <Link href="/dashboard" className="flex items-center gap-2 text-xs font-semibold text-zinc-400 hover:text-zinc-100">
          <ArrowLeft className="w-4 h-4" aria-hidden /> My projects
        </Link>
      </header>

      <main className="max-w-xl mx-auto px-4 py-10 space-y-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white">Your account</h1>
          <p className="mt-1 text-sm text-zinc-400">{user.email} · Free plan</p>
        </div>

        {mode === 'mock' && (
          <p role="note" className="border border-amber-400/40 bg-amber-400/[0.07] px-4 py-3 text-xs text-amber-100/90 leading-relaxed">
            <strong className="font-semibold">Demo account.</strong> It is stored in this browser only: it won’t exist on
            another computer or browser, and no emails are sent. Real accounts replace demo ones when the sign-in
            service is connected.
          </p>
        )}

        <form onSubmit={saveProfile} className="bg-industrial-panel border border-industrial-border p-6 space-y-5">
          <h2 className="text-sm font-semibold text-zinc-100">Profile</h2>
          <Field label="Your name" required maxLength={80} autoComplete="name" value={name} onChange={e => setName(e.target.value)} />
          <Field label="Firm (optional)" maxLength={80} autoComplete="organization" value={firm} onChange={e => setFirm(e.target.value)} />
          {pMsg && <FormMessage kind={pMsg.kind}>{pMsg.text}</FormMessage>}
          <div className="max-w-[200px]"><SubmitButton busy={pBusy}>Save profile</SubmitButton></div>
        </form>

        <form onSubmit={savePassword} className="bg-industrial-panel border border-industrial-border p-6 space-y-5">
          <h2 className="text-sm font-semibold text-zinc-100">Change password</h2>
          <Field label="New password" type="password" autoComplete="new-password" minLength={8} required value={password}
            onChange={e => setPassword(e.target.value)} hint="At least 8 characters." />
          {wMsg && <FormMessage kind={wMsg.kind}>{wMsg.text}</FormMessage>}
          <div className="max-w-[200px]"><SubmitButton busy={wBusy}>Change password</SubmitButton></div>
        </form>

        <section className="bg-industrial-panel border border-industrial-border p-6">
          <h2 className="text-sm font-semibold text-zinc-100">Where your projects are</h2>
          <p className="mt-2 text-sm text-zinc-400 leading-relaxed">
            On this computer, under your account. Logging out doesn’t delete them, and other people who log in on this
            computer won’t see them. To use a project on another computer, download a backup from the project list or
            save to a shared folder.
          </p>
        </section>

        <button
          type="button"
          onClick={() => { goAfterSignOut('/'); void signOut(); }}
          className="flex items-center gap-2 text-sm font-semibold text-zinc-400 hover:text-red-300"
        >
          <LogOut className="w-4 h-4" aria-hidden /> Log out
        </button>
      </main>
    </div>
  );
}

export default function AccountPage() {
  return <Suspense fallback={null}><RequireAuth><Account /></RequireAuth></Suspense>;
}

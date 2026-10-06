'use client';

// Shared frame and form bits for the account screens (log in, sign up,
// password reset). Keeps the original look — dotted backdrop, framed card with
// brass corner marks — with plain-language labels.

import React from 'react';
import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import { Logo } from '@/components/brand/Logo';

export function AuthShell({ title, subtitle, children, footer }: {
  title: string; subtitle?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-industrial-black text-zinc-200 flex flex-col relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none" aria-hidden
        style={{ backgroundImage: 'radial-gradient(circle, #2E353C 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

      <header className="relative z-10 h-16 px-6 flex items-center justify-between">
        <Link href="/" aria-label="Foldrule home"><Logo size={22} /></Link>
      </header>

      <main className="relative z-10 flex-1 flex items-center justify-center px-4 pb-16">
        <div className="w-full max-w-[420px]">
          <div className="relative bg-industrial-panel border border-industrial-border p-8">
            {(['top-0 left-0 border-t-2 border-l-2', 'top-0 right-0 border-t-2 border-r-2', 'bottom-0 left-0 border-b-2 border-l-2', 'bottom-0 right-0 border-b-2 border-r-2'] as const)
              .map(c => <span key={c} aria-hidden className={`absolute w-2.5 h-2.5 border-amber-accent ${c}`} />)}
            <h1 className="text-xl font-semibold tracking-tight text-white">{title}</h1>
            {subtitle && <p className="mt-1.5 text-sm text-zinc-400 leading-relaxed">{subtitle}</p>}
            <div className="mt-7">{children}</div>
          </div>
          {footer && <div className="mt-5 text-center text-sm text-zinc-400">{footer}</div>}
          <p className="mt-6 flex items-start justify-center gap-2 text-xs text-zinc-500">
            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden />
            Your drawings and projects stay on your own computer. The account only signs you in.
          </p>
        </div>
      </main>
    </div>
  );
}

export function Field({ label, hint, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  const id = props.id ?? `f-${label.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <label htmlFor={id} className="block text-xs font-semibold text-zinc-300">
      {label}
      <input
        {...props}
        id={id}
        className="mt-1.5 w-full bg-industrial-black border border-industrial-border px-3 py-2.5 text-sm font-normal text-zinc-100 outline-none focus:border-amber-accent transition-colors placeholder:text-zinc-600"
      />
      {hint && <span className="mt-1 block text-[11px] font-normal text-zinc-500">{hint}</span>}
    </label>
  );
}

export function SubmitButton({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="w-full bg-amber-accent hover:bg-amber-400 disabled:opacity-60 text-black font-bold text-sm py-3 transition-colors"
    >
      {busy ? 'Please wait…' : children}
    </button>
  );
}

export function FormMessage({ kind, children }: { kind: 'error' | 'success'; children: React.ReactNode }) {
  return (
    <p role={kind === 'error' ? 'alert' : 'status'}
      className={kind === 'error'
        ? 'border border-red-500/40 bg-red-500/10 px-3 py-2.5 text-xs text-red-200 leading-relaxed'
        : 'border border-emerald-500/40 bg-emerald-500/10 px-3 py-2.5 text-xs text-emerald-100 leading-relaxed'}>
      {children}
    </p>
  );
}

/** Shown on account screens when this deployment has no accounts configured. */
export function LocalModeNotice() {
  return (
    <AuthShell title="Accounts aren’t switched on here"
      subtitle="This copy of Foldrule is running in local mode, so there is nothing to log in to. Your projects are saved on this computer.">
      <Link href="/dashboard" className="block w-full text-center bg-amber-accent hover:bg-amber-400 text-black font-bold text-sm py-3">
        Open my projects
      </Link>
      <p className="mt-4 text-xs text-zinc-500 leading-relaxed">
        Running this yourself? Set <code className="text-zinc-300">NEXT_PUBLIC_SUPABASE_URL</code> and{' '}
        <code className="text-zinc-300">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> to turn accounts on (see the README).
      </p>
    </AuthShell>
  );
}

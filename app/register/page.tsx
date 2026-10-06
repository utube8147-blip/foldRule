'use client';

import React, { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { AuthShell, Field, SubmitButton, FormMessage, LocalModeNotice } from '@/components/auth/AuthShell';

const safeNext = (n: string | null) => (n && n.startsWith('/') && !n.startsWith('//') ? n : '/dashboard');

function RegisterForm() {
  const { status, signUp } = useAuth();
  const router = useRouter();
  const next   = safeNext(useSearchParams().get('next'));
  const [name, setName]   = useState('');
  const [firm, setFirm]   = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  useEffect(() => { if (status === 'signed-in') router.replace(next); }, [status, next, router]);
  if (status === 'local') return <LocalModeNotice />;

  if (sentTo) {
    return (
      <AuthShell title="Check your email"
        subtitle={<>We sent a confirmation link to <strong className="text-zinc-200">{sentTo}</strong>. Open it to finish creating your account — it brings you straight back here.</>}
        footer={<Link href="/login" className="text-amber-accent hover:text-amber-300 font-semibold">Back to log in</Link>}>
        <p className="text-xs text-zinc-500 leading-relaxed">
          Nothing after a couple of minutes? Check the spam folder, or go back and make sure the address is spelled correctly.
        </p>
      </AuthShell>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) { setError('Use at least 8 characters for your password.'); return; }
    setBusy(true); setError(null);
    const r = await signUp({ email, password, name, firm });
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    if (r.needsEmailConfirm) setSentTo(email.trim());
  };

  return (
    <AuthShell title="Create your free account" subtitle="Takes a minute. No card needed."
      footer={<>Already have an account? <Link href="/login" className="text-amber-accent hover:text-amber-300 font-semibold">Log in</Link></>}>
      <form onSubmit={submit} className="space-y-5">
        <Field label="Your name" autoComplete="name" required autoFocus maxLength={80} value={name}
          onChange={e => setName(e.target.value)} placeholder="e.g. Nimal Perera" />
        <Field label="Firm (optional)" autoComplete="organization" maxLength={80} value={firm}
          onChange={e => setFirm(e.target.value)} placeholder="e.g. Perera Quantity Surveyors" />
        <Field label="Email" type="email" autoComplete="email" required value={email}
          onChange={e => setEmail(e.target.value)} placeholder="you@firm.com" />
        <Field label="Password" type="password" autoComplete="new-password" required minLength={8} value={password}
          onChange={e => setPassword(e.target.value)} hint="At least 8 characters." />
        {error && <FormMessage kind="error">{error}</FormMessage>}
        <SubmitButton busy={busy || status === 'loading'}>Create account</SubmitButton>
      </form>
    </AuthShell>
  );
}

export default function RegisterPage() {
  return <Suspense fallback={null}><RegisterForm /></Suspense>;
}

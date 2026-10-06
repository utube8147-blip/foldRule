'use client';

import React, { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { AuthShell, Field, SubmitButton, FormMessage, LocalModeNotice } from '@/components/auth/AuthShell';

/** Only ever send people to a page inside this app. */
const safeNext = (n: string | null) => (n && n.startsWith('/') && !n.startsWith('//') ? n : '/dashboard');

function LoginForm() {
  const { status, signIn } = useAuth();
  const router = useRouter();
  const next   = safeNext(useSearchParams().get('next'));
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (status === 'signed-in') router.replace(next); }, [status, next, router]);
  if (status === 'local') return <LocalModeNotice />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    const r = await signIn(email, password);
    setBusy(false);
    if (!r.ok) setError(r.error);
  };

  return (
    <AuthShell title="Log in" subtitle="Welcome back. Log in to open your projects."
      footer={<>New to Foldrule? <Link href={`/register${next !== '/dashboard' ? `?next=${encodeURIComponent(next)}` : ''}`} className="text-amber-accent hover:text-amber-300 font-semibold">Create a free account</Link></>}>
      <form onSubmit={submit} className="space-y-5" noValidate={false}>
        <Field label="Email" type="email" autoComplete="email" required autoFocus value={email}
          onChange={e => setEmail(e.target.value)} placeholder="you@firm.com" />
        <div>
          <Field label="Password" type="password" autoComplete="current-password" required value={password}
            onChange={e => setPassword(e.target.value)} />
          <Link href="/forgot-password" className="mt-2 inline-block text-xs text-zinc-400 hover:text-amber-accent">Forgot your password?</Link>
        </div>
        {error && <FormMessage kind="error">{error}</FormMessage>}
        <SubmitButton busy={busy || status === 'loading'}>Log in</SubmitButton>
      </form>
    </AuthShell>
  );
}

export default function LoginPage() {
  return <Suspense fallback={null}><LoginForm /></Suspense>;
}

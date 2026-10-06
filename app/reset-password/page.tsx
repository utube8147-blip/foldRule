'use client';

// Landing page for the link in the password-reset email. Supabase signs the
// visitor in from the link (a short-lived recovery session); they then choose
// a new password here.

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { AuthShell, Field, SubmitButton, FormMessage, LocalModeNotice } from '@/components/auth/AuthShell';

export default function ResetPasswordPage() {
  const { status, updatePassword } = useAuth();
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone]   = useState(false);
  if (status === 'local') return <LocalModeNotice />;

  if (status === 'signed-out') {
    return (
      <AuthShell title="This link has expired" subtitle="Reset links work once and only for a short time. Ask for a new one and use it straight away."
        footer={<Link href="/login" className="text-amber-accent hover:text-amber-300 font-semibold">Back to log in</Link>}>
        <Link href="/forgot-password" className="block w-full text-center bg-amber-accent hover:bg-amber-400 text-black font-bold text-sm py-3">
          Send a new link
        </Link>
      </AuthShell>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) { setError('Use at least 8 characters.'); return; }
    if (password !== again)  { setError('The two passwords don’t match.'); return; }
    setBusy(true); setError(null);
    const r = await updatePassword(password);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    setDone(true);
    setTimeout(() => router.replace('/dashboard'), 1200);
  };

  return (
    <AuthShell title="Choose a new password">
      {done ? <FormMessage kind="success">Password changed. Taking you to your projects…</FormMessage> : (
        <form onSubmit={submit} className="space-y-5">
          <Field label="New password" type="password" autoComplete="new-password" required minLength={8} autoFocus
            value={password} onChange={e => setPassword(e.target.value)} hint="At least 8 characters." />
          <Field label="Repeat it" type="password" autoComplete="new-password" required value={again}
            onChange={e => setAgain(e.target.value)} />
          {error && <FormMessage kind="error">{error}</FormMessage>}
          <SubmitButton busy={busy || status === 'loading'}>Save new password</SubmitButton>
        </form>
      )}
    </AuthShell>
  );
}

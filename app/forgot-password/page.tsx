'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/context/AuthContext';
import { AuthShell, Field, SubmitButton, FormMessage } from '@/components/auth/AuthShell';

export default function ForgotPasswordPage() {
  const { mode, sendReset, resetDirect } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone]   = useState(false);
  const mock = mode === 'mock';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    const r = mock ? await resetDirect(email, password) : await sendReset(email);
    setBusy(false);
    if (r.ok) setDone(true); else setError(r.error);
  };

  return (
    <AuthShell title="Reset your password"
      subtitle={mock
        ? 'Demo accounts have no email, so you can set a new password here directly.'
        : 'Enter your account email and we’ll send you a link to choose a new password.'}
      footer={<Link href="/login" className="text-amber-accent hover:text-amber-300 font-semibold">Back to log in</Link>}>
      {done ? (
        <FormMessage kind="success">
          {mock
            ? 'Password changed. You can log in with it now.'
            : `If there is an account for ${email.trim()}, a reset link is on its way. It can take a minute; check spam too.`}
        </FormMessage>
      ) : (
        <form onSubmit={submit} className="space-y-5">
          <Field label="Email" type="email" autoComplete="email" required autoFocus value={email}
            onChange={e => setEmail(e.target.value)} placeholder="you@firm.com" />
          {mock && (
            <Field label="New password" type="password" autoComplete="new-password" required minLength={8} value={password}
              onChange={e => setPassword(e.target.value)} hint="At least 8 characters." />
          )}
          {error && <FormMessage kind="error">{error}</FormMessage>}
          <SubmitButton busy={busy}>{mock ? 'Set new password' : 'Send reset link'}</SubmitButton>
        </form>
      )}
    </AuthShell>
  );
}

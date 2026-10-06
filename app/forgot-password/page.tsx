'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/context/AuthContext';
import { AuthShell, Field, SubmitButton, FormMessage, LocalModeNotice } from '@/components/auth/AuthShell';

export default function ForgotPasswordPage() {
  const { status, sendReset } = useAuth();
  const [email, setEmail] = useState('');
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent]   = useState(false);
  if (status === 'local') return <LocalModeNotice />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    const r = await sendReset(email);
    setBusy(false);
    if (r.ok) setSent(true); else setError(r.error);
  };

  return (
    <AuthShell title="Reset your password" subtitle="Enter your account email and we’ll send you a link to choose a new password."
      footer={<Link href="/login" className="text-amber-accent hover:text-amber-300 font-semibold">Back to log in</Link>}>
      {sent ? (
        <FormMessage kind="success">
          If there is an account for {email.trim()}, a reset link is on its way. It can take a minute; check spam too.
        </FormMessage>
      ) : (
        <form onSubmit={submit} className="space-y-5">
          <Field label="Email" type="email" autoComplete="email" required autoFocus value={email}
            onChange={e => setEmail(e.target.value)} placeholder="you@firm.com" />
          {error && <FormMessage kind="error">{error}</FormMessage>}
          <SubmitButton busy={busy}>Send reset link</SubmitButton>
        </form>
      )}
    </AuthShell>
  );
}

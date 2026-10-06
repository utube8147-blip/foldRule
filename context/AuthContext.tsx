'use client';

// ─── Accounts ────────────────────────────────────────────────────────────────
//
//  Sign-in is handled by Supabase Auth (lib/auth/supabase.ts). The account is
//  who you are; your projects still live on your own computer (IndexedDB +
//  optional folder), each stamped with its owner so two people sharing a
//  browser don't see each other's work (lib/storage/projectDb.ts → ownerId).
//
//  status:
//    'loading'    — finding out whether someone is signed in
//    'signed-in'  — `user` is set
//    'signed-out' — nobody is signed in
//    'local'      — (unused at present) no accounts at all, nothing gated
//
//  mode:
//    'supabase'   — real accounts (the two NEXT_PUBLIC_SUPABASE_* values are set)
//    'mock'       — stand-in accounts kept in this browser only, so the whole
//                   flow works before Supabase is connected. See
//                   lib/auth/mockAuth.ts — not for public launch.
//
//  Cloud sync (planned, paid) will hang off the same user id.
// ─────────────────────────────────────────────────────────────────────────────

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { AUTH_CONFIGURED, getSupabase } from '@/lib/auth/supabase';
import { setStorageOwner } from '@/lib/storage/projectDb';
import {
  mockCurrentUser, mockSignIn, mockSignUp, mockSignOut, mockResetPassword, mockUpdate, onMockSessionChange,
  type MockUser,
} from '@/lib/auth/mockAuth';

export type AuthStatus = 'loading' | 'signed-in' | 'signed-out' | 'local';

export interface AccountUser {
  id:    string;
  email: string;
  name:  string;
  firm:  string;
}

type Result = { ok: true; needsEmailConfirm?: boolean } | { ok: false; error: string };

export type AuthMode = 'supabase' | 'mock';

interface AuthValue {
  status: AuthStatus;
  mode:   AuthMode;
  /** Mock mode only (there is no email): set a new password for an account directly. */
  resetDirect: (email: string, password: string) => Promise<Result>;
  user:   AccountUser | null;
  signIn:         (email: string, password: string) => Promise<Result>;
  signUp:         (p: { email: string; password: string; name: string; firm?: string }) => Promise<Result>;
  signOut:        () => Promise<void>;
  sendReset:      (email: string) => Promise<Result>;
  updatePassword: (password: string) => Promise<Result>;
  updateProfile:  (p: { name: string; firm?: string }) => Promise<Result>;
}

const noop = async (): Promise<Result> => ({ ok: false, error: 'Accounts are not set up on this deployment.' });
const AuthContext = createContext<AuthValue>({
  status: 'loading', mode: AUTH_CONFIGURED ? 'supabase' : 'mock', user: null, resetDirect: noop,
  signIn: noop, signUp: noop, signOut: async () => {}, sendReset: noop, updatePassword: noop, updateProfile: noop,
});

export const useAuth = () => useContext(AuthContext);

function toAccount(u: User): AccountUser {
  const meta = (u.user_metadata ?? {}) as { name?: string; full_name?: string; firm?: string };
  const email = u.email ?? '';
  return {
    id: u.id, email,
    name: (meta.name || meta.full_name || email.split('@')[0] || 'Account').trim(),
    firm: (meta.firm ?? '').trim(),
  };
}

/** Plain-language versions of the messages people actually hit. */
function explain(message: string | undefined): string {
  const m = (message ?? '').toLowerCase();
  if (m.includes('invalid login credentials')) return 'That email and password don’t match an account.';
  if (m.includes('email not confirmed'))       return 'Please confirm your email first — check your inbox for the link we sent.';
  if (m.includes('already registered') || m.includes('already been registered')) return 'There is already an account with that email. Try logging in instead.';
  if (m.includes('password') && m.includes('at least')) return 'That password is too short — use at least 8 characters.';
  if (m.includes('rate limit') || m.includes('too many'))  return 'Too many attempts. Wait a minute and try again.';
  if (m.includes('failed to fetch') || m.includes('network')) return 'Couldn’t reach the sign-in service. Check your internet connection and try again.';
  return message || 'Something went wrong. Please try again.';
}

const fromMock = (u: MockUser): AccountUser => ({ id: u.id, email: u.email, name: u.name, firm: u.firm });

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const mode: AuthMode = AUTH_CONFIGURED ? 'supabase' : 'mock';
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user,   setUser]   = useState<AccountUser | null>(null);

  useEffect(() => {
    const sb = getSupabase();
    if (!sb) {
      // Mock accounts: read the saved session from this browser.
      const sync = () => {
        const u = mockCurrentUser();
        setStorageOwner(null);   // demo accounts don't own projects (see mockAuth.ts)
        setUser(u ? fromMock(u) : null);
        setStatus(u ? 'signed-in' : 'signed-out');
      };
      sync();
      return onMockSessionChange(sync);
    }
    let alive = true;
    const apply = (u: User | null | undefined) => {
      if (!alive) return;
      const acc = u ? toAccount(u) : null;
      // Tell storage whose projects to show BEFORE anything renders them.
      setStorageOwner(acc ? acc.id : null);
      setUser(acc);
      setStatus(acc ? 'signed-in' : 'signed-out');
    };
    // getSession reads the saved session (no network), so this works offline.
    sb.auth.getSession().then(({ data }) => apply(data.session?.user)).catch(() => apply(null));
    const { data: sub } = sb.auth.onAuthStateChange((_event, session) => apply(session?.user));
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, []);

  const origin = () => (typeof window !== 'undefined' ? window.location.origin : '');

  const applyMock = useCallback((u: MockUser | null) => {
    setStorageOwner(null);   // demo accounts don't own projects (see mockAuth.ts)
    setUser(u ? fromMock(u) : null);
    setStatus(u ? 'signed-in' : 'signed-out');
  }, []);

  const resetDirect = useCallback<AuthValue['resetDirect']>(async (email, password) => {
    if (getSupabase()) return { ok: false, error: 'Use the link in the reset email.' };
    const r = await mockResetPassword(email, password);
    return r.ok ? { ok: true } : r;
  }, []);

  const signIn = useCallback<AuthValue['signIn']>(async (email, password) => {
    const sb = getSupabase();
    if (!sb) { const r = await mockSignIn(email, password); if (!r.ok) return r; applyMock(r.user); return { ok: true }; }
    const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
    return error ? { ok: false, error: explain(error.message) } : { ok: true };
  }, []);

  const signUp = useCallback<AuthValue['signUp']>(async ({ email, password, name, firm }) => {
    const sb = getSupabase();
    if (!sb) { const r = await mockSignUp({ email, password, name, firm }); if (!r.ok) return r; applyMock(r.user); return { ok: true }; }
    const { data, error } = await sb.auth.signUp({
      email: email.trim(), password,
      options: { data: { name: name.trim(), firm: (firm ?? '').trim() }, emailRedirectTo: `${origin()}/dashboard` },
    });
    if (error) return { ok: false, error: explain(error.message) };
    // With "Confirm email" on (Supabase default) there is no session until the link is clicked.
    return { ok: true, needsEmailConfirm: !data.session };
  }, []);

  const signOut = useCallback(async () => {
    const sb = getSupabase();
    if (!sb) { mockSignOut(); applyMock(null); return; }
    await sb.auth.signOut().catch(() => {});
  }, []);

  const sendReset = useCallback<AuthValue['sendReset']>(async (email) => {
    const sb = getSupabase(); if (!sb) return noop();
    const { error } = await sb.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${origin()}/reset-password` });
    return error ? { ok: false, error: explain(error.message) } : { ok: true };
  }, []);

  const updatePassword = useCallback<AuthValue['updatePassword']>(async (password) => {
    const sb = getSupabase();
    if (!sb) { const me = mockCurrentUser(); if (!me) return noop(); const r = await mockUpdate(me.id, { password }); return r.ok ? { ok: true } : r; }
    const { error } = await sb.auth.updateUser({ password });
    return error ? { ok: false, error: explain(error.message) } : { ok: true };
  }, []);

  const updateProfile = useCallback<AuthValue['updateProfile']>(async ({ name, firm }) => {
    const sb = getSupabase();
    if (!sb) { const me = mockCurrentUser(); if (!me) return noop(); const r = await mockUpdate(me.id, { name, firm }); if (!r.ok) return r; applyMock(r.user); return { ok: true }; }
    const { data, error } = await sb.auth.updateUser({ data: { name: name.trim(), firm: (firm ?? '').trim() } });
    if (error) return { ok: false, error: explain(error.message) };
    if (data.user) setUser(toAccount(data.user));
    return { ok: true };
  }, []);

  const value = useMemo(() => ({ status, mode, resetDirect, user, signIn, signUp, signOut, sendReset, updatePassword, updateProfile }),
    [status, mode, resetDirect, user, signIn, signUp, signOut, sendReset, updatePassword, updateProfile]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

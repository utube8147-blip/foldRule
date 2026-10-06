'use client';

// ─── Mock accounts (stand-in until Supabase is connected) ────────────────────
//
//  Used automatically when NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY are not set.
//  Sign-up, log in, log out, profile and password changes all work, so the
//  whole product flow can be built, demoed and tested — but the accounts live
//  ONLY in this browser's localStorage:
//
//    • an account made here does not exist on any other computer or browser;
//    • there is no email (no confirmation, no reset link — the reset screen
//      sets a new password directly);
//    • it is NOT security: anyone with this browser profile can read or edit
//      the stored accounts. Passwords are salted and hashed only so that real
//      passwords typed during a demo aren't left lying around in plain text.
//
//  Demo accounts do not own projects: every project on this computer is shown
//  to whoever is logged in, and nothing is stamped with a demo id — so clearing
//  the browser, or switching to real accounts, never strands a project. (The
//  first REAL account to open the list adopts them.)
//
//  Do not launch to the public on this. Setting the two Supabase variables
//  switches every screen to real accounts with no code changes.
// ─────────────────────────────────────────────────────────────────────────────

const USERS_KEY   = 'foldrule:mock-users';
const SESSION_KEY = 'foldrule:mock-session';

export interface MockUser { id: string; email: string; name: string; firm: string; salt: string; hash: string; createdAt: number }
export type MockResult = { ok: true; user: MockUser } | { ok: false; error: string };

const read = (): MockUser[] => {
  try { return JSON.parse(localStorage.getItem(USERS_KEY) ?? '[]') as MockUser[]; } catch { return []; }
};
const write = (users: MockUser[]) => localStorage.setItem(USERS_KEY, JSON.stringify(users));
const norm = (email: string) => email.trim().toLowerCase();

async function digest(salt: string, password: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${salt}:${password}`);
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
const newSalt = () => Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');

export function mockCurrentUser(): MockUser | null {
  try {
    const id = localStorage.getItem(SESSION_KEY);
    return id ? read().find(u => u.id === id) ?? null : null;
  } catch { return null; }
}

export async function mockSignUp(p: { email: string; password: string; name: string; firm?: string }): Promise<MockResult> {
  const email = norm(p.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'That doesn’t look like an email address.' };
  if (p.password.length < 8) return { ok: false, error: 'That password is too short — use at least 8 characters.' };
  const users = read();
  if (users.some(u => u.email === email)) return { ok: false, error: 'There is already an account with that email. Try logging in instead.' };
  const salt = newSalt();
  const user: MockUser = {
    id: `mock-${crypto.randomUUID()}`, email, name: p.name.trim() || email.split('@')[0], firm: (p.firm ?? '').trim(),
    salt, hash: await digest(salt, p.password), createdAt: Date.now(),
  };
  write([...users, user]);
  localStorage.setItem(SESSION_KEY, user.id);
  return { ok: true, user };
}

export async function mockSignIn(emailRaw: string, password: string): Promise<MockResult> {
  const user = read().find(u => u.email === norm(emailRaw));
  if (!user || (await digest(user.salt, password)) !== user.hash) {
    return { ok: false, error: 'That email and password don’t match an account.' };
  }
  localStorage.setItem(SESSION_KEY, user.id);
  return { ok: true, user };
}

export function mockSignOut(): void {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}

/** No email exists in mock mode, so a reset sets the new password directly. */
export async function mockResetPassword(emailRaw: string, password: string): Promise<MockResult> {
  if (password.length < 8) return { ok: false, error: 'Use at least 8 characters.' };
  const users = read();
  const i = users.findIndex(u => u.email === norm(emailRaw));
  if (i < 0) return { ok: false, error: 'There is no account with that email on this computer.' };
  const salt = newSalt();
  users[i] = { ...users[i], salt, hash: await digest(salt, password) };
  write(users);
  return { ok: true, user: users[i] };
}

export async function mockUpdate(id: string, patch: { name?: string; firm?: string; password?: string }): Promise<MockResult> {
  const users = read();
  const i = users.findIndex(u => u.id === id);
  if (i < 0) return { ok: false, error: 'You are no longer logged in.' };
  let next = { ...users[i] };
  if (patch.name !== undefined) next.name = patch.name.trim() || next.name;
  if (patch.firm !== undefined) next.firm = patch.firm.trim();
  if (patch.password !== undefined) {
    if (patch.password.length < 8) return { ok: false, error: 'Use at least 8 characters.' };
    const salt = newSalt();
    next = { ...next, salt, hash: await digest(salt, patch.password) };
  }
  users[i] = next;
  write(users);
  return { ok: true, user: next };
}

/** Other tabs logging in / out. */
export function onMockSessionChange(cb: () => void): () => void {
  const h = (e: StorageEvent) => { if (e.key === SESSION_KEY || e.key === USERS_KEY) cb(); };
  window.addEventListener('storage', h);
  return () => window.removeEventListener('storage', h);
}

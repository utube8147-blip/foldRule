'use client';

// Local profile shown in the dashboard header. There is no account server yet,
// so the name/firm/email typed on Sign up or Log in are kept in this browser
// only. Passwords are never stored. Replace with real auth when the backend lands.

export interface LocalProfile {
  name:  string;
  firm?: string;
  email?: string;
}

const KEY = 'foldrule:profile';

export function getProfile(): LocalProfile | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as LocalProfile) : null;
  } catch {
    return null;
  }
}

export function saveProfile(p: LocalProfile): void {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* storage blocked */ }
}

export function clearProfile(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/** Derive a display name from an email when only the email is known. */
export function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? '';
  return local.replace(/[._-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim() || 'Estimator';
}

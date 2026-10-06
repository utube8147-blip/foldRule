'use client';

// Supabase client for sign-in. Only the project URL and the public ("anon")
// key are used — both are meant to be shipped to the browser. Set them in
// .env.local / the hosting dashboard:
//
//   NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
//   NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
//
// Without them the app uses mock accounts kept in the browser (lib/auth/mockAuth.ts),
// so the flow works for development and demos. See README → Accounts.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

/** True when this deployment has accounts switched on. */
export const AUTH_CONFIGURED = /^https?:\/\//.test(URL) && KEY.length > 20;

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (!AUTH_CONFIGURED || typeof window === 'undefined') return null;
  if (!client) {
    client = createClient(URL, KEY, {
      auth: {
        persistSession:     true,      // stay signed in; also works offline in the installed app
        autoRefreshToken:   true,
        detectSessionInUrl: true,      // email-confirmation and password-reset links
      },
    });
  }
  return client;
}

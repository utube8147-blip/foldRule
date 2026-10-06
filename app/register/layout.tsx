// Account screens (Supabase Auth — see context/AuthContext.tsx).
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title:  'Create account',
  robots: { index: false, follow: true },
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

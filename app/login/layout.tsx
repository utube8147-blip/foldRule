// Sign-in screens. There is no account server yet: signing in stores a local
// profile in this browser (lib/profile.ts) and opens the dashboard.
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title:  'Log in',
  robots: { index: false, follow: true },
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

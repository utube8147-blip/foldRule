// Profile screen. There are no accounts: the profile is stored in this browser
// only (lib/profile.ts). /login redirects to /register.
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title:  'Profile',
  robots: { index: false, follow: true },
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

// Placeholder auth screen. There is no backend yet — projects are stored
// locally — so this route is hidden (404) in production builds unless
// NEXT_PUBLIC_ENABLE_LABS=true. Wire real auth here when the backend lands.
import { notFound } from 'next/navigation';
import { LABS_ENABLED } from '@/lib/config/labs';

export default function AuthPlaceholderLayout({ children }: { children: React.ReactNode }) {
  if (!LABS_ENABLED) notFound();
  return <>{children}</>;
}

// FILE: src/app/(project)/layout.tsx
// NEW FILE — Route-group layout that wraps /workspace and /takeoff-full together.
//
// Folder structure:
//   src/app/
//     (project)/                  ← route group, parentheses = no URL segment added
//       layout.tsx            ← THIS FILE — mounts TakeoffProvider once
//       workspace/
//         page.tsx            ← your existing Workspace (updated below)
//       takeoff-full/
//         page.tsx            ← new TakeoffFullPage
//
// Move your existing src/app/workspace/ into src/app/(app)/workspace/.
// The URL stays /workspace — the (app) group folder is invisible to the router.

import { TakeoffProvider } from '@/context/TakeoffContext';
import { PresetProvider }  from '@/context/PresetContext';


export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <TakeoffProvider>
      <PresetProvider>
        {children}
      </PresetProvider>
    </TakeoffProvider>
  );
}
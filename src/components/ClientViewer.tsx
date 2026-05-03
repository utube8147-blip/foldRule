// components/ClientViewer.tsx
'use client';

import dynamic from 'next/dynamic';

// Dynamically import Viewer with no SSR
const Viewer = dynamic(
  () => import('@/components/Viewer'),
  { 
    ssr: false,
    loading: () => (
      <div className="flex-1 bg-stone-950 flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-[10px] text-zinc-500 uppercase tracking-widest">Loading 3D Canvas...</p>
        </div>
      </div>
    )
  }
);

export default Viewer;
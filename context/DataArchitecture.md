> **Status: proposal, not implemented.** The app today is local-first: projects live in IndexedDB
> (`lib/storage/projectDb.ts`), optionally mirrored to a folder (`lib/storage/folderSync.ts`), with
> state in `context/TakeoffContext.tsx`. Nothing below (Supabase, Zustand, auth) exists in the code.
> Keep this only as a sketch for a possible cloud version.

# Cloud-Based Project Architecture
### Estimator Pro — Supabase + Zustand + Next.js

---

## Overview

A cloud-first SaaS architecture where authenticated users manage projects with full persistence. All project data lives in Supabase (Postgres + Storage). Zustand holds the currently open project in memory for fast UI interactions. Periodic auto-save syncs changes back to the cloud.

```
Auth → Project List → Open Project → Work → Auto-Save → Cloud
```

---

## Stack Decision

| Layer | Tool | Why |
|---|---|---|
| Database | Supabase (Postgres) | Auth + DB + Storage in one. RLS built in. |
| File Storage | Supabase Storage | PDFs and images, DB stores URL refs only |
| In-memory state | Zustand (no persist) | Fast UI, no localStorage conflicts |
| Framework | Next.js App Router | Route groups for clean layout nesting |

> **Why no localStorage?** Once data lives in the cloud, localStorage becomes a liability — stale data on different devices, merge conflicts, no auth boundary. Zustand holds working state only. On refresh, re-fetch from Supabase.

---

## Data Model

```
User
  └── Projects (many)
        ├── metadata        name, number, status, timestamps
        ├── Drawings (many) file refs (Storage URL) + scale factor
        ├── Measurements    all TakeoffRows
        ├── Materials       rate library per project
        └── Files           PDFs / images in Supabase Storage
```

---

## Database Schema

```sql
-- Projects
create table projects (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users not null,
  name        text not null,
  number      text,
  status      text default 'active',
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- Drawings (metadata only, actual file in Storage)
create table drawings (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid references projects on delete cascade,
  name         text,
  file_url     text,
  scale_factor numeric default 1,
  page_number  int default 1,
  created_at   timestamptz default now()
);

-- Measurements (TakeoffRow)
create table measurements (
  id               uuid primary key,
  project_id       uuid references projects on delete cascade,
  drawing_id       uuid references drawings,
  description      text,
  type             text,
  quantity         numeric,
  unit             text,
  unit_rate        numeric default 0,
  notes            text,
  group_id         text,
  group_name       text,
  is_group_header  boolean default false,
  is_overridden    boolean default false,
  color            text,
  is_visible       boolean default true,
  preset_id        text,
  points           jsonb,
  created_at       timestamptz default now()
);

-- Materials
create table materials (
  id             uuid primary key,
  project_id     uuid references projects on delete cascade,
  name           text,
  code           text,
  unit           text,
  material_cost  numeric,
  labor_cost     numeric,
  equipment_cost numeric
);
```

---

## Row Level Security

Always enable RLS. Users must never be able to read another user's data.

```sql
alter table projects    enable row level security;
alter table drawings    enable row level security;
alter table measurements enable row level security;
alter table materials   enable row level security;

-- Projects: user owns their own
create policy "users own their projects"
  on projects for all
  using (user_id = auth.uid());

-- Drawings: scoped through project ownership
create policy "users own their drawings"
  on drawings for all
  using (
    project_id in (
      select id from projects where user_id = auth.uid()
    )
  );

-- Measurements: same pattern
create policy "users own their measurements"
  on measurements for all
  using (
    project_id in (
      select id from projects where user_id = auth.uid()
    )
  );

-- Materials: same pattern
create policy "users own their materials"
  on materials for all
  using (
    project_id in (
      select id from projects where user_id = auth.uid()
    )
  );
```

---

## Zustand Store

```ts
// src/store/projectStore.ts
import { create } from 'zustand'
import { supabase } from '@/lib/supabase'

interface ProjectStore {
  // currently open project
  activeProject:    Project | null
  drawings:         Drawing[]
  measurements:     TakeoffRow[]
  materials:        MaterialSpec[]

  // sync status
  isSaving:  boolean
  lastSaved: Date | null
  isDirty:   boolean       // unsaved changes exist

  // actions
  loadProject:       (projectId: string) => Promise<void>
  addMeasurement:    (m: TakeoffRow) => void
  updateMeasurement: (id: string, updates: Partial<TakeoffRow>) => void
  deleteMeasurement: (id: string) => void
  saveProject:       () => Promise<void>
  closeProject:      () => void
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  activeProject: null,
  drawings:      [],
  measurements:  [],
  materials:     [],
  isSaving:      false,
  lastSaved:     null,
  isDirty:       false,

  loadProject: async (projectId) => {
    const [project, drawings, measurements, materials] = await Promise.all([
      supabase.from('projects').select('*').eq('id', projectId).single(),
      supabase.from('drawings').select('*').eq('project_id', projectId),
      supabase.from('measurements').select('*').eq('project_id', projectId),
      supabase.from('materials').select('*').eq('project_id', projectId),
    ])

    set({
      activeProject: project.data,
      drawings:      drawings.data      ?? [],
      measurements:  measurements.data  ?? [],
      materials:     materials.data     ?? [],
      isDirty:       false,
    })
  },

  addMeasurement: (m) => set(state => ({
    measurements: [...state.measurements, m],
    isDirty: true,
  })),

  updateMeasurement: (id, updates) => set(state => ({
    measurements: state.measurements.map(m =>
      m.id === id ? { ...m, ...updates } : m
    ),
    isDirty: true,
  })),

  deleteMeasurement: (id) => set(state => ({
    measurements: state.measurements.filter(m => m.id !== id),
    isDirty: true,
  })),

  saveProject: async () => {
    const { activeProject, measurements, materials } = get()
    if (!activeProject) return

    set({ isSaving: true })

    await Promise.all([
      supabase.from('measurements').upsert(
        measurements.map(m => ({ ...m, project_id: activeProject.id }))
      ),
      supabase.from('materials').upsert(
        materials.map(m => ({ ...m, project_id: activeProject.id }))
      ),
      supabase.from('projects')
        .update({ updated_at: new Date() })
        .eq('id', activeProject.id),
    ])

    set({ isSaving: false, lastSaved: new Date(), isDirty: false })
  },

  closeProject: () => set({
    activeProject: null,
    drawings:      [],
    measurements:  [],
    materials:     [],
    isDirty:       false,
  }),
}))
```

---

## Auto-Save Hook

Triggers a save every 30 seconds if there are unsaved changes. Also saves on tab close.

```ts
// src/hooks/useAutoSave.ts
import { useEffect } from 'react'
import { useProjectStore } from '@/store/projectStore'

export function useAutoSave(intervalMs = 30_000) {
  const isDirty     = useProjectStore(s => s.isDirty)
  const saveProject = useProjectStore(s => s.saveProject)

  // Periodic save
  useEffect(() => {
    if (!isDirty) return
    const timer = setInterval(() => {
      saveProject()
    }, intervalMs)
    return () => clearInterval(timer)
  }, [isDirty, saveProject, intervalMs])

  // Save on tab/window close
  useEffect(() => {
    const handleUnload = () => {
      if (isDirty) saveProject()
    }
    window.addEventListener('beforeunload', handleUnload)
    return () => window.removeEventListener('beforeunload', handleUnload)
  }, [isDirty, saveProject])
}
```

Mount once at layout level — not per page:

```tsx
// src/app/(app)/layout.tsx
export default function AppLayout({ children }) {
  useAutoSave(30_000)
  return children
}
```

---

## Save Status Component

Always show the user where their data stands.

```tsx
// src/components/SaveStatus.tsx
export function SaveStatus() {
  const isSaving  = useProjectStore(s => s.isSaving)
  const isDirty   = useProjectStore(s => s.isDirty)
  const lastSaved = useProjectStore(s => s.lastSaved)

  if (isSaving)   return <span className="text-amber-500">Saving...</span>
  if (isDirty)    return <span className="text-zinc-500">Unsaved changes</span>
  if (lastSaved)  return <span className="text-green-500">Saved {timeAgo(lastSaved)}</span>
  return null
}
```

---

## Folder Structure

```
src/
  app/
    (auth)/
      login/
        page.tsx
      signup/
        page.tsx
    (app)/
      layout.tsx          ← mounts useAutoSave, checks auth session
      projects/
        page.tsx          ← project list, fetches from Supabase directly
      workspace/
        page.tsx          ← reads from Zustand store
      takeoff-full/
        page.tsx          ← reads from Zustand store
  store/
    projectStore.ts       ← Zustand store
  hooks/
    useAutoSave.ts        ← periodic save hook
  lib/
    supabase.ts           ← Supabase client singleton
  components/
    SaveStatus.tsx
```

---

## User Flow

```
1. User visits app
      ↓
2. (auth) layout checks session → redirect to /login if none
      ↓
3. /projects page
   SELECT * FROM projects WHERE user_id = auth.uid()
   Shows project cards with name, number, last updated
      ↓
4. User clicks a project
   loadProject(id) → fetches drawings, measurements, materials in parallel
   Hydrates Zustand store
      ↓
5. /workspace or /takeoff-full
   All reads come from Zustand (fast, no network)
   All writes go to Zustand + set isDirty = true
      ↓
6. Auto-save fires every 30s if isDirty
   upsert measurements, materials → Supabase
   set isDirty = false, lastSaved = now
      ↓
7. User closes tab
   beforeunload → saveProject() fires if isDirty
      ↓
8. User returns later
   Session still valid → loadProject() re-fetches from Supabase
   Exactly where they left off
```

---

## The Core Principle

```
Supabase  =  source of truth       (permanent, cloud)
Zustand   =  working memory        (current session, fast)
UI        =  reads Zustand only    (no network latency on interactions)

Load project  →  Supabase  →  Zustand
User works    →  Zustand only
Auto-save     →  Zustand  →  Supabase  (every 30s)
Page refresh  →  Supabase  →  Zustand  (re-fetch)
```

---

## What to Build First

1. Set up Supabase project and run the schema SQL
2. Enable RLS and add the policies
3. Build `/login` and `/signup` with Supabase Auth
4. Build `/projects` list page
5. Create the Zustand store with `loadProject` and `saveProject`
6. Wire `loadProject` to project card click
7. Replace `useTakeoffContext()` calls with `useProjectStore()` selectors
8. Add `useAutoSave` to the app layout
9. Add `<SaveStatus />` to the navbar
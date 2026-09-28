'use client';

import { useCallback } from 'react';
import { useTakeoffData } from '@/context/TakeoffContext';

export const projectHref = (path: string, projectId: string | null | undefined): string =>
  projectId ? `${path}?project=${encodeURIComponent(projectId)}` : path;

/** Build links that keep the currently open project (e.g. /takeoff-full?project=…). */
export function useProjectHref(): (path: string) => string {
  const { projectId } = useTakeoffData();
  return useCallback((path: string) => projectHref(path, projectId), [projectId]);
}

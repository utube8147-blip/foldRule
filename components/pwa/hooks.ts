'use client';

import { useEffect, useSyncExternalStore } from 'react';
import {
  subscribeFolderStatus, getFolderStatus, getServerFolderStatus, initFolderSync, type FolderStatus,
} from '@/lib/storage/folderSync';
import { subscribeInstall, getInstallState, getServerInstallState } from '@/lib/pwa/install';

export function useFolderStatus(): FolderStatus {
  useEffect(() => { void initFolderSync(); }, []);
  return useSyncExternalStore(subscribeFolderStatus, getFolderStatus, getServerFolderStatus);
}

export function useInstallState() {
  return useSyncExternalStore(subscribeInstall, getInstallState, getServerInstallState);
}

'use client';

import { useEffect, useSyncExternalStore } from 'react';
import {
  subscribeFolderStatus, getFolderStatus, getServerFolderStatus, initFolderSync, type FolderStatus,
} from '@/lib/storage/folderSync';
import { subscribeStorageMode, getStorageMode, getServerStorageMode, type StorageMode } from '@/lib/storage/projectDb';
import { subscribeInstall, getInstallState, getServerInstallState } from '@/lib/pwa/install';

export function useFolderStatus(): FolderStatus {
  useEffect(() => { void initFolderSync(); }, []);
  return useSyncExternalStore(subscribeFolderStatus, getFolderStatus, getServerFolderStatus);
}

export function useInstallState() {
  return useSyncExternalStore(subscribeInstall, getInstallState, getServerInstallState);
}

/** 'memory' when the browser's own storage is unavailable (e.g. full disk). */
export function useStorageMode(): StorageMode {
  return useSyncExternalStore(subscribeStorageMode, getStorageMode, getServerStorageMode);
}

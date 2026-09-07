export function lastShellPathStorageKey(profileId: string): string {
  return `bb.webviewShell.lastPath.${profileId}`;
}

export interface ShellPreferenceStorage {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
}

export interface ShellPreferenceStore {
  getLastPath(profileId: string): string | null;
  setLastPath(profileId: string, path: string): void;
}

const MAX_REMEMBERED_PATH_LENGTH = 512;

export function isRememberablePath(path: string): boolean {
  return (
    path.startsWith("/") &&
    !path.startsWith("//") &&
    path.length <= MAX_REMEMBERED_PATH_LENGTH
  );
}

export function createShellPreferenceStore(
  storage: ShellPreferenceStorage,
): ShellPreferenceStore {
  return {
    getLastPath: (profileId) => {
      const stored = storage.getString(lastShellPathStorageKey(profileId));
      if (stored === undefined || !isRememberablePath(stored)) return null;
      return stored;
    },
    setLastPath: (profileId, path) => {
      if (!isRememberablePath(path)) return;
      storage.set(lastShellPathStorageKey(profileId), path);
    },
  };
}

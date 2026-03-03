const PROJECT_SCOPED_STORAGE_VERSION = "1";

function normalizeStorageSegment(value: string): string {
  return encodeURIComponent(value.trim());
}

export function getProjectScopedStorageKey(
  storageKeyPrefix: string,
  projectId?: string | null,
): string {
  if (!projectId || projectId.trim().length === 0) {
    return storageKeyPrefix;
  }
  return `${storageKeyPrefix}-${normalizeStorageSegment(projectId)}-${PROJECT_SCOPED_STORAGE_VERSION}`;
}

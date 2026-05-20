export const MANAGER_STATUS_FILE_PATH = "STATUS";
export const MANAGER_STATUS_MARKDOWN_FILE_PATH = "STATUS.md";
export const MANAGER_STATUS_HTML_FILE_PATH = "STATUS.html";

export interface ManagerStorageFileEntry {
  path: string;
}

export type ManagerStorageFiles = readonly ManagerStorageFileEntry[];

export function isManagerStatusStorageFilePath(path: string): boolean {
  return (
    path === MANAGER_STATUS_FILE_PATH ||
    path === MANAGER_STATUS_MARKDOWN_FILE_PATH ||
    path === MANAGER_STATUS_HTML_FILE_PATH
  );
}

export function resolvePinnedManagerStorageFilePath(
  _storageFiles: ManagerStorageFiles | undefined,
): string {
  return MANAGER_STATUS_FILE_PATH;
}

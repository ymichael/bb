import type { ViewFileEditMessage } from "@bb/domain";

type FileEditChange = ViewFileEditMessage["changes"][number];

export interface ChangedFileNamesSummary {
  extraCount: number;
  names: string[];
  totalUniqueFiles: number;
}

export function fileNameFromPath(path: string): string {
  const normalizedPath = path.replaceAll("\\", "/");
  const segments = normalizedPath.split("/");
  const candidate = segments[segments.length - 1];
  return candidate && candidate.length > 0 ? candidate : path;
}

export function fileChangeIdentity(change: FileEditChange): string {
  return (change.movePath ?? change.path).replaceAll("\\", "/");
}

export function formatFileChangeName(change: FileEditChange): string {
  const sourceName = fileNameFromPath(change.path);
  if (!change.movePath) {
    return sourceName;
  }
  const destinationName = fileNameFromPath(change.movePath);
  return `${sourceName} → ${destinationName}`;
}

export function countUniqueChangedFiles(
  changes: readonly FileEditChange[],
): number {
  const seenFiles = new Set<string>();
  for (const change of changes) {
    seenFiles.add(fileChangeIdentity(change));
  }
  return seenFiles.size;
}

export function summarizeChangedFileNames(
  changes: readonly FileEditChange[],
  maxNames: number,
): ChangedFileNamesSummary {
  const seenFiles = new Set<string>();
  const names: string[] = [];

  for (const change of changes) {
    const identity = fileChangeIdentity(change);
    if (seenFiles.has(identity)) {
      continue;
    }
    seenFiles.add(identity);
    if (names.length < maxNames) {
      names.push(formatFileChangeName(change));
    }
  }

  return {
    names,
    totalUniqueFiles: seenFiles.size,
    extraCount: Math.max(0, seenFiles.size - names.length),
  };
}

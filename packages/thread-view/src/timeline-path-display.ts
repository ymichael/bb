export type TimelinePathDisplayMode = "compact" | "full";

interface FormatTimelinePathArgs {
  mode: TimelinePathDisplayMode;
  path: string;
}

export function fileNameFromPath(path: string): string {
  const normalizedPath = path.replaceAll("\\", "/");
  const segments = normalizedPath.split("/");
  const candidate = segments[segments.length - 1];
  return candidate && candidate.length > 0 ? candidate : path;
}

export function directoryFromPath(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash === -1 ? "" : path.slice(0, lastSlash);
}

export function formatTimelinePath({
  mode,
  path,
}: FormatTimelinePathArgs): string {
  switch (mode) {
    case "compact":
      return fileNameFromPath(path);
    case "full":
      return path;
  }
}

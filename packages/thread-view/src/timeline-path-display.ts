export type TimelinePathDisplayMode = "compact" | "full";

export interface FormatTimelinePathArgs {
  mode: TimelinePathDisplayMode;
  path: string;
}

export function fileNameFromPath(path: string): string {
  const normalizedPath = path.replaceAll("\\", "/");
  const segments = normalizedPath.split("/");
  const candidate = segments[segments.length - 1];
  return candidate && candidate.length > 0 ? candidate : path;
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

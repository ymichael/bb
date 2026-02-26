import { pickProjectFolder } from "@/lib/api";

export function normalizeProjectRootPath(rawPath: string): string {
  const trimmed = rawPath.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) {
    return "";
  }

  const normalized = trimmed.replace(/\\/g, "/");
  if (normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)) {
    return normalized;
  }

  return normalized.replace(/\/+$/, "");
}

export function deriveProjectNameFromPath(path: string): string {
  if (!path || path === "/") {
    return "";
  }

  const segments = path.split("/").filter(Boolean);
  return segments.at(-1) ?? "";
}

export async function requestProjectRootPath(): Promise<string | null> {
  try {
    const selected = await pickProjectFolder();
    if (!selected.path) {
      return null;
    }
    return normalizeProjectRootPath(selected.path);
  } catch {
    const typed = window.prompt("Enter the full folder path for this project:");
    if (typed == null) {
      return null;
    }
    const normalized = normalizeProjectRootPath(typed);
    return normalized || null;
  }
}

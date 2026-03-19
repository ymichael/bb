import type { EnvironmentRecord } from "./types.js";

export interface EnvironmentDisplayInfo {
  /** Human-readable label: "Primary", "Worktree", "Docker", etc. */
  label: string;
  /** The environment kind for programmatic use */
  kind: "primary" | "worktree" | "docker" | "local" | "unknown";
  /** The environment ID (for use with --environment flag) */
  id: string;
  /** The filesystem path, if available */
  path?: string;
  /** Whether bb manages this environment's lifecycle */
  managed: boolean;
}

/**
 * Produce a structured display object for an environment record.
 *
 * The label logic mirrors the UI's `formatThreadEnvironmentLabel()` in
 * `ThreadDetailView.tsx` so that CLI and UI show consistent terminology.
 */
export function formatEnvironmentDisplay(
  environment: EnvironmentRecord,
  projectRootPath?: string,
): EnvironmentDisplayInfo {
  const descriptorPath = environment.descriptor?.path;
  const properties = environment.properties;

  // Determine kind + label
  const isPrimary =
    projectRootPath !== undefined &&
    descriptorPath !== undefined &&
    normalizePath(descriptorPath) === normalizePath(projectRootPath);

  if (isPrimary) {
    return {
      label: "Direct",
      kind: "primary",
      id: environment.id,
      path: descriptorPath,
      managed: environment.managed,
    };
  }

  if (properties?.location === "docker") {
    return {
      label: "Docker",
      kind: "docker",
      id: environment.id,
      path: descriptorPath,
      managed: environment.managed,
    };
  }

  if (properties?.workspaceKind === "worktree") {
    const suffix = formatRelativePath(descriptorPath, projectRootPath);
    const label = suffix ? `Worktree (${suffix})` : "Worktree";
    return {
      label,
      kind: "worktree",
      id: environment.id,
      path: descriptorPath,
      managed: environment.managed,
    };
  }

  if (properties?.location === "localhost") {
    return {
      label: "Local",
      kind: "local",
      id: environment.id,
      path: descriptorPath,
      managed: environment.managed,
    };
  }

  return {
    label: "Unknown",
    kind: "unknown",
    id: environment.id,
    path: descriptorPath,
    managed: environment.managed,
  };
}

function normalizePath(p: string): string {
  return p.replace(/\/+$/, "");
}

function formatRelativePath(
  path?: string,
  projectRootPath?: string,
): string | undefined {
  if (!path || !projectRootPath) {
    return path ? lastSegment(path) : undefined;
  }
  const normalizedRoot = normalizePath(projectRootPath);
  const normalizedPath = normalizePath(path);
  if (normalizedPath === normalizedRoot) {
    return undefined;
  }
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  return lastSegment(path);
}

function lastSegment(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.at(-1) ?? path;
}

import type { Environment, WorkspaceFileStatus } from "@bb/domain";
import type { WorkspaceChangedFilesSection } from "@/components/workspace/workspace-change-summary";
import type {
  EnvironmentFilePreviewSource,
  WorkspaceFilePreviewStatusLabel,
} from "@/lib/file-preview";

interface ResolveThreadWorkspaceOpenPathArgs {
  canOpenWorkspace: boolean;
  environment: Environment | null | undefined;
  hasWorkspaceOpenTargets: boolean;
  threadEnvironmentIsLocal: boolean;
}

export interface BuildOpenInEditorHandlerArgs {
  rootPath: string | null;
  canOpenPreferredTarget: boolean;
  openInPreferredTarget: (request: {
    lineNumber: number | null;
    path: string;
  }) => Promise<boolean>;
}

function joinAbsolutePath(rootPath: string, relativePath: string): string {
  const trimmedRoot = rootPath.endsWith("/") ? rootPath.slice(0, -1) : rootPath;
  const trimmedRelative = relativePath.startsWith("/")
    ? relativePath.slice(1)
    : relativePath;
  return `${trimmedRoot}/${trimmedRelative}`;
}

/**
 * Build the file-preview header's "open in editor" callback, gated on the
 * thread's environment being local and an editor being configured. Returns
 * `undefined` when either gate isn't satisfied so the icon hides instead of
 * surfacing a no-op button.
 */
export function buildOpenInEditorHandler(
  args: BuildOpenInEditorHandlerArgs,
): ((relativePath: string) => void) | undefined {
  if (!args.rootPath || !args.canOpenPreferredTarget) {
    return undefined;
  }
  const rootPath = args.rootPath;
  return (relativePath) => {
    void args.openInPreferredTarget({
      lineNumber: null,
      path: joinAbsolutePath(rootPath, relativePath),
    });
  };
}

export interface ResolveThreadLocalWorkspaceRootPathArgs {
  environment: Environment | null | undefined;
  threadEnvironmentIsLocal: boolean;
}

export type WorkspaceChangedFileOpenTarget =
  | { kind: "diff" }
  | {
      kind: "preview";
      source: EnvironmentFilePreviewSource;
      statusLabel: WorkspaceFilePreviewStatusLabel | null;
    };

export interface ResolveWorkspaceChangedFileOpenTargetArgs {
  file: WorkspaceFileStatus;
  section: WorkspaceChangedFilesSection;
}

export function resolveWorkspaceChangedFileOpenTarget(
  args: ResolveWorkspaceChangedFileOpenTargetArgs,
): WorkspaceChangedFileOpenTarget {
  if (args.file.status === "A" || args.file.status === "??") {
    return {
      kind: "preview",
      source: { kind: "working-tree" },
      statusLabel: null,
    };
  }

  if (args.file.status === "D") {
    if (args.section.kind === "committed") {
      return args.section.mergeBaseRef
        ? {
            kind: "preview",
            source: { kind: "merge-base", ref: args.section.mergeBaseRef },
            statusLabel: "deleted",
          }
        : { kind: "diff" };
    }
    return {
      kind: "preview",
      source: { kind: "head" },
      statusLabel: "deleted",
    };
  }

  return { kind: "diff" };
}

export function resolveThreadLocalWorkspaceRootPath(
  args: ResolveThreadLocalWorkspaceRootPathArgs,
): string | null {
  if (!args.threadEnvironmentIsLocal) {
    return null;
  }

  return args.environment?.path ?? null;
}

export function resolveThreadWorkspaceOpenPath(
  args: ResolveThreadWorkspaceOpenPathArgs,
): string | null {
  if (!args.canOpenWorkspace || !args.hasWorkspaceOpenTargets) {
    return null;
  }

  return resolveThreadLocalWorkspaceRootPath({
    environment: args.environment,
    threadEnvironmentIsLocal: args.threadEnvironmentIsLocal,
  });
}

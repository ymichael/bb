import type { ThreadTimelineLocalFileLink } from "@/components/thread/timeline";
import { matchPath } from "react-router-dom";
import { APP_ROUTE_PATTERNS } from "./app-route-paths";

const THREAD_LOCAL_FILE_LINK_UNAVAILABLE_DESCRIPTION =
  "Thread file links are only available when the thread has an environment.";
const THREAD_LOCAL_FILE_LINK_INVALID_PATH_DESCRIPTION =
  "Thread file links must use absolute file paths.";

export interface ResolveThreadLocalFileLinkArgs {
  hostFileLinksAvailable: boolean;
  link: ThreadTimelineLocalFileLink;
  workspaceRootPath: string | null;
}

export interface ThreadWorkspaceFileLinkOpenRequest {
  lineNumber: number | null;
  path: string;
  relativePath: string;
  workspaceRootPath: string;
}

export interface ThreadHostFileLinkOpenRequest {
  lineNumber: number | null;
  path: string;
}

interface ThreadLocalFileLinkAppRouteResolution {
  kind: "app-route";
}

interface ThreadLocalFileLinkErrorResolution {
  description: string;
  kind: "error";
}

interface ThreadWorkspaceFileLinkOpenResolution {
  kind: "open-workspace-path";
  request: ThreadWorkspaceFileLinkOpenRequest;
}

interface ThreadHostFileLinkOpenResolution {
  kind: "open-host-path";
  request: ThreadHostFileLinkOpenRequest;
}

interface WorkspacePathWithinRootArgs {
  candidatePath: string;
  workspaceRootPath: string;
}

interface NormalizeThreadLocalFileLinkPathArgs {
  linkPath: string;
  workspaceRootPath: string;
}

interface NormalizedThreadLocalFileLinkPath {
  path: string;
  relativePath: string;
  workspaceRootPath: string;
}

export type ThreadLocalFileLinkResolution =
  | ThreadLocalFileLinkAppRouteResolution
  | ThreadLocalFileLinkErrorResolution
  | ThreadWorkspaceFileLinkOpenResolution
  | ThreadHostFileLinkOpenResolution;

function isAppRoutePath(path: string): boolean {
  return APP_ROUTE_PATTERNS.some(
    (pattern) => matchPath(pattern, path) !== null,
  );
}

function normalizeAbsolutePath(candidatePath: string): string | null {
  if (!candidatePath.startsWith("/")) {
    return null;
  }

  const normalizedSegments: string[] = [];
  for (const segment of candidatePath.split("/")) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (normalizedSegments.length > 0) {
        normalizedSegments.pop();
      }
      continue;
    }
    normalizedSegments.push(segment);
  }

  return normalizedSegments.length === 0
    ? "/"
    : `/${normalizedSegments.join("/")}`;
}

function normalizeThreadLocalFileLinkPath(
  args: NormalizeThreadLocalFileLinkPathArgs,
): NormalizedThreadLocalFileLinkPath | null {
  const normalizedWorkspaceRootPath = normalizeAbsolutePath(
    args.workspaceRootPath,
  );
  if (!normalizedWorkspaceRootPath) {
    return null;
  }

  const normalizedPath = normalizeAbsolutePath(args.linkPath);
  if (!normalizedPath) {
    return null;
  }

  if (
    !isPathWithinWorkspaceRoot({
      candidatePath: normalizedPath,
      workspaceRootPath: normalizedWorkspaceRootPath,
    }) ||
    normalizedPath === normalizedWorkspaceRootPath
  ) {
    return null;
  }

  const relativePath =
    normalizedWorkspaceRootPath === "/"
      ? normalizedPath.slice(1)
      : normalizedPath.slice(normalizedWorkspaceRootPath.length + 1);

  return {
    path: normalizedPath,
    relativePath,
    workspaceRootPath: normalizedWorkspaceRootPath,
  };
}

function isPathWithinWorkspaceRoot(args: WorkspacePathWithinRootArgs): boolean {
  if (args.workspaceRootPath === "/") {
    return args.candidatePath.startsWith("/");
  }

  return (
    args.candidatePath === args.workspaceRootPath ||
    args.candidatePath.startsWith(`${args.workspaceRootPath}/`)
  );
}

export function resolveThreadLocalFileLink(
  args: ResolveThreadLocalFileLinkArgs,
): ThreadLocalFileLinkResolution {
  if (isAppRoutePath(args.link.path)) {
    return {
      kind: "app-route",
    };
  }

  const normalizedPath = normalizeAbsolutePath(args.link.path);
  if (!normalizedPath) {
    return {
      description: THREAD_LOCAL_FILE_LINK_INVALID_PATH_DESCRIPTION,
      kind: "error",
    };
  }

  const openRequest =
    args.workspaceRootPath === null
      ? null
      : normalizeThreadLocalFileLinkPath({
          linkPath: normalizedPath,
          workspaceRootPath: args.workspaceRootPath,
        });

  if (openRequest) {
    return {
      kind: "open-workspace-path",
      request: {
        lineNumber: args.link.lineNumber,
        path: openRequest.path,
        relativePath: openRequest.relativePath,
        workspaceRootPath: openRequest.workspaceRootPath,
      },
    };
  }

  if (!args.hostFileLinksAvailable) {
    return {
      description: THREAD_LOCAL_FILE_LINK_UNAVAILABLE_DESCRIPTION,
      kind: "error",
    };
  }

  return {
    kind: "open-host-path",
    request: {
      lineNumber: args.link.lineNumber,
      path: normalizedPath,
    },
  };
}

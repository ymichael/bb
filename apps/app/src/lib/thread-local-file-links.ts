import type { ThreadTimelineLocalFileLink } from "@/components/thread-timeline";
import { matchPath } from "react-router-dom";
import { APP_ROUTE_PATTERNS } from "./app-route-paths";

const THREAD_LOCAL_FILE_LINK_UNAVAILABLE_DESCRIPTION =
  "Thread file links are only available for ready local workspaces.";
const THREAD_LOCAL_FILE_LINK_OUTSIDE_WORKSPACE_DESCRIPTION =
  "Thread file links can only open files inside the current workspace.";

export interface ResolveThreadLocalFileLinkArgs {
  link: ThreadTimelineLocalFileLink;
  workspaceRootPath: string | null;
}

export interface ThreadLocalFileLinkOpenRequest {
  lineNumber: number | null;
  path: string;
  workspaceRootPath: string;
}

interface ThreadLocalFileLinkAppRouteResolution {
  kind: "app-route";
}

interface ThreadLocalFileLinkErrorResolution {
  description: string;
  kind: "error";
}

interface ThreadLocalFileLinkOpenResolution {
  kind: "open-local-path";
  request: ThreadLocalFileLinkOpenRequest;
}

interface WorkspacePathWithinRootArgs {
  candidatePath: string;
  workspaceRootPath: string;
}

export type ThreadLocalFileLinkResolution =
  | ThreadLocalFileLinkAppRouteResolution
  | ThreadLocalFileLinkErrorResolution
  | ThreadLocalFileLinkOpenResolution;

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

  if (args.workspaceRootPath === null) {
    return {
      description: THREAD_LOCAL_FILE_LINK_UNAVAILABLE_DESCRIPTION,
      kind: "error",
    };
  }

  const normalizedPath = normalizeAbsolutePath(args.link.path);
  const normalizedWorkspaceRootPath = normalizeAbsolutePath(
    args.workspaceRootPath,
  );

  if (
    !normalizedPath ||
    !normalizedWorkspaceRootPath ||
    !isPathWithinWorkspaceRoot({
      candidatePath: normalizedPath,
      workspaceRootPath: normalizedWorkspaceRootPath,
    })
  ) {
    return {
      description: THREAD_LOCAL_FILE_LINK_OUTSIDE_WORKSPACE_DESCRIPTION,
      kind: "error",
    };
  }

  return {
    kind: "open-local-path",
    request: {
      lineNumber: args.link.lineNumber,
      path: normalizedPath,
      workspaceRootPath: normalizedWorkspaceRootPath,
    },
  };
}

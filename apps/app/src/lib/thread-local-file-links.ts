import type { ThreadTimelineLocalFileLink } from "@/components/thread/timeline";
import { matchPath } from "react-router-dom";
import { APP_ROUTE_PATTERNS } from "./app-route-paths";

const THREAD_LOCAL_FILE_LINK_UNAVAILABLE_DESCRIPTION =
  "Thread file links are only available for ready local workspaces.";
const THREAD_LOCAL_FILE_LINK_OUTSIDE_WORKSPACE_DESCRIPTION =
  "Thread file links can only open files inside the current workspace or thread storage.";
const THREAD_STORAGE_DIRECTORY_NAME = "thread-storage";

export interface ResolveThreadLocalFileLinkArgs {
  link: ThreadTimelineLocalFileLink;
  threadId?: string | null;
  threadStorageRootPath?: string | null;
  workspaceRootPath: string | null;
}

export interface ThreadLocalFileLinkOpenRequest {
  lineNumber: number | null;
  path: string;
  relativePath: string;
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

interface ThreadStorageFileLinkOpenRequest {
  lineNumber: number | null;
  path: string;
  relativePath: string;
  rootPath: string;
}

interface ThreadStorageFileLinkOpenResolution {
  kind: "open-thread-storage-path";
  request: ThreadStorageFileLinkOpenRequest;
}

interface WorkspacePathWithinRootArgs {
  candidatePath: string;
  workspaceRootPath: string;
}

interface NormalizeThreadLocalFileLinkPathArgs {
  linkPath: string;
  workspaceRootPath: string;
}

interface NormalizeThreadStoragePathFromRootArgs {
  linkPath: string;
  threadStorageRootPath: string | null | undefined;
}

interface NormalizeThreadStoragePathFromThreadIdArgs {
  linkPath: string;
  threadId: string | null | undefined;
}

interface NormalizeThreadStoragePathArgs
  extends
    NormalizeThreadStoragePathFromRootArgs,
    NormalizeThreadStoragePathFromThreadIdArgs {}

interface NormalizedLocalFileLinkPath {
  path: string;
  relativePath: string;
  rootPath: string;
}

export type ThreadLocalFileLinkResolution =
  | ThreadLocalFileLinkAppRouteResolution
  | ThreadLocalFileLinkErrorResolution
  | ThreadLocalFileLinkOpenResolution
  | ThreadStorageFileLinkOpenResolution;

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
): NormalizedLocalFileLinkPath | null {
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
    rootPath: normalizedWorkspaceRootPath,
  };
}

function normalizeThreadStoragePathFromRoot(
  args: NormalizeThreadStoragePathFromRootArgs,
): NormalizedLocalFileLinkPath | null {
  if (!args.threadStorageRootPath) {
    return null;
  }
  return normalizeThreadLocalFileLinkPath({
    linkPath: args.linkPath,
    workspaceRootPath: args.threadStorageRootPath,
  });
}

function normalizeThreadStoragePathFromThreadId(
  args: NormalizeThreadStoragePathFromThreadIdArgs,
): NormalizedLocalFileLinkPath | null {
  if (!args.threadId) {
    return null;
  }

  const normalizedPath = normalizeAbsolutePath(args.linkPath);
  if (!normalizedPath) {
    return null;
  }

  const segments = normalizedPath.split("/").filter((segment) => segment);
  for (let index = 0; index < segments.length - 2; index += 1) {
    if (
      segments[index] !== THREAD_STORAGE_DIRECTORY_NAME ||
      segments[index + 1] !== args.threadId
    ) {
      continue;
    }

    const rootPath = `/${segments.slice(0, index + 2).join("/")}`;
    const relativePath = segments.slice(index + 2).join("/");
    if (relativePath.length === 0) {
      return null;
    }

    return {
      path: normalizedPath,
      relativePath,
      rootPath,
    };
  }

  return null;
}

function normalizeThreadStoragePath(
  args: NormalizeThreadStoragePathArgs,
): NormalizedLocalFileLinkPath | null {
  return (
    normalizeThreadStoragePathFromRoot({
      linkPath: args.linkPath,
      threadStorageRootPath: args.threadStorageRootPath,
    }) ??
    normalizeThreadStoragePathFromThreadId({
      linkPath: args.linkPath,
      threadId: args.threadId,
    })
  );
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

  const threadStorageRequest = normalizeThreadStoragePath({
    linkPath: args.link.path,
    threadId: args.threadId,
    threadStorageRootPath: args.threadStorageRootPath,
  });
  if (threadStorageRequest) {
    return {
      kind: "open-thread-storage-path",
      request: {
        lineNumber: args.link.lineNumber,
        path: threadStorageRequest.path,
        relativePath: threadStorageRequest.relativePath,
        rootPath: threadStorageRequest.rootPath,
      },
    };
  }

  if (args.workspaceRootPath === null) {
    return {
      description: THREAD_LOCAL_FILE_LINK_UNAVAILABLE_DESCRIPTION,
      kind: "error",
    };
  }

  const openRequest = normalizeThreadLocalFileLinkPath({
    linkPath: args.link.path,
    workspaceRootPath: args.workspaceRootPath,
  });

  if (!openRequest) {
    return {
      description: THREAD_LOCAL_FILE_LINK_OUTSIDE_WORKSPACE_DESCRIPTION,
      kind: "error",
    };
  }

  return {
    kind: "open-local-path",
    request: {
      lineNumber: args.link.lineNumber,
      path: openRequest.path,
      relativePath: openRequest.relativePath,
      workspaceRootPath: openRequest.rootPath,
    },
  };
}

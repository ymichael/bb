import path from "node:path";
import { watchPathChanges } from "./watch-path.js";
import { watchWorkspaceStatus } from "./watch-status.js";
import type {
  HostWatcher,
  ThreadStorageWatchTarget,
  WatchThreadStorageRootArgs,
  WatchWorkspaceArgs,
} from "./host-watcher-types.js";

interface ThreadStoragePathArgs {
  changedPath: string;
  threadStorageRootPath: string;
}

function toThreadIdFromStoragePath(args: ThreadStoragePathArgs): string | null {
  const relativePath = path.relative(
    args.threadStorageRootPath,
    args.changedPath,
  );
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }
  const [threadId] = relativePath.split(path.sep).filter(Boolean);
  return threadId ?? null;
}

function toThreadStorageTargetEvents(args: {
  changedPaths: string[];
  threadStorageRootPath: string;
  resolveThreadTarget: (threadId: string) => ThreadStorageWatchTarget | null;
}): ThreadStorageWatchTarget[] {
  const targets = new Map<string, ThreadStorageWatchTarget>();
  for (const changedPath of args.changedPaths) {
    const threadId = toThreadIdFromStoragePath({
      changedPath,
      threadStorageRootPath: args.threadStorageRootPath,
    });
    if (!threadId) {
      continue;
    }
    const target = args.resolveThreadTarget(threadId);
    if (!target) {
      continue;
    }
    targets.set(`${target.environmentId}:${target.threadId}`, target);
  }
  return Array.from(targets.values());
}

function watchWorkspace(args: WatchWorkspaceArgs): () => void {
  return watchWorkspaceStatus(args.workspacePath, {
    onChange: (event) => {
      args.onChange({
        changedPaths: event.changedPaths,
        changeKinds: event.changeKinds,
        kind: "workspace-status-changed",
        environmentId: args.environmentId,
      });
    },
    onWatchError: (error) => {
      args.onWatchError({
        kind: "workspace-watch-error",
        environmentId: args.environmentId,
        rootPath: error.rootPath,
        message: error.message,
      });
    },
  });
}

function watchThreadStorageRoot(args: WatchThreadStorageRootArgs): () => void {
  return watchPathChanges(args.threadStorageRootPath, {
    onChange: ({ changedPaths }) => {
      const targets = toThreadStorageTargetEvents({
        changedPaths,
        threadStorageRootPath: args.threadStorageRootPath,
        resolveThreadTarget: args.resolveThreadTarget,
      });
      for (const target of targets) {
        args.onChange({
          kind: "thread-storage-changed",
          environmentId: target.environmentId,
          threadId: target.threadId,
        });
      }
    },
    onWatchError: (error) => {
      args.onWatchError({
        kind: "thread-storage-watch-error",
        rootPath: error.rootPath,
        message: error.message,
      });
    },
  });
}

export function createParcelHostWatcher(): HostWatcher {
  return {
    watchWorkspace,
    watchThreadStorageRoot,
  };
}

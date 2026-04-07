import type { HostType } from "@bb/domain";
import type { WorkspaceStatusWatchChangeKind } from "./watch-status-types.js";

export type HostObservedChange =
  | {
      kind: "workspace-status-changed";
      changedPaths: string[];
      changeKinds: WorkspaceStatusWatchChangeKind[];
      environmentId: string;
    }
  | {
      kind: "thread-storage-changed";
      environmentId: string;
      threadId: string;
    };

export type WorkspaceObservedChange = Extract<
  HostObservedChange,
  { kind: "workspace-status-changed" }
>;

export type ThreadStorageObservedChange = Extract<
  HostObservedChange,
  { kind: "thread-storage-changed" }
>;

export interface WorkspaceWatchError {
  kind: "workspace-watch-error";
  environmentId: string;
  rootPath: string;
  message: string;
}

export interface ThreadStorageWatchError {
  kind: "thread-storage-watch-error";
  rootPath: string;
  message: string;
  environmentId?: string;
  threadId?: string;
}

export type HostWatchError = WorkspaceWatchError | ThreadStorageWatchError;

export interface ThreadStorageWatchTarget {
  environmentId: string;
  threadId: string;
}

export interface WatchWorkspaceArgs {
  environmentId: string;
  workspacePath: string;
  onChange: (event: WorkspaceObservedChange) => void;
  onWatchError: (error: WorkspaceWatchError) => void;
}

export interface WatchThreadStorageRootArgs {
  threadStorageRootPath: string;
  resolveThreadTarget: (threadId: string) => ThreadStorageWatchTarget | null;
  onChange: (event: ThreadStorageObservedChange) => void;
  onWatchError: (error: ThreadStorageWatchError) => void;
}

export interface HostWatcher {
  watchWorkspace(args: WatchWorkspaceArgs): () => void;
  watchThreadStorageRoot(args: WatchThreadStorageRootArgs): () => void;
}

export interface CreateHostWatcherArgs {
  hostType: HostType;
}

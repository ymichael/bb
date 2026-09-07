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
    }
  | {
      kind: "injected-skills-changed";
      changedPaths: string[];
      sourceType: "data-dir";
    };

type WorkspaceObservedChange = Extract<
  HostObservedChange,
  { kind: "workspace-status-changed" }
>;

export type ThreadStorageObservedChange = Extract<
  HostObservedChange,
  {
    kind: "thread-storage-changed";
  }
>;

export type InjectedSkillsObservedChange = Extract<
  HostObservedChange,
  {
    kind: "injected-skills-changed";
  }
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

export interface DataDirSkillsWatchError {
  kind: "data-dir-skills-watch-error";
  rootPath: string;
  message: string;
}

export type HostWatchError =
  | WorkspaceWatchError
  | ThreadStorageWatchError
  | DataDirSkillsWatchError;

export interface ThreadStorageWatchTarget {
  environmentId: string;
  threadId: string;
}

export interface WatchWorkspaceArgs {
  environmentId: string;
  workspacePath: string;
  onChange: (event: WorkspaceObservedChange) => void;
  onReady: () => void;
  onWatchError: (error: WorkspaceWatchError) => void;
}

export interface WatchThreadStorageRootArgs {
  threadStorageRootPath: string;
  resolveThreadTarget: (threadId: string) => ThreadStorageWatchTarget | null;
  onChange: (event: ThreadStorageObservedChange) => void;
  onWatchError: (error: ThreadStorageWatchError) => void;
}

export interface WatchDataDirSkillsRootArgs {
  dataDirSkillsRootPath: string;
  onChange: (event: InjectedSkillsObservedChange) => void;
  onWatchError: (error: DataDirSkillsWatchError) => void;
}

export type HostPathWatchChangeType = "create" | "update" | "delete";

export interface HostPathWatchChange {
  path: string;
  type: HostPathWatchChangeType;
}

export interface WatchPathRootArgs {
  rootPath: string;
  ignoredPaths: readonly string[];
  onChange: (changes: readonly HostPathWatchChange[]) => void;
  onReady: () => void;
  onRescanRequired: () => void;
  onWatchError: (error: { rootPath: string; message: string }) => void;
}

export interface HostWatcher {
  watchWorkspace(args: WatchWorkspaceArgs): () => void | Promise<void>;
  watchPathRoot?(args: WatchPathRootArgs): () => void | Promise<void>;
  watchThreadStorageRoot(
    args: WatchThreadStorageRootArgs,
  ): () => void | Promise<void>;
  watchDataDirSkillsRoot?(
    args: WatchDataDirSkillsRootArgs,
  ): () => void | Promise<void>;
}

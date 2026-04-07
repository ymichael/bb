export const WORKSPACE_STATUS_WATCH_CHANGE_KINDS = [
  "workspace-content-changed",
  "workspace-git-changed",
  "shared-git-refs-changed",
] as const;
export type WorkspaceStatusWatchChangeKind =
  (typeof WORKSPACE_STATUS_WATCH_CHANGE_KINDS)[number];

export interface WorkspaceStatusChangeEvent {
  changedPaths: string[];
  changeKinds: WorkspaceStatusWatchChangeKind[];
}

export type WorkspaceStatusChangeCallback = (
  event: WorkspaceStatusChangeEvent,
) => void;

export interface WorkspaceStatusWatchError {
  message: string;
  rootPath: string;
}

export type WorkspaceStatusWatchErrorCallback = (
  error: WorkspaceStatusWatchError,
) => void;

export interface WorkspaceStatusWatchArgs {
  onChange: WorkspaceStatusChangeCallback;
  onWatchError: WorkspaceStatusWatchErrorCallback;
}

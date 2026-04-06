export { openWorkspace, provisionWorkspace } from "./provision.js";
export type {
  HostWorkspace,
  ProvisionWorkspaceArgs,
  UnmanagedWorkspaceOpts,
  ManagedWorkspaceBaseOpts,
  ManagedWorktreeOpts,
  ManagedCloneOpts,
  ReconnectManagedWorktreeOpts,
  ReconnectManagedCloneOpts,
} from "./provision.js";

export type {
  CommitOptions,
  CommitResult,
  DiffOptions,
  DiffResult,
  FetchOptions,
  SquashMergeOptions,
  SquashMergeResult,
  StatusOptions,
} from "./workspace.js";

export { WorkspaceError } from "./git.js";

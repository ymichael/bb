export { provisionWorkspace } from "./provision.js";
export type {
  IWorkspace,
  ProvisionWorkspaceOpts,
  UnmanagedWorkspaceOpts,
  ManagedWorktreeOpts,
  ManagedCloneOpts,
} from "./provision.js";

export type {
  CheckpointOptions,
  CheckpointResult,
  CommitOptions,
  CommitResult,
  DiffOptions,
  DiffResult,
  FetchOptions,
  SquashMergeOptions,
  SquashMergeResult,
} from "./workspace.js";

export { readDefaultBranch } from "./git.js";
export { WorkspaceError } from "./git.js";

export { provisionWorkspace } from "./provision.js";
export type {
  IWorkspace,
  ProvisionWorkspaceOpts,
  UnmanagedWorkspaceOpts,
  ManagedWorkspaceBaseOpts,
  ManagedWorktreeOpts,
  ManagedCloneOpts,
  ReconnectManagedWorktreeOpts,
  ReconnectManagedCloneOpts,
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

export { readDefaultBranch, runGit } from "./git.js";
export type { RunGitOptions, GitCommandResult } from "./git.js";
export { WorkspaceError } from "./git.js";

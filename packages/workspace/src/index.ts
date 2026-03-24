export {
  Workspace,
} from "./workspace.js";
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

export {
  createClone,
  createWorktree,
  removeDirectory,
  removeWorktree,
  runSetupScript,
} from "./provisioning.js";
export {
  promoteWorkspace,
  demoteWorkspace,
} from "./promote.js";

export {
  WorkspaceError,
} from "./git.js";

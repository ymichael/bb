export { provisionWorkspace } from "./provision.js";
export type { HostWorkspace, ProvisionWorkspaceArgs } from "./provision.js";

export type { PullRequestActionOptions } from "./workspace.js";
export type { GitHostCliOptions } from "./git-host.js";
export { withGitRefMutationLock } from "./git-ref-mutation-lock.js";

export {
  WorkspaceError,
  detectGitRepo,
  detectLinkedWorktree,
  detectGitRepoKind,
  fetchRemoteBranches,
  getCheckoutRef,
  getCurrentBranch,
  getWorkspaceGitOperation,
  getGitCommonDir,
  hasUncommittedChanges,
  listBranchRefsWithDefaults,
  listBranches,
  listRemoteBranches,
  readDefaultBranchRefs,
  readGitBlob,
  runGit,
} from "./git.js";
export type { GitProcessOptions } from "./git.js";

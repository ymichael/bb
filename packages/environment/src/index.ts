export type {
  CreateEnvironmentContext,
  EnvironmentServices,
  EnvironmentCommandOptions,
  EnvironmentCommandResult,
  EnvironmentCapabilities,
  EnvironmentCapability,
  EnvironmentCheckoutSnapshot,
  EnvironmentInfo,
  EnvironmentDefinition,
  DemoteEnvironmentOptions,
  DemoteEnvironmentResult,
  EnvironmentWorkspaceCommitOptions,
  EnvironmentWorkspaceCommitResult,
  EnvironmentWorkspaceCommitsOptions,
  EnvironmentWorkspaceDiffOptions,
  EnvironmentWorkspaceDiffResult,
  EnvironmentCommitSummary,
  EnvironmentWorkFileChange,
  EnvironmentWorkState,
  EnvironmentWorkStatus,
  EnvironmentWorkspaceStatusOptions,
  EnvironmentSquashMergeMessageContext,
  EnvironmentSquashMergeMessageResolver,
  EnvironmentSquashMergeCommitFailureStage,
  EnvironmentSquashMergeOptions,
  EnvironmentSquashMergeResult,
  IEnvironment,
  PromoteEnvironmentOptions,
  PromoteEnvironmentResult,
} from "./contracts.js";
export { EnvironmentSquashMergeCommitFailureError } from "./contracts.js";
export type { EnvironmentAgentConnectionTarget } from "@bb/environment-daemon";
export {
  EnvironmentRegistry,
} from "./contracts.js";
export {
  createDefaultEnvironmentRegistry,
  createEnvironment,
  listAvailableEnvironmentInfos,
} from "./default-registry.js";
export { listGitWorkspaceMergeBaseBranchesAsync } from "./git-workspace.js";
export { createLocalEnvironmentDefinition } from "./local-environment.js";
export type {
  CreateLocalGitWorkspaceOptions,
  LocalGitWorkspaceState,
} from "./local-git-workspace.js";
export {
  createLocalGitWorkspaceDefinition,
  ensureLocalGitWorkspace,
  isLocalGitWorkspaceState,
  removeLocalGitWorkspace,
  resolveLocalGitWorkspaceState,
} from "./local-git-workspace.js";
export type {
  CreateDockerEnvironmentDefinitionOptions,
  DockerEnvironmentState,
} from "./docker-environment.js";
export {
  createDockerEnvironmentDefinition,
  ensureDockerEnvironmentArtifacts,
  isDockerEnvironmentState,
  removeDockerEnvironmentArtifacts,
  resolveDockerEnvironmentState,
} from "./docker-environment.js";
export { listManagedHostEnvironmentAgentPids } from "./host-environment-agent.js";

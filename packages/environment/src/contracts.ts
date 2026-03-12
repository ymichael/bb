import type { ChildProcess, SpawnOptions } from "node:child_process";
import type {
  PersistedEnvironmentRecord,
} from "@beanbag/agent-core";
import type { EnvironmentAgentConnectionTarget } from "@beanbag/environment-agent";

export type EnvironmentCapability =
  | "host_filesystem"
  | "isolated_workspace"
  | "promote_primary_checkout"
  | "demote_primary_checkout"
  | "squash_merge";

export type EnvironmentCapabilities = Record<EnvironmentCapability, boolean>;

export interface EnvironmentInfo {
  id: string;
  displayName: string;
  description?: string;
  capabilities: EnvironmentCapabilities;
}

export interface CreateEnvironmentContext {
  projectId: string;
  threadId: string;
  projectRootPath: string;
  runtimeEnv: Record<string, string | undefined>;
  managedEnvironmentAgentReconnectTarget?: {
    baseUrl: string;
    authToken?: string;
  };
  services?: EnvironmentServices;
}

export interface EnvironmentServices {
  llmCompletion?(args: {
    cwd: string;
    includeUnstaged?: boolean;
  }): Promise<string | undefined>;
}

export interface EnvironmentCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface EnvironmentCommandOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  rawOutput?: boolean;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export interface EnvironmentSpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdio?: SpawnOptions["stdio"];
}

export interface IEnvironment {
  readonly kind: string;
  readonly info: EnvironmentInfo;

  serialize(): unknown;
  prepare?(): Promise<void>;
  suspend(): void | Promise<void>;
  destroy(): void | Promise<void>;
  exists(): boolean;
  supportsHostFilesystemAccess(): boolean;
  isIsolatedWorkspace(): boolean;
  getAgentConnectionTarget(): EnvironmentAgentConnectionTarget;
  getCheckoutSnapshot(): EnvironmentCheckoutSnapshot;
  getCheckoutSnapshotAsync?(): Promise<EnvironmentCheckoutSnapshot>;
  getWorkspaceRootUnsafe(): string;
  buildAgentInstructions?(): string | undefined;
  getWorkspaceStatus(args?: EnvironmentWorkspaceStatusOptions): EnvironmentWorkStatus;
  getWorkspaceStatusAsync?(
    args?: EnvironmentWorkspaceStatusOptions,
  ): Promise<EnvironmentWorkStatus>;
  watchWorkspaceStatus(onChange: () => void): () => void;
  commitWorkspace(args: EnvironmentWorkspaceCommitOptions): Promise<EnvironmentWorkspaceCommitResult>;
  listWorkspaceCommitsSinceRef(args: EnvironmentWorkspaceCommitsOptions): EnvironmentCommitSummary[];
  listWorkspaceCommitsSinceRefAsync?(
    args: EnvironmentWorkspaceCommitsOptions,
  ): Promise<EnvironmentCommitSummary[]>;
  getWorkspaceDiff(args: EnvironmentWorkspaceDiffOptions): EnvironmentWorkspaceDiffResult;
  getWorkspaceDiffAsync?(
    args: EnvironmentWorkspaceDiffOptions,
  ): Promise<EnvironmentWorkspaceDiffResult>;
  spawn(
    command: string,
    args: string[],
    options?: EnvironmentSpawnOptions,
  ): ChildProcess;
  shouldRunSetupScript(): boolean;
  supportsPromoteToActiveWorkspace(): boolean;
  supportsDemoteFromActiveWorkspace(): boolean;
  supportsSquashMergeIntoDefaultBranch(): boolean;
  promoteToActiveWorkspace(args: PromoteEnvironmentOptions): PromoteEnvironmentResult;
  promoteToActiveWorkspaceAsync?(
    args: PromoteEnvironmentOptions,
  ): Promise<PromoteEnvironmentResult>;
  demoteFromActiveWorkspace(args: DemoteEnvironmentOptions): DemoteEnvironmentResult;
  demoteFromActiveWorkspaceAsync?(
    args: DemoteEnvironmentOptions,
  ): Promise<DemoteEnvironmentResult>;
  squashMergeIntoDefaultBranch(
    args: EnvironmentSquashMergeOptions,
  ): Promise<EnvironmentSquashMergeResult>;
  run(
    command: string,
    args: string[],
    options?: EnvironmentCommandOptions,
  ): EnvironmentCommandResult;
  runAsync?(
    command: string,
    args: string[],
    options?: EnvironmentCommandOptions,
  ): Promise<EnvironmentCommandResult>;
}

export interface EnvironmentCheckoutSnapshot {
  branch?: string;
  head: string;
  detached: boolean;
}

export interface EnvironmentWorkspaceStatusOptions {
  defaultBranch?: string;
  mergeBaseBranch?: string;
}

export interface EnvironmentWorkspaceCommitsOptions {
  baseRef?: string;
}

export interface EnvironmentWorkspaceCommitOptions {
  defaultBranch?: string;
  message?: string;
  includeUnstaged?: boolean;
}

export interface EnvironmentWorkspaceCommitResult {
  ok: true;
  commitCreated: boolean;
  message: string;
  workStatus: EnvironmentWorkStatus;
  commitSha?: string;
  commitSubject?: string;
  includeUnstaged?: boolean;
}

export type EnvironmentWorkState =
  | "clean"
  | "untracked"
  | "deleted"
  | "dirty_uncommitted"
  | "committed_unmerged"
  | "dirty_and_committed_unmerged";

export interface EnvironmentWorkFileChange {
  path: string;
  status: string;
}

export interface EnvironmentWorkStatus {
  state: EnvironmentWorkState;
  changedFiles: number;
  insertions: number;
  deletions: number;
  workspaceChangedFiles: number;
  workspaceInsertions: number;
  workspaceDeletions: number;
  hasUncommittedChanges: boolean;
  hasCommittedUnmergedChanges: boolean;
  aheadCount: number;
  behindCount: number;
  currentBranch?: string;
  defaultBranch?: string;
  mergeBaseBranch?: string;
  mergeBaseBranches?: string[];
  baseRef?: string;
  files?: EnvironmentWorkFileChange[];
}

export interface EnvironmentCommitSummary {
  sha: string;
  shortSha: string;
  subject: string;
  authorName?: string;
  authoredAt?: number;
}

export type EnvironmentWorkspaceDiffOptions =
  | {
      type: "working_tree";
    }
  | {
      type: "combined";
      baseRef?: string;
    }
  | {
      type: "commit";
      commitSha: string;
    };

export interface EnvironmentWorkspaceDiffResult {
  diff: string;
  truncated: boolean;
}

export interface PromoteEnvironmentResult {
  previousCheckout: EnvironmentCheckoutSnapshot;
  promotedCheckout: EnvironmentCheckoutSnapshot;
}

export interface PromoteEnvironmentOptions {
  activeWorkspaceRoot: string;
}

export interface DemoteEnvironmentResult {
  restoredCheckout: EnvironmentCheckoutSnapshot;
}

export interface DemoteEnvironmentOptions {
  activeWorkspaceRoot: string;
  snapshot: EnvironmentCheckoutSnapshot;
}

export interface EnvironmentSquashMergeMessageContext {
  tempWorkspaceRoot: string;
  mergeBaseBranch: string;
  sourceBranch?: string;
  defaultMessage: string;
}

export type EnvironmentSquashMergeMessageResolver = (
  context: EnvironmentSquashMergeMessageContext,
) => Promise<string | undefined> | string | undefined;

export interface EnvironmentSquashMergeOptions {
  activeWorkspaceRoot: string;
  defaultBranch?: string;
  message?: string;
  commitIfNeeded?: boolean;
  commitMessage?: string;
  includeUnstaged?: boolean;
  resolveMessage?: EnvironmentSquashMergeMessageResolver;
}

export type EnvironmentSquashMergeCommitFailureStage =
  | "prep_commit"
  | "squash_commit";

export class EnvironmentSquashMergeCommitFailureError extends Error {
  readonly stage: EnvironmentSquashMergeCommitFailureStage;

  constructor(stage: EnvironmentSquashMergeCommitFailureStage, message: string) {
    super(message);
    this.name = "EnvironmentSquashMergeCommitFailureError";
    this.stage = stage;
  }
}

export interface EnvironmentSquashMergeResult {
  merged: boolean;
  message: string;
  committed?: boolean;
  commitSha?: string;
  commitSubject?: string;
  prepCommit?: {
    message: string;
    commitSha?: string;
    commitSubject?: string;
    includeUnstaged?: boolean;
  };
  conflictFiles?: string[];
}

export interface EnvironmentDefinition<TState = unknown> {
  readonly kind: string;
  readonly info: EnvironmentInfo;
  create(context: CreateEnvironmentContext): IEnvironment;
  restore(state: TState, context: CreateEnvironmentContext): IEnvironment;
  isState(value: unknown): value is TState;
}

export class EnvironmentRegistry {
  #definitions = new Map<string, EnvironmentDefinition<unknown>>();

  register<TState>(definition: EnvironmentDefinition<TState>): this {
    if (this.#definitions.has(definition.kind)) {
      throw new Error(`Environment already registered: ${definition.kind}`);
    }
    this.#definitions.set(
      definition.kind,
      definition as EnvironmentDefinition<unknown>,
    );
    return this;
  }

  get(kind: string): EnvironmentDefinition<unknown> {
    const definition = this.#definitions.get(kind);
    if (!definition) {
      throw new Error(`Unknown environment: ${kind}`);
    }
    return definition;
  }

  has(kind: string): boolean {
    return this.#definitions.has(kind);
  }

  create(kind: string, context: CreateEnvironmentContext): IEnvironment {
    return this.get(kind).create(context);
  }

  restore(
    record: PersistedEnvironmentRecord,
    context: CreateEnvironmentContext,
  ): IEnvironment {
    const definition = this.get(record.kind);
    if (!definition.isState(record.state)) {
      throw new Error(`Invalid serialized state for environment: ${record.kind}`);
    }
    return definition.restore(record.state, context);
  }

  list(): EnvironmentInfo[] {
    return [...this.#definitions.values()].map((definition) => ({
      ...definition.info,
    }));
  }
}

import type {
  EnvironmentProvisioningEvent,
  PersistedEnvironmentRecord,
  SystemEnvironmentInfo,
} from "@beanbag/agent-core";

export interface CreateEnvironmentContext {
  projectId: string;
  threadId: string;
  projectRootPath: string;
  runtimeEnv: Record<string, string | undefined>;
  onProvisioningEvent?: (event: EnvironmentProvisioningEvent) => void;
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
}

export interface IEnvironment {
  readonly kind: string;
  readonly info: SystemEnvironmentInfo;

  serialize(): unknown;
  dispose(): void;
  getWorkspaceRoot(): string;
  getExecutionContext(): {
    cwd: string;
    env: Record<string, string | undefined>;
  };
  shouldRunSetupScript(): boolean;
  supportsPromoteToActiveWorkspace(): boolean;
  supportsDemoteFromActiveWorkspace(): boolean;
  supportsSquashMergeIntoDefaultBranch(): boolean;
  promoteToActiveWorkspace(args: PromoteEnvironmentOptions): PromoteEnvironmentResult;
  demoteFromActiveWorkspace(args: DemoteEnvironmentOptions): DemoteEnvironmentResult;
  squashMergeIntoDefaultBranch(
    args: EnvironmentSquashMergeOptions,
  ): Promise<EnvironmentSquashMergeResult>;
  run(
    command: string,
    args: string[],
    options?: EnvironmentCommandOptions,
  ): EnvironmentCommandResult;
}

export interface EnvironmentCheckoutSnapshot {
  branch?: string;
  head: string;
  detached: boolean;
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
  resolveMessage?: EnvironmentSquashMergeMessageResolver;
}

export interface EnvironmentSquashMergeResult {
  merged: boolean;
  message: string;
  conflictFiles?: string[];
}

export interface EnvironmentDefinition<TState = unknown> {
  readonly kind: string;
  readonly info: SystemEnvironmentInfo;
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
    const definition = this.#definitions.get(normalizeEnvironmentKind(kind));
    if (!definition) {
      throw new Error(`Unknown environment: ${kind}`);
    }
    return definition;
  }

  has(kind: string): boolean {
    return this.#definitions.has(normalizeEnvironmentKind(kind));
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

  list(): SystemEnvironmentInfo[] {
    return [...this.#definitions.values()].map((definition) => ({
      ...definition.info,
    }));
  }
}

export function normalizeEnvironmentKind(kind: string): string {
  const normalized = kind.trim().toLowerCase();
  return normalized === "direct" ? "local" : normalized;
}

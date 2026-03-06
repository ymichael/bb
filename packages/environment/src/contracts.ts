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
}

export interface IEnvironment {
  readonly kind: string;
  readonly info: SystemEnvironmentInfo;
  readonly rootPath: string;
  readonly env: Record<string, string | undefined>;

  serialize(): unknown;
  dispose(): void;
  run(
    command: string,
    args: string[],
    options?: EnvironmentCommandOptions,
  ): Promise<EnvironmentCommandResult>;
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

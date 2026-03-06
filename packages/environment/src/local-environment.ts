import type { SystemEnvironmentInfo } from "@beanbag/agent-core";
import type {
  CreateEnvironmentContext,
  DemoteEnvironmentOptions,
  DemoteEnvironmentResult,
  EnvironmentCommandOptions,
  EnvironmentDefinition,
  EnvironmentCheckoutSnapshot,
  EnvironmentSquashMergeOptions,
  EnvironmentSquashMergeResult,
  IEnvironment,
  PromoteEnvironmentOptions,
  PromoteEnvironmentResult,
} from "./contracts.js";
import { runCommand } from "./process.js";

interface LocalEnvironmentState {}

const LOCAL_ENVIRONMENT_INFO: SystemEnvironmentInfo = {
  id: "local",
  displayName: "Direct Workspace",
  description: "Run directly in the project root on the host machine.",
};

class LocalEnvironment implements IEnvironment {
  readonly kind = "local";
  readonly info = { ...LOCAL_ENVIRONMENT_INFO };
  private readonly rootPath: string;
  private readonly env: Record<string, string | undefined>;

  constructor(context: CreateEnvironmentContext) {
    this.rootPath = context.projectRootPath;
    this.env = {};
  }

  serialize(): LocalEnvironmentState {
    return {};
  }

  dispose(): void {}

  getWorkspaceRoot(): string {
    return this.rootPath;
  }

  getExecutionContext(): { cwd: string; env: Record<string, string | undefined> } {
    return {
      cwd: this.rootPath,
      env: { ...this.env },
    };
  }

  shouldRunSetupScript(): boolean {
    return false;
  }

  supportsPromoteToActiveWorkspace(): boolean {
    return false;
  }

  supportsDemoteFromActiveWorkspace(): boolean {
    return false;
  }

  supportsSquashMergeIntoDefaultBranch(): boolean {
    return false;
  }

  promoteToActiveWorkspace(_args: PromoteEnvironmentOptions): PromoteEnvironmentResult {
    throw new Error("Promotion is not supported for local environments");
  }

  demoteFromActiveWorkspace(_args: DemoteEnvironmentOptions): DemoteEnvironmentResult {
    throw new Error("Demotion is not supported for local environments");
  }

  async squashMergeIntoDefaultBranch(
    _args: EnvironmentSquashMergeOptions,
  ): Promise<EnvironmentSquashMergeResult> {
    throw new Error("Squash merge is not supported for local environments");
  }

  run(
    command: string,
    args: string[],
    options?: EnvironmentCommandOptions,
  ) {
    const executionContext = this.getExecutionContext();
    return runCommand(command, args, {
      cwd: options?.cwd ?? executionContext.cwd,
      env: {
        ...executionContext.env,
        ...(options?.env ?? {}),
      },
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options?.rawOutput ? { rawOutput: true } : {}),
    });
  }
}

export function createLocalEnvironmentDefinition(): EnvironmentDefinition<LocalEnvironmentState> {
  return {
    kind: "local",
    info: { ...LOCAL_ENVIRONMENT_INFO },
    create(context: CreateEnvironmentContext): IEnvironment {
      return new LocalEnvironment(context);
    },
    restore(_state: LocalEnvironmentState, context: CreateEnvironmentContext): IEnvironment {
      return new LocalEnvironment(context);
    },
    isState(value: unknown): value is LocalEnvironmentState {
      return value !== null && typeof value === "object" && !Array.isArray(value);
    },
  };
}

import type { SystemEnvironmentInfo } from "@beanbag/agent-core";
import type {
  CreateEnvironmentContext,
  EnvironmentDefinition,
  IEnvironment,
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
  readonly rootPath: string;
  readonly env: Record<string, string | undefined>;

  constructor(context: CreateEnvironmentContext) {
    this.rootPath = context.projectRootPath;
    this.env = {
      BB_WORKSPACE_ROOT: context.projectRootPath,
      BB_WORKSPACE_MODE: "local",
    };
  }

  serialize(): LocalEnvironmentState {
    return {};
  }

  dispose(): void {}

  run(command: string, args: string[]) {
    return runCommand(command, args, {
      cwd: this.rootPath,
      env: this.env,
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

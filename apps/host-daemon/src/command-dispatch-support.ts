import { createProviderForId, listAvailableProviders } from "@bb/agent-runtime";
import type {
  AvailableModel,
  ProviderInfo,
} from "@bb/domain";
import type {
  HostDaemonCommand,
} from "@bb/host-daemon-contract";
import { RuntimeManager, type RuntimeEntry } from "./runtime-manager.js";

export type CommandOf<TType extends HostDaemonCommand["type"]> = Extract<
  HostDaemonCommand,
  { type: TType }
>;

export interface CommandDispatchOptions {
  runtimeManager: RuntimeManager;
  seedThreadHighWaterMark?: (args: {
    sequence: number;
    threadId: string;
  }) => void;
  listModels?: (providerId: string) => Promise<AvailableModel[]>;
  listProviders?: () => ProviderInfo[];
}

export class CommandDispatchError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CommandDispatchError";
  }
}

export function getErrorCode(error: unknown): string {
  if (error instanceof CommandDispatchError) {
    return error.code;
  }
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "command_failed";
}

export async function requireExistingEnvironment(
  environmentId: string,
  runtimeManager: RuntimeManager,
): Promise<RuntimeEntry> {
  const entry = await runtimeManager.getOrAwait(environmentId);
  if (!entry) {
    throw new CommandDispatchError(
      "unknown_environment",
      `No runtime exists for environment ${environmentId}`,
    );
  }
  return entry;
}

export async function requireWorkspaceEnvironment(
  args: {
    environmentId: string;
    workspacePath: string;
  },
  runtimeManager: RuntimeManager,
): Promise<RuntimeEntry> {
  const existing = await runtimeManager.getOrAwait(args.environmentId);
  if (existing) {
    return existing;
  }

  return runtimeManager.ensureEnvironment({
    environmentId: args.environmentId,
    workspacePath: args.workspacePath,
  });
}

export function defaultListProviders(): ProviderInfo[] {
  return listAvailableProviders();
}

export async function defaultListModels(
  providerId: string,
): Promise<AvailableModel[]> {
  return createProviderForId(providerId).listModels();
}

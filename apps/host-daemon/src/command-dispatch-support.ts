import { createProviderForId } from "@bb/agent-runtime";
import type { AvailableModel } from "@bb/domain";
import type {
  HostDaemonCommand,
  HostDaemonExecutionOptions,
} from "@bb/host-daemon-contract";
import { RuntimeManager, type RuntimeEntry } from "./runtime-manager.js";

export type CommandOf<TType extends HostDaemonCommand["type"]> = Extract<
  HostDaemonCommand,
  { type: TType }
>;

export interface ThreadRuntimeResolution {
  workspacePath: string;
  projectId?: string;
  providerId?: string;
  providerThreadId?: string;
  options?: HostDaemonExecutionOptions;
  dynamicTools?: Array<{
    name: string;
    description: string;
    inputSchema: unknown;
  }>;
}

export interface CommandDispatchOptions {
  runtimeManager: RuntimeManager;
  resolveThreadRuntime?: (args: {
    environmentId: string;
    threadId: string;
  }) => Promise<ThreadRuntimeResolution | null>;
  listModels?: (providerId: string) => Promise<AvailableModel[]>;
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

export async function defaultListModels(
  providerId: string,
): Promise<AvailableModel[]> {
  return createProviderForId(providerId).listModels();
}

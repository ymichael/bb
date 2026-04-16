import {
  createAgentRuntime,
  listAvailableProviders,
  type AgentRuntime,
  type AgentRuntimeOptions,
} from "@bb/agent-runtime";
import type {
  AvailableModel,
  ProviderInfo,
} from "@bb/domain";
import type { BufferedEventInput } from "./event-buffer.js";
import type {
  HostDaemonCommand,
  HostRuntimeMaterialSnapshot,
  WorkspaceContext,
} from "@bb/host-daemon-contract";
import type { HostRuntimeMaterialState } from "@bb/host-runtime-material";
import type { InteractiveResolveCommandInput } from "./interactive-request-registry.js";
import { RuntimeManager, type RuntimeEntry } from "./runtime-manager.js";

export type CommandOf<TType extends HostDaemonCommand["type"]> = Extract<
  HostDaemonCommand,
  { type: TType }
>;

export interface EventSink {
  emit: (event: BufferedEventInput) => void;
  flush: () => Promise<void>;
}

export const noopEventSink: EventSink = {
  emit: () => undefined,
  flush: async () => undefined,
};

export interface CommandDispatchOptions {
  fetchRuntimeMaterial: (
    version: string,
  ) => Promise<HostRuntimeMaterialSnapshot>;
  readPersistedRuntimeMaterial: () => Promise<HostRuntimeMaterialState | null>;
  persistRuntimeMaterial: (
    state: HostRuntimeMaterialState,
  ) => Promise<void>;
  runtimeManager: RuntimeManager;
  seedThreadHighWaterMark?: (args: {
    sequence: number;
    threadId: string;
  }) => void;
  eventSink: EventSink;
  listModels?: (providerId: string) => Promise<AvailableModel[]>;
  listProviders?: () => ProviderInfo[];
  resolveInteractiveRequest?: (
    request: InteractiveResolveCommandInput,
  ) => Promise<void>;
  threadStorageRootPath: string;
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

export interface DefaultListModelsOptions {
  bridgeBundleDir?: AgentRuntimeOptions["bridgeBundleDir"];
}

const defaultModelListRuntimes = new Map<string, AgentRuntime>();

function getDefaultModelListRuntime(
  options: DefaultListModelsOptions = {},
): AgentRuntime {
  const runtimeKey = options.bridgeBundleDir ?? "";
  const existingRuntime = defaultModelListRuntimes.get(runtimeKey);
  if (existingRuntime) {
    return existingRuntime;
  }

  const runtime = createAgentRuntime({
    bridgeBundleDir: options.bridgeBundleDir,
    workspacePath: process.cwd(),
    onEvent: () => {},
    onToolCall: async () => ({
      contentItems: [],
      success: true,
    }),
  });
  defaultModelListRuntimes.set(runtimeKey, runtime);
  return runtime;
}

export async function shutdownDefaultListModelsRuntimes(): Promise<void> {
  const runtimes = [...defaultModelListRuntimes.values()];
  defaultModelListRuntimes.clear();
  await Promise.all(
    runtimes.map((runtime) => runtime.shutdown()),
  );
}

export async function defaultListModels(
  providerId: string,
  options: DefaultListModelsOptions = {},
): Promise<AvailableModel[]> {
  const runtime = getDefaultModelListRuntime(options);
  try {
    return await runtime.listModels({ providerId });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unsupported provider")) {
      throw new CommandDispatchError("unknown_provider", error.message);
    }
    throw error;
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
    workspaceContext: WorkspaceContext;
  },
  runtimeManager: RuntimeManager,
): Promise<RuntimeEntry> {
  const existing = await runtimeManager.getOrAwait(args.environmentId);
  if (existing) {
    return existing;
  }

  return runtimeManager.ensureEnvironment({
    environmentId: args.environmentId,
    workspacePath: args.workspaceContext.workspacePath,
    workspaceProvisionType: args.workspaceContext.workspaceProvisionType,
  });
}

export function defaultListProviders(): ProviderInfo[] {
  return listAvailableProviders();
}

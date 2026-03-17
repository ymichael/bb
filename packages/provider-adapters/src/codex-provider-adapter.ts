import type {
  AvailableModel,
  ProviderDynamicTool,
  ProviderLaunchConfiguration,
  ProviderCapabilities,
  PromptInput,
  ProviderToolCallRequest,
  ProviderToolCallResponse,
  SandboxMode,
  SpawnThreadRequest,
  Thread,
  ThreadEvent,
  ThreadProviderId,
} from "@bb/core";
import {
  assertNever,
  decodeThreadEventData,
  decodeThreadIdFromWireValue,
  toRecord,
} from "@bb/core";
import { renderTemplate } from "@bb/templates";
import { resolveCodexProviderLaunchConfiguration } from "./codex-auth.js";
import { listCodexModels } from "./codex-models.js";
import type {
  ProviderAdapter,
  ProviderExecutionOptions,
  ProviderThreadContext,
} from "./provider-adapter.js";

const DEFAULT_BASE_INSTRUCTIONS = renderTemplate("agentBaseInstructions", {});
const DEFAULT_APPROVAL_POLICY = "never";
const DEFAULT_SANDBOX_MODE = "danger-full-access";
// Ask Codex to suppress noisy legacy notifications at source.
const LEGACY_DUPLICATE_NOTIFICATION_METHODS = [
  "codex/event/item_started",
  "codex/event/item_completed",
] as const;
const DEFAULT_WORKSPACE_WRITE_POLICY = {
  type: "workspaceWrite",
  writableRoots: [] as string[],
  networkAccess: true,
  excludeTmpdirEnvVar: false,
  excludeSlashTmp: false,
} as const;

function normalizeProviderEventType(type: string): string {
  return type.toLowerCase().replaceAll(".", "/");
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= 60) return normalized;
  return `${normalized.slice(0, 57).trimEnd()}...`;
}

function withExecutionOptions(
  params: Record<string, unknown>,
  options?: ProviderExecutionOptions,
): Record<string, unknown> {
  if (!options) {
    return params;
  }

  const nextParams = { ...params };
  if (options.model) {
    nextParams.model = options.model;
  }
  if (options.serviceTier) {
    nextParams.service_tier = options.serviceTier;
  }
  if (options.reasoningLevel) {
    return withConfigValues(nextParams, {
      model_reasoning_effort: options.reasoningLevel,
    });
  }
  return nextParams;
}

function withConfigValues(
  params: Record<string, unknown>,
  configValues: Record<string, unknown>,
): Record<string, unknown> {
  const entries = Object.entries(configValues).filter(
    ([, value]) => value !== undefined,
  );
  if (entries.length === 0) return params;

  const nextConfig = {
    ...(toRecord(params.config) ?? {}),
    ...Object.fromEntries(entries),
  };
  return {
    ...params,
    config: nextConfig,
  };
}

function withThreadEnvironmentPolicy(
  params: Record<string, unknown>,
  context: ProviderThreadContext,
): Record<string, unknown> {
  return withConfigValues(params, {
    "shell_environment_policy.set.BB_PROJECT_ID": context.projectId,
    "shell_environment_policy.set.BB_THREAD_ID": context.threadId,
    "shell_environment_policy.set.BB_DAEMON_URL": context.daemonUrl,
    "shell_environment_policy.set.PATH": context.path,
  });
}

function resolveBaseInstructions(developerInstructions?: string): string {
  const trimmed = developerInstructions?.trim();
  if (!trimmed) {
    return DEFAULT_BASE_INSTRUCTIONS;
  }

  // Preserve existing prompts that already include the default prelude.
  if (
    trimmed === DEFAULT_BASE_INSTRUCTIONS ||
    trimmed.startsWith(`${DEFAULT_BASE_INSTRUCTIONS}\n`)
  ) {
    return trimmed;
  }

  return `${DEFAULT_BASE_INSTRUCTIONS}\n\n${trimmed}`;
}

function resolveSandboxMode(sandboxMode?: SandboxMode): SandboxMode {
  return sandboxMode ?? DEFAULT_SANDBOX_MODE;
}

function toCodexDynamicTools(
  dynamicTools?: ProviderDynamicTool[],
): Array<Record<string, unknown>> | undefined {
  if (!dynamicTools || dynamicTools.length === 0) return undefined;
  return dynamicTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: cloneJsonValue(tool.inputSchema),
  }));
}

function decodeCodexToolCallRequest(
  requestId: string | number,
  method: string,
  params: unknown,
): ProviderToolCallRequest | null {
  if (normalizeProviderEventType(method) !== "item/tool/call") {
    return null;
  }

  const record = toRecord(params);
  if (!record) return null;

  const threadId =
    typeof record.threadId === "string" ? record.threadId : undefined;
  const turnId = typeof record.turnId === "string" ? record.turnId : undefined;
  const callId = typeof record.callId === "string" ? record.callId : undefined;
  const tool = typeof record.tool === "string" ? record.tool : undefined;

  if (!threadId || !turnId || !callId || !tool) {
    return null;
  }

  return {
    requestId,
    threadId,
    turnId,
    callId,
    tool,
    arguments: record.arguments,
  };
}

function encodeCodexToolCallResponse(
  response: ProviderToolCallResponse,
): Record<string, unknown> {
  return {
    contentItems: response.contentItems.map((item) => {
      switch (item.type) {
        case "inputText":
          return {
            type: "inputText",
            text: item.text,
          };
        case "inputImage":
          return {
            type: "inputImage",
            imageUrl: item.imageUrl,
          };
        default:
          return assertNever(item);
      }
    }),
    success: response.success,
  };
}

function toTurnSandboxPolicy(sandboxMode?: SandboxMode): Record<string, unknown> {
  const resolved = resolveSandboxMode(sandboxMode);
  switch (resolved) {
    case "read-only":
      return { type: "readOnly" };
    case "workspace-write":
      return { ...DEFAULT_WORKSPACE_WRITE_POLICY };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    default:
      return assertNever(resolved);
  }
}

function deriveThreadTitleFromInput(input?: PromptInput[]): string | undefined {
  if (!input || input.length === 0) return undefined;
  const textChunk = input.find(
    (chunk): chunk is Extract<PromptInput, { type: "text" }> =>
      chunk.type === "text" && chunk.text.trim().length > 0,
  );
  if (!textChunk) return undefined;
  return normalizeTitle(textChunk.text);
}

function outputFromEvent(event: ThreadEvent): string | undefined {
  const normalizedType = normalizeProviderEventType(event.type);
  if (normalizedType !== "item/completed") return undefined;

  const decoded = decodeThreadEventData(event.data);
  if (decoded.item?.normalizedType !== "agentmessage") return undefined;
  return decoded.item.text.text || undefined;
}

export interface CreateCodexProviderAdapterOptions {
  id?: ThreadProviderId;
  displayName?: string;
  processCommand?: string;
  processArgs?: string[];
  launchEnv?: Record<string, string>;
  capabilities?: Partial<ProviderCapabilities>;
  listModels?: () => Promise<AvailableModel[]>;
}

export function createCodexProviderAdapter(
  opts?: CreateCodexProviderAdapterOptions,
): ProviderAdapter {
  const capabilities: ProviderCapabilities = {
    supportsRename: true,
    supportsServiceTier: true,
    ...(opts?.capabilities ?? {}),
  };
  const supportsRename = capabilities.supportsRename;
  const listModels = opts?.listModels ?? listCodexModels;

  return {
    id: opts?.id ?? "codex",
    displayName: opts?.displayName ?? "Codex",
    capabilities,
    processCommand: opts?.processCommand ?? "codex",
    processArgs: opts?.processArgs ?? ["app-server"],
    async resolveLaunchConfiguration(): Promise<ProviderLaunchConfiguration | undefined> {
      const launchConfig = await resolveCodexProviderLaunchConfiguration();
      if (!opts?.launchEnv || Object.keys(opts.launchEnv).length === 0) {
        return launchConfig;
      }

      return {
        ...(launchConfig ?? {}),
        env: {
          ...(launchConfig?.env ?? {}),
          ...opts.launchEnv,
        },
      };
    },
    clientInfo: {
      name: "bb",
      version: "0.0.1",
    },
    initializeMethod: "initialize",
    createInitializeParams(
      clientInfo: { name: string; version: string },
    ): Record<string, unknown> {
      return {
        clientInfo,
        capabilities: {
          experimentalApi: true,
          // Codex app-server emits both legacy codex/event/* and v2 item/* lifecycle
          // notifications; suppress duplicate legacy item lifecycle events at source.
          optOutNotificationMethods: [...LEGACY_DUPLICATE_NOTIFICATION_METHODS],
        },
      };
    },
    threadStartMethod: "thread/start",
    threadResumeMethod: "thread/resume",
    turnStartMethod: "turn/start",
    turnSteerMethod: "turn/steer",
    threadNameSetMethod: supportsRename ? "thread/name/set" : undefined,
    createThreadStartParams(
      req: SpawnThreadRequest,
      context: ProviderThreadContext,
      dynamicTools?: ProviderDynamicTool[],
    ): Record<string, unknown> {
      const baseInstructions = resolveBaseInstructions(req.developerInstructions);
      const params = withExecutionOptions(
        withThreadEnvironmentPolicy(
          {
            approvalPolicy: DEFAULT_APPROVAL_POLICY,
            sandbox: resolveSandboxMode(req.sandboxMode),
            baseInstructions,
          },
          context,
        ),
        req,
      );
      const codexDynamicTools = toCodexDynamicTools(dynamicTools);
      if (!codexDynamicTools) {
        return params;
      }
      return {
        ...params,
        dynamicTools: codexDynamicTools,
      };
    },
    createThreadResumeParams(
      providerThreadId: string,
      context: ProviderThreadContext,
      options?: ProviderExecutionOptions,
      _resumePath?: string,
    ): Record<string, unknown> {
      return withExecutionOptions(
        withThreadEnvironmentPolicy(
          {
            threadId: providerThreadId,
            // Codex currently rejects thread/resume.path unless experimentalApi
            // is enabled. Keep the adapter compatible with the default provider
            // surface and resume by thread id only.
            approvalPolicy: DEFAULT_APPROVAL_POLICY,
            sandbox: resolveSandboxMode(options?.sandboxMode),
          },
          context,
        ),
        options,
      );
    },
    createTurnStartParams(
      providerThreadId: string,
      input: PromptInput[],
      options?: ProviderExecutionOptions,
    ): Record<string, unknown> {
      return withExecutionOptions(
        {
          threadId: providerThreadId,
          input,
          approvalPolicy: DEFAULT_APPROVAL_POLICY,
          sandboxPolicy: toTurnSandboxPolicy(options?.sandboxMode),
        },
        options,
      );
    },
    createTurnSteerParams: (
      providerThreadId: string,
      expectedTurnId: string,
      input: PromptInput[],
    ): Record<string, unknown> => {
      return {
        threadId: providerThreadId,
        expectedTurnId,
        input,
      };
    },
    createThreadNameSetParams: supportsRename
      ? (providerThreadId: string, title: string): Record<string, unknown> => {
          return {
            threadId: providerThreadId,
            name: title,
          };
        }
      : undefined,
    extractThreadIdFromResult: decodeThreadIdFromWireValue,
    extractThreadIdFromEventData: decodeThreadIdFromWireValue,
    normalizeEventType(type: string): string {
      return normalizeProviderEventType(type);
    },
    shouldPersistEvent(method: string): boolean {
      const normalized = normalizeProviderEventType(method);
      if (normalized.startsWith("codex/event/")) return false;
      if (normalized === "thread/name/updated") return false;
      return true;
    },
    shouldBroadcastForEvent(method: string): boolean {
      const normalized = normalizeProviderEventType(method);
      if (normalized === "item/agentmessage/delta") return false;
      if (normalized === "item/reasoning/summarytextdelta") return false;
      if (normalized === "account/ratelimits/updated") return false;
      if (normalized === "item/reasoning/summarypartadded") return false;
      return true;
    },
    statusForEvent(method: string): Thread["status"] | undefined {
      const normalized = normalizeProviderEventType(method);
      if (normalized === "turn/start" || normalized === "turn/started") {
        return "active";
      }
      if (normalized === "turn/completed" || normalized === "turn/end") {
        return "idle";
      }
      // Open provider/runtime set: ignore unrelated provider event methods.
      return undefined;
    },
    titleFromEvent(method: string, data: unknown): string | undefined {
      const normalizedMethod = normalizeProviderEventType(method);
      const payload = toRecord(data);

      if (normalizedMethod === "thread/started") {
        const thread = toRecord(payload?.thread);
        return normalizeTitle(thread?.preview);
      }

      if (normalizedMethod === "thread/name/updated") {
        return normalizeTitle(payload?.threadName ?? payload?.thread_name);
      }

      return undefined;
    },
    outputFromEvent,
    listModels() {
      return listModels();
    },
    deriveThreadTitle(input?: PromptInput[]): string | undefined {
      return deriveThreadTitleFromInput(input);
    },
    inactiveSessionErrorMessage(threadId: string): string {
      return `Thread ${threadId} has no codex session`;
    },
    decodeToolCallRequest(requestId, method, params): ProviderToolCallRequest | null {
      return decodeCodexToolCallRequest(requestId, method, params);
    },
    encodeToolCallResponse(
      response: ProviderToolCallResponse,
    ): Record<string, unknown> {
      return encodeCodexToolCallResponse(response);
    },
  };
}

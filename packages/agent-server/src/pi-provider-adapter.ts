import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AvailableModel,
  ProviderDynamicTool,
  ProviderLaunchConfiguration,
  ProviderCapabilities,
  PromptInput,
  SandboxMode,
  SpawnThreadRequest,
  Thread,
  ThreadEvent,
  ThreadProviderId,
} from "@beanbag/agent-core";
import {
  decodeThreadEventData,
  decodeThreadIdFromWireValue,
  toRecord,
} from "@beanbag/agent-core";
import { renderTemplate } from "@beanbag/templates";
import type {
  ProviderAdapter,
  ProviderExecutionOptions,
  ProviderThreadContext,
} from "./provider-adapter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_BASE_INSTRUCTIONS = renderTemplate("codexBaseInstructions", {});

const PI_MODELS: AvailableModel[] = [
  {
    id: "anthropic/claude-sonnet-4-20250514",
    model: "anthropic/claude-sonnet-4-20250514",
    displayName: "Claude Sonnet 4 (via pi)",
    description: "Fast, intelligent model via pi agent",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Low reasoning effort" },
      { reasoningEffort: "medium", description: "Medium reasoning effort" },
      { reasoningEffort: "high", description: "High reasoning effort" },
    ],
    defaultReasoningEffort: "medium",
    isDefault: true,
  },
  {
    id: "anthropic/claude-opus-4-20250514",
    model: "anthropic/claude-opus-4-20250514",
    displayName: "Claude Opus 4 (via pi)",
    description: "Most capable model via pi agent",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Low reasoning effort" },
      { reasoningEffort: "medium", description: "Medium reasoning effort" },
      { reasoningEffort: "high", description: "High reasoning effort" },
    ],
    defaultReasoningEffort: "medium",
    isDefault: false,
  },
  {
    id: "openai/codex-mini",
    model: "openai/codex-mini",
    displayName: "Codex Mini (via pi)",
    description: "OpenAI coding model via pi agent",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Low reasoning effort" },
      { reasoningEffort: "medium", description: "Medium reasoning effort" },
      { reasoningEffort: "high", description: "High reasoning effort" },
    ],
    defaultReasoningEffort: "medium",
    isDefault: false,
  },
];

function normalizeProviderEventType(type: string): string {
  return type.toLowerCase().replaceAll(".", "/");
}

function normalizeTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= 60) return normalized;
  return `${normalized.slice(0, 57).trimEnd()}...`;
}

function resolveBaseInstructions(developerInstructions?: string): string {
  const trimmed = developerInstructions?.trim();
  if (!trimmed) return DEFAULT_BASE_INSTRUCTIONS;
  if (
    trimmed === DEFAULT_BASE_INSTRUCTIONS ||
    trimmed.startsWith(`${DEFAULT_BASE_INSTRUCTIONS}\n`)
  ) {
    return trimmed;
  }
  return `${DEFAULT_BASE_INSTRUCTIONS}\n\n${trimmed}`;
}

function withExecutionOptions(
  params: Record<string, unknown>,
  options?: ProviderExecutionOptions,
): Record<string, unknown> {
  if (!options) return params;
  const nextParams = { ...params };
  if (options.model) {
    nextParams.model = options.model;
  }
  if (options.reasoningLevel) {
    const nextConfig = {
      ...(toRecord(nextParams.config) ?? {}),
      model_reasoning_effort: options.reasoningLevel,
    };
    nextParams.config = nextConfig;
  }
  return nextParams;
}

function withThreadEnvironmentPolicy(
  params: Record<string, unknown>,
  context: ProviderThreadContext,
): Record<string, unknown> {
  const configEntries: Record<string, unknown> = {};
  if (context.projectId) {
    configEntries["shell_environment_policy.set.BB_PROJECT_ID"] = context.projectId;
  }
  if (context.threadId) {
    configEntries["shell_environment_policy.set.BB_THREAD_ID"] = context.threadId;
  }
  if (context.daemonUrl) {
    configEntries["shell_environment_policy.set.BB_DAEMON_URL"] = context.daemonUrl;
  }
  if (context.path) {
    configEntries["shell_environment_policy.set.PATH"] = context.path;
  }
  if (Object.keys(configEntries).length === 0) return params;
  const nextConfig = {
    ...(toRecord(params.config) ?? {}),
    ...configEntries,
  };
  return { ...params, config: nextConfig };
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

function resolveBridgePath(): string {
  return resolve(__dirname, "..", "..", "pi-bridge", "dist", "bridge.js");
}

export interface CreatePiProviderAdapterOptions {
  id?: ThreadProviderId;
  displayName?: string;
  processCommand?: string;
  processArgs?: string[];
  launchEnv?: Record<string, string>;
  capabilities?: Partial<ProviderCapabilities>;
  listModels?: () => Promise<AvailableModel[]>;
}

export function createPiProviderAdapter(
  opts?: CreatePiProviderAdapterOptions,
): ProviderAdapter {
  const capabilities: ProviderCapabilities = {
    supportsSteer: true,
    supportsRename: false,
    supportsModelList: true,
    supportsReasoningLevels: true,
    supportsServiceTier: false,
    supportsMultimodalInput: true,
    supportsDynamicTools: false,
    supportsToolCallRequests: false,
    ...(opts?.capabilities ?? {}),
  };

  const listModels =
    opts?.listModels ?? (async () => [...PI_MODELS]);

  return {
    id: opts?.id ?? ("pi" as ThreadProviderId),
    displayName: opts?.displayName ?? "Pi",
    capabilities,
    processCommand: opts?.processCommand ?? "node",
    processArgs: opts?.processArgs ?? [resolveBridgePath()],
    async resolveLaunchConfiguration(): Promise<
      ProviderLaunchConfiguration | undefined
    > {
      const env: Record<string, string> = {};

      if (opts?.launchEnv) {
        Object.assign(env, opts.launchEnv);
      }

      if (Object.keys(env).length === 0) return undefined;
      return { env };
    },
    clientInfo: {
      name: "beanbag",
      version: "0.0.1",
    },
    initializeMethod: "initialize",
    createInitializeParams(
      clientInfo: { name: string; version: string },
    ): Record<string, unknown> {
      return { clientInfo };
    },
    threadStartMethod: "thread/start",
    threadResumeMethod: "thread/resume",
    turnStartMethod: "turn/start",
    turnSteerMethod: "turn/steer",
    threadNameSetMethod: undefined,
    createThreadStartParams(
      req: SpawnThreadRequest,
      context: ProviderThreadContext,
      _dynamicTools?: ProviderDynamicTool[],
    ): Record<string, unknown> {
      const baseInstructions = resolveBaseInstructions(req.developerInstructions);
      return withExecutionOptions(
        withThreadEnvironmentPolicy({ baseInstructions }, context),
        req,
      );
    },
    createThreadResumeParams(
      providerThreadId: string,
      context: ProviderThreadContext,
      options?: ProviderExecutionOptions,
      _resumePath?: string,
    ): Record<string, unknown> {
      return withExecutionOptions(
        withThreadEnvironmentPolicy({ threadId: providerThreadId }, context),
        options,
      );
    },
    createTurnStartParams(
      providerThreadId: string,
      input: PromptInput[],
      options?: ProviderExecutionOptions,
    ): Record<string, unknown> {
      return withExecutionOptions(
        { threadId: providerThreadId, input },
        options,
      );
    },
    createTurnSteerParams(
      providerThreadId: string,
      expectedTurnId: string,
      input: PromptInput[],
    ): Record<string, unknown> {
      return {
        threadId: providerThreadId,
        expectedTurnId,
        input,
      };
    },
    createThreadNameSetParams: undefined,
    extractThreadIdFromResult: decodeThreadIdFromWireValue,
    extractThreadIdFromEventData: decodeThreadIdFromWireValue,
    normalizeEventType(type: string): string {
      return normalizeProviderEventType(type);
    },
    shouldPersistEvent(method: string): boolean {
      const normalized = normalizeProviderEventType(method);
      if (normalized === "item/agentmessage/delta") return false;
      return true;
    },
    shouldBroadcastForEvent(method: string): boolean {
      const normalized = normalizeProviderEventType(method);
      if (normalized === "item/agentmessage/delta") return false;
      return true;
    },
    statusForEvent(method: string): Thread["status"] | undefined {
      const normalized = normalizeProviderEventType(method);
      if (normalized === "turn/start" || normalized === "turn/started") return "active";
      if (normalized === "turn/completed" || normalized === "turn/end") return "idle";
      return undefined;
    },
    titleFromEvent(_method: string, _data: unknown): string | undefined {
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
      return `Thread ${threadId} has no pi session`;
    },
  };
}

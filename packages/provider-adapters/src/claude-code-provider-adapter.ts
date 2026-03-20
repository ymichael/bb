import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import type { ModelInfo } from "@anthropic-ai/sdk/resources/models";
import type {
  AvailableModel,
  ModelReasoningEffort,
  ProviderCapabilities,
  PromptInput,
  SandboxMode,
  SpawnThreadRequest,
  Thread,
  ThreadEvent,
  ThreadProviderId,
} from "@bb/core";
import {
  assertNever,
  decodeThreadEventData,
  toRecord,
} from "@bb/core";
import { renderTemplate } from "@bb/templates";
import type {
  ProviderAdapter,
  ProviderDynamicTool,
  ProviderExecutionOptions,
  ProviderLaunchConfiguration,
  ProviderThreadContext,
  ProviderToolCallRequest,
  ProviderToolCallResponse,
} from "./provider-adapter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_BASE_INSTRUCTIONS = renderTemplate("agentBaseInstructions", {});

const LOW_REASONING_EFFORT: ModelReasoningEffort = {
  reasoningEffort: "low",
  description: "Low reasoning effort",
};
const MEDIUM_REASONING_EFFORT: ModelReasoningEffort = {
  reasoningEffort: "medium",
  description: "Medium reasoning effort",
};
const HIGH_REASONING_EFFORT: ModelReasoningEffort = {
  reasoningEffort: "high",
  description: "High reasoning effort",
};
const XHIGH_REASONING_EFFORT: ModelReasoningEffort = {
  reasoningEffort: "xhigh",
  description: "Extra high reasoning effort",
};

const STATIC_CLAUDE_CODE_MODELS: AvailableModel[] = [
  {
    id: "claude-sonnet-4-6",
    model: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    description: "Fast, intelligent model for everyday coding tasks",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Low reasoning effort" },
      { reasoningEffort: "medium", description: "Medium reasoning effort" },
      { reasoningEffort: "high", description: "High reasoning effort" },
    ],
    defaultReasoningEffort: "medium",
    isDefault: true,
  },
  {
    id: "claude-opus-4-6",
    model: "claude-opus-4-6",
    displayName: "Claude Opus 4.6",
    description: "Most capable model for complex coding tasks",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Low reasoning effort" },
      { reasoningEffort: "medium", description: "Medium reasoning effort" },
      { reasoningEffort: "high", description: "High reasoning effort" },
    ],
    defaultReasoningEffort: "medium",
    isDefault: false,
  },
  {
    id: "claude-haiku-4-5",
    model: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5",
    description: "Fast, compact model for simple tasks",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Low reasoning effort" },
      { reasoningEffort: "medium", description: "Medium reasoning effort" },
    ],
    defaultReasoningEffort: "low",
    isDefault: false,
  },
];

const CLAUDE_DEFAULT_MODEL_PREFERENCES = [
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-sonnet-4",
  "claude-opus-4-6",
  "claude-haiku-4-5",
] as const;

const CLAUDE_CODE_AUTH_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

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

function decodeClaudeRoutingThreadId(value: unknown): string | undefined {
  const payload = toRecord(value);
  if (!payload) return undefined;
  return (
    (typeof payload.providerThreadId === "string"
      ? payload.providerThreadId
      : undefined) ??
    (typeof payload.provider_thread_id === "string"
      ? payload.provider_thread_id
      : undefined)
  );
}

function resolveClaudeCodeLaunchEnv(
  launchEnv?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const varName of CLAUDE_CODE_AUTH_ENV_VARS) {
    const value = process.env[varName];
    if (value) {
      env[varName] = value;
    }
  }

  if (launchEnv) {
    Object.assign(env, launchEnv);
  }

  return env;
}

function isClaudeCodeAuthConfigured(launchEnv?: Record<string, string>): boolean {
  const env = resolveClaudeCodeLaunchEnv(launchEnv);
  return CLAUDE_CODE_AUTH_ENV_VARS.some((varName) => {
    const value = env[varName];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function decodeClaudeCodeAgentMessageText(data: unknown): string | undefined {
  const decoded = decodeThreadEventData(data);
  if (decoded.item?.normalizedType !== "agentmessage") {
    return undefined;
  }
  return decoded.item.text.text || undefined;
}

function isClaudeCodeAuthFailureMessage(message: string | undefined): boolean {
  const normalized = message?.toLowerCase();
  if (!normalized) return false;
  return normalized.includes("not logged in") || normalized.includes("please run /login");
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
    configEntries["shell_environment_policy.set.BB_PROJECT_ID"] =
      context.projectId;
  }
  if (context.threadId) {
    configEntries["shell_environment_policy.set.BB_THREAD_ID"] =
      context.threadId;
  }
  if (context.serverUrl) {
    configEntries["shell_environment_policy.set.BB_SERVER_URL"] =
      context.serverUrl;
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

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function toClaudeCodeDynamicTools(
  dynamicTools?: ProviderDynamicTool[],
): Array<Record<string, unknown>> | undefined {
  if (!dynamicTools || dynamicTools.length === 0) return undefined;
  return dynamicTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: cloneJsonValue(tool.inputSchema),
  }));
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

function decodeClaudeCodeToolCallRequest(
  requestId: string | number,
  method: string,
  params: unknown,
): ProviderToolCallRequest | null {
  if (normalizeProviderEventType(method) !== "item/tool/call") return null;

  const record = toRecord(params);
  if (!record) return null;

  const threadId =
    typeof record.threadId === "string" ? record.threadId : undefined;
  const turnId =
    typeof record.turnId === "string" ? record.turnId : undefined;
  const callId =
    typeof record.callId === "string" ? record.callId : undefined;
  const tool = typeof record.tool === "string" ? record.tool : undefined;

  if (!threadId || !turnId || !callId || !tool) return null;

  return {
    requestId,
    threadId,
    turnId,
    callId,
    tool,
    arguments: record.arguments,
  };
}

function encodeClaudeCodeToolCallResponse(
  response: ProviderToolCallResponse,
): Record<string, unknown> {
  return {
    contentItems: response.contentItems.map((item) => {
      switch (item.type) {
        case "inputText":
          return { type: "inputText", text: item.text };
        case "inputImage":
          return { type: "inputImage", imageUrl: item.imageUrl };
        default:
          return assertNever(item);
      }
    }),
    success: response.success,
  };
}

function resolveBridgePath(): string {
  // Resolve the bridge.js path relative to this package's location.
  // In the monorepo layout: packages/provider-adapters/dist/ → packages/claude-code-bridge/dist/
  return resolve(__dirname, "..", "..", "claude-code-bridge", "dist", "bridge.js");
}

export function buildClaudeCodeAvailableModels(
  modelInfos: ModelInfo[],
): AvailableModel[] {
  const models = modelInfos
    .filter((model) => model.id.startsWith("claude-"))
    .map((model) => {
      const supportedReasoningEfforts = getClaudeReasoningEfforts(model.id);
      return {
        id: model.id,
        model: model.id,
        displayName: model.display_name,
        description: describeClaudeModel(model.id),
        supportedReasoningEfforts,
        defaultReasoningEffort:
          supportedReasoningEfforts.some(
            (effort) => effort.reasoningEffort === "medium",
          )
            ? "medium"
            : supportedReasoningEfforts[0].reasoningEffort,
        isDefault: false,
      };
    });

  const defaultModelId = resolveDefaultClaudeModelId(models);
  return models.map((model) =>
    model.id === defaultModelId ? { ...model, isDefault: true } : model,
  );
}

async function listClaudeCodeModels(): Promise<AvailableModel[]> {
  if (!shouldFetchClaudeCodeModelsFromAnthropic(process.env)) {
    return [...STATIC_CLAUDE_CODE_MODELS];
  }

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  const client = new Anthropic({
    ...(apiKey ? { apiKey } : {}),
  });

  const page = await client.models.list();
  const models = buildClaudeCodeAvailableModels(page.data);
  return models.length > 0 ? models : [...STATIC_CLAUDE_CODE_MODELS];
}

function shouldUseStaticClaudeModelList(env: NodeJS.ProcessEnv): boolean {
  return (
    env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    env.CLAUDE_CODE_USE_VERTEX === "1" ||
    env.CLAUDE_CODE_USE_FOUNDRY === "1"
  );
}

export function shouldFetchClaudeCodeModelsFromAnthropic(
  env: NodeJS.ProcessEnv,
): boolean {
  if (shouldUseStaticClaudeModelList(env)) {
    return false;
  }

  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (apiKey) {
    return true;
  }

  // Anthropic's public models API rejects Claude Code OAuth tokens, so
  // OAuth-only environments intentionally fall back to the static catalog.
  return false;
}

function getClaudeReasoningEfforts(modelId: string): ModelReasoningEffort[] {
  if (modelId.startsWith("claude-haiku")) {
    return [LOW_REASONING_EFFORT, MEDIUM_REASONING_EFFORT];
  }
  if (modelId.startsWith("claude-opus-4-6")) {
    return [
      LOW_REASONING_EFFORT,
      MEDIUM_REASONING_EFFORT,
      HIGH_REASONING_EFFORT,
      XHIGH_REASONING_EFFORT,
    ];
  }

  // Claude model IDs come from the provider and can evolve independently of BB.
  // Unknown Claude families intentionally fall back to the common reasoning set.
  return [LOW_REASONING_EFFORT, MEDIUM_REASONING_EFFORT, HIGH_REASONING_EFFORT];
}

function describeClaudeModel(modelId: string): string {
  if (modelId.startsWith("claude-opus")) {
    return "Most capable Claude model for complex coding tasks";
  }
  if (modelId.startsWith("claude-haiku")) {
    return "Fast Claude model for lightweight coding tasks";
  }
  return "Fast, intelligent Claude model for everyday coding tasks";
}

function resolveDefaultClaudeModelId(
  models: AvailableModel[],
): string | undefined {
  for (const preferred of CLAUDE_DEFAULT_MODEL_PREFERENCES) {
    if (models.some((model) => model.id === preferred)) {
      return preferred;
    }
  }
  return models[0]?.id;
}

export interface CreateClaudeCodeProviderAdapterOptions {
  id?: ThreadProviderId;
  displayName?: string;
  processCommand?: string;
  processArgs?: string[];
  launchEnv?: Record<string, string>;
  capabilities?: Partial<ProviderCapabilities>;
  listModels?: () => Promise<AvailableModel[]>;
}

export function createClaudeCodeProviderAdapter(
  opts?: CreateClaudeCodeProviderAdapterOptions,
): ProviderAdapter {
  const capabilities: ProviderCapabilities = {
    supportsRename: false,
    supportsServiceTier: false,
    ...(opts?.capabilities ?? {}),
  };

  const listModels =
    opts?.listModels ??
    listClaudeCodeModels;

  return {
    id: opts?.id ?? ("claude-code" as ThreadProviderId),
    displayName: opts?.displayName ?? "Claude Code",
    capabilities,
    processCommand: opts?.processCommand ?? "node",
    processArgs: opts?.processArgs ?? [resolveBridgePath()],
    async resolveLaunchConfiguration(): Promise<
      ProviderLaunchConfiguration | undefined
    > {
      const env = resolveClaudeCodeLaunchEnv(opts?.launchEnv);
      if (Object.keys(env).length === 0) return undefined;
      return { env };
    },
    preflightSessionStart(): string | undefined {
      if (isClaudeCodeAuthConfigured(opts?.launchEnv)) {
        return undefined;
      }
      return "Claude Code authentication is unavailable. Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN.";
    },
    clientInfo: {
      name: "bb",
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
      dynamicTools?: ProviderDynamicTool[],
    ): Record<string, unknown> {
      const baseInstructions = resolveBaseInstructions(
        req.developerInstructions,
      );
      const params = withExecutionOptions(
        withThreadEnvironmentPolicy(
          { baseInstructions },
          context,
        ),
        req,
      );
      const tools = toClaudeCodeDynamicTools(dynamicTools);
      return {
        ...params,
        threadId: context.threadId,
        ...(req.type === "manager" ? { managerMode: true } : {}),
        ...(tools ? { dynamicTools: tools } : {}),
      };
    },
    createThreadResumeParams(
      providerThreadId: string | undefined,
      context: ProviderThreadContext,
      options?: ProviderExecutionOptions,
      _resumePath?: string,
    ): Record<string, unknown> {
      return withExecutionOptions(
        withThreadEnvironmentPolicy(
          {
            threadId: context.threadId,
            providerThreadId: providerThreadId ?? null,
          },
          context,
        ),
        options,
      );
    },
    createTurnStartParams(
      threadId: string,
      providerThreadId: string | undefined,
      input: PromptInput[],
      options?: ProviderExecutionOptions,
    ): Record<string, unknown> {
      return withExecutionOptions(
        {
          threadId,
          providerThreadId: providerThreadId ?? null,
          input,
        },
        options,
      );
    },
    createTurnSteerParams(
      threadId: string,
      providerThreadId: string | undefined,
      expectedTurnId: string,
      input: PromptInput[],
    ): Record<string, unknown> {
      return {
        threadId,
        providerThreadId: providerThreadId ?? null,
        expectedTurnId,
        input,
      };
    },
    createThreadNameSetParams: undefined,
    extractThreadIdFromResult: decodeClaudeRoutingThreadId,
    extractThreadIdFromEventData: decodeClaudeRoutingThreadId,
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
    statusForEvent(method: string, data: unknown): Thread["status"] | undefined {
      const normalized = normalizeProviderEventType(method);
      if (normalized === "turn/start" || normalized === "turn/started") {
        return "active";
      }
      if (normalized === "turn/completed" || normalized === "turn/end") {
        return "idle";
      }
      if (normalized === "error") {
        return "error";
      }
      if (
        normalized === "item/completed" &&
        isClaudeCodeAuthFailureMessage(decodeClaudeCodeAgentMessageText(data))
      ) {
        return "error";
      }
      return undefined;
    },
    titleFromEvent(_method: string, _data: unknown): string | undefined {
      // Claude Code does not emit thread name events; BB manages
      // titles locally via deriveThreadTitle.
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
      return `Thread ${threadId} has no Claude Code session`;
    },
    decodeToolCallRequest(
      requestId: string | number,
      method: string,
      params: unknown,
    ): ProviderToolCallRequest | null {
      return decodeClaudeCodeToolCallRequest(requestId, method, params);
    },
    encodeToolCallResponse(
      response: ProviderToolCallResponse,
    ): Record<string, unknown> {
      return encodeClaudeCodeToolCallResponse(response);
    },
  };
}

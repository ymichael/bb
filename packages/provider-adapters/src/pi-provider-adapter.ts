import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { supportsXhigh, type Model } from "@mariozechner/pi-ai";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import type {
  AvailableModel,
  ModelReasoningEffort,
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
  decodeThreadEventData,
  decodeThreadIdFromWireValue,
  toRecord,
} from "@bb/core";
import { renderTemplate } from "@bb/templates";
import type {
  ProviderAdapter,
  ProviderExecutionOptions,
  ProviderThreadContext,
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

const PI_DEFAULT_MODEL_PREFERENCES = [
  "anthropic/claude-sonnet-4-20250514",
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-opus-4-20250514",
  "openai/codex-mini",
] as const;

type PiCatalogModel = Pick<
  Model<any>,
  "id" | "name" | "provider" | "reasoning" | "input"
>;

export function buildPiAvailableModels(args: {
  providers: string[];
  getModels: (provider: string) => PiCatalogModel[];
  hasAuth: (provider: string) => boolean;
}): AvailableModel[] {
  const models: AvailableModel[] = [];

  for (const provider of args.providers) {
    if (!args.hasAuth(provider)) continue;

    for (const model of args.getModels(provider)) {
      const canonicalId = toCanonicalPiModelId(provider, model.id);
      const supportedReasoningEfforts = getPiReasoningEfforts(model);
      models.push({
        id: canonicalId,
        model: canonicalId,
        displayName: model.name,
        description: describePiModel(model),
        supportedReasoningEfforts,
        defaultReasoningEffort: model.reasoning ? "medium" : "low",
        isDefault: false,
      });
    }
  }

  const defaultModelId = resolveDefaultPiModelId(models);
  return models.map((model) =>
    model.id === defaultModelId ? { ...model, isDefault: true } : model,
  );
}

async function listPiModels(): Promise<AvailableModel[]> {
  const [{ getModels, getProviders }, authStorageModule] = await Promise.all([
    import("@mariozechner/pi-ai"),
    Promise.resolve(AuthStorage.create()),
  ]);

  return buildPiAvailableModels({
    providers: getProviders(),
    getModels: (provider) => getModels(provider as never) as PiCatalogModel[],
    hasAuth: (provider) => authStorageModule.hasAuth(provider),
  });
}

function toCanonicalPiModelId(provider: string, modelId: string): string {
  return modelId.includes("/") ? modelId : `${provider}/${modelId}`;
}

function getPiReasoningEfforts(model: PiCatalogModel): ModelReasoningEffort[] {
  if (!model.reasoning) {
    return [LOW_REASONING_EFFORT];
  }

  const efforts = [
    LOW_REASONING_EFFORT,
    MEDIUM_REASONING_EFFORT,
    HIGH_REASONING_EFFORT,
  ];
  if (supportsXhigh(model as Model<any>)) {
    efforts.push(XHIGH_REASONING_EFFORT);
  }
  return efforts;
}

function describePiModel(model: PiCatalogModel): string {
  const capabilities: string[] = [];
  capabilities.push(model.reasoning ? "reasoning" : "non-reasoning");
  if (model.input.includes("image")) {
    capabilities.push("multimodal");
  }
  return `${capitalize(model.provider)} ${capabilities.join(", ")} model via Pi`;
}

function capitalize(value: string): string {
  return value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value;
}

function resolveDefaultPiModelId(models: AvailableModel[]): string | undefined {
  for (const preferred of PI_DEFAULT_MODEL_PREFERENCES) {
    if (models.some((model) => model.id === preferred)) {
      return preferred;
    }
  }
  return models[0]?.id;
}

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
    supportsRename: false,
    supportsServiceTier: false,
    ...(opts?.capabilities ?? {}),
  };

  const listModels =
    opts?.listModels ?? listPiModels;

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
      const baseInstructions = resolveBaseInstructions(req.developerInstructions);
      const params = withExecutionOptions(
        withThreadEnvironmentPolicy(
          {
            baseInstructions,
            ...(context.threadId ? { threadId: context.threadId } : {}),
          },
          context,
        ),
        req,
      );
      if (dynamicTools && dynamicTools.length > 0) {
        params.dynamicTools = dynamicTools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
      }
      return params;
    },
    createThreadResumeParams(
      providerThreadId: string,
      context: ProviderThreadContext,
      options?: ProviderExecutionOptions,
      resumePath?: string,
    ): Record<string, unknown> {
      return withExecutionOptions(
        withThreadEnvironmentPolicy(
          {
            threadId: providerThreadId,
            ...(resumePath ? { sessionPath: resumePath } : {}),
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
    decodeToolCallRequest(
      requestId: string | number,
      method: string,
      params: unknown,
    ): ProviderToolCallRequest | null {
      if (normalizeProviderEventType(method) !== "item/tool/call") {
        return null;
      }
      const record = toRecord(params);
      if (!record) return null;
      const threadId = typeof record.threadId === "string" ? record.threadId : undefined;
      const turnId = typeof record.turnId === "string" ? record.turnId : undefined;
      const callId = typeof record.callId === "string" ? record.callId : undefined;
      const tool = typeof record.tool === "string" ? record.tool : undefined;
      if (!threadId || !turnId || !callId || !tool) return null;
      return { requestId, threadId, turnId, callId, tool, arguments: record.arguments };
    },
    encodeToolCallResponse(
      response: ProviderToolCallResponse,
    ): Record<string, unknown> {
      return {
        contentItems: response.contentItems.map((item) => {
          if (item.type === "inputText") return { type: "inputText", text: item.text };
          if (item.type === "inputImage") return { type: "inputImage", imageUrl: item.imageUrl };
          return item;
        }),
        success: response.success,
      };
    },
  };
}

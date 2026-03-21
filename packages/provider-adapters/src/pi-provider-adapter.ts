/**
 * Pi provider adapter.
 *
 * Maps between bb's ProviderAdapter contract and the Pi coding agent bridge
 * process. Uses the Pi AI SDK for model catalog and authentication. The adapter
 * owns event translation: it takes raw `AgentSessionEvent` from the Pi SDK
 * and produces `BbProviderEvent[]`.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { supportsXhigh, type Model } from "@mariozechner/pi-ai";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import type {
  AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import { renderTemplate } from "@bb/templates";
import type {
  AvailableModel,
  ModelReasoningEffort,
  ProviderCapabilities,
} from "@bb/core";
import {
  bashArgsSchema,
  contentWrapperSchema,
  fileEditArgsSchema,
  textBlockSchema,
  webSearchArgsSchema,
} from "./tool-arg-schemas.js";
import {
  decodeProviderToolCallRequest,
  encodeProviderToolCallResponse,
} from "./provider-tool-call-contract.js";
import type {
  BbProviderEvent,
  BbProviderEventItem,
  BbProviderEventTokenUsage,
  BbProviderEventTokenUsageBreakdown,
  ProviderLaunchConfiguration,
  ProviderThreadContext,
} from "@bb/core";
import type { PiCommand } from "./bridges/pi/bridge.js";
import type { ProviderAdapter, ProviderRequest } from "./provider-adapter.js";

// ---------------------------------------------------------------------------
// Pi event and command types
// ---------------------------------------------------------------------------

/** The raw SDK event type from the Pi coding agent. */
export type PiEvent = AgentSessionEvent;


// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Pi-specific helpers
// ---------------------------------------------------------------------------

type PiCatalogModel = Pick<
  Model<any>,
  "id" | "name" | "provider" | "reasoning" | "input"
>;

function resolveBridgePath(): string {
  return resolve(__dirname, "bridges", "pi", "bridge.js");
}

function resolveBaseInstructions(developerInstructions?: string): string {
  const trimmed = developerInstructions?.trim();
  if (!trimmed) return DEFAULT_BASE_INSTRUCTIONS;
  if (trimmed === DEFAULT_BASE_INSTRUCTIONS || trimmed.startsWith(`${DEFAULT_BASE_INSTRUCTIONS}\n`)) {
    return trimmed;
  }
  return `${DEFAULT_BASE_INSTRUCTIONS}\n\n${trimmed}`;
}

function buildPiConfig(context: ProviderThreadContext): Record<string, unknown> | undefined {
  const config: Record<string, unknown> = {};
  if (context.projectId) config["shell_environment_policy.set.BB_PROJECT_ID"] = context.projectId;
  if (context.threadId) config["shell_environment_policy.set.BB_THREAD_ID"] = context.threadId;
  if (context.serverUrl) config["shell_environment_policy.set.BB_SERVER_URL"] = context.serverUrl;
  if (context.path) config["shell_environment_policy.set.PATH"] = context.path;
  return Object.keys(config).length > 0 ? config : undefined;
}

async function readPiAgentFile(path: string): Promise<string | null> {
  try {
    return await readFile(resolve(homedir(), ".pi", "agent", path), "utf8");
  } catch {
    return null;
  }
}

async function resolvePiProviderLaunchConfiguration(
  launchEnv?: Record<string, string>,
): Promise<ProviderLaunchConfiguration | undefined> {
  const env: Record<string, string> = {};
  if (launchEnv) Object.assign(env, launchEnv);

  const [authJson, settingsJson, modelsJson] = await Promise.all([
    readPiAgentFile("auth.json"),
    readPiAgentFile("settings.json"),
    readPiAgentFile("models.json"),
  ]);

  const files: NonNullable<ProviderLaunchConfiguration["files"]> = [];
  if (authJson) files.push({ placement: "home", path: ".pi/agent/auth.json", content: authJson });
  if (settingsJson) files.push({ placement: "home", path: ".pi/agent/settings.json", content: settingsJson });
  if (modelsJson) files.push({ placement: "home", path: ".pi/agent/models.json", content: modelsJson });

  if (Object.keys(env).length === 0 && files.length === 0) return undefined;
  return {
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(files.length > 0 ? { files } : {}),
  };
}

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

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
  const defaultId = resolveDefaultPiModelId(models);
  return models.map((m) => (m.id === defaultId ? { ...m, isDefault: true } : m));
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
  if (!model.reasoning) return [LOW_REASONING_EFFORT];
  const efforts = [LOW_REASONING_EFFORT, MEDIUM_REASONING_EFFORT, HIGH_REASONING_EFFORT];
  if (supportsXhigh(model as Model<any>)) efforts.push(XHIGH_REASONING_EFFORT);
  return efforts;
}

function describePiModel(model: PiCatalogModel): string {
  const capabilities: string[] = [];
  capabilities.push(model.reasoning ? "reasoning" : "non-reasoning");
  if (model.input.includes("image")) capabilities.push("multimodal");
  const provider = model.provider.length > 0
    ? model.provider[0].toUpperCase() + model.provider.slice(1)
    : model.provider;
  return `${provider} ${capabilities.join(", ")} model via Pi`;
}

function resolveDefaultPiModelId(models: AvailableModel[]): string | undefined {
  for (const preferred of PI_DEFAULT_MODEL_PREFERENCES) {
    if (models.some((m) => m.id === preferred)) return preferred;
  }
  return models[0]?.id;
}

async function hasPiModelsAvailable(listModels: () => Promise<AvailableModel[]>): Promise<boolean> {
  try {
    return (await listModels()).length > 0;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

/** Options for overriding pi adapter defaults. Used by test infrastructure. */
export interface CreatePiProviderAdapterOptions {
  /** Override the bridge binary. */
  processCommand?: string;
  /** Override the bridge binary args. */
  processArgs?: string[];
  /** Extra environment variables for the bridge process. */
  launchEnv?: Record<string, string>;
  /** Override model listing. Used by unit tests to avoid real API calls. */
  listModels?: () => Promise<AvailableModel[]>;
}

export function createPiProviderAdapter(
  opts?: CreatePiProviderAdapterOptions,
): ProviderAdapter<PiEvent, PiCommand> {
  const capabilities: ProviderCapabilities = {
    supportsRename: false,
    supportsServiceTier: false,
  };
  const models = opts?.listModels ?? listPiModels;

  // Turn counter state — Pi SDK doesn't have turn IDs
  let turnCounter = 0;
  let currentTurnId: string | undefined;

  function nextTurnId(): string {
    turnCounter += 1;
    return `turn-${turnCounter}`;
  }

  return {
    // -- Identity & launch -------------------------------------------------

    id: "pi",
    displayName: "Pi",
    capabilities,
    process: {
      command: opts?.processCommand ?? "node",
      args: opts?.processArgs ?? [resolveBridgePath()],
    },

    async resolveLaunchConfiguration(): Promise<ProviderLaunchConfiguration | undefined> {
      return resolvePiProviderLaunchConfiguration(opts?.launchEnv);
    },

    async preflightSessionStart(): Promise<string | undefined> {
      if (await hasPiModelsAvailable(models)) return undefined;
      return "Pi authentication or model selection is unavailable. Use /login to configure a provider and choose a model.";
    },

    // -- Unified command builder -------------------------------------------

    buildCommand(request: ProviderRequest) {
      switch (request.type) {
        case "initialize":
          return { method: "initialize" as const, params: { clientInfo: request.clientInfo } };
        case "thread/start": {
          const baseInstructions = resolveBaseInstructions(request.req.developerInstructions);
          const config = buildPiConfig(request.context);
          const dynamicTools = request.dynamicTools?.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: JSON.parse(JSON.stringify(t.inputSchema)),
          }));
          return {
            method: "thread/start" as const,
            params: {
              threadId: request.context.threadId,
              baseInstructions,
              ...(config ? { config } : {}),
              ...(request.req.model ? { model: request.req.model } : {}),
              ...(request.req.reasoningLevel ? { config: { ...config, model_reasoning_effort: request.req.reasoningLevel } } : {}),
              ...(dynamicTools && dynamicTools.length > 0 ? { dynamicTools } : {}),
            },
          };
        }
        case "thread/resume": {
          const threadId = request.providerThreadId ?? request.context.threadId;
          return {
            method: "thread/resume" as const,
            params: {
              threadId,
              ...(buildPiConfig(request.context) ? { config: buildPiConfig(request.context) } : {}),
              ...(request.options?.model ? { model: request.options.model } : {}),
              ...(request.resumePath ? { sessionPath: request.resumePath } : {}),
            },
          };
        }
        case "turn/start":
          return {
            method: "turn/start" as const,
            params: {
              threadId: request.providerThreadId ?? request.threadId,
              input: request.input,
              ...(request.options?.model ? { model: request.options.model } : {}),
            },
          };
        case "turn/steer":
          return {
            method: "turn/steer" as const,
            params: {
              threadId: request.providerThreadId ?? request.threadId,
              expectedTurnId: request.expectedTurnId,
              input: request.input,
            },
          };
        case "thread/name/set":
          return null; // Pi doesn't support rename
      }
    },

    // -- Unified event translator ------------------------------------------

    translateEvent(event: PiEvent): BbProviderEvent[] {
      const threadId = "";
      const events: BbProviderEvent[] = [];

      switch (event.type) {
        case "agent_start": {
          if (!currentTurnId) {
            currentTurnId = nextTurnId();
            events.push({ type: "turn/started", threadId, turnId: currentTurnId });
          }
          break;
        }

        case "agent_end": {
          const lastAssistant = findLastAssistantMessage(event.messages);
          if (lastAssistant) {
            const text = extractAssistantText(lastAssistant);
            if (text) {
              events.push({
                type: "item/completed",
                threadId,
                turnId: currentTurnId ?? "",
                item: { type: "agentMessage", id: `msg-${turnCounter}`, text },
              });
            }
          }
          if (currentTurnId) {
            const tokenUsage = extractPiTokenUsage(lastAssistant);
            if (tokenUsage) {
              events.push({
                type: "thread/tokenUsage/updated",
                threadId,
                turnId: currentTurnId,
                tokenUsage,
              });
            }
            events.push({
              type: "turn/completed",
              threadId,
              turnId: currentTurnId,
              status: "completed",
            });
            currentTurnId = undefined;
          }
          break;
        }

        case "message_update": {
          const assistantEvent = event.assistantMessageEvent;
          if (assistantEvent.type === "text_delta" && currentTurnId) {
            const delta = assistantEvent.delta;
            if (delta) {
              events.push({
                type: "item/agentMessage/delta",
                threadId,
                turnId: currentTurnId,
                delta,
              });
            }
          }
          break;
        }

        case "tool_execution_start": {
          if (currentTurnId) {
            events.push({
              type: "item/started",
              threadId,
              turnId: currentTurnId,
              item: translateToolCallToItem(
                event.toolCallId,
                event.toolName,
                event.args,
              ),
            });
          }
          break;
        }

        case "tool_execution_end": {
          if (currentTurnId) {
            events.push({
              type: "item/completed",
              threadId,
              turnId: currentTurnId,
              item: translateToolResultToItem(
                event.toolCallId,
                event.toolName,
                event.result,
                event.isError,
              ),
            });
          }
          break;
        }

        default:
          break;
      }

      return events;
    },

    // -- Tool call codec ---------------------------------------------------

    decodeToolCallRequest({ requestId, method, params }) {
      return decodeProviderToolCallRequest(requestId, method, params);
    },

    encodeToolCallResponse(response) {
      return encodeProviderToolCallResponse(response);
    },

    // -- Provider capabilities ---------------------------------------------

    listModels() {
      return models();
    },
  };
}

// ---------------------------------------------------------------------------
// Pi SDK event extraction helpers
// ---------------------------------------------------------------------------

type PiAgentEndEvent = Extract<AgentSessionEvent, { type: "agent_end" }>;
type PiAssistantMessage = Extract<PiAgentEndEvent["messages"][number], { role: "assistant" }>;

function findLastAssistantMessage(
  messages: PiAgentEndEvent["messages"],
): PiAssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === "assistant") {
      return message as PiAssistantMessage;
    }
  }
  return undefined;
}

function extractAssistantText(
  message: PiAssistantMessage,
): string | undefined {
  const content = message.content;
  const chunks: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      chunks.push(block.text);
    }
  }
  const text = chunks.join("\n").trim();
  return text.length > 0 ? text : undefined;
}

function extractPiTokenUsage(
  lastAssistant: PiAssistantMessage | undefined,
): BbProviderEventTokenUsage | undefined {
  const last = toAssistantUsageBreakdown(lastAssistant);

  if (!last) return undefined;

  const emptyBreakdown: BbProviderEventTokenUsageBreakdown = {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };

  return {
    total: emptyBreakdown,
    last,
    modelContextWindow: null,
  };
}

function toAssistantUsageBreakdown(
  lastAssistant: PiAssistantMessage | undefined,
): BbProviderEventTokenUsageBreakdown | undefined {
  const typedUsage = lastAssistant?.usage;
  if (!typedUsage) return undefined;

  const inputTokens = toNonNegativeNumber(typedUsage.input);
  const outputTokens = toNonNegativeNumber(typedUsage.output);
  const cachedInputTokens =
    toNonNegativeNumber(typedUsage.cacheRead) + toNonNegativeNumber(typedUsage.cacheWrite);
  const totalTokens = toNonNegativeNumber(typedUsage.totalTokens);

  return {
    totalTokens:
      totalTokens > 0 ? totalTokens : inputTokens + outputTokens + cachedInputTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens: 0,
  };
}

function toNonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

// ---------------------------------------------------------------------------
// Tool call → BbProviderEventItem translation
// ---------------------------------------------------------------------------

const BASH_TOOLS = new Set(["Bash", "bash"]);
const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "edit", "write"]);
const WEB_SEARCH_TOOLS = new Set(["WebSearch", "WebFetch"]);

function translateToolCallToItem(
  callId: string,
  toolName: string,
  args: unknown,
): BbProviderEventItem {
  if (BASH_TOOLS.has(toolName)) {
    const parsed = bashArgsSchema.safeParse(args);
    return {
      type: "commandExecution",
      id: callId,
      command: parsed.success ? String(parsed.data.command ?? "") : "",
      cwd: parsed.success && typeof parsed.data.cwd === "string" ? parsed.data.cwd : "",
      status: "pending",
    };
  }

  if (FILE_EDIT_TOOLS.has(toolName)) {
    const parsed = fileEditArgsSchema.safeParse(args);
    const filePath = parsed.success
      ? (parsed.data.file_path ?? parsed.data.path ?? "")
      : "";
    return {
      type: "fileChange",
      id: callId,
      changes: [{ path: filePath, kind: "update" as const }],
      status: "pending",
    };
  }

  if (WEB_SEARCH_TOOLS.has(toolName)) {
    const parsed = webSearchArgsSchema.safeParse(args);
    return {
      type: "webSearch",
      id: callId,
      query: parsed.success ? String(parsed.data.query ?? parsed.data.url ?? "") : "",
    };
  }

  return {
    type: "toolCall",
    id: callId,
    tool: toolName,
    arguments: args,
    status: "pending",
  };
}

function translateToolResultToItem(
  callId: string,
  toolName: string,
  content: unknown,
  isError: boolean,
): BbProviderEventItem {
  const outputText = extractResultText(content);
  const status = isError ? "failed" as const : "completed" as const;

  if (BASH_TOOLS.has(toolName)) {
    return {
      type: "commandExecution",
      id: callId,
      command: "",
      cwd: "",
      aggregatedOutput: outputText,
      exitCode: isError ? 1 : 0,
      status,
    };
  }

  if (FILE_EDIT_TOOLS.has(toolName)) {
    return {
      type: "fileChange",
      id: callId,
      changes: [],
      status,
    };
  }

  if (WEB_SEARCH_TOOLS.has(toolName)) {
    return {
      type: "webSearch",
      id: callId,
      query: "",
    };
  }

  return {
    type: "toolCall",
    id: callId,
    tool: toolName,
    status,
    result: outputText,
  };
}

function extractResultText(content: unknown): string {
  if (typeof content === "string") return content;

  if (content && typeof content === "object" && !Array.isArray(content)) {
    const wrapper = contentWrapperSchema.safeParse(content);
    if (wrapper.success) {
      return extractResultText(wrapper.data.content);
    }
    return JSON.stringify(content);
  }

  if (!Array.isArray(content)) return JSON.stringify(content ?? "");

  const chunks: string[] = [];
  for (const block of content) {
    const parsed = textBlockSchema.safeParse(block);
    if (parsed.success) {
      chunks.push(parsed.data.text);
    }
  }
  return chunks.join("\n");
}

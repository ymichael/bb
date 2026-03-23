/**
 * Pi provider adapter.
 *
 * Maps between bb's ProviderAdapter contract and the Pi coding agent bridge
 * process. Uses the Pi AI SDK for model catalog and authentication. The adapter
 * owns event translation: it takes raw `AgentSessionEvent` from the Pi SDK
 * and produces `ThreadEvent[]`.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { supportsXhigh, type Model } from "@mariozechner/pi-ai";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import type {
  AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import type {
  AvailableModel,
  ModelReasoningEffort,
  ProviderCapabilities,
  ThreadEvent,
  ThreadEventTokenUsage,
  ThreadEventTokenUsageBreakdown,
  ToolCallRequest,
} from "@bb/domain";
import {
  decodeProviderToolCallRequest,
} from "../shared/provider-tool-call-contract.js";
import {
  HIGH_REASONING_EFFORT,
  LOW_REASONING_EFFORT,
  MEDIUM_REASONING_EFFORT,
  XHIGH_REASONING_EFFORT,
  resolveBaseInstructions,
  toNonNegativeNumber,
  translateToolCallToItem,
  translateToolResultToItem,
} from "../shared/adapter-utils.js";
import type {
  AdapterCommand,
  AdapterOptions,
  JsonRpcMessage,
  ProviderAdapter,
} from "../provider-adapter.js";

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
  // When running via vitest, __dirname points to src/ where .js doesn't exist.
  // Redirect to dist/ so the bridge is always the compiled JS.
  const dir = __dirname.includes("/src/")
    ? __dirname.replace("/src/", "/dist/")
    : __dirname;
  return resolve(dir, "bridge", "bridge.js");
}

function buildPiConfig(threadId: string, options?: AdapterOptions): Record<string, unknown> | undefined {
  const config: Record<string, unknown> = {};
  if (threadId) config["shell_environment_policy.set.BB_THREAD_ID"] = threadId;
  const envVars = options?.envVars;
  if (envVars) {
    for (const [key, value] of Object.entries(envVars)) {
      config[`shell_environment_policy.set.${key}`] = value;
    }
  }
  return Object.keys(config).length > 0 ? config : undefined;
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
): ProviderAdapter {
  const capabilities: ProviderCapabilities = {
    supportsRename: false,
    supportsServiceTier: false,
  };
  const models = opts?.listModels ?? listPiModels;

  // Per-thread turn state — Pi SDK doesn't have turn IDs, so the adapter
  // assigns them. Keyed by threadId so multiple threads sharing one adapter
  // instance don't corrupt each other's counters.
  // TODO: turnState grows unboundedly — needs a removeThread(threadId) method
  // on the adapter interface to clean up entries when threads are removed.
  const turnState = new Map<string, {
    counter: number;
    currentTurnId: string | undefined;
    cumulativeTokens: ThreadEventTokenUsageBreakdown;
  }>();

  function getTurnState(threadId: string) {
    if (!turnState.has(threadId)) {
      turnState.set(threadId, {
        counter: 0,
        currentTurnId: undefined,
        cumulativeTokens: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
      });
    }
    return turnState.get(threadId)!;
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

    // -- Unified command builder -------------------------------------------

    buildCommand(command: AdapterCommand): JsonRpcMessage | null {
      switch (command.type) {
        case "initialize":
          return {
            jsonrpc: "2.0" as const,
            method: "initialize",
            params: { clientInfo: { name: "bb", version: "1.0.0" } },
          };
        case "thread/start": {
          const baseInstructions = resolveBaseInstructions(command.options?.instructions);
          const config = buildPiConfig(command.threadId, command.options);
          const finalConfig: Record<string, unknown> = config ? { ...config } : {};
          if (command.options?.reasoningLevel) {
            finalConfig.model_reasoning_effort = command.options.reasoningLevel;
          }
          const dynamicTools = command.dynamicTools?.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: JSON.parse(JSON.stringify(t.inputSchema)),
          }));
          return {
            jsonrpc: "2.0" as const,
            method: "thread/start",
            params: {
              threadId: command.threadId,
              baseInstructions,
              ...(Object.keys(finalConfig).length > 0 ? { config: finalConfig } : {}),
              ...(command.options?.model ? { model: command.options.model } : {}),
              ...(dynamicTools && dynamicTools.length > 0 ? { dynamicTools } : {}),
            },
          };
        }
        case "thread/resume": {
          const threadId = command.providerThreadId ?? command.threadId;
          const config = buildPiConfig(command.threadId, command.options);
          return {
            jsonrpc: "2.0" as const,
            method: "thread/resume",
            params: {
              threadId,
              ...(config ? { config } : {}),
              ...(command.options?.model ? { model: command.options.model } : {}),
              ...(command.resumePath ? { sessionPath: command.resumePath } : {}),
            },
          };
        }
        case "turn/start":
          return {
            jsonrpc: "2.0" as const,
            method: "turn/start",
            params: {
              threadId: command.providerThreadId ?? command.threadId,
              input: command.input,
              ...(command.options?.model ? { model: command.options.model } : {}),
            },
          };
        case "turn/steer":
          return {
            jsonrpc: "2.0" as const,
            method: "turn/steer",
            params: {
              threadId: command.providerThreadId ?? command.threadId,
              expectedTurnId: command.expectedTurnId,
              input: command.input,
            },
          };
        case "thread/stop":
          return null;
        case "thread/name/set":
          return null; // Pi doesn't support rename
      }
    },

    // -- Unified event translator ------------------------------------------

    translateEvent(event: unknown, context?: { threadId?: string }): ThreadEvent[] {
      // The runtime passes full JSON-RPC notifications. Unwrap bridge
      // envelope formats so the translation logic sees raw SDK events.
      const envelope = event as { method?: string; params?: Record<string, unknown> };
      if (envelope.method === "sdk/message") {
        const sdkMessage = envelope.params?.message;
        if (!sdkMessage) return [];
        return this.translateEvent(sdkMessage, context);
      }
      if (envelope.method === "thread/identity") {
        const tid = (envelope.params?.threadId as string) ?? "";
        const providerThreadId = envelope.params?.providerThreadId as string | undefined;
        if (providerThreadId) {
          return [{ type: "thread/identity", threadId: tid, providerThreadId } as ThreadEvent];
        }
        return [];
      }
      if (envelope.method === "error") {
        const params = envelope.params as { message?: string } | undefined;
        return [{ type: "error", threadId: "", providerThreadId: "", message: params?.message ?? "unknown error" } as ThreadEvent];
      }

      const piEvent = event as PiEvent;
      const threadId = "";
      const events: ThreadEvent[] = [];

      // Resolve per-thread turn state using the context threadId.
      const stateKey = context?.threadId ?? "";
      const state = getTurnState(stateKey);

      switch (piEvent.type) {
        case "agent_start": {
          if (!state.currentTurnId) {
            state.counter += 1;
            state.currentTurnId = `turn-${state.counter}`;
            events.push({ type: "turn/started", threadId, providerThreadId: "", turnId: state.currentTurnId });
          }
          break;
        }

        case "agent_end": {
          const lastAssistant = findLastAssistantMessage(piEvent.messages);
          if (lastAssistant) {
            const text = extractAssistantText(lastAssistant);
            if (text) {
              events.push({
                type: "item/completed",
                threadId,
                providerThreadId: "",
                turnId: state.currentTurnId ?? "",
                item: { type: "agentMessage", id: `msg-${state.counter}`, text },
              });
            }
          }
          if (state.currentTurnId) {
            const tokenUsage = extractPiTokenUsage(lastAssistant, state.cumulativeTokens);
            if (tokenUsage) {
              events.push({
                type: "thread/tokenUsage/updated",
                threadId,
                providerThreadId: "",
                turnId: state.currentTurnId,
                tokenUsage,
              });
            }
            events.push({
              type: "turn/completed",
              threadId,
              providerThreadId: "",
              turnId: state.currentTurnId,
              status: "completed",
            });
            state.currentTurnId = undefined;
          }
          break;
        }

        case "message_update": {
          const assistantEvent = piEvent.assistantMessageEvent;
          if (assistantEvent.type === "text_delta" && state.currentTurnId) {
            const delta = assistantEvent.delta;
            if (delta) {
              events.push({
                type: "item/agentMessage/delta",
                threadId,
                providerThreadId: "",
                turnId: state.currentTurnId,
                delta,
              });
            }
          }
          break;
        }

        case "tool_execution_start": {
          if (state.currentTurnId) {
            events.push({
              type: "item/started",
              threadId,
              providerThreadId: "",
              turnId: state.currentTurnId,
              item: translateToolCallToItem(
                piEvent.toolCallId,
                piEvent.toolName,
                piEvent.args,
              ),
            });
          }
          break;
        }

        case "tool_execution_end": {
          if (state.currentTurnId) {
            events.push({
              type: "item/completed",
              threadId,
              providerThreadId: "",
              turnId: state.currentTurnId,
              item: translateToolResultToItem(
                piEvent.toolCallId,
                piEvent.toolName,
                piEvent.result,
                piEvent.isError,
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

    decodeToolCallRequest(request: JsonRpcMessage): ToolCallRequest | null {
      if (request.id == null) return null;
      return decodeProviderToolCallRequest(request.id, request.method, request.params);
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
  cumulativeTokens: ThreadEventTokenUsageBreakdown,
): ThreadEventTokenUsage | undefined {
  const last = toAssistantUsageBreakdown(lastAssistant);

  if (!last) return undefined;

  // Accumulate into the per-thread cumulative total
  cumulativeTokens.totalTokens += last.totalTokens;
  cumulativeTokens.inputTokens += last.inputTokens;
  cumulativeTokens.cachedInputTokens += last.cachedInputTokens;
  cumulativeTokens.outputTokens += last.outputTokens;
  cumulativeTokens.reasoningOutputTokens += last.reasoningOutputTokens;

  return {
    total: { ...cumulativeTokens },
    last,
    modelContextWindow: null,
  };
}

function toAssistantUsageBreakdown(
  lastAssistant: PiAssistantMessage | undefined,
): ThreadEventTokenUsageBreakdown | undefined {
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


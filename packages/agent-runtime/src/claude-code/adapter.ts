/**
 * Claude Code provider adapter.
 *
 * Maps between bb's ProviderAdapter contract and the Claude Code SDK bridge
 * process. The bridge communicates via JSON-RPC over stdin/stdout. The adapter
 * owns event translation: it takes raw `SDKMessage` from the Claude Agent SDK
 * and produces `ThreadEvent[]`.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import type { ModelInfo } from "@anthropic-ai/sdk/resources/models";
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
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
  textBlockSchema,
} from "../shared/tool-arg-schemas.js";
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
  JsonRpcMessage,
  ProviderAdapter,
} from "../provider-adapter.js";

// ---------------------------------------------------------------------------
// Claude Code event and command types
// ---------------------------------------------------------------------------

/** The raw SDK message type from the Claude Agent SDK. */
export type ClaudeCodeEvent = SDKMessage;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);


const STATIC_CLAUDE_CODE_MODELS: AvailableModel[] = [
  {
    id: "claude-sonnet-4-6",
    model: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    description: "Fast, intelligent model for everyday coding tasks",
    supportedReasoningEfforts: [LOW_REASONING_EFFORT, MEDIUM_REASONING_EFFORT, HIGH_REASONING_EFFORT],
    defaultReasoningEffort: "medium",
    isDefault: true,
  },
  {
    id: "claude-opus-4-6",
    model: "claude-opus-4-6",
    displayName: "Claude Opus 4.6",
    description: "Most capable model for complex coding tasks",
    supportedReasoningEfforts: [LOW_REASONING_EFFORT, MEDIUM_REASONING_EFFORT, HIGH_REASONING_EFFORT, XHIGH_REASONING_EFFORT],
    defaultReasoningEffort: "medium",
    isDefault: false,
  },
  {
    id: "claude-haiku-4-5",
    model: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5",
    description: "Fast, compact model for simple tasks",
    supportedReasoningEfforts: [LOW_REASONING_EFFORT, MEDIUM_REASONING_EFFORT],
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

// ---------------------------------------------------------------------------
// Claude Code–specific helpers
// ---------------------------------------------------------------------------

function resolveBridgePath(): string {
  // When running via vitest, __dirname points to src/ where .js doesn't exist.
  // Redirect to dist/ so the bridge is always the compiled JS.
  const dir = __dirname.includes("/src/")
    ? __dirname.replace("/src/", "/dist/")
    : __dirname;
  return resolve(dir, "bridge", "bridge.js");
}

function buildClaudeCodeConfig(envVars?: Record<string, string>): Record<string, unknown> | undefined {
  if (!envVars) return undefined;
  const config: Record<string, unknown> = {};
  const projectId = envVars["BB_PROJECT_ID"];
  const threadId = envVars["BB_THREAD_ID"];
  const serverUrl = envVars["BB_SERVER_URL"];
  const path = envVars["PATH"];
  if (projectId) config["shell_environment_policy.set.BB_PROJECT_ID"] = projectId;
  if (threadId) config["shell_environment_policy.set.BB_THREAD_ID"] = threadId;
  if (serverUrl) config["shell_environment_policy.set.BB_SERVER_URL"] = serverUrl;
  if (path) config["shell_environment_policy.set.PATH"] = path;
  return Object.keys(config).length > 0 ? config : undefined;
}

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

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
        defaultReasoningEffort: supportedReasoningEfforts.some(
          (e) => e.reasoningEffort === "medium",
        )
          ? ("medium" as const)
          : supportedReasoningEfforts[0].reasoningEffort,
        isDefault: false,
      };
    });

  const defaultId = resolveDefaultClaudeModelId(models);
  return models.map((m) => (m.id === defaultId ? { ...m, isDefault: true } : m));
}

async function listClaudeCodeModels(): Promise<AvailableModel[]> {
  if (!shouldFetchClaudeCodeModelsFromAnthropic(process.env)) {
    return [...STATIC_CLAUDE_CODE_MODELS];
  }
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  const client = new Anthropic({ ...(apiKey ? { apiKey } : {}) });
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
  if (shouldUseStaticClaudeModelList(env)) return false;
  return !!env.ANTHROPIC_API_KEY?.trim();
}

function getClaudeReasoningEfforts(modelId: string): ModelReasoningEffort[] {
  if (modelId.startsWith("claude-haiku")) {
    return [LOW_REASONING_EFFORT, MEDIUM_REASONING_EFFORT];
  }
  if (modelId.startsWith("claude-opus-4-6")) {
    return [LOW_REASONING_EFFORT, MEDIUM_REASONING_EFFORT, HIGH_REASONING_EFFORT, XHIGH_REASONING_EFFORT];
  }
  return [LOW_REASONING_EFFORT, MEDIUM_REASONING_EFFORT, HIGH_REASONING_EFFORT];
}

function describeClaudeModel(modelId: string): string {
  if (modelId.startsWith("claude-opus")) return "Most capable Claude model for complex coding tasks";
  if (modelId.startsWith("claude-haiku")) return "Fast Claude model for lightweight coding tasks";
  return "Fast, intelligent Claude model for everyday coding tasks";
}

function resolveDefaultClaudeModelId(models: AvailableModel[]): string | undefined {
  for (const preferred of CLAUDE_DEFAULT_MODEL_PREFERENCES) {
    if (models.some((m) => m.id === preferred)) return preferred;
  }
  return models[0]?.id;
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

/** Options for overriding claude-code adapter defaults. Used by test infrastructure. */
export interface CreateClaudeCodeProviderAdapterOptions {
  /** Override the bridge binary. */
  processCommand?: string;
  /** Override the bridge binary args. */
  processArgs?: string[];
  /** Extra environment variables for the bridge process. */
  launchEnv?: Record<string, string>;
  /** Override model listing. Used by unit tests to avoid real API calls. */
  listModels?: () => Promise<AvailableModel[]>;
}

export function createClaudeCodeProviderAdapter(
  opts?: CreateClaudeCodeProviderAdapterOptions,
): ProviderAdapter {
  const capabilities: ProviderCapabilities = {
    supportsRename: false,
    supportsServiceTier: false,
  };
  const models = opts?.listModels ?? listClaudeCodeModels;

  // Per-thread turn state — the Claude SDK doesn't have turn IDs, so the
  // adapter assigns them. Keyed by threadId so multiple threads sharing
  // one adapter instance don't corrupt each other's counters.
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

    id: "claude-code",
    displayName: "Claude Code",
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
            jsonrpc: "2.0",
            method: "initialize",
            params: { clientInfo: { name: "bb", version: "1.0.0" } },
          };
        case "thread/start": {
          const baseInstructions = resolveBaseInstructions(command.options?.instructions);
          const config = buildClaudeCodeConfig(command.options?.envVars);
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
            jsonrpc: "2.0",
            method: "thread/start",
            params: {
              baseInstructions,
              threadId: command.threadId,
              ...(Object.keys(finalConfig).length > 0 ? { config: finalConfig } : {}),
              ...(command.options?.model ? { model: command.options.model } : {}),
              ...(dynamicTools && dynamicTools.length > 0 ? { dynamicTools } : {}),
            },
          };
        }
        case "thread/resume": {
          const resumeConfig = buildClaudeCodeConfig(command.options?.envVars);
          const finalResumeConfig: Record<string, unknown> = resumeConfig ? { ...resumeConfig } : {};
          if (command.options?.reasoningLevel) {
            finalResumeConfig.model_reasoning_effort = command.options.reasoningLevel;
          }
          return {
            jsonrpc: "2.0",
            method: "thread/resume",
            params: {
              threadId: command.threadId,
              providerThreadId: command.providerThreadId ?? null,
              ...(Object.keys(finalResumeConfig).length > 0 ? { config: finalResumeConfig } : {}),
              ...(command.options?.model ? { model: command.options.model } : {}),
            },
          };
        }
        case "turn/start":
          return {
            jsonrpc: "2.0",
            method: "turn/start",
            params: {
              threadId: command.threadId,
              providerThreadId: command.providerThreadId ?? null,
              input: command.input,
              ...(command.options?.model ? { model: command.options.model } : {}),
              ...(command.options?.reasoningLevel ? { config: { model_reasoning_effort: command.options.reasoningLevel } } : {}),
            },
          };
        case "turn/steer":
          return {
            jsonrpc: "2.0",
            method: "turn/steer",
            params: {
              threadId: command.threadId,
              providerThreadId: command.providerThreadId ?? null,
              expectedTurnId: command.expectedTurnId,
              input: command.input,
            },
          };
        case "thread/stop":
          return null;
        case "thread/name/set":
          return null; // Claude Code doesn't support rename
      }
    },

    // -- Unified event translator ------------------------------------------

    translateEvent(event: unknown, context?: { threadId?: string }): ThreadEvent[] {
      // The runtime passes full JSON-RPC notifications. Unwrap bridge
      // envelope formats so the translation logic sees raw SDK messages.
      const envelope = event as { method?: string; params?: Record<string, unknown> };
      if (envelope.method === "sdk/message") {
        const sdkMessage = envelope.params?.message;
        if (!sdkMessage) return [];
        return this.translateEvent(sdkMessage, context);
      }
      if (envelope.method === "thread/identity") {
        const threadId = (envelope.params?.threadId as string) ?? "";
        const providerThreadId = envelope.params?.providerThreadId as string | undefined;
        if (providerThreadId) {
          return [{ type: "thread/identity", threadId, providerThreadId } as ThreadEvent];
        }
        return [];
      }
      if (envelope.method === "error") {
        const params = envelope.params as { message?: string } | undefined;
        return [{ type: "error", threadId: "", providerThreadId: "", message: params?.message ?? "unknown error" } as ThreadEvent];
      }

      const message = event as ClaudeCodeEvent;
      // threadId is not available from SDKMessage — the bridge/host-daemon
      // supplies it from the session context. We use "" here; the caller
      // overrides it.
      const threadId = "";
      const events: ThreadEvent[] = [];

      // Resolve per-thread turn state using the context threadId.
      const stateKey = context?.threadId ?? "";
      const state = getTurnState(stateKey);

      switch (message.type) {
        case "system":
          // System init — no events emitted
          break;

        case "assistant": {
          if (!state.currentTurnId) {
            state.counter += 1;
            state.currentTurnId = `turn-${state.counter}`;
            events.push({ type: "turn/started", threadId, providerThreadId: "", turnId: state.currentTurnId });
          }

          const text = extractAssistantText(message);
          if (text) {
            events.push({
              type: "item/completed",
              threadId,
              providerThreadId: "",
              turnId: state.currentTurnId,
              item: { type: "agentMessage", id: `msg-${state.counter}`, text },
            });
          }

          const toolUses = extractToolUses(message);
          for (const toolUse of toolUses) {
            events.push({
              type: "item/started",
              threadId,
              providerThreadId: "",
              turnId: state.currentTurnId,
              item: translateToolCallToItem(toolUse.id, toolUse.name, toolUse.input),
            });
          }
          break;
        }

        case "stream_event": {
          const delta = extractStreamTextDelta(message);
          if (delta && state.currentTurnId) {
            events.push({
              type: "item/agentMessage/delta",
              threadId,
              providerThreadId: "",
              turnId: state.currentTurnId,
              delta,
            });
          }
          break;
        }

        case "user": {
          const toolResults = extractToolResults(message);
          for (const result of toolResults) {
            events.push({
              type: "item/completed",
              threadId,
              providerThreadId: "",
              turnId: state.currentTurnId ?? "",
              item: translateToolResultToItem(
                result.toolUseId,
                result.toolName,
                result.content,
              ),
            });
          }
          break;
        }

        case "result": {
          const resultMessage = message as SDKResultMessage;
          if (state.currentTurnId) {
            const tokenUsage = extractTokenUsage(resultMessage, state.cumulativeTokens);
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
              status: resultMessage.subtype.startsWith("error") ? "failed" : "completed",
            });
            state.currentTurnId = undefined;
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
      return decodeProviderToolCallRequest(request.id ?? "", request.method, request.params);
    },

    // -- Provider capabilities ---------------------------------------------

    listModels() {
      return models();
    },
  };
}

// ---------------------------------------------------------------------------
// SDK message parsing — Zod schemas for opaque SDK types
// ---------------------------------------------------------------------------

const toolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});

const toolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  tool_name: z.string().optional(),
  content: z.unknown(),
});

const messageContentSchema = z.object({
  content: z.array(z.object({ type: z.string() }).passthrough()).optional(),
}).passthrough();

const sdkUsageSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
}).passthrough();

const contentBlockDeltaSchema = z.object({
  type: z.literal("content_block_delta"),
  delta: z.object({ type: z.literal("text_delta"), text: z.string() }).passthrough(),
}).passthrough();

const contentBlockStartSchema = z.object({
  type: z.literal("content_block_start"),
  content_block: z.object({ type: z.literal("text"), text: z.string() }).passthrough(),
}).passthrough();

const streamEventSchema = z.union([contentBlockDeltaSchema, contentBlockStartSchema]);

// ---------------------------------------------------------------------------
// SDK message extraction helpers
// ---------------------------------------------------------------------------

function parseMessageContent(
  message: { message: unknown },
): Array<{ type: string } & Record<string, unknown>> {
  const parsed = messageContentSchema.safeParse(message.message);
  return parsed.success ? (parsed.data.content ?? []) : [];
}

function extractAssistantText(
  message: Extract<SDKMessage, { type: "assistant" }>,
): string | undefined {
  const chunks: string[] = [];
  for (const block of parseMessageContent(message)) {
    const text = textBlockSchema.safeParse(block);
    if (text.success) chunks.push(text.data.text);
  }
  const joined = chunks.join("\n").trim();
  return joined.length > 0 ? joined : undefined;
}

function extractToolUses(
  message: Extract<SDKMessage, { type: "assistant" }>,
): Array<{ id: string; name: string; input: unknown }> {
  const uses: Array<{ id: string; name: string; input: unknown }> = [];
  for (const block of parseMessageContent(message)) {
    const tool = toolUseBlockSchema.safeParse(block);
    if (tool.success) uses.push({ id: tool.data.id, name: tool.data.name, input: tool.data.input });
  }
  return uses;
}

function extractStreamTextDelta(
  message: Extract<SDKMessage, { type: "stream_event" }>,
): string | undefined {
  const parsed = streamEventSchema.safeParse(message.event);
  if (!parsed.success) return undefined;

  if (parsed.data.type === "content_block_delta") {
    return parsed.data.delta.text.length > 0 ? parsed.data.delta.text : undefined;
  }
  return parsed.data.content_block.text.length > 0 ? parsed.data.content_block.text : undefined;
}

function extractToolResults(
  message: Extract<SDKMessage, { type: "user" }>,
): Array<{ toolUseId: string; toolName?: string; content: unknown }> {
  const results: Array<{ toolUseId: string; toolName?: string; content: unknown }> = [];
  for (const block of parseMessageContent(message)) {
    const result = toolResultBlockSchema.safeParse(block);
    if (result.success) {
      results.push({
        toolUseId: result.data.tool_use_id,
        toolName: result.data.tool_name,
        content: result.data.content,
      });
    }
  }
  return results;
}

function extractTokenUsage(
  message: SDKResultMessage,
  cumulativeTokens: ThreadEventTokenUsageBreakdown,
): ThreadEventTokenUsage | undefined {
  const parsed = sdkUsageSchema.safeParse(message.usage);
  const last = parsed.success ? toTokenUsageBreakdown(parsed.data) : undefined;
  const modelContextWindow = extractModelContextWindow(message.modelUsage);

  if (!last && modelContextWindow === null) {
    return undefined;
  }

  const emptyBreakdown: ThreadEventTokenUsageBreakdown = {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };

  const current = last ?? emptyBreakdown;

  // Accumulate into the per-thread cumulative total
  cumulativeTokens.totalTokens += current.totalTokens;
  cumulativeTokens.inputTokens += current.inputTokens;
  cumulativeTokens.cachedInputTokens += current.cachedInputTokens;
  cumulativeTokens.outputTokens += current.outputTokens;
  cumulativeTokens.reasoningOutputTokens += current.reasoningOutputTokens;

  return {
    total: { ...cumulativeTokens },
    last: current,
    modelContextWindow,
  };
}

function toTokenUsageBreakdown(
  usage: z.infer<typeof sdkUsageSchema>,
): ThreadEventTokenUsageBreakdown {
  const inputTokens = toNonNegativeNumber(usage.input_tokens);
  const outputTokens = toNonNegativeNumber(usage.output_tokens);
  const cacheReadTokens = toNonNegativeNumber(usage.cache_read_input_tokens);
  const cacheCreationTokens = toNonNegativeNumber(usage.cache_creation_input_tokens);
  const cachedInputTokens = cacheReadTokens + cacheCreationTokens;

  return {
    totalTokens: inputTokens + outputTokens + cachedInputTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens: 0,
  };
}

function extractModelContextWindow(
  modelUsage: Record<string, { contextWindow: number }> | undefined,
): number | null {
  if (!modelUsage) return null;

  let largestContextWindow: number | null = null;
  for (const usage of Object.values(modelUsage)) {
    const contextWindow = toPositiveNumber(usage.contextWindow);
    if (contextWindow === null) continue;
    if (largestContextWindow === null || contextWindow > largestContextWindow) {
      largestContextWindow = contextWindow;
    }
  }

  return largestContextWindow;
}

function toPositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

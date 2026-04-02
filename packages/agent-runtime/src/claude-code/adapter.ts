/**
 * Claude Code provider adapter.
 *
 * Maps between bb's ProviderAdapter contract and the Claude Code SDK bridge
 * process. The bridge communicates via JSON-RPC over stdin/stdout. The adapter
 * owns event translation: it takes raw `SDKMessage` from the Claude Agent SDK
 * and produces `ThreadEvent[]`.
 */

import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type {
  AvailableModel,
  ProviderCapabilities,
  ThreadEvent,
  ThreadEventItem,
  ThreadEventTokenUsage,
  ThreadEventTokenUsageBreakdown,
  ToolCallRequest,
} from "@bb/domain";
import { toPositiveNumber } from "@bb/domain";
import {
  decodeProviderToolCallRequest,
} from "../shared/provider-tool-call-contract.js";
import { resolveBridgePath } from "../shared/bridge-path.js";
import {
  bashArgsSchema,
  textBlockSchema,
} from "../shared/tool-arg-schemas.js";
import {
  buildEditDiff,
  buildShellEnvironmentPolicyConfig,
  extractResultText,
  HIGH_REASONING_EFFORT,
  LOW_REASONING_EFFORT,
  MEDIUM_REASONING_EFFORT,
  XHIGH_REASONING_EFFORT,
  toNonNegativeNumber,
  toOptionalRecord,
  toOptionalString,
  withParentToolCallId,
} from "../shared/adapter-utils.js";
import {
  buildUnhandledProviderEvents,
  createUnhandledProviderEvent,
} from "../shared/provider-unhandled-event.js";
import {
  errorEnvelopeSchema,
  jsonRpcEnvelopeSchema,
  sdkMessageEnvelopeSchema,
  threadIdentityEnvelopeSchema,
} from "../shared/json-rpc-envelope.js";
import type {
  AdapterCommand,
  JsonRpcMessage,
  ProviderTranslationContext,
  ProviderAdapter,
} from "../provider-adapter.js";
import { claudeCodeVisibilityMetadata } from "./visibility.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

function getNestedParentToolUseId(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) {
    return undefined;
  }
  if (!("parent_tool_use_id" in message)) {
    return undefined;
  }
  return typeof message.parent_tool_use_id === "string"
    ? message.parent_tool_use_id
    : undefined;
}

const messageIdSchema = z.object({
  id: z.string(),
});

function getNestedMessageId(message: unknown): string | undefined {
  const parsed = messageIdSchema.safeParse(message);
  return parsed.success ? parsed.data.id : undefined;
}

const claudeFileEditArgsSchema = z.object({
  file_path: z.string().optional(),
  path: z.string().optional(),
  old_string: z.string().optional(),
  new_string: z.string().optional(),
  content: z.string().optional(),
}).passthrough();

const claudeWebSearchArgsSchema = z.object({
  query: z.string().optional(),
  url: z.string().optional(),
}).passthrough();

type ClaudeFileEditArgs = z.infer<typeof claudeFileEditArgsSchema>;
type ClaudePendingFileChangeItem = Extract<ThreadEventItem, { type: "fileChange" }>;

interface ClaudeToolUseTranslationInput {
  callId: string;
  toolName: string;
  args: unknown;
  parentToolCallId?: string;
}

interface ClaudeToolResultTranslationInput {
  callId: string;
  toolName?: string;
  content: unknown;
  isError: boolean;
  parentToolCallId?: string;
  startedItem?: ThreadEventItem;
}

function buildClaudeFileChangeItem(
  args: ClaudeFileEditArgs,
): ClaudePendingFileChangeItem | null {
  const filePath = args.file_path ?? args.path;
  if (!filePath) {
    return null;
  }
  const newText = args.new_string ?? args.content;

  const diff = buildEditDiff(
    filePath,
    args.old_string,
    newText,
  );

  return {
    type: "fileChange",
    id: "",
    changes: [{
      path: filePath,
      kind: args.old_string === undefined ? "add" : "update",
      ...(diff ? { diff } : {}),
    }],
    status: "pending",
  };
}

function translateClaudeToolUseItem(
  input: ClaudeToolUseTranslationInput,
): ThreadEventItem {
  const toolArguments = toOptionalRecord(input.args);
  const baseToolCall = {
    type: "toolCall" as const,
    id: input.callId,
    tool: input.toolName,
    ...(toolArguments ? { arguments: toolArguments } : {}),
    status: "pending" as const,
  };

  switch (input.toolName) {
    case "Bash": {
      const parsed = bashArgsSchema.safeParse(input.args);
      const command = parsed.success
        ? toOptionalString(parsed.data.command)
        : undefined;
      if (!command) {
        return withParentToolCallId(baseToolCall, input.parentToolCallId);
      }
      return withParentToolCallId({
        type: "commandExecution",
        id: input.callId,
        command,
        cwd: parsed.success ? (toOptionalString(parsed.data.cwd) ?? "") : "",
        status: "pending",
      }, input.parentToolCallId);
    }
    case "Edit":
    case "Write": {
      const parsed = claudeFileEditArgsSchema.safeParse(input.args);
      if (!parsed.success) {
        return withParentToolCallId(baseToolCall, input.parentToolCallId);
      }
      const fileChangeItem = buildClaudeFileChangeItem(parsed.data);
      if (!fileChangeItem) {
        return withParentToolCallId({
          ...baseToolCall,
          arguments: parsed.data,
        }, input.parentToolCallId);
      }
      return withParentToolCallId({
        ...fileChangeItem,
        id: input.callId,
      }, input.parentToolCallId);
    }
    case "WebSearch":
    case "WebFetch": {
      const parsed = claudeWebSearchArgsSchema.safeParse(input.args);
      const query = parsed.success
        ? (toOptionalString(parsed.data.query) ?? toOptionalString(parsed.data.url))
        : undefined;
      if (!query) {
        return withParentToolCallId(baseToolCall, input.parentToolCallId);
      }
      return withParentToolCallId({
        type: "webSearch",
        id: input.callId,
        query,
        ...(input.toolName === "WebFetch" ? { action: "fetch" } : {}),
      }, input.parentToolCallId);
    }
    default:
      return withParentToolCallId(baseToolCall, input.parentToolCallId);
  }
}

function translateClaudeToolResultItem(
  input: ClaudeToolResultTranslationInput,
): ThreadEventItem {
  const outputText = extractResultText(input.content);
  const startedItem = input.startedItem;
  const itemStatus = input.isError ? "failed" : "completed";
  const bashExitCode = input.isError ? 1 : 0;

  if (startedItem) {
    switch (startedItem.type) {
      case "commandExecution":
        return withParentToolCallId({
          type: "commandExecution",
          id: input.callId,
          command: startedItem.command,
          cwd: startedItem.cwd,
          aggregatedOutput: outputText,
          exitCode: bashExitCode,
          status: itemStatus,
        }, input.parentToolCallId ?? startedItem.parentToolCallId);
      case "fileChange":
        return withParentToolCallId({
          type: "fileChange",
          id: input.callId,
          changes: startedItem.changes,
          status: itemStatus,
        }, input.parentToolCallId ?? startedItem.parentToolCallId);
      case "webSearch":
        return withParentToolCallId({
          type: "webSearch",
          id: input.callId,
          query: startedItem.query,
          ...(startedItem.action ? { action: startedItem.action } : {}),
          ...(outputText ? { outputText } : {}),
        }, input.parentToolCallId ?? startedItem.parentToolCallId);
      case "toolCall":
        return withParentToolCallId({
          type: "toolCall",
          id: input.callId,
          tool: startedItem.tool,
          arguments: startedItem.arguments,
          status: itemStatus,
          result: outputText,
        }, input.parentToolCallId ?? startedItem.parentToolCallId);
      default:
        break;
    }
  }

  const fallbackToolCall = withParentToolCallId({
    type: "toolCall",
    id: input.callId,
    tool: input.toolName ?? "unknown",
    status: itemStatus,
    result: outputText,
  }, input.parentToolCallId);

  switch (input.toolName) {
    case "Bash":
      return withParentToolCallId({
        type: "commandExecution",
        id: input.callId,
        command: "",
        cwd: "",
        aggregatedOutput: outputText,
        exitCode: bashExitCode,
        status: itemStatus,
      }, input.parentToolCallId);
    case "Edit":
    case "Write":
      return withParentToolCallId({
        type: "fileChange",
        id: input.callId,
        changes: [],
        status: itemStatus,
      }, input.parentToolCallId);
    case "WebSearch":
      return withParentToolCallId({
        type: "webSearch",
        id: input.callId,
        query: "",
        ...(outputText ? { outputText } : {}),
      }, input.parentToolCallId);
    case "WebFetch":
      return withParentToolCallId({
        type: "webSearch",
        id: input.callId,
        query: "",
        action: "fetch",
        ...(outputText ? { outputText } : {}),
      }, input.parentToolCallId);
    default:
      return fallbackToolCall;
  }
}

// ---------------------------------------------------------------------------
// Claude Code–specific helpers
// ---------------------------------------------------------------------------

function buildClaudeCodeConfig(envVars?: Record<string, string>): Record<string, unknown> | undefined {
  const config = buildShellEnvironmentPolicyConfig(envVars);
  return config ? { ...config } : undefined;
}

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

function listClaudeCodeModels(): Promise<AvailableModel[]> {
  return Promise.resolve([...STATIC_CLAUDE_CODE_MODELS]);
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

interface ClaudeTurnState {
  assistantMessageCounter: number;
  counter: number;
  currentTurnId: string | undefined;
  cumulativeTokens: ThreadEventTokenUsageBreakdown;
  openAssistantMessageIdsByScope: Map<string, string>;
  toolItemsByCallId: Map<string, ThreadEventItem>;
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
  const turnState = new Map<string, ClaudeTurnState>();

  function getTurnState(threadId: string): ClaudeTurnState {
    if (!turnState.has(threadId)) {
      turnState.set(threadId, {
        assistantMessageCounter: 0,
        counter: 0,
        currentTurnId: undefined,
        cumulativeTokens: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },

        openAssistantMessageIdsByScope: new Map(),
        toolItemsByCallId: new Map(),
      });
    }
    return turnState.get(threadId)!;
  }

  function toAssistantScopeKey(parentToolCallId: string | undefined): string {
    return parentToolCallId ?? "root";
  }

  function createAssistantMessageId(state: ClaudeTurnState): string {
    state.assistantMessageCounter += 1;
    return `claude-assistant-${state.assistantMessageCounter}`;
  }

  function getOrCreateOpenAssistantMessageId(
    state: ClaudeTurnState,
    parentToolCallId: string | undefined,
  ): string {
    const scopeKey = toAssistantScopeKey(parentToolCallId);
    const existing = state.openAssistantMessageIdsByScope.get(scopeKey);
    if (existing) {
      return existing;
    }

    const itemId = createAssistantMessageId(state);
    state.openAssistantMessageIdsByScope.set(scopeKey, itemId);
    return itemId;
  }

  function resolveCompletedAssistantMessageId(
    state: ClaudeTurnState,
    args: {
      parentToolCallId: string | undefined;
      providerMessageId: string | undefined;
    },
  ): string {
    const scopeKey = toAssistantScopeKey(args.parentToolCallId);
    const existing = state.openAssistantMessageIdsByScope.get(scopeKey);
    if (existing) {
      state.openAssistantMessageIdsByScope.delete(scopeKey);
      return existing;
    }

    return args.providerMessageId ?? createAssistantMessageId(state);
  }

  function ensureTurnStarted(
    events: ThreadEvent[],
    threadId: string,
    state: ClaudeTurnState,
  ): string {
    if (!state.currentTurnId) {
      state.openAssistantMessageIdsByScope.clear();
      state.toolItemsByCallId.clear();

      state.counter += 1;
      state.currentTurnId = `turn-${state.counter}`;
      events.push({
        type: "turn/started",
        threadId,
        providerThreadId: "",
        turnId: state.currentTurnId,
      });
    }
    return state.currentTurnId;
  }

  function translateClaudeEvent(
    event: unknown,
    context?: ProviderTranslationContext,
  ): ThreadEvent[] {
    const sdkEnvelope = sdkMessageEnvelopeSchema.safeParse(event);
    if (sdkEnvelope.success) {
      const sdkMessage = sdkEnvelope.data.params.message;
      const nestedParentToolCallId = getNestedParentToolUseId(sdkMessage);
      const parentToolCallId =
        nestedParentToolCallId
          ? nestedParentToolCallId
          : sdkEnvelope.data.params.parent_tool_use_id ?? context?.parentToolCallId;
      const translated = translateClaudeEvent(sdkMessage, {
        ...context,
        ...(parentToolCallId ? { parentToolCallId } : {}),
      });
      return translated.length > 0
        ? translated
        : buildUnhandledProviderEvents({
            providerId: "claude-code",
            rawEvent: {
              jsonrpc: "2.0",
              method: sdkEnvelope.data.method,
              params: sdkEnvelope.data.params,
            },
            visibilityMetadata: claudeCodeVisibilityMetadata,
            ...(parentToolCallId ? { parentToolCallId } : {}),
          });
    }

    const identityEnvelope = threadIdentityEnvelopeSchema.safeParse(event);
    if (identityEnvelope.success) {
      const { threadId = "", providerThreadId } = identityEnvelope.data.params;
      return providerThreadId
        ? [{ type: "thread/identity", threadId, providerThreadId }]
        : [];
    }

    const errorEnvelope = errorEnvelopeSchema.safeParse(event);
    if (errorEnvelope.success) {
      return [{
        type: "error",
        threadId: "",
        providerThreadId: "",
        message: "Provider error",
        detail: errorEnvelope.data.params?.message ?? "unknown error",
      }];
    }

    const envelope = jsonRpcEnvelopeSchema.safeParse(event);
    if (envelope.success) {
      return buildUnhandledProviderEvents({
        providerId: "claude-code",
        rawEvent: {
          jsonrpc: "2.0",
          method: envelope.data.method,
          ...(envelope.data.params ? { params: envelope.data.params } : {}),
        },
        visibilityMetadata: claudeCodeVisibilityMetadata,
        ...(context?.parentToolCallId
          ? { parentToolCallId: context.parentToolCallId }
          : {}),
      });
    }

    const messageType = claudeSdkMessageTypeSchema.safeParse(event);
    if (!messageType.success) {
      return [];
    }
    // threadId is not available from SDKMessage — the bridge/host-daemon
    // supplies it from the session context. We use "" here; the caller
    // overrides it.
    const threadId = "";
    const events: ThreadEvent[] = [];

    // Resolve per-thread turn state using the context threadId.
    const stateKey = context?.threadId ?? "";
    const state = getTurnState(stateKey);
    const parentToolCallId = context?.parentToolCallId;

    switch (messageType.data.type) {
      case "system": {
        const parsedMessage = claudeSystemMessageSchema.safeParse(event);
        if (!parsedMessage.success) {
          return buildUnexpectedClaudeSdkEvent({ event, context });
        }
        // System init — no events emitted
        return [];
      }

      case "assistant": {
        const parsedMessage = claudeAssistantMessageSchema.safeParse(event);
        if (!parsedMessage.success) {
          return buildUnexpectedClaudeSdkEvent({ event, context });
        }
        const message = parsedMessage.data;
        const turnId = ensureTurnStarted(events, threadId, state);
        const assistantMessageId = getNestedMessageId(message.message);

        const text = extractAssistantText(message);
        if (text) {
          const itemId = resolveCompletedAssistantMessageId(state, {
            parentToolCallId,
            providerMessageId: assistantMessageId,
          });
          events.push({
            type: "item/completed",
            threadId,
            providerThreadId: "",
            turnId,
            item: {
              type: "agentMessage",
              id: itemId,
              text,
              ...(parentToolCallId ? { parentToolCallId } : {}),
            },
          });
        }

        const toolUses = extractToolUses(message);
        for (const toolUse of toolUses) {
          const item = translateClaudeToolUseItem({
            callId: toolUse.id,
            toolName: toolUse.name,
            args: toolUse.input,
            parentToolCallId,
          });
          state.toolItemsByCallId.set(toolUse.id, item);
          events.push({
            type: "item/started",
            threadId,
            providerThreadId: "",
            turnId,
            item,
          });
        }
        break;
      }

      case "stream_event": {
        const parsedMessage = claudeStreamEventMessageSchema.safeParse(event);
        if (!parsedMessage.success) {
          return buildUnexpectedClaudeSdkEvent({ event, context });
        }
        const message = parsedMessage.data;
        const delta = extractStreamTextDelta(message);
        if (delta) {
          const turnId = ensureTurnStarted(events, threadId, state);
          const itemId = getOrCreateOpenAssistantMessageId(state, parentToolCallId);
          events.push({
            type: "item/agentMessage/delta",
            threadId,
            providerThreadId: "",
            turnId,
            itemId,
            delta,
            ...(parentToolCallId ? { parentToolCallId } : {}),
          });
        }
        break;
      }

      case "user": {
        const parsedMessage = claudeUserMessageSchema.safeParse(event);
        if (!parsedMessage.success) {
          return buildUnexpectedClaudeSdkEvent({ event, context });
        }
        const message = parsedMessage.data;
        const toolResults = extractToolResults(message);
        for (const result of toolResults) {
          const startedItem = state.toolItemsByCallId.get(result.toolUseId);
          events.push({
            type: "item/completed",
            threadId,
            providerThreadId: "",
            turnId: state.currentTurnId ?? "",
            item: translateClaudeToolResultItem({
              callId: result.toolUseId,
              content: result.content,
              isError: result.isError,
              toolName: result.toolName,
              startedItem,
              parentToolCallId,
            }),
          });
          state.toolItemsByCallId.delete(result.toolUseId);
        }
        break;
      }

      case "result": {
        const parsedMessage = claudeResultMessageSchema.safeParse(event);
        if (!parsedMessage.success) {
          return buildUnexpectedClaudeSdkEvent({ event, context });
        }
        const message = parsedMessage.data;
        if (state.currentTurnId) {
          const resultErrorText = message.is_error && "result" in message && typeof message.result === "string"
            ? message.result
            : null;
          const tokenUsage = extractTokenUsage(message, state.cumulativeTokens);
          if (tokenUsage) {
            events.push({
              type: "thread/tokenUsage/updated",
              threadId,
              providerThreadId: "",
              turnId: state.currentTurnId,
              tokenUsage,
            });
          }
          if (resultErrorText) {
            events.push({
              type: "error",
              threadId,
              providerThreadId: "",
              turnId: state.currentTurnId,
              message: "Provider error",
              detail: resultErrorText,
            });
          }
          events.push({
            type: "turn/completed",
            threadId,
            providerThreadId: "",
            turnId: state.currentTurnId,
            status:
              message.is_error || message.subtype.startsWith("error")
                ? "failed"
                : "completed",
          });
          state.openAssistantMessageIdsByScope.clear();
          state.toolItemsByCallId.clear();
    
          state.currentTurnId = undefined;
        }
        break;
      }

      case "rate_limit_event":
        return [];

      default:
        return buildUnexpectedClaudeSdkEvent({ event, context });
    }

    return events;
  }

  return {
    // -- Identity & launch -------------------------------------------------

    id: "claude-code",
    displayName: "Claude Code",
    capabilities,
    process: {
      command: opts?.processCommand ?? "node",
      args: opts?.processArgs ?? [resolveBridgePath({
        importMetaUrl: import.meta.url,
        bridgeRelativePath: "bridge/bridge.js",
      })],
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
          const baseInstructions = command.options?.instructions ?? "";
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
          const baseInstructions = command.options?.instructions ?? "";
          const resumeConfig = buildClaudeCodeConfig(command.options?.envVars);
          const finalResumeConfig: Record<string, unknown> = resumeConfig ? { ...resumeConfig } : {};
          if (command.options?.reasoningLevel) {
            finalResumeConfig.model_reasoning_effort = command.options.reasoningLevel;
          }
          const dynamicTools = command.dynamicTools?.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: JSON.parse(JSON.stringify(t.inputSchema)),
          }));
          return {
            jsonrpc: "2.0",
            method: "thread/resume",
            params: {
              baseInstructions,
              threadId: command.threadId,
              providerThreadId: command.providerThreadId ?? null,
              ...(Object.keys(finalResumeConfig).length > 0 ? { config: finalResumeConfig } : {}),
              ...(command.options?.model ? { model: command.options.model } : {}),
              ...(dynamicTools && dynamicTools.length > 0 ? { dynamicTools } : {}),
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

    translateEvent(
      event: unknown,
      context?: ProviderTranslationContext,
    ): ThreadEvent[] {
      return translateClaudeEvent(event, context);
    },

    // -- Tool call codec ---------------------------------------------------

    decodeToolCallRequest(request: JsonRpcMessage): ToolCallRequest | null {
      if (typeof request.id !== "string" && typeof request.id !== "number") {
        return null;
      }
      return decodeProviderToolCallRequest(request.id, request.method, request.params);
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
  is_error: z.boolean().optional(),
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

const claudeModelUsageSchema = z.record(z.string(), z.object({
  contextWindow: z.number(),
}).passthrough());

const contentBlockDeltaSchema = z.object({
  type: z.literal("content_block_delta"),
  delta: z.object({ type: z.literal("text_delta"), text: z.string() }).passthrough(),
}).passthrough();

const contentBlockStartSchema = z.object({
  type: z.literal("content_block_start"),
  content_block: z.object({ type: z.literal("text"), text: z.string() }).passthrough(),
}).passthrough();

const streamEventSchema = z.union([contentBlockDeltaSchema, contentBlockStartSchema]);

const claudeSdkMessageTypeSchema = z.object({
  type: z.enum([
    "assistant",
    "rate_limit_event",
    "result",
    "stream_event",
    "system",
    "user",
  ]),
}).passthrough();

const claudeSystemMessageSchema = z.object({
  type: z.literal("system"),
}).passthrough();

const claudeAssistantMessageSchema = z.object({
  type: z.literal("assistant"),
  message: z.unknown(),
}).passthrough();

const claudeStreamEventMessageSchema = z.object({
  type: z.literal("stream_event"),
  event: z.unknown(),
}).passthrough();

const claudeUserMessageSchema = z.object({
  type: z.literal("user"),
  message: z.unknown(),
}).passthrough();

const claudeResultMessageSchema = z.object({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean().optional(),
  result: z.unknown().optional(),
  usage: z.unknown().optional(),
  modelUsage: z.unknown().optional(),
}).passthrough();

type ClaudeAssistantMessage = z.infer<typeof claudeAssistantMessageSchema>;
type ClaudeResultMessage = z.infer<typeof claudeResultMessageSchema>;
type ClaudeStreamEventMessage = z.infer<typeof claudeStreamEventMessageSchema>;
type ClaudeUserMessage = z.infer<typeof claudeUserMessageSchema>;
type ClaudeMessageContentBlock = NonNullable<z.infer<
  typeof messageContentSchema
>["content"]>[number];

interface ClaudeToolUseBlockData {
  id: string;
  input: unknown;
  name: string;
}

interface ClaudeToolResultBlockData {
  content: unknown;
  isError: boolean;
  toolName?: string;
  toolUseId: string;
}

// ---------------------------------------------------------------------------
// SDK message extraction helpers
// ---------------------------------------------------------------------------

function parseMessageContent(
  message: { message: unknown },
): ClaudeMessageContentBlock[] {
  const parsed = messageContentSchema.safeParse(message.message);
  return parsed.success ? (parsed.data.content ?? []) : [];
}

interface ClaudeUnexpectedSdkEventArgs {
  event: unknown;
  context?: ProviderTranslationContext;
}

function buildUnexpectedClaudeSdkEvent(
  args: ClaudeUnexpectedSdkEventArgs,
): ThreadEvent[] {
  const rawEvent: JsonRpcMessage = {
    jsonrpc: "2.0",
    method: "sdk/message",
    params: {
      ...(args.context?.threadId ? { threadId: args.context.threadId } : {}),
      message: args.event,
    },
  };
  return [
    createUnhandledProviderEvent({
      providerId: "claude-code",
      rawEvent,
      rawType: claudeCodeVisibilityMetadata.describeRawEvent(rawEvent).kind,
      ...(args.context?.parentToolCallId
        ? { parentToolCallId: args.context.parentToolCallId }
        : {}),
    }),
  ];
}

function extractAssistantText(
  message: ClaudeAssistantMessage,
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
  message: ClaudeAssistantMessage,
): ClaudeToolUseBlockData[] {
  const uses: ClaudeToolUseBlockData[] = [];
  for (const block of parseMessageContent(message)) {
    const tool = toolUseBlockSchema.safeParse(block);
    if (tool.success) uses.push({ id: tool.data.id, name: tool.data.name, input: tool.data.input });
  }
  return uses;
}

function extractStreamTextDelta(
  message: ClaudeStreamEventMessage,
): string | undefined {
  const parsed = streamEventSchema.safeParse(message.event);
  if (!parsed.success) return undefined;

  if (parsed.data.type === "content_block_delta") {
    return parsed.data.delta.text.length > 0 ? parsed.data.delta.text : undefined;
  }
  return parsed.data.content_block.text.length > 0 ? parsed.data.content_block.text : undefined;
}

function extractToolResults(
  message: ClaudeUserMessage,
): ClaudeToolResultBlockData[] {
  const results: ClaudeToolResultBlockData[] = [];
  for (const block of parseMessageContent(message)) {
    const result = toolResultBlockSchema.safeParse(block);
    if (result.success) {
      results.push({
        toolUseId: result.data.tool_use_id,
        toolName: result.data.tool_name,
        content: result.data.content,
        isError: result.data.is_error ?? false,
      });
    }
  }
  return results;
}

function extractTokenUsage(
  message: ClaudeResultMessage | SDKResultMessage,
  cumulativeTokens: ThreadEventTokenUsageBreakdown,
): ThreadEventTokenUsage | undefined {
  const parsed = sdkUsageSchema.safeParse(message.usage);
  const last = parsed.success ? toTokenUsageBreakdown(parsed.data) : undefined;
  const parsedModelUsage = claudeModelUsageSchema.safeParse(message.modelUsage);
  const modelContextWindow = parsedModelUsage.success
    ? extractModelContextWindow(parsedModelUsage.data)
    : null;

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
    if (contextWindow === undefined) continue;
    if (largestContextWindow === null || contextWindow > largestContextWindow) {
      largestContextWindow = contextWindow;
    }
  }

  return largestContextWindow;
}

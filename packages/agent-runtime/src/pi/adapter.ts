/**
 * Pi provider adapter.
 *
 * Maps between bb's ProviderAdapter contract and the Pi coding agent bridge
 * process. The bridge owns provider SDK interactions such as model discovery.
 * The adapter owns event translation: it takes raw `AgentSessionEvent` from
 * the Pi SDK and produces `ThreadEvent[]`.
 */

import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { z } from "zod";
import type {
  AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import type {
  ProviderCapabilities,
  ThreadEvent,
  ThreadEventItem,
  ThreadEventTokenUsage,
  ThreadEventTokenUsageBreakdown,
} from "@bb/domain";
import { toPositiveNumber } from "@bb/domain";
import {
  decodeNormalizedProviderToolCallRequest,
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
  toNonNegativeNumber,
  toOptionalRecord,
  toOptionalString,
  withParentToolCallId,
} from "../shared/adapter-utils.js";
import {
  createProviderTurnStateRegistry,
} from "../shared/turn-state.js";
import {
  buildUnhandledProviderEvents,
  createUnhandledProviderEvent,
} from "../shared/provider-unhandled-event.js";
import { parseAvailableModelList } from "../shared/available-models.js";
import {
  errorEnvelopeSchema,
  jsonRpcEnvelopeSchema,
  sdkMessageEnvelopeSchema,
  threadIdentityEnvelopeSchema,
} from "../shared/json-rpc-envelope.js";
import type {
  AdapterCommand,
  AdapterOptions,
  DecodedToolCallRequest,
  JsonRpcMessage,
  ProviderTranslationContext,
  ProviderAdapter,
} from "../provider-adapter.js";
import { toCanonicalPiModelId } from "./model-list.js";
import { piVisibilityMetadata } from "./visibility.js";

// ---------------------------------------------------------------------------
// Pi event and command types
// ---------------------------------------------------------------------------

/** The raw SDK event type from the Pi coding agent. */
export type PiEvent = AgentSessionEvent;

interface PiUnhandledEventArgs {
  rawEvent: JsonRpcMessage;
  parentToolCallId?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

function buildUnhandledPiEvent(
  args: PiUnhandledEventArgs,
): ThreadEvent[] {
  return buildUnhandledProviderEvents({
    providerId: "pi",
    rawEvent: args.rawEvent,
    visibilityMetadata: piVisibilityMetadata,
    ...(args.parentToolCallId ? { parentToolCallId: args.parentToolCallId } : {}),
  });
}

function buildUnexpectedPiSdkEvent(
  rawMessage: unknown,
  context?: ProviderTranslationContext,
): ThreadEvent[] {
  const rawEvent: JsonRpcMessage = {
    jsonrpc: "2.0",
    method: "sdk/message",
    params: {
      ...(context?.threadId ? { threadId: context.threadId } : {}),
      message: rawMessage,
    },
  };
  return [
    createUnhandledProviderEvent({
      providerId: "pi",
      rawEvent,
      rawType: piVisibilityMetadata.describeRawEvent(rawEvent).kind,
      ...(context?.parentToolCallId
        ? { parentToolCallId: context.parentToolCallId }
        : {}),
    }),
  ];
}

interface PiContextWindowModel {
  contextWindow?: number;
  id: string;
  provider: string;
}

const piContextWindowModelSchema = z.object({
  id: z.string(),
  provider: z.string(),
  contextWindow: z.number().optional(),
}).passthrough();

const piContextWindowModelsSchema = z.array(piContextWindowModelSchema);

const piEventTypeSchema = z.object({
  type: z.enum([
    "agent_end",
    "agent_start",
    "message_update",
    "tool_execution_end",
    "tool_execution_start",
    "tool_execution_update",
  ]),
}).passthrough();

const piMessageContentBlockSchema = z.object({
  type: z.string(),
}).passthrough();

const piAssistantUsageSchema = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
  totalTokens: z.number().optional(),
}).passthrough();

const piAssistantMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.array(piMessageContentBlockSchema),
  provider: z.string().optional(),
  model: z.string().optional(),
  usage: piAssistantUsageSchema.optional(),
}).passthrough();

const piConversationMessageSchema = z.object({
  role: z.string(),
  content: z.array(piMessageContentBlockSchema).optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  usage: piAssistantUsageSchema.optional(),
}).passthrough();

const piAgentStartEventSchema = z.object({
  type: z.literal("agent_start"),
}).passthrough();

const piAgentEndEventSchema = z.object({
  type: z.literal("agent_end"),
  messages: z.array(piConversationMessageSchema),
}).passthrough();

const piMessageUpdateEventSchema = z.object({
  type: z.literal("message_update"),
  assistantMessageEvent: z.object({
    type: z.string(),
    delta: z.string().optional(),
  }).passthrough(),
}).passthrough();

const piToolExecutionStartEventSchema = z.object({
  type: z.literal("tool_execution_start"),
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.unknown(),
}).passthrough();

const piToolExecutionEndEventSchema = z.object({
  type: z.literal("tool_execution_end"),
  toolCallId: z.string(),
  toolName: z.string(),
  result: z.unknown(),
  isError: z.boolean(),
}).passthrough();

const piToolExecutionUpdateEventSchema = z.object({
  type: z.literal("tool_execution_update"),
  toolCallId: z.string(),
  toolName: z.string(),
  partialResult: z.unknown(),
}).passthrough();

const piFileEditArgsSchema = z.object({
  path: z.string().optional(),
  oldText: z.string().optional(),
  newText: z.string().optional(),
  content: z.string().optional(),
}).passthrough();

type PiFileEditArgs = z.infer<typeof piFileEditArgsSchema>;
type PiPendingFileChangeItem = Extract<ThreadEventItem, { type: "fileChange" }>;
type PiAssistantMessage = z.infer<typeof piAssistantMessageSchema>;
type PiConversationMessage = z.infer<typeof piConversationMessageSchema>;
type PiToolExecutionUpdateEvent = z.infer<typeof piToolExecutionUpdateEventSchema>;

interface PiToolUseTranslationInput {
  callId: string;
  toolName: string;
  args: unknown;
  parentToolCallId?: string;
}

interface PiToolResultTranslationInput {
  callId: string;
  toolName?: string;
  content: unknown;
  isError: boolean;
  parentToolCallId?: string;
  startedItem?: ThreadEventItem;
}

function buildPiFileChangeItem(
  args: PiFileEditArgs,
): PiPendingFileChangeItem | null {
  if (!args.path) {
    return null;
  }
  const newText = args.newText ?? args.content;

  const diff = buildEditDiff(
    args.path,
    args.oldText,
    newText,
  );

  return {
    type: "fileChange",
    id: "",
    changes: [{
      path: args.path,
      kind: args.oldText === undefined ? "add" : "update",
      ...(diff ? { diff } : {}),
    }],
    status: "pending",
  };
}

function translatePiToolUseItem(
  input: PiToolUseTranslationInput,
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
    case "bash": {
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
    case "edit":
    case "write": {
      const parsed = piFileEditArgsSchema.safeParse(input.args);
      if (!parsed.success) {
        return withParentToolCallId(baseToolCall, input.parentToolCallId);
      }
      const fileChangeItem = buildPiFileChangeItem(parsed.data);
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
    default:
      return withParentToolCallId(baseToolCall, input.parentToolCallId);
  }
}

function translatePiToolResultItem(
  input: PiToolResultTranslationInput,
): ThreadEventItem {
  const outputText = extractResultText(input.content);
  const status = input.isError ? "failed" : "completed";
  const startedItem = input.startedItem;

  if (startedItem) {
    switch (startedItem.type) {
      case "commandExecution":
        return withParentToolCallId({
          type: "commandExecution",
          id: input.callId,
          command: startedItem.command,
          cwd: startedItem.cwd,
          aggregatedOutput: outputText,
          exitCode: input.isError ? 1 : 0,
          status,
        }, input.parentToolCallId ?? startedItem.parentToolCallId);
      case "fileChange":
        return withParentToolCallId({
          type: "fileChange",
          id: input.callId,
          changes: startedItem.changes,
          status,
        }, input.parentToolCallId ?? startedItem.parentToolCallId);
      case "toolCall":
        return withParentToolCallId({
          type: "toolCall",
          id: input.callId,
          tool: startedItem.tool,
          arguments: startedItem.arguments,
          status,
          result: outputText,
        }, input.parentToolCallId ?? startedItem.parentToolCallId);
      default:
        break;
    }
  }

  switch (input.toolName) {
    case "bash":
      return withParentToolCallId({
        type: "commandExecution",
        id: input.callId,
        command: "",
        cwd: "",
        aggregatedOutput: outputText,
        exitCode: input.isError ? 1 : 0,
        status,
      }, input.parentToolCallId);
    case "edit":
    case "write":
      return withParentToolCallId({
        type: "fileChange",
        id: input.callId,
        changes: [],
        status,
      }, input.parentToolCallId);
    default:
      return withParentToolCallId({
        type: "toolCall",
        id: input.callId,
        tool: input.toolName ?? "unknown",
        status,
        result: outputText,
      }, input.parentToolCallId);
  }
}

function buildPiConfig(threadId: string, options?: AdapterOptions): Record<string, unknown> | undefined {
  const config: Record<string, unknown> = {};
  if (threadId) config["shell_environment_policy.set.BB_THREAD_ID"] = threadId;
  const shellEnvironmentConfig = buildShellEnvironmentPolicyConfig(options?.envVars);
  if (shellEnvironmentConfig) {
    Object.assign(config, shellEnvironmentConfig);
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

type PiModelContextWindowLookup = ReadonlyMap<string, number>;

type PiModelContextWindowResolver = (
  lastAssistant: PiAssistantMessage | undefined,
) => number | null;

function createPiModelRegistry(): ModelRegistry {
  return new ModelRegistry(AuthStorage.create());
}

function buildPiModelContextWindowLookup(
  models: readonly PiContextWindowModel[],
): PiModelContextWindowLookup {
  const lookup = new Map<string, number>();
  for (const model of models) {
    const contextWindow = toPositiveNumber(model.contextWindow);
    if (contextWindow === undefined) {
      continue;
    }
    const canonicalId = toCanonicalPiModelId(model.provider, model.id);
    lookup.set(canonicalId, contextWindow);
    if (model.id.includes("/")) {
      lookup.set(model.id, contextWindow);
    }
  }
  return lookup;
}

function createPiModelContextWindowResolver(): PiModelContextWindowResolver {
  return (lastAssistant) => {
    if (!toOptionalString(lastAssistant?.model)) {
      return null;
    }

    // Resolve against a fresh registry so models.json overrides and custom
    // model definitions are reflected without module-level cached state.
    const models = piContextWindowModelsSchema.parse(createPiModelRegistry().getAll());
    const modelContextWindowLookup = buildPiModelContextWindowLookup(models);
    return resolvePiModelContextWindow(lastAssistant, modelContextWindowLookup);
  };
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
  /** Override the directory containing bundled bridge files. */
  bridgeBundleDir?: string;
  /** Extra environment variables for the bridge process. */
  launchEnv?: Record<string, string>;
  /** Override context-window resolution. Used by unit tests to avoid real catalogs. */
  resolveModelContextWindow?: PiModelContextWindowResolver;
}

interface PiTurnState {
  assistantMessageCounter: number;
  counter: number;
  currentTurnId: string | undefined;
  cumulativeTokens: ThreadEventTokenUsageBreakdown;
  openAssistantMessageIdsByScope: Map<string, string>;
  toolItemsByCallId: Map<string, ThreadEventItem>;
}

export function createPiProviderAdapter(
  opts?: CreatePiProviderAdapterOptions,
): ProviderAdapter {
  const capabilities: ProviderCapabilities = {
    supportsRename: false,
    supportsServiceTier: false,
  };
  const resolveModelContextWindow = opts?.resolveModelContextWindow
    ?? createPiModelContextWindowResolver();

  const turnState = createProviderTurnStateRegistry<PiTurnState>({
    createState: () => ({
        assistantMessageCounter: 0,
        counter: 0,
        currentTurnId: undefined,
        cumulativeTokens: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
        openAssistantMessageIdsByScope: new Map(),
        toolItemsByCallId: new Map(),
      }),
  });

  function translatePiEvent(
    event: unknown,
    context?: ProviderTranslationContext,
  ): ThreadEvent[] {
    const sdkEnvelope = sdkMessageEnvelopeSchema.safeParse(event);
    if (sdkEnvelope.success) {
      const parentToolCallId =
        sdkEnvelope.data.params.parent_tool_use_id ?? context?.parentToolCallId;
      const translated = translatePiEvent(sdkEnvelope.data.params.message, {
        ...context,
        ...(parentToolCallId ? { parentToolCallId } : {}),
      });
      return translated.length > 0
        ? translated
        : buildUnhandledPiEvent({
            rawEvent: {
              jsonrpc: "2.0",
              method: sdkEnvelope.data.method,
              params: sdkEnvelope.data.params,
            },
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
      return buildUnhandledPiEvent({
        rawEvent: {
          jsonrpc: "2.0",
          method: envelope.data.method,
          ...(envelope.data.params ? { params: envelope.data.params } : {}),
        },
        parentToolCallId: context?.parentToolCallId,
      });
    }

    const eventType = piEventTypeSchema.safeParse(event);
    if (!eventType.success) {
      return [];
    }
    const threadId = "";
    const events: ThreadEvent[] = [];

    // Resolve per-thread turn state using the context threadId.
    const stateKey = context?.threadId ?? "";
    const state = turnState.getOrCreate({ threadId: stateKey });

    switch (eventType.data.type) {
      case "agent_start": {
        const piEvent = piAgentStartEventSchema.safeParse(event);
        if (!piEvent.success) {
          return buildUnexpectedPiSdkEvent(event, context);
        }
        turnState.ensureTurnStarted({
          events,
          state,
          threadId,
        });
        break;
      }

      case "agent_end": {
        const piEvent = piAgentEndEventSchema.safeParse(event);
        if (!piEvent.success) {
          return buildUnexpectedPiSdkEvent(event, context);
        }
        const lastAssistant = findLastAssistantMessage(piEvent.data.messages);
        if (lastAssistant) {
          const text = extractAssistantText(lastAssistant);
          if (text) {
            const itemId = turnState.resolveCompletedAssistantMessageId({
              assistantIdPrefix: "pi-assistant",
              parentToolCallId: context?.parentToolCallId,
              state,
            });
            events.push({
              type: "item/completed",
              threadId,
              providerThreadId: "",
              turnId: state.currentTurnId ?? "",
              item: { type: "agentMessage", id: itemId, text },
            });
          }
        }
        if (state.currentTurnId) {
          const tokenUsage = extractPiTokenUsage(
            lastAssistant,
            state.cumulativeTokens,
            resolveModelContextWindow,
          );
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
          turnState.finishTurn({ state, threadId: stateKey });
        }
        break;
      }

      case "message_update": {
        const piEvent = piMessageUpdateEventSchema.safeParse(event);
        if (!piEvent.success) {
          return buildUnexpectedPiSdkEvent(event, context);
        }
        const assistantEvent = piEvent.data.assistantMessageEvent;
        if (assistantEvent.type === "text_delta" && state.currentTurnId) {
          const delta = assistantEvent.delta;
          if (delta) {
            const itemId = turnState.getOrCreateAssistantMessageId({
              assistantIdPrefix: "pi-assistant",
              parentToolCallId: context?.parentToolCallId,
              state,
            });
            events.push({
              type: "item/agentMessage/delta",
              threadId,
              providerThreadId: "",
              turnId: state.currentTurnId,
              itemId,
              delta,
            });
          }
        }
        break;
      }

      case "tool_execution_start": {
        const piEvent = piToolExecutionStartEventSchema.safeParse(event);
        if (!piEvent.success) {
          return buildUnexpectedPiSdkEvent(event, context);
        }
        if (!state.currentTurnId) {
          return buildUnexpectedPiSdkEvent(piEvent.data, context);
        }
        // Close any open assistant message scope so the final assistant
        // text at agent_end gets a fresh ID and doesn't overwrite
        // earlier streamed content.
        turnState.resolveCompletedAssistantMessageId({
          assistantIdPrefix: "pi-assistant",
          parentToolCallId: context?.parentToolCallId,
          state,
        });
        const item = translatePiToolUseItem({
          callId: piEvent.data.toolCallId,
          toolName: piEvent.data.toolName,
          args: piEvent.data.args,
          parentToolCallId: context?.parentToolCallId,
        });
        state.toolItemsByCallId.set(piEvent.data.toolCallId, item);
        events.push({
          type: "item/started",
          threadId,
          providerThreadId: "",
          turnId: state.currentTurnId,
          item,
        });
        break;
      }

      case "tool_execution_end": {
        const piEvent = piToolExecutionEndEventSchema.safeParse(event);
        if (!piEvent.success) {
          return buildUnexpectedPiSdkEvent(event, context);
        }
        if (!state.currentTurnId) {
          return buildUnexpectedPiSdkEvent(piEvent.data, context);
        }
        const startedItem = state.toolItemsByCallId.get(piEvent.data.toolCallId);
        events.push({
          type: "item/completed",
          threadId,
          providerThreadId: "",
          turnId: state.currentTurnId,
          item: translatePiToolResultItem({
            callId: piEvent.data.toolCallId,
            toolName: piEvent.data.toolName,
            content: piEvent.data.result,
            isError: piEvent.data.isError,
            startedItem,
            parentToolCallId: context?.parentToolCallId,
          }),
        });
        state.toolItemsByCallId.delete(piEvent.data.toolCallId);
        break;
      }

      case "tool_execution_update": {
        const piEvent = piToolExecutionUpdateEventSchema.safeParse(event);
        if (!piEvent.success) {
          return buildUnexpectedPiSdkEvent(event, context);
        }
        if (!state.currentTurnId) {
          return buildUnexpectedPiSdkEvent(piEvent.data, context);
        }
        events.push({
          type: "item/toolCall/progress",
          threadId,
          providerThreadId: "",
          turnId: state.currentTurnId,
          itemId: piEvent.data.toolCallId,
          message: extractPiToolProgressText(piEvent.data),
          ...(context?.parentToolCallId
            ? { parentToolCallId: context.parentToolCallId }
            : {}),
        });
        break;
      }

      default:
        break;
    }

    return events;
  }

  return {
    // -- Identity & launch -------------------------------------------------

    id: "pi",
    displayName: "Pi",
    capabilities,
    process: {
      command: opts?.processCommand ?? "node",
      args: opts?.processArgs ?? [resolveBridgePath({
        bridgeBundleDir: opts?.bridgeBundleDir,
        bundleFileName: "bb-pi-bridge.mjs",
        importMetaUrl: import.meta.url,
        bridgeRelativePath: "bridge/bridge.js",
      })],
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
        case "model/list":
          return {
            jsonrpc: "2.0",
            method: "model/list",
            params: {},
          };
        case "thread/start": {
          const baseInstructions = command.options?.instructions ?? "";
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
              cwd: command.cwd,
              baseInstructions,
              ...(Object.keys(finalConfig).length > 0 ? { config: finalConfig } : {}),
              ...(command.options?.model ? { model: command.options.model } : {}),
              ...(dynamicTools && dynamicTools.length > 0 ? { dynamicTools } : {}),
            },
          };
        }
        case "thread/resume": {
          const threadId = command.providerThreadId ?? command.threadId;
          const baseInstructions = command.options?.instructions ?? "";
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
            method: "thread/resume",
            params: {
              threadId,
              cwd: command.cwd,
              baseInstructions,
              ...(Object.keys(finalConfig).length > 0 ? { config: finalConfig } : {}),
              ...(command.options?.model ? { model: command.options.model } : {}),
              ...(command.resumePath ? { sessionPath: command.resumePath } : {}),
              ...(dynamicTools && dynamicTools.length > 0 ? { dynamicTools } : {}),
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

    translateEvent(
      event: unknown,
      context?: ProviderTranslationContext,
    ): ThreadEvent[] {
      return translatePiEvent(event, context);
    },

    parseModelListResult(result: unknown) {
      return parseAvailableModelList(result);
    },

    // -- Tool call codec ---------------------------------------------------

    decodeToolCallRequest(request: JsonRpcMessage): DecodedToolCallRequest | null {
      if (typeof request.id !== "string" && typeof request.id !== "number") {
        return null;
      }
      return decodeNormalizedProviderToolCallRequest(
        request.id,
        request.method,
        request.params,
      );
    },

  };
}

// ---------------------------------------------------------------------------
// Pi SDK event extraction helpers
// ---------------------------------------------------------------------------

function findLastAssistantMessage(
  messages: PiConversationMessage[],
): PiAssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const parsedMessage = piAssistantMessageSchema.safeParse(message);
    if (parsedMessage.success) {
      return parsedMessage.data;
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
    const parsedBlock = textBlockSchema.safeParse(block);
    if (parsedBlock.success) {
      chunks.push(parsedBlock.data.text);
    }
  }
  const text = chunks.join("\n").trim();
  return text.length > 0 ? text : undefined;
}

function extractPiTokenUsage(
  lastAssistant: PiAssistantMessage | undefined,
  cumulativeTokens: ThreadEventTokenUsageBreakdown,
  resolveModelContextWindow: PiModelContextWindowResolver,
): ThreadEventTokenUsage | undefined {
  const last = toAssistantUsageBreakdown(lastAssistant);
  if (!last) {
    return undefined;
  }
  const modelContextWindow = resolveModelContextWindow(lastAssistant);

  // Accumulate into the per-thread cumulative total
  cumulativeTokens.totalTokens += last.totalTokens;
  cumulativeTokens.inputTokens += last.inputTokens;
  cumulativeTokens.cachedInputTokens += last.cachedInputTokens;
  cumulativeTokens.outputTokens += last.outputTokens;
  cumulativeTokens.reasoningOutputTokens += last.reasoningOutputTokens;

  return {
    total: { ...cumulativeTokens },
    last,
    modelContextWindow,
  };
}

function resolvePiModelContextWindow(
  lastAssistant: PiAssistantMessage | undefined,
  modelContextWindowLookup: PiModelContextWindowLookup,
): number | null {
  const modelId = toOptionalString(lastAssistant?.model);
  if (!modelId) {
    return null;
  }

  if (modelId.includes("/")) {
    return modelContextWindowLookup.get(modelId) ?? null;
  }

  const providerId = toOptionalString(lastAssistant?.provider);
  if (!providerId) {
    return null;
  }

  const canonicalId = toCanonicalPiModelId(providerId, modelId);
  return modelContextWindowLookup.get(canonicalId) ?? null;
}

function extractPiToolProgressText(
  event: PiToolExecutionUpdateEvent,
): string {
  const text = extractResultText(event.partialResult).trim();
  if (text.length > 0) {
    return text;
  }
  return `${event.toolName} progress update`;
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

/**
 * Claude Code provider adapter.
 *
 * Maps between bb's ProviderAdapter contract and the Claude Code SDK bridge
 * process. The bridge communicates via JSON-RPC over stdin/stdout. The adapter
 * owns event translation: it takes raw `SDKMessage` from the Claude Agent SDK
 * and produces `ThreadEvent[]`.
 */

import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { getBuiltInAgentProviderInfo } from "@bb/agent-providers";
import type {
  ApprovalPendingInteractionPayload,
  PendingInteractionApprovalDecision,
  PendingInteractionApprovalSubject,
  PendingInteractionGrantedPermissionProfile,
  ProviderCapabilities,
  ThreadEvent,
  ThreadEventContextWindowUsage,
  ThreadEventItem,
  ThreadEventTokenUsage,
  ThreadEventTokenUsageBreakdown,
} from "@bb/domain";
import { jsonValueSchema, toPositiveNumber } from "@bb/domain";
import {
  decodeNormalizedProviderToolCallRequest,
} from "../shared/provider-tool-call-contract.js";
import { resolveAdapterPermissionPolicy } from "../shared/permission-policy.js";
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
  buildAcceptedUserMessageEvent,
  drainAcceptedUserMessages,
  queueAcceptedUserMessage,
  type AcceptedUserMessageState,
} from "../shared/accepted-user-messages.js";
import {
  createProviderTurnStateRegistry,
  finishOpenProviderTurn,
  type EnsureProviderTurnStartedArgs,
} from "../shared/turn-state.js";
import {
  getOrCreateScopedItemId,
  resolveCompletedScopedItemId,
} from "../shared/scoped-item-ids.js";
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
  DecodedInteractiveRequest,
  DecodedToolCallRequest,
  JsonRpcMessage,
  ProviderTranslationContext,
  ProviderAdapter,
} from "../provider-adapter.js";
import { ProviderResponseEncodeError } from "../provider-adapter.js";
import {
  buildClaudeSessionPermissionUpdates,
  CLAUDE_PERMISSION_REQUEST_APPROVAL_METHOD,
  isClaudeConcreteFileChangeToolName,
  type ClaudePermissionRequestApprovalParams,
  claudePermissionRequestApprovalParamsSchema,
  toClaudePermissionMode,
} from "./interactive-contract.js";
import {
  claudeAssistantMessageSchema,
  claudeAssistantUsageMessageSchema,
  claudeCompactBoundarySystemMessageSchema,
  claudeFileEditArgsSchema,
  claudeModelUsageSchema,
  claudeResultMessageSchema,
  claudeSdkMessageTypeSchema,
  claudeStatusSystemMessageSchema,
  claudeStreamEventMessageSchema,
  claudeSystemMessageSchema,
  claudeUserMessageSchema,
  claudeWebSearchArgsSchema,
  messageContentSchema,
  messageIdSchema,
  sdkUsageSchema,
  streamEventSchema,
  thinkingBlockSchema,
  toolResultBlockSchema,
  toolUseBlockSchema,
  type ClaudeAssistantMessage,
  type ClaudeFileEditArgs,
  type ClaudeMessageContentBlock,
  type ClaudeResultMessage,
  type ClaudeSdkUsage,
  type ClaudeStreamEventMessage,
  type ClaudeUserMessage,
} from "./schemas.js";
import { claudeCodeVisibilityMetadata } from "./visibility.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

function getNestedMessageId(message: unknown): string | undefined {
  const parsed = messageIdSchema.safeParse(message);
  return parsed.success ? parsed.data.id : undefined;
}

type ClaudePendingFileChangeItem = Extract<ThreadEventItem, { type: "fileChange" }>;

interface ClaudeBashCommand {
  command: string;
  cwd: string | null;
}

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

function parseClaudeBashCommand(input: unknown): ClaudeBashCommand | null {
  const parsed = bashArgsSchema.safeParse(input);
  if (!parsed.success) {
    return null;
  }
  const command = toOptionalString(parsed.data.command);
  if (!command) {
    return null;
  }
  return {
    command,
    cwd: toOptionalString(parsed.data.cwd) ?? null,
  };
}

function getClaudeFileEditPath(args: ClaudeFileEditArgs): string | null {
  return args.file_path ?? args.path ?? null;
}

function buildClaudeFileChangeItem(
  args: ClaudeFileEditArgs,
): ClaudePendingFileChangeItem | null {
  const filePath = getClaudeFileEditPath(args);
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
    approvalStatus: null,
  };
}

function hasClaudeSessionPermissionUpdate(
  args: ClaudePermissionRequestApprovalParams,
): boolean {
  return buildClaudeSessionPermissionUpdates({
    permissions: args.permissions,
    toolName: args.toolName,
  }) !== undefined;
}

function buildClaudeApprovalAvailableDecisions(
  args: ClaudePermissionRequestApprovalParams,
): PendingInteractionApprovalDecision[] {
  return hasClaudeSessionPermissionUpdate(args)
    ? ["allow_once", "allow_for_session", "deny"]
    : ["allow_once", "deny"];
}

function buildClaudeApprovalSubject(
  args: ClaudePermissionRequestApprovalParams,
): PendingInteractionApprovalSubject {
  if (args.toolName === "Bash") {
    const bashCommand = parseClaudeBashCommand(args.input);
    if (bashCommand) {
      return {
        kind: "command",
        itemId: args.itemId,
        command: bashCommand.command,
        cwd: bashCommand.cwd,
        actions: [{
          type: "unknown",
          command: bashCommand.command,
        }],
        sessionGrant: args.permissions,
      };
    }
  }

  if (isClaudeConcreteFileChangeToolName(args.toolName)) {
    const parsed = claudeFileEditArgsSchema.safeParse(args.input);
    if (parsed.success && getClaudeFileEditPath(parsed.data)) {
      return {
        kind: "file_change",
        itemId: args.itemId,
        writeScope: null,
        sessionGrant: args.permissions,
      };
    }
  }

  return {
    kind: "permission_grant",
    itemId: args.itemId,
    toolName: args.toolName,
    permissions: args.permissions,
  };
}

function resolveClaudeGrantedPermissions(
  grantedPermissions: PendingInteractionGrantedPermissionProfile | null,
): PendingInteractionGrantedPermissionProfile {
  if (grantedPermissions === null) {
    throw new ProviderResponseEncodeError(
      "Session approval resolution must include granted permissions",
    );
  }

  return grantedPermissions;
}

function getClaudePermissionUpdateToolName(
  payload: ApprovalPendingInteractionPayload,
): string | null {
  switch (payload.subject.kind) {
    case "command":
      return "Bash";
    case "file_change":
      return null;
    case "permission_grant":
      return payload.subject.toolName;
  }
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
      const bashCommand = parseClaudeBashCommand(input.args);
      if (!bashCommand) {
        return withParentToolCallId(baseToolCall, input.parentToolCallId);
      }
      return withParentToolCallId({
        type: "commandExecution",
        id: input.callId,
        command: bashCommand.command,
        cwd: bashCommand.cwd ?? "",
        status: "pending",
        approvalStatus: null,
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
          approvalStatus: startedItem.approvalStatus,
        }, input.parentToolCallId ?? startedItem.parentToolCallId);
      case "fileChange":
        return withParentToolCallId({
          type: "fileChange",
          id: input.callId,
          changes: startedItem.changes,
          status: itemStatus,
          approvalStatus: startedItem.approvalStatus,
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
        approvalStatus: null,
      }, input.parentToolCallId);
    case "Edit":
    case "Write":
      return withParentToolCallId({
        type: "fileChange",
        id: input.callId,
        changes: [],
        status: itemStatus,
        approvalStatus: null,
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
// Adapter factory
// ---------------------------------------------------------------------------

/** Options for overriding claude-code adapter defaults. Used by test infrastructure. */
export interface CreateClaudeCodeProviderAdapterOptions {
  /** Override the bridge binary. */
  processCommand?: string;
  /** Override the bridge binary args. */
  processArgs?: string[];
  /** Override the directory containing bundled bridge files. */
  bridgeBundleDir?: string;
  /** Extra environment variables for the bridge process. */
  launchEnv?: Record<string, string>;
  /** Prefix for bb-owned turn ids emitted by this adapter instance. */
  turnIdPrefix?: string;
}

interface ClaudeTurnState {
  assistantMessageCounter: number;
  counter: number;
  currentTurnId: string | undefined;
  cumulativeTokens: ThreadEventTokenUsageBreakdown;
  latestRequestContextTokens: number | undefined;
  openAssistantMessageIdsByScope: Map<string, string>;
  openReasoningItemIdsByScope: Map<string, string>;
  pendingAcceptedUserMessages: AcceptedUserMessageState["pendingAcceptedUserMessages"];
  reasoningItemCounter: number;
  selectedModelContextWindow: number | null;
  toolItemsByCallId: Map<string, ThreadEventItem>;
  userMessageCounter: number;
}

interface ClaudeContextWindowUsageArgs {
  fallbackModelContextWindow: number | null;
  latestRequestContextTokens: number | undefined;
  message: ClaudeResultMessage | SDKResultMessage;
}

const DEFAULT_CLAUDE_CONTEXT_WINDOW = 200_000;
const LARGE_CLAUDE_CONTEXT_WINDOW = 1_000_000;

export function createClaudeCodeProviderAdapter(
  opts?: CreateClaudeCodeProviderAdapterOptions,
): ProviderAdapter {
  const providerInfo = getBuiltInAgentProviderInfo("claude-code");
  const capabilities: ProviderCapabilities = {
    supportsRename: providerInfo.capabilities.supportsRename,
    supportsServiceTier: providerInfo.capabilities.supportsServiceTier,
    supportedPermissionModes: providerInfo.capabilities.supportedPermissionModes,
  };

  const turnState = createProviderTurnStateRegistry<ClaudeTurnState>({
    createState: () => ({
      assistantMessageCounter: 0,
      counter: 0,
      currentTurnId: undefined,
      cumulativeTokens: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
      latestRequestContextTokens: undefined,
      openAssistantMessageIdsByScope: new Map(),
      openReasoningItemIdsByScope: new Map(),
      pendingAcceptedUserMessages: [],
      reasoningItemCounter: 0,
      selectedModelContextWindow: null,
      toolItemsByCallId: new Map(),
      userMessageCounter: 0,
    }),
    turnIdPrefix: opts?.turnIdPrefix,
  });

  function setClaudeModelContextWindowHint(
    threadId: string,
    model: string,
  ): void {
    const state = turnState.getOrCreate({ threadId });
    state.selectedModelContextWindow = resolveClaudeModelContextWindowHint(model);
  }

  function ensureClaudeTurnStarted(
    args: EnsureProviderTurnStartedArgs<ClaudeTurnState>,
  ): string {
    const hadOpenTurn = args.state.currentTurnId !== undefined;
    if (!hadOpenTurn) {
      args.state.latestRequestContextTokens = undefined;
    }
    const turnId = turnState.ensureTurnStarted(args);
    if (!hadOpenTurn) {
      drainAcceptedUserMessages({
        events: args.events,
        providerThreadId: "",
        state: args.state,
        threadId: args.threadId,
        turnId,
      });
    }
    return turnId;
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
    const state = turnState.getOrCreate({ threadId: stateKey });
    const parentToolCallId = context?.parentToolCallId;

    switch (messageType.data.type) {
      case "system": {
        const parsedMessage = claudeSystemMessageSchema.safeParse(event);
        if (!parsedMessage.success) {
          return buildUnexpectedClaudeSdkEvent({ event, context });
        }
        const statusMessage = claudeStatusSystemMessageSchema.safeParse(event);
        if (
          statusMessage.success &&
          statusMessage.data.status === "compacting"
        ) {
          const turnId = ensureClaudeTurnStarted({
            events,
            state,
            threadId,
          });
          events.push({
            type: "item/started",
            threadId,
            providerThreadId: "",
            turnId,
            item: {
              type: "contextCompaction",
              id: buildClaudeCompactionItemId(turnId),
            },
          });
          return events;
        }

        const compactBoundaryMessage =
          claudeCompactBoundarySystemMessageSchema.safeParse(event);
        if (compactBoundaryMessage.success) {
          events.push(buildClaudeCompactedEvent(threadId));
          return events;
        }

        // System init / status reset — no events emitted
        return [];
      }

      case "assistant": {
        const parsedMessage = claudeAssistantMessageSchema.safeParse(event);
        if (!parsedMessage.success) {
          return buildUnexpectedClaudeSdkEvent({ event, context });
        }
        const message = parsedMessage.data;
        const turnId = ensureClaudeTurnStarted({
          events,
          state,
          threadId,
        });
        const requestContextTokens = extractClaudeRequestContextTokens(message);
        if (requestContextTokens !== null) {
          state.latestRequestContextTokens = requestContextTokens;
        }
        const assistantMessageId = getNestedMessageId(message.message);

        const thinkingBlocks = extractThinkingBlocks(message);
        for (const thinkingBlock of thinkingBlocks) {
          const itemId = resolveCompletedClaudeReasoningItemId({
            state,
            parentToolCallId,
            contentIndex: thinkingBlock.contentIndex,
          });
          events.push({
            type: "item/completed",
            threadId,
            providerThreadId: "",
            turnId,
            item: withParentToolCallId({
              type: "reasoning",
              id: itemId,
              summary: [],
              content: [thinkingBlock.text],
            }, parentToolCallId),
          });
        }

        const text = extractAssistantText(message);
        if (text) {
          const itemId = turnState.resolveCompletedAssistantMessageId({
            assistantIdPrefix: "claude-assistant",
            state,
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
        const reasoningDelta = extractStreamThinkingDelta(message);
        if (reasoningDelta) {
          const turnId = ensureClaudeTurnStarted({
            events,
            state,
            threadId,
          });
          const itemId = getOrCreateClaudeReasoningItemId({
            state,
            parentToolCallId,
            contentIndex: reasoningDelta.contentIndex,
          });
          events.push({
            type: "item/reasoning/textDelta",
            threadId,
            providerThreadId: "",
            turnId,
            itemId,
            delta: reasoningDelta.delta,
            ...(parentToolCallId ? { parentToolCallId } : {}),
          });
        }

        const textDelta = extractStreamTextDelta(message);
        if (textDelta) {
          const turnId = ensureClaudeTurnStarted({
            events,
            state,
            threadId,
          });
          const itemId = turnState.getOrCreateAssistantMessageId({
            assistantIdPrefix: "claude-assistant",
            parentToolCallId,
            state,
          });
          events.push({
            type: "item/agentMessage/delta",
            threadId,
            providerThreadId: "",
            turnId,
            itemId,
            delta: textDelta.delta,
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
          const contextWindowUsage = extractClaudeContextWindowUsage({
            fallbackModelContextWindow: state.selectedModelContextWindow,
            latestRequestContextTokens: state.latestRequestContextTokens,
            message,
          });
          if (
            contextWindowUsage !== undefined &&
            contextWindowUsage.modelContextWindow !== null
          ) {
            state.selectedModelContextWindow = contextWindowUsage.modelContextWindow;
          }
          const tokenUsage = extractTokenUsage(message, state.cumulativeTokens);
          if (contextWindowUsage) {
            events.push({
              type: "thread/contextWindowUsage/updated",
              threadId,
              providerThreadId: "",
              turnId: state.currentTurnId,
              contextWindowUsage,
            });
          }
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
          turnState.finishTurn({ state, threadId: stateKey });
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

    id: providerInfo.id,
    displayName: providerInfo.displayName,
    capabilities,
    threadStopBehavior: "keep-provider",
    process: {
      command: opts?.processCommand ?? "node",
      args: opts?.processArgs ?? [resolveBridgePath({
        bridgeBundleDir: opts?.bridgeBundleDir,
        bundleFileName: "bb-claude-code-bridge.mjs",
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
        case "model/list":
          return {
            jsonrpc: "2.0",
            method: "model/list",
            params: {},
          };
        case "thread/start": {
          finishOpenProviderTurn({ registry: turnState, threadId: command.threadId });
          const baseInstructions = command.options?.instructions ?? "";
          if (command.options?.model) {
            setClaudeModelContextWindowHint(
              command.threadId,
              command.options.model,
            );
          }
          const config = buildClaudeCodeConfig(command.options?.envVars);
          const finalConfig: Record<string, unknown> = config ? { ...config } : {};
          if (command.options?.reasoningLevel) {
            finalConfig.model_reasoning_effort = command.options.reasoningLevel;
          }
          const dynamicTools = command.dynamicTools?.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: jsonValueSchema.parse(t.inputSchema),
          }));
          const permissionPolicy = resolveAdapterPermissionPolicy(command.options);
          return {
            jsonrpc: "2.0",
            method: "thread/start",
            params: {
              baseInstructions,
              threadId: command.threadId,
              cwd: command.cwd,
              instructionMode: command.instructionMode,
              permissionMode: toClaudePermissionMode(permissionPolicy),
              permissionEscalation: permissionPolicy.permissionEscalation,
              ...(Object.keys(finalConfig).length > 0 ? { config: finalConfig } : {}),
              ...(command.options?.model ? { model: command.options.model } : {}),
              ...(dynamicTools && dynamicTools.length > 0 ? { dynamicTools } : {}),
            },
          };
        }
        case "thread/resume": {
          finishOpenProviderTurn({ registry: turnState, threadId: command.threadId });
          const baseInstructions = command.options?.instructions ?? "";
          if (command.options?.model) {
            setClaudeModelContextWindowHint(
              command.threadId,
              command.options.model,
            );
          }
          const resumeConfig = buildClaudeCodeConfig(command.options?.envVars);
          const finalResumeConfig: Record<string, unknown> = resumeConfig ? { ...resumeConfig } : {};
          if (command.options?.reasoningLevel) {
            finalResumeConfig.model_reasoning_effort = command.options.reasoningLevel;
          }
          const dynamicTools = command.dynamicTools?.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: jsonValueSchema.parse(t.inputSchema),
          }));
          const permissionPolicy = resolveAdapterPermissionPolicy(command.options);
          return {
            jsonrpc: "2.0",
            method: "thread/resume",
            params: {
              baseInstructions,
              threadId: command.threadId,
              cwd: command.cwd,
              providerThreadId: command.providerThreadId ?? null,
              instructionMode: command.instructionMode,
              permissionMode: toClaudePermissionMode(permissionPolicy),
              permissionEscalation: permissionPolicy.permissionEscalation,
              ...(Object.keys(finalResumeConfig).length > 0 ? { config: finalResumeConfig } : {}),
              ...(command.options?.model ? { model: command.options.model } : {}),
              ...(dynamicTools && dynamicTools.length > 0 ? { dynamicTools } : {}),
            },
          };
        }
        case "turn/start":
          if (command.options?.model) {
            setClaudeModelContextWindowHint(
              command.threadId,
              command.options.model,
            );
          }
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
          finishOpenProviderTurn({ registry: turnState, threadId: command.threadId });
          return {
            jsonrpc: "2.0",
            method: "thread/stop",
            params: {
              threadId: command.threadId,
            },
          };
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

    translateAcceptedCommand({ command }) {
      if (
        command.type === "thread/start" ||
        command.type === "thread/resume" ||
        command.type === "thread/stop"
      ) {
        const state = turnState.getOrCreate({ threadId: command.threadId });
        state.pendingAcceptedUserMessages = [];
        return [];
      }

      if (command.type === "turn/start") {
        const state = turnState.getOrCreate({ threadId: command.threadId });
        const turnId = turnState.getCurrentOrLastTurnId({ state });
        if (turnId) {
          return buildAcceptedUserMessageEvent({
            clientRequestSequence: command.clientRequestSequence,
            input: command.input,
            itemIdPrefix: "claude-user",
            providerThreadId: command.providerThreadId ?? "",
            state,
            threadId: command.threadId,
            turnId,
          });
        }
        queueAcceptedUserMessage({
          clientRequestSequence: command.clientRequestSequence,
          input: command.input,
          itemIdPrefix: "claude-user",
          state,
        });
      }

      if (command.type === "turn/steer") {
        const state = turnState.getOrCreate({ threadId: command.threadId });
        return buildAcceptedUserMessageEvent({
          clientRequestSequence: command.clientRequestSequence,
          input: command.input,
          itemIdPrefix: "claude-user",
          providerThreadId: command.providerThreadId ?? "",
          state,
          threadId: command.threadId,
          turnId: command.expectedTurnId,
        });
      }

      return [];
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

    decodeInteractiveRequest(request: JsonRpcMessage): DecodedInteractiveRequest | null {
      if (typeof request.id !== "string" && typeof request.id !== "number") {
        return null;
      }

      switch (request.method) {
        case CLAUDE_PERMISSION_REQUEST_APPROVAL_METHOD: {
          const parsed = claudePermissionRequestApprovalParamsSchema.safeParse(
            request.params,
          );
          if (!parsed.success) {
            return null;
          }
          return {
            requestId: request.id,
            method: request.method,
            threadId: parsed.data.threadId,
            providerThreadId: parsed.data.providerThreadId,
            turnId: parsed.data.turnId,
            payload: {
              subject: buildClaudeApprovalSubject(parsed.data),
              reason: parsed.data.reason,
              availableDecisions: buildClaudeApprovalAvailableDecisions(parsed.data),
            },
          };
        }
        default:
          return null;
      }
    },

    buildInteractiveResponse(args) {
      if (args.resolution.decision === "deny") {
        return {
          kind: "permission_request",
          behavior: "deny",
          message: "Permission request denied",
        };
      }

      if (args.resolution.decision === "allow_once") {
        // Claude canUseTool approvals without updatedPermissions apply only
        // to the current tool request. Session grants are the only scope
        // that should mutate Claude's permission state.
        return {
          kind: "permission_request",
          behavior: "allow",
        };
      }

      const updatedPermissions = buildClaudeSessionPermissionUpdates({
        permissions: resolveClaudeGrantedPermissions(
          args.resolution.grantedPermissions,
        ),
        toolName: getClaudePermissionUpdateToolName(args.request.payload),
      });

      return {
        kind: "permission_request",
        behavior: "allow",
        ...(updatedPermissions === undefined
          ? {}
          : { updatedPermissions }),
      };
    },

  };
}

// ---------------------------------------------------------------------------
// SDK message extraction helpers
// ---------------------------------------------------------------------------

interface ClaudeToolUseBlockData {
  id: string;
  input: unknown;
  name: string;
}

interface ClaudeReasoningBlockData {
  contentIndex: number;
  text: string;
}

interface ClaudeStreamDelta {
  contentIndex: number;
  delta: string;
}

interface ClaudeToolResultBlockData {
  content: unknown;
  isError: boolean;
  toolName?: string;
  toolUseId: string;
}

interface ParseClaudeMessageContentArgs {
  message: unknown;
}

function parseMessageContent(
  message: ParseClaudeMessageContentArgs,
): ClaudeMessageContentBlock[] {
  const parsed = messageContentSchema.safeParse(message.message);
  return parsed.success ? (parsed.data.content ?? []) : [];
}

function buildClaudeCompactionItemId(
  turnId: string,
): string {
  return turnId.length > 0
    ? `claude-compaction-${turnId}`
    : "claude-compaction";
}

function createClaudeReasoningItemId(
  state: ClaudeTurnState,
): string {
  state.reasoningItemCounter += 1;
  return `claude-reasoning-${state.reasoningItemCounter}`;
}

interface ClaudeReasoningItemIdArgs {
  contentIndex: number;
  parentToolCallId?: string;
  state: ClaudeTurnState;
}

function getOrCreateClaudeReasoningItemId(
  args: ClaudeReasoningItemIdArgs,
): string {
  return getOrCreateScopedItemId({
    createItemId: () => createClaudeReasoningItemId(args.state),
    openItemIdsByScope: args.state.openReasoningItemIdsByScope,
    parentToolCallId: args.parentToolCallId,
    scopeId: String(args.contentIndex),
  });
}

function resolveCompletedClaudeReasoningItemId(
  args: ClaudeReasoningItemIdArgs,
): string {
  return resolveCompletedScopedItemId({
    createItemId: () => createClaudeReasoningItemId(args.state),
    openItemIdsByScope: args.state.openReasoningItemIdsByScope,
    parentToolCallId: args.parentToolCallId,
    scopeId: String(args.contentIndex),
  });
}

interface ClaudeUnexpectedSdkEventArgs {
  event: unknown;
  context?: ProviderTranslationContext;
}

function buildClaudeCompactedEvent(
  threadId: string,
): ThreadEvent {
  return {
    type: "thread/compacted",
    threadId,
    providerThreadId: "",
  };
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
): ClaudeStreamDelta | undefined {
  const parsed = streamEventSchema.safeParse(message.event);
  if (!parsed.success) return undefined;

  if (parsed.data.type === "content_block_delta") {
    if (parsed.data.delta.type !== "text_delta") {
      return undefined;
    }
    return parsed.data.delta.text.length > 0
      ? { contentIndex: parsed.data.index, delta: parsed.data.delta.text }
      : undefined;
  }
  if (parsed.data.content_block.type !== "text") {
    return undefined;
  }
  return parsed.data.content_block.text.length > 0
    ? { contentIndex: parsed.data.index, delta: parsed.data.content_block.text }
    : undefined;
}

function extractStreamThinkingDelta(
  message: ClaudeStreamEventMessage,
): ClaudeStreamDelta | undefined {
  const parsed = streamEventSchema.safeParse(message.event);
  if (!parsed.success) return undefined;

  if (parsed.data.type === "content_block_delta") {
    if (parsed.data.delta.type !== "thinking_delta") {
      return undefined;
    }
    return parsed.data.delta.thinking.length > 0
      ? { contentIndex: parsed.data.index, delta: parsed.data.delta.thinking }
      : undefined;
  }
  if (parsed.data.content_block.type !== "thinking") {
    return undefined;
  }
  return parsed.data.content_block.thinking.length > 0
    ? { contentIndex: parsed.data.index, delta: parsed.data.content_block.thinking }
    : undefined;
}

function extractThinkingBlocks(
  message: ClaudeAssistantMessage,
): ClaudeReasoningBlockData[] {
  const thinkingBlocks: ClaudeReasoningBlockData[] = [];
  const content = parseMessageContent(message);
  for (const [contentIndex, block] of content.entries()) {
    const thinkingBlock = thinkingBlockSchema.safeParse(block);
    if (!thinkingBlock.success || thinkingBlock.data.thinking.length === 0) {
      continue;
    }
    thinkingBlocks.push({
      contentIndex,
      text: thinkingBlock.data.thinking,
    });
  }
  return thinkingBlocks;
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

function extractClaudeContextWindowUsage(
  args: ClaudeContextWindowUsageArgs,
): ThreadEventContextWindowUsage | undefined {
  const parsedModelUsage = claudeModelUsageSchema.safeParse(args.message.modelUsage);
  const modelContextWindow = parsedModelUsage.success
    ? extractModelContextWindow(parsedModelUsage.data)
    : args.fallbackModelContextWindow;
  const usedTokens = args.latestRequestContextTokens ?? null;

  if (usedTokens === null && modelContextWindow === null) {
    return undefined;
  }

  return {
    usedTokens,
    modelContextWindow,
    estimated: true,
  };
}

function extractClaudeRequestContextTokens(
  message: ClaudeAssistantMessage,
): number | null {
  const parsedMessage = claudeAssistantUsageMessageSchema.safeParse(message.message);
  if (!parsedMessage.success || !parsedMessage.data.usage) {
    return null;
  }

  return toClaudeCurrentContextTokens(parsedMessage.data.usage);
}

function toTokenUsageBreakdown(
  usage: ClaudeSdkUsage,
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

function toClaudeCurrentContextTokens(
  usage: ClaudeSdkUsage,
): number | null {
  return (
    toNonNegativeNumber(usage.input_tokens) +
    toNonNegativeNumber(usage.cache_read_input_tokens) +
    toNonNegativeNumber(usage.cache_creation_input_tokens)
  );
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

function resolveClaudeModelContextWindowHint(
  selectedModel: string,
): number | null {
  // The Claude SDK probe does not expose structured context-window metadata on
  // ModelInfo, so the selected model identifier is the only fallback hint
  // available when a result omits modelUsage.contextWindow.
  if (selectedModel.endsWith("[1m]")) {
    return LARGE_CLAUDE_CONTEXT_WINDOW;
  }
  if (selectedModel === "default") {
    return null;
  }
  return DEFAULT_CLAUDE_CONTEXT_WINDOW;
}

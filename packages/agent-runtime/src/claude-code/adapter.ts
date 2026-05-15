/**
 * Claude Code provider adapter.
 *
 * Maps between bb's ProviderAdapter contract and the Claude Code SDK bridge
 * process. The bridge communicates via JSON-RPC over stdin/stdout. The adapter
 * owns event translation: it takes raw `SDKMessage` from the Claude Agent SDK
 * and produces `ThreadEvent[]`.
 */

import { getBuiltInAgentProviderInfo } from "@bb/agent-providers";
import type {
  ApprovalPendingInteractionPayload,
  PendingInteractionApprovalDecision,
  PendingInteractionApprovalSubject,
  PendingInteractionGrantedPermissionProfile,
  ProviderCapabilities,
  ThreadEvent,
  ThreadEventItem,
} from "@bb/domain";
import { jsonValueSchema, threadScope } from "@bb/domain";
import { decodeNormalizedProviderToolCallRequest } from "../shared/provider-tool-call-contract.js";
import { resolveAdapterPermissionPolicy } from "../shared/permission-policy.js";
import { resolveBridgeProcessArgs } from "../shared/bridge-path.js";
import { bashArgsSchema } from "../shared/tool-arg-schemas.js";
import {
  buildEditDiff,
  buildShellEnvironmentPolicyConfig,
  extractResultText,
  toOptionalRecord,
  toOptionalString,
  withParentToolCallId,
} from "../shared/adapter-utils.js";
import {
  buildAcceptedUserMessageEvent,
  drainAcceptedUserMessages,
  queueAcceptedUserMessage,
} from "../shared/accepted-user-messages.js";
import {
  createProviderTurnStateRegistry,
  finishOpenProviderTurn,
  type EnsureProviderTurnStartedArgs,
} from "../shared/turn-state.js";
import {
  buildUnhandledProviderEvents,
  createUnhandledProviderEvent,
} from "../shared/provider-unhandled-event.js";
import { UNSTAMPED_THREAD_ID } from "../shared/unstamped-thread-id.js";
import { buildScopedProviderErrorEvents } from "../shared/provider-error-events.js";
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
  ProviderCommandPlan,
  ProviderTranslationContext,
  ProviderAdapter,
  ProviderAdapterFactoryOptions,
} from "../provider-adapter.js";
import { noPreparedProviderCommandDispatch } from "../provider-adapter.js";
import {
  type JsonRpcMessage,
  type ProviderInboundRequest,
  type ProviderRuntimeEvent,
  ProviderResponseEncodeError,
} from "../runtime-json-rpc.js";
import {
  buildClaudeSessionPermissionUpdates,
  CLAUDE_PERMISSION_REQUEST_APPROVAL_METHOD,
  isClaudeConcreteFileChangeToolName,
  type ClaudePermissionRequestApprovalParams,
  claudePermissionRequestApprovalParamsSchema,
  toClaudePermissionMode,
} from "./interactive-contract.js";
import {
  claudeFileEditArgsSchema,
  claudeWebFetchArgsSchema,
  claudeWebSearchArgsSchema,
  type ClaudeFileEditArgs,
  type ClaudeWebFetchArgs,
  type ClaudeWebSearchArgs,
} from "./schemas.js";
import { claudeCodeVisibilityMetadata } from "./visibility.js";
import {
  extractClaudeCommandExecutionOutput,
  getNestedParentToolUseId,
  resolveClaudeModelContextWindowHint,
} from "./sdk-extraction.js";
import {
  translateClaudeSdkMessage,
  type ClaudeToolResultTranslationInput,
  type ClaudeToolUseTranslationInput,
  type ClaudeTurnState,
  type ClaudeUnexpectedSdkEventArgs,
} from "./translate-message.js";

type ClaudePendingFileChangeItem = Extract<
  ThreadEventItem,
  { type: "fileChange" }
>;

interface ClaudeBashCommand {
  command: string;
  cwd: string | null;
}

interface ClaudeNormalizedWebFetch {
  url: string;
  prompt: string | null;
}

interface AdditionalWorkspaceWriteRootsParams {
  additionalWorkspaceWriteRoots: string[];
}

function buildAdditionalWorkspaceWriteRootsParams(
  roots: readonly string[],
): AdditionalWorkspaceWriteRootsParams | undefined {
  return roots.length > 0
    ? { additionalWorkspaceWriteRoots: [...roots] }
    : undefined;
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

  const diff = buildEditDiff(filePath, args.old_string, newText);

  return {
    type: "fileChange",
    id: "",
    changes: [
      {
        path: filePath,
        kind: args.old_string === undefined ? "add" : "update",
        ...(diff ? { diff } : {}),
      },
    ],
    status: "pending",
    approvalStatus: null,
  };
}

function normalizeClaudeWebSearchArgs(
  args: ClaudeWebSearchArgs,
): string[] | null {
  const query = toOptionalString(args.query);
  if (!query) {
    return null;
  }
  return [query];
}

function normalizeClaudeWebFetchArgs(
  args: ClaudeWebFetchArgs,
): ClaudeNormalizedWebFetch | null {
  const url = toOptionalString(args.url);
  if (!url) {
    return null;
  }
  return {
    url,
    prompt: toOptionalString(args.prompt) ?? null,
  };
}

function hasClaudeSessionPermissionUpdate(
  args: ClaudePermissionRequestApprovalParams,
): boolean {
  return (
    buildClaudeSessionPermissionUpdates({
      permissions: args.permissions,
      toolName: args.toolName,
    }) !== undefined
  );
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
        actions: [
          {
            type: "unknown",
            command: bashCommand.command,
          },
        ],
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
      return withParentToolCallId(
        {
          type: "commandExecution",
          id: input.callId,
          command: bashCommand.command,
          cwd: bashCommand.cwd ?? "",
          status: "pending",
          approvalStatus: null,
        },
        input.parentToolCallId,
      );
    }
    case "Edit":
    case "Write": {
      const parsed = claudeFileEditArgsSchema.safeParse(input.args);
      if (!parsed.success) {
        return withParentToolCallId(baseToolCall, input.parentToolCallId);
      }
      const fileChangeItem = buildClaudeFileChangeItem(parsed.data);
      if (!fileChangeItem) {
        return withParentToolCallId(
          {
            ...baseToolCall,
            arguments: parsed.data,
          },
          input.parentToolCallId,
        );
      }
      return withParentToolCallId(
        {
          ...fileChangeItem,
          id: input.callId,
        },
        input.parentToolCallId,
      );
    }
    case "WebSearch":
    case "WebFetch": {
      if (input.toolName === "WebSearch") {
        const parsed = claudeWebSearchArgsSchema.safeParse(input.args);
        if (!parsed.success) {
          return withParentToolCallId(baseToolCall, input.parentToolCallId);
        }
        const normalized = normalizeClaudeWebSearchArgs(parsed.data);
        if (!normalized) {
          return withParentToolCallId(baseToolCall, input.parentToolCallId);
        }
        return withParentToolCallId(
          {
            type: "webSearch",
            id: input.callId,
            queries: normalized,
            resultText: null,
          },
          input.parentToolCallId,
        );
      }

      const parsed = claudeWebFetchArgsSchema.safeParse(input.args);
      if (!parsed.success) {
        return withParentToolCallId(baseToolCall, input.parentToolCallId);
      }
      const normalized = normalizeClaudeWebFetchArgs(parsed.data);
      if (!normalized) {
        return withParentToolCallId(baseToolCall, input.parentToolCallId);
      }
      return withParentToolCallId(
        {
          type: "webFetch",
          id: input.callId,
          url: normalized.url,
          prompt: normalized.prompt,
          pattern: null,
          resultText: null,
        },
        input.parentToolCallId,
      );
    }
    default:
      return withParentToolCallId(baseToolCall, input.parentToolCallId);
  }
}

function translateClaudeToolResultItem(
  input: ClaudeToolResultTranslationInput,
): ThreadEventItem {
  const outputText =
    input.toolName === "Bash" || input.startedItem?.type === "commandExecution"
      ? extractClaudeCommandExecutionOutput({
          content: input.content,
          toolUseResult: input.toolUseResult,
        })
      : extractResultText(input.content);
  const startedItem = input.startedItem;
  const itemStatus = input.isError ? "failed" : "completed";
  const bashExitCode = input.isError ? 1 : 0;

  if (startedItem) {
    switch (startedItem.type) {
      case "commandExecution":
        return withParentToolCallId(
          {
            type: "commandExecution",
            id: input.callId,
            command: startedItem.command,
            cwd: startedItem.cwd,
            ...(outputText === undefined
              ? {}
              : { aggregatedOutput: outputText }),
            exitCode: bashExitCode,
            status: itemStatus,
            approvalStatus: startedItem.approvalStatus,
          },
          input.parentToolCallId ?? startedItem.parentToolCallId,
        );
      case "fileChange":
        return withParentToolCallId(
          {
            type: "fileChange",
            id: input.callId,
            changes: startedItem.changes,
            status: itemStatus,
            approvalStatus: startedItem.approvalStatus,
          },
          input.parentToolCallId ?? startedItem.parentToolCallId,
        );
      case "webSearch":
        return withParentToolCallId(
          {
            type: "webSearch",
            id: input.callId,
            queries: startedItem.queries,
            resultText: outputText ?? null,
          },
          input.parentToolCallId ?? startedItem.parentToolCallId,
        );
      case "webFetch":
        return withParentToolCallId(
          {
            type: "webFetch",
            id: input.callId,
            url: startedItem.url,
            prompt: startedItem.prompt,
            pattern: startedItem.pattern,
            resultText: outputText ?? null,
          },
          input.parentToolCallId ?? startedItem.parentToolCallId,
        );
      case "toolCall":
        return withParentToolCallId(
          {
            type: "toolCall",
            id: input.callId,
            tool: startedItem.tool,
            arguments: startedItem.arguments,
            status: itemStatus,
            result: outputText,
          },
          input.parentToolCallId ?? startedItem.parentToolCallId,
        );
      default:
        break;
    }
  }

  const fallbackToolCall = withParentToolCallId(
    {
      type: "toolCall",
      id: input.callId,
      tool: input.toolName ?? "unknown",
      status: itemStatus,
      result: outputText,
    },
    input.parentToolCallId,
  );

  switch (input.toolName) {
    case "Bash":
      return withParentToolCallId(
        {
          type: "commandExecution",
          id: input.callId,
          command: "",
          cwd: "",
          ...(outputText === undefined ? {} : { aggregatedOutput: outputText }),
          exitCode: bashExitCode,
          status: itemStatus,
          approvalStatus: null,
        },
        input.parentToolCallId,
      );
    case "Edit":
    case "Write":
      return withParentToolCallId(
        {
          type: "fileChange",
          id: input.callId,
          changes: [],
          status: itemStatus,
          approvalStatus: null,
        },
        input.parentToolCallId,
      );
    case "WebSearch":
    case "WebFetch":
      return fallbackToolCall;
    default:
      return fallbackToolCall;
  }
}

// ---------------------------------------------------------------------------
// Claude Code–specific helpers
// ---------------------------------------------------------------------------

function buildClaudeCodeConfig(
  envVars?: Record<string, string>,
): Record<string, unknown> | undefined {
  const config = buildShellEnvironmentPolicyConfig(envVars);
  return config ? { ...config } : undefined;
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

/** Options for overriding claude-code adapter defaults. Used by test infrastructure. */
export interface CreateClaudeCodeProviderAdapterOptions extends ProviderAdapterFactoryOptions {
  /** Override the bridge binary. */
  processCommand?: string;
  /** Override the bridge binary args. */
  processArgs?: string[];
  /** Override the directory containing bundled bridge files. */
  bridgeBundleDir?: string;
  /** Prefix for bb-owned turn ids emitted by this adapter instance. */
  turnIdPrefix?: string;
}

interface TranslateClaudeErrorEnvelopeArgs {
  context?: ProviderTranslationContext;
  detail: string;
}

interface ResolveClaudeInteractiveRequestTurnIdArgs {
  threadId: string;
  turnId: string | null;
}

export function createClaudeCodeProviderAdapter(
  opts?: CreateClaudeCodeProviderAdapterOptions,
): ProviderAdapter {
  const additionalWorkspaceWriteRoots =
    opts?.additionalWorkspaceWriteRoots ?? [];
  const providerInfo = getBuiltInAgentProviderInfo("claude-code");
  const capabilities: ProviderCapabilities = {
    supportsArchive: providerInfo.capabilities.supportsArchive,
    supportsRename: providerInfo.capabilities.supportsRename,
    supportsServiceTier: providerInfo.capabilities.supportsServiceTier,
    supportedPermissionModes:
      providerInfo.capabilities.supportedPermissionModes,
  };

  const turnState = createProviderTurnStateRegistry<ClaudeTurnState>({
    createState: () => ({
      assistantMessageCounter: 0,
      counter: 0,
      currentTurnId: undefined,
      cumulativeTokens: {
        totalTokens: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
      latestRequestContextTokens: undefined,
      openAssistantMessageIdsByScope: new Map(),
      openReasoningItemIdsByScope: new Map(),
      pendingAcceptedUserMessages: [],
      reasoningItemCounter: 0,
      selectedModelContextWindow: null,
      toolItemsByCallId: new Map(),
    }),
    turnIdPrefix: opts?.turnIdPrefix,
  });

  function setClaudeModelContextWindowHint(
    threadId: string,
    model: string,
  ): void {
    const state = turnState.getOrCreate({ threadId });
    state.selectedModelContextWindow =
      resolveClaudeModelContextWindowHint(model);
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

  function translateClaudeErrorEnvelope(
    args: TranslateClaudeErrorEnvelopeArgs,
  ): ThreadEvent[] {
    return buildScopedProviderErrorEvents({
      contextThreadId: args.context?.threadId,
      detail: args.detail,
      ensureTurnStarted: ensureClaudeTurnStarted,
      registry: turnState,
    });
  }

  function resolveClaudeInteractiveRequestTurnId(
    args: ResolveClaudeInteractiveRequestTurnIdArgs,
  ): string | null {
    if (args.turnId !== null) {
      return args.turnId;
    }

    const state = turnState.get({ threadId: args.threadId });
    if (state === null) {
      return null;
    }
    const currentTurnId = turnState.getCurrentOrLastTurnId({ state });
    return currentTurnId.length > 0 ? currentTurnId : null;
  }

  function resolveClaudeActiveTurnId(
    context?: ProviderTranslationContext,
  ): string | undefined {
    if (!context?.threadId) {
      return undefined;
    }
    return turnState.get({ threadId: context.threadId })?.currentTurnId;
  }

  function translateClaudeEvent(
    event: unknown,
    context?: ProviderTranslationContext,
  ): ThreadEvent[] {
    const sdkEnvelope = sdkMessageEnvelopeSchema.safeParse(event);
    if (sdkEnvelope.success) {
      const sdkMessage = sdkEnvelope.data.params.message;
      const nestedParentToolCallId = getNestedParentToolUseId(sdkMessage);
      const parentToolCallId = nestedParentToolCallId
        ? nestedParentToolCallId
        : (sdkEnvelope.data.params.parent_tool_use_id ??
          context?.parentToolCallId);
      const translated = translateClaudeEvent(sdkMessage, {
        ...context,
        ...(parentToolCallId ? { parentToolCallId } : {}),
      });
      const fallbackTurnId = resolveClaudeActiveTurnId(context);
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
            ...(fallbackTurnId ? { turnId: fallbackTurnId } : {}),
            ...(parentToolCallId ? { parentToolCallId } : {}),
          });
    }

    const identityEnvelope = threadIdentityEnvelopeSchema.safeParse(event);
    if (identityEnvelope.success) {
      const { threadId = UNSTAMPED_THREAD_ID, providerThreadId } =
        identityEnvelope.data.params;
      return providerThreadId
        ? [
            {
              type: "thread/identity",
              threadId,
              providerThreadId,
              scope: threadScope(),
            },
          ]
        : [];
    }

    const errorEnvelope = errorEnvelopeSchema.safeParse(event);
    if (errorEnvelope.success) {
      return translateClaudeErrorEnvelope({
        context,
        detail: errorEnvelope.data.params?.message ?? "unknown error",
      });
    }

    const envelope = jsonRpcEnvelopeSchema.safeParse(event);
    if (envelope.success) {
      const fallbackTurnId = resolveClaudeActiveTurnId(context);
      return buildUnhandledProviderEvents({
        providerId: "claude-code",
        rawEvent: {
          jsonrpc: "2.0",
          method: envelope.data.method,
          ...(envelope.data.params ? { params: envelope.data.params } : {}),
        },
        visibilityMetadata: claudeCodeVisibilityMetadata,
        ...(fallbackTurnId ? { turnId: fallbackTurnId } : {}),
        ...(context?.parentToolCallId
          ? { parentToolCallId: context.parentToolCallId }
          : {}),
      });
    }

    return translateClaudeSdkMessage({
      buildUnexpectedSdkEvent: buildUnexpectedClaudeSdkEvent,
      context,
      ensureTurnStarted: ensureClaudeTurnStarted,
      event,
      translateToolResultItem: translateClaudeToolResultItem,
      translateToolUseItem: translateClaudeToolUseItem,
      turnState,
    });
  }

  return {
    // -- Identity & launch -------------------------------------------------

    id: providerInfo.id,
    displayName: providerInfo.displayName,
    capabilities,
    process: {
      command: opts?.processCommand ?? "node",
      args:
        opts?.processArgs ??
        resolveBridgeProcessArgs({
          bridgeBundleDir: opts?.bridgeBundleDir,
          bundleFileName: "bb-claude-code-bridge.mjs",
          importMetaUrl: import.meta.url,
          bridgeRelativePath: "bridge/bridge.js",
        }),
    },

    // -- Unified command builder -------------------------------------------

    buildCommandPlan(command: AdapterCommand): ProviderCommandPlan {
      switch (command.type) {
        case "initialize":
          return {
            kind: "request",
            method: "initialize",
            params: { clientInfo: { name: "bb", version: "1.0.0" } },
          };
        case "model/list":
          return {
            kind: "request",
            method: "model/list",
            params: {},
          };
        case "thread/start": {
          finishOpenProviderTurn({
            registry: turnState,
            threadId: command.threadId,
          });
          const baseInstructions = command.options?.instructions ?? "";
          if (command.options?.model) {
            setClaudeModelContextWindowHint(
              command.threadId,
              command.options.model,
            );
          }
          const config = buildClaudeCodeConfig(command.options?.envVars);
          const dynamicTools = command.dynamicTools?.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: jsonValueSchema.parse(t.inputSchema),
          }));
          const permissionPolicy = resolveAdapterPermissionPolicy(
            command.options,
          );
          const additionalWorkspaceWriteRootsParams =
            permissionPolicy.permissionMode === "workspace-write"
              ? buildAdditionalWorkspaceWriteRootsParams(
                  additionalWorkspaceWriteRoots,
                )
              : undefined;
          return {
            kind: "request",
            method: "thread/start",
            params: {
              baseInstructions,
              threadId: command.threadId,
              cwd: command.cwd,
              instructionMode: command.instructionMode,
              permissionMode: toClaudePermissionMode(permissionPolicy),
              permissionEscalation: permissionPolicy.permissionEscalation,
              ...(additionalWorkspaceWriteRootsParams
                ? additionalWorkspaceWriteRootsParams
                : {}),
              ...(config ? { config } : {}),
              ...(command.options?.model
                ? { model: command.options.model }
                : {}),
              ...(command.options?.reasoningLevel
                ? { reasoningLevel: command.options.reasoningLevel }
                : {}),
              ...(dynamicTools && dynamicTools.length > 0
                ? { dynamicTools }
                : {}),
              ...(command.disallowedTools && command.disallowedTools.length > 0
                ? { disallowedTools: [...command.disallowedTools] }
                : {}),
            },
          };
        }
        case "thread/resume": {
          finishOpenProviderTurn({
            registry: turnState,
            threadId: command.threadId,
          });
          const baseInstructions = command.options?.instructions ?? "";
          if (command.options?.model) {
            setClaudeModelContextWindowHint(
              command.threadId,
              command.options.model,
            );
          }
          const resumeConfig = buildClaudeCodeConfig(command.options?.envVars);
          const dynamicTools = command.dynamicTools?.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: jsonValueSchema.parse(t.inputSchema),
          }));
          const permissionPolicy = resolveAdapterPermissionPolicy(
            command.options,
          );
          const additionalWorkspaceWriteRootsParams =
            permissionPolicy.permissionMode === "workspace-write"
              ? buildAdditionalWorkspaceWriteRootsParams(
                  additionalWorkspaceWriteRoots,
                )
              : undefined;
          return {
            kind: "request",
            method: "thread/resume",
            params: {
              baseInstructions,
              threadId: command.threadId,
              cwd: command.cwd,
              providerThreadId: command.providerThreadId,
              instructionMode: command.instructionMode,
              permissionMode: toClaudePermissionMode(permissionPolicy),
              permissionEscalation: permissionPolicy.permissionEscalation,
              ...(additionalWorkspaceWriteRootsParams
                ? additionalWorkspaceWriteRootsParams
                : {}),
              ...(resumeConfig ? { config: resumeConfig } : {}),
              ...(command.options?.model
                ? { model: command.options.model }
                : {}),
              ...(command.options?.reasoningLevel
                ? { reasoningLevel: command.options.reasoningLevel }
                : {}),
              ...(dynamicTools && dynamicTools.length > 0
                ? { dynamicTools }
                : {}),
              ...(command.disallowedTools && command.disallowedTools.length > 0
                ? { disallowedTools: [...command.disallowedTools] }
                : {}),
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
            kind: "request",
            method: "turn/start",
            params: {
              threadId: command.threadId,
              providerThreadId: command.providerThreadId,
              input: command.input,
              ...(command.options?.model
                ? { model: command.options.model }
                : {}),
            },
          };
        case "turn/steer":
          return {
            kind: "request",
            method: "turn/steer",
            params: {
              threadId: command.threadId,
              providerThreadId: command.providerThreadId,
              expectedTurnId: command.expectedTurnId,
              input: command.input,
            },
          };
        case "thread/stop":
          finishOpenProviderTurn({
            registry: turnState,
            threadId: command.threadId,
          });
          return {
            kind: "request",
            method: "thread/stop",
            params: {
              threadId: command.threadId,
            },
          };
        case "thread/name/set":
          return { kind: "noop", reason: "rename unsupported" };
        case "thread/archive":
        case "thread/unarchive":
          return { kind: "noop", reason: "archive unsupported" };
      }
    },

    // -- Unified event translator ------------------------------------------

    translateEvent(
      event: ProviderRuntimeEvent,
      context?: ProviderTranslationContext,
    ): ThreadEvent[] {
      return translateClaudeEvent(event, context);
    },

    prepareTurnStart: noPreparedProviderCommandDispatch,

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
            clientRequestId: command.clientRequestId,
            providerThreadId: command.providerThreadId,
            threadId: command.threadId,
            turnId,
          });
        }
        queueAcceptedUserMessage({
          clientRequestId: command.clientRequestId,
          state,
        });
      }

      if (command.type === "turn/steer") {
        return buildAcceptedUserMessageEvent({
          clientRequestId: command.clientRequestId,
          providerThreadId: command.providerThreadId,
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

    decodeToolCallRequest(
      request: ProviderInboundRequest,
    ): DecodedToolCallRequest | null {
      if (typeof request.id !== "string" && typeof request.id !== "number") {
        return null;
      }
      return decodeNormalizedProviderToolCallRequest(
        request.id,
        request.method,
        request.params,
      );
    },

    decodeInteractiveRequest(
      request: ProviderInboundRequest,
    ): DecodedInteractiveRequest | null {
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
          const turnId = resolveClaudeInteractiveRequestTurnId({
            threadId: parsed.data.threadId,
            turnId: parsed.data.turnId,
          });
          if (turnId === null) {
            return null;
          }
          return {
            requestId: request.id,
            method: request.method,
            threadId: parsed.data.threadId,
            providerThreadId: parsed.data.providerThreadId,
            turnId,
            payload: {
              subject: buildClaudeApprovalSubject(parsed.data),
              reason: parsed.data.reason,
              availableDecisions: buildClaudeApprovalAvailableDecisions(
                parsed.data,
              ),
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
          decisionClassification: "user_reject",
        };
      }

      if (args.resolution.decision === "allow_once") {
        // Claude canUseTool approvals without updatedPermissions apply only
        // to the current tool request. Session grants are the only scope
        // that should mutate Claude's permission state.
        return {
          kind: "permission_request",
          behavior: "allow",
          decisionClassification: "user_temporary",
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
        decisionClassification: "user_permanent",
        ...(updatedPermissions === undefined ? {} : { updatedPermissions }),
      };
    },
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
      ...(args.turnId ? { turnId: args.turnId } : {}),
      ...(args.context?.parentToolCallId
        ? { parentToolCallId: args.context.parentToolCallId }
        : {}),
    }),
  ];
}

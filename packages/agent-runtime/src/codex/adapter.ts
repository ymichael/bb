/**
 * Codex provider adapter.
 *
 * Maps between bb's ProviderAdapter contract and the OpenAI Codex app-server
 * JSON-RPC protocol. Validates the outer JSON-RPC envelope before translating
 * the provider-specific payloads.
 *
 * Reference: https://github.com/openai/codex (codex-rs/app-server-protocol/)
 */

import { getBuiltInAgentProviderInfo } from "@bb/agent-providers";
import { jsonValueSchema } from "@bb/domain";
import type {
  PermissionEscalation,
  PromptInput,
  ProviderCapabilities,
  ServiceTier,
  ThreadEvent,
  ThreadEventContextWindowUsage,
  ThreadEventItem,
  ThreadEventItemStatus,
  ThreadEventTurnStatus,
  ThreadEventUserContent,
} from "@bb/domain";
import type { ClientRequest as CodexClientRequest } from "./generated/codex-app-server/schema/ClientRequest.js";
import type { JsonValue } from "./generated/codex-app-server/schema/serde_json/JsonValue.js";
import type { ServerNotification as CodexServerNotification } from "./generated/codex-app-server/schema/ServerNotification.js";
import type { SandboxPolicy } from "./generated/codex-app-server/schema/v2/SandboxPolicy.js";
import type { DynamicToolSpec } from "./generated/codex-app-server/schema/v2/DynamicToolSpec.js";
import type { CommandExecutionRequestApprovalResponse } from "./generated/codex-app-server/schema/v2/CommandExecutionRequestApprovalResponse.js";
import type { FileChangeRequestApprovalResponse } from "./generated/codex-app-server/schema/v2/FileChangeRequestApprovalResponse.js";
import type { PermissionsRequestApprovalResponse } from "./generated/codex-app-server/schema/v2/PermissionsRequestApprovalResponse.js";
import type { SandboxMode as CodexSandboxMode } from "./generated/codex-app-server/schema/v2/SandboxMode.js";
import type { ThreadResumeParams } from "./generated/codex-app-server/schema/v2/ThreadResumeParams.js";
import type { ThreadStartParams } from "./generated/codex-app-server/schema/v2/ThreadStartParams.js";
import type { UserInput as CodexUserInput } from "./generated/codex-app-server/schema/v2/UserInput.js";
import type { AskForApproval } from "./generated/codex-app-server/schema/v2/AskForApproval.js";
import { parseModelsResponse } from "./models.js";
import {
  buildShellEnvironmentPolicyConfig,
  toOptionalRecord,
} from "../shared/adapter-utils.js";
import {
  decodeNativeProviderToolCallRequest,
} from "../shared/provider-tool-call-contract.js";
import { resolveAdapterPermissionPolicy } from "../shared/permission-policy.js";
import { createUnhandledProviderEvent } from "../shared/provider-unhandled-event.js";
import type {
  AdapterCommand,
  AdapterOptions,
  DecodedInteractiveRequest,
  DecodedToolCallRequest,
  JsonRpcMessage,
  ProviderAdapter,
  ProviderTranslationContext,
} from "../provider-adapter.js";
import {
  parseCodexAvailableDecisions,
  pendingInteractionToCodexFileChangeApprovalDecision,
  toCodexCommandApprovalDecision,
  toCodexGrantedPermissionProfile,
  toPendingInteractionGrantablePermissionProfile,
  toPendingInteractionPermissionProfile,
} from "./permission-mapping.js";
import {
  codexBridgeEnvelopeSchema,
  codexCommandExecutionRequestApprovalParamsSchema,
  codexFileChangeRequestApprovalParamsSchema,
  codexHandledEventSchema,
  codexHandledThreadItemSchema,
  codexPermissionsRequestApprovalParamsSchema,
  isHandledCodexMethod,
  type CodexDynamicToolCallContentItem,
  type CodexHandledEvent,
  type CodexHandledThreadItem,
  type CodexItemStatus,
  type CodexParsedUserInput,
  type CodexTurnStatus,
} from "./schemas.js";
import { codexVisibilityMetadata } from "./visibility.js";

function assertNever(value: never, message?: string): never {
  throw new Error(message ?? `Unexpected value: ${String(value)}`);
}

interface CodexLastTokenUsage {
  totalTokens: number;
}

function toCodexContextWindowUsage(
  lastTokenUsage: CodexLastTokenUsage,
  modelContextWindow: number | null,
): ThreadEventContextWindowUsage {
  return {
    usedTokens: lastTokenUsage.totalTokens,
    modelContextWindow,
    estimated: false,
  };
}

interface CodexPermissionSettings {
  approvalPolicy: AskForApproval;
  sandbox: CodexSandboxMode;
  sandboxPolicy: SandboxPolicy;
}

function toWorkspaceWriteCodexSandboxPolicy(): SandboxPolicy {
  return {
    type: "workspaceWrite",
    writableRoots: [],
    readOnlyAccess: { type: "fullAccess" },
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function toReadonlyCodexSandboxPolicy(): SandboxPolicy {
  return {
    type: "readOnly",
    access: { type: "fullAccess" },
    networkAccess: false,
  };
}

function toEscalationApprovalPolicy(
  escalation: PermissionEscalation,
): AskForApproval {
  return escalation === "deny" ? "never" : "on-request";
}

function toCodexPermissionSettings(
  options: AdapterOptions,
): CodexPermissionSettings {
  const permissionPolicy = resolveAdapterPermissionPolicy(options);
  switch (permissionPolicy.permissionMode) {
    case "readonly":
      return {
        approvalPolicy: toEscalationApprovalPolicy(
          permissionPolicy.permissionEscalation,
        ),
        sandbox: "read-only",
        sandboxPolicy: toReadonlyCodexSandboxPolicy(),
      };
    case "workspace-write":
      return {
        approvalPolicy: toEscalationApprovalPolicy(
          permissionPolicy.permissionEscalation,
        ),
        sandbox: "workspace-write",
        sandboxPolicy: toWorkspaceWriteCodexSandboxPolicy(),
      };
    case "full":
      return {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        sandboxPolicy: { type: "dangerFullAccess" },
      };
  }
}

export type CodexEvent = CodexServerNotification;

interface CodexUnhandledEventArgs {
  rawEvent: JsonRpcMessage;
  rawType?: string;
  threadId?: string;
  providerThreadId?: string;
  turnId?: string;
  parentToolCallId?: string;
}

export type CodexCommand = DistributiveOmit<CodexClientRequest, "id">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type CodexInteractiveResponse =
  | CommandExecutionRequestApprovalResponse
  | FileChangeRequestApprovalResponse
  | PermissionsRequestApprovalResponse;

function toCodexServiceTier(tier: ServiceTier | undefined): "fast" | undefined {
  return tier === "fast" ? "fast" : undefined;
}

function buildUnhandledCodexEvent(
  args: CodexUnhandledEventArgs,
): ThreadEvent[] {
  const description = codexVisibilityMetadata.describeRawEvent(args.rawEvent);
  if (description.coverage !== "unknown" && args.rawType === undefined) {
    return [];
  }

  return [
    createUnhandledProviderEvent({
      providerId: "codex",
      rawEvent: args.rawEvent,
      rawType: args.rawType ?? description.kind,
      ...(args.threadId ? { threadId: args.threadId } : {}),
      ...(args.providerThreadId ? { providerThreadId: args.providerThreadId } : {}),
      ...(args.turnId ? { turnId: args.turnId } : {}),
      ...(args.parentToolCallId ? { parentToolCallId: args.parentToolCallId } : {}),
    }),
  ];
}

function toCodexUserInput(input: PromptInput[]): CodexUserInput[] {
  return input.map((chunk): CodexUserInput => {
    switch (chunk.type) {
      case "text":
        return { type: "text", text: chunk.text, text_elements: [] };
      case "image":
        return { type: "image", url: chunk.url };
      case "localImage":
        return { type: "localImage", path: chunk.path };
      case "localFile":
        return { type: "text", text: `[Attached file: ${chunk.path}]`, text_elements: [] };
    }
  });
}

function buildCodexConfig(
  threadId: string,
  options?: AdapterOptions,
): { [key in string]?: JsonValue } | undefined {
  const config: { [key in string]?: JsonValue } = {};
  if (threadId) {
    config["shell_environment_policy.set.BB_THREAD_ID"] = threadId;
  }
  const shellEnvironmentConfig = buildShellEnvironmentPolicyConfig(options?.envVars);
  if (shellEnvironmentConfig) {
    Object.assign(config, shellEnvironmentConfig);
  }
  if (options?.reasoningLevel) {
    config["model_reasoning_effort"] = options.reasoningLevel;
  }
  config["features.default_mode_request_user_input"] = false;
  return Object.keys(config).length > 0 ? config : undefined;
}

type CodexDynamicToolCommand = Extract<
  AdapterCommand,
  { type: "thread/start" | "thread/resume" }
>;

function toCodexDynamicTools(
  dynamicTools: CodexDynamicToolCommand["dynamicTools"],
): DynamicToolSpec[] | undefined {
  return dynamicTools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: jsonValueSchema.parse(tool.inputSchema),
  }));
}

function toTurnStatus(status: CodexTurnStatus): ThreadEventTurnStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "inProgress":
      return "completed";
    default:
      return assertNever(status);
  }
}

function toItemStatus(status: CodexItemStatus): ThreadEventItemStatus {
  switch (status) {
    case "inProgress":
      return "pending";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "declined":
      return "interrupted";
    default:
      return assertNever(status);
  }
}

function translateCodexUserContent(
  content: CodexParsedUserInput,
): ThreadEventUserContent {
  switch (content.type) {
    case "text":
      return { type: "text", text: content.text };
    case "image":
      return { type: "image", url: content.url };
    case "localImage":
      return { type: "localImage", path: content.path };
    case "skill":
    case "mention":
      return { type: "text", text: `[${content.type}: ${content.name}]` };
    default:
      return assertNever(content);
  }
}

function extractDynamicToolCallResult(
  contentItems: CodexDynamicToolCallContentItem[] | null,
): unknown {
  if (!contentItems || contentItems.length === 0) {
    return undefined;
  }

  const parts = contentItems.map((contentItem) => {
    switch (contentItem.type) {
      case "inputText":
        return contentItem.text;
      case "inputImage":
        return `[image: ${contentItem.imageUrl}]`;
    }
  }).filter((part) => part.trim().length > 0);

  if (parts.length === 0) {
    return undefined;
  }

  return parts.join("\n");
}

function buildDynamicToolCallError(
  success: boolean | null,
  result: unknown,
): string | undefined {
  if (success !== false) {
    return undefined;
  }
  if (typeof result === "string" && result.trim().length > 0) {
    return result;
  }
  return "Dynamic tool call failed";
}

function translateCodexItem(item: unknown): ThreadEventItem | null {
  const parsed = codexHandledThreadItemSchema.safeParse(item);
  if (!parsed.success) {
    return null;
  }

  const parsedItem: CodexHandledThreadItem = parsed.data;
  switch (parsedItem.type) {
    case "agentMessage":
      return { type: "agentMessage", id: parsedItem.id, text: parsedItem.text };
    case "userMessage": {
      const content = parsedItem.content
        .map((entry) => translateCodexUserContent(entry))
        .filter((entry) => entry.type !== "text" || entry.text.length > 0);
      return { type: "userMessage", id: parsedItem.id, content };
    }
    case "commandExecution":
      return {
        type: "commandExecution",
        id: parsedItem.id,
        command: parsedItem.command,
        cwd: parsedItem.cwd,
        status: toItemStatus(parsedItem.status),
        aggregatedOutput: parsedItem.aggregatedOutput ?? undefined,
        exitCode: parsedItem.exitCode ?? undefined,
        durationMs: parsedItem.durationMs ?? undefined,
      };
    case "fileChange":
      return {
        type: "fileChange",
        id: parsedItem.id,
        changes: parsedItem.changes.map((change) => ({
          path: change.path,
          kind: change.kind.type,
          ...(change.kind.type === "update" && change.kind.move_path
            ? { movePath: change.kind.move_path }
            : {}),
          ...(change.diff ? { diff: change.diff } : {}),
        })),
        status: toItemStatus(parsedItem.status),
      };
    case "mcpToolCall":
      {
        const toolArguments = toOptionalRecord(parsedItem.arguments);
        return {
          type: "toolCall",
          id: parsedItem.id,
          server: parsedItem.server,
          tool: parsedItem.tool,
          ...(toolArguments ? { arguments: toolArguments } : {}),
          status: toItemStatus(parsedItem.status),
          error: parsedItem.error?.message,
          durationMs: parsedItem.durationMs ?? undefined,
        };
      }
    case "dynamicToolCall": {
      const result = extractDynamicToolCallResult(parsedItem.contentItems);
      const toolArguments = toOptionalRecord(parsedItem.arguments);
      return {
        type: "toolCall",
        id: parsedItem.id,
        tool: parsedItem.tool,
        ...(toolArguments ? { arguments: toolArguments } : {}),
        status: toItemStatus(parsedItem.status),
        result,
        error: buildDynamicToolCallError(parsedItem.success, result),
        durationMs: parsedItem.durationMs ?? undefined,
      };
    }
    case "collabAgentToolCall":
      return {
        type: "toolCall",
        id: parsedItem.id,
        tool: parsedItem.tool,
        arguments: {
          senderThreadId: parsedItem.senderThreadId,
          receiverThreadIds: parsedItem.receiverThreadIds,
          ...(parsedItem.prompt ? { prompt: parsedItem.prompt } : {}),
          ...(parsedItem.model ? { model: parsedItem.model } : {}),
          ...(parsedItem.reasoningEffort ? { reasoningEffort: parsedItem.reasoningEffort } : {}),
        },
        status: toItemStatus(parsedItem.status),
        result: parsedItem.agentsStates,
      };
    case "webSearch":
      return {
        type: "webSearch",
        id: parsedItem.id,
        query: parsedItem.query,
        ...(parsedItem.action ? { action: parsedItem.action.type } : {}),
      };
    case "reasoning":
      return {
        type: "reasoning",
        id: parsedItem.id,
        summary: parsedItem.summary,
        content: parsedItem.content,
      };
    case "plan":
      return {
        type: "plan",
        id: parsedItem.id,
        text: parsedItem.text,
      };
    case "contextCompaction":
      return {
        type: "contextCompaction",
        id: parsedItem.id,
      };
    default:
      return assertNever(parsedItem);
  }
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export interface CreateCodexProviderAdapterOptions {
  processCommand?: string;
  processArgs?: string[];
  launchEnv?: Record<string, string>;
}

export function createCodexProviderAdapter(
  opts?: CreateCodexProviderAdapterOptions,
): ProviderAdapter {
  const providerInfo = getBuiltInAgentProviderInfo("codex");
  const capabilities: ProviderCapabilities = {
    supportsRename: providerInfo.capabilities.supportsRename,
    supportsServiceTier: providerInfo.capabilities.supportsServiceTier,
    supportedPermissionModes: providerInfo.capabilities.supportedPermissionModes,
  };

  return {
    id: providerInfo.id,
    displayName: providerInfo.displayName,
    capabilities,
    process: {
      command: opts?.processCommand ?? "codex",
      args: opts?.processArgs ?? ["app-server"],
    },

    buildCommand(command: AdapterCommand): JsonRpcMessage | null {
      switch (command.type) {
        case "initialize":
          return {
            jsonrpc: "2.0",
            method: "initialize",
            params: {
              clientInfo: { name: "bb", version: "1.0.0", title: null },
              capabilities: { experimentalApi: true },
            },
          };
        case "model/list":
          return {
            jsonrpc: "2.0",
            method: "model/list",
            params: {},
          };
        case "thread/start": {
          const dynamicTools = toCodexDynamicTools(command.dynamicTools);
          const permissionSettings = toCodexPermissionSettings(command.options);
          const params: ThreadStartParams = {
            approvalPolicy: permissionSettings.approvalPolicy,
            sandbox: permissionSettings.sandbox,
            cwd: command.cwd,
            baseInstructions: command.options?.instructions ?? "",
            model: command.options?.model ?? undefined,
            serviceTier: toCodexServiceTier(command.options?.serviceTier),
            config: buildCodexConfig(command.threadId, command.options) ?? undefined,
            experimentalRawEvents: false,
            persistExtendedHistory: false,
            ...(dynamicTools && dynamicTools.length > 0 ? { dynamicTools } : {}),
          };
          return {
            jsonrpc: "2.0",
            method: "thread/start",
            params,
          };
        }
        case "thread/resume": {
          const dynamicTools = toCodexDynamicTools(command.dynamicTools);
          const permissionSettings = toCodexPermissionSettings(command.options);
          const params: ThreadResumeParams = {
            threadId: command.providerThreadId ?? command.threadId,
            approvalPolicy: permissionSettings.approvalPolicy,
            sandbox: permissionSettings.sandbox,
            cwd: command.cwd,
            baseInstructions: command.options?.instructions ?? "",
            model: command.options?.model ?? undefined,
            serviceTier: toCodexServiceTier(command.options?.serviceTier),
            config: buildCodexConfig(command.threadId, command.options) ?? undefined,
            persistExtendedHistory: false,
            ...(dynamicTools && dynamicTools.length > 0 ? { dynamicTools } : {}),
          };
          return {
            jsonrpc: "2.0",
            method: "thread/resume",
            params,
          };
        }
        case "turn/start": {
          const permissionSettings = toCodexPermissionSettings(command.options);
          return {
            jsonrpc: "2.0",
            method: "turn/start",
            params: {
              threadId: command.providerThreadId ?? command.threadId,
              input: toCodexUserInput(command.input),
              approvalPolicy: permissionSettings.approvalPolicy,
              sandboxPolicy: permissionSettings.sandboxPolicy,
              model: command.options?.model ?? undefined,
              serviceTier: toCodexServiceTier(command.options?.serviceTier),
            },
          };
        }
        case "turn/steer":
          return {
            jsonrpc: "2.0",
            method: "turn/steer",
            params: {
              threadId: command.providerThreadId ?? command.threadId,
              expectedTurnId: command.expectedTurnId,
              input: toCodexUserInput(command.input),
            },
          };
        case "thread/name/set":
          if (!capabilities.supportsRename) {
            return null;
          }
          return {
            jsonrpc: "2.0",
            method: "thread/name/set",
            params: {
              threadId: command.providerThreadId ?? command.threadId,
              name: command.title,
            },
          };
        case "thread/stop":
          return null;
      }
    },

    translateEvent(
      event: unknown,
      context?: ProviderTranslationContext,
    ): ThreadEvent[] {
      const envelope = codexBridgeEnvelopeSchema.safeParse(event);
      if (!envelope.success) {
        return [];
      }

      const rawEvent: JsonRpcMessage = {
        jsonrpc: "2.0",
        method: envelope.data.method,
        ...(envelope.data.params ? { params: envelope.data.params } : {}),
      };

      const parsed = codexHandledEventSchema.safeParse(rawEvent);
      if (!parsed.success) {
        return isHandledCodexMethod(rawEvent.method)
          ? buildUnhandledCodexEvent({ rawEvent, rawType: rawEvent.method })
          : buildUnhandledCodexEvent({ rawEvent });
      }

      const handledEvent: CodexHandledEvent = parsed.data;
      switch (handledEvent.method) {
        case "turn/started":
          return [{
            type: "turn/started",
            threadId: handledEvent.params.threadId,
            providerThreadId: handledEvent.params.threadId,
            turnId: handledEvent.params.turn.id,
          }];
        case "turn/completed":
          return [{
            type: "turn/completed",
            threadId: handledEvent.params.threadId,
            providerThreadId: handledEvent.params.threadId,
            turnId: handledEvent.params.turn.id,
            status: toTurnStatus(handledEvent.params.turn.status),
            ...(handledEvent.params.turn.error?.message
              ? { error: { message: handledEvent.params.turn.error.message } }
              : {}),
          }];
        case "thread/started": {
          const events: ThreadEvent[] = [
            {
              type: "thread/started",
              threadId: handledEvent.params.thread.id,
            },
            {
              type: "thread/identity",
              threadId: handledEvent.params.thread.id,
              providerThreadId: handledEvent.params.thread.id,
            },
          ];
          if (handledEvent.params.thread.preview) {
            events.push({
              type: "thread/name/updated",
              threadId: handledEvent.params.thread.id,
              providerThreadId: handledEvent.params.thread.id,
              threadName: handledEvent.params.thread.preview,
            });
          }
          return events;
        }
        case "thread/name/updated":
          return handledEvent.params.threadName
            ? [{
                type: "thread/name/updated",
                threadId: handledEvent.params.threadId,
                providerThreadId: handledEvent.params.threadId,
                threadName: handledEvent.params.threadName,
              }]
            : [];
        case "thread/compacted":
          return [{
            type: "thread/compacted",
            threadId: handledEvent.params.threadId,
            providerThreadId: handledEvent.params.threadId,
          }];
        case "item/started":
        case "item/completed": {
          const item = translateCodexItem(handledEvent.params.item);
          if (!item) {
            return buildUnhandledCodexEvent({
              rawEvent,
              rawType: handledEvent.method,
              threadId: handledEvent.params.threadId,
              providerThreadId: handledEvent.params.threadId,
              turnId: handledEvent.params.turnId,
            });
          }
          return [{
            type: handledEvent.method,
            threadId: handledEvent.params.threadId,
            providerThreadId: handledEvent.params.threadId,
            turnId: handledEvent.params.turnId,
            item,
          }];
        }
        case "item/agentMessage/delta":
          return [{
            type: "item/agentMessage/delta",
            threadId: handledEvent.params.threadId,
            providerThreadId: handledEvent.params.threadId,
            turnId: handledEvent.params.turnId,
            itemId: handledEvent.params.itemId,
            delta: handledEvent.params.delta,
          }];
        case "item/commandExecution/outputDelta":
          return [{
            type: "item/commandExecution/outputDelta",
            threadId: handledEvent.params.threadId,
            providerThreadId: handledEvent.params.threadId,
            turnId: handledEvent.params.turnId,
            itemId: handledEvent.params.itemId,
            delta: handledEvent.params.delta,
          }];
        case "item/fileChange/outputDelta":
          return [{
            type: "item/fileChange/outputDelta",
            threadId: handledEvent.params.threadId,
            providerThreadId: handledEvent.params.threadId,
            turnId: handledEvent.params.turnId,
            itemId: handledEvent.params.itemId,
            delta: handledEvent.params.delta,
          }];
        case "item/reasoning/summaryTextDelta":
          return [{
            type: "item/reasoning/summaryTextDelta",
            threadId: handledEvent.params.threadId,
            providerThreadId: handledEvent.params.threadId,
            turnId: handledEvent.params.turnId,
            itemId: handledEvent.params.itemId,
            delta: handledEvent.params.delta,
          }];
        case "item/reasoning/textDelta":
          return [{
            type: "item/reasoning/textDelta",
            threadId: handledEvent.params.threadId,
            providerThreadId: handledEvent.params.threadId,
            turnId: handledEvent.params.turnId,
            itemId: handledEvent.params.itemId,
            delta: handledEvent.params.delta,
          }];
        case "item/plan/delta":
          return [{
            type: "item/plan/delta",
            threadId: handledEvent.params.threadId,
            providerThreadId: handledEvent.params.threadId,
            turnId: handledEvent.params.turnId,
            itemId: handledEvent.params.itemId,
            delta: handledEvent.params.delta,
          }];
        case "item/mcpToolCall/progress":
          return [{
            type: "item/toolCall/progress",
            threadId: handledEvent.params.threadId,
            providerThreadId: handledEvent.params.threadId,
            turnId: handledEvent.params.turnId,
            itemId: handledEvent.params.itemId,
            ...(handledEvent.params.message ? { message: handledEvent.params.message } : {}),
          }];
        case "thread/tokenUsage/updated":
          return [{
            type: "thread/tokenUsage/updated",
            threadId: handledEvent.params.threadId,
            providerThreadId: handledEvent.params.threadId,
            turnId: handledEvent.params.turnId,
            tokenUsage: {
              total: {
                totalTokens: handledEvent.params.tokenUsage.total.totalTokens,
                inputTokens: handledEvent.params.tokenUsage.total.inputTokens,
                cachedInputTokens: handledEvent.params.tokenUsage.total.cachedInputTokens,
                outputTokens: handledEvent.params.tokenUsage.total.outputTokens,
                reasoningOutputTokens: handledEvent.params.tokenUsage.total.reasoningOutputTokens,
              },
              last: {
                totalTokens: handledEvent.params.tokenUsage.last.totalTokens,
                inputTokens: handledEvent.params.tokenUsage.last.inputTokens,
                cachedInputTokens: handledEvent.params.tokenUsage.last.cachedInputTokens,
                outputTokens: handledEvent.params.tokenUsage.last.outputTokens,
                reasoningOutputTokens: handledEvent.params.tokenUsage.last.reasoningOutputTokens,
              },
              modelContextWindow: handledEvent.params.tokenUsage.modelContextWindow,
            },
          }, {
            type: "thread/contextWindowUsage/updated",
            threadId: handledEvent.params.threadId,
            providerThreadId: handledEvent.params.threadId,
            turnId: handledEvent.params.turnId,
            contextWindowUsage: toCodexContextWindowUsage(
              handledEvent.params.tokenUsage.last,
              handledEvent.params.tokenUsage.modelContextWindow,
            ),
          }];
        case "turn/plan/updated":
          return [{
            type: "turn/plan/updated",
            threadId: handledEvent.params.threadId,
            providerThreadId: handledEvent.params.threadId,
            turnId: handledEvent.params.turnId,
            plan: handledEvent.params.plan.map((step) => ({
              step: step.step,
              status: step.status === "inProgress" ? "active" : step.status,
            })),
            ...(handledEvent.params.explanation
              ? { explanation: handledEvent.params.explanation }
              : {}),
          }];
        case "turn/diff/updated":
          return [{
            type: "turn/diff/updated",
            threadId: handledEvent.params.threadId,
            providerThreadId: handledEvent.params.threadId,
            turnId: handledEvent.params.turnId,
            diff: handledEvent.params.diff,
          }];
        case "error":
          return [{
            type: "error",
            threadId: handledEvent.params.threadId,
            providerThreadId: handledEvent.params.threadId,
            ...(handledEvent.params.turnId ? { turnId: handledEvent.params.turnId } : {}),
            message: "Provider error",
            detail: handledEvent.params.error.additionalDetails
              ? `${handledEvent.params.error.message}\n${handledEvent.params.error.additionalDetails}`
              : handledEvent.params.error.message,
            ...(handledEvent.params.willRetry !== undefined
              ? { willRetry: handledEvent.params.willRetry }
              : {}),
          }];
        case "deprecationNotice":
          return [{
            type: "warning",
            threadId: "",
            providerThreadId: "",
            category: "deprecation",
            summary: handledEvent.params.summary,
            ...(handledEvent.params.details ? { details: handledEvent.params.details } : {}),
          }];
        case "configWarning":
          return [{
            type: "warning",
            threadId: "",
            providerThreadId: "",
            category: "config",
            summary: handledEvent.params.summary,
            ...(handledEvent.params.details ? { details: handledEvent.params.details } : {}),
          }];
        default:
          return assertNever(handledEvent);
      }
    },

    decodeToolCallRequest(request: JsonRpcMessage): DecodedToolCallRequest | null {
      if (typeof request.id !== "string" && typeof request.id !== "number") {
        return null;
      }
      return decodeNativeProviderToolCallRequest(
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
        case "item/commandExecution/requestApproval": {
          const parsed = codexCommandExecutionRequestApprovalParamsSchema.safeParse(
            request.params,
          );
          if (!parsed.success) {
            return null;
          }
          const availableDecisions = parseCodexAvailableDecisions(
            parsed.data.availableDecisions,
          );
          if (!availableDecisions) {
            return null;
          }
          return {
            requestId: request.id,
            method: request.method,
            providerThreadId: parsed.data.threadId,
            turnId: parsed.data.turnId,
            payload: {
              kind: "command_approval",
              itemId: parsed.data.itemId,
              reason: parsed.data.reason ?? null,
              command: parsed.data.command ?? null,
              cwd: parsed.data.cwd ?? null,
              commandActions: parsed.data.commandActions ?? [],
              requestedPermissions: parsed.data.additionalPermissions
                ? toPendingInteractionPermissionProfile(parsed.data.additionalPermissions)
                : null,
              availableDecisions,
            },
          };
        }
        case "item/fileChange/requestApproval": {
          const parsed = codexFileChangeRequestApprovalParamsSchema.safeParse(
            request.params,
          );
          if (!parsed.success) {
            return null;
          }
          return {
            requestId: request.id,
            method: request.method,
            providerThreadId: parsed.data.threadId,
            turnId: parsed.data.turnId,
            payload: {
              kind: "file_change_approval",
              itemId: parsed.data.itemId,
              reason: parsed.data.reason ?? null,
              grantRoot: parsed.data.grantRoot ?? null,
            },
          };
        }
        case "item/permissions/requestApproval": {
          const parsed = codexPermissionsRequestApprovalParamsSchema.safeParse(
            request.params,
          );
          if (!parsed.success) {
            return null;
          }
          return {
            requestId: request.id,
            method: request.method,
            providerThreadId: parsed.data.threadId,
            turnId: parsed.data.turnId,
            payload: {
              kind: "permission_request",
              itemId: parsed.data.itemId,
              reason: parsed.data.reason,
              toolName: null,
              permissions: toPendingInteractionGrantablePermissionProfile(
                parsed.data.permissions,
              ),
            },
          };
        }
        default:
          return null;
      }
    },

    buildInteractiveResponse(args): CodexInteractiveResponse {
      switch (args.request.payload.kind) {
        case "command_approval": {
          if (args.resolution.kind !== "command_approval") {
            throw new Error("Interactive response kind mismatch for command approval");
          }
          const response: CommandExecutionRequestApprovalResponse = {
            decision: toCodexCommandApprovalDecision(args.resolution.decision),
          };
          return response;
        }
        case "file_change_approval": {
          if (args.resolution.kind !== "file_change_approval") {
            throw new Error("Interactive response kind mismatch for file change approval");
          }
          const response: FileChangeRequestApprovalResponse = {
            decision:
              pendingInteractionToCodexFileChangeApprovalDecision[
                args.resolution.decision
              ],
          };
          return response;
        }
        case "permission_request": {
          if (args.resolution.kind !== "permission_request") {
            throw new Error("Interactive response kind mismatch for permission request");
          }
          if (args.resolution.decision === "deny") {
            const response: PermissionsRequestApprovalResponse = {
              permissions: {},
              scope: "turn",
            };
            return response;
          }
          const response: PermissionsRequestApprovalResponse = {
            permissions: toCodexGrantedPermissionProfile(args.resolution.permissions),
            scope: args.resolution.scope,
          };
          return response;
        }
        default:
          return assertNever(args.request.payload);
      }
    },

    parseModelListResult(result: unknown) {
      return parseModelsResponse(result);
    },
  };
}

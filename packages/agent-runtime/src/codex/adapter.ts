/**
 * Codex provider adapter.
 *
 * Maps between bb's ProviderAdapter contract and the OpenAI Codex app-server
 * JSON-RPC protocol. Validates the outer JSON-RPC envelope before translating
 * the provider-specific payloads.
 *
 * Reference: https://github.com/openai/codex (codex-rs/app-server-protocol/)
 */

import { z } from "zod";
import type {
  PromptInput,
  ProviderCapabilities,
  SandboxMode,
  ServiceTier,
  ThreadEvent,
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
import type { ThreadResumeParams } from "./generated/codex-app-server/schema/v2/ThreadResumeParams.js";
import type { ThreadStartParams } from "./generated/codex-app-server/schema/v2/ThreadStartParams.js";
import type { UserInput as CodexUserInput } from "./generated/codex-app-server/schema/v2/UserInput.js";
import { parseModelsResponse } from "./models.js";
import {
  buildShellEnvironmentPolicyConfig,
  toOptionalRecord,
} from "../shared/adapter-utils.js";
import {
  decodeNativeProviderToolCallRequest,
} from "../shared/provider-tool-call-contract.js";
import { createUnhandledProviderEvent } from "../shared/provider-unhandled-event.js";
import { jsonRpcEnvelopeSchema } from "../shared/json-rpc-envelope.js";
import type {
  AdapterCommand,
  AdapterOptions,
  DecodedToolCallRequest,
  JsonRpcMessage,
  ProviderAdapter,
  ProviderTranslationContext,
} from "../provider-adapter.js";
import { codexVisibilityMetadata } from "./visibility.js";

function assertNever(value: never, message?: string): never {
  throw new Error(message ?? `Unexpected value: ${String(value)}`);
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

const codexTurnStatusSchema = z.enum([
  "completed",
  "failed",
  "interrupted",
  "inProgress",
]);
type CodexTurnStatus = z.infer<typeof codexTurnStatusSchema>;

const codexItemStatusSchema = z.enum([
  "inProgress",
  "completed",
  "failed",
  "declined",
]);
type CodexItemStatus = z.infer<typeof codexItemStatusSchema>;

const codexPlanStepStatusSchema = z.enum([
  "pending",
  "inProgress",
  "completed",
  "failed",
]);

type ZodObjectSchema = z.ZodObject<z.ZodRawShape>;

const codexStringArraySchema = z.array(z.string());

const codexUserInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
    text_elements: z.array(z.unknown()).optional(),
  }).passthrough(),
  z.object({
    type: z.literal("image"),
    url: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal("localImage"),
    path: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal("skill"),
    name: z.string(),
    path: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal("mention"),
    name: z.string(),
    path: z.string(),
  }).passthrough(),
]);
type CodexParsedUserInput = z.infer<typeof codexUserInputSchema>;

const codexToolReferenceStatusSchema = z.enum([
  "inProgress",
  "completed",
  "failed",
  "declined",
]);

const codexFileChangeKindSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add") }).passthrough(),
  z.object({ type: z.literal("delete") }).passthrough(),
  z.object({
    type: z.literal("update"),
    move_path: z.string().nullable().optional(),
  }).passthrough(),
]);

const codexFileChangeSchema = z.object({
  path: z.string(),
  kind: codexFileChangeKindSchema,
  diff: z.string(),
}).passthrough();

const codexDynamicToolCallContentItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("inputText"),
    text: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal("inputImage"),
    imageUrl: z.string(),
  }).passthrough(),
]);
type CodexDynamicToolCallContentItem = z.infer<
  typeof codexDynamicToolCallContentItemSchema
>;

const codexWebSearchActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("search"),
    query: z.string().optional(),
    queries: z.array(z.string()).nullable().optional(),
  }).passthrough(),
  z.object({
    type: z.literal("open_page"),
    url: z.string().optional(),
  }).passthrough(),
  z.object({
    type: z.literal("find_in_page"),
    url: z.string().optional(),
    pattern: z.string().optional(),
  }).passthrough(),
  z.object({
    type: z.literal("other"),
  }).passthrough(),
]);

const codexThreadItemEnvelopeSchema = z.object({
  type: z.string(),
  id: z.string(),
}).passthrough();

const codexHandledThreadItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("agentMessage"),
    id: z.string(),
    text: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal("userMessage"),
    id: z.string(),
    content: z.array(codexUserInputSchema),
  }).passthrough(),
  z.object({
    type: z.literal("commandExecution"),
    id: z.string(),
    command: z.string(),
    cwd: z.string(),
    status: codexToolReferenceStatusSchema,
    aggregatedOutput: z.string().nullable(),
    exitCode: z.number().nullable(),
    durationMs: z.number().nullable(),
  }).passthrough(),
  z.object({
    type: z.literal("fileChange"),
    id: z.string(),
    changes: z.array(codexFileChangeSchema),
    status: codexToolReferenceStatusSchema,
  }).passthrough(),
  z.object({
    type: z.literal("mcpToolCall"),
    id: z.string(),
    server: z.string(),
    tool: z.string(),
    status: codexToolReferenceStatusSchema,
    arguments: z.unknown(),
    error: z.object({
      message: z.string().optional(),
    }).passthrough().nullable().optional(),
    durationMs: z.number().nullable(),
  }).passthrough(),
  z.object({
    type: z.literal("dynamicToolCall"),
    id: z.string(),
    tool: z.string(),
    arguments: z.unknown(),
    status: codexToolReferenceStatusSchema,
    contentItems: z.array(codexDynamicToolCallContentItemSchema).nullable(),
    success: z.boolean().nullable(),
    durationMs: z.number().nullable(),
  }).passthrough(),
  z.object({
    type: z.literal("collabAgentToolCall"),
    id: z.string(),
    tool: z.string(),
    status: codexToolReferenceStatusSchema,
    senderThreadId: z.string(),
    receiverThreadIds: z.array(z.string()),
    prompt: z.string().nullable(),
    model: z.string().nullable(),
    reasoningEffort: z.string().nullable(),
    agentsStates: z.record(z.string(), z.unknown()),
  }).passthrough(),
  z.object({
    type: z.literal("webSearch"),
    id: z.string(),
    query: z.string(),
    action: codexWebSearchActionSchema.nullable(),
  }).passthrough(),
  z.object({
    type: z.literal("reasoning"),
    id: z.string(),
    summary: codexStringArraySchema,
    content: codexStringArraySchema,
  }).passthrough(),
  z.object({
    type: z.literal("plan"),
    id: z.string(),
    text: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal("contextCompaction"),
    id: z.string(),
  }).passthrough(),
]);
type CodexHandledThreadItem = z.infer<typeof codexHandledThreadItemSchema>;

const codexThreadTurnParamsSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
}).passthrough();

const codexTurnSchema = z.object({
  id: z.string(),
  status: codexTurnStatusSchema,
  error: z.object({
    message: z.string(),
    additionalDetails: z.string().nullish(),
  }).passthrough().nullable().optional(),
}).passthrough();

const codexThreadSchema = z.object({
  id: z.string(),
  preview: z.string().optional(),
}).passthrough();

const codexTokenUsageBreakdownSchema = z.object({
  totalTokens: z.number(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
  reasoningOutputTokens: z.number(),
}).passthrough();

const codexTokenUsageSchema = z.object({
  total: codexTokenUsageBreakdownSchema,
  last: codexTokenUsageBreakdownSchema,
  modelContextWindow: z.number().nullable(),
}).passthrough();

const codexPlanStepSchema = z.object({
  step: z.string(),
  status: codexPlanStepStatusSchema,
}).passthrough();

const codexWarningParamsSchema = z.object({
  summary: z.string(),
  details: z.string().nullish(),
}).passthrough();

const codexBridgeEnvelopeSchema = z.union([
  jsonRpcEnvelopeSchema,
  // Current Codex fixture captures still arrive as `{ method, params }`
  // notifications without `jsonrpc: "2.0"`, so the bridge accepts both.
  z.object({
    method: z.string(),
    params: z.record(z.string(), z.unknown()).optional(),
  }).passthrough(),
]);

function createCodexEventSchema<
  TMethod extends string,
  TParams extends ZodObjectSchema,
>(
  method: TMethod,
  params: TParams,
) {
  return z.object({
    method: z.literal(method),
    params,
  });
}

const codexHandledEventSchema = z.discriminatedUnion("method", [
  createCodexEventSchema("turn/started", z.object({
    threadId: z.string(),
    turn: codexTurnSchema,
  }).passthrough()),
  createCodexEventSchema("turn/completed", z.object({
    threadId: z.string(),
    turn: codexTurnSchema,
  }).passthrough()),
  createCodexEventSchema("thread/started", z.object({
    thread: codexThreadSchema,
  }).passthrough()),
  createCodexEventSchema("thread/name/updated", z.object({
    threadId: z.string(),
    threadName: z.string().optional(),
  }).passthrough()),
  createCodexEventSchema("thread/compacted", z.object({
    threadId: z.string(),
  }).passthrough()),
  createCodexEventSchema("item/started", z.object({
    threadId: z.string(),
    turnId: z.string(),
    item: codexThreadItemEnvelopeSchema,
  }).passthrough()),
  createCodexEventSchema("item/completed", z.object({
    threadId: z.string(),
    turnId: z.string(),
    item: codexThreadItemEnvelopeSchema,
  }).passthrough()),
  createCodexEventSchema("item/agentMessage/delta", codexThreadTurnParamsSchema.extend({
    itemId: z.string(),
    delta: z.string(),
  })),
  createCodexEventSchema("item/commandExecution/outputDelta", codexThreadTurnParamsSchema.extend({
    itemId: z.string(),
    delta: z.string(),
  })),
  createCodexEventSchema("item/fileChange/outputDelta", codexThreadTurnParamsSchema.extend({
    itemId: z.string(),
    delta: z.string(),
  })),
  createCodexEventSchema("item/reasoning/summaryTextDelta", codexThreadTurnParamsSchema.extend({
    itemId: z.string(),
    delta: z.string(),
  })),
  createCodexEventSchema("item/reasoning/textDelta", codexThreadTurnParamsSchema.extend({
    itemId: z.string(),
    delta: z.string(),
  })),
  createCodexEventSchema("item/plan/delta", codexThreadTurnParamsSchema.extend({
    itemId: z.string(),
    delta: z.string(),
  })),
  createCodexEventSchema("item/mcpToolCall/progress", codexThreadTurnParamsSchema.extend({
    itemId: z.string(),
    message: z.string().optional(),
  })),
  createCodexEventSchema("thread/tokenUsage/updated", codexThreadTurnParamsSchema.extend({
    tokenUsage: codexTokenUsageSchema,
  })),
  createCodexEventSchema("turn/plan/updated", codexThreadTurnParamsSchema.extend({
    plan: z.array(codexPlanStepSchema),
    explanation: z.string().nullish(),
  })),
  createCodexEventSchema("turn/diff/updated", codexThreadTurnParamsSchema.extend({
    diff: z.string(),
  })),
  createCodexEventSchema("error", z.object({
    threadId: z.string(),
    turnId: z.string().optional(),
    error: z.object({
      message: z.string(),
      additionalDetails: z.string().nullish(),
    }).passthrough(),
    willRetry: z.boolean().optional(),
  }).passthrough()),
  createCodexEventSchema("deprecationNotice", codexWarningParamsSchema),
  createCodexEventSchema("configWarning", codexWarningParamsSchema),
]);
type CodexHandledEvent = z.infer<typeof codexHandledEventSchema>;

type HandledCodexMethod = CodexHandledEvent["method"];

const handledCodexMethodSet = new Set<string>(
  codexHandledEventSchema.options.map((option) => option.shape.method.value),
);

function isHandledCodexMethod(method: string): method is HandledCodexMethod {
  return handledCodexMethodSet.has(method);
}

function toSandboxPolicy(sandboxMode?: SandboxMode): SandboxPolicy {
  const resolved: SandboxMode = sandboxMode ?? "danger-full-access";
  switch (resolved) {
    case "read-only":
      return { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false };
    case "workspace-write":
      return {
        type: "workspaceWrite",
        writableRoots: [],
        readOnlyAccess: { type: "fullAccess" },
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    default:
      return assertNever(resolved);
  }
}

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
    inputSchema: JSON.parse(JSON.stringify(tool.inputSchema)),
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
  const capabilities: ProviderCapabilities = {
    supportsRename: true,
    supportsServiceTier: true,
  };

  return {
    id: "codex",
    displayName: "Codex",
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
          const params: ThreadStartParams = {
            approvalPolicy: "never",
            sandbox: command.options?.sandboxMode ?? "danger-full-access",
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
          const params: ThreadResumeParams = {
            threadId: command.providerThreadId ?? command.threadId,
            approvalPolicy: "never",
            sandbox: command.options?.sandboxMode ?? "danger-full-access",
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
        case "turn/start":
          return {
            jsonrpc: "2.0",
            method: "turn/start",
            params: {
              threadId: command.providerThreadId ?? command.threadId,
              input: toCodexUserInput(command.input),
              approvalPolicy: "never",
              sandboxPolicy: toSandboxPolicy(command.options?.sandboxMode),
              model: command.options?.model ?? undefined,
              serviceTier: toCodexServiceTier(command.options?.serviceTier),
            },
          };
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

    parseModelListResult(result: unknown) {
      return parseModelsResponse(result);
    },
  };
}

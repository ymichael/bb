import type {
  ThreadEvent,
  ThreadEventContextWindowUsage,
  ThreadEventWebFetchItem,
  ThreadEventWebSearchItem,
  ThreadEventItemApprovalStatus,
  ThreadEventItem,
  ThreadEventItemStatus,
  ThreadEventTurnStatus,
  ThreadEventUserContent,
} from "@bb/domain";
import { threadScope, turnScope } from "@bb/domain";
import { toOptionalRecord } from "../shared/adapter-utils.js";
import { createUnhandledProviderEvent } from "../shared/provider-unhandled-event.js";
import { UNSTAMPED_THREAD_ID } from "../shared/unstamped-thread-id.js";
import type {
  JsonRpcMessage,
  ProviderRuntimeEvent,
} from "../runtime-json-rpc.js";
import {
  codexBridgeEnvelopeSchema,
  codexHandledEventSchema,
  codexHandledThreadItemSchema,
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

type CodexNormalizedWebItem =
  | ThreadEventWebSearchItem
  | ThreadEventWebFetchItem;

type CodexItemTranslationResult =
  | { kind: "translated"; item: ThreadEventItem }
  | { kind: "ignored" }
  | { kind: "unhandled" };

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

interface CodexUnhandledEventArgs {
  rawEvent: JsonRpcMessage;
  rawType?: string;
  threadId?: string;
  providerThreadId?: string;
  turnId?: string;
  parentToolCallId?: string;
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
      ...(args.providerThreadId
        ? { providerThreadId: args.providerThreadId }
        : {}),
      ...(args.turnId ? { turnId: args.turnId } : {}),
      ...(args.parentToolCallId
        ? { parentToolCallId: args.parentToolCallId }
        : {}),
    }),
  ];
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

function toApprovalStatus(
  status: CodexItemStatus,
  eventMethod: "item/started" | "item/completed",
): ThreadEventItemApprovalStatus {
  // A started event is not terminal even if Codex includes a terminal-looking
  // status. Only completed declined items represent a denied approval/policy.
  if (eventMethod === "item/completed" && status === "declined") {
    return "denied";
  }
  return null;
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

  const parts = contentItems
    .map((contentItem) => {
      switch (contentItem.type) {
        case "inputText":
          return contentItem.text;
        case "inputImage":
          return `[image: ${contentItem.imageUrl}]`;
      }
    })
    .filter((part) => part.trim().length > 0);

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

function collectNonEmptyStrings(
  values: Array<string | null | undefined>,
): string[] {
  return values.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

interface CodexSearchQueriesArgs {
  itemQuery: string;
  actionQuery: string | null | undefined;
  actionQueries: string[] | null | undefined;
}

function normalizeCodexSearchQueries(
  args: CodexSearchQueriesArgs,
): string[] | null {
  const queries = dedupeStrings(
    collectNonEmptyStrings([
      ...(args.actionQueries ?? []),
      args.actionQuery,
      args.itemQuery,
    ]),
  );
  return queries.length > 0 ? queries : null;
}

interface CodexUrlArgs {
  actionUrl: string | null | undefined;
}

function normalizeCodexUrl(args: CodexUrlArgs): string | null {
  const url = collectNonEmptyStrings([args.actionUrl])[0];
  return url ?? null;
}

function normalizeCodexWebItem(
  item: Extract<CodexHandledThreadItem, { type: "webSearch" }>,
): CodexNormalizedWebItem | null {
  if (!item.action) {
    return null;
  }

  switch (item.action.type) {
    case "search": {
      const queries = normalizeCodexSearchQueries({
        itemQuery: item.query,
        actionQuery: item.action.query,
        actionQueries: item.action.queries,
      });
      if (!queries) {
        return null;
      }
      return {
        type: "webSearch",
        id: item.id,
        queries,
        resultText: null,
      };
    }
    case "openPage": {
      const url = normalizeCodexUrl({ actionUrl: item.action.url });
      if (!url) {
        return null;
      }
      return {
        type: "webFetch",
        id: item.id,
        url,
        prompt: null,
        pattern: null,
        resultText: null,
      };
    }
    case "findInPage": {
      const url = normalizeCodexUrl({ actionUrl: item.action.url });
      if (!url) {
        return null;
      }
      return {
        type: "webFetch",
        id: item.id,
        url,
        prompt: null,
        pattern: item.action.pattern ?? null,
        resultText: null,
      };
    }
    case "other":
      return null;
    default:
      return assertNever(item.action);
  }
}

function shouldIgnoreCodexWebItem(
  item: Extract<CodexHandledThreadItem, { type: "webSearch" }>,
): boolean {
  return item.action === null || item.action.type === "other";
}

function translateCodexItem(
  item: unknown,
  eventMethod: "item/started" | "item/completed",
): CodexItemTranslationResult {
  const parsed = codexHandledThreadItemSchema.safeParse(item);
  if (!parsed.success) {
    return { kind: "unhandled" };
  }

  const parsedItem: CodexHandledThreadItem = parsed.data;
  const isStartedEvent = eventMethod === "item/started";
  switch (parsedItem.type) {
    case "agentMessage":
      return {
        kind: "translated",
        item: {
          type: "agentMessage",
          id: parsedItem.id,
          text: parsedItem.text,
        },
      };
    case "userMessage": {
      const content = parsedItem.content
        .map((entry) => translateCodexUserContent(entry))
        .filter((entry) => entry.type !== "text" || entry.text.length > 0);
      return {
        kind: "translated",
        item: { type: "userMessage", id: parsedItem.id, content },
      };
    }
    case "commandExecution":
      return {
        kind: "translated",
        item: {
          type: "commandExecution",
          id: parsedItem.id,
          command: parsedItem.command,
          cwd: parsedItem.cwd,
          status: isStartedEvent ? "pending" : toItemStatus(parsedItem.status),
          approvalStatus: toApprovalStatus(parsedItem.status, eventMethod),
          aggregatedOutput: parsedItem.aggregatedOutput ?? undefined,
          exitCode: parsedItem.exitCode ?? undefined,
          durationMs: parsedItem.durationMs ?? undefined,
        },
      };
    case "fileChange":
      return {
        kind: "translated",
        item: {
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
          status: isStartedEvent ? "pending" : toItemStatus(parsedItem.status),
          approvalStatus: toApprovalStatus(parsedItem.status, eventMethod),
        },
      };
    case "mcpToolCall": {
      const toolArguments = toOptionalRecord(parsedItem.arguments);
      return {
        kind: "translated",
        item: {
          type: "toolCall",
          id: parsedItem.id,
          server: parsedItem.server,
          tool: parsedItem.tool,
          ...(toolArguments ? { arguments: toolArguments } : {}),
          status: isStartedEvent ? "pending" : toItemStatus(parsedItem.status),
          error: parsedItem.error?.message,
          durationMs: parsedItem.durationMs ?? undefined,
        },
      };
    }
    case "dynamicToolCall": {
      const result = extractDynamicToolCallResult(parsedItem.contentItems);
      const toolArguments = toOptionalRecord(parsedItem.arguments);
      return {
        kind: "translated",
        item: {
          type: "toolCall",
          id: parsedItem.id,
          tool: parsedItem.tool,
          ...(toolArguments ? { arguments: toolArguments } : {}),
          status: isStartedEvent ? "pending" : toItemStatus(parsedItem.status),
          result,
          error: buildDynamicToolCallError(parsedItem.success, result),
          durationMs: parsedItem.durationMs ?? undefined,
        },
      };
    }
    case "collabAgentToolCall":
      return {
        kind: "translated",
        item: {
          type: "toolCall",
          id: parsedItem.id,
          tool: parsedItem.tool,
          arguments: {
            senderThreadId: parsedItem.senderThreadId,
            receiverThreadIds: parsedItem.receiverThreadIds,
            ...(parsedItem.prompt ? { prompt: parsedItem.prompt } : {}),
            ...(parsedItem.model ? { model: parsedItem.model } : {}),
            ...(parsedItem.reasoningEffort
              ? { reasoningEffort: parsedItem.reasoningEffort }
              : {}),
          },
          status: isStartedEvent ? "pending" : toItemStatus(parsedItem.status),
          result: parsedItem.agentsStates,
        },
      };
    case "webSearch": {
      if (shouldIgnoreCodexWebItem(parsedItem)) {
        return { kind: "ignored" };
      }
      const normalized = normalizeCodexWebItem(parsedItem);
      return normalized
        ? { kind: "translated", item: normalized }
        : { kind: "unhandled" };
    }
    case "reasoning":
      return {
        kind: "translated",
        item: {
          type: "reasoning",
          id: parsedItem.id,
          summary: parsedItem.summary,
          content: parsedItem.content,
        },
      };
    case "plan":
      return {
        kind: "translated",
        item: {
          type: "plan",
          id: parsedItem.id,
          text: parsedItem.text,
        },
      };
    case "contextCompaction":
      return {
        kind: "translated",
        item: {
          type: "contextCompaction",
          id: parsedItem.id,
        },
      };
    default:
      return assertNever(parsedItem);
  }
}

export function translateCodexEvent(
  event: ProviderRuntimeEvent,
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
      return [
        {
          type: "turn/started",
          threadId: handledEvent.params.threadId,
          providerThreadId: handledEvent.params.threadId,
          scope: turnScope(handledEvent.params.turn.id),
        },
      ];
    case "turn/completed":
      return [
        {
          type: "turn/completed",
          threadId: handledEvent.params.threadId,
          providerThreadId: handledEvent.params.threadId,
          scope: turnScope(handledEvent.params.turn.id),
          status: toTurnStatus(handledEvent.params.turn.status),
          ...(handledEvent.params.turn.error?.message
            ? { error: { message: handledEvent.params.turn.error.message } }
            : {}),
        },
      ];
    case "thread/started": {
      const events: ThreadEvent[] = [
        {
          type: "thread/started",
          threadId: handledEvent.params.thread.id,
          scope: threadScope(),
        },
        {
          type: "thread/identity",
          threadId: handledEvent.params.thread.id,
          providerThreadId: handledEvent.params.thread.id,
          scope: threadScope(),
        },
      ];
      if (handledEvent.params.thread.preview) {
        events.push({
          type: "thread/name/updated",
          threadId: handledEvent.params.thread.id,
          providerThreadId: handledEvent.params.thread.id,
          scope: threadScope(),
          threadName: handledEvent.params.thread.preview,
        });
      }
      return events;
    }
    case "thread/name/updated":
      return handledEvent.params.threadName
        ? [
            {
              type: "thread/name/updated",
              threadId: handledEvent.params.threadId,
              providerThreadId: handledEvent.params.threadId,
              scope: threadScope(),
              threadName: handledEvent.params.threadName,
            },
          ]
        : [];
    case "thread/compacted":
      return [
        {
          type: "thread/compacted",
          threadId: handledEvent.params.threadId,
          providerThreadId: handledEvent.params.threadId,
          scope: turnScope(handledEvent.params.turnId),
        },
      ];
    case "item/started":
    case "item/completed": {
      const translation = translateCodexItem(
        handledEvent.params.item,
        handledEvent.method,
      );
      if (translation.kind === "ignored") {
        return [];
      }
      if (translation.kind === "unhandled") {
        return buildUnhandledCodexEvent({
          rawEvent,
          rawType: handledEvent.method,
          threadId: handledEvent.params.threadId,
          providerThreadId: handledEvent.params.threadId,
          turnId: handledEvent.params.turnId,
        });
      }
      return [
        {
          type: handledEvent.method,
          threadId: handledEvent.params.threadId,
          providerThreadId: handledEvent.params.threadId,
          scope: turnScope(handledEvent.params.turnId),
          item: translation.item,
        },
      ];
    }
    case "item/agentMessage/delta":
      return [
        {
          type: "item/agentMessage/delta",
          threadId: handledEvent.params.threadId,
          providerThreadId: handledEvent.params.threadId,
          scope: turnScope(handledEvent.params.turnId),
          itemId: handledEvent.params.itemId,
          delta: handledEvent.params.delta,
        },
      ];
    case "item/commandExecution/outputDelta":
      return [
        {
          type: "item/commandExecution/outputDelta",
          threadId: handledEvent.params.threadId,
          providerThreadId: handledEvent.params.threadId,
          scope: turnScope(handledEvent.params.turnId),
          itemId: handledEvent.params.itemId,
          delta: handledEvent.params.delta,
        },
      ];
    case "item/fileChange/outputDelta":
      return [
        {
          type: "item/fileChange/outputDelta",
          threadId: handledEvent.params.threadId,
          providerThreadId: handledEvent.params.threadId,
          scope: turnScope(handledEvent.params.turnId),
          itemId: handledEvent.params.itemId,
          delta: handledEvent.params.delta,
        },
      ];
    case "item/reasoning/summaryTextDelta":
      return [
        {
          type: "item/reasoning/summaryTextDelta",
          threadId: handledEvent.params.threadId,
          providerThreadId: handledEvent.params.threadId,
          scope: turnScope(handledEvent.params.turnId),
          itemId: handledEvent.params.itemId,
          delta: handledEvent.params.delta,
        },
      ];
    case "item/reasoning/textDelta":
      return [
        {
          type: "item/reasoning/textDelta",
          threadId: handledEvent.params.threadId,
          providerThreadId: handledEvent.params.threadId,
          scope: turnScope(handledEvent.params.turnId),
          itemId: handledEvent.params.itemId,
          delta: handledEvent.params.delta,
        },
      ];
    case "item/plan/delta":
      return [
        {
          type: "item/plan/delta",
          threadId: handledEvent.params.threadId,
          providerThreadId: handledEvent.params.threadId,
          scope: turnScope(handledEvent.params.turnId),
          itemId: handledEvent.params.itemId,
          delta: handledEvent.params.delta,
        },
      ];
    case "item/mcpToolCall/progress":
      return [
        {
          type: "item/toolCall/progress",
          threadId: handledEvent.params.threadId,
          providerThreadId: handledEvent.params.threadId,
          scope: turnScope(handledEvent.params.turnId),
          itemId: handledEvent.params.itemId,
          ...(handledEvent.params.message
            ? { message: handledEvent.params.message }
            : {}),
        },
      ];
    case "thread/tokenUsage/updated":
      return [
        {
          type: "thread/tokenUsage/updated",
          threadId: handledEvent.params.threadId,
          providerThreadId: handledEvent.params.threadId,
          scope: turnScope(handledEvent.params.turnId),
          tokenUsage: {
            total: {
              totalTokens: handledEvent.params.tokenUsage.total.totalTokens,
              inputTokens: handledEvent.params.tokenUsage.total.inputTokens,
              cachedInputTokens:
                handledEvent.params.tokenUsage.total.cachedInputTokens,
              outputTokens: handledEvent.params.tokenUsage.total.outputTokens,
              reasoningOutputTokens:
                handledEvent.params.tokenUsage.total.reasoningOutputTokens,
            },
            last: {
              totalTokens: handledEvent.params.tokenUsage.last.totalTokens,
              inputTokens: handledEvent.params.tokenUsage.last.inputTokens,
              cachedInputTokens:
                handledEvent.params.tokenUsage.last.cachedInputTokens,
              outputTokens: handledEvent.params.tokenUsage.last.outputTokens,
              reasoningOutputTokens:
                handledEvent.params.tokenUsage.last.reasoningOutputTokens,
            },
            modelContextWindow:
              handledEvent.params.tokenUsage.modelContextWindow,
          },
        },
        {
          type: "thread/contextWindowUsage/updated",
          threadId: handledEvent.params.threadId,
          providerThreadId: handledEvent.params.threadId,
          scope: turnScope(handledEvent.params.turnId),
          contextWindowUsage: toCodexContextWindowUsage(
            handledEvent.params.tokenUsage.last,
            handledEvent.params.tokenUsage.modelContextWindow,
          ),
        },
      ];
    case "turn/plan/updated":
      return [
        {
          type: "turn/plan/updated",
          threadId: handledEvent.params.threadId,
          providerThreadId: handledEvent.params.threadId,
          scope: turnScope(handledEvent.params.turnId),
          plan: handledEvent.params.plan.map((step) => ({
            step: step.step,
            status: step.status === "inProgress" ? "active" : step.status,
          })),
          ...(handledEvent.params.explanation
            ? { explanation: handledEvent.params.explanation }
            : {}),
        },
      ];
    case "turn/diff/updated":
      return [
        {
          type: "turn/diff/updated",
          threadId: handledEvent.params.threadId,
          providerThreadId: handledEvent.params.threadId,
          scope: turnScope(handledEvent.params.turnId),
          diff: handledEvent.params.diff,
        },
      ];
    case "error":
      return [
        {
          type: "provider/error",
          threadId: handledEvent.params.threadId,
          providerThreadId: handledEvent.params.threadId,
          scope: handledEvent.params.turnId
            ? turnScope(handledEvent.params.turnId)
            : threadScope(),
          message: "Provider error",
          detail: handledEvent.params.error.additionalDetails
            ? `${handledEvent.params.error.message}\n${handledEvent.params.error.additionalDetails}`
            : handledEvent.params.error.message,
          ...(handledEvent.params.willRetry !== undefined
            ? { willRetry: handledEvent.params.willRetry }
            : {}),
        },
      ];
    case "deprecationNotice":
      return [
        {
          type: "provider/warning",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: threadScope(),
          category: "deprecation",
          summary: handledEvent.params.summary,
          ...(handledEvent.params.details
            ? { details: handledEvent.params.details }
            : {}),
        },
      ];
    case "configWarning":
      return [
        {
          type: "provider/warning",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: threadScope(),
          category: "config",
          summary: handledEvent.params.summary,
          ...(handledEvent.params.details
            ? { details: handledEvent.params.details }
            : {}),
        },
      ];
    default:
      return assertNever(handledEvent);
  }
}

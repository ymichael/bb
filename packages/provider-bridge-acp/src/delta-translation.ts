import { providerRawEventSchema } from "@bb/domain";
import type { ProviderRawEvent } from "@bb/domain";
import {
  COMPACTION_PRESENTATION,
  errorEnvelopeSchema,
  jsonRpcEnvelopeSchema,
  planStepsPresentation,
  presentationTitle,
} from "@bb/provider-bridge-protocol/bridge-kit";
import type {
  JsonRpcMessage,
  ProviderRuntimeEvent,
} from "@bb/provider-bridge-protocol/bridge-kit";
import type {
  ThreadEventItemStatus,
  ThreadEventPlanStep,
  ThreadEventTurnStatus,
} from "@bb/domain";
import type {
  DeltaItemShape,
  DeltaNoTurnFallback,
  ThreadDelta,
} from "@bb/provider-bridge-protocol";
import {
  ACP_COMPACTION_COMPLETED_METHOD,
  ACP_COMPACTION_STARTED_METHOD,
  ACP_FS_WRITE_METHOD,
  ACP_TURN_COMPLETED_METHOD,
  ACP_TURN_STARTED_METHOD,
  ACP_UPDATE_METHOD,
  ACP_WARNING_METHOD,
  acpCompactionCompletedNotificationParamsSchema,
  acpFsWriteNotificationParamsSchema,
  acpTurnCompletedNotificationParamsSchema,
  acpTurnStartedNotificationParamsSchema,
  acpUpdateNotificationParamsSchema,
  acpWarningNotificationParamsSchema,
} from "./bridge-protocol.js";
import {
  GENERIC_ACP_DIALECT,
  type AcpDelegationReport,
  type AcpDialect,
} from "./dialect.js";
import {
  delegationPresentation,
  fileChangePresentation,
} from "./presentation.js";
import {
  classifyAcpToolCall,
  extractAcpCommandResult,
  extractAcpStreamedCommandOutput,
  extractAcpToolCallOutputText,
  isInjectedToolCandidate,
  type AcpClassifiedToolCall,
  type AcpInjectedTool,
} from "./tool-classification.js";
import { resolveAcpToolCallPath } from "./tool-call-operation.js";
import { acpVisibilityMetadata } from "./visibility.js";
import {
  acpAgentMessageChunkUpdateSchema,
  acpAgentThoughtChunkUpdateSchema,
  acpPlanUpdateSchema,
  acpToolCallUpdateEventSchema,
  acpUsageUpdateSchema,
  extractAcpContentText,
  type AcpSessionUpdate,
  type AcpStopReason,
  type AcpToolCallContent,
  type AcpToolCallUpdateEvent,
} from "./wire.js";

interface AcpDeltaTranslationContext {
  threadId?: string;
}

export interface AcpDeltaTranslatorOptions {
  cwd?: string | undefined;
  dialect?: AcpDialect | undefined;
}

export interface AcpPermissionToolCallInput {
  toolCallId: string;
  title?: string | undefined;
  kind?: AcpToolCallUpdateEvent["kind"];
  rawKind?: string | undefined;
  content?: AcpToolCallUpdateEvent["content"];
  locations?: AcpToolCallUpdateEvent["locations"];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface AcpBoundPermissionToolCall {
  toolCallId: string;
  event: AcpToolCallUpdateEvent | undefined;
}

const ASSISTANT_STREAM_KEY = "assistant";
const THOUGHT_STREAM_KEY = "thought";
const ACP_PLAN_STEP_STATUS_BY_ENTRY_STATUS = {
  pending: "pending",
  in_progress: "active",
  completed: "completed",
} as const;

const PLAN_STEPS_CHANNEL = "planSteps";

function isTerminalAcpStatus(
  status: AcpToolCallUpdateEvent["status"],
): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

function mapAcpToolCallStatus(
  status: AcpToolCallUpdateEvent["status"],
): ThreadEventItemStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "interrupted";
    default:
      return "pending";
  }
}

function mergeAcpToolCallEvents(
  started: AcpToolCallUpdateEvent | undefined,
  update: AcpToolCallUpdateEvent,
): AcpToolCallUpdateEvent {
  if (!started) {
    return update;
  }
  const { rawKind: startedRawKind, ...startedRest } = started;
  const kindFields =
    update.kind !== undefined
      ? {
          kind: update.kind,
          ...(update.rawKind !== undefined ? { rawKind: update.rawKind } : {}),
        }
      : startedRawKind !== undefined
        ? { rawKind: startedRawKind }
        : {};
  return {
    ...startedRest,
    ...kindFields,
    ...(update.title !== undefined ? { title: update.title } : {}),
    ...(update.name !== undefined ? { name: update.name } : {}),
    ...(update.status !== undefined ? { status: update.status } : {}),
    ...(update.content !== undefined ? { content: update.content } : {}),
    ...(update.locations !== undefined ? { locations: update.locations } : {}),
    ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
    ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
  };
}

interface AcpOpenToolCall {
  event: AcpToolCallUpdateEvent;
  clientFileWrites?: Extract<AcpToolCallContent, { type: "diff" }>[];
  openedType: DeltaItemShape["type"];
  permissionTitle?: string;
  delegation?: AcpDelegationReport;
}

export function createAcpDeltaTranslator(
  options: AcpDeltaTranslatorOptions = {},
) {
  const dialect = options.dialect ?? GENERIC_ACP_DIALECT;
  const pathOptions = { cwd: options.cwd };
  const mergedToolCalls = new Map<string, AcpOpenToolCall>();

  let injectedToolsByName = new Map<string, AcpInjectedTool>();
  const injectedToolBindings = new Map<string, AcpInjectedTool>();
  const pendingInjectedCalls = new Map<string, AcpInjectedTool[]>();

  function callKey(
    context: AcpDeltaTranslationContext | undefined,
    toolCallId: string,
  ): string {
    return `${context?.threadId ?? ""} ${toolCallId}`;
  }

  function threadCallEntries(
    context: AcpDeltaTranslationContext | undefined,
  ): [string, AcpOpenToolCall][] {
    const prefix = `${context?.threadId ?? ""} `;
    return [...mergedToolCalls.entries()].filter(([key]) =>
      key.startsWith(prefix),
    );
  }

  function withDialectIdentity(
    event: AcpToolCallUpdateEvent,
  ): AcpToolCallUpdateEvent {
    if (dialect.toolIdentity === undefined) {
      return event;
    }
    const identity = dialect.toolIdentity(event);
    if (identity === undefined) {
      return event;
    }
    return {
      ...event,
      ...(event.kind === undefined && identity.kind !== undefined
        ? { kind: identity.kind }
        : {}),
      ...(event.name === undefined && identity.name !== undefined
        ? { name: identity.name }
        : {}),
    };
  }

  function clearThreadCalls(
    context: AcpDeltaTranslationContext | undefined,
  ): void {
    for (const [key] of threadCallEntries(context)) {
      mergedToolCalls.delete(key);
      injectedToolBindings.delete(key);
    }
    pendingInjectedCalls.delete(context?.threadId ?? "");
  }

  function configureInjectedTools(tools: readonly AcpInjectedTool[]): void {
    injectedToolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  }

  function injectedToolNamedBy(
    event: AcpToolCallUpdateEvent,
  ): AcpInjectedTool | undefined {
    const title = event.title;
    if (title === undefined || injectedToolsByName.size === 0) {
      return undefined;
    }
    for (const tool of injectedToolsByName.values()) {
      if (title.includes(tool.name)) {
        return tool;
      }
    }
    return undefined;
  }

  function bindAnnouncedCall(
    context: AcpDeltaTranslationContext | undefined,
    event: AcpToolCallUpdateEvent,
  ): AcpInjectedTool | undefined {
    if (!isInjectedToolCandidate(event)) {
      return undefined;
    }
    const named = injectedToolNamedBy(event);
    if (named !== undefined) {
      return named;
    }
    return pendingInjectedCalls.get(context?.threadId ?? "")?.shift();
  }

  function noteInjectedToolCall(threadId: string, toolName: string): void {
    const tool = injectedToolsByName.get(toolName) ?? { name: toolName };
    const candidates = threadCallEntries({ threadId }).filter(
      ([key, open]) =>
        !injectedToolBindings.has(key) && isInjectedToolCandidate(open.event),
    );
    const chosen =
      candidates.find(([, open]) => open.event.title?.includes(tool.name)) ??
      candidates.find(([, open]) => /\bmcp\b/i.test(open.event.title ?? "")) ??
      candidates[0];
    if (chosen !== undefined) {
      injectedToolBindings.set(chosen[0], tool);
      return;
    }
    const queue = pendingInjectedCalls.get(threadId) ?? [];
    queue.push(tool);
    pendingInjectedCalls.set(threadId, queue);
  }

  function classifyCall(
    context: AcpDeltaTranslationContext | undefined,
    event: AcpToolCallUpdateEvent,
  ): AcpClassifiedToolCall {
    const injected = injectedToolBindings.get(
      callKey(context, event.toolCallId),
    );
    if (injected === undefined) {
      const dialectShape = dialect.classifyToolCall?.(event);
      if (dialectShape !== undefined) {
        return dialectShape;
      }
    }
    return classifyAcpToolCall(event, injected, pathOptions);
  }

  interface AcpFsWriteSnapshot {
    path: string;
    oldText?: string;
    content: string;
  }

  function withClientFileWrites(
    event: AcpToolCallUpdateEvent,
    writes: readonly Extract<AcpToolCallContent, { type: "diff" }>[],
  ): AcpToolCallUpdateEvent {
    if (writes.length === 0) {
      return event;
    }
    const paths = new Set(
      writes.map((write) => resolveAcpToolCallPath(write.path, pathOptions)),
    );
    return {
      ...event,
      content: [
        ...(event.content ?? []).filter(
          (entry) =>
            entry.type !== "diff" ||
            !paths.has(resolveAcpToolCallPath(entry.path, pathOptions)),
        ),
        ...writes,
      ],
    };
  }

  function mergeFsWriteIntoOpenToolCall(
    context: AcpDeltaTranslationContext | undefined,
    write: AcpFsWriteSnapshot,
  ): boolean {
    const writePath = resolveAcpToolCallPath(write.path, pathOptions);
    const fileChangeCalls = threadCallEntries(context).flatMap(
      ([key, open]) => {
        if (open.openedType !== "fileChange") {
          return [];
        }
        const classified = classifyCall(context, open.event);
        return classified.item.type === "fileChange"
          ? [
              {
                key,
                open,
                paths: classified.item.changes.map((change) => change.path),
              },
            ]
          : [];
      },
    );
    const exactMatches = fileChangeCalls.filter(({ paths }) =>
      paths.includes(writePath),
    );
    const pathPendingMatches = fileChangeCalls.filter(
      ({ paths }) => paths.length === 0,
    );
    const matching =
      exactMatches.length === 1
        ? exactMatches[0]
        : exactMatches.length === 0 && pathPendingMatches.length === 1
          ? pathPendingMatches[0]
          : undefined;
    if (matching === undefined) {
      return false;
    }

    const previous = matching.open.clientFileWrites?.find(
      (entry) => resolveAcpToolCallPath(entry.path, pathOptions) === writePath,
    );
    const oldText = previous === undefined ? write.oldText : previous.oldText;
    const diff: Extract<AcpToolCallContent, { type: "diff" }> = {
      type: "diff",
      path: write.path,
      ...(oldText === undefined ? {} : { oldText }),
      newText: write.content,
    };
    const clientFileWrites = [
      ...(matching.open.clientFileWrites ?? []).filter(
        (entry) =>
          resolveAcpToolCallPath(entry.path, pathOptions) !== writePath,
      ),
      diff,
    ];
    mergedToolCalls.set(matching.key, {
      ...matching.open,
      clientFileWrites,
      event: withClientFileWrites(matching.open.event, clientFileWrites),
    });
    return true;
  }

  function toRawEvent(rawEvent: JsonRpcMessage): ProviderRawEvent {
    const parsed = providerRawEventSchema.safeParse(rawEvent);
    if (parsed.success) {
      return parsed.data;
    }
    return {
      jsonrpc: "2.0",
      ...(rawEvent.id !== undefined ? { id: rawEvent.id } : {}),
      method: rawEvent.method,
      params: {
        serializationError:
          "Provider raw event params were not JSON-serializable.",
      },
    };
  }

  function noTurnFallbackFor(rawEvent: JsonRpcMessage): DeltaNoTurnFallback {
    return {
      raw: toRawEvent(rawEvent),
      rawType: acpVisibilityMetadata.describeRawEvent(rawEvent).kind,
    };
  }

  function updateEnvelope(
    context: AcpDeltaTranslationContext | undefined,
    update: AcpSessionUpdate,
  ): JsonRpcMessage {
    return {
      jsonrpc: "2.0",
      method: ACP_UPDATE_METHOD,
      params: {
        ...(context?.threadId ? { threadId: context.threadId } : {}),
        update,
      },
    };
  }

  function suppressedUnhandled(rawEvent: JsonRpcMessage): ThreadDelta[] {
    const fallback = noTurnFallbackFor(rawEvent);
    return [
      {
        kind: "unhandled",
        raw: fallback.raw,
        rawType: fallback.rawType,
        vouchedTurn: false,
        onlyIfNoTurn: true,
      },
    ];
  }

  function unhandledDeltas(rawEvent: JsonRpcMessage): ThreadDelta[] {
    const description = acpVisibilityMetadata.describeRawEvent(rawEvent);
    if (description.coverage !== "unknown") {
      return [];
    }
    return [
      {
        kind: "unhandled",
        raw: toRawEvent(rawEvent),
        rawType: description.kind,
        vouchedTurn: true,
      },
    ];
  }

  function closeThoughtStream(): ThreadDelta {
    return {
      kind: "item.textClose",
      key: { channel: THOUGHT_STREAM_KEY },
      channel: "reasoningText",
    };
  }

  function closeAssistantStream(): ThreadDelta {
    return {
      kind: "item.textClose",
      key: { channel: ASSISTANT_STREAM_KEY },
      channel: "agentMessage",
    };
  }

  interface AcpCloseArgs {
    context: AcpDeltaTranslationContext | undefined;
    event: AcpToolCallUpdateEvent;
    status: ThreadEventItemStatus;
    permissionTitle?: string | undefined;
    delegation?: AcpDelegationReport | undefined;
    noTurnFallback?: DeltaNoTurnFallback;
  }

  function withDelegationReport(
    classified: AcpClassifiedToolCall,
    report: AcpDelegationReport | undefined,
  ): AcpClassifiedToolCall {
    if (report === undefined || classified.item.type !== "delegation") {
      return classified;
    }
    return {
      item: {
        ...classified.item,
        childRef: report.childRef,
        label: report.label,
      },
      presentation: delegationPresentation({
        label: report.label,
        ...(report.detail === undefined ? {} : { detail: report.detail }),
      }),
    };
  }

  function withPermissionTitle(
    classified: AcpClassifiedToolCall,
    permissionTitle: string | undefined,
  ): AcpClassifiedToolCall {
    const title =
      permissionTitle === undefined
        ? undefined
        : presentationTitle(permissionTitle);
    return title === undefined
      ? classified
      : {
          item: classified.item,
          presentation: { ...classified.presentation, title },
        };
  }

  function toolCallClose(args: AcpCloseArgs): ThreadDelta {
    const classified = withPermissionTitle(
      withDelegationReport(
        classifyCall(args.context, args.event),
        args.delegation,
      ),
      args.permissionTitle,
    );
    injectedToolBindings.delete(callKey(args.context, args.event.toolCallId));
    const closeFields =
      classified.item.type === "command"
        ? commandCloseFields(args.event, args.status)
        : genericCloseFields(args.event);
    return {
      kind: "item.close",
      key: {
        providerItemId: args.event.toolCallId,
      },
      status: args.status,
      ...closeFields,
      item: classified.item,
      presentation: classified.presentation,
      ...(args.noTurnFallback ? { noTurnFallback: args.noTurnFallback } : {}),
    };
  }

  function commandCloseFields(
    event: AcpToolCallUpdateEvent,
    status: ThreadEventItemStatus,
  ): Pick<
    Extract<ThreadDelta, { kind: "item.close" }>,
    "aggregatedOutput" | "exitCode" | "resultText"
  > {
    const normalizedEvent = dialect.normalizeCommandEvent?.(event) ?? event;
    const result =
      dialect.commandResult?.(normalizedEvent) ??
      extractAcpCommandResult(normalizedEvent);
    const exitCode = result.exitCode ?? (status === "failed" ? 1 : undefined);
    return {
      ...(result.output === undefined
        ? {}
        : { aggregatedOutput: result.output, resultText: result.output }),
      ...(exitCode === undefined ? {} : { exitCode }),
    };
  }

  function genericCloseFields(
    event: AcpToolCallUpdateEvent,
  ): Pick<Extract<ThreadDelta, { kind: "item.close" }>, "resultText"> {
    const outputText = extractAcpToolCallOutputText(event);
    return outputText === undefined ? {} : { resultText: outputText };
  }

  function drainOpenToolCalls(
    context: AcpDeltaTranslationContext | undefined,
    status: ThreadEventItemStatus,
  ): ThreadDelta[] {
    const deltas: ThreadDelta[] = [];
    for (const [key, open] of threadCallEntries(context)) {
      mergedToolCalls.delete(key);
      deltas.push(
        toolCallClose({
          context,
          event: open.event,
          status,
          permissionTitle: open.permissionTitle,
          delegation: open.delegation,
        }),
      );
    }
    return deltas;
  }

  function flushOpenTurnWork(
    context: AcpDeltaTranslationContext | undefined,
    status: ThreadEventItemStatus,
  ): ThreadDelta[] {
    return [
      closeThoughtStream(),
      closeAssistantStream(),
      ...drainOpenToolCalls(context, status),
    ];
  }

  function translateUpdate(
    update: AcpSessionUpdate,
    context: AcpDeltaTranslationContext | undefined,
  ): ThreadDelta[] {
    const rawEvent = updateEnvelope(context, update);

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const parsed = acpAgentMessageChunkUpdateSchema.safeParse(update);
        const text = parsed.success
          ? extractAcpContentText(parsed.data.content)
          : undefined;
        if (text === undefined) {
          return suppressedUnhandled(rawEvent);
        }
        return [
          closeThoughtStream(),
          {
            kind: "item.textDelta",
            key: { channel: ASSISTANT_STREAM_KEY },
            channel: "agentMessage",
            text,
            noTurnFallback: noTurnFallbackFor(rawEvent),
          },
        ];
      }

      case "agent_thought_chunk": {
        const parsed = acpAgentThoughtChunkUpdateSchema.safeParse(update);
        const text = parsed.success
          ? extractAcpContentText(parsed.data.content)
          : undefined;
        if (text === undefined) {
          return suppressedUnhandled(rawEvent);
        }
        return [
          {
            kind: "item.textDelta",
            key: { channel: THOUGHT_STREAM_KEY },
            channel: "reasoningText",
            text,
            noTurnFallback: noTurnFallbackFor(rawEvent),
          },
        ];
      }

      case "tool_call": {
        const parsed = acpToolCallUpdateEventSchema.safeParse(update);
        if (!parsed.success) {
          return suppressedUnhandled(rawEvent);
        }
        const event = withDialectIdentity(parsed.data);
        const flush = [closeThoughtStream(), closeAssistantStream()];
        const announcedKey = callKey(context, event.toolCallId);
        const bound = bindAnnouncedCall(context, event);
        if (bound !== undefined) {
          injectedToolBindings.set(announcedKey, bound);
        }
        if (isTerminalAcpStatus(event.status)) {
          return [
            ...flush,
            toolCallClose({
              context,
              event,
              status: mapAcpToolCallStatus(event.status),
              noTurnFallback: noTurnFallbackFor(rawEvent),
            }),
          ];
        }
        const classified = classifyCall(context, event);
        mergedToolCalls.set(announcedKey, {
          event,
          openedType: classified.item.type,
        });
        return [
          ...flush,
          {
            kind: "item.open",
            key: {
              providerItemId: event.toolCallId,
            },
            item: classified.item,
            presentation: classified.presentation,
            noTurnFallback: noTurnFallbackFor(rawEvent),
          },
        ];
      }

      case "tool_call_update": {
        const parsed = acpToolCallUpdateEventSchema.safeParse(update);
        if (!parsed.success) {
          return suppressedUnhandled(rawEvent);
        }
        const event = withDialectIdentity(parsed.data);
        const key = callKey(context, event.toolCallId);
        const open = mergedToolCalls.get(key);
        const merged = withClientFileWrites(
          mergeAcpToolCallEvents(open?.event, event),
          open?.clientFileWrites ?? [],
        );
        if (isTerminalAcpStatus(merged.status)) {
          mergedToolCalls.delete(key);
          return [
            toolCallClose({
              context,
              event: merged,
              status: mapAcpToolCallStatus(merged.status),
              permissionTitle: open?.permissionTitle,
              delegation: open?.delegation,
              noTurnFallback: noTurnFallbackFor(rawEvent),
            }),
          ];
        }
        const mergedType = classifyCall(context, merged).item.type;
        mergedToolCalls.set(key, {
          event: merged,
          openedType: open?.openedType ?? mergedType,
          ...(open?.permissionTitle === undefined
            ? {}
            : { permissionTitle: open.permissionTitle }),
          ...(open?.delegation === undefined
            ? {}
            : { delegation: open.delegation }),
          ...(open?.clientFileWrites === undefined
            ? {}
            : { clientFileWrites: open.clientFileWrites }),
        });
        if (
          event.status === "in_progress" &&
          mergedType === "command" &&
          open?.openedType === "command"
        ) {
          const normalizedEvent =
            dialect.normalizeCommandEvent?.(event) ?? event;
          const streamed = extractAcpStreamedCommandOutput(normalizedEvent);
          return streamed === undefined
            ? suppressedUnhandled(rawEvent)
            : [
                {
                  kind: "command.outputSnapshot",
                  key: { providerItemId: event.toolCallId },
                  text: streamed,
                },
              ];
        }
        const progressText = extractAcpToolCallOutputText(event);
        if (progressText === undefined) {
          return suppressedUnhandled(rawEvent);
        }
        if (mergedType !== "command" && mergedType !== "fileChange") {
          return [
            {
              kind: "item.progress",
              key: {
                providerItemId: event.toolCallId,
              },
              message: progressText,
              noTurnFallback: noTurnFallbackFor(rawEvent),
            },
          ];
        }
        return suppressedUnhandled(rawEvent);
      }

      case "plan": {
        const parsed = acpPlanUpdateSchema.safeParse(update);
        if (!parsed.success) {
          return suppressedUnhandled(rawEvent);
        }
        const steps: ThreadEventPlanStep[] = parsed.data.entries.map(
          (entry) => ({
            step: entry.content,
            ...(entry.status
              ? { status: ACP_PLAN_STEP_STATUS_BY_ENTRY_STATUS[entry.status] }
              : {}),
          }),
        );
        return [
          {
            kind: "item.close",
            key: { channel: PLAN_STEPS_CHANNEL },
            status: "completed",
            item: { type: "planSteps", steps },
            presentation: planStepsPresentation(steps),
            noTurnFallback: noTurnFallbackFor(rawEvent),
          },
        ];
      }

      case "usage_update": {
        const parsed = acpUsageUpdateSchema.safeParse(update);
        if (!parsed.success) {
          return [];
        }
        return [
          {
            kind: "contextWindow",
            used: parsed.data.used,
            size: parsed.data.size,
            estimated: false,
            attach: "open",
          },
        ];
      }

      default:
        return unhandledDeltas(rawEvent);
    }
  }

  function turnStatusForStopReason(
    stopReason: AcpStopReason,
  ): ThreadEventTurnStatus {
    return stopReason === "end_turn"
      ? "completed"
      : stopReason === "cancelled"
        ? "interrupted"
        : "failed";
  }

  function itemStatusForTurnStatus(
    status: ThreadEventTurnStatus,
  ): ThreadEventItemStatus {
    return status === "completed"
      ? "completed"
      : status === "interrupted"
        ? "interrupted"
        : "failed";
  }

  function translateTurnCompleted(
    stopReason: AcpStopReason,
    context: AcpDeltaTranslationContext | undefined,
  ): ThreadDelta[] {
    const status = turnStatusForStopReason(stopReason);
    return [
      ...flushOpenTurnWork(context, itemStatusForTurnStatus(status)),
      {
        kind: "turn.boundary",
        status,
        ...(status === "failed"
          ? { error: { message: `Agent stopped the turn: ${stopReason}` } }
          : {}),
        claimIfIdle: true,
      },
    ];
  }

  function translateAcpEvent(
    event: ProviderRuntimeEvent,
    context?: AcpDeltaTranslationContext,
  ): ThreadDelta[] {
    const errorEnvelope = errorEnvelopeSchema.safeParse(event);
    if (errorEnvelope.success) {
      clearThreadCalls(context);
      return [
        {
          kind: "provider.error",
          message: "Provider error",
          detail: errorEnvelope.data.params?.message ?? "unknown error",
          settlesTurn: true,
        },
      ];
    }

    const envelope = jsonRpcEnvelopeSchema.safeParse(event);
    if (!envelope.success) {
      return [];
    }

    switch (envelope.data.method) {
      case ACP_TURN_STARTED_METHOD: {
        const params = acpTurnStartedNotificationParamsSchema.safeParse(
          envelope.data.params,
        );
        if (!params.success) {
          return [];
        }
        clearThreadCalls(context);
        return [{ kind: "turn.open" }];
      }

      case ACP_TURN_COMPLETED_METHOD: {
        const params = acpTurnCompletedNotificationParamsSchema.safeParse(
          envelope.data.params,
        );
        if (!params.success) {
          return [];
        }
        return translateTurnCompleted(params.data.stopReason, context);
      }

      case ACP_COMPACTION_STARTED_METHOD: {
        const params = acpTurnStartedNotificationParamsSchema.safeParse(
          envelope.data.params,
        );
        if (!params.success) {
          return [];
        }
        clearThreadCalls(context);
        return [
          { kind: "turn.open" },
          {
            kind: "item.open",
            key: { channel: "compaction" },
            item: { type: "compaction" },
            presentation: COMPACTION_PRESENTATION,
          },
        ];
      }

      case ACP_COMPACTION_COMPLETED_METHOD: {
        const params = acpCompactionCompletedNotificationParamsSchema.safeParse(
          envelope.data.params,
        );
        if (!params.success) {
          return [];
        }
        const status = params.data.status;
        const turnStatus: ThreadEventTurnStatus =
          status === "skipped" ? "completed" : status;
        return [
          ...flushOpenTurnWork(context, itemStatusForTurnStatus(turnStatus)),
          ...(status === "completed"
            ? ([{ kind: "context.compacted" }] as ThreadDelta[])
            : []),
          ...(status === "skipped"
            ? ([
                {
                  kind: "provider.warning",
                  category: "compaction-skipped",
                  summary: "Context compaction skipped",
                  details: params.data.detail,
                  vouchedTurn: true,
                },
              ] as ThreadDelta[])
            : []),
          {
            kind: "turn.boundary",
            status: turnStatus,
            ...(status === "failed"
              ? { error: { message: params.data.error } }
              : {}),
          },
        ];
      }

      case ACP_UPDATE_METHOD: {
        const params = acpUpdateNotificationParamsSchema.safeParse(
          envelope.data.params,
        );
        if (!params.success) {
          return [];
        }
        return translateUpdate(params.data.update, context);
      }

      case ACP_FS_WRITE_METHOD: {
        const params = acpFsWriteNotificationParamsSchema.safeParse(
          envelope.data.params,
        );
        if (!params.success) {
          return [];
        }
        if (mergeFsWriteIntoOpenToolCall(context, params.data)) {
          return [];
        }
        const rawEvent: JsonRpcMessage = {
          jsonrpc: "2.0",
          method: ACP_FS_WRITE_METHOD,
          params: params.data,
        };
        return [
          {
            kind: "item.close",
            key: { channel: "fs-write" },
            status: "completed",
            item: {
              type: "fileChange",
              changes: [
                {
                  path: params.data.path,
                  kind: params.data.kind,
                  ...(params.data.oldText === undefined
                    ? {}
                    : { oldText: params.data.oldText }),
                  newText: params.data.content,
                },
              ],
            },
            presentation: fileChangePresentation({
              verb: params.data.kind,
              paths: [params.data.path],
            }),
            noTurnFallback: noTurnFallbackFor(rawEvent),
          },
        ];
      }

      case ACP_WARNING_METHOD: {
        const params = acpWarningNotificationParamsSchema.safeParse(
          envelope.data.params,
        );
        if (!params.success) {
          return [];
        }
        return [
          {
            kind: "provider.warning",
            summary: params.data.summary,
            ...(params.data.details ? { details: params.data.details } : {}),
            vouchedTurn: true,
          },
        ];
      }

      default:
        return unhandledDeltas({
          jsonrpc: "2.0",
          method: envelope.data.method,
          ...(envelope.data.params ? { params: envelope.data.params } : {}),
        });
    }
  }

  function notePermissionToolCall(
    threadId: string,
    toolCall: AcpPermissionToolCallInput,
  ): AcpBoundPermissionToolCall {
    const context = { threadId };
    const ownKey = callKey(context, toolCall.toolCallId);
    let boundKey: string | undefined = mergedToolCalls.has(ownKey)
      ? ownKey
      : undefined;
    if (boundKey === undefined) {
      const sameKind = threadCallEntries(context).filter(
        ([, open]) =>
          toolCall.kind !== undefined && open.event.kind === toolCall.kind,
      );
      boundKey = sameKind.length === 1 ? sameKind[0]?.[0] : undefined;
    }
    const open =
      boundKey === undefined ? undefined : mergedToolCalls.get(boundKey);
    if (boundKey === undefined || open === undefined) {
      return { toolCallId: toolCall.toolCallId, event: undefined };
    }
    if (classifyCall(context, open.event).item.type !== "tool") {
      return { toolCallId: open.event.toolCallId, event: open.event };
    }
    const kind =
      toolCall.kind !== undefined &&
      (toolCall.kind !== "other" || open.event.kind === undefined)
        ? toolCall.kind
        : undefined;
    const merged = mergeAcpToolCallEvents(open.event, {
      sessionUpdate: "tool_call_update",
      toolCallId: open.event.toolCallId,
      ...(toolCall.title !== undefined ? { title: toolCall.title } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(kind === "other" && toolCall.rawKind !== undefined
        ? { rawKind: toolCall.rawKind }
        : {}),
      ...(toolCall.locations !== undefined
        ? { locations: toolCall.locations }
        : {}),
      ...(toolCall.rawInput !== undefined
        ? { rawInput: toolCall.rawInput }
        : {}),
      ...(toolCall.rawOutput !== undefined
        ? { rawOutput: toolCall.rawOutput }
        : {}),
    });
    if (classifyCall(context, merged).item.type === open.openedType) {
      mergedToolCalls.set(boundKey, { ...open, event: merged });
      return { toolCallId: merged.toolCallId, event: merged };
    }
    mergedToolCalls.set(boundKey, {
      ...open,
      ...(toolCall.title === undefined
        ? {}
        : { permissionTitle: toolCall.title }),
    });
    return { toolCallId: open.event.toolCallId, event: merged };
  }

  function noteDelegationReport(
    threadId: string,
    report: AcpDelegationReport,
  ): ThreadDelta[] {
    const context = { threadId };
    const key = callKey(context, report.toolCallId);
    const open = mergedToolCalls.get(key);
    if (open === undefined) {
      return [];
    }
    const classified = classifyCall(context, open.event);
    if (classified.item.type !== "delegation") {
      return [];
    }
    const item: DeltaItemShape = {
      ...classified.item,
      childRef: report.childRef,
      label: report.label,
    };
    mergedToolCalls.set(key, { ...open, delegation: report });
    return [
      {
        kind: "item.open",
        key: { providerItemId: report.toolCallId },
        item,
        presentation: delegationPresentation({
          label: report.label,
          ...(report.detail === undefined ? {} : { detail: report.detail }),
        }),
      },
    ];
  }

  function getInjectedToolBinding(
    threadId: string,
    toolCallId: string,
  ): AcpInjectedTool | undefined {
    return injectedToolBindings.get(callKey({ threadId }, toolCallId));
  }

  return {
    configureInjectedTools,
    getInjectedToolBinding,
    noteDelegationReport,
    noteInjectedToolCall,
    notePermissionToolCall,
    translateAcpEvent,
  };
}

export type AcpDeltaTranslator = ReturnType<typeof createAcpDeltaTranslator>;

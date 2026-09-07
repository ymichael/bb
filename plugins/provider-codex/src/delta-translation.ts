import {
  type ProviderErrorCategory,
  type ProviderErrorInfo,
  type ProviderRateLimitState,
  type ProviderRateLimitStatus,
  type ProviderRateLimitWindow,
  providerRawEventSchema,
  type DeltaItemShape,
  type DeltaPresentation,
  type ProviderRawEvent,
  type ThreadDelta,
  type ThreadEventItemStatus,
  type ThreadEventTurnStatus,
  type JsonRpcMessage,
  type ProviderRuntimeEvent,
  experimental_COMPACTION_PRESENTATION as COMPACTION_PRESENTATION,
  experimental_REASONING_PRESENTATION as REASONING_PRESENTATION,
  experimental_toolPresentation as toolPresentation,
  experimental_webFetchPresentation as webFetchPresentation,
  experimental_webSearchPresentation as webSearchPresentation,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  codexBridgeEnvelopeSchema,
  codexHandledEventSchema,
  codexHandledThreadItemSchema,
  isHandledCodexMethod,
  type CodexDynamicToolCallContentItem,
  type CodexErrorInfo,
  type CodexHandledEvent,
  type CodexHandledThreadItem,
  type CodexItemStatus,
  type CodexRateLimitSnapshot,
  type CodexRateLimitSnapshotUpdate,
  type CodexTurnStatus,
} from "./schemas.js";
import {
  AGENT_MESSAGE_PRESENTATION,
  PLAN_PRESENTATION,
  collabAgentPresentation,
  commandPresentation,
  fileChangePresentation,
  imageViewPresentation,
  mcpToolPresentation,
  planStepsPresentation,
} from "./presentation.js";
import {
  CODEX_GOAL_EXTENSION_KIND,
  type CodexGoalState,
} from "./extension-kinds.js";
import { codexVisibilityMetadata } from "./visibility.js";

function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

export interface CodexInjectedTool {
  name: string;
  presentation?: DeltaPresentation;
}

interface CodexRetryErrorContext {
  errorInfo: CodexErrorInfo;
  failureText: string;
}

interface CodexEventTranslationState {
  rateLimitsByLimitId: Map<string, CodexRateLimitSnapshot>;
  injectedToolsByName: Map<string, CodexInjectedTool>;
  retryErrorsByTurnKey: Map<string, CodexRetryErrorContext>;
}

export function createCodexEventTranslationState(): CodexEventTranslationState {
  return {
    rateLimitsByLimitId: new Map(),
    injectedToolsByName: new Map(),
    retryErrorsByTurnKey: new Map(),
  };
}

export function setCodexInjectedTools(
  state: CodexEventTranslationState,
  tools: readonly CodexInjectedTool[],
): void {
  state.injectedToolsByName = new Map(tools.map((tool) => [tool.name, tool]));
}

function clampRateLimitPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function codexWindowStatus(usedPercent: number): ProviderRateLimitStatus {
  if (usedPercent >= 100) return "blocked";
  if (usedPercent >= 90) return "warning";
  return "allowed";
}

function normalizeCodexRateLimitWindow(
  key: "primary" | "secondary",
  window: CodexRateLimitSnapshot["primary"],
): ProviderRateLimitWindow | null {
  if (!window) return null;
  const usedPercent = clampRateLimitPercent(window.usedPercent);
  const label =
    window.windowDurationMins === 10_080
      ? "Weekly limit"
      : window.windowDurationMins === 300
        ? "Current session"
        : key === "primary"
          ? "Current session"
          : "Weekly limit";
  return {
    providerKey: key,
    label,
    status: codexWindowStatus(usedPercent),
    resetsAtMs: window.resetsAt === null ? null : window.resetsAt * 1_000,
  };
}

function codexReachedReasonIsActive(
  snapshot: CodexRateLimitSnapshot,
  reachedReason: string,
): boolean {
  if (reachedReason === "rate_limit_reached") {
    return [snapshot.primary, snapshot.secondary].some(
      (window) => window !== null && window.usedPercent >= 100,
    );
  }
  if (reachedReason.includes("credits_depleted")) {
    return (
      snapshot.credits !== null &&
      !snapshot.credits.unlimited &&
      !snapshot.credits.hasCredits
    );
  }
  if (reachedReason.includes("usage_limit_reached")) {
    return (
      snapshot.individualLimit !== null &&
      snapshot.individualLimit.remainingPercent <= 0
    );
  }
  return false;
}

function mergeCodexRateLimitSnapshot(
  previous: CodexRateLimitSnapshot | null,
  update: CodexRateLimitSnapshotUpdate,
  limitId: string,
): CodexRateLimitSnapshot {
  const merged: CodexRateLimitSnapshot = {
    limitId,
    limitName: update.limitName ?? previous?.limitName ?? null,
    primary: update.primary ?? previous?.primary ?? null,
    secondary: update.secondary ?? previous?.secondary ?? null,
    credits: update.credits ?? previous?.credits ?? null,
    individualLimit:
      update.individualLimit ?? previous?.individualLimit ?? null,
    spendControlReached: update.spendControlReached ?? null,
    planType: update.planType ?? previous?.planType ?? null,
    rateLimitReachedType: update.rateLimitReachedType ?? null,
  };
  if (
    merged.rateLimitReachedType === null &&
    previous?.rateLimitReachedType !== null &&
    previous?.rateLimitReachedType !== undefined &&
    codexReachedReasonIsActive(merged, previous.rateLimitReachedType)
  ) {
    merged.rateLimitReachedType = previous.rateLimitReachedType;
  }
  return merged;
}

export function applyCodexRateLimitUpdate(
  state: CodexEventTranslationState,
  update: CodexRateLimitSnapshotUpdate,
): CodexRateLimitSnapshot {
  const limitId = update.limitId ?? "codex";
  const rateLimits = mergeCodexRateLimitSnapshot(
    state.rateLimitsByLimitId.get(limitId) ?? null,
    update,
    limitId,
  );
  state.rateLimitsByLimitId.set(limitId, rateLimits);
  return rateLimits;
}

function normalizeCodexRateLimitSnapshot(
  snapshot: CodexRateLimitSnapshot,
): ProviderRateLimitState {
  const windows = [
    normalizeCodexRateLimitWindow("primary", snapshot.primary),
    normalizeCodexRateLimitWindow("secondary", snapshot.secondary),
  ].filter((window): window is ProviderRateLimitWindow => window !== null);

  if (snapshot.individualLimit) {
    const usedPercent = clampRateLimitPercent(
      100 - snapshot.individualLimit.remainingPercent,
    );
    windows.push({
      providerKey: "individual-limit",
      label: "Spend control",
      status: codexWindowStatus(usedPercent),
      resetsAtMs: snapshot.individualLimit.resetsAt * 1_000,
    });
  }

  const reachedReason = snapshot.rateLimitReachedType;
  const isIndividualLimitBlocked =
    snapshot.individualLimit !== null &&
    snapshot.individualLimit.remainingPercent <= 0;
  const kind =
    reachedReason === "rate_limit_reached"
      ? "subscription-window"
      : reachedReason?.includes("credits_depleted")
        ? "credits"
        : reachedReason?.includes("usage_limit_reached")
          ? "spend-control"
          : reachedReason !== null
            ? "unknown"
            : isIndividualLimitBlocked
              ? "spend-control"
              : snapshot.primary !== null || snapshot.secondary !== null
                ? "subscription-window"
                : snapshot.individualLimit !== null
                  ? "spend-control"
                  : "unknown";
  const status =
    reachedReason !== null
      ? "blocked"
      : windows.some((window) => window.status === "blocked")
        ? "blocked"
        : windows.some((window) => window.status === "warning")
          ? "warning"
          : windows.length > 0 || snapshot.credits?.hasCredits === true
            ? "allowed"
            : "unknown";
  const isSpendControlBlocked = snapshot.spendControlReached === true;

  return {
    providerId: "codex",
    status: isSpendControlBlocked ? "blocked" : status,
    kind: isSpendControlBlocked ? "spend-control" : kind,
    windows,
    reachedReason,
    overageStatus: null,
    overageReason: null,
  };
}

function rateLimitStatusRank(status: ProviderRateLimitStatus): number {
  switch (status) {
    case "blocked":
      return 3;
    case "warning":
      return 2;
    case "allowed":
      return 1;
    case "unknown":
      return 0;
    default:
      return assertNever(status);
  }
}

type CodexRateLimitCandidate = {
  explicitlyBlocked: boolean;
  limitId: string;
  nonResettableBlock: boolean;
  rateLimits: ProviderRateLimitState;
};

function normalizeCodexRateLimits(
  state: CodexEventTranslationState,
  preferredLimitId: string,
): ProviderRateLimitState {
  const candidates: CodexRateLimitCandidate[] = [];
  for (const limitId of new Set(["codex", preferredLimitId])) {
    const snapshot = state.rateLimitsByLimitId.get(limitId);
    if (snapshot === undefined) continue;
    const rateLimits = normalizeCodexRateLimitSnapshot(snapshot);
    candidates.push({
      explicitlyBlocked:
        snapshot.rateLimitReachedType !== null ||
        snapshot.spendControlReached === true,
      limitId,
      nonResettableBlock:
        rateLimits.status === "blocked" &&
        rateLimits.kind !== "subscription-window",
      rateLimits,
    });
  }
  let selected: CodexRateLimitCandidate | undefined;
  for (const candidate of candidates) {
    const { explicitlyBlocked, limitId, rateLimits } = candidate;
    const selectedExplicitlyBlocked = selected?.explicitlyBlocked ?? false;
    if (
      selected === undefined ||
      rateLimitStatusRank(rateLimits.status) >
        rateLimitStatusRank(selected.rateLimits.status) ||
      (rateLimits.status === selected.rateLimits.status &&
        candidate.nonResettableBlock &&
        !selected.nonResettableBlock) ||
      (rateLimits.status === selected.rateLimits.status &&
        candidate.nonResettableBlock === selected.nonResettableBlock &&
        explicitlyBlocked &&
        !selectedExplicitlyBlocked) ||
      (rateLimits.status === selected.rateLimits.status &&
        candidate.nonResettableBlock === selected.nonResettableBlock &&
        explicitlyBlocked === selectedExplicitlyBlocked &&
        limitId === preferredLimitId)
    ) {
      selected = candidate;
    }
  }
  if (selected === undefined) {
    throw new Error("Expected at least one Codex rate-limit snapshot");
  }
  const windows = candidates.flatMap((candidate) =>
    candidate === selected
      ? candidate.rateLimits.windows
      : candidate.rateLimits.status === "blocked"
        ? candidate.rateLimits.windows.filter(
            (window) => window.status === "blocked",
          )
        : [],
  );
  return windows.length === selected.rateLimits.windows.length
    ? selected.rateLimits
    : { ...selected.rateLimits, windows };
}

type CodexErrorEvent = Extract<CodexHandledEvent, { method: "error" }>;
type CodexErrorParams = CodexErrorEvent["params"];

type CodexItemTranslationResult =
  | {
      kind: "translated";
      shape: DeltaItemShape;
      presentation: DeltaPresentation;
      status: ThreadEventItemStatus;
      approvalDenied: boolean;
    }
  | { kind: "ignored" }
  | { kind: "unhandled" };

function getCodexErrorProviderCode(errorInfo: CodexErrorInfo): string {
  if (typeof errorInfo === "string") {
    return errorInfo;
  }
  if ("httpConnectionFailed" in errorInfo) {
    return "httpConnectionFailed";
  }
  if ("responseStreamConnectionFailed" in errorInfo) {
    return "responseStreamConnectionFailed";
  }
  if ("responseStreamDisconnected" in errorInfo) {
    return "responseStreamDisconnected";
  }
  if ("responseTooManyFailedAttempts" in errorInfo) {
    return "responseTooManyFailedAttempts";
  }
  if ("activeTurnNotSteerable" in errorInfo) {
    return "activeTurnNotSteerable";
  }
  return assertNever(errorInfo);
}

function getCodexErrorHttpStatusCode(errorInfo: CodexErrorInfo): number | null {
  if (typeof errorInfo === "string") {
    return null;
  }
  if ("httpConnectionFailed" in errorInfo) {
    return errorInfo.httpConnectionFailed.httpStatusCode;
  }
  if ("responseStreamConnectionFailed" in errorInfo) {
    return errorInfo.responseStreamConnectionFailed.httpStatusCode;
  }
  if ("responseStreamDisconnected" in errorInfo) {
    return errorInfo.responseStreamDisconnected.httpStatusCode;
  }
  if ("responseTooManyFailedAttempts" in errorInfo) {
    return errorInfo.responseTooManyFailedAttempts.httpStatusCode;
  }
  if ("activeTurnNotSteerable" in errorInfo) {
    return null;
  }
  return assertNever(errorInfo);
}

function getProviderErrorCategory(
  errorInfo: CodexErrorInfo,
): ProviderErrorCategory {
  if (typeof errorInfo === "string") {
    switch (errorInfo) {
      case "contextWindowExceeded":
        return "context-window-exceeded";
      case "sessionBudgetExceeded":
        return "budget-exceeded";
      case "usageLimitExceeded":
        return "rate-limit";
      case "serverOverloaded":
        return "overloaded";
      case "cyberPolicy":
      case "misalignmentPolicyViolation":
        return "policy";
      case "internalServerError":
        return "internal";
      case "unauthorized":
        return "unauthorized";
      case "badRequest":
        return "bad-request";
      case "threadRollbackFailed":
        return "thread-rollback-failed";
      case "sandboxError":
        return "sandbox";
      case "other":
        return "unknown";
    }
  }
  if ("httpConnectionFailed" in errorInfo) {
    return "connection-failed";
  }
  if ("responseStreamConnectionFailed" in errorInfo) {
    return "connection-failed";
  }
  if ("responseStreamDisconnected" in errorInfo) {
    return "stream-disconnected";
  }
  if ("responseTooManyFailedAttempts" in errorInfo) {
    return "too-many-failed-attempts";
  }
  if ("activeTurnNotSteerable" in errorInfo) {
    return "active-turn-not-steerable";
  }
  return assertNever(errorInfo);
}

function toProviderErrorInfo(
  errorInfo: CodexErrorInfo | null | undefined,
): ProviderErrorInfo | null {
  if (!errorInfo) {
    return null;
  }
  return {
    category: getProviderErrorCategory(errorInfo),
    providerCode: getCodexErrorProviderCode(errorInfo),
    httpStatusCode: getCodexErrorHttpStatusCode(errorInfo),
  };
}

function codexTurnKey(scope: { threadId: string; turnId?: string }): string {
  return `${scope.threadId}\0${scope.turnId ?? ""}`;
}

function takeCodexRetryError(
  state: CodexEventTranslationState,
  scope: { threadId: string; turnId?: string },
): CodexRetryErrorContext | undefined {
  const key = codexTurnKey(scope);
  const retryError = state.retryErrorsByTurnKey.get(key);
  state.retryErrorsByTurnKey.delete(key);
  return retryError;
}

export function clearCodexEventTranslationThreadState(
  state: CodexEventTranslationState,
  threadId: string,
): void {
  const prefix = codexTurnKey({ threadId });
  for (const key of state.retryErrorsByTurnKey.keys()) {
    if (key.startsWith(prefix)) {
      state.retryErrorsByTurnKey.delete(key);
    }
  }
}

function resolveCodexErrorInfo(
  state: CodexEventTranslationState,
  params: CodexErrorParams,
): CodexErrorInfo | null | undefined {
  const errorInfo = params.error.codexErrorInfo;
  const failureText = params.error.additionalDetails ?? params.error.message;
  if (params.willRetry === true) {
    if (errorInfo && errorInfo !== "other") {
      state.retryErrorsByTurnKey.set(codexTurnKey(params), {
        errorInfo,
        failureText,
      });
    }
    return errorInfo;
  }
  if (params.willRetry !== false) {
    return errorInfo;
  }
  const retryError = takeCodexRetryError(state, params);
  return errorInfo === "other" && retryError?.failureText === failureText
    ? retryError.errorInfo
    : errorInfo;
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

interface CodexUnhandledDeltaArgs {
  rawEvent: JsonRpcMessage;
  rawType?: string;
  providerTurnId?: string;
  parentRef?: string;
}

function buildUnhandledCodexDeltas(
  args: CodexUnhandledDeltaArgs,
): ThreadDelta[] {
  const description = codexVisibilityMetadata.describeRawEvent(args.rawEvent);
  if (description.coverage !== "unknown" && args.rawType === undefined) {
    return [];
  }

  return [
    {
      kind: "unhandled",
      raw: toRawEvent(args.rawEvent),
      rawType: args.rawType ?? description.kind,
      vouchedTurn: args.providerTurnId !== undefined,
      ...(args.providerTurnId !== undefined
        ? { providerTurnId: args.providerTurnId }
        : {}),
      ...(args.parentRef !== undefined ? { parentRef: args.parentRef } : {}),
    },
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

interface CodexWebItemTranslation {
  shape: DeltaItemShape;
  presentation: DeltaPresentation;
}

function normalizeCodexWebItemShape(
  item: Extract<CodexHandledThreadItem, { type: "webSearch" }>,
): CodexWebItemTranslation | null {
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
        shape: { type: "webSearch", queries },
        presentation: webSearchPresentation(queries[0]),
      };
    }
    case "openPage": {
      const url = normalizeCodexUrl({ actionUrl: item.action.url });
      if (!url) {
        return null;
      }
      return {
        shape: { type: "webFetch", url, pattern: null },
        presentation: webFetchPresentation(url),
      };
    }
    case "findInPage": {
      const url = normalizeCodexUrl({ actionUrl: item.action.url });
      if (!url) {
        return null;
      }
      return {
        shape: { type: "webFetch", url, pattern: item.action.pattern ?? null },
        presentation: webFetchPresentation(url),
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

function toolStatusFields(status: CodexItemStatus): {
  status: ThreadEventItemStatus;
  approvalDenied: boolean;
} {
  return {
    status: toItemStatus(status),
    approvalDenied: status === "declined",
  };
}

const PLAN_STEPS_CHANNEL = "planSteps";

const BB_TOOL_SERVER = "bb";

function isTerminalCodexItemStatus(status: CodexItemStatus): boolean {
  return status !== "inProgress";
}

type CodexCollabAgentToolCall = Extract<
  CodexHandledThreadItem,
  { type: "collabAgentToolCall" }
>;

const COLLAB_DELEGATION_VERBS: Readonly<Record<string, string>> = {
  spawnAgent: "Spawn agent",
  wait: "Wait for agent",
  resumeAgent: "Resume agent",
  sendInput: "Send input to agent",
  closeAgent: "Close agent",
};

function collabDelegationLabel(item: CodexCollabAgentToolCall): string {
  if (item.prompt !== null && item.prompt.trim().length > 0) {
    return item.prompt.trim();
  }
  return COLLAB_DELEGATION_VERBS[item.tool] ?? item.tool;
}

function summarizeCollabAgentsStates(
  agentsStates: Record<string, unknown>,
): string | undefined {
  const lines = Object.entries(agentsStates).map(([agentThreadId, state]) => {
    const rendered = typeof state === "string" ? state : JSON.stringify(state);
    return `${agentThreadId}: ${rendered}`;
  });
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function translateCodexItemShape(
  item: unknown,
  state: CodexEventTranslationState,
): CodexItemTranslationResult {
  const parsed = codexHandledThreadItemSchema.safeParse(item);
  if (!parsed.success) {
    return { kind: "unhandled" };
  }

  const parsedItem: CodexHandledThreadItem = parsed.data;
  switch (parsedItem.type) {
    case "agentMessage":
      return {
        kind: "translated",
        shape: { type: "agentMessage", text: parsedItem.text },
        presentation: AGENT_MESSAGE_PRESENTATION,
        status: "completed",
        approvalDenied: false,
      };
    case "userMessage":
      return { kind: "ignored" };
    case "commandExecution":
      return {
        kind: "translated",
        shape: {
          type: "command",
          command: parsedItem.command,
          cwd: parsedItem.cwd,
          ...(parsedItem.aggregatedOutput === null
            ? {}
            : { aggregatedOutput: parsedItem.aggregatedOutput }),
          ...(parsedItem.exitCode === null
            ? {}
            : { exitCode: parsedItem.exitCode }),
          ...(parsedItem.durationMs === null
            ? {}
            : { durationMs: parsedItem.durationMs }),
        },
        presentation: commandPresentation(parsedItem.command),
        ...toolStatusFields(parsedItem.status),
      };
    case "fileChange":
      return {
        kind: "translated",
        shape: {
          type: "fileChange",
          changes: parsedItem.changes.map((change) => ({
            path: change.path,
            kind: change.kind.type,
            ...(change.kind.type === "update" && change.kind.move_path
              ? { movePath: change.kind.move_path }
              : {}),
            ...(change.diff ? { diff: change.diff } : {}),
          })),
        },
        presentation: fileChangePresentation(
          parsedItem.changes.map((change) => change.path),
        ),
        ...toolStatusFields(parsedItem.status),
      };
    case "mcpToolCall":
      return {
        kind: "translated",
        shape: {
          type: "tool",
          server: parsedItem.server,
          tool: parsedItem.tool,
          ...(parsedItem.arguments === undefined
            ? {}
            : { args: parsedItem.arguments }),
          ...(parsedItem.error?.message === undefined
            ? {}
            : { error: parsedItem.error.message }),
          ...(parsedItem.durationMs === null ||
          parsedItem.durationMs === undefined
            ? {}
            : { durationMs: parsedItem.durationMs }),
        },
        presentation: mcpToolPresentation({
          server: parsedItem.server,
          tool: parsedItem.tool,
          args: parsedItem.arguments,
        }),
        ...toolStatusFields(parsedItem.status),
      };
    case "dynamicToolCall": {
      const result = extractDynamicToolCallResult(parsedItem.contentItems);
      const error = buildDynamicToolCallError(parsedItem.success, result);
      const injected = state.injectedToolsByName.get(parsedItem.tool);
      return {
        kind: "translated",
        shape: {
          type: "tool",
          ...(injected === undefined ? {} : { server: BB_TOOL_SERVER }),
          tool: parsedItem.tool,
          ...(parsedItem.arguments === undefined
            ? {}
            : { args: parsedItem.arguments }),
          ...(result === undefined ? {} : { result }),
          ...(error === undefined ? {} : { error }),
          ...(parsedItem.durationMs === null ||
          parsedItem.durationMs === undefined
            ? {}
            : { durationMs: parsedItem.durationMs }),
        },
        presentation:
          injected?.presentation ?? toolPresentation(parsedItem.tool),
        ...toolStatusFields(parsedItem.status),
      };
    }
    case "collabAgentToolCall": {
      const presentation = collabAgentPresentation({
        tool: parsedItem.tool,
        prompt: parsedItem.prompt,
      });
      const childRef = parsedItem.receiverThreadIds[0];
      if (childRef !== undefined && childRef.length > 0) {
        return {
          kind: "translated",
          shape: {
            type: "delegation",
            childRef,
            label: collabDelegationLabel(parsedItem),
            background: false,
            ...(isTerminalCodexItemStatus(parsedItem.status)
              ? {
                  summary: summarizeCollabAgentsStates(parsedItem.agentsStates),
                }
              : {}),
          },
          presentation,
          ...toolStatusFields(parsedItem.status),
        };
      }
      return {
        kind: "translated",
        shape: {
          type: "tool",
          tool: parsedItem.tool,
          args: {
            senderThreadId: parsedItem.senderThreadId,
            receiverThreadIds: parsedItem.receiverThreadIds,
            ...(parsedItem.prompt ? { prompt: parsedItem.prompt } : {}),
            ...(parsedItem.model ? { model: parsedItem.model } : {}),
            ...(parsedItem.reasoningEffort
              ? { reasoningEffort: parsedItem.reasoningEffort }
              : {}),
          },
          result: parsedItem.agentsStates,
        },
        presentation,
        ...toolStatusFields(parsedItem.status),
      };
    }
    case "subAgentActivity":
      return { kind: "ignored" };
    case "webSearch": {
      if (shouldIgnoreCodexWebItem(parsedItem)) {
        return { kind: "ignored" };
      }
      const translation = normalizeCodexWebItemShape(parsedItem);
      return translation
        ? {
            kind: "translated",
            shape: translation.shape,
            presentation: translation.presentation,
            status: "completed",
            approvalDenied: false,
          }
        : { kind: "unhandled" };
    }
    case "imageView":
      return {
        kind: "translated",
        shape: { type: "imageView", path: parsedItem.path },
        presentation: imageViewPresentation(parsedItem.path),
        status: "completed",
        approvalDenied: false,
      };
    case "reasoning":
      return {
        kind: "translated",
        shape: {
          type: "reasoning",
          summary: parsedItem.summary,
          content: parsedItem.content,
        },
        presentation: REASONING_PRESENTATION,
        status: "completed",
        approvalDenied: false,
      };
    case "plan":
      return {
        kind: "translated",
        shape: { type: "plan", text: parsedItem.text },
        presentation: PLAN_PRESENTATION,
        status: "completed",
        approvalDenied: false,
      };
    case "contextCompaction":
      return {
        kind: "translated",
        shape: { type: "compaction" },
        presentation: COMPACTION_PRESENTATION,
        status: "completed",
        approvalDenied: false,
      };
    default:
      return assertNever(parsedItem);
  }
}

export function translateCodexEventToDeltas(
  event: ProviderRuntimeEvent,
  state: CodexEventTranslationState,
): ThreadDelta[] {
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
      ? buildUnhandledCodexDeltas({ rawEvent, rawType: rawEvent.method })
      : buildUnhandledCodexDeltas({ rawEvent });
  }

  const handledEvent: CodexHandledEvent = parsed.data;
  switch (handledEvent.method) {
    case "account/rateLimits/updated": {
      const rateLimits = applyCodexRateLimitUpdate(
        state,
        handledEvent.params.rateLimits,
      );
      return [
        {
          kind: "provider.rateLimits",
          rateLimits: normalizeCodexRateLimits(
            state,
            rateLimits.limitId ?? "codex",
          ),
        },
      ];
    }
    case "turn/started":
      return [
        { kind: "turn.open", providerTurnId: handledEvent.params.turn.id },
      ];
    case "turn/completed": {
      takeCodexRetryError(state, {
        threadId: handledEvent.params.threadId,
        turnId: handledEvent.params.turn.id,
      });
      const status = toTurnStatus(handledEvent.params.turn.status);
      return [
        {
          kind: "turn.boundary",
          providerTurnId: handledEvent.params.turn.id,
          status,
          ...(handledEvent.params.turn.error?.message
            ? { error: { message: handledEvent.params.turn.error.message } }
            : {}),
          ...(status === "completed" || status === "interrupted"
            ? { providerCheckpointId: handledEvent.params.turn.id }
            : {}),
        },
      ];
    }
    case "thread/started": {
      const deltas: ThreadDelta[] = [
        { kind: "thread.started" },
        {
          kind: "thread.identity",
          providerThreadId: handledEvent.params.thread.id,
        },
      ];
      if (handledEvent.params.thread.preview) {
        deltas.push({
          kind: "thread.name",
          name: handledEvent.params.thread.preview,
        });
      }
      return deltas;
    }
    case "thread/archived":
    case "thread/unarchived":
      return [];
    case "thread/name/updated":
      return handledEvent.params.threadName
        ? [{ kind: "thread.name", name: handledEvent.params.threadName }]
        : [];
    case "thread/compacted":
      return [
        {
          kind: "context.compacted",
          providerTurnId: handledEvent.params.turnId,
        },
      ];
    case "thread/goal/updated": {
      const goal: CodexGoalState = {
        objective: handledEvent.params.goal.objective,
        status: handledEvent.params.goal.status,
        tokenBudget: handledEvent.params.goal.tokenBudget,
        tokensUsed: handledEvent.params.goal.tokensUsed,
        timeUsedSeconds: handledEvent.params.goal.timeUsedSeconds,
      };
      return [
        {
          kind: "extension.state",
          extensionKind: CODEX_GOAL_EXTENSION_KIND,
          payload: goal,
        },
      ];
    }
    case "thread/goal/cleared":
      return [
        {
          kind: "extension.state",
          extensionKind: CODEX_GOAL_EXTENSION_KIND,
          payload: null,
        },
      ];
    case "item/started":
    case "item/completed": {
      const translation = translateCodexItemShape(
        handledEvent.params.item,
        state,
      );
      if (translation.kind === "ignored") {
        return [];
      }
      if (translation.kind === "unhandled") {
        return buildUnhandledCodexDeltas({
          rawEvent,
          rawType: handledEvent.method,
          providerTurnId: handledEvent.params.turnId,
        });
      }
      const key = { providerItemId: handledEvent.params.item.id };
      if (handledEvent.method === "item/started") {
        return [
          {
            kind: "item.open",
            key,
            item: translation.shape,
            presentation: translation.presentation,
            providerTurnId: handledEvent.params.turnId,
          },
        ];
      }
      return [
        {
          kind: "item.close",
          key,
          status: translation.status,
          ...(translation.approvalDenied ? { approvalStatus: "denied" } : {}),
          item: translation.shape,
          presentation: translation.presentation,
          providerTurnId: handledEvent.params.turnId,
        },
      ];
    }
    case "item/agentMessage/delta":
      return [
        {
          kind: "item.textDelta",
          key: { providerItemId: handledEvent.params.itemId },
          channel: "agentMessage",
          text: handledEvent.params.delta,
          providerTurnId: handledEvent.params.turnId,
        },
      ];
    case "item/commandExecution/outputDelta":
      return [
        {
          kind: "item.outputDelta",
          key: { providerItemId: handledEvent.params.itemId },
          channel: "command",
          text: handledEvent.params.delta,
          providerTurnId: handledEvent.params.turnId,
        },
      ];
    case "item/fileChange/outputDelta":
      return [
        {
          kind: "item.outputDelta",
          key: { providerItemId: handledEvent.params.itemId },
          channel: "fileChange",
          text: handledEvent.params.delta,
          providerTurnId: handledEvent.params.turnId,
        },
      ];
    case "item/reasoning/summaryTextDelta":
      return [
        {
          kind: "item.textDelta",
          key: { providerItemId: handledEvent.params.itemId },
          channel: "reasoningSummary",
          text: handledEvent.params.delta,
          providerTurnId: handledEvent.params.turnId,
        },
      ];
    case "item/reasoning/textDelta":
      return [
        {
          kind: "item.textDelta",
          key: { providerItemId: handledEvent.params.itemId },
          channel: "reasoningText",
          text: handledEvent.params.delta,
          providerTurnId: handledEvent.params.turnId,
        },
      ];
    case "item/plan/delta":
      return [
        {
          kind: "item.textDelta",
          key: { providerItemId: handledEvent.params.itemId },
          channel: "plan",
          text: handledEvent.params.delta,
          providerTurnId: handledEvent.params.turnId,
        },
      ];
    case "item/mcpToolCall/progress":
      return [
        {
          kind: "item.progress",
          key: { providerItemId: handledEvent.params.itemId },
          ...(handledEvent.params.message
            ? { message: handledEvent.params.message }
            : {}),
          providerTurnId: handledEvent.params.turnId,
        },
      ];
    case "thread/tokenUsage/updated": {
      const { tokenUsage, turnId } = handledEvent.params;
      return [
        {
          kind: "usage",
          total: {
            totalTokens: tokenUsage.total.totalTokens,
            inputTokens: tokenUsage.total.inputTokens,
            cachedInputTokens: tokenUsage.total.cachedInputTokens,
            outputTokens: tokenUsage.total.outputTokens,
            reasoningOutputTokens: tokenUsage.total.reasoningOutputTokens,
          },
          last: {
            totalTokens: tokenUsage.last.totalTokens,
            inputTokens: tokenUsage.last.inputTokens,
            cachedInputTokens: tokenUsage.last.cachedInputTokens,
            outputTokens: tokenUsage.last.outputTokens,
            reasoningOutputTokens: tokenUsage.last.reasoningOutputTokens,
          },
          modelContextWindow: tokenUsage.modelContextWindow,
          providerTurnId: turnId,
        },
        {
          kind: "contextWindow",
          used: tokenUsage.last.totalTokens,
          size: tokenUsage.modelContextWindow,
          estimated: false,
          attach: "currentOrLast",
          providerTurnId: turnId,
        },
      ];
    }
    case "turn/plan/updated": {
      const steps = handledEvent.params.plan.map((step) => ({
        step: step.step,
        status:
          step.status === "inProgress" ? ("active" as const) : step.status,
      }));
      const explanation = handledEvent.params.explanation;
      return [
        {
          kind: "item.close",
          key: { channel: PLAN_STEPS_CHANNEL },
          status: "completed",
          item: {
            type: "planSteps",
            steps,
            ...(explanation ? { explanation } : {}),
          },
          presentation: planStepsPresentation({
            steps,
            explanation: explanation ?? null,
          }),
          providerTurnId: handledEvent.params.turnId,
        },
      ];
    }
    case "turn/diff/updated":
      return [
        {
          kind: "turn.diff",
          diff: handledEvent.params.diff,
          providerTurnId: handledEvent.params.turnId,
        },
      ];
    case "error": {
      const errorInfo = toProviderErrorInfo(
        resolveCodexErrorInfo(state, handledEvent.params),
      );
      return [
        {
          kind: "provider.error",
          message: "Provider error",
          detail: handledEvent.params.error.additionalDetails
            ? `${handledEvent.params.error.message}\n${handledEvent.params.error.additionalDetails}`
            : handledEvent.params.error.message,
          ...(handledEvent.params.willRetry !== undefined
            ? { willRetry: handledEvent.params.willRetry }
            : {}),
          ...(errorInfo ? { errorInfo } : {}),
          ...(handledEvent.params.turnId !== undefined
            ? { providerTurnId: handledEvent.params.turnId }
            : { threadScoped: true }),
        },
      ];
    }
    case "deprecationNotice":
      return [
        {
          kind: "provider.warning",
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
          kind: "provider.warning",
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

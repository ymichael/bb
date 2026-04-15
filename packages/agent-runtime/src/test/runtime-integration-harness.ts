import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import type {
  PendingInteractionCreate,
  PendingInteractionResolution,
  ThreadEvent,
  ToolCallRequest,
  ToolCallResponse,
} from "@bb/domain";
import type { AgentRuntimeCaptureEntry } from "../capture-types.js";
import { createAgentRuntime } from "../runtime.js";
import type { AgentRuntime, AgentRuntimeExecutionOptions } from "../types.js";

export type ThreadIdentityEvent = Extract<ThreadEvent, { type: "thread/identity" }>;
export type TurnStartedEvent = Extract<ThreadEvent, { type: "turn/started" }>;
export type UserMessageAckEvent = Extract<ThreadEvent, { type: "item/completed" }>;
export type ErrorThreadEvent = Extract<ThreadEvent, { type: "error" | "system/error" }>;
export type WaitPredicate = () => boolean;
export type WaitFailureDescription = () => string | null | undefined;

export interface WaitForConditionOptions {
  describeFailure?: WaitFailureDescription;
  failFast?: WaitFailureDescription;
  label?: string;
  timeoutMs?: number;
}

export interface RuntimeDiagnosticsArgs {
  ctx: TestContext;
  threadId?: string;
}

export interface RuntimeWaitArgs extends RuntimeDiagnosticsArgs {
  label: string;
  timeoutMs?: number;
}

export interface RuntimeConditionWaitArgs extends RuntimeWaitArgs {
  predicate: WaitPredicate;
}

export interface TurnCompletedCountWaitArgs extends RuntimeWaitArgs {
  count: number;
}

export interface ThreadWaitArgs extends RuntimeWaitArgs {
  threadId: string;
}

export interface ThreadTurnCompletedCountWaitArgs extends ThreadWaitArgs {
  count: number;
}

export interface ToolCallWaitArgs extends ThreadWaitArgs {
  toolName: string;
}

export interface InteractiveRequestWaitArgs extends ThreadWaitArgs {
  count: number;
}

export const fullRuntimeOptions = {
  permissionMode: "full",
  permissionEscalation: null,
} satisfies AgentRuntimeExecutionOptions;

export const workspaceWriteAskRuntimeOptions = {
  permissionMode: "workspace-write",
  permissionEscalation: "ask",
} satisfies AgentRuntimeExecutionOptions;

export const workspaceWriteDenyRuntimeOptions = {
  permissionMode: "workspace-write",
  permissionEscalation: "deny",
} satisfies AgentRuntimeExecutionOptions;

export const readonlyAskRuntimeOptions = {
  permissionMode: "readonly",
  permissionEscalation: "ask",
} satisfies AgentRuntimeExecutionOptions;

export const readonlyDenyRuntimeOptions = {
  permissionMode: "readonly",
  permissionEscalation: "deny",
} satisfies AgentRuntimeExecutionOptions;

export function waitForCondition(
  predicate: WaitPredicate,
  opts?: WaitForConditionOptions,
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const label = opts?.label ?? "condition";
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      const failFastMessage = opts?.failFast?.();
      if (failFastMessage) {
        reject(new Error(failFastMessage));
        return;
      }
      if (Date.now() - start > timeoutMs) {
        const failureDetail = opts?.describeFailure?.();
        const detail = failureDetail ? `\n${failureDetail}` : "";
        reject(new Error(`Timeout after ${timeoutMs}ms waiting for ${label}${detail}`));
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

export function turnCompletedCount(events: ThreadEvent[]): number {
  return events.filter((e) => e.type === "turn/completed").length;
}

export function turnStartedCount(events: ThreadEvent[]): number {
  return events.filter((e) => e.type === "turn/started").length;
}

export function collectTurnIds(events: ThreadEvent[]): Set<string> {
  const turnIds = new Set<string>();
  for (const event of events) {
    if ("turnId" in event && event.turnId) {
      turnIds.add(event.turnId);
    }
  }
  return turnIds;
}

export interface RuntimeRestartTurnIdAssertionArgs {
  firstEvents: ThreadEvent[];
  providerId: string;
  secondEvents: ThreadEvent[];
}

export interface ResolveProviderThreadIdArgs {
  events: ThreadEvent[];
  fallbackProviderThreadId: string | undefined;
  threadId: string;
}

export interface ResolveResumePathArgs {
  providerId: string;
  threadId: string;
}

export function providerUsesRuntimeTurnIds(providerId: string): boolean {
  return providerId === "claude-code" || providerId === "pi";
}

export function getUserMessageAckEvents(
  events: ThreadEvent[],
): UserMessageAckEvent[] {
  return events.filter(
    (event): event is UserMessageAckEvent =>
      event.type === "item/completed" && event.item.type === "userMessage",
  );
}

export function expectUserMessageAckCount(
  events: ThreadEvent[],
  count: number,
): void {
  expect(getUserMessageAckEvents(events)).toHaveLength(count);
}

export function getEventsForThread(
  events: ThreadEvent[],
  threadId: string,
): ThreadEvent[] {
  return events.filter((event) =>
    "threadId" in event && event.threadId === threadId,
  );
}

export function findLatestTurnStartedForThread(
  events: ThreadEvent[],
  threadId: string,
): TurnStartedEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "turn/started" && event.threadId === threadId) {
      return event;
    }
  }
  return null;
}

export function findUserMessageAckTextForThread(
  events: ThreadEvent[],
  threadId: string,
  text: string,
): UserMessageAckEvent | null {
  const ack = getUserMessageAckEvents(getEventsForThread(events, threadId)).find(
    (event) =>
      event.item.type === "userMessage" &&
      event.item.content.some((content) =>
        content.type === "text" && content.text === text,
      ),
  );
  return ack ?? null;
}

export function hasUserMessageAckTextForThread(
  events: ThreadEvent[],
  threadId: string,
  text: string,
): boolean {
  return findUserMessageAckTextForThread(events, threadId, text) !== null;
}

export function turnStartedCountForThread(
  events: ThreadEvent[],
  threadId: string,
): number {
  return getEventsForThread(events, threadId)
    .filter((event) => event.type === "turn/started").length;
}

export function turnCompletedCountForThread(
  events: ThreadEvent[],
  threadId: string,
): number {
  return getEventsForThread(events, threadId)
    .filter((event) => event.type === "turn/completed").length;
}

export function getAgentTextAfterIndex(
  events: ThreadEvent[],
  startIndex: number,
  threadId: string,
): string {
  return getThreadText(events.slice(startIndex), threadId);
}

export function isThreadIdentityEvent(
  event: ThreadEvent,
  threadId: string,
): event is ThreadIdentityEvent {
  return event.type === "thread/identity" && event.threadId === threadId;
}

export function resolveProviderThreadId(args: ResolveProviderThreadIdArgs): string {
  if (args.fallbackProviderThreadId) {
    return args.fallbackProviderThreadId;
  }

  const identityEvent = args.events.find((event) =>
    isThreadIdentityEvent(event, args.threadId),
  );
  if (!identityEvent) {
    throw new Error(`No provider thread id captured for ${args.threadId}`);
  }
  return identityEvent.providerThreadId;
}

export function resolveResumePath(args: ResolveResumePathArgs): string | undefined {
  if (args.providerId !== "pi") {
    return undefined;
  }
  const sanitized = args.threadId.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(homedir(), ".bb", "pi-bridge-sessions", `${sanitized}.jsonl`);
}

export function expectNoSharedRuntimeTurnIds(
  args: RuntimeRestartTurnIdAssertionArgs,
): void {
  if (!providerUsesRuntimeTurnIds(args.providerId)) {
    return;
  }

  const firstTurnIds = collectTurnIds(args.firstEvents);
  const secondTurnIds = collectTurnIds(args.secondEvents);
  const sharedTurnIds = Array.from(firstTurnIds).filter((turnId) =>
    secondTurnIds.has(turnId),
  );

  expect(firstTurnIds.size).toBeGreaterThan(0);
  expect(secondTurnIds.size).toBeGreaterThan(0);
  expect(sharedTurnIds).toEqual([]);
}

export function getAgentText(events: ThreadEvent[]): string {
  const texts: string[] = [];
  for (const e of events) {
    if (e.type === "item/completed" && e.item.type === "agentMessage" && e.item.text) {
      texts.push(e.item.text);
    }
  }
  return texts.join(" ");
}

export function getStreamedText(events: ThreadEvent[]): string {
  const chunks: string[] = [];
  for (const e of events) {
    if (e.type === "item/agentMessage/delta") {
      chunks.push(e.delta);
    }
  }
  return chunks.join("");
}

export function getThreadText(events: ThreadEvent[], threadId: string): string {
  const threadEvents = events.filter((event) =>
    "threadId" in event && event.threadId === threadId,
  );
  return getAgentText(threadEvents) || getStreamedText(threadEvents);
}

export function describeEventsForFailure(events: ThreadEvent[]): string {
  return events.map((event) => {
    const threadId = "threadId" in event ? event.threadId : "no-thread";
    if (event.type === "item/completed") {
      if (event.item.type === "toolCall") {
        const error = event.item.error ? ` error=${event.item.error}` : "";
        return `${threadId} ${event.type}:${event.item.type}:${event.item.tool}:${event.item.status}${error}`;
      }
      if (event.item.type === "commandExecution") {
        return `${threadId} ${event.type}:${event.item.type}:${event.item.status}:${event.item.approvalStatus}`;
      }
      if (event.item.type === "fileChange") {
        return `${threadId} ${event.type}:${event.item.type}:${event.item.status}:${event.item.approvalStatus}`;
      }
      return `${threadId} ${event.type}:${event.item.type}`;
    }
    if (event.type === "item/started") {
      return `${threadId} ${event.type}:${event.item.type}`;
    }
    if (event.type === "error") {
      return `${threadId} ${event.type}:${event.message}${event.detail ? ` ${event.detail}` : ""}`;
    }
    return `${threadId} ${event.type}`;
  }).join("\n");
}

export function previewText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 240) {
    return normalized;
  }
  return `${normalized.slice(0, 240)}...`;
}

export function isErrorEvent(event: ThreadEvent): event is ErrorThreadEvent {
  return event.type === "error" || event.type === "system/error";
}

export function findLatestErrorEvent(events: ThreadEvent[]): ErrorThreadEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && isErrorEvent(event)) {
      return event;
    }
  }
  return null;
}

export function formatErrorEvent(event: ErrorThreadEvent): string {
  const detail = event.detail ? ` detail=${event.detail}` : "";
  return `${event.type}: ${event.message}${detail}`;
}

export function formatInteractiveRequest(request: PendingInteractionCreate): string {
  const { subject } = request.payload;
  switch (subject.kind) {
    case "command":
      return `command:${previewText(subject.command)}`;
    case "file_change":
      return `file_change:${subject.itemId}`;
    case "permission_grant":
      return `permission_grant:${subject.toolName ?? "unknown"}`;
  }
}

export function describeRuntimeDiagnostics(args: RuntimeDiagnosticsArgs): string {
  const events = args.threadId
    ? getEventsForThread(args.ctx.events, args.threadId)
    : args.ctx.events;
  const relevantToolCalls = args.threadId
    ? args.ctx.toolCalls.filter((request) => request.threadId === args.threadId)
    : args.ctx.toolCalls;
  const relevantInteractiveRequests = args.threadId
    ? args.ctx.interactiveRequests.filter((request) => request.threadId === args.threadId)
    : args.ctx.interactiveRequests;
  const recentEvents = events.slice(-12);
  const latestError = findLatestErrorEvent(events);
  const agentText = previewText(getAgentText(events));
  const streamedText = previewText(getStreamedText(events));
  const toolCalls = relevantToolCalls.map((request) => request.tool).join(", ");
  const interactiveRequests = relevantInteractiveRequests
    .map(formatInteractiveRequest)
    .join(", ");

  return [
    `Diagnostics: threadId=${args.threadId ?? "all"} events=${events.length} turnStarted=${turnStartedCount(events)} turnCompleted=${turnCompletedCount(events)}`,
    `latestError=${latestError ? formatErrorEvent(latestError) : "none"}`,
    `toolCalls=[${toolCalls || "none"}]`,
    `interactiveRequests=[${interactiveRequests || "none"}]`,
    `agentText=${JSON.stringify(agentText)}`,
    `streamedText=${JSON.stringify(streamedText)}`,
    `recentEvents:\n${describeEventsForFailure(recentEvents) || "none"}`,
  ].join("\n");
}

export function failOnRuntimeError(args: RuntimeDiagnosticsArgs): string | null {
  const events = args.threadId
    ? getEventsForThread(args.ctx.events, args.threadId)
    : args.ctx.events;
  const latestError = findLatestErrorEvent(events);
  if (!latestError) {
    return null;
  }
  return `${formatErrorEvent(latestError)}\n${describeRuntimeDiagnostics(args)}`;
}

export function waitForRuntimeCondition(args: RuntimeConditionWaitArgs): Promise<void> {
  return waitForCondition(args.predicate, {
    describeFailure: () => describeRuntimeDiagnostics(args),
    failFast: () => failOnRuntimeError(args),
    label: args.label,
    timeoutMs: args.timeoutMs,
  });
}

export function waitForTurnCompletedCount(args: TurnCompletedCountWaitArgs): Promise<void> {
  return waitForRuntimeCondition({
    ctx: args.ctx,
    label: args.label,
    predicate: () => turnCompletedCount(args.ctx.events) >= args.count,
    timeoutMs: args.timeoutMs,
  });
}

export function waitForThreadTurnCompleted(args: ThreadWaitArgs): Promise<void> {
  return waitForRuntimeCondition({
    ctx: args.ctx,
    label: args.label,
    predicate: () => turnCompletedCountForThread(
      args.ctx.events,
      args.threadId,
    ) >= 1,
    threadId: args.threadId,
    timeoutMs: args.timeoutMs,
  });
}

export function waitForThreadTurnCompletedCount(
  args: ThreadTurnCompletedCountWaitArgs,
): Promise<void> {
  return waitForRuntimeCondition({
    ctx: args.ctx,
    label: args.label,
    predicate: () => turnCompletedCountForThread(
      args.ctx.events,
      args.threadId,
    ) >= args.count,
    threadId: args.threadId,
    timeoutMs: args.timeoutMs,
  });
}

export function waitForThreadTurnStarted(args: ThreadWaitArgs): Promise<void> {
  return waitForRuntimeCondition({
    ctx: args.ctx,
    label: args.label,
    predicate: () => findLatestTurnStartedForThread(
      args.ctx.events,
      args.threadId,
    ) !== null,
    threadId: args.threadId,
    timeoutMs: args.timeoutMs,
  });
}

export function hasToolCallForThread(
  ctx: TestContext,
  threadId: string,
  toolName: string,
): boolean {
  return ctx.toolCalls.some((request) =>
    request.threadId === threadId && request.tool === toolName,
  );
}

export function interactiveRequestCountForThread(
  ctx: TestContext,
  threadId: string,
): number {
  return ctx.interactiveRequests.filter((request) => request.threadId === threadId)
    .length;
}

export function waitForToolCallBeforeTurnCompletion(args: ToolCallWaitArgs): Promise<void> {
  return waitForCondition(
    () => hasToolCallForThread(args.ctx, args.threadId, args.toolName),
    {
      describeFailure: () => describeRuntimeDiagnostics(args),
      failFast: () => {
        const runtimeError = failOnRuntimeError(args);
        if (runtimeError) {
          return runtimeError;
        }
        if (turnCompletedCountForThread(args.ctx.events, args.threadId) > 0) {
          return `Turn completed before ${args.toolName} was called.\n${describeRuntimeDiagnostics(args)}`;
        }
        return null;
      },
      label: args.label,
      timeoutMs: args.timeoutMs,
    },
  );
}

export function waitForInteractiveRequestBeforeTurnCompletion(
  args: InteractiveRequestWaitArgs,
): Promise<void> {
  return waitForCondition(
    () => interactiveRequestCountForThread(args.ctx, args.threadId) >= args.count,
    {
      describeFailure: () => describeRuntimeDiagnostics(args),
      failFast: () => {
        const runtimeError = failOnRuntimeError(args);
        if (runtimeError) {
          return runtimeError;
        }
        if (turnCompletedCountForThread(args.ctx.events, args.threadId) > 0) {
          return `Turn completed before ${args.label} was observed.\n${describeRuntimeDiagnostics(args)}`;
        }
        return null;
      },
      label: args.label,
      timeoutMs: args.timeoutMs,
    },
  );
}

export function getCompletedCommandOutputs(events: ThreadEvent[]): string {
  const outputs: string[] = [];
  for (const event of events) {
    if (
      event.type === "item/completed"
      && event.item.type === "commandExecution"
      && event.item.aggregatedOutput
    ) {
      outputs.push(event.item.aggregatedOutput);
    }
  }
  return outputs.join("\n");
}

export function getCompletedCommands(events: ThreadEvent[]): string[] {
  const commands: string[] = [];
  for (const event of events) {
    if (
      event.type === "item/completed"
      && event.item.type === "commandExecution"
    ) {
      commands.push(event.item.command);
    }
  }
  return commands;
}

export function hasDeniedCommandExecution(events: ThreadEvent[]): boolean {
  return events.some((event) =>
    event.type === "item/completed"
    && event.item.type === "commandExecution"
    && event.item.approvalStatus === "denied"
  );
}

export function resolveDefaultModel(providerId: string, ctx: TestContext): Promise<string | undefined> {
  return ctx.runtime.listModels({ providerId }).then((models) =>
    models.find((model) => model.isDefault)?.model ?? models[0]?.model,
  );
}

export function newThreadId(): string {
  return randomUUID();
}

export function createToken(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function createTempFileName(prefix: string): string {
  return `${prefix}-${randomUUID().replaceAll("-", "")}.txt`;
}

export function expectSemanticApprovalRequest(request: PendingInteractionCreate): void {
  expect(["command", "file_change", "permission_grant"]).toContain(
    request.payload.subject.kind,
  );
  switch (request.payload.subject.kind) {
    case "command":
      expect(Array.isArray(request.payload.subject.actions)).toBe(true);
      expect(request.payload.subject.sessionGrant).not.toBeUndefined();
      break;
    case "file_change":
      expect(request.payload.subject.writeScope).not.toBeUndefined();
      expect(request.payload.subject.sessionGrant).not.toBeUndefined();
      break;
    case "permission_grant":
      expect(request.payload.subject.permissions).toBeDefined();
      break;
  }
  expect(request.payload.availableDecisions.length).toBeGreaterThan(0);
  for (const decision of request.payload.availableDecisions) {
    expect(["allow_once", "allow_for_session", "deny"]).toContain(decision);
  }
}

export interface TestContext {
  runtime: AgentRuntime;
  events: ThreadEvent[];
  toolCalls: ToolCallRequest[];
  interactiveRequests: PendingInteractionCreate[];
  captures: AgentRuntimeCaptureEntry[];
  tmpDir: string;
  ownsTmpDir: boolean;
}

export type TestToolCallHandler = (
  req: ToolCallRequest,
) => Promise<ToolCallResponse>;

export type TestInteractiveRequestHandler = (
  req: PendingInteractionCreate,
) => Promise<PendingInteractionResolution>;

export interface CreateTestRuntimeOptions {
  onInteractiveRequest?: TestInteractiveRequestHandler;
  onToolCall?: TestToolCallHandler;
  workspacePath?: string;
}

export function createTestRuntime(
  providerId: string,
  opts?: CreateTestRuntimeOptions,
): TestContext {
  const tmpDir = opts?.workspacePath ?? mkdtempSync(join(tmpdir(), `bb-integ-${providerId}-`));
  const ownsTmpDir = !opts?.workspacePath;
  const events: ThreadEvent[] = [];
  const toolCalls: ToolCallRequest[] = [];
  const interactiveRequests: PendingInteractionCreate[] = [];
  const captures: AgentRuntimeCaptureEntry[] = [];

  const defaultToolHandler = async (): Promise<ToolCallResponse> => ({
    contentItems: [{ type: "inputText" as const, text: "ok" }],
    success: true,
  });

  const runtime = createAgentRuntime({
    workspacePath: tmpDir,
    onEvent: (e) => events.push(e),
    onCapture: (entry) => captures.push(entry),
    onToolCall: async (req) => {
      toolCalls.push(req);
      if (opts?.onToolCall) return opts.onToolCall(req);
      return defaultToolHandler();
    },
    onInteractiveRequest: async (req) => {
      expectSemanticApprovalRequest(req);
      interactiveRequests.push(req);
      if (opts?.onInteractiveRequest) {
        return opts.onInteractiveRequest(req);
      }
      throw new Error(`Unexpected interactive request: ${req.payload.subject.kind}`);
    },
    onStderr: () => {},
  });

  return {
    runtime,
    events,
    toolCalls,
    interactiveRequests,
    captures,
    tmpDir,
    ownsTmpDir,
  };
}

export function cleanup(ctx: TestContext): void {
  if (ctx.ownsTmpDir) {
    rmSync(ctx.tmpDir, { recursive: true, force: true });
  }
}

export async function createApprovalResolution(
  request: PendingInteractionCreate,
): Promise<PendingInteractionResolution> {
  return {
    decision: request.payload.availableDecisions.includes("allow_for_session")
      ? "allow_for_session"
      : "allow_once",
    grantedPermissions:
      request.payload.subject.kind === "permission_grant"
        ? request.payload.subject.permissions
        : request.payload.subject.kind === "command"
          || request.payload.subject.kind === "file_change"
        ? request.payload.subject.sessionGrant
        : null,
  };
}

export function isWriteApprovalRequest(request: PendingInteractionCreate): boolean {
  return (
    (
      request.payload.subject.kind === "command"
      || request.payload.subject.kind === "file_change"
    )
    && request.payload.availableDecisions.includes("allow_once")
  );
}

export function expectWriteApprovalRequest(requests: PendingInteractionCreate[]): void {
  expect(
    requests.some(isWriteApprovalRequest),
    `Expected a command or file-change approval with allow_once; got ${JSON.stringify(
      requests.map((request) => request.payload),
    )}`,
  ).toBe(true);
}

export function getFirstNonEmptyLine(path: string): string {
  const line = readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .find((value) => value.trim().length > 0);
  if (!line) {
    throw new Error(`Expected a non-empty line in ${path}`);
  }
  return line;
}

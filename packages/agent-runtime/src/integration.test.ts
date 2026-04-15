/**
 * Provider integration tests using createAgentRuntime.
 *
 * These tests validate that each provider works end-to-end through the
 * real runtime: process spawning, JSON-RPC framing, event routing, and
 * tool call round-trips.
 *
 * All providers must be authenticated in the current environment before
 * running these tests.
 *
 * Run with: pnpm test:integration
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  PendingInteractionCreate,
  PendingInteractionResolution,
  ThreadEvent,
  ToolCallRequest,
  ToolCallResponse,
} from "@bb/domain";
import type { AgentRuntimeCaptureEntry } from "./capture-types.js";
import { listAvailableProviderInfos } from "./provider-registry.js";
import { createAgentRuntime } from "./runtime.js";
import type { AgentRuntime, AgentRuntimeExecutionOptions } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ThreadIdentityEvent = Extract<ThreadEvent, { type: "thread/identity" }>;
type TurnStartedEvent = Extract<ThreadEvent, { type: "turn/started" }>;
type UserMessageAckEvent = Extract<ThreadEvent, { type: "item/completed" }>;
type ErrorThreadEvent = Extract<ThreadEvent, { type: "error" | "system/error" }>;
type WaitPredicate = () => boolean;
type WaitFailureDescription = () => string | null | undefined;

interface WaitForConditionOptions {
  describeFailure?: WaitFailureDescription;
  failFast?: WaitFailureDescription;
  label?: string;
  timeoutMs?: number;
}

interface RuntimeDiagnosticsArgs {
  ctx: TestContext;
  threadId?: string;
}

interface RuntimeWaitArgs extends RuntimeDiagnosticsArgs {
  label: string;
  timeoutMs?: number;
}

interface RuntimeConditionWaitArgs extends RuntimeWaitArgs {
  predicate: WaitPredicate;
}

interface TurnCompletedCountWaitArgs extends RuntimeWaitArgs {
  count: number;
}

interface ThreadWaitArgs extends RuntimeWaitArgs {
  threadId: string;
}

interface ThreadTurnCompletedCountWaitArgs extends ThreadWaitArgs {
  count: number;
}

interface ToolCallWaitArgs extends ThreadWaitArgs {
  toolName: string;
}

interface InteractiveRequestWaitArgs extends ThreadWaitArgs {
  count: number;
}

const fullRuntimeOptions = {
  permissionMode: "full",
  permissionEscalation: null,
} satisfies AgentRuntimeExecutionOptions;

const workspaceWriteAskRuntimeOptions = {
  permissionMode: "workspace-write",
  permissionEscalation: "ask",
} satisfies AgentRuntimeExecutionOptions;

const workspaceWriteDenyRuntimeOptions = {
  permissionMode: "workspace-write",
  permissionEscalation: "deny",
} satisfies AgentRuntimeExecutionOptions;

const readonlyAskRuntimeOptions = {
  permissionMode: "readonly",
  permissionEscalation: "ask",
} satisfies AgentRuntimeExecutionOptions;

const readonlyDenyRuntimeOptions = {
  permissionMode: "readonly",
  permissionEscalation: "deny",
} satisfies AgentRuntimeExecutionOptions;

function waitForCondition(
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

function turnCompletedCount(events: ThreadEvent[]): number {
  return events.filter((e) => e.type === "turn/completed").length;
}

function turnStartedCount(events: ThreadEvent[]): number {
  return events.filter((e) => e.type === "turn/started").length;
}

function collectTurnIds(events: ThreadEvent[]): Set<string> {
  const turnIds = new Set<string>();
  for (const event of events) {
    if ("turnId" in event && event.turnId) {
      turnIds.add(event.turnId);
    }
  }
  return turnIds;
}

interface RuntimeRestartTurnIdAssertionArgs {
  firstEvents: ThreadEvent[];
  providerId: string;
  secondEvents: ThreadEvent[];
}

interface ResolveProviderThreadIdArgs {
  events: ThreadEvent[];
  fallbackProviderThreadId: string | undefined;
  threadId: string;
}

interface ResolveResumePathArgs {
  providerId: string;
  threadId: string;
}

function providerUsesRuntimeTurnIds(providerId: string): boolean {
  return providerId === "claude-code" || providerId === "pi";
}

function getUserMessageAckEvents(
  events: ThreadEvent[],
): UserMessageAckEvent[] {
  return events.filter(
    (event): event is UserMessageAckEvent =>
      event.type === "item/completed" && event.item.type === "userMessage",
  );
}

function expectUserMessageAckCount(
  events: ThreadEvent[],
  count: number,
): void {
  expect(getUserMessageAckEvents(events)).toHaveLength(count);
}

function getEventsForThread(
  events: ThreadEvent[],
  threadId: string,
): ThreadEvent[] {
  return events.filter((event) =>
    "threadId" in event && event.threadId === threadId,
  );
}

function findLatestTurnStartedForThread(
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

function findUserMessageAckTextForThread(
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

function hasUserMessageAckTextForThread(
  events: ThreadEvent[],
  threadId: string,
  text: string,
): boolean {
  return findUserMessageAckTextForThread(events, threadId, text) !== null;
}

function turnStartedCountForThread(
  events: ThreadEvent[],
  threadId: string,
): number {
  return getEventsForThread(events, threadId)
    .filter((event) => event.type === "turn/started").length;
}

function turnCompletedCountForThread(
  events: ThreadEvent[],
  threadId: string,
): number {
  return getEventsForThread(events, threadId)
    .filter((event) => event.type === "turn/completed").length;
}

function getAgentTextAfterIndex(
  events: ThreadEvent[],
  startIndex: number,
  threadId: string,
): string {
  return getThreadText(events.slice(startIndex), threadId);
}

function isThreadIdentityEvent(
  event: ThreadEvent,
  threadId: string,
): event is ThreadIdentityEvent {
  return event.type === "thread/identity" && event.threadId === threadId;
}

function resolveProviderThreadId(args: ResolveProviderThreadIdArgs): string {
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

function resolveResumePath(args: ResolveResumePathArgs): string | undefined {
  if (args.providerId !== "pi") {
    return undefined;
  }
  const sanitized = args.threadId.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(homedir(), ".bb", "pi-bridge-sessions", `${sanitized}.jsonl`);
}

function expectNoSharedRuntimeTurnIds(
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

function getAgentText(events: ThreadEvent[]): string {
  const texts: string[] = [];
  for (const e of events) {
    if (e.type === "item/completed" && e.item.type === "agentMessage" && e.item.text) {
      texts.push(e.item.text);
    }
  }
  return texts.join(" ");
}

function getStreamedText(events: ThreadEvent[]): string {
  const chunks: string[] = [];
  for (const e of events) {
    if (e.type === "item/agentMessage/delta") {
      chunks.push(e.delta);
    }
  }
  return chunks.join("");
}

function getThreadText(events: ThreadEvent[], threadId: string): string {
  const threadEvents = events.filter((event) =>
    "threadId" in event && event.threadId === threadId,
  );
  return getAgentText(threadEvents) || getStreamedText(threadEvents);
}

function describeEventsForFailure(events: ThreadEvent[]): string {
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

function previewText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 240) {
    return normalized;
  }
  return `${normalized.slice(0, 240)}...`;
}

function isErrorEvent(event: ThreadEvent): event is ErrorThreadEvent {
  return event.type === "error" || event.type === "system/error";
}

function findLatestErrorEvent(events: ThreadEvent[]): ErrorThreadEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && isErrorEvent(event)) {
      return event;
    }
  }
  return null;
}

function formatErrorEvent(event: ErrorThreadEvent): string {
  const detail = event.detail ? ` detail=${event.detail}` : "";
  return `${event.type}: ${event.message}${detail}`;
}

function formatInteractiveRequest(request: PendingInteractionCreate): string {
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

function describeRuntimeDiagnostics(args: RuntimeDiagnosticsArgs): string {
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

function failOnRuntimeError(args: RuntimeDiagnosticsArgs): string | null {
  const events = args.threadId
    ? getEventsForThread(args.ctx.events, args.threadId)
    : args.ctx.events;
  const latestError = findLatestErrorEvent(events);
  if (!latestError) {
    return null;
  }
  return `${formatErrorEvent(latestError)}\n${describeRuntimeDiagnostics(args)}`;
}

function waitForRuntimeCondition(args: RuntimeConditionWaitArgs): Promise<void> {
  return waitForCondition(args.predicate, {
    describeFailure: () => describeRuntimeDiagnostics(args),
    failFast: () => failOnRuntimeError(args),
    label: args.label,
    timeoutMs: args.timeoutMs,
  });
}

function waitForTurnCompletedCount(args: TurnCompletedCountWaitArgs): Promise<void> {
  return waitForRuntimeCondition({
    ctx: args.ctx,
    label: args.label,
    predicate: () => turnCompletedCount(args.ctx.events) >= args.count,
    timeoutMs: args.timeoutMs,
  });
}

function waitForThreadTurnCompleted(args: ThreadWaitArgs): Promise<void> {
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

function waitForThreadTurnCompletedCount(
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

function waitForThreadTurnStarted(args: ThreadWaitArgs): Promise<void> {
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

function hasToolCallForThread(
  ctx: TestContext,
  threadId: string,
  toolName: string,
): boolean {
  return ctx.toolCalls.some((request) =>
    request.threadId === threadId && request.tool === toolName,
  );
}

function interactiveRequestCountForThread(
  ctx: TestContext,
  threadId: string,
): number {
  return ctx.interactiveRequests.filter((request) => request.threadId === threadId)
    .length;
}

function waitForToolCallBeforeTurnCompletion(args: ToolCallWaitArgs): Promise<void> {
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

function waitForInteractiveRequestBeforeTurnCompletion(
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

function getCompletedCommandOutputs(events: ThreadEvent[]): string {
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

function getCompletedCommands(events: ThreadEvent[]): string[] {
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

function hasDeniedCommandExecution(events: ThreadEvent[]): boolean {
  return events.some((event) =>
    event.type === "item/completed"
    && event.item.type === "commandExecution"
    && event.item.approvalStatus === "denied"
  );
}

function resolveDefaultModel(providerId: string, ctx: TestContext): Promise<string | undefined> {
  return ctx.runtime.listModels({ providerId }).then((models) =>
    models.find((model) => model.isDefault)?.model ?? models[0]?.model,
  );
}

function newThreadId(): string {
  return randomUUID();
}

function createToken(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function createTempFileName(prefix: string): string {
  return `${prefix}-${randomUUID().replaceAll("-", "")}.txt`;
}

function expectSemanticApprovalRequest(request: PendingInteractionCreate): void {
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

interface TestContext {
  runtime: AgentRuntime;
  events: ThreadEvent[];
  toolCalls: ToolCallRequest[];
  interactiveRequests: PendingInteractionCreate[];
  captures: AgentRuntimeCaptureEntry[];
  tmpDir: string;
  ownsTmpDir: boolean;
}

type TestToolCallHandler = (
  req: ToolCallRequest,
) => Promise<ToolCallResponse>;

type TestInteractiveRequestHandler = (
  req: PendingInteractionCreate,
) => Promise<PendingInteractionResolution>;

interface CreateTestRuntimeOptions {
  onInteractiveRequest?: TestInteractiveRequestHandler;
  onToolCall?: TestToolCallHandler;
  workspacePath?: string;
}

function createTestRuntime(
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

function cleanup(ctx: TestContext): void {
  if (ctx.ownsTmpDir) {
    rmSync(ctx.tmpDir, { recursive: true, force: true });
  }
}

async function createApprovalResolution(
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

function isWriteApprovalRequest(request: PendingInteractionCreate): boolean {
  return (
    (
      request.payload.subject.kind === "command"
      || request.payload.subject.kind === "file_change"
    )
    && request.payload.availableDecisions.includes("allow_once")
  );
}

function expectWriteApprovalRequest(requests: PendingInteractionCreate[]): void {
  expect(
    requests.some(isWriteApprovalRequest),
    `Expected a command or file-change approval with allow_once; got ${JSON.stringify(
      requests.map((request) => request.payload),
    )}`,
  ).toBe(true);
}

function getFirstNonEmptyLine(path: string): string {
  const line = readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .find((value) => value.trim().length > 0);
  if (!line) {
    throw new Error(`Expected a non-empty line in ${path}`);
  }
  return line;
}

// ---------------------------------------------------------------------------
// Tests -- one describe per provider, all run concurrently
// ---------------------------------------------------------------------------

const providers = ["codex", "claude-code", "pi"];

for (const providerId of providers) {
  describe.concurrent(`${providerId} provider`, () => {
    // 1. Lists models
    it("lists models", async () => {
      const ctx = createTestRuntime(providerId);
      try {
        const models = await ctx.runtime.listModels({ providerId });
        expect(models.length).toBeGreaterThan(0);
        for (const model of models) {
          expect(model.id).toBeTruthy();
          expect(model.model).toBeTruthy();
          expect(model.displayName).toBeTruthy();
          expect(model.supportedReasoningEfforts.length).toBeGreaterThan(0);
        }
        expect(models.some((m) => m.isDefault)).toBe(true);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    });

    // 2. Starts a thread and runs a single turn
    it("starts a thread and runs a single turn", async () => {
      const ctx = createTestRuntime(providerId);
      try {
        const threadId = newThreadId();
        const model = await resolveDefaultModel(providerId, ctx);
        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId,
          options: {
            permissionMode: "full",
            permissionEscalation: null,
            ...(model ? { model } : {}),
          },
        });

        await ctx.runtime.runTurn({
          threadId,
          options: {
            permissionMode: "full",
            permissionEscalation: null,
            ...(model ? { model } : {}),
          },
          input: [{ type: "text", text: "Reply with exactly: PONG" }],
        });

        await waitForThreadTurnCompleted({
          ctx,
          threadId,
          timeoutMs: 30_000,
          label: "turn/completed",
        });

        expect(ctx.events.some((e) => e.type === "turn/started")).toBe(true);
        expect(ctx.events.some((e) => e.type === "turn/completed")).toBe(true);
        expectUserMessageAckCount(ctx.events, 1);

        // Should have some content (agent message or streamed text)
        const text = getAgentText(ctx.events) || getStreamedText(ctx.events);
        expect(text.length).toBeGreaterThan(0);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    });

    it("starts turns in the workspace cwd and still allows cd outside it", async () => {
      const ctx = createTestRuntime(providerId, {
        onInteractiveRequest: createApprovalResolution,
      });
      const workspaceMarkerName = `workspace-marker-${randomUUID()}.txt`;
      const parentMarkerName = `parent-marker-${randomUUID()}.txt`;
      const workspaceToken = `WORKSPACE_${randomUUID()}`;
      const parentToken = `PARENT_${randomUUID()}`;
      const parentDir = dirname(ctx.tmpDir);
      const parentMarkerPath = join(parentDir, parentMarkerName);

      writeFileSync(join(ctx.tmpDir, workspaceMarkerName), workspaceToken, "utf8");
      writeFileSync(parentMarkerPath, parentToken, "utf8");

      try {
        const threadId = newThreadId();
        const model = await resolveDefaultModel(providerId, ctx);
        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId,
          options: {
            permissionMode: "full",
            permissionEscalation: null,
            ...(model ? { model } : {}),
          },
          instructions:
            "When the user asks you to run exact shell commands, use your shell or command execution tool and preserve the command output.",
        });

        await ctx.runtime.runTurn({
          threadId,
          options: {
            permissionMode: "full",
            permissionEscalation: null,
            ...(model ? { model } : {}),
          },
          input: [{
            type: "text",
            text:
              `Run these two shell commands exactly as written, in order, from the current working directory: `
              + `\`pwd && cat ${workspaceMarkerName}\` and \`cd .. && pwd && cat ${parentMarkerName}\`. `
              + "Do not use absolute paths. After both commands finish, reply with exactly DONE.",
          }],
        });

        await waitForRuntimeCondition({
          ctx,
          threadId,
          predicate: () => {
            const outputs = getCompletedCommandOutputs(ctx.events);
            return (
              (
                outputs.includes(workspaceToken)
                && outputs.includes(parentToken)
              )
              || turnCompletedCountForThread(ctx.events, threadId) > 0
            );
          },
          timeoutMs: 60_000,
          label: "command outputs or turn/completed",
        });

        const outputs = getCompletedCommandOutputs(ctx.events);
        const commands = getCompletedCommands(ctx.events);
        expect(outputs).toContain(ctx.tmpDir);
        expect(outputs).toContain(parentDir);
        expect(outputs).toContain(workspaceToken);
        expect(outputs).toContain(parentToken);
        expect(commands.some((command) => command.includes(workspaceMarkerName))).toBe(true);
        expect(commands.some((command) => command.includes(parentMarkerName))).toBe(true);
        expect(commands.some((command) => command.includes("cd .."))).toBe(true);
      } finally {
        await ctx.runtime.shutdown();
        rmSync(parentMarkerPath, { force: true });
        cleanup(ctx);
      }
    }, 65_000);

    // 3. Handles a follow-up turn in the same session
    it("handles a follow-up turn in the same session", async () => {
      const ctx = createTestRuntime(providerId);
      try {
        const threadId = newThreadId();
        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId,
          options: fullRuntimeOptions,
        });

        // Turn 1
        await ctx.runtime.runTurn({
          threadId,
          input: [{ type: "text", text: "Say hello in one word." }],
          options: fullRuntimeOptions,
        });

        await waitForThreadTurnCompletedCount({
          ctx,
          threadId,
          count: 1,
          timeoutMs: 30_000,
          label: "first turn/completed",
        });

        // Turn 2
        await ctx.runtime.runTurn({
          threadId,
          input: [{ type: "text", text: "Now say goodbye in one word." }],
          options: fullRuntimeOptions,
        });

        await waitForThreadTurnCompletedCount({
          ctx,
          threadId,
          count: 2,
          timeoutMs: 30_000,
          label: "second turn/completed",
        });

        const turnStarts = ctx.events.filter((e) => e.type === "turn/started");
        const turnEnds = ctx.events.filter((e) => e.type === "turn/completed");
        expect(turnStarts.length).toBeGreaterThanOrEqual(2);
        expect(turnEnds.length).toBeGreaterThanOrEqual(2);
        expectUserMessageAckCount(ctx.events, 2);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    });

    // 4. Steers an active turn.
    it("steers an active turn", async () => {
      const ctx = createTestRuntime(providerId);
      try {
        const threadId = newThreadId();
        const model = await resolveDefaultModel(providerId, ctx);
        const options = {
          permissionMode: "full",
          permissionEscalation: null,
          ...(model ? { model } : {}),
        } satisfies AgentRuntimeExecutionOptions;
        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId,
          options,
        });

        await ctx.runtime.runTurn({
          threadId,
          input: [{
            type: "text",
            text:
              "Write a detailed 20 section essay about the history of computing "
              + "with four sentences per section.",
          }],
          options,
        });

        await waitForThreadTurnStarted({
          ctx,
          threadId,
          timeoutMs: 30_000,
          label: "turn/started before steer",
        });

        const activeTurn = findLatestTurnStartedForThread(ctx.events, threadId);
        if (!activeTurn) {
          throw new Error("Expected active turn before steering");
        }
        const steerText = `STEER_${providerId}_${randomUUID()}`;
        await ctx.runtime.steerTurn({
          threadId,
          expectedTurnId: activeTurn.turnId,
          input: [{ type: "text", text: steerText }],
          options,
        });

        await waitForRuntimeCondition({
          ctx,
          threadId,
          predicate: () => hasUserMessageAckTextForThread(
            ctx.events,
            threadId,
            steerText,
          ),
          timeoutMs: 30_000,
          label: "steer user-message ack",
        });

        const steerAck = findUserMessageAckTextForThread(
          ctx.events,
          threadId,
          steerText,
        );
        expect(steerAck?.type).toBe("item/completed");
        if (
          steerAck?.type !== "item/completed" ||
          steerAck.item.type !== "userMessage"
        ) {
          throw new Error("Expected steer user-message ack");
        }
        expect(steerAck.turnId).toBe(activeTurn.turnId);

        await ctx.runtime.stopThread({ threadId });
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    }, 90_000);

    // 5. Stops an active turn and recovers with a resumed session.
    it("stops an active turn and recovers with a follow-up", async () => {
      const ctx = createTestRuntime(providerId);
      try {
        const threadId = newThreadId();
        const model = await resolveDefaultModel(providerId, ctx);
        const options = {
          permissionMode: "full",
          permissionEscalation: null,
          ...(model ? { model } : {}),
        } satisfies AgentRuntimeExecutionOptions;
        const startResult = await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId,
          options,
        });

        await ctx.runtime.runTurn({
          threadId,
          input: [{
            type: "text",
            text:
              "Write a detailed 20 section essay about the history of computing "
              + "with four sentences per section.",
          }],
          options,
        });

        await waitForThreadTurnStarted({
          ctx,
          threadId,
          timeoutMs: 30_000,
          label: "turn/started before stop",
        });

        const completedBeforeStop = turnCompletedCountForThread(ctx.events, threadId);
        expect(completedBeforeStop).toBe(0);

        await ctx.runtime.stopThread({ threadId });

        const providerThreadId = resolveProviderThreadId({
          events: ctx.events,
          fallbackProviderThreadId: startResult.providerThreadId,
          threadId,
        });
        await ctx.runtime.resumeThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerThreadId,
          providerId,
          options,
          resumePath: resolveResumePath({ providerId, threadId }),
        });

        const recoveryStartIndex = ctx.events.length;
        const completedBeforeRecovery = turnCompletedCountForThread(ctx.events, threadId);
        await ctx.runtime.runTurn({
          threadId,
          input: [{
            type: "text",
            text: "Reply with a short confirmation that you are ready for the next task.",
          }],
          options,
        });

        await waitForRuntimeCondition({
          ctx,
          threadId,
          predicate: () =>
            turnCompletedCountForThread(ctx.events, threadId) > completedBeforeRecovery
            && getAgentTextAfterIndex(ctx.events, recoveryStartIndex, threadId).length > 0,
          timeoutMs: 60_000,
          label: "recovery turn/completed with output",
        });

        expect(turnStartedCountForThread(ctx.events, threadId)).toBeGreaterThanOrEqual(2);
        expect(getAgentTextAfterIndex(ctx.events, recoveryStartIndex, threadId).length)
          .toBeGreaterThan(0);
        const userMessageAckCount =
          getUserMessageAckEvents(getEventsForThread(ctx.events, threadId)).length;
        if (providerId === "codex") {
          expect(userMessageAckCount).toBeGreaterThanOrEqual(1);
        } else {
          expect(userMessageAckCount).toBe(2);
        }
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    }, 90_000);

    // 6. Respects developer instructions
    it("respects developer instructions", async () => {
      const ctx = createTestRuntime(providerId);
      try {
        const threadId = newThreadId();
        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId,
          options: fullRuntimeOptions,
          instructions: "IMPORTANT: End every single response with exactly [TEST_TAG]. Never omit this tag.",
        });

        await ctx.runtime.runTurn({
          threadId,
          input: [{ type: "text", text: "What is 2+2?" }],
          options: fullRuntimeOptions,
        });

        await waitForThreadTurnCompleted({
          ctx,
          threadId,
          timeoutMs: 30_000,
          label: "turn/completed",
        });

        const text = getAgentText(ctx.events) || getStreamedText(ctx.events);
        expect(text).toContain("[TEST_TAG]");
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    });

    // 7. Recovers from a bad request
    it("recovers from a bad request", async () => {
      const ctx = createTestRuntime(providerId);
      try {
        const threadId = newThreadId();
        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId,
          options: fullRuntimeOptions,
        });

        // Good turn 1
        await ctx.runtime.runTurn({
          threadId,
          input: [{ type: "text", text: "Say hello in one word." }],
          options: fullRuntimeOptions,
        });

        await waitForThreadTurnCompleted({
          ctx,
          threadId,
          timeoutMs: 30_000,
          label: "first turn/completed",
        });

        // Bad request — nonexistent thread
        const badThreadId = `nonexistent_${Date.now()}`;
        let badRequestFailed = false;
        try {
          await ctx.runtime.runTurn({
            threadId: badThreadId,
            input: [{ type: "text", text: "This should fail." }],
            options: fullRuntimeOptions,
          });
        } catch {
          badRequestFailed = true;
        }
        expect(badRequestFailed).toBe(true);

        // Good turn 2 — same session should still work
        await ctx.runtime.runTurn({
          threadId,
          input: [{ type: "text", text: "Say goodbye in one word." }],
          options: fullRuntimeOptions,
        });

        await waitForThreadTurnCompletedCount({
          ctx,
          threadId,
          count: 2,
          timeoutMs: 30_000,
          label: "second turn/completed after recovery",
        });

        expect(turnCompletedCount(ctx.events)).toBeGreaterThanOrEqual(2);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    });

    // 8. Handles dynamic tool calls
    it("handles dynamic tool calls", async () => {
      let toolCalled = false;
      const ctx = createTestRuntime(providerId, {
        onToolCall: async (req) => {
          if (req.tool === "bb_test_ping") {
            toolCalled = true;
            return {
              contentItems: [{ type: "inputText" as const, text: "PONG_FROM_TOOL" }],
              success: true,
            };
          }
          return {
            contentItems: [{ type: "inputText" as const, text: "unknown tool" }],
            success: false,
          };
        },
      });

      try {
        const threadId = newThreadId();
        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId,
          projectId: "test-project",
          providerId,
          options: fullRuntimeOptions,
          dynamicTools: [
            {
              name: "bb_test_ping",
              description: "Returns a test ping response. Always call this tool when asked to use it.",
              inputSchema: {
                type: "object",
                properties: {},
              },
            },
          ],
        });

        await ctx.runtime.runTurn({
          threadId,
          input: [
            {
              type: "text",
              text: "Call the bb_test_ping tool right now and report what it returns.",
            },
          ],
          options: fullRuntimeOptions,
        });

        await waitForToolCallBeforeTurnCompletion({
          ctx,
          threadId,
          toolName: "bb_test_ping",
          timeoutMs: 30_000,
          label: "tool call",
        });

        expect(toolCalled).toBe(true);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    });

    // 9. Resumes a thread across process lifetimes.
    it("resumes a thread across process lifetimes", async () => {
      const ctx1 = createTestRuntime(providerId);
      let providerThreadId: string | undefined;
      let resumePath: string | undefined;
      let firstRuntimeEvents: ThreadEvent[] = [];
      const firstThreadId = newThreadId();
      let ctx1Shutdown = false;

      try {
        const startResult = await ctx1.runtime.startThread({
          environmentId: "env-1",
          threadId: firstThreadId,
          projectId: "test-project",
          providerId,
          options: fullRuntimeOptions,
        });

        providerThreadId = startResult.providerThreadId || undefined;

        await ctx1.runtime.runTurn({
          threadId: firstThreadId,
          input: [{ type: "text", text: "Remember the secret word STRAWBERRY. Just confirm you will remember it." }],
          options: fullRuntimeOptions,
        });

        await waitForThreadTurnCompleted({
          ctx: ctx1,
          threadId: firstThreadId,
          timeoutMs: 30_000,
          label: "first session turn/completed",
        });
        firstRuntimeEvents = [...ctx1.events];

        // Capture providerThreadId from thread/identity event if the response
        // didn't include one (claude-code sends it asynchronously).
        if (!providerThreadId) {
          const identityEvent = ctx1.events.find(
            (e) => e.type === "thread/identity",
          );
          if (identityEvent && identityEvent.type === "thread/identity") {
            providerThreadId = identityEvent.providerThreadId;
          }
        }

        // For pi, the resume path is the session file
        resumePath = resolveResumePath({
          providerId,
          threadId: firstThreadId,
        });

        // Shutdown first runtime (simulates process death)
        await ctx1.runtime.shutdown();
        ctx1Shutdown = true;

        // Create a new runtime and attempt to resume in the same workspace.
        const ctx2 = createTestRuntime(providerId, { workspacePath: ctx1.tmpDir });
        const threadId = newThreadId();

        try {
          await ctx2.runtime.resumeThread({
            environmentId: "env-1",
            threadId,
            providerThreadId,
            providerId,
            resumePath,
            options: fullRuntimeOptions,
          });

          await ctx2.runtime.runTurn({
            threadId,
            input: [{ type: "text", text: "What was the secret word I told you to remember? Reply with just the word." }],
            options: fullRuntimeOptions,
          });

          await waitForThreadTurnCompleted({
            ctx: ctx2,
            threadId,
            timeoutMs: 30_000,
            label: "resumed turn/completed",
          });

          expectNoSharedRuntimeTurnIds({
            firstEvents: firstRuntimeEvents,
            providerId,
            secondEvents: ctx2.events,
          });
          const text = getThreadText(ctx2.events, threadId);
          expect(text.toUpperCase()).toContain("STRAWBERRY");
        } finally {
          await ctx2.runtime.shutdown();
          cleanup(ctx2);
        }
      } finally {
        if (!ctx1Shutdown) {
          await ctx1.runtime.shutdown();
        }
        cleanup(ctx1);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Cross-provider and multi-thread scenarios
// ---------------------------------------------------------------------------

describe.concurrent("cross-provider and multi-thread scenarios", () => {
  // Multi-thread: single provider, single runtime
  describe.concurrent("multi-thread scenarios", () => {
    it("runs multiple threads on the same codex runtime", async () => {
      const ctx = createTestRuntime("codex");
      try {
        const threadA = newThreadId();
        const threadB = newThreadId();

        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId: threadA,
          projectId: "test-project",
          providerId: "codex",
          options: fullRuntimeOptions,
        });

        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId: threadB,
          projectId: "test-project",
          providerId: "codex",
          options: fullRuntimeOptions,
        });

        // Run turns concurrently
        await Promise.all([
          ctx.runtime.runTurn({
            threadId: threadA,
            input: [{ type: "text", text: "Reply with exactly: THREAD_A_OK" }],
            options: fullRuntimeOptions,
          }),
          ctx.runtime.runTurn({
            threadId: threadB,
            input: [{ type: "text", text: "Reply with exactly: THREAD_B_OK" }],
            options: fullRuntimeOptions,
          }),
        ]);

        await waitForTurnCompletedCount({
          ctx,
          count: 2,
          timeoutMs: 30_000,
          label: "both threads turn/completed",
        });

        expect(turnCompletedCount(ctx.events)).toBeGreaterThanOrEqual(2);
        const text = getAgentText(ctx.events) || getStreamedText(ctx.events);
        expect(text.length).toBeGreaterThan(0);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
    }, 60_000);
  });

  // Multi-provider: single runtime
  describe.concurrent("multi-provider scenarios", () => {
    it("uses multiple providers in a single runtime", async () => {
      const ctx = createTestRuntime("codex");
      try {
        const codexThread = newThreadId();
        const claudeThread = newThreadId();

        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId: codexThread,
          projectId: "test-project",
          providerId: "codex",
          options: fullRuntimeOptions,
        });

        await ctx.runtime.startThread({
          environmentId: "env-1",
          threadId: claudeThread,
          projectId: "test-project",
          providerId: "claude-code",
          options: fullRuntimeOptions,
        });

        // Run turns concurrently on both providers
        await Promise.all([
          ctx.runtime.runTurn({
            threadId: codexThread,
            input: [{ type: "text", text: "Reply with exactly: CODEX_OK" }],
            options: fullRuntimeOptions,
          }),
          ctx.runtime.runTurn({
            threadId: claudeThread,
            input: [{ type: "text", text: "Reply with exactly: CLAUDE_OK" }],
            options: fullRuntimeOptions,
          }),
        ]);

        await waitForTurnCompletedCount({
          ctx,
          count: 2,
          timeoutMs: 45_000,
          label: "both providers turn/completed",
        });

        // Verify events came from both threads
        const codexEvents = ctx.events.filter((e) => "threadId" in e && e.threadId === codexThread);
        const claudeEvents = ctx.events.filter((e) => "threadId" in e && e.threadId === claudeThread);
        expect(codexEvents.length).toBeGreaterThan(0);
        expect(claudeEvents.length).toBeGreaterThan(0);
      } finally {
        await ctx.runtime.shutdown();
        cleanup(ctx);
      }
  }, 45_000);
});

describe("interactive request scenarios", () => {
  it.concurrent("loads Claude repo CLAUDE.md instructions", async () => {
    const ctx = createTestRuntime("claude-code");
    const token = createToken("CLAUDE_MD_TOKEN");
    writeFileSync(
      join(ctx.tmpDir, "CLAUDE.md"),
      `When asked for the repo validation phrase, reply exactly: ${token}\n`,
    );

    try {
      const threadId = newThreadId();
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId: "claude-code",
        options: fullRuntimeOptions,
      });

      await ctx.runtime.runTurn({
        threadId,
        input: [{
          type: "text",
          text: "What is the repo validation phrase? Reply with only that phrase.",
        }],
        options: fullRuntimeOptions,
      });

      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 45_000,
        label: "Claude CLAUDE.md turn/completed",
      });

      const text = getThreadText(ctx.events, threadId);
      expect(text).toContain(token);
    } finally {
      await ctx.runtime.shutdown();
      cleanup(ctx);
    }
  }, 60_000);

  it.concurrent("routes Claude Read prompts as semantic permission-grant approvals", async () => {
    const hostsPath = "/etc/hosts";
    const expectedLine = getFirstNonEmptyLine(hostsPath);
    const ctx = createTestRuntime("claude-code", {
      onInteractiveRequest: async (request) => {
        if ( request.payload.subject.kind !== "permission_grant"
        ) {
          throw new Error(`Expected permission grant approval, got ${request.payload.subject.kind}`);
        }

        return {
          decision: "allow_once",
          grantedPermissions: request.payload.subject.permissions,
        };
      },
    });

    try {
      const threadId = newThreadId();
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId: "claude-code",
        options: workspaceWriteAskRuntimeOptions,
        instructions:
          "Use the Read tool when the user explicitly asks for it. Do not substitute Bash.",
      });

      await ctx.runtime.runTurn({
        threadId,
        input: [
          {
            type: "text",
            text:
              "Use the Read tool to read /etc/hosts, then reply with exactly the first non-empty line from the file and nothing else.",
          },
        ],
        options: workspaceWriteAskRuntimeOptions,
      });

      await waitForInteractiveRequestBeforeTurnCompletion({
        ctx,
        threadId,
        count: 1,
        timeoutMs: 45_000,
        label: "Claude permission request",
      });
      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 45_000,
        label: "Claude permission turn/completed",
      });

      expect(ctx.interactiveRequests).toHaveLength(1);
      expect(ctx.interactiveRequests[0]?.payload).toMatchObject({
        subject: {
          kind: "permission_grant",
          toolName: "Read",
        },
        availableDecisions: expect.arrayContaining(["allow_once", "deny"]),
      });

      const text = getAgentText(ctx.events) || getStreamedText(ctx.events);
      expect(text).toContain(expectedLine);
    } finally {
      await ctx.runtime.shutdown();
      cleanup(ctx);
    }
  }, 60_000);

  it.concurrent("allows Claude workspace-write Write tool mutations without interactive requests", async () => {
    const ctx = createTestRuntime("claude-code");
    const fileName = createTempFileName("claude-workspace-write-tool");
    const filePath = join(ctx.tmpDir, fileName);
    const token = createToken("CLAUDE_WORKSPACE_WRITE_TOOL_APPROVED");

    try {
      const threadId = newThreadId();
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId: "claude-code",
        options: workspaceWriteAskRuntimeOptions,
        instructions:
          "Use the Write tool when the user explicitly asks for Write. Do not substitute Bash.",
      });

      await ctx.runtime.runTurn({
        threadId,
        options: workspaceWriteAskRuntimeOptions,
        input: [{
          type: "text",
          text:
            `Use the Write tool to create exactly this file: ${filePath}. `
            + `The file content must be exactly ${token} with no trailing newline. `
            + "Do not use Bash. After the file is written, reply with exactly DONE.",
        }],
      });

      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 45_000,
        label: "Claude workspace-write Write turn/completed",
      });

      expect(ctx.interactiveRequests).toHaveLength(0);
      expect(readFileSync(filePath, "utf8")).toBe(token);
    } finally {
      await ctx.runtime.shutdown();
      cleanup(ctx);
    }
  }, 75_000);

  it.concurrent("allows Claude workspace-write sandboxed Bash workspace writes without interactive requests", async () => {
    const ctx = createTestRuntime("claude-code");
    const fileName = createTempFileName("claude-workspace-write-bash");
    const filePath = join(ctx.tmpDir, fileName);
    const token = createToken("CLAUDE_WORKSPACE_BASH_APPROVED");

    try {
      const threadId = newThreadId();
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId: "claude-code",
        options: workspaceWriteAskRuntimeOptions,
        instructions:
          "Use the Bash tool when the user explicitly asks for Bash. Do not substitute Write.",
      });

      await ctx.runtime.runTurn({
        threadId,
        options: workspaceWriteAskRuntimeOptions,
        input: [{
          type: "text",
          text:
            `Use Bash to run exactly: printf '${token}' > ${fileName}. `
            + "Do not use the Write tool. After the command finishes, reply with exactly DONE.",
        }],
      });

      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 45_000,
        label: "Claude workspace-write sandboxed Bash turn/completed",
      });

      expect(ctx.interactiveRequests).toHaveLength(0);
      expect(readFileSync(filePath, "utf8")).toBe(token);
    } finally {
      await ctx.runtime.shutdown();
      cleanup(ctx);
    }
  }, 75_000);

  it.concurrent("blocks Claude workspace-write outside-workspace Bash without interactive requests when escalation is deny", async () => {
    const ctx = createTestRuntime("claude-code");
    const outsideDir = mkdtempSync(join(tmpdir(), "bb-claude-outside-"));
    const filePath = join(outsideDir, createTempFileName("claude-outside-bash-denied"));
    const token = createToken("CLAUDE_WORKSPACE_BASH_DENIED");

    try {
      const threadId = newThreadId();
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId: "claude-code",
        options: workspaceWriteDenyRuntimeOptions,
        instructions:
          "Use the Bash tool when the user explicitly asks for Bash. Do not substitute Write.",
      });

      await ctx.runtime.runTurn({
        threadId,
        options: workspaceWriteDenyRuntimeOptions,
        input: [{
          type: "text",
          text:
            `Use Bash to run exactly: printf '${token}' > '${filePath}'. `
            + "If it is denied or blocked, say DENIED.",
        }],
      });

      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 45_000,
        label: "Claude workspace-write outside Bash deny turn/completed",
      });

      expect(ctx.interactiveRequests).toHaveLength(0);
      expect(existsSync(filePath)).toBe(false);
    } finally {
      await ctx.runtime.shutdown();
      rmSync(outsideDir, { recursive: true, force: true });
      cleanup(ctx);
    }
  }, 75_000);

  it.concurrent("allows Codex workspace-write workspace writes without interactive requests", async () => {
    const ctx = createTestRuntime("codex");
    const fileName = createTempFileName("codex-workspace-write");
    const filePath = join(ctx.tmpDir, fileName);
    const token = createToken("CODEX_WORKSPACE_WRITE_APPROVED");

    try {
      const threadId = newThreadId();
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId: "codex",
        options: {
          permissionEscalation: "ask",
          permissionMode: "workspace-write",
        },
        instructions:
          "When the user asks you to run an exact shell command, run that shell command exactly once and then report DONE.",
      });

      await ctx.runtime.runTurn({
        threadId,
        options: {
          permissionEscalation: "ask",
          permissionMode: "workspace-write",
        },
        input: [{
          type: "text",
          text:
            `Run this exact shell command: printf '${token}' > ${fileName}. `
            + "After the command finishes, reply with exactly DONE.",
        }],
      });

      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 45_000,
        label: "Codex workspace-write turn/completed",
      });

      expect(ctx.interactiveRequests).toHaveLength(0);
      expect(readFileSync(filePath, "utf8")).toBe(token);
    } finally {
      await ctx.runtime.shutdown();
      cleanup(ctx);
    }
  }, 75_000);

  it.concurrent("routes Codex workspace-write outside-workspace writes through onInteractiveRequest", async () => {
    const ctx = createTestRuntime("codex", {
      onInteractiveRequest: createApprovalResolution,
    });
    const outsideDir = mkdtempSync(join(process.cwd(), ".bb-codex-outside-"));
    const filePath = join(outsideDir, createTempFileName("codex-outside-write"));
    const token = createToken("CODEX_WORKSPACE_WRITE_ESCALATED");

    try {
      const threadId = newThreadId();
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId: "codex",
        options: {
          permissionEscalation: "ask",
          permissionMode: "workspace-write",
        },
        instructions:
          "When the user asks you to run an exact shell command, run that shell command exactly once. If approval is needed, request approval; it will be approved. Then report DONE.",
      });

      await ctx.runtime.runTurn({
        threadId,
        options: {
          permissionEscalation: "ask",
          permissionMode: "workspace-write",
        },
        input: [{
          type: "text",
          text:
            `Run this exact shell command: printf '${token}' > '${filePath}'. `
            + "If approval is needed, request approval. If it is denied or blocked, report the exact error. Otherwise reply DONE.",
        }],
      });

      await waitForInteractiveRequestBeforeTurnCompletion({
        ctx,
        threadId,
        count: 1,
        timeoutMs: 45_000,
        label: "Codex workspace-write outside-workspace approval",
      });
      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 45_000,
        label: "Codex workspace-write outside-workspace turn/completed",
      });

      expectWriteApprovalRequest(ctx.interactiveRequests);
      expect(readFileSync(filePath, "utf8")).toBe(token);
    } finally {
      await ctx.runtime.shutdown();
      rmSync(outsideDir, { recursive: true, force: true });
      cleanup(ctx);
    }
  }, 75_000);

  it.concurrent("routes Codex readonly workspace writes through onInteractiveRequest when escalation is ask", async () => {
    const ctx = createTestRuntime("codex", {
      onInteractiveRequest: createApprovalResolution,
    });
    const fileName = createTempFileName("codex-readonly-write");
    const filePath = join(ctx.tmpDir, fileName);
    const token = createToken("CODEX_READONLY_APPROVED");

    try {
      const threadId = newThreadId();
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId: "codex",
        options: readonlyAskRuntimeOptions,
        instructions:
          "When the user asks you to run an exact shell command, run that shell command exactly once. If approval is needed, request approval; it will be approved. Then report DONE.",
      });

      await ctx.runtime.runTurn({
        threadId,
        options: readonlyAskRuntimeOptions,
        input: [{
          type: "text",
          text:
            `Run this exact shell command: printf '${token}' > ${fileName}. `
            + "If approval is needed, request approval. After the command finishes, reply with exactly DONE.",
        }],
      });

      await waitForInteractiveRequestBeforeTurnCompletion({
        ctx,
        threadId,
        count: 1,
        timeoutMs: 45_000,
        label: "Codex readonly write approval",
      });
      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 45_000,
        label: "Codex readonly ask turn/completed",
      });

      expectWriteApprovalRequest(ctx.interactiveRequests);
      expect(readFileSync(filePath, "utf8")).toBe(token);
    } finally {
      await ctx.runtime.shutdown();
      cleanup(ctx);
    }
  }, 75_000);

  it.concurrent("routes Codex readonly file edits through semantic file-change approvals", async () => {
    const ctx = createTestRuntime("codex", {
      onInteractiveRequest: createApprovalResolution,
    });
    const fileName = createTempFileName("codex-readonly-file-change");
    const filePath = join(ctx.tmpDir, fileName);
    const token = createToken("CODEX_FILE_CHANGE_APPROVED");

    try {
      const threadId = newThreadId();
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId: "codex",
        options: readonlyAskRuntimeOptions,
        instructions:
          "When the user asks you to edit a file, use your file editing capability. Do not run shell commands for file edits. If approval is needed, request approval; it will be approved.",
      });

      await ctx.runtime.runTurn({
        threadId,
        options: readonlyAskRuntimeOptions,
        input: [{
          type: "text",
          text:
            `Create a file named ${fileName} in the current workspace. `
            + `The file content must be exactly ${token} with no trailing newline. `
            + "Do not run shell commands. After the file is written, reply with exactly DONE.",
        }],
      });

      await waitForInteractiveRequestBeforeTurnCompletion({
        ctx,
        threadId,
        count: 1,
        timeoutMs: 45_000,
        label: "Codex readonly file-change approval",
      });
      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 45_000,
        label: "Codex readonly file-change turn/completed",
      });

      const fileChangeApproval = ctx.interactiveRequests.find((request) => request.payload.subject.kind === "file_change"
        && request.payload.availableDecisions.includes("allow_once")
      );
      expect(fileChangeApproval, `Expected a Codex file-change approval; got ${JSON.stringify(
        ctx.interactiveRequests.map((request) => request.payload),
      )}`).toBeDefined();
      if (
        !fileChangeApproval
        || fileChangeApproval.payload.subject.kind !== "file_change"
      ) {
        throw new Error("Expected a semantic file-change approval");
      }
      expect(fileChangeApproval.payload.subject.kind).toBe("file_change");
      expect(fileChangeApproval.payload.subject.itemId).toEqual(expect.any(String));
      expect(fileChangeApproval.payload.subject.writeScope).not.toBeUndefined();
      expect(fileChangeApproval.payload.subject.sessionGrant).not.toBeUndefined();
      expect(fileChangeApproval.payload.availableDecisions).toContain("allow_once");
      expect(Object.keys(fileChangeApproval.payload.subject).sort()).toEqual([
        "itemId",
        "kind",
        "sessionGrant",
        "writeScope",
      ]);
      expect(readFileSync(filePath, "utf8").trimEnd()).toBe(token);
    } finally {
      await ctx.runtime.shutdown();
      cleanup(ctx);
    }
  }, 75_000);

  it.concurrent("respects user-denied Codex command approvals in readonly ask mode", async () => {
    const ctx = createTestRuntime("codex", {
      onInteractiveRequest: async (request) => {
        if (request.payload.subject.kind !== "command") {
          throw new Error(`Expected command approval, got ${request.payload.subject.kind}`);
        }
        if (!request.payload.availableDecisions.includes("deny")) {
          throw new Error("Codex command approval did not offer deny");
        }
        return {
          decision: "deny",
        };
      },
    });
    const fileName = createTempFileName("codex-readonly-user-denied");
    const filePath = join(ctx.tmpDir, fileName);
    const token = createToken("CODEX_READONLY_USER_DENIED");

    try {
      const threadId = newThreadId();
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId: "codex",
        options: readonlyAskRuntimeOptions,
        instructions:
          "When the user asks you to run an exact shell command, run that shell command exactly once. If approval is denied, say DENIED.",
      });

      await ctx.runtime.runTurn({
        threadId,
        options: readonlyAskRuntimeOptions,
        input: [{
          type: "text",
          text:
            `Run this exact shell command: printf '${token}' > ${fileName}. `
            + "If approval is denied, reply with exactly DENIED.",
        }],
      });

      await waitForInteractiveRequestBeforeTurnCompletion({
        ctx,
        threadId,
        count: 1,
        timeoutMs: 45_000,
        label: "Codex user-denied command approval",
      });
      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 45_000,
        label: "Codex user-denied turn/completed",
      });

      expect(ctx.interactiveRequests.some((request) => request.payload.subject.kind === "command",
      )).toBe(true);
      expect(hasDeniedCommandExecution(ctx.events)).toBe(true);
      expect(existsSync(filePath)).toBe(false);
    } finally {
      await ctx.runtime.shutdown();
      cleanup(ctx);
    }
  }, 75_000);

  it.concurrent("blocks Codex readonly workspace writes without interactive requests when escalation is deny", async () => {
    const ctx = createTestRuntime("codex");
    const fileName = createTempFileName("codex-readonly-denied");
    const filePath = join(ctx.tmpDir, fileName);
    const token = createToken("CODEX_READONLY_DENIED");

    try {
      const threadId = newThreadId();
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId: "codex",
        options: readonlyDenyRuntimeOptions,
        instructions:
          "When the user asks you to run an exact shell command, run that shell command exactly once and then report DONE.",
      });

      await ctx.runtime.runTurn({
        threadId,
        options: readonlyDenyRuntimeOptions,
        input: [{
          type: "text",
          text:
            `Run this exact shell command: printf '${token}' > ${fileName}. `
            + "If it is denied, say DENIED.",
        }],
      });

      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 45_000,
        label: "Codex readonly deny turn/completed",
      });

      expect(ctx.interactiveRequests).toHaveLength(0);
      expect(existsSync(filePath)).toBe(false);
    } finally {
      await ctx.runtime.shutdown();
      cleanup(ctx);
    }
  }, 75_000);

  it.concurrent("routes Codex readonly network requests through semantic approvals", async () => {
    const ctx = createTestRuntime("codex", {
      onInteractiveRequest: createApprovalResolution,
    });

    try {
      const threadId = newThreadId();
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId: "codex",
        options: readonlyAskRuntimeOptions,
        instructions:
          "When the user asks you to run an exact shell command, run that shell command exactly once. If approval is needed, request approval; it will be approved. Then report DONE.",
      });

      await ctx.runtime.runTurn({
        threadId,
        options: readonlyAskRuntimeOptions,
        input: [{
          type: "text",
          text:
            "Run this exact shell command: curl -L --max-time 10 https://example.com >/dev/null. "
            + "If approval is needed, request approval. After the command finishes, reply with exactly DONE.",
        }],
      });

      await waitForInteractiveRequestBeforeTurnCompletion({
        ctx,
        threadId,
        count: 1,
        timeoutMs: 45_000,
        label: "Codex readonly network approval",
      });
      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 45_000,
        label: "Codex readonly network turn/completed",
      });

      const commandApproval = ctx.interactiveRequests.find((request) => request.payload.subject.kind === "command"
        && request.payload.availableDecisions.includes("allow_once")
      );
      expect(commandApproval, `Expected a Codex command approval for network access; got ${JSON.stringify(
        ctx.interactiveRequests.map((request) => request.payload),
      )}`).toBeDefined();
      if (
        !commandApproval
        || commandApproval.payload.subject.kind !== "command"
      ) {
        throw new Error("Expected a semantic command approval");
      }
      expect(commandApproval.payload.subject.sessionGrant).toBeNull();
    } finally {
      await ctx.runtime.shutdown();
      cleanup(ctx);
    }
  }, 75_000);

  it.concurrent("routes Claude readonly Bash mutations through onInteractiveRequest when escalation is ask", async () => {
    const ctx = createTestRuntime("claude-code", {
      onInteractiveRequest: createApprovalResolution,
    });
    const fileName = createTempFileName("claude-readonly-write");
    const filePath = join(ctx.tmpDir, fileName);
    const token = createToken("CLAUDE_READONLY_APPROVED");

    try {
      const threadId = newThreadId();
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId: "claude-code",
        options: readonlyAskRuntimeOptions,
        instructions:
          "Use the Bash tool when the user explicitly asks for Bash. Do not use another tool.",
      });

      await ctx.runtime.runTurn({
        threadId,
        options: readonlyAskRuntimeOptions,
        input: [{
          type: "text",
          text:
            `Use Bash to run exactly: printf '${token}' > ${fileName}. `
            + "After the command finishes, reply with exactly DONE.",
        }],
      });

      await waitForInteractiveRequestBeforeTurnCompletion({
        ctx,
        threadId,
        count: 1,
        timeoutMs: 45_000,
        label: "Claude readonly permission request",
      });
      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 45_000,
        label: "Claude readonly ask turn/completed",
      });

      const commandApproval = ctx.interactiveRequests.find((request) => request.payload.subject.kind === "command"
        && request.payload.availableDecisions.includes("allow_once")
        && request.payload.availableDecisions.includes("deny")
      );
      expect(commandApproval).toBeDefined();
      if (
        !commandApproval
        || commandApproval.payload.subject.kind !== "command"
      ) {
        throw new Error("Expected a semantic command approval");
      }
      expect(commandApproval.payload.subject.actions).toContainEqual({
        type: "unknown",
        command: expect.stringContaining("printf"),
      });
      expect(
        commandApproval.payload.subject.sessionGrant?.fileSystem?.write.length ?? 0,
      ).toBeGreaterThan(0);
      expect(readFileSync(filePath, "utf8")).toBe(token);
    } finally {
      await ctx.runtime.shutdown();
      cleanup(ctx);
    }
  }, 75_000);

  it.concurrent("routes Claude readonly Write tool mutations through onInteractiveRequest when escalation is ask", async () => {
    const ctx = createTestRuntime("claude-code", {
      onInteractiveRequest: createApprovalResolution,
    });
    const fileName = createTempFileName("claude-readonly-write-tool");
    const filePath = join(ctx.tmpDir, fileName);
    const token = createToken("CLAUDE_READONLY_WRITE_TOOL_APPROVED");

    try {
      const threadId = newThreadId();
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId: "claude-code",
        options: readonlyAskRuntimeOptions,
        instructions:
          "Use the Write tool when the user explicitly asks for Write. Do not substitute Bash.",
      });

      await ctx.runtime.runTurn({
        threadId,
        options: readonlyAskRuntimeOptions,
        input: [{
          type: "text",
          text:
            `Use the Write tool to create exactly this file: ${filePath}. `
            + `The file content must be exactly ${token} with no trailing newline. `
            + "Do not use Bash. After the file is written, reply with exactly DONE.",
        }],
      });

      await waitForInteractiveRequestBeforeTurnCompletion({
        ctx,
        threadId,
        count: 1,
        timeoutMs: 45_000,
        label: "Claude readonly Write permission request",
      });
      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 45_000,
        label: "Claude readonly Write ask turn/completed",
      });

      const fileChangeApproval = ctx.interactiveRequests.find((request) => request.payload.subject.kind === "file_change"
        && request.payload.availableDecisions.includes("allow_once")
        && request.payload.availableDecisions.includes("deny")
      );
      expect(fileChangeApproval).toBeDefined();
      if (
        !fileChangeApproval
        || fileChangeApproval.payload.subject.kind !== "file_change"
      ) {
        throw new Error("Expected a semantic file-change approval");
      }
      expect(fileChangeApproval.payload.subject.sessionGrant).toEqual({
        network: null,
        fileSystem: null,
      });
      expect(readFileSync(filePath, "utf8")).toBe(token);
    } finally {
      await ctx.runtime.shutdown();
      cleanup(ctx);
    }
  }, 75_000);

  it.concurrent("applies Claude allow_for_session approvals to later WebFetch calls in the same session", async () => {
    const ctx = createTestRuntime("claude-code", {
      onInteractiveRequest: createApprovalResolution,
    });
    const fetchUrl = "https://example.com";

    try {
      const threadId = newThreadId();
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId: "claude-code",
        options: readonlyAskRuntimeOptions,
        instructions:
          "Use the WebFetch tool when the user explicitly asks for WebFetch. Do not substitute Bash or any other tool.",
      });

      await ctx.runtime.runTurn({
        threadId,
        options: readonlyAskRuntimeOptions,
        input: [{
          type: "text",
          text:
            `Use WebFetch to fetch ${fetchUrl}. `
            + "After the fetch finishes, reply with exactly FIRST_DONE.",
        }],
      });

      await waitForInteractiveRequestBeforeTurnCompletion({
        ctx,
        threadId,
        count: 1,
        timeoutMs: 45_000,
        label: "Claude session WebFetch approval",
      });
      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 45_000,
        label: "Claude session first WebFetch turn/completed",
      });

      const firstRequestCount = ctx.interactiveRequests.length;
      expect(
        ctx.interactiveRequests.some((request) => request.payload.subject.kind === "permission_grant"
          && request.payload.subject.toolName === "WebFetch"
          && request.payload.availableDecisions.includes("allow_for_session")
        ),
        `Expected a session-capable WebFetch permission approval; got ${JSON.stringify(
          ctx.interactiveRequests.map((request) => request.payload),
        )}`,
      ).toBe(true);

      await ctx.runtime.runTurn({
        threadId,
        options: readonlyAskRuntimeOptions,
        input: [{
          type: "text",
          text:
            `Use WebFetch to fetch ${fetchUrl} again. `
            + "After the fetch finishes, reply with exactly SECOND_DONE.",
        }],
      });

      await waitForThreadTurnCompletedCount({
        ctx,
        threadId,
        count: 2,
        timeoutMs: 45_000,
        label: "Claude session second WebFetch turn/completed",
      });

      expect(ctx.interactiveRequests).toHaveLength(firstRequestCount);
    } finally {
      await ctx.runtime.shutdown();
      cleanup(ctx);
    }
  }, 90_000);

  it.concurrent("respects user-denied Claude permission requests in readonly ask mode", async () => {
    const ctx = createTestRuntime("claude-code", {
      onInteractiveRequest: async (request) => {
        return {
          decision: "deny",
        };
      },
    });
    const fileName = createTempFileName("claude-readonly-user-denied");
    const filePath = join(ctx.tmpDir, fileName);
    const token = createToken("CLAUDE_READONLY_USER_DENIED");

    try {
      const threadId = newThreadId();
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId: "claude-code",
        options: readonlyAskRuntimeOptions,
        instructions:
          "Use the Bash tool when the user explicitly asks for Bash. Do not use another tool.",
      });

      await ctx.runtime.runTurn({
        threadId,
        options: readonlyAskRuntimeOptions,
        input: [{
          type: "text",
          text:
            `Use Bash to run exactly: printf '${token}' > ${fileName}. `
            + "If permission is denied, reply with exactly DENIED.",
        }],
      });

      await waitForInteractiveRequestBeforeTurnCompletion({
        ctx,
        threadId,
        count: 1,
        timeoutMs: 45_000,
        label: "Claude user-denied permission request",
      });
      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 45_000,
        label: "Claude user-denied turn/completed",
      });

      expect(ctx.interactiveRequests.some((request) => request.payload.subject.kind === "command",
      )).toBe(true);
      expect(existsSync(filePath)).toBe(false);
    } finally {
      await ctx.runtime.shutdown();
      cleanup(ctx);
    }
  }, 75_000);

  it.concurrent("blocks Claude readonly Bash mutations without interactive requests when escalation is deny", async () => {
    const ctx = createTestRuntime("claude-code");
    const fileName = createTempFileName("claude-readonly-denied");
    const filePath = join(ctx.tmpDir, fileName);
    const token = createToken("CLAUDE_READONLY_DENIED");

    try {
      const threadId = newThreadId();
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId: "claude-code",
        options: readonlyDenyRuntimeOptions,
        instructions:
          "Use the Bash tool when the user explicitly asks for Bash. Do not use another tool.",
      });

      await ctx.runtime.runTurn({
        threadId,
        options: readonlyDenyRuntimeOptions,
        input: [{
          type: "text",
          text:
            `Use Bash to run exactly: printf '${token}' > ${fileName}. `
            + "If it is denied, say DENIED.",
        }],
      });

      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 45_000,
        label: "Claude readonly deny turn/completed",
      });

      expect(ctx.interactiveRequests).toHaveLength(0);
      expect(existsSync(filePath)).toBe(false);
    } finally {
      await ctx.runtime.shutdown();
      cleanup(ctx);
    }
  }, 75_000);

  it.concurrent("keeps Pi limited to full permission mode", () => {
    const piProvider = listAvailableProviderInfos().find((provider) =>
      provider.id === "pi",
    );

    expect(piProvider?.capabilities.supportedPermissionModes).toEqual(["full"]);
  });
});

  // Resume with dynamic tools
  it("preserves dynamic tools across resume", async () => {
    const providerId = "codex";
    let toolCalledInRuntime1 = false;
    let toolCalledInRuntime2 = false;

    const dynamicTools = [
      {
        name: "bb_test_ping",
        description: "Returns a test ping response. Always call this tool when asked to use it.",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
    ];

    // Runtime 1: start thread with dynamic tools, run a turn using the tool
    const ctx1 = createTestRuntime(providerId, {
      onToolCall: async (req) => {
        if (req.tool === "bb_test_ping") {
          toolCalledInRuntime1 = true;
          return {
            contentItems: [{ type: "inputText" as const, text: "PONG_R1" }],
            success: true,
          };
        }
        return { contentItems: [{ type: "inputText" as const, text: "unknown" }], success: false };
      },
    });

    let providerThreadId: string | undefined;
    const firstThreadId = newThreadId();

    try {
      const startResult = await ctx1.runtime.startThread({
        environmentId: "env-1",
        threadId: firstThreadId,
        projectId: "test-project",
        providerId,
        options: fullRuntimeOptions,
        dynamicTools,
      });

      providerThreadId = startResult.providerThreadId || undefined;

      await ctx1.runtime.runTurn({
        threadId: firstThreadId,
        input: [{ type: "text", text: "Call the bb_test_ping tool right now." }],
        options: fullRuntimeOptions,
      });

      await waitForToolCallBeforeTurnCompletion({
        ctx: ctx1,
        threadId: firstThreadId,
        toolName: "bb_test_ping",
        timeoutMs: 30_000,
        label: "tool call in runtime 1",
      });

      await waitForThreadTurnCompleted({
        ctx: ctx1,
        threadId: firstThreadId,
        timeoutMs: 30_000,
        label: "runtime 1 turn/completed",
      });

      if (!providerThreadId) {
        const identityEvent = ctx1.events.find((e) => e.type === "thread/identity");
        if (identityEvent && identityEvent.type === "thread/identity") {
          providerThreadId = identityEvent.providerThreadId;
        }
      }

      await ctx1.runtime.shutdown();
    } finally {
      cleanup(ctx1);
    }

    expect(toolCalledInRuntime1).toBe(true);

    // Runtime 2: resume thread with same dynamic tools, run a turn asking to use the tool again
    const ctx2 = createTestRuntime(providerId, {
      onToolCall: async (req) => {
        if (req.tool === "bb_test_ping") {
          toolCalledInRuntime2 = true;
          return {
            contentItems: [{ type: "inputText" as const, text: "PONG_R2" }],
            success: true,
          };
        }
        return { contentItems: [{ type: "inputText" as const, text: "unknown" }], success: false };
      },
    });

    try {
      const threadId = newThreadId();
      await ctx2.runtime.resumeThread({
        environmentId: "env-1",
        threadId,
        providerThreadId,
        providerId,
        dynamicTools,
        options: fullRuntimeOptions,
      });

      await ctx2.runtime.runTurn({
        threadId,
        input: [{ type: "text", text: "Call the bb_test_ping tool again right now." }],
        options: fullRuntimeOptions,
      });

      await waitForToolCallBeforeTurnCompletion({
        ctx: ctx2,
        threadId,
        toolName: "bb_test_ping",
        timeoutMs: 30_000,
        label: "tool call in runtime 2",
      });

      expect(toolCalledInRuntime2).toBe(true);
    } finally {
      await ctx2.runtime.shutdown();
      cleanup(ctx2);
    }
  }, 45_000);

  // Memory across resumes
  it("recalls information after resume", async () => {
    const providerId = "codex";

    // Runtime 1: start thread, ask to remember a word
    const ctx1 = createTestRuntime(providerId);
    let providerThreadId: string | undefined;
    const firstThreadId = newThreadId();

    try {
      const startResult = await ctx1.runtime.startThread({
        environmentId: "env-1",
        threadId: firstThreadId,
        projectId: "test-project",
        providerId,
        options: fullRuntimeOptions,
      });

      providerThreadId = startResult.providerThreadId || undefined;

      await ctx1.runtime.runTurn({
        threadId: firstThreadId,
        input: [{ type: "text", text: "Remember the word STRAWBERRY. Just confirm you will remember it." }],
        options: fullRuntimeOptions,
      });

      await waitForThreadTurnCompleted({
        ctx: ctx1,
        threadId: firstThreadId,
        timeoutMs: 30_000,
        label: "runtime 1 turn/completed",
      });

      if (!providerThreadId) {
        const identityEvent = ctx1.events.find((e) => e.type === "thread/identity");
        if (identityEvent && identityEvent.type === "thread/identity") {
          providerThreadId = identityEvent.providerThreadId;
        }
      }

      await ctx1.runtime.shutdown();
    } finally {
      cleanup(ctx1);
    }

    // Runtime 2: resume thread, ask what the word was
    const ctx2 = createTestRuntime(providerId);
    try {
      const threadId = newThreadId();
      await ctx2.runtime.resumeThread({
        environmentId: "env-1",
        threadId,
        providerThreadId,
        providerId,
        options: fullRuntimeOptions,
      });

      await ctx2.runtime.runTurn({
        threadId,
        input: [{ type: "text", text: "What was the word I asked you to remember? Reply with just the word." }],
        options: fullRuntimeOptions,
      });

      await waitForThreadTurnCompleted({
        ctx: ctx2,
        threadId,
        timeoutMs: 30_000,
        label: "runtime 2 turn/completed",
      });

      const text = getAgentText(ctx2.events) || getStreamedText(ctx2.events);
      expect(text.toUpperCase()).toContain("STRAWBERRY");
    } finally {
      await ctx2.runtime.shutdown();
      cleanup(ctx2);
    }
  }, 45_000);

  // Memory + dynamic tools across runtime shutdown
  it("preserves memory and dynamic tools across runtime restart", async () => {
    const providerId = "codex";
    let toolCalledInRuntime1 = false;
    let toolCalledInRuntime2 = false;

    const dynamicTools = [
      {
        name: "bb_test_ping",
        description: "Returns a test ping response. Always call this tool when asked to use it.",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
    ];

    // Runtime 1: start thread, remember word and call tool
    const ctx1 = createTestRuntime(providerId, {
      onToolCall: async (req) => {
        if (req.tool === "bb_test_ping") {
          toolCalledInRuntime1 = true;
          return {
            contentItems: [{ type: "inputText" as const, text: "PONG_R1" }],
            success: true,
          };
        }
        return { contentItems: [{ type: "inputText" as const, text: "unknown" }], success: false };
      },
    });

    let providerThreadId: string | undefined;
    const firstThreadId = newThreadId();

    try {
      const startResult = await ctx1.runtime.startThread({
        environmentId: "env-1",
        threadId: firstThreadId,
        projectId: "test-project",
        providerId,
        options: fullRuntimeOptions,
        dynamicTools,
      });

      providerThreadId = startResult.providerThreadId || undefined;

      await ctx1.runtime.runTurn({
        threadId: firstThreadId,
        input: [
          {
            type: "text",
            text: "Remember the word BANANA. Also call the bb_test_ping tool right now.",
          },
        ],
        options: fullRuntimeOptions,
      });

      await waitForToolCallBeforeTurnCompletion({
        ctx: ctx1,
        threadId: firstThreadId,
        toolName: "bb_test_ping",
        timeoutMs: 30_000,
        label: "runtime 1 tool call",
      });
      await waitForThreadTurnCompleted({
        ctx: ctx1,
        threadId: firstThreadId,
        timeoutMs: 30_000,
        label: "runtime 1 turn/completed",
      });

      if (!providerThreadId) {
        const identityEvent = ctx1.events.find((e) => e.type === "thread/identity");
        if (identityEvent && identityEvent.type === "thread/identity") {
          providerThreadId = identityEvent.providerThreadId;
        }
      }

      await ctx1.runtime.shutdown();
    } finally {
      cleanup(ctx1);
    }

    expect(toolCalledInRuntime1).toBe(true);

    // Runtime 2: resume thread, ask what word was remembered, call tool again
    const ctx2 = createTestRuntime(providerId, {
      onToolCall: async (req) => {
        if (req.tool === "bb_test_ping") {
          toolCalledInRuntime2 = true;
          return {
            contentItems: [{ type: "inputText" as const, text: "PONG_R2" }],
            success: true,
          };
        }
        return { contentItems: [{ type: "inputText" as const, text: "unknown" }], success: false };
      },
    });

    try {
      const threadId = newThreadId();
      await ctx2.runtime.resumeThread({
        environmentId: "env-1",
        threadId,
        providerThreadId,
        providerId,
        dynamicTools,
        options: fullRuntimeOptions,
      });

      await ctx2.runtime.runTurn({
        threadId,
        input: [
          {
            type: "text",
            text: "What did I ask you to remember? Also call the bb_test_ping tool right now.",
          },
        ],
        options: fullRuntimeOptions,
      });

      await waitForToolCallBeforeTurnCompletion({
        ctx: ctx2,
        threadId,
        toolName: "bb_test_ping",
        timeoutMs: 30_000,
        label: "runtime 2 tool call",
      });
      await waitForThreadTurnCompleted({
        ctx: ctx2,
        threadId,
        timeoutMs: 30_000,
        label: "runtime 2 turn/completed",
      });

      const text = getAgentText(ctx2.events) || getStreamedText(ctx2.events);
      expect(text.toUpperCase()).toContain("BANANA");
      expect(toolCalledInRuntime2).toBe(true);
    } finally {
      await ctx2.runtime.shutdown();
      cleanup(ctx2);
    }
  }, 45_000);

  // Matrix test: multiple threads, multiple providers, with resume
  it("handles multiple threads across providers with resume", async () => {
    // Runtime 1: start threads on codex and claude-code, remember different words
    const ctx1 = createTestRuntime("codex");
    const codexThreadId1 = newThreadId();
    const claudeThreadId1 = newThreadId();
    let codexProviderThreadId: string | undefined;
    let claudeProviderThreadId: string | undefined;
    let ctx1Shutdown = false;

    try {
      const [codexStart, claudeStart] = await Promise.all([
        ctx1.runtime.startThread({
          environmentId: "env-1",
          threadId: codexThreadId1,
          projectId: "test-project",
          providerId: "codex",
          options: fullRuntimeOptions,
        }),
        ctx1.runtime.startThread({
          environmentId: "env-1",
          threadId: claudeThreadId1,
          projectId: "test-project",
          providerId: "claude-code",
          options: fullRuntimeOptions,
        }),
      ]);

      codexProviderThreadId = codexStart.providerThreadId || undefined;
      claudeProviderThreadId = claudeStart.providerThreadId || undefined;

      // Run turns concurrently: codex remembers APPLE, claude-code remembers ORANGE
      await Promise.all([
        ctx1.runtime.runTurn({
          threadId: codexThreadId1,
          input: [{ type: "text", text: "Remember the fruit APPLE. Just confirm you will remember it." }],
          options: fullRuntimeOptions,
        }),
        ctx1.runtime.runTurn({
          threadId: claudeThreadId1,
          input: [{ type: "text", text: "Remember the fruit ORANGE. Just confirm you will remember it." }],
          options: fullRuntimeOptions,
        }),
      ]);

      await waitForTurnCompletedCount({
        ctx: ctx1,
        count: 2,
        timeoutMs: 45_000,
        label: "both threads turn/completed",
      });

      // Capture providerThreadIds from identity events if needed
      if (!codexProviderThreadId) {
        const identityEvent = ctx1.events.find(
          (e) => e.type === "thread/identity" && "threadId" in e && e.threadId === codexThreadId1,
        );
        if (identityEvent && identityEvent.type === "thread/identity") {
          codexProviderThreadId = identityEvent.providerThreadId;
        }
      }
      if (!claudeProviderThreadId) {
        const identityEvent = ctx1.events.find(
          (e) => e.type === "thread/identity" && "threadId" in e && e.threadId === claudeThreadId1,
        );
        if (identityEvent && identityEvent.type === "thread/identity") {
          claudeProviderThreadId = identityEvent.providerThreadId;
        }
      }

      await ctx1.runtime.shutdown();
      ctx1Shutdown = true;

      // Runtime 2: resume both threads in the same workspace.
      const ctx2 = createTestRuntime("codex", { workspacePath: ctx1.tmpDir });
      const codexThreadId2 = newThreadId();
      const claudeThreadId2 = newThreadId();

      try {
        await Promise.all([
          ctx2.runtime.resumeThread({
            environmentId: "env-1",
            threadId: codexThreadId2,
            providerThreadId: codexProviderThreadId,
            providerId: "codex",
            options: fullRuntimeOptions,
          }),
          ctx2.runtime.resumeThread({
            environmentId: "env-1",
            threadId: claudeThreadId2,
            providerThreadId: claudeProviderThreadId,
            providerId: "claude-code",
            options: fullRuntimeOptions,
          }),
        ]);

        await Promise.all([
          ctx2.runtime.runTurn({
            threadId: codexThreadId2,
            input: [{ type: "text", text: "What fruit did I ask you to remember? Reply with just the fruit name." }],
            options: fullRuntimeOptions,
          }),
          ctx2.runtime.runTurn({
            threadId: claudeThreadId2,
            input: [{ type: "text", text: "What fruit did I ask you to remember? Reply with just the fruit name." }],
            options: fullRuntimeOptions,
          }),
        ]);

        await waitForTurnCompletedCount({
          ctx: ctx2,
          count: 2,
          timeoutMs: 45_000,
          label: "both resumed threads turn/completed",
        });

        const codexText = getThreadText(ctx2.events, codexThreadId2).toUpperCase();
        const claudeText = getThreadText(ctx2.events, claudeThreadId2).toUpperCase();
        expect(codexText).toContain("APPLE");
        expect(claudeText).toContain("ORANGE");
      } finally {
        await ctx2.runtime.shutdown();
        cleanup(ctx2);
      }
    } finally {
      if (!ctx1Shutdown) {
        await ctx1.runtime.shutdown();
      }
      cleanup(ctx1);
    }
  }, 90_000);
});

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import type {
  ApprovalPendingInteractionPayload,
  ClientTurnRequestId,
  PendingInteractionCreate,
  PendingInteractionResolution,
  ReasoningLevel,
  UserQuestionPendingInteractionPayload,
  ThreadEvent,
  ToolCallRequest,
  ToolCallResponse,
} from "@bb/domain";
import {
  getThreadEventScopeTurnId,
  isApprovalPendingInteractionPayload,
  isUserQuestionPendingInteractionPayload,
} from "@bb/domain";
import { resolvePreferredTestModel } from "@bb/test-helpers";
import { createAgentRuntime } from "../runtime.js";
import type {
  AgentRuntimeExecutionOptions,
  AgentRuntimeSkillRoot,
} from "../types.js";
import { resolveIntegrationBridgeLaunch } from "./integration-provider-bridges.js";
import {
  withBridgeLaunch,
  type LaunchBoundAgentRuntime,
} from "./runtime-test-harness.js";
import {
  formatRuntimeErrorEvent,
  waitForRuntimeConditionUnsafe,
  waitForThreadTurnCompleted as waitForSharedThreadTurnCompleted,
  waitForThreadTurnStarted as waitForSharedThreadTurnStarted,
  type RuntimeWaitPredicate,
} from "./runtime-wait-helpers.js";

type ThreadIdentityEvent = Extract<ThreadEvent, { type: "thread/identity" }>;
export type TurnStartedEvent = Extract<ThreadEvent, { type: "turn/started" }>;
type InputAcceptedEvent = Extract<ThreadEvent, { type: "turn/input/accepted" }>;
type ErrorThreadEvent = Extract<
  ThreadEvent,
  { type: "provider/error" | "system/error" }
>;
type WaitPredicate = RuntimeWaitPredicate;

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

export interface ThreadWaitArgs extends RuntimeWaitArgs {
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

type RuntimeOptionsTemplate = Omit<AgentRuntimeExecutionOptions, "model">;

type RuntimeOptionsPreset =
  | "full"
  | "accept-edits-ask"
  | "accept-edits-deny"
  | "auto-ask"
  | "auto-deny";

interface ResolveRuntimeOptionsArgs {
  ctx: TestContext;
  providerId: string;
  preset: RuntimeOptionsPreset;
}

const fullRuntimeOptionsTemplate = {
  serviceTier: "default",
  reasoningLevel: "medium",
  providerOptions: {},
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
} satisfies RuntimeOptionsTemplate;

const workspaceWriteAskRuntimeOptionsTemplate = {
  serviceTier: "default",
  reasoningLevel: "medium",
  providerOptions: {},
  permissionMode: "accept-edits",
  permissionScope: "workspace",
  approvalReviewer: "user",
  permissionEscalation: "ask",
} satisfies RuntimeOptionsTemplate;

const workspaceWriteDenyRuntimeOptionsTemplate = {
  serviceTier: "default",
  reasoningLevel: "medium",
  providerOptions: {},
  permissionMode: "accept-edits",
  permissionScope: "workspace",
  approvalReviewer: "user",
  permissionEscalation: "deny",
} satisfies RuntimeOptionsTemplate;

const readonlyAskRuntimeOptionsTemplate = {
  serviceTier: "default",
  reasoningLevel: "medium",
  providerOptions: {},
  permissionMode: "auto",
  permissionScope: "workspace",
  approvalReviewer: "automatic",
  permissionEscalation: "ask",
} satisfies RuntimeOptionsTemplate;

const readonlyDenyRuntimeOptionsTemplate = {
  serviceTier: "default",
  reasoningLevel: "medium",
  providerOptions: {},
  permissionMode: "auto",
  permissionScope: "workspace",
  approvalReviewer: "automatic",
  permissionEscalation: "deny",
} satisfies RuntimeOptionsTemplate;

const runtimeOptionsTemplates = {
  full: fullRuntimeOptionsTemplate,
  "auto-ask": readonlyAskRuntimeOptionsTemplate,
  "auto-deny": readonlyDenyRuntimeOptionsTemplate,
  "accept-edits-ask": workspaceWriteAskRuntimeOptionsTemplate,
  "accept-edits-deny": workspaceWriteDenyRuntimeOptionsTemplate,
} satisfies Record<RuntimeOptionsPreset, RuntimeOptionsTemplate>;

const INTEGRATION_REASONING_LEVEL = "low" satisfies ReasoningLevel;
const PI_CODING_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const PI_BRIDGE_SESSION_DIR_ENV = "BB_PI_BRIDGE_SESSION_DIR";

function piAgentDir(): string {
  return (
    process.env[PI_CODING_AGENT_DIR_ENV] ?? join(homedir(), ".pi", "agent")
  );
}
const resolvedIntegrationModelPromises = new Map<string, Promise<string>>();

export function turnCompletedCount(events: ThreadEvent[]): number {
  return events.filter((e) => e.type === "turn/completed").length;
}

function turnStartedCount(events: ThreadEvent[]): number {
  return events.filter((e) => e.type === "turn/started").length;
}

function collectTurnIds(events: ThreadEvent[]): Set<string> {
  const turnIds = new Set<string>();
  for (const event of events) {
    const turnId = getThreadEventScopeTurnId(event.scope);
    if (turnId) {
      turnIds.add(turnId);
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

function providerUsesRuntimeTurnIds(providerId: string): boolean {
  return providerId === "claude-code" || providerId === "pi";
}

export function getInputAcceptedEvents(
  events: ThreadEvent[],
): InputAcceptedEvent[] {
  return events.filter(
    (event): event is InputAcceptedEvent =>
      event.type === "turn/input/accepted",
  );
}

export function expectInputAcceptedCount(
  events: ThreadEvent[],
  count: number,
): void {
  expect(getInputAcceptedEvents(events)).toHaveLength(count);
}

export function getEventsForThread(
  events: ThreadEvent[],
  threadId: string,
): ThreadEvent[] {
  return events.filter(
    (event) => "threadId" in event && event.threadId === threadId,
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

export function findInputAcceptedForThread(
  events: ThreadEvent[],
  threadId: string,
  clientRequestId: ClientTurnRequestId,
): InputAcceptedEvent | null {
  const event = getInputAcceptedEvents(
    getEventsForThread(events, threadId),
  ).find(
    (inputAcceptedEvent) =>
      inputAcceptedEvent.clientRequestId === clientRequestId,
  );
  return event ?? null;
}

export function hasInputAcceptedForThread(
  events: ThreadEvent[],
  threadId: string,
  clientRequestId: ClientTurnRequestId,
): boolean {
  return findInputAcceptedForThread(events, threadId, clientRequestId) !== null;
}

export function turnStartedCountForThread(
  events: ThreadEvent[],
  threadId: string,
): number {
  return getEventsForThread(events, threadId).filter(
    (event) => event.type === "turn/started",
  ).length;
}

export function turnCompletedCountForThread(
  events: ThreadEvent[],
  threadId: string,
): number {
  return getEventsForThread(events, threadId).filter(
    (event) => event.type === "turn/completed",
  ).length;
}

export function getAgentTextAfterIndex(
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

export function resolveProviderThreadId(
  args: ResolveProviderThreadIdArgs,
): string {
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
    if (
      e.type === "item/completed" &&
      e.item.type === "agentMessage" &&
      e.item.text
    ) {
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
  const threadEvents = events.filter(
    (event) => "threadId" in event && event.threadId === threadId,
  );
  return getAgentText(threadEvents) || getStreamedText(threadEvents);
}

function describeEventsForFailure(events: ThreadEvent[]): string {
  return events
    .map((event) => {
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
      if (event.type === "provider/error") {
        return `${threadId} ${event.type}:${event.message}${event.detail ? ` ${event.detail}` : ""}`;
      }
      return `${threadId} ${event.type}`;
    })
    .join("\n");
}

function previewText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 240) {
    return normalized;
  }
  return `${normalized.slice(0, 240)}...`;
}

function isErrorEvent(event: ThreadEvent): event is ErrorThreadEvent {
  return event.type === "provider/error" || event.type === "system/error";
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

function formatInteractiveRequest(request: PendingInteractionCreate): string {
  if (isUserQuestionPendingInteractionPayload(request.payload)) {
    const firstQuestion = request.payload.questions[0];
    return `user_question:${previewText(firstQuestion?.prompt ?? "empty")}`;
  }
  if (!isApprovalPendingInteractionPayload(request.payload)) {
    return `${request.payload.kind}:${previewText(request.payload.title)}`;
  }

  const { subject } = request.payload;
  switch (subject.kind) {
    case "command":
      return `command:${previewText(subject.command)}`;
    case "file_change":
      return `file_change:${subject.itemId}`;
    case "permission_grant":
      return `permission_grant:${subject.toolName ?? "unknown"}`;
    case "plan":
      return `plan:${previewText(subject.plan)}`;
    case "tool_use":
      return `tool_use:${subject.tool}`;
  }
}

export function describeRuntimeDiagnostics(
  args: RuntimeDiagnosticsArgs,
): string {
  const events = args.threadId
    ? getEventsForThread(args.ctx.events, args.threadId)
    : args.ctx.events;
  const relevantToolCalls = args.threadId
    ? args.ctx.toolCalls.filter((request) => request.threadId === args.threadId)
    : args.ctx.toolCalls;
  const relevantInteractiveRequests = args.threadId
    ? args.ctx.interactiveRequests.filter(
        (request) => request.threadId === args.threadId,
      )
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
    `latestError=${latestError ? formatRuntimeErrorEvent(latestError) : "none"}`,
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
  return `${formatRuntimeErrorEvent(latestError)}\n${describeRuntimeDiagnostics(args)}`;
}

export function waitForRuntimeCondition(
  args: RuntimeConditionWaitArgs,
): Promise<void> {
  return waitForRuntimeConditionUnsafe(args.predicate, {
    describeFailure: () => describeRuntimeDiagnostics(args),
    failFast: () => failOnRuntimeError(args),
    intervalMs: 100,
    label: args.label,
    timeoutMs: args.timeoutMs ?? 30_000,
  });
}

export function waitForTurnCompletedCount(
  args: TurnCompletedCountWaitArgs,
): Promise<void> {
  return waitForRuntimeCondition({
    ctx: args.ctx,
    label: args.label,
    predicate: () => turnCompletedCount(args.ctx.events) >= args.count,
    timeoutMs: args.timeoutMs,
  });
}

export function waitForThreadTurnCompleted(
  args: ThreadWaitArgs,
): Promise<void> {
  return waitForSharedThreadTurnCompleted({
    describeFailure: () => describeRuntimeDiagnostics(args),
    events: args.ctx.events,
    failFast: () => failOnRuntimeError(args),
    label: args.label,
    runtime: args.ctx.runtime,
    threadId: args.threadId,
    timeoutMs: args.timeoutMs ?? 30_000,
  });
}

export function waitForThreadTurnCompletedCount(
  args: ThreadTurnCompletedCountWaitArgs,
): Promise<void> {
  return waitForRuntimeCondition({
    ctx: args.ctx,
    label: args.label,
    predicate: () =>
      turnCompletedCountForThread(args.ctx.events, args.threadId) >= args.count,
    threadId: args.threadId,
    timeoutMs: args.timeoutMs,
  });
}

export async function waitForThreadTurnStarted(
  args: ThreadWaitArgs,
): Promise<void> {
  await waitForSharedThreadTurnStarted({
    describeFailure: () => describeRuntimeDiagnostics(args),
    events: args.ctx.events,
    failFast: () => failOnRuntimeError(args),
    label: args.label,
    runtime: args.ctx.runtime,
    threadId: args.threadId,
    timeoutMs: args.timeoutMs ?? 30_000,
  });
}

function hasToolCallForThread(
  ctx: TestContext,
  threadId: string,
  toolName: string,
): boolean {
  return ctx.toolCalls.some(
    (request) => request.threadId === threadId && request.tool === toolName,
  );
}

function interactiveRequestCountForThread(
  ctx: TestContext,
  threadId: string,
): number {
  return ctx.interactiveRequests.filter(
    (request) => request.threadId === threadId,
  ).length;
}

export function waitForToolCallBeforeTurnCompletion(
  args: ToolCallWaitArgs,
): Promise<void> {
  return waitForRuntimeConditionUnsafe(
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
      intervalMs: 100,
      label: args.label,
      timeoutMs: args.timeoutMs ?? 30_000,
    },
  );
}

export function waitForInteractiveRequestBeforeTurnCompletion(
  args: InteractiveRequestWaitArgs,
): Promise<void> {
  return waitForRuntimeConditionUnsafe(
    () =>
      interactiveRequestCountForThread(args.ctx, args.threadId) >= args.count,
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
      intervalMs: 100,
      label: args.label,
      timeoutMs: args.timeoutMs ?? 30_000,
    },
  );
}

export function getCompletedCommandOutputs(events: ThreadEvent[]): string {
  const outputs: string[] = [];
  for (const event of events) {
    if (
      event.type === "item/completed" &&
      event.item.type === "commandExecution" &&
      event.item.aggregatedOutput
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
      event.type === "item/completed" &&
      event.item.type === "commandExecution"
    ) {
      commands.push(event.item.command);
    }
  }
  return commands;
}

async function resolveDefaultModel(
  providerId: string,
  ctx: TestContext,
): Promise<string> {
  const cached = resolvedIntegrationModelPromises.get(providerId);
  if (cached) {
    return cached;
  }

  const promise = resolveDefaultModelUncached(providerId, ctx);
  resolvedIntegrationModelPromises.set(providerId, promise);

  try {
    return await promise;
  } catch (error) {
    if (resolvedIntegrationModelPromises.get(providerId) === promise) {
      resolvedIntegrationModelPromises.delete(providerId);
    }
    throw error;
  }
}

async function resolveDefaultModelUncached(
  providerId: string,
  ctx: TestContext,
): Promise<string> {
  const { models } = await ctx.runtime.listModels({ providerId });
  const model = resolvePreferredTestModel({
    models,
    providerId,
  });
  if (!model) {
    throw new Error(`Provider "${providerId}" returned no available models`);
  }
  return model;
}

function resolveIntegrationServiceTier(
  providerId: string,
): RuntimeOptionsTemplate["serviceTier"] {
  return providerId === "codex" ? "fast" : "default";
}

export async function resolveRuntimeOptions(
  args: ResolveRuntimeOptionsArgs,
): Promise<AgentRuntimeExecutionOptions> {
  return {
    ...runtimeOptionsTemplates[args.preset],
    reasoningLevel: INTEGRATION_REASONING_LEVEL,
    serviceTier: resolveIntegrationServiceTier(args.providerId),
    model: await resolveDefaultModel(args.providerId, args.ctx),
  };
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

function expectSemanticApprovalRequest(
  payload: ApprovalPendingInteractionPayload,
): void {
  expect(["command", "file_change", "permission_grant", "plan"]).toContain(
    payload.subject.kind,
  );
  switch (payload.subject.kind) {
    case "command":
      expect(Array.isArray(payload.subject.actions)).toBe(true);
      expect(payload.subject.sessionGrant).not.toBeUndefined();
      break;
    case "file_change":
      expect(payload.subject.writeScope).not.toBeUndefined();
      expect(payload.subject.sessionGrant).not.toBeUndefined();
      break;
    case "permission_grant":
      expect(payload.subject.permissions).toBeDefined();
      break;
    case "plan":
      expect(payload.subject.plan.length).toBeGreaterThan(0);
      break;
    case "tool_use":
      expect(payload.subject.tool.length).toBeGreaterThan(0);
      expect(payload.subject.presentation.label.pending.length).toBeGreaterThan(
        0,
      );
      break;
  }
  expect(payload.availableDecisions.length).toBeGreaterThan(0);
  for (const decision of payload.availableDecisions) {
    expect(["allow_once", "allow_for_session", "deny"]).toContain(decision);
  }
}

function expectSemanticUserQuestionRequest(
  payload: UserQuestionPendingInteractionPayload,
): void {
  expect(payload.questions.length).toBeGreaterThan(0);
  for (const question of payload.questions) {
    expect(question.id.length).toBeGreaterThan(0);
    expect(question.prompt.length).toBeGreaterThan(0);
  }
}

function expectSemanticInteractiveRequest(
  request: PendingInteractionCreate,
): void {
  const { payload } = request;
  switch (payload.kind) {
    case "approval":
      expectSemanticApprovalRequest(payload);
      return;
    case "user_question":
      expectSemanticUserQuestionRequest(payload);
      return;
    default:
      expect(payload.title.length).toBeGreaterThan(0);
      return;
  }
}

interface TestContext {
  runtime: LaunchBoundAgentRuntime;
  events: ThreadEvent[];
  toolCalls: ToolCallRequest[];
  interactiveRequests: PendingInteractionCreate[];
  tmpDir: string;
  ownsTmpDir: boolean;
}

type TestToolCallHandler = (req: ToolCallRequest) => Promise<ToolCallResponse>;

type TestInteractiveRequestHandler = (
  req: PendingInteractionCreate,
) => Promise<PendingInteractionResolution>;

interface CreateTestRuntimeOptions {
  onInteractiveRequest?: TestInteractiveRequestHandler;
  onToolCall?: TestToolCallHandler;
  skillRoots?: readonly AgentRuntimeSkillRoot[];
  workspacePath?: string;
}

interface CreateRuntimeProcessEnvArgs {
  providerId: string;
  tmpDir: string;
}

interface CopyPiAgentFileIfPresentArgs {
  fileName: string;
  sourceAgentDir: string;
  targetAgentDir: string;
}

interface PreparePiAgentDirArgs {
  tmpDir: string;
}

function copyPiAgentFileIfPresent(args: CopyPiAgentFileIfPresentArgs): void {
  const sourcePath = join(args.sourceAgentDir, args.fileName);
  if (!existsSync(sourcePath)) {
    return;
  }

  copyFileSync(sourcePath, join(args.targetAgentDir, args.fileName));
}

function preparePiAgentDir(args: PreparePiAgentDirArgs): string {
  const targetAgentDir = join(args.tmpDir, ".bb-pi-agent");
  mkdirSync(targetAgentDir, { recursive: true });

  const sourceAgentDir = piAgentDir();
  for (const fileName of ["auth.json", "models.json"]) {
    copyPiAgentFileIfPresent({
      fileName,
      sourceAgentDir,
      targetAgentDir,
    });
  }

  return targetAgentDir;
}

function createRuntimeProcessEnv(
  args: CreateRuntimeProcessEnvArgs,
): Record<string, string> | undefined {
  if (args.providerId !== "pi") {
    return undefined;
  }

  const sessionDir = join(args.tmpDir, ".bb-pi-bridge-sessions");
  mkdirSync(sessionDir, { recursive: true });
  return {
    [PI_BRIDGE_SESSION_DIR_ENV]: sessionDir,
    [PI_CODING_AGENT_DIR_ENV]: preparePiAgentDir({ tmpDir: args.tmpDir }),
  };
}

export function createTestRuntime(
  providerId: string,
  opts?: CreateTestRuntimeOptions,
): TestContext {
  const tmpDir =
    opts?.workspacePath ??
    mkdtempSync(join(tmpdir(), `bb-integ-${providerId}-`));
  const ownsTmpDir = !opts?.workspacePath;
  const events: ThreadEvent[] = [];
  const toolCalls: ToolCallRequest[] = [];
  const interactiveRequests: PendingInteractionCreate[] = [];

  const defaultToolHandler = async (): Promise<ToolCallResponse> => ({
    contentItems: [{ type: "inputText" as const, text: "ok" }],
    success: true,
  });

  const runtime = createAgentRuntime({
    env: createRuntimeProcessEnv({ providerId, tmpDir }),
    skillRoots: opts?.skillRoots,
    workspacePath: tmpDir,
    onEvent: (e) => events.push(e),
    onToolCall: async (req) => {
      toolCalls.push(req);
      if (opts?.onToolCall) return opts.onToolCall(req);
      return defaultToolHandler();
    },
    onInteractiveRequest: async (req) => {
      expectSemanticInteractiveRequest(req);
      interactiveRequests.push(req);
      if (opts?.onInteractiveRequest) {
        return opts.onInteractiveRequest(req);
      }
      throw new Error(
        `Unexpected interactive request: ${formatInteractiveRequest(req)}`,
      );
    },
    onStderr: () => {},
  });

  return {
    runtime: withBridgeLaunch(
      runtime,
      resolveIntegrationBridgeLaunch(providerId),
    ),
    events,
    toolCalls,
    interactiveRequests,
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
  const { payload } = request;
  switch (payload.kind) {
    case "approval":
      return {
        decision: payload.availableDecisions.includes("allow_for_session")
          ? "allow_for_session"
          : "allow_once",
        grantedPermissions:
          payload.subject.kind === "permission_grant"
            ? payload.subject.permissions
            : payload.subject.kind === "command" ||
                payload.subject.kind === "file_change"
              ? payload.subject.sessionGrant
              : null,
      };
    case "user_question":
      return {
        kind: "user_answer",
        answers: Object.fromEntries(
          payload.questions.map((question) => {
            const first = question.options?.[0];
            return [
              question.id,
              first === undefined
                ? { selected: [], freeText: "ok" }
                : { selected: [first.value] },
            ];
          }),
        ),
      };
    default:
      return { kind: "request_answer", value: { answered: true } };
  }
}

function isWriteApprovalRequest(request: PendingInteractionCreate): boolean {
  return (
    isApprovalPendingInteractionPayload(request.payload) &&
    (request.payload.subject.kind === "command" ||
      request.payload.subject.kind === "file_change") &&
    request.payload.availableDecisions.includes("allow_once")
  );
}

export function expectWriteApprovalRequest(
  requests: PendingInteractionCreate[],
): void {
  expect(
    requests.some(isWriteApprovalRequest),
    `Expected a command or file-change approval with allow_once; got ${JSON.stringify(
      requests.map((request) => request.payload),
    )}`,
  ).toBe(true);
}

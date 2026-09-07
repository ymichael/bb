import type { ThreadEvent } from "@bb/domain";
import { getThreadEventScopeTurnId } from "@bb/domain";
import type { AgentRuntime } from "../types.js";

export type RuntimeWaitPredicate = () => boolean;
type RuntimeWaitFailureDescription = () => string | null | undefined;
type RuntimeWaitConditionConfig = number | RuntimeWaitConditionOptions;
type RuntimeThreadEventPredicate = (event: ThreadEvent) => boolean;
type RuntimeErrorEvent = Extract<
  ThreadEvent,
  { type: "provider/error" | "system/error" }
>;

interface RuntimeWaitConditionOptions {
  describeFailure?: RuntimeWaitFailureDescription;
  failFast?: RuntimeWaitFailureDescription;
  intervalMs?: number;
  label?: string;
  timeoutMs?: number;
}

interface RuntimeFailureContext {
  describeFailure?: RuntimeWaitFailureDescription;
  events?: ThreadEvent[];
  failFast?: RuntimeWaitFailureDescription;
  providerId?: string;
  runtime?: AgentRuntime;
  threadId?: string;
}

interface RuntimeStateWaitArgs extends RuntimeFailureContext {
  label: string;
  predicate: RuntimeWaitPredicate;
  timeoutMs?: number;
}

interface RuntimeThreadEventWaitArgs extends RuntimeFailureContext {
  events: ThreadEvent[];
  label: string;
  predicate: RuntimeThreadEventPredicate;
  timeoutMs?: number;
}

interface RuntimeThreadTurnStartedWaitArgs extends RuntimeFailureContext {
  events: ThreadEvent[];
  label?: string;
  threadId: string;
  timeoutMs?: number;
  turnId?: string;
}

interface RuntimeThreadTurnCompletedWaitArgs extends RuntimeFailureContext {
  events: ThreadEvent[];
  label?: string;
  threadId: string;
  timeoutMs?: number;
  turnId?: string;
}

interface RuntimeThreadAgentMessageWaitArgs extends RuntimeFailureContext {
  events: ThreadEvent[];
  label?: string;
  text: string;
  threadId: string;
  timeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeWaitConditionConfig(
  config: RuntimeWaitConditionConfig | undefined,
): RuntimeWaitConditionOptions {
  if (typeof config === "number") {
    return { timeoutMs: config };
  }
  return config ?? {};
}

function isRuntimeErrorEvent(event: ThreadEvent): event is RuntimeErrorEvent {
  return event.type === "provider/error" || event.type === "system/error";
}

export function formatRuntimeErrorEvent(event: RuntimeErrorEvent): string {
  const detail = event.detail ? ` detail=${event.detail}` : "";
  return `${event.type}: ${event.message}${detail}`;
}

function findLatestRuntimeErrorEvent(
  events: ThreadEvent[] | undefined,
  threadId: string | undefined,
): RuntimeErrorEvent | null {
  if (!events) {
    return null;
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event &&
      isRuntimeErrorEvent(event) &&
      (!threadId || event.threadId === threadId)
    ) {
      return event;
    }
  }
  return null;
}

function formatRuntimeEvent(event: ThreadEvent): string {
  const providerThreadId =
    "providerThreadId" in event
      ? ` providerThreadId=${event.providerThreadId}`
      : "";
  const eventTurnId = getThreadEventScopeTurnId(event.scope);
  const turnId = eventTurnId ? ` turnId=${eventTurnId}` : "";
  return `${event.threadId} ${event.type}${providerThreadId}${turnId}`;
}

function describeRuntimeFailure(args: RuntimeFailureContext): string | null {
  const lines: string[] = [];
  const customFailure = args.describeFailure?.();
  if (customFailure) {
    lines.push(customFailure);
  }
  if (args.runtime) {
    lines.push(
      `runningProviders=[${args.runtime.listRunningProviders().join(",")}]`,
    );
  }
  if (args.events) {
    const scopedEvents = args.threadId
      ? args.events.filter((event) => event.threadId === args.threadId)
      : args.events;
    const recentEvents = scopedEvents.slice(-8).map(formatRuntimeEvent);
    lines.push(`recentEvents:\n${recentEvents.join("\n") || "none"}`);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

function failFastRuntimeFailure(args: RuntimeFailureContext): string | null {
  const customFailure = args.failFast?.();
  if (customFailure) {
    return customFailure;
  }
  const latestError = findLatestRuntimeErrorEvent(args.events, args.threadId);
  if (latestError) {
    return formatRuntimeErrorEvent(latestError);
  }
  if (
    args.runtime &&
    args.providerId &&
    !args.runtime.listRunningProviders().includes(args.providerId)
  ) {
    return `Provider "${args.providerId}" is no longer running`;
  }
  return null;
}

export async function waitForRuntimeConditionUnsafe(
  condition: RuntimeWaitPredicate,
  config?: RuntimeWaitConditionConfig,
): Promise<void> {
  const options = normalizeWaitConditionConfig(config);
  const timeoutMs = options.timeoutMs ?? 1_000;
  const intervalMs = options.intervalMs ?? 10;
  const label = options.label ?? "condition";
  const deadline = Date.now() + timeoutMs;

  while (true) {
    if (condition()) {
      return;
    }
    if (Date.now() >= deadline) {
      break;
    }
    const failFastMessage = options.failFast?.();
    if (failFastMessage) {
      throw new Error(failFastMessage);
    }
    await sleep(intervalMs);
  }

  const failureDetail = options.describeFailure?.();
  const detail = failureDetail ? `\n${failureDetail}` : "";
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${label}${detail}`,
  );
}

export async function waitForRuntimeState(
  args: RuntimeStateWaitArgs,
): Promise<void> {
  await waitForRuntimeConditionUnsafe(args.predicate, {
    describeFailure: () => describeRuntimeFailure(args),
    failFast: () => failFastRuntimeFailure(args),
    label: args.label,
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
  });
}

export async function waitForRuntimeThreadEvent(
  args: RuntimeThreadEventWaitArgs,
): Promise<void> {
  await waitForRuntimeState({
    ...args,
    predicate: () => args.events.some(args.predicate),
  });
}

export async function waitForThreadTurnStarted(
  args: RuntimeThreadTurnStartedWaitArgs,
): Promise<{ event: ThreadEvent; turnId: string }> {
  const predicate = (event: ThreadEvent): boolean =>
    event.type === "turn/started" &&
    event.threadId === args.threadId &&
    (!args.turnId || getThreadEventScopeTurnId(event.scope) === args.turnId);
  await waitForRuntimeThreadEvent({
    ...args,
    label: args.label ?? `turn/started for ${args.threadId}`,
    predicate,
  });
  const event = args.events.find(predicate);
  const turnId = event ? getThreadEventScopeTurnId(event.scope) : undefined;
  if (!event || turnId === undefined) {
    throw new Error(
      `turn/started for ${args.threadId} vanished after it was observed`,
    );
  }
  return { event, turnId };
}

export async function waitForThreadTurnCompleted(
  args: RuntimeThreadTurnCompletedWaitArgs,
): Promise<void> {
  await waitForRuntimeThreadEvent({
    ...args,
    label: args.label ?? `turn/completed for ${args.threadId}`,
    predicate: (event) =>
      event.type === "turn/completed" &&
      event.threadId === args.threadId &&
      (!args.turnId || getThreadEventScopeTurnId(event.scope) === args.turnId),
  });
}

export async function waitForThreadAgentMessageText(
  args: RuntimeThreadAgentMessageWaitArgs,
): Promise<void> {
  await waitForRuntimeThreadEvent({
    ...args,
    label: args.label ?? `agent message for ${args.threadId}`,
    predicate: (event) =>
      event.type === "item/completed" &&
      event.threadId === args.threadId &&
      event.item.type === "agentMessage" &&
      event.item.text.includes(args.text),
  });
}

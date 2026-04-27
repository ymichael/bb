// Shared real-provider end-to-end test helpers.
import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { expect } from "vitest";
import {
  requireThreadEventScopeTurnId,
  type ThreadEventRow,
  type ThreadExecutionOptions,
} from "@bb/domain";
import type { ThreadTimelineResponse } from "@bb/server-contract";
import { resolvePreferredTestModel } from "@bb/test-helpers";
import {
  getAvailableModels,
  getThread,
  getThreadEvents,
  getThreadOutput,
  getThreadTimeline,
  sendTextMessage,
} from "../helpers/api.js";
import {
  createProjectFixture,
  createReadyHostThread,
} from "../helpers/fixtures.js";
import {
  createIntegrationHarness,
  loadProjectEnvFile,
} from "../helpers/harness.js";
import {
  describeThreadEvent,
  previewThreadText,
} from "../helpers/thread-diagnostics.js";
import { scaleTimeoutMs } from "../helpers/time.js";

export type RealProviderId = "codex" | "claude-code" | "pi";

export const REAL_PROVIDER_IDS: ReadonlyArray<RealProviderId> = [
  "codex",
  "claude-code",
  "pi",
];
const REAL_PROVIDER_BOOTSTRAP_TEXT =
  "Reply with exactly READY and nothing else.";

type RealProviderExecutionOptions = Pick<
  ThreadExecutionOptions,
  "model" | "reasoningLevel" | "serviceTier"
>;
type RealProviderExecutionTemplate = Omit<
  RealProviderExecutionOptions,
  "model"
>;

export type ProviderSmokeHarness = Awaited<
  ReturnType<typeof createIntegrationHarness>
>;

interface WaitForThreadEventArgs {
  baselineSequence: number;
  harness: ProviderSmokeHarness;
  threadId: string;
}

export interface WaitForTurnStartedResult {
  sequence: number;
  turnId: string;
}

export interface WaitForInputAcceptedResult {
  clientRequestSequence: number;
  sequence: number;
  turnId: string;
}

interface SendLongRunningTurnArgs {
  harness: ProviderSmokeHarness;
  providerId: RealProviderId;
  threadId: string;
}

interface ManagedRealThreadWorkspace {
  type: "managed-worktree";
}

interface UnmanagedRealThreadWorkspace {
  path: string | null;
  type: "unmanaged";
}

type RealThreadWorkspace =
  | ManagedRealThreadWorkspace
  | UnmanagedRealThreadWorkspace;

interface CreateRealThreadArgs {
  providerId: RealProviderId;
  workspace: RealThreadWorkspace;
}

interface SendAndWaitForIdleArgs {
  harness: ProviderSmokeHarness;
  providerId: RealProviderId;
  text: string;
  threadId: string;
}

interface ResolveExecutionOptionsArgs {
  harness: ProviderSmokeHarness;
  providerId: RealProviderId;
}

// Active-turn waits: enough time to confirm the provider has started a long-running turn.
export const ACTIVE_TIMEOUT_MS = scaleTimeoutMs(15_000);
export const REAL_POLL_INTERVAL_MS = 200;
// Whole-turn waits: real providers can take much longer than the fake adapter to respond.
export const TURN_TIMEOUT_MS = scaleTimeoutMs(60_000);
// Stop waits: give the daemon time to interrupt an in-flight real-provider turn cleanly.
export const STOP_TIMEOUT_MS = scaleTimeoutMs(30_000);
// Per-test budget: end-to-end provider checks include real network and provider startup latency.
export const TEST_TIMEOUT_MS = scaleTimeoutMs(120_000);

// Concurrent real-provider harnesses each install daemon shutdown handlers.
process.setMaxListeners(Math.max(process.getMaxListeners(), 64));

const providerPrerequisitePromises = new Map<RealProviderId, Promise<void>>();
const resolvedExecutionOptionsPromises = new Map<
  string,
  Promise<RealProviderExecutionOptions>
>();

const FAST_EXECUTION_BY_PROVIDER: Record<
  RealProviderId,
  RealProviderExecutionTemplate
> = {
  codex: {
    reasoningLevel: "low",
    serviceTier: "fast",
  },
  "claude-code": {
    reasoningLevel: "low",
  },
  pi: {
    reasoningLevel: "low",
  },
};

export function countTurnEvents(
  events: ThreadEventRow[],
  type: "turn/completed" | "turn/started",
): number {
  return events.filter((event) => event.type === type).length;
}

function findLatestClientTurnRequestSequenceAfter(
  events: ThreadEventRow[],
  sequence: number,
): number | null {
  const request = [...events]
    .reverse()
    .find(
      (event) =>
        event.seq > sequence &&
        (event.type === "client/thread/start" ||
          event.type === "client/turn/requested" ||
          event.type === "client/turn/start"),
    );
  return request?.seq ?? null;
}

function hasCompletedAgentMessageAfter(
  events: ThreadEventRow[],
  sequence: number,
): boolean {
  return events.some(
    (event) =>
      event.seq > sequence &&
      event.type === "item/completed" &&
      event.data.item.type === "agentMessage" &&
      event.data.item.text.trim().length > 0,
  );
}

function findTurnStartedAfter(
  events: ThreadEventRow[],
  sequence: number,
): WaitForTurnStartedResult | null {
  for (const event of events) {
    if (event.seq > sequence && event.type === "turn/started") {
      return {
        sequence: event.seq,
        turnId: requireThreadEventScopeTurnId(event),
      };
    }
  }
  return null;
}

function findInputAcceptedAfter(
  events: ThreadEventRow[],
  sequence: number,
): WaitForInputAcceptedResult | null {
  const requestSequence = findLatestClientTurnRequestSequenceAfter(
    events,
    sequence,
  );
  if (requestSequence === null) {
    return null;
  }

  for (const event of events) {
    if (
      event.seq > requestSequence &&
      event.type === "turn/input/accepted" &&
      event.data.clientRequestSequence === requestSequence
    ) {
      return {
        clientRequestSequence: requestSequence,
        sequence: event.seq,
        turnId: requireThreadEventScopeTurnId(event),
      };
    }
  }

  return null;
}

function findErrorAfter(
  events: ThreadEventRow[],
  sequence: number,
): ThreadEventRow | null {
  return (
    events.find(
      (event) =>
        event.seq > sequence &&
        (event.type === "provider/error" || event.type === "system/error"),
    ) ?? null
  );
}

function hasTurnCompletedAfter(
  events: ThreadEventRow[],
  sequence: number,
): boolean {
  return events.some(
    (event) => event.seq > sequence && event.type === "turn/completed",
  );
}

async function buildThreadDiagnostics(
  args: WaitForThreadEventArgs,
): Promise<string> {
  const [thread, events, output] = await Promise.all([
    getThread(args.harness.api, args.threadId),
    getThreadEvents(args.harness.api, args.threadId),
    getThreadOutput(args.harness.api, args.threadId).catch(() => null),
  ]);
  const recentEvents = events.slice(-12).map(describeThreadEvent).join(" | ");
  const lastError = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === "provider/error" || event.type === "system/error",
    );
  const lastTurnStarted = [...events]
    .reverse()
    .find((event) => event.type === "turn/started");
  const lastTurnCompleted = [...events]
    .reverse()
    .find((event) => event.type === "turn/completed");
  return `status=${thread.status}; events=${events.length}; recentEvents=[${recentEvents || "none"}]; lastError=${JSON.stringify(lastError?.data ?? null)}; lastTurnStarted=${JSON.stringify(lastTurnStarted?.data ?? null)}; lastTurnCompleted=${JSON.stringify(lastTurnCompleted?.data ?? null)}; outputPreview=${JSON.stringify(previewThreadText(output))}`;
}

async function waitForTurnStartedAfter(
  args: WaitForThreadEventArgs,
): Promise<WaitForTurnStartedResult> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= ACTIVE_TIMEOUT_MS) {
    const [thread, events] = await Promise.all([
      getThread(args.harness.api, args.threadId),
      getThreadEvents(args.harness.api, args.threadId),
    ]);
    const turnStarted = findTurnStartedAfter(events, args.baselineSequence);
    if (turnStarted) {
      return turnStarted;
    }
    const errorEvent = findErrorAfter(events, args.baselineSequence);
    if (thread.status === "error" || errorEvent) {
      throw new Error(
        `Thread failed before turn/started. Diagnostics: ${await buildThreadDiagnostics(args)}`,
      );
    }
    if (hasTurnCompletedAfter(events, args.baselineSequence)) {
      throw new Error(
        `Turn completed before turn/started was observed. Diagnostics: ${await buildThreadDiagnostics(args)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, REAL_POLL_INTERVAL_MS));
  }
  throw new Error(
    `Timed out waiting for turn/started. Diagnostics: ${await buildThreadDiagnostics(args)}`,
  );
}

export async function waitForInputAcceptedAfter(
  args: WaitForThreadEventArgs,
): Promise<WaitForInputAcceptedResult> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= ACTIVE_TIMEOUT_MS) {
    const [thread, events] = await Promise.all([
      getThread(args.harness.api, args.threadId),
      getThreadEvents(args.harness.api, args.threadId),
    ]);
    const inputAccepted = findInputAcceptedAfter(events, args.baselineSequence);
    if (inputAccepted) {
      return inputAccepted;
    }
    const errorEvent = findErrorAfter(events, args.baselineSequence);
    if (thread.status === "error" || errorEvent) {
      throw new Error(
        `Thread failed before turn/input/accepted. Diagnostics: ${await buildThreadDiagnostics(args)}`,
      );
    }
    if (hasTurnCompletedAfter(events, args.baselineSequence)) {
      throw new Error(
        `Turn completed before turn/input/accepted. Diagnostics: ${await buildThreadDiagnostics(args)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, REAL_POLL_INTERVAL_MS));
  }
  throw new Error(
    `Timed out waiting for turn/input/accepted. Diagnostics: ${await buildThreadDiagnostics(args)}`,
  );
}

export async function sendLongRunningTurnAndWaitStarted(
  args: SendLongRunningTurnArgs,
): Promise<WaitForTurnStartedResult> {
  const baselineEvents = await getThreadEvents(args.harness.api, args.threadId);
  const baselineSequence = Math.max(
    0,
    ...baselineEvents.map((event) => event.seq),
  );
  await sendTextMessage(args.harness.api, args.threadId, {
    execution: await resolveExecutionOptions({
      harness: args.harness,
      providerId: args.providerId,
    }),
    text: "Write a detailed 20 section essay about the history of computing with four sentences per section.",
  });
  return waitForTurnStartedAfter({
    baselineSequence,
    harness: args.harness,
    threadId: args.threadId,
  });
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function assertProviderPrerequisites(
  providerId: RealProviderId,
): Promise<void> {
  const cached = providerPrerequisitePromises.get(providerId);
  if (cached) {
    return cached;
  }

  const promise = assertProviderPrerequisitesUncached(providerId);
  providerPrerequisitePromises.set(providerId, promise);

  try {
    return await promise;
  } catch (error) {
    if (providerPrerequisitePromises.get(providerId) === promise) {
      providerPrerequisitePromises.delete(providerId);
    }
    throw error;
  }
}

export async function resolveExecutionOptions(
  args: ResolveExecutionOptionsArgs,
): Promise<RealProviderExecutionOptions> {
  const cacheKey = `${args.harness.hostId}:${args.providerId}`;
  const cached = resolvedExecutionOptionsPromises.get(cacheKey);
  if (cached) {
    return cached;
  }

  const promise = resolveExecutionOptionsUncached(args);
  resolvedExecutionOptionsPromises.set(cacheKey, promise);

  try {
    return await promise;
  } catch (error) {
    if (resolvedExecutionOptionsPromises.get(cacheKey) === promise) {
      resolvedExecutionOptionsPromises.delete(cacheKey);
    }
    throw error;
  }
}

async function resolveExecutionOptionsUncached(
  args: ResolveExecutionOptionsArgs,
): Promise<RealProviderExecutionOptions> {
  const models = await getAvailableModels(args.harness.api, {
    hostId: args.harness.hostId,
    providerId: args.providerId,
  });
  const model = resolvePreferredTestModel({
    models,
    providerId: args.providerId,
  });
  if (!model) {
    throw new Error(
      `Provider "${args.providerId}" returned no available models for host ${args.harness.hostId}`,
    );
  }
  return {
    ...FAST_EXECUTION_BY_PROVIDER[args.providerId],
    model,
  };
}

async function assertProviderPrerequisitesUncached(
  providerId: RealProviderId,
): Promise<void> {
  await loadProjectEnvFile();
  await assertCliInstalled(
    providerId === "claude-code" ? "claude" : providerId,
  );
}

const execFile = promisify(execFileCb);

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function assertCliInstalled(command: string): Promise<void> {
  try {
    await execFile(command, ["--help"]);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      throw new Error(`${command} CLI is not installed or not on PATH`);
    }
    // --help returned non-zero but the binary exists - that's fine.
  }
}

export function expectNonEmptyOutput(
  output: string | null,
  context: string,
): void {
  expect(output?.trim().length ?? 0, context).toBeGreaterThan(0);
}

export function hasAssistantTimelineMessage(
  timeline: ThreadTimelineResponse,
): boolean {
  return timeline.rows.some(
    (row) =>
      row.kind === "message" &&
      (row.message.kind === "assistant-text" ||
        row.message.kind === "assistant-reasoning"),
  );
}

export async function createRealThread(args: CreateRealThreadArgs) {
  await assertProviderPrerequisites(args.providerId);
  const harness = await createIntegrationHarness({ adapterFactory: undefined });
  const project = await createProjectFixture(harness, {
    name: `Real Provider ${args.providerId}`,
  });
  const readyThread = await createReadyHostThread(harness, {
    execution: await resolveExecutionOptions({
      harness,
      providerId: args.providerId,
    }),
    input: [{ type: "text", text: REAL_PROVIDER_BOOTSTRAP_TEXT }],
    projectId: project.id,
    providerId: args.providerId,
    timeoutMs: TURN_TIMEOUT_MS,
    workspace: args.workspace,
  });

  return {
    harness,
    ...readyThread,
  };
}

export async function sendAndWaitForIdle(args: SendAndWaitForIdleArgs) {
  const baselineEvents = await getThreadEvents(args.harness.api, args.threadId);
  const baselineSequence = Math.max(
    0,
    ...baselineEvents.map((event) => event.seq),
  );
  await sendTextMessage(args.harness.api, args.threadId, {
    execution: await resolveExecutionOptions({
      harness: args.harness,
      providerId: args.providerId,
    }),
    text: args.text,
  });
  try {
    const requestSequence = findLatestClientTurnRequestSequenceAfter(
      await getThreadEvents(args.harness.api, args.threadId),
      baselineSequence,
    );
    if (requestSequence === null) {
      throw new Error(
        `Thread ${args.threadId} did not record a client turn request`,
      );
    }

    const startedAt = Date.now();
    let reachedIdle = false;
    while (Date.now() - startedAt <= TURN_TIMEOUT_MS) {
      const [thread, events] = await Promise.all([
        getThread(args.harness.api, args.threadId),
        getThreadEvents(args.harness.api, args.threadId),
      ]);
      if (thread.status === "idle") {
        if (hasCompletedAgentMessageAfter(events, requestSequence)) {
          reachedIdle = true;
          break;
        }
        if (hasTurnCompletedAfter(events, requestSequence)) {
          throw new Error(
            `Thread ${args.threadId} returned to idle without a completed agent message`,
          );
        }
      }
      if (thread.status === "error") {
        throw new Error(
          `Thread ${args.threadId} entered error before reaching idle`,
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, REAL_POLL_INTERVAL_MS),
      );
    }
    if (!reachedIdle) {
      throw new Error(
        `Timed out waiting for thread ${args.threadId} to return to idle`,
      );
    }
  } catch (error) {
    const [thread, events, output, timeline] = await Promise.all([
      getThread(args.harness.api, args.threadId),
      getThreadEvents(args.harness.api, args.threadId),
      getThreadOutput(args.harness.api, args.threadId),
      getThreadTimeline(args.harness.api, args.threadId).catch(() => null),
    ]);
    const recentEvents = events.slice(-10).map(describeThreadEvent).join(" | ");
    const timelineKinds = timeline
      ? timeline.rows
          .map((row) => (row.kind === "message" ? row.message.kind : row.kind))
          .join(", ")
      : "unavailable";
    const outputPreview = output?.trim().slice(0, 160) ?? "";
    const lastError = [...events]
      .reverse()
      .find(
        (event) =>
          event.type === "provider/error" || event.type === "system/error",
      );
    const lastTurnCompleted = [...events]
      .reverse()
      .find((event) => event.type === "turn/completed");
    const message = error instanceof Error ? error.message : String(error);

    throw new Error(
      `${message}. Diagnostics: status=${thread.status}; events=${events.length}; recentEvents=[${recentEvents || "none"}]; timelineKinds=[${timelineKinds || "none"}]; lastError=${JSON.stringify(lastError?.data ?? null)}; lastTurnCompleted=${JSON.stringify(lastTurnCompleted?.data ?? null)}; outputPreview=${JSON.stringify(outputPreview)}`,
    );
  }

  const events = await getThreadEvents(args.harness.api, args.threadId);
  const output = await getThreadOutput(args.harness.api, args.threadId);

  return { events, output };
}

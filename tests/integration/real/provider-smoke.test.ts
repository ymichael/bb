// Real provider end-to-end coverage
import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type {
  ThreadEventRow,
  ThreadExecutionOptions,
} from "@bb/domain";
import type { ThreadTimelineResponse } from "@bb/server-contract";
import {
  getEnvironment,
  getEnvironmentBranches,
  getEnvironmentDiff,
  getEnvironmentStatus,
  getThread,
  getThreadEvents,
  getThreadOutput,
  getThreadTimeline,
  sendTextMessage,
  stopThread,
} from "../helpers/api.js";
import { waitForThreadStatus } from "../helpers/assertions.js";
import {
  createProjectFixture,
  createReadyHostThread,
} from "../helpers/fixtures.js";
import {
  createIntegrationHarness,
  loadProjectEnvFile,
} from "../helpers/harness.js";
import { scaleTimeoutMs } from "../helpers/time.js";

const REAL_PROVIDER_IDS = ["codex", "claude-code", "pi"] as const;
type RealProviderId = (typeof REAL_PROVIDER_IDS)[number];
type RealProviderExecutionOptions = Pick<
  ThreadExecutionOptions,
  "model" | "reasoningLevel" | "serviceTier"
>;
type ProviderSmokeHarness = Awaited<ReturnType<typeof createIntegrationHarness>>;

interface WaitForThreadEventArgs {
  baselineSequence: number;
  harness: ProviderSmokeHarness;
  threadId: string;
}

interface WaitForUserMessageAckTextArgs extends WaitForThreadEventArgs {
  text: string;
}

interface WaitForTurnStartedResult {
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

interface SendAndWaitForIdleArgs {
  harness: ProviderSmokeHarness;
  providerId: RealProviderId;
  text: string;
  threadId: string;
}

// Active-turn waits: enough time to confirm the provider has started a long-running turn.
const ACTIVE_TIMEOUT_MS = scaleTimeoutMs(15_000);
const REAL_POLL_INTERVAL_MS = 200;
// Whole-turn waits: real providers can take much longer than the fake adapter to respond.
const TURN_TIMEOUT_MS = scaleTimeoutMs(60_000);
// Stop waits: give the daemon time to interrupt an in-flight real-provider turn cleanly.
const STOP_TIMEOUT_MS = scaleTimeoutMs(30_000);
// Per-test budget: end-to-end provider checks include real network and provider startup latency.
const TEST_TIMEOUT_MS = scaleTimeoutMs(120_000);
// Concurrent real-provider harnesses each install daemon shutdown handlers.
process.setMaxListeners(Math.max(process.getMaxListeners(), 64));

const FAST_EXECUTION_BY_PROVIDER: Record<
  RealProviderId,
  RealProviderExecutionOptions
> = {
  codex: {
    model: "gpt-5.4",
    reasoningLevel: "low",
    serviceTier: "fast",
  },
  "claude-code": {
    model: "claude-haiku-4-5",
    reasoningLevel: "low",
  },
  pi: {
    model: "openai/codex-mini",
    reasoningLevel: "low",
  },
};

function countTurnEvents(
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
        (
          event.type === "client/thread/start" ||
          event.type === "client/turn/requested" ||
          event.type === "client/turn/start"
        ),
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

function hasUserMessageAckTextAfter(
  events: ThreadEventRow[],
  sequence: number,
  text: string,
): boolean {
  return events.some((event) =>
    event.seq > sequence &&
    event.type === "item/completed" &&
    event.data.item.type === "userMessage" &&
    event.data.item.content.some((content) =>
      content.type === "text" && content.text.includes(text),
    ),
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
        turnId: event.data.turnId,
      };
    }
  }
  return null;
}

function findErrorAfter(
  events: ThreadEventRow[],
  sequence: number,
): ThreadEventRow | null {
  return events.find((event) =>
    event.seq > sequence &&
    (event.type === "error" || event.type === "system/error")
  ) ?? null;
}

function hasTurnCompletedAfter(
  events: ThreadEventRow[],
  sequence: number,
): boolean {
  return events.some((event) =>
    event.seq > sequence && event.type === "turn/completed"
  );
}

function previewText(value: string | null): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= 240) {
    return normalized;
  }
  return `${normalized.slice(0, 240)}...`;
}

function describeThreadEvent(event: ThreadEventRow): string {
  if (event.type === "item/completed") {
    const item = event.data.item;
    if (item.type === "toolCall") {
      const error = item.error ? ` error=${item.error}` : "";
      return `${event.seq}:${event.type}:${item.type}:${item.tool}:${item.status}${error}`;
    }
    if (item.type === "commandExecution") {
      return `${event.seq}:${event.type}:${item.type}:${item.status}:${item.approvalStatus}`;
    }
    if (item.type === "fileChange") {
      return `${event.seq}:${event.type}:${item.type}:${item.status}:${item.approvalStatus}`;
    }
    return `${event.seq}:${event.type}:${item.type}`;
  }
  if (event.type === "item/started") {
    return `${event.seq}:${event.type}:${event.data.item.type}`;
  }
  if (event.type === "error" || event.type === "system/error") {
    const detail = event.data.detail ? ` ${event.data.detail}` : "";
    return `${event.seq}:${event.type}:${event.data.message}${detail}`;
  }
  return `${event.seq}:${event.type}`;
}

async function buildThreadDiagnostics(
  args: WaitForThreadEventArgs,
): Promise<string> {
  const [thread, events, output] = await Promise.all([
    getThread(args.harness.api, args.threadId),
    getThreadEvents(args.harness.api, args.threadId),
    getThreadOutput(args.harness.api, args.threadId).catch(() => null),
  ]);
  const recentEvents = events
    .slice(-12)
    .map(describeThreadEvent)
    .join(" | ");
  const lastError = [...events]
    .reverse()
    .find((event) => event.type === "error" || event.type === "system/error");
  const lastTurnStarted = [...events]
    .reverse()
    .find((event) => event.type === "turn/started");
  const lastTurnCompleted = [...events]
    .reverse()
    .find((event) => event.type === "turn/completed");
  return `status=${thread.status}; events=${events.length}; recentEvents=[${recentEvents || "none"}]; lastError=${JSON.stringify(lastError?.data ?? null)}; lastTurnStarted=${JSON.stringify(lastTurnStarted?.data ?? null)}; lastTurnCompleted=${JSON.stringify(lastTurnCompleted?.data ?? null)}; outputPreview=${JSON.stringify(previewText(output))}`;
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

async function waitForUserMessageAckTextAfter(
  args: WaitForUserMessageAckTextArgs,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= ACTIVE_TIMEOUT_MS) {
    const [thread, events] = await Promise.all([
      getThread(args.harness.api, args.threadId),
      getThreadEvents(args.harness.api, args.threadId),
    ]);
    if (hasUserMessageAckTextAfter(events, args.baselineSequence, args.text)) {
      return;
    }
    const errorEvent = findErrorAfter(events, args.baselineSequence);
    if (thread.status === "error" || errorEvent) {
      throw new Error(
        `Thread failed before user-message ack containing ${JSON.stringify(args.text)}. Diagnostics: ${await buildThreadDiagnostics(args)}`,
      );
    }
    if (hasTurnCompletedAfter(events, args.baselineSequence)) {
      throw new Error(
        `Turn completed before user-message ack containing ${JSON.stringify(args.text)}. Diagnostics: ${await buildThreadDiagnostics(args)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, REAL_POLL_INTERVAL_MS));
  }
  throw new Error(
    `Timed out waiting for user-message ack containing ${JSON.stringify(args.text)}. Diagnostics: ${await buildThreadDiagnostics(args)}`,
  );
}

async function sendLongRunningTurnAndWaitStarted(
  args: SendLongRunningTurnArgs,
): Promise<WaitForTurnStartedResult> {
  const baselineEvents = await getThreadEvents(args.harness.api, args.threadId);
  const baselineSequence = Math.max(
    0,
    ...baselineEvents.map((event) => event.seq),
  );
  await sendTextMessage(args.harness.api, args.threadId, {
    execution: getExecutionOptions(args.providerId),
    text:
      "Write a detailed 20 section essay about the history of computing with four sentences per section.",
  });
  return waitForTurnStartedAfter({
    baselineSequence,
    harness: args.harness,
    threadId: args.threadId,
  });
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function assertProviderPrerequisites(
  providerId: RealProviderId,
): Promise<void> {
  await loadProjectEnvFile();
  await assertCliInstalled(providerId === "claude-code" ? "claude" : providerId);
}

const execFile = promisify(execFileCb);

async function assertCliInstalled(command: string): Promise<void> {
  try {
    await execFile(command, ["--help"]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${command} CLI is not installed or not on PATH`);
    }
    // --help returned non-zero but the binary exists — that's fine
  }
}

function getExecutionOptions(
  providerId: RealProviderId,
): RealProviderExecutionOptions {
  return FAST_EXECUTION_BY_PROVIDER[providerId];
}

function expectNonEmptyOutput(
  output: string | null,
  context: string,
): void {
  expect(output?.trim().length ?? 0, context).toBeGreaterThan(0);
}

function hasAssistantTimelineMessage(timeline: ThreadTimelineResponse): boolean {
  return timeline.rows.some(
    (row) =>
      row.kind === "message" &&
      (row.message.kind === "assistant-text" ||
        row.message.kind === "assistant-reasoning"),
  );
}

async function createRealThread(
  providerId: RealProviderId,
  workspace: RealThreadWorkspace,
) {
  await assertProviderPrerequisites(providerId);
  const harness = await createIntegrationHarness({ adapterFactory: undefined });
  const project = await createProjectFixture(harness, {
    name: `Real Provider ${providerId}`,
  });
  const readyThread = await createReadyHostThread(harness, {
    execution: getExecutionOptions(providerId),
    projectId: project.id,
    providerId,
    timeoutMs: TURN_TIMEOUT_MS,
    workspace,
  });

  return {
    harness,
    ...readyThread,
  };
}

async function sendAndWaitForIdle(args: SendAndWaitForIdleArgs) {
  const baselineEvents = await getThreadEvents(args.harness.api, args.threadId);
  const baselineSequence = Math.max(0, ...baselineEvents.map((event) => event.seq));
  await sendTextMessage(args.harness.api, args.threadId, {
    execution: getExecutionOptions(args.providerId),
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
      await new Promise((resolve) => setTimeout(resolve, REAL_POLL_INTERVAL_MS));
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
    const recentEvents = events
      .slice(-10)
      .map(describeThreadEvent)
      .join(" | ");
    const timelineKinds = timeline
      ? timeline.rows
        .map((row) => (row.kind === "message" ? row.message.kind : row.kind))
        .join(", ")
      : "unavailable";
    const outputPreview = output?.trim().slice(0, 160) ?? "";
    const lastError = [...events]
      .reverse()
      .find((event) => event.type === "error" || event.type === "system/error");
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

describe("real provider end-to-end integration", () => {
  for (const providerId of REAL_PROVIDER_IDS) {
    it.concurrent(
      `${providerId} completes a single turn end-to-end`,
      async () => {
        const { harness, thread } = await createRealThread(providerId, {
          path: null,
          type: "unmanaged",
        });

        try {
          const { events, output } = await sendAndWaitForIdle({
            providerId,
            threadId: thread.id,
            text: "Reply with a short hello in one sentence.",
            harness,
          });

          expect(countTurnEvents(events, "turn/started")).toBeGreaterThanOrEqual(1);
          expect(countTurnEvents(events, "turn/completed")).toBeGreaterThanOrEqual(1);
          expectNonEmptyOutput(output, `${providerId} single-turn output`);

          const timeline = await getThreadTimeline(harness.api, thread.id);
          expect(hasAssistantTimelineMessage(timeline)).toBe(true);
        } finally {
          await harness.cleanup();
        }
      },
      TEST_TIMEOUT_MS,
    );

    it.concurrent(
      `${providerId} handles a multi-turn thread end-to-end`,
      async () => {
        const { harness, thread } = await createRealThread(providerId, {
          path: null,
          type: "unmanaged",
        });

        try {
          await sendAndWaitForIdle({
            providerId,
            threadId: thread.id,
            text: "Remember this word for later: orchard.",
            harness,
          });
          const { events, output } = await sendAndWaitForIdle({
            providerId,
            threadId: thread.id,
            text: "What word did I ask you to remember? Reply briefly.",
            harness,
          });

          expect(countTurnEvents(events, "turn/completed")).toBeGreaterThanOrEqual(2);
          expect(events.every((event) => event.threadId === thread.id)).toBe(true);
          expectNonEmptyOutput(output, `${providerId} multi-turn output`);
        } finally {
          await harness.cleanup();
        }
      },
      TEST_TIMEOUT_MS,
    );

    it.concurrent(
      `${providerId} can steer an active turn`,
      async () => {
        const { harness, thread } = await createRealThread(providerId, {
          path: null,
          type: "unmanaged",
        });

        try {
          await sendLongRunningTurnAndWaitStarted({
            providerId,
            harness,
            threadId: thread.id,
          });
          const steerBaselineEvents = await getThreadEvents(harness.api, thread.id);
          const steerBaselineSequence = Math.max(
            0,
            ...steerBaselineEvents.map((event) => event.seq),
          );
          const steerText = `Steer acknowledgement ${providerId}`;
          await sendTextMessage(harness.api, thread.id, {
            execution: getExecutionOptions(providerId),
            mode: "steer",
            text: steerText,
          });
          await waitForUserMessageAckTextAfter({
            baselineSequence: steerBaselineSequence,
            harness,
            text: steerText,
            threadId: thread.id,
          });

          const refreshedThread = await getThread(harness.api, thread.id);
          if (refreshedThread.status === "active") {
            await stopThread(harness.api, thread.id);
            await waitForThreadStatus(
              harness.api,
              thread.id,
              "idle",
              STOP_TIMEOUT_MS,
            );
          }
        } finally {
          await harness.cleanup();
        }
      },
      TEST_TIMEOUT_MS,
    );

    it.concurrent(
      `${providerId} can stop an active turn and recover`,
      async () => {
        const { harness, thread } = await createRealThread(providerId, {
          path: null,
          type: "unmanaged",
        });

        try {
          await sendLongRunningTurnAndWaitStarted({
            providerId,
            harness,
            threadId: thread.id,
          });

          await stopThread(harness.api, thread.id);
          await waitForThreadStatus(
            harness.api,
            thread.id,
            "idle",
            STOP_TIMEOUT_MS,
          );

          const beforeRecoveryEvents = await getThreadEvents(harness.api, thread.id);
          const { events, output } = await sendAndWaitForIdle({
            providerId,
            threadId: thread.id,
            text: "Reply with a short confirmation that you are ready for the next task.",
            harness,
          });
          expect(countTurnEvents(events, "turn/completed")).toBeGreaterThan(
            countTurnEvents(beforeRecoveryEvents, "turn/completed"),
          );
          expectNonEmptyOutput(output, `${providerId} recovery output`);
        } finally {
          await harness.cleanup();
        }
      },
      TEST_TIMEOUT_MS,
    );

    it.concurrent(
      `${providerId} can interact with a managed workspace`,
      async () => {
        const { harness, environment, thread } = await createRealThread(providerId, {
          type: "managed-worktree",
        });

        try {
          const initialStatus = await getEnvironmentStatus(
            harness.api,
            environment.id,
          );
          const branches = await getEnvironmentBranches(
            harness.api,
            environment.id,
          );
          expect(initialStatus.workspace?.branch.currentBranch).toBeTruthy();
          expect(branches.length).toBeGreaterThan(0);

          await sendTextMessage(harness.api, thread.id, {
            text:
              "Create a file named hello.txt in the workspace with the content hello world if tool use is available. Then briefly summarize what you did.",
            execution: getExecutionOptions(providerId),
          });
          await waitForThreadStatus(
            harness.api,
            thread.id,
            "idle",
            TURN_TIMEOUT_MS,
          );

          const refreshedEnvironment = await getEnvironment(
            harness.api,
            environment.id,
          );
          const refreshedStatus = await getEnvironmentStatus(
            harness.api,
            environment.id,
          );
          const diff = await getEnvironmentDiff(harness.api, environment.id);
          expect(refreshedStatus.workspace?.branch.currentBranch).toBeTruthy();
          expectNonEmptyOutput(
            await getThreadOutput(harness.api, thread.id),
            `${providerId} workspace output`,
          );
          expect(typeof diff.diff).toBe("string");

          if (refreshedEnvironment.path) {
            const helloPath = path.join(refreshedEnvironment.path, "hello.txt");
            if (await pathExists(helloPath)) {
              const helloContents = await fs.readFile(helloPath, "utf8");
              expect(helloContents.trim()).toBe("hello world");
            }
          }
        } finally {
          await harness.cleanup();
        }
      },
      TEST_TIMEOUT_MS,
    );
  }

  it.concurrent(
    "runs codex and claude-code concurrently in separate environments",
    async () => {
      await assertProviderPrerequisites("codex");
      await assertProviderPrerequisites("claude-code");

      const harness = await createIntegrationHarness({ adapterFactory: undefined });

      try {
        const project = await createProjectFixture(harness, {
          name: "Real Concurrent Providers",
        });
        const codexThread = await createReadyHostThread(harness, {
          execution: getExecutionOptions("codex"),
          projectId: project.id,
          providerId: "codex",
          timeoutMs: TURN_TIMEOUT_MS,
          workspace: { type: "managed-worktree" },
        });
        const claudeThread = await createReadyHostThread(harness, {
          execution: getExecutionOptions("claude-code"),
          projectId: project.id,
          providerId: "claude-code",
          timeoutMs: TURN_TIMEOUT_MS,
          workspace: { type: "managed-worktree" },
        });

        await Promise.all([
          sendTextMessage(harness.api, codexThread.thread.id, {
            execution: getExecutionOptions("codex"),
            text: "Reply with a short hello from Codex.",
          }),
          sendTextMessage(harness.api, claudeThread.thread.id, {
            execution: getExecutionOptions("claude-code"),
            text: "Reply with a short hello from Claude.",
          }),
        ]);

        await Promise.all([
          waitForThreadStatus(
            harness.api,
            codexThread.thread.id,
            "idle",
            TURN_TIMEOUT_MS,
          ),
          waitForThreadStatus(
            harness.api,
            claudeThread.thread.id,
            "idle",
            TURN_TIMEOUT_MS,
          ),
        ]);

        expectNonEmptyOutput(
          await getThreadOutput(harness.api, codexThread.thread.id),
          "codex concurrent output",
        );
        expectNonEmptyOutput(
          await getThreadOutput(harness.api, claudeThread.thread.id),
          "claude concurrent output",
        );
        expect(
          (await getThreadEvents(harness.api, codexThread.thread.id)).every(
            (event) => event.threadId === codexThread.thread.id,
          ),
        ).toBe(true);
        expect(
          (await getThreadEvents(harness.api, claudeThread.thread.id)).every(
            (event) => event.threadId === claudeThread.thread.id,
          ),
        ).toBe(true);
      } finally {
        await harness.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  for (const providerId of REAL_PROVIDER_IDS) {
    it.concurrent(
      `${providerId} runs through the registered provider path`,
      async () => {
        const { harness, thread } = await createRealThread(providerId, {
          type: "managed-worktree",
        });

        try {
          const { events, output } = await sendAndWaitForIdle({
            providerId,
            threadId: thread.id,
            text: "Reply with a short confirmation that the thread is working.",
            harness,
          });

          expect(countTurnEvents(events, "turn/completed")).toBeGreaterThanOrEqual(1);
          expectNonEmptyOutput(output, `${providerId} registry output`);
        } finally {
          await harness.cleanup();
        }
      },
      TEST_TIMEOUT_MS,
    );
  }
});

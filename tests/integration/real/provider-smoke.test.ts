// Phase 7e: Real provider end-to-end coverage (plans/rebuild.md)
import fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

const REAL_PROVIDER_LOCK_PATH = path.join(
  tmpdir(),
  "bb-real-provider-tests.lock",
);
let realProviderLock: fs.FileHandle | null = null;

// Active-turn waits: enough time to confirm the provider has started a long-running turn.
const ACTIVE_TIMEOUT_MS = scaleTimeoutMs(15_000);
const REAL_POLL_INTERVAL_MS = 200;
// Whole-turn waits: real providers can take much longer than the fake adapter to respond.
const TURN_TIMEOUT_MS = scaleTimeoutMs(60_000);
// Stop waits: give the daemon time to interrupt an in-flight real-provider turn cleanly.
const STOP_TIMEOUT_MS = scaleTimeoutMs(30_000);
// Per-test budget: end-to-end provider checks include real network and provider startup latency.
const TEST_TIMEOUT_MS = scaleTimeoutMs(120_000);
// Mixed-provider budget: the all-provider pass runs multiple real-provider turns in one test.
const MIXED_PROVIDER_TIMEOUT_MS = scaleTimeoutMs(240_000);

const FAST_EXECUTION_BY_PROVIDER: Record<
  RealProviderId,
  RealProviderExecutionOptions
> = {
  codex: {
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

async function assertPathExists(targetPath: string): Promise<void> {
  await fs.access(targetPath);
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

  if (providerId === "codex") {
    await assertPathExists(path.join(homedir(), ".bun", "bin", "codex"));
    if (process.env.OPENAI_API_KEY?.trim()) {
      return;
    }
    await assertPathExists(path.join(homedir(), ".codex", "auth.json"));
    return;
  }

  if (providerId === "claude-code") {
    const hasOauthToken = !!process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
    const hasApiKey = !!process.env.ANTHROPIC_API_KEY?.trim();
    if (!hasOauthToken && !hasApiKey) {
      throw new Error(
        "Claude Code integration requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY",
      );
    }
    return;
  }

  await assertPathExists(path.join(homedir(), ".pi", "agent", "auth.json"));
  await assertPathExists("/opt/homebrew/bin/pi");
}

function getExecutionOptions(
  providerId: RealProviderId,
): RealProviderExecutionOptions {
  return FAST_EXECUTION_BY_PROVIDER[providerId];
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function acquireRealProviderLock(): Promise<void> {
  while (true) {
    try {
      realProviderLock = await fs.open(REAL_PROVIDER_LOCK_PATH, "wx");
      await realProviderLock.writeFile(
        JSON.stringify(
          {
            cwd: process.cwd(),
            pid: process.pid,
            startedAt: Date.now(),
          },
          null,
          2,
        ),
        "utf8",
      );
      return;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }

      const existingLock = await fs
        .readFile(REAL_PROVIDER_LOCK_PATH, "utf8")
        .then((raw) => JSON.parse(raw))
        .catch(() => null);
      const lockPid =
        existingLock &&
        typeof existingLock === "object" &&
        typeof existingLock.pid === "number"
          ? existingLock.pid
          : null;

      if (lockPid && isProcessAlive(lockPid)) {
        throw new Error(
          `Real provider integration tests are already running under pid ${lockPid}. Release ${REAL_PROVIDER_LOCK_PATH} before starting another worktree run.`,
        );
      }

      await fs.rm(REAL_PROVIDER_LOCK_PATH, { force: true });
    }
  }
}

async function releaseRealProviderLock(): Promise<void> {
  await realProviderLock?.close().catch(() => undefined);
  realProviderLock = null;
  await fs.rm(REAL_PROVIDER_LOCK_PATH, { force: true }).catch(() => undefined);
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
  workspace:
    | { type: "managed-worktree" }
    | { path: string | null; type: "unmanaged" },
) {
  await assertProviderPrerequisites(providerId);
  const harness = await createIntegrationHarness({ adapterFactory: undefined });
  const project = await createProjectFixture(harness, {
    name: `Real Provider ${providerId}`,
  });
  const readyThread = await createReadyHostThread(harness, {
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

async function sendAndWaitForIdle(args: {
  providerId: RealProviderId;
  threadId: string;
  text: string;
  harness: Awaited<ReturnType<typeof createIntegrationHarness>>;
}) {
  const baselineCompletedTurns = countTurnEvents(
    await getThreadEvents(args.harness.api, args.threadId),
    "turn/completed",
  );
  await sendTextMessage(args.harness.api, args.threadId, {
    execution: getExecutionOptions(args.providerId),
    text: args.text,
  });
  try {
    const startedAt = Date.now();
    let sawNonIdle = false;
    while (Date.now() - startedAt <= TURN_TIMEOUT_MS) {
      const [thread, events] = await Promise.all([
        getThread(args.harness.api, args.threadId),
        getThreadEvents(args.harness.api, args.threadId),
      ]);
      if (thread.status !== "idle") {
        sawNonIdle = true;
      }
      if (thread.status === "idle") {
        const completedTurns = countTurnEvents(events, "turn/completed");
        if (sawNonIdle || completedTurns > baselineCompletedTurns) {
          break;
        }
      }
      if (thread.status === "error") {
        throw new Error(
          `Thread ${args.threadId} entered error before reaching idle`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, REAL_POLL_INTERVAL_MS));
    }
  } catch (error) {
    const [thread, events, output, timeline] = await Promise.all([
      getThread(args.harness.api, args.threadId),
      getThreadEvents(args.harness.api, args.threadId),
      getThreadOutput(args.harness.api, args.threadId),
      getThreadTimeline(args.harness.api, args.threadId),
    ]);
    const recentEventTypes = events
      .slice(-10)
      .map((event) => event.type)
      .join(", ");
    const timelineKinds = timeline.rows
      .map((row) => (row.kind === "message" ? row.message.kind : row.kind))
      .join(", ");
    const outputPreview = output?.trim().slice(0, 160) ?? "";
    const lastError = [...events]
      .reverse()
      .find((event) => event.type === "error" || event.type === "system/error");
    const lastTurnCompleted = [...events]
      .reverse()
      .find((event) => event.type === "turn/completed");
    const message = error instanceof Error ? error.message : String(error);

    throw new Error(
      `${message}. Diagnostics: status=${thread.status}; events=${events.length}; recentEventTypes=[${recentEventTypes || "none"}]; timelineKinds=[${timelineKinds || "none"}]; lastError=${JSON.stringify(lastError?.data ?? null)}; lastTurnCompleted=${JSON.stringify(lastTurnCompleted?.data ?? null)}; outputPreview=${JSON.stringify(outputPreview)}`,
    );
  }

  const events = await getThreadEvents(args.harness.api, args.threadId);
  const output = await getThreadOutput(args.harness.api, args.threadId);

  return { events, output };
}

describe.sequential("real provider end-to-end integration", () => {
  beforeAll(async () => {
    await acquireRealProviderLock();
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await releaseRealProviderLock();
  });

  for (const providerId of REAL_PROVIDER_IDS) {
    it(
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

    it(
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

    it(
      `${providerId} can stop an active turn and recover`,
      async () => {
        const { harness, thread } = await createRealThread(providerId, {
          path: null,
          type: "unmanaged",
        });

        try {
          await sendTextMessage(harness.api, thread.id, {
            execution: getExecutionOptions(providerId),
            text:
              "Write a detailed 20 section essay about the history of computing with four sentences per section.",
          });
          await waitForThreadStatus(
            harness.api,
            thread.id,
            "active",
            ACTIVE_TIMEOUT_MS,
          );

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

    it(
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
          expect(initialStatus.workspace?.currentBranch).toBeTruthy();
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
          expect(refreshedStatus.workspace?.currentBranch).toBeTruthy();
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

  it(
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
          projectId: project.id,
          providerId: "codex",
          timeoutMs: TURN_TIMEOUT_MS,
          workspace: { type: "managed-worktree" },
        });
        const claudeThread = await createReadyHostThread(harness, {
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

  it(
    "runs codex, claude-code, and pi sequentially through the full registry",
    async () => {
      for (const providerId of REAL_PROVIDER_IDS) {
        await assertProviderPrerequisites(providerId);
      }

      const harness = await createIntegrationHarness({ adapterFactory: undefined });

      try {
        const project = await createProjectFixture(harness, {
          name: "Real Registry Sweep",
        });

        for (const providerId of REAL_PROVIDER_IDS) {
          const readyThread = await createReadyHostThread(harness, {
            projectId: project.id,
            providerId,
            timeoutMs: TURN_TIMEOUT_MS,
            workspace: { type: "managed-worktree" },
          });
          await sendTextMessage(harness.api, readyThread.thread.id, {
            execution: getExecutionOptions(providerId),
            text: "Reply with a short confirmation that the thread is working.",
          });
          await waitForThreadStatus(
            harness.api,
            readyThread.thread.id,
            "idle",
            TURN_TIMEOUT_MS,
          );
          expect(
            countTurnEvents(
              await getThreadEvents(harness.api, readyThread.thread.id),
              "turn/completed",
            ),
          ).toBeGreaterThanOrEqual(1);
          expectNonEmptyOutput(
            await getThreadOutput(harness.api, readyThread.thread.id),
            `${providerId} registry output`,
          );
        }
      } finally {
        await harness.cleanup();
      }
    },
    MIXED_PROVIDER_TIMEOUT_MS,
  );
});

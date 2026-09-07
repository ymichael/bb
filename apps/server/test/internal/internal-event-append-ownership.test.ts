import { eq } from "drizzle-orm";
import { events, getThread, listQueuedThreadMessages } from "@bb/db";
import { threadScope, turnScope } from "@bb/domain";
import {
  groupHostDaemonEvents,
  hostDaemonEventBatchResponseSchema,
  type HostDaemonEventEnvelope,
} from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { buildThreadTimeline } from "../../src/services/threads/timeline.js";
import {
  internalAuthHeaders,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  createCommandApprovalPayload,
  createUserQuestionPayload,
} from "../helpers/pending-interactions.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import type { TestAppHarness } from "../helpers/test-app.js";

interface SeedEventRouteArgs {
  hostType?: "persistent";
}

interface PostEventBatchArgs {
  harness: TestAppHarness;
  sessionId: string;
  events: HostDaemonEventEnvelope[];
}

async function postEventBatch(args: PostEventBatchArgs): Promise<Response> {
  return args.harness.app.request("/internal/session/events", {
    method: "POST",
    headers: internalAuthHeaders(args.harness),
    body: JSON.stringify({
      sessionId: args.sessionId,
      eventGroups: groupHostDaemonEvents(args.events),
    }),
  });
}

function setupEventRoute(args: SeedEventRouteArgs = {}) {
  return createTestAppHarness().then((harness) => {
    const { host, session } = seedHostSession(harness.deps, {
      type: args.hostType,
    });
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
    });
    const environment = seedEnvironment(harness.deps, {
      hostId: host.id,
      projectId: project.id,
    });
    const thread = seedThread(harness.deps, {
      projectId: project.id,
      environmentId: environment.id,
      status: "active",
    });
    return {
      environment,
      harness,
      host,
      project,
      session,
      thread,
    };
  });
}

describe("internal event append ownership", () => {
  it("stores thread-scoped ACP context usage for the timeline display", async () => {
    const { harness, session, thread } = await setupEventRoute();
    try {
      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "thread/contextWindowUsage/updated",
              threadId: thread.id,
              providerThreadId: "acp-session-1",
              scope: threadScope(),
              contextWindowUsage: {
                usedTokens: 24_000,
                modelContextWindow: 128_000,
                estimated: false,
              },
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      expect(
        buildThreadTimeline(harness.db, thread, {
          eventBudget: 1_000_000,
          includeProviderUnhandledOperations: true,
          maxInlineOutputChars: null,
          maxSeq: 1,
          page: {
            kind: "latest",
            segmentLimit: Number.MAX_SAFE_INTEGER,
          },
        }).contextWindowUsage,
      ).toEqual({
        usedTokens: 24_000,
        modelContextWindow: 128_000,
        estimated: false,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("assigns server-owned sequences and returns accepted event indexes", async () => {
    const { environment, harness, session, thread } = await setupEventRoute();
    try {
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 3,
        type: "system/error",
        scope: threadScope(),
        data: { message: "existing" },
      });

      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "system/error",
              threadId: thread.id,
              scope: threadScope(),
              message: "first daemon",
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "system/error",
              threadId: thread.id,
              scope: threadScope(),
              message: "second daemon",
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        acceptedEvents: [
          {
            eventIndex: 0,
            threadId: thread.id,
            sequence: 4,
          },
          {
            eventIndex: 1,
            threadId: thread.id,
            sequence: 5,
          },
        ],
        rejectedEvents: [],
      });
      expect(
        harness.db
          .select()
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all(),
      ).toMatchObject([
        { sequence: 3 },
        {
          sequence: 4,
        },
        {
          sequence: 5,
        },
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it("returns original event indexes after dropping orphan turn snapshots", async () => {
    const { harness, session, thread } = await setupEventRoute();
    try {
      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "thread/tokenUsage/updated",
              threadId: thread.id,
              scope: turnScope("turn-from-source-thread"),
              providerThreadId: "provider-fork-session",
              tokenUsage: {
                total: {
                  totalTokens: 42,
                  inputTokens: 20,
                  cachedInputTokens: 5,
                  outputTokens: 12,
                  reasoningOutputTokens: 5,
                },
                last: {
                  totalTokens: 42,
                  inputTokens: 20,
                  cachedInputTokens: 5,
                  outputTokens: 12,
                  reasoningOutputTokens: 5,
                },
                modelContextWindow: 200_000,
              },
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "system/error",
              threadId: thread.id,
              scope: threadScope(),
              message: "accepted after skipped",
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        acceptedEvents: [
          {
            eventIndex: 1,
            threadId: thread.id,
            sequence: 1,
          },
        ],
        rejectedEvents: [],
      });
      expect(
        harness.db
          .select()
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all(),
      ).toMatchObject([
        {
          sequence: 1,
          type: "system/error",
        },
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it("accepts a batch carrying a provider/unhandled event for a turn bb never started", async () => {
    const { harness, session, thread } = await setupEventRoute();
    try {
      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "provider/unhandled",
              threadId: thread.id,
              providerThreadId: "provider-compacting-session",
              providerId: "codex",
              rawType: "sdk/custom",
              scope: turnScope("auto-compact-1"),
              rawEvent: {
                jsonrpc: "2.0",
                method: "sdk/message",
                params: { threadId: thread.id, turnId: "auto-compact-1" },
              },
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "system/error",
              threadId: thread.id,
              scope: threadScope(),
              message: "queued behind the orphan event",
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        acceptedEvents: [
          {
            eventIndex: 1,
            threadId: thread.id,
            sequence: 1,
          },
        ],
        rejectedEvents: [],
      });
      expect(
        harness.db
          .select()
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all(),
      ).toMatchObject([
        {
          sequence: 1,
          type: "system/error",
        },
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it("assigns distinct sequences for simultaneous requests on the same thread", async () => {
    const { harness, session, thread } = await setupEventRoute();
    try {
      const [firstResponse, secondResponse] = await Promise.all([
        postEventBatch({
          harness,
          sessionId: session.id,
          events: [
            {
              threadId: thread.id,
              event: {
                type: "system/error",
                threadId: thread.id,
                scope: threadScope(),
                message: "first simultaneous daemon",
              },
            },
          ],
        }),
        postEventBatch({
          harness,
          sessionId: session.id,
          events: [
            {
              threadId: thread.id,
              event: {
                type: "system/error",
                threadId: thread.id,
                scope: threadScope(),
                message: "second simultaneous daemon",
              },
            },
          ],
        }),
      ]);

      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);
      const firstBody = hostDaemonEventBatchResponseSchema.parse(
        await readJson(firstResponse),
      );
      const secondBody = hostDaemonEventBatchResponseSchema.parse(
        await readJson(secondResponse),
      );
      expect(
        [...firstBody.acceptedEvents, ...secondBody.acceptedEvents]
          .map((event) => event.sequence)
          .sort((left, right) => left - right),
      ).toEqual([1, 2]);

      const storedRows = harness.db
        .select({
          sequence: events.sequence,
        })
        .from(events)
        .where(eq(events.threadId, thread.id))
        .all();

      expect(storedRows).toHaveLength(2);
      expect(
        storedRows
          .map((row) => row.sequence)
          .sort((left, right) => left - right),
      ).toEqual([1, 2]);
    } finally {
      await harness.cleanup();
    }
  });

  it("auto-sends a queued message after a zero-work turn completes", async () => {
    const { environment, harness, session, thread } = await setupEventRoute();
    try {
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        inputText: "/clear",
        providerThreadId: "provider-zero-work",
        threadId: thread.id,
      });
      seedQueuedMessage(harness.deps, {
        content: [
          {
            type: "text",
            text: "queued behind zero-work turn",
            mentions: [],
          },
        ],
        threadId: thread.id,
      });

      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "turn/started",
              threadId: thread.id,
              providerThreadId: "provider-zero-work",
              scope: turnScope("turn-zero-work"),
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "turn/completed",
              threadId: thread.id,
              providerThreadId: "provider-zero-work",
              scope: turnScope("turn-zero-work"),
              status: "completed",
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      const queuedTurn = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      expect(queuedTurn.command).toMatchObject({
        type: "turn.submit",
        input: [
          {
            type: "text",
            text: "queued behind zero-work turn",
            mentions: [],
          },
        ],
      });
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
      expect(getThread(harness.db, thread.id)?.status).toBe("active");
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects unowned thread events without blocking owned events in the same batch", async () => {
    const { harness, session, thread } = await setupEventRoute();
    try {
      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: "thr_missing",
            event: {
              type: "system/error",
              threadId: "thr_missing",
              scope: threadScope(),
              message: "stale daemon event",
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "system/error",
              threadId: thread.id,
              scope: threadScope(),
              message: "owned daemon event",
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        acceptedEvents: [
          {
            eventIndex: 1,
            threadId: thread.id,
            sequence: 1,
          },
        ],
        rejectedEvents: [
          {
            eventIndex: 0,
            reason: "thread_not_owned_by_host",
            threadId: "thr_missing",
          },
        ],
      });
      expect(
        harness.db
          .select()
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all(),
      ).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps owned event indexes aligned around an unowned middle row", async () => {
    const { environment, harness, project, session, thread } =
      await setupEventRoute();
    const secondThread = seedThread(harness.deps, {
      environmentId: environment.id,
      projectId: project.id,
      status: "active",
      title: "Second Thread",
    });
    try {
      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "thread/name/updated",
              threadId: thread.id,
              providerThreadId: "provider-owned-first",
              scope: threadScope(),
              threadName: "First owned rename",
            },
          },
          {
            threadId: "thr_missing",
            event: {
              type: "thread/name/updated",
              threadId: "thr_missing",
              providerThreadId: "provider-unowned-middle",
              scope: threadScope(),
              threadName: "Rejected rename",
            },
          },
          {
            threadId: secondThread.id,
            event: {
              type: "thread/name/updated",
              threadId: secondThread.id,
              providerThreadId: "provider-owned-second",
              scope: threadScope(),
              threadName: "Second owned rename",
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        acceptedEvents: [
          {
            eventIndex: 0,
            threadId: thread.id,
            sequence: 1,
          },
          {
            eventIndex: 2,
            threadId: secondThread.id,
            sequence: 1,
          },
        ],
        rejectedEvents: [
          {
            eventIndex: 1,
            reason: "thread_not_owned_by_host",
            threadId: "thr_missing",
          },
        ],
      });
      expect(getThread(harness.db, thread.id)?.title).not.toBe(
        "First owned rename",
      );
      expect(getThread(harness.db, secondThread.id)?.title).toBe(
        "Second Thread",
      );
      expect(
        harness.db
          .select()
          .from(events)
          .where(eq(events.threadId, "thr_missing"))
          .all(),
      ).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("notifies a parent when a child provider process exits", async () => {
    const { environment, harness, project, session } = await setupEventRoute();
    const parentThread = seedThread(harness.deps, {
      environmentId: environment.id,
      projectId: project.id,
      status: "idle",
      title: "Project coordinator",
    });
    seedThreadRuntimeState(harness.deps, {
      environmentId: environment.id,
      inputText: "Coordinate child work",
      providerThreadId: "provider-parent-provider-exit",
      threadId: parentThread.id,
    });
    const childThread = seedThread(harness.deps, {
      environmentId: environment.id,
      parentThreadId: parentThread.id,
      projectId: project.id,
      status: "active",
      title: "Child provider exit worker",
    });
    try {
      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: childThread.id,
            event: {
              type: "system/error",
              threadId: childThread.id,
              scope: threadScope(),
              code: "provider_process_exited",
              message: "Provider process exited",
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        acceptedEvents: [
          {
            eventIndex: 0,
            threadId: childThread.id,
            sequence: 1,
          },
        ],
        rejectedEvents: [],
      });
      expect(getThread(harness.db, childThread.id)?.status).toBe("error");

      const parentTurnCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" &&
          command.threadId === parentThread.id,
        3_000,
      );
      if (parentTurnCommand.command.type !== "turn.submit") {
        throw new Error(
          `Expected parent turn command, got ${parentTurnCommand.command.type}`,
        );
      }
      const [input] = parentTurnCommand.command.input;
      if (!input || input.type !== "text") {
        throw new Error("Expected parent notification text input");
      }
      const threadMention = `@thread:${childThread.id}`;
      expect(input.text).toContain(
        [
          `${threadMention} failed.`,
          "",
          "Review the thread before deciding next steps.",
        ].join("\n"),
      );
      expect(input.text).not.toContain("No failure output was recorded.");
      expect(input.mentions).toEqual([
        {
          start: input.text.indexOf(threadMention),
          end: input.text.indexOf(threadMention) + threadMention.length,
          resource: {
            kind: "thread",
            label: "Child provider exit worker",
            projectId: project.id,
            threadId: childThread.id,
          },
        },
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it("does not notify a parent when a side-chat child provider process exits", async () => {
    const { environment, harness, project, session } = await setupEventRoute();
    const parentThread = seedThread(harness.deps, {
      environmentId: environment.id,
      projectId: project.id,
      status: "idle",
    });
    seedThreadRuntimeState(harness.deps, {
      environmentId: environment.id,
      inputText: "Coordinate side chat child work",
      providerThreadId: "provider-side-chat-parent-provider-exit",
      threadId: parentThread.id,
    });
    const childThread = seedThread(harness.deps, {
      environmentId: environment.id,
      originKind: "fork",
      originPluginId: "side-chat",
      parentThreadId: parentThread.id,
      projectId: project.id,
      status: "active",
      visibility: "hidden",
    });
    try {
      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: childThread.id,
            event: {
              type: "system/error",
              threadId: childThread.id,
              scope: threadScope(),
              code: "provider_process_exited",
              message: "Provider process exited",
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      expect(getThread(harness.db, childThread.id)?.status).toBe("error");
      await expect(
        waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "turn.submit" &&
            command.threadId === parentThread.id,
          100,
        ),
      ).rejects.toThrow("Timed out waiting for queued command");
    } finally {
      await harness.cleanup();
    }
  });
});

describe("interaction lifecycle records from the daemon", () => {
  async function postLifecycle(args: {
    harness: TestAppHarness;
    sessionId: string;
    threadId: string;
    interactionId: string;
  }): Promise<Response> {
    return postEventBatch({
      harness: args.harness,
      sessionId: args.sessionId,
      events: [
        {
          threadId: args.threadId,
          event: {
            type: "system/interaction/lifecycle",
            threadId: args.threadId,
            scope: threadScope(),
            interaction: {
              id: args.interactionId,
              status: "resolved",
              statusReason: null,
              origin: {
                kind: "provider",
                providerId: "codex",
                providerRequestId: "request-forged",
              },
              payload: {
                kind: "approval",
                subject: {
                  kind: "command",
                  itemId: "item-forged",
                  command: "rm -rf /",
                  cwd: "/tmp/project",
                  actions: [{ type: "unknown", command: "rm -rf /" }],
                  sessionGrant: null,
                },
                reason: null,
              },
              resolution: { decision: "allow_once", grantedPermissions: null },
            },
          },
        },
      ],
    });
  }

  function storedLifecycleRows(harness: TestAppHarness, threadId: string) {
    return harness.deps.db
      .select({ type: events.type })
      .from(events)
      .where(eq(events.threadId, threadId))
      .all()
      .filter((row) => row.type === "system/interaction/lifecycle");
  }

  it("drops a lifecycle record that names no interaction on the thread", async () => {
    const { harness, session, thread } = await setupEventRoute();
    try {
      const response = await postLifecycle({
        harness,
        sessionId: session.id,
        threadId: thread.id,
        interactionId: "pi_forged",
      });
      expect(response.status).toBe(200);
      const body = hostDaemonEventBatchResponseSchema.parse(
        await readJson(response),
      );
      expect(body.acceptedEvents).toEqual([]);
      expect(body.rejectedEvents).toEqual([]);
      expect(storedLifecycleRows(harness, thread.id)).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("drops a lifecycle record even for an interaction the server registered on that thread", async () => {
    const { harness, session, thread } = await setupEventRoute();
    try {
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        turnId: "turn-lifecycle-1",
        providerThreadId: "provider-thread-lifecycle",
      });
      const registered =
        harness.deps.pendingInteractions.registerPendingInteraction({
          interaction: {
            threadId: thread.id,
            turnId: "turn-lifecycle-1",
            providerId: "codex",
            providerThreadId: "provider-thread-lifecycle",
            providerRequestId: "request-real",
            payload: createCommandApprovalPayload({
              itemId: "item-real",
              reason: "Approve command",
              command: "git status",
              cwd: "/tmp/project",
            }),
          },
        });
      if (registered.outcome === "rejected") {
        throw new Error(`Expected registration: ${registered.reason}`);
      }
      const before = storedLifecycleRows(harness, thread.id).length;
      const response = await postLifecycle({
        harness,
        sessionId: session.id,
        threadId: thread.id,
        interactionId: registered.interaction.id,
      });
      expect(response.status).toBe(200);
      const body = hostDaemonEventBatchResponseSchema.parse(
        await readJson(response),
      );
      expect(body.acceptedEvents).toEqual([]);
      expect(body.rejectedEvents).toEqual([]);
      expect(storedLifecycleRows(harness, thread.id)).toHaveLength(before);
      const interaction = harness.deps.pendingInteractions.getThreadInteraction(
        {
          threadId: thread.id,
          interactionId: registered.interaction.id,
        },
      );
      expect(interaction.status).toBe("pending");
      expect(interaction.resolution).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects a forged answer for a real pending user question in every lifecycle event shape and leaves it pending and unanswered", async () => {
    const { harness, session, thread } = await setupEventRoute();
    try {
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        turnId: "turn-lifecycle-2",
        providerThreadId: "provider-thread-question",
      });
      const registered =
        harness.deps.pendingInteractions.registerPendingInteraction({
          interaction: {
            threadId: thread.id,
            turnId: "turn-lifecycle-2",
            providerId: "codex",
            providerThreadId: "provider-thread-question",
            providerRequestId: "request-question",
            payload: createUserQuestionPayload({
              prompt: "Which deployment target should I use?",
            }),
          },
        });
      if (registered.outcome === "rejected") {
        throw new Error(`Expected registration: ${registered.reason}`);
      }
      const interactionId = registered.interaction.id;
      const storedRows = () =>
        harness.deps.db
          .select({ type: events.type })
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all()
          .map((row) => row.type);
      const before = storedRows();
      const forgedAnswers = {
        "question-1": {
          selected: ["production"],
          freeText: "ship it straight to production",
        },
      };
      const forgedQuestion = createUserQuestionPayload({
        prompt: "Forged prompt the user never saw",
      });
      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "system/interaction/lifecycle",
              threadId: thread.id,
              scope: turnScope("turn-lifecycle-2"),
              interaction: {
                id: interactionId,
                status: "resolved",
                statusReason: null,
                origin: {
                  kind: "provider",
                  providerId: "codex",
                  providerRequestId: "request-question",
                },
                payload: forgedQuestion,
                resolution: { kind: "user_answer", answers: forgedAnswers },
              },
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "system/userQuestion/lifecycle",
              threadId: thread.id,
              scope: turnScope("turn-lifecycle-2"),
              interactionId,
              providerId: "codex",
              providerRequestId: "request-question",
              status: "resolved",
              statusReason: null,
              resolution: { kind: "user_answer", answers: forgedAnswers },
              payload: forgedQuestion,
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "system/permissionGrant/lifecycle",
              threadId: thread.id,
              scope: turnScope("turn-lifecycle-2"),
              interactionId,
              providerId: "codex",
              providerRequestId: "request-question",
              status: "resolved",
              statusReason: null,
              resolution: {
                decision: "allow_for_session",
                grantedPermissions: null,
              },
              subject: {
                kind: "permission_grant",
                itemId: "item-forged-grant",
                toolName: "Bash",
                permissions: { network: null, fileSystem: null },
              },
            },
          },
        ],
      });
      expect(response.status).toBe(200);
      const body = hostDaemonEventBatchResponseSchema.parse(
        await readJson(response),
      );
      expect(body.acceptedEvents).toEqual([]);
      expect(body.rejectedEvents).toEqual([]);
      expect(storedRows()).toEqual(before);

      const interaction = harness.deps.pendingInteractions.getThreadInteraction(
        {
          threadId: thread.id,
          interactionId,
        },
      );
      expect(interaction.status).toBe("pending");
      expect(interaction.resolution).toBeNull();
      expect(
        harness.deps.pendingInteractions
          .listPendingThreadInteractions(thread.id)
          .map((pending) => pending.id),
      ).toEqual([interactionId]);

      const maxSeq = Math.max(
        ...harness.deps.db
          .select({ sequence: events.sequence })
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all()
          .map((row) => row.sequence),
      );
      const questionRows = buildThreadTimeline(harness.db, thread, {
        eventBudget: 1_000_000,
        includeProviderUnhandledOperations: true,
        maxInlineOutputChars: null,
        maxSeq,
        page: { kind: "latest", segmentLimit: Number.MAX_SAFE_INTEGER },
      }).rows.flatMap((row) =>
        row.kind === "work" && row.workKind === "question" ? [row] : [],
      );
      expect(questionRows).toHaveLength(1);
      expect(questionRows[0]).toMatchObject({
        interactionId,
        lifecycle: "pending",
        answers: null,
      });
      expect(questionRows[0]?.questions[0]?.prompt).toBe(
        "Which deployment target should I use?",
      );
    } finally {
      await harness.cleanup();
    }
  });
});

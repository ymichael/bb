import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { eq } from "drizzle-orm";
import {
  closeSession,
  events,
  getEnvironment,
  getThread,
  listEnvironments,
  listQueuedThreadMessages,
  threads,
} from "@bb/db";
import { threadScope, turnScope, type ToolCallResponse } from "@bb/domain";
import {
  groupHostDaemonEvents,
  type HostDaemonEventEnvelope,
} from "@bb/host-daemon-contract";
import { describe, expect, it, vi } from "vitest";
import { serve } from "@hono/node-server";
import {
  internalAuthHeaders,
  listQueuedThreadCommands,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEvent,
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import type { TestAppHarness } from "../helpers/test-app.js";
import { setPluginAgentContributions } from "../../src/services/plugins/plugin-agent-contributions.js";
import type { PluginAgentToolRecord } from "../../src/services/plugins/plugin-api.js";

async function postEventBatch(args: {
  events: HostDaemonEventEnvelope[];
  harness: TestAppHarness;
  sessionId: string;
}): Promise<Response> {
  return args.harness.app.request("/internal/session/events", {
    method: "POST",
    headers: internalAuthHeaders(args.harness),
    body: JSON.stringify({
      sessionId: args.sessionId,
      eventGroups: groupHostDaemonEvents(args.events),
    }),
  });
}

async function postToolCall(args: {
  arguments?: unknown;
  callId?: string;
  harness: TestAppHarness;
  providerThreadId?: string;
  sessionId: string;
  threadId: string;
  tool: string;
  turnId?: string;
}): Promise<Response> {
  return args.harness.app.request("/internal/session/tool-call", {
    method: "POST",
    headers: internalAuthHeaders(args.harness),
    body: JSON.stringify({
      sessionId: args.sessionId,
      threadId: args.threadId,
      providerThreadId: args.providerThreadId ?? "provider-tool-call",
      turnId: args.turnId ?? "turn-tool-call",
      callId: args.callId ?? "call-tool-call",
      tool: args.tool,
      arguments: args.arguments,
    }),
  });
}

async function flushDeferredChildThreadNotifications(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await sleep(2_100);
}

describe("internal event and tool-call routes", () => {
  it("returns the response head before a plugin tool completes", async () => {
    await withTestHarness(async (harness) => {
      const record = {
        name: "wait_for_user",
      } as PluginAgentToolRecord;
      let completeTool!: (value: ToolCallResponse) => void;
      const toolResult = new Promise<ToolCallResponse>((resolve) => {
        completeTool = resolve;
      });
      setPluginAgentContributions({
        listSkillRootContributions: () => [],
        listAgentTools: () => [],
        listInstructionContributions: () => [],
        findAgentTool: (name) =>
          name === record.name ? { pluginId: "fixture", record } : undefined,
        invokeAgentTool: () => toolResult,
        resolveMention: async () => ({ ok: false, error: "unused" }),
      });

      try {
        const { host, session } = seedHostSession(harness.deps, {
          id: "host-streaming-tool-call",
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
        });

        const server = serve({
          fetch: harness.app.fetch,
          hostname: "127.0.0.1",
          port: 0,
        });
        try {
          if (!server.listening) await once(server, "listening");
          const address = server.address();
          if (address === null || typeof address === "string") {
            throw new Error("Expected a TCP server address");
          }
          const responsePromise = fetch(
            `http://127.0.0.1:${address.port}/internal/session/tool-call`,
            {
              method: "POST",
              headers: internalAuthHeaders(harness),
              body: JSON.stringify({
                sessionId: session.id,
                threadId: thread.id,
                providerThreadId: "provider-tool-call",
                turnId: "turn-tool-call",
                callId: "call-tool-call",
                tool: record.name,
              }),
            },
          );
          const earlyResponse = await Promise.race([
            responsePromise,
            sleep(1_000).then(() => null),
          ]);

          completeTool({
            success: true,
            contentItems: [{ type: "inputText", text: "answered" }],
          });
          const response = earlyResponse ?? (await responsePromise);

          expect(earlyResponse).not.toBeNull();
          expect(response.status).toBe(200);
          await expect(readJson(response)).resolves.toEqual({
            success: true,
            contentItems: [{ type: "inputText", text: "answered" }],
          });
        } finally {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        }
      } finally {
        setPluginAgentContributions(undefined);
      }
    });
  });

  it("persists a native plugin tool call as the bridge sent it: no server-side label enrichment", async () => {
    await withTestHarness(async (harness) => {
      const record = {
        name: "repository_context",
        presentation: {
          label: {
            pending: "Reading project overview",
            completed: "Read project overview",
          },
        },
      } as PluginAgentToolRecord;
      setPluginAgentContributions({
        listSkillRootContributions: () => [],
        listAgentTools: () => [],
        listInstructionContributions: () => [],
        findAgentTool: (name) =>
          name === record.name ? { pluginId: "fixture", record } : undefined,
        invokeAgentTool: async () => ({
          success: false,
          contentItems: [{ type: "inputText", text: "unused" }],
        }),
        resolveMention: async () => ({ ok: false, error: "unused" }),
      });

      try {
        const { session } = seedHostSession(harness.deps);
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: session.hostId,
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: session.hostId,
          projectId: project.id,
        });
        const thread = seedThread(harness.deps, {
          environmentId: environment.id,
          projectId: project.id,
          status: "active",
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
                providerThreadId: "provider-1",
                scope: turnScope("turn-1"),
              },
            },
            ...(["item/started", "item/completed"] as const).map((type) => ({
              threadId: thread.id,
              event: {
                type,
                threadId: thread.id,
                providerThreadId: "provider-1",
                scope: turnScope("turn-1"),
                item: {
                  type: "toolCall" as const,
                  id: "tool-1",
                  tool: record.name,
                  status:
                    type === "item/started"
                      ? ("pending" as const)
                      : ("completed" as const),
                },
              },
            })),
          ],
        });

        expect(response.status).toBe(200);
        const storedToolEvents = harness.db
          .select()
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all()
          .filter(
            (event) =>
              event.type === "item/started" || event.type === "item/completed",
          );
        expect(storedToolEvents).toHaveLength(2);
        for (const event of storedToolEvents) {
          const item = JSON.parse(event.data).item;
          expect(item.tool).toBe(record.name);
          expect(item).not.toHaveProperty("statusLabels");
        }
      } finally {
        setPluginAgentContributions(undefined);
      }
    });
  });

  it("appends event batches and returns accepted event indexes", async () => {
    await withTestHarness(async (harness) => {
      const { session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: session.hostId,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: session.hostId,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
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
              providerThreadId: "provider-1",
              scope: turnScope("turn-1"),
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "turn/completed",
              threadId: thread.id,
              providerThreadId: "provider-1",
              scope: turnScope("turn-1"),
              status: "completed",
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
            eventIndex: 1,
            threadId: thread.id,
            sequence: 2,
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
      ).toHaveLength(2);
    });
  });

  it("does not log redundant run-start no-ops for already-active threads", async () => {
    await withTestHarness(async (harness) => {
      const info = vi.fn();
      harness.deps.logger.info = info;
      const { session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: session.hostId,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: session.hostId,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
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
              providerThreadId: "provider-thread",
              scope: turnScope("turn-1"),
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      expect(
        harness.db.select().from(threads).where(eq(threads.id, thread.id)).get()
          ?.status,
      ).toBe("active");
      expect(
        info.mock.calls.filter(
          ([, message]) => message === "Thread lifecycle event not applied",
        ),
      ).toEqual([]);
    });
  });

  it("logs inactive session details when daemon event posting uses a closed session", async () => {
    await withTestHarness(async (harness) => {
      const info = vi.fn();
      harness.deps.logger.info = info;
      const { session } = seedHostSession(harness.deps, { id: "host-1" });
      closeSession(
        harness.deps.db,
        harness.deps.hub,
        session.id,
        "daemon-disconnect",
      );

      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [],
      });

      expect(response.status).toBe(401);
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          authenticatedHostId: session.hostId,
          closeReason: "daemon-disconnect",
          inactiveSessionReason: "closed",
          sessionHostId: session.hostId,
          sessionId: session.id,
          sessionStatus: "closed",
        }),
        "Daemon event batch for inactive session",
      );
    });
  });

  it("rejects daemon turn-scoped events before turn/started is stored", async () => {
    await withTestHarness(async (harness) => {
      const { session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: session.hostId,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: session.hostId,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "turn/completed",
              threadId: thread.id,
              providerThreadId: "provider-missing-start",
              scope: turnScope("turn-missing-start"),
              status: "completed",
            },
          },
        ],
      });

      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
      });
      expect(
        harness.db
          .select()
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all(),
      ).toHaveLength(0);
    });
  });

  it("transitions active threads back to idle for a started/completed event batch", async () => {
    await withTestHarness(async (harness) => {
      const { session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: session.hostId,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: session.hostId,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
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
              providerThreadId: "provider-thread",
              scope: turnScope("turn-1"),
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "turn/completed",
              threadId: thread.id,
              providerThreadId: "provider-thread",
              scope: turnScope("turn-1"),
              status: "completed",
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      expect(
        harness.db.select().from(threads).where(eq(threads.id, thread.id)).get()
          ?.status,
      ).toBe("idle");
    });
  });

  it("keeps active root turns queueable when a delegated child turn completes", async () => {
    await withTestHarness(async (harness) => {
      const { session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: session.hostId,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: session.hostId,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        status: "active",
      });

      const eventResponse = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "turn/started",
              threadId: thread.id,
              providerThreadId: "provider-thread-main",
              scope: turnScope("root-turn"),
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "turn/started",
              threadId: thread.id,
              providerThreadId: "provider-thread-main",
              scope: turnScope("delegated-child-turn"),
              parentToolCallId: "call-delegate-agent",
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "turn/completed",
              threadId: thread.id,
              providerThreadId: "provider-thread-main",
              scope: turnScope("delegated-child-turn"),
              status: "completed",
            },
          },
        ],
      });

      expect(eventResponse.status).toBe(200);
      await expect(readJson(eventResponse)).resolves.toMatchObject({
        acceptedEvents: [
          { eventIndex: 0, threadId: thread.id },
          { eventIndex: 1, threadId: thread.id },
          { eventIndex: 2, threadId: thread.id },
        ],
        rejectedEvents: [],
      });
      expect(
        harness.db.select().from(threads).where(eq(threads.id, thread.id)).get()
          ?.status,
      ).toBe("active");

      const sendResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            input: [{ type: "text", text: "Follow up after child turn" }],
            mode: "queue-if-active",
            model: "gpt-5",
            permissionMode: "full",
            reasoningLevel: "medium",
            serviceTier: "default",
          }),
        },
      );

      expect(sendResponse.status).toBe(200);
      await expect(readJson(sendResponse)).resolves.toMatchObject({
        ok: true,
        delivery: "queued",
        queuedMessage: {
          id: expect.any(String),
          waitingOn: { kind: "thread-busy" },
          sendAt: null,
        },
      });
      const queuedRows = listQueuedThreadMessages(harness.db, thread.id);
      expect(queuedRows).toHaveLength(1);
      expect(JSON.parse(queuedRows[0]?.content ?? "null")).toEqual([
        {
          mentions: [],
          text: "Follow up after child turn",
          type: "text",
        },
      ]);
      expect(
        harness.db
          .select()
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all()
          .filter((row) => row.type === "client/turn/requested"),
      ).toEqual([]);
    });
  });

  it("does not activate an idle thread for a delegated child turn", async () => {
    await withTestHarness(async (harness) => {
      const { session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: session.hostId,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: session.hostId,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        status: "idle",
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
              providerThreadId: "provider-thread",
              scope: turnScope("delegated-child-turn"),
              parentToolCallId: "call-delegate-agent",
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "turn/completed",
              threadId: thread.id,
              providerThreadId: "provider-thread",
              scope: turnScope("delegated-child-turn"),
              status: "completed",
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      expect(
        harness.db.select().from(threads).where(eq(threads.id, thread.id)).get()
          ?.status,
      ).toBe("idle");
    });
  });

  it("does not notify a parent when a child thread nested turn completes", async () => {
    await withTestHarness(async (harness) => {
      const { session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: session.hostId,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: session.hostId,
        projectId: project.id,
      });
      const parentThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        status: "active",
      });
      seedEvent(harness.deps, {
        threadId: parentThread.id,
        environmentId: environment.id,
        providerThreadId: "provider-parent-thread",
        sequence: 1,
        type: "turn/started",
        scope: turnScope("parent-root-turn"),
        data: {
          providerThreadId: "provider-parent-thread",
        },
      });
      const childThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        parentThreadId: parentThread.id,
        providerId: "codex",
        status: "active",
      });

      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: childThread.id,
            event: {
              type: "turn/started",
              threadId: childThread.id,
              providerThreadId: "provider-child-thread",
              scope: turnScope("child-root-turn"),
            },
          },
          {
            threadId: childThread.id,
            event: {
              type: "turn/started",
              threadId: childThread.id,
              providerThreadId: "provider-child-thread",
              scope: turnScope("child-nested-turn"),
              parentToolCallId: "call-nested-agent",
            },
          },
          {
            threadId: childThread.id,
            event: {
              type: "turn/completed",
              threadId: childThread.id,
              providerThreadId: "provider-child-thread",
              scope: turnScope("child-nested-turn"),
              status: "completed",
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      await flushDeferredChildThreadNotifications();

      expect(
        harness.db
          .select()
          .from(threads)
          .where(eq(threads.id, childThread.id))
          .get()?.status,
      ).toBe("active");
      expect(
        harness.db
          .select()
          .from(events)
          .where(eq(events.threadId, parentThread.id))
          .all()
          .map((row) => row.type),
      ).toEqual(["turn/started"]);
    });
  });

  it("notifies a parent when a hidden delegated child root turn completes", async () => {
    await withTestHarness(async (harness) => {
      const { session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: session.hostId,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: session.hostId,
        projectId: project.id,
      });
      const parentThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        status: "idle",
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        inputText: "Coordinate hidden child work",
        providerThreadId: "provider-hidden-parent",
        threadId: parentThread.id,
      });
      const childThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        parentThreadId: parentThread.id,
        providerId: "codex",
        status: "active",
        visibility: "hidden",
      });

      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: childThread.id,
            event: {
              type: "turn/started",
              threadId: childThread.id,
              providerThreadId: "provider-hidden-child",
              scope: turnScope("hidden-child-root-turn"),
            },
          },
          {
            threadId: childThread.id,
            event: {
              type: "turn/completed",
              threadId: childThread.id,
              providerThreadId: "provider-hidden-child",
              scope: turnScope("hidden-child-root-turn"),
              status: "completed",
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      await flushDeferredChildThreadNotifications();
      expect(getThread(harness.db, childThread.id)?.status).toBe("idle");
      expect(
        listQueuedThreadCommands(harness, "turn.submit", parentThread.id),
      ).toHaveLength(1);
    });
  });

  it("does not notify a parent when a side-chat child root turn completes", async () => {
    await withTestHarness(async (harness) => {
      const { session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: session.hostId,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: session.hostId,
        projectId: project.id,
      });
      const parentThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        status: "idle",
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        inputText: "Coordinate side chat child work",
        providerThreadId: "provider-side-chat-parent",
        threadId: parentThread.id,
      });
      const childThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        originKind: "fork",
        originPluginId: "side-chat",
        parentThreadId: parentThread.id,
        providerId: "codex",
        status: "active",
        visibility: "hidden",
      });

      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: childThread.id,
            event: {
              type: "turn/started",
              threadId: childThread.id,
              providerThreadId: "provider-side-chat-child",
              scope: turnScope("side-chat-child-root-turn"),
            },
          },
          {
            threadId: childThread.id,
            event: {
              type: "turn/completed",
              threadId: childThread.id,
              providerThreadId: "provider-side-chat-child",
              scope: turnScope("side-chat-child-root-turn"),
              status: "completed",
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      await flushDeferredChildThreadNotifications();
      expect(getThread(harness.db, childThread.id)?.status).toBe("idle");
      expect(
        listQueuedThreadCommands(harness, "turn.submit", parentThread.id),
      ).toEqual([]);
    });
  });

  it("does not reactivate a stopped thread when provider turn start arrives after interruption", async () => {
    await withTestHarness(async (harness) => {
      const { session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: session.hostId,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: session.hostId,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        inputText: "Run this command and wait before replying: sleep 60",
        providerThreadId: "provider-stop-race",
        sequenceStart: 1,
        threadId: thread.id,
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: null,
        sequence: 3,
        type: "system/thread/interrupted",
        scope: threadScope(),
        data: {
          reason: "manual-stop",
        },
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
              providerThreadId: "provider-stop-race",
              scope: turnScope("turn-stop-race"),
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      expect(
        harness.db.select().from(threads).where(eq(threads.id, thread.id)).get()
          ?.status,
      ).toBe("idle");
    });
  });

  it("keeps a thread idle when a started/completed batch is posted again", async () => {
    await withTestHarness(async (harness) => {
      const { session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: session.hostId,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: session.hostId,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      const eventBatch: HostDaemonEventEnvelope[] = [
        {
          threadId: thread.id,
          event: {
            type: "turn/started",
            threadId: thread.id,
            providerThreadId: "provider-thread",
            scope: turnScope("turn-1"),
          },
        },
        {
          threadId: thread.id,
          event: {
            type: "turn/completed",
            threadId: thread.id,
            providerThreadId: "provider-thread",
            scope: turnScope("turn-1"),
            status: "completed",
          },
        },
      ];

      const firstResponse = await postEventBatch({
        harness,
        sessionId: session.id,
        events: eventBatch,
      });
      expect(firstResponse.status).toBe(200);
      const duplicateResponse = await postEventBatch({
        harness,
        sessionId: session.id,
        events: eventBatch,
      });
      expect(duplicateResponse.status).toBe(200);

      expect(
        harness.db.select().from(threads).where(eq(threads.id, thread.id)).get()
          ?.status,
      ).toBe("idle");
      expect(
        harness.db
          .select({ type: events.type })
          .from(events)
          .where(eq(events.threadId, thread.id))
          .orderBy(events.sequence)
          .all()
          .map((event) => event.type),
      ).toEqual(["turn/started", "turn/completed", "turn/completed"]);

      const timelineResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline`,
      );
      expect(timelineResponse.status).toBe(200);
    });
  });

  it("leaves a settled thread untouched when a stale turn completion is redelivered alone", async () => {
    await withTestHarness(async (harness) => {
      const { session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: session.hostId,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: session.hostId,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-stale-completion",
        sequence: 1,
        type: "turn/started",
        scope: turnScope("turn-stale-completion"),
        data: { providerThreadId: "provider-stale-completion" },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-stale-completion",
        sequence: 2,
        type: "turn/completed",
        scope: turnScope("turn-stale-completion"),
        data: { status: "completed" },
      });
      const settledRow = harness.db
        .select()
        .from(threads)
        .where(eq(threads.id, thread.id))
        .get();

      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "turn/completed",
              threadId: thread.id,
              providerThreadId: "provider-stale-completion",
              scope: turnScope("turn-stale-completion"),
              status: "completed",
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      expect(
        harness.db
          .select()
          .from(threads)
          .where(eq(threads.id, thread.id))
          .get(),
      ).toEqual(settledRow);
    });
  });

  it("updates a thread to an existing environment for the requested host path", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const currentEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/current-environment",
      });
      const targetEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/existing-managed-worktree",
        managed: true,
        workspaceProvisionType: "managed-worktree",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: currentEnvironment.id,
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: currentEnvironment.id,
        providerThreadId: "provider-tool-call",
        sequence: 1,
        type: "turn/started",
        scope: turnScope("turn-existing-environment"),
        data: {
          providerThreadId: "provider-tool-call",
        },
      });

      const response = await postToolCall({
        harness,
        sessionId: session.id,
        threadId: thread.id,
        turnId: "turn-existing-environment",
        tool: "update_environment_directory",
        arguments: { path: "/tmp/existing-managed-worktree/" },
      });

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: expect.stringContaining(
              "Environment directory updated to /tmp/existing-managed-worktree",
            ),
          },
        ],
      });
      expect(getThread(harness.db, thread.id)?.environmentId).toBe(
        targetEnvironment.id,
      );
      expect(listEnvironments(harness.db, project.id)).toHaveLength(2);
      const storedEvents = harness.db
        .select()
        .from(events)
        .where(eq(events.threadId, thread.id))
        .all();
      expect(storedEvents.map((event) => event.type)).toEqual([
        "turn/started",
        "system/operation",
      ]);
      expect(storedEvents[1]).toMatchObject({
        type: "system/operation",
        scopeKind: "turn",
        turnId: "turn-existing-environment",
      });
    });
  });

  it("creates an unmanaged environment for a new requested host path", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const currentEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/current-environment",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: currentEnvironment.id,
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: currentEnvironment.id,
        providerThreadId: "provider-tool-call",
        sequence: 1,
        type: "turn/started",
        scope: turnScope("turn-new-environment"),
        data: {
          providerThreadId: "provider-tool-call",
        },
      });

      const responsePromise = postToolCall({
        harness,
        sessionId: session.id,
        threadId: thread.id,
        turnId: "turn-new-environment",
        tool: "update_environment_directory",
        arguments: { path: "/tmp/new-unmanaged-worktree" },
      });
      const provisionCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.provision" &&
          command.workspaceProvisionType === "unmanaged" &&
          command.path === "/tmp/new-unmanaged-worktree",
      );
      if (provisionCommand.command.type !== "environment.provision") {
        throw new Error("Expected environment.provision command");
      }
      expect(provisionCommand.command.initiator).toBeNull();

      await reportQueuedCommandSuccess(harness, provisionCommand, {
        path: "/tmp/new-unmanaged-worktree",
        isGitRepo: true,
        isWorktree: true,
        branchName: "feature/new-worktree",
        defaultBranch: "main",
        transcript: [],
      });
      const response = await responsePromise;

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: expect.stringContaining(
              "Environment directory updated to /tmp/new-unmanaged-worktree",
            ),
          },
        ],
      });
      const targetEnvironment = listEnvironments(harness.db, project.id).find(
        (environment) => environment.path === "/tmp/new-unmanaged-worktree",
      );
      expect(targetEnvironment).toMatchObject({
        hostId: host.id,
        projectId: project.id,
        status: "ready",
        workspaceProvisionType: "unmanaged",
      });
      expect(getThread(harness.db, thread.id)?.environmentId).toBe(
        targetEnvironment?.id,
      );
      expect(
        targetEnvironment
          ? getEnvironment(harness.db, targetEnvironment.id)
          : null,
      ).toMatchObject({
        branchName: "feature/new-worktree",
        isGitRepo: true,
        isWorktree: true,
      });
      const storedEvents = harness.db
        .select()
        .from(events)
        .where(eq(events.threadId, thread.id))
        .all();
      expect(storedEvents.map((event) => event.type)).toEqual([
        "turn/started",
        "system/operation",
      ]);
      expect(storedEvents[1]).toMatchObject({
        scopeKind: "turn",
        turnId: "turn-new-environment",
      });
    });
  });

  it("switches into a directory another project already uses", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const sharedPath = "/tmp/shared-with-another-project";
      const { project: otherProject } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        name: "Other Project",
        path: sharedPath,
      });
      const otherEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: otherProject.id,
        path: sharedPath,
      });

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/switching-project",
      });
      const currentEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/switching-project",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: currentEnvironment.id,
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: currentEnvironment.id,
        providerThreadId: "provider-tool-call",
        sequence: 1,
        type: "turn/started",
        scope: turnScope("turn-shared-directory"),
        data: {
          providerThreadId: "provider-tool-call",
        },
      });

      const responsePromise = postToolCall({
        harness,
        sessionId: session.id,
        threadId: thread.id,
        turnId: "turn-shared-directory",
        tool: "update_environment_directory",
        arguments: { path: sharedPath },
      });
      const provisionCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.provision" &&
          command.workspaceProvisionType === "unmanaged" &&
          command.path === sharedPath,
      );
      await reportQueuedCommandSuccess(harness, provisionCommand, {
        path: sharedPath,
        isGitRepo: true,
        isWorktree: false,
        branchName: "main",
        defaultBranch: "main",
        transcript: [],
      });

      await expect(readJson(await responsePromise)).resolves.toMatchObject({
        success: true,
      });
      const switched = getThread(harness.db, thread.id)?.environmentId;
      expect(switched).not.toBe(otherEnvironment.id);
      expect(getEnvironment(harness.db, switched ?? "")).toMatchObject({
        path: sharedPath,
        projectId: project.id,
      });
      expect(getEnvironment(harness.db, otherEnvironment.id)).toMatchObject({
        path: sharedPath,
        projectId: otherProject.id,
      });
    });
  });

  it("refuses to switch into another project's managed worktree", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const worktreePath = "/tmp/bb-worktrees/env_owner/repo";
      const { project: owner } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        name: "Owning Project",
      });
      seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: owner.id,
        path: worktreePath,
        managed: true,
        workspaceProvisionType: "managed-worktree",
      });

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        name: "Aliasing Project",
        path: "/tmp/aliasing-project",
      });
      const currentEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/aliasing-project",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: currentEnvironment.id,
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: currentEnvironment.id,
        providerThreadId: "provider-tool-call",
        sequence: 1,
        type: "turn/started",
        scope: turnScope("turn-managed-alias"),
        data: { providerThreadId: "provider-tool-call" },
      });

      const response = await postToolCall({
        harness,
        sessionId: session.id,
        threadId: thread.id,
        turnId: "turn-managed-alias",
        tool: "update_environment_directory",
        arguments: { path: worktreePath },
      });

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: expect.stringContaining(
              "bb-managed workspace owned by another project",
            ),
          },
        ],
      });
      expect(getThread(harness.db, thread.id)?.environmentId).toBe(
        currentEnvironment.id,
      );
      expect(listEnvironments(harness.db, project.id)).toHaveLength(1);
    });
  });

  it("rejects relative update_environment_directory paths without changing the thread", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
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
      });

      const response = await postToolCall({
        harness,
        sessionId: session.id,
        threadId: thread.id,
        tool: "update_environment_directory",
        arguments: { path: "../other-checkout" },
      });

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: "Path must be an absolute path on the current host.",
          },
        ],
      });
      expect(getThread(harness.db, thread.id)?.environmentId).toBe(
        environment.id,
      );
      expect(listEnvironments(harness.db, project.id)).toHaveLength(1);
    });
  });

  it("rejects unsupported tool calls", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-tool-call-unsupported",
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
      });

      const response = await harness.app.request(
        "/internal/session/tool-call",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            threadId: thread.id,
            providerThreadId: "provider-unsupported-tool",
            turnId: "turn-1",
            callId: "call-1",
            tool: "spawn_thread",
            arguments: {},
          }),
        },
      );

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        success: false,
        contentItems: [
          { type: "inputText", text: "Unsupported tool: spawn_thread" },
        ],
      });
      const childThreads = harness.db
        .select()
        .from(threads)
        .where(eq(threads.parentThreadId, thread.id))
        .all();
      expect(childThreads).toHaveLength(0);
    });
  });

  it("does not support agent side chat send-to-main tool calls", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const mainThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const sideChatThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        originKind: "fork",
        originPluginId: "side-chat",
        visibility: "hidden",
        sourceThreadId: mainThread.id,
        status: "active",
      });

      const response = await harness.app.request(
        "/internal/session/tool-call",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            threadId: sideChatThread.id,
            providerThreadId: "provider-side-chat",
            turnId: "turn-side-chat",
            callId: "call-send-main",
            tool: "bb_send_to_main_thread",
            arguments: {
              message: "Please carry this back to the main thread.",
            },
          }),
        },
      );

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: "Unsupported tool: bb_send_to_main_thread",
          },
        ],
      });
      expect(
        listQueuedThreadCommands(harness, "turn.submit", mainThread.id),
      ).toHaveLength(0);
    });
  });

  it("rejects message_user tool calls as unsupported", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
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
      });

      const response = await harness.app.request(
        "/internal/session/tool-call",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            threadId: thread.id,
            providerThreadId: "provider-message-user",
            turnId: "turn-missing",
            callId: "call-missing-turn",
            tool: "message_user",
            arguments: {
              text: "Need input from the user",
            },
          }),
        },
      );

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        success: false,
        contentItems: [
          { type: "inputText", text: "Unsupported tool: message_user" },
        ],
      });
      expect(
        harness.db
          .select()
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all(),
      ).toHaveLength(0);
    });
  });

  it("rejects empty tool call turn ids at the internal contract boundary", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
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
      });

      const response = await harness.app.request(
        "/internal/session/tool-call",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            threadId: thread.id,
            providerThreadId: "provider-empty-turn",
            turnId: "",
            callId: "call-empty-turn",
            tool: "message_user",
            arguments: {
              text: "Need input from the user",
            },
          }),
        },
      );

      expect(response.status).toBe(400);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
      });
      expect(
        harness.db
          .select()
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all(),
      ).toHaveLength(0);
    });
  });

  it("still rejects message_user after the turn start is stored", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
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
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-message-user",
        sequence: 1,
        type: "turn/started",
        scope: turnScope("turn-2"),
        data: {
          providerThreadId: "provider-message-user",
        },
      });

      const response = await harness.app.request(
        "/internal/session/tool-call",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            threadId: thread.id,
            providerThreadId: "provider-message-user",
            turnId: "turn-2",
            callId: "call-2",
            tool: "message_user",
            arguments: {
              text: "Need input from the user",
            },
          }),
        },
      );

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        success: false,
        contentItems: [
          { type: "inputText", text: "Unsupported tool: message_user" },
        ],
      });
      const storedEvents = harness.db
        .select()
        .from(events)
        .where(eq(events.threadId, thread.id))
        .orderBy(events.sequence)
        .all();
      expect(storedEvents).toHaveLength(1);
    });
  });
});

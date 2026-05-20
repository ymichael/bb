import { and, eq } from "drizzle-orm";
import {
  archiveThread,
  createPromptHistoryEntry,
  createQueuedThreadMessageId,
  deleteHost,
  environments,
  events,
  getQueuedThreadMessage,
  getThread,
  hostDaemonCommands,
  queuedThreadMessages,
} from "@bb/db";
import {
  encodeClientTurnRequestIdNumber,
  threadQueuedMessageSchema,
  threadScope,
  threadSchema,
  turnScope,
} from "@bb/domain";
import {
  type ThreadStatusVersionResponse,
  type TimelineRow,
  threadComposerBootstrapResponseSchema,
  threadQueuedMessageListResponseSchema,
  threadStatusVersionResponseSchema,
  threadTimelineResponseSchema,
  threadWithIncludesResponseSchema,
  timelineTurnSummaryDetailsResponseSchema,
} from "@bb/server-contract";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  type QueuedCommand,
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
  waitForQueuedCommandAfter,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import type { TestAppHarness } from "../helpers/test-app.js";
import {
  seedQueuedMessage,
  seedEnvironment,
  seedEvent,
  seedHost,
  seedHostSession,
  seedProjectWithSource,
  seedStoredEvent,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";

const queuedMessageIdResponseSchema = z.object({
  id: z.string(),
});

const threadReadResponseSchema = z.object({
  lastReadAt: z.number().nullable(),
});

const threadEventWaitResponseSchema = z.object({
  seq: z.number(),
  type: z.string(),
});

type TimelineTurnRow = Extract<TimelineRow, { kind: "turn" }>;

interface ManagerThreadStorageFixture {
  hostId: string;
  threadId: string;
  storageRootPath: string;
}

function seedManagerThreadStorage(
  harness: TestAppHarness,
): ManagerThreadStorageFixture {
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/project-source",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/project-source",
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    type: "manager",
  });
  return {
    hostId: host.id,
    threadId: thread.id,
    storageRootPath: `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}`,
  };
}

describe("public thread data routes", () => {
  it("embeds thread environment and host snapshots when requested", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-thread-include",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
      });

      const leanResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}`,
      );
      expect(leanResponse.status).toBe(200);
      const leanThread = await readJson(leanResponse);
      expect(leanThread).not.toHaveProperty("environment");
      expect(leanThread).not.toHaveProperty("host");

      const includeResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}?include=environment,host`,
      );
      expect(includeResponse.status).toBe(200);
      const includedThread = threadWithIncludesResponseSchema.parse(
        await readJson(includeResponse),
      );

      expect(includedThread.environment?.id).toBe(environment.id);
      expect(includedThread.host?.id).toBe(host.id);
      expect(includedThread.host?.status).toBe("connected");
    } finally {
      await harness.cleanup();
    }
  });

  it("returns null thread includes when relations are absent or unresolved", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-thread-null-include",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const threadWithoutEnvironment = seedThread(harness.deps, {
        environmentId: null,
        projectId: project.id,
      });
      const threadWithMissingHost = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
      });
      deleteHost(harness.deps.db, harness.deps.hub, host.id);

      const noEnvironmentResponse = await harness.app.request(
        `/api/v1/threads/${threadWithoutEnvironment.id}?include=environment,host`,
      );
      expect(noEnvironmentResponse.status).toBe(200);
      const noEnvironmentThread = threadWithIncludesResponseSchema.parse(
        await readJson(noEnvironmentResponse),
      );
      expect(noEnvironmentThread.environment).toBeNull();
      expect(noEnvironmentThread.host).toBeNull();

      const missingHostResponse = await harness.app.request(
        `/api/v1/threads/${threadWithMissingHost.id}?include=host`,
      );
      expect(missingHostResponse.status).toBe(200);
      const missingHostThread = threadWithIncludesResponseSchema.parse(
        await readJson(missingHostResponse),
      );
      expect(missingHostThread).not.toHaveProperty("environment");
      expect(missingHostThread.host).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects invalid thread include values", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}?include=environment,timeline`,
      );
      expect(response.status).toBe(400);
    } finally {
      await harness.cleanup();
    }
  });

  it("returns timeline rows from thread events", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
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
        sequence: 1,
        type: "system/manager/user_message",
        scope: threadScope(),
        data: { text: "Manager note one" },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 2,
        type: "system/manager/user_message",
        scope: threadScope(),
        data: { text: "Manager note two" },
      });

      const timelineResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline`,
      );
      expect(timelineResponse.status).toBe(200);
      await expect(readJson(timelineResponse)).resolves.toEqual(
        expect.objectContaining({
          rows: expect.arrayContaining([
            expect.objectContaining({
              kind: "conversation",
            }),
          ]),
        }),
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("hydrates timeline turn-summary details from the summary row identity and range", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
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
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        sequence: 1,
        type: "turn/started",
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        sequence: 2,
        type: "item/completed",
        data: {
          item: {
            type: "toolCall",
            id: "tool-1",
            tool: "exec_command",
            arguments: { cmd: "pnpm test" },
            status: "completed",
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        sequence: 3,
        type: "item/completed",
        data: {
          item: {
            type: "agentMessage",
            id: "assistant-1",
            text: "Done.",
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        sequence: 4,
        type: "turn/completed",
        data: {
          status: "completed",
        },
      });

      const timelineResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline`,
      );
      expect(timelineResponse.status).toBe(200);
      const timeline = threadTimelineResponseSchema.parse(
        await readJson(timelineResponse),
      );
      const turnRow = timeline.rows.find(
        (row): row is TimelineTurnRow => row.kind === "turn",
      );
      expect(turnRow).toBeDefined();
      if (!turnRow) {
        throw new Error("Expected a turn row");
      }
      expect(turnRow.children).toBeNull();

      const toolDetailsResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline/turn-summary-details?turnId=${turnRow.turnId}&sourceSeqStart=${turnRow.sourceSeqStart}&sourceSeqEnd=${turnRow.sourceSeqEnd}`,
      );
      expect(toolDetailsResponse.status).toBe(200);
      const toolDetails = timelineTurnSummaryDetailsResponseSchema.parse(
        await readJson(toolDetailsResponse),
      );

      expect(toolDetails.rows.map((row) => row.kind)).toEqual(["work"]);
      expect(toolDetails.rows[0]?.kind).toBe("work");
      const detailRow = toolDetails.rows[0];
      if (detailRow?.kind === "work" && detailRow.workKind === "tool") {
        expect(detailRow.workKind).toBe("tool");
        expect(detailRow.callId).toBe("tool-1");
      }
    } finally {
      await harness.cleanup();
    }
  });

  it("hydrates a single-event turn-summary detail range", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
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
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        sequence: 1,
        type: "turn/started",
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        sequence: 2,
        type: "item/completed",
        data: {
          item: {
            type: "agentMessage",
            id: "assistant-1",
            text: "Single detail.",
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        sequence: 3,
        type: "turn/completed",
        data: {
          status: "completed",
        },
      });

      const detailsResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline/turn-summary-details?turnId=turn-1&sourceSeqStart=2&sourceSeqEnd=2`,
      );
      expect(detailsResponse.status).toBe(200);
      const details = timelineTurnSummaryDetailsResponseSchema.parse(
        await readJson(detailsResponse),
      );

      expect(details.rows).toHaveLength(1);
      expect(details.rows[0]?.kind).toBe("conversation");
      if (details.rows[0]?.kind === "conversation") {
        expect(details.rows[0].role).toBe("assistant");
        expect(details.rows[0].text).toBe("Single detail.");
        expect(details.rows[0].sourceSeqStart).toBe(2);
        expect(details.rows[0].sourceSeqEnd).toBe(2);
      }
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects invalid thread data query params with a 400", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
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
        `/api/v1/threads/${thread.id}/timeline/turn-summary-details?turnId=turn-1&sourceSeqStart=oops&sourceSeqEnd=2`,
      );
      expect(response.status).toBe(400);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("returns thread output and default execution options from stored events", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
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
        sequence: 1,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 101 }),
          input: [{ type: "text", text: "Explain the result" }],
          target: { kind: "new-turn" },
          execution: {
            model: "gpt-4o-mini",
            reasoningLevel: "medium",
            permissionMode: "full",
            serviceTier: "fast",
            source: "client/turn/requested",
          },
          initiator: "user",
          senderThreadId: null,
          request: {
            method: "turn/start",
            params: {},
          },
          source: "tell",
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-output",
        scope: turnScope("turn-1"),
        sequence: 2,
        type: "item/completed",
        data: {
          item: {
            type: "agentMessage",
            id: "msg-1",
            text: "First assistant reply",
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-output",
        scope: turnScope("turn-2"),
        sequence: 3,
        type: "item/completed",
        data: {
          item: {
            type: "agentMessage",
            id: "msg-2",
            text: "Last assistant reply",
          },
        },
      });

      const outputResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/output`,
      );
      expect(outputResponse.status).toBe(200);
      await expect(readJson(outputResponse)).resolves.toEqual({
        output: "Last assistant reply",
      });

      const defaultsResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/default-execution-options`,
      );
      expect(defaultsResponse.status).toBe(200);
      await expect(readJson(defaultsResponse)).resolves.toEqual({
        model: "gpt-4o-mini",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "fast",
        source: "client/turn/requested",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("returns the manager user-visible output when a later assistant item is empty", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
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
        type: "manager",
      });

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-output",
        scope: turnScope("turn-1"),
        sequence: 1,
        type: "system/manager/user_message",
        data: {
          text: "Visible manager update",
          toolCallId: "call-1",
          turnId: "turn-1",
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-output",
        scope: turnScope("turn-1"),
        sequence: 2,
        type: "item/completed",
        data: {
          item: {
            type: "agentMessage",
            id: "msg-1",
            text: "",
          },
        },
      });

      const outputResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/output`,
      );
      expect(outputResponse.status).toBe(200);
      await expect(readJson(outputResponse)).resolves.toEqual({
        output: "Visible manager update",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("skips malformed item/completed events and returns the last valid output", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
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
        providerThreadId: "provider-output",
        scope: turnScope("turn-1"),
        sequence: 1,
        type: "item/completed",
        data: {
          item: {
            type: "agentMessage",
            id: "msg-1",
            text: "Earlier assistant reply",
          },
        },
      });
      // Malformed: missing item.type, so the derived item_kind column is null.
      // The row is filtered out at the DB level instead of turning into a 500.
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-output",
        scope: turnScope("turn-2"),
        itemId: "msg-2",
        itemKind: null,
        sequence: 2,
        type: "item/completed",
        data: {
          item: {
            id: "msg-2",
          },
        },
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/output`,
      );

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        output: "Earlier assistant reply",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("returns the latest stored execution options from request events", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
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
        sequence: 1,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 201 }),
          input: [{ type: "text", text: "Initial request" }],
          target: { kind: "thread-start" },
          execution: {
            model: "gpt-5",
            reasoningLevel: "medium",
            permissionMode: "full",
            serviceTier: "default",
            source: "client/turn/requested",
          },
          initiator: "user",
          senderThreadId: null,
          request: {
            method: "thread/start",
            params: {},
          },
          source: "spawn",
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 2,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 202 }),
          input: [{ type: "text", text: "Follow up request" }],
          target: { kind: "new-turn" },
          execution: {
            model: "gpt-5-mini",
            reasoningLevel: "high",
            permissionMode: "workspace-write",
            serviceTier: "fast",
            source: "client/turn/requested",
          },
          initiator: "user",
          senderThreadId: null,
          request: {
            method: "turn/start",
            params: {},
          },
          source: "tell",
        },
      });

      const defaultsResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/default-execution-options`,
      );
      expect(defaultsResponse.status).toBe(200);
      await expect(readJson(defaultsResponse)).resolves.toEqual({
        model: "gpt-5-mini",
        reasoningLevel: "high",
        permissionMode: "workspace-write",
        serviceTier: "fast",
        source: "client/turn/requested",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("fails loudly when the latest stored request event is malformed", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
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
        sequence: 1,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 301 }),
          input: [{ type: "text", text: "Earlier valid request" }],
          target: { kind: "new-turn" },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/turn/requested",
          },
          initiator: "user",
          senderThreadId: null,
          request: {
            method: "turn/start",
            params: {},
          },
          source: "tell",
        },
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        itemId: null,
        itemKind: null,
        sequence: 2,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 302 }),
          input: [{ type: "text", text: "Malformed latest request" }],
          initiator: "user",
          senderThreadId: null,
          request: {
            method: "turn/start",
            params: {},
          },
          source: "tell",
        },
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/default-execution-options`,
      );

      expect(response.status).toBe(500);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "internal_error",
        message: expect.stringContaining(`thread ${thread.id}`),
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("marks threads as read and unread", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
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

      const readResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/read`,
        {
          method: "POST",
        },
      );
      expect(readResponse.status).toBe(200);
      const readThread = threadReadResponseSchema.parse(
        await readJson(readResponse),
      );
      expect(readThread.lastReadAt).toBeTypeOf("number");
      const threadAfterRead = getThread(harness.db, thread.id);
      expect(threadAfterRead?.lastReadAt).toBeTypeOf("number");
      expect(threadAfterRead?.latestAttentionAt).toBe(thread.latestAttentionAt);

      const unreadResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/unread`,
        {
          method: "POST",
        },
      );
      expect(unreadResponse.status).toBe(200);
      await expect(readJson(unreadResponse)).resolves.toMatchObject({
        lastReadAt: null,
      });
      const threadAfterUnread = getThread(harness.db, thread.id);
      expect(threadAfterUnread?.lastReadAt).toBeNull();
      expect(threadAfterUnread?.latestAttentionAt).toBe(
        thread.latestAttentionAt,
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("creates and deletes thread queued messages", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
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
        sequence: 1,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 401 }),
          input: [{ type: "text", text: "Earlier work" }],
          target: { kind: "new-turn" },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/turn/requested",
          },
          initiator: "user",
          senderThreadId: null,
          request: {
            method: "turn/start",
            params: {},
          },
          source: "tell",
        },
      });

      const createResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            input: [{ type: "text", text: "Queued message from test" }],
            reasoningLevel: "high",
            permissionMode: "full",
          }),
        },
      );
      expect(createResponse.status).toBe(201);
      const queuedMessage = queuedMessageIdResponseSchema.parse(
        await readJson(createResponse),
      );
      expect(
        getQueuedThreadMessage(harness.db, queuedMessage.id),
      ).toMatchObject({
        id: queuedMessage.id,
      });

      const deleteResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages/${queuedMessage.id}`,
        {
          method: "DELETE",
        },
      );
      expect(deleteResponse.status).toBe(200);
      await expect(readJson(deleteResponse)).resolves.toEqual({ ok: true });
      expect(getQueuedThreadMessage(harness.db, queuedMessage.id)).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("auto-sends queued messages created on idle provider threads", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-queued-message-create-idle-auto-send",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/queued-message-create-idle-auto-send-source",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/queued-message-create-idle-auto-send-environment",
        workspaceProvisionType: "unmanaged",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-queued-message-create-idle-auto-send",
      });

      const createResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            input: [{ type: "text", text: "Queued message ready to send" }],
            permissionMode: "full",
          }),
        },
      );
      expect(createResponse.status).toBe(201);
      const queuedMessage = queuedMessageIdResponseSchema.parse(
        await readJson(createResponse),
      );

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      expect(queued.command).toMatchObject({
        environmentId: environment.id,
        input: [{ type: "text", text: "Queued message ready to send" }],
        resumeContext: {
          providerThreadId: "provider-queued-message-create-idle-auto-send",
        },
      });
      expect(getQueuedThreadMessage(harness.db, queuedMessage.id)).toBeNull();
      expect(getThread(harness.db, thread.id)?.status).toBe("active");
    } finally {
      await harness.cleanup();
    }
  });

  it("lists queued thread messages", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
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
      seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: [{ type: "text", text: "First queued message" }],
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
      });
      seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: [{ type: "text", text: "Second queued message" }],
        model: "gpt-5",
        reasoningLevel: "high",
        permissionMode: "full",
        serviceTier: "fast",
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages`,
      );

      expect(response.status).toBe(200);
      const queuedMessages = threadQueuedMessageListResponseSchema.parse(
        await readJson(response),
      );
      expect(queuedMessages).toHaveLength(2);
      expect(queuedMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            content: [{ type: "text", text: "First queued message" }],
            model: "gpt-5",
            reasoningLevel: "medium",
            permissionMode: "full",
            serviceTier: "default",
          }),
          expect.objectContaining({
            content: [{ type: "text", text: "Second queued message" }],
            model: "gpt-5",
            reasoningLevel: "high",
            permissionMode: "full",
            serviceTier: "fast",
          }),
        ]),
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("loads thread composer bootstrap state", async () => {
    const harness = await createTestAppHarness();
    try {
      seedHostSession(harness.deps, {
        id: "host-composer-default",
      });
      const { host } = seedHostSession(harness.deps, {
        id: "host-composer-thread",
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
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 601 }),
          input: [{ type: "text", text: "Accepted prompt" }],
          target: { kind: "new-turn" },
          execution: {
            model: "gpt-5.5",
            serviceTier: "default",
            reasoningLevel: "xhigh",
            permissionMode: "workspace-write",
            source: "client/turn/requested",
          },
          initiator: "user",
          senderThreadId: null,
          request: {
            method: "turn/start",
            params: {},
          },
          source: "tell",
        },
      });
      createPromptHistoryEntry(harness.deps.db, {
        projectId: project.id,
        threadId: thread.id,
        scope: "thread",
        requestSequence: 1,
        input: [{ type: "text", text: "Accepted prompt" }],
      });
      seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: [{ type: "text", text: "Queued message" }],
        model: "gpt-5.5",
        reasoningLevel: "xhigh",
        permissionMode: "workspace-write",
        serviceTier: "default",
      });

      const responsePromise = harness.app.request(
        `/api/v1/threads/${thread.id}/composer-bootstrap`,
      );
      const providersCommand = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "provider.list",
      );
      expect(providersCommand.row.hostId).toBe(host.id);
      await reportQueuedCommandSuccess(
        harness,
        providersCommand,
        {
          providers: [
            {
              id: "codex",
              displayName: "Codex",
              capabilities: {
                supportsArchive: true,
                supportsRename: true,
                supportsServiceTier: true,
                supportsUserQuestion: true,
                supportedPermissionModes: [
                  "full",
                  "workspace-write",
                  "readonly",
                ],
              },
              available: true,
            },
          ],
        },
        { hostId: host.id },
      );
      const modelsCommand = await waitForQueuedCommandAfter(
        harness,
        providersCommand.row.cursor,
        ({ command }) =>
          command.type === "provider.list_models" &&
          command.providerId === "codex",
      );
      expect(modelsCommand.row.hostId).toBe(host.id);
      await reportQueuedCommandSuccess(
        harness,
        modelsCommand,
        {
          models: [
            {
              id: "gpt-5.5",
              model: "gpt-5.5",
              displayName: "GPT-5.5",
              description: "Frontier model",
              supportedReasoningEfforts: [
                {
                  reasoningEffort: "xhigh",
                  description: "Extra high",
                },
              ],
              defaultReasoningEffort: "xhigh",
              isDefault: true,
            },
          ],
          selectedOnlyModels: [],
        },
        { hostId: host.id },
      );
      const response = await responsePromise;

      expect(response.status).toBe(200);
      const bootstrap = threadComposerBootstrapResponseSchema.parse(
        await readJson(response),
      );
      expect(bootstrap.defaultExecutionOptions).toMatchObject({
        model: "gpt-5.5",
        reasoningLevel: "xhigh",
        permissionMode: "workspace-write",
      });
      expect(bootstrap.queuedMessages).toHaveLength(1);
      expect(bootstrap.executionOptions.providers).toHaveLength(1);
      expect(
        bootstrap.executionOptions.providers[0]?.capabilities
          .supportsUserQuestion,
      ).toBe(false);
      expect(bootstrap.executionOptions.models[0]?.model).toBe("gpt-5.5");
      expect(bootstrap.queuedMessages[0]?.content).toEqual([
        { type: "text", text: "Queued message" },
      ]);
      expect(bootstrap.pendingInteractions).toEqual([]);
      expect(bootstrap.promptHistory.map((entry) => entry.input)).toEqual(
        expect.arrayContaining([
          [{ type: "text", text: "Accepted prompt" }],
          [{ type: "text", text: "Queued message" }],
        ]),
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("returns empty composer execution options for archived threads on offline hosts", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, {
        id: "host-composer-archived-offline",
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
      archiveThread(harness.db, harness.hub, thread.id);

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/composer-bootstrap`,
      );

      expect(response.status).toBe(200);
      const bootstrap = threadComposerBootstrapResponseSchema.parse(
        await readJson(response),
      );
      expect(bootstrap.executionOptions).toEqual({
        providers: [],
        models: [],
        selectedOnlyModels: [],
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("inherits thread default execution options when queued message overrides are omitted", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
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
        sequence: 1,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 501 }),
          input: [{ type: "text", text: "Earlier work" }],
          target: { kind: "new-turn" },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/turn/requested",
          },
          initiator: "user",
          senderThreadId: null,
          request: {
            method: "turn/start",
            params: {},
          },
          source: "tell",
        },
      });

      const createResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            input: [{ type: "text", text: "Queued message from test" }],
          }),
        },
      );
      expect(createResponse.status).toBe(201);
      const queuedMessage = queuedMessageIdResponseSchema.parse(
        await readJson(createResponse),
      );
      expect(
        getQueuedThreadMessage(harness.db, queuedMessage.id),
      ).toMatchObject({
        id: queuedMessage.id,
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        permissionMode: "full",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("persists queued message model and service tier and clears the queued message after reprovision send", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/queued-message-reprovision",
        status: "error",
        managed: true,
        workspaceProvisionType: "managed-worktree",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const createResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            input: [{ type: "text", text: "Queued message from test" }],
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "high",
            permissionMode: "full",
          }),
        },
      );
      expect(createResponse.status).toBe(201);
      const createdQueuedMessage = threadQueuedMessageSchema.parse(
        await readJson(createResponse),
      );
      expect(createdQueuedMessage).toMatchObject({
        model: "gpt-5",
        serviceTier: "default",
      });

      const sendResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages/${createdQueuedMessage.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ mode: "auto" }),
        },
      );

      expect(sendResponse.status).toBe(200);
      expect(
        getQueuedThreadMessage(harness.db, createdQueuedMessage.id),
      ).toBeNull();
      const provisionCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.provision" &&
          command.environmentId === environment.id,
      );
      expect(provisionCommand.command.type).toBe("environment.provision");
      const requestedEvent = harness.db
        .select({ data: events.data })
        .from(events)
        .where(eq(events.threadId, thread.id))
        .orderBy(events.sequence)
        .all()
        .find((event) => {
          const parsed = JSON.parse(event.data) as {
            execution?: { model?: string; serviceTier?: string };
          };
          return parsed.execution?.model === "gpt-5";
        });
      expect(requestedEvent).toBeTruthy();
      expect(
        requestedEvent ? JSON.parse(requestedEvent.data) : null,
      ).toMatchObject({
        execution: {
          model: "gpt-5",
          serviceTier: "default",
        },
      });
      expect(
        harness.db
          .select({ id: events.id })
          .from(events)
          .where(
            and(
              eq(events.threadId, thread.id),
              eq(events.type, "client/turn/requested"),
            ),
          )
          .all(),
      ).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps queued messages when send is attempted while a created thread is still starting", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-queued-message-created-thread-send",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/queued-message-created-thread-send",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/queued-message-created-thread-send",
      });

      const createThreadResponse = await harness.app.request(
        "/api/v1/threads",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            origin: "app",
            projectId: project.id,
            providerId: "codex",
            model: "gpt-5",
            input: [{ type: "text", text: "Initial start request" }],
            environment: {
              type: "reuse",
              environmentId: environment.id,
            },
          }),
        },
      );

      expect(createThreadResponse.status).toBe(201);
      const createdThread = threadSchema.parse(
        await readJson(createThreadResponse),
      );
      expect(createdThread.status).toBe("provisioning");

      const createQueuedThreadMessageResponse = await harness.app.request(
        `/api/v1/threads/${createdThread.id}/queued-messages`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            input: [
              {
                type: "text",
                text: "Queued message follow-up while starting",
              },
            ],
          }),
        },
      );
      expect(createQueuedThreadMessageResponse.status).toBe(201);
      const createdQueuedMessage = queuedMessageIdResponseSchema.parse(
        await readJson(createQueuedThreadMessageResponse),
      );

      const sendResponse = await harness.app.request(
        `/api/v1/threads/${createdThread.id}/queued-messages/${createdQueuedMessage.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ mode: "auto" }),
        },
      );

      expect(sendResponse.status).toBe(409);
      await expect(readJson(sendResponse)).resolves.toMatchObject({
        code: "invalid_request",
        message: "Thread is still starting",
      });
      expect(
        getQueuedThreadMessage(harness.db, createdQueuedMessage.id),
      ).toMatchObject({
        id: createdQueuedMessage.id,
      });
      const requestedEvents = harness.db
        .select({ type: events.type })
        .from(events)
        .where(eq(events.threadId, createdThread.id))
        .all()
        .filter((event) => event.type === "client/turn/requested");
      expect(requestedEvents).toHaveLength(1);
      expect(
        harness.db
          .select({ id: queuedThreadMessages.id })
          .from(queuedThreadMessages)
          .where(eq(queuedThreadMessages.threadId, createdThread.id))
          .all(),
      ).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("lists thread storage files via host.list_files", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-source",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/project-source",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        type: "manager",
      });
      const threadStoragePath = `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}`;

      const filesPromise = harness.app.request(
        `/api/v1/threads/${thread.id}/thread-storage/files?query=notes`,
      );
      const filesCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.list_files" &&
          command.path === threadStoragePath,
      );
      expect(filesCommand.command).toMatchObject({
        path: threadStoragePath,
        query: "notes",
        limit: 1000,
      });
      await reportQueuedCommandSuccess(harness, filesCommand, {
        files: [
          { path: "notes/plan.md", name: "plan.md" },
          { path: "notes/todo.md", name: "todo.md" },
        ],
        truncated: false,
      });
      const filesResponse = await filesPromise;
      expect(filesResponse.status).toBe(200);
      await expect(readJson(filesResponse)).resolves.toEqual({
        files: [
          { path: "notes/plan.md", name: "plan.md" },
          { path: "notes/todo.md", name: "todo.md" },
        ],
        truncated: false,
        storageRootPath: threadStoragePath,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("lists thread storage paths via host.list_paths", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-source",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/project-source",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        type: "manager",
      });
      const threadStoragePath = `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}`;

      const pathsPromise = harness.app.request(
        `/api/v1/threads/${thread.id}/thread-storage/paths?query=notes&includeFiles=true&includeDirectories=true`,
      );
      const pathsCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.list_paths" &&
          command.path === threadStoragePath,
      );
      expect(pathsCommand.command).toMatchObject({
        path: threadStoragePath,
        query: "notes",
        limit: 1000,
        includeFiles: true,
        includeDirectories: true,
      });
      await reportQueuedCommandSuccess(harness, pathsCommand, {
        paths: [
          {
            kind: "directory",
            path: "notes",
            name: "notes",
            score: 100,
            positions: [0, 1, 2, 3, 4],
          },
          {
            kind: "file",
            path: "notes/plan.md",
            name: "plan.md",
            score: 75,
            positions: [0, 1, 2, 3, 4],
          },
        ],
        truncated: false,
      });
      const pathsResponse = await pathsPromise;
      expect(pathsResponse.status).toBe(200);
      await expect(readJson(pathsResponse)).resolves.toEqual({
        paths: [
          {
            kind: "directory",
            path: "notes",
            name: "notes",
            score: 100,
            positions: [0, 1, 2, 3, 4],
          },
          {
            kind: "file",
            path: "notes/plan.md",
            name: "plan.md",
            score: 75,
            positions: [0, 1, 2, 3, 4],
          },
        ],
        truncated: false,
        storageRootPath: threadStoragePath,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("lists thread storage files for standard threads with environments", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-source",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/project-source",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        type: "standard",
      });
      const threadStoragePath = `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}`;

      const filesPromise = harness.app.request(
        `/api/v1/threads/${thread.id}/thread-storage/files`,
      );
      const filesCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.list_files" &&
          command.path === threadStoragePath,
      );
      await reportQueuedCommandSuccess(harness, filesCommand, {
        files: [{ path: "notes/plan.md", name: "plan.md" }],
        truncated: false,
      });

      const filesResponse = await filesPromise;
      expect(filesResponse.status).toBe(200);
      await expect(readJson(filesResponse)).resolves.toEqual({
        files: [{ path: "notes/plan.md", name: "plan.md" }],
        truncated: false,
        storageRootPath: threadStoragePath,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("lists thread storage files without requiring a ready environment", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-source",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/project-source",
        status: "provisioning",
      });
      harness.db
        .update(environments)
        .set({
          path: null,
          status: "provisioning",
          updatedAt: Date.now(),
        })
        .where(eq(environments.id, environment.id))
        .run();
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        type: "manager",
        status: "provisioning",
      });
      const threadStoragePath = `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}`;

      const filesPromise = harness.app.request(
        `/api/v1/threads/${thread.id}/thread-storage/files`,
      );
      const filesCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.list_files" &&
          command.path === threadStoragePath,
      );
      await reportQueuedCommandSuccess(harness, filesCommand, {
        files: [{ path: "notes/plan.md", name: "plan.md" }],
        truncated: false,
      });

      const filesResponse = await filesPromise;
      expect(filesResponse.status).toBe(200);
      await expect(readJson(filesResponse)).resolves.toEqual({
        files: [{ path: "notes/plan.md", name: "plan.md" }],
        truncated: false,
        storageRootPath: threadStoragePath,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("serves thread storage file content as raw bytes", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-source",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/project-source",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        type: "manager",
      });
      const pngBytes = Uint8Array.from([137, 80, 78, 71]);
      const threadStorageRoot = `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}`;
      const threadStorageFilePath = `${threadStorageRoot}/images/diagram.png`;

      const filePromise = harness.app.request(
        `/api/v1/threads/${thread.id}/thread-storage/content?path=${encodeURIComponent("images/diagram.png")}`,
      );
      const fileCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file" &&
          command.path === threadStorageFilePath,
      );
      expect(fileCommand.command).toMatchObject({
        path: threadStorageFilePath,
        rootPath: threadStorageRoot,
      });
      await reportQueuedCommandSuccess(harness, fileCommand, {
        path: threadStorageFilePath,
        content: Buffer.from(pngBytes).toString("base64"),
        contentEncoding: "base64",
        mimeType: "image/png",
        sizeBytes: pngBytes.byteLength,
      });
      const fileResponse = await filePromise;
      expect(fileResponse.status).toBe(200);
      expect(fileResponse.headers.get("content-type")).toBe("image/png");
      expect(fileResponse.headers.get("x-bb-content-encoding")).toBeNull();
      expect(fileResponse.headers.get("x-bb-size-bytes")).toBeNull();
      expect(new Uint8Array(await fileResponse.arrayBuffer())).toEqual(
        pngBytes,
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("serves STATUS/index.html and sibling assets from the unified status route", async () => {
    const harness = await createTestAppHarness();
    try {
      const fixture = seedManagerThreadStorage(harness);
      const statusRootPath = `${fixture.storageRootPath}/STATUS`;
      const statusHtml = `<img src="logo.png"><link rel="stylesheet" href="style.css">`;

      const statusPromise = harness.app.request(
        `/api/v1/threads/${fixture.threadId}/status/`,
      );
      const statusCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file_relative" &&
          command.rootPath === statusRootPath &&
          command.path === "index.html",
      );
      expect(statusCommand.command).toMatchObject({
        type: "host.read_file_relative",
        rootPath: statusRootPath,
        path: "index.html",
        dotfiles: "deny",
      });
      await reportQueuedCommandSuccess(harness, statusCommand, {
        path: "index.html",
        content: statusHtml,
        contentEncoding: "utf8",
        mimeType: "text/html",
        sizeBytes: Buffer.byteLength(statusHtml),
      });

      const statusResponse = await statusPromise;
      expect(statusResponse.status).toBe(200);
      expect(statusResponse.headers.get("content-type")).toBe("text/html");
      expect(statusResponse.headers.get("cache-control")).toBe("no-store");
      expect(statusResponse.headers.get("x-content-type-options")).toBe(
        "nosniff",
      );
      await expect(statusResponse.text()).resolves.toBe(statusHtml);

      const assetBytes = Uint8Array.from([137, 80, 78, 71]);
      const assetPromise = harness.app.request(
        `/api/v1/threads/${fixture.threadId}/status/logo.png`,
      );
      const assetCommand = await waitForQueuedCommandAfter(
        harness,
        statusCommand.row.cursor,
        ({ command }) =>
          command.type === "host.read_file_relative" &&
          command.rootPath === statusRootPath &&
          command.path === "logo.png",
      );
      expect(assetCommand.command).toMatchObject({
        type: "host.read_file_relative",
        rootPath: statusRootPath,
        path: "logo.png",
        dotfiles: "deny",
      });
      await reportQueuedCommandSuccess(harness, assetCommand, {
        path: "logo.png",
        content: Buffer.from(assetBytes).toString("base64"),
        contentEncoding: "base64",
        mimeType: "image/png",
        sizeBytes: assetBytes.byteLength,
      });

      const assetResponse = await assetPromise;
      expect(assetResponse.status).toBe(200);
      expect(assetResponse.headers.get("content-type")).toBe("image/png");
      expect(assetResponse.headers.get("cache-control")).toBe("no-store");
      expect(assetResponse.headers.get("x-content-type-options")).toBe(
        "nosniff",
      );
      expect(new Uint8Array(await assetResponse.arrayBuffer())).toEqual(
        assetBytes,
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("returns the resolved STATUS version across all source modes", async () => {
    const harness = await createTestAppHarness();
    try {
      const fixture = seedManagerThreadStorage(harness);
      const expectedVersions: ThreadStatusVersionResponse[] = [
        { source: "folder", hash: "folder-hash-1" },
        { source: "folder", hash: "folder-hash-2" },
        { source: "html", hash: "html-hash" },
        { source: "md", hash: "md-hash" },
        { source: "empty", hash: "empty-hash" },
      ];

      let previousCursor: number | null = null;
      for (const expectedVersion of expectedVersions) {
        const versionPromise = harness.app.request(
          `/api/v1/threads/${fixture.threadId}/status-version`,
        );
        const versionCommand: QueuedCommand =
          previousCursor === null
            ? await waitForQueuedCommand(
                harness,
                ({ command }) => command.type === "host.status_version",
              )
            : await waitForQueuedCommandAfter(
                harness,
                previousCursor,
                ({ command }) => command.type === "host.status_version",
              );

        expect(versionCommand.command).toMatchObject({
          type: "host.status_version",
          sources: [
            {
              source: "folder",
              rootPath: `${fixture.storageRootPath}/STATUS`,
              indexPath: "index.html",
              dotfiles: "deny",
            },
            {
              source: "html",
              rootPath: fixture.storageRootPath,
              path: "STATUS.html",
              dotfiles: "allow",
            },
            {
              source: "md",
              rootPath: fixture.storageRootPath,
              path: "STATUS.md",
              dotfiles: "allow",
            },
          ],
        });
        await reportQueuedCommandSuccess(
          harness,
          versionCommand,
          expectedVersion,
        );

        const versionResponse = await versionPromise;
        expect(versionResponse.status).toBe(200);
        expect(versionResponse.headers.get("cache-control")).toBe("no-store");
        expect(
          threadStatusVersionResponseSchema.parse(
            await readJson(versionResponse),
          ),
        ).toEqual(expectedVersion);
        previousCursor = versionCommand.row.cursor;
      }
    } finally {
      await harness.cleanup();
    }
  });

  it("falls back from a missing STATUS/index.html to STATUS.html", async () => {
    const harness = await createTestAppHarness();
    try {
      const fixture = seedManagerThreadStorage(harness);
      const statusRootPath = `${fixture.storageRootPath}/STATUS`;
      const statusHtml = "<h1>Single file status</h1>";

      const statusPromise = harness.app.request(
        `/api/v1/threads/${fixture.threadId}/status/`,
      );
      const indexCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file_relative" &&
          command.rootPath === statusRootPath &&
          command.path === "index.html",
      );
      await reportQueuedCommandError(harness, indexCommand, {
        errorCode: "ENOENT",
        errorMessage: "Path does not exist: index.html",
      });
      const htmlCommand = await waitForQueuedCommandAfter(
        harness,
        indexCommand.row.cursor,
        ({ command }) =>
          command.type === "host.read_file_relative" &&
          command.rootPath === fixture.storageRootPath &&
          command.path === "STATUS.html",
      );
      expect(htmlCommand.command).toMatchObject({
        type: "host.read_file_relative",
        rootPath: fixture.storageRootPath,
        path: "STATUS.html",
        dotfiles: "allow",
      });
      await reportQueuedCommandSuccess(harness, htmlCommand, {
        path: "STATUS.html",
        content: statusHtml,
        contentEncoding: "utf8",
        mimeType: "text/html",
        sizeBytes: Buffer.byteLength(statusHtml),
      });

      const statusResponse = await statusPromise;
      expect(statusResponse.status).toBe(200);
      expect(statusResponse.headers.get("cache-control")).toBe("no-store");
      expect(statusResponse.headers.get("x-content-type-options")).toBe(
        "nosniff",
      );
      await expect(statusResponse.text()).resolves.toBe(statusHtml);
    } finally {
      await harness.cleanup();
    }
  });

  it("falls back from an unreadable STATUS/index.html to STATUS.html", async () => {
    const harness = await createTestAppHarness();
    try {
      const fixture = seedManagerThreadStorage(harness);
      const statusRootPath = `${fixture.storageRootPath}/STATUS`;
      const statusHtml = "<h1>Readable single file status</h1>";

      const statusPromise = harness.app.request(
        `/api/v1/threads/${fixture.threadId}/status/`,
      );
      const indexCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file_relative" &&
          command.rootPath === statusRootPath &&
          command.path === "index.html",
      );
      await reportQueuedCommandError(harness, indexCommand, {
        errorCode: "EACCES",
        errorMessage: "Permission denied: index.html",
      });
      const htmlCommand = await waitForQueuedCommandAfter(
        harness,
        indexCommand.row.cursor,
        ({ command }) =>
          command.type === "host.read_file_relative" &&
          command.rootPath === fixture.storageRootPath &&
          command.path === "STATUS.html",
      );
      await reportQueuedCommandSuccess(harness, htmlCommand, {
        path: "STATUS.html",
        content: statusHtml,
        contentEncoding: "utf8",
        mimeType: "text/html",
        sizeBytes: Buffer.byteLength(statusHtml),
      });

      const statusResponse = await statusPromise;
      expect(statusResponse.status).toBe(200);
      expect(statusResponse.headers.get("x-content-type-options")).toBe(
        "nosniff",
      );
      await expect(statusResponse.text()).resolves.toBe(statusHtml);
    } finally {
      await harness.cleanup();
    }
  });

  it("renders STATUS.md server-side when folder and html status sources are missing", async () => {
    const harness = await createTestAppHarness();
    try {
      const fixture = seedManagerThreadStorage(harness);
      const markdown = "# Markdown status\n\n- ready";

      const statusPromise = harness.app.request(
        `/api/v1/threads/${fixture.threadId}/status/`,
      );
      const indexCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file_relative" &&
          command.rootPath === `${fixture.storageRootPath}/STATUS` &&
          command.path === "index.html",
      );
      await reportQueuedCommandError(harness, indexCommand, {
        errorCode: "ENOENT",
        errorMessage: "Path does not exist: index.html",
      });
      const htmlCommand = await waitForQueuedCommandAfter(
        harness,
        indexCommand.row.cursor,
        ({ command }) =>
          command.type === "host.read_file_relative" &&
          command.rootPath === fixture.storageRootPath &&
          command.path === "STATUS.html",
      );
      await reportQueuedCommandError(harness, htmlCommand, {
        errorCode: "ENOENT",
        errorMessage: "Path does not exist: STATUS.html",
      });
      const markdownCommand = await waitForQueuedCommandAfter(
        harness,
        htmlCommand.row.cursor,
        ({ command }) =>
          command.type === "host.read_file_relative" &&
          command.rootPath === fixture.storageRootPath &&
          command.path === "STATUS.md",
      );
      expect(markdownCommand.command).toMatchObject({
        type: "host.read_file_relative",
        rootPath: fixture.storageRootPath,
        path: "STATUS.md",
        dotfiles: "allow",
      });
      await reportQueuedCommandSuccess(harness, markdownCommand, {
        path: "STATUS.md",
        content: markdown,
        contentEncoding: "utf8",
        mimeType: "text/markdown",
        sizeBytes: Buffer.byteLength(markdown),
      });

      const statusResponse = await statusPromise;
      expect(statusResponse.status).toBe(200);
      expect(statusResponse.headers.get("content-type")).toBe(
        "text/html; charset=utf-8",
      );
      expect(statusResponse.headers.get("cache-control")).toBe("no-store");
      expect(statusResponse.headers.get("x-content-type-options")).toBe(
        "nosniff",
      );
      const body = await statusResponse.text();
      expect(body).toContain("<h1>Markdown status</h1>");
      expect(body).toContain("<li>ready</li>");
    } finally {
      await harness.cleanup();
    }
  });

  it("returns an empty status page when no status source exists", async () => {
    const harness = await createTestAppHarness();
    try {
      const fixture = seedManagerThreadStorage(harness);

      const statusPromise = harness.app.request(
        `/api/v1/threads/${fixture.threadId}/status/`,
      );
      const indexCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file_relative" &&
          command.rootPath === `${fixture.storageRootPath}/STATUS` &&
          command.path === "index.html",
      );
      await reportQueuedCommandError(harness, indexCommand, {
        errorCode: "ENOENT",
        errorMessage: "Path does not exist: index.html",
      });
      const htmlCommand = await waitForQueuedCommandAfter(
        harness,
        indexCommand.row.cursor,
        ({ command }) =>
          command.type === "host.read_file_relative" &&
          command.rootPath === fixture.storageRootPath &&
          command.path === "STATUS.html",
      );
      await reportQueuedCommandError(harness, htmlCommand, {
        errorCode: "ENOENT",
        errorMessage: "Path does not exist: STATUS.html",
      });
      const markdownCommand = await waitForQueuedCommandAfter(
        harness,
        htmlCommand.row.cursor,
        ({ command }) =>
          command.type === "host.read_file_relative" &&
          command.rootPath === fixture.storageRootPath &&
          command.path === "STATUS.md",
      );
      await reportQueuedCommandError(harness, markdownCommand, {
        errorCode: "ENOENT",
        errorMessage: "Path does not exist: STATUS.md",
      });

      const statusResponse = await statusPromise;
      expect(statusResponse.status).toBe(200);
      expect(statusResponse.headers.get("content-type")).toBe(
        "text/html; charset=utf-8",
      );
      expect(statusResponse.headers.get("cache-control")).toBe("no-store");
      expect(statusResponse.headers.get("x-content-type-options")).toBe(
        "nosniff",
      );
      expect(await statusResponse.text()).toContain("No manager status yet");
    } finally {
      await harness.cleanup();
    }
  });

  it("serves subdirectory index files under STATUS when requested with a trailing slash", async () => {
    const harness = await createTestAppHarness();
    try {
      const fixture = seedManagerThreadStorage(harness);
      const body = "<p>Nested status</p>";

      const nestedPromise = harness.app.request(
        `/api/v1/threads/${fixture.threadId}/status/widgets/`,
      );
      const nestedCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file_relative" &&
          command.rootPath === `${fixture.storageRootPath}/STATUS` &&
          command.path === "widgets/index.html",
      );
      await reportQueuedCommandSuccess(harness, nestedCommand, {
        path: "widgets/index.html",
        content: body,
        contentEncoding: "utf8",
        mimeType: "text/html",
        sizeBytes: Buffer.byteLength(body),
      });

      const nestedResponse = await nestedPromise;
      expect(nestedResponse.status).toBe(200);
      expect(nestedResponse.headers.get("cache-control")).toBe("no-store");
      expect(nestedResponse.headers.get("x-content-type-options")).toBe(
        "nosniff",
      );
      await expect(nestedResponse.text()).resolves.toBe(body);
    } finally {
      await harness.cleanup();
    }
  });

  it("blocks dotfiles and invalid STATUS asset paths before reading", async () => {
    const harness = await createTestAppHarness();
    try {
      const fixture = seedManagerThreadStorage(harness);

      const dotfileResponse = await harness.app.request(
        `/api/v1/threads/${fixture.threadId}/status/assets/.env`,
      );
      expect(dotfileResponse.status).toBe(404);
      await expect(readJson(dotfileResponse)).resolves.toMatchObject({
        code: "ENOENT",
      });

      const normalizedTraversalResponse = await harness.app.request(
        `/api/v1/threads/${fixture.threadId}/status/%2e%2e/secrets.txt`,
      );
      expect(normalizedTraversalResponse.status).toBe(404);

      const encodedTraversalResponse = await harness.app.request(
        `/api/v1/threads/${fixture.threadId}/status/%2e%2e%2fsecrets.txt`,
      );
      expect(encodedTraversalResponse.status).toBe(400);
      await expect(readJson(encodedTraversalResponse)).resolves.toMatchObject({
        code: "invalid_path",
      });

      const invalidPathResponse = await harness.app.request(
        `/api/v1/threads/${fixture.threadId}/status/assets%5Csecrets.txt`,
      );
      expect(invalidPathResponse.status).toBe(400);
      await expect(readJson(invalidPathResponse)).resolves.toMatchObject({
        code: "invalid_path",
      });
      expect(harness.db.select().from(hostDaemonCommands).all()).toHaveLength(
        0,
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("returns 404 for missing STATUS assets without falling back to root status sources", async () => {
    const harness = await createTestAppHarness();
    try {
      const fixture = seedManagerThreadStorage(harness);

      const assetPromise = harness.app.request(
        `/api/v1/threads/${fixture.threadId}/status/missing.png`,
      );
      const assetCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file_relative" &&
          command.rootPath === `${fixture.storageRootPath}/STATUS` &&
          command.path === "missing.png",
      );
      await reportQueuedCommandError(harness, assetCommand, {
        errorCode: "ENOENT",
        errorMessage: "Path does not exist: missing.png",
      });

      const assetResponse = await assetPromise;
      expect(assetResponse.status).toBe(404);
      await expect(readJson(assetResponse)).resolves.toEqual({
        code: "ENOENT",
        message: "Path does not exist: missing.png",
        retryable: false,
      });
      expect(harness.db.select().from(hostDaemonCommands).all()).toHaveLength(
        1,
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("maps STATUS asset symlink escapes to invalid_path", async () => {
    const harness = await createTestAppHarness();
    try {
      const fixture = seedManagerThreadStorage(harness);

      const assetPromise = harness.app.request(
        `/api/v1/threads/${fixture.threadId}/status/assets/secrets.txt`,
      );
      const assetCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file_relative" &&
          command.rootPath === `${fixture.storageRootPath}/STATUS` &&
          command.path === "assets/secrets.txt",
      );
      await reportQueuedCommandError(harness, assetCommand, {
        errorCode: "invalid_path",
        errorMessage: "Path escapes read root",
      });

      const assetResponse = await assetPromise;
      expect(assetResponse.status).toBe(400);
      await expect(readJson(assetResponse)).resolves.toEqual({
        code: "invalid_path",
        message: "Path escapes read root",
        retryable: false,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("serves host file content from the thread environment host without requiring a ready environment", async () => {
    const harness = await createTestAppHarness();
    try {
      seedHostSession(harness.deps, { id: "host-other" });
      const { host } = seedHostSession(harness.deps, {
        id: "host-thread-environment",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-source",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/project-source",
        status: "provisioning",
      });
      harness.db
        .update(environments)
        .set({
          path: null,
          status: "provisioning",
          updatedAt: Date.now(),
        })
        .where(eq(environments.id, environment.id))
        .run();
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const hostFilePath = "/Users/me/notes/plan.md";
      const fileBytes = new TextEncoder().encode("# Plan\n");

      const filePromise = harness.app.request(
        `/api/v1/threads/${thread.id}/host-files/content?path=${encodeURIComponent(hostFilePath)}`,
      );
      const fileCommand = await waitForQueuedCommand(
        harness,
        ({ command, row }) =>
          row.hostId === host.id &&
          command.type === "host.read_file" &&
          command.path === hostFilePath,
      );
      expect(fileCommand.command).toEqual({
        type: "host.read_file",
        path: hostFilePath,
      });
      await reportQueuedCommandSuccess(
        harness,
        fileCommand,
        {
          path: hostFilePath,
          content: "# Plan\n",
          contentEncoding: "utf8",
          mimeType: "text/markdown",
          sizeBytes: fileBytes.byteLength,
        },
        { hostId: host.id },
      );
      const fileResponse = await filePromise;
      expect(fileResponse.status).toBe(200);
      expect(fileResponse.headers.get("content-type")).toBe("text/markdown");
      expect(new Uint8Array(await fileResponse.arrayBuffer())).toEqual(
        fileBytes,
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects host file content requests for threads without environments", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: null,
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/host-files/content?path=${encodeURIComponent("/Users/me/notes/plan.md")}`,
      );

      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toEqual({
        code: "invalid_request",
        message: "Thread has no environment",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it.each([
    {
      errorCode: "invalid_path",
      errorMessage: "Path is a directory, not a file",
      expectedStatus: 400,
    },
    {
      errorCode: "ENOENT",
      errorMessage: "Path does not exist",
      expectedStatus: 404,
    },
    {
      errorCode: "file_too_large",
      errorMessage: "File exceeds limit",
      expectedStatus: 413,
    },
  ])(
    "maps host file $errorCode errors to user-facing responses",
    async ({ errorCode, errorMessage, expectedStatus }) => {
      const harness = await createTestAppHarness();
      try {
        const { host } = seedHostSession(harness.deps);
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
        const hostFilePath = "/Users/me/notes/plan.md";

        const filePromise = harness.app.request(
          `/api/v1/threads/${thread.id}/host-files/content?path=${encodeURIComponent(hostFilePath)}`,
        );
        const fileCommand = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "host.read_file" && command.path === hostFilePath,
        );
        const fileErrorResponse = await reportQueuedCommandError(
          harness,
          fileCommand,
          {
            errorCode,
            errorMessage,
          },
        );
        expect(fileErrorResponse.status).toBe(200);

        const fileResponse = await filePromise;
        expect(fileResponse.status).toBe(expectedStatus);
        await expect(readJson(fileResponse)).resolves.toEqual({
          code: errorCode,
          message: errorMessage,
          retryable: false,
        });
      } finally {
        await harness.cleanup();
      }
    },
  );

  it("maps thread storage root-escape failures to invalid_path", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
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
        type: "manager",
      });
      const threadStorageRoot = `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}`;

      const filePromise = harness.app.request(
        `/api/v1/threads/${thread.id}/thread-storage/content?path=${encodeURIComponent("notes/secrets")}`,
      );
      const fileCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file" &&
          command.path === `${threadStorageRoot}/notes/secrets`,
      );
      expect(fileCommand.command).toMatchObject({
        path: `${threadStorageRoot}/notes/secrets`,
        rootPath: threadStorageRoot,
      });
      const fileErrorResponse = await reportQueuedCommandError(
        harness,
        fileCommand,
        {
          errorCode: "invalid_path",
          errorMessage: "Path escapes read root",
        },
      );
      expect(fileErrorResponse.status).toBe(200);

      const fileResponse = await filePromise;
      expect(fileResponse.status).toBe(400);
      await expect(readJson(fileResponse)).resolves.toEqual({
        code: "invalid_path",
        message: "Path escapes read root",
        retryable: false,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("returns an empty thread storage file list when the durable storage is absent", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
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
        type: "manager",
      });
      const threadStoragePath = `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}`;

      const filesPromise = harness.app.request(
        `/api/v1/threads/${thread.id}/thread-storage/files`,
      );
      const filesCommand = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "host.list_files",
      );
      const filesErrorResponse = await reportQueuedCommandError(
        harness,
        filesCommand,
        {
          errorCode: "ENOENT",
          errorMessage: "Path does not exist",
        },
      );
      expect(filesErrorResponse.status).toBe(200);

      const filesResponse = await filesPromise;
      expect(filesResponse.status).toBe(200);
      await expect(readJson(filesResponse)).resolves.toEqual({
        files: [],
        truncated: false,
        storageRootPath: threadStoragePath,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("maps thread storage file read failures to user-facing 4xx responses", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
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
        type: "manager",
      });

      const filePromise = harness.app.request(
        `/api/v1/threads/${thread.id}/thread-storage/content?path=${encodeURIComponent("notes/missing.txt")}`,
      );
      const fileCommand = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "host.read_file",
      );
      const fileErrorResponse = await reportQueuedCommandError(
        harness,
        fileCommand,
        {
          errorCode: "file_too_large",
          errorMessage: "File exceeds limit",
        },
      );
      expect(fileErrorResponse.status).toBe(200);

      const fileResponse = await filePromise;
      expect(fileResponse.status).toBe(413);
      await expect(readJson(fileResponse)).resolves.toEqual({
        code: "file_too_large",
        message: "File exceeds limit",
        retryable: false,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("fails loudly when stored queued message content is malformed", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
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
      const now = Date.now();
      const queuedMessageId = createQueuedThreadMessageId();
      const queuedMessage = harness.db
        .insert(queuedThreadMessages)
        .values({
          id: queuedMessageId,
          threadId: thread.id,
          content: "not-json",
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          claimedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages/${queuedMessage.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ mode: "auto" }),
        },
      );

      expect(response.status).toBe(500);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "internal_error",
        message: expect.stringContaining(`queued message ${queuedMessage.id}`),
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("returns existing matching event immediately from /events/wait", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
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
        sequence: 1,
        type: "system/manager/user_message",
        scope: threadScope(),
        data: { text: "A manager note" },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        sequence: 2,
        type: "item/completed",
        data: { item: { type: "agentMessage", id: "msg-1", text: "Reply" } },
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/events/wait?type=item/completed&waitMs=1000`,
      );
      expect(response.status).toBe(200);
      const body = threadEventWaitResponseSchema.parse(
        await readJson(response),
      );
      expect(body.type).toBe("item/completed");
      expect(body.seq).toBe(2);
    } finally {
      await harness.cleanup();
    }
  });

  it("returns 204 on timeout when no matching event exists", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
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
        sequence: 1,
        type: "system/manager/user_message",
        scope: threadScope(),
        data: { text: "Unrelated event" },
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/events/wait?type=item/completed&waitMs=100`,
      );
      expect(response.status).toBe(204);
    } finally {
      await harness.cleanup();
    }
  });

  it("respects afterSeq when waiting for events", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
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
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        sequence: 5,
        type: "item/completed",
        data: { item: { type: "agentMessage", id: "msg-1", text: "Reply" } },
      });

      // afterSeq=5 means "after sequence 5" — the match at seq 5 should NOT be returned
      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/events/wait?type=item/completed&afterSeq=5&waitMs=100`,
      );
      expect(response.status).toBe(204);
    } finally {
      await harness.cleanup();
    }
  });

  it("returns 404 for nonexistent thread on /events/wait", async () => {
    const harness = await createTestAppHarness();
    try {
      const response = await harness.app.request(
        `/api/v1/threads/nonexistent-thread-id/events/wait?type=item/completed&waitMs=100`,
      );
      expect(response.status).toBe(404);
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects invalid event types on /events/wait", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
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
        `/api/v1/threads/${thread.id}/events/wait?type=not-a-real-event&waitMs=100`,
      );
      expect(response.status).toBe(400);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
        message: "Invalid event type",
      });
    } finally {
      await harness.cleanup();
    }
  });
});

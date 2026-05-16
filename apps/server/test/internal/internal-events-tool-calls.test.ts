import { eq } from "drizzle-orm";
import { events, getHost, openSession, threads, upsertHost } from "@bb/db";
import { turnScope } from "@bb/domain";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  type HostDaemonEventEnvelope,
} from "@bb/host-daemon-contract";
import { describe, expect, it, vi } from "vitest";
import { internalAuthHeaders } from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEvent,
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import type { TestAppHarness } from "../helpers/test-app.js";

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
      events: args.events,
    }),
  });
}

describe("internal event and tool-call routes", () => {
  it("appends event batches and returns accepted producer events", async () => {
    const harness = await createTestAppHarness();
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
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            producerEventId: "hdevt_23456789abcdefghijkm",
            threadId: thread.id,
            event: {
              type: "turn/started",
              threadId: thread.id,
              providerThreadId: "provider-1",
              scope: turnScope("turn-1"),
            },
          },
          {
            producerEventId: "hdevt_23456789abcdefghijkn",
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
            producerEventId: "hdevt_23456789abcdefghijkm",
            threadId: thread.id,
            sequence: 1,
          },
          {
            producerEventId: "hdevt_23456789abcdefghijkn",
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
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects daemon turn-scoped events before turn/started is stored", async () => {
    const harness = await createTestAppHarness();
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
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            producerEventId: "hdevt_23456789abcdefghijkz",
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
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects producer event id reuse with a different payload", async () => {
    const harness = await createTestAppHarness();
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
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      const firstEvent: HostDaemonEventEnvelope = {
        producerEventId: "hdevt_23456789abcdefghijkp",
        threadId: thread.id,
        event: {
          type: "turn/started",
          threadId: thread.id,
          providerThreadId: "provider-1",
          scope: turnScope("turn-1"),
        },
      };
      const firstResponse = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [firstEvent],
      });
      expect(firstResponse.status).toBe(200);

      const conflictResponse = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            ...firstEvent,
            event: {
              type: "turn/started",
              threadId: thread.id,
              providerThreadId: "provider-2",
              scope: turnScope("turn-1"),
            },
          },
        ],
      });

      expect(conflictResponse.status).toBe(409);
      await expect(readJson(conflictResponse)).resolves.toEqual({
        code: "producer_event_payload_mismatch",
        message: "Producer event id was reused with a different payload",
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

  it("transitions active threads back to idle for a started/completed event batch", async () => {
    const harness = await createTestAppHarness();
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
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            producerEventId: "hdevt_23456789abcdefghijkq",
            threadId: thread.id,
            event: {
              type: "turn/started",
              threadId: thread.id,
              providerThreadId: "provider-thread",
              scope: turnScope("turn-1"),
            },
          },
          {
            producerEventId: "hdevt_23456789abcdefghijkr",
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
    } finally {
      await harness.cleanup();
    }
  });

  it("marks ephemeral sandbox hosts active when they send event batches", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = upsertHost(harness.db, harness.hub, {
        id: "host-event-activity",
        name: "Event Activity Host",
        type: "ephemeral",
      });
      const session = openSession(harness.db, harness.hub, {
        heartbeatIntervalMs: 5_000,
        hostId: host.id,
        hostName: host.name,
        hostType: host.type,
        instanceId: "instance-event-activity",
        leaseTimeoutMs: 30_000,
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        dataDir: "/tmp/bb-test-data",
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

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness, {
          hostId: host.id,
          hostType: "ephemeral",
        }),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            {
              producerEventId: "hdevt_23456789abcdefghijks",
              threadId: thread.id,
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: "provider-event-activity",
                scope: turnScope("turn-event-activity"),
              },
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      expect(getHost(harness.db, host.id)?.lastActivityAt).toEqual(
        expect.any(Number),
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("does not reactivate a thread when a started/completed batch is replayed", async () => {
    const harness = await createTestAppHarness();
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
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      const eventBatch: HostDaemonEventEnvelope[] = [
        {
          producerEventId: "hdevt_23456789abcdefghijkt",
          threadId: thread.id,
          event: {
            type: "turn/started",
            threadId: thread.id,
            providerThreadId: "provider-thread",
            scope: turnScope("turn-1"),
          },
        },
        {
          producerEventId: "hdevt_23456789abcdefghijkv",
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
          .select()
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all(),
      ).toHaveLength(2);
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects unsupported tool calls", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = upsertHost(harness.db, harness.hub, {
        id: "host-tool-call-activity",
        name: "Tool Call Host",
        type: "ephemeral",
      });
      const session = openSession(harness.db, harness.hub, {
        heartbeatIntervalMs: 5_000,
        hostId: host.id,
        hostName: host.name,
        hostType: host.type,
        instanceId: "instance-tool-call-activity",
        leaseTimeoutMs: 30_000,
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        dataDir: "/tmp/bb-test-data",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const managerThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        type: "manager",
      });

      const response = await harness.app.request(
        "/internal/session/tool-call",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            threadId: managerThread.id,
            providerThreadId: "provider-manager-unsupported-tool",
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
      expect(getHost(harness.db, host.id)?.lastActivityAt).toEqual(
        expect.any(Number),
      );

      const childThreads = harness.db
        .select()
        .from(threads)
        .where(eq(threads.parentThreadId, managerThread.id))
        .all();
      expect(childThreads).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects message_user tool calls before the turn start is stored", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const managerThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        type: "manager",
      });

      const response = await harness.app.request(
        "/internal/session/tool-call",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            threadId: managerThread.id,
            providerThreadId: "provider-manager-missing-turn",
            turnId: "turn-missing",
            callId: "call-missing-turn",
            tool: "message_user",
            arguments: {
              text: "Need input from the user",
            },
          }),
        },
      );

      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
      });
      expect(
        harness.db
          .select()
          .from(events)
          .where(eq(events.threadId, managerThread.id))
          .all(),
      ).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects empty tool call turn ids at the internal contract boundary", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const managerThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        type: "manager",
      });

      const response = await harness.app.request(
        "/internal/session/tool-call",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            threadId: managerThread.id,
            providerThreadId: "provider-manager-empty-turn",
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
          .where(eq(events.threadId, managerThread.id))
          .all(),
      ).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("accepts message_user tool calls after the turn start is stored", async () => {
    const harness = await createTestAppHarness();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const { host, session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const managerThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        type: "manager",
      });
      seedEvent(harness.deps, {
        threadId: managerThread.id,
        environmentId: environment.id,
        providerThreadId: "provider-manager-message-user",
        sequence: 1,
        type: "turn/started",
        scope: turnScope("turn-2"),
        data: {
          providerThreadId: "provider-manager-message-user",
        },
      });

      vi.setSystemTime(2_000);
      const response = await harness.app.request(
        "/internal/session/tool-call",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            threadId: managerThread.id,
            providerThreadId: "provider-manager-message-user",
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
      const storedEvents = harness.db
        .select()
        .from(events)
        .where(eq(events.threadId, managerThread.id))
        .orderBy(events.sequence)
        .all();
      expect(storedEvents).toHaveLength(2);
      expect(storedEvents[1]?.type).toBe("system/manager/user_message");
      const updatedManagerThread = harness.db
        .select()
        .from(threads)
        .where(eq(threads.id, managerThread.id))
        .get();
      expect(updatedManagerThread?.lastReadAt).toBe(1_000);
      expect(updatedManagerThread?.latestAttentionAt).toBe(2_000);
    } finally {
      vi.useRealTimers();
      await harness.cleanup();
    }
  });
});

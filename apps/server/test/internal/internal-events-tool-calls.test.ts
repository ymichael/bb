import { eq } from "drizzle-orm";
import {
  createEventId,
  events,
  getHost,
  openSession,
  threads,
  upsertHost,
} from "@bb/db";
import { threadScope, turnScope } from "@bb/domain";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { internalAuthHeaders } from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";

describe("internal event and tool-call routes", () => {
  it("deduplicates events by thread and sequence and returns high-water marks", async () => {
    const harness = await createTestAppHarness();
    try {
      const firstCreatedAt = 1_700_000_000_000;
      const duplicateCreatedAt = firstCreatedAt + 50;
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
        status: "active",
      });

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            {
              environmentId: environment.id,
              threadId: thread.id,
              sequence: 1,
              createdAt: firstCreatedAt,
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: "provider-1",
                turnId: "turn-1",
                scope: turnScope("turn-1"),
              },
            },
            {
              environmentId: environment.id,
              threadId: thread.id,
              sequence: 1,
              createdAt: duplicateCreatedAt,
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: "provider-1",
                turnId: "turn-1",
                scope: turnScope("turn-1"),
              },
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        threadHighWaterMarks: {
          [thread.id]: 1,
        },
      });
      const storedEvents = harness.db.select().from(events).all();
      expect(storedEvents).toHaveLength(1);
      expect(storedEvents[0]?.createdAt).toBe(firstCreatedAt);
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects mismatched duplicate event keys inside one batch", async () => {
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
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            {
              environmentId: environment.id,
              threadId: thread.id,
              sequence: 1,
              createdAt: Date.now(),
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: "provider-1",
                turnId: "turn-1",
                scope: turnScope("turn-1"),
              },
            },
            {
              environmentId: environment.id,
              threadId: thread.id,
              sequence: 1,
              createdAt: Date.now(),
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: "provider-2",
                turnId: "turn-1",
                scope: turnScope("turn-1"),
              },
            },
          ],
        }),
      });

      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toEqual({
        acceptedSequences: [],
        code: "sequence_conflict",
        threadHighWaterMarks: {},
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

  it("accepts duplicate event data with different JSON key order", async () => {
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
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread",
        sequence: 1,
        type: "turn/input/accepted",
        scope: turnScope("turn-1"),
        data: {
          clientRequestSequence: 42,
          providerThreadId: "provider-thread",
        },
      });

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            {
              environmentId: environment.id,
              threadId: thread.id,
              sequence: 1,
              createdAt: Date.now(),
              event: {
                type: "turn/input/accepted",
                threadId: thread.id,
                providerThreadId: "provider-thread",
                turnId: "turn-1",
                scope: turnScope("turn-1"),
                clientRequestSequence: 42,
              },
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        threadHighWaterMarks: {
          [thread.id]: 1,
        },
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

  it("fails loudly when duplicate comparison finds corrupt stored event JSON", async () => {
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
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      harness.db
        .insert(events)
        .values({
          id: createEventId(),
          threadId: thread.id,
          environmentId: environment.id,
          scopeKind: "turn",
          turnId: "turn-1",
          providerThreadId: "provider-thread",
          sequence: 1,
          type: "turn/input/accepted",
          itemId: null,
          itemKind: null,
          data: "{not-json",
          createdAt: Date.now(),
        })
        .run();

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            {
              environmentId: environment.id,
              threadId: thread.id,
              sequence: 1,
              createdAt: Date.now(),
              event: {
                type: "turn/input/accepted",
                threadId: thread.id,
                providerThreadId: "provider-thread",
                turnId: "turn-1",
                scope: turnScope("turn-1"),
                clientRequestSequence: 42,
              },
            },
          ],
        }),
      });

      expect(response.status).toBe(500);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "internal_error",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects non-identical sequence collisions without partially inserting the batch", async () => {
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
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          source: "tell",
          initiator: "user",
          input: [{ type: "text", text: "Run the task" }],
          target: { kind: "new-turn" },
          request: { method: "turn/start", params: {} },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/turn/requested",
          },
        },
      });

      const conflictedResponse = await harness.app.request(
        "/internal/session/events",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            events: [
              {
                environmentId: environment.id,
                threadId: thread.id,
                sequence: 1,
                createdAt: Date.now(),
                event: {
                  type: "turn/started",
                  threadId: thread.id,
                  providerThreadId: "provider-thread",
                  turnId: "turn-1",
                  scope: turnScope("turn-1"),
                },
              },
              {
                environmentId: environment.id,
                threadId: thread.id,
                sequence: 2,
                createdAt: Date.now(),
                event: {
                  type: "turn/input/accepted",
                  threadId: thread.id,
                  providerThreadId: "provider-thread",
                  turnId: "turn-1",
                  scope: turnScope("turn-1"),
                  clientRequestSequence: 1,
                },
              },
            ],
          }),
        },
      );

      expect(conflictedResponse.status).toBe(409);
      await expect(readJson(conflictedResponse)).resolves.toEqual({
        acceptedSequences: [],
        code: "sequence_conflict",
        threadHighWaterMarks: {
          [thread.id]: 1,
        },
      });
      expect(
        harness.db
          .select()
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all()
          .map((event) => event.type),
      ).toEqual(["client/turn/requested"]);

      const retryResponse = await harness.app.request(
        "/internal/session/events",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            events: [
              {
                environmentId: environment.id,
                threadId: thread.id,
                sequence: 2,
                createdAt: Date.now(),
                event: {
                  type: "turn/started",
                  threadId: thread.id,
                  providerThreadId: "provider-thread",
                  turnId: "turn-1",
                  scope: turnScope("turn-1"),
                },
              },
              {
                environmentId: environment.id,
                threadId: thread.id,
                sequence: 3,
                createdAt: Date.now(),
                event: {
                  type: "turn/input/accepted",
                  threadId: thread.id,
                  providerThreadId: "provider-thread",
                  turnId: "turn-1",
                  scope: turnScope("turn-1"),
                  clientRequestSequence: 1,
                },
              },
            ],
          }),
        },
      );

      expect(retryResponse.status).toBe(200);
      expect(
        harness.db
          .select()
          .from(events)
          .where(eq(events.threadId, thread.id))
          .orderBy(events.sequence)
          .all()
          .map((event) => event.type),
      ).toEqual([
        "client/turn/requested",
        "turn/started",
        "turn/input/accepted",
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it("transitions active threads back to idle for a started/completed event batch", async () => {
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
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            {
              environmentId: environment.id,
              threadId: thread.id,
              sequence: 1,
              createdAt: Date.now(),
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: "provider-thread",
                turnId: "turn-1",
                scope: turnScope("turn-1"),
              },
            },
            {
              environmentId: environment.id,
              threadId: thread.id,
              sequence: 2,
              createdAt: Date.now(),
              event: {
                type: "turn/completed",
                threadId: thread.id,
                providerThreadId: "provider-thread",
                turnId: "turn-1",
                scope: turnScope("turn-1"),
                status: "completed",
              },
            },
          ],
        }),
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
              environmentId: environment.id,
              threadId: thread.id,
              sequence: 1,
              createdAt: Date.now(),
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: "provider-event-activity",
                turnId: "turn-event-activity",
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

  it("reports accepted duplicate events when a later event in the batch collides", async () => {
    const harness = await createTestAppHarness();
    try {
      const createdAt = 1_700_000_000_000;
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
        status: "active",
      });

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread",
        sequence: 1,
        type: "turn/started",
        scope: turnScope("turn-1"),
        data: {
          providerThreadId: "provider-thread",
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
          source: "tell",
          initiator: "user",
          input: [{ type: "text", text: "Run the task" }],
          target: { kind: "new-turn" },
          request: { method: "turn/start", params: {} },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/turn/requested",
          },
        },
      });

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            {
              environmentId: environment.id,
              threadId: thread.id,
              sequence: 1,
              createdAt,
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: "provider-thread",
                turnId: "turn-1",
                scope: turnScope("turn-1"),
              },
            },
            {
              environmentId: environment.id,
              threadId: thread.id,
              sequence: 2,
              createdAt,
              event: {
                type: "turn/input/accepted",
                threadId: thread.id,
                providerThreadId: "provider-thread",
                turnId: "turn-1",
                scope: turnScope("turn-1"),
                clientRequestSequence: 2,
              },
            },
          ],
        }),
      });

      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toEqual({
        acceptedSequences: [
          {
            sequence: 1,
            threadId: thread.id,
          },
        ],
        code: "sequence_conflict",
        threadHighWaterMarks: {
          [thread.id]: 2,
        },
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

  it("does not reactivate a thread when a started/completed batch is replayed", async () => {
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
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      const requestBody = JSON.stringify({
        sessionId: session.id,
        events: [
          {
            environmentId: environment.id,
            threadId: thread.id,
            sequence: 1,
            createdAt: Date.now(),
            event: {
              type: "turn/started",
              threadId: thread.id,
              providerThreadId: "provider-thread",
              turnId: "turn-1",
              scope: turnScope("turn-1"),
            },
          },
          {
            environmentId: environment.id,
            threadId: thread.id,
            sequence: 2,
            createdAt: Date.now(),
            event: {
              type: "turn/completed",
              threadId: thread.id,
              providerThreadId: "provider-thread",
              turnId: "turn-1",
              scope: turnScope("turn-1"),
              status: "completed",
            },
          },
        ],
      });

      const firstResponse = await harness.app.request(
        "/internal/session/events",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: requestBody,
        },
      );
      expect(firstResponse.status).toBe(200);

      const duplicateResponse = await harness.app.request(
        "/internal/session/events",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: requestBody,
        },
      );
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

  it("accepts message_user tool calls and appends a manager message event", async () => {
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
      const storedEvents = harness.db.select().from(events).all();
      expect(storedEvents).toHaveLength(1);
      expect(storedEvents[0]?.type).toBe("system/manager/user_message");
    } finally {
      await harness.cleanup();
    }
  });
});

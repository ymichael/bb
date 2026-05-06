import { eq } from "drizzle-orm";
import { events, getHost, getThread, upsertHost } from "@bb/db";
import { threadScope } from "@bb/domain";
import {
  hostDaemonEventBatchResponseSchema,
  type HostDaemonEventEnvelope,
} from "@bb/host-daemon-contract";
import type { SandboxHost } from "@bb/sandbox-host";
import { describe, expect, it, vi } from "vitest";
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
import type { TestAppHarness } from "../helpers/test-app.js";

interface SeedEventRouteArgs {
  hostType?: "persistent" | "ephemeral";
}

interface PostEventBatchArgs {
  harness: TestAppHarness;
  sessionId: string;
  events: HostDaemonEventEnvelope[];
}

interface MockSandboxHost extends SandboxHost {
  extendTimeout: ReturnType<typeof vi.fn>;
}

async function postEventBatch(args: PostEventBatchArgs): Promise<Response> {
  return args.harness.app.request("/internal/session/events", {
    method: "POST",
    headers: internalAuthHeaders(args.harness),
    body: JSON.stringify({
      sessionId: args.sessionId,
      events: args.events,
    }),
  });
}

function createMockSandboxHost(
  hostId: string,
  externalId: string,
): MockSandboxHost {
  return {
    destroy: vi.fn().mockResolvedValue(undefined),
    extendTimeout: vi.fn().mockResolvedValue(undefined),
    externalId,
    hostId,
    resume: vi.fn().mockResolvedValue(undefined),
    suspend: vi.fn().mockResolvedValue(undefined),
  };
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
  it("assigns server-owned sequences and returns accepted producer events", async () => {
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
            producerEventId: "hdevt_23456789abcdefghijkm",
            threadId: thread.id,
            event: {
              type: "system/error",
              threadId: thread.id,
              scope: threadScope(),
              message: "first daemon",
            },
          },
          {
            producerEventId: "hdevt_23456789abcdefghijkn",
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
            producerEventId: "hdevt_23456789abcdefghijkm",
            threadId: thread.id,
            sequence: 4,
          },
          {
            producerEventId: "hdevt_23456789abcdefghijkn",
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
        { sequence: 3, producerEventId: null },
        {
          sequence: 4,
          producerEventId: "hdevt_23456789abcdefghijkm",
          producerEventPayloadHash: expect.any(String),
        },
        {
          sequence: 5,
          producerEventId: "hdevt_23456789abcdefghijkn",
          producerEventPayloadHash: expect.any(String),
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
              producerEventId: "hdevt_23456789abcdefghijkp",
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
              producerEventId: "hdevt_23456789abcdefghijkq",
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
          producerEventId: events.producerEventId,
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
      expect(
        storedRows
          .map((row) => row.producerEventId)
          .sort((left, right) => String(left).localeCompare(String(right))),
      ).toEqual(["hdevt_23456789abcdefghijkp", "hdevt_23456789abcdefghijkq"]);
    } finally {
      await harness.cleanup();
    }
  });

  it("returns existing sequences for identical producer retries and appends new events in order", async () => {
    const { harness, session, thread } = await setupEventRoute();
    try {
      const firstEvent: HostDaemonEventEnvelope = {
        producerEventId: "hdevt_23456789abcdefghijkm",
        threadId: thread.id,
        event: {
          type: "system/error",
          threadId: thread.id,
          scope: threadScope(),
          message: "first daemon",
        },
      };
      const firstResponse = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [firstEvent],
      });
      expect(firstResponse.status).toBe(200);

      const retryResponse = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          firstEvent,
          {
            producerEventId: "hdevt_23456789abcdefghijkn",
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

      expect(retryResponse.status).toBe(200);
      await expect(readJson(retryResponse)).resolves.toEqual({
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

  it("treats semantically identical canonical payloads as the same retry", async () => {
    const { harness, session, thread } = await setupEventRoute();
    try {
      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            producerEventId: "hdevt_23456789abcdefghijkm",
            threadId: thread.id,
            event: {
              type: "provider/unhandled",
              threadId: thread.id,
              providerThreadId: "provider-thread",
              providerId: "codex",
              rawType: "raw",
              rawEvent: {
                jsonrpc: "2.0",
                method: "test",
                params: { z: true, a: "value" },
              },
              scope: threadScope(),
            },
          },
        ],
      });
      expect(response.status).toBe(200);

      const retryResponse = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            producerEventId: "hdevt_23456789abcdefghijkm",
            threadId: thread.id,
            event: {
              type: "provider/unhandled",
              threadId: thread.id,
              providerThreadId: "provider-thread",
              providerId: "codex",
              rawType: "raw",
              rawEvent: {
                jsonrpc: "2.0",
                method: "test",
                params: { a: "value", z: true },
              },
              scope: threadScope(),
            },
          },
        ],
      });

      expect(retryResponse.status).toBe(200);
      await expect(readJson(retryResponse)).resolves.toEqual({
        acceptedEvents: [
          {
            producerEventId: "hdevt_23456789abcdefghijkm",
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
      ).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects producerEventId retries with mismatched payloads", async () => {
    const { harness, session, thread } = await setupEventRoute();
    const loggerError = vi.fn();
    const originalLoggerError = harness.deps.logger.error;
    harness.deps.logger.error = loggerError;
    try {
      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            producerEventId: "hdevt_23456789abcdefghijkm",
            threadId: thread.id,
            event: {
              type: "system/error",
              threadId: thread.id,
              scope: threadScope(),
              message: "first daemon",
            },
          },
        ],
      });
      expect(response.status).toBe(200);

      const mismatchResponse = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            producerEventId: "hdevt_23456789abcdefghijkm",
            threadId: thread.id,
            event: {
              type: "system/error",
              threadId: thread.id,
              scope: threadScope(),
              message: "different daemon payload",
            },
          },
        ],
      });

      expect(mismatchResponse.status).toBe(409);
      await expect(readJson(mismatchResponse)).resolves.toEqual({
        code: "producer_event_payload_mismatch",
        message: "Producer event id was reused with a different payload",
      });
      expect(loggerError).toHaveBeenCalledWith(
        expect.objectContaining({
          producerEventId: "hdevt_23456789abcdefghijkm",
          sessionId: session.id,
        }),
        "Producer event id payload mismatch",
      );
      expect(
        harness.db
          .select()
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all(),
      ).toHaveLength(1);
    } finally {
      harness.deps.logger.error = originalLoggerError;
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
            producerEventId: "hdevt_23456789abcdefghijkm",
            threadId: "thr_missing",
            event: {
              type: "system/error",
              threadId: "thr_missing",
              scope: threadScope(),
              message: "stale daemon event",
            },
          },
          {
            producerEventId: "hdevt_23456789abcdefghijkn",
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
            producerEventId: "hdevt_23456789abcdefghijkn",
            threadId: thread.id,
            sequence: 1,
          },
        ],
        rejectedEvents: [
          {
            producerEventId: "hdevt_23456789abcdefghijkm",
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

  it("does not mark sandbox activity for all-rejected event batches", async () => {
    const { harness, host, session } = await setupEventRoute({
      hostType: "ephemeral",
    });
    const sandboxHost = createMockSandboxHost(
      host.id,
      "sandbox-events-all-rejected",
    );
    try {
      upsertHost(harness.db, harness.hub, {
        externalId: sandboxHost.externalId,
        id: host.id,
        name: host.name,
        provider: "e2b",
        type: "ephemeral",
      });
      harness.deps.sandboxRegistry.set(host.id, sandboxHost);

      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            producerEventId: "hdevt_23456789abcdefghijkm",
            threadId: "thr_missing",
            event: {
              type: "system/error",
              threadId: "thr_missing",
              scope: threadScope(),
              message: "stale daemon event",
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        acceptedEvents: [],
        rejectedEvents: [
          {
            producerEventId: "hdevt_23456789abcdefghijkm",
            reason: "thread_not_owned_by_host",
            threadId: "thr_missing",
          },
        ],
      });
      expect(harness.db.select().from(events).all()).toHaveLength(0);
      expect(getHost(harness.db, host.id)?.lastActivityAt).toBeNull();
      expect(sandboxHost.extendTimeout).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });

  it("marks sandbox activity for mixed event batches with accepted rows", async () => {
    const { harness, host, session, thread } = await setupEventRoute({
      hostType: "ephemeral",
    });
    const sandboxHost = createMockSandboxHost(
      host.id,
      "sandbox-events-mixed",
    );
    try {
      upsertHost(harness.db, harness.hub, {
        externalId: sandboxHost.externalId,
        id: host.id,
        name: host.name,
        provider: "e2b",
        type: "ephemeral",
      });
      harness.deps.sandboxRegistry.set(host.id, sandboxHost);

      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            producerEventId: "hdevt_23456789abcdefghijkm",
            threadId: "thr_missing",
            event: {
              type: "system/error",
              threadId: "thr_missing",
              scope: threadScope(),
              message: "stale daemon event",
            },
          },
          {
            producerEventId: "hdevt_23456789abcdefghijkn",
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
            producerEventId: "hdevt_23456789abcdefghijkn",
            threadId: thread.id,
            sequence: 1,
          },
        ],
        rejectedEvents: [
          {
            producerEventId: "hdevt_23456789abcdefghijkm",
            reason: "thread_not_owned_by_host",
            threadId: "thr_missing",
          },
        ],
      });
      expect(getHost(harness.db, host.id)?.lastActivityAt).toEqual(
        expect.any(Number),
      );
      await vi.waitFor(() => {
        expect(sandboxHost.extendTimeout).toHaveBeenCalledTimes(1);
      });
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
            producerEventId: "hdevt_23456789abcdefghijkm",
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
            producerEventId: "hdevt_23456789abcdefghijkn",
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
            producerEventId: "hdevt_23456789abcdefghijkp",
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
            producerEventId: "hdevt_23456789abcdefghijkm",
            threadId: thread.id,
            sequence: 1,
          },
          {
            producerEventId: "hdevt_23456789abcdefghijkp",
            threadId: secondThread.id,
            sequence: 1,
          },
        ],
        rejectedEvents: [
          {
            producerEventId: "hdevt_23456789abcdefghijkn",
            reason: "thread_not_owned_by_host",
            threadId: "thr_missing",
          },
        ],
      });
      expect(getThread(harness.db, thread.id)?.title).toBe(
        "First owned rename",
      );
      expect(getThread(harness.db, secondThread.id)?.title).toBe(
        "Second owned rename",
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
});

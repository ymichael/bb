import { changedMessageSchema, type ThreadChangedMessage } from "@bb/domain";
import { getThread, markThreadDeleted } from "@bb/db";
import { describe, expect, it, vi } from "vitest";
import {
  handleDaemonSocketClosed,
  handleHostRemoved,
} from "../../src/internal/session-owner-side-effects.js";
import { createMockHubSocket } from "../helpers/mock-hub-socket.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

interface HostThreadsFixture {
  activeThreadId: string;
  environmentId: string;
  hostId: string;
  idleThreadId: string;
  projectId: string;
  sessionId: string;
}

function seedHostThreadsFixture(
  harness: TestAppHarness,
  value: number,
): HostThreadsFixture {
  const { host, session } = seedHostSession(harness.deps, {
    id: `host-runtime-status-${value}`,
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: `/tmp/runtime-status-${value}`,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: `/tmp/runtime-status-${value}`,
    status: "ready",
  });
  const activeThread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "active",
  });
  const idleThread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "idle",
  });
  return {
    activeThreadId: activeThread.id,
    environmentId: environment.id,
    hostId: host.id,
    idleThreadId: idleThread.id,
    projectId: project.id,
    sessionId: session.id,
  };
}

function seedHostThreads(
  harness: TestAppHarness,
  args: {
    count: number;
    fixture: Pick<HostThreadsFixture, "environmentId" | "projectId">;
    status: "active" | "idle";
  },
): string[] {
  return Array.from(
    { length: args.count },
    () =>
      seedThread(harness.deps, {
        projectId: args.fixture.projectId,
        environmentId: args.fixture.environmentId,
        status: args.status,
      }).id,
  );
}

function countPreparedStatements(
  harness: TestAppHarness,
  work: () => void,
): number {
  const prepare = vi.spyOn(harness.db.$client, "prepare");
  try {
    work();
    return prepare.mock.calls.length;
  } finally {
    prepare.mockRestore();
  }
}

function statusChangedMessagesFor(
  messages: readonly string[],
  threadId: string,
): ThreadChangedMessage[] {
  return messages.flatMap((raw) => {
    const message = changedMessageSchema.parse(JSON.parse(raw));
    return message.entity === "thread" &&
      message.id === threadId &&
      message.changes.includes("status-changed")
      ? [message]
      : [];
  });
}

function lastStatusChange(
  messages: readonly string[],
  threadId: string,
): ThreadChangedMessage {
  const statusMessages = statusChangedMessagesFor(messages, threadId);
  const last = statusMessages.at(-1);
  if (!last) {
    throw new Error(`no status-changed message for thread ${threadId}`);
  }
  return last;
}

describe("host thread runtime status notifications", () => {
  it("carries a statusChange snapshot for the active host threads when the daemon socket closes", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedHostThreadsFixture(harness, 1);
      const socket = createMockHubSocket();
      harness.hub.subscribe(socket, { kind: "thread-list" });

      handleDaemonSocketClosed(harness.deps, { sessionId: fixture.sessionId });
      harness.hub.cancelPendingDaemonDisconnect(fixture.sessionId);

      const activeMessage = lastStatusChange(
        socket.messages,
        fixture.activeThreadId,
      );
      expect(activeMessage.metadata?.statusChange).toMatchObject({
        status: "active",
        runtime: {
          displayStatus: "host-reconnecting",
          hostReconnectGraceExpiresAt: expect.any(Number),
        },
      });
      const idleMessage = lastStatusChange(
        socket.messages,
        fixture.idleThreadId,
      );
      expect(idleMessage.metadata?.statusChange).toBeUndefined();
    });
  });

  it("publishes the disconnect fan-out in a statement count that does not grow with the host's thread count", async () => {
    await withTestHarness(async (harness) => {
      const small = seedHostThreadsFixture(harness, 2);
      const large = seedHostThreadsFixture(harness, 3);
      const largeActiveThreadIds = [
        large.activeThreadId,
        ...seedHostThreads(harness, {
          count: 2,
          fixture: large,
          status: "active",
        }),
      ];
      const largeIdleThreadIds = seedHostThreads(harness, {
        count: 300,
        fixture: large,
        status: "idle",
      });
      const deletedActiveThread = seedThread(harness.deps, {
        projectId: large.projectId,
        environmentId: large.environmentId,
        status: "active",
      });
      markThreadDeleted(harness.db, harness.hub, {
        threadId: deletedActiveThread.id,
      });
      const socket = createMockHubSocket();
      harness.hub.subscribe(socket, { kind: "thread-list" });

      const largeStatements = countPreparedStatements(harness, () =>
        handleDaemonSocketClosed(harness.deps, { sessionId: large.sessionId }),
      );
      harness.hub.cancelPendingDaemonDisconnect(large.sessionId);
      const largeMessages = [...socket.messages];
      socket.messages.length = 0;

      const smallStatements = countPreparedStatements(harness, () =>
        handleDaemonSocketClosed(harness.deps, { sessionId: small.sessionId }),
      );
      harness.hub.cancelPendingDaemonDisconnect(small.sessionId);

      expect(largeStatements).toBe(smallStatements);

      for (const threadId of largeActiveThreadIds) {
        expect(
          lastStatusChange(largeMessages, threadId).metadata?.statusChange,
        ).toMatchObject({
          status: "active",
          runtime: { displayStatus: "host-reconnecting" },
        });
      }
      for (const threadId of [...largeIdleThreadIds, deletedActiveThread.id]) {
        expect(
          lastStatusChange(largeMessages, threadId).metadata?.statusChange,
        ).toBeUndefined();
      }
      expect(
        statusChangedMessagesFor(largeMessages, small.activeThreadId),
      ).toEqual([]);
    });
  });

  it("carries the settled post-interruption snapshot when the host is removed", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedHostThreadsFixture(harness, 4);
      const socket = createMockHubSocket();
      harness.hub.subscribe(socket, { kind: "thread-list" });

      handleHostRemoved(harness.deps, {
        hostId: fixture.hostId,
        sessionId: fixture.sessionId,
      });

      const activeSnapshots = statusChangedMessagesFor(
        socket.messages,
        fixture.activeThreadId,
      ).flatMap((message) =>
        message.metadata?.statusChange ? [message.metadata.statusChange] : [],
      );
      expect(activeSnapshots.length).toBeGreaterThan(0);
      expect(getThread(harness.db, fixture.activeThreadId)?.status).toBe(
        "error",
      );
      expect(activeSnapshots.at(-1)).toMatchObject({
        status: "error",
        runtime: { displayStatus: "error" },
      });
      expect(
        lastStatusChange(socket.messages, fixture.idleThreadId).metadata
          ?.statusChange,
      ).toBeUndefined();
    });
  });
});

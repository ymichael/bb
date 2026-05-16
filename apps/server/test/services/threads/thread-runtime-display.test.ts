import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  appendStoredThreadEvent,
  closeSession,
  createConnection,
  createEnvironment,
  createProject,
  createThread,
  hostDaemonSessions,
  migrate,
  noopNotifier,
  openSession,
  upsertHost,
  type DbConnection,
  type ThreadWithPendingInteractionState,
} from "@bb/db";
import { turnScope, type Thread, type ThreadRuntimeState } from "@bb/domain";
import { DAEMON_DISCONNECT_GRACE_MS } from "../../../src/constants.js";
import {
  resolveThreadRuntimeState,
  toThreadListEntryResponses,
} from "../../../src/services/threads/thread-runtime-display.js";

interface SetupResult {
  db: DbConnection;
  hostId: string;
}

interface OpenTestSessionArgs {
  db: DbConnection;
  hostId: string;
  leaseExpiresAt?: number;
}

interface CloseTestSessionArgs {
  closedAt: number;
  db: DbConnection;
  sessionId: string;
}

interface CreateThreadWithEnvironmentArgs {
  db: DbConnection;
  hostId: string;
  status?: Thread["status"];
}

interface CreateThreadListEntryArgs {
  environmentHostId: string | null;
  thread: Thread;
}

function setup(): SetupResult {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    id: "host-runtime-display",
    name: "Runtime Display Host",
    type: "persistent",
  });
  return { db, hostId: host.id };
}

function openTestSession(args: OpenTestSessionArgs) {
  const session = openSession(args.db, noopNotifier, {
    hostId: args.hostId,
    instanceId: `instance-${randomUUID()}`,
    hostName: "Runtime Display Host",
    hostType: "persistent",
    dataDir: `/tmp/${args.hostId}`,
    protocolVersion: 1,
    heartbeatIntervalMs: 5_000,
    leaseTimeoutMs: 30_000,
  });

  if (args.leaseExpiresAt !== undefined) {
    args.db
      .update(hostDaemonSessions)
      .set({ leaseExpiresAt: args.leaseExpiresAt })
      .where(eq(hostDaemonSessions.id, session.id))
      .run();
  }

  return session;
}

function closeTestSession(args: CloseTestSessionArgs): void {
  closeSession(args.db, noopNotifier, args.sessionId, "daemon-disconnect");
  args.db
    .update(hostDaemonSessions)
    .set({
      closedAt: args.closedAt,
      updatedAt: args.closedAt,
    })
    .where(eq(hostDaemonSessions.id, args.sessionId))
    .run();
}

function createThreadWithEnvironment(args: CreateThreadWithEnvironmentArgs) {
  const suffix = randomUUID();
  const { project } = createProject(args.db, noopNotifier, {
    name: `Runtime Display Project ${suffix}`,
    source: {
      type: "local_path",
      hostId: args.hostId,
      path: `/tmp/${args.hostId}/project/${suffix}`,
    },
  });
  const environment = createEnvironment(args.db, noopNotifier, {
    hostId: args.hostId,
    projectId: project.id,
    workspaceProvisionType: "unmanaged",
    path: `/tmp/${args.hostId}/environment/${suffix}`,
    status: "ready",
  });
  const thread = createThread(args.db, noopNotifier, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: "codex",
    status: args.status ?? "active",
  });

  return { environment, project, thread };
}

function createThreadListEntry(
  args: CreateThreadListEntryArgs,
): ThreadWithPendingInteractionState {
  return {
    ...args.thread,
    environmentBranchName: null,
    environmentHostId: args.environmentHostId,
    environmentWorkspaceDisplayKind: "other",
    hasPendingInteraction: false,
  };
}

describe("thread runtime display", () => {
  it("keeps active threads active while the latest host session is active", () => {
    const { db, hostId } = setup();
    const now = 1_000;
    openTestSession({
      db,
      hostId,
      leaseExpiresAt: now + 30_000,
    });

    expect(
      resolveThreadRuntimeState(
        { db },
        { environmentHostId: hostId, now, status: "active" },
      ),
    ).toEqual({
      displayStatus: "active",
      hostReconnectGraceExpiresAt: null,
    } satisfies ThreadRuntimeState);
  });

  it("shows host-reconnecting while a daemon disconnect is inside the grace period", () => {
    const { db, hostId } = setup();
    const now = 10_000;
    const session = openTestSession({ db, hostId });
    closeTestSession({
      closedAt: now - 1_000,
      db,
      sessionId: session.id,
    });

    expect(
      resolveThreadRuntimeState(
        { db },
        { environmentHostId: hostId, now, status: "active" },
      ),
    ).toEqual({
      displayStatus: "host-reconnecting",
      hostReconnectGraceExpiresAt: now - 1_000 + DAEMON_DISCONNECT_GRACE_MS,
    } satisfies ThreadRuntimeState);
  });

  it("shows waiting-for-host after the daemon disconnect grace period expires", () => {
    const { db, hostId } = setup();
    const now = 10_000;
    const session = openTestSession({ db, hostId });
    closeTestSession({
      closedAt: now - DAEMON_DISCONNECT_GRACE_MS - 1,
      db,
      sessionId: session.id,
    });

    expect(
      resolveThreadRuntimeState(
        { db },
        { environmentHostId: hostId, now, status: "active" },
      ),
    ).toEqual({
      displayStatus: "waiting-for-host",
      hostReconnectGraceExpiresAt: null,
    } satisfies ThreadRuntimeState);
  });

  it("uses the thread status directly for non-active statuses", () => {
    const { db, hostId } = setup();

    expect(
      resolveThreadRuntimeState(
        { db },
        { environmentHostId: hostId, now: 1_000, status: "idle" },
      ),
    ).toEqual({
      displayStatus: "idle",
      hostReconnectGraceExpiresAt: null,
    } satisfies ThreadRuntimeState);
  });

  it("does not require a host id for active threads without an environment host", () => {
    const { db } = setup();

    expect(
      resolveThreadRuntimeState(
        { db },
        { environmentHostId: null, now: 1_000, status: "active" },
      ),
    ).toEqual({
      displayStatus: "active",
      hostReconnectGraceExpiresAt: null,
    } satisfies ThreadRuntimeState);
  });

  it("resolves list entry runtime from the latest session per host", () => {
    const { db, hostId } = setup();
    const now = 1_000;
    openTestSession({
      db,
      hostId,
      leaseExpiresAt: now + 30_000,
    });
    const first = createThreadWithEnvironment({ db, hostId });
    const second = createThreadWithEnvironment({ db, hostId });
    const noHost = createThreadWithEnvironment({
      db,
      hostId,
      status: "active",
    });

    const entries = toThreadListEntryResponses(
      { db },
      {
        now,
        threads: [
          createThreadListEntry({
            environmentHostId: hostId,
            thread: first.thread,
          }),
          createThreadListEntry({
            environmentHostId: hostId,
            thread: second.thread,
          }),
          createThreadListEntry({
            environmentHostId: null,
            thread: noHost.thread,
          }),
        ],
      },
    );

    expect(entries.map((entry) => entry.runtime)).toEqual([
      {
        displayStatus: "active",
        hostReconnectGraceExpiresAt: null,
      },
      {
        displayStatus: "active",
        hostReconnectGraceExpiresAt: null,
      },
      {
        displayStatus: "active",
        hostReconnectGraceExpiresAt: null,
      },
    ] satisfies ThreadRuntimeState[]);
  });

  it("attaches latest terminal summaries to list entries", () => {
    const { db, hostId } = setup();
    const { thread } = createThreadWithEnvironment({
      db,
      hostId,
      status: "idle",
    });
    appendStoredThreadEvent(db, noopNotifier, {
      threadId: thread.id,
      scope: turnScope("turn_failed"),
      providerThreadId: "provider_failed",
      type: "turn/completed",
      data: {
        providerThreadId: "provider_failed",
        status: "failed",
      },
    });

    const [entry] = toThreadListEntryResponses(
      { db },
      {
        threads: [
          createThreadListEntry({
            environmentHostId: hostId,
            thread,
          }),
        ],
      },
    );

    expect(entry?.latestTerminalSummary).toEqual({
      sourceEventSequence: 1,
      sourceEventType: "turn/completed",
      turnId: "turn_failed",
      outcome: "failed",
      cause: {
        kind: "provider-turn-failure",
        text: "provider turn failure",
        systemThreadInterruptedReason: null,
        sourceEventSequence: 1,
      },
    });
  });
});

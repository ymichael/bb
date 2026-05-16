import {
  getEnvironment,
  getLatestSessionForHost,
  listLatestThreadTerminalSummaries,
  listLatestSessionsForHosts,
  type DbConnection,
  type HostDaemonSessionRow,
  type ThreadWithPendingInteractionState,
} from "@bb/db";
import type {
  Thread,
  ThreadRuntimeState,
  ThreadStatus,
} from "@bb/domain";
import type {
  ThreadListEntryResponse,
  ThreadResponse,
} from "@bb/server-contract";
import { DAEMON_DISCONNECT_GRACE_MS } from "../../constants.js";

interface ThreadRuntimeDisplayDeps {
  db: DbConnection;
}

interface ResolveThreadRuntimeStateArgs {
  environmentHostId: string | null;
  now?: number;
  status: ThreadStatus;
}

interface ResolveThreadRuntimeStateFromLatestSessionArgs {
  environmentHostId: string | null;
  latestSession: HostDaemonSessionRow | null;
  now?: number;
  status: ThreadStatus;
}

interface ToThreadResponseFromThreadArgs {
  now?: number;
  thread: Thread;
}

interface ToThreadResponseWithHostArgs extends ToThreadResponseFromThreadArgs {
  environmentHostId: string | null;
}

interface ToThreadListEntryResponseArgs {
  now?: number;
  thread: ThreadWithPendingInteractionState;
}

interface ToThreadListEntryResponsesArgs {
  now?: number;
  threads: readonly ThreadWithPendingInteractionState[];
}

interface ToThreadListEntryResponseFromLatestSessionArgs {
  latestSession: HostDaemonSessionRow | null;
  now?: number;
  thread: ThreadWithPendingInteractionState;
  terminalSummaryByThreadId?: ReadonlyMap<
    string,
    ThreadListEntryResponse["latestTerminalSummary"]
  >;
}

function threadStatusRuntimeState(status: ThreadStatus): ThreadRuntimeState {
  switch (status) {
    case "created":
    case "provisioning":
    case "idle":
    case "active":
    case "error":
      return {
        displayStatus: status,
        hostReconnectGraceExpiresAt: null,
      };
  }
}

function getDaemonDisconnectGraceExpiresAt(
  session: HostDaemonSessionRow,
): number | null {
  if (session.status !== "closed") {
    return null;
  }
  if (session.closeReason !== "daemon-disconnect") {
    return null;
  }
  if (session.closedAt === null) {
    return null;
  }
  return session.closedAt + DAEMON_DISCONNECT_GRACE_MS;
}

export function resolveThreadRuntimeState(
  deps: ThreadRuntimeDisplayDeps,
  args: ResolveThreadRuntimeStateArgs,
): ThreadRuntimeState {
  const latestSession =
    args.status === "active" && args.environmentHostId !== null
      ? getLatestSessionForHost(deps.db, {
          hostId: args.environmentHostId,
        })
      : null;
  return resolveThreadRuntimeStateFromLatestSession({
    environmentHostId: args.environmentHostId,
    latestSession,
    now: args.now,
    status: args.status,
  });
}

function resolveThreadRuntimeStateFromLatestSession(
  args: ResolveThreadRuntimeStateFromLatestSessionArgs,
): ThreadRuntimeState {
  if (args.status !== "active" || args.environmentHostId === null) {
    return threadStatusRuntimeState(args.status);
  }

  const now = args.now ?? Date.now();
  const latestSession = args.latestSession;
  if (
    latestSession &&
    latestSession.status === "active" &&
    latestSession.leaseExpiresAt > now
  ) {
    return threadStatusRuntimeState("active");
  }

  if (latestSession) {
    const graceExpiresAt = getDaemonDisconnectGraceExpiresAt(latestSession);
    if (graceExpiresAt !== null && graceExpiresAt > now) {
      return {
        displayStatus: "host-reconnecting",
        hostReconnectGraceExpiresAt: graceExpiresAt,
      };
    }
  }

  return {
    displayStatus: "waiting-for-host",
    hostReconnectGraceExpiresAt: null,
  };
}

function resolveThreadEnvironmentHostId(
  deps: ThreadRuntimeDisplayDeps,
  thread: Thread,
): string | null {
  if (thread.environmentId === null) {
    return null;
  }
  return getEnvironment(deps.db, thread.environmentId)?.hostId ?? null;
}

export function toThreadResponseWithHost(
  deps: ThreadRuntimeDisplayDeps,
  args: ToThreadResponseWithHostArgs,
): ThreadResponse {
  const [terminalSummaryRow] = listLatestThreadTerminalSummaries(deps.db, {
    threadIds: [args.thread.id],
  });
  return {
    ...args.thread,
    latestTerminalSummary: terminalSummaryRow?.summary ?? null,
    runtime: resolveThreadRuntimeState(deps, {
      environmentHostId: args.environmentHostId,
      now: args.now,
      status: args.thread.status,
    }),
  };
}

export function toThreadResponseFromThread(
  deps: ThreadRuntimeDisplayDeps,
  args: ToThreadResponseFromThreadArgs,
): ThreadResponse {
  return toThreadResponseWithHost(deps, {
    ...args,
    environmentHostId: resolveThreadEnvironmentHostId(deps, args.thread),
  });
}

export function toThreadListEntryResponse(
  deps: ThreadRuntimeDisplayDeps,
  args: ToThreadListEntryResponseArgs,
): ThreadListEntryResponse {
  const latestSession =
    args.thread.status === "active" && args.thread.environmentHostId !== null
      ? getLatestSessionForHost(deps.db, {
          hostId: args.thread.environmentHostId,
        })
      : null;
  return toThreadListEntryResponseFromLatestSession({
    latestSession,
    now: args.now,
    thread: args.thread,
    terminalSummaryByThreadId: terminalSummaryMapForThreadIds(deps, [
      args.thread.id,
    ]),
  });
}

export function toThreadListEntryResponses(
  deps: ThreadRuntimeDisplayDeps,
  args: ToThreadListEntryResponsesArgs,
): ThreadListEntryResponse[] {
  const activeHostIds = [
    ...new Set(
      args.threads.flatMap((thread) =>
        thread.status === "active" && thread.environmentHostId !== null
          ? [thread.environmentHostId]
          : [],
      ),
    ),
  ];
  const latestSessionByHostId = new Map(
    listLatestSessionsForHosts(deps.db, { hostIds: activeHostIds }).map(
      (session) => [session.hostId, session],
    ),
  );
  const terminalSummaryByThreadId = terminalSummaryMapForThreadIds(
    deps,
    args.threads.map((thread) => thread.id),
  );

  return args.threads.map((thread) =>
    toThreadListEntryResponseFromLatestSession({
      latestSession:
        thread.environmentHostId === null
          ? null
          : latestSessionByHostId.get(thread.environmentHostId) ?? null,
      now: args.now,
      thread,
      terminalSummaryByThreadId,
    }),
  );
}

function toThreadListEntryResponseFromLatestSession(
  args: ToThreadListEntryResponseFromLatestSessionArgs,
): ThreadListEntryResponse {
  return {
    ...args.thread,
    latestTerminalSummary:
      args.terminalSummaryByThreadId?.get(args.thread.id) ?? null,
    runtime: resolveThreadRuntimeStateFromLatestSession({
      environmentHostId: args.thread.environmentHostId,
      latestSession: args.latestSession,
      now: args.now,
      status: args.thread.status,
    }),
  };
}

function terminalSummaryMapForThreadIds(
  deps: ThreadRuntimeDisplayDeps,
  threadIds: readonly string[],
): Map<string, ThreadListEntryResponse["latestTerminalSummary"]> {
  return new Map(
    listLatestThreadTerminalSummaries(deps.db, { threadIds }).map((row) => [
      row.threadId,
      row.summary,
    ]),
  );
}

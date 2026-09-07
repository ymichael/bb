import type { QueryClient } from "@tanstack/react-query";
import type {
  TerminalListResponse,
  TerminalSession,
} from "@bb/server-contract";
import {
  allTerminalsQueryKeyPrefix,
  terminalsQueryKey,
  type TerminalQueryScope,
} from "../queries/query-keys";

interface TerminalSessionCacheArgs {
  queryClient: QueryClient;
  session: TerminalSession;
}

interface CloseTerminalSessionCacheArgs extends TerminalSessionCacheArgs {
  terminalId: string;
}

function upsertTerminalSession(
  current: TerminalListResponse | undefined,
  session: TerminalSession,
): TerminalListResponse {
  if (!current) {
    return { sessions: [session] };
  }

  const existingIndex = current.sessions.findIndex(
    (existingSession) => existingSession.id === session.id,
  );
  if (existingIndex === -1) {
    return { sessions: [...current.sessions, session] };
  }

  return {
    sessions: current.sessions.map((existingSession) =>
      existingSession.id === session.id ? session : existingSession,
    ),
  };
}

function removeTerminalSession(
  current: TerminalListResponse | undefined,
  terminalId: string,
): TerminalListResponse | undefined {
  if (!current) {
    return current;
  }

  const sessions = current.sessions.filter((session) => {
    return session.id !== terminalId;
  });
  if (sessions.length === current.sessions.length) {
    return current;
  }

  return { sessions };
}

function terminalScopesForSession(
  session: TerminalSession,
): TerminalQueryScope[] {
  if (session.threadId !== null) {
    return [{ kind: "thread", threadId: session.threadId }];
  }
  if (session.environmentId !== null) {
    return [{ kind: "environment", environmentId: session.environmentId }];
  }
  return [
    { kind: "host_path", hostId: session.hostId },
    { kind: "host_path", hostId: session.hostId, cwd: session.initialCwd },
  ];
}

export function applyTerminalSessionUpsert({
  queryClient,
  session,
}: TerminalSessionCacheArgs): void {
  for (const scope of terminalScopesForSession(session)) {
    queryClient.setQueryData<TerminalListResponse>(
      terminalsQueryKey(scope),
      (current) => upsertTerminalSession(current, session),
    );
  }
  queryClient.invalidateQueries({
    queryKey: allTerminalsQueryKeyPrefix(),
  });
}

export function applyTerminalSessionClose({
  queryClient,
  session,
  terminalId,
}: CloseTerminalSessionCacheArgs): void {
  for (const scope of terminalScopesForSession(session)) {
    queryClient.setQueryData<TerminalListResponse>(
      terminalsQueryKey(scope),
      (current) =>
        session.status === "exited"
          ? removeTerminalSession(current, terminalId)
          : upsertTerminalSession(current, session),
    );
  }
  queryClient.invalidateQueries({
    queryKey: allTerminalsQueryKeyPrefix(),
  });
}

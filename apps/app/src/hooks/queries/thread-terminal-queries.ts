import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CloseThreadTerminalRequest,
  CreateThreadTerminalRequest,
  TerminalSession,
  ThreadTerminalListResponse,
  UpdateThreadTerminalRequest,
} from "@bb/server-contract";
import * as api from "@/lib/api";
import { threadTerminalsQueryKey } from "./query-keys";

interface QueryOptions {
  enabled?: boolean;
}

interface CreateThreadTerminalMutationRequest
  extends CreateThreadTerminalRequest {
  threadId: string;
}

interface RenameThreadTerminalMutationRequest
  extends UpdateThreadTerminalRequest {
  terminalId: string;
  threadId: string;
}

interface CloseThreadTerminalMutationRequest {
  mode: CloseThreadTerminalRequest["mode"];
  terminalId: string;
  threadId: string;
}

function upsertTerminalSession(
  current: ThreadTerminalListResponse | undefined,
  session: TerminalSession,
): ThreadTerminalListResponse {
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
  current: ThreadTerminalListResponse | undefined,
  terminalId: string,
): ThreadTerminalListResponse | undefined {
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

function requireThreadId(id: string, hookName: string): string {
  if (!id) {
    throw new Error(`${hookName}: thread id is required when query is enabled`);
  }

  return id;
}

export function useThreadTerminals(id: string, options?: QueryOptions) {
  return useQuery<ThreadTerminalListResponse>({
    queryKey: threadTerminalsQueryKey(id),
    queryFn: ({ signal }) =>
      api.listThreadTerminals(
        requireThreadId(id, "useThreadTerminals"),
        signal,
      ),
    enabled: (options?.enabled ?? true) && Boolean(id),
    refetchOnWindowFocus: false,
  });
}

export function useCreateThreadTerminal() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to start terminal.",
    },
    mutationFn: ({ threadId, ...request }: CreateThreadTerminalMutationRequest) =>
      api.createThreadTerminal(threadId, request),
    onSuccess: (session: TerminalSession) => {
      queryClient.setQueryData<ThreadTerminalListResponse>(
        threadTerminalsQueryKey(session.threadId),
        (current) => upsertTerminalSession(current, session),
      );
      queryClient.invalidateQueries({
        queryKey: threadTerminalsQueryKey(session.threadId),
      });
    },
  });
}

export function useRenameThreadTerminal() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to rename terminal.",
    },
    mutationFn: ({
      terminalId,
      threadId,
      ...request
    }: RenameThreadTerminalMutationRequest) =>
      api.renameThreadTerminal(threadId, terminalId, request),
    onSuccess: (session: TerminalSession) => {
      queryClient.setQueryData<ThreadTerminalListResponse>(
        threadTerminalsQueryKey(session.threadId),
        (current) => upsertTerminalSession(current, session),
      );
      queryClient.invalidateQueries({
        queryKey: threadTerminalsQueryKey(session.threadId),
      });
    },
  });
}

export function useCloseThreadTerminal() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to close terminal.",
    },
    mutationFn: ({
      mode,
      terminalId,
      threadId,
    }: CloseThreadTerminalMutationRequest) =>
      api.closeThreadTerminal(threadId, terminalId, { mode, reason: "user" }),
    onSuccess: (session: TerminalSession, variables) => {
      queryClient.setQueryData<ThreadTerminalListResponse>(
        threadTerminalsQueryKey(session.threadId),
        (current) =>
          session.status === "exited"
            ? removeTerminalSession(current, variables.terminalId)
            : upsertTerminalSession(current, session),
      );
      queryClient.invalidateQueries({
        queryKey: threadTerminalsQueryKey(session.threadId),
      });
    },
  });
}

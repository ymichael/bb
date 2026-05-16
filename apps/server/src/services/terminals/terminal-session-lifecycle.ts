import { randomUUID } from "node:crypto";
import {
  createTerminalSession,
  getTerminalSessionForThread,
  listTerminalSessionsByEnvironment,
  listTerminalSessionsByThread,
  listVisibleTerminalSessionsByThread,
  markDaemonTerminalSessionExited,
  markDaemonTerminalSessionsDisconnected,
  markEnvironmentTerminalSessionsExited,
  markHostDisconnectedTerminalSessionsExited,
  markTerminalSessionExited,
  markTerminalSessionRunning,
  markTerminalSessionUserInput,
  markThreadTerminalSessionsExited,
  updateTerminalSessionSize,
  updateTerminalSessionTitle,
  type TerminalSessionRow,
} from "@bb/db";
import type { TerminalSessionCloseReason } from "@bb/domain";
import type {
  HostDaemonDaemonWsMessage,
  HostDaemonServerWsMessage,
} from "@bb/host-daemon-contract";
import type {
  CloseThreadTerminalRequest,
  CreateThreadTerminalRequest,
  TerminalClientMessage,
  TerminalOutputChunk,
  TerminalSession,
  UpdateThreadTerminalRequest,
} from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type { AppDeps, ServerLogger } from "../../types.js";
import {
  requireConnectedHostSession,
  requirePublicThread,
  requireReadyEnvironment,
} from "../lib/entity-lookup.js";

const DEFAULT_TERMINAL_OPEN_TIMEOUT_MS = 10_000;

type TerminalOpenedMessage = Extract<
  HostDaemonDaemonWsMessage,
  { type: "terminal.opened" }
>;
type TerminalErrorMessage = Extract<
  HostDaemonDaemonWsMessage,
  { type: "terminal.error" }
>;
type TerminalReplayMessage = Extract<
  HostDaemonDaemonWsMessage,
  { type: "terminal.replay" }
>;
type TerminalOutputMessage = Extract<
  HostDaemonDaemonWsMessage,
  { type: "terminal.output" }
>;
type TerminalApiErrorStatus = ConstructorParameters<typeof ApiError>[0];
type RunningBrowserTerminalSession = TerminalSessionRow & {
  daemonSessionId: string;
  status: "running";
};

interface TerminalClientSocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

interface PendingTerminalOpen {
  daemonSessionId: string;
  reject: (error: Error) => void;
  resolve: (message: TerminalOpenedMessage) => void;
  timeout: ReturnType<typeof setTimeout>;
  terminalId: string;
}

interface PendingTerminalAttach {
  daemonSessionId: string;
  socket: TerminalClientSocket;
  terminalId: string;
  threadId: string;
  timeout: ReturnType<typeof setTimeout>;
}

interface WaitForTerminalOpenArgs {
  daemonSessionId: string;
  requestId: string;
  terminalId: string;
}

interface WaitForTerminalAttachArgs {
  daemonSessionId: string;
  requestId: string;
  socket: TerminalClientSocket;
  terminalId: string;
  threadId: string;
}

interface ResolvePendingOpenArgs {
  daemonSessionId: string;
  message: TerminalOpenedMessage;
}

interface ResolvePendingAttachArgs {
  daemonSessionId: string;
  message: TerminalReplayMessage;
}

interface RejectPendingOpenArgs {
  daemonSessionId: string;
  message: TerminalErrorMessage;
}

interface RejectPendingAttachArgs {
  daemonSessionId: string;
  message: TerminalErrorMessage;
}

interface RejectPendingOpenForTerminalArgs {
  code: string;
  daemonSessionId: string;
  message: string;
  status: TerminalApiErrorStatus;
  terminalId: string;
}

interface RequestTerminalClosesArgs {
  closeReason: TerminalSessionCloseReason;
  sessions: readonly TerminalSessionRow[];
}

interface PublishLifecycleTerminalExitsArgs {
  code: string;
  message: string;
  previousSessionsById: ReadonlyMap<string, TerminalSessionRow>;
  sessions: readonly TerminalSessionRow[];
}

interface NotifyExitedTerminalSessionArgs {
  code: string;
  message: string;
  session: TerminalSessionRow;
}

interface TerminalDaemonCloseTarget {
  daemonSessionId: string;
  terminalId: string;
}

interface AttachBrowserTerminalArgs {
  socket: TerminalClientSocket;
  terminalId: string;
  threadId: string;
}

interface DetachBrowserTerminalArgs {
  socket: TerminalClientSocket;
  terminalId: string;
}

interface HandleBrowserTerminalMessageArgs {
  message: TerminalClientMessage;
  socket: TerminalClientSocket;
  terminalId: string;
  threadId: string;
}

interface GetRunningBrowserTerminalArgs {
  socket: TerminalClientSocket;
  terminalId: string;
  threadId: string;
}

interface SendTerminalSocketErrorArgs {
  code: string;
  message: string;
  socket: TerminalClientSocket;
}

interface DisconnectDaemonSessionTerminalsArgs {
  daemonSessionId: string;
}

interface RejectPendingAttachesForTerminalArgs {
  code: string;
  message: string;
  terminalId: string;
}

interface CloseStaleOpenedTerminalArgs {
  daemonSessionId: string;
  terminalId: string;
  threadId: string;
}

export interface TerminalSessionLifecycleOptions {
  attachTimeoutMs?: number;
  db: AppDeps["db"];
  hub: AppDeps["hub"];
  logger: ServerLogger;
  openTimeoutMs?: number;
}

export interface CreateThreadTerminalArgs {
  payload: CreateThreadTerminalRequest;
  threadId: string;
}

export interface RenameThreadTerminalArgs {
  payload: UpdateThreadTerminalRequest;
  terminalId: string;
  threadId: string;
}

export interface CloseThreadTerminalArgs {
  payload: CloseThreadTerminalRequest;
  terminalId: string;
  threadId: string;
}

export interface CloseDeletedThreadTerminalsArgs {
  threadId: string;
}

export interface CloseArchivedThreadTerminalsArgs {
  threadId: string;
}

export interface CloseDestroyedEnvironmentTerminalsArgs {
  environmentId: string;
}

export interface ExpireDisconnectedHostTerminalsArgs {
  daemonSessionId: string;
  hostId: string;
}

export interface HandleDaemonTerminalMessageArgs {
  hostId: string;
  message: HostDaemonDaemonWsMessage;
  sessionId: string;
}

export interface HandleDaemonSessionClosedArgs {
  sessionId: string;
}

function toTerminalOutputChunk(
  chunk: TerminalOutputMessage["chunk"],
): TerminalOutputChunk {
  return {
    seq: chunk.seq,
    dataBase64: chunk.dataBase64,
  };
}

function isRunningBrowserTerminalSession(
  row: TerminalSessionRow,
): row is RunningBrowserTerminalSession {
  return row.status === "running" && row.daemonSessionId !== null;
}

function getTerminalDaemonCloseTarget(
  row: TerminalSessionRow,
): TerminalDaemonCloseTarget | null {
  if (row.daemonSessionId === null) {
    return null;
  }
  if (row.status !== "starting" && row.status !== "running") {
    return null;
  }
  return {
    daemonSessionId: row.daemonSessionId,
    terminalId: row.id,
  };
}

function buildTerminalSessionMap(
  sessions: readonly TerminalSessionRow[],
): ReadonlyMap<string, TerminalSessionRow> {
  return new Map(sessions.map((session) => [session.id, session]));
}

export function toTerminalSession(row: TerminalSessionRow): TerminalSession {
  return {
    id: row.id,
    threadId: row.threadId,
    environmentId: row.environmentId,
    hostId: row.hostId,
    title: row.title,
    initialCwd: row.initialCwd,
    currentCwd: row.currentCwd,
    cols: row.cols,
    rows: row.rows,
    status: row.status,
    exitCode: row.exitCode,
    closeReason: row.closeReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUserInputAt: row.lastUserInputAt,
  };
}

export class TerminalSessionLifecycle {
  private readonly attachTimeoutMs: number;
  private readonly pendingAttaches = new Map<string, PendingTerminalAttach>();
  private readonly pendingOpens = new Map<string, PendingTerminalOpen>();
  private readonly openTimeoutMs: number;

  constructor(private readonly options: TerminalSessionLifecycleOptions) {
    this.attachTimeoutMs =
      options.attachTimeoutMs ?? DEFAULT_TERMINAL_OPEN_TIMEOUT_MS;
    this.openTimeoutMs =
      options.openTimeoutMs ?? DEFAULT_TERMINAL_OPEN_TIMEOUT_MS;
  }

  listThreadTerminals(threadId: string): TerminalSession[] {
    requirePublicThread(this.options.db, threadId);
    return listVisibleTerminalSessionsByThread(this.options.db, threadId).map(
      toTerminalSession,
    );
  }

  async createThreadTerminal(
    args: CreateThreadTerminalArgs,
  ): Promise<TerminalSession> {
    const thread = requirePublicThread(this.options.db, args.threadId);
    if (!thread.environmentId) {
      throw new ApiError(409, "invalid_request", "Thread has no environment");
    }
    const environment = requireReadyEnvironment(
      this.options.db,
      thread.environmentId,
    );
    const daemonSession = requireConnectedHostSession(
      this.options,
      environment.hostId,
    );
    const existingSessions = listTerminalSessionsByThread(
      this.options.db,
      thread.id,
    );
    const title = `Terminal ${existingSessions.length + 1}`;
    const startingSession = createTerminalSession(this.options.db, {
      cols: args.payload.cols,
      currentCwd: null,
      daemonSessionId: daemonSession.id,
      environmentId: environment.id,
      hostId: environment.hostId,
      initialCwd: environment.path,
      rows: args.payload.rows,
      status: "starting",
      threadId: thread.id,
      title,
    });
    const requestId = randomUUID();
    const openMessage: HostDaemonServerWsMessage = {
      type: "terminal.open",
      requestId,
      terminalId: startingSession.id,
      threadId: thread.id,
      environmentId: environment.id,
      workspaceContext: {
        workspacePath: environment.path,
        workspaceProvisionType: environment.workspaceProvisionType,
      },
      cols: args.payload.cols,
      rows: args.payload.rows,
    };

    const pendingOpen = this.waitForTerminalOpen({
      daemonSessionId: daemonSession.id,
      requestId,
      terminalId: startingSession.id,
    });
    const sent = this.options.hub.sendDaemonSessionMessage(
      daemonSession.id,
      openMessage,
    );
    if (!sent) {
      this.cancelPendingOpen(requestId);
      const exited = markTerminalSessionExited(this.options.db, {
        terminalId: startingSession.id,
        exitCode: null,
        closeReason: "daemon-disconnect",
      });
      if (exited) {
        this.notifyThreadTerminalsChanged(exited.threadId);
      }
      throw new ApiError(
        502,
        "host_disconnected",
        `Host is not connected for terminal ${exited?.id ?? startingSession.id}`,
      );
    }

    let opened: TerminalOpenedMessage;
    try {
      opened = await pendingOpen;
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.body.code === "terminal_open_timeout"
      ) {
        const exited = markTerminalSessionExited(this.options.db, {
          terminalId: startingSession.id,
          exitCode: null,
          closeReason: "open-timeout",
        });
        if (exited) {
          this.notifyThreadTerminalsChanged(exited.threadId);
        }
        this.options.hub.sendDaemonSessionMessage(daemonSession.id, {
          type: "terminal.close",
          terminalId: startingSession.id,
          reason: "open-timeout",
        });
      } else if (
        !(error instanceof ApiError) ||
        error.body.code !== "host_disconnected"
      ) {
        const exited = markTerminalSessionExited(this.options.db, {
          terminalId: startingSession.id,
          exitCode: null,
          closeReason: "process-exit",
        });
        if (exited) {
          this.notifyThreadTerminalsChanged(exited.threadId);
        }
      }
      throw error;
    }

    const runningSession = markTerminalSessionRunning(this.options.db, {
      cols: opened.cols,
      currentCwd: opened.currentCwd,
      daemonSessionId: daemonSession.id,
      initialCwd: opened.initialCwd,
      rows: opened.rows,
      terminalId: startingSession.id,
      title: opened.title,
    });
    if (!runningSession) {
      this.closeStaleOpenedTerminal({
        daemonSessionId: daemonSession.id,
        terminalId: startingSession.id,
        threadId: thread.id,
      });
      throw new ApiError(
        409,
        "terminal_open_cancelled",
        "Terminal session was cancelled before it opened",
      );
    }
    this.notifyThreadTerminalsChanged(runningSession.threadId);
    return toTerminalSession(runningSession);
  }

  renameThreadTerminal(args: RenameThreadTerminalArgs): TerminalSession {
    requirePublicThread(this.options.db, args.threadId);
    const renamed = updateTerminalSessionTitle(this.options.db, {
      terminalId: args.terminalId,
      threadId: args.threadId,
      title: args.payload.title,
    });
    if (!renamed) {
      throw new ApiError(
        404,
        "terminal_not_found",
        "Terminal session not found",
      );
    }
    this.notifyThreadTerminalsChanged(renamed.threadId);
    const session = toTerminalSession(renamed);
    this.options.hub.sendTerminalClientMessage(renamed.id, {
      type: "session-updated",
      session,
    });
    return session;
  }

  closeThreadTerminal(args: CloseThreadTerminalArgs): TerminalSession {
    requirePublicThread(this.options.db, args.threadId);
    const current = getTerminalSessionForThread(this.options.db, {
      terminalId: args.terminalId,
      threadId: args.threadId,
    });
    if (!current) {
      throw new ApiError(
        404,
        "terminal_not_found",
        "Terminal session not found",
      );
    }
    if (current.status === "exited") {
      return toTerminalSession(current);
    }
    if (args.payload.mode === "if-clean" && current.lastUserInputAt !== null) {
      return toTerminalSession(current);
    }
    if (
      current.daemonSessionId !== null &&
      (current.status === "starting" || current.status === "running")
    ) {
      this.options.hub.sendDaemonSessionMessage(current.daemonSessionId, {
        type: "terminal.close",
        terminalId: current.id,
        reason: args.payload.reason,
      });
    }
    const closed = markTerminalSessionExited(this.options.db, {
      terminalId: current.id,
      exitCode: current.exitCode,
      closeReason: args.payload.reason,
    });
    const session = closed ?? current;
    const terminalSession = toTerminalSession(session);
    this.notifyExitedTerminalSession({
      session,
      code: "terminal_closed",
      message: "Terminal session closed",
    });
    return terminalSession;
  }

  closeDeletedThreadTerminals(args: CloseDeletedThreadTerminalsArgs): void {
    const currentSessions = listTerminalSessionsByThread(
      this.options.db,
      args.threadId,
    );
    this.requestTerminalCloses({
      closeReason: "thread-deleted",
      sessions: currentSessions,
    });
    const exitedSessions = markThreadTerminalSessionsExited(this.options.db, {
      threadId: args.threadId,
      closeReason: "thread-deleted",
    });
    this.publishLifecycleTerminalExits({
      code: "terminal_closed",
      message: "Terminal session closed because the thread was deleted",
      previousSessionsById: buildTerminalSessionMap(currentSessions),
      sessions: exitedSessions,
    });
  }

  closeArchivedThreadTerminals(args: CloseArchivedThreadTerminalsArgs): void {
    const currentSessions = listTerminalSessionsByThread(
      this.options.db,
      args.threadId,
    );
    this.requestTerminalCloses({
      closeReason: "thread-archived",
      sessions: currentSessions,
    });
    const exitedSessions = markThreadTerminalSessionsExited(this.options.db, {
      threadId: args.threadId,
      closeReason: "thread-archived",
    });
    this.publishLifecycleTerminalExits({
      code: "terminal_closed",
      message: "Terminal session closed because the thread was archived",
      previousSessionsById: buildTerminalSessionMap(currentSessions),
      sessions: exitedSessions,
    });
  }

  closeDestroyedEnvironmentTerminals(
    args: CloseDestroyedEnvironmentTerminalsArgs,
  ): void {
    const currentSessions = listTerminalSessionsByEnvironment(
      this.options.db,
      args.environmentId,
    );
    this.requestTerminalCloses({
      closeReason: "environment-destroyed",
      sessions: currentSessions,
    });
    const exitedSessions = markEnvironmentTerminalSessionsExited(
      this.options.db,
      {
        environmentId: args.environmentId,
        closeReason: "environment-destroyed",
      },
    );
    this.publishLifecycleTerminalExits({
      code: "terminal_closed",
      message: "Terminal session closed because the environment was destroyed",
      previousSessionsById: buildTerminalSessionMap(currentSessions),
      sessions: exitedSessions,
    });
  }

  expireDisconnectedHostTerminals(
    args: ExpireDisconnectedHostTerminalsArgs,
  ): void {
    // Terminal v1 does not preserve PTYs across daemon websocket replacement.
    // Any terminal owned by the disconnected session is expired and the new
    // daemon is asked to close a stale PTY if it still exists locally.
    const exitedSessions = markHostDisconnectedTerminalSessionsExited(
      this.options.db,
      {
        hostId: args.hostId,
        closeReason: "daemon-disconnect",
      },
    );
    for (const session of exitedSessions) {
      this.options.hub.sendDaemonSessionMessage(args.daemonSessionId, {
        type: "terminal.close",
        terminalId: session.id,
        reason: "daemon-disconnect",
      });
      this.notifyExitedTerminalSession({
        session,
        code: "host_disconnected",
        message: "Host disconnected from terminal session",
      });
    }
  }

  attachBrowserTerminal(args: AttachBrowserTerminalArgs): void {
    requirePublicThread(this.options.db, args.threadId);
    const current = getTerminalSessionForThread(this.options.db, {
      terminalId: args.terminalId,
      threadId: args.threadId,
    });
    if (!current) {
      throw new ApiError(
        404,
        "terminal_not_found",
        "Terminal session not found",
      );
    }

    this.options.hub.registerTerminalClient(current.id, args.socket);
    const session = toTerminalSession(current);
    if (current.status !== "running" || current.daemonSessionId === null) {
      this.options.hub.sendTerminalSocketMessage(args.socket, {
        type: "attached",
        session,
        nextSeq: 0,
      });
      if (current.status === "exited") {
        this.options.hub.sendTerminalSocketMessage(args.socket, {
          type: "exited",
          session,
        });
      } else {
        this.sendTerminalSocketError({
          socket: args.socket,
          code: "terminal_not_running",
          message: "Terminal session is not running",
        });
      }
      return;
    }

    const requestId = randomUUID();
    this.waitForTerminalAttach({
      daemonSessionId: current.daemonSessionId,
      requestId,
      socket: args.socket,
      terminalId: current.id,
      threadId: args.threadId,
    });
    const sent = this.options.hub.sendDaemonSessionMessage(
      current.daemonSessionId,
      {
        type: "terminal.attach",
        requestId,
        terminalId: current.id,
        sinceSeq: 0,
      },
    );
    if (!sent) {
      this.cancelPendingAttach(requestId);
      this.sendTerminalSocketError({
        socket: args.socket,
        code: "host_disconnected",
        message: "Host is not connected",
      });
      this.disconnectDaemonSessionTerminals({
        daemonSessionId: current.daemonSessionId,
      });
    }
  }

  detachBrowserTerminal(args: DetachBrowserTerminalArgs): void {
    this.options.hub.unregisterTerminalClient(args.terminalId, args.socket);
    for (const [requestId, pending] of this.pendingAttaches) {
      if (
        pending.terminalId === args.terminalId &&
        pending.socket === args.socket
      ) {
        clearTimeout(pending.timeout);
        this.pendingAttaches.delete(requestId);
      }
    }
  }

  handleBrowserTerminalMessage(args: HandleBrowserTerminalMessageArgs): void {
    switch (args.message.type) {
      case "ping":
        this.options.hub.sendTerminalSocketMessage(args.socket, {
          type: "pong",
        });
        return;
      case "input":
        this.forwardBrowserTerminalInput(args);
        return;
      case "resize":
        this.resizeBrowserTerminal(args);
        return;
      case "close":
        this.closeThreadTerminal({
          threadId: args.threadId,
          terminalId: args.terminalId,
          payload: { mode: "force", reason: args.message.reason },
        });
        return;
    }
  }

  handleDaemonTerminalMessage(args: HandleDaemonTerminalMessageArgs): void {
    switch (args.message.type) {
      case "heartbeat":
        return;
      case "terminal.opened":
        this.resolvePendingOpen({
          daemonSessionId: args.sessionId,
          message: args.message,
        });
        return;
      case "terminal.error":
        this.rejectPendingOpen({
          daemonSessionId: args.sessionId,
          message: args.message,
        });
        this.rejectPendingAttach({
          daemonSessionId: args.sessionId,
          message: args.message,
        });
        return;
      case "terminal.exited":
        const exited = markDaemonTerminalSessionExited(this.options.db, {
          terminalId: args.message.terminalId,
          daemonSessionId: args.sessionId,
          exitCode: args.message.exitCode,
          closeReason: args.message.closeReason,
        });
        if (exited) {
          this.notifyThreadTerminalsChanged(exited.threadId);
          const session = toTerminalSession(exited);
          this.options.hub.sendTerminalClientMessage(exited.id, {
            type: "exited",
            session,
          });
          this.rejectPendingAttachesForTerminal({
            terminalId: exited.id,
            code: "terminal_exited",
            message: "Terminal session exited",
          });
        }
        return;
      case "terminal.output":
        this.options.hub.sendTerminalClientMessage(args.message.terminalId, {
          type: "output",
          chunk: toTerminalOutputChunk(args.message.chunk),
        });
        return;
      case "terminal.replay":
        this.resolvePendingAttach({
          daemonSessionId: args.sessionId,
          message: args.message,
        });
        return;
    }
  }

  handleDaemonSessionClosed(args: HandleDaemonSessionClosedArgs): void {
    this.disconnectDaemonSessionTerminals({ daemonSessionId: args.sessionId });
  }

  private requestTerminalCloses(args: RequestTerminalClosesArgs): void {
    for (const session of args.sessions) {
      const target = getTerminalDaemonCloseTarget(session);
      if (!target) {
        continue;
      }
      this.options.hub.sendDaemonSessionMessage(target.daemonSessionId, {
        type: "terminal.close",
        terminalId: target.terminalId,
        reason: args.closeReason,
      });
    }
  }

  private closeStaleOpenedTerminal(args: CloseStaleOpenedTerminalArgs): void {
    const current = getTerminalSessionForThread(this.options.db, {
      terminalId: args.terminalId,
      threadId: args.threadId,
    });
    this.options.hub.sendDaemonSessionMessage(args.daemonSessionId, {
      type: "terminal.close",
      terminalId: args.terminalId,
      reason: current?.closeReason ?? "daemon-disconnect",
    });
  }

  private publishLifecycleTerminalExits(
    args: PublishLifecycleTerminalExitsArgs,
  ): void {
    for (const session of args.sessions) {
      const previousSession = args.previousSessionsById.get(session.id);
      if (previousSession?.daemonSessionId) {
        this.rejectPendingOpenForTerminal({
          daemonSessionId: previousSession.daemonSessionId,
          terminalId: session.id,
          status: 409,
          code: args.code,
          message: args.message,
        });
      }
      this.notifyExitedTerminalSession({
        session,
        code: args.code,
        message: args.message,
      });
    }
  }

  private notifyExitedTerminalSession(
    args: NotifyExitedTerminalSessionArgs,
  ): void {
    this.notifyThreadTerminalsChanged(args.session.threadId);
    this.options.hub.sendTerminalClientMessage(args.session.id, {
      type: "exited",
      session: toTerminalSession(args.session),
    });
    this.rejectPendingAttachesForTerminal({
      terminalId: args.session.id,
      code: args.code,
      message: args.message,
    });
  }

  private forwardBrowserTerminalInput(
    args: HandleBrowserTerminalMessageArgs,
  ): void {
    if (args.message.type !== "input") {
      return;
    }
    const current = this.getRunningBrowserTerminal(args);
    if (!current) {
      return;
    }
    const markedInput = markTerminalSessionUserInput(this.options.db, {
      terminalId: current.id,
      threadId: args.threadId,
    });
    if (markedInput) {
      const session = toTerminalSession(markedInput);
      this.notifyThreadTerminalsChanged(markedInput.threadId);
      this.options.hub.sendTerminalClientMessage(markedInput.id, {
        type: "session-updated",
        session,
      });
    }
    const sent = this.options.hub.sendDaemonSessionMessage(
      current.daemonSessionId,
      {
        type: "terminal.input",
        terminalId: current.id,
        dataBase64: args.message.dataBase64,
      },
    );
    if (!sent) {
      this.sendTerminalSocketError({
        socket: args.socket,
        code: "host_disconnected",
        message: "Host is not connected",
      });
      this.disconnectDaemonSessionTerminals({
        daemonSessionId: current.daemonSessionId,
      });
    }
  }

  private resizeBrowserTerminal(args: HandleBrowserTerminalMessageArgs): void {
    if (args.message.type !== "resize") {
      return;
    }
    const current = this.getRunningBrowserTerminal(args);
    if (!current) {
      return;
    }
    if (current.cols !== args.message.cols || current.rows !== args.message.rows) {
      const resized = updateTerminalSessionSize(this.options.db, {
        cols: args.message.cols,
        rows: args.message.rows,
        terminalId: current.id,
        threadId: args.threadId,
      });
      if (resized) {
        const session = toTerminalSession(resized);
        this.notifyThreadTerminalsChanged(resized.threadId);
        this.options.hub.sendTerminalClientMessage(resized.id, {
          type: "session-updated",
          session,
        });
      }
    }
    const sent = this.options.hub.sendDaemonSessionMessage(
      current.daemonSessionId,
      {
        type: "terminal.resize",
        terminalId: current.id,
        cols: args.message.cols,
        rows: args.message.rows,
      },
    );
    if (!sent) {
      this.sendTerminalSocketError({
        socket: args.socket,
        code: "host_disconnected",
        message: "Host is not connected",
      });
      this.disconnectDaemonSessionTerminals({
        daemonSessionId: current.daemonSessionId,
      });
    }
  }

  private getRunningBrowserTerminal(
    args: GetRunningBrowserTerminalArgs,
  ): RunningBrowserTerminalSession | null {
    requirePublicThread(this.options.db, args.threadId);
    const current = getTerminalSessionForThread(this.options.db, {
      terminalId: args.terminalId,
      threadId: args.threadId,
    });
    if (!current) {
      this.sendTerminalSocketError({
        socket: args.socket,
        code: "terminal_not_found",
        message: "Terminal session not found",
      });
      return null;
    }
    if (!isRunningBrowserTerminalSession(current)) {
      this.sendTerminalSocketError({
        socket: args.socket,
        code: "terminal_not_running",
        message: "Terminal session is not running",
      });
      return null;
    }
    return current;
  }

  private disconnectDaemonSessionTerminals(
    args: DisconnectDaemonSessionTerminalsArgs,
  ): void {
    const disconnected = markDaemonTerminalSessionsDisconnected(this.options.db, {
      daemonSessionId: args.daemonSessionId,
    });
    for (const session of disconnected) {
      this.rejectPendingOpenForTerminal({
        daemonSessionId: args.daemonSessionId,
        terminalId: session.id,
        status: 502,
        code: "host_disconnected",
        message: "Host disconnected while opening terminal session",
      });
      this.rejectPendingAttachesForTerminal({
        terminalId: session.id,
        code: "host_disconnected",
        message: "Host disconnected from terminal session",
      });
      this.options.logger.info(
        { terminalId: session.id, sessionId: args.daemonSessionId },
        "Terminal session disconnected with daemon session",
      );
      this.notifyThreadTerminalsChanged(session.threadId);
      this.options.hub.sendTerminalClientMessage(session.id, {
        type: "session-updated",
        session: toTerminalSession(session),
      });
    }
  }

  private waitForTerminalOpen(
    args: WaitForTerminalOpenArgs,
  ): Promise<TerminalOpenedMessage> {
    return new Promise<TerminalOpenedMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingOpens.delete(args.requestId);
        reject(
          new ApiError(
            504,
            "terminal_open_timeout",
            "Timed out opening terminal session",
          ),
        );
      }, this.openTimeoutMs);
      this.pendingOpens.set(args.requestId, {
        daemonSessionId: args.daemonSessionId,
        reject,
        resolve,
        timeout,
        terminalId: args.terminalId,
      });
    });
  }

  private waitForTerminalAttach(args: WaitForTerminalAttachArgs): void {
    const timeout = setTimeout(() => {
      this.pendingAttaches.delete(args.requestId);
      this.sendTerminalSocketError({
        socket: args.socket,
        code: "terminal_attach_timeout",
        message: "Timed out attaching terminal session",
      });
    }, this.attachTimeoutMs);
    this.pendingAttaches.set(args.requestId, {
      daemonSessionId: args.daemonSessionId,
      socket: args.socket,
      terminalId: args.terminalId,
      threadId: args.threadId,
      timeout,
    });
  }

  private cancelPendingOpen(requestId: string): void {
    const pending = this.pendingOpens.get(requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingOpens.delete(requestId);
  }

  private cancelPendingAttach(requestId: string): void {
    const pending = this.pendingAttaches.get(requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingAttaches.delete(requestId);
  }

  private resolvePendingOpen(args: ResolvePendingOpenArgs): void {
    const pending = this.pendingOpens.get(args.message.requestId);
    if (
      !pending ||
      pending.terminalId !== args.message.terminalId ||
      pending.daemonSessionId !== args.daemonSessionId
    ) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingOpens.delete(args.message.requestId);
    pending.resolve(args.message);
  }

  private resolvePendingAttach(args: ResolvePendingAttachArgs): void {
    const pending = this.pendingAttaches.get(args.message.requestId);
    if (
      !pending ||
      pending.terminalId !== args.message.terminalId ||
      pending.daemonSessionId !== args.daemonSessionId
    ) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingAttaches.delete(args.message.requestId);

    const current = getTerminalSessionForThread(this.options.db, {
      terminalId: pending.terminalId,
      threadId: pending.threadId,
    });
    if (!current) {
      this.sendTerminalSocketError({
        socket: pending.socket,
        code: "terminal_not_found",
        message: "Terminal session not found",
      });
      return;
    }

    this.options.hub.sendTerminalSocketMessage(pending.socket, {
      type: "attached",
      session: toTerminalSession(current),
      nextSeq: args.message.nextSeq,
    });
    for (const chunk of args.message.chunks) {
      this.options.hub.sendTerminalSocketMessage(pending.socket, {
        type: "output",
        chunk: toTerminalOutputChunk(chunk),
      });
    }
  }

  private rejectPendingOpen(args: RejectPendingOpenArgs): void {
    const pending = this.pendingOpens.get(args.message.requestId);
    if (
      !pending ||
      pending.terminalId !== args.message.terminalId ||
      pending.daemonSessionId !== args.daemonSessionId
    ) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingOpens.delete(args.message.requestId);
    pending.reject(
      new ApiError(
        502,
        args.message.code,
        `Terminal failed to open: ${args.message.message}`,
      ),
    );
  }

  private rejectPendingAttach(args: RejectPendingAttachArgs): void {
    const pending = this.pendingAttaches.get(args.message.requestId);
    if (
      !pending ||
      pending.terminalId !== args.message.terminalId ||
      pending.daemonSessionId !== args.daemonSessionId
    ) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingAttaches.delete(args.message.requestId);
    this.sendTerminalSocketError({
      socket: pending.socket,
      code: args.message.code,
      message: args.message.message,
    });
  }

  private rejectPendingOpenForTerminal(
    args: RejectPendingOpenForTerminalArgs,
  ): void {
    for (const [requestId, pending] of this.pendingOpens) {
      if (
        pending.daemonSessionId !== args.daemonSessionId ||
        pending.terminalId !== args.terminalId
      ) {
        continue;
      }
      clearTimeout(pending.timeout);
      this.pendingOpens.delete(requestId);
      pending.reject(
        new ApiError(args.status, args.code, args.message),
      );
    }
  }

  private rejectPendingAttachesForTerminal(
    args: RejectPendingAttachesForTerminalArgs,
  ): void {
    for (const [requestId, pending] of this.pendingAttaches) {
      if (pending.terminalId !== args.terminalId) {
        continue;
      }
      clearTimeout(pending.timeout);
      this.pendingAttaches.delete(requestId);
      this.sendTerminalSocketError({
        socket: pending.socket,
        code: args.code,
        message: args.message,
      });
    }
  }

  private sendTerminalSocketError(args: SendTerminalSocketErrorArgs): void {
    this.options.hub.sendTerminalSocketMessage(args.socket, {
      type: "error",
      code: args.code,
      message: args.message,
    });
  }

  private notifyThreadTerminalsChanged(threadId: string): void {
    this.options.hub.notifyThread(threadId, ["terminals-changed"]);
  }
}

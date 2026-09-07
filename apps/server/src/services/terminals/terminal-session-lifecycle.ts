import { randomUUID } from "node:crypto";
import {
  createTerminalSession,
  getTerminalSession,
  listTerminalSessions,
  updateTerminalSession,
  updateTerminalSessions,
  type TerminalSessionMutation,
  type TerminalSessionRow,
} from "@bb/db";
import type { TerminalSessionCloseReason } from "@bb/domain";
import type {
  HostDaemonDaemonWsMessage,
  HostDaemonServerWsMessage,
} from "@bb/host-daemon-contract";
import type {
  CloseTerminalRequest,
  CreateTerminalRequest,
  TerminalClientMessage,
  TerminalInputRequest,
  TerminalCreateTarget,
  TerminalListQuery,
  TerminalOutputChunk,
  TerminalOutputQuery,
  TerminalOutputResponse,
  TerminalResizeRequest,
  TerminalSession,
  UpdateTerminalRequest,
} from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type { AppDeps, ServerLogger } from "../../types.js";
import { assertUsableHostId } from "../hosts/primary-host.js";
import {
  requireConnectedHostSession,
  requireEnvironment,
  requirePublicThread,
  requireReadyEnvironment,
} from "../lib/entity-lookup.js";
import {
  threadEnvironmentUnavailableDetails,
  throwThreadEnvironmentUnavailable,
} from "../lib/lifecycle-api-errors.js";
import { requireWorkspaceCommandTarget } from "../environments/workspace-command-target.js";
import {
  type PendingRpcKey,
  PendingRpcRegistry,
} from "./pending-rpc-registry.js";

const DEFAULT_TERMINAL_OPEN_TIMEOUT_MS = 10_000;
const DEFAULT_TERMINAL_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_TERMINAL_START: NonNullable<CreateTerminalRequest["start"]> = {
  mode: "shell",
};
const HOST_HOME_INITIAL_CWD = "~";
const BROWSER_TERMINAL_REPLAY_MAX_BYTES = 512 * 1024;
const TERMINAL_SCROLLBACK_MAX_BYTES = 4 * 1024 * 1024;
const TERMINAL_ATTACH_CANCELLED = new Error("Terminal attach cancelled");
const DAEMON_OWNED_TERMINAL_STATUSES = ["starting", "running"] as const;
const NON_TERMINAL_SESSION_STATUSES = [
  ...DAEMON_OWNED_TERMINAL_STATUSES,
  "disconnected",
] as const;

type TerminalOpenedMessage = Extract<
  HostDaemonDaemonWsMessage,
  { type: "terminal.opened" }
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

interface PendingTerminalRpcKey extends PendingRpcKey {
  daemonSessionId: string;
  requestId: string;
  terminalId: string;
}

interface PendingTerminalCloseKey extends PendingRpcKey {
  closeReason: TerminalSessionCloseReason;
  daemonSessionId: string;
  terminalId: string;
}

interface PendingTerminalAttachKey extends PendingTerminalRpcKey {
  socket: TerminalClientSocket;
  threadId: string | null;
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

type TerminalDaemonOpenTarget = Extract<
  HostDaemonServerWsMessage,
  { type: "terminal.open" }
>["target"];
type TerminalLaunchTarget = Exclude<TerminalCreateTarget, { kind: "thread" }>;

interface ResolvedTerminalLaunchTarget {
  daemonTarget: TerminalDaemonOpenTarget;
  environmentId: string | null;
  hostId: string;
  initialCwd: string;
}

interface AttachBrowserTerminalArgs {
  socket: TerminalClientSocket;
  sinceSeq: number;
  terminalId: string;
  threadId: string | null;
}

interface DetachBrowserTerminalArgs {
  socket: TerminalClientSocket;
  terminalId: string;
}

interface HandleBrowserTerminalMessageArgs {
  message: TerminalClientMessage;
  socket: TerminalClientSocket;
  terminalId: string;
  threadId: string | null;
}

interface SendTerminalInputArgs {
  payload: TerminalInputRequest;
  terminalId: string;
}

interface ResizeTerminalArgs {
  payload: TerminalResizeRequest;
  terminalId: string;
}

interface ReadTerminalOutputArgs {
  query: TerminalOutputQuery;
  terminalId: string;
}

interface GetRunningBrowserTerminalArgs {
  socket: TerminalClientSocket;
  terminalId: string;
  threadId: string | null;
}

interface GetBrowserTerminalSessionArgs {
  reportMissing?: boolean;
  socket: TerminalClientSocket;
  terminalId: string;
  threadId: string | null;
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
}

interface PublishLifecycleTerminalExitsForSessionsArgs {
  currentSessions: TerminalSessionRow[];
  exitedSessions: TerminalSessionRow[];
  message: string;
}

interface CloseThreadTerminalsForLifecycleArgs {
  closeReason: TerminalSessionCloseReason;
  message: string;
  threadId: string;
}

interface TerminalSessionLifecycleOptions {
  attachTimeoutMs?: number;
  closeTimeoutMs?: number;
  config: AppDeps["config"];
  db: AppDeps["db"];
  hub: AppDeps["hub"];
  logger: ServerLogger;
  openTimeoutMs?: number;
}

interface ListTerminalsArgs {
  query: TerminalListQuery;
}

interface CreateTerminalArgs {
  payload: CreateTerminalRequest;
}

interface GetTerminalArgs {
  terminalId: string;
}

interface TerminalCreatePayload {
  cols: number;
  rows: number;
  start?: NonNullable<CreateTerminalRequest["start"]>;
  title?: string;
}

interface CreateTerminalForTargetArgs {
  payload: TerminalCreatePayload;
  target: TerminalLaunchTarget;
  threadId: string | null;
  title: string;
}

interface RenameTerminalArgs {
  payload: UpdateTerminalRequest;
  terminalId: string;
}

interface CloseTerminalArgs {
  payload: CloseTerminalRequest;
  terminalId: string;
}

interface RestartTerminalArgs {
  terminalId: string;
}

interface CloseTerminalSessionArgs {
  current: TerminalSessionRow;
  payload: CloseTerminalRequest;
}

interface CloseDeletedThreadTerminalsArgs {
  threadId: string;
}

interface CloseArchivedThreadTerminalsArgs {
  threadId: string;
}

interface CloseDestroyedEnvironmentTerminalsArgs {
  environmentId: string;
}

interface ExpireDisconnectedHostTerminalsArgs {
  daemonSessionId: string;
  hostId: string;
}

interface HandleDaemonTerminalMessageArgs {
  hostId: string;
  message: HostDaemonDaemonWsMessage;
  sessionId: string;
}

interface HandleDaemonSessionClosedArgs {
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

function terminalRpcKey(
  daemonSessionId: string,
  terminalId: string,
  requestId: string,
): string {
  return `${daemonSessionId}\0${terminalId}\0${requestId}`;
}

function terminalResponseRpcKey(
  daemonSessionId: string,
  message: { requestId: string; terminalId: string },
): string {
  return terminalRpcKey(daemonSessionId, message.terminalId, message.requestId);
}

function terminalTimeoutError(code: string, message: string): () => ApiError {
  return () => new ApiError(504, code, message);
}

function titleFromCommand(command: string): string {
  const normalized = command.trim().replace(/\s+/g, " ");
  if (normalized.length <= 80) {
    return normalized;
  }
  return `${normalized.slice(0, 77)}...`;
}

function initialTitleForTerminal(
  payload: TerminalCreatePayload,
  existingSessionCount: number,
): string {
  if (payload.title !== undefined) {
    return payload.title;
  }
  if (payload.start?.mode === "command") {
    return titleFromCommand(payload.start.command);
  }
  return `Terminal ${existingSessionCount + 1}`;
}

interface BoundedTerminalOutput {
  chunks: TerminalOutputChunk[];
  truncated: boolean;
}

function applyTerminalOutputBounds(args: {
  chunks: readonly TerminalOutputChunk[];
  query: TerminalOutputQuery;
  replayNextSeq: number;
  requestedSinceSeq: number;
}): BoundedTerminalOutput {
  const { chunks, query, replayNextSeq, requestedSinceSeq } = args;
  const limitedByChunks =
    query.limitChunks === undefined ? chunks : chunks.slice(-query.limitChunks);
  let truncated =
    limitedByChunks.length < chunks.length ||
    (chunks[0]?.seq ?? replayNextSeq) > requestedSinceSeq;
  if (query.tailBytes === undefined) {
    return { chunks: [...limitedByChunks], truncated };
  }

  const bounded: TerminalOutputChunk[] = [];
  let byteLength = 0;
  for (let index = limitedByChunks.length - 1; index >= 0; index -= 1) {
    const chunk = limitedByChunks[index];
    const chunkByteLength = Buffer.byteLength(chunk.dataBase64, "base64");
    if (bounded.length > 0 && byteLength + chunkByteLength > query.tailBytes) {
      truncated = true;
      break;
    }
    bounded.unshift(chunk);
    byteLength += chunkByteLength;
    if (byteLength >= query.tailBytes) {
      truncated = truncated || index > 0;
      break;
    }
  }
  if (bounded.length < limitedByChunks.length) {
    truncated = true;
  }
  return { chunks: bounded, truncated };
}

function isRunningBrowserTerminalSession(
  row: TerminalSessionRow,
): row is RunningBrowserTerminalSession {
  return row.status === "running" && row.daemonSessionId !== null;
}

function terminalRestartTarget(row: TerminalSessionRow): TerminalCreateTarget {
  if (row.threadId !== null) {
    return { kind: "thread", threadId: row.threadId };
  }
  if (row.environmentId !== null) {
    return { kind: "environment", environmentId: row.environmentId };
  }
  return {
    kind: "host_path",
    hostId: row.hostId,
    cwd: row.initialCwd === HOST_HOME_INITIAL_CWD ? null : row.initialCwd,
  };
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

function toTerminalSession(row: TerminalSessionRow): TerminalSession {
  return {
    id: row.id,
    threadId: row.threadId,
    environmentId: row.environmentId,
    hostId: row.hostId,
    title: row.title,
    initialCwd: row.initialCwd,
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

function getTerminalById(
  db: AppDeps["db"],
  terminalId: string,
): TerminalSessionRow | null {
  return getTerminalSession(db, { kind: "terminal", terminalId });
}

function updateTerminalById(
  db: AppDeps["db"],
  terminalId: string,
  update: TerminalSessionMutation,
): TerminalSessionRow | null {
  return updateTerminalSession(db, {
    scope: { kind: "terminal", terminalId },
    update,
  });
}

export class TerminalSessionLifecycle {
  private readonly pendingAttaches: PendingRpcRegistry<
    PendingTerminalAttachKey,
    TerminalReplayMessage
  >;
  private readonly pendingCloses: PendingRpcRegistry<
    PendingTerminalCloseKey,
    TerminalSessionRow
  >;
  private readonly pendingOutputReads: PendingRpcRegistry<
    PendingTerminalRpcKey,
    TerminalReplayMessage
  >;
  private readonly pendingOpens: PendingRpcRegistry<
    PendingTerminalRpcKey,
    TerminalOpenedMessage
  >;
  private readonly pendingRestarts: PendingRpcRegistry<
    PendingRpcKey,
    TerminalSession
  >;

  constructor(private readonly options: TerminalSessionLifecycleOptions) {
    const attachTimeoutMs =
      options.attachTimeoutMs ?? DEFAULT_TERMINAL_OPEN_TIMEOUT_MS;
    const closeTimeoutMs =
      options.closeTimeoutMs ?? DEFAULT_TERMINAL_CLOSE_TIMEOUT_MS;
    const openTimeoutMs =
      options.openTimeoutMs ?? DEFAULT_TERMINAL_OPEN_TIMEOUT_MS;
    this.pendingAttaches = new PendingRpcRegistry<
      PendingTerminalAttachKey,
      TerminalReplayMessage
    >({
      onFail: (key, error) => this.failTerminalAttach(key, error),
      onSettle: (key, message) => this.completePendingAttach(key, message),
      timeoutMs: attachTimeoutMs,
      timeoutError: terminalTimeoutError(
        "terminal_attach_timeout",
        "Timed out attaching terminal session",
      ),
    });
    this.pendingCloses = new PendingRpcRegistry<
      PendingTerminalCloseKey,
      TerminalSessionRow
    >({
      onFail: (pending, error) =>
        this.finalizeTimedOutTerminalClose(pending, error),
      timeoutMs: closeTimeoutMs,
      timeoutError: terminalTimeoutError(
        "terminal_close_timeout",
        "Timed out waiting for terminal process to exit",
      ),
    });
    this.pendingOutputReads = new PendingRpcRegistry({
      timeoutMs: attachTimeoutMs,
      timeoutError: terminalTimeoutError(
        "terminal_output_timeout",
        "Timed out reading terminal output",
      ),
    });
    this.pendingOpens = new PendingRpcRegistry({
      timeoutMs: openTimeoutMs,
      timeoutError: terminalTimeoutError(
        "terminal_open_timeout",
        "Timed out opening terminal session",
      ),
    });
    this.pendingRestarts = new PendingRpcRegistry({
      timeoutMs: null,
    });
  }

  listTerminals(args: ListTerminalsArgs): TerminalSession[] {
    const { query } = args;
    if (query.threadId !== undefined) {
      requirePublicThread(this.options.db, query.threadId);
      return listTerminalSessions(this.options.db, {
        scope: { kind: "thread", threadId: query.threadId },
        visible: true,
      }).map(toTerminalSession);
    }
    if (query.environmentId !== undefined) {
      requireEnvironment(this.options.db, query.environmentId);
      return listTerminalSessions(this.options.db, {
        scope: {
          environmentId: query.environmentId,
          kind: "threadless-environment",
        },
        visible: true,
      }).map(toTerminalSession);
    }
    const hostId = query.hostId;
    if (hostId === undefined) {
      return [];
    }
    assertUsableHostId(
      {
        config: this.options.config,
        db: this.options.db,
        hub: this.options.hub,
      },
      { hostId },
    );
    return listTerminalSessions(this.options.db, {
      scope: { kind: "all" },
      visible: true,
    })
      .filter(
        (session) =>
          session.threadId === null &&
          session.environmentId === null &&
          session.hostId === hostId &&
          (query.cwd === undefined || session.initialCwd === query.cwd),
      )
      .map(toTerminalSession);
  }

  getTerminal(args: GetTerminalArgs): TerminalSession {
    const session = getTerminalById(this.options.db, args.terminalId);
    if (!session) {
      throw new ApiError(
        404,
        "terminal_not_found",
        "Terminal session not found",
      );
    }
    return toTerminalSession(session);
  }

  async createTerminal(args: CreateTerminalArgs): Promise<TerminalSession> {
    const { target } = args.payload;
    const existingSessionCount = this.countExistingSessionsForTarget(target);
    const launchTarget =
      target.kind === "thread"
        ? this.resolveThreadTerminalCreateTarget(target.threadId)
        : target;
    return this.createTerminalForTarget({
      payload: args.payload,
      target: launchTarget,
      threadId: target.kind === "thread" ? target.threadId : null,
      title: initialTitleForTerminal(args.payload, existingSessionCount),
    });
  }

  private countExistingSessionsForTarget(target: TerminalCreateTarget): number {
    switch (target.kind) {
      case "thread": {
        const thread = requirePublicThread(this.options.db, target.threadId);
        return listTerminalSessions(this.options.db, {
          scope: { kind: "thread", threadId: thread.id },
          visible: false,
        }).length;
      }
      case "environment":
        return listTerminalSessions(this.options.db, {
          scope: {
            environmentId: target.environmentId,
            kind: "threadless-environment",
          },
          visible: false,
        }).length;
      case "host_path":
        return listTerminalSessions(this.options.db, {
          scope: { kind: "all" },
          visible: true,
        }).filter(
          (session) =>
            session.threadId === null &&
            session.environmentId === null &&
            session.hostId === target.hostId &&
            (target.cwd === null || session.initialCwd === target.cwd),
        ).length;
    }
  }

  private resolveThreadTerminalCreateTarget(
    threadId: string,
  ): TerminalLaunchTarget {
    const thread = requirePublicThread(this.options.db, threadId);
    if (!thread.environmentId) {
      throwThreadEnvironmentUnavailable(
        threadEnvironmentUnavailableDetails("never_attached", null),
      );
    }
    return { kind: "environment", environmentId: thread.environmentId };
  }

  private async createTerminalForTarget(
    args: CreateTerminalForTargetArgs,
  ): Promise<TerminalSession> {
    const launchTarget = this.resolveTerminalLaunchTarget(args.target);
    const daemonSession = requireConnectedHostSession(
      this.options,
      launchTarget.hostId,
    );
    const start = args.payload.start ?? DEFAULT_TERMINAL_START;
    const startingSession = createTerminalSession(this.options.db, {
      cols: args.payload.cols,
      daemonSessionId: daemonSession.id,
      environmentId: launchTarget.environmentId,
      hostId: launchTarget.hostId,
      initialCwd: launchTarget.initialCwd,
      rows: args.payload.rows,
      status: "starting",
      threadId: args.threadId,
      title: args.title,
    });
    const requestId = randomUUID();
    const openMessage: HostDaemonServerWsMessage = {
      type: "terminal.open",
      requestId,
      terminalId: startingSession.id,
      ...(args.threadId !== null ? { threadId: args.threadId } : {}),
      target: launchTarget.daemonTarget,
      cols: args.payload.cols,
      rows: args.payload.rows,
      start,
    };

    const pendingOpenKey = terminalRpcKey(
      daemonSession.id,
      startingSession.id,
      requestId,
    );
    const pendingOpen = this.pendingOpens.claim({
      daemonSessionId: daemonSession.id,
      requestId,
      rpcKey: pendingOpenKey,
      terminalId: startingSession.id,
    }).promise;
    const sent = this.options.hub.sendDaemonSessionMessage(
      daemonSession.id,
      openMessage,
    );
    if (!sent) {
      this.pendingOpens.cancel(pendingOpenKey);
      const exited = updateTerminalById(this.options.db, startingSession.id, {
        closeReason: "daemon-disconnect",
        exitCode: null,
        kind: "exit",
      });
      if (exited) {
        this.notifyTerminalSessionChanged(exited);
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
        const exited = updateTerminalById(this.options.db, startingSession.id, {
          closeReason: "open-timeout",
          exitCode: null,
          kind: "exit",
        });
        if (exited) {
          this.notifyTerminalSessionChanged(exited);
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
        const exited = updateTerminalById(this.options.db, startingSession.id, {
          closeReason: "process-exit",
          exitCode: null,
          kind: "exit",
        });
        if (exited) {
          this.notifyTerminalSessionChanged(exited);
        }
      }
      throw error;
    }

    const runningSession = updateTerminalSession(this.options.db, {
      scope: {
        daemonSessionId: daemonSession.id,
        kind: "daemon",
        statuses: ["starting"],
        terminalId: startingSession.id,
      },
      update: {
        cols: opened.cols,
        daemonSessionId: daemonSession.id,
        initialCwd: opened.initialCwd,
        kind: "running",
        rows: opened.rows,
        title: args.payload.title ?? opened.title,
      },
    });
    if (!runningSession) {
      this.closeStaleOpenedTerminal({
        daemonSessionId: daemonSession.id,
        terminalId: startingSession.id,
      });
      throw new ApiError(
        409,
        "terminal_open_cancelled",
        "Terminal session was cancelled before it opened",
      );
    }
    this.notifyTerminalSessionChanged(runningSession);
    return toTerminalSession(runningSession);
  }

  private resolveTerminalLaunchTarget(
    target: TerminalLaunchTarget,
  ): ResolvedTerminalLaunchTarget {
    switch (target.kind) {
      case "environment": {
        const environment = requireReadyEnvironment(
          this.options.db,
          target.environmentId,
        );
        const workspaceTarget = requireWorkspaceCommandTarget(environment);
        return {
          daemonTarget: {
            kind: "workspace",
            environmentId: workspaceTarget.environmentId,
            workspaceContext: workspaceTarget.workspaceContext,
          },
          environmentId: environment.id,
          hostId: workspaceTarget.hostId,
          initialCwd: workspaceTarget.workspaceContext.workspacePath,
        };
      }
      case "host_path":
        assertUsableHostId(
          {
            config: this.options.config,
            db: this.options.db,
            hub: this.options.hub,
          },
          { hostId: target.hostId },
        );
        return {
          daemonTarget: {
            kind: "host_path",
            cwd: target.cwd,
          },
          environmentId: null,
          hostId: target.hostId,
          initialCwd: target.cwd ?? HOST_HOME_INITIAL_CWD,
        };
    }
  }

  renameTerminal(args: RenameTerminalArgs): TerminalSession {
    const renamed = updateTerminalById(this.options.db, args.terminalId, {
      kind: "title",
      title: args.payload.title,
    });
    if (!renamed) {
      throw new ApiError(
        404,
        "terminal_not_found",
        "Terminal session not found",
      );
    }
    this.notifyTerminalSessionChanged(renamed);
    const session = toTerminalSession(renamed);
    this.options.hub.sendTerminalClientMessage(renamed.id, {
      type: "session-updated",
      session,
    });
    return session;
  }

  async restartTerminal(args: RestartTerminalArgs): Promise<TerminalSession> {
    const pending = this.pendingRestarts.claim({ rpcKey: args.terminalId });
    if (pending.created) {
      void this.restartTerminalOnce(args.terminalId).then(
        (session) => this.pendingRestarts.settle(args.terminalId, session),
        (error) =>
          this.pendingRestarts.fail(
            args.terminalId,
            error instanceof Error ? error : new Error(String(error)),
          ),
      );
    }
    return pending.promise;
  }

  private async restartTerminalOnce(
    terminalId: string,
  ): Promise<TerminalSession> {
    const current = getTerminalById(this.options.db, terminalId);
    if (!current) {
      throw new ApiError(
        404,
        "terminal_not_found",
        "Terminal session not found",
      );
    }

    const replacement = await this.createTerminal({
      payload: {
        cols: current.cols,
        rows: current.rows,
        start: { mode: "shell" },
        target: terminalRestartTarget(current),
        title: current.title,
      },
    });
    if (current.status === "exited") {
      return replacement;
    }

    try {
      await this.closeTerminalSession({
        current,
        payload: { mode: "force", reason: "user" },
      });
    } catch (error) {
      const replacementRow = getTerminalById(this.options.db, replacement.id);
      if (replacementRow) {
        void this.closeTerminalSession({
          current: replacementRow,
          payload: { mode: "force", reason: "user" },
        }).catch((cleanupError) => {
          this.options.logger.warn(
            {
              err:
                cleanupError instanceof Error
                  ? cleanupError
                  : new Error(String(cleanupError)),
              terminalId: replacement.id,
            },
            "Failed to clean up replacement terminal after restart failure",
          );
        });
      }
      throw error;
    }
    return replacement;
  }

  async closeTerminal(args: CloseTerminalArgs): Promise<TerminalSession> {
    const current = getTerminalById(this.options.db, args.terminalId);
    if (!current) {
      throw new ApiError(
        404,
        "terminal_not_found",
        "Terminal session not found",
      );
    }
    return this.closeTerminalSession({
      current,
      payload: args.payload,
    });
  }

  private async closeTerminalSession(
    args: CloseTerminalSessionArgs,
  ): Promise<TerminalSession> {
    const current = args.current;
    if (current.status === "exited") {
      return toTerminalSession(current);
    }
    if (args.payload.mode === "if-clean" && current.lastUserInputAt !== null) {
      return toTerminalSession(current);
    }
    if (
      current.daemonSessionId === null ||
      (current.status !== "starting" && current.status !== "running")
    ) {
      return this.finishTerminalCloseWithoutDaemon({
        current,
        reason: args.payload.reason,
      });
    }

    const pending = this.pendingCloses.claim({
      closeReason: args.payload.reason,
      daemonSessionId: current.daemonSessionId,
      rpcKey: terminalRpcKey(current.daemonSessionId, current.id, current.id),
      terminalId: current.id,
    });
    if (pending.created) {
      const sent = this.options.hub.sendDaemonSessionMessage(
        current.daemonSessionId,
        {
          type: "terminal.close",
          terminalId: current.id,
          reason: args.payload.reason,
        },
      );
      if (!sent) {
        this.disconnectDaemonSessionTerminals({
          daemonSessionId: current.daemonSessionId,
        });
        this.rejectPendingClose(
          current.id,
          new ApiError(502, "host_disconnected", "Host is not connected"),
        );
      }
    }
    try {
      return toTerminalSession(await pending.promise);
    } catch (error) {
      const finalized = getTerminalById(this.options.db, current.id);
      if (
        finalized?.status === "exited" &&
        finalized.closeReason === args.payload.reason
      ) {
        return toTerminalSession(finalized);
      }
      throw error;
    }
  }

  private finishTerminalCloseWithoutDaemon(args: {
    current: TerminalSessionRow;
    reason: TerminalSessionCloseReason;
  }): TerminalSession {
    const closed = updateTerminalById(this.options.db, args.current.id, {
      closeReason: args.reason,
      exitCode: args.current.exitCode,
      kind: "exit",
    });
    const session = closed ?? args.current;
    this.notifyExitedTerminalSession({
      session,
      code: "terminal_closed",
      message: "Terminal session closed",
    });
    return toTerminalSession(session);
  }

  sendTerminalInput(args: SendTerminalInputArgs): TerminalSession {
    const current = getTerminalById(this.options.db, args.terminalId);
    if (!current) {
      throw new ApiError(
        404,
        "terminal_not_found",
        "Terminal session not found",
      );
    }
    if (!isRunningBrowserTerminalSession(current)) {
      throw new ApiError(
        409,
        "terminal_not_running",
        "Terminal session is not running",
      );
    }

    const markedInput = updateTerminalById(this.options.db, current.id, {
      kind: "user-input",
    });
    const session = markedInput ?? current;
    if (markedInput) {
      this.notifyTerminalSessionChanged(markedInput);
      this.options.hub.sendTerminalClientMessage(markedInput.id, {
        type: "session-updated",
        session: toTerminalSession(markedInput),
      });
    }

    const sent = this.options.hub.sendDaemonSessionMessage(
      current.daemonSessionId,
      {
        type: "terminal.input",
        terminalId: current.id,
        dataBase64: args.payload.dataBase64,
      },
    );
    if (!sent) {
      this.disconnectDaemonSessionTerminals({
        daemonSessionId: current.daemonSessionId,
      });
      throw new ApiError(502, "host_disconnected", "Host is not connected");
    }
    return toTerminalSession(session);
  }

  resizeTerminal(args: ResizeTerminalArgs): TerminalSession {
    const current = getTerminalById(this.options.db, args.terminalId);
    if (!current) {
      throw new ApiError(
        404,
        "terminal_not_found",
        "Terminal session not found",
      );
    }
    if (!isRunningBrowserTerminalSession(current)) {
      throw new ApiError(
        409,
        "terminal_not_running",
        "Terminal session is not running",
      );
    }

    const resized =
      current.cols === args.payload.cols && current.rows === args.payload.rows
        ? current
        : updateTerminalById(this.options.db, current.id, {
            cols: args.payload.cols,
            kind: "size",
            rows: args.payload.rows,
          });
    const session = resized ?? current;
    if (resized && resized !== current) {
      this.notifyTerminalSessionChanged(resized);
      this.options.hub.sendTerminalClientMessage(resized.id, {
        type: "session-updated",
        session: toTerminalSession(resized),
      });
    }

    const sent = this.options.hub.sendDaemonSessionMessage(
      current.daemonSessionId,
      {
        type: "terminal.resize",
        terminalId: current.id,
        cols: args.payload.cols,
        rows: args.payload.rows,
      },
    );
    if (!sent) {
      this.disconnectDaemonSessionTerminals({
        daemonSessionId: current.daemonSessionId,
      });
      throw new ApiError(502, "host_disconnected", "Host is not connected");
    }
    return toTerminalSession(session);
  }

  async readTerminalOutput(
    args: ReadTerminalOutputArgs,
  ): Promise<TerminalOutputResponse> {
    const current = getTerminalById(this.options.db, args.terminalId);
    if (!current) {
      throw new ApiError(
        404,
        "terminal_not_found",
        "Terminal session not found",
      );
    }
    if (!isRunningBrowserTerminalSession(current)) {
      throw new ApiError(
        409,
        "terminal_output_unavailable",
        "Terminal output is unavailable because the session is not running",
      );
    }

    const requestId = randomUUID();
    const pendingReplayKey = terminalRpcKey(
      current.daemonSessionId,
      current.id,
      requestId,
    );
    const pendingReplay = this.pendingOutputReads.claim({
      daemonSessionId: current.daemonSessionId,
      requestId,
      rpcKey: pendingReplayKey,
      terminalId: current.id,
    }).promise;
    const sent = this.options.hub.sendDaemonSessionMessage(
      current.daemonSessionId,
      {
        type: "terminal.attach",
        requestId,
        terminalId: current.id,
        sinceSeq: args.query.sinceSeq ?? 0,
        tailBytes: args.query.tailBytes ?? TERMINAL_SCROLLBACK_MAX_BYTES,
      },
    );
    if (!sent) {
      this.pendingOutputReads.cancel(pendingReplayKey);
      this.disconnectDaemonSessionTerminals({
        daemonSessionId: current.daemonSessionId,
      });
      throw new ApiError(502, "host_disconnected", "Host is not connected");
    }

    const requestedSinceSeq = args.query.sinceSeq ?? 0;
    const replay = await pendingReplay;
    const bounded = applyTerminalOutputBounds({
      chunks: replay.chunks.map(toTerminalOutputChunk),
      query: args.query,
      replayNextSeq: replay.nextSeq,
      requestedSinceSeq,
    });
    return {
      chunks: bounded.chunks,
      nextSeq: replay.nextSeq,
      truncated: bounded.truncated,
    };
  }

  closeDeletedThreadTerminals(args: CloseDeletedThreadTerminalsArgs): void {
    this.closeThreadTerminalsForLifecycle({
      threadId: args.threadId,
      closeReason: "thread-deleted",
      message: "Terminal session closed because the thread was deleted",
    });
  }

  closeArchivedThreadTerminals(args: CloseArchivedThreadTerminalsArgs): void {
    this.closeThreadTerminalsForLifecycle({
      threadId: args.threadId,
      closeReason: "thread-archived",
      message: "Terminal session closed because the thread was archived",
    });
  }

  closeDestroyedEnvironmentTerminals(
    args: CloseDestroyedEnvironmentTerminalsArgs,
  ): void {
    const currentSessions = listTerminalSessions(this.options.db, {
      scope: { environmentId: args.environmentId, kind: "environment" },
      visible: false,
    });
    this.requestTerminalCloses({
      closeReason: "environment-destroyed",
      sessions: currentSessions,
    });
    const exitedSessions = updateTerminalSessions(this.options.db, {
      scope: {
        environmentId: args.environmentId,
        kind: "environment",
        statuses: NON_TERMINAL_SESSION_STATUSES,
      },
      update: { closeReason: "environment-destroyed", kind: "exit" },
    });
    this.publishLifecycleTerminalExitsForSessions({
      currentSessions,
      exitedSessions,
      message: "Terminal session closed because the environment was destroyed",
    });
  }

  expireDisconnectedHostTerminals(
    args: ExpireDisconnectedHostTerminalsArgs,
  ): void {
    const exitedSessions = updateTerminalSessions(this.options.db, {
      scope: {
        hostId: args.hostId,
        kind: "host",
        statuses: ["disconnected"],
      },
      update: { closeReason: "daemon-disconnect", kind: "exit" },
    });
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
    const current = this.getBrowserTerminalSession({
      ...args,
      reportMissing: false,
    });
    if (!current) {
      throw new ApiError(
        404,
        "terminal_not_found",
        "Terminal session not found",
      );
    }

    const session = toTerminalSession(current);
    if (current.status !== "running" || current.daemonSessionId === null) {
      this.options.hub.sendTerminalSocketMessage(args.socket, {
        type: "attached",
        session,
        replayStartSeq: 0,
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

    this.options.hub.claimTerminalResizeOwnership(current.id, args.socket);
    const requestId = randomUUID();
    const pendingAttach: PendingTerminalAttachKey = {
      daemonSessionId: current.daemonSessionId,
      requestId,
      rpcKey: terminalRpcKey(current.daemonSessionId, current.id, requestId),
      socket: args.socket,
      terminalId: current.id,
      threadId: args.threadId,
    };
    void this.pendingAttaches
      .claim(pendingAttach)
      .promise.catch(() => undefined);
    const sent = this.options.hub.sendDaemonSessionMessage(
      current.daemonSessionId,
      {
        type: "terminal.attach",
        requestId,
        terminalId: current.id,
        sinceSeq: args.sinceSeq,
        tailBytes: BROWSER_TERMINAL_REPLAY_MAX_BYTES,
      },
    );
    if (!sent) {
      if (this.pendingAttaches.cancel(pendingAttach.rpcKey)) {
        this.options.hub.unregisterTerminalClient(current.id, args.socket);
      }
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
    this.pendingAttaches.failAllMatching(
      (pending) =>
        pending.terminalId === args.terminalId &&
        pending.socket === args.socket,
      TERMINAL_ATTACH_CANCELLED,
    );
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
        const current = this.getBrowserTerminalSession(args);
        if (current) {
          void this.closeTerminalSession({
            current,
            payload: { mode: "force", reason: args.message.reason },
          }).catch((error) => {
            this.sendTerminalSocketError({
              socket: args.socket,
              code: "terminal_close_failed",
              message: error instanceof Error ? error.message : String(error),
            });
          });
        }
        return;
    }
  }

  handleDaemonTerminalMessage(args: HandleDaemonTerminalMessageArgs): void {
    switch (args.message.type) {
      case "heartbeat":
        return;
      case "terminal.opened":
        this.pendingOpens.settle(
          terminalResponseRpcKey(args.sessionId, args.message),
          args.message,
        );
        return;
      case "terminal.error":
        const rpcKey = terminalResponseRpcKey(args.sessionId, args.message);
        this.pendingOpens.fail(
          rpcKey,
          new ApiError(
            502,
            args.message.code,
            `Terminal failed to open: ${args.message.message}`,
          ),
        );
        this.pendingAttaches.fail(
          rpcKey,
          new ApiError(502, args.message.code, args.message.message),
        );
        this.pendingOutputReads.fail(
          rpcKey,
          new ApiError(
            502,
            args.message.code,
            `Terminal output read failed: ${args.message.message}`,
          ),
        );
        return;
      case "terminal.exited":
        const exited = updateTerminalSession(this.options.db, {
          scope: {
            daemonSessionId: args.sessionId,
            kind: "daemon",
            terminalId: args.message.terminalId,
          },
          update: {
            closeReason: args.message.closeReason,
            exitCode: args.message.exitCode,
            kind: "exit",
          },
        });
        if (exited) {
          this.pendingCloses.settle(
            terminalRpcKey(args.sessionId, exited.id, exited.id),
            exited,
          );
          this.notifyTerminalSessionChanged(exited);
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
          this.rejectPendingOutputReadsForTerminal({
            terminalId: exited.id,
            code: "terminal_exited",
            message: "Terminal session exited",
          });
        }
        return;
      case "terminal.output": {
        const current = getTerminalById(
          this.options.db,
          args.message.terminalId,
        );
        if (
          current?.status !== "running" ||
          current.daemonSessionId !== args.sessionId
        ) {
          return;
        }
        this.options.hub.sendTerminalClientMessage(args.message.terminalId, {
          type: "output",
          chunk: toTerminalOutputChunk(args.message.chunk),
        });
        return;
      }
      case "terminal.replay":
        this.pendingAttaches.settle(
          terminalResponseRpcKey(args.sessionId, args.message),
          args.message,
        );
        this.pendingOutputReads.settle(
          terminalResponseRpcKey(args.sessionId, args.message),
          args.message,
        );
        return;
    }
  }

  handleDaemonSessionClosed(args: HandleDaemonSessionClosedArgs): void {
    this.disconnectDaemonSessionTerminals({ daemonSessionId: args.sessionId });
  }

  private closeThreadTerminalsForLifecycle(
    args: CloseThreadTerminalsForLifecycleArgs,
  ): void {
    const currentSessions = listTerminalSessions(this.options.db, {
      scope: { kind: "thread", threadId: args.threadId },
      visible: false,
    });
    this.requestTerminalCloses({
      closeReason: args.closeReason,
      sessions: currentSessions,
    });
    const exitedSessions = updateTerminalSessions(this.options.db, {
      scope: {
        kind: "thread",
        statuses: NON_TERMINAL_SESSION_STATUSES,
        threadId: args.threadId,
      },
      update: { closeReason: args.closeReason, kind: "exit" },
    });
    this.publishLifecycleTerminalExitsForSessions({
      currentSessions,
      exitedSessions,
      message: args.message,
    });
  }

  private publishLifecycleTerminalExitsForSessions(
    args: PublishLifecycleTerminalExitsForSessionsArgs,
  ): void {
    this.publishLifecycleTerminalExits({
      code: "terminal_closed",
      message: args.message,
      previousSessionsById: new Map(
        args.currentSessions.map((session) => [session.id, session]),
      ),
      sessions: args.exitedSessions,
    });
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
    const current = getTerminalById(this.options.db, args.terminalId);
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
    this.notifyTerminalSessionChanged(args.session);
    this.options.hub.sendTerminalClientMessage(args.session.id, {
      type: "exited",
      session: toTerminalSession(args.session),
    });
    this.rejectPendingAttachesForTerminal({
      terminalId: args.session.id,
      code: args.code,
      message: args.message,
    });
    this.rejectPendingOutputReadsForTerminal({
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
    const markedInput = updateTerminalById(this.options.db, current.id, {
      kind: "user-input",
    });
    if (markedInput) {
      const session = toTerminalSession(markedInput);
      this.notifyTerminalSessionChanged(markedInput);
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
    if (
      args.message.type !== "resize" ||
      !this.options.hub.isTerminalResizeOwner(args.terminalId, args.socket)
    ) {
      return;
    }
    const current = this.getRunningBrowserTerminal(args);
    if (!current) {
      return;
    }
    if (
      current.cols !== args.message.cols ||
      current.rows !== args.message.rows
    ) {
      const resized = updateTerminalById(this.options.db, current.id, {
        cols: args.message.cols,
        kind: "size",
        rows: args.message.rows,
      });
      if (resized) {
        const session = toTerminalSession(resized);
        this.notifyTerminalSessionChanged(resized);
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
    const current = this.getBrowserTerminalSession(args);
    if (!current) {
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

  private getBrowserTerminalSession(
    args: GetBrowserTerminalSessionArgs,
  ): TerminalSessionRow | null {
    let current: TerminalSessionRow | null;
    if (args.threadId === null) {
      current = getTerminalById(this.options.db, args.terminalId);
    } else {
      requirePublicThread(this.options.db, args.threadId);
      current = getTerminalSession(this.options.db, {
        kind: "thread",
        terminalId: args.terminalId,
        threadId: args.threadId,
      });
    }
    if (!current) {
      if (args.reportMissing !== false) {
        this.sendTerminalSocketError({
          socket: args.socket,
          code: "terminal_not_found",
          message: "Terminal session not found",
        });
      }
      return null;
    }
    return current;
  }

  private disconnectDaemonSessionTerminals(
    args: DisconnectDaemonSessionTerminalsArgs,
  ): void {
    const disconnected = updateTerminalSessions(this.options.db, {
      scope: {
        daemonSessionId: args.daemonSessionId,
        kind: "daemon",
        statuses: DAEMON_OWNED_TERMINAL_STATUSES,
      },
      update: { kind: "disconnect" },
    });
    for (const session of disconnected) {
      this.rejectPendingClose(
        session.id,
        new ApiError(
          502,
          "host_disconnected",
          "Host disconnected while closing terminal session",
        ),
      );
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
      this.rejectPendingOutputReadsForTerminal({
        terminalId: session.id,
        code: "host_disconnected",
        message: "Host disconnected from terminal session",
      });
      this.options.logger.info(
        { terminalId: session.id, sessionId: args.daemonSessionId },
        "Terminal session disconnected with daemon session",
      );
      this.notifyTerminalSessionChanged(session);
      this.options.hub.sendTerminalClientMessage(session.id, {
        type: "session-updated",
        session: toTerminalSession(session),
      });
    }
  }

  private finalizeTimedOutTerminalClose(
    pending: PendingTerminalCloseKey,
    error: Error,
  ): void {
    if (
      !(error instanceof ApiError) ||
      error.body.code !== "terminal_close_timeout"
    ) {
      return;
    }
    const exited = updateTerminalSession(this.options.db, {
      scope: {
        daemonSessionId: pending.daemonSessionId,
        kind: "daemon",
        statuses: DAEMON_OWNED_TERMINAL_STATUSES,
        terminalId: pending.terminalId,
      },
      update: {
        closeReason: pending.closeReason,
        exitCode: null,
        kind: "exit",
      },
    });
    if (!exited) {
      return;
    }

    this.options.logger.warn(
      {
        err: error,
        sessionId: pending.daemonSessionId,
        terminalId: pending.terminalId,
      },
      "Finalized terminal after close acknowledgement timed out",
    );
    this.notifyExitedTerminalSession({
      code: error.body.code,
      message: error.body.message,
      session: exited,
    });
  }

  private rejectPendingClose(terminalId: string, error: Error): void {
    this.pendingCloses.failAllMatching(
      (pending) => pending.terminalId === terminalId,
      error,
    );
  }

  private completePendingAttach(
    pending: PendingTerminalAttachKey,
    message: TerminalReplayMessage,
  ): void {
    const current =
      pending.threadId === null
        ? getTerminalById(this.options.db, pending.terminalId)
        : getTerminalSession(this.options.db, {
            kind: "thread",
            terminalId: pending.terminalId,
            threadId: pending.threadId,
          });
    if (!current) {
      this.options.hub.unregisterTerminalClient(
        pending.terminalId,
        pending.socket,
      );
      this.sendTerminalSocketError({
        socket: pending.socket,
        code: "terminal_not_found",
        message: "Terminal session not found",
      });
      return;
    }

    this.options.hub.registerTerminalClient(current.id, pending.socket);
    this.options.hub.sendTerminalSocketMessage(pending.socket, {
      type: "attached",
      session: toTerminalSession(current),
      replayStartSeq: message.replayStartSeq,
      nextSeq: message.nextSeq,
    });
    for (const chunk of message.chunks) {
      this.options.hub.sendTerminalSocketMessage(pending.socket, {
        type: "output",
        chunk: toTerminalOutputChunk(chunk),
      });
    }
  }

  private rejectPendingOpenForTerminal(
    args: RejectPendingOpenForTerminalArgs,
  ): void {
    this.pendingOpens.failAllMatching(
      (pending) =>
        pending.daemonSessionId === args.daemonSessionId &&
        pending.terminalId === args.terminalId,
      new ApiError(args.status, args.code, args.message),
    );
  }

  private rejectPendingAttachesForTerminal(
    args: RejectPendingAttachesForTerminalArgs,
  ): void {
    this.pendingAttaches.failAllMatching(
      (pending) => pending.terminalId === args.terminalId,
      new ApiError(409, args.code, args.message),
    );
  }

  private rejectPendingOutputReadsForTerminal(
    args: RejectPendingAttachesForTerminalArgs,
  ): void {
    this.pendingOutputReads.failAllMatching(
      (pending) => pending.terminalId === args.terminalId,
      new ApiError(409, args.code, args.message),
    );
  }

  private failTerminalAttach(
    pending: PendingTerminalAttachKey,
    error: Error,
  ): void {
    if (error === TERMINAL_ATTACH_CANCELLED) {
      return;
    }
    this.options.hub.unregisterTerminalClient(
      pending.terminalId,
      pending.socket,
    );
    this.sendTerminalSocketError({
      socket: pending.socket,
      code:
        error instanceof ApiError ? error.body.code : "terminal_attach_failed",
      message: error instanceof ApiError ? error.body.message : error.message,
    });
  }

  private sendTerminalSocketError(args: SendTerminalSocketErrorArgs): void {
    this.options.hub.sendTerminalSocketMessage(args.socket, {
      type: "error",
      code: args.code,
      message: args.message,
    });
  }

  private notifyTerminalSessionChanged(
    session: Pick<TerminalSessionRow, "threadId">,
  ): void {
    if (session.threadId !== null) {
      this.options.hub.notifyThread(session.threadId, ["terminals-changed"]);
    }
  }
}

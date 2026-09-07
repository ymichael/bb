import { Buffer } from "node:buffer";
import {
  realtimeSubscriptionTargetKey as subscriptionKey,
  type RealtimeSubscriptionTarget,
  type ChangedMessage,
  type EnvironmentChangeKind,
  type HostChangeKind,
  type ProjectChangeKind,
  type SystemChangeKind,
  type ThreadChangeKind,
  type ThreadChangeMetadata,
  type ThreadEventType,
} from "@bb/domain";
import type { DbNotifier } from "@bb/db";
import type {
  HostPlatform,
  HostDaemonOnlineRpcRequestMessage,
  HostDaemonOnlineRpcResponseMessage,
  HostDaemonServerWsMessage,
  HostDaemonSessionCloseReason,
} from "@bb/host-daemon-contract";
import {
  pluginSignalSchema,
  serverMessageSchema,
  terminalServerMessageSchema,
  threadOpenSignalSchema,
  threadPaneActionSignalSchema,
  type ThreadPaneAction,
  type ThreadOpenFile,
  type ThreadOpenSplit,
  type TerminalServerMessage,
} from "@bb/server-contract";

const TERMINAL_SOCKET_HIGH_WATER_BYTES = 1024 * 1024;
const TERMINAL_SOCKET_MAX_QUEUE_BYTES = 32 * 1024 * 1024;
const TERMINAL_SOCKET_DRAIN_POLL_MS = 10;
const THREAD_LIST_EVENTS_APPENDED_COALESCE_MS = 1_000;
const LIST_RELEVANT_THREAD_EVENT_TYPES: ReadonlySet<ThreadEventType> =
  new Set<ThreadEventType>(["client/turn/requested", "turn/completed"]);

interface HubSocket {
  close(code?: number, reason?: string): void;
  raw?: { bufferedAmount: number };
  send(data: string): void;
}

interface TerminalSocketSendQueue {
  bytes: number;
  payloads: string[];
  timeout: ReturnType<typeof setTimeout> | null;
}

type ChangedMessageListener = (message: ChangedMessage) => void;

interface PendingThreadListEventsAppended {
  eventTypes: Set<ThreadEventType>;
  merged: boolean;
  timeout: ReturnType<typeof setTimeout>;
}

type ThreadChangedMessage = Extract<ChangedMessage, { entity: "thread" }>;

function isThreadListRelevantChange(
  message: Pick<ThreadChangedMessage, "changes" | "metadata">,
): boolean {
  if (message.changes.some((change) => change !== "events-appended")) {
    return true;
  }
  const metadata = message.metadata;
  if (metadata === undefined) {
    return false;
  }
  return (
    metadata.backgroundActivityChanged === true ||
    metadata.hasPendingInteraction !== undefined ||
    metadata.projectId !== undefined ||
    (metadata.eventTypes?.some((eventType) =>
      LIST_RELEVANT_THREAD_EVENT_TYPES.has(eventType),
    ) ??
      false)
  );
}

function subscriptionKeysForMessage(message: ChangedMessage): string[] {
  switch (message.entity) {
    case "thread":
      return message.id
        ? [
            subscriptionKey({ kind: "thread-list" }),
            subscriptionKey({ kind: "thread-detail", threadId: message.id }),
          ]
        : [subscriptionKey({ kind: "thread-list" })];
    case "project":
      return message.id
        ? [
            subscriptionKey({ kind: "project-list" }),
            subscriptionKey({ kind: "project-detail", projectId: message.id }),
          ]
        : [subscriptionKey({ kind: "project-list" })];
    case "environment":
      return message.id
        ? [
            subscriptionKey({ kind: "environment-list" }),
            subscriptionKey({
              kind: "environment-detail",
              environmentId: message.id,
            }),
          ]
        : [subscriptionKey({ kind: "environment-list" })];
    case "host":
      return message.id
        ? [
            subscriptionKey({ kind: "host-list" }),
            subscriptionKey({ kind: "host-detail", hostId: message.id }),
          ]
        : [subscriptionKey({ kind: "host-list" })];
    case "system":
      return [subscriptionKey({ kind: "system" })];
  }
}

interface ThreadEventWaiter {
  resolve: (notified: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface DaemonRegistrationWaiter {
  resolve: (registered: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface HostOnlineRpcWaiter {
  reject: (reason?: Error) => void;
  resolve: (message: HostDaemonOnlineRpcResponseMessage) => void;
  sessionId: string;
  timeout: ReturnType<typeof setTimeout>;
}

interface RecordHostOnlineRpcResponseArgs {
  message: HostDaemonOnlineRpcResponseMessage;
  sessionId: string;
}

type HostOnlineRpcResponseDisposition =
  | { handled: true }
  | { handled: false; reason: "stale" }
  | {
      expectedSessionId: string;
      handled: false;
      reason: "session_mismatch";
    };

export class HostOnlineRpcTimeoutError extends Error {
  constructor() {
    super("Timed out waiting for host RPC response");
    this.name = "HostOnlineRpcTimeoutError";
  }
}

export class HostOnlineRpcUnavailableError extends Error {
  constructor() {
    super("Host daemon is not connected");
    this.name = "HostOnlineRpcUnavailableError";
  }
}

export class NotificationHub implements DbNotifier {
  private readonly clientKeysBySocket = new Map<HubSocket, Set<string>>();
  private readonly clientSocketsByKey = new Map<string, Set<HubSocket>>();
  private readonly daemonSessions = new Map<
    string,
    {
      hostId: string;
      localApiPort: number | null;
      platform: HostPlatform;
      socket: HubSocket;
    }
  >();
  private readonly daemonSessionLocalApiPortsBySessionId = new Map<
    string,
    number | null
  >();
  private readonly daemonSessionPlatformsBySessionId = new Map<
    string,
    HostPlatform
  >();
  private readonly daemonRegistrationWaiters = new Map<
    string,
    Set<DaemonRegistrationWaiter>
  >();
  private readonly daemonSessionIdsByHost = new Map<string, string>();
  private readonly hostOnlineRpcWaiters = new Map<
    string,
    HostOnlineRpcWaiter
  >();
  private readonly hostProtocolUpdateRetryRequests = new Set<string>();
  private readonly changedMessageListeners = new Set<ChangedMessageListener>();
  private readonly pendingDaemonDisconnects = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly pendingDaemonActiveWorkDisconnects = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly terminalClientSocketsById = new Map<
    string,
    Set<HubSocket>
  >();
  private readonly terminalSocketSendQueues = new Map<
    HubSocket,
    TerminalSocketSendQueue
  >();
  private readonly terminalIdsByClientSocket = new Map<
    HubSocket,
    Set<string>
  >();
  private readonly terminalResizeOwnerById = new Map<string, HubSocket>();
  private readonly threadEventWaiters = new Map<
    string,
    Set<ThreadEventWaiter>
  >();
  private readonly pendingThreadListEventsAppendedByThread = new Map<
    string,
    PendingThreadListEventsAppended
  >();

  registerClient(socket: HubSocket): void {
    if (!this.clientKeysBySocket.has(socket)) {
      this.clientKeysBySocket.set(socket, new Set());
    }
  }

  unregisterClient(socket: HubSocket): void {
    this.unregisterTerminalClientSocket(socket);
    const keys = this.clientKeysBySocket.get(socket);
    if (!keys) {
      return;
    }

    for (const key of keys) {
      const sockets = this.clientSocketsByKey.get(key);
      if (!sockets) {
        continue;
      }
      sockets.delete(socket);
      if (sockets.size === 0) {
        this.clientSocketsByKey.delete(key);
      }
    }

    this.clientKeysBySocket.delete(socket);
  }

  onChangedMessage(listener: ChangedMessageListener): () => void {
    this.changedMessageListeners.add(listener);
    return () => {
      this.changedMessageListeners.delete(listener);
    };
  }

  registerTerminalClient(terminalId: string, socket: HubSocket): void {
    const sockets =
      this.terminalClientSocketsById.get(terminalId) ?? new Set<HubSocket>();
    sockets.add(socket);
    this.terminalClientSocketsById.set(terminalId, sockets);

    const terminalIds =
      this.terminalIdsByClientSocket.get(socket) ?? new Set<string>();
    terminalIds.add(terminalId);
    this.terminalIdsByClientSocket.set(socket, terminalIds);
  }

  claimTerminalResizeOwnership(terminalId: string, socket: HubSocket): void {
    this.terminalResizeOwnerById.set(terminalId, socket);
  }

  isTerminalResizeOwner(terminalId: string, socket: HubSocket): boolean {
    return this.terminalResizeOwnerById.get(terminalId) === socket;
  }

  unregisterTerminalClient(terminalId: string, socket: HubSocket): void {
    const sockets = this.terminalClientSocketsById.get(terminalId);
    if (sockets) {
      sockets.delete(socket);
      if (sockets.size === 0) {
        this.terminalClientSocketsById.delete(terminalId);
      }
    }
    this.releaseTerminalResizeOwnership(terminalId, socket, sockets);

    const terminalIds = this.terminalIdsByClientSocket.get(socket);
    if (!terminalIds) {
      return;
    }
    terminalIds.delete(terminalId);
    if (terminalIds.size === 0) {
      this.terminalIdsByClientSocket.delete(socket);
      this.clearTerminalSocketSendQueue(socket);
    }
  }

  unregisterTerminalClientSocket(socket: HubSocket): void {
    const terminalIds = this.terminalIdsByClientSocket.get(socket);
    if (!terminalIds) {
      return;
    }

    for (const terminalId of terminalIds) {
      const sockets = this.terminalClientSocketsById.get(terminalId);
      if (!sockets) {
        continue;
      }
      sockets.delete(socket);
      if (sockets.size === 0) {
        this.terminalClientSocketsById.delete(terminalId);
      }
      this.releaseTerminalResizeOwnership(terminalId, socket, sockets);
    }

    this.terminalIdsByClientSocket.delete(socket);
    this.clearTerminalSocketSendQueue(socket);
  }

  private releaseTerminalResizeOwnership(
    terminalId: string,
    socket: HubSocket,
    sockets: Set<HubSocket> | undefined,
  ): void {
    if (this.terminalResizeOwnerById.get(terminalId) !== socket) {
      return;
    }
    let replacement: HubSocket | undefined;
    for (const candidate of sockets ?? []) {
      replacement = candidate;
    }
    if (replacement === undefined) {
      this.terminalResizeOwnerById.delete(terminalId);
    } else {
      this.terminalResizeOwnerById.set(terminalId, replacement);
    }
  }

  sendTerminalSocketMessage(
    socket: HubSocket,
    message: TerminalServerMessage,
  ): void {
    this.sendOrQueueTerminalPayload(
      socket,
      JSON.stringify(terminalServerMessageSchema.parse(message)),
    );
  }

  sendTerminalClientMessage(
    terminalId: string,
    message: TerminalServerMessage,
  ): void {
    const sockets = this.terminalClientSocketsById.get(terminalId);
    if (!sockets) {
      return;
    }

    const payload = JSON.stringify(terminalServerMessageSchema.parse(message));
    for (const socket of [...sockets]) {
      this.sendOrQueueTerminalPayload(socket, payload);
    }
  }

  private sendOrQueueTerminalPayload(socket: HubSocket, payload: string): void {
    const existingQueue = this.terminalSocketSendQueues.get(socket);
    if (
      !existingQueue &&
      (socket.raw?.bufferedAmount ?? 0) <= TERMINAL_SOCKET_HIGH_WATER_BYTES
    ) {
      try {
        socket.send(payload);
        return;
      } catch {
        this.dropTerminalSocket(socket, "terminal-send-failed");
        return;
      }
    }

    const queue = existingQueue ?? {
      bytes: 0,
      payloads: [],
      timeout: null,
    };
    const payloadBytes = Buffer.byteLength(payload, "utf8");
    if (queue.bytes + payloadBytes > TERMINAL_SOCKET_MAX_QUEUE_BYTES) {
      this.dropTerminalSocket(socket, "terminal-backpressure");
      return;
    }
    queue.payloads.push(payload);
    queue.bytes += payloadBytes;
    this.terminalSocketSendQueues.set(socket, queue);
    this.scheduleTerminalSocketDrain(socket, queue);
  }

  private scheduleTerminalSocketDrain(
    socket: HubSocket,
    queue: TerminalSocketSendQueue,
  ): void {
    if (queue.timeout !== null) {
      return;
    }
    queue.timeout = setTimeout(() => {
      queue.timeout = null;
      this.flushTerminalSocketQueue(socket, queue);
    }, TERMINAL_SOCKET_DRAIN_POLL_MS);
  }

  private flushTerminalSocketQueue(
    socket: HubSocket,
    queue: TerminalSocketSendQueue,
  ): void {
    if (this.terminalSocketSendQueues.get(socket) !== queue) {
      return;
    }
    while (
      queue.payloads.length > 0 &&
      (socket.raw?.bufferedAmount ?? 0) <= TERMINAL_SOCKET_HIGH_WATER_BYTES
    ) {
      const payload = queue.payloads[0];
      if (payload === undefined) {
        break;
      }
      try {
        socket.send(payload);
      } catch {
        this.dropTerminalSocket(socket, "terminal-send-failed");
        return;
      }
      queue.payloads.shift();
      queue.bytes -= Buffer.byteLength(payload, "utf8");
    }
    if (queue.payloads.length === 0) {
      this.clearTerminalSocketSendQueue(socket);
      return;
    }
    this.scheduleTerminalSocketDrain(socket, queue);
  }

  private dropTerminalSocket(socket: HubSocket, reason: string): void {
    this.unregisterTerminalClientSocket(socket);
    try {
      socket.close(1013, reason);
    } catch {}
  }

  private clearTerminalSocketSendQueue(socket: HubSocket): void {
    const queue = this.terminalSocketSendQueues.get(socket);
    if (!queue) {
      return;
    }
    if (queue.timeout !== null) {
      clearTimeout(queue.timeout);
    }
    this.terminalSocketSendQueues.delete(socket);
  }

  subscribe(socket: HubSocket, target: RealtimeSubscriptionTarget): void {
    this.registerClient(socket);
    const key = subscriptionKey(target);
    this.clientKeysBySocket.get(socket)?.add(key);

    const sockets = this.clientSocketsByKey.get(key) ?? new Set<HubSocket>();
    sockets.add(socket);
    this.clientSocketsByKey.set(key, sockets);
  }

  unsubscribe(socket: HubSocket, target: RealtimeSubscriptionTarget): void {
    const key = subscriptionKey(target);
    this.clientKeysBySocket.get(socket)?.delete(key);

    const sockets = this.clientSocketsByKey.get(key);
    if (!sockets) {
      return;
    }
    sockets.delete(socket);
    if (sockets.size === 0) {
      this.clientSocketsByKey.delete(key);
    }
  }

  recordDaemonSessionPlatform(sessionId: string, platform: HostPlatform): void {
    this.daemonSessionPlatformsBySessionId.set(sessionId, platform);
  }

  recordDaemonSessionLocalApiPort(
    sessionId: string,
    localApiPort: number | null,
  ): void {
    this.daemonSessionLocalApiPortsBySessionId.set(sessionId, localApiPort);
  }

  registerDaemon(sessionId: string, hostId: string, socket: HubSocket): void {
    this.cancelPendingDaemonDisconnect(sessionId);
    const existingSessionId = this.daemonSessionIdsByHost.get(hostId);
    if (existingSessionId && existingSessionId !== sessionId) {
      this.cancelPendingDaemonDisconnect(existingSessionId);
      this.unregisterDaemon(existingSessionId);
    }
    this.daemonSessions.set(sessionId, {
      hostId,
      localApiPort:
        this.daemonSessionLocalApiPortsBySessionId.get(sessionId) ?? null,
      platform:
        this.daemonSessionPlatformsBySessionId.get(sessionId) ?? "unknown",
      socket,
    });
    this.daemonSessionIdsByHost.set(hostId, sessionId);
    this.resolveDaemonRegistrationWaiters(hostId);
    this.notifyHost(hostId, ["host-connected"]);
  }

  unregisterDaemon(sessionId: string): void {
    const entry = this.daemonSessions.get(sessionId);
    if (!entry) {
      return;
    }
    this.daemonSessions.delete(sessionId);
    this.daemonSessionLocalApiPortsBySessionId.delete(sessionId);
    this.daemonSessionPlatformsBySessionId.delete(sessionId);
    this.rejectHostOnlineRpcWaitersForSession(sessionId);
    if (this.daemonSessionIdsByHost.get(entry.hostId) === sessionId) {
      this.daemonSessionIdsByHost.delete(entry.hostId);
    }
  }

  hasDaemonForHost(hostId: string): boolean {
    const sessionId = this.daemonSessionIdsByHost.get(hostId);
    return sessionId !== undefined && this.daemonSessions.has(sessionId);
  }

  getDaemonSessionIdForHost(hostId: string): string | null {
    const sessionId = this.daemonSessionIdsByHost.get(hostId);
    if (!sessionId || !this.daemonSessions.has(sessionId)) {
      return null;
    }
    return sessionId;
  }

  getDaemonPlatformForHost(hostId: string): HostPlatform | null {
    const sessionId = this.daemonSessionIdsByHost.get(hostId);
    if (!sessionId) {
      return null;
    }
    return this.daemonSessions.get(sessionId)?.platform ?? null;
  }

  listDaemonLocalApiPorts(): number[] {
    const ports = new Set<number>();
    for (const session of this.daemonSessions.values()) {
      if (session.localApiPort !== null) {
        ports.add(session.localApiPort);
      }
    }
    return [...ports].sort((left, right) => left - right);
  }

  async waitForDaemonForHost(
    hostId: string,
    timeoutMs: number,
  ): Promise<boolean> {
    if (this.hasDaemonForHost(hostId)) {
      return true;
    }

    return new Promise<boolean>((resolve) => {
      const waiter: DaemonRegistrationWaiter = {
        resolve,
        timeout: setTimeout(() => {
          this.deleteDaemonRegistrationWaiter(hostId, waiter);
          resolve(false);
        }, timeoutMs),
      };
      const waiters =
        this.daemonRegistrationWaiters.get(hostId) ??
        new Set<DaemonRegistrationWaiter>();
      waiters.add(waiter);
      this.daemonRegistrationWaiters.set(hostId, waiters);
    });
  }

  closeDaemonSession(
    sessionId: string,
    reason: HostDaemonSessionCloseReason,
  ): void {
    const entry = this.daemonSessions.get(sessionId);
    if (entry) {
      entry.socket.send(JSON.stringify({ type: "session-close", reason }));
    }
    this.closeDaemonSessionSocket(sessionId, reason);
  }

  closeDaemonSessionSocket(
    sessionId: string,
    reason: HostDaemonSessionCloseReason,
  ): void {
    this.cancelPendingDaemonDisconnect(sessionId);
    const entry = this.daemonSessions.get(sessionId);
    if (!entry) {
      return;
    }
    entry.socket.close(1000, reason);
    this.unregisterDaemon(sessionId);
  }

  scheduleDaemonDisconnect(
    sessionId: string,
    delayMs: number,
    callback: () => void,
  ): void {
    this.cancelPendingDaemonDisconnectGrace(sessionId);
    const timeout = setTimeout(() => {
      this.pendingDaemonDisconnects.delete(sessionId);
      callback();
    }, delayMs);
    this.pendingDaemonDisconnects.set(sessionId, timeout);
  }

  scheduleDaemonActiveWorkDisconnect(
    sessionId: string,
    delayMs: number,
    callback: () => void,
  ): void {
    this.cancelPendingDaemonActiveWorkDisconnect(sessionId);
    const timeout = setTimeout(() => {
      this.pendingDaemonActiveWorkDisconnects.delete(sessionId);
      callback();
    }, delayMs);
    this.pendingDaemonActiveWorkDisconnects.set(sessionId, timeout);
  }

  private cancelPendingDaemonDisconnectGrace(sessionId: string): void {
    const timeout = this.pendingDaemonDisconnects.get(sessionId);
    if (!timeout) {
      return;
    }
    clearTimeout(timeout);
    this.pendingDaemonDisconnects.delete(sessionId);
  }

  private cancelPendingDaemonActiveWorkDisconnect(sessionId: string): void {
    const timeout = this.pendingDaemonActiveWorkDisconnects.get(sessionId);
    if (!timeout) {
      return;
    }
    clearTimeout(timeout);
    this.pendingDaemonActiveWorkDisconnects.delete(sessionId);
  }

  cancelPendingDaemonDisconnect(sessionId: string): void {
    this.cancelPendingDaemonDisconnectGrace(sessionId);
    this.cancelPendingDaemonActiveWorkDisconnect(sessionId);
  }

  requestHostOnlineRpc(args: {
    hostId: string;
    message: HostDaemonOnlineRpcRequestMessage;
    timeoutMs: number;
  }): Promise<HostDaemonOnlineRpcResponseMessage> {
    const sessionId = this.daemonSessionIdsByHost.get(args.hostId);
    if (!sessionId) {
      return Promise.reject(new HostOnlineRpcUnavailableError());
    }
    const session = this.daemonSessions.get(sessionId);
    if (!session) {
      return Promise.reject(new HostOnlineRpcUnavailableError());
    }

    return new Promise<HostDaemonOnlineRpcResponseMessage>(
      (resolve, reject) => {
        const waiter: HostOnlineRpcWaiter = {
          reject,
          resolve,
          sessionId,
          timeout: setTimeout(() => {
            this.deleteHostOnlineRpcWaiter(args.message.requestId, waiter);
            reject(new HostOnlineRpcTimeoutError());
          }, args.timeoutMs),
        };
        this.hostOnlineRpcWaiters.set(args.message.requestId, waiter);
        try {
          session.socket.send(JSON.stringify(args.message));
        } catch (error) {
          this.deleteHostOnlineRpcWaiter(args.message.requestId, waiter);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    );
  }

  recordHostOnlineRpcResponse(
    args: RecordHostOnlineRpcResponseArgs,
  ): HostOnlineRpcResponseDisposition {
    const waiter = this.hostOnlineRpcWaiters.get(args.message.requestId);
    if (!waiter) {
      return { handled: false, reason: "stale" };
    }
    if (waiter.sessionId !== args.sessionId) {
      return {
        expectedSessionId: waiter.sessionId,
        handled: false,
        reason: "session_mismatch",
      };
    }
    this.deleteHostOnlineRpcWaiter(args.message.requestId, waiter);
    waiter.resolve(args.message);
    return { handled: true };
  }

  registerThreadEventWaiter(
    threadId: string,
    timeoutMs: number,
  ): { promise: Promise<boolean>; cancel: () => void } {
    let waiter: ThreadEventWaiter;
    const promise = new Promise<boolean>((resolve) => {
      waiter = {
        resolve: (notified) => resolve(notified),
        timeout: setTimeout(() => {
          this.deleteThreadEventWaiter(threadId, waiter);
          resolve(false);
        }, timeoutMs),
      };
      const waiters =
        this.threadEventWaiters.get(threadId) ?? new Set<ThreadEventWaiter>();
      waiters.add(waiter);
      this.threadEventWaiters.set(threadId, waiters);
    });
    const cancel = () => {
      this.deleteThreadEventWaiter(threadId, waiter!);
    };
    return { promise, cancel };
  }

  notifyThread(
    threadId: string,
    changes: ThreadChangeKind[],
    metadata?: ThreadChangeMetadata,
  ): void {
    const message: ThreadChangedMessage = {
      type: "changed",
      entity: "thread",
      id: threadId,
      ...(metadata ? { metadata } : {}),
      changes,
    };
    if (isThreadListRelevantChange(message)) {
      this.notifyClients(message);
    } else {
      this.notifyThreadEventsAppendedCoalesced(threadId, message);
    }

    const threadEventWaiters = this.threadEventWaiters.get(threadId);
    if (threadEventWaiters) {
      for (const waiter of threadEventWaiters) {
        clearTimeout(waiter.timeout);
        waiter.resolve(true);
      }
      this.threadEventWaiters.delete(threadId);
    }
  }

  notifyThreadOpen(
    thread: { projectId: string; threadId: string },
    request: { split: ThreadOpenSplit; file: ThreadOpenFile | null },
  ): number {
    const payload = JSON.stringify(
      threadOpenSignalSchema.parse({
        type: "thread-open",
        projectId: thread.projectId,
        threadId: thread.threadId,
        split: request.split,
        file: request.file,
      }),
    );
    let delivered = 0;
    for (const socket of this.clientKeysBySocket.keys()) {
      socket.send(payload);
      delivered += 1;
    }
    return delivered;
  }

  notifyThreadPaneAction(
    thread: { projectId: string; threadId: string },
    action: ThreadPaneAction,
  ): number {
    const payload = JSON.stringify(
      threadPaneActionSignalSchema.parse({
        type: "thread-pane-action",
        projectId: thread.projectId,
        threadId: thread.threadId,
        action,
      }),
    );
    let delivered = 0;
    for (const socket of this.clientKeysBySocket.keys()) {
      socket.send(payload);
      delivered += 1;
    }
    return delivered;
  }

  notifyPluginSignal(
    pluginId: string,
    channel: string,
    payload: unknown,
  ): number {
    const message = JSON.stringify(
      pluginSignalSchema.parse({
        type: "plugin-signal",
        pluginId,
        channel,
        payload,
      }),
    );
    let delivered = 0;
    for (const socket of this.clientKeysBySocket.keys()) {
      socket.send(message);
      delivered += 1;
    }
    return delivered;
  }

  notifyProject(projectId: string, changes: ProjectChangeKind[]): void {
    this.notifyClients({
      type: "changed",
      entity: "project",
      id: projectId,
      changes,
    });
  }

  notifyEnvironment(
    environmentId: string,
    changes: EnvironmentChangeKind[],
  ): void {
    this.notifyClients({
      type: "changed",
      entity: "environment",
      id: environmentId,
      changes,
    });
  }

  notifyHost(hostId: string, changes: HostChangeKind[]): void {
    this.notifyClients({
      type: "changed",
      entity: "host",
      id: hostId,
      changes,
    });
  }

  requestHostProtocolUpdateRetry(hostId: string): void {
    this.hostProtocolUpdateRetryRequests.add(hostId);
  }

  takeHostProtocolUpdateRetry(hostId: string): boolean {
    if (!this.hostProtocolUpdateRetryRequests.has(hostId)) {
      return false;
    }
    this.hostProtocolUpdateRetryRequests.delete(hostId);
    return true;
  }

  notifySystem(changes: SystemChangeKind[]): void {
    this.notifyClients({
      type: "changed",
      entity: "system",
      changes,
    });
  }

  private deleteThreadEventWaiter(
    threadId: string,
    waiter: ThreadEventWaiter,
  ): void {
    const waiters = this.threadEventWaiters.get(threadId);
    if (!waiters) {
      return;
    }
    clearTimeout(waiter.timeout);
    waiters.delete(waiter);
    if (waiters.size === 0) {
      this.threadEventWaiters.delete(threadId);
    }
  }

  private deleteHostOnlineRpcWaiter(
    requestId: string,
    waiter: HostOnlineRpcWaiter,
  ): void {
    clearTimeout(waiter.timeout);
    if (this.hostOnlineRpcWaiters.get(requestId) === waiter) {
      this.hostOnlineRpcWaiters.delete(requestId);
    }
  }

  private rejectHostOnlineRpcWaitersForSession(sessionId: string): void {
    for (const [requestId, waiter] of this.hostOnlineRpcWaiters) {
      if (waiter.sessionId !== sessionId) {
        continue;
      }
      this.deleteHostOnlineRpcWaiter(requestId, waiter);
      waiter.reject(new HostOnlineRpcUnavailableError());
    }
  }

  private deleteDaemonRegistrationWaiter(
    hostId: string,
    waiter: DaemonRegistrationWaiter,
  ): void {
    clearTimeout(waiter.timeout);
    const waiters = this.daemonRegistrationWaiters.get(hostId);
    if (!waiters) {
      return;
    }
    waiters.delete(waiter);
    if (waiters.size === 0) {
      this.daemonRegistrationWaiters.delete(hostId);
    }
  }

  private resolveDaemonRegistrationWaiters(hostId: string): void {
    const waiters = this.daemonRegistrationWaiters.get(hostId);
    if (!waiters) {
      return;
    }
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve(true);
    }
    this.daemonRegistrationWaiters.delete(hostId);
  }

  private notifyThreadEventsAppendedCoalesced(
    threadId: string,
    message: ThreadChangedMessage,
  ): void {
    const parseResult = serverMessageSchema.safeParse(message);
    if (!parseResult.success) {
      console.error("Skipping invalid realtime broadcast", parseResult.error);
      return;
    }
    const payload = JSON.stringify(parseResult.data);
    const detailSockets = this.clientSocketsByKey.get(
      subscriptionKey({ kind: "thread-detail", threadId }),
    );
    if (detailSockets) {
      this.notifyClientsByKeySet(detailSockets, payload);
    }
    this.notifyChangedMessageListeners(message);

    const eventTypes = message.metadata?.eventTypes ?? [];
    const pending = this.pendingThreadListEventsAppendedByThread.get(threadId);
    if (pending) {
      for (const eventType of eventTypes) {
        pending.eventTypes.add(eventType);
      }
      pending.merged = true;
      return;
    }

    this.notifyThreadListOnlySockets(threadId, payload);
    const timeout = setTimeout(() => {
      this.flushPendingThreadListEventsAppended(threadId);
    }, THREAD_LIST_EVENTS_APPENDED_COALESCE_MS);
    timeout.unref?.();
    this.pendingThreadListEventsAppendedByThread.set(threadId, {
      eventTypes: new Set(eventTypes),
      merged: false,
      timeout,
    });
  }

  private flushPendingThreadListEventsAppended(threadId: string): void {
    const pending = this.pendingThreadListEventsAppendedByThread.get(threadId);
    if (!pending) {
      return;
    }
    this.pendingThreadListEventsAppendedByThread.delete(threadId);
    if (!pending.merged) {
      return;
    }
    const message: ThreadChangedMessage = {
      type: "changed",
      entity: "thread",
      id: threadId,
      ...(pending.eventTypes.size > 0
        ? { metadata: { eventTypes: [...pending.eventTypes] } }
        : {}),
      changes: ["events-appended"],
    };
    const parseResult = serverMessageSchema.safeParse(message);
    if (!parseResult.success) {
      console.error("Skipping invalid realtime broadcast", parseResult.error);
      return;
    }
    this.notifyThreadListOnlySockets(
      threadId,
      JSON.stringify(parseResult.data),
    );
  }

  private notifyThreadListOnlySockets(threadId: string, payload: string): void {
    const listSockets = this.clientSocketsByKey.get(
      subscriptionKey({ kind: "thread-list" }),
    );
    if (!listSockets) {
      return;
    }
    const detailKey = subscriptionKey({ kind: "thread-detail", threadId });
    for (const socket of listSockets) {
      if (this.clientKeysBySocket.get(socket)?.has(detailKey)) {
        continue;
      }
      socket.send(payload);
    }
  }

  private notifyClients(message: ChangedMessage): void {
    const sockets = new Set<HubSocket>();
    for (const key of subscriptionKeysForMessage(message)) {
      const specificSockets = this.clientSocketsByKey.get(key);
      if (!specificSockets) {
        continue;
      }
      for (const socket of specificSockets) {
        sockets.add(socket);
      }
    }

    const parseResult = serverMessageSchema.safeParse(message);
    if (!parseResult.success) {
      console.error("Skipping invalid realtime broadcast", parseResult.error);
      return;
    }
    const payload = JSON.stringify(parseResult.data);
    this.notifyClientsByKeySet(sockets, payload);
    this.notifyChangedMessageListeners(message);
  }

  private notifyClientsByKeySet(
    sockets: Iterable<HubSocket>,
    payload: string,
  ): void {
    for (const socket of sockets) {
      socket.send(payload);
    }
  }

  private notifyChangedMessageListeners(message: ChangedMessage): void {
    for (const listener of this.changedMessageListeners) {
      listener(message);
    }
  }

  sendDaemonMessage(
    hostId: string,
    message: HostDaemonServerWsMessage,
  ): boolean {
    const sessionId = this.daemonSessionIdsByHost.get(hostId);
    if (!sessionId) {
      return false;
    }
    return this.sendDaemonSessionMessage(sessionId, message);
  }

  sendDaemonSessionMessage(
    sessionId: string,
    message: HostDaemonServerWsMessage,
  ): boolean {
    const session = this.daemonSessions.get(sessionId);
    if (!session) {
      return false;
    }
    session.socket.send(JSON.stringify(message));
    return true;
  }
}

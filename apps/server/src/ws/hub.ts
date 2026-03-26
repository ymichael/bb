import type {
  ChangedMessage,
  EnvironmentChangeKind,
  ProjectChangeKind,
  SystemChangeKind,
  ThreadChangeKind,
} from "@bb/domain";
import type { DbNotifier } from "@bb/db";
import { COMMAND_RESULT_CACHE_TTL_MS } from "../constants.js";

interface HubSocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

interface CommandWaiter {
  reject: (reason?: unknown) => void;
  resolve: (notified: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface CommandResultWaiter {
  reject: (reason?: unknown) => void;
  resolve: (result: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

function subKey(entity: string, id?: string): string {
  return id ? `${entity}:${id}` : entity;
}

export class NotificationHub implements DbNotifier {
  private readonly clientKeysBySocket = new Map<HubSocket, Set<string>>();
  private readonly clientSocketsByKey = new Map<string, Set<HubSocket>>();
  private readonly commandResultCache = new Map<string, unknown>();
  private readonly commandResultWaiters = new Map<string, Set<CommandResultWaiter>>();
  private readonly commandWaiters = new Map<string, Set<CommandWaiter>>();
  private readonly daemonSessions = new Map<string, { hostId: string; socket: HubSocket }>();
  private readonly daemonSessionIdsByHost = new Map<string, string>();

  registerClient(socket: HubSocket): void {
    if (!this.clientKeysBySocket.has(socket)) {
      this.clientKeysBySocket.set(socket, new Set());
    }
  }

  unregisterClient(socket: HubSocket): void {
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

  subscribe(socket: HubSocket, entity: string, id?: string): void {
    this.registerClient(socket);
    const key = subKey(entity, id);
    this.clientKeysBySocket.get(socket)?.add(key);

    const sockets = this.clientSocketsByKey.get(key) ?? new Set<HubSocket>();
    sockets.add(socket);
    this.clientSocketsByKey.set(key, sockets);
  }

  unsubscribe(socket: HubSocket, entity: string, id?: string): void {
    const key = subKey(entity, id);
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

  registerDaemon(sessionId: string, hostId: string, socket: HubSocket): void {
    const existingSessionId = this.daemonSessionIdsByHost.get(hostId);
    if (existingSessionId && existingSessionId !== sessionId) {
      this.unregisterDaemon(existingSessionId);
    }
    this.daemonSessions.set(sessionId, { hostId, socket });
    this.daemonSessionIdsByHost.set(hostId, sessionId);
  }

  unregisterDaemon(sessionId: string): void {
    const entry = this.daemonSessions.get(sessionId);
    if (!entry) {
      return;
    }
    this.daemonSessions.delete(sessionId);
    if (this.daemonSessionIdsByHost.get(entry.hostId) === sessionId) {
      this.daemonSessionIdsByHost.delete(entry.hostId);
    }
  }

  closeDaemonSession(
    sessionId: string,
    reason: "daemon-disconnect" | "expired" | "replaced",
  ): void {
    const entry = this.daemonSessions.get(sessionId);
    if (!entry) {
      return;
    }
    entry.socket.send(JSON.stringify({ type: "session-close", reason }));
    entry.socket.close(1000, reason);
    this.unregisterDaemon(sessionId);
  }

  async waitForCommands(hostId: string, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const waiter: CommandWaiter = {
        reject,
        resolve: (notified) => resolve(notified),
        timeout: setTimeout(() => {
          this.deleteCommandWaiter(hostId, waiter);
          resolve(false);
        }, timeoutMs),
      };
      const waiters = this.commandWaiters.get(hostId) ?? new Set<CommandWaiter>();
      waiters.add(waiter);
      this.commandWaiters.set(hostId, waiters);
    });
  }

  async waitForCommandResult(
    commandId: string,
    timeoutMs: number,
  ): Promise<unknown> {
    const cached = this.commandResultCache.get(commandId);
    if (cached !== undefined) {
      return cached;
    }

    return new Promise<unknown>((resolve, reject) => {
      const waiter: CommandResultWaiter = {
        reject,
        resolve,
        timeout: setTimeout(() => {
          this.deleteCommandResultWaiter(commandId, waiter);
          reject(new Error("Timed out waiting for command result"));
        }, timeoutMs),
      };
      const waiters =
        this.commandResultWaiters.get(commandId) ?? new Set<CommandResultWaiter>();
      waiters.add(waiter);
      this.commandResultWaiters.set(commandId, waiters);
    });
  }

  recordCommandResult(commandId: string, result: unknown): void {
    this.commandResultCache.set(commandId, result);
    setTimeout(() => {
      this.commandResultCache.delete(commandId);
    }, COMMAND_RESULT_CACHE_TTL_MS);

    const waiters = this.commandResultWaiters.get(commandId);
    if (!waiters) {
      return;
    }

    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve(result);
    }
    this.commandResultWaiters.delete(commandId);
  }

  notifyThread(threadId: string, changes: ThreadChangeKind[]): void {
    this.notifyClients({
      type: "changed",
      entity: "thread",
      id: threadId,
      changes,
    });
  }

  notifyProject(projectId: string, changes: ProjectChangeKind[]): void {
    this.notifyClients({
      type: "changed",
      entity: "project",
      id: projectId,
      changes,
    });
  }

  notifyEnvironment(environmentId: string, changes: EnvironmentChangeKind[]): void {
    this.notifyClients({
      type: "changed",
      entity: "environment",
      id: environmentId,
      changes,
    });
  }

  notifyCommand(hostId: string): void {
    this.notifyDaemon(hostId);

    const waiters = this.commandWaiters.get(hostId);
    if (!waiters) {
      return;
    }

    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve(true);
    }
    this.commandWaiters.delete(hostId);
  }

  notifySystem(changes: SystemChangeKind[]): void {
    this.notifyClients({
      type: "changed",
      entity: "system",
      changes,
    });
  }

  private deleteCommandResultWaiter(
    commandId: string,
    waiter: CommandResultWaiter,
  ): void {
    const waiters = this.commandResultWaiters.get(commandId);
    if (!waiters) {
      return;
    }
    clearTimeout(waiter.timeout);
    waiters.delete(waiter);
    if (waiters.size === 0) {
      this.commandResultWaiters.delete(commandId);
    }
  }

  private deleteCommandWaiter(hostId: string, waiter: CommandWaiter): void {
    const waiters = this.commandWaiters.get(hostId);
    if (!waiters) {
      return;
    }
    clearTimeout(waiter.timeout);
    waiters.delete(waiter);
    if (waiters.size === 0) {
      this.commandWaiters.delete(hostId);
    }
  }

  private notifyClients(message: ChangedMessage): void {
    const sockets = new Set<HubSocket>();
    const entitySockets = this.clientSocketsByKey.get(subKey(message.entity));
    if (entitySockets) {
      for (const socket of entitySockets) {
        sockets.add(socket);
      }
    }

    if ("id" in message && message.id) {
      const specificSockets = this.clientSocketsByKey.get(
        subKey(message.entity, message.id),
      );
      if (specificSockets) {
        for (const socket of specificSockets) {
          sockets.add(socket);
        }
      }
    }

    const payload = JSON.stringify(message);
    for (const socket of sockets) {
      socket.send(payload);
    }
  }

  notifyDaemon(
    hostId: string,
    message: { type: "commands-available" } = { type: "commands-available" },
  ): void {
    const sessionId = this.daemonSessionIdsByHost.get(hostId);
    if (!sessionId) {
      return;
    }
    this.daemonSessions.get(sessionId)?.socket.send(JSON.stringify(message));
  }
}

import { createServer } from "node:net";
import type {
  EnvironmentDaemonStatusSnapshot,
} from "@bb/environment-daemon";
import type {
  ChangedMessage,
  Project,
  Thread,
  ThreadEvent,
  ThreadQueuedMessage,
} from "@bb/core";
import type {
  EnvironmentDaemonSessionCloseReason,
  EnvironmentDaemonSessionStatus,
} from "@bb/db";

export interface EnvironmentDaemonSessionDebugView {
  id: string;
  environmentId: string;
  agentId: string;
  agentInstanceId: string;
  protocolVersion: number;
  status: EnvironmentDaemonSessionStatus;
  leaseExpiresAt: number;
  lastHeartbeatAt?: number;
  closedAt?: number;
  closeReason?: EnvironmentDaemonSessionCloseReason;
  controlBaseUrl?: string;
  createdAt: number;
  updatedAt: number;
}

export async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${body || response.statusText}`);
  }
  return (await response.json()) as T;
}

export async function readError(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: string }> {
  const response = await fetch(url, init);
  return {
    status: response.status,
    body: await response.text(),
  };
}

export async function createProject(
  baseUrl: string,
  rootPath: string,
  name: string = "e2e-env-daemon-project",
): Promise<Project> {
  return readJson<Project>(`${baseUrl}/api/v1/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, rootPath }),
  });
}

export async function createThread(
  baseUrl: string,
  projectId: string,
  inputText: string = "Prepare a thread for environment-daemon e2e.",
  opts?: { environmentKind?: string; environmentId?: string; providerId?: string },
): Promise<Thread> {
  return readJson<Thread>(`${baseUrl}/api/v1/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId,
      ...(opts?.providerId ? { providerId: opts.providerId } : {}),
      ...(opts?.environmentKind
        ? {
            environmentCreationArgs: {
              kind: opts.environmentKind,
            },
          }
        : {}),
      ...(opts?.environmentId ? { environmentId: opts.environmentId } : {}),
      input: [{ type: "text", text: inputText }],
    }),
  });
}

export async function tellThread(
  baseUrl: string,
  threadId: string,
  inputText: string,
): Promise<{ ok: boolean }> {
  return readJson<{ ok: boolean }>(`${baseUrl}/api/v1/threads/${threadId}/tell`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: [{ type: "text", text: inputText }],
    }),
  });
}

export async function enqueueThreadFollowUp(
  baseUrl: string,
  threadId: string,
  inputText: string,
): Promise<ThreadQueuedMessage> {
  return readJson<ThreadQueuedMessage>(`${baseUrl}/api/v1/threads/${threadId}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: [{ type: "text", text: inputText }],
    }),
  });
}

export async function sendQueuedThreadFollowUp(
  baseUrl: string,
  threadId: string,
  queuedMessageId: string,
  mode: "auto" | "steer-if-active" | "steer" = "auto",
): Promise<{ ok: boolean; queuedMessage: ThreadQueuedMessage }> {
  return readJson<{ ok: boolean; queuedMessage: ThreadQueuedMessage }>(
    `${baseUrl}/api/v1/threads/${threadId}/queue/${queuedMessageId}/send`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    },
  );
}

export async function archiveThread(baseUrl: string, threadId: string): Promise<{ ok: boolean }> {
  return readJson<{ ok: boolean }>(`${baseUrl}/api/v1/threads/${threadId}/archive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

export async function unarchiveThread(
  baseUrl: string,
  threadId: string,
): Promise<{ ok: boolean }> {
  return readJson<{ ok: boolean }>(`${baseUrl}/api/v1/threads/${threadId}/unarchive`, {
    method: "POST",
  });
}

export async function waitForThreadStatus(
  baseUrl: string,
  threadId: string,
  expectedStatus: Thread["status"],
  timeoutMs: number = 5_000,
  wsUrl?: string,
): Promise<Thread> {
  return waitForThreadCondition({
    threadId,
    timeoutMs,
    wsUrl,
    load: async () => readJson<Thread>(`${baseUrl}/api/v1/threads/${threadId}`),
    isReady: (thread) => thread.status === expectedStatus,
    describeLast: (thread) =>
      `Thread ${threadId} did not reach ${expectedStatus} (last status=${thread?.status ?? "unknown"})`,
  });
}

export async function listThreadEvents(
  baseUrl: string,
  threadId: string,
): Promise<ThreadEvent[]> {
  return readJson<ThreadEvent[]>(`${baseUrl}/api/v1/threads/${threadId}/events`);
}

export async function getEnvironmentDaemonStatus(
  baseUrl: string,
  threadId: string,
): Promise<EnvironmentDaemonStatusSnapshot> {
  return readJson<EnvironmentDaemonStatusSnapshot>(
    `${baseUrl}/api/v1/threads/${threadId}/environment-daemon/status`,
  );
}

export async function listEnvironmentDaemonSessions(
  baseUrl: string,
  environmentId: string,
): Promise<{
  environmentId: string;
  sessions: EnvironmentDaemonSessionDebugView[];
}> {
  return readJson<{
    environmentId: string;
    sessions: EnvironmentDaemonSessionDebugView[];
  }>(`${baseUrl}/api/v1/environments/${environmentId}/env-daemon/sessions`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface WaitForThreadConditionOptions<T> {
  threadId: string;
  timeoutMs?: number;
  wsUrl?: string;
  load: () => Promise<T>;
  isReady: (value: T) => boolean;
  describeLast: (value: T | undefined) => string;
}

interface ThreadSubscription {
  waitForNextChange: (timeoutMs: number) => Promise<void>;
  close: () => Promise<void>;
}

export async function waitForThreadCondition<T>(
  opts: WaitForThreadConditionOptions<T>,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  const subscription = opts.wsUrl
    ? await openThreadSubscription(opts.wsUrl, opts.threadId).catch(() => undefined)
    : undefined;
  let lastValue: T | undefined;

  try {
    while (Date.now() < deadline) {
      lastValue = await opts.load();
      if (opts.isReady(lastValue)) {
        return lastValue;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }

      if (subscription) {
        await subscription.waitForNextChange(remainingMs);
      } else {
        await sleep(25);
      }
    }
  } finally {
    await subscription?.close();
  }

  throw new Error(opts.describeLast(lastValue));
}

async function openThreadSubscription(
  wsUrl: string,
  threadId: string,
): Promise<ThreadSubscription> {
  const socket = new WebSocket(wsUrl);
  const queuedSignals: true[] = [];
  const pendingResolvers = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
  }>();
  let closedError: Error | undefined;

  const rejectPending = (error: Error) => {
    closedError = error;
    for (const pending of pendingResolvers) {
      pending.reject(error);
    }
    pendingResolvers.clear();
  };

  await new Promise<void>((resolveOpen, rejectOpen) => {
    const handleOpen = () => {
      socket.removeEventListener("error", handleOpenError);
      socket.send(JSON.stringify({ type: "subscribe", entity: "thread", id: threadId }));
      resolveOpen();
    };
    const handleOpenError = (event: Event) => {
      socket.removeEventListener("open", handleOpen);
      rejectOpen(new Error(`Failed to open session stream for thread ${threadId}`));
    };

    socket.addEventListener("open", handleOpen, { once: true });
    socket.addEventListener("error", handleOpenError, { once: true });
  });

  socket.addEventListener("message", (event: MessageEvent) => {
    let parsed: ChangedMessage | undefined;
    try {
      if (typeof event.data !== "string") {
        return;
      }
      parsed = JSON.parse(event.data) as ChangedMessage;
    } catch {
      return;
    }

    if (parsed.type !== "changed" || parsed.entity !== "thread") {
      return;
    }
    if (parsed.id && parsed.id !== threadId) {
      return;
    }

    const nextPending = pendingResolvers.values().next().value as
      | {
          resolve: () => void;
          reject: (error: Error) => void;
        }
      | undefined;
    if (nextPending) {
      pendingResolvers.delete(nextPending);
      nextPending.resolve();
      return;
    }

    queuedSignals.push(true);
  });

  socket.addEventListener("close", () => {
    rejectPending(new Error(`WebSocket closed while waiting for thread ${threadId}`));
  });
  socket.addEventListener("error", () => {
    rejectPending(new Error(`WebSocket errored while waiting for thread ${threadId}`));
  });

  return {
    waitForNextChange: (timeoutMs: number) => {
      if (queuedSignals.length > 0) {
        queuedSignals.shift();
        return Promise.resolve();
      }
      if (closedError) {
        return Promise.reject(closedError);
      }

      return new Promise<void>((resolveWait, rejectWait) => {
        const pending = {
          resolve: () => {
            clearTimeout(timer);
            resolveWait();
          },
          reject: (error: Error) => {
            clearTimeout(timer);
            rejectWait(error);
          },
        };
        const timer = setTimeout(() => {
          pendingResolvers.delete(pending);
          resolveWait();
        }, timeoutMs);
        pendingResolvers.add(pending);
      });
    },
    close: async () => {
      if (socket.readyState === WebSocket.CLOSED) {
        return;
      }
      await new Promise<void>((resolveClose) => {
        socket.addEventListener("close", () => resolveClose(), { once: true });
        socket.close();
      });
    },
  };
}

export async function allocateLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

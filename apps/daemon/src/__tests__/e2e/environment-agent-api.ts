import { createServer } from "node:net";
import type {
  EnvironmentAgentStatusSnapshot,
} from "@beanbag/environment-agent";
import type { ChangedMessage, Project, Thread, ThreadEvent } from "@beanbag/agent-core";

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
  name: string = "e2e-env-agent-project",
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
  inputText: string = "Prepare a thread for environment-agent e2e.",
): Promise<Thread> {
  return readJson<Thread>(`${baseUrl}/api/v1/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId,
      input: [{ type: "text", text: inputText }],
    }),
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

export async function getEnvironmentAgentStatus(
  baseUrl: string,
  threadId: string,
): Promise<EnvironmentAgentStatusSnapshot> {
  return readJson<EnvironmentAgentStatusSnapshot>(
    `${baseUrl}/api/v1/threads/${threadId}/environment-agent/status`,
  );
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

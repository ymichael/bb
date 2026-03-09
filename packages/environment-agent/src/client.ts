import type {
  JsonLineTransport,
  JsonLineTransportHandlers,
} from "./transport.js";
import {
  isEnvironmentAgentControlResponse,
  isEnvironmentAgentLiveEventMessage,
  type EnvironmentAgentAckRequest,
  type EnvironmentAgentAckResponse,
  type EnvironmentAgentControlRequest,
  type EnvironmentAgentEventEnvelope,
  type EnvironmentAgentProviderSpec,
  type EnvironmentAgentProviderStatus,
  type EnvironmentAgentReplayRequest,
  type EnvironmentAgentReplayResponse,
  type EnvironmentAgentStatusSnapshot,
} from "./protocol.js";

interface PendingControlRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

type EnvironmentAgentRequestShape =
  | { type: "provider.ensure"; payload: EnvironmentAgentProviderSpec }
  | { type: "delivery.retry" }
  | { type: "ack"; payload: EnvironmentAgentAckRequest }
  | { type: "replay"; payload: EnvironmentAgentReplayRequest }
  | { type: "status" };

export interface EnvironmentAgentClient {
  readonly providerTransport: JsonLineTransport;
  ensureProviderRunning(
    spec: EnvironmentAgentProviderSpec,
  ): Promise<EnvironmentAgentProviderStatus>;
  retryDaemonDelivery(): Promise<EnvironmentAgentStatusSnapshot>;
  acknowledge(request: EnvironmentAgentAckRequest): Promise<EnvironmentAgentAckResponse>;
  replay(request: EnvironmentAgentReplayRequest): Promise<EnvironmentAgentReplayResponse>;
  status(): Promise<EnvironmentAgentStatusSnapshot>;
  getLatestObservedSequence(): number;
  close(reason?: Error): void;
}

export class EnvironmentAgentClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentAgentClientError";
  }
}

class EnvironmentAgentClientImpl implements EnvironmentAgentClient {
  readonly providerTransport: JsonLineTransport;
  private providerHandlers: JsonLineTransportHandlers | undefined;
  private readonly pending = new Map<string, PendingControlRequest>();
  private requestCounter = 0;
  private latestObservedSequence = 0;
  private closed = false;

  constructor(private readonly transport: JsonLineTransport) {
    this.providerTransport = {
      setHandlers: (handlers) => {
        this.providerHandlers = handlers;
      },
      send: (line) => {
        this.transport.send(line);
      },
      close: (reason) => {
        this.close(reason);
      },
    };

    this.transport.setHandlers({
      onLine: (line) => {
        this.handleLine(line);
      },
      onStderrLine: (line) => {
        this.providerHandlers?.onStderrLine?.(line);
      },
      onClose: (reason) => {
        this.close(reason);
      },
    });
  }

  acknowledge(request: EnvironmentAgentAckRequest): Promise<EnvironmentAgentAckResponse> {
    return this.request<EnvironmentAgentAckResponse>({
      type: "ack",
      payload: request,
    });
  }

  ensureProviderRunning(
    spec: EnvironmentAgentProviderSpec,
  ): Promise<EnvironmentAgentProviderStatus> {
    return this.request<EnvironmentAgentProviderStatus>({
      type: "provider.ensure",
      payload: spec,
    });
  }

  retryDaemonDelivery(): Promise<EnvironmentAgentStatusSnapshot> {
    return this.request<EnvironmentAgentStatusSnapshot>({
      type: "delivery.retry",
    });
  }

  replay(request: EnvironmentAgentReplayRequest): Promise<EnvironmentAgentReplayResponse> {
    return this.request<EnvironmentAgentReplayResponse>({
      type: "replay",
      payload: request,
    });
  }

  status(): Promise<EnvironmentAgentStatusSnapshot> {
    return this.request<EnvironmentAgentStatusSnapshot>({
      type: "status",
    });
  }

  getLatestObservedSequence(): number {
    return this.latestObservedSequence;
  }

  close(reason?: Error): void {
    if (this.closed) return;
    this.closed = true;

    const closeError =
      reason ?? new EnvironmentAgentClientError("Environment agent transport closed");
    for (const [requestId, pending] of this.pending) {
      pending.reject(closeError);
      this.pending.delete(requestId);
    }

    this.transport.close(closeError);
    this.providerHandlers?.onClose?.(closeError);
  }

  private handleLine(line: string): void {
    const parsed = parseJson(line);
    if (parsed && isEnvironmentAgentLiveEventMessage(parsed)) {
      this.recordObservedEvent(parsed.payload);
      return;
    }

    if (!parsed || !isEnvironmentAgentControlResponse(parsed)) {
      this.providerHandlers?.onLine(line);
      return;
    }

    const pending = this.pending.get(parsed.requestId);
    if (!pending) return;
    this.pending.delete(parsed.requestId);
    pending.resolve(parsed.payload);
  }

  private recordObservedEvent(event: EnvironmentAgentEventEnvelope): void {
    this.latestObservedSequence = Math.max(this.latestObservedSequence, event.sequence);
  }

  private request<TResponse>(
    args: EnvironmentAgentRequestShape,
  ): Promise<TResponse> {
    if (this.closed) {
      return Promise.reject(
        new EnvironmentAgentClientError("Environment agent transport is closed"),
      );
    }

    const requestId = `env-agent-${++this.requestCounter}`;
    const message: EnvironmentAgentControlRequest = {
      environmentAgentMessage: true,
      requestId,
      ...args,
    };

    return new Promise<TResponse>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: (value) => {
          resolve(value as TResponse);
        },
        reject,
      });
      try {
        this.transport.send(JSON.stringify(message));
      } catch (error) {
        this.pending.delete(requestId);
        reject(
          error instanceof Error
            ? error
            : new EnvironmentAgentClientError(String(error)),
        );
      }
    });
  }
}

function parseJson(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export function createEnvironmentAgentClient(
  transport: JsonLineTransport,
): EnvironmentAgentClient {
  return new EnvironmentAgentClientImpl(transport);
}

export async function createHttpEnvironmentAgentClient(args: {
  baseUrl: string;
  headers?: Record<string, string>;
}): Promise<EnvironmentAgentClient> {
  const headers = {
    "content-type": "application/json",
    ...(args.headers ?? {}),
  };
  let handlers: JsonLineTransportHandlers | undefined;
  let closed = false;
  const abortController = new AbortController();

  const streamPromise = fetch(`${args.baseUrl}/stream`, {
    method: "GET",
    headers: args.headers,
    signal: abortController.signal,
  }).then(async (response) => {
    if (!response.ok || !response.body) {
      throw new EnvironmentAgentClientError(
        `Environment agent stream failed: ${response.status}`,
      );
    }

    const reader = response.body
      .pipeThrough(new TextDecoderStream())
      .getReader();
    let buffer = "";
    while (!closed) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split(/\r\n|\n|\r/g);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        handlers?.onLine(line);
      }
    }
  }).catch((error) => {
    if (!closed) {
      handlers?.onClose?.(
        error instanceof Error ? error : new EnvironmentAgentClientError(String(error)),
      );
    }
  });

  const transport: JsonLineTransport = {
    setHandlers(nextHandlers) {
      handlers = nextHandlers;
    },
    send(line) {
      void fetch(`${args.baseUrl}/provider-line`, {
        method: "POST",
        headers,
        body: JSON.stringify({ line }),
      }).then((response) => {
        if (!response.ok) {
          throw new EnvironmentAgentClientError(
            `Environment agent provider send failed: ${response.status}`,
          );
        }
      }).catch((error) => {
        handlers?.onClose?.(
          error instanceof Error ? error : new EnvironmentAgentClientError(String(error)),
        );
      });
    },
    close(reason) {
      if (closed) return;
      closed = true;
      abortController.abort();
      handlers?.onClose?.(reason);
    },
  };

  void streamPromise;
  const client = createEnvironmentAgentClient(transport);

  const postJson = async <TResponse>(path: string, body: unknown): Promise<TResponse> => {
    const response = await fetch(`${args.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new EnvironmentAgentClientError(
        `Environment agent request failed: ${response.status}`,
      );
    }
    return response.json() as Promise<TResponse>;
  };

    return {
      providerTransport: client.providerTransport,
      ensureProviderRunning(spec) {
        return postJson<EnvironmentAgentProviderStatus>("/control/provider/ensure", spec);
      },
      retryDaemonDelivery() {
        return postJson<EnvironmentAgentStatusSnapshot>("/control/delivery/retry", {});
      },
      acknowledge(request) {
        return postJson<EnvironmentAgentAckResponse>("/control/ack", request);
      },
    replay(request) {
      return postJson<EnvironmentAgentReplayResponse>("/control/replay", request);
    },
    status() {
      return postJson<EnvironmentAgentStatusSnapshot>("/control/status", {});
    },
    getLatestObservedSequence() {
      return client.getLatestObservedSequence();
    },
    close(reason) {
      client.close(reason);
    },
  };
}

import type {
  JsonLineTransport,
  JsonLineTransportHandlers,
} from "./transport.js";
import {
  isEnvironmentDaemonControlResponse,
  type EnvironmentDaemonCommandAck,
  type EnvironmentDaemonCommandEnvelope,
  type EnvironmentDaemonControlRequest,
  type EnvironmentDaemonProviderSpec,
  type EnvironmentDaemonProviderStatus,
  type EnvironmentDaemonStatusSnapshot,
} from "./protocol.js";

interface PendingControlRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

type EnvironmentDaemonRequestShape =
  | { type: "command"; payload: EnvironmentDaemonCommandEnvelope }
  | { type: "provider.ensure"; payload: EnvironmentDaemonProviderSpec }
  | { type: "status" };

export interface EnvironmentDaemonClient {
  readonly providerTransport: JsonLineTransport;
  sendCommand(
    envelope: EnvironmentDaemonCommandEnvelope,
  ): Promise<EnvironmentDaemonCommandAck>;
  ensureProviderRunning(
    spec: EnvironmentDaemonProviderSpec,
    forThreadId?: string,
  ): Promise<EnvironmentDaemonProviderStatus>;
  status(): Promise<EnvironmentDaemonStatusSnapshot>;
  close(reason?: Error): void;
}

export class EnvironmentDaemonClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentDaemonClientError";
  }
}

class EnvironmentDaemonClientImpl implements EnvironmentDaemonClient {
  readonly providerTransport: JsonLineTransport;
  private providerHandlers: JsonLineTransportHandlers | undefined;
  private readonly pending = new Map<string, PendingControlRequest>();
  private requestCounter = 0;
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

  ensureProviderRunning(
    spec: EnvironmentDaemonProviderSpec,
    forThreadId?: string,
  ): Promise<EnvironmentDaemonProviderStatus> {
    return this.request<EnvironmentDaemonProviderStatus>({
      type: "provider.ensure",
      payload: { ...spec, ...(forThreadId ? { forThreadId } : {}) },
    });
  }

  sendCommand(
    envelope: EnvironmentDaemonCommandEnvelope,
  ): Promise<EnvironmentDaemonCommandAck> {
    return this.request<EnvironmentDaemonCommandAck>({
      type: "command",
      payload: envelope,
    });
  }

  status(): Promise<EnvironmentDaemonStatusSnapshot> {
    return this.request<EnvironmentDaemonStatusSnapshot>({
      type: "status",
    });
  }

  close(reason?: Error): void {
    if (this.closed) return;
    this.closed = true;

    const closeError =
      reason ?? new EnvironmentDaemonClientError("Environment agent transport closed");
    for (const [requestId, pending] of this.pending) {
      pending.reject(closeError);
      this.pending.delete(requestId);
    }

    this.transport.close(closeError);
    this.providerHandlers?.onClose?.(closeError);
  }

  private handleLine(line: string): void {
    const parsed = parseJson(line);
    if (!parsed || !isEnvironmentDaemonControlResponse(parsed)) {
      this.providerHandlers?.onLine(line);
      return;
    }

    const pending = this.pending.get(parsed.requestId);
    if (!pending) return;
    this.pending.delete(parsed.requestId);
    pending.resolve(parsed.payload);
  }

  private request<TResponse>(
    args: EnvironmentDaemonRequestShape,
  ): Promise<TResponse> {
    if (this.closed) {
      return Promise.reject(
        new EnvironmentDaemonClientError("Environment agent transport is closed"),
      );
    }

    const requestId = `env-agent-${++this.requestCounter}`;
    const message: EnvironmentDaemonControlRequest = {
      environmentDaemonMessage: true,
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
            : new EnvironmentDaemonClientError(String(error)),
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

export function createEnvironmentDaemonClient(
  transport: JsonLineTransport,
): EnvironmentDaemonClient {
  return new EnvironmentDaemonClientImpl(transport);
}

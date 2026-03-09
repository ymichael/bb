import type { ChildProcess } from "node:child_process";
import {
  createChildProcessJsonLineTransport,
  type JsonLineTransport,
  type JsonLineTransportHandlers,
} from "./transport.js";
import {
  isEnvironmentAgentControlResponse,
  type EnvironmentAgentAckRequest,
  type EnvironmentAgentAckResponse,
  type EnvironmentAgentControlRequest,
  type EnvironmentAgentReplayRequest,
  type EnvironmentAgentReplayResponse,
  type EnvironmentAgentStatusSnapshot,
} from "./protocol.js";

interface PendingControlRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

type EnvironmentAgentRequestShape =
  | { type: "ack"; payload: EnvironmentAgentAckRequest }
  | { type: "replay"; payload: EnvironmentAgentReplayRequest }
  | { type: "status" };

export interface EnvironmentAgentClient {
  readonly providerTransport: JsonLineTransport;
  acknowledge(request: EnvironmentAgentAckRequest): Promise<EnvironmentAgentAckResponse>;
  replay(request: EnvironmentAgentReplayRequest): Promise<EnvironmentAgentReplayResponse>;
  status(): Promise<EnvironmentAgentStatusSnapshot>;
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
    if (!parsed || !isEnvironmentAgentControlResponse(parsed)) {
      this.providerHandlers?.onLine(line);
      return;
    }

    const pending = this.pending.get(parsed.requestId);
    if (!pending) return;
    this.pending.delete(parsed.requestId);
    pending.resolve(parsed.payload);
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

export function createChildProcessEnvironmentAgentClient(
  child: ChildProcess,
): EnvironmentAgentClient {
  return createEnvironmentAgentClient(createChildProcessJsonLineTransport(child));
}

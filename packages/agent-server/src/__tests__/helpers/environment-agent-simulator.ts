import {
  createEnvironmentAgentClient,
  ENVIRONMENT_AGENT_PROTOCOL_VERSION,
  type EnvironmentAgentAckRequest,
  type EnvironmentAgentAckResponse,
  type EnvironmentAgentClient,
  type EnvironmentAgentControlRequest,
  type EnvironmentAgentControlResponse,
  type EnvironmentAgentEvent,
  type EnvironmentAgentEventEnvelope,
  type EnvironmentAgentProviderSpec,
  type EnvironmentAgentProviderStatus,
  type EnvironmentAgentReplayRequest,
  type EnvironmentAgentReplayResponse,
  type EnvironmentAgentStatusSnapshot,
  isEnvironmentAgentControlRequest,
  type JsonLineTransport,
  type JsonLineTransportHandlers,
} from "@beanbag/environment-agent";

interface ProviderRequest {
  id?: string | number;
  method: string;
  params?: unknown;
}

type ProviderResponse =
  | { result: unknown }
  | { error: { code: number; message: string; data?: unknown } };

type ProviderRequestHandler = (request: ProviderRequest) => ProviderResponse | void;

interface EnvironmentAgentSimulatorOptions {
  threadId?: string;
  providerThreadId?: string;
  status?: Partial<EnvironmentAgentStatusSnapshot>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isProviderRequest(value: unknown): value is ProviderRequest {
  return (
    isRecord(value) &&
    value.jsonrpc === "2.0" &&
    typeof value.method === "string"
  );
}

function toResponseType(type: EnvironmentAgentControlRequest["type"]): EnvironmentAgentControlResponse["type"] {
  switch (type) {
    case "provider.ensure":
      return "provider.ensure.response";
    case "delivery.retry":
      return "delivery.retry.response";
    case "ack":
      return "ack.response";
    case "replay":
      return "replay.response";
    case "status":
      return "status.response";
    default:
      return type satisfies never;
  }
}

class FakeEnvironmentAgentTransport implements JsonLineTransport {
  private handlers: JsonLineTransportHandlers | undefined;

  constructor(private readonly simulator: EnvironmentAgentSimulator) {}

  setHandlers(handlers: JsonLineTransportHandlers): void {
    this.handlers = handlers;
  }

  send(line: string): void {
    this.simulator.handleOutgoingLine(line);
  }

  close(reason?: Error): void {
    this.handlers?.onClose?.(reason);
  }

  emitLine(line: string): void {
    this.handlers?.onLine(line);
  }

  emitStderrLine(line: string): void {
    this.handlers?.onStderrLine?.(line);
  }
}

export class EnvironmentAgentSimulator {
  readonly providerRequests: ProviderRequest[] = [];
  readonly ensureRequests: EnvironmentAgentProviderSpec[] = [];
  readonly ackRequests: EnvironmentAgentAckRequest[] = [];
  readonly replayRequests: EnvironmentAgentReplayRequest[] = [];
  readonly retryRequests: number[] = [];
  readonly statusRequests: number[] = [];

  private readonly transport = new FakeEnvironmentAgentTransport(this);
  private readonly providerHandlers = new Map<string, ProviderRequestHandler>();
  private readonly replayEvents: EnvironmentAgentEventEnvelope[] = [];
  private readonly status: EnvironmentAgentStatusSnapshot;
  private readonly providerThreadId: string;
  private nextSequence = 1;

  constructor(options: EnvironmentAgentSimulatorOptions = {}) {
    const threadId = options.threadId ?? "thread-1";
    this.providerThreadId = options.providerThreadId ?? "provider-thread-1";
    this.status = {
      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
      threadId,
      latestSequence: 0,
      connectedToDaemon: true,
      pendingEventCount: 0,
      pendingCommandCount: 0,
      ...(options.status ?? {}),
    };

    this.onProviderRequest("initialize", () => ({ result: {} }));
    this.onProviderRequest("thread/start", () => {
      this.emitEvent({
        type: "environment.ready",
        threadId,
      });
      return {
        result: { threadId: this.providerThreadId },
      };
    });
    this.onProviderRequest("thread/resume", () => ({
      result: { threadId: this.providerThreadId },
    }));
  }

  createClient(): EnvironmentAgentClient {
    return createEnvironmentAgentClient(this.transport);
  }

  onProviderRequest(method: string, handler: ProviderRequestHandler): void {
    this.providerHandlers.set(method, handler);
  }

  setReplayEvents(events: EnvironmentAgentEventEnvelope[]): void {
    this.replayEvents.length = 0;
    this.replayEvents.push(...events);
    this.syncStatus();
  }

  emitEvent<TEvent extends EnvironmentAgentEvent>(
    event: TEvent,
    options?: { sequence?: number; emittedAt?: number },
  ): EnvironmentAgentEventEnvelope<TEvent> {
    const sequence = options?.sequence ?? this.nextSequence++;
    this.nextSequence = Math.max(this.nextSequence, sequence + 1);
    const envelope: EnvironmentAgentEventEnvelope<TEvent> = {
      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
      sequence,
      emittedAt: options?.emittedAt ?? 1_000 + sequence,
      threadId: event.threadId,
      event,
    };
    this.transport.emitLine(
      JSON.stringify({
        environmentAgentMessage: true,
        type: "event.emitted",
        payload: envelope,
      }),
    );
    this.syncStatus();
    return envelope;
  }

  emitProviderEvent(
    method: string,
    payload: unknown,
    options?: { sequence?: number; threadId?: string; emittedAt?: number },
  ): EnvironmentAgentEventEnvelope<Extract<EnvironmentAgentEvent, { type: "provider.event" }>> {
    return this.emitEvent(
      {
        type: "provider.event",
        threadId: options?.threadId ?? (this.status.threadId ?? "thread-1"),
        method,
        payload,
      },
      options,
    );
  }

  emitProviderNotification(
    method: string,
    payload: unknown,
    options?: { sequence?: number; threadId?: string; emittedAt?: number },
  ): EnvironmentAgentEventEnvelope<Extract<EnvironmentAgentEvent, { type: "provider.event" }>> {
    const envelope = this.emitProviderEvent(method, payload, options);
    this.transport.emitLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method,
        params: payload,
      }),
    );
    return envelope;
  }

  emitProviderStderr(line: string): void {
    this.transport.emitStderrLine(line);
  }

  close(reason?: Error): void {
    this.transport.close(reason);
  }

  handleOutgoingLine(line: string): void {
    const parsed = this.parseJson(line);
    if (!parsed) {
      return;
    }
    if (isProviderRequest(parsed)) {
      this.handleProviderRequest(parsed);
      return;
    }
    if (isEnvironmentAgentControlRequest(parsed)) {
      this.handleControlRequest(parsed);
    }
  }

  private handleProviderRequest(request: ProviderRequest): void {
    this.providerRequests.push(request);
    const handler = this.providerHandlers.get(request.method);
    if (!handler || request.id === undefined) {
      return;
    }
    const response = handler(request);
    if (!response) {
      return;
    }
    this.transport.emitLine(
      JSON.stringify(
        "result" in response
          ? {
              jsonrpc: "2.0",
              id: request.id,
              result: response.result,
            }
          : {
              jsonrpc: "2.0",
              id: request.id,
              error: response.error,
            },
      ),
    );
  }

  private handleControlRequest(request: EnvironmentAgentControlRequest): void {
    switch (request.type) {
      case "provider.ensure":
        this.ensureRequests.push(request.payload);
        this.respond(request, {
          running: true,
          launched: true,
          pid: 12345,
        } satisfies EnvironmentAgentProviderStatus);
        return;
      case "delivery.retry":
        this.retryRequests.push(Date.now());
        this.respond(request, this.snapshot());
        return;
      case "ack":
        this.ackRequests.push(request.payload);
        this.status.lastAckedSequence = Math.max(
          this.status.lastAckedSequence ?? 0,
          request.payload.sequence,
        );
        this.syncStatus();
        this.respond(request, {
          protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
          acknowledgedSequence: request.payload.sequence,
          ...(request.payload.threadId ? { threadId: request.payload.threadId } : {}),
        } satisfies EnvironmentAgentAckResponse);
        return;
      case "replay":
        this.replayRequests.push(request.payload);
        this.respond(request, this.buildReplayResponse(request.payload));
        return;
      case "status":
        this.statusRequests.push(Date.now());
        this.respond(request, this.snapshot());
        return;
      default:
        return request satisfies never;
    }
  }

  private buildReplayResponse(
    request: EnvironmentAgentReplayRequest,
  ): EnvironmentAgentReplayResponse {
    const matching = this.replayEvents
      .filter((event) => event.sequence > request.afterSequence)
      .slice(0, request.limit);
    const toSequenceInclusive =
      matching.at(-1)?.sequence ?? request.afterSequence;

    return {
      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
      fromSequenceExclusive: request.afterSequence,
      toSequenceInclusive,
      events: matching,
      hasMore:
        typeof request.limit === "number" &&
        matching.length < this.replayEvents.filter(
          (event) => event.sequence > request.afterSequence,
        ).length,
    };
  }

  private respond<TPayload>(
    request: EnvironmentAgentControlRequest,
    payload: TPayload,
  ): void {
    this.transport.emitLine(
      JSON.stringify({
        environmentAgentMessage: true,
        requestId: request.requestId,
        type: toResponseType(request.type),
        payload,
      }),
    );
  }

  private snapshot(): EnvironmentAgentStatusSnapshot {
    return { ...this.status };
  }

  private syncStatus(): void {
    const maxReplaySequence = this.replayEvents.reduce(
      (highest, event) => Math.max(highest, event.sequence),
      0,
    );
    this.status.latestSequence = Math.max(
      this.status.latestSequence,
      this.nextSequence - 1,
      maxReplaySequence,
    );
    this.status.pendingEventCount = Math.max(
      0,
      this.status.latestSequence - (this.status.lastAckedSequence ?? 0),
    );
  }

  private parseJson(line: string): unknown {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }
}

export function createEnvironmentAgentSimulator(
  options?: EnvironmentAgentSimulatorOptions,
): EnvironmentAgentSimulator {
  return new EnvironmentAgentSimulator(options);
}

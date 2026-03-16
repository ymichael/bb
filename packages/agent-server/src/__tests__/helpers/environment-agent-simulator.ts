import { assertNever } from "@bb/core";
import {
  createEnvironmentAgentClient,
  ENVIRONMENT_AGENT_PROTOCOL_VERSION,
  type EnvironmentAgentClient,
  type EnvironmentAgentCommand,
  type EnvironmentAgentCommandAck,
  type EnvironmentAgentControlRequest,
  type EnvironmentAgentControlResponse,
  type EnvironmentAgentEvent,
  type EnvironmentAgentEventEnvelope,
  type EnvironmentAgentProviderSpec,
  type EnvironmentAgentProviderStatus,
  type EnvironmentAgentStatusSnapshot,
  isEnvironmentAgentControlRequest,
  type JsonLineTransport,
  type JsonLineTransportHandlers,
} from "@bb/environment-daemon";

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
    case "command":
      return "command.response";
    case "provider.ensure":
      return "provider.ensure.response";
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
  readonly statusRequests: number[] = [];

  private readonly transport = new FakeEnvironmentAgentTransport(this);
  private readonly providerHandlers = new Map<string, ProviderRequestHandler>();
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
      deliveryState: "healthy",
      retryAttemptCount: 0,
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
        jsonrpc: "2.0",
        method: "environmentAgent/event",
        params: envelope,
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
    this.issueProviderRequest(request);
  }

  private issueProviderRequest(
    request: ProviderRequest,
  ): ProviderResponse | undefined {
    this.providerRequests.push(request);
    const handler = this.providerHandlers.get(request.method);
    if (!handler || request.id === undefined) {
      return undefined;
    }
    const response = handler(request);
    if (!response) {
      return undefined;
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
    return response;
  }

  private handleControlRequest(request: EnvironmentAgentControlRequest): void {
    switch (request.type) {
      case "command": {
        const initialize = "initialize" in request.payload.command
          ? request.payload.command.initialize
          : undefined;
        if (initialize) {
          this.issueProviderRequest({
            id: `${request.payload.meta.commandId}:init`,
            method: initialize.method,
            params: initialize.params,
          });
        }
        const providerResponse = this.issueProviderRequest({
          id: request.payload.meta.commandId,
          method: this.toProviderMethod(request.payload.command.type),
          params: this.toProviderParams(request.payload.command),
        });
        this.respond(request, {
          protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
          commandId: request.payload.meta.commandId,
          idempotencyKey: request.payload.meta.idempotencyKey,
          state: providerResponse && "error" in providerResponse ? "rejected" : "accepted",
          acknowledgedAt: Date.now(),
          latestSequence: this.status.latestSequence,
          ...(providerResponse && "error" in providerResponse
            ? { message: providerResponse.error.message, errorCode: "provider_rpc_error" }
            : providerResponse && "result" in providerResponse
              ? { result: providerResponse.result }
              : {}),
        } satisfies EnvironmentAgentCommandAck);
        return;
      }
      case "provider.ensure":
        this.ensureRequests.push(request.payload);
        this.respond(request, {
          running: true,
          launched: true,
          pid: 12345,
        } satisfies EnvironmentAgentProviderStatus);
        return;
      case "status":
        this.statusRequests.push(Date.now());
        this.respond(request, this.snapshot());
        return;
      default:
        return request satisfies never;
    }
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
    this.status.latestSequence = Math.max(
      this.status.latestSequence,
      this.nextSequence - 1,
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

  private toProviderMethod(type: EnvironmentAgentCommand["type"]): string {
    switch (type) {
      case "provider.ensure":
        return "provider/ensure";
      case "thread.start":
        return "thread/start";
      case "thread.resume":
        return "thread/resume";
      case "thread.stop":
        return "thread/stop";
      case "turn.start":
        return "turn/start";
      case "turn.steer":
        return "turn/steer";
      case "thread.rename":
        return "thread/name/set";
      case "workspace.status":
        return "workspace/status";
      case "workspace.diff":
        return "workspace/diff";
      default:
        return type satisfies never;
    }
  }

  private toProviderParams(command: EnvironmentAgentCommand): unknown {
    switch (command.type) {
      case "provider.ensure":
        return command;
      case "thread.start":
      case "thread.resume":
      case "turn.start":
      case "turn.steer":
      case "thread.rename":
        return command.params;
      case "thread.stop":
        return command.params ?? {};
      case "workspace.status":
      case "workspace.diff":
        return { threadId: command.threadId };
    }

    return assertNever(command);
  }
}

export function createEnvironmentAgentSimulator(
  options?: EnvironmentAgentSimulatorOptions,
): EnvironmentAgentSimulator {
  return new EnvironmentAgentSimulator(options);
}

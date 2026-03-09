import { spawn, type ChildProcess } from "node:child_process";
import {
  ENVIRONMENT_AGENT_PROTOCOL_VERSION,
  type EnvironmentAgentAckRequest,
  type EnvironmentAgentAckResponse,
  type EnvironmentAgentCommandAck,
  type EnvironmentAgentControlRequest,
  type EnvironmentAgentConnectionTarget,
  type EnvironmentAgentEvent,
  type EnvironmentAgentEventEnvelope,
  type EnvironmentAgentReplayRequest,
  type EnvironmentAgentReplayResponse,
  type EnvironmentAgentStatusSnapshot,
  isEnvironmentAgentControlRequest,
} from "./protocol.js";

export interface EnvironmentAgentRuntimeOptions {
  threadId?: string;
  projectId?: string;
  environmentId?: string;
  providerCommand: string;
  providerArgs: string[];
  providerLaunchCommand?: string;
  providerLaunchArgs?: string[];
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

type ProtocolInbound =
  | { type: "ack"; payload: EnvironmentAgentAckRequest }
  | { type: "replay"; payload: EnvironmentAgentReplayRequest }
  | { type: "status" };

export class EnvironmentAgentRuntime {
  private readonly events: EnvironmentAgentEventEnvelope[] = [];
  private sequence = 0;
  private lastAckedSequence = 0;
  private pendingCommandCount = 0;
  private providerChild: ChildProcess | null = null;

  constructor(private readonly opts: EnvironmentAgentRuntimeOptions) {}

  start(): ChildProcess {
    const command = this.opts.providerLaunchCommand?.trim() || this.opts.providerCommand;
    const args = this.opts.providerLaunchCommand?.trim()
      ? [
          ...(this.opts.providerLaunchArgs ?? []),
          this.opts.providerCommand,
          ...this.opts.providerArgs,
        ]
      : this.opts.providerArgs;

    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.providerChild = child;

    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r\n|\n|\r/g)) {
        if (!line.trim()) continue;
        if (this.handleProtocolLine(line)) continue;
        child.stdin?.write(`${line}\n`);
      }
    });

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r\n|\n|\r/g)) {
        if (!line.trim()) continue;
        this.opts.onStdoutLine?.(line);
        process.stdout.write(`${line}\n`);
        this.appendEvent({
          type: "provider.event",
          threadId: this.resolveThreadId(),
          method: "provider.stdout",
          payload: { line },
        });
      }
    });

    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r\n|\n|\r/g)) {
        if (!line.trim()) continue;
        this.opts.onStderrLine?.(line);
        process.stderr.write(`${line}\n`);
      }
    });

    this.appendEvent({
      type: "environment.ready",
      threadId: this.resolveThreadId(),
    });

    child.once("exit", (_code, _signal) => {
      this.appendEvent({
        type: "environment.degraded",
        threadId: this.resolveThreadId(),
        message: "Provider runtime exited",
      });
    });

    return child;
  }

  appendEvent(event: EnvironmentAgentEvent): EnvironmentAgentEventEnvelope {
    const envelope: EnvironmentAgentEventEnvelope = {
      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
      sequence: ++this.sequence,
      emittedAt: Date.now(),
      threadId: event.threadId,
      event,
    };
    this.events.push(envelope);
    return envelope;
  }

  acknowledge(request: EnvironmentAgentAckRequest): EnvironmentAgentAckResponse {
    this.lastAckedSequence = Math.max(this.lastAckedSequence, request.sequence);
    return {
      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
      acknowledgedSequence: this.lastAckedSequence,
      ...(request.threadId ? { threadId: request.threadId } : {}),
    };
  }

  replay(request: EnvironmentAgentReplayRequest): EnvironmentAgentReplayResponse {
    const events = this.events.filter((event) => event.sequence > request.afterSequence);
    const limitedEvents =
      request.limit && request.limit > 0 ? events.slice(0, request.limit) : events;
    const toSequenceInclusive =
      limitedEvents.length > 0
        ? limitedEvents[limitedEvents.length - 1]!.sequence
        : request.afterSequence;
    return {
      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
      fromSequenceExclusive: request.afterSequence,
      toSequenceInclusive,
      events: limitedEvents,
      hasMore: limitedEvents.length < events.length,
    };
  }

  createCommandAck(args: {
    commandId: string;
    idempotencyKey: string;
    state: EnvironmentAgentCommandAck["state"];
    message?: string;
  }): EnvironmentAgentCommandAck {
    return {
      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
      commandId: args.commandId,
      idempotencyKey: args.idempotencyKey,
      state: args.state,
      acknowledgedAt: Date.now(),
      latestSequence: this.sequence,
      ...(args.message ? { message: args.message } : {}),
    };
  }

  getStatusSnapshot(): EnvironmentAgentStatusSnapshot {
    return {
      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
      ...(this.opts.threadId ? { threadId: this.opts.threadId } : {}),
      ...(this.opts.projectId ? { projectId: this.opts.projectId } : {}),
      ...(this.opts.environmentId ? { environmentId: this.opts.environmentId } : {}),
      latestSequence: this.sequence,
      ...(this.lastAckedSequence > 0
        ? { lastAckedSequence: this.lastAckedSequence }
        : {}),
      connectedToDaemon: true,
      pendingEventCount: Math.max(0, this.sequence - this.lastAckedSequence),
      pendingCommandCount: this.pendingCommandCount,
    };
  }

  private handleProtocolLine(line: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return false;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    if (isEnvironmentAgentControlRequest(parsed)) {
      this.handleControlRequest(parsed);
      return true;
    }
    const record = parsed as Record<string, unknown>;
    const type = record.type;
    if (type === "ack") {
      const payload = record.payload as EnvironmentAgentAckRequest;
      process.stdout.write(`${JSON.stringify(this.acknowledge(payload))}\n`);
      return true;
    }
    if (type === "replay") {
      const payload = record.payload as EnvironmentAgentReplayRequest;
      process.stdout.write(`${JSON.stringify(this.replay(payload))}\n`);
      return true;
    }
    if (type === "status") {
      process.stdout.write(`${JSON.stringify(this.getStatusSnapshot())}\n`);
      return true;
    }
    return false;
  }

  private handleControlRequest(request: EnvironmentAgentControlRequest): void {
    switch (request.type) {
      case "ack":
        this.writeControlResponse(request.requestId, "ack.response", this.acknowledge(request.payload));
        break;
      case "replay":
        this.writeControlResponse(
          request.requestId,
          "replay.response",
          this.replay(request.payload),
        );
        break;
      case "status":
        this.writeControlResponse(
          request.requestId,
          "status.response",
          this.getStatusSnapshot(),
        );
        break;
      default:
        request satisfies never;
    }
  }

  private writeControlResponse(
    requestId: string,
    type: "ack.response" | "replay.response" | "status.response",
    payload:
      | EnvironmentAgentAckResponse
      | EnvironmentAgentReplayResponse
      | EnvironmentAgentStatusSnapshot,
  ): void {
    process.stdout.write(
      `${JSON.stringify({
        environmentAgentMessage: true,
        requestId,
        type,
        payload,
      })}\n`,
    );
  }

  private resolveThreadId(): string {
    return this.opts.threadId ?? process.env.BB_THREAD_ID ?? "unknown-thread";
  }
}

export function connectionTargetFromRuntimeOptions(
  opts: EnvironmentAgentRuntimeOptions,
): EnvironmentAgentConnectionTarget {
  return {
    transport: "command-stdio",
    command: "bb",
    args: ["environment-agent"],
    env: {
      ...(opts.threadId ? { BB_THREAD_ID: opts.threadId } : {}),
      ...(opts.projectId ? { BB_PROJECT_ID: opts.projectId } : {}),
      ...(opts.environmentId ? { BB_ENVIRONMENT_ID: opts.environmentId } : {}),
    },
  };
}

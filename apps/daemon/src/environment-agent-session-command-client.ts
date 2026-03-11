import { randomUUID } from "node:crypto";
import type {
  EnvironmentAgentClient,
  EnvironmentAgentCommandAck,
  EnvironmentAgentCommandEnvelope,
  EnvironmentAgentProviderSpec,
  EnvironmentAgentProviderStatus,
  EnvironmentAgentStatusSnapshot,
} from "@beanbag/environment-agent";
import { ENVIRONMENT_AGENT_PROTOCOL_VERSION } from "@beanbag/environment-agent";
import type { JsonLineTransport } from "@beanbag/environment-agent";
import type { EnvironmentAgentCommandRecord } from "@beanbag/db";
import {
  EnvironmentAgentCommandDispatcher,
  isEnvironmentAgentSessionUnavailableError,
} from "./environment-agent-command-dispatcher.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

function isEnvironmentAgentProviderStatus(
  value: unknown,
): value is EnvironmentAgentProviderStatus {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { running?: unknown }).running === "boolean" &&
    typeof (value as { launched?: unknown }).launched === "boolean"
  );
}

export interface EnvironmentAgentSessionCommandClientOptions {
  threadId: string;
  commandDispatcher: EnvironmentAgentCommandDispatcher;
  commandTimeoutMs?: number;
  pollIntervalMs?: number;
  recoverSession?: () => Promise<void>;
}

export class EnvironmentAgentSessionCommandClient implements EnvironmentAgentClient {
  readonly providerTransport: JsonLineTransport = {
    setHandlers: () => undefined,
    send: () => {
      throw new Error("Session-backed environment-agent client does not expose provider transport");
    },
    close: () => undefined,
  };

  private readonly commandTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly recoverSession?: () => Promise<void>;
  private closed = false;

  constructor(private readonly options: EnvironmentAgentSessionCommandClientOptions) {
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.recoverSession = options.recoverSession;
  }

  async sendCommand(
    envelope: EnvironmentAgentCommandEnvelope,
  ): Promise<EnvironmentAgentCommandAck> {
    this.ensureOpen();
    const command = await this.enqueueCommand({
      commandId: envelope.meta.commandId,
      commandType: envelope.command.type,
      payload: envelope.command,
      sentAt: envelope.meta.sentAt,
    });

    switch (command.state) {
      case "completed":
        return {
          protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
          commandId: envelope.meta.commandId,
          idempotencyKey: envelope.meta.idempotencyKey,
          state: "accepted",
          acknowledgedAt: command.updatedAt,
          latestSequence: 0,
          ...(command.result !== undefined ? { result: command.result } : {}),
        };
      case "failed":
      case "cancelled":
        return {
          protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
          commandId: envelope.meta.commandId,
          idempotencyKey: envelope.meta.idempotencyKey,
          state: "rejected",
          acknowledgedAt: command.updatedAt,
          latestSequence: 0,
          ...(command.errorCode !== undefined ? { errorCode: command.errorCode } : {}),
          message:
            command.errorMessage ??
            (command.state === "cancelled"
              ? "Environment-agent command was cancelled"
              : "Environment-agent command failed"),
        };
      default:
        throw new Error(
          `Environment-agent command ${envelope.meta.commandId} did not reach terminal state`,
        );
    }
  }

  async ensureProviderRunning(
    spec: EnvironmentAgentProviderSpec,
  ): Promise<EnvironmentAgentProviderStatus> {
    this.ensureOpen();
    const command = await this.enqueueCommand({
      commandId: `provider-ensure-${randomUUID()}`,
      commandType: "provider.ensure",
      payload: spec,
    });

    switch (command.state) {
      case "completed":
        if (!isEnvironmentAgentProviderStatus(command.result)) {
          throw new Error("Environment-agent provider.ensure returned invalid status");
        }
        return command.result;
      case "failed":
      case "cancelled":
        throw new Error(
          command.errorMessage ??
            (command.state === "cancelled"
              ? "Environment-agent provider.ensure was cancelled"
              : "Environment-agent provider.ensure failed"),
        );
      default:
        throw new Error(
          `Environment-agent provider.ensure ${command.id} did not reach terminal state`,
        );
    }
  }

  status(): Promise<EnvironmentAgentStatusSnapshot> {
    throw new Error("Session-backed environment-agent client does not support status");
  }

  close(): void {
    this.closed = true;
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error("Environment-agent session command client is closed");
    }
  }

  private enqueueCommand(args: {
    commandId: string;
    commandType: string;
    payload: unknown;
    sentAt?: number;
  }): Promise<EnvironmentAgentCommandRecord> {
    return this.enqueueCommandWithRecovery(args);
  }

  private async enqueueCommandWithRecovery(args: {
    commandId: string;
    commandType: string;
    payload: unknown;
    sentAt?: number;
  }): Promise<EnvironmentAgentCommandRecord> {
    let recovered = false;
    while (true) {
      try {
        return await this.options.commandDispatcher.enqueueForActiveSession({
          threadId: this.options.threadId,
          commandId: args.commandId,
          commandType: args.commandType,
          payload: args.payload,
          timeoutMs: this.commandTimeoutMs,
          pollIntervalMs: this.pollIntervalMs,
          sentAt: args.sentAt,
        });
      } catch (error) {
        if (
          recovered ||
          !this.recoverSession ||
          !isEnvironmentAgentSessionUnavailableError(error)
        ) {
          throw error;
        }
        recovered = true;
        await this.recoverSession();
      }
    }
  }
}

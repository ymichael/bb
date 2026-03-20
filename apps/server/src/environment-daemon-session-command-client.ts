import { randomUUID } from "node:crypto";
import type {
  EnvironmentDaemonClient,
  EnvironmentDaemonCommandAck,
  EnvironmentDaemonCommandEnvelope,
  EnvironmentDaemonProviderSpec,
  EnvironmentDaemonProviderStatus,
  EnvironmentDaemonStatusSnapshot,
} from "@bb/environment-daemon";
import { ENVIRONMENT_DAEMON_PROTOCOL_VERSION } from "@bb/environment-daemon";
import type { JsonLineTransport } from "@bb/environment-daemon";
import type { EnvironmentDaemonCommandRecord } from "@bb/db";
import {
  EnvironmentDaemonCommandDispatcher,
  isEnvironmentDaemonSessionUnavailableError,
} from "./environment-daemon-command-dispatcher.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

function isEnvironmentDaemonProviderStatus(
  value: unknown,
): value is EnvironmentDaemonProviderStatus {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { running?: unknown }).running === "boolean" &&
    typeof (value as { launched?: unknown }).launched === "boolean"
  );
}

export interface EnvironmentDaemonSessionCommandClientOptions {
  channelId: string;
  commandDispatcher: EnvironmentDaemonCommandDispatcher;
  commandTimeoutMs?: number;
  pollIntervalMs?: number;
  ensureSessionAccess?: () => Promise<void>;
}

export class EnvironmentDaemonSessionCommandClient implements EnvironmentDaemonClient {
  readonly providerTransport: JsonLineTransport = {
    setHandlers: () => undefined,
    send: () => {
      throw new Error("Session-backed environment-daemon client does not expose provider transport");
    },
    close: () => undefined,
  };

  private readonly commandTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly ensureSessionAccess?: () => Promise<void>;
  private closed = false;

  constructor(private readonly options: EnvironmentDaemonSessionCommandClientOptions) {
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.ensureSessionAccess = options.ensureSessionAccess;
  }

  async sendCommand(
    envelope: EnvironmentDaemonCommandEnvelope,
  ): Promise<EnvironmentDaemonCommandAck> {
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
          protocolVersion: ENVIRONMENT_DAEMON_PROTOCOL_VERSION,
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
          protocolVersion: ENVIRONMENT_DAEMON_PROTOCOL_VERSION,
          commandId: envelope.meta.commandId,
          idempotencyKey: envelope.meta.idempotencyKey,
          state: "rejected",
          acknowledgedAt: command.updatedAt,
          latestSequence: 0,
          ...(command.errorCode !== undefined ? { errorCode: command.errorCode } : {}),
          message:
            command.errorMessage ??
            (command.state === "cancelled"
              ? "Environment-daemon command was cancelled"
              : "Environment-daemon command failed"),
        };
      default:
        throw new Error(
          `Environment-daemon command ${envelope.meta.commandId} did not reach terminal state`,
        );
    }
  }

  async ensureProviderRunning(
    spec: EnvironmentDaemonProviderSpec,
    forThreadId?: string,
  ): Promise<EnvironmentDaemonProviderStatus> {
    this.ensureOpen();
    const command = await this.enqueueCommand({
      commandId: `provider-ensure-${randomUUID()}`,
      commandType: "provider.ensure",
      payload: { ...spec, ...(forThreadId ? { forThreadId } : {}) },
    });

    switch (command.state) {
      case "completed":
        if (!isEnvironmentDaemonProviderStatus(command.result)) {
          throw new Error("Environment-daemon provider.ensure returned invalid status");
        }
        return command.result;
      case "failed":
      case "cancelled":
        throw new Error(
          command.errorMessage ??
            (command.state === "cancelled"
              ? "Environment-daemon provider.ensure was cancelled"
              : "Environment-daemon provider.ensure failed"),
        );
      default:
        throw new Error(
          `Environment-daemon provider.ensure ${command.id} did not reach terminal state`,
        );
    }
  }

  status(): Promise<EnvironmentDaemonStatusSnapshot> {
    throw new Error("Session-backed environment-daemon client does not support status");
  }

  close(): void {
    this.closed = true;
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error("Environment-daemon session command client is closed");
    }
  }

  private enqueueCommand(args: {
    commandId: string;
    commandType: string;
    payload: unknown;
    sentAt?: number;
  }): Promise<EnvironmentDaemonCommandRecord> {
    return this.enqueueCommandWithRecovery(args);
  }

  private async enqueueCommandWithRecovery(args: {
    commandId: string;
    commandType: string;
    payload: unknown;
    sentAt?: number;
  }): Promise<EnvironmentDaemonCommandRecord> {
    let recovered = false;
    while (true) {
      try {
        return await this.options.commandDispatcher.enqueueForActiveSession({
          channelId: this.options.channelId,
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
          !this.ensureSessionAccess ||
          !isEnvironmentDaemonSessionUnavailableError(error)
        ) {
          throw error;
        }
        recovered = true;
        await this.ensureSessionAccess();
      }
    }
  }
}

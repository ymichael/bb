import pRetry, { AbortError } from "p-retry";
import {
  HOST_DAEMON_COMMAND_TYPES,
  HOST_DAEMON_PROTOCOL_VERSION,
  hostDaemonCommandEnvelopeSchema,
  hostDaemonCommandResultResponseSchema,
  hostDaemonCommandResultReportSchema,
  hostDaemonCommandsQuerySchema,
  hostDaemonEnvironmentChangeRequestSchema,
  hostDaemonEventBatchRequestSchema,
  hostDaemonEventBatchResponseSchema,
  hostDaemonRuntimeMaterialQuerySchema,
  hostDaemonInteractiveInterruptRequestSchema,
  hostDaemonInteractiveInterruptResponseSchema,
  hostDaemonInteractiveRequestResponseSchema,
  hostDaemonInteractiveRequestSchema,
  hostDaemonSessionOpenRequestSchema,
  hostDaemonSessionOpenResponseSchema,
  hostDaemonToolCallRequestSchema,
  hostDaemonToolCallResponseSchema,
  hostRuntimeMaterialSnapshotSchema,
  type HostDaemonCommandResultResponse,
  type HostDaemonInteractiveInterruptResponse,
  type HostDaemonInteractiveRequestResponse,
  type HostDaemonActiveThread,
  type HostDaemonCommandEnvelope,
  type HostDaemonCommandResultReportWithoutSession,
  type HostDaemonEventEnvelope,
  type HostDaemonEnvironmentChangePayload,
  type HostRuntimeMaterialSnapshot,
  type HostDaemonSessionOpenRequest,
  type HostDaemonSessionOpenResponse,
  type HostDaemonToolCallResponse,
} from "@bb/host-daemon-contract";
import type { PendingInteractionCreate, ToolCallRequest } from "@bb/domain";
import type { HostDaemonLogger } from "./logger.js";
import type { EventPostResult } from "./event-buffer.js";

const knownCommandTypes = new Set<string>(HOST_DAEMON_COMMAND_TYPES);
const DEFAULT_COMMAND_FETCH_LIMIT = 100;
const DEFAULT_COMMAND_FETCH_WAIT_MS = 0;

interface JsonRecord {
  readonly [key: string]: unknown;
}

interface ApiErrorResponseBody {
  code: string;
  message: string;
  retryable?: boolean;
}

interface RawCommandHeader {
  commandId?: string;
  type?: string;
}

interface ServerResponseErrorArgs {
  action: string;
  bodyMessage: string | null;
  code: string | null;
  retryable: boolean;
  status: number;
  statusText: string;
}

interface ReportCommandErrorArgs {
  commandId: string;
  errorCode: string;
  errorMessage: string;
  type: string;
}

export class ServerResponseError extends Error {
  readonly action: string;
  readonly bodyMessage: string | null;
  readonly code: string | null;
  readonly retryable: boolean;
  readonly status: number;
  readonly statusText: string;

  constructor(args: ServerResponseErrorArgs) {
    const detail = args.bodyMessage ? ` - ${args.bodyMessage}` : "";
    super(
      `Failed to ${args.action}: ${args.status} ${args.statusText}${detail}`,
    );
    this.name = "ServerResponseError";
    this.action = args.action;
    this.bodyMessage = args.bodyMessage;
    this.code = args.code;
    this.retryable = args.retryable;
    this.status = args.status;
    this.statusText = args.statusText;
  }
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toJsonRecord(value: unknown): JsonRecord | null {
  return isJsonRecord(value) ? value : null;
}

function parseRawCommandBatch(json: unknown): unknown[] {
  const record = toJsonRecord(json);
  if (record && Array.isArray(record.commands)) {
    return record.commands;
  }
  throw new Error("Invalid command batch structure: missing commands array");
}

function readRawCommandHeader(rawCommand: unknown): RawCommandHeader {
  const record = toJsonRecord(rawCommand);
  if (!record) {
    return {};
  }
  const command = toJsonRecord(record.command);
  return {
    commandId: typeof record.id === "string" ? record.id : undefined,
    type:
      command && typeof command.type === "string" ? command.type : undefined,
  };
}

function parseApiErrorResponseBody(text: string): ApiErrorResponseBody | null {
  if (text.trim() === "") {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const record = toJsonRecord(parsed);
  if (
    !record ||
    typeof record.code !== "string" ||
    typeof record.message !== "string"
  ) {
    return null;
  }

  if (typeof record.retryable === "boolean") {
    return {
      code: record.code,
      message: record.message,
      retryable: record.retryable,
    };
  }

  return {
    code: record.code,
    message: record.message,
  };
}

async function readApiErrorResponseBody(
  response: Response,
): Promise<ApiErrorResponseBody | null> {
  try {
    return parseApiErrorResponseBody(await response.text());
  } catch {
    return null;
  }
}

function defaultRetryableForStatus(status: number): boolean {
  return status < 400 || status >= 500;
}

function toRetryControlError(error: ServerResponseError): Error {
  return error.retryable ? error : new AbortError(error);
}

type FetchFn = typeof fetch;

export interface CommandResultRetryOptions {
  maxTimeoutMs: number;
  minTimeoutMs: number;
  randomize: boolean;
  retries: number;
}

export interface CreateServerClientOptions {
  serverUrl: string;
  hostKey: string;
  logger: HostDaemonLogger;
  getSessionId: () => string;
  /** Runs before each POST attempt so retryable ordering preconditions can be repaired. */
  beforeInteractiveRequestRegistrationAttempt?: () => Promise<void>;
  commandResultRetryOptions?: CommandResultRetryOptions;
  fetchFn?: FetchFn;
}

export interface OpenSessionArgs {
  hostId: string;
  hostName: string;
  hostType: HostDaemonSessionOpenRequest["hostType"];
  dataDir: string;
  instanceId: string;
  activeThreads: HostDaemonActiveThread[] | Promise<HostDaemonActiveThread[]>;
  protocolVersion?: typeof HOST_DAEMON_PROTOCOL_VERSION;
}

export interface ServerClient {
  openSession(args: OpenSessionArgs): Promise<HostDaemonSessionOpenResponse>;
  fetchCommands(options?: {
    limit?: number;
    waitMs?: number;
  }): Promise<HostDaemonCommandEnvelope[]>;
  fetchRuntimeMaterial(args: {
    version: string;
  }): Promise<HostRuntimeMaterialSnapshot>;
  reportCommandResult(
    report: HostDaemonCommandResultReportWithoutSession,
  ): Promise<HostDaemonCommandResultResponse>;
  postEnvironmentChange(
    args: HostDaemonEnvironmentChangePayload,
  ): Promise<void>;
  postEvents(events: HostDaemonEventEnvelope[]): Promise<EventPostResult>;
  callTool(request: ToolCallRequest): Promise<HostDaemonToolCallResponse>;
  registerInteractiveRequest(
    request: PendingInteractionCreate,
  ): Promise<HostDaemonInteractiveRequestResponse>;
  interruptInteractiveRequests(args: {
    providerId: string;
    reason: string;
    threadIds: readonly string[];
  }): Promise<HostDaemonInteractiveInterruptResponse>;
}

const COMMAND_RESULT_RETRIES = 5;
const INTERACTIVE_REQUEST_REGISTRATION_RETRIES = 5;
const DEFAULT_COMMAND_RESULT_RETRY_OPTIONS: CommandResultRetryOptions = {
  maxTimeoutMs: 2_000,
  minTimeoutMs: 100,
  randomize: true,
  retries: COMMAND_RESULT_RETRIES,
};

function usesSecureRuntimeMaterialTransport(serverUrl: string): boolean {
  const parsed = new URL(serverUrl);
  if (parsed.protocol === "https:") {
    return true;
  }

  return (
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "::1"
  );
}

export function createServerClient(
  options: CreateServerClientOptions,
): ServerClient {
  const fetchFn = options.fetchFn ?? fetch;
  const commandResultRetryOptions =
    options.commandResultRetryOptions ?? DEFAULT_COMMAND_RESULT_RETRY_OPTIONS;

  function requireSessionId(): string {
    const sessionId = options.getSessionId();
    if (!sessionId) {
      throw new Error("Server session is not open");
    }
    return sessionId;
  }

  function headers(): HeadersInit {
    return {
      authorization: `Bearer ${options.hostKey}`,
      "content-type": "application/json",
    };
  }

  function buildInternalUrl(
    pathname: string,
    query?: Record<string, string | undefined>,
  ): string {
    const url = new URL(`/internal${pathname}`, options.serverUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          url.searchParams.set(key, value);
        }
      }
    }
    return url.toString();
  }

  async function createResponseError(
    action: string,
    response: Response,
  ): Promise<ServerResponseError> {
    const body = await readApiErrorResponseBody(response);
    return new ServerResponseError({
      action,
      bodyMessage: body?.message ?? null,
      code: body?.code ?? null,
      retryable: body?.retryable ?? defaultRetryableForStatus(response.status),
      status: response.status,
      statusText: response.statusText,
    });
  }

  async function reportCommandError(
    args: ReportCommandErrorArgs,
  ): Promise<void> {
    try {
      const response = await fetchFn(
        buildInternalUrl("/session/command-result"),
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({
            sessionId: requireSessionId(),
            commandId: args.commandId,
            type: args.type,
            completedAt: Date.now(),
            ok: false,
            errorCode: args.errorCode,
            errorMessage: args.errorMessage,
          }),
        },
      );

      if (!response.ok) {
        options.logger.warn(
          { status: response.status, commandId: args.commandId },
          "failed to report command error result",
        );
      }
    } catch (error) {
      options.logger.warn(
        { err: error },
        "error while reporting command error",
      );
    }
  }

  return {
    async openSession(
      args: OpenSessionArgs,
    ): Promise<HostDaemonSessionOpenResponse> {
      const payload = hostDaemonSessionOpenRequestSchema.parse({
        hostId: args.hostId,
        instanceId: args.instanceId,
        hostName: args.hostName,
        hostType: args.hostType,
        dataDir: args.dataDir,
        protocolVersion: args.protocolVersion ?? HOST_DAEMON_PROTOCOL_VERSION,
        activeThreads: await args.activeThreads,
      });
      const response = await fetchFn(buildInternalUrl("/session/open"), {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(payload),
      });

      if (response.status !== 201) {
        const detail = await response.text();
        throw new Error(
          `Failed to open session: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ""}`,
        );
      }

      return hostDaemonSessionOpenResponseSchema.parse(await response.json());
    },

    async fetchCommands(optionsArg = {}): Promise<HostDaemonCommandEnvelope[]> {
      const query = hostDaemonCommandsQuerySchema.parse({
        sessionId: requireSessionId(),
        limit: String(optionsArg.limit ?? DEFAULT_COMMAND_FETCH_LIMIT),
        waitMs: String(optionsArg.waitMs ?? DEFAULT_COMMAND_FETCH_WAIT_MS),
      });
      const response = await fetchFn(
        buildInternalUrl("/session/commands", query),
        {
          method: "GET",
          headers: headers(),
        },
      );

      if (response.status === 204) {
        return [];
      }

      if (!response.ok) {
        throw new Error(
          `Failed to fetch commands: ${response.status} ${response.statusText}`,
        );
      }

      const rawCommands = parseRawCommandBatch(await response.json());
      const accepted: HostDaemonCommandEnvelope[] = [];
      const reportPromises: Promise<void>[] = [];

      for (const rawCommand of rawCommands) {
        const header = readRawCommandHeader(rawCommand);
        const rawType = header.type;

        if (rawType && knownCommandTypes.has(rawType)) {
          const parsed = hostDaemonCommandEnvelopeSchema.safeParse(rawCommand);
          if (parsed.success) {
            accepted.push(parsed.data);
          } else {
            options.logger.warn(
              { type: rawType, error: parsed.error.message },
              "failed to parse command envelope, skipping",
            );
            if (header.commandId) {
              reportPromises.push(
                reportCommandError({
                  commandId: header.commandId,
                  type: rawType,
                  errorCode: "invalid_command",
                  errorMessage: `Invalid command envelope for type ${rawType}`,
                }),
              );
            } else {
              options.logger.warn(
                { rawCommand },
                "cannot report invalid command: missing id",
              );
            }
          }
        } else {
          options.logger.warn(
            { type: rawType ?? "missing" },
            "unknown command type in batch, reporting error to server",
          );
          if (header.commandId) {
            const type = rawType ?? "unknown";
            reportPromises.push(
              reportCommandError({
                commandId: header.commandId,
                type,
                errorCode: "unknown_command",
                errorMessage: `Unrecognized command type: ${type}`,
              }),
            );
          } else {
            options.logger.warn(
              { rawCommand },
              "cannot report unknown command: missing id",
            );
          }
        }
      }

      // Wait for all command error reports to complete before returning
      // so callers don't race ahead of the error reports within the same fetch cycle.
      await Promise.all(reportPromises);

      return accepted;
    },

    async fetchRuntimeMaterial(args): Promise<HostRuntimeMaterialSnapshot> {
      if (!usesSecureRuntimeMaterialTransport(options.serverUrl)) {
        throw new AbortError(
          `Refusing to fetch runtime material over insecure server URL: ${options.serverUrl}`,
        );
      }

      const query = hostDaemonRuntimeMaterialQuerySchema.parse({
        sessionId: requireSessionId(),
        version: args.version,
      });
      const response = await fetchFn(
        buildInternalUrl("/session/runtime-material", query),
        {
          method: "GET",
          headers: headers(),
        },
      );

      if (!response.ok) {
        throw await createResponseError("fetch runtime material", response);
      }

      return hostRuntimeMaterialSnapshotSchema.parse(await response.json());
    },

    async reportCommandResult(
      report: HostDaemonCommandResultReportWithoutSession,
    ): Promise<HostDaemonCommandResultResponse> {
      return pRetry(
        async () => {
          const payload = hostDaemonCommandResultReportSchema.parse({
            ...report,
            sessionId: requireSessionId(),
          });
          const response = await fetchFn(
            buildInternalUrl("/session/command-result"),
            {
              method: "POST",
              headers: headers(),
              body: JSON.stringify(payload),
            },
          );

          if (!response.ok) {
            throw toRetryControlError(
              await createResponseError("report command result", response),
            );
          }

          return hostDaemonCommandResultResponseSchema.parse(
            await response.json(),
          );
        },
        {
          retries: commandResultRetryOptions.retries,
          minTimeout: commandResultRetryOptions.minTimeoutMs,
          maxTimeout: commandResultRetryOptions.maxTimeoutMs,
          randomize: commandResultRetryOptions.randomize,
          onFailedAttempt(context): void {
            options.logger.warn(
              {
                err: context,
                attempt: context.attemptNumber,
                retriesLeft: context.retriesLeft,
              },
              "command result POST failed, retrying",
            );
          },
        },
      );
    },

    async postEnvironmentChange(args): Promise<void> {
      const payload = hostDaemonEnvironmentChangeRequestSchema.parse({
        sessionId: requireSessionId(),
        environmentId: args.environmentId,
        change: args.change,
      });
      const response = await fetchFn(
        buildInternalUrl("/session/environment-change"),
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(payload),
        },
      );

      if (!response.ok) {
        throw await createResponseError("post environment change", response);
      }
    },

    async postEvents(
      events: HostDaemonEventEnvelope[],
    ): Promise<EventPostResult> {
      const payload = hostDaemonEventBatchRequestSchema.parse({
        sessionId: requireSessionId(),
        events,
      });
      const response = await fetchFn(buildInternalUrl("/session/events"), {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw await createResponseError("post events", response);
      }

      const json = await response.json();
      const parsed = hostDaemonEventBatchResponseSchema.parse(json);
      return {
        acceptedEvents: parsed.acceptedEvents,
        kind: "accepted",
        rejectedEvents: parsed.rejectedEvents,
      };
    },

    async callTool(
      request: ToolCallRequest,
    ): Promise<HostDaemonToolCallResponse> {
      const payload = hostDaemonToolCallRequestSchema.parse({
        ...request,
        sessionId: requireSessionId(),
      });
      const response = await fetchFn(buildInternalUrl("/session/tool-call"), {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw await createResponseError("call tool", response);
      }

      return hostDaemonToolCallResponseSchema.parse(await response.json());
    },

    async registerInteractiveRequest(
      request: PendingInteractionCreate,
    ): Promise<HostDaemonInteractiveRequestResponse> {
      return pRetry(
        async () => {
          await options.beforeInteractiveRequestRegistrationAttempt?.();
          const payload = hostDaemonInteractiveRequestSchema.parse({
            sessionId: requireSessionId(),
            interaction: request,
          });
          const response = await fetchFn(
            buildInternalUrl("/session/interactive-request"),
            {
              method: "POST",
              headers: headers(),
              body: JSON.stringify(payload),
            },
          );

          if (!response.ok) {
            throw toRetryControlError(
              await createResponseError(
                "register interactive request",
                response,
              ),
            );
          }

          return hostDaemonInteractiveRequestResponseSchema.parse(
            await response.json(),
          );
        },
        {
          retries: INTERACTIVE_REQUEST_REGISTRATION_RETRIES,
          minTimeout: 100,
          maxTimeout: 2_000,
          randomize: true,
          onFailedAttempt(context): void {
            options.logger.warn(
              {
                err: context,
                attempt: context.attemptNumber,
                retriesLeft: context.retriesLeft,
              },
              "interactive request registration failed, retrying",
            );
          },
        },
      );
    },

    async interruptInteractiveRequests(
      args,
    ): Promise<HostDaemonInteractiveInterruptResponse> {
      const payload = hostDaemonInteractiveInterruptRequestSchema.parse({
        sessionId: requireSessionId(),
        providerId: args.providerId,
        threadIds: args.threadIds,
        reason: args.reason,
      });
      const response = await fetchFn(
        buildInternalUrl("/session/interactive-request/interrupt"),
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(payload),
        },
      );

      if (!response.ok) {
        throw await createResponseError(
          "interrupt interactive requests",
          response,
        );
      }

      return hostDaemonInteractiveInterruptResponseSchema.parse(
        await response.json(),
      );
    },
  };
}

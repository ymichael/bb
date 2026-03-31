import pRetry, { AbortError } from "p-retry";
import {
  HOST_DAEMON_COMMAND_TYPES,
  HOST_DAEMON_PROTOCOL_VERSION,
  hostDaemonCommandEnvelopeSchema,
  hostDaemonCommandResultReportSchema,
  hostDaemonCommandsQuerySchema,
  hostDaemonEnvironmentChangeRequestSchema,
  hostDaemonEventBatchRequestSchema,
  hostDaemonEventBatchResponseSchema,
  hostDaemonSessionOpenRequestSchema,
  hostDaemonSessionOpenResponseSchema,
  hostDaemonToolCallRequestSchema,
  hostDaemonToolCallResponseSchema,
  type HostDaemonActiveThread,
  type HostDaemonCommandEnvelope,
  type HostDaemonCommandResultReport,
  type HostDaemonEventEnvelope,
  type HostDaemonEnvironmentChangeRequest,
  type HostDaemonSessionOpenRequest,
  type HostDaemonSessionOpenResponse,
  type HostDaemonToolCallResponse,
} from "@bb/host-daemon-contract";
import type { ToolCallRequest } from "@bb/domain";
import type { HostDaemonLogger } from "./logger.js";

const knownCommandTypes = new Set<string>(HOST_DAEMON_COMMAND_TYPES);
const DEFAULT_COMMAND_FETCH_LIMIT = 100;
const DEFAULT_COMMAND_FETCH_WAIT_MS = 0;

function parseRawCommandBatch(json: unknown): unknown[] {
  if (
    json != null &&
    typeof json === "object" &&
    "commands" in json &&
    Array.isArray(json.commands)
  ) {
    return json.commands;
  }
  throw new Error("Invalid command batch structure: missing commands array");
}

function extractRawField<T>(obj: unknown, key: string): T | undefined {
  if (obj != null && typeof obj === "object" && key in obj) {
    return (obj as Record<string, unknown>)[key] as T;
  }
  return undefined;
}

function extractRawCommandType(rawCommand: unknown): string | undefined {
  const command = extractRawField<unknown>(rawCommand, "command");
  return extractRawField<string>(command, "type") ?? undefined;
}

type FetchFn = typeof fetch;
type PostEnvironmentChangeArgs = Omit<
  HostDaemonEnvironmentChangeRequest,
  "sessionId"
>;

export interface CreateServerClientOptions {
  serverUrl: string;
  authToken: string;
  logger: HostDaemonLogger;
  getSessionId: () => string;
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
  reportCommandResult(
    report: Omit<HostDaemonCommandResultReport, "sessionId">,
  ): Promise<void>;
  postEnvironmentChange(args: PostEnvironmentChangeArgs): Promise<void>;
  postEvents(events: HostDaemonEventEnvelope[]): Promise<Record<string, number>>;
  callTool(request: ToolCallRequest): Promise<HostDaemonToolCallResponse>;
}

const COMMAND_RESULT_RETRIES = 5;

export function createServerClient(
  options: CreateServerClientOptions,
): ServerClient {
  const fetchFn = options.fetchFn ?? fetch;

  function requireSessionId(): string {
    const sessionId = options.getSessionId();
    if (!sessionId) {
      throw new Error("Server session is not open");
    }
    return sessionId;
  }

  function headers(): HeadersInit {
    return {
      authorization: `Bearer ${options.authToken}`,
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

  function createResponseError(action: string, response: Response): Error {
    const message = `Failed to ${action}: ${response.status} ${response.statusText}`;
    if (response.status >= 400 && response.status < 500) {
      return new AbortError(message);
    }
    return new Error(message);
  }

  async function reportUnknownCommand(rawCommand: unknown): Promise<void> {
    try {
      const commandId = extractRawField<string>(rawCommand, "id");
      const rawType = extractRawCommandType(rawCommand) ?? "unknown";

      if (!commandId) {
        options.logger.warn(
          { rawCommand },
          "cannot report unknown command: missing id",
        );
        return;
      }

      const response = await fetchFn(
        buildInternalUrl("/session/command-result"),
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({
            sessionId: requireSessionId(),
            commandId,
            type: rawType,
            completedAt: Date.now(),
            ok: false,
            errorCode: "unknown_command",
            errorMessage: `Unrecognized command type: ${rawType}`,
          }),
        },
      );

      if (!response.ok) {
        options.logger.warn(
          { status: response.status, commandId },
          "failed to report unknown command result",
        );
      }
    } catch (error) {
      options.logger.warn(
        { err: error },
        "error while reporting unknown command",
      );
    }
  }

  return {
    async openSession(args: OpenSessionArgs): Promise<HostDaemonSessionOpenResponse> {
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
        const rawType = extractRawCommandType(rawCommand);

        if (rawType && knownCommandTypes.has(rawType)) {
          const parsed = hostDaemonCommandEnvelopeSchema.safeParse(rawCommand);
          if (parsed.success) {
            accepted.push(parsed.data);
          } else {
            options.logger.warn(
              { type: rawType, error: parsed.error.message },
              "failed to parse command envelope, skipping",
            );
            reportPromises.push(reportUnknownCommand(rawCommand));
          }
        } else {
          options.logger.warn(
            { type: rawType ?? "missing" },
            "unknown command type in batch, reporting error to server",
          );
          reportPromises.push(reportUnknownCommand(rawCommand));
        }
      }

      // Wait for all unknown command reports to complete before returning
      // so callers don't race ahead of the error reports within the same fetch cycle.
      await Promise.all(reportPromises);

      return accepted;
    },

    async reportCommandResult(
      report: Omit<HostDaemonCommandResultReport, "sessionId">,
    ): Promise<void> {
      await pRetry(
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
            throw createResponseError("report command result", response);
          }
        },
        {
          retries: COMMAND_RESULT_RETRIES,
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
        throw createResponseError("post environment change", response);
      }
    },

    async postEvents(
      events: HostDaemonEventEnvelope[],
    ): Promise<Record<string, number>> {
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
        throw new Error(
          `Failed to post events: ${response.status} ${response.statusText}`,
        );
      }

      const json = await response.json();
      return hostDaemonEventBatchResponseSchema.parse(json).threadHighWaterMarks;
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
        throw new Error(
          `Failed to call tool: ${response.status} ${response.statusText}`,
        );
      }

      return hostDaemonToolCallResponseSchema.parse(await response.json());
    },
  };
}

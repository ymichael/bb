import pRetry, { AbortError } from "p-retry";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  hostDaemonCommandBatchSchema,
  hostDaemonCommandResultReportSchema,
  hostDaemonCommandsQuerySchema,
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
  type HostDaemonSessionOpenRequest,
  type HostDaemonSessionOpenResponse,
  type HostDaemonToolCallResponse,
} from "@bb/host-daemon-contract";
import type { ToolCallRequest } from "@bb/domain";
import type { HostDaemonLogger } from "./logger.js";

type FetchFn = typeof fetch;

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
  instanceId: string;
  activeThreads?: HostDaemonActiveThread[] | Promise<HostDaemonActiveThread[]>;
  protocolVersion?: typeof HOST_DAEMON_PROTOCOL_VERSION;
}

export interface ServerClient {
  openSession(args: OpenSessionArgs): Promise<HostDaemonSessionOpenResponse>;
  fetchCommands(options: {
    afterCursor: number;
    limit?: number;
    waitMs?: number;
  }): Promise<HostDaemonCommandEnvelope[]>;
  reportCommandResult(
    report: Omit<HostDaemonCommandResultReport, "sessionId">,
  ): Promise<void>;
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

  return {
    async openSession(args: OpenSessionArgs): Promise<HostDaemonSessionOpenResponse> {
      const payload = hostDaemonSessionOpenRequestSchema.parse({
        hostId: args.hostId,
        instanceId: args.instanceId,
        hostName: args.hostName,
        hostType: args.hostType,
        protocolVersion: args.protocolVersion ?? HOST_DAEMON_PROTOCOL_VERSION,
        activeThreads: await args.activeThreads,
      });
      const response = await fetchFn(buildInternalUrl("/session/open"), {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(payload),
      });

      if (response.status !== 201) {
        throw new Error(
          `Failed to open session: ${response.status} ${response.statusText}`,
        );
      }

      return hostDaemonSessionOpenResponseSchema.parse(await response.json());
    },

    async fetchCommands(optionsArg): Promise<HostDaemonCommandEnvelope[]> {
      const query = hostDaemonCommandsQuerySchema.parse({
        sessionId: requireSessionId(),
        afterCursor: String(optionsArg.afterCursor),
        limit:
          optionsArg.limit === undefined ? undefined : String(optionsArg.limit),
        waitMs:
          optionsArg.waitMs === undefined ? undefined : String(optionsArg.waitMs),
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

      const parsed = hostDaemonCommandBatchSchema.parse(await response.json());
      return parsed.commands;
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

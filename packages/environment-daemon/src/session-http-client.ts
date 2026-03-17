import { randomUUID } from "node:crypto";
import type { EnvironmentAgentDaemonConnectionConfig } from "./protocol.js";
import type {
  EnvironmentAgentSessionClientMessage,
  EnvironmentAgentSessionCommandAckPayload,
  EnvironmentAgentSessionCommandBatchMessage,
  EnvironmentAgentSessionCommandResultPayload,
  EnvironmentAgentSessionEventAckMessage,
  EnvironmentAgentSessionEventBatchPayload,
  EnvironmentAgentSessionHeartbeatPayload,
  EnvironmentAgentSessionOpenPayload,
  EnvironmentAgentSessionProviderRequestPayload,
  EnvironmentAgentSessionProviderResponseMessage,
  EnvironmentAgentSessionWelcomeMessage,
} from "./session-protocol.js";
import { ENVIRONMENT_AGENT_SESSION_PROTOCOL } from "./session-protocol.js";

type EnvironmentAgentSessionBoundClientMessage = Exclude<
  EnvironmentAgentSessionClientMessage,
  { type: "session_open" }
>;

export interface EnvironmentAgentSessionHttpClientOptions {
  daemonUrl: string;
  threadId: string;
  authToken?: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export class EnvironmentAgentSessionHttpClientError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(args: {
    message: string;
    status?: number;
    code?: string;
    retryable?: boolean;
    details?: unknown;
  }) {
    super(args.message);
    this.name = "EnvironmentAgentSessionHttpClientError";
    this.status = args.status;
    this.code = args.code;
    this.retryable = args.retryable ?? false;
    this.details = args.details;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new EnvironmentAgentSessionHttpClientError({
      message: `Invalid JSON response: ${response.status}`,
      status: response.status,
    });
  }
}

export class EnvironmentAgentSessionHttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly daemonUrl: string;
  private readonly threadId: string;
  private readonly defaultHeaders: Record<string, string>;

  constructor(options: EnvironmentAgentSessionHttpClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.daemonUrl = options.daemonUrl;
    this.threadId = options.threadId;
    this.defaultHeaders = {
      ...(options.authToken
        ? { authorization: `Bearer ${options.authToken}` }
        : {}),
      ...(options.headers ?? {}),
    };
  }

  openSession(
    payload: EnvironmentAgentSessionOpenPayload,
  ): Promise<EnvironmentAgentSessionWelcomeMessage> {
    return this.postJson(
      `/threads/${this.threadId}/env-daemon/session/open`,
      payload,
      201,
    ) as Promise<EnvironmentAgentSessionWelcomeMessage>;
  }

  async heartbeat(
    sessionId: string,
    payload: EnvironmentAgentSessionHeartbeatPayload,
  ): Promise<void> {
    await this.postClientMessage({
      type: "heartbeat",
      sessionId,
      payload,
    });
  }

  pushEvents(args: {
    sessionId: string;
    payload: EnvironmentAgentSessionEventBatchPayload;
  }): Promise<EnvironmentAgentSessionEventAckMessage> {
    return this.postClientMessage({
      type: "event_batch",
      sessionId: args.sessionId,
      payload: args.payload,
      responseStatus: 200,
    }) as Promise<EnvironmentAgentSessionEventAckMessage>;
  }

  pullCommands(args: {
    sessionId: string;
    afterCursor?: number;
    limit?: number;
    waitMs?: number;
    signal?: AbortSignal;
  }): Promise<EnvironmentAgentSessionCommandBatchMessage> {
    const search = new URLSearchParams({ sessionId: args.sessionId });
    if (args.afterCursor !== undefined) {
      search.set("afterCursor", String(args.afterCursor));
    }
    if (args.limit !== undefined) {
      search.set("limit", String(args.limit));
    }
    if (Number.isFinite(args.waitMs) && (args.waitMs ?? 0) >= 0) {
      search.set("waitMs", String(Math.floor(args.waitMs ?? 0)));
    }
    return this.getJson(
      `/threads/${this.threadId}/env-daemon/session/commands?${search.toString()}`,
      200,
      { signal: args.signal },
    ) as Promise<EnvironmentAgentSessionCommandBatchMessage>;
  }

  async acknowledgeCommands(
    sessionId: string,
    payload: EnvironmentAgentSessionCommandAckPayload,
  ): Promise<void> {
    await this.postClientMessage({
      type: "command_ack",
      sessionId,
      payload,
    });
  }

  async sendCommandResult(
    sessionId: string,
    payload: EnvironmentAgentSessionCommandResultPayload,
  ): Promise<void> {
    await this.postClientMessage({
      type: "command_result",
      sessionId,
      payload,
    });
  }

  sendProviderRequest(args: {
    sessionId: string;
    payload: EnvironmentAgentSessionProviderRequestPayload;
  }): Promise<EnvironmentAgentSessionProviderResponseMessage> {
    return this.postClientMessage({
      type: "provider_request",
      sessionId: args.sessionId,
      payload: args.payload,
      responseStatus: 200,
    }) as Promise<EnvironmentAgentSessionProviderResponseMessage>;
  }

  async closeSession(
    sessionId: string,
    reason: "agent_shutdown" | "daemon_shutdown" | "migration" | "internal_error",
  ): Promise<void> {
    await this.postClientMessage({
      type: "session_close",
      sessionId,
      payload: { reason },
    });
  }

  private async postClientMessage<
    TType extends EnvironmentAgentSessionBoundClientMessage["type"],
  >(args: {
    type: TType;
    sessionId: string;
    payload: Extract<EnvironmentAgentSessionBoundClientMessage, { type: TType }>["payload"];
    responseStatus?: 200 | 204;
  }): Promise<unknown> {
    const message = {
      protocol: ENVIRONMENT_AGENT_SESSION_PROTOCOL,
      messageId: randomUUID(),
      sentAt: Date.now(),
      sessionId: args.sessionId,
      type: args.type,
      payload: args.payload,
    } as Extract<EnvironmentAgentSessionBoundClientMessage, { type: TType }>;
    if (args.responseStatus === 200) {
      return this.postJson(
        `/threads/${this.threadId}/env-daemon/session/messages`,
        message,
        200,
      );
    }
    return this.postNoContent(`/threads/${this.threadId}/env-daemon/session/messages`, message);
  }

  private async getJson(
    path: string,
    expectedStatus: number,
    options?: { signal?: AbortSignal },
  ): Promise<unknown> {
    try {
      const response = await this.fetchImpl(joinUrl(this.daemonUrl, path), {
        method: "GET",
        headers: this.defaultHeaders,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      return await this.requireJson(response, expectedStatus);
    } catch (error) {
      if (
        options?.signal?.aborted &&
        error instanceof EnvironmentAgentSessionHttpClientError
      ) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      throw error;
    }
  }

  private async postJson(
    path: string,
    body: unknown,
    expectedStatus: number,
  ): Promise<unknown> {
    const response = await this.fetchImpl(joinUrl(this.daemonUrl, path), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.defaultHeaders,
      },
      body: JSON.stringify(body),
    });
    return this.requireJson(response, expectedStatus);
  }

  private async postNoContent(path: string, body: unknown): Promise<void> {
    const response = await this.fetchImpl(joinUrl(this.daemonUrl, path), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.defaultHeaders,
      },
      body: JSON.stringify(body),
    });
    if (response.status !== 204) {
      throw await this.buildHttpError(response, 204);
    }
  }

  private async requireJson(response: Response, expectedStatus: number): Promise<unknown> {
    if (response.status !== expectedStatus) {
      throw await this.buildHttpError(response, expectedStatus);
    }
    return parseJsonResponse(response);
  }

  private async buildHttpError(
    response: Response,
    expectedStatus: number,
  ): Promise<EnvironmentAgentSessionHttpClientError> {
    const body = await response.text();
    let parsedBody: unknown;
    if (body.trim()) {
      try {
        parsedBody = JSON.parse(body);
      } catch {
        parsedBody = undefined;
      }
    }
    const parsedRecord = asRecord(parsedBody);
    const code =
      typeof parsedRecord?.code === "string" ? parsedRecord.code : undefined;
    const message =
      typeof parsedRecord?.message === "string"
        ? parsedRecord.message
        : body.trim() || undefined;
    const retryable = parsedRecord?.retryable === true;
    const details = parsedRecord?.details;
    const suffix = message ? `: ${message}` : "";
    return new EnvironmentAgentSessionHttpClientError({
      message: `Unexpected daemon response ${response.status} (expected ${expectedStatus})${suffix}`,
      status: response.status,
      ...(code ? { code } : {}),
      ...(retryable ? { retryable: true } : {}),
      ...(details !== undefined ? { details } : {}),
    });
  }
}

export function isEnvironmentAgentSessionInactiveError(
  error: unknown,
): error is EnvironmentAgentSessionHttpClientError {
  return (
    error instanceof EnvironmentAgentSessionHttpClientError &&
    error.status === 409 &&
    error.code === "inactive_session"
  );
}

export function createEnvironmentAgentSessionHttpClientFromConnection(
  config: EnvironmentAgentDaemonConnectionConfig,
  args?: {
    headers?: Record<string, string>;
    fetchImpl?: typeof fetch;
  },
): EnvironmentAgentSessionHttpClient {
  if (!config.daemonUrl || !config.threadId) {
    throw new EnvironmentAgentSessionHttpClientError({
      message: "Environment-agent daemon session connection requires daemonUrl and threadId",
    });
  }
  return new EnvironmentAgentSessionHttpClient({
    daemonUrl: config.daemonUrl,
    threadId: config.threadId,
    authToken: config.authToken,
    ...(args?.headers ? { headers: args.headers } : {}),
    ...(args?.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  });
}

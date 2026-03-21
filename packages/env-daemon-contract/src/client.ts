import { randomUUID } from "node:crypto";
import {
  ENVIRONMENT_DAEMON_SESSION_PROTOCOL,
  type EnvironmentDaemonSessionClientMessage,
  type EnvironmentDaemonSessionCommandAckPayload,
  type EnvironmentDaemonSessionCommandBatchMessage,
  type EnvironmentDaemonSessionCommandResultPayload,
  type EnvironmentDaemonSessionEventAckMessage,
  type EnvironmentDaemonSessionEventBatchPayload,
  type EnvironmentDaemonSessionHeartbeatPayload,
  type EnvironmentDaemonSessionOpenPayload,
  type EnvironmentDaemonSessionProviderRequestPayload,
  type EnvironmentDaemonSessionProviderResponseMessage,
  type EnvironmentDaemonSessionWelcomeMessage,
} from "./session-protocol.js";

type EnvironmentDaemonSessionBoundClientMessage = Exclude<
  EnvironmentDaemonSessionClientMessage,
  { type: "session_open" }
>;

export interface EnvironmentDaemonSessionClientConfig {
  serverUrl: string;
  environmentId: string;
  authToken?: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export class EnvironmentDaemonSessionClientError extends Error {
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
    this.name = "EnvironmentDaemonSessionClientError";
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
    throw new EnvironmentDaemonSessionClientError({
      message: `Invalid JSON response: ${response.status}`,
      status: response.status,
    });
  }
}

export class EnvironmentDaemonSessionClient {
  private readonly fetchImpl: typeof fetch;
  private readonly serverUrl: string;
  private readonly environmentId: string;
  private readonly defaultHeaders: Record<string, string>;

  constructor(config: EnvironmentDaemonSessionClientConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.serverUrl = config.serverUrl;
    this.environmentId = config.environmentId;
    this.defaultHeaders = {
      ...(config.authToken
        ? { authorization: `Bearer ${config.authToken}` }
        : {}),
      ...(config.headers ?? {}),
    };
  }

  openSession(
    payload: EnvironmentDaemonSessionOpenPayload,
  ): Promise<EnvironmentDaemonSessionWelcomeMessage> {
    return this.postJson(
      `/environments/${this.environmentId}/env-daemon/session/open`,
      payload,
      201,
    ) as Promise<EnvironmentDaemonSessionWelcomeMessage>;
  }

  async heartbeat(
    sessionId: string,
    payload: EnvironmentDaemonSessionHeartbeatPayload,
  ): Promise<void> {
    await this.postClientMessage({
      type: "heartbeat",
      sessionId,
      payload,
    });
  }

  pushEvents(args: {
    sessionId: string;
    payload: EnvironmentDaemonSessionEventBatchPayload;
  }): Promise<EnvironmentDaemonSessionEventAckMessage> {
    return this.postClientMessage({
      type: "event_batch",
      sessionId: args.sessionId,
      payload: args.payload,
      responseStatus: 200,
    }) as Promise<EnvironmentDaemonSessionEventAckMessage>;
  }

  pullCommands<TCommand = Record<string, unknown>>(args: {
    sessionId: string;
    afterCursor?: number;
    limit?: number;
    waitMs?: number;
    signal?: AbortSignal;
  }): Promise<EnvironmentDaemonSessionCommandBatchMessage<TCommand>> {
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
      `/environments/${this.environmentId}/env-daemon/session/commands?${search.toString()}`,
      200,
      { signal: args.signal },
    ) as Promise<EnvironmentDaemonSessionCommandBatchMessage<TCommand>>;
  }

  async acknowledgeCommands(
    sessionId: string,
    payload: EnvironmentDaemonSessionCommandAckPayload,
  ): Promise<void> {
    await this.postClientMessage({
      type: "command_ack",
      sessionId,
      payload,
    });
  }

  async sendCommandResult(
    sessionId: string,
    payload: EnvironmentDaemonSessionCommandResultPayload,
  ): Promise<void> {
    await this.postClientMessage({
      type: "command_result",
      sessionId,
      payload,
    });
  }

  sendProviderRequest(args: {
    sessionId: string;
    payload: EnvironmentDaemonSessionProviderRequestPayload;
  }): Promise<EnvironmentDaemonSessionProviderResponseMessage> {
    return this.postClientMessage({
      type: "provider_request",
      sessionId: args.sessionId,
      payload: args.payload,
      responseStatus: 200,
    }) as Promise<EnvironmentDaemonSessionProviderResponseMessage>;
  }

  async closeSession(
    sessionId: string,
    reason: "agent_shutdown" | "server_shutdown" | "migration" | "internal_error",
  ): Promise<void> {
    await this.postClientMessage({
      type: "session_close",
      sessionId,
      payload: { reason },
    });
  }

  private async postClientMessage<
    TType extends EnvironmentDaemonSessionBoundClientMessage["type"],
  >(args: {
    type: TType;
    sessionId: string;
    payload: Extract<EnvironmentDaemonSessionBoundClientMessage, { type: TType }>["payload"];
    responseStatus?: 200 | 204;
  }): Promise<unknown> {
    const message = {
      protocol: ENVIRONMENT_DAEMON_SESSION_PROTOCOL,
      messageId: randomUUID(),
      sentAt: Date.now(),
      sessionId: args.sessionId,
      type: args.type,
      payload: args.payload,
    } as Extract<EnvironmentDaemonSessionBoundClientMessage, { type: TType }>;
    if (args.responseStatus === 200) {
      return this.postJson(
        `/environments/${this.environmentId}/env-daemon/session/messages`,
        message,
        200,
      );
    }
    return this.postNoContent(`/environments/${this.environmentId}/env-daemon/session/messages`, message);
  }

  private async getJson(
    path: string,
    expectedStatus: number,
    options?: { signal?: AbortSignal },
  ): Promise<unknown> {
    try {
      const response = await this.fetchImpl(joinUrl(this.serverUrl, path), {
        method: "GET",
        headers: this.defaultHeaders,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      return await this.requireJson(response, expectedStatus);
    } catch (error) {
      if (
        options?.signal?.aborted &&
        error instanceof EnvironmentDaemonSessionClientError
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
    const response = await this.fetchImpl(joinUrl(this.serverUrl, path), {
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
    const response = await this.fetchImpl(joinUrl(this.serverUrl, path), {
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
  ): Promise<EnvironmentDaemonSessionClientError> {
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
    return new EnvironmentDaemonSessionClientError({
      message: `Unexpected daemon response ${response.status} (expected ${expectedStatus})${suffix}`,
      status: response.status,
      ...(code ? { code } : {}),
      ...(retryable ? { retryable: true } : {}),
      ...(details !== undefined ? { details } : {}),
    });
  }
}

export function isEnvironmentDaemonSessionInactiveError(
  error: unknown,
): error is EnvironmentDaemonSessionClientError {
  return (
    error instanceof EnvironmentDaemonSessionClientError &&
    error.status === 409 &&
    error.code === "inactive_session"
  );
}

export interface EnvironmentDaemonSessionConnectionConfig {
  serverUrl?: string;
  environmentId?: string;
  authToken?: string;
}

export function createEnvironmentDaemonSessionClient(
  config: EnvironmentDaemonSessionConnectionConfig,
  args?: {
    headers?: Record<string, string>;
    fetchImpl?: typeof fetch;
  },
): EnvironmentDaemonSessionClient {
  if (!config.serverUrl || !config.environmentId) {
    throw new EnvironmentDaemonSessionClientError({
      message: "Environment-daemon session connection requires serverUrl and environmentId",
    });
  }
  return new EnvironmentDaemonSessionClient({
    serverUrl: config.serverUrl,
    environmentId: config.environmentId,
    authToken: config.authToken,
    ...(args?.headers ? { headers: args.headers } : {}),
    ...(args?.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  });
}

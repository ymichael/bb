import type { JsonLineTransport } from "@bb/environment-daemon";

type JsonRpcId = string | number;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
  };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class ProviderRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRuntimeError";
  }
}

export class ProviderRuntimeUnavailableError extends ProviderRuntimeError {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRuntimeUnavailableError";
  }
}

export class ProviderRuntimeTimeoutError extends ProviderRuntimeError {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRuntimeTimeoutError";
  }
}

export class ProviderRuntimeRpcError extends ProviderRuntimeError {
  constructor(
    readonly requestId: JsonRpcId,
    message: string,
  ) {
    super(message);
    this.name = "ProviderRuntimeRpcError";
  }
}

export interface ProviderRuntimeNotification {
  method: string;
  params: unknown;
}

export interface ProviderRuntimeServerRequest {
  id: JsonRpcId;
  method: string;
  params: unknown;
}

export interface ProviderRuntimeOptions {
  threadId: string;
  transport: JsonLineTransport;
  onNotification: (msg: ProviderRuntimeNotification) => void;
  onServerRequest?: (
    request: ProviderRuntimeServerRequest,
  ) => Promise<unknown> | unknown;
  onUnmatchedRpcError?: (id: JsonRpcId, message: string) => void;
  onStderrLine?: (line: string) => void;
  onClosed?: (reason?: Error) => void;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asJsonRpcId(value: unknown): JsonRpcId | undefined {
  if (typeof value === "string" || typeof value === "number") return value;
  return undefined;
}

type DecodedProviderRuntimeMessage =
  | {
      kind: "response";
      id: JsonRpcId;
      result: unknown;
      error?: undefined;
    }
  | {
      kind: "response";
      id: JsonRpcId;
      result?: undefined;
      error: unknown;
    }
  | {
      kind: "notification";
      method: string;
      params: unknown;
    }
  | {
      kind: "request";
      id: JsonRpcId;
      method: string;
      params: unknown;
    };

function decodeProviderRuntimeMessage(
  value: unknown,
): DecodedProviderRuntimeMessage | null {
  const record = asRecord(value);
  if (!record) return null;

  const id = asJsonRpcId(record.id);
  const method = typeof record.method === "string" ? record.method : undefined;

  if (id !== undefined && ("result" in record || "error" in record)) {
    if ("error" in record && record.error !== undefined) {
      return {
        kind: "response",
        id,
        error: record.error,
      };
    }

    return {
      kind: "response",
      id,
      result: record.result,
    };
  }

  if (method) {
    if (id !== undefined) {
      return {
        kind: "request",
        id,
        method,
        params: record.params,
      };
    }

    return {
      kind: "notification",
      method,
      params: record.params,
    };
  }

  return null;
}

function getErrorMessage(value: unknown): string {
  if (typeof value === "string" && value.length > 0) return value;
  const record = asRecord(value);
  if (!record) return JSON.stringify(value);
  const msg = record.message;
  if (typeof msg === "string" && msg.length > 0) return msg;
  return JSON.stringify(value);
}

export class ProviderRuntime {
  private pending = new Map<JsonRpcId, PendingRequest>();
  private closed = false;

  constructor(private opts: ProviderRuntimeOptions) {
    this._setupTransport();
  }

  send(msg: object): void {
    if (this.closed) {
      throw new ProviderRuntimeUnavailableError(
        `[thread ${this.opts.threadId}] Provider runtime is closed`,
      );
    }

    try {
      this.opts.transport.send(JSON.stringify(msg));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ProviderRuntimeUnavailableError(
        `[thread ${this.opts.threadId}] Failed to write provider message: ${message}`,
      );
    }
  }

  request(
    msg: JsonRpcRequest,
    timeoutMs: number = 10_000,
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(
        new ProviderRuntimeUnavailableError(
          `[thread ${this.opts.threadId}] Provider runtime is closed`,
        ),
      );
    }

    if (this.pending.has(msg.id)) {
      return Promise.reject(
        new ProviderRuntimeError(
          `[thread ${this.opts.threadId}] Duplicate pending request id ${msg.id}`,
        ),
      );
    }

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(msg.id);
        reject(
          new ProviderRuntimeTimeoutError(
            `[thread ${this.opts.threadId}] Timed out waiting for response to request ${msg.id}. ` +
              "This usually means provider did not understand the previous RPC call.",
          ),
        );
      }, timeoutMs);

      this.pending.set(msg.id, { resolve, reject, timeout });

      try {
        this.opts.transport.send(JSON.stringify(msg));
      } catch (error) {
        const request = this.pending.get(msg.id);
        if (!request) return;
        clearTimeout(request.timeout);
        this.pending.delete(msg.id);
        const message = error instanceof Error ? error.message : String(error);
        reject(
          new ProviderRuntimeUnavailableError(
            `[thread ${this.opts.threadId}] Failed to write RPC request ${msg.id}: ${message}`,
          ),
        );
      }
    });
  }

  close(reason?: Error): void {
    if (this.closed) return;
    this.closed = true;

    const closeError =
      reason ??
      new Error(`[thread ${this.opts.threadId}] Provider runtime closed`);

    this.opts.transport.close(closeError);

    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(closeError);
      this.pending.delete(id);
    }
    this.opts.onClosed?.(closeError);
  }

  private _handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }

    const msg = decodeProviderRuntimeMessage(parsed);
    if (!msg) return;

    if (msg.kind === "response") {
      const pending = this.pending.get(msg.id);
      if (!pending) {
        if (msg.error !== undefined) {
          this.opts.onUnmatchedRpcError?.(msg.id, getErrorMessage(msg.error));
        }
        return;
      }

      clearTimeout(pending.timeout);
      this.pending.delete(msg.id);

      if (msg.error !== undefined) {
        pending.reject(
          new ProviderRuntimeRpcError(
            msg.id,
            `[thread ${this.opts.threadId}] Provider RPC error for request ${msg.id}: ` +
              getErrorMessage(msg.error),
          ),
        );
        return;
      }

      pending.resolve(msg.result);
      return;
    }

    if (msg.kind === "request") {
      void this._handleServerRequest(msg);
      return;
    }

    this.opts.onNotification({
      method: msg.method,
      params: msg.params,
    });
  }

  private async _handleServerRequest(
    request: ProviderRuntimeServerRequest,
  ): Promise<void> {
    const response = await this._resolveServerRequest(request);
    try {
      this.opts.transport.send(JSON.stringify(response));
    } catch {
      // Best-effort only; the close/error path will surface transport failure.
    }
  }

  private async _resolveServerRequest(
    request: ProviderRuntimeServerRequest,
  ): Promise<JsonRpcSuccessResponse | JsonRpcErrorResponse> {
    if (!this.opts.onServerRequest) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32601,
          message: `Unhandled provider request method ${request.method}`,
        },
      };
    }

    try {
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: await this.opts.onServerRequest(request),
      };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private _setupTransport(): void {
    this.opts.transport.setHandlers({
      onLine: (line: string) => {
        this._handleLine(line);
      },
      onStderrLine: (line: string) => {
        this.opts.onStderrLine?.(line);
      },
      onClose: (reason?: Error) => {
        this.close(reason);
      },
    });
  }
}

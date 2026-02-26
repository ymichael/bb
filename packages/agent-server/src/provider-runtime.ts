import type { ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

type JsonRpcId = string | number;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
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
  method: unknown;
  params: unknown;
}

export interface ProviderRuntimeOptions {
  threadId: string;
  child: ChildProcess;
  onNotification: (msg: ProviderRuntimeNotification) => void;
  onUnmatchedRpcError?: (id: JsonRpcId, message: string) => void;
  onStderrLine?: (line: string) => void;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asJsonRpcId(value: unknown): JsonRpcId | undefined {
  if (typeof value === "string" || typeof value === "number") return value;
  return undefined;
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
  private stdoutRl: Interface | undefined;
  private stderrRl: Interface | undefined;
  private closed = false;

  constructor(private opts: ProviderRuntimeOptions) {
    this._setupStdout();
    this._setupStderr();
  }

  send(msg: object): void {
    if (this.closed) {
      throw new ProviderRuntimeUnavailableError(
        `[thread ${this.opts.threadId}] Provider runtime is closed`,
      );
    }

    if (!this.opts.child.stdin) {
      throw new ProviderRuntimeUnavailableError(
        `[thread ${this.opts.threadId}] No stdin on child process`,
      );
    }

    this.opts.child.stdin.write(`${JSON.stringify(msg)}\n`);
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

    if (!this.opts.child.stdin) {
      return Promise.reject(
        new ProviderRuntimeUnavailableError(
          `[thread ${this.opts.threadId}] No stdin on child process`,
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

      this.opts.child.stdin!.write(`${JSON.stringify(msg)}\n`, (err) => {
        if (!err) return;

        const request = this.pending.get(msg.id);
        if (!request) return;
        clearTimeout(request.timeout);
        this.pending.delete(msg.id);
        reject(
          new ProviderRuntimeUnavailableError(
            `[thread ${this.opts.threadId}] Failed to write RPC request ${msg.id}: ${err.message}`,
          ),
        );
      });
    });
  }

  close(reason?: Error): void {
    if (this.closed) return;
    this.closed = true;

    const closeError =
      reason ??
      new Error(`[thread ${this.opts.threadId}] Provider runtime closed`);

    if (this.stdoutRl) {
      this.stdoutRl.close();
      this.stdoutRl = undefined;
    }

    if (this.stderrRl) {
      this.stderrRl.close();
      this.stderrRl = undefined;
    }

    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(closeError);
      this.pending.delete(id);
    }
  }

  private _setupStdout(): void {
    if (!this.opts.child.stdout) return;

    this.stdoutRl = createInterface({ input: this.opts.child.stdout });
    this.stdoutRl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return;
      }

      const msg = asRecord(parsed);
      if (!msg) return;

      const id = asJsonRpcId(msg.id);
      if (id !== undefined && ("result" in msg || "error" in msg)) {
        const pending = this.pending.get(id);
        if (!pending) {
          if (msg.error) {
            this.opts.onUnmatchedRpcError?.(id, getErrorMessage(msg.error));
          }
          return;
        }

        clearTimeout(pending.timeout);
        this.pending.delete(id);

        if (msg.error) {
          pending.reject(
            new ProviderRuntimeRpcError(
              id,
              `[thread ${this.opts.threadId}] Provider RPC error for request ${id}: ` +
                getErrorMessage(msg.error),
            ),
          );
          return;
        }

        pending.resolve(msg.result);
        return;
      }

      if ("method" in msg) {
        this.opts.onNotification({
          method: msg.method,
          params: msg.params,
        });
      }
    });
  }

  private _setupStderr(): void {
    if (!this.opts.child.stderr) return;

    this.stderrRl = createInterface({ input: this.opts.child.stderr });
    this.stderrRl.on("line", (line) => {
      this.opts.onStderrLine?.(line);
    });
  }
}

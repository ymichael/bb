import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { experimental_recordProviderChildIo } from "@get-bb/plugin-sdk/provider-bridge";
import type { z } from "zod";

const STDERR_TAIL_MAX_CHUNKS = 40;
const CLOSE_AFTER_EXIT_GRACE_MS = 1_000;
const KILL_ESCALATION_MS = 4_000;

export interface CodexAppServerRequestResponder {
  result(value: unknown): void;
  error(code: number, message: string): void;
}

export interface CodexAppServerExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
  spawnFailed: boolean;
}

interface CreateCodexAppServerConnectionOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  recordThreadId: string | null;
  onNotification(method: string, params: unknown): void;
  onRequest(
    method: string,
    params: unknown,
    responder: CodexAppServerRequestResponder,
  ): void;
  onExit(info: CodexAppServerExitInfo): void;
}

interface CodexAppServerRequestArgs<TResult> {
  method: string;
  params?: unknown;
  resultSchema: z.ZodType<TResult>;
  timeoutMs?: number;
}

export interface CodexAppServerConnection {
  request<TResult>(args: CodexAppServerRequestArgs<TResult>): Promise<TResult>;
  notify(method: string, params?: unknown): void;
  kill(): Promise<void>;
  readonly exited: boolean;
}

export class CodexAppServerExitedError extends Error {
  readonly spawnFailed: boolean;

  constructor(message: string, options?: { spawnFailed?: boolean }) {
    super(message);
    this.name = "CodexAppServerExitedError";
    this.spawnFailed = options?.spawnFailed ?? false;
  }
}

interface PendingChildRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout | null;
}

interface ParsedChildMessage {
  id?: string | number;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string };
  params?: unknown;
}

function parseChildLine(line: string): ParsedChildMessage | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as ParsedChildMessage;
}

export function createCodexAppServerConnection(
  options: CreateCodexAppServerConnectionOptions,
): CodexAppServerConnection {
  const child: ChildProcess = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  experimental_recordProviderChildIo(child, {
    threadId: options.recordThreadId,
  });

  const pending = new Map<number, PendingChildRequest>();
  const stderrChunks: string[] = [];
  let nextRequestId = 1;
  let finalized = false;
  let spawnFailed = false;
  let exitStatus: {
    code: number | null;
    signal: NodeJS.Signals | null;
  } | null = null;
  let closeGraceTimer: NodeJS.Timeout | null = null;
  let stdoutLines: Interface | null = null;
  let resolveExit!: () => void;
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  function writeLine(message: object): void {
    const stdin = child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      return;
    }
    stdin.write(JSON.stringify(message) + "\n");
  }

  function rejectAllPending(error: Error): void {
    for (const [, request] of pending) {
      if (request.timeout !== null) {
        clearTimeout(request.timeout);
      }
      request.reject(error);
    }
    pending.clear();
  }

  function finalizeExit(status: {
    code: number | null;
    signal: NodeJS.Signals | null;
  }): void {
    if (finalized) {
      return;
    }
    finalized = true;
    if (closeGraceTimer !== null) {
      clearTimeout(closeGraceTimer);
      closeGraceTimer = null;
    }
    stdoutLines?.close();
    child.stdout?.destroy();
    child.stderr?.destroy();
    const stderrTail = stderrChunks.join("\n");
    rejectAllPending(
      new CodexAppServerExitedError(
        `codex app-server exited (code ${status.code ?? "null"}, signal ${status.signal ?? "null"})${
          stderrTail ? `: ${stderrTail}` : ""
        }`,
        { spawnFailed },
      ),
    );
    try {
      options.onExit({ ...status, stderrTail, spawnFailed });
    } finally {
      resolveExit();
    }
  }

  if (child.stdout) {
    stdoutLines = createInterface({ input: child.stdout, terminal: false });
    stdoutLines.on("line", (line) => {
      if (finalized) {
        return;
      }
      const message = parseChildLine(line);
      if (!message) {
        return;
      }

      const id = message.id;
      if (
        (typeof id === "string" || typeof id === "number") &&
        message.method === undefined
      ) {
        const numericId = typeof id === "number" ? id : Number(id);
        const request = pending.get(numericId);
        if (!request) {
          return;
        }
        pending.delete(numericId);
        if (request.timeout !== null) {
          clearTimeout(request.timeout);
        }
        if (message.error) {
          request.reject(
            new Error(
              message.error.message ??
                `codex app-server returned error code ${message.error.code ?? "unknown"}`,
            ),
          );
        } else {
          request.resolve(message.result);
        }
        return;
      }

      if (typeof message.method !== "string") {
        return;
      }

      if (typeof id === "string" || typeof id === "number") {
        let settled = false;
        options.onRequest(message.method, message.params, {
          result(value) {
            if (settled || finalized) return;
            settled = true;
            writeLine({ jsonrpc: "2.0", id, result: value ?? null });
          },
          error(code, errorMessage) {
            if (settled || finalized) return;
            settled = true;
            writeLine({
              jsonrpc: "2.0",
              id,
              error: { code, message: errorMessage },
            });
          },
        });
        return;
      }

      options.onNotification(message.method, message.params);
    });
  }

  if (child.stderr) {
    const stderrLines = createInterface({
      input: child.stderr,
      terminal: false,
    });
    stderrLines.on("line", (line) => {
      stderrChunks.push(line);
      if (stderrChunks.length > STDERR_TAIL_MAX_CHUNKS) {
        stderrChunks.shift();
      }
    });
  }

  child.on("error", (error) => {
    spawnFailed = true;
    stderrChunks.push(error.message);
    finalizeExit({ code: null, signal: null });
  });

  child.on("exit", (code, signal) => {
    exitStatus = { code: code ?? null, signal: signal ?? null };
    closeGraceTimer = setTimeout(() => {
      finalizeExit(exitStatus ?? { code: null, signal: null });
    }, CLOSE_AFTER_EXIT_GRACE_MS);
    closeGraceTimer.unref?.();
  });

  child.on("close", (code, signal) => {
    finalizeExit(exitStatus ?? { code: code ?? null, signal: signal ?? null });
  });

  return {
    get exited() {
      return finalized;
    },

    request({ method, params, resultSchema, timeoutMs }) {
      if (finalized) {
        return Promise.reject(
          new CodexAppServerExitedError("codex app-server is not running", {
            spawnFailed,
          }),
        );
      }
      const id = nextRequestId;
      nextRequestId += 1;
      return new Promise((resolve, reject) => {
        const entry: PendingChildRequest = {
          resolve: (value) => {
            const parsed = resultSchema.safeParse(value);
            if (parsed.success) {
              resolve(parsed.data);
            } else {
              reject(
                new Error(
                  `codex app-server returned an unexpected ${method} result: ${parsed.error.message}`,
                ),
              );
            }
          },
          reject,
          timeout: null,
        };
        if (timeoutMs !== undefined) {
          entry.timeout = setTimeout(() => {
            pending.delete(id);
            reject(
              new Error(
                `codex app-server did not answer ${method} within ${timeoutMs}ms`,
              ),
            );
          }, timeoutMs);
          entry.timeout.unref?.();
        }
        pending.set(id, entry);
        writeLine({ jsonrpc: "2.0", id, method, params });
      });
    },

    notify(method, params) {
      if (finalized) {
        return;
      }
      writeLine({ jsonrpc: "2.0", method, params });
    },

    kill() {
      if (finalized) {
        return exitPromise;
      }
      const escalation = setTimeout(() => {
        if (!finalized) {
          child.kill("SIGKILL");
        }
      }, KILL_ESCALATION_MS);
      escalation.unref?.();
      child.kill("SIGTERM");
      return exitPromise;
    },
  };
}

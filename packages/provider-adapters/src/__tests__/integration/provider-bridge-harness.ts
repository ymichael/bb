/**
 * Test harness for spawning a provider bridge process and exchanging
 * JSON-RPC messages. Used by integration tests to validate the full
 * adapter → bridge → provider roundtrip within this package.
 *
 * The harness is provider-agnostic. For providers whose bridges forward raw
 * SDK messages (method: "sdk/message"), the caller passes a `translateEvent`
 * function so the harness can translate them into canonical notifications for
 * turn completion detection and assertion.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { BbProviderEvent } from "@bb/core";

export interface BridgeMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface CollectedNotification {
  method: string;
  params: BridgeMessage["params"];
}

export interface CollectedTurn {
  notifications: CollectedNotification[];
  response?: BridgeMessage;
  providerThreadId?: string;
  error?: string;
  ok: boolean;
}

/**
 * Optional translator for bridges that send raw SDK messages.
 * The harness calls this for `sdk/message` notifications to expand them
 * into canonical notification methods for turn detection and assertions.
 */
type BridgeEventTranslator = (sdkMessage: unknown) => BbProviderEvent[];

export class BridgeTestHarness {
  private child: ChildProcess | null = null;
  private readline: Interface | null = null;
  private requestId = 0;
  private pending = new Map<number, {
    resolve: (msg: BridgeMessage) => void;
    reject: (err: Error) => void;
  }>();
  private notificationListeners: Array<(msg: BridgeMessage) => void> = [];
  private toolCallHandler: ((msg: BridgeMessage) => Record<string, unknown> | null) | null = null;
  private _providerThreadId: string | undefined;
  private stderrChunks: string[] = [];

  constructor(
    private readonly processConfig: { command: string; args: string[] },
    private readonly launchConfig?: {
      env?: Record<string, string>;
    },
    private readonly overrides?: {
      processCommand?: string;
      processArgs?: string[];
      env?: Record<string, string>;
    },
    private readonly translateEvent?: BridgeEventTranslator,
  ) {}

  onToolCall(handler: (msg: BridgeMessage) => Record<string, unknown> | null): void {
    this.toolCallHandler = handler;
  }

  async start(): Promise<void> {
    const command = this.overrides?.processCommand ?? this.processConfig.command;
    const args = this.overrides?.processArgs ?? this.processConfig.args;

    this.child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(this.launchConfig?.env ?? {}),
        ...(this.overrides?.env ?? {}),
      },
    });

    if (!this.child.stdin || !this.child.stdout) {
      throw new Error(`Failed to spawn ${command}`);
    }

    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrChunks.push(chunk.toString());
    });

    this.readline = createInterface({ input: this.child.stdout });
    this.readline.on("line", (line) => this.handleLine(line));

    await new Promise((resolve) => setTimeout(resolve, 500));

    if (this.child.exitCode !== null) {
      const stderr = this.stderrChunks.join("");
      throw new Error(
        `${command} exited immediately with code ${this.child.exitCode}` +
        (stderr ? `\nstderr: ${stderr.slice(0, 500)}` : ""),
      );
    }
  }

  async initialize(params?: Record<string, unknown>): Promise<BridgeMessage> {
    return this.sendRequest({
      method: "initialize",
      params: {
        clientInfo: { name: "bb", version: "0.0.1" },
        ...params,
      },
    });
  }

  async sendRequest(cmd: { method: string; params: unknown }): Promise<BridgeMessage> {
    if (!this.child?.stdin) throw new Error("Bridge not started");

    const id = ++this.requestId;
    const request = {
      jsonrpc: "2.0" as const,
      id,
      method: cmd.method,
      params: cmd.params,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${cmd.method} (id=${id})`));
      }, 30_000);

      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timeout);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      this.child!.stdin!.write(JSON.stringify(request) + "\n");
    });
  }

  collectNotifications(opts: {
    until: (msg: BridgeMessage) => boolean;
    timeoutMs?: number;
  }): { promise: Promise<BridgeMessage[]>; cancel: () => void } {
    const collected: BridgeMessage[] = [];
    const timeoutMs = opts.timeoutMs ?? 40_000;

    let cleanup: () => void;

    const promise = new Promise<BridgeMessage[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        const summary = collected.map((m) => {
          const method = m.method ?? "(response)";
          const detail = m.params ? JSON.stringify(m.params).slice(0, 200) : "";
          return `  ${method}: ${detail}`;
        }).join("\n");
        reject(new Error(
          `Timeout after ${timeoutMs}ms waiting for turn completion.\n` +
          `Collected ${collected.length} notifications:\n${summary}`,
        ));
      }, timeoutMs);

      const listener = (msg: BridgeMessage) => {
        collected.push(msg);
        if (opts.until(msg)) {
          cleanup();
          resolve(collected);
        }
      };

      cleanup = () => {
        clearTimeout(timeout);
        const idx = this.notificationListeners.indexOf(listener);
        if (idx >= 0) this.notificationListeners.splice(idx, 1);
      };

      this.notificationListeners.push(listener);
    });

    return { promise, cancel: () => cleanup() };
  }

  async startThread(cmd: { method: string; params: unknown }): Promise<void> {
    const response = await this.sendRequest(cmd);
    if (response.error) {
      throw new Error(`thread/start failed: ${response.error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  getProviderThreadId(): string | undefined {
    return this._providerThreadId;
  }

  /**
   * Send a command and collect notifications until the turn completes.
   *
   * For bridges that forward raw SDK messages (method: "sdk/message"),
   * the harness uses the provided `translateEvent` to expand them into
   * canonical bb events for turn completion detection. The collected
   * notifications are the expanded canonical forms.
   */
  async runTurn(cmd: { method: string; params: unknown }): Promise<CollectedTurn> {
    const allNotifications: CollectedNotification[] = [];
    let turnDone = false;
    let endedWithError = false;
    let errorMessage: string | undefined;

    const collector = this.collectNotifications({
      until: (msg) => {
        // Expand sdk/message notifications via translateEvent
        if (msg.method === "sdk/message" && this.translateEvent) {
          const sdkMsg = (msg.params as { message?: unknown })?.message;
          if (sdkMsg) {
            const events = this.translateEvent(sdkMsg);
            for (const event of events) {
              allNotifications.push({ method: event.type, params: event as unknown as Record<string, unknown> });
              if (event.type === "turn/completed") {
                turnDone = true;
              }
              if (event.type === "error") {
                endedWithError = true;
                errorMessage = event.message;
                turnDone = true;
              }
            }
            return turnDone;
          }
        }

        // Direct notifications (codex, bridge errors, thread/identity)
        allNotifications.push({ method: msg.method!, params: msg.params });
        if (msg.method === "turn/completed") {
          turnDone = true;
          return true;
        }
        if (msg.method === "error") {
          endedWithError = true;
          errorMessage = (msg.params as { message?: string })?.message;
          return true;
        }
        return false;
      },
    });

    let response: BridgeMessage;
    try {
      response = await this.sendRequest(cmd);
    } catch (err) {
      collector.cancel();
      return {
        notifications: [],
        response: undefined,
        providerThreadId: this._providerThreadId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    await collector.promise;

    return {
      notifications: allNotifications,
      response,
      providerThreadId: this._providerThreadId,
      ok: !endedWithError,
      error: errorMessage,
    };
  }

  async stop(): Promise<void> {
    if (!this.child) return;

    if (this.child.stdin && !this.child.stdin.destroyed) {
      this.child.stdin.end();
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.child?.exitCode === null) {
          this.child.kill("SIGTERM");
          setTimeout(() => {
            if (this.child?.exitCode === null) {
              this.child!.kill("SIGKILL");
            }
            resolve();
          }, 1000);
        } else {
          resolve();
        }
      }, 2000);

      this.child!.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    this.readline?.close();
    this.child = null;
    this.readline = null;

    for (const [id, { reject }] of this.pending) {
      reject(new Error(`Bridge stopped while waiting for response (id=${id})`));
    }
    this.pending.clear();
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: BridgeMessage;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }

    // JSON-RPC request FROM provider (has both id AND method) — tool call
    if (msg.id !== undefined && msg.method) {
      this.handleToolCallRequest(msg);
      for (const listener of this.notificationListeners) {
        listener(msg);
      }
      return;
    }

    // JSON-RPC response (has id, no method)
    if (msg.id !== undefined && !msg.method) {
      const pending = this.pending.get(msg.id as number);
      if (pending) {
        this.pending.delete(msg.id as number);
        if (msg.error) {
          pending.reject(new Error(`RPC error: ${msg.error.message}`));
        } else {
          pending.resolve(msg);
        }
      }
      return;
    }

    // JSON-RPC notification (has method, no id)
    if (msg.method) {
      // Track provider thread ID
      if (msg.method === "thread/identity" && msg.params) {
        const ptid = (msg.params as Record<string, unknown>).providerThreadId;
        if (typeof ptid === "string") {
          this._providerThreadId = ptid;
        }
      }
      if (msg.method === "thread/started" && msg.params) {
        const thread = (msg.params as Record<string, unknown>).thread;
        if (thread && typeof thread === "object" && "id" in thread) {
          const threadId = (thread as { id: unknown }).id;
          if (typeof threadId === "string" && !this._providerThreadId) {
            this._providerThreadId = threadId;
          }
        }
      }
      // For sdk/message, also check translated events for thread/identity
      if (msg.method === "sdk/message" && this.translateEvent) {
        const sdkMsg = (msg.params as { message?: unknown })?.message;
        if (sdkMsg) {
          const events = this.translateEvent(sdkMsg);
          for (const event of events) {
            if (event.type === "thread/identity") {
              this._providerThreadId = event.providerThreadId;
            }
          }
        }
      }

      for (const listener of this.notificationListeners) {
        listener(msg);
      }
    }
  }

  private handleToolCallRequest(msg: BridgeMessage): void {
    if (!this.child?.stdin || msg.id === undefined) return;

    let result: Record<string, unknown> | null = null;
    if (this.toolCallHandler) {
      result = this.toolCallHandler(msg);
    }

    const response = result
      ? { jsonrpc: "2.0" as const, id: msg.id, result }
      : {
          jsonrpc: "2.0" as const,
          id: msg.id,
          error: { code: -32601, message: "No tool call handler registered" },
        };

    this.child.stdin.write(JSON.stringify(response) + "\n");
  }
}

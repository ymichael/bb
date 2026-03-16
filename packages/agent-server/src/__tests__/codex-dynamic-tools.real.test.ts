import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonLineTransport, JsonLineTransportHandlers } from "@bb/environment-daemon";
import { createCodexProviderAdapter } from "../codex-provider-adapter.js";
import { ProviderRuntime } from "../provider-runtime.js";
import { ProviderToolHost } from "../provider-tool-host.js";

class ChildProcessJsonLineTransport implements JsonLineTransport {
  private handlers: JsonLineTransportHandlers | undefined;
  private stdoutBuffer = "";
  private stderrBuffer = "";

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.stdoutBuffer = this.processChunk(this.stdoutBuffer, chunk, (line) => {
        this.handlers?.onLine(line);
      });
    });
    child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer = this.processChunk(this.stderrBuffer, chunk, (line) => {
        this.handlers?.onStderrLine?.(line);
      });
    });
    child.once("exit", () => {
      this.handlers?.onClose?.();
    });
  }

  setHandlers(handlers: JsonLineTransportHandlers): void {
    this.handlers = handlers;
  }

  send(line: string): void {
    this.child.stdin.write(`${line}\n`);
  }

  close(reason?: Error): void {
    this.child.kill("SIGTERM");
    this.handlers?.onClose?.(reason);
  }

  private processChunk(
    buffer: string,
    chunk: string,
    onLine: (line: string) => void,
  ): string {
    const combined = buffer + chunk;
    const parts = combined.split(/\r\n|\n|\r/g);
    const remainder = parts.pop() ?? "";
    for (const line of parts) {
      if (line.trim().length > 0) {
        onLine(line);
      }
    }
    return remainder;
  }
}

const shouldRun = process.env.BB_REAL_CODEX === "1";

describe.runIf(shouldRun).sequential("codex dynamic tools (real)", () => {
  const children: ChildProcessWithoutNullStreams[] = [];

  afterEach(() => {
    for (const child of children.splice(0)) {
      child.kill("SIGTERM");
    }
  });

  it(
    "round-trips a dynamic tool call through the real Codex provider",
    async () => {
      const adapter = createCodexProviderAdapter();
      const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
        stdio: "pipe",
        env: { ...process.env },
      });
      children.push(child);

      const transport = new ChildProcessJsonLineTransport(child);
      const toolCalls: string[] = [];
      let finalOutput = "";
      let resolveCompletion: (() => void) | undefined;
      const completed = new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      });

      const toolHost = new ProviderToolHost([
        {
          name: "echo_test_tool",
          description:
            "Return the exact input message verbatim. Use this tool when instructed to echo a message.",
          inputSchema: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
            required: ["message"],
            additionalProperties: false,
          },
          execute: ({ call }) => {
            const args =
              call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
                ? (call.arguments as { message?: unknown })
                : {};
            return String(args.message ?? "");
          },
        },
      ]);

      const runtime = new ProviderRuntime({
        threadId: "real-thread",
        transport,
        onNotification: ({ method, params }) => {
          if (method !== "item/completed") {
            return;
          }
          const item =
            params && typeof params === "object" && !Array.isArray(params)
              ? (params as { item?: unknown }).item
              : undefined;
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            return;
          }
          const record = item as { type?: unknown; text?: unknown };
          if (record.type !== "agentMessage" || typeof record.text !== "string") {
            return;
          }
          finalOutput = record.text;
          resolveCompletion?.();
        },
        onServerRequest: async (request) => {
          const call = adapter.decodeToolCallRequest?.(
            request.id,
            request.method,
            request.params,
          );
          if (!call) {
            throw new Error(`Unexpected provider request: ${request.method}`);
          }
          toolCalls.push(call.tool);
          const response = await toolHost.execute({
            call,
            context: {
              projectId: "proj-real",
              threadId: "real-thread",
            },
          });
          return adapter.encodeToolCallResponse?.(response) ?? response;
        },
      });

      await runtime.request({
        jsonrpc: "2.0",
        id: "init",
        method: adapter.initializeMethod,
        params: adapter.createInitializeParams?.(adapter.clientInfo) ?? {
          clientInfo: adapter.clientInfo,
        },
      }, 30_000);

      const providerThreadResult = await runtime.request(
        {
          jsonrpc: "2.0",
          id: "thread-start",
          method: adapter.threadStartMethod,
          params: adapter.createThreadStartParams(
            {
              projectId: "proj-real",
              developerInstructions:
                "When the user asks for a message echo, you must call echo_test_tool exactly once and then answer with exactly the tool result.",
            },
            {
              projectId: "proj-real",
              threadId: "real-thread",
            },
            toolHost.listTools(),
          ),
        },
        30_000,
      );
      const providerThreadId = adapter.extractThreadIdFromResult(providerThreadResult);
      expect(providerThreadId).toBeTruthy();

      await runtime.request(
        {
          jsonrpc: "2.0",
          id: "turn-start",
          method: adapter.turnStartMethod,
          params: adapter.createTurnStartParams(providerThreadId!, [
            {
              type: "text",
              text:
                'Use echo_test_tool with message "from-codex". After the tool returns, reply with exactly the returned text and nothing else.',
            },
          ]),
        },
        30_000,
      );

      await Promise.race([
        completed,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timed out waiting for Codex completion")), 60_000),
        ),
      ]);

      expect(toolCalls).toContain("echo_test_tool");
      expect(finalOutput.toLowerCase()).toContain("from-codex");
    },
    120_000,
  );
});

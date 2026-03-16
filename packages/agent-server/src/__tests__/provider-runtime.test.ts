import { describe, expect, it, vi } from "vitest";
import type { JsonLineTransport } from "@bb/environment-daemon";
import { ProviderRuntime } from "../provider-runtime.js";

function createTransport(): JsonLineTransport & {
  emitLine: (line: string) => void;
  emitClose: (reason?: Error) => void;
} {
  let handlers: {
    onLine?: (line: string) => void;
    onStderrLine?: (line: string) => void;
    onClose?: (reason?: Error) => void;
  } = {};

  return {
    send: vi.fn(),
    close: vi.fn(),
    setHandlers(nextHandlers) {
      handlers = nextHandlers;
    },
    emitLine(line: string) {
      handlers.onLine?.(line);
    },
    emitClose(reason?: Error) {
      handlers.onClose?.(reason);
    },
  };
}

describe("ProviderRuntime", () => {
  it("emits only typed string-method notifications", () => {
    const transport = createTransport();
    const onNotification = vi.fn();

    new ProviderRuntime({
      threadId: "thread-1",
      transport,
      onNotification,
    });

    transport.emitLine('{"method":"item/completed","params":{"ok":true}}');
    transport.emitLine('{"method":42,"params":{"ignored":true}}');

    expect(onNotification).toHaveBeenCalledTimes(1);
    expect(onNotification).toHaveBeenCalledWith({
      method: "item/completed",
      params: { ok: true },
    });
  });

  it("decodes rpc errors through the typed response path", async () => {
    const transport = createTransport();
    const runtime = new ProviderRuntime({
      threadId: "thread-1",
      transport,
      onNotification: vi.fn(),
    });

    const pending = runtime.request({
      jsonrpc: "2.0",
      id: "req-1",
      method: "thread/start",
    });

    transport.emitLine('{"id":"req-1","error":{"message":"bad request"}}');

    await expect(pending).rejects.toEqual(
      expect.objectContaining({
        name: "ProviderRuntimeRpcError",
        message:
          "[thread thread-1] Provider RPC error for request req-1: bad request",
      }),
    );
  });

  it("responds to server requests with handler results", async () => {
    const transport = createTransport();
    const onServerRequest = vi.fn(async () => ({
      success: true,
      contentItems: [{ type: "inputText", text: "ok" }],
    }));

    new ProviderRuntime({
      threadId: "thread-1",
      transport,
      onNotification: vi.fn(),
      onServerRequest,
    });

    transport.emitLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 61,
        method: "item/tool/call",
        params: { tool: "echo" },
      }),
    );

    await vi.waitFor(() => {
      expect(onServerRequest).toHaveBeenCalledWith({
        kind: "request",
        id: 61,
        method: "item/tool/call",
        params: { tool: "echo" },
      });
      expect(transport.send).toHaveBeenCalledWith(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 61,
          result: {
            success: true,
            contentItems: [{ type: "inputText", text: "ok" }],
          },
        }),
      );
    });
  });

  it("returns json-rpc errors for unhandled server requests", async () => {
    const transport = createTransport();

    new ProviderRuntime({
      threadId: "thread-1",
      transport,
      onNotification: vi.fn(),
    });

    transport.emitLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 62,
        method: "item/tool/call",
        params: { tool: "echo" },
      }),
    );

    await vi.waitFor(() => {
      expect(transport.send).toHaveBeenCalledWith(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 62,
          error: {
            code: -32601,
            message: "Unhandled provider request method item/tool/call",
          },
        }),
      );
    });
  });
});

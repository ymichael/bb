import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AcpAgentExitedError,
  createAcpAgentConnection,
  formatAgentError,
  type AcpAgentConnection,
  type AcpAgentExitInfo,
} from "./agent-connection.js";

const EPIPE_PAYLOAD_SIZE = 1024 * 1024;

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}

async function stopConnection(
  connection: AcpAgentConnection,
  exit: Promise<AcpAgentExitInfo>,
): Promise<void> {
  if (!connection.exited) {
    connection.kill();
  }
  await exit;
}

describe("formatAgentError", () => {
  it("appends error.data.details to the generic JSON-RPC message", () => {
    expect(
      formatAgentError({
        code: -32603,
        message: "Internal error",
        data: { details: "bb-bridge: Transport closed" },
      }),
    ).toBe("Internal error: bb-bridge: Transport closed");
  });

  it("keeps the message alone when there is no usable data", () => {
    expect(formatAgentError({ message: "Internal error" })).toBe(
      "Internal error",
    );
    expect(formatAgentError({ message: "Internal error", data: "  " })).toBe(
      "Internal error",
    );
    expect(formatAgentError({ code: -32600 })).toBe(
      "ACP agent returned error code -32600",
    );
  });

  it("serializes structured data without a details string", () => {
    expect(
      formatAgentError({ message: "Invalid params", data: { field: "cwd" } }),
    ).toBe('Invalid params: {"field":"cwd"}');
  });
});

describe("ACP agent stdio lifecycle", () => {
  it("does not surface a closed agent stdin as an unhandled EPIPE", async () => {
    const ready = deferred<void>();
    const exited = deferred<AcpAgentExitInfo>();
    const connection = createAcpAgentConnection({
      recordThreadId: null,
      command: process.execPath,
      args: [
        "-e",
        [
          'require("node:fs").closeSync(0);',
          'process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "ready" }) + "\\n");',
          "setTimeout(() => process.exit(0), 1000);",
        ].join(" "),
      ],
      cwd: process.cwd(),
      env: process.env,
      onNotification(method) {
        if (method === "ready") ready.resolve();
      },
      onRequest() {},
      onExit: exited.resolve,
    });

    try {
      await ready.promise;
      connection.notify("large-notification", {
        payload: "x".repeat(EPIPE_PAYLOAD_SIZE),
      });
      await delay(50);
    } finally {
      await stopConnection(connection, exited.promise);
    }
  });

  it("rejects requests and stops an agent that closes stdin but stays alive", async () => {
    const ready = deferred<void>();
    const exited = deferred<AcpAgentExitInfo>();
    const connection = createAcpAgentConnection({
      recordThreadId: null,
      command: process.execPath,
      args: [
        "-e",
        [
          'require("node:fs").closeSync(0);',
          'process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "ready" }) + "\\n");',
          "setInterval(() => {}, 1000);",
        ].join(" "),
      ],
      cwd: process.cwd(),
      env: process.env,
      onNotification(method) {
        if (method === "ready") ready.resolve();
      },
      onRequest() {},
      onExit: exited.resolve,
    });

    try {
      await ready.promise;
      const pendingRequest = connection.request({
        method: "fixture/pending",
        params: { payload: "x".repeat(EPIPE_PAYLOAD_SIZE) },
        resultSchema: z.unknown(),
      });
      const requestWithDeadline = Promise.race([
        pendingRequest,
        delay(500).then(() => {
          throw new Error("ACP request remained pending after stdin closed");
        }),
      ]);

      await expect(requestWithDeadline).rejects.toBeInstanceOf(
        AcpAgentExitedError,
      );
      expect(connection.exited).toBe(true);
      await expect(
        connection.request({
          method: "fixture/future",
          params: null,
          resultSchema: z.unknown(),
        }),
      ).rejects.toBeInstanceOf(AcpAgentExitedError);
      await expect(exited.promise).resolves.toMatchObject({
        code: null,
        signal: null,
      });
    } finally {
      await stopConnection(connection, exited.promise);
    }
  });

  it("makes an intentionally stopped connection unavailable before stdin teardown", async () => {
    const ready = deferred<void>();
    const exited = deferred<AcpAgentExitInfo>();
    const connection = createAcpAgentConnection({
      recordThreadId: null,
      command: process.execPath,
      args: [
        "-e",
        [
          'const fs = require("node:fs");',
          'const send = (method) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\\n");',
          'process.on("SIGTERM", () => { fs.closeSync(0); setTimeout(() => process.exit(0), 50); });',
          'send("ready");',
          "setInterval(() => {}, 1000);",
        ].join(" "),
      ],
      cwd: process.cwd(),
      env: process.env,
      onNotification(method) {
        if (method === "ready") ready.resolve();
      },
      onRequest() {},
      onExit: exited.resolve,
    });

    try {
      await ready.promise;
      const pendingError = connection
        .request({
          method: "session/new",
          params: null,
          resultSchema: z.unknown(),
        })
        .then(
          () => undefined,
          (error: Error) => error,
        );
      connection.kill();
      connection.notify("construction/continues", {
        payload: "x".repeat(EPIPE_PAYLOAD_SIZE),
      });

      const error = await Promise.race([
        pendingError,
        delay(500).then(() => {
          throw new Error(
            "ACP request remained pending after intentional stop",
          );
        }),
      ]);
      expect(error).toBeInstanceOf(AcpAgentExitedError);
      expect(error?.message).toBe(
        `ACP agent "${process.execPath}" is not running`,
      );
      expect(connection.exited).toBe(true);
      await expect(
        connection.request({
          method: "fixture/future",
          params: null,
          resultSchema: z.unknown(),
        }),
      ).rejects.toThrow(`ACP agent "${process.execPath}" is not running`);
      await expect(exited.promise).resolves.toMatchObject({
        code: 0,
        signal: null,
      });
    } finally {
      await stopConnection(connection, exited.promise);
    }
  });

  it("ignores an ACP request emitted during SIGTERM", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "bb-acp-stop-"));
    const lateWrite = join(workspace, "late-write.txt");
    const ready = deferred<void>();
    const exited = deferred<AcpAgentExitInfo>();
    let requestCount = 0;
    const connection = createAcpAgentConnection({
      recordThreadId: null,
      command: process.execPath,
      args: [
        "-e",
        [
          'const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");',
          'process.on("SIGTERM", () => { send({ jsonrpc: "2.0", id: 1, method: "fs/write_text_file", params: {} }); setTimeout(() => process.exit(0), 50); });',
          'send({ jsonrpc: "2.0", method: "ready" });',
          "setInterval(() => {}, 1000);",
        ].join(" "),
      ],
      cwd: workspace,
      env: process.env,
      onNotification(method) {
        if (method === "ready") ready.resolve();
      },
      onRequest() {
        requestCount += 1;
        writeFileSync(lateWrite, "written after release");
      },
      onExit: exited.resolve,
    });

    try {
      await ready.promise;
      connection.kill();
      await exited.promise;
      expect(requestCount).toBe(0);
      expect(existsSync(lateWrite)).toBe(false);
    } finally {
      await stopConnection(connection, exited.promise);
      rmSync(workspace, { recursive: true });
    }
  });

  it("rejects pending requests when the agent exits", async () => {
    const exited = deferred<AcpAgentExitInfo>();
    const connection = createAcpAgentConnection({
      recordThreadId: null,
      command: process.execPath,
      args: ["-e", "setTimeout(() => process.exit(7), 20)"],
      cwd: process.cwd(),
      env: process.env,
      onNotification() {},
      onRequest() {},
      onExit: exited.resolve,
    });

    const request = connection.request({
      method: "fixture/pending",
      params: null,
      resultSchema: z.unknown(),
    });

    await expect(request).rejects.toThrow(
      `ACP agent "${process.execPath}" exited (code 7, signal null)`,
    );
    await expect(exited.promise).resolves.toMatchObject({
      code: 7,
      signal: null,
    });
  });
});

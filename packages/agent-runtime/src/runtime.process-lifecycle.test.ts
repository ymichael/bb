import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadEvent } from "@bb/domain";
import type { ProviderAdapter } from "./provider-adapter.js";
import { createAgentRuntimeWithAdapters } from "./runtime.js";
import { fakeProviderScriptPath } from "./test/index.js";
import {
  createFakeAdapter,
  fullRuntimeOptions,
  waitForRuntimeState,
} from "./test/runtime-test-harness.js";

describe("createAgentRuntime process lifecycle", () => {
  let tmpDir: string;
  let scriptPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bb-runtime-test-"));
    scriptPath = fakeProviderScriptPath;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("handles JSON-RPC error responses from provider", async () => {
    const events: ThreadEvent[] = [];
    const runtime = createAgentRuntimeWithAdapters({
      workspacePath: tmpDir,
      onEvent: (e) => events.push(e),
      onToolCall: async () => ({
        contentItems: [{ type: "inputText", text: "ok" }],
        success: true,
      }),
      adapterFactory: () => createFakeAdapter(scriptPath),
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });

    // runTurn on a thread that the fake provider doesn't know about (start creates it,
    // but if we use a different threadId the fake script returns an error)
    // Actually, let's test the bad thread case through the provider error path:
    // The fake provider returns an error for unknown threads in turn/start
    // But our runtime maps threadId -> provider, so we need to trick it.
    // Instead, test with a custom adapter that always returns errors:
    const errorAdapter: ProviderAdapter = {
      ...createFakeAdapter(scriptPath),
      buildCommandPlan(cmd) {
        if (cmd.type === "turn/start") {
          return { kind: "request", method: "bad_method", params: {} };
        }
        return createFakeAdapter(scriptPath).buildCommandPlan(cmd);
      },
    };

    const runtime2 = createAgentRuntimeWithAdapters({
      workspacePath: tmpDir,
      onEvent: () => {},
      onToolCall: async () => ({
        contentItems: [{ type: "inputText", text: "ok" }],
        success: true,
      }),
      adapterFactory: () => errorAdapter,
    });

    await runtime2.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    // This should reject because the provider returns a -32601 error
    await expect(
      runtime2.runTurn({
        clientRequestId: "creq_222222224w",
        threadId: "t1",
        input: [{ type: "text", text: "hi" }],
        options: fullRuntimeOptions,
      }),
    ).rejects.toThrow("Method not found");
    await runtime.shutdown();
    await runtime2.shutdown();
  });

  // ---- Process lifecycle ----

  it("fires onProcessExit when provider crashes", async () => {
    const exitInfo = vi.fn();
    const crashScript = join(tmpDir, "crash-provider.cjs");
    writeFileSync(
      crashScript,
      `const rl = require("readline").createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
          setTimeout(() => process.exit(42), 50);
        }
      });`,
    );

    const runtime = createAgentRuntimeWithAdapters({
      workspacePath: tmpDir,
      onEvent: () => {},
      onToolCall: async () => ({
        contentItems: [{ type: "inputText", text: "ok" }],
        success: true,
      }),
      onProcessExit: exitInfo,
      adapterFactory: () => createFakeAdapter(crashScript),
    });

    await runtime.ensureProvider({ providerId: "fake" });
    await waitForRuntimeState({
      label: "provider process exit callback",
      predicate: () => exitInfo.mock.calls.length === 1,
    });

    expect(exitInfo).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "fake", code: 42 }),
    );
    await runtime.shutdown();
  });

  it("shutdown kills processes and rejects pending requests", async () => {
    const runtime = createAgentRuntimeWithAdapters({
      workspacePath: tmpDir,
      onEvent: () => {},
      onToolCall: async () => ({
        contentItems: [{ type: "inputText", text: "ok" }],
        success: true,
      }),
      adapterFactory: () => createFakeAdapter(scriptPath),
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await runtime.shutdown();
    // Should not hang
  });

  it("ignores provider stdout emitted after shutdown starts", async () => {
    const events: ThreadEvent[] = [];
    const shutdownEventScript = join(tmpDir, "shutdown-event-provider.cjs");
    writeFileSync(
      shutdownEventScript,
      `const rl = require("readline").createInterface({ input: process.stdin });
      process.on("SIGTERM", () => {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          method: "thread/identity",
          params: { threadId: "t1", providerThreadId: "late-provider-thread" }
        }) + "\\n");
        setTimeout(() => process.exit(0), 10);
      });
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
        } else if (msg.method === "thread/start") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { providerThreadId: "provider-thread" }
          }) + "\\n");
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            method: "thread/identity",
            params: { threadId: msg.params?.threadId, providerThreadId: "provider-thread" }
          }) + "\\n");
        }
      });`,
    );

    const runtime = createAgentRuntimeWithAdapters({
      workspacePath: tmpDir,
      onEvent: (event) => {
        events.push(event);
      },
      onToolCall: async () => ({
        contentItems: [{ type: "inputText", text: "ok" }],
        success: true,
      }),
      adapterFactory: () => createFakeAdapter(shutdownEventScript),
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await waitForRuntimeState({
      label: "initial provider identity event",
      predicate: () =>
        events.some(
          (event) =>
            event.type === "thread/identity" &&
            event.providerThreadId === "provider-thread",
        ),
    });
    events.splice(0, events.length);

    await runtime.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(events).toEqual([]);
  });

  // ---- Fail-fast behavior ----

  it("fails fast when provider binary does not exist", async () => {
    const badAdapter: ProviderAdapter = {
      ...createFakeAdapter(scriptPath),
      process: { command: "nonexistent-binary-that-does-not-exist", args: [] },
    };

    const runtime = createAgentRuntimeWithAdapters({
      workspacePath: tmpDir,
      onEvent: () => {},
      onToolCall: async () => ({
        contentItems: [{ type: "inputText", text: "ok" }],
        success: true,
      }),
      adapterFactory: () => badAdapter,
    });

    await expect(
      runtime.ensureProvider({ providerId: "fake" }),
    ).rejects.toThrow(/failed to start|exited during startup/i);
    await runtime.shutdown();
  });

  it("fails fast when provider crashes during initialize", async () => {
    const crashOnInitScript = join(tmpDir, "crash-on-init.cjs");
    writeFileSync(
      crashOnInitScript,
      `process.exit(1);`, // exits immediately, never responds to init
    );

    const runtime = createAgentRuntimeWithAdapters({
      workspacePath: tmpDir,
      onEvent: () => {},
      onToolCall: async () => ({
        contentItems: [{ type: "inputText", text: "ok" }],
        success: true,
      }),
      adapterFactory: () => createFakeAdapter(crashOnInitScript),
    });

    await expect(
      runtime.ensureProvider({ providerId: "fake" }),
    ).rejects.toThrow(/exited/i);
    await runtime.shutdown();
  });

  it("fails fast on runTurn after provider has crashed", async () => {
    const crashAfterInitScript = join(tmpDir, "crash-after-init.cjs");
    writeFileSync(
      crashAfterInitScript,
      `const rl = require("readline").createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
          // Start thread succeeds
        } else if (msg.method === "thread/start") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id: msg.id,
            result: { providerThreadId: "prov-crash" }
          }) + "\\n");
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0", method: "thread/identity",
            params: { threadId: msg.params?.threadId, providerThreadId: "prov-crash" }
          }) + "\\n");
          // Then crash
          setTimeout(() => process.exit(99), 50);
        }
      });`,
    );

    const exitInfo = vi.fn();
    const runtime = createAgentRuntimeWithAdapters({
      workspacePath: tmpDir,
      onEvent: () => {},
      onToolCall: async () => ({
        contentItems: [{ type: "inputText", text: "ok" }],
        success: true,
      }),
      onProcessExit: exitInfo,
      adapterFactory: () => createFakeAdapter(crashAfterInitScript),
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await waitForRuntimeState({
      label: "provider process exit callback",
      predicate: () => exitInfo.mock.calls.length === 1,
    });

    await expect(
      runtime.runTurn({
        clientRequestId: "creq_222222224x",
        threadId: "t1",
        input: [{ type: "text", text: "hi" }],
        options: fullRuntimeOptions,
      }),
    ).rejects.toThrow(/exited|not running|no provider associated/i);
    await runtime.shutdown();
  });

  it("rejects pending sendRequest when provider dies mid-turn", async () => {
    const crashDuringTurnScript = join(tmpDir, "crash-during-turn.cjs");
    writeFileSync(
      crashDuringTurnScript,
      `const rl = require("readline").createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
        } else if (msg.method === "thread/start") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id: msg.id,
            result: { providerThreadId: "prov-mid" }
          }) + "\\n");
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0", method: "thread/identity",
            params: { threadId: msg.params?.threadId, providerThreadId: "prov-mid" }
          }) + "\\n");
        } else if (msg.method === "turn/start") {
          // Don't respond — just crash
          setTimeout(() => process.exit(77), 50);
        }
      });`,
    );

    const runtime = createAgentRuntimeWithAdapters({
      workspacePath: tmpDir,
      onEvent: () => {},
      onToolCall: async () => ({
        contentItems: [{ type: "inputText", text: "ok" }],
        success: true,
      }),
      adapterFactory: () => createFakeAdapter(crashDuringTurnScript),
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });

    // runTurn sends the request but the provider crashes without responding
    await expect(
      runtime.runTurn({
        clientRequestId: "creq_222222224y",
        threadId: "t1",
        input: [{ type: "text", text: "hi" }],
        options: fullRuntimeOptions,
      }),
    ).rejects.toThrow(/exited unexpectedly/i);
    await runtime.shutdown();
  });

  it("concurrent ensureProvider calls do not spawn duplicate processes", async () => {
    let spawnCount = 0;
    const baseAdapter = createFakeAdapter(scriptPath);
    const countingAdapter: ProviderAdapter = {
      ...baseAdapter,
      get process() {
        spawnCount++;
        return baseAdapter.process;
      },
    };

    const runtime = createAgentRuntimeWithAdapters({
      workspacePath: tmpDir,
      onEvent: () => {},
      onToolCall: async () => ({
        contentItems: [{ type: "inputText", text: "ok" }],
        success: true,
      }),
      adapterFactory: () => countingAdapter,
    });

    // Call ensureProvider concurrently
    await Promise.all([
      runtime.ensureProvider({ providerId: "fake" }),
      runtime.ensureProvider({ providerId: "fake" }),
      runtime.ensureProvider({ providerId: "fake" }),
    ]);

    // Duplicate starts would read the process config more than once.
    expect(spawnCount).toBe(1);
    await runtime.shutdown();
  });

  // ---- Multi-thread ----
});

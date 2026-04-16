import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadEvent } from "@bb/domain";
import { createAgentRuntimeWithAdapters } from "./runtime.js";
import { fakeProviderScriptPath } from "./test/index.js";
import {
  createFakeAdapter,
  fullRuntimeOptions,
  waitForThreadTurnStarted,
} from "./test/runtime-test-harness.js";

describe("createAgentRuntime command contracts", () => {
  let tmpDir: string;
  let scriptPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bb-runtime-test-"));
    scriptPath = fakeProviderScriptPath;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects required adapter commands that return no-op plans", async () => {
    const baseAdapter = createFakeAdapter(scriptPath);
    const runtime = createAgentRuntimeWithAdapters({
      workspacePath: tmpDir,
      onEvent: () => {},
      onToolCall: async () => ({
        contentItems: [{ type: "inputText", text: "ok" }],
        success: true,
      }),
      adapterFactory: () => ({
        ...baseAdapter,
        buildCommandPlan(command) {
          if (command.type === "turn/start") {
            return { kind: "noop", reason: "turn start unsupported" };
          }
          return baseAdapter.buildCommandPlan(command);
        },
      }),
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await expect(
      runtime.runTurn({
        threadId: "t1",
        input: [{ type: "text", text: "hello" }],
        options: fullRuntimeOptions,
      }),
    ).rejects.toThrow(/returned no provider request for turn\/start/);
    await runtime.shutdown();
  });

  it("rejects no-op steer commands instead of silently dropping them", async () => {
    const events: ThreadEvent[] = [];
    const baseAdapter = createFakeAdapter(scriptPath);
    const runtime = createAgentRuntimeWithAdapters({
      workspacePath: tmpDir,
      onEvent: (event) => events.push(event),
      onToolCall: async () => ({
        contentItems: [{ type: "inputText", text: "ok" }],
        success: true,
      }),
      adapterFactory: () => ({
        ...baseAdapter,
        buildCommandPlan(command) {
          if (command.type === "turn/steer") {
            return { kind: "noop", reason: "steer unsupported" };
          }
          return baseAdapter.buildCommandPlan(command);
        },
      }),
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await runtime.runTurn({
      threadId: "t1",
      input: [{ type: "text", text: "delay:500" }],
      options: fullRuntimeOptions,
    });
    await waitForThreadTurnStarted({
      events,
      providerId: "fake",
      runtime,
      threadId: "t1",
      turnId: "turn-1",
    });
    await expect(
      runtime.steerTurn({
        threadId: "t1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "steer" }],
        options: fullRuntimeOptions,
      }),
    ).rejects.toThrow(/returned no provider request for turn\/steer/);
    await runtime.shutdown();
  });

  it("rejects unsupported thread rename instead of silently succeeding", async () => {
    const baseAdapter = createFakeAdapter(scriptPath);
    const runtime = createAgentRuntimeWithAdapters({
      workspacePath: tmpDir,
      onEvent: () => {},
      onToolCall: async () => ({
        contentItems: [{ type: "inputText", text: "ok" }],
        success: true,
      }),
      adapterFactory: () => ({
        ...baseAdapter,
        capabilities: {
          ...baseAdapter.capabilities,
          supportsRename: false,
        },
      }),
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await expect(
      runtime.renameThread({ threadId: "t1", title: "New Title" }),
    ).rejects.toThrow(/does not support thread rename/);
    await runtime.shutdown();
  });

  it("rejects unsupported execution options before they reach adapters", async () => {
    const runtime = createAgentRuntimeWithAdapters({
      workspacePath: tmpDir,
      onEvent: () => {},
      onToolCall: async () => ({
        contentItems: [{ type: "inputText", text: "ok" }],
        success: true,
      }),
      adapterFactory: () => createFakeAdapter(scriptPath),
    });

    await expect(
      runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: {
          ...fullRuntimeOptions,
          serviceTier: "fast",
        },
      }),
    ).rejects.toThrow(/does not support service tiers/);
    await runtime.shutdown();
  });

  it("rejects no-op stop commands for active turns but allows explicit idle no-ops", async () => {
    const events: ThreadEvent[] = [];
    const baseAdapter = createFakeAdapter(scriptPath);
    const runtime = createAgentRuntimeWithAdapters({
      workspacePath: tmpDir,
      onEvent: (event) => events.push(event),
      onToolCall: async () => ({
        contentItems: [{ type: "inputText", text: "ok" }],
        success: true,
      }),
      adapterFactory: () => ({
        ...baseAdapter,
        buildCommandPlan(command) {
          if (command.type === "thread/stop") {
            return { kind: "noop", reason: "no active turn to stop" };
          }
          return baseAdapter.buildCommandPlan(command);
        },
      }),
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await runtime.stopThread({ threadId: "t1" });

    await runtime.runTurn({
      threadId: "t1",
      input: [{ type: "text", text: "delay:500" }],
      options: fullRuntimeOptions,
    });
    await waitForThreadTurnStarted({
      events,
      providerId: "fake",
      runtime,
      threadId: "t1",
      turnId: "turn-1",
    });
    await expect(runtime.stopThread({ threadId: "t1" }))
      .rejects.toThrow(/returned no provider request for thread\/stop with active turn/);

    await runtime.shutdown();
  });

});

import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadEvent } from "@bb/domain";
import type { AdapterCommand } from "./provider-adapter.js";
import { createAgentRuntime } from "./runtime.js";
import { fakeProviderScriptPath } from "./test/index.js";
import {
  createFakeAdapter,
  createRecordingAdapter,
  findLastRecordedCommand,
  fullRuntimeOptions,
  wait,
  waitForCondition,
} from "./test/runtime-test-harness.js";

describe("createAgentRuntime lifecycle", () => {
  let tmpDir: string;
  let scriptPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bb-runtime-test-"));
    scriptPath = fakeProviderScriptPath;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("thread setup and configuration", () => {
    it("starts a thread and receives a providerThreadId", async () => {
      const events: ThreadEvent[] = [];
      const runtime = createAgentRuntime({
        workspacePath: tmpDir,
        onEvent: (e) => events.push(e),
        onToolCall: async () => ({
          contentItems: [{ type: "inputText", text: "ok" }],
          success: true,
        }),
        adapterFactory: () => createFakeAdapter(scriptPath),
      });

      const { providerThreadId } = await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: fullRuntimeOptions,
      });

      expect(providerThreadId).toBe("prov-1");
      await wait(50);
      expect(events.some((e) => e.type === "thread/identity")).toBe(true);
      await runtime.shutdown();
    });

    it("accepts thread/start results with a null providerThreadId", async () => {
      const nullIdentityScriptPath = join(tmpDir, "null-identity-provider.cjs");
      writeFileSync(
        nullIdentityScriptPath,
        `
const readline = require("node:readline");

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }

  if (message.method === "thread/start") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { threadId: "prov-thread-fallback", providerThreadId: null },
    });
  }
});
`,
        "utf8",
      );
      const runtime = createAgentRuntime({
        workspacePath: tmpDir,
        onEvent: () => undefined,
        onToolCall: async () => ({
          contentItems: [{ type: "inputText", text: "ok" }],
          success: true,
        }),
        adapterFactory: () => createFakeAdapter(nullIdentityScriptPath),
      });

      const { providerThreadId } = await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: fullRuntimeOptions,
      });

      expect(providerThreadId).toBe("prov-thread-fallback");
      await runtime.shutdown();
    });

    it("merges runtime shell env with per-thread context on start", async () => {
      const recordedCommands: AdapterCommand[] = [];
      const runtime = createAgentRuntime({
        workspacePath: tmpDir,
        shellEnv: {
          PATH: "/tmp/bb-bin:/usr/bin",
          BB_HOST_DAEMON_PORT: "3002",
          BB_PROJECT_ID: "wrong-project",
          BB_SERVER_URL: "http://127.0.0.1:3334",
          BB_THREAD_ID: "wrong-thread",
        },
        onEvent: () => undefined,
        onToolCall: async () => ({
          contentItems: [{ type: "inputText", text: "ok" }],
          success: true,
        }),
        adapterFactory: () =>
          createRecordingAdapter({ recordedCommands, scriptPath }),
      });

      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: fullRuntimeOptions,
      });

      const threadStart = recordedCommands.find(
        (command) => command.type === "thread/start",
      );
      expect(threadStart?.type).toBe("thread/start");
      if (!threadStart || threadStart.type !== "thread/start") {
        throw new Error("Expected thread/start command");
      }
      expect(threadStart.options?.envVars).toEqual({
        PATH: "/tmp/bb-bin:/usr/bin",
        BB_HOST_DAEMON_PORT: "3002",
        BB_PROJECT_ID: "p1",
        BB_SERVER_URL: "http://127.0.0.1:3334",
        BB_THREAD_ID: "t1",
        BB_ENVIRONMENT_ID: "env-1",
      });
      expect(threadStart.cwd).toBe(tmpDir);

      await runtime.shutdown();
    });

    it("preserves merged shell env when reconfiguring a thread", async () => {
      const recordedCommands: AdapterCommand[] = [];
      const runtime = createAgentRuntime({
        workspacePath: tmpDir,
        shellEnv: {
          PATH: "/tmp/bb-bin:/usr/bin",
          BB_HOST_DAEMON_PORT: "3002",
          BB_SERVER_URL: "http://127.0.0.1:3334",
        },
        onEvent: () => undefined,
        onToolCall: async () => ({
          contentItems: [{ type: "inputText", text: "ok" }],
          success: true,
        }),
        adapterFactory: () =>
          createRecordingAdapter({ recordedCommands, scriptPath }),
      });

      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        instructions: "Initial instructions",
        options: fullRuntimeOptions,
      });

      await runtime.runTurn({
        threadId: "t1",
        input: [{ type: "text", text: "follow up" }],
        instructions: "Updated instructions",
        options: fullRuntimeOptions,
      });

      const reconfigureCommand = findLastRecordedCommand(
        recordedCommands,
        "thread/resume",
      );
      expect(reconfigureCommand?.type).toBe("thread/resume");
      if (!reconfigureCommand || reconfigureCommand.type !== "thread/resume") {
        throw new Error("Expected thread/resume command");
      }
      expect(reconfigureCommand.options?.envVars).toEqual({
        PATH: "/tmp/bb-bin:/usr/bin",
        BB_HOST_DAEMON_PORT: "3002",
        BB_SERVER_URL: "http://127.0.0.1:3334",
        BB_PROJECT_ID: "p1",
        BB_THREAD_ID: "t1",
        BB_ENVIRONMENT_ID: "env-1",
      });
      expect(reconfigureCommand.cwd).toBe(tmpDir);

      await runtime.shutdown();
    });

    it("passes the workspace cwd when resuming a thread", async () => {
      const recordedCommands: AdapterCommand[] = [];
      const runtime = createAgentRuntime({
        workspacePath: tmpDir,
        shellEnv: {
          PATH: "/tmp/bb-bin:/usr/bin",
          BB_HOST_DAEMON_PORT: "3002",
          BB_SERVER_URL: "http://127.0.0.1:3334",
        },
        onEvent: () => undefined,
        onToolCall: async () => ({
          contentItems: [{ type: "inputText", text: "ok" }],
          success: true,
        }),
        adapterFactory: () =>
          createRecordingAdapter({ recordedCommands, scriptPath }),
      });

      await runtime.resumeThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerThreadId: "prov-1",
        providerId: "fake",
        options: fullRuntimeOptions,
      });

      const resumeCommand = findLastRecordedCommand(
        recordedCommands,
        "thread/resume",
      );
      expect(resumeCommand?.type).toBe("thread/resume");
      if (!resumeCommand || resumeCommand.type !== "thread/resume") {
        throw new Error("Expected thread/resume command");
      }
      expect(resumeCommand.options?.envVars).toEqual({
        PATH: "/tmp/bb-bin:/usr/bin",
        BB_HOST_DAEMON_PORT: "3002",
        BB_SERVER_URL: "http://127.0.0.1:3334",
        BB_PROJECT_ID: "p1",
        BB_THREAD_ID: "t1",
        BB_ENVIRONMENT_ID: "env-1",
      });
      expect(resumeCommand.cwd).toBe(tmpDir);

      await runtime.shutdown();
    });

    it("passes permission mode through to adapter commands", async () => {
      const recordedCommands: AdapterCommand[] = [];
      const runtime = createAgentRuntime({
        workspacePath: tmpDir,
        onEvent: () => undefined,
        onToolCall: async () => ({
          contentItems: [{ type: "inputText", text: "ok" }],
          success: true,
        }),
        adapterFactory: () =>
          createRecordingAdapter({ recordedCommands, scriptPath }),
      });

      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: {
          permissionMode: "workspace-write",
          permissionEscalation: "ask",
        },
      });

      await runtime.runTurn({
        threadId: "t1",
        input: [{ type: "text", text: "follow up" }],
        options: fullRuntimeOptions,
      });

      const threadStart = recordedCommands.find(
        (command) => command.type === "thread/start",
      );
      expect(threadStart?.type).toBe("thread/start");
      if (!threadStart || threadStart.type !== "thread/start") {
        throw new Error("Expected thread/start command");
      }
      expect(threadStart.options?.permissionMode).toBe("workspace-write");

      const reconfigureCommand = findLastRecordedCommand(
        recordedCommands,
        "thread/resume",
      );
      expect(reconfigureCommand?.type).toBe("thread/resume");
      if (!reconfigureCommand || reconfigureCommand.type !== "thread/resume") {
        throw new Error("Expected thread/resume command");
      }
      expect(reconfigureCommand.options?.permissionMode).toBe("full");

      const turnStart = findLastRecordedCommand(recordedCommands, "turn/start");
      expect(turnStart?.type).toBe("turn/start");
      if (!turnStart || turnStart.type !== "turn/start") {
        throw new Error("Expected turn/start command");
      }
      expect(turnStart.options?.permissionMode).toBe("full");

      await runtime.shutdown();
    });

    it("reconfigures permission policy before starting a turn when options change", async () => {
      const recordedCommands: AdapterCommand[] = [];
      const runtime = createAgentRuntime({
        workspacePath: tmpDir,
        onEvent: () => undefined,
        onToolCall: async () => ({
          contentItems: [{ type: "inputText", text: "ok" }],
          success: true,
        }),
        adapterFactory: () =>
          createRecordingAdapter({ recordedCommands, scriptPath }),
      });

      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: {
          permissionEscalation: "ask",
          permissionMode: "workspace-write",
        },
      });

      await runtime.runTurn({
        threadId: "t1",
        input: [{ type: "text", text: "follow up" }],
        options: {
          permissionEscalation: "deny",
          permissionMode: "readonly",
        },
      });

      const resumeIndex = recordedCommands.findIndex(
        (command) => command.type === "thread/resume",
      );
      const turnStartIndex = recordedCommands.findIndex(
        (command) => command.type === "turn/start",
      );
      expect(resumeIndex).toBeGreaterThan(-1);
      expect(turnStartIndex).toBeGreaterThan(-1);
      expect(resumeIndex).toBeLessThan(turnStartIndex);

      const resumeCommand = recordedCommands[resumeIndex];
      if (!resumeCommand || resumeCommand.type !== "thread/resume") {
        throw new Error("Expected thread/resume command");
      }
      expect(resumeCommand.options?.permissionMode).toBe("readonly");
      expect(resumeCommand.options?.permissionEscalation).toBe("deny");

      const turnStartCommand = recordedCommands[turnStartIndex];
      if (!turnStartCommand || turnStartCommand.type !== "turn/start") {
        throw new Error("Expected turn/start command");
      }
      expect(turnStartCommand.options?.permissionMode).toBe("readonly");
      expect(turnStartCommand.options?.permissionEscalation).toBe("deny");

      await runtime.shutdown();
    });

  });

  describe("turn execution and thread commands", () => {
    it("runs a turn and receives turn/started + turn/completed events", async () => {
      const events: ThreadEvent[] = [];
      const runtime = createAgentRuntime({
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
      await runtime.runTurn({ threadId: "t1", input: [{ type: "text", text: "hello" }], options: fullRuntimeOptions });
      await wait(100);

      expect(events.some((e) => e.type === "turn/started")).toBe(true);
      expect(events.some((e) => e.type === "turn/completed")).toBe(true);
      await runtime.shutdown();
    });

    it("runs the initial turn when startThread includes input", async () => {
      const events: ThreadEvent[] = [];
      const runtime = createAgentRuntime({
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
        input: [{ type: "text", text: "hello from start" }],
        options: fullRuntimeOptions,
      });
      await wait(100);

      expect(events.some((e) => e.type === "thread/identity")).toBe(true);
      expect(events.some((e) => e.type === "turn/started")).toBe(true);
      expect(events.some((e) => e.type === "turn/completed")).toBe(true);
      await runtime.shutdown();
    });

    it("does not start a turn until input is sent separately", async () => {
      const events: ThreadEvent[] = [];
      const runtime = createAgentRuntime({
        workspacePath: tmpDir,
        onEvent: (event) => events.push(event),
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
      await wait(100);

      expect(events.some((event) => event.type === "thread/identity")).toBe(true);
      expect(events.some((event) => event.type === "turn/started")).toBe(false);
      expect(events.some((event) => event.type === "turn/completed")).toBe(false);

      await runtime.runTurn({
        threadId: "t1",
        input: [{ type: "text", text: "hello after start" }],
        options: fullRuntimeOptions,
      });
      await wait(100);

      expect(events.some((event) => event.type === "turn/started")).toBe(true);
      expect(events.some((event) => event.type === "turn/completed")).toBe(true);
      await runtime.shutdown();
    });

    it("resumes a thread", async () => {
      const events: ThreadEvent[] = [];
      const runtime = createAgentRuntime({
        workspacePath: tmpDir,
        onEvent: (e) => events.push(e),
        onToolCall: async () => ({
          contentItems: [{ type: "inputText", text: "ok" }],
          success: true,
        }),
        adapterFactory: () => createFakeAdapter(scriptPath),
      });

      const { providerThreadId } = await runtime.resumeThread({
        environmentId: "env-1",
        threadId: "t1",
        providerThreadId: "old-prov-123",
        providerId: "fake",
        options: fullRuntimeOptions,
      });

      expect(providerThreadId).toBe("old-prov-123");

      // Should be able to run a turn on the resumed thread
      await runtime.runTurn({ threadId: "t1", input: [{ type: "text", text: "after resume" }], options: fullRuntimeOptions });
      await wait(100);
      expect(events.some((e) => e.type === "turn/completed")).toBe(true);
      await runtime.shutdown();
    });

    it("renames a thread", async () => {
      const runtime = createAgentRuntime({
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
      await runtime.renameThread({ threadId: "t1", title: "New Title" });
      await runtime.shutdown();
    });

    it("stops a thread", async () => {
      const runtime = createAgentRuntime({
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
      await runtime.stopThread({ threadId: "t1" });
      await runtime.shutdown();
    });

    it("preserves active turn state when stop command construction fails", async () => {
      const builtCommands: AdapterCommand[] = [];
      const events: ThreadEvent[] = [];
      const baseAdapter = createFakeAdapter(scriptPath);
      const runtime = createAgentRuntime({
        workspacePath: tmpDir,
        onEvent: (event) => events.push(event),
        onToolCall: async () => ({
          contentItems: [{ type: "inputText", text: "ok" }],
          success: true,
        }),
        adapterFactory: () => ({
          ...baseAdapter,
          buildCommand(command) {
            if (command.type === "thread/stop") {
              throw new Error("stop command failed to build");
            }
            builtCommands.push(command);
            return baseAdapter.buildCommand(command);
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
      await waitForCondition(() =>
        events.some((event) => event.type === "turn/started" && event.turnId === "turn-1"),
      );

      await expect(runtime.stopThread({ threadId: "t1" }))
        .rejects.toThrow(/stop command failed to build/);

      await runtime.steerTurn({
        threadId: "t1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "still active" }],
        options: fullRuntimeOptions,
      });

      expect(builtCommands.some((command) => command.type === "turn/steer")).toBe(true);

      await runtime.shutdown();
    });

    it("restarts providers that require a restart after thread stop", async () => {
      const events: ThreadEvent[] = [];
      const adapter = createFakeAdapter(scriptPath);
      const runtime = createAgentRuntime({
        workspacePath: tmpDir,
        onEvent: (event) => events.push(event),
        onToolCall: async () => ({
          contentItems: [{ type: "inputText", text: "ok" }],
          success: true,
        }),
        adapterFactory: () => ({
          ...adapter,
          threadStopBehavior: "restart-provider",
        }),
      });

      const startResult = await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: fullRuntimeOptions,
      });
      expect(runtime.listRunningProviders()).toEqual(["fake"]);

      await runtime.stopThread({ threadId: "t1" });
      expect(runtime.listRunningProviders()).toEqual([]);

      await runtime.resumeThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerThreadId: startResult.providerThreadId,
        providerId: "fake",
        options: fullRuntimeOptions,
      });
      await runtime.runTurn({
        threadId: "t1",
        input: [{ type: "text", text: "after restart" }],
        options: fullRuntimeOptions,
      });
      await waitForCondition(() =>
        events.some(
          (event) =>
            event.type === "item/completed" &&
            event.item.type === "agentMessage" &&
            event.item.text.includes("after restart"),
        )
      );

      await runtime.shutdown();
    });

    it("steers an active turn", async () => {
      const events: ThreadEvent[] = [];
      const runtime = createAgentRuntime({
        workspacePath: tmpDir,
        onEvent: (event) => events.push(event),
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
      await runtime.runTurn({
        threadId: "t1",
        input: [{ type: "text", text: "delay:500" }],
        options: fullRuntimeOptions,
      });
      await waitForCondition(() =>
        events.some((event) => event.type === "turn/started" && event.turnId === "turn-1"),
      );
      await runtime.steerTurn({
        threadId: "t1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "steer input" }],
        options: fullRuntimeOptions,
      });
      await runtime.shutdown();
    });

    it("reconfigures the thread before later run turns when settings change", async () => {
      const builtCommands: AdapterCommand[] = [];
      const baseAdapter = createFakeAdapter(scriptPath);
      const runtime = createAgentRuntime({
        workspacePath: tmpDir,
        onEvent: () => {},
        onToolCall: async () => ({
          contentItems: [{ type: "inputText", text: "ok" }],
          success: true,
        }),
        adapterFactory: () => ({
          ...baseAdapter,
          buildCommand(command) {
            builtCommands.push(command);
            return baseAdapter.buildCommand(command);
          },
        }),
      });

      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: { ...fullRuntimeOptions, model: "fake-model" },
        instructions: "Initial instructions",
      });
      builtCommands.length = 0;

      await runtime.runTurn({
        threadId: "t1",
        input: [{ type: "text", text: "use a different setup" }],
        options: { ...fullRuntimeOptions, model: "fake-model-2" },
        instructions: "Updated instructions",
      });

      expect(builtCommands).toHaveLength(2);
      expect(builtCommands[0]).toMatchObject({
        type: "thread/resume",
        options: {
          instructions: "Updated instructions",
          model: "fake-model-2",
        },
      });
      expect(builtCommands[1]).toMatchObject({
        type: "turn/start",
        options: {
          instructions: "Updated instructions",
          model: "fake-model-2",
        },
      });
      await runtime.shutdown();
    });

    it("reconfigures the thread before steer turns when settings change", async () => {
      const builtCommands: AdapterCommand[] = [];
      const events: ThreadEvent[] = [];
      const baseAdapter = createFakeAdapter(scriptPath);
      const runtime = createAgentRuntime({
        workspacePath: tmpDir,
        onEvent: (event) => events.push(event),
        onToolCall: async () => ({
          contentItems: [{ type: "inputText", text: "ok" }],
          success: true,
        }),
        adapterFactory: () => ({
          ...baseAdapter,
          buildCommand(command) {
            builtCommands.push(command);
            return baseAdapter.buildCommand(command);
          },
        }),
      });

      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: { ...fullRuntimeOptions, model: "fake-model" },
        instructions: "Initial instructions",
      });
      await runtime.runTurn({
        threadId: "t1",
        input: [{ type: "text", text: "delay:500" }],
        options: { ...fullRuntimeOptions, model: "fake-model" },
        instructions: "Initial instructions",
      });
      await waitForCondition(() =>
        events.some((event) => event.type === "turn/started" && event.turnId === "turn-1"),
      );
      builtCommands.length = 0;

      await runtime.steerTurn({
        threadId: "t1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "apply a new setup now" }],
        options: { ...fullRuntimeOptions, model: "fake-model-2" },
        instructions: "Updated instructions",
      });

      expect(builtCommands).toHaveLength(2);
      expect(builtCommands[0]).toMatchObject({
        type: "thread/resume",
        options: {
          instructions: "Updated instructions",
          model: "fake-model-2",
        },
      });
      expect(builtCommands[1]).toMatchObject({
        expectedTurnId: "turn-1",
        type: "turn/steer",
        options: {
          instructions: "Updated instructions",
          model: "fake-model-2",
        },
      });
      await runtime.shutdown();
    });

  });

  describe("models", () => {
    it("lists models", async () => {
      const runtime = createAgentRuntime({
        workspacePath: tmpDir,
        onEvent: () => {},
        onToolCall: async () => ({
          contentItems: [{ type: "inputText", text: "ok" }],
          success: true,
        }),
        adapterFactory: () => createFakeAdapter(scriptPath),
      });

      const models = await runtime.listModels({ providerId: "fake" });
      expect(models).toHaveLength(1);
      expect(models[0].id).toBe("fake-model");
      expect(models[0].isDefault).toBe(true);
      await runtime.shutdown();
    });

  });

  describe("errors", () => {
    it("rejects runTurn for unknown thread", async () => {
      const runtime = createAgentRuntime({
        workspacePath: tmpDir,
        onEvent: () => {},
        onToolCall: async () => ({
          contentItems: [{ type: "inputText", text: "ok" }],
          success: true,
        }),
        adapterFactory: () => createFakeAdapter(scriptPath),
      });

      await expect(
        runtime.runTurn({ threadId: "nonexistent", input: [{ type: "text", text: "hi" }], options: fullRuntimeOptions }),
      ).rejects.toThrow('No provider associated with thread "nonexistent"');
      await runtime.shutdown();
    });

  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadEvent } from "@bb/domain";
import { promptTextInput } from "./test/prompt-input.js";
import {
  createScriptedEchoLaunch,
  createScriptedEchoRequestRecord,
  createScriptedEchoRuntime,
  fullRuntimeOptions,
  wait,
  waitForThreadAgentMessageText,
  waitForThreadTurnCompleted,
  waitForThreadTurnStarted,
  type ScriptedEchoRequestRecord,
} from "./test/runtime-test-harness.js";

function recordedMethods(record: ScriptedEchoRequestRecord): string[] {
  return record.read().map((request) => request.method);
}

describe("createAgentRuntime lifecycle", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bb-runtime-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("thread setup and configuration", () => {
    it("starts a thread and receives a providerThreadId", async () => {
      const events: ThreadEvent[] = [];
      const runtime = createScriptedEchoRuntime({
        runtime: {
          workspacePath: tmpDir,
          onEvent: (e) => events.push(e),
        },
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

    it("allows thread/start to outlive the generic JSON-RPC timeout", async () => {
      const realSetTimeout = setTimeout;
      const sleepReal = (ms: number): Promise<void> =>
        new Promise((resolve) => {
          realSetTimeout(resolve, ms);
        });
      vi.useFakeTimers();
      const record = createScriptedEchoRequestRecord();
      const runtime = createScriptedEchoRuntime({
        runtime: {
          workspacePath: tmpDir,
          env: record.env,
          onEvent: () => undefined,
        },
        launch: { scripted: { startDelayMs: 1_500 } },
      });
      let settled = false;
      const startOutcome = runtime
        .startThread({
          environmentId: "env-1",
          threadId: "t1",
          projectId: "p1",
          providerId: "fake",
          options: fullRuntimeOptions,
        })
        .then(
          (result) => ({ status: "resolved" as const, result }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        );
      void startOutcome.then(() => {
        settled = true;
      });

      try {
        for (
          let attempt = 0;
          record.last("thread/start") === undefined;
          attempt += 1
        ) {
          if (attempt >= 1_000) {
            throw new Error("The bridge never received thread/start");
          }
          await sleepReal(10);
        }
        await vi.advanceTimersByTimeAsync(30_001);
        expect(settled).toBe(false);

        expect(await startOutcome).toEqual({
          status: "resolved",
          result: { providerThreadId: "prov-1" },
        });
      } finally {
        vi.useRealTimers();
        await runtime.shutdown();
      }
    });

    it("fails session construction when the thread/start result carries no providerThreadId", async () => {
      const record = createScriptedEchoRequestRecord();
      const runtime = createScriptedEchoRuntime({
        runtime: {
          workspacePath: tmpDir,
          env: record.env,
          onEvent: () => {},
        },
        launch: { scripted: { answerStartWithoutIdentity: true } },
      });

      try {
        await expect(
          runtime.startThread({
            environmentId: "env-1",
            threadId: "t1",
            projectId: "p1",
            providerId: "fake",
            options: fullRuntimeOptions,
          }),
        ).rejects.toThrow(
          /Invalid JSON-RPC result for thread\/start: providerThreadId/,
        );
        expect(runtime.hasThread("t1")).toBe(false);
        expect(runtime.getProviderSession("t1")).toBeNull();
        expect(record.last("thread/stop")?.params).toMatchObject({
          threadId: "t1",
          intent: "release",
        });
      } finally {
        await runtime.shutdown();
      }
    });

    it("fails session construction when the thread/resume result carries no providerThreadId", async () => {
      const record = createScriptedEchoRequestRecord();
      const runtime = createScriptedEchoRuntime({
        runtime: {
          workspacePath: tmpDir,
          env: record.env,
          onEvent: () => {},
        },
        launch: { scripted: { answerStartWithoutIdentity: true } },
      });

      try {
        await expect(
          runtime.resumeThread({
            environmentId: "env-1",
            threadId: "t1",
            projectId: "p1",
            providerThreadId: "old-prov-123",
            providerId: "fake",
            options: fullRuntimeOptions,
          }),
        ).rejects.toThrow(
          /Invalid JSON-RPC result for thread\/resume: providerThreadId/,
        );
        expect(runtime.hasThread("t1")).toBe(false);
        expect(runtime.getProviderSession("t1")).toBeNull();
        expect(record.last("thread/stop")?.params).toMatchObject({
          threadId: "t1",
          providerThreadId: "old-prov-123",
          intent: "release",
        });
      } finally {
        await runtime.shutdown();
      }
    });

    it("forgets a thread whose thread/resume request was rejected", async () => {
      const record = createScriptedEchoRequestRecord();
      const runtime = createScriptedEchoRuntime({
        runtime: {
          workspacePath: tmpDir,
          env: record.env,
          onEvent: () => {},
        },
        launch: {
          scripted: {
            failMethods: [
              { method: "thread/resume", message: "resume refused", times: 1 },
            ],
          },
        },
      });
      const resume = {
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerThreadId: "old-prov-123",
        providerId: "fake",
        options: fullRuntimeOptions,
      };

      try {
        await expect(runtime.resumeThread(resume)).rejects.toThrow(
          "resume refused",
        );
        expect(runtime.hasThread("t1")).toBe(false);
        expect(runtime.getProviderSession("t1")).toBeNull();
        expect(record.last("thread/stop")?.params).toMatchObject({
          threadId: "t1",
          providerThreadId: "old-prov-123",
          intent: "release",
        });

        await expect(
          runtime.resumeThread({
            ...resume,
            bridgeLaunch: createScriptedEchoLaunch({
              digest: "resume-success",
            }),
          }),
        ).resolves.toEqual({ providerThreadId: "old-prov-123" });
        expect(runtime.hasThread("t1")).toBe(true);
      } finally {
        await runtime.shutdown();
      }
    });

    it("merges runtime shell env with per-thread context on start", async () => {
      const record = createScriptedEchoRequestRecord();
      const events: ThreadEvent[] = [];
      const threadStorageRootPath = join(tmpDir, "thread-storage");
      const contributedEnv = [
        {
          name: "PATH",
          value: "/plugin/bin",
          source: { plugin: "env-test" },
          reason: "Use the plugin toolchain",
          secret: false,
        },
        {
          name: "AUTH_PROXY_URL",
          value: { serverPath: "/plugins/env-test/auth" },
          source: { plugin: "env-test" },
          reason: "Use the authenticated server proxy",
          secret: true,
        },
      ] as const;
      const runtime = createScriptedEchoRuntime({
        runtime: {
          workspacePath: tmpDir,
          threadStorageRootPath,
          env: record.env,
          shellEnv: {
            PATH: "/tmp/bb-bin:/usr/bin",
            BB_HOST_DAEMON_PORT: "3002",
            BB_PROJECT_ID: "wrong-project",
            BB_SERVER_URL: "http://127.0.0.1:3334",
            BB_THREAD_ID: "wrong-thread",
          },
          onEvent: (event) => events.push(event),
        },
      });

      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        contributedEnv,
        options: fullRuntimeOptions,
      });

      const threadStart = record.last("thread/start");
      expect(threadStart).toBeDefined();
      expect(threadStart?.params).toEqual(
        expect.objectContaining({
          threadId: "t1",
          cwd: tmpDir,
          options: expect.objectContaining({
            envVars: {
              PATH: "/plugin/bin",
              AUTH_PROXY_URL: "http://127.0.0.1:3334/plugins/env-test/auth",
              BB_HOST_DAEMON_PORT: "3002",
              BB_PROJECT_ID: "p1",
              BB_SERVER_URL: "http://127.0.0.1:3334",
              BB_THREAD_STORAGE: join(threadStorageRootPath, "t1"),
              BB_THREAD_ID: "t1",
              BB_ENVIRONMENT_ID: "env-1",
            },
          }),
        }),
      );
      expect(
        events.find((event) => event.type === "provider.env-resolved"),
      ).toMatchObject({
        entries: expect.arrayContaining([
          {
            name: "PATH",
            source: { plugin: "env-test" },
            value: "/plugin/bin",
            reason: "Use the plugin toolchain",
          },
          {
            name: "AUTH_PROXY_URL",
            source: { plugin: "env-test" },
            value: { masked: true },
            reason: "Use the authenticated server proxy",
          },
        ]),
      });
      expect(JSON.stringify(events)).not.toContain("/plugins/env-test/auth");

      await runtime.runTurn({
        clientRequestId: "creq_222222224c",
        threadId: "t1",
        input: [promptTextInput({ text: "follow up" })],
        contributedEnv,
        options: fullRuntimeOptions,
      });
      expect(
        events.filter((event) => event.type === "provider.env-resolved"),
      ).toHaveLength(1);

      await runtime.shutdown();
    });

    it("drops unresolved server paths without preventing thread start", async () => {
      const record = createScriptedEchoRequestRecord();
      const events: ThreadEvent[] = [];
      const runtime = createScriptedEchoRuntime({
        runtime: {
          workspacePath: tmpDir,
          env: record.env,
          shellEnv: { PATH: "/usr/bin" },
          onEvent: (event) => events.push(event),
        },
      });

      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        contributedEnv: [
          {
            name: "AUTH_PROXY_URL",
            value: { serverPath: "/plugins/env-test/auth" },
            source: { plugin: "env-test" },
            reason: "Use the authenticated server proxy",
            secret: true,
          },
        ],
        options: fullRuntimeOptions,
      });

      const threadStart = record.last("thread/start");
      expect(threadStart).toBeDefined();
      expect(threadStart?.params).toEqual(
        expect.objectContaining({
          options: expect.objectContaining({
            envVars: expect.not.objectContaining({
              AUTH_PROXY_URL: expect.anything(),
            }),
          }),
        }),
      );
      expect(
        events.find((event) => event.type === "provider.env-resolved"),
      ).toMatchObject({
        entries: expect.arrayContaining([
          {
            name: "AUTH_PROXY_URL",
            source: { plugin: "env-test" },
            value: { masked: true },
            reason:
              "Use the authenticated server proxy (dropped: no BB_SERVER_URL)",
          },
        ]),
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "provider/warning",
          category: "config",
          summary:
            'Dropped environment variable "AUTH_PROXY_URL" from plugin "env-test".',
        }),
      );

      await runtime.shutdown();
    });

    it("does not configure provider skills unless skill roots are supplied", async () => {
      const record = createScriptedEchoRequestRecord();
      const runtime = createScriptedEchoRuntime({
        runtime: {
          workspacePath: tmpDir,
          env: record.env,
          onEvent: () => undefined,
        },
      });

      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: fullRuntimeOptions,
      });

      expect(recordedMethods(record)).toContain("thread/start");
      expect(recordedMethods(record)).not.toContain("skills/configure");

      await runtime.shutdown();
    });

    it("configures provider skills from runtime skill roots before thread start", async () => {
      const record = createScriptedEchoRequestRecord();
      const skillRootPath = join(tmpDir, "skill-root");
      const runtime = createScriptedEchoRuntime({
        runtime: {
          workspacePath: tmpDir,
          env: record.env,
          skillRoots: [
            {
              id: "bb-cli",
              path: skillRootPath,
              skills: [{ name: "bb-cli", description: "Use the bb CLI." }],
            },
          ],
          onEvent: () => undefined,
        },
      });

      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "codex",
        options: fullRuntimeOptions,
      });

      expect(record.last("skills/configure")?.params).toEqual({
        roots: [
          {
            id: "bb-cli",
            path: skillRootPath,
            skills: [{ name: "bb-cli", description: "Use the bb CLI." }],
          },
        ],
      });
      const methods = recordedMethods(record);
      expect(methods.indexOf("skills/configure")).toBeGreaterThan(-1);
      expect(methods.indexOf("thread/start")).toBeGreaterThan(-1);
      expect(methods.indexOf("skills/configure")).toBeLessThan(
        methods.indexOf("thread/start"),
      );

      await runtime.shutdown();
    });

    it("configures the same generic roots for every provider", async () => {
      const record = createScriptedEchoRequestRecord();
      const skillRootPath = join(tmpDir, "skill-root");
      const runtime = createScriptedEchoRuntime({
        runtime: {
          workspacePath: tmpDir,
          env: record.env,
          skillRoots: [{ id: "bb-cli", path: skillRootPath, skills: [] }],
          onEvent: () => undefined,
        },
      });

      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: fullRuntimeOptions,
      });

      expect(record.last("skills/configure")?.params).toEqual({
        roots: [{ id: "bb-cli", path: skillRootPath, skills: [] }],
      });

      await runtime.shutdown();
    });

    it("carries changed settings on the next turn without rebuilding the session", async () => {
      const record = createScriptedEchoRequestRecord();
      const runtime = createScriptedEchoRuntime({
        runtime: {
          workspacePath: tmpDir,
          env: record.env,
          onEvent: () => undefined,
        },
      });

      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        instructions: "Initial instructions",
        options: {
          ...fullRuntimeOptions,
          permissionMode: "auto",
          permissionScope: "workspace",
          approvalReviewer: "automatic",
          permissionEscalation: "ask",
          providerOptions: {
            memoryEnabled: true,
            providerSubagentsEnabled: true,
          },
        },
      });

      await runtime.runTurn({
        clientRequestId: "creq_222222224h",
        threadId: "t1",
        input: [promptTextInput({ text: "follow up" })],
        instructions: "Initial instructions",
        options: {
          ...fullRuntimeOptions,
          model: "test-model-2",
          permissionMode: "auto",
          permissionScope: "workspace",
          approvalReviewer: "automatic",
          permissionEscalation: "deny",
          reasoningLevel: "high",
          providerOptions: {
            memoryEnabled: false,
            providerSubagentsEnabled: false,
            workflowsEnabled: true,
          },
        },
      });

      expect(recordedMethods(record)).not.toContain("thread/resume");
      expect(record.last("thread/start")?.params).toMatchObject({
        options: {
          model: "test-model",
          permissionEscalation: "ask",
          reasoningLevel: "medium",
          providerOptions: {
            memoryEnabled: true,
            providerSubagentsEnabled: true,
          },
        },
      });
      expect(record.last("turn/start")?.params).toMatchObject({
        clientRequestId: "creq_222222224h",
        options: {
          model: "test-model-2",
          permissionEscalation: "deny",
          reasoningLevel: "high",
          serviceTier: "default",
          providerOptions: {
            memoryEnabled: false,
            providerSubagentsEnabled: false,
            workflowsEnabled: true,
          },
        },
      });

      await runtime.shutdown();
    });

    it("passes the workspace cwd when resuming a thread", async () => {
      const record = createScriptedEchoRequestRecord();
      const runtime = createScriptedEchoRuntime({
        runtime: {
          workspacePath: tmpDir,
          env: record.env,
          shellEnv: {
            PATH: "/tmp/bb-bin:/usr/bin",
            BB_HOST_DAEMON_PORT: "3002",
            BB_SERVER_URL: "http://127.0.0.1:3334",
          },
          onEvent: () => undefined,
        },
      });

      await runtime.resumeThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerThreadId: "prov-1",
        providerId: "fake",
        options: fullRuntimeOptions,
      });

      const resume = record.last("thread/resume");
      expect(resume).toBeDefined();
      expect(resume?.params).toEqual(
        expect.objectContaining({
          threadId: "t1",
          providerThreadId: "prov-1",
          cwd: tmpDir,
          options: expect.objectContaining({
            envVars: {
              PATH: "/tmp/bb-bin:/usr/bin",
              BB_HOST_DAEMON_PORT: "3002",
              BB_SERVER_URL: "http://127.0.0.1:3334",
              BB_PROJECT_ID: "p1",
              BB_THREAD_ID: "t1",
              BB_ENVIRONMENT_ID: "env-1",
            },
          }),
        }),
      );

      await runtime.shutdown();
    });

    it("passes permission mode through to session and turn commands", async () => {
      const record = createScriptedEchoRequestRecord();
      const runtime = createScriptedEchoRuntime({
        runtime: {
          workspacePath: tmpDir,
          env: record.env,
          onEvent: () => undefined,
        },
      });

      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: {
          ...fullRuntimeOptions,
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "ask",
        },
      });

      await runtime.runTurn({
        clientRequestId: "creq_222222223i",
        threadId: "t1",
        input: [promptTextInput({ text: "follow up" })],
        options: fullRuntimeOptions,
      });

      expect(record.last("thread/start")?.params).toMatchObject({
        options: {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "ask",
        },
      });
      expect(recordedMethods(record)).not.toContain("thread/resume");
      expect(record.last("turn/start")?.params).toMatchObject({
        options: { permissionMode: "full" },
      });

      await runtime.shutdown();
    });

    it("carries a changed permission policy on the turn that follows it", async () => {
      const record = createScriptedEchoRequestRecord();
      const runtime = createScriptedEchoRuntime({
        runtime: {
          workspacePath: tmpDir,
          env: record.env,
          onEvent: () => undefined,
        },
      });

      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: {
          ...fullRuntimeOptions,
          permissionEscalation: "ask",
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
        },
      });

      await runtime.runTurn({
        clientRequestId: "creq_222222223j",
        threadId: "t1",
        input: [promptTextInput({ text: "follow up" })],
        options: {
          ...fullRuntimeOptions,
          permissionEscalation: "deny",
          permissionMode: "auto",
          permissionScope: "workspace",
          approvalReviewer: "automatic",
        },
      });

      expect(recordedMethods(record)).not.toContain("thread/resume");
      expect(record.last("turn/start")?.params).toMatchObject({
        threadId: "t1",
        clientRequestId: "creq_222222223j",
        options: {
          permissionMode: "auto",
          permissionScope: "workspace",
          approvalReviewer: "automatic",
          permissionEscalation: "deny",
        },
      });

      await runtime.shutdown();
    });
  });

  describe("turn execution and thread commands", () => {
    it("runs a turn and receives turn/started + turn/completed events", async () => {
      const events: ThreadEvent[] = [];
      const runtime = createScriptedEchoRuntime({
        runtime: {
          workspacePath: tmpDir,
          onEvent: (e) => events.push(e),
        },
      });

      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: fullRuntimeOptions,
      });
      await runtime.runTurn({
        clientRequestId: "creq_222222223k",
        threadId: "t1",
        input: [promptTextInput({ text: "hello" })],
        options: fullRuntimeOptions,
      });
      await waitForThreadTurnCompleted({
        events,
        runtime,
        threadId: "t1",
      });

      expect(events.some((e) => e.type === "turn/started")).toBe(true);
      expect(events.some((e) => e.type === "turn/completed")).toBe(true);
      await runtime.shutdown();
    });

    it("drops replayed completed turn starts before emitting to consumers", async () => {
      const events: ThreadEvent[] = [];
      const stderr: string[] = [];
      const runtime = createScriptedEchoRuntime({
        runtime: {
          workspacePath: tmpDir,
          onEvent: (event) => events.push(event),
          onStderr: (line) => stderr.push(line),
        },
        launch: {
          pluginId: "provider-replayed-turn",
          digest: "replayed-turn",
          modulePath: fileURLToPath(
            new URL("./test/bridges/replayed-turn-bridge.ts", import.meta.url),
          ),
        },
      });

      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: fullRuntimeOptions,
      });
      await runtime.runTurn({
        clientRequestId: "creq_222222223m",
        threadId: "t1",
        input: [promptTextInput({ text: "hello" })],
        options: fullRuntimeOptions,
      });
      await waitForThreadTurnCompleted({
        events,
        runtime,
        threadId: "t1",
      });
      await wait(50);

      expect(
        events.filter((event) => event.type === "turn/started"),
      ).toHaveLength(1);
      expect(stderr.some((line) => line.includes("turn/starts-once"))).toBe(
        true,
      );
      expect(runtime.getActiveTurnId("t1")).toBeNull();
      expect(events.some((event) => event.type === "item/completed")).toBe(
        true,
      );
      await runtime.shutdown();
    });

    it("runs the initial turn when startThread includes input", async () => {
      const events: ThreadEvent[] = [];
      const runtime = createScriptedEchoRuntime({
        runtime: {
          workspacePath: tmpDir,
          onEvent: (e) => events.push(e),
        },
      });

      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        clientRequestId: "creq_222222223n",
        input: [promptTextInput({ text: "hello from start" })],
        options: fullRuntimeOptions,
      });
      await waitForThreadTurnCompleted({
        events,
        runtime,
        threadId: "t1",
      });

      expect(events.some((e) => e.type === "thread/identity")).toBe(true);
      expect(events.some((e) => e.type === "turn/started")).toBe(true);
      expect(events.some((e) => e.type === "turn/completed")).toBe(true);
      await runtime.shutdown();
    });

    it("does not start a turn until input is sent separately", async () => {
      const events: ThreadEvent[] = [];
      const runtime = createScriptedEchoRuntime({
        runtime: {
          workspacePath: tmpDir,
          onEvent: (event) => events.push(event),
        },
      });

      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: fullRuntimeOptions,
      });
      await wait(100);

      expect(events.some((event) => event.type === "thread/identity")).toBe(
        true,
      );
      expect(events.some((event) => event.type === "turn/started")).toBe(false);
      expect(events.some((event) => event.type === "turn/completed")).toBe(
        false,
      );

      await runtime.runTurn({
        clientRequestId: "creq_222222223n",
        threadId: "t1",
        input: [promptTextInput({ text: "hello after start" })],
        options: fullRuntimeOptions,
      });
      await waitForThreadTurnCompleted({
        events,
        runtime,
        threadId: "t1",
      });

      expect(events.some((event) => event.type === "turn/started")).toBe(true);
      expect(events.some((event) => event.type === "turn/completed")).toBe(
        true,
      );
      await runtime.shutdown();
    });

    it("resumes a thread", async () => {
      const events: ThreadEvent[] = [];
      const runtime = createScriptedEchoRuntime({
        runtime: {
          workspacePath: tmpDir,
          onEvent: (e) => events.push(e),
        },
      });

      const { providerThreadId } = await runtime.resumeThread({
        environmentId: "env-1",
        threadId: "t1",
        providerThreadId: "old-prov-123",
        providerId: "fake",
        options: fullRuntimeOptions,
      });

      expect(providerThreadId).toBe("old-prov-123");

      await runtime.runTurn({
        clientRequestId: "creq_222222223p",
        threadId: "t1",
        input: [promptTextInput({ text: "after resume" })],
        options: fullRuntimeOptions,
      });
      await waitForThreadTurnCompleted({
        events,
        runtime,
        threadId: "t1",
      });
      expect(events.some((e) => e.type === "turn/completed")).toBe(true);
      await runtime.shutdown();
    });

    it("preserves active turn state when the stop request fails", async () => {
      const events: ThreadEvent[] = [];
      const record = createScriptedEchoRequestRecord();
      const runtime = createScriptedEchoRuntime({
        runtime: {
          workspacePath: tmpDir,
          env: record.env,
          onEvent: (event) => events.push(event),
        },
        launch: {
          scripted: {
            failMethods: [
              { method: "thread/stop", message: "stop command failed" },
            ],
          },
        },
      });

      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: fullRuntimeOptions,
      });
      await runtime.runTurn({
        clientRequestId: "creq_222222223q",
        threadId: "t1",
        input: [promptTextInput({ text: "delay:500" })],
        options: fullRuntimeOptions,
      });
      const { turnId } = await waitForThreadTurnStarted({
        events,
        providerId: "fake",
        runtime,
        threadId: "t1",
      });

      await expect(runtime.stopThread({ threadId: "t1" })).rejects.toThrow(
        /stop command failed/,
      );
      expect(runtime.getActiveTurnId("t1")).toBe(turnId);

      await expect(
        runtime.steerTurn({
          clientRequestId: "creq_222222223r",
          threadId: "t1",
          expectedTurnId: turnId,
          input: [promptTextInput({ text: "still active" })],
          options: fullRuntimeOptions,
        }),
      ).resolves.toEqual({ status: "steered" });
      expect(record.last("turn/steer")?.params).toMatchObject({
        threadId: "t1",
        clientRequestId: "creq_222222223r",
      });

      await runtime.shutdown();
    });

    it("retires the provider after thread stop and starts it for resume", async () => {
      const events: ThreadEvent[] = [];
      const runtime = createScriptedEchoRuntime({
        runtime: {
          workspacePath: tmpDir,
          onEvent: (event) => events.push(event),
        },
      });

      const startResult = await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: fullRuntimeOptions,
      });
      expect(runtime.listRunningProviders()).toEqual(["fake"]);
      expect(runtime.hasThread("t1")).toBe(true);
      expect(runtime.getProviderSession("t1")).toEqual({
        providerId: "fake",
        providerThreadId: startResult.providerThreadId,
      });

      await runtime.stopThread({ threadId: "t1" });
      expect(runtime.listRunningProviders()).toEqual([]);
      expect(runtime.hasThread("t1")).toBe(false);
      expect(runtime.getProviderSession("t1")).toBeNull();
      expect(runtime.getActiveTurnId("t1")).toBeNull();

      await runtime.resumeThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerThreadId: startResult.providerThreadId,
        providerId: "fake",
        options: fullRuntimeOptions,
      });
      await runtime.runTurn({
        clientRequestId: "creq_222222223s",
        threadId: "t1",
        input: [promptTextInput({ text: "after stop" })],
        options: fullRuntimeOptions,
      });
      await waitForThreadAgentMessageText({
        events,
        providerId: "fake",
        runtime,
        text: "after stop",
        threadId: "t1",
      });

      await runtime.shutdown();
    });

    it("resolves waitForActiveTurn and rejects a competing start while active", async () => {
      const events: ThreadEvent[] = [];
      const record = createScriptedEchoRequestRecord();
      const runtime = createScriptedEchoRuntime({
        runtime: {
          workspacePath: tmpDir,
          env: record.env,
          onEvent: (event) => events.push(event),
        },
      });

      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: fullRuntimeOptions,
      });
      expect(runtime.getActiveTurnId("t1")).toBeNull();

      const pendingTurnId = runtime.waitForActiveTurn("t1", {
        timeoutMs: 5_000,
      });
      await runtime.runTurn({
        clientRequestId: "creq_222222223t",
        threadId: "t1",
        input: [promptTextInput({ text: "delay:500" })],
        options: fullRuntimeOptions,
      });
      const { turnId } = await waitForThreadTurnStarted({
        events,
        providerId: "fake",
        runtime,
        threadId: "t1",
      });

      await expect(pendingTurnId).resolves.toBe(turnId);
      expect(runtime.getActiveTurnId("t1")).toBe(turnId);
      expect(runtime.getLiveThreadIds()).toEqual(["t1"]);
      await expect(
        runtime.runTurn({
          clientRequestId: "creq_222222224a",
          threadId: "t1",
          input: [promptTextInput({ text: "competing active turn" })],
          options: fullRuntimeOptions,
        }),
      ).rejects.toThrow(/active or starting/);
      expect(
        recordedMethods(record).filter((method) => method === "turn/start"),
      ).toHaveLength(1);
      await runtime.shutdown();
    });

    it("reports pending work and rejects a competing start before the first event", async () => {
      const record = createScriptedEchoRequestRecord();
      const runtime = createScriptedEchoRuntime({
        runtime: {
          workspacePath: tmpDir,
          env: record.env,
          onEvent: () => {},
        },
        launch: { scripted: { swallowTurnStart: true } },
      });

      try {
        await runtime.startThread({
          environmentId: "env-1",
          threadId: "t1",
          projectId: "p1",
          providerId: "fake",
          options: fullRuntimeOptions,
        });
        await runtime.runTurn({
          clientRequestId: "creq_222222223u",
          threadId: "t1",
          input: [promptTextInput({ text: "wait for first event" })],
          options: fullRuntimeOptions,
        });

        expect(runtime.getActiveTurnId("t1")).toBeNull();
        expect(runtime.getLiveThreadIds()).toEqual(["t1"]);
        await expect(
          runtime.runTurn({
            clientRequestId: "creq_222222224b",
            threadId: "t1",
            input: [promptTextInput({ text: "competing pending turn" })],
            options: fullRuntimeOptions,
          }),
        ).rejects.toThrow(/active or starting/);
        expect(
          recordedMethods(record).filter((method) => method === "turn/start"),
        ).toHaveLength(1);
      } finally {
        await runtime.shutdown();
      }
    });

    it("resolves pending waitForActiveTurn waiters with null when the provider crashes", async () => {
      const runtime = createScriptedEchoRuntime({
        runtime: {
          workspacePath: tmpDir,
          onEvent: () => {},
        },
        launch: { scripted: { exitAfter: "thread/start" } },
      });

      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: fullRuntimeOptions,
      });
      const pendingTurnId = runtime.waitForActiveTurn("t1", {
        timeoutMs: 30_000,
      });

      await expect(pendingTurnId).resolves.toBeNull();
      expect(runtime.hasThread("t1")).toBe(false);
      expect(runtime.getProviderSession("t1")).toBeNull();
      await runtime.shutdown();
    });

    it("carries changed settings and instructions on later run turns", async () => {
      const record = createScriptedEchoRequestRecord();
      const runtime = createScriptedEchoRuntime({
        runtime: {
          workspacePath: tmpDir,
          env: record.env,
          onEvent: () => {},
        },
      });

      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: { ...fullRuntimeOptions, model: "fake-model" },
        instructions: "Initial instructions",
      });
      const methodsBeforeTurn = recordedMethods(record).length;

      await runtime.runTurn({
        clientRequestId: "creq_222222223v",
        threadId: "t1",
        input: [promptTextInput({ text: "use a different setup" })],
        options: { ...fullRuntimeOptions, model: "fake-model-2" },
        instructions: "Updated instructions",
      });

      expect(recordedMethods(record).slice(methodsBeforeTurn)).toEqual([
        "turn/start",
      ]);
      expect(record.last("turn/start")?.params).toMatchObject({
        clientRequestId: "creq_222222223v",
        options: {
          instructions: "Updated instructions",
          model: "fake-model-2",
        },
      });
      await runtime.shutdown();
    });

    it("does not resume the thread when only instructions change", async () => {
      const record = createScriptedEchoRequestRecord();
      const runtime = createScriptedEchoRuntime({
        runtime: {
          workspacePath: tmpDir,
          env: record.env,
          onEvent: () => {},
        },
      });

      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: fullRuntimeOptions,
        instructions: "Initial instructions",
      });
      const methodsBeforeTurn = recordedMethods(record).length;

      await runtime.runTurn({
        clientRequestId: "creq_222222223y",
        threadId: "t1",
        input: [promptTextInput({ text: "follow up" })],
        options: fullRuntimeOptions,
        instructions: "Updated instructions",
      });

      expect(recordedMethods(record).slice(methodsBeforeTurn)).toEqual([
        "turn/start",
      ]);
      await runtime.shutdown();
    });

    it("carries changed settings and instructions on steer turns", async () => {
      const record = createScriptedEchoRequestRecord();
      const events: ThreadEvent[] = [];
      const runtime = createScriptedEchoRuntime({
        runtime: {
          workspacePath: tmpDir,
          env: record.env,
          onEvent: (event) => events.push(event),
        },
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
        clientRequestId: "creq_222222223w",
        threadId: "t1",
        input: [promptTextInput({ text: "delay:500" })],
        options: { ...fullRuntimeOptions, model: "fake-model" },
        instructions: "Initial instructions",
      });
      const { turnId } = await waitForThreadTurnStarted({
        events,
        providerId: "fake",
        runtime,
        threadId: "t1",
      });
      const methodsBeforeSteer = recordedMethods(record).length;

      await runtime.steerTurn({
        clientRequestId: "creq_222222223x",
        threadId: "t1",
        expectedTurnId: turnId,
        input: [promptTextInput({ text: "apply a new setup now" })],
        options: { ...fullRuntimeOptions, model: "fake-model-2" },
        instructions: "Updated instructions",
      });

      expect(recordedMethods(record).slice(methodsBeforeSteer)).toEqual([
        "turn/steer",
      ]);
      expect(record.last("turn/steer")?.params).toMatchObject({
        threadId: "t1",
        expectedTurnId: "turn-1",
        clientRequestId: "creq_222222223x",
        options: {
          instructions: "Updated instructions",
          model: "fake-model-2",
        },
      });
      expect(turnId).not.toBe("turn-1");
      await runtime.shutdown();
    });
  });

  describe("models", () => {
    it("lists models", async () => {
      const runtime = createScriptedEchoRuntime({
        runtime: {
          workspacePath: tmpDir,
          onEvent: () => {},
        },
      });

      const { models } = await runtime.listModels({ providerId: "fake" });
      expect(models).toHaveLength(1);
      expect(models[0]?.id).toBe("fake-model");
      expect(models[0]?.isDefault).toBe(true);
      await runtime.shutdown();
    });
  });

  describe("errors", () => {
    it("rejects runTurn for unknown thread", async () => {
      const runtime = createScriptedEchoRuntime({
        runtime: {
          workspacePath: tmpDir,
          onEvent: () => {},
        },
      });

      await expect(
        runtime.runTurn({
          clientRequestId: "creq_222222223y",
          threadId: "nonexistent",
          input: [promptTextInput({ text: "hi" })],
          options: fullRuntimeOptions,
        }),
      ).rejects.toThrow('No provider associated with thread "nonexistent"');
      await runtime.shutdown();
    });
  });
});

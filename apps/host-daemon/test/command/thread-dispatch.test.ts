import fs from "node:fs/promises";
import path from "node:path";
import type { AgentRuntimeOptions } from "@bb/agent-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchCommand } from "../../src/command-dispatch.js";
import { RuntimeManager } from "../../src/runtime-manager.js";
import {
  cleanupTempDirs,
  createFakeRuntime,
  createFakeWorkspace,
  createHarness,
  makeTempDir,
} from "./dispatch-helpers.js";

afterEach(cleanupTempDirs);

describe("thread command dispatch", () => {
  it("covers thread lifecycle commands", async () => {
    const harness = createHarness();

    const startResult = await dispatchCommand(
      {
        type: "thread.start",
        environmentId: "env-1",
        threadId: "thread-1",
        workspaceContext: { workspacePath: "/tmp/env-1", workspaceProvisionType: "unmanaged" },
        projectId: "project-1",
        providerId: "fake",
        eventSequence: 1,
        input: [{ type: "text", text: "hello" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        instructions: "Be a helpful coding agent.",
        dynamicTools: [],
        instructionMode: "append",
      },
      harness.dispatchOptions(),
    );
    const renameResult = await dispatchCommand(
      {
        type: "thread.rename",
        environmentId: "env-1",
        threadId: "thread-1",
        title: "Renamed",
      },
      harness.dispatchOptions(),
    );
    const stopResult = await dispatchCommand(
      {
        type: "thread.stop",
        environmentId: "env-1",
        threadId: "thread-1",
      },
      harness.dispatchOptions(),
    );

    expect(startResult).toEqual({ providerThreadId: "provider-thread-1" });
    expect(harness.runtimeState.startedEnvironmentId).toBe("env-1");
    expect(renameResult).toEqual({});
    expect(stopResult).toEqual({});
    expect(harness.runtimeState.startedThreadId).toBe("thread-1");
    expect(harness.runtimeState.startedInstructions).toBe("Be a helpful coding agent.");
    expect(harness.runtimeState.renamedTitle).toBe("Renamed");
    expect(harness.runtimeState.stoppedThreadId).toBe("thread-1");
    expect(harness.manager.listActiveThreads()).toEqual([]);
  });

  it("covers turn.run and turn.steer", async () => {
    const harness = createHarness();
    await harness.manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    harness.manager.markThreadActive("env-1", "thread-1", "provider-1");

    const runResult = await dispatchCommand(
      {
        type: "turn.run",
        environmentId: "env-1",
        threadId: "thread-1",
        eventSequence: 3,
        input: [{ type: "text", text: "hello" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        resumeContext: {
          workspaceContext: { workspacePath: "/tmp/env-1", workspaceProvisionType: "unmanaged" },
          projectId: "project-1",
          providerId: "fake",
          providerThreadId: "provider-1",
          instructions: "Be a helpful coding agent.",
          dynamicTools: [],
          instructionMode: "append",
        },
      },
      harness.dispatchOptions(),
    );
    const steerResult = await dispatchCommand(
      {
        type: "turn.steer",
        environmentId: "env-1",
        threadId: "thread-1",
        eventSequence: 4,
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "adjust" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        resumeContext: {
          workspaceContext: { workspacePath: "/tmp/env-1", workspaceProvisionType: "unmanaged" },
          projectId: "project-1",
          providerId: "fake",
          providerThreadId: "provider-1",
          instructions: "Be a helpful coding agent.",
          dynamicTools: [],
          instructionMode: "append",
        },
      },
      harness.dispatchOptions(),
    );

    expect(runResult).toEqual({});
    expect(steerResult).toEqual({});
    expect(harness.runtimeState.ranTurnText).toBe("hello");
    expect(harness.runtimeState.steeredTurnId).toBe("turn-1");
    expect(harness.runtimeState.steeredTurnInstructions).toBe("Be a helpful coding agent.");
  });

  it("marks a known thread active for the next turn after runtime completion made it idle", async () => {
    const { runtime, state } = createFakeRuntime();
    const { workspace } = createFakeWorkspace("/tmp/env-1");
    let runtimeOptions: AgentRuntimeOptions | undefined;
    let completedTurns = 0;
    runtime.runTurn = async (args) => {
      state.ranTurnText = args.input[0]?.text;
      completedTurns += 1;
      if (completedTurns === 1) {
        runtimeOptions?.onEvent?.({
          type: "turn/completed",
          threadId: "thread-1",
          providerThreadId: "provider-1",
          turnId: `turn-${completedTurns}`,
          status: "completed",
        });
      }
    };
    const manager = new RuntimeManager({
      provisionWorkspace: async () => workspace,
      createRuntime: (options) => {
        runtimeOptions = options;
        return runtime;
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    manager.markThreadActive("env-1", "thread-1", "provider-1");

    await dispatchCommand(
      {
        type: "turn.run",
        environmentId: "env-1",
        threadId: "thread-1",
        eventSequence: 4,
        input: [{ type: "text", text: "finish this" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        resumeContext: {
          workspaceContext: { workspacePath: "/tmp/env-1", workspaceProvisionType: "unmanaged" },
          projectId: "project-1",
          providerId: "fake",
          providerThreadId: "provider-1",
          instructions: "Be a helpful coding agent.",
          dynamicTools: [],
          instructionMode: "append",
        },
      },
      { runtimeManager: manager, threadStorageRootPath: "/tmp/bb-test-thread-storage" },
    );

    expect(manager.listActiveThreads()).toEqual([]);

    const result = await dispatchCommand(
      {
        type: "turn.run",
        environmentId: "env-1",
        threadId: "thread-1",
        eventSequence: 5,
        input: [{ type: "text", text: "resume work" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        resumeContext: {
          workspaceContext: { workspacePath: "/tmp/env-1", workspaceProvisionType: "unmanaged" },
          projectId: "project-1",
          providerId: "fake",
          providerThreadId: "provider-1",
          instructions: "Be a helpful coding agent.",
          dynamicTools: [],
          instructionMode: "append",
        },
      },
      { runtimeManager: manager, threadStorageRootPath: "/tmp/bb-test-thread-storage" },
    );

    expect(result).toEqual({});
    expect(state.ranTurnText).toBe("resume work");
    expect(manager.listActiveThreads()).toEqual([
      {
        threadId: "thread-1",
      },
    ]);
  });

  it("marks known idle threads active when dispatching turn.steer", async () => {
    const harness = createHarness();
    await harness.manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    harness.manager.markThreadActive("env-1", "thread-1", "provider-1");
    harness.manager.markThreadInactive("env-1", "thread-1");
    expect(harness.manager.listActiveThreads()).toEqual([]);

    const result = await dispatchCommand(
      {
        type: "turn.steer",
        environmentId: "env-1",
        threadId: "thread-1",
        eventSequence: 5,
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "adjust course" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        resumeContext: {
          workspaceContext: { workspacePath: "/tmp/env-1", workspaceProvisionType: "unmanaged" },
          projectId: "project-1",
          providerId: "fake",
          providerThreadId: "provider-1",
          instructions: "Be a helpful coding agent.",
          dynamicTools: [],
          instructionMode: "append",
        },
      },
      harness.dispatchOptions(),
    );

    expect(result).toEqual({});
    expect(harness.runtimeState.steeredTurnId).toBe("turn-1");
    expect(harness.manager.listActiveThreads()).toEqual([
      {
        threadId: "thread-1",
      },
    ]);
  });

  it("lazily resumes a missing thread runtime before turn.run", async () => {
    const harness = createHarness({ workspacePath: "/tmp/env-lazy" });

    const result = await dispatchCommand(
      {
        type: "turn.run",
        environmentId: "env-lazy",
        threadId: "thread-1",
        eventSequence: 1,
        input: [{ type: "text", text: "hello" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        resumeContext: {
          workspaceContext: { workspacePath: "/tmp/env-lazy", workspaceProvisionType: "unmanaged" },
          projectId: "project-1",
          providerId: "fake",
          providerThreadId: "provider-1",
          instructions: "Be a helpful coding agent.",
          dynamicTools: [],
          instructionMode: "append",
        },
      },
      harness.dispatchOptions(),
    );

    expect(result).toEqual({});
    expect(harness.provisions).toEqual([
      {
        workspaceProvisionType: "unmanaged",
        path: "/tmp/env-lazy",
      },
    ]);
    expect(harness.runtimeState.resumedEnvironmentId).toBe("env-lazy");
    expect(harness.runtimeState.resumedProviderThreadId).toBe("provider-1");
    expect(harness.runtimeState.ranTurnText).toBe("hello");
  });

  it("re-resolves thread runtime after provider exit clears known threads", async () => {
    const { runtime, state } = createFakeRuntime();
    const { workspace } = createFakeWorkspace("/tmp/env-exit");
    let onProcessExit:
      | ((info: {
          code: number | null;
          providerId: string;
          signal: string | null;
          threadIds: string[];
        }) => void)
      | undefined;
    const manager = new RuntimeManager({
      provisionWorkspace: async () => workspace,
      createRuntime: (options) => {
        onProcessExit = options.onProcessExit;
        return runtime;
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-exit",
      workspacePath: "/tmp/env-exit",
    });
    manager.markThreadActive("env-exit", "thread-1", "provider-1");
    onProcessExit?.({
      providerId: "fake",
      threadIds: ["thread-1"],
      code: 1,
      signal: null,
    });

    const result = await dispatchCommand(
      {
        type: "turn.run",
        environmentId: "env-exit",
        threadId: "thread-1",
        eventSequence: 2,
        input: [{ type: "text", text: "after exit" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        resumeContext: {
          workspaceContext: { workspacePath: "/tmp/env-exit", workspaceProvisionType: "unmanaged" },
          projectId: "project-1",
          providerId: "fake",
          providerThreadId: "provider-1",
          instructions: "Be a helpful coding agent.",
          dynamicTools: [],
          instructionMode: "append",
        },
      },
      { runtimeManager: manager, threadStorageRootPath: "/tmp/bb-test-thread-storage" },
    );

    expect(result).toEqual({});
    expect(state.resumedThreadId).toBe("thread-1");
    expect(state.ranTurnText).toBe("after exit");
  });

  it("covers provider.list", async () => {
    const harness = createHarness();

    const result = await dispatchCommand(
      {
        type: "provider.list",
      },
      {
        ...harness.dispatchOptions(),
        listProviders: () => [
          {
            id: "fake",
            displayName: "Fake Provider",
            capabilities: {
              supportsRename: false,
              supportsServiceTier: false,
              supportedPermissionModes: ["full", "workspace-write", "readonly"],
            },
            available: true,
          },
        ],
      },
    );

    expect(result).toEqual({
      providers: [
        {
          id: "fake",
          displayName: "Fake Provider",
          capabilities: {
            supportsRename: false,
            supportsServiceTier: false,
            supportedPermissionModes: ["full", "workspace-write", "readonly"],
          },
          available: true,
        },
      ],
    });
  });

  it("covers provider.list_models", async () => {
    const harness = createHarness();

    const result = await dispatchCommand(
      {
        type: "provider.list_models",
        providerId: "fake",
      },
      {
        ...harness.dispatchOptions(),
        listModels: async () => [
          {
            id: "model-1",
            model: "model-1",
            displayName: "Model 1",
            description: "Test model",
            supportedReasoningEfforts: [],
            defaultReasoningEffort: "medium",
            isDefault: true,
          },
        ],
      },
    );

    expect(result).toEqual({
      models: [
        {
          id: "model-1",
          model: "model-1",
          displayName: "Model 1",
          description: "Test model",
          supportedReasoningEfforts: [],
          defaultReasoningEffort: "medium",
          isDefault: true,
        },
      ],
    });
  });

  it("uses the server-provided manager runtime config", async () => {
    const threadStorage = await makeTempDir("bb-manager-runtime-");
    const harness = createHarness({ workspacePath: threadStorage });
    const managerInstructions = [
      "You are a manager for this project.",
      "Prefer concise user updates.",
      "Delegate implementation quickly.",
      "Manager Project",
      threadStorage,
    ].join("\n");

    await dispatchCommand(
      {
        type: "thread.start",
        environmentId: "env-manager",
        threadId: "thread-manager",
        workspaceContext: { workspacePath: threadStorage, workspaceProvisionType: "unmanaged" },
        projectId: "project-1",
        providerId: "fake",
        eventSequence: 1,
        input: [{ type: "text", text: "hello" }],
        options: {
          model: "claude-opus-4-6",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        instructions: managerInstructions,
        dynamicTools: [
          {
            name: "message_user",
            description: "Send a user-visible update from the manager thread.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                text: {
                  type: "string",
                  description: "User-visible message text.",
                },
              },
              required: ["text"],
            },
          },
        ],
        instructionMode: "replace",
      },
      harness.dispatchOptions(),
    );

    expect(harness.runtimeState.startedDynamicTools).toEqual(
      [expect.objectContaining({ name: "message_user" })],
    );
    expect(harness.runtimeState.startedInstructions).toBe(managerInstructions);
  });

  it("creates threadStoragePath directory before starting the thread", async () => {
    const tempDir = await makeTempDir("bb-thread-storage-start-");
    const storagePath = path.join(tempDir, "thr_abc123");
    const harness = createHarness();

    await dispatchCommand(
      {
        type: "thread.start",
        environmentId: "env-1",
        threadId: "thread-1",
        workspaceContext: { workspacePath: "/tmp/env-1", workspaceProvisionType: "unmanaged" },
        projectId: "project-1",
        providerId: "fake",
        eventSequence: 1,
        input: [{ type: "text", text: "hello" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        instructions: "test",
        dynamicTools: [],
        instructionMode: "append",
        threadStoragePath: storagePath,
      },
      harness.dispatchOptions({ threadStorageRootPath: tempDir }),
    );

    const stat = await fs.stat(storagePath);
    expect(stat.isDirectory()).toBe(true);
  });

  it("does not fail when threadStoragePath is omitted", async () => {
    const harness = createHarness();

    const result = await dispatchCommand(
      {
        type: "thread.start",
        environmentId: "env-1",
        threadId: "thread-1",
        workspaceContext: { workspacePath: "/tmp/env-1", workspaceProvisionType: "unmanaged" },
        projectId: "project-1",
        providerId: "fake",
        eventSequence: 1,
        input: [{ type: "text", text: "hello" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        instructions: "test",
        dynamicTools: [],
        instructionMode: "append",
      },
      harness.dispatchOptions(),
    );

    expect(result).toEqual({ providerThreadId: "provider-thread-1" });
  });

  it("removes thread storage directory on thread.deleted", async () => {
    const tempDir = await makeTempDir("bb-thread-storage-delete-");
    const threadDir = path.join(tempDir, "thr_del123");
    await fs.mkdir(threadDir);
    await fs.writeFile(path.join(threadDir, "PREFERENCES.md"), "prefs");

    const harness = createHarness();

    const result = await dispatchCommand(
      {
        type: "thread.deleted",
        environmentId: "env-1",
        threadId: "thr_del123",
      },
      harness.dispatchOptions({ threadStorageRootPath: tempDir }),
    );

    expect(result).toEqual({});
    await expect(fs.stat(threadDir)).rejects.toThrow();
  });

  it("succeeds on thread.deleted when directory does not exist", async () => {
    const tempDir = await makeTempDir("bb-thread-storage-delete-noop-");
    const harness = createHarness();

    const result = await dispatchCommand(
      {
        type: "thread.deleted",
        environmentId: "env-1",
        threadId: "thr_missing",
      },
      harness.dispatchOptions({ threadStorageRootPath: tempDir }),
    );

    expect(result).toEqual({});
  });

  it("rejects thread.deleted when threadId escapes storage root", async () => {
    const tempDir = await makeTempDir("bb-thread-storage-traversal-");
    const harness = createHarness();

    await expect(
      dispatchCommand(
        {
          type: "thread.deleted",
          environmentId: "env-1",
          threadId: "../../etc",
        },
        harness.dispatchOptions({ threadStorageRootPath: tempDir }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_path",
      message: expect.stringContaining("escapes"),
    });
  });

  it("rejects thread.deleted when threadId resolves to the root itself", async () => {
    const tempDir = await makeTempDir("bb-thread-storage-root-");
    const harness = createHarness();

    await expect(
      dispatchCommand(
        {
          type: "thread.deleted",
          environmentId: "env-1",
          threadId: ".",
        },
        harness.dispatchOptions({ threadStorageRootPath: tempDir }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_path",
    });
  });

  it("rejects thread.start when threadStoragePath escapes storage root", async () => {
    const tempDir = await makeTempDir("bb-thread-storage-start-traversal-");
    const harness = createHarness();

    await expect(
      dispatchCommand(
        {
          type: "thread.start",
          environmentId: "env-1",
          threadId: "thread-1",
          workspaceContext: { workspacePath: "/tmp/env-1", workspaceProvisionType: "unmanaged" },
          projectId: "project-1",
          providerId: "fake",
          eventSequence: 1,
          input: [{ type: "text", text: "hello" }],
          options: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
          permissionEscalation: null,
          },
          instructions: "test",
          dynamicTools: [],
          instructionMode: "append",
          threadStoragePath: "/tmp/evil-escape",
        },
        harness.dispatchOptions({ threadStorageRootPath: tempDir }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_path",
      message: expect.stringContaining("escapes"),
    });
  });
});

import fs from "node:fs/promises";
import path from "node:path";
import type { AgentRuntimeOptions } from "@bb/agent-runtime";
import {
  encodeClientTurnRequestIdNumber,
  turnScope,
  type ClientTurnRequestId,
} from "@bb/domain";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchCommand } from "../../src/command-dispatch.js";
import { RuntimeManager } from "../../src/runtime-manager.js";
import {
  cleanupTempDirs,
  createFakeRuntime,
  createFakeWorkspace,
  createHarness,
  makeDispatchOptions,
  makeTempDir,
} from "./dispatch-helpers.js";

afterEach(cleanupTempDirs);

let nextClientRequestIdValue = 1;

function nextClientRequestId(): ClientTurnRequestId {
  const requestId = encodeClientTurnRequestIdNumber({
    value: nextClientRequestIdValue,
  });
  nextClientRequestIdValue += 1;
  return requestId;
}

describe("thread command dispatch", () => {
  it("covers thread lifecycle commands", async () => {
    const harness = createHarness();

    const startResult = await dispatchCommand(
      {
        type: "thread.start",
        environmentId: "env-1",
        threadId: "thread-1",
        workspaceContext: {
          workspacePath: "/tmp/env-1",
          workspaceProvisionType: "unmanaged",
        },
        projectId: "project-1",
        providerId: "fake",
        requestId: nextClientRequestId(),
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
    const archiveResult = await dispatchCommand(
      {
        type: "thread.archive",
        environmentId: "env-1",
        threadId: "thread-1",
        workspaceContext: {
          workspacePath: "/tmp/env-1",
          workspaceProvisionType: "unmanaged",
        },
        providerId: "fake",
        providerThreadId: "provider-thread-1",
      },
      harness.dispatchOptions(),
    );
    const unarchiveResult = await dispatchCommand(
      {
        type: "thread.unarchive",
        threadId: "thread-1",
        providerId: "fake",
        providerThreadId: "provider-thread-1",
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
    expect(archiveResult).toEqual({});
    expect(unarchiveResult).toEqual({});
    expect(stopResult).toEqual({});
    expect(harness.runtimeState.startedThreadId).toBe("thread-1");
    expect(harness.runtimeState.startedInstructions).toBe(
      "Be a helpful coding agent.",
    );
    expect(harness.runtimeState.renamedTitle).toBe("Renamed");
    expect(harness.runtimeState.archivedThreadId).toBe("thread-1");
    expect(harness.runtimeState.archivedProviderId).toBe("fake");
    expect(harness.runtimeState.archivedProviderThreadId).toBe(
      "provider-thread-1",
    );
    expect(harness.runtimeState.unarchivedThreadId).toBe("thread-1");
    expect(harness.runtimeState.unarchivedProviderId).toBe("fake");
    expect(harness.runtimeState.unarchivedProviderThreadId).toBe(
      "provider-thread-1",
    );
    expect(harness.runtimeState.stoppedThreadId).toBe("thread-1");
    expect(harness.manager.listActiveThreads()).toEqual([]);
  });

  it("creates the environment runtime for archive commands when needed", async () => {
    const harness = createHarness({ workspacePath: "/tmp/recreated-env" });

    const result = await dispatchCommand(
      {
        type: "thread.archive",
        environmentId: "env-recreated",
        threadId: "thread-archive",
        workspaceContext: {
          workspacePath: "/tmp/recreated-env",
          workspaceProvisionType: "unmanaged",
        },
        providerId: "fake",
        providerThreadId: "provider-archive",
      },
      harness.dispatchOptions(),
    );

    expect(result).toEqual({});
    expect(harness.provisions).toEqual([
      {
        workspaceProvisionType: "unmanaged",
        path: "/tmp/recreated-env",
      },
    ]);
    expect(harness.runtimeState.archivedThreadId).toBe("thread-archive");
    expect(harness.runtimeState.archivedProviderId).toBe("fake");
    expect(harness.runtimeState.archivedProviderThreadId).toBe(
      "provider-archive",
    );
  });

  it("forgets archived runtime threads so later sends resume the provider thread", async () => {
    const harness = createHarness();

    await dispatchCommand(
      {
        type: "thread.start",
        environmentId: "env-resume-after-archive",
        threadId: "thread-resume-after-archive",
        workspaceContext: {
          workspacePath: "/tmp/env-resume-after-archive",
          workspaceProvisionType: "unmanaged",
        },
        projectId: "project-1",
        providerId: "fake",
        requestId: nextClientRequestId(),
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

    await dispatchCommand(
      {
        type: "thread.archive",
        environmentId: "env-resume-after-archive",
        threadId: "thread-resume-after-archive",
        workspaceContext: {
          workspacePath: "/tmp/env-resume-after-archive",
          workspaceProvisionType: "unmanaged",
        },
        providerId: "fake",
        providerThreadId: "provider-thread-resume-after-archive",
      },
      harness.dispatchOptions(),
    );
    expect(
      harness.manager.hasThread(
        "env-resume-after-archive",
        "thread-resume-after-archive",
      ),
    ).toBe(false);

    await dispatchCommand(
      {
        type: "turn.submit",
        environmentId: "env-resume-after-archive",
        threadId: "thread-resume-after-archive",
        requestId: nextClientRequestId(),
        input: [{ type: "text", text: "follow up" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        resumeContext: {
          workspaceContext: {
            workspacePath: "/tmp/env-resume-after-archive",
            workspaceProvisionType: "unmanaged",
          },
          projectId: "project-1",
          providerId: "fake",
          providerThreadId: "provider-thread-resume-after-archive",
          instructions: "Be a helpful coding agent.",
          dynamicTools: [],
          instructionMode: "append",
        },
        target: { mode: "start" },
      },
      harness.dispatchOptions(),
    );

    expect(harness.runtimeState.resumedThreadId).toBe(
      "thread-resume-after-archive",
    );
    expect(harness.runtimeState.resumedProviderThreadId).toBe(
      "provider-thread-resume-after-archive",
    );
    expect(harness.runtimeState.ranTurnText).toBe("follow up");
  });

  it("unarchives through provider maintenance runtime after managed workspace cleanup", async () => {
    const dataDir = await makeTempDir("bb-daemon-data-");
    const oldManagedWorkspacePath = path.join(dataDir, "destroyed-worktree");
    const harness = createHarness({ workspacePath: oldManagedWorkspacePath });

    const result = await dispatchCommand(
      {
        type: "thread.unarchive",
        threadId: "thread-unarchive-cleaned",
        providerId: "fake",
        providerThreadId: "provider-unarchive-cleaned",
      },
      harness.dispatchOptions({ dataDir }),
    );

    expect(result).toEqual({});
    expect(harness.provisions).toEqual([]);
    const maintenanceWorkspace = await fs.stat(
      path.join(dataDir, "provider-maintenance-workspace"),
    );
    expect(maintenanceWorkspace.isDirectory()).toBe(true);
    expect(harness.runtimeState.unarchivedThreadId).toBe(
      "thread-unarchive-cleaned",
    );
    expect(harness.runtimeState.unarchivedProviderId).toBe("fake");
    expect(harness.runtimeState.unarchivedProviderThreadId).toBe(
      "provider-unarchive-cleaned",
    );
  });

  it("covers turn.submit start and auto targets", async () => {
    const harness = createHarness();
    const runRequestId = nextClientRequestId();
    const steerRequestId = nextClientRequestId();
    await harness.manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    harness.manager.markThreadActive("env-1", "thread-1", "provider-1");

    const runResult = await dispatchCommand(
      {
        type: "turn.submit",
        environmentId: "env-1",
        threadId: "thread-1",
        requestId: runRequestId,
        input: [{ type: "text", text: "hello" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        resumeContext: {
          workspaceContext: {
            workspacePath: "/tmp/env-1",
            workspaceProvisionType: "unmanaged",
          },
          projectId: "project-1",
          providerId: "fake",
          providerThreadId: "provider-1",
          instructions: "Be a helpful coding agent.",
          dynamicTools: [],
          instructionMode: "append",
        },
        target: { mode: "start" },
      },
      harness.dispatchOptions(),
    );
    const steerResult = await dispatchCommand(
      {
        type: "turn.submit",
        environmentId: "env-1",
        threadId: "thread-1",
        requestId: steerRequestId,
        input: [{ type: "text", text: "adjust" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        resumeContext: {
          workspaceContext: {
            workspacePath: "/tmp/env-1",
            workspaceProvisionType: "unmanaged",
          },
          projectId: "project-1",
          providerId: "fake",
          providerThreadId: "provider-1",
          instructions: "Be a helpful coding agent.",
          dynamicTools: [],
          instructionMode: "append",
        },
        target: { mode: "auto", expectedTurnId: "turn-1" },
      },
      harness.dispatchOptions(),
    );

    expect(runResult).toEqual({ appliedAs: "new-turn" });
    expect(steerResult).toEqual({ appliedAs: "steer" });
    expect(harness.runtimeState.ranTurnText).toBe("hello");
    expect(harness.runtimeState.ranTurnClientRequestId).toBe(runRequestId);
    expect(harness.runtimeState.steeredTurnId).toBe("turn-1");
    expect(harness.runtimeState.steeredClientRequestId).toBe(steerRequestId);
    expect(harness.runtimeState.steeredTurnInstructions).toBe(
      "Be a helpful coding agent.",
    );
  });

  it("marks a known thread active for the next turn after runtime completion made it idle", async () => {
    const { runtime, state } = createFakeRuntime();
    const { workspace } = createFakeWorkspace("/tmp/env-1");
    let runtimeOptions: AgentRuntimeOptions | undefined;
    let completedTurns = 0;
    runtime.runTurn = async (args) => {
      const firstInput = args.input[0];
      state.ranTurnText =
        firstInput?.type === "text" ? firstInput.text : undefined;
      completedTurns += 1;
      if (completedTurns === 1) {
        runtimeOptions?.onEvent?.({
          type: "turn/completed",
          threadId: "thread-1",
          providerThreadId: "provider-1",
          scope: turnScope(`turn-${completedTurns}`),
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
        type: "turn.submit",
        environmentId: "env-1",
        threadId: "thread-1",
        requestId: nextClientRequestId(),
        input: [{ type: "text", text: "finish this" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        resumeContext: {
          workspaceContext: {
            workspacePath: "/tmp/env-1",
            workspaceProvisionType: "unmanaged",
          },
          projectId: "project-1",
          providerId: "fake",
          providerThreadId: "provider-1",
          instructions: "Be a helpful coding agent.",
          dynamicTools: [],
          instructionMode: "append",
        },
        target: { mode: "start" },
      },
      makeDispatchOptions({ runtimeManager: manager }),
    );

    expect(manager.listActiveThreads()).toEqual([]);

    const result = await dispatchCommand(
      {
        type: "turn.submit",
        environmentId: "env-1",
        threadId: "thread-1",
        requestId: nextClientRequestId(),
        input: [{ type: "text", text: "resume work" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        resumeContext: {
          workspaceContext: {
            workspacePath: "/tmp/env-1",
            workspaceProvisionType: "unmanaged",
          },
          projectId: "project-1",
          providerId: "fake",
          providerThreadId: "provider-1",
          instructions: "Be a helpful coding agent.",
          dynamicTools: [],
          instructionMode: "append",
        },
        target: { mode: "start" },
      },
      makeDispatchOptions({ runtimeManager: manager }),
    );

    expect(result).toEqual({ appliedAs: "new-turn" });
    expect(state.ranTurnText).toBe("resume work");
    expect(manager.listActiveThreads()).toEqual([
      {
        threadId: "thread-1",
      },
    ]);
  });

  it("marks known idle threads active when dispatching auto turn.submit", async () => {
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
        type: "turn.submit",
        environmentId: "env-1",
        threadId: "thread-1",
        requestId: nextClientRequestId(),
        input: [{ type: "text", text: "adjust course" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        resumeContext: {
          workspaceContext: {
            workspacePath: "/tmp/env-1",
            workspaceProvisionType: "unmanaged",
          },
          projectId: "project-1",
          providerId: "fake",
          providerThreadId: "provider-1",
          instructions: "Be a helpful coding agent.",
          dynamicTools: [],
          instructionMode: "append",
        },
        target: { mode: "auto", expectedTurnId: "turn-1" },
      },
      harness.dispatchOptions(),
    );

    expect(result).toEqual({ appliedAs: "steer" });
    expect(harness.runtimeState.steeredTurnId).toBe("turn-1");
    expect(harness.manager.listActiveThreads()).toEqual([
      {
        threadId: "thread-1",
      },
    ]);
  });

  it("falls back to a new turn when auto turn.submit sees a stale turn", async () => {
    const harness = createHarness();
    const requestId = nextClientRequestId();
    await harness.manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    harness.manager.markThreadActive("env-1", "thread-1", "provider-1");
    harness.runtime.steerTurn = async (args) => {
      harness.runtimeState.steeredTurnId = args.expectedTurnId;
      harness.runtimeState.steeredClientRequestId = args.clientRequestId;
      return {
        status: "stale",
        activeTurnId: null,
      };
    };

    const result = await dispatchCommand(
      {
        type: "turn.submit",
        environmentId: "env-1",
        threadId: "thread-1",
        requestId,
        input: [{ type: "text", text: "send anyway" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        resumeContext: {
          workspaceContext: {
            workspacePath: "/tmp/env-1",
            workspaceProvisionType: "unmanaged",
          },
          projectId: "project-1",
          providerId: "fake",
          providerThreadId: "provider-1",
          instructions: "Be a helpful coding agent.",
          dynamicTools: [],
          instructionMode: "append",
        },
        target: { mode: "auto", expectedTurnId: "turn-old" },
      },
      harness.dispatchOptions(),
    );

    expect(result).toEqual({ appliedAs: "new-turn" });
    expect(harness.runtimeState.steeredTurnId).toBe("turn-old");
    expect(harness.runtimeState.steeredClientRequestId).toBe(requestId);
    expect(harness.runtimeState.ranTurnText).toBe("send anyway");
    expect(harness.runtimeState.ranTurnClientRequestId).toBe(requestId);
  });

  it("falls back to a new turn when explicit steer sees a stale turn", async () => {
    const harness = createHarness();
    const requestId = nextClientRequestId();
    await harness.manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    harness.manager.markThreadActive("env-1", "thread-1", "provider-1");
    harness.runtime.steerTurn = async (args) => ({
      status: "stale",
      activeTurnId: args.expectedTurnId,
    });

    const result = await dispatchCommand(
      {
        type: "turn.submit",
        environmentId: "env-1",
        threadId: "thread-1",
        requestId,
        input: [{ type: "text", text: "strict steer" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        resumeContext: {
          workspaceContext: {
            workspacePath: "/tmp/env-1",
            workspaceProvisionType: "unmanaged",
          },
          projectId: "project-1",
          providerId: "fake",
          providerThreadId: "provider-1",
          instructions: "Be a helpful coding agent.",
          dynamicTools: [],
          instructionMode: "append",
        },
        target: { mode: "steer", expectedTurnId: "turn-old" },
      },
      harness.dispatchOptions(),
    );

    expect(result).toEqual({ appliedAs: "new-turn" });
    expect(harness.runtimeState.ranTurnText).toBe("strict steer");
    expect(harness.runtimeState.ranTurnClientRequestId).toBe(requestId);
  });

  it("starts a new turn when explicit steer has no expected turn", async () => {
    const harness = createHarness();
    const requestId = nextClientRequestId();
    await harness.manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    harness.manager.markThreadActive("env-1", "thread-1", "provider-1");

    const result = await dispatchCommand(
      {
        type: "turn.submit",
        environmentId: "env-1",
        threadId: "thread-1",
        requestId,
        input: [{ type: "text", text: "send without active turn" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        resumeContext: {
          workspaceContext: {
            workspacePath: "/tmp/env-1",
            workspaceProvisionType: "unmanaged",
          },
          projectId: "project-1",
          providerId: "fake",
          providerThreadId: "provider-1",
          instructions: "Be a helpful coding agent.",
          dynamicTools: [],
          instructionMode: "append",
        },
        target: { mode: "steer", expectedTurnId: null },
      },
      harness.dispatchOptions(),
    );

    expect(result).toEqual({ appliedAs: "new-turn" });
    expect(harness.runtimeState.ranTurnText).toBe("send without active turn");
    expect(harness.runtimeState.ranTurnClientRequestId).toBe(requestId);
    expect(harness.runtimeState.steeredTurnId).toBeUndefined();
  });

  it("lazily resumes a missing thread runtime before turn.submit", async () => {
    const harness = createHarness({ workspacePath: "/tmp/env-lazy" });

    const result = await dispatchCommand(
      {
        type: "turn.submit",
        environmentId: "env-lazy",
        threadId: "thread-1",
        requestId: nextClientRequestId(),
        input: [{ type: "text", text: "hello" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        resumeContext: {
          workspaceContext: {
            workspacePath: "/tmp/env-lazy",
            workspaceProvisionType: "unmanaged",
          },
          projectId: "project-1",
          providerId: "fake",
          providerThreadId: "provider-1",
          instructions: "Be a helpful coding agent.",
          dynamicTools: [],
          instructionMode: "append",
        },
        target: { mode: "start" },
      },
      harness.dispatchOptions(),
    );

    expect(result).toEqual({ appliedAs: "new-turn" });
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
        type: "turn.submit",
        environmentId: "env-exit",
        threadId: "thread-1",
        requestId: nextClientRequestId(),
        input: [{ type: "text", text: "after exit" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        resumeContext: {
          workspaceContext: {
            workspacePath: "/tmp/env-exit",
            workspaceProvisionType: "unmanaged",
          },
          projectId: "project-1",
          providerId: "fake",
          providerThreadId: "provider-1",
          instructions: "Be a helpful coding agent.",
          dynamicTools: [],
          instructionMode: "append",
        },
        target: { mode: "start" },
      },
      makeDispatchOptions({ runtimeManager: manager }),
    );

    expect(result).toEqual({ appliedAs: "new-turn" });
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
              supportsArchive: false,
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
            supportsArchive: false,
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
        workspaceContext: {
          workspacePath: threadStorage,
          workspaceProvisionType: "unmanaged",
        },
        projectId: "project-1",
        providerId: "fake",
        requestId: nextClientRequestId(),
        input: [{ type: "text", text: "hello" }],
        options: {
          model: "claude-opus-4-7",
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

    expect(harness.runtimeState.startedDynamicTools).toEqual([
      expect.objectContaining({ name: "message_user" }),
    ]);
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
        workspaceContext: {
          workspacePath: "/tmp/env-1",
          workspaceProvisionType: "unmanaged",
        },
        projectId: "project-1",
        providerId: "fake",
        requestId: nextClientRequestId(),
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
        workspaceContext: {
          workspacePath: "/tmp/env-1",
          workspaceProvisionType: "unmanaged",
        },
        projectId: "project-1",
        providerId: "fake",
        requestId: nextClientRequestId(),
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
          workspaceContext: {
            workspacePath: "/tmp/env-1",
            workspaceProvisionType: "unmanaged",
          },
          projectId: "project-1",
          providerId: "fake",
          requestId: nextClientRequestId(),
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

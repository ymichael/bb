import type {
  HostDaemonCommand,
  HostDaemonOnlineRpcRequestMessage,
  HostDaemonOnlineRpcResponseMessage,
} from "@bb/host-daemon-contract";
import { WorkspaceError } from "@bb/host-workspace";
import {
  encodeClientTurnRequestIdNumber,
  type ClientTurnRequestId,
  type PromptInput,
} from "@bb/domain";
import { createDeferredPromise } from "@bb/test-helpers";
import { describe, expect, it, vi } from "vitest";
import {
  CommandRouter,
  type CommandRouterOptions,
} from "../../src/command-router.js";
import { noopEventSink } from "../../src/command-dispatch-support.js";
import {
  createHarness,
  createFakeRuntime,
  createFakeWorkspace,
  unexpectedProjectAttachmentFetch,
  unexpectedProviderMaintenance,
  DISPATCH_TEST_BRIDGE_LAUNCH,
  fetchDispatchTestArtifact,
} from "./dispatch-helpers.js";
import { RuntimeManager } from "../../src/runtime-manager.js";

type EnvironmentDestroyCommand = Extract<
  HostDaemonCommand,
  { type: "environment.destroy" }
>;
type EnvironmentProvisionCommand = Extract<
  HostDaemonCommand,
  { type: "environment.provision" }
>;
type RouterHarness = ReturnType<typeof createHarness>;
type TextPromptInput = Extract<PromptInput, { type: "text" }>;
type InteractiveResolveCommand = Extract<
  HostDaemonCommand,
  { type: "interactive.resolve" }
>;
type ThreadStartCommand = Extract<HostDaemonCommand, { type: "thread.start" }>;
type TurnSubmitCommand = Extract<HostDaemonCommand, { type: "turn.submit" }>;

interface RunRouterCommandArgs {
  command: HostDaemonCommand;
  requestId: string;
  router: CommandRouter;
}

interface CreateTurnSubmitCommandArgs {
  environmentId?: string;
  providerId?: string;
  providerThreadId?: string;
  workspacePath?: string;
  text?: string;
  threadId?: string;
}

interface CreateRouterArgs {
  logger?: CommandRouterOptions["logger"];
  resolveInteractiveRequest?: CommandRouterOptions["resolveInteractiveRequest"];
  runtimeManager?: RuntimeManager;
}

let nextClientRequestIdValue = 1;

function createClientRequestId(): ClientTurnRequestId {
  const requestId = encodeClientTurnRequestIdNumber({
    value: nextClientRequestIdValue,
  });
  nextClientRequestIdValue += 1;
  return requestId;
}

function createRouter(
  harness: RouterHarness,
  args: CreateRouterArgs = {},
): CommandRouter {
  return new CommandRouter({
    dataDir: "/tmp/bb-router-test-data",
    eventSink: noopEventSink,
    fetchProjectAttachment: unexpectedProjectAttachmentFetch,
    fetchPluginHostArtifact: fetchDispatchTestArtifact,
    ...unexpectedProviderMaintenance,
    logger: {
      debug: () => undefined,
      warn: () => undefined,
      ...args.logger,
    },
    resolveInteractiveRequest: args.resolveInteractiveRequest,
    runtimeManager: args.runtimeManager ?? harness.manager,
    threadStorageRootPath: "/tmp/bb-router-test-thread-storage",
  });
}

function createTurnSubmitCommand(
  args: CreateTurnSubmitCommandArgs = {},
): TurnSubmitCommand {
  const workspacePath = args.workspacePath ?? "/tmp/env-router";
  return {
    bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
    type: "turn.submit",
    environmentId: args.environmentId ?? "env-router",
    threadId: args.threadId ?? "thread-router",
    requestId: createClientRequestId(),
    input: [textPromptInput(args.text ?? "after destroy")],
    options: {
      model: "gpt-5",
      serviceTier: "default",
      reasoningLevel: "medium",
      providerOptions: {},
      permissionMode: "full",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
    },
    resumeContext: {
      bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
      workspaceContext: {
        workspacePath,
        workspaceProvisionType: "unmanaged",
      },
      projectId: "project-router",
      providerId: args.providerId ?? "fake",
      providerThreadId: args.providerThreadId ?? "provider-thread-router",
      instructions: "Be a helpful coding agent.",
      dynamicTools: [],
      contributedEnv: [],
      injectedSkillSources: [],
      instructionMode: "append",
    },
    target: { mode: "start" },
  };
}

function createThreadStartCommand(): ThreadStartCommand {
  return {
    bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
    type: "thread.start",
    environmentId: "env-router",
    threadId: "thread-router-start",
    workspaceContext: {
      workspacePath: "/tmp/env-router",
      workspaceProvisionType: "unmanaged",
    },
    projectId: "project-router",
    providerId: "fake",
    requestId: createClientRequestId(),
    input: [textPromptInput("start")],
    options: {
      model: "gpt-5",
      serviceTier: "default",
      reasoningLevel: "medium",
      providerOptions: {},
      permissionMode: "full",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
    },
    instructions: "Be a helpful coding agent.",
    dynamicTools: [],
    contributedEnv: [],
    injectedSkillSources: [],
    instructionMode: "append",
  };
}

function createInteractiveResolveCommand(): InteractiveResolveCommand {
  return {
    type: "interactive.resolve",
    environmentId: "env-router",
    threadId: "thread-router",
    interactionId: "interaction-router",
    providerId: "fake",
    providerThreadId: "provider-thread-router",
    providerRequestId: "provider-request-router",
    resolution: { decision: "allow_once", grantedPermissions: null },
  };
}

function textPromptInput(text: string): TextPromptInput {
  return { type: "text", text, mentions: [] };
}

function createEnvironmentDestroyCommand(): EnvironmentDestroyCommand {
  return {
    type: "environment.destroy",
    environmentId: "env-router",
    teardownTimeoutMs: 900000,
    workspaceContext: {
      workspacePath: "/tmp/env-router",
      workspaceProvisionType: "unmanaged",
    },
  };
}

function createEnvironmentProvisionCommand(): EnvironmentProvisionCommand {
  return {
    type: "environment.provision",
    environmentId: "env-router",
    initiator: null,
    workspaceProvisionType: "unmanaged",
    path: "/tmp/env-router",
  };
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

async function runRouterCommand({
  command,
  requestId,
  router,
}: RunRouterCommandArgs): Promise<HostDaemonOnlineRpcResponseMessage> {
  const message: HostDaemonOnlineRpcRequestMessage = {
    type: "host-rpc.request",
    requestId,
    command,
  };
  return router.handleOnlineRpcRequest(message);
}

describe("CommandRouter", () => {
  it("does not warn for expected provision cancellation RPC failures", async () => {
    const harness = createHarness({ workspacePath: "/tmp/env-router" });
    const logger = {
      debug: vi.fn(),
      warn: vi.fn(),
    };
    const runtimeManager = new RuntimeManager({
      createRuntime: () => harness.runtime,
      provisionWorkspace: async () => {
        throw new WorkspaceError(
          "provision_cancelled",
          "Workspace provisioning was cancelled",
        );
      },
    });
    const router = createRouter(harness, { logger, runtimeManager });

    const response = await runRouterCommand({
      command: createEnvironmentProvisionCommand(),
      requestId: "provision-cancelled-env-router",
      router,
    });

    expect(response).toMatchObject({
      ok: false,
      errorCode: "provision_cancelled",
      errorMessage: "Workspace provisioning was cancelled",
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("orders turn.submit after an in-flight environment destroy", async () => {
    const harness = createHarness({ workspacePath: "/tmp/env-router" });
    await harness.manager.ensureEnvironment({
      environmentId: "env-router",
      workspacePath: "/tmp/env-router",
    });
    const destroyStarted = createDeferredPromise<void>();
    const releaseDestroy = createDeferredPromise<void>();
    harness.workspace.destroy = async () => {
      destroyStarted.resolve();
      await releaseDestroy.promise;
    };

    const router = createRouter(harness);
    const destroyTask = runRouterCommand({
      command: createEnvironmentDestroyCommand(),
      requestId: "destroy-env-router",
      router,
    });
    await destroyStarted.promise;

    const turnTask = runRouterCommand({
      command: createTurnSubmitCommand(),
      requestId: "turn-env-router",
      router,
    });
    await flushAsyncWork();

    expect(harness.runtimeState.ranTurnText).toBeUndefined();

    releaseDestroy.resolve();
    const destroyResponse = await destroyTask;
    expect(destroyResponse.ok).toBe(true);
    const turnResponse = await turnTask;
    expect(turnResponse.ok).toBe(true);
    expect(harness.runtimeState.ranTurnText).toBe("after destroy");
  });

  it("orders thread.stop after an in-flight thread.start handoff", async () => {
    const harness = createHarness({ workspacePath: "/tmp/env-router" });
    await harness.manager.ensureEnvironment({
      environmentId: "env-router",
      workspacePath: "/tmp/env-router",
    });
    const startEntered = createDeferredPromise<void>();
    const releaseStart = createDeferredPromise<void>();
    const originalStartThread = harness.runtime.startThread;
    harness.runtime.startThread = async (args) => {
      startEntered.resolve();
      await releaseStart.promise;
      return originalStartThread(args);
    };

    const router = createRouter(harness);
    const startTask = runRouterCommand({
      command: createThreadStartCommand(),
      requestId: "start-env-router",
      router,
    });
    await startEntered.promise;

    let stopResolved = false;
    const stopTask = runRouterCommand({
      command: {
        type: "thread.stop",
        intent: "interrupt",
        environmentId: "env-router",
        threadId: "thread-router-start",
      },
      requestId: "stop-env-router",
      router,
    }).then((response) => {
      stopResolved = true;
      return response;
    });
    await flushAsyncWork();

    expect(harness.runtimeState.stoppedThreadId).toBeUndefined();
    expect(stopResolved).toBe(false);

    releaseStart.resolve();
    const startResponse = await startTask;
    expect(startResponse.ok).toBe(true);
    const stopResponse = await stopTask;

    expect(stopResponse.ok).toBe(true);
    expect(harness.runtimeState.stoppedThreadId).toBe("thread-router-start");
    expect(harness.runtime.hasThread("thread-router-start")).toBe(false);
  });

  it("orders interactive.resolve after an in-flight turn.submit on the same thread", async () => {
    const harness = createHarness({ workspacePath: "/tmp/env-router" });
    await harness.manager.ensureEnvironment({
      environmentId: "env-router",
      workspacePath: "/tmp/env-router",
    });
    const turnEntered = createDeferredPromise<void>();
    const releaseTurn = createDeferredPromise<void>();
    const originalRunTurn = harness.runtime.runTurn;
    harness.runtime.runTurn = async (args) => {
      turnEntered.resolve();
      await releaseTurn.promise;
      return originalRunTurn(args);
    };
    const resolveInteractiveRequest = vi.fn(async () => undefined);

    const router = createRouter(harness, { resolveInteractiveRequest });
    const turnTask = runRouterCommand({
      command: createTurnSubmitCommand({ text: "hold the lane" }),
      requestId: "turn-before-resolve",
      router,
    });
    await turnEntered.promise;

    const resolveTask = runRouterCommand({
      command: createInteractiveResolveCommand(),
      requestId: "resolve-behind-turn",
      router,
    });
    await flushAsyncWork();

    expect(resolveInteractiveRequest).not.toHaveBeenCalled();

    releaseTurn.resolve();
    const turnResponse = await turnTask;
    expect(turnResponse.ok).toBe(true);
    const resolveResponse = await resolveTask;
    expect(resolveResponse.ok).toBe(true);
    expect(resolveInteractiveRequest).toHaveBeenCalledTimes(1);
    expect(resolveInteractiveRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        interactionId: "interaction-router",
        threadId: "thread-router",
      }),
    );
  });

  it("waits for an old-environment turn before resuming the moved thread", async () => {
    const harness = createHarness({ workspacePath: "/tmp/env-router" });
    const oldHarness = createFakeRuntime();
    const newHarness = createFakeRuntime();
    const oldRuntime = oldHarness.runtime;
    const newRuntime = newHarness.runtime;
    const runtimes = [oldRuntime, newRuntime];
    const runtimeManager = new RuntimeManager({
      createRuntime: () => {
        const runtime = runtimes.shift();
        if (!runtime) {
          throw new Error("Unexpected runtime creation");
        }
        return runtime;
      },
      provisionWorkspace: async (options) =>
        createFakeWorkspace(
          "path" in options ? options.path : options.targetPath,
        ).workspace,
    });
    await runtimeManager.ensureEnvironment({
      environmentId: "env-router-old",
      workspacePath: "/tmp/env-router-old",
    });
    oldHarness.threadControls.setProviderSession("thread-moved", {
      providerId: "fake",
      providerThreadId: "provider-moved",
    });

    const oldRunEntered = createDeferredPromise<void>();
    const releaseOldRun = createDeferredPromise<void>();
    const originalOldRunTurn = oldRuntime.runTurn.bind(oldRuntime);
    oldRuntime.runTurn = async (args) => {
      oldRunEntered.resolve();
      await releaseOldRun.promise;
      return originalOldRunTurn(args);
    };
    const originalOldStopThread = oldRuntime.stopThread.bind(oldRuntime);
    const oldStopThread = vi.fn(originalOldStopThread);
    oldRuntime.stopThread = oldStopThread;
    const originalNewResumeThread = newRuntime.resumeThread.bind(newRuntime);
    const newResumeThread = vi.fn(originalNewResumeThread);
    newRuntime.resumeThread = newResumeThread;
    const retainEnvironment = vi.spyOn(
      runtimeManager,
      "retainEnvironmentForThreadCommand",
    );

    const router = createRouter(harness, { runtimeManager });
    const oldTask = runRouterCommand({
      command: createTurnSubmitCommand({
        environmentId: "env-router-old",
        providerThreadId: "provider-moved",
        threadId: "thread-moved",
        workspacePath: "/tmp/env-router-old",
        text: "old turn",
      }),
      requestId: "old-moved-turn",
      router,
    });
    await oldRunEntered.promise;

    const newTask = runRouterCommand({
      command: createTurnSubmitCommand({
        environmentId: "env-router-new",
        providerThreadId: "provider-moved",
        threadId: "thread-moved",
        workspacePath: "/tmp/env-router-new",
        text: "new turn",
      }),
      requestId: "new-moved-turn",
      router,
    });
    await flushAsyncWork();

    expect(retainEnvironment).toHaveBeenCalledTimes(1);
    expect(newResumeThread).not.toHaveBeenCalled();
    releaseOldRun.resolve();
    const [oldResponse, newResponse] = await Promise.all([oldTask, newTask]);

    expect(oldResponse.ok).toBe(true);
    expect(newResponse.ok).toBe(true);
    expect(retainEnvironment).toHaveBeenNthCalledWith(
      2,
      "env-router-new",
      "thread-moved",
    );
    expect(oldStopThread).toHaveBeenCalledWith({
      threadId: "thread-moved",
    });
    expect(newResumeThread).toHaveBeenCalledWith(
      expect.objectContaining({
        providerThreadId: "provider-moved",
        threadId: "thread-moved",
      }),
    );
    expect(oldStopThread.mock.invocationCallOrder[0]).toBeLessThan(
      newResumeThread.mock.invocationCallOrder[0],
    );
    await runtimeManager.shutdownAll();
  });

  it.each(["codex", "claude-code", "acp-cursor"])(
    "does not route separate %s threads through one lane",
    async (providerId) => {
      const harness = createHarness({ workspacePath: "/tmp/env-router" });
      await harness.manager.ensureEnvironment({
        environmentId: "env-router",
        workspacePath: "/tmp/env-router",
      });
      harness.threadControls.setProviderSession("thread-stop", {
        providerId,
        providerThreadId: "provider-stop",
      });
      harness.threadControls.setProviderSession("thread-turn", {
        providerId,
        providerThreadId: "provider-turn",
      });

      const stopEntered = createDeferredPromise<void>();
      const releaseStop = createDeferredPromise<void>();
      const originalStopThread = harness.runtime.stopThread;
      harness.runtime.stopThread = async (args) => {
        stopEntered.resolve();
        await releaseStop.promise;
        return originalStopThread(args);
      };

      const router = createRouter(harness);
      const stopTask = runRouterCommand({
        command: {
          type: "thread.stop",
          intent: "interrupt",
          environmentId: "env-router",
          threadId: "thread-stop",
        },
        requestId: "stop-thread",
        router,
      });
      await stopEntered.promise;

      const turnTask = runRouterCommand({
        command: createTurnSubmitCommand({
          providerId,
          providerThreadId: "provider-turn",
          text: "other thread",
          threadId: "thread-turn",
        }),
        requestId: "turn-other-thread",
        router,
      });
      await flushAsyncWork();

      expect(harness.runtimeState.ranTurnText).toBe("other thread");
      const turnResponse = await turnTask;
      expect(turnResponse.ok).toBe(true);

      releaseStop.resolve();
      const stopResponse = await stopTask;
      expect(stopResponse.ok).toBe(true);
    },
  );
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPersonalWorkspaceRoot,
  WorkspaceError,
  type HostWorkspace,
} from "@bb/host-workspace";
import { createDeferredPromise } from "@bb/test-helpers";
import { dispatchCommand } from "../../src/command-dispatch.js";
import type { EventSinkInput } from "../../src/event-sink.js";
import {
  TerminalManager,
  type ResolveTerminalShell,
  type SpawnTerminalPtyArgs,
  type TerminalPtyAdapter,
  type TerminalPtyDisposable,
  type TerminalPtyExit,
  type TerminalPtyProcess,
} from "../../src/terminals/terminal-manager.js";
import {
  cleanupTempDirs,
  createFakeRuntime,
  createFakeWorkspace,
  createHarness,
  makeDispatchOptions,
  makeTempDir,
} from "./dispatch-helpers.js";
import { RuntimeManager } from "../../src/runtime-manager.js";

const DEFAULT_TERMINAL_START = { mode: "shell" } as const;

interface ResizeCall {
  cols: number;
  rows: number;
}

interface SpawnedTerminal {
  args: SpawnTerminalPtyArgs;
  pty: FakeTerminalPty;
}

interface CreateTerminalManagerArgs {
  manager: RuntimeManager;
  resolveShell: ResolveTerminalShell;
}

interface TerminalManagerFixture {
  adapter: FakeTerminalPtyAdapter;
  manager: TerminalManager;
}

type TerminalDataListener = (data: string) => void;
type TerminalExitListener = (event: TerminalPtyExit) => void;

afterEach(cleanupTempDirs);

class FakeTerminalPty implements TerminalPtyProcess {
  readonly killCalls: (string | null)[];
  readonly resizeCalls: ResizeCall[];
  readonly writeCalls: (Buffer | string)[];
  private readonly dataListeners: TerminalDataListener[];
  private readonly exitListeners: TerminalExitListener[];

  constructor() {
    this.killCalls = [];
    this.resizeCalls = [];
    this.writeCalls = [];
    this.dataListeners = [];
    this.exitListeners = [];
  }

  dispose(): void {}

  kill(signal?: string): void {
    this.killCalls.push(signal ?? null);
  }

  onData(listener: TerminalDataListener): TerminalPtyDisposable {
    this.dataListeners.push(listener);
    return {
      dispose: () => {
        const index = this.dataListeners.indexOf(listener);
        if (index >= 0) {
          this.dataListeners.splice(index, 1);
        }
      },
    };
  }

  onExit(listener: TerminalExitListener): TerminalPtyDisposable {
    this.exitListeners.push(listener);
    return {
      dispose: () => {
        const index = this.exitListeners.indexOf(listener);
        if (index >= 0) {
          this.exitListeners.splice(index, 1);
        }
      },
    };
  }

  resize(cols: number, rows: number): void {
    this.resizeCalls.push({ cols, rows });
  }

  write(data: Buffer | string): void {
    this.writeCalls.push(data);
  }
}

class FakeTerminalPtyAdapter implements TerminalPtyAdapter {
  readonly spawned: SpawnedTerminal[];

  constructor() {
    this.spawned = [];
  }

  spawn(args: SpawnTerminalPtyArgs): TerminalPtyProcess {
    const pty = new FakeTerminalPty();
    this.spawned.push({ args, pty });
    return pty;
  }
}

function createTerminalManager(
  args: CreateTerminalManagerArgs,
): TerminalManagerFixture {
  const adapter = new FakeTerminalPtyAdapter();
  const manager = new TerminalManager({
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    ptyAdapter: adapter,
    resolveShell: args.resolveShell,
    runtimeManager: args.manager,
    sendMessage: () => true,
  });
  return { adapter, manager };
}

describe("environment command dispatch", () => {
  it("covers environment.provision in unmanaged mode", async () => {
    const harness = createHarness({ workspacePath: "/tmp/unmanaged" });
    const sourcePath = await makeTempDir("bb-dispatch-unmanaged-");

    const result = await dispatchCommand(
      {
        type: "environment.provision",
        environmentId: "env-unmanaged",
        initiator: null,
        workspaceProvisionType: "unmanaged",
        path: sourcePath,
      },
      harness.dispatchOptions(),
    );

    expect(result).toMatchObject({
      path: sourcePath,
      isGitRepo: true,
      isWorktree: false,
      branchName: "main",
      defaultBranch: "main",
    });
    expect(result.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "workspace-path",
          text: `Using workspace: ${sourcePath}`,
        }),
        expect.objectContaining({
          key: "workspace-branch",
          text: expect.stringContaining("Using branch: main"),
        }),
      ]),
    );
    expect(harness.provisions).toEqual([
      {
        workspaceProvisionType: "unmanaged",
        path: sourcePath,
        onProgress: expect.any(Function),
        signal: expect.any(AbortSignal),
      },
    ]);
  });

  it("covers environment.provision in managed-worktree mode", async () => {
    const harness = createHarness({
      workspacePath: "/tmp/worktree",
      isWorktree: true,
    });
    const sourcePath = await makeTempDir("bb-dispatch-worktree-");

    const result = await dispatchCommand(
      {
        type: "environment.provision",
        environmentId: "env-worktree",
        initiator: null,
        workspaceProvisionType: "managed-worktree",
        sourcePath,
        targetPath: "/tmp/worktree",
        branchName: "bb/test",
        baseBranch: "main",
        setupTimeoutMs: 900000,
      },
      harness.dispatchOptions(),
    );

    expect(result).toMatchObject({
      path: "/tmp/worktree",
      isGitRepo: true,
      isWorktree: true,
      branchName: "main",
      defaultBranch: "main",
    });
    expect(result.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "workspace-path",
          text: "Using workspace: /tmp/worktree",
        }),
        expect.objectContaining({
          key: "workspace-branch",
          text: expect.stringContaining("Using branch: main"),
        }),
      ]),
    );
    expect(harness.provisions).toEqual([
      {
        workspaceProvisionType: "managed-worktree",
        sourcePath,
        targetPath: "/tmp/worktree",
        branchName: "bb/test",
        baseBranch: "main",
        timeoutMs: 900000,
        onProgress: expect.any(Function),
        signal: expect.any(AbortSignal),
      },
    ]);
  });

  it("covers environment.provision in personal mode", async () => {
    const dataDir = await makeTempDir("bb-dispatch-personal-data-");
    const environmentId = "env_personal";
    const personalWorkspaceRoot = getPersonalWorkspaceRoot(dataDir);
    const targetPath = `${personalWorkspaceRoot}/${environmentId}`;
    const harness = createHarness({
      workspacePath: targetPath,
    });
    harness.workspace.isGitRepo = false;
    harness.workspace.getCurrentBranch = async () => null;

    const result = await dispatchCommand(
      {
        type: "environment.provision",
        environmentId,
        initiator: null,
        workspaceProvisionType: "personal",
        targetPath,
      },
      harness.dispatchOptions({ dataDir }),
    );

    expect(result).toMatchObject({
      path: targetPath,
      isGitRepo: false,
      isWorktree: false,
      branchName: null,
      defaultBranch: null,
    });
    expect(harness.provisions).toEqual([
      {
        workspaceProvisionType: "personal",
        environmentId,
        personalWorkspaceRoot,
        targetPath,
        onProgress: expect.any(Function),
        signal: expect.any(AbortSignal),
      },
    ]);
  });

  it("returns success when cancelling a provision with no in-flight work", async () => {
    const harness = createHarness();

    await expect(
      dispatchCommand(
        {
          type: "environment.provision.cancel",
          environmentId: "env-missing",
        },
        harness.dispatchOptions(),
      ),
    ).resolves.toEqual({ aborted: false });
  });

  it("aborts in-flight environment provisioning", async () => {
    const { workspace } = createFakeWorkspace("/tmp/cancelled");
    const { runtime } = createFakeRuntime();
    let provisionSignal: AbortSignal | undefined;
    let resolveProvisionStarted: () => void = () => undefined;
    const provisionStarted = new Promise<void>((resolve) => {
      resolveProvisionStarted = resolve;
    });
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async (options) => {
        provisionSignal = options.signal;
        resolveProvisionStarted();
        await new Promise<void>((resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              reject(options.signal?.reason);
            },
            { once: true },
          );
        });
        return workspace;
      },
    });
    const dispatchOptions = makeDispatchOptions({ runtimeManager: manager });
    const provision = dispatchCommand(
      {
        type: "environment.provision",
        environmentId: "env-cancel",
        initiator: null,
        workspaceProvisionType: "unmanaged",
        path: "/tmp/cancelled",
      },
      dispatchOptions,
    );
    await provisionStarted;

    await expect(
      dispatchCommand(
        {
          type: "environment.provision.cancel",
          environmentId: "env-cancel",
        },
        dispatchOptions,
      ),
    ).resolves.toEqual({ aborted: true });

    expect(provisionSignal?.aborted).toBe(true);
    await expect(provision).rejects.toMatchObject({
      code: "provision_cancelled",
    });
  });

  it("reports provision cancellation after delivering abort without waiting for work to settle", async () => {
    const { runtime } = createFakeRuntime();
    let abortObserved = false;
    let provisionSettled = false;
    let provisionSignal: AbortSignal | undefined;
    let resolveProvisionStarted: () => void = () => undefined;
    const provisionStarted = new Promise<void>((resolve) => {
      resolveProvisionStarted = resolve;
    });
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async (options) => {
        provisionSignal = options.signal;
        options.signal?.addEventListener(
          "abort",
          () => {
            abortObserved = true;
          },
          { once: true },
        );
        resolveProvisionStarted();
        return new Promise<HostWorkspace>(() => undefined);
      },
    });
    const dispatchOptions = makeDispatchOptions({ runtimeManager: manager });
    const provision = dispatchCommand(
      {
        type: "environment.provision",
        environmentId: "env-cancel-no-settle",
        initiator: null,
        workspaceProvisionType: "unmanaged",
        path: "/tmp/cancelled-no-settle",
      },
      dispatchOptions,
    ).finally(() => {
      provisionSettled = true;
    });
    await provisionStarted;

    const cancel = dispatchCommand(
      {
        type: "environment.provision.cancel",
        environmentId: "env-cancel-no-settle",
      },
      dispatchOptions,
    );

    await expect(cancel).resolves.toEqual({ aborted: true });
    expect(provisionSignal?.aborted).toBe(true);
    expect(abortObserved).toBe(true);
    expect(provisionSettled).toBe(false);
    void provision;
  });

  it("rejects personal provision targets outside the data dir personal workspace root", async () => {
    const dataDir = await makeTempDir("bb-dispatch-personal-data-");
    const environmentId = "env_personal";
    const harness = createHarness();

    await expect(() =>
      dispatchCommand(
        {
          type: "environment.provision",
          environmentId,
          initiator: null,
          workspaceProvisionType: "personal",
          targetPath: `${dataDir}/personal-workspaces-sibling/${environmentId}`,
        },
        harness.dispatchOptions({ dataDir }),
      ),
    ).rejects.toThrow("Personal workspace target path must match");
    expect(harness.provisions).toEqual([]);
  });

  it("rejects personal provision targets that traverse out of the environment directory", async () => {
    const dataDir = await makeTempDir("bb-dispatch-personal-data-");
    const environmentId = "env_personal";
    const harness = createHarness();

    await expect(() =>
      dispatchCommand(
        {
          type: "environment.provision",
          environmentId,
          initiator: null,
          workspaceProvisionType: "personal",
          targetPath: `${getPersonalWorkspaceRoot(dataDir)}/${environmentId}/../env_other`,
        },
        harness.dispatchOptions({ dataDir }),
      ),
    ).rejects.toThrow("Personal workspace target path must match");
    expect(harness.provisions).toEqual([]);
  });

  it("streams live events and flushes when initiator is provided", async () => {
    const harness = createHarness({ workspacePath: "/tmp/live-stream" });
    const sourcePath = await makeTempDir("bb-dispatch-stream-");
    const emittedEvents: EventSinkInput[] = [];
    let flushCount = 0;

    const result = await dispatchCommand(
      {
        type: "environment.provision",
        environmentId: "env-stream",
        initiator: {
          threadId: "thr-initiator",
          provisioningId: "tpv-initiator",
        },
        workspaceProvisionType: "unmanaged",
        path: sourcePath,
      },
      makeDispatchOptions({
        runtimeManager: harness.manager,
        eventSink: {
          emit: (event) => {
            emittedEvents.push(event);
          },
          flush: async () => {
            flushCount += 1;
          },
        },
      }),
    );

    expect(flushCount).toBe(1);
    expect(emittedEvents.length).toBeGreaterThan(0);
    const firstEvent = emittedEvents[0];
    expect(firstEvent?.threadId).toBe("thr-initiator");
    expect(
      firstEvent && "environmentId" in firstEvent.event
        ? firstEvent.event.environmentId
        : undefined,
    ).toBe("env-stream");
    expect(result.transcript.length).toBeGreaterThan(0);
    expect(result.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "workspace-path" }),
        expect.objectContaining({ key: "workspace-branch" }),
      ]),
    );
  });

  it("batches live provisioning entries before flushing", async () => {
    const { workspace } = createFakeWorkspace("/tmp/batched-progress");
    const { runtime } = createFakeRuntime();
    const emittedEvents: EventSinkInput[] = [];
    const eventCountsAtFlush: number[] = [];
    const manager = new RuntimeManager({
      provisionWorkspace: async (options) => {
        options.onProgress?.({
          type: "step",
          key: "setup-output-0",
          text: "install line 0",
          status: "completed",
          startedAt: Date.now(),
        });
        options.onProgress?.({
          type: "step",
          key: "setup-output-1",
          text: "install line 1",
          status: "completed",
          startedAt: Date.now(),
        });
        options.onProgress?.({
          type: "step",
          key: "setup-output-2",
          text: "install line 2",
          status: "completed",
          startedAt: Date.now(),
        });
        return workspace;
      },
      createRuntime: () => runtime,
    });

    const result = await dispatchCommand(
      {
        type: "environment.provision",
        environmentId: "env-batched-progress",
        initiator: {
          threadId: "thr-batched-progress",
          provisioningId: "tpv-batched-progress",
        },
        workspaceProvisionType: "unmanaged",
        path: "/tmp/batched-progress",
      },
      makeDispatchOptions({
        runtimeManager: manager,
        eventSink: {
          emit: (event) => {
            emittedEvents.push(event);
          },
          flush: async () => {
            eventCountsAtFlush.push(emittedEvents.length);
          },
        },
      }),
    );

    expect(emittedEvents).toHaveLength(1);
    expect(eventCountsAtFlush).toEqual([1]);
    const event = emittedEvents[0]?.event;
    if (!event || event.type !== "system/thread-provisioning") {
      throw new Error("Expected thread provisioning event");
    }
    const entryKeys = event.entries.map((entry) => entry.key);
    expect(entryKeys).toEqual([
      "setup-output-0",
      "setup-output-1",
      "setup-output-2",
      "workspace-path",
      "workspace-branch",
    ]);
    expect(result.transcript.map((entry) => entry.key)).toEqual(entryKeys);
  });

  it("flushes live events before surfacing provisioning failures", async () => {
    const emittedEvents: EventSinkInput[] = [];
    let flushCount = 0;
    const manager = new RuntimeManager({
      provisionWorkspace: async (options) => {
        options.onProgress?.({
          type: "step",
          key: "git-worktree",
          text: "git worktree add -B bb/failure /tmp/failure",
          status: "started",
          startedAt: Date.now(),
        });
        throw new WorkspaceError(
          "git_command_failed",
          "git worktree add failed",
        );
      },
      createRuntime: () => createFakeRuntime().runtime,
    });

    await expect(() =>
      dispatchCommand(
        {
          type: "environment.provision",
          environmentId: "env-failure",
          initiator: {
            threadId: "thr-failure",
            provisioningId: "tpv-failure",
          },
          workspaceProvisionType: "managed-worktree",
          sourcePath: "/tmp/source",
          targetPath: "/tmp/failure",
          branchName: "bb/failure",
          baseBranch: "main",
          setupTimeoutMs: 900000,
        },
        makeDispatchOptions({
          runtimeManager: manager,
          eventSink: {
            emit: (event) => {
              emittedEvents.push(event);
            },
            flush: async () => {
              flushCount += 1;
            },
          },
        }),
      ),
    ).rejects.toThrow("git worktree add failed");

    expect(emittedEvents).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({ environmentId: "env-failure" }),
        threadId: "thr-failure",
      }),
    ]);
    expect(flushCount).toBe(1);
  });

  it("returns empty transcript when environment already exists", async () => {
    const harness = createHarness({ workspacePath: "/tmp/idempotent" });
    const sourcePath = await makeTempDir("bb-dispatch-idempotent-");

    await dispatchCommand(
      {
        type: "environment.provision",
        environmentId: "env-idempotent",
        initiator: null,
        workspaceProvisionType: "unmanaged",
        path: sourcePath,
      },
      harness.dispatchOptions(),
    );

    const result = await dispatchCommand(
      {
        type: "environment.provision",
        environmentId: "env-idempotent",
        initiator: {
          threadId: "thr-second",
          provisioningId: "tpv-second",
        },
        workspaceProvisionType: "unmanaged",
        path: sourcePath,
      },
      harness.dispatchOptions(),
    );

    expect(result.transcript).toEqual([]);
  });

  it("covers environment.destroy", async () => {
    const harness = createHarness();
    const closeEnvironmentTerminals = vi.fn(async () => undefined);
    await harness.manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    const result = await dispatchCommand(
      {
        type: "environment.destroy",
        environmentId: "env-1",
        teardownTimeoutMs: 900000,
        workspaceContext: {
          workspacePath: "/tmp/env-1",
          workspaceProvisionType: "managed-worktree",
        },
      },
      makeDispatchOptions({
        runtimeManager: harness.manager,
        terminalManager: { closeEnvironmentTerminals },
      }),
    );

    expect(result).toEqual({ transcript: [] });
    expect(closeEnvironmentTerminals).toHaveBeenCalledWith({
      environmentId: "env-1",
      reason: "environment-destroyed",
    });
    expect(harness.runtimeState.shutdownCount).toBe(1);
    expect(harness.workspaceState.destroyed).toBe(true);
  });

  it("returns the teardown transcript from environment.destroy", async () => {
    const harness = createHarness();
    await harness.manager.ensureEnvironment({
      environmentId: "env-teardown",
      workspacePath: "/tmp/env-1",
    });
    harness.workspace.destroy = async (args) => {
      expect(args.timeoutMs).toBe(1234);
      args.onProgress?.({
        type: "step",
        key: "teardown-completed",
        text: ".bb-env-teardown.sh finished",
        status: "completed",
        startedAt: 100,
      });
    };

    const result = await dispatchCommand(
      {
        type: "environment.destroy",
        environmentId: "env-teardown",
        teardownTimeoutMs: 1234,
        workspaceContext: {
          workspacePath: "/tmp/env-1",
          workspaceProvisionType: "managed-worktree",
        },
      },
      makeDispatchOptions({ runtimeManager: harness.manager }),
    );

    expect(result.transcript).toEqual([
      {
        type: "step",
        key: "teardown-completed",
        text: ".bb-env-teardown.sh finished",
        status: "completed",
        startedAt: 100,
      },
    ]);
  });

  it("waits for terminal closes before destroying an environment", async () => {
    const harness = createHarness();
    const terminalClose = createDeferredPromise<void>();
    const closeEnvironmentTerminals = vi.fn(() => terminalClose.promise);
    await harness.manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    let destroyResolved = false;
    const destroyPromise = dispatchCommand(
      {
        type: "environment.destroy",
        environmentId: "env-1",
        teardownTimeoutMs: 900000,
        workspaceContext: {
          workspacePath: "/tmp/env-1",
          workspaceProvisionType: "managed-worktree",
        },
      },
      makeDispatchOptions({
        runtimeManager: harness.manager,
        terminalManager: { closeEnvironmentTerminals },
      }),
    ).then((result) => {
      destroyResolved = true;
      return result;
    });

    await vi.waitFor(() =>
      expect(closeEnvironmentTerminals).toHaveBeenCalledWith({
        environmentId: "env-1",
        reason: "environment-destroyed",
      }),
    );
    expect(destroyResolved).toBe(false);
    expect(harness.runtimeState.shutdownCount).toBe(0);
    expect(harness.workspaceState.destroyed).toBe(false);

    terminalClose.resolve(undefined);
    await expect(destroyPromise).resolves.toEqual({ transcript: [] });
    expect(destroyResolved).toBe(true);
    expect(harness.runtimeState.shutdownCount).toBe(1);
    expect(harness.workspaceState.destroyed).toBe(true);
  });

  it("waits for in-progress terminal opens to close before destroying an environment", async () => {
    const harness = createHarness();
    const shell = createDeferredPromise<string>();
    let resolveShellCalls = 0;
    const terminalFixture = createTerminalManager({
      manager: harness.manager,
      resolveShell: () => {
        resolveShellCalls += 1;
        return shell.promise;
      },
    });
    const dispatchOptions = makeDispatchOptions({
      runtimeManager: harness.manager,
      terminalManager: terminalFixture.manager,
    });

    const openPromise = terminalFixture.manager.handleMessage({
      type: "terminal.open",
      requestId: "open-1",
      terminalId: "term-1",
      threadId: "thr-1",
      target: {
        kind: "workspace",
        environmentId: "env-1",
        workspaceContext: {
          workspacePath: "/tmp/env-1",
          workspaceProvisionType: "managed-worktree",
        },
      },
      cols: 100,
      rows: 30,
      start: DEFAULT_TERMINAL_START,
    });
    await vi.waitFor(() => expect(resolveShellCalls).toBe(1));

    let destroyResolved = false;
    const destroyPromise = dispatchCommand(
      {
        type: "environment.destroy",
        environmentId: "env-1",
        teardownTimeoutMs: 900000,
        workspaceContext: {
          workspacePath: "/tmp/env-1",
          workspaceProvisionType: "managed-worktree",
        },
      },
      dispatchOptions,
    ).then((result) => {
      destroyResolved = true;
      return result;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(destroyResolved).toBe(false);
    expect(harness.runtimeState.shutdownCount).toBe(0);
    expect(harness.workspaceState.destroyed).toBe(false);

    shell.resolve("/bin/zsh");
    await Promise.all([openPromise, destroyPromise]);

    const pty = terminalFixture.adapter.spawned[0]?.pty;
    if (!pty) {
      throw new Error("Expected terminal PTY to spawn");
    }
    expect(pty.killCalls).toEqual([null]);
    expect(harness.runtimeState.shutdownCount).toBe(1);
    expect(harness.workspaceState.destroyed).toBe(true);
    expect(destroyResolved).toBe(true);
  });

  it("destroys a managed environment after daemon restart (not in memory)", async () => {
    const harness = createHarness();
    const result = await dispatchCommand(
      {
        type: "environment.destroy",
        environmentId: "env-restart",
        teardownTimeoutMs: 900000,
        workspaceContext: {
          workspacePath: "/tmp/env-1",
          workspaceProvisionType: "managed-worktree",
        },
      },
      makeDispatchOptions({ runtimeManager: harness.manager }),
    );

    expect(result).toEqual({ transcript: [] });
    expect(harness.workspaceState.destroyed).toBe(true);
    expect(harness.provisions).toEqual([
      {
        workspaceProvisionType: "reconnect-managed-worktree",
        path: "/tmp/env-1",
        signal: expect.any(AbortSignal),
      },
    ]);
  });

  it("treats a retry as success when the workspace was already removed", async () => {
    let callCount = 0;
    const { workspace } = createFakeWorkspace("/tmp/env-retry");
    const { runtime } = createFakeRuntime();
    const manager = new RuntimeManager({
      provisionWorkspace: async () => {
        callCount++;
        if (callCount > 1) {
          throw new WorkspaceError(
            "path_not_found",
            "Managed workspace path does not exist: /tmp/env-retry",
          );
        }
        return workspace;
      },
      createRuntime: () => runtime,
    });

    await dispatchCommand(
      {
        type: "environment.destroy",
        environmentId: "env-retry",
        teardownTimeoutMs: 900000,
        workspaceContext: {
          workspacePath: "/tmp/env-retry",
          workspaceProvisionType: "managed-worktree",
        },
      },
      makeDispatchOptions({ runtimeManager: manager }),
    );

    const retryResult = await dispatchCommand(
      {
        type: "environment.destroy",
        environmentId: "env-retry",
        teardownTimeoutMs: 900000,
        workspaceContext: {
          workspacePath: "/tmp/env-retry",
          workspaceProvisionType: "managed-worktree",
        },
      },
      makeDispatchOptions({ runtimeManager: manager }),
    );

    expect(retryResult).toEqual({ transcript: [] });
  });
});

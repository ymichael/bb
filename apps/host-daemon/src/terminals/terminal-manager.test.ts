import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@bb/agent-runtime";
import type { HostDaemonDaemonWsMessage } from "@bb/host-daemon-contract";
import type { HostWorkspace } from "@bb/host-workspace";
import {
  createDeferredPromise,
  makeWorkspaceMergeBase,
  makeWorkspaceStatus,
} from "@bb/test-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostDaemonLogger } from "../logger.js";
import { RuntimeManager } from "../runtime-manager.js";
import {
  ensureNodePtySpawnHelpersExecutableInPackage,
  resolveNodePtySpawnHelperPaths,
  TerminalManager,
  type ResolveTerminalShell,
  type SpawnTerminalPtyArgs,
  type TerminalPtyAdapter,
  type TerminalPtyDisposable,
  type TerminalPtyExit,
  type TerminalPtyProcess,
} from "./terminal-manager.js";

const tempDirs: string[] = [];
const DEFAULT_TERMINAL_START = { mode: "shell" } as const;

interface ResizeCall {
  cols: number;
  rows: number;
}

interface SpawnedTerminal {
  args: SpawnTerminalPtyArgs;
  pty: FakeTerminalPty;
}

interface TerminalManagerHarness {
  adapter: FakeTerminalPtyAdapter;
  manager: TerminalManager;
  messages: HostDaemonDaemonWsMessage[];
  runtime: AgentRuntime;
  runtimeManager: RuntimeManager;
  workspace: HostWorkspace;
}

interface WaitForOutputArgs {
  messages: HostDaemonDaemonWsMessage[];
  text: string;
}

type TerminalMessageObserver = (message: HostDaemonDaemonWsMessage) => void;

interface CreateHarnessOptions {
  closeGracePeriodMs?: number;
  onSendMessage: TerminalMessageObserver;
  resolveShell: ResolveTerminalShell;
}

interface CreateHarnessWithShellArgs {
  resolveShell: ResolveTerminalShell;
}

type SteerTurnResult = Awaited<ReturnType<AgentRuntime["steerTurn"]>>;

async function makeTempDir(prefix: string): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

async function writeEmptyFile(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "");
}

function createFakeLogger(): HostDaemonLogger {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

async function cleanupTempDirs(): Promise<void> {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((tempDir) => fs.rm(tempDir, { force: true, recursive: true })),
  );
}

class FakeTerminalPty implements TerminalPtyProcess {
  disposeCount: number;
  readonly killCalls: (string | null)[];
  readonly resizeCalls: ResizeCall[];
  readonly writeCalls: (Buffer | string)[];
  private readonly dataListeners: ((data: string) => void)[];
  private readonly exitListeners: ((event: TerminalPtyExit) => void)[];
  private readonly registeredDataListeners: ((data: string) => void)[];
  private readonly registeredExitListeners: ((
    event: TerminalPtyExit,
  ) => void)[];

  constructor() {
    this.disposeCount = 0;
    this.killCalls = [];
    this.resizeCalls = [];
    this.writeCalls = [];
    this.dataListeners = [];
    this.exitListeners = [];
    this.registeredDataListeners = [];
    this.registeredExitListeners = [];
  }

  dispose(): void {
    this.disposeCount += 1;
  }

  kill(signal?: string): void {
    this.killCalls.push(signal ?? null);
  }

  onData(listener: (data: string) => void): TerminalPtyDisposable {
    this.dataListeners.push(listener);
    this.registeredDataListeners.push(listener);
    return {
      dispose: () => {
        const index = this.dataListeners.indexOf(listener);
        if (index >= 0) {
          this.dataListeners.splice(index, 1);
        }
      },
    };
  }

  onExit(listener: (event: TerminalPtyExit) => void): TerminalPtyDisposable {
    this.exitListeners.push(listener);
    this.registeredExitListeners.push(listener);
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

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitExit(exitCode: number): void {
    for (const listener of [...this.exitListeners]) {
      listener({ exitCode });
    }
  }

  emitStaleData(data: string): void {
    for (const listener of [...this.registeredDataListeners]) {
      listener(data);
    }
  }

  emitStaleExit(exitCode: number): void {
    for (const listener of [...this.registeredExitListeners]) {
      listener({ exitCode });
    }
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

function createFakeRuntime(): AgentRuntime {
  const steerTurnResult: SteerTurnResult = { status: "steered" };
  return {
    ensureProvider: vi.fn(async () => undefined),
    startThread: vi.fn(async () => ({
      providerThreadId: "provider-thread",
    })),
    prepareThreadRewind: vi.fn(async () => ({
      providerThreadId: "provider-thread-rewind",
    })),
    discardThreadRewind: vi.fn(async () => undefined),
    resumeThread: vi.fn(async () => ({
      providerThreadId: "provider-thread",
    })),
    runTurn: vi.fn(async () => undefined),
    steerTurn: vi.fn(async () => steerTurnResult),
    stopThread: vi.fn(async () => ({ providerCheckpointId: null })),
    clearThreadGoal: vi.fn(async () => ({ cleared: true })),
    renameThread: vi.fn(async () => undefined),
    archiveThread: vi.fn(async () => undefined),
    unarchiveThread: vi.fn(async () => undefined),
    listModels: vi.fn(async () => ({ models: [], selectedOnlyModels: [] })),
    providerHealth: vi.fn(async () => ({ supported: false as const })),
    providerUsage: vi.fn(async () => ({ supported: false as const })),
    providerInstallationStatus: vi.fn(async () => {
      throw new Error("Unexpected provider installation status call");
    }),
    providerInstallationRun: vi.fn(async () => {
      throw new Error("Unexpected provider installation run call");
    }),
    listRunningProviders: vi.fn(() => []),
    getActiveTurnId: vi.fn(() => null),
    waitForActiveTurn: vi.fn(async () => null),
    getProviderSession: vi.fn(() => null),
    reapIdleProviderSessions: vi.fn(async () => ({ reapedSessions: [] })),
    hasThread: vi.fn(() => false),
    getLiveThreadIds: vi.fn(() => []),
    hasOpenBackgroundWork: vi.fn(() => false),
    shutdown: vi.fn(async () => undefined),
  };
}

function createFakeWorkspace(path: string): HostWorkspace {
  return {
    path,
    managed: false,
    isGitRepo: true,
    isWorktree: false,
    getCurrentBranch: vi.fn(async () => "main"),
    getHeadSha: vi.fn(async () => "commit-1"),
    getLocalStateFingerprint: vi.fn(async () => "local-1"),
    getSharedGitRefsFingerprint: vi.fn(async () => "refs-1"),
    getAdditionalWorkspaceWriteRoots: vi.fn(async () => []),
    getStatus: vi.fn(async () =>
      makeWorkspaceStatus({
        mergeBase: makeWorkspaceMergeBase(),
      }),
    ),
    getDefaultBranch: vi.fn(async () => "main"),
    getDiff: vi.fn(async () => ({
      diff: "",
      files: "",
      mergeBaseRef: null,
      shortstat: "",
      truncated: false,
    })),
    diffFiles: vi.fn(async () => ({
      files: [],
      shortstat: "",
      mergeBaseRef: null,
      truncated: false,
    })),
    diffPatch: vi.fn(async () => []),
    getPullRequest: vi.fn(async () => ({ outcome: "none" as const })),
    listFiles: vi.fn(async () => []),
    commit: vi.fn(async () => ({
      commitSha: "commit-1",
      commitSubject: "commit",
    })),
    reset: vi.fn(async () => undefined),
    runPullRequestAction: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
  };
}

function createHarness(): TerminalManagerHarness {
  return createHarnessWithShell({
    resolveShell: async () => "/bin/zsh",
  });
}

function createHarnessWithShell(
  args: CreateHarnessWithShellArgs,
): TerminalManagerHarness {
  return createHarnessWithOptions({
    onSendMessage: () => undefined,
    resolveShell: args.resolveShell,
  });
}

function createHarnessWithOptions(
  args: CreateHarnessOptions,
): TerminalManagerHarness {
  const adapter = new FakeTerminalPtyAdapter();
  const messages: HostDaemonDaemonWsMessage[] = [];
  const runtime = createFakeRuntime();
  const workspace = createFakeWorkspace("/tmp/terminal-workspace");
  const runtimeManager = new RuntimeManager({
    createRuntime: () => runtime,
    provisionWorkspace: async () => workspace,
    shellEnv: {
      BB_BASE_ENV: "1",
    },
  });
  const manager = new TerminalManager({
    closeGracePeriodMs: args.closeGracePeriodMs,
    logger: createFakeLogger(),
    ptyAdapter: adapter,
    resolveShell: args.resolveShell,
    runtimeManager,
    sendMessage: (message) => {
      messages.push(message);
      args.onSendMessage(message);
      return true;
    },
  });

  return {
    adapter,
    manager,
    messages,
    runtime,
    runtimeManager,
    workspace,
  };
}

function collectTerminalOutput(messages: HostDaemonDaemonWsMessage[]): string {
  return messages
    .flatMap((message) =>
      message.type === "terminal.output"
        ? [Buffer.from(message.chunk.dataBase64, "base64").toString("utf8")]
        : [],
    )
    .join("");
}

async function waitForOutputContaining(args: WaitForOutputArgs): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (collectTerminalOutput(args.messages).includes(args.text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for terminal output: ${args.text}\nCurrent output:\n${collectTerminalOutput(args.messages)}\nMessages:\n${JSON.stringify(args.messages)}`,
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function openTerminal(
  harness: TerminalManagerHarness,
): Promise<FakeTerminalPty> {
  await harness.manager.handleMessage({
    type: "terminal.open",
    requestId: "open-1",
    terminalId: "term-1",
    threadId: "thr-1",
    target: {
      kind: "workspace",
      environmentId: "env-1",
      workspaceContext: {
        workspacePath: "/tmp/terminal-workspace",
        workspaceProvisionType: "unmanaged",
      },
    },
    cols: 100,
    rows: 30,
    start: DEFAULT_TERMINAL_START,
  });
  const spawned = harness.adapter.spawned[0];
  if (!spawned) {
    throw new Error("Expected terminal PTY to spawn");
  }
  return spawned.pty;
}

describe("TerminalManager", () => {
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await cleanupTempDirs();
  });

  it("opens a PTY in the workspace and keeps the environment active", async () => {
    const harness = createHarness();
    await openTerminal(harness);

    expect(harness.adapter.spawned).toHaveLength(1);
    expect(harness.adapter.spawned[0]?.args).toMatchObject({
      cols: 100,
      cwd: "/tmp/terminal-workspace",
      file: "/bin/zsh",
      rows: 30,
    });
    expect(harness.adapter.spawned[0]?.args.env).toMatchObject({
      BB_BASE_ENV: "1",
      BB_TERMINAL_SESSION_ID: "term-1",
      COLORTERM: "truecolor",
      DISABLE_AUTO_TITLE: "true",
      FORCE_HYPERLINK: "1",
      PROMPT_EOL_MARK: "",
      TERM: "xterm-256color",
    });
    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        type: "terminal.opened",
        terminalId: "term-1",
        initialCwd: "/tmp/terminal-workspace",
        title: "zsh",
      }),
    );
    await expect(
      harness.runtimeManager.evictIdleEnvironments(),
    ).resolves.toEqual([]);
  });

  it("opens a command PTY through the resolved shell", async () => {
    const harness = createHarness();

    await harness.manager.handleMessage({
      type: "terminal.open",
      requestId: "open-command",
      terminalId: "term-command",
      threadId: "thr-1",
      target: {
        kind: "workspace",
        environmentId: "env-1",
        workspaceContext: {
          workspacePath: "/tmp/terminal-workspace",
          workspaceProvisionType: "unmanaged",
        },
      },
      cols: 100,
      rows: 30,
      start: { mode: "command", command: "pnpm dev" },
    });

    expect(harness.adapter.spawned[0]?.args).toMatchObject({
      args: ["-lc", "pnpm dev"],
      file: "/bin/zsh",
    });
    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        type: "terminal.opened",
        terminalId: "term-command",
        title: "pnpm dev",
      }),
    );
    await expect(
      harness.runtimeManager.evictIdleEnvironments(),
    ).resolves.toEqual([]);
  });

  it("opens a PTY in a host path without an environment", async () => {
    const cwd = await makeTempDir("bb-terminal-host-path-");
    const harness = createHarness();

    await harness.manager.handleMessage({
      type: "terminal.open",
      requestId: "open-host-path",
      terminalId: "term-host-path",
      target: {
        kind: "host_path",
        cwd,
      },
      cols: 80,
      rows: 24,
      start: DEFAULT_TERMINAL_START,
    });

    expect(harness.adapter.spawned).toHaveLength(1);
    expect(harness.adapter.spawned[0]?.args).toMatchObject({
      cols: 80,
      cwd,
      rows: 24,
    });
    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        type: "terminal.opened",
        terminalId: "term-host-path",
        initialCwd: cwd,
      }),
    );
    await expect(
      harness.runtimeManager.evictIdleEnvironments(),
    ).resolves.toEqual([]);
  });

  it("opens a host-path PTY in the home directory when no cwd is provided", async () => {
    const harness = createHarness();
    const expectedCwd = os.homedir();

    await harness.manager.handleMessage({
      type: "terminal.open",
      requestId: "open-host-home",
      terminalId: "term-host-home",
      target: {
        kind: "host_path",
        cwd: null,
      },
      cols: 80,
      rows: 24,
      start: DEFAULT_TERMINAL_START,
    });

    expect(harness.adapter.spawned).toHaveLength(1);
    expect(harness.adapter.spawned[0]?.args).toMatchObject({
      cwd: expectedCwd,
    });
    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        type: "terminal.opened",
        terminalId: "term-host-home",
        initialCwd: expectedCwd,
      }),
    );
    await expect(
      harness.runtimeManager.evictIdleEnvironments(),
    ).resolves.toEqual([]);
  });

  it("closes a terminal after an in-progress open finishes", async () => {
    const shell = createDeferredPromise<string>();
    let resolveShellCalls = 0;
    const harness = createHarnessWithShell({
      resolveShell: () => {
        resolveShellCalls += 1;
        return shell.promise;
      },
    });

    const openPromise = harness.manager.handleMessage({
      type: "terminal.open",
      requestId: "open-1",
      terminalId: "term-1",
      threadId: "thr-1",
      target: {
        kind: "workspace",
        environmentId: "env-1",
        workspaceContext: {
          workspacePath: "/tmp/terminal-workspace",
          workspaceProvisionType: "unmanaged",
        },
      },
      cols: 100,
      rows: 30,
      start: DEFAULT_TERMINAL_START,
    });
    await vi.waitFor(() => expect(resolveShellCalls).toBe(1));

    const closePromise = harness.manager.handleMessage({
      type: "terminal.close",
      terminalId: "term-1",
      reason: "user",
    });

    expect(harness.adapter.spawned).toHaveLength(0);
    shell.resolve("/bin/zsh");
    await Promise.all([openPromise, closePromise]);

    const pty = harness.adapter.spawned[0]?.pty;
    if (!pty) {
      throw new Error("Expected terminal PTY to spawn");
    }
    expect(harness.adapter.spawned).toHaveLength(1);
    expect(pty.killCalls).toEqual([null]);

    pty.emitExit(0);
    await vi.waitFor(() =>
      expect(
        harness.messages.filter(
          (message) => message.type === "terminal.exited",
        ),
      ).toEqual([
        {
          type: "terminal.exited",
          terminalId: "term-1",
          exitCode: 0,
          closeReason: "user",
        },
      ]),
    );
  });

  it("closes environment terminals after in-progress opens finish", async () => {
    const shell = createDeferredPromise<string>();
    let resolveShellCalls = 0;
    const harness = createHarnessWithShell({
      resolveShell: () => {
        resolveShellCalls += 1;
        return shell.promise;
      },
    });

    const openPromise = harness.manager.handleMessage({
      type: "terminal.open",
      requestId: "open-1",
      terminalId: "term-1",
      threadId: "thr-1",
      target: {
        kind: "workspace",
        environmentId: "env-1",
        workspaceContext: {
          workspacePath: "/tmp/terminal-workspace",
          workspaceProvisionType: "unmanaged",
        },
      },
      cols: 100,
      rows: 30,
      start: DEFAULT_TERMINAL_START,
    });
    await vi.waitFor(() => expect(resolveShellCalls).toBe(1));

    const closePromise = harness.manager.closeEnvironmentTerminals({
      environmentId: "env-1",
      reason: "environment-destroyed",
    });
    shell.resolve("/bin/zsh");
    await Promise.all([openPromise, closePromise]);

    const pty = harness.adapter.spawned[0]?.pty;
    if (!pty) {
      throw new Error("Expected terminal PTY to spawn");
    }
    await vi.waitFor(() => expect(pty.killCalls).toEqual([null]));

    pty.emitExit(0);
    await vi.waitFor(() =>
      expect(
        harness.messages.filter(
          (message) => message.type === "terminal.exited",
        ),
      ).toEqual([
        {
          type: "terminal.exited",
          terminalId: "term-1",
          exitCode: 0,
          closeReason: "environment-destroyed",
        },
      ]),
    );
  });

  it("shuts down terminals after in-progress opens finish", async () => {
    const shell = createDeferredPromise<string>();
    let resolveShellCalls = 0;
    const harness = createHarnessWithShell({
      resolveShell: () => {
        resolveShellCalls += 1;
        return shell.promise;
      },
    });

    const openPromise = harness.manager.handleMessage({
      type: "terminal.open",
      requestId: "open-1",
      terminalId: "term-1",
      threadId: "thr-1",
      target: {
        kind: "workspace",
        environmentId: "env-1",
        workspaceContext: {
          workspacePath: "/tmp/terminal-workspace",
          workspaceProvisionType: "unmanaged",
        },
      },
      cols: 100,
      rows: 30,
      start: DEFAULT_TERMINAL_START,
    });
    await vi.waitFor(() => expect(resolveShellCalls).toBe(1));

    const shutdownPromise = harness.manager.shutdownAll();
    shell.resolve("/bin/zsh");
    await Promise.all([openPromise, shutdownPromise]);

    const pty = harness.adapter.spawned[0]?.pty;
    if (!pty) {
      throw new Error("Expected terminal PTY to spawn");
    }
    expect(pty.killCalls).toEqual([null]);
    expect(
      harness.messages.filter((message) => message.type === "terminal.exited"),
    ).toEqual([
      {
        type: "terminal.exited",
        terminalId: "term-1",
        exitCode: null,
        closeReason: "daemon-disconnect",
      },
    ]);
  });

  it("rejects duplicate opens queued behind an in-progress open", async () => {
    const shell = createDeferredPromise<string>();
    let resolveShellCalls = 0;
    const harness = createHarnessWithShell({
      resolveShell: () => {
        resolveShellCalls += 1;
        return shell.promise;
      },
    });

    const firstOpenPromise = harness.manager.handleMessage({
      type: "terminal.open",
      requestId: "open-1",
      terminalId: "term-1",
      threadId: "thr-1",
      target: {
        kind: "workspace",
        environmentId: "env-1",
        workspaceContext: {
          workspacePath: "/tmp/terminal-workspace",
          workspaceProvisionType: "unmanaged",
        },
      },
      cols: 100,
      rows: 30,
      start: DEFAULT_TERMINAL_START,
    });
    await vi.waitFor(() => expect(resolveShellCalls).toBe(1));

    const secondOpenPromise = harness.manager.handleMessage({
      type: "terminal.open",
      requestId: "open-2",
      terminalId: "term-1",
      threadId: "thr-1",
      target: {
        kind: "workspace",
        environmentId: "env-1",
        workspaceContext: {
          workspacePath: "/tmp/terminal-workspace",
          workspaceProvisionType: "unmanaged",
        },
      },
      cols: 100,
      rows: 30,
      start: DEFAULT_TERMINAL_START,
    });

    shell.resolve("/bin/zsh");
    await Promise.all([firstOpenPromise, secondOpenPromise]);

    expect(harness.adapter.spawned).toHaveLength(1);
    expect(resolveShellCalls).toBe(1);
    expect(harness.messages).toContainEqual({
      type: "terminal.error",
      requestId: "open-2",
      terminalId: "term-1",
      code: "terminal_exists",
      message: "Terminal session is already open",
    });
  });

  it("serializes PTY exits behind already queued terminal messages", async () => {
    const shell = createDeferredPromise<string>();
    let resolveShellCalls = 0;
    let exitOnOpened = false;
    let harness: TerminalManagerHarness | null = null;
    harness = createHarnessWithOptions({
      onSendMessage: (message) => {
        if (!exitOnOpened || message.type !== "terminal.opened") {
          return;
        }
        const currentHarness = harness;
        const pty = currentHarness?.adapter.spawned[0]?.pty;
        if (!pty) {
          throw new Error("Expected terminal PTY to spawn");
        }
        pty.emitExit(0);
      },
      resolveShell: () => {
        resolveShellCalls += 1;
        return shell.promise;
      },
    });

    const firstOpenPromise = harness.manager.handleMessage({
      type: "terminal.open",
      requestId: "open-1",
      terminalId: "term-1",
      threadId: "thr-1",
      target: {
        kind: "workspace",
        environmentId: "env-1",
        workspaceContext: {
          workspacePath: "/tmp/terminal-workspace",
          workspaceProvisionType: "unmanaged",
        },
      },
      cols: 100,
      rows: 30,
      start: DEFAULT_TERMINAL_START,
    });
    await vi.waitFor(() => expect(resolveShellCalls).toBe(1));

    const secondOpenPromise = harness.manager.handleMessage({
      type: "terminal.open",
      requestId: "open-2",
      terminalId: "term-1",
      threadId: "thr-1",
      target: {
        kind: "workspace",
        environmentId: "env-1",
        workspaceContext: {
          workspacePath: "/tmp/terminal-workspace",
          workspaceProvisionType: "unmanaged",
        },
      },
      cols: 100,
      rows: 30,
      start: DEFAULT_TERMINAL_START,
    });

    exitOnOpened = true;
    shell.resolve("/bin/zsh");
    await Promise.all([firstOpenPromise, secondOpenPromise]);

    expect(harness.adapter.spawned).toHaveLength(1);
    await vi.waitFor(() =>
      expect(
        harness.messages.filter(
          (message) =>
            message.type === "terminal.opened" ||
            message.type === "terminal.error" ||
            message.type === "terminal.exited",
        ),
      ).toEqual([
        expect.objectContaining({
          type: "terminal.opened",
          requestId: "open-1",
          terminalId: "term-1",
        }),
        {
          type: "terminal.error",
          requestId: "open-2",
          terminalId: "term-1",
          code: "terminal_exists",
          message: "Terminal session is already open",
        },
        {
          type: "terminal.exited",
          terminalId: "term-1",
          exitCode: 0,
          closeReason: "process-exit",
        },
      ]),
    );
  });

  it("rejects terminal opens when the loaded runtime path differs from workspaceContext", async () => {
    const harness = createHarness();
    await harness.runtimeManager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/terminal-workspace",
    });

    await harness.manager.handleMessage({
      type: "terminal.open",
      requestId: "open-stale",
      terminalId: "term-stale",
      threadId: "thr-1",
      target: {
        kind: "workspace",
        environmentId: "env-1",
        workspaceContext: {
          workspacePath: "/tmp/stale-terminal-workspace",
          workspaceProvisionType: "unmanaged",
        },
      },
      cols: 100,
      rows: 30,
      start: DEFAULT_TERMINAL_START,
    });

    expect(harness.adapter.spawned).toHaveLength(0);
    expect(harness.messages).toEqual([
      {
        type: "terminal.error",
        requestId: "open-stale",
        terminalId: "term-stale",
        code: "workspace_type_mismatch",
        message:
          "Loaded environment env-1 is bound to /tmp/terminal-workspace, not /tmp/stale-terminal-workspace",
      },
    ]);
  });

  it("scrubs inherited bb runtime env vars before spawning a terminal", async () => {
    vi.stubEnv("BB_DATA_DIR", "/tmp/leaked-bb-data");
    vi.stubEnv("BB_HOST_DAEMON_PORT", "38887");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("OPENAI_API_KEY", "external-secret");

    const harness = createHarness();
    await openTerminal(harness);

    const env = harness.adapter.spawned[0]?.args.env;
    expect(env).toMatchObject({
      BB_BASE_ENV: "1",
      BB_TERMINAL_SESSION_ID: "term-1",
      OPENAI_API_KEY: "external-secret",
    });
    expect(env?.BB_DATA_DIR).toBeUndefined();
    expect(env?.BB_HOST_DAEMON_PORT).toBeUndefined();
    expect(env?.NODE_ENV).toBeUndefined();
  });

  it("makes every available node-pty spawn-helper executable", async () => {
    const logger = createFakeLogger();
    const packageDirectory = await makeTempDir("bb-node-pty-package-");
    const buildNativePath = path.join(
      packageDirectory,
      "build",
      "Release",
      "pty.node",
    );
    const buildHelperPath = path.join(
      packageDirectory,
      "build",
      "Release",
      "spawn-helper",
    );
    const prebuildHelperPath = path.join(
      packageDirectory,
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    );
    await writeEmptyFile(buildNativePath);
    await writeEmptyFile(buildHelperPath);
    await fs.chmod(buildHelperPath, 0o644);
    await writeEmptyFile(
      path.join(
        packageDirectory,
        "prebuilds",
        `${process.platform}-${process.arch}`,
        "pty.node",
      ),
    );
    await writeEmptyFile(prebuildHelperPath);
    await fs.chmod(prebuildHelperPath, 0o644);

    expect(resolveNodePtySpawnHelperPaths({ packageDirectory })).toEqual([
      buildHelperPath,
      prebuildHelperPath,
    ]);

    ensureNodePtySpawnHelpersExecutableInPackage({
      logger,
      packageDirectory,
    });

    const buildHelperMode = (await fs.stat(buildHelperPath)).mode;
    const prebuildHelperMode = (await fs.stat(prebuildHelperPath)).mode;
    expect(buildHelperMode & 0o111).not.toBe(0);
    expect(prebuildHelperMode & 0o111).not.toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("makes an available prebuild-only node-pty spawn-helper executable", async () => {
    const logger = createFakeLogger();
    const packageDirectory = await makeTempDir("bb-node-pty-package-");
    const prebuildHelperPath = path.join(
      packageDirectory,
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    );
    await writeEmptyFile(
      path.join(
        packageDirectory,
        "prebuilds",
        `${process.platform}-${process.arch}`,
        "pty.node",
      ),
    );
    await writeEmptyFile(prebuildHelperPath);
    await fs.chmod(prebuildHelperPath, 0o644);

    expect(resolveNodePtySpawnHelperPaths({ packageDirectory })).toEqual([
      prebuildHelperPath,
    ]);

    ensureNodePtySpawnHelpersExecutableInPackage({
      logger,
      packageDirectory,
    });

    const prebuildHelperMode = (await fs.stat(prebuildHelperPath)).mode;
    expect(prebuildHelperMode & 0o111).not.toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs and skips when no node-pty spawn-helper is present", async () => {
    const logger = createFakeLogger();
    const packageDirectory = await makeTempDir("bb-node-pty-package-");
    const buildHelperPath = path.join(
      packageDirectory,
      "build",
      "Release",
      "spawn-helper",
    );
    const prebuildHelperPath = path.join(
      packageDirectory,
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    );
    await writeEmptyFile(
      path.join(packageDirectory, "build", "Release", "pty.node"),
    );
    await writeEmptyFile(
      path.join(
        packageDirectory,
        "prebuilds",
        `${process.platform}-${process.arch}`,
        "pty.node",
      ),
    );

    expect(() =>
      ensureNodePtySpawnHelpersExecutableInPackage({
        logger,
        packageDirectory,
      }),
    ).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith({
      component: "terminal-manager",
      msg: "no node-pty spawn-helper found at known paths",
      searched: expect.arrayContaining([buildHelperPath, prebuildHelperPath]),
    });
  });

  it("forwards output and replays scrollback on attach", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    pty.emitData("hello");
    pty.emitData("\n");
    await harness.manager.handleMessage({
      type: "terminal.attach",
      requestId: "attach-1",
      terminalId: "term-1",
      sinceSeq: 0,
      tailBytes: 4 * 1024 * 1024,
    });

    expect(
      harness.messages.filter((message) => message.type === "terminal.output"),
    ).toEqual([
      {
        type: "terminal.output",
        terminalId: "term-1",
        chunk: {
          seq: 0,
          dataBase64: Buffer.from("hello\n", "utf8").toString("base64"),
        },
      },
    ]);
    expect(harness.messages).toContainEqual({
      type: "terminal.replay",
      requestId: "attach-1",
      terminalId: "term-1",
      chunks: [
        {
          seq: 0,
          dataBase64: Buffer.from("hello\n", "utf8").toString("base64"),
        },
      ],
      replayStartSeq: 0,
      nextSeq: 1,
    });
  });

  it("answers primary device attribute queries without replaying them", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    pty.emitData("before\u001b[0cbetween\u001b[cafter");
    await harness.manager.handleMessage({
      type: "terminal.attach",
      requestId: "attach-da1",
      terminalId: "term-1",
      sinceSeq: 0,
      tailBytes: 4 * 1024 * 1024,
    });

    expect(pty.writeCalls).toEqual(["\u001b[?1;2c\u001b[?1;2c"]);
    expect(collectTerminalOutput(harness.messages)).toBe("beforebetweenafter");
    expect(harness.messages).toContainEqual({
      type: "terminal.replay",
      requestId: "attach-da1",
      terminalId: "term-1",
      chunks: [
        {
          seq: 0,
          dataBase64: Buffer.from("beforebetweenafter", "utf8").toString(
            "base64",
          ),
        },
      ],
      replayStartSeq: 0,
      nextSeq: 1,
    });
  });

  it("answers primary device attribute queries split across output chunks", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    for (const chunk of ["\u001b", "[", "0", "c", "\u001b[", "c"]) {
      pty.emitData(chunk);
    }
    await harness.manager.handleMessage({
      type: "terminal.attach",
      requestId: "attach-split-da1",
      terminalId: "term-1",
      sinceSeq: 0,
      tailBytes: 4 * 1024 * 1024,
    });

    expect(pty.writeCalls).toEqual(["\u001b[?1;2c", "\u001b[?1;2c"]);
    expect(collectTerminalOutput(harness.messages)).toBe("");
    expect(harness.messages).toContainEqual({
      type: "terminal.replay",
      requestId: "attach-split-da1",
      terminalId: "term-1",
      chunks: [],
      replayStartSeq: 0,
      nextSeq: 0,
    });
  });

  it("bounds device attribute replies for one flooded output chunk", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    pty.emitData("\u001b[c".repeat(5_000));

    expect(pty.writeCalls).toEqual(["\u001b[?1;2c".repeat(8)]);
    expect(collectTerminalOutput(harness.messages)).toBe("");
  });

  it("preserves near matches and incomplete device attribute queries on exit", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    pty.emitData("before\u001b[1cafter\u001b[0");
    pty.emitExit(0);

    expect(pty.writeCalls).toEqual([]);
    expect(collectTerminalOutput(harness.messages)).toBe(
      "before\u001b[1cafter\u001b[0",
    );
    expect(
      harness.messages
        .filter(
          (message) =>
            message.type === "terminal.output" ||
            message.type === "terminal.exited",
        )
        .map((message) => message.type),
    ).toEqual(["terminal.output", "terminal.exited"]);
  });

  it("bounds replay to the requested tail without splitting output chunks", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    pty.emitData(`${"a".repeat(64 * 1024)}tail`);
    await harness.manager.handleMessage({
      type: "terminal.attach",
      requestId: "attach-tail",
      terminalId: "term-1",
      sinceSeq: 0,
      tailBytes: 4,
    });

    expect(harness.messages).toContainEqual({
      type: "terminal.replay",
      requestId: "attach-tail",
      terminalId: "term-1",
      chunks: [
        {
          seq: 1,
          dataBase64: Buffer.from("tail", "utf8").toString("base64"),
        },
      ],
      replayStartSeq: 1,
      nextSeq: 2,
    });
  });

  it("flushes pending output before the PTY exit message", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    pty.emitData("final output");
    pty.emitExit(0);

    expect(
      harness.messages
        .filter(
          (message) =>
            message.type === "terminal.output" ||
            message.type === "terminal.exited",
        )
        .map((message) => message.type),
    ).toEqual(["terminal.output", "terminal.exited"]);
    expect(collectTerminalOutput(harness.messages)).toBe("final output");
  });

  it("writes input and resizes the active PTY", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    await harness.manager.handleMessage({
      type: "terminal.input",
      terminalId: "term-1",
      dataBase64: Buffer.from("pwd\n", "utf8").toString("base64"),
    });
    await harness.manager.handleMessage({
      type: "terminal.resize",
      terminalId: "term-1",
      cols: 120,
      rows: 40,
    });
    await harness.manager.handleMessage({
      type: "terminal.resize",
      terminalId: "term-1",
      cols: 120,
      rows: 40,
    });

    expect(pty.writeCalls).toHaveLength(1);
    expect(pty.writeCalls[0]).toEqual(Buffer.from("pwd\n"));
    expect(pty.resizeCalls).toEqual([{ cols: 120, rows: 40 }]);
  });

  it("kills a terminal and emits exactly one user exit", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    await harness.manager.handleMessage({
      type: "terminal.close",
      terminalId: "term-1",
      reason: "user",
    });
    pty.emitExit(0);
    pty.emitExit(0);

    expect(pty.killCalls).toEqual([null]);
    expect(
      harness.messages.filter((message) => message.type === "terminal.exited"),
    ).toEqual([
      {
        type: "terminal.exited",
        terminalId: "term-1",
        exitCode: 0,
        closeReason: "user",
      },
    ]);
    await expect(
      harness.runtimeManager.evictIdleEnvironments(),
    ).resolves.toEqual(["env-1"]);
    expect(harness.runtime.shutdown).toHaveBeenCalledTimes(1);
  });

  it("acknowledges closing a terminal that is already gone", async () => {
    const harness = createHarness();

    await harness.manager.handleMessage({
      type: "terminal.close",
      terminalId: "term-missing",
      reason: "user",
    });

    expect(harness.messages).toEqual([
      {
        type: "terminal.exited",
        terminalId: "term-missing",
        exitCode: null,
        closeReason: "user",
      },
    ]);
  });

  it("force kills and cleans up a terminal when node-pty never emits exit", async () => {
    vi.useFakeTimers();
    const harness = createHarnessWithOptions({
      closeGracePeriodMs: 10,
      onSendMessage: () => undefined,
      resolveShell: async () => "/bin/zsh",
    });
    const pty = await openTerminal(harness);

    await harness.manager.handleMessage({
      type: "terminal.close",
      terminalId: "term-1",
      reason: "user",
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(pty.killCalls).toEqual([null, "SIGKILL"]);
    expect(pty.disposeCount).toBe(1);
    expect(
      harness.messages.filter((message) => message.type === "terminal.exited"),
    ).toEqual([
      {
        type: "terminal.exited",
        terminalId: "term-1",
        exitCode: null,
        closeReason: "user",
      },
    ]);
    await expect(
      harness.runtimeManager.evictIdleEnvironments(),
    ).resolves.toEqual(["env-1"]);
  });

  it("kills all terminals on shutdown", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    await harness.manager.shutdownAll();
    pty.emitExit(0);

    expect(pty.killCalls).toEqual([null]);
    expect(
      harness.messages.filter((message) => message.type === "terminal.exited"),
    ).toEqual([
      {
        type: "terminal.exited",
        terminalId: "term-1",
        exitCode: null,
        closeReason: "daemon-disconnect",
      },
    ]);
  });

  it("ignores stale output and exits from a replaced PTY", async () => {
    const harness = createHarness();
    const oldPty = await openTerminal(harness);

    await harness.manager.shutdownAll();
    await openTerminal(harness);
    const newPty = harness.adapter.spawned[1]?.pty;
    if (!newPty) {
      throw new Error("Expected replacement terminal PTY to spawn");
    }

    oldPty.emitStaleData("stale-output\n");
    oldPty.emitStaleExit(7);
    newPty.emitData("current-output\n");
    await harness.manager.handleMessage({
      type: "terminal.input",
      terminalId: "term-1",
      dataBase64: Buffer.from("pwd\n", "utf8").toString("base64"),
    });
    await harness.manager.handleMessage({
      type: "terminal.attach",
      requestId: "attach-replacement",
      terminalId: "term-1",
      sinceSeq: 0,
      tailBytes: 4 * 1024 * 1024,
    });

    expect(newPty.writeCalls).toEqual([Buffer.from("pwd\n")]);
    expect(collectTerminalOutput(harness.messages)).toContain(
      "current-output\n",
    );
    expect(collectTerminalOutput(harness.messages)).not.toContain(
      "stale-output\n",
    );
    expect(
      harness.messages.filter((message) => message.type === "terminal.exited"),
    ).toEqual([
      {
        type: "terminal.exited",
        terminalId: "term-1",
        exitCode: null,
        closeReason: "daemon-disconnect",
      },
    ]);
  });

  it("rejects native Windows opens", async () => {
    const harness = createHarness();
    const manager = new TerminalManager({
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      platform: "win32",
      ptyAdapter: harness.adapter,
      runtimeManager: harness.runtimeManager,
      sendMessage: (message) => {
        harness.messages.push(message);
        return true;
      },
    });

    await manager.handleMessage({
      type: "terminal.open",
      requestId: "open-1",
      terminalId: "term-1",
      threadId: "thr-1",
      target: {
        kind: "workspace",
        environmentId: "env-1",
        workspaceContext: {
          workspacePath: "/tmp/terminal-workspace",
          workspaceProvisionType: "unmanaged",
        },
      },
      cols: 100,
      rows: 30,
      start: DEFAULT_TERMINAL_START,
    });

    expect(harness.adapter.spawned).toHaveLength(0);
    expect(harness.messages).toEqual([
      {
        type: "terminal.error",
        requestId: "open-1",
        terminalId: "term-1",
        code: "unsupported_platform",
        message: "Native Windows terminals are not supported",
      },
    ]);
  });

  it("runs commands in one persistent shell from the workspace cwd", async () => {
    if (process.platform === "win32") {
      return;
    }

    const workspacePath = await makeTempDir("bb-terminal-manager-real-");
    const targetPath = await makeTempDir("bb-terminal-manager-target-");
    const expectedWorkspacePath = await fs.realpath(workspacePath);
    const expectedTargetPath = await fs.realpath(targetPath);
    const messages: HostDaemonDaemonWsMessage[] = [];
    const runtimeManager = new RuntimeManager({
      createRuntime: () => createFakeRuntime(),
      provisionWorkspace: async () => createFakeWorkspace(workspacePath),
    });
    const manager = new TerminalManager({
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      resolveShell: async () => "/bin/sh",
      runtimeManager,
      sendMessage: (message) => {
        messages.push(message);
        return true;
      },
    });

    await manager.handleMessage({
      type: "terminal.open",
      requestId: "open-real",
      terminalId: "term-real",
      threadId: "thr-real",
      target: {
        kind: "workspace",
        environmentId: "env-real",
        workspaceContext: {
          workspacePath,
          workspaceProvisionType: "unmanaged",
        },
      },
      cols: 100,
      rows: 30,
      start: DEFAULT_TERMINAL_START,
    });
    await manager.handleMessage({
      type: "terminal.input",
      terminalId: "term-real",
      dataBase64: Buffer.from(
        [
          'printf "__PWD1:%s\\n" "$(pwd -P)"',
          `cd ${shellQuote(targetPath)}`,
          'printf "__PWD2:%s\\n" "$(pwd -P)"',
          "",
        ].join("\n"),
        "utf8",
      ).toString("base64"),
    });

    await waitForOutputContaining({
      messages,
      text: `__PWD1:${expectedWorkspacePath}`,
    });
    await waitForOutputContaining({
      messages,
      text: `__PWD2:${expectedTargetPath}`,
    });
    await manager.shutdownAll();
  }, 10_000);
});

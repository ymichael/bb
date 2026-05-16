import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@bb/agent-runtime";
import type { HostDaemonDaemonWsMessage } from "@bb/host-daemon-contract";
import type { HostWorkspace } from "@bb/host-workspace";
import { makeWorkspaceMergeBase, makeWorkspaceStatus } from "@bb/test-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeManager } from "../runtime-manager.js";
import {
  TerminalManager,
  type SpawnTerminalPtyArgs,
  type TerminalPtyAdapter,
  type TerminalPtyDisposable,
  type TerminalPtyExit,
  type TerminalPtyProcess,
} from "./terminal-manager.js";

const tempDirs: string[] = [];

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

type SteerTurnResult = Awaited<ReturnType<AgentRuntime["steerTurn"]>>;

async function makeTempDir(prefix: string): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

async function cleanupTempDirs(): Promise<void> {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((tempDir) => fs.rm(tempDir, { force: true, recursive: true })),
  );
}

class FakeTerminalPty implements TerminalPtyProcess {
  readonly killCalls: (string | null)[];
  readonly resizeCalls: ResizeCall[];
  readonly writeCalls: (Buffer | string)[];
  private readonly dataListeners: ((data: string) => void)[];
  private readonly exitListeners: ((event: TerminalPtyExit) => void)[];

  constructor() {
    this.killCalls = [];
    this.resizeCalls = [];
    this.writeCalls = [];
    this.dataListeners = [];
    this.exitListeners = [];
  }

  kill(signal?: string): void {
    this.killCalls.push(signal ?? null);
  }

  onData(listener: (data: string) => void): TerminalPtyDisposable {
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

  onExit(listener: (event: TerminalPtyExit) => void): TerminalPtyDisposable {
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
    resumeThread: vi.fn(async () => ({
      providerThreadId: "provider-thread",
    })),
    runTurn: vi.fn(async () => undefined),
    steerTurn: vi.fn(async () => steerTurnResult),
    stopThread: vi.fn(async () => undefined),
    renameThread: vi.fn(async () => undefined),
    archiveThread: vi.fn(async () => undefined),
    unarchiveThread: vi.fn(async () => undefined),
    listModels: vi.fn(async () => ({ models: [], selectedOnlyModels: [] })),
    listRunningProviders: vi.fn(() => []),
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
    getDiff: vi.fn(async () => ({
      diff: "",
      files: "",
      mergeBaseRef: null,
      shortstat: "",
      truncated: false,
    })),
    listBranches: vi.fn(async () => ["main"]),
    listFiles: vi.fn(async () => []),
    commit: vi.fn(async () => ({
      commitSha: "commit-1",
      commitSubject: "commit",
    })),
    reset: vi.fn(async () => undefined),
    fetch: vi.fn(async () => undefined),
    squashMerge: vi.fn(async () => ({
      commitSha: "commit-1",
      commitSubject: "commit",
      merged: true,
      targetBranch: "main",
    })),
    destroy: vi.fn(async () => undefined),
  };
}

function createHarness(): TerminalManagerHarness {
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
    logger: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    ptyAdapter: adapter,
    resolveShell: async () => "/bin/zsh",
    runtimeManager,
    sendMessage: (message) => {
      messages.push(message);
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
    environmentId: "env-1",
    workspaceContext: {
      workspacePath: "/tmp/terminal-workspace",
      workspaceProvisionType: "unmanaged",
    },
    cols: 100,
    rows: 30,
  });
  const spawned = harness.adapter.spawned[0];
  if (!spawned) {
    throw new Error("Expected terminal PTY to spawn");
  }
  return spawned.pty;
}

describe("TerminalManager", () => {
  afterEach(async () => {
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
    await expect(harness.runtimeManager.evictIdleEnvironments()).resolves.toEqual(
      [],
    );
  });

  it("forwards output and replays scrollback on attach", async () => {
    const harness = createHarness();
    const pty = await openTerminal(harness);

    pty.emitData("hello\n");
    await harness.manager.handleMessage({
      type: "terminal.attach",
      requestId: "attach-1",
      terminalId: "term-1",
      sinceSeq: 0,
    });

    expect(harness.messages).toContainEqual({
      type: "terminal.output",
      terminalId: "term-1",
      chunk: {
        seq: 0,
        dataBase64: Buffer.from("hello\n", "utf8").toString("base64"),
      },
    });
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
      nextSeq: 1,
    });
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

    expect(pty.writeCalls).toHaveLength(1);
    expect(pty.writeCalls[0]).toBe("pwd\n");
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
    await expect(harness.runtimeManager.evictIdleEnvironments()).resolves.toEqual(
      ["env-1"],
    );
    expect(harness.runtime.shutdown).toHaveBeenCalledTimes(1);
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

  it("rejects native Windows opens", async () => {
    const harness = createHarness();
    const manager = new TerminalManager({
      logger: {
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
      environmentId: "env-1",
      workspaceContext: {
        workspacePath: "/tmp/terminal-workspace",
        workspaceProvisionType: "unmanaged",
      },
      cols: 100,
      rows: 30,
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

  it(
    "runs commands in one persistent shell from the workspace cwd",
    async () => {
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
        environmentId: "env-real",
        workspaceContext: {
          workspacePath,
          workspaceProvisionType: "unmanaged",
        },
        cols: 100,
        rows: 30,
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
    },
    10_000,
  );
});

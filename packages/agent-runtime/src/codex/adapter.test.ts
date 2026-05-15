import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { turnScope } from "@bb/domain";

import { createCodexProviderAdapter } from "./adapter.js";
import type { CodexEvent } from "./adapter.js";
import { ProviderRequestDecodeError } from "../runtime-json-rpc.js";
import type {
  AdapterCommand,
  ProviderExecutionContext,
  TurnStartAdapterCommand,
} from "../provider-adapter.js";

// ---------------------------------------------------------------------------
// Helpers to build typed CodexEvent fixtures
// ---------------------------------------------------------------------------

function codexEvent<M extends CodexEvent["method"]>(
  method: M,
  params: Extract<CodexEvent, { method: M }>["params"],
) {
  return {
    jsonrpc: "2.0" as const,
    method,
    params,
  };
}

const fullProviderExecutionContext = {
  permissionMode: "full",
  permissionEscalation: null,
} satisfies ProviderExecutionContext;

const workspaceWriteAskProviderExecutionContext = {
  permissionMode: "workspace-write",
  permissionEscalation: "ask",
} satisfies ProviderExecutionContext;

type CodexProviderAdapter = ReturnType<typeof createCodexProviderAdapter>;
type CodexProviderCommandPlan = ReturnType<
  CodexProviderAdapter["buildCommandPlan"]
>;
type ThreadStartAdapterCommand = Extract<
  AdapterCommand,
  { type: "thread/start" }
>;
type ThreadResumeAdapterCommand = Extract<
  AdapterCommand,
  { type: "thread/resume" }
>;

interface LinkedWorktreeFixture {
  cleanup(): void;
  commonDir: string;
  expectedWritableRoots: string[];
  gitDir: string;
  rootPath: string;
  workspacePath: string;
}

interface OptionalGitRootEscapeCase {
  label: string;
  outsidePrefix: string;
  relativePath: string;
}

interface UnsafeHeadRefCase {
  headContent: string;
  label: string;
}

interface InvalidCommonDirCase {
  label: string;
  setup(fixture: LinkedWorktreeFixture): void;
}

interface BuildLinkedWorktreeThreadStartCommandArgs {
  fixture: LinkedWorktreeFixture;
  threadId?: string;
}

interface AcceptThreadCommandArgs {
  adapter: CodexProviderAdapter;
  command: ThreadResumeAdapterCommand | ThreadStartAdapterCommand;
  providerThreadId: string;
}

const optionalGitRootEscapeCases: readonly OptionalGitRootEscapeCase[] = [
  {
    label: "refs",
    outsidePrefix: "bb-codex-refs-escape-",
    relativePath: "refs",
  },
  {
    label: "logs refs",
    outsidePrefix: "bb-codex-logs-refs-escape-",
    relativePath: path.join("logs", "refs"),
  },
];

const unsafeHeadRefCases: readonly UnsafeHeadRefCase[] = [
  {
    label: "parent traversal",
    headContent: "ref: refs/heads/../main\n",
  },
  {
    label: "absolute path",
    headContent: "ref: /tmp/bb-main\n",
  },
  {
    label: "empty path segment",
    headContent: "ref: refs/heads//main\n",
  },
];

const invalidCommonDirCases: readonly InvalidCommonDirCase[] = [
  {
    label: "missing commondir",
    setup(fixture) {
      rmSync(path.join(fixture.gitDir, "commondir"), { force: true });
    },
  },
  {
    label: "empty commondir",
    setup(fixture) {
      writeFileSync(path.join(fixture.gitDir, "commondir"), "\n");
    },
  },
];

function createLinkedWorktreeFixture(): LinkedWorktreeFixture {
  const rootPath = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "bb-codex-worktree-")),
  );
  const workspacePath = path.join(rootPath, "worktree");
  const commonDir = path.join(rootPath, "repo.git");
  const gitDir = path.join(commonDir, "worktrees", "bb1");
  const headRef = "refs/heads/bb/probe";
  const headRefParent = path.join(commonDir, "refs", "heads", "bb");
  const headLogParent = path.join(commonDir, "logs", "refs", "heads", "bb");

  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(gitDir, { recursive: true });
  mkdirSync(path.join(commonDir, "objects"), { recursive: true });
  mkdirSync(headRefParent, { recursive: true });
  mkdirSync(headLogParent, { recursive: true });
  writeFileSync(path.join(workspacePath, ".git"), `gitdir: ${gitDir}\n`);
  writeFileSync(
    path.join(gitDir, "gitdir"),
    `${path.join(workspacePath, ".git")}\n`,
  );
  writeFileSync(path.join(gitDir, "commondir"), "../..\n");
  writeFileSync(path.join(gitDir, "HEAD"), `ref: ${headRef}\n`);

  return {
    cleanup() {
      rmSync(rootPath, { recursive: true, force: true });
    },
    commonDir,
    expectedWritableRoots: [
      gitDir,
      path.join(commonDir, "objects"),
      headRefParent,
      headLogParent,
    ],
    gitDir,
    rootPath,
    workspacePath,
  };
}

function prepareTurnStart(
  adapter: CodexProviderAdapter,
  command: TurnStartAdapterCommand,
): void {
  expect(adapter.prepareTurnStart(command)).not.toBeNull();
}

function expectWorkspaceWriteWritableRootsConfigAbsent(
  command: CodexProviderCommandPlan,
): void {
  expect(command).toMatchObject({
    params: {
      config: expect.not.objectContaining({
        "sandbox_workspace_write.writable_roots": expect.anything(),
      }),
    },
  });
}

function dedupeRoots(roots: readonly string[]): string[] {
  return [...new Set(roots)];
}

function buildLinkedWorktreeThreadStartCommand(
  args: BuildLinkedWorktreeThreadStartCommandArgs,
): ThreadStartAdapterCommand {
  return {
    type: "thread/start",
    cwd: args.fixture.workspacePath,
    threadId: args.threadId ?? "bb-thread-1",
    input: [{ type: "text", text: "hello" }],
    instructionMode: "append",
    options: workspaceWriteAskProviderExecutionContext,
  };
}

function buildLinkedWorktreeThreadResumeCommand(
  args: BuildLinkedWorktreeThreadStartCommandArgs & {
    providerThreadId?: string;
  },
): ThreadResumeAdapterCommand {
  return {
    type: "thread/resume",
    cwd: args.fixture.workspacePath,
    threadId: args.threadId ?? "bb-thread-1",
    providerThreadId: args.providerThreadId ?? "codex-thread-1",
    instructionMode: "append",
    options: workspaceWriteAskProviderExecutionContext,
  };
}

function acceptThreadCommand(args: AcceptThreadCommandArgs): void {
  args.adapter.translateAcceptedCommand({
    command: args.command,
    providerThreadId: args.providerThreadId,
  });
}

describe("codex provider adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -- Identity & capabilities ---------------------------------------------

  it("advertises trimmed capabilities", () => {
    const adapter = createCodexProviderAdapter();
    expect(adapter.capabilities).toEqual({
      supportsArchive: true,
      supportsRename: true,
      supportsServiceTier: true,
      supportedPermissionModes: ["full", "workspace-write", "readonly"],
    });
  });

  it("has correct process config", () => {
    const adapter = createCodexProviderAdapter();
    expect(adapter.process.command).toBe("codex");
    expect(adapter.process.args).toMatchObject(["app-server"]);
  });

  it("translates accepted steer results to input accepted events", () => {
    const adapter = createCodexProviderAdapter();

    expect(
      adapter.translateAcceptedCommand({
        command: {
          type: "turn/start",
          clientRequestId: "creq_222222228e",
          threadId: "thread-1",
          providerThreadId: "provider-thread-1",
          input: [{ type: "text", text: "normal turn" }],
          options: fullProviderExecutionContext,
        },
      }),
    ).toMatchObject([]);
    expect(
      adapter.translateAcceptedCommand({
        command: {
          type: "turn/steer",
          threadId: "thread-1",
          providerThreadId: "provider-thread-1",
          expectedTurnId: "turn-1",
          clientRequestId: "creq_23456789af",
          input: [{ type: "text", text: "steer turn" }],
          options: fullProviderExecutionContext,
        },
      }),
    ).toEqual([
      {
        type: "turn/input/accepted",
        threadId: "thread-1",
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        clientRequestId: "creq_23456789af",
      },
    ]);
  });

  it("emits input accepted when a queued turn starts and suppresses later user-message echoes", () => {
    const adapter = createCodexProviderAdapter();

    prepareTurnStart(adapter, {
      type: "turn/start",
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      clientRequestId: "creq_23456789ag",
      input: [{ type: "text", text: "normal turn" }],
      options: fullProviderExecutionContext,
    });

    expect(
      adapter.translateEvent(
        codexEvent("turn/started", {
          threadId: "provider-thread-1",
          turn: { id: "turn-1", items: [], status: "inProgress", error: null },
        }),
      ),
    ).toEqual([
      {
        type: "turn/started",
        threadId: "provider-thread-1",
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
      },
      {
        type: "turn/input/accepted",
        threadId: "provider-thread-1",
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        clientRequestId: "creq_23456789ag",
      },
    ]);

    const echoEvents = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "provider-thread-1",
        turnId: "turn-1",
        item: {
          type: "userMessage",
          id: "provider-user-1",
          content: [{ type: "text", text: "normal turn", text_elements: [] }],
        },
      }),
    );

    expect(echoEvents).toMatchObject([]);
  });

  it("rolls back queued input acceptance when turn/start dispatch fails", () => {
    const adapter = createCodexProviderAdapter();

    const prepared = adapter.prepareTurnStart({
      type: "turn/start",
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      clientRequestId: "creq_23456789ag",
      input: [{ type: "text", text: "normal turn" }],
      options: fullProviderExecutionContext,
    });
    expect(prepared).not.toBeNull();
    if (!prepared) {
      throw new Error("Expected prepared turn/start state");
    }
    prepared.rollback();

    expect(
      adapter.translateEvent(
        codexEvent("turn/started", {
          threadId: "provider-thread-1",
          turn: { id: "turn-1", items: [], status: "inProgress", error: null },
        }),
      ),
    ).toEqual([
      {
        type: "turn/started",
        threadId: "provider-thread-1",
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
      },
    ]);
  });

  it("suppresses native user-message echoes without a queued client request", () => {
    const adapter = createCodexProviderAdapter();

    const events = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "provider-thread-1",
        turnId: "turn-1",
        item: {
          type: "userMessage",
          id: "provider-user-1",
          content: [{ type: "text", text: "provider echo", text_elements: [] }],
        },
      }),
    );

    expect(events).toMatchObject([]);
  });

  // -- buildCommand --------------------------------------------------------

  it("buildCommand returns codex initialize with experimental API", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommandPlan({ type: "initialize" });
    expect(cmd).toMatchObject({
      method: "initialize",
      params: {
        clientInfo: { name: "bb", version: "1.0.0", title: null },
        capabilities: { experimentalApi: true },
      },
    });
  });

  it("buildCommand model/list maps to the codex protocol", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommandPlan({ type: "model/list" });

    expect(cmd).toEqual({
      kind: "request",
      method: "model/list",
      params: {},
    });
  });

  it("buildCommand thread/start defaults to full permissions", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "thread/start",
      cwd: "/tmp/worktree",
      threadId: "t1",
      input: [{ type: "text", text: "hello" }],
      instructionMode: "append",
      options: fullProviderExecutionContext,
    });
    expect(cmd).toMatchObject({
      method: "thread/start",
      params: {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        cwd: "/tmp/worktree",
        experimentalRawEvents: true,
      },
    });
    expect(JSON.stringify(cmd)).not.toContain("baseInstructions");
    expect(JSON.stringify(cmd)).not.toContain("developerInstructions");
  });

  it("buildCommand thread/start maps workspace-write permissions to on-request approvals", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "thread/start",
      cwd: "/tmp/worktree",
      threadId: "t1",
      input: [{ type: "text", text: "hello" }],
      instructionMode: "append",
      options: workspaceWriteAskProviderExecutionContext,
    });

    expect(cmd).toMatchObject({
      method: "thread/start",
      params: {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      },
    });
  });

  it("buildCommand thread/start and turn/start include captured linked worktree git writable roots", () => {
    const fixture = createLinkedWorktreeFixture();
    const adapter = createCodexProviderAdapter();
    try {
      const startCommand = buildLinkedWorktreeThreadStartCommand({ fixture });
      const startCmd = adapter.buildCommandPlan(startCommand);

      expect(startCmd).toMatchObject({
        method: "thread/start",
        params: {
          config: {
            "sandbox_workspace_write.writable_roots":
              fixture.expectedWritableRoots,
          },
        },
      });
      acceptThreadCommand({
        adapter,
        command: startCommand,
        providerThreadId: "codex-thread-1",
      });

      writeFileSync(path.join(fixture.workspacePath, ".git"), "gitdir: /\n");

      const turnCmd = adapter.buildCommandPlan({
        type: "turn/start",
        clientRequestId: "creq_222222228f",
        threadId: "bb-thread-1",
        providerThreadId: "codex-thread-1",
        input: [{ type: "text", text: "edit it" }],
        options: workspaceWriteAskProviderExecutionContext,
      });

      expect(turnCmd).toMatchObject({
        method: "turn/start",
        params: {
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: fixture.expectedWritableRoots,
          },
        },
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("buildCommand combines additional workspace roots with captured linked worktree git roots", () => {
    const fixture = createLinkedWorktreeFixture();
    const additionalWorkspaceWriteRoots = [
      path.join(fixture.rootPath, "host-extra-root"),
      fixture.gitDir,
    ];
    const expectedWritableRoots = dedupeRoots([
      ...additionalWorkspaceWriteRoots,
      ...fixture.expectedWritableRoots,
    ]);
    const adapter = createCodexProviderAdapter({
      additionalWorkspaceWriteRoots,
    });
    try {
      const startCommand = buildLinkedWorktreeThreadStartCommand({
        fixture,
        threadId: "bb-thread-start",
      });
      const startCmd = adapter.buildCommandPlan(startCommand);

      expect(startCmd).toMatchObject({
        method: "thread/start",
        params: {
          config: {
            "sandbox_workspace_write.writable_roots": expectedWritableRoots,
          },
        },
      });
      acceptThreadCommand({
        adapter,
        command: startCommand,
        providerThreadId: "codex-thread-start",
      });

      const resumeCommand = buildLinkedWorktreeThreadResumeCommand({
        fixture,
        providerThreadId: "codex-thread-resume",
        threadId: "bb-thread-resume",
      });
      const resumeCmd = adapter.buildCommandPlan(resumeCommand);

      expect(resumeCmd).toMatchObject({
        method: "thread/resume",
        params: {
          config: {
            "sandbox_workspace_write.writable_roots": expectedWritableRoots,
          },
        },
      });
      acceptThreadCommand({
        adapter,
        command: resumeCommand,
        providerThreadId: "codex-thread-resume",
      });

      writeFileSync(path.join(fixture.workspacePath, ".git"), "gitdir: /\n");

      const startTurnCmd = adapter.buildCommandPlan({
        type: "turn/start",
        clientRequestId: "creq_222222228g",
        threadId: "bb-thread-start",
        providerThreadId: "codex-thread-start",
        input: [{ type: "text", text: "commit it" }],
        options: workspaceWriteAskProviderExecutionContext,
      });
      const resumeTurnCmd = adapter.buildCommandPlan({
        type: "turn/start",
        clientRequestId: "creq_222222228h",
        threadId: "bb-thread-resume",
        providerThreadId: "codex-thread-resume",
        input: [{ type: "text", text: "commit it" }],
        options: workspaceWriteAskProviderExecutionContext,
      });

      expect(startTurnCmd).toMatchObject({
        method: "turn/start",
        params: {
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: expectedWritableRoots,
          },
        },
      });
      expect(resumeTurnCmd).toMatchObject({
        method: "turn/start",
        params: {
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: expectedWritableRoots,
          },
        },
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("buildCommand turn/start waits for successful thread/start before using linked worktree git writable roots", () => {
    const fixture = createLinkedWorktreeFixture();
    const adapter = createCodexProviderAdapter();
    try {
      const startCommand = buildLinkedWorktreeThreadStartCommand({ fixture });
      const startCmd = adapter.buildCommandPlan(startCommand);

      expect(startCmd).toMatchObject({
        method: "thread/start",
        params: {
          config: {
            "sandbox_workspace_write.writable_roots":
              fixture.expectedWritableRoots,
          },
        },
      });

      const turnCmd = adapter.buildCommandPlan({
        type: "turn/start",
        clientRequestId: "creq_222222228i",
        threadId: "bb-thread-1",
        providerThreadId: "codex-thread-1",
        input: [{ type: "text", text: "edit it" }],
        options: workspaceWriteAskProviderExecutionContext,
      });

      expect(turnCmd).toMatchObject({
        method: "turn/start",
        params: {
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [],
          },
        },
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("translateAcceptedCommand binds git roots to the accepted provider thread id", () => {
    const firstFixture = createLinkedWorktreeFixture();
    const secondFixture = createLinkedWorktreeFixture();
    const adapter = createCodexProviderAdapter();
    try {
      const firstStartCommand = buildLinkedWorktreeThreadStartCommand({
        fixture: firstFixture,
        threadId: "bb-thread-1",
      });
      const secondStartCommand = buildLinkedWorktreeThreadStartCommand({
        fixture: secondFixture,
        threadId: "bb-thread-2",
      });
      adapter.buildCommandPlan(firstStartCommand);
      adapter.buildCommandPlan(secondStartCommand);

      acceptThreadCommand({
        adapter,
        command: secondStartCommand,
        providerThreadId: "codex-thread-2",
      });
      acceptThreadCommand({
        adapter,
        command: firstStartCommand,
        providerThreadId: "codex-thread-1",
      });

      adapter.translateEvent(
        codexEvent("thread/closed", {
          threadId: "codex-thread-1",
        }),
      );

      const firstTurnCmd = adapter.buildCommandPlan({
        type: "turn/start",
        clientRequestId: "creq_222222228j",
        threadId: "bb-thread-1",
        providerThreadId: "codex-thread-1",
        input: [{ type: "text", text: "edit it" }],
        options: workspaceWriteAskProviderExecutionContext,
      });
      const secondTurnCmd = adapter.buildCommandPlan({
        type: "turn/start",
        clientRequestId: "creq_222222228k",
        threadId: "bb-thread-2",
        providerThreadId: "codex-thread-2",
        input: [{ type: "text", text: "edit it" }],
        options: workspaceWriteAskProviderExecutionContext,
      });

      expect(firstTurnCmd).toMatchObject({
        method: "turn/start",
        params: {
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [],
          },
        },
      });
      expect(secondTurnCmd).toMatchObject({
        method: "turn/start",
        params: {
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: secondFixture.expectedWritableRoots,
          },
        },
      });
    } finally {
      firstFixture.cleanup();
      secondFixture.cleanup();
    }
  });

  it("buildCommand thread/start rejects linked worktree git roots that escape canonical containment", () => {
    const fixture = createLinkedWorktreeFixture();
    const adapter = createCodexProviderAdapter();
    try {
      writeFileSync(path.join(fixture.workspacePath, ".git"), "gitdir: /\n");

      const startCmd = adapter.buildCommandPlan({
        type: "thread/start",
        cwd: fixture.workspacePath,
        threadId: "bb-thread-1",
        input: [{ type: "text", text: "hello" }],
        instructionMode: "append",
        options: workspaceWriteAskProviderExecutionContext,
      });

      expect(startCmd).not.toMatchObject({
        params: {
          config: {
            "sandbox_workspace_write.writable_roots": expect.any(Array),
          },
        },
      });

      const turnCmd = adapter.buildCommandPlan({
        type: "turn/start",
        clientRequestId: "creq_222222228m",
        threadId: "bb-thread-1",
        providerThreadId: "codex-thread-1",
        input: [{ type: "text", text: "edit it" }],
        options: workspaceWriteAskProviderExecutionContext,
      });

      expect(turnCmd).toMatchObject({
        method: "turn/start",
        params: {
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [],
          },
        },
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("buildCommand thread/start rejects linked worktree git roots from a foreign workspace", () => {
    const fixture = createLinkedWorktreeFixture();
    const foreignFixture = createLinkedWorktreeFixture();
    const adapter = createCodexProviderAdapter();
    try {
      writeFileSync(
        path.join(fixture.workspacePath, ".git"),
        `gitdir: ${foreignFixture.gitDir}\n`,
      );

      const startCmd = adapter.buildCommandPlan({
        type: "thread/start",
        cwd: fixture.workspacePath,
        threadId: "bb-thread-1",
        input: [{ type: "text", text: "hello" }],
        instructionMode: "append",
        options: workspaceWriteAskProviderExecutionContext,
      });

      expect(startCmd).not.toMatchObject({
        params: {
          config: {
            "sandbox_workspace_write.writable_roots": expect.any(Array),
          },
        },
      });

      const turnCmd = adapter.buildCommandPlan({
        type: "turn/start",
        clientRequestId: "creq_222222228n",
        threadId: "bb-thread-1",
        providerThreadId: "codex-thread-1",
        input: [{ type: "text", text: "edit it" }],
        options: workspaceWriteAskProviderExecutionContext,
      });

      expect(turnCmd).toMatchObject({
        method: "turn/start",
        params: {
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [],
          },
        },
      });
    } finally {
      fixture.cleanup();
      foreignFixture.cleanup();
    }
  });

  it("buildCommand thread/start rejects symlinked workspace .git files", () => {
    const fixture = createLinkedWorktreeFixture();
    const foreignFixture = createLinkedWorktreeFixture();
    const adapter = createCodexProviderAdapter();
    try {
      rmSync(path.join(fixture.workspacePath, ".git"), { force: true });
      symlinkSync(
        path.join(foreignFixture.workspacePath, ".git"),
        path.join(fixture.workspacePath, ".git"),
      );

      const startCommand = buildLinkedWorktreeThreadStartCommand({ fixture });
      const startCmd = adapter.buildCommandPlan(startCommand);

      expectWorkspaceWriteWritableRootsConfigAbsent(startCmd);
      acceptThreadCommand({
        adapter,
        command: startCommand,
        providerThreadId: "codex-thread-1",
      });

      const turnCmd = adapter.buildCommandPlan({
        type: "turn/start",
        clientRequestId: "creq_222222228p",
        threadId: "bb-thread-1",
        providerThreadId: "codex-thread-1",
        input: [{ type: "text", text: "edit it" }],
        options: workspaceWriteAskProviderExecutionContext,
      });

      expect(turnCmd).toMatchObject({
        method: "turn/start",
        params: {
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [],
          },
        },
      });
    } finally {
      fixture.cleanup();
      foreignFixture.cleanup();
    }
  });

  it("buildCommand thread/start tolerates missing linked worktree ref and reflog dirs", () => {
    const fixture = createLinkedWorktreeFixture();
    const adapter = createCodexProviderAdapter();
    const expectedWritableRoots = [
      fixture.gitDir,
      path.join(fixture.commonDir, "objects"),
    ];
    try {
      rmSync(path.join(fixture.commonDir, "refs"), {
        recursive: true,
        force: true,
      });
      rmSync(path.join(fixture.commonDir, "logs"), {
        recursive: true,
        force: true,
      });

      const startCmd = adapter.buildCommandPlan({
        type: "thread/start",
        cwd: fixture.workspacePath,
        threadId: "bb-thread-1",
        input: [{ type: "text", text: "hello" }],
        instructionMode: "append",
        options: workspaceWriteAskProviderExecutionContext,
      });

      expect(startCmd).toMatchObject({
        method: "thread/start",
        params: {
          config: {
            "sandbox_workspace_write.writable_roots": expectedWritableRoots,
          },
        },
      });
    } finally {
      fixture.cleanup();
    }
  });

  it.each(unsafeHeadRefCases)(
    "buildCommand thread/start skips linked worktree ref/log roots for unsafe HEAD ref: $label",
    (testCase) => {
      const fixture = createLinkedWorktreeFixture();
      const adapter = createCodexProviderAdapter();
      const expectedWritableRoots = [
        fixture.gitDir,
        path.join(fixture.commonDir, "objects"),
      ];
      try {
        writeFileSync(path.join(fixture.gitDir, "HEAD"), testCase.headContent);

        const startCmd = adapter.buildCommandPlan({
          type: "thread/start",
          cwd: fixture.workspacePath,
          threadId: "bb-thread-1",
          input: [{ type: "text", text: "hello" }],
          instructionMode: "append",
          options: workspaceWriteAskProviderExecutionContext,
        });

        expect(startCmd).toMatchObject({
          method: "thread/start",
          params: {
            config: {
              "sandbox_workspace_write.writable_roots": expectedWritableRoots,
            },
          },
        });
      } finally {
        fixture.cleanup();
      }
    },
  );

  it("buildCommand thread/start includes branch ref roots for detached HEAD so later branch commits can update refs", () => {
    const fixture = createLinkedWorktreeFixture();
    const adapter = createCodexProviderAdapter();
    const expectedWritableRoots = [
      fixture.gitDir,
      path.join(fixture.commonDir, "objects"),
      path.join(fixture.commonDir, "refs", "heads"),
      path.join(fixture.commonDir, "logs", "refs", "heads"),
    ];
    try {
      writeFileSync(
        path.join(fixture.gitDir, "HEAD"),
        "0123456789abcdef0123456789abcdef01234567\n",
      );

      const startCommand = buildLinkedWorktreeThreadStartCommand({ fixture });
      const startCmd = adapter.buildCommandPlan(startCommand);

      expect(startCmd).toMatchObject({
        method: "thread/start",
        params: {
          config: {
            "sandbox_workspace_write.writable_roots": expectedWritableRoots,
          },
        },
      });
      acceptThreadCommand({
        adapter,
        command: startCommand,
        providerThreadId: "codex-thread-1",
      });

      const turnCmd = adapter.buildCommandPlan({
        type: "turn/start",
        clientRequestId: "creq_222222228q",
        threadId: "bb-thread-1",
        providerThreadId: "codex-thread-1",
        input: [{ type: "text", text: "edit it" }],
        options: workspaceWriteAskProviderExecutionContext,
      });

      expect(turnCmd).toMatchObject({
        method: "turn/start",
        params: {
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: expectedWritableRoots,
          },
        },
      });
    } finally {
      fixture.cleanup();
    }
  });

  it.each(invalidCommonDirCases)(
    "buildCommand thread/start rejects linked worktree git roots for $label",
    (testCase) => {
      const fixture = createLinkedWorktreeFixture();
      const adapter = createCodexProviderAdapter();
      try {
        testCase.setup(fixture);

        const startCmd = adapter.buildCommandPlan({
          type: "thread/start",
          cwd: fixture.workspacePath,
          threadId: "bb-thread-1",
          input: [{ type: "text", text: "hello" }],
          instructionMode: "append",
          options: workspaceWriteAskProviderExecutionContext,
        });

        expectWorkspaceWriteWritableRootsConfigAbsent(startCmd);

        const turnCmd = adapter.buildCommandPlan({
          type: "turn/start",
          clientRequestId: "creq_222222228r",
          threadId: "bb-thread-1",
          providerThreadId: "codex-thread-1",
          input: [{ type: "text", text: "edit it" }],
          options: workspaceWriteAskProviderExecutionContext,
        });

        expect(turnCmd).toMatchObject({
          method: "turn/start",
          params: {
            sandboxPolicy: {
              type: "workspaceWrite",
              writableRoots: [],
            },
          },
        });
      } finally {
        fixture.cleanup();
      }
    },
  );

  it("buildCommand thread/start rejects linked worktree git roots when objects symlink escapes common dir", () => {
    const fixture = createLinkedWorktreeFixture();
    const outsideObjectsPath = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "bb-codex-objects-escape-")),
    );
    const adapter = createCodexProviderAdapter();
    try {
      rmSync(path.join(fixture.commonDir, "objects"), {
        recursive: true,
        force: true,
      });
      symlinkSync(
        outsideObjectsPath,
        path.join(fixture.commonDir, "objects"),
        "dir",
      );

      const startCmd = adapter.buildCommandPlan({
        type: "thread/start",
        cwd: fixture.workspacePath,
        threadId: "bb-thread-1",
        input: [{ type: "text", text: "hello" }],
        instructionMode: "append",
        options: workspaceWriteAskProviderExecutionContext,
      });

      const startCmdText = JSON.stringify(startCmd);
      expect(startCmdText).not.toContain(outsideObjectsPath);
      expectWorkspaceWriteWritableRootsConfigAbsent(startCmd);

      const turnCmd = adapter.buildCommandPlan({
        type: "turn/start",
        clientRequestId: "creq_222222228s",
        threadId: "bb-thread-1",
        providerThreadId: "codex-thread-1",
        input: [{ type: "text", text: "edit it" }],
        options: workspaceWriteAskProviderExecutionContext,
      });

      expect(turnCmd).toMatchObject({
        method: "turn/start",
        params: {
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [],
          },
        },
      });
    } finally {
      fixture.cleanup();
      rmSync(outsideObjectsPath, { recursive: true, force: true });
    }
  });

  it("buildCommand thread/start rejects linked worktree git roots when worktrees symlink escapes common dir", () => {
    const fixture = createLinkedWorktreeFixture();
    const outsideWorktreesPath = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "bb-codex-worktrees-escape-")),
    );
    const adapter = createCodexProviderAdapter();
    try {
      rmSync(path.join(fixture.commonDir, "worktrees"), {
        recursive: true,
        force: true,
      });

      const escapedGitDir = path.join(outsideWorktreesPath, "bb1");
      mkdirSync(escapedGitDir, { recursive: true });
      writeFileSync(
        path.join(escapedGitDir, "gitdir"),
        `${path.join(fixture.workspacePath, ".git")}\n`,
      );
      writeFileSync(
        path.join(escapedGitDir, "commondir"),
        `${fixture.commonDir}\n`,
      );
      writeFileSync(
        path.join(escapedGitDir, "HEAD"),
        "ref: refs/heads/bb/probe\n",
      );
      symlinkSync(
        outsideWorktreesPath,
        path.join(fixture.commonDir, "worktrees"),
        "dir",
      );

      const startCmd = adapter.buildCommandPlan({
        type: "thread/start",
        cwd: fixture.workspacePath,
        threadId: "bb-thread-1",
        input: [{ type: "text", text: "hello" }],
        instructionMode: "append",
        options: workspaceWriteAskProviderExecutionContext,
      });

      const startCmdText = JSON.stringify(startCmd);
      expect(startCmdText).not.toContain(outsideWorktreesPath);
      expectWorkspaceWriteWritableRootsConfigAbsent(startCmd);

      const turnCmd = adapter.buildCommandPlan({
        type: "turn/start",
        clientRequestId: "creq_222222228t",
        threadId: "bb-thread-1",
        providerThreadId: "codex-thread-1",
        input: [{ type: "text", text: "edit it" }],
        options: workspaceWriteAskProviderExecutionContext,
      });

      expect(turnCmd).toMatchObject({
        method: "turn/start",
        params: {
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [],
          },
        },
      });
    } finally {
      fixture.cleanup();
      rmSync(outsideWorktreesPath, { recursive: true, force: true });
    }
  });

  it.each(optionalGitRootEscapeCases)(
    "buildCommand thread/start rejects linked worktree git roots when $label symlink escapes common dir",
    (escapeCase) => {
      const fixture = createLinkedWorktreeFixture();
      const outsidePath = realpathSync.native(
        mkdtempSync(path.join(tmpdir(), escapeCase.outsidePrefix)),
      );
      const adapter = createCodexProviderAdapter();
      try {
        const escapePath = path.join(
          fixture.commonDir,
          escapeCase.relativePath,
        );
        rmSync(escapePath, {
          recursive: true,
          force: true,
        });
        symlinkSync(outsidePath, escapePath, "dir");

        const startCmd = adapter.buildCommandPlan({
          type: "thread/start",
          cwd: fixture.workspacePath,
          threadId: "bb-thread-1",
          input: [{ type: "text", text: "hello" }],
          instructionMode: "append",
          options: workspaceWriteAskProviderExecutionContext,
        });

        const startCmdText = JSON.stringify(startCmd);
        expect(startCmdText).not.toContain(outsidePath);
        expectWorkspaceWriteWritableRootsConfigAbsent(startCmd);

        const turnCmd = adapter.buildCommandPlan({
          type: "turn/start",
          clientRequestId: "creq_222222228u",
          threadId: "bb-thread-1",
          providerThreadId: "codex-thread-1",
          input: [{ type: "text", text: "edit it" }],
          options: workspaceWriteAskProviderExecutionContext,
        });

        expect(turnCmd).toMatchObject({
          method: "turn/start",
          params: {
            sandboxPolicy: {
              type: "workspaceWrite",
              writableRoots: [],
            },
          },
        });
      } finally {
        fixture.cleanup();
        rmSync(outsidePath, { recursive: true, force: true });
      }
    },
  );

  it("translateEvent clears captured Codex workspace-write git roots when a thread closes", () => {
    const fixture = createLinkedWorktreeFixture();
    const adapter = createCodexProviderAdapter();
    try {
      const resumeCommand: ThreadResumeAdapterCommand = {
        type: "thread/resume",
        cwd: fixture.workspacePath,
        threadId: "bb-thread-1",
        providerThreadId: "codex-thread-1",
        instructionMode: "append",
        options: workspaceWriteAskProviderExecutionContext,
      };
      adapter.buildCommandPlan(resumeCommand);
      acceptThreadCommand({
        adapter,
        command: resumeCommand,
        providerThreadId: "codex-thread-1",
      });

      adapter.translateEvent(
        codexEvent("thread/closed", {
          threadId: "codex-thread-1",
        }),
      );

      const turnCmd = adapter.buildCommandPlan({
        type: "turn/start",
        clientRequestId: "creq_222222228v",
        threadId: "bb-thread-1",
        providerThreadId: "codex-thread-1",
        input: [{ type: "text", text: "edit it" }],
        options: workspaceWriteAskProviderExecutionContext,
      });

      expect(turnCmd).toMatchObject({
        method: "turn/start",
        params: {
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [],
          },
        },
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("translateEvent clears captured Codex workspace-write git roots after accepted start provider identity", () => {
    const fixture = createLinkedWorktreeFixture();
    const adapter = createCodexProviderAdapter();
    try {
      const startCommand = buildLinkedWorktreeThreadStartCommand({ fixture });
      adapter.buildCommandPlan(startCommand);
      acceptThreadCommand({
        adapter,
        command: startCommand,
        providerThreadId: "codex-thread-1",
      });
      adapter.translateEvent(
        codexEvent("thread/closed", {
          threadId: "codex-thread-1",
        }),
      );

      const turnCmd = adapter.buildCommandPlan({
        type: "turn/start",
        clientRequestId: "creq_222222228w",
        threadId: "bb-thread-1",
        providerThreadId: "codex-thread-1",
        input: [{ type: "text", text: "edit it" }],
        options: workspaceWriteAskProviderExecutionContext,
      });

      expect(turnCmd).toMatchObject({
        method: "turn/start",
        params: {
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [],
          },
        },
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("buildCommand thread/start maps deny escalation to no approval prompts", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "thread/start",
      cwd: "/tmp/worktree",
      threadId: "t1",
      input: [{ type: "text", text: "hello" }],
      instructionMode: "append",
      options: {
        permissionMode: "workspace-write",
        permissionEscalation: "deny",
      },
    });

    expect(cmd).toMatchObject({
      method: "thread/start",
      params: {
        approvalPolicy: "never",
        sandbox: "workspace-write",
      },
    });
  });

  it("buildCommand thread/start ignores escalation in full permission mode", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "thread/start",
      cwd: "/tmp/worktree",
      threadId: "t1",
      input: [{ type: "text", text: "hello" }],
      instructionMode: "append",
      options: {
        permissionMode: "full",
        permissionEscalation: null,
      },
    });

    expect(cmd).toMatchObject({
      method: "thread/start",
      params: {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      },
    });
  });

  it("buildCommand thread/start disables provider user-input requests", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "thread/start",
      cwd: "/tmp/worktree",
      threadId: "bb-thread-1",
      input: [{ type: "text", text: "hello" }],
      instructionMode: "append",
      options: fullProviderExecutionContext,
    });

    expect(cmd).toMatchObject({
      method: "thread/start",
      params: {
        config: {
          "features.default_mode_request_user_input": false,
          "tools.web_search": {
            allowed_domains: null,
            context_size: null,
            location: null,
          },
        },
      },
    });
  });

  it("buildCommand thread/start appends instructions as developer instructions", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "thread/start",
      cwd: "/tmp/worktree",
      threadId: "bb-thread-1",
      input: [{ type: "text", text: "hello" }],
      instructionMode: "append",
      options: {
        ...fullProviderExecutionContext,
        model: "gpt-5.4",
        serviceTier: "fast",
        instructions: "Focus on the failing tests first.",
        reasoningLevel: "high",
        envVars: {
          "BAD.KEY": "ignored",
          TEST_VAR: "123",
        },
      },
      dynamicTools: [
        {
          name: "bb_test_ping",
          description: "Ping the host",
          inputSchema: {
            type: "object",
            properties: {
              ping: { type: "boolean" },
            },
            required: ["ping"],
          },
        },
      ],
    });

    expect(cmd).toMatchObject({
      method: "thread/start",
      params: {
        model: "gpt-5.4",
        serviceTier: "fast",
        developerInstructions: expect.stringContaining(
          "Focus on the failing tests first.",
        ),
        dynamicTools: [
          {
            name: "bb_test_ping",
            description: "Ping the host",
            inputSchema: {
              type: "object",
              properties: {
                ping: { type: "boolean" },
              },
              required: ["ping"],
            },
          },
        ],
      },
    });
    expect(cmd?.params).toMatchObject({
      config: {
        "shell_environment_policy.set.BB_THREAD_ID": "bb-thread-1",
        "shell_environment_policy.set.TEST_VAR": "123",
        model_reasoning_effort: "high",
      },
    });
    expect(cmd).not.toMatchObject({
      params: {
        baseInstructions: expect.any(String),
      },
    });
    expect(cmd).not.toMatchObject({
      params: {
        config: {
          "shell_environment_policy.set.BAD.KEY": "ignored",
        },
      },
    });
  });

  it("buildCommand thread/start replaces instructions as base instructions", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "thread/start",
      cwd: "/tmp/worktree",
      threadId: "bb-thread-1",
      input: [{ type: "text", text: "hello" }],
      instructionMode: "replace",
      options: {
        ...fullProviderExecutionContext,
        instructions: "Use this as the complete base prompt.",
      },
    });

    expect(cmd).toMatchObject({
      method: "thread/start",
      params: {
        baseInstructions: "Use this as the complete base prompt.",
      },
    });
    expect(cmd).not.toMatchObject({
      params: {
        developerInstructions: expect.any(String),
      },
    });
  });

  it("buildCommand thread/resume routes to provider thread id", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "thread/resume",
      cwd: "/tmp/worktree",
      threadId: "bb-t1",
      providerThreadId: "codex-uuid-1",
      instructionMode: "append",
      options: fullProviderExecutionContext,
    });
    expect(cmd).toMatchObject({
      method: "thread/resume",
      params: {
        threadId: "codex-uuid-1",
        cwd: "/tmp/worktree",
      },
    });
    expect(JSON.stringify(cmd)).not.toContain("baseInstructions");
    expect(JSON.stringify(cmd)).not.toContain("developerInstructions");
  });

  it("buildCommand thread/resume appends instructions as developer instructions", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "thread/resume",
      cwd: "/tmp/worktree",
      threadId: "bb-t1",
      providerThreadId: "codex-uuid-1",
      instructionMode: "append",
      options: {
        ...fullProviderExecutionContext,
        instructions: "Continue inside bb.",
      },
    });

    expect(cmd).toMatchObject({
      method: "thread/resume",
      params: {
        threadId: "codex-uuid-1",
        developerInstructions: "Continue inside bb.",
      },
    });
    expect(cmd).not.toMatchObject({
      params: {
        baseInstructions: expect.any(String),
      },
    });
  });

  it("buildCommand thread/stop maps active turns to turn/interrupt", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "thread/stop",
      threadId: "bb-t1",
      providerThreadId: "codex-thread-1",
      activeTurnId: "turn-1",
    });
    expect(cmd).toMatchObject({
      method: "turn/interrupt",
      params: {
        threadId: "codex-thread-1",
        turnId: "turn-1",
      },
    });
  });

  it("buildCommand thread/stop returns a no-op without an active turn id", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "thread/stop",
      threadId: "bb-t1",
      providerThreadId: "codex-thread-1",
      activeTurnId: null,
    });
    expect(cmd).toEqual({
      kind: "noop",
      reason: "no active turn to interrupt",
    });
  });

  it("buildCommand turn/start includes input and sandbox policy", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "turn/start",
      clientRequestId: "creq_222222228x",
      threadId: "t1",
      providerThreadId: "codex-1",
      input: [{ type: "text", text: "do it" }],
      options: fullProviderExecutionContext,
    });
    expect(cmd).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "codex-1",
        input: [{ type: "text", text: "do it" }],
        approvalPolicy: "never",
      },
    });
  });

  it("buildCommand turn/start maps workspace-write permissions to on-request approvals", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "turn/start",
      clientRequestId: "creq_222222228y",
      threadId: "t1",
      providerThreadId: "codex-1",
      input: [{ type: "text", text: "do it" }],
      options: workspaceWriteAskProviderExecutionContext,
    });

    expect(cmd).toMatchObject({
      method: "turn/start",
      params: {
        approvalPolicy: "on-request",
      },
    });
  });

  it("buildCommand turn/start maps workspace-write permissions to workspace-write sandbox policy", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "turn/start",
      clientRequestId: "creq_222222228z",
      threadId: "t1",
      providerThreadId: "codex-1",
      input: [{ type: "text", text: "edit it" }],
      options: workspaceWriteAskProviderExecutionContext,
    });
    expect(cmd).toMatchObject({
      method: "turn/start",
      params: {
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [],
          readOnlyAccess: { type: "fullAccess" },
          networkAccess: true,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      },
    });
  });

  it("buildCommand turn/start includes additional workspace-write roots", () => {
    const adapter = createCodexProviderAdapter({
      additionalWorkspaceWriteRoots: [
        "/repo/.git/worktrees/bb13",
        "/repo/.git/objects",
        "/repo/.git/refs",
        "/repo/.git/logs",
      ],
    });
    const cmd = adapter.buildCommandPlan({
      type: "turn/start",
      clientRequestId: "creq_2222222292",
      threadId: "t1",
      providerThreadId: "codex-1",
      input: [{ type: "text", text: "commit it" }],
      options: workspaceWriteAskProviderExecutionContext,
    });
    expect(cmd).toMatchObject({
      method: "turn/start",
      params: {
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [
            "/repo/.git/worktrees/bb13",
            "/repo/.git/objects",
            "/repo/.git/refs",
            "/repo/.git/logs",
          ],
        },
      },
    });
  });

  it("buildCommand turn/start maps readonly permissions to a read-only sandbox policy", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "turn/start",
      clientRequestId: "creq_2222222293",
      threadId: "t1",
      providerThreadId: "codex-1",
      input: [{ type: "text", text: "inspect it" }],
      options: {
        permissionMode: "readonly",
        permissionEscalation: "ask",
      },
    });
    expect(cmd).toMatchObject({
      method: "turn/start",
      params: {
        approvalPolicy: "on-request",
        sandboxPolicy: {
          type: "readOnly",
          access: { type: "fullAccess" },
          networkAccess: false,
        },
      },
    });
  });

  it("buildCommand turn/start maps readonly deny escalation to no approval prompts", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "turn/start",
      clientRequestId: "creq_2222222294",
      threadId: "t1",
      providerThreadId: "codex-1",
      input: [{ type: "text", text: "inspect it" }],
      options: {
        permissionMode: "readonly",
        permissionEscalation: "deny",
      },
    });
    expect(cmd).toMatchObject({
      method: "turn/start",
      params: {
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
        },
      },
    });
  });

  it("buildCommand turn/steer includes expectedTurnId", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "turn/steer",
      clientRequestId: "creq_2222222295",
      threadId: "t1",
      providerThreadId: "codex-1",
      expectedTurnId: "turn-3",
      input: [{ type: "text", text: "steer it" }],
      options: fullProviderExecutionContext,
    });
    expect(cmd).toMatchObject({
      method: "turn/steer",
      params: {
        threadId: "codex-1",
        expectedTurnId: "turn-3",
        input: [{ type: "text", text: "steer it" }],
      },
    });
  });

  it("buildCommand thread/name/set returns command when rename supported", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "thread/name/set",
      threadId: "t1",
      providerThreadId: "codex-1",
      title: "New title",
    });
    expect(cmd).toMatchObject({
      method: "thread/name/set",
      params: { threadId: "codex-1", name: "New title" },
    });
  });

  it("buildCommand thread/archive routes to provider thread id", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "thread/archive",
      threadId: "bb-thread-1",
      providerThreadId: "codex-thread-1",
    });
    expect(cmd).toEqual({
      kind: "request",
      method: "thread/archive",
      params: { threadId: "codex-thread-1" },
    });
  });

  it("buildCommand thread/unarchive routes to provider thread id", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "thread/unarchive",
      threadId: "bb-thread-1",
      providerThreadId: "codex-thread-1",
    });
    expect(cmd).toEqual({
      kind: "request",
      method: "thread/unarchive",
      params: { threadId: "codex-thread-1" },
    });
  });

  // -- translateEvent: turn lifecycle --------------------------------------

  it("translateEvent turn/started", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("turn/started", {
        threadId: "t1",
        turn: { id: "turn-1", items: [], status: "inProgress", error: null },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/started",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
      }),
    );
  });

  it("translateEvent accepts legacy Codex bridge envelopes without jsonrpc", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent({
      method: "turn/started",
      params: {
        threadId: "t1",
        turn: { id: "turn-1", items: [], status: "inProgress", error: null },
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/started",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
      }),
    );
  });

  it("translateEvent surfaces malformed handled Codex events as provider/unhandled", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "turn/started",
      params: {
        threadId: "t1",
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "codex",
        rawType: "turn/started",
        threadId: "t1",
      }),
    );
  });

  it("translateEvent ignores resolved Codex server requests", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("serverRequest/resolved", {
        threadId: "t1",
        requestId: 0,
      }),
    );

    expect(events).toEqual([]);
  });

  it("translateEvent turn/completed with status and error", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("turn/completed", {
        threadId: "t1",
        turn: {
          id: "turn-1",
          items: [],
          status: "failed",
          error: {
            message: "rate limited",
            codexErrorInfo: null,
            additionalDetails: "try again",
          },
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        threadId: "t1",
        scope: turnScope("turn-1"),
        status: "failed",
        error: { message: "rate limited" },
      }),
    );
  });

  it("translateEvent turn/completed maps interrupted status", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("turn/completed", {
        threadId: "t1",
        turn: { id: "turn-1", items: [], status: "interrupted", error: null },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        status: "interrupted",
      }),
    );
  });

  // -- translateEvent: thread lifecycle ------------------------------------

  it("translateEvent thread/started emits started + identity + name", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("thread/started", {
        thread: {
          id: "codex-uuid-123",
          preview: "Fix the tests",
          ephemeral: false,
          modelProvider: "openai",
          createdAt: 0,
          updatedAt: 0,
          status: { type: "idle" },
          path: null,
          cwd: "/tmp",
          cliVersion: "0.1",
          source: "appServer",
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [],
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/started",
        threadId: "codex-uuid-123",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/identity",
        threadId: "codex-uuid-123",
        providerThreadId: "codex-uuid-123",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/name/updated",
        threadId: "codex-uuid-123",
        providerThreadId: "codex-uuid-123",
        threadName: "Fix the tests",
      }),
    );
  });

  it("translateEvent thread/name/updated", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("thread/name/updated", {
        threadId: "t1",
        threadName: "Updated title",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/name/updated",
        threadId: "t1",
        providerThreadId: "t1",
        threadName: "Updated title",
      }),
    );
  });

  it("translateEvent thread/name/updated ignores empty name", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("thread/name/updated", { threadId: "t1" }),
    );
    expect(events).toHaveLength(0);
  });

  it("translateEvent ignores native archive acknowledgements", () => {
    const adapter = createCodexProviderAdapter();

    expect(
      adapter.translateEvent(
        codexEvent("thread/archived", { threadId: "t1" }),
      ),
    ).toEqual([]);
    expect(
      adapter.translateEvent(
        codexEvent("thread/unarchived", { threadId: "t1" }),
      ),
    ).toEqual([]);
  });

  it("translateEvent thread/compacted emits a compacted event", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("thread/compacted", { threadId: "t1", turnId: "turn-1" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/compacted",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
      }),
    );
  });

  // -- translateEvent: items -----------------------------------------------

  it("translateEvent item/started with agentMessage", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/started", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "item-1",
          text: "Hello",
          phase: null,
          memoryCitation: null,
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
        item: { type: "agentMessage", id: "item-1", text: "Hello" },
      }),
    );
  });

  it("translateEvent item/started with userMessage is suppressed as a provider echo", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/started", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "userMessage",
          id: "user-1",
          content: [
            { type: "text", text: "hello", text_elements: [] },
            { type: "image", url: "https://example.com/image.png" },
            { type: "localImage", path: "/tmp/image.png" },
            { type: "skill", name: "repo-research", path: "/tmp/SKILL.md" },
          ],
        },
      }),
    );
    expect(events).toMatchObject([]);
  });

  it("translateEvent item/started with unsupported item type falls back to provider/unhandled", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/started", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "imageView",
          id: "image-1",
          path: "/tmp/image.png",
        },
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "codex",
        rawType: "item/started",
        threadId: "t1",
        scope: turnScope("turn-1"),
        rawEvent: expect.objectContaining({
          method: "item/started",
          params: expect.objectContaining({
            item: expect.objectContaining({
              type: "imageView",
            }),
          }),
        }),
      }),
    );
  });

  it("translateEvent unknown codex notifications fall back to provider/unhandled", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "t1",
        turnId: "turn-1",
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "codex",
        rawType: "item/tool/requestUserInput",
        threadId: "t1",
        scope: turnScope("turn-1"),
      }),
    );
  });

  it("translateEvent item/mcpToolCall/progress maps to shared tool progress", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/mcpToolCall/progress", {
        threadId: "t1",
        turnId: "turn-1",
        itemId: "mcp-1",
        message: "Connecting to MCP server",
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/toolCall/progress",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
        itemId: "mcp-1",
        message: "Connecting to MCP server",
      }),
    );
  });

  it("translateEvent item/completed with commandExecution maps status", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "ls -la",
          cwd: "/tmp",
          processId: null,
          status: "completed",
          commandActions: [],
          aggregatedOutput: "file1\nfile2",
          exitCode: 0,
          durationMs: 150,
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
        item: expect.objectContaining({
          type: "commandExecution",
          id: "cmd-1",
          command: "ls -la",
          status: "completed",
          exitCode: 0,
          durationMs: 150,
        }),
      }),
    );
  });

  it("translateEvent repairs completed commandExecution output from raw shell tool output", () => {
    const adapter = createCodexProviderAdapter();

    expect(
      adapter.translateEvent(
        codexEvent("rawResponseItem/completed", {
          threadId: "t1",
          turnId: "turn-1",
          item: {
            type: "function_call",
            name: "exec_command",
            arguments: '{"cmd":"echo hi"}',
            call_id: "cmd-1",
          },
        }),
      ),
    ).toMatchObject([]);

    expect(
      adapter.translateEvent(
        codexEvent("rawResponseItem/completed", {
          threadId: "t1",
          turnId: "turn-1",
          item: {
            type: "function_call_output",
            call_id: "cmd-1",
            output: [
              "Chunk ID: abc123",
              "Wall time: 3.6 seconds",
              "Process exited with code 0",
              "Original token count: 8",
              "Output:",
              "OUT-1",
              "OUT-2",
              "OUT-3",
              "",
            ].join("\n"),
          },
        }),
      ),
    ).toMatchObject([]);

    const events = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "echo hi",
          cwd: "/tmp",
          processId: null,
          status: "completed",
          commandActions: [],
          aggregatedOutput: "OUT-2\nOUT-3\n",
          exitCode: 0,
          durationMs: 150,
        },
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
        item: expect.objectContaining({
          type: "commandExecution",
          id: "cmd-1",
          aggregatedOutput: "OUT-1\nOUT-2\nOUT-3\n",
        }),
      }),
    );
  });

  it("translateEvent preserves literal Output lines in recovered command output", () => {
    const adapter = createCodexProviderAdapter();

    adapter.translateEvent(
      codexEvent("rawResponseItem/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "function_call",
          name: "exec_command",
          arguments: '{"cmd":"printf \'prefix\\\\nOutput:\\\\nsuffix\\\\n\'"}',
          call_id: "cmd-1",
        },
      }),
    );
    adapter.translateEvent(
      codexEvent("rawResponseItem/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "function_call_output",
          call_id: "cmd-1",
          output: [
            "Chunk ID: abc123",
            "Wall time: 1.2 seconds",
            "Process exited with code 0",
            "Original token count: 5",
            "Output:",
            "prefix",
            "Output:",
            "suffix",
            "",
          ].join("\n"),
        },
      }),
    );

    const events = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "printf 'prefix\\nOutput:\\nsuffix\\n'",
          cwd: "/tmp",
          processId: null,
          status: "completed",
          commandActions: [],
          aggregatedOutput: "Output:\nsuffix\n",
          exitCode: 0,
          durationMs: 150,
        },
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
        item: expect.objectContaining({
          type: "commandExecution",
          id: "cmd-1",
          aggregatedOutput: "prefix\nOutput:\nsuffix\n",
        }),
      }),
    );
  });

  it("translateEvent repairs completed commandExecution output for raw Bash shell aliases", () => {
    const adapter = createCodexProviderAdapter();
    const shellToolNames = ["Bash", "bash"];

    for (const [index, toolName] of shellToolNames.entries()) {
      const callId = `cmd-${index + 1}`;
      const fullOutput = `OUT-${index + 1}\n`;

      adapter.translateEvent(
        codexEvent("rawResponseItem/completed", {
          threadId: "t1",
          turnId: "turn-1",
          item: {
            type: "function_call",
            name: toolName,
            arguments: '{"cmd":"echo alias"}',
            call_id: callId,
          },
        }),
      );
      adapter.translateEvent(
        codexEvent("rawResponseItem/completed", {
          threadId: "t1",
          turnId: "turn-1",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: `Output:\n${fullOutput}`,
          },
        }),
      );

      const events = adapter.translateEvent(
        codexEvent("item/completed", {
          threadId: "t1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: callId,
            command: "echo alias",
            cwd: "/tmp",
            processId: null,
            status: "completed",
            commandActions: [],
            aggregatedOutput: "",
            exitCode: 0,
            durationMs: 150,
          },
        }),
      );

      expect(events).toContainEqual(
        expect.objectContaining({
          type: "item/completed",
          threadId: "t1",
          providerThreadId: "t1",
          scope: turnScope("turn-1"),
          item: expect.objectContaining({
            type: "commandExecution",
            id: callId,
            aggregatedOutput: fullOutput,
          }),
        }),
      );
    }
  });

  it("translateEvent preserves raw command output that starts with metadata-like text", () => {
    const adapter = createCodexProviderAdapter();

    adapter.translateEvent(
      codexEvent("rawResponseItem/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "function_call",
          name: "exec_command",
          arguments:
            '{"cmd":"printf \'Chunk ID: abc\\\\nactual stdout\\\\n\'"}',
          call_id: "cmd-1",
        },
      }),
    );
    adapter.translateEvent(
      codexEvent("rawResponseItem/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "function_call_output",
          call_id: "cmd-1",
          output: ["Chunk ID: abc", "actual stdout", ""].join("\n"),
        },
      }),
    );

    const events = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "printf 'Chunk ID: abc\\nactual stdout\\n'",
          cwd: "/tmp",
          processId: null,
          status: "completed",
          commandActions: [],
          aggregatedOutput: "actual stdout\n",
          exitCode: 0,
          durationMs: 150,
        },
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
        item: expect.objectContaining({
          type: "commandExecution",
          id: "cmd-1",
          aggregatedOutput: "Chunk ID: abc\nactual stdout\n",
        }),
      }),
    );
  });

  it("translateEvent ignores raw metadata wrappers that do not include an Output marker", () => {
    const adapter = createCodexProviderAdapter();

    adapter.translateEvent(
      codexEvent("rawResponseItem/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "function_call",
          name: "exec_command",
          arguments: '{"cmd":"echo hi"}',
          call_id: "cmd-1",
        },
      }),
    );
    adapter.translateEvent(
      codexEvent("rawResponseItem/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "function_call_output",
          call_id: "cmd-1",
          output: [
            "Chunk ID: abc123",
            "Wall time: 1.2 seconds",
            "Process exited with code 0",
            "Original token count: 5",
          ].join("\n"),
        },
      }),
    );

    const events = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "echo hi",
          cwd: "/tmp",
          processId: null,
          status: "completed",
          commandActions: [],
          aggregatedOutput: "provider output\n",
          exitCode: 0,
          durationMs: 150,
        },
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
        item: expect.objectContaining({
          type: "commandExecution",
          id: "cmd-1",
          aggregatedOutput: "provider output\n",
        }),
      }),
    );
  });

  it("translateEvent repairs concurrent commandExecution outputs independently", () => {
    const adapter = createCodexProviderAdapter();

    adapter.translateEvent(
      codexEvent("rawResponseItem/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "function_call",
          name: "exec_command",
          arguments: '{"cmd":"first"}',
          call_id: "cmd-a",
        },
      }),
    );
    adapter.translateEvent(
      codexEvent("rawResponseItem/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "function_call",
          name: "exec_command",
          arguments: '{"cmd":"second"}',
          call_id: "cmd-b",
        },
      }),
    );
    adapter.translateEvent(
      codexEvent("rawResponseItem/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "function_call_output",
          call_id: "cmd-a",
          output: "Output:\nA-1\nA-2\nA-3\n",
        },
      }),
    );
    adapter.translateEvent(
      codexEvent("rawResponseItem/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "function_call_output",
          call_id: "cmd-b",
          output: "Output:\nB-1\nB-2\nB-3\n",
        },
      }),
    );

    const firstEvents = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "commandExecution",
          id: "cmd-a",
          command: "first",
          cwd: "/tmp",
          processId: null,
          status: "completed",
          commandActions: [],
          aggregatedOutput: "A-2\nA-3\n",
          exitCode: 0,
          durationMs: 150,
        },
      }),
    );
    const secondEvents = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "commandExecution",
          id: "cmd-b",
          command: "second",
          cwd: "/tmp",
          processId: null,
          status: "completed",
          commandActions: [],
          aggregatedOutput: "B-2\nB-3\n",
          exitCode: 0,
          durationMs: 150,
        },
      }),
    );

    expect(firstEvents).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
        item: expect.objectContaining({
          type: "commandExecution",
          id: "cmd-a",
          aggregatedOutput: "A-1\nA-2\nA-3\n",
        }),
      }),
    );
    expect(secondEvents).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
        item: expect.objectContaining({
          type: "commandExecution",
          id: "cmd-b",
          aggregatedOutput: "B-1\nB-2\nB-3\n",
        }),
      }),
    );
  });

  it("translateEvent keeps another thread's recovered command output after a different thread completes", () => {
    const adapter = createCodexProviderAdapter();

    adapter.translateEvent(
      codexEvent("rawResponseItem/completed", {
        threadId: "thread-a",
        turnId: "turn-a",
        item: {
          type: "function_call",
          name: "exec_command",
          arguments: '{"cmd":"first"}',
          call_id: "cmd-a",
        },
      }),
    );
    adapter.translateEvent(
      codexEvent("rawResponseItem/completed", {
        threadId: "thread-a",
        turnId: "turn-a",
        item: {
          type: "function_call_output",
          call_id: "cmd-a",
          output: "Output:\nA-1\nA-2\n",
        },
      }),
    );
    adapter.translateEvent(
      codexEvent("rawResponseItem/completed", {
        threadId: "thread-b",
        turnId: "turn-b",
        item: {
          type: "function_call",
          name: "exec_command",
          arguments: '{"cmd":"second"}',
          call_id: "cmd-b",
        },
      }),
    );
    adapter.translateEvent(
      codexEvent("rawResponseItem/completed", {
        threadId: "thread-b",
        turnId: "turn-b",
        item: {
          type: "function_call_output",
          call_id: "cmd-b",
          output: "Output:\nB-1\nB-2\n",
        },
      }),
    );

    adapter.translateEvent(
      codexEvent("turn/completed", {
        threadId: "thread-a",
        turn: { id: "turn-a", items: [], status: "completed", error: null },
      }),
    );

    const events = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "thread-b",
        turnId: "turn-b",
        item: {
          type: "commandExecution",
          id: "cmd-b",
          command: "second",
          cwd: "/tmp",
          processId: null,
          status: "completed",
          commandActions: [],
          aggregatedOutput: "B-2\n",
          exitCode: 0,
          durationMs: 150,
        },
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        threadId: "thread-b",
        providerThreadId: "thread-b",
        scope: turnScope("turn-b"),
        item: expect.objectContaining({
          type: "commandExecution",
          id: "cmd-b",
          aggregatedOutput: "B-1\nB-2\n",
        }),
      }),
    );
  });

  it("translateEvent clears recovered raw command output state when a thread closes", () => {
    const adapter = createCodexProviderAdapter();

    adapter.translateEvent(
      codexEvent("rawResponseItem/completed", {
        threadId: "thread-a",
        turnId: "turn-a",
        item: {
          type: "function_call",
          name: "exec_command",
          arguments: '{"cmd":"echo hi"}',
          call_id: "cmd-a",
        },
      }),
    );

    adapter.translateEvent(
      codexEvent("thread/closed", {
        threadId: "thread-a",
      }),
    );

    adapter.translateEvent(
      codexEvent("rawResponseItem/completed", {
        threadId: "thread-a",
        turnId: "turn-a",
        item: {
          type: "function_call_output",
          call_id: "cmd-a",
          output: "Output:\nSTALE\n",
        },
      }),
    );

    const events = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "thread-a",
        turnId: "turn-a",
        item: {
          type: "commandExecution",
          id: "cmd-a",
          command: "echo hi",
          cwd: "/tmp",
          processId: null,
          status: "completed",
          commandActions: [],
          aggregatedOutput: "provider output\n",
          exitCode: 0,
          durationMs: 150,
        },
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        threadId: "thread-a",
        providerThreadId: "thread-a",
        scope: turnScope("turn-a"),
        item: expect.objectContaining({
          type: "commandExecution",
          id: "cmd-a",
          aggregatedOutput: "provider output\n",
        }),
      }),
    );
  });

  it("translateEvent item/completed with declined commandExecution maps approval denial", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "ls -la",
          cwd: "/tmp",
          processId: null,
          status: "declined",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
        item: expect.objectContaining({
          type: "commandExecution",
          id: "cmd-1",
          status: "interrupted",
          approvalStatus: "denied",
        }),
      }),
    );
  });

  it("translateEvent item/started normalizes commandExecution to pending", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/started", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "ls -la",
          cwd: "/tmp",
          processId: null,
          status: "declined",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
        item: expect.objectContaining({
          type: "commandExecution",
          id: "cmd-1",
          command: "ls -la",
          status: "pending",
          approvalStatus: null,
        }),
      }),
    );
  });

  it("translateEvent item/completed with fileChange maps kind correctly", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "fileChange",
          id: "fc-1",
          changes: [
            {
              path: "src/foo.ts",
              kind: { type: "update", move_path: null },
              diff: "+line",
            },
            { path: "src/bar.ts", kind: { type: "add" }, diff: "" },
          ],
          status: "completed",
        },
      }),
    );
    const itemEvent = events.find((e) => e.type === "item/completed");
    expect(itemEvent).toBeDefined();
    if (
      itemEvent?.type === "item/completed" &&
      itemEvent.item.type === "fileChange"
    ) {
      expect(itemEvent.item.changes).toMatchObject([
        {
          path: "src/foo.ts",
          kind: "update",
          diff: "+line",
        },
        {
          path: "src/bar.ts",
          kind: "add",
        },
      ]);
      expect(itemEvent.item.status).toBe("completed");
    }
  });

  it("translateEvent item/completed with mcpToolCall maps to toolCall", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "mcpToolCall",
          id: "mcp-1",
          server: "myserver",
          tool: "search",
          status: "completed",
          arguments: { query: "test" },
          result: null,
          error: null,
          durationMs: 200,
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
        item: expect.objectContaining({
          type: "toolCall",
          id: "mcp-1",
          server: "myserver",
          tool: "search",
          status: "completed",
          durationMs: 200,
        }),
      }),
    );
  });

  it("translateEvent item/completed with declined fileChange maps approval denial", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "fileChange",
          id: "edit-1",
          status: "declined",
          changes: [
            {
              path: "new.txt",
              kind: { type: "add" },
              diff: "+hello",
            },
          ],
        },
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
        item: expect.objectContaining({
          type: "fileChange",
          id: "edit-1",
          status: "interrupted",
          approvalStatus: "denied",
        }),
      }),
    );
  });

  it("translateEvent item/completed with dynamicToolCall maps to toolCall", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "dynamicToolCall",
          id: "dyn-1",
          tool: "bb_test_ping",
          arguments: {},
          status: "completed",
          contentItems: [{ type: "inputText", text: "PONG_FROM_TOOL" }],
          success: true,
          durationMs: 3,
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
        item: expect.objectContaining({
          type: "toolCall",
          id: "dyn-1",
          tool: "bb_test_ping",
          status: "completed",
          result: "PONG_FROM_TOOL",
          durationMs: 3,
        }),
      }),
    );
  });

  it("translateEvent item/completed with failed dynamicToolCall preserves textual errors", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "dynamicToolCall",
          id: "dyn-err-1",
          tool: "bb_test_ping",
          arguments: {},
          status: "failed",
          contentItems: [{ type: "inputText", text: "permission denied" }],
          success: false,
          durationMs: 8,
        },
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
        item: expect.objectContaining({
          type: "toolCall",
          id: "dyn-err-1",
          status: "failed",
          result: "permission denied",
          error: "permission denied",
        }),
      }),
    );
  });

  it("translateEvent item/completed with image-only dynamicToolCall keeps readable output", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "dynamicToolCall",
          id: "dyn-img-1",
          tool: "bb_test_image",
          arguments: {},
          status: "failed",
          contentItems: [
            {
              type: "inputImage",
              imageUrl: "https://example.com/tool-result.png",
            },
          ],
          success: false,
          durationMs: 4,
        },
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
        item: expect.objectContaining({
          type: "toolCall",
          id: "dyn-img-1",
          status: "failed",
          result: "[image: https://example.com/tool-result.png]",
          error: "[image: https://example.com/tool-result.png]",
        }),
      }),
    );
  });

  it("translateEvent item/completed with collabAgentToolCall maps to toolCall", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "collabAgentToolCall",
          id: "collab-1",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "t1",
          receiverThreadIds: ["sub-thread-1"],
          prompt: "Inspect the docs directory",
          model: "gpt-5.4",
          reasoningEffort: "medium",
          agentsStates: {
            "sub-thread-1": { status: "completed", message: "done" },
          },
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
        item: expect.objectContaining({
          type: "toolCall",
          id: "collab-1",
          tool: "spawnAgent",
          status: "completed",
          arguments: expect.objectContaining({
            senderThreadId: "t1",
            receiverThreadIds: ["sub-thread-1"],
            prompt: "Inspect the docs directory",
            model: "gpt-5.4",
            reasoningEffort: "medium",
          }),
          result: {
            "sub-thread-1": { status: "completed", message: "done" },
          },
        }),
      }),
    );
  });

  it("translateEvent item/completed with declined collabAgentToolCall maps to interrupted", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "collabAgentToolCall",
          id: "collab-declined-1",
          tool: "spawnAgent",
          status: "declined",
          senderThreadId: "t1",
          receiverThreadIds: ["sub-thread-1"],
          prompt: null,
          model: null,
          reasoningEffort: null,
          agentsStates: {},
        },
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
        item: expect.objectContaining({
          type: "toolCall",
          id: "collab-declined-1",
          status: "interrupted",
        }),
      }),
    );
  });

  it("translateEvent item/completed with search maps to webSearch", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "webSearch",
          id: "web-1",
          query: "react suspense",
          action: { type: "search", query: "react suspense", queries: null },
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
        item: {
          type: "webSearch",
          id: "web-1",
          queries: ["react suspense"],
          resultText: null,
        },
      }),
    );
  });

  it("translateEvent item/started with search maps to webSearch and merges query fields", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/started", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "webSearch",
          id: "web-start-1",
          query: "react suspense fallback",
          action: {
            type: "search",
            query: "react suspense primary",
            queries: ["react suspense primary", "react suspense secondary"],
          },
        },
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
        item: {
          type: "webSearch",
          id: "web-start-1",
          queries: [
            "react suspense primary",
            "react suspense secondary",
            "react suspense fallback",
          ],
          resultText: null,
        },
      }),
    );
  });

  it("translateEvent item/started with camelCase openPage maps to webFetch", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/started", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "webSearch",
          id: "web-open-start-1",
          query: "ignored fallback",
          action: { type: "openPage", url: "https://example.com" },
        },
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
        item: {
          type: "webFetch",
          id: "web-open-start-1",
          url: "https://example.com",
          prompt: null,
          pattern: null,
          resultText: null,
        },
      }),
    );
  });

  it("translateEvent item/started with camelCase findInPage maps to webFetch", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/started", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "webSearch",
          id: "web-find-start-1",
          query: "ignored fallback",
          action: {
            type: "findInPage",
            url: "https://example.com",
            pattern: "Example Domain",
          },
        },
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
        item: {
          type: "webFetch",
          id: "web-find-start-1",
          url: "https://example.com",
          prompt: null,
          pattern: "Example Domain",
          resultText: null,
        },
      }),
    );
  });

  it("translateEvent item/completed with camelCase openPage maps to webFetch", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "webSearch",
          id: "web-open-1",
          query: "https://example.com",
          action: { type: "openPage", url: "https://example.com" },
        },
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
        item: {
          type: "webFetch",
          id: "web-open-1",
          url: "https://example.com",
          prompt: null,
          pattern: null,
          resultText: null,
        },
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "provider/unhandled",
      }),
    );
  });

  it("translateEvent item/completed with camelCase findInPage maps to webFetch", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "webSearch",
          id: "web-find-1",
          query: "https://example.com",
          action: {
            type: "findInPage",
            url: "https://example.com",
            pattern: "Example Domain",
          },
        },
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
        item: {
          type: "webFetch",
          id: "web-find-1",
          url: "https://example.com",
          prompt: null,
          pattern: "Example Domain",
          resultText: null,
        },
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "provider/unhandled",
      }),
    );
  });

  it("translateEvent ignores placeholder webSearch started items without canonical details", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/started", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "webSearch",
          id: "web-placeholder-1",
          query: "",
          action: { type: "other" },
        },
      }),
    );

    expect(events).toMatchObject([]);
  });

  it("translateEvent ignores placeholder webSearch completed items without canonical details", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "webSearch",
          id: "web-placeholder-completed-1",
          query: "",
          action: null,
        },
      }),
    );

    expect(events).toMatchObject([]);
  });

  it("translateEvent item/completed with missing openPage url falls back to provider/unhandled", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "webSearch",
          id: "web-open-missing-url-1",
          query: "not-a-url",
          action: { type: "openPage", url: null },
        },
      }),
    );

    expect(
      events.some(
        (event) =>
          event.type === "provider/unhandled" &&
          event.rawType === "item/completed",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "item/completed" && event.item.type === "webFetch",
      ),
    ).toBe(false);
  });

  it("translateEvent item/completed with reasoning maps to reasoning", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "reasoning",
          id: "reasoning-1",
          summary: ["Read the search flow"],
          content: ["Investigated the search sidebar state machine."],
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
        item: {
          type: "reasoning",
          id: "reasoning-1",
          summary: ["Read the search flow"],
          content: ["Investigated the search sidebar state machine."],
        },
      }),
    );
  });

  it("translateEvent item/completed with plan maps to plan", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "plan",
          id: "plan-1",
          text: "1. Read the file\n2. Edit the function",
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
        item: {
          type: "plan",
          id: "plan-1",
          text: "1. Read the file\n2. Edit the function",
        },
      }),
    );
  });

  it("translateEvent item/started with contextCompaction maps to contextCompaction", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/started", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "contextCompaction",
          id: "compact-1",
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
        item: {
          type: "contextCompaction",
          id: "compact-1",
        },
      }),
    );
  });

  // -- translateEvent: streaming deltas ------------------------------------

  it("translateEvent item/agentMessage/delta", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/agentMessage/delta", {
        threadId: "t1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "hello ",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/agentMessage/delta",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
        itemId: "item-1",
        delta: "hello ",
      }),
    );
  });

  it("translateEvent item/commandExecution/outputDelta", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/commandExecution/outputDelta", {
        threadId: "t1",
        turnId: "turn-1",
        itemId: "cmd-1",
        delta: "output line\n",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/commandExecution/outputDelta",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
        itemId: "cmd-1",
        delta: "output line\n",
      }),
    );
  });

  // -- translateEvent: token usage -----------------------------------------

  it("translateEvent thread/tokenUsage/updated", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("thread/tokenUsage/updated", {
        threadId: "t1",
        turnId: "turn-1",
        tokenUsage: {
          total: {
            totalTokens: 100,
            inputTokens: 60,
            cachedInputTokens: 10,
            outputTokens: 30,
            reasoningOutputTokens: 0,
          },
          last: {
            totalTokens: 50,
            inputTokens: 30,
            cachedInputTokens: 5,
            outputTokens: 15,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 128000,
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/tokenUsage/updated",
        threadId: "t1",
        tokenUsage: expect.objectContaining({
          total: expect.objectContaining({ totalTokens: 100 }),
          modelContextWindow: 128000,
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/contextWindowUsage/updated",
        contextWindowUsage: {
          usedTokens: 50,
          modelContextWindow: 128000,
          estimated: false,
        },
      }),
    );
  });

  // -- translateEvent: plan/diff -------------------------------------------

  it("translateEvent turn/plan/updated maps step statuses", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("turn/plan/updated", {
        threadId: "t1",
        turnId: "turn-1",
        explanation: "Here's the plan",
        plan: [
          { step: "Read the file", status: "completed" },
          { step: "Edit the function", status: "inProgress" },
          { step: "Run tests", status: "pending" },
        ],
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/plan/updated",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
        explanation: "Here's the plan",
        plan: [
          { step: "Read the file", status: "completed" },
          { step: "Edit the function", status: "active" },
          { step: "Run tests", status: "pending" },
        ],
      }),
    );
  });

  it("translateEvent turn/plan/updated tolerates null explanations", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent({
      method: "turn/plan/updated",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        explanation: null,
        plan: [
          { step: "Read the file", status: "completed" },
          { step: "Run tests", status: "pending" },
        ],
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/plan/updated",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
        plan: [
          { step: "Read the file", status: "completed" },
          { step: "Run tests", status: "pending" },
        ],
      }),
    );
  });

  // -- translateEvent: errors ----------------------------------------------

  it("translateEvent error includes detail and willRetry", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("error", {
        threadId: "t1",
        turnId: "turn-1",
        error: {
          message: "Rate limited",
          codexErrorInfo: null,
          additionalDetails: "retry after 30s",
        },
        willRetry: true,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider/error",
        threadId: "t1",
        providerThreadId: "t1",
        scope: turnScope("turn-1"),
        message: "Provider error",
        detail: "Rate limited\nretry after 30s",
        willRetry: true,
      }),
    );
  });

  // -- translateEvent: warnings --------------------------------------------

  it("translateEvent deprecationNotice maps to warning", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("deprecationNotice", {
        summary: "Model deprecated",
        details: "Use newer model",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider/warning",
        threadId: "",
        providerThreadId: "",
        category: "deprecation",
        summary: "Model deprecated",
        details: "Use newer model",
      }),
    );
  });

  it("translateEvent configWarning maps to warning", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("configWarning", {
        summary: "Bad config",
        details: null,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider/warning",
        threadId: "",
        providerThreadId: "",
        category: "config",
        summary: "Bad config",
      }),
    );
  });

  it("translateEvent ignores MCP startup status updates", () => {
    const adapter = createCodexProviderAdapter();
    const failedEvents = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "mcpServer/startupStatus/updated",
      params: {
        name: "codex_apps",
        status: "failed",
        error: "MCP client failed to start",
      },
    });
    const readyEvents = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "mcpServer/startupStatus/updated",
      params: {
        name: "codex_apps",
        status: "ready",
        error: null,
      },
    });

    expect(failedEvents).toEqual([]);
    expect(readyEvents).toEqual([]);
  });

  // -- translateEvent: unknown events --------------------------------------

  it("translateEvent returns empty for unhandled codex events", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("account/rateLimits/updated", {
        rateLimits: {
          limitId: null,
          limitName: null,
          primary: null,
          secondary: null,
          credits: null,
          planType: null,
        },
      }),
    );
    expect(events).toMatchObject([]);
  });

  it("translateEvent ignores remote control status changes", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "remoteControl/status/changed",
      params: {
        status: "disabled",
        environmentId: null,
      },
    });

    expect(events).toEqual([]);
  });

  it("decodeToolCallRequest preserves numeric request ids", () => {
    const adapter = createCodexProviderAdapter();
    expect(
      adapter.decodeToolCallRequest({
        id: 7,
        method: "item/tool/call",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          callId: "call-1",
          tool: "bb_test_ping",
          arguments: { ping: true },
        },
      }),
    ).toEqual({
      requestId: 7,
      providerThreadId: "t1",
      turnId: "turn-1",
      callId: "call-1",
      tool: "bb_test_ping",
      arguments: { ping: true },
    });
  });

  it("decodeToolCallRequest returns null when the request id is missing", () => {
    const adapter = createCodexProviderAdapter();
    expect(
      adapter.decodeToolCallRequest({
        method: "item/tool/call",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          callId: "call-1",
          tool: "bb_test_ping",
          arguments: { ping: true },
        },
      }),
    ).toBeNull();
  });

  it("decodeInteractiveRequest maps command approval requests into pending interaction payloads", () => {
    const adapter = createCodexProviderAdapter();
    expect(
      adapter.decodeInteractiveRequest?.({
        id: 8,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          itemId: "item-1",
          reason: "Needs approval",
          command: "git push",
          cwd: "/tmp/project",
          commandActions: [
            {
              type: "unknown",
              command: "git push",
            },
          ],
          additionalPermissions: {
            network: { enabled: true },
            fileSystem: null,
            macos: null,
          },
          availableDecisions: ["accept", "acceptForSession", "decline"],
        },
      }),
    ).toEqual({
      requestId: 8,
      method: "item/commandExecution/requestApproval",
      providerThreadId: "t1",
      turnId: "turn-1",
      payload: {
        subject: {
          kind: "command",
          itemId: "item-1",
          command: "git push",
          cwd: "/tmp/project",
          actions: [
            {
              type: "unknown",
              command: "git push",
            },
          ],
          sessionGrant: {
            network: { enabled: true },
            fileSystem: null,
          },
        },
        reason: "Needs approval",
        availableDecisions: ["allow_once", "allow_for_session", "deny"],
      },
    });
  });

  it("decodeInteractiveRequest omits command session approval without session grants", () => {
    const adapter = createCodexProviderAdapter();
    expect(
      adapter.decodeInteractiveRequest?.({
        id: 80,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          itemId: "item-1",
          reason: "Needs approval",
          command: "git push",
          cwd: "/tmp/project",
          commandActions: [],
          availableDecisions: ["accept", "acceptForSession", "decline"],
        },
      }),
    ).toEqual({
      requestId: 80,
      method: "item/commandExecution/requestApproval",
      providerThreadId: "t1",
      turnId: "turn-1",
      payload: {
        subject: {
          kind: "command",
          itemId: "item-1",
          command: "git push",
          cwd: "/tmp/project",
          actions: [],
          sessionGrant: null,
        },
        reason: "Needs approval",
        availableDecisions: ["allow_once", "deny"],
      },
    });
  });

  it("decodeInteractiveRequest rejects empty command approval decisions as invalid params", () => {
    const adapter = createCodexProviderAdapter();
    expect(() =>
      adapter.decodeInteractiveRequest?.({
        id: 8,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          itemId: "item-1",
          reason: "Needs approval",
          command: "git push",
          cwd: "/tmp/project",
          commandActions: [],
          availableDecisions: [],
        },
      }),
    ).toThrowError(ProviderRequestDecodeError);
  });

  it("decodeInteractiveRequest maps cancel-only command approval decisions to deny", () => {
    const adapter = createCodexProviderAdapter();
    expect(
      adapter.decodeInteractiveRequest?.({
        id: 8,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          itemId: "item-1",
          reason: "Needs approval",
          command: "git push",
          cwd: "/tmp/project",
          commandActions: [],
          availableDecisions: ["cancel"],
        },
      }),
    ).toMatchObject({
      payload: {
        availableDecisions: ["deny"],
      },
    });
  });

  it("decodeInteractiveRequest rejects unsupported macOS permissions in command session grants", () => {
    const adapter = createCodexProviderAdapter();
    expect(() =>
      adapter.decodeInteractiveRequest?.({
        id: 8,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          itemId: "item-1",
          reason: "Needs approval",
          command: "osascript -e 'tell app \"Finder\" to activate'",
          cwd: "/tmp/project",
          commandActions: [],
          additionalPermissions: {
            network: null,
            fileSystem: null,
            macos: {
              preferences: "read_only",
              automations: {
                bundle_ids: ["com.apple.finder"],
              },
              launchServices: true,
              accessibility: true,
              calendar: false,
              reminders: false,
              contacts: "none",
            },
          },
          availableDecisions: ["accept", "decline"],
        },
      }),
    ).toThrowError(ProviderRequestDecodeError);
  });

  it("decodeInteractiveRequest rejects macOS automation none in command approvals", () => {
    const adapter = createCodexProviderAdapter();
    expect(() =>
      adapter.decodeInteractiveRequest?.({
        id: 81,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          itemId: "item-1",
          reason: "Needs approval",
          command: "open -a Finder",
          cwd: "/tmp/project",
          commandActions: [],
          additionalPermissions: {
            network: null,
            fileSystem: null,
            macos: {
              preferences: "none",
              automations: "none",
              launchServices: false,
              accessibility: false,
              calendar: false,
              reminders: false,
              contacts: "none",
            },
          },
          availableDecisions: ["accept", "decline"],
        },
      }),
    ).toThrowError(ProviderRequestDecodeError);
  });

  it("decodeInteractiveRequest rejects unsupported macOS automation grants from command session grants", () => {
    const adapter = createCodexProviderAdapter();
    expect(() =>
      adapter.decodeInteractiveRequest?.({
        id: 82,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          itemId: "item-1",
          reason: "Needs approval",
          command: "open -a Finder",
          cwd: "/tmp/project",
          commandActions: [],
          additionalPermissions: {
            network: null,
            fileSystem: null,
            macos: {
              preferences: "none",
              automations: "all",
              launchServices: false,
              accessibility: false,
              calendar: false,
              reminders: false,
              contacts: "none",
            },
          },
          availableDecisions: ["accept", "decline"],
        },
      }),
    ).toThrowError(ProviderRequestDecodeError);
  });

  it("decodeInteractiveRequest ignores unsupported policy-amendment decisions when simple decisions remain", () => {
    const adapter = createCodexProviderAdapter();
    expect(
      adapter.decodeInteractiveRequest?.({
        id: 9,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-2",
          itemId: "item-2",
          reason: "Needs approval",
          command: "git push",
          cwd: "/tmp/project",
          commandActions: [],
          additionalPermissions: null,
          availableDecisions: [
            {
              acceptWithExecpolicyAmendment: {
                execpolicy_amendment: ["allow", "git", "push"],
              },
            },
            {
              applyNetworkPolicyAmendment: {
                network_policy_amendment: {
                  host: "api.openai.com",
                  action: "allow",
                },
              },
            },
            "decline",
          ],
        },
      }),
    ).toMatchObject({
      payload: {
        subject: {
          kind: "command",
          command: "git push",
        },
        availableDecisions: ["deny"],
      },
    });
  });

  it("decodeInteractiveRequest rejects policy-amendment-only command approval decisions", () => {
    const adapter = createCodexProviderAdapter();
    expect(() =>
      adapter.decodeInteractiveRequest?.({
        id: 90,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-network-amendment",
          itemId: "item-network-amendment",
          reason: "Needs network policy approval",
          command: "curl https://api.openai.com",
          cwd: "/tmp/project",
          commandActions: [],
          additionalPermissions: null,
          availableDecisions: [
            {
              acceptWithExecpolicyAmendment: {
                execpolicy_amendment: ["allow", "git", "push"],
              },
            },
            {
              applyNetworkPolicyAmendment: {
                network_policy_amendment: {
                  host: "api.openai.com",
                  action: "allow",
                },
              },
            },
          ],
        },
      }),
    ).toThrowError(ProviderRequestDecodeError);
  });

  it("decodeInteractiveRequest preserves deny when policy amendments are paired with cancel", () => {
    const adapter = createCodexProviderAdapter();
    expect(
      adapter.decodeInteractiveRequest?.({
        id: 91,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-network-amendment-deny",
          itemId: "item-network-amendment-deny",
          reason: "Needs network policy approval",
          command: "curl https://api.openai.com",
          cwd: "/tmp/project",
          commandActions: [],
          additionalPermissions: null,
          availableDecisions: [
            {
              applyNetworkPolicyAmendment: {
                network_policy_amendment: {
                  host: "api.openai.com",
                  action: "allow",
                },
              },
            },
            "cancel",
          ],
        },
      }),
    ).toMatchObject({
      payload: {
        availableDecisions: ["deny"],
      },
    });
  });

  it("decodeInteractiveRequest maps file-change approvals into pending interactions", () => {
    const adapter = createCodexProviderAdapter();
    expect(
      adapter.decodeInteractiveRequest?.({
        id: 10,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-file-change",
          itemId: "item-file-change",
          reason: "Review generated file changes",
          grantRoot: "/tmp/project",
        },
      }),
    ).toEqual({
      requestId: 10,
      method: "item/fileChange/requestApproval",
      providerThreadId: "t1",
      turnId: "turn-file-change",
      payload: {
        subject: {
          kind: "file_change",
          itemId: "item-file-change",
          writeScope: "/tmp/project",
          sessionGrant: {
            network: null,
            fileSystem: {
              read: [],
              write: ["/tmp/project"],
            },
          },
        },
        reason: "Review generated file changes",
        availableDecisions: ["allow_once", "allow_for_session", "deny"],
      },
    });
  });

  it("decodeInteractiveRequest omits file-change session approval without grant root", () => {
    const adapter = createCodexProviderAdapter();
    expect(
      adapter.decodeInteractiveRequest?.({
        id: 11,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-file-change",
          itemId: "item-file-change",
          reason: "Review generated file changes",
          grantRoot: null,
        },
      }),
    ).toEqual({
      requestId: 11,
      method: "item/fileChange/requestApproval",
      providerThreadId: "t1",
      turnId: "turn-file-change",
      payload: {
        subject: {
          kind: "file_change",
          itemId: "item-file-change",
          writeScope: null,
          sessionGrant: null,
        },
        reason: "Review generated file changes",
        availableDecisions: ["allow_once", "deny"],
      },
    });
  });

  it("decodeInteractiveRequest maps permission approvals into pending interactions", () => {
    const adapter = createCodexProviderAdapter();
    expect(
      adapter.decodeInteractiveRequest?.({
        id: 11,
        method: "item/permissions/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-permissions",
          itemId: "item-permissions",
          reason: "Need network access",
          permissions: {
            network: { enabled: true },
            fileSystem: {
              read: ["/tmp/project/README.md"],
              write: [],
            },
          },
        },
      }),
    ).toEqual({
      requestId: 11,
      method: "item/permissions/requestApproval",
      providerThreadId: "t1",
      turnId: "turn-permissions",
      payload: {
        subject: {
          kind: "permission_grant",
          itemId: "item-permissions",
          toolName: null,
          permissions: {
            network: { enabled: true },
            fileSystem: {
              read: ["/tmp/project/README.md"],
              write: [],
            },
          },
        },
        reason: "Need network access",
        availableDecisions: ["allow_once", "allow_for_session", "deny"],
      },
    });
  });

  it("buildInteractiveResponse maps bb command approvals back to Codex responses", () => {
    const adapter = createCodexProviderAdapter();
    expect(
      adapter.buildInteractiveResponse?.({
        request: {
          requestId: 8,
          method: "item/commandExecution/requestApproval",
          providerThreadId: "t1",
          turnId: "turn-1",
          payload: {
            subject: {
              kind: "command",
              itemId: "item-1",
              command: "git push",
              cwd: "/tmp/project",
              actions: [],
              sessionGrant: null,
            },
            reason: null,
            availableDecisions: ["allow_once", "allow_for_session", "deny"],
          },
        },
        resolution: {
          decision: "allow_for_session",
          grantedPermissions: null,
        },
      }),
    ).toEqual({
      decision: "acceptForSession",
    });
  });

  it("buildInteractiveResponse maps command denial back to Codex responses", () => {
    const adapter = createCodexProviderAdapter();
    expect(
      adapter.buildInteractiveResponse?.({
        request: {
          requestId: 10,
          method: "item/commandExecution/requestApproval",
          providerThreadId: "t1",
          turnId: "turn-3",
          payload: {
            subject: {
              kind: "command",
              itemId: "item-3",
              command: "git push",
              cwd: "/tmp/project",
              actions: [],
              sessionGrant: null,
            },
            reason: null,
            availableDecisions: ["allow_once", "deny"],
          },
        },
        resolution: {
          decision: "deny",
        },
      }),
    ).toEqual({
      decision: "decline",
    });
  });

  it("buildInteractiveResponse maps file-change approvals back to Codex responses", () => {
    const adapter = createCodexProviderAdapter();
    expect(
      adapter.buildInteractiveResponse?.({
        request: {
          requestId: 12,
          method: "item/fileChange/requestApproval",
          providerThreadId: "t1",
          turnId: "turn-file-change",
          payload: {
            subject: {
              kind: "file_change",
              itemId: "item-file-change",
              writeScope: null,
              sessionGrant: null,
            },
            reason: "Review generated file changes",
            availableDecisions: ["allow_once", "allow_for_session", "deny"],
          },
        },
        resolution: {
          decision: "allow_for_session",
          grantedPermissions: null,
        },
      }),
    ).toEqual({
      decision: "acceptForSession",
    });
  });

  it("buildInteractiveResponse maps permission grants back to Codex responses", () => {
    const adapter = createCodexProviderAdapter();
    expect(
      adapter.buildInteractiveResponse?.({
        request: {
          requestId: 13,
          method: "item/permissions/requestApproval",
          providerThreadId: "t1",
          turnId: "turn-permissions",
          payload: {
            subject: {
              kind: "permission_grant",
              itemId: "item-permissions",
              toolName: null,
              permissions: {
                network: { enabled: true },
                fileSystem: {
                  read: ["/tmp/project/README.md"],
                  write: [],
                },
              },
            },
            reason: "Need network access",
            availableDecisions: ["allow_once", "allow_for_session", "deny"],
          },
        },
        resolution: {
          decision: "allow_for_session",
          grantedPermissions: {
            network: { enabled: true },
            fileSystem: {
              read: ["/tmp/project/README.md"],
              write: [],
            },
          },
        },
      }),
    ).toEqual({
      permissions: {
        network: { enabled: true },
        fileSystem: {
          read: ["/tmp/project/README.md"],
          write: null,
        },
      },
      scope: "session",
    });
  });

  // -- listModels ----------------------------------------------------------

  it("parseModelListResult validates model/list payloads", () => {
    const adapter = createCodexProviderAdapter();
    const result = adapter.parseModelListResult({
      data: [
        {
          id: "codex-mini",
          model: "codex-mini",
          displayName: "Codex Mini",
          description: "Fast coding model",
          supportedReasoningEfforts: [],
          defaultReasoningEffort: "medium",
          isDefault: true,
        },
      ],
    });
    expect(result.models).toHaveLength(1);
    expect(result.selectedOnlyModels).toHaveLength(0);
  });
});

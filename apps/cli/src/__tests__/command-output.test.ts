import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import {
  buildThreadEventRow,
  turnScope,
  type Environment,
  type PendingInteraction,
  type PendingInteractionApprovalDecision,
  type Thread,
  type ThreadGitDiffResponse,
} from "@bb/domain";
import type {
  ThreadTimelineResponse,
  TimelineRow,
  TimelineRowBase,
  TimelineUserConversationRow,
} from "@bb/server-contract";

const readlineState = vi.hoisted(() => ({
  question: vi.fn(),
  close: vi.fn(),
}));

vi.mock("../client.js", () => {
  return {
    createClient: vi.fn(),
    unwrap: vi.fn(async (responsePromise: Promise<unknown>) => {
      return responsePromise;
    }),
  };
});

vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(() => ({
    question: readlineState.question,
    close: readlineState.close,
  })),
}));

vi.mock("../daemon.js", () => ({
  fetchLocalHostId: vi.fn(async () => "host-test-001"),
}));

import { createClient, unwrap } from "../client.js";
import { registerEnvironmentCommands } from "../commands/environment.js";
import { registerGuideCommand } from "../commands/guide.js";
import { registerHostCommands } from "../commands/host.js";
import { registerManagerCommands } from "../commands/manager.js";
import { registerProjectCommands } from "../commands/project.js";
import { registerProviderCommands } from "../commands/provider.js";
import { registerStatusCommand } from "../commands/status.js";
import { registerThreadCommands } from "../commands/thread/index.js";

type ServerClient = ReturnType<typeof createClient>;

interface TimelineBaseArgs {
  id: string;
  sourceSeqStart: number;
  sourceSeqEnd?: number;
  startedAt?: number;
  createdAt?: number;
}

function makeTimelineBase(args: TimelineBaseArgs): TimelineRowBase {
  return {
    id: args.id,
    threadId: "thread-log",
    turnId: null,
    sourceSeqStart: args.sourceSeqStart,
    sourceSeqEnd: args.sourceSeqEnd ?? args.sourceSeqStart,
    startedAt: args.startedAt ?? args.createdAt ?? args.sourceSeqStart,
    createdAt: args.createdAt ?? args.sourceSeqStart,
  };
}

/**
 * Mock for the `GET /threads/:id/timeline` endpoint used by `bb thread show`
 * and `bb status` to read `pendingTodos`. Tests should add this alongside
 * their `:id.$get` mock so contract drift on the timeline lane fails loudly
 * instead of silently degrading to `pendingTodos: null`.
 */
function makeEmptyTimelineGetMock() {
  return vi.fn(async () => makeTimelineResponse([]));
}

function makeTimelineResponse(rows: TimelineRow[]): ThreadTimelineResponse {
  return {
    rows,
    activeThinking: null,
    pendingTodos: null,
    timelinePage: {
      kind: "latest",
      segmentLimit: 20,
      returnedSegmentCount: rows.length > 0 ? 1 : 0,
      hasOlderRows: false,
      olderCursor: null,
    },
  };
}

function makePendingSteerTimelineRow(): TimelineUserConversationRow {
  return {
    ...makeTimelineBase({
      id: "pending-steer-1",
      sourceSeqStart: 12,
    }),
    kind: "conversation",
    role: "user",
    text: "Please switch to the safer plan",
    attachments: null,
    initiator: "user",
    senderThreadId: null,
    turnRequest: { kind: "steer", status: "pending" },
  };
}

function makeThread(
  overrides: Partial<Thread> & {
    id: string;
    projectId: string;
    providerId: string;
  },
): Thread {
  return {
    type: "standard",
    status: "idle",
    title: null,
    titleFallback: null,
    automationId: null,
    environmentId: null,
    parentThreadId: null,
    archivedAt: null,
    stopRequestedAt: null,
    deletedAt: null,
    lastReadAt: null,
    latestAttentionAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeEnvironment(
  overrides: Partial<Environment> & {
    id: string;
    projectId: string;
    hostId: string;
  },
): Environment {
  return {
    path: "/tmp/environment",
    managed: false,
    isGitRepo: true,
    isWorktree: false,
    workspaceProvisionType: "unmanaged",
    branchName: "bb/thread",
    defaultBranch: "main",
    baseBranch: null,
    mergeBaseBranch: null,
    cleanupRequestedAt: null,
    cleanupMode: null,
    status: "ready",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makePendingInteraction(
  overrides: Partial<PendingInteraction> & {
    id: string;
    providerId: string;
    providerRequestId: string;
    providerThreadId: string;
    threadId: string;
    turnId: string;
  },
): PendingInteraction {
  return {
    createdAt: Date.now(),
    payload: {
      kind: "approval",
      subject: {
        kind: "command",
        itemId: "item-1",
        command: "git push",
        cwd: "/tmp/project",
        actions: [],
        sessionGrant: null,
      },
      reason: "Approve command",
      availableDecisions: ["allow_once", "allow_for_session", "deny"],
    },
    resolution: null,
    resolvedAt: null,
    status: "pending",
    statusReason: null,
    ...overrides,
  };
}

function makeCommandApprovalPayload(
  itemId: string,
  availableDecisions: PendingInteractionApprovalDecision[] = [
    "allow_once",
    "allow_for_session",
    "deny",
  ],
): PendingInteraction["payload"] {
  return {
    kind: "approval",
    subject: {
      kind: "command",
      itemId,
      command: "git push",
      cwd: "/tmp/project",
      actions: [],
      sessionGrant: null,
    },
    reason: "Approve command",
    availableDecisions,
  };
}

function makeFileChangeApprovalPayload(
  itemId: string,
): PendingInteraction["payload"] {
  return {
    kind: "approval",
    subject: {
      kind: "file_change",
      itemId,
      writeScope: null,
      sessionGrant: null,
    },
    reason: "Approve file changes",
    availableDecisions: ["allow_once", "allow_for_session", "deny"],
  };
}

function makeUserQuestionPayload(): PendingInteraction["payload"] {
  return {
    kind: "user_question",
    questions: [
      {
        id: "question-1",
        prompt: "Which deployment path?",
        shortLabel: "Path",
        multiSelect: false,
        options: [
          { value: "staging", label: "Staging" },
          { value: "production", label: "Production" },
        ],
        allowFreeText: true,
      },
    ],
  };
}

function makeMultiUserQuestionPayload(): PendingInteraction["payload"] {
  return {
    kind: "user_question",
    questions: [
      {
        id: "question-1",
        prompt: "Which deployment path?",
        shortLabel: "Path",
        multiSelect: false,
        options: [
          { value: "staging", label: "Staging" },
          { value: "production", label: "Production" },
        ],
        allowFreeText: false,
      },
      {
        id: "question-2",
        prompt: "Any rollout notes?",
        shortLabel: "Notes",
        multiSelect: false,
        allowFreeText: true,
      },
    ],
  };
}

function makePermissionGrantApprovalPayload(
  itemId: string,
): PendingInteraction["payload"] {
  return {
    kind: "approval",
    subject: {
      kind: "permission_grant",
      itemId,
      toolName: null,
      permissions: {
        network: { enabled: true },
        fileSystem: {
          read: ["/tmp/project/README.md"],
          write: ["/tmp/project/notes.md"],
        },
      },
    },
    reason: "Grant workspace access",
    availableDecisions: ["allow_once", "allow_for_session", "deny"],
  };
}

function asServerClient(value: unknown): ServerClient {
  return value as ServerClient;
}

function collectLogLines(logSpy: ReturnType<typeof vi.spyOn>): string[] {
  return logSpy.mock.calls.map((args: unknown[]) => args.join(" "));
}

function collectLogPayloads(logSpy: ReturnType<typeof vi.spyOn>): string[] {
  return logSpy.mock.calls.map((args: unknown[]) => String(args[0] ?? ""));
}

async function runCommand(
  args: string[],
  register: (program: Command) => void,
): Promise<void> {
  const program = new Command();
  register(program);
  await program.parseAsync(["node", "bb", ...args]);
}

async function getHelpOutput(
  args: string[],
  register: (program: Command) => void,
): Promise<string> {
  const program = new Command();
  const writeOut = vi.fn();
  program.exitOverride();
  program.configureOutput({
    writeOut,
    writeErr: vi.fn(),
  });
  register(program);

  await expect(
    program.parseAsync(["node", "bb", ...args, "--help"]),
  ).rejects.toMatchObject({
    code: "commander.helpDisplayed",
  });

  return writeOut.mock.calls
    .map((callArgs) => String(callArgs[0] ?? ""))
    .join("");
}

describe("CLI command output contracts", () => {
  const createClientMock = vi.mocked(createClient);
  const unwrapMock = vi.mocked(unwrap);

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(
      (code?: string | number | null) => {
        throw new Error(`process.exit:${code ?? 0}`);
      },
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    createClientMock.mockReset();
    unwrapMock.mockReset();
    unwrapMock.mockImplementation(async (responsePromise: Promise<unknown>) => {
      return responsePromise;
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    readlineState.question.mockReset();
    readlineState.close.mockReset();

    vi.stubEnv("BB_PROJECT_ID", undefined);
    vi.stubEnv("BB_THREAD_ID", undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("bb guide styling prints the styling chapter", async () => {
    await runCommand(["guide", "styling"], registerGuideCommand);

    const output = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(output.trim().length).toBeGreaterThan(0);
    expect(output).toContain("STATUS.html styling");
    expect(output).toContain("https://cdn.tailwindcss.com");
    expect(output).toContain("--background: oklch(0.9551 0 0);");
    expect(output).toContain("@media (prefers-color-scheme: dark)");
  });

  it("bb guide async prints the async chapter", async () => {
    await runCommand(["guide", "async"], registerGuideCommand);

    const output = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(output.trim().length).toBeGreaterThan(0);
    expect(output).toContain("Async scheduled nudges");
    expect(output).toContain("Use `ASYNC.md` in thread storage");
    expect(output).toContain("No more than 20 schedules.");
  });

  it("bb guide unknown chapter lists styling in available chapters", async () => {
    await expect(
      runCommand(["guide", "missing"], registerGuideCommand),
    ).rejects.toThrow("process.exit:1");

    const errorOutput = collectLogLines(vi.mocked(console.error)).join("\n");
    expect(errorOutput).toContain("Unknown guide chapter 'missing'");
    expect(errorOutput).toContain(
      "Available: threads, environments, managers, providers, projects, hosts, styling, async.",
    );
  });

  it("bb project list --json prints raw projects", async () => {
    const projects = [
      {
        id: "proj-1",
        name: "Alpha",
        createdAt: 1,
        updatedAt: 2,
      },
    ];
    const get = vi.fn(async () => projects);
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            projects: {
              $get: get,
            },
          },
        },
      }),
    );

    await runCommand(["project", "list", "--json"], (program) =>
      registerProjectCommands(program, () => "http://server"),
    );

    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual(projects);
  });

  it("bb project list renders the shared borderless table", async () => {
    const projects = [
      {
        id: "proj-1",
        name: "Alpha",
        sources: [
          { hostId: "host-test-001", type: "local_path", path: "/tmp/alpha" },
        ],
        createdAt: 1,
        updatedAt: 2,
      },
    ];
    const get = vi.fn(async () => projects);
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            projects: {
              $get: get,
            },
          },
        },
      }),
    );

    await runCommand(["project", "list"], (program) =>
      registerProjectCommands(program, () => "http://server"),
    );

    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "",
      "ID      Name   Local Path\n------  -----  ----------\nproj-1  Alpha  /tmp/alpha",
      "",
    ]);
  });

  it("bb project create --json prints the created project", async () => {
    const created = {
      id: "proj-created",
      name: "Alpha",
      createdAt: 1,
      updatedAt: 2,
    };
    const post = vi.fn(async () => created);
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            projects: {
              $post: post,
            },
          },
        },
      }),
    );

    await runCommand(
      [
        "project",
        "create",
        "--name",
        "Alpha",
        "--root",
        "/tmp/alpha",
        "--host",
        "host-1",
        "--json",
      ],
      (program) => registerProjectCommands(program, () => "http://server"),
    );

    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual(created);
  });

  it("bb project source update patches the existing source type", async () => {
    const get = vi.fn(async () => ({
      createdAt: 1,
      id: "proj-1",
      name: "Alpha",
      sources: [
        {
          createdAt: 1,
          hostId: "host-test-001",
          id: "source-1",
          isDefault: true,
          path: "/tmp/alpha",
          projectId: "proj-1",
          type: "local_path",
          updatedAt: 2,
        },
      ],
      updatedAt: 2,
    }));
    const patch = vi.fn(async () => ({
      createdAt: 1,
      hostId: "host-test-001",
      id: "source-1",
      isDefault: true,
      path: "/tmp/renamed",
      projectId: "proj-1",
      type: "local_path",
      updatedAt: 3,
    }));
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            projects: {
              ":id": {
                $get: get,
                sources: {
                  ":sourceId": {
                    $patch: patch,
                  },
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(
      [
        "project",
        "source",
        "update",
        "proj-1",
        "source-1",
        "--path",
        "/tmp/renamed",
      ],
      (program) => registerProjectCommands(program, () => "http://server"),
    );

    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Project source updated: source-1",
    );
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "source-1  host-test-001 (local)  local_path  /tmp/renamed [default]",
    );
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        json: {
          path: "/tmp/renamed",
          type: "local_path",
        },
        param: { id: "proj-1", sourceId: "source-1" },
      }),
    );
  });

  it("bb project source delete deletes without prompting when --yes is passed", async () => {
    const del = vi.fn(async () => ({ ok: true }));
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            projects: {
              ":id": {
                sources: {
                  ":sourceId": {
                    $delete: del,
                  },
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(
      ["project", "source", "delete", "proj-1", "source-1", "--yes"],
      (program) => registerProjectCommands(program, () => "http://server"),
    );

    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Project source source-1 deleted",
    );
    expect(readlineState.question).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        param: { id: "proj-1", sourceId: "source-1" },
      }),
    );
  });

  it("bb manager hire posts to the project manager route", async () => {
    const post = vi.fn(async () => ({
      id: "thread-manager-1",
      projectId: "project-123",
      title: "Manager",
      type: "manager",
      status: "active",
      createdAt: 1,
      updatedAt: 2,
    }));
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            projects: {
              ":id": {
                managers: {
                  $post: post,
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(
      [
        "manager",
        "hire",
        "project-123",
        "--name",
        "Manager",
        "--provider",
        "claude-code",
        "--model",
        "claude-opus-4-7",
        "--template",
        "minimal",
        "--reasoning-level",
        "high",
      ],
      (program) => registerManagerCommands(program, () => "http://server"),
    );

    expect(post).toHaveBeenCalledWith({
      param: { id: "project-123" },
      json: {
        environment: { type: "host", hostId: "host-test-001" },
        origin: "cli",
        model: "claude-opus-4-7",
        name: "Manager",
        providerId: "claude-code",
        reasoningLevel: "high",
        templateName: "minimal",
      },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Manager hired: thread-manager-1",
    );
  });

  it("bb manager hire omits reasoning level when not provided", async () => {
    const post = vi.fn(async () => ({
      id: "thread-manager-2",
      projectId: "project-123",
      title: "Manager",
      type: "manager",
      status: "active",
      createdAt: 1,
      updatedAt: 2,
    }));
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            projects: {
              ":id": {
                managers: {
                  $post: post,
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(
      [
        "manager",
        "hire",
        "project-123",
        "--name",
        "Manager",
        "--provider",
        "claude-code",
        "--model",
        "claude-opus-4-7",
      ],
      (program) => registerManagerCommands(program, () => "http://server"),
    );

    expect(post).toHaveBeenCalledWith({
      param: { id: "project-123" },
      json: {
        environment: { type: "host", hostId: "host-test-001" },
        origin: "cli",
        model: "claude-opus-4-7",
        name: "Manager",
        providerId: "claude-code",
      },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Manager hired: thread-manager-2",
    );
  });

  it("bb manager hire omits provider and model when the user relies on remembered manager defaults", async () => {
    const post = vi.fn(async () => ({
      id: "thread-manager-3",
      projectId: "project-123",
      title: "Manager",
      type: "manager",
      status: "active",
      createdAt: 1,
      updatedAt: 2,
    }));
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            projects: {
              ":id": {
                managers: {
                  $post: post,
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(
      ["manager", "hire", "project-123", "--name", "Manager"],
      (program) => registerManagerCommands(program, () => "http://server"),
    );

    expect(post).toHaveBeenCalledWith({
      param: { id: "project-123" },
      json: {
        environment: { type: "host", hostId: "host-test-001" },
        name: "Manager",
        origin: "cli",
      },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Manager hired: thread-manager-3",
    );
  });

  it("bb manager hire forwards managed permission mode", async () => {
    const post = vi.fn(async () => ({
      id: "thread-manager-4",
      projectId: "project-123",
      title: "Manager",
      type: "manager",
      status: "active",
      createdAt: 1,
      updatedAt: 2,
    }));
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            projects: {
              ":id": {
                managers: {
                  $post: post,
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(
      [
        "manager",
        "hire",
        "project-123",
        "--permission-mode",
        "workspace-write",
      ],
      (program) => registerManagerCommands(program, () => "http://server"),
    );

    expect(post).toHaveBeenCalledWith({
      param: { id: "project-123" },
      json: {
        environment: { type: "host", hostId: "host-test-001" },
        origin: "cli",
        permissionMode: "workspace-write",
      },
    });
  });

  it("bb manager hire help lists permission modes and server defaults", async () => {
    const helpOutput = await getHelpOutput(["manager", "hire"], (program) =>
      registerManagerCommands(program, () => "http://server"),
    );

    expect(helpOutput).toContain("--permission-mode <mode>");
    expect(helpOutput).toContain("--template <name>");
    expect(helpOutput).toMatch(
      /Permission mode: full, workspace-write, or\s+readonly/,
    );
    expect(helpOutput).toMatch(
      /remembered manager defaults or the server\s+manager policy/,
    );
  });

  it("bb manager hire reports invalid permission mode choices", async () => {
    await expect(
      runCommand(
        ["manager", "hire", "project-123", "--permission-mode", "unsafe"],
        (program) => registerManagerCommands(program, () => "http://server"),
      ),
    ).rejects.toThrow("process.exit:1");

    expect(console.error).toHaveBeenCalledWith(
      "Error: Invalid permission mode 'unsafe'. Expected full, workspace-write, or readonly.",
    );
  });

  it("bb manager list reports when no managers are hired", async () => {
    const list = vi.fn(async () => []);
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              $get: list,
            },
          },
        },
      }),
    );

    await runCommand(["manager", "list", "project-123"], (program) =>
      registerManagerCommands(program, () => "http://server"),
    );

    expect(list).toHaveBeenCalledWith({
      query: { projectId: "project-123", type: "manager" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "No managers hired",
    );
  });

  it("bb manager list renders the shared borderless table", async () => {
    const list = vi.fn(async () => [
      makeThread({
        id: "thread-manager-1",
        projectId: "project-123",
        providerId: "codex",
        title: "Manager",
        type: "manager",
        status: "active",
        createdAt: 1,
        updatedAt: 2,
      }),
    ]);
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              $get: list,
            },
          },
        },
      }),
    );

    await runCommand(["manager", "list", "project-123"], (program) =>
      registerManagerCommands(program, () => "http://server"),
    );

    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "",
      "ID                Status  Title  \n----------------  ------  -------\nthread-manager-1  active  Manager",
      "",
    ]);
  });

  it("bb manager status includes managed child threads", async () => {
    const managerThread: Thread = makeThread({
      id: "thread-manager-1",
      projectId: "project-123",
      providerId: "codex",
      title: "Manager",
      type: "manager",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });
    const managedThread: Thread = makeThread({
      id: "thread-worker-1",
      projectId: "project-123",
      providerId: "codex",
      title: "Worker",
      type: "standard",
      status: "active",
      parentThreadId: "thread-manager-1",
      createdAt: 3,
      updatedAt: 4,
    });
    const get = vi.fn(async ({ param }: { param: { id: string } }) => {
      expect(param.id).toBe("thread-manager-1");
      return managerThread;
    });
    const list = vi.fn(
      async ({ query }: { query: { parentThreadId?: string } }) => {
        expect(query.parentThreadId).toBe("thread-manager-1");
        return [managedThread];
      },
    );
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              $get: list,
              ":id": {
                $get: get,
              },
            },
          },
        },
      }),
    );

    await runCommand(["manager", "status", "thread-manager-1"], (program) =>
      registerManagerCommands(program, () => "http://server"),
    );

    const lines = collectLogLines(vi.mocked(console.log));
    expect(lines).toContain("Managed threads:");
    expect(lines.some((line) => line.includes("thread-worker-1"))).toBe(true);
  });

  it("bb manager delete deletes the manager thread", async () => {
    const managerThread: Thread = makeThread({
      id: "thread-manager-1",
      projectId: "project-123",
      providerId: "codex",
      title: "Manager",
      type: "manager",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });
    const get = vi.fn(async () => managerThread);
    const deleteFn = vi.fn(async () => ({ ok: true }));
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                $get: get,
                $delete: deleteFn,
              },
            },
          },
        },
      }),
    );

    await runCommand(
      ["manager", "delete", "thread-manager-1", "--yes"],
      (program) => registerManagerCommands(program, () => "http://server"),
    );

    expect(deleteFn).toHaveBeenCalledWith({
      param: { id: "thread-manager-1" },
      json: { managerChildThreadsConfirmed: false },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Manager thread-manager-1 deleted",
    );
  });

  it("bb manager delete forwards explicit assigned-child confirmation", async () => {
    const managerThread: Thread = makeThread({
      id: "thread-manager-children",
      projectId: "project-123",
      providerId: "codex",
      title: "Manager",
      type: "manager",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });
    const get = vi.fn(async () => managerThread);
    const deleteFn = vi.fn(async () => ({ ok: true }));
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                $get: get,
                $delete: deleteFn,
              },
            },
          },
        },
      }),
    );

    await runCommand(
      [
        "manager",
        "delete",
        "thread-manager-children",
        "--yes",
        "--confirm-assigned-child-threads",
      ],
      (program) => registerManagerCommands(program, () => "http://server"),
    );

    expect(deleteFn).toHaveBeenCalledWith({
      param: { id: "thread-manager-children" },
      json: { managerChildThreadsConfirmed: true },
    });
  });

  it("bb status prints project/thread context", async () => {
    vi.stubEnv("BB_PROJECT_ID", "proj-1");
    vi.stubEnv("BB_THREAD_ID", "thread-1");

    await runCommand(["status"], (program) =>
      registerStatusCommand(program, () => "http://server"),
    );

    const lines = collectLogLines(vi.mocked(console.log));
    expect(lines).toContain("Project: proj-1");
    expect(lines).toContain("Thread: thread-1");
  });

  it("bb status fetches the environment host by id", async () => {
    vi.stubEnv("BB_PROJECT_ID", "proj-1");
    vi.stubEnv("BB_THREAD_ID", "thread-1");

    const getProject = vi.fn(async () => ({
      id: "proj-1",
      name: "Alpha",
    }));
    const getThread = vi.fn(async () =>
      makeThread({
        id: "thread-1",
        projectId: "proj-1",
        providerId: "codex",
        environmentId: "env-1",
      }),
    );
    const getEnvironment = vi.fn(async () =>
      makeEnvironment({
        id: "env-1",
        projectId: "proj-1",
        hostId: "host-remote",
      }),
    );
    const getHost = vi.fn(async () => ({
      id: "host-remote",
      name: "Remote Host",
      type: "persistent",
      status: "connected",
      createdAt: 1,
      updatedAt: 2,
      lastSeenAt: 3,
    }));
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            projects: {
              ":id": {
                $get: getProject,
              },
            },
            threads: {
              ":id": {
                $get: getThread,
              },
            },
            environments: {
              ":id": {
                $get: getEnvironment,
              },
            },
            hosts: {
              ":id": {
                $get: getHost,
              },
            },
          },
        },
      }),
    );

    await runCommand(["status"], (program) =>
      registerStatusCommand(program, () => "http://server"),
    );

    expect(getHost).toHaveBeenCalledWith({
      param: { id: "host-remote" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "  Environment: Working remotely (env-1)",
    );
  });

  it("bb thread spawn omits provider and model when the user relies on project defaults", async () => {
    vi.stubEnv("BB_PROJECT_ID", "proj-1");
    const thread: Thread = makeThread({
      id: "thread-1",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "created",
      createdAt: 1,
      updatedAt: 1,
    });
    const post = vi.fn(async () => thread);
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              $post: post,
            },
          },
        },
      }),
    );

    await runCommand(["thread", "spawn", "--prompt", "hello"], (program) =>
      registerThreadCommands(program, () => "http://server"),
    );

    expect(post).toHaveBeenCalledWith({
      json: {
        origin: "cli",
        projectId: "proj-1",
        input: [{ type: "text", text: "hello" }],
        environment: {
          type: "host",
          hostId: "host-test-001",
          workspace: { type: "unmanaged", path: null },
        },
      },
    });
  });

  it("bb thread spawn forwards explicit execution overrides", async () => {
    vi.stubEnv("BB_PROJECT_ID", "proj-1");
    const thread: Thread = makeThread({
      id: "thread-overrides",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "created",
      createdAt: 1,
      updatedAt: 1,
    });
    const post = vi.fn(async () => thread);
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              $post: post,
            },
          },
        },
      }),
    );

    await runCommand(
      [
        "thread",
        "spawn",
        "--prompt",
        "hello",
        "--provider",
        "codex",
        "--model",
        "gpt-5",
        "--reasoning-level",
        "high",
        "--service-tier",
        "fast",
        "--permission-mode",
        "workspace-write",
      ],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(post).toHaveBeenCalledWith({
      json: {
        origin: "cli",
        projectId: "proj-1",
        providerId: "codex",
        model: "gpt-5",
        reasoningLevel: "high",
        permissionMode: "workspace-write",
        serviceTier: "fast",
        input: [{ type: "text", text: "hello" }],
        environment: {
          type: "host",
          hostId: "host-test-001",
          workspace: { type: "unmanaged", path: null },
        },
      },
    });
  });

  it("bb thread spawn help lists product permission modes", async () => {
    const helpOutput = await getHelpOutput(["thread", "spawn"], (program) =>
      registerThreadCommands(program, () => "http://server"),
    );
    expect(helpOutput).toContain("--permission-mode <mode>");
    expect(helpOutput).toMatch(
      /Permission mode: full, workspace-write, or\s+readonly/,
    );
  });

  it("bb thread spawn reports invalid permission mode choices", async () => {
    vi.stubEnv("BB_PROJECT_ID", "proj-1");

    await expect(
      runCommand(
        ["thread", "spawn", "--prompt", "hello", "--permission-mode", "unsafe"],
        (program) => registerThreadCommands(program, () => "http://server"),
      ),
    ).rejects.toThrow("process.exit:1");

    expect(console.error).toHaveBeenCalledWith(
      "Error: Invalid permission mode 'unsafe'. Expected full, workspace-write, or readonly.",
    );
  });

  it("bb thread log help describes verbose as expanded timeline output", async () => {
    const helpOutput = await getHelpOutput(["thread", "log"], (program) =>
      registerThreadCommands(program, () => "http://server"),
    );

    expect(helpOutput).toContain("verbose (expanded timeline)");
    expect(helpOutput).not.toContain("verbose (full timeline)");
  });

  it("bb thread list supports parent-thread filtering", async () => {
    const list = vi.fn(async () => []);
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              $get: list,
            },
          },
        },
      }),
    );

    await runCommand(
      [
        "thread",
        "list",
        "--project",
        "proj-1",
        "--parent-thread",
        "thread-manager-1",
      ],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(list).toHaveBeenCalledWith({
      query: {
        projectId: "proj-1",
        parentThreadId: "thread-manager-1",
      },
    });
  });

  it("bb thread list renders archived status in the shared borderless table", async () => {
    const list = vi.fn(async () => [
      makeThread({
        id: "thread-archived-1",
        projectId: "proj-1",
        providerId: "codex",
        type: "standard",
        status: "idle",
        archivedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      }),
    ]);
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              $get: list,
            },
          },
        },
      }),
    );

    vi.stubEnv("BB_PROJECT_ID", "proj-1");
    await runCommand(["thread", "list"], (program) =>
      registerThreadCommands(program, () => "http://server"),
    );

    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "",
      "ID                 Project  Status         \n-----------------  -------  ---------------\nthread-archived-1  proj-1   idle (archived)",
      "",
    ]);
  });

  it("bb provider list renders the shared borderless table", async () => {
    const get = vi.fn(async () => [{ id: "openai", displayName: "OpenAI" }]);
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            system: {
              providers: {
                $get: get,
              },
            },
          },
        },
      }),
    );

    await runCommand(["provider", "list"], (program) =>
      registerProviderCommands(program, () => "http://server"),
    );

    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "",
      "ID      Name  \n------  ------\nopenai  OpenAI",
      "",
    ]);
  });

  it("bb host list --json prints raw hosts", async () => {
    const hosts = [
      {
        id: "host-1",
        name: "Workstation",
        type: "persistent",
        status: "connected",
        createdAt: 1,
        updatedAt: 2,
        lastSeenAt: 3,
      },
    ];
    const get = vi.fn(async () => hosts);
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            hosts: {
              $get: get,
            },
          },
        },
      }),
    );

    await runCommand(["host", "list", "--json"], (program) =>
      registerHostCommands(program, () => "http://server"),
    );

    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual(hosts);
  });

  it("bb host list renders the shared borderless table", async () => {
    const get = vi.fn(async () => [
      {
        id: "host-1",
        name: "Workstation",
        type: "persistent",
        status: "connected",
        createdAt: 1,
        updatedAt: 2,
        lastSeenAt: 3,
      },
    ]);
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            hosts: {
              $get: get,
            },
          },
        },
      }),
    );

    await runCommand(["host", "list"], (program) =>
      registerHostCommands(program, () => "http://server"),
    );

    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "",
      "ID      Name         Status\n------  -----------  ---------\nhost-1  Workstation  connected",
      "",
    ]);
  });

  it("bb provider models renders the shared borderless table", async () => {
    const get = vi.fn(async () => [
      { model: "gpt-5", displayName: "GPT-5", isDefault: true },
    ]);
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            system: {
              "execution-options": {
                $get: vi.fn(async () => ({
                  providers: [],
                  models: await get(),
                  selectedOnlyModels: [],
                })),
              },
            },
          },
        },
      }),
    );

    await runCommand(["provider", "models", "openai"], (program) =>
      registerProviderCommands(program, () => "http://server"),
    );

    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "Models for openai:",
      "",
      "Model  Name   Default\n-----  -----  -------\ngpt-5  GPT-5  *",
      "",
    ]);
  });

  it("bb provider models includes a matching selected-only model", async () => {
    const get = vi.fn(async () => ({
      providers: [],
      models: [
        {
          model: "claude-haiku-4-5",
          displayName: "Claude Haiku 4.5",
          isDefault: true,
        },
      ],
      selectedOnlyModels: [
        {
          model: "claude-opus-4-6",
          displayName: "Claude Opus 4.6",
          isDefault: false,
        },
      ],
    }));
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            system: {
              "execution-options": {
                $get: get,
              },
            },
          },
        },
      }),
    );

    await runCommand(
      [
        "provider",
        "models",
        "claude-code",
        "--selected-model",
        "claude-opus-4-6",
      ],
      (program) => registerProviderCommands(program, () => "http://server"),
    );

    expect(get).toHaveBeenCalledWith({
      query: {
        providerId: "claude-code",
      },
    });
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "Models for claude-code:",
      "",
      "Model             Name              Default\n----------------  ----------------  -------\nclaude-opus-4-6   Claude Opus 4.6\n----------------  ----------------  -------\nclaude-haiku-4-5  Claude Haiku 4.5  *",
      "",
    ]);
  });

  it("bb thread spawn --json prints the raw thread", async () => {
    vi.stubEnv("BB_PROJECT_ID", "proj-1");
    const thread: Thread = makeThread({
      id: "thread-json-spawn",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "created",
      createdAt: 1,
      updatedAt: 1,
    });
    const post = vi.fn(async () => thread);
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              $post: post,
            },
          },
        },
      }),
    );

    await runCommand(
      [
        "thread",
        "spawn",
        "--json",
        "--prompt",
        "hello",
        "--provider",
        "codex",
        "--model",
        "gpt-5",
      ],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual(thread);
  });

  it("bb thread spawn prefixes missing-project-default failures with context", async () => {
    vi.stubEnv("BB_PROJECT_ID", "proj-1");
    const post = vi.fn(async () => {
      throw new Error(
        "HTTP 400: Provider is required when project proj-1 has no stored execution defaults for thread type standard",
      );
    });
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              $post: post,
            },
          },
        },
      }),
    );

    await expect(
      runCommand(["thread", "spawn", "--prompt", "hello"], (program) =>
        registerThreadCommands(program, () => "http://server"),
      ),
    ).rejects.toThrow("process.exit:1");

    expect(collectLogLines(vi.mocked(console.error))).toContain(
      "Error: Failed to create thread: HTTP 400: Provider is required when project proj-1 has no stored execution defaults for thread type standard",
    );
  });

  it("bb thread spawn with --parent-thread forwards parent thread id", async () => {
    vi.stubEnv("BB_PROJECT_ID", "proj-1");
    const thread: Thread = makeThread({
      id: "thread-2",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "created",
      parentThreadId: "thread-parent",
      createdAt: 1,
      updatedAt: 1,
    });
    const post = vi.fn(async () => thread);
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              $post: post,
            },
          },
        },
      }),
    );

    await runCommand(
      [
        "thread",
        "spawn",
        "--parent-thread",
        "thread-parent",
        "--prompt",
        "hello",
        "--provider",
        "codex",
        "--model",
        "gpt-5",
      ],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(post).toHaveBeenCalledWith({
      json: {
        origin: "cli",
        projectId: "proj-1",
        providerId: "codex",
        model: "gpt-5",
        input: [{ type: "text", text: "hello" }],
        parentThreadId: "thread-parent",
        environment: {
          type: "host",
          hostId: "host-test-001",
          workspace: { type: "unmanaged", path: null },
        },
      },
    });
  });

  it("bb thread spawn forwards --environment", async () => {
    vi.stubEnv("BB_PROJECT_ID", "proj-1");
    const thread: Thread = makeThread({
      id: "thread-env-1",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "created",
      environmentId: "env-worktree-001",
      createdAt: 1,
      updatedAt: 1,
    });
    const post = vi.fn(async () => thread);
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              $post: post,
            },
          },
        },
      }),
    );

    await runCommand(
      [
        "thread",
        "spawn",
        "--environment",
        "env-worktree-001",
        "--prompt",
        "hello",
        "--provider",
        "codex",
        "--model",
        "gpt-5",
      ],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(post).toHaveBeenCalledWith({
      json: {
        origin: "cli",
        projectId: "proj-1",
        providerId: "codex",
        model: "gpt-5",
        input: [{ type: "text", text: "hello" }],
        environment: { type: "reuse", environmentId: "env-worktree-001" },
      },
    });
  });

  it("bb thread spawn forwards --new-environment", async () => {
    vi.stubEnv("BB_PROJECT_ID", "proj-1");
    const thread: Thread = makeThread({
      id: "thread-env-1",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "created",
      environmentId: "env-worktree-001",
      createdAt: 1,
      updatedAt: 1,
    });
    const post = vi.fn(async () => thread);
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              $post: post,
            },
          },
        },
      }),
    );

    await runCommand(
      [
        "thread",
        "spawn",
        "--new-environment",
        "worktree",
        "--prompt",
        "hello",
        "--provider",
        "codex",
        "--model",
        "gpt-5",
      ],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(post).toHaveBeenCalledWith({
      json: {
        origin: "cli",
        projectId: "proj-1",
        providerId: "codex",
        model: "gpt-5",
        input: [{ type: "text", text: "hello" }],
        environment: {
          type: "host",
          hostId: "host-test-001",
          workspace: {
            type: "managed-worktree",
            baseBranch: { kind: "default" },
          },
        },
      },
    });
  });

  it("bb thread archive sends the thread id from args", async () => {
    const archivePost = vi.fn(async () => ({ ok: true }));
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                archive: {
                  $post: archivePost,
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(["thread", "archive", "thread-archive-1"], (program) =>
      registerThreadCommands(program, () => "http://server"),
    );

    expect(archivePost).toHaveBeenCalledWith({
      param: { id: "thread-archive-1" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-archive-1 archived",
    );
  });

  it("bb thread archive --self resolves from BB_THREAD_ID", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-archive-2");
    const archivePost = vi.fn(async () => ({ ok: true }));
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                archive: {
                  $post: archivePost,
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(["thread", "archive", "--self"], (program) =>
      registerThreadCommands(program, () => "http://server"),
    );

    expect(archivePost).toHaveBeenCalledWith({
      param: { id: "thread-archive-2" },
    });
  });

  it("bb thread archive prefixes failures with thread context", async () => {
    const archivePost = vi.fn(async () => {
      throw new Error("HTTP 404: missing");
    });
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                archive: {
                  $post: archivePost,
                },
              },
            },
          },
        },
      }),
    );

    await expect(
      runCommand(["thread", "archive", "thread-archive-1"], (program) =>
        registerThreadCommands(program, () => "http://server"),
      ),
    ).rejects.toThrow("process.exit:1");

    expect(collectLogLines(vi.mocked(console.error))).toContain(
      "Error: Failed to archive thread thread-archive-1: HTTP 404: missing",
    );
    expect(archivePost).toHaveBeenCalledWith({
      param: { id: "thread-archive-1" },
    });
  });

  it("bb thread unarchive --self resolves from BB_THREAD_ID", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-unarchive-1");
    const unarchivePost = vi.fn(async () => ({ ok: true }));
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                unarchive: {
                  $post: unarchivePost,
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(["thread", "unarchive", "--self"], (program) =>
      registerThreadCommands(program, () => "http://server"),
    );

    expect(unarchivePost).toHaveBeenCalledWith({
      param: { id: "thread-unarchive-1" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-unarchive-1 unarchived",
    );
  });

  it("bb thread delete prompts before deleting", async () => {
    const thread: Thread = makeThread({
      id: "thread-delete-1",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "idle",
      title: "Delete me",
      createdAt: 1,
      updatedAt: 1,
    });
    const get = vi.fn(async () => thread);
    const deleteFn = vi.fn(async () => ({ ok: true }));
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                $get: get,
                $delete: deleteFn,
              },
            },
          },
        },
      }),
    );
    readlineState.question.mockResolvedValue("yes");

    await runCommand(["thread", "delete", "thread-delete-1"], (program) =>
      registerThreadCommands(program, () => "http://server"),
    );

    expect(get).toHaveBeenCalledWith({
      param: { id: "thread-delete-1" },
    });
    expect(deleteFn).toHaveBeenCalledWith({
      param: { id: "thread-delete-1" },
      json: { managerChildThreadsConfirmed: false },
    });
    expect(readlineState.question).toHaveBeenCalled();
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-delete-1 deleted",
    );
  });

  it("bb thread delete cancels when confirmation is declined", async () => {
    const thread: Thread = makeThread({
      id: "thread-delete-2",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    });
    const get = vi.fn(async () => thread);
    const deleteFn = vi.fn(async () => ({ ok: true }));
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                $get: get,
                $delete: deleteFn,
              },
            },
          },
        },
      }),
    );
    readlineState.question.mockResolvedValue("no");

    await runCommand(["thread", "delete", "thread-delete-2"], (program) =>
      registerThreadCommands(program, () => "http://server"),
    );

    expect(deleteFn).not.toHaveBeenCalled();
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-delete-2 deletion cancelled",
    );
  });

  it("bb thread delete --yes skips confirmation (requires explicit id)", async () => {
    const thread: Thread = makeThread({
      id: "thread-delete-3",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    });
    const get = vi.fn(async () => thread);
    const deleteFn = vi.fn(async () => ({ ok: true }));
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                $get: get,
                $delete: deleteFn,
              },
            },
          },
        },
      }),
    );

    await runCommand(
      ["thread", "delete", "thread-delete-3", "--yes"],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(readlineState.question).not.toHaveBeenCalled();
    expect(deleteFn).toHaveBeenCalledWith({
      param: { id: "thread-delete-3" },
      json: { managerChildThreadsConfirmed: false },
    });
  });

  it("bb thread delete forwards explicit assigned-child confirmation", async () => {
    const thread: Thread = makeThread({
      id: "thread-delete-children",
      projectId: "proj-1",
      providerId: "codex",
      type: "manager",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    });
    const get = vi.fn(async () => thread);
    const deleteFn = vi.fn(async () => ({ ok: true }));
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                $get: get,
                $delete: deleteFn,
              },
            },
          },
        },
      }),
    );

    await runCommand(
      [
        "thread",
        "delete",
        "thread-delete-children",
        "--yes",
        "--confirm-assigned-child-threads",
      ],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(deleteFn).toHaveBeenCalledWith({
      param: { id: "thread-delete-children" },
      json: { managerChildThreadsConfirmed: true },
    });
  });

  it("bb environment commit prefixes failures with environment context", async () => {
    const post = vi.fn(async () => {
      throw new Error("HTTP 500: boom");
    });
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            environments: {
              ":id": {
                actions: {
                  $post: post,
                },
              },
            },
          },
        },
      }),
    );

    await expect(
      runCommand(["environment", "commit", "env-1"], (program) =>
        registerEnvironmentCommands(program, () => "http://server"),
      ),
    ).rejects.toThrow("process.exit:1");

    expect(collectLogLines(vi.mocked(console.error))).toContain(
      "Error: Failed to commit in environment env-1: HTTP 500: boom",
    );
  });

  it("bb environment commit posts the action without a thread id", async () => {
    const post = vi.fn(async () => ({
      ok: true as const,
      action: "commit" as const,
      message: "Created commit abc123",
      commitSha: "abc123",
      commitSubject: "bb: automated commit",
    }));
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            environments: {
              ":id": {
                actions: {
                  $post: post,
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(["environment", "commit", "env-commit-1"], (program) =>
      registerEnvironmentCommands(program, () => "http://server"),
    );

    expect(post).toHaveBeenCalledWith({
      param: { id: "env-commit-1" },
      json: { action: "commit" },
    });
  });

  it("bb environment update sets the merge base branch", async () => {
    const environment = makeEnvironment({
      id: "env-update-1",
      projectId: "proj-1",
      hostId: "host-1",
      mergeBaseBranch: "release",
      createdAt: 1,
      updatedAt: 2,
    });
    const patch = vi.fn(async () => environment);
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            environments: {
              ":id": {
                $patch: patch,
              },
            },
          },
        },
      }),
    );

    await runCommand(
      [
        "environment",
        "update",
        "env-update-1",
        "--merge-base-branch",
        "release",
      ],
      (program) => registerEnvironmentCommands(program, () => "http://server"),
    );

    expect(patch).toHaveBeenCalledWith({
      param: { id: "env-update-1" },
      json: { mergeBaseBranch: "release" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Environment env-update-1 updated",
    );
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Merge base branch: release",
    );
  });

  it("bb environment update clears the merge base branch", async () => {
    const environment = makeEnvironment({
      id: "env-update-2",
      projectId: "proj-1",
      hostId: "host-1",
      mergeBaseBranch: null,
      createdAt: 1,
      updatedAt: 2,
    });
    const patch = vi.fn(async () => environment);
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            environments: {
              ":id": {
                $patch: patch,
              },
            },
          },
        },
      }),
    );

    await runCommand(
      ["environment", "update", "env-update-2", "--clear-merge-base-branch"],
      (program) => registerEnvironmentCommands(program, () => "http://server"),
    );

    expect(patch).toHaveBeenCalledWith({
      param: { id: "env-update-2" },
      json: { mergeBaseBranch: null },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Merge base branch cleared",
    );
  });

  it("bb thread show prints archived timestamp for archived threads", async () => {
    const thread: Thread = makeThread({
      id: "thread-archived-1",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "idle",
      archivedAt: 1_700_000_000_000,
      createdAt: 1,
      updatedAt: 2,
    });
    const get = vi.fn(async () => thread);
    const timelineGet = makeEmptyTimelineGetMock();
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                $get: get,
                timeline: { $get: timelineGet },
              },
            },
          },
        },
      }),
    );

    await runCommand(["thread", "show", "thread-archived-1"], (program) =>
      registerThreadCommands(program, () => "http://server"),
    );

    expect(get).toHaveBeenCalledWith({
      param: { id: "thread-archived-1" },
    });
    expect(timelineGet).toHaveBeenCalledWith({
      param: { id: "thread-archived-1" },
      query: { summaryOnly: "true" },
    });
    const lines = collectLogLines(vi.mocked(console.log));
    expect(lines.some((line) => line.includes("Archived:"))).toBe(true);
  });

  it("bb thread show --self resolves from BB_THREAD_ID", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-show-self");
    const thread: Thread = makeThread({
      id: "thread-show-self",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });
    const get = vi.fn(async () => thread);
    const timelineGet = makeEmptyTimelineGetMock();
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                $get: get,
                timeline: { $get: timelineGet },
              },
            },
          },
        },
      }),
    );

    await runCommand(["thread", "show", "--self"], (program) =>
      registerThreadCommands(program, () => "http://server"),
    );

    expect(get).toHaveBeenCalledWith({
      param: { id: "thread-show-self" },
    });
    expect(collectLogLines(vi.mocked(console.error))).toEqual([]);
  });

  it("bb thread show rejects combining a thread id with --self", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-show-self");

    await expect(
      runCommand(["thread", "show", "thread-explicit", "--self"], (program) =>
        registerThreadCommands(program, () => "http://server"),
      ),
    ).rejects.toThrow("process.exit:1");

    expect(collectLogLines(vi.mocked(console.error))).toContain(
      "Error: Cannot combine a thread ID argument with --self.",
    );
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("bb thread show --git-diff uses the environment base branch before the repository default", async () => {
    const thread: Thread = makeThread({
      id: "thread-show-diff-base",
      projectId: "proj-1",
      providerId: "codex",
      environmentId: "env-diff-base",
      type: "standard",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });
    const environment = makeEnvironment({
      id: "env-diff-base",
      projectId: "proj-1",
      hostId: "host-1",
      baseBranch: "release",
      defaultBranch: "main",
      mergeBaseBranch: null,
      createdAt: 1,
      updatedAt: 2,
    });
    const gitDiff: ThreadGitDiffResponse = {
      diff: "",
      files: "M\tsrc/file.ts\n",
      mergeBaseRef: "abc1234",
      shortstat: " 1 file changed, 1 insertion(+)",
      truncated: false,
    };
    const get = vi.fn(async () => thread);
    const environmentGet = vi.fn(async () => environment);
    const diffGet = vi.fn(async () => gitDiff);
    const timelineGet = makeEmptyTimelineGetMock();
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            environments: {
              ":id": {
                $get: environmentGet,
                diff: { $get: diffGet },
              },
            },
            threads: {
              ":id": {
                $get: get,
                timeline: { $get: timelineGet },
              },
            },
          },
        },
      }),
    );

    await runCommand(
      ["thread", "show", "thread-show-diff-base", "--git-diff"],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(diffGet).toHaveBeenCalledWith({
      param: { id: "env-diff-base" },
      query: {
        mergeBaseBranch: "release",
        target: "all",
      },
    });
  });
});

describe("CLI JSON output contracts", () => {
  const createClientMock = vi.mocked(createClient);
  const unwrapMock = vi.mocked(unwrap);

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(
      (code?: string | number | null) => {
        throw new Error(`process.exit:${code ?? 0}`);
      },
    );

    createClientMock.mockReset();
    unwrapMock.mockReset();
    unwrapMock.mockImplementation(async (responsePromise: Promise<unknown>) => {
      return responsePromise;
    });

    vi.stubEnv("BB_PROJECT_ID", undefined);
    vi.stubEnv("BB_THREAD_ID", undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("bb thread show --json prints the thread in status payload format", async () => {
    const thread: Thread = makeThread({
      id: "thread-json-show",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    });
    const get = vi.fn(async () => thread);
    const timelineGet = makeEmptyTimelineGetMock();
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                $get: get,
                timeline: { $get: timelineGet },
              },
            },
          },
        },
      }),
    );

    await runCommand(
      ["thread", "show", "thread-json-show", "--json"],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual({ thread, environment: null, pendingTodos: null });
  });

  it("bb thread update sets the parent thread id", async () => {
    const thread: Thread = makeThread({
      id: "thread-update-1",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "idle",
      parentThreadId: "thread-manager-1",
      createdAt: 1,
      updatedAt: 1,
    });
    const get = vi.fn(async () => thread);
    const patch = vi.fn(async () => thread);
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                $get: get,
                $patch: patch,
              },
            },
          },
        },
      }),
    );

    await runCommand(
      [
        "thread",
        "update",
        "thread-update-1",
        "--parent-thread",
        "thread-manager-1",
      ],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(patch).toHaveBeenCalledWith({
      param: { id: "thread-update-1" },
      json: { parentThreadId: "thread-manager-1" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Managed by thread-manager-1",
    );
  });

  it("bb thread update clears the parent thread id", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-update-2");
    const thread: Thread = makeThread({
      id: "thread-update-2",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    });
    const get = vi.fn(async () => thread);
    const patch = vi.fn(async () => thread);
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                $get: get,
                $patch: patch,
              },
            },
          },
        },
      }),
    );

    await runCommand(
      ["thread", "update", "--self", "--clear-parent-thread"],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(patch).toHaveBeenCalledWith({
      param: { id: "thread-update-2" },
      json: { parentThreadId: null },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "No managing parent thread",
    );
  });

  it("bb environment update --json prints the updated environment", async () => {
    const environment = makeEnvironment({
      id: "env-json-update",
      projectId: "proj-1",
      hostId: "host-1",
      mergeBaseBranch: "release",
      createdAt: 1,
      updatedAt: 2,
    });
    const patch = vi.fn(async () => environment);
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            environments: {
              ":id": {
                $patch: patch,
              },
            },
          },
        },
      }),
    );

    await runCommand(
      [
        "environment",
        "update",
        "env-json-update",
        "--merge-base-branch",
        "release",
        "--json",
      ],
      (program) => registerEnvironmentCommands(program, () => "http://server"),
    );

    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual(environment);
  });

  it("bb thread tell --json prints the raw response plus thread id", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                send: {
                  $post: post,
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(
      ["thread", "tell", "thread-json-tell", "hello", "--json"],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual({
      threadId: "thread-json-tell",
      ok: true,
    });
  });

  it("bb thread tell includes sender thread metadata when run inside another thread", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-sender");
    const post = vi.fn(async () => ({ ok: true }));
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                send: {
                  $post: post,
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(
      ["thread", "tell", "thread-receiver", "hello from sender"],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(post).toHaveBeenCalledWith({
      param: { id: "thread-receiver" },
      json: {
        input: [{ type: "text", text: "hello from sender" }],
        mode: "auto",
        senderThreadId: "thread-sender",
      },
    });
  });

  it("bb thread tell omits sender metadata when targeting the current thread", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-self");
    const post = vi.fn(async () => ({ ok: true }));
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                send: {
                  $post: post,
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(
      ["thread", "tell", "thread-self", "self note"],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(post).toHaveBeenCalledWith({
      param: { id: "thread-self" },
      json: {
        input: [{ type: "text", text: "self note" }],
        mode: "auto",
      },
    });
  });

  it("bb thread wait --status succeeds when the thread is already at the requested status", async () => {
    const get = vi.fn(async () =>
      makeThread({
        id: "thread-wait",
        projectId: "proj-1",
        providerId: "codex",
        type: "standard",
        status: "idle",
        createdAt: 1,
        updatedAt: 2,
      }),
    );
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                $get: get,
              },
            },
          },
        },
      }),
    );

    await runCommand(
      ["thread", "wait", "thread-wait", "--status", "idle"],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-wait reached status idle.",
    );
  });

  it("bb thread wait --status exits with timeout code when the status is not reached", async () => {
    const get = vi.fn(async () =>
      makeThread({
        id: "thread-wait-timeout",
        projectId: "proj-1",
        providerId: "codex",
        type: "standard",
        status: "active",
        createdAt: 1,
        updatedAt: 2,
      }),
    );
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                $get: get,
              },
            },
          },
        },
      }),
    );

    await expect(
      runCommand(
        [
          "thread",
          "wait",
          "thread-wait-timeout",
          "--status",
          "idle",
          "--timeout",
          "0",
        ],
        (program) => registerThreadCommands(program, () => "http://server"),
      ),
    ).rejects.toThrow("process.exit:2");
  });

  it("bb thread wait --status idle fails fast when the thread is stuck in error", async () => {
    const get = vi.fn(async () =>
      makeThread({
        id: "thread-wait-error",
        projectId: "proj-1",
        providerId: "codex",
        type: "standard",
        status: "error",
        createdAt: 1,
        updatedAt: 2,
      }),
    );
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                $get: get,
              },
            },
          },
        },
      }),
    );

    await expect(
      runCommand(
        ["thread", "wait", "thread-wait-error", "--status", "idle"],
        (program) => registerThreadCommands(program, () => "http://server"),
      ),
    ).rejects.toThrow("process.exit:4");

    expect(collectLogLines(vi.mocked(console.error))).toContain(
      "Error: Thread thread-wait-error is in status error and will not reach idle by waiting alone. Inspect it with 'bb thread show thread-wait-error' and recover by sending a follow-up.",
    );
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("bb thread wait --event reports server errors instead of schema errors", async () => {
    const waitGet = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ code: "not_found", message: "Thread not found" }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                events: {
                  wait: {
                    $get: waitGet,
                  },
                },
              },
            },
          },
        },
      }),
    );

    await expect(
      runCommand(
        [
          "thread",
          "wait",
          "thread-404",
          "--event",
          "turn/completed",
          "--timeout",
          "5",
        ],
        (program) => registerThreadCommands(program, () => "http://server"),
      ),
    ).rejects.toThrow("process.exit:1");

    const errorLines = collectLogLines(vi.mocked(console.error));
    const hasServerError = errorLines.some(
      (line) => line.includes("404") && !line.includes("ZodError"),
    );
    expect(hasServerError).toBe(true);
  });

  it("bb thread wait --event --timeout 0 returns immediately when event exists", async () => {
    const waitGet = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ...buildThreadEventRow({
              id: "evt-1",
              scope: turnScope("turn-1"),
              threadId: "thread-t0",
              seq: 3,
              createdAt: Date.now(),
              event: {
                type: "turn/completed",
                threadId: "thread-t0",
                providerThreadId: "provider-thread-t0",
                turnId: "turn-1",
                scope: turnScope("turn-1"),
                status: "completed",
              },
            }),
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                events: {
                  wait: {
                    $get: waitGet,
                  },
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(
      [
        "thread",
        "wait",
        "thread-t0",
        "--event",
        "turn/completed",
        "--timeout",
        "0",
      ],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-t0 observed event turn/completed at seq 3.",
    );
  });

  it("bb thread stop exits early when the thread is already idle", async () => {
    const get = vi.fn(async () =>
      makeThread({
        id: "thread-stop-idle",
        projectId: "proj-1",
        providerId: "codex",
        type: "standard",
        status: "idle",
        createdAt: 1,
        updatedAt: 2,
      }),
    );
    const stopPost = vi.fn();
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                $get: get,
                stop: {
                  $post: stopPost,
                },
              },
            },
          },
        },
      }),
    );

    await expect(
      runCommand(["thread", "stop", "thread-stop-idle"], (program) =>
        registerThreadCommands(program, () => "http://server"),
      ),
    ).rejects.toThrow("process.exit:1");

    expect(collectLogLines(vi.mocked(console.error))).toContain(
      "Error: Thread thread-stop-idle is already idle.",
    );
    expect(stopPost).not.toHaveBeenCalled();
  });

  it("bb thread stop refuses to clear error into idle", async () => {
    const get = vi.fn(async () =>
      makeThread({
        id: "thread-stop-error",
        projectId: "proj-1",
        providerId: "codex",
        type: "standard",
        status: "error",
        createdAt: 1,
        updatedAt: 2,
      }),
    );
    const stopPost = vi.fn();
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                $get: get,
                stop: {
                  $post: stopPost,
                },
              },
            },
          },
        },
      }),
    );

    await expect(
      runCommand(["thread", "stop", "thread-stop-error"], (program) =>
        registerThreadCommands(program, () => "http://server"),
      ),
    ).rejects.toThrow("process.exit:1");

    expect(collectLogLines(vi.mocked(console.error))).toContain(
      "Error: Thread thread-stop-error is in status error. Do not stop it to force idle; inspect it with 'bb thread show thread-stop-error' and recover by sending a follow-up.",
    );
    expect(stopPost).not.toHaveBeenCalled();
  });

  it("bb thread stop still stops active threads", async () => {
    const get = vi.fn(async () =>
      makeThread({
        id: "thread-stop-active",
        projectId: "proj-1",
        providerId: "codex",
        type: "standard",
        status: "active",
        createdAt: 1,
        updatedAt: 2,
      }),
    );
    const stopPost = vi.fn(async () => ({ ok: true }));
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                $get: get,
                stop: {
                  $post: stopPost,
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(["thread", "stop", "thread-stop-active"], (program) =>
      registerThreadCommands(program, () => "http://server"),
    );

    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-stop-active stopped",
    );
    expect(stopPost).toHaveBeenCalledTimes(1);
  });

  it("bb thread log --json prints raw events", async () => {
    const thread = {
      id: "thread-json-log",
      projectId: "proj-1",
      providerId: "provider-1",
      type: "task",
      status: "idle",
      createdAt: 10,
      updatedAt: 20,
    };
    const events = [
      {
        id: "evt-1",
        threadId: "thread-json-log",
        type: "system/error",
        data: { code: "provider_unavailable" },
        createdAt: 20,
        sequence: 2,
      },
    ];
    const getThread = vi.fn(async () => thread);
    const getEvents = vi.fn(async () => events);
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                $get: getThread,
                events: {
                  $get: getEvents,
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(
      ["thread", "log", "thread-json-log", "--json"],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual(events);
  });

  it("bb thread log renders merged timeline rows for human output", async () => {
    const getEvents = vi.fn(async () => []);
    const getTimeline = vi.fn(async () =>
      makeTimelineResponse([
        {
          ...makeTimelineBase({
            id: "user-1",
            sourceSeqStart: 1,
          }),
          kind: "conversation",
          role: "user",
          text: "Say hello",
          attachments: null,
          initiator: "user",
          senderThreadId: null,
          turnRequest: { kind: "message", status: "accepted" },
        },
        {
          ...makeTimelineBase({
            id: "op-1",
            sourceSeqStart: 2,
            sourceSeqEnd: 8,
            startedAt: 2,
            createdAt: 8,
          }),
          kind: "system",
          systemKind: "operation",
          operationKind: "thread-provisioning",
          title: "Provisioned thread",
          detail: null,
          status: "completed",
          completedAt: 8,
        },
        {
          ...makeTimelineBase({
            id: "assistant-1",
            sourceSeqStart: 9,
          }),
          kind: "conversation",
          role: "assistant",
          text: "Hello!",
          attachments: null,
          turnRequest: null,
        },
      ]),
    );
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                events: {
                  $get: getEvents,
                },
                timeline: {
                  $get: getTimeline,
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(
      ["thread", "log", "thread-log", "--format", "verbose"],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    const output = String(vi.mocked(console.log).mock.calls[0]?.[0]);
    expect(output).toContain("Provisioned thread");
    expect(output).not.toContain("Provisioning interrupted");
    expect(getEvents).not.toHaveBeenCalled();
  });

  it("bb thread log renders pending steers for human output", async () => {
    const getEvents = vi.fn(async () => []);
    const getTimeline = vi.fn(async () =>
      makeTimelineResponse([makePendingSteerTimelineRow()]),
    );
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                events: {
                  $get: getEvents,
                },
                timeline: {
                  $get: getTimeline,
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(
      ["thread", "log", "thread-log", "--format", "verbose"],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    const output = String(vi.mocked(console.log).mock.calls[0]?.[0]);
    expect(output).toContain("Please switch to the safer plan");
    expect(output).toContain("steer pending");
    expect(getTimeline).toHaveBeenCalledWith({
      param: { id: "thread-log" },
      query: { includeNestedRows: "true" },
    });
    expect(getEvents).not.toHaveBeenCalled();
  });

  it("bb thread log renders pending steers with default formatting", async () => {
    const getEvents = vi.fn(async () => []);
    const getTimeline = vi.fn(async () =>
      makeTimelineResponse([makePendingSteerTimelineRow()]),
    );
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                events: {
                  $get: getEvents,
                },
                timeline: {
                  $get: getTimeline,
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(["thread", "log", "thread-log"], (program) =>
      registerThreadCommands(program, () => "http://server"),
    );

    const output = String(vi.mocked(console.log).mock.calls[0]?.[0]);
    expect(output).toContain("Please switch to the safer plan");
    expect(output).toContain("steer pending");
    expect(getTimeline).toHaveBeenCalledWith({
      param: { id: "thread-log" },
      query: {},
    });
    expect(getEvents).not.toHaveBeenCalled();
  });

  it("bb thread log renders approval state on command and file-change rows", async () => {
    const getEvents = vi.fn(async () => []);
    const getTimeline = vi.fn(async () =>
      makeTimelineResponse([
        {
          ...makeTimelineBase({
            id: "command-approval",
            sourceSeqStart: 1,
          }),
          kind: "work",
          workKind: "command",
          status: "pending",
          callId: "cmd-1",
          command: "git push",
          cwd: null,
          source: null,
          output: "",
          exitCode: null,
          completedAt: null,
          approvalStatus: "waiting_for_approval",
          activityIntents: [],
        },
        {
          ...makeTimelineBase({
            id: "file-approval",
            sourceSeqStart: 2,
          }),
          kind: "work",
          workKind: "file-change",
          status: "interrupted",
          callId: "file-1",
          change: {
            path: "src/example.ts",
            kind: null,
            movePath: null,
            diff: null,
            diffStats: { added: 0, removed: 0 },
          },
          stdout: null,
          stderr: null,
          approvalStatus: "denied",
        },
      ]),
    );
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                events: {
                  $get: getEvents,
                },
                timeline: {
                  $get: getTimeline,
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(
      ["thread", "log", "thread-log", "--format", "verbose"],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    const output = String(vi.mocked(console.log).mock.calls[0]?.[0]);
    expect(output).toContain("Waiting for approval to run git push");
    expect(output).toContain("git push");
    expect(output).toContain("denied");
    expect(output).toContain("example.ts");
    expect(output).not.toContain("Command approval started");
    expect(output).not.toContain("File-change approval started");
    expect(getEvents).not.toHaveBeenCalled();
  });

  it("bb thread log --self resolves from BB_THREAD_ID", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-log-self");
    const getEvents = vi.fn(async () => []);
    const getTimeline = vi.fn(async () => makeTimelineResponse([]));
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                events: {
                  $get: getEvents,
                },
                timeline: {
                  $get: getTimeline,
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(["thread", "log", "--self"], (program) =>
      registerThreadCommands(program, () => "http://server"),
    );

    expect(getEvents).not.toHaveBeenCalled();
    expect(getTimeline).toHaveBeenCalledWith({
      param: { id: "thread-log-self" },
      query: {},
    });
    expect(collectLogLines(vi.mocked(console.error))).toEqual([]);
  });

  it("bb thread output --json prints the raw output payload", async () => {
    const getOutput = vi.fn(async () => ({ output: "FINAL" }));
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                output: {
                  $get: getOutput,
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(
      ["thread", "output", "thread-json-output", "--json"],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual({
      output: "FINAL",
    });
  });

  it("bb thread interactions list renders the shared borderless table", async () => {
    const listInteractions = vi.fn(async () => [
      makePendingInteraction({
        id: "int-1",
        providerId: "codex",
        providerRequestId: "request-1",
        providerThreadId: "provider-thread-1",
        threadId: "thread-1",
        turnId: "turn-1",
      }),
    ]);
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                interactions: {
                  $get: listInteractions,
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(
      ["thread", "interactions", "list", "thread-1"],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(listInteractions).toHaveBeenCalledWith({
      param: { id: "thread-1" },
    });
    const lines = collectLogPayloads(vi.mocked(console.log));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("");
    expect(lines[1]).toContain("ID");
    expect(lines[1]).toContain("Kind");
    expect(lines[1]).toContain("Status");
    expect(lines[1]).toContain("Summary");
    expect(lines[1]).toContain("int-1");
    expect(lines[1]).toContain("command");
    expect(lines[1]).toContain("pending");
    expect(lines[1]).toContain("Approve command");
    expect(lines[2]).toBe("");
  });

  it("bb thread interactions show prints interaction details", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-show-interaction");
    const getInteraction = vi.fn(async () =>
      makePendingInteraction({
        id: "int-show",
        providerId: "codex",
        providerRequestId: "request-show",
        providerThreadId: "provider-thread-show",
        threadId: "thread-show-interaction",
        turnId: "turn-show",
      }),
    );
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                interactions: {
                  ":interactionId": {
                    $get: getInteraction,
                  },
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(
      ["thread", "interactions", "show", "int-show"],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(getInteraction).toHaveBeenCalledWith({
      param: {
        id: "thread-show-interaction",
        interactionId: "int-show",
      },
    });
    expect(collectLogLines(vi.mocked(console.error))).toEqual([
      "Thread thread-show-interaction (from BB_THREAD_ID)",
    ]);
    const lines = collectLogLines(vi.mocked(console.log));
    expect(lines.slice(0, 4)).toEqual([
      "Interaction: int-show",
      "  Thread: thread-show-interaction",
      "  Kind: command",
      "  Status: pending",
    ]);
    expect(lines[4]).toMatch(/^  Created: /);
    expect(lines.slice(5)).toEqual([
      "  Command: git push",
      "  Cwd: /tmp/project",
      "  Prompt: Approve command",
      "  Decisions: allow_once, allow_for_session, deny",
    ]);
  });

  it("bb thread interactions show prints user question details", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-show-question");
    const getInteraction = vi.fn(async () =>
      makePendingInteraction({
        id: "int-question",
        providerId: "claude-code",
        providerRequestId: "request-question",
        providerThreadId: "provider-thread-question",
        threadId: "thread-show-question",
        turnId: "turn-question",
        status: "resolved",
        resolvedAt: Date.now(),
        payload: makeUserQuestionPayload(),
        resolution: {
          kind: "user_answer",
          answers: {
            "question-1": {
              selected: ["staging"],
              freeText: "Use staging url=https://staging.example.com first.",
            },
          },
        },
      }),
    );
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                interactions: {
                  ":interactionId": {
                    $get: getInteraction,
                  },
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(
      ["thread", "interactions", "show", "int-question"],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    const lines = collectLogLines(vi.mocked(console.log));
    expect(lines).toContain("  Kind: question");
    expect(lines).toContain("  Questions:");
    expect(lines).toContain("    - Path: Which deployment path?");
    expect(lines).toContain("      Options: Staging, Production");
    expect(lines).toContain("      Free text: allowed");
    expect(lines).toContain("Answers:");
    expect(lines).toContain(
      "  Path: Staging, Use staging url=https://staging.example.com first.",
    );
  });

  it("bb thread interactions answer resolves single-question interactions with shorthand flags", async () => {
    const getInteraction = vi.fn(async () =>
      makePendingInteraction({
        id: "int-question-answer",
        providerId: "claude-code",
        providerRequestId: "request-question-answer",
        providerThreadId: "provider-thread-question-answer",
        threadId: "thread-question-answer",
        turnId: "turn-question-answer",
        payload: makeUserQuestionPayload(),
      }),
    );
    const resolveInteraction = vi.fn(async () =>
      makePendingInteraction({
        id: "int-question-answer",
        providerId: "claude-code",
        providerRequestId: "request-question-answer",
        providerThreadId: "provider-thread-question-answer",
        threadId: "thread-question-answer",
        turnId: "turn-question-answer",
        payload: makeUserQuestionPayload(),
        status: "resolving",
        resolvedAt: null,
        resolution: {
          kind: "user_answer",
          answers: {
            "question-1": {
              selected: ["staging"],
              freeText: "Use staging first.",
            },
          },
        },
      }),
    );
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                interactions: {
                  ":interactionId": {
                    $get: getInteraction,
                    resolve: {
                      $post: resolveInteraction,
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(
      [
        "thread",
        "interactions",
        "answer",
        "int-question-answer",
        "thread-question-answer",
        "--choice",
        "staging",
        "--text",
        "Use staging url=https://staging.example.com first.",
      ],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(resolveInteraction).toHaveBeenCalledWith({
      param: {
        id: "thread-question-answer",
        interactionId: "int-question-answer",
      },
      json: {
        kind: "user_answer",
        answers: {
          "question-1": {
            selected: ["staging"],
            freeText: "Use staging url=https://staging.example.com first.",
          },
        },
      },
    });
    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      "Interaction int-question-answer submitted (answered); delivering to provider",
    ]);
  });

  it("bb thread interactions answer resolves multi-question interactions with explicit question ids", async () => {
    const getInteraction = vi.fn(async () =>
      makePendingInteraction({
        id: "int-question-multi",
        providerId: "claude-code",
        providerRequestId: "request-question-multi",
        providerThreadId: "provider-thread-question-multi",
        threadId: "thread-question-multi",
        turnId: "turn-question-multi",
        payload: makeMultiUserQuestionPayload(),
      }),
    );
    const resolveInteraction = vi.fn(async () =>
      makePendingInteraction({
        id: "int-question-multi",
        providerId: "claude-code",
        providerRequestId: "request-question-multi",
        providerThreadId: "provider-thread-question-multi",
        threadId: "thread-question-multi",
        turnId: "turn-question-multi",
        payload: makeMultiUserQuestionPayload(),
        status: "resolving",
        resolvedAt: null,
        resolution: {
          kind: "user_answer",
          answers: {
            "question-1": {
              selected: ["production"],
            },
            "question-2": {
              selected: [],
              freeText: "Wait for url=https://qa.example.com.",
            },
          },
        },
      }),
    );
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                interactions: {
                  ":interactionId": {
                    $get: getInteraction,
                    resolve: {
                      $post: resolveInteraction,
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(
      [
        "thread",
        "interactions",
        "answer",
        "int-question-multi",
        "thread-question-multi",
        "--choice",
        "question-1=production",
        "--text",
        "question-2=Wait for url=https://qa.example.com.",
      ],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(resolveInteraction).toHaveBeenCalledWith({
      param: {
        id: "thread-question-multi",
        interactionId: "int-question-multi",
      },
      json: {
        kind: "user_answer",
        answers: {
          "question-1": {
            selected: ["production"],
          },
          "question-2": {
            selected: [],
            freeText: "Wait for url=https://qa.example.com.",
          },
        },
      },
    });
  });

  it("bb thread interactions answer rejects shorthand for multi-question interactions", async () => {
    const getInteraction = vi.fn(async () =>
      makePendingInteraction({
        id: "int-question-shorthand",
        providerId: "claude-code",
        providerRequestId: "request-question-shorthand",
        providerThreadId: "provider-thread-question-shorthand",
        threadId: "thread-question-shorthand",
        turnId: "turn-question-shorthand",
        payload: makeMultiUserQuestionPayload(),
      }),
    );
    const resolveInteraction = vi.fn();
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                interactions: {
                  ":interactionId": {
                    $get: getInteraction,
                    resolve: {
                      $post: resolveInteraction,
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );

    await expect(
      runCommand(
        [
          "thread",
          "interactions",
          "answer",
          "int-question-shorthand",
          "thread-question-shorthand",
          "--choice",
          "staging",
        ],
        (program) => registerThreadCommands(program, () => "http://server"),
      ),
    ).rejects.toThrow("process.exit:1");
    expect(resolveInteraction).not.toHaveBeenCalled();
    expect(collectLogLines(vi.mocked(console.error)).join("\n")).toContain(
      "shorthand can only be used for single-question interactions",
    );
  });

  it("bb thread interactions answer rejects unknown explicit text question ids", async () => {
    const getInteraction = vi.fn(async () =>
      makePendingInteraction({
        id: "int-question-unknown-text",
        providerId: "claude-code",
        providerRequestId: "request-question-unknown-text",
        providerThreadId: "provider-thread-question-unknown-text",
        threadId: "thread-question-unknown-text",
        turnId: "turn-question-unknown-text",
        payload: makeMultiUserQuestionPayload(),
      }),
    );
    const resolveInteraction = vi.fn();
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                interactions: {
                  ":interactionId": {
                    $get: getInteraction,
                    resolve: {
                      $post: resolveInteraction,
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );

    await expect(
      runCommand(
        [
          "thread",
          "interactions",
          "answer",
          "int-question-unknown-text",
          "thread-question-unknown-text",
          "--text",
          "question-missing=Use staging",
        ],
        (program) => registerThreadCommands(program, () => "http://server"),
      ),
    ).rejects.toThrow("process.exit:1");
    expect(resolveInteraction).not.toHaveBeenCalled();
    expect(collectLogLines(vi.mocked(console.error)).join("\n")).toContain(
      "Answer references unknown question 'question-missing'",
    );
  });

  it("bb thread interactions answer rejects approvals and invalid question choices before posting", async () => {
    const getInteraction = vi
      .fn()
      .mockResolvedValueOnce(
        makePendingInteraction({
          id: "int-answer-approval",
          providerId: "codex",
          providerRequestId: "request-answer-approval",
          providerThreadId: "provider-thread-answer-approval",
          threadId: "thread-answer-approval",
          turnId: "turn-answer-approval",
        }),
      )
      .mockResolvedValueOnce(
        makePendingInteraction({
          id: "int-answer-invalid-choice",
          providerId: "claude-code",
          providerRequestId: "request-answer-invalid-choice",
          providerThreadId: "provider-thread-answer-invalid-choice",
          threadId: "thread-answer-invalid-choice",
          turnId: "turn-answer-invalid-choice",
          payload: makeUserQuestionPayload(),
        }),
      );
    const resolveInteraction = vi.fn();
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                interactions: {
                  ":interactionId": {
                    $get: getInteraction,
                    resolve: {
                      $post: resolveInteraction,
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );

    await expect(
      runCommand(
        [
          "thread",
          "interactions",
          "answer",
          "int-answer-approval",
          "thread-answer-approval",
          "--choice",
          "staging",
        ],
        (program) => registerThreadCommands(program, () => "http://server"),
      ),
    ).rejects.toThrow("process.exit:1");
    await expect(
      runCommand(
        [
          "thread",
          "interactions",
          "answer",
          "int-answer-invalid-choice",
          "thread-answer-invalid-choice",
          "--choice",
          "qa",
        ],
        (program) => registerThreadCommands(program, () => "http://server"),
      ),
    ).rejects.toThrow("process.exit:1");

    expect(resolveInteraction).not.toHaveBeenCalled();
    const errorOutput = collectLogLines(vi.mocked(console.error)).join("\n");
    expect(errorOutput).toContain("cannot be answered with this command");
    expect(errorOutput).toContain("does not offer choice 'qa'");
  });

  it("bb thread interactions show indicates when resolution delivery is in progress", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-show-resolving");
    const getInteraction = vi.fn(async () =>
      makePendingInteraction({
        id: "int-show-resolving",
        providerId: "codex",
        providerRequestId: "request-show-resolving",
        providerThreadId: "provider-thread-show-resolving",
        threadId: "thread-show-resolving",
        turnId: "turn-show-resolving",
        status: "resolving",
        resolution: {
          decision: "allow_for_session",
          grantedPermissions: null,
        },
      }),
    );
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                interactions: {
                  ":interactionId": {
                    $get: getInteraction,
                  },
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(
      ["thread", "interactions", "show", "int-show-resolving"],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    const lines = collectLogLines(vi.mocked(console.log));
    expect(lines).toContain("  Status: resolving");
    expect(lines).toContain("  Delivery: waiting for provider acknowledgement");
    expect(lines).toContain("Resolution:");
    expect(lines).toContain("  Decision: allow_for_session");
  });

  it("bb thread interactions approve resolves command approvals for the current turn", async () => {
    const getInteraction = vi.fn(async () =>
      makePendingInteraction({
        id: "int-approve",
        providerId: "codex",
        providerRequestId: "request-approve",
        providerThreadId: "provider-thread-approve",
        threadId: "thread-approve",
        turnId: "turn-approve",
      }),
    );
    const resolveInteraction = vi.fn(async () =>
      makePendingInteraction({
        id: "int-approve",
        providerId: "codex",
        providerRequestId: "request-approve",
        providerThreadId: "provider-thread-approve",
        threadId: "thread-approve",
        turnId: "turn-approve",
        status: "resolving",
        resolvedAt: null,
        resolution: {
          decision: "allow_once",
          grantedPermissions: null,
        },
      }),
    );
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                interactions: {
                  ":interactionId": {
                    $get: getInteraction,
                    resolve: {
                      $post: resolveInteraction,
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(
      ["thread", "interactions", "approve", "int-approve", "thread-approve"],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(resolveInteraction).toHaveBeenCalledWith({
      param: {
        id: "thread-approve",
        interactionId: "int-approve",
      },
      json: {
        decision: "allow_once",
        grantedPermissions: null,
      },
    });
    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      "Interaction int-approve submitted (approved); delivering to provider",
    ]);
  });

  it("bb thread interactions approve falls back to accept when session approval is unavailable", async () => {
    const getInteraction = vi.fn(async () =>
      makePendingInteraction({
        id: "int-approve-no-session",
        providerId: "codex",
        providerRequestId: "request-approve-no-session",
        providerThreadId: "provider-thread-approve-no-session",
        threadId: "thread-approve-no-session",
        turnId: "turn-approve-no-session",
        payload: makeCommandApprovalPayload("item-approve-no-session", [
          "allow_once",
          "deny",
        ]),
      }),
    );
    const resolveInteraction = vi.fn(async () =>
      makePendingInteraction({
        id: "int-approve-no-session",
        providerId: "codex",
        providerRequestId: "request-approve-no-session",
        providerThreadId: "provider-thread-approve-no-session",
        threadId: "thread-approve-no-session",
        turnId: "turn-approve-no-session",
        payload: makeCommandApprovalPayload("item-approve-no-session", [
          "allow_once",
          "deny",
        ]),
        status: "resolving",
        resolvedAt: null,
        resolution: {
          decision: "allow_once",
          grantedPermissions: null,
        },
      }),
    );
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                interactions: {
                  ":interactionId": {
                    $get: getInteraction,
                    resolve: {
                      $post: resolveInteraction,
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(
      [
        "thread",
        "interactions",
        "approve",
        "int-approve-no-session",
        "thread-approve-no-session",
      ],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(resolveInteraction).toHaveBeenCalledWith({
      param: {
        id: "thread-approve-no-session",
        interactionId: "int-approve-no-session",
      },
      json: {
        decision: "allow_once",
        grantedPermissions: null,
      },
    });
    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      "Interaction int-approve-no-session submitted (approved); delivering to provider",
    ]);
  });

  it("bb thread interactions approve errors when no allow decision is available", async () => {
    const getInteraction = vi.fn(async () =>
      makePendingInteraction({
        id: "int-approve-amendment",
        providerId: "codex",
        providerRequestId: "request-approve-amendment",
        providerThreadId: "provider-thread-approve-amendment",
        threadId: "thread-approve-amendment",
        turnId: "turn-approve-amendment",
        payload: makeCommandApprovalPayload("item-approve-amendment", ["deny"]),
      }),
    );
    const resolveInteraction = vi.fn();
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                interactions: {
                  ":interactionId": {
                    $get: getInteraction,
                    resolve: {
                      $post: resolveInteraction,
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );

    await expect(
      runCommand(
        [
          "thread",
          "interactions",
          "approve",
          "int-approve-amendment",
          "thread-approve-amendment",
        ],
        (program) => registerThreadCommands(program, () => "http://server"),
      ),
    ).rejects.toThrow("process.exit:1");
    expect(resolveInteraction).not.toHaveBeenCalled();
    expect(collectLogLines(vi.mocked(console.error)).join("\n")).toContain(
      "does not offer an approval decision",
    );
  });

  it("bb thread interactions deny uses decline when it is available", async () => {
    const getInteraction = vi.fn(async () =>
      makePendingInteraction({
        id: "int-deny",
        providerId: "codex",
        providerRequestId: "request-deny",
        providerThreadId: "provider-thread-deny",
        threadId: "thread-deny",
        turnId: "turn-deny",
      }),
    );
    const resolveInteraction = vi.fn(async () =>
      makePendingInteraction({
        id: "int-deny",
        providerId: "codex",
        providerRequestId: "request-deny",
        providerThreadId: "provider-thread-deny",
        threadId: "thread-deny",
        turnId: "turn-deny",
        status: "resolving",
        resolvedAt: null,
        resolution: {
          decision: "deny",
        },
      }),
    );
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                interactions: {
                  ":interactionId": {
                    $get: getInteraction,
                    resolve: {
                      $post: resolveInteraction,
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(
      ["thread", "interactions", "deny", "int-deny", "thread-deny"],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(resolveInteraction).toHaveBeenCalledWith({
      param: {
        id: "thread-deny",
        interactionId: "int-deny",
      },
      json: {
        decision: "deny",
      },
    });
    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      "Interaction int-deny submitted (denied); delivering to provider",
    ]);
  });

  it("bb thread interactions deny errors when deny is unavailable", async () => {
    const getInteraction = vi.fn(async () =>
      makePendingInteraction({
        id: "int-cancel",
        providerId: "codex",
        providerRequestId: "request-cancel",
        providerThreadId: "provider-thread-cancel",
        threadId: "thread-cancel",
        turnId: "turn-cancel",
        payload: makeCommandApprovalPayload("item-cancel", ["allow_once"]),
      }),
    );
    const resolveInteraction = vi.fn();
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                interactions: {
                  ":interactionId": {
                    $get: getInteraction,
                    resolve: {
                      $post: resolveInteraction,
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );

    await expect(
      runCommand(
        ["thread", "interactions", "deny", "int-cancel", "thread-cancel"],
        (program) => registerThreadCommands(program, () => "http://server"),
      ),
    ).rejects.toThrow("process.exit:1");
    expect(resolveInteraction).not.toHaveBeenCalled();
    expect(collectLogLines(vi.mocked(console.error)).join("\n")).toContain(
      "does not offer a deny decision",
    );
  });

  it("bb thread interactions approve resolves file-change approvals without granting extra permissions", async () => {
    const getInteraction = vi.fn(async () =>
      makePendingInteraction({
        id: "int-file-change",
        providerId: "codex",
        providerRequestId: "request-file-change",
        providerThreadId: "provider-thread-file-change",
        threadId: "thread-file-change",
        turnId: "turn-file-change",
        payload: makeFileChangeApprovalPayload("item-file-change"),
      }),
    );
    const resolveInteraction = vi.fn(async () =>
      makePendingInteraction({
        id: "int-file-change",
        providerId: "codex",
        providerRequestId: "request-file-change",
        providerThreadId: "provider-thread-file-change",
        threadId: "thread-file-change",
        turnId: "turn-file-change",
        payload: makeFileChangeApprovalPayload("item-file-change"),
        status: "resolving",
        resolvedAt: null,
        resolution: {
          decision: "allow_once",
          grantedPermissions: null,
        },
      }),
    );
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                interactions: {
                  ":interactionId": {
                    $get: getInteraction,
                    resolve: {
                      $post: resolveInteraction,
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(
      [
        "thread",
        "interactions",
        "approve",
        "int-file-change",
        "thread-file-change",
      ],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(resolveInteraction).toHaveBeenCalledWith({
      param: {
        id: "thread-file-change",
        interactionId: "int-file-change",
      },
      json: {
        decision: "allow_once",
        grantedPermissions: null,
      },
    });
    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      "Interaction int-file-change submitted (approved); delivering to provider",
    ]);
  });

  it("bb thread interactions grant resolves permission requests", async () => {
    const getInteraction = vi.fn(async () =>
      makePendingInteraction({
        id: "int-permission-grant",
        providerId: "codex",
        providerRequestId: "request-permission-grant",
        providerThreadId: "provider-thread-permission-grant",
        threadId: "thread-permission-grant",
        turnId: "turn-permission-grant",
        payload: makePermissionGrantApprovalPayload("item-permission-grant"),
      }),
    );
    const resolveInteraction = vi.fn(async () =>
      makePendingInteraction({
        id: "int-permission-grant",
        providerId: "codex",
        providerRequestId: "request-permission-grant",
        providerThreadId: "provider-thread-permission-grant",
        threadId: "thread-permission-grant",
        turnId: "turn-permission-grant",
        payload: makePermissionGrantApprovalPayload("item-permission-grant"),
        status: "resolving",
        resolvedAt: null,
        resolution: {
          decision: "allow_for_session",
          grantedPermissions: {
            network: { enabled: true },
            fileSystem: {
              read: ["/tmp/project/README.md"],
              write: ["/tmp/project/notes.md"],
            },
          },
        },
      }),
    );
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                interactions: {
                  ":interactionId": {
                    $get: getInteraction,
                    resolve: {
                      $post: resolveInteraction,
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(
      [
        "thread",
        "interactions",
        "grant",
        "int-permission-grant",
        "thread-permission-grant",
      ],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(resolveInteraction).toHaveBeenCalledWith({
      param: {
        id: "thread-permission-grant",
        interactionId: "int-permission-grant",
      },
      json: {
        decision: "allow_for_session",
        grantedPermissions: {
          network: { enabled: true },
          fileSystem: {
            read: ["/tmp/project/README.md"],
            write: ["/tmp/project/notes.md"],
          },
        },
      },
    });
    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      "Interaction int-permission-grant submitted (approved for this session); delivering to provider",
    ]);
  });

  it("bb thread interactions grant builds a semantic turn-scoped resolution from server interaction data", async () => {
    const getInteraction = vi.fn(async () =>
      makePendingInteraction({
        id: "int-claude-permission-grant",
        providerId: "claude-code",
        providerRequestId: "request-claude-permission-grant",
        providerThreadId: "provider-thread-claude-permission-grant",
        threadId: "thread-claude-permission-grant",
        turnId: "turn-claude-permission-grant",
        payload: makePermissionGrantApprovalPayload(
          "item-claude-permission-grant",
        ),
      }),
    );
    const resolveInteraction = vi.fn(async () =>
      makePendingInteraction({
        id: "int-claude-permission-grant",
        providerId: "claude-code",
        providerRequestId: "request-claude-permission-grant",
        providerThreadId: "provider-thread-claude-permission-grant",
        threadId: "thread-claude-permission-grant",
        turnId: "turn-claude-permission-grant",
        payload: makePermissionGrantApprovalPayload(
          "item-claude-permission-grant",
        ),
        status: "resolving",
        resolvedAt: null,
        resolution: {
          decision: "allow_once",
          grantedPermissions: {
            network: { enabled: true },
            fileSystem: {
              read: ["/tmp/project/README.md"],
              write: ["/tmp/project/notes.md"],
            },
          },
        },
      }),
    );
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                interactions: {
                  ":interactionId": {
                    $get: getInteraction,
                    resolve: {
                      $post: resolveInteraction,
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(
      [
        "thread",
        "interactions",
        "grant",
        "int-claude-permission-grant",
        "thread-claude-permission-grant",
        "--scope",
        "turn",
      ],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(resolveInteraction).toHaveBeenCalledWith({
      param: {
        id: "thread-claude-permission-grant",
        interactionId: "int-claude-permission-grant",
      },
      json: {
        decision: "allow_once",
        grantedPermissions: {
          network: { enabled: true },
          fileSystem: {
            read: ["/tmp/project/README.md"],
            write: ["/tmp/project/notes.md"],
          },
        },
      },
    });
    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      "Interaction int-claude-permission-grant submitted (approved); delivering to provider",
    ]);
  });

  it("bb thread interactions deny resolves permission requests as denied", async () => {
    const getInteraction = vi.fn(async () =>
      makePendingInteraction({
        id: "int-permission-deny",
        providerId: "codex",
        providerRequestId: "request-permission-deny",
        providerThreadId: "provider-thread-permission-deny",
        threadId: "thread-permission-deny",
        turnId: "turn-permission-deny",
        payload: makePermissionGrantApprovalPayload("item-permission-deny"),
      }),
    );
    const resolveInteraction = vi.fn(async () =>
      makePendingInteraction({
        id: "int-permission-deny",
        providerId: "codex",
        providerRequestId: "request-permission-deny",
        providerThreadId: "provider-thread-permission-deny",
        threadId: "thread-permission-deny",
        turnId: "turn-permission-deny",
        payload: makePermissionGrantApprovalPayload("item-permission-deny"),
        status: "resolving",
        resolvedAt: null,
        resolution: {
          decision: "deny",
        },
      }),
    );
    createClientMock.mockReturnValue(
      asServerClient({
        api: {
          v1: {
            threads: {
              ":id": {
                interactions: {
                  ":interactionId": {
                    $get: getInteraction,
                    resolve: {
                      $post: resolveInteraction,
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );

    await runCommand(
      [
        "thread",
        "interactions",
        "deny",
        "int-permission-deny",
        "thread-permission-deny",
      ],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(resolveInteraction).toHaveBeenCalledWith({
      param: {
        id: "thread-permission-deny",
        interactionId: "int-permission-deny",
      },
      json: {
        decision: "deny",
      },
    });
    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      "Interaction int-permission-deny submitted (denied); delivering to provider",
    ]);
  });
});

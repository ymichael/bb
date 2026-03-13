import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import type { Thread } from "@beanbag/agent-core";

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

import { createClient, unwrap } from "../client.js";
import { registerManagerCommands } from "../commands/manager.js";
import { registerDaemonCommands } from "../commands/daemon.js";
import { registerProjectCommands } from "../commands/project.js";
import { registerStatusCommand } from "../commands/status.js";
import { registerThreadCommands } from "../commands/thread.js";

type DaemonClient = ReturnType<typeof createClient>;

function asDaemonClient(value: unknown): DaemonClient {
  return value as DaemonClient;
}

function collectLogLines(logSpy: ReturnType<typeof vi.spyOn>): string[] {
  return logSpy.mock.calls.map((args: unknown[]) => args.join(" "));
}

async function runCommand(
  args: string[],
  register: (program: Command) => void,
): Promise<void> {
  const program = new Command();
  register(program);
  await program.parseAsync(["node", "bb", ...args]);
}

describe("CLI command output contracts", () => {
  const createClientMock = vi.mocked(createClient);
  const unwrapMock = vi.mocked(unwrap);

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit:${code ?? 0}`);
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
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

    delete process.env.BB_PROJECT_ID;
    delete process.env.BB_THREAD_ID;
    delete process.env.BEANBAG_ENVIRONMENT;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });


  it("bb project list --json prints raw projects", async () => {
    const projects = [
      {
        id: "proj-1",
        name: "Alpha",
        rootPath: "/tmp/alpha",
        createdAt: 1,
        updatedAt: 2,
      },
    ];
    const get = vi.fn(async () => projects);
    createClientMock.mockReturnValue(asDaemonClient({
      api: {
        v1: {
          projects: {
            $get: get,
          },
        },
      },
    }));

    await runCommand(["project", "list", "--json"], (program) =>
      registerProjectCommands(program, () => "http://daemon"),
    );

    expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toEqual(
      projects,
    );
  });

  it("bb project create --json prints the created project", async () => {
    const created = {
      id: "proj-created",
      name: "Alpha",
      rootPath: "/tmp/alpha",
      createdAt: 1,
      updatedAt: 2,
    };
    const post = vi.fn(async () => created);
    createClientMock.mockReturnValue(asDaemonClient({
      api: {
        v1: {
          projects: {
            $post: post,
          },
        },
      },
    }));

    await runCommand(
      ["project", "create", "--name", "Alpha", "--root", "/tmp/alpha", "--json"],
      (program) => registerProjectCommands(program, () => "http://daemon"),
    );

    expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toEqual(
      created,
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
    createClientMock.mockReturnValue(asDaemonClient({
      api: {
        v1: {
          projects: {
            ":id": {
              manager: {
                $post: post,
              },
            },
          },
        },
      },
    }));

    await runCommand(["manager", "hire", "project-123"], (program) =>
      registerManagerCommands(program, () => "http://daemon"),
    );

    expect(post).toHaveBeenCalledWith({
      param: { id: "project-123" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain("Manager ready: thread-manager-1");
  });

  it("bb manager show reports when no manager is hired", async () => {
    const get = vi.fn(async () => [
      {
        id: "project-123",
        name: "Repo",
        rootPath: "/tmp/repo",
        createdAt: 1,
        updatedAt: 2,
        primaryManagerThreadId: null,
      },
    ]);
    createClientMock.mockReturnValue(asDaemonClient({
      api: {
        v1: {
          projects: {
            $get: get,
          },
        },
      },
    }));

    await runCommand(["manager", "show", "project-123"], (program) =>
      registerManagerCommands(program, () => "http://daemon"),
    );

    expect(collectLogLines(vi.mocked(console.log))).toContain("No manager hired");
  });

  it("bb manager status includes managed child threads", async () => {
    const managerThread: Thread = {
      id: "thread-manager-1",
      projectId: "project-123",
      providerId: "codex",
      title: "Manager",
      type: "manager",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    };
    const managedThread: Thread = {
      id: "thread-worker-1",
      projectId: "project-123",
      providerId: "codex",
      title: "Worker",
      type: "standard",
      status: "active",
      parentThreadId: "thread-manager-1",
      createdAt: 3,
      updatedAt: 4,
    };
    const get = vi.fn(async ({ param }: { param: { id: string } }) => {
      expect(param.id).toBe("thread-manager-1");
      return managerThread;
    });
    const list = vi.fn(async ({ query }: { query: { parentThreadId?: string } }) => {
      expect(query.parentThreadId).toBe("thread-manager-1");
      return [managedThread];
    });
    createClientMock.mockReturnValue(asDaemonClient({
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
    }));

    await runCommand(["manager", "status", "thread-manager-1"], (program) =>
      registerManagerCommands(program, () => "http://daemon"),
    );

    const lines = collectLogLines(vi.mocked(console.log));
    expect(lines).toContain("Managed threads:");
    expect(lines.some((line) => line.includes("thread-worker-1"))).toBe(true);
  });

  it("bb manager send posts a tell message", async () => {
    const managerThread: Thread = {
      id: "thread-manager-1",
      projectId: "project-123",
      providerId: "codex",
      type: "manager",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    };
    const get = vi.fn(async () => managerThread);
    const post = vi.fn(async () => ({ ok: true }));
    createClientMock.mockReturnValue(asDaemonClient({
      api: {
        v1: {
          threads: {
            ":id": {
              $get: get,
              tell: {
                $post: post,
              },
            },
          },
        },
      },
    }));

    await runCommand(
      ["manager", "send", "thread-manager-1", "hello manager"],
      (program) => registerManagerCommands(program, () => "http://daemon"),
    );

    expect(post).toHaveBeenCalledWith({
      param: { id: "thread-manager-1" },
      json: {
        input: [{ type: "text", text: "hello manager" }],
      },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Manager thread-manager-1 updated",
    );
  });

  it("bb manager delete deletes the manager thread", async () => {
    const managerThread: Thread = {
      id: "thread-manager-1",
      projectId: "project-123",
      providerId: "codex",
      title: "Manager",
      type: "manager",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    };
    const get = vi.fn(async () => managerThread);
    createClientMock.mockReturnValue(asDaemonClient({
      api: {
        v1: {
          threads: {
            ":id": {
              $get: get,
            },
          },
        },
      },
    }));

    await runCommand(
      ["manager", "delete", "thread-manager-1", "--yes"],
      (program) => registerManagerCommands(program, () => "http://daemon"),
    );

    expect(globalThis.fetch).toHaveBeenCalledWith(
      new URL("/api/v1/threads/thread-manager-1", "http://daemon"),
      { method: "DELETE" },
    );
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Manager thread-manager-1 deleted",
    );
  });

  it("bb manager log prints events", async () => {
    const managerThread: Thread = {
      id: "thread-manager-1",
      projectId: "project-123",
      providerId: "codex",
      type: "manager",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    };
    const get = vi.fn(async () => managerThread);
    const eventsGet = vi.fn(async () => [
      {
        seq: 1,
        threadId: "thread-manager-1",
        type: "system/manager/user_message",
        data: { text: "hello" },
        createdAt: 3,
      },
    ]);
    createClientMock.mockReturnValue(asDaemonClient({
      api: {
        v1: {
          threads: {
            ":id": {
              $get: get,
              events: {
                $get: eventsGet,
              },
            },
          },
        },
      },
    }));

    await runCommand(["manager", "log", "thread-manager-1"], (program) =>
      registerManagerCommands(program, () => "http://daemon"),
    );

    expect(eventsGet).toHaveBeenCalledWith({
      param: { id: "thread-manager-1" },
      query: {},
    });
    expect(
      collectLogLines(vi.mocked(console.log)).some((line) =>
        line.includes("system/manager/user_message"),
      ),
    ).toBe(true);
  });

  it("bb status prints project/thread context", async () => {
    process.env.BB_PROJECT_ID = "proj-1";
    process.env.BB_THREAD_ID = "thread-1";

    await runCommand(["status"], (program) =>
      registerStatusCommand(program, () => "http://daemon"),
    );

    const lines = collectLogLines(vi.mocked(console.log));
    expect(lines).toContain("Project: proj-1");
    expect(lines).toContain("Thread: thread-1");
  });

  it("bb thread spawn sends project and prompt", async () => {
    process.env.BB_PROJECT_ID = "proj-1";
    const thread: Thread = {
      id: "thread-1",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "created",
      createdAt: 1,
      updatedAt: 1,
    };
    const post = vi.fn(async () => thread);
    createClientMock.mockReturnValue(asDaemonClient({
      api: {
        v1: {
          threads: {
            $post: post,
          },
        },
      },
    }));

    await runCommand(["thread", "spawn", "--prompt", "hello"], (program) =>
      registerThreadCommands(program, () => "http://daemon"),
    );

    expect(post).toHaveBeenCalledWith({
      json: {
        projectId: "proj-1",
        input: [{ type: "text", text: "hello" }],
      },
    });
  });

  it("bb thread list supports parent-thread filtering", async () => {
    const list = vi.fn(async () => []);
    createClientMock.mockReturnValue(asDaemonClient({
      api: {
        v1: {
          threads: {
            $get: list,
          },
        },
      },
    }));

    await runCommand(
      ["thread", "list", "--project", "proj-1", "--parent-thread", "thread-manager-1"],
      (program) => registerThreadCommands(program, () => "http://daemon"),
    );

    expect(list).toHaveBeenCalledWith({
      query: {
        projectId: "proj-1",
        parentThreadId: "thread-manager-1",
      },
    });
  });

  it("bb thread spawn --json prints the raw thread", async () => {
    process.env.BB_PROJECT_ID = "proj-1";
    const thread: Thread = {
      id: "thread-json-spawn",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "created",
      createdAt: 1,
      updatedAt: 1,
    };
    const post = vi.fn(async () => thread);
    createClientMock.mockReturnValue(asDaemonClient({
      api: {
        v1: {
          threads: {
            $post: post,
          },
        },
      },
    }));

    await runCommand(["thread", "spawn", "--json"], (program) =>
      registerThreadCommands(program, () => "http://daemon"),
    );

    expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toEqual(
      thread,
    );
  });

  it("bb thread spawn with --parent-thread forwards parent thread id", async () => {
    process.env.BB_PROJECT_ID = "proj-1";
    const thread: Thread = {
      id: "thread-2",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "created",
      parentThreadId: "thread-parent",
      createdAt: 1,
      updatedAt: 1,
    };
    const post = vi.fn(async () => thread);
    createClientMock.mockReturnValue(asDaemonClient({
      api: {
        v1: {
          threads: {
            $post: post,
          },
        },
      },
    }));

    await runCommand(
      ["thread", "spawn", "--parent-thread", "thread-parent"],
      (program) => registerThreadCommands(program, () => "http://daemon"),
    );

    expect(post).toHaveBeenCalledWith({
      json: {
        projectId: "proj-1",
        input: undefined,
        parentThreadId: "thread-parent",
      },
    });
  });

  it("bb thread spawn forwards --environment", async () => {
    process.env.BB_PROJECT_ID = "proj-1";
    const thread: Thread = {
      id: "thread-env-1",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "created",
      environmentId: "worktree",
      createdAt: 1,
      updatedAt: 1,
    };
    const post = vi.fn(async () => thread);
    createClientMock.mockReturnValue(asDaemonClient({
      api: {
        v1: {
          threads: {
            $post: post,
          },
        },
      },
    }));

    await runCommand(
      ["thread", "spawn", "--environment", "worktree"],
      (program) => registerThreadCommands(program, () => "http://daemon"),
    );

    expect(post).toHaveBeenCalledWith({
      json: {
        projectId: "proj-1",
        input: undefined,
        environmentId: "worktree",
      },
    });
  });

  it("bb thread spawn falls back to BEANBAG_ENVIRONMENT", async () => {
    process.env.BB_PROJECT_ID = "proj-1";
    process.env.BEANBAG_ENVIRONMENT = "local";
    const thread: Thread = {
      id: "thread-env-2",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "created",
      environmentId: "local",
      createdAt: 1,
      updatedAt: 1,
    };
    const post = vi.fn(async () => thread);
    createClientMock.mockReturnValue(asDaemonClient({
      api: {
        v1: {
          threads: {
            $post: post,
          },
        },
      },
    }));

    await runCommand(["thread", "spawn"], (program) =>
      registerThreadCommands(program, () => "http://daemon"),
    );

    expect(post).toHaveBeenCalledWith({
      json: {
        projectId: "proj-1",
        input: undefined,
        environmentId: "local",
      },
    });
  });

  it("bb thread archive sends the thread id from args", async () => {
    await runCommand(["thread", "archive", "thread-archive-1"], (program) =>
      registerThreadCommands(program, () => "http://daemon"),
    );

    expect(globalThis.fetch).toHaveBeenCalledWith(
      new URL("http://daemon/api/v1/threads/thread-archive-1/archive"),
      { method: "POST" },
    );
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-archive-1 archived",
    );
  });

  it("bb thread archive falls back to BB_THREAD_ID and forwards --force", async () => {
    process.env.BB_THREAD_ID = "thread-archive-2";

    await runCommand(["thread", "archive", "--force"], (program) =>
      registerThreadCommands(program, () => "http://daemon"),
    );

    expect(globalThis.fetch).toHaveBeenCalledWith(
      new URL("http://daemon/api/v1/threads/thread-archive-2/archive"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      },
    );
  });

  it("bb thread unarchive falls back to BB_THREAD_ID", async () => {
    process.env.BB_THREAD_ID = "thread-unarchive-1";
    const unarchivePost = vi.fn(async () => ({ ok: true }));
    createClientMock.mockReturnValue(asDaemonClient({
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
    }));

    await runCommand(["thread", "unarchive"], (program) =>
      registerThreadCommands(program, () => "http://daemon"),
    );

    expect(unarchivePost).toHaveBeenCalledWith({
      param: { id: "thread-unarchive-1" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-unarchive-1 unarchived",
    );
  });

  it("bb thread delete prompts before deleting", async () => {
    const thread: Thread = {
      id: "thread-delete-1",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "idle",
      title: "Delete me",
      createdAt: 1,
      updatedAt: 1,
    };
    const get = vi.fn(async () => thread);
    createClientMock.mockReturnValue(asDaemonClient({
      api: {
        v1: {
          threads: {
            ":id": {
              $get: get,
            },
          },
        },
      },
    }));
    readlineState.question.mockResolvedValue("yes");

    await runCommand(["thread", "delete", "thread-delete-1"], (program) =>
      registerThreadCommands(program, () => "http://daemon"),
    );

    expect(get).toHaveBeenCalledWith({
      param: { id: "thread-delete-1" },
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      new URL("http://daemon/api/v1/threads/thread-delete-1"),
      { method: "DELETE" },
    );
    expect(readlineState.question).toHaveBeenCalled();
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-delete-1 deleted",
    );
  });

  it("bb thread delete cancels when confirmation is declined", async () => {
    const thread: Thread = {
      id: "thread-delete-2",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    };
    const get = vi.fn(async () => thread);
    createClientMock.mockReturnValue(asDaemonClient({
      api: {
        v1: {
          threads: {
            ":id": {
              $get: get,
            },
          },
        },
      },
    }));
    readlineState.question.mockResolvedValue("no");

    await runCommand(["thread", "delete", "thread-delete-2"], (program) =>
      registerThreadCommands(program, () => "http://daemon"),
    );

    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      new URL("http://daemon/api/v1/threads/thread-delete-2"),
      { method: "DELETE" },
    );
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-delete-2 deletion cancelled",
    );
  });

  it("bb thread delete --yes skips confirmation", async () => {
    process.env.BB_THREAD_ID = "thread-delete-3";
    const thread: Thread = {
      id: "thread-delete-3",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    };
    const get = vi.fn(async () => thread);
    createClientMock.mockReturnValue(asDaemonClient({
      api: {
        v1: {
          threads: {
            ":id": {
              $get: get,
            },
          },
        },
      },
    }));

    await runCommand(["thread", "delete", "--yes"], (program) =>
      registerThreadCommands(program, () => "http://daemon"),
    );

    expect(readlineState.question).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      new URL("http://daemon/api/v1/threads/thread-delete-3"),
      { method: "DELETE" },
    );
  });

  it("bb daemon restart requests daemon shutdown", async () => {
    const shutdownPost = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          forced: false,
          blockingThreadsCount: 0,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ));
    createClientMock.mockReturnValue(asDaemonClient({
      api: {
        v1: {
          system: {
            shutdown: {
              $post: shutdownPost,
            },
          },
        },
      },
    }));
    unwrapMock.mockImplementation(async (responsePromise: Promise<unknown>) => {
      const response = await responsePromise as Response;
      return response.json();
    });

    await runCommand(["daemon", "restart"], (program) =>
      registerDaemonCommands(program, () => "http://daemon"),
    );

    expect(shutdownPost).toHaveBeenCalledWith({
      json: {},
    });
    const lines = collectLogLines(vi.mocked(console.log));
    expect(lines).toContain("Daemon shutdown requested.");
  });

  it("bb daemon health prints storage and thread summary", async () => {
    const healthGet = vi.fn(async () =>
      new Response(
        JSON.stringify({
          generatedAt: 1_700_000_000_000,
          uptime: 3661,
          projectCount: 2,
          runningThreads: 1,
          threadCounts: {
            total: 4,
            archived: 1,
            created: 0,
            provisioning: 1,
            provisioningFailed: 0,
            active: 1,
            idle: 2,
          },
          storage: {
            totalBytes: 1536,
            disk: {
              path: "/Users/test/.beanbag",
              availableBytes: 4096,
              totalBytes: 8192,
              usedBytes: 4096,
            },
            buckets: [
              {
                key: "worktrees",
                label: "Worktrees",
                bytes: 1024,
                paths: ["/Users/test/.beanbag/worktrees"],
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ));
    createClientMock.mockReturnValue(asDaemonClient({
      api: {
        v1: {
          system: {
            health: {
              $get: healthGet,
            },
          },
        },
      },
    }));
    unwrapMock.mockImplementation(async (responsePromise: Promise<unknown>) => {
      const response = await responsePromise as Response;
      return response.json();
    });

    await runCommand(["daemon", "health"], (program) =>
      registerDaemonCommands(program, () => "http://daemon"),
    );

    expect(healthGet).toHaveBeenCalledTimes(1);
    const lines = collectLogLines(vi.mocked(console.log));
    expect(lines).toContain("Daemon Health");
    expect(lines).toContain("Projects: 2");
    expect(lines).toContain("Running threads: 1");
    expect(lines).toContain("Managed storage: 1.50 KiB");
    expect(lines).toContain("Storage buckets:");
    expect(lines).toContain("- Worktrees: 1.00 KiB");
    expect(lines).toContain("  /Users/test/.beanbag/worktrees");
  });

  it("bb thread show prints archived timestamp for archived threads", async () => {
    const thread: Thread = {
      id: "thread-archived-1",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "idle",
      archivedAt: 1_700_000_000_000,
      createdAt: 1,
      updatedAt: 2,
    };
    const get = vi.fn(async () => thread);
    createClientMock.mockReturnValue(asDaemonClient({
      api: {
        v1: {
          threads: {
            ":id": {
              $get: get,
            },
          },
        },
      },
    }));

    await runCommand(["thread", "show", "thread-archived-1"], (program) =>
      registerThreadCommands(program, () => "http://daemon"),
    );

    expect(get).toHaveBeenCalledWith({
      param: { id: "thread-archived-1" },
    });
    const lines = collectLogLines(vi.mocked(console.log));
    expect(lines.some((line) => line.includes("Archived:"))).toBe(true);
  });

  it("bb daemon restart exits when shutdown is blocked by active work", async () => {
    const shutdownPost = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: "shutdown_blocked",
          message: "Daemon shutdown blocked by active thread work",
          blockingThreads: [
            { id: "thread-1", status: "active", projectId: "proj-1" },
          ],
        }),
        {
          status: 409,
          headers: { "Content-Type": "application/json" },
        },
      ));
    vi.mocked(createClient).mockReturnValue(asDaemonClient({
      api: {
        v1: {
          system: {
            shutdown: {
              $post: shutdownPost,
            },
          },
        },
      },
    }));

    await expect(
      runCommand(["daemon", "restart"], (program) =>
        registerDaemonCommands(program, () => "http://daemon"),
      ),
    ).rejects.toThrow("process.exit:1");

    const errorLines = collectLogLines(vi.mocked(console.error));
    expect(errorLines).toContain("Daemon shutdown blocked by active thread work");
    expect(errorLines).toContain("Blocking threads:");
    expect(errorLines).toContain("- thread-1 (active, project proj-1)");
  });
});

describe("CLI JSON output contracts", () => {
  const createClientMock = vi.mocked(createClient);
  const unwrapMock = vi.mocked(unwrap);

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit:${code ?? 0}`);
    });

    createClientMock.mockReset();
    unwrapMock.mockReset();
    unwrapMock.mockImplementation(async (responsePromise: Promise<unknown>) => {
      return responsePromise;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("bb daemon health --json prints the raw report", async () => {
    const report = {
      generatedAt: 1_700_000_000_000,
      uptime: 3661,
      projectCount: 2,
      runningThreads: 1,
      threadCounts: {
        total: 4,
        archived: 1,
        created: 0,
        provisioning: 1,
        provisioned: 0,
        provisioningFailed: 0,
        error: 0,
        active: 1,
        idle: 2,
      },
      storage: {
        totalBytes: 1536,
        buckets: [],
      },
    };
    const healthGet = vi.fn(async () =>
      new Response(JSON.stringify(report), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    createClientMock.mockReturnValue(asDaemonClient({
      api: {
        v1: {
          system: {
            health: {
              $get: healthGet,
            },
          },
        },
      },
    }));
    unwrapMock.mockImplementation(async (responsePromise: Promise<unknown>) => {
      const response = await responsePromise as Response;
      return response.json();
    });

    await runCommand(["daemon", "health", "--json"], (program) =>
      registerDaemonCommands(program, () => "http://daemon"),
    );

    expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toEqual(
      report,
    );
  });

  it("bb thread show --json prints the raw thread", async () => {
    const thread: Thread = {
      id: "thread-json-show",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    };
    const get = vi.fn(async () => thread);
    createClientMock.mockReturnValue(asDaemonClient({
      api: {
        v1: {
          threads: {
            ":id": {
              $get: get,
            },
          },
        },
      },
    }));

    await runCommand(["thread", "show", "thread-json-show", "--json"], (program) =>
      registerThreadCommands(program, () => "http://daemon"),
    );

    expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toEqual(
      thread,
    );
  });

  it("bb thread update sets the parent thread id", async () => {
    const thread: Thread = {
      id: "thread-update-1",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "idle",
      parentThreadId: "thread-manager-1",
      createdAt: 1,
      updatedAt: 1,
    };
    const patch = vi.fn(async () => thread);
    createClientMock.mockReturnValue(asDaemonClient({
      api: {
        v1: {
          threads: {
            ":id": {
              $patch: patch,
            },
          },
        },
      },
    }));

    await runCommand(
      ["thread", "update", "thread-update-1", "--parent-thread", "thread-manager-1"],
      (program) => registerThreadCommands(program, () => "http://daemon"),
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
    process.env.BB_THREAD_ID = "thread-update-2";
    const thread: Thread = {
      id: "thread-update-2",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    };
    const patch = vi.fn(async () => thread);
    createClientMock.mockReturnValue(asDaemonClient({
      api: {
        v1: {
          threads: {
            ":id": {
              $patch: patch,
            },
          },
        },
      },
    }));

    await runCommand(["thread", "update", "--clear-parent-thread"], (program) =>
      registerThreadCommands(program, () => "http://daemon"),
    );

    expect(patch).toHaveBeenCalledWith({
      param: { id: "thread-update-2" },
      json: { parentThreadId: null },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "No managing parent thread",
    );
  });

  it("bb thread sessions --json prints raw session inspection data", async () => {
    const payload = {
      threadId: "thread-sessions",
      sessions: [
        {
          id: "sess-1",
          threadId: "thread-sessions",
          agentId: "agent-1",
          agentInstanceId: "instance-1",
          protocolVersion: 1,
          status: "active",
          leaseExpiresAt: 10,
          lastHeartbeatAt: 9,
          controlBaseUrl: "http://127.0.0.1:7777",
          createdAt: 1,
          updatedAt: 9,
        },
      ],
    };
    unwrapMock.mockImplementation(async (responsePromise: Promise<unknown>) => {
      const response = await responsePromise as Response;
      return response.json();
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await runCommand(["thread", "sessions", "thread-sessions", "--json"], (program) =>
      registerThreadCommands(program, () => "http://daemon"),
    );

    expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toEqual(
      payload,
    );
  });

  it("bb thread tell --json prints the raw response plus thread id", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    createClientMock.mockReturnValue(asDaemonClient({
      api: {
        v1: {
          threads: {
            ":id": {
              tell: {
                $post: post,
              },
            },
          },
        },
      },
    }));

    await runCommand(
      ["thread", "tell", "thread-json-tell", "hello", "--json"],
      (program) => registerThreadCommands(program, () => "http://daemon"),
    );

    expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toEqual({
      threadId: "thread-json-tell",
      ok: true,
    });
  });

  it("bb thread wait --status succeeds when the thread is already at the requested status", async () => {
    const get = vi.fn(async () => ({
      id: "thread-wait",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    } satisfies Thread));
    createClientMock.mockReturnValue(asDaemonClient({
      api: {
        v1: {
          threads: {
            ":id": {
              $get: get,
            },
          },
        },
      },
    }));

    await runCommand(["thread", "wait", "thread-wait", "--status", "idle"], (program) =>
      registerThreadCommands(program, () => "http://daemon"),
    );

    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-wait reached status idle.",
    );
  });

  it("bb thread wait --status exits with timeout code when the status is not reached", async () => {
    const get = vi.fn(async () => ({
      id: "thread-wait-timeout",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "active",
      createdAt: 1,
      updatedAt: 2,
    } satisfies Thread));
    createClientMock.mockReturnValue(asDaemonClient({
      api: {
        v1: {
          threads: {
            ":id": {
              $get: get,
            },
          },
        },
      },
    }));

    await expect(
      runCommand(
        ["thread", "wait", "thread-wait-timeout", "--status", "idle", "--timeout", "0"],
        (program) => registerThreadCommands(program, () => "http://daemon"),
      ),
    ).rejects.toThrow("process.exit:2");
  });

  it("bb thread status --json prints thread and filtered recent events", async () => {
    const thread: Thread = {
      id: "thread-json-status",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "active",
      createdAt: 1,
      updatedAt: 2,
    };
    const events = [
      {
        id: "evt-1",
        threadId: "thread-json-status",
        type: "turn.started",
        data: { ok: true },
        createdAt: 10,
        sequence: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-json-status",
        type: "system.error",
        data: { code: "provider_unavailable" },
        createdAt: 20,
        sequence: 2,
      },
    ];
    const get = vi.fn(async () => thread);
    const getEvents = vi.fn(async () => events);
    createClientMock.mockReturnValue(asDaemonClient({
      api: {
        v1: {
          threads: {
            ":id": {
              $get: get,
              events: {
                $get: getEvents,
              },
            },
          },
        },
      },
    }));

    await runCommand(
      ["thread", "status", "thread-json-status", "--recent-events", "5", "--json"],
      (program) => registerThreadCommands(program, () => "http://daemon"),
    );

    expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toEqual(
      {
        thread,
        recentEvents: {
          requestedCount: 5,
          eventMode: "summary",
          includeLowSignal: false,
          events: [events[1]],
        },
      },
    );
  });

  it("bb thread log --json prints raw events", async () => {
    const events = [
      {
        id: "evt-1",
        threadId: "thread-json-log",
        type: "system.error",
        data: { code: "provider_unavailable" },
        createdAt: 20,
        sequence: 2,
      },
    ];
    const getEvents = vi.fn(async () => events);
    createClientMock.mockReturnValue(asDaemonClient({
      api: {
        v1: {
          threads: {
            ":id": {
              events: {
                $get: getEvents,
              },
            },
          },
        },
      },
    }));

    await runCommand(["thread", "log", "thread-json-log", "--json"], (program) =>
      registerThreadCommands(program, () => "http://daemon"),
    );

    expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toEqual(
      events,
    );
  });

  it("bb thread output --json prints the raw output payload", async () => {
    const getOutput = vi.fn(async () => ({ output: "FINAL" }));
    createClientMock.mockReturnValue(asDaemonClient({
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
    }));

    await runCommand(
      ["thread", "output", "thread-json-output", "--json"],
      (program) => registerThreadCommands(program, () => "http://daemon"),
    );

    expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toEqual({
      output: "FINAL",
    });
  });
});

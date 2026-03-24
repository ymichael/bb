import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import type { Thread } from "@bb/domain";

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
import { registerServerCommands } from "../commands/server.js";
import { registerProjectCommands } from "../commands/project.js";
import { registerStatusCommand } from "../commands/status.js";
import { registerThreadCommands } from "../commands/thread.js";

type ServerClient = ReturnType<typeof createClient>;

function makeThread(overrides: Partial<Thread> & { id: string; projectId: string; providerId: string }): Thread {
  return {
    type: "standard",
    status: "idle",
    title: null,
    mergeBaseBranch: null,
    environmentId: null,
    parentThreadId: null,
    archivedAt: null,
    lastReadAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function asServerClient(value: unknown): ServerClient {
  return value as ServerClient;
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
    delete process.env.BB_ENVIRONMENT;
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
    createClientMock.mockReturnValue(asServerClient({
      api: {
        v1: {
          projects: {
            $get: get,
          },
        },
      },
    }));

    await runCommand(["project", "list", "--json"], (program) =>
      registerProjectCommands(program, () => "http://server"),
    );

    expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toEqual(
      projects,
    );
  });

  it("bb project create --json prints the created project", async () => {
    const created = {
      id: "proj-created",
      name: "Alpha",
      createdAt: 1,
      updatedAt: 2,
    };
    const post = vi.fn(async () => created);
    createClientMock.mockReturnValue(asServerClient({
      api: {
        v1: {
          projects: {
            $post: post,
          },
        },
      },
    }));

    await runCommand(
      ["project", "create", "--name", "Alpha", "--root", "/tmp/alpha", "--host", "host-1", "--json"],
      (program) => registerProjectCommands(program, () => "http://server"),
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
    createClientMock.mockReturnValue(asServerClient({
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
    }));

    await runCommand(["manager", "hire", "project-123"], (program) =>
      registerManagerCommands(program, () => "http://server"),
    );

    expect(post).toHaveBeenCalledWith({
      param: { id: "project-123" },
      json: {},
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain("Manager hired: thread-manager-1");
  });

  it("bb manager list reports when no managers are hired", async () => {
    const list = vi.fn(async () => []);
    createClientMock.mockReturnValue(asServerClient({
      api: {
        v1: {
          threads: {
            $get: list,
          },
        },
      },
    }));

    await runCommand(["manager", "list", "project-123"], (program) =>
      registerManagerCommands(program, () => "http://server"),
    );

    expect(list).toHaveBeenCalledWith({
      query: { projectId: "project-123", type: "manager" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain("No managers hired");
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
    const list = vi.fn(async ({ query }: { query: { parentThreadId?: string } }) => {
      expect(query.parentThreadId).toBe("thread-manager-1");
      return [managedThread];
    });
    createClientMock.mockReturnValue(asServerClient({
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
    createClientMock.mockReturnValue(asServerClient({
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
    }));

    await runCommand(
      ["manager", "delete", "thread-manager-1", "--yes"],
      (program) => registerManagerCommands(program, () => "http://server"),
    );

    expect(deleteFn).toHaveBeenCalledWith({
      param: { id: "thread-manager-1" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Manager thread-manager-1 deleted",
    );
  });

  it("bb status prints project/thread context", async () => {
    process.env.BB_PROJECT_ID = "proj-1";
    process.env.BB_THREAD_ID = "thread-1";

    await runCommand(["status"], (program) =>
      registerStatusCommand(program, () => "http://server"),
    );

    const lines = collectLogLines(vi.mocked(console.log));
    expect(lines).toContain("Project: proj-1");
    expect(lines).toContain("Thread: thread-1");
  });

  it("bb thread spawn sends project and prompt", async () => {
    process.env.BB_PROJECT_ID = "proj-1";
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
    createClientMock.mockReturnValue(asServerClient({
      api: {
        v1: {
          threads: {
            $post: post,
          },
        },
      },
    }));

    await runCommand(["thread", "spawn", "--prompt", "hello"], (program) =>
      registerThreadCommands(program, () => "http://server"),
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
    createClientMock.mockReturnValue(asServerClient({
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
      (program) => registerThreadCommands(program, () => "http://server"),
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
    createClientMock.mockReturnValue(asServerClient({
      api: {
        v1: {
          threads: {
            $post: post,
          },
        },
      },
    }));

    await runCommand(["thread", "spawn", "--json"], (program) =>
      registerThreadCommands(program, () => "http://server"),
    );

    expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toEqual(
      thread,
    );
  });

  it("bb thread spawn with --parent-thread forwards parent thread id", async () => {
    process.env.BB_PROJECT_ID = "proj-1";
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
    createClientMock.mockReturnValue(asServerClient({
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
      (program) => registerThreadCommands(program, () => "http://server"),
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
    createClientMock.mockReturnValue(asServerClient({
      api: {
        v1: {
          threads: {
            $post: post,
          },
        },
      },
    }));

    await runCommand(["thread", "spawn", "--environment", "env-worktree-001"], (program) =>
      registerThreadCommands(program, () => "http://server"),
    );

    expect(post).toHaveBeenCalledWith({
      json: {
        projectId: "proj-1",
        input: undefined,
        environmentId: "env-worktree-001",
      },
    });
  });

  it("bb thread spawn forwards --new-environment", async () => {
    process.env.BB_PROJECT_ID = "proj-1";
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
    createClientMock.mockReturnValue(asServerClient({
      api: {
        v1: {
          threads: {
            $post: post,
          },
        },
      },
    }));

    await runCommand(
      ["thread", "spawn", "--new-environment", "worktree"],
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(post).toHaveBeenCalledWith({
      json: {
        projectId: "proj-1",
        input: undefined,
        environmentCreationArgs: {
          kind: "worktree",
        },
      },
    });
  });

  it("bb thread spawn does not read BB_ENVIRONMENT", async () => {
    process.env.BB_PROJECT_ID = "proj-1";
    process.env.BB_ENVIRONMENT = "/tmp/project-root";
    const thread: Thread = makeThread({
      id: "thread-env-2",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "created",
      environmentId: "env-local-001",
      createdAt: 1,
      updatedAt: 1,
    });
    const post = vi.fn(async () => thread);
    createClientMock.mockReturnValue(asServerClient({
      api: {
        v1: {
          threads: {
            $post: post,
          },
        },
      },
    }));

    await runCommand(["thread", "spawn"], (program) =>
      registerThreadCommands(program, () => "http://server"),
    );

    expect(post).toHaveBeenCalledWith({
      json: {
        projectId: "proj-1",
        input: undefined,
      },
    });
  });

  it("bb thread archive sends the thread id from args", async () => {
    const archivePost = vi.fn(async () => ({ ok: true }));
    createClientMock.mockReturnValue(asServerClient({
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
    }));

    await runCommand(["thread", "archive", "thread-archive-1"], (program) =>
      registerThreadCommands(program, () => "http://server"),
    );

    expect(archivePost).toHaveBeenCalledWith({
      param: { id: "thread-archive-1" },
      json: {},
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-archive-1 archived",
    );
  });

  it("bb thread archive --self resolves from BB_THREAD_ID and forwards --force", async () => {
    process.env.BB_THREAD_ID = "thread-archive-2";
    const archivePost = vi.fn(async () => ({ ok: true }));
    createClientMock.mockReturnValue(asServerClient({
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
    }));

    await runCommand(["thread", "archive", "--self", "--force"], (program) =>
      registerThreadCommands(program, () => "http://server"),
    );

    expect(archivePost).toHaveBeenCalledWith({
      param: { id: "thread-archive-2" },
      json: { force: true },
    });
  });

  it("bb thread unarchive --self resolves from BB_THREAD_ID", async () => {
    process.env.BB_THREAD_ID = "thread-unarchive-1";
    const unarchivePost = vi.fn(async () => ({ ok: true }));
    createClientMock.mockReturnValue(asServerClient({
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
    createClientMock.mockReturnValue(asServerClient({
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
    }));
    readlineState.question.mockResolvedValue("yes");

    await runCommand(["thread", "delete", "thread-delete-1"], (program) =>
      registerThreadCommands(program, () => "http://server"),
    );

    expect(get).toHaveBeenCalledWith({
      param: { id: "thread-delete-1" },
    });
    expect(deleteFn).toHaveBeenCalledWith({
      param: { id: "thread-delete-1" },
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
    createClientMock.mockReturnValue(asServerClient({
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
    }));
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
    createClientMock.mockReturnValue(asServerClient({
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
    }));

    await runCommand(["thread", "delete", "thread-delete-3", "--yes"], (program) =>
      registerThreadCommands(program, () => "http://server"),
    );

    expect(readlineState.question).not.toHaveBeenCalled();
    expect(deleteFn).toHaveBeenCalledWith({
      param: { id: "thread-delete-3" },
    });
  });

  it("bb server restart requests server shutdown", async () => {
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
    createClientMock.mockReturnValue(asServerClient({
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

    await runCommand(["server", "restart"], (program) =>
      registerServerCommands(program, () => "http://server"),
    );

    expect(shutdownPost).toHaveBeenCalledWith({
      json: {},
    });
    const lines = collectLogLines(vi.mocked(console.log));
    expect(lines).toContain("Server shutdown requested.");
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
    createClientMock.mockReturnValue(asServerClient({
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
      registerThreadCommands(program, () => "http://server"),
    );

    expect(get).toHaveBeenCalledWith({
      param: { id: "thread-archived-1" },
    });
    const lines = collectLogLines(vi.mocked(console.log));
    expect(lines.some((line) => line.includes("Archived:"))).toBe(true);
  });

  it("bb server restart exits when shutdown is blocked by active work", async () => {
    const shutdownPost = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: "shutdown_blocked",
          message: "Server shutdown blocked by active thread work",
          blockingThreads: [
            { id: "thread-1", status: "active", projectId: "proj-1" },
          ],
        }),
        {
          status: 409,
          headers: { "Content-Type": "application/json" },
        },
      ));
    vi.mocked(createClient).mockReturnValue(asServerClient({
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
      runCommand(["server", "restart"], (program) =>
        registerServerCommands(program, () => "http://server"),
      ),
    ).rejects.toThrow("process.exit:1");

    const errorLines = collectLogLines(vi.mocked(console.error));
    expect(errorLines).toContain("Server shutdown blocked by active thread work");
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
    createClientMock.mockReturnValue(asServerClient({
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
      registerThreadCommands(program, () => "http://server"),
    );

    expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toEqual(
      { thread },
    );
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
    const patch = vi.fn(async () => thread);
    createClientMock.mockReturnValue(asServerClient({
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
    process.env.BB_THREAD_ID = "thread-update-2";
    const thread: Thread = makeThread({
      id: "thread-update-2",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    });
    const patch = vi.fn(async () => thread);
    createClientMock.mockReturnValue(asServerClient({
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

    await runCommand(["thread", "update", "--self", "--clear-parent-thread"], (program) =>
      registerThreadCommands(program, () => "http://server"),
    );

    expect(patch).toHaveBeenCalledWith({
      param: { id: "thread-update-2" },
      json: { parentThreadId: null },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "No managing parent thread",
    );
  });

  it("bb thread tell --json prints the raw response plus thread id", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    createClientMock.mockReturnValue(asServerClient({
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
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toEqual({
      threadId: "thread-json-tell",
      ok: true,
    });
  });

  it("bb thread wait --status succeeds when the thread is already at the requested status", async () => {
    const get = vi.fn(async () => makeThread({
      id: "thread-wait",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    }));
    createClientMock.mockReturnValue(asServerClient({
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
      registerThreadCommands(program, () => "http://server"),
    );

    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-wait reached status idle.",
    );
  });

  it("bb thread wait --status exits with timeout code when the status is not reached", async () => {
    const get = vi.fn(async () => makeThread({
      id: "thread-wait-timeout",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "active",
      createdAt: 1,
      updatedAt: 2,
    }));
    createClientMock.mockReturnValue(asServerClient({
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
        (program) => registerThreadCommands(program, () => "http://server"),
      ),
    ).rejects.toThrow("process.exit:2");
  });

  it("bb thread wait --status idle fails fast when the thread is stuck in error", async () => {
    const get = vi.fn(async () => makeThread({
      id: "thread-wait-error",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "error",
      createdAt: 1,
      updatedAt: 2,
    }));
    createClientMock.mockReturnValue(asServerClient({
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
        ["thread", "wait", "thread-wait-error", "--status", "idle"],
        (program) => registerThreadCommands(program, () => "http://server"),
      ),
    ).rejects.toThrow("process.exit:4");

    expect(collectLogLines(vi.mocked(console.error))).toContain(
      "Error: Thread thread-wait-error is in status error and will not reach idle by waiting alone. Inspect it with 'bb thread show thread-wait-error' and recover by sending a follow-up.",
    );
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("bb thread stop exits early when the thread is already idle", async () => {
    const get = vi.fn(async () => makeThread({
      id: "thread-stop-idle",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    }));
    const stopPost = vi.fn();
    createClientMock.mockReturnValue(asServerClient({
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
    }));

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
    const get = vi.fn(async () => makeThread({
      id: "thread-stop-error",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "error",
      createdAt: 1,
      updatedAt: 2,
    }));
    const stopPost = vi.fn();
    createClientMock.mockReturnValue(asServerClient({
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
    }));

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
    const get = vi.fn(async () => makeThread({
      id: "thread-stop-active",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "active",
      createdAt: 1,
      updatedAt: 2,
    }));
    const stopPost = vi.fn(async () => ({ ok: true }));
    createClientMock.mockReturnValue(asServerClient({
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
    }));

    await runCommand(["thread", "stop", "thread-stop-active"], (program) =>
      registerThreadCommands(program, () => "http://server"),
    );

    expect(collectLogLines(vi.mocked(console.log))).toContain("Thread thread-stop-active stopped");
    expect(stopPost).toHaveBeenCalledTimes(1);
  });

  it("bb thread show --json with --recent-events prints thread and filtered recent events", async () => {
    const thread: Thread = makeThread({
      id: "thread-json-status",
      projectId: "proj-1",
      providerId: "codex",
      type: "standard",
      status: "active",
      createdAt: 1,
      updatedAt: 2,
    });
    const events = [
      {
        id: "evt-1",
        threadId: "thread-json-status",
        type: "turn/started",
        data: { ok: true },
        createdAt: 10,
        sequence: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-json-status",
        type: "system/error",
        data: { code: "provider_unavailable" },
        createdAt: 20,
        sequence: 2,
      },
    ];
    const get = vi.fn(async () => thread);
    const getEvents = vi.fn(async () => events);
    createClientMock.mockReturnValue(asServerClient({
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
      ["thread", "show", "thread-json-status", "--recent-events", "5", "--json"],
      (program) => registerThreadCommands(program, () => "http://server"),
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
    createClientMock.mockReturnValue(asServerClient({
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
    }));

    await runCommand(["thread", "log", "thread-json-log", "--json"], (program) =>
      registerThreadCommands(program, () => "http://server"),
    );

    expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toEqual(
      events,
    );
  });

  it("bb thread log renders merged timeline rows for human output", async () => {
    const getEvents = vi.fn(async () => []);
    const getTimeline = vi.fn(async () => ({
      rows: [
        {
          kind: "message",
          id: "msg-1",
          message: {
            kind: "user",
            id: "user-1",
            threadId: "thread-log",
            sourceSeqStart: 1,
            sourceSeqEnd: 1,
            createdAt: 1,
            startedAt: 1,
            text: "Say hello",
          },
        },
        {
          kind: "message",
          id: "msg-2",
          message: {
            kind: "operation",
            id: "op-1",
            threadId: "thread-log",
            sourceSeqStart: 2,
            sourceSeqEnd: 8,
            createdAt: 8,
            startedAt: 2,
            opType: "provisioning",
            title: "Provisioning ready",
            status: "completed",
          },
        },
        {
          kind: "message",
          id: "msg-3",
          message: {
            kind: "assistant-text",
            id: "assistant-1",
            threadId: "thread-log",
            sourceSeqStart: 9,
            sourceSeqEnd: 9,
            createdAt: 9,
            startedAt: 9,
            text: "Hello!",
            status: "completed",
          },
        },
      ],
    }));
    createClientMock.mockReturnValue(asServerClient({
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
    }));

    await runCommand(["thread", "log", "thread-log"], (program) =>
      registerThreadCommands(program, () => "http://server"),
    );

    const output = String(vi.mocked(console.log).mock.calls[0]?.[0]);
    expect(output).toContain("Provisioning ready");
    expect(output).not.toContain("Provisioning interrupted");
  });

  it("bb thread output --json prints the raw output payload", async () => {
    const getOutput = vi.fn(async () => ({ output: "FINAL" }));
    createClientMock.mockReturnValue(asServerClient({
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
      (program) => registerThreadCommands(program, () => "http://server"),
    );

    expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toEqual({
      output: "FINAL",
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import type { Thread } from "@beanbag/agent-core";

vi.mock("../client.js", () => {
  return {
    createClient: vi.fn(),
    unwrap: vi.fn(async (responsePromise: Promise<unknown>) => {
      return responsePromise;
    }),
  };
});

import { createClient, unwrap } from "../client.js";
import { registerDaemonCommands } from "../commands/daemon.js";
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

    createClientMock.mockReset();
    unwrapMock.mockReset();
    unwrapMock.mockImplementation(async (responsePromise: Promise<unknown>) => {
      return responsePromise;
    });

    delete process.env.BB_PROJECT_ID;
    delete process.env.BB_THREAD_ID;
    delete process.env.BEANBAG_ENVIRONMENT;
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("bb thread spawn with --parent-thread forwards parent thread id", async () => {
    process.env.BB_PROJECT_ID = "proj-1";
    const thread: Thread = {
      id: "thread-2",
      projectId: "proj-1",
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

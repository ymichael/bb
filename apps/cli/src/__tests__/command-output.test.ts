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
import { registerStatusCommand } from "../commands/status.js";
import { registerThreadCommands } from "../commands/thread.js";

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
    createClientMock.mockReturnValue({
      api: {
        v1: {
          threads: {
            $post: post,
          },
        },
      },
    } as any);

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
    createClientMock.mockReturnValue({
      api: {
        v1: {
          threads: {
            $post: post,
          },
        },
      },
    } as any);

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
});

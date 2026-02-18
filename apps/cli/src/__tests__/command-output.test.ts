import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import type { Task, TaskEvent, Thread, ThreadEvent } from "@beanbag/core";

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
import { registerTaskCommands } from "../commands/task.js";
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
    delete process.env.BB_TASK_ID;
    delete process.env.BB_THREAD_ID;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("bb status prints context and task title+description when task context is set", async () => {
    process.env.BB_PROJECT_ID = "proj-1";
    process.env.BB_TASK_ID = "task-1";
    process.env.BB_THREAD_ID = "thread-1";

    const task: Task = {
      id: "task-1",
      projectId: "proj-1",
      title: "Implement search",
      description: "Add fuzzy file search endpoint",
      status: "in_progress",
      createdAt: 1,
      updatedAt: 2,
    };

    const taskGet = vi.fn(async () => task);
    createClientMock.mockReturnValue({
      api: {
        v1: {
          tasks: {
            ":id": {
              $get: taskGet,
            },
          },
        },
      },
    } as any);

    await runCommand(["status"], (program) =>
      registerStatusCommand(program, () => "http://daemon"),
    );

    const lines = collectLogLines(vi.mocked(console.log));
    expect(lines).toContain("Project: proj-1");
    expect(lines).toContain("Task: task-1");
    expect(lines).toContain("Thread: thread-1");
    expect(lines).toContain("Task Title: Implement search");
    expect(lines).toContain("Task Description: Add fuzzy file search endpoint");
    expect(taskGet).toHaveBeenCalledWith({ param: { id: "task-1" } });
  });

  it("bb status prints unavailable title+description together when enrichment fails", async () => {
    process.env.BB_TASK_ID = "task-1";

    const taskGet = vi.fn(async () => {
      throw new Error("lookup failed");
    });
    createClientMock.mockReturnValue({
      api: {
        v1: {
          tasks: {
            ":id": {
              $get: taskGet,
            },
          },
        },
      },
    } as any);

    await runCommand(["status"], (program) =>
      registerStatusCommand(program, () => "http://daemon"),
    );

    const lines = collectLogLines(vi.mocked(console.log));
    expect(lines).toContain("Task Title: <unavailable>");
    expect(lines).toContain("Task Description: <unavailable>");
  });

  it("bb task status is concise by default and does not fetch events", async () => {
    process.env.BB_TASK_ID = "task-1";
    const task: Task = {
      id: "task-1",
      projectId: "proj-1",
      title: "Implement search",
      description: "Add fuzzy file search endpoint",
      status: "in_progress",
      createdAt: 1,
      updatedAt: 2,
      assignee: "agent/generic",
    };
    const taskGet = vi.fn(async () => task);
    const taskEventsGet = vi.fn(async (): Promise<TaskEvent[]> => []);
    createClientMock.mockReturnValue({
      api: {
        v1: {
          tasks: {
            ":id": {
              $get: taskGet,
              events: {
                $get: taskEventsGet,
              },
            },
          },
        },
      },
    } as any);

    await runCommand(["task", "status"], (program) =>
      registerTaskCommands(program, () => "http://daemon"),
    );

    const lines = collectLogLines(vi.mocked(console.log));
    expect(lines).toContain("Task task-1");
    expect(lines).toContain("Status in_progress (assignee: agent/generic)");
    expect(lines).toContain("Description Add fuzzy file search endpoint");
    expect(lines).not.toContain("Recent events:");
    expect(taskEventsGet).not.toHaveBeenCalled();
  });

  it("bb task status supports opt-in recent events with summary mode", async () => {
    process.env.BB_TASK_ID = "task-1";
    const task: Task = {
      id: "task-1",
      projectId: "proj-1",
      title: "Implement search",
      status: "in_progress",
      createdAt: 1,
      updatedAt: 2,
    };
    const events: TaskEvent[] = [
      {
        id: "evt-1",
        taskId: "task-1",
        seq: 1,
        type: "task.updated.title",
        data: { title: "Implement search API" },
        createdAt: 1_000,
      },
      {
        id: "evt-2",
        taskId: "task-1",
        seq: 2,
        type: "task.updated.status",
        data: { status: "blocked" },
        createdAt: 2_000,
      },
    ];
    const taskGet = vi.fn(async () => task);
    const taskEventsGet = vi.fn(async () => events);
    createClientMock.mockReturnValue({
      api: {
        v1: {
          tasks: {
            ":id": {
              $get: taskGet,
              events: {
                $get: taskEventsGet,
              },
            },
          },
        },
      },
    } as any);

    await runCommand(["task", "status", "--recent-events", "2"], (program) =>
      registerTaskCommands(program, () => "http://daemon"),
    );

    const lines = collectLogLines(vi.mocked(console.log));
    expect(lines).toContain("Recent events:");
    expect(lines.some((line) => line.includes("task.updated.title"))).toBe(true);
    expect(lines.some((line) => line.includes("task.updated.status"))).toBe(true);
    expect(taskEventsGet).toHaveBeenCalledTimes(1);
  });

  it("bb thread status is concise by default and does not fetch events", async () => {
    process.env.BB_THREAD_ID = "thread-1";
    const thread: Thread = {
      id: "thread-1",
      projectId: "proj-1",
      status: "active",
      createdAt: 1,
      updatedAt: 2,
      taskId: "task-1",
      agentRoleId: "agent/generic",
    };
    const threadGet = vi.fn(async () => thread);
    const threadEventsGet = vi.fn(async (): Promise<ThreadEvent[]> => []);
    createClientMock.mockReturnValue({
      api: {
        v1: {
          threads: {
            ":id": {
              $get: threadGet,
              events: {
                $get: threadEventsGet,
              },
            },
          },
        },
      },
    } as any);

    await runCommand(["thread", "status"], (program) =>
      registerThreadCommands(program, () => "http://daemon"),
    );

    const lines = collectLogLines(vi.mocked(console.log));
    expect(lines).toContain("Thread thread-1");
    expect(lines).toContain("Status active (task: task-1)");
    expect(lines).toContain("Role agent/generic");
    expect(lines).not.toContain("Recent events:");
    expect(threadEventsGet).not.toHaveBeenCalled();
  });

  it("bb thread status filters low-signal events unless include-low-signal is set", async () => {
    process.env.BB_THREAD_ID = "thread-1";
    const thread: Thread = {
      id: "thread-1",
      projectId: "proj-1",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    };
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "turn/started",
        data: {} as any,
        createdAt: 1_000,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {} as any,
        createdAt: 2_000,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "thread/tokenUsage/updated",
        data: {} as any,
        createdAt: 3_000,
      },
    ];
    const threadGet = vi.fn(async () => thread);
    const threadEventsGet = vi.fn(async () => events);
    createClientMock.mockReturnValue({
      api: {
        v1: {
          threads: {
            ":id": {
              $get: threadGet,
              events: {
                $get: threadEventsGet,
              },
            },
          },
        },
      },
    } as any);

    await runCommand(["thread", "status", "--recent-events", "5"], (program) =>
      registerThreadCommands(program, () => "http://daemon"),
    );
    let lines = collectLogLines(vi.mocked(console.log));
    expect(lines.some((line) => line.includes("item/completed"))).toBe(true);
    expect(lines.some((line) => line.includes("turn/started"))).toBe(false);
    expect(lines.some((line) => line.includes("thread/tokenUsage/updated"))).toBe(false);

    vi.mocked(console.log).mockClear();

    await runCommand(
      ["thread", "status", "--recent-events", "5", "--include-low-signal"],
      (program) => registerThreadCommands(program, () => "http://daemon"),
    );
    lines = collectLogLines(vi.mocked(console.log));
    expect(lines.some((line) => line.includes("turn/started"))).toBe(true);
  });

  it("bb task show falls back to BB_TASK_ID when id is omitted", async () => {
    process.env.BB_TASK_ID = "task-42";
    const task: Task = {
      id: "task-42",
      projectId: "proj-1",
      title: "Implement search",
      description: "Add fuzzy file search endpoint",
      status: "open",
      createdAt: 1,
      updatedAt: 2,
    };
    const taskGet = vi.fn(async () => task);
    createClientMock.mockReturnValue({
      api: {
        v1: {
          tasks: {
            ":id": {
              $get: taskGet,
            },
          },
        },
      },
    } as any);

    await runCommand(["task", "show"], (program) =>
      registerTaskCommands(program, () => "http://daemon"),
    );

    expect(taskGet).toHaveBeenCalledWith({ param: { id: "task-42" } });
  });

  it("bb thread show falls back to BB_THREAD_ID when id is omitted", async () => {
    process.env.BB_THREAD_ID = "thread-42";
    const thread: Thread = {
      id: "thread-42",
      projectId: "proj-1",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    };
    const threadGet = vi.fn(async () => thread);
    createClientMock.mockReturnValue({
      api: {
        v1: {
          threads: {
            ":id": {
              $get: threadGet,
            },
          },
        },
      },
    } as any);

    await runCommand(["thread", "show"], (program) =>
      registerThreadCommands(program, () => "http://daemon"),
    );

    expect(threadGet).toHaveBeenCalledWith({ param: { id: "thread-42" } });
  });

  it("bb thread spawn errors when --task-role is provided without task context", async () => {
    createClientMock.mockReturnValue({
      api: { v1: { threads: { $post: vi.fn() } } },
    } as any);

    await expect(
      runCommand(
        ["thread", "spawn", "--project", "proj-1", "--task-role", "primary"],
        (program) => registerThreadCommands(program, () => "http://daemon"),
      ),
    ).rejects.toThrow("process.exit:1");

    const errorCalls = vi.mocked(console.error).mock.calls.map((args) => args.join(" "));
    expect(
      errorCalls.some((line) =>
        line.includes("--task-role requires task context"),
      ),
    ).toBe(true);
  });
});

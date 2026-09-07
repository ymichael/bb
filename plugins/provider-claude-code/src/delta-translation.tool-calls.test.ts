import { describe, expect, it } from "vitest";
import {
  ITEM_ID_PATTERN,
  createClaudeDeltaHarness,
} from "./delta-test-harness.js";

describe("claude tool-use translation (delta path)", () => {
  it("emits item/started for tool use blocks", () => {
    const harness = createClaudeDeltaHarness();
    harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Let me check" }],
      },
      session_id: "sess-1",
    });

    const events = harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: { command: "ls" },
          },
        ],
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "commandExecution",
          id: harness.itemId("tool-1"),
          status: "pending",
        }),
      }),
    );
    expect(harness.itemId("tool-1")).toMatch(ITEM_ID_PATTERN);
  });

  it("falls back to a generic tool call when Bash args are malformed", () => {
    const harness = createClaudeDeltaHarness();
    harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Let me check" }],
      },
      session_id: "sess-1",
    });

    const events = harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: { command: 42 },
          },
        ],
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "toolCall",
          id: harness.itemId("tool-1"),
          tool: "Bash",
          status: "pending",
        }),
      }),
    );
  });

  it("maps WebSearch and WebFetch tool uses into web items", () => {
    const harness = createClaudeDeltaHarness();

    const events = harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-search-1",
            name: "WebSearch",
            input: { query: "react suspense" },
          },
          {
            type: "tool_use",
            id: "tool-fetch-1",
            name: "WebFetch",
            input: { url: "https://example.com" },
          },
        ],
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "webSearch",
          id: harness.itemId("tool-search-1"),
          queries: ["react suspense"],
          resultText: null,
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "webFetch",
          id: harness.itemId("tool-fetch-1"),
          url: "https://example.com",
          prompt: null,
          pattern: null,
          resultText: null,
        }),
      }),
    );
  });

  it("preserves completed WebSearch result text", () => {
    const harness = createClaudeDeltaHarness();

    harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-search-1",
            name: "WebSearch",
            input: { query: "react suspense" },
          },
        ],
      },
      session_id: "sess-1",
    });

    const events = harness.translate({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-search-1",
            content: "Found the Suspense docs",
            is_error: false,
          },
        ],
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "webSearch",
          id: harness.itemId("tool-search-1"),
          queries: ["react suspense"],
          resultText: "Found the Suspense docs",
        }),
      }),
    );
  });

  it("preserves completed WebFetch result text and prompt", () => {
    const harness = createClaudeDeltaHarness();

    harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-fetch-1",
            name: "WebFetch",
            input: {
              url: "https://example.com",
              prompt: "page title",
            },
          },
        ],
      },
      session_id: "sess-1",
    });

    const events = harness.translate({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-fetch-1",
            content: "Example Domain",
            is_error: false,
          },
        ],
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "webFetch",
          id: harness.itemId("tool-fetch-1"),
          url: "https://example.com",
          prompt: "page title",
          pattern: null,
          resultText: "Example Domain",
        }),
      }),
    );
  });

  it("emits fileChange items with diffs for Edit tool uses", () => {
    const harness = createClaudeDeltaHarness();

    harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Let me patch that" }],
      },
      session_id: "sess-1",
    });

    const events = harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-edit-1",
            name: "Edit",
            input: {
              file_path: "src/app.ts",
              old_string: "const answer = 1;",
              new_string: "const answer = 2;",
            },
          },
        ],
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "fileChange",
          id: harness.itemId("tool-edit-1"),
          status: "pending",
          changes: [
            expect.objectContaining({
              path: "src/app.ts",
              diff: expect.stringContaining("const answer = 2;"),
            }),
          ],
        }),
      }),
    );
  });

  it("marks content-only Write tool uses as add changes", () => {
    const harness = createClaudeDeltaHarness();

    const events = harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-write-1",
            name: "Write",
            input: {
              path: "src/app.ts",
              content: "console.log('updated');\n",
            },
          },
        ],
      },
      session_id: "sess-1",
    });

    const started = events.find(
      (
        event,
      ): event is Extract<(typeof events)[number], { type: "item/started" }> =>
        event.type === "item/started",
    );
    expect(started?.item).toMatchObject({
      type: "fileChange",
      id: harness.itemId("tool-write-1"),
      status: "pending",
      changes: [
        {
          path: "src/app.ts",
          kind: "add",
        },
      ],
    });
    if (!started || started.item.type !== "fileChange") return;
    expect(started.item.changes[0]?.diff).toContain("+++ b/src/app.ts");
  });

  it("preserves structured Agent arguments on tool calls", () => {
    const harness = createClaudeDeltaHarness();

    harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Let me delegate that" }],
      },
      session_id: "sess-1",
    });

    const events = harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-agent-1",
            name: "Agent",
            input: {
              subagent_type: "Explore",
              description: "Inspect the docs tree",
              prompt: "List every markdown file",
            },
          },
        ],
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: {
          type: "delegation",
          id: harness.itemId("tool-agent-1"),
          childRef: "tool-agent-1",
          label: "Inspect the docs tree",
          status: "pending",
          background: false,
          presentation: {
            label: {
              pending: "Running subagent",
              completed: "Subagent finished",
            },
            icon: { glyph: "UserRound" },
            title: "Inspect the docs tree",
            detail: "Explore agent",
          },
        },
      }),
    );
  });

  it("closes a delegation with the child's summary, without Claude's agent metadata", () => {
    const harness = createClaudeDeltaHarness();
    harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-agent-2",
            name: "Agent",
            input: {
              subagent_type: "Explore",
              description: "Find the entry point",
              prompt: "Where does the server start?",
              model: "haiku",
            },
          },
        ],
      },
      session_id: "sess-1",
    });
    const events = harness.translate({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-agent-2",
            content: [
              {
                type: "text",
                text: "The server starts in apps/server/src/index.ts.\nagentId: abc123 (internal)\n<usage>total_tokens: 12</usage>",
              },
            ],
          },
        ],
      },
      session_id: "sess-1",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: {
          type: "delegation",
          id: harness.itemId("tool-agent-2"),
          childRef: "tool-agent-2",
          label: "Find the entry point",
          status: "completed",
          background: false,
          summary: "The server starts in apps/server/src/index.ts.",
          presentation: expect.objectContaining({
            title: "Find the entry point",
            detail: "Explore agent · model haiku",
          }),
        },
      }),
    );
  });

  it("marks a backgrounded Agent call as a background delegation that settles at the launch ack", () => {
    const harness = createClaudeDeltaHarness();
    harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-agent-bg",
            name: "Agent",
            input: {
              subagent_type: "general-purpose",
              description: "Survey the build",
              prompt: "Map the build pipeline",
              run_in_background: true,
            },
          },
        ],
      },
      session_id: "sess-1",
    });
    const events = harness.translate({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-agent-bg",
            content:
              "Async agent launched successfully.\nagentId: a1 (internal)",
          },
        ],
      },
      session_id: "sess-1",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/delegation/completed",
        scope: { kind: "thread" },
        item: expect.objectContaining({
          type: "delegation",
          id: harness.itemId("tool-agent-bg"),
          background: true,
          status: "completed",
          summary: "Async agent launched successfully.",
          presentation: expect.objectContaining({
            label: {
              pending: "Launching subagent",
              completed: "Launched subagent",
            },
          }),
        }),
      }),
    );
  });

  it("maps Read, Grep, and Glob to fileRead and search items with presentation", () => {
    const harness = createClaudeDeltaHarness();

    harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Let me inspect the repo" }],
      },
      session_id: "sess-1",
    });

    const events = harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-read-1",
            name: "Read",
            input: { file_path: "src/index.ts" },
          },
          {
            type: "tool_use",
            id: "tool-grep-1",
            name: "Grep",
            input: { pattern: "TODO", path: "src" },
          },
          {
            type: "tool_use",
            id: "tool-glob-1",
            name: "Glob",
            input: { pattern: "**/*.ts", path: "src" },
          },
        ],
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: {
          type: "fileRead",
          id: harness.itemId("tool-read-1"),
          path: "src/index.ts",
          status: "pending",
          presentation: {
            label: { pending: "Reading file", completed: "Read file" },
            icon: { glyph: "FileText" },
            title: "index.ts",
          },
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: {
          type: "search",
          id: harness.itemId("tool-grep-1"),
          mode: "content",
          query: "TODO",
          path: "src",
          status: "pending",
          presentation: {
            label: { pending: "Searching files", completed: "Searched files" },
            icon: { glyph: "Search" },
            title: "TODO",
          },
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: {
          type: "search",
          id: harness.itemId("tool-glob-1"),
          mode: "path",
          query: "**/*.ts",
          path: "src",
          status: "pending",
          presentation: {
            label: { pending: "Finding files", completed: "Found files" },
            icon: { glyph: "FolderOpen" },
            title: "**/*.ts",
          },
        },
      }),
    );

    const closed = harness.translate({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-read-1",
            content: "1\texport const x = 1;",
          },
          {
            type: "tool_result",
            tool_use_id: "tool-grep-1",
            content: "src/a.ts:3:// TODO",
          },
        ],
      },
      session_id: "sess-1",
    });
    expect(closed).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: {
          type: "fileRead",
          id: harness.itemId("tool-read-1"),
          path: "src/index.ts",
          status: "completed",
          presentation: expect.objectContaining({ title: "index.ts" }),
        },
      }),
    );
    expect(closed).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "search",
          id: harness.itemId("tool-grep-1"),
          status: "completed",
        }),
      }),
    );
  });

  it("falls back to generic tool calls for malformed structured args", () => {
    const harness = createClaudeDeltaHarness();

    harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Let me inspect that" }],
      },
      session_id: "sess-1",
    });

    const events = harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-read-bad-1",
            name: "Read",
            input: "not-an-object",
          },
        ],
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "toolCall",
          id: harness.itemId("tool-read-bad-1"),
          tool: "Read",
          status: "pending",
        }),
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          id: harness.itemId("tool-read-bad-1"),
          arguments: expect.anything(),
        }),
      }),
    );
  });

  it("preserves parent_tool_use_id on nested sdk/message events", () => {
    const harness = createClaudeDeltaHarness();

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        message: {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-1",
                name: "Bash",
                input: { command: "ls" },
              },
            ],
          },
          parent_tool_use_id: "agent-parent-1",
          session_id: "sess-1",
        },
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "commandExecution",
          id: harness.itemId("tool-1"),
          parentToolCallId: harness.itemId("agent-parent-1"),
        }),
      }),
    );
    expect(harness.itemId("agent-parent-1")).not.toBe("agent-parent-1");
  });
});

describe("claude tool-result translation (delta path)", () => {
  it("emits item/completed for user tool results", () => {
    const harness = createClaudeDeltaHarness();
    harness.translate({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "x" }] },
      session_id: "sess-1",
    });

    const events = harness.translate({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            tool_name: "Bash",
            content: "output text",
          },
        ],
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "commandExecution",
          id: harness.itemId("tool-1"),
          status: "completed",
        }),
      }),
    );
  });

  it("closes a task-list call with its text result and folds the structured result into the plan", () => {
    const harness = createClaudeDeltaHarness();

    harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "task-create-1",
            name: "TaskCreate",
            input: {
              subject: "Add task support",
              description: "Track Claude Task tools",
              activeForm: "Adding task support",
            },
          },
        ],
      },
      session_id: "sess-1",
    });

    const events = harness.translate({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "task-create-1",
            content: "Task #task-1 created successfully: Add task support",
          },
        ],
      },
      session_id: "sess-1",
      tool_use_result: {
        task: { id: "task-1", subject: "Add task support" },
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "toolCall",
          id: harness.itemId("task-create-1"),
          tool: "TaskCreate",
          result: "Task #task-1 created successfully: Add task support",
          status: "completed",
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "planSteps",
          steps: [{ step: "Add task support", status: "pending" }],
        }),
      }),
    );
  });

  it("folds a task-list result carried as JSON text when the envelope has none", () => {
    const harness = createClaudeDeltaHarness();
    harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "task-list-1",
            name: "TaskList",
            input: {},
          },
        ],
      },
      session_id: "sess-1",
    });
    const events = harness.translate({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "task-list-1",
            content: JSON.stringify({
              tasks: [{ id: "1", subject: "Review", status: "in_progress" }],
            }),
          },
        ],
      },
      session_id: "sess-1",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "planSteps",
          steps: [{ step: "Review", status: "active" }],
        }),
      }),
    );
  });

  it("marks Bash tool results with is_error as failed", () => {
    const harness = createClaudeDeltaHarness();

    harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: { command: "npm test", cwd: "/repo" },
          },
        ],
      },
      session_id: "sess-1",
    });

    const events = harness.translate({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            tool_name: "Bash",
            content: "command failed",
            is_error: true,
          },
        ],
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "commandExecution",
          id: harness.itemId("tool-1"),
          command: "npm test",
          cwd: "/repo",
          aggregatedOutput: "command failed",
          exitCode: 1,
          status: "failed",
        }),
      }),
    );
  });

  it("prefers Claude stdout/stderr over placeholder Bash content", () => {
    const harness = createClaudeDeltaHarness();

    harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: { command: "printf hi", cwd: "/repo" },
          },
        ],
      },
      session_id: "sess-1",
    });

    const events = harness.translate({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            tool_name: "Bash",
            content: "(Bash completed with no output)",
            tool_use_result: {
              stdout: "hi\n",
              stderr: "",
            },
          },
        ],
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "commandExecution",
          id: harness.itemId("tool-1"),
          command: "printf hi",
          cwd: "/repo",
          aggregatedOutput: "hi\n",
          status: "completed",
        }),
      }),
    );
  });

  it("strips Claude no-output placeholders when stdout/stderr are empty", () => {
    const harness = createClaudeDeltaHarness();

    harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: { command: "true", cwd: "/repo" },
          },
        ],
      },
      session_id: "sess-1",
    });

    const events = harness.translate({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            tool_name: "Bash",
            content: "(Bash completed with no output)",
            tool_use_result: {
              stdout: "",
              stderr: "",
            },
          },
        ],
      },
      session_id: "sess-1",
    });

    const completedEvent = events.find(
      (
        event,
      ): event is Extract<
        (typeof events)[number],
        { type: "item/completed" }
      > => event.type === "item/completed",
    );

    expect(completedEvent?.item).toMatchObject({
      type: "commandExecution",
      id: harness.itemId("tool-1"),
      command: "true",
      cwd: "/repo",
      status: "completed",
      exitCode: 0,
    });
    if (completedEvent?.item.type !== "commandExecution") {
      throw new Error("Expected commandExecution completion");
    }
    expect(completedEvent.item.aggregatedOutput).toBeUndefined();
  });

  it("inserts a newline between Claude stdout and stderr", () => {
    const harness = createClaudeDeltaHarness();

    harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: { command: "printf hi; printf warn >&2", cwd: "/repo" },
          },
        ],
      },
      session_id: "sess-1",
    });

    const events = harness.translate({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            tool_name: "Bash",
            content: "(Bash completed with no output)",
            tool_use_result: {
              stdout: "hi",
              stderr: "warn\n",
            },
          },
        ],
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "commandExecution",
          id: harness.itemId("tool-1"),
          aggregatedOutput: "hi\nwarn\n",
          status: "completed",
        }),
      }),
    );
  });

  it("falls back to Claude content when tool_use_result streams are empty", () => {
    const harness = createClaudeDeltaHarness();

    harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: { command: "cat output.txt", cwd: "/repo" },
          },
        ],
      },
      session_id: "sess-1",
    });

    const events = harness.translate({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            tool_name: "Bash",
            content: "file output\n",
            tool_use_result: {},
          },
        ],
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "commandExecution",
          id: harness.itemId("tool-1"),
          command: "cat output.txt",
          cwd: "/repo",
          aggregatedOutput: "file output\n",
          status: "completed",
        }),
      }),
    );
  });

  it("preserves string tool_use_result errors for Bash completions", () => {
    const harness = createClaudeDeltaHarness();

    harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: { command: "grep '(' file.txt", cwd: "/repo" },
          },
        ],
      },
      session_id: "sess-1",
    });

    const events = harness.translate({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            tool_name: "Bash",
            content: "(Bash completed with no output)",
            is_error: true,
            tool_use_result:
              "Error: Exit code 2\ngrep: parentheses not balanced",
          },
        ],
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "commandExecution",
          id: harness.itemId("tool-1"),
          command: "grep '(' file.txt",
          cwd: "/repo",
          aggregatedOutput:
            "Error: Exit code 2\ngrep: parentheses not balanced",
          exitCode: 1,
          status: "failed",
        }),
      }),
    );
  });

  it("recovers missing tool names from prior tool uses", () => {
    const harness = createClaudeDeltaHarness();

    harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Edit",
            input: { file_path: "notes/todo.txt" },
          },
        ],
      },
      session_id: "sess-1",
    });

    const events = harness.translate({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "updated",
          },
        ],
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "fileChange",
          id: harness.itemId("tool-1"),
          status: "completed",
        }),
      }),
    );
  });

  it("surfaces late tool results without turn context as unhandled", () => {
    const harness = createClaudeDeltaHarness();

    harness.translate(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "npm test", cwd: "/repo" },
            },
          ],
        },
        session_id: "sess-1",
      },
      { threadId: "thread-1" },
    );

    harness.translate(
      {
        type: "result",
        subtype: "end_turn",
        session_id: "sess-1",
      },
      { threadId: "thread-1" },
    );

    const events = harness.translate(
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              tool_name: "Bash",
              content: "late output",
            },
          ],
        },
        session_id: "sess-1",
      },
      { threadId: "thread-1" },
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider/unhandled",
        rawType: "sdk/user:tool_result",
        scope: { kind: "thread" },
      }),
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  LEGACY_CODEX_GOAL_EXTENSION_KIND,
  convertLegacyStoredThreadEvent,
  isLegacyDelegationToolCall,
  isLegacyThreadEventType,
  upgradeLegacyToolItem,
} from "../src/legacy-thread-events.js";
import {
  parseStoredThreadEvent,
  parseThreadEventRow,
} from "../src/stored-thread-event.js";
import { threadScope, turnScope } from "../src/thread-event-scope.js";
import { threadEventSchema } from "../src/provider-event.js";

describe("legacy thread event conversion", () => {
  it("reads a persisted thread/goal/updated row as the codex goal state", () => {
    const event = parseStoredThreadEvent({
      type: "thread/goal/updated",
      threadId: "thread-1",
      providerThreadId: "provider-1",
      scope: threadScope(),
      data: {
        objective: "Ship the release",
        status: "budgetLimited",
        tokenBudget: 50_000,
        tokensUsed: 49_000,
        timeUsedSeconds: 1_200,
      },
    });
    expect(event).toEqual({
      type: "thread/extensionState/updated",
      threadId: "thread-1",
      providerThreadId: "provider-1",
      scope: threadScope(),
      kind: LEGACY_CODEX_GOAL_EXTENSION_KIND,
      payload: {
        objective: "Ship the release",
        status: "budgetLimited",
        tokenBudget: 50_000,
        tokensUsed: 49_000,
        timeUsedSeconds: 1_200,
      },
    });
  });

  it("reads a persisted thread/goal/cleared row as a null goal state", () => {
    const row = parseThreadEventRow({
      id: "evt-2",
      type: "thread/goal/cleared",
      threadId: "thread-1",
      seq: 2,
      scope: threadScope(),
      data: { providerThreadId: "provider-1" },
      createdAt: 2,
    });
    expect(row.type).toBe("thread/extensionState/updated");
    expect(row.data).toEqual({
      providerThreadId: "provider-1",
      kind: LEGACY_CODEX_GOAL_EXTENSION_KIND,
      payload: null,
    });
  });

  it("still rejects a malformed legacy goal row", () => {
    expect(() =>
      parseStoredThreadEvent({
        type: "thread/goal/updated",
        threadId: "thread-1",
        providerThreadId: "provider-1",
        scope: threadScope(),
        data: { objective: 42 },
      }),
    ).toThrow();
  });

  it("reads a persisted system/permissionGrant/lifecycle row as the one interaction lifecycle", () => {
    const subject = {
      kind: "permission_grant",
      itemId: "item_1",
      toolName: "WebFetch",
      permissions: { network: { enabled: true }, fileSystem: null },
    };
    const converted = convertLegacyStoredThreadEvent({
      type: "system/permissionGrant/lifecycle",
      data: {
        interactionId: "pint_1",
        providerId: "claude-code",
        providerRequestId: "req_1",
        status: "resolved",
        resolution: { decision: "allow_for_session", grantedPermissions: null },
        subject,
      },
    });
    expect(converted).toEqual({
      type: "system/interaction/lifecycle",
      data: {
        interaction: {
          id: "pint_1",
          status: "resolved",
          statusReason: null,
          origin: {
            kind: "provider",
            providerId: "claude-code",
            providerRequestId: "req_1",
          },
          payload: { kind: "approval", subject, reason: null },
          resolution: {
            decision: "allow_for_session",
            grantedPermissions: null,
          },
        },
      },
    });
    expect(
      threadEventSchema.safeParse({
        ...converted.data,
        type: converted.type,
        threadId: "thr_1",
        scope: turnScope("turn_1"),
      }).success,
    ).toBe(true);
  });

  it("reads a persisted system/userQuestion/lifecycle row as the one interaction lifecycle", () => {
    const payload = {
      kind: "user_question",
      questions: [
        {
          id: "q1",
          prompt: "Which target?",
          multiSelect: false,
          options: [{ value: "staging", label: "Staging" }],
          allowFreeText: false,
        },
      ],
    };
    const converted = convertLegacyStoredThreadEvent({
      type: "system/userQuestion/lifecycle",
      data: {
        interactionId: "pint_2",
        providerId: "codex",
        providerRequestId: "req_2",
        status: "pending",
        statusReason: null,
        payload,
      },
    });
    expect(converted.type).toBe("system/interaction/lifecycle");
    const parsed = threadEventSchema.parse({
      ...converted.data,
      type: converted.type,
      threadId: "thr_1",
      scope: turnScope("turn_1"),
    });
    expect(
      parsed.type === "system/interaction/lifecycle" && parsed.interaction,
    ).toEqual({
      id: "pint_2",
      status: "pending",
      statusReason: null,
      origin: {
        kind: "provider",
        providerId: "codex",
        providerRequestId: "req_2",
      },
      payload,
      resolution: null,
    });
  });

  it("passes every other type through untouched", () => {
    const stored = {
      type: "thread/name/updated" as const,
      data: { name: "A thread", providerThreadId: "provider-1" },
    };
    expect(convertLegacyStoredThreadEvent(stored)).toBe(stored);
    expect(isLegacyThreadEventType("thread/goal/updated")).toBe(true);
    expect(isLegacyThreadEventType("thread/extensionState/updated")).toBe(
      false,
    );
  });
});

describe("legacy tool-item adapter", () => {
  const presented = {
    label: { pending: "Reading", completed: "Read" },
    icon: { glyph: "FileText" },
  };

  function toolItem(
    tool: string,
    args: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) {
    return {
      type: "toolCall",
      id: `call-${tool}`,
      tool,
      arguments: args,
      status: "completed",
      ...extra,
    };
  }

  it("is never consulted for an item that carries a presentation, whatever its name", () => {
    for (const [tool, args] of [
      ["Read", { file_path: "/repo/a.ts" }],
      ["Grep", { pattern: "todo", path: "/repo" }],
      ["Glob", { pattern: "**/*.ts" }],
      ["TodoWrite", { todos: [] }],
      ["ToolSearch", { query: "fetch" }],
      ["AskUserQuestion", { questions: [] }],
      ["Agent", { description: "x" }],
    ] as const) {
      const item = toolItem(tool, args, {
        presentation: presented,
        result: "agentId: 1\nreal output",
      });
      expect(upgradeLegacyToolItem(item)).toBe(item);
    }
    for (const providerThreadId of ["claude-1", "codex-1", "acp-1", "pi-1"]) {
      const event = parseStoredThreadEvent({
        type: "item/completed",
        threadId: "thread-1",
        providerThreadId,
        scope: turnScope("turn-1"),
        data: {
          item: toolItem(
            "Read",
            { file_path: "/repo/a.ts" },
            { presentation: presented },
          ),
        },
      });
      expect(event.type === "item/completed" && event.item.type).toBe(
        "toolCall",
      );
    }
  });

  it("upgrades presentation-less Read / Grep / Glob calls to fileRead / search items", () => {
    expect(
      upgradeLegacyToolItem(toolItem("Read", { file_path: "/repo/a.ts" })),
    ).toEqual({
      type: "fileRead",
      id: "call-Read",
      status: "completed",
      path: "/repo/a.ts",
      cmd: "Read { file_path: /repo/a.ts }",
    });
    expect(
      upgradeLegacyToolItem(
        toolItem(
          "Grep",
          { pattern: "todo", path: "/repo" },
          { parentToolCallId: "agent-1" },
        ),
      ),
    ).toEqual({
      type: "search",
      id: "call-Grep",
      status: "completed",
      parentToolCallId: "agent-1",
      mode: "content",
      query: "todo",
      path: "/repo",
      cmd: "Grep { pattern: todo, path: /repo }",
    });
    expect(
      upgradeLegacyToolItem(toolItem("Glob", { pattern: "**/*.ts" })),
    ).toMatchObject({
      type: "search",
      mode: "path",
      query: "**/*.ts",
    });
    expect(
      upgradeLegacyToolItem(toolItem("read", { path: "/repo/b.ts" })),
    ).toMatchObject({
      type: "fileRead",
      path: "/repo/b.ts",
    });
    expect(
      upgradeLegacyToolItem(toolItem("ls", { path: "/repo/src" })),
    ).toMatchObject({
      type: "search",
      mode: "list",
      path: "/repo/src",
    });
    expect(
      upgradeLegacyToolItem(toolItem("fs:Read", { path: "/repo/c.ts" })),
    ).toMatchObject({
      type: "fileRead",
      cmd: "fs:Read { path: /repo/c.ts }",
    });
    const pathless = toolItem("Read", { offset: 3 });
    expect(upgradeLegacyToolItem(pathless)).toBe(pathless);
  });

  it("collapses the bookkeeping tools only while pending or completed", () => {
    const pending = toolItem(
      "ToolSearch",
      { query: "fetch" },
      { status: "pending" },
    );
    expect(upgradeLegacyToolItem(pending)).toEqual({
      ...pending,
      presentation: {
        label: { pending: "Running ToolSearch", completed: "Ran ToolSearch" },
        icon: { glyph: "Toolbox" },
        suppress: true,
      },
    });
    for (const tool of [
      "TodoWrite",
      "TodoRead",
      "TaskCreate",
      "TaskUpdate",
      "AskUserQuestion",
    ]) {
      expect(upgradeLegacyToolItem(toolItem(tool, {}))).toMatchObject({
        presentation: { suppress: true },
      });
    }
    for (const status of ["failed", "interrupted"]) {
      const item = toolItem("AskUserQuestion", {}, { status });
      expect(upgradeLegacyToolItem(item)).toBe(item);
    }
  });

  it("strips harness metadata lines from an Agent result", () => {
    const item = toolItem(
      "Agent",
      { description: "Review" },
      {
        result: "agentId: abc\n<usage>tokens</usage>\nFound 3 issues.  \nDone.",
      },
    );
    expect(upgradeLegacyToolItem(item)).toEqual({
      ...item,
      result: "Found 3 issues.\nDone.",
    });
    const clean = toolItem("Agent", {}, { result: "Done." });
    expect(upgradeLegacyToolItem(clean)).toBe(clean);
    const structured = toolItem("Agent", {}, { result: { ok: true } });
    expect(upgradeLegacyToolItem(structured)).toBe(structured);
  });

  it("classifies a presentation-less call by the pre-change delegation name set", () => {
    for (const tool of [
      "Agent",
      "Task",
      "spawnAgent",
      "resumeAgent",
      "bb:spawnAgent",
    ]) {
      expect(isLegacyDelegationToolCall({ tool }), tool).toBe(true);
    }
    for (const tool of [
      "TaskCreate",
      "TaskOutput",
      "agent",
      "Bash",
      "spawn_helper",
    ]) {
      expect(isLegacyDelegationToolCall({ tool }), tool).toBe(false);
    }
    expect(
      isLegacyDelegationToolCall({ tool: "Agent", presentation: presented }),
    ).toBe(false);
  });

  it("runs at read time for item/started and item/completed rows and nothing else", () => {
    const started = parseStoredThreadEvent({
      type: "item/started",
      threadId: "thread-1",
      providerThreadId: "provider-1",
      scope: turnScope("turn-1"),
      data: {
        item: toolItem(
          "Read",
          { file_path: "/repo/a.ts" },
          { status: "pending" },
        ),
      },
    });
    expect(started.type === "item/started" && started.item).toEqual({
      type: "fileRead",
      id: "call-Read",
      status: "pending",
      path: "/repo/a.ts",
      cmd: "Read { file_path: /repo/a.ts }",
    });
    const stored = {
      type: "item/completed" as const,
      data: {
        providerThreadId: "provider-1",
        item: toolItem("Bash", { command: "ls" }),
      },
    };
    expect(convertLegacyStoredThreadEvent(stored)).toBe(stored);
  });
});

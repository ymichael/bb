import { describe, expect, it } from "vitest";
import type { ServerNotification as CodexServerNotification } from "./generated/codex-app-server/schema/ServerNotification.js";
import {
  collabAgentPresentation,
  commandPresentation,
  fileChangePresentation,
  mcpToolPresentation,
} from "./presentation.js";
import { createCodexEventTranslator } from "./translator.js";

describe("codex presentation", () => {
  it("unwraps the shell wrapper codex adds around every command", () => {
    expect(
      commandPresentation("/bin/bash -lc \"sed -n '1,200p' math.js\""),
    ).toEqual({
      label: { pending: "Running command", completed: "Ran command" },
      icon: { glyph: "Terminal" },
      title: "sed -n '1,200p' math.js",
    });
    expect(commandPresentation("zsh -c 'ls -la'").title).toBe("ls -la");
    expect(commandPresentation("cargo test").title).toBe("cargo test");
  });

  it("drops the headline of a blank command", () => {
    expect(commandPresentation("   ").title).toBeUndefined();
  });

  it("pluralizes file edits and names the files, not their directories", () => {
    expect(fileChangePresentation(["/repo/src/a.ts"])).toEqual({
      label: { pending: "Editing file", completed: "Edited file" },
      icon: { glyph: "EditFile" },
      title: "a.ts",
    });
    expect(
      fileChangePresentation([
        "/repo/src/a.ts",
        "/repo/src/b.ts",
        "/repo/src/a.ts",
      ]),
    ).toEqual({
      label: { pending: "Editing files", completed: "Edited files" },
      icon: { glyph: "EditFile" },
      title: "a.ts, b.ts",
    });
    expect(fileChangePresentation([]).title).toBeUndefined();
  });

  it("presents the bundled node REPL by its human title and other MCP tools by name", () => {
    expect(
      mcpToolPresentation({
        server: "node_repl",
        tool: "js",
        args: { title: "Inspect Discord Bugs tab", code: "1+1" },
      }),
    ).toEqual({
      label: { pending: "Running JavaScript", completed: "Ran JavaScript" },
      icon: { glyph: "Code" },
      title: "Inspect Discord Bugs tab",
    });
    expect(
      mcpToolPresentation({
        server: "node_repl",
        tool: "js",
        args: { code: "1" },
      }).title,
    ).toBeUndefined();
    expect(
      mcpToolPresentation({ server: "node_repl", tool: "js_reset", args: {} })
        .label.completed,
    ).toBe("Reset JavaScript session");
    expect(
      mcpToolPresentation({
        server: "codex_apps",
        tool: "github.search_issues",
        args: {},
      }),
    ).toEqual({
      label: {
        pending: "Running github.search_issues",
        completed: "Ran github.search_issues",
      },
      icon: { glyph: "Toolbox" },
      title: "codex_apps",
    });
  });

  it("labels each collab verb and headlines the prompt", () => {
    expect(collabAgentPresentation({ tool: "wait", prompt: null })).toEqual({
      label: { pending: "Waiting for agents", completed: "Waited for agents" },
      icon: { glyph: "UserRound" },
    });
    expect(
      collabAgentPresentation({
        tool: "spawnAgent",
        prompt: "Review the PR\nin depth",
      }),
    ).toEqual({
      label: { pending: "Spawning agent", completed: "Spawned agent" },
      icon: { glyph: "UserRound" },
      title: "Review the PR",
    });
    expect(
      collabAgentPresentation({ tool: "futureVerb", prompt: null }).label,
    ).toEqual({
      pending: "Running futureVerb",
      completed: "Ran futureVerb",
    });
  });
});

describe("every codex lifecycle delta carries a presentation", () => {
  const items: Array<
    CodexServerNotification["params"] & { item: { type: string } }
  > = [
    {
      threadId: "t1",
      turnId: "turn-1",
      startedAtMs: 0,
      item: {
        type: "agentMessage",
        id: "m1",
        text: "hi",
        phase: null,
        memoryCitation: null,
        delivery: null,
      },
    },
    {
      threadId: "t1",
      turnId: "turn-1",
      startedAtMs: 0,
      item: {
        type: "commandExecution",
        id: "c1",
        command: "/bin/bash -lc ls",
        cwd: "/tmp",
        processId: null,
        source: "agent",
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
        pluginId: null,
        scriptPath: null,
      },
    },
    {
      threadId: "t1",
      turnId: "turn-1",
      startedAtMs: 0,
      item: {
        type: "fileChange",
        id: "f1",
        changes: [{ path: "/tmp/a.ts", kind: { type: "add" }, diff: "+a" }],
        status: "inProgress",
      },
    },
    {
      threadId: "t1",
      turnId: "turn-1",
      startedAtMs: 0,
      item: {
        type: "mcpToolCall",
        id: "t1",
        server: "codex_apps",
        tool: "github.fetch_pr",
        status: "inProgress",
        arguments: {},
        result: null,
        error: null,
        durationMs: null,
      },
    },
    {
      threadId: "t1",
      turnId: "turn-1",
      startedAtMs: 0,
      item: {
        type: "dynamicToolCall",
        id: "d1",
        namespace: null,
        tool: "bb_workflow_run",
        arguments: {},
        status: "inProgress",
        contentItems: null,
        success: null,
        durationMs: null,
      },
    },
    {
      threadId: "t1",
      turnId: "turn-1",
      startedAtMs: 0,
      item: {
        type: "collabAgentToolCall",
        id: "w1",
        tool: "wait",
        status: "inProgress",
        senderThreadId: "t1",
        receiverThreadIds: [],
        prompt: null,
        model: null,
        reasoningEffort: null,
        agentsStates: {},
      },
    },
    {
      threadId: "t1",
      turnId: "turn-1",
      startedAtMs: 0,
      item: {
        type: "webSearch",
        id: "ws1",
        query: "bb",
        action: { type: "search", query: "bb", queries: null },
      },
    },
    {
      threadId: "t1",
      turnId: "turn-1",
      startedAtMs: 0,
      item: { type: "imageView", id: "i1", path: "/tmp/x.png" },
    },
    {
      threadId: "t1",
      turnId: "turn-1",
      startedAtMs: 0,
      item: { type: "reasoning", id: "r1", summary: ["s"], content: ["c"] },
    },
    {
      threadId: "t1",
      turnId: "turn-1",
      startedAtMs: 0,
      item: { type: "plan", id: "p1", text: "plan" },
    },
    {
      threadId: "t1",
      turnId: "turn-1",
      startedAtMs: 0,
      item: { type: "contextCompaction", id: "cc1" },
    },
    {
      threadId: "t1",
      turnId: "turn-1",
      startedAtMs: 0,
      item: {
        type: "subAgentActivity",
        id: "call_1",
        kind: "started",
        agentThreadId: "agent-1",
        agentPath: "/root/review",
      },
    },
  ];

  it.each(items.map((params) => [params.item.type, params] as const))(
    "%s",
    (_type, params) => {
      const translator = createCodexEventTranslator({
        additionalWorkspaceWriteRoots: [],
      });
      const lifecycle = [
        ...translator.translateEvent({
          jsonrpc: "2.0",
          method: "item/started",
          params,
        }),
        ...translator.translateEvent({
          jsonrpc: "2.0",
          method: "item/completed",
          params: { ...params, completedAtMs: 0 },
        }),
      ].filter(
        (delta) => delta.kind === "item.open" || delta.kind === "item.close",
      );
      expect(lifecycle.length).toBeGreaterThan(0);
      for (const delta of lifecycle) {
        expect(delta.presentation).toBeDefined();
        expect(delta.presentation?.label.pending.length).toBeGreaterThan(0);
        expect(delta.presentation?.label.completed.length).toBeGreaterThan(0);
        expect(delta.presentation?.icon.glyph.length).toBeGreaterThan(0);
      }
    },
  );
});

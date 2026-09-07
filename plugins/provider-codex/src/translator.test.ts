import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { turnScope, type ThreadEvent } from "@bb/domain";
import type { RuntimePermissionPolicy } from "@bb/domain";
import { experimental_createDeltaAssembler as createDeltaAssembler } from "@get-bb/plugin-sdk/provider-bridge/testing";
import type { DeltaAssembler } from "@get-bb/plugin-sdk/provider-bridge/testing";
import type { ServerNotification as CodexServerNotification } from "./generated/codex-app-server/schema/ServerNotification.js";
import type { Turn } from "./generated/codex-app-server/schema/v2/Turn.js";
import {
  createCodexEventTranslator,
  type CodexEventTranslator,
} from "./translator.js";

const THREAD_ID = "t-codex-translator";
const ENTROPY = "cxt-test";

function codexEvent<M extends CodexServerNotification["method"]>(
  method: M,
  params: Extract<CodexServerNotification, { method: M }>["params"],
) {
  return { jsonrpc: "2.0" as const, method, params };
}

function codexTurn(args: {
  id: string;
  status: Turn["status"];
  error: Turn["error"];
}): Turn {
  return {
    id: args.id,
    items: [],
    itemsView: "full",
    status: args.status,
    error: args.error,
    startedAt: 0,
    completedAt: null,
    durationMs: null,
  };
}

interface CodexTranslatorHarness {
  assembler: DeltaAssembler;
  translator: CodexEventTranslator;
  translate(
    event: Parameters<CodexEventTranslator["translateEvent"]>[0],
  ): ThreadEvent[];
  turnId(codexTurnId: string): string;
  itemId(codexItemId: string): string;
}

function createHarness(
  translator = createCodexEventTranslator({
    additionalWorkspaceWriteRoots: [],
  }),
): CodexTranslatorHarness {
  const assembler = createDeltaAssembler({
    providerId: "codex",
    entropyPrefix: ENTROPY,
    textDeltaFlushMs: 0,
  });
  return {
    assembler,
    translator,
    translate(event) {
      return assembler.assemble({
        threadId: THREAD_ID,
        deltas: translator.translateEvent(event),
      });
    },
    turnId(codexTurnId) {
      return assembler.getBbTurnId(THREAD_ID, codexTurnId) ?? "";
    },
    itemId(codexItemId) {
      return assembler.getBbItemId(THREAD_ID, codexItemId) ?? "";
    },
  };
}

function createTranslator() {
  return createCodexEventTranslator({ additionalWorkspaceWriteRoots: [] });
}

const WORKSPACE_ASK_OPTIONS = {
  permissionMode: "accept-edits",
  permissionScope: "workspace",
  approvalReviewer: "user",
  permissionEscalation: "ask",
} satisfies RuntimePermissionPolicy;

interface LinkedWorktreeFixture {
  cleanup(): void;
  expectedWritableRoots: string[];
  gitDir: string;
  rootPath: string;
  workspacePath: string;
}

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

function unlinkWorkspaceGitDir(fixture: LinkedWorktreeFixture): void {
  writeFileSync(path.join(fixture.workspacePath, ".git"), "gitdir: /\n");
}

function dedupeRoots(roots: readonly string[]): string[] {
  return [...new Set(roots)];
}

describe("codex workspace-write git-root staging", () => {
  it("hands staged roots to the thread only once the construction is accepted", () => {
    const fixture = createLinkedWorktreeFixture();
    const translator = createTranslator();
    try {
      const prepared = translator.prepareWorkspaceWriteGitRoots({
        command: {
          threadId: "bb-thread-1",
          cwd: fixture.workspacePath,
          options: WORKSPACE_ASK_OPTIONS,
        },
      });
      expect(prepared.config).toMatchObject({
        "sandbox_workspace_write.writable_roots": fixture.expectedWritableRoots,
      });

      expect(translator.getThreadGitWritableRoots("bb-thread-1")).toEqual([]);

      translator.activateThreadGitWritableRoots({
        providerThreadId: "codex-thread-1",
        threadId: "bb-thread-1",
      });
      unlinkWorkspaceGitDir(fixture);

      expect(translator.getThreadGitWritableRoots("bb-thread-1")).toEqual(
        fixture.expectedWritableRoots,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("merges the host's additional workspace roots into the construction config", () => {
    const fixture = createLinkedWorktreeFixture();
    const additionalWorkspaceWriteRoots = [
      path.join(fixture.rootPath, "host-extra-root"),
      fixture.gitDir,
    ];
    const translator = createCodexEventTranslator({
      additionalWorkspaceWriteRoots,
    });
    try {
      const prepared = translator.prepareWorkspaceWriteGitRoots({
        command: {
          threadId: "bb-thread-1",
          cwd: fixture.workspacePath,
          options: WORKSPACE_ASK_OPTIONS,
        },
      });
      expect(prepared.config).toMatchObject({
        "sandbox_workspace_write.writable_roots": dedupeRoots([
          ...additionalWorkspaceWriteRoots,
          ...fixture.expectedWritableRoots,
        ]),
      });

      translator.activateThreadGitWritableRoots({
        providerThreadId: "codex-thread-1",
        threadId: "bb-thread-1",
      });

      expect(translator.getThreadGitWritableRoots("bb-thread-1")).toEqual(
        fixture.expectedWritableRoots,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("binds each construction's roots to its own accepted provider thread id", () => {
    const firstFixture = createLinkedWorktreeFixture();
    const secondFixture = createLinkedWorktreeFixture();
    const translator = createTranslator();
    try {
      for (const [threadId, fixture] of [
        ["bb-thread-1", firstFixture],
        ["bb-thread-2", secondFixture],
      ] as const) {
        translator.prepareWorkspaceWriteGitRoots({
          command: {
            threadId,
            cwd: fixture.workspacePath,
            options: WORKSPACE_ASK_OPTIONS,
          },
        });
      }

      translator.activateThreadGitWritableRoots({
        providerThreadId: "codex-thread-2",
        threadId: "bb-thread-2",
      });
      translator.activateThreadGitWritableRoots({
        providerThreadId: "codex-thread-1",
        threadId: "bb-thread-1",
      });

      translator.translateEvent(
        codexEvent("thread/closed", { threadId: "codex-thread-1" }),
      );

      expect(translator.getThreadGitWritableRoots("bb-thread-1")).toEqual([]);
      expect(translator.getThreadGitWritableRoots("bb-thread-2")).toEqual(
        secondFixture.expectedWritableRoots,
      );
    } finally {
      firstFixture.cleanup();
      secondFixture.cleanup();
    }
  });
});

function rawShellCall(args: {
  callId: string;
  providerThreadId: string;
  toolName?: string;
  turnId: string;
}) {
  return codexEvent("rawResponseItem/completed", {
    threadId: args.providerThreadId,
    turnId: args.turnId,
    item: {
      type: "function_call",
      name: args.toolName ?? "exec_command",
      arguments: '{"cmd":"echo hi"}',
      call_id: args.callId,
    },
  });
}

function rawShellOutput(args: {
  callId: string;
  output: string;
  providerThreadId: string;
  turnId: string;
}) {
  return codexEvent("rawResponseItem/completed", {
    threadId: args.providerThreadId,
    turnId: args.turnId,
    item: {
      type: "function_call_output",
      call_id: args.callId,
      output: args.output,
    },
  });
}

function completedCommand(args: {
  aggregatedOutput: string;
  callId: string;
  providerThreadId: string;
  turnId: string;
}) {
  return codexEvent("item/completed", {
    threadId: args.providerThreadId,
    turnId: args.turnId,
    completedAtMs: 0,
    item: {
      type: "commandExecution",
      id: args.callId,
      command: "echo hi",
      cwd: "/tmp",
      processId: null,
      pluginId: null,
      scriptPath: null,
      source: "agent",
      status: "completed",
      commandActions: [],
      aggregatedOutput: args.aggregatedOutput,
      exitCode: 0,
      durationMs: 150,
    },
  });
}

function publishedCommandOutput(args: {
  providerAggregatedOutput: string;
  rawOutput: string;
  toolName?: string;
}): string | undefined {
  const harness = createHarness();
  const call = {
    callId: "cmd-1",
    providerThreadId: "t1",
    turnId: "turn-1",
    toolName: args.toolName,
  };
  harness.translate(rawShellCall(call));
  harness.translate(rawShellOutput({ ...call, output: args.rawOutput }));
  const events = harness.translate(
    completedCommand({
      ...call,
      aggregatedOutput: args.providerAggregatedOutput,
    }),
  );
  const completed = events.find(
    (event) =>
      event.type === "item/completed" &&
      event.item.type === "commandExecution" &&
      event.item.id === harness.itemId("cmd-1"),
  );
  if (completed?.type !== "item/completed") {
    throw new Error("Expected a completed commandExecution event");
  }
  if (completed.item.type !== "commandExecution") {
    throw new Error("Expected a commandExecution item");
  }
  return completed.item.aggregatedOutput;
}

const METADATA_WRAPPER_LINES = [
  "Chunk ID: abc123",
  "Wall time: 3.6 seconds",
  "Process exited with code 0",
  "Original token count: 8",
];

describe("codex raw shell command-output recovery", () => {
  it("repairs a completed command from a raw result that arrived first", () => {
    expect(
      publishedCommandOutput({
        providerAggregatedOutput: "OUT-2\nOUT-3\n",
        rawOutput: [
          ...METADATA_WRAPPER_LINES,
          "Output:",
          "OUT-1",
          "OUT-2",
          "OUT-3",
          "",
        ].join("\n"),
      }),
    ).toBe("OUT-1\nOUT-2\nOUT-3\n");
  });

  it("preserves a literal Output: line inside the recovered body", () => {
    expect(
      publishedCommandOutput({
        providerAggregatedOutput: "Output:\nsuffix\n",
        rawOutput: [
          ...METADATA_WRAPPER_LINES,
          "Output:",
          "prefix",
          "Output:",
          "suffix",
          "",
        ].join("\n"),
      }),
    ).toBe("prefix\nOutput:\nsuffix\n");
  });

  it("preserves a body whose first line looks like wrapper metadata", () => {
    expect(
      publishedCommandOutput({
        providerAggregatedOutput: "actual stdout\n",
        rawOutput: ["Chunk ID: abc", "actual stdout", ""].join("\n"),
      }),
    ).toBe("Chunk ID: abc\nactual stdout\n");
  });

  it("ignores a metadata wrapper with no Output marker", () => {
    expect(
      publishedCommandOutput({
        providerAggregatedOutput: "provider output\n",
        rawOutput: METADATA_WRAPPER_LINES.join("\n"),
      }),
    ).toBe("provider output\n");
  });

  it.each(["Bash", "bash"])(
    "repairs raw shell output for the %s alias",
    (toolName) => {
      expect(
        publishedCommandOutput({
          providerAggregatedOutput: "",
          rawOutput: "Output:\nOUT-1\n",
          toolName,
        }),
      ).toBe("OUT-1\n");
    },
  );

  it("repairs concurrent command executions independently", () => {
    const harness = createHarness();
    const commands = [
      { callId: "cmd-a", output: "A-1\nA-2\nA-3\n", truncated: "A-2\nA-3\n" },
      { callId: "cmd-b", output: "B-1\nB-2\nB-3\n", truncated: "B-2\nB-3\n" },
    ];

    for (const command of commands) {
      harness.translate(
        rawShellCall({
          callId: command.callId,
          providerThreadId: "t1",
          turnId: "turn-1",
        }),
      );
    }
    for (const command of commands) {
      harness.translate(
        rawShellOutput({
          callId: command.callId,
          output: `Output:\n${command.output}`,
          providerThreadId: "t1",
          turnId: "turn-1",
        }),
      );
    }

    for (const command of commands) {
      expect(
        harness.translate(
          completedCommand({
            aggregatedOutput: command.truncated,
            callId: command.callId,
            providerThreadId: "t1",
            turnId: "turn-1",
          }),
        ),
      ).toContainEqual(
        expect.objectContaining({
          type: "item/completed",
          scope: turnScope(harness.turnId("turn-1")),
          item: expect.objectContaining({
            type: "commandExecution",
            id: harness.itemId(command.callId),
            aggregatedOutput: command.output,
          }),
        }),
      );
    }
  });

  it("keeps a thread's captured output when a different thread completes a turn", () => {
    const harness = createHarness();
    for (const suffix of ["a", "b"]) {
      harness.translate(
        rawShellCall({
          callId: `cmd-${suffix}`,
          providerThreadId: `thread-${suffix}`,
          turnId: `turn-${suffix}`,
        }),
      );
      harness.translate(
        rawShellOutput({
          callId: `cmd-${suffix}`,
          output: `Output:\n${suffix.toUpperCase()}-1\n${suffix.toUpperCase()}-2\n`,
          providerThreadId: `thread-${suffix}`,
          turnId: `turn-${suffix}`,
        }),
      );
    }

    harness.translate(
      codexEvent("turn/completed", {
        threadId: "thread-a",
        turn: codexTurn({ id: "turn-a", status: "completed", error: null }),
      }),
    );

    expect(
      harness.translate(
        completedCommand({
          aggregatedOutput: "B-2\n",
          callId: "cmd-b",
          providerThreadId: "thread-b",
          turnId: "turn-b",
        }),
      ),
    ).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        scope: turnScope(harness.turnId("turn-b")),
        item: expect.objectContaining({
          type: "commandExecution",
          id: harness.itemId("cmd-b"),
          aggregatedOutput: "B-1\nB-2\n",
        }),
      }),
    );
  });

  it("drops recovered output state when the thread closes", () => {
    const harness = createHarness();
    harness.translate(
      rawShellCall({
        callId: "cmd-a",
        providerThreadId: "thread-a",
        turnId: "turn-a",
      }),
    );
    harness.translate(codexEvent("thread/closed", { threadId: "thread-a" }));
    harness.translate(
      rawShellOutput({
        callId: "cmd-a",
        output: "Output:\nSTALE\n",
        providerThreadId: "thread-a",
        turnId: "turn-a",
      }),
    );

    expect(
      harness.translate(
        completedCommand({
          aggregatedOutput: "provider output\n",
          callId: "cmd-a",
          providerThreadId: "thread-a",
          turnId: "turn-a",
        }),
      ),
    ).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        scope: turnScope(harness.turnId("turn-a")),
        item: expect.objectContaining({
          type: "commandExecution",
          id: harness.itemId("cmd-a"),
          aggregatedOutput: "provider output\n",
        }),
      }),
    );
  });
});

describe("codex command output capture across reordering", () => {
  const shellCall = {
    callId: "cmd-1",
    providerThreadId: "t1",
    turnId: "turn-1",
  };

  it("defers a completed command until the later raw shell result arrives", () => {
    const harness = createHarness();
    harness.translate(rawShellCall(shellCall));

    expect(
      harness.translate(
        completedCommand({ ...shellCall, aggregatedOutput: "OUT-2\nOUT-3\n" }),
      ),
    ).toEqual([]);

    expect(
      harness.translate(
        rawShellOutput({
          ...shellCall,
          output: "Output:\nOUT-1\nOUT-2\nOUT-3\n",
        }),
      ),
    ).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        scope: turnScope(harness.turnId("turn-1")),
        item: expect.objectContaining({
          type: "commandExecution",
          id: harness.itemId("cmd-1"),
          aggregatedOutput: "OUT-1\nOUT-2\nOUT-3\n",
        }),
      }),
    );
  });

  it("releases a deferred command before turn completion when no raw result arrives", () => {
    const harness = createHarness();
    harness.translate(rawShellCall(shellCall));
    expect(
      harness.translate(
        completedCommand({
          ...shellCall,
          aggregatedOutput: "provider output\n",
        }),
      ),
    ).toEqual([]);

    const completedEvents = harness.translate(
      codexEvent("turn/completed", {
        threadId: "t1",
        turn: codexTurn({ id: "turn-1", status: "completed", error: null }),
      }),
    );

    expect(completedEvents.map((event) => event.type)).toEqual([
      "item/completed",
      "turn/completed",
    ]);
    expect(completedEvents[0]).toMatchObject({
      item: {
        id: harness.itemId("cmd-1"),
        aggregatedOutput: "provider output\n",
      },
    });
  });
});

describe("codex subagent activity correlation", () => {
  const rootProviderThreadId = "root-provider-thread";

  function rawCollaborationCall(args: {
    callId: string;
    name: "followup_task" | "send_message";
  }) {
    return codexEvent("rawResponseItem/completed", {
      threadId: rootProviderThreadId,
      turnId: "parent-turn",
      item: {
        type: "function_call",
        name: args.name,
        arguments: '{"target":"/root/lifecycle_child"}',
        call_id: args.callId,
      },
    });
  }

  function subAgentActivity(args: {
    agentThreadId?: string;
    id: string;
    kind: "started" | "interacted" | "interrupted";
  }) {
    const agentThreadId = args.agentThreadId ?? "agent-thread-1";
    return {
      jsonrpc: "2.0" as const,
      method: "item/completed",
      params: {
        threadId: rootProviderThreadId,
        turnId: "parent-turn",
        item: {
          type: "subAgentActivity",
          id: args.id,
          kind: args.kind,
          agentThreadId,
          agentPath: "/root/lifecycle_child",
        },
      },
    };
  }

  function childTurnStarted(id: string, threadId = rootProviderThreadId) {
    return codexEvent("turn/started", {
      threadId,
      turn: codexTurn({ id, status: "inProgress", error: null }),
    });
  }

  function childTurnCompleted(id: string, threadId = rootProviderThreadId) {
    return codexEvent("turn/completed", {
      threadId,
      turn: codexTurn({ id, status: "completed", error: null }),
    });
  }

  it("opens a pending delegation at the spawn and settles it with the child turn", () => {
    const harness = createHarness();
    const opened = harness.translate(
      subAgentActivity({ id: "subagent-call-1", kind: "started" }),
    );
    expect(opened).toEqual([
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "delegation",
          status: "pending",
        }),
      }),
    ]);

    harness.translate(childTurnStarted("child-turn-1"));
    expect(
      harness
        .translate(childTurnCompleted("child-turn-1"))
        .map((event) => event.type),
    ).toEqual(["turn/completed", "item/completed"]);
  });

  it("materializes subagent activity as a nested delegation lifecycle", () => {
    const harness = createHarness();

    expect(
      harness.translate(
        subAgentActivity({ id: "subagent-call-1", kind: "started" }),
      ),
    ).toEqual([
      expect.objectContaining({
        type: "item/started",
        scope: turnScope(harness.turnId("parent-turn")),
        item: {
          type: "delegation",
          id: harness.itemId("subagent-call-1"),
          childRef: "agent-thread-1",
          label: "/root/lifecycle_child",
          status: "pending",
          background: false,
          presentation: {
            label: { pending: "Running agent", completed: "Agent finished" },
            icon: { glyph: "UserRound" },
            title: "/root/lifecycle_child",
          },
        },
      }),
    ]);

    expect(harness.translate(childTurnStarted("child-turn-1"))).toContainEqual(
      expect.objectContaining({
        type: "turn/started",
        scope: turnScope(harness.turnId("child-turn-1")),
        parentToolCallId: harness.itemId("subagent-call-1"),
      }),
    );

    expect(
      harness.translate(
        subAgentActivity({ id: "interaction-1", kind: "interacted" }),
      ),
    ).toEqual([]);

    expect(
      harness.translate(
        codexEvent("item/completed", {
          threadId: rootProviderThreadId,
          turnId: "child-turn-1",
          completedAtMs: 0,
          item: {
            type: "agentMessage",
            id: "child-message-1",
            text: "Audit complete.",
            phase: null,
            memoryCitation: null,
            delivery: null,
          },
        }),
      ),
    ).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          id: harness.itemId("child-message-1"),
          parentToolCallId: harness.itemId("subagent-call-1"),
        }),
      }),
    );

    expect(harness.translate(childTurnCompleted("child-turn-1"))).toEqual([
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(harness.turnId("child-turn-1")),
      }),
      expect.objectContaining({
        type: "item/completed",
        scope: turnScope(harness.turnId("parent-turn")),
        item: expect.objectContaining({
          type: "delegation",
          id: harness.itemId("subagent-call-1"),
          childRef: "agent-thread-1",
          status: "completed",
        }),
      }),
    ]);
  });

  it("re-arms the parent link when a completed subagent is interacted with again", () => {
    const harness = createHarness();
    harness.translate(
      subAgentActivity({ id: "subagent-call-1", kind: "started" }),
    );

    expect(harness.translate(childTurnStarted("child-turn-1"))).toContainEqual(
      expect.objectContaining({
        type: "turn/started",
        scope: turnScope(harness.turnId("child-turn-1")),
        parentToolCallId: harness.itemId("subagent-call-1"),
      }),
    );
    harness.translate(childTurnCompleted("child-turn-1"));

    expect(
      harness.translate(
        subAgentActivity({ id: "interaction-1", kind: "interacted" }),
      ),
    ).toEqual([]);

    expect(harness.translate(childTurnStarted("child-turn-2"))).toEqual([
      expect.objectContaining({
        type: "item/started",
        scope: turnScope(harness.turnId("parent-turn")),
        item: expect.objectContaining({
          type: "delegation",
          id: harness.itemId("subagent-call-1"),
          status: "pending",
        }),
      }),
      expect.objectContaining({
        type: "turn/started",
        scope: turnScope(harness.turnId("child-turn-2")),
        parentToolCallId: harness.itemId("subagent-call-1"),
      }),
    ]);

    const resumedTurnCompleted = harness.translate(
      childTurnCompleted("child-turn-2"),
    );
    expect(resumedTurnCompleted).toEqual([
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(harness.turnId("child-turn-2")),
      }),
      expect.objectContaining({
        type: "item/completed",
        scope: turnScope(harness.turnId("parent-turn")),
        item: expect.objectContaining({
          type: "delegation",
          id: harness.itemId("subagent-call-1"),
          status: "completed",
        }),
      }),
    ]);
  });

  it("links an unknown resumed subagent from the raw followup intent after translator restart", () => {
    const harness = createHarness();

    expect(
      harness.translate(
        rawCollaborationCall({
          callId: "message-call",
          name: "send_message",
        }),
      ),
    ).toEqual([]);
    expect(
      harness.translate(
        subAgentActivity({ id: "message-call", kind: "interacted" }),
      ),
    ).toEqual([]);

    expect(
      harness.translate(
        rawCollaborationCall({
          callId: "followup-call",
          name: "followup_task",
        }),
      ),
    ).toEqual([]);
    expect(
      harness.translate(
        subAgentActivity({ id: "followup-call", kind: "interacted" }),
      ),
    ).toEqual([
      expect.objectContaining({
        type: "item/started",
        scope: turnScope(harness.turnId("parent-turn")),
        item: expect.objectContaining({
          type: "delegation",
          id: harness.itemId("followup-call"),
          childRef: "agent-thread-1",
          status: "pending",
        }),
      }),
    ]);

    expect(
      harness.translate(childTurnStarted("resumed-child-turn")),
    ).toContainEqual(
      expect.objectContaining({
        type: "turn/started",
        scope: turnScope(harness.turnId("resumed-child-turn")),
        parentToolCallId: harness.itemId("followup-call"),
      }),
    );
  });

  it("does not reopen a known terminal subagent for send_message", () => {
    const harness = createHarness();
    harness.translate(
      subAgentActivity({ id: "subagent-call-1", kind: "started" }),
    );
    harness.translate(childTurnStarted("child-turn-1"));
    harness.translate(childTurnCompleted("child-turn-1"));

    harness.translate(
      rawCollaborationCall({ callId: "message-call", name: "send_message" }),
    );
    expect(
      harness.translate(
        subAgentActivity({ id: "message-call", kind: "interacted" }),
      ),
    ).toEqual([]);

    expect(
      harness.translator.prepareTurnStart({
        clientRequestId: "creq_after_message",
        providerThreadId: rootProviderThreadId,
      }),
    ).not.toBeNull();
    const nextRootTurn = harness
      .translate(childTurnStarted("next-root-turn"))
      .find((event) => event.type === "turn/started");
    expect(nextRootTurn).not.toHaveProperty("parentToolCallId");
  });

  it("links a rawless resumed subagent when its child turn starts", () => {
    const harness = createHarness();

    expect(
      harness.translate(
        subAgentActivity({ id: "rawless-followup", kind: "interacted" }),
      ),
    ).toEqual([]);

    const resumedEvents = harness.translate(
      childTurnStarted("rawless-child-turn"),
    );
    expect(resumedEvents).toEqual([
      expect.objectContaining({
        type: "item/started",
        scope: turnScope(harness.turnId("parent-turn")),
        item: expect.objectContaining({
          type: "delegation",
          id: harness.itemId("rawless-followup"),
          childRef: "agent-thread-1",
        }),
      }),
      expect.objectContaining({
        type: "turn/started",
        scope: turnScope(harness.turnId("rawless-child-turn")),
        parentToolCallId: harness.itemId("rawless-followup"),
      }),
    ]);
    expect(resumedEvents[0]).not.toHaveProperty("parentToolCallId");
    expect(resumedEvents[0]).not.toHaveProperty("item.parentToolCallId");
  });

  it("keeps root input correlation independent from a rawless resumed child thread", () => {
    const harness = createHarness();

    expect(
      harness.translate(
        subAgentActivity({ id: "rawless-followup", kind: "interacted" }),
      ),
    ).toEqual([]);

    expect(
      harness.translate(
        childTurnStarted("rawless-child-turn", "agent-thread-1"),
      ),
    ).toEqual([
      expect.objectContaining({
        type: "item/started",
        scope: turnScope(harness.turnId("parent-turn")),
        item: expect.objectContaining({
          type: "delegation",
          id: harness.itemId("rawless-followup"),
          childRef: "agent-thread-1",
        }),
      }),
      expect.objectContaining({
        type: "turn/started",
        scope: turnScope(harness.turnId("rawless-child-turn")),
        parentToolCallId: harness.itemId("rawless-followup"),
      }),
    ]);

    harness.translate(childTurnCompleted("parent-turn"));
    expect(
      harness.translator.prepareTurnStart({
        clientRequestId: "creq_while_child_running",
        providerThreadId: rootProviderThreadId,
      }),
    ).not.toBeNull();

    const rootEvents = harness.translate(childTurnStarted("next-root-turn"));
    expect(rootEvents).toContainEqual(
      expect.objectContaining({
        type: "turn/started",
        scope: turnScope(harness.turnId("next-root-turn")),
      }),
    );
    expect(rootEvents).toContainEqual(
      expect.objectContaining({
        type: "turn/input/accepted",
        scope: turnScope(harness.turnId("next-root-turn")),
        clientRequestId: "creq_while_child_running",
      }),
    );
    expect(
      rootEvents.find((event) => event.type === "turn/started"),
    ).not.toHaveProperty("parentToolCallId");

    expect(
      harness
        .translate(childTurnCompleted("rawless-child-turn", "agent-thread-1"))
        .map((event) => event.type),
    ).toEqual(["turn/completed", "item/completed"]);
  });

  it("discards a rawless message interaction at its parent boundary", () => {
    const harness = createHarness();
    expect(
      harness.translate(
        subAgentActivity({ id: "rawless-message", kind: "interacted" }),
      ),
    ).toEqual([]);
    harness.translate(childTurnCompleted("parent-turn"));

    harness.translator.prepareTurnStart({
      clientRequestId: "creq_after_rawless_message",
      providerThreadId: rootProviderThreadId,
    });
    const nextRootTurn = harness
      .translate(childTurnStarted("next-root-after-message"))
      .find((event) => event.type === "turn/started");
    expect(nextRootTurn).not.toHaveProperty("parentToolCallId");
  });

  it("does not attach a rawless message to an unrelated multiplexed child", () => {
    const harness = createHarness();
    expect(
      harness.translate(
        subAgentActivity({
          agentThreadId: "message-target-thread",
          id: "rawless-message",
          kind: "interacted",
        }),
      ),
    ).toEqual([]);

    harness.translate(
      subAgentActivity({
        agentThreadId: "unrelated-agent-thread",
        id: "unrelated-subagent-call",
        kind: "started",
      }),
    );
    const unrelatedChild = harness
      .translate(childTurnStarted("unrelated-child-turn"))
      .find((event) => event.type === "turn/started");
    expect(unrelatedChild).toEqual(
      expect.objectContaining({
        type: "turn/started",
        parentToolCallId: harness.itemId("unrelated-subagent-call"),
      }),
    );
    expect(unrelatedChild).not.toHaveProperty(
      "parentToolCallId",
      harness.itemId("rawless-message"),
    );

    harness.translate(childTurnCompleted("unrelated-child-turn"));
    harness.translate(childTurnCompleted("parent-turn"));
    expect(
      harness.translator.prepareTurnStart({
        clientRequestId: "creq_after_unrelated_child",
        providerThreadId: rootProviderThreadId,
      }),
    ).not.toBeNull();
    const nextRootTurn = harness
      .translate(childTurnStarted("next-root-after-unrelated-child"))
      .find((event) => event.type === "turn/started");
    expect(nextRootTurn).not.toHaveProperty("parentToolCallId");
  });

  it("preserves the parent link across queued follow-up resumes", () => {
    const harness = createHarness();
    harness.translate(
      subAgentActivity({ id: "subagent-call-1", kind: "started" }),
    );
    harness.translate(childTurnStarted("child-turn-1"));
    harness.translate(childTurnCompleted("child-turn-1"));

    expect(
      harness
        .translate(
          subAgentActivity({ id: "interaction-1", kind: "interacted" }),
        )
        .map((event) => event.type),
    ).toEqual([]);
    expect(
      harness.translate(
        subAgentActivity({ id: "interaction-2", kind: "interacted" }),
      ),
    ).toEqual([]);

    for (const index of [2, 3]) {
      expect(
        harness.translate(childTurnStarted(`child-turn-${index}`)),
      ).toEqual([
        expect.objectContaining({
          type: "item/started",
          item: expect.objectContaining({
            type: "delegation",
            id: harness.itemId("subagent-call-1"),
          }),
        }),
        expect.objectContaining({
          type: "turn/started",
          scope: turnScope(harness.turnId(`child-turn-${index}`)),
          parentToolCallId: harness.itemId("subagent-call-1"),
        }),
      ]);
      expect(
        harness
          .translate(childTurnCompleted(`child-turn-${index}`))
          .map((event) => event.type),
      ).toEqual(["turn/completed", "item/completed"]);
    }
  });

  it("does not attach a resumed subagent parent to a later human turn", () => {
    const harness = createHarness();
    harness.translate(
      subAgentActivity({ id: "subagent-call-1", kind: "started" }),
    );
    harness.translate(childTurnStarted("child-turn-1"));
    harness.translate(childTurnCompleted("child-turn-1"));
    harness.translate(
      subAgentActivity({ id: "interaction-1", kind: "interacted" }),
    );

    expect(
      harness.translator.prepareTurnStart({
        clientRequestId: "creq_followup",
        providerThreadId: rootProviderThreadId,
      }),
    ).not.toBeNull();

    const humanTurnStarted = harness
      .translate(childTurnStarted("human-turn"))
      .find((event) => event.type === "turn/started");
    expect(humanTurnStarted).toEqual(
      expect.objectContaining({
        type: "turn/started",
        scope: turnScope(harness.turnId("human-turn")),
      }),
    );
    expect(humanTurnStarted).not.toHaveProperty("parentToolCallId");

    expect(harness.translate(childTurnStarted("child-turn-2"))).toContainEqual(
      expect.objectContaining({
        type: "turn/started",
        scope: turnScope(harness.turnId("child-turn-2")),
        parentToolCallId: harness.itemId("subagent-call-1"),
      }),
    );
  });

  it("settles open delegations as failed when the child exits", () => {
    const harness = createHarness();
    harness.translate(
      subAgentActivity({ id: "subagent-call-1", kind: "started" }),
    );
    harness.translate(childTurnStarted("child-turn-1"));

    const closes = harness.translator.clearExitedChildThreadState({
      providerThreadId: rootProviderThreadId,
    });
    expect(
      harness.assembler.assemble({ threadId: THREAD_ID, deltas: closes }),
    ).toEqual([
      expect.objectContaining({
        type: "item/completed",
        scope: turnScope(harness.turnId("parent-turn")),
        item: expect.objectContaining({
          type: "delegation",
          id: harness.itemId("subagent-call-1"),
          status: "failed",
        }),
      }),
    ]);
    expect(
      harness.translator.clearExitedChildThreadState({
        providerThreadId: rootProviderThreadId,
      }),
    ).toEqual([]);
  });

  it("ignores a duplicated interacted item", () => {
    const harness = createHarness();
    harness.translate(
      subAgentActivity({ id: "subagent-call-1", kind: "started" }),
    );
    harness.translate(childTurnStarted("child-turn-1"));
    harness.translate(childTurnCompleted("child-turn-1"));

    harness.translate(
      subAgentActivity({ id: "interaction-1", kind: "interacted" }),
    );
    harness.translate(
      subAgentActivity({ id: "interaction-1", kind: "interacted" }),
    );

    expect(harness.translate(childTurnStarted("child-turn-2"))).toContainEqual(
      expect.objectContaining({
        type: "turn/started",
        scope: turnScope(harness.turnId("child-turn-2")),
        parentToolCallId: harness.itemId("subagent-call-1"),
      }),
    );
    harness.translate(childTurnCompleted("child-turn-2"));

    expect(
      harness.translator.prepareTurnStart({
        clientRequestId: "creq_after_duplicate",
        providerThreadId: rootProviderThreadId,
      }),
    ).not.toBeNull();
    const laterHumanTurn = harness
      .translate(childTurnStarted("human-turn"))
      .find((event) => event.type === "turn/started");
    expect(laterHumanTurn).not.toHaveProperty("parentToolCallId");
  });

  it("does not FIFO-cross-link concurrently resumed subagents", () => {
    const harness = createHarness();
    for (const index of [1, 2]) {
      harness.translate(
        subAgentActivity({
          agentThreadId: `agent-thread-${index}`,
          id: `subagent-call-${index}`,
          kind: "started",
        }),
      );
      harness.translate(childTurnStarted(`child-turn-${index}`));
      harness.translate(childTurnCompleted(`child-turn-${index}`));
    }
    for (const index of [1, 2]) {
      harness.translate(
        subAgentActivity({
          agentThreadId: `agent-thread-${index}`,
          id: `interaction-${index}`,
          kind: "interacted",
        }),
      );
    }

    expect(
      harness.translate(childTurnStarted("resumed-turn-2", "agent-thread-2")),
    ).toContainEqual(
      expect.objectContaining({
        type: "turn/started",
        scope: turnScope(harness.turnId("resumed-turn-2")),
        parentToolCallId: harness.itemId("subagent-call-2"),
      }),
    );

    expect(
      harness.translate(childTurnStarted("resumed-turn-1")),
    ).toContainEqual(
      expect.objectContaining({
        type: "turn/started",
        scope: turnScope(harness.turnId("resumed-turn-1")),
        parentToolCallId: harness.itemId("subagent-call-1"),
      }),
    );
  });

  it("links concurrent subagents to child turns in activity order", () => {
    const harness = createHarness();
    for (const index of [1, 2]) {
      harness.translate(
        subAgentActivity({
          agentThreadId: `agent-thread-${index}`,
          id: `subagent-call-${index}`,
          kind: "started",
        }),
      );
    }

    for (const index of [1, 2]) {
      expect(
        harness.translate(childTurnStarted(`child-turn-${index}`)),
      ).toContainEqual(
        expect.objectContaining({
          type: "turn/started",
          scope: turnScope(harness.turnId(`child-turn-${index}`)),
          parentToolCallId: harness.itemId(`subagent-call-${index}`),
        }),
      );
    }
  });

  it("terminalizes an open subagent when activity is interrupted", () => {
    const harness = createHarness();
    harness.translate(
      subAgentActivity({ id: "subagent-call-1", kind: "started" }),
    );

    expect(
      harness.translate(
        subAgentActivity({ id: "interrupt-activity-1", kind: "interrupted" }),
      ),
    ).toEqual([
      expect.objectContaining({
        type: "item/completed",
        scope: turnScope(harness.turnId("parent-turn")),
        item: expect.objectContaining({
          id: harness.itemId("subagent-call-1"),
          status: "interrupted",
        }),
      }),
    ]);

    expect(
      harness.translate(
        subAgentActivity({ id: "subagent-call-1", kind: "started" }),
      ),
    ).toHaveLength(0);
  });
});

const STREAM_DISCONNECT_MESSAGE =
  "stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)";

const STREAM_DISCONNECTED_ERROR_INFO = {
  category: "stream-disconnected",
  providerCode: "responseStreamDisconnected",
  httpStatusCode: 502,
};

const UNKNOWN_ERROR_INFO = {
  category: "unknown",
  providerCode: "other",
  httpStatusCode: null,
};

function codexReconnectError(turnId: string) {
  return codexEvent("error", {
    threadId: "t1",
    turnId,
    error: {
      message: "Reconnecting... 5/5",
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } },
      additionalDetails: STREAM_DISCONNECT_MESSAGE,
    },
    willRetry: true,
  });
}

function codexTerminalOtherError(turnId: string, message: string) {
  return codexEvent("error", {
    threadId: "t1",
    turnId,
    error: { message, codexErrorInfo: "other", additionalDetails: null },
    willRetry: false,
  });
}

describe("codex terminal retry-error classification", () => {
  it("carries the retry classification into the degraded terminal error", () => {
    const harness = createHarness();
    harness.translate(codexReconnectError("turn-1"));

    expect(
      harness.translate(
        codexTerminalOtherError("turn-1", STREAM_DISCONNECT_MESSAGE),
      ),
    ).toContainEqual(
      expect.objectContaining({
        type: "provider/error",
        scope: turnScope(harness.turnId("turn-1")),
        willRetry: false,
        detail: STREAM_DISCONNECT_MESSAGE,
        errorInfo: STREAM_DISCONNECTED_ERROR_INFO,
      }),
    );

    expect(
      harness.translate(
        codexTerminalOtherError("turn-1", STREAM_DISCONNECT_MESSAGE),
      ),
    ).toContainEqual(
      expect.objectContaining({
        type: "provider/error",
        errorInfo: UNKNOWN_ERROR_INFO,
      }),
    );
  });

  it("does not relabel an unrelated terminal error after a reconnect", () => {
    const harness = createHarness();
    harness.translate(codexReconnectError("turn-1"));

    expect(
      harness.translate(codexTerminalOtherError("turn-1", "request failed")),
    ).toContainEqual(
      expect.objectContaining({
        type: "provider/error",
        errorInfo: UNKNOWN_ERROR_INFO,
      }),
    );
  });

  it("scopes the retry context to the turn and drops it on turn/completed", () => {
    const harness = createHarness();
    harness.translate(codexReconnectError("turn-1"));

    expect(
      harness.translate(
        codexTerminalOtherError("turn-2", STREAM_DISCONNECT_MESSAGE),
      ),
    ).toContainEqual(
      expect.objectContaining({
        type: "provider/error",
        errorInfo: UNKNOWN_ERROR_INFO,
      }),
    );

    harness.translate(
      codexEvent("turn/completed", {
        threadId: "t1",
        turn: codexTurn({ id: "turn-1", status: "completed", error: null }),
      }),
    );
    expect(
      harness.translate(
        codexTerminalOtherError("turn-1", STREAM_DISCONNECT_MESSAGE),
      ),
    ).toContainEqual(
      expect.objectContaining({
        type: "provider/error",
        errorInfo: UNKNOWN_ERROR_INFO,
      }),
    );
  });

  it("drops the retry context when the codex thread closes", () => {
    const harness = createHarness();
    harness.translate(codexReconnectError("turn-1"));
    harness.translate(codexEvent("thread/closed", { threadId: "t1" }));

    expect(
      harness.translate(
        codexTerminalOtherError("turn-1", STREAM_DISCONNECT_MESSAGE),
      ),
    ).toContainEqual(
      expect.objectContaining({
        type: "provider/error",
        errorInfo: UNKNOWN_ERROR_INFO,
      }),
    );
  });
});

describe("codex accepted-input correlation", () => {
  it("acks a queued turn on turn/started and suppresses the later echo", () => {
    const harness = createHarness();
    expect(
      harness.translator.prepareTurnStart({
        clientRequestId: "creq_23456789ag",
        providerThreadId: "provider-thread-1",
      }),
    ).not.toBeNull();

    const events = harness.translate(
      codexEvent("turn/started", {
        threadId: "provider-thread-1",
        turn: codexTurn({ id: "turn-1", status: "inProgress", error: null }),
      }),
    );
    expect(events).toEqual([
      {
        type: "turn/started",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(harness.turnId("turn-1")),
      },
      {
        type: "turn/input/accepted",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(harness.turnId("turn-1")),
        clientRequestId: "creq_23456789ag",
      },
    ]);

    expect(
      harness.translate(
        codexEvent("item/completed", {
          threadId: "provider-thread-1",
          turnId: "turn-1",
          completedAtMs: 0,
          item: {
            type: "userMessage",
            id: "provider-user-1",
            clientId: null,
            content: [{ type: "text", text: "normal turn", text_elements: [] }],
          },
        }),
      ),
    ).toMatchObject([]);
  });

  it("drops the queued ack when the dispatch is rolled back", () => {
    const harness = createHarness();
    const prepared = harness.translator.prepareTurnStart({
      clientRequestId: "creq_23456789ag",
      providerThreadId: "provider-thread-1",
    });
    if (!prepared) {
      throw new Error("Expected prepared turn/start state");
    }
    prepared.rollback();

    expect(
      harness.translate(
        codexEvent("turn/started", {
          threadId: "provider-thread-1",
          turn: codexTurn({ id: "turn-1", status: "inProgress", error: null }),
        }),
      ),
    ).toEqual([
      {
        type: "turn/started",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(harness.turnId("turn-1")),
      },
    ]);
  });
});

describe("codex delegation-turn nesting", () => {
  it("does not inherit a delegation link onto a later human turn", () => {
    const harness = createHarness();
    const providerThreadId = "root-provider-thread";
    const parentCallId = "call_MV1jTrxEd9bsYdEXQo1PhVOs";

    harness.translate(
      codexEvent("turn/started", {
        threadId: providerThreadId,
        turn: codexTurn({
          id: "parent-turn",
          status: "inProgress",
          error: null,
        }),
      }),
    );
    harness.translate(
      codexEvent("item/started", {
        threadId: providerThreadId,
        turnId: "parent-turn",
        startedAtMs: 0,
        item: {
          type: "collabAgentToolCall",
          id: parentCallId,
          tool: "spawnAgent",
          status: "inProgress",
          senderThreadId: providerThreadId,
          receiverThreadIds: [],
          prompt: "Run the child command",
          model: null,
          reasoningEffort: null,
          agentsStates: {},
        },
      }),
    );
    harness.translate(
      codexEvent("item/completed", {
        threadId: providerThreadId,
        turnId: "parent-turn",
        completedAtMs: 0,
        item: {
          type: "collabAgentToolCall",
          id: parentCallId,
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: providerThreadId,
          receiverThreadIds: ["child-provider-thread"],
          prompt: "Run the child command",
          model: "gpt-5.5",
          reasoningEffort: "medium",
          agentsStates: {
            "child-provider-thread": { status: "pendingInit", message: null },
          },
        },
      }),
    );
    harness.translate(
      codexEvent("turn/completed", {
        threadId: providerThreadId,
        turn: codexTurn({
          id: "parent-turn",
          status: "completed",
          error: null,
        }),
      }),
    );
    const parentToolCallId = harness.itemId(parentCallId);

    expect(
      harness.translate(
        codexEvent("turn/started", {
          threadId: providerThreadId,
          turn: codexTurn({
            id: "child-turn",
            status: "inProgress",
            error: null,
          }),
        }),
      ),
    ).toContainEqual(
      expect.objectContaining({
        type: "turn/started",
        parentToolCallId,
        scope: turnScope(harness.turnId("child-turn")),
      }),
    );

    expect(
      harness.translate(
        codexEvent("item/started", {
          threadId: providerThreadId,
          turnId: "child-turn",
          startedAtMs: 0,
          item: {
            type: "commandExecution",
            id: "child-command",
            command: "/bin/zsh -lc 'sleep 20; echo CHILD_REAL_PROVIDER_DONE'",
            cwd: "/tmp",
            processId: null,
            pluginId: null,
            scriptPath: null,
            source: "agent",
            status: "inProgress",
            commandActions: [],
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
          },
        }),
      ),
    ).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "commandExecution",
          id: harness.itemId("child-command"),
          parentToolCallId,
        }),
      }),
    );

    harness.translator.prepareTurnStart({
      clientRequestId: "creq_followup",
      providerThreadId,
    });

    const followUpTurnStarted = harness
      .translate(
        codexEvent("turn/started", {
          threadId: providerThreadId,
          turn: codexTurn({
            id: "follow-up-turn",
            status: "inProgress",
            error: null,
          }),
        }),
      )
      .find((event) => event.type === "turn/started");
    expect(followUpTurnStarted).toEqual(
      expect.objectContaining({
        type: "turn/started",
        scope: turnScope(harness.turnId("follow-up-turn")),
      }),
    );
    expect(followUpTurnStarted).not.toHaveProperty("parentToolCallId");

    const followUpAssistant = harness
      .translate(
        codexEvent("item/completed", {
          threadId: providerThreadId,
          turnId: "follow-up-turn",
          completedAtMs: 0,
          item: {
            type: "agentMessage",
            id: "follow-up-assistant",
            text: "follow-up done",
            phase: null,
            memoryCitation: null,
            delivery: null,
          },
        }),
      )
      .find(
        (event) =>
          event.type === "item/completed" && event.item.type === "agentMessage",
      );
    expect(followUpAssistant).toEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "agentMessage",
          id: harness.itemId("follow-up-assistant"),
        }),
      }),
    );
    expect(followUpAssistant).not.toHaveProperty("item.parentToolCallId");

    expect(
      harness.translate(
        codexEvent("item/commandExecution/outputDelta", {
          threadId: providerThreadId,
          turnId: "child-turn",
          itemId: "child-command",
          delta: "CHILD_REAL_PROVIDER_DONE\n",
        }),
      ),
    ).toContainEqual(
      expect.objectContaining({
        type: "item/commandExecution/outputDelta",
        parentToolCallId,
        scope: turnScope(harness.turnId("child-turn")),
      }),
    );
  });

  it.each(["spawnAgent", "resumeAgent"] as const)(
    "stamps pending same-provider child turn events for %s",
    (tool) => {
      const harness = createHarness();
      const providerThreadId = "root-provider-thread";

      harness.translate(
        codexEvent("turn/started", {
          threadId: providerThreadId,
          turn: codexTurn({
            id: "parent-turn",
            status: "inProgress",
            error: null,
          }),
        }),
      );
      harness.translate(
        codexEvent("item/started", {
          threadId: providerThreadId,
          turnId: "parent-turn",
          startedAtMs: 0,
          item: {
            type: "collabAgentToolCall",
            id: "delegation-1",
            tool,
            status: "inProgress",
            senderThreadId: providerThreadId,
            receiverThreadIds: [],
            prompt: "Inspect the repo",
            model: null,
            reasoningEffort: null,
            agentsStates: {},
          },
        }),
      );

      expect(
        harness.translate(
          codexEvent("turn/started", {
            threadId: providerThreadId,
            turn: codexTurn({
              id: "child-turn",
              status: "inProgress",
              error: null,
            }),
          }),
        ),
      ).toContainEqual(
        expect.objectContaining({
          type: "turn/started",
          parentToolCallId: harness.itemId("delegation-1"),
          scope: turnScope(harness.turnId("child-turn")),
        }),
      );

      expect(
        harness.translate(
          codexEvent("item/completed", {
            threadId: providerThreadId,
            turnId: "child-turn",
            completedAtMs: 0,
            item: {
              type: "agentMessage",
              id: "child-assistant-1",
              text: "Child done.",
              phase: null,
              memoryCitation: null,
              delivery: null,
            },
          }),
        ),
      ).toContainEqual(
        expect.objectContaining({
          type: "item/completed",
          item: expect.objectContaining({
            type: "agentMessage",
            id: harness.itemId("child-assistant-1"),
            parentToolCallId: harness.itemId("delegation-1"),
          }),
        }),
      );
    },
  );

  it.each(["spawnAgent", "resumeAgent"] as const)(
    "stamps explicit receiver-thread child events under the %s call",
    (tool) => {
      const harness = createHarness();

      harness.translate(
        codexEvent("item/completed", {
          threadId: "root-provider-thread",
          turnId: "parent-turn",
          completedAtMs: 0,
          item: {
            type: "collabAgentToolCall",
            id: "delegation-1",
            tool,
            status: "completed",
            senderThreadId: "root-provider-thread",
            receiverThreadIds: ["child-provider-thread"],
            prompt: "Inspect the docs",
            model: null,
            reasoningEffort: null,
            agentsStates: {
              "child-provider-thread": { status: "completed", message: "done" },
            },
          },
        }),
      );

      expect(
        harness.translate(
          codexEvent("turn/started", {
            threadId: "child-provider-thread",
            turn: codexTurn({
              id: "child-turn",
              status: "inProgress",
              error: null,
            }),
          }),
        ),
      ).toContainEqual(
        expect.objectContaining({
          type: "turn/started",
          parentToolCallId: harness.itemId("delegation-1"),
          scope: turnScope(harness.turnId("child-turn")),
        }),
      );

      expect(
        harness.translate(
          codexEvent("item/completed", {
            threadId: "child-provider-thread",
            turnId: "child-turn",
            completedAtMs: 0,
            item: {
              type: "agentMessage",
              id: "child-assistant-1",
              text: "Child done.",
              phase: null,
              memoryCitation: null,
              delivery: null,
            },
          }),
        ),
      ).toContainEqual(
        expect.objectContaining({
          type: "item/completed",
          item: expect.objectContaining({
            type: "agentMessage",
            id: harness.itemId("child-assistant-1"),
            parentToolCallId: harness.itemId("delegation-1"),
          }),
        }),
      );
    },
  );
});

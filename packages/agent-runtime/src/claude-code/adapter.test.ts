import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { threadScope, turnScope } from "@bb/domain";
import { createClaudeCodeProviderAdapter } from "./adapter.js";
import { CLAUDE_PERMISSION_REQUEST_APPROVAL_METHOD } from "./interactive-contract.js";
import type { ProviderExecutionContext } from "../provider-adapter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "../__fixtures__/claude-code");

function isFixtureObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function loadFixture(name: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    readFileSync(resolve(FIXTURES, name), "utf8"),
  );
  if (!isFixtureObject(parsed)) {
    throw new Error(`Fixture ${name} did not contain an object`);
  }
  return parsed;
}

const fullProviderExecutionContext = {
  permissionMode: "full",
  permissionEscalation: null,
} satisfies ProviderExecutionContext;

const workspaceWriteProviderExecutionContext = {
  permissionMode: "workspace-write",
  permissionEscalation: "deny",
} satisfies ProviderExecutionContext;

describe("claude-code provider adapter", () => {
  // -- Identity & capabilities ---------------------------------------------

  it("has correct identity", () => {
    const adapter = createClaudeCodeProviderAdapter();
    expect(adapter.id).toBe("claude-code");
    expect(adapter.displayName).toBe("Claude Code");
  });

  it("has correct process config", () => {
    const adapter = createClaudeCodeProviderAdapter();
    expect(adapter.process.command).toBe("node");
    expect(adapter.process.args.slice(0, 3)).toEqual([
      "--conditions=source",
      "--import",
      import.meta.resolve("tsx"),
    ]);
    expect(adapter.process.args.at(-1)).toMatch(
      /agent-runtime\/src\/claude-code\/bridge\/bridge\.ts$/,
    );
  });

  it("uses the configured bridge bundle directory when present", () => {
    const adapter = createClaudeCodeProviderAdapter({
      additionalWorkspaceWriteRoots: [],
      bridgeBundleDir: "/tmp",
    });
    expect(adapter.process.args[0]).toBe("/tmp/bb-claude-code-bridge.mjs");
  });

  it("advertises trimmed capabilities", () => {
    const adapter = createClaudeCodeProviderAdapter();
    expect(adapter.capabilities).toEqual({
      supportsArchive: false,
      supportsRename: false,
      supportsServiceTier: false,
      supportedPermissionModes: ["full", "workspace-write", "readonly"],
    });
  });

  it("translates accepted steers to input accepted events", () => {
    const adapter = createClaudeCodeProviderAdapter();

    expect(
      adapter.translateAcceptedCommand({
        command: {
          type: "turn/steer",
          threadId: "thread-1",
          providerThreadId: "provider-thread-1",
          expectedTurnId: "turn-1",
          clientRequestId: "creq_23456789ad",
          input: [{ type: "text", text: "steer turn" }],
          options: fullProviderExecutionContext,
        },
      }),
    ).toEqual([
      {
        type: "turn/input/accepted",
        threadId: "thread-1",
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        clientRequestId: "creq_23456789ad",
      },
    ]);
  });

  // -- buildCommand --------------------------------------------------------

  it("buildCommand returns an unsupported no-op for thread/name/set", () => {
    const adapter = createClaudeCodeProviderAdapter();
    expect(
      adapter.buildCommandPlan({
        type: "thread/name/set",
        threadId: "t1",
        providerThreadId: "p1",
        title: "hi",
      }),
    ).toEqual({
      kind: "noop",
      reason: "rename unsupported",
    });
  });

  it("buildCommand model/list routes through the bridge", () => {
    const adapter = createClaudeCodeProviderAdapter();
    expect(adapter.buildCommandPlan({ type: "model/list" })).toEqual({
      kind: "request",
      method: "model/list",
      params: {},
    });
  });

  it("buildCommand thread/start routes threadId from command", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "thread/start",
      cwd: "/tmp/worktree",
      threadId: "bb-thread-1",
      input: [{ type: "text", text: "hello" }],
      instructionMode: "append",
      options: fullProviderExecutionContext,
    });
    expect(cmd?.params).toMatchObject({
      threadId: "bb-thread-1",
      permissionMode: "bypassPermissions",
      permissionEscalation: null,
      cwd: "/tmp/worktree",
    });
  });

  it("buildCommand thread/start includes construction-level workspace-write roots", () => {
    const adapter = createClaudeCodeProviderAdapter({
      additionalWorkspaceWriteRoots: [
        "/repo/.git/worktrees/bb13",
        "/repo/.git/objects",
      ],
    });
    const cmd = adapter.buildCommandPlan({
      type: "thread/start",
      cwd: "/tmp/worktree",
      threadId: "bb-thread-1",
      input: [{ type: "text", text: "hello" }],
      instructionMode: "append",
      options: workspaceWriteProviderExecutionContext,
    });

    expect(cmd?.params).toMatchObject({
      additionalWorkspaceWriteRoots: [
        "/repo/.git/worktrees/bb13",
        "/repo/.git/objects",
      ],
    });
  });

  it("buildCommand thread/start omits empty workspace-write roots", () => {
    const adapter = createClaudeCodeProviderAdapter({
      additionalWorkspaceWriteRoots: [],
    });
    const cmd = adapter.buildCommandPlan({
      type: "thread/start",
      cwd: "/tmp/worktree",
      threadId: "bb-thread-1",
      input: [{ type: "text", text: "hello" }],
      instructionMode: "append",
      options: workspaceWriteProviderExecutionContext,
    });

    expect(cmd?.params).not.toHaveProperty("additionalWorkspaceWriteRoots");
  });

  it("buildCommand thread/start omits workspace roots outside workspace-write mode", () => {
    const adapter = createClaudeCodeProviderAdapter({
      additionalWorkspaceWriteRoots: [
        "/repo/.git/worktrees/bb13",
        "/repo/.git/objects",
      ],
    });
    const readonlyCmd = adapter.buildCommandPlan({
      type: "thread/start",
      cwd: "/tmp/worktree",
      threadId: "bb-thread-readonly",
      input: [{ type: "text", text: "hello" }],
      instructionMode: "append",
      options: {
        permissionMode: "readonly",
        permissionEscalation: "ask",
      },
    });
    const fullCmd = adapter.buildCommandPlan({
      type: "thread/start",
      cwd: "/tmp/worktree",
      threadId: "bb-thread-full",
      input: [{ type: "text", text: "hello" }],
      instructionMode: "append",
      options: fullProviderExecutionContext,
    });

    expect(readonlyCmd?.params).not.toHaveProperty(
      "additionalWorkspaceWriteRoots",
    );
    expect(fullCmd?.params).not.toHaveProperty("additionalWorkspaceWriteRoots");
  });

  it("buildCommand thread/start passes through model, env vars, instructions, reasoning level, and dynamic tools", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "thread/start",
      cwd: "/tmp/worktree",
      threadId: "bb-thread-1",
      input: [{ type: "text", text: "hello" }],
      instructionMode: "append",
      options: {
        permissionEscalation: "ask",
        model: "claude-sonnet-4-5",
        permissionMode: "workspace-write",
        instructions: "Focus on the failing tests first.",
        reasoningLevel: "high",
        envVars: {
          "BAD.KEY": "ignored",
          TEST_VAR: "123",
        },
      },
      dynamicTools: [
        {
          name: "bb_test_ping",
          description: "Ping the host",
          inputSchema: {
            type: "object",
            properties: {
              ping: { type: "boolean" },
            },
            required: ["ping"],
          },
        },
      ],
      disallowedTools: ["ExitPlanMode", "NotebookEdit", "Task"],
    });

    expect(cmd).toMatchObject({
      method: "thread/start",
      params: {
        threadId: "bb-thread-1",
        model: "claude-sonnet-4-5",
        reasoningLevel: "high",
        permissionMode: "acceptEdits",
        permissionEscalation: "ask",
        baseInstructions: expect.stringContaining(
          "Focus on the failing tests first.",
        ),
        dynamicTools: [
          {
            name: "bb_test_ping",
            description: "Ping the host",
            inputSchema: {
              type: "object",
              properties: {
                ping: { type: "boolean" },
              },
              required: ["ping"],
            },
          },
        ],
        disallowedTools: ["ExitPlanMode", "NotebookEdit", "Task"],
      },
    });
    expect(cmd?.params).toMatchObject({
      config: {
        "shell_environment_policy.set.TEST_VAR": "123",
      },
    });
    expect(cmd).not.toMatchObject({
      params: {
        config: {
          "shell_environment_policy.set.BAD.KEY": "ignored",
        },
      },
    });
  });

  it("buildCommand thread/resume passes providerThreadId", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "thread/resume",
      cwd: "/tmp/worktree",
      threadId: "bb-thread-1",
      providerThreadId: "claude-session-1",
      instructionMode: "append",
      options: fullProviderExecutionContext,
    });
    expect(cmd?.params).toMatchObject({
      cwd: "/tmp/worktree",
      threadId: "bb-thread-1",
      providerThreadId: "claude-session-1",
      permissionMode: "bypassPermissions",
      permissionEscalation: null,
    });
  });

  it("buildCommand thread/start maps readonly deny policy to dontAsk with deny escalation", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "thread/start",
      cwd: "/tmp/worktree",
      threadId: "bb-thread-1",
      input: [{ type: "text", text: "hello" }],
      instructionMode: "append",
      options: {
        permissionMode: "readonly",
        permissionEscalation: "deny",
      },
    });
    expect(cmd?.params).toMatchObject({
      permissionMode: "dontAsk",
      permissionEscalation: "deny",
    });
  });

  it("buildCommand thread/start ignores escalation in full permission mode", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "thread/start",
      cwd: "/tmp/worktree",
      threadId: "bb-thread-1",
      input: [{ type: "text", text: "hello" }],
      instructionMode: "append",
      options: {
        permissionMode: "full",
        permissionEscalation: null,
      },
    });
    expect(cmd?.params).toMatchObject({
      permissionMode: "bypassPermissions",
      permissionEscalation: null,
    });
  });

  it("parseModelListResult validates bridge model payloads", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const result = adapter.parseModelListResult({
      models: [
        {
          id: "claude-sonnet-4-6",
          model: "claude-sonnet-4-6",
          displayName: "Claude Sonnet 4.6",
          description: "Fast, intelligent model for everyday coding tasks",
          supportedReasoningEfforts: [
            {
              reasoningEffort: "medium",
              description: "Medium reasoning effort",
            },
          ],
          defaultReasoningEffort: "medium",
          isDefault: true,
        },
      ],
      selectedOnlyModels: [],
    });
    expect(result.models).toHaveLength(1);
    expect(result.selectedOnlyModels).toHaveLength(0);
  });

  it("buildCommand thread/resume maps updated permission policy", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "thread/resume",
      cwd: "/tmp/worktree",
      threadId: "bb-thread-1",
      providerThreadId: "claude-session-1",
      instructionMode: "append",
      options: {
        permissionEscalation: "deny",
        permissionMode: "readonly",
      },
    });
    expect(cmd?.params).toMatchObject({
      permissionEscalation: "deny",
      permissionMode: "dontAsk",
    });
  });

  it("buildCommand thread/resume includes construction-level workspace-write roots", () => {
    const adapter = createClaudeCodeProviderAdapter({
      additionalWorkspaceWriteRoots: [
        "/repo/.git/worktrees/bb13",
        "/repo/.git/objects",
      ],
    });
    const cmd = adapter.buildCommandPlan({
      type: "thread/resume",
      cwd: "/tmp/worktree",
      threadId: "bb-thread-1",
      providerThreadId: "claude-session-1",
      instructionMode: "append",
      options: workspaceWriteProviderExecutionContext,
    });

    expect(cmd?.params).toMatchObject({
      additionalWorkspaceWriteRoots: [
        "/repo/.git/worktrees/bb13",
        "/repo/.git/objects",
      ],
    });
  });

  it("buildCommand thread/resume omits empty workspace-write roots", () => {
    const adapter = createClaudeCodeProviderAdapter({
      additionalWorkspaceWriteRoots: [],
    });
    const cmd = adapter.buildCommandPlan({
      type: "thread/resume",
      cwd: "/tmp/worktree",
      threadId: "bb-thread-1",
      providerThreadId: "claude-session-1",
      instructionMode: "append",
      options: workspaceWriteProviderExecutionContext,
    });

    expect(cmd?.params).not.toHaveProperty("additionalWorkspaceWriteRoots");
  });

  it("buildCommand thread/resume omits workspace roots outside workspace-write mode", () => {
    const adapter = createClaudeCodeProviderAdapter({
      additionalWorkspaceWriteRoots: [
        "/repo/.git/worktrees/bb13",
        "/repo/.git/objects",
      ],
    });
    const readonlyCmd = adapter.buildCommandPlan({
      type: "thread/resume",
      cwd: "/tmp/worktree",
      threadId: "bb-thread-readonly",
      providerThreadId: "claude-session-readonly",
      instructionMode: "append",
      options: {
        permissionMode: "readonly",
        permissionEscalation: "ask",
      },
    });
    const fullCmd = adapter.buildCommandPlan({
      type: "thread/resume",
      cwd: "/tmp/worktree",
      threadId: "bb-thread-full",
      providerThreadId: "claude-session-full",
      instructionMode: "append",
      options: fullProviderExecutionContext,
    });

    expect(readonlyCmd?.params).not.toHaveProperty(
      "additionalWorkspaceWriteRoots",
    );
    expect(fullCmd?.params).not.toHaveProperty("additionalWorkspaceWriteRoots");
  });

  it("buildCommand thread/resume passes through options and dynamic tools", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "thread/resume",
      cwd: "/tmp/worktree",
      threadId: "bb-thread-1",
      providerThreadId: "claude-session-1",
      instructionMode: "append",
      options: {
        ...fullProviderExecutionContext,
        model: "claude-sonnet-4-5",
        instructions: "Reopen the thread and continue carefully.",
        reasoningLevel: "high",
        envVars: {
          "BAD.KEY": "ignored",
          TEST_VAR: "123",
        },
      },
      dynamicTools: [
        {
          name: "bb_test_ping",
          description: "Ping the host",
          inputSchema: {
            type: "object",
            properties: {
              ping: { type: "boolean" },
            },
            required: ["ping"],
          },
        },
      ],
    });

    expect(cmd).toMatchObject({
      method: "thread/resume",
      params: {
        threadId: "bb-thread-1",
        providerThreadId: "claude-session-1",
        model: "claude-sonnet-4-5",
        reasoningLevel: "high",
        baseInstructions: "Reopen the thread and continue carefully.",
        dynamicTools: [
          {
            name: "bb_test_ping",
            description: "Ping the host",
            inputSchema: {
              type: "object",
              properties: {
                ping: { type: "boolean" },
              },
              required: ["ping"],
            },
          },
        ],
      },
    });
    expect(cmd?.params).toMatchObject({
      config: {
        "shell_environment_policy.set.TEST_VAR": "123",
      },
    });
    expect(cmd).not.toMatchObject({
      params: {
        config: {
          "shell_environment_policy.set.BAD.KEY": "ignored",
        },
      },
    });
  });

  it("buildCommand turn/start includes input and providerThreadId", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "turn/start",
      clientRequestId: "creq_2222222296",
      threadId: "bb-thread-1",
      providerThreadId: "claude-session-1",
      input: [{ type: "text", text: "follow up" }],
      options: fullProviderExecutionContext,
    });
    expect(cmd?.params).toMatchObject({
      threadId: "bb-thread-1",
      providerThreadId: "claude-session-1",
    });
  });

  it("buildCommand turn/steer includes expectedTurnId", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "turn/steer",
      clientRequestId: "creq_2222222297",
      threadId: "bb-thread-1",
      providerThreadId: "claude-session-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "steer" }],
      options: fullProviderExecutionContext,
    });
    expect(cmd?.params).toMatchObject({
      threadId: "bb-thread-1",
      providerThreadId: "claude-session-1",
      expectedTurnId: "turn-1",
    });
  });

  it("buildCommand thread/stop maps to the bridge stop command", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "thread/stop",
      threadId: "bb-thread-1",
      providerThreadId: "claude-session-1",
      activeTurnId: "turn-1",
    });
    expect(cmd).toEqual({
      kind: "request",
      method: "thread/stop",
      params: {
        threadId: "bb-thread-1",
      },
    });
  });

  it("decodeToolCallRequest preserves string request ids", () => {
    const adapter = createClaudeCodeProviderAdapter();
    expect(
      adapter.decodeToolCallRequest({
        id: "req-1",
        method: "item/tool/call",
        params: {
          threadId: "t1",
          providerThreadId: "claude-session-1",
          turnId: "turn-1",
          callId: "call-1",
          tool: "bb_test_ping",
          arguments: { ping: true },
        },
      }),
    ).toEqual({
      requestId: "req-1",
      threadId: "t1",
      providerThreadId: "claude-session-1",
      turnId: "turn-1",
      callId: "call-1",
      tool: "bb_test_ping",
      arguments: { ping: true },
    });
  });

  it("decodeToolCallRequest returns null when the request id is missing", () => {
    const adapter = createClaudeCodeProviderAdapter();
    expect(
      adapter.decodeToolCallRequest({
        method: "item/tool/call",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          callId: "call-1",
          tool: "bb_test_ping",
          arguments: { ping: true },
        },
      }),
    ).toBeNull();
  });

  it("decodes Claude permission approval requests into pending interactions", () => {
    const adapter = createClaudeCodeProviderAdapter();

    expect(
      adapter.decodeInteractiveRequest?.({
        id: "req-2",
        method: CLAUDE_PERMISSION_REQUEST_APPROVAL_METHOD,
        params: {
          threadId: "thr_1",
          providerThreadId: "claude-session-1",
          turnId: "turn-provider",
          itemId: "toolu_1",
          toolName: "WebFetch",
          input: { url: "https://example.com" },
          reason: "Needs approval",
          permissions: {
            network: { enabled: true },
            fileSystem: null,
          },
        },
      }),
    ).toEqual({
      requestId: "req-2",
      method: CLAUDE_PERMISSION_REQUEST_APPROVAL_METHOD,
      threadId: "thr_1",
      providerThreadId: "claude-session-1",
      turnId: "turn-provider",
      payload: {
        subject: {
          kind: "permission_grant",
          itemId: "toolu_1",
          toolName: "WebFetch",
          permissions: {
            network: { enabled: true },
            fileSystem: null,
          },
        },
        reason: "Needs approval",
        availableDecisions: ["allow_once", "allow_for_session", "deny"],
      },
    });
  });

  it("fills missing Claude permission approval turn ids from the active turn", () => {
    const adapter = createClaudeCodeProviderAdapter();
    adapter.translateEvent(
      {
        type: "assistant",
        message: {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Read",
              input: { file_path: "/etc/hosts" },
            },
          ],
        },
        session_id: "sess-1",
      },
      { threadId: "thr_1" },
    );

    expect(
      adapter.decodeInteractiveRequest?.({
        id: "req-2",
        method: CLAUDE_PERMISSION_REQUEST_APPROVAL_METHOD,
        params: {
          threadId: "thr_1",
          providerThreadId: "claude-session-1",
          turnId: null,
          itemId: "toolu_1",
          toolName: "Read",
          input: { file_path: "/etc/hosts" },
          reason: "Needs approval",
          permissions: {
            network: null,
            fileSystem: { read: ["/etc/hosts"], write: [] },
          },
        },
      }),
    ).toMatchObject({
      turnId: "turn-1",
      payload: {
        subject: {
          kind: "permission_grant",
          itemId: "toolu_1",
          toolName: "Read",
        },
      },
    });
  });

  it("rejects missing Claude permission approval turn ids without an active turn", () => {
    const adapter = createClaudeCodeProviderAdapter();

    expect(
      adapter.decodeInteractiveRequest?.({
        id: "req-missing-turn",
        method: CLAUDE_PERMISSION_REQUEST_APPROVAL_METHOD,
        params: {
          threadId: "thr_1",
          providerThreadId: "claude-session-1",
          turnId: null,
          itemId: "toolu_1",
          toolName: "Read",
          input: { file_path: "/etc/hosts" },
          reason: "Needs approval",
          permissions: {
            network: null,
            fileSystem: { read: ["/etc/hosts"], write: [] },
          },
        },
      }),
    ).toBeNull();
  });

  it("decodes Claude Bash approvals with command execution scope", () => {
    const adapter = createClaudeCodeProviderAdapter();

    expect(
      adapter.decodeInteractiveRequest?.({
        id: "req-bash",
        method: CLAUDE_PERMISSION_REQUEST_APPROVAL_METHOD,
        params: {
          threadId: "thr_1",
          providerThreadId: "claude-session-1",
          turnId: "turn-bash",
          itemId: "toolu_bash",
          toolName: "Bash",
          input: { command: "git status", cwd: "/tmp/project" },
          reason: "Needs approval",
          permissions: {
            network: null,
            fileSystem: {
              read: ["/tmp/project"],
              write: ["/tmp/project"],
            },
          },
        },
      }),
    ).toMatchObject({
      payload: {
        subject: {
          kind: "command",
          itemId: "toolu_bash",
          command: "git status",
          cwd: "/tmp/project",
          actions: [{ type: "unknown", command: "git status" }],
          sessionGrant: {
            network: null,
            fileSystem: {
              read: ["/tmp/project"],
              write: ["/tmp/project"],
            },
          },
        },
      },
    });
  });

  it("decodes Claude Edit approvals with file-change execution scope", () => {
    const adapter = createClaudeCodeProviderAdapter();

    expect(
      adapter.decodeInteractiveRequest?.({
        id: "req-edit",
        method: CLAUDE_PERMISSION_REQUEST_APPROVAL_METHOD,
        params: {
          threadId: "thr_1",
          providerThreadId: "claude-session-1",
          turnId: "turn-edit",
          itemId: "toolu_edit",
          toolName: "Edit",
          input: {
            file_path: "/tmp/project/README.md",
            old_string: "before",
            new_string: "after",
          },
          reason: "Needs approval",
          permissions: {
            network: null,
            fileSystem: {
              read: [],
              write: ["/tmp/project"],
            },
          },
        },
      }),
    ).toMatchObject({
      payload: {
        subject: {
          kind: "file_change",
          itemId: "toolu_edit",
          writeScope: null,
          sessionGrant: {
            network: null,
            fileSystem: {
              read: [],
              write: ["/tmp/project"],
            },
          },
        },
      },
    });
  });

  it("returns null for malformed Claude permission approval payloads", () => {
    const adapter = createClaudeCodeProviderAdapter();

    expect(
      adapter.decodeInteractiveRequest?.({
        id: "req-2b",
        method: CLAUDE_PERMISSION_REQUEST_APPROVAL_METHOD,
        params: {
          threadId: "thr_1",
          providerThreadId: "claude-session-1",
          turnId: null,
          itemId: "toolu_1",
          toolName: "WebFetch",
          input: { url: "https://example.com" },
          reason: "Needs approval",
          permissions: {
            network: { enabled: "yes" },
            fileSystem: null,
          },
        },
      }),
    ).toBeNull();
  });

  it("builds Claude permission approval responses", () => {
    const adapter = createClaudeCodeProviderAdapter();

    expect(
      adapter.buildInteractiveResponse?.({
        request: {
          requestId: "req-4",
          method: CLAUDE_PERMISSION_REQUEST_APPROVAL_METHOD,
          threadId: "thr_1",
          providerThreadId: "claude-session-1",
          turnId: "turn-1",
          payload: {
            subject: {
              kind: "permission_grant",
              itemId: "toolu_3",
              toolName: "WebFetch",
              permissions: {
                network: { enabled: true },
                fileSystem: null,
              },
            },
            reason: "Needs network",
            availableDecisions: ["allow_once", "allow_for_session", "deny"],
          },
        },
        resolution: {
          decision: "allow_for_session",
          grantedPermissions: {
            network: { enabled: true },
            fileSystem: null,
          },
        },
      }),
    ).toEqual({
      kind: "permission_request",
      behavior: "allow",
      decisionClassification: "user_permanent",
      updatedPermissions: [
        {
          type: "addRules",
          rules: [{ toolName: "WebFetch" }],
          behavior: "allow",
          destination: "session",
        },
      ],
    });
  });

  it("builds Claude session permission updates for command approvals", () => {
    const adapter = createClaudeCodeProviderAdapter();

    expect(
      adapter.buildInteractiveResponse?.({
        request: {
          requestId: "req-4b",
          method: CLAUDE_PERMISSION_REQUEST_APPROVAL_METHOD,
          threadId: "thr_1",
          providerThreadId: "claude-session-1",
          turnId: "turn-1",
          payload: {
            subject: {
              kind: "command",
              itemId: "toolu_3b",
              command: "pwd",
              cwd: null,
              actions: [],
              sessionGrant: {
                network: null,
                fileSystem: {
                  read: ["/tmp/project"],
                  write: ["/tmp/project"],
                },
              },
            },
            reason: "Needs approval",
            availableDecisions: ["allow_once", "allow_for_session", "deny"],
          },
        },
        resolution: {
          decision: "allow_for_session",
          grantedPermissions: {
            network: null,
            fileSystem: {
              read: ["/tmp/project"],
              write: ["/tmp/project"],
            },
          },
        },
      }),
    ).toEqual({
      kind: "permission_request",
      behavior: "allow",
      decisionClassification: "user_permanent",
      updatedPermissions: [
        {
          type: "addDirectories",
          directories: ["/tmp/project"],
          destination: "session",
        },
      ],
    });
  });

  it("builds Claude session directory updates for file-change approvals", () => {
    const adapter = createClaudeCodeProviderAdapter();

    expect(
      adapter.buildInteractiveResponse?.({
        request: {
          requestId: "req-4d",
          method: CLAUDE_PERMISSION_REQUEST_APPROVAL_METHOD,
          threadId: "thr_1",
          providerThreadId: "claude-session-1",
          turnId: "turn-1",
          payload: {
            subject: {
              kind: "file_change",
              itemId: "toolu_3d",
              writeScope: null,
              sessionGrant: {
                network: null,
                fileSystem: {
                  read: [],
                  write: ["/tmp/project"],
                },
              },
            },
            reason: "Needs file access",
            availableDecisions: ["allow_once", "allow_for_session", "deny"],
          },
        },
        resolution: {
          decision: "allow_for_session",
          grantedPermissions: {
            network: null,
            fileSystem: {
              read: [],
              write: ["/tmp/project"],
            },
          },
        },
      }),
    ).toEqual({
      kind: "permission_request",
      behavior: "allow",
      decisionClassification: "user_permanent",
      updatedPermissions: [
        {
          type: "addDirectories",
          directories: ["/tmp/project"],
          destination: "session",
        },
      ],
    });
  });

  it("rejects session-scoped Claude approvals without an explicit resolution grant", () => {
    const adapter = createClaudeCodeProviderAdapter();

    expect(() =>
      adapter.buildInteractiveResponse?.({
        request: {
          requestId: "req-4e",
          method: CLAUDE_PERMISSION_REQUEST_APPROVAL_METHOD,
          threadId: "thr_1",
          providerThreadId: "claude-session-1",
          turnId: "turn-1",
          payload: {
            subject: {
              kind: "file_change",
              itemId: "toolu_3e",
              writeScope: null,
              sessionGrant: null,
            },
            reason: "Needs file access",
            availableDecisions: ["allow_once", "allow_for_session", "deny"],
          },
        },
        resolution: {
          decision: "allow_for_session",
          grantedPermissions: null,
        },
      }),
    ).toThrow("Session approval resolution must include granted permissions");
  });

  it("keeps turn-scoped Claude permission approvals scoped to the current tool request", () => {
    const adapter = createClaudeCodeProviderAdapter();

    expect(
      adapter.buildInteractiveResponse?.({
        request: {
          requestId: "req-4c",
          method: CLAUDE_PERMISSION_REQUEST_APPROVAL_METHOD,
          threadId: "thr_1",
          providerThreadId: "claude-session-1",
          turnId: "turn-1",
          payload: {
            subject: {
              kind: "command",
              itemId: "toolu_3c",
              command: "pwd",
              cwd: null,
              actions: [],
              sessionGrant: null,
            },
            reason: "Needs approval",
            availableDecisions: ["allow_once", "deny"],
          },
        },
        resolution: {
          decision: "allow_once",
          grantedPermissions: null,
        },
      }),
    ).toEqual({
      kind: "permission_request",
      behavior: "allow",
      decisionClassification: "user_temporary",
    });
  });

  // -- translateEvent: assistant messages -----------------------------------

  it("translateEvent emits turn/started + item/completed for assistant message", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const events = adapter.translateEvent({
      type: "assistant",
      message: {
        id: "msg-1",
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/started",
        scope: turnScope("turn-1"),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "agentMessage",
          id: "msg-1",
          text: "Hello world",
        }),
      }),
    );
  });

  it("translateEvent keeps assistant message ids distinct within one turn", () => {
    const adapter = createClaudeCodeProviderAdapter();

    const firstEvents = adapter.translateEvent({
      type: "assistant",
      message: {
        id: "msg-1",
        role: "assistant",
        content: [{ type: "text", text: "Now let me read the main files:" }],
      },
      session_id: "sess-1",
    });

    const secondEvents = adapter.translateEvent({
      type: "assistant",
      message: {
        id: "msg-2",
        role: "assistant",
        content: [{ type: "text", text: "Now let me read the test file:" }],
      },
      session_id: "sess-1",
    });

    expect(firstEvents).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "agentMessage",
          id: "msg-1",
          text: "Now let me read the main files:",
        }),
      }),
    );
    expect(secondEvents).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "agentMessage",
          id: "msg-2",
          text: "Now let me read the test file:",
        }),
      }),
    );
  });

  it("translateEvent emits item/started for tool use blocks", () => {
    const adapter = createClaudeCodeProviderAdapter();
    // First send an assistant message to start a turn
    adapter.translateEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Let me check" }],
      },
      session_id: "sess-1",
    });

    const events = adapter.translateEvent({
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
          id: "tool-1",
          status: "pending",
        }),
      }),
    );
  });

  it("translateEvent falls back to a generic tool call when Bash args are malformed", () => {
    const adapter = createClaudeCodeProviderAdapter();
    adapter.translateEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Let me check" }],
      },
      session_id: "sess-1",
    });

    const events = adapter.translateEvent({
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
          id: "tool-1",
          tool: "Bash",
          status: "pending",
        }),
      }),
    );
  });

  it("translateEvent maps WebSearch and WebFetch tool uses into web items", () => {
    const adapter = createClaudeCodeProviderAdapter();

    const events = adapter.translateEvent({
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
          id: "tool-search-1",
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
          id: "tool-fetch-1",
          url: "https://example.com",
          prompt: null,
          pattern: null,
          resultText: null,
        }),
      }),
    );
  });

  it("translateEvent preserves completed WebSearch result text", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.translateEvent({
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

    const events = adapter.translateEvent({
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
          id: "tool-search-1",
          queries: ["react suspense"],
          resultText: "Found the Suspense docs",
        }),
      }),
    );
  });

  it("translateEvent preserves completed WebFetch result text and prompt", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.translateEvent({
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

    const events = adapter.translateEvent({
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
          id: "tool-fetch-1",
          url: "https://example.com",
          prompt: "page title",
          pattern: null,
          resultText: "Example Domain",
        }),
      }),
    );
  });

  it("translateEvent ignores rate limit events", () => {
    const adapter = createClaudeCodeProviderAdapter();

    const events = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "claude-thread-1",
        message: {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed",
            rateLimitType: "five_hour",
            overageStatus: "rejected",
            overageDisabledReason: "out_of_credits",
          },
        },
      },
    });

    expect(events).toMatchObject([]);
  });

  it("translateEvent ignores task-updated system events from the SDK envelope", () => {
    const adapter = createClaudeCodeProviderAdapter();

    const events = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "claude-thread-1",
        message: {
          type: "system",
          subtype: "task_updated",
          task_id: "task-1",
          patch: {
            is_backgrounded: true,
          },
        },
      },
    });

    expect(events).toMatchObject([]);
  });

  it("translateEvent maps thread identity envelopes", () => {
    const adapter = createClaudeCodeProviderAdapter();

    const events = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "thread/identity",
      params: {
        threadId: "bb-thread-1",
        providerThreadId: "claude-thread-1",
      },
    });

    expect(events).toEqual([
      {
        type: "thread/identity",
        threadId: "bb-thread-1",
        providerThreadId: "claude-thread-1",
        scope: threadScope(),
      },
    ]);
  });

  it("translateEvent maps error envelopes", () => {
    const adapter = createClaudeCodeProviderAdapter();

    const events = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "error",
      params: {
        message: "bridge failed",
      },
    });

    expect(events).toEqual([
      {
        type: "provider/error",
        threadId: "",
        providerThreadId: "",
        scope: threadScope(),
        message: "Provider error",
        detail: "bridge failed",
      },
    ]);
  });

  it("translateEvent completes a failed turn for thread-scoped bridge errors", () => {
    const adapter = createClaudeCodeProviderAdapter();

    const events = adapter.translateEvent(
      {
        jsonrpc: "2.0",
        method: "error",
        params: {
          message: "Claude auth expired",
        },
      },
      { threadId: "bb-thread-1" },
    );

    expect(events).toEqual([
      {
        type: "turn/started",
        threadId: "",
        providerThreadId: "",
        scope: turnScope("turn-1"),
      },
      {
        type: "provider/error",
        threadId: "",
        providerThreadId: "",
        scope: turnScope("turn-1"),
        message: "Provider error",
        detail: "Claude auth expired",
      },
      {
        type: "turn/completed",
        threadId: "",
        providerThreadId: "",
        scope: turnScope("turn-1"),
        status: "failed",
      },
    ]);
  });

  it("translateEvent marks Claude result events with is_error as failed", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.translateEvent({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "claude-thread-1",
        message: {
          type: "assistant",
          message: {
            id: "assistant-1",
            content: [
              {
                type: "text",
                text: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded. https://docs.claude.com/en/api/errors"},"request_id":"req_123"}',
              },
            ],
          },
        },
      },
    });

    const events = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "claude-thread-1",
        message: {
          type: "result",
          subtype: "success",
          is_error: true,
          result:
            'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded. https://docs.claude.com/en/api/errors"},"request_id":"req_123"}',
          usage: {},
          modelUsage: {},
        },
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope("turn-1"),
        status: "failed",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider/error",
        message: "Provider error",
      }),
    );
  });

  it("translateEvent falls back to provider/unhandled for unknown sdk envelopes", () => {
    const adapter = createClaudeCodeProviderAdapter();

    const events = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "bb-thread-1",
        message: {
          type: "custom_event",
        },
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/unhandled",
        threadId: "bb-thread-1",
        providerThreadId: "bb-thread-1",
        providerId: "claude-code",
        rawType: "sdk/custom_event",
        scope: threadScope(),
        rawEvent: expect.objectContaining({
          method: "sdk/message",
        }),
      }),
    ]);
  });

  it("translateEvent ignores sdk user text echoes", () => {
    const adapter = createClaudeCodeProviderAdapter();

    const events = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "bb-thread-1",
        message: {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "This session is being continued from a previous conversation.",
              },
            ],
          },
          parent_tool_use_id: null,
          session_id: "sess-1",
          uuid: "user-message-1",
          timestamp: "2026-05-03T07:53:31.543Z",
          isSynthetic: true,
        },
      },
    });

    expect(events).toEqual([]);
  });

  it("translateEvent preserves the active turn on unknown sdk envelopes", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.translateEvent(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Working on it." }],
        },
        session_id: "sess-1",
      },
      { threadId: "bb-thread-1" },
    );

    const events = adapter.translateEvent(
      {
        jsonrpc: "2.0",
        method: "sdk/message",
        params: {
          threadId: "bb-thread-1",
          message: {
            type: "custom_event",
          },
        },
      },
      { threadId: "bb-thread-1" },
    );

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/unhandled",
        threadId: "bb-thread-1",
        scope: turnScope("turn-1"),
        rawType: "sdk/custom_event",
      }),
    ]);
  });

  it("translateEvent surfaces malformed handled sdk envelopes as provider/unhandled", () => {
    const adapter = createClaudeCodeProviderAdapter();

    const events = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "claude-thread-1",
        message: {
          type: "result",
        },
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "claude-code",
        rawType: "sdk/result",
        scope: threadScope(),
        rawEvent: expect.objectContaining({
          method: "sdk/message",
        }),
      }),
    ]);
  });

  it("translateEvent emits fileChange items with diffs for Edit tool uses", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.translateEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Let me patch that" }],
      },
      session_id: "sess-1",
    });

    const events = adapter.translateEvent({
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
          id: "tool-edit-1",
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

  it("translateEvent marks content-only Write tool uses as add changes", () => {
    const adapter = createClaudeCodeProviderAdapter();

    const events = adapter.translateEvent({
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
      id: "tool-write-1",
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

  it("translateEvent preserves structured Agent arguments on tool calls", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.translateEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Let me delegate that" }],
      },
      session_id: "sess-1",
    });

    const events = adapter.translateEvent({
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
        item: expect.objectContaining({
          type: "toolCall",
          id: "tool-agent-1",
          tool: "Agent",
          status: "pending",
          arguments: expect.objectContaining({
            subagent_type: "Explore",
            description: "Inspect the docs tree",
            prompt: "List every markdown file",
          }),
        }),
      }),
    );
  });

  it("translateEvent preserves structured Read, Grep, and Glob arguments on tool calls", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.translateEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Let me inspect the repo" }],
      },
      session_id: "sess-1",
    });

    const events = adapter.translateEvent({
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
        item: expect.objectContaining({
          type: "toolCall",
          id: "tool-read-1",
          tool: "Read",
          arguments: expect.objectContaining({
            file_path: "src/index.ts",
          }),
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "toolCall",
          id: "tool-grep-1",
          tool: "Grep",
          arguments: expect.objectContaining({
            pattern: "TODO",
            path: "src",
          }),
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "toolCall",
          id: "tool-glob-1",
          tool: "Glob",
          arguments: expect.objectContaining({
            pattern: "**/*.ts",
            path: "src",
          }),
        }),
      }),
    );
  });

  it("translateEvent falls back to generic tool calls for malformed structured args", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.translateEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Let me inspect that" }],
      },
      session_id: "sess-1",
    });

    const events = adapter.translateEvent({
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
          id: "tool-read-bad-1",
          tool: "Read",
          status: "pending",
        }),
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          id: "tool-read-bad-1",
          arguments: expect.anything(),
        }),
      }),
    );
  });

  it("translateEvent preserves parent_tool_use_id on nested sdk/message events", () => {
    const adapter = createClaudeCodeProviderAdapter();

    const events = adapter.translateEvent({
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
          id: "tool-1",
          parentToolCallId: "agent-parent-1",
        }),
      }),
    );
  });

  // -- translateEvent: stream events ---------------------------------------

  it("translateEvent emits item/agentMessage/delta for stream text", () => {
    const adapter = createClaudeCodeProviderAdapter();
    // Start a turn first
    adapter.translateEvent({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "x" }] },
      session_id: "sess-1",
    });

    const events = adapter.translateEvent({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "streaming..." },
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/agentMessage/delta",
        itemId: expect.stringMatching(/^claude-assistant-/),
        delta: "streaming...",
      }),
    );
  });

  it("translateEvent reuses the streamed assistant item id when the final assistant arrives", () => {
    const adapter = createClaudeCodeProviderAdapter();

    const deltaEvents = adapter.translateEvent({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "PONG" },
      },
      session_id: "sess-1",
    });
    const deltaEvent = deltaEvents.find(
      (
        event,
      ): event is Extract<
        (typeof deltaEvents)[number],
        { type: "item/agentMessage/delta" }
      > => event.type === "item/agentMessage/delta",
    );

    const assistantEvents = adapter.translateEvent({
      type: "assistant",
      message: {
        id: "provider-msg-1",
        role: "assistant",
        content: [{ type: "text", text: "PONG" }],
      },
      session_id: "sess-1",
    });

    expect(deltaEvent?.itemId).toMatch(/^claude-assistant-/);
    expect(assistantEvents).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "agentMessage",
          id: deltaEvent?.itemId,
          text: "PONG",
        }),
      }),
    );
  });

  it("translateEvent starts a turn when stream text arrives before the assistant envelope", () => {
    const adapter = createClaudeCodeProviderAdapter();

    const events = adapter.translateEvent({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "PONG" },
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/started",
        scope: turnScope("turn-1"),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/agentMessage/delta",
        itemId: expect.stringMatching(/^claude-assistant-/),
        scope: turnScope("turn-1"),
        delta: "PONG",
      }),
    );
  });

  it("translateEvent streams thinking and finalizes it on the assistant message", () => {
    const adapter = createClaudeCodeProviderAdapter();

    const deltaEvents = adapter.translateEvent({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "thinking_delta",
          thinking: "Let me inspect this first.",
        },
      },
      session_id: "sess-1",
    });
    const reasoningDelta = deltaEvents.find(
      (
        event,
      ): event is Extract<
        (typeof deltaEvents)[number],
        { type: "item/reasoning/textDelta" }
      > => event.type === "item/reasoning/textDelta",
    );

    const assistantEvents = adapter.translateEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Let me inspect this first.",
          },
        ],
      },
      session_id: "sess-1",
    });

    expect(reasoningDelta?.itemId).toMatch(/^claude-reasoning-/);
    expect(assistantEvents).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "reasoning",
          id: reasoningDelta?.itemId,
          content: ["Let me inspect this first."],
        }),
      }),
    );
  });

  // -- translateEvent: result (turn complete) -------------------------------

  it("translateEvent emits turn/completed on result message", () => {
    const adapter = createClaudeCodeProviderAdapter();
    // Start a turn
    adapter.translateEvent({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      session_id: "sess-1",
    });

    const events = adapter.translateEvent({
      type: "result",
      subtype: "end_turn",
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope("turn-1"),
        status: "completed",
      }),
    );
  });

  it("translateEvent emits failed status for error result", () => {
    const adapter = createClaudeCodeProviderAdapter();
    // Start a turn
    adapter.translateEvent({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "x" }] },
      session_id: "sess-1",
    });

    const events = adapter.translateEvent({
      type: "result",
      subtype: "error",
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        status: "failed",
      }),
    );
  });

  // -- translateEvent: tool results ----------------------------------------

  it("translateEvent emits item/completed for user tool results", () => {
    const adapter = createClaudeCodeProviderAdapter();
    // Start a turn
    adapter.translateEvent({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "x" }] },
      session_id: "sess-1",
    });

    const events = adapter.translateEvent({
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
          id: "tool-1",
          status: "completed",
        }),
      }),
    );
  });

  it("translateEvent marks Bash tool results with is_error as failed", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.translateEvent({
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

    const events = adapter.translateEvent({
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
          id: "tool-1",
          command: "npm test",
          cwd: "/repo",
          aggregatedOutput: "command failed",
          exitCode: 1,
          status: "failed",
        }),
      }),
    );
  });

  it("translateEvent prefers Claude stdout/stderr over placeholder Bash content", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.translateEvent({
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

    const events = adapter.translateEvent({
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
          id: "tool-1",
          command: "printf hi",
          cwd: "/repo",
          aggregatedOutput: "hi\n",
          status: "completed",
        }),
      }),
    );
  });

  it("translateEvent strips Claude no-output placeholders when stdout/stderr are empty", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.translateEvent({
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

    const events = adapter.translateEvent({
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
      id: "tool-1",
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

  it("translateEvent inserts a newline between Claude stdout and stderr", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.translateEvent({
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

    const events = adapter.translateEvent({
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
          id: "tool-1",
          aggregatedOutput: "hi\nwarn\n",
          status: "completed",
        }),
      }),
    );
  });

  it("translateEvent falls back to Claude content when tool_use_result streams are empty", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.translateEvent({
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

    const events = adapter.translateEvent({
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
          id: "tool-1",
          command: "cat output.txt",
          cwd: "/repo",
          aggregatedOutput: "file output\n",
          status: "completed",
        }),
      }),
    );
  });

  it("translateEvent preserves string tool_use_result errors for Bash completions", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.translateEvent({
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

    const events = adapter.translateEvent({
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
          id: "tool-1",
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

  it("translateEvent recovers missing tool names from prior tool uses", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.translateEvent({
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

    const events = adapter.translateEvent({
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
          id: "tool-1",
          status: "completed",
        }),
      }),
    );
  });

  it("translateEvent surfaces late tool results without turn context as unhandled", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.translateEvent(
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

    adapter.translateEvent(
      {
        type: "result",
        subtype: "end_turn",
        session_id: "sess-1",
      },
      { threadId: "thread-1" },
    );

    const events = adapter.translateEvent(
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

  // -- translateEvent: system message --------------------------------------

  it("translateEvent returns empty for non-compaction system messages", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const events = adapter.translateEvent({
      type: "system",
      subtype: "init",
      session_id: "sess-1",
    });
    expect(events).toMatchObject([]);
  });

  it("translateEvent status compacting starts a turn and emits a compaction item", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const events = adapter.translateEvent({
      type: "system",
      subtype: "status",
      status: "compacting",
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/started",
        threadId: "",
        providerThreadId: "",
        scope: turnScope("turn-1"),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        threadId: "",
        providerThreadId: "",
        scope: turnScope("turn-1"),
        item: {
          type: "contextCompaction",
          id: "claude-compaction-turn-1",
        },
      }),
    );
  });

  it("translateEvent compact_boundary emits thread/compacted", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.translateEvent({
      type: "system",
      subtype: "status",
      status: "compacting",
      session_id: "sess-1",
    });

    const events = adapter.translateEvent({
      type: "system",
      subtype: "compact_boundary",
      session_id: "sess-1",
      compact_metadata: {
        pre_tokens: 199622,
        trigger: "auto",
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/compacted",
        threadId: "",
        providerThreadId: "",
        scope: turnScope("turn-1"),
      }),
    );
  });

  it("translateEvent compact_boundary without a known turn is unhandled", () => {
    const adapter = createClaudeCodeProviderAdapter();

    const events = adapter.translateEvent({
      type: "system",
      subtype: "compact_boundary",
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider/unhandled",
      }),
    );
  });

  // -- translateEvent: multiple turns --------------------------------------

  it("translateEvent increments turn IDs across turns", () => {
    const adapter = createClaudeCodeProviderAdapter();

    // Turn 1
    adapter.translateEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "first" }],
      },
      session_id: "sess-1",
    });
    adapter.translateEvent({
      type: "result",
      subtype: "end_turn",
      session_id: "sess-1",
    });

    // Turn 2
    const events = adapter.translateEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "second" }],
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/started",
        scope: turnScope("turn-2"),
      }),
    );
  });

  // -- translateEvent: real SDK fixtures ------------------------------------

  it("fixture: assistant-text produces turn/started + item/completed agentMessage", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const events = adapter.translateEvent(loadFixture("assistant-text.json"));

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/started",
        scope: turnScope("turn-1"),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "agentMessage",
          text: expect.stringContaining("refactor that function"),
        }),
      }),
    );
  });

  it("fixture: assistant-tool-use produces agentMessage + commandExecution item", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const events = adapter.translateEvent(
      loadFixture("assistant-tool-use.json"),
    );

    // Should have turn/started, item/completed (text), item/started (tool)
    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn/started" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({ type: "agentMessage" }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "commandExecution",
          id: "toolu_01AbCdEfGhIjKlMnOpQrStUv",
          command: "ls -la src/",
          status: "pending",
        }),
      }),
    );
  });

  it("fixture: assistant-file-edit produces fileChange item", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const events = adapter.translateEvent(
      loadFixture("assistant-file-edit.json"),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "fileChange",
          status: "pending",
          changes: [
            expect.objectContaining({
              path: "/Users/developer/project/src/utils/format.ts",
              diff: expect.stringContaining("toLocaleDateString"),
            }),
          ],
        }),
      }),
    );
  });

  it("fixture: stream-text-delta produces agentMessage delta", () => {
    const adapter = createClaudeCodeProviderAdapter();
    // Start a turn first
    adapter.translateEvent(loadFixture("assistant-text.json"));

    const events = adapter.translateEvent(
      loadFixture("stream-text-delta.json"),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/agentMessage/delta",
        delta: expect.any(String),
      }),
    );
  });

  it("fixture: result-success produces request context usage, token usage, and turn/completed", () => {
    const adapter = createClaudeCodeProviderAdapter();
    // Start a turn first
    adapter.translateEvent(loadFixture("assistant-text.json"));

    const events = adapter.translateEvent(loadFixture("result-success.json"));

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/tokenUsage/updated",
        tokenUsage: expect.objectContaining({
          total: expect.objectContaining({
            inputTokens: 8420,
            outputTokens: 1253,
          }),
          modelContextWindow: 200000,
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/contextWindowUsage/updated",
        contextWindowUsage: {
          usedTokens: 2_723,
          modelContextWindow: 200000,
          estimated: true,
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope("turn-1"),
        status: "completed",
      }),
    );
  });

  it("uses the latest Claude request context for context-window usage while keeping aggregate token usage", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.translateEvent({
      type: "assistant",
      message: {
        type: "message",
        role: "assistant",
        content: [],
        usage: {
          input_tokens: 1,
          cache_read_input_tokens: 49_000,
          cache_creation_input_tokens: 999,
          output_tokens: 120,
        },
      },
    });
    adapter.translateEvent({
      type: "assistant",
      message: {
        type: "message",
        role: "assistant",
        content: [],
        usage: {
          input_tokens: 1,
          cache_read_input_tokens: 51_908,
          cache_creation_input_tokens: 300,
          output_tokens: 164,
        },
      },
    });

    const events = adapter.translateEvent({
      type: "result",
      subtype: "success",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      num_turns: 1,
      result: "ok",
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: {
        input_tokens: 16,
        cache_read_input_tokens: 704_436,
        cache_creation_input_tokens: 0,
        output_tokens: 2_544,
      },
      modelUsage: {
        "claude-opus-4-7": {
          contextWindow: 1_000_000,
        },
      },
      session_id: "session-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/tokenUsage/updated",
        tokenUsage: expect.objectContaining({
          last: expect.objectContaining({
            totalTokens: 706_996,
            inputTokens: 16,
            cachedInputTokens: 704_436,
            outputTokens: 2_544,
          }),
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/contextWindowUsage/updated",
        contextWindowUsage: {
          usedTokens: 52_209,
          modelContextWindow: 1_000_000,
          estimated: true,
        },
      }),
    );
  });

  it("clears the latest Claude request context when a non-assistant event starts the next turn", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.translateEvent(loadFixture("assistant-text.json"), {
      threadId: "bb-thread-1",
    });
    adapter.translateEvent(loadFixture("result-success.json"), {
      threadId: "bb-thread-1",
    });
    adapter.translateEvent(
      {
        type: "system",
        subtype: "status",
        status: "compacting",
        session_id: "session-1",
      },
      {
        threadId: "bb-thread-1",
      },
    );

    const events = adapter.translateEvent(
      {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: "ok",
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 40,
        },
        session_id: "session-1",
      },
      {
        threadId: "bb-thread-1",
      },
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/contextWindowUsage/updated",
        contextWindowUsage: {
          usedTokens: null,
          modelContextWindow: 200000,
          estimated: true,
        },
      }),
    );
  });

  it("fixture: result-success accumulates Claude token usage across turns", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.translateEvent(loadFixture("assistant-text.json"));
    const firstTurnEvents = adapter.translateEvent(
      loadFixture("result-success.json"),
    );

    adapter.translateEvent(loadFixture("assistant-text.json"));
    const secondTurnEvents = adapter.translateEvent(
      loadFixture("result-success.json"),
    );

    const firstTokenUsage = firstTurnEvents.find(
      (
        event,
      ): event is Extract<
        (typeof firstTurnEvents)[number],
        { type: "thread/tokenUsage/updated" }
      > => event.type === "thread/tokenUsage/updated",
    );
    const secondTokenUsage = secondTurnEvents.find(
      (
        event,
      ): event is Extract<
        (typeof secondTurnEvents)[number],
        { type: "thread/tokenUsage/updated" }
      > => event.type === "thread/tokenUsage/updated",
    );

    expect(firstTokenUsage?.tokenUsage.last).toMatchObject({
      totalTokens: 16685,
      inputTokens: 8420,
      outputTokens: 1253,
      cachedInputTokens: 7012,
    });
    expect(secondTokenUsage?.tokenUsage.total).toMatchObject({
      totalTokens: 33370,
      inputTokens: 16840,
      outputTokens: 2506,
      cachedInputTokens: 14024,
    });
    expect(secondTokenUsage?.tokenUsage.last).toEqual(
      firstTokenUsage?.tokenUsage.last,
    );
  });

  it("falls back to a model-based context window when Claude omits modelUsage.contextWindow", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.buildCommandPlan({
      type: "thread/start",
      threadId: "bb-thread-1",
      cwd: "/tmp/worktree",
      input: [{ type: "text", text: "hello" }],
      instructionMode: "append",
      options: {
        ...fullProviderExecutionContext,
        model: "claude-opus-4-7[1m]",
      },
    });
    adapter.translateEvent(loadFixture("assistant-text.json"), {
      threadId: "bb-thread-1",
    });

    const events = adapter.translateEvent(
      {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: "ok",
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 40,
        },
        session_id: "session-1",
      },
      {
        threadId: "bb-thread-1",
      },
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/contextWindowUsage/updated",
        contextWindowUsage: {
          usedTokens: 2_723,
          modelContextWindow: 1_000_000,
          estimated: true,
        },
      }),
    );
  });

  it("keeps Claude context-window capacity unknown when no model hint exists", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.translateEvent(loadFixture("assistant-text.json"), {
      threadId: "bb-thread-unknown",
    });

    const events = adapter.translateEvent(
      {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: "ok",
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 40,
        },
        session_id: "session-1",
      },
      {
        threadId: "bb-thread-unknown",
      },
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/contextWindowUsage/updated",
        contextWindowUsage: {
          usedTokens: 2_723,
          modelContextWindow: null,
          estimated: true,
        },
      }),
    );
  });

  it("keeps Claude context-window capacity unknown for the ambiguous default model alias", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.buildCommandPlan({
      type: "thread/start",
      threadId: "bb-thread-default",
      cwd: "/tmp/worktree",
      input: [{ type: "text", text: "hello" }],
      instructionMode: "append",
      options: {
        ...fullProviderExecutionContext,
        model: "default",
      },
    });
    adapter.translateEvent(loadFixture("assistant-text.json"), {
      threadId: "bb-thread-default",
    });

    const events = adapter.translateEvent(
      {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: "ok",
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 40,
        },
        session_id: "session-1",
      },
      {
        threadId: "bb-thread-default",
      },
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/contextWindowUsage/updated",
        contextWindowUsage: {
          usedTokens: 2_723,
          modelContextWindow: null,
          estimated: true,
        },
      }),
    );
  });

  it("reuses the last known Claude context window when a later result omits modelUsage.contextWindow", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.translateEvent(loadFixture("assistant-text.json"), {
      threadId: "bb-thread-1",
    });
    adapter.translateEvent(loadFixture("result-success.json"), {
      threadId: "bb-thread-1",
    });

    adapter.translateEvent(loadFixture("assistant-text.json"), {
      threadId: "bb-thread-1",
    });

    const events = adapter.translateEvent(
      {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: "ok",
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 40,
        },
        session_id: "session-1",
      },
      {
        threadId: "bb-thread-1",
      },
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/contextWindowUsage/updated",
        contextWindowUsage: {
          usedTokens: 2_723,
          modelContextWindow: 200000,
          estimated: true,
        },
      }),
    );
  });

  it("fixture: user-tool-result produces commandExecution completed", () => {
    const adapter = createClaudeCodeProviderAdapter();
    // Start a turn first
    adapter.translateEvent(loadFixture("assistant-text.json"));

    const events = adapter.translateEvent(loadFixture("user-tool-result.json"));

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "commandExecution",
          status: "completed",
        }),
      }),
    );
  });

  it("fixture: user-tool-result-generic produces toolCall completed", () => {
    const adapter = createClaudeCodeProviderAdapter();
    // Start a turn first
    adapter.translateEvent(loadFixture("assistant-text.json"));

    const events = adapter.translateEvent(
      loadFixture("user-tool-result-generic.json"),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "toolCall",
          status: "completed",
        }),
      }),
    );
  });

  it("fixture: system-init produces no events", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const events = adapter.translateEvent(loadFixture("system-init.json"));
    expect(events).toMatchObject([]);
  });
});

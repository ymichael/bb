import { describe, expect, it } from "vitest";
import {
  createHostDaemonClient,
  hostDaemonCommandEnvelopeSchema,
  hostDaemonCommandResultSchemaByType,
  hostDaemonCommandsQuerySchema,
  hostDaemonCommandSchema,
  hostDaemonDaemonWsMessageSchema,
  hostDaemonEventBatchRequestSchema,
  hostDaemonEventBatchResponseSchema,
  hostDaemonServerWsMessageSchema,
  hostDaemonSessionOpenRequestSchema,
  hostDaemonSessionOpenResponseSchema,
} from "../src/index.js";

describe("host-daemon command schemas", () => {
  it("parses valid workspace and provisioning commands", () => {
    expect(
      hostDaemonCommandSchema.parse({
        type: "workspace.commit",
        environmentId: "env_123",
        workspacePath: "/tmp/workspace",
        threadId: "thr_123",
        message: "Checkpoint work",
        includeUnstaged: true,
      }),
    ).toMatchObject({
      type: "workspace.commit",
      message: "Checkpoint work",
    });

    expect(
      hostDaemonCommandSchema.parse({
        type: "environment.provision",
        environmentId: "env_123",
        projectId: "proj_123",
        workspaceProvisionType: "managed-worktree",
        sourcePath: "/tmp/project",
        targetPath: "/tmp/project/.bb/env",
        branchName: "bb/env-123",
      }),
    ).toMatchObject({
      type: "environment.provision",
      workspaceProvisionType: "managed-worktree",
    });

    expect(
      hostDaemonCommandEnvelopeSchema.parse({
        id: "hcmd_123",
        cursor: 7,
        command: {
          type: "workspace.commit",
          environmentId: "env_123",
          workspacePath: "/tmp/workspace",
          threadId: "thr_123",
          message: "Checkpoint work",
        },
      }),
    ).toMatchObject({
      id: "hcmd_123",
      cursor: 7,
    });
  });

  it("parses thread.start with workspacePath", () => {
    expect(
      hostDaemonCommandSchema.parse({
        type: "thread.start",
        environmentId: "env_123",
        threadId: "thr_123",
        workspacePath: "/tmp/workspace",
        projectId: "proj_123",
        providerId: "codex",
        options: {
          instructions: "You are a manager.",
        },
        dynamicTools: [
          {
            name: "message_user",
            description: "Send a user-visible update",
            inputSchema: { type: "object" },
          },
        ],
      }),
    ).toMatchObject({
      type: "thread.start",
      workspacePath: "/tmp/workspace",
      options: {
        instructions: "You are a manager.",
      },
    });
  });

  it("parses thread.resume with workspacePath", () => {
    expect(
      hostDaemonCommandSchema.parse({
        type: "thread.resume",
        environmentId: "env_123",
        threadId: "thr_123",
        workspacePath: "/tmp/workspace",
        projectId: "proj_123",
        providerId: "codex",
      }),
    ).toMatchObject({
      type: "thread.resume",
      workspacePath: "/tmp/workspace",
    });
  });

  it("requires eventSequence and runtime context for turn.run and turn.steer", () => {
    expect(
      hostDaemonCommandSchema.parse({
        type: "turn.run",
        environmentId: "env_123",
        threadId: "thr_123",
        workspacePath: "/tmp/workspace",
        projectId: "proj_123",
        providerId: "codex",
        providerThreadId: "provider_123",
        eventSequence: 12,
        input: [{ type: "text", text: "hello" }],
      }),
    ).toMatchObject({
      type: "turn.run",
      eventSequence: 12,
      workspacePath: "/tmp/workspace",
    });

    expect(
      hostDaemonCommandSchema.parse({
        type: "turn.steer",
        environmentId: "env_123",
        threadId: "thr_123",
        workspacePath: "/tmp/workspace",
        projectId: "proj_123",
        providerId: "codex",
        providerThreadId: "provider_123",
        eventSequence: 13,
        expectedTurnId: "turn_123",
        input: [{ type: "text", text: "adjust" }],
      }),
    ).toMatchObject({
      type: "turn.steer",
      eventSequence: 13,
      expectedTurnId: "turn_123",
    });

    expect(() =>
      hostDaemonCommandSchema.parse({
        type: "turn.run",
        environmentId: "env_123",
        threadId: "thr_123",
        workspacePath: "/tmp/workspace",
        projectId: "proj_123",
        providerId: "codex",
        input: [{ type: "text", text: "hello" }],
      }),
    ).toThrow();
  });

  it("parses promote and demote commands", () => {
    expect(
      hostDaemonCommandSchema.parse({
        type: "workspace.promote",
        environmentId: "env_123",
        workspacePath: "/tmp/workspace",
        threadId: "thr_123",
        primaryPath: "/tmp/primary",
      }),
    ).toMatchObject({
      type: "workspace.promote",
      primaryPath: "/tmp/primary",
    });

    expect(
      hostDaemonCommandSchema.parse({
        type: "workspace.demote",
        environmentId: "env_123",
        workspacePath: "/tmp/workspace",
        threadId: "thr_123",
        primaryPath: "/tmp/primary",
        defaultBranch: "main",
        envBranch: "bb/env-abc",
      }),
    ).toMatchObject({
      type: "workspace.demote",
      defaultBranch: "main",
      envBranch: "bb/env-abc",
    });
  });

  it("keeps typed per-command result schemas", () => {
    expect(
      hostDaemonCommandResultSchemaByType["workspace.promote"].parse({
        ok: true,
      }),
    ).toMatchObject({
      ok: true,
    });

    expect(
      hostDaemonCommandResultSchemaByType["workspace.demote"].parse({
        ok: true,
      }),
    ).toMatchObject({
      ok: true,
    });

    expect(() =>
      hostDaemonCommandResultSchemaByType["workspace.commit"].parse({
        commitSha: "",
      }),
    ).toThrow();
  });

  it("includes discovered workspace properties in environment.provision result", () => {
    expect(
      hostDaemonCommandResultSchemaByType["environment.provision"].parse({
        path: "/tmp/env",
        isGitRepo: true,
        isWorktree: true,
        branchName: "bb/env-123",
        ranSetup: true,
      }),
    ).toMatchObject({
      isGitRepo: true,
      isWorktree: true,
      branchName: "bb/env-123",
    });
  });
});

describe("host-daemon session schemas", () => {
  it("parses valid session open and event batch payloads", () => {
    expect(
      hostDaemonSessionOpenRequestSchema.parse({
        hostId: "host_123",
        instanceId: "instance_1",
        hostName: "Michael's MacBook",
        hostType: "persistent",
        protocolVersion: 2,
        activeThreads: [
          {
            environmentId: "env_123",
            threadId: "thr_123",
            providerThreadId: "provider_thr_123",
          },
        ],
      }),
    ).toMatchObject({
      hostId: "host_123",
      hostType: "persistent",
    });

    expect(
      hostDaemonCommandsQuerySchema.parse({
        sessionId: "session_123",
        afterCursor: "12",
      }),
    ).toMatchObject({
      sessionId: "session_123",
    });

    expect(
      hostDaemonSessionOpenResponseSchema.parse({
        sessionId: "session_123",
        heartbeatIntervalMs: 5_000,
        leaseTimeoutMs: 30_000,
        threadHighWaterMarks: { thr_123: 10 },
      }),
    ).toMatchObject({
      sessionId: "session_123",
      threadHighWaterMarks: { thr_123: 10 },
    });

    expect(
      hostDaemonEventBatchRequestSchema.parse({
        sessionId: "session_123",
        events: [
          {
            id: "evt_1",
            environmentId: "env_123",
            threadId: "thr_123",
            sequence: 1,
            createdAt: 1,
            event: {
              type: "system/error",
              threadId: "thr_123",
              message: "boom",
            },
          },
        ],
      }),
    ).toMatchObject({
      sessionId: "session_123",
      events: [
        {
          id: "evt_1",
        },
      ],
    });

    expect(
      hostDaemonEventBatchResponseSchema.parse({
        threadHighWaterMarks: {
          thr_123: 42,
        },
      }),
    ).toEqual({
      threadHighWaterMarks: {
        thr_123: 42,
      },
    });
  });

  it("restricts websocket messages to notifications and heartbeats", () => {
    expect(
      hostDaemonServerWsMessageSchema.parse({
        type: "commands-available",
      }),
    ).toEqual({ type: "commands-available" });

    expect(
      hostDaemonServerWsMessageSchema.parse({
        type: "session-close",
        reason: "replaced",
      }),
    ).toMatchObject({
      type: "session-close",
      reason: "replaced",
    });

    expect(
      hostDaemonServerWsMessageSchema.parse({
        type: "session-close",
        reason: "daemon-disconnect",
      }),
    ).toMatchObject({
      type: "session-close",
      reason: "daemon-disconnect",
    });

    expect(() =>
      hostDaemonServerWsMessageSchema.parse({
        type: "session-close",
        reason: "shutdown",
      }),
    ).toThrow();

    expect(
      hostDaemonDaemonWsMessageSchema.parse({
        type: "heartbeat",
        bufferDepth: 3,
        lastCommandCursor: 12,
      }),
    ).toMatchObject({
      type: "heartbeat",
    });
  });

  it("builds an internal client rooted at /internal", () => {
    const client = createHostDaemonClient("http://localhost:3334", "secret");

    expect(client.session.open.$url().pathname).toBe("/internal/session/open");
    expect(client.session.commands.$url().pathname).toBe(
      "/internal/session/commands",
    );
    expect(client.session["command-result"].$url().pathname).toBe(
      "/internal/session/command-result",
    );
  });
});

import { collectOptionalFieldPaths } from "@bb/test-helpers";
import { describe, expect, it } from "vitest";
import * as contract from "../src/index.js";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  createHostDaemonClient,
  hostDaemonEnrollRequestSchema,
  hostDaemonEnrollResponseSchema,
  hostDaemonCommandEnvelopeSchema,
  hostDaemonCommandResultSchemaByType,
  hostDaemonCommandsQuerySchema,
  hostDaemonCommandSchema,
  hostDaemonDaemonWsMessageSchema,
  hostDaemonEnvironmentChangeRequestSchema,
  hostDaemonEventBatchRequestSchema,
  hostDaemonEventBatchResponseSchema,
  hostDaemonServerWsMessageSchema,
  hostDaemonSessionOpenRequestSchema,
  hostDaemonSessionOpenResponseSchema,
} from "../src/index.js";

const INTENTIONAL_OPTIONAL_HOST_DAEMON_FIELDS: Record<string, string> = {
  "hostDaemonCommandSchema.maxDiffBytes": "workspace.diff may omit maxDiffBytes to use the system default cap.",
  "hostDaemonCommandSchema.maxFileListBytes": "workspace.diff may omit maxFileListBytes to use the system default cap.",
  "hostDaemonCommandSchema.mergeBaseBranch": "workspace.status may omit mergeBaseBranch when the caller only needs working-tree state.",
  "hostDaemonCommandSchema.options.approvalPolicy": "Daemon command metadata may omit approval policy when the server does not need to override the default.",
  "hostDaemonCommandSchema.options.seq": "Daemon command metadata may omit sequence when the command source does not assign one.",
  "hostDaemonCommandSchema.options.source": "Daemon command metadata may omit source when the command origin is not being tracked.",
  "hostDaemonCommandSchema.query": "host.list_files and workspace.list_files may omit a search string to list files without filtering.",
  "hostDaemonCommandSchema.threadStoragePath": "thread.start may include a storage path for manager threads so the daemon creates the directory before the agent starts.",
};

describe("host-daemon local schemas", () => {
  it("parses workspace open target routes", () => {
    expect(
      contract.workspaceOpenTargetSchema.parse({
        id: "vscode",
        label: "VS Code",
      }),
    ).toEqual({
      id: "vscode",
      label: "VS Code",
    });

    expect(
      contract.workspaceOpenTargetsResponseSchema.parse({
        targets: [
          {
            id: "finder",
            label: "Finder",
          },
          {
            id: "terminal",
            label: "Terminal",
          },
        ],
      }),
    ).toEqual({
      targets: [
        {
          id: "finder",
          label: "Finder",
        },
        {
          id: "terminal",
          label: "Terminal",
        },
      ],
    });

    expect(
      contract.openWorkspaceRequestSchema.parse({
        path: "/tmp/workspace",
        targetId: "zed",
      }),
    ).toEqual({
      path: "/tmp/workspace",
      targetId: "zed",
    });
  });

  it("rejects malformed workspace open payloads", () => {
    expect(() =>
      contract.workspaceOpenTargetSchema.parse({
        id: "unknown-editor",
        label: "Unknown",
      }),
    ).toThrow();

    expect(() =>
      contract.workspaceOpenTargetsResponseSchema.parse({
        targets: [
          {
            id: "vscode",
            label: "",
          },
        ],
      }),
    ).toThrow();

    expect(() =>
      contract.openWorkspaceRequestSchema.parse({
        path: "/tmp/workspace",
      }),
    ).toThrow();
  });
});

describe("host-daemon command schemas", () => {
  it("parses valid workspace and provisioning commands", () => {
    expect(
      hostDaemonEnrollRequestSchema.parse({
        hostId: "host_123",
        hostName: "test-host",
        hostType: "persistent",
      }),
    ).toMatchObject({
      hostId: "host_123",
      hostType: "persistent",
    });

    expect(
      hostDaemonEnrollResponseSchema.parse({
        hostId: "host_123",
        hostKey: "bbdh_example",
      }),
    ).toMatchObject({
      hostId: "host_123",
    });

    expect(
      hostDaemonCommandSchema.parse({
        type: "workspace.commit",
        environmentId: "env_123",
        environmentStatus: "ready",
        workspaceContext: { workspacePath: "/tmp/workspace", workspaceProvisionType: "unmanaged" },
        threadId: "thr_123",
        message: "Checkpoint work",
      }),
    ).toMatchObject({
      type: "workspace.commit",
      message: "Checkpoint work",
    });

    expect(
      hostDaemonCommandSchema.parse({
        type: "environment.provision",
        environmentId: "env_123",
        initiator: { threadId: "thr_123", eventSequence: 0 },
        workspaceProvisionType: "managed-worktree",
        sourcePath: "/tmp/project",
        targetPath: "/tmp/project/.bb/env",
        branchName: "bb/env-123",
        setupTimeoutMs: 900000,
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
          environmentStatus: "ready",
          workspaceContext: { workspacePath: "/tmp/workspace", workspaceProvisionType: "unmanaged" },
          threadId: "thr_123",
          message: "Checkpoint work",
        },
      }),
    ).toMatchObject({
      id: "hcmd_123",
      cursor: 7,
    });

    expect(
      hostDaemonCommandSchema.parse({
        type: "workspace.list_files",
        environmentId: "env_123",
        environmentStatus: "ready",
        workspaceContext: { workspacePath: "/tmp/workspace", workspaceProvisionType: "unmanaged" },
        limit: 1000,
      }),
    ).toMatchObject({
      type: "workspace.list_files",
      workspaceContext: { workspacePath: "/tmp/workspace", workspaceProvisionType: "unmanaged" },
      limit: 1000,
    });

    expect(
      hostDaemonCommandSchema.parse({
        type: "host.read_file",
        path: "/tmp/bb-data/thread-storage/thread-123/PREFERENCES.md",
        rootPath: "/tmp/bb-data/thread-storage/thread-123",
      }),
    ).toMatchObject({
      type: "host.read_file",
      path: "/tmp/bb-data/thread-storage/thread-123/PREFERENCES.md",
      rootPath: "/tmp/bb-data/thread-storage/thread-123",
    });

    expect(
      hostDaemonCommandSchema.parse({
        type: "host.list_files",
        path: "/tmp/bb-data/thread-storage/thread-123",
        limit: 100,
      }),
    ).toMatchObject({
      type: "host.list_files",
      path: "/tmp/bb-data/thread-storage/thread-123",
      limit: 100,
    });

    expect(
      contract.hostRuntimeMaterialSnapshotSchema.parse({
        env: {
          OPENAI_API_KEY: "test-openai-key",
        },
        files: [
          {
            contents: "{}\n",
            managedBy: "bb-runtime-material",
            mode: 0o600,
            path: "~/.codex/auth.json",
          },
        ],
        version: "runtime-version-1",
      }),
    ).toMatchObject({
      files: [
        {
          managedBy: "bb-runtime-material",
          mode: 0o600,
          path: "~/.codex/auth.json",
        },
      ],
      version: "runtime-version-1",
    });

    expect(
      hostDaemonCommandSchema.parse({
        type: "host.sync_runtime_material",
        version: "runtime-version-1",
      }),
    ).toMatchObject({
      type: "host.sync_runtime_material",
      version: "runtime-version-1",
    });
  });

  it("rejects malformed environment.provision commands at parse time", () => {
    expect(() =>
      hostDaemonCommandSchema.parse({
        type: "environment.provision",
        environmentId: "env_123",
        initiator: null,
        workspaceProvisionType: "managed-worktree",
        sourcePath: "/tmp/project",
        targetPath: "/tmp/project/.bb/env",
      }),
    ).toThrow();

    expect(() =>
      hostDaemonCommandSchema.parse({
        type: "environment.provision",
        environmentId: "env_123",
        initiator: null,
        workspaceProvisionType: "unmanaged",
      }),
    ).toThrow();

    expect(() =>
      hostDaemonCommandSchema.parse({
        type: "host.read_file",
        path: "/tmp/bb-data/thread-storage/thread-123/PREFERENCES.md",
      }),
    ).toThrow();
  });

  it("requires environmentId on thread and turn commands", () => {
    expect(() =>
      hostDaemonCommandSchema.parse({
        type: "thread.start",
        threadId: "thr_123",
        workspaceContext: {
          workspacePath: "/tmp/workspace",
          workspaceProvisionType: "unmanaged",
        },
        projectId: "proj_123",
        providerId: "codex",
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          sandboxMode: "danger-full-access",
        },
        instructions: "Be concise.",
        dynamicTools: [],
        instructionMode: "append",
        eventSequence: 0,
        input: [{ type: "text", text: "hello" }],
      }),
    ).toThrow();

    expect(() =>
      hostDaemonCommandSchema.parse({
        type: "turn.run",
        threadId: "thr_123",
        eventSequence: 1,
        input: [{ type: "text", text: "follow up" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          sandboxMode: "danger-full-access",
        },
        resumeContext: {
          workspaceContext: {
            workspacePath: "/tmp/workspace",
            workspaceProvisionType: "unmanaged",
          },
          projectId: "proj_123",
          providerId: "codex",
          providerThreadId: "prov_123",
          instructions: "Be concise.",
          dynamicTools: [],
          instructionMode: "append",
        },
      }),
    ).toThrow();
  });

  it("parses thread.start with workspacePath", () => {
    expect(
      hostDaemonCommandSchema.parse({
        type: "thread.start",
        environmentId: "env_123",
        threadId: "thr_123",
        workspaceContext: { workspacePath: "/tmp/workspace", workspaceProvisionType: "unmanaged" },
        projectId: "proj_123",
        providerId: "codex",
        eventSequence: 1,
        input: [{ type: "text", text: "hello" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          sandboxMode: "danger-full-access",
        },
        instructions: "Be a helpful manager.",
        dynamicTools: [
          {
            name: "message_user",
            description: "Send a user-visible update",
            inputSchema: { type: "object" },
          },
        ],
        instructionMode: "replace",
      }),
    ).toMatchObject({
      type: "thread.start",
      workspaceContext: { workspacePath: "/tmp/workspace", workspaceProvisionType: "unmanaged" },
    });
  });

  it("keeps contract optional fields on an explicit allowlist", () => {
    const optionalFieldPaths = collectOptionalFieldPaths({
      hostDaemonActiveThreadSchema: contract.hostDaemonActiveThreadSchema,
      hostDaemonCommandSchema: contract.hostDaemonCommandSchema,
      workspaceCommitResultSchema:
        contract.hostDaemonCommandResultSchemaByType["workspace.commit"],
      workspaceSquashMergeResultSchema:
        contract.hostDaemonCommandResultSchemaByType["workspace.squash_merge"],
    });

    expect(optionalFieldPaths).toEqual(
      Object.keys(INTENTIONAL_OPTIONAL_HOST_DAEMON_FIELDS).sort(),
    );
    expect(
      Object.values(INTENTIONAL_OPTIONAL_HOST_DAEMON_FIELDS).every(
        (reason) => reason.trim().length > 0,
      ),
    ).toBe(true);
  });

  it("requires eventSequence and resumeContext for turn.run and turn.steer", () => {
    expect(
      hostDaemonCommandSchema.parse({
        type: "turn.run",
        environmentId: "env_123",
        threadId: "thr_123",
        eventSequence: 12,
        input: [{ type: "text", text: "hello" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          sandboxMode: "danger-full-access",
        },
        resumeContext: {
          workspaceContext: { workspacePath: "/tmp/workspace", workspaceProvisionType: "unmanaged" },
          projectId: "proj_123",
          providerId: "codex",
          providerThreadId: "provider_123",
          instructions: "Be a helpful coding agent.",
          dynamicTools: [],
          instructionMode: "append",
        },
      }),
    ).toMatchObject({
      type: "turn.run",
      eventSequence: 12,
      resumeContext: {
        workspaceContext: { workspacePath: "/tmp/workspace", workspaceProvisionType: "unmanaged" },
      },
    });

    expect(
      hostDaemonCommandSchema.parse({
        type: "turn.steer",
        environmentId: "env_123",
        threadId: "thr_123",
        eventSequence: 13,
        expectedTurnId: "turn_123",
        input: [{ type: "text", text: "adjust" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          sandboxMode: "danger-full-access",
        },
        resumeContext: {
          workspaceContext: { workspacePath: "/tmp/workspace", workspaceProvisionType: "unmanaged" },
          projectId: "proj_123",
          providerId: "codex",
          providerThreadId: "provider_123",
          instructions: "Be a helpful coding agent.",
          dynamicTools: [],
          instructionMode: "append",
        },
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
        input: [{ type: "text", text: "hello" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          sandboxMode: "danger-full-access",
        },
        resumeContext: {
          workspaceContext: { workspacePath: "/tmp/workspace", workspaceProvisionType: "unmanaged" },
          projectId: "proj_123",
          providerId: "codex",
          instructions: "Be a helpful coding agent.",
          dynamicTools: [],
        },
      }),
    ).toThrow();
  });

  it("parses promote and demote commands", () => {
    expect(
      hostDaemonCommandSchema.parse({
        type: "workspace.promote",
        environmentId: "env_123",
        environmentStatus: "ready",
        workspaceContext: { workspacePath: "/tmp/workspace", workspaceProvisionType: "unmanaged" },
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
        environmentStatus: "ready",
        workspaceContext: { workspacePath: "/tmp/workspace", workspaceProvisionType: "unmanaged" },
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

    expect(
      hostDaemonCommandResultSchemaByType["host.list_files"].parse({
        files: [{ path: "notes/today.md", name: "today.md" }],
        truncated: false,
      }),
    ).toMatchObject({
      files: [{ path: "notes/today.md", name: "today.md" }],
      truncated: false,
    });

    expect(
      hostDaemonCommandResultSchemaByType["host.read_file"].parse({
        path: "/tmp/bb-data/thread-storage/thread-123/PREFERENCES.md",
        content: "# Preferences",
        contentEncoding: "utf8",
        mimeType: "text/markdown",
        sizeBytes: 13,
      }),
    ).toMatchObject({
      path: "/tmp/bb-data/thread-storage/thread-123/PREFERENCES.md",
      content: "# Preferences",
      contentEncoding: "utf8",
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
        defaultBranch: "main",
        transcript: [{ type: "step", key: "setup", text: "/bin/bash .bb-env-setup.sh", status: "completed" }],
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
        dataDir: "/tmp/bb-data",
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        activeThreads: [
          {
            threadId: "thr_123",
          },
        ],
      }),
    ).toMatchObject({
      hostId: "host_123",
      hostType: "persistent",
    });

    expect(() =>
      hostDaemonSessionOpenRequestSchema.parse({
        hostId: "host_123",
        instanceId: "instance_1",
        hostName: "Michael's MacBook",
        hostType: "persistent",
        dataDir: "/tmp/bb-data",
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        activeThreads: [
          {
            threadId: "",
          },
        ],
      }),
    ).toThrow();

    expect(
      hostDaemonCommandsQuerySchema.parse({
        sessionId: "session_123",
        limit: "100",
        waitMs: "0",
      }),
    ).toMatchObject({
      sessionId: "session_123",
    });

    expect(
      hostDaemonSessionOpenResponseSchema.parse({
        sessionId: "session_123",
        heartbeatIntervalMs: 5_000,
        leaseTimeoutMs: 30_000,
        trackedThreadTargets: [
          {
            environmentId: "env_123",
            threadId: "thr_123",
          },
        ],
        threadHighWaterMarks: { thr_123: 10 },
      }),
    ).toMatchObject({
      sessionId: "session_123",
      trackedThreadTargets: [
        {
          environmentId: "env_123",
          threadId: "thr_123",
        },
      ],
      threadHighWaterMarks: { thr_123: 10 },
    });

    expect(
      hostDaemonEventBatchRequestSchema.parse({
        sessionId: "session_123",
        events: [
          {
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
          threadId: "thr_123",
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

    expect(
      hostDaemonEnvironmentChangeRequestSchema.parse({
        sessionId: "session_123",
        environmentId: "env_123",
        change: "work-status-changed",
      }),
    ).toEqual({
      sessionId: "session_123",
      environmentId: "env_123",
      change: "work-status-changed",
    });

    expect(
      hostDaemonEnvironmentChangeRequestSchema.parse({
        sessionId: "session_123",
        environmentId: "env_123",
        change: "git-refs-changed",
      }),
    ).toEqual({
      sessionId: "session_123",
      environmentId: "env_123",
      change: "git-refs-changed",
    });

    expect(
      hostDaemonEnvironmentChangeRequestSchema.parse({
        sessionId: "session_123",
        environmentId: "env_123",
        change: "thread-storage-changed",
      }),
    ).toEqual({
      sessionId: "session_123",
      environmentId: "env_123",
      change: "thread-storage-changed",
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
      }),
    ).toMatchObject({
      type: "heartbeat",
    });

    expect(() =>
      hostDaemonDaemonWsMessageSchema.parse({
        type: "heartbeat",
        bufferDepth: 0,
      }),
    ).toThrow();
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
    expect(client.session["environment-change"].$url().pathname).toBe(
      "/internal/session/environment-change",
    );
  });
});

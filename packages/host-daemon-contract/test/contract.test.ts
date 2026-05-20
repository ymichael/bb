import { collectOptionalFieldPaths } from "@bb/test-helpers";
import { threadScope } from "@bb/domain";
import { describe, expect, it } from "vitest";
import * as contract from "../src/index.js";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  TERMINAL_COLS_MAX,
  TERMINAL_DATA_MAX_BASE64_LENGTH,
  TERMINAL_DATA_MAX_BYTES,
  TERMINAL_ROWS_MAX,
  createHostDaemonClient,
  hostDaemonEnrollRequestSchema,
  hostDaemonEnrollResponseSchema,
  hostDaemonCommandEnvelopeSchema,
  hostDaemonCommandResultResponseSchema,
  hostDaemonCommandResultSchemaByType,
  hostDaemonCommandsQuerySchema,
  hostDaemonCommandSchema,
  hostDaemonDaemonWsMessageSchema,
  hostDaemonEnvironmentChangeRequestSchema,
  hostDaemonEventBatchRequestSchema,
  hostDaemonEventBatchResponseSchema,
  hostDaemonInteractiveInterruptRequestSchema,
  hostDaemonInteractiveInterruptResponseSchema,
  hostDaemonInteractiveRequestResponseSchema,
  hostDaemonInteractiveRequestSchema,
  hostDaemonServerWsMessageSchema,
  hostDaemonSessionOpenRequestSchema,
  hostDaemonSessionOpenResponseSchema,
  hostDaemonTerminalOutputChunkSchema,
} from "../src/index.js";

const PRODUCER_EVENT_ID = "hdevt_23456789abcdefghijkm";
const CLIENT_REQUEST_ID = "creq_23456789ab";

function terminalDataBase64(byteLength: number): string {
  return Buffer.alloc(byteLength, "a").toString("base64");
}

const INTENTIONAL_OPTIONAL_HOST_DAEMON_FIELDS: Record<string, string> = {
  "hostDaemonCommandSchema.checkout":
    "environment.provision only includes checkout instructions for unmanaged workspaces that requested a branch mutation.",
  "hostDaemonCommandSchema.mergeBaseBranch":
    "workspace.status may omit mergeBaseBranch when the caller only needs working-tree state.",
  "hostDaemonCommandSchema.query":
    "host.list_files may omit a search string to list files without filtering.",
  "hostDaemonCommandSchema.ref":
    "host.read_file may omit ref to read from disk; setting ref switches to git history at that ref.",
  "hostDaemonCommandSchema.rootPath":
    "host.read_file and host.file_metadata may omit rootPath only for explicit absolute disk reads; ref-based reads still require it.",
  "hostDaemonCommandSchema.threadStoragePath":
    "thread.start may include a storage path for manager threads so the daemon creates the directory before the agent starts.",
  "hostDaemonCommandSchema.disallowedTools":
    "manager thread runtime context may omit provider-specific built-in tool removals for providers that do not need them.",
  "hostDaemonCommandSchema.resumeContext.disallowedTools":
    "turn.submit resume context may omit provider-specific built-in tool removals for providers that do not need them.",
};

describe("host-daemon local schemas", () => {
  it("parses workspace open target routes", () => {
    expect(
      contract.workspaceOpenTargetSchema.parse({
        id: "vscode",
        kind: "editor",
        label: "VS Code",
      }),
    ).toEqual({
      id: "vscode",
      kind: "editor",
      label: "VS Code",
    });

    expect(
      contract.workspaceOpenTargetsResponseSchema.parse({
        targets: [
          {
            id: "finder",
            kind: "file-browser",
            label: "Finder",
          },
          {
            id: "terminal",
            kind: "terminal",
            label: "Terminal",
          },
        ],
      }),
    ).toEqual({
      targets: [
        {
          id: "finder",
          kind: "file-browser",
          label: "Finder",
        },
        {
          id: "terminal",
          kind: "terminal",
          label: "Terminal",
        },
      ],
    });

    expect(
      contract.openInTargetRequestSchema.parse({
        lineNumber: 12,
        path: "/tmp/workspace",
        targetId: "zed",
      }),
    ).toEqual({
      lineNumber: 12,
      path: "/tmp/workspace",
      targetId: "zed",
    });
  });

  it("rejects malformed workspace open payloads", () => {
    expect(() =>
      contract.workspaceOpenTargetSchema.parse({
        id: "unknown-editor",
        kind: "editor",
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
      contract.openInTargetRequestSchema.parse({
        path: "/tmp/workspace",
      }),
    ).toThrow();

    expect(() =>
      contract.openInTargetRequestSchema.parse({
        lineNumber: 0,
        path: "/tmp/workspace",
        targetId: "zed",
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
        workspaceContext: {
          workspacePath: "/tmp/workspace",
          workspaceProvisionType: "unmanaged",
        },
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
        initiator: {
          threadId: "thr_123",
          provisioningId: "tpv_123",
        },
        workspaceProvisionType: "managed-worktree",
        sourcePath: "/tmp/project",
        targetPath: "/tmp/project/.bb/env",
        branchName: "bb/env-123",
        baseBranch: null,
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
          workspaceContext: {
            workspacePath: "/tmp/workspace",
            workspaceProvisionType: "unmanaged",
          },
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
        type: "host.list_files",
        path: "/tmp/workspace",
        limit: 1000,
      }),
    ).toMatchObject({
      type: "host.list_files",
      path: "/tmp/workspace",
      limit: 1000,
    });

    expect(
      hostDaemonCommandSchema.parse({
        type: "host.list_paths",
        path: "/tmp/workspace",
        limit: 1000,
        includeFiles: true,
        includeDirectories: true,
      }),
    ).toMatchObject({
      type: "host.list_paths",
      path: "/tmp/workspace",
      limit: 1000,
      includeFiles: true,
      includeDirectories: true,
    });

    expect(
      hostDaemonCommandSchema.parse({
        type: "host.list_branches",
        path: "/tmp/workspace",
      }),
    ).toMatchObject({
      type: "host.list_branches",
      path: "/tmp/workspace",
    });

    expect(
      hostDaemonCommandSchema.parse({
        type: "host.file_metadata",
        path: "/tmp/bb-data/thread-storage/thread-123/PREFERENCES.md",
        rootPath: "/tmp/bb-data/thread-storage/thread-123",
      }),
    ).toMatchObject({
      type: "host.file_metadata",
      path: "/tmp/bb-data/thread-storage/thread-123/PREFERENCES.md",
      rootPath: "/tmp/bb-data/thread-storage/thread-123",
    });

    expect(
      hostDaemonCommandSchema.parse({
        type: "host.status_version",
        sources: [
          {
            source: "folder",
            rootPath: "/tmp/bb-data/thread-storage/thread-123/STATUS",
            indexPath: "index.html",
            dotfiles: "deny",
          },
          {
            source: "html",
            rootPath: "/tmp/bb-data/thread-storage/thread-123",
            path: "STATUS.html",
            dotfiles: "allow",
          },
          {
            source: "md",
            rootPath: "/tmp/bb-data/thread-storage/thread-123",
            path: "STATUS.md",
            dotfiles: "allow",
          },
        ],
      }),
    ).toMatchObject({
      type: "host.status_version",
      sources: [
        { source: "folder", indexPath: "index.html", dotfiles: "deny" },
        { source: "html", path: "STATUS.html", dotfiles: "allow" },
        { source: "md", path: "STATUS.md", dotfiles: "allow" },
      ],
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
        type: "host.read_file",
        path: "/tmp/bb-data/thread-storage/thread-123/PREFERENCES.md",
      }),
    ).toMatchObject({
      type: "host.read_file",
      path: "/tmp/bb-data/thread-storage/thread-123/PREFERENCES.md",
    });

    expect(
      hostDaemonCommandSchema.parse({
        type: "host.read_file",
        path: "/tmp/bb-data/thread-storage/thread-123/PREFERENCES.md",
        rootPath: "/tmp/bb-data/thread-storage/thread-123",
        ref: "HEAD",
      }),
    ).toMatchObject({
      type: "host.read_file",
      path: "/tmp/bb-data/thread-storage/thread-123/PREFERENCES.md",
      rootPath: "/tmp/bb-data/thread-storage/thread-123",
      ref: "HEAD",
    });

    expect(
      hostDaemonCommandSchema.parse({
        type: "host.read_file_relative",
        rootPath: "/tmp/bb-data/thread-storage/thread-123/STATUS",
        path: "assets/logo.png",
        dotfiles: "deny",
      }),
    ).toMatchObject({
      type: "host.read_file_relative",
      rootPath: "/tmp/bb-data/thread-storage/thread-123/STATUS",
      path: "assets/logo.png",
      dotfiles: "deny",
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
      hostDaemonCommandSchema.parse({
        type: "interactive.resolve",
        environmentId: "env_123",
        threadId: "thr_123",
        interactionId: "pint_123",
        providerId: "codex",
        providerThreadId: "provider-thread-123",
        providerRequestId: "request-123",
        resolution: {
          decision: "allow_for_session",
          grantedPermissions: null,
        },
      }),
    ).toMatchObject({
      type: "interactive.resolve",
      interactionId: "pint_123",
      resolution: {
        decision: "allow_for_session",
      },
    });

    expect(
      hostDaemonCommandSchema.parse({
        type: "codex.inference.complete",
        model: "gpt-5.4-mini",
        prompt: "Return a JSON object with a short title.",
        outputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["title"],
          properties: {
            title: { type: "string" },
          },
        },
        timeoutMs: 10000,
      }),
    ).toMatchObject({
      type: "codex.inference.complete",
      model: "gpt-5.4-mini",
    });

    expect(
      hostDaemonCommandSchema.parse({
        type: "codex.voice.transcribe",
        model: "gpt-4o-mini-transcribe",
        audioBase64: Buffer.from("audio").toString("base64"),
        mimeType: "audio/webm",
        filename: "prompt.webm",
        prompt: null,
        timeoutMs: 30000,
      }),
    ).toMatchObject({
      type: "codex.voice.transcribe",
      model: "gpt-4o-mini-transcribe",
      mimeType: "audio/webm",
    });
  });

  it("rejects old provider-agnostic AI command names", () => {
    expect(() =>
      hostDaemonCommandSchema.parse({
        type: "inference.complete",
        model: "gpt-5.4-mini",
        prompt: "Return a title",
        outputSchema: { type: "object" },
        timeoutMs: 10000,
      }),
    ).toThrow();

    expect(() =>
      hostDaemonCommandSchema.parse({
        type: "voice.transcribe",
        model: "gpt-4o-mini-transcribe",
        audioBase64: Buffer.from("audio").toString("base64"),
        mimeType: "audio/webm",
        filename: "prompt.webm",
        prompt: null,
        timeoutMs: 30000,
      }),
    ).toThrow();
  });

  it("requires Codex inference schemas and results to be JSON objects", () => {
    for (const outputSchema of [null, "object", ["object"]]) {
      expect(() =>
        hostDaemonCommandSchema.parse({
          type: "codex.inference.complete",
          model: "gpt-5.4-mini",
          prompt: "Return a title",
          outputSchema,
          timeoutMs: 10000,
        }),
      ).toThrow();
    }

    expect(() =>
      hostDaemonCommandResultSchemaByType["codex.inference.complete"].parse({
        model: "gpt-5.4-mini",
        value: null,
      }),
    ).toThrow();

    expect(
      hostDaemonCommandResultSchemaByType["codex.inference.complete"].parse({
        model: "gpt-5.4-mini",
        value: { title: "Short title" },
      }),
    ).toEqual({
      model: "gpt-5.4-mini",
      value: { title: "Short title" },
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
        ref: "HEAD",
      }),
    ).toThrow();

    expect(() =>
      hostDaemonCommandSchema.parse({
        type: "host.read_file_relative",
        rootPath: "/tmp/bb-data/thread-storage/thread-123/STATUS",
        path: "assets/logo.png",
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
          permissionMode: "full",
          permissionEscalation: null,
        },
        instructions: "Be concise.",
        dynamicTools: [],
        instructionMode: "append",
        requestId: CLIENT_REQUEST_ID,
        input: [{ type: "text", text: "hello" }],
      }),
    ).toThrow();

    expect(() =>
      hostDaemonCommandSchema.parse({
        type: "turn.submit",
        threadId: "thr_123",
        requestId: CLIENT_REQUEST_ID,
        input: [{ type: "text", text: "follow up" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
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
        target: { mode: "start" },
      }),
    ).toThrow();
  });

  it("parses thread.start with workspacePath", () => {
    expect(
      hostDaemonCommandSchema.parse({
        type: "thread.start",
        environmentId: "env_123",
        threadId: "thr_123",
        workspaceContext: {
          workspacePath: "/tmp/workspace",
          workspaceProvisionType: "unmanaged",
        },
        projectId: "proj_123",
        providerId: "codex",
        requestId: CLIENT_REQUEST_ID,
        input: [{ type: "text", text: "hello" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
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
      workspaceContext: {
        workspacePath: "/tmp/workspace",
        workspaceProvisionType: "unmanaged",
      },
    });
  });

  it("keeps contract optional fields on an explicit allowlist", () => {
    const optionalFieldPaths = collectOptionalFieldPaths({
      hostDaemonActiveThreadSchema: contract.hostDaemonActiveThreadSchema,
      hostDaemonCommandSchema: contract.hostDaemonCommandSchema,
      hostDaemonInteractiveRequestSchema:
        contract.hostDaemonInteractiveRequestSchema,
      hostDaemonInteractiveRequestResponseSchema:
        contract.hostDaemonInteractiveRequestResponseSchema,
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

  it("requires requestId, resumeContext, and target for turn.submit", () => {
    expect(
      hostDaemonCommandSchema.parse({
        type: "turn.submit",
        environmentId: "env_123",
        threadId: "thr_123",
        requestId: CLIENT_REQUEST_ID,
        input: [{ type: "text", text: "hello" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        resumeContext: {
          workspaceContext: {
            workspacePath: "/tmp/workspace",
            workspaceProvisionType: "unmanaged",
          },
          projectId: "proj_123",
          providerId: "codex",
          providerThreadId: "provider_123",
          instructions: "Be a helpful coding agent.",
          dynamicTools: [],
          instructionMode: "append",
        },
        target: { mode: "start" },
      }),
    ).toMatchObject({
      type: "turn.submit",
      requestId: CLIENT_REQUEST_ID,
      resumeContext: {
        workspaceContext: {
          workspacePath: "/tmp/workspace",
          workspaceProvisionType: "unmanaged",
        },
      },
      target: { mode: "start" },
    });

    expect(
      hostDaemonCommandSchema.parse({
        type: "turn.submit",
        environmentId: "env_123",
        threadId: "thr_123",
        requestId: CLIENT_REQUEST_ID,
        input: [{ type: "text", text: "adjust" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        resumeContext: {
          workspaceContext: {
            workspacePath: "/tmp/workspace",
            workspaceProvisionType: "unmanaged",
          },
          projectId: "proj_123",
          providerId: "codex",
          providerThreadId: "provider_123",
          instructions: "Be a helpful coding agent.",
          dynamicTools: [],
          instructionMode: "append",
        },
        target: { mode: "auto", expectedTurnId: "turn_123" },
      }),
    ).toMatchObject({
      type: "turn.submit",
      requestId: CLIENT_REQUEST_ID,
      target: { mode: "auto", expectedTurnId: "turn_123" },
    });

    expect(() =>
      hostDaemonCommandSchema.parse({
        type: "turn.submit",
        environmentId: "env_123",
        threadId: "thr_123",
        input: [{ type: "text", text: "hello" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        resumeContext: {
          workspaceContext: {
            workspacePath: "/tmp/workspace",
            workspaceProvisionType: "unmanaged",
          },
          projectId: "proj_123",
          providerId: "codex",
          instructions: "Be a helpful coding agent.",
          dynamicTools: [],
        },
        target: { mode: "start" },
      }),
    ).toThrow();

    expect(() =>
      hostDaemonCommandSchema.parse({
        type: "thread.start",
        environmentId: "env_123",
        threadId: "thr_123",
        workspaceContext: {
          workspacePath: "/tmp/workspace",
          workspaceProvisionType: "unmanaged",
        },
        projectId: "proj_123",
        providerId: "codex",
        requestId: CLIENT_REQUEST_ID,
        input: [{ type: "text", text: "hello" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        instructions: "Be concise.",
        dynamicTools: [],
      }),
    ).toThrow();
  });

  it("rejects old eventSequence command fields", () => {
    expect(() =>
      hostDaemonCommandSchema.parse({
        type: "thread.start",
        environmentId: "env_123",
        threadId: "thr_123",
        workspaceContext: {
          workspacePath: "/tmp/workspace",
          workspaceProvisionType: "unmanaged",
        },
        projectId: "proj_123",
        providerId: "codex",
        requestId: CLIENT_REQUEST_ID,
        eventSequence: 1,
        input: [{ type: "text", text: "hello" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        instructions: "Be concise.",
        dynamicTools: [],
        instructionMode: "append",
      }),
    ).toThrow();

    expect(() =>
      hostDaemonCommandSchema.parse({
        type: "turn.submit",
        environmentId: "env_123",
        threadId: "thr_123",
        requestId: CLIENT_REQUEST_ID,
        eventSequence: 2,
        input: [{ type: "text", text: "hello" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        resumeContext: {
          workspaceContext: {
            workspacePath: "/tmp/workspace",
            workspaceProvisionType: "unmanaged",
          },
          projectId: "proj_123",
          providerId: "codex",
          providerThreadId: "provider_123",
          instructions: "Be a helpful coding agent.",
          dynamicTools: [],
          instructionMode: "append",
        },
        target: { mode: "start" },
      }),
    ).toThrow();

    expect(() =>
      hostDaemonCommandSchema.parse({
        type: "environment.provision",
        environmentId: "env_123",
        initiator: {
          threadId: "thr_123",
          provisioningId: "tpv_123",
          eventSequence: 3,
        },
        workspaceProvisionType: "managed-worktree",
        sourcePath: "/tmp/project",
        targetPath: "/tmp/project/.bb/env",
        branchName: "bb/env-123",
        setupTimeoutMs: 900000,
      }),
    ).toThrow();
  });

  it("requires replay.run request correlation", () => {
    expect(
      hostDaemonCommandSchema.parse({
        type: "replay.run",
        captureId: "cap_123",
        environmentId: "env_123",
        threadId: "thr_123",
        requestId: CLIENT_REQUEST_ID,
        speed: 10,
      }),
    ).toMatchObject({
      type: "replay.run",
      requestId: CLIENT_REQUEST_ID,
    });

    expect(() =>
      hostDaemonCommandSchema.parse({
        type: "replay.run",
        captureId: "cap_123",
        environmentId: "env_123",
        threadId: "thr_123",
        speed: 10,
      }),
    ).toThrow();
  });

  it("bounds file list command queries and limits", () => {
    const longQuery = "a".repeat(contract.FILE_LIST_QUERY_MAX_LENGTH + 1);

    expect(() =>
      hostDaemonCommandSchema.parse({
        type: "host.list_files",
        path: "/tmp/bb-data/thread-storage/thread-123",
        query: longQuery,
        limit: 100,
      }),
    ).toThrow();

    expect(() =>
      hostDaemonCommandSchema.parse({
        type: "host.list_files",
        path: "/tmp/bb-data/thread-storage/thread-123",
        limit: contract.FILE_LIST_LIMIT_MAX + 1,
      }),
    ).toThrow();

    expect(() =>
      hostDaemonCommandSchema.parse({
        type: "host.list_files",
        path: "/tmp/workspace",
        query: longQuery,
        limit: 100,
      }),
    ).toThrow();

    expect(() =>
      hostDaemonCommandSchema.parse({
        type: "host.list_files",
        path: "/tmp/workspace",
        limit: contract.FILE_LIST_LIMIT_MAX + 1,
      }),
    ).toThrow();

    expect(() =>
      hostDaemonCommandSchema.parse({
        type: "host.list_paths",
        path: "/tmp/workspace",
        query: longQuery,
        limit: 100,
        includeFiles: true,
        includeDirectories: true,
      }),
    ).toThrow();

    expect(() =>
      hostDaemonCommandSchema.parse({
        type: "host.list_paths",
        path: "/tmp/workspace",
        limit: contract.FILE_LIST_LIMIT_MAX + 1,
        includeFiles: true,
        includeDirectories: true,
      }),
    ).toThrow();

    expect(() =>
      hostDaemonCommandSchema.parse({
        type: "host.list_paths",
        path: "/tmp/workspace",
        limit: 100,
        includeFiles: false,
        includeDirectories: false,
      }),
    ).toThrow();
  });

  it("keeps typed per-command result schemas", () => {
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
      hostDaemonCommandResultSchemaByType["host.list_paths"].parse({
        paths: [
          {
            kind: "directory",
            path: "notes",
            name: "notes",
            score: 0,
            positions: [],
          },
          {
            kind: "file",
            path: "notes/today.md",
            name: "today.md",
            score: 240,
            positions: [0, 1, 2],
          },
        ],
        truncated: false,
      }),
    ).toMatchObject({
      paths: [
        { kind: "directory", path: "notes" },
        { kind: "file", path: "notes/today.md" },
      ],
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

    expect(
      hostDaemonCommandResultSchemaByType["host.read_file_relative"].parse({
        path: "assets/logo.png",
        content: "iVBORw0KGgo=",
        contentEncoding: "base64",
        mimeType: "image/png",
        sizeBytes: 8,
      }),
    ).toMatchObject({
      path: "assets/logo.png",
      content: "iVBORw0KGgo=",
      contentEncoding: "base64",
    });

    expect(
      hostDaemonCommandResultSchemaByType["host.file_metadata"].parse({
        path: "/tmp/bb-data/thread-storage/thread-123/PREFERENCES.md",
        modifiedAtMs: 1234.5,
        sizeBytes: 26_214_401,
      }),
    ).toMatchObject({
      path: "/tmp/bb-data/thread-storage/thread-123/PREFERENCES.md",
      modifiedAtMs: 1234.5,
      sizeBytes: 26_214_401,
    });

    expect(
      hostDaemonCommandResultSchemaByType["host.status_version"].parse({
        source: "folder",
        hash: "abc123",
      }),
    ).toEqual({
      source: "folder",
      hash: "abc123",
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
        transcript: [
          {
            type: "step",
            key: "setup",
            text: "/bin/bash .bb-env-setup.sh",
            status: "completed",
          },
        ],
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

    expect(() =>
      hostDaemonSessionOpenRequestSchema.parse({
        hostId: "host_123",
        instanceId: "instance_1",
        hostName: "Michael's MacBook",
        hostType: "persistent",
        dataDir: "/tmp/bb-data",
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION - 1,
        activeThreads: [],
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
      }),
    ).toMatchObject({
      sessionId: "session_123",
      trackedThreadTargets: [
        {
          environmentId: "env_123",
          threadId: "thr_123",
        },
      ],
    });

    expect(() =>
      hostDaemonSessionOpenResponseSchema.parse({
        sessionId: "session_123",
        heartbeatIntervalMs: 5_000,
        leaseTimeoutMs: 30_000,
        trackedThreadTargets: [],
        threadHighWaterMarks: { thr_123: 10 },
      }),
    ).toThrow();

    expect(
      hostDaemonEventBatchRequestSchema.parse({
        sessionId: "session_123",
        events: [
          {
            producerEventId: PRODUCER_EVENT_ID,
            threadId: "thr_123",
            event: {
              type: "system/error",
              threadId: "thr_123",
              scope: threadScope(),
              message: "boom",
            },
          },
        ],
      }),
    ).toMatchObject({
      sessionId: "session_123",
      events: [
        {
          producerEventId: PRODUCER_EVENT_ID,
          threadId: "thr_123",
        },
      ],
    });

    expect(
      hostDaemonEventBatchResponseSchema.parse({
        acceptedEvents: [
          {
            producerEventId: PRODUCER_EVENT_ID,
            threadId: "thr_123",
            sequence: 42,
          },
        ],
        rejectedEvents: [
          {
            producerEventId: "hdevt_23456789abcdefghijkn",
            reason: "thread_not_owned_by_host",
            threadId: "thr_stale",
          },
        ],
      }),
    ).toEqual({
      acceptedEvents: [
        {
          producerEventId: PRODUCER_EVENT_ID,
          threadId: "thr_123",
          sequence: 42,
        },
      ],
      rejectedEvents: [
        {
          producerEventId: "hdevt_23456789abcdefghijkn",
          reason: "thread_not_owned_by_host",
          threadId: "thr_stale",
        },
      ],
    });

    expect(() =>
      hostDaemonEventBatchResponseSchema.parse({
        acceptedEvents: [],
      }),
    ).toThrow();

    expect(() =>
      hostDaemonEventBatchResponseSchema.parse({
        acceptedEvents: [],
        rejectedEvents: [
          {
            producerEventId: "hdevt_23456789abcdefghijkn",
            reason: "unknown_reason",
            threadId: "thr_stale",
          },
        ],
      }),
    ).toThrow();

    expect(() =>
      hostDaemonEventBatchRequestSchema.parse({
        sessionId: "session_123",
        events: [
          {
            producerEventId: PRODUCER_EVENT_ID,
            threadId: "thr_123",
            sequence: 1,
            event: {
              type: "system/error",
              threadId: "thr_123",
              scope: threadScope(),
              message: "boom",
            },
          },
        ],
      }),
    ).toThrow();

    expect(() =>
      hostDaemonEventBatchResponseSchema.parse({
        acceptedEvents: [
          {
            producerEventId: PRODUCER_EVENT_ID,
            threadId: "thr_123",
            sequence: 42,
          },
        ],
        rejectedEvents: [],
        threadHighWaterMarks: {
          thr_123: 42,
        },
      }),
    ).toThrow();

    expect(
      hostDaemonCommandResultResponseSchema.parse({
        ok: true,
      }),
    ).toEqual({
      ok: true,
    });

    expect(() =>
      hostDaemonCommandResultResponseSchema.parse({
        ok: true,
        threadHighWaterMarks: {
          thr_123: 43,
        },
      }),
    ).toThrow();

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

    expect(
      hostDaemonInteractiveRequestSchema.parse({
        sessionId: "session_123",
        interaction: {
          threadId: "thr_123",
          turnId: "turn_123",
          providerId: "codex",
          providerThreadId: "provider-thread-123",
          providerRequestId: "request-123",
          payload: {
            kind: "approval",
            subject: {
              kind: "command",
              itemId: "item_123",
              command: "git push",
              cwd: "/tmp/project",
              actions: [],
              sessionGrant: null,
            },
            reason: "Needs approval",
            availableDecisions: ["allow_once", "deny"],
          },
        },
      }),
    ).toMatchObject({
      sessionId: "session_123",
      interaction: {
        providerId: "codex",
      },
    });

    expect(
      hostDaemonInteractiveRequestResponseSchema.parse({
        outcome: "created",
        interactionId: "pint_123",
        status: "pending",
      }),
    ).toMatchObject({
      outcome: "created",
      interactionId: "pint_123",
    });

    expect(
      hostDaemonInteractiveRequestResponseSchema.parse({
        outcome: "existing",
        interactionId: "pint_123",
        status: "resolving",
      }),
    ).toMatchObject({
      outcome: "existing",
      interactionId: "pint_123",
      status: "resolving",
    });

    expect(
      hostDaemonInteractiveInterruptRequestSchema.parse({
        sessionId: "session_123",
        providerId: "codex",
        threadIds: ["thr_123"],
        reason: "Provider exited",
      }),
    ).toEqual({
      sessionId: "session_123",
      providerId: "codex",
      threadIds: ["thr_123"],
      reason: "Provider exited",
    });

    expect(
      hostDaemonInteractiveInterruptResponseSchema.parse({
        ok: true,
        interactionIds: ["pint_123"],
      }),
    ).toEqual({
      ok: true,
      interactionIds: ["pint_123"],
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

  it("bounds terminal dimensions in daemon websocket messages", () => {
    expect(
      hostDaemonServerWsMessageSchema.safeParse({
        type: "terminal.open",
        requestId: "request-1",
        terminalId: "term_123",
        threadId: "thr_123",
        environmentId: "env_123",
        workspaceContext: {
          workspacePath: "/tmp/workspace",
          workspaceProvisionType: "unmanaged",
        },
        cols: TERMINAL_COLS_MAX,
        rows: TERMINAL_ROWS_MAX,
      }).success,
    ).toBe(true);
    expect(
      hostDaemonServerWsMessageSchema.safeParse({
        type: "terminal.resize",
        terminalId: "term_123",
        cols: TERMINAL_COLS_MAX + 1,
        rows: TERMINAL_ROWS_MAX,
      }).success,
    ).toBe(false);
    expect(
      hostDaemonDaemonWsMessageSchema.safeParse({
        type: "terminal.opened",
        requestId: "request-1",
        terminalId: "term_123",
        shell: "/bin/zsh",
        title: "zsh",
        initialCwd: "/tmp/workspace",
        currentCwd: null,
        cols: TERMINAL_COLS_MAX,
        rows: TERMINAL_ROWS_MAX + 1,
      }).success,
    ).toBe(false);
  });

  it("bounds and validates terminal data in daemon websocket messages", () => {
    const maxPayload = terminalDataBase64(TERMINAL_DATA_MAX_BYTES);
    const oversizedDecodedPayload = terminalDataBase64(
      TERMINAL_DATA_MAX_BYTES + 1,
    );
    const oversizedEncodedPayload = "A".repeat(
      TERMINAL_DATA_MAX_BASE64_LENGTH + 4,
    );

    expect(
      hostDaemonServerWsMessageSchema.safeParse({
        type: "terminal.input",
        terminalId: "term_123",
        dataBase64: maxPayload,
      }).success,
    ).toBe(true);
    expect(
      hostDaemonTerminalOutputChunkSchema.safeParse({
        seq: 0,
        dataBase64: maxPayload,
      }).success,
    ).toBe(true);
    expect(
      hostDaemonDaemonWsMessageSchema.safeParse({
        type: "terminal.replay",
        requestId: "request-1",
        terminalId: "term_123",
        chunks: [
          {
            seq: 0,
            dataBase64: oversizedDecodedPayload,
          },
        ],
        nextSeq: 1,
      }).success,
    ).toBe(false);
    expect(
      hostDaemonServerWsMessageSchema.safeParse({
        type: "terminal.input",
        terminalId: "term_123",
        dataBase64: "not base64!",
      }).success,
    ).toBe(false);
    expect(
      hostDaemonTerminalOutputChunkSchema.safeParse({
        seq: 0,
        dataBase64: oversizedEncodedPayload,
      }).success,
    ).toBe(false);
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

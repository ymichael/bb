import { collectOptionalFieldPaths } from "@bb/test-helpers";
import { threadScope, turnScope, type JsonObject } from "@bb/domain";
import { describe, expect, it } from "vitest";
import * as contract from "../src/index.js";
import {
  HOST_ARTIFACT_MAX_BYTES,
  HOST_DAEMON_PROTOCOL_VERSION,
  HOST_DAEMON_ONLINE_RPC_COMMAND_TYPES,
  HOST_DAEMON_SETTLED_COMMAND_TYPES,
  TERMINAL_COLS_MAX,
  TERMINAL_DATA_MAX_BASE64_LENGTH,
  TERMINAL_DATA_MAX_BYTES,
  TERMINAL_ROWS_MAX,
  createHostDaemonClient,
  hostDaemonEnrollRequestSchema,
  hostDaemonEnrollResponseSchema,
  hostDaemonCommandResultSchemaByType,
  hostDaemonCommandSchema,
  hostDaemonDaemonWsMessageSchema,
  hostDaemonEventBatchRequestSchema,
  hostDaemonEventBatchResponseSchema,
  hostDaemonInteractiveInterruptRequestSchema,
  hostDaemonInteractiveInterruptResponseSchema,
  hostDaemonInjectedSkillSourceSchema,
  hostDaemonInteractiveRequestResponseSchema,
  hostDaemonInteractiveRequestSchema,
  hostDaemonOnlineRpcCommandSchema,
  type HostDaemonOnlineRpcCommandType,
  type HostDaemonRpcCommandType,
  hostDaemonOnlineRpcResponseMessageSchema,
  hostDaemonOnlineRpcResultSchemaByType,
  hostDaemonServerWsMessageSchema,
  hostDaemonSessionOpenRequestSchema,
  hostDaemonSessionOpenResponseSchema,
  hostDaemonTerminalOutputChunkSchema,
  threadStopCommandSchema,
  type HostDaemonSettledCommandType,
} from "../src/index.js";

const CLIENT_REQUEST_ID = "creq_23456789ab";
const ACP_LAUNCH_SPEC = {
  displayName: "Local ACP",
  command: "local-acp",
  args: ["serve"],
  env: {
    LOCAL_ACP_MODE: "test",
  },
  cwd: "/tmp/local-acp",
  modelCli: {
    listArgs: ["models", "list"],
    selectFlag: "--model",
    primaryModels: ["local-default"],
  },
  reasoningCli: {
    flag: "--reasoning-effort",
    supportedLevels: ["low", "medium", "high"],
    levelValues: {
      max: "high",
    },
    defaultLevel: "high",
  },
  nativeReasoning: {
    configId: "reasoning_effort",
    supportedLevels: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultLevel: "medium",
  },
  nativeSkillRoots: {
    user: [".agents/skills"],
    project: [".agents/skills"],
  },
  permissionCli: {
    full: ["--always-approve"],
    insertAfterArgs: 1,
  },
};

type OnlineRpcResponseResultFixtures = Record<
  HostDaemonOnlineRpcCommandType,
  JsonObject
>;
type SettledResponseResultFixtures = Record<
  HostDaemonSettledCommandType,
  JsonObject
>;

interface OnlineRpcResponseMismatchCase {
  commandType: HostDaemonOnlineRpcCommandType;
  name: string;
  result: JsonObject;
}

interface OnlineRpcResponseRoundTripCase {
  commandType: HostDaemonOnlineRpcCommandType;
  name: string;
  result: JsonObject;
}

const WORKSPACE_UNAVAILABLE_RESULT: JsonObject = {
  outcome: "unavailable",
  failure: {
    code: "path_not_found",
    workspacePath: "/tmp/missing-workspace",
    message: "Workspace path is missing",
  },
};

const WORKSPACE_STATUS_AVAILABLE_RESULT: JsonObject = {
  outcome: "available",
  workspaceStatus: {
    workingTree: {
      insertions: 3,
      deletions: 1,
      lineStatsComplete: true,
      files: [
        {
          path: "src/index.ts",
          status: "M",
          insertions: 3,
          deletions: 1,
        },
      ],
      hasUncommittedChanges: true,
      state: "dirty_and_committed_unmerged",
    },
    branch: {
      currentBranch: "feature/host-rpc",
      defaultBranch: "main",
    },
    checkout: {
      kind: "branch",
      branchName: "feature/host-rpc",
      headSha: null,
    },
    mergeBase: {
      insertions: 5,
      deletions: 0,
      lineStatsComplete: true,
      files: [
        {
          path: "README.md",
          status: "A",
          insertions: 5,
          deletions: 0,
        },
      ],
      mergeBaseBranch: "main",
      baseRef: "abc123",
      aheadCount: 1,
      behindCount: 0,
      hasCommittedUnmergedChanges: true,
      commits: [
        {
          sha: "abcdef123456",
          shortSha: "abcdef1",
          subject: "Add host RPC guard",
          authorName: "Test User",
          authoredAt: 1_700_000_000_000,
        },
      ],
    },
  },
};

const WORKSPACE_DIFF_AVAILABLE_RESULT: JsonObject = {
  outcome: "available",
  diff: {
    diff: "diff --git a/src/index.ts b/src/index.ts\n",
    truncated: false,
    shortstat: "1 file changed, 3 insertions(+), 1 deletion(-)",
    files: "src/index.ts\n",
    mergeBaseRef: "abc123",
  },
};

const ONLINE_RPC_RESPONSE_RESULT_FIXTURES: OnlineRpcResponseResultFixtures = {
  "desktop.browser.list_instances": { instances: [] },
  "desktop.browser.list_tabs": { tabs: [] },
  "desktop.browser.create_tab": {
    tab: {
      tabId: "tab",
      threadId: "thread",
      title: "",
      url: "about:blank",
      profile: { kind: "personal" },
      presentation: "hidden",
      control: null,
    },
  },
  "desktop.browser.reveal_tab": { ok: true },
  "desktop.browser.close_tab": { ok: true },
  "desktop.browser.capture_tab": {
    mimeType: "image/jpeg",
    width: 800,
    height: 600,
    base64: "",
  },
  "desktop.browser.acquire_control": {
    lease: {
      leaseId: "lease",
      controllerLabel: "Agent",
      expiresAt: 1700000000000,
    },
  },
  "desktop.browser.open_connection": {
    wsEndpoint: "ws://127.0.0.1:1234/scoped",
    expiresAt: 1700000000000,
  },
  "desktop.browser.release_control": { ok: true },
  "plugin.host.call": { output: { ok: true } },
  "plugin.host.cancel": { cancelled: true },
  "plugin.host.dispose": { disposed: true },
  "connect-tunnel.ensure-identity": {
    label: "sawyer-air",
    baseDomain: "getbb.app",
  },
  "host.list_files": {
    files: [
      {
        path: "src/index.ts",
        name: "index.ts",
      },
    ],
    truncated: false,
  },
  "host.list_paths": {
    paths: [
      {
        kind: "file",
        path: "src/index.ts",
        name: "index.ts",
        score: 1,
        positions: [0, 4],
      },
    ],
    truncated: false,
  },
  "host.mkdir": { ok: true },
  "host.move_path": { ok: true },
  "host.remove_path": { ok: true },
  "host.browse_directory": {
    directory: "/home/me/project",
    parent: "/home/me",
    entries: [
      { kind: "directory", name: "src", path: "/home/me/project/src" },
      { kind: "file", name: "README.md", path: "/home/me/project/README.md" },
    ],
  },
  "host.paths_exist": {
    existence: {
      "/home/me/project": true,
      "/home/me/missing": false,
    },
  },
  "project.inspect": {
    path: "/home/me/project",
    gitRemoteUrl: "git@example.com:me/project.git",
  },
  "project.clone_default_path": {
    path: "/home/me/.bb/checkouts/project",
  },
  "host.pick_folder": {
    path: "/home/me/project",
  },
  "host.list_commands": {
    commands: [
      {
        name: "review",
        source: "skill",
        origin: "project",
        description: "Review the current diff",
        argumentHint: null,
      },
    ],
  },
  "host.list_skills": {
    skills: [
      {
        id: `skill_${"a".repeat(64)}`,
        name: "review",
        description: "Review the current diff",
        filePath: "/home/user/.bb/skills/review/SKILL.md",
        rootKind: "bb-data-dir",
        linked: false,
      },
    ],
  },
  "host.delete_skill": {
    deletedPath: "/home/user/.bb/skills/review",
  },
  "host.write_skill": {
    outcome: "written",
    filePath: "/home/user/.bb/skills/review/SKILL.md",
    sha256: "b".repeat(64),
  },
  "host.global_skills_status": {
    entries: [
      {
        name: "bb-cli",
        path: "/home/user/.agents/skills/bb-cli",
        treeHash: "c".repeat(64),
      },
    ],
  },
  "host.install_global_skills": {
    installations: [
      { name: "bb-cli", path: "/home/user/.agents/skills/bb-cli" },
    ],
  },
  "host.inspect_git_source": {
    checkout: {
      kind: "branch",
      branchName: "main",
      headSha: "abc123",
    },
    defaultBranch: "main",
    defaultBranchRelation: "equal",
    hasUncommittedChanges: false,
    operation: {
      kind: "none",
    },
    originDefaultBranch: "origin/main",
  },
  "host.list_branch_options": {
    branches: ["main"],
    branchesTruncated: false,
    remoteBranches: ["origin/main"],
    remoteBranchesTruncated: false,
    selectedBranch: {
      name: "main",
      kind: "local",
    },
  },
  "host.file_metadata": {
    path: "/tmp/report.html",
    modifiedAtMs: 1234,
    sizeBytes: 42,
  },
  "host.read_file": {
    path: "/tmp/report.html",
    content: "<!doctype html>",
    contentEncoding: "utf8",
    mimeType: "text/html",
    sizeBytes: 15,
    sha256: "a".repeat(64),
  },
  "host.read_file_relative": {
    path: "assets/logo.png",
    content: "iVBORw0KGgo=",
    contentEncoding: "base64",
    mimeType: "image/png",
    sizeBytes: 8,
    sha256: "b".repeat(64),
  },
  "host.write_file": {
    outcome: "written",
    sha256: "c".repeat(64),
    sizeBytes: 12,
  },
  "provider.list_models": {
    models: [
      {
        id: "codex/gpt-5",
        model: "gpt-5",
        displayName: "GPT-5",
        routeProviderId: "openai-codex",
        description: "Test model",
        supportedReasoningEfforts: [
          {
            reasoningEffort: "medium",
            description: "Balanced",
          },
        ],
        defaultReasoningEffort: "medium",
        isDefault: true,
      },
    ],
    selectedOnlyModels: [],
  },
  "provider.health": {
    supported: true,
    health: {
      status: "ready",
      statusMessage: null,
      accountEmail: "agent@example.com",
      planLabel: "Pro",
      installedVersion: "1.2.3",
      minimumSupportedVersion: "1.0.0",
      canInstall: true,
      canUpdate: true,
      loginCommand: "agent login",
    },
  },
  "provider.usage": {
    supported: true,
    usage: {
      status: "ok",
      accountEmail: "codex@example.com",
      planLabel: "Pro",
      windows: [
        {
          label: "Current session",
          usedPercent: 6,
          resetsAt: "2026-06-20T05:28:16.000Z",
        },
      ],
    },
  },
  "provider.installation.status": {
    executableName: "codex",
    executablePath: null,
    installed: false,
    installSource: "notInstalled",
    currentVersion: null,
    latestVersion: "0.136.0",
    minimumSupportedVersion: "0.136.0",
    npmPackageName: "@openai/codex",
    npmGlobalPackageVersion: null,
    installAction: {
      kind: "install",
      label: "Install",
      command: "npm install -g @openai/codex@latest",
    },
    needsUpdate: false,
    versionUnsupported: false,
  },
  "provider.installation.run": {
    events: [
      {
        type: "started",
        provider: "codex",
        command: "npm install -g @openai/codex@latest",
      },
      {
        type: "completed",
        provider: "codex",
        exitCode: 0,
        signal: null,
        success: true,
      },
    ],
  },
  "workspace.status": WORKSPACE_UNAVAILABLE_RESULT,
  "workspace.diff": WORKSPACE_UNAVAILABLE_RESULT,
  "workspace.diffFiles": WORKSPACE_UNAVAILABLE_RESULT,
  "workspace.diffPatch": WORKSPACE_UNAVAILABLE_RESULT,
  "workspace.pull_request": {
    outcome: "available",
    pullRequest: {
      number: 42,
      title: "Add host RPC guard",
      state: "OPEN",
      url: "https://github.com/acme/bb/pull/42",
      isDraft: false,
      baseRefName: "main",
      headRefName: "feature/host-rpc",
      updatedAt: "2026-06-16T12:30:00Z",
      checks: [
        {
          name: "test",
          status: "completed",
          conclusion: "success",
          url: null,
          startedAt: "2026-06-16T12:25:00Z",
        },
      ],
      reviewDecision: "APPROVED",
      reviewRequestCount: 0,
      mergeStateStatus: "CLEAN",
      mergeable: "MERGEABLE",
    },
  },
};

const SETTLED_RESPONSE_RESULT_FIXTURES: SettledResponseResultFixtures = {
  "thread.rewind.discard": {},
  "thread.rewind.prepare": {
    providerThreadId: "provider-thread-rewind",
  },
  "thread.start": {
    providerThreadId: "provider-thread-123",
  },
  "turn.submit": {
    appliedAs: "new-turn",
  },
  "thread.stop": { providerCheckpointId: null },
  "thread.goal.clear": { cleared: true },
  "thread.plan.cancel": { cancelled: true },
  "thread.rename": {},
  "thread.archive": {},
  "thread.unarchive": {},
  "interactive.resolve": {},
  "environment.provision": {
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
  },
  "environment.provision.cancel": {
    aborted: true,
  },
  "project.clone": {
    path: "/home/me/.bb/checkouts/project",
    gitRemoteUrl: "git@example.com:me/project.git",
  },
  "environment.destroy": {
    transcript: [],
  },
  "workspace.commit": {
    commitSha: "abcdef123456",
    commitSubject: "Checkpoint work",
  },
  "workspace.pull_request_action": {},
};

const WORKSPACE_DIFF_FILES_AVAILABLE_RESULT: JsonObject = {
  outcome: "available",
  files: [
    {
      path: "src/renamed.ts",
      previousPath: "src/original.ts",
      statusLetter: "R",
      additions: 3,
      deletions: 1,
      binary: false,
      origin: "tracked",
    },
  ],
  shortstat: "1 file changed, 3 insertions(+), 1 deletion(-)",
  mergeBaseRef: "abc123",
  truncated: false,
};

const WORKSPACE_DIFF_PATCH_AVAILABLE_RESULT: JsonObject = {
  outcome: "available",
  patches: [
    {
      path: "src/renamed.ts",
      patch: "diff --git a/src/original.ts b/src/renamed.ts\n",
      truncated: true,
    },
  ],
};

const ADDITIONAL_ONLINE_RPC_RESPONSE_ROUND_TRIP_CASES: OnlineRpcResponseRoundTripCase[] =
  [
    {
      name: "workspace.status available result",
      commandType: "workspace.status",
      result: WORKSPACE_STATUS_AVAILABLE_RESULT,
    },
    {
      name: "workspace.diff available result",
      commandType: "workspace.diff",
      result: WORKSPACE_DIFF_AVAILABLE_RESULT,
    },
    {
      name: "workspace.diffFiles available result",
      commandType: "workspace.diffFiles",
      result: WORKSPACE_DIFF_FILES_AVAILABLE_RESULT,
    },
    {
      name: "workspace.diffPatch available result",
      commandType: "workspace.diffPatch",
      result: WORKSPACE_DIFF_PATCH_AVAILABLE_RESULT,
    },
    {
      name: "workspace.pull_request no-PR result",
      commandType: "workspace.pull_request",
      result: { outcome: "absent" },
    },
    {
      name: "workspace.pull_request unavailable result",
      commandType: "workspace.pull_request",
      result: {
        outcome: "unavailable",
        message: "GitHub CLI is not available",
      },
    },
  ];

const ONLINE_RPC_RESPONSE_MISMATCH_CASES: OnlineRpcResponseMismatchCase[] = [
  {
    name: "host.file_metadata command with a read-file result",
    commandType: "host.file_metadata",
    result: {
      path: "/tmp/report.html",
      content: "<!doctype html>",
      contentEncoding: "utf8",
      mimeType: "text/html",
      sizeBytes: 15,
    },
  },
  {
    name: "host.read_file command with a metadata result",
    commandType: "host.read_file",
    result: {
      path: "/tmp/report.html",
      modifiedAtMs: 1234,
      sizeBytes: 42,
    },
  },
  {
    name: "provider.list_models command with a provider-list result",
    commandType: "provider.list_models",
    result: {
      providers: [],
    },
  },
  {
    name: "provider.list_models command with unrelated collection result",
    commandType: "provider.list_models",
    result: {
      captures: [],
    },
  },
];

function buildHostRpcResponseMessage(
  commandType: HostDaemonRpcCommandType,
  result: JsonObject,
): JsonObject {
  return {
    type: "host-rpc.response",
    requestId: `rpc-${commandType}`,
    commandType,
    ok: true,
    result,
  };
}

function expectHostRpcResponseRoundTrip(
  commandType: HostDaemonRpcCommandType,
  result: JsonObject,
  name: string,
): void {
  const message = buildHostRpcResponseMessage(commandType, result);
  const jsonRoundTripped = JSON.parse(JSON.stringify(message));

  expect(
    hostDaemonOnlineRpcResponseMessageSchema.parse(jsonRoundTripped),
    name,
  ).toEqual(message);
  expect(hostDaemonDaemonWsMessageSchema.parse(jsonRoundTripped), name).toEqual(
    message,
  );
}

function terminalDataBase64(byteLength: number): string {
  return Buffer.alloc(byteLength, "a").toString("base64");
}

const INTENTIONAL_OPTIONAL_HOST_DAEMON_FIELDS: Record<string, string> = {
  "hostDaemonCommandSchema.checkout":
    "environment.provision only includes checkout instructions for unmanaged workspaces that requested a branch mutation.",
  "hostDaemonCommandSchema.targetPath":
    "project.clone omits targetPath when the daemon should derive its default checkout location for the project.",
  "hostDaemonOnlineRpcCommandSchema.expectedSha256":
    "host.write_file may omit expectedSha256 for unconditional writes; a hash is the compare-and-swap guard and null means create-only.",
  "hostDaemonOnlineRpcCommandSchema.mode":
    "host.write_file may omit mode to preserve existing permissions; when present it only controls newly created files.",
  "hostDaemonOnlineRpcCommandSchema.mergeBaseBranch":
    "workspace.status may omit mergeBaseBranch when the caller only needs working-tree state.",
  "hostDaemonInteractiveRequestSchema.interaction.payload.subject.presentation.badge":
    "a tool_use approval's presentation carries a badge only when the bridge has something to flag about how the call will run, such as a command opting out of the session sandbox; absence means the ordinary case, not a blank badge.",
  "hostDaemonInteractiveRequestSchema.interaction.payload.subject.presentation.detail":
    "a tool_use approval's presentation has a detail only when the bridge summarized the call; a missing detail means the label and title are the whole summary, not an empty string.",
  "hostDaemonInteractiveRequestSchema.interaction.payload.subject.presentation.suppress":
    "a tool_use approval's presentation marks suppress only for low-value rows the bridge wants collapsed; absence means render normally.",
  "hostDaemonInteractiveRequestSchema.interaction.payload.subject.presentation.tint":
    "a tool_use approval's presentation carries a tint only when the bridge wants an accent colour; absence means the neutral row tint, which is not a colour value.",
  "hostDaemonInteractiveRequestSchema.interaction.payload.subject.presentation.title":
    "a tool_use approval's presentation has a title only when the call has a headline (a path, a query); absence means the label stands alone.",
  "hostDaemonOnlineRpcCommandSchema.cwd":
    "provider.list_models may omit cwd when only user-level provider configuration applies.",
  "hostDaemonOnlineRpcCommandSchema.query":
    "host.list_files may omit a search string to list files without filtering.",
  "hostDaemonOnlineRpcCommandSchema.path":
    "host.browse_directory may omit path to list the host's home directory, which a remote caller cannot resolve.",
  "hostDaemonOnlineRpcCommandSchema.ref":
    "host.read_file may omit ref to read from disk; setting ref switches to git history at that ref.",
  "hostDaemonOnlineRpcCommandSchema.requirement":
    "provider installation status omits requirement for general compatibility and names one only when checking a specific operation.",
  "hostDaemonOnlineRpcCommandSchema.rootPath":
    "host.read_file and host.file_metadata may omit rootPath only for explicit absolute disk reads; ref-based reads still require it.",
  "hostDaemonOnlineRpcCommandSchema.selectedBranch":
    "host.list_branch_options may omit exact selected-branch classification when the caller only needs a branch option page.",
  "hostDaemonCommandSchema.threadStoragePath":
    "thread.start may include a storage path so the daemon creates the directory before the agent starts.",
  "hostDaemonCommandSchema.fork":
    "thread.start omits fork unless the new thread should clone an existing provider session; absent means a normal start.",
  "hostDaemonCommandSchema.fork.sourceProviderCheckpointId":
    "thread.start.fork names a checkpoint only when the clone should stop at an earlier source turn; absent means clone the session tip.",
  "hostDaemonCommandSchema.inputGroups":
    "thread.start and turn.submit omit inputGroups for ordinary single user-message turns; presence preserves grouped user messages within one turn.",
  "hostDaemonCommandSchema.disallowedTools":
    "thread runtime context may omit provider-specific built-in tool removals for providers that do not need them.",
  "hostDaemonCommandSchema.options.promptMode":
    "thread runtime options carry a prompt mode only when the prompt entered one through the provider's declared composer action.",
  "hostDaemonCommandSchema.resumeContext.disallowedTools":
    "turn.submit resume context may omit provider-specific built-in tool removals for providers that do not need them.",
};

describe("host-daemon local schemas", () => {
  it("parses workspace open target routes", () => {
    expect(
      contract.workspaceOpenTargetSchema.parse({
        id: "custom:my-editor",
        label: "My Editor",
        kind: "editor",
        icon: {
          kind: "builtin",
          name: "vscode",
        },
        capabilities: {
          openDirectory: true,
          openFile: true,
          openFileAtColumn: true,
          openFileAtLine: true,
        },
        remoteSshCapabilities: {
          openDirectory: true,
          openFile: true,
          openFileAtColumn: true,
          openFileAtLine: true,
        },
      }),
    ).toEqual({
      id: "custom:my-editor",
      label: "My Editor",
      kind: "editor",
      icon: {
        kind: "builtin",
        name: "vscode",
      },
      capabilities: {
        openDirectory: true,
        openFile: true,
        openFileAtColumn: true,
        openFileAtLine: true,
      },
      remoteSshCapabilities: {
        openDirectory: true,
        openFile: true,
        openFileAtColumn: true,
        openFileAtLine: true,
      },
    });

    expect(
      contract.workspaceOpenTargetsResponseSchema.parse({
        targets: [
          {
            id: "default-app",
            label: "Default App",
            capabilities: {
              openDirectory: true,
              openFile: true,
              openFileAtLine: false,
            },
          },
          {
            id: "finder",
            label: "Finder",
            capabilities: {
              openDirectory: true,
              openFile: false,
              openFileAtLine: false,
            },
          },
          {
            id: "terminal",
            label: "Terminal",
            capabilities: {
              openDirectory: true,
              openFile: false,
              openFileAtLine: false,
            },
          },
        ],
      }),
    ).toEqual({
      targets: [
        {
          id: "default-app",
          label: "Default App",
          capabilities: {
            openDirectory: true,
            openFile: true,
            openFileAtLine: false,
          },
        },
        {
          id: "finder",
          label: "Finder",
          capabilities: {
            openDirectory: true,
            openFile: false,
            openFileAtLine: false,
          },
        },
        {
          id: "terminal",
          label: "Terminal",
          capabilities: {
            openDirectory: true,
            openFile: false,
            openFileAtLine: false,
          },
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
      context: { kind: "local" },
      columnNumber: null,
      lineNumber: 12,
      path: "/tmp/workspace",
      targetId: "zed",
    });

    expect(
      contract.openInTargetRequestSchema.parse({
        context: {
          kind: "remote-ssh",
          serverOrigin: "https://bb.example.test",
          hostId: "host_remote",
        },
        lineNumber: 12,
        path: "/home/me/project/file.ts",
        targetId: "vscode",
      }),
    ).toEqual({
      context: {
        kind: "remote-ssh",
        serverOrigin: "https://bb.example.test",
        hostId: "host_remote",
      },
      columnNumber: null,
      lineNumber: 12,
      path: "/home/me/project/file.ts",
      targetId: "vscode",
    });
  });

  it("rejects malformed workspace open payloads", () => {
    expect(() =>
      contract.workspaceOpenTargetSchema.parse({
        id: "",
        label: "Unknown",
        capabilities: {
          openDirectory: true,
          openFile: true,
          openFileAtLine: true,
        },
      }),
    ).toThrow();

    expect(() =>
      contract.workspaceOpenTargetSchema.parse({
        id: "custom:bad-icon",
        label: "Bad Icon",
        icon: {
          kind: "data-url",
          dataUrl: "https://example.test/icon.png",
        },
        capabilities: {
          openDirectory: true,
          openFile: true,
          openFileAtLine: true,
        },
      }),
    ).toThrow();

    expect(() =>
      contract.workspaceOpenTargetSchema.parse({
        id: "vscode",
        label: "VS Code",
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

    expect(() =>
      contract.openInTargetRequestSchema.parse({
        columnNumber: 0,
        lineNumber: 1,
        path: "/tmp/workspace",
        targetId: "zed",
      }),
    ).toThrow();

    expect(() =>
      contract.openInTargetRequestSchema.parse({
        context: {
          kind: "remote-ssh",
          serverOrigin: "not a url",
          hostId: "host_remote",
        },
        lineNumber: 1,
        path: "/tmp/workspace",
        targetId: "vscode",
      }),
    ).toThrow();
  });
});

const BRIDGE_LAUNCH = {
  pluginId: "provider-pi",
  source: { kind: "artifact", digest: "a".repeat(64), byteLength: 4096 },
  providerOptions: {},
  envPassthrough: [],
  capabilities: {
    providerInstallation: false,
    supportsServiceTier: false,
    permissionModes: ["full"],
    supportsThreadArchive: false,
    supportsThreadRename: false,
    fork: "none",
  },
} as const;

const ACP_BRIDGE_LAUNCH = {
  ...BRIDGE_LAUNCH,
  pluginId: "provider-acp",
  providerOptions: { acpLaunchSpec: ACP_LAUNCH_SPEC },
} as const;

const CONTRIBUTED_ENV = [
  {
    name: "PLUGIN_API_URL",
    value: { serverPath: "/plugins/auth-proxy/api" },
    source: { plugin: "auth-proxy" },
    reason: "Route provider traffic through the plugin",
    secret: true,
  },
] as const;

describe("host-daemon command schemas", () => {
  it("uses the current host-daemon protocol version", () => {
    expect(HOST_DAEMON_PROTOCOL_VERSION).toBe(183);
    expect(HOST_ARTIFACT_MAX_BYTES).toBe(256 * 1024 * 1024);
  });

  it("uses relative host-plugin timeouts and bounds artifact declarations", () => {
    const command = {
      type: "plugin.host.call" as const,
      pluginId: "fixture",
      generation: "generation-1",
      artifact: {
        digest: "a".repeat(64),
        byteLength: 1,
      },
      callId: "call-1",
      method: "echo",
      input: null,
      timeoutMs: 10_000,
    };
    expect(hostDaemonOnlineRpcCommandSchema.safeParse(command).success).toBe(
      true,
    );
    expect(
      hostDaemonOnlineRpcCommandSchema.safeParse({
        ...command,
        timeoutMs: undefined,
        deadlineUnixMs: Date.now() + 10_000,
      }).success,
    ).toBe(false);
    expect(
      hostDaemonOnlineRpcCommandSchema.safeParse({
        ...command,
        artifact: {
          ...command.artifact,
          byteLength: HOST_ARTIFACT_MAX_BYTES + 1,
        },
      }).success,
    ).toBe(false);
  });

  it("requires an explicit intent on a thread stop command", () => {
    const base = {
      environmentId: "env_1",
      threadId: "thr_1",
      type: "thread.stop" as const,
    };
    expect(threadStopCommandSchema.safeParse(base).success).toBe(false);
    expect(
      threadStopCommandSchema.safeParse({ ...base, intent: "release" }).success,
    ).toBe(true);
    expect(
      threadStopCommandSchema.safeParse({ ...base, intent: "pause" }).success,
    ).toBe(false);
  });

  it("binds Plan cancellation to a required turn id and typed result", () => {
    expect(
      hostDaemonCommandSchema.parse({
        type: "thread.plan.cancel",
        environmentId: "env_123",
        threadId: "thr_123",
        expectedTurnId: "turn-plan-123",
      }),
    ).toMatchObject({
      type: "thread.plan.cancel",
      expectedTurnId: "turn-plan-123",
    });
    expect(
      hostDaemonCommandSchema.safeParse({
        type: "thread.plan.cancel",
        environmentId: "env_123",
        threadId: "thr_123",
      }).success,
    ).toBe(false);
    expect(
      hostDaemonCommandResultSchemaByType["thread.plan.cancel"].parse({
        cancelled: true,
      }),
    ).toEqual({ cancelled: true });
    expect(
      hostDaemonCommandResultSchemaByType["thread.plan.cancel"].safeParse({})
        .success,
    ).toBe(false);
  });

  it("preserves optional USD spend amounts on usage windows", () => {
    expect(
      contract.providerUsageWindowSchema.parse({
        label: "On-demand spend",
        usedPercent: 10,
        resetsAt: null,
        cost: { usedUsdCents: 500, limitUsdCents: 5_000 },
      }),
    ).toEqual({
      label: "On-demand spend",
      usedPercent: 10,
      resetsAt: null,
      cost: { usedUsdCents: 500, limitUsdCents: 5_000 },
    });
  });

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
        workspaceContext: {
          workspacePath: "/tmp/workspace",
          workspaceProvisionType: "unmanaged",
        },
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
      hostDaemonCommandSchema.parse({
        type: "environment.provision",
        environmentId: "env_personal",
        initiator: null,
        workspaceProvisionType: "personal",
        targetPath: "/tmp/bb/personal-workspaces/env_personal",
      }),
    ).toMatchObject({
      type: "environment.provision",
      workspaceProvisionType: "personal",
    });

    expect(
      hostDaemonCommandSchema.parse({
        type: "environment.provision",
        environmentId: "env_123",
        initiator: null,
        workspaceProvisionType: "unmanaged",
        path: "/tmp/project",
        checkout: {
          kind: "existing",
          name: "feature/test",
        },
      }),
    ).toMatchObject({
      type: "environment.provision",
      workspaceProvisionType: "unmanaged",
      checkout: {
        kind: "existing",
        name: "feature/test",
      },
    });

    expect(
      hostDaemonCommandSchema.parse({
        type: "environment.provision",
        environmentId: "env_123",
        initiator: null,
        workspaceProvisionType: "unmanaged",
        path: "/tmp/project",
        checkout: {
          kind: "new",
          name: "bb/env-123",
          baseBranch: "release",
        },
      }),
    ).toMatchObject({
      type: "environment.provision",
      workspaceProvisionType: "unmanaged",
      checkout: {
        kind: "new",
        baseBranch: "release",
      },
    });

    expect(
      hostDaemonCommandSchema.parse({
        type: "workspace.commit",
        environmentId: "env_123",
        workspaceContext: {
          workspacePath: "/tmp/workspace",
          workspaceProvisionType: "unmanaged",
        },
        message: "Checkpoint work",
      }),
    ).toMatchObject({
      type: "workspace.commit",
      environmentId: "env_123",
    });

    expect(
      hostDaemonCommandSchema.parse({
        type: "workspace.pull_request_action",
        operation: "ready",
        environmentId: "env_123",
        workspaceContext: {
          workspacePath: "/tmp/workspace",
          workspaceProvisionType: "unmanaged",
        },
      }),
    ).toMatchObject({
      type: "workspace.pull_request_action",
      operation: "ready",
    });

    expect(
      hostDaemonCommandSchema.parse({
        type: "workspace.pull_request_action",
        operation: "draft",
        environmentId: "env_123",
        workspaceContext: {
          workspacePath: "/tmp/workspace",
          workspaceProvisionType: "unmanaged",
        },
      }),
    ).toMatchObject({
      type: "workspace.pull_request_action",
      operation: "draft",
    });

    expect(
      hostDaemonCommandSchema.parse({
        type: "workspace.pull_request_action",
        operation: "merge",
        method: "squash",
        environmentId: "env_123",
        workspaceContext: {
          workspacePath: "/tmp/workspace",
          workspaceProvisionType: "unmanaged",
        },
      }),
    ).toMatchObject({
      type: "workspace.pull_request_action",
      operation: "merge",
      method: "squash",
    });

    expect(() =>
      hostDaemonCommandSchema.parse({
        type: "workspace.pull_request_action",
        operation: "merge",
        environmentId: "env_123",
        workspaceContext: {
          workspacePath: "/tmp/workspace",
          workspaceProvisionType: "unmanaged",
        },
      }),
    ).toThrow();

    expect(
      hostDaemonOnlineRpcCommandSchema.parse({
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
      hostDaemonOnlineRpcCommandSchema.parse({
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

    const root = (
      path: string,
      options: Partial<{
        recursive: boolean;
        ancestors: boolean;
        namePrefix: string;
      }> = {},
    ) => ({
      path,
      recursive: false,
      ancestors: false,
      namePrefix: "",
      ...options,
    });
    const emptyRoots = { user: [], project: [] };
    expect(
      hostDaemonOnlineRpcCommandSchema.parse({
        type: "host.list_commands",
        providerId: "acp-amp",
        cwd: "/tmp/workspace",
        nativeRoots: {
          skills: {
            user: [root(".agents/skills")],
            project: [
              root(".amp/skills", { recursive: true, ancestors: true }),
            ],
          },
          commands: { ...emptyRoots, project: [root(".amp/commands")] },
          resolved: {
            skills: [
              {
                path: "/home/dev/.amp/plugins/one/skills",
                origin: "user",
                recursive: false,
                ancestors: false,
                namePrefix: "one:",
                shape: "skills",
              },
            ],
            commands: [],
          },
        },
      }),
    ).toMatchObject({
      type: "host.list_commands",
      providerId: "acp-amp",
      nativeRoots: {
        skills: {
          project: [{ path: ".amp/skills", recursive: true, ancestors: true }],
        },
        resolved: { skills: [{ namePrefix: "one:", shape: "skills" }] },
      },
    });

    expect(
      hostDaemonOnlineRpcCommandSchema.parse({
        type: "host.list_skills",
        providerId: "bb-shared",
        cwd: "/tmp/workspace",
        nativeRoots: {
          skills: { ...emptyRoots, user: [root(".agents/skills")] },
          commands: emptyRoots,
          resolved: { skills: [], commands: [] },
        },
      }),
    ).toMatchObject({
      type: "host.list_skills",
      nativeRoots: { skills: { user: [{ path: ".agents/skills" }] } },
    });

    expect(() =>
      hostDaemonOnlineRpcCommandSchema.parse({
        type: "host.list_commands",
        providerId: "pi",
        cwd: "/tmp/workspace",
        nativeSkillRoots: { user: [".pi/agent/skills"], project: [] },
      }),
    ).toThrow();
    const withRoots = (skills: Record<string, unknown>) => ({
      type: "host.list_commands",
      providerId: "pi",
      cwd: "/tmp/workspace",
      nativeRoots: {
        skills: { ...emptyRoots, ...skills },
        commands: emptyRoots,
        resolved: { skills: [], commands: [] },
      },
    });
    expect(() =>
      hostDaemonOnlineRpcCommandSchema.parse(
        withRoots({ absolute: [root("/home/dev/.pi/agent/skills")] }),
      ),
    ).toThrow(/Unrecognized key[^\n]*absolute/u);
    expect(() =>
      hostDaemonOnlineRpcCommandSchema.parse(
        withRoots({ user: [root("/home/dev/.pi/agent/skills")] }),
      ),
    ).toThrow(/relative paths without dot segments/u);
    expect(() =>
      hostDaemonOnlineRpcCommandSchema.parse(
        withRoots({ user: [root(".pi/skills", { ancestors: true })] }),
      ),
    ).toThrow(/Only project roots may walk ancestors/u);
    expect(() =>
      hostDaemonOnlineRpcCommandSchema.parse(
        withRoots({ user: [root(".pi/skills"), root(".pi/skills")] }),
      ),
    ).toThrow(/must not repeat a path/u);
    expect(() =>
      hostDaemonOnlineRpcCommandSchema.parse(
        withRoots({ user: [root(".pi/skills", { namePrefix: "bad prefix" })] }),
      ),
    ).toThrow(/ending in ':'/u);

    expect(
      hostDaemonOnlineRpcCommandSchema.parse({
        type: "host.list_branch_options",
        path: "/tmp/workspace",
        query: "release",
        selectedBranch: "origin/main",
        limit: 50,
        remoteRefresh: "background",
      }),
    ).toMatchObject({
      type: "host.list_branch_options",
      path: "/tmp/workspace",
      query: "release",
      selectedBranch: "origin/main",
      limit: 50,
      remoteRefresh: "background",
    });

    expect(
      hostDaemonOnlineRpcCommandSchema.parse({
        type: "host.inspect_git_source",
        path: "/tmp/workspace",
        remoteRefresh: "background",
      }),
    ).toMatchObject({
      type: "host.inspect_git_source",
      path: "/tmp/workspace",
      remoteRefresh: "background",
    });

    expect(
      hostDaemonOnlineRpcCommandSchema.parse({
        type: "host.file_metadata",
        path: "/tmp/bb-data/thread-storage/thread-123/notes.md",
        rootPath: "/tmp/bb-data/thread-storage/thread-123",
      }),
    ).toMatchObject({
      type: "host.file_metadata",
      path: "/tmp/bb-data/thread-storage/thread-123/notes.md",
      rootPath: "/tmp/bb-data/thread-storage/thread-123",
    });

    expect(
      hostDaemonOnlineRpcCommandSchema.parse({
        type: "host.read_file",
        path: "/tmp/bb-data/thread-storage/thread-123/notes.md",
        rootPath: "/tmp/bb-data/thread-storage/thread-123",
      }),
    ).toMatchObject({
      type: "host.read_file",
      path: "/tmp/bb-data/thread-storage/thread-123/notes.md",
      rootPath: "/tmp/bb-data/thread-storage/thread-123",
    });

    expect(
      hostDaemonOnlineRpcCommandSchema.parse({
        type: "host.read_file",
        path: "/tmp/bb-data/thread-storage/thread-123/notes.md",
      }),
    ).toMatchObject({
      type: "host.read_file",
      path: "/tmp/bb-data/thread-storage/thread-123/notes.md",
    });

    expect(
      hostDaemonOnlineRpcCommandSchema.parse({
        type: "host.read_file",
        path: "/tmp/bb-data/thread-storage/thread-123/notes.md",
        rootPath: "/tmp/bb-data/thread-storage/thread-123",
        ref: "HEAD",
      }),
    ).toMatchObject({
      type: "host.read_file",
      path: "/tmp/bb-data/thread-storage/thread-123/notes.md",
      rootPath: "/tmp/bb-data/thread-storage/thread-123",
      ref: "HEAD",
    });

    expect(
      hostDaemonOnlineRpcCommandSchema.parse({
        type: "host.read_file_relative",
        rootPath: "/tmp/bb-data/apps/demo/assets",
        path: "logo.png",
        dotfiles: "deny",
      }),
    ).toMatchObject({
      type: "host.read_file_relative",
      rootPath: "/tmp/bb-data/apps/demo/assets",
      path: "logo.png",
      dotfiles: "deny",
    });

    expect(
      hostDaemonOnlineRpcCommandSchema.parse({
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
  });

  it("rejects the removed codex AI-service command names", () => {
    for (const type of ["codex.inference.complete", "codex.voice.transcribe"]) {
      expect(() =>
        hostDaemonCommandSchema.parse({
          type,
          model: "gpt-5.4-mini",
          reasoningEffort: "none",
          prompt: "Return a short title.",
          outputSchema: { type: "object" },
          timeoutMs: 10000,
        }),
      ).toThrow();
    }
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

  it("rejects online-RPC-only read commands from the settled command schema", () => {
    const onlineReadCommands = [
      { type: "host.list_files", path: "/tmp/workspace", limit: 100 },
      {
        type: "host.list_paths",
        path: "/tmp/workspace",
        limit: 100,
        includeFiles: true,
        includeDirectories: true,
      },
      {
        type: "host.list_branch_options",
        path: "/tmp/workspace",
        limit: 50,
        remoteRefresh: "none",
      },
      {
        type: "host.inspect_git_source",
        path: "/tmp/workspace",
        remoteRefresh: "blocking",
      },
      {
        type: "host.file_metadata",
        path: "/tmp/workspace/README.md",
        rootPath: "/tmp/workspace",
      },
      {
        type: "host.read_file",
        path: "/tmp/workspace/README.md",
        rootPath: "/tmp/workspace",
      },
      {
        type: "host.read_file_relative",
        rootPath: "/tmp/workspace",
        path: "README.md",
        dotfiles: "deny",
      },
      {
        type: "provider.list_models",
        providerId: "codex",
        bridgeLaunch: BRIDGE_LAUNCH,
      },
      {
        type: "workspace.status",
        environmentId: "env_123",
        maxUntrackedLineStatFiles: 50,
        maxUntrackedLineStatBytes: 8 * 1024 * 1024,
        workspaceContext: {
          workspacePath: "/tmp/workspace",
          workspaceProvisionType: "managed-worktree",
        },
      },
      {
        type: "workspace.diff",
        environmentId: "env_123",
        workspaceContext: {
          workspacePath: "/tmp/workspace",
          workspaceProvisionType: "managed-worktree",
        },
        target: { type: "uncommitted" },
        maxDiffBytes: 1000,
        maxFileListBytes: 1000,
        maxUntrackedFiles: 5000,
      },
    ];

    for (const command of onlineReadCommands) {
      expect(() => hostDaemonCommandSchema.parse(command)).toThrow();
      expect(hostDaemonOnlineRpcCommandSchema.parse(command)).toMatchObject({
        type: command.type,
      });
    }
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
        type: "environment.provision",
        environmentId: "env_123",
        initiator: null,
        workspaceProvisionType: "unmanaged",
        path: "/tmp/project",
        checkout: { kind: "new", name: "bb/env-123" },
      }),
    ).toThrow();

    expect(() =>
      hostDaemonCommandSchema.parse({
        type: "environment.provision",
        environmentId: "env_123",
        initiator: null,
        workspaceProvisionType: "unmanaged",
        path: "/tmp/project",
        checkout: { kind: "existing" },
      }),
    ).toThrow();

    expect(() =>
      hostDaemonOnlineRpcCommandSchema.parse({
        type: "host.read_file",
        path: "/tmp/bb-data/thread-storage/thread-123/notes.md",
        ref: "HEAD",
      }),
    ).toThrow();

    expect(() =>
      hostDaemonOnlineRpcCommandSchema.parse({
        type: "host.read_file_relative",
        rootPath: "/tmp/bb-data/apps/demo/assets",
        path: "logo.png",
      }),
    ).toThrow();
  });

  it("requires environmentId on thread and turn commands", () => {
    expect(() =>
      hostDaemonCommandSchema.parse({
        type: "thread.start",
        bridgeLaunch: BRIDGE_LAUNCH,
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
          providerOptions: {},
          permissionMode: "full",
          permissionScope: "full",
          approvalReviewer: null,
          permissionEscalation: null,
        },
        instructions: "Be concise.",
        dynamicTools: [],
        contributedEnv: [],
        injectedSkillSources: [],
        instructionMode: "append",
        requestId: CLIENT_REQUEST_ID,
        input: [{ type: "text", text: "hello", mentions: [] }],
      }),
    ).toThrow();

    expect(() =>
      hostDaemonCommandSchema.parse({
        type: "turn.submit",
        bridgeLaunch: BRIDGE_LAUNCH,
        threadId: "thr_123",
        requestId: CLIENT_REQUEST_ID,
        input: [{ type: "text", text: "follow up", mentions: [] }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          providerOptions: {},
          permissionMode: "full",
          permissionScope: "full",
          approvalReviewer: null,
          permissionEscalation: null,
        },
        resumeContext: {
          bridgeLaunch: BRIDGE_LAUNCH,
          workspaceContext: {
            workspacePath: "/tmp/workspace",
            workspaceProvisionType: "unmanaged",
          },
          projectId: "proj_123",
          providerId: "codex",
          providerThreadId: "prov_123",
          instructions: "Be concise.",
          dynamicTools: [],
          contributedEnv: [],
          injectedSkillSources: [],
          instructionMode: "append",
        },
        target: { mode: "start" },
      }),
    ).toThrow();
  });

  it("parses section mentions in thread.start", () => {
    expect(
      hostDaemonCommandSchema.parse({
        type: "thread.start",
        bridgeLaunch: BRIDGE_LAUNCH,
        environmentId: "env_123",
        threadId: "thr_123",
        workspaceContext: {
          workspacePath: "/tmp/workspace",
          workspaceProvisionType: "unmanaged",
        },
        projectId: "proj_123",
        providerId: "codex",
        requestId: CLIENT_REQUEST_ID,
        input: [
          {
            type: "text",
            text: "@release",
            mentions: [
              {
                start: 0,
                end: 8,
                resource: {
                  kind: "section",
                  sectionId: "sec_release",
                  label: "Release QA",
                },
              },
            ],
          },
        ],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          providerOptions: {},
          permissionMode: "full",
          permissionScope: "full",
          approvalReviewer: null,
          permissionEscalation: null,
        },
        instructions: "Be a helpful thread.",
        dynamicTools: [
          {
            name: "notify_user",
            description: "Send a thread-visible update",
            inputSchema: { type: "object" },
          },
        ],
        contributedEnv: [],
        injectedSkillSources: [],
        instructionMode: "replace",
      }),
    ).toMatchObject({
      type: "thread.start",
      bridgeLaunch: BRIDGE_LAUNCH,
      input: [
        {
          mentions: [
            {
              resource: {
                kind: "section",
                sectionId: "sec_release",
                label: "Release QA",
              },
            },
          ],
        },
      ],
      workspaceContext: {
        workspacePath: "/tmp/workspace",
        workspaceProvisionType: "unmanaged",
      },
    });
  });

  it.each([
    {
      permissionMode: "accept-edits" as const,
      permissionScope: "workspace" as const,
      approvalReviewer: "user" as const,
    },
    {
      permissionMode: "auto" as const,
      permissionScope: "workspace" as const,
      approvalReviewer: "automatic" as const,
    },
  ])(
    "parses explicit $permissionMode runtime enforcement",
    ({ permissionMode, permissionScope, approvalReviewer }) => {
      const command = {
        type: "thread.start" as const,
        bridgeLaunch: BRIDGE_LAUNCH,
        environmentId: "env_123",
        threadId: "thr_123",
        workspaceContext: {
          workspacePath: "/tmp/workspace",
          workspaceProvisionType: "unmanaged" as const,
        },
        projectId: "proj_123",
        providerId: "codex",
        requestId: CLIENT_REQUEST_ID,
        input: [{ type: "text" as const, text: "hello", mentions: [] }],
        options: {
          model: "gpt-5",
          serviceTier: "default" as const,
          reasoningLevel: "medium" as const,
          providerOptions: {},
          permissionMode,
          permissionScope,
          approvalReviewer,
          permissionEscalation: "ask" as const,
        },
        instructions: "Be concise.",
        dynamicTools: [],
        contributedEnv: [],
        injectedSkillSources: [],
        instructionMode: "append" as const,
      };

      expect(hostDaemonCommandSchema.parse(command)).toMatchObject({
        options: { permissionMode, permissionScope, approvalReviewer },
      });
      expect(
        hostDaemonCommandSchema.safeParse({
          ...command,
          options: { ...command.options, permissionScope: "full" },
        }).success,
      ).toBe(false);
    },
  );

  it("parses section mentions in turn.submit follow-ups", () => {
    expect(
      hostDaemonCommandSchema.parse({
        type: "turn.submit",
        bridgeLaunch: BRIDGE_LAUNCH,
        environmentId: "env_123",
        threadId: "thr_123",
        requestId: CLIENT_REQUEST_ID,
        input: [
          {
            type: "text",
            text: "Review @release",
            mentions: [
              {
                start: 7,
                end: 15,
                resource: {
                  kind: "section",
                  sectionId: "sec_release",
                  label: "Release QA",
                },
              },
            ],
          },
        ],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          providerOptions: {},
          permissionMode: "full",
          permissionScope: "full",
          approvalReviewer: null,
          permissionEscalation: null,
        },
        resumeContext: {
          bridgeLaunch: BRIDGE_LAUNCH,
          workspaceContext: {
            workspacePath: "/tmp/workspace",
            workspaceProvisionType: "unmanaged",
          },
          projectId: "proj_123",
          providerId: "codex",
          providerThreadId: "provider_123",
          instructions: "Be a helpful coding agent.",
          dynamicTools: [],
          contributedEnv: [],
          injectedSkillSources: [],
          instructionMode: "append",
        },
        target: { mode: "start" },
      }),
    ).toMatchObject({
      type: "turn.submit",
      bridgeLaunch: BRIDGE_LAUNCH,
      input: [
        {
          mentions: [
            {
              resource: {
                kind: "section",
                sectionId: "sec_release",
                label: "Release QA",
              },
            },
          ],
        },
      ],
    });
  });

  it("rejects grouped commands whose flat input disagrees with inputGroups", () => {
    const threadStartCommand = {
      type: "thread.start",
      bridgeLaunch: BRIDGE_LAUNCH,
      environmentId: "env_123",
      threadId: "thr_123",
      workspaceContext: {
        workspacePath: "/tmp/workspace",
        workspaceProvisionType: "unmanaged",
      },
      projectId: "proj_123",
      providerId: "codex",
      requestId: CLIENT_REQUEST_ID,
      input: [{ type: "text", text: "different", mentions: [] }],
      inputGroups: [[{ type: "text", text: "grouped", mentions: [] }]],
      options: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        providerOptions: {},
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
      instructions: "Be a helpful thread.",
      dynamicTools: [],
      contributedEnv: [],
      injectedSkillSources: [],
      instructionMode: "replace",
    };

    expect(() => hostDaemonCommandSchema.parse(threadStartCommand)).toThrow(
      /flattened inputGroups/u,
    );
    expect(() =>
      hostDaemonCommandSchema.parse({
        ...threadStartCommand,
        fork: { sourceProviderThreadId: "provider-source" },
        input: [],
      }),
    ).toThrow(/flattened inputGroups/u);

    const turnSubmitCommand = {
      type: "turn.submit",
      bridgeLaunch: BRIDGE_LAUNCH,
      environmentId: "env_123",
      threadId: "thr_123",
      requestId: CLIENT_REQUEST_ID,
      input: [{ type: "text", text: "different", mentions: [] }],
      inputGroups: [[{ type: "text", text: "grouped", mentions: [] }]],
      options: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        providerOptions: {},
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
      resumeContext: {
        bridgeLaunch: BRIDGE_LAUNCH,
        workspaceContext: {
          workspacePath: "/tmp/workspace",
          workspaceProvisionType: "unmanaged",
        },
        projectId: "proj_123",
        providerId: "codex",
        providerThreadId: "provider_123",
        instructions: "Be a helpful coding agent.",
        dynamicTools: [],
        contributedEnv: [],
        injectedSkillSources: [],
        instructionMode: "append",
      },
      target: { mode: "start" },
    };
    expect(() => hostDaemonCommandSchema.parse(turnSubmitCommand)).toThrow(
      /flattened inputGroups/u,
    );
  });

  it("round-trips a provider's declared launch spec on provider.list_models, thread.start, and turn.submit", () => {
    const providerListModelsCommand = {
      type: "provider.list_models",
      bridgeLaunch: ACP_BRIDGE_LAUNCH,
      providerId: "acp-local",
      cwd: "/tmp/workspace",
    };
    const providerListModelsRoundTrip = JSON.parse(
      JSON.stringify(providerListModelsCommand),
    );

    expect(
      hostDaemonOnlineRpcCommandSchema.parse(providerListModelsRoundTrip),
    ).toEqual(providerListModelsCommand);
    expect(
      hostDaemonServerWsMessageSchema.parse({
        type: "host-rpc.request",
        requestId: "rpc-acp-models",
        command: providerListModelsRoundTrip,
      }),
    ).toEqual({
      type: "host-rpc.request",
      requestId: "rpc-acp-models",
      command: providerListModelsCommand,
    });

    const threadStartCommand = {
      type: "thread.start",
      bridgeLaunch: ACP_BRIDGE_LAUNCH,
      environmentId: "env_123",
      threadId: "thr_123",
      workspaceContext: {
        workspacePath: "/tmp/workspace",
        workspaceProvisionType: "unmanaged",
      },
      projectId: "proj_123",
      providerId: "acp-local",
      requestId: CLIENT_REQUEST_ID,
      input: [{ type: "text", text: "hello", mentions: [] }],
      options: {
        model: "acp-default",
        serviceTier: "default",
        reasoningLevel: "medium",
        providerOptions: {},
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
      instructions: "Be a helpful thread.",
      dynamicTools: [],
      contributedEnv: CONTRIBUTED_ENV,
      injectedSkillSources: [],
      instructionMode: "append",
    };
    const threadStartRoundTrip = JSON.parse(JSON.stringify(threadStartCommand));

    expect(hostDaemonCommandSchema.parse(threadStartRoundTrip)).toEqual(
      threadStartCommand,
    );

    const turnSubmitCommand = {
      type: "turn.submit",
      bridgeLaunch: ACP_BRIDGE_LAUNCH,
      environmentId: "env_123",
      threadId: "thr_123",
      requestId: CLIENT_REQUEST_ID,
      input: [{ type: "text", text: "follow up", mentions: [] }],
      options: {
        model: "acp-default",
        serviceTier: "default",
        reasoningLevel: "medium",
        providerOptions: {},
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
      resumeContext: {
        bridgeLaunch: ACP_BRIDGE_LAUNCH,
        workspaceContext: {
          workspacePath: "/tmp/workspace",
          workspaceProvisionType: "unmanaged",
        },
        projectId: "proj_123",
        providerId: "acp-local",
        providerThreadId: "provider_123",
        instructions: "Be a helpful thread.",
        dynamicTools: [],
        contributedEnv: CONTRIBUTED_ENV,
        injectedSkillSources: [],
        instructionMode: "append",
      },
      target: { mode: "start" },
    };
    const turnSubmitRoundTrip = JSON.parse(JSON.stringify(turnSubmitCommand));

    expect(hostDaemonCommandSchema.parse(turnSubmitRoundTrip)).toEqual(
      turnSubmitCommand,
    );

    const withoutBridgeLaunch: Record<string, unknown> = {
      ...threadStartRoundTrip,
    };
    delete withoutBridgeLaunch.bridgeLaunch;
    expect(hostDaemonCommandSchema.safeParse(withoutBridgeLaunch).success).toBe(
      false,
    );
  });

  it("round-trips bridge launch specs and rejects malformed artifact sources", () => {
    const bridgeLaunch = {
      pluginId: "provider-echo",
      source: {
        kind: "artifact",
        digest: "a".repeat(64),
        byteLength: 4096,
      },
      capabilities: {
        providerInstallation: true,
        supportsServiceTier: true,
        permissionModes: ["accept-edits", "full"],
        supportsThreadArchive: false,
        supportsThreadRename: false,
        fork: "tip",
      },
      providerOptions: { launch: { command: "echo-agent" } },
      envPassthrough: ["BB_ECHO_AGENT_EXECUTABLE"],
    };

    const providerListModelsCommand = {
      type: "provider.list_models",
      providerId: "echo-agent",
      bridgeLaunch,
      cwd: "/tmp/workspace",
    };
    expect(
      hostDaemonOnlineRpcCommandSchema.parse(
        JSON.parse(JSON.stringify(providerListModelsCommand)),
      ),
    ).toEqual(providerListModelsCommand);

    const threadStartCommand = {
      type: "thread.start",
      environmentId: "env_123",
      threadId: "thr_123",
      workspaceContext: {
        workspacePath: "/tmp/workspace",
        workspaceProvisionType: "unmanaged",
      },
      projectId: "proj_123",
      providerId: "echo-agent",
      bridgeLaunch,
      requestId: CLIENT_REQUEST_ID,
      input: [{ type: "text", text: "hello", mentions: [] }],
      options: {
        model: "echo-default",
        serviceTier: "default",
        reasoningLevel: "medium",
        providerOptions: {},
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
      instructions: "Be a helpful thread.",
      dynamicTools: [],
      contributedEnv: [],
      injectedSkillSources: [],
      instructionMode: "append",
    };
    expect(
      hostDaemonCommandSchema.parse(
        JSON.parse(JSON.stringify(threadStartCommand)),
      ),
    ).toEqual(threadStartCommand);

    const goalClearCommand = {
      type: "thread.goal.clear",
      environmentId: "env_123",
      threadId: "thr_123",
      options: threadStartCommand.options,
      bridgeLaunch,
      resumeContext: {
        workspaceContext: threadStartCommand.workspaceContext,
        projectId: "proj_123",
        providerId: "echo-agent",
        providerThreadId: "provider_123",
        bridgeLaunch,
        instructions: "Be a helpful thread.",
        dynamicTools: [],
        contributedEnv: [],
        injectedSkillSources: [],
        instructionMode: "append",
      },
    };
    expect(
      hostDaemonCommandSchema.parse(
        JSON.parse(JSON.stringify(goalClearCommand)),
      ),
    ).toEqual(goalClearCommand);

    for (const source of [
      { kind: "artifact", digest: "not-a-hash", byteLength: 4096 },
      { kind: "artifact", digest: "A".repeat(64), byteLength: 4096 },
      { kind: "artifact", digest: "a".repeat(64), byteLength: 0 },
      { kind: "bundled" },
      { kind: "daemon-bundled", id: "pi" },
    ]) {
      expect(
        hostDaemonCommandSchema.safeParse({
          ...threadStartCommand,
          bridgeLaunch: { pluginId: "provider-echo", source },
        }).success,
      ).toBe(false);
    }
    expect(
      hostDaemonCommandSchema.safeParse({
        ...threadStartCommand,
        bridgeLaunch: {
          source: bridgeLaunch.source,
          capabilities: bridgeLaunch.capabilities,
        },
      }).success,
    ).toBe(false);
  });

  it("parses every injected skill source variant", () => {
    const base = {
      name: "workflow-help",
      description: "Use when building workflows.",
    };
    const tree = {
      ...base,
      kind: "tree",
      treeHash: "a".repeat(64),
      entryPath: "SKILL.md",
    };

    expect(
      hostDaemonInjectedSkillSourceSchema.parse({
        ...tree,
        sourceType: "builtin",
      }),
    ).toMatchObject({ kind: "tree", sourceType: "builtin" });
    expect(
      hostDaemonInjectedSkillSourceSchema.parse({
        ...tree,
        sourceType: "data-dir",
      }),
    ).toMatchObject({ kind: "tree", sourceType: "data-dir" });
    expect(
      hostDaemonInjectedSkillSourceSchema.parse({
        ...base,
        kind: "workspace-path",
        sourceType: "project",
        sourceRootPath: "/workspace/.bb/skills/workflow-help",
        skillFilePath: "/workspace/.bb/skills/workflow-help/SKILL.md",
      }),
    ).toMatchObject({ kind: "workspace-path", sourceType: "project" });
    expect(
      hostDaemonInjectedSkillSourceSchema.parse({
        ...base,
        kind: "host-path",
        sourceType: "shared-user",
        sourceRootPath: "/home/user/.agents/skills/workflow-help",
        skillFilePath: "/home/user/.agents/skills/workflow-help/SKILL.md",
      }),
    ).toMatchObject({ kind: "host-path", sourceType: "shared-user" });

    expect(() =>
      hostDaemonInjectedSkillSourceSchema.parse({
        ...tree,
        sourceType: "project",
      }),
    ).toThrow();
  });

  it("keeps contract optional fields on an explicit allowlist", () => {
    const optionalFieldPaths = collectOptionalFieldPaths({
      hostDaemonActiveThreadSchema: contract.hostDaemonActiveThreadSchema,
      hostDaemonCommandSchema: contract.hostDaemonCommandSchema,
      hostDaemonInteractiveRequestSchema:
        contract.hostDaemonInteractiveRequestSchema,
      hostDaemonInteractiveRequestResponseSchema:
        contract.hostDaemonInteractiveRequestResponseSchema,
      hostDaemonOnlineRpcCommandSchema:
        contract.hostDaemonOnlineRpcCommandSchema,
      hostDaemonSessionOpenResponseSchema:
        contract.hostDaemonSessionOpenResponseSchema,
      workspaceCommitResultSchema:
        contract.hostDaemonCommandResultSchemaByType["workspace.commit"],
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
        bridgeLaunch: BRIDGE_LAUNCH,
        environmentId: "env_123",
        threadId: "thr_123",
        requestId: CLIENT_REQUEST_ID,
        input: [{ type: "text", text: "hello", mentions: [] }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          providerOptions: {},
          permissionMode: "full",
          permissionScope: "full",
          approvalReviewer: null,
          permissionEscalation: null,
        },
        resumeContext: {
          bridgeLaunch: BRIDGE_LAUNCH,
          workspaceContext: {
            workspacePath: "/tmp/workspace",
            workspaceProvisionType: "unmanaged",
          },
          projectId: "proj_123",
          providerId: "codex",
          providerThreadId: "provider_123",
          instructions: "Be a helpful coding agent.",
          dynamicTools: [],
          contributedEnv: [],
          injectedSkillSources: [],
          instructionMode: "append",
        },
        target: { mode: "start" },
      }),
    ).toMatchObject({
      type: "turn.submit",
      requestId: CLIENT_REQUEST_ID,
      resumeContext: {
        bridgeLaunch: BRIDGE_LAUNCH,
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
        bridgeLaunch: BRIDGE_LAUNCH,
        environmentId: "env_123",
        threadId: "thr_123",
        requestId: CLIENT_REQUEST_ID,
        input: [{ type: "text", text: "adjust", mentions: [] }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          providerOptions: {},
          permissionMode: "full",
          permissionScope: "full",
          approvalReviewer: null,
          permissionEscalation: null,
        },
        resumeContext: {
          bridgeLaunch: BRIDGE_LAUNCH,
          workspaceContext: {
            workspacePath: "/tmp/workspace",
            workspaceProvisionType: "unmanaged",
          },
          projectId: "proj_123",
          providerId: "codex",
          providerThreadId: "provider_123",
          instructions: "Be a helpful coding agent.",
          dynamicTools: [],
          contributedEnv: [],
          injectedSkillSources: [],
          instructionMode: "append",
        },
        target: { mode: "auto", expectedTurnId: "turn_123" },
      }),
    ).toMatchObject({
      type: "turn.submit",
      bridgeLaunch: BRIDGE_LAUNCH,
      requestId: CLIENT_REQUEST_ID,
      target: { mode: "auto", expectedTurnId: "turn_123" },
    });

    expect(() =>
      hostDaemonCommandSchema.parse({
        type: "turn.submit",
        bridgeLaunch: BRIDGE_LAUNCH,
        environmentId: "env_123",
        threadId: "thr_123",
        input: [{ type: "text", text: "hello", mentions: [] }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          providerOptions: {},
          permissionMode: "full",
          permissionScope: "full",
          approvalReviewer: null,
          permissionEscalation: null,
        },
        resumeContext: {
          bridgeLaunch: BRIDGE_LAUNCH,
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
        bridgeLaunch: BRIDGE_LAUNCH,
        environmentId: "env_123",
        threadId: "thr_123",
        workspaceContext: {
          workspacePath: "/tmp/workspace",
          workspaceProvisionType: "unmanaged",
        },
        projectId: "proj_123",
        providerId: "codex",
        requestId: CLIENT_REQUEST_ID,
        input: [{ type: "text", text: "hello", mentions: [] }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          providerOptions: {},
          permissionMode: "full",
          permissionScope: "full",
          approvalReviewer: null,
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
        bridgeLaunch: BRIDGE_LAUNCH,
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
        input: [{ type: "text", text: "hello", mentions: [] }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          providerOptions: {},
          permissionMode: "full",
          permissionScope: "full",
          approvalReviewer: null,
          permissionEscalation: null,
        },
        instructions: "Be concise.",
        dynamicTools: [],
        contributedEnv: [],
        injectedSkillSources: [],
        instructionMode: "append",
      }),
    ).toThrow();

    expect(() =>
      hostDaemonCommandSchema.parse({
        type: "turn.submit",
        bridgeLaunch: BRIDGE_LAUNCH,
        environmentId: "env_123",
        threadId: "thr_123",
        requestId: CLIENT_REQUEST_ID,
        eventSequence: 2,
        input: [{ type: "text", text: "hello", mentions: [] }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          providerOptions: {},
          permissionMode: "full",
          permissionScope: "full",
          approvalReviewer: null,
          permissionEscalation: null,
        },
        resumeContext: {
          bridgeLaunch: BRIDGE_LAUNCH,
          workspaceContext: {
            workspacePath: "/tmp/workspace",
            workspaceProvisionType: "unmanaged",
          },
          projectId: "proj_123",
          providerId: "codex",
          providerThreadId: "provider_123",
          instructions: "Be a helpful coding agent.",
          dynamicTools: [],
          contributedEnv: [],
          injectedSkillSources: [],
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

  it("rejects invalid branch names at command boundaries", () => {
    expect(
      hostDaemonCommandSchema.safeParse({
        type: "host.list_branch_options",
        path: "/tmp/workspace",
        selectedBranch: "origin/main lock",
        limit: 50,
        remoteRefresh: "none",
      }).success,
    ).toBe(false);

    expect(
      hostDaemonCommandSchema.safeParse({
        type: "environment.provision",
        environmentId: "env_123",
        initiator: null,
        workspaceProvisionType: "unmanaged",
        path: "/tmp/project",
        checkout: { kind: "existing", name: "feature/test lock" },
      }).success,
    ).toBe(false);

    expect(
      hostDaemonCommandSchema.safeParse({
        type: "environment.provision",
        environmentId: "env_123",
        initiator: null,
        workspaceProvisionType: "unmanaged",
        path: "/tmp/project",
        checkout: {
          kind: "new",
          name: "bb/env-123",
          baseBranch: "release lock",
        },
      }).success,
    ).toBe(false);

    expect(
      hostDaemonCommandSchema.safeParse({
        type: "environment.provision",
        environmentId: "env_123",
        initiator: null,
        workspaceProvisionType: "managed-worktree",
        sourcePath: "/tmp/project",
        targetPath: "/tmp/project/.bb/env",
        branchName: "bb/env lock",
        baseBranch: null,
        setupTimeoutMs: 900000,
      }).success,
    ).toBe(false);

    expect(
      hostDaemonCommandSchema.safeParse({
        type: "environment.provision",
        environmentId: "env_123",
        initiator: null,
        workspaceProvisionType: "managed-worktree",
        sourcePath: "/tmp/project",
        targetPath: "/tmp/project/.bb/env",
        branchName: "bb/env-123",
        baseBranch: "release lock",
        setupTimeoutMs: 900000,
      }).success,
    ).toBe(false);

    expect(
      hostDaemonCommandSchema.safeParse({
        type: "workspace.status",
        environmentId: "env_123",
        environmentStatus: "ready",
        maxUntrackedLineStatFiles: 50,
        maxUntrackedLineStatBytes: 8 * 1024 * 1024,
        workspaceContext: {
          workspacePath: "/tmp/workspace",
          workspaceProvisionType: "unmanaged",
        },
        mergeBaseBranch: "origin/main lock",
      }).success,
    ).toBe(false);
  });

  it("limits host.write_skill to daemon-derived bb roots", () => {
    const base = {
      type: "host.write_skill",
      name: "review",
      cwd: null,
      content: "# Review",
      expectedSha256: "a".repeat(64),
    } as const;
    expect(
      hostDaemonOnlineRpcCommandSchema.safeParse({
        ...base,
        scope: "bb-user",
      }).success,
    ).toBe(true);
    expect(
      hostDaemonOnlineRpcCommandSchema.safeParse({
        ...base,
        scope: "provider-user",
      }).success,
    ).toBe(false);
  });

  it("bounds file list command queries and limits", () => {
    const longQuery = "a".repeat(contract.FILE_LIST_QUERY_MAX_LENGTH + 1);

    expect(() =>
      hostDaemonOnlineRpcCommandSchema.parse({
        type: "host.list_files",
        path: "/tmp/bb-data/thread-storage/thread-123",
        query: longQuery,
        limit: 100,
      }),
    ).toThrow();

    expect(() =>
      hostDaemonOnlineRpcCommandSchema.parse({
        type: "host.list_files",
        path: "/tmp/bb-data/thread-storage/thread-123",
        limit: contract.FILE_LIST_LIMIT_MAX + 1,
      }),
    ).toThrow();

    expect(() =>
      hostDaemonOnlineRpcCommandSchema.parse({
        type: "host.list_files",
        path: "/tmp/workspace",
        query: longQuery,
        limit: 100,
      }),
    ).toThrow();

    expect(() =>
      hostDaemonOnlineRpcCommandSchema.parse({
        type: "host.list_files",
        path: "/tmp/workspace",
        limit: contract.FILE_LIST_LIMIT_MAX + 1,
      }),
    ).toThrow();

    expect(() =>
      hostDaemonOnlineRpcCommandSchema.parse({
        type: "host.list_paths",
        path: "/tmp/workspace",
        query: longQuery,
        limit: 100,
        includeFiles: true,
        includeDirectories: true,
      }),
    ).toThrow();

    expect(() =>
      hostDaemonOnlineRpcCommandSchema.parse({
        type: "host.list_paths",
        path: "/tmp/workspace",
        limit: contract.FILE_LIST_LIMIT_MAX + 1,
        includeFiles: true,
        includeDirectories: true,
      }),
    ).toThrow();

    expect(() =>
      hostDaemonOnlineRpcCommandSchema.parse({
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
      hostDaemonOnlineRpcResultSchemaByType["host.list_files"].parse({
        files: [{ path: "notes/today.md", name: "today.md" }],
        truncated: false,
      }),
    ).toMatchObject({
      files: [{ path: "notes/today.md", name: "today.md" }],
      truncated: false,
    });

    expect(
      hostDaemonOnlineRpcResultSchemaByType["host.list_paths"].parse({
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
      hostDaemonOnlineRpcResultSchemaByType["host.inspect_git_source"].parse({
        checkout: {
          kind: "branch",
          branchName: "feature/test",
          headSha: "abc123",
        },
        defaultBranch: "main",
        defaultBranchRelation: "equal",
        hasUncommittedChanges: true,
        operation: { kind: "merge", hasConflicts: true },
        originDefaultBranch: "origin/main",
      }),
    ).toMatchObject({
      checkout: {
        kind: "branch",
        branchName: "feature/test",
      },
      hasUncommittedChanges: true,
      operation: { kind: "merge", hasConflicts: true },
    });

    expect(
      hostDaemonOnlineRpcResultSchemaByType["host.read_file"].parse({
        path: "/tmp/bb-data/thread-storage/thread-123/notes.md",
        content: "# Notes",
        contentEncoding: "utf8",
        mimeType: "text/markdown",
        sizeBytes: 13,
        sha256: "d".repeat(64),
      }),
    ).toMatchObject({
      path: "/tmp/bb-data/thread-storage/thread-123/notes.md",
      content: "# Notes",
      contentEncoding: "utf8",
    });

    expect(
      hostDaemonOnlineRpcResultSchemaByType["host.read_file_relative"].parse({
        path: "assets/logo.png",
        content: "iVBORw0KGgo=",
        contentEncoding: "base64",
        mimeType: "image/png",
        sizeBytes: 8,
        sha256: "f".repeat(64),
      }),
    ).toMatchObject({
      path: "assets/logo.png",
      content: "iVBORw0KGgo=",
      contentEncoding: "base64",
    });

    expect(
      hostDaemonOnlineRpcResultSchemaByType["host.file_metadata"].parse({
        path: "/tmp/bb-data/thread-storage/thread-123/notes.md",
        modifiedAtMs: 1234.5,
        sizeBytes: 26_214_401,
      }),
    ).toMatchObject({
      path: "/tmp/bb-data/thread-storage/thread-123/notes.md",
      modifiedAtMs: 1234.5,
      sizeBytes: 26_214_401,
    });

    expect(
      hostDaemonOnlineRpcResultSchemaByType["workspace.status"].parse({
        outcome: "available",
        workspaceStatus: {
          workingTree: {
            insertions: 0,
            deletions: 0,
            lineStatsComplete: true,
            files: [],
            hasUncommittedChanges: false,
            state: "clean",
          },
          branch: {
            currentBranch: "bb/env-123",
            defaultBranch: "main",
          },
          checkout: {
            kind: "branch",
            branchName: "bb/env-123",
            headSha: null,
          },
          mergeBase: null,
        },
      }),
    ).toMatchObject({
      outcome: "available",
      workspaceStatus: {
        workingTree: {
          state: "clean",
        },
      },
    });

    expect(
      hostDaemonOnlineRpcResultSchemaByType["workspace.diff"].parse({
        outcome: "unavailable",
        failure: {
          code: "not_git_repo",
          workspacePath: "/tmp/workspace",
          message: "Path is not a git repository: /tmp/workspace",
        },
      }),
    ).toMatchObject({
      outcome: "unavailable",
      failure: {
        code: "not_git_repo",
      },
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
        hasMachineCredential: true,
        platform: "darwin",
        dataDir: "/tmp/bb-data",
        localApiPort: 38_887,
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
      hasMachineCredential: true,
      loadedEnvironments: [],
    });

    expect(
      hostDaemonSessionOpenRequestSchema.parse({
        hostId: "host_123",
        instanceId: "instance_1",
        hostName: "Michael's MacBook",
        hostType: "persistent",
        hasMachineCredential: false,
        platform: "darwin",
        dataDir: "/tmp/bb-data",
        localApiPort: null,
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        activeThreads: [],
        loadedEnvironments: [
          {
            environmentId: "env_123",
          },
        ],
      }),
    ).toMatchObject({
      loadedEnvironments: [
        {
          environmentId: "env_123",
        },
      ],
    });

    expect(() =>
      hostDaemonSessionOpenRequestSchema.parse({
        hostId: "host_123",
        instanceId: "instance_1",
        hostName: "Michael's MacBook",
        hostType: "persistent",
        hasMachineCredential: true,
        platform: "darwin",
        dataDir: "/tmp/bb-data",
        localApiPort: 38_887,
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        activeThreads: [
          {
            threadId: "",
          },
        ],
      }),
    ).toThrow();

    expect(
      hostDaemonSessionOpenRequestSchema.parse({
        hostId: "host_123",
        instanceId: "instance_1",
        hostName: "Michael's MacBook",
        hostType: "persistent",
        hasMachineCredential: true,
        platform: "darwin",
        dataDir: "/tmp/bb-data",
        localApiPort: 38_887,
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION - 1,
        activeThreads: [],
      }),
    ).toMatchObject({
      protocolVersion: HOST_DAEMON_PROTOCOL_VERSION - 1,
    });

    expect(() =>
      hostDaemonSessionOpenRequestSchema.parse({
        hostId: "host_123",
        instanceId: "instance_1",
        hostName: "Michael's MacBook",
        hostType: "persistent",
        hasMachineCredential: true,
        platform: "darwin",
        dataDir: "/tmp/bb-data",
        localApiPort: 38_887,
        protocolVersion: 0,
        activeThreads: [],
      }),
    ).toThrow();

    expect(
      hostDaemonSessionOpenResponseSchema.parse({
        sessionId: "session_123",
        heartbeatIntervalMs: 5_000,
        leaseTimeoutMs: 30_000,
        connectShares: {
          generation: 2,
          ports: [3000, 8080],
        },
      }),
    ).toMatchObject({
      sessionId: "session_123",
      connectShares: {
        generation: 2,
        ports: [3000, 8080],
      },
      retiredEnvironmentIds: [],
      watchSet: {
        generation: 0,
        workspaceTargets: [],
        threadStorageTargets: [],
      },
    });

    expect(
      hostDaemonSessionOpenResponseSchema.parse({
        sessionId: "session_default_shares",
        heartbeatIntervalMs: 5_000,
        leaseTimeoutMs: 30_000,
      }).connectShares,
    ).toEqual({ generation: 0, ports: [] });

    expect(() =>
      hostDaemonSessionOpenResponseSchema.parse({
        sessionId: "session_123",
        heartbeatIntervalMs: 5_000,
        leaseTimeoutMs: 30_000,
        threadHighWaterMarks: { thr_123: 10 },
      }),
    ).toThrow();

    expect(
      hostDaemonEventBatchRequestSchema.parse({
        sessionId: "session_123",
        eventGroups: [
          {
            threadId: "thr_123",
            events: [
              {
                type: "system/error",
                threadId: "thr_123",
                scope: threadScope(),
                message: "boom",
              },
            ],
          },
        ],
      }),
    ).toMatchObject({
      sessionId: "session_123",
      eventGroups: [
        {
          threadId: "thr_123",
        },
      ],
    });

    expect(
      hostDaemonEventBatchRequestSchema.parse({
        sessionId: "session_123",
        eventGroups: [
          {
            threadId: "thr_123",
            events: [
              {
                type: "thread/context/cleared",
                threadId: "thr_123",
                providerThreadId: "provider-thread-123",
                scope: turnScope("turn_123"),
              },
            ],
          },
        ],
      }),
    ).toMatchObject({
      eventGroups: [
        {
          events: [{ type: "thread/context/cleared" }],
        },
      ],
    });

    expect(
      hostDaemonEventBatchResponseSchema.parse({
        acceptedEvents: [
          {
            eventIndex: 0,
            threadId: "thr_123",
            sequence: 42,
          },
        ],
        rejectedEvents: [
          {
            eventIndex: 1,
            reason: "thread_not_owned_by_host",
            threadId: "thr_stale",
          },
        ],
      }),
    ).toEqual({
      acceptedEvents: [
        {
          eventIndex: 0,
          threadId: "thr_123",
          sequence: 42,
        },
      ],
      rejectedEvents: [
        {
          eventIndex: 1,
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
            eventIndex: 1,
            reason: "unknown_reason",
            threadId: "thr_stale",
          },
        ],
      }),
    ).toThrow();

    expect(() =>
      hostDaemonEventBatchRequestSchema.parse({
        sessionId: "session_123",
        eventGroups: [
          {
            threadId: "thr_123",
            events: [
              {
                type: "system/error",
                threadId: "thr_123",
                scope: threadScope(),
                message: "boom",
                sequence: 1,
              },
            ],
          },
        ],
      }),
    ).toThrow();

    const parsed = hostDaemonEventBatchRequestSchema.parse({
      sessionId: "session_123",
      eventGroups: [
        {
          threadId: "thr_123",
          events: [
            {
              type: "item/started",
              threadId: "thr_123",
              providerThreadId: "provider-1",
              scope: turnScope("turn-1"),
              item: {
                type: "toolCall",
                id: "tool-2",
                tool: "Read",
                status: "pending",
                statusLabels: { pending: "Spoofed", completed: "Spoofed" },
              },
            },
          ],
        },
      ],
    });
    const [group] = parsed.eventGroups;
    const started = group?.events.find(
      (event) => event.type === "item/started",
    );
    expect(started).toBeDefined();
    if (started?.type !== "item/started") {
      throw new Error("Expected the spoofed event to parse as item/started");
    }
    expect(started.item).not.toHaveProperty("statusLabels");

    expect(() =>
      hostDaemonEventBatchResponseSchema.parse({
        acceptedEvents: [
          {
            eventIndex: 0,
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
      hostDaemonDaemonWsMessageSchema.parse({
        type: "environment-change",
        environmentId: "env_123",
        change: "work-status-changed",
      }),
    ).toEqual({
      type: "environment-change",
      environmentId: "env_123",
      change: "work-status-changed",
    });

    expect(
      hostDaemonDaemonWsMessageSchema.parse({
        type: "environment-change",
        environmentId: "env_123",
        change: "git-refs-changed",
      }),
    ).toEqual({
      type: "environment-change",
      environmentId: "env_123",
      change: "git-refs-changed",
    });

    expect(
      hostDaemonDaemonWsMessageSchema.parse({
        type: "environment-change",
        environmentId: "env_123",
        change: "thread-storage-changed",
      }),
    ).toEqual({
      type: "environment-change",
      environmentId: "env_123",
      change: "thread-storage-changed",
    });

    expect(
      hostDaemonDaemonWsMessageSchema.parse({
        type: "environment-metadata-change",
        environmentId: "env_123",
        workspace: {
          path: "/tmp/workspace",
          isGitRepo: true,
          isWorktree: false,
          branchName: "main",
          defaultBranch: "main",
        },
      }),
    ).toEqual({
      type: "environment-metadata-change",
      environmentId: "env_123",
      workspace: {
        path: "/tmp/workspace",
        isGitRepo: true,
        isWorktree: false,
        branchName: "main",
        defaultBranch: "main",
      },
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

  it("restricts daemon websocket control and RPC messages", () => {
    expect(
      hostDaemonServerWsMessageSchema.safeParse({
        type: "commands-available",
      }).success,
    ).toBe(false);

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

    expect(
      hostDaemonServerWsMessageSchema.parse({
        type: "heartbeat-ack",
      }),
    ).toEqual({ type: "heartbeat-ack" });

    expect(() =>
      hostDaemonServerWsMessageSchema.parse({
        type: "heartbeat-ack",
        sessionId: "session-1",
      }),
    ).toThrow();

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

    expect(
      hostDaemonServerWsMessageSchema.parse({
        type: "host-rpc.request",
        requestId: "rpc-1",
        command: {
          type: "provider.list_models",
          providerId: "codex",
          bridgeLaunch: BRIDGE_LAUNCH,
        },
      }),
    ).toEqual({
      type: "host-rpc.request",
      requestId: "rpc-1",
      command: {
        type: "provider.list_models",
        providerId: "codex",
        bridgeLaunch: BRIDGE_LAUNCH,
      },
    });

    expect(
      hostDaemonServerWsMessageSchema.parse({
        type: "watch-set.replace",
        generation: 1,
        workspaceTargets: [
          {
            environmentId: "env_123",
            workspaceContext: {
              workspacePath: "/tmp/env-123",
              workspaceProvisionType: "unmanaged",
            },
          },
        ],
        threadStorageTargets: [
          {
            environmentId: "env_123",
            threadId: "thr_123",
          },
        ],
      }),
    ).toMatchObject({
      type: "watch-set.replace",
      generation: 1,
      workspaceTargets: [
        {
          environmentId: "env_123",
        },
      ],
      threadStorageTargets: [
        {
          threadId: "thr_123",
        },
      ],
    });

    expect(
      hostDaemonServerWsMessageSchema.parse({
        type: "connect-shares.replace",
        generation: 3,
        ports: [3000, 8080],
      }),
    ).toEqual({
      type: "connect-shares.replace",
      generation: 3,
      ports: [3000, 8080],
    });

    expect(
      hostDaemonServerWsMessageSchema.safeParse({
        type: "connect-shares.replace",
        generation: 4,
        ports: [3000],
        tunnel: {
          label: "sawyer-air",
          baseDomain: "getbb.app",
        },
      }).success,
    ).toBe(false);

    expect(
      hostDaemonDaemonWsMessageSchema.parse({
        type: "connect-tunnel.identity",
        identity: { label: "sawyer-air", baseDomain: "getbb.app" },
      }),
    ).toEqual({
      type: "connect-tunnel.identity",
      identity: { label: "sawyer-air", baseDomain: "getbb.app" },
    });

    expect(
      hostDaemonDaemonWsMessageSchema.parse({
        type: "plugin-host.worker-exited",
        pluginId: "keep-awake",
        generation: "generation-1",
      }),
    ).toEqual({
      type: "plugin-host.worker-exited",
      pluginId: "keep-awake",
      generation: "generation-1",
    });

    expect(
      hostDaemonDaemonWsMessageSchema.parse({
        type: "plugin-host.signal",
        pluginId: "fixture",
        generation: "generation-1",
        signal: "changed",
        payload: { sequence: 2 },
      }),
    ).toEqual({
      type: "plugin-host.signal",
      pluginId: "fixture",
      generation: "generation-1",
      signal: "changed",
      payload: { sequence: 2 },
    });

    expect(
      hostDaemonDaemonWsMessageSchema.parse({
        type: "host-rpc.response",
        requestId: "rpc-1",
        commandType: "provider.list_models",
        ok: true,
        result: ONLINE_RPC_RESPONSE_RESULT_FIXTURES["provider.list_models"],
      }),
    ).toEqual({
      type: "host-rpc.response",
      requestId: "rpc-1",
      commandType: "provider.list_models",
      ok: true,
      result: ONLINE_RPC_RESPONSE_RESULT_FIXTURES["provider.list_models"],
    });

    expect(
      hostDaemonDaemonWsMessageSchema.parse({
        type: "host-rpc.response",
        requestId: "rpc-1",
        commandType: "host.read_file",
        ok: true,
        result: {
          path: "/tmp/bb-data/thread-storage/thread-123/notes.md",
          content: "# Notes",
          contentEncoding: "utf8",
          mimeType: "text/markdown",
          modifiedAtMs: 1234.5,
          sizeBytes: 13,
          sha256: "e".repeat(64),
        },
      }),
    ).toEqual({
      type: "host-rpc.response",
      requestId: "rpc-1",
      commandType: "host.read_file",
      ok: true,
      result: {
        path: "/tmp/bb-data/thread-storage/thread-123/notes.md",
        content: "# Notes",
        contentEncoding: "utf8",
        mimeType: "text/markdown",
        modifiedAtMs: 1234.5,
        sizeBytes: 13,
        sha256: "e".repeat(64),
      },
    });

    expect(
      hostDaemonDaemonWsMessageSchema.parse({
        type: "host-rpc.response",
        requestId: "rpc-1",
        commandType: "host.read_file_relative",
        ok: true,
        result: {
          path: "assets/logo.png",
          content: "iVBORw0KGgo=",
          contentEncoding: "base64",
          mimeType: "image/png",
          modifiedAtMs: 1234.5,
          sizeBytes: 8,
          sha256: "f".repeat(64),
        },
      }),
    ).toEqual({
      type: "host-rpc.response",
      requestId: "rpc-1",
      commandType: "host.read_file_relative",
      ok: true,
      result: {
        path: "assets/logo.png",
        content: "iVBORw0KGgo=",
        contentEncoding: "base64",
        mimeType: "image/png",
        modifiedAtMs: 1234.5,
        sizeBytes: 8,
        sha256: "f".repeat(64),
      },
    });

    expect(
      hostDaemonDaemonWsMessageSchema.safeParse({
        type: "host-rpc.response",
        requestId: "rpc-1",
        commandType: "provider.list_models",
        ok: true,
        result: { providers: [] },
      }).success,
    ).toBe(false);
  });

  it("round-trips every online RPC response success variant through daemon websocket schemas", () => {
    expect(Object.keys(ONLINE_RPC_RESPONSE_RESULT_FIXTURES).sort()).toEqual(
      [...HOST_DAEMON_ONLINE_RPC_COMMAND_TYPES].sort(),
    );

    for (const commandType of HOST_DAEMON_ONLINE_RPC_COMMAND_TYPES) {
      expectHostRpcResponseRoundTrip(
        commandType,
        ONLINE_RPC_RESPONSE_RESULT_FIXTURES[commandType],
        commandType,
      );
    }

    for (const testCase of ADDITIONAL_ONLINE_RPC_RESPONSE_ROUND_TRIP_CASES) {
      expectHostRpcResponseRoundTrip(
        testCase.commandType,
        testCase.result,
        testCase.name,
      );
    }
  });

  it("round-trips every settled command response success variant through daemon websocket schemas", () => {
    expect(Object.keys(SETTLED_RESPONSE_RESULT_FIXTURES).sort()).toEqual(
      [...HOST_DAEMON_SETTLED_COMMAND_TYPES].sort(),
    );

    for (const commandType of HOST_DAEMON_SETTLED_COMMAND_TYPES) {
      expectHostRpcResponseRoundTrip(
        commandType,
        SETTLED_RESPONSE_RESULT_FIXTURES[commandType],
        commandType,
      );
    }
  });

  it("rejects online RPC response results that do not match commandType", () => {
    for (const testCase of ONLINE_RPC_RESPONSE_MISMATCH_CASES) {
      const message = buildHostRpcResponseMessage(
        testCase.commandType,
        testCase.result,
      );
      const jsonRoundTripped = JSON.parse(JSON.stringify(message));

      expect(
        hostDaemonOnlineRpcResponseMessageSchema.safeParse(jsonRoundTripped)
          .success,
        testCase.name,
      ).toBe(false);
      expect(
        hostDaemonDaemonWsMessageSchema.safeParse(jsonRoundTripped).success,
        testCase.name,
      ).toBe(false);
    }
  });

  it("bounds terminal dimensions in daemon websocket messages", () => {
    expect(
      hostDaemonServerWsMessageSchema.safeParse({
        type: "terminal.open",
        requestId: "request-1",
        terminalId: "term_123",
        threadId: "thr_123",
        target: {
          kind: "workspace",
          environmentId: "env_123",
          workspaceContext: {
            workspacePath: "/tmp/workspace",
            workspaceProvisionType: "unmanaged",
          },
        },
        cols: TERMINAL_COLS_MAX,
        rows: TERMINAL_ROWS_MAX,
        start: { mode: "shell" },
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
        type: "terminal.attach",
        requestId: "request-1",
        terminalId: "term_123",
        sinceSeq: 12,
        tailBytes: 512 * 1024,
      }).success,
    ).toBe(true);
    expect(
      hostDaemonServerWsMessageSchema.safeParse({
        type: "terminal.attach",
        requestId: "request-1",
        terminalId: "term_123",
        sinceSeq: 12,
      }).success,
    ).toBe(false);
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
        replayStartSeq: 0,
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
  });
});

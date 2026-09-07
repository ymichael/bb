import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PromptInput, RuntimePermissionPolicy } from "@bb/domain";
import {
  buildCodexConfig,
  combineWorkspaceWriteRoots,
  gitWritableRootsForWorkspace,
  resolveCodexInstructionOverrides,
  toCodexDynamicTools,
  toCodexPermissionSettings,
  toCodexReasoningEffort,
  toCodexServiceTier,
  toCodexThreadPermissionSettings,
  toCodexUserInput,
} from "./session-params.js";
import type { CodexSessionOptions } from "./session-params.js";

const WORKSPACE_ASK_OPTIONS = {
  permissionMode: "accept-edits",
  permissionScope: "workspace",
  approvalReviewer: "user",
  permissionEscalation: "ask",
} satisfies RuntimePermissionPolicy;

const WORKSPACE_DENY_OPTIONS = {
  permissionMode: "accept-edits",
  permissionScope: "workspace",
  approvalReviewer: "user",
  permissionEscalation: "deny",
} satisfies RuntimePermissionPolicy;

const AUTO_ASK_OPTIONS = {
  permissionMode: "auto",
  permissionScope: "workspace",
  approvalReviewer: "automatic",
  permissionEscalation: "ask",
} satisfies RuntimePermissionPolicy;

const AUTO_DENY_OPTIONS = {
  permissionMode: "auto",
  permissionScope: "workspace",
  approvalReviewer: "automatic",
  permissionEscalation: "deny",
} satisfies RuntimePermissionPolicy;

const FULL_OPTIONS = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
} satisfies RuntimePermissionPolicy;

interface LinkedWorktreeFixture {
  cleanup(): void;
  commonDir: string;
  expectedWritableRoots: string[];
  gitDir: string;
  rootPath: string;
  workspacePath: string;
}

interface OptionalGitRootEscapeCase {
  label: string;
  outsidePrefix: string;
  relativePath: string;
}

interface UnsafeHeadRefCase {
  headContent: string;
  label: string;
}

interface InvalidCommonDirCase {
  label: string;
  setup(fixture: LinkedWorktreeFixture): void;
}

const optionalGitRootEscapeCases: readonly OptionalGitRootEscapeCase[] = [
  {
    label: "refs",
    outsidePrefix: "bb-codex-refs-escape-",
    relativePath: "refs",
  },
  {
    label: "logs refs",
    outsidePrefix: "bb-codex-logs-refs-escape-",
    relativePath: path.join("logs", "refs"),
  },
];

const unsafeHeadRefCases: readonly UnsafeHeadRefCase[] = [
  {
    label: "parent traversal",
    headContent: "ref: refs/heads/../main\n",
  },
  {
    label: "absolute path",
    headContent: "ref: /tmp/bb-main\n",
  },
  {
    label: "empty path segment",
    headContent: "ref: refs/heads//main\n",
  },
];

const invalidCommonDirCases: readonly InvalidCommonDirCase[] = [
  {
    label: "missing commondir",
    setup(fixture) {
      rmSync(path.join(fixture.gitDir, "commondir"), { force: true });
    },
  },
  {
    label: "empty commondir",
    setup(fixture) {
      writeFileSync(path.join(fixture.gitDir, "commondir"), "\n");
    },
  },
];

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
    commonDir,
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

function dedupeRoots(roots: readonly string[]): string[] {
  return [...new Set(roots)];
}

function workspaceConfigForCwd(args: {
  cwd: string;
  additionalWorkspaceWriteRoots?: string[];
}): ReturnType<typeof buildCodexConfig> {
  return buildCodexConfig({
    threadId: "bb-thread-1",
    additionalWorkspaceWriteRoots: args.additionalWorkspaceWriteRoots ?? [],
    gitWritableRoots: gitWritableRootsForWorkspace(args.cwd),
    options: WORKSPACE_ASK_OPTIONS,
  });
}

function expectWorkspaceWriteWritableRootsConfigAbsent(
  config: ReturnType<typeof buildCodexConfig>,
): void {
  expect(config).toEqual(
    expect.not.objectContaining({
      "sandbox_workspace_write.writable_roots": expect.anything(),
    }),
  );
}

describe("gitWritableRootsForWorkspace", () => {
  it("rejects linked worktree git roots that escape canonical containment", () => {
    const fixture = createLinkedWorktreeFixture();
    try {
      writeFileSync(path.join(fixture.workspacePath, ".git"), "gitdir: /\n");

      expect(gitWritableRootsForWorkspace(fixture.workspacePath)).toEqual([]);
      expectWorkspaceWriteWritableRootsConfigAbsent(
        workspaceConfigForCwd({ cwd: fixture.workspacePath }),
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects linked worktree git roots from a foreign workspace", () => {
    const fixture = createLinkedWorktreeFixture();
    const foreignFixture = createLinkedWorktreeFixture();
    try {
      writeFileSync(
        path.join(fixture.workspacePath, ".git"),
        `gitdir: ${foreignFixture.gitDir}\n`,
      );

      expect(gitWritableRootsForWorkspace(fixture.workspacePath)).toEqual([]);
      expectWorkspaceWriteWritableRootsConfigAbsent(
        workspaceConfigForCwd({ cwd: fixture.workspacePath }),
      );
    } finally {
      fixture.cleanup();
      foreignFixture.cleanup();
    }
  });

  it("rejects symlinked workspace .git files", () => {
    const fixture = createLinkedWorktreeFixture();
    const foreignFixture = createLinkedWorktreeFixture();
    try {
      rmSync(path.join(fixture.workspacePath, ".git"), { force: true });
      symlinkSync(
        path.join(foreignFixture.workspacePath, ".git"),
        path.join(fixture.workspacePath, ".git"),
      );

      expect(gitWritableRootsForWorkspace(fixture.workspacePath)).toEqual([]);
      expectWorkspaceWriteWritableRootsConfigAbsent(
        workspaceConfigForCwd({ cwd: fixture.workspacePath }),
      );
    } finally {
      fixture.cleanup();
      foreignFixture.cleanup();
    }
  });

  it("tolerates missing linked worktree ref and reflog dirs", () => {
    const fixture = createLinkedWorktreeFixture();
    const expectedWritableRoots = [
      fixture.gitDir,
      path.join(fixture.commonDir, "objects"),
    ];
    try {
      rmSync(path.join(fixture.commonDir, "refs"), {
        recursive: true,
        force: true,
      });
      rmSync(path.join(fixture.commonDir, "logs"), {
        recursive: true,
        force: true,
      });

      expect(gitWritableRootsForWorkspace(fixture.workspacePath)).toEqual(
        expectedWritableRoots,
      );
      expect(
        workspaceConfigForCwd({ cwd: fixture.workspacePath }),
      ).toMatchObject({
        "sandbox_workspace_write.writable_roots": expectedWritableRoots,
      });
    } finally {
      fixture.cleanup();
    }
  });

  it.each(unsafeHeadRefCases)(
    "skips linked worktree ref/log roots for unsafe HEAD ref: $label",
    (testCase) => {
      const fixture = createLinkedWorktreeFixture();
      const expectedWritableRoots = [
        fixture.gitDir,
        path.join(fixture.commonDir, "objects"),
      ];
      try {
        writeFileSync(path.join(fixture.gitDir, "HEAD"), testCase.headContent);

        expect(gitWritableRootsForWorkspace(fixture.workspacePath)).toEqual(
          expectedWritableRoots,
        );
      } finally {
        fixture.cleanup();
      }
    },
  );

  it("includes branch ref roots for detached HEAD so later branch commits can update refs", () => {
    const fixture = createLinkedWorktreeFixture();
    const expectedWritableRoots = [
      fixture.gitDir,
      path.join(fixture.commonDir, "objects"),
      path.join(fixture.commonDir, "refs", "heads"),
      path.join(fixture.commonDir, "logs", "refs", "heads"),
    ];
    try {
      writeFileSync(
        path.join(fixture.gitDir, "HEAD"),
        "0123456789abcdef0123456789abcdef01234567\n",
      );

      expect(gitWritableRootsForWorkspace(fixture.workspacePath)).toEqual(
        expectedWritableRoots,
      );
      expect(
        workspaceConfigForCwd({ cwd: fixture.workspacePath }),
      ).toMatchObject({
        "sandbox_workspace_write.writable_roots": expectedWritableRoots,
      });
    } finally {
      fixture.cleanup();
    }
  });

  it.each(invalidCommonDirCases)(
    "rejects linked worktree git roots for $label",
    (testCase) => {
      const fixture = createLinkedWorktreeFixture();
      try {
        testCase.setup(fixture);

        expect(gitWritableRootsForWorkspace(fixture.workspacePath)).toEqual([]);
        expectWorkspaceWriteWritableRootsConfigAbsent(
          workspaceConfigForCwd({ cwd: fixture.workspacePath }),
        );
      } finally {
        fixture.cleanup();
      }
    },
  );

  it("rejects linked worktree git roots when objects symlink escapes common dir", () => {
    const fixture = createLinkedWorktreeFixture();
    const outsideObjectsPath = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "bb-codex-objects-escape-")),
    );
    try {
      rmSync(path.join(fixture.commonDir, "objects"), {
        recursive: true,
        force: true,
      });
      symlinkSync(
        outsideObjectsPath,
        path.join(fixture.commonDir, "objects"),
        "dir",
      );

      const config = workspaceConfigForCwd({ cwd: fixture.workspacePath });

      expect(gitWritableRootsForWorkspace(fixture.workspacePath)).toEqual([]);
      expect(JSON.stringify(config)).not.toContain(outsideObjectsPath);
      expectWorkspaceWriteWritableRootsConfigAbsent(config);
    } finally {
      fixture.cleanup();
      rmSync(outsideObjectsPath, { recursive: true, force: true });
    }
  });

  it("rejects linked worktree git roots when worktrees symlink escapes common dir", () => {
    const fixture = createLinkedWorktreeFixture();
    const outsideWorktreesPath = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "bb-codex-worktrees-escape-")),
    );
    try {
      rmSync(path.join(fixture.commonDir, "worktrees"), {
        recursive: true,
        force: true,
      });

      const escapedGitDir = path.join(outsideWorktreesPath, "bb1");
      mkdirSync(escapedGitDir, { recursive: true });
      writeFileSync(
        path.join(escapedGitDir, "gitdir"),
        `${path.join(fixture.workspacePath, ".git")}\n`,
      );
      writeFileSync(
        path.join(escapedGitDir, "commondir"),
        `${fixture.commonDir}\n`,
      );
      writeFileSync(
        path.join(escapedGitDir, "HEAD"),
        "ref: refs/heads/bb/probe\n",
      );
      symlinkSync(
        outsideWorktreesPath,
        path.join(fixture.commonDir, "worktrees"),
        "dir",
      );

      const config = workspaceConfigForCwd({ cwd: fixture.workspacePath });

      expect(gitWritableRootsForWorkspace(fixture.workspacePath)).toEqual([]);
      expect(JSON.stringify(config)).not.toContain(outsideWorktreesPath);
      expectWorkspaceWriteWritableRootsConfigAbsent(config);
    } finally {
      fixture.cleanup();
      rmSync(outsideWorktreesPath, { recursive: true, force: true });
    }
  });

  it.each(optionalGitRootEscapeCases)(
    "rejects linked worktree git roots when $label symlink escapes common dir",
    (escapeCase) => {
      const fixture = createLinkedWorktreeFixture();
      const outsidePath = realpathSync.native(
        mkdtempSync(path.join(tmpdir(), escapeCase.outsidePrefix)),
      );
      try {
        const escapePath = path.join(
          fixture.commonDir,
          escapeCase.relativePath,
        );
        rmSync(escapePath, {
          recursive: true,
          force: true,
        });
        symlinkSync(outsidePath, escapePath, "dir");

        const config = workspaceConfigForCwd({ cwd: fixture.workspacePath });

        expect(gitWritableRootsForWorkspace(fixture.workspacePath)).toEqual([]);
        expect(JSON.stringify(config)).not.toContain(outsidePath);
        expectWorkspaceWriteWritableRootsConfigAbsent(config);
      } finally {
        fixture.cleanup();
        rmSync(outsidePath, { recursive: true, force: true });
      }
    },
  );

  it("carries the captured git writable roots into the workspace-write config", () => {
    const fixture = createLinkedWorktreeFixture();
    try {
      expect(gitWritableRootsForWorkspace(fixture.workspacePath)).toEqual(
        fixture.expectedWritableRoots,
      );
      expect(
        workspaceConfigForCwd({ cwd: fixture.workspacePath }),
      ).toMatchObject({
        "sandbox_workspace_write.writable_roots": fixture.expectedWritableRoots,
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("combines additional workspace roots with the git roots, deduped, additional first", () => {
    const fixture = createLinkedWorktreeFixture();
    const additionalWorkspaceWriteRoots = [
      path.join(fixture.rootPath, "host-extra-root"),
      fixture.gitDir,
    ];
    const expectedWritableRoots = dedupeRoots([
      ...additionalWorkspaceWriteRoots,
      ...fixture.expectedWritableRoots,
    ]);
    try {
      const gitWritableRoots = gitWritableRootsForWorkspace(
        fixture.workspacePath,
      );

      expect(
        combineWorkspaceWriteRoots(
          gitWritableRoots,
          additionalWorkspaceWriteRoots,
        ),
      ).toEqual(expectedWritableRoots);
      expect(
        workspaceConfigForCwd({
          cwd: fixture.workspacePath,
          additionalWorkspaceWriteRoots,
        }),
      ).toMatchObject({
        "sandbox_workspace_write.writable_roots": expectedWritableRoots,
      });
    } finally {
      fixture.cleanup();
    }
  });
});

function permissionSettings(
  options: CodexSessionOptions,
  additionalWorkspaceWriteRoots: readonly string[] = [],
) {
  return toCodexPermissionSettings({
    additionalWorkspaceWriteRoots,
    gitWritableRoots: [],
    options,
  });
}

describe("codex permission settings", () => {
  it("defaults full permission scope to unreviewed danger-full-access", () => {
    expect(toCodexThreadPermissionSettings(FULL_OPTIONS)).toEqual({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
    });
    expect(permissionSettings(FULL_OPTIONS)).toEqual({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
    expect(
      resolveCodexInstructionOverrides({
        instructionMode: "append",
        options: {},
      }),
    ).toEqual({});
  });

  it("maps accept-edits to user-reviewed workspace approvals", () => {
    expect(toCodexThreadPermissionSettings(WORKSPACE_ASK_OPTIONS)).toEqual({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    });
  });

  it("keeps automatic review on-request under deny escalation", () => {
    expect(toCodexThreadPermissionSettings(AUTO_DENY_OPTIONS)).toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    });
    expect(permissionSettings(AUTO_DENY_OPTIONS)).toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    });
  });

  it("maps deny escalation to no approval prompts while staying workspace-write", () => {
    expect(
      toCodexThreadPermissionSettings(WORKSPACE_DENY_OPTIONS),
    ).toMatchObject({
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
  });

  it("maps workspace-write to the full workspaceWrite sandbox policy", () => {
    expect(permissionSettings(WORKSPACE_ASK_OPTIONS)).toEqual({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });
  });

  it("passes additional workspace-write roots through in order", () => {
    expect(
      permissionSettings(WORKSPACE_ASK_OPTIONS, [
        "/repo/.git/worktrees/bb13",
        "/repo/.git/objects",
        "/repo/.git/refs",
        "/repo/.git/logs",
      ]).sandboxPolicy,
    ).toMatchObject({
      type: "workspaceWrite",
      writableRoots: [
        "/repo/.git/worktrees/bb13",
        "/repo/.git/objects",
        "/repo/.git/refs",
        "/repo/.git/logs",
      ],
    });
  });

  it("maps auto to automatic workspace review", () => {
    expect(permissionSettings(AUTO_ASK_OPTIONS)).toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandboxPolicy: {
        type: "workspaceWrite",
        networkAccess: true,
      },
    });
  });
});

function configFor(options: CodexSessionOptions) {
  return buildCodexConfig({
    threadId: "bb-thread-1",
    additionalWorkspaceWriteRoots: [],
    gitWritableRoots: [],
    options,
  });
}

describe("buildCodexConfig", () => {
  it("disables provider user-input requests without overriding web search", () => {
    const config = configFor(FULL_OPTIONS);

    expect(config).toMatchObject({
      "features.default_mode_request_user_input": false,
    });
    expect(JSON.stringify(config)).not.toContain("tools.web_search");
  });

  it("disables Codex memory recall and generation", () => {
    expect(configFor({ ...FULL_OPTIONS, memoryEnabled: false })).toMatchObject({
      "memories.generate_memories": false,
      "memories.use_memories": false,
    });
  });

  it("disables Codex native subagents", () => {
    expect(
      configFor({ ...FULL_OPTIONS, providerSubagentsEnabled: false }),
    ).toMatchObject({
      "features.multi_agent": false,
      "features.multi_agent_v2.max_concurrent_threads_per_session": 1,
    });
  });

  it("injects contributed environment into session params and drops invalid keys", () => {
    const config = configFor({
      ...FULL_OPTIONS,
      envVars: {
        "BAD.KEY": "ignored",
        PLUGIN_API_URL: "http://127.0.0.1:3334/plugins/example/auth",
        TEST_VAR: "123",
      },
    });

    expect(config).toMatchObject({
      "shell_environment_policy.set.BB_THREAD_ID": "bb-thread-1",
      "shell_environment_policy.set.PLUGIN_API_URL":
        "http://127.0.0.1:3334/plugins/example/auth",
      "shell_environment_policy.set.TEST_VAR": "123",
    });
    expect(config).not.toMatchObject({
      "shell_environment_policy.set.BAD.KEY": "ignored",
    });
  });

  it("maps the reasoning level onto model_reasoning_effort", () => {
    expect(
      configFor({ ...FULL_OPTIONS, reasoningLevel: "high" }),
    ).toMatchObject({ model_reasoning_effort: "high" });
    expect(configFor({ ...FULL_OPTIONS, reasoningLevel: "max" })).toMatchObject(
      {
        model_reasoning_effort: "max",
      },
    );
    expect(
      configFor({ ...FULL_OPTIONS, reasoningLevel: "ultra" }),
    ).toMatchObject({ model_reasoning_effort: "ultra" });
  });

  it("omits the writable-roots key for a full-access session", () => {
    expectWorkspaceWriteWritableRootsConfigAbsent(
      buildCodexConfig({
        threadId: "bb-thread-1",
        additionalWorkspaceWriteRoots: ["/repo/.git/objects"],
        gitWritableRoots: [],
        options: FULL_OPTIONS,
      }),
    );
  });
});

describe("resolveCodexInstructionOverrides", () => {
  it("appends instructions as developer instructions", () => {
    const overrides = resolveCodexInstructionOverrides({
      instructionMode: "append",
      options: { instructions: "Focus on the failing tests first." },
    });

    expect(overrides).toEqual({
      developerInstructions: "Focus on the failing tests first.",
    });
    expect(overrides).not.toHaveProperty("baseInstructions");
  });

  it("replaces instructions as base instructions", () => {
    const overrides = resolveCodexInstructionOverrides({
      instructionMode: "replace",
      options: { instructions: "Use this as the complete base prompt." },
    });

    expect(overrides).toEqual({
      baseInstructions: "Use this as the complete base prompt.",
    });
    expect(overrides).not.toHaveProperty("developerInstructions");
  });
});

describe("toCodexReasoningEffort", () => {
  it("maps the top of the bb reasoning ladder", () => {
    expect(toCodexReasoningEffort("max")).toBe("max");
    expect(toCodexReasoningEffort("ultra")).toBe("ultra");
  });

  it("rejects ultracode because Codex does not support it", () => {
    expect(() => toCodexReasoningEffort("ultracode")).toThrow(
      "Codex does not support the ultracode reasoning level.",
    );
  });
});

describe("toCodexServiceTier", () => {
  it("forwards only the fast tier", () => {
    expect(toCodexServiceTier("fast")).toBe("fast");
    expect(toCodexServiceTier("default")).toBeUndefined();
    expect(toCodexServiceTier(undefined)).toBeUndefined();
  });
});

describe("toCodexDynamicTools", () => {
  it("passes dynamic tool specs through with their input schema intact", () => {
    expect(
      toCodexDynamicTools([
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
      ]),
    ).toEqual([
      {
        type: "function",
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
    ]);
    expect(toCodexDynamicTools(undefined)).toBeUndefined();
  });
});

describe("toCodexUserInput", () => {
  it("maps every prompt input variant, rendering local files as text", () => {
    const input: PromptInput[] = [
      { type: "text", text: "hello", mentions: [] },
      { type: "image", url: "https://example.com/a.png" },
      { type: "localImage", path: "/tmp/shot.png" },
      { type: "localFile", path: "/tmp/notes.md" },
    ];

    expect(toCodexUserInput(input)).toEqual([
      { type: "text", text: "hello", text_elements: [] },
      { type: "image", url: "https://example.com/a.png" },
      { type: "localImage", path: "/tmp/shot.png" },
      {
        type: "text",
        text: "[Attached file: /tmp/notes.md]",
        text_elements: [],
      },
    ]);
  });
});

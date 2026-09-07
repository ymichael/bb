import { describe, expect, it, vi } from "vitest";
import type { ThreadPullRequest, WorkspaceStatus } from "@bb/domain";
import {
  setupCommandOutputTestEnvironment,
  collectLogLines,
  getHelpOutput,
  runCommand,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import * as fixtures from "../helpers/command-output-fixtures.js";
import { registerEnvironmentCommands } from "../../commands/environment.js";

describe("bb environment command output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerEnvironmentCommands(program, () => "http://server");

  const workspaceStatus: WorkspaceStatus = {
    workingTree: {
      state: "dirty_uncommitted",
      hasUncommittedChanges: true,
      files: [
        {
          path: "src/environment.ts",
          status: "M",
          insertions: 3,
          deletions: 1,
        },
      ],
      insertions: 3,
      deletions: 1,
      lineStatsComplete: true,
    },
    checkout: {
      kind: "branch",
      branchName: "bb/environment-cli",
      headSha: "abc123",
    },
    branch: {
      currentBranch: "bb/environment-cli",
      defaultBranch: "main",
    },
    mergeBase: {
      mergeBaseBranch: "main",
      baseRef: "def456",
      aheadCount: 2,
      behindCount: 0,
      hasCommittedUnmergedChanges: true,
      commits: [],
      files: [],
      insertions: 0,
      deletions: 0,
      lineStatsComplete: true,
    },
  };

  const pullRequest: ThreadPullRequest = {
    number: 701,
    title: "Environment inspection parity",
    state: "open",
    url: "https://github.com/example/bb/pull/701",
    baseRefName: "main",
    headRefName: "bb/environment-cli",
    updatedAt: "2026-07-14T12:00:00.000Z",
    checks: {
      state: "passing",
      totalCount: 2,
      passedCount: 2,
      failedCount: 0,
      pendingCount: 0,
    },
    review: {
      state: "review_required",
      reviewRequestCount: 1,
    },
    mergeability: {
      state: "mergeable",
      mergeStateStatus: "CLEAN",
      mergeable: "MERGEABLE",
    },
    attention: "ready_to_merge",
  };

  it("discovers every direct environment inspection command in help", async () => {
    const help = await getHelpOutput(["environment"], register);

    expect(help).toContain("status [options] <id>");
    expect(help).toContain("branches [options] <id>");
    expect(help).toContain("paths [options] <id>");
    expect(help).toContain("diff [options] <id>");
    expect(help).toContain("diff-files [options] <id>");
    expect(help).toContain("diff-file [options] <id>");
    expect(help).toContain("diff-patch [options] <id>");
    expect(help).toContain("pull-request");
    expect(help).not.toContain("squash-merge");
  });

  it("bb environment status inspects an arbitrary environment id", async () => {
    const get = vi.fn(async () => ({
      outcome: "available",
      workspace: workspaceStatus,
    }));
    stubServerApi({ "v1.environments.:id.status.$get": get });

    await runCommand(
      [
        "environment",
        "status",
        "env-status-only",
        "--merge-base-branch",
        "main",
      ],
      register,
    );

    expect(get).toHaveBeenCalledWith({
      param: { id: "env-status-only" },
      query: { mergeBaseBranch: "main" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toEqual(
      expect.arrayContaining([
        "State: dirty_uncommitted",
        "Branch: bb/environment-cli",
        "Changed files: 1",
        "Merge base: main",
        "Ahead: 2",
      ]),
    );
  });

  it("bb environment status --json preserves the canonical response", async () => {
    const response = {
      outcome: "available",
      workspace: workspaceStatus,
    };
    stubServerApi({
      "v1.environments.:id.status.$get": vi.fn(async () => response),
    });

    await runCommand(
      ["environment", "status", "env-status-json", "--json"],
      register,
    );

    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual(response);
  });

  it("does not print incomplete line totals for untracked files", async () => {
    stubServerApi({
      "v1.environments.:id.status.$get": vi.fn(async () => ({
        outcome: "available",
        workspace: {
          ...workspaceStatus,
          workingTree: {
            ...workspaceStatus.workingTree,
            lineStatsComplete: false,
          },
        },
      })),
    });

    await runCommand(["environment", "status", "env-untracked"], register);

    const lines = collectLogLines(vi.mocked(console.log));
    expect(lines).toContain("Line stats: unavailable for untracked files");
    expect(lines.some((line) => line.startsWith("Insertions:"))).toBe(false);
    expect(lines.some((line) => line.startsWith("Deletions:"))).toBe(false);
  });

  it("bb environment status explains non-git environments", async () => {
    stubServerApi({
      "v1.environments.:id.status.$get": vi.fn(async () => ({
        outcome: "not_applicable",
        reason: "non_git_environment",
        message: "Workspace status is not available for non-git environments",
      })),
    });

    await runCommand(["environment", "status", "env-non-git"], register);

    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Status unavailable: Workspace status is not available for non-git environments",
    );
  });

  it("bb environment pull-request show reports absence and presence", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "absent" })
      .mockResolvedValueOnce({ outcome: "available", pullRequest });
    stubServerApi({ "v1.environments.:id.pull-request.$get": get });

    await runCommand(
      ["environment", "pull-request", "show", "env-pr-none"],
      register,
    );
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "No pull request found",
    );

    vi.mocked(console.log).mockClear();
    await runCommand(
      ["environment", "pull-request", "show", "env-pr-present"],
      register,
    );

    expect(get).toHaveBeenNthCalledWith(1, {
      param: { id: "env-pr-none" },
    });
    expect(get).toHaveBeenNthCalledWith(2, {
      param: { id: "env-pr-present" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toEqual(
      expect.arrayContaining([
        "Pull request: #701 open - Environment inspection parity",
        "Branch: bb/environment-cli -> main",
        "Checks: passing (2 passed, 0 failed, 0 pending, 2 total)",
      ]),
    );
  });

  it("bb environment pull-request show --json preserves the outcome", async () => {
    stubServerApi({
      "v1.environments.:id.pull-request.$get": vi.fn(async () => ({
        outcome: "absent",
      })),
    });

    await runCommand(
      ["environment", "pull-request", "show", "env-pr-json", "--json"],
      register,
    );

    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual({ outcome: "absent" });
  });

  it("bb environment pull-request show reports a failed lookup", async () => {
    stubServerApi({
      "v1.environments.:id.pull-request.$get": vi.fn(async () => ({
        outcome: "unavailable",
        message: "gh pr view failed: authentication required",
      })),
    });

    await runCommand(
      ["environment", "pull-request", "show", "env-pr-down"],
      register,
    );

    expect(vi.mocked(console.log).mock.calls.map((call) => call[0])).toEqual([
      "Pull request lookup unavailable: gh pr view failed: authentication required",
    ]);
  });

  it("bb environment branches returns local and remote results", async () => {
    const get = vi.fn(async () => ({
      branches: ["main", "release"],
      branchesTruncated: false,
      remoteBranches: ["origin/main"],
      remoteBranchesTruncated: true,
      selectedBranch: null,
    }));
    stubServerApi({ "v1.environments.:id.diff.branches.$get": get });

    await runCommand(
      [
        "environment",
        "branches",
        "env-branches-direct",
        "--query",
        "main",
        "--limit",
        "20",
      ],
      register,
    );

    expect(get).toHaveBeenCalledWith({
      param: { id: "env-branches-direct" },
      query: { query: "main", limit: "20" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      "Local branches:",
      "  main",
      "  release",
      "Remote branches:",
      "  origin/main",
      "  (truncated)",
    ]);
  });

  it("bb environment paths targets the environment and path kinds", async () => {
    const response = {
      paths: [
        {
          kind: "directory",
          path: "apps/cli",
          name: "cli",
          score: 1,
          positions: [5],
        },
      ],
      truncated: true,
    };
    const get = vi.fn(async () => response);
    stubServerApi({ "v1.environments.:id.paths.$get": get });

    await runCommand(
      [
        "environment",
        "paths",
        "env-paths-direct",
        "--query",
        "cli",
        "--directories",
        "--limit",
        "5",
      ],
      register,
    );

    expect(get).toHaveBeenCalledWith({
      param: { id: "env-paths-direct" },
      query: {
        query: "cli",
        limit: "5",
        includeFiles: "false",
        includeDirectories: "true",
      },
    });
    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      "directory\tapps/cli",
      "(results truncated)",
    ]);
  });

  it("bb environment diff prints summary, full diff, and truncation", async () => {
    const get = vi.fn(async () => ({
      outcome: "available",
      diff: {
        files: "M\tapps/cli/src/commands/environment.ts\n",
        shortstat: "1 file changed, 3 insertions(+)",
        diff: "diff --git a/environment.ts b/environment.ts",
        truncated: true,
        mergeBaseRef: "abc123",
      },
    }));
    stubServerApi({ "v1.environments.:id.diff.$get": get });

    await runCommand(
      [
        "environment",
        "diff",
        "env-diff-direct",
        "--target",
        "all",
        "--merge-base-branch",
        "main",
      ],
      register,
    );

    expect(get).toHaveBeenCalledWith({
      param: { id: "env-diff-direct" },
      query: { target: "all", mergeBaseBranch: "main" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      "M\tapps/cli/src/commands/environment.ts",
      "1 file changed, 3 insertions(+)",
      "diff --git a/environment.ts b/environment.ts",
      "(diff truncated)",
    ]);
  });

  it("bb environment diff-files --json preserves binary and initial patch metadata", async () => {
    const response = {
      outcome: "available",
      files: [
        {
          path: "assets/logo.png",
          previousPath: null,
          changeKind: "modified",
          additions: 0,
          deletions: 0,
          binary: true,
          origin: "tracked",
          loadMode: "on_demand",
        },
      ],
      shortstat: "1 file changed",
      mergeBaseRef: null,
      truncated: false,
      initialPatches: [
        {
          path: "assets/logo.png",
          patch: "Binary files differ",
          truncated: true,
        },
      ],
    };
    const get = vi.fn(async () => response);
    stubServerApi({ "v1.environments.:id.diff.files.$get": get });

    await runCommand(
      [
        "environment",
        "diff-files",
        "env-diff-files-direct",
        "--target",
        "uncommitted",
        "--json",
      ],
      register,
    );

    expect(get).toHaveBeenCalledWith({
      param: { id: "env-diff-files-direct" },
      query: { target: "uncommitted" },
    });
    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual(response);
  });

  it("bb environment diff-files reports a truncated file list", async () => {
    stubServerApi({
      "v1.environments.:id.diff.files.$get": vi.fn(async () => ({
        outcome: "available",
        files: [
          {
            path: "one.txt",
            previousPath: null,
            changeKind: "added",
            additions: 1,
            deletions: 0,
            binary: false,
            origin: "untracked",
            loadMode: "auto",
          },
        ],
        shortstat: "1 file changed, 1 insertion(+)",
        mergeBaseRef: null,
        initialPatches: [],
        truncated: true,
      })),
    });

    await runCommand(
      [
        "environment",
        "diff-files",
        "env-diff-files-truncated",
        "--target",
        "uncommitted",
      ],
      register,
    );

    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      "added\t+1 -0\tuntracked\tauto\tone.txt",
      "1 file changed, 1 insertion(+)",
      "(additional changed files omitted)",
    ]);
  });

  it("bb environment diff-file distinguishes text and binary content", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        path: "README.md",
        content: "hello\n",
        contentEncoding: "utf8",
        mimeType: "text/markdown",
        sizeBytes: 6,
      })
      .mockResolvedValueOnce({
        path: "assets/logo.png",
        content: "iVBORw0KGgo=",
        contentEncoding: "base64",
        mimeType: "image/png",
        sizeBytes: 8,
      });
    stubServerApi({ "v1.environments.:id.diff.file.$get": get });

    await runCommand(
      [
        "environment",
        "diff-file",
        "env-text-file",
        "--target",
        "uncommitted",
        "--path",
        "README.md",
        "--side",
        "new",
      ],
      register,
    );
    expect(collectLogLines(vi.mocked(console.log))).toEqual(["hello\n"]);

    vi.mocked(console.log).mockClear();
    await runCommand(
      [
        "environment",
        "diff-file",
        "env-binary-file",
        "--target",
        "commit",
        "--sha",
        "abc123",
        "--path",
        "assets/logo.png",
        "--side",
        "old",
      ],
      register,
    );

    expect(get).toHaveBeenNthCalledWith(1, {
      param: { id: "env-text-file" },
      query: { target: "uncommitted", path: "README.md", side: "new" },
    });
    expect(get).toHaveBeenNthCalledWith(2, {
      param: { id: "env-binary-file" },
      query: {
        target: "commit",
        sha: "abc123",
        path: "assets/logo.png",
        side: "old",
      },
    });
    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      "Binary file: assets/logo.png",
      "Encoding: base64",
      "Size: 8 bytes",
      "MIME type: image/png",
      "iVBORw0KGgo=",
    ]);
  });

  it("bb environment diff-patch preserves patch paths and truncation", async () => {
    const post = vi.fn(async () => ({
      outcome: "available",
      patches: [
        {
          path: "src/a.ts",
          patch: "@@ -1 +1 @@\n-old\n+new",
          truncated: false,
        },
        {
          path: "src/b.ts",
          patch: "@@ -1 +1 @@",
          truncated: true,
        },
      ],
    }));
    stubServerApi({ "v1.environments.:id.diff.patch.$post": post });

    await runCommand(
      [
        "environment",
        "diff-patch",
        "env-patch-direct",
        "--target",
        "branch_committed",
        "--merge-base-branch",
        "main",
        "--path",
        "src/a.ts",
        "--path",
        "src/b.ts",
      ],
      register,
    );

    expect(post).toHaveBeenCalledWith({
      param: { id: "env-patch-direct" },
      json: {
        target: { type: "branch_committed", mergeBaseBranch: "main" },
        paths: ["src/a.ts", "src/b.ts"],
      },
    });
    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      "File: src/a.ts",
      "@@ -1 +1 @@\n-old\n+new",
      "File: src/b.ts",
      "@@ -1 +1 @@",
      "(patch truncated)",
    ]);
  });

  it("bb environment diff explains non-git results", async () => {
    stubServerApi({
      "v1.environments.:id.diff.$get": vi.fn(async () => ({
        outcome: "not_applicable",
        reason: "non_git_environment",
        message: "Workspace diff is not available for non-git environments",
      })),
    });

    await runCommand(
      ["environment", "diff", "env-diff-non-git", "--target", "uncommitted"],
      register,
    );

    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Diff unavailable: Workspace diff is not available for non-git environments",
    );
  });

  it("rejects incompatible diff flags before calling the server", async () => {
    const get = vi.fn();
    stubServerApi({ "v1.environments.:id.diff.$get": get });

    await expect(
      runCommand(
        [
          "environment",
          "diff",
          "env-invalid-target",
          "--target",
          "commit",
          "--merge-base-branch",
          "main",
        ],
        register,
      ),
    ).rejects.toThrow("process.exit:1");

    expect(get).not.toHaveBeenCalled();
    expect(collectLogLines(vi.mocked(console.error))).toContain(
      "Error: --sha is required when --target commit is used.",
    );
  });

  it("preserves nonzero behavior for environment inspection errors", async () => {
    stubServerApi({
      "v1.environments.:id.diff.file.$get": vi.fn(async () => {
        throw new Error("workspace is unavailable");
      }),
    });

    await expect(
      runCommand(
        [
          "environment",
          "diff-file",
          "env-read-error",
          "--target",
          "uncommitted",
          "--path",
          "README.md",
          "--side",
          "new",
        ],
        register,
      ),
    ).rejects.toThrow("process.exit:1");

    expect(collectLogLines(vi.mocked(console.error))).toContain(
      "Error: workspace is unavailable",
    );
  });

  it("bb environment commit prefixes failures with environment context", async () => {
    const post = vi.fn(async () => {
      throw new Error("HTTP 500: boom");
    });
    stubServerApi({ "v1.environments.:id.actions.$post": post });

    await expect(
      runCommand(["environment", "commit", "env-1"], register),
    ).rejects.toThrow("process.exit:1");

    expect(collectLogLines(vi.mocked(console.error))).toContain(
      "Error: Failed to commit in environment env-1: HTTP 500: boom",
    );
  });

  it("bb environment commit posts the action without a thread id", async () => {
    const post = vi.fn(async () => ({
      ok: true,
      action: "commit",
      message: "Created commit abc123",
      commitSha: "abc123",
      commitSubject: "bb: automated commit",
    }));
    stubServerApi({ "v1.environments.:id.actions.$post": post });

    await runCommand(["environment", "commit", "env-commit-1"], register);

    expect(post).toHaveBeenCalledWith({
      param: { id: "env-commit-1" },
      json: { action: "commit" },
    });
  });

  it("bb environment update sets the merge base branch", async () => {
    const environment = fixtures.makeEnvironment({
      id: "env-update-1",
      projectId: "proj-1",
      hostId: "host-1",
      mergeBaseBranch: "release",
      createdAt: 1,
      updatedAt: 2,
    });
    const patch = vi.fn(async () => environment);
    stubServerApi({ "v1.environments.:id.$patch": patch });

    await runCommand(
      [
        "environment",
        "update",
        "env-update-1",
        "--merge-base-branch",
        "release",
      ],
      register,
    );

    expect(patch).toHaveBeenCalledWith({
      param: { id: "env-update-1" },
      json: { mergeBaseBranch: "release" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Environment env-update-1 updated",
    );
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Merge base branch: release",
    );
  });

  it("bb environment update clears the merge base branch", async () => {
    const environment = fixtures.makeEnvironment({
      id: "env-update-2",
      projectId: "proj-1",
      hostId: "host-1",
      mergeBaseBranch: null,
      createdAt: 1,
      updatedAt: 2,
    });
    const patch = vi.fn(async () => environment);
    stubServerApi({ "v1.environments.:id.$patch": patch });

    await runCommand(
      ["environment", "update", "env-update-2", "--clear-merge-base-branch"],
      register,
    );

    expect(patch).toHaveBeenCalledWith({
      param: { id: "env-update-2" },
      json: { mergeBaseBranch: null },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Merge base branch cleared",
    );
  });

  it("bb environment update renames the environment", async () => {
    const environment = fixtures.makeEnvironment({
      id: "env-update-name",
      projectId: "proj-1",
      hostId: "host-1",
      name: "Review workspace",
      createdAt: 1,
      updatedAt: 2,
    });
    const patch = vi.fn(async () => environment);
    stubServerApi({ "v1.environments.:id.$patch": patch });

    await runCommand(
      [
        "environment",
        "update",
        "env-update-name",
        "--name",
        "Review workspace",
      ],
      register,
    );

    expect(patch).toHaveBeenCalledWith({
      param: { id: "env-update-name" },
      json: { name: "Review workspace" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Environment env-update-name updated",
    );
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Name: Review workspace",
    );
  });

  it("bb environment update clears the environment name", async () => {
    const environment = fixtures.makeEnvironment({
      id: "env-clear-name",
      projectId: "proj-1",
      hostId: "host-1",
      name: null,
      createdAt: 1,
      updatedAt: 2,
    });
    const patch = vi.fn(async () => environment);
    stubServerApi({ "v1.environments.:id.$patch": patch });

    await runCommand(
      ["environment", "update", "env-clear-name", "--clear-name"],
      register,
    );

    expect(patch).toHaveBeenCalledWith({
      param: { id: "env-clear-name" },
      json: { name: null },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain("Name cleared");
  });

  it("bb environment update sets name and merge base together", async () => {
    const environment = fixtures.makeEnvironment({
      id: "env-update-combined",
      projectId: "proj-1",
      hostId: "host-1",
      name: "Review workspace",
      mergeBaseBranch: "release",
      createdAt: 1,
      updatedAt: 2,
    });
    const patch = vi.fn(async () => environment);
    stubServerApi({ "v1.environments.:id.$patch": patch });

    await runCommand(
      [
        "environment",
        "update",
        "env-update-combined",
        "--name",
        "Review workspace",
        "--merge-base-branch",
        "release",
      ],
      register,
    );

    expect(patch).toHaveBeenCalledWith({
      param: { id: "env-update-combined" },
      json: { mergeBaseBranch: "release", name: "Review workspace" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Merge base branch: release",
    );
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Name: Review workspace",
    );
  });

  it("bb environment update rejects name and clear-name together", async () => {
    const patch = vi.fn();
    stubServerApi({ "v1.environments.:id.$patch": patch });

    await expect(
      runCommand(
        [
          "environment",
          "update",
          "env-update-name-conflict",
          "--name",
          "Review workspace",
          "--clear-name",
        ],
        register,
      ),
    ).rejects.toThrow("process.exit:1");

    expect(vi.mocked(console.error)).toHaveBeenCalledWith(
      expect.stringContaining("Cannot combine --name with --clear-name."),
    );
    expect(patch).not.toHaveBeenCalled();
  });

  it("bb environment update rejects an empty name", async () => {
    const patch = vi.fn();
    stubServerApi({ "v1.environments.:id.$patch": patch });

    await expect(
      runCommand(
        ["environment", "update", "env-update-empty-name", "--name", ""],
        register,
      ),
    ).rejects.toThrow("process.exit:1");

    expect(vi.mocked(console.error)).toHaveBeenCalledWith(
      expect.stringContaining("Environment name cannot be empty."),
    );
    expect(patch).not.toHaveBeenCalled();
  });

  it("bb environment update --json prints the updated environment", async () => {
    const environment = fixtures.makeEnvironment({
      id: "env-json-update",
      projectId: "proj-1",
      hostId: "host-1",
      mergeBaseBranch: "release",
      createdAt: 1,
      updatedAt: 2,
    });
    const patch = vi.fn(async () => environment);
    stubServerApi({ "v1.environments.:id.$patch": patch });

    await runCommand(
      [
        "environment",
        "update",
        "env-json-update",
        "--merge-base-branch",
        "release",
        "--json",
      ],
      register,
    );

    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual(environment);
  });
});

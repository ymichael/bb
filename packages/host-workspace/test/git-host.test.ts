import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPullRequestForCurrentBranch,
  parseGitHostPullRequest,
  runPullRequestActionForCurrentBranch,
  type GitHostPullRequestAction,
} from "../src/git-host.js";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  const { promisify } = await import("node:util");
  Object.defineProperty(execFileMock, promisify.custom, {
    value: (file: string, args: readonly string[], options: object) =>
      new Promise((resolve, reject) => {
        execFileMock(
          file,
          args,
          options,
          (error: Error | null, stdout = "", stderr = "") => {
            if (error) reject(error);
            else resolve({ stdout, stderr });
          },
        );
      }),
  });
  return {
    ...actual,
    execFile: execFileMock,
  };
});

beforeEach(() => {
  execFileMock.mockReset();
});

function ghJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 42,
    title: "Add pull request section",
    state: "OPEN",
    url: "https://github.com/acme/bb/pull/42",
    isDraft: false,
    baseRefName: "main",
    headRefName: "bb/add-pr-section",
    updatedAt: "2026-06-16T12:30:00Z",
    statusCheckRollup: [],
    reviewDecision: null,
    reviewRequests: [],
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
    ...overrides,
  });
}

describe("parseGitHostPullRequest", () => {
  it("parses a well-formed open PR", () => {
    expect(parseGitHostPullRequest(ghJson())).toEqual({
      number: 42,
      title: "Add pull request section",
      state: "OPEN",
      url: "https://github.com/acme/bb/pull/42",
      isDraft: false,
      baseRefName: "main",
      headRefName: "bb/add-pr-section",
      updatedAt: "2026-06-16T12:30:00Z",
      checks: [],
      reviewDecision: null,
      reviewRequestCount: 0,
      mergeStateStatus: "CLEAN",
      mergeable: "MERGEABLE",
    });
  });

  it("preserves the draft flag and merged/closed states", () => {
    expect(parseGitHostPullRequest(ghJson({ isDraft: true }))?.isDraft).toBe(
      true,
    );
    expect(parseGitHostPullRequest(ghJson({ state: "MERGED" }))?.state).toBe(
      "MERGED",
    );
    expect(parseGitHostPullRequest(ghJson({ state: "CLOSED" }))?.state).toBe(
      "CLOSED",
    );
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseGitHostPullRequest(`\n  ${ghJson()}\n`)?.number).toBe(42);
  });

  it("normalizes checks, review requests, and mergeability", () => {
    expect(
      parseGitHostPullRequest(
        ghJson({
          statusCheckRollup: [
            {
              __typename: "CheckRun",
              name: "typecheck",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              detailsUrl: "https://github.com/acme/bb/actions/runs/1",
              startedAt: "2026-06-16T12:20:00Z",
            },
            {
              __typename: "StatusContext",
              context: "ci/build",
              state: "FAILURE",
              targetUrl: "https://ci.example.test/build/42",
              createdAt: "2026-06-16T12:21:00Z",
            },
            {
              __typename: "CheckRun",
              workflowName: "lint",
              status: "IN_PROGRESS",
              conclusion: null,
              startedAt: "2026-06-16T12:22:00Z",
            },
          ],
          reviewDecision: "REVIEW_REQUIRED",
          reviewRequests: [
            { requestedReviewer: { login: "octocat" } },
            { requestedReviewer: { login: "hubot" } },
          ],
          mergeStateStatus: "DIRTY",
          mergeable: "CONFLICTING",
        }),
      ),
    ).toMatchObject({
      checks: [
        {
          name: "typecheck",
          status: "completed",
          conclusion: "success",
          url: "https://github.com/acme/bb/actions/runs/1",
          startedAt: "2026-06-16T12:20:00Z",
        },
        {
          name: "ci/build",
          status: "completed",
          conclusion: "failure",
          url: "https://ci.example.test/build/42",
          startedAt: "2026-06-16T12:21:00Z",
        },
        {
          name: "lint",
          status: "in_progress",
          conclusion: null,
          url: null,
          startedAt: "2026-06-16T12:22:00Z",
        },
      ],
      reviewDecision: "REVIEW_REQUIRED",
      reviewRequestCount: 2,
      mergeStateStatus: "DIRTY",
      mergeable: "CONFLICTING",
    });
  });

  it.each([
    ["empty output", ""],
    ["whitespace only", "   \n"],
    ["non-JSON", "no pull requests found for branch"],
    ["a JSON array", "[]"],
  ])("returns null for %s", (_label, stdout) => {
    expect(parseGitHostPullRequest(stdout)).toBeNull();
  });

  it.each([
    ["an unknown state", ghJson({ state: "QUEUED" })],
    [
      "a missing field",
      JSON.stringify({ number: 1, title: "x", state: "OPEN" }),
    ],
    ["a non-positive number", ghJson({ number: 0 })],
    ["an invalid updatedAt", ghJson({ updatedAt: "yesterday" })],
    ["a non-url", ghJson({ url: "not-a-url" })],
  ])("returns null for %s", (_label, stdout) => {
    expect(parseGitHostPullRequest(stdout)).toBeNull();
  });
});

describe("runPullRequestActionForCurrentBranch", () => {
  const actionArgs = {
    cwd: "/tmp/workspace",
    localBranch: "bb/pr-action",
    shellPath: "/Users/test/.local/bin:/usr/bin",
  };

  function mockGhSuccess(): void {
    execFileMock.mockImplementation(
      (
        file: string,
        _args: readonly string[],
        _options: object,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (file === "git") {
          callback(null, "", "");
          return;
        }
        callback(null, "", "");
      },
    );
  }

  it.each([
    ["ready", { operation: "ready" }, ["pr", "ready"]],
    ["draft", { operation: "draft" }, ["pr", "ready", "--undo"]],
    [
      "merge",
      { operation: "merge", method: "merge" },
      ["pr", "merge", "--merge"],
    ],
    [
      "squash",
      { operation: "merge", method: "squash" },
      ["pr", "merge", "--squash"],
    ],
    [
      "rebase",
      { operation: "merge", method: "rebase" },
      ["pr", "merge", "--rebase"],
    ],
  ] satisfies readonly [string, GitHostPullRequestAction, readonly string[]][])(
    "runs gh pr %s without a target so gh can honor a fork upstream",
    async (_label, action, expectedArgs) => {
      mockGhSuccess();

      await runPullRequestActionForCurrentBranch({
        ...actionArgs,
        action,
      });

      expect(execFileMock).toHaveBeenCalledWith(
        "gh",
        expectedArgs,
        expect.objectContaining({
          cwd: "/tmp/workspace",
          encoding: "utf8",
          env: expect.objectContaining({
            PATH: "/Users/test/.local/bin:/usr/bin",
          }),
          maxBuffer: 16 * 1024 * 1024,
          timeout: 60_000,
        }),
        expect.any(Function),
      );
    },
  );

  it("maps a missing gh executable to a workspace error", async () => {
    const error = Object.assign(new Error("spawn gh ENOENT"), {
      code: "ENOENT",
    });
    execFileMock.mockImplementation(
      (
        file: string,
        _args: readonly string[],
        _options: object,
        callback: (
          error: Error | null,
          stdout?: string,
          stderr?: string,
        ) => void,
      ) => {
        if (file === "git") {
          callback(null, "", "");
          return;
        }
        callback(error);
      },
    );

    await expect(
      runPullRequestActionForCurrentBranch({
        ...actionArgs,
        action: { operation: "ready" },
      }),
    ).rejects.toMatchObject({
      code: "git_host_cli_unavailable",
      name: "WorkspaceError",
    });
  });
});

describe("getPullRequestForCurrentBranch", () => {
  const lookupArgs = {
    cwd: "/tmp/workspace",
    localBranch: "bb/pr-lookup",
    shellPath: "/Users/test/.local/bin:/usr/bin",
  };

  function mockGhStdout(stdout: string): void {
    execFileMock.mockImplementation(
      (
        file: string,
        _args: readonly string[],
        _options: object,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (file === "git") {
          callback(null, "", "");
          return;
        }
        callback(null, stdout, "");
      },
    );
  }

  function mockGhFailure(error: Error): void {
    execFileMock.mockImplementation(
      (
        file: string,
        _args: readonly string[],
        _options: object,
        callback: (
          error: Error | null,
          stdout?: string,
          stderr?: string,
        ) => void,
      ) => {
        if (file === "git") {
          callback(null, "", "");
          return;
        }
        callback(error);
      },
    );
  }

  it("uses bare gh lookup when the branch has no differently named upstream", async () => {
    mockGhStdout(ghJson());
    await expect(
      getPullRequestForCurrentBranch(lookupArgs),
    ).resolves.toMatchObject({
      outcome: "found",
      pullRequest: { number: 42, state: "OPEN" },
    });
    expect(execFileMock).toHaveBeenCalledWith(
      "gh",
      ["pr", "view", "--json", expect.any(String)],
      expect.objectContaining({
        cwd: "/tmp/workspace",
        env: expect.objectContaining({
          PATH: "/Users/test/.local/bin:/usr/bin",
        }),
      }),
      expect.any(Function),
    );
  });

  it("returns none when gh reports the branch has no PR", async () => {
    mockGhFailure(
      Object.assign(new Error("gh exited 1"), {
        code: 1,
        stderr: 'no pull requests found for branch "bb/pr-lookup"',
      }),
    );
    await expect(getPullRequestForCurrentBranch(lookupArgs)).resolves.toEqual({
      outcome: "none",
    });
  });

  it("returns unavailable when gh is not installed", async () => {
    mockGhFailure(
      Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }),
    );
    await expect(getPullRequestForCurrentBranch(lookupArgs)).resolves.toEqual({
      outcome: "unavailable",
      message: "GitHub CLI is not available",
    });
  });

  it("returns unavailable with the stderr detail for an auth failure", async () => {
    mockGhFailure(
      Object.assign(new Error("gh exited 4"), {
        code: 4,
        stderr: "gh: To get started with GitHub CLI, please run: gh auth login",
      }),
    );
    const result = await getPullRequestForCurrentBranch(lookupArgs);
    expect(result.outcome).toBe("unavailable");
    expect(result).toMatchObject({
      message: expect.stringContaining("gh auth login"),
    });
  });

  it("returns unavailable when gh times out", async () => {
    mockGhFailure(
      Object.assign(new Error("timed out"), { killed: true, code: null }),
    );
    await expect(
      getPullRequestForCurrentBranch(lookupArgs),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      message: expect.stringContaining("timed out"),
    });
  });

  it("returns unavailable for unparseable gh output", async () => {
    mockGhStdout("not json at all");
    await expect(getPullRequestForCurrentBranch(lookupArgs)).resolves.toEqual({
      outcome: "unavailable",
      message: "gh pr view returned unparseable output",
    });
  });
});

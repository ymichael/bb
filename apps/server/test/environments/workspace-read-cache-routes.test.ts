import { describe, expect, it } from "vitest";
import type { GitHostPullRequest, WorkspaceWorkingTree } from "@bb/domain";
import type { HostDaemonOnlineRpcResult } from "@bb/host-daemon-contract";
import {
  listQueuedCommands,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
  waitForQueuedCommandAfter,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function workspaceStatus(
  currentBranch: string,
  state: WorkspaceWorkingTree["state"] = "clean",
): HostDaemonOnlineRpcResult<"workspace.status"> {
  const hasUncommittedChanges =
    state === "untracked" ||
    state === "dirty_uncommitted" ||
    state === "dirty_and_committed_unmerged";
  return {
    outcome: "available",
    workspaceStatus: {
      workingTree: {
        insertions: 0,
        deletions: 0,
        lineStatsComplete: true,
        files: [],
        hasUncommittedChanges,
        state,
      },
      branch: { currentBranch, defaultBranch: "main" },
      checkout: { kind: "branch", branchName: currentBranch, headSha: null },
      mergeBase: null,
    },
  };
}

function rawPullRequest(
  overrides: Partial<GitHostPullRequest> = {},
): GitHostPullRequest {
  return {
    number: 42,
    title: "Cache the PR probe",
    state: "OPEN",
    url: "https://github.com/acme/bb/pull/42",
    isDraft: false,
    baseRefName: "main",
    headRefName: "bb/pr-cache",
    updatedAt: "2026-06-16T12:30:00Z",
    checks: [],
    reviewDecision: null,
    reviewRequestCount: 0,
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
    ...overrides,
  };
}

function seedGitEnvironment(harness: TestAppHarness, suffix: string) {
  const { host } = seedHostSession(harness.deps, {
    id: `host-workspace-read-cache-${suffix}`,
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    branchName: "bb/pr-cache",
    defaultBranch: "main",
    path: `/tmp/workspace-read-cache-${suffix}`,
    workspaceProvisionType: "managed-worktree",
  });
  return { host, environment };
}

describe("workspace read caches on the environment routes", () => {
  it("serves overlapping and repeated status reads from one daemon probe until work-status-changed", async () => {
    await withTestHarness(async (harness) => {
      const { environment } = seedGitEnvironment(harness, "status");
      const url = `/api/v1/environments/${environment.id}/status`;

      const first = harness.app.request(url);
      const second = harness.app.request(url);
      const statusCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.status" &&
          command.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(
        harness,
        statusCommand,
        workspaceStatus("feature/one"),
      );
      for (const response of await Promise.all([first, second])) {
        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toMatchObject({
          outcome: "available",
          workspace: { branch: { currentBranch: "feature/one" } },
        });
      }

      const third = await harness.app.request(url);
      expect(third.status).toBe(200);
      await expect(readJson(third)).resolves.toMatchObject({
        workspace: { branch: { currentBranch: "feature/one" } },
      });
      expect(listQueuedCommands(harness, "workspace.status")).toHaveLength(0);

      const withMergeBase = harness.app.request(
        `${url}?mergeBaseBranch=release`,
      );
      const mergeBaseCommand = await waitForQueuedCommandAfter(
        harness,
        statusCommand.row.cursor,
        ({ command }) =>
          command.type === "workspace.status" &&
          command.environmentId === environment.id,
      );
      expect(mergeBaseCommand.command).toMatchObject({
        mergeBaseBranch: "release",
      });
      await reportQueuedCommandSuccess(
        harness,
        mergeBaseCommand,
        workspaceStatus("feature/one"),
      );
      expect((await withMergeBase).status).toBe(200);

      harness.hub.notifyEnvironment(environment.id, ["work-status-changed"]);
      const fourth = harness.app.request(url);
      const refreshedCommand = await waitForQueuedCommandAfter(
        harness,
        mergeBaseCommand.row.cursor,
        ({ command }) =>
          command.type === "workspace.status" &&
          command.environmentId === environment.id &&
          command.mergeBaseBranch === undefined,
      );
      await reportQueuedCommandSuccess(
        harness,
        refreshedCommand,
        workspaceStatus("feature/two"),
      );
      const fourthResponse = await fourth;
      expect(fourthResponse.status).toBe(200);
      await expect(readJson(fourthResponse)).resolves.toMatchObject({
        workspace: { branch: { currentBranch: "feature/two" } },
      });
    });
  });

  it("serves repeated pull request reads from one gh probe until git-refs-changed", async () => {
    await withTestHarness(async (harness) => {
      const { environment } = seedGitEnvironment(harness, "pull-request");
      const url = `/api/v1/environments/${environment.id}/pull-request`;

      const first = harness.app.request(url);
      const second = harness.app.request(url);
      const pullRequestCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.pull_request" &&
          command.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(harness, pullRequestCommand, {
        outcome: "available",
        pullRequest: rawPullRequest({ isDraft: true }),
      });
      for (const response of await Promise.all([first, second])) {
        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toMatchObject({
          outcome: "available",
          pullRequest: { number: 42, state: "draft" },
        });
      }

      const third = await harness.app.request(url);
      expect(third.status).toBe(200);
      await expect(readJson(third)).resolves.toMatchObject({
        pullRequest: { number: 42, state: "draft" },
      });
      expect(
        listQueuedCommands(harness, "workspace.pull_request"),
      ).toHaveLength(0);

      harness.hub.notifyEnvironment(environment.id, ["git-refs-changed"]);
      const fourth = harness.app.request(url);
      const refreshedCommand = await waitForQueuedCommandAfter(
        harness,
        pullRequestCommand.row.cursor,
        ({ command }) =>
          command.type === "workspace.pull_request" &&
          command.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(harness, refreshedCommand, {
        outcome: "available",
        pullRequest: rawPullRequest({ isDraft: false }),
      });
      const fourthResponse = await fourth;
      expect(fourthResponse.status).toBe(200);
      await expect(readJson(fourthResponse)).resolves.toMatchObject({
        pullRequest: { number: 42, state: "open" },
      });
    });
  });

  it("drops the cached status and pull request when the commit action mutates the workspace", async () => {
    await withTestHarness(async (harness) => {
      const { environment } = seedGitEnvironment(harness, "commit-action");
      const statusUrl = `/api/v1/environments/${environment.id}/status`;
      const pullRequestUrl = `/api/v1/environments/${environment.id}/pull-request`;

      const dirtyRead = harness.app.request(statusUrl);
      const dirtyCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.status" &&
          command.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(
        harness,
        dirtyCommand,
        workspaceStatus("bb/pr-cache", "untracked"),
      );
      await expect(readJson(await dirtyRead)).resolves.toMatchObject({
        workspace: { workingTree: { state: "untracked" } },
      });
      const pullRequestRead = harness.app.request(pullRequestUrl);
      const pullRequestCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.pull_request" &&
          command.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(harness, pullRequestCommand, {
        outcome: "absent",
      });
      expect((await pullRequestRead).status).toBe(200);

      const commitResponse = harness.app.request(
        `/api/v1/environments/${environment.id}/actions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "commit" }),
        },
      );
      const preflightCommand = await waitForQueuedCommandAfter(
        harness,
        pullRequestCommand.row.cursor,
        ({ command }) =>
          command.type === "workspace.status" &&
          command.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(
        harness,
        preflightCommand,
        workspaceStatus("bb/pr-cache", "untracked"),
      );
      const diffCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.diff" &&
          command.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(harness, diffCommand, {
        outcome: "available",
        diff: {
          diff: "",
          files: "",
          mergeBaseRef: null,
          shortstat: "",
          truncated: false,
        },
      });
      const commitCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.commit" &&
          command.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(harness, commitCommand, {
        commitSha: "abc123",
        commitSubject: "bb: automated commit",
      });
      expect((await commitResponse).status).toBe(200);

      const refreshedRead = harness.app.request(statusUrl);
      const refreshedCommand = await waitForQueuedCommandAfter(
        harness,
        commitCommand.row.cursor,
        ({ command }) =>
          command.type === "workspace.status" &&
          command.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(
        harness,
        refreshedCommand,
        workspaceStatus("bb/pr-cache", "clean"),
      );
      const refreshedResponse = await refreshedRead;
      expect(refreshedResponse.status).toBe(200);
      await expect(readJson(refreshedResponse)).resolves.toMatchObject({
        workspace: { workingTree: { state: "clean" } },
      });

      const refreshedPullRequestRead = harness.app.request(pullRequestUrl);
      const refreshedPullRequestCommand = await waitForQueuedCommandAfter(
        harness,
        commitCommand.row.cursor,
        ({ command }) =>
          command.type === "workspace.pull_request" &&
          command.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(harness, refreshedPullRequestCommand, {
        outcome: "available",
        pullRequest: rawPullRequest(),
      });
      await expect(
        readJson(await refreshedPullRequestRead),
      ).resolves.toMatchObject({ pullRequest: { number: 42 } });
    });
  });
});

import { describe, expect, it } from "vitest";
import { getEnvironment } from "@bb/db";
import type { GitHostPullRequest } from "@bb/domain";
import { readJson } from "../helpers/json.js";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

function rawPullRequest(
  overrides: Partial<GitHostPullRequest> = {},
): GitHostPullRequest {
  return {
    number: 42,
    title: "Add pull request actions",
    state: "OPEN",
    url: "https://github.com/acme/bb/pull/42",
    isDraft: false,
    baseRefName: "main",
    headRefName: "bb/pr-actions",
    updatedAt: "2026-06-16T12:30:00Z",
    checks: [],
    reviewDecision: null,
    reviewRequestCount: 0,
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
    ...overrides,
  };
}

describe("public environment action regressions", () => {
  it("rejects the removed squash-merge action with a 400", async () => {
    await withTestHarness(async (harness) => {
      const squashMergeResponse = await harness.app.request(
        "/api/v1/environments/env_missing/actions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "squash_merge",
            options: { mergeBaseBranch: "main" },
          }),
        },
      );
      expect(squashMergeResponse.status).toBe(400);
      await expect(readJson(squashMergeResponse)).resolves.toMatchObject({
        code: "invalid_request",
      });
    });
  });

  it("rejects legacy environment action payloads that still send threadId", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-thread-target",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/thread-target",
      });

      const mismatchedResponse = await harness.app.request(
        `/api/v1/environments/${environment.id}/actions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "commit",
            threadId: "thread-legacy",
          }),
        },
      );
      expect(mismatchedResponse.status).toBe(400);
      await expect(readJson(mismatchedResponse)).resolves.toMatchObject({
        code: "invalid_request",
      });
    });
  });

  it("records the daemon-observed branch during commit action status preflight", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-commit-observed-branch",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        branchName: "bb/stale",
        defaultBranch: "main",
        path: "/tmp/commit-observed-branch-env",
      });

      const responsePromise = harness.app.request(
        `/api/v1/environments/${environment.id}/actions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "commit" }),
        },
      );

      const statusCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.status" &&
          command.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(harness, statusCommand, {
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
            currentBranch: "feature/current",
            defaultBranch: "trunk",
          },
          checkout: {
            kind: "branch",
            branchName: "feature/current",
            headSha: null,
          },
          mergeBase: null,
        },
      });

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

      const response = await responsePromise;
      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "no_changes",
      });
      expect(getEnvironment(harness.db, environment.id)).toMatchObject({
        branchName: "feature/current",
        defaultBranch: "trunk",
      });
    });
  });

  it("marks draft pull requests ready through the environment action route", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pr-ready",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/pr-ready-env",
      });

      const responsePromise = harness.app.request(
        `/api/v1/environments/${environment.id}/actions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "pull_request_ready",
          }),
        },
      );

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

      const readyCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.pull_request_action" &&
          command.environmentId === environment.id,
      );
      expect(readyCommand.command).toMatchObject({
        operation: "ready",
      });
      await reportQueuedCommandSuccess(harness, readyCommand, {});

      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        action: "pull_request_ready",
        ok: true,
      });
    });
  });

  it("converts open pull requests back to draft through the environment action route", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pr-draft",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/pr-draft-env",
      });

      const responsePromise = harness.app.request(
        `/api/v1/environments/${environment.id}/actions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "pull_request_draft",
          }),
        },
      );

      const pullRequestCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.pull_request" &&
          command.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(harness, pullRequestCommand, {
        outcome: "available",
        pullRequest: rawPullRequest(),
      });

      const draftCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.pull_request_action" &&
          command.environmentId === environment.id,
      );
      expect(draftCommand.command).toMatchObject({
        operation: "draft",
      });
      await reportQueuedCommandSuccess(harness, draftCommand, {});

      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        action: "pull_request_draft",
        ok: true,
      });
    });
  });

  it("rejects blocked pull request merges before dispatching a merge command", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pr-blocked",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/pr-blocked-env",
      });

      const responsePromise = harness.app.request(
        `/api/v1/environments/${environment.id}/actions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "pull_request_merge",
            options: { method: "merge" },
          }),
        },
      );

      const pullRequestCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.pull_request" &&
          command.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(harness, pullRequestCommand, {
        outcome: "available",
        pullRequest: rawPullRequest({
          mergeStateStatus: "BLOCKED",
          mergeable: "UNKNOWN",
        }),
      });

      const response = await responsePromise;
      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "pull_request_not_mergeable",
      });
    });
  });

  it("merges open pull requests through the selected merge method", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pr-merge",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/pr-merge-env",
      });

      const responsePromise = harness.app.request(
        `/api/v1/environments/${environment.id}/actions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "pull_request_merge",
            options: { method: "rebase" },
          }),
        },
      );

      const pullRequestCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.pull_request" &&
          command.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(harness, pullRequestCommand, {
        outcome: "available",
        pullRequest: rawPullRequest(),
      });

      const mergeCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.pull_request_action" &&
          command.environmentId === environment.id,
      );
      expect(mergeCommand.command).toMatchObject({
        operation: "merge",
        method: "rebase",
      });
      await reportQueuedCommandSuccess(harness, mergeCommand, {});

      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        action: "pull_request_merge",
        method: "rebase",
        ok: true,
      });
    });
  });
});

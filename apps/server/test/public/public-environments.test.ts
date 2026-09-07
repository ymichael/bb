import { describe, expect, it } from "vitest";
import { getEnvironment } from "@bb/db";
import {
  registerTestHostRpcCapture,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("public environments", () => {
  it("lists cached branch options while remotes refresh in the background", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-environment-branch-options",
      });
      registerTestHostRpcCapture(harness, {
        hostId: host.id,
        sessionId: session.id,
        queueBranchOptions: true,
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/branch-options-env",
        workspaceProvisionType: "managed-worktree",
      });

      const responsePromise = harness.app.request(
        `/api/v1/environments/${environment.id}/diff/branches?query=feature&selectedBranch=origin%2Fmain&limit=10`,
      );
      const branchOptionsCommand = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "host.list_branch_options",
      );
      expect(branchOptionsCommand.command).toEqual({
        type: "host.list_branch_options",
        path: "/tmp/branch-options-env",
        query: "feature",
        selectedBranch: "origin/main",
        limit: 10,
        remoteRefresh: "background",
      });
      await reportQueuedCommandSuccess(harness, branchOptionsCommand, {
        branches: ["feature/local"],
        branchesTruncated: false,
        remoteBranches: ["origin/feature/remote"],
        remoteBranchesTruncated: false,
        selectedBranch: { kind: "remote", name: "origin/main" },
      });

      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        branches: ["feature/local"],
        branchesTruncated: false,
        remoteBranches: ["origin/feature/remote"],
        remoteBranchesTruncated: false,
        selectedBranch: { kind: "remote", name: "origin/main" },
      });
    });
  });

  it("propagates a bounded truncated diff table of contents", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-environment-truncated-diff",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/truncated-diff-env",
        workspaceProvisionType: "managed-worktree",
      });

      const responsePromise = harness.app.request(
        `/api/v1/environments/${environment.id}/diff/files?target=uncommitted`,
      );
      const diffFilesCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.diffFiles" &&
          command.environmentId === environment.id,
      );
      expect(diffFilesCommand.command).toMatchObject({ maxFiles: 500 });
      await reportQueuedCommandSuccess(harness, diffFilesCommand, {
        outcome: "available",
        files: [
          {
            path: "large.bin",
            previousPath: null,
            statusLetter: "A",
            additions: 0,
            deletions: 0,
            binary: true,
            origin: "untracked",
          },
        ],
        shortstat: "1 file changed",
        mergeBaseRef: null,
        truncated: true,
      });

      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        outcome: "available",
        truncated: true,
        files: [
          {
            path: "large.bin",
            origin: "untracked",
            loadMode: "on_demand",
          },
        ],
      });
    });
  });

  it("records the daemon-observed current branch after workspace status", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-environment-current-branch",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        branchName: "bb/stale",
        defaultBranch: "main",
        path: "/tmp/current-branch-env",
        workspaceProvisionType: "managed-worktree",
      });

      const statusPromise = harness.app.request(
        `/api/v1/environments/${environment.id}/status`,
      );
      const statusCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.status" &&
          command.environmentId === environment.id,
      );
      expect(statusCommand.command).toMatchObject({
        maxUntrackedLineStatFiles: 50,
        maxUntrackedLineStatBytes: 8 * 1024 * 1024,
      });
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

      const response = await statusPromise;
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        outcome: "available",
        workspace: {
          branch: {
            currentBranch: "feature/current",
            defaultBranch: "trunk",
          },
        },
      });
      expect(getEnvironment(harness.db, environment.id)).toMatchObject({
        branchName: "feature/current",
        defaultBranch: "trunk",
      });
    });
  });

  it("clears the stored branch after detached workspace status", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-environment-detached-branch",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        branchName: "bb/stale",
        defaultBranch: "main",
        path: "/tmp/detached-branch-env",
        workspaceProvisionType: "managed-worktree",
      });

      const statusPromise = harness.app.request(
        `/api/v1/environments/${environment.id}/status`,
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
            currentBranch: null,
            defaultBranch: "main",
          },
          checkout: {
            kind: "detached",
            headSha: "0123456789abcdef0123456789abcdef01234567",
          },
          mergeBase: null,
        },
      });

      const response = await statusPromise;
      expect(response.status).toBe(200);
      expect(getEnvironment(harness.db, environment.id)).toMatchObject({
        branchName: null,
        defaultBranch: "main",
      });
    });
  });

  it("renames an environment through the public update route", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-environment-rename",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        workspaceProvisionType: "managed-worktree",
      });

      const response = await harness.app.request(
        `/api/v1/environments/${environment.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "  Review workspace  " }),
        },
      );

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        id: environment.id,
        name: "Review workspace",
      });
    });
  });

  it("rejects empty environment updates", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request(
        "/api/v1/environments/env_missing",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      expect(response.status).toBe(400);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
      });
    });
  });

  it("lists workspace paths via host.list_paths for a personal-workspace environment", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-environment-paths",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/personal-workspace",
        workspaceProvisionType: "personal",
      });

      const pathsPromise = harness.app.request(
        `/api/v1/environments/${environment.id}/paths?query=app&includeFiles=true&includeDirectories=false`,
      );
      const pathsCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.list_paths" &&
          command.path === "/tmp/personal-workspace",
      );
      expect(pathsCommand.command).toMatchObject({
        path: "/tmp/personal-workspace",
        query: "app",
        includeFiles: true,
        includeDirectories: false,
      });
      await reportQueuedCommandSuccess(harness, pathsCommand, {
        paths: [
          {
            kind: "file",
            path: "src/app.ts",
            name: "app.ts",
            score: 80,
            positions: [0, 1, 2],
          },
        ],
        truncated: false,
      });

      const pathsResponse = await pathsPromise;
      expect(pathsResponse.status).toBe(200);
      await expect(readJson(pathsResponse)).resolves.toEqual({
        paths: [
          {
            kind: "file",
            path: "src/app.ts",
            name: "app.ts",
            score: 80,
            positions: [0, 1, 2],
          },
        ],
        truncated: false,
      });
    });
  });

  it("returns not-ready for workspace path search on an unprovisioned environment", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-environment-paths-pending",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        status: "provisioning",
      });

      const response = await harness.app.request(
        `/api/v1/environments/${environment.id}/paths?query=app&includeFiles=true&includeDirectories=false`,
      );

      expect(response.status).toBe(409);
    });
  });
});

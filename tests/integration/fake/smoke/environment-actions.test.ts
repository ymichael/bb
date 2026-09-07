import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  archiveThread,
  deleteThread,
  getEnvironmentBranches,
  getEnvironmentDiff,
  getEnvironmentDiffFiles,
  getEnvironmentDiffPatch,
  getEnvironmentStatus,
  getThread,
  getThreadOutput,
  runEnvironmentAction,
  sendTextMessage,
  unarchiveThread,
} from "../../helpers/api.js";
import {
  waitForPathRemoval,
  waitForThreadStatus,
} from "../../helpers/assertions.js";
import { withHarness } from "../../helpers/harness.js";
import { createTestFile, runGit } from "../../helpers/seed.js";
import {
  createProjectFixture,
  createReadyThread,
  DEFAULT_TIMEOUT_MS,
  expectEnvironmentDestroyed,
  expectThreadMissing,
  TURN_TIMEOUT_MS,
} from "./shared.js";

describe.sequential("fake provider smoke environment integration", () => {
  it("reports workspace status, diff, and branches for a ready environment", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(
        harness,
        "Workspace Status Smoke",
      );
      const { environment } = await createReadyThread(harness, {
        projectId: project.id,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });

      const status = await getEnvironmentStatus(harness.api, environment.id);
      const diff = await getEnvironmentDiff(harness.api, environment.id);
      const branches = await getEnvironmentBranches(
        harness.api,
        environment.id,
      );

      expect(status.outcome).toBe("available");
      if (status.outcome !== "available") {
        throw new Error(
          `Expected workspace status, received ${status.outcome}`,
        );
      }
      expect(status.workspace.workingTree.state).toBe("clean");
      expect(status.workspace.workingTree.hasUncommittedChanges).toBe(false);
      expect(typeof diff.diff).toBe("string");
      expect(branches.branches).toContain("main");
    }));

  it("paginates the diff through diff/files and diff/patch for a ready environment", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(
        harness,
        "Diff Pagination Smoke",
      );
      const { environment } = await createReadyThread(harness, {
        projectId: project.id,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });

      const workspacePath = environment.path;
      if (!workspacePath) {
        throw new Error("Workspace path was not assigned");
      }

      await createTestFile({
        content: "export const paginated = true;\n",
        filePath: path.join(workspacePath, "feature.ts"),
      });

      const files = await getEnvironmentDiffFiles(harness.api, environment.id);
      expect(files.outcome).toBe("available");
      if (files.outcome !== "available") {
        throw new Error(`Expected diff files, received ${files.outcome}`);
      }
      const entry = files.files.find((file) => file.path === "feature.ts");
      expect(entry).toBeDefined();
      expect(entry?.loadMode).toBe("auto");
      expect(files.initialPatches.some((p) => p.path === "feature.ts")).toBe(
        true,
      );

      const patch = await getEnvironmentDiffPatch(harness.api, environment.id, [
        "feature.ts",
      ]);
      expect(patch.outcome).toBe("available");
      if (patch.outcome !== "available") {
        throw new Error(`Expected diff patch, received ${patch.outcome}`);
      }
      expect(patch.patches).toHaveLength(1);
      expect(patch.patches[0]?.path).toBe("feature.ts");
      expect(patch.patches[0]?.patch).toContain(
        "export const paginated = true;",
      );
    }));

  it("commits dirty workspace changes through the environment actions route", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(
        harness,
        "Workspace Commit Smoke",
      );
      const { environment } = await createReadyThread(harness, {
        projectId: project.id,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });

      const workspacePath = environment.path;
      if (!workspacePath) {
        throw new Error("Workspace path was not assigned");
      }

      await createTestFile({
        content: "committed from smoke test\n",
        filePath: path.join(workspacePath, "committed.txt"),
      });

      const dirtyStatus = await getEnvironmentStatus(
        harness.api,
        environment.id,
      );
      expect(dirtyStatus.outcome).toBe("available");
      if (dirtyStatus.outcome !== "available") {
        throw new Error(
          `Expected dirty workspace status, received ${dirtyStatus.outcome}`,
        );
      }
      expect(dirtyStatus.workspace.workingTree.hasUncommittedChanges).toBe(
        true,
      );

      const result = await runEnvironmentAction(harness.api, environment.id, {
        action: "commit",
      });
      expect(result.action).toBe("commit");
      if (result.action !== "commit") {
        throw new Error(
          `Expected commit action result, received ${result.action}`,
        );
      }
      expect(result.commitSha).toBeTruthy();

      const cleanStatus = await getEnvironmentStatus(
        harness.api,
        environment.id,
      );
      expect(cleanStatus.outcome).toBe("available");
      if (cleanStatus.outcome !== "available") {
        throw new Error(
          `Expected clean workspace status, received ${cleanStatus.outcome}`,
        );
      }
      expect(cleanStatus.workspace.workingTree.state).toBe("clean");

      const subject = await runGit({
        args: ["log", "-1", "--format=%s"],
        cwd: workspacePath,
      });
      expect(subject.trim()).toBe("bb: automated commit");
    }));

  it("archives and unarchives a thread, blocking work while archived", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(harness, "Archive Smoke");
      const { thread } = await createReadyThread(harness, {
        projectId: project.id,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });

      await archiveThread(harness.api, thread.id);
      const archivedThread = await getThread(harness.api, thread.id);
      expect(archivedThread.archivedAt).toBeTypeOf("number");

      const archivedSendResponse = await harness.api.threads[":id"].send.$post({
        param: { id: thread.id },
        json: {
          input: [{ type: "text", text: "should fail", mentions: [] }],
          mode: "auto",
        },
      });
      expect(archivedSendResponse.status).toBe(409);

      await unarchiveThread(harness.api, thread.id);
      const unarchivedThread = await getThread(harness.api, thread.id);
      expect(unarchivedThread.archivedAt).toBeNull();

      await sendTextMessage(harness.api, thread.id, {
        text: "after unarchive",
      });
      await waitForThreadStatus(
        harness.api,
        thread.id,
        "idle",
        TURN_TIMEOUT_MS,
      );

      const output = await getThreadOutput(harness.api, thread.id);
      expect(output).toContain("after unarchive");
    }));

  it("archives a managed worktree thread and destroys the environment", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(
        harness,
        "Archive Cleanup Smoke",
      );
      const { environment, thread } = await createReadyThread(harness, {
        projectId: project.id,
        workspace: { type: "managed-worktree" },
      });

      const workspacePath = environment.path;
      if (!workspacePath) {
        throw new Error("Managed worktree path was not assigned");
      }

      await archiveThread(harness.api, thread.id);
      await waitForPathRemoval(workspacePath, DEFAULT_TIMEOUT_MS);
      await expectEnvironmentDestroyed(harness, environment.id);
    }));

  it("deletes a thread after turn history has been created", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(harness, "Delete Smoke");
      const { thread } = await createReadyThread(harness, {
        projectId: project.id,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });

      await sendTextMessage(harness.api, thread.id, {
        text: "delete me after this turn",
      });
      await waitForThreadStatus(
        harness.api,
        thread.id,
        "idle",
        TURN_TIMEOUT_MS,
      );

      await deleteThread(harness.api, thread.id);
      await expectThreadMissing(harness, thread.id);
    }));
});

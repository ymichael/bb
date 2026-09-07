import { eq } from "drizzle-orm";
import { environments } from "@bb/db";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  archiveThread,
  deleteThread,
  getEnvironment,
  getThreadOutput,
  runEnvironmentAction,
  sendTextMessage,
  unarchiveThread,
} from "../../helpers/api.js";
import {
  waitForEnvironmentStatus,
  waitForPathRemoval,
  waitForThreadStatus,
} from "../../helpers/assertions.js";
import {
  createProjectFixture,
  createReadyHostThread,
  createReadyReuseThread,
} from "../../helpers/fixtures.js";
import { withHarness } from "../../helpers/harness.js";
import {
  createTestFile,
  createTestGitRepo,
  runGit,
} from "../../helpers/seed.js";
import { scaleTimeoutMs } from "../../helpers/time.js";
import {
  CONCURRENT_DELAY_TEXT,
  DEFAULT_TIMEOUT_MS,
  TURN_TIMEOUT_MS,
} from "./shared.js";

const REBUILD_TIMEOUT_MS = scaleTimeoutMs(30_000);
const REBUILD_TEST_TIMEOUT_MS = scaleTimeoutMs(120_000);

describe.sequential("fake provider environment-isolation multi-thread integration", () => {
  it(
    "asks the worktree provider again on unarchive",
    () =>
      withHarness(
        { builtinPlugins: ["environment-git-worktree"] },
        async (harness) => {
          const project = await createProjectFixture(harness, {
            name: "Rebuild Managed Worktree",
          });
          const worktreeThread = await createReadyHostThread(harness, {
            projectId: project.id,
            timeoutMs: DEFAULT_TIMEOUT_MS,
            workspace: { type: "managed-worktree" },
          });
          const siblingThread = await createReadyReuseThread(harness, {
            environmentId: worktreeThread.environment.id,
            projectId: project.id,
            timeoutMs: DEFAULT_TIMEOUT_MS,
          });
          const unrelatedThread = await createReadyHostThread(harness, {
            projectId: project.id,
            timeoutMs: DEFAULT_TIMEOUT_MS,
            workspace: { type: "unmanaged", path: harness.repoDir },
          });
          const originalWorkspacePath = worktreeThread.environment.path;
          if (!originalWorkspacePath) {
            throw new Error("Managed worktree path was not assigned");
          }

          await archiveThread(harness.api, worktreeThread.thread.id);
          await deleteThread(harness.api, siblingThread.thread.id);
          await expect
            .poll(
              async () =>
                (
                  await getEnvironment(
                    harness.api,
                    worktreeThread.environment.id,
                  )
                ).lifecycle.phase,
              { timeout: DEFAULT_TIMEOUT_MS },
            )
            .toBe("retiring");
          await fs.access(originalWorkspacePath);
          harness.db
            .update(environments)
            .set({ retireAt: Date.now() - 1 })
            .where(eq(environments.id, worktreeThread.environment.id))
            .run();
          await expect
            .poll(
              async () => {
                await harness.server.sweepEnvironments();
                return (
                  await getEnvironment(
                    harness.api,
                    worktreeThread.environment.id,
                  )
                ).lifecycle.teardown?.status;
              },
              { timeout: REBUILD_TIMEOUT_MS },
            )
            .toBe("removed");
          await waitForPathRemoval(originalWorkspacePath, DEFAULT_TIMEOUT_MS);
          await deleteThread(harness.api, unrelatedThread.thread.id);
          await waitForEnvironmentStatus(
            harness.api,
            worktreeThread.environment.id,
            "destroyed",
            DEFAULT_TIMEOUT_MS,
          );

          await unarchiveThread(harness.api, worktreeThread.thread.id);
          await sendTextMessage(harness.api, worktreeThread.thread.id, {
            text: "rebuild after archive",
          });
          const rebuiltThread = await waitForThreadStatus(
            harness.api,
            worktreeThread.thread.id,
            "idle",
            REBUILD_TIMEOUT_MS,
          );

          const rebuiltEnvironmentId = rebuiltThread.environmentId;
          expect(rebuiltEnvironmentId).toBeTruthy();
          expect(rebuiltEnvironmentId).not.toBe(worktreeThread.environment.id);
          if (!rebuiltEnvironmentId) {
            throw new Error("Rebuilt thread has no environment");
          }
          const rebuiltEnvironment = await getEnvironment(
            harness.api,
            rebuiltEnvironmentId,
          );
          expect(rebuiltEnvironment.status).toBe("ready");
          expect(rebuiltEnvironment.environmentProviderId).toBe("git-worktree");
          expect(rebuiltEnvironment.path).toBeTruthy();
          expect(rebuiltEnvironment.path).not.toBe(originalWorkspacePath);
          await fs.access(rebuiltEnvironment.path ?? "");
          expect(
            await getThreadOutput(harness.api, worktreeThread.thread.id),
          ).toContain("rebuild after archive");
        },
      ),
    REBUILD_TEST_TIMEOUT_MS,
  );

  it("isolates concurrent work across separate environments", () =>
    withHarness(async (harness) => {
      const secondRepoDir = await createTestGitRepo({
        repoDir: path.join(path.dirname(harness.repoDir), "second-project"),
      });
      const projectA = await createProjectFixture(harness, {
        name: "Environment Isolation A",
      });
      const projectB = await createProjectFixture(harness, {
        name: "Environment Isolation B",
        path: secondRepoDir,
      });
      const threadA = await createReadyHostThread(harness, {
        projectId: projectA.id,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });
      const threadB = await createReadyHostThread(harness, {
        projectId: projectB.id,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        workspace: {
          type: "unmanaged",
          path: secondRepoDir,
        },
      });

      await Promise.all([
        sendTextMessage(harness.api, threadA.thread.id, {
          text: `${CONCURRENT_DELAY_TEXT} env-a`,
        }),
        sendTextMessage(harness.api, threadB.thread.id, {
          text: `${CONCURRENT_DELAY_TEXT} env-b`,
        }),
      ]);
      await Promise.all([
        waitForThreadStatus(
          harness.api,
          threadA.thread.id,
          "idle",
          TURN_TIMEOUT_MS,
        ),
        waitForThreadStatus(
          harness.api,
          threadB.thread.id,
          "idle",
          TURN_TIMEOUT_MS,
        ),
      ]);

      await createTestFile({
        content: "environment a only\n",
        filePath: path.join(harness.repoDir, "env-a-only.txt"),
      });
      await createTestFile({
        content: "environment b only\n",
        filePath: path.join(secondRepoDir, "env-b-only.txt"),
      });

      await Promise.all([
        runEnvironmentAction(harness.api, threadA.environment.id, {
          action: "commit",
        }),
        runEnvironmentAction(harness.api, threadB.environment.id, {
          action: "commit",
        }),
      ]);

      expect(
        (
          await runGit({
            args: ["log", "-1", "--format=%s"],
            cwd: harness.repoDir,
          })
        ).trim(),
      ).toBe("bb: automated commit");
      expect(
        (
          await runGit({
            args: ["log", "-1", "--format=%s"],
            cwd: secondRepoDir,
          })
        ).trim(),
      ).toBe("bb: automated commit");
    }));
});

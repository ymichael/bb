import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  archiveThread,
  getEnvironment,
  getHosts,
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
import {
  createIntegrationHarness,
  withHarness,
} from "../../helpers/harness.js";
import { countStoredThreads } from "../../helpers/queries.js";
import {
  createTestFile,
  createTestGitRepo,
  runGit,
} from "../../helpers/seed.js";
import {
  CONCURRENT_DELAY_TEXT,
  DEFAULT_TIMEOUT_MS,
  TURN_TIMEOUT_MS,
} from "./shared.js";

describe.sequential("fake provider environment-isolation multi-thread integration", () => {
  it("does not reprovision a destroyed shared environment on unarchive", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(harness, {
        name: "Archive All Managed Siblings",
      });
      const threadA = await createReadyHostThread(harness, {
        projectId: project.id,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        workspace: { type: "managed-worktree" },
      });
      const threadB = await createReadyReuseThread(harness, {
        environmentId: threadA.environment.id,
        projectId: project.id,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      const originalWorkspacePath = threadA.environment.path;
      if (!originalWorkspacePath) {
        throw new Error("Managed worktree path was not assigned");
      }

      await archiveThread(harness.api, threadA.thread.id);
      await archiveThread(harness.api, threadB.thread.id);
      await waitForPathRemoval(originalWorkspacePath, DEFAULT_TIMEOUT_MS);
      await waitForEnvironmentStatus(
        harness.api,
        threadA.environment.id,
        "destroyed",
        DEFAULT_TIMEOUT_MS,
      );

      await unarchiveThread(harness.api, threadA.thread.id);

      const sendResponse = await harness.api.threads[":id"].send.$post({
        param: { id: threadA.thread.id },
        json: {
          input: [
            { type: "text", text: "reprovision after archive", mentions: [] },
          ],
          mode: "auto",
        },
      });
      expect(sendResponse.status).toBe(409);
      expect(await sendResponse.json()).toMatchObject({
        code: "thread_environment_unavailable",
        details: { reason: "destroyed", environmentStatus: "destroyed" },
      });

      const environment = await getEnvironment(
        harness.api,
        threadA.environment.id,
      );
      expect(environment.status).toBe("destroyed");
    }));

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

  it("runs two isolated bb instances concurrently without cross-contamination", async () => {
    const harnessA = await createIntegrationHarness();
    const harnessB = await createIntegrationHarness();

    try {
      const [projectA, projectB] = await Promise.all([
        createProjectFixture(harnessA, {
          name: "Isolated Instance A",
        }),
        createProjectFixture(harnessB, {
          name: "Isolated Instance B",
        }),
      ]);
      const [threadA, threadB] = await Promise.all([
        createReadyHostThread(harnessA, {
          projectId: projectA.id,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          workspace: {
            type: "unmanaged",
            path: harnessA.repoDir,
          },
        }),
        createReadyHostThread(harnessB, {
          projectId: projectB.id,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          workspace: {
            type: "unmanaged",
            path: harnessB.repoDir,
          },
        }),
      ]);

      await Promise.all([
        sendTextMessage(harnessA.api, threadA.thread.id, {
          text: "instance-a turn",
        }),
        sendTextMessage(harnessB.api, threadB.thread.id, {
          text: "instance-b turn",
        }),
      ]);
      await Promise.all([
        waitForThreadStatus(
          harnessA.api,
          threadA.thread.id,
          "idle",
          TURN_TIMEOUT_MS,
        ),
        waitForThreadStatus(
          harnessB.api,
          threadB.thread.id,
          "idle",
          TURN_TIMEOUT_MS,
        ),
      ]);

      await Promise.all([
        createTestFile({
          content: "instance a only\n",
          filePath: path.join(harnessA.repoDir, "instance-a.txt"),
        }),
        createTestFile({
          content: "instance b only\n",
          filePath: path.join(harnessB.repoDir, "instance-b.txt"),
        }),
      ]);
      await Promise.all([
        runEnvironmentAction(harnessA.api, threadA.environment.id, {
          action: "commit",
        }),
        runEnvironmentAction(harnessB.api, threadB.environment.id, {
          action: "commit",
        }),
      ]);

      expect(countStoredThreads(harnessA.db)).toBe(1);
      expect(countStoredThreads(harnessB.db)).toBe(1);

      expect((await getHosts(harnessA.api)).length).toBe(1);
      expect((await getHosts(harnessB.api)).length).toBe(1);
      expect(harnessA.hostId).not.toBe(harnessB.hostId);

      expect(
        (
          await runGit({
            args: ["log", "-1", "--format=%s"],
            cwd: harnessA.repoDir,
          })
        ).trim(),
      ).toBe("bb: automated commit");
      expect(
        (
          await runGit({
            args: ["log", "-1", "--format=%s"],
            cwd: harnessB.repoDir,
          })
        ).trim(),
      ).toBe("bb: automated commit");
      await expect(
        fs.access(path.join(harnessB.repoDir, "instance-a.txt")),
      ).rejects.toThrow();
      await expect(
        fs.access(path.join(harnessA.repoDir, "instance-b.txt")),
      ).rejects.toThrow();
    } finally {
      await Promise.all([harnessA.cleanup(), harnessB.cleanup()]);
    }
  });
});

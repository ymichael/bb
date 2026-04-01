// Phase 7c: Fake provider multi-thread scenarios (plans/rebuild.md)
import fs from "node:fs/promises";
import path from "node:path";
import { createFakeAdapter } from "@bb/agent-runtime/test";
import type { ThreadEventRow } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  archiveThread,
  getEnvironment,
  getHosts,
  getThreadEvents,
  getThreadOutput,
  runEnvironmentAction,
  sendTextMessage,
  unarchiveThread,
} from "../helpers/api.js";
import {
  waitForCommand,
  waitForCommandsDrained,
  waitForPathRemoval,
  waitForThreadStatus,
} from "../helpers/assertions.js";
import {
  createProjectFixture,
  createReadyHostThread,
  createReadyReuseThread,
} from "../helpers/fixtures.js";
import {
  createIntegrationHarness,
  withHarness,
} from "../helpers/harness.js";
import {
  countQueuedCommandsByType,
  countStoredThreads,
} from "../helpers/queries.js";
import {
  createTestFile,
  createTestGitRepo,
  runGit,
} from "../helpers/seed.js";
import { scaleTimeoutMs } from "../helpers/time.js";

// Setup and reprovision waits: environment creation, cleanup, and shared-workspace reloads.
const DEFAULT_TIMEOUT_MS = scaleTimeoutMs(10_000);
// Whole-turn waits: sibling threads should finish a standard turn inside this window.
const TURN_TIMEOUT_MS = scaleTimeoutMs(15_000);
// Active-turn waits: enough time to observe concurrent threads become active.
const ACTIVE_TIMEOUT_MS = scaleTimeoutMs(5_000);
// Reprovision waits: managed cleanup plus a fresh start can take longer than a normal turn.
const REPROVISION_TIMEOUT_MS = scaleTimeoutMs(25_000);
// Fake provider inputs accept `delay:<ms>` prefixes to keep sibling turns overlapping.
const CONCURRENT_DELAY_TEXT = "delay:800";

function countTurnEvents(
  events: ThreadEventRow[],
  type: "turn/completed" | "turn/started",
): number {
  return events.filter((event) => event.type === type).length;
}

function assertEventsBelongToThread(
  events: ThreadEventRow[],
  threadId: string,
): void {
  expect(events.length).toBeGreaterThan(0);
  expect(events.every((event) => event.threadId === threadId)).toBe(true);
}

describe.sequential("fake provider multi-thread integration", () => {
  it("runs two threads in the same environment without cross-contaminating events", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(harness, {
        name: "Shared Environment Same Provider",
      });
      const threadA = await createReadyHostThread(harness, {
        projectId: project.id,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });
      const threadB = await createReadyReuseThread(harness, {
        environmentId: threadA.environment.id,
        projectId: project.id,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      const baselineEventsA = await getThreadEvents(harness.api, threadA.thread.id);
      const baselineEventsB = await getThreadEvents(harness.api, threadB.thread.id);
      const baselineCompletedA = countTurnEvents(baselineEventsA, "turn/completed");
      const baselineCompletedB = countTurnEvents(baselineEventsB, "turn/completed");

      await Promise.all([
        sendTextMessage(harness.api, threadA.thread.id, {
          text: `${CONCURRENT_DELAY_TEXT} shared-a`,
        }),
        sendTextMessage(harness.api, threadB.thread.id, {
          text: `${CONCURRENT_DELAY_TEXT} shared-b`,
        }),
      ]);

      await Promise.all([
        waitForThreadStatus(
          harness.api,
          threadA.thread.id,
          "active",
          ACTIVE_TIMEOUT_MS,
        ),
        waitForThreadStatus(
          harness.api,
          threadB.thread.id,
          "active",
          ACTIVE_TIMEOUT_MS,
        ),
      ]);
      await Promise.all([
        waitForThreadStatus(harness.api, threadA.thread.id, "idle", TURN_TIMEOUT_MS),
        waitForThreadStatus(harness.api, threadB.thread.id, "idle", TURN_TIMEOUT_MS),
      ]);

      const eventsA = await getThreadEvents(harness.api, threadA.thread.id);
      const eventsB = await getThreadEvents(harness.api, threadB.thread.id);
      assertEventsBelongToThread(eventsA, threadA.thread.id);
      assertEventsBelongToThread(eventsB, threadB.thread.id);
      expect(countTurnEvents(eventsA, "turn/completed")).toBe(
        baselineCompletedA + 1,
      );
      expect(countTurnEvents(eventsB, "turn/completed")).toBe(
        baselineCompletedB + 1,
      );

      const outputA = await getThreadOutput(harness.api, threadA.thread.id);
      const outputB = await getThreadOutput(harness.api, threadB.thread.id);
      expect(outputA).toContain("shared-a");
      expect(outputB).toContain("shared-b");
    }));

  it("supports sequential follow-ups for two sibling threads in one environment", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(harness, {
        name: "Shared Environment Follow Ups",
      });
      const threadA = await createReadyHostThread(harness, {
        projectId: project.id,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });
      const threadB = await createReadyReuseThread(harness, {
        environmentId: threadA.environment.id,
        projectId: project.id,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      const baselineEventsA = await getThreadEvents(harness.api, threadA.thread.id);
      const baselineEventsB = await getThreadEvents(harness.api, threadB.thread.id);
      const baselineStartedA = countTurnEvents(baselineEventsA, "turn/started");
      const baselineCompletedA = countTurnEvents(baselineEventsA, "turn/completed");
      const baselineStartedB = countTurnEvents(baselineEventsB, "turn/started");
      const baselineCompletedB = countTurnEvents(baselineEventsB, "turn/completed");

      await sendTextMessage(harness.api, threadA.thread.id, {
        text: "thread-a first",
      });
      await waitForThreadStatus(harness.api, threadA.thread.id, "idle", TURN_TIMEOUT_MS);

      await sendTextMessage(harness.api, threadB.thread.id, {
        text: "thread-b first",
      });
      await waitForThreadStatus(harness.api, threadB.thread.id, "idle", TURN_TIMEOUT_MS);

      await sendTextMessage(harness.api, threadA.thread.id, {
        mode: "auto",
        text: "thread-a second",
      });
      await waitForThreadStatus(harness.api, threadA.thread.id, "idle", TURN_TIMEOUT_MS);

      await sendTextMessage(harness.api, threadB.thread.id, {
        mode: "auto",
        text: "thread-b second",
      });
      await waitForThreadStatus(harness.api, threadB.thread.id, "idle", TURN_TIMEOUT_MS);

      const eventsA = await getThreadEvents(harness.api, threadA.thread.id);
      const eventsB = await getThreadEvents(harness.api, threadB.thread.id);
      assertEventsBelongToThread(eventsA, threadA.thread.id);
      assertEventsBelongToThread(eventsB, threadB.thread.id);
      expect(countTurnEvents(eventsA, "turn/started")).toBe(
        baselineStartedA + 2,
      );
      expect(countTurnEvents(eventsA, "turn/completed")).toBe(
        baselineCompletedA + 2,
      );
      expect(countTurnEvents(eventsB, "turn/started")).toBe(
        baselineStartedB + 2,
      );
      expect(countTurnEvents(eventsB, "turn/completed")).toBe(
        baselineCompletedB + 2,
      );
    }));

  it("keeps a shared environment alive while one sibling remains unarchived", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(harness, {
        name: "Archive One Sibling",
      });
      const threadA = await createReadyHostThread(harness, {
        projectId: project.id,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });
      const threadB = await createReadyReuseThread(harness, {
        environmentId: threadA.environment.id,
        projectId: project.id,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });

      await Promise.all([
        sendTextMessage(harness.api, threadA.thread.id, {
          text: "archive-a seed",
        }),
        sendTextMessage(harness.api, threadB.thread.id, {
          text: "archive-b seed",
        }),
      ]);
      await Promise.all([
        waitForThreadStatus(harness.api, threadA.thread.id, "idle", TURN_TIMEOUT_MS),
        waitForThreadStatus(harness.api, threadB.thread.id, "idle", TURN_TIMEOUT_MS),
      ]);

      await archiveThread(harness.api, threadA.thread.id);
      await sendTextMessage(harness.api, threadB.thread.id, {
        text: "thread-b still works",
      });
      await waitForThreadStatus(harness.api, threadB.thread.id, "idle", TURN_TIMEOUT_MS);

      expect(countQueuedCommandsByType(harness.db, "environment.destroy")).toBe(0);

      const environment = await getEnvironment(harness.api, threadA.environment.id);
      expect(environment.status).toBe("ready");
      expect(await getThreadOutput(harness.api, threadB.thread.id)).toContain(
        "thread-b still works",
      );
    }));

  it("destroys a managed shared environment and reprovisions it after unarchive", () =>
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
      const originalWorkspacePath = threadA.environment.path ?? "";

      await archiveThread(harness.api, threadA.thread.id);
      await archiveThread(harness.api, threadB.thread.id);
      await waitForCommand(
        harness.db,
        (command) =>
          command.type === "environment.destroy" &&
          command.command.type === "environment.destroy" &&
          command.command.environmentId === threadA.environment.id,
        DEFAULT_TIMEOUT_MS,
      );
      await waitForCommandsDrained(harness.db, harness.hostId, DEFAULT_TIMEOUT_MS);
      await waitForPathRemoval(originalWorkspacePath, DEFAULT_TIMEOUT_MS);

      await unarchiveThread(harness.api, threadA.thread.id);
      await sendTextMessage(harness.api, threadA.thread.id, {
        text: "reprovision after archive",
      });
      await waitForThreadStatus(
        harness.api,
        threadA.thread.id,
        "idle",
        REPROVISION_TIMEOUT_MS,
      );

      const reloadedThread = await waitForThreadStatus(
        harness.api,
        threadA.thread.id,
        "idle",
        DEFAULT_TIMEOUT_MS,
      );
      const environment = await getEnvironment(
        harness.api,
        reloadedThread.environmentId ?? "",
      );
      expect(environment.status).toBe("ready");
      expect(environment.path).toBeTruthy();
      await fs.access(environment.path ?? "");
      expect(await getThreadOutput(harness.api, threadA.thread.id)).toContain(
        "reprovision after archive",
      );
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
        waitForThreadStatus(harness.api, threadA.thread.id, "idle", TURN_TIMEOUT_MS),
        waitForThreadStatus(harness.api, threadB.thread.id, "idle", TURN_TIMEOUT_MS),
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
        (await runGit({
          args: ["log", "-1", "--format=%s"],
          cwd: harness.repoDir,
        })).trim(),
      ).toBe("bb: automated commit");
      expect(
        (await runGit({
          args: ["log", "-1", "--format=%s"],
          cwd: secondRepoDir,
        })).trim(),
      ).toBe("bb: automated commit");
    }));

  it("keeps provider processes isolated for different providers in one environment", async () => {
    await withHarness(
      {
        adapterFactory: (providerId) =>
          createFakeAdapter({
            displayName: providerId,
            id: providerId,
            modelId: `${providerId}-model`,
            modelName: `${providerId} model`,
          }),
      },
      async (harness) => {
        const project = await createProjectFixture(harness, {
          name: "Shared Environment Different Providers",
        });
        const threadA = await createReadyHostThread(harness, {
          projectId: project.id,
          providerId: "fake-alpha",
          timeoutMs: DEFAULT_TIMEOUT_MS,
          workspace: {
            type: "unmanaged",
            path: harness.repoDir,
          },
        });
        const threadB = await createReadyReuseThread(harness, {
          environmentId: threadA.environment.id,
          projectId: project.id,
          providerId: "fake-beta",
          timeoutMs: DEFAULT_TIMEOUT_MS,
        });

        await Promise.all([
          sendTextMessage(harness.api, threadA.thread.id, {
            text: `${CONCURRENT_DELAY_TEXT} alpha`,
          }),
          sendTextMessage(harness.api, threadB.thread.id, {
            text: `${CONCURRENT_DELAY_TEXT} beta`,
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

        const runtimeEntry = harness.daemonApp.runtimeManager.get(
          threadA.environment.id,
        );
        const runningProviders =
          runtimeEntry?.runtime.listRunningProviders().sort() ?? [];
        expect(runningProviders).toEqual(["fake-alpha", "fake-beta"]);

        const eventsA = await getThreadEvents(harness.api, threadA.thread.id);
        const eventsB = await getThreadEvents(harness.api, threadB.thread.id);
        assertEventsBelongToThread(eventsA, threadA.thread.id);
        assertEventsBelongToThread(eventsB, threadB.thread.id);
        expect(await getThreadOutput(harness.api, threadA.thread.id)).toContain(
          "alpha",
        );
        expect(await getThreadOutput(harness.api, threadB.thread.id)).toContain(
          "beta",
        );
      },
    );
  });

  it("handles three concurrent threads across shared and isolated environments", () =>
    withHarness(async (harness) => {
      const secondRepoDir = await createTestGitRepo({
        repoDir: path.join(path.dirname(harness.repoDir), "stress-project"),
      });
      const projectA = await createProjectFixture(harness, {
        name: "Stress Shared Environment",
      });
      const projectB = await createProjectFixture(harness, {
        name: "Stress Isolated Environment",
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
      const threadB = await createReadyReuseThread(harness, {
        environmentId: threadA.environment.id,
        projectId: projectA.id,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      const threadC = await createReadyHostThread(harness, {
        projectId: projectB.id,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        workspace: {
          type: "unmanaged",
          path: secondRepoDir,
        },
      });

      await Promise.all([
        sendTextMessage(harness.api, threadA.thread.id, {
          text: `${CONCURRENT_DELAY_TEXT} stress-a`,
        }),
        sendTextMessage(harness.api, threadB.thread.id, {
          text: `${CONCURRENT_DELAY_TEXT} stress-b`,
        }),
        sendTextMessage(harness.api, threadC.thread.id, {
          text: `${CONCURRENT_DELAY_TEXT} stress-c`,
        }),
      ]);
      await Promise.all([
        waitForThreadStatus(harness.api, threadA.thread.id, "idle", TURN_TIMEOUT_MS),
        waitForThreadStatus(harness.api, threadB.thread.id, "idle", TURN_TIMEOUT_MS),
        waitForThreadStatus(harness.api, threadC.thread.id, "idle", TURN_TIMEOUT_MS),
      ]);

      assertEventsBelongToThread(
        await getThreadEvents(harness.api, threadA.thread.id),
        threadA.thread.id,
      );
      assertEventsBelongToThread(
        await getThreadEvents(harness.api, threadB.thread.id),
        threadB.thread.id,
      );
      assertEventsBelongToThread(
        await getThreadEvents(harness.api, threadC.thread.id),
        threadC.thread.id,
      );
      expect(await getThreadOutput(harness.api, threadC.thread.id)).toContain("stress-c");
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
        waitForThreadStatus(harnessA.api, threadA.thread.id, "idle", TURN_TIMEOUT_MS),
        waitForThreadStatus(harnessB.api, threadB.thread.id, "idle", TURN_TIMEOUT_MS),
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
        (await runGit({
          args: ["log", "-1", "--format=%s"],
          cwd: harnessA.repoDir,
        })).trim(),
      ).toBe("bb: automated commit");
      expect(
        (await runGit({
          args: ["log", "-1", "--format=%s"],
          cwd: harnessB.repoDir,
        })).trim(),
      ).toBe("bb: automated commit");
      await expect(
        fs.access(path.join(harnessB.repoDir, "instance-a.txt")),
      ).rejects.toThrow();
      await expect(
        fs.access(path.join(harnessA.repoDir, "instance-b.txt")),
      ).rejects.toThrow();
    } finally {
      await Promise.all([
        harnessA.cleanup(),
        harnessB.cleanup(),
      ]);
    }
  });
});

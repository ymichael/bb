// Phase 7b: Fake provider basic lifecycle (plans/rebuild.md)
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createFakeAdapter } from "@bb/agent-runtime/test";
import { environments } from "@bb/db";
import type { ThreadEventRow } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  archiveThread,
  createHostThread,
  createManagerThread,
  deleteThread,
  getEnvironment,
  getEnvironmentBranches,
  getEnvironmentDiff,
  getEnvironmentStatus,
  getHosts,
  getThread,
  getThreadEvents,
  getThreadOutput,
  getThreadTimeline,
  runEnvironmentAction,
  sendTextMessage,
  stopThread,
  unarchiveThread,
  updateEnvironment,
} from "../helpers/api.js";
import {
  waitForCommand,
  waitForCommandsDrained,
  waitForEventType,
  waitForHostConnected,
  waitForPathRemoval,
  waitForThreadStatus,
} from "../helpers/assertions.js";
import {
  type IntegrationHarness,
  withHarness,
} from "../helpers/harness.js";
import {
  createProjectFixture as createProjectFixtureForHarness,
  createReadyHostThread,
  createReadyReuseThread,
  type ProjectFixture,
  type ReadyHostThreadOptions,
  type ReadyThreadFixture,
} from "../helpers/fixtures.js";
import {
  createTestFile,
  runGit,
} from "../helpers/seed.js";
import { scaleTimeoutMs } from "../helpers/time.js";
import {
  countQueuedCommandsByType,
  readStoredTurnEvents,
} from "../helpers/queries.js";

// Setup and provisioning waits: project creation, environment readiness, and archive cleanup.
const DEFAULT_TIMEOUT_MS = scaleTimeoutMs(10_000);
// Whole-turn waits: allow the fake provider enough time to start and finish a normal turn.
const TURN_TIMEOUT_MS = scaleTimeoutMs(15_000);
// Active-turn waits: only long enough to observe the thread leave idle.
const ACTIVE_TURN_TIMEOUT_MS = scaleTimeoutMs(5_000);
// Fake provider inputs accept `delay:<ms>` prefixes to pause a turn before completion.
const STOP_DELAY_TEXT = "delay:5000 stop me";

async function createProjectFixture(
  harness: IntegrationHarness,
  name: string,
): Promise<ProjectFixture> {
  return createProjectFixtureForHarness(harness, { name });
}

async function createReadyThread(
  harness: IntegrationHarness,
  options: ReadyHostThreadOptions,
): Promise<ReadyThreadFixture> {
  return createReadyHostThread(harness, {
    ...options,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
}

function assertMonotonicSequences(events: ThreadEventRow[]): void {
  for (let index = 1; index < events.length; index += 1) {
    expect(events[index]?.seq).toBeGreaterThan(events[index - 1]?.seq ?? -1);
  }
}

async function expectThreadMissing(
  harness: IntegrationHarness,
  threadId: string,
): Promise<void> {
  const response = await harness.api.threads[":id"].$get({
    param: { id: threadId },
  });
  expect(response.status).toBe(404);
}

async function expectEnvironmentDestroyed(
  harness: IntegrationHarness,
  environmentId: string,
): Promise<void> {
  const environment = await getEnvironment(harness.api, environmentId);
  expect(environment.status).toBe("destroyed");
}

function countProvisionCommands(harness: IntegrationHarness): number {
  return countQueuedCommandsByType(harness.db, "environment.provision");
}

describe.sequential("fake provider smoke integration", () => {
  it("creates a project and unmanaged thread, then provisions the workspace", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(harness, "Unmanaged Smoke");
      const { environment, thread } = await createReadyThread(harness, {
        projectId: project.id,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });

      const host = await waitForHostConnected(harness.api, DEFAULT_TIMEOUT_MS);
      expect(thread.environmentId).toBe(environment.id);
      expect(environment.status).toBe("ready");
      expect(environment.path).toBe(harness.repoDir);
      expect(environment.isGitRepo).toBe(true);
      expect(environment.isWorktree).toBe(false);
      expect(host.id).toBe(harness.hostId);

      const hosts = await getHosts(harness.api);
      expect(hosts).toHaveLength(1);
      expect(hosts[0]?.status).toBe("connected");
    }));

  it("creates a managed worktree and registers it as a git worktree", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(harness, "Managed Worktree Smoke");
      const { environment } = await createReadyThread(harness, {
        projectId: project.id,
        workspace: { type: "managed-worktree" },
      });

      expect(environment.isWorktree).toBe(true);
      expect(environment.branchName).toBeTruthy();
      expect(environment.path).toBeTruthy();

      await fs.access(environment.path ?? "");
      const resolvedWorktreePath = await fs.realpath(environment.path ?? "");
      const worktreeList = await runGit({
        args: ["worktree", "list", "--porcelain"],
        cwd: harness.repoDir,
      });

      expect(worktreeList).toContain(`worktree ${resolvedWorktreePath}`);
    }));

  it("creates a manager thread and starts it with manager tools and instructions", async () => {
    const runtimeConfigCommands: Array<{
      commandType: string;
      dynamicToolNames: string[];
      instructions: string | undefined;
      threadId: string;
    }> = [];
    await withHarness(
      {
        adapterFactory: (providerId) => {
          const baseAdapter = createFakeAdapter({
            displayName: providerId,
            id: providerId,
            modelId: `${providerId}-model`,
            modelName: `${providerId} model`,
          });
          const buildCommand: typeof baseAdapter.buildCommand = (command) => {
            if (command.type === "thread/start" || command.type === "thread/resume") {
              runtimeConfigCommands.push({
                commandType: command.type,
                dynamicToolNames: (command.dynamicTools ?? [])
                  .map((tool) => tool.name)
                  .sort(),
                instructions: command.options?.instructions,
                threadId: command.threadId,
              });
            }
            return baseAdapter.buildCommand(command);
          };
          return {
            ...baseAdapter,
            buildCommand,
          };
        },
      },
      async (harness) => {
        const project = await createProjectFixture(harness, "Manager Smoke");

        // Create an unmanaged thread first so the environment is ready. The
        // manager reuses the existing unmanaged environment from the project's
        // default source instead of provisioning a new managed-worktree.
        const { environment: sourceEnvironment } = await createReadyThread(harness, {
          projectId: project.id,
          workspace: {
            type: "unmanaged",
            path: harness.repoDir,
          },
        });

        // Manager creation returns immediately — the initial thread.start
        // uses default preferences (isThreadCreation skips the daemon read).
        const managerThread = await createManagerThread(harness.api, project.id, {
          model: "fake-model",
          providerId: "fake",
          reasoningLevel: "high",
          name: "Project manager",
        });
        expect(managerThread.type).toBe("manager");
        expect(managerThread.environmentId).toBe(sourceEnvironment.id);

        await waitForThreadStatus(
          harness.api,
          managerThread.id,
          "idle",
          TURN_TIMEOUT_MS,
        );

        const managerEnvironment = await getEnvironment(
          harness.api,
          managerThread.environmentId ?? "",
        );
        if (!managerEnvironment.path) {
          throw new Error("Manager environment path was not assigned");
        }

        const managerRuntimeCommand = [...runtimeConfigCommands]
          .reverse()
          .find((command) => command.threadId === managerThread.id);
        expect(managerRuntimeCommand).toBeDefined();
        expect(managerRuntimeCommand?.commandType).toBe("thread/start");
        expect(managerRuntimeCommand?.dynamicToolNames).toEqual(
          expect.arrayContaining(["message_user"]),
        );
        expect(managerRuntimeCommand?.instructions).toContain(
          "You are a manager for this project.",
        );
        expect(managerRuntimeCommand?.instructions).toContain(
          "(file does not exist)",
        );
        expect(managerRuntimeCommand?.instructions).toContain(managerThread.id);
        expect(managerRuntimeCommand?.instructions).toContain(managerEnvironment.path);
      },
    );
  });

  it("sends a message, runs the provider, and records timeline/output data", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(harness, "Turn Flow Smoke");
      const { thread } = await createReadyThread(harness, {
        projectId: project.id,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });

      await sendTextMessage(harness.api, thread.id, {
        text: "hello delay:400",
      });
      await waitForThreadStatus(
        harness.api,
        thread.id,
        "active",
        ACTIVE_TURN_TIMEOUT_MS,
      );
      await waitForThreadStatus(harness.api, thread.id, "idle", TURN_TIMEOUT_MS);

      await waitForEventType(
        harness.api,
        thread.id,
        "turn/started",
        TURN_TIMEOUT_MS,
      );
      await waitForEventType(
        harness.api,
        thread.id,
        "turn/completed",
        TURN_TIMEOUT_MS,
      );

      const events = await getThreadEvents(harness.api, thread.id);
      assertMonotonicSequences(events);
      expect(events.some((event) => event.type === "turn/started")).toBe(true);
      expect(events.some((event) => event.type === "turn/completed")).toBe(true);
      expect(events.every((event) => event.threadId === thread.id)).toBe(true);

      const storedTurnEvents = readStoredTurnEvents(harness.db, thread.id).filter(
        (event) =>
          event.type === "turn/started" || event.type === "turn/completed",
      );
      expect(storedTurnEvents.length).toBeGreaterThanOrEqual(2);
      expect(storedTurnEvents.every((event) => Boolean(event.turnId))).toBe(true);

      const timeline = await getThreadTimeline(harness.api, thread.id);
      const output = await getThreadOutput(harness.api, thread.id);
      expect(timeline.rows.length).toBeGreaterThan(0);
      expect(output).toContain("hello");
    }));

  it("creates a new turn for an idle follow-up instead of steering the previous turn", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(harness, "Follow-Up Smoke");
      const { thread } = await createReadyThread(harness, {
        projectId: project.id,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });
      const baselineEvents = await getThreadEvents(harness.api, thread.id);
      const baselineStartedCount = baselineEvents.filter((event) => event.type === "turn/started").length;
      const baselineCompletedCount = baselineEvents.filter((event) => event.type === "turn/completed").length;
      const baselineTurnIds = new Set(
        readStoredTurnEvents(harness.db, thread.id)
          .map((event) => event.turnId)
          .filter((turnId): turnId is string => Boolean(turnId)),
      );

      await sendTextMessage(harness.api, thread.id, {
        text: "first turn",
      });
      await waitForThreadStatus(harness.api, thread.id, "idle", TURN_TIMEOUT_MS);

      await sendTextMessage(harness.api, thread.id, {
        mode: "auto",
        text: "second turn",
      });
      await waitForThreadStatus(harness.api, thread.id, "idle", TURN_TIMEOUT_MS);

      const events = await getThreadEvents(harness.api, thread.id);
      expect(events.filter((event) => event.type === "turn/started")).toHaveLength(
        baselineStartedCount + 2,
      );
      expect(events.filter((event) => event.type === "turn/completed")).toHaveLength(
        baselineCompletedCount + 2,
      );

      const turnIds = new Set(
        readStoredTurnEvents(harness.db, thread.id)
          .map((event) => event.turnId)
          .filter((turnId): turnId is string => Boolean(turnId)),
      );
      expect(turnIds.size).toBe(baselineTurnIds.size + 2);
    }));

  it("stops an active thread and records a thread interruption event", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(harness, "Stop Smoke");
      const { thread } = await createReadyThread(harness, {
        projectId: project.id,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });

      await sendTextMessage(harness.api, thread.id, {
        text: STOP_DELAY_TEXT,
      });
      await waitForThreadStatus(
        harness.api,
        thread.id,
        "active",
        ACTIVE_TURN_TIMEOUT_MS,
      );
      await stopThread(harness.api, thread.id);
      await waitForThreadStatus(harness.api, thread.id, "idle", TURN_TIMEOUT_MS);
      const interruptedEvents = (await getThreadEvents(harness.api, thread.id))
        .filter((event) => event.type === "system/thread/interrupted");
      const latestInterruptedEvent = interruptedEvents.at(-1);
      expect(latestInterruptedEvent?.data.reason).toBe("user");
    }));

  it("reports workspace status, diff, and branches for a ready environment", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(harness, "Workspace Status Smoke");
      const { environment } = await createReadyThread(harness, {
        projectId: project.id,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });

      const status = await getEnvironmentStatus(harness.api, environment.id);
      const diff = await getEnvironmentDiff(harness.api, environment.id);
      const branches = await getEnvironmentBranches(harness.api, environment.id);

      expect(status.workspace?.workingTree.state).toBe("clean");
      expect(status.workspace?.workingTree.hasUncommittedChanges).toBe(false);
      expect(typeof diff.diff).toBe("string");
      expect(branches).toContain("main");
    }));

  it("commits dirty workspace changes through the environment actions route", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(harness, "Workspace Commit Smoke");
      const { environment } = await createReadyThread(harness, {
        projectId: project.id,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });

      const workspacePath = environment.path ?? "";
      await createTestFile({
        content: "committed from smoke test\n",
        filePath: path.join(workspacePath, "committed.txt"),
      });

      const dirtyStatus = await getEnvironmentStatus(harness.api, environment.id);
      expect(dirtyStatus.workspace?.workingTree.hasUncommittedChanges).toBe(true);

      const result = await runEnvironmentAction(harness.api, environment.id, {
        action: "commit",
      });
      expect(result.action).toBe("commit");
      if (result.action !== "commit") {
        throw new Error(`Expected commit action result, received ${result.action}`);
      }
      expect(result.commitSha).toBeTruthy();

      const cleanStatus = await getEnvironmentStatus(harness.api, environment.id);
      expect(cleanStatus.workspace?.workingTree.state).toBe("clean");

      const subject = await runGit({
        args: ["log", "-1", "--format=%s"],
        cwd: workspacePath,
      });
      expect(subject.trim()).toBe("bb: automated commit");
    }));

  it("promotes and demotes a managed worktree after committing changes", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(harness, "Promote Smoke");
      const { environment } = await createReadyThread(harness, {
        projectId: project.id,
        workspace: { type: "managed-worktree" },
      });

      const workspacePath = environment.path ?? "";
      await updateEnvironment(harness.api, environment.id, {
        mergeBaseBranch: "main",
      });
      await createTestFile({
        content: "feature branch change\n",
        filePath: path.join(workspacePath, "feature.txt"),
      });

      await runEnvironmentAction(harness.api, environment.id, {
        action: "commit",
      });
      await runEnvironmentAction(harness.api, environment.id, {
        action: "promote",
      });

      const promotedHead = await runGit({
        args: ["log", "-1", "--format=%s"],
        cwd: harness.repoDir,
      });
      expect(promotedHead.trim()).toBe("bb: automated commit");

      await runEnvironmentAction(harness.api, environment.id, {
        action: "demote",
      });

      const sourceBranch = await runGit({
        args: ["rev-parse", "--abbrev-ref", "HEAD"],
        cwd: harness.repoDir,
      });
      const environmentStatus = await getEnvironmentStatus(harness.api, environment.id);
      expect(sourceBranch.trim()).toBe("main");
      expect(environmentStatus.workspace?.workingTree.state).toBe("committed_unmerged");
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
          input: [{ type: "text", text: "should fail" }],
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
      await waitForThreadStatus(harness.api, thread.id, "idle", TURN_TIMEOUT_MS);

      const output = await getThreadOutput(harness.api, thread.id);
      expect(output).toContain("after unarchive");
    }));

  it("archives a managed worktree thread and destroys the environment", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(harness, "Archive Cleanup Smoke");
      const { environment, thread } = await createReadyThread(harness, {
        projectId: project.id,
        workspace: { type: "managed-worktree" },
      });

      const workspacePath = environment.path ?? "";
      await archiveThread(harness.api, thread.id);
      await waitForCommand(
        harness.db,
        (command) =>
          command.type === "environment.destroy" &&
          command.command.type === "environment.destroy" &&
          command.command.environmentId === environment.id,
        DEFAULT_TIMEOUT_MS,
      );
      await waitForCommandsDrained(
        harness.db,
        harness.hostId,
        DEFAULT_TIMEOUT_MS,
      );
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
      await waitForThreadStatus(harness.api, thread.id, "idle", TURN_TIMEOUT_MS);

      await deleteThread(harness.api, thread.id);
      await expectThreadMissing(harness, thread.id);
    }));

  it("moves a thread to error and records failure events when environment provisioning fails", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(harness, "Provision Failure Smoke");
      const missingPath = path.join(
        path.dirname(harness.repoDir),
        `missing-provision-${randomUUID()}`,
      );
      await fs.rm(missingPath, { recursive: true, force: true });

      const thread = await createHostThread(harness.api, {
        hostId: harness.hostId,
        projectId: project.id,
        workspace: {
          type: "unmanaged",
          path: missingPath,
        },
      });
      const environmentId = thread.environmentId;
      if (!environmentId) {
        throw new Error("Provisioning thread was missing an environment");
      }

      await waitForThreadStatus(harness.api, thread.id, "error", TURN_TIMEOUT_MS);

      const environment = await getEnvironment(harness.api, environmentId);
      const events = await getThreadEvents(harness.api, thread.id);
      expect(environment.status).toBe("error");
      expect(
        events.some(
          (event) =>
            event.type === "system/provisioning" &&
            event.data.status === "failed",
        ),
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "system/error" &&
            event.data.code === "thread_provisioning_failed",
        ),
      ).toBe(true);
    }));

  it("reuses the same unmanaged environment when two host threads target the same path", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(harness, "Implicit Reuse Smoke");
      const firstThread = await createReadyThread(harness, {
        projectId: project.id,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });
      const provisionCountBeforeSecondThread = countProvisionCommands(harness);

      const secondThread = await createReadyThread(harness, {
        projectId: project.id,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });

      expect(secondThread.thread.environmentId).toBe(firstThread.thread.environmentId);
      expect(secondThread.environment.id).toBe(firstThread.environment.id);
      expect(countProvisionCommands(harness)).toBe(provisionCountBeforeSecondThread);
    }));

  it("creates a reuse thread without provisioning a second environment", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(harness, "Reuse Smoke");
      const { environment, thread } = await createReadyThread(harness, {
        projectId: project.id,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });

      const provisionCountBefore = countProvisionCommands(harness);

      const reusedThread = await createReadyReuseThread(harness, {
        environmentId: environment.id,
        projectId: project.id,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      expect(reusedThread.thread.environmentId).toBe(thread.environmentId);
      expect(reusedThread.thread.status).toBe("idle");

      const provisionCountAfter = countProvisionCommands(harness);
      expect(provisionCountAfter).toBe(provisionCountBefore);

      await sendTextMessage(harness.api, reusedThread.thread.id, {
        text: "reuse environment",
      });
      await waitForThreadStatus(
        harness.api,
        reusedThread.thread.id,
        "idle",
        TURN_TIMEOUT_MS,
      );

      const output = await getThreadOutput(harness.api, reusedThread.thread.id);
      const reusedEnvironment = await getEnvironment(harness.api, environment.id);
      expect(reusedEnvironment.id).toBe(environment.id);
      expect(output).toContain("reuse environment");
    }));

  it("returns 409 when a second send tries to reprovision while managed reprovision is already in progress", () =>
    withHarness(async (harness) => {
      await fs.writeFile(
        path.join(harness.repoDir, ".bb-env-setup.sh"),
        "#!/bin/sh\nsleep 2\n",
        "utf8",
      );
      const project = await createProjectFixture(harness, "Managed Reprovision Conflict");
      const { environment, thread } = await createReadyThread(harness, {
        projectId: project.id,
        workspace: { type: "managed-worktree" },
      });
      const originalWorkspacePath = environment.path ?? "";

      await archiveThread(harness.api, thread.id);
      await waitForCommand(
        harness.db,
        (command) =>
          command.type === "environment.destroy" &&
          command.command.type === "environment.destroy" &&
          command.command.environmentId === environment.id,
        DEFAULT_TIMEOUT_MS,
      );
      await waitForCommandsDrained(harness.db, harness.hostId, DEFAULT_TIMEOUT_MS);
      await waitForPathRemoval(originalWorkspacePath, DEFAULT_TIMEOUT_MS);

      await unarchiveThread(harness.api, thread.id);
      const provisionCountBefore = countProvisionCommands(harness);
      const firstSendResponse = await harness.api.threads[":id"].send.$post({
        param: { id: thread.id },
        json: {
          input: [{ type: "text", text: "start reprovision" }],
          mode: "auto",
        },
      });
      expect(firstSendResponse.status).toBe(200);
      expect(countProvisionCommands(harness)).toBe(provisionCountBefore + 1);

      const secondSendResponse = await harness.api.threads[":id"].send.$post({
        param: { id: thread.id },
        json: {
          input: [{ type: "text", text: "duplicate reprovision" }],
          mode: "auto",
        },
      });
      expect(secondSendResponse.status).toBe(409);
      await expect(secondSendResponse.json()).resolves.toMatchObject({
        code: "invalid_request",
      });
      expect(countProvisionCommands(harness)).toBe(provisionCountBefore + 1);

      const reloadingEnvironment = await getEnvironment(harness.api, environment.id);
      expect(reloadingEnvironment.status).toBe("provisioning");
    }));

  it("rejects reprovision attempts for unmanaged environments", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(harness, "Unmanaged Reprovision Rejected");
      const { environment, thread } = await createReadyThread(harness, {
        projectId: project.id,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });
      const provisionCountBefore = countProvisionCommands(harness);

      harness.db
        .update(environments)
        .set({
          path: null,
          status: "error",
          updatedAt: Date.now(),
        })
        .where(eq(environments.id, environment.id))
        .run();

      const response = await harness.api.threads[":id"].send.$post({
        param: { id: thread.id },
        json: {
          input: [{ type: "text", text: "try unmanaged reprovision" }],
          mode: "auto",
        },
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: "invalid_request",
      });
      expect(countProvisionCommands(harness)).toBe(provisionCountBefore);
    }));
});

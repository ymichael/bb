import fs from "node:fs/promises";
import { createFakeAdapter } from "@bb/agent-runtime/test";
import { describe, expect, it } from "vitest";
import {
  createManagerThread,
  getEnvironment,
  getHosts,
  getThreadEvents,
  getThreadOutput,
  getThreadTimeline,
  sendTextMessage,
  stopThread,
} from "../../helpers/api.js";
import {
  waitForEventType,
  waitForHostConnected,
  waitForThreadStatus,
} from "../../helpers/assertions.js";
import { withHarness } from "../../helpers/harness.js";
import { runGit } from "../../helpers/seed.js";
import { readStoredTurnEvents } from "../../helpers/queries.js";
import {
  ACTIVE_TURN_TIMEOUT_MS,
  assertMonotonicSequences,
  createProjectFixture,
  createReadyThread,
  DEFAULT_TIMEOUT_MS,
  type RuntimeConfigCommand,
  STOP_DELAY_TEXT,
  TURN_TIMEOUT_MS,
} from "./shared.js";

describe.sequential("fake provider smoke lifecycle integration", () => {
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
      const project = await createProjectFixture(
        harness,
        "Managed Worktree Smoke",
      );
      const { environment } = await createReadyThread(harness, {
        projectId: project.id,
        workspace: { type: "managed-worktree" },
      });

      expect(environment.isWorktree).toBe(true);
      expect(environment.branchName).toBeTruthy();
      expect(environment.path).toBeTruthy();

      const workspacePath = environment.path;
      if (!workspacePath) {
        throw new Error("Managed worktree path was not assigned");
      }

      await fs.access(workspacePath);
      const resolvedWorktreePath = await fs.realpath(workspacePath);
      const worktreeList = await runGit({
        args: ["worktree", "list", "--porcelain"],
        cwd: harness.repoDir,
      });

      expect(worktreeList).toContain(`worktree ${resolvedWorktreePath}`);
    }));

  it("creates a manager thread and starts it with manager tools and instructions", async () => {
    const runtimeConfigCommands: RuntimeConfigCommand[] = [];
    await withHarness(
      {
        adapterFactory: (providerId) => {
          const baseAdapter = createFakeAdapter({
            displayName: providerId,
            id: providerId,
          });
          const buildCommandPlan: typeof baseAdapter.buildCommandPlan = (
            command,
          ) => {
            if (
              command.type === "thread/start" ||
              command.type === "thread/resume"
            ) {
              runtimeConfigCommands.push({
                commandType: command.type,
                dynamicToolNames: (command.dynamicTools ?? [])
                  .map((tool) => tool.name)
                  .sort(),
                instructions: command.options?.instructions,
                threadId: command.threadId,
              });
            }
            return baseAdapter.buildCommandPlan(command);
          };
          return {
            ...baseAdapter,
            buildCommandPlan,
          };
        },
      },
      async (harness) => {
        const project = await createProjectFixture(harness, "Manager Smoke");
        const { environment: sourceEnvironment } = await createReadyThread(
          harness,
          {
            projectId: project.id,
            workspace: {
              type: "unmanaged",
              path: harness.repoDir,
            },
          },
        );

        const managerThread = await createManagerThread(
          harness.api,
          project.id,
          {
            model: "fake-model",
            providerId: "fake",
            reasoningLevel: "high",
            name: "Project manager",
            environment: { type: "host", hostId: harness.hostId },
          },
        );
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
          "You are a manager in a project inside bb",
        );
        expect(managerRuntimeCommand?.instructions).toContain(
          "Delegate substantive work by default.",
        );
        expect(managerRuntimeCommand?.instructions).toContain(
          "Thread storage:",
        );
        expect(managerRuntimeCommand?.instructions).toContain(managerThread.id);
        expect(managerRuntimeCommand?.instructions).toContain(
          managerEnvironment.path,
        );
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
      await waitForThreadStatus(
        harness.api,
        thread.id,
        "idle",
        TURN_TIMEOUT_MS,
      );

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
      expect(events.some((event) => event.type === "turn/completed")).toBe(
        true,
      );
      expect(events.every((event) => event.threadId === thread.id)).toBe(true);

      const storedTurnEvents = readStoredTurnEvents(
        harness.db,
        thread.id,
      ).filter(
        (event) =>
          event.type === "turn/started" || event.type === "turn/completed",
      );
      expect(storedTurnEvents.length).toBeGreaterThanOrEqual(2);
      expect(storedTurnEvents.every((event) => Boolean(event.turnId))).toBe(
        true,
      );

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
      const baselineStartedCount = baselineEvents.filter(
        (event) => event.type === "turn/started",
      ).length;
      const baselineCompletedCount = baselineEvents.filter(
        (event) => event.type === "turn/completed",
      ).length;
      const baselineTurnIds = new Set(
        readStoredTurnEvents(harness.db, thread.id)
          .map((event) => event.turnId)
          .filter((turnId): turnId is string => Boolean(turnId)),
      );

      await sendTextMessage(harness.api, thread.id, {
        text: "first turn",
      });
      await waitForThreadStatus(
        harness.api,
        thread.id,
        "idle",
        TURN_TIMEOUT_MS,
      );

      await sendTextMessage(harness.api, thread.id, {
        mode: "auto",
        text: "second turn",
      });
      await waitForThreadStatus(
        harness.api,
        thread.id,
        "idle",
        TURN_TIMEOUT_MS,
      );

      const events = await getThreadEvents(harness.api, thread.id);
      expect(
        events.filter((event) => event.type === "turn/started"),
      ).toHaveLength(baselineStartedCount + 2);
      expect(
        events.filter((event) => event.type === "turn/completed"),
      ).toHaveLength(baselineCompletedCount + 2);

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
      await waitForThreadStatus(
        harness.api,
        thread.id,
        "idle",
        TURN_TIMEOUT_MS,
      );
      const interruptedEvents = (
        await getThreadEvents(harness.api, thread.id)
      ).filter((event) => event.type === "system/thread/interrupted");
      const latestInterruptedEvent = interruptedEvents.at(-1);
      expect(latestInterruptedEvent?.data.reason).toBe("manual-stop");
    }));
});

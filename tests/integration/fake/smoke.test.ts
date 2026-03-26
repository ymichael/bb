// Phase 7b: Fake provider basic lifecycle (plans/rebuild.md)
import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import {
  events as eventRows,
  hostDaemonCommands,
} from "@bb/db";
import type { DbConnection } from "@bb/db";
import type {
  ThreadEventRow,
} from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  archiveThread,
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
  updateThread,
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
  createIntegrationHarness,
  type IntegrationHarness,
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

interface StoredTurnEventRow {
  sequence: number;
  turnId: string | null;
  type: string;
}

// Setup and provisioning waits: project creation, environment readiness, and archive cleanup.
const DEFAULT_TIMEOUT_MS = scaleTimeoutMs(10_000);
// Whole-turn waits: allow the fake provider enough time to start and finish a normal turn.
const TURN_TIMEOUT_MS = scaleTimeoutMs(15_000);
// Active-turn waits: only long enough to observe the thread leave idle.
const ACTIVE_TURN_TIMEOUT_MS = scaleTimeoutMs(5_000);
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

function readStoredTurnEvents(
  db: DbConnection,
  threadId: string,
): StoredTurnEventRow[] {
  return db
    .select({
      sequence: eventRows.sequence,
      turnId: eventRows.turnId,
      type: eventRows.type,
    })
    .from(eventRows)
    .where(eq(eventRows.threadId, threadId))
    .orderBy(eventRows.sequence)
    .all();
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

describe.sequential("fake provider smoke integration", () => {
  it("creates a project and unmanaged thread, then provisions the workspace", async () => {
    const harness = await createIntegrationHarness();

    try {
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
    } finally {
      await harness.cleanup();
    }
  });

  it("creates a managed worktree and registers it as a git worktree", async () => {
    const harness = await createIntegrationHarness();

    try {
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
    } finally {
      await harness.cleanup();
    }
  });

  it("sends a message, runs the provider, and records timeline/output data", async () => {
    const harness = await createIntegrationHarness();

    try {
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
    } finally {
      await harness.cleanup();
    }
  });

  it("creates a new turn for an idle follow-up instead of steering the previous turn", async () => {
    const harness = await createIntegrationHarness();

    try {
      const project = await createProjectFixture(harness, "Follow-Up Smoke");
      const { thread } = await createReadyThread(harness, {
        projectId: project.id,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });

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
      expect(events.filter((event) => event.type === "turn/started")).toHaveLength(2);
      expect(events.filter((event) => event.type === "turn/completed")).toHaveLength(2);

      const turnIds = new Set(
        readStoredTurnEvents(harness.db, thread.id)
          .map((event) => event.turnId)
          .filter((turnId): turnId is string => Boolean(turnId)),
      );
      expect(turnIds.size).toBe(2);
    } finally {
      await harness.cleanup();
    }
  });

  it("stops an active thread and records an interrupted completion", async () => {
    const harness = await createIntegrationHarness();

    try {
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

      const completedEvent = await waitForEventType(
        harness.api,
        thread.id,
        "turn/completed",
        TURN_TIMEOUT_MS,
      );
      expect(completedEvent.data.status).toBe("interrupted");
    } finally {
      await harness.cleanup();
    }
  });

  it("reports workspace status, diff, and branches for a ready environment", async () => {
    const harness = await createIntegrationHarness();

    try {
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

      expect(status.workspace?.state).toBe("clean");
      expect(status.workspace?.hasUncommittedChanges).toBe(false);
      expect(diff.currentBranch).toBe("main");
      expect(branches).toContain("main");
    } finally {
      await harness.cleanup();
    }
  });

  it("commits dirty workspace changes through the environment actions route", async () => {
    const harness = await createIntegrationHarness();

    try {
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
      expect(dirtyStatus.workspace?.hasUncommittedChanges).toBe(true);

      const result = await runEnvironmentAction(harness.api, environment.id, {
        action: "commit",
        options: {
          includeUnstaged: true,
          message: "smoke commit",
        },
      });
      expect(result.action).toBe("commit");
      if (result.action !== "commit") {
        throw new Error(`Expected commit action result, received ${result.action}`);
      }
      expect(result.commitCreated).toBe(true);
      expect(result.commitSha).toBeTruthy();

      const cleanStatus = await getEnvironmentStatus(harness.api, environment.id);
      expect(cleanStatus.workspace?.state).toBe("clean");

      const subject = await runGit({
        args: ["log", "-1", "--format=%s"],
        cwd: workspacePath,
      });
      expect(subject.trim()).toBe("smoke commit");
    } finally {
      await harness.cleanup();
    }
  });

  it("promotes and demotes a managed worktree after committing changes", async () => {
    const harness = await createIntegrationHarness();

    try {
      const project = await createProjectFixture(harness, "Promote Smoke");
      const { environment, thread } = await createReadyThread(harness, {
        projectId: project.id,
        workspace: { type: "managed-worktree" },
      });

      const workspacePath = environment.path ?? "";
      await updateThread(harness.api, thread.id, {
        mergeBaseBranch: "main",
      });
      await createTestFile({
        content: "feature branch change\n",
        filePath: path.join(workspacePath, "feature.txt"),
      });

      await runEnvironmentAction(harness.api, environment.id, {
        action: "commit",
        options: {
          includeUnstaged: true,
          message: "feature work",
        },
      });
      await runEnvironmentAction(harness.api, environment.id, {
        action: "promote",
      });

      const promotedHead = await runGit({
        args: ["log", "-1", "--format=%s"],
        cwd: harness.repoDir,
      });
      expect(promotedHead.trim()).toBe("feature work");

      await runEnvironmentAction(harness.api, environment.id, {
        action: "demote",
      });

      const sourceBranch = await runGit({
        args: ["rev-parse", "--abbrev-ref", "HEAD"],
        cwd: harness.repoDir,
      });
      const environmentStatus = await getEnvironmentStatus(harness.api, environment.id);
      expect(sourceBranch.trim()).toBe("main");
      expect(environmentStatus.workspace?.state).toBe("clean");
    } finally {
      await harness.cleanup();
    }
  });

  it("archives and unarchives a thread, blocking work while archived", async () => {
    const harness = await createIntegrationHarness();

    try {
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
    } finally {
      await harness.cleanup();
    }
  });

  it("archives a managed worktree thread and destroys the environment", async () => {
    const harness = await createIntegrationHarness();

    try {
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
    } finally {
      await harness.cleanup();
    }
  });

  it("deletes a thread after turn history has been created", async () => {
    const harness = await createIntegrationHarness();

    try {
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
    } finally {
      await harness.cleanup();
    }
  });

  it("creates a reuse thread without provisioning a second environment", async () => {
    const harness = await createIntegrationHarness();

    try {
      const project = await createProjectFixture(harness, "Reuse Smoke");
      const { environment, thread } = await createReadyThread(harness, {
        projectId: project.id,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });

      const provisionCountBefore = harness.db
        .select({ count: hostDaemonCommands.id })
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.type, "environment.provision"))
        .all()
        .length;

      const reusedThread = await createReadyReuseThread(harness, {
        environmentId: environment.id,
        projectId: project.id,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      expect(reusedThread.thread.environmentId).toBe(thread.environmentId);
      expect(reusedThread.thread.status).toBe("idle");

      const provisionCountAfter = harness.db
        .select({ count: hostDaemonCommands.id })
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.type, "environment.provision"))
        .all()
        .length;
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
    } finally {
      await harness.cleanup();
    }
  });
});
